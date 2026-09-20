/* MySQL 数据层：连接池 + 建库建表 + 版本化迁移 + 通用查询
 *
 * 设计要点：
 *  - 账号密码、余额、操作记录全部只存数据库；密码 scrypt+盐 不可逆；
 *  - 会话用随机 token，HttpOnly Cookie 下发，7 天过期；同时累计在线时长；
 *  - 任务/题目/事件持久化，用户随时回来继续（解决"切页/重开就丢"）；
 *  - 表结构变化一律走 schema_migrations（版本化、幂等、可审计），
 *    不再依赖"CREATE TABLE IF NOT EXISTS 顺手改老表"（它并不会改老表）。
 *  - 连接参数可用环境变量覆盖（QF_DB_*），测试库用 QF_DB_NAME 与生产隔离。
 */
'use strict';
const mysql = require('mysql2/promise');
const crypto = require('crypto');

/* ---- 连接配置：环境变量优先，缺省值与历史版本保持一致（不影响现有部署） ---- */
const DB_NAME = process.env.QF_DB_NAME || 'questionforge';
const DB_HOST = process.env.QF_DB_HOST || '127.0.0.1';
const DB_PORT = +(process.env.QF_DB_PORT || 3306);
const DB_USER = process.env.QF_DB_USER || 'root';
const DB_PWD = process.env.QF_DB_PASSWORD == null ? '123456' : process.env.QF_DB_PASSWORD;
const DB_POOL = +(process.env.QF_DB_POOL || 10);
/* 会话空闲多久算"在线结束"，以及心跳写入的节流间隔（避免每个请求都写库） */
const HEARTBEAT_THROTTLE_MS = +(process.env.QF_HEARTBEAT_MS || 45000);
/* 单次心跳最多累计多久（防止"关掉浏览器几小时后又打开"被算成在线） */
const HEARTBEAT_MAX_MS = 5 * 60 * 1000;

const pool = mysql.createPool({
  host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PWD,
  database: DB_NAME, waitForConnections: true, connectionLimit: DB_POOL,
  charset: 'utf8mb4', timezone: '+00:00'
});

const q = (sql, params) => pool.query(sql, params);

/* ================= 表结构 ================= */
/* 说明：CREATE TABLE 只负责"全新装库"。已有库的字段变化一律由下方 MIGRATIONS 负责，
 * 因为 CREATE TABLE IF NOT EXISTS 对已存在的表完全不做任何事。 */
