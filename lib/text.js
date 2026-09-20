/* 资料分块 / 检索 / 相似度 —— 解决"出题只看得到资料前 12000 字"的根本问题
 *
 * 背景（实测）：一份 200 页真题资料的正文可达 20 万字符，而旧实现把整份资料
 * 直接截断成前 12000 字塞进提示词，于是第 2 章以后的考点永远不会被出题，
 * 客户拿到的"第一章专项"就是这样来的。
 *
 * 这里用纯本地、确定性、零依赖的做法替代：
 *   1) splitChunks   按"标题/空行/长度"把资料切成带章节号的语义块；
 *   2) 打分检索      用 CJK 二元组 + 拉丁词做词袋，按考点/章节给块打分；
 *   3) 覆盖优先      优先挑"这批还没用过"的块，多批次跑下来自然覆盖整份资料；
 *   4) 相似度        字符 3-gram 的 Jaccard，用于近似重复题去重。
 * 之所以不上向量库：这些操作要在一个 SQLite/MySQL + 纯 Node 的部署里跑，
 * 词袋打分对"按考点取段"这种任务已经够用，且结果可复现（测试不需要随机数）。
 */
'use strict';

/* ---------- 分块 ---------- */
const CHAPTER_PATTERNS = [
  /^第\s*([一二三四五六七八九十百零〇\d]+)\s*[章节讲部分篇]/,
  /^chapter\s*(\d+)/i,
  /^#{1,4}\s*第?\s*([一二三四五六七八九十百零〇\d]+)?\s*[章节]?/,
  /^([一二三四五六七八九十]+)\s*[、.．]/,
  /^[（(]\s*([一二三四五六七八九十]+)\s*[)）]/,
  /^(\d{1,2})\s*[、.．]\s*\S/
];
const CN_NUM = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
  '十一': 11, '十二': 12, '十三': 13, '十四': 14, '十五': 15, '十六': 16, '十七': 17, '十八': 18, '十九': 19, '二十': 20 };

function cnToNum(s) {
  if (/^\d+$/.test(s)) return +s;
  if (CN_NUM[s]) return CN_NUM[s];
  if (s === '零' || s === '〇') return 0;
  return null;
}
/* 判断一行是否是章节标题；返回章节号或 null */
function detectChapter(line) {
  const t = String(line).trim();
  if (!t || t.length > 40) return null;
  for (const p of CHAPTER_PATTERNS) {
    const m = p.exec(t);
    if (m) {
      const n = m[1] ? cnToNum(m[1]) : null;
      if (n != null && n > 0 && n <= 99) return n;
    }
  }
  return null;
}
/* 一行是否是"知识点式"小标题（不改变章节号，但值得单独成块） */
function isHeading(line) {
  const t = String(line).trim();
  if (!t || t.length > 40) return false;
  if (/^#{1,4}\s/.test(t)) return true;
  if (detectChapter(t)) return true;
  if (/^[（(]?[一二三四五六七八九十]+[)）、.]/.test(t)) return true;
  if (/[:：]$/.test(t)) return true;
  return false;
}

/*
 * 把资料切成块。
 * 返回 [{ i, ch, title, text, chars }]，ch 为最近的章节号（没识别到就是 null）。
 */
function splitChunks(text, opts = {}) {
  const maxChars = opts.maxChars || 1400;
  const minChars = opts.minChars || 120;
  const raw = String(text || '').replace(/\r\n?/g, '\n')
    .replace(/=====【资料附图[\s\S]*$/, '');   // 识图描述段不参与分块（它已由视觉通道单独注入）
  const lines = raw.split('\n');
  const blocks = [];
  let cur = { title: '', lines: [], chars: 0 };
  let ch = null, chTitle = '';

  const flush = () => {
    const body = cur.lines.join('\n').replace(/^\s+|\s+$/g, '');
    if (body) blocks.push({ ch, title: cur.title || chTitle, text: body, chars: body.length });
    cur = { title: '', lines: [], chars: 0 };
  };

  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      if (cur.chars > 0) { cur.lines.push(''); cur.chars += 1; }
      continue;
    }
    const dc = detectChapter(t);
    if (dc != null) {                     // 新章节 → 断块并更新章节号
      flush();
      ch = dc; chTitle = t.slice(0, 40);
      cur.title = chTitle; cur.lines.push(t); cur.chars = t.length;
      continue;
    }
    if (isHeading(t) && cur.chars > minChars) {
      flush();
      cur.title = t.slice(0, 40); cur.lines.push(t); cur.chars = t.length;
      continue;
    }
    if (cur.chars + t.length > maxChars && cur.chars > minChars) {
      flush();
      cur.lines.push(t); cur.chars = t.length;
      continue;
    }
    cur.lines.push(t); cur.chars += t.length + 1;
  }
  flush();

  /* 合并过小的块，避免一堆碎块让检索失去意义（只合并同章节的相邻块） */
  const merged = [];
  for (const b of blocks) {
    const prev = merged[merged.length - 1];
    const hasSmall = b.chars < minChars || (prev && prev.chars < minChars);
    if (prev && prev.ch === b.ch && hasSmall && prev.chars + b.chars <= maxChars * 1.5) {
      prev.text += '\n' + b.text; prev.chars = prev.text.length;
      if (!prev.title && b.title) prev.title = b.title;
    } else {
      merged.push({ ch: b.ch, title: b.title, text: b.text, chars: b.chars });
    }
  }
  return merged.map((b, i) => ({ i, ch: b.ch, title: b.title, text: b.text, chars: b.chars }));
}

