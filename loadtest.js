/* 压测：并发打 DB/API 层，输出可对比的报告
 *
 * 用法：
 *   QF_DB_NAME=questionforge_test QF_BASE=http://localhost:8541 node loadtest.js --concurrency=30 --label after
 *   node loadtest.js --diff before.json after.json
 *
 * 为什么不用 k6 / JMeter：
 *   本项目接口是 Cookie 会话制、瓶颈几乎全在 MySQL，用 Node 内置 fetch + 一个并发池就够，
 *   而且零依赖（和项目本身的选型一致），报告格式也能自己控。
 *
 * 三条纪律（否则数字没有可比性）：
 *   1) 同一台机器、同一个数据集快照、同一并发档位；
 *   2) 压的只是 DB/API 层 —— 绝不压真实模型调用（会烧钱）。要压流水线并发请用 QF_MOCK=1 起服务；
 *   3) 报告里必须写清"客户端与 MySQL 是否同机"，否则读者无法判断数字含义。
 *
 * 关键指标不只是 QPS，还有"每次请求触发的 SQL 次数"（MySQL 的 Questions 全局计数差值）——
 * 这条最能反映"全量加载 vs SQL 侧过滤"这类改造的效果。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const db = require('./lib/db');

const args = {};
process.argv.slice(2).forEach(a => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) args[m[1]] = m[2] === undefined ? true : m[2];
});

const BASE = process.env.QF_BASE || 'http://localhost:8541';
const DB = process.env.QF_DB_NAME || db.DB_NAME;
const USER = args.user || 'perf_user';
const PWD = args.password || 'perf123456';
const LEVELS = String(args.concurrency || '10,30,100').split(',').map(x => +x);
const PER_SCENARIO = +(args.requests || 400);      // 每个场景在每个并发档位下的请求数
const LABEL = String(args.label || 'run');
const OUT_DIR = path.join(__dirname, 'data', 'loadtest');
fs.mkdirSync(OUT_DIR, { recursive: true });

/* ---------- 对比模式 ---------- */
if (args.diff) {
  const [a, b] = String(args.diff).split(',').map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
  const fmt = n => (n == null ? '—' : (n >= 100 ? Math.round(n) : n.toFixed(1)));
  console.log('对比：' + a.label + '  →  ' + b.label);
  console.log('场景'.padEnd(14) + '并发'.padEnd(6) + 'QPS'.padEnd(18) + 'p95(ms)'.padEnd(18) + 'SQL/请求');
  for (const k of Object.keys(b.scenarios)) {
    for (const c of Object.keys(b.scenarios[k].levels)) {
      const x = a.scenarios[k] && a.scenarios[k].levels[c];
      const y = b.scenarios[k].levels[c];
      if (!y) continue;
      console.log(
        k.padEnd(14) + c.padEnd(6) +
        (fmt(x && x.qps) + ' → ' + fmt(y.qps)).padEnd(18) +
        (fmt(x && x.p95) + ' → ' + fmt(y.p95)).padEnd(18) +
        (x && x.sqlPerReq != null ? fmt(x.sqlPerReq) : '—') + ' → ' + fmt(y.sqlPerReq));
    }
  }
  const sqlA = a.sql && a.sql.queries ? a.sql.queries : null;
  const sqlB = b.sql && b.sql.queries ? b.sql.queries : null;
  if (sqlA || sqlB) console.log('\n整轮 SQL 查询总数：' + sqlA + ' → ' + sqlB);
  process.exit(0);
}

