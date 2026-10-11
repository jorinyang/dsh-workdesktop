/**
 * v1/schema.mjs —— 工作台 v1.0 **数据模型冻结层**（P0-2）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 这一层管什么
 *   四类内容（消息 / 笔记 / 日程 / 待办）的**载荷字段**，外加**统一事件外壳**。
 *   依据：用户 2026-10-12 需求 3.1.3–3.1.6 + 工程图 `工作台.prg` 的字段模型（n53–n57 / n59–n63 / n65–n67 / n71–n73）。
 *
 * 为什么不另建「事件」实体（Q1 裁定）
 *   用户原话：「事件是 4 类内容记录的统一生命周期外壳，不另外建第 5 种实体」。
 *   ⇒ 四类共用同一个外壳，`type` 只是标签；生命周期走
 *     `open → processed → verified → archived`（分析引擎创建 → 前端呈现/交互 → 处理引擎验证 → 归档）。
 *
 * 纪律
 *   · **校验必须能判否**：每个必填字段都有对应的负向对照（见 `selfTest()`），否则校验等于没有。
 *   · **不猜**：字段缺失一律报错，不补默认值；可选字段缺失就如实为空。
 *   · 时间统一用**可排序的本地字符串**：`YYYY-MM-DD` 或 `YYYY-MM-DDTHH:mm`（或空格分隔）。
 *     不引入时区换算 —— 采集端拿到的就是本地时间，转换会引入看不见的偏移。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

export const SCHEMA_VERSION = 'workbench-v1/1';

/** 四类内容（Q1：就是这四类，没有第五种实体） */
export const TYPES = Object.freeze(['message', 'note', 'schedule', 'todo']);

/** 中文标签（前端导航/统计按这个显示；唯一来源，别处不许再写一份） */
export const TYPE_LABELS = Object.freeze({
  message: '消息', note: '笔记', schedule: '日程', todo: '待办',
});

/** 事件生命周期（Q1）：分析引擎创建 → 前端交互 → 处理引擎验证 → 归档 */
export const LIFECYCLE = Object.freeze(['open', 'processed', 'verified', 'archived']);
export const LIFECYCLE_LABELS = Object.freeze({
  open: '待处理', processed: '已处理', verified: '已验证', archived: '已归档',
});

/** 允许的状态迁移（拒绝乱跳：不能从 open 直接到 archived） */
export const LIFECYCLE_TRANSITIONS = Object.freeze({
  open: ['processed'],
  processed: ['verified', 'open'],       // 允许回退（如"撤销已回复"）
  verified: ['archived', 'processed'],
  archived: [],
});

/** 来源渠道（需求 2.x：钉钉 / 飞书 / 微信 / iMessage[Q4] / 手工在前端新增） */
export const CHANNELS = Object.freeze(['dingtalk', 'feishu', 'weixin', 'imessage', 'manual']);
export const CHANNEL_LABELS = Object.freeze({
  dingtalk: '钉钉', feishu: '飞书', weixin: '微信', imessage: 'iMessage', manual: '手工录入',
});

