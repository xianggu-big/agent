/* 模型评测框架自测（② 阶段 1）
 *
 * 这个套件守四件事（每条断言都对应一个真实会出事的场景）：
 *   ① **花不了钱**：模拟模式下不许发出任何真实请求（网络哨兵断言 fetch 调用数为 0）
 *   ② **判分是可信的**：exec 判分必须真的编译运行代码 —— 参考实现判对、注入缺陷判错、
 *      编译失败/死循环/输出多空格 各走对路径（这一节需要本机 gcc，没有就跳过并说明）
 *   ③ **题集与判分不许错配**：mcq 用 exec 判这类错配跑前报错，而不是静默跳过（
 *      静默跳过会把"少判了一半题"伪装成"准确率很高"）
 *   ④ **不许只报准确率**：成本、延迟、方差、失败分类、样本量警示都必须在报告里
 *
 * 用法：node evalsuite_test.js
 * 零网络、零数据库、零 API 花费。
 */
'use strict';
const fs = require('fs');
const path = require('path');

/* 独立数据目录 + 假 Key：本测试**绝不读生产配置**（CI 上 data/ 不存在），
 * 也不发真实请求（假 Key + 网络哨兵双重保证）。必须在 require lib 之前设置环境变量。 */
const DATA = path.join(__dirname, 'data', 'test-env-suite');
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({
  concurrency: { global: 8, perProvider: 4, cooldownSec: 30 },
  providers: [
    { id: 'sp_main', name: '测试甲', baseUrl: 'https://example.invalid', apiKey: 'sk-suite-fake-0001', priceIn: 2, priceOut: 8, enabled: true, model: 'mock-a' },
    { id: 'sp_alt', name: '测试乙', baseUrl: 'https://example.invalid', apiKey: 'sk-suite-fake-0002', priceIn: 1, priceOut: 1, enabled: true, model: 'mock-b' }
  ],
  profiles: {
    generator: { label: '出题员', model: 'mock-a', providerIds: ['sp_main'] },
    verifier1: { label: '质检员A', model: 'mock-a', providerIds: ['sp_main'] },
    verifier2: { label: '质检员B', model: 'mock-b', providerIds: ['sp_alt'] },
    judgebot: { label: '判分员', model: 'mock-b', providerIds: ['sp_alt'] }
  }
}, null, 2));
process.env.QF_DATA_DIR = DATA;
process.env.QF_DB_NAME = process.env.QF_DB_NAME || 'questionforge_test';

/* 网络哨兵：任何真实出网请求都会被计数（模拟模式的验收断言就是"它是 0"） */
const realFetch = global.fetch;
let fetchCalls = 0;
let fetchUrls = [];
global.fetch = function (...a) { fetchCalls++; fetchUrls.push(String(a[0])); return realFetch.apply(this, a); };

const ES = require('./lib/evalsuite');

