/* 金标集评估：用 853 已校验真题当考卷，量化"质检员准确率"与"出题流水线质量" */
'use strict';
const fs = require('fs');
const path = require('path');
const Store = require('./store');
const { callLLM, configure } = require('./llm');
const M = require('./mock');
const { extractJSON } = require('./agent');

/* 金标题库加载：按候选路径自动发现（可配置，不再写死某个目录）
 * 优先级：环境变量 QF_GOLDEN → 项目内 data/golden.js → 兄弟目录 853刷题系统 → data/golden.json
 * → 最后回落到仓库内置的**合成夹具** testdata/golden.js。
 * 为什么要夹具：真实金标题库体积大且属第三方资料，不进仓库（data/ 已 gitignore），
 * 但 CI（GitHub Actions）上必须能跑通"评估"这条链路，否则该套件必然红。
 * 本机若存在真实题库，仍然优先生效（candidates 顺序保证）。 */
function goldenCandidates() {
  const list = [];
  if (process.env.QF_GOLDEN) list.push(path.resolve(process.env.QF_GOLDEN));
  list.push(path.join(Store.dirs.root, 'golden.js'));
  list.push(path.join(Store.dirs.root, 'golden.json'));
  list.push(path.join(__dirname, '..', '..', '853刷题系统', 'data', 'questions.js'));
  list.push(path.join(__dirname, '..', 'data', 'golden.js'));
  list.push(path.join(__dirname, '..', 'testdata', 'golden.js'));
  return list;
}
function loadGoldenFrom(file) {
  try {
    if (!fs.existsSync(file)) return null;
    if (file.endsWith('.json')) {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      const arr = Array.isArray(j) ? j : (j.questions || []);
      return arr.filter(q => q.type === 'mcq' && (q.verified || q.answer));
    }
    const src = fs.readFileSync(file, 'utf8');
    const qs = new Function(src + '\n;return typeof QUESTIONS!=="undefined"?QUESTIONS:null;')();
    if (qs && qs.length) return qs.filter(q => q.type === 'mcq' && (q.verified || q.answer));
  } catch (e) { /* 换下一个候选 */ }
  return null;
}
function loadGolden() {
  for (const f of goldenCandidates()) {
    const qs = loadGoldenFrom(f);
    if (qs && qs.length) return qs;
  }
  return [];
}
/* 当前金标题库来源（供页面显示，避免"为什么读的是那个目录"的疑惑） */
function goldenSource() {
  for (const f of goldenCandidates()) {
    const qs = loadGoldenFrom(f);
    if (qs && qs.length) return { file: f, count: qs.length };
  }
  return null;
}

/* 评估一：质检员准确率 —— 各质检模型按各自「视角」独立重解金标选择题，对比官方答案
 *
 * 视角的意义：同一个模型若拿到同一份提示词，会走同一条推理路径、犯同一个错，
 * 分歧信号为 0。按岗位绑定不同视角（概念/演算/反证/边界/教材）后，
 * 同一模型也会在不同环节出错，于是「分歧」能真实暴露"这题不稳"。
 */
