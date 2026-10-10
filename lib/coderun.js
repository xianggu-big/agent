/* 代码运行器：把"跑一段生成的代码"这件事收在一处（两个调用方共用）
 *
 * 为什么要单独一个文件（原来这段在 lib/evalsuite.js 里）：
 *   **两个地方要跑代码** —— ① 评测里跑"模型为解题写的代码"（exec 判分）
 *   ② 质检环节里跑"模型为验算写的代码"（run_code 工具，D1）。两处各写一份必然漂移，
 *   而这份代码正好是**安全敏感**的那份（执行不可信代码），更不能有两套。
 *   lib/tools.js 是纯函数套件（tools_test 不碰数据库），所以这里不能反过来依赖 evalsuite
 *   （它会拉起 store → db）。运行器抽出来，两边都只依赖它。
 *
 * 两种运行方式（runner）：
 *   local  本机 gcc 编译运行：**无沙箱**（只有超时 + 临时目录 + 输出上限）
 *   docker 容器沙箱：断网 / 只读 / 限额 / 非 root / 即用即弃（五条隔离，见 dockerArgs）
 * 没装、没启动、没镜像 → `dockerAvailable()` 返回 ok:false + 原因，由调用方决定怎么办：
 *   · 评测（evalsuite）：降级本机并在报告里写明"无沙箱"（题集里的代码是我们自己的参考实现与模型的解题代码，可接受）
 *   · 质检工具（tools）：**干脆不给这个工具**（跑的是模型临场生成的任意代码，没沙箱就不该跑）
 *   —— 同一条降级原则在两种场景下结论不同，这是有意的，不是不一致。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');

const DEFAULTS = { compileTimeoutMs: 30000, runTimeoutMs: 5000 };
const SANDBOX_IMAGE = process.env.QF_SANDBOX_IMAGE || 'qf-sandbox';
let dockerCache = null;

/* 输出归一化：折叠行内多空格、去行首尾空白、去末尾空行。
 * 判题必须归一化，否则"行末多一个空格"会被误判成错答案，对模型不公平。 */
function normalizeOut(s) {
  return String(s == null ? '' : s)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(l => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n+$/, '')
    .trim();
}

function findGcc() {
  const cands = [process.env.QF_GCC, 'D:\\tools\\w64devkit\\bin\\gcc.exe',
    path.join(os.homedir(), 'tools', 'w64devkit', 'bin', 'gcc.exe'), 'gcc'];
  for (const c of cands) {
    if (!c) continue;
    try {
      const r = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 20000 });
      if (r.status === 0) return c;
    } catch (e) { /* 试下一个 */ }
  }
  return null;
}

/* 异步跑一个子进程：**为什么不能用 spawnSync** ——
 * 它是阻塞的：一个程序跑满 5 秒超时，事件循环就被卡 5 秒，同一批里其它题目的
 * LLM 调用（本该重叠的 I/O）全被堵住。那样"并发 3"只是名义并发。
 * 这里用 spawn + Promise，把等待交回事件循环，并发才是真的。 */
function runProc(cmd, args, opts = {}) {
  return new Promise(resolve => {
    const cap = opts.maxBuffer || (1 << 20);
    let out = '', err = '', timedOut = false, overflow = false, done = false;
    let p;
    try {
      p = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true });
    } catch (e) {
      return resolve({ error: e, out: '', err: '', timedOut, overflow });
    }
    const finish = r => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { timedOut = true; try { p.kill('SIGKILL'); } catch (e) { /* 已退出 */ } }, opts.timeoutMs || 30000);
    p.stdout.on('data', d => {
      if (overflow) return;
      out += d;
      if (out.length > cap) { overflow = true; out = out.slice(0, cap); try { p.kill('SIGKILL'); } catch (e) { /* 已退出 */ } }
    });
    p.stderr.on('data', d => { if (err.length < 8000) err += d; });
    p.on('error', e => finish({ error: e, out, err, timedOut, overflow }));
    p.on('close', code => finish({ code, out, err, timedOut, overflow }));
    try {
      if (opts.input != null) p.stdin.write(opts.input);
      p.stdin.end();
    } catch (e) { /* 子进程可能已退出 */ }
  });
}

