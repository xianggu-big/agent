/* 模型评测框架 · 命令行（② 阶段 1）
 *
 * 用法：
 *   node evalsuite_run.js --list                      列出已装题库集
 *   node evalsuite_run.js --suite calgo --models verifier1,verifier2
 *   node evalsuite_run.js --suite calgo --limit 3     只跑前 3 题（试链路）
 *   node evalsuite_run.js --suite calgo --items h01,h03  只重跑指定题（省钱：不必全量重跑）
 *   node evalsuite_run.js --suite calgo --repeats 3   每题问三遍，测方差
 *   node evalsuite_run.js --suite calgo --real        真实调用（会花钱，先打印预估）
 *   node evalsuite_run.js --suite calgo --runner gcc  模拟模型 + 真编译器（不花钱也能验 gcc 链路）
 *   node evalsuite_run.js --suite calgo --limit 3 --sandbox   用 Docker 沙箱跑模型代码（断网/只读/限额）
 *   node evalsuite_run.js --suite calgo --models generator --real --no-system   与无系统提示词的旧实验对比
 *
 * 真实跑过的结果**一律落盘**到 data/evals/suites/（花了钱的数据不能只留在终端上）。
 * --sandbox 要了沙箱却没要到（没装/没启动/没镜像）时**降级到本机运行，并在报告里写明"无沙箱"**。
 *
 * ⚠ 不加 --real 就是模拟模式：不发任何真实请求、不产生费用，只验证链路。
 *   这是实施方案里"花钱失控"那条风险的兜底（另一条兜底是 evalsuite_test.js 的网络哨兵断言）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Store = require('./lib/store');
const ES = require('./lib/evalsuite');

const args = process.argv.slice(2);
const has = f => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

(async () => {
  if (has('--list') || args.length === 0) {
    console.log('已装题库集：');
    for (const d of ES.SUITE_DIRS) console.log('  来源目录：' + d);
    for (const s of ES.listSuites()) {
      console.log('  ' + (s.id + '            ').slice(0, 14) + (s.items + ' 题').padEnd(8)
        + '判分 ' + (s.judge || '-').padEnd(11) + (s.title || '') + (s.local ? '  [本地]' : '') + (s.error ? '  ✗ ' + s.error : ''));
    }
    console.log('\n用法：node evalsuite_run.js --suite <id> --models <岗位1,岗位2> [--limit N] [--items 题号,题号] [--repeats N] [--real] [--runner gcc|stub|docker] [--sandbox] [--no-system] [--save]');
    console.log('说明：不加 --real 为模拟模式（不发真实请求）；--models 填岗位 key（如 generator/verifier1）；');
    console.log('      --runner gcc 用模拟模型 + 真编译器（不花钱也能验证 exec 判分链路）。');
    console.log('      --no-system 关掉框架自带的系统提示词（用于和没有系统提示词的旧实验对照）。');
    return;
  }

  const suiteId = val('--suite', 'calgo');
  const models = val('--models', 'generator,verifier1').split(',').map(s => s.trim()).filter(Boolean);
  const repeats = +val('--repeats', '1');
  const limit = val('--limit', null) ? +val('--limit') : null;
  const items = val('--items', null) ? val('--items').split(',').map(s => s.trim()).filter(Boolean) : null;
  const real = has('--real');

  if (real) {
    /* 真跑之前先把账算给你看（实施方案承诺："真跑要显式 --real 并打印预估费用"） */
    const cfg = Store.loadConfig();
    const suite = ES.loadSuite(suiteId);
    const items = limit ? suite.items.slice(0, limit) : suite.items;
    const est = ES.estimateCost(suite, items, models, repeats, cfg);
    console.log('预估费用（按实测 token 量级校准过的粗估）：');
    for (const r of est.rows) console.log('  ' + r.role.padEnd(12) + (r.provider + ' / ' + r.model).padEnd(34)
      + '每约 ' + r.tokenIn + '→' + r.tokenOut + ' token   ¥' + r.total.toFixed(4));
    console.log('  合计：' + est.calls + ' 次调用，约 ¥' + est.total.toFixed(4));
    console.log('');
  } else {
    console.log('⚠ 模拟模式：不发真实请求、不产生费用（只验证链路）。要真实调用请加 --real。\n');
  }

  const t0 = Date.now();
  let done = 0;
  const total = (limit || ES.loadSuite(suiteId).items.length) * repeats * models.length;
  const rep = await ES.runSuite({
    suiteId, models, repeats, limit, items, real,
    runner: val('--runner', null) || undefined,
    /* --no-system：关掉框架自带的系统提示词。
     * 为什么需要它：框架默认会说一句"你是一名严谨的解题者"，而当年 llm_test 没有这句 ——
     * 想和旧实验的数字对比，就必须能把这一项关掉做对照。 */
    system: has('--no-system') ? '' : undefined,
    /* --sandbox：要求用 Docker 沙箱跑模型代码（断网/只读/内存与进程限额）。
     * 没装/没启动/没镜像时会**降级到本机并在报告里写明**，不会假装沙箱。 */
    sandbox: has('--sandbox') ? true : undefined,
    onProgress: p => { done++; if (done % 5 === 0 || done === total) process.stdout.write('  进度 ' + done + '/' + total + '\r'); }
  });
  process.stdout.write(' '.repeat(30) + '\r');

  console.log(rep.md);
  console.log('\n（耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's）');

  /* 真实跑过的数据**一律落盘**：花了钱的结果只留在终端上，等于白花
   * （第一次真实跑就吃了这个亏 —— 26 题 ¥0.0609 的逐题明细没存下来）。
   * 模拟跑默认不落盘，加 --save 才存（免得一堆演示数据淹掉历史）。
   * 存到 data/evals/suites/ 子目录：金标集评估页读的是 data/evals 根目录的 *.json，
   * 放子目录里不会污染那页的「历史报告」列表（阶段 3 接页面时再统一）。 */
  const save = has('--save') || real;
  if (save) {
    const dir = path.join(Store.dirs.evals, 'suites');
    fs.mkdirSync(dir, { recursive: true });
    const json = path.join(dir, rep.id + '.json');
    const md = path.join(dir, rep.id + '.md');
    fs.writeFileSync(json, JSON.stringify(rep, null, 2));
    fs.writeFileSync(md, rep.md);
    console.log('\n已保存（含逐题明细）：' + json + '\n                      ' + md);
  }
})().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