async function runVerifierEval(limit, onlyRoles) {
  const cfg = Store.loadConfig();
  configure(cfg);
  const Lenses = require('./lenses');
  const golden = loadGolden().slice(0, limit || 40);
  if (!golden.length) throw new Error('未找到金标题库。请把金标题库放到 data/golden.js（或 data/golden.json），或用环境变量 QF_GOLDEN 指定路径');
  /* 参与互检的岗位：默认全部可用的 verifier*，也可由调用方指定（换供应商/模型后无需改代码） */
  let roleKeys = Object.keys(cfg.profiles).filter(k => k.startsWith('verifier'));
  if (Array.isArray(onlyRoles) && onlyRoles.length) roleKeys = roleKeys.filter(r => onlyRoles.includes(r));
  const verifiers = roleKeys
    .map(k => [k, Store.profileFor(cfg, k)])
    .filter(([k, prof]) => prof && !prof.missing && prof.apiKey);
  /* 一个可用质检员都没有 → 不能"空跑出 100%"。
   * （空集合做全称判断恒为真，会得出"没有质检员 ⇒ 全员答对 ⇒ 100%"这种荒谬结论） */
  if (!verifiers.length) {
    const report = {
      id: Store.id('ev'), ts: Date.now(), mode: 'verifier_accuracy',
      mock: !!cfg.mockMode, goldenCount: golden.length,
      goldenSource: (goldenSource() || {}).file || null,
      usedRoles: [],
      results: {
        perVerifier: {},
        consensus: { total: golden.length, correct: 0, accuracy: 0 },
        unansweredRate: null, diverged: 0, matrix: [],
        failReasons: ['没有任何可用的质检岗位 —— 质检员未绑定供应商，或所绑供应商没有 API Key。请到「API 池」把质检员绑定到有 Key 的供应商。']
      },
      verdict: 'NEED_ATTENTION'
    };
    return Store.saveEval(report);
  }
  const results = { perVerifier: {}, consensus: { total: golden.length, correct: 0 } };
  let unansweredTotal = 0;   // 所有质检员的未答总数（在收集阶段累计）

  for (const [key, prof] of verifiers) {
    const lens = prof.lens || Lenses.get(null, key);
    const r = { label: prof.label || key, model: cfg.mockMode ? 'mock' : prof.model, provider: prof.providerName || '',
                lens: lens.id, lensLabel: lens.label,
                total: golden.length, correct: 0, unanswered: 0, wrongList: [], answeredSet: new Set(), picks: {} };
    for (const g of golden) {
      let ans = '?';
      if (cfg.mockMode) {
        /* mock：按视角制造不同的错题分布，复现"同模型不同视角"的报告形态。
         * 每个视角错在不同的题号集合上，这样分歧矩阵才看得出东西。 */
        const idx = golden.indexOf(g);
        const every = { concept: 7, trace: 5, adversarial: 6, boundary: 4, textbook: 9 }[lens.id] || 7;
        ans = (idx % every === 0) ? ({ A: 'B', B: 'C', C: 'D', D: 'A' }[g.answer] || 'A') : g.answer;
      } else {
        /* 视角 → 独立解题提示：不同视角给不同的解题路径要求 */
        const sys = '你是独立解题者，按下面的视角作答。只输出 JSON：{"answer":"选项字母"}。\n'
          + '【本次视角：' + lens.label + '】' + lens.system;
        const user = lens.solve + '\n\n题目：\n' + g.stem + '\n' +
          g.options.map((o, i) => 'ABCD'[i] + '. ' + o).join('\n') +
          (g.code ? '\n```c\n' + g.code + '\n```' : '');
        try {
          const resp = await callLLM(prof, [{ role: 'system', content: sys }, { role: 'user', content: user }],
            { maxTokens: 200, temperature: lens.temp });
          ans = String(extractJSON(resp.content).answer || '?').toUpperCase()[0];
        } catch (e) { ans = '?'; }
      }
      r.picks[g.id] = ans;
      if (ans === '?') { r.unanswered++; }
      else { r.answeredSet.add(g.id); if (ans === g.answer) r.correct++; else r.wrongList.push(g.id + '→' + ans); }
    }
    r.unansweredRate = +(100 * r.unanswered / r.total).toFixed(1);
    if (!cfg.mockMode) unansweredTotal += r.unanswered;
    r.accuracy = +(100 * r.correct / r.total).toFixed(1);
    results.perVerifier[key] = r;
  }
  /* 共识准确率：所有质检员都【答对】才算对（体现"交叉质检"价值）
   * 关键：未答 ≠ 答对。如果质检员大量未答（调用失败/Key 无效），共识准确率会被虚高，
   * 导致"全挂了却判 PASS"的严重误判 —— 这里显式区分三态：对 / 错 / 未答。 */
  const vkeys = verifiers.map(v => v[0]);
  const matrix = [];      // 视角分歧矩阵：逐题记录每个质检员的选择
  for (const g of golden) {
    const idx = golden.indexOf(g);
    let allRight = true;
    const row = { id: g.id, official: g.answer, picks: {}, agree: true };
    const seen = new Set();
    for (const k of vkeys) {
      const r = results.perVerifier[k];
      if (cfg.mockMode) {
        const every = { concept: 7, trace: 5, adversarial: 6, boundary: 4, textbook: 9 }[r.lens] || 7;
        const ok = idx % every !== 0;
        row.picks[k] = { lens: r.lensLabel, ans: ok ? g.answer : 'X', ok };
        seen.add(row.picks[k].ans);
        if (!ok) allRight = false;
        continue;
      }
      const wrong = r.wrongList.some(w => w.startsWith(g.id + '→'));
      const answered = r.answeredSet ? r.answeredSet.has(g.id) : (r.correct + r.wrongList.length) > 0;
      const ans = (r.picks && r.picks[g.id]) || '?';
      row.picks[k] = { lens: r.lensLabel, ans, ok: answered && !wrong };
      seen.add(ans);
      if (!answered || wrong) { allRight = false; }   // 未答或答错 → 共识不通过
    }
    /* agree=false 表示质检员之间给出了不同答案（真正的"视角分歧"）。
     * 这里不再 break，要统计全部投票，才能算出分歧清单。 */
    row.agree = seen.size <= 1;
    if (!row.agree) matrix.push(row);
    if (allRight) results.consensus.correct++;
  }
  results.matrix = matrix;
  results.diverged = matrix.length;
  /* 未答率守门：任何一个质检员未答率超过 20%，直接判 FAIL 并说明原因，
   * 防止"调用全挂了但共识 100%"这种荒谬结论。 */
  const denom = golden.length * vkeys.length;
  const unansweredRate = denom ? +(100 * unansweredTotal / denom).toFixed(1) : 0;
  results.unansweredRate = unansweredRate;
  results.consensus.answeredCount = golden.length * vkeys.length - unansweredTotal;
  const failReasons = [];
  for (const k of vkeys) {
    const r = results.perVerifier[k];
    if (r.unansweredRate > 20) failReasons.push(r.label + '（' + r.model + '·' + r.lensLabel + '）未答 ' + r.unanswered + '/' + r.total + ' 道（' + r.unansweredRate + '%）—— 请到「API 池」检查该供应商的 Key 与模型名');
  }
  if (results.consensus.accuracy < 85) failReasons.push('共识准确率 ' + results.consensus.accuracy + '% 低于 85% 阈值');
  results.failReasons = failReasons;
  results.consensus.accuracy = +(100 * results.consensus.correct / golden.length).toFixed(1);

  const report = {
    id: Store.id('ev'), ts: Date.now(), mode: 'verifier_accuracy',
    mock: !!cfg.mockMode, goldenCount: golden.length,
    goldenSource: (goldenSource() || {}).file || null,
    usedRoles: verifiers.map(([k, p]) => ({
      role: k, label: p.label, provider: p.providerName, model: p.model,
      lens: p.lens ? p.lens.id : null, lensLabel: p.lens ? p.lens.label : ''
    })),
    results,
    verdict: (results.consensus.accuracy >= 85 && results.unansweredRate <= 20 && !results.failReasons.length) ? 'PASS' : 'NEED_ATTENTION'
  };
  return Store.saveEval(report);
}

