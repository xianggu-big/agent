/* 安全清理：只删除测试账号及其数据，绝不触碰真实用户
 *
 * 为什么需要这个脚本：开发期清理测试数据时，如果用 DELETE FROM users 这类全表删除，
 * 会把真实用户的账号/余额/操作记录一起抹掉（本项目开发过程中真实发生过）。
 * 因此这里只删**用户名匹配测试前缀**的账号，且默认只做"预演"，需显式 --yes 才真正删除。
 *
 * 用法：
 *   node cleandata.js            预演：列出将被删除的测试账号与数据量（不删任何东西）
 *   node cleandata.js --yes      真正执行删除（仅限测试账号）
 */
'use strict';
const db = require('./lib/db');

/* 测试账号前缀（测试脚本创建的账号都带这些前缀） */
const TEST_PREFIXES = ['bgtest_', 'uitest', 'pool_admin_', 'pool_user_', 'pool_', 'newadmin_', 'adminperm_', 'weak_', 'pf_', 'pfother_', 'dbg', 'acct_a_', 'acct_b_', 'logout_', 'acct_', 'selftest_', 'libtest_', 'otherlib_', 'other_man', 'laoban', 'xuesheng', 'qiong', 'ceshi_user', 'mat_tester', 'journey_', 'e2e_'];

function isTestUser(name) {
  return TEST_PREFIXES.some(p => String(name).startsWith(p));
}

(async () => {
  await db.init();
  const apply = process.argv.includes('--yes');

  const [users] = await db.q('SELECT id, username, balance, role, created_at FROM users ORDER BY id');
  const testUsers = users.filter(u => isTestUser(u.username));
  const realUsers = users.filter(u => !isTestUser(u.username));

  console.log('数据库中共 ' + users.length + ' 个账号\n');
  console.log('真实用户（' + realUsers.length + ' 个，绝不删除）：');
  if (!realUsers.length) console.log('  （无）');
  for (const u of realUsers) {
    const [o] = await db.q('SELECT COUNT(*) c FROM oplogs WHERE user_id=?', [u.id]);
    const [m] = await db.q('SELECT COUNT(*) c FROM materials WHERE user_id=?', [u.id]);
    const [t] = await db.q('SELECT COUNT(*) c FROM tasks WHERE user_id=?', [u.id]);
    console.log('  · ' + u.username + '  余额 ¥' + (+u.balance).toFixed(2) + ' ｜ 资料 ' + m[0].c + ' ｜ 任务 ' + t[0].c + ' ｜ 操作记录 ' + o[0].c);
  }
  console.log('\n测试账号（' + testUsers.length + ' 个' + (apply ? '，将删除' : '，预演不删') + '）：');
  if (!testUsers.length) console.log('  （无）');
  for (const u of testUsers) console.log('  · ' + u.username + '（id=' + u.id + '）');

  if (!apply) {
    const [orph] = await db.q('SELECT COUNT(*) c FROM oplogs WHERE user_id NOT IN (SELECT id FROM users)');
    const [orphEv] = await db.q('SELECT COUNT(*) c FROM events WHERE user_id NOT IN (SELECT id FROM users)');
    if (orph[0].c || orphEv[0].c) {
      console.log('\n另有孤儿数据待清理：操作记录 ' + orph[0].c + ' 条、任务日志 ' + orphEv[0].c + ' 条（所属账号已不存在）');
    }
    console.log('\n这是预演。确认无误后执行：node cleandata.js --yes');
    process.exit(0);
  }

  let n = 0;
  for (const u of testUsers) {
    const [tasks] = await db.q('SELECT id FROM tasks WHERE user_id=?', [u.id]);
    for (const t of tasks) await db.q('DELETE FROM events WHERE task_id=?', [t.id]);
    await db.q('DELETE FROM questions WHERE user_id=?', [u.id]);
    await db.q('DELETE FROM tasks WHERE user_id=?', [u.id]);
    await db.q('DELETE FROM materials WHERE user_id=?', [u.id]);
    await db.q('DELETE FROM figures WHERE user_id=?', [u.id]);
    await db.q('DELETE FROM qstate WHERE user_id=?', [u.id]);
    await db.q('DELETE FROM oplogs WHERE user_id=?', [u.id]);
    await db.q('DELETE FROM sessions WHERE user_id=?', [u.id]);
    await db.q('DELETE FROM users WHERE id=?', [u.id]);
    n++;
  }

  /* 清理孤儿数据：所属账号已不存在的历史记录（手工删账号时容易遗留） */
  const orphaned = {};
  for (const t of ['oplogs', 'events', 'questions', 'tasks', 'materials', 'figures', 'qstate', 'attempts', 'qchats']) {
    const [r] = await db.q('DELETE FROM ' + t + ' WHERE user_id NOT IN (SELECT id FROM users)');
    if (r.affectedRows) orphaned[t] = r.affectedRows;
  }
  const orphanTotal = Object.values(orphaned).reduce((a, b) => a + b, 0);
  if (orphanTotal) {
    console.log('同时清理孤儿数据：' + Object.entries(orphaned).map(([k, v]) => k + ' ' + v + ' 条').join('、'));
  }

  console.log('\n已清理 ' + n + ' 个测试账号（真实用户 ' + realUsers.length + ' 个未受影响）');
  process.exit(0);
})().catch(e => { console.error('清理失败：' + e.message); process.exit(1); });