// ── 时间格式 ────────────────────────────────────────────────────────────────────
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/;
const isDate = (s) => typeof s === 'string' && RE_DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00`));
const isDateTime = (s) => typeof s === 'string' && RE_DATETIME.test(s) && !Number.isNaN(Date.parse(s.replace(' ', 'T')));
const isNonEmptyStr = (s) => typeof s === 'string' && s.trim().length > 0;
const isStrArray = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string');

/**
 * 四类载荷的字段规格。
 *   `required` 缺一即错；`optional` 缺失合法（为空）；`check` 给出该字段的判定函数。
 * 字段名与需求原文一一对应，注释里保留需求条目号，便于回查。
 */
export const PAYLOAD_SPEC = Object.freeze({
  // 3.1.3 信息来源 / 发信人 / 信息原文
  message: {
    required: ['channel', 'sender', 'raw'],
    optional: ['senderType', 'conversationId', 'conversationName', 'summary', 'atMe', 'isDirect', 'source', 'modality', 'mediaId', 'fileRef'],
    check: {
      channel: (v) => CHANNELS.includes(v) || `channel 必须是 ${CHANNELS.join('/')} 之一，实得 ${JSON.stringify(v)}`,
      sender: (v) => isNonEmptyStr(v) || 'sender 必须是非空字符串（单聊姓名 / 群聊群组+发言人 / DSH 通道标签）',
      raw: (v) => isNonEmptyStr(v) || 'raw（信息原文）必须是非空字符串',
      senderType: (v) => v === undefined || v === null || ['user', 'bot', 'app', 'self'].includes(v) || `senderType 非法：${JSON.stringify(v)}`,
      atMe: (v) => v === undefined || typeof v === 'boolean' || 'atMe 必须是布尔',
      isDirect: (v) => v === undefined || typeof v === 'boolean' || 'isDirect 必须是布尔',
      // 子通道：同一渠道下的不同来路（邮件 / 听记 / 自语音 / 群聊），供筛选引擎分流用
      source: (v) => v === undefined || ['im', 'mail', 'minutes', 'self-voice', 'doc', 'bitable', 'task', 'calendar', 'kb', 'manual'].includes(v) || `source 非法：${JSON.stringify(v)}`,
      // 模态：原文是文字 / 语音转写 / 图片转文件 / 文件原样（P1-7 的产物标记）
      modality: (v) => v === undefined || ['text', 'voice', 'image', 'video', 'file'].includes(v) || `modality 非法：${JSON.stringify(v)}`,
      // 多媒体：原始 mediaId（筛选引擎后续据此下载/补转写）+ 已落盘的文件引用
      mediaId: (v) => v === undefined || v === null || typeof v === 'string' || 'mediaId 必须是字符串或 null',
      fileRef: (v) => v === undefined || v === null || typeof v === 'string' || 'fileRef 必须是字符串或 null',
    },
  },
  // 3.1.4 笔记主题 / 时间（YYYY-MM-DD）/ 内容（md）
  note: {
    required: ['topic', 'date', 'content_md'],
    optional: ['tags', 'source'],
    check: {
      topic: (v) => isNonEmptyStr(v) || 'topic（笔记主题）必须是非空字符串',
      date: (v) => isDate(v) || `date 必须是 YYYY-MM-DD，实得 ${JSON.stringify(v)}`,
      content_md: (v) => isNonEmptyStr(v) || 'content_md（内容，md 格式）必须是非空字符串',
      tags: (v) => v === undefined || isStrArray(v) || 'tags 必须是字符串数组',
    },
  },
  // 3.1.5 日程主题 / 详情 / 起止时间 / 地点 / 参与人
  schedule: {
    required: ['topic', 'start', 'end'],
    optional: ['detail', 'place', 'participants', 'type', 'source'],
    check: {
      topic: (v) => isNonEmptyStr(v) || 'topic（日程主题）必须是非空字符串',
      start: (v) => (isDate(v) || isDateTime(v)) || `start 必须是 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm，实得 ${JSON.stringify(v)}`,
      end: (v) => (isDate(v) || isDateTime(v)) || `end 必须是 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm，实得 ${JSON.stringify(v)}`,
      participants: (v) => v === undefined || isStrArray(v) || 'participants 必须是字符串数组',
      detail: (v) => v === undefined || typeof v === 'string' || 'detail 必须是字符串',
      place: (v) => v === undefined || typeof v === 'string' || 'place 必须是字符串',
    },
  },
  // 3.1.6 待办任务主题 / 任务详情 / 截止时间 / 发布人 / 执行人
  todo: {
    required: ['topic', 'detail'],
    optional: ['due', 'publisher', 'executor', 'source', 'closeConditions'],
    check: {
      topic: (v) => isNonEmptyStr(v) || 'topic（任务主题）必须是非空字符串',
      detail: (v) => isNonEmptyStr(v) || 'detail（任务详情）必须是非空字符串',
      due: (v) => v === undefined || v === null || v === '' || isDate(v) || isDateTime(v) || `due 必须是 YYYY-MM-DD 或带时间，实得 ${JSON.stringify(v)}`,
      publisher: (v) => v === undefined || typeof v === 'string' || 'publisher 必须是字符串',
      executor: (v) => v === undefined || typeof v === 'string' || 'executor 必须是字符串',
      // Q11：创建时由模型生成"机器可查的关闭条件清单"
      closeConditions: (v) => v === undefined || (Array.isArray(v) && v.every((c) => c && typeof c === 'object' && isNonEmptyStr(c.kind))) || 'closeConditions 必须是 {kind,…} 数组',
    },
  },
});

/** 校验载荷：返回错误数组（空数组 = 合法）。**不抛异常**，把判断权交给调用方。 */
export function validatePayload(type, payload) {
  const errors = [];
  if (!TYPES.includes(type)) return [`未知类型：${JSON.stringify(type)}`];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return [`payload 必须是对象，实得 ${Array.isArray(payload) ? 'array' : typeof payload}`];
  const spec = PAYLOAD_SPEC[type];
  for (const f of spec.required) {
    if (!(f in payload)) { errors.push(`${type}.${f} 缺失（必填）`); continue; }
    const r = spec.check[f] ? spec.check[f](payload[f]) : true;
    if (r !== true) errors.push(r);
  }
  for (const f of spec.optional) {
    const v = payload[f];
    if (v === undefined || v === null) continue;   // 约定：null 与缺省同义（可选字段为空时不报错）
    const r = spec.check[f] ? spec.check[f](v) : true;
    if (r !== true) errors.push(r);
  }
  // 未知字段：不报错但记一处提示（防止上游悄悄塞字段而前端读不到）
  const known = new Set([...spec.required, ...spec.optional]);
  for (const k of Object.keys(payload)) if (!known.has(k)) errors.push(`${type}.${k} 是未登记字段（请先在 PAYLOAD_SPEC 登记，否则前端不会读它）`);
  return errors;
}

const ID_RE = /^[a-z]{3,10}_[0-9a-z]{6,}$/;
export function newId(type, at = new Date()) {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${type.slice(0, 4)}_${at.getTime().toString(36)}${rand}`;
}