async function createTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(32) NOT NULL UNIQUE,
    pwd_hash CHAR(128) NOT NULL,
    salt CHAR(32) NOT NULL,
    balance DECIMAL(12,4) NOT NULL DEFAULT 5.0000,
    role VARCHAR(10) NOT NULL DEFAULT 'user',
    user_no VARCHAR(20) NULL,
    created_at BIGINT NOT NULL,
    UNIQUE KEY uk_user_no (user_no)
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
    token CHAR(64) PRIMARY KEY,
    user_id INT NOT NULL,
    expires_at BIGINT NOT NULL,
    created_at BIGINT NULL,
    last_seen BIGINT NULL,
    duration_ms BIGINT NOT NULL DEFAULT 0,
    ended_at BIGINT NULL,
    revoke_reason VARCHAR(40) NULL,
    ip VARCHAR(45) NULL,
    ua VARCHAR(200) NULL,
    INDEX idx_sess_user (user_id)
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS materials (
    id VARCHAR(40) PRIMARY KEY,
    user_id INT NOT NULL,
    name VARCHAR(160) NOT NULL,
    text LONGTEXT NOT NULL,
    kind VARCHAR(10),
    pages INT, chars INT,
    figure_count INT DEFAULT 0,
    deleted_at BIGINT NULL,
    created_at BIGINT NOT NULL,
    INDEX idx_mat_user (user_id)
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS figures (
    id VARCHAR(64) NOT NULL,
    material_id VARCHAR(40) NOT NULL,
    orig_id VARCHAR(64),
    user_id INT NOT NULL,
    page INT, w INT, h INT, kb DECIMAL(10,1),
    file_path VARCHAR(255) NOT NULL,
    fig_desc MEDIUMTEXT,
    created_at BIGINT NOT NULL,
    /* 主键必须带 material_id：图片 id 形如 p04_img01，只在单份资料内唯一，
     * 不同资料之间会重名（旧实现只拿 id 做主键，导致后一份资料的图"挂"在前一份上）。 */
    PRIMARY KEY (material_id, id),
    INDEX idx_fig_mat (material_id)
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS tasks (
    id VARCHAR(40) PRIMARY KEY,
    user_id INT NOT NULL,
    name VARCHAR(160) NOT NULL,
    subject_json JSON,
    material_text LONGTEXT,
    requirements_json JSON,
    quote_json JSON,
    budget DECIMAL(12,4) DEFAULT 0,
    vision_cost DECIMAL(12,4) DEFAULT 0,
    costs_json JSON, progress_json JSON, stats_json JSON,
    kps_json JSON,
    covered_json JSON,
    constraints_json JSON,
    coverage_strict TINYINT(1) NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL,
    phase VARCHAR(20), error TEXT,
    exported_json JSON,
    figures_json JSON,
    created_at BIGINT NOT NULL,
    INDEX idx_task_user (user_id)
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS questions (
    id VARCHAR(40) PRIMARY KEY,
    task_id VARCHAR(40) NOT NULL,
    user_id INT NOT NULL,
    type VARCHAR(10), ch INT, kp VARCHAR(160), diff INT,
    stem MEDIUMTEXT, options_json JSON, answer VARCHAR(4), expl TEXT,
    ref MEDIUMTEXT, fig_id VARCHAR(64),
    status VARCHAR(20), consensus TINYINT(1),
    verdicts_json JSON, human_json JSON, gen_json JSON,
    dup_of VARCHAR(40) NULL,
    created_at BIGINT NOT NULL,
    INDEX idx_q_task (task_id), INDEX idx_q_user (user_id, status)
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    task_id VARCHAR(40), user_id INT, ts BIGINT,
    step VARCHAR(30), level VARCHAR(10), msg TEXT, usage_json JSON,
    INDEX idx_ev_task (task_id)
  ) ENGINE=InnoDB`);
  /* 操作记录：scope 区分"用户自己的操作"与"管理员操作"，两者在界面上分开呈现；
   * user_no 冗余存一份，便于按用户号一条 SQL 直查（不必每次都 join users）；
   * meta_json 存结构化参数，撤销（撤回）功能靠它精确还原，而不是解析中文描述。 */
  await pool.query(`CREATE TABLE IF NOT EXISTS oplogs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL, ts BIGINT NOT NULL,
    user_no VARCHAR(20) NULL,
    scope VARCHAR(10) NOT NULL DEFAULT 'user',
    action VARCHAR(30) NOT NULL, detail VARCHAR(500),
    meta_json JSON,
    revertible TINYINT(1) NOT NULL DEFAULT 0,
    reverted TINYINT(1) NOT NULL DEFAULT 0,
    revert_of INT NULL,
    ip VARCHAR(45) NULL,
    INDEX idx_op_user (user_id, scope, id),
    INDEX idx_op_no (user_no, id),
    INDEX idx_op_action (action, id)
  ) ENGINE=InnoDB`);
  /* prio = 复习优先级（0 错题 / 1 未做 / 2 半会 / 3 已会）。
   * 它是从 last_right/attempts 推导出来的，之所以冗余存一列，是为了让"按优先级取题"
   * 能走索引、避免每次请求都对全库 filesort（见迁移 012 的说明）。 */
  await pool.query(`CREATE TABLE IF NOT EXISTS qstate (
    user_id INT NOT NULL,
    question_id VARCHAR(40) NOT NULL,
    hidden TINYINT(1) NOT NULL DEFAULT 0,
    starred TINYINT(1) DEFAULT 0,
    attempts INT DEFAULT 0, wrong INT DEFAULT 0,
    last_right TINYINT(1) DEFAULT NULL,
    last_ts BIGINT,
    prio TINYINT NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, question_id),
    /* 这条索引和题库列表的 ORDER BY 逐字段对应（含方向），因此能沿索引顺序取数、命中 LIMIT 即停。
     * 一旦 ORDER BY 里混入 questions 表的字段，MySQL 就必须排序 —— 这是 125ms 与 0.8ms 的差别。 */
    INDEX idx_qstate_sort (user_id, prio, last_ts DESC, question_id),
    /* 汇总统计的覆盖索引：counts 的 5 个聚合只用到这几个小列，走覆盖索引就不用回表 */
    INDEX idx_qstate_agg (user_id, hidden, starred, attempts, wrong, last_right)
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS attempts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL, question_id VARCHAR(40) NOT NULL,
    ts BIGINT NOT NULL, correct TINYINT NOT NULL,
    given VARCHAR(300), grade DECIMAL(3,2),
    INDEX idx_att_user (user_id, ts), INDEX idx_att_q (user_id, question_id)
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS qchats (
    user_id INT NOT NULL, question_id VARCHAR(40) NOT NULL,
    msgs JSON, updated_at BIGINT,
    PRIMARY KEY (user_id, question_id)
  ) ENGINE=InnoDB`);
  /* 账务流水（只增不改）：每次扣费/充值/退回都留一条，
   * idem_key 唯一键保证"同一件事只扣一次"（幂等），这是修掉"重复扣费/漏扣费"的关键。 */
  await pool.query(`CREATE TABLE IF NOT EXISTS bills (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL, user_no VARCHAR(20) NULL,
    task_id VARCHAR(40) NULL,
    kind VARCHAR(20) NOT NULL,
    amount DECIMAL(12,4) NOT NULL,
    shortfall DECIMAL(12,4) NOT NULL DEFAULT 0,
    balance_after DECIMAL(12,4) NULL,
    reason VARCHAR(255),
    idem_key VARCHAR(90) NULL,
    reverted TINYINT(1) NOT NULL DEFAULT 0,
    ts BIGINT NOT NULL,
    UNIQUE KEY uk_bill_idem (idem_key),
    INDEX idx_bill_user (user_id, id)
  ) ENGINE=InnoDB`);
  /* 签到 */
  await pool.query(`CREATE TABLE IF NOT EXISTS checkins (
    user_id INT NOT NULL,
    day CHAR(10) NOT NULL,
    ts BIGINT NOT NULL,
    streak INT NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, day),
    INDEX idx_ck_day (day)
  ) ENGINE=InnoDB`);
  /* 知识点：由 AI 从资料中抽取，出题时作为参考与覆盖校验的依据。
   * material_id 为空表示来自"粘贴文本"的临时知识点。 */
  await pool.query(`CREATE TABLE IF NOT EXISTS kps (
    id VARCHAR(40) PRIMARY KEY,
    user_id INT NOT NULL,
    material_id VARCHAR(40) NULL,
    task_id VARCHAR(40) NULL,
    ch INT NULL,
    name VARCHAR(160) NOT NULL,
    detail TEXT,
    weight INT NOT NULL DEFAULT 1,
    source VARCHAR(10) NOT NULL DEFAULT 'ai',
    created_at BIGINT NOT NULL,
    INDEX idx_kp_user (user_id, material_id),
    INDEX idx_kp_task (task_id)
  ) ENGINE=InnoDB`);
  /* 撤销申请：用户申请撤回自己的某个操作，管理员在此审批并执行补偿动作。 */
  await pool.query(`CREATE TABLE IF NOT EXISTS revert_requests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL, user_no VARCHAR(20) NULL,
    oplog_id INT NOT NULL,
    action VARCHAR(30) NULL,
    reason VARCHAR(300),
    status VARCHAR(12) NOT NULL DEFAULT 'pending',
    admin_id INT NULL, admin_note VARCHAR(300),
    created_at BIGINT NOT NULL, done_at BIGINT NULL,
    INDEX idx_rr_status (status, id),
    INDEX idx_rr_user (user_id, id)
  ) ENGINE=InnoDB`);
}

/* ================= 版本化迁移 =================
 * 每个迁移只做一件事、可重复执行（先探测再改），执行过的版本记在 schema_migrations。 */
const MIGRATIONS = [
  {
    id: '002_oplogs_scope',
    desc: 'oplogs 增加 scope/user_no/meta/revert 字段（区分用户与管理员操作、支持撤回）',
    async run() {
      await addColumn('oplogs', 'user_no', "ALTER TABLE oplogs ADD COLUMN user_no VARCHAR(20) NULL");
      await addColumn('oplogs', 'scope', "ALTER TABLE oplogs ADD COLUMN scope VARCHAR(10) NOT NULL DEFAULT 'user'");
      await addColumn('oplogs', 'meta_json', "ALTER TABLE oplogs ADD COLUMN meta_json JSON");
      await addColumn('oplogs', 'revertible', "ALTER TABLE oplogs ADD COLUMN revertible TINYINT(1) NOT NULL DEFAULT 0");
      await addColumn('oplogs', 'reverted', "ALTER TABLE oplogs ADD COLUMN reverted TINYINT(1) NOT NULL DEFAULT 0");
      await addColumn('oplogs', 'revert_of', "ALTER TABLE oplogs ADD COLUMN revert_of INT NULL");
      await addColumn('oplogs', 'ip', "ALTER TABLE oplogs ADD COLUMN ip VARCHAR(45) NULL");
      await addIndex('oplogs', 'idx_op_no', 'ALTER TABLE oplogs ADD INDEX idx_op_no (user_no, id)');
      await addIndex('oplogs', 'idx_op_action', 'ALTER TABLE oplogs ADD INDEX idx_op_action (action, id)');
    }
  },
  {
    id: '003_sessions_online',
    desc: 'sessions 增加在线时长统计字段',
    async run() {
      await addColumn('sessions', 'created_at', 'ALTER TABLE sessions ADD COLUMN created_at BIGINT NULL');
      await addColumn('sessions', 'last_seen', 'ALTER TABLE sessions ADD COLUMN last_seen BIGINT NULL');
      await addColumn('sessions', 'duration_ms', 'ALTER TABLE sessions ADD COLUMN duration_ms BIGINT NOT NULL DEFAULT 0');
      await addColumn('sessions', 'ended_at', 'ALTER TABLE sessions ADD COLUMN ended_at BIGINT NULL');
      await addColumn('sessions', 'revoke_reason', 'ALTER TABLE sessions ADD COLUMN revoke_reason VARCHAR(40) NULL');
      await addColumn('sessions', 'ip', 'ALTER TABLE sessions ADD COLUMN ip VARCHAR(45) NULL');
      await addColumn('sessions', 'ua', 'ALTER TABLE sessions ADD COLUMN ua VARCHAR(200) NULL');
    }
  },
  {
    id: '004_materials_softdelete',
    desc: 'materials 增加 deleted_at（软删除，删除后可撤销恢复）',
    async run() {
      await addColumn('materials', 'deleted_at', 'ALTER TABLE materials ADD COLUMN deleted_at BIGINT NULL');
    }
  },
  {
    id: '005_questions_dup',
    desc: 'questions 增加 dup_of（标记近似重复题，不参与自动入库）',
    async run() {
      await addColumn('questions', 'dup_of', 'ALTER TABLE questions ADD COLUMN dup_of VARCHAR(40) NULL');
    }
  },
  {
    id: '006_tasks_kps',
    desc: 'tasks 增加 kps_json（本题任务参考的知识点清单）',
    async run() {
      await addColumn('tasks', 'kps_json', 'ALTER TABLE tasks ADD COLUMN kps_json JSON');
    }
  },
  {
    id: '007_user_no_backfill',
    desc: 'users 增加 user_no 并按注册顺序回填：管理员 admin1..，普通用户 u1..',
    async run() {
      /* 老库的 users 表没有这一列（CREATE TABLE IF NOT EXISTS 不会改老表），先补列 */
      await addColumn('users', 'user_no', 'ALTER TABLE users ADD COLUMN user_no VARCHAR(20) NULL');
      const [rows] = await pool.query('SELECT id, role, user_no FROM users ORDER BY id');
      let adminSeq = 0, userSeq = 0;
      for (const r of rows) {
        if (r.user_no) {           // 已分配过的不再改动（user_no 是不可变身份标识）
          if (/^admin(\d+)$/.test(r.user_no)) adminSeq = Math.max(adminSeq, +RegExp.$1);
          else if (/^u(\d+)$/.test(r.user_no)) userSeq = Math.max(userSeq, +RegExp.$1);
          continue;
        }
        const no = r.role === 'admin' ? 'admin' + (++adminSeq) : 'u' + (++userSeq);
        await pool.query('UPDATE users SET user_no=? WHERE id=?', [no, r.id]);
      }
      /* 唯一键：NULL 不参与唯一约束，回填后补上索引（新库已在 CREATE TABLE 里定义） */
      await addIndex('users', 'uk_user_no', 'ALTER TABLE users ADD UNIQUE KEY uk_user_no (user_no)');
    }
  },
  {
    id: '008_oplog_backfill',
    desc: '给历史操作记录补 user_no 与 scope（管理员专属动作标记为 admin）',
    async run() {
      await pool.query(`UPDATE oplogs o JOIN users u ON u.id=o.user_id
        SET o.user_no=u.user_no WHERE o.user_no IS NULL`);
      const ADMIN_ONLY = ['provider_add', 'provider_del', 'provider_import', 'provider_test',
        'admin_create', 'admin_role', 'role', 'grant', 'config', 'eval', 'memory', 'revert'];
      await pool.query(`UPDATE oplogs SET scope='admin' WHERE scope='user' AND action IN (${ADMIN_ONLY.map(() => '?').join(',')})`, ADMIN_ONLY);
    }
  },
  {
    id: '009_tasks_covered',
    desc: 'tasks 增加 covered_json（已取材的资料块下标，续跑时接着覆盖未用过的部分）',
    async run() {
      await addColumn('tasks', 'covered_json', 'ALTER TABLE tasks ADD COLUMN covered_json JSON');
    }
  },
  {
    id: '013_qstate_sort_index',
    desc: 'qstate 换成与 ORDER BY 逐字段匹配的 (user_id,prio,last_ts DESC,question_id) 索引；hidden 改 NOT NULL；清理非已采纳题的多余 qstate 行',
    async run() {
      await pool.query('UPDATE qstate SET hidden=0 WHERE hidden IS NULL');
      try { await pool.query('ALTER TABLE qstate MODIFY hidden TINYINT(1) NOT NULL DEFAULT 0'); } catch (e) { /* 已是 NOT NULL */ }
      await pool.query('ALTER TABLE qstate DROP INDEX idx_qstate_prio').catch(() => {});
      await addIndex('qstate', 'idx_qstate_sort', 'ALTER TABLE qstate ADD INDEX idx_qstate_sort (user_id, prio, last_ts DESC, question_id)');
      await addIndex('qstate', 'idx_qstate_agg', 'ALTER TABLE qstate ADD INDEX idx_qstate_agg (user_id, hidden, starred, attempts, wrong, last_right)');
      /* 不变式清洗：非已采纳的题不该留在 qstate 里（否则题库列表会把它们列出来） */
      await pool.query(`DELETE s FROM qstate s JOIN questions q ON q.id=s.question_id AND q.user_id=s.user_id
        WHERE q.status NOT IN ('accepted','auto_accepted')`);
    }
  },
  {
    id: '012_qstate_prio',
    desc: 'qstate 增加物化优先级 prio + (user_id,prio,last_ts) 索引，消除题库列表的全量 filesort',
    async run() {
      await addColumn('qstate', 'prio', 'ALTER TABLE qstate ADD COLUMN prio TINYINT NOT NULL DEFAULT 1');
      await addIndex('qstate', 'idx_qstate_prio', 'ALTER TABLE qstate ADD INDEX idx_qstate_prio (user_id, prio, last_ts)');
      /* 回填：与旧 CASE 表达式完全等价的口径 */
      await pool.query(`UPDATE qstate SET prio = CASE
          WHEN last_right = 0 THEN 0
          WHEN COALESCE(attempts,0) = 0 THEN 1
          WHEN last_right = 1 THEN 3
          ELSE 2 END`);
      /* 不变式：每道已采纳的题都要有 qstate 行，否则"从 qstate 驱动"的查询会漏题 */
      await pool.query(`INSERT IGNORE INTO qstate (user_id, question_id, hidden, starred, attempts, wrong, last_right, last_ts, prio)
        SELECT q.user_id, q.id, 0, 0, 0, 0, NULL, NULL, 1 FROM questions q
        WHERE q.status IN ('accepted','auto_accepted')`);
    }
  },
  {
    id: '011_tasks_constraints',
    desc: 'tasks 增加 constraints_json / coverage_strict（客户额外要求与"必须覆盖全部知识点"）',
    async run() {
      await addColumn('tasks', 'constraints_json', 'ALTER TABLE tasks ADD COLUMN constraints_json JSON');
      await addColumn('tasks', 'coverage_strict', 'ALTER TABLE tasks ADD COLUMN coverage_strict TINYINT(1) NOT NULL DEFAULT 0');
    }
  },
  {
    id: '010_figures_pk',
    desc: 'figures 主键改为 (material_id, id)：图片 id 形如 p04_img01，只在单份资料内唯一',
    async run() {
      /* 旧主键只有 id，于是"另一份资料里同样叫 p04_img01 的图"会被当成同一行，
       * ON DUPLICATE 只更新了描述/路径，material_id 与 user_id 仍指向最早那份资料 ——
       * 表现为"图片随资料归档了，但按 materialId 却列不出来"，题目也就挂不上原图。 */
      const [cols] = await pool.query(
        "SELECT COUNT(*) c FROM information_schema.key_column_usage WHERE table_schema=? AND table_name='figures' AND constraint_name='PRIMARY' AND column_name='material_id'",
        [DB_NAME]);
      if (!cols[0].c) {
        await pool.query('ALTER TABLE figures DROP PRIMARY KEY, ADD PRIMARY KEY (material_id, id)');
      }
      await addIndex('figures', 'idx_fig_mat', 'ALTER TABLE figures ADD INDEX idx_fig_mat (material_id)');
    }
  }
];

async function addColumn(table, col, ddl) {
  const [rows] = await pool.query(
    'SELECT COUNT(*) c FROM information_schema.columns WHERE table_schema=? AND table_name=? AND column_name=?',
    [DB_NAME, table, col]);
  if (!rows[0].c) await pool.query(ddl);
}
async function addIndex(table, name, ddl) {
  const [rows] = await pool.query(
    'SELECT COUNT(*) c FROM information_schema.statistics WHERE table_schema=? AND table_name=? AND index_name=?',
    [DB_NAME, table, name]);
  if (!rows[0].c) {
    try { await pool.query(ddl); } catch (e) { /* 并发/重复创建时忽略 */ }
  }
}

async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(40) PRIMARY KEY, descr VARCHAR(200), applied_at BIGINT NOT NULL
  ) ENGINE=InnoDB`);
  const [done] = await pool.query('SELECT version FROM schema_migrations');
  const has = new Set(done.map(r => r.version));
  /* 基线：老库的表已存在且字段由后续迁移补齐，这里只补记一条"基线"记录 */
  if (!has.size) {
    await pool.query('INSERT IGNORE INTO schema_migrations (version, descr, applied_at) VALUES (?,?,?)',
      ['001_baseline', '初始表结构（由 CREATE TABLE IF NOT EXISTS 建立）', Date.now()]);
    has.add('001_baseline');
  }
  for (const m of MIGRATIONS) {
    if (has.has(m.id)) continue;
    try {
      await m.run();
      await pool.query('INSERT IGNORE INTO schema_migrations (version, descr, applied_at) VALUES (?,?,?)', [m.id, m.desc, Date.now()]);
      console.log('[migrate] 已应用 ' + m.id + '：' + m.desc);
    } catch (e) {
      console.error('[migrate] 迁移失败 ' + m.id + '：' + e.message);
      throw e;
    }
  }
}

