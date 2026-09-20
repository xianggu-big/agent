/* 存储层 v2：MySQL 持久化（用户数据） + 本地文件（图片/科目包/操作员配置）
 * 接口与 agent.js 的调用保持兼容：createTask/saveTask/loadTask/saveQuestions/...
 * 用户要求的核心改进：任务、题目、资料、识图结果全部落库，任何时候打开都在。 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

/* 数据目录：可用 QF_DATA_DIR 指定（测试用独立目录，避免污染生产配置与数据） */
const DATA = process.env.QF_DATA_DIR
  ? path.resolve(process.env.QF_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const DIRS = {
  root: DATA,
  tasks: path.join(DATA, 'tasks'),   // 仅存图片等二进制附件
  packs: path.join(DATA, 'packs'),
  evals: path.join(DATA, 'evals'),
  tmp: path.join(DATA, 'tmp'),
  uploads: path.join(DATA, 'uploads'),
  logs: path.join(DATA, 'logs')      // 结构化日志按天落地
};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

/* MySQL JSON 列不接受 JS 对象，需 JSON.stringify 后作为字符串传入 */
const J = v => v == null ? null : JSON.stringify(v);
/* 行 → 任务对象 */
function rowToTask(r) {
  if (!r) return null;
  return {
    id: r.id, userId: r.user_id, name: r.name,
    subject: r.subject_json, material: r.material_text == null ? null : {
      text: r.material_text, rawChars: (r.material_text || '').length, warnings: []
    },
    requirements: r.requirements_json, quote: r.quote_json,
    budgetYuan: +r.budget, visionCost: +r.vision_cost || 0,
    costs: r.costs_json || { spent: 0, byProfile: {}, calls: 0 },
    progress: r.progress_json || {},
    stats: r.stats_json || null,
    kps: r.kps_json || [],
    coveredChunks: r.covered_json || [],
    constraints: r.constraints_json || [],
    coverageStrict: !!r.coverage_strict,
    status: r.status, phase: r.phase || null, error: r.error || null,
    exported: r.exported_json || null,
    figures: r.figures_json || [],
    createdAt: Number(r.created_at)
  };
}
/* 任务对象 → 行 */
function taskToRow(t) {
  return [
    J(t.subject), t.material ? t.material.text : null, J(t.requirements), J(t.quote),
    t.budgetYuan || 0, t.visionCost || 0,
    JSON.stringify(t.costs || { spent: 0, byProfile: {}, calls: 0 }),
    JSON.stringify(t.progress || {}), J(t.stats), J(t.kps || []), J(t.coveredChunks || []),
    J(t.constraints || []), t.coverageStrict ? 1 : 0, t.status || 'draft',
    t.phase || null, t.error || null, J(t.exported), JSON.stringify(t.figures || [])
  ];
}

const Store = {
  dirs: DIRS,
  db,
  id(prefix) { return prefix + '_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); },

  /* ---- 操作员配置（含 API Key，仅存本机文件，不入库不外发） ----
   * 结构：
   *   providers: [{id, name, baseUrl, apiKey, priceIn, priceOut, enabled, note}]  ← 供应商密钥池（可多个）
   *   profiles : {角色: {label, model, providerIds:[...], maxTokens?}}            ← 岗位绑定供应商（可多个做轮换）
   * 一个岗位可绑定多个供应商：并发时自动分散、某个 Key 失败/限流时自动切换。
   * 鉴权：岗位未配 Key 时自动回退到「主供应商」，避免漏配导致 401。 */
  loadConfig() {
    const f = path.join(DATA, 'config.json');
    const defaults = {
      marginPct: 200, retryFactor: 1.25,
      conflictHumanRateAssume: 0.15,
      visionBudgetYuan: 2,
      signupBonus: 5,
      concurrency: { global: 8, perProvider: 4, cooldownSec: 30 },  // 并发与冷却
      providers: [
        { id: 'p_deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: '', priceIn: 2, priceOut: 8, enabled: true, model: 'deepseek-chat', note: '主供应商（未配 Key 的岗位会回退到这里）' },
        { id: 'p_zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: '', priceIn: 1, priceOut: 1, enabled: true, model: 'glm-4-flash', note: '视觉模型与异构质检' }
      ],
      profiles: {
        generator:  { label: '出题员', model: 'deepseek-chat', providerIds: ['p_deepseek'] },
        classifier: { label: '难度标注员', model: 'deepseek-chat', providerIds: ['p_deepseek'] },
        verifier1:  { label: '质检员A', model: 'deepseek-chat', providerIds: ['p_deepseek'] },
        verifier2:  { label: '质检员B', model: 'glm-4-flash', providerIds: ['p_zhipu'] },
        vision:     { label: '识图员', model: 'glm-4v-flash', providerIds: ['p_zhipu'], maxTokens: 1000 },
        nlu:        { label: '需求解析员', model: 'deepseek-chat', providerIds: ['p_deepseek'] }
      }
    };
    let cfg;
    if (!fs.existsSync(f)) cfg = JSON.parse(JSON.stringify(defaults));
    else {
      try { cfg = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { cfg = JSON.parse(JSON.stringify(defaults)); }
    }
    for (const [k, v] of Object.entries(defaults)) if (cfg[k] === undefined) cfg[k] = v;
    cfg.concurrency = Object.assign({}, defaults.concurrency, cfg.concurrency || {});
    delete cfg.mockMode; // 旧字段，模式由环境变量决定
    cfg = this._migrateProviders(cfg, defaults);
    return this._withMode(cfg);
  },

  /* 迁移：
   *  a) 旧格式 profiles[角色] = {baseUrl, apiKey, priceIn, priceOut} → 生成供应商 + 绑定
   *  b) 补齐缺失角色（用主供应商兜底，避免漏配） */
  _migrateProviders(cfg, defaults) {
    cfg.providers = Array.isArray(cfg.providers) ? cfg.providers : [];
    const byKey = new Map(cfg.providers.map(p => [p.baseUrl + '|' + (p.apiKey || ''), p]));
    const addProvider = (name, baseUrl, apiKey, priceIn, priceOut, note) => {
      const k = baseUrl + '|' + (apiKey || '');
      if (byKey.has(k)) return byKey.get(k).id;
      const id = 'p_' + require('crypto').randomBytes(4).toString('hex');
      cfg.providers.push({ id, name: name || '供应商', baseUrl, apiKey: apiKey || '', priceIn: priceIn || 0, priceOut: priceOut || 0, enabled: true, note: note || '' });
      byKey.set(k, cfg.providers[cfg.providers.length - 1]);
      return id;
    };
    /* 旧格式 → 供应商池 */
    for (const [role, prof] of Object.entries(cfg.profiles || {})) {
      if (!prof) continue;
      if (Array.isArray(prof.providerIds)) continue;         // 已是新格式
      const ids = [];
      if (prof.baseUrl) ids.push(addProvider(prof.label || role, prof.baseUrl, prof.apiKey, prof.priceIn, prof.priceOut, '由旧配置迁移'));
      prof.providerIds = ids;
      delete prof.baseUrl; delete prof.apiKey; delete prof.priceIn; delete prof.priceOut;
    }
    /* 把主供应商的 Key 灌进默认供应商（老配置里 generator 的 Key 就是主 Key） */
    const mainDefault = cfg.providers.find(p => p.id === 'p_deepseek') || cfg.providers[0];
    if (mainDefault && !mainDefault.apiKey) {
      const g = (cfg.profiles || {}).generator;
      const gid = g && g.providerIds && g.providerIds[0];
      const gp = gid ? cfg.providers.find(p => p.id === gid) : null;
      if (gp && gp.apiKey) mainDefault.apiKey = gp.apiKey;
    }
    /* 迁移：岗位上的 model 原是"给那个供应商用的模型名"，提升为供应商默认模型；
     * 岗位侧改为 modelOverride（留空 = 用供应商默认），换供应商时模型自动跟随。 */
    for (const prof of Object.values(cfg.profiles || {})) {
      if (!prof || prof.modelOverride !== undefined) continue;
      if (prof.model) {
        for (const pid of (prof.providerIds || [])) {
          const p = cfg.providers.find(x => x.id === pid);
          if (p && !p.model) p.model = prof.model;
        }
      }
      prof.modelOverride = '';
    }

    /* 补齐缺失角色，并让未绑定供应商的角色回退到主供应商 */
    const primaryId = (mainDefault && mainDefault.id) || (cfg.providers[0] && cfg.providers[0].id);
    for (const [role, def] of Object.entries(defaults.profiles)) {
      if (!cfg.profiles[role]) { cfg.profiles[role] = Object.assign({}, def); continue; }
      const cur = cfg.profiles[role];
      if (!cur.model) cur.model = def.model;
      if (!cur.label) cur.label = def.label;
      if (!Array.isArray(cur.providerIds) || !cur.providerIds.length) cur.providerIds = primaryId ? [primaryId] : [];
      /* 绑定的供应商被删了 → 也回退 */
      cur.providerIds = cur.providerIds.filter(id => cfg.providers.some(p => p.id === id));
      if (!cur.providerIds.length && primaryId) cur.providerIds = [primaryId];
    }
    return cfg;
  },

  /* 解析岗位 → 可直接调用模型的配置（含选取的供应商）
   * — 岗位未配 Key 时回退主供应商；多供应商时按轮换/冷却状态挑选。 */
  profileFor(cfg, role) {
    const raw = cfg.profiles && cfg.profiles[role];
    /* 配置里没有这个岗位 → 视为未定义（不回退），避免凭空多出岗位（如 verifier3/4） */
    if (!raw) return { label: role, model: '', baseUrl: '', apiKey: '', priceIn: 0, priceOut: 0, missing: true, undefinedRole: true };
    const prof = raw;
    const pool = (prof.providerIds || [])
      .map(id => cfg.providers.find(p => p.id === id))
      .filter(p => p && p.enabled !== false && p.apiKey);
    let provider = null;
    if (pool.length) provider = require('./llm').pickProvider(pool, role);
    if (!provider) {
      /* 兜底：主供应商（有 Key 的第一个），避免漏配直接 401 */
      provider = cfg.providers.find(p => p.enabled !== false && p.apiKey) || null;
    }
    if (!provider) {
      return { label: prof.label || role, model: prof.modelOverride || prof.model || '', baseUrl: '', apiKey: '', priceIn: 0, priceOut: 0, missing: true };
    }
    /* 模型名跟随供应商：岗位覆盖 > 供应商默认模型 > 岗位旧字段
     * 换供应商时模型自动跟随，避免"拿 GLM 的模型名去请求 DeepSeek"。*/
    const ov = (prof.modelOverride || '').trim();
    const pm = (provider.model || '').trim();
    return {
      label: prof.label || role, role,
      model: ov || pm || prof.model || '',
      modelSource: ov ? '岗位覆盖' : (pm ? '供应商默认' : '岗位旧字段'),
      baseUrl: provider.baseUrl, apiKey: provider.apiKey,
      priceIn: provider.priceIn || 0, priceOut: provider.priceOut || 0,
      providerId: provider.id, providerName: provider.name,
      maxTokens: prof.maxTokens,
      /* 质检视角：岗位可配（profiles[role].lens），未配则按岗位自动分配，
       * 保证"质检员A/B"开箱即用就是两个不同侧重点，而不是同一提示词跑两遍。 */
      lens: (require('./lenses').get(prof.lens, role))
    };
  },

  /* 只解析岗位视角，不挑供应商 —— 供 UI 高频读取使用。
   * （profileFor 会调用 pickProvider 推进负载均衡游标，UI 轮询不该影响调度） */
  lensFor(cfg, role) {
    const prof = (cfg.profiles && cfg.profiles[role]) || {};
    return require('./lenses').get(prof.lens, role);
  },

  /* 岗位当前绑定的全部候选（含各自会用到的模型），供 UI 展示"实际会用什么" */
  roleBindings(cfg, role) {    const prof = (cfg.profiles && cfg.profiles[role]) || {};
    const ov = (prof.modelOverride || '').trim();
    return (prof.providerIds || [])
      .map(id => (cfg.providers || []).find(p => p.id === id))
      .filter(Boolean)
      .map(p => ({
        providerId: p.id, providerName: p.name, hasKey: !!p.apiKey, enabled: p.enabled !== false,
        model: ov || (p.model || '').trim() || prof.model || '',
        modelSource: ov ? '岗位覆盖' : ((p.model || '').trim() ? '供应商默认' : '岗位旧字段'),
        baseUrl: p.baseUrl, priceIn: p.priceIn, priceOut: p.priceOut
      }));
  },

  /* 带价格的岗位表（供 cost.estimateCost 估算用；价格存在供应商上） */
  pricedProfiles(cfg) {
    const out = {};
    for (const role of Object.keys(cfg.profiles || {})) {
      const p = this.profileFor(cfg, role);
      out[role] = {
        label: p.label, model: p.model || '(未配置)',
        priceIn: p.priceIn || 0, priceOut: p.priceOut || 0,
        baseUrl: p.baseUrl, apiKey: p.apiKey, missing: p.missing
      };
    }
    return out;
  },

  /* 某个岗位是否有可用凭据（用于提前给出友好提示） */
  hasCredentials(cfg, role) {
    const p = this.profileFor(cfg, role);
    return !p.missing && !!p.apiKey && !!p.baseUrl && !!p.model;
  },

  saveConfig(cfg) { fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify(cfg, null, 2)); },

  /* 是否使用模拟响应：只由启动环境变量 QF_MOCK=1 决定（自动化测试专用），不写配置、不下发网页 */
  _withMode(cfg) { cfg.mockMode = process.env.QF_MOCK === '1'; return cfg; },
  isMock() { return process.env.QF_MOCK === '1'; },

  /* ---- 任务（MySQL 持久化） ---- */
  taskDir(id) { const d = path.join(DIRS.tasks, id); fs.mkdirSync(d, { recursive: true }); return d; },
  taskImgDir(taskId) {
    const d = path.join(this.taskDir(taskId), 'images');
    fs.mkdirSync(d, { recursive: true });
    return d;
  },
  async createTask(t) {
    await db.q(`INSERT INTO tasks (id, user_id, name, subject_json, material_text, requirements_json, quote_json,
      budget, vision_cost, costs_json, progress_json, stats_json, kps_json, covered_json, constraints_json, coverage_strict,
      status, phase, error, exported_json, figures_json, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [t.id, t.userId, t.name, J(t.subject), t.material ? t.material.text : null,
       J(t.requirements), J(t.quote), t.budgetYuan || 0, t.visionCost || 0,
       JSON.stringify(t.costs || { spent: 0, byProfile: {}, calls: 0 }), JSON.stringify(t.progress || {}),
       J(t.stats), J(t.kps || []), J(t.coveredChunks || []), J(t.constraints || []), t.coverageStrict ? 1 : 0,
       t.status || 'draft', t.phase || null, t.error || null, J(t.exported),
       JSON.stringify(t.figures || []), t.createdAt || Date.now()]);
    this.taskDir(t.id); // 建附件目录
    return t;
  },
  async saveTask(t) {
    await db.q(`UPDATE tasks SET name=?, subject_json=?, material_text=?, requirements_json=?, quote_json=?,
      budget=?, vision_cost=?, costs_json=?, progress_json=?, stats_json=?, kps_json=?, covered_json=?,
      constraints_json=?, coverage_strict=?, status=?, phase=?, error=?, exported_json=?, figures_json=?
      WHERE id=?`,
      [t.name, J(t.subject), t.material ? t.material.text : null, J(t.requirements),
       J(t.quote), t.budgetYuan || 0, t.visionCost || 0,
       JSON.stringify(t.costs || { spent: 0, byProfile: {}, calls: 0 }), JSON.stringify(t.progress || {}),
       J(t.stats), J(t.kps || []), J(t.coveredChunks || []), J(t.constraints || []), t.coverageStrict ? 1 : 0,
       t.status || 'draft', t.phase || null, t.error || null, J(t.exported),
       JSON.stringify(t.figures || []), t.id]);
    return t;
  },
  async loadTask(id) {
    const [rows] = await db.q('SELECT * FROM tasks WHERE id=?', [id]);
    return rowToTask(rows[0]);
  },
  async listTasks(userId) {
    const [rows] = await db.q('SELECT * FROM tasks WHERE user_id=? ORDER BY created_at DESC', [userId]);
    return rows.map(rowToTask);
  },
  /* 把解析出的图片复制进任务附件目录（原图持久保存在磁盘，路径记录在任务的 figures_json） */
  adoptImages(taskId, images) {
    const dir = this.taskImgDir(taskId);
    return images.map(im => {
      const dst = path.join(dir, path.basename(im.file));
      try { if (fs.existsSync(im.file) && !fs.existsSync(dst)) fs.copyFileSync(im.file, dst); } catch (e) { /* 保留原路径 */ }
      return Object.assign({}, im, { file: fs.existsSync(dst) ? dst : im.file });
    });
  },

  /* ---- 题目（MySQL 持久化） ----
   * 落库守卫（关键）：流水线写入时，一旦某题已经有人工结论（human_json 非空），
   * 就不再覆盖它的 status / human_json —— 否则"流水线内存里的旧状态"会把
   * 用户刚做出的采纳/毙掉决定悄悄改回去（真实发生过的丢更新）。
   * 人工裁决路径传 { fromHuman: true }，表示"这是人的决定，必须覆盖"。 */
  _questionSQL(fromHuman) {
    return `INSERT INTO questions (id, task_id, user_id, type, ch, kp, diff, stem, options_json, answer, expl,
        ref, fig_id, status, consensus, verdicts_json, human_json, gen_json, dup_of, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE type=VALUES(type), ch=VALUES(ch), kp=VALUES(kp), diff=VALUES(diff), stem=VALUES(stem),
        options_json=VALUES(options_json), answer=VALUES(answer), expl=VALUES(expl), ref=VALUES(ref), fig_id=VALUES(fig_id),
        dup_of=VALUES(dup_of), verdicts_json=VALUES(verdicts_json), gen_json=VALUES(gen_json),
        status=${fromHuman ? 'VALUES(status)' : 'IF(human_json IS NULL, VALUES(status), status)'},
        human_json=${fromHuman ? 'VALUES(human_json)' : 'IF(human_json IS NULL, VALUES(human_json), human_json)'}`;
  },
  _questionArgs(taskId, userId, q) {
    return [q.id, taskId, userId, q.type, q.ch, q.kp, q.diff, q.stem,
      q.options ? JSON.stringify(q.options) : null, q.answer || null, q.expl || null,
      q.ref || null, q.fig || null, q.status, q.consensus ? 1 : 0,
      JSON.stringify(q.verdicts || []),
      /* 必须写 SQL NULL 而不是字符串 "null"：落库守卫靠 human_json IS NULL 判断
       * "这题有没有人工结论"，写成 'null' 会让守卫永远认为有人工结论。 */
      q.human ? JSON.stringify(q.human) : null,
      JSON.stringify(q.gen || {}),
      q.dup_of || null, Date.now()];
  },
  /* 单题落库：质检/出题阶段逐题写，避免"每来一条结果就重写全部题目"的写放大 */
  /* 已采纳的题必须有一条 qstate 行（"每道题都有复习优先级"）：
   * 题库列表从 qstate 驱动按索引取数，缺行就会漏题，所以在写入侧就补上。 */
  async _ensureQstateRow(userId, q) {
    if (!userId || !q || !['accepted', 'auto_accepted'].includes(q.status)) return;
    await db.q(`INSERT IGNORE INTO qstate (user_id, question_id, hidden, starred, attempts, wrong, last_right, last_ts, prio)
      VALUES (?,?,0,0,0,0,NULL,NULL,1)`, [userId, q.id]).catch(() => {});
  },
  async saveQuestion(taskId, q, opts = {}) {
    const task = await this.loadTask(taskId);
    const userId = task ? task.userId : null;
    await db.q(this._questionSQL(!!opts.fromHuman), this._questionArgs(taskId, userId, q));
    await this._ensureQstateRow(userId, q);
    return q;
  },
  async saveQuestions(taskId, qs, opts = {}) {
    const task = await this.loadTask(taskId);
    const userId = task ? task.userId : null;
    for (const q of qs) {
      await db.q(this._questionSQL(!!opts.fromHuman), this._questionArgs(taskId, userId, q));
      await this._ensureQstateRow(userId, q);
    }
  },
  async loadQuestions(taskId) {
    const [rows] = await db.q('SELECT * FROM questions WHERE task_id=? ORDER BY created_at, id', [taskId]);
    return rows.map(r => {
      const gen = r.gen_json || {};
      return {
        id: r.id, reqIdx: 0, task_id: taskId, userId: r.user_id,
        type: r.type, ch: r.ch, kp: r.kp, diff: r.diff,
        stem: r.stem, options: r.options_json || undefined, answer: r.answer || undefined,
        expl: r.expl || undefined, ref: r.ref || undefined, fig: r.fig_id || undefined,
        status: r.status, consensus: !!r.consensus, dup_of: r.dup_of || undefined,
        seq: gen.seq,                       // 续跑时保住题目序号（演示/测试的可复现性依赖它）
        verdicts: r.verdicts_json || [], human: r.human_json || undefined, gen
      };
    });
  },
  /* 用户已采纳题库（跨任务） */
  async listAcceptedQuestions(userId) {
    const [rows] = await db.q(`SELECT * FROM questions WHERE user_id=? AND status IN ('accepted','auto_accepted')
      ORDER BY created_at DESC`, [userId]);
    return rows.map(r => ({
      id: r.id, taskId: r.task_id, task_id: r.task_id, type: r.type, ch: r.ch, kp: r.kp, diff: r.diff,
      stem: r.stem, options: r.options_json || undefined, answer: r.answer || undefined,
      expl: r.expl || undefined, ref: r.ref || undefined, fig: r.fig_id || undefined, status: r.status
    }));
  },

  /* ---- 事件日志 ---- */
  async logEvent(taskId, ev) {
    await db.q(`INSERT INTO events (task_id, user_id, ts, step, level, msg, usage_json)
      SELECT id, user_id, ?, ?, ?, ?, ? FROM tasks WHERE id=?`,
      [Date.now(), ev.step || '', ev.level || 'info', ev.msg || '',
       ev.usage ? JSON.stringify(ev.usage) : null, taskId]);
  },
  async loadEvents(taskId, tailN) {
    const sql = tailN
      ? 'SELECT ts, step, level, msg, usage_json FROM (SELECT * FROM events WHERE task_id=? ORDER BY id DESC LIMIT ?) t ORDER BY id'
      : 'SELECT ts, step, level, msg, usage_json FROM events WHERE task_id=? ORDER BY id';
    const [rows] = await db.q(sql, tailN ? [taskId, tailN] : [taskId]);
    return rows.map(r => ({ ts: Number(r.ts), step: r.step, level: r.level, msg: r.msg, usage: r.usage_json || undefined }));
  },

  /* ---- 经验库（长期记忆，操作员级别共享） ----
   * 结构：{ id, ts, kind, text, kp?, taskName? }
   * kind: correction（人工修正） | note（操作员备注） | feedback（客户反馈）
   * 注入出题提示词时不再"取最后 15 条"，而是按相关度检索（见 selectMemory）。 */
  loadMemory() {
    const f = path.join(DATA, 'memory.json');
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
  },
  saveMemory(m) { fs.writeFileSync(path.join(DATA, 'memory.json'), JSON.stringify(m, null, 2)); },
  /* 追加一条经验；同一文本重复加入时只更新计数（避免同一条错误反复堆叠） */
  addMemory(entry) {
    const mem = this.loadMemory();
    const dup = mem.find(m => m.text === entry.text);
    if (dup) { dup.ts = Date.now(); dup.hits = (dup.hits || 1) + 1; }
    else mem.push(Object.assign({ id: this.id('m'), ts: Date.now(), kind: 'note', hits: 1 }, entry));
    this.saveMemory(mem.slice(-300));
    return mem;
  },
  /*
   * 按相关度挑选要注入提示词的经验（而不是无脑取最近 N 条）：
   * 命中本次考点/资料的经验优先，其余用较新的补充，保证"总条数受控、相关知识一定在"。
   */
  selectMemory({ query = '', kp = '', limit = 12 } = {}) {
    const mem = this.loadMemory();
    if (!mem.length) return [];
    const Text = require('./text');
    const q = [query, kp].filter(Boolean).join(' ');
    const scored = mem.map(m => ({
      m,
      s: (q ? Text.similarity(q, m.text) : 0) * 3 + (m.kp && kp && (m.kp.includes(kp) || kp.includes(m.kp)) ? 2 : 0)
        + (m.kind === 'correction' ? 0.4 : 0) + Math.min(0.3, (m.hits || 1) * 0.05)
    }));
    scored.sort((a, b) => (b.s - a.s) || (b.m.ts - a.m.ts));
    return scored.slice(0, limit).map(x => x.m);
  },

  /* ---- 资料库（用户上传，MySQL 持久化） ---- */
  async saveMaterial(userId, mat) {
    await db.q(`INSERT INTO materials (id, user_id, name, text, kind, pages, chars, figure_count, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`,
      [mat.id, userId, mat.name, mat.text, mat.kind || null, mat.pages || null,
       mat.chars || (mat.text || '').length, mat.figure_count || 0, Date.now()]);
    return mat;
  },
  async listMaterials(userId) {
    const [rows] = await db.q(`SELECT id, name, kind, pages, chars, figure_count, created_at FROM materials
      WHERE user_id=? AND deleted_at IS NULL ORDER BY created_at DESC`, [userId]);
    return rows;
  },
  async loadMaterial(userId, id) {
    const [rows] = await db.q('SELECT * FROM materials WHERE id=? AND user_id=? AND deleted_at IS NULL', [id, userId]);
    const r = rows[0];
    return r ? { id: r.id, userId: r.user_id, name: r.name, text: r.text, kind: r.kind, pages: r.pages, chars: r.chars, figure_count: r.figure_count } : null;
  },
  /* 含已删除（供"撤销删除"与取证用） */
  async loadMaterialAny(userId, id) {
    const [rows] = await db.q('SELECT * FROM materials WHERE id=? AND user_id=?', [id, userId]);
    return rows[0] || null;
  },
  /* 软删除：只打时间戳，正文与图片都留在库里/磁盘上，因此可以"撤销删除"恢复 */
  async deleteMaterial(userId, id) {
    const [r] = await db.q('UPDATE materials SET deleted_at=? WHERE id=? AND user_id=? AND deleted_at IS NULL',
      [Date.now(), id, userId]);
    return r.affectedRows > 0;
  },
  async restoreMaterial(userId, id) {
    const [r] = await db.q('UPDATE materials SET deleted_at=NULL WHERE id=? AND user_id=? AND deleted_at IS NOT NULL',
      [id, userId]);
    return r.affectedRows > 0;
  },
  async saveFigureDesc(userId, materialId, figId, desc) {
    await db.q('UPDATE figures SET fig_desc=? WHERE id=? AND material_id=? AND user_id=?', [desc, figId, materialId, userId]);
  },
  async saveFigures(userId, materialId, figures) {
    for (const f of figures) {
      await db.q(`INSERT INTO figures (id, material_id, orig_id, user_id, page, w, h, kb, file_path, fig_desc, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE user_id=VALUES(user_id), page=VALUES(page), w=VALUES(w), h=VALUES(h),
          kb=VALUES(kb), file_path=VALUES(file_path), fig_desc=VALUES(fig_desc)`,
        [f.id, materialId, f.orig_id || f.id, userId, f.page || null, f.w || 0, f.h || 0, f.kb || 0,
         f.file, f.desc || null, Date.now()]);
    }
  },
  async listFigures(userId, materialId) {
    const [rows] = await db.q(`SELECT id, orig_id, page, w, h, kb, file_path, fig_desc FROM figures
      WHERE user_id=? AND material_id=? ORDER BY page, id`, [userId, materialId]);
    return rows.map(r => ({ id: r.id, orig_id: r.orig_id, page: r.page, w: r.w, h: r.h, kb: +r.kb, file: r.file_path, desc: r.fig_desc || '' }));
  },

  /* ---- 资料解析会话（短生命周期，文件暂存） ---- */
  saveParse(parseId, data) {
    const d = path.join(DIRS.tmp, parseId);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify(data, null, 2));
  },
  loadParse(parseId) {
    if (!/^[a-z0-9_]+$/.test(String(parseId))) return null; // 防路径穿越
    const f = path.join(DIRS.tmp, parseId, 'meta.json');
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  },

  /* ---- 导出与评估（文件形态的交付物） ---- */
  savePack(name, content) {
    const f = path.join(DIRS.packs, name);
    fs.writeFileSync(f, content);
    return f;
  },
  saveTmp(name, buf) {
    const f = path.join(DIRS.tmp, name);
    fs.writeFileSync(f, buf);
    return f;
  },
  saveEval(report) {
    fs.writeFileSync(path.join(DIRS.evals, report.id + '.json'), JSON.stringify(report, null, 2));
    return report;
  },
  listEvals() {
    return fs.readdirSync(DIRS.evals).filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(DIRS.evals, f), 'utf8')); } catch (e) { return null; } })
      .filter(Boolean).sort((a, b) => b.ts - a.ts);
  }
};

module.exports = Store;