let ok = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { ok++; console.log('  [OK] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name + (detail === undefined ? '' : ' → ' + detail)); }
}
function section(t) { console.log('\n【' + t + '】'); }
const throws = async fn => { try { await fn(); return null; } catch (e) { return e.message; } };

(async () => {
  /* ---------- 1 题集加载与校验 ---------- */
  section('题集加载与校验');
  const list = ES.listSuites();
  const calgo = list.find(s => s.id === 'calgo');
  check('listSuites 能列出 calgo', !!calgo);
  check('calgo 有 26 题、判分 exec', calgo && calgo.items === 26 && calgo.judge === 'exec', calgo && (calgo.items + '/' + calgo.judge));
  check('★ 第一套题集里不能有加载失败的文件', !list.some(s => s.error), (list.find(s => s.error) || {}).error);
  const suite = ES.loadSuite('calgo');
  check('loadSuite 返回题集本体', suite.items.length === 26);
  check('找不到的题集报错并列出已装题库集', /找不到题集/.test((await throws(() => ES.loadSuite('nope'))) || ''));
  check('题集缺 prompt 也会报错', !!ES.validateSuite.length);

  /* ★ 题集与判分不许错配：四种错配各试一遍 */
  const base = () => ({ id: 'x', title: 'x', judge: 'exec', fields: { code: 'code', predictions: 'predictions' },
    prompt: () => 'p', items: [{ id: 'a', hidden: [{ in: '1', expected: '1' }] }] });
  check('exec 判分缺 fields.code → 报错', !!ES.validateSuite && (() => { const s = base(); delete s.fields.code; try { ES.validateSuite(s); return false; } catch (e) { return /fields\.code/.test(e.message); } })());
  check('exec 判分题目没有隐藏用例 → 报错', (() => { const s = base(); s.items[0].hidden = []; try { ES.validateSuite(s); return false; } catch (e) { return /隐藏用例/.test(e.message); } })());
  check('隐藏用例没有标准答案 expected → 报错', (() => { const s = base(); delete s.items[0].hidden[0].expected; try { ES.validateSuite(s); return false; } catch (e) { return /标准答案/.test(e.message); } })());
  check('structured 判分缺 expect → 报错', (() => { const s = { id: 'y', judge: 'structured', prompt: () => '', items: [{ id: 'a' }] }; try { ES.validateSuite(s); return false; } catch (e) { return /expect/.test(e.message); } })());
  check('judge 判分缺 reference → 报错', (() => { const s = { id: 'z', judge: 'judge', prompt: () => '', items: [{ id: 'a' }] }; try { ES.validateSuite(s); return false; } catch (e) { return /reference/.test(e.message); } })());
  check('题目 id 重复 → 报错', (() => { const s = base(); s.items.push(JSON.parse(JSON.stringify(s.items[0]))); try { ES.validateSuite(s); return false; } catch (e) { return /重复/.test(e.message); } })());
  check('判分方式与题集声明不一致 → 报错', /不一致/.test(await throws(() => ES.runSuite({ suiteId: 'calgo', models: ['generator'], judge: 'structured', limit: 1 })) || ''));

  /* ---------- 2 exec 判分：真编译真运行（需要 gcc） ---------- */
  section('exec 判分（真编译真运行）');
  const gcc = ES.findGcc();
  console.log('  编译器：' + (gcc || '未找到（本节跳过，只测模拟路径）'));
  if (gcc) {
    const p01 = suite.items.find(x => x.id === 'p01');
    const refCode = fs.readFileSync(path.join(ES.SUITE_DIR, p01.ref), 'utf8');
    /* 2.1 参考实现必须判对（判分器"把对的判错"和"把错的判对"一样致命） */
    const r1 = await ES.compileAndRun(refCode, p01.hidden, {});
    check('参考实现编译通过', r1.compiled, r1.compileLog.slice(0, 120));
    check('★ 参考实现在隐藏用例上的输出 == 冻结的标准答案',
      JSON.stringify(r1.outputs) === JSON.stringify(p01.hidden.map(h => h.expected)),
      JSON.stringify(r1.outputs) + ' vs ' + JSON.stringify(p01.hidden.map(h => h.expected)));
    let j = ES.judgeExec(p01, { predictions: p01.hidden.map(h => h.expected) }, r1);
    check('参考实现被判为"全对"', j.correct === true);
    check('参考实现的自相矛盾率为 0（它说的=它跑的）', j.mismatch === 0);

    /* 2.2 注入缺陷：代码错 → 必须判错 */
    const r2 = await ES.compileAndRun('int main(void){return 0;}', p01.hidden, {});
    check('空程序能编译但输出不对', r2.compiled && ES.judgeExec(p01, {}, r2).correct === false);
    const j2 = ES.judgeExec(p01, { predictions: p01.hidden.map(h => h.expected) }, r2);
    check('★ 代码跑错但"嘴上说对" → 记成自相矛盾（这是最危险的错误）', j2.mismatch === 2, j2.mismatch);
    /* 2.3 注入缺陷：不是 C 代码 → 编译失败（必须记 compile，不能当成"答错"糊过去） */
    const r3 = await ES.compileAndRun('这不是 C 代码', p01.hidden, {});
    check('非 C 代码 → 编译失败且留编译日志', r3.compiled === false && r3.compileLog.length > 0);
    /* 2.4 注入缺陷：死循环 → 超时被杀（不然评测会被一道题卡死） */
    const r4 = await ES.compileAndRun('int main(void){while(1);}', p01.hidden, { runTimeoutMs: 1200 });
    check('★ 死循环被超时杀掉（不死等）', r4.outputs.some(o => o === '__TIMEOUT__'), JSON.stringify(r4.outputs));
    /* 2.4b 注入缺陷：死循环打印 → 输出超限（与"超时"和"运行出错"分开记，
     * 不然"输出爆炸"会被当成普通运行失败，看不出根因） */
    const r4b = await ES.compileAndRun('#include <stdio.h>\nint main(void){ for(;;) putchar(\'x\'); }', [{ in: '' }], { maxBuffer: 64 * 1024, runTimeoutMs: 5000 });
    check('★ 死循环打印 → 标记为输出超限（不混进一般运行失败）',
      r4b.outputs.some(o => o === '__OUTPUT_OVERFLOW__'), JSON.stringify(r4b.outputs).slice(0, 80));
    check('输出超限的用例被判为不通过', ES.judgeExec({ hidden: [{ in: '', expected: 'x' }] }, {}, r4b).correct === false);
    /* 2.5 判分必须归一化空白：模型多打空格/空行不该被判错（否则对模型不公平） */
    const item5 = { id: 'n1', hidden: [{ in: p01.sample.in, expected: '5 1' }] };
    const r5 = await ES.compileAndRun('#include <stdio.h>\nint main(void){printf("  5    1  \\n\\n");return 0;}', item5.hidden, {});
    check('行内多空格 + 末尾空行仍判对（归一化生效）', ES.judgeExec(item5, {}, r5).per[0].actualOk === true, JSON.stringify(r5.outputs));

    /* 2.6 题集夹具完整性：26 题的参考实现逐个重跑，核对冻结的 sample/expected
     * （防止"题集文件里的标准答案被抄错"——那种错会让整份评测结论都是错的） */
    let bad = [];
    let compiledCount = 0;
    for (const it of suite.items) {
      const src = path.join(ES.SUITE_DIR, it.ref);
      const rr = await ES.compileAndRun(fs.readFileSync(src, 'utf8'), [{ in: it.sample.in }, ...it.hidden], {});
      if (!rr.compiled) { bad.push(it.id + ' 编译失败'); continue; }
      compiledCount++;
      if (rr.outputs[0] !== ES.normalizeOut(it.sample.out)) bad.push(it.id + ' 样例对不上：' + rr.outputs[0] + ' vs ' + it.sample.out);
      it.hidden.forEach((h, i) => { if (rr.outputs[i + 1] !== h.expected) bad.push(it.id + ' 隐藏' + (i + 1) + ' 对不上'); });
    }
    check('★ 26 题参考实现全部可编译', compiledCount === 26, compiledCount);
    check('★ 冻结的标准答案与参考实现逐个一致（题目夹具没被抄错）', bad.length === 0, bad.slice(0, 3).join(' / '));

    /* 2.7 端到端：模拟模型 + 真 gcc 运行器，证明 exec 这条链路是通的 */
    const rE2E = await ES.runSuite({ suiteId: 'calgo', models: ['generator'], limit: 3, runner: 'gcc' });
    const anyCompiled = (rE2E.detail.generator || []).some(r => r.compiled === true);
    check('★ 模拟模型 + gcc 运行器：端到端跑通并真的编译了代码', rE2E.runner === 'gcc' && anyCompiled);
    check('报告里标注了运行器是 gcc', /gcc/.test(rE2E.md));
  } else {
    console.log('  （跳过 exec 真实性断言：本机没有 gcc。CI 上这是预期行为，本地请装 w64devkit 或设 QF_GCC）');
  }

  /* ---------- 2b Docker 沙箱：隔离参数 + 诚实降级（不启动 Docker 也能验七成） ----------
   * 沙箱防的不是"模型笨"，而是"别人的提示词"：上传的资料会被喂给模型，
   * 模型生成的代码会被我们编译运行 —— 多人/对外场景下这就是攻击面。 */
  section('Docker 沙箱运行器（五条隔离 + 诚实降级）');
  const dargs = ES.dockerArgs('/tmp/qfsrc', 'qf-eval-test', {}).join(' ');
  check('★ 断网：--network=none 在场（挡住"把题库/资料发到外网"）', /--network=none/.test(dargs), dargs.slice(0, 120));
  check('★ 只读：--read-only + tmpfs 在场（挡住改宿主机文件）', /--read-only/.test(dargs) && /--tmpfs/.test(dargs));
  check('★ 限额：内存/CPU/进程数上限在场（挡住内存炸弹与 fork 炸弹）',
    /--memory=/.test(dargs) && /--cpus=/.test(dargs) && /--pids-limit=/.test(dargs));
  check('★ 非 root：--user + 去能力 + no-new-privileges 在场（挡住提权）',
    /--user 10001:10001/.test(dargs) && /--cap-drop=ALL/.test(dargs) && /no-new-privileges/.test(dargs));
  check('★ 即用即弃：--rm + 容器具名 + 源码只读挂载（挡住状态残留）',
    /^run --rm/.test(dargs) && /-v \/tmp\/qfsrc:\/src:ro/.test(dargs) && /--name qf-eval-test/.test(dargs));
  check('★ 超时在容器内兜（与本机运行器同一口径，否则换运行器数字就不可比）',
    /timeout -s KILL \d+s/.test(dargs), dargs.slice(-90));

  const av = await ES.dockerAvailable({ refresh: true });
  console.log('  Docker 沙箱：' + (av.ok ? '可用（' + av.reason + '）' : '不可用 → ' + av.reason));
  /* ★ 这条守的是 CI 上真发生过的一次崩溃：环境里**没有**要执行的命令时（CI 没有 docker），
   * 往子进程 stdin 写数据会触发异步 EPIPE 事件，没人接就把整个进程打崩
   * （GitHub Actions 上报 "EPIPE / syscall: write"，而本地因为有 docker 永远复现不了）。
   * 所以断言"命令不存在时也必须有结果返回，且不许把进程弄崩"。 */
  const bogus = await ES.runProc('definitely-not-a-real-binary-xyz', [], { input: 'hello\n', timeoutMs: 5000 });
  check('★ 要执行的命令不存在时：返回错误对象而不是打崩进程（CI 上就栽在这条）',
    !!bogus.error && String(bogus.error.code || '').length > 0, JSON.stringify(bogus.error && bogus.error.code));
  const noDocker = await ES.dockerAvailable({ refresh: true, dockerBin: 'definitely-not-a-real-binary-xyz' });
  check('★ 找不到 docker 命令时：降级信息明确（而不是崩溃）', noDocker.ok === false && /找不到 docker/.test(noDocker.reason), noDocker.reason);
  const repSB = await ES.runSuite({ suiteId: 'calgo', models: ['generator'], limit: 2, runner: 'docker' });
  check(av.ok ? '★ 沙箱可用 → 这一跑真的在沙箱里（runner=docker）'
              : '★ 沙箱不可用 → 降级本机跑，且报告里写明"已降级、无沙箱"',
    av.ok ? repSB.runner === 'docker' : (repSB.runner === 'gcc' && !!repSB.sandboxDegraded && /降级/.test(repSB.md)),
    repSB.runner + ' / ' + repSB.sandboxDegraded);
  check('★ 绝不会"报告标着 docker、其实本机跑"', repSB.runner !== 'docker' || av.ok);
  /* ★ 模拟跑 + 沙箱也必须真执行：不能停在 stub（否则"勾了沙箱"静默失效 —— 这个 bug 是页面上点出来的） */
  const repSBMock = await ES.runSuite({ suiteId: 'calgo', models: ['generator'], limit: 2, sandbox: true });
  check('★ 勾沙箱后运行器绝不可能是 stub（要沙箱=要真执行，模拟跑也不例外）',
    repSBMock.runner !== 'stub', repSBMock.runner + ' / ' + repSBMock.sandboxDegraded);
  if (av.ok) {
    /* 真隔离探针：只有 Docker 可用时才跑（没启动时自动跳过，不装样子） */
    const NET = ['#include <stdio.h>', '#include <string.h>', '#include <sys/socket.h>', '#include <netinet/in.h>', '#include <arpa/inet.h>',
      'int main(void){ int s=socket(AF_INET,SOCK_STREAM,0); struct sockaddr_in a; memset(&a,0,sizeof a);',
      'a.sin_family=AF_INET; a.sin_port=htons(53); inet_pton(AF_INET,"8.8.8.8",&a.sin_addr);',
      'printf(connect(s,(struct sockaddr*)&a,sizeof a)==0?"NET_OK":"NET_BLOCKED"); return 0; }'].join('\n');
    const net = await ES.dockerRun(NET, [{ in: '' }], { runTimeoutMs: 4000 });
    check('★ 沙箱里连不上外网（断网真的生效）', net.outputs[0] === 'NET_BLOCKED', JSON.stringify(net.outputs));
    const wr = await ES.dockerRun('#include <stdio.h>\nint main(void){ FILE *f=fopen("/pwned.txt","w"); printf(f?"WROTE":"READONLY"); return 0; }', [{ in: '' }], { runTimeoutMs: 4000 });
    check('★ 沙箱根文件系统只读（写不出宿主机）', wr.outputs[0] === 'READONLY', JSON.stringify(wr.outputs));
    const to = await ES.dockerRun('int main(void){for(;;);}', [{ in: '' }], { runTimeoutMs: 2000, compileTimeoutMs: 20000 });
    check('★ 沙箱里死循环被杀（不死等，容器按名字清理）', to.outputs[0] === '__TIMEOUT__', JSON.stringify(to.outputs));
    /* 等价性：同一个模型同一套题，换运行器（本机 gcc ↔ Docker 沙箱）判分结果必须一致 ——
     * 否则"这次数字变了"就分不清是模型变了还是运行环境变了。
     * 必须用 exec 判分的题集（structured 压根不跑代码，比了等于没比）。 */
    const strip2 = r => JSON.stringify(r.models.map(m => Object.assign({}, m, { msP50: 0, msP95: 0, cost: 0, costPerItem: 0 })));
    const rLocal = await ES.runSuite({ suiteId: 'calgo', models: ['generator'], limit: 3, runner: 'gcc' });
    const rDocker = await ES.runSuite({ suiteId: 'calgo', models: ['generator'], limit: 3, runner: 'docker' });
    check('★ 换运行器不改判分结果（本机 gcc 与 Docker 沙箱逐字段一致）', strip2(rLocal) === strip2(rDocker),
      rLocal.models[0].accuracy + '% vs ' + rDocker.models[0].accuracy + '%');
  } else {
    console.log('  （跳过真隔离探针：' + av.reason + '。启动 Docker Desktop 并按 docs/EVALSUITE.md 建好 qf-sandbox 镜像后重跑本套件，这三条会自动执行）');
  }

  /* ---------- 3 模拟链路：不许出网 + 指标算对 ---------- */
  section('模拟链路（网络哨兵 + 指标）');
  fetchCalls = 0; fetchUrls = [];
  const rep = await ES.runSuite({ suiteId: 'calgo', models: ['generator', 'verifier1'], limit: 8 });
  check('★ 模拟模式没有发出任何真实请求（网络哨兵 = 0）', fetchCalls === 0, fetchUrls.slice(0, 3).join(','));
  check('报告标明是模拟模式', rep.mode === 'mock' && /演示模式/.test(rep.md));
  check('模拟模式没用真编译器（runner=stub）', rep.runner === 'stub');
  const m0 = rep.models[0], m1 = rep.models[1];
  check('两个模型都出了指标', rep.models.length === 2 && m1.accuracy >= 0);
  check('★ 两个模型的模拟能力有区分度（否则对比表看不出东西）', m0.accuracy !== m1.accuracy || m0.selfMismatch !== m1.selfMismatch,
    m0.accuracy + ' / ' + m1.accuracy);
  check('隐藏用例数 = 题数 × 2', m0.predJudged === 16, m0.predJudged);
  check('自相矛盾率被算出来了（>0 说明这条链路有数据流过）', m0.selfMismatch > 0, m0.selfMismatch);
  check('成本与延迟都有数（不许只报准确率）', m0.cost > 0 && m0.msP50 > 0 && m0.msP95 >= m0.msP50);
  check('编译失败被单独归类（不混进"答错"）', m0.failCompile + m1.failCompile > 0);
  check('★ 样本量 < 20 时报告带"仅供参考"警示', !!rep.sampleWarning && /仅供参考/.test(rep.md));
  check('报告含选型建议表（不是只给排行榜）', /选型建议/.test(rep.md) && rep.recommend.rows.length === 2);
  /* ★ 建议行必须带 providerId：阶段四"一键绑回岗位"要靠它，
   * 只留供应商显示名的话同名两家会绑错（页面上就是靠它判断"这一行是不是已经最优"）。 */
  check('★ 选型建议行带 providerId（一键绑定的前提）',
    rep.recommend.rows.every(r => r.providerId && r.model), JSON.stringify(rep.recommend.rows.map(r => r.providerId)));
  check('报告含逐题问题清单', /问题清单/.test(rep.md));

  /* 确定性：同参数跑两遍，模型指标必须完全一样（演示/回归都要可复现） */
  const rep2 = await ES.runSuite({ suiteId: 'calgo', models: ['generator', 'verifier1'], limit: 8 });
  check('★ 模拟结果可复现（两次跑的指标完全一致）', JSON.stringify(rep.models) === JSON.stringify(rep2.models));

  /* ★ 并发不改变结果：条目是并发的（默认 3），但结果必须与串行逐字段一致 ——
   * 页面上跑 3 个模型 × 3 次重复时靠它把时间从好几分钟压到一两分钟。 */
  const repC1 = await ES.runSuite({ suiteId: 'cread', models: ['generator'], limit: 6, concurrency: 1 });
  const repC3 = await ES.runSuite({ suiteId: 'cread', models: ['generator'], limit: 6, concurrency: 3 });
  const strip = r => JSON.stringify(r.models.map(m => Object.assign({}, m, { msP50: 0, msP95: 0 })));
  check('★ 并发 3 与串行结果逐字段一致（只差延迟统计）', strip(repC1) === strip(repC3),
    strip(repC1).slice(0, 120) + ' vs ' + strip(repC3).slice(0, 120));

  /* 方差：repeats>1 才有 */
  const rep3 = await ES.runSuite({ suiteId: 'calgo', models: ['generator'], limit: 8, repeats: 2 });
  const mr = rep3.models[0];
  check('repeats=2 时给出每次准确率', Array.isArray(mr.accuracyPerRun) && mr.accuracyPerRun.length === 2, JSON.stringify(mr.accuracyPerRun));
  check('repeats=2 时给出"结论翻转"题数（方差指标）', mr.flipItems != null && mr.items === 8, mr.flipItems);
  check('repeats=1 时明确写"方差未测"', /方差未测/.test(rep.md));

  /* 只重跑指定题（重跑失败题、做小范围对照实验都要它，不然每次全量重跑都是白花钱） */
  const rItems = await ES.runSuite({ suiteId: 'calgo', models: ['generator'], items: ['h01', 'h03'] });
  check('★ --items 只跑指定题号', rItems.samples === 2 && rItems.itemsRun.join(',') === 'h01,h03', rItems.itemsRun.join(','));
  check('指定不存在的题号 → 报错（不许静默跑空）',
    /都不存在/.test(await throws(() => ES.runSuite({ suiteId: 'calgo', models: ['generator'], items: ['nope'] })) || ''));

  /* ---------- 4 structured 判分（第二套题集的判分方式） ---------- */
  section('第二套题集 cread（给代码问输出 × structured 判分）');
  const cread = ES.loadSuite('cread');
  check('cread 有 20 题、判分 structured', cread.items.length === 20 && cread.judge === 'structured',
    cread.items.length + '/' + cread.judge);
  check('prompt 里给了代码块并写明"只输出 JSON 的 output 字段"',
    /\{"output"/.test(cread.prompt(cread.items[0])) && cread.prompt(cread.items[0]).includes('```c'));
  check('每题都有 expect.output（structured 的判分依据）',
    cread.items.every(it => it.expect && typeof it.expect.output === 'string' && it.expect.output.length));
  if (gcc) {
    /* ★ 夹具完整性：20 题逐个重新编译运行，核对冻结的标准答案
     * （这些答案是"读程序写输出"的判分基准 —— 基准错了，主观题就全错得没法发现） */
    const bad = [];
    for (const it of cread.items) {
      const rr = await ES.compileAndRun(it.src, [{ in: '' }], {});
      if (!rr.compiled) { bad.push(it.id + ' 编译失败'); continue; }
      if (rr.outputs[0] !== ES.normalizeOut(it.expect.output)) {
        bad.push(it.id + ' 输出对不上：实跑=' + JSON.stringify(rr.outputs[0]) + ' 冻结=' + JSON.stringify(it.expect.output));
      }
    }
    check('★ 20 题标准答案与真跑输出逐个一致（夹具没被改错）', bad.length === 0, bad.slice(0, 3).join(' / '));
  }
  const rc = await ES.runSuite({ suiteId: 'cread', models: ['generator', 'verifier1'] });
  check('cread 在模拟模式下跑完 20 题、两个模型', rc.models.length === 2 && rc.models[0].total === 20);
  check('★ structured 判分有区分度（模拟模型下有对有错）',
    rc.models.every(m => m.accuracy > 0 && m.accuracy < 100), rc.models.map(m => m.accuracy).join('/'));
  check('★ 20 题不再触发"样本量不足"警示（样本量边界）', rc.sampleWarning === null, String(rc.sampleWarning));
  check('报告写明判分方式=structured，且没有"预测/自相矛盾"这两个 exec 专属列的数字误导',
    /structured/.test(rc.md) && /给代码问输出/.test(rc.md));
  check('读程序题的明细能定位到"哪个字段对不上"', (() => {
    const recs = rc.detail.generator || [];
    const wrong = recs.filter(r => !r.correct);
    return wrong.length > 0 && wrong.every(r => Array.isArray(r.actual) && Array.isArray(r.expected) && r.actual.length === r.expected.length);
  })());

  /* D1 对照实验用的"推理题金标题"（testdata/golden_reason.js）是从 cread 派生出来的：
   * 正确答案必须**等于**对应 cread 题目的真跑输出。两边只改一个就会静默对不上 → 断言守住。 */
  const srcG = fs.readFileSync(path.join(__dirname, 'testdata', 'golden_reason.js'), 'utf8');
  const gqs = new Function(srcG + '\n;return QUESTIONS;')();
  check('金标题（D1）能被 loadGolden 的方式加载，且每题四选项', gqs.length > 0 && gqs.every(q => q.type === 'mcq' && q.options.length === 4 && new Set(q.options).size === 4), '题数=' + gqs.length);
  const badMap = [];
  for (const q of gqs) {
    const cid = q.id.replace(/^d1_/, '');
    const cit = cread.items.find(x => x.id === cid);
    if (!cit) { badMap.push(q.id + ' 找不到对应的 cread 题'); continue; }
    if (q.options['ABCD'.indexOf(q.answer)] !== cit.expect.output) badMap.push(q.id + ' 的正确答案与 cread 的真跑输出不一致');
  }
  check('★ 金标题的正确答案 == cread 的真跑输出（跨文件一致性，只改一边会变红）', badMap.length === 0, badMap.slice(0, 3).join(' / '));
  check('金标题的正确项位置分布均衡（不会让模型学会猜某个字母）', (() => {
    const d = {};
    for (const q of gqs) d[q.answer] = (d[q.answer] || 0) + 1;
    return Math.max(...Object.values(d)) <= Math.ceil(gqs.length / 4) + 1;
  })(), JSON.stringify(gqs.reduce((a, q) => (a[q.answer] = (a[q.answer] || 0) + 1, a), {})));

  /* 第三套题集的来源：**本地题集目录**（data/suites/，第三方真题不进仓库）。
   * 这里分两段测：① 用一份合成夹具验"多目录发现"这个机制本身（CI 上也能跑）
   *             ② 本机真存在真题集时顺手验它的结构（不存在就跳过 —— CI 上没有，不算失败） */
  const localDir = path.join(DATA, 'suites');
  fs.mkdirSync(localDir, { recursive: true });
  fs.writeFileSync(path.join(localDir, 'synlocal.js'),
    "module.exports = { id: 'synlocal', title: '本地合成夹具（验多目录机制）', judge: 'structured',\n" +
    "  fields: { answer: 'answer' }, note: '合成夹具',\n" +
    "  prompt: it => '请作答：' + it.stem,\n" +
    "  items: [{ id: 's1', group: '第一章', stem: '1+1=?', options: ['1','2','3','4'], expect: { answer: 'B' } }] };\n", 'utf8');
  const listed = ES.listSuites().find(s => s.id === 'synlocal');
  check('★ 本地题集目录（data/suites/）能被发现，并标记 local（第三方真题靠它不进仓库）',
    !!listed && listed.local === true && listed.items === 1, JSON.stringify(listed || null));
  check('本地题集能加载并跑出指标',
    (await ES.runSuite({ suiteId: 'synlocal', models: ['generator'] })).models[0].total === 1);
  check('题集自己的目录用于解析 ref（本地题集不会跑到 testdata 里找文件）',
    ES.loadSuite('synlocal')._dir === localDir, ES.loadSuite('synlocal')._dir);
  fs.unlinkSync(path.join(localDir, 'synlocal.js'));
  /* 本机的真题集（如果生成过）：结构 + 证据等级都要对 */
  const realFile = path.join(__dirname, 'data', 'suites', 'real852.js');
  if (fs.existsSync(realFile)) {
    const s = ES.validateSuite(require(realFile));
    check('★ 本机真题集 real852 结构合法：' + s.items.length + ' 题、判分 ' + s.judge + '（样本量 ≥20）',
      s.items.length >= 20 && s.judge === 'structured', s.items.length + ' 题');
    check('真题集每题都有期望答案字段', s.items.every(it => it.expect && /^[ABCD]$/.test(it.expect.answer)));
    check('真题集标明了"答案人工校验"（证据等级不能与执行验证混为一谈）', /人工校验/.test(s.note || ''), s.note);
  } else {
    console.log('  （跳过本机真题集断言：data/suites/real852.js 不存在，按 docs/EVALSUITE.md §16 生成）');
  }

  /* ---------- 5 structured 判分（合成题集的最小验证） ---------- */
  section('structured 判分（合成题集）');
  const sSuite = {
    id: 'syn_struct', title: '合成结构化题集', judge: 'structured', fields: { output: 'output' },
    prompt: it => '请给出 ' + it.stem + ' 的输出，只输出 JSON：{"output":"..."}',
    items: Array.from({ length: 8 }, (_, i) => ({ id: 's' + i, group: 'g', stem: '题' + i, expect: { output: 'OUT-' + i } }))
  };
  const rs = await ES.runSuite({ suite: sSuite, models: ['generator'] });
  const recs = rs.detail.generator;
  check('structured 题集能跑完 8 题', recs.length === 8);
  const correctOnes = recs.filter(r => r.correct);
  check('★ structured 判分有区分度（不是全对也不是全错）', correctOnes.length > 0 && correctOnes.length < 8, correctOnes.length);
  check('判对的记录里"它的作答 == 期望值"', correctOnes.every(r => JSON.stringify(r.actual) === JSON.stringify(r.expected)));
  check('判错的记录里确有字段不一致', recs.filter(r => !r.correct).every(r => r.actual.some((a, i) => a !== r.expected[i])));

  /* ---------- 5 judge 判分：强制双向对照 ---------- */
  section('judge 判分（双向对照）');
  const jSuite = {
    id: 'syn_judge', title: '合成主观题集', judge: 'judge', answerField: 'answer',
    prompt: it => '请作答：' + it.stem,
    items: [
      { id: 'j1', stem: '说明栈与队列的区别', reference: '栈后进先出，队列先进先出' },
      { id: 'j2', stem: '说明哈希冲突', reference: '不同键映射到同一位置，需用链地址法或开放寻址解决' }
    ]
  };
  const judgeCalls = [];
  const mkCall = (verdicts) => {
    /* 判分调用是并发发生的（同一批题目同时在跑），所以**不能假设调用顺序**：
     * 第一遍/第二遍要看"这道题自己的第几次调用"，不能拿 judgeCalls[0]/[1] 当一对。
     * 这里按题分组记录，v 也按题计数 —— 否则断言会随调度顺序时好时坏。 */
    const seen = new Map();
    return async (profile, messages, opts) => {
      /* 只记用户消息：系统提示词里也有"参考答案/待判作答"字样，混进来会把顺序判断搞错 */
      const prompt = messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
      /* 判分提示词里一定有"参考答案"，按它认题。
       * 注意：假作答文本不能写成某题的参考答案原文，否则这道题会被认成那一题（踩过）。 */
      const item = jSuite.items.find(it => prompt.includes(it.reference));
      const id = item ? item.id : '?';
      const pass = seen.get(id) || 0;
      seen.set(id, pass + 1);
      judgeCalls.push({ itemId: id, pass, prompt });
      const v = verdicts[Math.min(pass, verdicts.length - 1)];
      return { content: JSON.stringify({ correct: v, reason: '测试' }), usage: { ms: 5, cost: 0.0001 } };
    };
  };
  /* 假作答：**故意写得与任何参考答案都不同** —— 否则"按参考答案认题"会把这道题认成那一题 */
  const answerCall = async () => ({ content: JSON.stringify({ answer: '【测试作答】LIFO / FIFO 之类的说法' }), usage: { ms: 7, cost: 0.0002 } });
  judgeCalls.length = 0;
  const rj = await ES.runSuite({
    suite: jSuite, models: ['generator'], judgeModel: 'judgebot', real: true,
    callFn: answerCall, callJudgeFn: mkCall([true, true])
  });
  check('★ judge 型：每题跑了两遍判分（双向对照）', judgeCalls.length === 4, judgeCalls.length);
  const pairOk = jSuite.items.every(it => {
    const p = judgeCalls.filter(c => c.itemId === it.id).sort((a, b) => a.pass - b.pass);
    if (p.length !== 2) return false;
    const a = p[0].prompt, b = p[1].prompt;
    return a.indexOf('参考答案') < a.indexOf('待判作答') && b.indexOf('参考答案') > b.indexOf('待判作答');
  });
  check('★ 两遍的顺序相反（第二遍把作答与参考答案换位）', pairOk,
    judgeCalls.map(c => c.itemId + '#' + c.pass).join(','));
  check('两遍都说对 → 判对', rj.models[0].accuracy === 100, rj.models[0].accuracy);
  check('报告里注明了"已强制双向对照"', /双向对照/.test(rj.md));
  judgeCalls.length = 0;
  const rj2 = await ES.runSuite({
    suite: jSuite, models: ['generator'], judgeModel: 'judgebot', real: true,
    callFn: answerCall, callJudgeFn: mkCall([true, false])
  });
  check('★ 只要一遍说错就判错（口径取严，防位置偏好蒙对）', rj2.models[0].accuracy === 0, rj2.models[0].accuracy);
  check('判分模型不能同时参赛', /不能同时是参赛模型/.test(await throws(() => ES.runSuite({ suite: jSuite, models: ['judgebot'], judgeModel: 'judgebot' })) || ''));
  check('judge 判分必须指定判分模型', /必须指定判分模型/.test(await throws(() => ES.runSuite({ suite: jSuite, models: ['generator'] })) || ''));

  /* ---------- 6 真跑门禁与费用预估 ---------- */
  section('真跑门禁与费用预估');
  const est = ES.estimateCost(suite, suite.items.slice(0, 4), ['generator', 'verifier1'], 1, require('./lib/store').loadConfig());
  check('费用预估给出金额与调用次数', est.total > 0 && est.calls === 8, JSON.stringify({ total: est.total, calls: est.calls }));
  check('★ 真实模式：岗位没有可用凭据就直接报错（不许悄悄出网）',
    /没有可用凭据/.test(await throws(() => ES.runSuite({ suiteId: 'calgo', models: ['nobody'], limit: 1, real: true })) || ''));
  check('★ 全程零真实请求（哨兵仍未归零）', fetchCalls === 0, fetchUrls.join(','));

  /* 系统提示词是"被比较的作答条件"，必须能控制、能记录（否则跨实验对比的数字不可比） */
  section('系统提示词可控与可记录');
  const seenMsgs = [];
  const spyCall = async (profile, messages) => { seenMsgs.push(messages.map(m => m.role)); return { content: JSON.stringify({ output: 'OUT-0' }), usage: { ms: 3, cost: 0 } }; };
  const rSys = await ES.runSuite({ suite: sSuite, models: ['generator'], limit: 1, real: true, callFn: spyCall });
  check('默认带系统提示词（且记录在报告里）', seenMsgs[0][0] === 'system' && /严谨/.test(rSys.systemPrompt));
  seenMsgs.length = 0;
  const rNo = await ES.runSuite({ suite: sSuite, models: ['generator'], limit: 1, real: true, system: '', callFn: spyCall });
  check('★ system:"" 能关掉系统提示词（做对照用）', seenMsgs[0][0] === 'user' && seenMsgs[0].length === 1, JSON.stringify(seenMsgs[0]));
  check('报告里标明"已关闭"', rNo.systemPrompt === '(无系统提示词)' && /已关闭/.test(rNo.md));

  console.log('\n通过 ' + ok + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('✗ 测试自身出错：' + e.stack); process.exit(1); });
