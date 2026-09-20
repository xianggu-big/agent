/* LLM 客户端：多供应商密钥池 + 并发控制 + 失败冷却与自动切换
 *
 * 高并发设计（多用户同时制题时）：
 *  1) 全局并发上限 + 单供应商并发上限（信号量排队，避免把供应商打爆被限流）
 *  2) 同一岗位绑定多个供应商 → 轮换分发，吞吐叠加
 *  3) 某个 Key 报 401/429/5xx → 进入冷却，自动换下一个可用 Key 重试
 *  4) 全部不可用时给出明确错误，而不是静默失败
 * 用量与成本逐次计量，任务级预算硬闸。 */
'use strict';

class BudgetExceeded extends Error {
  constructor(need, have) { super('预算不足：本次调用预计 ¥' + need.toFixed(4) + '，剩余 ¥' + have.toFixed(4)); this.code = 'BUDGET'; }
}

/* ---------- 并发信号量 ---------- */
class Semaphore {
  constructor(limit) { this.limit = Math.max(1, limit); this.active = 0; this.queue = []; }
  setLimit(n) { this.limit = Math.max(1, n); this._drain(); }
  /* 获取槽位：有空间直接占用，否则排队等待被直接唤醒（见 release 的槽位交接） */
  async acquire() {
    if (this.active < this.limit) { this.active++; return; }
    await new Promise(res => this.queue.push(res));
    /* 被 release 唤醒时已把槽位直接交接过来，这里不再自增，避免竞态超发 */
  }
  /* 释放：优先把槽位直接交接给等待者（active 不变），无人等待才真正减一 */
  release() {
    const next = this.queue.shift();
    if (next) { next(); return; }
    this.active = Math.max(0, this.active - 1);
  }
  _drain() {
    while (this.queue.length && this.active < this.limit) {
      const next = this.queue.shift();
      this.active++;
      next();
    }
  }
  get waiting() { return this.queue.length; }
}

/* ---------- 运行状态（供管理端观察） ---------- */
const Runtime = {
  cfg: { global: 8, perProvider: 4, cooldownSec: 30 },
  global: new Semaphore(8),
  perProvider: new Map(),            // providerId -> Semaphore
  cooldown: new Map(),               // providerId -> 解冻时间戳
  cursor: 0,                         // 轮换游标
  stats: new Map()                   // providerId -> {ok, fail, lastErr, lastTs}
};
function configure(cfg) {
  const c = (cfg && cfg.concurrency) || {};
  Runtime.cfg = { global: c.global || 8, perProvider: c.perProvider || 4, cooldownSec: c.cooldownSec == null ? 30 : c.cooldownSec };
  Runtime.global.setLimit(Runtime.cfg.global);
  for (const s of Runtime.perProvider.values()) s.setLimit(Runtime.cfg.perProvider);
}
function semFor(providerId) {
  if (!Runtime.perProvider.has(providerId)) Runtime.perProvider.set(providerId, new Semaphore(Runtime.cfg.perProvider));
  const s = Runtime.perProvider.get(providerId);
  s.setLimit(Runtime.cfg.perProvider);
  return s;
}
function statOf(providerId) {
  if (!Runtime.stats.has(providerId)) Runtime.stats.set(providerId, { ok: 0, fail: 0, lastErr: null, lastTs: null });
  return Runtime.stats.get(providerId);
}
function isCooling(providerId) {
  const until = Runtime.cooldown.get(providerId);
  if (!until) return false;
  if (Date.now() >= until) { Runtime.cooldown.delete(providerId); return false; }
  return true;
}
function coolDown(providerId, seconds) {
  const sec = seconds == null ? Runtime.cfg.cooldownSec : seconds;
  if (sec > 0) Runtime.cooldown.set(providerId, Date.now() + sec * 1000);
}

/* 从候选供应商里挑一个：跳过冷却中的，按轮换分配（并发时天然分散） */
function pickProvider(pool, roleKey) {
  const usable = pool.filter(p => p && p.apiKey && p.enabled !== false);
  if (!usable.length) return null;
  const ready = usable.filter(p => !isCooling(p.id));
  const cands = ready.length ? ready : usable;      // 都在冷却也硬试（总比直接失败好）
  /* 优先挑当前并发最小的（负载均衡），并列时轮换 */
  cands.sort((a, b) => {
    const la = semFor(a.id).active, lb = semFor(b.id).active;
    return la - lb;
  });
  const minLoad = semFor(cands[0].id).active;
  const tied = cands.filter(p => semFor(p.id).active === minLoad);
  const chosen = tied[Runtime.cursor % tied.length];
  Runtime.cursor++;
  return chosen;
}

