/* 检索评估：量「按考点检索」到底找得准不准（recall@k）
 *
 * 为什么需要它：如果哪天要把词袋检索换成向量检索，必须先有数据说明"现在不够用"。
 * 没有评估集的"我觉得检索不准"不算理由；有了它，换与不换就是个数字问题。
 *
 * 三步用法（中间那步必须人工做，不能省）：
 *   1) 生成候选标注：node retrieval_eval.js --material <资料id> --gen
 *        → 它会分块、拉出考点、按"块里出现了考点名"生成**候选**标注，
 *          并把每块的内容摘要打印出来供你核对。
 *   2) 人工核对：打开 data/retrieval/<资料id>.json，把 labels 改成你认可的答案，
 *      并把 _reviewed 改成 true。
 *      ⚠ 这一步不能跳：候选标注是脚本按关键词猜的，跟被测方法是同一套逻辑，
 *        直接用会形成循环论证（自己考自己，必得高分）。
 *   3) 跑评估：node retrieval_eval.js --material <资料id>
 *        → 输出 recall@1/3/5/8、命中率、MRR。
 *
 * 辅助：node retrieval_eval.js --list        列出资料库里的资料
 */
'use strict';
const fs = require('fs');
const path = require('path');
const db = require('./lib/db');
const Text = require('./lib/text');

const DIR = path.join(__dirname, 'data', 'retrieval');
const KS = [1, 3, 5, 8];                 // 看前 1/3/5/8 块里能不能覆盖标注答案
const BUDGET = +(process.env.QF_CONTEXT_BUDGET || 8000);   // 与出题时一致

function arg(name) { const i = process.argv.indexOf('--' + name); return i < 0 ? null : (process.argv[i + 1] || true); }
const fileOf = mid => path.join(DIR, mid + '.json');
const kpsOf = mid => path.join(DIR, mid + '.kps.txt');
/* 手写考点清单（每行一个）。存在就用它，否则回退到"已抽取的知识点 / 章节标题"。
 * 为什么需要它：章节标题（"一、填空："）不是考点，拿它当查询词评估没意义。 */
function manualKPs(mid) {
  try {
    return fs.readFileSync(kpsOf(mid), 'utf8').split('\n')
      .map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  } catch (e) { return []; }
}