/** 统一事件外壳的必填项 */
export const EVENT_REQUIRED = Object.freeze(['_id', '_at', 'type', 'lifecycle', 'origin', 'payload']);

/** 校验完整事件：返回错误数组 */
export function validateEvent(evt) {
  const errors = [];
  if (evt === null || typeof evt !== 'object' || Array.isArray(evt)) return ['事件必须是对象'];
  for (const f of EVENT_REQUIRED) if (!(f in evt) || evt[f] === undefined || evt[f] === null) errors.push(`事件缺 ${f}`);
  if (errors.length) return errors;
  if (!ID_RE.test(evt._id)) errors.push(`_id 形态非法：${JSON.stringify(evt._id)}`);
  if (typeof evt._at !== 'number' || !Number.isFinite(evt._at)) errors.push('_at 必须是毫秒时间戳（数字）');
  if (!TYPES.includes(evt.type)) errors.push(`type 非法：${JSON.stringify(evt.type)}`);
  if (!LIFECYCLE.includes(evt.lifecycle)) errors.push(`lifecycle 非法：${JSON.stringify(evt.lifecycle)}`);
  const o = evt.origin;
  if (o === null || typeof o !== 'object') errors.push('origin 必须是对象');
  else {
    if (!CHANNELS.includes(o.channel)) errors.push(`origin.channel 非法：${JSON.stringify(o.channel)}`);
    if (!isNonEmptyStr(o.sender)) errors.push('origin.sender 必须是非空字符串');
    // 约定：**`null` 与缺省同义**（工厂对"无此项"一律写 null 以保持形状稳定 ⇒ 校验器必须接受 null）
    if (o.raw != null && typeof o.raw !== 'string') errors.push('origin.raw 必须是字符串或 null');
    if (o.messageId != null && typeof o.messageId !== 'string') errors.push('origin.messageId 必须是字符串或 null');
    if (o.conversationId != null && typeof o.conversationId !== 'string') errors.push('origin.conversationId 必须是字符串或 null');
    if (o.senderType != null && !['user', 'bot', 'app', 'self'].includes(o.senderType)) errors.push(`origin.senderType 非法：${JSON.stringify(o.senderType)}`);
  }
  errors.push(...validatePayload(evt.type, evt.payload));
  if (evt.ops !== undefined && !Array.isArray(evt.ops)) errors.push('ops 必须是数组');
  if (evt.deliverables !== undefined && !Array.isArray(evt.deliverables)) errors.push('deliverables 必须是数组');
  if (evt.context != null && (typeof evt.context !== 'object' || Array.isArray(evt.context))) errors.push('context 必须是对象或 null');
  if (evt.analysis != null && (typeof evt.analysis !== 'object' || Array.isArray(evt.analysis))) errors.push('analysis 必须是对象或 null');
  if (evt.closedBy != null && typeof evt.closedBy !== 'string') errors.push('closedBy 必须是字符串或 null');
  if (evt.archiveRef != null && typeof evt.archiveRef !== 'string') errors.push('archiveRef 必须是字符串或 null');
  return errors;
}

