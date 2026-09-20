/* AI 客户端（平台版）：基于 lib/llm.js 的轻量封装
 * 与刷题系统里的 ai.js 同源（单题讲解 / 连续追问），
 * 区别是这里的模型配置来自平台的「API 池」页（服务端持有 Key，不下发前端）。
 *
 * 两个入口：
 *   chat()      → 只返回文本（旧调用方保持兼容）
 *   chatFull()  → 返回 { content, usage }，供"按实际用量计费"的接口使用
 */
'use strict';
const { callLLM, callGuarded } = require('./llm');

const AI = {
  /* 是否已配置可用：按岗位解析（Key 存在供应商池里，不在岗位对象上） */
  configured(cfg) {
    const Store = require('./store');
    const p = Store.profileFor(cfg, 'generator');
    return !!(p && !p.missing && p.apiKey && p.baseUrl && p.model);
  },

  async chatFull(profile, messages, { maxTokens = 2000, temperature = 0.4, meter = null, pool = null } = {}) {
    if (!profile || !profile.apiKey) throw new Error('未配置模型 API Key');
    const r = await callGuarded(profile, messages, { maxTokens, temperature, meter, pool });
    return { content: r.content, usage: r.usage };
  },

  /* 通用对话：messages 为 OpenAI 格式，返回文本 */
  async chat(profile, messages, { maxTokens = 2000, temperature = 0.4, meter = null, pool = null } = {}) {
    const r = await this.chatFull(profile, messages, { maxTokens, temperature, meter, pool });
    return r.content;
  }
};

module.exports = AI;
