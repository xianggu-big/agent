/* 成本预估与报价：接单前先算 token 与费用，生成可直接发给客户的报价单 */
'use strict';
const Reqs = require('./reqs');

/* 中文文本 token 估算经验系数（宁高勿低，报价按上限） */
const ZH_CHARS_PER_TOKEN = 1.4;

function estimateTokens(chars) { return Math.ceil(chars / ZH_CHARS_PER_TOKEN); }

/* 各环节单题 token 经验值（输入/输出） */
const PER_Q = {
  mcq:       { genIn: 700,  genOut: 420,  verIn: 480, verOut: 220 },
  solution:  { genIn: 700,  genOut: 800,  verIn: 520, verOut: 500 },
  algo:      { genIn: 750,  genOut: 950,  verIn: 600, verOut: 650 },
  app:       { genIn: 750,  genOut: 950,  verIn: 600, verOut: 650 }
};
/* 出题时每批注入的资料片段预算（字符）—— 与 agent.js 的 CONTEXT_BUDGET / FIG_BUDGET 保持一致。
 * 资料现在按块检索注入（不再是"整份资料重复注入"），所以报价按这个真实预算算，
 * 既不会给客户虚报，也不会低估。 */
const CTX_CHARS = +process.env.QF_CONTEXT_BUDGET || 8000;
const FIG_CHARS = +process.env.QF_FIG_BUDGET || 4000;

/*
 * 估算一次制题任务的成本
 * opts: { materialChars, requirements: [{type, count}], verifierCount, profiles, retryFactor, figureCount }
 * 返回逐岗位明细 + 总成本（元）
 */
function estimateCost(opts) {
  const { materialChars, requirements, verifierCount = 2, profiles, retryFactor = 1.25, figureCount = 0 } = opts;
  const matTokens = estimateTokens(materialChars);
  /* 一条需求可能声明多种题型（types），题量按"题型数 × 每题型数量"算 */
  const totalQ = Reqs.totals(requirements).total;
  const lines = []; // {role, profile, tokensIn, tokensOut, cost, note}

  const push = (role, prof, tin, tout, note) => {
    const cost = (tin * (prof.priceIn || 0) + tout * (prof.priceOut || 0)) / 1e6;
    lines.push({ role, profile: prof.model, tokensIn: Math.ceil(tin), tokensOut: Math.ceil(tout), cost, note: note || '' });
  };

  /* 识图（可选）：客户资料含图形时，每张图一次视觉模型调用 */
  if (figureCount > 0 && profiles.vision) {
    push('识图(图形→文字)', profiles.vision, figureCount * 900, figureCount * 450, figureCount + ' 张图，各一次视觉调用');
  }

  /* 出题：资料按块检索注入，每批注入的是"与该考点最相关的片段"（有上限），
   * 因此按每批的固定预算估算，而不是把整份资料乘批次数（那样会严重高估）。 */
  const batches = Math.max(1, Math.ceil(totalQ / 8));
  let genIn = 0, genOut = 0;
  for (const r of requirements) {
    for (const t of Reqs.typesOf(r)) {
      const p = PER_Q[t] || PER_Q.mcq;
      genIn += Reqs.perTypeCount(r) * p.genIn; genOut += Reqs.perTypeCount(r) * p.genOut;
    }
  }
  const perBatchCtx = Math.ceil((CTX_CHARS + (figureCount ? FIG_CHARS : 0)) / 1.4);
  genIn += batches * (perBatchCtx + 600);
  push('出题', profiles.generator, genIn, genOut,
    '资料按考点检索注入 ' + batches + ' 批，每批约 ' + (CTX_CHARS + (figureCount ? FIG_CHARS : 0)) + ' 字');

  /* 难度标注：一次批量调用 */
  push('难度标注', profiles.classifier || profiles.generator, totalQ * 260 + 400, totalQ * 50, totalQ + ' 题批量标注');

  /* 交叉质检：每题 × 每家质检员独立重解 */
  for (let i = 1; i <= verifierCount; i++) {
    const prof = profiles['verifier' + i];
    if (!prof) continue;
    let vin = 0, vout = 0;
    for (const r of requirements) {
      for (const t of Reqs.typesOf(r)) {
        const p = PER_Q[t] || PER_Q.mcq;
        vin += Reqs.perTypeCount(r) * p.verIn; vout += Reqs.perTypeCount(r) * p.verOut;
      }
    }
    push('交叉质检' + i, prof, vin, vout, '独立重解全部题目');
  }

  const subtotal = lines.reduce((a, l) => a + l.cost, 0);
  const total = subtotal * retryFactor;
  return { lines, tokensIn: lines.reduce((a, l) => a + l.tokensIn, 0), tokensOut: lines.reduce((a, l) => a + l.tokensOut, 0), subtotal, retryFactor, total, totalQ };
}

/* 题量描述：按题型汇总（"选择 24 + 解答 12"），多知识点多题型时也不会变成一长串 */
function quoteTypeLine(requirements) {
  const by = Reqs.totals(requirements).byType;
  const names = { mcq: '选择', solution: '解答', algo: '算法设计', app: '综合应用' };
  return Reqs.TYPES.filter(t => by[t]).map(t => names[t] + ' ' + by[t]).join(' + ') || '0';
}

/* 生成报价单（markdown，可直接复制发客户） */
function quoteText(task, est, cfg) {
  const margin = cfg.marginPct || 0;
  const price = est.total * (1 + margin / 100);
  const totalQ = est.totalQ || task.requirements.reduce((a, r) => a + r.count, 0);
  const humanMins = Math.round(totalQ * (cfg.conflictHumanRateAssume || 0.15) * 1.5);
  /* 兼容两种任务形态：原始任务（material.rawChars）与对外裁剪后（material.chars） */
  const chars = (task.material && (task.material.rawChars || task.material.chars)) || task.materialChars || 0;
  const fmt = n => '¥' + n.toFixed(n < 1 ? 3 : 2);
  return [
    '【制题服务报价单】',
    '任务：' + task.name,
    '题量：' + totalQ + ' 题（' + quoteTypeLine(task.requirements) + '）',
    '资料规模：约 ' + chars + ' 字',
    '',
    '一、AI 生产成本明细（自动估算，含 ' + Math.round((est.retryFactor - 1) * 100) + '% 重试余量）',
    ...est.lines.map(l => '· ' + l.role + '（' + l.profile + '）：入 ' + l.tokensIn + ' + 出 ' + l.tokensOut + ' tok ≈ ' + fmt(l.cost)),
    '小计 ' + fmt(est.subtotal) + ' × 重试系数 = ' + fmt(est.total),
    '',
    '二、人工质检与审核：约 ' + humanMins + ' 分钟（按经验冲突率估算）',
    ...(task.constraints && task.constraints.length ? ['', '客户的额外要求（出题时逐条满足）：', ...task.constraints.map(c => '· ' + c)] : []),
    '',
    '三、报价：' + fmt(price) + '（成本加成 ' + margin + '%，含勘误更新）',
    '预计交付：资料齐后 1~3 个工作日',
    '',
    '—— 由 QuestionForge 制题 Agent 控制台生成于 ' + new Date().toLocaleString('zh-CN')
  ].join('\n');
}

module.exports = { estimateCost, quoteText, estimateTokens };
