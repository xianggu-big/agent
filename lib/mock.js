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
 * 用题目序号（seq）而非随机哈希 —— 保证演示与回归测试结果完全可复现
 *
 * round 参数用于覆盖「有界工具调用」的两条路径（不覆盖的话那段逻辑在 CI 上跑不到）：
 *   round=1 且该题被判定需要计算 → 返回一次工具调用（要求模型先算）
 *   round=2 → 返回最终判定
 * opts.run=true（本轮提供了 run_code 工具）时，round=1 会改成"先写段小程序跑一下"，
 * 好让"沙箱工具 → 真起容器 → 结果喂回"这条链路在 mock 模式下也走一遍。
 * 返回值既可以是字符串（普通返回），也可以是 {content, toolCalls}（要求调工具）。 */
function mockVerify(q, verifierIdx, round, opts) {
  const idx = (q.seq !== undefined && q.seq !== null) ? q.seq : hash(q.stem);
  /* run_code 路径：**只在 calc 分支不触发的题上**（两分支必须互斥，
   * 否则 run_code 会把 calc 的"会算错"那条路径吞掉，覆盖就悄悄少了一块）。
   * 只让 verifier1 调；另一种情况由 verifier2 覆盖"给了也不调"。
   * 程序是真的能跑出结果的（打印约瑟夫出列序列），这样"结果喂回"才有真内容。 */
  if (opts && opts.run && round === 1 && verifierIdx === 1 && idx % 2 === 0 && idx % 3 !== 2) {
    return {
      content: '',
      toolCalls: [{
        id: 'mock_runcode_' + idx,
        type: 'function',
        function: {
          name: 'run_code',
          arguments: JSON.stringify({
            code: '#include <stdio.h>\nint main(void){int a[7],i=0,j=0,k=0,alive=7;for(int x=0;x<7;x++)a[x]=1;/* 约瑟夫 n=7,m=3 */\nwhile(alive){k=0;while(k<3){if(a[i])k++;if(k==3)break;i=(i+1)%7;}a[i]=0;printf("%d ",i+1);alive--;i=(i+1)%7;}\nprintf("\\n");return 0;}',
            stdin: ''
          })
        }
      }]
    };
  }
  /* 需要工具的题：每 3 题挑 1 题，且只让 verifier1 用工具（另一条路径由 verifier2 覆盖"不调工具"） */
  const needsTool = (idx % 3 === 2);
  if (round === 1 && verifierIdx === 1 && needsTool) {
    /* 每隔几题刻意给一个"会算错"的表达式，覆盖"工具报错也要喂回模型"这条路径 */
    const bad = (idx % 6 === 2);
    return {
      content: '',
      toolCalls: [{
        id: 'mock_calc_' + idx,
        type: 'function',
        function: {
          name: 'calc',
          arguments: JSON.stringify({ expression: bad ? '1/(3-3)' : '(2+3)*4' })
        }
      }]
    };
  }
  let answer = q.answer || '见参考';
  if (verifierIdx >= 2 && idx % 3 === 0) {
    answer = q.type === 'mcq' ? ({ A: 'B', B: 'C', C: 'D', D: 'A' }[q.answer] || 'A') : '与参考答案存在差异';
  }
  const consistent = String(answer) === (q.answer || '');
  /* 用了工具的题：把工具算出的数字写进理由，方便演示"心算 vs 工具"这条链路 */
  const calcNote = needsTool ? (idx % 6 === 2 ? '（工具计算失败，已按题目条件人工推导）' : '（工具计算：结果为 20）') : '';
  return JSON.stringify({
    answer: String(answer),
    reason: '演示模式：质检员' + verifierIdx + calcNote
      + (consistent ? ' 独立重解后与出题答案一致。' : ' 重解后与出题答案不一致，需人工裁决。'),
    confidence: 0.87
  });
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