/** 幂等键：同一来源的同一条消息只能有一条事件（采集幂等 / 重复投递去重） */
export function originKey(evt) {
  const o = evt.origin ?? {};
  if (isNonEmptyStr(o.messageId)) return `${o.channel}|mid|${o.messageId}`;
  if (isNonEmptyStr(o.conversationId) && evt._at) return `${o.channel}|cid|${o.conversationId}|${evt._at}`;
  return `${o.channel}|id|${evt._id}`;
}

/**
 * 造一条事件。
 * @param {{type:string, payload:object, origin:{channel:string,sender:string,raw?:string,messageId?:string,conversationId?:string,conversationName?:string,senderType?:string}, lifecycle?:string, context?:object, analysis?:object, _at?:number, _id?:string}} o
 * @returns {{ok:true, event:object} | {ok:false, errors:string[]}}
 */
export function makeEvent(o = {}) {
  const at = Number.isFinite(o._at) ? o._at : Date.now();
  const type = o.type;
  const evt = {
    _id: o._id ?? newId(type || 'evt', new Date(at)),
    _at: at,
    type,
    lifecycle: o.lifecycle ?? 'open',
    origin: {
      channel: o.origin?.channel,
      sender: o.origin?.sender,
      senderType: o.origin?.senderType ?? null,
      conversationId: o.origin?.conversationId ?? null,
      conversationName: o.origin?.conversationName ?? null,
      messageId: o.origin?.messageId ?? null,
      raw: o.origin?.raw ?? null,
    },
    payload: o.payload,
    context: o.context ?? { recalled: [] },
    analysis: o.analysis ?? null,
    ops: o.ops ?? [],
    deliverables: o.deliverables ?? [],
    closedBy: null,
    archiveRef: null,
  };
  const errors = validateEvent(evt);
  return errors.length ? { ok: false, errors } : { ok: true, event: evt };
}

