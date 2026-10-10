/* 把某份资料的分块结果导出成可读文本，供人工核对"哪一块在讲什么"
 *
 * 为什么需要它：`retrieval_eval.js --gen` 每块只打印前 78 字，
 * 而标注 labels 时必须看清整块内容才知道它到底在讲哪个考点。
 *
 * 用法：node dump_chunks.js <资料id>
 * 产物：data/retrieval/<资料id>.chunks.txt（用记事本/VSCode 打开即可）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const db = require('./lib/db');
const Text = require('./lib/text');

const mid = process.argv[2];
if (!mid) { console.log('用法：node dump_chunks.js <资料id>   （资料id 用 node retrieval_eval.js --list 查）'); process.exit(1); }

(async () => {
  await db.init();
  const [rows] = await db.q('SELECT id,name,text FROM materials WHERE id=? AND deleted_at IS NULL', [mid]);
  if (!rows.length) { console.log('✗ 找不到资料 ' + mid); await db.pool.end(); process.exit(1); }
  const mat = rows[0];
  const text = mat.text || '';
  const chunks = Text.splitChunks(text);

  const out = [];
  out.push('资料：' + mat.name);
  out.push('全文 ' + text.length + ' 字，换行 ' + ((text.match(/\n/g) || []).length) + ' 个，切成 ' + chunks.length + ' 块');
  out.push('（这个文件是给人看的，不是程序输入；判断"这块在讲什么"就看它）');
  out.push('');
  chunks.forEach(c => {
    out.push('══════════ 块 ' + c.i + '　章节 ' + (c.ch === null ? '未识别' : c.ch) + '　' + c.chars + ' 字　标题：' + (c.title || '（无）'));
    out.push(c.text);
    out.push('');
  });

  const dir = path.join(__dirname, 'data', 'retrieval');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, mid + '.chunks.txt');
  fs.writeFileSync(file, out.join('\n'), 'utf8');
  console.log('已导出 ' + chunks.length + ' 块 →  ' + file);
  console.log('用记事本或 VSCode 打开它，对照着填 data/retrieval/' + mid + '.json 里的 labels。');
  await db.pool.end();
})().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
