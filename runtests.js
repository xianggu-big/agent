/* 统一测试入口：起一个独立的模拟服务（不碰你正在用的服务），跑完全部测试后自动关闭
 *
 * 为什么这样设计：产品运行时永远是真实 API 模式；测试需要的"模拟响应"只通过
 * 启动环境变量 QF_MOCK=1 开启，并跑在独立端口上，避免污染正在使用的数据与配置。
 *
 * 用法：node runtests.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const PORT = process.env.QF_TEST_PORT || 8541;
const BASE = 'http://localhost:' + PORT;
const ROOT = __dirname;
/* 测试库与生产库分开：旧版本只隔离了文件目录、数据库仍是同一个（靠前缀 + cleandata.js 事后清理），
 * 现在测试写的是 questionforge_test，生产的 users/tasks/questions 完全不受影响。 */
const TEST_DB = process.env.QF_TEST_DB || 'questionforge_test';
/* 测试需要连续注册多个账号，因此关掉接口限流（只作用于测试进程，与 QF_MOCK 同一套约定） */
const TEST_ENV = { QF_MOCK: '1', QF_DB_NAME: TEST_DB, QF_RATELIMIT: 'off', QF_LOG_LEVEL: 'warn' };

const results = [];
function log(s) { process.stdout.write(s + '\n'); }

function waitForServer(timeoutMs) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const probe = () => {
      const req = http.get(BASE + '/api/me', res => { res.resume(); resolve(); });
      req.on('error', () => {
        if (Date.now() - t0 > timeoutMs) return reject(new Error('测试服务启动超时'));
        setTimeout(probe, 300);
      });
    };
    probe();
  });
}

function run(cmd, args, env) {
  return new Promise(resolve => {
    const t0 = Date.now();
    /* Node 自身路径可能含空格，绝不能用 shell 拼接；python 在 Windows 上需要 shell 解析 */
    const useShell = process.platform === 'win32' && cmd === 'python';
    const p = spawn(cmd, args, { cwd: ROOT, env: Object.assign({}, process.env, env || {}), shell: useShell });
    let out = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => out += d);
    p.on('close', code => resolve({ code, out, ms: Date.now() - t0 }));
  });
}

async function runStep(label, cmd, args, env) {
  log('\n' + '━'.repeat(64));
  log('▶ ' + label);
  log('━'.repeat(64));
  const r = await run(cmd, args, env);
  // 只回显结果摘要与失败细节，避免刷屏
  const lines = r.out.split(/\r?\n/);
  const summary = lines.filter(l => /通过 \d+ 项|全部接口已接通|所有页面均从后端|^通过|FAIL|✗|未接通/.test(l));
  log(summary.length ? summary.join('\n') : lines.slice(-6).join('\n'));
  results.push({ label, ok: r.code === 0, ms: r.ms, code: r.code });
  return r.code === 0;
}