/* ---------------- 本机运行器（无沙箱） ---------------- */
async function compileAndRun(code, cases, opts = {}) {
  const gcc = opts.gcc || findGcc();
  if (!gcc) return { compiled: false, compileLog: '未找到 C 编译器（可用环境变量 QF_GCC 指定路径）', outputs: [], runner: 'none', timeouts: 0 };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-evalsuite-'));
  try {
    const src = path.join(tmp, 'model.c');
    const exe = path.join(tmp, 'model.exe');
    fs.writeFileSync(src, String(code == null ? '' : code), 'utf8');
    const c = await runProc(gcc, ['-std=c11', '-O2', '-w', '-o', exe, src],
      { timeoutMs: opts.compileTimeoutMs || DEFAULTS.compileTimeoutMs });
    if (c.code !== 0) {
      /* 把 spawn 自身的错误也带进编译日志：否则"命令没跑起来"（比如忘了 import spawn）
       * 会表现为一条空白的编译失败，看不出根因。 */
      const log = ((c.out || '') + (c.err || '') + (c.error ? ' [spawn 失败: ' + c.error.message + ']' : '')).slice(0, 1200);
      return { compiled: false, compileLog: log, outputs: [], runner: 'gcc', timeouts: 0 };
    }
    let timeouts = 0, overflows = 0;
    const outputs = [];
    for (const cs of cases) {
      const r = await runProc(exe, [], {
        input: cs.in, cwd: tmp,
        timeoutMs: opts.runTimeoutMs || DEFAULTS.runTimeoutMs,
        maxBuffer: opts.maxBuffer || (1 << 20)
      });
      if (r.timedOut) { timeouts++; outputs.push('__TIMEOUT__'); continue; }
      if (r.overflow) { overflows++; outputs.push('__OUTPUT_OVERFLOW__'); continue; }
      outputs.push((r.error || r.code !== 0) ? '__RUNTIME_ERR__' : normalizeOut(r.out));
    }
    return { compiled: true, compileLog: '', outputs, runner: 'gcc', timeouts, overflows };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 临时目录清理失败不影响结果 */ }
  }
}

/* ---------------- Docker 沙箱运行器 ----------------
 * 五条隔离各自的用处（每条都对应一个具体的坏结果，不是为了好看）：
 *   --network=none                代码把题库/资料发到外网（**最关键的一条**）
 *   --read-only + tmpfs           改宿主机文件、往磁盘塞垃圾、留后门文件
 *   --memory/--cpus/--pids-limit  内存炸弹、占满 CPU、fork 炸弹（本机跑 fork 炸弹是真会把机器搞死）
 *   --cap-drop=ALL/非 root        提权
 *   --rm + 一题一容器             状态残留（上一题写的东西被下一题读到）
 * 用法：先 `docker build -f Dockerfile.sandbox -t qf-sandbox <空目录>`（见 docs/EVALSUITE.md §13）。 */

/* 探活：守护进程在不在 + 镜像在不在（两条都满足才算"可用"）。结果缓存，避免每题都探一次。
 * ⚠ 缓存会把"不可用"也记住 —— 中途才启动 Docker 的话要重启服务进程才会生效。 */
async function dockerAvailable(opts = {}) {
  if (dockerCache && !opts.refresh) return dockerCache;
  const bin = opts.dockerBin || process.env.QF_DOCKER || 'docker';
  const v = await runProc(bin, ['--version'], { timeoutMs: 8000 });
  if (v.error || v.code !== 0) { dockerCache = { ok: false, reason: '找不到 docker 命令（未安装或不在 PATH）' }; return dockerCache; }
  const info = await runProc(bin, ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 15000 });
  if (info.error || info.code !== 0) {
    dockerCache = { ok: false, reason: 'Docker 守护进程没在跑（启动 Docker Desktop 后重试）' };
    return dockerCache;
  }
  const img = await runProc(bin, ['image', 'inspect', SANDBOX_IMAGE, '--format', '{{.Id}}'], { timeoutMs: 15000 });
  if (img.error || img.code !== 0) {
    dockerCache = { ok: false, reason: '沙箱镜像 ' + SANDBOX_IMAGE + ' 不存在（先 docker build，见 docs/EVALSUITE.md）' };
    return dockerCache;
  }
  dockerCache = { ok: true, reason: 'docker ' + String(info.out).trim() + ' / 镜像 ' + SANDBOX_IMAGE };
  return dockerCache;
}

/* 纯函数：沙箱的 docker 参数。抽出来是为了让"五条隔离必须在场"能被断言守住 ——
 * 谁哪天把 --network=none 删了，测试立刻变红（不用真的启动 Docker）。 */
function dockerArgs(hostSrcDir, name, opts = {}) {
  const mem = opts.mem || process.env.QF_SANDBOX_MEM || '256m';
  const cpus = opts.cpus || process.env.QF_SANDBOX_CPUS || '0.5';
  const pids = String(opts.pids || process.env.QF_SANDBOX_PIDS || 64);
  /* 运行时限**在容器里**用 timeout 兜（-s KILL：程序自己忽略 SIGTERM 也没用）。
   * 为什么不在外面靠"杀 docker 客户端"：那样超时要等 compile+run 两个预算跑完（35 秒），
   * 而本机运行器是 5 秒 —— 同一个题集换个运行器超时行为就不一样，评测数字就不可比了。 */
  const runSec = Math.max(1, Math.round((opts.runTimeoutMs || DEFAULTS.runTimeoutMs) / 1000));
  return [
    'run', '--rm', '-i',
    '--name', name,
    '--network=none',                       // 断网
    '--read-only', '--tmpfs', '/tmp:rw,size=16m,exec',   // 根只读；编译产物只进 tmpfs
    '--memory=' + mem, '--memory-swap=' + mem, '--cpus=' + cpus, '--pids-limit=' + pids,
    '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--user', opts.user || '10001:10001',
    '-v', hostSrcDir + ':/src:ro',          // 宿主机只读挂载源码
    SANDBOX_IMAGE, 'sh', '-c',
    'gcc -std=c11 -O2 -w -o /tmp/a /src/model.c && exec timeout -s KILL ' + runSec + 's /tmp/a'
  ];
}

