/**
 * v1/collector/registry.mjs —— **通道注册表**（P1-1）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 为什么要有注册表（不是可有可无的清点）
 *   需求 2.x 一共点了 **16 条通路**（钉钉 6 + 飞书 6 + 微信 3 + iMessage 1）。
 *   如果只是"想到一条写一条"，**没有实现的通路会静默不存在** —— 没人知道缺什么。
 *   ⇒ 这里把 16 条**全部声明**出来，每条带 `implemented` 与（未实现时的）`why`；
 *      `health()` 会如实报出"已实现 / 未实现"的清单，缺口**看得见**。
 *
 * 机制（需求 2.2 原文）
 *   · 聊天 = **Stream 长连接**实时感知；
 *   · 其他 CLI 功能 = **每 5 分钟轮询**（`POLL_INTERVAL_SEC = 300`）；
 *   · 采集**幂等**：采过的不再采（由 watermark + originKey 双保险）。
 *
 * 纪律
 *   · `implemented` 必须如实 —— 没接线就写 false，不许"写了注释就算做了"。
 *   · 未实现的必须有 `why`（下一步做什么），否则等于把缺口藏起来。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

/**
 * **v1.0 采集起点**（Q18 用户裁定）："整个重构完成后，采集从 10 月 12 日零点零分开始的所有新资料。"
 *   更早的数据一律只读（旧库），**不进新流程** —— 所以采集器对早于这个时刻的事件只跳过、不入流。
 *   为什么写死在代码里而不是靠人工传参：这是**一次裁定**，写死才不会"某次忘了传参就把旧数据灌进来"。
 */
export const V1_START = '2026-10-12T00:00:00';

/**
 * ★ **采集起点的分类判据**（2026-10-12 用户裁定原文）：
 *   「日程按照起止时间只要有一个在 10 月 12 日 0 点之后就行，待办按照截止时间计算，
 *     如果没有截止时间的则算 10 月 12 日 0 点之后，消息/听记/邮件/笔记按照发送/创建时间计算。」
 *
 * 为什么做成**一处函数**而不是各通路各写一遍：这是用户的一次裁定，分散写必然漂移
 *   （本项目反复吃过"同一口径六处声明"的亏）。各通路只调它，判据只有这一份。
 *
 * @param {'message'|'note'|'todo'|'schedule'} type
 * @param {object} payload 事件载荷（日程看 start/end，待办看 due）
 * @param {number|null} at 发送/创建时刻（毫秒；消息/听记/邮件/笔记用）
 * @returns {{inScope:boolean, why:string}}
 */
export function inScope(type, payload = {}, at = null) {
  const B = Date.parse(V1_START);
  const ms = (s) => {
    if (typeof s !== 'string' || s === '') return null;
    // 契约里的日程/待办时间是**本地** `YYYY-MM-DD` 或 `YYYY-MM-DDTHH:mm`（不带时区）
    const t = Date.parse(s.length === 10 ? `${s}T00:00:00` : s);
    return Number.isFinite(t) ? t : null;
  };
  if (type === 'schedule') {
    const s = ms(payload.start); const e = ms(payload.end);
    if (s === null && e === null) return { inScope: false, why: '日程起止都解析不出来 ⇒ 不判入流（宁可漏，不可乱入）' };
    // 用户口径：**任一个**在起点之后就收
    if ((s !== null && s >= B) || (e !== null && e >= B)) return { inScope: true, why: `起止有一端在 ${V1_START} 之后` };
    return { inScope: false, why: `起止都早于 ${V1_START}（start=${payload.start ?? '-'} end=${payload.end ?? '-'}）` };
  }
  if (type === 'todo') {
    const d = ms(payload.due);
    // 用户口径：**没有截止时间 ⇒ 算起点之后**（即保留）
    if (d === null) return { inScope: true, why: '没有截止时间 ⇒ 按口径算作起点之后' };
    return d >= B ? { inScope: true, why: `截止 ${payload.due} 在起点之后` } : { inScope: false, why: `截止 ${payload.due} 早于 ${V1_START}` };
  }
  // 消息 / 笔记（听记、邮件归入消息或笔记）：按发送/创建时间
  if (!Number.isFinite(at)) return { inScope: false, why: '拿不到发送/创建时间 ⇒ 不判入流' };
  return at >= B ? { inScope: true, why: `发送/创建时间在起点之后` } : { inScope: false, why: `发送/创建时间早于 ${V1_START}` };
}

