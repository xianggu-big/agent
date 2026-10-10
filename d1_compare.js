/* D1 对照实验：有 / 无 run_code 两组（真实 API）
 *
 * 要回答的问题：给质检员一个"在断网沙箱里真跑代码"的工具，能不能把推理题的准确率拉上去？
 * 值不值这个钱？（这是 ① 里 R3 三组对照的 D1 版）
 *
 * 题集：testdata/golden_reason.js（14 道"读程序判断输出"题）——
 * 正确答案是真编译真运行冻结的，干扰项是模型上次真实答错的原话（所以题目对它有区分度）。
 *
 * 两组都开 QF_TOOLS=1（calc）+ 提示词要求必须调用工具，唯一差别是 QF_TOOLS_RUN：
 *   A 组 = 只有 calc（数值表达式）→ 这 14 道题它帮不上忙，模型只能心算
 *   B 组 = 再加 run_code（能把题面里那段 C 程序原样跑一遍）
 * 这样两组之差就是"run_code 的净效果"，不会被"提示词要求认真算"混进来。
 *
 * 用法：node d1_compare.js        （会调用真实 API，产生少量费用；先看打印的预估）
 */
'use strict';
const fs = require('fs');
const path = require('path');
process.env.QF_GOLDEN = process.env.QF_GOLDEN || path.join(__dirname, 'testdata', 'golden_reason.js');
process.env.QF_TOOLS = '1';
const E = require('./lib/evals');
const Tools = require('./lib/tools');

const N = +(process.env.D1_LIMIT || 14);

(async () => {
  /* 先探一次沙箱：B 组要它可用才真的会启用 run_code（不可用会降级成 A 组，那样对比就没意义了）。
   * 注意探活时两个开关都要开着，否则 planRunCode 会在"开关"这一层就返回 disabled。 */
  process.env.QF_TOOLS_RUN = '1';
  const plan = await Tools.planRunCode({ type: 'mcq', stem: '输出是什么？' }, { refresh: true });
  console.log('沙箱状态：' + (plan.use ? '可用 ✓（B 组会真的启用 run_code）' : '⚠ 不可用（' + plan.reason + '） → ' + (plan.detail || '') + '　B 组会退化成 A 组，先别看结论'));
  if (!plan.use) process.exit(1);

  const out = {};
  for (const arm of (process.env.D1_ARMS || 'A:calc,B:calc+run_code').split(',')) {
    if (arm.startsWith('B')) process.env.QF_TOOLS_RUN = '1'; else delete process.env.QF_TOOLS_RUN;
    if (arm.includes('长额度')) process.env.QF_EVAL_TOK = '1600'; else delete process.env.QF_EVAL_TOK;
    const t0 = Date.now();
    const rep = await E.runVerifierEval(N, null, { mode: 'tools' });
    const usage = Object.values(rep.results.toolUsage);
    out[arm] = {
      consensus: rep.results.consensus.accuracy,
      perVerifier: {},
      toolTotal: rep.results.toolTotal,
      cost: +usage.reduce((a, x) => a + (x.cost || 0), 0).toFixed(4),
      calls: usage.reduce((a, x) => a + (x.llmCalls || 0), 0),
      wallMs: Date.now() - t0
    };
    for (const [k, v] of Object.entries(rep.results.perVerifier)) {
      out[arm].perVerifier[k] = { accuracy: v.accuracy, correct: v.correct, total: v.total, wrongList: v.wrongList };
    }
    console.log('[' + arm + '] 共识=' + out[arm].consensus + '%  ' +
      Object.entries(out[arm].perVerifier).map(([k, v]) => k + '=' + v.accuracy + '%').join(' ') +
      '  工具调用=' + rep.results.toolTotal.calls + '  漏调=' + rep.results.toolTotal.missed +
      '  成本=¥' + out[arm].cost + '  调用=' + out[arm].calls + '  墙钟=' + (out[arm].wallMs / 1000).toFixed(1) + 's');
  }
  /* 小结只在两臂都跑过时才打印（单臂运行 D1_ARMS=... 时跳过） */
  const a = out['A:calc'], b = out['B:calc+run_code'];
  if (a && b) {
  console.log('\n── 结论 ──');
  console.log('共识准确率：' + a.consensus + '% → ' + b.consensus + '%（' + (b.consensus - a.consensus >= 0 ? '+' : '') + (b.consensus - a.consensus).toFixed(1) + ' 个百分点）');
  console.log('成本：¥' + a.cost + ' → ¥' + b.cost + '（×' + (a.cost ? (b.cost / a.cost).toFixed(2) : '?') + '）');
  }
  const file = path.join(__dirname, 'data', 'd1_compare.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let prev = {}; try { prev = JSON.parse(fs.readFileSync(file, 'utf8')).arms || {}; } catch (e2) { /* 首次跑没有旧文件 */ }
  fs.writeFileSync(file, JSON.stringify({ ts: Date.now(), questions: N, arms: Object.assign(prev, out) }, null, 2), 'utf8');
  console.log('\n完整结果已写入 data/d1_compare.json');
})().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