/* ---------- 会话与请求 ---------- */
let cookie = '';
async function raw(p, opts = {}) {
  const t0 = process.hrtime.bigint();
  let status = 0, err = null;
  try {
    const r = await fetch(BASE + p, Object.assign({}, opts, {
      headers: Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {}, cookie ? { Cookie: cookie } : {})
    }));
    status = r.status;
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    const s = sc.map(x => x.split(';')[0]).find(x => x.startsWith('qf_sess='));
    if (s && s.length > 9) cookie = s;
    await r.text();
  } catch (e) { err = e.message; }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { status, ms, err };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function login() {
  const r = await raw('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: USER, password: PWD }) });
  if (r.status !== 200) throw new Error('登录失败 HTTP ' + r.status + '（先跑 seed.js 造数据，或确认账号密码）');
}
async function sqlCount() {
  try { const [rows] = await db.q("SHOW GLOBAL STATUS LIKE 'Questions'"); return Number(rows[0].Value) || 0; } catch (e) { return null; }
}

function summarize(rows, sqlDelta, seconds) {
  const ok = rows.filter(r => r.status >= 200 && r.status < 400);
  const lat = ok.map(r => r.ms).sort((a, b) => a - b);
  const q = p => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] : null);
  return {
    requests: rows.length, ok: ok.length,
    errors: rows.length - ok.length,
    errorRate: +(100 * (rows.length - ok.length) / rows.length).toFixed(2),
    qps: +(ok.length / seconds).toFixed(1),
    mean: lat.length ? +(lat.reduce((a, b) => a + b, 0) / lat.length).toFixed(1) : null,
    p50: q(0.5) != null ? +q(0.5).toFixed(1) : null,
    p95: q(0.95) != null ? +q(0.95).toFixed(1) : null,
    p99: q(0.99) != null ? +q(0.99).toFixed(1) : null,
    max: lat.length ? +lat[lat.length - 1].toFixed(1) : null,
    sqlPerReq: sqlDelta != null ? +(sqlDelta / Math.max(1, ok.length)).toFixed(2) : null
  };
}

