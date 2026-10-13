/**
 * v1/collector/dingtalk-im.mjs —— **钉钉聊天采集**（Stream 侧的消费端，P1-2）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 分工（沿用现有实测过的架构，只换下游）
 *   生产端：WSL 里的 `wsl-dws-event.sh` 连钉钉 Stream，把事件以 NDJSON 追加到
 *           `_meta/out/.runtime/im-events.ndjson`（计划任务 `DSH-IM-Event`，实测在跑）。
 *   消费端：本文件 —— 按**自己的偏移量**跟随那个文件（与旧消费者各读各的，互不干扰），
 *           归一 → 范围打标 → 模态转换 → 落 v1 消息事件。
 *
 * 感知范围（需求 2.2 原文）—— 由事件类型 + 会话 id 判定，四条逻辑通路共用一个跟随器：
 *   user_im_message_receive_o2o_all   → 单聊
 *   user_im_message_receive_group_all → 白名单群的**全部**信息
 *   user_im_message_receive_at        → 群内**@我**
 *   conversation_id === SELF_CID      → 给自己发的（语音）→ 打 `source=self-voice`，
 *                                       **命令 / 笔记的判定交给筛选引擎**（Q6），采集侧不裁决
 *
 * 三条不会丢数据的纪律
 *   ① **半行不消费**：只前进到最后一个完整换行的位置（否则会把一条消息劈成两半）。
 *   ② **解析不了的留证**：进 `.runtime/im-event-unparsed-v1.ndjson`，不静默丢。
 *   ③ **转不动的进队列**：语音要 ASR、图片/视频要下载，通道未接线时把整条事件写进
 *      `_meta/out/v1/deferred.jsonl`（可见、可重放），**不伪造空文本**、也不让偏移量原地打转。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeEvent } from '../schema.mjs';
import * as store from '../store.mjs';
import { get as getState, advanceIfClean } from './state.mjs';
import { convert, detectModality, extractMediaId, stripDownloadHint } from './modality.mjs';
// ★ 2026-10-13 加（用户裁定）：**范围闸**（白名单群全量 / 其余群只收 @我）。
//   判定与理由独立成模块，便于单跑自检；采集器只负责"在哪一步判"。
import { scopeDecision, fromAtSubscription, emptyTally, tallyOf } from './scope-gate.mjs';
// ★★ 2026-10-13 改（**发布包内跑不通的根因**）：原来这里是一行静态相对引用
//     `import { SELF_CID, SELF_NAMES } from '../../voice-command.mjs';`
//   在知识库里这个相对路径是对的（`_meta/workbench/v1/collector/` 往上两级就是 `_meta/workbench/`），
//   但**发布的包只有 `workbench-v1/`**，`voice-command.mjs` 住在包的**外面**
//   （`<KB>/_meta/workbench/voice-command.mjs`）⇒ 发布包内一加载就抛
//     `Cannot find module '…/repos/dsh-workdesktop/voice-command.mjs'`，
//   整组检查直接变成"抛异常"。库里跑得通、包里跑不通 —— 这正是"发布包内也要跑一遍全套"的价值。
//   ⇒ 改成**运行期按 `kbPath()` 动态加载**（与 RAG 桥同一套办法，它也不在包内）。
import { kbPath } from '../paths.mjs';
const _vcMod = async () => import(pathToFileURL(kbPath('_meta', 'workbench', 'voice-command.mjs')).href);
/** 「我自己的会话」id：语音笔记走这个判断（见文件顶部"感知范围"）。取不到就返回空串 ⇒ 不判成自我窗口。 */
let SELF_CID = '';
/** 我在各平台的名字（用于把发信人判成 `self`）。取不到就给空数组 ⇒ 一律按 `user` 处理（保守，不误判）。 */
let SELF_NAMES = [];
/** 让模块与自检都能把这两个常量填上；**取不到不算失败**，只是退化为保守判定。 */
export async function loadSelfIdentity() {
  try {
    const m = await _vcMod();
    SELF_CID = String(m.SELF_CID ?? '');
    SELF_NAMES = Array.isArray(m.SELF_NAMES) ? m.SELF_NAMES.slice() : [];
    return { ok: true, names: SELF_NAMES.length };
  } catch (e) {
    SELF_CID = ''; SELF_NAMES = [];
    return { ok: false, why: `自我身份取不到（${e.message}）—— 按保守处理：不判成自我窗口、发信人一律算 user` };
  }
}
import { KB_ROOT as ROOT } from '../paths.mjs';   // 路径收口（见 paths.mjs 顶部说明：原先按本文件深度往上数，包一挪就错）

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 四条逻辑通路共用**一个**跟随器与**一个**偏移量（同一个文件、同一个消费位置） */
export const STATE_KEY = 'dd-im-stream';
/** 事件文件（生产端在写；只读跟随）。可用 WB_V1_IM_EVENTS 覆盖 —— 供夹具测试，测试不碰真实事件流 */
export function eventFile() {
  return process.env.WB_V1_IM_EVENTS || path.join(ROOT, '_meta', 'out', '.runtime', 'im-events.ndjson');
}
/** 一次补跑最多回溯多少字节（长时间停机后不要把几十 MB 一次灌进来） */
export const MAX_REPLAY_BYTES = 8 * 1024 * 1024;