/* 评估报告 → markdown 展示 */
function evalToMd(rep) {
  const t = new Date(rep.ts).toLocaleString('zh-CN');
  const lines = ['# 金标集评估报告 · ' + (rep.mock ? '（⚠ 演示模式数据，非真实指标）' : ''), '生成时间：' + t, ''];
  if (rep.mode === 'verifier_accuracy') {
    lines.push('## 质检员准确率（金标：' + rep.goldenCount + ' 道已校验真题选择题）', '',
      '| 质检员 | 视角 | 模型 | 正确 | 未答 | 准确率 |', '|---|---|---|---|---|---|');
    for (const [k, r] of Object.entries(rep.results.perVerifier)) {
      lines.push('| ' + k + ' | ' + (r.lensLabel || '-') + ' | ' + r.model + ' | ' + r.correct + '/' + r.total +
        ' | ' + r.unanswered + ' | **' + r.accuracy + '%** |');
    }
    lines.push('', '共识（全员答对才通过；未答视同不通过）准确率：**' + rep.results.consensus.accuracy + '%**');
    if (rep.results.unansweredRate != null) {
      lines.push('整体未答率：' + rep.results.unansweredRate + '%' +
        (rep.results.unansweredRate > 20 ? '（⚠️ 超过 20% 守门线）' : ''));
    }
    if (rep.results.diverged != null) {
      lines.push('视角分歧题数：' + rep.results.diverged + ' / ' + rep.goldenCount +
        '（分歧题 = 质检员给出了不同答案，正是需要人工重点复核的题）');
    }
    /* 分歧清单：这是"换视角"真正的产出 —— 指出哪些题不稳、各自选了啥 */
    const mx = rep.results.matrix || [];
    if (mx.length) {
      const keys = Object.keys(mx[0].picks);
      const head = Object.keys(mx[0].picks).map(k => {
        const u = (rep.usedRoles || []).find(x => x.role === k);
        return k + (u && u.lensLabel ? '(' + u.lensLabel + ')' : '');
      });
      lines.push('', '### 视点分歧清单（前 20 题）', '',
        '| 题号 | 官方 | ' + head.join(' | ') + ' |', '|---|' + '|---|'.repeat(keys.length + 1));
      for (const row of mx.slice(0, 20)) {
        const cells = keys.map(k => {
          const p = row.picks[k] || {};
          return p.ok ? '✅' + p.ans : (p.ans === '?' ? '⚠️未答' : '❌' + p.ans);
        });
        lines.push('| ' + row.id + ' | ' + row.official + ' | ' + cells.join(' | ') + ' |');
      }
    }
    if (rep.failReasons && rep.failReasons.length) {
      lines.push('', '**不达标原因：**', ...rep.failReasons.map(x => '- ' + x));
    }
    lines.push('', '结论：' + (rep.verdict === 'PASS' ? '✅ 达标（共识 ≥85% 且未答率 ≤20%）' : '❌ 未达标，上方已列出原因'));
    /* 视角多样性提示：让用户明白"同模型换视角"到底解决了什么、没解决什么 */
    const lensSet = new Set(Object.values(rep.results.perVerifier).map(r => r.lensLabel).filter(Boolean));
    const provSet = new Set(Object.values(rep.results.perVerifier).map(r => r.provider).filter(Boolean));
    lines.push('', '### 视角/供应商多样性', '',
      '- 参与视角：' + ([...lensSet].join('、') || '-') + '（' + lensSet.size + ' 种）',
      '- 参与供应商：' + ([...provSet].join('、') || '-') + '（' + provSet.size + ' 家）');
    if (lensSet.size < Object.keys(rep.results.perVerifier).length) {
      lines.push('- ⚠️ 有质检员用了相同视角，交叉质检的去相关效果会被削弱：建议在「API 池」给每个质检员换不同视角。');
    }
    if (provSet.size === 1 && Object.keys(rep.results.perVerifier).length > 1) {
      lines.push('- ⚠️ 全部质检员来自同一家供应商：换视角能减少共同盲区，但消不掉模型自身的系统性偏差，条件允许时建议混一家异构供应商。');
    }
  }
  return lines.join('\n');
}

module.exports = { runVerifierEval, evalToMd, loadGolden, goldenSource, goldenCandidates };
