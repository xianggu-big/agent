/* 新功能与本次修复的专项自测（回归保护）
 *
 * 覆盖：
 *   一、纯逻辑单测（不碰数据库）：资料分块 / 按考点检索取材 / 近似重复检测 / 知识点规则抽取 / 限流
 *   二、接口级测试（对着 QF_BASE）：健康检查、签到幂等、在线时长、知识点抽取、按知识点分别出题、
 *      题库 SQL 侧筛选与分页、收藏/隐藏、操作记录按 scope 隔离、按用户号查审计、撤回申请与执行、CSRF
 *   三、本次修复的针对性回归：
 *      · 计费幂等（同一笔只扣一次）
 *      · "待人工审核"的任务也会结算费用（旧版本这一支永远不扣费）
 *      · 人工裁决不会被流水线的陈旧内存状态覆盖（落库守卫）
 *      · 服务重启后的僵尸任务可恢复
 *
 * 用法：QF_MOCK=1 QF_DB_NAME=questionforge_test QF_BASE=http://localhost:8541 node feature_test.js
 */
'use strict';
const path = require('path');
const db = require('./lib/db');
const Store = require('./lib/store');
const Agent = require('./lib/agent');
const Text = require('./lib/text');
const KP = require('./lib/kp');
const RL = require('./lib/ratelimit');
const Revert = require('./lib/revert');

const BASE = process.env.QF_BASE || 'http://localhost:8541';
let pass = 0, fail = 0, cur = '';
function section(t) { console.log('\n【' + t + '】'); cur = t; }
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail !== undefined ? ' → ' + detail : '')); }
}
/* 两个独立会话：测试里要在普通用户与管理员之间来回切换，共用一个 cookie 变量会串号 */
const cookies = { user: '', admin: '' };
async function api(pathname, opts = {}, who = 'user') {
  const r = await fetch(BASE + pathname, Object.assign({}, opts, {
    headers: Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {}, cookies[who] ? { Cookie: cookies[who] } : {})
  }));
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (sc.length) cookies[who] = sc.map(c => c.split(';')[0]).join('; ');
  let d = null; const text = await r.text().catch(() => '');
  try { d = JSON.parse(text); } catch (e) { d = text; }
  return { status: r.status, d };
}
const uid = () => 'ft_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const SAMPLE = [
  '第一章 线性表',
  '1.1 顺序表的插入与删除，时间复杂度与移动元素个数有关。',
  '1.2 单链表的插入需要修改前驱结点的指针域，删除要注意释放空间。',
  '第二章 栈与队列',
  '2.1 循环队列需要牺牲一个存储单元来区分队满与队空。',
  '2.2 栈的典型应用包括表达式求值与递归调用。',
  '第三章 二叉树',
  '3.1 二叉树的中序遍历可以用于判定二叉排序树。',
  '3.2 完全二叉树适合顺序存储，不浪费空间。'
].join('\n');