async function main() {
  await db.init();
  if (arg('list')) {
    const [ms] = await db.q('SELECT id,name,chars FROM materials WHERE deleted_at IS NULL ORDER BY chars DESC');
    console.log('资料库（按字数倒序）：');
    for (const m of ms) console.log('  ' + m.id + '  ' + String(m.chars).padStart(6) + ' 字  ' + m.name);
    await db.pool.end(); return;
  }

  const mid = arg('material');
  if (!mid) { console.log('用法：--list ｜ --material <id> [--gen]'); await db.pool.end(); process.exit(1); }

  const [rows] = await db.q('SELECT id,name,text FROM materials WHERE id=? AND deleted_at IS NULL', [mid]);
  if (!rows.length) { console.log('✗ 找不到资料 ' + mid); await db.pool.end(); process.exit(1); }
  const mat = rows[0];
  const chunks = Text.splitChunks(mat.text || '');
  console.log('资料：' + mat.name + '（' + (mat.text || '').length + ' 字 → ' + chunks.length + ' 块）');

  /* ---------- 步骤 1：生成候选标注 ---------- */
  if (arg('gen')) {
    /* 考点来源：优先用该资料已抽取的知识点；没有再退回章节标题 */
    const [kps] = await db.q('SELECT name,ch FROM kps WHERE material_id=? ORDER BY ch,id', [mid]);
    const manual = manualKPs(mid);
    let names = manual.length ? manual : kps.map(k => k.name);
    if (!manual.length && !names.length) {
      names = [...new Set(chunks.map(c => c.title).filter(Boolean))];
      console.log('（该资料没有抽取过知识点，改用章节标题做考点）');
    }
    if (!manual.length) {
      /* 写出样板文件，让用户把"标题"改成"真考点" —— 这步必须人工，脚本猜不出来 */
      fs.mkdirSync(DIR, { recursive: true });
      /* 换行符用 String.fromCharCode(10) 拼：这个脚本是多次补丁拼起来的，
       * 直接写反斜杠 n 在跨工具传递时会被吃掉，已经踩过三次。 */
      const NLc = String.fromCharCode(10);
      fs.writeFileSync(kpsOf(mid),
        ['# 考点清单：每行一个考点，以 # 开头的行会被忽略。',
         '# 下面这些是脚本猜的候选（多半是章节/题型标题），请改成真正的考点名，例如：',
         '#   二叉树的遍历 / 哈夫曼树的构造 / 图的深度优先搜索 / 循环队列的判空判满',
         '# 改完重跑一次 --gen（标注会按新考点重算），再人工核对 labels。',
         ...names].join(NLc) + NLc, 'utf8');
      console.log('');
      console.log('★ 已写出考点清单样板：' + kpsOf(mid));
      console.log('   请把它改成真正的考点名（删掉"一、填空："这类标题），然后重跑一次 --gen。');
    }
    const chOf = {}; kps.forEach(k => { chOf[k.name] = k.ch; });

    const labels = {}; const preview = [];
    for (const name of names) {
      const hit = chunks.filter(c => c.text.includes(name) || (name.length >= 3 && c.text.includes(name.slice(0, 3))))
                        .map(c => c.i);
      labels[name] = hit;
      preview.push({ name: name, ch: chOf[name] || null, cand: hit });
    }
    fs.mkdirSync(DIR, { recursive: true });
    /* ★ 不许静默覆盖手填的标注（2026-10-10 修，起因：用户手填 labels 后再跑 --gen，成果被整个擦掉）。
     * 规则：① 先备份成 .bak；② 已核对过（_reviewed=true）就**拒绝覆盖**，要重来必须先删掉 json。 */
    if (fs.existsSync(fileOf(mid))) {
      let old = null;
      try { old = JSON.parse(fs.readFileSync(fileOf(mid), 'utf8')); } catch (e) { old = null; }
      fs.copyFileSync(fileOf(mid), fileOf(mid) + '.bak');
      if (old && old._reviewed) {
        console.log('');
        console.log('✗ 已存在人工核对过的标注文件（_reviewed=true），拒绝覆盖以免擦掉你的工作。');
        console.log('  已备份当前文件到 ' + fileOf(mid) + '.bak');
        console.log('  确实要按新考点重建：先删掉（或改名）该 json，再重跑 --gen。');
        await db.pool.end(); return;
      }
      if (old && old.labels) {
        let kept = 0;
        for (const k of Object.keys(labels)) if (old.labels[k] && old.labels[k].length) { labels[k] = old.labels[k]; kept++; }
        if (kept) console.log('（已保留你之前填过的 ' + kept + ' 个考点标注；备份在 .bak）');
      }
    }
    fs.writeFileSync(fileOf(mid), JSON.stringify({
      materialId: mid, materialName: mat.name, chunks: chunks.length, budgetChars: BUDGET,
      _reviewed: false,
      _howto: '把 labels 改成你认可的答案（考点 → 应该取材的块下标数组）；核对完把 _reviewed 改成 true 再跑评估',
      labels: labels
    }, null, 2), 'utf8');

    console.log('\n候选标注已写入 ' + fileOf(mid) + '（考点 ' + names.length + ' 个）');
    console.log('\n===== 逐块摘要（供你核对：这一块到底在讲什么）=====');
    chunks.forEach(c => {
      const head = c.text.replace(/\s+/g, ' ').slice(0, 78);
      console.log('  块' + String(c.i).padStart(2) + ' [ch' + (c.ch === null ? '-' : c.ch) + '] ' + String(c.chars).padStart(4) + '字  ' + head);
    });
    console.log('\n===== 每个考点的候选命中块 =====');
    preview.forEach(p => console.log('  ' + p.name + '  → 块 [' + p.cand.join(', ') + ']' +
      (p.cand.length === 0 ? '  ⚠ 一块都没命中（这个考点可能很难检索，重点看它）' : '')));
    console.log('\n下一步：编辑上面的 json 核对 labels（并把 _reviewed 改成 true），然后不带 --gen 再跑一次。');
    await db.pool.end(); return;
  }

  /* ---------- 步骤 3：跑评估 ---------- */
  if (!fs.existsSync(fileOf(mid))) { console.log('✗ 还没有标注文件，请先加 --gen 生成'); await db.pool.end(); process.exit(1); }
  const lab = JSON.parse(fs.readFileSync(fileOf(mid), 'utf8'));
  if (!lab._reviewed) {
    console.log('\n⚠⚠ 标注文件里的 _reviewed 还是 false —— 说明还没人工核对过。');
    console.log('   候选标注是脚本按关键词猜的，跟被测方法同一套逻辑，直接跑等于"自己考自己"，分数必然虚高。');
    console.log('   请先核对 ' + fileOf(mid) + ' 里的 labels，并把 _reviewed 改成 true。\n');
  }
  const manual = manualKPs(mid);
  if (manual.length && manual.join('|') !== Object.keys(lab.labels).join('|')) {
    console.log('⚠ 考点清单 ' + kpsOf(mid) + ' 与标注文件里的考点不一致，请先重跑 --gen 重建标注。');
  }
  const names = Object.keys(lab.labels);
  if (!names.length) { console.log('✗ 标注里没有考点'); await db.pool.end(); process.exit(1); }

  const sum = { recall: {}, hit: 0, mrr: 0, n: 0, empty: 0 };
  KS.forEach(k => { sum.recall[k] = 0; });
  console.log('\n考点'.padEnd(26) + ['r@1', 'r@3', 'r@5', 'r@8', '命中', '首个命中排名'].map(s => s.padStart(7)).join(''));
  console.log('-'.repeat(78));

  for (const name of names) {
    const gold = (lab.labels[name] || []).filter(i => i >= 0 && i < chunks.length);
    /* 与出题时的调用完全一致（同样的 query / wantCh / 预算），否则量的不是同一条路径 */
    const wantCh = chunks.length ? null : null;
    /* ⚠ 关键：selectChunks 返回的 picked 是**按文档顺序**排的（为了拼提示词读起来连贯），
     * 不是按相关性排的。所以不能直接 slice(0,k) 当 top-k —— 那算出来是
     * "文档位置靠前的块里有没有金标"，跟 recall@k 根本不是一回事（2026-10-10 修，之前几轮的 recall 列全不可信）。
     * 这里自己按打分重排，才得到真正的 top-k。 */
    const qt = Text.termSet(name);
    const pickedRaw = Text.selectChunks(chunks, { query: name, wantCh: wantCh, used: new Set(), budgetChars: BUDGET }).picked;
    const picked = pickedRaw.map(i => ({ i: i, s: Text.scoreChunk(chunks[i], name, qt, wantCh) }))
      .sort((a, b) => b.s - a.s).map(x => x.i);
    if (!gold.length) { sum.empty++; console.log(name.slice(0, 24).padEnd(26) + '（无标注，跳过）'); continue; }
    const row = [];
    for (const k of KS) {
      const top = picked.slice(0, k);
      const got = gold.filter(g => top.includes(g)).length;
      const r = got / gold.length;
      sum.recall[k] += r; row.push(r.toFixed(2));
    }
    const firstIdx = picked.findIndex(p => gold.includes(p));
    const hit = firstIdx >= 0 ? 1 : 0;
    sum.hit += hit; sum.mrr += hit ? 1 / (firstIdx + 1) : 0; sum.n++;
    console.log(name.slice(0, 24).padEnd(26) + row.map(x => x.padStart(7)).join('') +
      String(hit ? '✓' : '✗').padStart(8) + String(firstIdx >= 0 ? '#' + (firstIdx + 1) : '-').padStart(12));
  }

  const n = sum.n || 1;
  console.log('-'.repeat(78));
  console.log('平均：' + KS.map(k => 'recall@' + k + '=' + (sum.recall[k] / n * 100).toFixed(1) + '%').join('  '));
  console.log('至少命中一块的比例 ' + (sum.hit / n * 100).toFixed(1) + '%   MRR ' + (sum.mrr / n).toFixed(3) +
    '   （参与评估 ' + sum.n + ' 个考点' + (sum.empty ? '，' + sum.empty + ' 个无标注被跳过' : '') + '）');
  console.log('\n怎么读：');
  console.log('  · recall@5 ≥ 80% 且"至少命中一块"=100% → 词袋检索够用，不需要换向量检索');
  console.log('  · 有考点 recall 一直为 0（上面 ✗ 那些）→ 先看是"标注写错"还是"检索真的找不到"；');
  console.log('    若确实是找不到（比如题干用词和资料用词完全不同）→ 这就是该上向量/查询改写的证据');
  await db.pool.end();
}
main().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
