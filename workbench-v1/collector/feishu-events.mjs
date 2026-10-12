/**
 * v1/collector/feishu-events.mjs —— 飞书 · 聊天实时（登记表 `fs-im-group` + `fs-im-p2p`）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 需求 2.2：「飞书和钉钉的**聊天**使用 **Stream 长链接**模式，实时感知新信息流入；
 *           飞书的聊天是**包含全部群聊和单聊**的信息感知」—— 本条就是它。
 *
 * ★ 为什么是"常驻消费者 + NDJSON + 采集器读文件"（而不是每轮 tick 里跑一次 consume）：
 *   `lark-cli event consume` 是**长连接**，事件只在连接活着的时候进来。5 分钟一轮里跑 20 秒，
 *   中间那 4 分 40 秒的消息就**丢了**（假绿：看起来在采，其实漏）。所以照**钉钉那条的成熟做法**
 *   （`_meta/workbench/im-event-consume.mjs`，2026-09-21 起在 WSL 常驻）：常驻进程把事件
 *   **追加**到 NDJSON，采集器只读文件 ⇒ 谁也不漏。
 *
 * ★ 三条实测约束（本轮全部撞过，别再以为"写错了"）：
 *   ① **必须 `--as bot`** —— `--as user` 直接报 `this command only supports: bot`；
 *   ② **同一个应用只能有一条实时连接** —— 被占时报
 *      `another event bus is already connected to this app (1 remote event connection(s) detected via API)`；
 *      本轮实测占它的是 **`.hermes-fde` 那个 hermes 实例**（`FEISHU_APP_ID=cli_aae5b0cbf3e1dbeb`
 *      + `FEISHU_CONNECTION_MODE=websocket`）⇒ 停掉它之后 `online_instance_cnt=0`、连接立刻建起来；
 *   ③ **它能看到的范围 = 机器人在的群 + 与机器人的单聊** —— 这正是需求里"全部群聊和单聊"的
 *      **实际边界**（要覆盖别的群得把机器人拉进去），读数里如实写，不假装全知。
 *
 * 幂等键 = `fs-evt-<event_id>`（飞书事件自带 id）；起点按**消息发送时间**（用户裁定口径）。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { makeEvent } from '../schema.mjs';
import * as store from '../store.mjs';
import { v1Out } from '../paths.mjs';
import { inScope } from './registry.mjs';

export const KEY = 'fs-im-group';
export const EVENT_KEY = 'im.message.receive_v1';
/** 事件落点（常驻进程写、采集器读） */
export function eventsFile() { return path.join(v1Out(), '.runtime', 'fs-im-events.ndjson'); }
export function consumerStateFile() { return path.join(v1Out(), 'fs-im-consumer.json'); }
export function seenFile() { return path.join(v1Out(), 'fs-im-seen.json'); }

export function loadSeen() { try { return JSON.parse(fs.readFileSync(seenFile(), 'utf8')) ?? {}; } catch { return {}; } }
export function saveSeen(doc) {
  const f = seenFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, f);
}

// ──────────────────────────────────────────────────────────────────────────────
// 常驻消费者：把 `lark-cli event consume` 的 NDJSON 原样追加到文件
// ──────────────────────────────────────────────────────────────────────────────
export function startConsumer({ bin = 'lark-cli', eventKey = EVENT_KEY, file = null, onLine = null } = {}) {
  const dest = file ?? eventsFile();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(dest, { flags: 'a' });
  // 经 PowerShell 起（Windows 上 .cmd 垫片直接 spawn 会 ENOENT，且这里要的是长驻）
  // ⚠️ stdio 的 stdin **必须是 'pipe' 且一直不关** —— 这不是随手写的：
  //   `lark-cli event consume` **把 stdin EOF 当作"调用方结束"的退出信号**（它为 AI 子进程调用而设计），
  //   第一版用 `stdio: ['ignore', …]` ⇒ stdin 立刻 EOF ⇒ 进程刚 ready 就退出，
  //   日志里那句原文是：`stdin closed — shutting down. consume treats stdin EOF as exit signal`。
  //   （真机上表现为"消费者反复重启、一个事件都收不到"。）
  const ps = spawn('powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${bin} event consume ${eventKey} --as bot`],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  // 保持 stdin 打开：引用住它，谁也不写、谁也不关
  ps.stdin.on('error', () => { /* 忽略 EPIPE */ });
  const pump = (stream) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        out.write(t + '\n');
        if (onLine) onLine(t);
      }
    });
  };
  pump(ps.stdout); pump(ps.stderr);
  const state = { pid: ps.pid, eventKey, startedAt: new Date().toISOString(), file: dest };
  fs.writeFileSync(consumerStateFile(), JSON.stringify(state, null, 2) + '\n', 'utf8');
  return { proc: ps, state };
}