/** 状态迁移（处理引擎用）：合法才改，非法返回原因 */
export function transition(evt, to, meta = {}) {
  if (!LIFECYCLE.includes(to)) return { ok: false, why: `未知状态 ${JSON.stringify(to)}` };
  const from = evt.lifecycle;
  if (!LIFECYCLE_TRANSITIONS[from]?.includes(to)) return { ok: false, why: `不允许 ${from} → ${to}` };
  evt.lifecycle = to;
  evt.ops = [...(evt.ops ?? []), { at: Date.now(), op: `lifecycle:${to}`, ...meta }];
  return { ok: true, from, to };
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检（P0-2 的验收：合法样本必过 + 每条必填字段都有负向对照）
// ══════════════════════════════════════════════════════════════════════════════
const VALID_SAMPLES = {
  message: { channel: 'dingtalk', sender: '王芳【示例】', raw: '明天下午三点对一下验收清单', atMe: true, isDirect: true },
  note: { topic: '工作台 v1.0 三大部分', date: '2026-10-12', content_md: '# 采集器\n- 多通道获取信息' },
  schedule: { topic: '示例客户戊验收会', start: '2026-10-13T15:00', end: '2026-10-13T16:00', place: '线上', participants: ['张伟', '王芳'] },
  todo: { topic: '补交 Q3 报表', detail: '把三季度渠道数据补齐并发出', due: '2026-10-15', publisher: '张伟', executor: '月夜' },
};

export function selfTest() {
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });

  // ① 四类合法样本必过
  for (const t of TYPES) {
    const r = makeEvent({ type: t, payload: VALID_SAMPLES[t], origin: { channel: 'dingtalk', sender: 'X' }, _at: 1730000000000 });
    chk(`SCH-1.${t}`, `合法样本通过（${TYPE_LABELS[t]}）`, r.ok, r.ok ? '' : r.errors.join('；'));
  }

  // ② 每条必填字段都有负向对照：删掉它必须报错
  for (const t of TYPES) {
    for (const f of PAYLOAD_SPEC[t].required) {
      const p = { ...VALID_SAMPLES[t] };
      delete p[f];
      const r = makeEvent({ type: t, payload: p, origin: { channel: 'weixin', sender: 'X' } });
      chk(`SCH-2.${t}.${f}`, `删掉必填 ${t}.${f} ⇒ 必红`, !r.ok, r.ok ? '**没有报错（校验恒真）**' : r.errors[0]);
    }
  }

  // ③ 形态类负向对照
  const bad = [
    ['SCH-3.date', '笔记时间写成 2026/10/12 ⇒ 必红', () => makeEvent({ type: 'note', payload: { ...VALID_SAMPLES.note, date: '2026/10/12' }, origin: { channel: 'manual', sender: 'me' } })],
    ['SCH-4.channel', '未知渠道 ⇒ 必红', () => makeEvent({ type: 'message', payload: { ...VALID_SAMPLES.message, channel: 'qq' }, origin: { channel: 'qq', sender: 'X' } })],
    ['SCH-5.type', '未知类型 ⇒ 必红', () => makeEvent({ type: 'email', payload: {}, origin: { channel: 'manual', sender: 'me' } })],
    ['SCH-6.emptyraw', '信息原文为空串 ⇒ 必红', () => makeEvent({ type: 'message', payload: { ...VALID_SAMPLES.message, raw: '   ' }, origin: { channel: 'manual', sender: 'me' } })],
    ['SCH-7.unknownfield', '未登记字段 ⇒ 必红（防上游悄悄塞字段）', () => makeEvent({ type: 'todo', payload: { ...VALID_SAMPLES.todo, prio: '高' }, origin: { channel: 'manual', sender: 'me' } })],
    ['SCH-8.ops', 'ops 不是数组 ⇒ 必红', () => validateEvent({ ...makeEvent({ type: 'note', payload: VALID_SAMPLES.note, origin: { channel: 'manual', sender: 'me' }, _at: 1 }).event, ops: 'x' }).length > 0],
  ];
  for (const [id, desc, fn] of bad) {
    let ok;
    try { const r = fn(); ok = Array.isArray(r) ? r.length > 0 : !r.ok; } catch { ok = true; }
    chk(id, desc, ok, ok ? '' : '**没有报错（校验恒真）**');
  }

  // ④ 生命周期迁移：合法过 + 跳级必拒
  const e1 = makeEvent({ type: 'note', payload: VALID_SAMPLES.note, origin: { channel: 'manual', sender: 'me' }, _at: 1730000000000 }).event;
  chk('SCH-9.trans-ok', 'open → processed 合法', transition(e1, 'processed').ok);
  chk('SCH-10.trans-skip', 'processed → archived 跳级必拒', !transition(e1, 'archived').ok);
  const e2 = makeEvent({ type: 'note', payload: VALID_SAMPLES.note, origin: { channel: 'manual', sender: 'me' }, _at: 1730000000001 }).event;
  e2.lifecycle = 'archived';
  chk('SCH-11.trans-terminal', 'archived 是终态（任何迁移必拒）', !transition(e2, 'open').ok);

  // ⑤ 幂等键：同 messageId 必须同键
  const a = makeEvent({ type: 'message', payload: VALID_SAMPLES.message, origin: { channel: 'feishu', sender: 'X', messageId: 'om_1' }, _at: 1 }).event;
  const b = makeEvent({ type: 'message', payload: VALID_SAMPLES.message, origin: { channel: 'feishu', sender: 'X', messageId: 'om_1' }, _at: 2 }).event;
  chk('SCH-12.idem', '同一 messageId ⇒ 同一幂等键（重复投递可去重）', originKey(a) === originKey(b), `${originKey(a)} vs ${originKey(b)}`);

  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
