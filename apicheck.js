/* 前后端接口对照检查：确保前端每个调用都能在后端找到路由（防止"没接上"）
 *
 * 原理：不做正则转模板，而是**直接用后端的路由正则去测前端的调用路径**（真值判定）。
 * 同时比对 HTTP 方法，避免"路径对但方法错"（如把 POST 写成 GET）。
 * 用法: node apicheck.js   （退出码非 0 表示有未接通的接口） */
'use strict';
const fs = require('fs');
const path = require('path');
const fe = fs.readFileSync(path.join(__dirname, 'web', 'console.js'), 'utf8');
const be = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

/* ============ 1. 抽取后端路由（路径条件 + 方法 + 正则） ============ */
const routes = [];
/* 1a. 精确路径：(p === '/api/xxx' ... ) 或 (p === '/api/xxx') */
function methodsNear(idx, span) {
  const win = be.slice(idx, idx + span);
  const set = new Set();
  for (const mm of win.matchAll(/req\.method === '([A-Z]+)'/g)) set.add(mm[1]);
  return set;
}
for (const m of be.matchAll(/p === '([^']+)'/g)) {
  routes.push({ type: 'exact', p: m[1], methods: methodsNear(m.index, 500) });
}
/* 1b. 正则路径：const X = p.match(/^\/api\/...$/) */
for (const m of be.matchAll(/const \w+ = p\.match\((\/\^[\s\S]*?\/)\);/g)) {
  routes.push({ type: 'regex', src: m[1].slice(1, -1), methods: methodsNear(m.index, 2500) }); // 去掉 / 定界符
}

/* ============ 2. 抽取前端调用（路径 + 方法） ============ */
const calls = [];
/* api('/x', { method: 'M', ... }) */
for (const m of fe.matchAll(/api\(\s*'([^']+)'([^\n]{0,200})/g)) {
  let p = m[1];
  if (!p.startsWith('/api/')) continue;
  if (p.endsWith('/')) continue;   // 拼接基址（如 '/api/tasks/' + id），由下方拼接分支处理
  p = p.split('?')[0];             // 去掉查询串
  const mm = m[2].match(/method:\s*'([A-Z]+)'/);
  calls.push({ p, method: mm ? mm[1] : 'GET' });
}
/* fetch('/x?y', { method: 'M', body }) */
for (const m of fe.matchAll(/fetch\(\s*'([^']+)'([^\n]{0,200})/g)) {
  let p = m[1].split('?')[0];
  if (!p.startsWith('/api/')) continue;
  if (p.endsWith('/')) continue;   // 拼接基址，由下方拼接分支处理
  const mm = m[2].match(/method:\s*'([A-Z]+)'/);
  calls.push({ p, method: mm ? mm[1] : (m[2].includes('body') ? 'POST' : 'GET') });
}
/* 拼接形式：'/api/tasks/' + id + '/approve'、'/api/auth/' + mode、'/api/materials/' + id */
const CONCAT_VALUES = { mode: ['login', 'register'] }; // 变量取值（从代码中确定）
for (const m of fe.matchAll(/'(\/api\/[a-zA-Z\/]+)'\s*\+\s*(\w+)(?:\s*\+\s*'\/([a-z]+)')?/g)) {
  const base = m[1], v = m[2], suffix = m[3];
  const vals = CONCAT_VALUES[v] || [':id'];
  const ctx = fe.slice(m.index, m.index + 260);
  const mm = ctx.match(/method:\s*'([A-Z]+)'/);
  for (const val of vals) calls.push({ p: (base + val + (suffix ? '/' + suffix : '')), method: mm ? mm[1] : null, dynamic: true });
}

/* ============ 3. 逐个匹配 ============ */
function matchRoute(call) {
  const hits = [];
  for (const r of routes) {
    let ok = false;
    if (r.type === 'exact') ok = r.p === call.p;
    else { try { ok = new RegExp(r.src).test(call.p); } catch (e) { ok = false; } }
    if (ok) hits.push(r);
  }
  if (!hits.length) return { ok: false };
  /* 方法校验：能找到方法匹配（或任一方未标注方法）的即为通过 */
  const names = new Set();
  for (const h of hits) for (const x of (h.methods || [])) names.add(x);
  const methodOk = !call.method || names.size === 0 || names.has(call.method);
  return { ok: true, methodOk, method: [...names].join('/') || '?', callMethod: call.method };
}

/* 去重（同路径同方法） */
const seen = new Set();
const uniq = [];
for (const c of calls) {
  const k = c.p + ' ' + (c.method || '?');
  if (seen.has(k)) continue;
  seen.add(k); uniq.push(c);
}

const missing = [], methodBad = [], wired = [];
for (const c of uniq.sort((a, b) => a.p.localeCompare(b.p))) {
  const r = matchRoute(c);
  if (!r.ok) missing.push(c);
  else if (!r.methodOk) methodBad.push({ c, route: r.method });
  else wired.push(c);
}

console.log('前端调用 ' + uniq.length + ' 个 ｜ 后端路由 ' + routes.length + ' 条\n');
console.log('✅ 路径与方法都匹配（' + wired.length + '）：');
for (const c of wired) console.log('   ' + (c.method || '?').padEnd(5) + c.p + (c.dynamic ? '   [动态拼接]' : ''));
if (methodBad.length) {
  console.log('\n⚠️  路径匹配但方法可能不一致（' + methodBad.length + '）：');
  for (const m of methodBad) console.log('   ' + m.c.method + ' ' + m.c.p + '  后端为 ' + m.route);
}
if (missing.length) {
  console.log('\n❌ 前端调用但后端无对应路由（会返回"未知接口"）（' + missing.length + '）：');
  for (const c of missing) console.log('   ' + (c.method || '?').padEnd(5) + c.p);
  process.exit(1);
}
console.log('\n全部接口已接通。' + (methodBad.length ? '（注意上面方法提示）' : ''));
