/* R4：标定 needsCalc —— 用两个标注集算混淆矩阵
 *  正例集 testdata/golden_calc.js（10 道必须算一遍的题）→ 应该被判为"需要计算"
 *  负例集 testdata/golden.js（12 道概念题）      → 不应该被判为"需要计算"
 * 用法：node r4_calibrate.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { needsCalc } = require('./lib/agent');

function load(f) {
  const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
  return new Function(src + '\n;return typeof QUESTIONS!=="undefined"?QUESTIONS:null;')() || [];
}
const pos = load('testdata/golden_calc.js');
const neg = load('testdata/golden.js');

let tp = 0, fn = 0, fp = 0, tn = 0;
const fpList = [], fnList = [];
pos.forEach(q => { if (needsCalc(q)) tp++; else { fn++; fnList.push(q.id + ' ' + String(q.stem).slice(0, 40)); } });
neg.forEach(q => { if (needsCalc(q)) { fp++; fpList.push(q.id + ' ' + String(q.stem).slice(0, 40)); } else tn++; });

console.log('正例集（需要计算）: ' + pos.length + ' 道  → 判定需要计算 ' + tp + '，漏判 ' + fn);
console.log('负例集（概念题）  : ' + neg.length + ' 道  → 误判需要计算 ' + fp + '，正确排除 ' + tn);
const prec = (tp + fp) ? (100 * tp / (tp + fp)).toFixed(1) : '-';
const rec = (tp + fn) ? (100 * tp / (tp + fn)).toFixed(1) : '-';
console.log('精确率 ' + prec + '%   召回率 ' + rec + '%');
if (fpList.length) { console.log('\n误判（概念题被当成计算题）：'); fpList.forEach(x => console.log('  ✗ ' + x)); }
if (fnList.length) { console.log('\n漏判（计算题没被认出来）：'); fnList.forEach(x => console.log('  ✗ ' + x)); }
