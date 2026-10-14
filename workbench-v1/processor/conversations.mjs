/**
 * `v1/processor/conversations.mjs` —— **把消息按「会话 × 天」聚合**（用户 2026-10-14 这一轮）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 用户原话（逐条）
 *   · 「消息页面的消息列表应该改成**按照会话聚合的会话列表**，消息列表下面的字段需要改为：
 *      **日期、最近一条消息、时间、来源、发信人、最新一条消息内容**。」
 *   · 「点击会话列表进入**会话详情**，会话详情中，除了现有的来源渠道、发信人之外，
 *      **信息原文应该是按照时间顺序，将当天该会话的所有信息按时间排序（XX：XX  XXXXXXXXXXX）**。」
 *   · 「"已回复"按钮同样将该会话**整体**移动到"已回复"中，**直到该会话有新消息流入再移动回来**。」
 *   · 「**会话的消息都是按天为单位**。」
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 三条口径（写清楚，免得以后变成玄学）
 *
 *   一、**一个会话 = 同一个 `conversationId` 的、同一天的消息**。
 *      为什么要按天切：用户明说"会话的消息都是按天为单位"——
 *      一个群聊跑一个月，如果聚成一条会话，那"最新一条消息"就没意义了，
 *      而且"已回复"会一直挂在一个巨大的历史包袱上。
 *   二、`conversationId` 缺失的（实测有 8 个群因为没取到 conversationName 而形态不整），
 *      **按发信人聚**（不是丢掉、也不是全塞一个筐）—— 丢了就等于消息不见了。
 *   三、"已回复"是**会话级**的：整条会话移进"已回复"，**直到有新消息流入**才回来。
 *      ⇒ 判法：`最新一条消息的时间 > 最后一次 replied 的时间` ⇒ 有新消息 ⇒ 回到待处理。
 *        这条判法不需要额外记账（不用"记一个已回复到哪条为止"），
 *        时间戳本身就把这件事说清楚了 —— 少一份要维护的状态就少一处会漂的地方。
 */
import * as store from '../store.mjs';

/** 本地日期（不做时区换算；与库里其它日期口径一致） */
export function dayOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function timeOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 一条消息属于哪个会话。
 * 优先 `conversationId`；没有就退回**发信人**（并标明这是退路，界面可以看到）。
 */
export function keyOf(evt) {
  const cid = String(evt?.payload?.conversationId ?? '').trim();
  if (cid !== '') return { key: `cid:${cid}`, kind: 'conversation' };
  const sender = String(evt?.payload?.sender ?? '').trim();
  if (sender !== '') return { key: `sender:${sender}`, kind: 'sender' };
  return { key: 'unknown', kind: 'unknown' };
}

const CH_NAME = { dingtalk: '钉钉', feishu: '飞书', weixin: '微信', imessage: 'iMessage', manual: '手工' };
export const channelName = (c) => CH_NAME[c] ?? c ?? '未知';

// ⚠️ 这里原来有个 `lastOpAt()`（取某条 op 的最后时间）——
//   改会话状态判法时**一并删掉了**：现在"已回复"是**逐条**看的（用户裁定"只标勾选的那些条"），
//   不再需要"最后一次 replied 是什么时候"。留着就是死代码。

/**
 * 把消息列表聚合成会话列表。
 * @param {object[]} rows 消息事件（任意顺序）
 * @param {{day?:string|null, tab?:string, now?:number}} o
 * @returns {{conversations:object[], counts:object, day:string}}
 */
