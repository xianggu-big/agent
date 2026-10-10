/* 模型评测框架（② · 阶段 1）：把"跑一批题 → 判分 → 出指标"抽成可复用跑批引擎
 *
 * 定位（先划边界，免得做成"大而全"）：
 *   **不做通用评测平台**（那条路上有 promptfoo / OpenCompass / Braintrust，做不过它们）。
 *   只做：面向本项目的任务集、以**可执行判分**为主、零新依赖、能跑在本机与 CI 的轻量跑批。
 *
 * 三处可插拔（这是本文件存在的全部理由）：
 *
 *     题集（testdata/suites/*.js）  ×  判分方式（exec / structured / judge）  ×  模型（岗位绑定）
 *
 * 与 lib/evals.js 的 runVerifierEval 的关系：**并列复用，不是替换**。
 *   金标集评估回答"我的质检员在真题上准不准"（题来自金标题库，本质是 mcq）；
 *   本模块回答"这套题上哪个模型更好"（题集自带判分方式，可以是跑代码）。
 *   两者共用 lib/llm.js（调用/计费）与 lib/tools.js，绝不各写一份调用逻辑。
 *
 * 为什么判分要分三级（可信度差一个数量级，报告里必须标明用的哪种）：
 *   exec       跑代码/表达式，与标准答案比对        ← 首选，唯一"客观"的一种
 *   structured 要求固定 JSON 字段，逐字段比对       ← 抽取/分类类任务
 *   judge      让另一个模型判分                     ← 备选，必须双向对照防位置偏置
 *
 * 花钱防护（这是本模块最容易出事的地方）：
 *   默认**只跑 mock**（不发出任何真实请求，返回可复现的模拟结果）；
 *   真实调用必须显式 real: true（CLI 上是 --real），且先打印预估费用。
 *   这条由 evalsuite_test.js 的"网络哨兵"断言守着（mock 跑完 fetch 调用数必须为 0）。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
/* 子进程相关都搬去 lib/coderun.js 了（评测与质检的 run_code 工具共用一份），这里不再直接起进程 */
const Store = require('./store');
const { callLLM, configure } = require('./llm');

const SUITE_DIR = path.join(__dirname, '..', 'testdata', 'suites');
/* 题集的两个来源（与 lib/evals.js 的"金标题库候选路径"同一套思路）：
 *   ① testdata/suites/  仓库内置的**合成夹具**（随仓库走，CI 上也有）
 *   ② data/suites/      本机题集，**第三方真题放这里** —— data/ 已 gitignore，
 *                       真题不进仓库（授权/版权与体积两个原因）；没有这个目录也不影响任何东西。
 * 同名时以仓库内置的为准（免得本地文件悄悄改变 CI 的行为）。 */
const SUITE_DIRS = [SUITE_DIR, path.join(Store.dirs.root, 'suites')];
const JUDGES = ['exec', 'structured', 'judge'];
const JUDGE_CN = {
  exec: 'exec —— 编译并运行模型交付的代码，与隐藏用例的标准答案比对（可信度最高）',
  structured: 'structured —— 要求固定 JSON 字段，逐字段比对',
  judge: 'judge —— 另一个模型判分（已强制双向对照，换了顺序跑两遍）'
};
/* exec 判分要跑模型生成的代码：仅本机实验用途，必须带超时。
 * 生产环境绝不能用这种方式执行模型生成的代码（需容器沙箱：断网/只读/限额/非 root）。
 * 运行器本体已抽到 lib/coderun.js（评测与"质检的 run_code 工具"两处共用一份安全敏感代码）。 */
const CodeRun = require('./coderun');
const DEFAULTS = { compileTimeoutMs: 30000, runTimeoutMs: 5000, maxRoundsPerItem: 1 };

/* ---------------- 小工具 ---------------- */
const hashByte = s => crypto.createHash('md5').update(String(s)).digest()[0];

/* 输出归一化（实现在 coderun，那里也要用；只留一份，避免两处漂移） */
const normalizeOut = CodeRun.normalizeOut;

/* 从模型返回里抠 JSON（容忍 ```json 围栏与前后废话） */
function extractJSON(text) {
  if (!text) return null;
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch (e) { /* 往下试截取 */ }
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch (e) { /* 放弃 */ } }
  return null;
}

function pct(n, d) { return d ? +(100 * n / d).toFixed(1) : 0; }
function percentile(arr, p) {
  const a = arr.slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  const i = Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1));
  return a[i];
}
/* 简易并发池：按顺序取任务、最多 limit 个在跑，结果**按传入顺序**返回
 * （顺序固定，报告与断言才有确定性）。任何一个任务抛错都不影响其它任务 ——
 * runOne 自己已经把失败兜成记录，这里再兜一层是为了"池子本身不许把整批打挂"。 */
async function runPool(tasks, limit) {
  const n = Math.max(1, Math.min(limit || 1, tasks.length || 1));
  const out = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      try { out[i] = await tasks[i](); } catch (e) { out[i] = { error: String(e && e.message || e) }; }
    }
  };
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

/* ---------------- 题集加载与校验 ---------------- */
function listSuites() {
  const out = [];
  const seen = new Set();
  for (const dir of SUITE_DIRS) {
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.js')); } catch (e) { continue; }   // 本地题集目录不存在是正常的
    const local = dir !== SUITE_DIR;
    for (const f of files) {
      let s = null;
      try { s = require(path.join(dir, f)); } catch (e) { /* 坏文件不让整个列表挂掉，但要能被看见 */
        if (!seen.has(f)) { seen.add(f); out.push({ id: f, title: '（无法加载）', judge: null, items: 0, file: f, dir, local, error: e.message }); }
        continue;
      }
      if (!s || !s.id) continue;
      if (seen.has(s.id)) continue;      // 同名以仓库内置的为准（先扫的就是它）
      seen.add(s.id);
      out.push({
        id: s.id, title: s.title || s.id, judge: s.judge || 'exec',
        items: (s.items || []).length, file: f, dir, local,
        groups: [...new Set((s.items || []).map(x => x.group).filter(Boolean))],
        note: s.note || ''
      });
    }
  }
  return out;
}

