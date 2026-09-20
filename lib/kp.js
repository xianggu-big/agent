/* 知识点抽取：让"AI 先看懂资料里有哪些知识点，再据此出题"
 *
 * 用户的原始诉求："每次识别题目或资料后都要 AI 先看一下这里面有哪些知识点，
 * 然后它就可以在制造题目时有一个参考了"。
 *
 * 实现分两条路：
 *   1) AI 路：把资料（分块后抽样，避免超长）交给模型，产出结构化知识点清单；
 *   2) 规则路：解析资料的标题层级、"考点/重点/掌握"句式，作为无 Key 或调用失败时的兜底。
 * 两条路的输出结构一致，且都是确定性的（mock 模式用内容哈希，测试可复现）。
 *
 * 抽出的知识点有三个用途：
 *   a) 出题时按知识点取材（配合 lib/text.js 的块检索）→ 题目真正对上考点；
 *   b) 一句话需求里说"每个知识点各出 2 道"时，展开成逐知识点的制题需求；
 *   c) 出完题做覆盖率检查：哪些知识点一道题都没有 → 提示补题。
 */
'use strict';
const crypto = require('crypto');
const { extractJSON } = require('./json');
const Text = require('./text');

const MAX_KPS = 40;

/* ---------- 规则路（兜底 / 无 Key / 测试用） ---------- */
const HEAD_CLEAN = /^[#\s]*(第\s*[一二三四五六七八九十百零〇\d]+\s*[章节讲]|[（(]?[一二三四五六七八九十\d]+[)）]?[、.．]|\d+(\.\d+)*[、.．]?)\s*/;
const KP_HINT = /(考点|知识点|重点|难点|掌握|理解|熟悉|了解|要求|考查|考察)[:：]?\s*(.+)$/;

function cleanName(s) {
  return String(s || '')
    .replace(HEAD_CLEAN, '')
    .replace(/^[、.．,，:：\-\s]+/, '')
    .replace(/[:：。；;，,、\s]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
function heuristicKPs(text, opts = {}) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const found = new Map();
  const bump = (name, ch, detail, w) => {
    const key = name;
    if (!key || key.length < 2 || key.length > 30) return;
    if (/^[\d\s.、．]+$/.test(key)) return;
    const cur = found.get(key);
    if (cur) { cur.hits++; cur.weight = Math.min(5, cur.weight + (w || 1)); if (!cur.detail && detail) cur.detail = detail; }
    else found.set(key, { name: key, ch: ch || null, detail: detail || '', weight: w || 1, hits: 1 });
  };
  let ch = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const dc = Text.detectChapter(line);
    if (dc != null) { ch = dc; const nm = cleanName(line); if (nm) bump(nm, ch, '章节标题', 2); continue; }
    const m = KP_HINT.exec(line);
    if (m) {
      /* "考点：xxx、yyy" 可能并列多个 */
      for (const part of m[2].split(/[、,，;；]/)) bump(cleanName(part), ch, m[1] + '要求', 2);
      continue;
    }
    /* 形如 "（1）顺序表的插入" 的小标题也算候选 */
    if (/^[（(]\s*\d+\s*[)）]/.test(line) && line.length <= 30) bump(cleanName(line), ch, '', 1);
    else if (/^[A-Za-z\u4e00-\u9fa5][^。；;]{1,18}$/.test(line) && /[:：]$/.test(line)) bump(cleanName(line), ch, '', 1);
  }
  return [...found.values()]
    .sort((a, b) => (b.weight - a.weight) || (b.hits - a.hits) || a.name.localeCompare(b.name))
    .slice(0, opts.limit || MAX_KPS)
    .map(x => ({ ch: x.ch, name: x.name, detail: x.detail, weight: x.weight, source: 'rule' }));
}

/* ---------- mock（演示 / 自动化测试）：按内容哈希造可复现的知识点 ---------- */
function mockKPs(text, opts = {}) {
  const h = require('./mock').hash(String(text || ''));
  const preset = [
    { name: '线性表与顺序存储', detail: '顺序表的插入/删除与复杂度', weight: 3 },
    { name: '链表与指针操作', detail: '单链表插入、删除、逆置', weight: 3 },
    { name: '栈与队列', detail: '循环队列判满判空、表达式求值', weight: 3 },
    { name: '二叉树遍历', detail: '先序/中序/后序与线索化', weight: 4 },
    { name: '哈夫曼树与编码', detail: '带权路径长度与编码构造', weight: 2 },
    { name: '图的存储与遍历', detail: '邻接矩阵/邻接表、DFS 与 BFS', weight: 4 },
    { name: '最小生成树', detail: 'Prim 与 Kruskal 的适用场景', weight: 2 },
    { name: '最短路径', detail: 'Dijkstra 与 Floyd 的过程', weight: 3 },
    { name: '查找与散列', detail: '折半查找判定树、冲突处理', weight: 3 },
    { name: '内部排序', detail: '各排序的稳定性与时间复杂度', weight: 4 },
    { name: '算法复杂度分析', detail: '时间复杂度与空间复杂度计算', weight: 3 },
    { name: '拓扑排序与关键路径', detail: 'AOV/AOE 网的计算', weight: 2 }
  ];
  const n = Math.max(3, Math.min(opts.limit || 10, preset.length));
  const start = h % preset.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = preset[(start + i) % preset.length];
    out.push({ ch: (i % 3) + 1, name: p.name, detail: p.detail, weight: p.weight, source: 'ai' });
  }
  return out;
}