async function init() {
  const bare = mysql.createPool({ host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PWD, charset: 'utf8mb4' });
  await bare.query('CREATE DATABASE IF NOT EXISTS `' + DB_NAME + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
  await bare.end();
  await createTables();
  await migrate();
}

/* ================= 用户与会话 ================= */
function hashPassword(pwd, salt) {
  return crypto.scryptSync(String(pwd), salt, 64).toString('hex');
}
function newSalt() { return crypto.randomBytes(16).toString('hex'); }
function newToken() { return crypto.randomBytes(32).toString('hex'); }

/* 用户号：按注册顺序分配，管理员 admin1/2/3…，普通用户 u1/2/3…
 * —— 创建时一次性定下，之后即使升降级也不改名（改名会让历史操作记录对不上号）。 */
async function nextUserNo(role) {
  const prefix = role === 'admin' ? 'admin' : 'u';
  const [rows] = await q(
    "SELECT user_no FROM users WHERE user_no LIKE ? ORDER BY LENGTH(user_no) DESC, user_no DESC LIMIT 1",
    [prefix + '%']);
  let n = 0;
  if (rows.length) {
    const m = /^(\d+)$/.exec(String(rows[0].user_no).slice(prefix.length));
    if (m) n = +m[1];
  }
  return prefix + (n + 1);
}

async function createUser(username, password, opts = {}) {
  const salt = newSalt();
  const hash = hashPassword(password, salt);
  const role = opts.role === 'admin' ? 'admin' : 'user';
  const userNo = await nextUserNo(role);
  const [r] = await q('INSERT INTO users (username, pwd_hash, salt, balance, role, user_no, created_at) VALUES (?,?,?,?,?,?,?)',
    [username, hash, salt, opts.bonus == null ? 5.0 : opts.bonus, role, userNo, Date.now()]);
  return r.insertId;
}
async function findUserByName(username) {
  const [rows] = await q('SELECT * FROM users WHERE username=?', [username]);
  return rows[0] || null;
}
async function findUserById(id) {
  const [rows] = await q('SELECT * FROM users WHERE id=?', [id]);
  return rows[0] || null;
}
async function findUserByNo(userNo) {
  const [rows] = await q('SELECT * FROM users WHERE user_no=?', [userNo]);
  return rows[0] || null;
}
/* 会话表很小，缓存 user_no 避免每次写操作记录都 join 一次 */
const userNoCache = new Map();
async function userNoOf(userId) {
  if (userNoCache.has(userId)) return userNoCache.get(userId);
  const [rows] = await q('SELECT user_no FROM users WHERE id=?', [userId]);
  const no = rows.length ? rows[0].user_no : null;
  userNoCache.set(userId, no);
  return no;
}
async function createSession(userId, meta = {}) {
  const token = newToken();
  const now = Date.now();
  const exp = now + 7 * 24 * 3600 * 1000;
  await q('INSERT INTO sessions (token, user_id, expires_at, created_at, last_seen, duration_ms, ip, ua) VALUES (?,?,?,?,?,0,?,?)',
    [token, userId, exp, now, now, meta.ip || null, (meta.ua || '').slice(0, 200) || null]);
  /* 清理：已过期的会话，以及结束超过 90 天的会话。
   * 注意这里"不删刚结束的会话"—— 在线时长按会话累计，退出登录时删行就等于把时长丢了。 */
  await q('DELETE FROM sessions WHERE expires_at < ? OR (ended_at IS NOT NULL AND ended_at < ?)',
    [now, now - 90 * 24 * 3600 * 1000]);
  return token;
}
/* 会话校验 + 在线心跳：返回用户行；超过节流间隔才写库累计在线时长。
 * 已结束（ended_at 非空）的会话立即失效，因此"踢下线"不会被这次改动削弱。 */
async function userBySession(token) {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const now = Date.now();
  const [rows] = await q(`SELECT u.*, s.last_seen AS sess_last_seen, s.created_at AS sess_created
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token=? AND s.expires_at > ? AND s.ended_at IS NULL`, [token, now]);
  if (!rows.length) return null;
  const r = rows[0];
  const last = Number(r.sess_last_seen || r.sess_created || now);
  const gap = now - last;
  if (gap > HEARTBEAT_THROTTLE_MS) {
    /* 只把"确实最近还在活动"的时间计入在线时长，长时间挂机不计。
     * 用一条 UPDATE 在 SQL 里同时读 last_seen 与写 duration_ms（原子），
     * 避免"先读后写"在并发请求下重复累计。 */
    q(`UPDATE sessions SET duration_ms = duration_ms + LEAST(GREATEST(0, ? - COALESCE(last_seen, created_at, ?)), ?),
        last_seen = ? WHERE token=? AND ended_at IS NULL`,
      [now, now, HEARTBEAT_MAX_MS, now, token]).catch(() => {});
  }
  return r;
}
/* 结束会话：先补上最后一段在线时间，再标记 ended_at。
 * 保留行而不是删除，这样"累计在线时长"才能跨退出登录累计（90 天后由 createSession 清理）。 */
async function destroySession(token) {
  const now = Date.now();
  try {
    /* 同样用原子 UPDATE：即使此刻正好有一次心跳写入在途，也不会把同一段时间算两遍 */
    await q(`UPDATE sessions SET
        duration_ms = duration_ms + LEAST(GREATEST(0, ? - COALESCE(last_seen, created_at, ?)), ?),
        ended_at = ?
      WHERE token=? AND ended_at IS NULL`, [now, now, HEARTBEAT_MAX_MS, now, token]);
  } catch (e) { /* 统计失败不影响登出 */ }
}
/* 活跃会话列表（本人可见，用于"换设备后把其它设备踢下线"） */
async function listSessions(userId, currentToken) {
  const [rows] = await q(`SELECT token, created_at, last_seen, duration_ms, ip, ua FROM sessions
    WHERE user_id=? AND expires_at > ? AND ended_at IS NULL ORDER BY last_seen DESC LIMIT 20`, [userId, Date.now()]);
  return rows.map(r => ({
    current: r.token === currentToken,
    tokenTail: String(r.token).slice(-6),
    createdAt: Number(r.created_at || 0), lastSeen: Number(r.last_seen || 0),
    onlineMs: Number(r.duration_ms || 0), ip: r.ip || '', ua: r.ua || ''
  }));
}
/* 踢下线：标记 ended_at 即可失效（不删行，保住已累计的在线时长） */
async function revokeSessions(userId, { keepToken = null } = {}) {
  const now = Date.now();
  const [r] = keepToken
    ? await q('UPDATE sessions SET ended_at=? WHERE user_id=? AND ended_at IS NULL AND token<>?', [now, userId, keepToken])
    : await q('UPDATE sessions SET ended_at=? WHERE user_id=? AND ended_at IS NULL', [now, userId]);
  return r.affectedRows;
}
async function changePassword(userId, newPassword) {
  const salt = newSalt();
  await q('UPDATE users SET pwd_hash=?, salt=? WHERE id=?', [hashPassword(newPassword, salt), salt, userId]);
}

/* ================= 操作记录与余额 ================= */
/* logOp(userId, action, detail, opts)
 *  opts.scope      'user'（本人可见） | 'admin'（仅管理员审计可见）
 *  opts.meta       结构化参数（撤销时用来精确还原）
 *  opts.revertible 是否支持"撤回"
 *  opts.ip         来源 IP
 *  opts.revertOf   本条是"撤销"时，指向被撤销的记录 id
 */
async function logOp(userId, action, detail, opts = {}) {
  const scope = opts.scope || 'user';
  const userNo = await userNoOf(userId).catch(() => null);
  const [r] = await q(`INSERT INTO oplogs (user_id, ts, user_no, scope, action, detail, meta_json, revertible, revert_of, ip)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [userId, Date.now(), userNo, scope, action, String(detail || '').slice(0, 480),
     opts.meta ? JSON.stringify(opts.meta) : null, opts.revertible ? 1 : 0,
     opts.revertOf || null, opts.ip ? String(opts.ip).slice(0, 45) : null]);
  return r.insertId;
}
/* 本人可见的操作记录（不含管理员操作；管理员操作在「审计与撤回」页单独呈现） */
async function listOp(userId, limit, scope) {
  const sc = scope || 'user';
  const [rows] = await q(`SELECT id, ts, action, detail, meta_json, revertible, reverted, revert_of
    FROM oplogs WHERE user_id=? AND scope=? ORDER BY id DESC LIMIT ?`, [userId, sc, limit || 50]);
  return rows;
}
async function getOplog(id) {
  const [rows] = await q('SELECT * FROM oplogs WHERE id=?', [id]);
  return rows[0] || null;
}
async function markOplogReverted(id) {
  await q('UPDATE oplogs SET reverted=1 WHERE id=?', [id]);
}
/* 管理员审计查询：按用户号/动作/范围/时间段过滤 + 分页 */
async function queryOplogs({ userNo, action, scope, from, to, page = 1, size = 50, userId } = {}) {
  const where = [], args = [];
  if (userNo) { where.push('o.user_no=?'); args.push(userNo); }
  if (userId) { where.push('o.user_id=?'); args.push(userId); }
  if (action) { where.push('o.action=?'); args.push(action); }
  if (scope) { where.push('o.scope=?'); args.push(scope); }
  if (from) { where.push('o.ts>=?'); args.push(+from); }
  if (to) { where.push('o.ts<=?'); args.push(+to); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const sizeN = Math.max(1, Math.min(200, +size || 50));
  const pageN = Math.max(1, +page || 1);
  const [[cnt]] = await q(`SELECT COUNT(*) n FROM oplogs o ${w}`, args);
  const [rows] = await q(`SELECT o.id, o.user_id, o.user_no, o.scope, o.action, o.detail, o.meta_json,
      o.revertible, o.reverted, o.revert_of, o.ts, u.username, u.role
    FROM oplogs o LEFT JOIN users u ON u.id=o.user_id
    ${w} ORDER BY o.id DESC LIMIT ${sizeN} OFFSET ${(pageN - 1) * sizeN}`, args);
  return { total: Number(cnt.n) || 0, page: pageN, size: sizeN, rows };
}
/* 可选的动作清单（供审计页下拉筛选） */
async function oplogActions() {
  const [rows] = await q('SELECT action, COUNT(*) n FROM oplogs GROUP BY action ORDER BY n DESC LIMIT 60');
  return rows.map(r => ({ action: r.action, n: Number(r.n) }));
}

/* 扣费：条件更新 + 行锁（FOR UPDATE）保证并发下不会扣成负数。
 * 返回 {deducted, shortfall}，实际扣款可能小于应扣（钳到 0），差额记为欠费。 */
async function deduct(userId, amount, reason) {
  const amt = +(+amount).toFixed(4);
  if (!(amt > 0)) return { deducted: 0, shortfall: 0 };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT balance FROM users WHERE id=? FOR UPDATE', [userId]);
    if (!rows.length) { await conn.rollback(); return { deducted: 0, shortfall: amt }; }
    const have = +rows[0].balance;
    const ded = Math.min(have, amt);
    await conn.query('UPDATE users SET balance = balance - ? WHERE id=?', [ded, userId]);
    await conn.commit();
    if (ded > 0) await logOp(userId, 'deduct', reason + '：扣费 ¥' + ded.toFixed(4) + (ded < amt ? '（余额不足，少扣 ¥' + (amt - ded).toFixed(4) + ' 记为欠费）' : ''));
    return { deducted: ded, shortfall: Math.max(0, amt - ded) };
  } catch (e) {
    try { await conn.rollback(); } catch (_) { /* 忽略 */ }
    throw e;
  } finally { conn.release(); }
}

/* 记账 + 扣费，一步完成且幂等：
 *  同一个 idemKey 重复调用只会真正扣一次（靠 bills.idem_key 唯一键 + 事务）。
 *  这是修掉"任务有分歧就永远不扣费 / 重跑重复扣费"的核心。
 *  kind: task | nlu | vision | explain | recharge | refund | revert */
async function billAndDeduct(userId, { taskId = null, kind = 'other', amount = 0, reason = '', idemKey = null } = {}) {
  const amt = +(+amount).toFixed(4);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const userNo = await userNoOf(userId).catch(() => null);
    let billId = null;
    if (idemKey) {
      try {
        const [ins] = await conn.query(`INSERT INTO bills (user_id, user_no, task_id, kind, amount, shortfall, reason, idem_key, ts)
          VALUES (?,?,?,?,?,0,?,?,?)`, [userId, userNo, taskId, kind, amt, String(reason).slice(0, 250), idemKey, Date.now()]);
        billId = ins.insertId;
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') { await conn.rollback(); return { deducted: 0, shortfall: 0, duplicate: true }; }
        throw e;
      }
    }
    const [rows] = await conn.query('SELECT balance FROM users WHERE id=? FOR UPDATE', [userId]);
    if (!rows.length) { await conn.rollback(); return { deducted: 0, shortfall: amt }; }
    const have = +rows[0].balance;
    const ded = Math.min(have, amt);
    const shortfall = Math.max(0, +(amt - ded).toFixed(4));
    await conn.query('UPDATE users SET balance = balance - ? WHERE id=?', [ded, userId]);
    if (billId) {
      await conn.query('UPDATE bills SET shortfall=?, balance_after=? WHERE id=?', [shortfall, +(have - ded).toFixed(4), billId]);
    } else {
      const [ins] = await conn.query(`INSERT INTO bills (user_id, user_no, task_id, kind, amount, shortfall, balance_after, reason, ts)
        VALUES (?,?,?,?,?,?,?,?,?)`, [userId, userNo, taskId, kind, ded, shortfall, +(have - ded).toFixed(4), String(reason).slice(0, 250), Date.now()]);
      billId = ins.insertId;
    }
    await conn.commit();
    return { deducted: ded, shortfall, billId, duplicate: false };
  } catch (e) {
    try { await conn.rollback(); } catch (_) { /* 忽略 */ }
    throw e;
  } finally { conn.release(); }
}
async function listBills(userId, limit) {
  const [rows] = await q(`SELECT id, task_id, kind, amount, shortfall, balance_after, reason, reverted, ts
    FROM bills WHERE user_id=? ORDER BY id DESC LIMIT ?`, [userId, limit || 50]);
  return rows;
}
async function recharge(userId, amount, reason) {
  const amt = +(+amount).toFixed(4);
  await q('UPDATE users SET balance = balance + ? WHERE id=?', [amt, userId]);
  await q(`INSERT INTO bills (user_id, user_no, task_id, kind, amount, shortfall, reason, ts)
    VALUES (?,?,NULL,'recharge',?,0,?,?)`, [userId, await userNoOf(userId).catch(() => null), -amt, reason || '充值', Date.now()]);
  const id = await logOp(userId, 'recharge', (reason || '充值') + '：+¥' + amt.toFixed(2), { revertible: true, meta: { amount: amt } });
  return { id, amount: amt };
}
async function getBalance(userId) {
  const [rows] = await q('SELECT balance FROM users WHERE id=?', [userId]);
  return rows.length ? +rows[0].balance : 0;
}

/* ================= 签到与在线时长 ================= */
function dayStr(d) {
  const x = d || new Date();
  const p = n => String(n).padStart(2, '0');
  return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate());
}
function prevDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - 1);
  return dayStr(dt);
}
async function checkin(userId) {
  const today = dayStr();
  const [prevRows] = await q('SELECT streak FROM checkins WHERE user_id=? AND day=?', [userId, prevDay(today)]);
  const streak = prevRows.length ? Number(prevRows[0].streak) + 1 : 1;
  const [r] = await q('INSERT IGNORE INTO checkins (user_id, day, ts, streak) VALUES (?,?,?,?)',
    [userId, today, Date.now(), streak]);
  const fresh = r.affectedRows === 1;
  const info = await checkinInfo(userId);
  return { fresh, today, ...info };
}
async function checkinInfo(userId) {
  const today = dayStr();
  const [[me]] = await q('SELECT streak, ts FROM checkins WHERE user_id=? AND day=?', [userId, today]);
  const [[agg]] = await q('SELECT COUNT(*) days, MAX(streak) best FROM checkins WHERE user_id=?', [userId]);
  const [[mon]] = await q('SELECT COUNT(*) n FROM checkins WHERE user_id=? AND day LIKE ?', [userId, today.slice(0, 7) + '%']);
  return {
    checkedToday: !!me,
    todayTs: me ? Number(me.ts) : null,
    streak: me ? Number(me.streak) : 0,
    totalDays: Number(agg.days) || 0,
    bestStreak: Number(agg.best) || 0,
    monthDays: Number(mon.n) || 0,
    onlineMs: await onlineMs(userId)
  };
}
async function onlineMs(userId) {
  const [[r]] = await q('SELECT COALESCE(SUM(duration_ms),0) ms FROM sessions WHERE user_id=?', [userId]);
  return Number(r.ms) || 0;
}
async function checkinBoard(days) {
  const [rows] = await q(`SELECT day, COUNT(*) n FROM checkins WHERE day >= ? GROUP BY day ORDER BY day DESC`, [dayStr(new Date(Date.now() - (days || 14) * 86400000))]);
  return rows.map(r => ({ day: r.day, n: Number(r.n) }));
}

/* ================= 撤销申请 ================= */
async function createRevertRequest(userId, oplogId, reason) {
  const op = await getOplog(oplogId);
  if (!op || op.user_id !== userId) throw new Error('操作记录不存在或不属于你');
  if (!op.revertible) throw new Error('该类型操作不支持撤回');
  if (op.reverted) throw new Error('该操作已经撤回过了');
  const [dup] = await q("SELECT id FROM revert_requests WHERE oplog_id=? AND status='pending'", [oplogId]);
  if (dup.length) throw new Error('这条操作的撤回申请正在处理中');
  const [r] = await q(`INSERT INTO revert_requests (user_id, user_no, oplog_id, action, reason, status, created_at)
    VALUES (?,?,?,?,?,'pending',?)`, [userId, op.user_no, oplogId, op.action, String(reason || '').slice(0, 300), Date.now()]);
  return r.insertId;
}
async function listRevertRequests({ status, userId } = {}) {
  const where = [], args = [];
  if (status) { where.push('r.status=?'); args.push(status); }
  if (userId) { where.push('r.user_id=?'); args.push(userId); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const [rows] = await q(`SELECT r.*, u.username, o.detail AS op_detail, o.ts AS op_ts, o.action AS op_action,
      o.meta_json AS op_meta, o.reverted AS op_reverted
    FROM revert_requests r LEFT JOIN users u ON u.id=r.user_id
    LEFT JOIN oplogs o ON o.id=r.oplog_id ${w} ORDER BY r.id DESC LIMIT 200`, args);
  return rows;
}
async function decideRevertRequest(id, status, adminId, note) {
  await q('UPDATE revert_requests SET status=?, admin_id=?, admin_note=?, done_at=? WHERE id=?',
    [status, adminId, String(note || '').slice(0, 300), Date.now(), id]);
}
async function countPendingReverts() {
  const [[r]] = await q("SELECT COUNT(*) n FROM revert_requests WHERE status='pending'");
  return Number(r.n) || 0;
}

/* ================= 知识点 ================= */
async function saveKPs(userId, materialId, taskId, list) {
  if (materialId) await q('DELETE FROM kps WHERE user_id=? AND material_id=?', [userId, materialId]);
  if (taskId) await q('DELETE FROM kps WHERE user_id=? AND task_id=?', [userId, taskId]);
  const now = Date.now();
  for (const k of list) {
    await q(`INSERT INTO kps (id, user_id, material_id, task_id, ch, name, detail, weight, source, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ['kp_' + crypto.randomBytes(6).toString('hex'), userId, materialId || null, taskId || null,
       k.ch || null, String(k.name).slice(0, 160), String(k.detail || '').slice(0, 600),
       Math.max(1, Math.min(5, +k.weight || 1)), k.source || 'ai', now]);
  }
  return list.length;
}
async function listKPs(userId, { materialId, taskId } = {}) {
  if (materialId) {
    const [rows] = await q('SELECT * FROM kps WHERE user_id=? AND material_id=? ORDER BY ch, id', [userId, materialId]);
    return rows.map(rowToKP);
  }
  if (taskId) {
    const [rows] = await q('SELECT * FROM kps WHERE user_id=? AND task_id=? ORDER BY ch, id', [userId, taskId]);
    return rows.map(rowToKP);
  }
  return [];
}
function rowToKP(r) {
  return { id: r.id, ch: r.ch, name: r.name, detail: r.detail || '', weight: r.weight, source: r.source, materialId: r.material_id, taskId: r.task_id };
}

/* ================= 学习状态（进度/隐藏/收藏） ================= */
async function recordAttempt(userId, questionId, correct, given, grade) {
  const ts = Date.now();
  await q(`INSERT INTO qstate (user_id, question_id, hidden, attempts, wrong, last_right, last_ts, prio)
           VALUES (?,?,0,1,?,?,?,?)
           ON DUPLICATE KEY UPDATE attempts=attempts+1, wrong=wrong+VALUES(wrong),
             last_right=VALUES(last_right), last_ts=VALUES(last_ts), prio=VALUES(prio)`,
    [userId, questionId, correct ? 0 : 1, correct ? 1 : 0, ts, correct ? 3 : 0]);
  await q('INSERT INTO attempts (user_id, question_id, ts, correct, given, grade) VALUES (?,?,?,?,?,?)',
    [userId, questionId, ts, correct ? 1 : 0, given == null ? null : String(given).slice(0, 300), grade == null ? null : grade]);
}
async function setStarred(userId, questionId, starred) {
  await q(`INSERT INTO qstate (user_id, question_id, hidden, starred, attempts, wrong, last_ts, prio)
           VALUES (?,?,0,?,0,0,NULL,1)
           ON DUPLICATE KEY UPDATE starred=VALUES(starred)`,
    [userId, questionId, starred ? 1 : 0]);
}
async function setHidden(userId, questionId, hidden) {
  await q(`INSERT INTO qstate (user_id, question_id, hidden, attempts, wrong, last_ts, prio) VALUES (?,?,?,?,0,NULL,1)
           ON DUPLICATE KEY UPDATE hidden=VALUES(hidden)`,
    [userId, questionId, hidden ? 1 : 0, hidden ? 1 : 0]);
}
async function getMyState(userId) {
  const [rows] = await q('SELECT question_id, hidden, starred, attempts, wrong, last_right, last_ts FROM qstate WHERE user_id=?', [userId]);
  const m = {};
  for (const r of rows) m[r.question_id] = { hidden: !!r.hidden, starred: !!r.starred, attempts: r.attempts, wrong: r.wrong, last_right: r.last_right, last_ts: r.last_ts };
  return m;
}
async function listAttempts(userId, limit) {
  const [rows] = await q(`SELECT a.ts, a.correct, a.given, a.grade, q.stem, q.type, q.ch, q.kp, a.question_id
    FROM attempts a JOIN questions q ON q.id=a.question_id
    WHERE a.user_id=? ORDER BY a.id DESC LIMIT ?`, [userId, limit || 50]);
  return rows;
}

/* ================= 题库查询（在 SQL 侧过滤 + 分页，不再全量拉到内存里筛） ================= */
const Q_SCOPE_SQL = {
  all: '1=1',
  wrong: '(s.last_right=0 OR (s.wrong>0 AND (s.last_right IS NULL OR s.last_right<>1)))',
  starred: 's.starred=1',
  todo: 'COALESCE(s.attempts,0)=0',
  done: 's.last_right=1'
};
function buildPracticeWhere(userId, f = {}) {
  /* 只用 qstate 侧的条件 + 可选的 q.* 筛选。
   * 不再写 q.status IN (...) —— "qstate 行 ⟺ 可练习题"这个不变式已经保证了这一点
   * （由迁移清理 + 入库补行 + 驳回删行 + 查询前自愈共同维护），
   * 而把它写成 JOIN 条件会让优化器放弃索引排序。 */
  const where = ['s.user_id=?', 's.hidden=0'];
  const args = [userId];
  if (f.ch) { where.push('q.ch=?'); args.push(+f.ch); }
  if (f.type) { where.push('q.type=?'); args.push(String(f.type)); }
  if (f.diff) { where.push('q.diff=?'); args.push(+f.diff); }
  if (f.taskId) { where.push('q.task_id=?'); args.push(String(f.taskId)); }
  if (f.scope && f.scope !== 'all') where.push('(' + (Q_SCOPE_SQL[f.scope] || '1=1') + ')');
  return { where, args };
}
/* 自愈：补齐缺失的 qstate 行（保证每道已采纳的题都有优先级行）。
 * 每个用户每进程只做一次，成本是一次 INSERT IGNORE ... SELECT；正常情况下插 0 行。 */
const _qstateEnsured = new Set();
async function ensureQstate(userId) {
  if (_qstateEnsured.has(userId)) return;
  _qstateEnsured.add(userId);
  try {
    await q(`INSERT IGNORE INTO qstate (user_id, question_id, hidden, starred, attempts, wrong, last_right, last_ts, prio)
      SELECT q.user_id, q.id, 0, 0, 0, 0, NULL, NULL, 1 FROM questions q
      LEFT JOIN qstate s ON s.question_id=q.id AND s.user_id=q.user_id
      WHERE q.user_id=? AND q.status IN ('accepted','auto_accepted') AND s.question_id IS NULL`, [userId]);
    /* 反向：非已采纳的题（被驳回/打回）不该留在 qstate 里 */
    await q(`DELETE s FROM qstate s JOIN questions q ON q.id=s.question_id AND q.user_id=s.user_id
      WHERE s.user_id=? AND q.status NOT IN ('accepted','auto_accepted')`, [userId]);
  } catch (e) { /* 自愈失败不影响查询本身 */ }
}

/* 列表：SQL 侧过滤/排序/分页（排序规则：错题 → 未做 → 半会 → 已会，同组内按最近练习时间） */
async function practiceList(userId, f = {}) {
  await ensureQstate(userId);
  const { where, args } = buildPracticeWhere(userId, f);
  const limit = Math.max(1, Math.min(200, +f.limit || 30));
  const offset = Math.max(0, +f.offset || 0);
  /* 排序键**必须全部来自 qstate**：prio（错题→未做→半会→已会）、last_ts、question_id（保证分页稳定）。
   * 只要混入 questions 的字段（哪怕只是兜底的 created_at），MySQL 就会放弃索引排序改成 filesort ——
   * 实测 5 万题下是 125ms vs 0.8ms。 */
  const order = 'ORDER BY s.prio ASC, s.last_ts DESC, s.question_id ASC';
  const [rows] = await q(`SELECT q.*, s.hidden, s.starred,
      COALESCE(s.attempts,0) attempts, COALESCE(s.wrong,0) wrong, s.last_right, s.last_ts
    FROM qstate s JOIN questions q ON q.id=s.question_id AND q.user_id=s.user_id
    WHERE ${where.join(' AND ')} ${order} LIMIT ${limit} OFFSET ${offset}`, args);
  /* 命中筛选的条数：只在用到 questions 侧筛选（章节/题型/难度/批次）时才 join，
   * 否则纯 qstate 计数 —— 后者是常见路径，直接省掉一次 5 万行 join。 */
  const needsQ = /q\.(ch|type|diff|task_id)/.test(where.join(' '));
  const [[tot]] = await q(needsQ
    ? `SELECT COUNT(*) n FROM qstate s JOIN questions q ON q.id=s.question_id AND q.user_id=s.user_id WHERE ${where.join(' AND ')}`
    : `SELECT COUNT(*) n FROM qstate s WHERE ${where.join(' AND ')}`, args);
  /* 汇总：all = 题库总量（含已隐藏，隐藏不是删除），其余按状态统计。
   * 只读 qstate、不再 join questions —— 不变式保证"qstate 行 ⟺ 可练习题"，
   * 且 Q_SCOPE_SQL 的四个表达式都只引用 s.* 列，所以改写语义完全等价；
   * 少一次 5 万行 join + 5 个聚合 SUM，实测这是 230ms 与几十 ms 的差别。
   * 注意这里不带 hidden 过滤 —— 否则"隐藏后题库总量变小"会让人以为题目被删了。 */
  const [[cnt]] = await q(`SELECT COUNT(*) allN,
      SUM(CASE WHEN ${Q_SCOPE_SQL.wrong} THEN 1 ELSE 0 END) wrongN,
      SUM(CASE WHEN s.starred=1 THEN 1 ELSE 0 END) starN,
      SUM(CASE WHEN COALESCE(s.attempts,0)=0 THEN 1 ELSE 0 END) todoN,
      SUM(CASE WHEN s.last_right=1 THEN 1 ELSE 0 END) doneN
    FROM qstate s WHERE s.user_id=?`, [userId]);
  return {
    rows, total: Number(tot.n) || 0, offset,
    counts: {
      all: Number(cnt.allN) || 0, wrong: Number(cnt.wrongN) || 0, starred: Number(cnt.starN) || 0,
      todo: Number(cnt.todoN) || 0, done: Number(cnt.doneN) || 0
    }
  };
}
/* 筛选项：一个聚合查询算完各维度数量 */
async function practiceFilters(userId) {
  const base = `FROM qstate s JOIN questions q ON q.id=s.question_id AND q.user_id=s.user_id
    WHERE s.user_id=? AND s.hidden=0`;
  const mk = async (col) => {
    const [rows] = await q(`SELECT q.${col} k, COUNT(*) n,
        SUM(CASE WHEN ${Q_SCOPE_SQL.wrong} THEN 1 ELSE 0 END) wrongN,
        SUM(CASE WHEN COALESCE(s.attempts,0)=0 THEN 1 ELSE 0 END) todoN
      ${base} GROUP BY q.${col} ORDER BY q.${col}`, [userId]);
    return rows.map(r => ({ k: r.k, n: Number(r.n), wrong: Number(r.wrongN) || 0, todo: Number(r.todoN) || 0 }));
  };
  const [chs, types, diffs, tasks] = await Promise.all([mk('ch'), mk('type'), mk('diff'), mk('task_id')]);
  const [trows] = await q('SELECT id, name, created_at FROM tasks WHERE user_id=?', [userId]);
  const tmap = new Map(trows.map(t => [t.id, t]));
  return {
    chapters: chs.map(x => ({ ch: x.k, n: x.n, wrong: x.wrong, todo: x.todo })),
    types: types.map(x => ({ type: x.k, n: x.n, wrong: x.wrong, todo: x.todo })),
    diffs: diffs.map(x => ({ diff: x.k, n: x.n, wrong: x.wrong, todo: x.todo })),
    tasks: tasks.map(x => {
      const t = tmap.get(x.k);
      return {
        taskId: x.k, name: t ? t.name : '（任务已删除）', n: x.n, wrong: x.wrong, todo: x.todo,
        createdAt: t ? Number(t.created_at) : 0
      };
    }).sort((a, b) => b.createdAt - a.createdAt)
  };
}
/* 单题查询：判分时按 id 直查，不再把用户全部题目拉进内存 */
async function questionById(userId, qid) {
  const [rows] = await q(`SELECT * FROM questions WHERE id=? AND user_id=? AND status IN ('accepted','auto_accepted')`, [qid, userId]);
  return rows[0] || null;
}
async function practiceStats(userId) {
  const [byChapter] = await q(`SELECT q.ch, COUNT(*) n, SUM(a.correct) ok
    FROM attempts a JOIN questions q ON q.id=a.question_id WHERE a.user_id=? GROUP BY q.ch`, [userId]);
  const [byType] = await q(`SELECT q.type, COUNT(*) n, SUM(a.correct) ok
    FROM attempts a JOIN questions q ON q.id=a.question_id WHERE a.user_id=? GROUP BY q.type`, [userId]);
  const [byKp] = await q(`SELECT q.kp, COUNT(*) n, SUM(a.correct) ok
    FROM attempts a JOIN questions q ON q.id=a.question_id WHERE a.user_id=? AND q.kp IS NOT NULL AND q.kp<>''
    GROUP BY q.kp HAVING n>=2 ORDER BY n DESC LIMIT 12`, [userId]);
  const [tot] = await q('SELECT COUNT(*) n, SUM(correct) ok FROM attempts WHERE user_id=?', [userId]);
  return {
    total: Number(tot[0].n) || 0, correct: Number(tot[0].ok) || 0,
    byChapter: byChapter.map(r => ({ ch: r.ch, n: Number(r.n), ok: Number(r.ok) })),
    byType: byType.map(r => ({ type: r.type, n: Number(r.n), ok: Number(r.ok) })),
    byKp: byKp.map(r => ({ kp: r.kp, n: Number(r.n), ok: Number(r.ok) }))
  };
}
/* 真实答题数据回流：按考点统计正确率，供出题时"多出薄弱考点的题" */
async function weakKPs(userId, limit) {
  const [rows] = await q(`SELECT q.kp, COUNT(*) n, SUM(a.correct) ok
    FROM attempts a JOIN questions q ON q.id=a.question_id
    WHERE a.user_id=? AND q.kp IS NOT NULL AND q.kp<>'' GROUP BY q.kp HAVING n>=2`, [userId]);
  return rows.map(r => ({ kp: r.kp, n: Number(r.n), ok: Number(r.ok) }))
    .filter(r => r.ok / r.n < 0.6)
    .sort((a, b) => (a.ok / a.n) - (b.ok / b.n))
    .slice(0, limit || 5);
}

/* ================= 逐题 AI 对话 ================= */
async function loadChat(userId, questionId) {
  const [rows] = await q('SELECT msgs FROM qchats WHERE user_id=? AND question_id=?', [userId, questionId]);
  return rows.length && Array.isArray(rows[0].msgs) ? rows[0].msgs : [];
}
async function saveChat(userId, questionId, msgs) {
  await q(`INSERT INTO qchats (user_id, question_id, msgs, updated_at) VALUES (?,?,?,?)
           ON DUPLICATE KEY UPDATE msgs=VALUES(msgs), updated_at=VALUES(updated_at)`,
    [userId, questionId, JSON.stringify(msgs.slice(-40)), Date.now()]);
}
async function clearChat(userId, questionId) {
  await q('DELETE FROM qchats WHERE user_id=? AND question_id=?', [userId, questionId]);
}

/* ================= 健康检查 ================= */
async function ping() {
  const t0 = Date.now();
  const [r] = await q('SELECT 1 v');
  return { ok: r.length > 0, ms: Date.now() - t0, schema: await schemaVersion() };
}
async function schemaVersion() {
  try {
    const [rows] = await q('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1');
    return rows.length ? rows[0].version : null;
  } catch (e) { return null; }
}

module.exports = {
  DB_NAME, DB_HOST, DB_PORT, DB_USER, pool, init, q, Q_SCOPE_SQL,
  hashPassword, newSalt, newToken,
  createUser, findUserByName, findUserById, findUserByNo, nextUserNo, userNoOf,
  createSession, userBySession, destroySession, listSessions, revokeSessions, changePassword,
  logOp, listOp, getOplog, markOplogReverted, queryOplogs, oplogActions,
  deduct, billAndDeduct, listBills, recharge, getBalance,
  dayStr, prevDay, checkin, checkinInfo, onlineMs, checkinBoard,
  createRevertRequest, listRevertRequests, decideRevertRequest, countPendingReverts,
  saveKPs, listKPs,
  recordAttempt, setHidden, setStarred, getMyState,
  listAttempts, practiceStats, practiceList, practiceFilters, questionById, weakKPs, ensureQstate,
  loadChat, saveChat, clearChat,
  ping, schemaVersion
};
