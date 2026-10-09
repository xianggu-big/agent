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
 * 用法：
 *   const r = await solveWithTools(call, profile, sys, user, { tools: Tools.list(), maxTokens: 1600 });
 *   // r = { content, tools: [{name,args,ok,result,ms}], rounds, forced }
 */
'use strict';
const Tools = require('./tools');

const MAX_ROUNDS = 3;

/**
 * @param {Function} call    形如 agent.js 里的 call(profile, messages, opts)，负责计费与日志
 * @param {Object}   profile 岗位配置（模型/供应商）
 * @param {String}   sys     系统提示
 * @param {String}   user    用户提示
 * @param {Object}   opts    { tools, toolChoice, maxTokens, temperature, pool, mockContent, inTok, outTok, round 以外透传 }
 */
async function solveWithTools(call, profile, sys, user, opts = {}) {
  const maxRounds = Math.min(opts.maxRounds || MAX_ROUNDS, MAX_ROUNDS);
  const tools = opts.tools === undefined ? Tools.list() : opts.tools;
  if (!tools || !tools.length) {
    /* 没有工具就是普通单次调用，走原路径（保证不改变既有行为）。
     * 显式把 tools 置空而不是透传空数组：契约要明确，别让下游去猜"空数组算不算有工具"。 */
    const r = await call(profile, [{ role: 'system', content: sys }, { role: 'user', content: user }],
      Object.assign({}, opts, { tools: null, toolChoice: null }));
    return { content: r.content, toolCalls: r.toolCalls || [], tools: [], rounds: 1, forced: false };
  }

  const messages = [{ role: 'system', content: sys }, { role: 'user', content: user }];
  const used = [];

  for (let round = 1; round <= maxRounds; round++) {
    const r = await call(profile, messages, Object.assign({}, opts, {
      tools, toolChoice: opts.toolChoice || 'auto', round, label: opts.label || 'solve'
    }));
    /* 没要求调工具 → 它就是最终答案 */
    if (!r.toolCalls || !r.toolCalls.length) {
      return { content: r.content, toolCalls: [], tools: used, rounds: round, forced: false };
    }
    /* 把"要求调工具"这条消息原样放回上下文，再逐条追加工具结果 */
    messages.push({ role: 'assistant', content: r.content || '', tool_calls: r.toolCalls });
    for (const tc of r.toolCalls) {
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
  return { content: r.content, toolCalls: [], tools: used, rounds: maxRounds, forced: true };
}

module.exports = { solveWithTools, MAX_ROUNDS };
