/* R2：核实智谱 GLM 是否支持 function calling（真实调用一次，只发一条最短请求省费用）
 * 用法：node r2_check_glm.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const CFG = process.env.QF_CONFIG || path.join(__dirname, 'data', 'config.json');
const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
const prov = (cfg.providers || []).find(p => /bigmodel|zhipu|glm/i.test((p.baseUrl || '') + (p.name || '')) && p.apiKey);
if (!prov) { console.error('配置里找不到智谱供应商'); process.exit(1); }

const model = process.env.QF_GLM_MODEL || 'glm-4-flash';
const tools = [{
  type: 'function',
  function: {
    name: 'calc',
    description: '计算一个数值表达式并返回结果。涉及算术时必须调用。',
    parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] }
  }
}];

(async () => {
  const base = (prov.baseUrl || '').replace(/\/+$/, '');
  console.log('供应商: ' + (prov.name || prov.id) + '  模型: ' + model);
  const t0 = Date.now();
  let resp, txt;
  try {
    resp = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + prov.apiKey },
      body: JSON.stringify({
        model, temperature: 0, max_tokens: 200,
        messages: [{ role: 'user', content: '请计算 (1234+5678)*3 等于多少？必须调用 calc 工具。' }],
        tools, tool_choice: 'auto'
      })
    });
    txt = await resp.text();
  } catch (e) {
    console.log('✗ 请求失败: ' + e.message);
    process.exit(1);
  }
  console.log('HTTP ' + resp.status + '  耗时 ' + (Date.now() - t0) + 'ms');
  if (!resp.ok) {
    console.log('✗ 不支持或报错，返回体（截断）:');
    console.log(txt.slice(0, 500));
    console.log('\n=> 结论：该模型**拒绝了带 tools 的请求**，R1 的降级兜底就是它的保护。');
    process.exit(0);
  }
  const d = JSON.parse(txt);
  const msg = d.choices && d.choices[0] && d.choices[0].message;
  const tcs = (msg && msg.tool_calls) || [];
  console.log('content: ' + JSON.stringify((msg && msg.content) || '').slice(0, 200));
  console.log('tool_calls: ' + tcs.length + ' 个');
  if (tcs.length) {
    console.log('  第一个: ' + JSON.stringify(tcs[0]).slice(0, 300));
    console.log('  ★ 带 id: ' + (tcs[0].id ? '有（' + tcs[0].id + '）' : '无 —— 需要 parseChoice 的补 id 逻辑'));
    console.log('\n=> 结论：GLM **支持** function calling。');
  } else {
    console.log('\n=> 结论：HTTP 200 但没有 tool_calls —— 说明它接受 tools 字段但没按预期调用（能力弱，不是不支持）。');
  }
  if (d.usage) console.log('usage: ' + JSON.stringify(d.usage));
})().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