/* 校验题集与判分方式是否匹配。
 * 这一步是实施方案里承诺的兜底："题集与判分不匹配（如 mcq 用 exec 判）→ 跑前报错，
 * 而不是静默跳过"（静默跳过会把"少判了一半题"伪装成"准确率很高"）。 */
function validateSuite(s) {
  if (!s || typeof s !== 'object') throw new Error('题集不是一个对象');
  if (!s.id) throw new Error('题集缺少 id');
  if (!JUDGES.includes(s.judge)) throw new Error('题集 ' + s.id + ' 的 judge 非法：' + s.judge + '（可选 ' + JUDGES.join(' / ') + '）');
  if (!Array.isArray(s.items) || !s.items.length) throw new Error('题集 ' + s.id + ' 没有任何题目');
  const fields = s.fields || {};
  const seen = new Set();
  for (const it of s.items) {
    if (!it.id) throw new Error('题集 ' + s.id + ' 有题目缺少 id');
    if (seen.has(it.id)) throw new Error('题集 ' + s.id + ' 题目 id 重复：' + it.id);
    seen.add(it.id);
    if (s.judge === 'exec') {
      /* exec 判分靠"跑代码 + 隐藏用例标准答案"，两样缺一不可 */
      if (!fields.code) throw new Error('题集 ' + s.id + ' 声明 exec 判分，但没声明 fields.code（从模型返回里取哪个字段当代码）');
      if (!Array.isArray(it.hidden) || !it.hidden.length) throw new Error('题集 ' + s.id + ' 的题目 ' + it.id + ' 用 exec 判分但没有隐藏用例（item.hidden）');
      for (const h of it.hidden) {
        if (typeof h.in !== 'string') throw new Error('题集 ' + s.id + ' 题目 ' + it.id + ' 的隐藏用例缺少输入 in');
        if (typeof h.expected !== 'string') throw new Error('题集 ' + s.id + ' 题目 ' + it.id + ' 的隐藏用例缺少标准答案 expected（exec 判分没有它就没法判）');
      }
    }
    if (s.judge === 'structured') {
      if (!it.expect || typeof it.expect !== 'object' || !Object.keys(it.expect).length) {
        throw new Error('题集 ' + s.id + ' 的题目 ' + it.id + ' 用 structured 判分但没有 expect（要逐字段比对什么）');
      }
    }
    if (s.judge === 'judge') {
      if (!it.reference) throw new Error('题集 ' + s.id + ' 的题目 ' + it.id + ' 用 judge 判分但没给 reference（判分模型要拿什么当参考答案）');
    }
  }
  if (typeof s.prompt !== 'function' && !s.promptTemplate) {
    throw new Error('题集 ' + s.id + ' 既没有 prompt(item) 函数也没有 promptTemplate');
  }
  return s;
}

function loadSuite(id) {
  if (!id) throw new Error('未指定题集 id');
  for (const dir of SUITE_DIRS) {
    const f = path.join(dir, id + '.js');
    if (!fs.existsSync(f)) continue;
    const s = validateSuite(require(f));
    /* 记下它来自哪个目录：题集里的 ref（参考实现）是相对**自己所在目录**的 ——
     * 本地真题集不该跑到 testdata 里去找文件。 */
    s._dir = dir;
    return s;
  }
  throw new Error('找不到题集 ' + id + '（已装题库集：' + listSuites().map(x => x.id).join('、') + '）');
}

function promptOf(suite, item) {
  if (typeof suite.prompt === 'function') return suite.prompt(item);
  return String(suite.promptTemplate)
    .replace(/\{stem\}/g, item.stem || '')
    .replace(/\{desc\}/g, item.desc || '');
}

/* exec 判分的代码运行器已抽到 lib/coderun.js（评测与质检的 run_code 工具共用一份）。
 * 这里只做一件事：把 coderun 的能力再导出，保持既有调用方（server.js / 测试）不变。 */
const compileAndRun = CodeRun.compileAndRun;
const findGcc = CodeRun.findGcc;
const dockerRun = CodeRun.dockerRun;
const dockerArgs = CodeRun.dockerArgs;
const dockerAvailable = CodeRun.dockerAvailable;
const runProc = CodeRun.runProc;
const SANDBOX_IMAGE = CodeRun.SANDBOX_IMAGE;

/* 模拟模式的"运行器"：不发真实请求也不编译（CI 上可能没有 gcc），
 * 按 mock 给的意图造出输出。**报告里会标明 runner=stub**，不会冒充真实跑过。 */
function stubRun(item, sim) {
  const cases = item.hidden || [];
  if (sim === 'compileFail') return { compiled: false, compileLog: '（模拟）编译失败', outputs: [], runner: 'stub', timeouts: 0 };
  if (sim === 'codeWrong') return { compiled: true, compileLog: '', outputs: cases.map(() => '（模拟）错误输出'), runner: 'stub', timeouts: 0 };
  return { compiled: true, compileLog: '', outputs: cases.map(c => c.expected), runner: 'stub', timeouts: 0 };
}

/* ---------------- 判分（三种） ---------------- */
function judgeExec(item, resp, run) {
  const fields = { code: 'code', predictions: 'predictions' };
  const preds = Array.isArray(resp && resp[fields.predictions])
    ? resp[fields.predictions].map(normalizeOut) : [];
  const cases = item.hidden || [];
  const per = cases.map((c, i) => {
    const actual = run.outputs[i] === undefined ? null : run.outputs[i];
    const pred = preds[i] === undefined ? null : preds[i];
    return {
      expected: c.expected, actual, pred,
      actualOk: actual === c.expected,
      predOk: pred === c.expected,
      /* 自相矛盾：它"嘴上说"的输出与"它自己代码真跑出来"的输出不一致。
       * 这是本项目最看重的指标 —— 模型自认为对、实际错了，最危险。 */
      mismatch: pred != null && actual != null && pred !== actual,
      compiled: run.compiled
    };
  });
  const judged = per.filter(p => p.actual != null);
  return {
    correct: run.compiled && per.length > 0 && per.every(p => p.actualOk),
    per,
    codeOk: run.compiled && per.length > 0 && per.every(p => p.actualOk),
    predOk: per.filter(p => p.predOk).length,
    predJudged: per.filter(p => p.pred != null).length,
    mismatch: per.filter(p => p.mismatch).length,
    cases: per.length,
    judgedCases: judged.length
  };
}