export function aggregate(rows, { day = null, now = Date.now() } = {}) {
  const groups = new Map();
  for (const e of rows) {
    const d = dayOf(e._at);
    const { key, kind } = keyOf(e);
    const gk = `${d}|${key}`;
    if (!groups.has(gk)) groups.set(gk, { day: d, key, kind, items: [] });
    groups.get(gk).items.push(e);
  }

  const conversations = [];
  for (const g of groups.values()) {
    const items = [...g.items].sort((a, b) => a._at - b._at);          // 时间升序（详情就按这个排）
    const last = items[items.length - 1];
    const opNames = (e) => (e.ops ?? []).map((o) => String(o.op ?? ''));
    const isReplied = (e) => opNames(e).includes('replied');
    // ★★ 2026-10-14 改（用户裁定）：**「已回复」是按条标的** ——
    //   原话：「流入的一个会话中的多条消息，有可能会被**分别**转待办、转日程、转笔记或转为已回复，
    //          所以会话详情页中的消息原文应该是**可以按条进行选择**（支持单选及多选）」，
    //          并在追问里明确选了「**只标勾选的那些条**」。
    //   ⇒ 会话状态不再看"最新一条之后有没有动过"，而是看**这批消息各自被标了什么**：
    //     · 全都已回复 ⇒ 会话算「已回复」；
    //     · 还有没回复的 ⇒ 会话仍是「待处理」（哪怕部分已回复）——
    //       这与用户"只标勾选的那些条"直接对应：没勾的仍留在待处理。
    //   ⚠️ 与旧写法（"最新一条晚于最后一次 replied ⇒ 回到待处理"）的区别：
    //     旧写法把"已回复"当成**会话级的一次点击**；新写法把它当成**逐条的状态**。
    //     后者才是用户这一轮要的（一个会话里可以被分别处理）。
    const repliedCount = items.filter(isReplied).length;
    const allReplied = items.length > 0 && repliedCount === items.length;
    let state = 'pending';
    if (allReplied) state = 'replied';
    else {
      // 还没全回复：看**最后一条**被转成了什么（转换是"这条消息被处置掉了"）
      const lastOps = opNames(last);
      if (lastOps.includes('to-todo')) state = 'to-todo';
      else if (lastOps.includes('to-schedule')) state = 'to-schedule';
      else if (lastOps.includes('to-note')) state = 'to-note';
    }
    conversations.push({
      id: `${g.day}__${g.key}`,                                         // 会话的稳定标识（日期 + 会话键）
      day: g.day, key: g.key, kind: g.kind,
      count: items.length,
      repliedCount,
      firstAt: items[0]._at,
      lastAt: last._at,
      time: timeOf(last._at),
      channel: channelName(last.payload?.channel),
      sender: String(last.payload?.sender ?? ''),
      // 用户点名的六个字段：日期 / 最近一条消息（时间）/ 时间 / 来源 / 发信人 / 最新一条消息内容
      lastSummary: String(last.payload?.summary ?? last.payload?.raw ?? '').slice(0, 120),
      state,
      items,                                                            // 详情要用（时间升序）
      ids: items.map((e) => e._id),
      repliedIds: items.filter(isReplied).map((e) => e._id),
    });
  }
  // 列表按"最近一条消息"倒序（最新的会话在最上面）
  conversations.sort((a, b) => b.lastAt - a.lastAt);
  return { conversations, day };
}

