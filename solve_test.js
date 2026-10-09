/* 有界工具循环自测：llm.js 的请求/响应纯函数 + lib/solve.js 的四条路径
 *
 * 不需要网络、不需要数据库、零成本 —— 用假的 call() 函数把模型行为脚本化。
 * 重点覆盖三类容易出错的地方：
 *   ① 请求体：不传工具时必须与改动前完全一致（向后兼容）
 *   ② 响应解析：**要调工具时 content 可能为空，不能当错误抛**
 *   ③ 循环：轮数上限、工具报错要喂回去、超轮数要强制收口
 * 用法：node solve_test.js
 */
'use strict';
const L = require('./lib/llm');
const S = require('./lib/solve');
const Tools = require('./lib/tools');

let ok = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { ok++; console.log('  [OK] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name + (detail === undefined ? '' : ' → ' + detail)); }
}
function section(t) { console.log('\n【' + t + '】'); }
const PROFILE = { model: 'test-model', label: '测试岗' };
const tc = (name, args, id) => ({ id: id || 'c1', type: 'function', function: { name: name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });

/* 造一个脚本化的 call：第 N 次调用返回 script[N-1] */
function makeCall(script) {
  const log = [];
  const call = async (profile, messages, opts = {}) => {
    log.push({ messages: JSON.parse(JSON.stringify(messages)), opts: Object.assign({}, opts) });
    if (script[log.length - 1] instanceof Error) throw script[log.length - 1];
    const step = script[log.length - 1];
    if (!step) throw new Error('脚本用完了（第 ' + log.length + ' 次调用没有对应步骤）');
    return typeof step === 'function' ? step(messages, opts) : step;
  };
  call.log = log;
  return call;
}

/* ---------- 1 请求体构造（向后兼容 + 工具字段） ---------- */
section('请求体构造 buildBody');
const b0 = L.buildBody(PROFILE, [{ role: 'user', content: 'hi' }], { maxTokens: 500, temperature: 0.4 });
check('默认带上 model/messages/max_tokens/temperature', b0.model === 'test-model' && b0.max_tokens === 500 && b0.temperature === 0.4);
check('★ 不传工具时：请求体里没有 tools 字段（向后兼容）', !('tools' in b0));
check('★ 不传工具时：请求体里没有 tool_choice 字段', !('tool_choice' in b0));
const b1 = L.buildBody(PROFILE, [], { tools: Tools.list() });
check('传了工具时带 tools 字段', Array.isArray(b1.tools) && b1.tools.length === 1);
check('tool_choice 默认 auto', b1.tool_choice === 'auto', b1.tool_choice);
const b2 = L.buildBody(PROFILE, [], { tools: Tools.list(), toolChoice: 'required' });
check('tool_choice 可覆盖', b2.tool_choice === 'required', b2.tool_choice);
const b3 = L.buildBody(PROFILE, [], { tools: [] });
check('空工具数组视为不传工具', !('tools' in b3));
check('temperature 未指定时默认 0.3', L.buildBody(PROFILE, [], {}).temperature === 0.3);
check('max_tokens 未指定时默认 3000', L.buildBody(PROFILE, [], {}).max_tokens === 3000);

/* ---------- 2 响应解析（含"要调工具时 content 为空"这个关键点） ---------- */
section('响应解析 parseChoice');
const p0 = L.parseChoice({ choices: [{ message: { content: '答案是 B' } }] });
check('普通文字返回：content 正确', p0.content === '答案是 B');
check('普通文字返回：toolCalls 为空数组', Array.isArray(p0.toolCalls) && p0.toolCalls.length === 0);

const p1 = L.parseChoice({ choices: [{ message: { content: null, tool_calls: [tc('calc', { expression: '1+1' })] } }] });
check('★ 要调工具且 content 为 null → 不报错（旧实现会误判成"空内容"）', p1.content === '');
check('★ 解析出工具名', p1.toolCalls.length === 1 && p1.toolCalls[0].function.name === 'calc');
check('★ 解析出参数（JSON 字符串原样保留）', p1.toolCalls[0].function.arguments === '{"expression":"1+1"}');
check('★ 缺 id 时补一个（回传 tool 结果必须带 id）', !!p1.toolCalls[0].id);

const p2 = L.parseChoice({ choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'calc' } }] } }] });
check('arguments 缺失时兜底为 {}', p2.toolCalls[0].function.arguments === '{}');

