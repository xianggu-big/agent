/* 视图取数审计：检查每个页面是否从数据库（API）实时取数，而不是只展示内存缓存
 * 用法: node viewaudit.js */
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'web', 'console.js'), 'utf8');

/* 逐个函数体切出来（按 function 名与缩进匹配大括号） */
function bodyOf(name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(src);
  if (!m) return null;
  let i = src.indexOf('{', m.index), depth = 0, start = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

const views = [
  ['vChat', '对话制题（含上传/知识点/报价）'], ['vMaterials', '我的资料库'],
  ['vTasks', '制题任务'], ['vTask', '任务详情'], ['vPractice', '我的题库'],
  ['vProfile', '个人中心'], ['vEval', '金标集评估'], ['vMemory', '经验库'], ['vSettings', '模型与预算']
];

let warn = 0;
console.log('视图'.padEnd(12) + '实时取数（调用后端接口）');
console.log('-'.repeat(78));
for (const [fn, label] of views) {
  const b = bodyOf(fn);
  if (!b) { console.log((label + ' ' + fn).padEnd(12) + '未找到函数'); warn++; continue; }
  const calls = [...new Set([...b.matchAll(/api\(\s*'([^']+)'/g)].map(m => m[1]))];
  const indirect = /await\s+loadMaterialList|await\s+refresh|await\s+openTask|->/.test(b);
  const cacheOnly = /State\.(tasks|questions|events|practice)\b/.test(b) && !calls.length;
  if (calls.length) {
    console.log((label + ' ' + fn).padEnd(12) + '✓ ' + calls.join(', '));
  } else if (indirect) {
    console.log((label + ' ' + fn).padEnd(12) + '✓ 经由 refresh()/loadMaterialList() 取数');
  } else if (cacheOnly) {
    console.log((label + ' ' + fn).padEnd(12) + '⚠ 仅读取内存缓存（State.*），未重新请求');
    warn++;
  } else {
    console.log((label + ' ' + fn).padEnd(12) + '— 纯静态渲染');
  }
}
console.log('-'.repeat(78));
if (warn) { console.log('存在 ' + warn + ' 处可能不实时，请检查。'); process.exit(1); }
console.log('所有页面均从后端（数据库）取数。');