/** 会话列表（供页面用）：带页签筛选与计数 */
export function conversations({ tab = 'all', day = null, limit = 300, now = Date.now() } = {}) {
  const rows = store.list({ type: 'message' });
  const all = aggregate(rows, { day, now });
  // ⚠️ `all` 这一档**不是**一个状态桶 —— 会话的 `state` 只会是 pending / to-todo /
  //   to-schedule / to-note / replied，**永远不会等于 'all'**。
  //   第一版把 `byTab.all` 初始化成空数组、又用 `byTab[c.state]` 往里塞 ⇒
  //   `all` 档**永远是空的**（实测：counts.total=54、list=0，页面显示"会话列表 · 暂无"，
  //   而卡片上明明白白写着 52 —— 又是"数字说有、列表说没有"）。
  //   ⇒ `all` 直接就是全部会话，不参与按状态分桶。
  const byTab = { all: all.conversations, pending: [], 'to-todo': [], 'to-schedule': [], 'to-note': [], replied: [] };
  for (const c of all.conversations) {
    const b = byTab[c.state];
    if (b) b.push(c);
    else byTab.pending.push(c);      // 认不出的状态 ⇒ 归待处理（宁可多显示，也不能让它消失）
  }
  const counts = {
    total: all.conversations.length,
    pending: byTab.pending.length,
    toTodo: byTab['to-todo'].length,
    toSchedule: byTab['to-schedule'].length,
    toNote: byTab['to-note'].length,
    replied: byTab.replied.length,
  };
  const list = (byTab[tab] ?? all.conversations).slice(0, limit).map((c) => ({
    id: c.id, day: c.day, time: c.time, at: c.lastAt,
    channel: c.channel, sender: c.sender,
    count: c.count, lastSummary: c.lastSummary, state: c.state,
    // ★ 2026-10-14 加：**已回复条数**要一并给出来。
    //   会话状态是"逐条"算的（全回复才算会话回复），所以"这个会话回复了几条"
    //   本身就是有用信息 —— 详情页那行「当天消息数（已回复 N 条）」读的就是它。
    //   ⚠️ 第一版只在内部对象上留了它、**没进列表投影** ⇒ 列表里取到 undefined
    //     （实测：`已回复 undefined/2`）。**投影漏字段**这类错在页面上就是"显示 undefined"。
    repliedCount: c.repliedCount,
    repliedIds: c.repliedIds,
    keyText: c.kind === 'sender' ? `${c.sender}（按发信人聚）` : c.sender,
    ids: c.ids,
  }));
  return { counts, list, tab, day: all.day };
}

/** 按会话 id（`YYYY-MM-DD__cid:xxx`）取出那一个会话 */
export function one(convId) {
  const rows = store.list({ type: 'message' });
  const all = aggregate(rows, {});
  return all.conversations.find((c) => c.id === String(convId)) ?? null;
}

