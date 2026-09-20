/* QuestionForge 多用户控制台
 * 登录/注册 · 对话制题（含上传/知识点/报价闸门） · 资料库 · 任务与人工审核 · 题库练习
 * 个人中心（签到/在线时长/账单/会话） · 管理端（用户/审计与撤回/API池/金标/经验库/配置）
 *
 * 约定：
 *  - 所有业务数据都从后端实时取（视图函数里调用 api()），不依赖内存缓存;
 *  - 一切来自用户或模型的内容在插入 HTML 前必须经过 esc();
 *  - 会写库的按钮统一走 busy() 包裹，避免连点重复提交。
 */
'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
let Me = null;
let State = { view: 'chat', tasks: [], config: null, current: null, events: [], questions: [], poll: null,
  parse: null, vision: null, chat: null, practice: null, kps: null };
const TYPE_CN = { mcq: '选择', solution: '解答', algo: '算法设计', app: '综合应用' };
const TYPE_FULL = { mcq: '单项选择题', solution: '解答题', algo: '算法设计题', app: '综合应用题' };
const DIFF_CN = { 1: '简单', 2: '中等', 3: '困难' };
const STATUS_CN = { draft: '待批准报价', approved: '已批准', running: '运行中', paused_budget: '预算暂停', paused_error: '异常暂停', awaiting_review: '待人工审核', completed: '已完成' };
const OP_CN = {
  register: '注册', login: '登录', recharge: '充值', deduct: '扣费', checkin: '签到', material: '保存资料',
  material_del: '删除资料', task_create: '新建任务', task_approve: '批准报价', budget_add: '追加预算',
  export: '导出题库', review: '审核题目', regen: '打回重做', practice_hide: '隐藏题目', practice_star: '收藏题目',
  kps: '抽取知识点', password: '修改密码', session_revoke: '踢下线', revert_apply: '申请撤回',
  revert_done: '撤回已执行', revert_reject: '撤回被驳回', revert: '执行撤回', grant: '授予管理员',
  role: '角色变更', admin_create: '创建管理员', admin_role: '修改角色', config: '修改配置',
  provider_add: '新增供应商', provider_del: '删除供应商', provider_import: '导入供应商', provider_test: '测试供应商',
  eval: '运行评估', memory: '经验库变更'
};

