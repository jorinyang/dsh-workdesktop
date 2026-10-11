/**
 * v1/processor/kb.mjs —— **知识库写入层**（P2-1/P2-3 的落盘侧）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 为什么消息要**双写**（Q8 用户裁定："消息存储的时候，双写同时保存 JSON 和 MD"）
 *   · JSONL 台账 = **机器真相源**：字段完整、按 originKey 可核对、供程序消费；
 *   · MD 摘要   = **人读 + 向量化载体**：向量库当前**整类排除 `.json`**（实测配置），
 *                 所以只写 JSON 的话，消息永远不会进 RAG —— 分析引擎就召不回上下文。
 *   ⇒ 一份内容两种形态，各司其职，缺一不可。
 *
 * 目录规则（规划 §4.2，用户 Q7 已采纳）
 *   · 命中客户/域 ⇒ `Work/<客户目录>/Input/Inflow/<YYYY-MM>/…`
 *   · 未命中     ⇒ `Other/Inflow/<类别>/<YYYY-MM>/…`
 *   当前先实现"未命中"这一支（客户匹配需要 `clients.yml` 的别名语义，留到有真实样本时接）；
 *   `resolveDir()` 已经把分支写死，接入时只改这一处。
 *
 * 幂等
 *   KB 里是**追加型文本**，重跑无法靠"再写一次"去重 ⇒ 用一份**已写索引**
 *   （`_meta/out/v1/kb-index.json`，原子写）记住"这条事件已经写过哪些形态"。
 *   索引写不进去时**如实报错**（宁可下轮重试并偶发重复，也不假装写成功）。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KB_ROOT as ROOT } from '../paths.mjs';   // 路径收口（见 paths.mjs 顶部说明：原先按本文件深度往上数，包一挪就错）

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 知识库根（测试可覆盖，避免污染真库） */
export function kbRoot() { return process.env.WB_V1_KB_ROOT || ROOT; }
/** 运行态目录（索引等） */
export function v1Out() { return process.env.WB_V1_OUT || path.join(ROOT, '_meta', 'out', 'v1'); }
export function indexFile() { return path.join(v1Out(), 'kb-index.json'); }

/** 类别 → 目录（未命中客户时的落点） */
export const KIND_DIRS = Object.freeze({
  message: 'Other/Inflow/消息',
  note: 'Other/Inflow/笔记',
  schedule: 'Other/Inflow/日程',
  todo: 'Other/Inflow/待办',
  file: 'Other/Inflow/文件',
  link: 'Other/Inflow/链接',
  archive: 'Other/Inflow/产出物',
});

export const ym = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

/**
 * 解析落点目录（相对知识库根）。
 * @param {{kind:string, client?:string|null, clientDir?:string|null}} o
 *   `clientDir` 命中客户时给（如 "示例客户乙" 对应 Work 下的目录名）
 */
export function resolveDir({ kind, client = null, clientDir = null }) {
  if (!KIND_DIRS[kind]) throw new Error(`未知类别 ${JSON.stringify(kind)}（KIND_DIRS 里没有）`);
  if (clientDir) return `Work/${clientDir}/Input/Inflow`;      // 命中客户 ⇒ 进客户目录
  return KIND_DIRS[kind];                                       // 未命中 ⇒ 归到 Other/Inflow/<类别>
  // client（显示名）暂未参与路径计算：目录名以 clientDir 为准，避免"客户名≠目录名"时猜错
}

export function loadIndex() {
  try { return JSON.parse(fs.readFileSync(indexFile(), 'utf8')) ?? {}; } catch { return {}; }
}
export function saveIndex(idx) {
  const f = indexFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, f);
}

