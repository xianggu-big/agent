/* 制题需求的结构定义与规范化（解析 / 计价 / 出题三处共用同一套语义）
 *
 * 解决的实际问题：用户的自然语言里常常同时包含"多个知识点 × 多种题型 × 每种几道"，
 * 而旧结构一条需求只能表达"一种题型 × 几道"。于是"这些知识点所有题型都各出一道题"
 * 这种话没地方承载，只能退化成默认的"5 道选择题"。
 *
 * 现在一条需求可以写成：
 *   { types: ['mcq','solution','algo','app'], count: 1, kp: '循环队列', diff: 2, ch: 2 }
 * 含义是：**这个知识点，上述每种题型各出 1 道**（共 4 道）。
 * 于是"12 个知识点 × 4 种题型各 1 道"= 12 条需求 / 48 道题，
 * 需求条数不会爆炸，报价表、进度、断点续跑都能照旧工作。
 *
 * 兼容：老任务里只有 `type`（单题型）的需求照旧按单题型处理。
 */
'use strict';

const TYPES = ['mcq', 'solution', 'algo', 'app'];
const TYPE_CN = { mcq: '单项选择题', solution: '解答题', algo: '算法设计题', app: '综合应用题' };
const TYPE_CN_SHORT = { mcq: '选择', solution: '解答', algo: '算法设计', app: '综合应用' };
/* 各种说法 → 标准题型 */
const TYPE_ALIAS = {
  mcq: 'mcq', solution: 'solution', algo: 'algo', app: 'app',
  '单项选择题': 'mcq', '选择题': 'mcq', '单选': 'mcq', '选择': 'mcq',
  '解答题': 'solution', '解答': 'solution', '简答题': 'solution', '简答': 'solution', '主观题': 'solution',
  '算法设计题': 'algo', '算法设计': 'algo', '算法题': 'algo', '算法': 'algo', '编程题': 'algo', '编程': 'algo', '代码题': 'algo',
  '综合应用题': 'app', '综合应用': 'app', '综合题': 'app', '应用题': 'app', '应用': 'app'
};
function normType(t) {
  if (!t) return null;
  const k = String(t).trim();
  if (TYPE_ALIAS[k]) return TYPE_ALIAS[k];
  const low = k.toLowerCase();
  return TYPES.includes(low) ? low : null;
}
/* 需求包含的题型（去重、保序）；没有 types 时回退到单 type */
function typesOf(req) {
  const raw = (req && Array.isArray(req.types) && req.types.length) ? req.types : [req && req.type];
  const out = [];
  for (const t of raw) { const n = normType(t); if (n && !out.includes(n)) out.push(n); }
  return out.length ? out : ['mcq'];
}
/* 每种题型的题量 */
function perTypeCount(req) { return Math.max(1, Math.min(50, Math.round(+(req && req.count)) || 1)); }
/* 这条需求一共要出多少题 */
function countOf(req) { return perTypeCount(req) * typesOf(req).length; }
/* 全部需求合计 */
function totals(list) {
  const byType = {};
  let total = 0;
  for (const r of (list || [])) {
    const n = perTypeCount(r);
    for (const t of typesOf(r)) { byType[t] = (byType[t] || 0) + n; total += n; }
  }
  return { total, byType };
}
function describeTypes(req) { return typesOf(req).map(t => TYPE_CN_SHORT[t]).join('+'); }

/* 规范化单条需求（补默认值 + 夹取范围）。返回 { req, dropped } */
function normalizeOne(r, { maxCount = 50, maxCh = 20 } = {}) {
  if (!r || typeof r !== 'object') return null;
  const types = typesOf(r);
  const out = {
    types,
    count: Math.max(1, Math.min(maxCount, Math.round(+r.count) || 1)),
    kp: String(r.kp || '').slice(0, 60),
    diff: [1, 2, 3].includes(+r.diff) ? +r.diff : 1,
    ch: Math.max(1, Math.min(maxCh, Math.round(+r.ch) || 1))
  };
  /* 单题型时也保留 type 字段：老代码/老任务/导出报表都还在读它 */
  if (types.length === 1) out.type = types[0];
  return out;
}
/* 规范化整份需求表；maxTotal 为总题量护栏（超出按顺序截断） */
function normalize(list, { maxReqs = 200, maxTotal = 400, maxCount = 50 } = {}) {
  const out = [];
  let total = 0, dropped = 0;
  for (const r of (Array.isArray(list) ? list : [])) {
    const n = normalizeOne(r, { maxCount });
    if (!n) { dropped++; continue; }
    if (out.length >= maxReqs) { dropped++; continue; }
    const c = countOf(n);
    if (total + c > maxTotal) {
      /* 还有余额就削到余额，否则丢弃（宁可少出题，也不要给出一份天价报价又跑不完的任务） */
      const room = maxTotal - total;
      const per = perTypeCount(n);
      const canTypes = Math.floor(room / per);
      if (canTypes >= 1) { n.types = n.types.slice(0, canTypes); if (n.types.length === 1) n.type = n.types[0]; else delete n.type; out.push(n); total += countOf(n); }
      dropped++;
      continue;
    }
    out.push(n); total += c;
  }
  return { list: out, total, dropped };
}

/*
 * 断点续跑用的分段：progress 是"这条需求已生成的题数"，
 * 按题型顺序切成 [0,perType) 属于第 1 种题型、[perType,2*perType) 属于第 2 种……
 * 这样续跑时能确定性地回到"该出哪个题型的第几道"，不会重出也不会漏。
 */
function segmentOf(req, done) {
  const types = typesOf(req);
  const perType = perTypeCount(req);
  const total = perType * types.length;
  const d = Math.max(0, Math.min(total, Math.round(+done) || 0));
  const typeIdx = Math.min(types.length - 1, Math.floor(d / perType));
  return {
    types, perType, total, typeIdx, type: types[typeIdx],
    doneInType: d - typeIdx * perType,
    remainInType: perType - (d - typeIdx * perType),
    phaseLabel: types.length > 1 ? ('第 ' + (typeIdx + 1) + '/' + types.length + ' 种题型（' + TYPE_CN[types[typeIdx]] + '）') : TYPE_CN[types[typeIdx]]
  };
}

/* 覆盖率补题：为缺少题目的知识点各补一条需求（默认每种题型 1 道） */
function forMissingKPs(missing, kps, { count = 1, types = ['mcq'], diff = 2 } = {}) {
  const byName = new Map((kps || []).map(k => [k.name, k]));
  return missing.map(name => {
    const k = byName.get(name) || {};
    return { types: types.slice(), count, kp: name, diff: k.weight >= 4 ? Math.max(2, diff) : diff, ch: k.ch || 1 };
  });
}

module.exports = { TYPES, TYPE_CN, TYPE_CN_SHORT, TYPE_ALIAS, normType, typesOf, countOf, perTypeCount, totals, describeTypes, normalize, normalizeOne, segmentOf, forMissingKPs };
