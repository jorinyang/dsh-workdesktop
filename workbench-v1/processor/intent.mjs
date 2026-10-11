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

/** 把一条自我语音消息转成笔记载荷（需求 3.1.4：主题 / 时间 YYYY-MM-DD / 内容 md） */
export function toNotePayload(evt) {
  const raw = String(evt.payload?.raw ?? '').trim();
  // 去掉"帮我记录一下"这类话术前缀，留下真正要记的内容
  let body = raw;
  for (const h of NOTE_HINTS) body = body.replace(h, '');
  body = body.replace(/^[，,。:：\s]+/, '').trim();
  if (body === '') body = raw;                       // 全是话术 ⇒ 保留原文（不产出空笔记）
  const firstLine = body.split(/\r?\n/)[0].trim();
  const topic = firstLine.length > 30 ? `${firstLine.slice(0, 30)}…` : (firstLine || '自我语音记录');
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
  chk('INT-10', '超长主题被截断（列表页不撑破）', npLong.topic.length <= 31, `${npLong.topic.length}`);

  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
