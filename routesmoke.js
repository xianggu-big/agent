/* 路由冒烟测试：把 server.js 里的**每一条**路由都真实调用一次，断言没有任何一条返回 5xx
 *
 * 为什么需要它（这是本项目真实吃过的教训）：
 *   `apicheck.js` 只检查"前端调用的路径在后端存在"，`viewaudit.js` 只检查"页面从后端取数"，
 *   Python 测试只覆盖它们各自知道的快乐路径。于是"某个不常走的分支里引用了已被删除的变量"
 *   这类错误可以一路绿灯活到线上 —— 实际发生过：重写需求解析时删掉了 server.js 里的 TYPE_CN 定义，
 *   AI 讲解接口（用到了它）直接 500，而 8 个套件全绿，是用户点出来才发现的。
 *
 * 做法：像 apicheck 一样从 server.js 抽取路由（`p === '/api/x'` 与 `p.match(/^\/api\/...$/)`），
 * 给动态段填上真实 id，再用真实会话逐条调用；只看"有没有 5xx"，不看业务语义。
 * 断言 4xx 是允许的（参数不全、权限不足都是正常回答），但 5xx 一律视为缺陷。
 *
 * 用法：QF_BASE=http://localhost:8541 node routesmoke.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const BASE = process.env.QF_BASE || 'http://localhost:8541';
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; } else { fail++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
}

/* ---------- 1. 从 server.js 抽取路由 ---------- */
function extractRoutes() {
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const routes = [];
  const methodsNear = (idx, span) => {
    const win = src.slice(idx, idx + span);
    const set = new Set();
    for (const m of win.matchAll(/req\.method === '([A-Z]+)'/g)) set.add(m[1]);
    return [...set];
  };
  for (const m of src.matchAll(/p === '(\/api\/[^']+)'/g)) {
    routes.push({ p: m[1], methods: methodsNear(m.index, 500) });
  }
  for (const m of src.matchAll(/const \w+ = p\.match\((\/\^[\s\S]*?\/)\);/g)) {
    /* 把后端正则里的捕获组换成占位符，再填真实 id */
    const re = new RegExp(m[1].slice(1, -1));
    routes.push({ re, methods: methodsNear(m.index, 2500) });
  }
  return routes;
}

