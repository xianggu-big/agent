/* QuestionForge 服务器 v3：多用户平台
 * - MySQL 持久化：账号/会话/资料/图形/任务/题目/事件/操作记录/学习状态/账单/签到/知识点/撤回申请
 * - 认证：scrypt 加盐存密码；会话随机 token 走 HttpOnly Cookie，并统计在线时长
 * - 安全：登录注册限流、Origin 校验（防 CSRF）、安全响应头、字段白名单
 * - 对话制题：自然语言 → 知识点解析 → NLU → 报价确认 → 创建并启动流水线
 * - 题库练习：按用户进度推送（错题优先），SQL 侧过滤分页
 * - 管理：审计日志（按用户号一条 SQL 直查）+ 操作撤回（用户申请 → 管理员审批）
 * 启动: node server.js → http://localhost:8540 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const Store = require('./lib/store');
const Agent = require('./lib/agent');
const Evals = require('./lib/evals');
const Cost = require('./lib/cost');
const Vision = require('./lib/vision');
const db = require('./lib/db');
const { sanitizeMaterial, wrapMaterial } = require('./lib/guard');
const { callLLM, callGuarded, newMeter, configure, status: llmStatus, clearCooldown } = require('./lib/llm');
const AI = require('./lib/ai');
const Revert = require('./lib/revert');
const KP = require('./lib/kp');
const Reqs = require('./lib/reqs');
const Text = require('./lib/text');
const RL = require('./lib/ratelimit');
const { log, access, newReqId } = require('./lib/log');

const PORT = process.env.QF_PORT || 8540;
const WEB = path.join(__dirname, 'web');
const running = new Set();
const VERSION = require('./package.json').version;
const STARTED_AT = Date.now();

/* ---------- 基础工具 ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.md': 'text/markdown; charset=utf-8', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
/* 安全响应头：CSP 允许内联脚本（前端是无构建的原生 JS，大量使用 onclick），
 * 但禁止外部脚本与框架嵌套，配合"输出转义"已能挡住绝大多数注入类攻击。 */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
};
function send(res, code, data, type, extraHeaders) {
  const isBuf = Buffer.isBuffer(data);
  const body = isBuf || typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(code, Object.assign({}, SECURITY_HEADERS, {
    'Content-Type': type || (isBuf ? 'application/octet-stream' : 'application/json; charset=utf-8'),
    'Cache-Control': 'no-store'
  }, extraHeaders || {}));
  res.end(body);
}
function readBody(req, limitMB) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > (limitMB || 30) * 1024 * 1024) { reject(new Error('文件过大（上限 ' + (limitMB || 30) + 'MB）')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function parseCookies(req) {
  const h = req.headers.cookie || '';
  const out = {};
  h.split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function isHttps(req) {
  if (process.env.QF_SECURE_COOKIE === '1') return true;
  return !!(req.socket && req.socket.encrypted) || String(req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';
}
/* CSRF 防护：对写操作校验 Origin/Referer 的主机名必须与本服务一致。
 * 跨站发起请求时浏览器必然会带上攻击者的 Origin，因此这一层能挡住 CSRF；
 * 而 curl / 自动化测试不带 Origin，故放行（它们本来也不受浏览器同源策略保护）。 */
function sameOrigin(req) {
  const raw = req.headers.origin || req.headers.referer;
  if (!raw) return true;
  try {
    const u = new URL(raw);
    const host = String(req.headers.host || '');
    return u.host === host;
  } catch (e) { return false; }
}
function maskProfile(p) { return Object.assign({}, p, { apiKey: p.apiKey ? p.apiKey.slice(0, 5) + '***' + p.apiKey.slice(-4) : '' }); }
function publicConfig(cfg, user) {
  const profiles = {};
  for (const [k, v] of Object.entries(cfg.profiles)) {
    const lens = Store.lensFor(cfg, k);
    profiles[k] = Object.assign({}, v, {
      usable: Store.hasCredentials(cfg, k),
      lensId: lens ? lens.id : null,
      lensLabel: lens ? lens.label : ''
    });
  }
  const providers = (cfg.providers || []).map(p => ({
    id: p.id, name: p.name, baseUrl: p.baseUrl, priceIn: p.priceIn, priceOut: p.priceOut,
    enabled: p.enabled !== false, note: p.note || '',
    model: p.model || '',
    apiKey: p.apiKey ? p.apiKey.slice(0, 6) + '***' + p.apiKey.slice(-4) : ''
  }));
  return {
    marginPct: cfg.marginPct, profiles, providers, concurrency: cfg.concurrency,
    lenses: require('./lib/lenses').list(),
    isAdmin: !!user && user.role === 'admin'
  };
}
function publicTask(t) {
  const out = Object.assign({}, t, {
    material: { chars: t.material ? t.material.rawChars : 0, warnings: t.material ? t.material.warnings : [] },
    kps: t.kps || [],
    constraints: t.constraints || [],
    coverageStrict: !!t.coverageStrict,
    totals: Reqs.totals(t.requirements || []),
    coveredChunks: (t.coveredChunks || []).length
  });
  out.figures = (t.figures || []).map(f => ({ id: f.id, page: f.page, w: f.w, h: f.h, kb: f.kb, desc: f.desc ? String(f.desc).slice(0, 400) : '' }));
  return out;
}
async function getUser(req) {
  const token = parseCookies(req).qf_sess;
  return token ? db.userBySession(token) : null;
}
function requireUser(handler) {
  return async (req, res, m, url) => {
    const user = await getUser(req);
    if (!user) return send(res, 401, { error: '请先登录' });
    req._user = user;
    return handler(req, res, user, m, url);
  };
}
function requireAdmin(handler) {
  return requireUser(async (req, res, user, m, url) => {
    if (user.role !== 'admin') return send(res, 403, { error: '需要管理员权限' });
    return handler(req, res, user, m, url);
  });
}
function setSessionCookie(res, token, req) {
  res.setHeader('Set-Cookie', 'qf_sess=' + token + '; HttpOnly; SameSite=Lax; Max-Age=604800; Path=/' + (isHttps(req) ? '; Secure' : ''));
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'qf_sess=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/');
}
/* 限流：命中就返回 429，并给出重试秒数 */
function rateLimit(req, res, kind, key) {
  const r = RL.check(kind, key);
  if (r.ok) return false;
  send(res, 429, { error: '请求过于频繁，请 ' + r.retryAfter + ' 秒后重试' }, null, { 'Retry-After': String(r.retryAfter) });
  return true;
}
function reqMeta(req) {
  return { ip: RL.clientIp(req), ua: String(req.headers['user-agent'] || '').slice(0, 200) };
}

/* ---------- 自然语言 → 结构化需求 ----------
 * 这一段的职责只有一句话：**把用户的口语翻成程序能执行的结构**。
 * 旧实现只认"N 道<题型>"和"每个知识点各出 N 道"两种句式，用户说
 * "这些知识点所有题型都各出一道题，并且要覆盖全部知识点"就会整句落空，
 * 退化成默认的"5 道选择题"——这正是用户反馈的问题。
 *
 * 现在的解析覆盖四类要素：
 *   1) 题型集合：说出"所有题型/题型不限/各种题型"→ 四种题型全上；否则只取点名的
 *   2) 覆盖范围：说"覆盖全部知识点/这些知识点/每个知识点"→ 逐知识点展开；
 *                点名了具体知识点 → 只出点名的（用知识点清单做匹配）
 *   3) 题量：有逐知识点意图时 "N 道" = 每个知识点每种题型各 N 道；否则 = 总量
 *   4) 其它约束：把剩下的、有约束含义的短语逐条收进 constraints，
 *                原样注入出题提示词（"不要出计算题""要有详细解析"这类以前直接丢失）
 */
const CN_NUM = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
/* 题型词 → 标准题型（补充了口语说法） */
const TYPE_WORDS = [
  ['单项选择', 'mcq'], ['选择', 'mcq'], ['单选', 'mcq'],
  ['简答', 'solution'], ['解答', 'solution'], ['主观题', 'solution'],
  ['算法设计', 'algo'], ['算法', 'algo'], ['编程', 'algo'], ['代码题', 'algo'],
  ['综合应用', 'app'], ['综合', 'app'], ['应用', 'app']
];
/* 覆盖全部知识点的说法 */
const ALL_KP_RE = /(全部|所有|每个|各个|逐个|这些|以上|该|全部的?)[^。；;\n]{0,6}(知识点|考点)|知识点[^。；;\n]{0,4}(全覆盖|都覆盖|全部覆盖|全部出|都出|都要|都考|全覆盖到|都覆盖到)|按知识点|逐知识点|知识点专项|覆盖[^。；;\n]{0,4}(全部|所有|每个)[^。；;\n]{0,4}(知识点|考点)/;
/* "题型不限/所有题型"的说法 */
const ALL_TYPE_RE = /(全部|所有|各个|每种|各|不同|各种)[^。；;\n]{0,4}题型|题型[^。；;\n]{0,4}(不限|都要|全覆盖|都出|都要有)|题型混排|混合题型|每种题型都/;
/* 约束性词汇：命中才当作"额外要求"保留，避免把口水词当约束 */
const CONSTRAINT_HINT = /(不要|不能|别|禁止|避免|必须|需要|务必|要|希望|尽量|注意|重点|侧重|偏向|结合|联系|实际|场景|应用|计算|证明|画图|图示|表格|步骤|详细|简洁|精简|通俗|难度|区分|易错|易混淆|多选|判断|填空|不给|附|标注|解析|思路|考察|考查|以及|并且|同时|还|另外)/;
const CONSTRAINT_STOP = /^(这些|那么|然后|就此|谢谢|麻烦|请|帮我|给我|我)?[^，。；;]{0,3}$/;

function detectDiff(text) {
  const clean = text.replace(/难度/g, '');
  return /冲刺|困难|很难|高难/.test(clean) ? 3 : /中等|强化|一般难/.test(clean) ? 2 : 1;
}
function detectChapter(text) {
  const m = text.match(/第\s*([一二三四五六七八九十1-9]+)\s*章/);
  return m ? (CN_NUM[m[1]] || parseInt(m[1]) || 1) : 1;
}
/* 从文本里提取"用户点名的知识点"（用清单名做包含匹配，避免把普通词组当成考点） */
function matchKPsInText(text, kps) {
  const hits = [];
  for (const k of (kps || [])) {
    const name = String(k.name || '');
    if (name.length < 3) continue;
    /* 用"去掉虚词后的核心词"匹配，避免"线性表与顺序存储"这种长名一个都用不上 */
    const core = name.replace(/[与和的及、，（(）)]/g, '');
    if (text.includes(name) || (core.length >= 4 && text.includes(core.slice(0, 4)))) hits.push(k.name);
  }
  return [...new Set(hits)];
}
/* 提取题型意图：
 *  - "所有/每种题型都各出一道" → 逐题型展开（题型集合 = 四种）
 *  - "题型不限/随便/你定"       → 不乘题型数（用户关心的是总量），题型先按选择题走，
 *                                 并把"题型不限"作为约束交给模型在出题时自行把握
 *  - 点名的题型                  → 只取点名的
 */
function detectTypeIntent(text) {
  const named = [];
  for (const [word, type] of TYPE_WORDS) {
    /* 必须出现在"题型语境"里才算，否则会误伤话题词：
     *   "算法的时间复杂度" → 这里的"算法"是考点，不是要出算法题；
     *   "结合实际应用场景" → 同理，不该被当成综合应用题。
     * 真正算数的三种写法：① <词>题；② N 道<词>；③ <词>各/都/不限/类型。 */
    const inTypeContext = new RegExp(word + '题').test(text)
      || new RegExp('道\\s*' + word).test(text)
      || new RegExp(word + '\\s*(各|都|不限|类型|和|与|、)').test(text);
    if (inTypeContext && !named.includes(type)) named.push(type);
  }
  if (named.length) return { types: named, unrestricted: false };
  if (/(题型)?(不限|随意|随便|你定|由你|都可以|无所谓|自行决定)/.test(text)) return { types: ['mcq'], unrestricted: true };
  if (ALL_TYPE_RE.test(text)) return { types: Reqs.TYPES.slice(), unrestricted: false };
  return { types: [], unrestricted: false };
}
/*
 * 提取"额外要求"：把句子切段，剔除已识别的部分，剩下的约束性短语收进来。
 * 例：输入"每个知识点各出 2 道选择题，中等难度，不要出计算题，解析要详细"
 *     → constraints = ['不要出计算题', '解析要详细']
 */
function detectConstraints(text, kpNames) {
  const segs = String(text)
    .split(/[。；;，,\n]|然后|并且|而且|同时|另外|以及|还有|再|且(?=[^\u4e00-\u9fa5])/g)
    .map(s => s.trim())
    .filter(s => s.length >= 4 && s.length <= 80);
  const out = [];
  for (const s of segs) {
    if (CONSTRAINT_STOP.test(s)) continue;
    /* 已转成结构的部分不再重复当作约束 */
    if (COUNT_RE.test(s) && detectTypeIntent(s).types.length) continue;   // "出 10 道选择题" 已识别为题量+题型
    if (COUNT_RE.test(s) && ALL_KP_RE.test(s)) continue;                  // "每个知识点各出 2 道" 已识别
    /* 整句只是在说"覆盖全部知识点"时不算额外要求（已经转成 coverage.mode=all 了）。
     * 判断方法：把覆盖短语抠掉、再去掉句首的虚词，剩下不足 3 个字就说明这句没别的意思。 */
    const rest = s.replace(new RegExp(ALL_KP_RE.source, 'g'), '')
      .replace(/^(要|须|需|必须|希望|请|然后|并且|而且|同时|另外|还有|以及|我|帮我|给我|让|把)+/g, '').trim();
    if (ALL_KP_RE.test(s) && rest.length < 3) continue;
    let s2 = s.replace(/^(然后|并且|而且|同时|另外|还有|以及|希望|要求|需要|请|帮我|给我|我)+/g, '').trim();
    if (s2.length < 4) continue;
    /* 只保留有约束含义的短语；另外把"点名知识点"的句子也排除（那属于覆盖范围） */
    if (kpNames.some(n => s2.includes(n))) continue;
    if (!CONSTRAINT_HINT.test(s2)) continue;
    if (out.includes(s2)) continue;
    out.push(s2.slice(0, 60));
    if (out.length >= 8) break;
  }
  return out;
}

/* 题量：阿拉伯数字与中文数字都要认（"一道题""两 道题"）。
 * 单位只认"道/题" —— 不认"个"，否则"一共 12 个知识点"会被当成题量。 */
const CN_DIGIT = { '一': 1, '两': 2, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
const COUNT_RE = new RegExp('(\\d+|[一二两三四五六七八九十]+)\\s*(?:道|题)');
function detectCount(text, fallback) {
  const m = COUNT_RE.exec(String(text || ''));
  if (!m) return fallback;
  const raw = m[1];
  const n = /^\d+$/.test(raw) ? +raw : (CN_DIGIT[raw] || 0);
  return n > 0 ? Math.max(1, Math.min(50, n)) : fallback;
}
/* 启发式解析（无 Key / 调用失败 / 演示模式下的兜底），同样要能听懂复杂说法。
 * 注意：这里只负责**识别意图**（覆盖范围、题型、每题型题量、额外要求），
 * 具体把意图展开成需求表由 normalizeParsed 统一做 —— 与模型路径共用同一套展开逻辑，
 * 避免两条路径行为不一致。 */
function heuristicParse(text, opts = {}) {
  const kps = (opts.kps || []);
  const matName = String(opts.materialName || '').replace(/\.(pdf|docx?|txt|md|pptx?)$/i, '');
  const diff = detectDiff(text);
  const chNum = detectChapter(text);
  const nameM = text.match(/(?:根据|依据|按照)?\s*([^。\n]{2,18}?)(?:的)?(?:课堂笔记|笔记|讲义|教材|资料)/);

  const typeIntent = detectTypeIntent(text);
  const wantsAllKP = ALL_KP_RE.test(text) && kps.length > 0;
  const namedKPs = matchKPsInText(text, kps);
  const constraints = detectConstraints(text, kps.map(k => k.name));
  if (typeIntent.unrestricted) constraints.unshift('题型不限：按题目内容选择最合适的题型出题');
  const countRaw = detectCount(text, null);
  const mode = wantsAllKP ? 'all' : (namedKPs.length ? 'listed' : 'none');
  /* 题量语义：
   *  mode=all/listed（逐知识点）→ 这个数字是"每个知识点每种题型各几道"
   *  mode=none                  → 这个数字是总题量 */
  const perCount = mode === 'none' ? null : (countRaw || 2);
  const name = (mode === 'all' ? (matName ? matName + '·知识点专项' : '知识点专项')
    : (nameM ? nameM[1] : (matName || text.replace(/\s+/g, ' ').slice(0, 18)))) || '对话制题';

  const requirements = [];
  if (mode === 'none') {
    requirements.push({ types: (typeIntent.types.length ? typeIntent.types : ['mcq']), count: countRaw || 5, kp: '', diff, ch: chNum });
  }
  return {
    name, subjectName: '', requirements,
    coverage: {
      mode,
      kps: namedKPs,
      types: typeIntent.types.length ? typeIntent.types : ['mcq'],
      perCount: perCount || countRaw || 5,
      strict: mode === 'all'
    },
    constraints,
    types: typeIntent.types
  };
}

/* NLU 提示词：把"要翻译成什么结构"讲清楚，并把知识点清单作为可引用的事实 */
function nluSystemPrompt(kpList) {
  const kpBlock = kpList.length
    ? '\n【这份资料已识别的知识点清单（kp 只能从这里选，名称必须一字不差）】\n' +
      kpList.slice(0, 60).map((k, i) => (i + 1) + '. ' + k.name + '（第' + (k.ch || 1) + '章' + (k.weight >= 4 ? '，重点' : '') + '）').join('\n')
    : '\n（这份资料还没有知识点清单，kp 留空即可）';
  return '你是制题需求解析器。把用户的中文需求翻译成结构化 JSON，只输出 JSON，不要任何解释。\n' +
    '输出格式：\n' +
    '{\n' +
    '  "name": "简短任务名(<=20字)",\n' +
    '  "subjectName": "科目名(可空)",\n' +
    '  "coverage": { "mode": "all|listed|none", "kps": ["知识点名"], "types": ["mcq","solution","algo","app"], "perCount": 2 },\n' +
    '  "constraints": ["用户的其它要求，一条一句"],\n' +
    '  "requirements": [ { "types": ["mcq"], "count": 2, "kp": "知识点名", "diff": 1, "ch": 1 } ],\n' +
    '  "understood": "用一句话复述你理解到的要求（给人看）"\n' +
    '}\n' +
    '字段说明：\n' +
    '- coverage.mode：all=用户要求覆盖全部知识点；listed=只考用户点名的知识点；none=没特别要求。\n' +
    '- coverage.types：用户要的题型。说"所有题型/各种题型/题型不限"就填全部四种 mcq,solution,algo,app；否则只填点名的。\n' +
    '- coverage.perCount：每个知识点每种题型各出几道（用户说"每个知识点各出 2 道"就是 2）。\n' +
    '- constraints：把用户提出的**其它一切要求**逐条收进来，例如"不要出计算题""解析要详细""结合实际应用场景""重点考第 2 章""难度中等偏上"。这条很重要，不要漏。\n' +
    '- requirements：mode=all 或 listed 时，**每个知识点一条**，types 填该需求的题型集合，count 为每种题型的数量；mode=none 时一条即可，kp 留空。\n' +
    '- 用户没提到的不要编造；不确定的用保守默认（types=["mcq"]，count=5，diff=1，ch=1）。\n' +
    '常见说法的翻译示例：\n' +
    '  "覆盖全部知识点，所有题型都各出一道" → mode=all, types=[四种], perCount=1\n' +
    '  "每个知识点各出 2 道题，题型不限" → mode=all, types=["mcq"], perCount=2, constraints 里写"题型不限"\n' +
    '  注意："题型不限/由你决定" **不要**翻译成四种题型都出满（那会把题量乘以 4，与用户预期不符）；\n' +
    '        只有明确说"每种/所有题型都各出 N 道"时，types 才填四种、count 填 N（语义是每种各 N 道）。\n' +
    '  "第 2 章出 10 道选择题，不要出计算题" → mode=none, requirements=[{types:["mcq"],count:10,ch:2}], constraints=["不要出计算题"]\n' +
    '  "覆盖全部知识点" → mode=all，不要把它再抄进 constraints（已经由 mode 表达了）' + kpBlock;
}

async function nluParse(text, cfg, meter, kps, materialName) {
  const hopts = { kps, materialName };
  const kpList = kps || [];
  if (cfg.mockMode) return normalizeParsed(heuristicParse(text, hopts), kpList, text);
  const nluProfile = Store.profileFor(cfg, 'nlu');
  if (nluProfile.missing || !nluProfile.apiKey) return normalizeParsed(heuristicParse(text, hopts), kpList, text);
  const sys = nluSystemPrompt(kpList);
  let parsed = null;
  try {
    const r = await callGuarded(nluProfile, [{ role: 'system', content: sys }, { role: 'user', content: text.slice(0, 6000) }],
      { meter, maxTokens: 1600, temperature: 0.1, pool: providerPool(cfg, 'nlu') });
    parsed = JSON.parse(String(r.content).replace(/```(json)?/g, '').trim());
  } catch (e) {
    /* 模型不可用或返回不可解析 → 用启发式兜底，但解析结果仍要走同一套规范化 */
    parsed = heuristicParse(text, hopts);
    parsed.fallbackReason = e.message;
  }
  return normalizeParsed(parsed, kpList, text);
}

/*
 * 把（无论来自模型还是启发式的）解析结果规范化成程序内部结构：
 *  - 按 coverage 展开 requirements（覆盖全部知识点时逐知识点一条）
 *  - 题型集合与题量夹取范围
 *  - kp 对齐到知识点清单里的标准名称（否则出题取材对不上）
 *  - 合并重复需求、去掉越界项、总题量护栏
 */
function normalizeParsed(parsed, kpList, text) {
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  const cov = p.coverage && typeof p.coverage === 'object' ? p.coverage : {};
  const types = (Array.isArray(cov.types) ? cov.types : []).map(Reqs.normType).filter(Boolean);
  const perCount = Math.max(1, Math.min(50, Math.round(+cov.perCount) || 0)) || 0;
  const mode = ['all', 'listed', 'none'].includes(cov.mode) ? cov.mode : 'none';
  const namedKPs = (Array.isArray(cov.kps) ? cov.kps : []).map(String).filter(Boolean);

  /* kp 对齐：模型可能写"循环队列"而清单里是"循环队列的判满判空" */
  const alignKP = (raw) => {
    const s = String(raw || '').trim();
    if (!s || !kpList.length) return s;
    const exact = kpList.find(k => k.name === s);
    if (exact) return exact.name;
    const loose = kpList.find(k => k.name.includes(s) || s.includes(k.name));
    return loose ? loose.name : s;
  };

  let reqs = Array.isArray(p.requirements) ? p.requirements : [];
  reqs = reqs.map(r => ({
    types: (Array.isArray(r.types) && r.types.length ? r.types : [r.type]).map(Reqs.normType).filter(Boolean),
    count: Math.round(+r.count) || 0,
    kp: alignKP(r.kp),
    diff: [1, 2, 3].includes(+r.diff) ? +r.diff : 1,
    ch: Math.max(1, Math.min(20, Math.round(+r.ch) || 1))
  })).filter(r => r.types.length && r.count > 0);

  /* 覆盖全部知识点：按清单逐条展开（题型/题量取 coverage 的声明） */
  if (mode === 'all' && kpList.length) {
    const ts = types.length ? types : ['mcq'];
    const per = perCount || 2;
    const byKP = new Map(reqs.filter(r => r.kp).map(r => [r.kp, r]));
    reqs = kpList.slice(0, 60).map(k => {
      const hit = byKP.get(k.name);
      return {
        types: (hit && hit.types.length ? hit.types : ts).slice(),
        count: per,
        kp: k.name,
        diff: hit ? hit.diff : (k.weight >= 4 ? 2 : 1),
        ch: (hit && hit.ch) || k.ch || 1
      };
    });
  } else if (mode === 'listed' && namedKPs.length) {
    const ts = types.length ? types : ['mcq'];
    const per = perCount || 2;
    reqs = namedKPs.map(nm => {
      const std = alignKP(nm);
      const hit = reqs.find(r => r.kp === std);
      const k = kpList.find(x => x.name === std);
      return { types: (hit && hit.types.length ? hit.types : ts).slice(), count: per, kp: std, diff: hit ? hit.diff : 1, ch: (hit && hit.ch) || (k && k.ch) || 1 };
    });
  }
  /* 补齐题型：模型给了 kp 却没给 types 时，用 coverage.types 兜底 */
  if (types.length) reqs.forEach(r => { if (!r.types.length) r.types = types.slice(); r.types = r.types.length ? r.types : ['mcq']; });
  if (!reqs.length) {
    const h = heuristicParse(text || '', { kps: kpList });
    return normalizeParsed(h, kpList, text);
  }
  /* 合并完全相同的需求（同 kp 同题型集合 → 题量相加），避免出现两条一模一样的行 */
  const merged = [];
  for (const r of reqs) {
    const key = r.kp + '|' + r.types.slice().sort().join(',') + '|' + r.diff + '|' + r.ch;
    const hit = merged.find(m => m._k === key);
    if (hit) hit.count = Math.min(50, hit.count + r.count);
    else merged.push(Object.assign({ _k: key }, r));
  }
  merged.forEach(m => delete m._k);

  const norm = Reqs.normalize(merged, { maxReqs: 200, maxTotal: 400, maxCount: 50 });
  /* 约束清理：
   *  - "要覆盖全部知识点"这类话已经由 coverage.mode 表达，再抄进 constraints 只会重复；
   *  - "题型不限"要保留（它确实是一条出题要求），但此时不能因为"不限"就把题量乘以题型数。 */
  const COVER_NOISE = /(覆盖|包含|都要?考|都出|都要?有|不漏)[^。；;]{0,6}(全部|所有|每个|各个)[^。；;]{0,4}(知识点|考点)/;
  const constraints = (Array.isArray(p.constraints) ? p.constraints : [])
    .map(c => String(c || '').trim())
    .filter(c => c.length >= 2 && c.length <= 80)
    .filter(c => !COVER_NOISE.test(c))
    .slice(0, 8);
  const byType = Reqs.totals(norm.list).byType;
  const unrestrictedType = constraints.some(c => /题型不限/.test(c)) ||
    (cov && Array.isArray(cov.types) && cov.types.length === 1 && /不限/.test(String(p.understood || '')));
  return {
    name: String(p.name || '').slice(0, 60) || '对话制题',
    subjectName: String(p.subjectName || '').slice(0, 40),
    requirements: norm.list,
    constraints,
    coverage: { mode, kps: namedKPs.map(alignKP), types: types.length ? types : Reqs.TYPES.slice(0, 1), perCount: perCount || null, strict: mode === 'all' },
    totals: Reqs.totals(norm.list),
    byType,
    understood: String(p.understood || '').slice(0, 120),
    perKP: mode === 'all' || (mode === 'listed' && norm.list.length > 1),
    fallbackReason: p.fallbackReason || null,
    warning: norm.dropped ? ('有 ' + norm.dropped + ' 条需求因超出上限被截断（总题量上限 400）')
      : (unrestrictedType ? '「题型不限」已按选择题处理（如需混合题型，请写明"所有题型各出一道"）' : (p.warning || null))
  };
}

/* 从资料库取资料 → {material, text, figures}
 * text 已拼接图形描述段落（供出题引用【图片id】），figures 供题目关联原图并在导出时内嵌 */
async function loadMaterialForTask(user, materialId) {
  const mat = await Store.loadMaterial(user.id, materialId);
  if (!mat) return null;
  const figs = await Store.listFigures(user.id, materialId);
  const figures = figs.map(f => ({ id: f.id, page: f.page, w: f.w, h: f.h, kb: f.kb, file: f.file, desc: f.desc || '' }));
  let text = mat.text || '';
  if (figures.length && !text.includes('资料附图')) {
    const described = figures.filter(f => f.desc);
    if (described.length) text += Vision.toMaterialSection(described);
  }
  return { material: mat, text, figures };
}

/* ---------- 识图后台任务管理 ---------- */
const vjobs = new Map();
const VJOB_TTL = 2 * 3600 * 1000;
const VJOB_MAX = 20;

async function startVisionJob(user, body) {
  const cfg = Store.loadConfig();
  configure(cfg);
  const visionProfile = Store.profileFor(cfg, 'vision');
  if (visionProfile.missing || !visionProfile.apiKey) return { error: '未配置「识图员」岗位的可用 API Key（管理端「API 池」里配置）' };
  let images = [], materialId = null;
  if (body.materialId) {
    materialId = body.materialId;
    const figs = await Store.listFigures(user.id, materialId);
    if (!figs.length) return { error: '该资料没有已归档的图片' };
    images = figs.map(f => ({ id: f.id, page: f.page, file: f.file, w: f.w, h: f.h, kb: f.kb }));
  } else {
    const reg = Store.loadParse(body.parseId);
    if (!reg || reg.userId !== user.id) return { error: '解析记录不存在或不属于当前用户', code: 404 };
    images = (body.ids && body.ids.length ? reg.images.filter(im => body.ids.includes(im.id)) : reg.images).filter(im => fs.existsSync(im.file));
  }
  if (!images.length) return { error: '没有可识别的图片' };
  if (body.limit) images = images.slice(0, +body.limit);

  for (const [k, v] of vjobs) if (Date.now() - v.startedAt > VJOB_TTL) vjobs.delete(k);
  while (vjobs.size >= VJOB_MAX) vjobs.delete(vjobs.keys().next().value);

  const job = {
    id: Store.id('vjob'), userId: user.id, materialId,
    status: 'running', total: images.length, done: 0, failed: 0,
    results: [], section: '', cost: 0, startedAt: Date.now(), endedAt: null, error: null
  };
  vjobs.set(job.id, job);

  const meter = newMeter(cfg.visionBudgetYuan || 2);
  job.donePromise = (async () => {
    try {
      const results = await Vision.describeAll(images, {
        profiles: { vision: visionProfile }, pool: providerPool(cfg, 'vision'),
        meter, mockMode: cfg.mockMode,
        onProgress: (n) => { job.done = n; }
      });
      job.results = results;
      job.failed = results.filter(r => !r.desc).length;
      job.section = Vision.toMaterialSection(results);
      job.cost = meter.spent;
      if (materialId) for (const r of results) if (r.desc) await Store.saveFigureDesc(user.id, materialId, r.id, r.desc);
      if (meter.spent > 0) {
        /* 识图计费走账单表（幂等键含任务 id），避免重试导致重复扣费 */
        await db.billAndDeduct(user.id, {
          kind: 'vision', amount: meter.spent,
          reason: '图形识别 ' + results.length + ' 张',
          idemKey: 'vision:' + job.id
        });
      }
      job.status = 'done';
    } catch (e) {
      job.status = 'error'; job.error = e.message;
    } finally {
      job.endedAt = Date.now();
    }
  })();
  return { jobId: job.id, total: images.length };
}

/* 把题目整理成 AI 可读的上下文文本 */
function buildQuestionContext(q) {
  let t = '【题型】' + (Reqs.TYPE_CN[q.type] || q.type) + '【章节】第' + q.ch + '章【考点】' + q.kp + '\n【题目】\n' + q.stem;
  if (q.options) t += '\n【选项】\n' + q.options.map((o, i) => 'ABCD'[i] + '. ' + o).join('\n');
  if (q.answer) t += '\n【正确答案】' + q.answer;
  if (q.expl) t += '【题库解析】' + q.expl;
  if (q.ref) t += '\n【参考答案要点】' + String(q.ref).slice(0, 600);
  return t;
}
/* 岗位 → 候选供应商池 */
function providerPool(cfg, role) {
  const prof = (cfg.profiles && cfg.profiles[role]) || {};
  return (prof.providerIds || [])
    .map(id => cfg.providers.find(p => p.id === id))
    .filter(p => p && p.apiKey && p.enabled !== false)
    .map(p => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, apiKey: p.apiKey, priceIn: p.priceIn, priceOut: p.priceOut, role }));
}

/* ---------- 题目 → 前端结构 ---------- */
function practiceQuestion(r) {
  const o = {
    id: r.id, taskId: r.task_id || r.taskId, type: r.type, ch: r.ch, kp: r.kp, diff: r.diff,
    stem: r.stem,
    mine: {
      hidden: !!r.hidden, starred: !!r.starred, attempts: r.attempts || 0,
      wrong: r.wrong || 0, last_right: r.last_right, last_ts: r.last_ts || null
    }
  };
  if (r.type === 'mcq') { o.options = r.options_json || r.options; o.answer = r.answer; o.expl = r.expl; }
  else o.ref = r.ref;
  const fig = r.fig_id || r.fig;
  if (fig) o.img = '/api/practice/figure?taskId=' + encodeURIComponent(r.task_id || r.taskId) + '&figId=' + encodeURIComponent(fig);
  return o;
}

/* ---------- 知识点抽取（AI 先看懂资料有哪些知识点） ---------- */
async function extractKPsFor(user, { materialId, text, force }) {
  const cfg = Store.loadConfig();
  if (materialId) {
    const mat = await Store.loadMaterial(user.id, materialId);
    if (!mat) { const e = new Error('资料不存在或不属于当前用户'); e.code = 404; throw e; }
    if (!force) {
      const cached = await db.listKPs(user.id, { materialId });
      if (cached.length) return { kps: cached, source: cached[0].source, cached: true };
    }
    text = mat.text;
  }
  const src = String(text || '');
  if (src.length < 20) { const e = new Error('内容太短，无法提取知识点'); e.code = 400; throw e; }
  const meter = newMeter(+(cfg.kpBudgetYuan || 0.2));
  const prof = Store.profileFor(cfg, cfg.profiles.classifier ? 'classifier' : 'nlu');
  const out = await KP.extract(src, {
    profile: prof, callLLM, meter, mockMode: cfg.mockMode, limit: KP.MAX_KPS
  });
  if (meter.spent > 0) {
    await db.billAndDeduct(user.id, {
      kind: 'kp', amount: meter.spent, reason: '知识点抽取',
      /* 同一份资料重复抽取只扣一次（内容哈希做幂等键） */
      idemKey: 'kp:' + user.id + ':' + crypto.createHash('sha1').update(src.slice(0, 4000)).digest('hex').slice(0, 16)
    });
  }
  if (materialId) await db.saveKPs(user.id, materialId, null, out.list);
  return { kps: out.list, source: out.source, cached: false, error: out.error || null };
}

/* ---------- 路由 ---------- */
async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  /* 静态文件 */
  if (req.method === 'GET' && !p.startsWith('/api/')) {
    if (p.includes('..')) return send(res, 404, 'Not Found', 'text/plain');
    const file = p === '/' ? '/index.html' : p;
    const full = path.join(WEB, path.normalize(file).replace(/^([/\\])+/, ''));
    if (!full.startsWith(WEB) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return send(res, 404, 'Not Found', 'text/plain');
    const ext = path.extname(full);
    const headers = ext === '.css' || ext === '.js' ? { 'Cache-Control': 'public, max-age=60' } : {};
    return send(res, 200, fs.readFileSync(full), MIME[ext] || 'application/octet-stream', headers);
  }

  try {
    /* ===== 健康检查（不需要登录；供容器探针/负载均衡使用，不含敏感信息） ===== */
    if (p === '/api/health' && req.method === 'GET') {
      let dbState = { ok: false };
      try { dbState = await db.ping(); } catch (e) { dbState = { ok: false, error: e.message }; }
      const ok = !!dbState.ok;
      return send(res, ok ? 200 : 503, {
        ok, version: VERSION, uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
        db: dbState, queue: { running: running.size }, mock: Store.isMock()
      });
    }

    /* ===== 认证（无需登录） ===== */
    if (p === '/api/auth/register' && req.method === 'POST') {
      if (rateLimit(req, res, 'register', RL.clientIp(req))) return;
      const { username, password } = JSON.parse((await readBody(req, 1)).toString('utf8'));
      if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,20}$/.test(username || '')) return send(res, 400, { error: '用户名需 2-20 位（中文/字母/数字/下划线）' });
      if (!password || String(password).length < 6) return send(res, 400, { error: '密码至少 6 位' });
      if (String(password).length > 128) return send(res, 400, { error: '密码过长（上限 128 位）' });
      if (await db.findUserByName(username)) return send(res, 400, { error: '用户名已存在' });
      /* 系统第一个注册的用户自动成为管理员（因此用户号是 admin1，后续注册的是 u1、u2…） */
      const [cntRows] = await db.q('SELECT COUNT(*) c FROM users');
      const isFirstUser = Number(cntRows[0].c) === 0;
      const cfg0 = Store.loadConfig();
      const userId = await db.createUser(username, String(password), {
        role: isFirstUser ? 'admin' : 'user', bonus: +(cfg0.signupBonus || 5)
      });
      const u = await db.findUserById(userId);
      if (isFirstUser) await db.logOp(userId, 'grant', '系统首个用户，授予管理员权限（用户号 ' + u.user_no + '）');
      await db.logOp(userId, 'register', '注册账号，赠送体验金 ¥' + (+(cfg0.signupBonus || 5)).toFixed(2), { ...reqMeta(req) });
      const token = await db.createSession(userId, { ...reqMeta(req) });
      setSessionCookie(res, token, req);
      return send(res, 200, { ok: true, username, userNo: u.user_no, role: u.role });
    }
    if (p === '/api/auth/login' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 1)).toString('utf8'));
      const username = String(body.username || '');
      /* 限流按 IP + 用户名做键：既防单机暴力破解，也不至于让同办公室的人互相影响 */
      if (rateLimit(req, res, 'login', RL.clientIp(req) + '|' + username)) return;
      const user = await db.findUserByName(username);
      if (!user || db.hashPassword(body.password || '', user.salt) !== user.pwd_hash) {
        log.warn('login_failed', { username, ip: RL.clientIp(req) });
        return send(res, 401, { error: '用户名或密码错误' });
      }
      RL.reset('login:' + RL.clientIp(req) + '|' + username);
      const token = await db.createSession(user.id, { ...reqMeta(req) });
      setSessionCookie(res, token, req);
      await db.logOp(user.id, 'login', '登录（用户号 ' + user.user_no + '）', { ...reqMeta(req) });
      return send(res, 200, { ok: true, username: user.username, userNo: user.user_no, role: user.role });
    }
    if (p === '/api/auth/logout' && req.method === 'POST') {
      clearSessionCookie(res);
      const token = parseCookies(req).qf_sess;
      if (token) await db.destroySession(token);
      return send(res, 200, { ok: true });
    }

    /* ===== 以下全部需要登录 ===== */
    if (p === '/api/me' && req.method === 'GET') {
      const user = await getUser(req);
      if (!user) return send(res, 200, { authed: false });
      const cfg = Store.loadConfig();
      const ck = await db.checkinInfo(user.id).catch(() => ({ checkedToday: false, streak: 0, onlineMs: 0 }));
      return send(res, 200, {
        authed: true, username: user.username, balance: +(await db.getBalance(user.id)).toFixed(4),
        role: user.role, userNo: user.user_no, signupBonus: cfg.signupBonus,
        checkin: ck,
        revertPending: user.role === 'admin' ? await db.countPendingReverts().catch(() => 0) : undefined
      });
    }

    /* 全局状态（登录后） */
    if (p === '/api/state' && req.method === 'GET') return requireUser(async (req, res, user) => {
      const cfg = Store.loadConfig();
      const tasks = await Store.listTasks(user.id);
      return send(res, 200, {
        tasks: tasks.map(publicTask), config: publicConfig(cfg, user),
        memory: Store.loadMemory().length, running: [...running],
        checkin: await db.checkinInfo(user.id).catch(() => null),
        revertPending: user.role === 'admin' ? await db.countPendingReverts().catch(() => 0) : 0,
        evals: Store.listEvals().map(e => ({ id: e.id, ts: e.ts, mock: e.mock, verdict: e.verdict, accuracy: e.results && e.results.consensus ? e.results.consensus.accuracy : null }))
      });
    })(req, res);

    /* ===== 签到 / 在线时长 ===== */
    if (p === '/api/checkin' && req.method === 'POST') return requireUser(async (req, res, user) => {
      const r = await db.checkin(user.id);
      await db.logOp(user.id, 'checkin', '签到' + (r.fresh ? '成功，连续 ' + r.streak + ' 天' : '（今日已签到）'));
      return send(res, 200, r);
    })(req, res);
    if (p === '/api/checkin' && req.method === 'GET') return requireUser(async (req, res, user) => {
      return send(res, 200, Object.assign(await db.checkinInfo(user.id), { board: await db.checkinBoard(14) }));
    })(req, res);

    /* 资料解析（临时会话，识图后可保存进资料库） */
    if (p === '/api/parse' && req.method === 'POST') return requireUser(async (req, res, user) => {
      if (rateLimit(req, res, 'upload', RL.clientIp(req))) return;
      const buf = await readBody(req, 30);
      const name = (url.searchParams.get('name') || 'upload.bin').replace(/[\\/:*?"<>|]/g, '_');
      const parseId = Store.id('parse');
      const tmpDir = path.join(Store.dirs.tmp, parseId);
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmp = Store.saveTmp(parseId + '_' + name, buf);
      const out = await new Promise((resolve) => {
        const py = spawn('python', [path.join(__dirname, 'lib', 'parse.py'), tmp, tmpDir], { windowsHide: true });
        let so = '';
        py.stdout.on('data', d => so += d);
        py.stderr.on('data', d => so += d);
        py.on('close', () => { try { resolve(JSON.parse(so.trim().split('\n').pop())); } catch (e) { resolve({ ok: false, error: '解析输出异常: ' + so.slice(0, 300) }); } });
      });
      if (out.ok) {
        out.parseId = parseId;
        Store.saveParse(parseId, { parseId, userId: user.id, name, ts: Date.now(), images: out.images, stats: out.stats, pages: out.pages });
      }
      return send(res, 200, out);
    })(req, res);

    /* 保存进资料库 */
    if (p === '/api/materials' && req.method === 'POST') return requireUser(async (req, res, user) => {
      const body = JSON.parse((await readBody(req, 2)).toString('utf8'));
      if (!body.name || !body.text) return send(res, 400, { error: '缺少名称或内容' });
      const reg = body.parseId ? Store.loadParse(body.parseId) : null;
      if (body.parseId && (!reg || reg.userId !== user.id)) return send(res, 403, { error: '解析会话不属于当前用户' });
      const id = Store.id('mat');
      const mat = { id, userId: user.id, name: String(body.name).slice(0, 150), text: body.text, kind: (reg && reg.name || '').split('.').pop() || 'txt', pages: reg ? reg.pages : null, chars: body.text.length, figure_count: (reg && reg.images ? reg.images.length : 0) };
      await Store.saveMaterial(user.id, mat);
      if (reg && reg.images && reg.images.length) {
        const dir = path.join(Store.dirs.uploads, String(user.id), id);
        fs.mkdirSync(dir, { recursive: true });
        const figs = reg.images.map(im => {
          const dst = path.join(dir, path.basename(im.file));
          try { fs.copyFileSync(im.file, dst); } catch (e) { /* 忽略 */ }
          return { id: im.id, orig_id: im.id, page: im.page, w: im.w, h: im.h, kb: im.kb, file: dst, desc: (body.figureDescs && body.figureDescs[im.id]) || '' };
        });
        await Store.saveFigures(user.id, id, figs);
      }
      await db.logOp(user.id, 'material', '保存资料「' + mat.name + '」（' + mat.chars + ' 字' + (mat.figure_count ? '，' + mat.figure_count + ' 张图' : '') + '）',
        { meta: { materialId: id } });
      return send(res, 200, { id, figure_count: mat.figure_count });
    })(req, res);
    if (p === '/api/materials' && req.method === 'GET') return requireUser(async (req, res, user) => {
      return send(res, 200, await Store.listMaterials(user.id));
    })(req, res);
    const mm = p.match(/^\/api\/materials\/([^/]+)(?:\/(figures))?$/);
    if (mm && req.method === 'GET') return requireUser(async (req, res, user) => {
      const mat = await Store.loadMaterial(user.id, mm[1]);
      if (!mat) return send(res, 404, { error: '资料不存在' });
      if (mm[2] === 'figures') return send(res, 200, await Store.listFigures(user.id, mm[1]));
      return send(res, 200, mat);
    })(req, res);
    /* 删除资料 = 软删除（正文与图片都保留），因此「操作记录」里可以一键撤销恢复 */
    if (mm && mm[2] !== 'figures' && req.method === 'DELETE') return requireUser(async (req, res, user) => {
      const mat = await Store.loadMaterial(user.id, mm[1]);
      if (!mat) return send(res, 404, { error: '资料不存在或不属于当前用户' });
      const ok = await Store.deleteMaterial(user.id, mm[1]);
      if (!ok) return send(res, 404, { error: '资料不存在或已删除' });
      await db.logOp(user.id, 'material_del', '删除资料「' + mat.name + '」（' + mat.chars + ' 字，可从操作记录撤销恢复）',
        { revertible: true, meta: { materialId: mm[1], name: mat.name } });
      return send(res, 200, { ok: true, soft: true });
    })(req, res);

    /* 知识点：读取 / 抽取 */
    if (p === '/api/kps' && req.method === 'GET') return requireUser(async (req, res, user) => {
      const materialId = url.searchParams.get('materialId');
      const taskId = url.searchParams.get('taskId');
      return send(res, 200, await db.listKPs(user.id, { materialId, taskId }));
    })(req, res);
    if (p === '/api/kps/extract' && req.method === 'POST') return requireUser(async (req, res, user) => {
      if (rateLimit(req, res, 'llm', String(user.id))) return;
      const body = JSON.parse((await readBody(req, 2)).toString('utf8'));
      try {
        const out = await extractKPsFor(user, { materialId: body.materialId, text: body.text, force: !!body.force });
        if (body.taskId && out.kps.length) await db.saveKPs(user.id, null, body.taskId, out.kps);
        await db.logOp(user.id, 'kps', '抽取知识点 ' + out.kps.length + ' 个' + (out.cached ? '（命中缓存）' : ''));
        return send(res, 200, { kps: out.kps, source: out.source, cached: out.cached, warning: out.error || null });
      } catch (e) {
        return send(res, e.code || 500, { error: e.message });
      }
    })(req, res);

    /* 图形识别 */
    if (p === '/api/vision/start' && req.method === 'POST') return requireUser(async (req, res, user) => {
      if (rateLimit(req, res, 'llm', String(user.id))) return;
      const body = JSON.parse((await readBody(req, 1)).toString('utf8'));
      const started = await startVisionJob(user, body);
      if (started.error) return send(res, started.code || 400, { error: started.error });
      return send(res, 200, { jobId: started.jobId, total: started.total });
    })(req, res);

    if (p === '/api/vision/job' && req.method === 'GET') return requireUser(async (req, res, user) => {
      const job = vjobs.get(url.searchParams.get('id'));
      if (!job || job.userId !== user.id) return send(res, 404, { error: '任务不存在' });
      return send(res, 200, {
        jobId: job.id, status: job.status, total: job.total, done: job.done,
        cost: +job.cost.toFixed(5), failed: job.failed, chars: job.section ? job.section.length : 0,
        results: job.results.map(r => ({ id: r.id, page: r.page, desc: r.desc || '', error: r.error || null })),
        section: job.status === 'done' ? job.section : undefined,
        error: job.error || null, ms: job.endedAt ? job.endedAt - job.startedAt : Date.now() - job.startedAt
      });
    })(req, res);

    if (p === '/api/vision' && req.method === 'POST') return requireUser(async (req, res, user) => {
      if (rateLimit(req, res, 'llm', String(user.id))) return;
      const body = JSON.parse((await readBody(req, 1)).toString('utf8'));
      const started = await startVisionJob(user, body);
      if (started.error) return send(res, started.code || 400, { error: started.error });
      const job = vjobs.get(started.jobId);
      const t0 = Date.now();
      await job.donePromise;
      return send(res, 200, {
        results: job.results, section: job.section, chars: job.section.length,
        cost: +job.cost.toFixed(5), calls: job.done, ms: Date.now() - t0, failed: job.failed
      });
    })(req, res);

    /* 对话制题：自然语言 → 结构化需求 + 报价
     * 现在会先取该资料已识别的知识点（没有就现抽一份），再交给 NLU 解析，
     * 因此"每个知识点各出 2 道"这类说法能被正确展开成逐知识点的需求。 */
    if (p === '/api/chat/parse' && req.method === 'POST') return requireUser(async (req, res, user) => {
      if (rateLimit(req, res, 'llm', String(user.id))) return;
      const body = JSON.parse((await readBody(req, 2)).toString('utf8'));
      const reqText = String(body.requirementText || body.text || '').trim();
      let materialText = '', figures = [], matInfo = null, kps = [];
      if (body.materialId) {
        const m = await loadMaterialForTask(user, body.materialId);
        if (!m) return send(res, 404, { error: '资料不存在或不属于当前用户' });
        materialText = m.text;
        figures = m.figures;
        matInfo = { id: m.material.id, name: m.material.name, chars: m.material.chars, figures: m.figures.length };
        if (reqText.length < 4) return send(res, 400, { error: '请描述你的出题需求（例如：出 10 道选择题，重点考时间复杂度；也可以说"每个知识点各出 2 道"）' });
        kps = await db.listKPs(user.id, { materialId: body.materialId });
        /* 首次使用这份资料：先自动抽取知识点（失败也不阻断，退回规则/空清单） */
        if (!kps.length && !body.skipKPs) {
          try {
            const out = await extractKPsFor(user, { materialId: body.materialId });
            kps = out.kps;
          } catch (e) { log.warn('kp_extract_failed', { msg: e.message, materialId: body.materialId }); }
        }
        /* 前端可以只传用户勾选的那部分知识点（"我只想考这几章"） */
        if (Array.isArray(body.kps) && body.kps.length) {
          const picked = new Set(body.kps.map(x => String(x.name || x)));
          const only = kps.filter(k => picked.has(k.name));
          if (only.length) kps = only;
        }
      } else {
        materialText = String(body.materialText || body.text || '').trim();
        if (materialText.length < 10) return send(res, 400, { error: '请粘贴资料内容，或从资料库选择已有资料（至少 10 个字）' });
        if (body.extractKPs) {
          try { kps = (await extractKPsFor(user, { text: materialText })).kps; } catch (e) { /* 忽略 */ }
        }
      }
      const cfg = Store.loadConfig();
      const sanMat = sanitizeMaterial(materialText);
      const sanReq = sanitizeMaterial(reqText);
      const meter = newMeter(0.05);
      const parsed = await nluParse(sanReq.text, cfg, meter, kps, matInfo ? matInfo.name : "");
      const verifierCount = Object.keys(cfg.profiles).filter(k => k.startsWith('verifier')).length;
      const est = Cost.estimateCost({
        materialChars: sanMat.text.length, requirements: parsed.requirements, verifierCount,
        profiles: Store.pricedProfiles(cfg), retryFactor: cfg.retryFactor, figureCount: figures.length
      });
      const taskLike = { id: 'preview', name: parsed.name, requirements: parsed.requirements, material: { rawChars: sanMat.text.length } };
      if (meter.spent > 0) {
        await db.billAndDeduct(user.id, { kind: 'nlu', amount: meter.spent, reason: '需求解析（含知识点识别）' });
      }
      return send(res, 200, {
        parsed, est, materialText: sanMat.text, materialInfo: matInfo,
        kps, perKP: !!parsed.perKP,
        quoteText: Cost.quoteText(taskLike, est, cfg),
        balance: +(await db.getBalance(user.id)).toFixed(4),
        warnings: sanMat.warnings.concat(sanReq.warnings)
      });
    })(req, res);

    /* 对话制题：确认报价 → 创建任务并启动 */
    if (p === '/api/chat/confirm' && req.method === 'POST') return requireUser(async (req, res, user) => {
      const body = JSON.parse((await readBody(req, 2)).toString('utf8'));
      const parsed = body.parsed;
      if (!parsed || !Array.isArray(parsed.requirements) || !parsed.requirements.length) return send(res, 400, { error: '需求解析结果无效，请重新描述' });
      /* 再规范化一次：请求体可能来自手工构造（或解析结果被前端改过），
       * 题型/题量/章节都要夹到合法范围，避免把非法需求写进任务里。 */
      const normReqs = Reqs.normalize(parsed.requirements, { maxReqs: 200, maxTotal: 400 });
      if (!normReqs.list.length) return send(res, 400, { error: '需求条目无效，请重新描述' });
      /* 解析出的额外要求 + 用户在表单里手填的（手填的优先保留，去重后最多 8 条） */
      const constraints = (Array.isArray(parsed.constraints) ? parsed.constraints : [])
        .concat(Array.isArray(body.constraints) ? body.constraints : [])
        .map(c => String(c || '').trim()).filter(c => c.length >= 2 && c.length <= 80)
        .filter((c, i, arr) => arr.indexOf(c) === i)
        .slice(0, 8);
      const cfg = Store.loadConfig();
      let materialText = '', figures = [];
      if (body.materialId) {
        const m = await loadMaterialForTask(user, body.materialId);
        if (!m) return send(res, 404, { error: '资料不存在或不属于当前用户' });
        materialText = m.text; figures = m.figures;
      } else {
        materialText = String(body.materialText || body.text || '');
      }
      const san = sanitizeMaterial(materialText);
      const verifierCount = Object.keys(cfg.profiles).filter(k => k.startsWith('verifier')).length;
      const est = Cost.estimateCost({
        materialChars: san.text.length, requirements: normReqs.list, verifierCount,
        profiles: Store.pricedProfiles(cfg), retryFactor: cfg.retryFactor, figureCount: figures.length
      });
      const balance = await db.getBalance(user.id);
      const need = +(est.total * 1.15).toFixed(4);
      if (balance < need) return send(res, 400, { error: '余额不足：需约 ¥' + need + '，当前余额 ¥' + balance.toFixed(2) + '。请到「个人中心」充值' });
      const kps = Array.isArray(body.kps) && body.kps.length
        ? body.kps.map(k => ({ ch: k.ch, name: String(k.name).slice(0, 60), detail: String(k.detail || '').slice(0, 200), weight: +k.weight || 1 }))
        : await db.listKPs(user.id, { materialId: body.materialId });
      /* 任务名优先用用户手填的；defer=true 表示"只存为待批准任务，先不启动" */
      const taskName = String(body.name || '').trim().slice(0, 150) || String(parsed.name || '对话制题').slice(0, 150);
      const defer = !!body.defer;
      const task = {
        id: Store.id('t'), userId: user.id, name: taskName, createdAt: Date.now(),
        subject: { school: '', name: parsed.subjectName || '未命名科目', chapters: [{ no: 1, name: '第一章' }] },
        material: { text: san.text, rawChars: san.text.length, warnings: san.warnings },
        requirements: normReqs.list, quote: { est, price: est.total * (1 + (cfg.marginPct || 0) / 100) },
        /* constraints：客户原话里的其它要求，出题时逐条注入提示词
         * coverageStrict：客户要求"覆盖全部知识点"→ 跑完自动补缺的考点 */
        constraints,
        coverageStrict: !!(parsed.coverage && parsed.coverage.strict) || !!(body.coverageStrict),
        budgetYuan: need, status: defer ? 'draft' : 'approved', phase: null, progress: {},
        costs: { spent: 0, byProfile: {}, calls: 0, billed: 0 }, stats: null, exported: null, error: null, visionCost: 0,
        kps, coveredChunks: [],
        figures
      };
      await Store.createTask(task);
      san.warnings.forEach(w => Store.logEvent(task.id, { step: 'guard', level: 'warn', msg: w }).catch(() => {}));
      await Store.logEvent(task.id, {
        step: 'chat', level: 'info',
        msg: '对话制题：' + JSON.stringify(normReqs.list) + (figures.length ? '（引用资料库附图 ' + figures.length + ' 张）' : '') +
          (kps.length ? '；参考知识点 ' + kps.length + ' 个' : '') +
          (constraints.length ? '；额外要求：' + constraints.join('；') : '')
      }).catch(() => {});
      await db.logOp(user.id, 'task_create', '对话制题「' + task.name + '」（' + Reqs.totals(normReqs.list).total + ' 题，预估 ¥' + est.total.toFixed(3) +
        (defer ? '，已存为待批准' : '') + '）', { meta: { taskId: task.id } });
      if (defer) {
        await Store.logEvent(task.id, { step: 'quote', level: 'info', msg: '已存为待批准任务（用户选择稍后手动启动），预算 ¥' + need }).catch(() => {});
        return send(res, 200, { taskId: task.id, deferred: true });
      }
      if (!running.has(task.id)) {
        running.add(task.id);
        Agent.runTask(task.id).catch(() => { }).finally(() => running.delete(task.id));
      }
      return send(res, 200, { taskId: task.id });
    })(req, res);

    /* 精确制题：新建任务（含自动报价与待批准状态） */
    if (p === '/api/tasks' && req.method === 'POST') return requireUser(async (req, res, user) => {
      const body = JSON.parse((await readBody(req, 2)).toString('utf8'));
      if (!body.name || !Array.isArray(body.requirements) || !body.requirements.length) {
        return send(res, 400, { error: '缺少任务名或出题需求' });
      }
      /* 精确制题的表单行是"一种题型 × 几道"，规范化后统一成 types 结构，
       * 与对话制题走同一套语义（计价/出题/续跑都不需要分支）。 */
      const normReqs = Reqs.normalize(body.requirements, { maxReqs: 200, maxTotal: 400 });
      if (!normReqs.list.length) return send(res, 400, { error: '出题需求无效，请检查题型与数量' });
      const constraints = (Array.isArray(body.constraints) ? body.constraints : String(body.constraints || '').split(/\n|；|;/))
        .map(c => String(c || '').trim()).filter(c => c.length >= 2 && c.length <= 80).slice(0, 8);
      const coverageStrict = !!body.coverageStrict;
      let materialText = String(body.materialText || '').trim();
      let figures = [];
      if (body.materialId) {
        const m = await loadMaterialForTask(user, body.materialId);
        if (!m) return send(res, 404, { error: '资料不存在或不属于当前用户' });
        materialText = m.text;
        figures = m.figures.map(f => ({ id: f.id, page: f.page, w: f.w, h: f.h, kb: f.kb, file: f.file, desc: f.desc || '' }));
      }
      if (!materialText) return send(res, 400, { error: '缺少资料内容：请上传文件、粘贴文本，或从资料库选择' });
      const cfg = Store.loadConfig();
      const san = sanitizeMaterial(materialText);
      const verifierCount = Object.keys(cfg.profiles).filter(k => k.startsWith('verifier')).length;
      if (!body.materialId && body.parseId) {
        const reg = Store.loadParse(body.parseId);
        if (reg && reg.userId === user.id) {
          figures = (body.imageIds && body.imageIds.length
            ? reg.images.filter(im => body.imageIds.includes(im.id))
            : reg.images).map(im => ({
              id: im.id, page: im.page, file: im.file, w: im.w, h: im.h, kb: im.kb,
              desc: (body.figureDescs && body.figureDescs[im.id]) || ''
            }));
        }
      }
      const est = Cost.estimateCost({
        materialChars: san.text.length, requirements: normReqs.list,
        verifierCount, profiles: Store.pricedProfiles(cfg), retryFactor: cfg.retryFactor,
        figureCount: figures.length
      });
      const task = {
        id: Store.id('t'), userId: user.id, name: String(body.name).slice(0, 150), createdAt: Date.now(),
        subject: body.subject || { school: '自定义', name: '未命名科目', chapters: [{ no: 1, name: '第一章' }] },
        material: { text: san.text, rawChars: san.text.length, warnings: san.warnings },
        requirements: normReqs.list, quote: { est, price: est.total * (1 + (cfg.marginPct || 0) / 100) },
        constraints, coverageStrict,
        budgetYuan: +(est.total * 1.15).toFixed(3), status: 'draft', phase: null, progress: {},
        costs: { spent: 0, byProfile: {}, calls: 0, billed: 0 }, stats: null, exported: null, error: null,
        visionCost: +body.visionCost || 0,
        kps: Array.isArray(body.kps) ? body.kps.slice(0, 60) : [],
        coveredChunks: [],
        source: body.materialId ? { type: 'library', materialId: body.materialId } : (body.parseId ? { type: 'upload', parseId: body.parseId } : { type: 'paste' }),
        figures: []
      };
      await Store.createTask(task);
      if (figures.length) {
        task.figures = body.materialId ? figures : Store.adoptImages(task.id, figures);
        await Store.saveTask(task);
        await Store.logEvent(task.id, {
          step: 'ingest', level: 'info',
          msg: '资料附图 ' + figures.length + ' 张已关联' + (body.materialId ? '（来自资料库）' : '') +
            (task.visionCost ? '，识图已花 ¥' + task.visionCost : '')
        }).catch(() => { });
      }
      san.warnings.forEach(w => Store.logEvent(task.id, { step: 'guard', level: 'warn', msg: w }).catch(() => { }));
      await Store.logEvent(task.id, {
        step: 'quote', level: 'info',
        msg: '成本估算 ¥' + est.total.toFixed(3) + '（含识图 ' + figures.length + ' 张），建议报价 ¥' + task.quote.price.toFixed(2) +
          (task.kps.length ? '；参考知识点 ' + task.kps.length + ' 个' : '')
      }).catch(() => { });
      await db.logOp(user.id, 'task_create', '新建制题任务「' + task.name + '」（' + Reqs.totals(task.requirements).total + ' 题，预估 ¥' + est.total.toFixed(3) + '，待批准）',
        { meta: { taskId: task.id } });
      return send(res, 200, {
        task: publicTask(task), quoteText: Cost.quoteText(publicTask(task), est, cfg),
        figures: task.figures.map(f => ({ id: f.id, page: f.page, w: f.w, h: f.h, kb: f.kb }))
      });
    })(req, res);

    /* 任务详情 / 操作 */
    const tm = p.match(/^\/api\/tasks\/([^/]+)(?:\/(approve|run|export))?$/);
    if (tm && req.method === 'GET' && !tm[2]) return requireUser(async (req, res, user) => {
      const t = await Store.loadTask(tm[1]);
      if (!t || t.userId !== user.id) return send(res, 404, { error: '任务不存在' });
      const cfg = Store.loadConfig();
      const questions = await Store.loadQuestions(t.id);
      return send(res, 200, {
        task: publicTask(t), questions, events: await Store.loadEvents(t.id, 120),
        quoteText: Cost.quoteText(publicTask(t), t.quote.est, cfg),
        runningNow: running.has(t.id),
        kps: await db.listKPs(user.id, { taskId: t.id })
      });
    })(req, res);
    if (tm && req.method === 'POST') return requireUser(async (req, res, user) => {
      const t = await Store.loadTask(tm[1]);
      if (!t || t.userId !== user.id) return send(res, 404, { error: '任务不存在' });
      const body = JSON.parse((await readBody(req, 1)).toString('utf8') || '{}');
      if (tm[2] === 'approve') {
        if (t.status !== 'draft') return send(res, 400, { error: '当前状态不能批准：' + t.status });
        if (body.budgetYuan) t.budgetYuan = Math.max(0.01, Math.min(100000, +body.budgetYuan));
        t.status = 'approved';
        await Store.saveTask(t);
        await Store.logEvent(t.id, { step: 'approve', level: 'info', msg: '报价已批准，预算 ¥' + t.budgetYuan }).catch(() => { });
        await db.logOp(user.id, 'task_approve', '批准任务「' + t.name + '」预算 ¥' + t.budgetYuan,
          { revertible: true, meta: { taskId: t.id, budgetYuan: t.budgetYuan } });
        return send(res, 200, { task: publicTask(t) });
      }
      if (tm[2] === 'run') {
        /* 允许续跑的状态；running 表示"上次进程中断留下的僵尸状态"，
         * 只要本进程确实没在跑它（!running.has），就允许用户重新接管续跑 */
        const allowed = ['approved', 'paused_budget', 'paused_error', 'running'];
        if (!allowed.includes(t.status)) return send(res, 400, { error: '当前状态不能启动：' + t.status });
        if (running.has(t.id)) return send(res, 400, { error: '任务已在运行' });
        if (body.addBudget) {
          t.budgetYuan += Math.max(0, Math.min(100000, +body.addBudget));
          await db.logOp(user.id, 'budget_add', '任务「' + t.name + '」追加预算 ¥' + (+body.addBudget).toFixed(2), { meta: { taskId: t.id } });
        }
        if (!Array.isArray(t.coveredChunks)) t.coveredChunks = [];
        t.status = 'running';
        t.error = null;
        await Store.saveTask(t);
        running.add(t.id);
        Agent.runTask(t.id).catch(() => { }).finally(() => running.delete(t.id));
        return send(res, 200, { started: true });
      }
      if (tm[2] === 'export') {
        const r = await Agent.exportPack(t.id);
        await db.logOp(user.id, 'export', '导出科目包 ' + r.file + '（' + r.count + ' 题）', { meta: { taskId: t.id, file: r.file } });
        return send(res, 200, r);
      }
    })(req, res);

    /* 人工裁决 / 打回 */
    const dm = p.match(/^\/api\/tasks\/([^/]+)\/(decide|regen)$/);
    if (dm && req.method === 'POST') return requireUser(async (req, res, user) => {
      const own = await Store.loadTask(dm[1]);
      if (!own || own.userId !== user.id) return send(res, 404, { error: '任务不存在' });
      const body = JSON.parse((await readBody(req, 1)).toString('utf8'));
      if (dm[2] === 'decide') {
        const r = await Agent.decide(dm[1], body.qid, body.action, body.edits);
        await db.logOp(user.id, 'review', '审核题目 ' + body.qid + '：' + body.action,
          { revertible: true, meta: { qid: body.qid, taskId: dm[1], action: body.action } });
        return send(res, 200, { task: publicTask(r.task), question: r.question });
      }
      if (running.has(dm[1])) return send(res, 400, { error: '任务运行中，稍后再试' });
      running.add(dm[1]);
      try {
        const t = await Agent.regenQuestion(dm[1], body.qid);
        await db.logOp(user.id, 'regen', '打回重做题目 ' + body.qid, { meta: { qid: body.qid, taskId: dm[1] } });
        return send(res, 200, { task: publicTask(t) });
      } catch (e) {
        const t = await Store.loadTask(dm[1]);
        return send(res, 200, { task: t ? publicTask(t) : null, warning: e.message, needBudget: e.code === 'BUDGET' });
      } finally { running.delete(dm[1]); }
    })(req, res);

    /* ================= 刷题系统 =================
 * 题库来源：该用户所有已采纳的题目（questions 表），制完题立即可刷。
 * 逐题数据：qstate（进度/隐藏/收藏）+ attempts（答题流水）。
 * 列表/筛选/分页都在 SQL 侧完成，不再把整库题目拉进内存。 */

    if (p === '/api/practice/list' && req.method === 'GET') return requireUser(async (req, res, user) => {
      const Q = url.searchParams;
      const scope = Q.get('scope') || 'all';
      const r = await db.practiceList(user.id, {
        ch: Q.get('ch') || '', type: Q.get('type') || '', diff: Q.get('diff') || '',
        taskId: Q.get('taskId') || '', scope,
        limit: Math.min(200, +(Q.get('limit') || 30)), offset: Math.max(0, +(Q.get('offset') || 0))
      });
      return send(res, 200, {
        total: r.total, offset: r.offset, counts: r.counts,
        questions: r.rows.map(practiceQuestion)
      });
    })(req, res);

    if (p === '/api/practice/filters' && req.method === 'GET') return requireUser(async (req, res, user) => {
      return send(res, 200, await db.practiceFilters(user.id));
    })(req, res);

    /* 题目原图（按任务属主校验） */
    if (p === '/api/practice/figure' && req.method === 'GET') return requireUser(async (req, res, user) => {
      const taskId = url.searchParams.get('taskId'), figId = url.searchParams.get('figId');
      const task = await Store.loadTask(taskId);
      if (!task || task.userId !== user.id) return send(res, 404, { error: '图片不存在' });
      const fig = (task.figures || []).find(f => f.id === figId);
      if (!fig || !fs.existsSync(fig.file)) return send(res, 404, { error: '图片不存在' });
      const ext = fig.file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
      res.writeHead(200, Object.assign({}, SECURITY_HEADERS, { 'Content-Type': ext, 'Cache-Control': 'private, max-age=86400' }));
      return res.end(fs.readFileSync(fig.file));
    })(req, res);

    /* 交答案（选择题自动判分；主观题自评） */
    if (p === '/api/practice/answer' && req.method === 'POST') return requireUser(async (req, res, user) => {
      const body = JSON.parse((await readBody(req, 0.2)).toString('utf8'));
      const q = await db.questionById(user.id, body.qid);
      if (!q) return send(res, 404, { error: '题目不存在或不可练习' });
      let correct, grade = null;
      if (typeof body.grade === 'number') {
        grade = Math.max(0, Math.min(1, body.grade));
        correct = grade >= 1;
      } else {
        const given = String(body.answer || '').trim().toUpperCase().slice(0, 2);
        correct = given === String(q.answer || '').toUpperCase();
      }
      await db.recordAttempt(user.id, q.id, correct, body.answer, grade);
      const st = (await db.getMyState(user.id))[q.id] || {};
      return send(res, 200, { correct, answer: q.answer || null, expl: q.expl || null, ref: q.ref || null, mine: st });
    })(req, res);

    if (p === '/api/practice/star' && req.method === 'POST') return requireUser(async (req, res, user) => {
      const body = JSON.parse((await readBody(req, 0.2)).toString('utf8'));
      if (!(await db.questionById(user.id, body.qid))) return send(res, 404, { error: '题目不存在' });
      await db.setStarred(user.id, body.qid, !!body.starred);
      await db.logOp(user.id, 'practice_star', (body.starred ? '收藏' : '取消收藏') + '题目 ' + body.qid,
        { revertible: true, meta: { qid: body.qid, starred: !!body.starred } });
      return send(res, 200, { ok: true, starred: !!body.starred });
    })(req, res);

    if (p === '/api/practice/hide' && req.method === 'POST') return requireUser(async (req, res, user) => {
      const body = JSON.parse((await readBody(req, 0.2)).toString('utf8'));
      if (!(await db.questionById(user.id, body.qid))) return send(res, 404, { error: '题目不存在' });
      await db.setHidden(user.id, body.qid, !!body.hidden);
      await db.logOp(user.id, 'practice_hide', (body.hidden ? '隐藏' : '恢复') + '题目 ' + body.qid + (body.hidden ? '（不再推送，可撤销）' : ''),
        { revertible: true, meta: { qid: body.qid, hidden: !!body.hidden } });
      return send(res, 200, { ok: true });
    })(req, res);

    if (p === '/api/practice/stats' && req.method === 'GET') return requireUser(async (req, res, user) => {
      const stats = await db.practiceStats(user.id);
      const recent = await db.listAttempts(user.id, 60);
      const _f = await db.practiceFilters(user.id);
      const [[bank]] = await db.q(`SELECT COUNT(*) total FROM questions WHERE user_id=? AND status IN ('accepted','auto_accepted')`, [user.id]);
      const [[hid]] = await db.q(`SELECT COUNT(*) n FROM questions q JOIN qstate s ON s.question_id=q.id AND s.user_id=q.user_id
        WHERE q.user_id=? AND q.status IN ('accepted','auto_accepted') AND s.hidden=1`, [user.id]);
      const weak = await db.weakKPs(user.id, 8);
      const [[todo]] = await db.q(`SELECT COUNT(*) n FROM questions q LEFT JOIN qstate s ON s.question_id=q.id AND s.user_id=q.user_id
        WHERE q.user_id=? AND q.status IN ('accepted','auto_accepted') AND COALESCE(s.hidden,0)=0 AND COALESCE(s.attempts,0)=0`, [user.id]);
      return send(res, 200, {
        stats, recent, weak,
        bank: { total: Number(bank.total) || 0, hidden: Number(hid.n) || 0, todo: Number(todo.n) || 0 }
      });
    })(req, res);

    /* AI 讲解：首次生成 / 读取历史（按实际用量计费） */
    if (p === '/api/practice/explain' && req.method === 'POST') return requireUser(async (req, res, user) => {
      if (rateLimit(req, res, 'llm', String(user.id))) return;
      const body = JSON.parse((await readBody(req, 1)).toString('utf8'));
      const q = await db.questionById(user.id, body.qid);
      if (!q) return send(res, 404, { error: '题目不存在' });
      const history = await db.loadChat(user.id, q.id);
      if (history.length && !body.force) return send(res, 200, { messages: history, cached: true });
      const cfg = Store.loadConfig();
      if (!AI.configured(cfg)) return send(res, 400, { error: '请在「API 池」配置出题员(key)后再使用 AI 讲解' });
      const ctx = buildQuestionContext(q);
      const prompt = '请讲解下面这道题：\n\n' + ctx +
        (body.mine && body.mine.last_right === 0 ? '\n\n（学生此前做错过这道题）' : '') +
        '\n\n请输出：1) 这道题考什么知识点；2) 逐步讲解解题过程；3) 常见错误；4) 举一反三留一道变式题（不给答案）。';
      /* 演示模式（测试专用）下一律返回可复现的模拟讲解：
       * 否则测试环境会带着假 Key 真去打上游接口 —— 既慢又不可复现。 */
      if (cfg.mockMode) {
        const msgs = [{ role: 'assistant', content: '【演示模式】这道题考的是「' + q.kp + '」。\n\n1) 考点：' + (Reqs.TYPE_CN[q.type] || q.type) +
          '，围绕「' + q.kp + '」的基本定义与常见陷阱。\n2) 解题过程：先看题干条件，再对照考点定义逐步排除选项/推导结论。\n3) 常见错误：把相近概念混用、忽略边界情形。\n4) 变式题：把题干中的规模条件改掉再想一遍（此处不演示答案）。', ts: Date.now() }];
        await db.saveChat(user.id, q.id, msgs);
        return send(res, 200, { messages: msgs, cached: false, mock: true, cost: 0 });
      }
      try {
        const gp = Store.profileFor(cfg, 'generator');
        const meter = newMeter(+(cfg.explainBudgetYuan || 0.5));
        const out = await AI.chatFull(gp, [
          { role: 'system', content: '你是考研辅导老师，讲解准确、循序渐进，用中文和 markdown。' },
          { role: 'user', content: prompt }
        ], { maxTokens: 2000, meter, pool: providerPool(cfg, 'generator') });
        const msgs = [{ role: 'assistant', content: out.content, ts: Date.now() }];
        await db.saveChat(user.id, q.id, msgs);
        if (meter.spent > 0) {
          await db.billAndDeduct(user.id, {
            kind: 'explain', amount: meter.spent, reason: 'AI 讲解题目 ' + q.id,
            idemKey: 'explain:' + user.id + ':' + q.id
          });
        }
        return send(res, 200, { messages: msgs, cached: false, cost: +meter.spent.toFixed(4) });
      } catch (e) { return send(res, 200, { error: 'AI 讲解失败：' + e.message }); }
    })(req, res);

    /* AI 追问：带完整上下文的连续对话 */
    if (p === '/api/practice/ask' && req.method === 'POST') return requireUser(async (req, res, user) => {
      if (rateLimit(req, res, 'llm', String(user.id))) return;
      const body = JSON.parse((await readBody(req, 1)).toString('utf8'));
      const msg = String(body.message || '').trim();
      if (!msg) return send(res, 400, { error: '请输入问题' });
      if (msg.length > 2000) return send(res, 400, { error: '问题过长（上限 2000 字）' });
      const q = await db.questionById(user.id, body.qid);
      if (!q) return send(res, 404, { error: '题目不存在' });
      const cfg = Store.loadConfig();
      if (!AI.configured(cfg)) return send(res, 400, { error: '未配置模型，无法使用 AI' });
      const history = await db.loadChat(user.id, q.id);
      history.push({ role: 'user', content: msg, ts: Date.now() });
      /* 演示模式同样返回可复现的模拟回答，避免测试环境真打上游接口 */
      if (cfg.mockMode) {
        history.push({ role: 'assistant', content: '【演示模式】针对「' + msg.slice(0, 40) + '」的追问：这道题的关键仍在「' + q.kp + '」，把定义与边界情形对齐即可。', ts: Date.now() });
        await db.saveChat(user.id, q.id, history);
        return send(res, 200, { messages: history, mock: true, cost: 0 });
      }
      try {
        const kept = history.slice(-16);
        const meter = newMeter(+(cfg.explainBudgetYuan || 0.5));
        const out = await AI.chatFull(Store.profileFor(cfg, 'generator'), [
          { role: 'system', content: '你是考研辅导老师，正在与学生就某一道题连续讨论。基于题目与已有讨论直接回答新问题，不要重复已讲过的内容。用中文和 markdown。' },
          { role: 'user', content: buildQuestionContext(q) + '\n\n（以上是题目背景。以下是此前的讨论，请接着回答最后一个问题。）' },
          ...kept.map(m => ({ role: m.role, content: m.content }))
        ], { maxTokens: 2000, meter, pool: providerPool(cfg, 'generator') });
        history.push({ role: 'assistant', content: out.content, ts: Date.now() });
        await db.saveChat(user.id, q.id, history);
        if (meter.spent > 0) {
          await db.billAndDeduct(user.id, { kind: 'explain', amount: meter.spent, reason: 'AI 追问题目 ' + q.id });
        }
        return send(res, 200, { messages: history, cost: +meter.spent.toFixed(4) });
      } catch (e) { return send(res, 200, { error: 'AI 回答失败：' + e.message }); }
    })(req, res);

    if (p === '/api/practice/chat-clear' && req.method === 'POST') return requireUser(async (req, res, user) => {
      const body = JSON.parse((await readBody(req, 0.2)).toString('utf8'));
      await db.clearChat(user.id, body.qid);
      return send(res, 200, { ok: true });
    })(req, res);

    /* ===== 个人中心 ===== */
    if (p === '/api/user/info' && req.method === 'GET') return requireUser(async (req, res, user) => {
      const token = parseCookies(req).qf_sess;
      return send(res, 200, {
        username: user.username, role: user.role, userNo: user.user_no, created_at: user.created_at,
        balance: +(await db.getBalance(user.id)).toFixed(4),
        /* 只返回 scope='user' 的记录：管理员操作不会混进普通用户的个人中心 */
        oplog: await db.listOp(user.id, 60, 'user'),
        bills: await db.listBills(user.id, 40),
        checkin: await db.checkinInfo(user.id),
        revertRequests: await db.listRevertRequests({ userId: user.id }),
        sessions: await db.listSessions(user.id, token)
      });
    })(req, res);
    if (p === '/api/user/recharge' && req.method === 'POST') return requireUser(async (req, res, user) => {
      const body = JSON.parse((await readBody(req, 0.1)).toString('utf8'));
      const amount = +body.amount;
      if (!(amount > 0) || amount > 100) return send(res, 400, { error: '单次充值 0.01 ~ 100 元（模拟充值，未接入支付网关）' });
      await db.recharge(user.id, amount, '模拟充值');
      return send(res, 200, { balance: +(await db.getBalance(user.id)).toFixed(4) });
    })(req, res);
    /* 改密码：校验旧密码，改完踢掉其它设备（当前会话保留） */
    if (p === '/api/user/password' && req.method === 'POST') return requireUser(async (req, res, user) => {
      if (rateLimit(req, res, 'login', 'pwd|' + user.id)) return;
      const body = JSON.parse((await readBody(req, 0.2)).toString('utf8'));
      const oldPwd = String(body.oldPassword || ''), newPwd = String(body.newPassword || '');
      if (db.hashPassword(oldPwd, user.salt) !== user.pwd_hash) return send(res, 401, { error: '原密码不正确' });
      if (newPwd.length < 6) return send(res, 400, { error: '新密码至少 6 位' });
      if (newPwd.length > 128) return send(res, 400, { error: '新密码过长（上限 128 位）' });
      await db.changePassword(user.id, newPwd);
      const token = parseCookies(req).qf_sess;
      const n = await db.revokeSessions(user.id, { keepToken: token });
      await db.logOp(user.id, 'password', '修改密码，并踢下线其它设备 ' + n + ' 个会话', { ...reqMeta(req) });
      return send(res, 200, { ok: true, revoked: n });
    })(req, res);
    if (p === '/api/user/sessions/revoke' && req.method === 'POST') return requireUser(async (req, res, user) => {
      const token = parseCookies(req).qf_sess;
      const n = await db.revokeSessions(user.id, { keepToken: token });
      await db.logOp(user.id, 'session_revoke', '踢下线其它设备 ' + n + ' 个会话', { ...reqMeta(req) });
      return send(res, 200, { ok: true, revoked: n });
    })(req, res);
    /* 用户申请撤回自己的某个操作 */
    if (p === '/api/user/revert-request' && req.method === 'POST') return requireUser(async (req, res, user) => {
      const body = JSON.parse((await readBody(req, 0.5)).toString('utf8'));
      try {
        const id = await db.createRevertRequest(user.id, +body.oplogId, body.reason);
        await db.logOp(user.id, 'revert_apply', '申请撤回操作记录 #' + body.oplogId +
          (body.reason ? '（理由：' + String(body.reason).slice(0, 80) + '）' : ''), { meta: { oplogId: +body.oplogId, requestId: id } });
        return send(res, 200, { ok: true, id });
      } catch (e) { return send(res, 400, { error: e.message }); }
    })(req, res);

    /* ===== 管理员 ===== */
    if (p === '/api/config' && req.method === 'GET') return requireUser(async (req, res, user) => {
      return send(res, 200, publicConfig(Store.loadConfig(), user));
    })(req, res);
    if (p === '/api/config' && req.method === 'POST') return requireAdmin(async (req, res, user) => {
      const cfg = Store.loadConfig();
      const body = JSON.parse((await readBody(req, 1)).toString('utf8'));
      if (body.marginPct != null) cfg.marginPct = Math.max(0, +body.marginPct || 0);
      if (body.visionBudgetYuan != null) cfg.visionBudgetYuan = Math.max(0.1, +body.visionBudgetYuan || 2);
      if (body.kpBudgetYuan != null) cfg.kpBudgetYuan = Math.max(0.01, +body.kpBudgetYuan || 0.2);
      if (body.explainBudgetYuan != null) cfg.explainBudgetYuan = Math.max(0.05, +body.explainBudgetYuan || 0.5);
      if (body.concurrency) {
        const c = cfg.concurrency || {};
        for (const f of ['global', 'perProvider', 'cooldownSec']) {
          if (body.concurrency[f] != null) c[f] = Math.max(1, Math.min(200, +body.concurrency[f] || 1));
        }
        cfg.concurrency = c;
      }
      if (Array.isArray(body.providers)) {
        for (const p of body.providers) {
          const cur = (cfg.providers || []).find(x => x.id === p.id);
          if (!cur) continue;
          if (p.name != null) cur.name = String(p.name).slice(0, 40);
          if (p.baseUrl != null) cur.baseUrl = String(p.baseUrl).trim().slice(0, 200);
          if (p.priceIn != null) cur.priceIn = +p.priceIn || 0;
          if (p.priceOut != null) cur.priceOut = +p.priceOut || 0;
          if (p.note != null) cur.note = String(p.note).slice(0, 200);
          if (typeof p.enabled === 'boolean') cur.enabled = p.enabled;
          if (p.model != null) cur.model = String(p.model).trim().slice(0, 80);
          if (p.apiKey && !p.apiKey.includes('***')) cur.apiKey = String(p.apiKey).trim().slice(0, 200);
        }
      }
      for (const [k, v] of Object.entries(body.profiles || {})) {
        const cur = cfg.profiles[k] || (cfg.profiles[k] = { label: k });
        if (v.model != null) cur.model = String(v.model).trim().slice(0, 80);
        if (v.modelOverride != null) cur.modelOverride = String(v.modelOverride).trim().slice(0, 80);
        if (Array.isArray(v.providerIds)) cur.providerIds = v.providerIds.filter(id => (cfg.providers || []).some(p => p.id === id));
        if (v.maxTokens != null) cur.maxTokens = +v.maxTokens || undefined;
        if (v.lens !== undefined) {
          const L = require('./lib/lenses');
          cur.lens = L.isLens(v.lens) ? v.lens : '';
        }
      }
      Store.saveConfig(cfg);
      configure(cfg);
      await db.logOp(user.id, 'config', '修改平台配置（报价/并发/供应商/岗位）',
        { scope: 'admin', revertible: false, ...reqMeta(req) });
      return send(res, 200, publicConfig(cfg, { role: 'admin' }));
    })(req, res);

    if (p === '/api/providers' && req.method === 'POST') return requireAdmin(async (req, res, user) => {
      const cfg = Store.loadConfig();
      const body = JSON.parse((await readBody(req, 1)).toString('utf8'));
      const list = Array.isArray(body.providers) ? body.providers : [body];
      const added = [];
      for (const p of list) {
        if (!p.baseUrl || !p.name) continue;
        const item = {
          id: 'p_' + crypto.randomBytes(4).toString('hex'),
          name: String(p.name).slice(0, 40), baseUrl: String(p.baseUrl).trim(),
          apiKey: String(p.apiKey || '').trim(),
          model: String(p.model || '').trim(),
          priceIn: +p.priceIn || 0, priceOut: +p.priceOut || 0,
          enabled: p.enabled !== false, note: String(p.note || '').slice(0, 200)
        };
        cfg.providers.push(item);
        added.push({ id: item.id, name: item.name });
      }
      Store.saveConfig(cfg);
      await db.logOp(user.id, 'provider_add', '新增供应商 ' + added.map(a => a.name).join('、'), { scope: 'admin', ...reqMeta(req) });
      return send(res, 200, { ok: true, added, config: publicConfig(cfg, user) });
    })(req, res);

    if (p === '/api/providers/delete' && req.method === 'POST') return requireAdmin(async (req, res, user) => {
      const cfg = Store.loadConfig();
      const { id } = JSON.parse((await readBody(req, 0.2)).toString('utf8'));
      const del = (cfg.providers || []).find(x => x.id === id);
      if (!del) return send(res, 404, { error: '供应商不存在' });
      cfg.providers = cfg.providers.filter(x => x.id !== id);
      const primary = cfg.providers.find(x => x.apiKey);
      for (const prof of Object.values(cfg.profiles)) {
        prof.providerIds = (prof.providerIds || []).filter(pid => pid !== id);
        if (!prof.providerIds.length && primary) prof.providerIds = [primary.id];
      }
      Store.saveConfig(cfg);
      await db.logOp(user.id, 'provider_del', '删除供应商 ' + del.name, { scope: 'admin', ...reqMeta(req) });
      return send(res, 200, { ok: true, config: publicConfig(cfg, user) });
    })(req, res);

    if (p === '/api/providers/import' && req.method === 'POST') return requireAdmin(async (req, res, user) => {
      if (rateLimit(req, res, 'write', String(user.id))) return;
      const cfg = Store.loadConfig();
      const body = JSON.parse((await readBody(req, 2)).toString('utf8'));
      const text = String(body.text || '');
      const bindTo = String(body.bindTo || '');
      const added = [], failed = [];
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const parts = line.split(/\s*[,|\t]\s*/).filter(x => x !== '');
        if (parts.length < 3) { failed.push(line.slice(0, 40) + '（列数不足，需要 名称,BaseURL,Key）'); continue; }
        const [name, baseUrl, apiKey, priceIn, priceOut, model] = parts;
        if (!/^https?:\/\//.test(baseUrl)) { failed.push(name + '（BaseURL 需以 http(s):// 开头）'); continue; }
        const item = {
          id: 'p_' + crypto.randomBytes(4).toString('hex'),
          name: name.slice(0, 40), baseUrl: baseUrl.replace(/\/+$/, ''), apiKey: apiKey,
          model: String(model || '').trim(),
          priceIn: +priceIn || 0, priceOut: +priceOut || 0, enabled: true, note: '批量导入'
        };
        cfg.providers.push(item);
        added.push({ id: item.id, name: item.name });
      }
      if (bindTo && cfg.profiles[bindTo] && added.length) {
        cfg.profiles[bindTo].providerIds = (cfg.profiles[bindTo].providerIds || []).concat(added.map(a => a.id));
      }
      Store.saveConfig(cfg);
      configure(cfg);
      await db.logOp(user.id, 'provider_import', '批量导入供应商 ' + added.length + ' 个' + (bindTo ? '，绑定到 ' + bindTo : ''), { scope: 'admin', ...reqMeta(req) });
      return send(res, 200, { ok: true, added, failed, config: publicConfig(cfg, user) });
    })(req, res);

    if (p === '/api/providers/test' && req.method === 'POST') return requireAdmin(async (req, res, user) => {
      if (rateLimit(req, res, 'llm', String(user.id))) return;
      const cfg = Store.loadConfig();
      configure(cfg);
      const body = JSON.parse((await readBody(req, 1)).toString('utf8') || '{}');
      const targets = body.ids && body.ids.length
        ? (cfg.providers || []).filter(p => body.ids.includes(p.id))
        : (cfg.providers || []);
      const results = [];
      for (const p of targets) {
        if (!p.apiKey) { results.push({ id: p.id, name: p.name, ok: false, error: '未填写 API Key' }); continue; }
        const model = p.model || (Object.values(cfg.profiles).find(prof => (prof.providerIds || []).includes(p.id)) || {}).model || 'deepseek-chat';
        const t0 = Date.now();
        try {
          await callLLM({ role: 'probe', label: p.name, model, baseUrl: p.baseUrl, apiKey: p.apiKey, priceIn: p.priceIn, priceOut: p.priceOut },
            [{ role: 'user', content: '只回复两个字：正常' }], { maxTokens: 50, temperature: 0, pool: [] });
          results.push({ id: p.id, name: p.name, ok: true, ms: Date.now() - t0 });
        } catch (e) {
          results.push({ id: p.id, name: p.name, ok: false, error: e.message.slice(0, 160), ms: Date.now() - t0 });
        }
      }
      clearCooldown();
      await db.logOp(user.id, 'provider_test', '测试供应商 ' + results.length + ' 个，可用 ' + results.filter(r => r.ok).length + ' 个', { scope: 'admin', ...reqMeta(req) });
      return send(res, 200, { ok: true, results });
    })(req, res);

    if (p === '/api/runtime' && req.method === 'GET') return requireAdmin(async (req, res) => {
      const cfg = Store.loadConfig();
      configure(cfg);
      return send(res, 200, Object.assign({ mock: Store.isMock(), version: VERSION, uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000), running: [...running] }, llmStatus(cfg)));
    })(req, res);

    if (p === '/api/runtime/thaw' && req.method === 'POST') return requireAdmin(async (req, res) => {
      const body = JSON.parse((await readBody(req, 0.2)).toString('utf8') || '{}');
      clearCooldown(body.id || null);
      return send(res, 200, { ok: true });
    })(req, res);

    /* ---------- 用户管理（仅管理员） ---------- */
    if (p === '/api/admin/users' && req.method === 'GET') return requireAdmin(async (req, res, user) => {
      const [rows] = await db.q(`SELECT u.id, u.username, u.user_no, u.role, u.balance, u.created_at,
          (SELECT COUNT(*) FROM tasks t WHERE t.user_id=u.id) tasks,
          (SELECT COUNT(*) FROM materials m WHERE m.user_id=u.id AND m.deleted_at IS NULL) materials,
          (SELECT COUNT(*) FROM questions q WHERE q.user_id=u.id AND q.status IN ('accepted','auto_accepted')) questions,
          (SELECT COUNT(*) FROM attempts a WHERE a.user_id=u.id) attempts,
          (SELECT COALESCE(SUM(s.duration_ms),0) FROM sessions s WHERE s.user_id=u.id) online_ms,
          (SELECT MAX(s.last_seen) FROM sessions s WHERE s.user_id=u.id) last_seen,
          (SELECT COALESCE(MAX(c.streak),0) FROM checkins c WHERE c.user_id=u.id) best_streak,
          (SELECT COUNT(*) FROM checkins c WHERE c.user_id=u.id) checkin_days,
          (SELECT COALESCE(SUM(b.amount),0) FROM bills b WHERE b.user_id=u.id AND b.kind='task') spent
        FROM users u ORDER BY u.id`);
      const now = Date.now();
      return send(res, 200, {
        me: { id: user.id, username: user.username, userNo: user.user_no },
        users: rows.map(r => ({
          id: r.id, username: r.username, userNo: r.user_no, role: r.role, balance: +r.balance,
          createdAt: Number(r.created_at), isMe: r.id === user.id,
          tasks: Number(r.tasks), materials: Number(r.materials), questions: Number(r.questions), attempts: Number(r.attempts),
          onlineMs: Number(r.online_ms) || 0,
          lastSeen: r.last_seen ? Number(r.last_seen) : null,
          /* 3 分钟内有过会话活动视为"在线" */
          online: r.last_seen ? (now - Number(r.last_seen) < 3 * 60 * 1000) : false,
          bestStreak: Number(r.best_streak) || 0, checkinDays: Number(r.checkin_days) || 0,
          spent: +(+(r.spent || 0)).toFixed(4)
        }))
      });
    })(req, res);

    if (p === '/api/admin/create-admin' && req.method === 'POST') return requireAdmin(async (req, res, user) => {
      const { username, password } = JSON.parse((await readBody(req, 1)).toString('utf8'));
      if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,20}$/.test(username || '')) return send(res, 400, { error: '用户名需 2-20 位（中文/字母/数字/下划线）' });
      if (!password || String(password).length < 6) return send(res, 400, { error: '密码至少 6 位' });
      if (await db.findUserByName(username)) return send(res, 400, { error: '用户名已存在' });
      const nid = await db.createUser(username, String(password), { role: 'admin' });
      const nu = await db.findUserById(nid);
      await db.logOp(nid, 'grant', '由 ' + user.username + ' 创建为管理员（用户号 ' + nu.user_no + '）', { scope: 'admin' });
      await db.logOp(user.id, 'admin_create', '创建管理员账号 ' + username + '（' + nu.user_no + '）', { scope: 'admin', ...reqMeta(req) });
      return send(res, 200, { ok: true, id: nid, username, userNo: nu.user_no });
    })(req, res);

    if (p === '/api/admin/role' && req.method === 'POST') return requireAdmin(async (req, res, user) => {
      const { userId, role } = JSON.parse((await readBody(req, 0.5)).toString('utf8'));
      if (!['admin', 'user'].includes(role)) return send(res, 400, { error: '角色只能是 admin 或 user' });
      const target = await db.findUserById(+userId);
      if (!target) return send(res, 404, { error: '用户不存在' });
      if (role === 'user') {
        const [cnt] = await db.q("SELECT COUNT(*) c FROM users WHERE role='admin'");
        if (Number(cnt[0].c) <= 1) return send(res, 400, { error: '这是最后一个管理员，不能取消（否则将无人能管理平台）' });
      }
      await db.q('UPDATE users SET role=? WHERE id=?', [role, target.id]);
      /* 用户号是身份标识，不随升降级改变（否则历史操作记录就对不上了） */
      await db.logOp(target.id, 'role', '角色被 ' + user.username + ' 改为 ' + role + '（用户号 ' + target.user_no + ' 保持不变）', { scope: 'admin' });
      await db.logOp(user.id, 'admin_role', '将 ' + target.username + '（' + target.user_no + '）设为 ' + role, { scope: 'admin', ...reqMeta(req) });
      return send(res, 200, { ok: true, note: '用户号不随角色变化，便于历史记录追溯' });
    })(req, res);

    /* ---------- 审计与撤回（管理员） ---------- */
    if (p === '/api/admin/oplogs' && req.method === 'GET') return requireAdmin(async (req, res) => {
      const Q = url.searchParams;
      const r = await db.queryOplogs({
        userNo: Q.get('userNo') || '', action: Q.get('action') || '', scope: Q.get('scope') || '',
        from: Q.get('from') || '', to: Q.get('to') || '', page: Q.get('page') || 1, size: Q.get('size') || 50
      });
      return send(res, 200, {
        total: r.total, page: r.page, size: r.size,
        rows: r.rows.map(o => ({
          id: o.id, userId: o.user_id, userNo: o.user_no || ('#' + o.user_id), username: o.username || '（已删除）',
          role: o.role || '', scope: o.scope, action: o.action, detail: o.detail,
          meta: o.meta_json || null, revertible: !!o.revertible, reverted: !!o.reverted, revertOf: o.revert_of,
          ts: Number(o.ts), canRevert: !!o.revertible && !o.reverted && Revert.isRevertible(o.action)
        })),
        actions: await db.oplogActions()
      });
    })(req, res);

    if (p === '/api/admin/oplogs/export' && req.method === 'GET') return requireAdmin(async (req, res) => {
      const Q = url.searchParams;
      const r = await db.queryOplogs({ userNo: Q.get('userNo') || '', page: 1, size: 200 });
      const head = 'id,时间,用户号,用户名,范围,操作,明细\n';
      const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
      const body = r.rows.map(o => [o.id, new Date(Number(o.ts)).toISOString(), o.user_no, o.username, o.scope, o.action, o.detail].map(esc).join(',')).join('\n');
      return send(res, 200, '\ufeff' + head + body, 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="oplogs.csv"' });
    })(req, res);

    if (p === '/api/admin/revert' && req.method === 'POST') return requireAdmin(async (req, res, user) => {
      const body = JSON.parse((await readBody(req, 0.5)).toString('utf8'));
      const op = await db.getOplog(+body.oplogId);
      if (!op) return send(res, 404, { error: '操作记录不存在' });
      try {
        const r = await Revert.revert(op, { adminId: user.id, note: body.note });
        return send(res, 200, { ok: true, message: r.message, action: r.action });
      } catch (e) { return send(res, 400, { error: e.message }); }
    })(req, res);

    if (p === '/api/admin/revert-requests' && req.method === 'GET') return requireAdmin(async (req, res) => {
      const status = url.searchParams.get('status');
      const rows = await db.listRevertRequests({ status: status || undefined });
      return send(res, 200, {
        pending: await db.countPendingReverts(),
        rows: rows.map(r => ({
          id: r.id, userId: r.user_id, userNo: r.user_no || ('#' + r.user_id), username: r.username || '（已删除）',
          oplogId: r.oplog_id, action: r.action, actionLabel: Revert.labelOf(r.action),
          reason: r.reason, status: r.status, adminNote: r.admin_note,
          createdAt: Number(r.created_at), doneAt: r.done_at ? Number(r.done_at) : null,
          opDetail: r.op_detail, opTs: r.op_ts ? Number(r.op_ts) : null, opMeta: r.op_meta || null, opReverted: !!r.op_reverted,
          enabled: Revert.isRevertible(r.action) && !r.op_reverted
        }))
      });
    })(req, res);

    if (p === '/api/admin/revert-decide' && req.method === 'POST') return requireAdmin(async (req, res, user) => {
      const body = JSON.parse((await readBody(req, 0.5)).toString('utf8'));
      const [rows] = await db.q('SELECT * FROM revert_requests WHERE id=?', [+body.id]);
      const reqRow = rows[0];
      if (!reqRow) return send(res, 404, { error: '申请不存在' });
      if (reqRow.status !== 'pending') return send(res, 400, { error: '该申请已处理过（' + reqRow.status + '）' });
      if (body.approve) {
        const op = await db.getOplog(reqRow.oplog_id);
        if (!op) return send(res, 404, { error: '对应的操作记录不存在' });
        let msg;
        try {
          const r = await Revert.revert(op, { adminId: user.id, note: body.note || reqRow.reason });
          msg = r.message;
        } catch (e) { return send(res, 400, { error: '撤销失败：' + e.message }); }
        await db.decideRevertRequest(reqRow.id, 'approved', user.id, body.note || '');
        await db.logOp(reqRow.user_id, 'revert_done', '撤回申请已通过：' + msg, { scope: 'admin', meta: { requestId: reqRow.id } });
        return send(res, 200, { ok: true, message: msg });
      }
      await db.decideRevertRequest(reqRow.id, 'rejected', user.id, body.note || '');
      await db.logOp(reqRow.user_id, 'revert_reject', '撤回申请被驳回' + (body.note ? '（' + String(body.note).slice(0, 80) + '）' : ''), { scope: 'admin', meta: { requestId: reqRow.id } });
      return send(res, 200, { ok: true, message: '已驳回', reject: true });
    })(req, res);

    if (p === '/api/admin/checkin-board' && req.method === 'GET') return requireAdmin(async (req, res) => {
      return send(res, 200, { board: await db.checkinBoard(30) });
    })(req, res);

    if (p === '/api/test-profile' && req.method === 'POST') return requireAdmin(async (req, res) => {
      if (rateLimit(req, res, 'llm', String(user.id))) return;
      const cfg = Store.loadConfig();
      const key = JSON.parse((await readBody(req, 0.1)).toString('utf8')).key;
      const prof = cfg.profiles[key];
      if (!prof) return send(res, 400, { error: '岗位不存在' });
      if (cfg.mockMode) return send(res, 200, { ok: true });
      try { await callLLM(Store.profileFor(cfg, key), [{ role: 'user', content: '只回复：正常' }], { maxTokens: 100, temperature: 0 }); return send(res, 200, { ok: true }); }
      catch (e) { return send(res, 200, { ok: false, error: e.message }); }
    })(req, res);

    if (p === '/api/memory' && req.method === 'GET') return requireUser(async (req, res, user) => {
      if (user.role !== 'admin') return send(res, 403, { error: '需要管理员权限' });
      return send(res, 200, Store.loadMemory());
    })(req, res);
    if (p === '/api/memory' && req.method === 'POST') return requireAdmin(async (req, res, user) => {
      const body = JSON.parse((await readBody(req, 0.1)).toString('utf8'));
      if (body.op === 'add' && body.text) {
        Store.addMemory({ kind: body.kind || 'note', text: String(body.text).slice(0, 500), kp: body.kp ? String(body.kp).slice(0, 60) : undefined });
        await db.logOp(user.id, 'memory', '新增经验库条目', { scope: 'admin' });
      } else if (body.op === 'delete' && body.id) {
        const mem = Store.loadMemory();
        const i = mem.findIndex(m => m.id === body.id);
        if (i >= 0) mem.splice(i, 1);
        Store.saveMemory(mem.slice(-300));
        await db.logOp(user.id, 'memory', '删除经验库条目 ' + body.id, { scope: 'admin' });
      } else return send(res, 400, { error: '参数错误' });
      return send(res, 200, Store.loadMemory());
    })(req, res);

    if (p === '/api/eval/preflight' && req.method === 'GET') return requireAdmin(async (req, res) => {
      const cfg = Store.loadConfig();
      const roles = Object.keys(cfg.profiles).filter(k => k.startsWith('verifier'));
      const list = roles.map(k => {
        const p = Store.profileFor(cfg, k);
        const lens = p.lens || Store.lensFor(cfg, k);
        return {
          role: k, label: p.label || k, usable: !p.missing && !!p.apiKey,
          provider: p.providerName || null, providerId: p.providerId || null,
          model: p.model || '', modelSource: p.modelSource || '',
          lens: lens ? lens.id : null, lensLabel: lens ? lens.label : '',
          lensDesc: lens ? lens.desc : '',
          candidates: Store.roleBindings(cfg, k)
        };
      });
      const gs = Evals.goldenSource();
      return send(res, 200, {
        verifiers: list,
        usableCount: list.filter(x => x.usable).length,
        golden: gs ? { file: gs.file, count: gs.count } : null,
        goldenCandidates: Evals.goldenCandidates(),
        concurrency: cfg.concurrency
      });
    })(req, res);

    if (p === '/api/eval/run' && req.method === 'POST') return requireAdmin(async (req, res, user) => {
      if (rateLimit(req, res, 'llm', String(user.id))) return;
      const body = JSON.parse((await readBody(req, 0.1)).toString('utf8') || '{}');
      const rep = await Evals.runVerifierEval(body.limit, body.roles);
      await db.logOp(user.id, 'eval', '运行金标集评估（' + rep.goldenCount + ' 题，结论 ' + rep.verdict + '）', { scope: 'admin' });
      return send(res, 200, Object.assign({ md: Evals.evalToMd(rep) }, rep));
    })(req, res);

    return send(res, 404, { error: '未知接口' });
  } catch (e) {
    /* 参数类错误（JSON 解析失败等）回 400，其余回 500，且都带请求号便于追日志 */
    const bad = /JSON|Unexpected|not valid/i.test(e.message);
    log.error('route_error', { reqId: req._reqId, path: p, method: req.method, msg: e.message, stack: (e.stack || '').split('\n')[1] });
    return send(res, bad ? 400 : 500, { error: e.message, reqId: req._reqId });
  }
}
/* 撤回会话时"保留当前会话"：默认保留当前 token，其余设备全部失效 */

/* ---------- 请求入口：请求号、访问日志、CSRF 校验、限流分层 ---------- */
const server = http.createServer((req, res) => {
  const reqId = newReqId();
  req._reqId = reqId;
  req._ip = RL.clientIp(req);
  const t0 = Date.now();
  /* 响应字节数（访问日志用） */
  const origEnd = res.end.bind(res);
  res.end = function (chunk, enc, cb) {
    if (chunk) res._bytes = (res._bytes || 0) + (Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk)));
    return origEnd(chunk, enc, cb);
  };
  res.on('finish', () => {
    access(req, res, { reqId, ms: Date.now() - t0, userNo: req._user ? req._user.user_no : undefined, note: res._note });
  });
  /* CSRF：写操作校验来源 */
  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (unsafe && req.url.startsWith('/api/') && !sameOrigin(req)) {
    res._note = 'csrf_blocked';
    log.warn('csrf_blocked', { reqId, origin: req.headers.origin || req.headers.referer, host: req.headers.host, path: req.url });
    return send(res, 403, { error: '请求来源校验失败（跨站请求已被拒绝）' });
  }
  route(req, res).catch(e => {
    log.error('unhandled', { reqId, msg: e.message });
    try { send(res, 500, { error: e.message }); } catch (_) { /* 响应已发出 */ }
  });
});

/* ---------- 启动 / 停机 ---------- */
let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.warn('shutdown_begin', { signal: sig, runningTasks: [...running] });
  server.close(() => log.info('http_closed'));
  /* 给正在跑的流水线一点时间收尾（它们会在停下时结算费用） */
  const t0 = Date.now();
  while (running.size && Date.now() - t0 < 20000) await new Promise(r => setTimeout(r, 500));
  try { await db.pool.end(); } catch (e) { /* 忽略 */ }
  log.info('shutdown_done', { ms: Date.now() - t0 });
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => log.error('unhandledRejection', { msg: e && e.message, stack: String(e && e.stack || '').split('\n')[1] }));
process.on('uncaughtException', (e) => { log.fatal('uncaughtException', { msg: e && e.message, stack: String(e && e.stack || '').split('\n')[1] }); });

(async () => {
  await db.init();
  const cfg = Store.loadConfig();
  configure(cfg);
  log.configure({ dir: process.env.QF_LOG_DIR === 'off' ? null : Store.dirs.logs });
  /* 进程重启后把"卡在 running"的僵尸任务转为可续跑状态，否则用户界面无法恢复 */
  const orphans = await Agent.recoverOrphans().catch(e => { log.error('recoverOrphans_failed', { msg: e.message }); return 0; });
  const schema = await db.schemaVersion().catch(() => null);
  server.listen(PORT, () => {
    log.info('server_started', {
      port: PORT, version: VERSION, db: db.DB_NAME + '@' + db.DB_HOST,
      mock: Store.isMock(), orphansRecovered: orphans, schema
    });
    console.log('QuestionForge 多用户制题平台已启动: http://localhost:' + PORT);
    console.log('数据库: MySQL ' + db.DB_NAME + '（账号/任务/题目/账单/操作记录全部持久化）');
    console.log('模型调用: ' + (Store.isMock() ? '模拟响应（QF_MOCK=1，仅测试用）' : '真实 API'));
    if (orphans) console.log('已恢复 ' + orphans + ' 个因重启中断的任务（状态改为「异常暂停」，可在任务页续跑）');
  });
})().catch(e => {
  console.error('启动失败（请确认 MySQL 已运行，或通过 QF_DB_* 环境变量指定连接）：', e.message);
  process.exit(1);
});
