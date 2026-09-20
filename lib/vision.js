/* 视觉通道：把客户资料里的图形/扫描内容"读懂"成可解题的文字
 *
 * 为什么必须是视觉模型而不是 OCR：
 *   OCR 只能读"像素里的字"，而树形图、邻接矩阵、排序过程图的信息是【结构关系】
 *   ——"谁是谁的孩子"藏在线的连接里，不在文字里。实测对树形图 OCR 输出仅为乱码。
 *   视觉模型能同时做两件事：① 转写图中的文字与公式（比 OCR 更准，能识别上下标）
 *   ② 描述图形的结构，使读者不看图也能据此解题。
 */
'use strict';
const fs = require('fs');
const { callGuarded } = require('./llm');

const DESCRIBE_PROMPT =
  '请分析这张来自复习资料的图片，分两部分输出：\n' +
  '【文字转写】完整转写图中所有文字，包括公式（注意上下标，如 O(log₃n) 不要写成 O(log,n)）、' +
  '代码、选项、标注。若图中无文字则写"无"。\n' +
  '【图形结构】若图中有图形（特别是树、图、链表、矩阵、表格、流程图、排序过程），' +
  '用文字精确描述其结构关系，要求读者不看图也能据此解题。例如二叉树要写清"根结点是谁，' +
  '每个结点的左右孩子是谁"；图要写清顶点与边的连接关系及权值；矩阵要写出各元素值。' +
  '若图中无图形则写"无"。\n\n' +
  '另外用一行输出：【类型】从下列中选择最贴切的：树形图/图结构/矩阵表格/排序过程/代码/文字段落/其他';

/* 单张图片描述（视觉模型） */
/* maxTokens 默认 1000：部分视觉模型（如智谱 GLM-4V）限制 max_tokens ≤ 1024，
 * 传大会直接 400 报错。这里取安全值，需要更长输出可通过 profile.maxTokens 覆盖。 */
async function describeImage(img, profile, { meter, mockMode, maxTokens } = {}) {
  const outTok = maxTokens || profile.maxTokens || 1000;
  if (mockMode || img._mockDesc) {
    /* 演示模式同样走计量，保证成本链路在演示时也被真实执行到 */
    const usage = { in: 900, out: 420, cost: (900 * (profile.priceIn || 1) + 420 * (profile.priceOut || 1)) / 1e6 };
    if (meter) {
      meter.spent += usage.cost; meter.calls++;
      meter.byProfile[profile.label || profile.model] = (meter.byProfile[profile.label || profile.model] || 0) + usage.cost;
    }
    return { id: img.id, page: img.page, desc: mockDescribe(img), usage };
  }
  let dataUrl;
  try {
    const buf = fs.readFileSync(img.file);
    const ext = img.file.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
    dataUrl = 'data:image/' + ext + ';base64,' + buf.toString('base64');
  } catch (e) {
    return { id: img.id, page: img.page, desc: '', error: '读取图片失败: ' + e.message };
  }
  const messages = [
    { role: 'system', content: '你是教材与试卷内容的识图专家，输出准确、克制，不臆测图中不存在的信息。' },
    { role: 'user', content: [
      { type: 'text', text: DESCRIBE_PROMPT },
      { type: 'image_url', image_url: { url: dataUrl } }
    ] }
  ];
  const r = await callGuarded(profile, messages, { meter, maxTokens: outTok, temperature: 0.1 });
  return { id: img.id, page: img.page, desc: r.content.trim(), usage: r.usage };
}

/* 批量识图（逐张，便于进度反馈与失败隔离） */
async function describeAll(images, { profiles, meter, mockMode, onProgress, limit }) {
  const profile = profiles.vision;
  if (!profile || profile.missing || !profile.apiKey) throw new Error('未配置「识图员」岗位的可用 API Key（在管理端「API 池」里配置）');
  const list = limit ? images.slice(0, limit) : images;
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const img = list[i];
    try {
      const r = await describeImage(img, profile, { meter, mockMode });
      out.push(Object.assign({ id: img.id, page: img.page, file: img.file }, r));
    } catch (e) {
      out.push({ id: img.id, page: img.page, file: img.file, desc: '', error: e.message });
    }
    if (onProgress) onProgress(i + 1, list.length, img.id);
  }
  return out;
}

/* 把图形描述汇总成可供出题的资料段落 */
function toMaterialSection(describes) {
  const ok = describes.filter(d => d.desc);
  if (!ok.length) return '';
  return '\n\n=====【资料附图（由图识别得到，出题时可引用）】=====\n' +
    ok.map(d => '【' + d.id + (d.page ? '（原文第' + d.page + '页）' : '') + '】\n' + d.desc).join('\n\n');
}

/* 演示模式：可复现的模拟识图结果（按文件名哈希区分类型，便于演示各类图形） */
function mockDescribe(img) {
  const h = require('./mock').hash(img.id);
  const kinds = ['树形图', '图结构', '矩阵表格', '排序过程'];
  const kind = kinds[h % kinds.length];
  if (kind === '树形图') {
    return '【文字转写】无\n【图形结构】（演示模式模拟输出）二叉树结构：根结点 A；左子树根 B（左孩子 D、右孩子 F）；' +
      '右子树根 C（左孩子 E、右孩子 G，G 的右孩子 H）。\n【类型】树形图';
  }
  if (kind === '图结构') {
    return '【文字转写】无\n【图形结构】（演示模式模拟输出）无向图，5 个顶点 V1~V5；' +
      '边及权值：V1-V2(6)、V1-V3(1)、V1-V4(5)、V2-V3(5)、V3-V4(5)、V3-V5(6)、V4-V5(2)。\n【类型】图结构';
  }
  if (kind === '矩阵表格') {
    return '【文字转写】（演示模式模拟输出）表头：分数段 | 人数占比\n' +
      '90-100 | 12%；80-89 | 25%；70-79 | 30%；60-69 | 22%；60以下 | 11%\n【图形结构】表格共 5 行 2 列，数值如上。\n【类型】矩阵表格';
  }
  return '【文字转写】（演示模式模拟输出）\n第一趟：56、69、55、29、40\n第二趟：55、56、69、29、40\n' +
    '【图形结构】排序过程示意，展示两趟后的序列状态。\n【类型】排序过程';
}

module.exports = { describeImage, describeAll, toMaterialSection, DESCRIBE_PROMPT };