(async function main() {
  if (!Store.isMock()) {
    console.log('⚠ 请用 QF_MOCK=1 运行（避免真实调用模型产生费用）');
    process.exit(2);
  }
  console.log('QuestionForge 新功能自测（演示模式）\n' + '='.repeat(56));

  /* ============ 一、纯逻辑单测 ============ */
  section('资料分块与检索（替代"只喂前 12000 字"）');
  const long = Array.from({ length: 60 }, (_, i) => '第' + (i + 1) + '章 主题' + (i + 1) + '\n' + ('内容' + (i + 1) + '。').repeat(80)).join('\n\n');
  const chunks = Text.splitChunks(long);
  check('长资料被切成多块', chunks.length > 10, '块数=' + chunks.length);
  check('识别到章节号', chunks.some(c => c.ch > 1), 'ch 集合=' + [...new Set(chunks.map(c => c.ch))].slice(0, 6).join(','));
  const whole = chunks.reduce((a, c) => a + c.chars, 0);
  check('分块后总字数≈原文（无明显丢失）', whole > long.length * 0.8, whole + ' vs ' + long.length);
  const used = new Set();
  const sel1 = Text.selectChunks(chunks, { query: '第5章 主题5', wantCh: 5, used, budgetChars: 1200 });
  sel1.picked.forEach(i => used.add(i));
  check('按考点/章节能选中相关块', sel1.text.includes('主题5'), '选中块=' + sel1.picked.join(','));
  const sel2 = Text.selectChunks(chunks, { query: '第40章 主题40', wantCh: 40, used, budgetChars: 1200 });
  check('第二批优先挑没用过的块（覆盖率推进）', sel2.picked.some(i => !sel1.picked.includes(i)));
  /* 旧实现只把前 12000 字塞进提示词：这里验证第 40 章也能被取到 */
  const tailChunk = chunks.find(c => c.ch === 40);
  check('靠后的章节内容也能被检索到（旧实现永远看不到）', !!(tailChunk && long.indexOf(tailChunk.text) > 12000));

  section('近似重复检测');
  const a = '下列关于循环队列判满与判空的说法，正确的是（　）';
  const b = '关于循环队列判满、判空的说法中，正确的是（　）';
  const c = '在含 n 个结点的完全二叉树中，叶子结点的个数是多少？';
  check('改写过的高度相似题能识别为重复', Text.similarity(a, b) > 0.6, 'similarity=' + Text.similarity(a, b).toFixed(3));
  check('不同题目不会被误判', Text.similarity(a, c) < 0.3, 'similarity=' + Text.similarity(a, c).toFixed(3));
  check('findDuplicate 返回命中项', !!Text.findDuplicate(b, [{ id: 'x', stem: a }], 0.6));

  section('知识点规则抽取（无 Key/调用失败时的兜底）');
  const ruleKPs = KP.heuristicKPs(SAMPLE);
  check('从资料里抽出知识点', ruleKPs.length >= 3, '条数=' + ruleKPs.length);
  check('知识点带章节号', ruleKPs.some(k => k.ch >= 2));
  check('不产生空名或超长名', ruleKPs.every(k => k.name && k.name.length <= 30));
  const cov = KP.coverage([{ name: '循环队列' }, { name: '二叉树遍历' }], [{ kp: '循环队列的判满判空' }, { kp: '其他' }]);
  check('覆盖率检查能指出没出到题的知识点', cov.missing.length === 1 && cov.missing[0] === '二叉树遍历', JSON.stringify(cov.missing));

  section('限流器');
  RL.reset('unit:x');
  let blocked = false, hits = 0;
  for (let i = 0; i < 12; i++) { const r = RL.hit('unit:x', 5, 60000); if (r.ok) hits++; else blocked = true; }
  check('超过额度后被拦截', blocked && hits === 5, '通过 ' + hits + ' 次');
  process.env.QF_RATELIMIT = 'off';
  check('QF_RATELIMIT=off 可关闭限流（测试用）', RL.check('login', 'unit:y').ok);
  delete process.env.QF_RATELIMIT;

  /* ============ 二、接口级 ============ */
  await db.init();
  section('健康检查与安全响应头');
  const h = await api('/api/health');
  check('/api/health 返回 ok', h.status === 200 && h.d.ok === true, JSON.stringify(h.d).slice(0, 120));
  check('健康检查带数据库与队列信息', !!(h.d.db && h.d.queue), JSON.stringify(h.d));
  const hdr = await fetch(BASE + '/api/health');
  check('带 nuosniff 等安全响应头', !!hdr.headers.get('x-content-type-options') && !!hdr.headers.get('content-security-policy'));

  section('账号 / 签到 / 用户号');
  const uname = uid();
  const reg = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: uname, password: 'test123456' }) });
  check('注册成功并返回用户号', reg.status === 200 && !!reg.d.userNo, JSON.stringify(reg.d));
  const me1 = await api('/api/me');
  check('/api/me 带用户号', me1.d.userNo === reg.d.userNo);
  const ck1 = await api('/api/checkin', { method: 'POST', body: '{}' });
  check('首次签到成功', ck1.d.fresh === true && ck1.d.streak === 1, JSON.stringify(ck1.d).slice(0, 100));
  const ck2 = await api('/api/checkin', { method: 'POST', body: '{}' });
  check('重复签到不会重复计数（幂等）', ck2.d.fresh === false && ck2.d.totalDays === 1, JSON.stringify(ck2.d).slice(0, 100));

  section('在线时长（按会话累计，登出不清零）');
  const meRow = await db.findUserByName(uname);
  const t1 = await db.createSession(meRow.id, { ip: '127.0.0.1', ua: 'feature-test' });
  await db.q('UPDATE sessions SET last_seen=? WHERE token=?', [Date.now() - 120000, t1]);
  await db.userBySession(t1);
  await new Promise(r => setTimeout(r, 250));
  const onlineA = await db.onlineMs(meRow.id);
  await db.destroySession(t1);
  await new Promise(r => setTimeout(r, 150));
  const onlineB = await db.onlineMs(meRow.id);
  check('心跳把在线时长累加进会话', onlineA >= 118000, 'onlineMs=' + onlineA);
  check('登出后时长保留（旧实现会连行一起删掉）', onlineB >= onlineA, onlineA + ' → ' + onlineB);
  const stale = await db.userBySession(t1);
  check('已结束的会话立即失效（登出/踢下线有效）', stale === null);

  section('知识点抽取与"按知识点分别出题"');
  const mat = await api('/api/materials', { method: 'POST', body: JSON.stringify({ name: 'feature测试资料', text: SAMPLE }) });
  const matId = mat.d.id;
  const kex = await api('/api/kps/extract', { method: 'POST', body: JSON.stringify({ materialId: matId }) });
  check('抽取知识点成功', kex.status === 200 && (kex.d.kps || []).length > 0, 'n=' + ((kex.d.kps || []).length));
  const kcached = await api('/api/kps?materialId=' + matId);
  check('知识点已缓存入库，可直接复用', (kcached.d || []).length === (kex.d.kps || []).length);
  const parse = await api('/api/chat/parse', { method: 'POST', body: JSON.stringify({ materialId: matId, requirementText: '按知识点分别出题，每个知识点各出 2 道选择题，中等难度' }) });
  check('NLU 把"按知识点分别出题"展开成逐知识点需求', parse.d.perKP === true && parse.d.parsed.requirements.length > 1,
    'perKP=' + parse.d.perKP + ' reqs=' + (parse.d.parsed ? parse.d.parsed.requirements.length : 0));
  check('每条需求都挂了具体考点（供出题时检索取材）', parse.d.parsed.requirements.every(r => r.kp && r.kp.length > 0));
  const totalReqQ = parse.d.parsed.requirements.reduce((a, r) => a + r.count, 0);
  check('总题量 = 知识点数 × 每条数量', totalReqQ === parse.d.parsed.requirements.length * 2, 'total=' + totalReqQ);

  section('自然语言 → 程序语言（复杂说法的翻译）');
  /* 用户反馈的原话：这类"多知识点 × 多题型 + 其它要求"的句子以前会整句落空，
   * 退化成默认的"5 道选择题"。这里把每种说法都固化下来，防止再退化。 */
  const kpCount = (kex.d.kps || []).length;
  const cases = [
    {
      text: '这些知识点所有题型都各出一道题，然后我希望这些题目都能将这些知识点全部覆盖',
      mode: 'all', types: 4, per: 1, cons: 0
    },
    {
      text: '每个知识点各出 2 道题，题型不限，要覆盖全部知识点',
      mode: 'all', types: 1, per: 2, cons: 1
    },
    {
      text: '覆盖全部知识点，所有题型各出一道，另外每道题都要有详细解析，不要出纯计算题',
      mode: 'all', types: 4, per: 1, cons: 2
    },
    {
      text: '帮我出题，覆盖全部知识点',
      mode: 'all', types: 1, per: 2, cons: 0
    },
    {
      text: '第 2 章出 10 道选择题，中等难度，不要出计算题',
      mode: 'none', types: 1, per: 10, cons: 2
    }
  ];
  for (const c of cases) {
    const r = await api('/api/chat/parse', { method: 'POST', body: JSON.stringify({ materialId: matId, requirementText: c.text }) });
    const p = r.d.parsed || {};
    const bits = [];
    bits.push(p.coverage && p.coverage.mode === c.mode ? '覆盖模式✓' : '覆盖模式✗(' + (p.coverage && p.coverage.mode) + ')');
    bits.push(Object.keys(p.byType || {}).length === c.types ? '题型数✓' : '题型数✗(' + Object.keys(p.byType || {}).length + ')');
    const expectTotal = c.mode === 'all' ? kpCount * c.types * c.per : c.per;
    bits.push(p.totals && p.totals.total === expectTotal ? '题量✓' : '题量✗(' + (p.totals && p.totals.total) + '≠' + expectTotal + ')');
    bits.push((p.constraints || []).length === c.cons ? '约束数✓' : '约束数✗(' + (p.constraints || []).length + '≠' + c.cons + ')');
    check('翻译「' + c.text.slice(0, 22) + '…」', bits.every(x => x.endsWith('✓')), bits.join(' '));
  }
  /* 兜底句：确实什么都没说时，才允许出现"默认 5 道选择题" */
  const empty = await api('/api/chat/parse', { method: 'POST', body: JSON.stringify({ materialId: matId, requirementText: '随便出点题' }) });
  check('没给信息时退回合理默认（不是错误）', (empty.d.parsed.totals.total >= 1), JSON.stringify(empty.d.parsed.totals));

  section('多题型生成与额外要求注入');
  {
    const kp1 = (kex.d.kps || [])[0];
    const two = await api('/api/chat/parse', { method: 'POST', body: JSON.stringify({
      materialId: matId,
      requirementText: '只考这个知识点：' + kp1.name + '，所有题型各出一道，解析要写详细步骤',
      kps: [kp1]
    }) });
    const tp = two.d.parsed;
    check('多题型需求能落到结构里（types 含 4 种）', tp.requirements.length === 1 && (tp.requirements[0].types || []).length === 4,
      JSON.stringify(tp.requirements[0]));
    const cf = await api('/api/chat/confirm', { method: 'POST', body: JSON.stringify({ parsed: tp, materialId: matId, kps: [kp1] }) });
    check('多题型任务创建成功', cf.status === 200 && !!cf.d.taskId, JSON.stringify(cf.d));
    let t2 = null;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 700));
      t2 = (await api('/api/tasks/' + cf.d.taskId)).d.task;
      if (!['running', 'approved'].includes(t2.status)) break;
    }
    const qs2 = (await api('/api/tasks/' + cf.d.taskId)).d.questions;
    const typeSet = [...new Set(qs2.map(q => q.type))];
    check('每种题型都真的出到了题', qs2.length === 4 && typeSet.length === 4,
      '题数=' + qs2.length + ' 题型=' + typeSet.join(','));
    check('客户的额外要求已存进任务（出题时逐条注入）',
      Array.isArray(t2.constraints) && t2.constraints.some(c => /详细步骤/.test(c)), JSON.stringify(t2.constraints));
    check('任务记录知识点总数与题量', (t2.kps || []).length === 1 && t2.totals && t2.totals.total === 4, JSON.stringify(t2.totals));
  }

  section('流水线：计费 / 覆盖率 / 待审核也结算');
  const confirm = await api('/api/chat/confirm', { method: 'POST', body: JSON.stringify({ parsed: parse.d.parsed, materialId: matId, kps: parse.d.kps }) });
  check('创建并启动制题任务', confirm.status === 200 && !!confirm.d.taskId, JSON.stringify(confirm.d));
  const taskId = confirm.d.taskId;
  let task = null;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 700));
    const t = await api('/api/tasks/' + taskId);
    task = t.d.task;
    if (!['running', 'approved'].includes(task.status)) break;
  }
  check('流水线跑完（含质检与裁决）', task && ['awaiting_review', 'completed'].includes(task.status), task && task.status);
  check('记录了资料分块覆盖情况', task.coveredChunks > 0, 'coveredChunks=' + task.coveredChunks);
  check('"要覆盖全部知识点"的任务标记了严格覆盖', task.coverageStrict === true, 'coverageStrict=' + task.coverageStrict);
  check('知识点覆盖率被计算', !!(task.stats && task.stats.coverage), JSON.stringify(task.stats && task.stats.coverage));
  /* 演示模式的分歧是按题号分布的：如果题目序号重复（同批题共用一个 seq），
   * 就会出现"整批一起分歧"或"整批一起一致"，这里把它固化成回归检查。 */
  check('分歧按题号分布（既非全部入库也非全部分歧）', task.stats.autoAccepted > 0 && task.stats.toReview > 0,
    'autoAccepted=' + task.stats.autoAccepted + ' toReview=' + task.stats.toReview);
  const seqs = (await db.q('SELECT gen_json FROM questions WHERE task_id=?', [taskId]))[0].map(r => (r.gen_json || {}).seq);
  check('题目序号唯一（同批题不会共用同一个 seq）', new Set(seqs).size === seqs.length, 'seqs=' + seqs.slice(0, 8).join(','));
  check('成本已入账（billed>0）', task.costs.billed > 0, 'spent=' + task.costs.spent + ' billed=' + task.costs.billed);
  /* 旧版本只在 status==='completed' 时扣费：只要有一道分歧题就永远不扣钱 */
  if (task.status === 'awaiting_review') {
    check('待人工审核的任务同样结算了费用（旧版本的漏单点）', task.costs.billed > 0);
  }
  const bills = await db.listBills(meRow.id, 20);
  const taskBill = bills.find(b => b.task_id === taskId);
  check('账单表里有该任务的流水', !!taskBill, JSON.stringify(bills.map(b => b.kind)));
  /* 幂等一：同一个 idemKey 重复入账，只扣一次 */
  const bal1 = await db.getBalance(meRow.id);
  const k1 = await db.billAndDeduct(meRow.id, { kind: 'unit', amount: 0.5, reason: '幂等单测', idemKey: 'unit:dup:' + taskId });
  const bal2 = await db.getBalance(meRow.id);
  const k2 = await db.billAndDeduct(meRow.id, { kind: 'unit', amount: 0.5, reason: '幂等单测', idemKey: 'unit:dup:' + taskId });
  const bal3 = await db.getBalance(meRow.id);
  check('同一 idemKey 重复入账只扣一次', k1.duplicate === false && k2.duplicate === true && Math.abs(bal2 - bal3) < 1e-6,
    'first=' + k1.duplicate + ' second=' + k2.duplicate + ' 余额 ' + bal2 + '→' + bal3);
  /* 幂等二：没有新增花费时重复结算，不应再扣钱（billTaskDelta 按差额计费） */
  await Agent.billTaskNow(taskId, '重复结算测试');
  await Agent.billTaskNow(taskId, '重复结算测试');
  const bal4 = await db.getBalance(meRow.id);
  check('无新增花费时重复结算不再扣费', Math.abs(bal3 - bal4) < 1e-6, '余额 ' + bal3 + '→' + bal4);

  section('题库：SQL 侧筛选 / 分页 / 收藏 / 隐藏');
  const qlist = await api('/api/practice/list?limit=5');
  check('题库能列出已采纳题目', qlist.d.total > 0 && qlist.d.questions.length <= 5, 'total=' + qlist.d.total);
  check('返回 counts 汇总', !!(qlist.d.counts && qlist.d.counts.all), JSON.stringify(qlist.d.counts));
  const q1 = qlist.d.questions[0];
  const page2 = await api('/api/practice/list?limit=5&offset=5');
  check('分页生效（offset 与首页不重复）', !page2.d.questions.some(x => x.id === q1.id), 'page2 n=' + page2.d.questions.length);
  const filters = await api('/api/practice/filters');
  check('筛选项带"批次"（按每次制题分开）', (filters.d.tasks || []).length >= 1 && !!filters.d.tasks[0].taskId, JSON.stringify(filters.d.tasks));
  check('批次带题量/未做/错题统计', filters.d.tasks[0].n > 0 && filters.d.tasks[0].todo !== undefined);
  const byBatch = await api('/api/practice/list?taskId=' + encodeURIComponent(taskId));
  check('按批次筛选后只剩这一批的题', byBatch.d.questions.length > 0 && byBatch.d.questions.every(x => x.taskId === taskId));
  const ans = await api('/api/practice/answer', { method: 'POST', body: JSON.stringify({ qid: q1.id, answer: q1.answer }) });
  check('选择题判分正确', ans.d.correct === true);
  const star = await api('/api/practice/star', { method: 'POST', body: JSON.stringify({ qid: q1.id, starred: true }) });
  check('收藏题目成功', star.d.starred === true);
  const hide = await api('/api/practice/hide', { method: 'POST', body: JSON.stringify({ qid: q1.id, hidden: true }) });
  check('隐藏题目成功', hide.d.ok === true);
  const afterHide = await api('/api/practice/list?limit=200');
  check('隐藏后不再推送', !afterHide.d.questions.some(x => x.id === q1.id));
  const stats = await api('/api/practice/stats');
  check('统计含按知识点维度与薄弱点', !!(stats.d.stats.byKp && stats.d.weak !== undefined));

  section('操作记录：用户与管理员分开 + 按用户号查询');
  const myInfo = await api('/api/user/info');
  check('个人中心能看到自己的操作记录', (myInfo.d.oplog || []).length > 0);
  check('个人中心只含 scope=user 的记录（不含管理员操作）', myInfo.d.oplog.every(o => (o.action !== 'config' && o.action !== 'provider_add')));
  check('个人中心返回账单与签到信息', Array.isArray(myInfo.d.bills) && !!myInfo.d.checkin);
  check('个人中心返回登录设备列表', Array.isArray(myInfo.d.sessions) && myInfo.d.sessions.length >= 1);
  const hideOp = (myInfo.d.oplog || []).find(o => o.action === 'practice_hide');
  check('隐藏操作被标记为可撤回', !!(hideOp && hideOp.revertible === 1 || hideOp && hideOp.revertible === true));

  /* 管理员：直接建号（避免与真实管理员的密码耦合） */
  const adminName = uid() + '_adm';
  const asalt = db.newSalt();
  await db.q('INSERT INTO users (username, pwd_hash, salt, balance, role, user_no, created_at) VALUES (?,?,?,?,?,?,?)',
    [adminName, db.hashPassword('admin123456', asalt), asalt, 50, 'admin', await db.nextUserNo('admin'), Date.now()]);
  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: adminName, password: 'admin123456' }) }, 'admin');
  check('管理员登录成功', login.status === 200 && login.d.role === 'admin', JSON.stringify(login.d));
  const auditAll = await api('/api/admin/oplogs?size=20', {}, 'admin');
  check('管理员能查询全局审计', auditAll.status === 200 && auditAll.d.total > 0, 'total=' + auditAll.d.total);
  check('审计区分"用户操作/管理操作"', auditAll.d.rows.some(r => r.scope === 'user') || auditAll.d.rows.some(r => r.scope === 'admin'));
  const auditByNo = await api('/api/admin/oplogs?userNo=' + encodeURIComponent(reg.d.userNo), {}, 'admin');
  check('按用户号一条查询到该用户的操作', auditByNo.d.total > 0 && auditByNo.d.rows.every(r => r.userNo === reg.d.userNo), 'total=' + auditByNo.d.total);
  const actions = await api('/api/admin/oplogs?size=1', {}, 'admin');
  check('审计提供操作类型候选（供下拉筛选）', (actions.d.actions || []).length > 0);
  const users = await api('/api/admin/users', {}, 'admin');
  const uRow = users.d.users.find(u => u.userNo === reg.d.userNo);
  check('用户管理带用户号/在线状态/在线时长/签到', !!(uRow && uRow.onlineMs !== undefined && uRow.bestStreak !== undefined && uRow.online !== undefined));
  const csv = await fetch(BASE + '/api/admin/oplogs/export', { headers: { Cookie: cookies.admin } });
  check('审计日志可导出 CSV', csv.status === 200 && (await csv.text()).includes('用户号'));

  section('撤回：用户申请 → 管理员批准 → 数据还原');
  const rr = await api('/api/user/revert-request', { method: 'POST', body: JSON.stringify({ oplogId: hideOp.id, reason: '点错了' }) }, 'user');
  check('用户提交撤回申请', rr.status === 200, JSON.stringify(rr.d));
  const rrDup = await api('/api/user/revert-request', { method: 'POST', body: JSON.stringify({ oplogId: hideOp.id, reason: 'again' }) }, 'user');
  check('同一操作不能重复申请', rrDup.status === 400, JSON.stringify(rrDup.d));
  const nonRev = await api('/api/user/revert-request', { method: 'POST', body: JSON.stringify({ oplogId: (myInfo.d.oplog || []).find(o => !o.revertible).id, reason: 'x' }) }, 'user');
  check('不可撤回的操作类型会被拒绝', nonRev.status === 400, JSON.stringify(nonRev.d));
  const pend = await api('/api/admin/revert-requests?status=pending', {}, 'admin');
  check('管理员能看到待处理申请', pend.d.rows.some(r => r.oplogId === hideOp.id), 'pending=' + pend.d.pending);
  const reqRow = pend.d.rows.find(r => r.oplogId === hideOp.id);
  const decided = await api('/api/admin/revert-decide', { method: 'POST', body: JSON.stringify({ id: reqRow.id, approve: true, note: '核实为误操作' }) }, 'admin');
  check('批准后执行撤回', decided.status === 200 && /恢复/.test(decided.d.message || ''), JSON.stringify(decided.d));
  const back = await api('/api/practice/list?limit=200', {}, 'user');
  check('被隐藏的题目已恢复推送', back.d.questions.some(x => x.id === q1.id));
  const opAfter = await db.getOplog(hideOp.id);
  check('原记录被标记为已撤回', !!opAfter.reverted);
  const revertOp = (await db.queryOplogs({ action: 'revert', size: 5 })).rows[0];
  check('新增一条指向原记录的撤回日志（可追溯）', !!(revertOp && revertOp.revert_of === hideOp.id), JSON.stringify(revertOp && { id: revertOp.id, revert_of: revertOp.revert_of }));

  section('资料软删除与恢复（删除不再不可逆）');
  const del = await api('/api/materials/' + matId, { method: 'DELETE' }, 'user');
  check('删除资料返回软删除标记', del.d.soft === true, JSON.stringify(del.d));
  const listAfterDel = await api('/api/materials', {}, 'user');
  check('删除后列表里不再出现', !listAfterDel.d.some(x => x.id === matId));
  const rawStill = await db.q('SELECT deleted_at FROM materials WHERE id=?', [matId]);
  check('正文仍在库里（可恢复）', rawStill[0].length === 1 && !!rawStill[0][0].deleted_at);
  const delOp = (await db.queryOplogs({ action: 'material_del', size: 3 })).rows[0];
  const rest = await Revert.revert(await db.getOplog(delOp.id), { adminId: meRow.id, note: '测试恢复' });
  check('撤销删除后资料恢复', /恢复/.test(rest.message));
  const listRestored = await api('/api/materials', {}, 'user');
  check('资料重新出现在列表里', listRestored.d.some(x => x.id === matId));

  section('人工裁决落库守卫（流水线不得覆盖人的决定）');
  const qq = await db.q('SELECT id FROM questions WHERE task_id=? LIMIT 1', [taskId]);
  const qid = qq[0][0].id;
  await db.q("UPDATE questions SET status='accepted', human_json=?, dup_of=NULL WHERE id=?", [JSON.stringify({ action: 'accept', ts: Date.now() }), qid]);
  /* 模拟流水线用陈旧的内存状态回写（旧实现会把人工决定冲掉） */
  await Store.saveQuestion(taskId, { id: qid, type: 'mcq', ch: 1, kp: 'x', diff: 2, stem: 'stale', options: ['a', 'b', 'c', 'd'], answer: 'A', status: 'pending', verdicts: [], gen: {} }, { fromHuman: false });
  const kept = await db.q('SELECT status FROM questions WHERE id=?', [qid]);
  check('流水线回写不会覆盖人工的 status', kept[0][0].status === 'accepted', 'status=' + kept[0][0].status);
  /* 人工路径必须能改（打回重做依赖它） */
  await Store.saveQuestion(taskId, { id: qid, type: 'mcq', ch: 1, kp: 'x', diff: 2, stem: 'human-edit', options: ['a', 'b', 'c', 'd'], answer: 'A', status: 'rejected', human: { action: 'regen', ts: Date.now() }, verdicts: [], gen: {} }, { fromHuman: true });
  const changed = await db.q('SELECT status, human_json FROM questions WHERE id=?', [qid]);
  check('人工路径（fromHuman）能正常写入', changed[0][0].status === 'rejected');

  section('僵尸任务恢复（服务重启后不再永久卡死）');
  const orphan = { id: Store.id('t'), userId: meRow.id, name: '僵尸任务测试', material: { text: SAMPLE, rawChars: SAMPLE.length, warnings: [] }, requirements: [{ type: 'mcq', count: 1, kp: '', diff: 1, ch: 1 }], costs: { spent: 0, byProfile: {}, calls: 0 }, status: 'running', phase: 'verify', progress: {}, createdAt: Date.now() };
  await Store.createTask(orphan);
  const recovered = await Agent.recoverOrphans();
  const orphanAfter = await Store.loadTask(orphan.id);
  check('启动时把 running 的僵尸任务转为可续跑状态', orphanAfter.status === 'paused_error' && /重启/.test(orphanAfter.error || ''), orphanAfter.status + ' / ' + orphanAfter.error);
  check('恢复数量 > 0', recovered >= 1, 'recovered=' + recovered);

  section('CSRF 与 Origin 校验');
  const evil = await fetch(BASE + '/api/practice/star', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example.com', Cookie: cookies.user }, body: JSON.stringify({ qid: q1.id, starred: true }) });
  check('跨站写请求被拒绝', evil.status === 403, 'status=' + evil.status);
  const sameOk = await api('/api/practice/star', { method: 'POST', body: JSON.stringify({ qid: q1.id, starred: true }) }, 'user');
  check('同源写请求正常放行', sameOk.status === 200);

  section('权限隔离');
  const noAuth = await fetch(BASE + '/api/admin/users');
  check('未登录访问管理接口返回 401', noAuth.status === 401);
  const asUser = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: uname, password: 'test123456' }) });
  check('普通用户登录成功', asUser.status === 200);
  const userAudit = await api('/api/admin/oplogs');
  check('普通用户访问审计接口返回 403', userAudit.status === 403);
  const userRevert = await api('/api/admin/revert', { method: 'POST', body: JSON.stringify({ oplogId: 1 }) });
  check('普通用户不能执行撤回', userRevert.status === 403);

  /* ============ 汇总 ============ */
  console.log('\n' + '='.repeat(56));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  await db.pool.end().catch(() => {});
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('\n测试异常终止：' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