export async function selfTest() {
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail: String(detail) });
  const M = (id, cid, sender, at, raw, ops = []) => ({
    _id: id, _at: at, type: 'message', ops,
    payload: { channel: 'dingtalk', sender, raw, summary: raw, conversationId: cid },
  });
  const D1 = Date.parse('2026-10-14T09:00:00+08:00');
  const D2 = Date.parse('2026-10-15T09:00:00+08:00');

  const rows = [
    M('a', 'cidA', '张三', D1, '早上第一条'),
    M('b', 'cidA', '李四', D1 + 3600000, '上午第二条'),
    M('c', 'cidA', '张三', D2, '第二天的'),
    M('d', 'cidB', '王五', D1, '另一个会话'),
  ];
  const a = aggregate(rows, {});
  chk('CV-1', '★★ 按「会话 × 天」聚合：cidA 有两天 ⇒ 两条会话（用户："会话的消息都是按天为单位"）',
    a.conversations.filter((c) => c.key === 'cid:cidA').length === 2, JSON.stringify(a.conversations.map((c) => c.id)));
  chk('CV-2', '★ 会话按"最近一条消息"倒序（最新的在最上面）',
    a.conversations[0].lastAt >= a.conversations[a.conversations.length - 1].lastAt,
    a.conversations.map((c) => c.id).join(' | '));
  const cidA1 = a.conversations.find((c) => c.key === 'cid:cidA' && c.day === '2026-10-14');
  chk('CV-3', '★★ 会话里的消息**按时间升序**（详情就按这个排）',
    cidA1.items.map((e) => e._id).join(',') === 'a,b', cidA1.items.map((e) => e._id).join(','));
  chk('CV-4', '★ 列表字段齐（日期/时间/来源/发信人/最新一条内容/条数）',
    cidA1.day === '2026-10-14' && /^\d{2}:\d{2}$/.test(cidA1.time) && cidA1.channel === '钉钉'
    && cidA1.sender === '李四' && cidA1.lastSummary === '上午第二条' && cidA1.count === 2,
    JSON.stringify({ day: cidA1.day, time: cidA1.time, ch: cidA1.channel, s: cidA1.sender, n: cidA1.count }));

  // 已回复：**按条标**（用户裁定："只标勾选的那些条"）⇒ 全部标了才算会话已回复
  const repliedAt = D1 + 7200000;                                      // 11:00 回复
  const rows2 = [
    M('a', 'cidA', '张三', D1, '早上第一条'),
    M('b', 'cidA', '李四', D1 + 3600000, '上午第二条', [{ at: repliedAt, op: 'replied' }]),
  ];
  const r2 = aggregate(rows2, {});
  chk('CV-5', '★ 只标了其中一条 ⇒ 会话**仍算待处理**（用户："只标勾选的那些条"）',
    r2.conversations[0].state === 'pending' && r2.conversations[0].repliedCount === 1,
    `${r2.conversations[0].state} · 已回复 ${r2.conversations[0].repliedCount}/${r2.conversations[0].count}`);
  const rowsAll = [
    M('a', 'cidA', '张三', D1, '早上第一条', [{ at: repliedAt, op: 'replied' }]),
    M('b', 'cidA', '李四', D1 + 3600000, '上午第二条', [{ at: repliedAt, op: 'replied' }]),
  ];
  chk('CV-5b', '★★ 全部标了 ⇒ 会话算「已回复」',
    aggregate(rowsAll, {}).conversations[0].state === 'replied', aggregate(rowsAll, {}).conversations[0].state);
  const rows3 = [
    ...rowsAll,
    M('c', 'cidA', '张三', repliedAt + 60000, '回复之后又来了一条'),   // 新消息（没标已回复）
  ];
  const r3 = aggregate(rows3, {});
  chk('CV-6', '★★ 该会话又有新消息流入 ⇒ **回到待处理**（用户："直到该会话有新消息流入再移动回来"）',
    r3.conversations[0].state === 'pending', `${r3.conversations[0].state} · 已回复 ${r3.conversations[0].repliedCount}/${r3.conversations[0].count}`);
  const rows4 = [
    M('a', 'cidA', '张三', D1, '旧消息'),
    M('b', 'cidA', '李四', D1 + 1000, '新的在回复之前', [{ at: repliedAt, op: 'replied' }]),
  ];
  chk('CV-7', '★ 负向对照：只回了一条 ⇒ 仍待处理（不是"有一条回复就整会话回复"）',
    aggregate(rows4, {}).conversations[0].state === 'pending', aggregate(rows4, {}).conversations[0].state);

  // 没有 conversationId ⇒ 按发信人聚（不丢）
  const rows5 = [{ _id: 'x', _at: D1, type: 'message', payload: { channel: 'dingtalk', sender: '孤儿群', raw: '没有会话号', conversationId: '' } }];
  const r5 = aggregate(rows5, {});
  chk('CV-8', '★★ 没有 conversationId ⇒ **按发信人聚**（不丢、也不全塞一个筐）',
    r5.conversations.length === 1 && r5.conversations[0].kind === 'sender', JSON.stringify(r5.conversations[0]?.kind));

  // 转过下游
  const rows6 = [M('a', 'cidA', '张三', D1, 'x', [{ at: D1 + 100, op: 'to-todo' }])];
  chk('CV-9', '★ 转过待办的会话 ⇒ 落在「已转待办」档',
    aggregate(rows6, {}).conversations[0].state === 'to-todo', aggregate(rows6, {}).conversations[0].state);

  chk('CV-10', '★ 时间格式是 `HH:MM`（详情里要显示 `XX：XX  内容`）',
    /^\d{2}:\d{2}$/.test(timeOf(D1)) && timeOf(D1) === '09:00', timeOf(D1));

  return { pass: out.filter((x) => x.ok).length, fail: out.filter((x) => !x.ok).length, details: out };
}
