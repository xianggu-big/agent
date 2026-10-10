/* 工具注册表：目前只有一个 calc —— 纯本地表达式求值器
 *
 * 三条硬约束（决定了它为什么不需要沙箱）：
 *  ① 纯函数、无 IO、无副作用 —— 不会读文件、不会起进程，被滥用也放大不成 RCE
 *  ② 确定性 —— 同样输入必得同样输出，测试与 mock 可复现（本项目一贯的要求）
 *  ③ 自己写词法/语法分析，**绝不用 eval / new Function**
 *     eval 能访问全局、读文件、起进程；而这个工具将来会通过对外 API / MCP 暴露给外部调用方，
 *     用 eval 等于把远程代码执行送出去。
 *
 * 这是《2026-10-08 实施方案-质检验算工具》的第一阶段产物：只暴露一个纯函数，
 * 不接数据库、不接流水线、不依赖网络。第二阶段才把它接进质检环节。
 */
'use strict';

const MAX_LEN = 200;      // 表达式长度上限（防构造超长串拖死进程）
const MAX_STEPS = 200;    // 求值步数上限

/* 支持的函数：{ 实现, 参数个数范围 } —— 一元函数 + 可变参数的 max/min + 二元 pow */
const FUNCS = {
  sqrt: { fn: x => { if (x < 0) throw new Error('sqrt 的参数不能为负'); return Math.sqrt(x); }, a: [1, 1] },
  abs: { fn: Math.abs, a: [1, 1] },
  floor: { fn: Math.floor, a: [1, 1] },
  ceil: { fn: Math.ceil, a: [1, 1] },
  round: { fn: Math.round, a: [1, 1] },
  ln: { fn: x => { if (x <= 0) throw new Error('ln 的参数必须为正'); return Math.log(x); }, a: [1, 1] },
  log: { fn: x => { if (x <= 0) throw new Error('log 的参数必须为正'); return Math.log10(x); }, a: [1, 1] },
  exp: { fn: Math.exp, a: [1, 1] },
  sin: { fn: Math.sin, a: [1, 1] },
  cos: { fn: Math.cos, a: [1, 1] },
  tan: { fn: Math.tan, a: [1, 1] },
  max: { fn: Math.max, a: [1, 8] },
  min: { fn: Math.min, a: [1, 8] },
  pow: { fn: Math.pow, a: [2, 2] }
};
const CONSTS = { pi: Math.PI, e: Math.E };

/* ---------- 词法分析 ---------- */
function tokenize(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c >= '0' && c <= '9' || c === '.') {
      let j = i;
      while (j < s.length && (s[j] >= '0' && s[j] <= '9' || s[j] === '.')) j++;
      const num = s.slice(i, j);
      if ((num.match(/\./g) || []).length > 1) throw new Error('数字格式错误：' + num);
      out.push({ t: 'num', v: parseFloat(num) });
      i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      out.push({ t: 'id', v: s.slice(i, j).toLowerCase() });
      i = j; continue;
    }
    if ('+-*/%^(),'.indexOf(c) >= 0) { out.push({ t: 'op', v: c }); i++; continue; }
    throw new Error('不支持的字符：' + c);
  }
  return out;
}

/* ---------- 语法分析 + 求值（递归下降，边解析边算） ----------
 * 优先级（低 → 高）：+ - ｜ * / % ｜ 一元 - + ｜ ^（右结合）｜ 括号/函数/常量
 * 因此 -2^2 = -(2^2) = -4，2^3^2 = 2^(3^2) = 512
 */