function judgeStructured(item, resp) {
  const keys = Object.keys(item.expect);
  const per = keys.map(k => {
    const expected = normalizeOut(item.expect[k]);
    const actual = resp && resp[k] != null ? normalizeOut(resp[k]) : null;
    return { field: k, expected, actual, ok: actual === expected };
  });
  return {
    correct: per.length > 0 && per.every(p => p.ok),
    per,
    codeOk: per.length > 0 && per.every(p => p.ok),
    predOk: 0, predJudged: 0, mismatch: 0,
    cases: per.length, judgedCases: per.filter(p => p.actual != null).length
  };
}

/* LLM 判分：**必须双向对照**（同一份作答，换个顺序再判一遍）。
 * 为什么：模型判分对"答案放在前面还是后面"有系统性偏好，只跑一遍的数字没有意义。
 * 判定口径故意取严（两遍都说对才算对）——宁可低估也不要"靠位置偏好蒙对"。 */
async function judgeByModel(ctx, item, answerText) {
  const ask = async swapped => {
    const order = swapped
      ? ['【待判作答】', answerText, '', '【参考答案】', item.reference]
      : ['【参考答案】', item.reference, '', '【待判作答】', answerText];
    const sys = '你是阅卷员。只比较"待判作答"与"参考答案"在实质内容上是否一致（表述不同但意思相同算一致）。'
      + '只输出 JSON：{"correct":true|false,"reason":"一句话"}';
    const r = await ctx.callJudge([{ role: 'system', content: sys }, { role: 'user', content: order.join('\n') }]);
    const j = extractJSON(r.content) || {};
    return { swapped, correct: j.correct === true, reason: String(j.reason || '').slice(0, 120), raw: r.content };
  };
  const passes = [await ask(false), await ask(true)];
  return { correct: passes.every(p => p.correct), per: [], codeOk: passes.every(p => p.correct),
    predOk: 0, predJudged: 0, mismatch: 0, cases: 1, judgedCases: 1, passes };
}

/* ---------------- 模拟响应（可复现，不发真实请求） ----------------
 * 为什么 mock 要"故意造错"：全对的模拟跑出来的报告看不出链路有没有接对
 * （错题统计、自相矛盾率、编译失败、方差全是 0，等于没测）。这里按哈希确定性地
 * 让一部分题落在 四条路径 上：正常 / 代码跑错 / 编译失败 / 代码对但嘴上说错。
 */
function mockRespond(suite, item, roleKey, runIdx, prof) {
  const h = hashByte(item.id + '|' + roleKey + '|' + runIdx);
  const thr = 150 + (hashByte('thr|' + roleKey) % 3) * 35;   // 不同岗位的"能力"不同，好让对比表有区分度
  const ms = 300 + (h % 700);
  const promptChars = promptOf(suite, item).length;
  const usage = {
    in: Math.ceil(promptChars * 0.8), out: 300 + (h % 400),
    cost: 0, provider: prof.providerName || '（模拟）'
  };
  usage.cost = +(((usage.in * (prof.priceIn || 0)) + (usage.out * (prof.priceOut || 0))) / 1e6).toFixed(6);
  const hidden = item.hidden || [];
  let code = '', predictions = [], sim = 'ok';
  if (suite.judge === 'exec') {
    const refFile = item.ref ? path.join(suite._dir || SUITE_DIR, item.ref) : null;
    const refSrc = refFile && fs.existsSync(refFile) ? fs.readFileSync(refFile, 'utf8') : '/* 模拟模式：题集未提供参考实现，用空程序代替 */\nint main(void){return 0;}\n';
    if (h < thr) {
      code = refSrc; predictions = hidden.map(x => x.expected);
    } else {
      const bucket = h % 3;
      if (bucket === 0) { sim = 'codeWrong'; code = 'int main(void){return 0;}'; predictions = hidden.map(x => x.expected); }
      else if (bucket === 1) { sim = 'compileFail'; code = '这不是 C 代码 —— 模拟编译失败'; predictions = hidden.map(x => x.expected); }
      else { sim = 'predWrong'; code = refSrc; predictions = hidden.map(x => (x.expected + '（模拟：说错了）')); }
    }
  } else {
    /* structured / judge：按 expect（或 reference）造一个"对/错"作答 */
    const ok = h < thr;
    const out = {};
    if (suite.judge === 'structured') {
      for (const k of Object.keys(item.expect || {})) out[k] = ok ? item.expect[k] : '（模拟）答错';
    } else {
      out.answer = ok ? item.reference : '（模拟）答错';
    }
    code = JSON.stringify(out); predictions = [];
  }
  const content = suite.judge === 'exec'
    ? JSON.stringify({ code, predictions })
    : code;
  return { content, ms, usage, meta: { sim } };
}

/* ---------------- 真实调用的薄封装（可注入，便于离线断言） ---------------- */
function defaultCall(profile, messages, opts) {
  return callLLM(profile, messages, opts).then(r => ({
    content: r.content, toolCalls: r.toolCalls || [], usage: r.usage || null
  }));
}

/* ---------------- 费用预估（真跑之前先算给你看） ----------------
 * 这里的系数是**用实测数据校准过的**，不是拍脑袋。两次校准记录：
 *   ① exec（calgo）：拿 llm_test 留下的真实 usage 反推 —— 基础 20 题平均 in=256 / out=191 token，
 *      而题面 447 字符、参考实现 391 字节 → "输入 ≈ 题面字符 × 0.6"、"输出 ≈ 参考实现字节 × 0.5"。
 *      实测对照：预估 ¥0.0547 vs 实际 ¥0.0609（偏低 11%，偏保守方向）。
 *   ② structured（cread）：实测平均 in=314 / out=**18** token（作答就是个短字符串 + JSON 外壳），
 *      原先按"输出上限"估到 150 token、高估 8 倍 → 改为按 expect 里答案的长度折算。
 * 报告里现在会打印**真实 token 用量**（平均 进→出），下次校准直接看它，别再猜。 */