/* 把后端正则变成一条可调用的具体路径：捕获组统一填 :id，之后按名字替换 */
function concretePath(route, ids) {
  if (route.p) return route.p;
  return route.re.source
    .replace(/^\^/, '').replace(/\$$/, '')
    .replace(/\\\//g, '/')
    .replace(/\(\[\^\/\]\+\)/g, ':id')
    .replace(/\((?:[^()]*\|[^()]*)\)/g, ':sub')   // 枚举组如 (decide|regen) → 用第一个
    .replace(/:sub/g, () => {
      const m = /\(([^()]*)\)/.exec(route.re.source.replace(/\\\//g, '/'));
      return m ? m[1].split('|')[0] : 'x';
    })
    .replace(/:id/g, () => ids.next());
}

/* ---------- 2. 会话与准备数据 ---------- */
let cookie = '';
let loginUser = null, loginPwd = null;
async function raw(p, opts = {}) {
  const r = await fetch(BASE + p, Object.assign({}, opts, {
    headers: Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {}, cookie ? { Cookie: cookie } : {})
  }));
  /* 只在服务端确实下发了非空会话时才更新本地 cookie：
   * 否则一次 /api/auth/logout（会清 cookie）就把后面所有请求变成 401，
   * 整个冒烟测试会"假装通过"——这正是第一版踩到的坑。 */
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  const sess = sc.map(c => c.split(';')[0]).find(c => c.startsWith('qf_sess='));
  if (sess) {
    const v = sess.slice('qf_sess='.length);
    if (v) cookie = sess; else cookie = '';
  }
  const text = await r.text().catch(() => '');
  let d = null; try { d = JSON.parse(text); } catch (e) { d = text; }
  return { status: r.status, d };
}
async function login() {
  cookie = '';
  await raw('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: loginUser, password: loginPwd }) });
}
/* 普通调用：万一会话失效（被踢/过期）就重新登录并重试一次，避免把 401 当成正常结果混过去 */
let relogins = 0;
async function call(p, opts = {}) {
  let r = await raw(p, opts);
  if (r.status === 401 && loginUser) { relogins++; await login(); r = await raw(p, opts); }
  return r;
}

(async () => {
  console.log('路由冒烟测试（每条路由都真实调一次，断言不出现 5xx）\n' + '='.repeat(64));
  const tag = 'smoke_' + Date.now().toString(36);
  loginUser = tag;
  loginPwd = 'test123456';

  /* 报个账号，准备一份资料 + 一个跑完的任务 + 一道题（好让详情类接口有真实 id 可用） */
  const reg = await call('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: tag, password: 'test123456' }) });
  if (reg.status !== 200) { console.log('注册失败，无法继续：' + JSON.stringify(reg.d)); process.exit(1); }
  const mat = await call('/api/materials', { method: 'POST', body: JSON.stringify({ name: '冒烟资料', text: '第一章 线性表\n1.1 顺序表的插入平均移动 n/2 个元素。\n第二章 栈与队列\n2.1 循环队列牺牲一个单元区分队满队空。' }) });
  const materialId = mat.d.id;
  const kps = await call('/api/kps/extract', { method: 'POST', body: JSON.stringify({ materialId }) });
  const parsed = await call('/api/chat/parse', { method: 'POST', body: JSON.stringify({ materialId, requirementText: '覆盖全部知识点，每个知识点各出 1 道选择题' }) });
  const conf = await call('/api/chat/confirm', { method: 'POST', body: JSON.stringify({ parsed: parsed.d.parsed, materialId }) });
  const taskId = conf.d.taskId;
  let qid = null;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 700));
    const t = await call('/api/tasks/' + taskId);
    if (t.d && t.d.questions && t.d.questions.length) { qid = t.d.questions[0].id; }
    if (t.d && t.d.task && !['running', 'approved'].includes(t.d.task.status)) break;
  }
  const qlist = await call('/api/practice/list?limit=5');
  let practiceQid = (qlist.d.questions && qlist.d.questions[0] && qlist.d.questions[0].id) || null;
  if (!practiceQid) {
    /* 题库里没有已采纳的题（演示模式下常见：分歧题都进了人工队列）。
     * 讲解/追问这类接口只有拿到一道"可练习"的题才会走到真正的代码路径，
     * 所以这里主动把一道分歧题采纳掉，保证覆盖到 —— 否则冒烟测试会静默漏掉它们。 */
    const det = await call('/api/tasks/' + taskId);
    const target = (det.d.questions || []).find(x => x.status === 'needs_review');
    if (target) {
      await call('/api/tasks/' + taskId + '/decide', { method: 'POST', body: JSON.stringify({ qid: target.id, action: 'accept' }) });
      const again = await call('/api/practice/list?limit=5');
      practiceQid = (again.d.questions && again.d.questions[0] && again.d.questions[0].id) || target.id;
    }
  }
  check('准备了"可练习题目"（否则讲解类接口不会被真正覆盖）', !!practiceQid, '请检查制题流水线是否正常');
  const figId = ((await call('/api/tasks/' + taskId)).d.task.figures || [])[0];
  const ids = { taskId, materialId, qid: practiceQid || 'q_none', figId: figId ? figId.id : 'none', parseId: 'none' };
  console.log('准备数据：任务 ' + taskId + '，可练习题目 ' + practiceQid + '\n');

  /* ---------- 3. 逐条调用 ---------- */
  const routes = extractRoutes();
  const seq = () => { let i = 0; return () => ids[['taskId', 'materialId', 'qid'][i++ % 3]] || 'x'; };
  const seen = new Set();
  let okCount = 0, sessionFails = 0;
  const SKIP = ['/api/auth/logout'];   // 单独放到最后测，避免中途把会话清掉
  for (const route of routes) {
    const methods = route.methods.length ? route.methods : ['GET'];
    for (const method of methods) {
      let p;
      try { p = concretePath(route, seq()); } catch (e) { continue; }
      if (!p || !p.startsWith('/api/')) continue;
      if (SKIP.includes(p)) continue;
      const key = method + ' ' + p;
      if (seen.has(key)) continue;
      seen.add(key);
      const opts = { method };
      if (method !== 'GET') {
        /* 给写接口一个最小但合法的 body：带 id 的字段用真实 id 填 */
        opts.body = JSON.stringify({
          taskId, materialId, qid: practiceQid, id: practiceQid, questionId: practiceQid,
          oplogId: 1, userId: 1, action: 'accept', key: 'generator', name: '冒烟', username: 'x',
          message: '这是什么考点', amount: 1, text: '冒烟文本', op: 'add', ids: [], role: 'user', approve: false
        });
      }
      let r;
      try { r = await call(p, opts); } catch (e) { check(method + ' ' + p, false, '请求异常 ' + e.message); continue; }
      if (process.env.QF_SMOKE_VERBOSE === '1') console.log('   ' + method + ' ' + p + ' → ' + r.status);
      /* 只把"会话失效"算作问题：像"原密码不正确"这类业务性 401 是正常回答，
       * 不能一杆子打死 —— 但会话失效必须暴露，否则后面所有路由都会"看起来正常"地返回 401，
       * 这个冒烟测试就变成安慰剂了（第一版就是这么骗过自己的）。 */
      if (r.status === 401 && r.d && /请先登录/.test(String(r.d.error || ''))) sessionFails++;
      else okCount++;
      check(method + ' ' + p, r.status < 500,
        'HTTP ' + r.status + ' ' + String(typeof r.d === 'object' ? JSON.stringify(r.d) : r.d).slice(0, 200));
    }
  }
  check('冒烟过程中会话始终有效（否则 401 会掩盖真实问题）', sessionFails === 0 && okCount > 20,
    '会话失效=' + sessionFails + ' 次，有效响应=' + okCount + '，中途重新登录=' + relogins);
  /* 关键接口必须真的被执行到（不能因为参数不足而提前返回） */
  const ex = await call('/api/practice/explain', { method: 'POST', body: JSON.stringify({ qid: practiceQid, force: true }) });
  check('AI 讲解真的返回内容（不是 404/400 提前退出）', ex.status === 200 && !!(ex.d.messages && ex.d.messages.length),
    'HTTP ' + ex.status + ' ' + String(JSON.stringify(ex.d)).slice(0, 160));

  /* ---------- 4. 登出单独测（放在最后，且验证它确实让会话失效） ---------- */
  const lo = await call('/api/auth/logout', { method: 'POST', body: '{}' });
  check('登出接口不报 5xx', lo.status < 500, 'HTTP ' + lo.status);
  const afterLogout = await raw('/api/me');
  check('登出后会话确实失效（/api/me 返回 authed:false）', afterLogout.status === 200 && afterLogout.d.authed === false,
    'HTTP ' + afterLogout.status + ' ' + JSON.stringify(afterLogout.d).slice(0, 80));

  console.log('\n' + '='.repeat(64));
  console.log('共检查 ' + (pass + fail) + ' 条路由调用：通过 ' + pass + '，失败 ' + fail);
  if (failures.length) { console.log('\n失败明细：'); failures.forEach(f => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('冒烟测试异常终止：' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n')); process.exit(1); });
