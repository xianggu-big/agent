/* 制题 Agent 流水线：出题 → 难度标注 → 多模型交叉质检 → 裁决（共识自动入库，分歧进人工队列）
 *
 * 企业级要点：
 *  - 阶段幂等（断点续跑不产生脏数据）
 *  - 逐调用成本计量 + 预算硬闸
 *  - 计费幂等且不漏单：任何"流水线停下来"的时刻（完成/待审核/预算暂停/异常暂停）
 *    都会把"已花但未计费"的差额入账，靠 bills.idem_key 保证同一笔只扣一次
 *  - 资料按块检索注入（不再截断前 12000 字），并记录覆盖情况
 *  - 近似重复题打标 dup_of，不自动入库，交人工判断
 *  - 质检员的裁决结果逐题落库（不再每来一条质检就重写全表）
 *  - 人工裁决结果不会被后续流水线用陈旧内存状态覆盖（见 store.saveQuestion 的 SQL 守卫）
 */
'use strict';
const path = require('path');
const db = require('./db');
const { callGuarded, newMeter, BudgetExceeded, configure } = require('./llm');
const { sanitizeMaterial, wrapMaterial } = require('./guard');
const { extractJSON } = require('./json');
const KP = require('./kp');
const Reqs = require('./reqs');
const Text = require('./text');
const Solve = require('./solve');
const Tools = require('./tools');
const CodeRun = require('./coderun');
/* ===== 有界工具调用（质检验算工具）=====
 * 开关默认关：保证原有行为完全不变、可随时回滚（QF_TOOLS=1 打开 calc）。
 * 只在**质检环节**注入，且只对"看起来需要计算/推演"的题注入 ——
 * 纯概念题给工具只会产生白调（多花一次调用、没有任何收益）。
 *
 * D1 扩展：QF_TOOLS_RUN=1 时**再**给一个 run_code（在断网沙箱里跑模型写的 C 程序）。
 * 它补的是 calc 解决不了的那类题 —— 算法过程推演（栈的出栈序列、树的遍历、递归展开…）：
 * 这类题模型只能心算，而实测"心算代码输出"的准确率只有约 31%（docs/EVALSUITE.md 阶段二）。
 * ⚠ 安全前提：**沙箱不可用就不给这个工具** —— run_code 跑的是模型临场生成的任意代码，
 *    宁可不给，也不在本机跑它（这是与"评测没沙箱就降级本机"不同的取舍，理由见 docs/EVALSUITE.md §14）。 */
const TOOL_NAME = 'calc';
const RUN_CODE_NAME = 'run_code';
const TOOL_RULE = '\n【工具使用规定】凡涉及数值计算（算术、百分比、单位换算、方程求解、多位数运算）'
  + '必须调用 ' + TOOL_NAME + ' 工具得出结果，不得心算；不需要计算的题目直接作答，不要为了使用工具而计算。';
const RUN_TOOL_RULE = Tools.RUN_RULE;   // 定义在 tools.js（评测与质检共用一份）
function toolsEnabled() { return process.env.QF_TOOLS === '1'; }
/* run_code 以 QF_TOOLS 为**总开关**：关掉 QF_TOOLS 就必须完全没有工具（干净的回滚点）。
 * 两个独立开关看着灵活，实际会让"关掉工具"这件事变成两处都要记得关 —— 回滚路径越短越好。 */
function runToolEnabled() { return process.env.QF_TOOLS === '1' && process.env.QF_TOOLS_RUN === '1'; }
/* 判据：题干/选项里有数字且有计算意味的词，或题型本身偏计算。
 * 故意保守：宁可少给工具（少花钱），也不要给概念题塞工具。 */
function needsCalc(q) {
  /* 判据（R4 标定后收紧，实测见下）：
   * 旧的写法把"多少 / 平均 / 最大"这类**只表示问一个值**的词当成计算意图，
   * 结果把概念题也判成了计算题（实测精确率 75%："包含多少条边""不超过多少"都被误判）。
   * 现在要求：**两个具体数字之间真有算术**（1/(3-3)、(3+5)*4、987654321 × 123456789），
   * 或者出现明确的"算出来"动词（计算/求解/之和/概率/结果/几号/是多少…）。
   * 并先剔除不是在算具体数的数字：章节号、年份、题号、下标、代数记号（n-1 / 2n）。 */
  if (['solution', 'algo', 'app'].indexOf(q.type) >= 0) return true;
  const raw = String(q.stem || '') + ' ' + (Array.isArray(q.options) ? q.options.join(' ') : '');
  const text = raw
    .replace(/第\s*\d+\s*[章节讲篇]/g, ' ')
    .replace(/(19|20)\d{2}\s*年/g, ' ')
    .replace(/题号\s*\d+/g, ' ')
    .replace(/[\u2080-\u2089]/g, ' ')
    .replace(/\b[nm]\s*[-+*/^]\s*\d+/g, ' ')
    .replace(/\d+\s*[nm]\b/g, ' ');
  if (!/\d/.test(text)) return false;
  const realArith = /\d\s*[-+*/^%×÷]\s*\d/.test(text);
  /* 用"有多少X"而不是裸"多少"：前者是问具体数量，后者在概念题里也会出现（"包含多少条边"）。 */
  const calcVerb = /计算|求解|求和|之和|总和|概率|比例|结果|等于|几号|是多少|值是多少|有多少|多少种|多少天|多少个|求[^，。]{0,8}(值|结果|多少)/.test(text);
  return realArith || calcVerb;
}

/* run_code 的判据与门禁已挪到 lib/tools.js（评测与质检共用一份，避免两处漂移）。
 * 这里保留同名导出，纯粹是给既有调用方（feature_test 等）用。 */
const needsRunCode = Tools.needsRunCode;
const runToolPlan = Tools.planRunCode;
const M = require('./mock');
const Store = require('./store');
const { log } = require('./log');

