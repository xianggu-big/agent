/* 计算类金标夹具（合成，供"有/无工具"对比实验使用）
 *
 * 为什么需要它：testdata/golden.js 是概念题（题干里没有数字），
 * 按 needsCalc 判据本就不该给工具 → 拿它做对比实验测不出任何差异。
 * 这份夹具专门放**必须算一遍才稳**的题，答案都是唯一确定的数值。
 *
 * 题目取材自 llm_test 的难题集（那里的标准答案已由 C 参考实现本地跑过并三轮验证）。
 * ⚠ 纯合成题，不含任何真实试题内容。
 */
/* 注意：**不要写 module.exports** —— loadGolden 用 new Function 加载，那里没有 module 对象，
 * 一旦引用就会抛错并被当成"这个候选文件不可用"而静默回落到下一个（实测踩过）。 */
'use strict';
const QUESTIONS = [
  { id: 'c01', type: 'mcq', ch: 1, kp: '计算类夹具', verified: true, answer: 'B',
    stem: '计算 987654321 × 123456789 的结果是多少？',
    options: ['121932631113211269', '121932631112635269', '121932631137021795', '121932631112635268'] },
  { id: 'c02', type: 'mcq', ch: 1, kp: '计算类夹具', verified: true, answer: 'C',
    stem: '求 2^40 - 1 的值。',
    options: ['1073741823', '549755813887', '1099511627775', '2199023255551'] },
  { id: 'c03', type: 'mcq', ch: 1, kp: '计算类夹具', verified: true, answer: 'B',
    stem: '十进制数 1099511627775 的二进制表示中有多少个 1？',
    options: ['39', '40', '41', '20'] },
  { id: 'c04', type: 'mcq', ch: 1, kp: '计算类夹具', verified: true, answer: 'D',
    stem: '100! 末尾有多少个连续的 0？',
    options: ['20', '25', '22', '24'] },
  { id: 'c05', type: 'mcq', ch: 1, kp: '计算类夹具', verified: true, answer: 'B',
    stem: '把十进制数 4095 转成十六进制（字母用大写）是多少？',
    options: ['FEF', 'FFF', '1000', 'EFF'] },
  { id: 'c06', type: 'mcq', ch: 1, kp: '计算类夹具', verified: true, answer: 'C',
    stem: '7 个人围成一圈报数，从 1 号开始，每报到 3 的人出列。第 1 个出列的人是几号？',
    options: ['1', '2', '3', '4'] },
  { id: 'c07', type: 'mcq', ch: 1, kp: '计算类夹具', verified: true, answer: 'A',
    stem: '斐波那契数列 F(1)=1, F(2)=1，求 F(80) 的值。',
    options: ['23416728348467685', '160500643816367088', '14472334024676221', '12322791741412852'] },
  { id: 'c08', type: 'mcq', ch: 1, kp: '计算类夹具', verified: true, answer: 'B',
    stem: '从 2020 年 2 月 28 日到 2020 年 3 月 1 日相差多少天？（2020 年是闰年）',
    options: ['1', '2', '3', '0'] },
  { id: 'c09', type: 'mcq', ch: 1, kp: '计算类夹具', verified: true, answer: 'D',
    stem: '数组 [-2, 1, -3, 4, -1, 2, 1, -5] 的最大连续子数组和是多少？',
    options: ['5', '4', '7', '6'] },
  { id: 'c10', type: 'mcq', ch: 1, kp: '计算类夹具', verified: true, answer: 'C',
    stem: '1/6 + 1/3 的和化成最简分数是多少？',
    options: ['2/9', '1/3', '1/2', '2/6'] }
];
