/* 近似重复判定指标的标定实验（阈值 0.62 的依据）
 *
 * 为什么需要这个脚本：中文题干的近似重复用哪套指标、阈值定多少，凭感觉定会两头出错 ——
 * 定高了漏检（客户拿到重复题），定低了误判（好题被标成重复）。这里用一组真实形态的题对量出来。
 * 运行：node simcal.js
 * 结论：'2-gram 重叠系数'把改写的同一道题(0.69~0.95) 与不同考点(≤0.21) 分得很开，
 *      因此 lib/text.js 的 similarity() 采用它（并与 3-gram Jaccard 取最大值），阈值取 0.62。 */
'use strict';


const pairs = [
  ['改标点+微调', '下列关于循环队列判满与判空的说法，正确的是（　）', '关于循环队列判满、判空的说法中，正确的是（　）'],
  ['语序调整', '设有一个循环队列，判断队满的条件是什么？', '循环队列中队满的判断条件是什么？'],
  ['增删修饰', '在单链表中删除结点p的后继结点，时间复杂度是多少？', '单链表中删除结点 p 的后继结点时，时间复杂度是（　）'],
  ['换选项措辞', '顺序表插入元素平均需要移动多少个元素？', '在顺序表中插入一个元素，平均需要移动的元素个数是？'],
  // 以下应当是"不同题"
  ['不同考点A', '下列关于循环队列判满与判空的说法，正确的是（　）', '在含 n 个结点的完全二叉树中，叶子结点的个数是多少？'],
  ['不同考点B', '二叉树的先序遍历和中序遍历可以唯一确定一棵二叉树。', '图的深度优先遍历与广度优先遍历的时间复杂度分别是多少？'],
  ['同章节不同知识点', '顺序表的插入平均移动多少个元素？', '单链表的插入需要修改几个指针域？']
];

/* 方案：字符 n-gram 的 Jaccard / 重叠系数（overlap coefficient），可选去样板语 */
const BOILER = /(下列关于|关于|下列说法|的说法|说法中|中，|，|正确的是|哪一项|以下|下列|设有一个|设有|一个|的是|什么|多少|请|试|若|则)/g;
function norm(s, stripBoiler) {
  let t = String(s).toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  if (stripBoiler) t = t.replace(BOILER, '');
  return t;
}
function grams(s, n) {
  const set = new Set();
  if (s.length <= n) { if (s) set.add(s); return set; }
  for (let i = 0; i + n <= s.length; i++) set.add(s.slice(i, i + n));
  return set;
}
function jac(A, B) { let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i); }
function overlap(A, B) { let i = 0; for (const x of A) if (B.has(x)) i++; return i / Math.min(A.size, B.size); }

console.log('配对'.padEnd(18) + 'tri-jac  tri-ovl  bi-jac   bi-ovl   bi-jac+去样板');
console.log('-'.repeat(76));
for (const [label, a, b] of pairs) {
  const r = [
    jac(grams(norm(a, false), 3), grams(norm(b, false), 3)),
    overlap(grams(norm(a, false), 3), grams(norm(b, false), 3)),
    jac(grams(norm(a, false), 2), grams(norm(b, false), 2)),
    overlap(grams(norm(a, false), 2), grams(norm(b, false), 2)),
    jac(grams(norm(a, true), 2), grams(norm(b, true), 2))
  ].map(x => x.toFixed(3).padEnd(9));
  console.log(label.padEnd(18) + r.join(''));
}
console.log('\n结论：采用「2-gram 重叠系数」（bi-ovl 列）—— 改写的同一题 0.69~0.95、不同考点 ≤0.21；');
console.log('      lib/text.js 的 similarity() 取它与 3-gram Jaccard 的最大值，阈值 0.62。');