const p3 = L.parseChoice({ choices: [{ message: { content: '文字 + 同时要调工具', tool_calls: [tc('calc', {})] } }] });
check('文字与工具调用可共存', p3.content === '文字 + 同时要调工具' && p3.toolCalls.length === 1);

check('content 空且无工具调用 → 报错', (() => { try { L.parseChoice({ choices: [{ message: { content: '' } }] }); return false; } catch (e) { return /空内容/.test(e.message); } })());
check('响应结构异常 → 报错', (() => { try { L.parseChoice({}); return false; } catch (e) { return /结构异常/.test(e.message); } })());

/* ---------- 3 有界循环：路径一「第一轮直接答」 ---------- */
section('循环路径一：第一轮直接给出答案（不调工具）');
(async () => {
  let call = makeCall([{ content: '{"answer":"B"}', toolCalls: [] }]);
  let r = await S.solveWithTools(call, PROFILE, 'SYS', 'USER', { tools: Tools.list(), maxTokens: 800 });
  check('返回内容正确', r.content === '{"answer":"B"}', r.content);
  check('rounds = 1', r.rounds === 1, r.rounds);
  check('tools 使用记录为空', r.tools.length === 0);
  check('forced = false', r.forced === false);
  check('只调了一次模型（计费正确）', call.log.length === 1, call.log.length);
  check('第一轮就把工具定义发给了模型', !!(call.log[0].opts.tools && call.log[0].opts.tools.length));
  check('system / user 消息按顺序传入', call.log[0].messages.length === 2 && call.log[0].messages[0].role === 'system');

  /* ---------- 路径二：先调工具，再给答案 ---------- */
  section('循环路径二：调工具后给出答案');
  call = makeCall([
    { content: '', toolCalls: [tc('calc', { expression: '(3+5)*2' }, 'call_a')] },
    { content: '{"answer":"16"}', toolCalls: [] }
  ]);
  r = await S.solveWithTools(call, PROFILE, 'SYS', 'USER', { tools: Tools.list(), maxTokens: 800 });
  check('返回第二轮的内容', r.content === '{"answer":"16"}', r.content);
  check('rounds = 2', r.rounds === 2, r.rounds);
  check('记录了 1 次工具调用', r.tools.length === 1, r.tools.length);
  check('工具名正确', r.tools[0].name === 'calc');
  check('工具执行成功', r.tools[0].ok === true);
  check('★ 工具算出了正确结果 16', r.tools[0].result === 16, r.tools[0].result);
  check('记录了工具耗时', typeof r.tools[0].ms === 'number');
  check('调了两次模型（每轮都计费）', call.log.length === 2, call.log.length);
  const m2 = call.log[1].messages;
  check('★ 第二轮带上了 assistant 的工具调用消息', m2.some(x => x.role === 'assistant' && Array.isArray(x.tool_calls)));
  const toolMsg = m2.filter(x => x.role === 'tool');
  check('★ 第二轮带上了 role=tool 的结果消息', toolMsg.length === 1);
  check('★ tool 消息带 tool_call_id（对上 id）', toolMsg[0] && toolMsg[0].tool_call_id === 'call_a', toolMsg[0] && toolMsg[0].tool_call_id);
  check('★ 工具结果以 JSON 形式回传', (() => { try { return JSON.parse(toolMsg[0].content).result === 16; } catch (e) { return false; } })());
  check('第二轮仍带工具定义（允许继续调）', !!(call.log[1].opts.tools && call.log[1].opts.tools.length));

  /* ---------- 路径三：工具报错要喂回去，而不是抛异常 ---------- */
  section('循环路径三：工具报错 → 作为结果喂回，不抛异常');
  call = makeCall([
    { content: '', toolCalls: [tc('calc', { expression: '1/0' })] },
    { content: '{"answer":"除数为零，题目可能有误","confidence":0.3}', toolCalls: [] }
  ]);
  r = await S.solveWithTools(call, PROFILE, 'SYS', 'USER', { tools: Tools.list(), maxTokens: 800 });
  check('不抛异常，正常返回', typeof r.content === 'string' && r.content.length > 0);
  check('记录了这次失败的调用', r.tools.length === 1 && r.tools[0].ok === false);
  check('错误原因被记录', /零/.test(String(r.tools[0].result)), r.tools[0].result);
  const errMsg = call.log[1].messages.filter(x => x.role === 'tool')[0];
  check('★ 错误以 {error:...} 回传给模型（否则它会继续瞎编）', (() => { try { return !!JSON.parse(errMsg.content).error; } catch (e) { return false; } })());

  /* 未知工具同样要喂回错误 */
  call = makeCall([
    { content: '', toolCalls: [tc('rm_rf', { path: '/' })] },
    { content: '{"answer":"x"}', toolCalls: [] }
  ]);
  r = await S.solveWithTools(call, PROFILE, 'SYS', 'USER', { tools: Tools.list(), maxTokens: 800 });
  check('未知工具不会执行，只回错误', r.tools[0].ok === false && /未知工具/.test(String(r.tools[0].result)));
  check('未知工具后流程继续（不是崩掉）', r.rounds === 2);

  /* ---------- 路径四：一直调工具 → 用满轮数被强制收口 ---------- */
  section('循环路径四：一直调工具 → 硬上限 + 强制收口');
  const always = () => ({ content: '', toolCalls: [tc('calc', { expression: '1+1' }, 'c' + Math.random())] });
  call = makeCall([always, always, always, { content: '{"answer":"final"}', toolCalls: [] }]);
  r = await S.solveWithTools(call, PROFILE, 'SYS', 'USER', { tools: Tools.list(), maxTokens: 800 });
  check('轮数被限制在 3', r.rounds === 3, r.rounds);
  check('forced 标记为 true', r.forced === true);
  check('返回了强制收口后的内容', r.content === '{"answer":"final"}', r.content);
  check('用了 3 次工具', r.tools.length === 3, r.tools.length);
  check('总共调了 4 次模型（3 轮 + 1 次收口）', call.log.length === 4, call.log.length);
  check('★ 收口那次请求里没有 tools（强制它作答）', !call.log[3].opts.tools);
  check('★ 普通轮次里都有 tools', !!(call.log[0].opts.tools && call.log[1].opts.tools && call.log[2].opts.tools));

  /* maxRounds 不能超过硬上限 */
  call = makeCall([always, always, always, { content: '{"answer":"x"}', toolCalls: [] }]);
  r = await S.solveWithTools(call, PROFILE, 'SYS', 'USER', { tools: Tools.list(), maxRounds: 99 });
  check('maxRounds 传 99 也只跑 3 轮（硬上限）', r.rounds === 3, r.rounds);

  /* ---------- 无工具时走原路径 ---------- */
  section('无工具时走原路径（保证不改变既有行为）');
  call = makeCall([{ content: '{"answer":"B"}', toolCalls: [] }]);
  r = await S.solveWithTools(call, PROFILE, 'SYS', 'USER', { tools: [] });
  check('tools 为空时只调一次模型', call.log.length === 1, call.log.length);
  check('tools 为空时请求体里不带 tools', !call.log[0].opts.tools);
  check('rounds = 1', r.rounds === 1);
  check('内容原样返回', r.content === '{"answer":"B"}');

  /* ---------- 路径五：供应商不支持 tools → 降级为无工具重跑（R1） ----------
   * 这条对应实施方案 §5 承诺过的兜底，曾经"写了方案却没实现"。
   * 现在的规矩是：承诺必须有一条会红的断言守着。 */
  section('循环路径五：不支持 tools 的供应商 → 降级重跑（不让任务失败）');
  const err400tools = () => { const e = new Error('API 400: {"error":{"message":"tools is not supported by this model"}}'); e.status = 400; return e; };

  call = makeCall([
    (m, o) => { if (o.tools && o.tools.length) { const e = new Error('API 400: tools is not supported by this model'); e.status = 400; throw e; } return { content: '{}', toolCalls: [] }; },
    { content: '{"answer":"B"}', toolCalls: [] }
  ]);
  r = await S.solveWithTools(call, PROFILE, 'SYS', 'USER', { tools: Tools.list(), maxTokens: 800 });
  check('★ 不抛异常（任务不会因此失败）', r.content === '{"answer":"B"}', r.content);
  check('★ 结果标记为已降级', r.degraded === true, r.degraded);
  check('★ 降级重跑那次没有带 tools', !call.log[1].opts.tools);
  check('降级后不记录工具调用', r.tools.length === 0);
  check('记录了降级原因', /tools is not supported/.test(String(r.degradedReason)), r.degradedReason);

  /* 与 tools 无关的 400 必须照常抛出 —— 否则会静默降级、把真问题掩盖掉 */
  call = makeCall([
    (() => { const e = new Error('API 400: max_tokens too large for this model'); e.status = 400; return e; })(),
    (() => { const e = new Error('API 400: max_tokens too large for this model'); e.status = 400; return e; })()
  ]);
  let threw = null;
  try { await S.solveWithTools(call, PROFILE, 'SYS', 'USER', { tools: Tools.list(), maxTokens: 999999 }); }
  catch (e) { threw = e; }
  check('★ 与 tools 无关的 400 仍然抛出（不掩盖真问题）', !!threw && /max_tokens/.test(threw.message), threw && threw.message);
  check('★ 且没有偷偷降级重跑', call.log.length === 1, call.log.length);

  /* 5xx 不属可降级 */
  call = makeCall([(() => { const e = new Error('API 500: internal error'); e.status = 500; return e; })()]);
  threw = null;
  try { await S.solveWithTools(call, PROFILE, 'SYS', 'USER', { tools: Tools.list() }); } catch (e) { threw = e; }
  check('500 照常抛出（不属可降级错误）', !!threw && /500/.test(threw.message));

  /* 本来就没带工具时，400 照常抛出 */
  call = makeCall([(() => { const e = new Error('API 400: tools is not supported'); e.status = 400; return e; })()]);
  threw = null;
  try { await S.solveWithTools(call, PROFILE, 'SYS', 'USER', { tools: [] }); } catch (e) { threw = e; }
  check('未带工具时 400 照常抛出（没有降级可降）', !!threw);
  /* ---------- 单轮工具调用数量上限（R5） ---------- */
  section('单轮工具调用上限');
  const many = () => ({ content: '', toolCalls: [1,2,3,4,5,6,7,8].map(n => tc('calc', { expression: n + '+1' }, 'c' + n)) });
  call = makeCall([many, { content: '{"answer":"x"}', toolCalls: [] }]);
  r = await S.solveWithTools(call, PROFILE, 'SYS', 'USER', { tools: Tools.list() });
  check('单轮工具调用被限制在上限内', r.tools.length === 5, r.tools.length);
  check('超出部分被记录（不静默丢弃）', r.toolOverrun === 3, r.toolOverrun);
  check('★ 每个 tool_call 都配了结果消息（不破坏 API 配对）', call.log[1].messages.filter(x => x.role === 'tool').length === 8, call.log[1].messages.filter(x => x.role === 'tool').length);

  /* ---------- 汇总 ---------- */
  console.log('\n通过 ' + ok + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('✗ 测试自身出错：' + e.message); process.exit(1); });