const TYPE_CN = { mcq: '单项选择题', solution: '解答题', algo: '算法设计题', app: '综合应用题' };
const VERIFIER_KEYS = ['verifier1', 'verifier2', 'verifier3', 'verifier4'];
/* 注入提示词的资料预算（字符）。按块检索挑选，超长资料因此也能被完整覆盖到 */
const CONTEXT_BUDGET = +(process.env.QF_CONTEXT_BUDGET || 8000);
const FIG_BUDGET = +(process.env.QF_FIG_BUDGET || 4000);
/* 近似重复阈值：2-gram 重叠系数（阈值 0.62 的依据见 lib/text.js 与 simcal.js 的标定表） */
const DUP_THRESHOLD = +(process.env.QF_DUP_THRESHOLD || 0.62);

function clampDiff(d) { d = Math.round(+d); return d >= 1 && d <= 3 ? d : 2; }

/* 经验库 → 出题 system 提示（长期记忆注入：按相关度检索，而不是无脑取最近几条） */
function memoryPrompt({ query = '', kp = '', limit = 12 } = {}) {
  const mem = Store.selectMemory({ query, kp, limit });
  if (!mem.length) return '';
  return '\n【历史经验（此前人工纠错沉淀，必须遵守）】\n' + mem.map(m => '· ' + m.text).join('\n');
}
/* 知识点清单 → 提示词片段 */
function kpPrompt(kps, req) {
  if (!kps || !kps.length) return '';
  const hit = kps.filter(k => req && (k.name.includes(req.kp) || req.kp.includes(k.name) || (req.ch && k.ch === req.ch)));
  const list = (hit.length ? hit : kps).slice(0, 12);
  return '\n【这份资料的知识点清单（出题请对齐这些考点，不要考清单外的内容）】\n' +
    list.map(k => '· 第' + (k.ch || 1) + '章 ' + k.name + (k.detail ? '（' + k.detail + '）' : '')).join('\n');
}

/* ============ 计费：把"已花未计费"的差额入账（幂等，任何停止状态都调用） ============ */
async function billTaskDelta(task, reason) {
  const spent = +((task.costs && task.costs.spent) || 0).toFixed(4);
  const billed = +((task.costs && task.costs.billed) || 0).toFixed(4);
  const delta = +(spent - billed).toFixed(4);
  if (delta <= 0.00005) return { billed: 0, delta: 0 };
  try {
    const r = await db.billAndDeduct(task.userId, {
      taskId: task.id, kind: 'task', amount: delta,
      reason: reason + '「' + task.name + '」',
      /* 幂等键带上"计费前已计费金额"，同一笔差额重跑时命中的是同一把键 → 不会重复扣 */
      idemKey: 'task:' + task.id + ':' + billed.toFixed(4)
    });
    task.costs.billed = +(billed + delta).toFixed(4);
    await Store.saveTask(task);
    if (r.duplicate) log.info('bill_duplicate', { taskId: task.id, idemKey: 'task:' + task.id + ':' + billed.toFixed(4) });
    else log.info('bill_task', { taskId: task.id, userId: task.userId, delta, deducted: r.deducted, shortfall: r.shortfall });
    return { billed: r.deducted, delta, shortfall: r.shortfall, duplicate: r.duplicate };
  } catch (e) {
    /* 计费失败不阻断业务，但必须留下痕迹，否则就是"钱悄悄漏了" */
    log.error('bill_failed', { taskId: task.id, userId: task.userId, delta, msg: e.message });
    Store.logEvent(task.id, { step: 'bill', level: 'error', msg: '计费失败：' + e.message + '（差额 ¥' + delta + ' 未入账，可再次续跑重试）' }).catch(() => {});
    return { billed: 0, delta, error: e.message };
  }
}
/* 把任务当前累计成本计费到账（供"人工审完全部题目后"等场景调用） */
async function billTaskNow(taskId, reason) {
  const task = await Store.loadTask(taskId);
  if (!task) return null;
  return billTaskDelta(task, reason || '制题任务');
}

