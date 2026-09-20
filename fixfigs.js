/* 修复历史图片错挂：把 figures.material_id / user_id 按磁盘路径纠正回来
 *
 * 背景（已定位的旧 bug）：
 *   figures 表原来的主键只有 id，而图片 id 形如 p04_img01 —— 只在"单份资料内"唯一。
 *   当第二份资料也解析出 p04_img01 时，INSERT ... ON DUPLICATE KEY UPDATE 只更新了描述与路径，
 *   material_id / user_id 仍停留在最早那份资料上，于是"图归档了、但按 materialId 列不出来"，
 *   题目也就挂不上原图。本次已把主键改成 (material_id, id) 从根上堵住。
 *
 * 本脚本负责把已经错挂的历史行纠正回来。判断依据是磁盘路径本身就编码了归属：
 *   …/uploads/<user_id>/<material_id>/<图片文件>
 * 注意：脚本会在"多条记录被纠正到同一份资料"时按主键冲突报错（说明该资料已有同 id 的图），
 * 这类行会被跳过并列出，交人工确认，绝不静默覆盖。
 *
 * 用法：
 *   node fixfigs.js            # 预演：只列出将被纠正的行，不写库
 *   node fixfigs.js --yes      # 真正执行
 *   node fixfigs.js --yes --all # 连"路径缺失/无法解析"的行一并列出（仍不修改它们）
 */
'use strict';
const path = require('path');
const mysql = require('mysql2/promise');

const DB = {
  host: process.env.QF_DB_HOST || '127.0.0.1',
  port: +(process.env.QF_DB_PORT || 3306),
  user: process.env.QF_DB_USER || 'root',
  password: process.env.QF_DB_PASSWORD == null ? '123456' : process.env.QF_DB_PASSWORD,
  database: process.env.QF_DB_NAME || 'questionforge',
  charset: 'utf8mb4'
};
const APPLY = process.argv.includes('--yes');
const SHOW_ALL = process.argv.includes('--all');

/* 从 …/uploads/<user>/<material>/<file> 里取出归属；两种分隔符都支持 */
function ownerFromPath(p) {
  const norm = String(p || '').replace(/\\/g, '/');
  const parts = norm.split('/').filter(Boolean);
  if (parts.length < 3) return null;
  const file = parts[parts.length - 1];
  const materialId = parts[parts.length - 2];
  const userId = parts[parts.length - 3];
  if (!/^\d+$/.test(userId)) return null;
  if (!/^mat_/.test(materialId)) return null;
  return { userId: +userId, materialId, file };
}

(async () => {
  const pool = await mysql.createPool(DB);
  const [rows] = await pool.query('SELECT id, material_id, user_id, file_path FROM figures');
  const fixable = [], unparsable = [], ok = [];
  for (const r of rows) {
    const o = ownerFromPath(r.file_path);
    if (!o) { unparsable.push(r); continue; }
    if (o.materialId === r.material_id && o.userId === +r.user_id) { ok.push(r); continue; }
    fixable.push({ id: r.id, from: r.material_id + '/' + r.user_id, to: o.materialId + '/' + o.userId, file: r.file_path });
  }
  console.log('数据库: ' + DB.database + '（' + rows.length + ' 行图片）');
  console.log('  ✓ 归属正确      : ' + ok.length);
  console.log('  ✗ 需要纠正      : ' + fixable.length);
  console.log('  ? 路径无法解析  : ' + unparsable.length);
  if (fixable.length) {
    console.log('\n将被纠正的行（前 20 条）：');
    fixable.slice(0, 20).forEach(f => console.log('  #' + f.id + '：' + f.from + ' → ' + f.to + '  (' + path.basename(f.file) + ')'));
    if (fixable.length > 20) console.log('  …共 ' + fixable.length + ' 条');
  }
  if (unparsable.length && SHOW_ALL) {
    console.log('\n路径无法解析（不会改动，请人工核对）：');
    unparsable.slice(0, 20).forEach(r => console.log('  #' + r.id + ' material=' + r.material_id + ' path=' + r.file_path));
  }
  if (!APPLY) {
    console.log('\n这是预演，未修改任何数据。确认无误后执行：node fixfigs.js --yes');
    await pool.end();
    return;
  }
  let done = 0, failed = 0;
  for (const f of fixable) {
    const o = ownerFromPath(f.file);
    try {
      await pool.query('UPDATE figures SET material_id=?, user_id=? WHERE id=? AND file_path=?',
        [o.materialId, o.userId, f.id, f.file]);
      done++;
    } catch (e) {
      failed++;
      console.log('  ✗ #' + f.id + ' 跳过：' + e.code + '（该资料下可能已有同名图片，需人工确认）');
    }
  }
  console.log('\n完成：纠正 ' + done + ' 行' + (failed ? '，跳过 ' + failed + ' 行' : ''));
  await pool.end();
})().catch(e => { console.error('执行失败：' + e.message); process.exit(1); });