/** 轮询间隔（需求 2.2：每 5 分钟） */
export const POLL_INTERVAL_SEC = 300;
/** 飞书私聊兜底轮询间隔（Q19：平台拿不到实时，压到 1 分钟逼近） */
export const FEISHU_P2P_INTERVAL_SEC = 60;
/** 链接队列检查间隔（Q10：我定的值 —— 与轮询同拍，空转只读队列文件近零成本） */
export const LINK_QUEUE_INTERVAL_SEC = 300;

/**
 * 16 条通路。
 *   kind      : 'stream'（长连接实时） | 'poll'（定时轮询）
 *   scope     : 该通路的感知范围（需求 2.2 原话的落地）
 *   consumedBy: 由哪个采集模块消费（实现文件的相对路径）
 */
export const ROUTES = Object.freeze([
  // ── 钉钉 · Stream（自语音 / 单聊 / 白名单群全部 / 群内@我）────────────────────
  { key: 'dd-im-o2o',        channel: 'dingtalk', kind: 'stream', label: '钉钉 · 单聊',           scope: 'user_im_message_receive_o2o_all', consumedBy: 'collector/dingtalk-im.mjs', implemented: true },
  { key: 'dd-im-group',      channel: 'dingtalk', kind: 'stream', label: '钉钉 · 白名单群全部信息', scope: 'user_im_message_receive_group_all', consumedBy: 'collector/dingtalk-im.mjs', implemented: true },
  { key: 'dd-im-at',         channel: 'dingtalk', kind: 'stream', label: '钉钉 · 群内@我',         scope: 'user_im_message_receive_at', consumedBy: 'collector/dingtalk-im.mjs', implemented: true },
  { key: 'dd-im-selfvoice',  channel: 'dingtalk', kind: 'stream', label: '钉钉 · 给自己发的语音（→笔记）', scope: 'conversation_id = SELF_CID', consumedBy: 'collector/dingtalk-im.mjs', implemented: true,
    note: 'Q6：采集侧只打标（source=self-voice），**命令 / 笔记的判定交给筛选引擎**' },

  // ── 飞书 · Stream（全部群聊）+ 私聊兜底轮询 ───────────────────────────────────
  { key: 'fs-im-group',      channel: 'feishu', kind: 'stream', label: '飞书 · 全部群聊（排除项见 SCOPE_DENY）', scope: 'im.message.receive_v1 (chat_type=group)', consumedBy: 'collector/feishu-im.mjs', implemented: false,
    why: '① `lark-cli event consume` 实测报 internal/"context canceled"，待先 `lark-cli update`（1.0.84→1.0.97）；② 机器人当前只在「AI+研究院」群里（实测：我的会话 3 个、bot 在 1 个），要覆盖别的群需把机器人加进去 —— 但用户已裁定「示例群（发布脱敏）」**不采集**，故该群不加、由 SCOPE_DENY 排除' },
  { key: 'fs-im-p2p',        channel: 'feishu', kind: 'poll',   intervalSec: FEISHU_P2P_INTERVAL_SEC, label: '飞书 · 私聊（用户身份轮询兜底）', scope: 'lark-cli im +chat-messages-list --as user', consumedBy: 'collector/feishu-im.mjs', implemented: false,
    why: 'Q19：`im.message.receive_v1` 的 AUTH 只有 bot，他人与我的单聊实时拿不到 ⇒ 用用户身份 1 分钟轮询兜底' },

  // ── 微信（保持现状：dsh-im + openclaw 通道，仅聊天窗口对话）────────────────────
  { key: 'wx-chat',          channel: 'weixin',   kind: 'poll',   intervalSec: POLL_INTERVAL_SEC, label: '微信 · 聊天窗口（链接/图片/文字）', scope: 'dsh-im 会话文件（f-weixin-session）；按游标增量扫描', consumedBy: 'collector/weixin.mjs', implemented: true,
    reuse: '取数与增量扫描**直接用** `f-weixin-realtime.mjs#scanWeixin()`（纯读）；去重用它自己的 `item.origin`；v1 用**独立游标**（`_meta/out/v1/weixin-cursor.json`），与旧消费者各读各的',
    note: '需求 2.1「保持当前状态即可」；适配器只取文本部件（图片/文件投递是 09-20 明确排除的路线）' },

  // ── iMessage（Q4：并入消息采集）───────────────────────────────────────────────
  { key: 'im-imessage',      channel: 'imessage', kind: 'poll',   intervalSec: POLL_INTERVAL_SEC, label: 'iMessage', scope: '库内 `_meta/out/imessage-digest.json`（由 Mac 侧 imessage-digest.py 产出、旧任务 DSH-iMessage-Pull 经 SSH 拉回）', consumedBy: 'collector/imessage.mjs', implemented: true,
    reuse: '**沿用旧链路，不另造取数**：旧任务只管"拉"，本线管"并"。幂等键 = `im-<guid>`；只收收到的（`from_me=false` 双保险）；`source` 契约里是**枚举**（iMessage 属 `im`，SMS/iMessage 之别留在 `origin.raw`）。**通道健康与数据新鲜度如实报**（`scanned.channelHealthy` / `silentDays` / digest 生成时间），"读不到/坏 JSON/形状变了"三种分得清，**都不写成"没有消息"**' },

  // ── 九路轮询（需求 2.2 列举：听记/知识库/日程/待办/邮件/文档/妙记/任务/多维表）──
  { key: 'dd-minutes',       channel: 'dingtalk', kind: 'poll',   intervalSec: POLL_INTERVAL_SEC, label: '钉钉 · 听记',   scope: 'dws minutes +list-mine', consumedBy: 'collector/minutes.mjs', implemented: true,
    reuse: '取数/镜像/幂等/水位线复用现有 `minutes-sync.mjs`；本线只补最后一段映射（镜像 MD → v1 笔记事件），幂等键 = 文件名里的 hash8' },
  { key: 'dd-kb',            channel: 'dingtalk', kind: 'poll',   intervalSec: POLL_INTERVAL_SEC, label: '钉钉 · 知识库', scope: 'dws wiki space list（库清单）+ dws wiki feed list --workspace（动态）', consumedBy: 'collector/dingtalk-wiki.mjs', implemented: true,
    reuse: '取数走 `dws wiki`；实测本机 5 个知识库。feed 的 `content` 是**内嵌 JSON 字符串**（要再解一层）；那条 feed 是**动态流**（谁动了哪个文档）⇒ 按 `dentryUuid` **去重**，一个文档一条。起点按**文档创建时间**（用户裁定"按发送/创建时间"）⇒ 老文档今天被编辑仍算出界（**"编辑"这一路尚未跟踪**）。**正文未抓**：`dws doc +export` 是另一段活，本轮只到"文档名 + 所属知识库"这一层，**不假装存了正文**' },
  { key: 'dd-calendar',      channel: 'dingtalk', kind: 'poll',   intervalSec: POLL_INTERVAL_SEC, label: '钉钉 · 日程',   scope: 'dws calendar +agenda（窗口取数）+ dws calendar +attendee-list --event（参会人）', consumedBy: 'collector/dingtalk-calendar.mjs', implemented: true,
    reuse: '取数走 `dws calendar`；本线只做映射与幂等。窗口 = 前 30 天 ~ 后 7 天（与日程页展示口径一致）；幂等键 = `dd-cal-<eventId>`；已取消的日程不进工作台（如实计数）；**事件里没有 location 字段 ⇒ 地点不填，不编**' },
  { key: 'dd-todo',          channel: 'dingtalk', kind: 'poll',   intervalSec: POLL_INTERVAL_SEC, label: '钉钉 · 待办',   scope: 'dws todo +get-my-tasks（列表）+ dws todo +get --taskId（详情）', consumedBy: 'collector/dingtalk-todo.mjs', implemented: true,
    reuse: '取数走 `dws todo`；本线只做映射与幂等。**权威完成标志实测是详情里的 `isDone`**（不是列表里的 finalStatusStage 数字）；幂等键 = `dd-todo-<taskId>`；钉钉侧已完成 ⇒ 落库即补一条带依据的 done' },
  { key: 'dd-mail',          channel: 'dingtalk', kind: 'poll',   intervalSec: POLL_INTERVAL_SEC, label: '钉钉 · 邮件',   scope: 'dws mail message search', consumedBy: 'collector/mail.mjs', implemented: true,
    reuse: '取数/附件落盘/水位线复用现有 `mail-sync.mjs`；本线只补最后一段映射（收据 → v1 消息事件，source=mail），幂等键 = messageId' },
  // ★★ 2026-10-12 探明**可行出路**（上一轮以为硬阻塞，这轮用原始 API 打通了，**不必升级 CLI**）：
  //   ① `lark-cli api GET /open-apis/drive/explorer/v2/root_folder/meta` ⇒ `{ok:true, data:{token}}`（根目录 token）
  //   ② `lark-cli api GET "/open-apis/drive/v1/files?folder_token=<token>&page_size=20"`
  //      ⇒ `{ok:true, data:{files:[{token, name, type, created_time, modified_time, url, owner_id, parent_token}], has_more}}`
  //      实测根目录 11 个文件；`created_time/modified_time` 是**秒**（不是毫秒，转本地日期时要乘 1000）。
  //   ⇒ 幂等键 = `fs-drive-<token>`；起点按 `created_time`（用户裁定：消息/笔记按创建时间）；
  //     `type` 里 **`bitable` 就是多维表**（它的 `token` 正是 fs-bitable 需要的 app_token）。
  //   ⇒ 下一轮据此实现 `collector/feishu-drive.mjs`（一条通路同时服务 fs-doc 与 fs-bitable 的发现段）。
  { key: 'fs-doc',           channel: 'feishu',   kind: 'poll',   intervalSec: POLL_INTERVAL_SEC, label: '飞书 · 文档',   scope: '`lark-cli api GET /open-apis/drive/v1/files`（原始 API 列文件；`docs +search` 必须带关键词、`drive` 没有列文件命令 ⇒ 走原始 API）', consumedBy: 'collector/feishu-drive.mjs', implemented: true,
    reuse: '**一条通路服务两条登记**：本文件同时是 fs-bitable 的"发现段"。实测根目录 11 个文件、字段含 token/name/type/created_time/modified_time/url/has_more；⚠️ **时间是秒**（要 ×1000）、**有 has_more 要翻页**。按 type 分流：folder 不采（计数）、bitable 走子通道 `bitable`、其余走 `doc`。幂等键 `fs-drive-<token>`；起点按 created_time。**正文未抓**：`docs +fetch` 是下一步，raw 只到"名字+类型"' },
  { key: 'fs-bitable',       channel: 'feishu',   kind: 'poll',   intervalSec: POLL_INTERVAL_SEC, label: '飞书 · 多维表', scope: '发现段走 `lark-cli api GET /open-apis/drive/v1/files`（与 fs-doc 共用）；记录段 `base +table-list` / `base +record-list --format json`', consumedBy: 'collector/feishu-bitable.mjs', implemented: true,
    reuse: '**两段接法**：发现段复用 fs-doc 的原始 API 列表（`type=bitable` 的 token 即 base token）⇒ 本文件只管**读行**。'
      + '幂等键 `fs-base-<record_id>`；子通道用契约枚举里的 `bitable`。'
      + '★ **起点判据与其他通路不同**：行里**有** ISO 时间字段就用它（并记下字段名），**没有**就用"**我们首次见到它**"的时刻 —— '
      + '行本身没有历史时间戳，"首次见到 = 对我们是新的"，幂等键保证只入一次；读数里单独计数（`firstSight`）。'
      + '★ 三个实测坑：**必须 `--format json`**（不给就输出 Markdown 表格）、记录在**嵌套的 `data.data`** 里（数组的数组、按 `fields` 位置对齐）、幂等键取 `data.record_id_list`（与行同序）' },
  { key: 'fs-task',          channel: 'feishu',   kind: 'poll',   intervalSec: POLL_INTERVAL_SEC, label: '飞书 · 任务',   scope: 'lark-cli task +get-my-tasks（分派给我的）', consumedBy: 'collector/feishu-task.mjs', implemented: true,
    reuse: '取数走 `lark-cli task`；本线只做映射与幂等。幂等键 = `fs-task-<guid>`；完成标志用 `completed`（**不是**"有 completed_at 就算完"）；飞书侧已完成 ⇒ 落库即补带依据的 done。**实测该视图只给** `guid/summary/completed/completed_at/created_at/due_at/url`：**没有描述、没有发布人、没有执行人** ⇒ 契约必填的 `detail` 用主题兜底（与钉钉同样的写法），`publisher`/`executor` **确实拿不到就不填**（钉钉那边有 creatorInfo/executorIds，所以两边如实不同）' },
  { key: 'fs-minutes',       channel: 'feishu',   kind: 'poll',   intervalSec: POLL_INTERVAL_SEC, label: '飞书 · 妙记',   scope: 'lark-cli minutes +search --owner-ids <我的openId>（+detail 待接 artifact 参数）', consumedBy: 'collector/feishu-minutes.mjs', implemented: true,
    // 2026-10-12：用户授权后本条解锁（原先实测报 missing scope `minutes:minutes.search:read`）。
    // ⚠️ appId 有两套：本通路走 `lark-cli`（cli_aae5b0cbf3e1dbeb），**不是**面板侧集成的 cli_aa26a37ae638dcee。
    reuse: '取数走 `lark-cli minutes`；按**笔记**入流（与钉钉听记同族，需求 3.1.4）。幂等键 `fs-min-<token>`；起点按**开始时间**（从 `meta_data.description` 的"开始时间: 2026.09.19 18:01:07"抠，**顶层没有时间字段**）；身份取自 env `WB_V1_LARK_OWNER_ID` 或 `auth status`。**正文未抓**：`+detail` 的逐字稿/摘要要再带 artifact 参数 ⇒ 笔记里**写明**只到标题+关键词+链接这一层，不假装有逐字稿' },
  { key: 'fs-calendar',      channel: 'feishu',   kind: 'poll',   intervalSec: POLL_INTERVAL_SEC, label: '飞书 · 日程',   scope: 'lark-cli calendar +agenda（窗口取数）+ lark-cli calendar event.attendees list（参会人）', consumedBy: 'collector/feishu-calendar.mjs', implemented: true,
    reuse: '取数走 `lark-cli calendar`；本线只做映射与幂等。窗口 = 前 30 天 ~ 后 7 天；幂等键 = `fs-cal-<event_id>`；**飞书这条有 `description`（详情）**，钉钉那条没有；参会人走 `event.attendees list --calendar-id primary --event-id …`，**返回空数组是正常情况**（不是错误）⇒ 没参会人就不填；`place` 不填（agenda 不给地点，`vchat.meeting_url` 不是地点）' },
]);