/* ============ 流水线主入口（幂等，可反复调用续跑） ============ */
async function runTask(taskId) {
  const task = await Store.loadTask(taskId);
  if (!task) throw new Error('任务不存在: ' + taskId);
  if (['completed', 'awaiting_review'].includes(task.status) && task.phase !== 'regen' && task.phase !== 'resume') return task;
  const cfg = Store.loadConfig();
  configure(cfg);
  const resolve = role => Store.profileFor(cfg, role);
  const poolOf = role => {
    const prof = cfg.profiles[role] || {};
    return (prof.providerIds || [])
      .map(id => cfg.providers.find(x => x.id === id))
      .filter(p => p && p.apiKey && p.enabled !== false)
      .map(p => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, apiKey: p.apiKey, priceIn: p.priceIn, priceOut: p.priceOut, role }));
  };
  const P = {
    get generator() { return resolve('generator'); }, get classifier() { return resolve('classifier'); },
    get verifier1() { return resolve('verifier1'); }, get verifier2() { return resolve('verifier2'); }
  };

  const meter = newMeter(task.budgetYuan);
  meter.spent = (task.costs && task.costs.spent) || 0;
  meter.byProfile = (task.costs && task.costs.byProfile) || {};
  meter.calls = (task.costs && task.costs.calls) || 0;

  const persist = async () => { task.costs = { spent: meter.spent, byProfile: meter.byProfile, calls: meter.calls, billed: (task.costs && task.costs.billed) || 0 }; await Store.saveTask(task); };
  const logEv = (step, msg, extra) => { Store.logEvent(taskId, Object.assign({ step, level: 'info', msg }, extra || {})).catch(() => {}); persist().catch(() => {}); };
  const call = async (prof, messages, o = {}) => {
    const opts = { meter, maxTokens: o.maxTokens || 3000, temperature: o.temperature == null ? 0.3 : o.temperature };
    /* 工具：只有显式给了才带上（不给则与改动前完全一致，向后兼容） */
    if (o.tools && o.tools.length) { opts.tools = o.tools; opts.toolChoice = o.toolChoice || 'auto'; }
    if (cfg.mockMode) {
      /* mockContent 允许是对象 {content, toolCalls} —— 用来覆盖"模型要求调工具"这条路径 */
      opts.mock = () => {
        const usage = M.mockUsage(o.inTok || 800, o.outTok || 600, prof);
        const mc = (typeof o.mockContent === 'function') ? o.mockContent(o.round) : o.mockContent;
        return (mc && typeof mc === 'object') ? Object.assign({ usage }, mc) : { content: mc, usage };
      };
    }
    const r = await callGuarded(prof, messages, opts);
    logEv(o.label || 'llm', (prof.label || prof.model) + ' 调用完成', { usage: r.usage });
    return r;
  };

  /* 资料分块（确定性结果，一次算好复用）＋ 已覆盖块集合（跨批次累积，保证覆盖率） */
  const fullText = (task.material && task.material.text) || '';
  const figMatch = fullText.match(/=====【资料附图[\s\S]*$/);
  const figSection = figMatch ? figMatch[0] : '';
  const chunks = Text.splitChunks(fullText);
  const covered = new Set(Array.isArray(task.coveredChunks) ? task.coveredChunks : []);
  /* 学生薄弱考点（真实答题数据回流）：出题时对薄弱点倾斜 */
  let weak = [];
  try { weak = await db.weakKPs(task.userId, 5); } catch (e) { /* 无答题数据时忽略 */ }

  task.status = 'running';
  try {
    /* ---- 阶段1：出题（按需求批次，幂等：跳过已完成的需求） ---- */
    task.phase = 'generate'; persist();
    const qs = await Store.loadQuestions(taskId);
    task.progress = task.progress || {};
    let dupTotal = 0;
    for (let ri = 0; ri < task.requirements.length; ri++) {
      const req = task.requirements[ri];
      task.progress[ri] = task.progress[ri] || 0;
      let guard = 0;
      /* 一条需求可以声明多种题型（types）：按题型依次各出 count 道。
       * 进度 task.progress[ri] 记"这条需求已生成的题数"，于是断点续跑能确定性地回到
       * "该出第几种题型的第几道"，既不重出也不漏出（segmentOf 负责这个换算）。 */
      const reqTotal = Reqs.countOf(req);
      const perBatch = cfg.mockMode ? 3 : 8;
      const maxBatches = Math.ceil(reqTotal / perBatch) * 3 + 5;
      while (task.progress[ri] < reqTotal) {
        const seg = Reqs.segmentOf(req, task.progress[ri]);
        const curType = seg.type;
        if (++guard > maxBatches) throw new Error('需求' + (ri + 1) + '连续 ' + guard + ' 批未能推进（已出 ' + task.progress[ri] + '/' + reqTotal + ' 题），已停止（请检查资料或考点设置）');
        const batchN = cfg.mockMode ? Math.min(3, seg.remainInType) : Math.min(8, seg.remainInType);
        const chName_ = (task.subject.chapters.find(c => c.no === req.ch) || {}).name || '';
        const memHint = memoryPrompt({ query: req.kp || '', kp: req.kp || '' });
        const sys = '你是考研资料制题专家，只依据给定资料出题，答案必须准确。' +
          '只输出一个 JSON 数组，不要任何解释文字或markdown标记。' + memHint +
          kpPrompt(task.kps, req) +
          /* 客户的原始额外要求（"不要出计算题""解析要详细"这类）原样注入 —— 旧实现解析完就丢了 */
          (task.constraints && task.constraints.length
            ? '\n【客户提出的额外要求（必须逐条满足）】\n' + task.constraints.map(c => '· ' + c).join('\n') : '') +
          (weak.length ? '\n【学生薄弱考点（可适当倾斜，但不得超出资料范围）】\n' + weak.map(w => '· ' + w.kp + '（正确率 ' + Math.round(100 * w.ok / w.n) + '%）').join('\n') : '');
        /* 按块检索取材：优先挑本次任务还没用过的块，多批次跑完可覆盖整份资料 */
        const sel = Text.selectChunks(chunks, {
          query: req.kp || chName_, wantCh: req.ch, used: covered, budgetChars: CONTEXT_BUDGET
        });
        sel.picked.forEach(i => covered.add(i));
        const figHint = (task.figures && task.figures.length)
          ? '\n资料中包含【资料附图】段落，每条以【图片id】开头（如【p04_img01】）。' +
            '若某道题是基于某张附图出的，必须在题目 JSON 中加 "fig":"图片id" 字段；不基于附图则不加该字段。'
          : '';
        const recent = Text.briefStems(qs, 14, 40);
        const multiTypeHint = seg.types.length > 1
          ? '（本考点共需 ' + seg.types.length + ' 种题型各 ' + seg.perType + ' 道，当前出' + seg.phaseLabel + '）'
          : '';
        const user = '为「' + task.subject.school + ' ' + task.subject.name + '」出 ' + batchN + ' 道' + TYPE_CN[curType] + multiTypeHint +
          '。章节：第' + req.ch + '章 ' + chName_ + (req.kp ? '；重点考点：' + req.kp : '') + '。' +
          (req.diff ? '目标难度：' + ['', '基础', '强化', '冲刺'][req.diff] + '。' : '') +
          (curType === 'mcq'
            ? '每题格式：{"stem":"题干","options":["A内容","B内容","C内容","D内容"],"answer":"正确选项字母","expl":"解析","kp":"具体考点"}，恰好4个选项且仅一个正确。'
            : '每题格式：{"stem":"题干（含小问）","ref":"分步骤的参考答案与解析要点","kp":"具体考点"}。') +
          figHint +
          (recent ? '\n【本任务已出过的题（严禁重复或近似重复）】\n' + recent : '') +
          '\n\n' + wrapMaterial(sel.text + (figSection ? '\n' + figSection.slice(0, FIG_BUDGET) : ''));
        const r = await call(P.generator, [{ role: 'system', content: sys }, { role: 'user', content: user }], {
          label: 'generate', maxTokens: 4000, temperature: 0.4, pool: poolOf('generator'),
          /* mock 也要拿到当前正在出的题型，否则演示模式会一直造选择题 */
          mockContent: M.mockGenerate(Object.assign({}, req, { count: batchN, type: curType }), task.progress[ri], task.material.text, task.figures),
          inTok: Math.ceil(sel.text.length / 1.4) + 400, outTok: batchN * 450
        });
        let arr = extractJSON(r.content);
        if (!Array.isArray(arr)) arr = [];
        let made = 0, dups = 0;
        const fresh = [];
        const rejects = [];      // 记录每道被丢弃的题及其原因，0 产出时直接写进日志
        arr.slice(0, batchN).forEach((d, k) => {
          if (!d || !d.stem) { rejects.push('第' + (k + 1) + '条缺 stem'); return; }
          const q = {
            /* seq = 这道题最终在整个任务里的序号。注意要加 fresh.length：
             * 本批的题目先攒在 fresh 里，最后才并入 qs，若只写 qs.length 则同批题目序号全相同
             * （演示模式的"分歧按题号分布"会因此失效 —— 全批一起分歧或一起一致）。 */
            id: Store.id('q'), seq: qs.length + fresh.length, reqIdx: ri, type: curType, ch: req.ch,
            kp: String(d.kp || req.kp || '未标注').slice(0, 60),
            stem: String(d.stem), diff: null, status: 'pending', adjudicated: false,
            /* seq 也存进 gen：演示模式的"分歧分布"按 seq 决定，
             * 断点续跑时会从数据库重新读题，丢掉 seq 就会让同一批题全部分歧或全部一致。 */
            verdicts: [], gen: { model: cfg.mockMode ? 'mock' : P.generator.model, chunks: sel.picked, seq: qs.length + fresh.length }
          };
          if (d.fig && task.figures && task.figures.some(f => f.id === d.fig)) q.fig = String(d.fig);
          if (curType === 'mcq') {
            const opts = Array.isArray(d.options) ? d.options.map(String) : [];
            const ans = String(d.answer || '').trim().toUpperCase()[0];
            if (opts.length < 4 || !'ABCD'.includes(ans)) { rejects.push('第' + (k + 1) + '条选择题选项/答案不合格(选项' + opts.length + '个,答案"' + ans + '")'); return; }
            q.options = opts.slice(0, 4); q.answer = ans; q.expl = String(d.expl || '');
          } else {
            if (!d.ref) { rejects.push('第' + (k + 1) + '条主观题缺 ref'); return; }
            q.ref = String(d.ref);
          }
          fresh.push(q);
        });
        /* 近似重复检测：命中就打 dup_of 标记。不丢弃（不丢数据、也不会因反复重试卡死），
         * 但被标记的题不参与自动入库，会进人工队列由人判断。 */
        if (!cfg.mockMode) {
          const pool = qs.concat(fresh);
          for (const q of fresh) {
            const hit = Text.findDuplicate(q.stem, pool.filter(x => x !== q), DUP_THRESHOLD);
            if (hit) { q.dup_of = hit.id; q.gen.dupScore = +Text.similarity(q.stem, hit.stem).toFixed(3); dups++; }
          }
        }
        fresh.forEach(q => { qs.push(q); made++; });
        dupTotal += dups;
        task.progress[ri] += made;
        logEv('generate', '需求' + (ri + 1) + (req.kp ? '「' + req.kp + '」' : '') + '：本批生成 ' + made + ' 题' + TYPE_CN[curType] + '（累计 ' + task.progress[ri] + '/' + reqTotal + '）' +
          (dups ? '，其中 ' + dups + ' 题疑似与已出题重复（已标记，人工复核）' : '') +
          '，取材块 ' + sel.picked.join(','));
        /* 逐题落库：只写本批新增的题，不再"每次重写全部题目"（旧实现是 O(题数²) 次写库） */
        for (const q of fresh) await Store.saveQuestion(taskId, q);
        await persist();
        if (made === 0) {
          /* 把"原始输出长什么样、每条为什么被丢"一并写进事件日志，否则只有一个
           * "返回 0 题"根本无从排查（这一步在真实环境排障时救过命）。 */
          const raw = String(r.content || '');
          logEv('generate', '本批 0 题，丢弃明细：' + (rejects.join('；') || '解析后为空数组') +
            '｜模型原始输出前 300 字：' + raw.slice(0, 300).replace(/\s+/g, ' '));
          throw new Error('出题批次返回 0 题（' + (rejects.join('；') || '模型未返回题目数组') + '）');
        }
      }
    }

    /* ---- 阶段2：难度标注（批量，幂等：只标未标的） ---- */
    task.phase = 'tag'; persist();
    let untagged = qs.filter(q => !q.diff);
    if (untagged.length) {
      const sys = '你是试题难度分析师。只输出 JSON。';
      const user = '为下列每道题评估难度（1=简单/基础，2=中等/强化，3=困难/冲刺），' +
        '依据：概念深度、步骤多寡、易错程度。\n只输出：{"results":[{"id":"题目id","diff":1}]}\n\n' +
        untagged.map(q => ({ id: q.id, type: TYPE_CN[q.type], kp: q.kp, stem: q.stem.slice(0, 120) })).map(JSON.stringify).join('\n');
      const r = await call(P.classifier || P.generator, [{ role: 'system', content: sys }, { role: 'user', content: user }], {
        label: 'tag', maxTokens: 2000, pool: poolOf(cfg.profiles.classifier ? 'classifier' : 'generator'),
        mockContent: M.mockTagEach(untagged), inTok: untagged.length * 150, outTok: untagged.length * 15
      });
      const parsed = extractJSON(r.content);
      const map = new Map((parsed.results || parsed || []).map(x => [x.id, clampDiff(x.diff)]));
      untagged.forEach(q => { q.diff = map.has(q.id) ? map.get(q.id) : 2; });
      logEv('tag', '难度标注完成：' + untagged.length + ' 题');
      for (const q of untagged) await Store.saveQuestion(taskId, q);
    }

    /* ---- 阶段3：交叉质检（每题 × 每家质检员，独立重解；幂等：补缺） ---- */
    task.phase = 'verify'; persist();
    const verifiers = VERIFIER_KEYS
      .filter(k => cfg.profiles[k])
      .map(k => ({ key: k, prof: resolve(k) }))
      .filter(x => x.prof && !x.prof.missing && x.prof.apiKey);
    for (const q of qs) {
      if (['rejected'].includes(q.status)) continue;
      for (let vi = 0; vi < verifiers.length; vi++) {
        const key = verifiers[vi].key;
        if (q.verdicts.some(v => v.by === key)) continue;
        /* 每个质检员按自己的「视角」审题 —— 换视角 = 换一条解题路径 */
        const lens = verifiers[vi].prof.lens || require('./lenses').get(null, key);
        /* 只在"看起来需要计算/推演"的题上给工具：纯概念题给工具只会产生白调（多花钱、无收益）。 */
        const useTools = toolsEnabled() && needsCalc(q);
        /* run_code：另一条判据（推演题）+ **必须沙箱可用**（不可用就不给，宁可不给也不在本机跑它的代码）。
         * dockerAvailable 结果有缓存，所以这里每题 await 一次的成本可忽略。 */
        const plan = await runToolPlan(q);
        const useRun = plan.use;
        if (plan.reason === 'sandbox-unavailable') {
          logEv('verify', 'run_code 工具未启用（' + plan.detail + '）—— 本题按无工具模式质检',
            { question: q.id, level: 'warn' });
        }
        const sys = '你是独立阅卷质检员，凭自己的专业知识解题，绝不参考、不猜测任何"已有答案"。只输出 JSON。\n'
          + '【本次质检视角：' + lens.label + '】' + lens.system
          + (useTools ? TOOL_RULE : '') + (useRun ? RUN_TOOL_RULE : '');
        let user;
        if (q.type === 'mcq') {
          user = '独立解答这道' + TYPE_CN[q.type] + '（不要看任何给定答案）：\n' + q.stem +
            '\n' + q.options.map((o, i) => 'ABCD'[i] + '. ' + o).join('\n') +
            '\n' + lens.solve +
            '\n只输出：{"answer":"正确选项字母","reason":"50字内理由","confidence":0到1}';
        } else {
          user = '先独立解答这道' + TYPE_CN[q.type] + '（写出你的答案要点），再与下面的"待检参考答案"对比，' +
            '判断参考答案是否存在实质性错误或重大遗漏：\n【题目】' + q.stem + '\n【待检参考答案】' + q.ref +
            '\n' + lens.verify +
            '\n只输出：{"independent":"你的独立答案要点(80字内)","verdict":"consistent或error或uncertain","issue":"若有问题，指出问题；无则空串"}';
        }
        /* 有界工具循环（最多 3 轮，循环在单题内、不跨题 → 不影响断点续跑）。
         * 不用工具时 tools 传 null → 内部走原来的单次调用路径，行为与改动前一致。 */
        const sol = await Solve.solveWithTools(call, verifiers[vi].prof, sys, user, {
          label: 'verify', temperature: lens.temp, maxTokens: (useTools || useRun) ? 1600 : 1200, pool: poolOf(key),
          tools: (useTools || useRun) ? Tools.list({ runCode: useRun }) : null,
          /* 工具执行器：run_code 走沙箱（异步），calc 走原来的同步实现。
           * ⚠ ctx.runCode 只在 useRun 时注入 —— 这样"没给这个工具"与"给了"在内核上就是两回事：
           * 模型硬要调一个没给它的工具，会拿到明确错误而不是被真的执行（见 tools.callAsync 的注释）。 */
          runTool: Tools.buildRunTool(useRun),
          mockContent: r2 => M.mockVerify(q, vi + 1, r2, { run: useRun }), inTok: 420, outTok: 200
        });
        const r = { content: sol.content };
        let v;
        try {
          const p = extractJSON(r.content);
          v = q.type === 'mcq'
            ? { by: key, lens: lens.id, lensLabel: lens.label, model: cfg.mockMode ? 'mock' : verifiers[vi].prof.model, answer: String(p.answer || '').trim().toUpperCase()[0] || '?', reason: String(p.reason || ''), confidence: +p.confidence || 0.8, match: String(p.answer || '').trim().toUpperCase()[0] === q.answer }
            : { by: key, lens: lens.id, lensLabel: lens.label, model: cfg.mockMode ? 'mock' : verifiers[vi].prof.model, independent: String(p.independent || ''), verdict: String(p.verdict || 'uncertain'), issue: String(p.issue || ''), match: p.verdict === 'consistent' };
        } catch (e) { v = { by: key, lens: lens.id, lensLabel: lens.label, model: verifiers[vi].prof.model, answer: '?', reason: '质检返回无法解析：' + e.message, match: false }; }
        if (sol.degraded) {
          /* 供应商/模型不支持 tools → 该质检员本次已自动改用无工具模式（不让任务失败）。
           * 记 warn 让它可见：持续出现说明这家供应商该换，或该在配置里关掉工具。 */
          v.degraded = true;
          logEv('verify', '质检员' + (vi + 1) + ' 的模型不支持工具调用，本次已降级为无工具模式',
            { question: q.id, level: 'warn' });
        }
        if (useTools || useRun) {
          v.tools = sol.tools;                                   // 工具调用明细（含 name，能区分 calc 与 run_code）
          v.rounds = sol.rounds;
          if (sol.forced) v.forced = true;                       // 用满轮数被强制收口
          if (sol.tools.some(t => !t.ok)) v.toolFailed = true;   // 工具算不出来（题目或表达式有问题）
          /* 漏调分两种：calc 的判据说"该算"、run_code 的判据说"该推演"，各自统计 ——
           * 混在一起就分不清是哪条判据的问题了。 */
          const calcCalls = sol.tools.filter(t => t.name === TOOL_NAME).length;
          const runCalls = sol.tools.filter(t => t.name === RUN_CODE_NAME).length;
          if (useTools && !calcCalls) v.missedCalc = true;
          if (useRun && !runCalls) v.missedRun = true;
          /* ★ 心算 vs 工具结果对不上：只作为**信号**存档，不直接进裁决。
           * 误报风险：模型可能先用工具算出中间值、再自己合并成最终答案，那不是错。
           * 判定口径保守：工具成功返回过数字、且模型给出的数字没有一个出现在工具结果里。 */
          const tNums = {};
          sol.tools.filter(t => t.ok).forEach(t => {
            const m = String(t.result).match(/-?\d+(?:\.\d+)?/g) || [];
            m.forEach(x => { tNums[x] = 1; });
          });
          const aText = [v.answer, v.reason, v.independent, v.issue].filter(Boolean).join(' ');
          const aNums = aText.match(/-?\d+(?:\.\d+)?/g) || [];
          if (sol.tools.length && Object.keys(tNums).length && aNums.length
              && !aNums.some(x => tNums[x])) v.calcMismatch = true;
        }
        q.verdicts.push(v);
        if (useTools || useRun) {
          const parts = [];
          if (useTools) parts.push(TOOL_NAME + ' ' + sol.tools.filter(t => t.name === TOOL_NAME).length + ' 次'
            + (sol.tools.filter(t => t.name === TOOL_NAME).length ? '' : '（判定需要计算但未调用）'));
          if (useRun) parts.push(RUN_CODE_NAME + ' ' + sol.tools.filter(t => t.name === RUN_CODE_NAME).length + ' 次'
            + (sol.tools.filter(t => t.name === RUN_CODE_NAME).length ? '' : '（判定需要推演但未调用）'));
          logEv('verify', '质检员' + (vi + 1) + ' 工具使用：' + parts.join('；')
            + (sol.forced ? '（用满轮数被强制收口）' : '')
            + (sol.tools.some(t => !t.ok) ? '（含失败调用）' : ''), { question: q.id });
        }
        /* 只落这一题：旧实现这里每次重写全部题目，100 题 × 2 质检员 = 2 万次写库，任务卡死的主因 */
        await Store.saveQuestion(taskId, q);
      }
    }

    /* ---- 阶段4：裁决（共识→自动入库；分歧→人工队列） ---- */
    task.phase = 'adjudicate'; persist();
    for (const q of qs) {
      if (q.adjudicated || q.status !== 'pending') continue;
      const need = verifiers.length;
      if (q.verdicts.length < need) continue;
      const consensus = q.verdicts.every(v => v.match);
      q.consensus = consensus;
      if (q.dup_of) {
        /* 近似重复题即使全员一致也不自动入库：先让人看一眼是不是真重复 */
        q.status = 'needs_review';
        q.adjudicated = true;
        logEv('adjudicate', q.id + ' 疑似与 ' + q.dup_of + ' 重复，转人工确认');
        continue;
      }
      q.status = consensus ? 'auto_accepted' : 'needs_review';
      q.adjudicated = true;
      logEv('adjudicate', q.id + ' ' + (consensus ? '共识达成，自动入库' : '质检分歧，进入人工队列'));
    }
    for (const q of qs) if (q.adjudicated) await Store.saveQuestion(taskId, q);
    refreshStats(task, qs);
    /* 覆盖率：哪些知识点一道题都没覆盖到（有知识点清单时才计算） */
    if (Array.isArray(task.kps) && task.kps.length) {
      const cov = KP.coverage(task.kps, qs);
      task.stats.coverage = { total: cov.total, covered: cov.covered, missing: cov.missing };
      if (cov.missing.length) logEv('coverage', '有 ' + cov.missing.length + ' 个知识点没有出到题：' + cov.missing.slice(0, 8).join('、'));
      /* 客户明确要求"覆盖全部知识点"时自动补齐（最多 2 轮，每轮只补缺的考点）。
       * runTask 是幂等的：已出的题与已完成的质检不会重做，只补新增的这几道。 */
      if (cov.missing.length && task.coverageStrict && (task.coverRounds || 0) < 2) {
        task.coverRounds = (task.coverRounds || 0) + 1;
        const baseTypes = Reqs.typesOf(task.requirements[0] || {}).slice(0, 1);
        const addReqs = Reqs.forMissingKPs(cov.missing, task.kps, { count: 1, types: baseTypes, diff: 2 });
        task.requirements.push(...addReqs);
        await persist();
        logEv('coverage', '自动补题第 ' + task.coverRounds + ' 轮：为 ' + cov.missing.length + ' 个未覆盖知识点各补 1 道（' + addReqs.map(r => r.kp).slice(0, 5).join('、') + '）');
        return runTask(taskId);
      }
    }
    if (dupTotal) logEv('dedupe', '共识别出 ' + dupTotal + ' 道疑似重复题，已标记待人工确认');
    task.coveredChunks = [...covered];
    task.phase = null;
    task.status = qs.some(q => q.status === 'needs_review') ? 'awaiting_review' : 'completed';
    await persist();
    /* ---- 计费：只要流水线停下来就结算差额（含 awaiting_review —— 旧实现漏的正是这一支） ---- */
    await billTaskDelta(task, '制题任务');
    logEv('pipeline', '流水线结束：' + task.status);
    return task;
  } catch (e) {
    task.status = e instanceof BudgetExceeded ? 'paused_budget' : 'paused_error';
    task.error = e.message;
    task.coveredChunks = [...covered];
    await persist();
    /* 暂停也要结算已花的钱：钱是真花了，不能因为"没跑完"就不入账 */
    await billTaskDelta(task, e instanceof BudgetExceeded ? '制题任务（预算暂停结算）' : '制题任务（异常暂停结算）');
    Store.logEvent(taskId, { step: 'pipeline', level: 'error', msg: (e instanceof BudgetExceeded ? '预算暂停：' : '异常暂停：') + e.message }).catch(() => {});
    throw e;
  }
}