function evaluate(expression) {
  const s = String(expression == null ? '' : expression).trim();
  if (!s) return { ok: false, error: '表达式为空' };
  if (s.length > MAX_LEN) return { ok: false, error: '表达式过长（上限 ' + MAX_LEN + ' 字符）' };

  let tokens;
  try { tokens = tokenize(s); } catch (e) { return { ok: false, error: e.message }; }
  if (!tokens.length) return { ok: false, error: '表达式为空' };

  let p = 0, steps = 0;
  const peek = () => tokens[p];
  const step = () => { if (++steps > MAX_STEPS) throw new Error('表达式过于复杂'); };

  function parseExpr() {
    let v = parseTerm();
    while (peek() && peek().t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = tokens[p++].v;
      const r = parseTerm();
      v = op === '+' ? v + r : v - r;
      step();
    }
    return v;
  }
  function parseTerm() {
    let v = parseUnary();
    while (peek() && peek().t === 'op' && (peek().v === '*' || peek().v === '/' || peek().v === '%')) {
      const op = tokens[p++].v;
      const r = parseUnary();
      if ((op === '/' || op === '%') && r === 0) throw new Error('除数为零');
      v = op === '*' ? v * r : (op === '/' ? v / r : v % r);
      step();
    }
    return v;
  }
  function parseUnary() {
    if (peek() && peek().t === 'op' && (peek().v === '-' || peek().v === '+')) {
      const op = tokens[p++].v;
      const v = parseUnary();
      step();
      return op === '-' ? -v : v;
    }
    return parsePower();
  }
  function parsePower() {
    const base = parsePrimary();
    if (peek() && peek().t === 'op' && peek().v === '^') {
      p++;
      const exp = parseUnary();          // 右结合
      step();
      return Math.pow(base, exp);
    }
    return base;
  }
  function parsePrimary() {
    const tk = peek();
    if (!tk) throw new Error('表达式不完整');
    if (tk.t === 'num') { p++; return tk.v; }
    if (tk.t === 'op' && tk.v === '(') {
      p++;
      const v = parseExpr();
      step();
      if (!peek() || peek().v !== ')') throw new Error('缺少右括号');
      p++;
      return v;
    }
    if (tk.t === 'id') {
      p++;
      const name = tk.v;
      /* 函数调用 */
      if (peek() && peek().t === 'op' && peek().v === '(') {
        const spec = FUNCS[name];
        if (!spec) throw new Error('不支持的函数：' + name);
        p++;
        const args = [];
        if (peek() && !(peek().t === 'op' && peek().v === ')')) {
          args.push(parseExpr());
          while (peek() && peek().t === 'op' && peek().v === ',') { p++; args.push(parseExpr()); }
        }
        if (!peek() || !(peek().t === 'op' && peek().v === ')')) throw new Error('函数 ' + name + ' 缺少右括号');
        p++;
        if (args.length < spec.a[0] || args.length > spec.a[1]) {
          throw new Error(name + ' 需要 ' + (spec.a[0] === spec.a[1] ? spec.a[0] : spec.a[0] + '~' + spec.a[1]) + ' 个参数，实际给了 ' + args.length + ' 个');
        }
        step();
        return spec.fn.apply(null, args);
      }
      /* 常量 */
      if (Object.prototype.hasOwnProperty.call(CONSTS, name)) return CONSTS[name];
      throw new Error('未知的名称：' + name);
    }
    throw new Error('无法解析的内容：' + (tk.v === undefined ? '' : tk.v));
  }

  try {
    const v = parseExpr();
    if (p < tokens.length) throw new Error('表达式末尾有多余内容：' + tokens[p].v);
    if (typeof v !== 'number' || Number.isNaN(v)) return { ok: false, error: '结果不是有效数字' };
    if (!Number.isFinite(v)) return { ok: false, error: '结果超出可表示范围' };
    return { ok: true, value: v };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ---------- 对外的工具契约（OpenAI tools 格式） ----------
 * description 要写**什么时候用它**，而不只是"它是什么"——
 * 工具描述是模型判断该不该调的主要依据。 */
const TOOLS = [{
  type: 'function',
  function: {
    name: 'calc',
    description: '计算一个数值表达式并返回精确结果。凡涉及算术、百分比、单位换算、方程求解、'
      + '多位数运算，必须调用本工具得出结果，不要心算。不需要计算的题目不要调用。',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: '要计算的表达式。支持 + - * / % ^ 与括号；'
            + '函数 sqrt/abs/floor/ceil/round/ln/log/exp/sin/cos/tan/max/min/pow；常量 pi/e。例：(3+5)*2/7'
        }
      },
      required: ['expression']
    }
  }
}];