// ──────────────────────────────────────────────────────────────────────────────
// 事件 → v1 消息（需求 3.1.3：来源 / 发信人 / 原文）
// ──────────────────────────────────────────────────────────────────────────────
/** 从 `lark-cli` 输出的行里挑出事件对象（它前面还会打 `[event] …` 这类状态行） */
export function parseEventLine(line) {
  const t = String(line ?? '').trim();
  if (!t.startsWith('{')) return { ok: false, skip: true, why: '不是 JSON 行（状态/提示行）' };
  // ★ 形如 `{` 但没有配对的 `}` ⇒ 是**多行 JSON 的片段**（CLI 出错时会整块 pretty-print）——
  //   按"跳过"算，不按"坏 JSON"算：单行流里的事件永远是完整一行，片段只是噪声。
  //   （第一版把片段记成隔离 ⇒ 真实文件里长期挂着 1 条"坏 JSON"，看着像有问题其实不是。）
  if (!t.endsWith('}')) return { ok: false, skip: true, why: 'JSON 片段（多行块的一行）' };
  let j;
  try { j = JSON.parse(t); } catch (e) { return { ok: false, why: `坏 JSON：${e.message}` }; }

  // ★★ 2026-10-12 **真事件到达后才发现**：`lark-cli` 输出的是**扁平结构**，不是官方文档里的嵌套 `event.message`：
  //   {"type":"im.message.receive_v1","event_id":"…","create_time":"1791772410668",
  //    "chat_id":"oc_…","chat_type":"p2p","message_type":"text","sender_id":"ou_…","content":"测试信息"}
  //   ⇒ 三处都不一样：① 扁平（无 `event.message`）；② `content` 是**纯文本**（不是 '{"text":…}' 字符串）；
  //     ③ `sender_id` 是扁平字符串（不是 `sender.sender_id.open_id`）。
  //   第一版只按文档形状解析 ⇒ 真事件进来时**一条都认不出**（"认得出 0"），而 skip 又让它看起来"没消息"。
  if (j && typeof j === 'object' && (j.message_id || j.chat_id) && j.message_type) {
    const id = String(j.event_id ?? j.id ?? j.message_id ?? '');
    return {
      ok: true, id, flat: true,
      msg: { chat_id: j.chat_id, chat_type: j.chat_type, message_type: j.message_type, create_time: j.create_time, content: j.content },
      sender: { sender_id: { open_id: j.sender_id } },
    };
  }

  // 兼容官方 API 的**嵌套**形状（webhook / 原始事件体）
  const ev = j.event ?? j;
  const msg = ev?.message ?? ev?.event?.message;
  const sender = ev?.sender ?? ev?.event?.sender;
  const id = ev?.event_id ?? ev?.eventId ?? j.event_id ?? null;
  if (!msg || !id) return { ok: false, skip: true, why: '不是消息事件（或没有 event_id）' };
  return { ok: true, id: String(id), msg, sender, chatType: msg.chat_type ?? '', chatId: msg.chat_id ?? '' };
}

const TEXT_MSG = 'text';

