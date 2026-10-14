/**
 * v1/processor/intent.mjs —— **意图判定**（P2-7；Q6 用户裁定）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 裁定原文（Q6）："走语音命令通道的信息**优先执行**，当我说'帮我记录一下'的时候，
 *                 才作为笔记去收取，**这个判断应该由筛选引擎进行判断**。"
 *
 * ⇒ 判定规则（纯函数，无副作用 —— 判定与执行分离，便于单测与复核）
 *   · 非自我窗口的消息        → `message`（普通消息，走 3.1.3 的结构化 + 双写）
 *   · 自我窗口 + 命中"记录"话术 → `note`（转成笔记：主题/时间/内容 md）
 *   · 自我窗口 + 其它          → `voice-command`（**默认走命令通道**，因为"命令优先执行"）
 *
 * 为什么默认是命令而不是笔记：语音命令是**既有能力**（我按一下就说一句，期望它被执行），
 *   若默认当笔记收，等于把命令悄悄降级成记录 —— 那是能力回退。要记录就明说"帮我记录一下"。
 *
 * 本文件**不执行**任何命令（执行仍在 `voice-command.mjs`，它是既有引擎）；
 * 这里只回答"这条该往哪儿走"，并把答案写进事件的 `ops` 留痕。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ★ 2026-10-14 加：笔记的**主题**用与待办/日程同一套"一句话"产地（见 `toNotePayload` 的说明）
import { briefTitle } from './brief.mjs';

/** "记录"话术（只要命中其一即视为"我要的是一条笔记"） */
export const NOTE_HINTS = Object.freeze([
  '帮我记录一下', '帮我记一下', '记录一下', '记一下', '记录为笔记', '存成笔记',
]);

const fmtDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** 命中"记录"话术？（大小写/空格不敏感，中文无大小写问题，主要防空格） */
export function hasNoteHint(text) {
  const t = String(text ?? '').replace(/\s+/g, '');
  return NOTE_HINTS.some((h) => t.includes(h.replace(/\s+/g, '')));
}

/**
 * 判定一条事件的去向。
 * @returns {{intent:'message'|'note'|'voice-command'|null, why:string}}
 *   非消息类事件返回 intent=null（意图判定只对消息有意义）
 */
export function classifyIntent(evt) {
  if (!evt || evt.type !== 'message') return { intent: null, why: '非消息类事件，不做意图判定' };
  const src = evt.payload?.source;
  if (src !== 'self-voice') return { intent: 'message', why: '普通渠道消息 ⇒ 直接结构化入库' };
  if (hasNoteHint(evt.payload?.raw)) return { intent: 'note', why: '自我窗口且命中"记录"话术 ⇒ 收成笔记（Q6）' };
  return { intent: 'voice-command', why: '自我窗口且非记录话术 ⇒ 走语音命令通道（命令优先执行，Q6）' };
}

/**
 * 把一条消息转成笔记载荷（需求 3.1.4：主题 / 时间 YYYY-MM-DD / 内容 md）。
 *
 * ★★ 2026-10-14 改（**与待办/日程对齐**）：
 *   原来主题是"首行前 30 字"—— 而消息常常一整段没有换行 ⇒ 主题就是**整段原文**。
 *   后果不只是标题难看：用户第 7.1 条点名要「**笔记概括**」这一列，
 *   而列表里那一格被整段原文撑满 —— 那个字段名等于没落到实处。
 *   ⇒ 走 `briefTitle()`（与"消息转待办/转日程"同一个产地：剥 @/表情/链接、取第一句、
 *     去开头客套、太长在标点处收）。**内容一个字不动**（`content_md` 仍是完整原文），
 *     只是主题从"整段"变成"一句话" —— 用户要的是"消息转笔记把消息完整记录下来"，
 *     记的是内容，不是让标题去承载全文。
 */