/* run_code：把"算一遍"从数值表达式扩展到**算法过程**（栈的出栈序列、树的遍历、递归展开、
 * 哈希探查顺序……）。为什么需要它：这些题计算器帮不上忙，模型只能心算，而实测"心算代码输出"
 * 的准确率只有约 31%（见 docs/EVALSUITE.md 阶段二），执行验证的价值就在这里。
 *
 * ⚠ 它跑的是**模型临场生成的任意代码**，所以只在沙箱可用时才提供（见 toolsAll / agent.js）——
 * 和评测的降级策略不同：评测没沙箱可以降级本机跑（那些代码是我们自己的参考实现），
 * 这里没沙箱**就不给这个工具**（宁可不给，也不在本机跑不可信代码）。 */
const RUN_CODE_TOOL = {
  type: 'function',
  function: {
    name: 'run_code',
    description: '把一段 C 程序在**断网沙箱**里编译并运行，返回它的真实输出。'
      + '凡是需要精确推演过程与结果的题（算法执行序列、递归展开、树的遍历、哈希探测顺序、'
      + '模拟多步操作……），都应该写一段短程序用它跑出来，不要心算。程序从标准输入读、往标准输出写。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '完整、可独立编译的 C 程序（只用标准库；不要依赖任何外部文件）。' },
        stdin: { type: 'string', description: '喂给程序的标准输入（不需要输入就留空字符串）。' }
      },
      required: ['code']
    }
  }
};

function list(opts = {}) {
  /* 默认只给 calc（向后兼容：不传 opts 的行为与改动前完全一致）；
   * 要 run_code 必须显式 runCode:true —— 由调用方确认沙箱可用之后才要。 */
  return opts.runCode === true ? TOOLS.concat([RUN_CODE_TOOL]) : TOOLS;
}

function call(name, args) {
  if (name !== 'calc') return { ok: false, error: '未知工具：' + String(name) };
  let a = args;
  if (typeof a === 'string') {
    try { a = JSON.parse(a); } catch (e) { return { ok: false, error: '参数不是合法 JSON' }; }
  }
  if (!a || typeof a !== 'object') return { ok: false, error: '参数必须是对象' };
  if (typeof a.expression !== 'string') return { ok: false, error: 'calc 需要字符串参数 expression' };
  return evaluate(a.expression);
}

/* 统一执行入口（**异步**）：calc 是纯函数、当场算；run_code 要起沙箱容器，必须异步。
 * 执行器由调用方注入（ctx.runCode）—— tools.js 保持"不依赖任何外部模块"的纯函数性质
 * （tools_test 是纯函数套件，不碰数据库、不碰 Docker）。 */
async function callAsync(name, args, ctx = {}) {
  if (name === 'run_code') {
    if (typeof ctx.runCode !== 'function') {
      /* 没注入执行器 = 调用方没确认沙箱可用。**明确报错，不静默跳过** ——
       * 静默跳过会让模型以为"跑了、没输出"，从而按错误的假设往下推理。 */
      return { ok: false, error: 'run_code 工具在当前环境不可用（沙箱未就绪），请改用其它方式推理' };
    }
    let a = args;
    if (typeof a === 'string') {
      try { a = JSON.parse(a); } catch (e) { return { ok: false, error: '参数不是合法 JSON' }; }
    }
    if (!a || typeof a !== 'object') return { ok: false, error: '参数必须是对象' };
    if (typeof a.code !== 'string' || !a.code.trim()) return { ok: false, error: 'run_code 需要字符串参数 code（完整 C 程序）' };
    if (a.code.length > (ctx.maxCodeChars || 8000)) return { ok: false, error: '代码过长（上限 ' + (ctx.maxCodeChars || 8000) + ' 字符）' };
    return ctx.runCode(a.code, a.stdin == null ? '' : String(a.stdin));
  }
  return call(name, args);
}