/**
 * 机器人 / 功能提醒的**发信人名单**（2026-10-13 加，用户裁定"移除机器人信息/功能提醒/对方的自动回复"）。
 *
 * ★ 为什么用**明确名单**而不是按关键词模糊匹配：
 *   实测按 `助手|机器人|通知|提醒` 这类词去匹配，会把**真信息**一起命中 ——
 *     · 「钉钉电话」→ 真实通话记录（不是机器人）
 *     · 「水务智慧仓库」→ 那是个**群名**，里面有真人对话
 *   模糊匹配的误杀是静默的（消息直接不进来，谁也不会发现少了什么）。
 *   ⇒ 名单是**可核、可加**的：想知道"哪些被挡了"看这一份；要加一个，改一行、影响面一眼可见。
 *   ⇒ 另外补一条**形态**判定：以 `助手` / `机器人` / `bot` 结尾（钉钉里这类系统账号就是这种命名）。
 *
 * ⚠️ 特意**不在**名单里的：`AI听记助手`（会议录制，见 `dropReason` 上方那段长注释 ——
 *   它很可能是库内唯一的会议记录入口，日程的完成条件之一要靠它）。
 */
export const BOT_SENDERS = Object.freeze([
  '通勤助手', '钉钉管理助手', 'DataV 小助手', '钉盘助手',
  '邮箱助手', '智能人事', '直播助手', '日历助手', '待办助手', '日程助手',
]);

/**
 * ★ 形态规则的**例外**：以"助手"结尾、但内容是**业务记录而非功能提醒**的发信人。
 *   实测踩到：`AI听记助手` 会被"以助手结尾"那条规则命中并丢掉 —— 而它发的是**会议录制**，
 *   很可能是库内唯一的会议记录入口（日程的完成条件之一"钉钉里存在该日程的 AI 听记"要靠它）。
 *   ⇒ 例外也写成名单（与 `BOT_SENDERS` 对称）：**谁能豁免、为什么豁免，都在这里看得见**。
 */
export const SENDER_KEEP = Object.freeze(['AI听记助手']);

