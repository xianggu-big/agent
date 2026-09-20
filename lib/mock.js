/* Mock 演示模式：无 API Key 也能完整跑通流水线（演示与自测用）。
 * 响应可复现（按内容哈希决定分歧），token 用量按经验值模拟，成本/预算链路真实走一遍。 */
'use strict';
const crypto = require('crypto');
const hash = s => crypto.createHash('md5').update(String(s)).digest()[0];

const TYPE_CN = { mcq: '单项选择题', solution: '解答题', algo: '算法设计题', app: '综合应用题' };

/* 出题 mock：按规格生成题目 JSON（含一道刻意埋下的错误答案用于演示质检）
 * 若任务带附图（figures），部分题目会声明基于某张图，用于演示"题目关联原图"链路。 */
function mockGenerate(req, batchIdx, material, figures) {
  const n = Math.min(req.count, 3); // mock 每批最多 3 题，演示足够
  const arr = [];
  for (let i = 0; i < n; i++) {
    const seq = batchIdx * 10 + i;
    const fig = (figures && figures.length && seq % 2 === 0) ? figures[seq % figures.length].id : null;
    if (req.type === 'mcq') {
      const wrong = seq === 0; // 第 0 题故意给错答案 → 演示"分歧进人工队列"
      const q = {
        stem: (fig ? '【演示题·依据附图 ' + fig + '】' : '【演示题】') + TYPE_CN.mcq + '：关于「' + req.kp + '」的概念辨析，下列说法正确的是？（演示模式生成，非真实题目）',
        options: ['概念甲的表述正确', '概念乙的表述正确', '概念丙的表述正确', '概念丁的表述正确'],
        answer: 'B',
        expl: (wrong ? '（本题为演示"质检分歧"而故意写错：实际应选 A）' : '') + '根据资料中「' + req.kp + '」的定义直接推得。演示解析。',
        kp: req.kp
      };
      if (wrong) q.answer = 'C';
      if (fig) q.fig = fig;
      arr.push(q);
    } else {
      const q = {
        stem: (fig ? '【演示题·依据附图 ' + fig + '】' : '【演示题】') + TYPE_CN[req.type] + '：请围绕「' + req.kp + '」设计一道' + TYPE_CN[req.type] + '，并给出分步解答。（演示模式生成）',
        ref: '参考答案要点：1) 先给出核心定义；2) 分步骤推导；3) 结论与易错点提示。（演示内容，非真实答案）',
        kp: req.kp
      };
      if (fig) q.fig = fig;
      arr.push(q);
    }
  }
  return JSON.stringify(arr);
}

/* 质检 mock：verifier1 与出题一致；verifier2 固定每 3 题分歧一次
 * 用题目序号（seq）而非随机哈希 —— 保证演示与回归测试结果完全可复现 */
function mockVerify(q, verifierIdx) {
  let answer = q.answer || '见参考';
  const idx = (q.seq !== undefined && q.seq !== null) ? q.seq : hash(q.stem);
  if (verifierIdx >= 2 && idx % 3 === 0) {
    answer = q.type === 'mcq' ? ({ A: 'B', B: 'C', C: 'D', D: 'A' }[q.answer] || 'A') : '与参考答案存在差异';
  }
  return JSON.stringify({ answer: String(answer), reason: '演示模式：质检员' + verifierIdx + (String(answer) === (q.answer || '') ? ' 独立重解后与出题答案一致。' : ' 重解后与出题答案不一致，需人工裁决。'), confidence: 0.87 });
}

/* 难度标注 mock：按哈希分布 1/2/3 */
function mockTag() { return JSON.stringify({ note: '演示模式：按内容复杂度哈希分布难度' }); }

function mockTagEach(qs) {
  return JSON.stringify({ results: qs.map(q => ({ id: q.id, diff: [1, 1, 2, 2, 3][hash(q.stem) % 5] })) });
}

/* token 模拟用量 */
function mockUsage(inTok, outTok, prof) {
  return { in: inTok, out: outTok, cost: (inTok * (prof.priceIn || 0) + outTok * (prof.priceOut || 0)) / 1e6 };
}

module.exports = { mockGenerate, mockVerify, mockTagEach, mockUsage, hash };
