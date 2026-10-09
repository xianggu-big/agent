/* R6：三组对照实验（真实 API）
 *   off    = 无工具无提示
 *   prompt = 有提示无工具（要求写出计算步骤）
 *   tools  = 有工具 + 规定必须调用
 * 用计算类金标夹具（testdata/golden_calc.js，10 道必须算一遍的题），
 * 目的是把"收益来自工具"和"收益来自提示词"分开。
 * 用法：node r6_compare.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('./lib/evals');

(async () => {
  const out = {};
  for (const mode of ['off', 'prompt', 'tools']) {
    const t0 = Date.now();
    const rep = await E.runVerifierEval(10, null, { mode });
    const per = {};
    for (const [k, v] of Object.entries(rep.results.toolUsage)) per[k] = v;
    out[mode] = {
      consensus: rep.results.consensus.accuracy,
      unansweredRate: rep.results.unansweredRate,
      diverged: rep.results.diverged,
      toolTotal: rep.results.toolTotal,
      perVerifier: per,
      wallMs: Date.now() - t0
    };
    console.log('[' + mode + '] 共识=' + out[mode].consensus + '%  未答率=' + out[mode].unansweredRate +
      '%  工具调用=' + rep.results.toolTotal.calls + '  漏调=' + rep.results.toolTotal.missed +
      '  工具报错=' + rep.results.toolTotal.errors +
      '  成本=¥' + Object.values(per).reduce((a, x) => a + (x.cost || 0), 0).toFixed(4) +
      '  墙钟=' + (out[mode].wallMs / 1000).toFixed(1) + 's');
  }
  const file = path.join(__dirname, 'data', 'tools_compare.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');
  console.log('\n结果已写入 data/tools_compare.json');
})().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