/* ---------- 用量计量 ---------- */
function newMeter(budgetYuan) {
  return { budgetYuan: budgetYuan || Infinity, spent: 0, byProfile: {}, calls: 0 };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 单次调用（含并发闸 + 供应商切换重试） ---------- */
async function callLLM(profile, messages, opts = {}) {
  const { maxTokens = 3000, temperature = 0.3, meter = null, mock = null, label = '' } = opts;

  if (mock) {
    const r = mock(messages, profile);
    if (r && r.usage && meter) {
      meter.spent += r.usage.cost || 0; meter.calls++;
      meter.byProfile[profile.label || profile.model] = (meter.byProfile[profile.label || profile.model] || 0) + (r.usage.cost || 0);
    }
    return r;
  }

  /* 组装候选供应商：优先用 profile 指定的，失败后换同岗位池里的其它 */
  const role = profile.role || profile.label || 'generator';
  const pool = (opts.pool && opts.pool.length) ? opts.pool : [profile];
  const tried = new Set();

  for (let attempt = 1; attempt <= 4; attempt++) {
    const cands = pool.filter(p => p && p.apiKey && !tried.has(p.id || p.apiKey));
    if (!cands.length) break;
    const provider = pickProvider(cands, role) || cands[0];
    const pid = provider.id || provider.apiKey;
    const base = (provider.baseUrl || profile.baseUrl || '').replace(/\/+$/, '');
    if (!base) throw new Error('未配置 API 地址（Base URL）');
    tried.add(pid);

    await Runtime.global.acquire();
    const psem = semFor(pid);
    await psem.acquire();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    const t0 = Date.now();
    try {
      const resp = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + provider.apiKey },
        body: JSON.stringify({ model: profile.model, messages, temperature, max_tokens: maxTokens }),
        signal: ctrl.signal
      });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        const err = new Error('API ' + resp.status + ': ' + txt.slice(0, 200));
        err.status = resp.status;
        throw err;
      }
      const data = await resp.json();
      const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!content) throw new Error('API 返回空内容');
      const u = data.usage || {};
      const usage = {
        in: u.prompt_tokens || 0, out: u.completion_tokens || 0,
        cost: ((u.prompt_tokens || 0) * (provider.priceIn || 0) + (u.completion_tokens || 0) * (provider.priceOut || 0)) / 1e6,
        ms: Date.now() - t0, provider: provider.name || pid
      };
      const st = statOf(pid); st.ok++; st.lastTs = Date.now(); st.lastErr = null;
      if (meter) {
        meter.spent += usage.cost; meter.calls++;
        meter.byProfile[provider.name || profile.label || profile.model] = (meter.byProfile[provider.name || profile.label || profile.model] || 0) + usage.cost;
      }
      return { content, usage };
    } catch (e) {
      const st = statOf(pid); st.fail++; st.lastErr = e.message.slice(0, 160); st.lastTs = Date.now();
      const isTimeout = e.name === 'AbortError';
      const status = e.status || 0;
      /* 认证/限流/服务端错误 → 该 Key 冷却，换下一个候选继续 */
      const shouldSwitch = status === 401 || status === 403 || status === 429 || status >= 500 || isTimeout;
      if (shouldSwitch) {
        coolDown(pid, status === 429 ? Runtime.cfg.cooldownSec * 2 : Runtime.cfg.cooldownSec);
        const more = pool.some(p => p && p.apiKey && !tried.has(p.id || p.apiKey));
        if (!more) throw (isTimeout ? new Error('请求超时（120s），且没有其它可用供应商') : e);
        await sleep(300 * attempt);
        continue;                       // 换供应商重试
      }
      /* 参数类错误（如 max_tokens 超限）→ 换供应商也没用，直接抛 */
      throw e;
    } finally {
      clearTimeout(timer);
      psem.release();
      Runtime.global.release();
    }
  }
  throw new Error('所有绑定的供应商都不可用（检查 API Key 是否有效、是否被限流）');
}

/* 带预算预检 */
async function callGuarded(profile, messages, opts) {
  const meter = opts.meter;
  if (meter) {
    const worst = ((opts.maxTokens || 3000) * (profile.priceOut || 0)) / 1e6 + 0.002;
    if (meter.spent + worst > meter.budgetYuan) throw new BudgetExceeded(worst, meter.budgetYuan - meter.spent);
  }
  return callLLM(profile, messages, opts);
}

/* 运行状态快照（管理端展示） */
function status(cfg) {
  const providers = (cfg.providers || []).map(p => {
    const st = Runtime.stats.get(p.id) || { ok: 0, fail: 0, lastErr: null, lastTs: null };
    const semi = Runtime.perProvider.get(p.id);
    return {
      id: p.id, name: p.name, baseUrl: p.baseUrl, enabled: p.enabled !== false,
      hasKey: !!p.apiKey, keyMask: p.apiKey ? p.apiKey.slice(0, 6) + '***' + p.apiKey.slice(-4) : '',
      priceIn: p.priceIn, priceOut: p.priceOut,
      ok: st.ok, fail: st.fail, lastErr: st.lastErr, lastTs: st.lastTs,
      active: semi ? semi.active : 0, waiting: semi ? semi.waiting : 0,
      cooling: isCooling(p.id), cooldownSec: isCooling(p.id) ? Math.ceil((Runtime.cooldown.get(p.id) - Date.now()) / 1000) : 0
    };
  });
  return {
    concurrency: Runtime.cfg,
    global: { limit: Runtime.global.limit, active: Runtime.global.active, waiting: Runtime.global.waiting },
    providers
  };
}
/* 手动清除冷却（管理员操作） */
function clearCooldown(providerId) {
  if (providerId) Runtime.cooldown.delete(providerId);
  else Runtime.cooldown.clear();
}

module.exports = { callLLM, callGuarded, newMeter, BudgetExceeded, pickProvider, configure, status, clearCooldown, Semaphore, Runtime };
