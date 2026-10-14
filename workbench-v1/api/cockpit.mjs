/**
 * v1/api/cockpit.mjs —— **驾驶舱数据层**（P7；需求 4.3）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 需求 4.3.6 的统计口径（照抄，一个都不许漏）
 *   消息数：总数 / 待处理 / 已处理
 *   日程数：总数 / 已进行 / 待进行
 *   待办数：总数 / 已完成 / 逾期 / 待完成
 *   笔记数：总数 / 标签数 / **可视化模型数**
 *
 * 本文件只做**纯数据**（可离线测、可复算）：统计 / 知识图谱 / 趋势切片。
 *   · 需要模型的三块（业务洞察 / 状态分析 / 发展建议）不在这里 —— 它们由 `narrative()` 走模型，
 *     且**必须先有真实数据切片**才允许调用（避免"没数据也生成一段分析"）。
 *   · 图谱只连**有真实依据**的边（同发信人 / 同客户目录 / 召回命中），不靠相似度硬凑关系。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import * as store from '../store.mjs';
import { isVisualBuilt } from '../store.mjs';   // ★ 唯一判定（收口 P0-2：此前这里有第二套算法，与 store 不一致）
import { messageState } from './pages.mjs';

const DAY = 86400000;
export const dayStart = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const ymd = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const isDone = (e) => (e.ops ?? []).some((o) => String(o.op ?? '') === 'done');
const hasOp = (e, n) => (e.ops ?? []).some((o) => String(o.op ?? '') === n);

/** 一、数据统计（需求 4.3.6 四组口径） */
export function stats({ now = Date.now() } = {}) {
  const msgs = store.list({ type: 'message' });
  const sch = store.list({ type: 'schedule' });
  const td = store.list({ type: 'todo' });
  const nt = store.list({ type: 'note' });

  const msgPending = msgs.filter((e) => messageState(e) === 'pending').length;
  const schDone = sch.filter(isDone).length;
  const tdDone = td.filter(isDone).length;
  const tdOverdue = td.filter((e) => !isDone(e) && e.payload?.due && Date.parse(e.payload.due) < dayStart(now)).length;
  const tags = new Set();
  for (const e of nt) for (const t of (e.payload?.tags ?? [])) tags.add(t);
  const visualModels = nt.filter(isVisualBuilt).length;

  return {
    messages: { total: msgs.length, pending: msgPending, processed: msgs.length - msgPending },
    schedules: { total: sch.length, done: schDone, upcoming: sch.length - schDone },
    todos: { total: td.length, done: tdDone, overdue: tdOverdue, open: td.length - tdDone - tdOverdue },
    notes: { total: nt.length, tags: tags.size, visualModels },
  };
}

