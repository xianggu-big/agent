/* 造压测数据（只往测试库写，带硬保护）
 *
 * 用法：
 *   QF_DB_NAME=questionforge_test node seed.js --questions=50000 --users=1000 --tasks=1000
 *   QF_DB_NAME=questionforge_test node seed.js --reset          # 先清掉上次造的数据
 *
 * 设计要点：
 *  1) **拒绝在生产库运行**：库名不含 test 就直接退出 —— 这个项目真实发生过"临时脚本误写生产库"，
 *     所以造数据的脚本第一道防线是把库名写死校验，而不是靠人记得设环境变量。
 *  2) 批量插入：每条 SQL 插 500 行、一个事务提交。一行一条会跑几十分钟。
 *  3) 数据分布贴近真实：4 种题型、12 章、约 40 个考点、难度 1-3、5% 收藏、一部分已有答题记录。
 *  4) 用固定种子的伪随机，保证同一份数据可复现（压测结果才可比）。
 */
'use strict';
const db = require('./lib/db');

const args = {};
process.argv.slice(2).forEach(a => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) args[m[1]] = m[2] === undefined ? true : m[2];
});

const DB = process.env.QF_DB_NAME || db.DB_NAME;
if (!/test/i.test(DB)) {
  console.error('✗ 拒绝执行：目标是数据库「' + DB + '」，它不是测试库。');
  console.error('  造数据脚本只允许写测试库，请显式指定：QF_DB_NAME=questionforge_test node seed.js');
  process.exit(1);
}

const N_Q = Math.min(500000, +(args.questions || 10000));
const N_U = Math.min(50000, +(args.users || 200));
const N_T = Math.min(50000, +(args.tasks || Math.ceil(N_Q / 50)));
const USER = args.user || 'perf_user';
const PWD = 'perf123456';
const BATCH = 500;

/* 固定种子的伪随机（可复现） */
let seed = 20260920;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }

const TYPES = ['mcq', 'solution', 'algo', 'app'];
const KPS = Array.from({ length: 40 }, (_, i) => '考点' + (i + 1) + (['的定义与性质', '的复杂度分析', '的典型应用', '的常见错误'][i % 4]));
const HEAD = ['下列关于', '有关', '在考查', '结合实例说明', '试述'];
const TAIL = ['的说法中正确的是？', '的时间复杂度是多少？', '的适用场景是什么？', '请给出推导过程。', '举一例说明。'];
function stem(i) { return HEAD[i % HEAD.length] + KPS[i % KPS.length] + TAIL[i % TAIL.length] + '（第 ' + i + ' 题）'; }