/* ---------- AI 路 ---------- */
function sampleForPrompt(text, maxChars) {
  const s = String(text || '');
  if (s.length <= maxChars) return s;
  /* 超长资料：取开头 + 均匀抽样中段 + 结尾，尽量覆盖全篇而不是只取前 1/3 */
  const head = s.slice(0, Math.floor(maxChars * 0.4));
  const tail = s.slice(-Math.floor(maxChars * 0.2));
  const midLen = maxChars - head.length - tail.length;
  const mid = s.slice(Math.floor(maxChars * 0.4), s.length - tail.length);
  const step = Math.max(1, Math.floor(mid.length / midLen));
  let picked = '';
  for (let i = 0; i < mid.length && picked.length < midLen; i += step) picked += mid[i];
  return head + '\n……（中间略）……\n' + picked + '\n……（略）……\n' + tail;
}

async function aiKPs(text, { profile, callLLM, meter, maxTokens = 2600, limit = MAX_KPS } = {}) {
  const sys = '你是复习资料分析专家。任务：从资料中抽取这份资料覆盖的知识点清单，不要出题、不要解释。' +
    '只输出一个 JSON 数组，格式：[{"ch":章节号(整数,不确定填1),"name":"知识点名(<=16字)","detail":"一句话说明这个知识点通常怎么考","weight":1到5的重要性}]。' +
    '要求：知识点要具体（如"循环队列的判满判空"而不是"队列"），数量控制在 ' + limit + ' 个以内，按资料顺序给出，不要编造资料里没有的内容。';
  const user = '以下是一份复习资料的节选，请抽取知识点清单：\n\n' + sampleForPrompt(text, 16000);
  const r = await callLLM(profile, [{ role: 'system', content: sys }, { role: 'user', content: user }],
    { meter, maxTokens, temperature: 0.2 });
  const arr = extractJSON(r.content);
  const list = (Array.isArray(arr) ? arr : (arr.kps || arr.items || [])).filter(x => x && x.name);
  if (!list.length) throw new Error('模型未返回知识点');
  return list.slice(0, limit).map(x => ({
    ch: Math.max(1, Math.min(99, Math.round(+x.ch) || 1)),
    name: String(x.name).slice(0, 30),
    detail: String(x.detail || '').slice(0, 200),
    weight: Math.max(1, Math.min(5, Math.round(+x.weight) || 2)),
    source: 'ai'
  }));
}

/*
 * 统一入口。
 * opts: { profile, callLLM, meter, mockMode, limit }
 * 返回 { list, source }，source 为 'ai' | 'rule' | 'mock'
 */
async function extract(text, opts = {}) {
  const t = String(text || '').trim();
  if (!t) return { list: [], source: 'rule' };
  if (opts.mockMode) return { list: mockKPs(t, opts), source: 'mock' };
  if (opts.profile && opts.profile.apiKey && !opts.profile.missing && opts.callLLM) {
    try {
      const list = await aiKPs(t, opts);
      if (list.length) return { list, source: 'ai' };
    } catch (e) {
      /* AI 抽取失败不阻断流程，退回规则路并留下痕迹 */
      return { list: heuristicKPs(t, opts), source: 'rule', error: e.message };
    }
  }
  return { list: heuristicKPs(t, opts), source: 'rule' };
}

/* ---------- 用途 b：把知识点展开成制题需求 ---------- */
/* "每个知识点各出 N 道" → requirements 里每个知识点一条，出题时逐条取材 */
function requirementsFromKPs(kps, { count = 2, type = 'mcq', diff = 2 } = {}) {
  return kps.map(k => ({
    type, count: Math.max(1, Math.min(50, +count || 2)),
    kp: k.name, diff: Math.max(1, Math.min(3, +diff || 2)),
    ch: Math.max(1, Math.min(20, +k.ch || 1))
  }));
}

/* ---------- 用途 c：覆盖率检查 ---------- */
/* 出完题后：哪些知识点一道题都没覆盖到 */
function coverage(kps, questions) {
  const names = kps.map(k => k.name);
  const covered = new Map(names.map(n => [n, 0]));
  for (const q of questions) {
    const kp = String(q.kp || '');
    if (!kp) continue;
    for (const n of names) {
      if (kp.includes(n) || n.includes(kp)) covered.set(n, covered.get(n) + 1);
    }
  }
  const missing = names.filter(n => !covered.get(n));
  return { total: names.length, covered: names.length - missing.length, missing, detail: [...covered.entries()].map(([name, n]) => ({ name, n })) };
}

module.exports = { extract, heuristicKPs, mockKPs, aiKPs, requirementsFromKPs, coverage, sampleForPrompt, MAX_KPS };