export function ensureDir(rel) {
  const abs = path.join(kbRoot(), rel);
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

/** 追加一行 JSONL（原子性由 appendFileSync 保证；一行一条） */
export function appendJsonl(rel, obj) {
  const abs = path.join(kbRoot(), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.appendFileSync(abs, JSON.stringify(obj) + '\n', 'utf8');
  return abs;
}

/** 追加一段 MD（人为可读的小节） */
export function appendMd(rel, section) {
  const abs = path.join(kbRoot(), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.appendFileSync(abs, section, 'utf8');
  return abs;
}

const esc = (s) => String(s ?? '').replace(/\r?\n/g, ' ').trim();
const CH_LABEL = { dingtalk: '钉钉', feishu: '飞书', weixin: '微信', imessage: 'iMessage', manual: '手工' };
const stamp = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** 消息 → JSONL 记录（需求 3.1.3 的三个字段 + 溯源字段） */
export function messageRecord(evt) {
  return {
    id: evt._id,
    type: 'message',
    at: new Date(evt._at).toISOString(),
    channel: evt.payload.channel,                 // 信息来源（钉钉/飞书/微信）
    sender: evt.payload.sender,                   // 发信人（单聊姓名 / 群聊群组+发言人 / DSH 通道标签）
    raw: evt.payload.raw,                         // 信息原文
    summary: evt.payload.summary ?? null,
    source: evt.payload.source ?? null,
    modality: evt.payload.modality ?? null,
    fileRef: evt.payload.fileRef ?? null,
    conversationId: evt.origin.conversationId ?? null,
    messageId: evt.origin.messageId ?? null,
    originKey: `${evt.origin.channel}|mid|${evt.origin.messageId ?? ''}`,
  };
}

/** 笔记 → 记录（需求 3.1.4：主题 / 时间 YYYY-MM-DD / 内容 md） */
export function noteRecord(evt) {
  return {
    id: evt._id, type: 'note',
    at: new Date(evt._at).toISOString(),
    topic: evt.payload.topic,
    date: evt.payload.date,
    content_md: evt.payload.content_md,
    tags: evt.payload.tags ?? [],
    source: evt.payload.source ?? null,
    originKey: `${evt.origin.channel}|mid|${evt.origin.messageId ?? ''}`,
  };
}

/** 日程 → 记录（需求 3.1.5：主题 / 详情 / 起止 / 地点 / 参与人） */
export function scheduleRecord(evt) {
  const p = evt.payload;
  return {
    id: evt._id, type: 'schedule',
    at: new Date(evt._at).toISOString(),
    topic: p.topic, detail: p.detail ?? null,
    start: p.start, end: p.end ?? null,
    location: p.location ?? null,
    participants: p.participants ?? [],
    originKey: `${evt.origin.channel}|mid|${evt.origin.messageId ?? ''}`,
  };
}

/** 待办 → 记录（需求 3.1.6：主题 / 详情 / 截止 / 发布人 / 执行人） */
export function todoRecord(evt) {
  const p = evt.payload;
  return {
    id: evt._id, type: 'todo',
    at: new Date(evt._at).toISOString(),
    topic: p.topic, detail: p.detail ?? null,
    due: p.due ?? null,
    publisher: p.publisher ?? null,
    assignee: p.assignee ?? null,
    originKey: `${evt.origin.channel}|mid|${evt.origin.messageId ?? ''}`,
  };
}

/** 消息 → MD 小节（带标题，便于切块与回读） */
export function messageSection(evt) {
  const lines = [
    '',
    `## ${stamp(evt._at)} · ${CH_LABEL[evt.payload.channel] ?? evt.payload.channel} · ${esc(evt.payload.sender)}`,
    '',
    `- 子通道：${evt.payload.source ?? 'im'}　模态：${evt.payload.modality ?? 'text'}`,
  ];
  if (evt.payload.fileRef) lines.push(`- 附件：${evt.payload.fileRef}`);
  if (evt.origin.conversationId) lines.push(`- 会话：${evt.origin.conversationId}`);
  lines.push('', esc(evt.payload.raw), '');
  return lines.join('\n');
}

/** 笔记 / 日程 / 待办 → MD 小节（人读 + 向量化载体） */
export function typedSection(evt) {
  const p = evt.payload;
  if (evt.type === 'note') {
    const tags = (p.tags ?? []).length ? `\n- 标签：${(p.tags ?? []).join('、')}` : '';
    return `\n## [笔记] ${esc(p.topic)}\n\n- 日期：${p.date}${tags}${p.source ? `\n- 来源：${p.source}` : ''}\n\n${p.content_md}\n`;
  }
  if (evt.type === 'schedule') {
    const lines = ['', `## [日程] ${esc(p.topic)}`, '', `- 起止：${p.start}${p.end ? ` ~ ${p.end}` : ''}`];
    if (p.location) lines.push(`- 地点：${p.location}`);
    if ((p.participants ?? []).length) lines.push(`- 参与人：${(p.participants ?? []).join('、')}`);
    if (p.detail) lines.push('', esc(p.detail));
    lines.push('');
    return lines.join('\n');
  }
  if (evt.type === 'todo') {
    const lines = ['', `## [待办] ${esc(p.topic)}`, ''];
    if (p.due) lines.push(`- 截止：${p.due}`);
    if (p.publisher) lines.push(`- 发布人：${p.publisher}`);
    if (p.assignee) lines.push(`- 执行人：${p.assignee}`);
    if (p.detail) lines.push('', esc(p.detail));
    lines.push('');
    return lines.join('\n');
  }
  return '';
}

const RECORDERS = { message: messageRecord, note: noteRecord, schedule: scheduleRecord, todo: todoRecord };
const SECTIONERS = { message: messageSection, note: typedSection, schedule: typedSection, todo: typedSection };

/**
 * 双写一条事件（四类都支持）。
 * @returns {{ok:boolean, wrote:string[], skipped:string[], why?:string}}
 */
export function writeEvent(evt, { dir = null } = {}) {
  const rec = RECORDERS[evt.type]; const sec = SECTIONERS[evt.type];
  if (!rec || !sec) return { ok: false, wrote: [], skipped: [], why: `未支持的事件类型：${evt.type}` };

  const idx = loadIndex();
  const entry = idx[evt._id] ?? {};
  const wrote = []; const skipped = [];
  const at = new Date(evt._at).toISOString();
  const base = dir ?? resolveDir({ kind: evt.type });
  const month = ym(evt._at);
  const jsonlRel = `${base}/${month}.jsonl`;
  const mdRel = `${base}/${month}.md`;

  try {
    if (!entry.jsonl) { appendJsonl(jsonlRel, rec(evt)); entry.jsonl = at; wrote.push(jsonlRel); } else skipped.push(jsonlRel);
    if (!entry.md) { appendMd(mdRel, sec(evt)); entry.md = at; wrote.push(mdRel); } else skipped.push(mdRel);
    idx[evt._id] = entry;
    saveIndex(idx);
    return { ok: true, wrote, skipped };
  } catch (e) {
    return { ok: false, wrote, skipped, why: `知识库写入失败：${e.message}` };
  }
}