/** 事件 → v1 消息事件 */
export function mapEvent(parsed) {
  const errs = [];
  const { id, msg } = parsed ?? {};
  // ★ 会话类型两种形状都要取：扁平事件放在 `msg.chat_type`（第一版只读 `parsed.chatType`，
  //   而那个字段只有嵌套分支才设 ⇒ **单聊被标成了"群聊"**。真事件到达后当场发现。）
  const chatType = parsed?.chatType ?? msg?.chat_type ?? '';
  if (!id) errs.push('缺 event_id（幂等键要用）');
  const t = Number(msg?.create_time);
  if (!Number.isFinite(t) || t <= 0) errs.push(`create_time 无法解析：${JSON.stringify(msg?.create_time)}`);
  const chatId = String(msg?.chat_id ?? '').trim();
  if (!chatId) errs.push('缺 chat_id（拿不到来源）');
  if (errs.length) return { ok: false, errors: errs };

  // 内容：text 直接取；其它模态（图片/文件/语音/视频）先按"模态 + 文件键"入流，附件下载是下一步
  let raw = '';
  let modality = 'text';
  const c = msg.content;
  if (msg.message_type === TEXT_MSG) {
    // ★ 两种形状都要认：**扁平事件里 `content` 就是纯文本**；官方嵌套形状里是 `'{"text":"…"}'` 字符串。
    if (typeof c === 'string' && !c.trim().startsWith('{')) { raw = c.trim(); }
    else {
      try { raw = String(JSON.parse(c ?? '{}').text ?? '').trim(); } catch { raw = String(c ?? '').trim(); }
    }
  } else {
    modality = String(msg.message_type ?? 'unknown');
    let body = {};
    try { body = typeof c === 'string' && c.trim().startsWith('{') ? JSON.parse(c) : (c ?? {}); } catch { body = {}; }
    const human = body.file_name ?? body.image_name ?? '';
    const opaque = body.file_key ?? body.image_key ?? body.file_token ?? '';
    raw = `［${modality}］${human || opaque}`.trim();
  }
  if (!raw) return { ok: false, skip: true, errors: ['空内容'] };

  const who = chatType === 'p2p' ? '飞书·单聊' : `飞书·群聊(${chatId.slice(0, 10)})`;
  return {
    ok: true,
    payload: {
      channel: 'feishu',
      sender: who,
      raw,
      source: 'im',
      modality,
      summary: raw.replace(/\s+/g, ' ').slice(0, 80),
    },
    origin: { channel: 'feishu', sender: who, messageId: `fs-evt-${id}`, raw: `chat=${chatId} type=${msg.message_type ?? ''} sender=${parsed.sender?.sender_id?.open_id ?? ''}` },
    _at: t,                                    // 飞书消息 create_time 是**毫秒**
    chatType,
  };
}