/* ---------- run_code 的"该不该给"与"怎么执行"（评测与质检共用一份） ----------
 * 放在这里是防止漂移：金标集评估（evals.js）与流水线质检（agent.js）都要做同一件事 ——
 * "这道题该不该给 run_code + 给了怎么跑"。两处各写一份必然分叉（改了 A 忘了 B）。 */

/* 需要"精确推演过程与结果"的题：算法/主观题一律算；选择题里出现推演词也算。
 * ⚠ 判据偏宽（和 needsCalc 一样先宽后收）：误判的代价只是多花一次调用，漏判的代价是正确答案判错。 */
function needsRunCode(q) {
  if (!q) return false;
  if (['solution', 'algo', 'app'].indexOf(q.type) >= 0) return true;
  const text = String(q.stem || '') + ' ' + (Array.isArray(q.options) ? q.options.join(' ') : '');
  return /出栈|入栈|进栈|遍历(顺序|序列|结果)|先序|中序|后序|层序|探测(次序|顺序|序列)|执行(结果|顺序|后)|输出(序列|结果|是)|递归|调用(过程|顺序)|序列|顺序是|依次|最小生成树|最短路|拓扑|散列|哈希|哈夫曼|队列的|栈的/.test(text);
}

/* 决定"这道题到底给不给 run_code"：
 *   开关（QF_TOOLS 总开关 + QF_TOOLS_RUN）→ 判据 → **沙箱可用性**。
 * 沙箱不可用就**不给**：跑的是模型临场生成的代码，宁可不给也不在本机跑它。
 * opts.refresh 供测试用（dockerAvailable 结果有缓存）。 */
async function planRunCode(q, opts = {}) {
  if (process.env.QF_TOOLS !== '1' || process.env.QF_TOOLS_RUN !== '1') return { use: false, reason: 'disabled' };
  if (!needsRunCode(q)) return { use: false, reason: 'not-needed' };
  const CodeRun = require('./coderun');           // 懒加载：没启用时不把 coderun 拖进来
  const av = await CodeRun.dockerAvailable(opts);
  return av.ok ? { use: true, reason: 'sandbox-ready', detail: av.reason }
               : { use: false, reason: 'sandbox-unavailable', detail: av.reason };
}

/* 提示词里的"推演规定"（工具描述之外的强约束：要求它必须跑，而不是可选） */
const RUN_RULE = '\n【推演规定】凡需要**精确推演过程与结果**的题（算法执行序列、递归展开、栈/队列的操作结果、'
  + '树与图的遍历顺序、哈希探测次序、多步模拟），必须写一段短 C 程序调用 run_code 跑出来，'
  + '不得凭印象给序列。程序从标准输入读、往标准输出写；必须以它跑出的真实结果作为依据。';

/* 造一个"工具执行器"给 solveWithTools 用（run_code 走沙箱；不 enabled 时返回 undefined，
 * 于是 callAsync 会对 run_code 明确报错 —— 不是静默跳过） */
function buildRunTool(enabled) {
  return (name, args) => callAsync(name, args, {
    runCode: enabled
      ? (code, stdin) => require('./coderun').runOnce(code, stdin, { runTimeoutMs: 5000, compileTimeoutMs: 30000, maxChars: 3000 })
        .then(r => ({ ok: r.ok, value: r.text, error: r.ok ? undefined : r.text }))
      : undefined
  });
}

module.exports = { list, call, callAsync, evaluate, TOOLS, RUN_CODE_TOOL, MAX_LEN,
  needsRunCode, planRunCode, RUN_RULE, buildRunTool };