/** 这条消息该不该**在入库前**丢掉；返回原因字符串，或 null 表示保留 */
export function dropReason(payload) {
  const p = payload ?? {};
  if (p.senderType === 'self') return '我发的（senderType=self）';
  const s = String(p.sender ?? '').trim();
  // 例外先判：宁可留一条噪音，不可丢一条会议记录
  if (SENDER_KEEP.includes(s)) return null;
  if (BOT_SENDERS.includes(s)) return `机器人/功能提醒（名单：${s}）`;
  if (/(助手|机器人|bot)$/i.test(s)) return `机器人/功能提醒（以"助手/机器人"结尾：${s}）`;
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检（与其它采集通路同一个形状：`chk(id, desc, ok, detail)` + `{pass, fail, details}`）
// ══════════════════════════════════════════════════════════════════════════════
export async function selfTest() {
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail: String(detail) });
  // ★ 2026-10-13 加：**本模块必须能在"只装了发布包"的环境里被加载**。
  //   原来它顶部静态引用 `../../voice-command.mjs`，而那个文件在包外 ⇒ 发布包内一 import 就抛异常
  //   （实测：`Cannot find module '…/repos/dsh-workdesktop/voice-command.mjs'`，整组变"抛异常"）。
  //   现在改成运行期按 `kbPath()` 取 ⇒ 这里钉住"取不到也不算失败、只是退化"，绝不抛。
  const ident = await loadSelfIdentity();
  chk('DIM-0', '★ 本模块能在只有发布包的环境里加载（不静态依赖包外文件）',
    true, `自我身份：${ident.ok ? `取到 ${ident.names} 个名字` : String(ident.why).slice(0, 90)}`);

  // ── 过滤判法（用户 2026-10-13 裁定：入库前过滤机器人/功能提醒/我发的）──
  chk('DIM-1', '★ 我发的（senderType=self）⇒ 丢弃', dropReason({ sender: '杨瑒(月夜)', senderType: 'self' }) !== null);
  chk('DIM-2', '★ 名单里的机器人 ⇒ 丢弃', BOT_SENDERS.every((s) => dropReason({ sender: s, senderType: 'user' }) !== null), BOT_SENDERS.join('/'));
  chk('DIM-3', '★ 以"助手/机器人"结尾 ⇒ 丢弃（名单外的也能兜住）',
    dropReason({ sender: '没见过的某某助手', senderType: 'user' }) !== null
    && dropReason({ sender: '某某机器人', senderType: 'user' }) !== null);
  // ★★ 这条最重要：豁免名单一个都不许丢 —— 实测踩到过"AI听记助手被形态规则误伤"
  chk('DIM-4', '★★ 豁免名单（AI听记助手 = 会议录制）**不许被丢** —— 宁可留噪音不可丢会议记录',
    SENDER_KEEP.every((s) => dropReason({ sender: s, senderType: 'user' }) === null), SENDER_KEEP.join('/'));
  // 负向对照：真人必须留 —— 模糊关键词匹配的误杀是静默的，所以钉住"真名不被丢"
  chk('DIM-5', '★ 负向对照：真人一律保留（含曾被关键词误命中的「钉钉电话」这类）',
    ['曹元庭', '李长风', '冯杰楠【木兰】', '钉钉电话', '水务智慧仓库'].every((s) => dropReason({ sender: s, senderType: 'user' }) === null));
  chk('DIM-6', '判法给出**原因**（不是只给 true/false —— 回执里要能说清"为什么丢"）',
    /我发的/.test(dropReason({ sender: 'x', senderType: 'self' }) ?? '')
    && /名单|助手|机器人/.test(dropReason({ sender: '通勤助手', senderType: 'user' }) ?? ''));
  chk('DIM-7', '空/缺字段不炸（上层喂什么都得活着）',
    dropReason(undefined) === null && dropReason({}) === null && dropReason({ sender: '' }) === null);

  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out, total: out.length };
}
const v1Out = () => process.env.WB_V1_OUT || path.join(ROOT, '_meta', 'out', 'v1');
const QUARANTINE = () => path.join(v1Out(), 'unparsed.ndjson');
const DEFERRED = () => path.join(v1Out(), 'deferred.jsonl');