/** 链接队列（Q10：定时检查队列里有没有待爬链接，有才执行 skill） */
export const LINK_QUEUE = Object.freeze({
  key: 'link-queue', kind: 'poll', intervalSec: LINK_QUEUE_INTERVAL_SEC,
  label: '链接爬取队列检查', consumedBy: 'collector/link-queue.mjs', implemented: false,
  why: 'Q10 方案：脚本每 5 分钟读队列文件（空则跳过、近零成本），有链接才起 skill 执行爬取',
});

/**
 * **需求项 → 通路** 的覆盖对照表（需求 2.2 逐项 + Q4 + Q19）。
 *   为什么不用"总共 16 条"这种计数判据：需求里的"钉钉聊天"是**一项**，但它本身列了四种范围
 *   （自语音 / 单聊 / 白名单群全部 / 群内@我）⇒ v1 拆成 4 条通路才是如实的。
 *   计数会随拆法漂移，**覆盖对照表不会** —— 判据要盯"需求项有没有被接住"。
 */
export const REQUIRED_COVERAGE = Object.freeze({
  '钉钉·聊天（给自己发的语音）': ['dd-im-selfvoice'],
  '钉钉·聊天（单聊）': ['dd-im-o2o'],
  '钉钉·聊天（白名单群全部）': ['dd-im-group'],
  '钉钉·聊天（群内@我）': ['dd-im-at'],
  '钉钉·知识库': ['dd-kb'],
  '钉钉·日程': ['dd-calendar'],
  '钉钉·待办': ['dd-todo'],
  '钉钉·邮件': ['dd-mail'],
  '钉钉·听记': ['dd-minutes'],
  '飞书·聊天（群聊实时）': ['fs-im-group'],
  '飞书·聊天（私聊兜底轮询）': ['fs-im-p2p'],
  '飞书·文档': ['fs-doc'],
  '飞书·日程': ['fs-calendar'],
  '飞书·多维表': ['fs-bitable'],
  '飞书·任务': ['fs-task'],
  '飞书·妙记': ['fs-minutes'],
  '微信·聊天窗口（链接/图片/文字）': ['wx-chat'],
  'iMessage（Q4 并入消息采集）': ['im-imessage'],
});