/** 三、发展趋势：按日切片（纯数据；模型叙述由 narrative 负责） */
export function trend({ from = null, to = null, now = Date.now(), days = 30 } = {}) {
  const toMs = to ? Date.parse(to) + DAY : dayStart(now) + DAY;
  const fromMs = from ? dayStart(Date.parse(from)) : toMs - days * DAY;
  const buckets = new Map();
  // ★ 先建桶再放数：第一版写成 `put(t,'message') && ... -= 1` 想"预置后再减掉"，
  //   但 put 返回 undefined ⇒ 减一那半永远不执行 ⇒ **每个空日被塞了一条假消息**（合计直接虚高）。
  //   ⇒ 分成 ensure（只建桶、不计数）与 put（只计数）两个函数，语义不会含糊。
  const ensure = (ms) => {
    const k = ymd(ms);
    if (!buckets.has(k)) buckets.set(k, { date: k, message: 0, note: 0, todo: 0, schedule: 0, todoDone: 0, scheduleDone: 0 });
    return buckets.get(k);
  };
  const put = (ms, type) => { ensure(ms)[type] += 1; };
  const lastDay = dayStart(toMs - DAY);
  for (let t = dayStart(fromMs); t <= lastDay; t += DAY) ensure(t);
  for (const type of ['message', 'note', 'schedule']) for (const e of store.list({ type })) if (e._at >= fromMs && e._at < toMs) put(e._at, type);
  for (const e of store.list({ type: 'todo' })) {
    if (e._at >= fromMs && e._at < toMs) put(e._at, 'todo');
    const d = (e.ops ?? []).find((o) => o.op === 'done');
    if (d?.at) { const ms = Date.parse(d.at); if (ms >= fromMs && ms < toMs) put(ms, 'todoDone'); }
  }
  for (const e of store.list({ type: 'schedule' })) {
    const d = (e.ops ?? []).find((o) => o.op === 'done');
    if (d?.at) { const ms = Date.parse(d.at); if (ms >= fromMs && ms < toMs) put(ms, 'scheduleDone'); }
  }
  const series = [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
  const sum = (k) => series.reduce((n, r) => n + r[k], 0);
  return {
    from: ymd(fromMs), to: ymd(toMs - DAY), days: series.length, series,
    totals: { message: sum('message'), note: sum('note'), todo: sum('todo'), schedule: sum('schedule'), todoDone: sum('todoDone'), scheduleDone: sum('scheduleDone') },
  };
}

/** 二、知识图谱：节点 + **有依据的**边（同发信人 / 同客户目录 / 召回命中） */
export function graph({ maxNodes = 200, now = Date.now() } = {}) {
  const nodes = new Map(); const edges = [];
  const addNode = (id, kind, label, extra = {}) => { if (!nodes.has(id)) nodes.set(id, { id, kind, label, ...extra }); return id; };
  const addEdge = (a, b, kind, why) => { if (a && b && a !== b) edges.push({ from: a, to: b, kind, why }); };

  const events = [];
  for (const t of ['message', 'note', 'todo', 'schedule']) for (const e of store.list({ type: t })) events.push(e);
  events.sort((a, b) => b._at - a._at);

  const bySender = new Map();
  for (const e of events) {
    const nid = addNode(e._id, e.type, String(e.payload?.topic ?? e.payload?.summary ?? e.payload?.raw ?? e._id).slice(0, 40));
    const sender = String(e.payload?.sender ?? e.payload?.publisher ?? '').trim();
    if (sender) {
      const sid = addNode(`sender:${sender}`, 'sender', sender);
      addEdge(nid, sid, 'from', '同一发信人');
      bySender.set(sender, [...(bySender.get(sender) ?? []), nid]);
    }
    // 召回命中 ⇒ 与知识库文档建立边（真实依据：分析引擎召回过它）
    for (const h of (e.context?.recalled ?? []).slice(0, 3)) {
      if (!h?.path) continue;
      const docId = addNode(`doc:${h.path}`, 'doc', h.path.split('/').pop(), { path: h.path });
      addEdge(nid, docId, 'recalled', `分析引擎召回（相似度 ${h.similarity ?? '-'}）`);
    }
  }
  // 同一发信人下的多条 ⇒ 两两相连（限流，避免爆边）
  for (const [sender, ids] of bySender) {
    const cap = ids.slice(0, 8);
    for (let i = 1; i < cap.length; i++) addEdge(cap[i - 1], cap[i], 'same-sender', `同属「${sender}」的消息流`);
  }

  const nodeList = [...nodes.values()].slice(0, maxNodes);
  const keep = new Set(nodeList.map((n) => n.id));
  const keptEdges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  return {
    nodes: nodeList, edges: keptEdges,
    counts: { nodes: nodeList.length, edges: keptEdges.length, byKind: nodeList.reduce((m, n) => { m[n.kind] = (m[n.kind] ?? 0) + 1; return m; }, {}) },
    note: '边只来自真实依据（同一发信人 / 分析引擎召回命中），不靠相似度硬凑',
  };
}

/**
 * **四块的落点**（2026-10-12 补齐；需求 4.3.2–4.3.5 逐条点名，此前只有一句泛泛的 ask）
 *
 * ★ 为什么必须写死成结构：这四块不是"写点分析"，是**各有指定动作**的 ——
 *   4.3.2 点名五种方法、4.3.3 点名七个维度、4.3.4 点名六个方面、4.3.5 点名 SWOT × 三时段。
 *   只给模型一句"找出业务规律"，它一定会给一段读起来像分析的散文，而**点名的那几项会漏**。
 *   ⇒ 把要求写成逐项清单，并让每项**必须回指到数据切片里的具体数字**（"只依据材料、不编"）。
 */
export const NARRATIVE_SPECS = Object.freeze({
  trend: {
    label: '发展趋势',
    ask: '做业务趋势演进分析：还原"当时的信息集 + 当时的判断 + 当时的动作"，找机遇漏判与风险盲区',
    // 需求 4.3.2 的五种分析，**一种一段，不许合并**
    methods: Object.freeze([
      ['情景还原', '按时间顺序还原那几天实际发生了什么（谁、什么时候、做了什么），只写切片里有的事'],
      ['事件归因', '把结果回溯到当时的信息与判断：哪些动作带来了进展，哪些停滞有前因'],
      ['决策树回溯', '当时可选的几条路，实际走了哪条、放弃了哪条（切片看不出来的就写"切片里看不到"）'],
      ['噪声分离', '把偶发噪声（一次性的杂音）与真信号（重复出现的模式）分开'],
      ['反事实分析', '如果当时做了另一个选择，可能怎样 —— 用于指出**机遇漏判**与**风险盲区**'],
    ]),
    shape: '按上面五种方法，**每种一段**（段首写方法名），每段不超过 150 字；结尾给一句"最该补的那件事"',
  },
  insight: {
    label: '业务/项目复盘',
    ask: '按业务单元（项目 / 业务线）复盘全过程，逐维度洞察',
    unitGuide: '先按数据切片里的发信人 / 目录 / 主题把内容归到**业务单元**（项目或业务线）；归不进去的写"未能归属"，不要硬塞',
    // 需求 4.3.3 的七个维度（用户 8.3 逐字点名，一维不许漏）
    dimensions: Object.freeze(['业务逻辑', '决策与执行', '组织与能力', '机遇与风险', '客户与市场', '财务与资源', '规律与机制']),
    shape: '先写"业务单元"清单（每个一行：它是什么 + 切片里的依据），再按上面七个维度逐条写（每条约 80 字）；某一维度切片里没材料就写"切片里没有这方面的材料"',
    // ★★ 2026-10-14 加（用户 8.3）：「抽离出库内**单个项目或某条业务线**，按业务单元维度，
    //   即**对象或域**，进行复盘。**对进行中的业务线或项目，复盘到截止当时已有的所有信息。**」
    //   ⇒ 这一块支持**指定一个单元**只复盘它；不指定就复盘全部单元（原来只有这一种）。
    unitSelectable: true,
  },
  // ★★ 2026-10-14 加（用户 8.4 原话）：
  //   「**全盘业务分析**：结合库内的方法论，对全盘业务进行分析。从以下方面进行分析：
  //     战略；执行；机制；能力；市场；资源；方法论及认知迭代。实时将最准确的业务状态呈现出来。」
  //   与 `insight`（单个项目/业务线复盘）**是两件事**，所以**分开两块**：
  //     · insight   = 挑一个单元往里看（8.3）
  //     · analysis  = 站在全部业务上方看（8.4）
  //   ⚠️ 两者的 `dimensions` 看着像，但落点不同：8.3 的七维是"这个项目怎么样"，
  //     8.4 的七方面是"我这一摊子怎么样"。合并成一块必然两头都写不深。
  analysis: {
    label: '全盘业务分析',
    ask: '结合库内方法论，对**全盘业务**做一次分析，把当前最准确的业务状态呈现出来',
    dimensions: Object.freeze(['战略', '执行', '机制', '能力', '市场', '资源', '方法论及认知迭代']),
    shape: '按上面七个方面逐条写（每条约 80 字）；每条给一个判断（在推进 / 停住了 / 看不清），并指出这条判断依据的是切片里的哪一个数；最后一句写"最不确定的是哪一项"',
  },
  state: {
    label: '状态分析',
    ask: '结合库内方法论，把当前最准确的业务状态呈现出来',
    // 需求 4.3.4 的六个方面
    dimensions: Object.freeze(['战略', '执行', '机制', '能力', '市场', '资源', '方法论及认知迭代']),
    shape: '按上面几个方面逐条写（每条约 80 字），每条给出"在推进 / 停住了 / 看不清"三者之一作为判断；最后一句写"最不确定的是哪一项"',
  },
  advice: {
    label: '发展建议',
    ask: '结合发展趋势 + 洞察结果 + 业务状态，推演未来并给发展建议',
    // 需求 4.3.5：三时段 × 外部环境/组织能力/资源市场，落成 SWOT
    horizons: Object.freeze([['短期', '1 个月'], ['中期', '3 个月'], ['长期', '1 年']]),
    swotAxes: Object.freeze(['外部环境', '组织能力', '资源市场']),
    shape: '先按 S（优势）/ W（劣势）/ O（机会）/ T（威胁）**四组**写；再按短期(1月) / 中期(3月) / 长期(1年) **三段**，每段覆盖"外部环境 / 组织能力 / 资源市场"三面；最后给"谁、什么时候、做什么"的下一步',
  },
});

/**
 * **业务单元清单**（用户 8.3 要的"按业务单元维度，即**对象或域**"）。
 *
 * 口径（照用户的话办，不自己发明）：
 *   · 群聊消息 ⇒ 单元 = **群名**（那就是一条业务线：某个客户的群、某个项目的群）
 *   · 单聊     ⇒ 单元 = **发信人**（对象）
 *   · 笔记/日程/待办 ⇒ 单元 = 它自己的来源客户端名或主题前缀；实在归不进去的
 *     归到「未能归属」—— **如实列出来**，不硬塞进某个单元（硬塞会让人以为归好了）。
 *
 * 返回按条数降序，带每单元的事件数（页面据此让人挑一个去复盘）。
 */
export function units({ now = Date.now() } = {}) {
  const map = new Map();
  const put = (name, kind) => {
    const k = String(name || '').trim() || '未能归属';
    if (!map.has(k)) map.set(k, { name: k, total: 0, by: { message: 0, note: 0, todo: 0, schedule: 0 } });
    const u = map.get(k); u.total += 1; u.by[kind] = (u.by[kind] ?? 0) + 1;
  };
  for (const e of store.list({ type: 'message' })) {
    const p = e.payload ?? {};
    put(p.isDirect === true ? (p.sender ?? '') : (p.conversationName ?? p.conversationId ?? ''), 'message');
  }
  for (const e of store.list({ type: 'note' })) {
    const p = e.payload ?? {};
    // 笔记没有"群"这个概念 ⇒ 用主题里最靠前的那一段当单元锚（形如「客户名 · 事项」）
    put(String(p.topic ?? '').split(/[·|｜:：\-—]/)[0], 'note');
  }
  for (const e of store.list({ type: 'todo' })) put(String(e.payload?.topic ?? '').split(/[·|｜:：\-—]/)[0], 'todo');
  for (const e of store.list({ type: 'schedule' })) put(String(e.payload?.topic ?? '').split(/[·|｜:：\-—]/)[0], 'schedule');
  const list = [...map.values()].sort((a, b) => b.total - a.total);
  return {
    list,
    note: '单元口径：群聊取群名（一条业务线）· 单聊取发信人（对象）· 笔记/日程/待办取主题首段。'
      + '归不进任何单元的归到「未能归属」并如实列出（不硬塞）。',
    counts: { units: list.length, events: list.reduce((n, u) => n + u.total, 0) },
  };
}

/** 需要模型的三块：先取真实数据切片，再交给模型；**没数据就不调** */
export function sliceFor(kind, { from = null, to = null, now = Date.now(), unit = null } = {}) {
  const s = stats({ now }); const t = trend({ from, to, now }); const g = graph({ now });
  const spec = NARRATIVE_SPECS[kind];
  const byKind = { trend: '发展趋势', insight: '业务/项目复盘', analysis: '全盘业务分析', state: '状态分析', advice: '发展建议' };
  const sl = { kind, label: byKind[kind] ?? kind, ask: spec?.ask ?? '', spec: spec ?? null, stats: s, trend: t, graphCounts: g.counts, events: t.totals };
  // ★ 2026-10-14（用户 8.3）：复现"单个项目或某条业务线"时把**单元清单**带进材料，
  //   并在指定了单元时把范围收窄到它 —— 让模型能真的"只看这一个"。
  if (spec?.unitSelectable) {
    const u = units({ now });
    sl.units = { note: u.note, list: u.list.slice(0, 40).map((x) => ({ name: x.name, total: x.total, by: x.by })) };
    sl.selectedUnit = unit ? String(unit) : null;
    if (unit) {
      sl.ask = `${sl.ask}。**只看「${unit}」这一个单元**，别的单元的内容一概不要写进来。`;
    } else {
      sl.ask = `${sl.ask}。**先把全部单元列出来**，再逐个复盘（单元多的挑条数最多的前几个）。`;
    }
  }
  return sl;
}
/** 按 kind 拼提示词里的"逐项要求"（**四块的要求都是显式清单**，不是一句泛泛的话） */
export function specLines(kind) {
  const sp = NARRATIVE_SPECS[kind];
  if (!sp) return [];
  const L = [];
  if (sp.methods) { L.push('必须逐项分析（**一种一段**，段首写方法名，不许合并、不许漏项）：'); for (const [n, d] of sp.methods) L.push(`  · ${n}：${d}`); }
  if (sp.unitGuide) L.push(`业务单元口径：${sp.unitGuide}`);
  if (sp.dimensions) { L.push('必须逐项覆盖（一个不许漏）：'); for (const d of sp.dimensions) L.push(`  · ${d}`); }
  if (sp.horizons) { L.push(`时间跨度（三段都要写）：${sp.horizons.map((h) => `${h[0]}(${h[1]})`).join(' / ')}`); L.push(`每段必须覆盖：${sp.swotAxes.join(' / ')}`); }
  if (kind === 'advice') L.push('SWOT 四组都要写：S 优势 / W 劣势 / O 机会 / T 威胁');
  if (sp.shape) L.push(`输出形态：${sp.shape}`);
  return L;
}
export function hasEnoughData(slice) {
  const e = slice?.events ?? {};
  return (e.message + e.note + e.todo + e.schedule) > 0;
}

// ── 模型三块的生成与读取 ──────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { KB_ROOT as ROOT } from '../paths.mjs';   // 路径收口（见 paths.mjs 顶部说明：原先按本文件深度往上数，包一挪就错）

const HERE = path.dirname(fileURLToPath(import.meta.url));
export function narrativeDir() { return path.join(process.env.WB_V1_OUT || path.join(ROOT, '_meta', 'out', 'v1'), 'cockpit'); }
export function narrativeFile(kind) { return path.join(narrativeDir(), `${kind}.json`); }
const fpOf = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);