/** 跑一轮：读 NDJSON → 判起点 → 落库（幂等） */
export function ingestOnce({ file = null, dryRun = false, now = Date.now(), maxNew = 200 } = {}) {
  const src = file ?? eventsFile();
  const errors = [];
  let lines = 0; let parsed = 0; let skipped = 0; let outOfScope = 0; let quarantined = 0; let outCount = 0; let refreshed = 0;
  const kinds = { p2p: 0, group: 0 };

  if (!fs.existsSync(src)) {
    return { inCount: 0, lines: 0, parsed: 0, outCount: 0, refreshed: 0, skipped: 0, outOfScope: 0, quarantined: 0, kinds, errors: [], dataAsOf: null,
      why: `还没有事件文件（常驻消费者未启动？）：${path.basename(src)}` };
  }
  const seen = loadSeen();
  const text = fs.readFileSync(src, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    lines += 1;
    const p = parseEventLine(line);
    if (p.ok !== true) { if (!p.skip) { quarantined += 1; errors.push(String(p.why).slice(0, 90)); } continue; }
    parsed += 1;
    const m = mapEvent(p);
    if (m.ok !== true) { if (m.skip) { skipped += 1; } else { quarantined += 1; errors.push(`事件 ${p.id.slice(0, 12)} 映射失败：${m.errors.join('；')}`); } continue; }
    kinds[m.chatType === 'p2p' ? 'p2p' : 'group'] += 1;
    const scope = inScope('message', m.payload, m._at);
    if (!scope.inScope) { skipped += 1; outOfScope += 1; continue; }
    if (dryRun) { outCount += 1; continue; }
    if (outCount + refreshed >= maxNew) { errors.push(`达到上限 ${maxNew} 条`); break; }
    const made = makeEvent({ type: 'message', payload: m.payload, origin: m.origin, _at: m._at });
    if (made.ok === false) { quarantined += 1; errors.push(`归一失败：${made.errors.join('；')}`); continue; }
    const r = store.upsert(made.event);
    if (r.action === 'rejected') { quarantined += 1; errors.push(`落库被拒：${r.reason}`); continue; }
    if (r.action === 'added') outCount += 1; else if (r.action === 'updated') refreshed += 1;
    seen[m.origin.messageId] = { at: new Date(now).toISOString() };
  }
  if (!dryRun) saveSeen(seen);
  return {
    // ★ 必须给 `inCount`：节拍读的是这个字段，缺了就会在日志里显示"进 undefined"（读数里出现 undefined 很难看也不可信）。
    //   `parsed` 也保留（自检与读数都在用；两个都给，别为了省一个字段把另一个弄丢 —— 本轮就这么红过一次）。
    inCount: parsed, parsed, outCount, refreshed, skipped, outOfScope, quarantined, kinds, errors, lines, dataAsOf: new Date(now).toISOString(),
    why: `事件行 ${lines} · 认得出 ${parsed}（单聊 ${kinds.p2p} · 群聊 ${kinds.group}）→ 新采 ${outCount} · 刷新 ${refreshed}`
      + ` · 跳过 ${skipped}（其中出界 ${outOfScope}） · 隔离 ${quarantined}`,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检
// ══════════════════════════════════════════════════════════════════════════════
export async function selfTest() {
  const os = await import('node:os');
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });
  const prevOut = process.env.WB_V1_OUT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v1-fsev-'));
  process.env.WB_V1_OUT = tmp;

  const AT = Date.parse('2026-10-12T10:00:00+08:00');
  const line = (o) => JSON.stringify(o);
  const evt = (id, chatType, t, text, type = 'text') => line({
    event_id: id,
    event: { message: { chat_id: chatType === 'p2p' ? 'oc_p2p_1' : 'oc_grp_1', chat_type: chatType, message_type: type, create_time: t, content: JSON.stringify(type === 'text' ? { text } : { file_key: 'fk_1', file_name: text }) },
      sender: { sender_id: { open_id: 'ou_x' } } },
  });

  try {
    // ① 状态行不算事件
    chk('FSE-1', '状态/提示行被跳过（不当作事件）', parseEventLine('[event] ready event_key=im.message.receive_v1').skip === true);
    chk('FSE-2', '坏 JSON 分得清（不是静默丢）', /坏 JSON/.test(parseEventLine('{oops}').why ?? ''));
    chk('FSE-2b', '★ JSON **片段**（多行块的一行）算跳过、不算坏（真实文件里长期挂着的那种噪声）',
      parseEventLine('{').skip === true && parseEventLine('  "ok": false,').skip === true);
    const p1 = parseEventLine(evt('e1', 'p2p', AT, '你好'));
    chk('FSE-3', '★ 认得出消息事件并拿到 event_id', p1.ok === true && p1.id === 'e1' && p1.msg.create_time === AT);

    // ★★ 真实形状（2026-10-12 真事件到达后才发现）：`lark-cli` 输出的是**扁平**结构，
    //   且 `content` 是**纯文本**。第一版只按官方文档的嵌套形状解析 ⇒ 真事件一条都认不出（"认得出 0"）。
    const FLAT = JSON.stringify({
      type: 'im.message.receive_v1', event_id: 'flat-1', timestamp: String(AT), id: 'om_1', message_id: 'om_1',
      create_time: String(AT), chat_id: 'oc_flat', chat_type: 'p2p', message_type: 'text',
      sender_id: 'ou_flat', sender_type: 'user', content: '测试信息',
    });
    { const r = parseEventLine(FLAT); chk('FSE-3b', '★★ 认得出**扁平**形状（lark-cli 的真实输出）', r.ok === true && r.id === 'flat-1' && r.msg.content === '测试信息'); }
    { const m = mapEvent(parseEventLine(FLAT)); chk('FSE-3c', '★★ 扁平形状：纯文本 content + **单聊**标签（不能标成群聊）', m.ok === true && m.payload.raw === '测试信息' && m.payload.sender === '飞书·单聊', JSON.stringify(m.payload)); }
    { const m = mapEvent(parseEventLine(FLAT.replace('"chat_type":"p2p"', '"chat_type":"group"'))); chk('FSE-3d', '扁平形状：群聊标签带群标识', m.payload.sender.startsWith('飞书·群聊'), m.payload.sender); }

    // ② 映射
    const m1 = mapEvent(p1);
    chk('FSE-4', '★ 单聊：来源写明「飞书·单聊」、原文正确、模态 text', m1.payload.sender === '飞书·单聊' && m1.payload.raw === '你好' && m1.payload.modality === 'text', JSON.stringify(m1.payload));
    chk('FSE-5', '幂等键 = fs-evt-<event_id>', m1.origin.messageId === 'fs-evt-e1');
    chk('FSE-6', '★ 时间按**毫秒**直接用（飞书 create_time 就是毫秒）', m1._at === AT, String(m1._at));
    const m2 = mapEvent(parseEventLine(evt('e2', 'group', AT, '方案.pdf', 'file')));
    chk('FSE-7', '★ 非文字消息：模态如实记（file），内容不编（写明是哪种模态）', m2.ok === true && m2.payload.modality === 'file' && /［file］/.test(m2.payload.raw) && /方案\.pdf/.test(m2.payload.raw), m2.payload.raw);
    chk('FSE-8', '★ 群聊来源带群标识（可追溯是哪个群）', /群聊\(oc_grp_1/.test(m2.payload.sender), m2.payload.sender);
    chk('FSE-9', '★ 负向对照：缺 event_id / 缺时间 / 缺 chat_id ⇒ 映射失败', (() => {
      const bad1 = mapEvent({ id: '', msg: { create_time: AT, chat_id: 'c', content: '{"text":"x"}', message_type: 'text' } });
      const bad2 = mapEvent({ id: 'x', msg: { chat_id: 'c', content: '{"text":"x"}', message_type: 'text' } });
      const bad3 = mapEvent({ id: 'x', msg: { create_time: AT, content: '{"text":"x"}', message_type: 'text' } });
      return bad1.ok === false && bad2.ok === false && bad3.ok === false;
    })());
    chk('FSE-10', '空内容 ⇒ skip（不是错）', mapEvent({ id: 'x', msg: { create_time: AT, chat_id: 'c', message_type: 'text', content: '{"text":"  "}' } }).skip === true);

    // ③ 一轮：界内入流、界外出界
    const f = path.join(tmp, 'ev.ndjson');
    const old = Date.parse('2026-09-01T10:00:00+08:00');
    fs.writeFileSync(f, [evt('a', 'p2p', AT, '十月的新消息'), evt('b', 'group', old, '九月的老消息'), '[event] ready', ''].join('\n') + '\n', 'utf8');
    const r1 = ingestOnce({ file: f, now: AT });
    chk('FSE-11', '★ 一轮：认得出 2 条事件、界内 1 条入流、九月那条出界', r1.parsed === 2 && r1.outCount === 1 && r1.outOfScope === 1, JSON.stringify({ parsed: r1.parsed, out: r1.outCount, oos: r1.outOfScope }));
    chk('FSE-12', '库里 1 条消息', store.list({ type: 'message' }).length === 1, String(store.list({ type: 'message' }).length));
    const r2 = ingestOnce({ file: f, now: AT });
    chk('FSE-13', '★ 第二轮幂等：不新建', r2.outCount === 0 && store.list({ type: 'message' }).length === 1, JSON.stringify({ out: r2.outCount }));

    // ④ 没有事件文件时要说清（不写成"没有消息"）
    process.env.WB_V1_OUT = path.join(tmp, 'nowhere');
    chk('FSE-14', '★ 没有事件文件 ⇒ 写明"消费者未启动"（不写成没有消息）', /常驻消费者未启动/.test(ingestOnce({ file: null }).why), ingestOnce({ file: null }).why);
    process.env.WB_V1_OUT = tmp;

    // ⑤ 干跑不写盘
    const before = store.list({ type: 'message' }).length;
    ingestOnce({ file: f, dryRun: true, now: AT });
    chk('FSE-15', '干跑不写盘', store.list({ type: 'message' }).length === before);
  } finally {
    if (prevOut === undefined) delete process.env.WB_V1_OUT; else process.env.WB_V1_OUT = prevOut;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