/* 并发池：N 个 worker 从队列里取任务 */
async function runPool(concurrency, tasks) {
  const rows = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      rows[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return rows;
}

(async () => {
  if (!/test/i.test(DB)) {
    console.error('✗ 拒绝执行：目标库「' + DB + '」不是测试库（压测只允许打测试库）。');
    process.exit(1);
  }
  await db.init();
  await login();
  const me = await raw('/api/me');
  console.log('压测目标：' + BASE + '　库：' + DB + '　账号：' + USER + '（/api/me → ' + me.status + '）');

  /* 取一批真实题目 id 供写场景使用 */
  const listOnce = async () => {
    const r = await fetch(BASE + '/api/practice/list?limit=50', { headers: { Cookie: cookie } });
    const j = await r.json();
    return (j.questions || []).map(q => q.id);
  };
  const qids = await listOnce();
  if (!qids.length) { console.error('✗ 题库里没有可练习的题，请先跑 seed.js'); process.exit(1); }
  console.log('拿到 ' + qids.length + ' 道真实题目用于写场景\n');

  const mk = pattern => {
    let i = 0;
    return () => {
      const p = pattern[(i++) % pattern.length];
      if (typeof p === 'string') return () => raw(p);
      return () => raw(p.path, p.opts);
    };
  };
  const SCENARIOS = {
    /* 读：题库列表（带筛选）+ 筛选项 + 统计 —— 学生刷题最常打的路径 */
    read: mk(['/api/practice/list?limit=30', '/api/practice/list?limit=30&scope=wrong',
      '/api/practice/list?limit=60&ch=2', '/api/practice/filters', '/api/practice/stats']),
    /* 写：答题 + 收藏/取消 + 隐藏/恢复 —— 含 upsert 与流水写入 */
    write: mk([{ path: '/api/practice/answer', opts: { method: 'POST', body: JSON.stringify({ qid: '__Q__', answer: 'A' }) } }]),
    /* 混合：读 4 : 写 1，接近真实 */
    mixed: null
  };
  /* 写场景的 qid 每次替换成真实 id（避免同一个 id 造成行锁热点） */
  const writeTask = () => {
    const qid = qids[Math.floor(Math.random() * qids.length)];
    return () => raw('/api/practice/answer', { method: 'POST', body: JSON.stringify({ qid, answer: 'A' }) });
  };
  const readTask = mk(['/api/practice/list?limit=30', '/api/practice/list?limit=30&scope=wrong',
    '/api/practice/list?limit=60&ch=2', '/api/practice/filters', '/api/practice/stats']);
  const mixedTask = (() => { let i = 0; return () => (i++ % 5 === 4 ? writeTask() : readTask()); })();

  const report = {
    label: LABEL, ts: Date.now(), base: BASE, db: DB,
    host: { node: process.version, platform: process.platform, cpus: require('os').cpus().length },
    sameMachineAsDb: DB_HOST_IS_LOCAL(),
    scenarios: {}
  };
  const sqlBeforeAll = await sqlCount();

  for (const name of Object.keys(SCENARIOS)) {
    report.scenarios[name] = { levels: {} };
    for (const c of LEVELS) {
      const task = name === 'read' ? readTask : name === 'write' ? writeTask : mixedTask;
      /* 注意：task 是"请求工厂"，要调用一次才拿到具体请求函数（第一版忘了调用，
       * 结果 400 个任务全是函数、一个请求都没发出去，报告显示 100% 错误）。 */
      const tasks = Array.from({ length: PER_SCENARIO }, () => task());
      const sql0 = await sqlCount();
      const t0 = Date.now();
      const rows = await runPool(c, tasks);
      const seconds = (Date.now() - t0) / 1000;
      const sql1 = await sqlCount();
      const s = summarize(rows, sql0 != null && sql1 != null ? sql1 - sql0 : null, seconds);
      s.seconds = +seconds.toFixed(2);
      report.scenarios[name].levels[c] = s;
      console.log(name.padEnd(7) + ' 并发 ' + String(c).padEnd(4) +
        ' QPS ' + String(s.qps).padEnd(8) + ' p50 ' + String(s.p50).padEnd(7) + ' p95 ' + String(s.p95).padEnd(7) +
        ' p99 ' + String(s.p99).padEnd(7) + ' 错误 ' + s.errorRate + '%' + ' SQL/请求 ' + s.sqlPerReq);
      await sleep(500);
    }
  }
  const sqlAfterAll = await sqlCount();
  report.sql = { before: sqlBeforeAll, after: sqlAfterAll, queries: sqlAfterAll - sqlBeforeAll };

  const file = path.join(OUT_DIR, 'loadtest-' + LABEL + '-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '') + '.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  /* 同时写一份 markdown，方便贴进文档 */
  const md = ['# 压测报告 ' + LABEL, '',
    '- 目标：' + BASE + '　库：' + DB + '　Node ' + process.version + '　CPU ' + report.host.cpus + ' 核',
    '- 客户端与 MySQL 同机：' + (report.sameMachineAsDb ? '是（会互相抢 CPU，数字偏保守）' : '否'),
    '- 每个场景每档并发下发 ' + PER_SCENARIO + ' 个请求', '',
    '| 场景 | 并发 | QPS | p50 | p95 | p99 | 错误率 | 每次请求 SQL 数 |', '|---|---|---|---|---|---|---|---|'];
  for (const [k, v] of Object.entries(report.scenarios)) {
    for (const [c, s] of Object.entries(v.levels)) {
      md.push('| ' + k + ' | ' + c + ' | ' + s.qps + ' | ' + s.p50 + ' | ' + s.p95 + ' | ' + s.p99 + ' | ' + s.errorRate + '% | ' + s.sqlPerReq + ' |');
    }
  }
  md.push('', '整轮 SQL 查询总数：' + report.sql.queries);
  fs.writeFileSync(file.replace(/\.json$/, '.md'), md.join('\n') + '\n');
  console.log('\n报告已写出：' + file);
  console.log(md.join('\n'));
  await db.pool.end();
})().catch(e => { console.error('压测失败：' + e.message); process.exit(1); });

function DB_HOST_IS_LOCAL() {
  const h = process.env.QF_DB_HOST || '127.0.0.1';
  return h === '127.0.0.1' || h === 'localhost';
}