/* ================= 基础工具 ================= */
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 3200); }
async function api(path, opts) {
  const r = await fetch(path, opts);
  const text = await r.text().catch(() => '');
  let d = null;
  if (text) { try { d = JSON.parse(text); } catch (e) { d = null; } }
  if (r.status === 401) {
    if (path.indexOf('/api/auth/') === 0) throw new Error((d && d.error) || '用户名或密码错误');
    Me = null; renderNav(); render();
    throw new Error('登录状态已失效，请重新登录');
  }
  if (!r.ok) {
    if (d && d.error) throw new Error(d.error);
    if (r.status === 429) throw new Error('操作太频繁，请稍后再试');
    throw new Error('请求失败（HTTP ' + r.status + '）');
  }
  if (d === null && text) throw new Error('服务器返回格式异常（HTTP ' + r.status + '）');
  if (d && d.error) throw new Error(d.error);
  return d;
}
/* 防连点：请求期间禁用按钮并给出加载态 */
async function busy(btn, fn) {
  const el = typeof btn === 'string' ? $(btn) : btn;
  if (el) { if (el.dataset.busy === '1') return; el.dataset.busy = '1'; el.disabled = true; el.dataset.old = el.innerHTML; el.innerHTML = '<span class="spin"></span>处理中…'; }
  try { return await fn(); }
  finally { if (el) { el.disabled = false; el.dataset.busy = ''; if (el.dataset.old != null) { el.innerHTML = el.dataset.old; delete el.dataset.old; } } }
}
function money(n) { n = +(n || 0); return '¥' + (Math.abs(n) < 1 ? n.toFixed(3) : n.toFixed(2)); }
function fmtDur(ms) {
  ms = +(ms || 0);
  if (ms < 60000) return Math.round(ms / 1000) + ' 秒';
  const h = Math.floor(ms / 3600000), m = Math.round((ms % 3600000) / 60000);
  if (h >= 24) return Math.floor(h / 24) + ' 天 ' + (h % 24) + ' 小时';
  return (h ? h + ' 小时 ' : '') + m + ' 分钟';
}
function fmtTime(ts) { return ts ? new Date(Number(ts)).toLocaleString('zh-CN') : '—'; }
function fmtAgo(ts) {
  if (!ts) return '从未';
  const s = Math.round((Date.now() - Number(ts)) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  return Math.floor(s / 86400) + ' 天前';
}

/* ================= 导航 ================= */
const NAV_USER = [
  { id: 'chat', label: '💬 对话制题' },
  { id: 'materials', label: '📂 我的资料库' },
  { id: 'tasks', label: '📋 制题任务' },
  { id: 'practice', label: '📝 我的题库' },
  { id: 'profile', label: '👤 个人中心' }
];
const NAV_ADMIN = [
  { id: 'users', label: '👥 用户管理' },
  { id: 'audit', label: '🛡 审计与撤回' },
  { id: 'pool', label: '🔑 API 池' },
  { id: 'eval', label: '🧪 金标集评估' },
  { id: 'memory', label: '🧠 经验库' },
  { id: 'settings', label: '⚙️ 模型与预算' }
];
function navItems() { return Me && Me.role === 'admin' ? NAV_USER.concat(NAV_ADMIN) : NAV_USER; }
function pendingBadge(id) {
  const n = (State.global && State.global.revertPending) || 0;
  return id === 'audit' && n ? ' <span class="nav-badge">' + n + '</span>' : '';
}
function renderNav() {
  $('#nav').innerHTML = navItems().map(n =>
    `<div class="nav-item ${State.view === n.id || (n.id === 'tasks' && State.view === 'task') ? 'active' : ''}" data-v="${n.id}">${n.label}${pendingBadge(n.id)}</div>`).join('');
  $('#user-chip').innerHTML = Me
    ? `<div class="uc-name">${esc(Me.username)}</div>
       <div class="uc-no">${esc(Me.userNo || '')} · ${Me.role === 'admin' ? '管理员' : '用户'}</div>
       <div class="uc-bal">余额 ${money(Me.balance)}</div>`
    : '';
}
document.addEventListener('click', e => {
  const n = e.target.closest('.nav-item');
  if (!n) return;
  stopPoll();
  State.view = n.dataset.v; State.current = null;
  renderNav();
  navigate(State.view);
});
async function navigate(view) {
  if (Me) { try { await refresh(); } catch (e) { /* 401 已由 api() 处理 */ } }
  render();
}
function stopPoll() { if (State.poll) { clearInterval(State.poll); State.poll = null; } }
async function refresh() {
  try {
    const s = await api('/api/state');
    State.tasks = s.tasks; State.config = s.config; State.global = s;
  } catch (e) { /* 未登录时静默 */ }
  if (!Me) return;
  const me = await api('/api/me').catch(() => null);
  /* 会话失效时 api() 已把 Me 置空，这里必须再判一次，否则会 TypeError */
  if (!Me) return;
  if (me && me.authed) Object.assign(Me, me);
  const ck = Me.checkin || {};
  $('#foot').innerHTML = `${Me.role === 'admin' ? '管理员' : '用户'} · ${esc(Me.userNo || '')} · 余额 ${money(Me.balance)}`
    + (ck.checkedToday ? ` · 已连续签到 ${ck.streak} 天` : '');
  renderNav();
}
function render() {
  renderUserMenu();
  if (!Me) { vLogin(); return; }
  $('#sidebar').style.display = 'flex';
  const fn = { login: vLogin, chat: vChat, materials: vMaterials, tasks: vTasks, task: vTask,
    practice: vPractice, profile: vProfile, audit: vAudit, eval: vEval, memory: vMemory, settings: vSettings, pool: vPool, users: vUsers }[State.view] || vChat;
  try { const r = fn(); if (r && r.catch) r.catch(e => { console.error('视图渲染失败:', e); toast('页面加载失败：' + e.message); }); }
  catch (e) { console.error('视图渲染失败:', e); toast('页面加载失败：' + e.message); }
}

/* ================= 全局后台任务面板 ================= */
let Jobs = [];
const JOB_ICON = { running: '<span class="spin"></span>', done: '✅', error: '⚠️' };
function renderJobs() {
  const panel = $('#jobs-panel');
  if (!panel) return;
  if (!Jobs.length) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  const running = Jobs.filter(j => j.status === 'running').length;
  $('#jobs-count').textContent = running ? (running + ' 个进行中') : (Jobs.length + ' 个最近任务');
  $('#jobs-list').innerHTML = Jobs.map(j => {
    const pct = j.total ? Math.round(100 * (j.done || 0) / j.total) : 0;
    return '<div class="job-item ' + j.status + '">' +
      '<div class="jl">' + (JOB_ICON[j.status] || '') + '<span class="jt">' + esc(j.title) + '</span></div>' +
      (j.detail ? '<div class="jd">' + esc(j.detail) + '</div>' : '') +
      (j.status === 'running' && j.total
        ? '<div class="job-bar"><div style="width:' + pct + '%"></div></div><div class="jd">' + (j.done || 0) + ' / ' + j.total + '（' + pct + '%）</div>'
        : '') +
      (j.status === 'done' && j.detail2 ? '<div class="jd">' + esc(j.detail2) + '</div>' : '') +
      '</div>';
  }).join('');
}
window.toggleJobs = function () { $('#jobs-panel').classList.toggle('collapsed'); };
document.addEventListener('click', e => { if (e.target.closest('#jobs-head')) window.toggleJobs(); });
function addJob(title, detail) {
  const job = { id: 'j' + Date.now() + Math.random().toString(36).slice(2, 6), title, detail, status: 'running', done: 0, total: 0, ts: Date.now() };
  Jobs.unshift(job);
  if (Jobs.length > 8) Jobs.length = 8;
  renderJobs();
  return job;
}
function updateJob(job, patch) { Object.assign(job, patch); renderJobs(); }
function finishJob(job, status, patch) {
  Object.assign(job, patch || {}, { status, endedAt: Date.now() });
  renderJobs();
  setTimeout(() => { if (job.status !== 'running') { Jobs = Jobs.filter(j => j !== job); renderJobs(); } }, 60000);
}

/* ================= 账号菜单 ================= */
function renderUserMenu() {
  const bar = $('#topbar');
  if (!bar) return;
  if (!Me) { bar.style.display = 'none'; document.body.classList.remove('logged-in'); return; }
  bar.style.display = 'block';
  document.body.classList.add('logged-in');
  $('#avatar').textContent = String(Me.username || '?').slice(0, 1).toUpperCase();
  $('#topbar-name').textContent = Me.username;
  const ck = Me.checkin || {};
  $('#menu-head').innerHTML =
    '<div class="mh-name">' + esc(Me.username) + ' <span class="mh-no">' + esc(Me.userNo || '') + '</span></div>' +
    '<div class="mh-sub">' + (Me.role === 'admin' ? '管理员' : '用户') + ' · 余额 ' + money(Me.balance) + '</div>' +
    '<div class="mh-sub">' + (ck.checkedToday ? '✅ 今日已签到（连续 ' + ck.streak + ' 天）' : '⏰ 今日还没签到') + '</div>' +
    (ck.onlineMs ? '<div class="mh-sub">累计在线 ' + fmtDur(ck.onlineMs) + '</div>' : '');
}
function toggleMenu(force) {
  const m = $('#user-menu');
  if (!m) return;
  const open = force !== undefined ? force : !m.classList.contains('open');
  m.classList.toggle('open', open);
}
document.addEventListener('click', e => {
  if (e.target.closest('#user-btn')) { toggleMenu(); return; }
  if (!e.target.closest('#user-menu')) toggleMenu(false);
  const item = e.target.closest('.menu-item');
  if (!item) return;
  toggleMenu(false);
  const act = item.dataset.act;
  if (act === 'profile') { stopPoll(); State.view = 'profile'; State.current = null; renderNav(); navigate('profile'); }
  else if (act === 'checkin') doCheckin();
  else if (act === 'logout') doLogout(false);
  else if (act === 'switch') doLogout(true);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') toggleMenu(false); });

function resetClientState() {
  Me = null;
  stopPoll();
  State.tasks = []; State.current = null; State.questions = []; State.events = [];
  State.global = null; State.matList = null; State.matListAt = 0; State.parse = null; State.vision = null;
  State.chat = null; State.practice = null; State.pendingTask = null; State.quoteText = null;
  State.kps = null; State.pTab = 'practice'; State.pQueue = null; State.pIdx = 0;
  State.pDrafts = {}; State.pFilter = null; State.pCounts = null;
  State.usersMe = null; State.audit = null; State.profile = null;
  State.view = 'chat';
  Jobs = []; renderJobs();
}
window.doLogout = async function (switchAccount) {
  const runningTask = State.current && ['running', 'approved'].includes(State.current.status);
  if (!switchAccount && runningTask) {
    if (!confirm('有任务正在运行。退出后任务会在服务器继续跑，下次登录仍可查看进度。确定退出？')) return;
  }
  try {
    await api('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  } catch (e) { /* 会话可能已过期，仍继续本地登出 */ }
  resetClientState();
  renderUserMenu(); renderNav(); render();
  toast(switchAccount ? '已退出，请用其他账号登录' : '已退出登录');
  if (switchAccount) setTimeout(() => { const u = $('#li-user'); if (u) u.focus(); }, 150);
};
window.confirmLogout = function () { return doLogout(false); };
window.doCheckin = async function (btn) {
  return busy(btn, async () => {
    try {
      const d = await api('/api/checkin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      Me.checkin = d;
      toast(d.fresh ? '签到成功！连续 ' + d.streak + ' 天，累计 ' + d.totalDays + ' 天' : '今天已经签过到啦（连续 ' + d.streak + ' 天）');
      renderUserMenu();
      if (State.view === 'profile') vProfile();
    } catch (e) { toast(e.message); }
  });
};

/* ================= 登录 / 注册 ================= */
function vLogin() {
  $('#sidebar').style.display = 'none';
  $('#view').innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <div class="login-brand">QuestionForge</div>
        <div class="login-sub">智能制题平台 · 资料变题库，AI 交叉质检</div>
        <div class="tabs"><span class="tab active" id="tab-login">登录</span><span class="tab" id="tab-reg">注册</span></div>
        <div class="field"><label>用户名</label><input type="text" id="li-user" placeholder="2-20位：中文/字母/数字/下划线"></div>
        <div class="field"><label>密码</label><input type="password" id="li-pwd" placeholder="至少 6 位"></div>
        <div class="field" id="li-pwd2-wrap" style="display:none"><label>确认密码</label><input type="password" id="li-pwd2"></div>
        <button class="btn wide" id="li-btn">登录</button>
        <div class="hint" id="li-msg" style="margin-top:10px"></div>
        <div class="hint" style="margin-top:14px;line-height:1.7">注册即送体验金，可在「个人中心」充值。<br>账号/密码经加盐散列存储，会话走 HttpOnly Cookie。</div>
      </div>
    </div>`;
  let mode = 'login';
  $('#tab-login').onclick = () => { mode = 'login'; $('#tab-login').classList.add('active'); $('#tab-reg').classList.remove('active'); $('#li-pwd2-wrap').style.display = 'none'; $('#li-btn').textContent = '登录'; };
  $('#tab-reg').onclick = () => { mode = 'register'; $('#tab-reg').classList.add('active'); $('#tab-login').classList.remove('active'); $('#li-pwd2-wrap').style.display = 'block'; $('#li-btn').textContent = '注册并登录'; };
  $('#li-btn').onclick = () => busy('#li-btn', async () => {
    const username = $('#li-user').value.trim(), password = $('#li-pwd').value;
    $('#li-msg').textContent = '';
    try {
      if (mode === 'register' && password !== $('#li-pwd2').value) throw new Error('两次密码不一致');
      const d = await api('/api/auth/' + mode, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      await boot(); renderUserMenu(); renderNav(); render();
      toast('欢迎，' + username + (d.userNo ? '（用户号 ' + d.userNo + '）' : ''));
    } catch (e) { $('#li-msg').textContent = e.message; }
  });
  $('#li-pwd').addEventListener('keydown', e => { if (e.key === 'Enter') $('#li-btn').click(); });
}

/* ================= 资料选择器 + 知识点面板（两个制题页共用） ================= */
/* 资料库列表缓存：默认 30 秒内复用，避免每次渲染都请求；
 * 带 TTL 是为了让"在另一个标签页新上传的资料"能自动出现，而不是一直用旧缓存。 */
const MAT_TTL = 30000;
async function loadMaterialList(force) {
  const fresh = State.matList && (Date.now() - (State.matListAt || 0) < MAT_TTL);
  if (!force && fresh) return State.matList;
  try { State.matList = await api('/api/materials'); } catch (e) { State.matList = State.matList || []; }
  State.matListAt = Date.now();
  return State.matList;
}
function matPickerHtml(sel, idPrefix) {
  const list = State.matList || [];
  const opts = list.map(m => `<option value="${esc(m.id)}" ${sel && sel.id === m.id ? 'selected' : ''}>${esc(m.name)}（${m.chars}字${m.figure_count ? '，' + m.figure_count + '图' : ''}）</option>`).join('');
  return `
    <div class="mat-picker">
      <div class="filter-row" style="align-items:center">
        <span class="hint strong">资料选择：</span>
        <select id="${idPrefix}-pick" style="min-width:260px">
          <option value="">✍️ 手动输入 / 上传文件</option>
          ${opts}
        </select>
        <button class="btn sm gray" onclick="nav('materials')">管理资料库（${list.length}）</button>
        ${sel && sel.id ? `<button class="btn sm ghost" onclick="previewMat('${esc(sel.id)}','${idPrefix}')">查看内容</button>` : ''}
      </div>
      ${sel && sel.id ? `<div class="note-box" style="margin-top:8px">
        <b>已选用资料库：《${esc(sel.name)}》</b> — ${sel.chars} 字${sel.figure_count ? '，含 ' + sel.figure_count + ' 张图（出题时可引用，导出时原图内嵌）' : ''}
      </div>` : ''}
      <div id="${idPrefix}-preview"></div>
    </div>`;
}
function bindMatPicker(sel, idPrefix, onPick) {
  const el = document.getElementById(idPrefix + '-pick');
  if (!el) return;
  el.addEventListener('change', () => {
    const id = el.value;
    if (!id) { onPick(null); return; }
    const m = (State.matList || []).find(x => x.id === id);
    onPick(m ? { id: m.id, name: m.name, chars: m.chars, figure_count: m.figure_count } : null);
  });
}
/* 知识点面板：AI 先看懂资料里有哪些知识点，用户勾选后再出题 */
function kpPanelHtml(idPrefix) {
  const st = State.kps && State.kps[idPrefix];
  if (!st) {
    return `<div class="kp-panel">
      <div class="filter-row">
        <span class="hint strong">🧩 知识点</span>
        <span class="hint">还没分析这份资料的知识点</span>
        <button class="btn sm ghost" onclick="analyzeKPs('${idPrefix}')">🤖 让 AI 先分析知识点</button>
      </div>
      <div class="hint">分析后可以按知识点分别出题（例如"每个知识点各出 2 道"），AI 出题时会对着这些考点取材。</div>
    </div>`;
  }
  if (st.loading) return `<div class="kp-panel"><div class="hint"><span class="spin"></span>AI 正在通读资料、梳理知识点…</div></div>`;
  if (st.error) return `<div class="kp-panel"><div class="warn-box">知识点分析失败：${esc(st.error)}</div>
    <button class="btn sm ghost" onclick="analyzeKPs('${idPrefix}')">重试</button></div>`;
  const list = st.list || [];
  if (!list.length) return `<div class="kp-panel"><div class="hint">这份资料里没有识别出明确的知识点，可直接用一句话描述需求。</div></div>`;
  const picked = st.picked instanceof Set ? st.picked : new Set(list.map(k => k.name));
  st.picked = picked;
  return `<div class="kp-panel">
    <div class="filter-row">
      <span class="hint strong">🧩 知识点（${list.length} 个，来源：${st.source === 'ai' ? 'AI 通读资料' : st.source === 'mock' ? '演示数据' : '规则解析'}）</span>
      <button class="btn sm ghost" onclick="kpSelectAll('${idPrefix}',true)">全选</button>
      <button class="btn sm ghost" onclick="kpSelectAll('${idPrefix}',false)">清空</button>
      <button class="btn sm gray" onclick="analyzeKPs('${idPrefix}',true)">重新分析</button>
      <span class="hint">已选 <b id="${idPrefix}-kp-n">${picked.size}</b> 个</span>
    </div>
    <div class="kp-list">${list.map(k => `
      <label class="kp-chip ${picked.has(k.name) ? 'on' : ''}" data-kp="${esc(k.name)}">
        <input type="checkbox" ${picked.has(k.name) ? 'checked' : ''} onchange="kpToggle('${idPrefix}', this)">
        <span class="kp-name">${esc(k.name)}</span>
        <span class="kp-meta">第${k.ch || 1}章${k.weight >= 4 ? ' · 重点' : ''}</span>
        ${k.detail ? `<span class="kp-detail">${esc(k.detail)}</span>` : ''}
      </label>`).join('')}</div>
    <div class="kp-actions">
      <span class="hint">按知识点批量出题：每个知识点各出</span>
      <input type="number" id="${idPrefix}-kp-count" value="2" min="1" max="20" style="width:70px">
      <select id="${idPrefix}-kp-type" style="width:auto">
        <option value="all">所有题型</option>
        <option value="mcq">选择题</option><option value="solution">解答题</option>
        <option value="algo">算法设计题</option><option value="app">综合应用题</option>
      </select>
      <select id="${idPrefix}-kp-diff" style="width:auto"><option value="1">基础</option><option value="2" selected>强化</option><option value="3">冲刺</option></select>
      <button class="btn sm" onclick="applyKPsToReqs('${idPrefix}')">生成需求</button>
      <span class="hint">（会按所选知识点逐条生成制题需求）</span>
    </div>
  </div>`;
}
window.analyzeKPs = async function (idPrefix, force) {
  const sel = (State.chat && State.chat.material) || null;
  const text = (($('#c-text') || {}).value || '').trim();
  if (!sel && text.length < 20) { toast('请先选择资料库里的资料、上传文件，或粘贴至少 20 字的资料内容'); return; }
  State.kps = State.kps || {};
  State.kps[idPrefix] = { loading: true };
  const rerender = () => vChat();
  rerender();
  try {
    const payload = sel ? { materialId: sel.id, force: !!force } : { text };
    const d = await api('/api/kps/extract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    State.kps[idPrefix] = { list: d.kps || [], source: d.source, error: d.warning || null, picked: new Set((d.kps || []).map(k => k.name)) };
    if (State.chat && idPrefix === 'chat') State.chat.kps = d.kps || [];
    toast('识别出 ' + (d.kps || []).length + ' 个知识点');
  } catch (e) {
    State.kps[idPrefix] = { list: [], source: '', error: e.message };
  }
  rerender();
};
window.kpToggle = function (idPrefix, el) {
  const st = State.kps[idPrefix]; if (!st) return;
  const name = el.closest('.kp-chip').dataset.kp;
  if (el.checked) st.picked.add(name); else st.picked.delete(name);
  el.closest('.kp-chip').classList.toggle('on', el.checked);
  const n = $('#' + idPrefix + '-kp-n'); if (n) n.textContent = st.picked.size;
};
window.kpSelectAll = function (idPrefix, on) {
  const st = State.kps[idPrefix]; if (!st) return;
  st.picked = new Set(on ? (st.list || []).map(k => k.name) : []);
  vChat();
};
/* 把选中的知识点展开成需求描述（走对话制题的解析链路） */
window.applyKPsToReqs = function (idPrefix) {
  const st = State.kps[idPrefix]; if (!st || !st.list) return;
  const per = +($('#' + idPrefix + '-kp-count') || {}).value || 2;
  const typeRaw = ($('#' + idPrefix + '-kp-type') || {}).value || 'mcq';
  const diff = +($('#' + idPrefix + '-kp-diff') || {}).value || 2;
  const sel = st.list.filter(k => st.picked.has(k.name));
  if (!sel.length) { toast('请至少勾选一个知识点'); return; }
  const all = sel.length === st.list.length;
  /* 把表单选择写成一句自然语言，再走完整解析链路（后端会翻译成逐知识点需求）。
   * 勾满与只勾一部分是两种语义，句子里要写清楚，别混。 */
  const typePart = typeRaw === 'all' ? '，所有题型各出 ' + per + ' 道' : '，每个知识点各出 ' + per + ' 道' + TYPE_CN[typeRaw] + '题';
  const t = (all ? '覆盖全部知识点' : '只考这些知识点：' + sel.map(k => k.name).join('、')) + typePart + '，难度' + DIFF_CN[diff];
  const box = $('#c-req'); if (box) box.value = t;
  State.chat = Object.assign({}, State.chat, { req: t, kps: sel, coverageStrict: all });
  const coverBox = $('#c-coverall'); if (coverBox) coverBox.checked = all;
  toast('已生成需求描述（' + (all ? '覆盖全部知识点' : '只考勾选的 ' + sel.length + ' 个') + '），点「解析需求并估算费用」继续');
};
window.previewMat = async function (id, idPrefix) {
  const box = document.getElementById(idPrefix + '-preview');
  if (!box) return;
  box.innerHTML = '<div class="hint"><span class="spin"></span>加载中…</div>';
  try {
    const mat = await api('/api/materials/' + id);
    const figs = await api('/api/materials/' + id + '/figures');
    box.innerHTML = `<div class="card" style="margin-top:8px;background:var(--bg-soft)">
      <div class="hint" style="margin-bottom:6px">${mat.chars} 字 ｜ ${figs.length} 张图${figs.filter(f => f.desc).length ? '（已识图 ' + figs.filter(f => f.desc).length + ' 张）' : '（未识图）'}</div>
      ${figs.length ? `<div class="filter-row" style="margin-bottom:8px">${figs.slice(0, 8).map(f => `<span class="badge b-gray" title="${esc((f.desc || '').slice(0, 100))}">${esc(f.id)}</span>`).join('')}${figs.length > 8 ? '<span class="hint">…共 ' + figs.length + ' 张</span>' : ''}</div>` : ''}
      <pre class="quote-pre" style="max-height:200px;overflow-y:auto">${esc(mat.text.slice(0, 1200))}${mat.text.length > 1200 ? '\n…（共 ' + mat.chars + ' 字）' : ''}</pre>
    </div>`;
  } catch (e) { box.innerHTML = `<div class="warn-box">${esc(e.message)}</div>`; }
};

/* ================= 对话制题 ================= */
async function vChat() {
  await loadMaterialList();
  const c = State.chat || {};
  const sel = c.material || null;
  $('#view').innerHTML = `
    <h1 class="page">对话制题</h1>
    <div class="page-sub">选一份资料 → 让 AI 先梳理知识点 → 用一句话说清需求 → 确认费用 → 自动制题</div>
    <div class="card">
      <h3>1 · 选择资料</h3>
      ${matPickerHtml(sel, 'chat')}
      ${!sel ? `<div class="field" style="margin-top:10px"><label>资料内容（粘贴文本）</label>
        <textarea id="c-text" rows="8" placeholder="粘贴资料内容…&#10;（也可以先到「我的资料库」上传 PDF/Word，之后在这里直接选用）">${esc(c.text || '')}</textarea></div>` : ''}
    </div>
    <div class="card">
      <h3>2 · 或者直接上传文件（可选）</h3>
      <div class="hint">支持 PDF / Word / txt。上传后本地解析（扫描页走 OCR、含图形的页自动抽图），需要时再交视觉模型识图，确认无误后一键存进资料库并选中。</div>
      <div class="filter-row" style="margin-top:8px">
        <input type="file" id="c-file" accept=".pdf,.docx,.txt,.md">
        <span id="c-parse" class="hint"></span>
      </div>
      <div id="c-figs"></div>
    </div>
    <div class="card">
      <h3>3 · 知识点（AI 先看懂资料，再据此出题）</h3>
      ${kpPanelHtml('chat')}
    </div>
    <div class="card">
      <h3>4 · 用自然语言说清你的需求</h3>
      <div class="kp-link">${kpLinkHtml('chat')}</div>
      <textarea id="c-req" rows="4" placeholder="例1：这些知识点所有题型都各出一道题，并且要覆盖全部知识点。&#10;例2：每个知识点各出 2 道选择题，中等难度，不要出计算题，解析要详细。&#10;例3：第 2 章出 10 道选择题，重点考循环队列。">${esc(c.req || '')}</textarea>
      <div class="btn-row">
        <span class="hint strong">快捷说法：</span>
        <span class="chip" onclick="chatQuick('覆盖全部知识点')">覆盖全部知识点</span>
        <span class="chip" onclick="chatQuick('所有题型各出一道题')">所有题型各一道</span>
        <span class="chip" onclick="chatQuick('每个知识点各出 2 道')">每个知识点各 2 道</span>
        <span class="chip" onclick="chatQuick('不要出计算题，解析要详细')">不要计算题·要详细解析</span>
      </div>
      <div class="field" style="margin-top:12px">
        <label>额外要求（可选，一行一条，会逐条注入出题提示词）</label>
        <textarea id="c-constraints" rows="2" placeholder="例如：不要出纯计算题&#10;解析要给出常见错误提示">${esc((c.constraints || []).join('\n'))}</textarea>
      </div>
      <label class="row-check" style="margin-top:4px">
        <input type="checkbox" id="c-coverall" ${c.coverageStrict ? 'checked' : ''}>
        <span>必须覆盖选中的全部知识点（跑完自动检查，缺哪个考点就自动补题）</span>
      </label>
      <div class="filter-row" style="margin-top:10px">
        <label class="lbl">任务名（可选）</label>
        <input type="text" id="c-name" value="${esc(c.name || '')}" placeholder="留空则由 AI 按资料和需求命名" style="width:260px">
      </div>
      <div class="btn-row"><button class="btn" onclick="chatParse(this)">🧮 解析需求并估算费用</button>
        <span class="hint">上面的知识点栏勾了什么，这里就按什么出题；没写需求时默认 5 道选择题</span></div>
    </div>
    <div id="c-out"></div>`;
  bindMatPicker(sel, 'chat', m => { State.chat = Object.assign({}, State.chat, { material: m }); State.kps = State.kps || {}; State.kps.chat = null; vChat(); });
  $('#c-file').addEventListener('change', e => { const f = e.target.files[0]; if (f) window.chatUpload(f); });
}
/* 知识点栏 ↔ 自然语言栏的连接提示：告诉用户"上面勾的知识点，就是这里要覆盖的范围" */
function kpLinkHtml(idPrefix) {
  const st = (State.kps || {})[idPrefix];
  if (!st || !st.list || !st.list.length) {
    return '<span class="hint">还没有分析知识点 —— 在上面点「让 AI 先分析知识点」之后，就能直接说"覆盖全部知识点""所有题型各一道"这类话，AI 也才有一个明确的考点范围可依据。</span>';
  }
  const picked = st.picked instanceof Set ? st.picked : new Set(st.list.map(k => k.name));
  const total = st.list.length, n = picked.size;
  const names = st.list.filter(k => picked.has(k.name)).map(k => k.name);
  return '<span class="badge b-purple">知识点栏已勾选 ' + n + '/' + total + ' 个</span>' +
    '<span class="hint">出题范围以这 ' + n + ' 个为准' +
    (n && n <= 8 ? '：' + esc(names.join('、')) : (n > 8 ? '（如 ' + esc(names.slice(0, 5).join('、')) + ' 等）' : '')) +
    '；也可以直接说“覆盖全部知识点”“所有题型各一道”，我来翻译成制题命令。</span>';
}
/* 快捷说法：把常用句式追加进需求框，省得用户不知道能怎么说 */
window.chatQuick = function (phrase) {
  const box = $('#c-req');
  if (!box) return;
  const cur = box.value.trim().replace(/[，,。；;]$/, '');
  box.value = cur ? (cur + '，' + phrase) : phrase;
  State.chat = Object.assign({}, State.chat, { req: box.value });
  box.focus();
  toast('已加入需求描述，点「解析需求并估算费用」查看翻译结果');
};
/* ===== 对话制题页内的资料上传：解析 →（可选）识图 → 存进资料库并选中 =====
 * 这块能力原来在「精确制题」页；该页合并过来后必须保留，否则用户就少了一条"从文件开始"的路。
 * 上传/解析/识图都在服务端跑（见右下角任务面板），中途切页面不会中断。 */
window.chatUpload = async function (file) {
  if (!file) return;
  const job = addJob('上传资料：' + file.name, '解析中…');
  const setStatus = html => { const el = $('#c-parse'); if (el) el.innerHTML = html; };
  setStatus('<span class="spin"></span>解析中（见右下角任务面板）…');
  try {
    const buf = await file.arrayBuffer();
    const r = await fetch('/api/parse?name=' + encodeURIComponent(file.name), { method: 'POST', body: buf });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error);
    State.parse = d; State.vision = null;
    finishJob(job, 'done', { detail2: '解析完成：' + d.chars + ' 字，' + (d.images || []).length + ' 张图' });
    setStatus('<span style="color:var(--ok)">✓ 已解析 ' + d.chars + ' 字，抽出 ' + (d.images || []).length + ' 张图</span>');
    renderChatFigs();
    /* 没有图就直接入库；有图则等用户在下面选"识别/跳过"——识图要花钱，不替用户决定 */
    if (!(d.images || []).length) await saveChatMaterial(job, d.name || file.name);
  } catch (err) {
    finishJob(job, 'error', { detail: err.message });
    setStatus('<span style="color:var(--bad)">✗ ' + esc(err.message) + '</span>');
  }
};
function renderChatFigs() {
  const d = State.parse;
  const box = $('#c-figs');
  if (!box) return;
  if (!d || !(d.images || []).length) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="note-box" style="margin-top:10px"><b>检测到 ' + d.images.length + ' 张图片</b>。树形图/矩阵/排序过程这类图形的信息在结构里，OCR 读不出，需要视觉模型读懂成文字；也可以跳过。</div>' +
    '<div class="btn-row"><button class="btn" onclick="chatVision(this,0)">🔍 识别全部图片并入库</button>' +
    '<button class="btn ghost" onclick="chatVision(this,8)">只识别前 8 张（省费用）</button>' +
    '<button class="btn gray" onclick="chatSkipVision(this)">跳过识图，直接入库</button></div>';
}
window.chatVision = async function (btn, limit) {
  if (!State.parse) { toast('请先上传文件'); return; }
  return busy(btn, async () => {
    const job = addJob('识别资料图片', '启动中…');
    try {
      const started = await api('/api/vision/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parseId: State.parse.parseId, limit: limit || 0 }) });
      updateJob(job, { total: started.total, detail: '逐张识别中（可离开此页面）' });
      const vres = await pollVisionJob(started.jobId, p => updateJob(job, { done: p.done, total: p.total }));
      const descs = {};
      (vres.results || []).forEach(r => { descs[r.id] = r.desc; });
      State.vision = { results: descs, cost: vres.cost };
      updateJob(job, { detail: '识图完成 ' + vres.total + ' 张，花费 ¥' + vres.cost + (vres.failed ? '，失败 ' + vres.failed + ' 张' : '') });
      await saveChatMaterial(job, State.parse.name || '上传资料');
    } catch (e) {
      finishJob(job, 'error', { detail: e.message });
      toast('识图失败：' + e.message);
    }
  });
};
window.chatSkipVision = async function (btn) {
  return busy(btn, async () => { await saveChatMaterial(null, (State.parse && State.parse.name) || '上传资料'); });
};
/* 把解析结果（含识图描述）存进资料库并自动选中，用户接着就能分析知识点 */
async function saveChatMaterial(job, wantName) {
  const d = State.parse;
  if (!d) return;
  const setStatus = html => { const el = $('#c-parse'); if (el) el.innerHTML = html; };
  try {
    const name = String(wantName || '上传资料').replace(/[.][a-z0-9]+$/i, '');
    await api('/api/materials', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, text: d.text, parseId: d.parseId, figureDescs: (State.vision && State.vision.results) || {} }) });
    await loadMaterialList(true);
    const saved = (State.matList || []).find(m => m.name === name) || (State.matList || [])[0];
    State.parse = null; State.vision = null;
    if (job) finishJob(job, 'done', { detail2: '资料「' + name + '」已入库并选中' });
    setStatus('<span style="color:var(--ok)">✓ 已入库并选中「' + esc(name) + '」</span>');
    State.chat = Object.assign({}, State.chat, {
      material: saved ? { id: saved.id, name: saved.name, chars: saved.chars, figure_count: saved.figure_count } : null
    });
    State.kps = State.kps || {}; State.kps.chat = null;
    toast('资料已入库并选中，接着分析知识点或用一句话说需求');
    vChat();
  } catch (e) {
    if (job) finishJob(job, 'error', { detail: e.message });
    setStatus('<span style="color:var(--bad)">✗ ' + esc(e.message) + '</span>');
    toast('入库失败：' + e.message);
  }
}

window.chatParse = async function (btn) {
  return busy(btn, async () => {
    const sel = (State.chat && State.chat.material) || null;
    const text = ($('#c-text') || {}).value ? $('#c-text').value.trim() : '';
    const req = ($('#c-req') || {}).value ? $('#c-req').value.trim() : '';
    if (!sel && text.length < 10) { toast('请粘贴资料内容，或从上方选择一个资料库资料'); return; }
    if (sel && !req) { toast('已选资料，请写一句出题需求（或用「生成需求」按钮）'); return; }
    /* 额外要求 / 覆盖全部知识点 / 任务名也从表单读走，随解析结果一起带去确认步骤 */
    const cExtra = ($('#c-constraints') && $('#c-constraints').value) ? $('#c-constraints').value.split('\n').map(x => x.trim()).filter(Boolean) : [];
    const cCover = !!($('#c-coverall') && $('#c-coverall').checked);
    const cName = (($('#c-name') || {}).value || '').trim();
    State.chat = Object.assign({}, State.chat, { text, req, material: sel, constraints: cExtra, coverageStrict: cCover, name: cName });
    $('#c-out').innerHTML = '<div class="card"><div class="hint"><span class="spin"></span>AI 正在理解你的需求…</div></div>';
    try {
      const payload = { requirementText: req || text };
      if (sel) payload.materialId = sel.id; else payload.materialText = text;
      /* 只把用户勾选的知识点交给后端（不勾就是全部）—— 这就是"知识点栏与自然语言栏相通"：
       * 自然语言说"覆盖全部知识点"时，覆盖的就是上面勾出来的那一批。 */
      const st = State.kps && State.kps.chat;
      if (st && st.picked && st.list) {
        payload.kps = st.list.filter(k => st.picked.has(k.name));
        payload.coverageStrict = payload.kps.length > 0 && payload.kps.length === st.list.length;
      }
      const d = await api('/api/chat/parse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      State.chat.parsed = d.parsed; State.chat.est = d.est; State.chat.quoteText = d.quoteText;
      State.chat.balance = d.balance; State.chat.materialInfo = d.materialInfo; State.chat.kps = d.kps || [];
      /* 把 AI 的"翻译结果"摊开给用户确认：题型（可能多种）、覆盖范围、额外要求 */
      const typeLabelOf = r => ((r.types && r.types.length) ? r.types : [r.type]).map(t => TYPE_CN[t] || t).join(' + ');
      const reqRows = d.parsed.requirements.map(r => `<tr><td>${esc(typeLabelOf(r))}</td><td>${r.count}</td><td>${esc(r.kp || '—')}</td><td>${DIFF_CN[r.diff]}</td><td>第${r.ch}章</td></tr>`).join('');
      const totalQ = (d.parsed.totals && d.parsed.totals.total) || d.parsed.requirements.reduce((a, r) => a + r.count, 0);
      const cov = d.parsed.coverage || {};
      const byType = d.parsed.byType || {};
      const cons = d.parsed.constraints || [];
      const covLine = cov.mode === 'all' ? '<span class="badge b-purple">覆盖全部知识点</span>'
        : cov.mode === 'listed' ? '<span class="badge b-blue">只考点名的知识点</span>' : '';
      const typeLine = Object.keys(byType).length
        ? '<span class="badge b-cyan">' + Object.keys(byType).map(t => (TYPE_CN[t] || t) + ' ' + byType[t] + ' 道').join(' · ') + '</span>' : '';
      $('#c-out').innerHTML = `
        <div class="card"><h3>✅ AI 把你的话翻译成了这些制题命令（共 ${totalQ} 题）</h3>
          <div class="hint" style="margin-bottom:8px">任务名：<b>${esc(d.parsed.name)}</b>${d.parsed.subjectName ? ' · 科目：' + esc(d.parsed.subjectName) : ''}
            ${d.materialInfo ? ' · 资料来源：资料库《' + esc(d.materialInfo.name) + '》' + (d.materialInfo.figures ? '（含 ' + d.materialInfo.figures + ' 张图）' : '') : ' · 资料来源：手动粘贴'}</div>
          <div class="filter-row" style="margin-bottom:8px">
            ${covLine}${typeLine}
            ${d.parsed.perKP ? '<span class="badge b-purple">逐知识点出题</span>' : ''}
            ${cons.length ? '<span class="badge b-yellow">额外要求 ' + cons.length + ' 条</span>' : '<span class="badge b-gray">无额外要求</span>'}
          </div>
          ${d.parsed.understood ? '<div class="note-box">AI 复述：' + esc(d.parsed.understood) + '</div>' : ''}
          ${cons.length ? '<div class="note-box"><b>出题时会逐条满足的额外要求：</b><br>' + cons.map(c => '· ' + esc(c)).join('<br>') + '</div>' : ''}
          ${d.parsed.fallbackReason ? '<div class="warn-box">模型解析不可用，已用本地规则解析（' + esc(d.parsed.fallbackReason) + '）</div>' : ''}
          <div class="scroll-y" style="max-height:260px"><table class="tbl"><tr><th>题型（多种题型=每种各这么多）</th><th>每题型数量</th><th>考点</th><th>难度</th><th>章节</th></tr>${reqRows}</table></div>
          ${d.warnings && d.warnings.length ? `<div class="warn-box" style="margin-top:8px">${d.warnings.map(esc).join('<br>')}</div>` : ''}
          <div class="btn-row"><button class="btn sm gray" onclick="chatReset()">← 重新描述</button></div>
        </div>
        <div class="card"><h3>💰 费用预估</h3>
          <table class="tbl"><tr><th>环节</th><th>模型</th><th>tokens(入/出)</th><th>费用</th></tr>
          ${d.est.lines.map(l => `<tr><td>${esc(l.role)}</td><td>${esc(l.profile)}</td><td>${l.tokensIn} / ${l.tokensOut}</td><td>${money(l.cost)}</td></tr>`).join('')}
          <tr><td colspan="3"><b>预估总成本 × 重试系数 ${(d.est.retryFactor).toFixed(2)}</b></td><td><b>${money(d.est.total)}</b></td></tr></table>
          <div class="btn-row">
            <span class="badge b-blue">当前余额 ${money(d.balance)}</span>
            <button class="btn" onclick="chatConfirm(this,false)">✓ 确认费用，开始制题</button>
            <button class="btn ghost" onclick="chatConfirm(this,true)">🕒 先存为待批准任务</button>
            <button class="btn ghost" onclick="copyQuote()">复制报价单</button>
          </div>
          <pre class="quote-pre" id="quote-pre">${esc(d.quoteText)}</pre>
        </div>`;
    } catch (e) { $('#c-out').innerHTML = `<div class="warn-box">${esc(e.message)}</div>`; }
  });
};
window.chatReset = function () { State.chat = { material: (State.chat && State.chat.material) || null, text: (State.chat && State.chat.text) || '', req: (State.chat && State.chat.req) || '', constraints: (State.chat && State.chat.constraints) || [], coverageStrict: !!(State.chat && State.chat.coverageStrict), name: (State.chat && State.chat.name) || '' }; vChat(); };
window.chatConfirm = async function (btn, defer) {
  return busy(btn, async () => {
    try {
      const sel = State.chat.material;
      const payload = { parsed: State.chat.parsed };
      if (sel) payload.materialId = sel.id; else payload.materialText = State.chat.text;
      const st = State.kps && State.kps.chat;
      if (st && st.picked && st.list) {
        payload.kps = st.list.filter(k => st.picked.has(k.name));
        payload.coverageStrict = payload.kps.length > 0 && payload.kps.length === st.list.length;
      }
      /* 表单里写的额外要求 / 任务名 / 是否只存草稿 */
      payload.constraints = (State.chat.constraints || []).slice(0, 8);
      payload.name = State.chat.name || '';
      payload.defer = !!defer;
      const d = await api('/api/chat/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      toast(defer ? '已存为待批准任务，到「制题任务」里批准后才会启动' : '任务已创建并启动');
      State.chat = Object.assign({}, State.chat, { constraints: [], name: '' });
      stopPoll(); State.view = 'task'; State.current = null;
      await refresh();
      await openTask(d.taskId);
    } catch (e) { toast(e.message); }
  });
};
window.copyQuote = function () {
  const t = $('#quote-pre') ? $('#quote-pre').textContent : '';
  navigator.clipboard.writeText(t).then(() => toast('报价单已复制')).catch(() => toast('复制失败，请手动选择'));
};

/* ================= 资料库 ================= */
async function vMaterials() {
  $('#view').innerHTML = `<h1 class="page">我的资料库</h1>
    <div class="page-sub">上传过的资料与图片全部持久保存在数据库，任何时候回来都能用；删除后也可在「个人中心 → 操作记录」申请撤回恢复</div>
    <div class="card"><h3>上传新资料</h3>
      <div class="filter-row">
        <input type="file" id="m-file" accept=".pdf,.docx,.txt,.md" style="font-size:13px">
        <input type="text" id="m-name" placeholder="资料名称（可选，默认用文件名）" style="width:220px">
      </div>
      <div id="m-status" class="hint" style="margin-top:8px"></div>
      <div id="m-preview"></div>
    </div>
    <div class="card"><h3>已保存的资料</h3><div id="m-list" class="hint">加载中…</div></div>`;
  const list = await api('/api/materials');
  $('#m-list').innerHTML = list.length ? `<table class="tbl"><tr><th>名称</th><th>类型</th><th>规模</th><th>图片</th><th>保存时间</th><th></th></tr>
    ${list.map(m => `<tr><td><b>${esc(m.name)}</b></td><td>${esc(m.kind || '')}</td><td>${m.chars} 字${m.pages ? ' / ' + m.pages + '页' : ''}</td><td>${m.figure_count || 0} 张</td><td>${fmtTime(m.created_at)}</td>
    <td class="nowrap"><button class="btn sm ghost" onclick="viewMat('${m.id}')">查看</button> <button class="btn sm gray" onclick="useMat('${m.id}')">用于制题</button> <button class="btn sm danger" onclick="delMat(this,'${m.id}')">删</button></td></tr>`).join('')}</table>`
    : '<div class="empty">还没有资料，上传一个试试</div>';
  $('#m-file').addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    const wantName = $('#m-name').value.trim() || f.name;
    uploadMaterialJob(f, wantName);
  });
}
async function uploadMaterialJob(file, wantName) {
  const job = addJob('上传资料：' + wantName, '读取文件中…');
  const setStatus = html => { const el = $('#m-status'); if (el) el.innerHTML = html; };
  try {
    setStatus('<span class="spin"></span>解析中（见右下角任务面板）…');
    const buf = await file.arrayBuffer();
    const r = await fetch('/api/parse?name=' + encodeURIComponent(file.name), { method: 'POST', body: buf });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error);
    updateJob(job, { detail: '解析完成：' + d.chars + ' 字 / ' + (d.images || []).length + ' 张图' });
    setStatus('<span class="spin"></span>已解析，正在保存…');
    let figDescs = {};
    if (d.images && d.images.length) {
      updateJob(job, { total: d.images.length, done: 0, detail: '视觉模型识别中（可离开此页面）' });
      try {
        const started = await api('/api/vision/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parseId: d.parseId }) });
        const vres = await pollVisionJob(started.jobId, p => updateJob(job, { done: p.done, total: p.total }));
        vres.results.forEach(rr => { figDescs[rr.id] = rr.desc; });
        updateJob(job, { detail: '识图完成 ' + vres.total + ' 张，花费 ¥' + vres.cost + (vres.failed ? '，失败 ' + vres.failed + ' 张' : '') });
      } catch (ve) {
        updateJob(job, { detail: '识图跳过：' + ve.message });
      }
    }
    await api('/api/materials', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: wantName, text: d.text, parseId: d.parseId, figureDescs: figDescs }) });
    finishJob(job, 'done', { detail: '已入库', detail2: '资料「' + wantName + '」已保存（' + d.chars + ' 字，' + (d.images || []).length + ' 张图）' });
    setStatus('<span style="color:var(--ok)">✓ 已保存「' + esc(wantName) + '」</span>');
    toast('资料已入库：' + wantName);
    await refresh(); await loadMaterialList(true);
    if (State.view === 'materials') vMaterials();
  } catch (err) {
    finishJob(job, 'error', { detail: err.message });
    setStatus('<span style="color:var(--bad)">✗ ' + esc(err.message) + '</span>');
    toast('上传失败：' + err.message);
  }
}
async function pollVisionJob(jobId, onProgress) {
  for (let i = 0; i < 3600; i++) {
    const p = await api('/api/vision/job?id=' + encodeURIComponent(jobId));
    if (onProgress) onProgress(p);
    if (p.status === 'done') return p;
    if (p.status === 'error') throw new Error(p.error || '识图失败');
    await new Promise(r => setTimeout(r, p.total > 30 ? 1500 : 600));
  }
  throw new Error('识图超时（仍在服务端运行，可稍后查看资料库）');
}
window.viewMat = async function (id) {
  const box = $('#m-preview');
  box.innerHTML = '<div class="hint"><span class="spin"></span>加载中…</div>';
  try {
    const [mat, figs] = await Promise.all([api('/api/materials/' + id), api('/api/materials/' + id + '/figures')]);
    let kps = [];
    try { kps = await api('/api/kps?materialId=' + id); } catch (e) { /* 忽略 */ }
    box.innerHTML = `<div class="card" style="margin-top:10px"><h3>📄 ${esc(mat.name)}</h3>
      <div class="hint" style="margin-bottom:8px">${mat.chars} 字 · ${figs.length} 张图${kps.length ? ' · ' + kps.length + ' 个知识点' : ''}</div>
      ${kps.length ? `<div class="filter-row" style="margin-bottom:8px">${kps.slice(0, 12).map(k => `<span class="badge b-purple" title="${esc(k.detail || '')}">${esc(k.name)}</span>`).join('')}</div>` : ''}
      <div class="filter-row">${figs.map(f => `<div class="fig-item" style="max-width:180px"><div class="fig-meta">${esc(f.id)}<br><span class="hint">第${f.page || '?'}页</span></div><div class="fig-desc hint">${f.desc ? esc(f.desc.slice(0, 120)) : '（未识图）'}</div></div>`).join('')}</div>
      <pre class="quote-pre" style="max-height:260px;overflow-y:auto">${esc(mat.text.slice(0, 2000))}${mat.text.length > 2000 ? '\n…（剩余 ' + (mat.chars - 2000) + ' 字）' : ''}</pre></div>`;
  } catch (e) { box.innerHTML = `<div class="warn-box">${esc(e.message)}</div>`; }
};
window.useMat = async function (id) {
  const mat = await api('/api/materials/' + id);
  /* 精确制题页已并入对话制题：这里直接把资料选中并切过去 */
  State.chat = Object.assign({}, State.chat, {
    material: { id: mat.id, name: mat.name, chars: mat.chars, figure_count: mat.figure_count }
  });
  State.kps = State.kps || {}; State.kps.chat = null;
  stopPoll(); State.view = 'chat'; State.current = null;
  await navigate('chat');
  toast('资料已选中，可先分析知识点，或用一句话说需求');
};
window.delMat = async function (btn, id) {
  if (!confirm('删除这份资料？\n\n（是软删除：正文与图片都还在库里，可在「个人中心 → 操作记录」申请撤回恢复）')) return;
  return busy(btn, async () => {
    try {
      await api('/api/materials/' + id, { method: 'DELETE' });
      toast('已删除（可申请撤回恢复）');
      vMaterials();
    } catch (e) { toast(e.message); }
  });
};

/* ================= 任务列表 / 详情 ================= */
async function vTasks() {
  const s = await api('/api/state');
  State.tasks = s.tasks; State.config = s.config; State.global = s;
  const rows = State.tasks.map(t => {
    const st = t.stats;
    const prog = st ? `${st.generated} 题｜自动入库 ${st.autoAccepted}｜待人工 ${st.toReview}｜已采纳 ${st.accepted + st.autoAccepted}${st.duplicates ? '｜疑似重复 ' + st.duplicates : ''}` : '尚未运行';
    const hint = t.status === 'draft' ? '<span class="hint" style="color:var(--warn)">点进来批准报价即可继续制题 →</span>' : '';
    return `<tr class="clickable" onclick="openTask('${t.id}')">
      <td><b>${esc(t.name)}</b><br><span class="hint">${fmtTime(t.createdAt)}${t.kps && t.kps.length ? ' · ' + t.kps.length + ' 个知识点' : ''}</span>${hint ? '<br>' + hint : ''}</td>
      <td>${badge(t.status)}</td><td>${prog}</td>
      <td>${money(t.costs.spent)} / 预算 ${money(t.budgetYuan)}</td>
      <td>${t.exported ? '<span class="badge b-green">已导出 ' + t.exported.count + ' 题</span>' : ''}</td></tr>`;
  }).join('');
  $('#view').innerHTML = `
    <h1 class="page">制题任务</h1>
    <div class="page-sub">流水线：资料 → 报价审批 → AI出题（按知识点取材）→ 难度标注 → 多模型交叉质检 → 共识入库 / 分歧人工</div>
    ${State.tasks.length ? `<div class="card"><table class="tbl"><tr><th>任务</th><th>状态</th><th>进度</th><th>成本</th><th>交付</th></tr>${rows}</table></div>`
      : '<div class="card"><div class="empty">还没有任务，去「对话制题」用一句话开始</div></div>'}`;
}
function badge(s) {
  const map = { draft: 'b-yellow', approved: 'b-blue', running: 'b-blue', paused_budget: 'b-red', paused_error: 'b-red', awaiting_review: 'b-yellow', completed: 'b-green' };
  return `<span class="badge ${map[s] || 'b-gray'}">${STATUS_CN[s] || s}</span>`;
}
window.openTask = async function (id) {
  stopPoll();
  const d = await api('/api/tasks/' + id);
  State.view = 'task'; State.current = d.task; State.questions = d.questions; State.events = d.events;
  State.quoteText = d.quoteText; State.runningNow = d.runningNow; State.taskKPs = d.kps || [];
  renderNav(); render();
  startPoll(id);
};
function startPoll(id) {
  stopPoll();
  State.poll = setInterval(async () => {
    if (State.view !== 'task') return stopPoll();
    /* 用户正在编辑某道题（或正在输入）时不要重绘：重绘会把输入框里的内容冲掉 */
    const editing = document.querySelector('.edit-area[style*="display: block"], .edit-area[style*="display:block"]');
    const focused = document.activeElement && $('#view') && $('#view').contains(document.activeElement);
    if (editing || focused) { const hint = $('#poll-hold'); if (hint) hint.style.display = 'inline'; return; }
    try {
      const d = await api('/api/tasks/' + id);
      const changed = JSON.stringify(d.task) !== JSON.stringify(State.current) || d.questions.length !== State.questions.length;
      State.current = d.task; State.questions = d.questions; State.events = d.events;
      State.quoteText = d.quoteText; State.runningNow = d.runningNow;
      if (changed) render();
    } catch (e) { /* 忽略瞬时错误 */ }
  }, 2000);
}
async function vTask() {
  const t = State.current;
  if (!t) { State.view = 'tasks'; return vTasks(); }
  try {
    const fresh = await api('/api/tasks/' + t.id);
    State.current = fresh.task; State.questions = fresh.questions;
    State.events = fresh.events; State.quoteText = fresh.quoteText;
    State.runningNow = fresh.runningNow; State.taskKPs = fresh.kps || [];
  } catch (e) { toast(e.message); }
  const t2 = State.current || t;
  const st = t2.stats || { generated: 0, autoAccepted: 0, toReview: 0, accepted: 0, rejected: 0 };
  const runPhase = { generate: '出题中', tag: '难度标注中', verify: '交叉质检中', adjudicate: '裁决中', regen: '重生成中', resume: '续跑中' }[t2.phase] || '';
  /* 可启动/续跑：待批准（draft）在详情页也能批准；running 但本进程没在跑 = 重启遗留的僵尸状态，允许接管 */
  const isOrphanRunning = t2.status === 'running' && !State.runningNow;
  const canApprove = t2.status === 'draft';
  const canRun = ['approved', 'paused_budget', 'paused_error'].includes(t2.status) || isOrphanRunning;
  const toReview = State.questions.filter(q => q.status === 'needs_review');
  const others = State.questions.filter(q => q.status !== 'needs_review').reverse();
  const cov = (t2.stats && t2.stats.coverage) || null;
  $('#view').innerHTML = `
    <h1 class="page">${esc(t2.name)} ${badge(t2.status)}</h1>
    <div class="page-sub">${runPhase ? '<span class="spin"></span>' + runPhase + ' · ' : ''}成本 ${money(t2.costs.spent)}${t2.costs.billed != null ? '（已入账 ' + money(t2.costs.billed) + '）' : ''} / 预算 ${money(t2.budgetYuan)} · AI 调用 ${t2.costs.calls} 次${t2.material.warnings.length ? ' · <span style="color:var(--warn)">⚠ 资料含 ' + t2.material.warnings.length + ' 条注入警告</span>' : ''}
      <span id="poll-hold" class="badge b-yellow" style="display:none">数据已更新（正在编辑，暂停自动刷新）</span></div>
    ${t2.status === 'paused_budget' ? `<div class="warn-box">预算耗尽暂停。已花 ${money(t2.costs.spent)}。可在下方追加预算后继续。</div>` : ''}
    ${t2.error ? `<div class="warn-box">上次中断：${esc(t2.error)}（修复后可从断点续跑，已完成的部分不会重做）</div>` : ''}
    ${isOrphanRunning ? '<div class="warn-box">这个任务的状态是「运行中」，但当前服务进程里并没有它在跑（通常是服务重启留下的）。点下方按钮可直接接管续跑。</div>' : ''}
    ${cov && cov.missing && cov.missing.length ? `<div class="warn-box">知识点覆盖：${cov.covered}/${cov.total}。以下知识点还没有出到题：${cov.missing.slice(0, 10).map(esc).join('、')}${cov.missing.length > 10 ? ' 等' : ''}。可点「打回重新生成」补题。</div>` : ''}
    <div class="stat-row">
      <div class="stat"><b>${st.generated}</b><span>生成题数</span></div>
      <div class="stat"><b style="color:var(--ok)">${st.autoAccepted}</b><span>质检共识·自动入库</span></div>
      <div class="stat"><b style="color:var(--bad)">${st.toReview}</b><span>分歧·待人工审核</span></div>
      <div class="stat"><b>${st.accepted}</b><span>人工采纳</span></div>
      <div class="stat"><b>${st.rejected}</b><span>毙掉/打回</span></div>
      ${st.duplicates ? `<div class="stat"><b style="color:var(--warn)">${st.duplicates}</b><span>疑似重复</span></div>` : ''}
    </div>
    ${canApprove ? `<div class="card"><h3>这份报价还没批准（任务还停在"待批准"）</h3>
      <div class="hint" style="margin-bottom:8px">预估成本 ${money(t2.quote.est.total)}，建议报价 ${money(t2.quote.price)}。批准后 Agent 才会开始出题。</div>
      <div class="btn-row" style="margin-top:0">
        <input type="number" id="t-budget" value="${+t2.budgetYuan.toFixed(2)}" step="0.5" min="0.01" style="width:110px" title="预算上限">
        <button class="btn" onclick="approveRun(this,'${t2.id}')">✓ 批准报价并启动</button>
        <button class="btn ghost" onclick="copyQuote()">复制报价单</button>
      </div></div>` : ''}
    <div class="card">
      <div class="btn-row" style="margin-top:0">
        ${canRun ? `<button class="btn" onclick="runTask(this,'${t2.id}')">${t2.status === 'approved' || canApprove ? '▶ 启动流水线' : '▶ 从断点续跑'}</button>` : ''}
        ${t2.status === 'paused_budget' ? `<input type="number" id="add-budget" value="1" step="0.5" style="width:90px"><button class="btn sm ghost" onclick="addBudget(this,'${t2.id}')">追加预算并续跑</button>` : ''}
        ${st.toReview === 0 && st.generated > 0 ? `<button class="btn ghost" onclick="exportPack(this,'${t2.id}')">📦 导出科目包</button>` : ''}
        ${t2.exported ? `<span class="badge b-green">已导出：${esc(t2.exported.file)}（${t2.exported.count} 题${t2.exported.embedded ? '，内嵌原图 ' + t2.exported.embedded + ' 张' : ''}，${t2.exported.sizeKB}KB）</span>` : ''}
        ${State.taskKPs.length ? `<span class="badge b-purple">参考知识点 ${State.taskKPs.length} 个</span>` : ''}
      </div>
      ${State.taskKPs.length ? `<div class="kp-list" style="margin-top:10px">${State.taskKPs.map(k => `<span class="kp-chip on" title="${esc(k.detail || '')}">${esc(k.name)}<span class="kp-meta">第${k.ch || 1}章</span></span>`).join('')}</div>` : ''}
      ${(t2.constraints && t2.constraints.length) ? `<div class="note-box" style="margin-top:10px"><b>客户额外要求（出题时逐条满足）：</b><br>${t2.constraints.map(c => '· ' + esc(c)).join('<br>')}${t2.coverageStrict ? '<br>· <b>必须覆盖全部选中知识点</b>（缺考点自动补题）' : ''}</div>` : (t2.coverageStrict ? '<div class="note-box" style="margin-top:10px">· <b>必须覆盖全部选中知识点</b>（缺考点自动补题）</div>' : '')}
      ${t2.quote ? `<pre class="quote-pre" id="quote-pre">${esc(State.quoteText || '')}</pre>` : ''}
    </div>
    ${toReview.length ? `<div class="card"><h3>⚠ 待人工审核（质检分歧 ${toReview.length} 题）</h3>
      <div class="hint" style="margin-bottom:8px">采纳/修改后采纳 会把人工定稿写进经验库，后续出题自动参考。</div>
      ${toReview.map(q => qCard(q, true)).join('')}</div>` : ''}
    <div class="card"><h3>全部题目（${State.questions.length}）</h3>
      ${others.length ? others.map(q => qCard(q, false)).join('') : '<div class="empty">尚无题目，启动流水线后这里会出现生成结果</div>'}
    </div>
    <div class="card"><h3>运行日志（最近 ${Math.min(State.events.length, 120)} 条）</h3>
      <div class="events">${State.events.map(ev => `<div class="${ev.level}">[${new Date(ev.ts).toLocaleTimeString('zh-CN')}] ${esc(ev.step)} · ${esc(ev.msg)}${ev.usage ? ` <span class="cost">(¥${(ev.usage.cost || 0).toFixed(4)})</span>` : ''}</div>`).join('') || '<div class="empty">暂无日志</div>'}</div>
    </div>`;
}
window.approveRun = async function (btn, id) {
  return busy(btn, async () => {
    try {
      const budget = +($('#t-budget') || {}).value || 0;
      await api('/api/tasks/' + id + '/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ budgetYuan: budget }) });
      await api('/api/tasks/' + id + '/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      toast('已批准并启动流水线');
      await refresh(); await openTask(id);
    } catch (e) { toast(e.message); }
  });
};
window.runTask = async function (btn, id) {
  return busy(btn, async () => {
    try {
      await api('/api/tasks/' + id + '/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      toast('流水线已启动，正在续跑未完成的部分');
      openTask(id);
    } catch (e) { toast(e.message); }
  });
};
window.addBudget = async function (btn, id) {
  return busy(btn, async () => {
    const add = +($('#add-budget') || {}).value || 1;
    try {
      await api('/api/tasks/' + id + '/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ addBudget: add }) });
      toast('已追加 ' + money(add) + ' 并续跑');
      openTask(id);
    } catch (e) { toast(e.message); }
  });
};
window.exportPack = async function (btn, id) {
  return busy(btn, async () => {
    try {
      const r = await api('/api/tasks/' + id + '/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const blob = new Blob([r.content], { type: 'text/javascript' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = r.file; a.click(); URL.revokeObjectURL(a.href);
      toast('已导出科目包（' + r.count + ' 题）');
      openTask(id);
    } catch (e) { toast(e.message); }
  });
};
function qCard(q, review) {
  const vHtml = q.verdicts.map(v => q.type === 'mcq'
    ? `<div class="verdict ${v.match ? 'good' : 'bad'}"><b>${esc(v.by)}</b>${v.lensLabel ? '<span class="hint">（' + esc(v.lensLabel) + '）</span>' : ''}：判 ${esc(v.answer)} ${v.match ? '✓ 与出题答案一致' : '✗ 与出题答案 ' + esc(q.answer) + ' 冲突'} — ${esc((v.reason || '').slice(0, 80))}</div>`
    : `<div class="verdict ${v.match ? 'good' : 'bad'}"><b>${esc(v.by)}</b>：${esc(v.verdict)} ${v.issue ? '— ' + esc(v.issue.slice(0, 110)) : ''}</div>`).join('');
  const head = `<div style="margin-bottom:6px">
    <span class="badge b-blue">${TYPE_CN[q.type] || q.type}</span>
    <span class="badge b-gray">${esc(q.kp)}</span>
    ${q.diff ? `<span class="badge b-yellow">难度:${DIFF_CN[q.diff]}</span>` : ''}
    ${q.fig ? `<span class="badge b-green">含原图 ${esc(q.fig)}</span>` : ''}
    ${q.dup_of ? `<span class="badge b-orange" title="与另一道题高度相似，需人工判断">疑似重复</span>` : ''}
    <span class="badge ${q.status === 'auto_accepted' ? 'b-green' : q.status === 'needs_review' ? 'b-red' : q.status === 'accepted' ? 'b-green' : 'b-gray'}">${({ pending: '待质检', auto_accepted: '共识入库', needs_review: '分歧待审', accepted: '已采纳', rejected: '已毙' }[q.status]) || esc(q.status)}</span>
    ${q.human ? '<span class="badge b-gray">人工:' + esc(q.human.action) + '</span>' : ''}</div>`;
  let body = `<div class="q-stem">${esc(q.stem)}</div>`;
  /* 选项必须转义：题干与选项来自模型，而模型的输入是客户资料（不可信） */
  if (q.options) body += `<div class="opt-preview">${q.options.map((o, i) => '<span class="opt-chip">' + 'ABCD'[i] + '. ' + esc(o) + '</span>').join('')}</div><div class="hint">出题答案：${esc(q.answer)} ｜ ${esc((q.expl || '').slice(0, 100))}</div>`;
  if (q.ref) body += `<div class="hint" style="margin-top:4px">参考答案：${esc(q.ref.slice(0, 200))}</div>`;
  body += `<div class="verdicts">${vHtml}</div>`;
  let actions = '';
  if (review) {
    actions = `<div class="btn-row" id="act-${q.id}">
      <button class="btn sm ok" onclick="decide(this,'${q.id}','accept')">✓ 采纳</button>
      <button class="btn sm gray" onclick="toggleEdit('${q.id}')">✎ 修改后采纳</button>
      <button class="btn sm ghost" onclick="regen(this,'${q.id}')">↻ 打回重新生成</button>
      <button class="btn sm danger" onclick="decide(this,'${q.id}','reject')">✗ 毙掉</button>
    </div>
    <div class="edit-area" id="edit-${q.id}" style="display:none">
      <label>题干</label><textarea rows="2" id="e-stem-${q.id}">${esc(q.stem)}</textarea>
      ${q.options ? q.options.map((o, i) => `<label>${'ABCD'[i]}</label><input type="text" id="e-opt${i}-${q.id}" value="${esc(o)}">`).join('') +
        `<label>答案</label><input type="text" id="e-ans-${q.id}" value="${esc(q.answer)}" style="width:70px"><label>解析</label><textarea rows="2" id="e-expl-${q.id}">${esc(q.expl || '')}</textarea>`
        : `<label>参考答案</label><textarea rows="3" id="e-ref-${q.id}">${esc(q.ref || '')}</textarea>`}
      <div class="btn-row"><button class="btn sm" onclick="decideEdit(this,'${q.id}')">保存并采纳</button>
        <button class="btn sm gray" onclick="toggleEdit('${q.id}')">取消</button></div>
    </div>`;
  }
  return `<div class="q-card ${q.status === 'needs_review' ? 'conflict' : q.status === 'auto_accepted' || q.status === 'accepted' ? 'ok' : ''}">${head}${body}${actions}</div>`;
}
window.toggleEdit = function (qid) {
  const e = $('#edit-' + qid);
  e.style.display = e.style.display === 'none' ? 'block' : 'none';
};
/* 采纳 / 毙掉 / 修改后采纳
 * 注意：这里必须写成 window.decide = async function(...)，不能再另写一个同名顶层函数，
 * 否则内联 onclick 调用的是被覆盖后的全局函数，会指向它自己造成无限递归
 * （旧版本就是这么崩的：点"采纳"直接 RangeError，人工审核整条链路不可用）。 */
window.decide = async function (btn, qid, action, edits) {
  return busy(btn, async () => {
    try {
      await api('/api/tasks/' + State.current.id + '/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qid, action, edits }) });
      const fresh = await api('/api/tasks/' + State.current.id);
      State.questions = fresh.questions; State.current = fresh.task; State.events = fresh.events;
      render();
      toast(action === 'edit_accept' ? '已修改并采纳（定稿口径已沉淀进经验库）' : '已' + ({ accept: '采纳', reject: '毙掉' }[action] || action));
    } catch (e) { toast(e.message); }
  });
};
window.decideEdit = async function (btn, qid) {
  const q = State.questions.find(x => x.id === qid);
  if (!q) return;
  const edits = { stem: $('#e-stem-' + qid).value };
  if (q.options) {
    edits.options = [0, 1, 2, 3].map(i => $('#e-opt' + i + '-' + qid).value);
    edits.answer = $('#e-ans-' + qid).value.trim().toUpperCase();
    edits.expl = $('#e-expl-' + qid).value;
  } else edits.ref = $('#e-ref-' + qid).value;
  /* 把原稿一起带上，服务端才知道"改了哪几个字段"，经验库里写的是真正的修正点 */
  edits.__before = { stem: q.stem, options: q.options, answer: q.answer, expl: q.expl, ref: q.ref };
  await window.decide(btn, qid, 'edit_accept', edits);
};
window.regen = async function (btn, qid) {
  return busy(btn, async () => {
    try {
      const r = await api('/api/tasks/' + State.current.id + '/regen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qid }) });
      toast(r.warning ? '已打回，但流水线中断：' + r.warning : '已打回，Agent 将重新生成一题替代');
      const fresh = await api('/api/tasks/' + State.current.id);
      State.questions = fresh.questions; State.current = fresh.task; State.events = fresh.events;
      render();
    } catch (e) { toast(e.message); }
  });
};

/* 轻量 markdown 渲染（AI 讲解输出用）：先整体转义，再做受控替换 */
function mdLite(text) {
  let h = esc(text);
  h = h.replace(/```([\s\S]*?)```/g, function (m, c) { return '<pre class="code">' + c + '</pre>'; });
  h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>').replace(/^## (.+)$/gm, '<h2>$1</h2>').replace(/^# (.+)$/gm, '<h2>$1</h2>');
  h = h.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  return h;
}

/* ================= 刷题 ================= */
const PRACTICE_TABS = [
  { id: 'practice', label: '📝 练习' },
  { id: 'wrong', label: '📕 错题本' },
  { id: 'starred', label: '⭐ 收藏' },
  { id: 'stats', label: '📊 统计' }
];
async function vPractice() {
  const tab = State.pTab || 'practice';
  $('#view').innerHTML = `
    <h1 class="page">我的题库</h1>
    <div class="page-sub">所有任务里已采纳的题目（存数据库）。可按每次制题的批次分开刷，答题进度自动记录，错题优先推送。</div>
    <div class="ptabs" id="ptabs"></div>
    <div id="p-body"><div class="hint"><span class="spin"></span>加载中…</div></div>`;
  renderPracticeTabs();
  $('#ptabs').addEventListener('click', e => {
    const el = e.target.closest('.ptab');
    if (el) { State.pTab = el.dataset.ptab; vPractice(); }
  });
  if (tab === 'stats') return renderPracticeStats();
  return renderPracticeList(tab);
}
function renderPracticeTabs() {
  const box = $('#ptabs');
  if (!box) return;
  const c = State.pCounts || {};
  box.innerHTML = PRACTICE_TABS.map(t => {
    const badge = t.id === 'wrong' && c.wrong ? '（' + c.wrong + '）' : (t.id === 'starred' && c.starred ? '（' + c.starred + '）' : '');
    return '<span class="ptab ' + (t.id === (State.pTab || 'practice') ? 'active' : '') + '" data-ptab="' + t.id + '">' + t.label + badge + '</span>';
  }).join('');
}
async function renderPracticeList(tab) {
  const scope = tab === 'wrong' ? 'wrong' : (tab === 'starred' ? 'starred' : 'all');
  const f = State.pFilter || (State.pFilter = { ch: '', type: '', diff: '', taskId: '', limit: 30 });
  const [data, filters] = await Promise.all([
    api('/api/practice/list?scope=' + scope + '&limit=' + f.limit + buildFilterQS(f)),
    api('/api/practice/filters').catch(() => ({ chapters: [], types: [], diffs: [], tasks: [] }))
  ]);
  State.pCounts = data.counts;
  State.pQueue = data.questions; State.pIdx = 0;
  State.pFilters = filters;
  if (!data.questions.length) {
    $('#p-body').innerHTML = `<div class="card"><div class="empty">
      ${scope === 'wrong' ? '错题本是空的——做得不错！' : scope === 'starred' ? '还没有收藏的题目（答题时点 ⭐ 收藏）' : '题库还是空的，先去「对话制题」生产一批题目'}
    </div></div>`;
    return;
  }
  /* 批次条：把每次制题的题目分开看，不再全部杂糅在一起（只有 1 个批次时也显示，方便确认"这批是哪次生成的"） */
  const batches = filters.tasks || [];
  const cur = f.taskId || '';
  const batchBar = batches.length ? `
    <div class="batch-bar">
      <span class="hint strong">按制题批次：</span>
      <span class="batch-chip ${!cur ? 'on' : ''}" onclick="pickBatch('')">全部（${data.counts.all}）</span>
      ${batches.map(b => `<span class="batch-chip ${cur === b.taskId ? 'on' : ''}" onclick="pickBatch('${esc(b.taskId)}')" title="${esc(b.name)}">
        ${esc((b.name || '').slice(0, 20))}<span class="bc-meta">${b.n} 题${b.todo ? ' · 未做 ' + b.todo : ''}${b.wrong ? ' · <b class="bc-wrong">错 ' + b.wrong + '</b>' : ''}</span></span>`).join('')}
    </div>` : '';
  $('#p-body').innerHTML = `
    ${batchBar}
    <div class="card" style="padding:12px 14px">
      <div class="filter-row">
        <span class="hint strong">筛选：</span>
        <select id="pf-ch"><option value="">全部章节</option>${(filters.chapters || []).map(c => `<option value="${c.ch}" ${String(f.ch) === String(c.ch) ? 'selected' : ''}>第${c.ch}章（${c.n}题${c.wrong ? '，错' + c.wrong : ''}）</option>`).join('')}</select>
        <select id="pf-type"><option value="">全部题型</option>${(filters.types || []).map(t => `<option value="${t.type}" ${f.type === t.type ? 'selected' : ''}>${TYPE_FULL[t.type] || t.type}（${t.n}）</option>`).join('')}</select>
        <select id="pf-diff"><option value="">全部难度</option>${(filters.diffs || []).map(d => `<option value="${d.diff}" ${String(f.diff) === String(d.diff) ? 'selected' : ''}>${DIFF_CN[d.diff] || '未标注'}（${d.n}）</option>`).join('')}</select>
        <select id="pf-task"><option value="">全部批次</option>${(filters.tasks || []).map(t => `<option value="${esc(t.taskId)}" ${f.taskId === t.taskId ? 'selected' : ''}>${esc((t.name || '').slice(0, 18))}（${t.n}）</option>`).join('')}</select>
        <select id="pf-limit">${[10, 30, 60, 120].map(n => `<option value="${n}" ${+f.limit === n ? 'selected' : ''}>每次 ${n} 题</option>`).join('')}</select>
        <button class="btn sm" onclick="applyPFilter(this)">应用</button>
        <span class="hint">当前 ${data.total} 题 ｜ 全库 ${data.counts.all} 题，未做 ${data.counts.todo}，错题 ${data.counts.wrong}，收藏 ${data.counts.starred}</span>
      </div>
    </div>
    <div id="p-card"></div>`;
  ['pf-ch', 'pf-type', 'pf-diff', 'pf-task', 'pf-limit'].forEach(id => { const el = $('#' + id); if (el) el.addEventListener('change', () => applyPFilter()); });
  renderPracticeCard();
}
window.pickBatch = function (taskId) {
  State.pFilter = Object.assign({}, State.pFilter || { limit: 30 }, { taskId });
  renderPracticeList(State.pTab || 'practice');
};
function buildFilterQS(f) {
  return (f.ch ? '&ch=' + f.ch : '') + (f.type ? '&type=' + f.type : '') + (f.diff ? '&diff=' + f.diff : '') + (f.taskId ? '&taskId=' + encodeURIComponent(f.taskId) : '');
}
window.applyPFilter = function (btn) {
  const g = id => { const el = $('#' + id); return el ? el.value : ''; };
  return busy(btn, async () => {
    State.pFilter = { ch: g('pf-ch'), type: g('pf-type'), diff: g('pf-diff'), taskId: g('pf-task'), limit: +g('pf-limit') || 30 };
    renderPracticeList(State.pTab || 'practice');
  });
};
function renderPracticeCard() {
  const list = State.pQueue || [];
  const q = list[State.pIdx];
  if (!q) { $('#p-card').innerHTML = '<div class="card"><div class="empty">这一批做完了 🎉 换个筛选继续</div></div>'; return; }
  const m = q.mine || {};
  const tName = TYPE_FULL[q.type] || q.type;
  const dName = DIFF_CN[q.diff] || '';
  const batchName = ((State.pFilters || {}).tasks || []).find(t => t.taskId === q.taskId);
  const state = m.last_right === 1 ? '<span class="badge b-green">已掌握</span>'
    : (m.last_right === 0 || m.wrong > 0) ? '<span class="badge b-red">错题待复习</span>'
    : m.attempts ? '<span class="badge b-yellow">做过 ' + m.attempts + ' 次</span>'
    : '<span class="badge b-blue">新题</span>';
  const imgHtml = q.img ? '<div class="q-img-wrap"><img class="q-img" src="' + esc(q.img) + '" alt="题目附图" loading="lazy"></div>' : '';
  /* 选项：hover 高亮 + 键盘 1-4/A-D 可选（"有人机互动的感觉"） */
  const optsHtml = q.options ? '<div class="opts">' + q.options.map((o, i) =>
    '<div class="popt" data-i="' + i + '" role="button" tabindex="0"><span class="letter">' + 'ABCD'[i] + '</span><span class="opt-text">' + esc(o) + '</span><span class="opt-hint">按 ' + (i + 1) + ' 选择</span></div>').join('') + '</div>' : '';
  const subjHtml = !q.options ? `<textarea class="ans" id="p-subj" rows="6" placeholder="写下你的解答…（提交后对照参考答案自评）">${esc((State.pDrafts && State.pDrafts[q.id]) || '')}</textarea>
    <div class="btn-row"><button class="btn" onclick="submitSubjective(this,'${q.id}')">提交并对照参考答案</button></div>` : '';
  $('#p-card').innerHTML = `
    <div class="stat-row">
      <div class="stat"><b>${State.pIdx + 1} / ${list.length}</b><span>本批进度</span></div>
      <div class="stat"><b>${m.attempts || 0}</b><span>此题做过</span></div>
      <div class="stat"><b class="${m.wrong ? 'bad' : ''}">${m.wrong || 0}</b><span>此题答错</span></div>
    </div>
    <div class="card q-card">
      <div style="margin-bottom:8px">
        <span class="badge b-blue">${tName}</span>
        <span class="badge b-gray">第${q.ch}章 · ${esc(q.kp || '')}</span>
        ${dName ? `<span class="badge b-yellow">${dName}</span>` : ''}
        ${q.img ? '<span class="badge b-purple">含原图</span>' : ''}
        ${batchName ? `<span class="badge b-cyan" title="${esc(batchName.name)}">批次：${esc((batchName.name || '').slice(0, 14))}</span>` : ''}
        ${state}
        <span class="badge ${m.starred ? 'b-yellow' : 'b-gray'} clickable-badge" onclick="starQ(this,'${q.id}', ${!m.starred})">${m.starred ? '⭐ 已收藏' : '☆ 收藏'}</span>
      </div>
      <div class="q-stem">${esc(q.stem)}</div>
      ${imgHtml}
      ${optsHtml}
      ${subjHtml}
      <div id="p-fb"></div>
      <div class="btn-row">
        <button class="btn ghost" onclick="aiExplainQ('${q.id}')">🤖 AI 讲解这道题</button>
        <button class="btn gray" onclick="hideQ(this,'${q.id}')">不需要这题，隐藏</button>
        <button class="btn gray" onclick="nextP()">跳过 / 下一题 →</button>
      </div>
      <div id="ai-slot"></div>
    </div>`;
  document.querySelectorAll('.popt').forEach(el => {
    el.addEventListener('click', () => answerMCQ(q.id, +el.dataset.i, el));
    el.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); answerMCQ(q.id, +el.dataset.i, el); } });
  });
  document.onkeydown = ev => {
    if (State.view !== 'practice' || !q.options) return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const k = ev.key.toUpperCase();
    const idx = /^[1-4]$/.test(k) ? +k - 1 : 'ABCD'.indexOf(k);
    if (idx >= 0 && idx < q.options.length) { const el = document.querySelectorAll('.popt')[idx]; if (el) answerMCQ(q.id, idx, el); }
  };
}
window.nextP = function () { State.pIdx = (State.pIdx || 0) + 1; renderPracticeCard(); };
async function answerMCQ(qid, idx, el) {
  const q = (State.pQueue || []).find(x => x.id === qid);
  if (!q || q._answered) return;
  q._answered = true;                       // 乐观锁：避免同一题被连点两次
  const given = 'ABCD'[idx];
  let d;
  try {
    d = await api('/api/practice/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qid, answer: given }) });
  } catch (e) {
    q._answered = false;                    // 失败要放开锁，否则这题永远点不动了
    toast(e.message);
    return;
  }
  q.mine = d.mine || q.mine;
  const rightIdx = 'ABCD'.indexOf(String(d.answer || '').toUpperCase());
  document.querySelectorAll('.popt').forEach((x, i) => {
    x.classList.add('locked');
    x.removeAttribute('tabindex');
    if (i === rightIdx) x.classList.add('right');
    else if (i === idx && !d.correct) x.classList.add('wrong');
  });
  $('#p-fb').innerHTML = `<div class="feedback ${d.correct ? 'good' : 'bad'}">
    <div class="verdict">${d.correct ? '✓ 回答正确' : '✗ 答错了'}</div>
    <div>正确答案：<b>${esc(d.answer || '')}</b>　你的答案：${esc(given)}</div>
    ${d.expl ? '<div style="margin-top:6px"><b>解析：</b>' + esc(d.expl) + '</div>' : ''}
    <div class="hint" style="margin-top:6px">${d.correct ? '已记录为掌握' : '已加入错题本，会优先推送复习'}</div>
  </div>`;
  await refreshCounts();
}
window.submitSubjective = async function (btn, qid) {
  const ta = $('#p-subj');
  const text = ta ? ta.value.trim() : '';
  if (!text) { toast('请先写下你的解答'); return; }
  State.pDrafts = State.pDrafts || {}; State.pDrafts[qid] = text;
  return busy(btn, async () => {
    try {
      const d = await api('/api/practice/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qid, answer: text, grade: 0 }) });
      $('#p-fb').innerHTML = `<div class="feedback good">
        <div class="verdict">参考答案</div>
        <div class="ref" style="margin-top:6px">${esc(d.ref || '（本题未提供参考答案）')}</div>
        <div style="margin-top:10px">自评掌握程度（用于统计与错题本）：
          <button class="btn sm ok" onclick="gradeSubj(this,'${qid}',1)">✓ 掌握</button>
          <button class="btn sm warn" onclick="gradeSubj(this,'${qid}',0.5)">△ 半对</button>
          <button class="btn sm danger" onclick="gradeSubj(this,'${qid}',0)">✗ 未掌握</button>
        </div></div>`;
      const ta2 = $('#p-subj'); if (ta2) ta2.readOnly = true;
      await refreshCounts();
    } catch (e) { toast(e.message); }
  });
};
window.gradeSubj = async function (btn, qid, grade) {
  return busy(btn, async () => {
    try {
      await api('/api/practice/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qid, grade }) });
      toast(grade >= 1 ? '已标记掌握' : grade > 0 ? '已标记半对' : '已标记未掌握，进入错题本');
      nextP();
    } catch (e) { toast(e.message); }
  });
};
window.starQ = async function (btn, qid, star) {
  return busy(btn, async () => {
    try {
      await api('/api/practice/star', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qid, starred: star }) });
      const q = (State.pQueue || []).find(x => x.id === qid);
      if (q) q.mine.starred = star;
      await refreshCounts();
      renderPracticeTabs();
      toast(star ? '已收藏' : '已取消收藏');
      renderPracticeCard();
    } catch (e) { toast(e.message); }
  });
};
window.hideQ = async function (btn, qid) {
  return busy(btn, async () => {
    try {
      await api('/api/practice/hide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qid, hidden: true }) });
      State.pQueue = (State.pQueue || []).filter(x => x.id !== qid);
      if (State.pIdx >= State.pQueue.length) State.pIdx = Math.max(0, State.pQueue.length - 1);
      toast('已隐藏，不再推送（题目仍在数据库，可在操作记录里申请撤回恢复）');
      renderPracticeCard();
    } catch (e) { toast(e.message); }
  });
};
async function refreshCounts() {
  try { const d = await api('/api/practice/list?limit=1'); State.pCounts = d.counts; renderPracticeTabs(); } catch (e) { /* 忽略 */ }
}
async function renderPracticeStats() {
  const d = await api('/api/practice/stats');
  const s = d.stats, bank = d.bank;
  const rate = s.total ? Math.round(100 * s.correct / s.total) : 0;
  const bar = r => `<div class="bar-wrap"><div class="bar-fill" style="width:${r}%"></div></div>`;
  const rateCell = rt => `<span class="rate ${rt >= 80 ? 'hi' : rt >= 60 ? 'mid' : 'lo'}">${rt}%</span>`;
  const chRows = (s.byChapter || []).sort((a, b) => a.ch - b.ch).map(r => {
    const rt = r.n ? Math.round(100 * r.ok / r.n) : 0;
    return `<tr><td>第${r.ch}章</td><td>${r.n}</td><td>${bar(rt)}</td><td>${rateCell(rt)}</td></tr>`;
  }).join('') || '<tr><td colspan="4" class="hint">还没有答题记录</td></tr>';
  const typeRows = (s.byType || []).map(r => {
    const rt = r.n ? Math.round(100 * r.ok / r.n) : 0;
    return `<tr><td>${TYPE_FULL[r.type] || r.type}</td><td>${r.n}</td><td>${bar(rt)}</td><td>${rateCell(rt)}</td></tr>`;
  }).join('') || '<tr><td colspan="4" class="hint">还没有答题记录</td></tr>';
  const kpRows = (s.byKp || []).map(r => {
    const rt = r.n ? Math.round(100 * r.ok / r.n) : 0;
    return `<tr><td>${esc(r.kp)}</td><td>${r.n}</td><td>${bar(rt)}</td><td>${rateCell(rt)}</td></tr>`;
  }).join('') || '<tr><td colspan="4" class="hint">还没有足够的答题记录</td></tr>';
  const weakHtml = (d.weak || []).length ? `<div class="warn-box">薄弱知识点（正确率 &lt;60%，出题时会被倾斜）：${d.weak.map(w => esc(w.kp) + '（' + Math.round(100 * w.ok / w.n) + '%）').join('、')}</div>` : '';
  const recent = d.recent.map(r => `<tr>
    <td>${fmtTime(r.ts)}</td>
    <td>${esc(String(r.stem || '').slice(0, 34))}…</td>
    <td>第${r.ch}章</td>
    <td>${TYPE_CN[r.type] || r.type}</td>
    <td>${r.correct ? '<span class="rate hi">✓</span>' : '<span class="rate lo">✗</span>'}</td>
    <td><button class="btn sm gray" onclick="jumpToQ('${r.question_id}')">重做</button></td></tr>`).join('') || '<tr><td colspan="6" class="hint">还没有答题记录</td></tr>';
  $('#p-body').innerHTML = `
    <div class="stat-row">
      <div class="stat"><b>${bank.total}</b><span>题库总量</span></div>
      <div class="stat"><b>${s.total}</b><span>累计答题</span></div>
      <div class="stat"><b class="${rate >= 80 ? 'ok' : rate >= 60 ? '' : 'bad'}">${s.total ? rate + '%' : '—'}</b><span>总正确率</span></div>
      <div class="stat"><b>${bank.todo}</b><span>未做的题</span></div>
      <div class="stat"><b>${bank.hidden}</b><span>已隐藏</span></div>
    </div>
    ${weakHtml}
    <div class="grid c2">
      <div class="card"><h3>按章节</h3><table class="tbl"><tr><th>章节</th><th>答题数</th><th>正确率</th><th></th></tr>${chRows}</table></div>
      <div class="card"><h3>按题型</h3><table class="tbl"><tr><th>题型</th><th>答题数</th><th>正确率</th><th></th></tr>${typeRows}</table></div>
    </div>
    <div class="card"><h3>按知识点（答题数 ≥2）</h3><table class="tbl"><tr><th>知识点</th><th>答题数</th><th>正确率</th><th></th></tr>${kpRows}</table></div>
    <div class="card"><h3>最近答题记录（最多 60 条）</h3>
      <table class="tbl"><tr><th>时间</th><th>题目</th><th>章节</th><th>题型</th><th>结果</th><th></th></tr>${recent}</table>
    </div>`;
}
window.jumpToQ = async function (qid) {
  State.pTab = 'practice'; State.pIdx = 0;
  await vPractice();
  const i = (State.pQueue || []).findIndex(x => x.id === qid);
  if (i >= 0) { State.pIdx = i; renderPracticeCard(); }
  else { toast('该题在当前筛选条件下不可见（可能已隐藏）'); }
};
window.aiExplainQ = async function (qid) {
  const slot = $('#ai-slot');
  if (!slot) return;
  slot.innerHTML = '<div class="hint"><span class="spin"></span>AI 正在讲解…（按实际用量计费）</div>';
  try {
    const d = await api('/api/practice/explain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qid }) });
    if (d.error) { slot.innerHTML = '<div class="feedback bad">' + esc(d.error) + '</div>'; return; }
    renderAiChat(qid, d.messages || []);
    if (d.cost) { toast('讲解已生成，消耗 ¥' + d.cost); refresh().catch(() => {}); }
  } catch (e) { slot.innerHTML = '<div class="feedback bad">' + esc(e.message) + '</div>'; }
};
function renderAiChat(qid, msgs) {
  const slot = $('#ai-slot');
  const quick = ['换个更简单的方式再讲一遍', '关键步骤没看懂，展开讲讲', '给我一道同考点的变式题（先不给答案）', '这个考点常怎么考？'];
  slot.innerHTML = `
    <div class="aichat">
      <div class="ai-head"><b>🤖 AI 讲解 · 可连续追问</b><span class="hint">上下文已保存，随时接着问</span>
        <button class="btn sm gray" onclick="clearAiChat('${qid}')">清空对话</button></div>
      <div class="ai-thread" id="ai-thread">
        ${msgs.map(m => `<div class="ai-msg ${m.role === 'user' ? 'me' : 'ai'}">${m.role === 'assistant' ? mdLite(m.content) : esc(m.content)}</div>`).join('')}
      </div>
      <div class="ai-quick">${quick.map(t => `<span class="chip" data-ask="${esc(t)}">${esc(t)}</span>`).join('')}</div>
      <div class="ai-input"><textarea id="ai-q" rows="2" placeholder="追问这道题…（Enter 发送）"></textarea><button class="btn" onclick="aiAsk('${qid}')">发送</button></div>
      <div id="ai-err"></div>
    </div>`;
  const th = $('#ai-thread'); if (th) th.scrollTop = th.scrollHeight;
  const ta = $('#ai-q');
  if (ta) ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); window.aiAsk(qid); } });
  slot.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => { const box = $('#ai-q'); if (box) { box.value = c.dataset.ask; window.aiAsk(qid); } }));
}
window.aiAsk = async function (qid) {
  const ta = $('#ai-q');
  const msg = ta ? ta.value.trim() : '';
  if (!msg) return;
  const thread = $('#ai-thread');
  thread.insertAdjacentHTML('beforeend', '<div class="ai-msg me">' + esc(msg) + '</div>');
  ta.value = '';
  thread.insertAdjacentHTML('beforeend', '<div class="ai-msg ai" id="ai-wait"><span class="spin"></span>思考中…</div>');
  thread.scrollTop = thread.scrollHeight;
  try {
    const d = await api('/api/practice/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qid, message: msg }) });
    const w = $('#ai-wait'); if (w) w.remove();
    if (d.error) { $('#ai-err').innerHTML = '<div class="feedback bad">' + esc(d.error) + '</div>'; return; }
    const last = (d.messages || []).filter(m => m.role === 'assistant').pop();
    thread.insertAdjacentHTML('beforeend', '<div class="ai-msg ai">' + mdLite(last ? last.content : '') + '</div>');
    thread.scrollTop = thread.scrollHeight;
  } catch (e) {
    const w = $('#ai-wait'); if (w) w.remove();
    $('#ai-err').innerHTML = '<div class="feedback bad">' + esc(e.message) + '</div>';
  }
};
window.clearAiChat = async function (qid) {
  if (!confirm('清空与 AI 关于这道题的对话？')) return;
  await api('/api/practice/chat-clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qid }) });
  const slot = $('#ai-slot'); if (slot) slot.innerHTML = '';
  toast('已清空');
};

/* 内联"填写说明"面板：替代原生 prompt()
 * 原生 prompt 在自动化环境/部分浏览器里会被拦截或样式不可控，而且体验割裂；
 * 这里统一用一个可关闭的浮层，管理员/用户都在同一处填写理由。 */
function askNote({ title, placeholder = '', okText = '确认', danger = false, onOk }) {
  const old = document.getElementById('ask-modal');
  if (old) old.remove();
  const wrap = document.createElement('div');
  wrap.id = 'ask-modal';
  wrap.className = 'ask-modal';
  wrap.innerHTML = `<div class="ask-card">
    <div class="ask-title">${esc(title)}</div>
    <textarea id="ask-note" rows="3" placeholder="${esc(placeholder)}"></textarea>
    <div class="btn-row"><button class="btn ${danger ? 'danger' : ''}" id="ask-ok">${esc(okText)}</button>
      <button class="btn gray" id="ask-cancel">取消</button></div>
  </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelector('#ask-cancel').onclick = close;
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
  wrap.querySelector('#ask-ok').onclick = async () => {
    const v = wrap.querySelector('#ask-note').value.trim();
    const ok = wrap.querySelector('#ask-ok');
    if (ok.dataset.busy === '1') return;
    ok.dataset.busy = '1'; ok.disabled = true;
    try { await onOk(v); close(); }
    catch (e) { toast(e.message); ok.dataset.busy = ''; ok.disabled = false; }
  };
  const ta = wrap.querySelector('#ask-note');
  ta.focus();
  ta.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
}
window.askNote = askNote;

/* ================= 个人中心 ================= */
async function vProfile() {
  const info = await api('/api/user/info');
  Me.balance = info.balance; Me.checkin = info.checkin;
  const ck = info.checkin || {};
  const pend = (info.revertRequests || []).filter(r => r.status === 'pending');
  const reqByOp = new Map((info.revertRequests || []).map(r => [r.oplog_id, r]));
  const opRows = info.oplog.map(o => {
    const rq = reqByOp.get(o.id);
    const opName = OP_CN[o.action] || o.action;
    const status = o.reverted ? '<span class="badge b-gray">已撤回</span>'
      : rq ? (rq.status === 'pending' ? '<span class="badge b-yellow">待管理员处理</span>'
        : rq.status === 'approved' ? '<span class="badge b-green">撤回已通过</span>' : '<span class="badge b-red">撤回被驳回</span>') : '';
    const btn = (!o.reverted && !rq && o.revertible)
      ? `<button class="btn sm gray" onclick="askRevert(this,${o.id})">申请撤回</button>` : '';
    return `<tr><td class="nowrap">${fmtTime(o.ts)}</td><td><span class="badge b-gray">${esc(opName)}</span></td>
      <td>${esc(o.detail || '')}</td><td class="nowrap">${status}${btn}</td></tr>`;
  }).join('');
  const billRows = info.bills.map(b => {
    const isIn = +b.amount < 0;
    return `<tr><td class="nowrap">${fmtTime(b.ts)}</td><td>${esc(b.reason || b.kind)}</td>
      <td class="${isIn ? 'ok' : ''}">${isIn ? '+' : '−'}${money(Math.abs(b.amount))}</td>
      <td>${b.shortfall ? '<span class="badge b-red">欠费 ' + money(b.shortfall) + '</span>' : ''}</td>
      <td class="hint">${fmtTime(b.ts) === '—' ? '' : '余额 ' + money(b.balance_after)}</td></tr>`;
  }).join('');
  const sessRows = info.sessions.map(s => `<tr><td>${s.current ? '<span class="badge b-green">当前设备</span>' : '<span class="badge b-gray">其它设备</span>'}</td>
    <td class="hint">${esc(s.ip || '')} ${esc((s.ua || '').slice(0, 40))}</td>
    <td>${fmtAgo(s.lastSeen)}</td><td>${fmtDur(s.onlineMs)}</td></tr>`).join('');
  $('#view').innerHTML = `
    <h1 class="page">个人中心</h1>
    <div class="page-sub">用户号是你在这个平台的唯一标识，可用于查询操作记录；密码加盐散列存储，余额与记录只在你登录后可见</div>
    <div class="stat-row">
      <div class="stat"><b>${esc(info.userNo || '')}</b><span>用户号（${esc(info.username)}${info.role === 'admin' ? ' · 管理员' : ''}）</span></div>
      <div class="stat"><b class="ok">${money(info.balance)}</b><span>当前余额</span></div>
      <div class="stat"><b>${fmtDur(ck.onlineMs)}</b><span>累计在线时长</span></div>
      <div class="stat"><b>${ck.totalDays || 0}</b><span>累计签到（连续 ${ck.streak || 0} 天）</span></div>
      <div class="stat"><b>${new Date(Number(info.created_at)).toLocaleDateString('zh-CN')}</b><span>注册时间</span></div>
    </div>

    <div class="card"><h3>每日签到</h3>
      <div class="filter-row">
        ${ck.checkedToday
          ? `<span class="badge b-green">今日已签到</span><span class="hint">连续 ${ck.streak} 天 · 本月 ${ck.monthDays} 天 · 历史最长 ${ck.bestStreak} 天</span>`
          : `<button class="btn" onclick="doCheckin(this)">✅ 签到</button><span class="hint">已连续 ${ck.streak} 天，本月签到 ${ck.monthDays} 天</span>`}
      </div>
    </div>

    <div class="card"><h3>充值（模拟充值，未接入支付网关；单次 ≤ ¥100）</h3>
      <div class="filter-row">
        <input type="number" id="r-amount" value="10" step="1" min="0.01" max="100" style="width:110px">
        <button class="btn" onclick="recharge(this)">充值</button>
        <span class="hint">正式环境会接入支付，此处为模拟</span>
      </div></div>

    <div class="card"><h3>我的操作记录（${info.oplog.length} 条，仅包含你自己的操作）</h3>
      <div class="hint" style="margin-bottom:8px">这里<b>不会出现管理员的操作</b>（配置、供应商、授权等属于管理行为，只在管理端「审计与撤回」里可见）。做错的操作可以点「申请撤回」，管理员批准后自动还原。</div>
      ${info.oplog.length ? `<div class="scroll-y" style="max-height:420px"><table class="tbl"><tr><th>时间</th><th>操作</th><th>明细</th><th></th></tr>${opRows}</table></div>`
        : '<div class="empty">暂无操作记录</div>'}
      ${pend.length ? `<div class="note-box" style="margin-top:10px">你有 ${pend.length} 条撤回申请正在等待管理员处理。</div>` : ''}
    </div>

    <div class="card"><h3>账务流水（充值与扣费明细）</h3>
      ${info.bills.length ? `<div class="scroll-y" style="max-height:320px"><table class="tbl"><tr><th>时间</th><th>说明</th><th>金额</th><th>欠费</th><th></th></tr>${billRows}</table></div>`
        : '<div class="empty">暂无流水</div>'}
    </div>

    <div class="card"><h3>登录设备（在线时长按会话累计）</h3>
      <table class="tbl"><tr><th>设备</th><th>来源</th><th>最近活动</th><th>累计在线</th></tr>${sessRows}</table>
      <div class="btn-row"><button class="btn ghost" onclick="revokeSessions(this)">🚪 踢下线其它设备</button>
        <span class="hint">发现异常登录时使用；当前设备不受影响</span></div>
    </div>

    <div class="card"><h3>修改密码</h3>
      <div class="filter-row">
        <input type="password" id="pw-old" placeholder="原密码" style="width:170px">
        <input type="password" id="pw-new" placeholder="新密码（≥6位）" style="width:170px">
        <input type="password" id="pw-new2" placeholder="确认新密码" style="width:170px">
        <button class="btn" onclick="changePwd(this)">修改密码</button>
      </div>
      <div class="hint">修改后其它设备会被强制下线</div>
    </div>

    <div class="card"><h3>账号</h3>
      <div class="btn-row" style="margin-top:0">
        <button class="btn ghost" onclick="doLogout(true)">🔄 切换账号</button>
        <button class="btn gray" onclick="doLogout(false)">🚪 退出登录</button>
        <span class="hint">退出后服务器上的数据（余额/资料/题库）都会保留，下次登录继续用</span>
      </div></div>`;
}
window.askRevert = function (btn, oplogId) {
  askNote({
    title: '申请撤回这条操作',
    placeholder: '简单说明原因，管理员会看到（例如：误删了资料 / 手滑隐藏了题目）',
    okText: '提交申请',
    onOk: async (reason) => {
      await api('/api/user/revert-request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oplogId, reason }) });
      toast('已提交撤回申请，等管理员处理');
      vProfile();
    }
  });
};
window.recharge = async function (btn) {
  return busy(btn, async () => {
    const amount = +$('#r-amount').value;
    try {
      const d = await api('/api/user/recharge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount }) });
      Me.balance = d.balance;
      toast('充值成功，余额 ' + money(d.balance));
      renderNav(); vProfile();
    } catch (e) { toast(e.message); }
  });
};
window.changePwd = async function (btn) {
  const oldPassword = $('#pw-old').value, newPassword = $('#pw-new').value, again = $('#pw-new2').value;
  if (!oldPassword || !newPassword) { toast('请填写原密码与新密码'); return; }
  if (newPassword !== again) { toast('两次输入的新密码不一致'); return; }
  return busy(btn, async () => {
    try {
      const d = await api('/api/user/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oldPassword, newPassword }) });
      toast('密码已修改，其它 ' + d.revoked + ' 个设备已下线');
      $('#pw-old').value = $('#pw-new').value = $('#pw-new2').value = '';
    } catch (e) { toast(e.message); }
  });
};
window.revokeSessions = async function (btn) {
  if (!confirm('把其它设备上的登录全部踢下线？当前设备不受影响。')) return;
  return busy(btn, async () => {
    try {
      const d = await api('/api/user/sessions/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      toast('已踢下线 ' + d.revoked + ' 个会话');
      vProfile();
    } catch (e) { toast(e.message); }
  });
};

/* ================= 审计与撤回（管理员） ================= */
async function vAudit() {
  if (!Me || Me.role !== 'admin') { $('#view').innerHTML = '<div class="card"><div class="empty">审计与撤回仅管理员可见</div></div>'; return; }
  const st = State.audit || (State.audit = { userNo: '', action: '', scope: '', page: 1, size: 50 });
  const [reqs, logs] = await Promise.all([
    api('/api/admin/revert-requests?status=pending').catch(() => ({ pending: 0, rows: [] })),
    api('/api/admin/oplogs?size=' + st.size + '&page=' + st.page + (st.userNo ? '&userNo=' + encodeURIComponent(st.userNo) : '')
      + (st.action ? '&action=' + encodeURIComponent(st.action) : '') + (st.scope ? '&scope=' + st.scope : '')).catch(() => ({ total: 0, rows: [], actions: [] }))
  ]);
  const pendingRows = (reqs.rows || []).map(r => `
    <tr>
      <td><b>${esc(r.username)}</b><br><span class="hint">${esc(r.userNo)}</span></td>
      <td><span class="badge b-purple">${esc(r.actionLabel)}</span><div class="hint">#${r.oplogId} ${fmtTime(r.opTs)}</div></td>
      <td>${esc(r.opDetail || '')}</td>
      <td>${esc(r.reason || '（未填理由）')}</td>
      <td class="nowrap">
        <button class="btn sm ok" onclick="decideRevert(this,${r.id},true)">✓ 批准并撤回</button>
        <button class="btn sm danger" onclick="decideRevert(this,${r.id},false)">✗ 驳回</button>
      </td>
    </tr>`).join('');
  const rows = (logs.rows || []).map(o => `
    <tr>
      <td class="nowrap">${fmtTime(o.ts)}</td>
      <td><b>${esc(o.username)}</b><br><span class="hint">${esc(o.userNo)}</span></td>
      <td><span class="badge ${o.scope === 'admin' ? 'b-purple' : 'b-gray'}">${o.scope === 'admin' ? '管理操作' : '用户操作'}</span></td>
      <td><span class="badge b-gray">${esc(OP_CN[o.action] || o.action)}</span><div class="hint">${esc(o.action)}</div></td>
      <td>${esc(o.detail || '')}${o.revertOf ? '<div class="hint">← 撤销了 #' + o.revertOf + '</div>' : ''}</td>
      <td class="nowrap">
        ${o.reverted ? '<span class="badge b-gray">已撤回</span>' : (o.canRevert
          ? `<button class="btn sm gray" onclick="revertOp(this,${o.id})">↩ 撤回</button>`
          : '<span class="hint">不可撤回</span>')}
      </td>
    </tr>`).join('');
  const pages = Math.max(1, Math.ceil((logs.total || 0) / st.size));
  $('#view').innerHTML = `
    <h1 class="page">审计与撤回（管理员）</h1>
    <div class="page-sub">用户与管理员的操作分开呈现：普通用户在「个人中心」只看到自己的操作，管理操作只在这里可见。可按用户号一条查询，也可按用户申请直接执行撤回。</div>

    <div class="card"><h3>待处理的撤回申请 ${reqs.pending ? '<span class="badge b-red">' + reqs.pending + '</span>' : ''}</h3>
      ${pendingRows ? `<table class="tbl"><tr><th>申请用户</th><th>要撤回的操作</th><th>操作明细</th><th>申请理由</th><th></th></tr>${pendingRows}</table>`
        : '<div class="empty">没有待处理的撤回申请</div>'}
    </div>

    <div class="card"><h3>操作记录查询</h3>
      <div class="filter-row">
        <input type="text" id="au-userNo" placeholder="用户号（如 u1 / admin1）" value="${esc(st.userNo)}" style="width:180px">
        <select id="au-action" style="min-width:150px"><option value="">全部操作类型</option>
          ${(logs.actions || []).map(a => `<option value="${esc(a.action)}" ${st.action === a.action ? 'selected' : ''}>${esc(OP_CN[a.action] || a.action)}（${a.n}）</option>`).join('')}</select>
        <select id="au-scope" style="min-width:120px">
          <option value="">全部范围</option>
          <option value="user" ${st.scope === 'user' ? 'selected' : ''}>用户操作</option>
          <option value="admin" ${st.scope === 'admin' ? 'selected' : ''}>管理操作</option>
        </select>
        <select id="au-size">${[20, 50, 100, 200].map(n => `<option value="${n}" ${+st.size === n ? 'selected' : ''}>每页 ${n} 条</option>`).join('')}</select>
        <button class="btn sm" onclick="auditQuery(this)">查询</button>
        <button class="btn sm ghost" onclick="auditExport()">导出 CSV</button>
        <span class="hint">共 ${logs.total} 条 ｜ 第 ${st.page}/${pages} 页</span>
      </div>
      <div class="btn-row" style="margin-top:8px">
        <button class="btn sm gray" onclick="auditPage(${st.page - 1})" ${st.page <= 1 ? 'disabled' : ''}>← 上一页</button>
        <button class="btn sm gray" onclick="auditPage(${st.page + 1})" ${st.page >= pages ? 'disabled' : ''}>下一页 →</button>
        <span class="hint">提示：在「用户管理」里点某个账号的「查操作记录」也会跳到这里并按用户号过滤</span>
      </div>
      <div class="scroll-y" style="max-height:560px;margin-top:10px">
        <table class="tbl"><tr><th>时间</th><th>用户</th><th>范围</th><th>操作</th><th>明细</th><th></th></tr>
        ${rows || '<tr><td colspan="6" class="hint">没有符合条件的记录</td></tr>'}</table>
      </div>
    </div>

    <div class="card"><h3>签到看板（近 30 天）</h3>
      <div id="ck-board" class="ck-board hint">加载中…</div>
    </div>`;
  /* 签到看板按需加载，避免拖慢主查询 */
  api('/api/admin/checkin-board').then(d => {
    const max = Math.max(1, ...d.board.map(x => x.n));
    const el = $('#ck-board');
    if (el) el.innerHTML = d.board.length
      ? d.board.map(x => `<div class="ck-col" title="${x.day}：${x.n} 人签到"><div class="ck-bar" style="height:${Math.max(4, Math.round(60 * x.n / max))}px"></div><span>${x.day.slice(5)}</span></div>`).join('')
      : '近 30 天还没有签到记录';
  }).catch(() => {});
}
window.auditQuery = function (btn) {
  return busy(btn, async () => {
    const g = id => { const el = $('#' + id); return el ? el.value : ''; };
    State.audit = { userNo: g('au-userNo').trim(), action: g('au-action'), scope: g('au-scope'), size: +g('au-size') || 50, page: 1 };
    vAudit();
  });
};
window.auditPage = function (p) {
  State.audit = Object.assign({}, State.audit || {}, { page: Math.max(1, p) });
  vAudit();
};
window.auditExport = function () {
  const st = State.audit || {};
  window.open('/api/admin/oplogs/export' + (st.userNo ? '?userNo=' + encodeURIComponent(st.userNo) : ''), '_blank');
};
window.auditForUser = function (userNo) {
  State.audit = { userNo, action: '', scope: '', page: 1, size: 50 };
  stopPoll(); State.view = 'audit'; State.current = null; renderNav(); navigate('audit');
};
window.revertOp = function (btn, oplogId) {
  askNote({
    title: '确认撤回这条操作？',
    placeholder: '可以填一句说明，会记录在审计日志里（例如：客户申请撤销，已电话核实）',
    okText: '确认撤回', danger: true,
    onOk: async (note) => {
      const d = await api('/api/admin/revert', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oplogId, note }) });
      toast('撤回完成：' + d.message);
      refresh(); vAudit();
    }
  });
};
window.decideRevert = function (btn, id, approve) {
  askNote({
    title: approve ? '批准并执行撤回？' : '驳回这条撤回申请？',
    placeholder: approve ? '可填一句说明，会写进审计日志' : '可填一句理由（申请人会看到）',
    okText: approve ? '批准并撤回' : '确认驳回',
    danger: !approve,
    onOk: async (note) => {
      const d = await api('/api/admin/revert-decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, approve, note }) });
      toast(d.reject ? '已驳回' : '已执行撤回：' + d.message);
      refresh(); vAudit();
    }
  });
};

/* ================= 金标评估 / 经验库 ================= */
async function vEval() {
  const list = (State.global && State.global.evals) || [];
  let pf = null;
  try { pf = await api('/api/eval/preflight'); } catch (e) { /* 忽略 */ }
  const vrows = (pf && pf.verifiers) || [];
  const roleRows = vrows.map(v => `
    <tr>
      <td><label class="row-check">
        <input type="checkbox" class="ev-role" value="${esc(v.role)}" ${v.usable ? 'checked' : 'disabled'}>
        <span><b>${esc(v.label)}</b><div class="hint">${v.role}</div></span>
      </label></td>
      <td>${v.lensLabel ? `<span class="badge b-blue">${esc(v.lensLabel)}</span><div class="hint" title="${esc(v.lensDesc || '')}">${esc((v.lensDesc || '').slice(0, 46))}…</div>` : '<span class="hint">—</span>'}</td>
      <td>${v.usable ? `<span class="badge b-green">可用</span><div class="hint">将用：${esc(v.provider || '')} / ${esc(v.model)}（${esc(v.modelSource || '')}）</div>` : '<span class="badge b-red">不可用</span><div class="hint">该岗位没有可用 API Key，请到「API 池」配置</div>'}</td>
      <td><div class="hint">${(v.candidates || []).map(c => esc(c.providerName) + (c.hasKey ? '' : '（缺Key）') + ' → ' + esc(c.model)).join('<br>') || '未绑定供应商'}</div></td>
    </tr>`).join('');
  const lensOf = vrows.filter(v => v.usable).map(v => v.lensLabel).filter(Boolean);
  const dupLens = [...new Set(lensOf.filter((x, i) => lensOf.indexOf(x) !== i))];
  $('#view').innerHTML = `
    <h1 class="page">金标集评估</h1>
    <div class="page-sub">用已人工验算的真题当考卷，量化质检模型可信度（共识准确率 ≥85% 且未答率 ≤20% 才可自动入库）</div>
    <div class="card"><h3>本次评估将使用（跟随「API 池」的配置，改完即时生效）</h3>
      <table class="tbl"><tr><th style="width:140px">互检岗位</th><th style="width:170px">质检视角</th><th style="width:230px">状态与实际模型</th><th>候选供应商</th></tr>
        ${roleRows || '<tr><td colspan="4" class="hint">没有配置任何质检岗位</td></tr>'}
      </table>
      ${dupLens.length ? `<div class="warn-box" style="margin-top:10px">⚠ 有质检员使用了相同视角（${esc(dupLens.join('、'))}）。相同视角下同一个模型会走同一条推理路径、犯同一个错，分歧信号≈0。</div>` : ''}
      <div class="note-box" style="margin-top:10px">
        <b>质检视角怎么起作用</b>：视角不是换个"人设"，而是换一条<b>解题路径</b> —— 概念派查定义、演算派逐步手算、反证派构造反例、边界派试退化情形、教材派对齐教材口径。
        <div class="hint" style="margin-top:4px">同模型换视角属于「去相关」，能减少共同盲区，但消不掉模型自身的系统性偏差；条件允许时再混一家异构供应商效果最强。</div>
      </div>
      <div class="note-box" style="margin-top:10px">
        <b>金标题库</b>：${pf && pf.golden ? esc(pf.golden.file) + '（' + pf.golden.count + ' 道已验算选择题）' : '未找到，请把金标题库放到 data/golden.js 或用环境变量 QF_GOLDEN 指定'}
      </div>
      <div class="btn-row">
        <button class="btn" onclick="runEval(this)">▶ 运行评估</button>
        <button class="btn ghost" onclick="vEval()">↻ 刷新配置</button>
        <span class="hint">想换供应商或模型？到 <span class="link" onclick="nav('pool')">API 池</span> 改，这里会自动跟随</span>
      </div>
      <div id="eval-out"></div>
    </div>
    ${list.length ? `<div class="card"><h3>历史报告</h3>
      <table class="tbl"><tr><th>时间</th><th>共识准确率</th><th>使用的质检模型</th><th>结论</th></tr>
      ${list.map(e => `<tr>
        <td>${fmtTime(e.ts)}</td>
        <td>${e.accuracy == null ? '—' : e.accuracy + '%'}</td>
        <td><div class="hint">${(e.usedRoles || []).map(r => esc(r.role) + '=' + esc(r.provider || '') + '/' + esc(r.model || '')).join('<br>') || '（旧报告未记录）'}</div></td>
        <td>${e.verdict === 'PASS' ? '✅' : '⚠️'}</td>
      </tr>`).join('')}</table>
      <div class="hint" style="margin-top:6px">注意：历史报告反映的是当时的配置，与当前 API 池设置无关。</div>
    </div>` : ''}`;
}
window.runEval = async function (btn) {
  const roles = [...document.querySelectorAll('.ev-role:checked')].map(x => x.value);
  if (!roles.length) { toast('请至少勾选一个质检岗位'); return; }
  return busy(btn, async () => {
    $('#eval-out').innerHTML = '<div class="hint"><span class="spin"></span>评估运行中（逐题真实调用所选质检模型，题多时较慢）…</div>';
    try {
      const r = await api('/api/eval/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roles }) });
      $('#eval-out').innerHTML = `<pre class="quote-pre">${esc(r.md)}</pre>`;
      toast('评估完成：' + r.verdict);
    } catch (e) { $('#eval-out').innerHTML = `<div class="warn-box">${esc(e.message)}</div>`; }
  });
};
async function vMemory() {
  let mem = [];
  try { mem = await api('/api/memory'); } catch (e) { toast(e.message); return; }
  $('#view').innerHTML = `
    <h1 class="page">经验库（Agent 长期记忆）</h1>
    <div class="page-sub">人工修正与勘误沉淀，出题时按相关度检索注入（不再是无脑取最近几条），Agent 少犯同样的错</div>
    <div class="card"><h3>新增经验</h3>
      <textarea id="mem-text" rows="2" placeholder="如：循环队列题注意判满判空的两种约定（牺牲一个单元 / 用 size 计数），要说明按哪种。"></textarea>
      <div class="filter-row" style="margin-top:8px"><input type="text" id="mem-kp" placeholder="关联考点（可选，便于检索命中）" style="width:220px">
        <button class="btn" onclick="addMem(this)">加入经验库</button></div></div>
    <div class="card"><h3>已有经验（${mem.length}/300）</h3>
      ${mem.length ? `<div class="scroll-y" style="max-height:520px"><table class="tbl"><tr><th>时间</th><th>类型</th><th>内容</th><th>命中</th><th></th></tr>
      ${mem.slice().reverse().map(m => `<tr><td class="nowrap">${new Date(m.ts).toLocaleDateString('zh-CN')}</td><td><span class="badge ${m.kind === 'correction' ? 'b-yellow' : 'b-gray'}">${m.kind === 'correction' ? '人工修正' : '备注'}</span></td><td>${esc(m.text)}${m.kp ? '<div class="hint">考点：' + esc(m.kp) + '</div>' : ''}</td><td class="hint">${m.hits || 1}</td><td><button class="btn sm gray" onclick="delMem(this,'${m.id}')">删</button></td></tr>`).join('')}</table></div>` : '<div class="empty">暂无</div>'}
    </div>`;
}
window.addMem = async function (btn) {
  const t = ($('#mem-text') || {}).value ? $('#mem-text').value.trim() : '';
  if (!t) { toast('请填写经验内容'); return; }
  return busy(btn, async () => {
    try {
      const kp = ($('#mem-kp') || {}).value ? $('#mem-kp').value.trim() : '';
      await api('/api/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'add', text: t, kp }) });
      toast('已加入'); vMemory();
    } catch (e) { toast(e.message); }
  });
};
window.delMem = async function (btn, id) {
  return busy(btn, async () => {
    await api('/api/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'delete', id }) });
    vMemory();
  });
};

/* ================= 用户管理（管理员） ================= */
async function vUsers() {
  if (!Me || Me.role !== 'admin') { $('#view').innerHTML = '<div class="card"><div class="empty">用户管理仅管理员可见</div></div>'; return; }
  const d = await api('/api/admin/users');
  State.usersMe = d.me;
  const admins = d.users.filter(u => u.role === 'admin').length;
  const online = d.users.filter(u => u.online).length;
  const rows = d.users.map(u => `
    <tr>
      <td><b>${esc(u.userNo || '')}</b><div class="hint">${esc(u.username)}${u.isMe ? ' · 我' : ''}</div></td>
      <td>${u.role === 'admin' ? '<span class="badge b-purple">管理员</span>' : '<span class="badge b-gray">普通用户</span>'}</td>
      <td>${u.online ? '<span class="badge b-green">在线</span>' : '<span class="badge b-gray">离线</span>'}<div class="hint">${fmtAgo(u.lastSeen)}</div></td>
      <td>${money(u.balance)}<div class="hint">已消费 ${money(u.spent)}</div></td>
      <td><div class="hint">任务 ${u.tasks} ｜ 资料 ${u.materials}<br>题目 ${u.questions} ｜ 答题 ${u.attempts}</div></td>
      <td><div class="hint">在线 ${fmtDur(u.onlineMs)}<br>签到 ${u.checkinDays} 天（连续最长 ${u.bestStreak}）</div></td>
      <td class="nowrap">
        <button class="btn sm ghost" onclick="auditForUser('${esc(u.userNo)}')">查操作记录</button>
        ${u.role === 'admin'
          ? `<button class="btn sm gray" onclick="setRole(this,${u.id}, 'user')" ${admins <= 1 ? 'disabled title="最后一个管理员不可取消"' : ''}>取消管理员</button>`
          : `<button class="btn sm" onclick="setRole(this,${u.id}, 'admin')">设为管理员</button>`}
      </td>
    </tr>`).join('');
  $('#view').innerHTML = `
    <h1 class="page">用户管理（管理员）</h1>
    <div class="page-sub">共 ${d.users.length} 个账号（${admins} 个管理员，当前在线 ${online} 个）。用户号按注册顺序分配：管理员 admin1 起，普通用户 u1 起；升降级不会改变用户号，便于历史记录追溯。</div>

    <div class="card"><h3>创建管理员账号</h3>
      <div class="hint" style="margin-bottom:8px">平台第一个注册的账号自动是最初的管理员。需要更多管理员时在这里直接创建，或把已有账号「设为管理员」。</div>
      <div class="filter-row">
        <input type="text" id="na-user" placeholder="新管理员用户名（2-20位）" style="width:200px">
        <input type="password" id="na-pwd" placeholder="密码（至少 6 位）" style="width:200px">
        <button class="btn" onclick="createAdmin(this)">创建管理员</button>
        <span class="hint" id="na-msg"></span>
      </div>
    </div>

    <div class="card"><h3>全部账号（${d.users.length}）</h3>
      <div class="scroll-y" style="max-height:640px">
        <table class="tbl"><tr><th>用户号 / 账号</th><th>角色</th><th>状态</th><th>余额</th><th>数据量</th><th>活跃度</th><th></th></tr>${rows}</table>
      </div>
      <div class="hint" style="margin-top:8px">测试脚本创建的账号（如 smoke_ / laoban_ / pool_ 等前缀）可用 <code class="inline">node cleandata.js --yes</code> 清理。</div>
    </div>`;
}
window.createAdmin = async function (btn) {
  const username = $('#na-user').value.trim(), password = $('#na-pwd').value;
  if (!username || !password) { toast('请填写用户名和密码'); return; }
  return busy(btn, async () => {
    $('#na-msg').innerHTML = '<span class="spin"></span>创建中…';
    try {
      const d = await api('/api/admin/create-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      $('#na-msg').innerHTML = '<span style="color:var(--ok)">✓ 已创建管理员 ' + esc(d.username) + '（' + esc(d.userNo || '') + '）</span>';
      toast('管理员已创建：' + d.username);
      vUsers();
    } catch (e) { $('#na-msg').innerHTML = '<span style="color:var(--bad)">✗ ' + esc(e.message) + '</span>'; }
  });
};
window.setRole = async function (btn, userId, role) {
  const self = State.usersMe && State.usersMe.id === userId;
  if (role === 'user') {
    if (self && !confirm('这是你自己的账号。取消后你将立即失去管理权限（API 池、用户管理等页面将不可见）。确定继续？')) return;
    if (!self && !confirm('取消该账号的管理员权限？')) return;
  }
  return busy(btn, async () => {
    try {
      const d = await api('/api/admin/role', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, role }) });
      toast((role === 'admin' ? '已设为管理员' : '已取消管理员') + (d.note ? '（' + d.note + '）' : ''));
      vUsers();
    } catch (e) { toast(e.message); }
  });
};

/* ================= API 池 ================= */
function roleResolved(cfg, role) {
  const prof = (cfg.profiles || {})[role] || {};
  const ov = (prof.modelOverride || '').trim();
  const cands = (prof.providerIds || [])
    .map(id => (cfg.providers || []).find(p => p.id === id))
    .filter(p => p && p.apiKey && p.enabled !== false);
  const pick = cands[0] || (cfg.providers || []).find(p => p.apiKey);
  if (!pick) return { provider: null, model: null, source: '' };
  const pm = (pick.model || '').trim();
  return { provider: pick.name, model: ov || pm || prof.model || '', source: ov ? '岗位覆盖' : (pm ? '供应商默认' : '岗位旧字段') };
}
async function vPool() {
  if (!Me || Me.role !== 'admin') { $('#view').innerHTML = '<div class="card"><div class="empty">API 池仅管理员可见</div></div>'; return; }
  const c = State.config || {};
  const provs = c.providers || [];
  let rt = { providers: [], concurrency: c.concurrency || {}, global: { limit: 0, active: 0, waiting: 0 } };
  try { rt = await api('/api/runtime'); } catch (e) { /* 忽略 */ }
  const rtm = new Map((rt.providers || []).map(x => [x.id, x]));
  const roles = Object.entries(c.profiles || {});
  const provRows = provs.map(p => {
    const r = rtm.get(p.id) || {};
    const bound = roles.filter(([k, v]) => (v.providerIds || []).includes(p.id)).map(([k]) => k);
    const status = !p.apiKey ? '<span class="badge b-red">缺 Key</span>'
      : (r.cooling ? '<span class="badge b-yellow">冷却 ' + r.cooldownSec + 's</span>'
        : (r.active ? '<span class="badge b-blue">使用中 ' + r.active + '</span>' : '<span class="badge b-green">就绪</span>'));
    return `<tr data-pid="${esc(p.id)}">
      <td><input type="text" class="pv-name" value="${esc(p.name)}" style="width:110px"></td>
      <td><input type="text" class="pv-url" value="${esc(p.baseUrl)}" style="width:230px"></td>
      <td><input type="password" class="pv-key" value="${esc(p.apiKey)}" placeholder="sk-..." style="width:150px"></td>
      <td><input type="text" class="pv-model" value="${esc(p.model || '')}" placeholder="默认模型" style="width:130px" title="该供应商的默认模型（岗位绑定到它时自动使用）"></td>
      <td style="width:74px"><input type="number" class="pv-in" value="${p.priceIn}" step="0.5" style="width:64px"></td>
      <td style="width:74px"><input type="number" class="pv-out" value="${p.priceOut}" step="0.5" style="width:64px"></td>
      <td>${status}<div class="hint">成功 ${r.ok || 0} / 失败 ${r.fail || 0}</div></td>
      <td><div class="hint">${bound.join(', ') || '未绑定岗位'}</div>${r.lastErr ? '<div class="hint" style="color:var(--bad)">' + esc(String(r.lastErr).slice(0, 40)) + '</div>' : ''}</td>
      <td class="nowrap">
        <button class="btn sm gray" onclick="testOne(this,'${esc(p.id)}')">测试</button>
        <button class="btn sm danger" onclick="delProvider(this,'${esc(p.id)}')">删</button>
      </td>
    </tr>`;
  }).join('');
  const lensList = c.lenses || [];
  const isVerifier = k => /^verifier/.test(k);
  const lensCell = (k, v) => {
    if (!isVerifier(k)) return '<td class="hint">—</td>';
    const cur = v.lens || '';
    const eff = v.lensId || '';
    const effLabel = (lensList.find(x => x.id === eff) || {}).label || eff;
    const opts = ['<option value="">（默认）</option>'].concat(
      lensList.map(x => `<option value="${esc(x.id)}" ${cur === x.id ? 'selected' : ''}>${esc(x.label)}</option>`)
    ).join('');
    const tip = lensList.find(x => x.id === (cur || eff));
    return `<td><select class="rl-lens" title="${esc(tip ? tip.desc : '')}">${opts}</select>
        <div class="hint" title="${esc(tip ? tip.desc : '')}">生效：${esc(effLabel)}</div></td>`;
  };
  const roleRows = roles.map(([k, v]) => {
    const opts = provs.map(p => `<option value="${esc(p.id)}" ${(v.providerIds || []).includes(p.id) ? 'selected' : ''}>${esc(p.name)}${p.apiKey ? '' : '（缺 Key）'}</option>`).join('');
    const bind = roleResolved(c, k);
    return `<tr data-role="${esc(k)}">
      <td><b>${esc(v.label || k)}</b><div class="hint">${k}</div></td>
      <td><select class="rl-prov" multiple size="3" style="min-width:200px">${opts}</select>
          <div class="hint">可多选：并发时轮换 + 失败自动切换</div></td>
      <td><input type="text" class="rl-model" value="${esc(v.modelOverride || '')}" placeholder="留空=用供应商默认" style="width:150px" title="岗位级模型覆盖：同一供应商要跑不同模型时才填（如识图用 glm-4v-flash）">
          <div class="hint">覆盖（可选）</div></td>
      ${lensCell(k, v)}
      <td>${v.usable ? '<span class="badge b-green">可用</span>' : '<span class="badge b-red">不可用</span>'}
          <div class="hint">实际调用：${esc(bind.provider || '—')} / ${esc(bind.model || '—')}${bind.source ? '（' + esc(bind.source) + '）' : ''}</div></td>
      <td><button class="btn sm gray" onclick="testRole(this,'${esc(k)}')">测试</button><div class="hint" id="rt-${esc(k)}"></div></td>
    </tr>`;
  }).join('');
  $('#view').innerHTML = `
    <h1 class="page">API 池（管理员）</h1>
    <div class="page-sub">集中管理多个供应商密钥：一个岗位可绑定多个 Key，并发时自动轮换分散，某个 Key 失效/被限流时自动切换。API Key 只存服务器本机，页面回显打码。</div>
    <div class="card"><h3>批量导入（一次配好多个 Key）</h3>
      <div class="hint" style="margin-bottom:8px">每行一个供应商，格式：<code class="inline">名称,BaseURL,APIKey[,输入价,输出价,模型名]</code>（也支持制表符/竖线分隔，价格单位：元/百万 tokens，可留空）</div>
      <textarea id="imp-text" rows="4" placeholder="DeepSeek-主,https://api.deepseek.com,sk-xxxxxxxx,2,8,deepseek-chat&#10;DeepSeek-备,https://api.deepseek.com,sk-yyyyyyyy,2,8,deepseek-chat&#10;智谱GLM,https://open.bigmodel.cn/api/paas/v4,xxxxxxxx,1,1,glm-4-flash"></textarea>
      <div class="filter-row" style="margin-top:8px">
        <span class="hint">导入后绑定到：</span>
        <select id="imp-bind"><option value="">不绑定</option>${roles.map(([k, v]) => `<option value="${esc(k)}">${esc(v.label || k)}</option>`).join('')}</select>
        <button class="btn" onclick="importProviders(this)">批量导入</button>
        <span class="hint" id="imp-msg"></span>
      </div>
    </div>
    <div class="card"><h3>供应商（${provs.length} 个）</h3>
      <div class="scroll-x"><table class="tbl"><tr><th>名称</th><th>Base URL</th><th>API Key</th><th>模型</th><th>入价</th><th>出价</th><th>状态</th><th>绑定岗位</th><th></th></tr>
        ${provRows || '<tr><td colspan="9" class="hint">还没有供应商，用上面的批量导入添加</td></tr>'}
      </table></div>
      <div class="btn-row">
        <button class="btn" onclick="saveProviders(this)">保存修改</button>
        <button class="btn ghost" onclick="testAllProviders(this)">测试全部</button>
        <button class="btn gray" onclick="addProviderRow()">+ 新增一行</button>
        <button class="btn gray" onclick="thawAll(this)">清除所有冷却</button>
      </div>
      <div id="pool-msg" class="hint" style="margin-top:8px"></div>
    </div>
    <div class="card"><h3>岗位绑定（模型 + 供应商 + 质检视角）</h3>
      <div class="hint" style="margin-bottom:8px">质检视角决定这个质检员"从哪个角度审题"：概念派查定义、演算派逐步手算、反证派构造反例、边界派试空表/单元素/溢出、教材派对齐教材口径。
        <b>换视角 = 换一条解题路径</b>，所以同一个模型在不同视角下会在不同环节出错 —— 这才是有效的交叉质检。</div>
      <div class="scroll-x"><table class="tbl"><tr><th style="width:120px">岗位</th><th>使用哪些供应商</th><th style="width:190px">模型覆盖</th><th style="width:130px">质检视角</th><th style="width:230px">状态</th><th></th></tr>${roleRows}</table></div>
      <div class="btn-row"><button class="btn" onclick="saveRoles(this)">保存岗位绑定</button>
        <span class="hint">同一岗位选多个供应商即可获得更高的并发吞吐与容错；不同质检员配不同视角即可获得真正的交叉验证</span></div>
      <div id="role-msg" class="hint" style="margin-top:8px"></div>
    </div>
    <div class="card"><h3>并发控制（多用户同时制题时防止打爆供应商）</h3>
      <div class="filter-row">
        <label class="lbl">全局并发上限</label><input type="number" id="cc-global" value="${(rt.concurrency && rt.concurrency.global) || 8}" min="1" max="200" style="width:90px">
        <label class="lbl">单供应商并发上限</label><input type="number" id="cc-per" value="${(rt.concurrency && rt.concurrency.perProvider) || 4}" min="1" max="100" style="width:90px">
        <label class="lbl">失败冷却（秒）</label><input type="number" id="cc-cd" value="${(rt.concurrency && rt.concurrency.cooldownSec) || 30}" min="0" max="600" style="width:90px">
        <button class="btn" onclick="saveConcurrency(this)">保存</button>
      </div>
      <div class="hint" style="margin-top:8px">当前瞬时状态：全局 ${rt.global.active}/${rt.global.limit} 运行中，${rt.global.waiting} 排队${rt.running && rt.running.length ? ' ｜ 运行中任务 ' + rt.running.length + ' 个' : ''} ｜ 单个 Key 失败（401/429/5xx）会自动冷却并切换到同岗位的其它 Key</div>
      <div class="hint">服务版本 ${esc(rt.version || '')} ｜ 已运行 ${fmtDur((rt.uptimeSec || 0) * 1000)}</div>
    </div>`;
}
window.nav = function (v) { stopPoll(); State.view = v; State.current = null; renderNav(); navigate(v); };
window.importProviders = async function (btn) {
  const text = $('#imp-text').value.trim();
  if (!text) { toast('请粘贴供应商信息'); return; }
  return busy(btn, async () => {
    $('#imp-msg').innerHTML = '<span class="spin"></span>导入中…';
    try {
      const d = await api('/api/providers/import', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, bindTo: $('#imp-bind').value }) });
      State.config = d.config;
      await refresh();
      $('#imp-msg').innerHTML = '<span style="color:var(--ok)">✓ 成功导入 ' + d.added.length + ' 个' + (d.failed.length ? '，失败 ' + d.failed.length + ' 个' : '') + '</span>';
      if (d.failed.length) toast('部分行未导入：' + d.failed[0]);
      render();
    } catch (e) { $('#imp-msg').innerHTML = '<span style="color:var(--bad)">✗ ' + esc(e.message) + '</span>'; }
  });
};
window.saveProviders = async function (btn) {
  const rows = [...document.querySelectorAll('tr[data-pid]')];
  const providers = rows.map(r => ({
    id: r.dataset.pid,
    name: r.querySelector('.pv-name').value.trim(),
    baseUrl: r.querySelector('.pv-url').value.trim(),
    apiKey: r.querySelector('.pv-key').value.trim(),
    priceIn: +r.querySelector('.pv-in').value || 0,
    priceOut: +r.querySelector('.pv-out').value || 0,
    model: r.querySelector('.pv-model').value.trim()
  }));
  if (!providers.length) { toast('没有可保存的供应商'); return; }
  return busy(btn, async () => {
    $('#pool-msg').innerHTML = '<span class="spin"></span>保存中…';
    try {
      const d = await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providers }) });
      State.config = d; await refresh();
      $('#pool-msg').innerHTML = '<span style="color:var(--ok)">✓ 已保存</span>';
      toast('API 池已保存'); render();
    } catch (e) { $('#pool-msg').innerHTML = '<span style="color:var(--bad)">✗ ' + esc(e.message) + '</span>'; }
  });
};
window.saveRoles = async function (btn) {
  const profiles = {};
  for (const r of document.querySelectorAll('tr[data-role]')) {
    const sel = r.querySelector('.rl-prov');
    const lensEl = r.querySelector('.rl-lens');
    profiles[r.dataset.role] = {
      modelOverride: r.querySelector('.rl-model').value.trim(),
      providerIds: [...sel.selectedOptions].map(o => o.value),
      lens: lensEl ? lensEl.value : ''
    };
  }
  const vLens = Object.entries(profiles).filter(([k]) => /^verifier/.test(k)).map(([, v]) => v.lens || '');
  const dup = vLens.filter((x, i) => x && vLens.indexOf(x) !== i);
  return busy(btn, async () => {
    $('#role-msg').innerHTML = '<span class="spin"></span>保存中…';
    try {
      const d = await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profiles }) });
      State.config = d; await refresh();
      $('#role-msg').innerHTML = '<span style="color:var(--ok)">✓ 已保存</span>'
        + (dup.length ? '<span style="color:var(--warn)">　⚠ 有质检员视角重复（' + esc([...new Set(dup)].join('、')) + '），交叉质检效果会打折</span>' : '');
      toast('岗位绑定已保存'); render();
    } catch (e) { $('#role-msg').innerHTML = '<span style="color:var(--bad)">✗ ' + esc(e.message) + '</span>'; }
  });
};
window.testAllProviders = async function (btn) {
  const ids = [...document.querySelectorAll('tr[data-pid]')].map(r => r.dataset.pid);
  return busy(btn, async () => {
    $('#pool-msg').innerHTML = '<span class="spin"></span>正在逐个测试（真实调用，稍等）…';
    try {
      const d = await api('/api/providers/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
      const okN = d.results.filter(r => r.ok).length;
      $('#pool-msg').innerHTML = d.results.map(r =>
        (r.ok ? '<span style="color:var(--ok)">✓ ' + esc(r.name) + '（' + r.ms + 'ms）</span>'
              : '<span style="color:var(--bad)">✗ ' + esc(r.name) + '：' + esc(r.error || '') + '</span>')).join('　')
        + '<br>可用 ' + okN + ' / ' + d.results.length;
      toast('测试完成：' + okN + '/' + d.results.length + ' 可用');
      render();
    } catch (e) { $('#pool-msg').innerHTML = '<span style="color:var(--bad)">✗ ' + esc(e.message) + '</span>'; }
  });
};
window.testOne = async function (btn, id) {
  return busy(btn, async () => {
    try {
      const d = await api('/api/providers/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [id] }) });
      const r = d.results[0];
      $('#pool-msg').innerHTML = r.ok ? '<span style="color:var(--ok)">✓ ' + esc(r.name) + ' 可用（' + r.ms + 'ms）</span>'
        : '<span style="color:var(--bad)">✗ ' + esc(r.name) + '：' + esc(r.error || '') + '</span>';
      render();
    } catch (e) { toast(e.message); }
  });
};
window.testRole = async function (btn, key) {
  return busy(btn, async () => {
    $('#rt-' + key).textContent = '测试中…';
    try {
      const d = await api('/api/test-profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
      $('#rt-' + key).textContent = d.ok ? '✓ 连通' : '✗ ' + (d.error || '');
    } catch (e) { $('#rt-' + key).textContent = '✗ ' + e.message; }
  });
};
window.delProvider = async function (btn, id) {
  if (!confirm('删除这个供应商？绑定它的岗位会自动回退到其它可用供应商。')) return;
  return busy(btn, async () => {
    try {
      const d = await api('/api/providers/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      State.config = d.config; await refresh(); toast('已删除'); render();
    } catch (e) { toast(e.message); }
  });
};
window.addProviderRow = function () {
  const tbody = document.querySelector('table.tbl');
  if (!tbody) return;
  const tr = document.createElement('tr');
  tr.dataset.pid = '';
  tr.innerHTML = `<td><input type="text" class="pv-name" placeholder="名称" style="width:110px"></td>
    <td><input type="text" class="pv-url" placeholder="https://..." style="width:230px"></td>
    <td><input type="password" class="pv-key" placeholder="sk-..." style="width:150px"></td>
    <td><input type="text" class="pv-model" placeholder="模型名" style="width:130px"></td>
    <td><input type="number" class="pv-in" value="0" step="0.5" style="width:64px"></td>
    <td><input type="number" class="pv-out" value="0" step="0.5" style="width:64px"></td>
    <td class="hint">新增</td><td class="hint">-</td><td></td>`;
  tbody.appendChild(tr);
};
window.saveConcurrency = async function (btn) {
  return busy(btn, async () => {
    try {
      const d = await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ concurrency: { global: +$('#cc-global').value, perProvider: +$('#cc-per').value, cooldownSec: +$('#cc-cd').value } }) });
      State.config = d; toast('并发参数已保存'); render();
    } catch (e) { toast(e.message); }
  });
};
window.thawAll = async function (btn) {
  return busy(btn, async () => {
    await api('/api/runtime/thaw', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    toast('已清除所有冷却'); render();
  });
};

/* ================= 模型与预算 ================= */
function vSettings() {
  const c = State.config;
  if (!Me || Me.role !== 'admin') { $('#view').innerHTML = '<div class="card"><div class="empty">模型配置仅管理员可见</div></div>'; return; }
  if (!c || !c.profiles) { $('#view').innerHTML = '<div class="card"><div class="empty">配置加载中或不可用，请刷新页面</div></div>'; return; }
  const profRows = Object.entries(c.profiles).map(([k, p]) => `
    <tr><td><b>${esc(p.label || k)}</b><div class="hint">${k}</div></td>
    <td class="hint">${esc((Store_roleResolved(c, k).provider) || '')}<div class="hint">${esc(Store_roleResolved(c, k).model || '')}</div></td>
    <td>${p.usable ? '<span class="badge b-green">可用</span>' : '<span class="badge b-red">未就绪</span>'}</td>
    <td><button class="btn sm gray" onclick="testProf(this,'${esc(k)}')">测试</button><div class="hint" id="pt-${esc(k)}"></div></td></tr>`).join('');
  $('#view').innerHTML = `
    <h1 class="page">模型与预算（管理员）</h1>
    <div class="page-sub">岗位实际调用哪个供应商/模型由「API 池」决定（这里只读展示与连通性测试）。API Key 只存服务器本机，回显打码。</div>
    <div class="card"><h3>岗位实际调用</h3>
      <table class="tbl"><tr><th>岗位</th><th>实际供应商 / 模型</th><th>状态</th><th></th></tr>${profRows}</table>
      <div class="btn-row"><button class="btn ghost" onclick="nav('pool')">到「API 池」修改供应商与模型</button></div>
    </div>
    <div class="card"><h3>报价参数</h3>
      <div class="filter-row"><label class="lbl">利润加成 %</label><input type="number" id="cfg-margin" value="${c.marginPct}" style="width:90px">
        <button class="btn" onclick="saveCfg(this)">保存</button>
        <span class="hint">报价 = 预估成本 ×（1 + 加成%）。资料已按考点分块检索注入，成本估算与实际用量一致。</span></div>
    </div>`;
}
function Store_roleResolved(cfg, role) { return roleResolved(cfg, role); }
window.testProf = async function (btn, k) {
  return busy(btn, async () => {
    $('#pt-' + k).textContent = '测试中…';
    try {
      const r = await api('/api/test-profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: k }) });
      $('#pt-' + k).textContent = r.ok ? '✓ 连通' : '✗ ' + r.error;
    } catch (e) { $('#pt-' + k).textContent = '✗ ' + e.message; }
  });
};
window.saveCfg = async function (btn) {
  return busy(btn, async () => {
    try {
      await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ marginPct: +$('#cfg-margin').value || 0 }) });
      await refresh(); toast('配置已保存'); vSettings();
    } catch (e) { toast(e.message); }
  });
};

/* ================= 启动 ================= */
async function boot() {
  const me = await api('/api/me').catch(() => ({ authed: false }));
  Me = me.authed ? me : null;
  if (Me) await refresh();
}
(async function init() {
  await boot();
  renderNav();
  render();
  /* 心跳：既刷新余额/角标，也让服务端累计在线时长（会话活动时间） */
  setInterval(() => { if (Me) refresh().catch(() => {}); }, 8000);
})();