function estimateCost(suite, items, roleKeys, repeats, cfg) {
  const rows = roleKeys.map(k => {
    const prof = Store.profileFor(cfg, k);
    let inSum = 0, outSum = 0;
    for (const it of items) {
      inSum += Math.ceil(promptOf(suite, it).length * 0.6);
      if (suite.judge === 'exec') {
        const f = it.ref ? path.join(suite._dir || SUITE_DIR, it.ref) : null;
        outSum += Math.ceil((f && fs.existsSync(f) ? fs.statSync(f).size : 800) * 0.5);
      } else if (suite.judge === 'structured') {
        const answerChars = Object.values(it.expect || {}).reduce((s, v) => s + String(v).length, 0);
        outSum += Math.ceil(answerChars * 0.6) + 20;       // 实测 cread 为 18 token/题，这里留了约 2 倍余量
      } else {
        outSum += 200;                                     // judge 型：判分模型的输出
      }
    }
    const per = ((inSum * (prof.priceIn || 0)) + (outSum * (prof.priceOut || 0))) / 1e6 / items.length;
    return { role: k, label: prof.label || k, model: prof.model || '(未配置)', provider: prof.providerName || '-',
      tokenIn: Math.round(inSum / items.length), tokenOut: Math.round(outSum / items.length),
      perItem: per, total: per * items.length * repeats };
  });
  return { rows, total: rows.reduce((s, r) => s + r.total, 0), calls: items.length * repeats * roleKeys.length };
}

/* ---------------- 报告落盘（CLI 与页面共用一份实现，避免两处漂移） ----------------
 * 放在 data/evals/suites/ 子目录：金标集评估页读的是 data/evals 根目录的 *.json，
 * 子目录不会污染那页的「历史报告」列表。真实跑过的结果必须落盘（花了钱的数据不能只留在终端上）。 */
function suitesDir() {
  const d = path.join(Store.dirs.evals, 'suites');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function saveSuiteReport(rep) {
  const d = suitesDir();
  fs.writeFileSync(path.join(d, rep.id + '.json'), JSON.stringify(rep, null, 2));
  fs.writeFileSync(path.join(d, rep.id + '.md'), rep.md);
  return d;
}
/* 列出最近跑过的题集评测（只回摘要 + 各模型的准确率，不带逐题明细——明细可能很大） */
function listSuiteReports(limit = 10) {
  let files = [];
  try { files = fs.readdirSync(suitesDir()).filter(f => f.endsWith('.json')); } catch (e) { return []; }
  const out = [];
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(suitesDir(), f), 'utf8'));
      out.push({
        id: j.id, ts: j.ts, suiteId: j.suite && j.suite.id, title: j.suite && j.suite.title,
        judge: j.judge, mode: j.mode, runner: j.runner, repeats: j.repeats, samples: j.samples,
        models: (j.models || []).map(m => ({ role: m.role, label: m.label, model: m.model, provider: m.provider,
          accuracy: m.accuracy, correct: m.correct, total: m.total, cost: m.cost, flipRate: m.flipRate }))
      });
    } catch (e) { /* 坏文件跳过 */ }
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, limit);
}

/* ---------------- 主入口：跑一批题 ---------------- */
/**
 * @param {Object} opts
 *   suiteId / suite   题集 id（或直接传题集对象，便于测试）
 *   models  []        参赛模型 = 岗位 key 列表（默认 ['generator']）
 *   repeats 1         每题重复次数（>1 才测得出方差）
 *   limit             只跑前 N 题（试跑）
 *   real   false      **必须显式 true 才发真实请求**；否则走可复现模拟
 *   judgeModel        判分模型岗位（judge 判分时必填，且不能与参赛模型相同）
 *   callFn / callJudgeFn  注入用（测试）
 *   runner 'stub'|'gcc'   exec 判分的运行器；默认 real ? 'gcc' : 'stub'
 */