export function toNotePayload(evt) {
  const raw = String(evt.payload?.raw ?? '').trim();
  // 去掉"帮我记录一下"这类话术前缀，留下真正要记的内容
  let body = raw;
  for (const h of NOTE_HINTS) body = body.replace(h, '');
  body = body.replace(/^[，,。:：\s]+/, '').trim();
  if (body === '') body = raw;                       // 全是话术 ⇒ 保留原文（不产出空笔记）
  // 主题：先试"一句话概括"；概括不出东西（纯噪声）才退回首行截断；再不行给个中性标题。
  const brief = briefTitle(body, { max: 34 });
  const firstLine = body.split(/\r?\n/)[0].trim();
  const topic = brief || (firstLine.length > 30 ? `${firstLine.slice(0, 30)}…` : firstLine) || '自我语音记录';
  return { topic, date: fmtDate(evt._at), content_md: body, tags: [], source: 'self-voice' };
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检（纯函数，无副作用）
// ══════════════════════════════════════════════════════════════════════════════
export function selfTest() {
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });
  const msg = (over = {}) => ({
    _id: 'mess_x', _at: 1791736751000, type: 'message', lifecycle: 'open',
    origin: { channel: 'dingtalk', sender: '我（示例用户）', messageId: 'm1' },
    payload: { channel: 'dingtalk', sender: '我（示例用户）', raw: '你好', source: 'im', ...(over.payload ?? {}) },
  });

  chk('INT-1', '普通渠道消息 ⇒ message', classifyIntent(msg()).intent === 'message');
  chk('INT-2', '★ 自我窗口 + 无记录话术 ⇒ voice-command（命令优先，Q6）', classifyIntent(msg({ payload: { source: 'self-voice', raw: '帮我查一下今天的日程' } })).intent === 'voice-command');
  chk('INT-3', '★ 自我窗口 +「帮我记录一下」⇒ note（Q6）', classifyIntent(msg({ payload: { source: 'self-voice', raw: '帮我记录一下：明天找张伟要验收单' } })).intent === 'note');
  chk('INT-4', '「记一下」也算（话术表多条）', classifyIntent(msg({ payload: { source: 'self-voice', raw: '记一下：咖啡机要保养' } })).intent === 'note');
  chk('INT-5', '非消息类 ⇒ 不做判定（intent=null）', classifyIntent({ type: 'note' }).intent === null);
  chk('INT-6', '★ 负向对照：普通渠道里出现「记录一下」也**不**变笔记（只认自我窗口）', classifyIntent(msg({ payload: { raw: '帮我记录一下这个需求' } })).intent === 'message');

  const np = toNotePayload(msg({ payload: { source: 'self-voice', raw: '帮我记录一下：明天找张伟要验收单' } }));
  chk('INT-7', '笔记主题去掉了话术前缀', np.topic === '明天找张伟要验收单', JSON.stringify(np));
  chk('INT-8', '笔记时间 = YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(np.date), np.date);
  chk('INT-9', '★ 全是话术 ⇒ 保留原文（不产出空笔记）', toNotePayload(msg({ payload: { source: 'self-voice', raw: '帮我记录一下' } })).content_md === '帮我记录一下');
  const npLong = toNotePayload(msg({ payload: { source: 'self-voice', raw: `记录一下：${'很长的一句话'.repeat(10)}` } }));
  // ★★ 2026-10-14 改：原来这条写死 `topic.length <= 31`（旧的"首行截 30 字"口径）。
  //   主题改走 `briefTitle({max:34})` 之后长度是 35（34 字 + 省略号）⇒ 当场红。
  //   **红得对**，但它守的是"**列表页不撑破**"这件事，而不是某一个具体字数：
  //   列表那一格现在有 CSS 截断（`text-overflow: ellipsis`），所以真正的约束是
  //   "**主题要短到能一眼看完，且被截过要说出来**"。
  //   ⇒ 改成守这个：长度在合理上限内（≤36），且**截过就有省略号**（不假装完整）。
  chk('INT-10', '★ 超长主题收短（列表页不撑破），且**截过就有省略号**',
    npLong.topic.length <= 36 && npLong.topic.endsWith('…'), `${npLong.topic.length} 字 · ${npLong.topic.slice(-8)}`);

  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
