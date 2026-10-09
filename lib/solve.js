/* 带工具的"独立解题"——有界循环（最多 MAX_ROUNDS 轮）
 *
 * 为什么要单独一个文件：这段逻辑有**两个调用方**——`agent.js` 的流水线质检、
 * `evals.js` 的金标集评估。各写一份必然漂移（改了流水线忘了改评估，对比实验就失真了）。
 *
 * 「有界」是设计前提（见《2026-10-08 实施方案-质检验算工具》）：
 *   - 只允许模型调**我给的**工具（默认只有 calc），不允许自由规划用哪些工具
 *   - 轮数硬上限，且**循环发生在单题内、不跨题** → 不影响流水线现有的断点续跑语义
 *     （断点仍按"已出题数 / 已质检员数"确定性换算）
 *   - 每次工具轮本身就是一次正常的 LLM 调用 → 现有 meter 自动计费，不需要额外记账
 *
 * 降级（R1，2026-10-09 补）：**不是所有供应商都支持 function calling**。
 * 供应商拒绝 tools 参数时（400/422 且消息提到 tool/function），整个循环**从头用无工具重跑一次**，
 * 而不是让整个质检任务失败。这条是实施方案 §5 承诺过的兜底——它一度"写了方案却漏了实现"，
 * 所以现在由 solve_test.js 的断言守着。
 *
 * 用法：
 *   const r = await solveWithTools(call, profile, sys, user, { tools: Tools.list(), maxTokens: 1600 });
 *   // r = { content, tools: [{name,args,ok,result,ms}], rounds, forced, degraded? }
 */
'use strict';
const Tools = require('./tools');

const MAX_ROUNDS = 3;
/* 单轮工具调用上限：模型一次可能返回很多个 tool_call，全执行会放大成本与落库体积。 */
const MAX_TOOL_CALLS_PER_ROUND = 5;

/* 判定"这个错误是不是因为供应商不支持 tools"。
 *
 * 口径故意收紧（必须同时满足 400/422 且消息提到 tool/function）：
 * 宁可漏判（任务失败、看得见）也不要误判（静默降级、把真问题掩盖成"模型不支持工具"）。
 * 比如 max_tokens 超限也是 400，但那是必须暴露的错误，不该被降级掉。 */
function isToolsUnsupported(err) {
  const status = err && err.status;
  if (status !== 400 && status !== 422) return false;
  const msg = String((err && err.message) || err || '');
  return /tool/i.test(msg) || /function/i.test(msg);
}

/**
 * @param {Function} call    形如 agent.js 里的 call(profile, messages, opts)，负责计费与日志
 * @param {Object}   profile 岗位配置（模型/供应商）
 * @param {String}   sys     系统提示
 * @param {String}   user    用户提示
 * @param {Object}   opts    { tools, toolChoice, maxTokens, temperature, pool, mockContent, ... }
 */
async function solveWithTools(call, profile, sys, user, opts = {}) {
  /* 原始两条消息单独留一份：降级重跑要**从干净的上下文重来**，
   * 不能把已经塞进去的 tool 消息留在历史里（那还是会触发供应商的 tools 校验）。 */
  const baseMessages = [{ role: 'system', content: sys }, { role: 'user', content: user }];
  const tools = opts.tools === undefined ? Tools.list() : opts.tools;

  if (!tools || !tools.length) {
    /* 没有工具就是普通单次调用，走原路径（保证不改变既有行为）。
     * 显式把 tools 置空而不是透传空数组：契约要明确，别让下游去猜"空数组算不算有工具"。 */
    const r = await call(profile, baseMessages, Object.assign({}, opts, { tools: null, toolChoice: null }));
    return { content: r.content, toolCalls: r.toolCalls || [], tools: [], rounds: 1, toolOverrun: 0, forced: false, degraded: false };
  }

  const maxRounds = Math.min(opts.maxRounds || MAX_ROUNDS, MAX_ROUNDS);
  const messages = baseMessages.slice();
  const used = [];
  let overrun = 0;

  try {
    for (let round = 1; round <= maxRounds; round++) {
      const r = await call(profile, messages, Object.assign({}, opts, {
        tools, toolChoice: opts.toolChoice || 'auto', round, label: opts.label || 'solve'
      }));
      /* 没要求调工具 → 它就是最终答案 */
      if (!r.toolCalls || !r.toolCalls.length) {
        return { content: r.content, toolCalls: [], tools: used, rounds: round, toolOverrun: overrun, forced: false, degraded: false };
      }
      /* 把"要求调工具"这条消息原样放回上下文，再逐条追加工具结果 */
      messages.push({ role: 'assistant', content: r.content || '', tool_calls: r.toolCalls });
      let ti = 0;
      for (const tc of r.toolCalls) {
        ti++;
        if (ti > MAX_TOOL_CALLS_PER_ROUND) {
          /* 超出上限的不执行，但必须补一条结果消息，否则 assistant 的 tool_calls 与 tool 消息数量对不上，下次请求会被判格式错误 */
          overrun++;
          messages.push({ role: 'tool', tool_call_id: tc.id,
            content: JSON.stringify({ error: '超出单轮工具调用上限（' + MAX_TOOL_CALLS_PER_ROUND + '），已跳过' }) });
          continue;
        }
        const name = tc.function && tc.function.name;
        const args = tc.function && tc.function.arguments;
        const t0 = Date.now();
        const out = Tools.call(name, args);
        used.push({
          name: name,
          args: typeof args === 'string' ? args : JSON.stringify(args),
          ok: !!out.ok,
          result: out.ok ? out.value : out.error,
          ms: Date.now() - t0
        });
        /* ★ 工具**报错也要喂回去**：否则模型不知道失败了，会继续按自己的假设往下编 */
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(out.ok ? { result: out.value } : { error: out.error })
        });
      }
    }

    /* 用满轮数还在调工具 → 去掉工具再问一次，强制它给出文字答案。
     * （不依赖 tool_choice:'none'，因为不是所有供应商都支持；直接不发 tools 最通用） */
    const r = await call(profile, messages, Object.assign({}, opts, {
      tools: null, toolChoice: null, round: maxRounds + 1, label: (opts.label || 'solve') + '_forced'
    }));
    return { content: r.content, toolCalls: [], tools: used, rounds: maxRounds, toolOverrun: overrun, forced: true, degraded: false };
  } catch (e) {
    if (!isToolsUnsupported(e)) throw e;      // 别的错误照常抛，不许被降级掩盖
    /* 降级：这个模型/供应商不接受 tools。从干净上下文重跑一次无工具版本，
     * 让该质检员"本次改用无工具模式"而不是把整个任务打挂。 */
    const r = await call(profile, baseMessages, Object.assign({}, opts, {
      tools: null, toolChoice: null, label: (opts.label || 'solve') + '_degraded'
    }));
    return {
      content: r.content, toolCalls: [], tools: [], rounds: 1, forced: false,
      degraded: true, degradedReason: String(e.message || '').slice(0, 160)
    };
  }
}

module.exports = { solveWithTools, MAX_ROUNDS, isToolsUnsupported };
