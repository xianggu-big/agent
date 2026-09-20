/* 结构化日志：JSON Lines，stdout + 按天落地文件
 *
 * 旧实现只有 console.log 的自由文本，出问题时要靠肉眼在终端里翻。
 * 这里每次日志都是一行 JSON（带 ts/level/event/reqId/用户号等字段），
 * 可以直接被 filebeat / loki / jq 消费；同时按天写 data/logs/app-YYYY-MM-DD.log。
 * 仍然零依赖，且默认不改变原有控制台可读性（pretty=1 时输出人类可读行）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };
const MIN = LEVELS[process.env.QF_LOG_LEVEL || 'info'] || 20;
const PRETTY = process.env.QF_LOG_PRETTY === '1' || !process.stdout.isTTY;
let DIR = process.env.QF_LOG_DIR === 'off' ? null : (process.env.QF_LOG_DIR || null);

let stream = null, streamDay = null;
function fileStream() {
  if (!DIR) return null;
  const day = new Date().toISOString().slice(0, 10);
  if (stream && streamDay === day) return stream;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    if (stream) stream.end();
    stream = fs.createWriteStream(path.join(DIR, 'app-' + day + '.log'), { flags: 'a' });
    streamDay = day;
    return stream;
  } catch (e) { return null; }
}

function write(level, event, fields = {}) {
  if ((LEVELS[level] || 20) < MIN) return;
  const rec = Object.assign({ ts: new Date().toISOString(), level, event }, fields);
  let line;
  if (PRETTY) {
    const extras = Object.entries(fields).filter(([k]) => k !== 'msg').map(([k, v]) => k + '=' + (typeof v === 'object' ? JSON.stringify(v) : v)).join(' ');
    line = '[' + rec.ts + '] ' + level.toUpperCase().padEnd(5) + ' ' + event + (fields.msg ? ' — ' + fields.msg : '') + (extras ? '  ' + extras : '');
  } else line = JSON.stringify(rec);
  const out = level === 'error' || level === 'fatal' ? process.stderr : process.stdout;
  out.write(line + '\n');
  const s = fileStream();
  if (s) s.write(JSON.stringify(rec) + '\n');
}
function configure({ dir }) {
  if (dir) { DIR = dir; stream = null; streamDay = null; }
}
const log = {
  debug: (e, f) => write('debug', e, f),
  info: (e, f) => write('info', e, f),
  warn: (e, f) => write('warn', e, f),
  error: (e, f) => write('error', e, f),
  fatal: (e, f) => write('fatal', e, f),
  configure,
  level: () => Object.keys(LEVELS).find(k => LEVELS[k] === MIN)
};

/* ---------- HTTP 访问日志 ---------- */
let seq = 0;
function newReqId() { return 'r' + Date.now().toString(36) + (++seq).toString(36); }
function access(req, res, { reqId, userNo, ms, note }) {
  const level = res.statusCode >= 500 ? 'error' : (res.statusCode >= 400 ? 'warn' : 'info');
  write(level, 'http', {
    reqId, method: req.method, path: (req.url || '').split('?')[0],
    status: res.statusCode, ms, userNo: userNo || undefined, ip: req._ip, bytes: res._bytes, note
  });
}

module.exports = { log, access, newReqId, LOG_LEVELS: LEVELS };