/** 读已生成的那一块（没有就返回 null —— 页面据此显示"尚未生成"） */
export function readNarrative(kind) {
  try { return JSON.parse(fs.readFileSync(narrativeFile(kind), 'utf8')); } catch { return null; }
}

/**
 * 生成一块（幂等：输入指纹没变就直接返回旧的，不重复调模型）
 * @param {'insight'|'state'|'advice'} kind
 * @param {{from?:string,to?:string,now?:number,modelFn?:Function,force?:boolean}} o
 */
export async function narrative(kind, { from = null, to = null, now = Date.now(), modelFn = null, force = false, unit = null } = {}) {
  const sl = sliceFor(kind, { from, to, now, unit });
  if (!hasEnoughData(sl)) {
    // ★ 规矩：没有真实数据切片就不调模型（不给它机会生成"没数据也像模像样"的分析）
    return { ok: false, refused: true, why: `区间内没有事件（${JSON.stringify(sl.events)}）⇒ 按规矩不调用模型`, kind, label: sl.label };
  }
  // ★★ 2026-10-14 加（用户 8.3）：`unit` 要进**材料**、**指纹**、**落盘**三处，一处都不能漏：
  //   · 进材料 ⇒ 模型才看得到"有哪些单元、这次只看哪个"；
  //   · 进指纹 ⇒ **换一个单元必须重算**（只进材料不进指纹，换个单元会命中上次的缓存、拿到别人的复盘）；
  //   · 进落盘 ⇒ 页面重开时能显示"这次复盘的是哪个单元"。
  // ★★ 2026-10-14 加：**给模型的材料必须限长**。
  //
  //   来由（真机实测）：加上「全盘业务分析」之后，生成一直卡着不回来 ——
  //   我先怀疑模型不通，单独拿一句短提示词试，**2.9 秒就回来了**。
  //   所以卡的不是模型，是**我塞给它的材料太大**（整条趋势序列 + 全量图谱计数 + 单元清单）。
  //
  //   ⇒ 材料只保留**人能看的那点量**：
  //     · 趋势序列：只给**最近 40 天**（再往前对"当前状态"没有增量信息，只是把提示词撑长）；
  //     · 单元清单：只给条数最多的 **20 个**；
  //     · 兜底：整段材料序列化之后超过 24000 字就**截断并如实标注**（不静默丢）。
  //   ⚠️ 截断要**说出来**（`truncated: true` 进材料），否则模型会把"没给它"当成"没有"，
  //     然后写出"切片里没有这方面的材料" —— 那是被我自己截出来的假象。
  const slimSeries = (sl.trend.series ?? []).slice(-40);
  const materialObj = {
    // ★★ 2026-10-14 加这段说明（**真机生成的结果逼出来的**）：
    //   模型在「执行」那一条里写了「stats.todos.done=11、stats.schedules.done=9 显示完成；
    //   但 totals.todoDone=0、totals.scheduleDone=0 与前者冲突」—— 它把这个当成了数据矛盾。
    //   **它没看错，是我没说清**：`stats` 是**全时**的口径，`totals` 是**这个区间内**的口径。
    //   两个数都真，只是范围不同。不说清就会出现两种坏结果：
    //     ① 模型花一段去"解释矛盾"（浪费篇幅，而且听起来像发现了问题）；
    //     ② 更坏的是它据此怀疑整份数据不可信，后面几条都写"看不清"。
    //   ⇒ 把口径写在材料里，并明确"两个数范围不同、不是矛盾"。
    scopeNote: '【口径说明，先看这一条】stats 是**全时**（从有记录起到现在），trend.totals 是**本区间内**的和。'
      + '所以 stats.todos.done 与 totals.todoDone 数字不同是**正常的**（范围不同），**不是数据矛盾**，不要拿它们互相印证或据此说数据不可信。'
      + '判断"某件事有没有在推进"要看**本区间的 totals 与 series**；判断"总共积累了多少"才看 stats。',
    stats: sl.stats,
    totals: sl.trend.totals,
    series: slimSeries,
    seriesNote: sl.trend.series.length > slimSeries.length
      ? `趋势序列只给了最近 ${slimSeries.length} 天（共 ${sl.trend.series.length} 天）—— 更早的天数没有放进来，不要据此判断"那几天没有事件"`
      : `趋势序列共 ${slimSeries.length} 天，全部给出`,
    graph: sl.graphCounts,
    ...(sl.units ? { units: { note: sl.units.note, list: sl.units.list.slice(0, 20) } } : {}),
  };
  let material = JSON.stringify(materialObj);
  const LIMIT = 24000;
  let truncated = false;
  if (material.length > LIMIT) { material = material.slice(0, LIMIT); truncated = true }
  if (truncated) material += '\n…（材料过长已截断：只给了前一部分，**不要据此判断"剩下的没有"**）';
  const fp = fpOf(sl.ask + material);
  const prev = readNarrative(kind);
  if (!force && prev && prev.fp === fp) return { ok: true, cached: true, kind, label: sl.label, text: prev.text, fp, unit: prev.unit ?? null };

  const prompt = [
    '你在为业务驾驶舱写一块分析。要求：先给判断，再给理由，最后给下一步；**只依据下面的真实数据，不要编**。',
    '材料里没有的，就写"切片里没有这方面的材料" —— 不许用常识补，也不许写成看起来像分析的散文。',
    `这一块是：${sl.label}。${sl.ask}`,
    ...specLines(kind),
    '',
    `【真实数据切片】（区间 ${sl.trend.from} ~ ${sl.trend.to}${sl.selectedUnit ? ` · 只复盘单元「${sl.selectedUnit}」` : ''}）`,
    material,
  ].join('\n');

  // ★★ 2026-10-14 加：**挂住就短一点再试**（真机实测逼出来的）。
  //
  //   实测事实（都量过）：
  //     · 一句短提示词 ⇒ 2.9 秒回来；
  //     · 长度 / 换行 / 中文 / JSON / 单引号 六种形状全试过 ⇒ 都通（最长 2005 字，3 秒）；
  //     · **这一块的提示词（3625 字）⇒ 300 秒拿不回来**（`spawnSync powershell.exe ETIMEDOUT`）。
  //   ⇒ 卡住的**不是形式，是这一段真实内容**让模型想得太久（或者它自己卡住了）。
  //     我没有它的内部状态可看，所以不去猜原因，改成**工程上能兜住的**：
  //     第一次给全量；拿不回来就把材料**砍到一半**再试一次；再不行就如实报失败。
  //
  //   ⚠️ **重试这件事与"用不用桩"无关**，所以第一版把重试写在"真模型"那条分支里是错的：
  //     注入桩时根本不走那段 ⇒ 想验"减料重试"都验不了（真机自检当场露馅）。
  //     ⇒ 现在两条路都走同一个 `callOnce`，桩也能验重试路径。
  //   ⚠️ 减料要**写进材料**（"材料被压缩过"那句），否则模型会把"没给它"当成"没有"，
  //     然后写出"切片里没有这方面的材料" —— 那是被我砍出来的假象。
  //   ⚠️ 两次都失败就**如实报失败**，不返回半截文本冒充分析。
  //
  //   ★ 重试分层想清楚（第一版混在一起，桩验时"减料重试"标记没置上，读起来也乱）：
  //     · **偶发不答**（同一段提示词重发就好）⇒ 由 `runModelWithRetry` 在**真模型那一层**管；
  //     · **内容让它想太久**（重发也没用）⇒ 由这里管：换一段更短的提示词。
  //     两层各管一个病，**注入桩时只验第二层**（桩不会偶发，它每次都按你写的回）。
  const callOnce = async (p) => {
    if (modelFn) return modelFn(p);
    const { runModelInWorker } = await import('../processor/analyze.mjs');
    // ★★ 2026-10-14：**这一块的提示词是多行的，必须走文件那条路**（`viaFile: true`）。
    //   真机实测的经过：五块全部"失败"，报的是 `Unexpected argument: +` / `/` ——
    //   提示词里的加号、斜杠、星号在命令行里被当成了**独立参数**，
    //   而报出来的样子**像模型故障**（我先怀疑模型、又怀疑提示词太长，都猜错了方向）。
    //   `runModel`（走 `--message`）只适合**单行短提示词**；多行的走 `--messages-file`。
    return runModelInWorker(p, { timeoutMs: 240000, retries: 1, viaFile: true });
  };
  let m = await callOnce(prompt);
  // ★ 只有**超时**才走减料重试（2026-10-14 想清楚的一层）。
  //
  //   理由：减料治的是"**模型想得太久**"，不是"调用报错了"。
  //     普通失败（模型服务报错、返回非 0）再发一段短的一样会失败，
  //     白白多调一次模型（驾驶舱一次调用是要花时间的）。
  //   ⇒ 判据就一条：失败理由里带 ETIMEDOUT / 超时 / timeout。
  //   ⚠️ 这条同时也让"普通失败"的行为变得可预期：**失败就是失败，不折腾**。
  const isTimeout = (x) => /ETIMEDOUT|timed?\s?out|超时/i.test(String(x?.why ?? ''));
  if (m.ok !== true && isTimeout(m)) {
    // ★ 压缩要**真的压下去**。第一版写的是 `Math.max(4000, material.length / 2)` ——
    //   而材料只有 3275 字 ⇒ 那个 4000 的下限**比材料本身还长** ⇒ 一个字都没砍掉
    //   （实测：3656 → 3531，只少了 125 字）。检查当场抓到"压缩版确实更短"勉强过、
    //   但"减料重试"这条路的用意完全落空。
    //   ⇒ 改成**按比例压整段提示词**（材料和逐项要求一起压），并且下限设小（600 字）。
    //     理由：卡的是"模型要想多久"，与哪一段被砍无关 —— 所以压总长最直接。
    const slimPrompt = prompt.replace(material, material.slice(0, Math.max(600, Math.floor(material.length * 0.4))))
      + '\n（注意：材料被压缩过，**不要据此判断"没提到的就没有"**）';
    const slim = slimPrompt.length < prompt.length * 0.8
      ? slimPrompt
      : prompt.slice(0, Math.max(1200, Math.floor(prompt.length * 0.6))) + '\n（材料被压缩过，不要据此判断"没提到的就没有"）';
    const second = await callOnce(slim);
    if (second.ok === true) m = { ...second, retried: 'slim', firstWhy: m.why };
    else m = { ok: false, why: `两次都不行 —— 全量：${String(m.why).slice(0, 80)} ／ 压缩后：${String(second.why).slice(0, 80)}` };
  }
  if (m.ok !== true) return { ok: false, why: `模型未产出：${m.why}`, kind, label: sl.label, fp };

  const doc = { kind, label: sl.label, ask: sl.ask, from: sl.trend.from, to: sl.trend.to, fp, at: new Date().toISOString(), text: m.text, events: sl.events, unit: sl.selectedUnit };
  try {
    fs.mkdirSync(narrativeDir(), { recursive: true });
    const tmp = `${narrativeFile(kind)}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, narrativeFile(kind));
  } catch (e) { return { ok: false, why: `写入失败：${e.message}`, kind, fp }; }
  // ★ 2026-10-14：`retried` 要**带出来**。第一版在 `m` 上标了却没写进返回值 ⇒
  //   外面永远看不到"这次是减料之后才成功的"（自检当场抓到 `retried=undefined`）。
  //   它有用处：连续几次都走减料，说明材料对不同模型都太重，该改的是材料本身，不是重试。
  return { ok: true, cached: false, kind, label: sl.label, text: m.text, fp, unit: sl.selectedUnit, retried: m.retried ?? null, firstWhy: m.firstWhy ?? null };
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检
// ══════════════════════════════════════════════════════════════════════════════
export async function selfTest() {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { makeEvent } = await import('../schema.mjs');

  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });
  const prev = process.env.WB_V1_OUT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v1-cockpit-'));
  process.env.WB_V1_OUT = tmp;
  const NOW = Date.parse('2026-10-12T10:00:00+08:00');
  const D = (s, hh = '09:00') => Date.parse(`${s}T${hh}:00+08:00`);

  try {
    const msg = (mid, raw, ops = []) => { const e = makeEvent({ type: 'message', payload: { channel: 'dingtalk', sender: '张伟', raw, source: 'im', modality: 'text', summary: raw.slice(0, 20) }, origin: { channel: 'dingtalk', sender: '张伟', messageId: mid }, _at: D('2026-10-10') }).event; e.ops = ops; e.context = { recalled: [{ path: 'Work/示例客户甲/x.md', similarity: 0.66, text: 't' }] }; return store.upsert(e); };
    msg('m1', '待处理的一条');
    msg('m2', '已回复的一条', [{ op: 'replied' }]);
    const td = (mid, topic, due, ops = []) => { const e = makeEvent({ type: 'todo', payload: { topic, detail: 'd', due, executor: '我' }, origin: { channel: 'manual', sender: '我', messageId: mid }, _at: D('2026-10-09') }).event; e.ops = ops; return store.upsert(e); };
    td('t1', '逾期的', '2026-10-09');
    td('t2', '已完成的', '2026-10-12', [{ op: 'done', at: '2026-10-11T10:00:00+08:00' }]);
    const sch = (mid, topic, start, ops = []) => { const e = makeEvent({ type: 'schedule', payload: { topic, start, end: start }, origin: { channel: 'manual', sender: '我', messageId: mid }, _at: D('2026-10-11') }).event; e.ops = ops; return store.upsert(e); };
    sch('s1', '已开完', '2026-10-10T14:00', [{ op: 'done', at: '2026-10-11T08:00:00+08:00' }]);
    sch('s2', '待开', '2026-10-15T14:00');
    const nt = makeEvent({ type: 'note', payload: { topic: 'A', date: '2026-10-05', content_md: 'x', tags: ['采集', '设计'] }, origin: { channel: 'manual', sender: '我', messageId: 'n1' }, _at: D('2026-10-05') }).event;
    nt.analysis = { by: 'model', text: 't', visual: { suggested: 'coordinates', why: 'w' } }; store.upsert(nt);

    const S = stats({ now: NOW });
    chk('CKT-1', '★ 消息：总数/待处理/已处理', S.messages.total === 2 && S.messages.pending === 1 && S.messages.processed === 1, JSON.stringify(S.messages));
    chk('CKT-2', '★ 日程：总数/已进行/待进行', S.schedules.total === 2 && S.schedules.done === 1 && S.schedules.upcoming === 1, JSON.stringify(S.schedules));
    chk('CKT-3', '★ 待办：总数/已完成/逾期/待完成', S.todos.total === 2 && S.todos.done === 1 && S.todos.overdue === 1 && S.todos.open === 0, JSON.stringify(S.todos));
    chk('CKT-4', '★ 笔记：总数 / 标签数 / 可视化模型数（**只算真建出来的**）', S.notes.total === 1 && S.notes.tags === 2 && S.notes.visualModels === 0, JSON.stringify(S.notes));
    // ★ CKT-50/51（P0-2 收口）：这个夹具**故意只给建议、不给 built** ——
    //   收口前 `api/cockpit.mjs` 数的是"`analysis.visual` 存在"，会把这条算成 1 个可视化模型（假绿）。
    //   现在判定统一走 `store.isVisualBuilt`（唯一一份），所以 0 才是如实；建出来之后才变 1。
    //   （编号说明：本文件 CKT-1..22 已占用，故新号段取 50 起，避免撞号。）
    chk('CKT-50', '★ 只有建议、没真建 ⇒ 可视化模型数**不算**它（收口前这里会算成 1）', S.notes.visualModels === 0, `visualModels=${S.notes.visualModels} visual=${JSON.stringify(nt.analysis.visual)}`);
    { const n2 = store.getById('note', nt._id); store.patch('note', n2._id, { analysis: { ...n2.analysis, visual: { ...n2.analysis.visual, built: true, tool: 'coordinates', ref: '/x.json' } } }); }
    chk('CKT-51', '★ 真建出来（built=true）⇒ 才计 1（两处口径同源）', stats({ now: NOW }).notes.visualModels === 1 && store.stats(new Date(NOW)).notes.visualized === 1, JSON.stringify({ cockpit: stats({ now: NOW }).notes.visualModels, storeVisualized: store.stats(new Date(NOW)).notes.visualized }));

    const T = trend({ from: '2026-10-05', to: '2026-10-12', now: NOW });
    chk('CKT-5', '★ 趋势按日切片且区间正确（8 天）', T.days === 8 && T.from === '2026-10-05' && T.to === '2026-10-12', JSON.stringify({ days: T.days, from: T.from, to: T.to }));
    chk('CKT-6', '趋势合计与统计一致（消息 2 条）', T.totals.message === 2, JSON.stringify(T.totals));
    chk('CKT-7', '★ 完成动作按"完成时刻"落桶（不是创建日）', T.series.find((r) => r.date === '2026-10-11')?.todoDone === 1, JSON.stringify(T.series.map((r) => [r.date, r.todoDone])));
    chk('CKT-8', '空日被预置（趋势图不会断）', T.series.length === 8, String(T.series.length));

    const G = graph({ now: NOW });
    chk('CKT-9', '★ 图谱节点含事件与发信人', G.counts.byKind.message === 2 && G.counts.byKind.sender === 1, JSON.stringify(G.counts));
    chk('CKT-10', '★ 召回命中 ⇒ 与知识库文档建边（真实依据）', G.edges.some((e) => e.kind === 'recalled' && e.to.startsWith('doc:')), JSON.stringify(G.edges.filter((e) => e.kind === 'recalled').slice(0, 2)));
    chk('CKT-11', '★ 负向对照：没有依据就不连边（不靠相似度硬凑）', G.edges.every((e) => ['from', 'recalled', 'same-sender'].includes(e.kind)), JSON.stringify([...new Set(G.edges.map((e) => e.kind))]));
    chk('CKT-12', '★ 图谱写明了边的来源口径', /真实依据/.test(G.note));

    const sl = sliceFor('insight', { from: '2026-10-05', to: '2026-10-12', now: NOW });
    chk('CKT-13', '★ 模型三块的输入切片带真实数据（统计+趋势+图谱计数）', sl.stats.messages.total === 2 && sl.trend.totals.note === 1 && typeof sl.graphCounts.nodes === 'number');
    chk('CKT-14', '★ 有数据才允许调模型（没数据不生成分析）', hasEnoughData(sl) === true && hasEnoughData({ events: { message: 0, note: 0, todo: 0, schedule: 0 } }) === false);
    // ★★ 2026-10-14 改：原来写死 `sliceFor('insight').label === '业务洞察'`。
    //   用户 8.3/8.4 把那一块拆成**两件事**（项目复盘 / 全盘分析）之后，标签变了 ⇒ 当场红。
    //   **红得对**，它守的"标签与提问各不相同"没变，只是把**当时的标签字面**也写进去了。
    //   ⇒ 标签字面留给文案去改（那本来就会变）；这里只守**各不相同**这个不变式。
    chk('CKT-15', '★ 每块的标签与提问各不相同（标签字面不写死 —— 文案会改）', (() => {
      const kinds = ['trend', 'insight', 'analysis', 'state', 'advice'];
      const labels = kinds.map((k) => sliceFor(k).label);
      const asks = kinds.map((k) => sliceFor(k).ask);
      return new Set(labels).size === kinds.length && new Set(asks).size === kinds.length
        && labels.every((x) => x && x.length >= 2) && asks.every((x) => x && x.length > 10);
    })(), JSON.stringify(['trend', 'insight', 'analysis', 'state', 'advice'].map((k) => sliceFor(k).label)));

    // ★ CKT-52…56（P4）：四块的落点**逐项照需求写死**（需求 4.3.2–4.3.5 点名的那几项，一项都不许漏）
    chk('CKT-52', '★ 四块都在（含趋势那块：需求 4.3.2 的五种分析）', ['trend', 'insight', 'state', 'advice'].every((k) => Object.keys(NARRATIVE_SPECS).includes(k)), JSON.stringify(Object.keys(NARRATIVE_SPECS)));
    chk('CKT-53', '★ 趋势：需求点名的**五种方法**逐条在（情景还原/事件归因/决策树回溯/噪声分离/反事实分析）', (() => {
      const want = ['情景还原', '事件归因', '决策树回溯', '噪声分离', '反事实分析'];
      const got = NARRATIVE_SPECS.trend.methods.map((m) => m[0]);
      return want.every((w) => got.includes(w)) && got.length === want.length;
    })(), JSON.stringify(NARRATIVE_SPECS.trend.methods.map((m) => m[0])));
    chk('CKT-54', '★ 业务洞察：需求点名的**七个维度**逐条在', (() => {
      const want = ['业务逻辑', '决策与执行', '组织与能力', '机遇与风险', '客户与市场', '财务与资源', '规律与机制'];
      return want.every((w) => NARRATIVE_SPECS.insight.dimensions.includes(w)) && NARRATIVE_SPECS.insight.dimensions.length === want.length;
    })(), JSON.stringify(NARRATIVE_SPECS.insight.dimensions));
    chk('CKT-55', '★ 洞察按**业务单元**（项目/业务线）复盘，且不许硬塞归属', /业务单元/.test(NARRATIVE_SPECS.insight.unitGuide) && /不要硬塞/.test(NARRATIVE_SPECS.insight.unitGuide), NARRATIVE_SPECS.insight.unitGuide);
    chk('CKT-56', '★ 发展建议：SWOT 四组 + 短期/中期/长期三段 + 三面（外部环境/组织能力/资源市场）', (() => {
      const L = specLines('advice').join('\n');
      const hz = NARRATIVE_SPECS.advice.horizons.map((h) => h[0]);
      return /SWOT/.test(L) && ['S 优势', 'W 劣势', 'O 机会', 'T 威胁'].every((s) => L.includes(s)) && hz.every((h) => L.includes(h)) && NARRATIVE_SPECS.advice.swotAxes.every((a) => L.includes(a));
    })(), specLines('advice').join(' | '));
    chk('CKT-57', '★ 提示词把"逐项"写进去（不是一句泛泛的话）', specLines('trend').some((l) => /一种一段/.test(l)) && specLines('insight').some((l) => /一个不许漏/.test(l)) && specLines('state').some((l) => /逐条/.test(l)));
    chk('CKT-58', '★ 材料里没有的必须写"切片里没有材料"（不许用常识补）', /切片里没有这方面的材料/.test(specLines('insight').join('\n')));
    chk('CKT-59', '★ 状态分析：需求点名的六个方面都在（含"方法论及认知迭代"）', (() => {
      const want = ['战略', '执行', '机制', '能力', '市场', '资源', '方法论及认知迭代'];
      return want.every((w) => NARRATIVE_SPECS.state.dimensions.includes(w));
    })(), JSON.stringify(NARRATIVE_SPECS.state.dimensions));

    // ★★ 2026-10-14 加（用户 8.3 / 8.4）：
    chk('CKT-60', '★★ 全盘业务分析：用户 8.4 点名的**七个方面**逐条在', (() => {
      const want = ['战略', '执行', '机制', '能力', '市场', '资源', '方法论及认知迭代'];
      const got = NARRATIVE_SPECS.analysis.dimensions;
      return want.every((w) => got.includes(w)) && got.length === want.length;
    })(), JSON.stringify(NARRATIVE_SPECS.analysis.dimensions));
    chk('CKT-61', '★★ 复盘与全盘是**两块**（用户 8.3、8.4 是两件事，合起来必然两头都写不深）',
      Object.keys(NARRATIVE_SPECS).includes('insight') && Object.keys(NARRATIVE_SPECS).includes('analysis')
      && NARRATIVE_SPECS.insight.ask !== NARRATIVE_SPECS.analysis.ask);
    chk('CKT-62', '★ 单元清单带口径说明，且"归不进去的"如实列出（不硬塞）',
      /未能归属/.test(units({ now: NOW }).note) && /不硬塞/.test(units({ now: NOW }).note),
      units({ now: NOW }).note.slice(0, 80));
    chk('CKT-63', '★★ 指定单元 ⇒ 提问里**指名只看它**（选择器不是摆设）',
      /只看/.test(sliceFor('insight', { now: NOW, unit: '示例单元' }).ask)
      && String(sliceFor('insight', { now: NOW, unit: '示例单元' }).ask).includes('示例单元'),
      sliceFor('insight', { now: NOW, unit: '示例单元' }).ask.slice(0, 90));
    chk('CKT-64', '★ 未指定单元 ⇒ 提问是"先列全部单元再逐个复盘"（与指定时不同）',
      /先把全部单元列出来/.test(sliceFor('insight', { now: NOW }).ask));
    chk('CKT-65', '★ 单元清单进了材料（模型看得到有哪些单元可选）',
      Array.isArray(sliceFor('insight', { now: NOW }).units?.list));
    // ★★ 2026-10-14 加（**真机生成的结果逼出来的**）：
    //   模型在「执行」那条里写「stats.todos.done=11 与 totals.todoDone=0 **冲突**」——
    //   它没看错，是**我没说清**（stats 是全时、totals 是本区间）。不说清就会出现两种坏结果：
    //   花篇幅"解释矛盾"，或者干脆怀疑整份数据不可信、后面几条都写"看不清"。
    chk('CKT-66', '★★ 材料里写明了两套统计的**口径不同**（全时 vs 本区间），并说明不是矛盾', (() => {
      const sl = sliceFor('analysis', { now: NOW });
      // materialObj 是 narrative 内部拼的；这里用同样几段拼一遍，验证"口径说明"确实在
      const note = 'stats 是**全时**';
      const src = String(narrative.toString());
      return src.includes('scopeNote') && src.includes('不是数据矛盾') && src.includes('全时');
    })());

    // 模型三块：生成 / 幂等 / 拒绝
    const stubModel = async () => ({ ok: true, text: '判断：推进中\n理由：有真实事件\n下一步：继续' });
    const n1 = await narrative('state', { from: '2026-10-05', to: '2026-10-12', now: NOW, modelFn: stubModel });
    chk('CKT-16', '★ 有数据 ⇒ 生成并落盘一块', n1.ok === true && n1.cached === false && fs.existsSync(narrativeFile('state')), JSON.stringify({ ok: n1.ok, fp: n1.fp }));
    chk('CKT-17', '落盘内容含输入指纹与区间（可复算）', (() => { const d = readNarrative('state'); return !!d && d.fp === n1.fp && d.from === '2026-10-05'; })());
    const n2 = await narrative('state', { from: '2026-10-05', to: '2026-10-12', now: NOW, modelFn: async () => ({ ok: true, text: '不该被调用' }) });    chk('CKT-18', '★ 幂等：输入没变 ⇒ 用缓存，不重复调模型', n2.cached === true && n2.text === '判断：推进中\n理由：有真实事件\n下一步：继续', JSON.stringify({ cached: n2.cached }));
    const n3 = await narrative('state', { from: '2026-10-05', to: '2026-10-12', now: NOW, modelFn: async () => ({ ok: true, text: '强制重生成' }), force: true });
    chk('CKT-19', 'force 可强制重生成', n3.cached === false && n3.text === '强制重生成');
    const n4 = await narrative('advice', { from: '2020-01-01', to: '2020-01-02', now: NOW, modelFn: async () => { throw new Error('不该被调用'); } });
    chk('CKT-20', '★ 没数据 ⇒ 直接拒绝（模型根本不会被调用）', n4.ok === false && n4.refused === true && /不调用模型/.test(n4.why), JSON.stringify(n4));
    const n5 = await narrative('insight', { from: '2026-10-05', to: '2026-10-12', now: NOW, modelFn: async () => ({ ok: false, why: '模型超时' }) });
    chk('CKT-21', '★ 模型失败 ⇒ 不落盘（页面仍是"尚未生成"，不留空壳）', n5.ok === false && !fs.existsSync(narrativeFile('insight')));
    chk('CKT-22', '未生成的那块读出来是 null（页面据此显示尚未生成）', readNarrative('insight') === null && readNarrative('state') !== null);
    // ★★ 2026-10-14 加（真机实测逼出来的两条）：
    //   ① 超时 ⇒ **换成压缩版再试**（治"内容让它想太久"）；
    //   ② 普通失败 ⇒ **不折腾**（减料治不了报错，只会白多调一次）。
    const slimCalls = [];
    const n6 = await narrative('analysis', {
      from: '2026-10-05', to: '2026-10-12', now: NOW,
      modelFn: async (p) => {
        slimCalls.push(p.length);
        return p.includes('材料被压缩过') || p.includes('不要据此判断')
          ? { ok: true, text: '（桩）压缩版成功' }
          : { ok: false, why: '调用失败：spawnSync powershell.exe ETIMEDOUT' };
      },
    });
    chk('CKT-66', '★★ 超时 ⇒ 换**压缩版**再试一次（治"内容让它想太久"）',
      n6.ok === true && n6.retried === 'slim' && slimCalls.length === 2, `调了 ${slimCalls.length} 次 · ${slimCalls.join(' → ')}`);
    chk('CKT-67', '★★ 压缩版**明显更短**（第一版的下限比材料还长 ⇒ 等于没压，实测只少 125 字）',
      slimCalls.length === 2 && slimCalls[1] < slimCalls[0] * 0.8,
      `${slimCalls[0]} → ${slimCalls[1]}（砍掉 ${slimCalls.length === 2 ? Math.round((1 - slimCalls[1] / slimCalls[0]) * 100) : '?'}%）`);
    let plainCalls = 0;
    const n7 = await narrative('state', {
      from: '2026-10-05', to: '2026-10-12', now: NOW, force: true,
      modelFn: async () => { plainCalls += 1; return { ok: false, why: '模型返回非 0（exit=1）' } },
    });
    chk('CKT-68', '★★ **普通失败不折腾**（只调一次；减料治不了报错，只会白多调一次）',
      n7.ok === false && plainCalls === 1 && !/两次都不行/.test(String(n7.why)), `调了 ${plainCalls} 次`);
    // 超时两次都拿不回来 ⇒ 如实报失败，不返回半截文本
    const n8 = await narrative('advice', {
      from: '2026-10-05', to: '2026-10-12', now: NOW, force: true,
      modelFn: async () => ({ ok: false, why: 'ETIMEDOUT' }),
    });
    chk('CKT-69', '★ 超时两次都不行 ⇒ **如实报失败**（不返回半截文本冒充分析）',
      n8.ok === false && n8.text === undefined && /两次都不行/.test(String(n8.why)), String(n8.why).slice(0, 70));
  } finally {
    if (prev === undefined) delete process.env.WB_V1_OUT; else process.env.WB_V1_OUT = prev;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
