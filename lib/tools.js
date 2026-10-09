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

function list() { return TOOLS; }

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

module.exports = { list, call, evaluate, TOOLS, MAX_LEN };
