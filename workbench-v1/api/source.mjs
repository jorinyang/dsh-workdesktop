/**
 * `v1/api/source.mjs` —— **事件来源标注**（用户 2026-10-13 要求）。
 *
 * 用户原话（待办/日程/笔记三页都要这一项）：
 *   「列表的字段需要新增一个来源字段，来源标注需注明是**钉钉/飞书/消息/日程/待办/工作台**（当前页面新建）的来源」
 *   「消息转待办应当概括消息的内容为一句话作为待办标题」「日程转待办应当将日程的标题作为待办标题」
 *   —— 后两句说的是**标题怎么来**，但同样要求"这条是从哪转来的"要看得见。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 判据从哪来（**不猜，逐条对到真数据的字段上**）
 * ══════════════════════════════════════════════════════════════════════════════
 * 实测库里三种落点都能指出源头：
 *   ① `origin.channel`     —— `dingtalk` / `feishu` / `manual`（本页新建时是 manual）
 *   ② `payload.source`     —— `dingtalk-todo` / `dingtalk-calendar` / `manual` …
 *   ③ `origin.messageId`   —— **跨转时服务端写的前缀**最能说明"从哪一类转来的"：
 *        · `from-<消息id>`              ⇒ 从**消息**转来（`messages/:id/convert`）
 *        · `auto-mess_<消息id>-note`    ⇒ 分析引擎自动从**消息**转成**笔记**
 *        · `dd-todo-…` / `dd-cal-…`     ⇒ 钉钉自己的待办/日程通道
 *
 * ⚠️ 一处我特意没动的地方：`origin.channel` **保留原样**（跨转后仍是 `dingtalk`）。
 *   这是有意为之——它记的是"这条业务最终来自哪个平台"，不是"它由谁创建"。
 *   两者都要有：用户要的"来源"是**后者**（消息/日程/待办/工作台），
 *   所以这里**只加一层派生标注**，不去改 `origin`（改了会让"平台维度"的统计失准）。
 */

/** 中文标注（用户点名的六个词，一个不多一个不少） */
export const SOURCE_LABELS = Object.freeze({
  dingtalk: '钉钉',
  feishu: '飞书',
  message: '消息',
  schedule: '日程',
  todo: '待办',
  workbench: '工作台',
});

const CHANNEL_LABEL = { dingtalk: '钉钉', feishu: '飞书', weixin: '微信', imessage: 'iMessage' };

/**
 * 判一条事件"从哪来"。
 * @returns {{key:string,label:string,detail:string}} key 是机器名，label 是给人看的，detail 是可回查的原始依据
 */
export function sourceOf(evt) {
  const ch = String(evt?.origin?.channel ?? '');
  const mid = String(evt?.origin?.messageId ?? '');
  const src = String(evt?.payload?.source ?? '');
  const ops = evt?.ops ?? [];
  const hasOp = (n) => ops.some((o) => String(o?.op ?? '') === n);

  // ① 跨转：`messageId` 的前缀是服务端写的，最可靠
  //    —— 顺序有讲究：先判"从消息/待办/日程转来"，再判平台，否则会被 channel 抢先盖掉
  if (/^from-/.test(mid) || /^auto-mess_/.test(mid) || /-note$/.test(mid) && /^auto-/.test(mid)) {
    return { key: 'message', label: SOURCE_LABELS.message, detail: `origin.messageId=${mid}` };
  }
  if (/^from-todo/.test(mid) || hasOp('to-todo-from-schedule')) {
    return { key: 'todo', label: SOURCE_LABELS.todo, detail: `origin.messageId=${mid}` };
  }
  if (/^from-schedule/.test(mid)) {
    return { key: 'schedule', label: SOURCE_LABELS.schedule, detail: `origin.messageId=${mid}` };
  }

  // ② 本页新建：channel=manual 或 source=manual
  if (ch === 'manual' || src === 'manual') {
    return { key: 'workbench', label: SOURCE_LABELS.workbench, detail: `channel=${ch} · source=${src}` };
  }

  // ③ 平台自己的通道（钉钉/飞书的待办、日程、文档…）
  if (CHANNEL_LABEL[ch]) {
    return { key: ch, label: CHANNEL_LABEL[ch], detail: `channel=${ch} · source=${src}` };
  }
  return { key: 'unknown', label: ch || '未知', detail: `channel=${ch} · source=${src}` };
}