function refreshStats(task, qs) {
  task.stats = Object.assign(task.stats && task.stats.coverage ? { coverage: task.stats.coverage } : {}, {
    generated: qs.filter(q => q.status !== 'rejected').length,
    autoAccepted: qs.filter(q => q.status === 'auto_accepted').length,
    toReview: qs.filter(q => q.status === 'needs_review').length,
    accepted: qs.filter(q => q.status === 'accepted').length,
    rejected: qs.filter(q => q.status === 'rejected').length,
    duplicates: qs.filter(q => q.dup_of).length
  });
}

/* ============ 人工裁决 ============ */
/* 只接受白名单字段，避免请求体里的任意字段被写进题目（旧的 Object.assign(q, edits) 可以改 status/id） */
const EDITABLE_FIELDS = ['stem', 'options', 'answer', 'expl', 'ref', 'kp', 'ch', 'diff', 'type'];
function pickEdits(edits) {
  const out = {};
  for (const k of EDITABLE_FIELDS) if (edits && edits[k] !== undefined) out[k] = edits[k];
  return out;
}
async function decide(taskId, qid, action, edits) {
  const task = await Store.loadTask(taskId);
  const qs = await Store.loadQuestions(taskId);
  const q = qs.find(x => x.id === qid);
  if (!q) throw new Error('题目不存在');
  if (action === 'accept') q.status = 'accepted';
  else if (action === 'edit_accept') {
    const clean = pickEdits(edits);
    /* 字段级校验：题干/参考答案限长，选项必须四个且答案在 ABCD 内 */
    if (clean.stem != null) clean.stem = String(clean.stem).slice(0, 5000);
    if (clean.ref != null) clean.ref = String(clean.ref).slice(0, 5000);
    if (clean.expl != null) clean.expl = String(clean.expl).slice(0, 3000);
    if (clean.kp != null) clean.kp = String(clean.kp).slice(0, 60);
    if (clean.ch != null) clean.ch = Math.max(1, Math.min(20, Math.round(+clean.ch) || 1));
    if (clean.diff != null) clean.diff = clampDiff(clean.diff);
    if (clean.options != null) clean.options = (Array.isArray(clean.options) ? clean.options : []).slice(0, 4).map(o => String(o).slice(0, 1000));
    if (clean.answer != null) clean.answer = String(clean.answer).trim().toUpperCase().slice(0, 1);
    Object.assign(q, clean);
    if (q.type === 'mcq' && !(q.options && q.options.length === 4 && 'ABCD'.includes(q.answer))) throw new Error('编辑后选择题字段不合法（需 4 个选项且答案为 A/B/C/D）');
    q.status = 'accepted';
    q.dup_of = null;                       // 人工确认过（可能是重复也可能不是），不再标记
    /* 人工修正沉淀进经验库：带上"错在哪/正解是什么"，而不是一句空洞的"被改过" */
    const diffFields = [];
    const before = edits && edits.__before;
    for (const k of ['stem', 'answer', 'ref', 'expl']) {
      if (clean[k] != null && before && before[k] != null && String(before[k]) !== String(clean[k])) diffFields.push(k);
    }
    const label = { stem: '题干', answer: '答案', ref: '参考答案', expl: '解析' };
    /* 沉淀进经验库。有 __before 时写清"改了哪几个字段"（信息量最大）；
     * 调用方没带 __before（直接调 API）时也要沉淀，否则"人工修正一定会变成记忆"这条保证就没了。 */
    const changedDesc = diffFields.length ? '（改了' + diffFields.map(k => label[k]).join('、') + '）' : (before ? '（内容与生成版一致，人工确认采纳）' : '');
    Store.addMemory({
      kind: 'correction',
      kp: q.kp,
      taskName: task.name,
      text: '【' + task.name + '｜' + (q.kp || '未标注考点') + '】人工修正了一道' + TYPE_CN[q.type] + changedDesc +
        '；该考点的题后续出题请按人工定稿口径：' + String(clean.stem || q.stem).replace(/\s+/g, ' ').slice(0, 80) +
        (clean.answer ? '（正确答案 ' + clean.answer + '）' : '')
    });
  } else if (action === 'reject') {
    q.status = 'rejected';
    /* 不变式维护：被驳回的题不再可练习，必须同时移除它的 qstate 行，
     * 否则题库列表（由 qstate 驱动）还会把它列出来。 */
    await db.q('DELETE FROM qstate WHERE user_id=? AND question_id=?', [task.userId, q.id]).catch(() => {});
  }
  else throw new Error('未知操作');
  q.human = { action, ts: Date.now() };
  /* fromHuman=true：这是人的决定，必须覆盖流水线可能残留的陈旧状态 */
  await Store.saveQuestion(taskId, q, { fromHuman: true });
  const fresh = await Store.loadQuestions(taskId);
  refreshStats(task, fresh);
  if (task.status === 'awaiting_review' && !fresh.some(x => x.status === 'needs_review')) task.status = 'completed';
  await Store.saveTask(task);
  Store.logEvent(taskId, { step: 'human', level: 'info', msg: qid + ' 人工裁决：' + action }).catch(() => {});
  return { task, question: q };
}