async function main() {
  await db.init();
  console.log('目标库：' + DB + '（已确认是测试库）');
  console.log('计划写入：questions=' + N_Q + ' users=' + N_U + ' tasks=' + N_T);

  if (args.reset) {
    const t0 = Date.now();
    for (const t of ['attempts', 'qstate', 'questions', 'qchats', 'tasks']) {
      await db.q('DELETE FROM ' + t + ' WHERE user_id IN (SELECT id FROM users WHERE username LIKE ?)', [USER + '%']);
    }
    console.log('已清理上次数据（' + (Date.now() - t0) + 'ms）');
  }

  /* 1) 主测试账号（题库都挂在它名下） */
  let user = await db.findUserByName(USER);
  if (!user) {
    const id = await db.createUser(USER, PWD, { bonus: 10000 });
    user = await db.findUserById(id);
    console.log('已创建测试账号 ' + USER + '（密码 ' + PWD + '）');
  } else {
    console.log('复用已有测试账号 ' + USER);
  }
  const uid = user.id;

  /* 2) 其他用户（只为了 users 表规模，影响管理端聚合查询）
   *    这些账号只用于凑表大小、不需要能登录，所以用固定假散列 —— 真做 scrypt 会白等几十秒 */
  const t1 = Date.now();
  const FAKE_HASH = 'a'.repeat(128), FAKE_SALT = 'b'.repeat(32);
  const existU = Number((await db.q('SELECT COUNT(*) n FROM users'))[0][0].n);
  const needU = Math.max(0, N_U - existU);
  for (let i = 0; i < needU; i += BATCH) {
    const vals = [], ps = [];
    for (let k = 0; k < Math.min(BATCH, needU - i); k++) {
      vals.push('(?,?,?,?,?,?,?)');
      ps.push('filler_' + (existU + i + k), FAKE_HASH, FAKE_SALT, 5, 'user', 'z' + (existU + i + k), Date.now());
    }
    await db.q('INSERT IGNORE INTO users (username,pwd_hash,salt,balance,role,user_no,created_at) VALUES ' + vals.join(','), ps);
  }
  if (needU) console.log('补了 ' + needU + ' 个填充用户（' + (Date.now() - t1) + 'ms）');

  /* 3) 任务 + 题目 */
  const t2 = Date.now();
  const taskIds = [];
  for (let i = 0; i < N_T; i++) {
    const tid = 'perft_' + i;
    taskIds.push(tid);
    await db.q(`INSERT IGNORE INTO tasks (id,user_id,name,subject_json,material_text,requirements_json,quote_json,
      budget,vision_cost,costs_json,progress_json,stats_json,kps_json,covered_json,constraints_json,coverage_strict,
      status,phase,error,exported_json,figures_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [tid, uid, '压测任务 ' + i, JSON.stringify({ school: 'perf', name: '压测科目', chapters: [{ no: 1, name: '第一章' }] }),
        '（压测资料占位）', JSON.stringify([{ types: TYPES, count: 1, kp: KPS[i % KPS.length], diff: 2, ch: (i % 12) + 1 }]),
        JSON.stringify({ est: { total: 0.1, lines: [], totalQ: 50 }, price: 0.3 }), 1, 0,
        JSON.stringify({ spent: 0.05, byProfile: {}, calls: 10, billed: 0.05 }),
        JSON.stringify({ 0: 50 }), null, JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), 0,
        'completed', null, null, null, JSON.stringify([]), Date.now()]);
  }
  console.log('写入任务 ' + N_T + ' 条（' + (Date.now() - t2) + 'ms）');

  /* 4) 题目（分批多行插入） */
  const t3 = Date.now();
  let done = 0;
  while (done < N_Q) {
    const n = Math.min(BATCH, N_Q - done);
    const vals = [], ps = [];
    for (let k = 0; k < n; k++) {
      const i = done + k;
      const type = TYPES[i % TYPES.length];
      const isMcq = type === 'mcq';
      vals.push('(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      ps.push(
        'perfq_' + i, taskIds[i % taskIds.length], uid, type, (i % 12) + 1, KPS[i % KPS.length], (i % 3) + 1,
        stem(i),
        isMcq ? JSON.stringify(['选项甲' + i, '选项乙' + i, '选项丙' + i, '选项丁' + i]) : null,
        isMcq ? 'ABCD'[i % 4] : null,
        isMcq ? '（压测解析）' : null,
        isMcq ? null : '（压测参考答案要点）',
        null, 'accepted', 1, JSON.stringify([{ by: 'verifier1', match: true }, { by: 'verifier2', match: true }]),
        null, JSON.stringify({ model: 'perf' }), null, Date.now() - (i % 3600) * 1000
      );
    }
    await db.q(`INSERT IGNORE INTO questions (id,task_id,user_id,type,ch,kp,diff,stem,options_json,answer,expl,
      ref,fig_id,status,consensus,verdicts_json,human_json,gen_json,dup_of,created_at)
      VALUES ${vals.join(',')}`, ps);
    done += n;
    if (done % 5000 === 0 || done === N_Q) console.log('  题目进度 ' + done + '/' + N_Q);
  }
  const qMs = Date.now() - t3;
  console.log('写入题目 ' + N_Q + ' 条（' + qMs + 'ms，约 ' + Math.round(N_Q / (qMs / 1000)) + ' 行/秒）');

  /* 5) qstate（一半题目有学习状态）+ attempts（有状态的一部分有答题流水） */
  const t4 = Date.now();
  await db.q(`INSERT IGNORE INTO qstate (user_id,question_id,hidden,starred,attempts,wrong,last_right,last_ts)
    SELECT ?, id, 0, IF(RAND()<0.05,1,0), FLOOR(RAND()*6), FLOOR(RAND()*2), FLOOR(RAND()*2), ?
    FROM questions WHERE user_id=? AND id LIKE 'perfq_%' AND CAST(SUBSTRING(id,7) AS UNSIGNED) % 2 = 0 LIMIT 50000`,
    [uid, Date.now(), uid]);
  /* 回填 prio：与迁移 012 完全同一口径。种子数据是直接写 last_right/attempts 的，
   * 不补这一步 prio 会全停在默认值 1，排序就不对了（这个坑在造数据时真踩到过）。 */
  await db.q(`UPDATE qstate SET prio = CASE WHEN last_right=0 THEN 0 WHEN COALESCE(attempts,0)=0 THEN 1
    WHEN last_right=1 THEN 3 ELSE 2 END WHERE user_id=?`, [uid]);
  const attemptsFrom = +(args.attemptsFrom || 0);
  await db.q(`INSERT INTO attempts (user_id,question_id,ts,correct,given,grade)
    SELECT ?, id, ?, FLOOR(RAND()*2), IF(type='mcq', ELT(FLOOR(RAND()*4)+1,'A','B','C','D'), '主观作答'), NULL
    FROM questions WHERE user_id=? AND id LIKE 'perfq_%' LIMIT ?`, [uid, Date.now(), uid, attemptsFrom]);
  const st = await db.q(`SELECT (SELECT COUNT(*) FROM questions WHERE user_id=?) q,
    (SELECT COUNT(*) FROM qstate WHERE user_id=?) s, (SELECT COUNT(*) FROM attempts WHERE user_id=?) a`, [uid, uid, uid]);
  console.log('qstate=' + st[0][0].s + ' attempts=' + st[0][0].a + '（' + (Date.now() - t4) + 'ms）');
  console.log('\n完成。题库共 ' + st[0][0].q + ' 题，账号 ' + USER + ' / ' + PWD);
  console.log('下一步：QF_DB_NAME=' + DB + ' QF_BASE=http://localhost:8541 node loadtest.js --concurrency=30');
  await db.pool.end();
}
main().catch(e => { console.error('造数据失败：' + e.message); process.exit(1); });
