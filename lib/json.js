/* 从模型输出里稳健地取出 JSON —— 单独成模块，避免 agent.js 与 kp.js 互相 require 成环 */
'use strict';

/* 模型经常把 JSON 包在 markdown 代码块里，或前后带解释文字，也常多一个尾逗号：
 * 这里按"先数组后对象"的顺序截取并容忍尾逗号。 */
function extractJSON(text) {
  const t = String(text == null ? '' : text).replace(/```(json)?/gi, '').replace(/```/g, '');
  const s = t.indexOf('['), e = t.lastIndexOf(']');
  if (s >= 0 && e > s) {
    const body = t.slice(s, e + 1).replace(/,\s*([}\]])/g, '$1');
    try { return JSON.parse(body); } catch (err) { /* 落到对象分支 */ }
  }
  const s2 = t.indexOf('{'), e2 = t.lastIndexOf('}');
  if (s2 >= 0 && e2 > s2) {
    const body = t.slice(s2, e2 + 1).replace(/,\s*([}\]])/g, '$1');
    try { return JSON.parse(body); } catch (err) { throw new Error('模型未返回可解析的 JSON'); }
  }
  throw new Error('模型未返回 JSON');
}
/* 只在解析失败时用的兜底：把文本按行拆成字符串数组 */
function extractLines(text) {
  return String(text == null ? '' : text).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

module.exports = { extractJSON, extractLines };