async function runSuite(opts = {}) {
  const suite = opts.suite ? validateSuite(opts.suite) : loadSuite(opts.suiteId);
  const judge = opts.judge || suite.judge;
  if (!JUDGES.includes(judge)) throw new Error('未知判分方式：' + judge);
  if (judge !== suite.judge) {
    throw new Error('判分方式与题集声明不一致：题集 ' + suite.id + ' 声明 ' + suite.judge + '，本次要求 ' + judge
      + '。不允许临时换判分方式（会把"判错了"伪装成"模型变强了"）。');
  }
  const repeats = Math.max(1, Math.min(opts.repeats || 1, 5));
  let items = opts.limit ? suite.items.slice(0, opts.limit) : suite.items.slice();
  /* 只跑指定题号：重跑失败题、做小范围对照实验都要它（不然每次都得全量重跑，白花钱） */
  if (Array.isArray(opts.items) && opts.items.length) {
    const want = new Set(opts.items);
    items = items.filter(it => want.has(it.id));
    if (!items.length) throw new Error('指定的题目在题集 ' + suite.id + ' 里都不存在：' + opts.items.join(','));
  }
  if (!items.length) throw new Error('题集 ' + suite.id + ' 没有题目可跑');

  const cfg = Store.loadConfig();
  configure(cfg);
  const roleKeys = (Array.isArray(opts.models) && opts.models.length) ? opts.models.slice() : ['generator'];
  const real = opts.real === true || process.env.QF_EVAL_REAL === '1';
  let runner = opts.runner || (real ? 'gcc' : 'stub');
  /* 沙箱：显式要求（opts.sandbox / QF_SANDBOX=docker / --runner docker）才走容器。
   * 要不到就**降级到本机并在报告里写明**，不许假装 -- "跑在哪"是报告可信度的一部分。 */
  let sandboxDegraded = null;
  const wantSandbox = runner === 'docker' || opts.sandbox === true || process.env.QF_SANDBOX === 'docker';
  if (wantSandbox) {
    /* 要沙箱就意味着"代码要真的执行" —— 不能停在 stub 上：
     * 模拟模式下默认运行器是 stub（不编译不运行），如果这里不拉起来，
     * "勾了沙箱"就会**静默失效**（跑了还是 stub，报告里也不写沙箱）。
     * 所以模拟跑 + 沙箱 = 不花钱但真编译真运行（专门用来验证沙箱链路）。
     * ⚠ 这个 bug 是"在页面上点一遍"才发现的（接口测试全绿）—— 静默失效最怕只看断言。 */
    if (runner === 'stub') runner = 'gcc';
    const av = await dockerAvailable();
    if (av.ok) runner = 'docker';
    else { runner = 'gcc'; sandboxDegraded = av.reason; }
  }

  const models = roleKeys.map(k => {
    const p = Store.profileFor(cfg, k);
    if (real && (p.missing || !p.apiKey || !p.baseUrl || !p.model)) {
      throw new Error('真实模式：岗位 ' + k + ' 没有可用凭据（供应商未配 Key 或未绑模型）—— 请到「API 池」配置，或改用模拟模式试链路');
    }
    return { role: k, label: p.label || k, model: p.model || '(未配置)', provider: p.providerName || '(未配置)', profile: p };
  });

  let judgeProfile = null;
  if (judge === 'judge') {
    const jk = opts.judgeModel;
    if (!jk) throw new Error('judge 判分必须指定判分模型岗位（judgeModel），且不能与参赛模型相同');
    if (roleKeys.includes(jk)) throw new Error('判分模型（' + jk + '）不能同时是参赛模型 —— 自己判自己不是评测');
    judgeProfile = Store.profileFor(cfg, jk);
    if (real && (judgeProfile.missing || !judgeProfile.apiKey)) throw new Error('真实模式：判分岗位 ' + jk + ' 没有可用凭据');
  }

  const est = real ? estimateCost(suite, items, roleKeys, repeats, cfg) : null;
  const ctx = {
    suite, judge, real, runner, cfg, judgeProfile,
    /* 系统提示词是**被比较的作答条件之一**，必须能控制、能记录：
     * 默认那句"严谨的解题者"来自本框架，而 llm_test 当年没有它 —— 两边的数字不能直接比。
     * 用 system:'' 关掉即可做"有/无系统提示词"的对照。 */
    system: opts.system !== undefined ? opts.system : (suite.system || '你是一名严谨的解题者。只输出要求的 JSON，不要多余文字。'),
    compileTimeoutMs: opts.compileTimeoutMs, runTimeoutMs: opts.runTimeoutMs,
    /* 并发度：条目之间独立，默认 3（llm.js 内部还有全局信号量，不会把供应商打爆）；
     * 传 1 可退回串行（调试用）。 */
    concurrency: Math.max(1, Math.min(opts.concurrency || 3, 6)),
    gcc: opts.gcc,
    callFn: opts.callFn || defaultCall,
    callJudgeFn: opts.callJudgeFn || defaultCall,
    onProgress: opts.onProgress || null,
    maxTokens: opts.maxTokens
  };

  const detail = {};
  /* 每个 (模型 × 重复) 一轮：**轮内条目并发跑**（默认 3，`opts.concurrency` 可调）。
   * 为什么要有并发：3 个模型 × 3 次重复 = 234 次调用，串行要好几分钟，
   * 页面上就是一个干等的转圈。条目之间彼此独立（结果按 role/item/run 归集），
   * 并发不改变结果 —— evalsuite_test 里有"并发 3 与串行结果完全一致"的断言守着。
   * 模型之间仍串行：不同岗位可能绑同一家供应商，别在一个请求里把它打爆。 */
  const modelReports = [];
  for (const m of models) {
    const recs = [];
    for (let run = 1; run <= repeats; run++) {
      const batch = items.map(item => () => runOne(ctx, m, item, run));
      recs.push(...await runPool(batch, ctx.concurrency));
    }
    detail[m.role] = recs;
    modelReports.push(summarize(m, recs, items, repeats, judge));
  }
  const report = {
    id: Store.id('suite'), ts: Date.now(),
    suite: { id: suite.id, title: suite.title || suite.id, judge, items: items.length, groups: [...new Set(items.map(x => x.group).filter(Boolean))] },
    judge, judgeLabel: JUDGE_CN[judge],
    mode: real ? 'real' : 'mock',
    runner, repeats, limit: opts.limit || null,
    /* 要求了沙箱却没要到时的原因（页面/报告要如实显示"这次是无沙箱跑的"） */
    sandboxDegraded,
    /* 记下本次用的系统提示词：不同提示词下的数字不可直接比较（跨框架对比时要看这一行） */
    systemPrompt: ctx.system || '(无系统提示词)',
    estimatedCost: est ? { total: +est.total.toFixed(4), calls: est.calls, rows: est.rows } : null,
    samples: items.length,
    /* 样本太小就不许下结论 —— 实施方案承诺"报告强制显示样本量，<20 标注仅供参考" */
    sampleWarning: items.length < 20 ? '样本量 ' + items.length + ' 题 < 20，结论仅供参考（样本越小，单题波动对百分比的影响越大）' : null,
    itemsRun: items.map(it => it.id),
    models: modelReports,
    recommend: recommendOf(modelReports),
    detail
  };
  report.md = suiteToMd(report);
  if (opts.save) Store.saveEval(report);
  return report;
}

/* 跑一道题（一次）：调用 → 解析 → 判分。任何一步失败都记成"未答"而不是抛出去 ——
 * 一道题把整批打挂，等于花钱买了半份报告。 */
