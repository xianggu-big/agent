/* 轻量限流：固定窗口计数（内存实现，单实例够用；多实例部署应换成 Redis 或在网关层做）
 *
 * 为什么必须有：登录/注册接口没有限流时，攻击者可以离线字典暴力跑账号密码；
 * 上传/解析/识图/需求解析这些"花钱且吃 CPU"的接口没有限流时，一个脚本就能把额度烧光。
 */
'use strict';

const buckets = new Map();   // key -> { n, resetAt }

/* 返回 { ok, remaining, retryAfter }；limit 为窗口内允许次数 */
function hit(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now >= b.resetAt) { b = { n: 0, resetAt: now + windowMs }; buckets.set(key, b); }
  b.n++;
  if (b.n > limit) {
    return { ok: false, remaining: 0, retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
  }
  return { ok: true, remaining: limit - b.n, retryAfter: 0 };
}
/* 只查看不计数（用于页面提示） */
function peek(key) {
  const b = buckets.get(key);
  if (!b || Date.now() >= b.resetAt) return 0;
  return b.n;
}
function reset(key) { buckets.delete(key); }

/* 定期清理过期窗口，防止 Map 无限增长 */
const cleaner = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now >= b.resetAt) buckets.delete(k);
}, 60000);
if (cleaner.unref) cleaner.unref();

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return (req.socket && (req.socket.remoteAddress || '')) || 'unknown';
}

/* 预置策略：按"接口类别"给不同额度 */
const POLICY = {
  login: { limit: 10, windowMs: 60000 },        // 同一 IP + 用户名，每分钟 10 次
  register: { limit: 5, windowMs: 3600000 },    // 同一 IP，每小时 5 个账号
  upload: { limit: 30, windowMs: 60000 },       // 解析/上传
  llm: { limit: 60, windowMs: 60000 },          // 走模型且计费的接口
  write: { limit: 240, windowMs: 60000 }        // 一般写操作
};

function check(kind, key) {
  /* 自动化测试需要可复现地连打接口（例如连续注册多个测试账号），
   * 因此允许用 QF_RATELIMIT=off 关闭限流 —— 只作用于测试进程，与 QF_MOCK 同一套约定。 */
  if (process.env.QF_RATELIMIT === 'off') return { ok: true, remaining: 1, retryAfter: 0, disabled: true };
  const p = POLICY[kind] || POLICY.write;
  return hit(kind + ':' + key, p.limit, p.windowMs);
}

module.exports = { hit, peek, reset, check, clientIp, POLICY, buckets };
