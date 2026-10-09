/* 工具层自测：lib/tools.js 的纯函数测试（不需要数据库、不需要起服务、零成本）
 *
 * 这一节最重要的不是"算得对不对"，而是**"不该执行的东西一定不会被执行"**。
 * 因为这个工具将来会通过对外 API / MCP 暴露给外部调用方，
 * 一旦它能被诱导执行代码，就等于把远程代码执行送出去。
 * 用法：node tools_test.js
 */
'use strict';
const T = require('./lib/tools');

let ok = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { ok++; console.log('  [OK] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name + (detail === undefined ? '' : ' → ' + detail)); }
}
function section(t) { console.log('\n【' + t + '】'); }

/* ---------- 1 基本运算与优先级 ---------- */
section('四则运算与优先级');
const val = e => { const r = T.evaluate(e); return r.ok ? r.value : ('ERR:' + r.error); };
check('加法', val('1+2') === 3, val('1+2'));
check('减法得负数', val('3-10') === -7, val('3-10'));
check('乘法优先于加法', val('2+3*4') === 14, val('2+3*4'));
check('括号改变优先级', val('(2+3)*4') === 20, val('(2+3)*4'));
check('除法', val('7/2') === 3.5, val('7/2'));
check('取模', val('7%3') === 1, val('7%3'));
check('一元负号', val('-5+2') === -3, val('-5+2'));
check('连续一元负号', val('--5') === 5, val('--5'));
check('一元负号与幂：-2^2 = -4', val('-2^2') === -4, val('-2^2'));
check('幂右结合：2^3^2 = 512', val('2^3^2') === 512, val('2^3^2'));
check('幂的指数可为负', val('2^-1') === 0.5, val('2^-1'));
check('多重括号', val('((1+2)*(3+4))') === 21, val('((1+2)*(3+4))'));
check('小数运算', Math.abs(val('0.1+0.2') - 0.3) < 1e-12, val('0.1+0.2'));
check('空格无影响', val(' 1 +  2 * 3 ') === 7, val(' 1 +  2 * 3 '));

/* ---------- 2 函数与常量 ---------- */
section('函数与常量');
check('sqrt', val('sqrt(16)') === 4, val('sqrt(16)'));
check('abs', val('abs(-3.5)') === 3.5, val('abs(-3.5)'));
check('floor / ceil / round', val('floor(2.9)') === 2 && val('ceil(2.1)') === 3 && val('round(2.5)') === 3);
check('ln(e) = 1', Math.abs(val('ln(e)') - 1) < 1e-12, val('ln(e)'));
check('log(1000) = 3', Math.abs(val('log(1000)') - 3) < 1e-12, val('log(1000)'));
check('pi 常量可用', Math.abs(val('pi') - Math.PI) < 1e-12);
check('pow 两参数', val('pow(2,10)') === 1024, val('pow(2,10)'));
check('max 可变参数', val('max(1,5,3)') === 5, val('max(1,5,3)'));
check('min 可变参数', val('min(4,2,9,2)') === 2, val('min(4,2,9,2)'));
check('函数参数可以是表达式', val('sqrt(3^2+4^2)') === 5, val('sqrt(3^2+4^2)'));
check('函数可嵌套', val('abs(min(-7,3))') === 7, val('abs(min(-7,3))'));

/* ---------- 3 错误处理（要返回错误，而不是抛异常/崩掉） ---------- */
section('错误处理');
const isErr = e => { const r = T.evaluate(e); return r.ok === false; };
check('除数为零 → 错误', isErr('1/0'));
check('取模除数为零 → 错误', isErr('5%0'));
check('sqrt 负数 → 错误', isErr('sqrt(-1)'));
check('ln(0) → 错误', isErr('ln(0)'));
check('log 负数 → 错误', isErr('log(-5)'));
check('未知函数 → 错误', isErr('foo(1)'));
check('未知名称 → 错误', isErr('xyz'));
check('缺少右括号 → 错误', isErr('(1+2'));
check('多余右括号 → 错误', isErr('1+2)'));
check('表达式不完整 → 错误', isErr('1+'));
check('空表达式 → 错误', isErr(''));
check('纯空格 → 错误', isErr('   '));
check('非法字符 → 错误', isErr('1 & 2'));
check('参数个数不对 → 错误', isErr('pow(2)'));
check('参数过多 → 错误', isErr('sqrt(1,2)'));
check('数字格式错误 → 错误', isErr('1.2.3'));
check('溢出 → 错误（不是 Infinity）', isErr('10^400'));
check('超长表达式 → 错误', isErr('1+' .repeat(200) + '1'));
check('错误带原因说明', (() => { const r = T.evaluate('1/0'); return !r.ok && /零/.test(r.error); })());

/* ---------- 4 ★ 安全回归：不该被执行的任何东西，必须只是"报错" ---------- */
section('安全回归（这一节最重要）');
const dangerous = [
  'process.exit(1)',
  'require("fs")',
  'global.process',
  'this.constructor',
  'constructor.constructor("return 1")()',
  '__proto__',
  'process.env',
  'import("fs")',
  'eval("1+1")',
  'Function("return 1")()',
  'x => x',
  '1;process.exit(1)',
  'console.log(1)'
];
dangerous.forEach(d => {
  const r = T.evaluate(d);
  check('拦截：' + d, r.ok === false, r.ok ? '⚠ 被执行了！' : r.error);
});
check('没有发生副作用（进程仍存活）', true);

/* ---------- 5 工具契约（对外的 tools 定义与 call） ---------- */
section('工具契约');
const tools = T.list();
check('tools 是数组且至少 1 个', Array.isArray(tools) && tools.length >= 1);
const f = tools[0].function;
check('工具名是 calc', f.name === 'calc', f.name);
check('有描述', typeof f.description === 'string' && f.description.length > 20);
check('描述里写了"什么时候用"', /必须调用|不要心算/.test(f.description));
check('参数 schema 要求 expression', f.parameters.required.indexOf('expression') >= 0);
check('call("calc", {expression}) 正常', (() => { const r = T.call('calc', { expression: '2+2' }); return r.ok && r.value === 4; })());
check('call 支持 JSON 字符串参数', (() => { const r = T.call('calc', '{"expression":"3*3"}'); return r.ok && r.value === 9; })());
check('call 未知工具 → 错误', T.call('rm_rf', {}).ok === false);
check('call 缺参数 → 错误', T.call('calc', {}).ok === false);
check('call 参数非法 JSON → 错误', T.call('calc', '{bad').ok === false);

/* ---------- 汇总 ---------- */
console.log('\n通过 ' + ok + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