/* ---------- 词袋与打分 ---------- */
/* 中文按二元组切（无需分词依赖），英文/数字按词切 */
function tokens(s) {
  const str = String(s || '').toLowerCase();
  const out = [];
  const latin = str.match(/[a-z0-9_]{2,}/g);
  if (latin) for (const w of latin) out.push(w);
  const cjk = str.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const seg of cjk) {
    if (seg.length === 1) { out.push(seg); continue; }
    for (let i = 0; i + 1 < seg.length; i++) out.push(seg.slice(i, i + 2));
  }
  return out;
}
function termSet(s) {
  const set = new Map();
  for (const t of tokens(s)) set.set(t, (set.get(t) || 0) + 1);
  return set;
}
/* 单块对查询的相关度：命中词种数 / 查询词种数，附章节与整串命中加成 */
function scoreChunk(chunk, query, queryTerms, wantCh) {
  const cs = termSet(chunk.title + '\n' + chunk.text);
  let hit = 0;
  for (const [t] of queryTerms) if (cs.has(t)) hit++;
  let score = queryTerms.size ? hit / queryTerms.size : 0;
  const q = String(query || '').trim();
  if (q.length >= 2 && (chunk.text.includes(q) || (chunk.title || '').includes(q))) score += 0.5;
  if (wantCh && chunk.ch === wantCh) score += 0.6;
  if (wantCh && chunk.ch && chunk.ch !== wantCh) score -= 0.15;
  return score;
}

/*
 * 按需求挑选资料片段。
 *  - query：本次需求的考点/关键词（如 req.kp）
 *  - wantCh：需求指定的章节号
 *  - used：本题任务已用过的块下标集合（Set）—— 优先挑没用过的，保证覆盖率
 *  - budgetChars：注入提示词的总字符预算
 * 返回 { text, used: [块下标], covered: 是否覆盖了全部块 }
 */
function selectChunks(chunks, { query = '', wantCh = null, used = new Set(), budgetChars = 9000 } = {}) {
  if (!chunks.length) return { text: '', picked: [], allUsed: true };
  const queryTerms = termSet(query + ' ' + (wantCh ? '第' + wantCh + '章' : ''));
  const scored = chunks.map(c => ({ c, s: scoreChunk(c, query, queryTerms, wantCh) }));
  /* 未用过的排前面（同分时按原始顺序，保证确定性） */
  scored.sort((a, b) => {
    const ua = used.has(a.c.i) ? 1 : 0, ub = used.has(b.c.i) ? 1 : 0;
    if (ua !== ub) return ua - ub;
    if (b.s !== a.s) return b.s - a.s;
    return a.c.i - b.c.i;
  });
  const picked = [];
  let chars = 0;
  for (const x of scored) {
    if (chars >= budgetChars) break;
    if (chars + x.c.chars > budgetChars * 1.35 && picked.length) continue;  // 超预算太多的块跳过（找更小的）
    picked.push(x.c);
    chars += x.c.chars + 2;
    if (picked.length >= 8) break;
  }
  if (!picked.length) picked.push(scored[0].c);
  picked.sort((a, b) => a.i - b.i);        // 输出时恢复原文顺序，读起来连贯
  const text = picked.map(c => (c.title ? '【' + c.title + '】\n' : '') + c.text).join('\n\n');
  return { text, picked: picked.map(c => c.i), allUsed: picked.every(c => used.has(c.i)) };
}

/* ---------- 近似重复检测 ----------
 * 指标选择有实测依据（见 simcal.js 的标定表）：
 *   中文题干用"字符 3-gram 的 Jaccard"过于敏感 —— 只是换了标点、加了"下列说法"、
 *   调了语序，同一个知识点的同一道题相似度就掉到 0.26~0.48，低于任何合理阈值，等于漏检。
 *   改用「2-gram 重叠系数（overlap coefficient）」后：
 *     改写的同一道题 0.69 ~ 0.95，不同考点的题 ≤ 0.21，两者之间有大片空白。
 *   因此这里取两者最大值（既容忍增删改，又不会把不同题拉近），阈值定在 0.62。 */
function normStem(s) { return String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, ''); }
function gramsOf(s, n) {
  const set = new Set();
  if (!s) return set;
  if (s.length <= n) { set.add(s); return set; }
  for (let i = 0; i + n <= s.length; i++) set.add(s.slice(i, i + n));
  return set;
}
function jaccard(A, B) {
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
/* 重叠系数：除以较小集合大小，因此对"加了修饰语""删了一小段"这类长度差异不敏感 */
function overlapCoef(A, B) {
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / Math.min(A.size, B.size);
}
function shingles(s, n = 2) { return gramsOf(normStem(s), n); }
function similarity(a, b) {
  const A = normStem(a), B = normStem(b);
  if (!A || !B) return 0;
  return Math.max(overlapCoef(gramsOf(A, 2), gramsOf(B, 2)), jaccard(gramsOf(A, 3), gramsOf(B, 3)));
}
/* 在一批已有题目里找近似重复；返回命中的题目对象或 null */
function findDuplicate(stem, pool, threshold = 0.62) {
  const s = String(stem || '');
  if (s.length < 8) return null;
  for (const p of pool) {
    if (similarity(s, p.stem) >= threshold) return p;
  }
  return null;
}

/* ---------- 摘要（用于提示词里"避免与这些重复"的提示） ---------- */
function briefStems(list, n = 12, len = 40) {
  return list.slice(-n).map((q, i) => (i + 1) + '. ' + String(q.stem || '').replace(/\s+/g, ' ').slice(0, len)).join('\n');
}

module.exports = { splitChunks, detectChapter, tokens, termSet, scoreChunk, selectChunks, similarity, findDuplicate, shingles, briefStems, cnToNum };