async function runOne(ctx, model, item, runIdx) {
  const rec = { itemId: item.id, group: item.group || null, runIdx, correct: false, fail: null,
    ms: 0, cost: 0, preds: null, actual: null, compileLog: '', judgePasses: null };
  let resp = null;
  let ms = 0, cost = 0;
  try {
    if (ctx.real) {
      const userMsg = { role: 'user', content: promptOf(ctx.suite, item) };
      const messages = ctx.system ? [{ role: 'system', content: ctx.system }, userMsg] : [userMsg];
      const r = await ctx.callFn(model.profile, messages, {
        maxTokens: ctx.maxTokens || (ctx.judge === 'exec' ? 2600 : 900),
        temperature: 0.2,
        label: 'evalsuite_' + model.role
      });
      ms = (r.usage && r.usage.ms) || 0;
      cost = (r.usage && r.usage.cost) || 0;
      /* 记下真实 token 用量：费用预估的系数要靠它持续校准（不然预估永远是我拍的数） */
      rec.tokensIn = (r.usage && r.usage.in) || 0;
      rec.tokensOut = (r.usage && r.usage.out) || 0;
      resp = extractJSON(r.content);
      if (!resp) { rec.fail = 'parse'; rec.ms = ms; rec.cost = cost; return rec; }
    } else {
      const r = mockRespond(ctx.suite, item, model.role, runIdx, model.profile);
      ms = r.ms; cost = r.usage.cost;
      rec.tokensIn = r.usage.in; rec.tokensOut = r.usage.out;   // 模拟用量也占位，免得报告里那一列空着
      resp = extractJSON(r.content);
      resp = resp || {};
      resp._sim = r.meta.sim;                    // 模拟模式：把"意图"带给 stub 运行器
    }

    if (ctx.judge === 'exec') {
      const codeField = (ctx.suite.fields && ctx.suite.fields.code) || 'code';
      const code = resp[codeField];
      if (typeof code !== 'string' || !code.trim()) { rec.fail = 'nocode'; rec.ms = ms; rec.cost = cost; return rec; }
      /* 按 ctx.runner 选运行器（而不是"真跑才编译"）：这样模拟模式下也能用
       * runner='gcc' 真的编译运行一遍 —— 测试里靠它证明 exec 这条链路是通的。 */
      const run = ctx.runner === 'docker' ? await dockerRun(code, item.hidden, ctx)
        : ctx.runner === 'gcc' ? await compileAndRun(code, item.hidden, ctx)
        : stubRun(item, resp._sim);
      rec.compiled = !!run.compiled;
      rec.compileLog = run.compileLog || '';
      rec.isTimeout = (run.outputs || []).some(o => o === '__TIMEOUT__');
      const j = judgeExec(item, resp, run);
      rec.correct = j.correct;
      rec.expected = j.per.map(p => p.expected);
      rec.preds = j.per.map(p => p.pred);
      rec.actual = j.per.map(p => p.actual);
      rec.mismatch = j.mismatch;
      rec.predOk = j.predOk;
      rec.predJudged = j.predJudged;
      rec.cases = j.cases;
      if (!run.compiled) rec.fail = 'compile';
      else if (run.outputs.some(o => o === '__TIMEOUT__')) rec.fail = 'timeout';
      else if (run.outputs.some(o => o === '__OUTPUT_OVERFLOW__')) rec.fail = 'overflow';
    } else if (ctx.judge === 'structured') {
      const j = judgeStructured(item, resp);
      rec.correct = j.correct;
      rec.expected = j.per.map(p => p.expected);
      rec.actual = j.per.map(p => p.actual);
    } else {
      const answer = ctx.suite.answerField ? resp[ctx.suite.answerField] : (resp.answer || JSON.stringify(resp));
      let j;
      if (ctx.real) {
        j = await judgeByModel({ callJudge: (m) => ctx.callJudgeFn(ctx.judgeProfile, m, { maxTokens: 300, temperature: 0, label: 'evalsuite_judge' }) }, item, String(answer));
      } else {
        j = { correct: resp._sim === 'ok', per: [], predOk: 0, predJudged: 0, mismatch: 0, cases: 1, judgedCases: 1,
          passes: [{ swapped: false, correct: resp._sim === 'ok' }, { swapped: true, correct: resp._sim === 'ok' }] };
      }
      rec.correct = j.correct;
      rec.judgePasses = (j.passes || []).map(p => ({ swapped: p.swapped, correct: p.correct }));
    }
  } catch (e) {
    rec.fail = 'call';
    rec.error = String(e.message || e).slice(0, 200);
    rec.ms = ms; rec.cost = cost;
    return rec;
  }
  rec.ms = ms; rec.cost = cost;
  return rec;
}

/* 汇总一个模型的指标。**不许只报准确率**：这里把成本、延迟、方差、失败率一次全给。 */
function summarize(model, recs, items, repeats, judge) {
  const judged = recs.filter(r => !r.fail || r.fail === 'compile' || r.fail === 'timeout');
  const correct = recs.filter(r => r.correct).length;
  const cases = recs.reduce((s, r) => s + (r.cases || 0), 0);
  const predJudged = recs.reduce((s, r) => s + (r.predJudged || 0), 0);
  const predOk = recs.reduce((s, r) => s + (r.predOk || 0), 0);
  const mismatch = recs.reduce((s, r) => s + (r.mismatch || 0), 0);
  const byGroup = {};
  for (const r of recs) {
    const g = r.group || '（未分组）';
    byGroup[g] = byGroup[g] || { total: 0, correct: 0 };
    byGroup[g].total++;
    if (r.correct) byGroup[g].correct++;
  }
  for (const g of Object.keys(byGroup)) byGroup[g].accuracy = pct(byGroup[g].correct, byGroup[g].total);

  /* 方差：同一题在多次重复里判定结果不一致的题数占比（这是"能不能上线当质检员"的依据） */
  let flip = 0, accs = [];
  if (repeats > 1) {
    const byItem = {};
    for (const r of recs) { (byItem[r.itemId] = byItem[r.itemId] || []).push(r.correct); }
    for (const id of Object.keys(byItem)) {
      const v = byItem[id];
      if (v.some(x => x) !== v.every(x => x)) flip++;
    }
    for (let run = 1; run <= repeats; run++) {
      const sub = recs.filter(r => r.runIdx === run);
      accs.push(pct(sub.filter(r => r.correct).length, sub.length));
    }
  }
  const msList = recs.map(r => r.ms).filter(x => x > 0);
  return {
    role: model.role, label: model.label, model: model.model, provider: model.provider,
    /* 供应商 id 要带上：阶段四"一键绑回岗位"必须知道胜出模型是哪家供应商提供的，
     * 只留显示名没法写回配置（同名两家会绑错）。 */
    providerId: (model.profile && model.profile.providerId) || null,
    total: recs.length, items: items.length, repeats,
    judged: judged.length, correct, accuracy: pct(correct, recs.length),
    cases, predJudged, predOk, predRate: pct(predOk, predJudged),
    selfMismatch: mismatch, selfMismatchRate: pct(mismatch, predJudged),
    failCall: recs.filter(r => r.fail === 'call').length,
    failParse: recs.filter(r => r.fail === 'parse').length,
    failNoCode: recs.filter(r => r.fail === 'nocode').length,
    failCompile: recs.filter(r => r.fail === 'compile').length,
    failTimeout: recs.filter(r => r.fail === 'timeout').length,
    failOverflow: recs.filter(r => r.fail === 'overflow').length,
    cost: +recs.reduce((s, r) => s + (r.cost || 0), 0).toFixed(4),
    costPerItem: +(recs.reduce((s, r) => s + (r.cost || 0), 0) / Math.max(1, recs.length)).toFixed(5),
    tokensIn: recs.reduce((s, r) => s + (r.tokensIn || 0), 0),
    tokensOut: recs.reduce((s, r) => s + (r.tokensOut || 0), 0),
    avgTokensIn: Math.round(recs.reduce((s, r) => s + (r.tokensIn || 0), 0) / Math.max(1, recs.length)),
    avgTokensOut: Math.round(recs.reduce((s, r) => s + (r.tokensOut || 0), 0) / Math.max(1, recs.length)),
    msP50: percentile(msList, 0.5), msP95: percentile(msList, 0.95),
    flipItems: repeats > 1 ? flip : null,
    flipRate: repeats > 1 ? pct(flip, items.length) : null,
    accuracyPerRun: accs.length ? accs : null,
    byGroup, judge
  };
}