async function dockerRun(code, cases, opts = {}) {
  const bin = opts.dockerBin || process.env.QF_DOCKER || 'docker';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-sandbox-'));
  const base = 'qf-eval-' + crypto.randomBytes(5).toString('hex');
  const budget = (opts.compileTimeoutMs || DEFAULTS.compileTimeoutMs) + (opts.runTimeoutMs || DEFAULTS.runTimeoutMs);
  try {
    fs.writeFileSync(path.join(tmp, 'model.c'), String(code == null ? '' : code), 'utf8');
    const outputs = [];
    let compiled = true, compileLog = '', timeouts = 0, overflows = 0;
    for (let i = 0; i < cases.length; i++) {
      const name = base + '-' + i;
      /* 每个用例起一个容器：编译 + 运行都在容器里完成。
       * 为什么不在一次容器里跑完所有用例：那样用例之间会共享同一个进程/文件系统，
       * 与"本机运行器每题一个进程"的语义不一致 —— 评测要的是可比，不是省时间。 */
      const r = await runProc(bin, dockerArgs(tmp, name, opts), { input: cases[i].in, timeoutMs: budget });
      /* 124 = 容器内 timeout 自己报超时；137 = 被 SIGKILL（timeout -s KILL，也可能是 OOM 杀）。
       * 两者都表示"程序没跑完"，与本机运行器的 __TIMEOUT__ 对齐（外面那层 30+5 秒是最后的安全网，
       * 正常路径不会走到它）。139（段错误）等别的非零退出归为运行出错，不混进超时。 */
      if (r.timedOut || r.code === 124 || r.code === 137) {
        /* 杀掉 docker 客户端不一定杀得掉容器 —— 必须按名字清理，否则它会一直在后台跑 */
        await runProc(bin, ['rm', '-f', name], { timeoutMs: 15000 });
        timeouts++; outputs.push('__TIMEOUT__'); continue;
      }
      if (r.overflow) { overflows++; outputs.push('__OUTPUT_OVERFLOW__'); try { await runProc(bin, ['rm', '-f', name], { timeoutMs: 15000 }); } catch (e) { /* 尽力 */ } continue; }
      if (r.code !== 0) {
        const log = ((r.out || '') + (r.err || '')).slice(0, 1200);
        /* 编译+运行合并成一条命令，失败时都非零退出：靠"是不是 gcc 的报错"来区分。
         * 判错方向的代价不对称 —— 宁愿把编译失败误判成运行失败（看得见），
         * 也不要把运行失败误判成编译失败（会让人以为代码编译不过）。 */
        if (/error:|No such file or directory/.test(log)) { compiled = false; compileLog = log; outputs.push(null); continue; }
        outputs.push('__RUNTIME_ERR__');
        continue;
      }
      outputs.push(normalizeOut(r.out));
    }
    if (!compiled) return { compiled: false, compileLog, outputs: [], runner: 'docker', timeouts: 0, overflows: 0 };
    return { compiled: true, compileLog: '', outputs, runner: 'docker', timeouts, overflows };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结果 */ }
  }
}

/* 给质检环节用的便捷入口：跑**一段代码 + 一条输入**，返回一段可以直接喂回模型的文字。
 * 和评测的区别：评测要比对多个用例、要区分编译失败/超时（那些是判分依据）；
 * 这里只需要"把真实结果告诉模型"，所以把三种异常都翻译成人话，并截断长度。 */
async function runOnce(code, stdin, opts = {}) {
  const cap = opts.maxChars || 3000;
  const r = await dockerRun(code, [{ in: String(stdin == null ? '' : stdin) }], {
    runTimeoutMs: opts.runTimeoutMs || 5000, compileTimeoutMs: opts.compileTimeoutMs || 30000
  });
  if (!r.compiled) return { ok: false, kind: 'compile_error', text: ('编译失败：\n' + (r.compileLog || '')).slice(0, cap) };
  const out = r.outputs[0];
  if (out === '__TIMEOUT__') return { ok: false, kind: 'timeout', text: '程序运行超时（' + Math.round((opts.runTimeoutMs || 5000) / 1000) + ' 秒）已被杀掉：可能有死循环。' };
  if (out === '__OUTPUT_OVERFLOW__') return { ok: false, kind: 'overflow', text: '程序输出超过上限（可能是死循环打印），已截断。' };
  if (out === '__RUNTIME_ERR__') return { ok: false, kind: 'runtime_error', text: '程序非正常退出（崩溃或返回了非零退出码）。' };
  return { ok: true, kind: 'ok', text: '程序实际输出：\n' + String(out).slice(0, cap) };
}

module.exports = { compileAndRun, findGcc, normalizeOut, runProc,
  dockerRun, dockerArgs, dockerAvailable, runOnce, SANDBOX_IMAGE, DEFAULTS };