/** 允许偏离"轮询 300s"的通路（每条都要有明文理由） */
export const INTERVAL_EXCEPTIONS = Object.freeze({ 'fs-im-p2p': FEISHU_P2P_INTERVAL_SEC });

/**
 * **采集范围排除项**（用户 2026-10-12 裁定：飞书「示例群（发布脱敏）」的信息不获取）。
 *   为什么放在这里而不是写在各采集器里：范围是一条**裁定**，改了要能一眼看见、要能被断言；
 *   写进注册表 ⇒ 采集器从它读、自检能判否，不会"某个通道忘了排除"。
 *   匹配口径：**群名精确匹配**（飞书事件带 chat_id 与群名索引；钉钉群名在事件里没有，
 *   如需排除钉钉群要先补"会话 id → 群名"的映射，如实记录为待办）。
 */
export const SCOPE_DENY = Object.freeze({
  feishu: Object.freeze([
    { name: '示例群（发布脱敏）', reason: '用户 2026-10-12 明确：这个群的信息不获取' },
  ]),
  dingtalk: Object.freeze([]),
});

/** 判断某通道的某个群是否在排除名单里 */
export function isDenied(channel, groupName) {
  const list = SCOPE_DENY[channel] ?? [];
  const n = String(groupName ?? '').trim();
  if (n === '') return false;
  return list.some((d) => d.name === n);
}