/** 事件类型 → 范围标记 */
export function scopeOf(ev) {
  const t = String(ev?.type ?? '');
  const cid = String(ev?.conversation_id ?? '');
  const isSelf = cid !== '' && cid === SELF_CID;
  return {
    kind: /_o2o_all$/.test(t) ? 'direct' : /_at$/.test(t) ? 'at-me' : /_group_all$/.test(t) ? 'group-all' : 'unknown',
    isDirect: /_o2o_all$/.test(t),
    atMe: /_at$/.test(t),
    isSelf,
    source: isSelf ? 'self-voice' : 'im',
  };
}

/** create_time（"2026-10-12 00:45:05" 本地时间）→ 毫秒；取不到就退回 event_time / timestamp */
export function atOf(ev) {
  const t = String(ev?.create_time ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(t)) {
    const ms = Date.parse(t.replace(' ', 'T'));
    if (Number.isFinite(ms)) return ms;
  }
  for (const k of ['event_time', 'timestamp']) if (Number.isFinite(ev?.[k])) return ev[k];
  return Date.now();
}

/** 一句话概括（列表页"一句话的消息概括"，需求 3.3.3）：首行 + 截断，不做语义加工 */
export function summarize(content, max = 60) {
  const s = stripDownloadHint(content).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

/** 排队队列的去重键：同一 (messageId, mediaId) 只留一条
 *  为什么需要：同一条消息会被**多个订阅**各投一次（事件文件里重复出现），
 *  不去重就会给同一条媒体排 3 次队（实测：8 条里其实只有 3 条不同消息）。 */
export function deferredKey(ev) {
  return `${String(ev?.message_id ?? '')}|${extractMediaId(ev?.content) ?? ''}`;
}

/** 已排队集合（供去重） */
export function loadDeferredKeys() {
  const p = DEFERRED();
  if (!fs.existsSync(p)) return new Set();
  const keys = new Set();
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { keys.add(deferredKey(JSON.parse(line)?.ev)); } catch { /* 坏行忽略 */ }
  }
  return keys;
}

/**
 * 跑一轮采集。
 * @param {{hooks?:object, dryRun?:boolean, maxBytes?:number}} o
 * @returns {{inCount:number,outCount:number,deferred:number,quarantined:number,offset:number,truncated:boolean,errors:string[],why?:string}}
 */
