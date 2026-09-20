/* 操作撤回（撤销）：把"用户申请 → 管理员审批 → 执行补偿动作"做成一条可追溯的链路
 *
 * 用户的原始诉求：用户做错了事向我们申请撤销某些行为时，管理员能快速解决。
 *
 * 关键设计：撤销不是"把日志删掉"，而是写一条反向的补偿操作 ——
 *   账务类（充值）        → 反向扣回，并留下一条反向账单（不会出现"账对不上"）
 *   题库类（隐藏/收藏）    → 还原状态位
 *   审核类（采纳/毙掉）    → 题目退回"分歧待审"，人工结论清空
 *   任务类（批准报价）     → 退回"待批准报价"
 *   资料类（删除资料）     → 因为改成了软删除，物理行与图片都还在，直接恢复
 * 原始记录标 reverted=1，并新增一条 scope=admin 的记录指向它（revert_of），
 * 因此"谁在什么时候撤销了谁的操作"永远查得到，不会被抹掉。
 *
 * 只有 meta_json 里有结构化参数的新记录才可撤销；历史记录（无 meta）会被标记为不可撤销，
 * 避免靠猜中文描述去操作数据。
 */
'use strict';
const db = require('./db');
const Store = require('./store');
const { log } = require('./log');

/* 支持撤销的动作 → 中文名（供界面展示；不在此表内的一律视为不可撤销） */
const REVERTIBLE_ACTIONS = {
  recharge: '充值',
  practice_hide: '隐藏题目',
  practice_star: '收藏题目',
  review: '人工审核裁决',
  task_approve: '批准报价',
  material_del: '删除资料'
};
function isRevertible(action) { return !!REVERTIBLE_ACTIONS[action]; }
function labelOf(action) { return REVERTIBLE_ACTIONS[action] || action; }

/* 每个动作的补偿实现。返回一句"撤销了什么"的中文说明。 */
const HANDLERS = {
  /* 充值撤销：把误加的余额扣回。用户已经花掉了就记为欠费（不强行扣成负数）。 */
  async recharge(op, meta) {
    const amount = Math.abs(+(meta && meta.amount) || 0);
    if (!amount) throw new Error('这条充值记录没有金额信息，无法撤销');
    const r = await db.billAndDeduct(op.user_id, {
      kind: 'revert', amount, reason: '撤销充值 #' + op.id,
      idemKey: 'revert:oplog:' + op.id
    });
    if (r.duplicate) return '该充值此前已撤销过';
    return '已扣回误充的 ¥' + amount.toFixed(2) +
      (r.shortfall ? '（余额不足，其中 ¥' + (+r.shortfall).toFixed(2) + ' 记为欠费）' : '');
  },

  /* 隐藏撤销：恢复推送 */
  async practice_hide(op, meta) {
    if (!meta || !meta.qid) throw new Error('缺少题目信息，无法撤销');
    await db.setHidden(op.user_id, meta.qid, false);
    return '题目 ' + meta.qid + ' 已恢复推送';
  },

  /* 收藏撤销：取消收藏（恢复到操作前的状态） */
  async practice_star(op, meta) {
    if (!meta || !meta.qid) throw new Error('缺少题目信息，无法撤销');
    await db.setStarred(op.user_id, meta.qid, meta.starred ? false : true);
    return '题目 ' + meta.qid + ' 的收藏状态已还原';
  },

  /* 审核撤销：题目退回"分歧待审"，人工结论清空 */
  async review(op, meta) {
    if (!meta || !meta.qid) throw new Error('缺少题目信息，无法撤销');
    const [r] = await db.q("UPDATE questions SET status='needs_review', human_json=NULL WHERE id=? AND user_id=?",
      [meta.qid, op.user_id]);
    if (!r.affectedRows) throw new Error('题目不存在或已不属于该用户');
    if (meta.taskId) {
      await db.q("UPDATE tasks SET status='awaiting_review' WHERE id=? AND user_id=? AND status IN ('completed','awaiting_review')",
        [meta.taskId, op.user_id]);
    }
    return '题目 ' + meta.qid + ' 已退回「分歧待审」，人工结论已清空';
  },

  /* 批准报价撤销：任务退回待批准（如果流水线已经跑过，提示需要人工确认） */
  async task_approve(op, meta) {
    if (!meta || !meta.taskId) throw new Error('缺少任务信息，无法撤销');
    const t = await Store.loadTask(meta.taskId);
    if (!t) throw new Error('任务不存在');
    if (t.userId !== op.user_id) throw new Error('任务不属于该用户');
    if (!['approved', 'draft'].includes(t.status)) {
      throw new Error('任务当前状态为「' + t.status + '」，流水线已产生数据，不能直接退回待批准；如需停止请人工处理');
    }
    t.status = 'draft';
    await Store.saveTask(t);
    return '任务「' + t.name + '」已退回「待批准报价」';
  },

  /* 删除资料撤销：软删除恢复（资料正文与图片一直都在，只是被标记为已删除） */
  async material_del(op, meta) {
    if (!meta || !meta.materialId) throw new Error('缺少资料信息，无法撤销');
    const [r] = await db.q('UPDATE materials SET deleted_at=NULL WHERE id=? AND user_id=?', [meta.materialId, op.user_id]);
    if (!r.affectedRows) throw new Error('资料不存在或已被彻底删除');
    return '资料已恢复（含归档图片）';
  }
};

/*
 * 执行撤销。oplog 为 oplogs 表的原始行。
 * 返回 { message }。失败抛错（调用方原样回显给管理员）。
 */
async function revert(oplog, { adminId = null, note = '' } = {}) {
  if (!oplog) throw new Error('操作记录不存在');
  if (oplog.reverted) throw new Error('该操作已经撤销过了');
  const action = oplog.action;
  const handler = HANDLERS[action];
  if (!handler || !isRevertible(action)) {
    throw new Error('「' + labelOf(action) + '」不支持撤销' + (oplog.meta_json ? '' : '（这条是历史记录，没有结构化参数）'));
  }
  let meta = oplog.meta_json;
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch (e) { meta = null; } }
  const message = await handler(oplog, meta || {});
  await db.markOplogReverted(oplog.id);
  await db.logOp(oplog.user_id, 'revert',
    '撤销「' + labelOf(action) + '」#' + oplog.id + '：' + message + (note ? '（' + note + '）' : ''),
    { scope: 'admin', revertOf: oplog.id, meta: { oplogId: oplog.id, action, adminId }, ip: null });
  log.info('oplog_reverted', { oplogId: oplog.id, action, userId: oplog.user_id, adminId, msg: message });
  return { message, action };
}

module.exports = { revert, isRevertible, labelOf, REVERTIBLE_ACTIONS, HANDLERS };