/* 选型建议：输出"哪个岗位该换成哪个模型"的依据，而不是一张排行榜。 */
function recommendOf(models) {
  const rank = models.slice().sort((a, b) => (b.accuracy - a.accuracy) || (a.costPerItem - b.costPerItem));
  const best = rank[0], cheapest = models.slice().sort((a, b) => a.costPerItem - b.costPerItem)[0];
  const rows = rank.map(m => {
    const reasons = [];
    if (m === best) reasons.push('准确率最高');
    if (m === cheapest && models.length > 1) reasons.push('单题成本最低');
    if (m.flipRate != null && m.flipRate > 0) reasons.push('重复跑有 ' + m.flipRate + '% 的题结论翻转（不稳定）');
    if (m.failCall + m.failParse + m.failNoCode > 0) reasons.push('有 ' + (m.failCall + m.failParse + m.failNoCode) + ' 次调用/解析失败');
    if (!reasons.length) reasons.push('准确率低 ' + (best.accuracy - m.accuracy).toFixed(1) + ' 个百分点');
    return { role: m.role, label: m.label, model: m.model, provider: m.provider, providerId: m.providerId,
      accuracy: m.accuracy, costPerItem: m.costPerItem, msP95: m.msP95, reason: reasons.join('；') };
  });
  const notes = [];
  if (models.length > 1 && best.accuracy === rank[rank.length - 1].accuracy) notes.push('各模型准确率相同，此时按成本与延迟选（' + cheapest.model + ' 更便宜）');
  if (best.accuracy - rank[rank.length - 1].accuracy < 5 && models.length > 1) notes.push('准确率差距 < 5 个百分点，在这个样本量下可能只是噪声 —— 想据此换模型请先加 --repeats 看方差');
  return { rows, notes };
}