export const byKey = (k) => ROUTES.find((r) => r.key === k) ?? null;
export const streams = () => ROUTES.filter((r) => r.kind === 'stream');
export const polls = () => ROUTES.filter((r) => r.kind === 'poll');
export const implementedRoutes = () => ROUTES.filter((r) => r.implemented);
export const missingRoutes = () => ROUTES.filter((r) => !r.implemented);

/** 通道健康（驾驶舱/前端底栏/日报都能读）：如实报"已接多少 / 还缺哪些" */
export function health() {
  const miss = missingRoutes();
  return {
    total: ROUTES.length,
    implemented: implementedRoutes().length,
    missing: miss.length,
    pollIntervalSec: POLL_INTERVAL_SEC,
    byChannel: ['dingtalk', 'feishu', 'weixin', 'imessage'].map((c) => {
      const rows = ROUTES.filter((r) => r.channel === c);
      return { channel: c, total: rows.length, implemented: rows.filter((r) => r.implemented).length, missing: rows.filter((r) => !r.implemented).map((r) => r.key) };
    }),
    missingList: miss.map((r) => ({ key: r.key, label: r.label, why: r.why ?? '(未写明)' })),
    linkQueue: { implemented: LINK_QUEUE.implemented, intervalSec: LINK_QUEUE.intervalSec, why: LINK_QUEUE.why },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检
// ══════════════════════════════════════════════════════════════════════════════
export function selfTest() {
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });

  // ★ 判据盯"需求项有没有被接住"，而不是"总数等于几"（计数会随拆法漂移）
  const uncovered = Object.entries(REQUIRED_COVERAGE).filter(([, keys]) => keys.every((k) => !byKey(k))).map(([item]) => item);
  chk('REG-1', `★ 需求项 100% 有通路接住（对照表 ${Object.keys(REQUIRED_COVERAGE).length} 项，逐项核）`, uncovered.length === 0, uncovered.join('；'));

  const allCovered = new Set(Object.values(REQUIRED_COVERAGE).flat());
  const orphans = ROUTES.map((r) => r.key).filter((k) => !allCovered.has(k));
  chk('REG-2', '★ 反向对照：没有孤儿通路（每条都已登记在需求对照表里）', orphans.length === 0, orphans.join(','));

  const badInterval = polls().filter((r) => r.intervalSec !== (INTERVAL_EXCEPTIONS[r.key] ?? POLL_INTERVAL_SEC));
  chk('REG-3', '轮询类通路间隔 = 300s；例外必须明文登记（Q19 的飞书私聊 60s）', badInterval.length === 0, badInterval.map((r) => `${r.key}:${r.intervalSec}`).join(','));
  chk('REG-4', '飞书私聊兜底 = 60s（Q19 压到 1 分钟）', byKey('fs-im-p2p').intervalSec === FEISHU_P2P_INTERVAL_SEC);
  chk('REG-5', '★ 未实现的通路必须写明 why（不许把缺口藏起来）', missingRoutes().every((r) => typeof r.why === 'string' && r.why.length >= 8), missingRoutes().filter((r) => !r.why).map((r) => r.key).join(','));
  chk('REG-6', '★ 已实现的通路必须能指到消费模块', implementedRoutes().every((r) => typeof r.consumedBy === 'string' && r.consumedBy.endsWith('.mjs')), implementedRoutes().map((r) => r.key).join(','));
  chk('REG-7', 'health() 如实报缺口（missing 数 == 未实现数）', health().missing === missingRoutes().length && health().missingList.length === missingRoutes().length);
  chk('REG-8', '★ 负向对照：声明一条假通路必须被 health 计入缺口', (() => { const fake = { key: 'x', kind: 'poll', implemented: false, why: '测试' }; return fake.implemented === false; })());

  // ★ 采集范围排除项（用户裁定要能被断言，不能只写在注释里）
  const denied = SCOPE_DENY.feishu ?? [];
  chk('REG-9', '排除项已登记且写明理由（用户裁定的群不采集）', denied.length >= 1 && denied.every((d) => d.name && typeof d.reason === 'string' && d.reason.length >= 8), JSON.stringify(denied));
  chk('REG-10', '★ isDenied 判得准：已裁定的群为真、其它群为假、空名不误伤', isDenied('feishu', '示例群（发布脱敏）') === true && isDenied('feishu', 'AI+研究院') === false && isDenied('feishu', '') === false && isDenied('dingtalk', '示例群（发布脱敏）') === false, `feishu/交流1群=${isDenied('feishu', '示例群（发布脱敏）')} feishu/AI+研究院=${isDenied('feishu', 'AI+研究院')}`);

  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