(async () => {
  log('QuestionForge 测试套件');
  log('测试服务端口: ' + PORT + '（独立于生产服务，模拟响应模式）');

  /* 1. 静态检查（不需要服务） */
  if (!await runStep('接口连通性检查（前后端路由对齐）', process.execPath, ['apicheck.js'])) { /* 继续跑其余项 */ }
  if (!await runStep('视图取数审计（页面必须从数据库取数）', process.execPath, ['viewaudit.js'])) { /* 继续 */ }

  /* 2. 启动独立测试服务 */
  log('\n' + '━'.repeat(64));
  log('▶ 启动独立测试服务（QF_MOCK=1, 端口 ' + PORT + '）');
  log('━'.repeat(64));
  /* 测试服务使用独立数据目录：绝不读写生产环境的 config.json 等文件 */
  const testDataDir = path.join(ROOT, 'data', 'test-env');
  require('fs').mkdirSync(testDataDir, { recursive: true });
  /* 写入测试专用配置（假 Key：模拟模式不发真实请求，仅让岗位判定为"可用"） */
  const seedCfg = {
    marginPct: 200, retryFactor: 1.25, visionBudgetYuan: 2, signupBonus: 5,
    concurrency: { global: 8, perProvider: 4, cooldownSec: 30 },
    providers: [
      { id: 'tp_main', name: '测试主供应商', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test-mock-0000000000', priceIn: 2, priceOut: 8, enabled: true, note: '测试用' },
      { id: 'tp_alt', name: '测试副供应商', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'test-mock-alt-0000000000', priceIn: 1, priceOut: 1, enabled: true, note: '测试用' }
    ],
    profiles: {
      generator: { label: '出题员', model: 'deepseek-chat', providerIds: ['tp_main'] },
      classifier: { label: '难度标注员', model: 'deepseek-chat', providerIds: ['tp_main'] },
      verifier1: { label: '质检员A', model: 'deepseek-chat', providerIds: ['tp_main'] },
      verifier2: { label: '质检员B', model: 'glm-4-flash', providerIds: ['tp_alt'] },
      vision: { label: '识图员', model: 'glm-4v-flash', providerIds: ['tp_alt'], maxTokens: 1000 },
      nlu: { label: '需求解析员', model: 'deepseek-chat', providerIds: ['tp_main'] }
    }
  };
  require('fs').writeFileSync(path.join(testDataDir, 'config.json'), JSON.stringify(seedCfg, null, 2));
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, TEST_ENV, { QF_PORT: String(PORT), QF_DATA_DIR: testDataDir }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  server.stdout.on('data', d => serverLog += d);
  server.stderr.on('data', d => serverLog += d);

  let ok = true;
  try {
    await waitForServer(20000);
    log('  ✓ 测试服务已就绪');

    /* 造一个固定的测试管理员（夹具）：
     * pool_test 需要管理员权限，旧版本靠"注册第一个用户碰运气"或登录真实管理员账号，
     * 后者把测试绑在某个人的线上账号上。现在由夹具统一提供，凭据通过环境变量下发。 */
    const FIX_ADMIN = { user: 'qf_test_admin', pwd: 'qf-test-admin-123456' };
    const fixScript = [
      "const db = require('./lib/db');",
      "(async () => {",
      "  await db.init();",
      "  let u = await db.findUserByName('" + FIX_ADMIN.user + "');",
      "  if (!u) { const id = await db.createUser('" + FIX_ADMIN.user + "', '" + FIX_ADMIN.pwd + "', { role: 'admin', bonus: 100 }); u = await db.findUserById(id); }",
      "  else if (u.role !== 'admin') await db.q(\"UPDATE users SET role='admin' WHERE id=?\", [u.id]);",
      "  console.log('fixture admin ready: ' + u.user_no);",
      "  await db.pool.end();",
      "})().catch(e => { console.error(e.message); process.exit(1); });"
    ].join('\n');
    const fix = await run(process.execPath, ['-e', fixScript], TEST_ENV);
    if (fix.code !== 0) { log('  ✗ 测试夹具管理员创建失败：' + fix.out.slice(-300)); ok = false; }
    else log('  ✓ 测试夹具管理员已就绪（' + FIX_ADMIN.user + '）');
    const PY_ENV = { QF_BASE: BASE, QF_TEST_ADMIN_USER: FIX_ADMIN.user, QF_TEST_ADMIN_PWD: FIX_ADMIN.pwd };

    /* 3. 依次执行测试 */
    if (!await runStep('后端自测（数据库/账号/流水线/视觉/导出）', process.execPath, ['selftest.js'], Object.assign({}, TEST_ENV, { QF_DATA_DIR: testDataDir }))) ok = false;
    if (!await runStep('新功能自测（签到/在线时长/知识点/审计/撤回/计费幂等/分块检索）', process.execPath, ['feature_test.js'], Object.assign({}, TEST_ENV, { QF_DATA_DIR: testDataDir, QF_BASE: BASE }))) ok = false;
    if (!await runStep('路由冒烟（每条路由真实调一次，断言不出现 5xx）', process.execPath, ['routesmoke.js'], Object.assign({}, TEST_ENV, { QF_BASE: BASE }))) ok = false;
    if (!await runStep('用户旅程（注册→制题→审核→题库→退出/切换）', 'python', ['journey_test.py'], PY_ENV)) ok = false;
    if (!await runStep('资料库取证（上传→两个页面取材→原图内嵌）', 'python', ['material_test.py'], PY_ENV)) ok = false;
    if (!await runStep('刷题系统（制题→立即可刷→判分→错题本→统计→AI讲解）', 'python', ['practice_test.py'], PY_ENV)) ok = false;
    if (!await runStep('API 池与高并发（多密钥轮换/批量导入/冷却切换/权限）', 'python', ['pool_test.py'], PY_ENV)) ok = false;
  } catch (e) {
    log('  ✗ ' + e.message);
    log(serverLog.slice(-800));
    ok = false;
  } finally {
    server.kill();
  }

  /* 4. 汇总 */
  log('\n' + '═'.repeat(64));
  log('测试汇总');
  log('═'.repeat(64));
  for (const r of results) {
    log('  ' + (r.ok ? '✓ 通过' : '✗ 失败') + '  ' + r.label + '  (' + (r.ms / 1000).toFixed(1) + 's)');
  }
  const failed = results.filter(r => !r.ok);
  log('\n共 ' + results.length + ' 项，失败 ' + failed.length + ' 项');
  process.exit(failed.length ? 1 : 0);
})();