/* ============ 打回重新生成单题 ============ */
async function regenQuestion(taskId, qid) {
  const task = await Store.loadTask(taskId);
  const qs = await Store.loadQuestions(taskId);
  const old = qs.find(x => x.id === qid);
  if (!old) throw new Error('题目不存在');
  old.status = 'rejected';
  old.human = { action: 'regen', ts: Date.now() };
  /* 同上：打回重做的题在替换完成前不参与练习 */
  await db.q('DELETE FROM qstate WHERE user_id=? AND question_id=?', [task.userId, old.id]).catch(() => {});
  task.requirements.push({ type: old.type, count: 1, ch: old.ch, kp: old.kp, diff: old.diff });
  task.progress = task.progress || {};
  task.progress[task.requirements.length - 1] = 0;
  /* 单题重生成是用户主动发起的有限操作：自动小额追加预算（按原估算的 10%），避免被预算闸卡死；仍留痕 */
  const topUp = +((task.quote && task.quote.est && task.quote.est.total || 0.01) * 0.1).toFixed(4);
  task.budgetYuan = +(task.budgetYuan + topUp).toFixed(4);
  await Store.saveQuestion(taskId, old, { fromHuman: true });
  Store.logEvent(taskId, { step: 'human', level: 'info', msg: qid + ' 打回重新生成（新增单题需求，预算自动追加 ¥' + topUp + '）' }).catch(() => {});
  /* 必须先落盘标记 regen，否则 runTask 从磁盘读回时会误判为"已完成"直接返回 */
  task.phase = 'regen';
  await Store.saveTask(task);
  return runTask(taskId);
}