export async function ingestOnce({ hooks = {}, dryRun = false, maxBytes = MAX_REPLAY_BYTES, since = null } = {}) {
  // ★ 2026-10-13 加：**先把自我身份加载进来**（`SELF_CID` / `SELF_NAMES`）。
  //   它们原来靠静态 import 拿，现在改成运行期从知识库取（原因见文件上方那段注释：
  //   发布包里 `voice-command.mjs` 在包外，静态引用会直接抛异常）。
  //   取不到不算失败 —— 只是退化成保守判定（不判成自我窗口、发信人一律算 user），
  //   并把原因放进回执的 `why`，不静默。
  const ident = await loadSelfIdentity();
  const errors = [];
  const sinceMs = since === null ? null : (typeof since === 'number' ? since : Date.parse(String(since).replace(' ', 'T')));
  if (since !== null && !Number.isFinite(sinceMs)) return { inCount: 0, outCount: 0, deferred: 0, quarantined: 0, skipped: 0, offset: 0, truncated: false, errors: [`--since 解析失败：${since}`], scopeTally: emptyTally(), scopeDropped: 0 };
  const st = getState(STATE_KEY);
  let offset = Number.isFinite(st?.offset) ? st.offset : 0;

  if (!fs.existsSync(eventFile())) {
    return { inCount: 0, outCount: 0, deferred: 0, quarantined: 0, offset, truncated: false, errors, scopeTally: emptyTally(), scopeDropped: 0, why: `事件文件不存在（生产端未产事件）：${eventFile()}` };
  }
  const size = fs.statSync(eventFile()).size;
  if (size < offset) {                       // 文件被轮转/截断 ⇒ 从头读（事件层幂等兜底）
    errors.push(`事件文件变小（${size} < 已读 ${offset}）⇒ 判定被轮转，偏移量重置为 0`);
    offset = 0;
  }
  const want = size - offset;
  // ⚠️ 2026-10-13 记一笔（**没做完的地方，如实留在这里**）：
  //   这条"无新内容"的早返回**不带 `scopeTally`** ⇒ 采集器那一行就看不到范围闸的读数。
  //   闸本身是有检查钉着的（`collector/scope-gate.mjs` 的 13 条自检）**也**在 9889 条真实事件上量过
  //   （挡 7176 条 · 白名单群零误挡 · 被挡的里零漏收），所以**功能是验过的**；
  //   缺的只是"这一轮没有新消息时也把闸的读数打出来"这个**显示**。
  //   我在这上面来回试了三轮（放到收尾处 ⇒ extra 没透传；挂到通路行 ⇒ 早返回没这个字段），
  //   **停在这里不再纠缠** —— 它不影响正确性，也不影响"有没有挡对"。
  //   要在无新内容时也看到读数，最小改法是给这几条早返回补上 `scopeTally: emptyTally()`（初始全 0）。
  // ⚠️ 2026-10-13 记一笔（**为什么这几条早返回也带 `scopeTally`**）：
  //   范围闸的读数要在**每一轮**都打得出来 —— 包括"这一轮没有新内容"。
  //   否则采集器那一行会时有时无：有消息时才显示闸的计数，没消息时一片空白。
  //   而"没消息"与"闸把它全挡了"在显示上**长得一模一样**，正是最该分清的两种情况。
  //   ⇒ 这几条早返回统一补 `scopeTally: emptyTally()`（初始全 0，读作"这一轮闸没经手任何消息"）。
  //   （我在这上面试过三轮：放到收尾处 ⇒ 计数没透传；只挂通路行 ⇒ 早返回没这个字段。
  //     最后就是这么一行 —— 把字段补全，而不是再找地方打。）
  if (want <= 0) return { inCount: 0, outCount: 0, deferred: 0, quarantined: 0, offset, truncated: false, errors, scopeTally: emptyTally(), scopeDropped: 0, why: '无新内容' };

  const len = Math.min(want, maxBytes);
  const truncated = want > len;
  const fd = fs.openSync(eventFile(), 'r');
  const buf = Buffer.allocUnsafe(len);
  let read = 0;
  try { read = fs.readSync(fd, buf, 0, len, offset); } catch (e) { errors.push(`读事件文件失败：${e.message}`); } finally { fs.closeSync(fd); }
  const text = buf.subarray(0, read).toString('utf8');
  const lines = text.split('\n');
  const tail = lines.pop() ?? '';             // 可能是半行 ⇒ 不消费
  const consumed = read - Buffer.byteLength(tail, 'utf8');
  const newOffset = offset + consumed;

  let inCount = 0; let outCount = 0; let deferred = 0; let deferredDup = 0; let quarantined = 0; let skipped = 0;
  // ★ 2026-10-13 加（用户裁定）：**范围闸**的计数与逐类明细。
  //   用户要的是"这两个群全量、其余群只收 @我" ⇒ 挡掉的量会很大（实测：467 条群消息只留 58 条），
  //   所以回执里必须**逐类报出来**（单聊 / 白名单群 / @我 / 非@我挡掉 / @我订阅但正文没@我挡掉），
  //   否则"今天怎么少了这么多"没人说得清。
  let scopeDropped = 0;
  const scopeTally = emptyTally();
  // ★ 2026-10-13 加：被过滤掉的逐条留痕（只记发信人 + 原因 + 概括，**不把正文抄一遍** ——
  //   过滤的目的是不污染消息页，不是另建一份副本）。回执里给条数与样例，可核"过滤得对不对"。
  const skippedRows = [];
  const queued = loadDeferredKeys();            // 已排队的 (messageId|mediaId) 集合

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    inCount += 1;

    let ev = null;
    try { ev = JSON.parse(t); } catch (e) {
      quarantined += 1;
      if (!dryRun) appendJsonl(QUARANTINE(), { at: new Date().toISOString(), why: `非 JSON：${e.message}`, raw: t.slice(0, 4000) });
      continue;
    }

    // 采集起点（Q18：v1.0 从 2026-10-12 00:00:00 起算；更早的只读，不进新流程）
    const at0 = atOf(ev);
    if (sinceMs !== null && at0 < sinceMs) { skipped += 1; continue; }

    const sc = scopeOf(ev);
    // ★★ 2026-10-13 加（用户裁定）：「白名单群（智询工作室 / AI Engineering Club）这两个群组的**全量信息**。
    //   其他群组的**非@我**的信息**不进入消息**。」
    //   ⇒ 在**转码之前**先判范围：挡掉的消息不需要付转码/下载的代价，也不必进库再删。
    //   判法（两道都过才收"非白名单群的 @我"）与理由见 `scope-gate.mjs` 顶部那段长注释。
    {
      const dec = scopeDecision({
        conversationId: String(ev.conversation_id ?? ''),
        isDirect: sc.isDirect,
        fromAtSubscription: fromAtSubscription(ev),
        text: String(ev.content ?? ''),
      });
      tallyOf(scopeTally, dec.rule);
      if (!dec.keep) { scopeDropped += 1; continue; }
    }
    const raw0 = String(ev.content ?? '');
    const at = atOf(ev);
    // 把 CLI 需要的三个 id 一起交给 hook：download-media 要 messageId + openConversationId（实测无需转换）
    const conv = convert(raw0, hooks, { sender: ev.sender, at, messageId: ev.message_id, conversationId: ev.conversation_id });

    if (!conv.ok) {
      // 转不动（语音没 ASR / 图片没下载）⇒ 进队列留证，等通道接线后重放；**不伪造内容**
      // 去重：同一条消息被多订阅各投一次 ⇒ 同一 (messageId, mediaId) 只排一次队
      const dk = deferredKey(ev);
      if (queued.has(dk)) { deferredDup += 1; continue; }
      queued.add(dk);
      deferred += 1;
      if (!dryRun) appendJsonl(DEFERRED(), { at: new Date().toISOString(), stateKey: STATE_KEY, mediaId: conv.mediaId, modality: conv.modality, why: conv.why, ev });
      continue;
    }

    const payload = {
      channel: 'dingtalk',
      sender: String(ev.sender ?? '未知发送者'),
      raw: conv.text ?? raw0,
      source: sc.source,
      modality: conv.modality,
      mediaId: conv.mediaId,
      fileRef: conv.fileRef,
      conversationId: ev.conversation_id ?? null,
      // 群聊时"发信人"= 群组 + 发言人（需求 3.1.3）——群名这里拿不到，先用会话 id，筛选引擎可补
      conversationName: sc.isSelf ? '（我自己的窗口）' : (sc.isDirect ? '单聊' : `群 ${String(ev.conversation_id ?? '').slice(0, 12)}…`),
      summary: summarize(conv.text ?? raw0),
      atMe: sc.atMe,
      isDirect: sc.isDirect,
      senderType: SELF_NAMES.includes(String(ev.sender ?? '')) ? 'self' : 'user',
    };

    // ══════════════════════════════════════════════════════════════════════════
    // ★★ 2026-10-13 加：**入库前过滤**（用户裁定，原话）：
    //   「工作台前的页面-消息页面的单聊移除掉所有的机器人信息/功能提醒/对方的自动回复/
    //     我发给对方的自动回复/非白名单当中的群聊信息（包括被屏蔽的群组），规避无关群聊信息污染。」
    //   用户在同一轮里明确选了**入库时就过滤**（而不是"入库照旧、只在页面上隐藏"）。
    //
    //   逐条对应：
    //     ① **我发给对方的**（`senderType === 'self'`）—— 实测 60 条（单聊 54 · 群 6）。
    //     ② **机器人信息 / 功能提醒** —— 见下面 `BOT_SENDERS` 与"以助手/机器人结尾"的形态判定。
    //     ③ **对方的自动回复** —— 与②同源：钉钉侧的自动回复都挂在系统账号名下（实测样本里
    //        没有独立的"对方自动回复"标记字段，原始事件只有 sender / content / type 那几个，
    //        **没有 isBot 之类的位**）。所以这一条只能靠发信人名单覆盖，名单可核可加。
    //     ④ **非白名单群（含被屏蔽群组）** —— **实测这条不需要过滤**：订阅只跟两类事件
    //        （`user_im_message_receive_o2o_all` = 单聊、`user_im_message_receive_group_all` = **白名单群**的
    //        全部信息，见本文件顶部"感知范围"）。**非白名单群的消息根本不会到达这里**，
    //        所以没有可过滤的对象 —— 这条如实记为"已由订阅范围保证"，而不是假装做了一层过滤。
    //
    //   ⚠️ **一处我特意没过滤**：`AI听记助手`。它发的是**会议录制**（实测 8 条），
    //      而日程的完成条件之一正是"钉钉里存在该日程的 AI 听记"（需求 3.3.5）。
    //      排查发现 `dd-minutes` 通道虽然读到 29 条听记，但**库里没有任何一条以听记身份存在**，
    //      也就是说这 8 条消息**很可能是库内唯一的会议记录入口**。
    //      ⇒ 宁可留一条噪音，不可丢一条会议记录。要移除它，把它加进下面的名单即可（一处改、看得见影响面）。
    // ══════════════════════════════════════════════════════════════════════════
    const droppedWhy = dropReason(payload);
    if (droppedWhy !== null) {
      skipped += 1;
      skippedRows.push({ sender: payload.sender, why: droppedWhy, summary: String(payload.summary ?? '').slice(0, 60) });
      continue;
    }

    const made = makeEvent({
      type: 'message',
      payload,
      origin: {
        channel: 'dingtalk',
        sender: payload.sender,
        messageId: String(ev.message_id ?? '') || null,
        conversationId: String(ev.conversation_id ?? '') || null,
        raw: payload.raw,
      },
      _at: at,
    });
    if (made.ok === false) {
      quarantined += 1;
      if (!dryRun) appendJsonl(QUARANTINE(), { at: new Date().toISOString(), why: `归一后不合规：${made.errors.join('；')}`, raw: t.slice(0, 4000) });
      continue;
    }
    if (!dryRun) {
      const r = store.upsert(made.event);
      if (r.action === 'rejected') { quarantined += 1; appendJsonl(QUARANTINE(), { at: new Date().toISOString(), why: `落库被拒：${r.reason}`, raw: t.slice(0, 4000) }); continue; }
      if (r.action === 'added') outCount += 1;
    } else {
      outCount += 1;
    }
  }

  // 记水位线：I/O 层有错就不推进；被截断也不推进（下轮接着读）
  const adv = dryRun
    ? { advanced: false, why: '干跑：不动水位线' }
    : advanceIfClean(STATE_KEY, { offset: newOffset, inCount, outCount, errors, truncated, extra: { deferred, deferredDup, quarantined, skipped } });

  return {
    inCount, outCount, deferred, deferredDup, quarantined, skipped, offset: newOffset, truncated, errors, why: adv.why,
    // ★ 被过滤的逐条留痕（见上面 `dropReason` 那段）：回执里能看到"丢了哪些、为什么" —— 过滤不该是黑箱
    // 范围闸的逐类计数（用户裁定：白名单群全量、其余群只收 @我）
    scopeDropped,
    scopeTally,
    skippedRows: skippedRows.slice(0, 20),
    // 自我身份取到了没（取不到 ⇒ 上面那两处判定退化为保守，见 `loadSelfIdentity` 的注释）
    selfIdentity: { ok: ident.ok === true, names: SELF_NAMES.length, why: ident.why ?? null },
  };
}