/* ---------------- 报告 ---------------- */
function suiteToMd(rep) {
  const t = new Date(rep.ts).toLocaleString('zh-CN');
  const L = [];
  L.push('# 模型评测报告 · ' + rep.suite.title, '', '生成时间：' + t, '',
    '> 判分方式：' + rep.judgeLabel,
    '> 模式：' + (rep.mode === 'real' ? '**真实调用**（本次为真实 API 结果）' : '⚠ **演示模式（模拟结果，未发出任何真实请求）**'),
    '> 题集：' + rep.suite.id + '（' + rep.suite.items + ' 题' + (rep.suite.groups.length ? '，分组 ' + rep.suite.groups.join('/') : '') + '）　'
      + '参赛模型 ' + rep.models.length + ' 个　每题重复 ' + rep.repeats + ' 次'
      + (rep.judge === 'exec' ? '　代码运行器：' + (rep.runner === 'docker' ? '**Docker 沙箱**（断网/只读/内存与进程限额/非 root/即用即弃）'
        : rep.runner === 'gcc' ? '本机 gcc（真编译真运行，**无沙箱**）' : '模拟（未编译）') : ''),
    /* 要了沙箱没要到 —— 必须写在报告里，否则"我们的评测跑在沙箱里"就是一句假话 */
    ...(rep.sandboxDegraded ? ['> ⚠ 本次**要了沙箱但没要到，已降级为本机运行（无沙箱）**：' + rep.sandboxDegraded] : []),
    '> 系统提示词：' + (rep.systemPrompt === '(无系统提示词)' ? '**已关闭**（本次是"没有系统提示词"的对照臂）' : '默认／自定义，全文见 JSON 报告的 systemPrompt 字段'),
    '');
  if (rep.sampleWarning) L.push('> ⚠ ' + rep.sampleWarning, '');
  L.push('## 一、指标对比', '', '| 岗位 | 模型 | 供应商 | 准确率 | 预测正确率 | 自相矛盾率 | 失败(调用/解析/编译) | 单题成本 | 平均 token(进→出) | p50 | p95 |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const m of rep.models) {
    /* 报告是**当纯文本看的**（终端直接打印、页面放进 <pre>）：
     * 表格单元里不要用 <div> 之类的 HTML 换行技巧 —— 那只有 GitHub 会渲染，
     * 在终端和页面上会原样显示成 <div>…</div> 噪声（第一阶段没注意到，页面上才看见）。 */
    L.push('| ' + m.label + '（' + m.role + '） | ' + m.model + ' | ' + m.provider
      + ' | **' + m.accuracy + '%**（' + m.correct + '/' + m.total + '）'
      + ' | ' + (m.predJudged ? m.predRate + '%（' + m.predOk + '/' + m.predJudged + '）' : '—')
      + ' | ' + (m.predJudged ? m.selfMismatchRate + '%（' + m.selfMismatch + '/' + m.predJudged + '）' : '—')
      + ' | ' + m.failCall + ' / ' + m.failParse + ' / ' + m.failCompile
      + ' | ' + (m.cost ? '¥' + m.cost.toFixed(4) + ' · 单题 ¥' + m.costPerItem.toFixed(5) : '—')
      + ' | ' + (m.avgTokensIn ? m.avgTokensIn + ' → ' + m.avgTokensOut : '—')
      + ' | ' + m.msP50 + 'ms | ' + m.msP95 + 'ms |');
  }
  /* 失败分类单独一行：表格里只放三个最常出现的，超时/输出超限放这里，别把表挤宽 */
  const fb = rep.models.map(m => {
    const parts = [];
    if (m.failCall) parts.push('调用失败 ' + m.failCall);
    if (m.failParse) parts.push('返回没法解析 ' + m.failParse);
    if (m.failCompile) parts.push('编译失败 ' + m.failCompile);
    if (m.failTimeout) parts.push('运行超时 ' + m.failTimeout);
    if (m.failOverflow) parts.push('输出超限（死循环打印）' + m.failOverflow);
    return parts.length ? m.label + '：' + parts.join('、') : null;
  }).filter(Boolean);
  if (fb.length) L.push('', '> 失败分类：' + fb.join('　｜　'));
  if (rep.models.some(m => m.repeats > 1)) {
    L.push('', '### 重复跑稳定性（每题跑 ' + rep.repeats + ' 次）', '',
      '| 岗位 | 各次准确率 | 结论翻转的题 |', '|---|---|---|');
    for (const m of rep.models) {
      L.push('| ' + m.label + ' | ' + (m.accuracyPerRun || []).map(x => x + '%').join(' / ')
        + ' | ' + (m.flipItems == null ? '—' : m.flipItems + ' / ' + m.items + '（' + m.flipRate + '%）') + ' |');
    }
    L.push('', '> 翻转率高 = 同一道题重复问会得到不同结论 → 该模型不适合当自动质检员（它自己都不稳）。');
  } else {
    L.push('', '> 想测方差？加 `--repeats 3` 重跑（同一题问三遍，看结论会不会翻转）。本次每题只跑 1 次，**方差未测**。');
  }
  const groups = [...new Set(rep.models.flatMap(m => Object.keys(m.byGroup)))];
  if (groups.length > 1) {
    L.push('', '## 二、按难度分组', '', '| 分组 | ' + rep.models.map(m => m.label).join(' | ') + ' |', '|---|' + '|---|'.repeat(rep.models.length));
    for (const g of groups) {
      L.push('| ' + g + ' | ' + rep.models.map(m => {
        const b = m.byGroup[g];
        return b ? b.accuracy + '%（' + b.correct + '/' + b.total + '）' : '—';
      }).join(' | ') + ' |');
    }
  }
  L.push('', '## 三、选型建议', '', '| 岗位 | 推荐模型 | 准确率 | 单题成本 | p95 | 理由 |', '|---|---|---|---|---|---|');
  for (const r of rep.recommend.rows) {
    L.push('| ' + r.label + '（' + r.role + '） | ' + r.model + ' | ' + r.accuracy + '% | ¥' + r.costPerItem.toFixed(5) + ' | ' + r.msP95 + 'ms | ' + r.reason + ' |');
  }
  for (const n of rep.recommend.notes) L.push('', '> ' + n);
  if (rep.judge === 'judge') L.push('', '> judge 判分已强制双向对照（同一份作答换序判两遍，两遍都说对才算对）。');
  if (rep.mode === 'mock') L.push('', '> ⚠ 本报告是**模拟数据**，只能用来验证链路（指标计算、失败分类、报告渲染）接对了没有，**不能当作模型的真实能力**。真跑请用 `--real`。');

  /* 逐题明细：只列有问题的（错题 / 编译失败 / 自相矛盾），最多 20 条 ——
   * 报告给人看，全对的行没有信息量。 */
  const bad = [];
  for (const m of rep.models) {
    for (const r of (rep.detail[m.role] || [])) {
      if (r.correct && !r.mismatch) continue;
      bad.push({ m, r });
    }
  }
  if (bad.length) {
    L.push('', '## 四、问题清单（错题 / 编译失败 / 自相矛盾，最多 20 条）', '',
      '| 岗位 | 题 | 第几次 | 现象 | 用例/字段 | 标准答案 | 它说的 | 它写的东西实跑 |', '|---|---|---|---|---|---|---|---|');
    for (const { m, r } of bad.slice(0, 20)) {
      const phenomenon = r.fail === 'compile' ? '编译失败' : (r.fail === 'timeout' ? '运行超时'
        : (r.fail === 'nocode' ? '没交代码' : (r.fail === 'parse' ? '返回没法解析成 JSON' : (r.fail === 'call' ? '调用失败' : ''))));
      const exp = r.expected || [], act = r.actual || [], prd = r.preds || [];
      /* 挑第一个"对不上"的用例来展示：先看代码输出与标准答案的差，再看它嘴上说的与代码输出的差 */
      let idx = exp.findIndex((e, i) => act[i] !== e);
      if (idx < 0) idx = prd.findIndex((p, i) => p != null && act[i] != null && p !== act[i]);
      if (idx < 0) idx = 0;
      const only = (phenomenon === '编译失败' || phenomenon === '没交代码' || phenomenon === '调用失败');
      L.push('| ' + m.label + ' | ' + r.itemId + ' | ' + r.runIdx + ' | '
        + (phenomenon || (r.mismatch ? '自相矛盾（它说的 ≠ 它代码实跑的）' : '用例不通过'))
        + ' | #' + (idx + 1)
        + ' | ' + (only ? '—' : esc(exp[idx]))
        + ' | ' + (only || prd[idx] == null ? '—' : esc(prd[idx]))
        + ' | ' + (only ? '—' : esc(act[idx])) + ' |');
    }
    if (bad.length > 20) L.push('', '（还有 ' + (bad.length - 20) + ' 条未列出）');
  }
  return L.join('\n');
}
function esc(s) { return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, '⏎').slice(0, 80); }

/* 导出 judgeExec / judgeStructured / mockRespond / stubRun 只为 evalsuite_test.js 能直接断言
 * 判分与模拟这两个纯函数（对外的稳定 API 只有上面这几个）。 */
module.exports = { runSuite, listSuites, loadSuite, validateSuite, suiteToMd, estimateCost, SUITE_DIRS,
  compileAndRun, findGcc, normalizeOut, extractJSON, JUDGES, JUDGE_CN, SUITE_DIR,
  suitesDir, saveSuiteReport, listSuiteReports,
  dockerRun, dockerArgs, dockerAvailable, runProc, SANDBOX_IMAGE,
  judgeExec, judgeStructured, mockRespond, stubRun };