/* ============ 导出科目包（兼容刷题系统的 registerSubject 格式） ============ */
async function exportPack(taskId, { embedImages = true } = {}) {
  const fs = require('fs');
  const task = await Store.loadTask(taskId);
  const qs = (await Store.loadQuestions(taskId)).filter(q => q.status === 'accepted' || q.status === 'auto_accepted');
  if (!qs.length) throw new Error('没有已采纳的题目可导出');
  const pid = 'qf_' + Date.now().toString(36);
  const figMap = new Map((task.figures || []).map(f => [f.id, f]));
  let embedded = 0, skipped = 0;
  const questions = qs.map(q => {
    const o = {
      id: pid + '_' + q.id, src: 'QuestionForge·' + task.name, type: q.type, ch: q.ch,
      kp: q.kp, diff: q.diff || 2, stem: q.stem,
      note: 'AI生成，经多模型交叉质检' + (q.human ? '与人工审核' : '')
    };
    if (q.type === 'mcq') { o.options = q.options; o.answer = q.answer; o.expl = q.expl; }
    else o.sub = [{ ask: '参考答案与解析', ref: q.ref }];
    if (q.fig && figMap.has(q.fig) && embedImages) {
      const fig = figMap.get(q.fig);
      try {
        const buf = fs.readFileSync(fig.file);
        const mime = fig.file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
        o.img = 'data:' + mime + ';base64,' + buf.toString('base64');
        embedded++;
      } catch (e) { skipped++; }
    } else if (q.fig) skipped++;
    return o;
  });
  const pack = {
    id: pid, name: task.subject.name + '（AI制题）', school: task.subject.school,
    storagePrefix: pid + '_',
    paperInfo: 'QuestionForge 生成题库 · ' + questions.length + ' 题' + (embedded ? '（含 ' + embedded + ' 张原图）' : ''),
    goal: '由制题 Agent 依据客户资料生成的复习题库。',
    books: [],
    aiPersona: '你是考研辅导老师，针对本科目（' + task.subject.name + '）为学生讲题与分析薄弱点。用中文和 markdown 回答。',
    syllabus: { chapters: task.subject.chapters.map(c => ({ no: c.no, name: c.name, secs: [] })) },
    knowledgePoints: (task.kps || []).map(k => ({ ch: k.ch, name: k.name, detail: k.detail || '' })),
    questions
  };
  const content = '/* 科目包：由 QuestionForge 导出 · ' + new Date().toISOString() + ' */\n' +
    "'use strict';\nregisterSubject(" + JSON.stringify(pack, null, 2) + ');\n';
  const file = Store.savePack('subject-' + pid + '.js', content);
  const sizeKB = Math.round(fs.statSync(file).size / 1024);
  task.exported = { file: path.basename(file), packId: pid, count: questions.length, embedded, sizeKB, ts: Date.now() };
  await Store.saveTask(task);
  await Store.logEvent(taskId, {
    step: 'export', level: 'info',
    msg: '导出科目包 ' + pid + '（' + questions.length + ' 题，内嵌原图 ' + embedded + ' 张' +
      (skipped ? '，跳过 ' + skipped + ' 张' : '') + '，' + sizeKB + 'KB）'
  });
  return { file: path.basename(file), packId: pid, count: questions.length, embedded, sizeKB, content };
}

/* ============ 服务重启后的孤儿任务处理 ============ */
/* 进程重启后 running 集合是空的，但库里的任务状态还停在 running，
 * 而 /run 接口又不接受 running → 用户被永久锁死（实测踩到过两个 200 题的任务）。
 * 这里在启动时把这类任务改成"异常暂停"，用户即可从断点续跑。 */
async function recoverOrphans() {
  const [rows] = await db.q("SELECT id, name FROM tasks WHERE status='running'");
  for (const r of rows) {
    await db.q("UPDATE tasks SET status='paused_error', error='服务重启导致流水线中断（题目与质检进度已保留，可从断点续跑）' WHERE id=? AND status='running'", [r.id]);
    await Store.logEvent(r.id, { step: 'pipeline', level: 'warn', msg: '服务重启，任务中断，已转为「异常暂停」，可从断点续跑' }).catch(() => {});
    log.warn('orphan_task_recovered', { taskId: r.id, name: r.name });
  }
  return rows.length;
}

module.exports = { runTask, decide, regenQuestion, exportPack, recoverOrphans, billTaskDelta, billTaskNow, extractJSON, TYPE_CN, EDITABLE_FIELDS, needsCalc, needsRunCode, runToolPlan, toolsEnabled, runToolEnabled };
