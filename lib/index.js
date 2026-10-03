/**
 * dsh-workdesktop — host half.
 *
 * Collects the workbench snapshot (DingTalk calendar/todos/minutes across every
 * signed-in organization, plus the local knowledge base) and serves it to the
 * browser half over three routes under `/workdesktop/api`.
 *
 * Deliberately dependency-free: only `node:` builtins are imported (plus this
 * package's own zero-dependency `pg-helper/` modules), so the same package boots
 * on the checkout runtime and on the packaged runtime shipped by the DSH Desktop
 * app, whose @deepseek-ai versions differ.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
// 同步读（仅用于 MCP 配置行扫描：几行 YAML，几毫秒；带 120s 缓存）
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// 工程图的**文档层**（对象级读写 + `$` 下标维护）。与 MCP server 共用同一份实现，
// 免得"面板能拖、MCP 拖不了"这种两套行为。
import {
  readDocument as pgReadDocument,
  writeDocument as pgWriteDocument,
  summarize as pgSummarize,
  moveBatch as pgMoveBatch,
  makeTextNode as pgMakeTextNode,
  makeEdge as pgMakeEdge,
  reconnectEdge as pgReconnectEdge,
  setSectionFlags as pgSetSectionFlags,
  makeSection as pgMakeSection,
  setParent as pgSetParent,
  reorderObject as pgReorderObject,
  readAttachment as pgReadAttachment,
  insertObjects as pgInsertObjects,
  removeObjectsAndDanglingEdges as pgRemoveWithEdges,
  locateBridge as pgLocateBridge,
  isEdge as pgIsEdge,
} from '../pg-helper/project-graph-doc.mjs'

export const name = 'dsh-workdesktop'
// 2026-10-03：补 'timer' —— 2673 行用 ctx.interval（快照预热）是 timer 服务的投影，
// 缺声明会在 cordis 严格模式抛 "cannot get property 'timer' without inject"（整包 fiber 失败）。
export const inject = ['webServer', 'timer']

const PS = process.env.DSH_WORKDESKTOP_POWERSHELL
  || 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const HOME = process.env.USERPROFILE || ''
/**
 * 知识库根目录：**环境变量优先，缺省回落到 `%USERPROFILE%\Desktop\Knowledge`，但必须真实存在**。
 *
 *   三条边界（2026-09-24 发布前收口，直承已发布版的脱敏契约 L2-1/L2-2）：
 *     ① **不硬编任何人的路径** —— 缺省值是**运行时从 USERPROFILE 推**出来的，不是写死的字符串；
 *     ② **缺省值不存在就报错**，并**点名 `DSH_WORKDESKTOP_KNOWLEDGE`** —— 换台机器（或换用户）时
 *        宁可当场说清"该设哪个变量"，也不要静默指到一个不存在的目录、让所有卡片空着；
 *     ③ 设了环境变量就**只用它**（不做二次推断），指向不存在的目录同样报错。
 *   ⚠️ 与已发布 v0.4.0 的差别：那一版**完全没有缺省值**（缺变量即抛错），本机因此每次都得先设变量；
 *      现在改成"能用 + 缺省不可用即报错"，两种机器上都说得清（详见 release notes 的契约变更一节）。
 */
const KNOWLEDGE = process.env.DSH_WORKDESKTOP_KNOWLEDGE || (HOME === '' ? '' : join(HOME, 'Desktop', 'Knowledge'))
if (KNOWLEDGE === '' || !existsSync(KNOWLEDGE)) {
  throw new Error(
    'dsh-workdesktop：找不到知识库目录。请设置环境变量 DSH_WORKDESKTOP_KNOWLEDGE 指向你的知识库根目录'
    + `（当前解析到：${KNOWLEDGE === '' ? '（空，USERPROFILE 也未设置）' : KNOWLEDGE}，该目录不存在）。`,
  )
}
const HERMES_URL = process.env.DSH_WORKDESKTOP_HERMES_URL || 'http://127.0.0.1:8787'
const CACHE_MS = Number(process.env.DSH_WORKDESKTOP_CACHE_MS || 120000)
const RUN_DIR = join(tmpdir(), 'dsh-workdesktop')
const SCRIPT_PATH = join(RUN_DIR, 'snapshot.ps1')
const ROUTE = '/workdesktop/api'

// ── 数据层（personal-workbench）─────────────────────────────────────────────
// ⚠️ **不复制逻辑，只读产物** —— P2「一个真相源」：
//   本插件**复用驾驶舱自己的 `_meta/out/snapshot.json`**，不另建一套派生。
//   该文件由 `build-snapshot.mjs` 幂等生成（run-t4 / run-ingest 会自动重建）。
//   插件因此只依赖**文件格式**，不依赖库内任何模块 —— 库内 345 项验收怎么改都不影响它。
const PWB_DIR = join(KNOWLEDGE, '_meta', 'out')
const PWB_SNAPSHOT = join(PWB_DIR, 'snapshot.json')
const PWB_METRICS = join(PWB_DIR, 's-metrics.json')
// 库内仪表盘（驾驶舱 HTML）：better-sidebar 的「驾驶舱」tab 用 iframe 内嵌这份自包含产物
const PWB_DASHBOARD = join(PWB_DIR, 'dashboard.html')
const PWB_BUILD = process.env.DSH_WORKDESKTOP_BUILD || join(KNOWLEDGE, '_meta', 'workbench', 'build-snapshot.mjs')
// 专注块的运行时写路径：面板按钮与 DSH 工具共用这一个 CLI（P2 一个真相源）
const PWB_FOCUS_CLI = join(KNOWLEDGE, '_meta', 'workbench', 'cli-focus.mjs')
// 活跃关注域（B 块 2026-09-14 裁定 ②「两者都要」）：自动读会话 + agent 声明覆盖，共用这一个 CLI
const PWB_AD_CLI = join(KNOWLEDGE, '_meta', 'workbench', 'cli-active-domains.mjs')
const PWB_AD_INPUT = join(PWB_DIR, 'active-domains-input.json')
const PWB_AD_DOC = join(PWB_DIR, 'active-domains.json')
const AD_MATCH_MS = Number(process.env.DSH_WORKDESKTOP_AD_MATCH_MS || 60000)
const NODE = process.env.DSH_WORKDESKTOP_NODE || process.execPath || 'node'
const PWB_CACHE_MS = Number(process.env.DSH_WORKDESKTOP_PWB_CACHE_MS || 30000)

// ── 「系统」卡：两张**能力小卡片**的四态与手动开关（2026-09-23 用户裁定）──────────
//   用户原话：「把实时回复功能/响应功能的状态（在线绿·待机或执行黄·离线红·关闭灰）加到
//   **系统卡片**里，作为工具卡片；点击小卡片切换开/关。」
//   P2 一个真相源：**判定全在库内**（`system-switches.mjs`：开关文件 + 计划任务
//   状态 + 锁内 pid + 消费者心跳 + 台账），host **只转调、只透传**，不在这边重算任何一盏灯。
//   为什么不在 host 算：四态要用到"消费者进程的武装态/是否在会中/语音在途条数"——那些只有消费者
//   自己知道（它写进心跳）；在 host 猜就等于**编灯**。
const PWB_SYSTEM_CLI = join(KNOWLEDGE, '_meta', 'workbench', 'system-switches.mjs')

// ── 「验收」卡缺口三字段（未达成原因 / 解锁条件 / 下一步）的**透传契约**（2026-09-17）──
// 只透传、**不判定**：判定的唯一产地是产物 `_meta/out/s-metrics.json`（生产者 build-s-metrics.mjs）。
// ⚠️ 实测更正（别再把这里当"丢字段的 bug"修一遍）：`/state` 此前没有这三字段**不是 host 丢字段** ——
//    `metrics.metrics` 本来就是整对象透传（实测 2026-09-17：产物补上字段后，未改动的 host
//    立刻在 /state 里带出了 reason/unlock/nextAction/calibrated 16/16）。写在这里是为了让契约
//    **在代码里可见**（而不是依赖"整对象透传"这个隐含行为），并钉住一条语义：
//      · 产物里**没有这个键** ⇒ 不补键（渲染层据此显示「该字段不在 payload 中」）
//      · 产物里是 **null**   ⇒ 保持 null（达成项的 unlock / nextAction 就是 null = 没有可解锁项）
//    host 不推断解锁条件、不补阈值、不合成 reason。
const GAP_FIELDS = ['reason', 'unlock', 'nextAction']
function carryGapFields(m) {
  if (m === null || typeof m !== 'object') return m
  const out = { ...m }
  for (const k of GAP_FIELDS) if (Object.prototype.hasOwnProperty.call(m, k)) out[k] = m[k]
  return out
}
// ── E 块：事务详情卡（记录 / 关闭 / 重开）───────────────────────────────────
// P2 一个真相源（2026-09-15 合并定案）：
//   · 关闭/重开 = 事务**状态** → 归库内单一真相源：cli-matter.mjs → matter-overrides.json
//     → 立即套用到 matters.json，管线重建后由 apply-matter-overrides 再套用（关闭持久）。
//     **插件不自己维护 closures/reopens 覆盖层**（曾是双真相源，已废弃）。
//   · 添加记录（progress/decision/risk/note）= 面板**展示层注释**，不入管线状态，
//     存 matter-actions.json（仅 records 字段，插件本地）。
//   · 面板按钮与 DSH 工具 workbench_matter 共用 cli-matter.mjs 这一条写通道。
// env 覆盖仅用于自测隔离（selftest-matter.mjs），正常运行不设置。
const PWB_MATTERS = process.env.DSH_WORKDESKTOP_MATTERS || join(PWB_DIR, 'matters.json')
const PWB_MACTIONS = process.env.DSH_WORKDESKTOP_MATTER_ACTIONS || join(PWB_DIR, 'matter-actions.json')
// ── 业务对象层产物（聚合平面 · 2026-09-16）：卡片按需取数，host 只做透传，不加工 ──
const PWB_OBJECTS = join(PWB_DIR, 'objects.json')
const PWB_DISPOSITION = join(PWB_DIR, 'disposition.json')
const PWB_CROSSCHECK = join(PWB_DIR, 'crosscheck.json')
const PWB_DOMAIN_HEALTH = join(PWB_DIR, 'domain-health.json')
const PWB_BRIEF = join(PWB_DIR, 'brief.json')
// 决策卡（2026-09-17 改名）读的就是 `brief.json`。**写操作之后必须把它重建**，否则卡上还是旧世界
// （条目关了/重定了截止却仍在原来的桶里）—— 用的就是 run-objects-pipeline 里那一步的**同一个文件**，
// 本层不复制它的任何判定（实测 ~120ms，且对同一组输入逐字节可复现）。
const PWB_BRIEF_BUILD = process.env.DSH_WORKDESKTOP_BRIEF_BUILD || join(KNOWLEDGE, '_meta', 'workbench', 'build-brief.mjs')
const PWB_INSIGHTS = join(PWB_DIR, 'insights.json')
// ── 「资产」卡（`recall`，2026-09-17 改名）接入本地 RAG 的一期产物（2026-09-23）──
//   双口径并存：`curated`（库内精读语料，旧口径）· `all`（本地 RAG 全库）。
//   host **只读透传**，不直接调 RAG（查询向量需现场用 bge-m3 嵌入，Node 侧没有）。
//   `RAG 不可用` 必须显式传给卡面（`available:false` + `error`），不得让卡面显示 0。
const PWB_ASSETS = join(PWB_DIR, 'assets.json')
const PWB_ASSETS_BUILD = process.env.DSH_WORKDESKTOP_ASSETS_BUILD || join(KNOWLEDGE, '_meta', 'workbench', 'build-assets.mjs')
const PWB_MATTER_CLI = process.env.DSH_WORKDESKTOP_MATTER_CLI || join(KNOWLEDGE, '_meta', 'workbench', 'cli-matter.mjs')
// ── 触发响应写入口（T32 · 2026-09-16）───────────────────────────────────────
//   triggers.json 是**判断层产物**（每次管线重建从零派生）⇒ 人工响应不得直改产物，
//   必须写登记表 `trigger-responses.json`，再由管线步骤 `apply-trigger-responses.mjs` 回放
//   —— 与 matter-overrides 完全同构（写通道单一：面板与 DSH 工具共用 cli-trigger.mjs）。
//   分组（已超时 / 今日到期 / 其它未响应）由 CLI 用**冻结层选择器**算好，host 只透传；
//   用户在面板里写的中文走 `--from-json`（Windows 传非 ASCII argv 可能被转码，与 cli-matter 同处理）。
const PWB_TRIGGERS = process.env.DSH_WORKDESKTOP_TRIGGERS || join(PWB_DIR, 'triggers.json')
const PWB_TRIGGER_REG = process.env.DSH_WORKDESKTOP_TRIGGER_RESPONSES || join(PWB_DIR, 'trigger-responses.json')
const PWB_TRIGGER_CLI = process.env.DSH_WORKDESKTOP_TRIGGER_CLI || join(KNOWLEDGE, '_meta', 'workbench', 'cli-trigger.mjs')
const PWB_TRIGGER_REQ = join(PWB_DIR, '.runtime', 'trigger-request.json')
// 听记 → 事务（第四条）的草稿请求文件。
//   ⚠️ **不能**落在 `_meta/out/`──连子目录也不行！`cli-matter.mjs` 的 `checkScratchPath()`
//   把"草稿落在产物目录"当**硬错**（`_meta/out` 下每个 .json 都按产物登记，未登记即红），
//   而 `/intake` 转调的正是 `cli-matter.mjs add --from-json <草稿>` ⇒ 放进去会被**当场拒收**。
//   本轮实测（HTTP 级探针）：写成 `out/.runtime/intake-request.json` 时返回
//   「草稿不要放在产物目录 … 建议写到 _meta/tmp/ 或系统临时目录」⇒ 一键转事务**在真机上必然失败**。
//   修法：与 `RUN_DIR`（`%TEMP%/dsh-workdesktop`）同址 —— 那里是进程级临时目录，不进产物平面。
//   ⚠️ 这个坑**只有端到端（路由 → CLI）才暴露**：T16-187 的沙箱测试用的是 tmpdir、
//   校验分支探针又跑不到 CLI ⇒ 两支都绿而功能是坏的。已补 T16-192 把这条规则变成**常驻判据**。
const PWB_INTAKE_REQ = join(RUN_DIR, 'intake-request.json')
const TRIGGER_ID_RE = /^TR-[A-Za-z0-9-]{1,40}$/
const TRIGGER_CACHE_MS = Number(process.env.DSH_WORKDESKTOP_TRIGGER_CACHE_MS || 15000)
// 待议流入的处置写入口（2026-09-16 · 流入卡专用）：
//   闸判 `pending`（未命中任何关注域、需人定边界）后，系统里原本**没有任何出口** ——
//   `gate.resolvePending()` 只在测试 run-t4.mjs 里被调用，host 无路由、库里无 CLI。
//   本路由转调 cli-disposition.mjs（它负责"必须写理由 / 只能处置 pending / id 碰撞要 --source"三条纪律）。
const PWB_DISP_CLI = process.env.DSH_WORKDESKTOP_DISP_CLI || join(KNOWLEDGE, '_meta', 'workbench', 'cli-disposition.mjs')
// 判断质量台账（T31 建议 5）：产物 + 唯一写入口 CLI（与 DSH 工具/面板共用 ⇒ P2 单真相源）
const PWB_FEEDBACK = join(PWB_DIR, 'feedback.json')
const PWB_FEEDBACK_CLI = process.env.DSH_WORKDESKTOP_FEEDBACK_CLI || join(KNOWLEDGE, '_meta', 'workbench', 'cli-feedback.mjs')
// 卡片顺序**覆盖层**（2026-09-16 用户裁定：面板可拖动排序）——
//   默认顺序在 client 的 `CARD_ORDER`（契约，被断言）；本文件只是用户覆盖，只影响渲染。
//   落 host 的理由：跨刷新/跨设备一致，且**可读可断言**（localStorage 读不出来也测不了）。
const PWB_UI_PREFS = process.env.DSH_WORKDESKTOP_UI_PREFS || join(PWB_DIR, 'ui-prefs.json')
// 日程**取消 / 恢复** 的决策台账（2026-09-20 用户规格 · 第三条「日程取消」）——
//   形态照 `trigger-responses.json`：面板写一条**覆盖层决定**，`/snapshot` 的三天窗口据此过滤。
//   ⚠️ 只影响**面板看到的窗口**，不改任何源头日历（钉钉/飞书的真事件仍在）——
//     面板不是源头的写者，所以「取消」是**可恢复**的：删掉一条记录，行就回来。
//   唯一写入口 = host `POST /schedule/act`（键由 host 用事件身份字段算，客户端**不自己拼键**，
//   否则 host 过滤与 client 显示会长出两套键 ⇒ 静默失配）。
const PWB_SCHED_CANCELS = process.env.DSH_WORKDESKTOP_SCHED_CANCELS || join(PWB_DIR, 'schedule-cancels.json')
// 台账保留窗口（天）：只留最近 90 天的取消记录（三天窗口外的旧记录没有恢复价值，且会无限增长）
const SCHED_CANCEL_KEEP_DAYS = Number(process.env.DSH_WORKDESKTOP_SCHED_KEEP_DAYS || 90)
// ⚠️ 已知卡片 key 的**唯一来源是 client 的 CARD_ORDER**（默认顺序表）。这里重复一份是为了
//    在 host 侧做"未知 key 忽略"的校验（host 不引入 client 的 React 依赖）。
//    T16-59 会断言两者**逐项一致** ⇒ 将来新增卡片而忘了同步，回归会红，不会静默失配。
//    ⚠️ 顺序敏感：必须与 client.js 的 CARD_ORDER **逐项**一致（同步自「用户裁定 2026-09-16 · 三带布局」）。
//    这份表漏改的后果不是报错而是**静默丢卡**：`/ui-prefs` 会用本表过滤覆盖层，
//    本表里没有的 key 会被当成"未知 key"忽略 ⇒ 用户拖动过的卡片位置失效、甚至退回默认。
//    ⚠️ 2026-09-20：`domains` 已并入 `focus`（卡名「专注 · 活跃」，15 → 14 张卡）⇒ 本表同步删该键。
//      被合并掉的 `domains` 从此是**未知键**：覆盖层里残留的它会被忽略（不报错、不影响渲染），
//      其余已知键照旧生效、顺序**不会整体回默认**（规则见 `mergeUiPrefs`）。这是刻意保留的兼容行为。
//    ⚠️ 2026-09-21（P2b）：`objects`（「对象」）已**撤卡**（对象改为**属性**并入事务卡 / 事务详情 /
//      流入 / 洞察证据段，14 → 13 张卡）⇒ 本表同步删该键，兼容行为同上（旧覆盖层里的 `objects`
//      成为未知键，被静默忽略、其余键照旧生效）。漏改本表的后果依旧是**静默丢卡**。
const KNOWN_CARD_KEYS = ['brief', 'triggers', 'matters', 'schedule', 'todos', 'focus', 'inflow', 'insights', 'recall', 'metrics', 'kb', 'minutes', 'system']
// 覆盖层**已知字段**（未知 key 忽略并回报）。两个字段各有唯一写入口，且**必须 merge 写**：
//   · `cardOrder`   —— 拖动排序（面板）；
//   · `briefSeenAt` —— 决策卡的「标记已读」游标，`build-brief.mjs` 直接读它算「昨夜动向」窗口。

//   · `briefRead`   —— 决策卡的**逐条已读**集合 `{ <条目键>: ISO | null }`（用户 2026-09-17 修正①：
//     卡面不再有批量「标记已读」；`null` = 撤销该条的已读）。`build-brief.mjs` 读它算「N 条新」。
const UI_PREF_FIELDS = ['cardOrder', 'briefSeenAt', 'briefRead']

/**
 * `/ui-prefs` POST 的**纯函数核**：读改写（merge）+ 校验 + 未知 key 忽略。
 *
 * 输入：`prev` = 现有 `ui-prefs.json` 的内容（不存在给 null）；`body` = 请求体。
 * 输出：`{ ok, error?, updated?, kept, ignored, duplicated, ignoredKeys, hasOrder, hasSeen }`。
 *
 * ⚠️ 为什么必须是 merge 而不是整份覆盖：`cardOrder`（拖动排序）与 `briefSeenAt`（决策卡的
 *   「标记已读」游标）是**同一个文件的两个字段**，各有唯一写入口。整份覆盖会让后写的那个把
 *   先写的抹掉，而 `briefSeenAt` 被抹掉 = 决策卡的游标失效（每次都当成"从没看过"）。
 * ⚠️ 为什么抽成纯函数：host 路由要重启 DSH 才生效，纯函数可以在 Node 里直接单测
 *   （`__test.mergeUiPrefs`，见 selftest）—— 校验规则不用等重启就能验证。
 */
function mergeUiPrefs(prev, body) {
  const src = (body !== null && typeof body === 'object') ? body : {}
  const hasOrder = Object.prototype.hasOwnProperty.call(src, 'cardOrder')
  const hasSeen = Object.prototype.hasOwnProperty.call(src, 'briefSeenAt')

  const hasRead = Object.prototype.hasOwnProperty.call(src, 'briefRead')
  const out = { ok: false, error: null, updated: null, kept: [], ignored: [], duplicated: [], ignoredKeys: [], hasOrder, hasSeen, hasRead }
  out.ignoredKeys = Object.keys(src).filter((k) => UI_PREF_FIELDS.indexOf(k) === -1)
  if (!hasOrder && !hasSeen && !hasRead) {
    out.error = '至少给一个字段: ' + UI_PREF_FIELDS.join(' / ')
    return out
  }
  const updated = Object.assign({}, (prev !== null && typeof prev === 'object') ? prev : {}, {
    version: 1,
    updatedAt: new Date().toISOString(),
  })
  let kept = Array.isArray(updated.cardOrder) ? updated.cardOrder : []
  if (hasOrder) {
    if (!Array.isArray(src.cardOrder)) { out.error = 'cardOrder must be an array'; return out }
    kept = []
    for (const k of src.cardOrder) {
      const key = typeof k === 'string' ? k.trim() : ''
      if (key === '') continue
      if (!KNOWN_CARD_KEYS.includes(key)) { out.ignored.push(key); continue }   // 未知 key 忽略
      if (kept.includes(key)) { out.duplicated.push(key); continue }           // 重复只取首次
      kept.push(key)
    }
    updated.cardOrder = kept
  }
  if (hasSeen) {
    // 游标只接受**可解析的 ISO 时刻**：写坏值 = 把"上次看过"变成一个读不出来的时间点，
    // 产物只能整段回退 24 小时 —— 宁可拒绝，也不静默写坏（BR-25/BR-26 直接读这个字段）。
    if (src.briefSeenAt !== null
      && (typeof src.briefSeenAt !== 'string' || Number.isNaN(Date.parse(String(src.briefSeenAt).trim())))) {
      out.error = 'briefSeenAt must be an ISO timestamp'
      return out
    }
    updated.briefSeenAt = src.briefSeenAt === null ? null : String(src.briefSeenAt).trim()
  }

  if (hasRead) {
    // 逐条已读（用户 2026-09-17 修正①）：`{ <条目键>: ISO | null }`，`null` = **撤销**该条。
    //  ⚠️ **合并写**：只动请求里提到的键 —— 若整份覆盖，"标一条"会把其它条的已读全抹掉。
    if (src.briefRead === null || typeof src.briefRead !== 'object' || Array.isArray(src.briefRead)) {
      out.error = 'briefRead must be an object: { <itemKey>: ISO | null }'
      return out
    }
    const cur = (updated.briefRead !== null && typeof updated.briefRead === 'object' && !Array.isArray(updated.briefRead)) ? updated.briefRead : {}
    const merged = Object.assign({}, cur)
    let marked = 0; let unmarked = 0
    for (const k of Object.keys(src.briefRead)) {
      const key = String(k).trim()
      if (key === '') continue
      const v = src.briefRead[k]
      if (v === null) { if (Object.prototype.hasOwnProperty.call(merged, key)) { delete merged[key]; unmarked += 1 } continue }
      if (typeof v !== 'string' || Number.isNaN(Date.parse(v.trim()))) { out.error = 'briefRead["' + key + '"] must be an ISO timestamp or null'; return out }
      merged[key] = v.trim()
      marked += 1
    }
    updated.briefRead = merged
    out.readMarked = marked
    out.readUnmarked = unmarked
  }
  out.ok = true
  out.updated = updated
  out.kept = kept
  return out
}

/**
 * `/ui-prefs` 写入后**是否需要重建 brief 产物**（纯函数 ⇒ 可单测，不用等重启）。
 *
 * ⚠️ 2026-09-17 修复的真 bug：原判据只看 `merged.hasSeen`（字符串游标 `briefSeenAt`），
 *    而"逐条已读"（修正①）写的是 `briefRead` —— 于是**文件写成功、产物不重建**：
 *    `brief.json` 里该条仍 `read:false`、`new_count` 不变，界面点了行尾 ○ 毫无变化。
 *    正确判据 = 游标变了 **或** 已读集合真的增删过（`readMarked + readUnmarked > 0`）。
 *    ⚠️ 不要退回"只看 hasSeen"：那正是这个 bug 的形态。
 *
 * @param {{hasSeen?:boolean, hasRead?:boolean, readMarked?:number, readUnmarked?:number}} merged
 *        `mergeUiPrefs()` 的返回值
 * @returns {boolean}
 */
function shouldRebuildBrief(merged) {
  if (merged === null || typeof merged !== 'object') return false
  if (merged.hasSeen === true) return true
  if (merged.hasRead === true && ((merged.readMarked || 0) + (merged.readUnmarked || 0)) > 0) return true
  return false
}
// 个人待办目录 + 其唯一写入口（手动放置 / 会话内创建 同一真相源）
const TODO_DIR = process.env.DSH_WORKDESKTOP_TODO_DIR || join(KNOWLEDGE, 'Other', 'Todo')
const PWB_TODO_CLI = process.env.DSH_WORKDESKTOP_TODO_CLI || join(KNOWLEDGE, '_meta', 'workbench', 'cli-todo.mjs')
// 待办回写动作台账（成功/失败都记）：既是审计留痕，也是「最近关闭 → 可重新打开」的数据源
const PWB_TODO_ACTIONS = process.env.DSH_WORKDESKTOP_TODO_ACTIONS || join(PWB_DIR, 'todo-actions.json')
const PWB_MATTER_OVR = process.env.DSH_WORKDESKTOP_MATTER_OVERRIDES || join(PWB_DIR, 'matter-overrides.json')
// 关闭条件求值（2026-09-15 需求）：库内 CLI，复用适配器观测判定 —— 本层不复制 marker 匹配逻辑
const PWB_MATTER_CHECK_CLI = process.env.DSH_WORKDESKTOP_MATTER_CHECK_CLI || join(KNOWLEDGE, '_meta', 'workbench', 'cli-matter-check.mjs')
// 自动检测节流（自测里设为 0 可让每次指纹变化都触发）
const AUTO_CHECK_MS = Number(process.env.DSH_WORKDESKTOP_AUTOCHECK_MS || 60000)
// 周期兜底检测间隔（2026-09-15 需求）：关闭条件的证据是**产出物落盘**，那不是"流入事件"，
// 不会触发 ingest 派生 —— 所以必须有一个定时检测点，否则只能等面板被打开/有人跑管线才被发现。
const CHECK_INTERVAL_MS = Number(process.env.DSH_WORKDESKTOP_CHECK_INTERVAL_MS || 300000)
const RECORD_KINDS = ['progress', 'decision', 'risk', 'note']
const MATTER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/**
 * One PowerShell pass for every source.
 *
 * `dws todo` silently returns an empty list when `--size` exceeds 20, so the
 * page size stays at the default; every signed-in organization is queried and
 * the merge happens in JS.
 *
 * 日程（2026-09-15 用户要求「全组织日程，以个人视角」）：
 *   改用 `dws calendar +agenda`（**个人主日历**视角，含 eventId），
 *   逐 profile（= 逐组织）拉今天 00:00 → 明天 23:59，再在 JS 里按日期归并。
 *   旧实现用 `calendar +today/+tomorrow` 取的是**组织日历视图**，与"我的日程"不是一回事。
 */
const SCRIPT = `$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$K = Join-Path (Join-Path $env:USERPROFILE 'Desktop') 'Knowledge'
$epoch = [datetime]'1970-01-01'
$sep = [char]92
$skip = @('node_modules','.venv','venv','site-packages','__pycache__','.git','dist','build','.next','target')
$dws = 'dws'
if (-not (Get-Command dws -ErrorAction SilentlyContinue)) { $c = Join-Path (Join-Path $env:APPDATA 'npm') 'dws.cmd'; if (Test-Path $c) { $dws = $c } }
$stamp = { param($f) [int64](([datetime]$f.LastWriteTime).ToUniversalTime() - $epoch).TotalMilliseconds }
$agStart = (Get-Date).ToString('yyyy-MM-dd') + 'T00:00:00+08:00'
$agEnd = (Get-Date).AddDays(2).ToString('yyyy-MM-dd') + 'T23:59:59+08:00'
$plist = (& $dws profile list 2>&1 | Out-String)
$profs = @()
try { $pj = $plist | ConvertFrom-Json; if ($pj.profiles) { $profs = @($pj.profiles) } } catch {}
$o = [ordered]@{}
$o.psVersion = $PSVersionTable.PSVersion.ToString()
$o.orgCount = @($profs).Count
$o.minutes = (& $dws minutes +list-mine 2>&1 | Out-String)
$perOrg = @()
foreach ($pf in $profs) {
  # ⚠️⚠️ --size 的**上限实测 = 20**：>20（如 50）时钉钉接口**静默返回空**（count=0、todos=[]），
  #   不报错、不提示 —— 2026-09-17 实测踩到：本脚本曾写 --size 50（想把待办全量取回），
  #   结果**三个组织的待办全部变成 0**（面板显示「钉钉 0」），而同一命令 --size 20 正常返回 19 条。
  #   ⇒ 铁律：--size 只能 ≤ 20；要更多条用 --page 翻页（实测 page 2/3 可用，取空即止）。
  #   翻页只为**必要时**付代价：第 1 页不足 20 条就说明没有下一页。
  #   （注：本段在 JS 模板字面量里，**注释中不得出现反引号** —— 会截断模板串。）
  #
  # ★ 角色**分读**（2026-09-17 用户要求覆盖钉钉客户端的四类待办）：
  #   客户端「待办」按归属分：稍后处理 / 别人安排给我的 / 我安排给别人的 / 个人创建属于自己的。
  #   实测：+get-my-tasks 的投影只给 {dueTime, finalStatusStage, priority, subject, taskId}，
  #   **不带任何角色字段** ⇒ 想知道"这条是谁安排的"，只能**按角色分别读**，再本地求交/并：
  #     · creator ∩ executor      = 个人创建给自己的
  #     · executor 且非 creator    = 别人安排给我的
  #     · creator 且非 executor    = 我安排给别人的
  #     · participant（且非上面三种）= 我参与的
  #   三读的并集 = 全部相关待办（实测：逐角色并集 15 = 合并读 15 ⇒ 一条不漏）。
  $roleOut = [ordered]@{}
  foreach ($role in @('executor','creator','participant')) {
    $r1 = (& $dws todo +get-my-tasks --profile $pf.profile --role-types $role --status false --size 20 --page 1 2>&1 | Out-String)
    $r2 = ''
    $rn = 0
    try { $rj = $r1 | ConvertFrom-Json; if ($rj.todos) { $rn = @($rj.todos).Count } } catch {}
    if ($rn -ge 20) { $r2 = (& $dws todo +get-my-tasks --profile $pf.profile --role-types $role --status false --size 20 --page 2 2>&1 | Out-String) }
    $roleOut[$role] = $r1
    $roleOut[$role + 'P2'] = $r2
  }
  # 个人视角日程：+agenda（默认 primary 主日历，即"我的日程"），逐组织拉，
  # 后续在 JS 里按日期归并为 今天/明天 两栏（并保留组织标签）。
  $ag = (& $dws calendar +agenda --profile $pf.profile --start $agStart --end $agEnd --limit 100 2>&1 | Out-String)
  $perOrg += [ordered]@{ corpId = $pf.corpId; corpName = $pf.corpName; profile = $pf.profile; status = $pf.status; agenda = $ag
    todosExecutor = $roleOut['executor']; todosExecutorP2 = $roleOut['executorP2']
    todosCreator = $roleOut['creator']; todosCreatorP2 = $roleOut['creatorP2']
    todosParticipant = $roleOut['participant']; todosParticipantP2 = $roleOut['participantP2'] }
}
$o.perOrg = $perOrg
$o.agendaRange = [ordered]@{ start = $agStart; end = $agEnd }
$all = @()
foreach ($c in @('Work','Learn','Research','Life','Other','Tools','Temp')) { $all += @(Get-ChildItem -LiteralPath (Join-Path $K $c) -Recurse -File -ErrorAction SilentlyContinue) }
$all += @(Get-ChildItem -LiteralPath $K -File -ErrorAction SilentlyContinue)
$files = @($all | Where-Object { $p = $_.FullName.Split($sep); $ok = $true; foreach ($s in $skip) { if ($p -contains $s) { $ok = $false } }; $ok })
$o.totalFiles = @($files).Count
$o.skipped = @($all).Count - @($files).Count
$pick = { param($list, $n) @($list | Sort-Object LastWriteTime -Descending | Select-Object -First $n | ForEach-Object { [ordered]@{ name = $_.Name; path = $_.FullName; size = $_.Length; mtime = & $stamp $_ } }) }
$o.recent = & $pick $files 14
$counts = [ordered]@{}
foreach ($f in $files) { $rel = $f.FullName.Substring($K.Length); $parts = @($rel.Split($sep) | Where-Object { $_ -ne '' }); $cat = 'root'; if ($parts.Count -gt 1) { $cat = $parts[0] }; if ($counts.Contains($cat)) { $counts[$cat] = $counts[$cat] + 1 } else { $counts[$cat] = 1 } }
$o.counts = $counts
$byCat = [ordered]@{}
foreach ($c in @('Learn','Research','Work','Life')) { $byCat[$c] = & $pick @($files | Where-Object { $_.FullName -like (Join-Path $K ($c + '*')) }) 10 }
$o.byCategory = $byCat
$o.todoFiles = @(Get-ChildItem -LiteralPath (Join-Path (Join-Path $K 'Other') 'Todo') -Recurse -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 10 | ForEach-Object { [ordered]@{ name = $_.Name; path = $_.FullName; size = $_.Length; mtime = & $stamp $_ } })
[Console]::Out.Write(($o | ConvertTo-Json -Depth 6 -Compress))
`

/* ── Node 侧并发取数（2026-10-03 用户要求「改成 Node 直接并发取数」）─────────────
 * 为什么不再走上面那段 PowerShell（本机实测，2026-10-03）：
 *   · 整轮采集 24.6 秒 = PowerShell 那段 **15.7 秒**（钉钉命令 ~12.7 秒 + 递归扫文件 3.0 秒）
 *     + 飞书四条**串行** ~9 秒；
 *   · 那 12.7 秒几乎全是**排队等进程**：一次 dws 调用 440~600ms，其中 ~300ms 是启动
 *     （`dws.cmd` 是 cmd → node → dws.exe 三层包装）；
 *   · 同样 12 次调用**并发 6 路 0.97 秒**（16 次 1.42 秒，无一失败）；同样的文件扫描
 *     Node 只要 **0.2 秒**（PowerShell 5.1 是 3.0 秒）。
 *
 * 三条不许动的边界：
 *   ① 返回对象与老脚本**逐字段同形**（`perOrg[].todosExecutor/todosCreator/todosParticipant`
 *      及其 `…P2`、`agenda`、`minutes`、`totalFiles`、`counts`、`recent`、`byCategory`、
 *      `todoFiles`）⇒ `collect()` 下游一行都不用改；
 *   ② 仍然**每组织、每角色各读一次**：`+get-my-tasks` 的投影**不带角色字段**，合并读会让
 *      「四类归属」失去判定依据（见 `classifyTodoItems` 的长注释）；
 *   ③ `--size` 只能 ≤ 20（>20 静默返回空，已造成过「钉钉 0」事故），更多条走 `--page`。
 *
 * 回退：设 `DSH_WORKDESKTOP_COLLECT=ps` 可走回老脚本；找不到 `dws.exe` 时也自动回老脚本。
 */
const DWS_ROLES = ['executor', 'creator', 'participant']
// 直连 `vendor\dws.exe`：绕过 dws.cmd 的 cmd → node 两层包装，单次调用省 ~150ms
const DWS_EXE_PATHS = [
  process.env.DSH_WORKDESKTOP_DWS_EXE || '',
  process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules', 'dingtalk-workspace-cli', 'vendor', 'dws.exe') : '',
  HOME ? join(HOME, 'AppData', 'Roaming', 'npm', 'node_modules', 'dingtalk-workspace-cli', 'vendor', 'dws.exe') : '',
].filter((p) => p !== '')
let dwsExeResolved
function dwsExe() {
  if (dwsExeResolved === undefined) dwsExeResolved = DWS_EXE_PATHS.find((p) => existsSync(p)) || ''
  return dwsExeResolved
}
function envNum(name, dflt, lo, hi) {
  const n = Number(process.env[name])
  if (!Number.isFinite(n) || n <= 0) return dflt
  return Math.max(lo, Math.min(hi, n))
}
const DWS_CONCURRENCY = envNum('DSH_WORKDESKTOP_DWS_CONCURRENCY', 6, 1, 16)
const DWS_TIMEOUT_MS = envNum('DSH_WORKDESKTOP_DWS_TIMEOUT_MS', 30000, 5000, 300000)
// 本地扫描的跳过名单：与老脚本逐字一致（命中即整棵子树不进统计）
const SCAN_DIRS = ['Work', 'Learn', 'Research', 'Life', 'Other', 'Tools', 'Temp']
const SCAN_SKIP = new Set(['node_modules', '.venv', 'venv', 'site-packages', '__pycache__', '.git', 'dist', 'build', '.next', 'target'])

/** 并发闸门：按上限跑一批任务，**按输入顺序**返回结果；单个任务抛错只让那一格落空 */
async function poolMap(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const width = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: width }, async () => {
    for (;;) {
      const k = next
      next += 1
      if (k >= items.length) return
      try { out[k] = await fn(items[k], k) } catch { out[k] = null }
    }
  }))
  return out
}

/**
 * 一次 dws 调用 → 原始输出字符串（失败回落 `''`，容错口径与老脚本的 `2>&1 | Out-String` 一致）。
 * 优先只用 stdout：只有 stdout 里连 `{` 都没有时才把 stderr 接上（否则警告会污染 JSON 解析）。
 */
async function dwsRaw(args) {
  const r = await run(dwsExe(), args, DWS_TIMEOUT_MS)
  const out = String(r.stdout || '')
  if (out.includes('{')) return out
  const err = String(r.stderr || '')
  return err === '' ? out : out + err
}

/**
 * 本地知识库扫描（Node 版）：与老 PowerShell 脚本**同样的 7 个目录 + 根目录文件、同样的跳过名单**。
 * 差别只有一处：命中跳过名单的目录**不再往里走**（老脚本会走进去再逐条丢弃 —— 那 3 秒大半花在这）。
 * 两个口径最终留下的文件集合是同一个，所以 `totalFiles` 与老脚本一致（`skipped` 无人读，保留字段）。
 */
async function scanKnowledge() {
  const files = []
  const walkFiles = async (dir, out, depth) => {
    if (depth > 12) return
    let ents
    try { ents = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (e.isSymbolicLink()) continue // 不跟软链（避免成环；知识库里没有这类目录）
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (!SCAN_SKIP.has(e.name)) await walkFiles(full, out, depth + 1)
        continue
      }
      // 点号开头的**文件**不计入（老脚本的 `Get-ChildItem` 不带 `-Force` 看不见隐藏项）。
      // ⚠️ 只跳文件、**不跳点号目录**：`.archive` 这类目录老脚本是能进去的（里面几十个文件都算数），
      //    连目录一起跳会让总数比老版少 40 个。
      // 残留差别（实测 ±2 个，约 0.05%）：老脚本按 Windows「隐藏」属性判定 ——
      //    它看不见 `WeChatlog\.obsidian\*`（4 个，Node 会走进去），但看得见
      //    `.editorconfig` / `.gitignore`（2 个，Node 按点号跳掉）。
      //    Node 读不到 Windows 隐藏属性（`fs.Stats` 不映射 FILE_ATTRIBUTE_HIDDEN），故用点号近似。
      if (e.name.startsWith('.')) continue
      if (!e.isFile()) continue
      try {
        const st = await stat(full)
        out.push({ name: e.name, path: full, size: st.size, mtime: Math.round(st.mtimeMs) })
      } catch { /* 读不到就跳过（不让一个坏文件拖垮整卡） */ }
    }
  }
  for (const c of SCAN_DIRS) await walkFiles(join(KNOWLEDGE, c), files, 0)
  // 根目录只取**直属文件**（与 `Get-ChildItem -File` 不带 -Recurse 同义）
  let rootEnts = []
  try { rootEnts = await readdir(KNOWLEDGE, { withFileTypes: true }) } catch { rootEnts = [] }
  for (const e of rootEnts) {
    if (e.name.startsWith('.')) continue // 同上：隐藏文件不计入
    if (!e.isFile()) continue
    const full = join(KNOWLEDGE, e.name)
    try {
      const st = await stat(full)
      files.push({ name: e.name, path: full, size: st.size, mtime: Math.round(st.mtimeMs) })
    } catch { /* 同上 */ }
  }

  const byMtime = (a, b) => b.mtime - a.mtime
  const pick = (list, n) => list.slice().sort(byMtime).slice(0, n)
    .map((f) => ({ name: f.name, path: f.path, size: f.size, mtime: f.mtime }))
  const counts = {}
  for (const f of files) {
    const rel = f.path.slice(KNOWLEDGE.length).split(/[\\/]/).filter((s) => s !== '')
    const cat = rel.length > 1 ? rel[0] : 'root'
    counts[cat] = (counts[cat] || 0) + 1
  }
  const byCategory = {}
  for (const c of ['Learn', 'Research', 'Work', 'Life']) {
    const prefix = join(KNOWLEDGE, c)
    byCategory[c] = pick(files.filter((f) => f.path.startsWith(prefix)), 10)
  }
  const todoRaw = []
  await walkFiles(join(join(KNOWLEDGE, 'Other'), 'Todo'), todoRaw, 0)

  return {
    totalFiles: files.length,
    skipped: 0, // 老脚本会走进跳过名单再丢弃，这里直接不进 —— 该字段无人读，保留只为同形
    recent: pick(files, 14),
    counts,
    byCategory,
    todoFiles: pick(todoRaw, 10),
  }
}

/**
 * 钉钉 + 本地知识库的**并发**采集，产出与老 PowerShell 脚本同形的对象。
 * 找不到 `dws.exe` ⇒ 返回 null（由 `collect()` 回落到老脚本）。
 */
async function gatherDwsAndFiles() {
  if (dwsExe() === '') return null
  const started = Date.now()
  // 文件扫描与钉钉调用**同时**进行（本地 I/O 只占 0.2 秒，白等不如叠着跑）
  const scanPromise = scanKnowledge().catch(() => null)

  activity.dwsBusy = true
  let profs = []
  let minutesRaw = ''
  const byKey = new Map()
  let agWindow = { start: '', end: '' }
  try {
    const profDoc = parseJsonLoose(await dwsRaw(['profile', 'list']))
    profs = profDoc && Array.isArray(profDoc.profiles) ? profDoc.profiles : []

    // 日程窗口：今天 00:00 → 后天 23:59（与老脚本同口径，含时区偏移）
    const t = new Date()
    agWindow = {
      start: `${ymdLocal(t)}T00:00:00+08:00`,
      end: `${ymdLocal(new Date(t.getTime() + 2 * 86400000))}T23:59:59+08:00`,
    }

    const jobs = [{ key: 'minutes', args: ['minutes', '+list-mine'] }]
    for (const pf of profs) {
      // 键用 profile（= corpId:userId）：同组织多账号时 corpId 会撞键
      const prof = String(pf.profile || '')
      for (const role of DWS_ROLES) {
        jobs.push({
          key: `todo|${prof}|${role}`,
          args: ['todo', '+get-my-tasks', '--profile', prof,
            '--role-types', role, '--status', 'false', '--size', '20', '--page', '1'],
        })
      }
      jobs.push({
        key: `agenda|${prof}`,
        args: ['calendar', '+agenda', '--profile', prof,
          '--start', agWindow.start, '--end', agWindow.end, '--limit', '100'],
      })
    }
    const results = await poolMap(jobs, DWS_CONCURRENCY, (j) => dwsRaw(j.args))
    for (let i = 0; i < jobs.length; i += 1) byKey.set(jobs[i].key, results[i] === null ? '' : results[i])
    minutesRaw = byKey.get('minutes') || ''

    // 第二页：只有第一页取满 20 条才可能有下一页（老脚本同规则）
    const p2 = []
    for (const pf of profs) {
      const prof = String(pf.profile || '')
      for (const role of DWS_ROLES) {
        const page1 = parseJsonLoose(byKey.get(`todo|${prof}|${role}`))
        const n = page1 && Array.isArray(page1.todos) ? page1.todos.length : 0
        if (n >= 20) {
          p2.push({
            key: `todo|${prof}|${role}|P2`,
            args: ['todo', '+get-my-tasks', '--profile', prof,
              '--role-types', role, '--status', 'false', '--size', '20', '--page', '2'],
          })
        }
      }
    }
    if (p2.length > 0) {
      const r2 = await poolMap(p2, DWS_CONCURRENCY, (j) => dwsRaw(j.args))
      for (let i = 0; i < p2.length; i += 1) byKey.set(p2[i].key, r2[i] === null ? '' : r2[i])
    }
  } finally {
    activity.dwsBusy = false
  }

  const perOrg = profs.map((pf) => {
    const prof = String(pf.profile || '')
    return {
      corpId: pf.corpId,
      corpName: pf.corpName,
      profile: pf.profile,
      status: pf.status,
      agenda: byKey.get(`agenda|${prof}`) || '',
      todosExecutor: byKey.get(`todo|${prof}|executor`) || '',
      todosExecutorP2: byKey.get(`todo|${prof}|executor|P2`) || '',
      todosCreator: byKey.get(`todo|${prof}|creator`) || '',
      todosCreatorP2: byKey.get(`todo|${prof}|creator|P2`) || '',
      todosParticipant: byKey.get(`todo|${prof}|participant`) || '',
      todosParticipantP2: byKey.get(`todo|${prof}|participant|P2`) || '',
    }
  })

  const scan = await scanPromise
  return {
    engine: 'node',
    engineMs: Date.now() - started,
    orgCount: profs.length,
    dwsArgs: { concurrency: DWS_CONCURRENCY, timeoutMs: DWS_TIMEOUT_MS, exe: dwsExe() },
    minutes: minutesRaw,
    perOrg,
    agendaRange: agWindow,
    totalFiles: scan === null ? 0 : scan.totalFiles,
    skipped: scan === null ? 0 : scan.skipped,
    recent: scan === null ? [] : scan.recent,
    counts: scan === null ? {} : scan.counts,
    byCategory: scan === null ? {} : scan.byCategory,
    todoFiles: scan === null ? [] : scan.todoFiles,
  }
}

/** Run one PowerShell invocation; never rejects. */
function ps(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(PS, args, { timeout: timeoutMs || 300000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: err === null,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: err === null ? null : String(err.message || err),
      })
    })
  })
}

/** Run any executable; never rejects. `code` = 退出码（拿不到时为 null，超时/被杀也归这里） */
function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs || 180000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: err === null,
        code: err === null ? 0 : (typeof err.code === 'number' ? err.code : null),
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: err === null ? null : String(err.message || err),
      })
    })
  })
}

/* ── 飞书 CLI 直连（2026-10-03，与钉钉那段同一个理由）──────────────────────────
 * `lark-cli` 在 PATH 上解析到的是 **`lark-cli.ps1`**（npm 的 PowerShell shim）⇒
 * 一次调用要套三层：外层 PowerShell → 那个 .ps1 → node。
 * 实测同一个命令（本机 2026-10-03）：
 *   · 老路（PS → lark-cli.ps1 → node）：**1477 ~ 1671 毫秒**
 *   · 直连 `node <…>\@larksuite\cli\scripts\run.js`：**236 ~ 259 毫秒**
 *
 * 命令**照命令行原样写成一行字符串**（`larkRun('calendar +agenda --start …')`）：
 * 既与 CLI 文档、库内套件里的写法对得上，也避免"参数数组"与"文档里的命令"两份描述漂移。
 * 找不到 node 入口 ⇒ 回退老路（PowerShell shim），保证换台机器/换 npm 布局也能取数。
 */
const LARK_ENTRY_PATHS = [
  process.env.DSH_WORKDESKTOP_LARK_ENTRY || '',
  process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js') : '',
  HOME ? join(HOME, 'AppData', 'Roaming', 'npm', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js') : '',
].filter((p) => p !== '')
let larkEntryResolved
function larkEntry() {
  if (larkEntryResolved === undefined) larkEntryResolved = LARK_ENTRY_PATHS.find((p) => existsSync(p)) || ''
  return larkEntryResolved
}

/**
 * 跑一次 lark-cli。返回 `{ out, exit, cliPath, direct }`：
 *   · `out` 尽量等价于老路上的 `2>&1 | Out-String` —— 优先用 stdout；stdout 里连 `{` 都没有时
 *     才把 stderr 接上（这个 CLI 有几条命令把 JSON 写进 stderr，见 `adapters/e-lark-im.mjs`）；
 *   · `exit` / `cliPath` 是**失败诊断的两个字段**（飞书妙记套件的 FM-13 盯着它俩），两条路都带。
 * `cwd` 只给需要"工作目录必须在知识库根"的命令用（`minutes +detail --output-dir` 的相对路径）。
 */
async function larkRun(cmd, timeoutMs, cwd) {
  const entry = larkEntry()
  if (entry !== '') {
    const argv = cmd.split(' ').filter((s) => s !== '')
    const r = await run(process.execPath, [entry, ...argv], timeoutMs)
    const out = r.stdout.includes('{') ? r.stdout : r.stdout + r.stderr
    return { out, exit: r.code, cliPath: entry, direct: true }
  }
  const script = "$ErrorActionPreference='SilentlyContinue'; try { [Console]::OutputEncoding=[Text.Encoding]::UTF8 } catch {}; "
    + (cwd ? `Set-Location -LiteralPath "${cwd}"; ` : '')
    + '$o = [ordered]@{}; '
    + `$o.cliPath = [string]((Get-Command ${LARK_CLI} -ErrorAction SilentlyContinue | Select-Object -First 1).Source); `
    + `$o.out = (& ${LARK_CLI} ${cmd} 2>&1 | Out-String); `
    + '$o.exit = $LASTEXITCODE; '
    + '$o | ConvertTo-Json -Depth 3 -Compress'
  const r = await ps(['-NoProfile', '-NonInteractive', '-Command', script], timeoutMs)
  const env = parseJsonLoose(r.stdout)
  if (env === null) return { out: r.stdout, exit: null, cliPath: LARK_CLI, direct: false }
  return { out: String(env.out || ''), exit: env.exit === undefined ? null : env.exit, cliPath: String(env.cliPath || LARK_CLI), direct: false }
}

async function readJson(p) {
  try { return JSON.parse(await readFile(p, 'utf8')) } catch { return null }
}

// ── 底部系统在线状态（2026-09-15 需求：DWS / MCP / 本地工具 / 浏览器 + 诊断）──────
// 诚实原则：**探测不到就说探测不到**（ok:null → 面板显示 ◌ 未知），不伪装成在线。
const SYS_CACHE_MS = 120000
let sysCache = { at: 0, data: null }

async function probeSystem() {
  // ① DWS（钉钉 CLI）：走 PowerShell（与 snapshot.ps1 同一套调用方式）
  let dws = { ok: null, version: null, detail: '' }
  // ② 本地工具：node / npm / git
  let tools = { ok: null, label: '—', detail: '' }
  try {
    // ⚠️ 2026-10-03：`node` 走 PATH 会**假阴性** —— 本机 DSH 有一次是在 PATH 里没有 node 的环境下起来的
    //   （nvm 的目录没进 PATH），于是这张卡把「本地工具」报成没探测到，而工具其实好好的。
    //   ⇒ 先试 PATH，拿不到再退回 `process.execPath`（绝对路径，与 host 同体，必然可用）。
    const nodeExe = String(NODE).replace(/'/g, "''")
    // ⚠️ 2026-10-03 第二处同类假阴性：`dws` 只按 PATH + `%APPDATA%\npm\dws.cmd` 找，
    //   而 DSH 有一次是在"PATH 里没有 npm 全局 bin"的环境下起来的 ⇒ 卡片报 `dws 未找到`，
    //   **可同一时刻采集明明跑得好好的**（采集走的是 `dwsExe()` 的绝对路径 vendor\dws.exe）。
    //   ⇒ 候选表按可靠性排序，全部在 JS 侧算成绝对路径传进去：
    //     ① `dwsExe()`（采集实际用的那一支 —— "卡片报的在线"与"采集真能用"必须是同一支）
    //     ② `%APPDATA%\npm\dws.cmd`（老兜底）
    const dwsCands = [dwsExe(), process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'dws.cmd') : '']
      .filter((p) => p !== '' && existsSync(p))
      .map((p) => `'${p.replace(/'/g, "''")}'`)
    const r = await ps(['-NoProfile', '-NonInteractive', '-Command',
      `$cands = @(${dwsCands.join(', ')}); ` +
      // 顺序：先 PATH 上的 `dws`（能用就用），**拿不到版本号再逐个试候选绝对路径**。
      // ⚠️ 不能写成"解析到就用、解析不到才试候选" —— 本机的坑正是：PATH 上**解析得到** `dws.ps1`，
      //   而那个 .ps1 里要去调 `node`（PATH 里没有）⇒ 解析成功、执行失败、版本号是空的。
      //   判据必须是"**拿到了版本号**"，不是"解析到了命令"。
      "$d = (Get-Command dws -ErrorAction SilentlyContinue); " +
      "$dv = if ($d) { (& $d --version 2>&1 | Out-String).Trim() } else { '' }; " +
      "foreach ($c in $cands) { if ($dv -match 'v?\\d+\\.\\d+') { break }; if (Test-Path $c) { $dv = (& $c --version 2>&1 | Out-String).Trim() } }; " +
      "$nv = (node --version 2>&1 | Out-String).Trim(); " +
      `if (-not $nv -or $nv -notmatch '^v?\\d') { $nv = (& '${nodeExe}' --version 2>&1 | Out-String).Trim() }; ` +
      "$np = (npm --version 2>&1 | Out-String).Trim(); $gv = (git --version 2>&1 | Out-String).Trim(); " +
      "Write-Output ($dv + '|' + $nv + '|' + $np + '|' + $gv)"], 20000)
    const parts = String(r.stdout || '').trim().split('|').map((x) => x.trim())
    const [dv, nv, npv, gv] = parts
    // ⚠️ 实测输出形如 "dws version v1.0.57 (6811a123, …)" —— 用 `/^\d/` 判会**误判成未安装**（假阴性），
    //    改为从输出里抽版本号。
    const dvMatch = /v?(\d+\.\d+(?:\.\d+)?)/.exec(dv || '')
    dws = dvMatch
      ? { ok: true, version: dvMatch[1], detail: String(dv).slice(0, 80) }
      : { ok: false, version: null, detail: 'dws 未找到或 --version 无输出' + (r.error ? '（' + String(r.error).slice(0, 60) + '）' : '') }
    const have = []
    if (/^v?\d/.test(nv || '')) have.push('node ' + nv)
    if (/^\d/.test(npv || '')) have.push('npm ' + npv)
    if (/^git version/.test(gv || '')) have.push(gv.split(' ').slice(0, 3).join(' '))
    tools = { ok: have.length >= 2, label: have.join(' · ') || '未探测到', detail: have.join('；') || 'node/npm/git 均未探测到' }
  } catch (e) {
    tools = { ok: null, label: '探测失败', detail: String((e && e.message) || e).slice(0, 120) }
  }

  // ③ MCP：查常见配置位置（不在则如实说"未配置"）
  let mcp = { ok: null, label: '未配置', detail: '' }
  const mcpCandidates = [
    join(HOME, '.dsh', 'mcp.json'),
    join(HOME, '.dsh', 'profiles', 'web', 'mcp.json'),
    join(HOME, '.dsh', 'profiles', 'web', 'dsh.mcp.json'),
    join(KNOWLEDGE, '.mcp.json'),
  ]
  let mcpFound = null
  for (const f of mcpCandidates) {
    const j = await readJson(f)
    if (j !== null) { mcpFound = { file: f, doc: j }; break }
  }
  if (mcpFound === null) {
    mcp = { ok: null, label: '未配置', detail: '未找到 MCP 配置文件（查过 ' + mcpCandidates.length + ' 处）' }
  } else {
    const servers = mcpFound.doc.mcpServers || mcpFound.doc.servers || {}
    const n = Object.keys(servers).length
    mcp = { ok: n > 0, label: n + ' 个', detail: n + ' 个 server（' + mcpFound.file + '）' }
  }

  // ④ 浏览器：本机是否有可驱动内核（Chrome/Edge）
  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ]
  let browser = { ok: null, label: '未检测', detail: '' }
  for (const p of chromePaths) {
    try {
      const st = await stat(p)
      if (st) { browser = { ok: true, label: p.includes('msedge') ? 'Edge' : 'Chrome', detail: p }; break }
    } catch { /* 继续 */ }
  }
  if (browser.ok === null) browser = { ok: false, label: '未装', detail: '未找到 Chrome/Edge' }

  return { ok: true, at: new Date().toISOString(), dws, mcp, tools, browser }
}

async function sysStatus(force) {
  if (force !== true && sysCache.data !== null && Date.now() - sysCache.at < SYS_CACHE_MS) return sysCache.data
  const data = await probeSystem().catch((e) => ({ ok: false, error: String((e && e.message) || e) }))
  sysCache = { at: Date.now(), data }
  return data
}

// ── 实时活动状态（2026-09-15 需求：DWS 在线/不在线 · MCP 正在调用/空闲 · 本地工具 · 浏览器）──
// 数据来源都是**真实运行**，不靠猜：
//   · 工具调用 → `ctx.on('tools/execute')` waterfall 包住每次派发，期间即"正在调用/操作"；
//     命名规则实测：MCP 工具形如 `mcp__<server>__<tool>`（harness 的 dsh-mcp-client 约定）；
//   · DWS → `/snapshot` 采集期间真的在调 dws ⇒ 采集进行中即"调用中"；
//   · MCP 是否已配置 → **看 tools 服务里当前注册的 `mcp__*` 工具**（比读配置文件可靠）。
const activity = { active: new Map(), recent: [], dwsBusy: false }
let ctxTools = undefined

// ── MCP 配置位置扫描（2026-09-16 因用户提问新增）─────────────────────────────
// 起因：用户「已把 Firecrawl 连到本机 docker，为何还显示未配置？」——
//   实测根因是**时序 + 位置**：MCP 客户端是**异步启动**的（首次 `npx -y firecrawl-mcp`
//   要下载包），启动完成前 host 注册表里没有 `mcp__*` ⇒ 面板显示红色「未配置」= **假阴性**；
//   而当时那份配置还只挂在某个 preset 里（跨会话不可见）。
// 所以：除了"注册表里有没有工具"（硬事实），再补一条"**有没有 MCP 配置行**"（软事实），
//   两者合起来才能区分三种状态：空闲中（已注册）/ **未注册（已配置，多半在启动中）** / 未配置。
// 只读扫描，缓存 120s；扫不到的路径一律忽略（不猜、不报错）。
const MCP_CFG_CACHE_MS = 120000
let mcpCfgCache = { at: 0, data: null }
function probeMcpConfig() {
  if (mcpCfgCache.data !== null && Date.now() - mcpCfgCache.at < MCP_CFG_CACHE_MS) return mcpCfgCache.data
  const found = []
  const files = []
  const dshHome = process.env.DSH_HOME || join(HOME, '.dsh')
  try {
    for (const prof of readdirSync(join(dshHome, 'profiles'))) {
      files.push(join(dshHome, 'profiles', prof, 'cordis.patch.yml'))
      files.push(join(dshHome, 'profiles', prof, 'cordis.yml'))
    }
  } catch { /* 无 profiles 目录 */ }
  try {
    for (const pre of readdirSync(join(dshHome, '.agent-presets'))) {
      files.push(join(dshHome, '.agent-presets', pre, 'agent.cordis.yml'))
    }
  } catch { /* 无预设目录 */ }
  for (const f of files) {
    let txt = ''
    try { txt = readFileSync(f, 'utf8') } catch { continue }
    if (!txt.includes('dsh-mcp-client')) continue
    // ⚠️ 只统计**生效的行**（2026-09-16 实测修正）：geo-web 里已**注释掉**的 firecrawl 行
    //    仍会被 `serverName:` 正则匹配到 ⇒ 面板会声称"别处已配置"，而实际提供者早已移到常驻层
    //    —— 这属于**不实陈述**（那种"把注释当生效"的错，正是本项目反复警惕的一类）。
    //    做法：先按行丢掉以 # 开头的注释行，再在剩下的文本里找。
    const active = txt.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n')
    if (!active.includes('dsh-mcp-client')) continue
    const servers = [...active.matchAll(/serverName:\s*([A-Za-z0-9_.-]+)/g)].map((m) => m[1])
    const where = f.replace(dshHome, '~/.dsh')
    found.push({ where, servers: [...new Set(servers)] })
  }
  const data = {
    rows: found.length,
    servers: [...new Set(found.flatMap((x) => x.servers))],
    where: found.map((x) => x.where + (x.servers.length ? '（' + x.servers.join('/') + '）' : '')),
  }
  mcpCfgCache = { at: Date.now(), data }
  return data
}

/** 工具名 → 类别（mcp / browser / local） */
function classifyTool(name) {
  const s = String(name || '')
  if (s.startsWith('mcp__')) {
    const rest = s.slice('mcp__'.length)
    const i = rest.indexOf('__')
    return { kind: 'mcp', label: i > 0 ? rest.slice(0, i) : rest, tool: i > 0 ? rest.slice(i + 2) : '' }
  }
  if (/^(web_fetch|web_search|browser|ego[-_]?browser|open_url)/i.test(s)) return { kind: 'browser', label: s, tool: s }
  return { kind: 'local', label: s, tool: s }
}

function activitySnapshot() {
  const now = Date.now()
  const active = [...activity.active.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((a) => ({ name: a.name, kind: a.kind, label: a.label, tool: a.tool, ms: now - a.startedAt }))
  let mcpServers = null
  try {
    if (ctxTools !== undefined && typeof ctxTools.schemas === 'function') {
      const names = ctxTools.schemas().map((s) => String(s.name || '')).filter((n) => n.startsWith('mcp__'))
      const servers = [...new Set(names.map((n) => classifyTool(n).label))]
      mcpServers = { count: servers.length, servers, tools: names.length }
    }
  } catch (e) { mcpServers = null }
  let mcpConfigured = null
  try { mcpConfigured = probeMcpConfig() } catch (e) { mcpConfigured = null }
  return {
    ok: true,
    at: new Date().toISOString(),
    active,
    recent: activity.recent.slice(0, 10),
    dwsBusy: activity.dwsBusy,
    mcpServers,
    mcpConfigured,     // { rows, servers, where } —— "有没有 MCP 配置行"（软事实，见上方注释）
  }
}

// ── 事务覆盖层（E 块）──────────────────────────────────────────────────────
function emptyActions() { return { version: 1, records: {}, closures: {}, reopens: {} } }

async function loadMatterActions() {
  const j = await readJson(PWB_MACTIONS)
  if (j === null || typeof j !== 'object') return emptyActions()
  const a = emptyActions()
  if (j.records && typeof j.records === 'object') a.records = j.records
  if (j.closures && typeof j.closures === 'object') a.closures = j.closures
  if (j.reopens && typeof j.reopens === 'object') a.reopens = j.reopens
  return a
}

async function loadMattersBase() {
  const j = await readJson(PWB_MATTERS)
  if (j === null || !Array.isArray(j.matters)) return []
  return j.matters
}

function findMatter(base, id) {
  for (let i = 0; i < base.length; i += 1) {
    const m = base[i]
    if (m && String(m.id) === id) return m
  }
  return null
}

/** 库内相对路径 → 绝对路径（知识库内）；绝对路径原样返回；非库路径返回 null */
function resolveVaultPath(rel) {
  const s = String(rel || '').trim()
  if (s.length === 0) return null
  if (/^[A-Za-z]:[\\/]/.test(s)) return s
  if (/^https?:/i.test(s)) return null
  return join(KNOWLEDGE, s)
}

/** 基态（matters.json，已含库内套用的人工处置）⊕ 展示层记录 = 有效事务。
 *  closures/reopens 字段保留兼容读取（历史文件可能有），但写入已全部归库内 cli-matter。 */
function effectiveMatter(baseMatter, actions, id) {
  const closure = (actions.closures || {})[id] || null
  const reopened = (actions.reopens || {})[id] || null
  const records = Array.isArray((actions.records || {})[id]) ? actions.records[id] : []
  let closedAt = baseMatter && baseMatter.closed_at ? baseMatter.closed_at : null
  let closureNote = baseMatter && baseMatter.closure_note ? baseMatter.closure_note : null
  if (closure !== null) { closedAt = closure.closed_at; closureNote = closure.closure_note }
  if (reopened !== null && closure === null) { closedAt = null; closureNote = null }
  const srcs = [baseMatter && baseMatter.source_ref, baseMatter && baseMatter.origin_project]
    .map(resolveVaultPath).filter(Boolean)
  const seen = new Set()
  const sources = []
  for (let i = 0; i < srcs.length && sources.length < 4; i += 1) {
    if (seen.has(srcs[i])) continue
    seen.add(srcs[i])
    sources.push(srcs[i])
  }
  return Object.assign({}, baseMatter || {}, {
    closed_at: closedAt,
    closure_note: closureNote,
    reopened_at: reopened === null ? null : reopened.reopened_at,
    records: records.slice(-50),
    sources,
  })
}

// 写通道串行化：单进程内所有覆盖层写操作排队，读-改-写原子进行
let mWriteChain = Promise.resolve()
function mutateMatterActions(fn) {
  const next = mWriteChain.then(async () => {
    const cur = await loadMatterActions()
    const updated = fn(cur)
    await writeFile(PWB_MACTIONS, JSON.stringify(updated, null, 2), 'utf8')
    return updated
  })
  mWriteChain = next.catch(() => {})
  return next
}

// ── 关闭条件检测（2026-09-15 需求）───────────────────────────────────────────
// 背景：派生的自动关闭只在**管线重派生时**发生；两轮之间产出物出现了，事务不会自己关闭。
// 这里把「当下重新求值关闭条件」交给库内 cli-matter-check.mjs（复用适配器观测，不复制 marker 逻辑），
// 匹配到就地走 cli-matter.mjs 关闭（唯一写通道，M7d 校验也在库内）。
async function runMatterCheck(args) {
  const r = await run(NODE, [PWB_MATTER_CHECK_CLI, ...args], 180000)
  const j = parseJsonLoose(r.stdout)
  return j ?? { ok: false, error: String(r.error || r.stderr || 'no output').slice(0, 300) }
}

/**
 * 写操作之后的**重建**（沿用既有做法：跑库内脚本，本层不新造一套）：
 *   ① `build-snapshot.mjs` —— `/state` 读的 snapshot.json（面板数据层 / 事务卡 / 触发卡）；
 *   ② `build-brief.mjs`    —— 决策卡读的 brief.json（游标 / 三组 / 三桶都由它派生）。
 * 两者都是「输入的确定性函数」：只重算，不新增判断、不改任何输入（实测 ~120ms，逐字节可复现）。
 * ⚠️ 为什么必须带上 ②：只重建 snapshot 的话，刚从卡上关掉 / 重定截止 / 忽略归档的那一条
 *    **仍会留在原来的桶里**，看起来像"点了没生效"。清缓存仍由各调用点按既有写法处理。
 */
async function rebuildArtifacts() {
  await run(NODE, [PWB_BUILD], 180000)
  await run(NODE, [PWB_BRIEF_BUILD], 60000)
}

/** 关闭 + 立即重建快照与决策卡产物（面板事务卡读 snapshot、决策卡读 brief） */
async function closeMatterViaCli(id, note) {
  const args = ['close', '--id', id, '--file', PWB_MATTERS, '--overrides', PWB_MATTER_OVR]
  if (typeof note === 'string' && note.trim().length > 0) args.push('--note', note.trim().slice(0, 1000))
  const r = await run(NODE, [PWB_MATTER_CLI, ...args], 60000)
  const j = parseJsonLoose(r.stdout)
  if (j !== null && j.ok === true) await rebuildArtifacts()
  return j ?? { ok: false, error: String(r.error || r.stderr || 'no output').slice(0, 300) }
}

// ── 事务分桶（E 块 tab：待完成 / 已关闭）─────────────────────────────────────

/** 'YYYY-MM-DD' → UTC 日序数（日期粒度，避免时区/夏令时把天算错） */
function dayValue(iso) {
  const s = String(iso || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  return Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)))
}

/**
 * 事务分桶：**待完成 / 已关闭**（2026-09-15 用户更正：去掉「已过期」这一档）。
 *
 * 时间语义：事务上的时间是**发起时间**（该事务被发起/提出的日期），不是截止时间 ——
 * 因此这里不做任何过期判定，也不再下发 `overdue` / `due_state` 字段，
 * 渲染层自然不会有「已过期」标签。
 *
 * 基态 = `_meta/out/matters.json`（只读），关闭/重开来自覆盖层（登记表 + 插件侧旧记录，见 effectiveMatter）。
 */
function buildMatterBuckets(baseMatters, actions) {
  const todo = []
  const closed = []
  for (const m of baseMatters) {
    if (m === null || typeof m !== 'object') continue
    const id = String(m.id || '')
    if (id.length === 0) continue
    const eff = effectiveMatter(m, actions, id)
    // 事务的**发起时间**：该事务被发起/提出的日期（库内 `created_at`；缺失时回落 `due_at`）。
    // 2026-09-15 用户更正：行内显示与排序都用这个时间 —— 早发起的排在前面。
    // （派生事务的 `created_at` 与场次日期同日；只有立项类事务两者会差几天，
    //  如 MT-PC-003 发起 09-14 / 授课 09-20。）
    const initiated = m.created_at ? String(m.created_at).slice(0, 10) : (m.due_at ? String(m.due_at).slice(0, 10) : null)
    const base = {
      id,
      title: String(m.title || ''),
      domain: m.domain ? String(m.domain) : null,
      held_by: m.held_by ? String(m.held_by) : null,
      counterparty: m.counterparty ? String(m.counterparty) : null,
      done_when: m.done_when ? String(m.done_when) : '',
      origin_project: m.origin_project ? String(m.origin_project) : '',
      initiated_at: initiated,
      initiated_from: m.created_at ? 'created_at' : (m.due_at ? 'due_at' : null),
      records: Array.isArray(eff.records) ? eff.records.length : 0,
    }
    if (eff.closed_at) {
      closed.push(Object.assign({}, base, {
        closed_at: String(eff.closed_at),
        closure_note: eff.closure_note ? String(eff.closure_note) : null,
      }))
      continue
    }
    todo.push(base)
  }
  // 排序规则（2026-09-15 用户更正）：
  //   待完成 = **发起时间从远到近**（离现在最久/最早发起的排最前，越晚发起越靠后；无日期置后）；
  //   已关闭 = 关闭时间**从近到远**（最近关闭的在前）。
  const byInitiatedAsc = (a, b) => {
    const x = dayValue(a.initiated_at)
    const y = dayValue(b.initiated_at)
    if (x === null && y === null) return 0
    if (x === null) return 1
    if (y === null) return -1
    return x - y
  }
  todo.sort(byInitiatedAsc)
  closed.sort((a, b) => String(b.closed_at).localeCompare(String(a.closed_at)))
  const LIMIT = 100
  return {
    todo: todo.slice(0, LIMIT),
    closed: closed.slice(0, LIMIT),
    counts: { todo: todo.length, closed: closed.length },
  }
}

/**
 * 专注态**实时**读（运行时块在 `_meta/out/focus-live.json`，写入方是 cli-focus.mjs）。
 *
 * 为什么必须实时读：写入只改 `focus-live.json`，不改 `snapshot.json`；
 * 面板的「结束专注」按钮只在 `focus.active` 为真时渲染，读陈旧的快照会让
 * "已结束的块"永远显示为进行中，点结束必然失败（2026-09-16 用户报的缺陷）。
 *
 * 读也走**同一个模块**（`cli-focus.mjs status`）⇒ 派生逻辑只有一份，不在 host 里复写规则。
 * 取不到就返回 null，由调用方退回快照（不静默编造）。
 */
async function readLiveFocus() {
  try {
    const r = await run(NODE, [PWB_FOCUS_CLI, 'status'], 15000)
    const j = parseJsonLoose(r.stdout)
    return j !== null && j !== undefined && j.ok === true ? j : null
  } catch { return null }
}

/**
 * 数据层状态：**只读驾驶舱产物**，不重新派生。
 *
 * 返回里刻意带上 `dataAsOf` 与 `staleMs` —— 渲染层据此显示"数据有多旧"，
 * 而不是把一份陈旧快照当实时数据展示（V5 审计里那条教训：陈旧数据必须对读者可见）。
 */
async function workbenchState() {
  const snap = await readJson(PWB_SNAPSHOT)
  const liveFocus = await readLiveFocus()
  if (snap === null) {
    return {
      ok: false,
      error: `未找到或无法解析 ${PWB_SNAPSHOT} —— 先运行 node <库内>/build-snapshot.mjs`,
      path: PWB_SNAPSHOT,
    }
  }
  let fileMtimeMs = null
  try { fileMtimeMs = (await stat(PWB_SNAPSHOT)).mtimeMs } catch { /* 保持 null */ }
  const dataAsOf = snap?.meta?.dataAsOf ?? null
  const parsed = dataAsOf === null ? NaN : Date.parse(dataAsOf)
  const staleMs = Number.isFinite(parsed) ? Date.now() - parsed : null
  const metrics = await readJson(PWB_METRICS)
  const activeDomains = await readJson(PWB_AD_DOC)
  // 业务对象层摘要（**只加字段，不动既有字段** ⇒ 老卡片不受影响）
  const objectsDoc = await readJson(PWB_OBJECTS)
  const dispositionDoc = await readJson(PWB_DISPOSITION)
  const crosscheckDoc = await readJson(PWB_CROSSCHECK)
  const domainHealthDoc = await readJson(PWB_DOMAIN_HEALTH)
  const bizObjects = {
    generatedAt: objectsDoc?.generatedAt ?? null,
    objects: Array.isArray(objectsDoc?.objects) ? objectsDoc.objects.length : null,
    inPlay: Array.isArray(objectsDoc?.objects) ? objectsDoc.objects.filter((o) => o.state !== 'settled').length : null,
    crossLayer: Array.isArray(objectsDoc?.objects) ? objectsDoc.objects.filter((o) => o.multi_source?.trajectory === 'both').length : null,
    coverage: objectsDoc?.coverage ?? null,
  }
  // 「资产」卡一期（2026-09-23）：整份透传（≈4KB）——卡面要渲染双口径、分布与二级出处，
  //   再开一次请求不值当；`/assets` 仍保留给"只取资产、不进 /state"的消费方与断言。
  const assetsDoc = await readJson(PWB_ASSETS)
  const assets = assetsDoc === null ? null : {
    available: assetsDoc.available === true,
    error: assetsDoc.error ?? null,
    as_of: assetsDoc.as_of ?? null,
    stale: assetsDoc.stale ?? null,
    stale_threshold_hours: assetsDoc.stale_threshold_hours ?? null,
    curated: assetsDoc.curated ?? null,
    all: assetsDoc.all ?? null,
    by_doc_type: assetsDoc.by_doc_type ?? [],
    by_top_dir: assetsDoc.by_top_dir ?? [],
    by_client: assetsDoc.by_client ?? null,
    by_project: assetsDoc.by_project ?? null,
    top_sessions: assetsDoc.top_sessions ?? null,
    notes: assetsDoc.notes ?? [],
  }
  const dispositionSummary = {
    generatedAt: dispositionDoc?.generatedAt ?? null,
    ...(dispositionDoc?.summary ?? {}),
    active: dispositionDoc?.summary?.active ?? null,
  }
  const crosscheckSummary = {
    generatedAt: crosscheckDoc?.generatedAt ?? null,
    trace: crosscheckDoc?.trace ? {
      strictRate: crosscheckDoc.trace.strictRate, looseRate: crosscheckDoc.trace.looseRate,
      bySide: crosscheckDoc.trace.bySide ?? null,
    } : null,
    multiSource: crosscheckDoc?.multiSource ?? null,
    planVsActual: crosscheckDoc?.planVsActual ? {
      late: crosscheckDoc.planVsActual.late, onTime: crosscheckDoc.planVsActual.onTime,
      avgDeltaDays: crosscheckDoc.planVsActual.avgDeltaDays, openOverdue: crosscheckDoc.planVsActual.openOverdue?.length ?? null,
    } : null,
    promiseVsDelivery: crosscheckDoc?.promiseVsDelivery ? {
      total: crosscheckDoc.promiseVsDelivery.total, executed: crosscheckDoc.promiseVsDelivery.executed,
      notExecuted: crosscheckDoc.promiseVsDelivery.notExecuted ?? [],
    } : null,
    contradictions: crosscheckDoc?.contradictions ?? [],
    attribution: crosscheckDoc?.attribution ?? null,
    duplicates: crosscheckDoc?.duplicates ?? [],
  }
  const domainHealthSummary = {
    generatedAt: domainHealthDoc?.generatedAt ?? null,
    summary: domainHealthDoc?.summary ?? null,
    active: domainHealthDoc?.active ?? null,
    quiet: domainHealthDoc?.quiet ?? [],
    domains: Array.isArray(domainHealthDoc?.domains) ? domainHealthDoc.domains : [],
  }
  const mActions = await loadMatterActions()
  const matterBase = await loadMattersBase()
  const recordCounts = {}
  for (const k of Object.keys(mActions.records)) recordCounts[k] = Array.isArray(mActions.records[k]) ? mActions.records[k].length : 0
  return {
    ok: true,
    path: PWB_SNAPSHOT,
    fileMtimeMs,
    dataAsOf,
    staleMs,
    counts: snap.counts ?? null,
    // ── 专注态：**实时读**，不吃快照 ───────────────────────────────────────
    // 缺陷（2026-09-16 用户报「可以开始专注但无法结束专注」）：
    //   `focus-live.json` 是运行时写的，而 `snapshot.json` 只在重建时更新 ⇒
    //   声明/结束之后 `/state.focus` 仍是旧值：面板一直显示「进行中」，
    //   点「结束专注」时 CLI 已无活动块而回错，用户看起来就是"结束不了"。
    // 修法：读走**同一个模块**（cli-focus.mjs status，只有一份派生逻辑），
    //   读不到时才退回快照（保持兼容：available/live/br9 等字段仍来自快照）。
    focus: liveFocus === null
      ? (snap.focus ?? null)
      : Object.assign({}, snap.focus ?? {}, {
        active: liveFocus.active ?? null,
        last: liveFocus.last ?? null,
        stats: liveFocus.stats ?? (snap.focus ?? {}).stats ?? null,
        blocks_total: liveFocus.blocks_total ?? null,
        // 必穿透白名单（2026-09-17）：逾期未关事务 / 过期未响应触发 / 60 分钟内即将开始的日程。
        // 面板在专注期间据此决定**哪些卡不降权**，并在专注卡上给出计数。
        // 整块原样透传 `cli-focus.mjs status` 的 `whitelist`，host **不重算**（派生只有一份）；
        // 取不到就是 `null` —— 渲染层据此区分「未取到」与「口径为 0」，不许混为一谈。
        whitelist: liveFocus.whitelist ?? null,
        liveRead: true,
        liveReadAt: new Date().toISOString(),
      }),
    core: snap.core ?? null,
    respond: snap.respond ?? null,
    recall: snap.recall ?? null,
    sections: snap.sections ?? null,
    domains: Array.isArray(snap.domains) ? snap.domains.length : null,
    activeDomains: activeDomains ?? { empty: true, effective: [] },
    // ── 业务对象层（2026-09-16 新增；纯附加字段，卡片按需消费）──
    bizObjects,
    // 「资产」卡一期（2026-09-23）：双口径（curated 旧口径 / all 全库）+ 分布 + as_of/stale/error
    assets,
    disposition: dispositionSummary,
    crosscheck: crosscheckSummary,
    domainHealth: domainHealthSummary,
    // 事务覆盖层摘要：渲染层据此标记「已关闭」并调整未关闭计数（不另建派生源）
    matterActions: { path: PWB_MACTIONS, closures: mActions.closures, recordCounts },
    // 事务分桶（卡内两个 tab）：待完成 / 已关闭 —— 由 host 统一分类与排序
    matterBuckets: buildMatterBuckets(matterBase, mActions),
    // 事务变动指纹（id + 状态 + 关闭时刻 + 变更时刻）：用于「事务一变就自动检测可关闭项」
    matterSig: matterBase.map((m) => [m.id, m.status, m.closed_at || '-', m.last_change_at || '-'].join(':')).join('|'),
    // 面板「声明专注」表单的选项：关注域 id/name 列表（取自快照，不是第二套派生）
    domainOptions: Array.isArray(snap.domains)
      ? snap.domains.map((d) => ({ id: String(d.id), name: String(d.name) }))
      : [],
    metrics: metrics === null ? null : {
      summary: metrics.summary ?? null,
      s1Timing: metrics.s1Timing ?? null,
      r8: metrics.r8 ?? null,
      // 缺口三字段走 carryGapFields 显式透传（见文件上方 GAP_FIELDS 的说明）：
      // 只挑字段、不造字段、不判定；其余字段整对象保留（不做白名单裁剪 —— 裁剪会把卡片依赖的字段悄悄丢掉）
      metrics: Array.isArray(metrics.metrics) ? metrics.metrics.map(carryGapFields) : [],
    },
  }
}

/** Parse the first JSON object embedded in output that may carry a banner. */
function parseJsonLoose(text) {
  if (typeof text !== 'string') return null
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try { return JSON.parse(text.slice(a, b + 1)) } catch { return null }
}

// ── 飞书日历（2026-09-15 需求：日程安排同时同步钉钉 dws 与飞书）──────────────
// 走 lark-cli：`lark-cli calendar +agenda --start <d> --end <d> --as user --format json`
// 未授权 / 缺 scope 时**如实报告**（ok:false + 原文错误），绝不伪装成"今天没有日程"。
const LARK_CLI = process.env.DSH_WORKDESKTOP_LARK_CLI || 'lark-cli'
// 钉钉 CLI（待办源头回写用：`dws todo task done --task-id … --status true|false`）
const DWS_CLI = process.env.DSH_WORKDESKTOP_DWS_CLI || 'dws'
// ── 听记（`/snapshot` 的 `minutes` 段）分源常量（2026-09-19 用户规格）──────────
//   · `MINUTES_CAP`：**每源**最多下发多少条 —— 50 是"防御病态数据"的上限，不是展示裁剪。
//     ⚠️ 为什么从 10 提到 50（2026-09-19 实测）：`dws minutes +list-mine` 实际返回 **20** 条，
//       而旧实现 `slice(0,10)` ⇒ 卡片只列 10 行而钉钉侧有 20 条（**徽标与行数口径打架**，
//       与待办卡当初"面板拿到 12 条却显示钉钉 19"是同一类问题）。待办卡已裁定"全部列出 + 卡体滚动"，
//       听记卡沿用同一口径：**行数 == 徽标数字 == payload 计数**。
//   · `FEISHU_MINUTES_PAGE`：`minutes +search` 的 page-size（接口上限 30，取 15 够用且更省）。
const MINUTES_CAP = Number(process.env.DSH_WORKDESKTOP_MINUTES_CAP || 50)
const FEISHU_MINUTES_PAGE = Number(process.env.DSH_WORKDESKTOP_FEISHU_MINUTES_PAGE || 15)
//   · `FEISHU_MINUTES_PROFILE`：飞书妙记必须走**已授予 minutes scope 的那个应用 profile**。
//     ⚠️ 2026-09-19 线上故障根因：采集命令漏带 `--profile` ⇒ 落到默认 profile（旧应用，无
//     `minutes:minutes.search:read`）⇒ CLI 退出码 3、stdout 为空 ⇒ 面板显示
//     「飞书妙记读取失败: lark-cli 无输出或非 JSON」——文案把"缺 profile"伪装成了"没输出"。
const FEISHU_MINUTES_PROFILE = String(process.env.DSH_WORKDESKTOP_FEISHU_MINUTES_PROFILE || 'cli_aa26a37ae638dcee').trim()

// ── 听记 → 事务草稿（2026-09-26 · 第六条「从听记直接建事务」）────────────────────
//   分工（**判定不在 host**，这条是本节的架构约束）：
//     · host 只做**采集**：飞书妙记走 `lark-cli minutes +detail`（**必须**带 FEISHU_MINUTES_PROFILE——
//       默认 profile 是另一个缺 scope 的应用，见上一条注释）；钉钉听记走 `dws minutes +detail`
//       （与听记列表同一条 CLI）。正文取不到就**如实回原因**，绝不编标题或关闭条件。
//     · 草稿一律由库内草稿引擎 `matter-draft.mjs` 生成：host 把采集结果组装成一份入参 JSON，
//       跑 `node matter-draft.mjs --file <入参> --now <iso>`，再把引擎的 JSON **原样透传**。
//       host 在这里**不**判域、不判关闭条件、不挑锚点（那些是判断层与引擎的活；重写一遍就是分叉）。
//   ⚠️ 入参 JSON 与飞书 `--output-dir` 都落在 `_meta/tmp/`（草稿是**输入**不是产物；
//      `_meta/out/` 下每个 .json 都按产物登记，未登记即红 —— REG-1，与 PWB_INTAKE_REQ 同一个坑）。
const PWB_MATTER_DRAFT_CLI = process.env.DSH_WORKDESKTOP_MATTER_DRAFT
  || join(KNOWLEDGE, '_meta', 'workbench', 'matter-draft.mjs')
const PWB_MINUTES_DRAFT_TMP = join(KNOWLEDGE, '_meta', 'tmp', 'minutes-draft')
//   令牌 / 听记 id 的**形态白名单**：它们要拼进 PowerShell 命令行 ⇒ 进命令之前必须先过这一道
//   （既防注入，也防"手滑把整段 URL 当 token 传进去"这种看不懂的失败）。
const MINUTE_TOKEN_RE = /^[A-Za-z0-9_-]{8,80}$/
const DING_MINUTE_ID_RE = /^[A-Za-z0-9_-]{8,120}$/

function ymdLocal(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 时间抽取 —— 按**实测**的三种形态：
 *  ① { datetime: '2026-09-15T20:00:00+08:00', timezone }  ← `+agenda` 实测所用（首版漏了 datetime，
 *     导致真实事件的 start/end 全为空 —— 由真机链路验证抓到）
 *  ② { timestamp: '1789473600' }                         ← 部分接口的秒级时间戳
 *  ③ { date: '2026-09-16' } / 纯字符串                    ← 全天日程
 */
const toIso = (v) => {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') {
    // ⚠️ 两家的键名不同，且都可能带"另一个键为 null"：飞书 `datetime` / 钉钉 `dateTime`；
    //    全天日程用 `date`（此时 datetime/dateTime 为 null）—— 取**第一个非空**者。
    const cands = [v.datetime, v.dateTime, v.timestamp, v.date]
    v = cands.find((x) => x !== null && x !== undefined && x !== '')
  }
  if (v === null || v === undefined || v === '') return ''
  const n = Number(v)
  if (Number.isFinite(n) && n > 1e9) return new Date(n * 1000).toISOString()
  const s = String(v)
  if (/\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s)
    return Number.isNaN(d.getTime()) ? '' : d.toISOString()
  }
  return ''
}

/** 地点：API 里可能是字符串，也可能是对象 {name} */
const toLoc = (v) => {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return String(v.name || v.display_name || '')
  return String(v)
}

/**
 * 解析 lark-cli calendar 的 JSON 输出（**按实测量身**）。
 *
 * ⚠️ 实测两种形态（2026-09-15，授权后真机验证）：
 *   `+agenda`        → { ok:true, identity, data: [ …事件… ] }        ← data 是**数组**
 *   `+search-event`  → { ok:true, data: { calendar_id, items: [...] } } ← data 是对象、事件在 items
 * 原实现只认 `data.items` ⇒ 遇到 agenda 的数组形态会**静默丢光所有飞书日程**（最坏的一类 bug：
 * 看起来"今天没有飞书日程"）。现同时支持两种形态，并保留 items/events 直挂的兼容。
 */
function parseLarkAgenda(j) {
  if (j === null || typeof j !== 'object') return { ok: false, authorized: null, error: '输出不是 JSON', items: [] }
  if (j.ok === false) {
    const e = j.error || {}
    return {
      ok: false,
      authorized: e.type === 'authorization' ? false : null,
      error: String(e.message || 'lark-cli 返回 ok:false'),
      hint: String(e.hint || ''),
      items: [],
    }
  }
  const d = j.data
  const arr = Array.isArray(d) ? d
    : (d && (d.items || d.events || d.calendar_events)) || j.items || j.events || []
  const list = Array.isArray(arr) ? arr : []
  const items = list.map((it, i) => ({
    id: String(it.event_id || it.eventId || `feishu-${i}`),
    title: String(it.summary || it.title || '(无标题)'),
    start: toIso(it.start_time || it.start),
    end: toIso(it.end_time || it.end),
    location: toLoc(it.location),
    // 实测字段（+agenda）：app_link 可在浏览器直接打开该日程；vchat.meeting_url 是视频会议链接
    url: String(it.app_link || ''),
    meeting_url: String((it.vchat && it.vchat.meeting_url) || ''),
    organizer: String((it.event_organizer && it.event_organizer.display_name) || ''),
    allDay: Boolean(it.is_all_day || (it.start_time && it.start_time.date)),
    source: 'feishu',
  }))
  return { ok: true, authorized: true, error: null, items, raw_count: list.length }
}

/** 采集飞书日历（今天 + 明天）：任何失败都如实返回，不抛 */
async function collectFeishuCalendar() {
  const today = new Date()
  const from = ymdLocal(today)
  const to = ymdLocal(new Date(today.getTime() + 2 * 86400000))
  // 命令行原样一行（直连 node 执行；找不到入口才回退 PowerShell shim，见 larkRun）
  const cmd = `calendar +agenda --start ${from} --end ${to} --as user --format json`
  const r = await larkRun(cmd, 60000)
  const parsed = parseLarkAgenda(parseJsonLoose(r.out))
  return { ...parsed, range: { from, to } }
}

/**
 * 解析飞书任务返回（2026-09-16 按**真实 payload** 校准，两份原文均已固化）：
 *
 * ① `+get-related-tasks`（**当前主源 —— 用户要求"基于个人的所有任务"**）
 *    真实结构 `{ok:true, identity:'user', data:{has_more, items:[…], page_token}}`，任务项实测：
 *    `{guid, summary, url(applink 带 guid), created_at:'YYYY-MM-DD HH:mm:ss'(本地时间,空格分隔),
 *      creator:{id,type}, members:[{id, role:'assignee'|'follower', type}], status:'todo',
 *      description:'', tasklists:[], mode, source, subtask_count}`
 * ② `+get-my-tasks`（兼容保留）：`{completed:boolean, created_at:'ISO+08:00', guid, summary, url}`
 *
 * ⚠️ **实测打脸的三处错假设**（首版凭想象写的）：
 *    · 完成标志：related 是 **`status:'todo'`**（非 'todo' 即已完成）；my-tasks 是 **`completed` 布尔**
 *      —— 只认 `completed_at`/`complete_status` 会把已完成任务显示成未完成；
 *    · `members[].role` 是**字符串** `'assignee'|'follower'`（不是数字 2）；
 *    · `created_at` 为**空格分隔的本地时间**字符串（不是 ISO）—— 按 ISO 解析会得到 NaN。
 * ⚠️ **第二次实测打脸（2026-09-16 · 用真实新建任务验证）**：**列表接口根本不返回 `due`**。
 *    实测对照：同一次 `+get-related-tasks` 返回的两条任务，一条**明确设了截止（--due 2026-09-18）**、
 *    一条没有，而两者的键集合**完全相同**（都没有 due）：
 *      created_at, creator, description, guid, members, mode, source, status, subtask_count, summary, tasklists, url
 *    ⇒ 截止时间只能逐条 `task tasks get`（详情）取 —— 见 parseLarkTaskDetail / enrichFeishuTasks。
 *    详情里的形状：`due:{is_all_day, timestamp:'<毫秒字符串>'}`
 *    （实测：`--due 2026-09-18` 全天 ⇒ `{is_all_day:true, timestamp:'1789689600000'}` = 2026-09-18T00:00:00Z）。
 */
function parseFeishuTime(v) {
  const s = String(v || '').trim()
  if (s.length === 0) return null
  // "2026-09-16 12:09:19"（本地时间，无时区）→ 补 T 后按本地解析
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)) return new Date(s.replace(' ', 'T')).toISOString()
  return toIso(v)
}

function parseLarkTasks(j, selfOpenId = null) {
  if (j === null) return { ok: false, authorized: null, error: 'lark-cli 无输出或非 JSON', items: [] }
  if (j.ok !== true) {
    const err = (j && j.error) || {}
    const authorized = err.type === 'authorization' ? false : null
    return {
      ok: false,
      authorized,
      error: String(err.message || err.subtype || '未知错误'),
      missing_scopes: Array.isArray(err.missing_scopes) ? err.missing_scopes : null,
      items: [],
    }
  }
  const list = Array.isArray(j.data) ? j.data : ((j.data && j.data.items) || j.items || [])
  const nameOf = (id) => {
    const s = String(id || '')
    if (s.length === 0) return ''
    if (selfOpenId !== null && s === selfOpenId) return '我'
    return s.length > 10 ? s.slice(0, 8) + '…' : s
  }
  const items = (Array.isArray(list) ? list : []).map((t) => {
    const due = t.due || (t.due_time !== undefined ? { timestamp: t.due_time } : (t.due_date !== undefined ? { date: t.due_date } : null))
    // ★ 实测：related 用 status（'todo' 之外视为已完成）；my-tasks 用 completed 布尔；两者都兼容
    const done = t.completed === true
      || (t.status !== undefined && String(t.status) !== 'todo')
      || t.completed_at != null || t.complete_status === 2 || t.is_completed === true
    const members = Array.isArray(t.members) ? t.members : []
    const owners = members
      // ★ 实测 role 是字符串 'assignee'（兼容旧假设的数字 2）
      .filter((m) => String(m.role) === 'assignee' || Number(m.role) === 2)
      .map((m) => nameOf(m.id))
      .filter(Boolean)
    const followers = members.filter((m) => String(m.role) === 'follower').map((m) => nameOf(m.id)).filter(Boolean)
    const listName = Array.isArray(t.tasklists) && t.tasklists[0] ? String(t.tasklists[0].summary || '') : ''
    return {
      id: String(t.guid || t.id || t.task_guid || ''),
      title: String(t.summary || t.title || '(无标题)'),
      due: parseFeishuTime(due),
      created: parseFeishuTime(t.created_at),
      done,
      status: String(t.status || (done ? 'done' : 'todo')),
      url: String(t.url || t.app_link || ''),
      owners: owners.slice(0, 4),
      followers: followers.slice(0, 4),
      creator: t.creator ? nameOf(t.creator.id) : '',
      listName,
      description: typeof t.description === 'string' ? t.description.slice(0, 500) : '',
      source: 'feishu',
    }
  })
  items.sort((a, b) => String(a.due || '9999').localeCompare(String(b.due || '9999')))
  return { ok: true, authorized: true, error: null, items }
}

/** 当前登录用户的 open_id（用于把 members 里的自己显示成「我」；失败返回 null，不阻塞） */
let larkSelfId = null
async function larkSelfOpenId() {
  if (larkSelfId !== null) return larkSelfId
  const r = await larkRun('auth status --json', 20000)
  const j = parseJsonLoose(r.out)
  larkSelfId = j?.identities?.user?.openId ?? null
  return larkSelfId
}

/**
 * 任务**详情**返回（`task tasks get`）→ 截止时间与补充字段。纯函数（可吃 fixture、可单测）。
 *
 * 实测形状：`{ok:true, data:{task:{…, due:{is_all_day:true, timestamp:'1789689600000'}, created_at:'1789556537486', description:'…'}}}`
 * ⚠️ 全天任务的 timestamp 是 **UTC 零点**（`--due 2026-09-18` ⇒ 2026-09-18T00:00:00Z）
 *    ⇒ 全天一律输出**日期字符串**（`YYYY-MM-DD`），不输出带时刻的 ISO ——
 *      否则在 +08 会被渲染成 "08:00" 这种**看起来精确、其实是凭空造的**时间（本项目已经踩过一次同类坑）。
 */
function parseLarkTaskDetail(j) {
  const t = j && j.ok === true && j.data && j.data.task ? j.data.task : null
  if (t === null) return { ok: false, due: null, description: null, created: null }
  let due = null
  const d = t.due && typeof t.due === 'object' ? t.due : null
  if (d !== null && d.timestamp !== undefined && d.timestamp !== null) {
    const ms = Number(d.timestamp)
    if (Number.isFinite(ms) && ms > 0) {
      due = d.is_all_day === true
        ? new Date(ms).toISOString().slice(0, 10)
        : new Date(ms).toISOString()
    }
  }
  // 详情里的 created_at 是**毫秒纪元字符串**（列表里则是"空格分隔的本地时间"）—— 两种口径都要认
  const cms = Number(t.created_at)
  return {
    ok: true,
    due,
    description: typeof t.description === 'string' && t.description.length > 0 ? t.description.slice(0, 500) : null,
    created: Number.isFinite(cms) && cms > 1000000000000 ? new Date(cms).toISOString() : null,
  }
}

/** 单条任务详情（失败返回 null —— 补截止时间是**锦上添花**，绝不能让整张卡变红） */
async function feishuTaskDetail(guid) {
  if (!guid) return null
  const cmd = `task tasks get --task-guid ${guid} --as user --format json`
  const r = await larkRun(cmd, 45000)
  const d = parseLarkTaskDetail(parseJsonLoose(r.out))
  return d.ok === true ? d : null
}

/** 详情补齐的条数上限（**规模化保护**：列表接口不返回 due ⇒ 只能逐条取，必须封顶） */
const FEISHU_DETAIL_CAP = Number(process.env.DSH_WORKDESKTOP_FEISHU_DETAIL_CAP || 6)

/**
 * 给列表条目补 `due`（及缺失的 description / created）。
 * 只补**前 CAP 条缺 due 的**任务，**并发**执行；单条失败即跳过（返回原数据）。
 */
async function enrichFeishuTasks(items) {
  const targets = items.filter((x) => x.id && !x.due).slice(0, FEISHU_DETAIL_CAP)
  if (targets.length === 0) return items
  const details = await Promise.all(targets.map((x) => feishuTaskDetail(x.id).catch(() => null)))
  targets.forEach((x, i) => {
    const d = details[i]
    if (d === null) return
    if (d.due !== null) x.due = d.due
    if (d.description !== null && !x.description) x.description = d.description
    if (d.created !== null) x.created = d.created
  })
  items.sort((a, b) => String(a.due || '9999').localeCompare(String(b.due || '9999')))
  return items
}

/**
 * 个人待办（待办卡「个人」源）—— 2026-09-16 用户口径：
 *   「待办的个人匹配的是**手动创建的**或者**在 dsh 会话中创建的**」。
 * ⇒ 同一个真相源：`Other/Todo/` 下的文件。
 *   · 手动创建 = 直接往目录放文件（**没有 frontmatter 也算数**：标题取首个非空行/文件名）；
 *   · DSH 会话创建 = 库内 `cli-todo.mjs add`（面板按钮与 agent 工具 `workbench_todo` 同一通道）。
 *
 * ⚠️ 与"已完成 = 已关闭"同口径：`done: true` 的**不进待办列表**（仅计数留存 personalClosed）。
 * 纯函数（文本 + 文件名 → 结构），可吃 fixture 单测。
 */
function parsePersonalTodoText(text, fileName) {
  const s = String(text || '')
  const fm = {}
  const m = s.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/)
      if (!kv) continue
      let v = kv[2].trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      fm[kv[1]] = v
    }
  }
  const body = m ? s.slice(m[0].length) : s
  const firstLine = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] || ''
  const name = String(fileName || '')
  return {
    id: fm.id || null,
    title: (fm.title || firstLine.replace(/^#+\s*/, '').slice(0, 120) || name.replace(/\.[a-z0-9]+$/i, '')).trim(),
    due: fm.due_at || fm.due || null,
    done: String(fm.done || '').toLowerCase() === 'true',
    created: fm.created_at || null,
    closed_at: fm.closed_at || null,
    closure_note: fm.closure_note || null,
    // 手动放置的文件没有 source 字段 ⇒ 如实标 `manual`（不猜成会话内创建）
    source: fm.source || 'manual',
    origin: fm.origin || null,
    name,
  }
}

/**
 * 钉钉待办的**四类归属判定**（纯函数 · 可单测）。
 *
 * 用户口径（2026-09-17）：「钉钉客户端的待办中，稍后处理 / 别人安排给我的 / 我安排给别人的 /
 *   个人创建属于自己的待办，都需要添加到这里」。
 * 实现依据（实测）：`+get-my-tasks` 的投影**不带角色字段**（只有 dueTime/finalStatusStage/priority/
 *   subject/taskId）⇒ 唯一的办法是**按角色分别读**，再本地求交/并：
 *     · creator ∩ executor        → `mine`（个人创建给自己）
 *     · executor 且非 creator      → `assigned-by-others`（别人安排给我的）
 *     · creator 且非 executor      → `assigned-to-others`（我安排给别人的）
 *     · participant（收尾兜底）     → `participating`（我参与的）
 * ⚠️ 「稍后处理」是**钉钉客户端侧**的分组/延后状态，`dws`/开放接口**没有任何对应字段或过滤参数**
 *   （已全量检索 946 个工具：snooze/defer/postpone/稍后 均无 TODO 相关能力）⇒ 无法单独读取；
 *   但"稍后处理"的条目**仍是未完成**，本函数按归属归入上面四类之一、照常列出。
 *
 * @param {{executor?:any[], creator?:any[], participant?:any[]}} byRole 三个角色的原始条目数组
 * @returns {{items:any[], byCategory:Record<string,number>}} 去重后的条目（带 category）与分类计数
 */
function classifyTodoItems(byRole) {
  const map = new Map()
  const add = (list, role) => {
    for (const t of (Array.isArray(list) ? list : [])) {
      const id = String(t.taskId || t.subject || '')
      if (id.length === 0) continue
      const e = map.get(id) || { item: t, roles: {} }
      e.roles[role] = true
      map.set(id, e)
    }
  }
  add(byRole.executor, 'executor')
  add(byRole.creator, 'creator')
  add(byRole.participant, 'participant')
  const items = []
  const byCategory = { mine: 0, 'assigned-by-others': 0, 'assigned-to-others': 0, participating: 0 }
  for (const [id, e] of map) {
    const r = e.roles
    const category = (r.creator === true && r.executor === true) ? 'mine'
      : (r.executor === true ? 'assigned-by-others'
        : (r.creator === true ? 'assigned-to-others' : 'participating'))
    items.push({ ...e.item, id, category })
    byCategory[category] += 1
  }
  return { items, byCategory }
}

/**
 * 待办**回写策略**（纯函数 · 用户 2026-09-17 精确裁定）：
 *   「我自己或别人安排给我的，可以由我关闭/重开之后反馈到源头的状态；
 *     **我安排给别人的，我只读，不反馈**。」
 *
 * 判据只有一条：**这条待办是不是"我来执行"**。
 *   · 钉钉：`category = mine`（creator∩executor）或 `assigned-by-others`（仅 executor）⇒ 可回写；
 *          `assigned-to-others`（仅 creator，别人执行）与 `participating`（我仅参与）⇒ 只读。
 *   · 飞书：`owners` 含「我」（我是 assignee）⇒ 可回写；只是我创建/关注的 ⇒ 只读。
 *   · 个人：库内 `Other/Todo/` 的文件，天然是我的 ⇒ 永远可回写。
 * @returns {{writable:boolean, reason:string}}
 */
function todoWritePolicy(item) {
  const source = String((item && item.source) || '')
  if (source === 'personal') return { writable: true, reason: '个人待办（库内文件，天然由我执行）' }
  if (source === 'feishu') {
    const owners = Array.isArray(item && item.owners) ? item.owners : []
    const mine = owners.some((o) => String(o) === '我')
    return mine
      ? { writable: true, reason: '飞书任务：我是负责人' }
      : { writable: false, reason: '飞书任务：我不是负责人（只读，不回写源头）' }
  }
  const cat = String((item && item.category) || '')
  if (cat === 'mine') return { writable: true, reason: '个人创建给自己（我是执行者）' }
  if (cat === 'assigned-by-others') return { writable: true, reason: '别人安排给我的（我是执行者）' }
  if (cat === 'assigned-to-others') return { writable: false, reason: '我安排给别人的（由对方执行 ⇒ 只读，不回写源头）' }
  if (cat === 'participating') return { writable: false, reason: '我仅参与（非执行者 ⇒ 只读，不回写源头）' }
  return { writable: false, reason: '无法判定该条是否由我执行（category 缺失）⇒ 为安全起见不回写' }
}

/**
 * 台账标题的取值（三层兜底：客户端 → 服务端最近一次采集 → 个人文件）。
 *
 * 为什么需要：台账里的 `title` 同时是「最近关闭 · 可重新打开」那一行的**显示名**。
 *   二级详情那条路径原先**不带标题** ⇒ 台账 title 为空 ⇒ 用户看到的是 `↺ 57405640551`（一串 taskId）。
 *   实测（2026-09-17）：用户本人连关 5 条真待办，台账里 5 条 title 全空 ⇒ 面板只能显示 id。
 *   ⇒ 服务端在写台账时补上标题：**优先用调用方给的**（最准，等于用户看到的那个），
 *     其次用**服务端最近一次采集**里的（钉钉/飞书），最后从**被改的个人文件**里取。
 *
 * @param {string} sentTitle 客户端传来的标题
 * @param {object|null} found 服务端采集里命中的条目（钉钉/飞书）
 * @param {string} personalTitle 个人文件里解析出的标题
 * @returns {string} ≤200 字（与台账字段长度一致）
 */
function ledgerTitle(sentTitle, found, personalTitle) {
  const pick = (v) => String(v === null || v === undefined ? '' : v).trim()
  const s = pick(sentTitle)
  if (s.length > 0) return s.slice(0, 200)
  const f = pick(found && (found.title || found.subject))
  if (f.length > 0) return f.slice(0, 200)
  return pick(personalTitle).slice(0, 200)
}

/**
 * ── 「最近关闭 · 可重新打开」的挑选规则（2026-09-17 修 **时序缺陷**）──────────────────
 *
 * 面板不展示已完成项 ⇒ "重新打开"必须先知道"刚才关了哪条、源头 id 是什么"，数据源是回写台账。
 *
 * 旧实现（有缺陷）：把**所有成功 reopen** 的 `source|id` 收成一个"取消集合"，再用它去全量过滤 done。
 *   ⇒ **无时序**：11:51 的一次 reopen 会把 20:58 新产生的 done 也一并取消掉。
 *   实测踩到（用户真实操作）：用户在面板关了一条**飞书**待办（20:58），却因为该条 **9 小时前**
 *   被测试 reopen 过，而**不在「最近关闭」里** —— 关得掉、找不回。
 *
 * 新规则（本函数）：**每个 `source|idOrPath` 只看它在时间上的"最后一次"动作** ——
 *   最后一次是 done ⇒ 进「最近关闭」；最后一次是 reopen ⇒ 不进。
 *   再按时间升序取**最后 5 条**并倒序（最新在前）。失败记录（`ok !== true`）一律不参与。
 *
 * @param {Array} actions 台账 `actions`（按追加顺序 = 时间顺序）
 * @returns {Array} 供 `todos.recentClosed` 下发的条目（最多 5 条，最新在前）
 */
function pickRecentClosed(actions) {
  const arr = Array.isArray(actions) ? actions : []
  const lastByKey = new Map()
  for (const a of arr) {
    if (!a || a.ok !== true) continue
    const act = String(a.action || '')
    if (act !== 'done' && act !== 'reopen') continue
    lastByKey.set(`${a.source}|${a.id || a.path}`, a)   // 后来者覆盖先前 ⇒ 每键只留最后一次
  }
  return [...lastByKey.values()]
    .filter((a) => String(a.action) === 'done')
    .sort((x, y) => String(x.at || '').localeCompare(String(y.at || '')))
    .slice(-5)
    .reverse()
}

/** 扫 `Other/Todo/`（不设条数上限：面板已可滚动；文件量级远小于此） */
async function collectPersonalTodos() {
  const items = []
  let names = []
  try { names = await readdir(TODO_DIR) } catch { return { ok: true, dir: TODO_DIR, items: [], closed: 0 } }
  for (const name of names) {
    if (!/\.(md|markdown|txt)$/i.test(name)) continue
    if (name.startsWith('.')) continue
    const full = join(TODO_DIR, name)
    try {
      const text = await readFile(full, 'utf8')
      const t = parsePersonalTodoText(text, name)
      items.push({ ...t, path: full })
    } catch { /* 读不了就跳过（不让一个坏文件拖垮整卡） */ }
  }
  const open = items.filter((t) => t.done !== true)
  open.sort((a, b) => {
    const ak = a.due ? Date.parse(String(a.due).length === 10 ? String(a.due) : a.due) : Number.MAX_SAFE_INTEGER
    const bk = b.due ? Date.parse(String(b.due).length === 10 ? String(b.due) : b.due) : Number.MAX_SAFE_INTEGER
    return (Number.isFinite(ak) ? ak : Number.MAX_SAFE_INTEGER) - (Number.isFinite(bk) ? bk : Number.MAX_SAFE_INTEGER)
  })
  return { ok: true, dir: TODO_DIR, items: open, closed: items.length - open.length, total: items.length }
}

/**
 * 采集飞书任务：**个人视角的全部相关任务**（用户 2026-09-16 明确要求"基于个人的所有任务，不是组织层面"）。
 * 用 `+get-related-tasks`（含：我负责 / 我创建 / 我关注 的任务），而非只取"分配给我"。
 * 列表不含 due ⇒ 再按上限并发补详情（见 enrichFeishuTasks）。失败如实返回，不抛。
 */
async function collectFeishuTasks() {
  const selfId = await larkSelfOpenId()
  const cmd = 'task +get-related-tasks --include-complete=false --page-limit 5 --as user --format json'
  const r = await larkRun(cmd, 60000)
  const parsed = parseLarkTasks(parseJsonLoose(r.out), selfId)
  if (parsed.ok === true && parsed.items.length > 0) {
    try { await enrichFeishuTasks(parsed.items) } catch { /* 补齐失败不降级主数据 */ }
  }
  return {
    ...parsed,
    scopeNote: '个人视角（与我相关：负责/创建/关注）· 仅未完成',
    detailNote: `截止时间由详情接口逐条补齐（列表接口实测不返回 due），上限 ${FEISHU_DETAIL_CAP} 条`,
  }
}

// ══ 飞书妙记（听记第二源 · 2026-09-19 用户规格）══════════════════════════════════
/**
 * 为什么在这里**新增采集**：
 *   `/snapshot` 的 `minutes` 此前**只有钉钉一路**（`dws minutes +list-mine`，见 SCRIPT 与
 *   `collect()` 末段的解析）。用户 2026-09-19 的规格要求「列表同时列钉钉与飞书的听记/妙记」
 *   ⇒ 飞书侧必须有一条**真实**采集通路，否则卡上只能说"钉钉 N"，第二条源就是假的。
 *
 * 通路选型：`lark-cli minutes +search`（`POST /open-apis/minutes/v1/minutes/search`）——
 *   与既有飞书日历/任务**同一条 CLI**（`LARK_CLI`），不引新依赖、不复用浏览器会话。
 *   · 该接口**只支持 user 身份**（`--as user`），scope 要求 `minutes:minutes.search:read`；
 *   · 「我的妙记」按 lark-minutes skill 的口径 = `--owner-ids me` ∪ `--participant-ids me`
 *     （**两次**查询按 token 去重合并）—— 只跑一次会漏掉"我参与但不是我的"。
 *
 * 诚实纪律（本项目的硬规矩，与飞书日历/任务同款）：
 *   **缺授权就必须把缺哪个 scope 原样带出**，绝不静默成空列表、绝不假装有数据。
 *   实测（2026-09-19 · 本机 lark-cli 1.0.84 · `lark-cli auth status --json`）：
 *   当前 user 身份的 scope 串里**没有** `minutes:minutes.search:read`
 *   ⇒ 每次都会走 `authorized:false` 分支，面板据此显示「飞书 未授权（缺 …）」，**不是 0 条**。
 *   用户授权后**无需改代码**：同一段采集立刻返回真实列表。
 *
 * ⚠️ 成功分支的**字段形状尚未实测**（当前拿不到数据 ⇒ 无样本）⇒ 解析器按声明性字段名
 *   **宽容取值**，并在返回值里带 `shape:'unverified'` 如实标注；授权后第一次跑需按真实
 *   payload 校准（这是一条明写的待办，不是可以假装已验的地方）。
 */
function parseLarkMinutes(j) {
  if (j === null) return { ok: false, authorized: null, error: 'lark-cli 无输出或非 JSON', missing_scopes: null, items: [], shape: null }
  if (j.ok !== true) {
    const err = (j && j.error) || {}
    return {
      ok: false,
      authorized: err.type === 'authorization' ? false : null,
      error: String(err.message || err.subtype || '未知错误'),
      missing_scopes: Array.isArray(err.missing_scopes) ? err.missing_scopes : null,
      items: [],
      shape: null,
    }
  }
  const d = (j.data !== undefined && j.data !== null) ? j.data : j
  const list = Array.isArray(d) ? d
    : (Array.isArray(d.items) ? d.items : (Array.isArray(d.minutes) ? d.minutes : []))
  // ⚠️ 形状**已实测**（2026-09-19 · 应用 cli_aa26a37ae638dcee · user 身份 · 实得 1 条）：
  //   item = { token, display_info: "<标题>\n<b>关键词:</b> …\n所有者: … 开始时间: … 时长: …",
  //            meta_data: { app_link, description } }
  //   旧版按 m.title / m.app_link 宽容取 ⇒ 真实 payload 下 title 与 url 全落空、被 filter 掉，
  //   表现为"授权了却 0 条"——这正是本轮修掉的静默失效。
  const firstLine = (s) => String(s || '').split(/\r?\n/)[0].trim()
  const pickStart = (s) => {
    const m = String(s || '').match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})/)
    if (m === null) return null
    const p = (x) => String(x).padStart(2, '0')
    return `${m[1]}-${p(m[2])}-${p(m[3])}T${p(m[4])}:${m[5]}:${m[6]}`
  }
  const pickOwner = (s) => {
    const m = String(s || '').match(/所有者[:：]\s*([^\s<]+)/)
    return m === null ? null : m[1]
  }
  // 反向护栏：**接口给了条目、但没有一条带可识别字段** ⇒ 说明字段形状变了，必须显式报错。
  // ⚠️ 判据不能看"解析后是否为空"——标题有 `(未记标题)` 兜底，空条目也会被算成解析成功，
  //    那样护栏永远不触发（首版就踩了这个坑，反测没红）。
  const recognizable = (m) => {
    if (m === null || typeof m !== 'object') return false
    return Boolean(m.token || m.minute_token || m.display_info || m.meta_data)
  }
  if (list.length > 0 && list.every((m) => !recognizable(m))) {
    return {
      ok: false,
      authorized: true,
      error: `飞书妙记字段形状与预期不符：接口返回 ${list.length} 条但没有一条含 token/display_info/meta_data（首条字段：${Object.keys(list[0] || {}).join(',')}）`,
      missing_scopes: null,
      items: [],
      shape: 'minutes-search-v1-mismatch',
      has_more: d.has_more === true,
      page_token: String(d.page_token || ''),
    }
  }
  const items = list.filter(recognizable).map((m) => {
    const meta = (m !== null && typeof m === 'object' && m.meta_data !== null && typeof m.meta_data === 'object') ? m.meta_data : {}
    const info = String((m || {}).display_info || '')
    const desc = String(meta.description || info)
    return {
      // token 是后续 +detail 的钥匙，必须留下
      token: String((m || {}).token || (m || {}).minute_token || ''),
      title: firstLine(info) || String((m || {}).title || (m || {}).topic || '') || '(未记标题)',
      start: pickStart(desc),
      start_text: (desc.match(/开始时间[:：]\s*([^\n]+)/) || [null, null])[1],
      owner: pickOwner(desc),
      url: String(meta.app_link || (m || {}).url || (m || {}).minute_url || ''),
      source: 'feishu',
    }
  }).filter((m) => m.title.length > 0 || m.url.length > 0)
  return {
    ok: true,
    authorized: true,
    error: null,
    missing_scopes: null,
    items,
    shape: 'minutes-search-v1',
    has_more: d.has_more === true,
    page_token: String(d.page_token || ''),
  }
}

/** 采集飞书妙记：我拥有 ∪ 我参与（两次查询合并去重）。任何失败都如实返回，不抛。 */
async function collectFeishuMinutes() {
  // ⚠️ 必须带 `--profile`（见 FEISHU_MINUTES_PROFILE 注释）；并**显式采集 exit code 与 CLI 解析路径**，
  //    否则失败时只剩一句"无输出或非 JSON"，无法诊断（2026-09-19 线上故障的教训）。
  const prof = FEISHU_MINUTES_PROFILE.length > 0 ? ` --profile ${FEISHU_MINUTES_PROFILE}` : ''
  // 两次查询**互相独立** ⇒ 并发发出（2026-10-03）；两条命令行照命令行原样写，`${prof}` 就在里面
  //   —— 缺 profile 会把"环境错"伪装成"没数据"，这条由 FM-11 守着，写法不许改成参数数组。
  const ownerCmd = `minutes +search --owner-ids me --page-size ${FEISHU_MINUTES_PAGE}${prof} --as user --format json`
  const partCmd = `minutes +search --participant-ids me --page-size ${FEISHU_MINUTES_PAGE}${prof} --as user --format json`
  let env
  if (larkEntry() !== '') {
    const [ro, rp] = await Promise.all([larkRun(ownerCmd, 90000), larkRun(partCmd, 90000)])
    env = { cliPath: ro.cliPath, owner: ro.out, ownerExit: ro.exit, participant: rp.out, participantExit: rp.exit }
  } else {
    // 回退：老路（PowerShell shim）。这条路同时是 FM-13 盯着的"失败可诊断"形态
    //   （cliPath + 两次各自的 exit code），换机器/换 npm 布局时靠它照样能取数。
    const script = "$ErrorActionPreference='SilentlyContinue'; try { [Console]::OutputEncoding=[Text.Encoding]::UTF8 } catch {}; "
      + '$o = [ordered]@{}; '
      + `$o.cliPath = [string]((Get-Command ${LARK_CLI} -ErrorAction SilentlyContinue | Select-Object -First 1).Source); `
      + `$o.owner = (& ${LARK_CLI} ${ownerCmd} 2>&1 | Out-String); $o.ownerExit = $LASTEXITCODE; `
      + `$o.participant = (& ${LARK_CLI} ${partCmd} 2>&1 | Out-String); $o.participantExit = $LASTEXITCODE; `
      + '$o | ConvertTo-Json -Depth 4 -Compress'
    const r = await ps(['-NoProfile', '-NonInteractive', '-Command', script], 90000)
    env = parseJsonLoose(r.stdout)
    if (env === null) {
      // 外层 pwsh 的输出都解析不了 ⇒ 必须带上"命令解析情况 + 退出码 + 输出片段"，否则不可诊断
      return {
        ok: false, authorized: null,
        error: `飞书妙记读取失败：外层输出无法解析（cli=${LARK_CLI} profile=${FEISHU_MINUTES_PROFILE || '(默认)'} `
          + `ok=${r === null || r === undefined ? '?' : r.ok} `
          + `stdout=${JSON.stringify(String((r && r.stdout) || '').slice(0, 160))} `
          + `stderr=${JSON.stringify(String((r && r.stderr) || '').slice(0, 160))}）`,
        missing_scopes: null, items: [], shape: null,
        scopeNote: '我的妙记（我拥有 ∪ 我参与）',
      }
    }
  }
  const a = parseLarkMinutes(parseJsonLoose(env.owner))
  const b = parseLarkMinutes(parseJsonLoose(env.participant))
  const okA = a.ok === true
  const okB = b.ok === true
  if (!okA && !okB) {
    // 两次都失败 ⇒ 取**带 missing_scopes** 的那次（信息量最大：能告诉用户缺哪个 scope）
    const e = a.missing_scopes !== null ? a : (b.missing_scopes !== null ? b : a)
    // 若两次都只是"没输出"（拿不到 scope 信息）⇒ 补上 exit code / CLI 解析路径 / 输出片段，
    // 让"缺 profile"或"CLI 不在 PATH"这类环境问题当场可见（2026-09-19 故障的教训）。
    const generic = e.error === 'lark-cli 无输出或非 JSON'
    const error = generic
      ? `飞书妙记读取失败：CLI 无输出（cli=${LARK_CLI} → ${env.cliPath || '未解析到路径'} profile=${FEISHU_MINUTES_PROFILE || '(默认)'} `
        + `owner exit=${env.ownerExit} participant exit=${env.participantExit} `
        + `owner 输出片段=${JSON.stringify(String(env.owner || '').slice(0, 160))}）`
      : e.error
    return {
      ok: false, authorized: e.authorized, error,
      missing_scopes: e.missing_scopes, items: [], shape: null, tried: 2,
      scopeNote: '我的妙记（我拥有 ∪ 我参与）',
    }
  }
  const seen = new Set()
  const merged = []
  for (const it of [...(okA ? a.items : []), ...(okB ? b.items : [])]) {
    const k = it.token.length > 0 ? it.token : (it.url + '|' + it.title)
    if (seen.has(k)) continue
    seen.add(k)
    merged.push(it)
  }
  // 最新在前（start 是毫秒；取不到时间的排最后，不伪造成 0 时刻）
  merged.sort((x, y) => (num(y.start) || 0) - (num(x.start) || 0))
  return {
    ok: true, authorized: true, error: null, missing_scopes: null,
    items: merged.slice(0, MINUTES_CAP),
    shape: (okA && okB) ? a.shape : 'partial',
    scopeNote: '我的妙记（我拥有 ∪ 我参与，按 token 去重）',
    raw_count: merged.length,
  }
}

/** 钉钉听记 → 面板/契约用的条目形状（`title/start/url` 三个旧字段**原样保留**给旧消费者）。 */
function dingMinutesOf(raw) {
  return (Array.isArray(raw) ? raw : []).slice(0, MINUTES_CAP).map((m) => ({
    title: String((m && m.title) || ''),
    start: num(m && m.startTime),
    url: String((m && m.url) || ''),
    source: 'dingtalk',
  }))
}

/**
 * 听记 id 归一（**纯函数**）：面板只给 `source` + `id|token`（可选 `url` 兜底），其余由这里定。
 *
 * ⚠️ 钉钉这一路必须能从 `url` 兜底取 id：`/snapshot` 里的钉钉条目（`dingMinutesOf`）只投影
 * `title/start/url` 三个字段（**不带** `taskUuid`），而 `dws minutes +detail` 要的是 taskUuid。
 * 从 URL 尾段取（`…/app/transcribes/<taskUuid>`）是**寻址**，不是判定 —— 取不到就如实回原因，不猜。
 */
function minuteRefOf(source, id, url) {
  const raw = String(id === null || id === undefined ? '' : id).trim()
  if (source !== 'feishu' && source !== 'dingtalk') {
    return {
      ok: false, id: '',
      error: `source 只认 feishu / dingtalk（实得 ${JSON.stringify(String(source === null || source === undefined ? '' : source))}）`,
    }
  }
  // ★ 两个来源的 id 都从 URL 尾段兜底取：飞书 `…/minutes/<minute_token>`、钉钉 `…/app/transcribes/<taskUuid>`。
  //   为什么必须兜底（2026-09-26 实测）：面板的听记一级行**根本没有 id 字段** ——
  //   `minutesRowModel` 只投影 `{src,title,url}`（用户明令"听记不显示时间"，行模型只留三个字段，T16-174 守着）。
  //   寻址在 host 做**一处**，面板不解析 URL（两处解析 = 两套寻址，漂移后就是"这条听记取不到正文"）。
  const re = source === 'feishu' ? MINUTE_TOKEN_RE : DING_MINUTE_ID_RE
  const label = source === 'feishu' ? '飞书 minute_token' : '钉钉听记 taskUuid'
  if (re.test(raw)) return { ok: true, id: raw, error: null }
  const tail = String(url === null || url === undefined ? '' : url)
    .split('?')[0].split('/').filter((s) => s.length > 0).pop() || ''
  if (re.test(tail)) return { ok: true, id: tail, error: null }
  return {
    ok: false, id: '',
    error: `${label} 形态不对（应为 8–80 位字母/数字/下划线/连字符；id=${JSON.stringify(raw.slice(0, 60))} `
      + `· url 尾段=${JSON.stringify(tail.slice(0, 60))}）`,
  }
}

/**
 * 飞书妙记详情采集：`lark-cli minutes +detail --profile <FEISHU_MINUTES_PROFILE> --minute-tokens <token>
 * --summary --todo --chapter --keyword --transcript --output-dir <_meta/tmp/…> --format json`。
 *
 * 三条必须守住的：
 *   ① **显式带 `--profile`** —— 默认 profile 是另一个缺 `minutes:minutes.search:read` 的应用，
 *      2026-09-19 的线上故障就是漏了它（表现为"CLI 无输出"，把"缺 profile"伪装成了"没数据"）；
 *   ② `--output-dir` **只能是相对路径**，且**必须落在 CLI 的工作目录内**。
 *      ⚠️ 2026-09-26 实测打脸：给绝对路径时 lark-cli 直接回
 *      `{"ok":false,"error":{"type":"validation","subtype":"invalid_argument",
 *        "message":"--output must be a relative path within the current directory, got \"C:\\…\""}}`
 *      且退出码 **2**、stdout 里只有这段错误 JSON（表现为"取不到正文"）。
 *      而 host 的工作目录**不是**知识库根（`ps()` 不设 cwd，子进程继承 DSH 进程的目录）
 *      ⇒ 命令里先 `Set-Location` 到知识库根，再传**相对** `_meta/tmp/…`。
 *      这样 CLI 回的 `transcript_file` 也是相对路径，由本层按知识库根解析（见下）。
 *   ③ 逐字稿文件由**本层读好**再交给引擎 —— 草稿引擎不读文件（读文件是采集层的活，见 SPEC §十二 12.1）。
 *
 * 任何失败都**如实返回**（ok:false + 原文错误 + exit code + 缺哪个 scope），不抛。
 */
async function collectFeishuMinuteDetail(token) {
  const dirRel = `_meta/tmp/minutes-draft/feishu-${token}-${Date.now()}`
  const dir = join(KNOWLEDGE, ...dirRel.split('/'))
  const base = {
    ok: false, payload: null, text: '', transcript_file: null, title: '',
    dir, exit: null, profile: FEISHU_MINUTES_PROFILE, missing_scopes: null, warning: null, error: null,
  }
  try { await mkdir(dir, { recursive: true }) } catch (e) {
    return { ...base, error: `飞书妙记取正文失败：建临时输出目录失败（${String((e && e.message) || e)}）` }
  }
  const prof = FEISHU_MINUTES_PROFILE.length > 0 ? ` --profile ${FEISHU_MINUTES_PROFILE}` : ''
  const script = "$ErrorActionPreference='SilentlyContinue'; try { [Console]::OutputEncoding=[Text.Encoding]::UTF8 } catch {}; "
    + '$o = [ordered]@{}; '
    + `Set-Location -LiteralPath "${KNOWLEDGE}"; `
    + `$o.cliPath = [string]((Get-Command ${LARK_CLI} -ErrorAction SilentlyContinue | Select-Object -First 1).Source); `
    + `$o.detail = (& ${LARK_CLI} minutes +detail${prof} --minute-tokens ${token}`
    + ` --summary --todo --chapter --keyword --transcript --output-dir ${dirRel} --format json 2>&1 | Out-String); `
    + '$o.exit = $LASTEXITCODE; '
    + '$o | ConvertTo-Json -Depth 3 -Compress'
  const r = await ps(['-NoProfile', '-NonInteractive', '-Command', script], 150000)
  const env = parseJsonLoose(r.stdout)
  if (env === null) {
    return {
      ...base,
      error: `飞书妙记取正文失败：外层输出无法解析（cli=${LARK_CLI} → ${String((r && r.stdout) || '').length} 字节 `
        + `profile=${FEISHU_MINUTES_PROFILE || '(默认)'} stdout=${JSON.stringify(String((r && r.stdout) || '').slice(0, 160))}）`,
    }
  }
  const withExit = { ...base, exit: env.exit === undefined ? null : env.exit }
  const payload = parseJsonLoose(env.detail)
  if (payload === null) {
    return {
      ...withExit,
      error: `飞书妙记取正文失败：CLI 输出不是 JSON（exit=${env.exit} cli=${env.cliPath || LARK_CLI} `
        + `profile=${FEISHU_MINUTES_PROFILE || '(默认)'} 输出片段=${JSON.stringify(String(env.detail || '').slice(0, 200))}）`,
    }
  }
  if (payload.ok !== true) {
    const err = (payload.error !== null && typeof payload.error === 'object') ? payload.error : {}
    const scopes = Array.isArray(err.missing_scopes) ? err.missing_scopes : null
    return {
      ...withExit, payload, missing_scopes: scopes,
      error: `飞书妙记取正文失败：${String(err.message || err.subtype || 'lark-cli 返回 ok:false')}`
        + (scopes === null ? '' : `（缺 scope ${scopes.join(' / ')}）`),
    }
  }
  const minutes = ((payload.data !== null && typeof payload.data === 'object' ? payload.data.minutes : null) || [])
  const m = Array.isArray(minutes) && minutes.length > 0 ? minutes[0] : null
  if (m === null) {
    return { ...withExit, payload, error: '飞书妙记取正文失败：payload 里没有 data.minutes[0]（token 不存在或无权限）' }
  }
  // 逐字稿文件：CLI 回的是**它写下的路径**（相对/绝对都可能），相对时按知识库根解析
  const rawPath = String(((m.artifacts !== null && typeof m.artifacts === 'object' ? m.artifacts.transcript_file : '') || ''))
  const abs = rawPath === '' ? null : (isAbsolute(rawPath) ? rawPath : join(KNOWLEDGE, rawPath))
  let text = ''
  let readErr = null
  if (abs !== null) {
    try { text = await readFile(abs, 'utf8') } catch (e) { readErr = String((e && e.message) || e) }
  }
  return {
    ...withExit, ok: true, payload, transcript_file: abs, text,
    title: String(m.title || ''),
    warning: readErr === null ? null
      : `逐字稿文件读不到（${abs}）：${readErr} —— 本次只用 artifacts（摘要 / 章节 / 待办）起草`,
  }
}

/**
 * 钉钉听记详情 → 草稿引擎入参（**纯函数**：只搬运，不判定）。
 *
 * 实测形状（2026-09-26 · `dws minutes +detail --id <taskUuid> --format json`）：
 *   `{ basic.result.{title,url,taskUuid,startTime,duration}, keywords.result.keywords[],
 *      summary.result.fullSummary, todos.result.{actions[],dingtalkTodoList[{title,minutesTodoId}]},
 *      transcript.result.{hasNext,nextToken,paragraphList[{paragraph,speakerDisplay.nickName,…}] } }`
 * ⇒ 这一路映射进引擎的三个字段（引擎侧 `from` 的取值域是固定的，不新增）：
 *   `artifacts.todos`（**实测非空**：`dingtalkTodoList[].title` → 引擎的 +4 权重那一支）、
 *   `artifacts.summary`（`fullSummary`）、`text`（`paragraphList[].paragraph` 拼接 = 逐字稿）。
 * ⚠️ `keywords` 不喂引擎：引擎的 `evidence.from` 取值域没有 `keyword`（`EVIDENCE_FROM`），
 *   硬塞进去只会多一个没人认的字段。它在 `collection.keywords` 里如实带出即可。
 * ⚠️ `transcript.hasNext === true` ⇒ 这一页**不是全部**逐字稿：如实带出（`has_next`），不假装取全。
 */
function dingDetailInput(payload) {
  const p = (payload !== null && typeof payload === 'object') ? payload : null
  if (p === null) return { ok: false, error: '钉钉听记取正文失败：dws 输出不是 JSON', title: '', text: '', artifacts: null, has_next: null, keywords: [] }
  const res = (k) => (((p[k] !== null && typeof p[k] === 'object') ? p[k].result : null) || {})
  const basic = res('basic')
  const errOf = (k) => {
    const blk = (p[k] !== null && typeof p[k] === 'object') ? p[k] : {}
    const msg = String(blk.errorMsg || '')
    return (blk.success === false && msg.length > 0 && msg !== 'ok') ? `${k} 失败：${msg}` : null
  }
  const errs = ['basic', 'summary', 'transcript', 'todos'].map(errOf).filter(Boolean)
  const title = String(basic.title || '')
  const summary = String(res('summary').fullSummary || '')
  const todoRaw = res('todos').dingtalkTodoList
  const todos = (Array.isArray(todoRaw) ? todoRaw : [])
    .map((t) => ({ title: String(((t !== null && typeof t === 'object') ? t.title : '') || '') }))
    .filter((t) => t.title.length > 0)
  const tr = res('transcript')
  const paras = Array.isArray(tr.paragraphList) ? tr.paragraphList : []
  const text = paras
    .map((x) => String(((x !== null && typeof x === 'object') ? x.paragraph : '') || ''))
    .filter((s) => s.length > 0)
    .join('\n')
  const kw = res('keywords').keywords
  return {
    ok: true, title, text,
    artifacts: { summary: summary.length > 0 ? summary : null, todos },
    has_next: tr.hasNext === true,
    keywords: (Array.isArray(kw) ? kw : []).map((x) => String(x)).filter((s) => s.length > 0),
    error: errs.length > 0 ? `钉钉听记部分产物失败（${errs.join(' ; ')}）` : null,
  }
}

/** 钉钉听记详情采集：`dws minutes +detail --id <taskUuid> --format json`（与听记列表同一条 CLI）。 */
async function collectDingMinuteDetail(id) {
  const script = "$ErrorActionPreference='SilentlyContinue'; try { [Console]::OutputEncoding=[Text.Encoding]::UTF8 } catch {}; "
    + '$o = [ordered]@{}; '
    + `$o.cliPath = [string]((Get-Command ${DWS_CLI} -ErrorAction SilentlyContinue | Select-Object -First 1).Source); `
    + `$o.detail = (& ${DWS_CLI} minutes +detail --id ${id} --format json 2>&1 | Out-String); $o.exit = $LASTEXITCODE; `
    + '$o | ConvertTo-Json -Depth 3 -Compress'
  const r = await ps(['-NoProfile', '-NonInteractive', '-Command', script], 150000)
  const env = parseJsonLoose(r.stdout)
  const base = { ok: false, id, dir: null, exit: null, profile: null, missing_scopes: null, warning: null, error: null }
  if (env === null) {
    return {
      ...base,
      error: `钉钉听记取正文失败：外层输出无法解析（cli=${DWS_CLI} stdout=${JSON.stringify(String((r && r.stdout) || '').slice(0, 160))}）`,
    }
  }
  const withExit = { ...base, exit: env.exit === undefined ? null : env.exit }
  const payload = parseJsonLoose(env.detail)
  if (payload === null) {
    return {
      ...withExit,
      error: `钉钉听记取正文失败：CLI 输出不是 JSON（exit=${env.exit} cli=${env.cliPath || DWS_CLI} `
        + `输出片段=${JSON.stringify(String(env.detail || '').slice(0, 200))}）`,
    }
  }
  const mapped = dingDetailInput(payload)
  if (mapped.ok !== true) return { ...withExit, error: mapped.error }
  // 「拿到正文」的判据与引擎一致：摘要 / 待办 / 逐字稿**至少一处 ≥8 字**
  const gotBody = [mapped.text, String(mapped.artifacts.summary || ''), ...mapped.artifacts.todos.map((t) => t.title)]
    .some((s) => String(s).length >= 8)
  if (!gotBody) {
    return { ...withExit, payload, error: '钉钉听记取正文失败：`+detail` 回来了，但摘要 / 待办 / 逐字稿三处都没有 ≥8 字的内容（这条听记可能还没生成产物）' }
  }
  return {
    ...withExit, ok: true, payload, title: mapped.title, text: mapped.text,
    artifacts: mapped.artifacts, has_next: mapped.has_next, keywords: mapped.keywords,
    warning: mapped.error,
  }
}

/** 跑草稿引擎：`node matter-draft.mjs --file <入参 JSON> --now <iso>`；入参落在 `_meta/tmp/`。 */
async function runMatterDraft(reqDoc, nowIso) {
  try { await mkdir(PWB_MINUTES_DRAFT_TMP, { recursive: true }) } catch (e) {
    return { ok: false, error: `草稿引擎不可用：建临时目录失败（${String((e && e.message) || e)}）`, req_path: null }
  }
  const reqPath = join(PWB_MINUTES_DRAFT_TMP, `args-${Date.now()}-${process.pid}.json`)
  try { await writeFile(reqPath, JSON.stringify(reqDoc), 'utf8') } catch (e) {
    return { ok: false, error: `草稿引擎不可用：入参写不进去（${String((e && e.message) || e)}）`, req_path: reqPath }
  }
  const r = await run(NODE, [PWB_MATTER_DRAFT_CLI, '--file', reqPath, '--now', nowIso], 90000)
  const j = parseJsonLoose(r.stdout)
  if (j === null) {
    return {
      ok: false, req_path: reqPath,
      error: `草稿引擎不可用：没有可解析的输出（cli=${PWB_MATTER_DRAFT_CLI} `
        + `stdout=${JSON.stringify(String(r.stdout || '').slice(0, 200))} stderr=${JSON.stringify(String(r.stderr || '').slice(0, 300))}）`,
    }
  }
  return { ok: true, draft: j, req_path: reqPath }
}

/**
 * 听记 payload 组装（**纯函数** —— 分源计数与 items 的同源性因此可被 Node 级行为实测）。
 *
 * 契约（面板与断言都照这一份读，不要各算一份）：
 *   · `items`  —— 两源**合并**的扁平列表（**兼容既有消费者**：每项仍带 title/url/start），新增 `source`；
 *   · `sources.{dingtalk,feishu}` —— 各自的 ok / authorized / error / missing_scopes / count / items；
 *   · `counts.{dingtalk,feishu,total}` —— **与 `sources.*.count` 同源同值**（同一数组的 length）。
 *     面板卡头「钉钉 N · 飞书 M」读的就是这两个数；未授权时 `count` 仍是 0，
 *     但面板**不得**把 0 当成"没有"显示 —— 它必须改说「未授权」并给出缺失的 scope（见 client.js）。
 */
function minutesPayload(dingItems, feishuRes) {
  const ding = Array.isArray(dingItems) ? dingItems : []
  const f = (feishuRes !== null && typeof feishuRes === 'object') ? feishuRes : {}
  const fei = (f.ok === true && Array.isArray(f.items)) ? f.items : []
  return {
    items: [...ding, ...fei],
    sources: {
      dingtalk: { ok: true, authorized: true, error: null, missing_scopes: null, count: ding.length, items: ding },
      feishu: {
        ok: f.ok === true,
        authorized: f.authorized === undefined ? null : f.authorized,
        error: f.error || null,
        missing_scopes: Array.isArray(f.missing_scopes) ? f.missing_scopes : null,
        shape: f.shape || null,
        count: fei.length,
        items: fei,
      },
    },
    counts: { dingtalk: ding.length, feishu: fei.length, total: ding.length + fei.length },
  }
}

/**
 * 把事件按「今天 / 明天 / 后天」分桶（2026-09-15 用户要求）。
 *
 * 约定：
 *   · 窗口含**当天已过期项**（今天 00:00 起即入窗）；
 *   · 桶内按开始时间由近到远排序；
 *   · 去重键 = `来源|id`（**不含组织**：实测同一场会在多个组织 profile 下 eventId 完全相同，
 *     带上组织就合并不掉 —— 2026-09-15 由 LK-10 抓到）；无 id 时退化为 `来源|开始时间`；
 *   · 窗口外（> 后天 23:59 或无法解析开始时间）**丢弃**，不静默塞进某天。
 * 纯函数：now 由调用方传入（可测、可复现）。
 */
/**
 * 条目在"哪几天"上出现 —— **跨天覆盖**（用户 2026-09-16 裁定）：
 *   · 住宿类（`source='trip'` 且 kind 为 hotel/stay）：覆盖 = **入住日 12:00 → 退房日 14:00**
 *     （所以 9/15–9/16 的酒店在今天 14:00 前仍然算"在进行中"；9/16–9/18 的酒店在三天里都出现）
 *   · 其他条目：覆盖 = 自身 start → end（无 end 视为当天一个点）
 * 返回毫秒区间；无法解析 start 返回 null（调用方按"丢弃"处理，不静默塞进某天）。
 */
function coverageOf(e) {
  const s = Date.parse((e && e.start) || '')
  if (Number.isNaN(s)) return null
  const rawEnd = Date.parse((e && e.end) || '')
  const end = Number.isNaN(rawEnd) ? s : Math.max(rawEnd, s)
  const isStay = (e && e.source) === 'trip' && ['hotel', 'stay'].includes(String(e.kind || ''))
  if (!isStay) return { start: s, end, stay: false }
  const ci = new Date(s); ci.setHours(12, 0, 0, 0)          // 入住日 12:00
  const co = new Date(Number.isNaN(rawEnd) ? s : rawEnd); co.setHours(14, 0, 0, 0)  // 退房日 14:00
  return { start: ci.getTime(), end: Math.max(co.getTime(), ci.getTime()), stay: true }
}

function bucketByNext3Days(events, now = new Date()) {
  const dayStart = new Date(now.getTime())
  dayStart.setHours(0, 0, 0, 0)
  const DAY_MS = 86400000
  const dayKeys = [0, 1, 2].map((i) => dayStart.getTime() + i * DAY_MS)
  const buckets = [[], [], []]
  const seen = [new Set(), new Set(), new Set()]
  for (const e of (events || [])) {
    const cov = coverageOf(e)
    if (cov === null) continue
    // ⚠️ 判据是**区间相交**，不是"开始时间落在某天"：否则昨晚入住的酒店在今天整条消失
    //    （2026-09-16 实测：9/15–9/16 的苏州酒店因为 start 在昨天而被整条丢掉）。
    for (let i = 0; i < 3; i += 1) {
      const from = dayKeys[i]
      const to = dayKeys[i] + DAY_MS
      if (cov.start >= to || cov.end < from) continue
      const key = `${e.source || '?'}|${e.id || e.start}`
      if (seen[i].has(key)) continue
      seen[i].add(key)
      // 同一条跨天条目在不同日子有不同"角色"，面板据此换措辞（入住 12:00 / 住宿中 / 退房 14:00 前）
      const firstDay = cov.start >= from          // 覆盖区间在本日内开始
      const lastDay = cov.end < to                // 覆盖区间在本日内结束
      const role = (!firstDay && !lastDay && cov.stay) ? 'stay'
        : (firstDay && lastDay ? 'point' : (firstDay ? 'checkin' : (lastDay ? 'checkout' : 'stay')))
      buckets[i].push(Object.assign({}, e, { dayRole: role, dayIndex: i }))
    }
  }
  const byStart = (a, b) => String(a.start || '').localeCompare(String(b.start || ''))
  for (const b of buckets) b.sort(byStart)
  const LABELS = ['今天', '明天', '后天']
  const days = buckets.map((items, i) => ({
    date: ymdLocal(new Date(dayKeys[i])), label: LABELS[i], items,
  }))
  // 计数按**唯一条目**（跨天条目在三天里都出现，但订单只有一张 —— 徽标不能说成 3 条）
  const uniq = { dingtalk: new Set(), feishu: new Set(), trip: new Set() }
  for (const items of buckets) {
    for (const e of items) {
      const src = String(e.source || 'dingtalk')
      if (uniq[src]) uniq[src].add(String(e.id || e.start || ''))
    }
  }
  const countOf = (src) => (uniq[src] ? uniq[src].size : 0)
  return {
    days,
    today: buckets[0],
    tomorrow: buckets[1],
    counts: { dingtalk: countOf('dingtalk'), feishu: countOf('feishu'), trip: countOf('trip') },
  }
}

/**
 * 日程条目的**规范键**（唯一实现，host 专用）。
 *   `source|id`，没有 id 时退回 `source|start` —— 与 `bucketByNext3Days()` 日内去重键**同一口径**
 *   （见该函数里的 `${e.source || '?'}|${e.id || e.start}`）。
 *   ⚠️ 面板拿到的 `calendar.cancelled[].key` 就是这个值；**客户端绝不自己拼键**
 *     （两处拼键 = 两套真相源，一旦漂移就是"取消了点不掉 / 恢复了不回来"这种静默失配）。
 */
function schedKeyOf(e) {
  const src = String((e && e.source) || 'dingtalk')
  const id = (e && e.id !== null && e.id !== undefined && String(e.id) !== '') ? String(e.id) : ''
  const start = String((e && e.start) || '')
  return id !== '' ? (src + '|' + id) : (src + '|' + start)
}

/**
 * 取消台账**纯函数核**：读改写 + 保留窗口裁剪（便于 Node 级直测，不用起 host）。
 *   · `cancel`  —— 按规范键 upsert（重复取消同一条 ⇒ 只留一条，`reason` 取最新）；
 *   · `restore` —— 按键删除（**这就是"可恢复"的实现**：删掉记录，行就回到窗口里）；
 *   · 裁剪只按 `at` 的时间戳，不按窗口位置（三天窗口滚动不影响台账语义）。
 * @returns {{ok:boolean, error:(string|null), cancels:Array, changed:boolean}}
 */
function applySchedCancel(prevList, action, rec, nowMs = Date.now()) {
  const list = Array.isArray(prevList) ? prevList.filter((c) => c !== null && typeof c === 'object') : []
  const key = String((rec && rec.key) || '')
  if (action !== 'cancel' && action !== 'restore') return { ok: false, error: 'action 只接受 cancel / restore', cancels: list, changed: false }
  if (key === '') return { ok: false, error: '缺少日程键（host 用事件身份字段计算，不接受空键）', cancels: list, changed: false }
  const keepMs = SCHED_CANCEL_KEEP_DAYS * 86400000
  const fresh = list.filter((c) => {
    const t = Date.parse(String(c.at || ''))
    return !Number.isFinite(t) || (nowMs - t) <= keepMs      // 时间坏的记录不静默丢（宁可留着让人看见）
  })
  if (action === 'restore') {
    const next = fresh.filter((c) => String(c.key) !== key)
    return { ok: true, error: null, cancels: next, changed: next.length !== list.length }
  }
  const next = fresh.filter((c) => String(c.key) !== key)
  next.push({
    key,
    title: String((rec && rec.title) || '').slice(0, 200),
    source: String((rec && rec.source) || 'dingtalk'),
    start: String((rec && rec.start) || '').slice(0, 40),
    // 2026-09-24：`end` 一并记 —— 跨天条目（住宿/出差）靠它才能判断"还在不在三天窗口里"
    //（`applyScheduleCancels` 的区间相交口径要 start+end；缺它只能退回"起点在三天内"）
    end: String((rec && rec.end) || '').slice(0, 40),
    reason: String((rec && rec.reason) || '').slice(0, 200),
    at: new Date(nowMs).toISOString(),
  })
  return { ok: true, error: null, cancels: next, changed: true }
}

/**
 * 把取消台账套到三天窗口上（**纯函数** · 面板看到的就是它的输出）。
 *   · `days/today/tomorrow/counts` 全部来自**过滤后**的事件集 ⇒ 卡头数字与列表同源
 *     （不会出现"卡头说钉钉 3 条、列表只剩 2 行"）；
 *   · `cancelled` = 台账里**确实落在当前窗口**的记录（窗口外的旧记录不占面板版面）——
 *     它就是面板「恢复」入口的数据源，`key` 原样回传给 `/schedule/act`。
 */
function applyScheduleCancels(events, cancels, now = new Date()) {
  const list = Array.isArray(cancels) ? cancels : []
  const cancelSet = new Set(list.map((c) => String(c.key)))
  const all3 = bucketByNext3Days(events, now)          // 未过滤：判断"这条取消还在不在当前窗口里"
  const inWindow = new Set()
  for (const items of [all3.today, all3.tomorrow, all3.days[2] ? all3.days[2].items : []]) {
    for (const e of items) inWindow.add(schedKeyOf(e))
  }
  // ── ★ 2026-09-24 修（真机 + 接口复现抓到的真 bug）：**判"还在不在窗口里"不能只看事件集** ──
  //   病灶：取消之后那条事件**已经从 events 里被过滤掉了**，而本函数在 `/snapshot` 路径上会被
  //   应用两次（`collect()` 一次 + `snapshotWithCancels()` 一次，后者为覆盖"快照缓存比台账旧"的
  //   情形而存在）⇒ 第二次跑到这里时 `inWindow` 里已经没有那条的键 ⇒ `cancelled.items` 变空 ⇒
  //   **面板的「恢复」入口一条都不显示：取消得掉、恢复不回来**（实测：取消一行后
  //   `calendar.cancelled = {count:0,items:[]}`，而该键按定义确实在窗口内）。
  //   修法：**以记录自己的时间为准**（台账里每条的 `start` 就是事件开始时间，`end` 2026-09-24 起也记）
  //   —— 它与"事件集还在不在"是两个**独立信号**，取**并集**：
  //     · 幂等：重复应用不会把 `cancelled` 抹掉（这正是本次 bug 的根因）；
  //     · 跨天条目（住宿/出差）也能判：记录里同时有 start/end 时按**区间相交**算，与
  //       `bucketByNext3Days()` 的口径一致；
  //     · 老记录没有 `end` ⇒ 退回"start 落在三天内"；再没有 `start`（极老）⇒ 退回事件集。
  const DAY_MS = 86400000
  const winFrom = new Date(now.getTime()); winFrom.setHours(0, 0, 0, 0)
  const fromMs = winFrom.getTime()
  const toMs = fromMs + 3 * DAY_MS
  const inWindowByRecord = (c) => {
    const s = Date.parse(String(c.start || ''))
    if (!Number.isFinite(s)) return null                        // 连 start 都没有 ⇒ 不表态
    const e = Date.parse(String(c.end || ''))
    if (Number.isFinite(e) && e > s) return s < toMs && e >= fromMs   // 区间相交（与分桶同口径）
    return s >= fromMs && s < toMs                              // 只有 start ⇒ 起点落在三天内
  }
  const visible = (Array.isArray(events) ? events : []).filter((e) => !cancelSet.has(schedKeyOf(e)))
  const next3 = bucketByNext3Days(visible, now)        // 过滤后：面板口径（计数同源）
  const cancelled = list.filter((c) => {
    if (inWindow.has(String(c.key))) return true        // ① 事件集还在（未过滤的第一遍）
    const byRec = inWindowByRecord(c)                    // ② 记录自己的时间（幂等，第二遍也认）
    return byRec === true
  })
  return {
    days: next3.days, today: next3.today, tomorrow: next3.tomorrow, counts: next3.counts,
    cancelled: { count: cancelled.length, items: cancelled },
  }
}

/** 杭州示例公司科技有限公司 → 示例公司 */
function shortOrg(corpName) {
  const n = String(corpName || '')
  if (n.length === 0) return '钉钉'
  const s = n.replace('杭州', '').replace('有限公司', '').replace('股份', '').replace('科技', '').replace('公司', '')
  return s.length > 0 ? s : n
}

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0 }

/**
 * 解析 `dws calendar +agenda` 的输出（**个人主日历**视角）。
 * 实测形态：{ count, events: [ { eventId, summary, status, start:{dateTime|date}, end:{…} } ] }
 * 与旧 `+today/+tomorrow`（组织日历视角、start/end 是字符串）**不是同一形态**，故单列一个解析器。
 */
function eventsFromAgenda(raw, orgLabel) {
  const j = parseJsonLoose(raw)
  const arr = j && Array.isArray(j.events) ? j.events : []
  return arr.map((e) => ({
    id: String((e && e.eventId) || ''),
    title: String((e && e.summary) || ''),
    start: toIso((e && e.start) || null),
    end: toIso((e && e.end) || null),
    location: toLoc((e && e.location) || null),
    organizer: String((e && e.organizer && e.organizer.displayName) || ''),
    status: String((e && e.status) || ''),
    org: String(orgLabel || ''),
    source: 'dingtalk',
  }))
}

/** Collect one snapshot. Merges every organization; never throws. */
async function collect() {
  // ── 取数路线（2026-10-03 用户要求「改成 Node 直接并发取数」）──────────────────
  //   默认走 `gatherDwsAndFiles()`（Node 并发，见其长注释）；
  //   两种情况回退老 PowerShell 脚本：设了 `DSH_WORKDESKTOP_COLLECT=ps`，或找不到 `dws.exe`。
  let data = null
  let why = ''
  if (process.env.DSH_WORKDESKTOP_COLLECT !== 'ps') {
    try {
      data = await gatherDwsAndFiles()
      if (data === null) why = '未找到 dws.exe（vendor 路径不存在）'
    } catch (e) {
      data = null
      why = `Node 取数失败：${String((e && e.message) || e)}`
    }
  }

  if (data === null) {
    let scriptError = null
    try {
      await mkdir(RUN_DIR, { recursive: true })
      // ⚠️ **必须带 UTF-8 BOM**（2026-09-15 实测定位）：
      //    Windows PowerShell 5.1 读**无 BOM** 的 .ps1 时按 ANSI（本机 CP936/GBK）解码，
      //    脚本里的中文注释会被解成乱码，并**把紧邻的语句吃掉** —— 表现是"某段命令静默返回空"。
      //    实测 A/B：同一个脚本无 BOM → `dws calendar +agenda` 每组织返回 0 字符；
      //              带 BOM → 正常返回 444 字符的事件 JSON（todos 在别处故当时没暴露）。
      await writeFile(SCRIPT_PATH, '\uFEFF' + SCRIPT, 'utf8')
    } catch (e) {
      scriptError = `write script failed: ${String((e && e.message) || e)}`
    }

    const run = scriptError === null
      ? await (async () => {
        // 这次采集真的在调 dws（钉钉 CLI）→ 期间标记为「DWS 调用中」（供底部/设备卡实时显示）
        activity.dwsBusy = true
        try { return await ps(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH]) } finally { activity.dwsBusy = false }
      })()
      : { ok: false, stdout: '', stderr: '', error: scriptError }
    data = run.ok === true ? parseJsonLoose(run.stdout) : null
    if (data === null) why = run.error || run.stderr.trim() || why || 'no json'
  }

  if (data === null) {
    return {
      ok: true,
      at: Date.now(),
      diag: `script failed: ${String(why).slice(0, 300)}`,
      knowledgePath: KNOWLEDGE,
      hermesUrl: HERMES_URL,
      calendar: { today: [], tomorrow: [], orgs: [], days: [], counts: { dingtalk: 0, feishu: 0, trip: 0 }, feishu: { ok: false, error: 'host 采集脚本失败，飞书日程未取', authorized: null, items: [] } },
      todos: { items: [], orgs: [], files: [], feishu: { ok: false, authorized: null, error: 'host 采集脚本失败，飞书任务未取', items: [] }, counts: { dingtalk: 0, feishu: 0, personal: 0 } },
      // 采集脚本整体失败时，听记同样给**分源结构**（不是旧的一层 items）——
      //   否则面板会走"host 未返回分源字段"的降级分支，把脚本失败误报成"host 太旧需重启"。
      minutes: minutesPayload([], { ok: false, authorized: null, error: 'host 采集脚本失败，听记未取', items: [] }),
      knowledge: { total: 0, counts: {}, recent: [], byCategory: {} },
    }
  }

  const perOrg = Array.isArray(data.perOrg) ? data.perOrg : []
  const seenTodo = new Set()
  const todos = []
  const todoOrgs = []
  const calOrgs = []
  // 近三天日程：三源（钉钉 / 飞书 / 行程）先汇总，最后统一分桶排序（见 bucketByNext3Days）
  const calEvents = []
  // 已完成的钉钉待办计数（用户：「已完成 = 已关闭」，不进待办列表但留存计数）
  //   ⚠️ 源头已用 `--status false` 过滤 ⇒ 该计数恒为 0（保留字段是为了契约稳定）
  let todoClosed = 0
  // 钉钉待办的**四类归属**计数（用户 2026-09-17 要求四类都要进来）
  const todoByCategory = { mine: 0, 'assigned-by-others': 0, 'assigned-to-others': 0, participating: 0 }

  for (const org of perOrg) {
    const label = shortOrg(org && org.corpName)
    // ── 三源合成：按角色分读的三份原始输出（每角色可能各带第 2 页）→ 去重 + 四类归属判定 ──
    //   `--size` 上限 20（>20 静默返回空），超出部分靠 `--page` 翻页带回
    //   （脚本只在上一页满 20 条时才取下一页，故这里通常只有第 1 页）。
    const pagesOf = (role) => {
      const out = []
      for (const key of [role, role + 'P2']) {
        const page = parseJsonLoose(org && org[key])
        if (page && Array.isArray(page.todos)) out.push(...page.todos)
      }
      return out
    }
    const classified = classifyTodoItems({
      executor: pagesOf('todosExecutor'),
      creator: pagesOf('todosCreator'),
      participant: pagesOf('todosParticipant'),
    })
    const arr = classified.items
    for (const [k, v] of Object.entries(classified.byCategory)) todoByCategory[k] = (todoByCategory[k] || 0) + v
    let open = 0
    for (let k = 0; k < arr.length; k += 1) {
      const t = arr[k] || {}
      const id = String(t.taskId || `${label}#${k}`)
      if (seenTodo.has(id)) continue
      seenTodo.add(id)
      const done = num(t.finalStatusStage) >= 2
      // ★ 用户口径（2026-09-16）：「已完成的项不应当在待办中显示，应当视为被关闭」。
      //   两条防线：① 采集脚本已加 `--status false`（源头只取未完成）；
      //            ② 这里再按 finalStatusStage 判一次（CLI 版本若忽略该 flag 也不漏）。
      //   ⚠️ 因此 `todoClosed` 恒为 0（源头已过滤）—— 保留该字段是为了契约稳定与将来"已关闭"视图。
      if (done) { todoClosed += 1; continue }
      open += 1
      todos.push({
        title: String(t.subject || t.title || ''), due: num(t.dueTime), done: false, org: label,
        // 四类归属（用户 2026-09-17 要求：都要进这里）：mine / assigned-by-others / assigned-to-others / participating
        category: String(t.category || 'mine'),
        taskId: String(t.taskId || ''),
        // 回写定位用：钉钉 taskId 是**组织内**唯一 ⇒ 必须带该条的 profile，否则可能写错组织（2026-09-17）
        profile: String((org && org.profile) || ''),
      })
    }
    todoOrgs.push({ label, count: arr.length, open })

    // 个人视角日程：+agenda 一批（今天 00:00 → 后天 23:59），最后统一分桶（bucketByNext3Days）
    {
      const list = eventsFromAgenda(org && org.agenda, label)
      for (const e of list) calEvents.push(e)
      calOrgs.push({ label, agenda: list.length })
    }
  }

  todos.sort((a, b) => (a.done === b.done ? ((a.due || 9e15) - (b.due || 9e15)) : (a.done ? 1 : -1)))

  // ── 听记（2026-09-19 用户规格）：**钉钉 + 飞书双源** ─────────────────────────
  //   · 钉钉 = `dws minutes +list-mine`（SCRIPT 里已经采回，这里只解析）；
  //   · 飞书 = `lark-cli minutes +search`（**本轮新增的采集通路**，见 collectFeishuMinutes）；
  //   · 两源各自**诚实降级**：钉钉拿不到不影响飞书那条，反之亦然（未授权/失败都如实带出）。
  //   · `minutesPayload()`（纯函数）保证 `counts` 与 `sources.*.count` 同源同值 —— 面板卡头
  //     的「钉钉 N · 飞书 M」与断言读的是同一个数，不存在第二份计数。
  const minRaw = parseJsonLoose(data.minutes)
  const rawMinutes = minRaw && Array.isArray(minRaw.minutes) ? minRaw.minutes : []
  const dingMinutes = dingMinutesOf(rawMinutes)

  // 飞书四条采集**互相独立**（各自起自己的 CLI、读自己的源，没有共享状态）⇒ 并发发出。
  //   2026-10-03：此前是四条顺序 await，实测这一段串行要 ~9 秒；并发后由最慢的一条决定。
  const [feishuMinutes, feishu, feishuTasks, personalTodos] = await Promise.all([
    collectFeishuMinutes(),
    collectFeishuCalendar(),
    collectFeishuTasks(),
    collectPersonalTodos(),
  ])
  const minutes = minutesPayload(dingMinutes, feishuMinutes)

  // 飞书日历（第二源）：与钉钉一并进同一批，最后统一分桶（任一源失败不影响另一源 —— 诚实降级）
  for (const e of (feishu.items || [])) calEvents.push(e)
  // 最近关闭（来自回写台账）：面板不展示已完成项，所以"重新打开"必须先知道刚关了哪条、它的源头 id 是什么。
  //   挑选规则 = `pickRecentClosed()`（**每个 source|id 只看时间上最后一次动作**；见该函数注释：
  //   旧实现的"取消集合"无时序，会把新做的 done 也被早前的 reopen 取消掉 —— 用户实测踩到过）。
  let todoRecentClosed = []
  try {
    const log = await readJson(PWB_TODO_ACTIONS)
    todoRecentClosed = pickRecentClosed(log && log.actions)
  } catch { todoRecentClosed = [] }

  // 行程（第三源）：T29 尚未实现 —— 若 `_meta/out/trips.json` 存在就先聚合进来，
  // 结构 { trips: [ {id,title,start,end,location,kind,vendor,no} ] }（见 PLAN_T29）。
  // 不存在 → 计数为 0，面板显示「行程 0」，不是伪造数据。
  let trips = []
  try {
    const doc = await readJson(join(PWB_DIR, 'trips.json'))
    if (doc && Array.isArray(doc.trips)) {
      trips = doc.trips.map((t) => ({
        id: String(t.id || ''), title: String(t.title || '(行程)'),
        start: toIso(t.start), end: toIso(t.end), location: toLoc(t.location),
        vendor: String(t.vendor || ''), no: String(t.no || ''), kind: String(t.kind || ''),
        // ★ needs_review 必须透传给面板：只有日期没有时刻的车次/航班，面板要显示「时间待确认」，
        //   而不是把日期规范化成 00:00Z 后在本地渲染成 08:00 那种**看起来精确的假时间**（实测踩过）。
        needs_review: t.needs_review === true,
        source: 'trip',
      }))
      for (const e of trips) calEvents.push(e)
    }
  } catch { /* 无行程源 */ }

  // 近三天（今天 / 明天 / 后天）统一分桶：含当天已过期项 · 由近到远 · 三源已聚合在同一批
  // ★ 2026-09-20（第三条「日程取消」）：分桶前先把**取消台账**套上去 —— 过滤、计数、面板口径
  //   三者都出自同一个纯函数 `applyScheduleCancels()`（卡头数字 == 列表口径，不许两套算法）。
  //   台账读不到（文件不存在）⇒ 当成空台账，**不报错**（没有取消 ≠ 读取失败）。
  let schedCancels = []
  try {
    const sc = await readJson(PWB_SCHED_CANCELS)
    schedCancels = (sc && Array.isArray(sc.cancels)) ? sc.cancels : []
  } catch { schedCancels = [] }
  const next3 = applyScheduleCancels(calEvents, schedCancels, new Date())
  const days = next3.days
  const today = next3.today
  const tomorrow = next3.tomorrow
  const calCounts = next3.counts

  return {
    ok: true,
    at: Date.now(),
    diag: `${data.engine === 'node' ? `Node 并发 ${num(data.engineMs)}ms` : `PS ${String(data.psVersion || '?')}`} · 组织 ${perOrg.length} · 待办 ${todos.length}(未完成 ${todos.filter((t) => !t.done).length})`
      + ` · 日程(近三天) 钉钉${calCounts.dingtalk} 飞书${feishu.ok ? calCounts.feishu : (feishu.authorized === false ? '未授权' : '读取失败')} 行程${calCounts.trip}`
      + ` · 听记 钉钉${minutes.counts.dingtalk} 飞书${feishuMinutes.ok === true ? minutes.counts.feishu : (feishuMinutes.authorized === false ? '未授权' : '读取失败')}`
      + ` · files=${num(data.totalFiles)}`,
    knowledgePath: KNOWLEDGE,
    hermesUrl: HERMES_URL,
    // days = 近三天（今天/明天/后天）的三源聚合结果；today/tomorrow 保留给旧消费方
    calendar: { today, tomorrow, days, counts: calCounts, orgs: calOrgs, trips, feishu, cancelled: next3.cancelled },
    todos: {
      // ⚠️ 2026-09-16 用户要求「在列表中展示全部，超过高度部分滚动条即可」⇒ 原 `slice(0, 12)`
      //   会把钉钉待办**在 host 侧就砍掉**，面板拿到 12 条却显示"钉钉 19"——两处口径打架。
      //   现改为**全量下发**（留 200 条安全上限防病态数据），行数上限交给前端卡体滚动。
      items: todos.slice(0, 200),
      orgs: todoOrgs,
      files: Array.isArray(data.todoFiles) ? data.todoFiles : [],
      // 飞书任务（第二源）：与钉钉待办并列展示；失败/未授权如实带上，面板据此显示原因
      feishu: feishuTasks,
      // 个人待办（第三源）：`Other/Todo/` 下的文件 —— **手动放置 或 会话内经 cli-todo.mjs 创建**
      //   （用户口径："待办的个人匹配的是手动创建的或者在 dsh 会话中创建的"）
      personal: personalTodos,
      // 最近回写动作（供面板"最近关闭 → ↺ 重新打开"）：只保留**成功且涉及完成**的最后几条
      recentClosed: todoRecentClosed,
      counts: {
        // dingtalk = **未完成**条数（= items.length，两条口径一致）
        dingtalk: todos.length,
        // 已完成（= 已关闭）计数：源头已过滤 ⇒ 恒为 0（字段保留以稳定契约）
        dingtalkClosed: todoClosed,
        // 四类归属计数（别人安排给我的 / 我安排给别人的 / 自己创建的 / 我参与的）
        dingtalkByCategory: todoByCategory,
        feishu: feishuTasks.ok === true ? feishuTasks.items.length : 0,
        personal: personalTodos.ok === true ? personalTodos.items.length : 0,
        personalClosed: personalTodos.ok === true ? personalTodos.closed : 0,
      },
    },
    minutes,
    knowledge: {
      total: num(data.totalFiles),
      counts: data.counts || {},
      recent: Array.isArray(data.recent) ? data.recent : [],
      byCategory: data.byCategory || {},
    },
  }
}

/* ══ 工程图（Project Graph）══════════════════════════════════════════════════
 *
 * 第五个「工作台」：把本机的 Project Graph（https://github.com/graphif/project-graph）
 * 接进 DSH —— 面板是一栏，内容是**上游自己的 CLI** 跑出来的，本插件不复制它的图模型。
 *
 * ── 三层各自是什么 ────────────────────────────────────────────────────────
 *   ① 上游仓库（PG_REPO）：clone 下来的 project-graph 检出，`pnpm install` 过。
 *      它的 CLI 入口是 `packages/project-graph-cli/src/cli.mjs`（tsx 直跑 TS 源码）。
 *   ② 工程图工作区（PG_HOME，默认 `$DSH_HOME/.dsh-project-graph`）：**本插件的数据根** ——
 *      `projects/` 放 `.prg` 工程，`bin/` 放编译出来的所有权 helper，`cache/` 放临时产物。
 *      与知识库解耦：工程图不往 `_meta/out/` 写任何东西。
 *   ③ 本插件：只做三件事 —— 拉起 CLI、把结果透传给浏览器半段、把同一批动作开成 agent 工具。
 *
 * ── 为什么要自己编一个「所有权 helper」────────────────────────────────────
 *   上游 CLI 在动手前必须先独占目标 `.prg`：它会 spawn 一个**原生产物**
 *   （`app/src-tauri/src/bin/project-graph-ownership-helper.rs`）并核对一行 JSON 协议，
 *   还要读写「项目级引用」存储（`n1` / `e1` 这套稳定句柄，同一份 Rust 侧实现）。
 *   本机没有那个目标原生产物（要整条 Tauri/CEF 工具链），所以这里带上**同协议的
 *   C# 等价实现**（`pg-helper/ProjectGraphOwnershipHelper.cs`），运行前用系统自带的
 *   `csc.exe` 编到 `<PG_HOME>/bin/`。**仓库里不放二进制**：源码是唯一真相，
 *   编译产物属于这台机器的运行目录。协议与差异见那份 .cs 的头部注释。
 *
 * ── 上游的 29 个内置工具 = 工程图的全部动作 ───────────────────────────────
 *   `tool list` / `tool describe <name>` / `tool invoke <name> --project <x.prg> --input <JSON>`。
 *   创建 / 编辑 / 删除 / 连线 / 布局都在里面，本插件**不重写任何一条判定**，只转调。
 *
 *   ⚠️ 上游把 29 条分成两档（`BuiltInToolRuntimeProfiles.ts`）：
 *     · **关闭态可跑 19 条**（不需要桌面端）：读、改、删、连线、树扩展、布局、上色；
 *     · **需要打开态 10 条**（声明了 `viewport` 或 `selection`）：`create_text_node`
 *       `generate_node_tree_by_text` `search_and_add_image_node` `select_objects`
 *       `get_selected_nodes` `get_selected_refs` `get_nodes_in_viewport`
 *       `delete_selected_nodes` `sort_selected_nodes_by_x/by_y` —— 只有桌面端开着才有，
 *       关闭态调用会回 `PROJECT_MUST_BE_OPEN`。本插件**原样透传**这个错误码，
 *       不假装成功、也不把这个能力说成"我们也支持"。
 *     ⇒ 所以关闭态下"新建节点"的正路是**树扩展**：新工程模板里预置了一个根节点，
 *       用 `expand_node_tree_from_node` / `breadth_expand_node` / `depth_expand_node`
 *       就能长出整棵树（这三条都不需要 viewport）。
 */

/** 上游检出目录（`DSH_WORKDESKTOP_PROJECT_GRAPH_REPO` 覆盖）。 */
const PG_REPO = process.env.DSH_WORKDESKTOP_PROJECT_GRAPH_REPO
  || (HOME === '' ? '' : join(HOME, 'Desktop', 'DSH', 'project-graph'))
/** 工程图工作区根（`DSH_WORKDESKTOP_PROJECT_GRAPH_DIR` 覆盖）。 */
const PG_HOME = process.env.DSH_WORKDESKTOP_PROJECT_GRAPH_DIR
  || join(process.env.DSH_HOME || (HOME === '' ? '' : join(HOME, '.dsh')), '.dsh-project-graph')
const PG_PROJECTS = join(PG_HOME, 'projects')
const PG_BIN = join(PG_HOME, 'bin')
const PG_HELPER_EXE = join(PG_BIN, 'project-graph-ownership-helper.exe')
/** 空工程模板：一个预置了根节点的 `.prg`，由 `pg-helper/build-empty-project.mjs` 生成。 */
const PG_SEED = join(PG_BIN, 'empty-project.prg')
/** 插件自己的目录（`lib/` 的上一层）—— helper 的源码与模板在这里。 */
const PG_PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PG_HELPER_SRC = join(PG_PLUGIN_ROOT, 'pg-helper', 'ProjectGraphOwnershipHelper.cs')
const PG_SEED_BUNDLED = join(PG_PLUGIN_ROOT, 'pg-helper', 'empty-project.prg')
const PG_CLI = join(PG_REPO, 'packages', 'project-graph-cli', 'src', 'cli.mjs')
const PG_CSC = process.env.DSH_WORKDESKTOP_CSC
  || 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'
/** 工程名只允许这些字符（防路径穿越；`.prg` 由代码补）。 */
const PG_NAME_RE = /^[^\\/:*?"<>|\u0000-\u001f]{1,80}$/
const PG_MAX_BUFFER = 32 * 1024 * 1024

let pgHelperBuild = null           // { ok, exe, error, at } —— 进程内只编一次
const pgToolCache = { data: null } // `tool list` 的进程内缓存（tsx 冷启动很贵）
const pgEvents = { rev: 0, list: [] } // 面板唤起 / 落图事件（与「坐标系」同款：轮询取）

function pgPushEvent(kind, payload) {
  pgEvents.rev += 1
  pgEvents.list.push({ rev: pgEvents.rev, kind, at: Date.now(), ...payload })
  if (pgEvents.list.length > 50) pgEvents.list.splice(0, pgEvents.list.length - 50)
}

/**
 * 工程名 → 绝对路径；越界或非法名直接抛。
 *
 * 两种入参都收：
 *   · **工程名**（`我的工程` / `我的工程.prg`）—— 常规用法；
 *   · **绝对路径** —— 但必须**落在 `<PG_PROJECTS>` 之内**（越界一律拒）。
 *     没有这一条，`/pg/graph` 那种"已经解析过路径再往下传"的调用会自己把自己拒掉
 *     （实测踩到过：`PG-5` 报"工程名不合法"，因为路径里的 `\` 与 `:` 不合法）。
 */
function pgProjectPath(name) {
  const raw = String(name || '')
  const direct = isAbsolute(raw) ? raw : null
  if (direct !== null) {
    const root = PG_PROJECTS.endsWith('\\') ? PG_PROJECTS : PG_PROJECTS + '\\'
    const resolved = raw
    if (!resolved.toLowerCase().startsWith(root.toLowerCase())) throw new Error(`工程路径越出工作区：${raw}`)
    if (!resolved.toLowerCase().endsWith('.prg')) throw new Error(`不是 .prg 工程：${raw}`)
    return resolved
  }
  if (!PG_NAME_RE.test(raw)) throw new Error(`工程名不合法：${raw}`)
  const file = raw.toLowerCase().endsWith('.prg') ? raw : `${raw}.prg`
  return join(PG_PROJECTS, file)
}

/**
 * 跑一次上游 CLI。**成功 = stdout 恰好一个 JSON 值**；失败 = stdout 空 + stderr 一个
 * JSON 错误对象（上游 `docs/agents/cli.md` 的报文契约）。这里两种情况都如实回传，
 * 不把 stderr 的空字符串伪装成"没有错误"。
 */
function pgRun(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(NODE, [PG_CLI, '--', ...args], {
      cwd: PG_REPO === '' ? undefined : PG_REPO,
      timeout: timeoutMs || 180000,
      maxBuffer: PG_MAX_BUFFER,
      windowsHide: true,
      env: { ...process.env, PROJECT_GRAPH_OWNERSHIP_HELPER_PATH: PG_HELPER_EXE },
    }, (err, stdout, stderr) => {
      resolve({
        ok: err === null,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: err === null ? null : String((err && err.message) || err),
      })
    })
  })
}

/**
 * 解析上游 CLI 的 stdout。
 *
 * ⚠️ 上游的报文契约是"**恰好一个 JSON 值**"—— 这个值**可以是数组**
 * （`tool list` 回 `[{name,description,inputSchema},…]`，`check_connections` 回
 * `[{fromRef,toRef,connected},…]`）。所以**不能**用上面那个 `parseJsonLoose`：
 * 它从第一个 `{` 截到最后一个 `}`，对数组会截出 `{…},{…}` 这种非法 JSON，
 * 结果是"CLI 明明成功了，host 却当没读到"（实测踩到过，PG-4 那条断言抓到的就是它）。
 *
 * 顺序：先按整段严格解析；只有带横幅的输出才退回宽松解析。
 */
function pgParseJson(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (trimmed === '') return null
  try { return JSON.parse(trimmed) } catch { /* 不是整段 JSON：退回宽松解析 */ }
  return parseJsonLoose(trimmed)
}

/** CLI 的调用结果 → 结构化回执（成功取 stdout 的 JSON；失败取 stderr 的 JSON 错误）。 */
function pgResult(r) {
  if (r.ok) {
    const value = pgParseJson(r.stdout)
    if (value === null) {
      return { ok: false, error: 'CLI 回了 0 但 stdout 不是 JSON', raw: r.stdout.slice(0, 4000) }
    }
    return { ok: true, value }
  }
  const failure = pgParseJson(r.stderr)
  return {
    ok: false,
    error: (failure && failure.message) || r.error || 'CLI 调用失败',
    code: failure && failure.code ? failure.code : undefined,
    detail: failure || undefined,
    stderr: failure === null ? r.stderr.slice(0, 2000) : undefined,
  }
}

/** 需要时把 C# helper 编成 exe（源码比 exe 新也重编）。返回 { ok, exe, error }。 */
async function pgEnsureHelper() {
  if (pgHelperBuild !== null && pgHelperBuild.ok) return pgHelperBuild
  try {
    await mkdir(PG_BIN, { recursive: true })
    const srcStat = await stat(PG_HELPER_SRC)
    const exeStat = await stat(PG_HELPER_EXE).catch(() => null)
    if (exeStat !== null && exeStat.mtimeMs >= srcStat.mtimeMs && exeStat.size > 0) {
      pgHelperBuild = { ok: true, exe: PG_HELPER_EXE, error: null, at: Date.now(), reused: true }
      return pgHelperBuild
    }
    // `/r:System.Web.Extensions.dll` 是**必须**的：helper 用 JavaScriptSerializer 读写
    // `ai-project-references.json`（.NET Framework 自带的 JSON 解析器在这个程序集里，
    // 不在 csc 的默认引用集里）。少了它编译当场报 CS0246。
    const build = await run(PG_CSC, [
      '/nologo', '/target:exe', '/optimize+', '/r:System.Web.Extensions.dll',
      `/out:${PG_HELPER_EXE}`, PG_HELPER_SRC,
    ], 120000)
    if (!build.ok) {
      pgHelperBuild = {
        ok: false, exe: PG_HELPER_EXE, at: Date.now(),
        error: `编译 ${PG_CSC} 失败：${String(build.stderr || build.error || '').slice(0, 400)}`,
      }
      return pgHelperBuild
    }
    pgHelperBuild = { ok: true, exe: PG_HELPER_EXE, error: null, at: Date.now() }
    return pgHelperBuild
  } catch (error) {
    pgHelperBuild = { ok: false, exe: PG_HELPER_EXE, at: Date.now(), error: String((error && error.message) || error) }
    return pgHelperBuild
  }
}

/** 工程图整体可用性（面板与工具都用它给出**具体**原因，不写"不可用"三个字了事）。 */
async function pgStatus() {
  const helper = await pgEnsureHelper()
  const [repoStat, cliStat, modulesStat] = await Promise.all([
    stat(PG_REPO).catch(() => null),
    stat(PG_CLI).catch(() => null),
    stat(join(PG_REPO, 'node_modules')).catch(() => null),
  ])
  return {
    ok: repoStat !== null && cliStat !== null && helper.ok,
    repo: PG_REPO,
    repoReady: repoStat !== null,
    cli: PG_CLI,
    cliReady: cliStat !== null,
    dependenciesReady: modulesStat !== null,
    workspace: PG_HOME,
    projectsDir: PG_PROJECTS,
    helperExe: helper.exe,
    helperReady: helper.ok === true,
    helperError: helper.error || null,
    seedReady: existsSync(PG_SEED) || existsSync(PG_SEED_BUNDLED),
    node: NODE,
    installHint: modulesStat === null
      ? `先在上游检出里装依赖：cd "${PG_REPO}" && pnpm install`
      : null,
  }
}

/** 工作区里的工程清单（按修改时间倒序）。 */
async function pgListProjects() {
  let entries = []
  try { entries = await readdir(PG_PROJECTS, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.prg')) continue
    const info = await stat(join(PG_PROJECTS, entry.name)).catch(() => null)
    out.push({
      name: entry.name,
      title: entry.name.replace(/\.prg$/i, ''),
      size: info === null ? 0 : info.size,
      updatedAt: info === null ? 0 : info.mtimeMs,
    })
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * 让一个工程先"分到引用"。
 *
 * 上游把 `n1` / `e1` 这套**项目级引用**存在一个**按工程 URI 分键**的存储里
 * （`ai-project-references.json`，本插件的 C# helper 负责读写）。引用由声明了
 * `projectReferences.allocates` 的工具分配，其中 `get_all_nodes` 是最轻的一条
 * （`reads:false, allocates:true, persistence:'project-references'`）。
 *
 * 所以：**一份新工程在第一次 `get_all_nodes` 之前是没有引用的** ——
 * 这期间任何"按引用操作"的工具（`expand_node_tree_from_node` / `edit_text_node` /
 * `delete_node` …）都会回 `unknown_ref`。实测踩到过：新建工程后直接树扩展，
 * 报 `Project Object Reference does not exist. ref=n1`。
 *
 * 新建工程时调一次这个函数，就把"新工程永远可从 n1 开始"变成契约，而不是运气。
 */
async function pgEnsureReferences(file) {
  const r = await pgInvoke('get_all_nodes', file, {}, false)
  return r.ok === true
}

/** 调一条上游内置工具。`project` 传工程名或工作区内的绝对路径。 */
async function pgInvoke(tool, project, input, allowUpgrade) {
  const name = String(tool || '').trim()
  if (name === '') return { ok: false, error: 'invoke 需要 tool' }
  let file
  try { file = pgProjectPath(project) } catch (error) { return { ok: false, error: String((error && error.message) || error) } }
  if (!existsSync(file)) return { ok: false, error: `没有这个工程：${file}`, code: 'PROJECT_NOT_FOUND' }
  const args = ['tool', 'invoke', name, '--project', file, '--input', JSON.stringify(input === undefined || input === null ? {} : input)]
  if (allowUpgrade === true) args.push('--allow-upgrade')
  const first = pgResult(await pgRun(args))
  // 自愈一次：引用存储里还没有这个工程的条目（例如工程是用户自己拷进来的）⇒
  // 先跑一次分配引用的读，再原样重试同一条调用。**只重试一次**，且不改入参。
  if (first.ok !== true && name !== 'get_all_nodes' && /unknown_ref|Reference does not exist/i.test(String(first.error || ''))) {
    if (await pgEnsureReferences(file)) {
      const retryArgs = args.slice()
      return pgResult(await pgRun(retryArgs))
    }
  }
  return first
}

/**
 * 空工程模板：**只读模板，绝不清空用户的工程**。
 *   ① 工作区里有 `<PG_BIN>/empty-project.prg` 就直接用；
 *   ② 没有就从插件自带的 `pg-helper/empty-project.prg` 拷一份过来；
 *   ③ 两者都没有就如实报错，让调用方知道缺什么 —— 不拿工作区里某个真工程去"派生"
 *      （那会先把人家清空，是最不该有的副作用）。
 */
async function pgEnsureSeed() {
  if (existsSync(PG_SEED)) return { ok: true, seed: PG_SEED, created: false }
  if (!existsSync(PG_SEED_BUNDLED)) {
    return {
      ok: false,
      error: `空工程模板不存在：${PG_SEED} 与 ${PG_SEED_BUNDLED} 都没有 —— 先跑一次 pg-helper/build-empty-project.mjs（见 README「工程图」一节）`,
    }
  }
  await mkdir(PG_BIN, { recursive: true })
  const { copyFile } = await import('node:fs/promises')
  await copyFile(PG_SEED_BUNDLED, PG_SEED)
  return { ok: true, seed: PG_SEED, created: true }
}

/**
 * 工程图 · 文档层（面板的画布交互走这里）
 *
 * 上游 CLI 那一层只认项目级引用（`n1` / `e1`），给不了画布要的东西：
 * 一次拖动要动十几个对象、要能删掉没有引用的对象、要能在任意位置新建。
 * 所以这几条走 `pg-helper/project-graph-doc.mjs`（与 MCP server 共用同一份实现）。
 *
 * ⚠️ 文档层**不经过上游的所有权锁**：同一时刻只应有一个写者。
 * 面板写之前会先取一次图，用户拖动期间不会有别人动它；真撞上也只能认。
 */
async function pgDocLoad(project) {
  let file
  try { file = pgProjectPath(project) } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
  if (!existsSync(file)) return { ok: false, error: `没有这个工程：${file}`, code: 'PROJECT_NOT_FOUND' }
  try {
    const loaded = pgReadDocument(file)
    return { ok: true, file, doc: loaded.doc, stage: loaded.stage }
  } catch (error) {
    return { ok: false, error: `读 .prg 失败：${String((error && error.message) || error)}` }
  }
}

/**
 * 撤销栈（**每个工程一条，进程内**）。
 *
 * 做法是"动之前先存一份整个舞台" —— 文档很小（用户的工程 7KB 左右），
 * 存整份比给每种操作单独写一个反操作简单得多，也不会漏（新增一种写操作时不用再补一条反向逻辑）。
 * 上限 60 步，撤销过的东西进 redo 栈。
 */
const pgUndo = new Map()
const PG_UNDO_MAX = 60

function pgUndoEntry(file) {
  if (!pgUndo.has(file)) pgUndo.set(file, { past: [], future: [] })
  return pgUndo.get(file)
}

/** 在任何写盘**之前**调用：记下当前状态。 */
function pgMarkUndo(loaded) {
  const entry = pgUndoEntry(loaded.file)
  entry.past.push(structuredClone(loaded.stage))
  if (entry.past.length > PG_UNDO_MAX) entry.past.shift()
  entry.future.length = 0
}

/**
 * 撤销 / 重做：把整份舞台换回去再写盘。
 * ⚠️ 换回去之后要**重新校验引用**（$ 下标的完整性）—— 栈里的快照理论上都是合法的，
 * 但真出问题时要当场炸，而不是写一个坏文件出去。
 */
function pgUndoStep(project, direction) {
  let file
  try { file = pgProjectPath(project) } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
  const entry = pgUndoEntry(file)
  const from = direction === 'redo' ? 'future' : 'past'
  const to = direction === 'redo' ? 'past' : 'future'
  if (entry[from].length === 0) {
    return { ok: false, error: direction === 'redo' ? '没有可重做的了' : '没有可撤销的了', canUndo: entry.past.length > 0, canRedo: entry.future.length > 0 }
  }
  const loaded = (() => {
    try {
      const doc = pgReadDocument(file)
      return { ok: true, file, doc: doc.doc, stage: doc.stage }
    } catch (error) { return { ok: false, error: `读 .prg 失败：${String((error && error.message) || error)}` } }
  })()
  if (loaded.ok !== true) return loaded
  const restored = entry[from].pop()
  entry[to].push(structuredClone(loaded.stage))
  loaded.stage = restored
  const written = pgDocWrite(loaded)
  if (written.ok !== true) return written
  pgPushEvent('graph', { project: String(project || ''), op: direction })
  return {
    ok: true, bytes: written.bytes, objects: restored.length,
    canUndo: entry.past.length > 0, canRedo: entry.future.length > 0,
  }
}

function pgDocWrite(loaded) {
  try {
    const bytes = pgWriteDocument(loaded.file, loaded.doc, loaded.stage)
    return { ok: true, bytes }
  } catch (error) {
    return { ok: false, error: `写 .prg 失败：${String((error && error.message) || error)}` }
  }
}

/** 面板要的整份文档读数：每个对象一条摘要（画布直接照着画）。 */
async function pgDocumentSummary(project) {
  const loaded = await pgDocLoad(project)
  if (loaded.ok !== true) return loaded
  const objects = loaded.stage.map((object, index) => pgSummarize(object, index, loaded.stage))
  const types = objects.reduce((acc, item) => {
    const key = item.type === null ? '(未知)' : item.type
    acc[key] = (acc[key] || 0) + 1
    return acc
  }, {})
  return {
    ok: true,
    project: loaded.file,
    name: loaded.file.split('\\').pop(),
    metadata: loaded.doc.metadata,
    entryNames: (loaded.doc.entries || []).map((entry) => entry.name),
    attachments: loaded.doc.attachments,
    stageCount: loaded.stage.length,
    types,
    objects,
  }
}

/** 引用 ↔ uuid 的精确对照（面板点了一个 `n1` 想改它时要用）。 */
async function pgLocate(project) {
  const loaded = await pgDocLoad(project)
  if (loaded.ok !== true) return loaded
  const nodes = await pgInvoke('get_all_nodes', loaded.file, {}, false)
  if (nodes.ok !== true) return nodes
  const cliObjects = (nodes.value && Array.isArray(nodes.value.objects)) ? nodes.value.objects : []
  const bridge = pgLocateBridge(cliObjects, loaded.stage)
  return {
    ok: bridge.ok,
    project: loaded.file,
    refs: bridge.refs,
    objects: bridge.objects,
    matched: bridge.matched,
    pairs: bridge.pairs,
    unmatchedRefs: bridge.unmatchedRefs,
    unmatchedObjects: bridge.unmatchedObjects,
    note: bridge.ok
      ? '两层完全对上（每个引用恰配一个对象，反之亦然）'
      : '不是双射：有引用或对象没配上（实体按 类型+文本+坐标、连线按 两端uuid+文本，都要求两边唯一；重复项判为无法确定，不猜）',
  }
}

/** 上游内置工具目录（29 条）：慢（tsx 冷启动），所以进程内缓存一次。 */
async function pgLoadCatalog() {
  if (pgToolCache.data !== null) return pgToolCache.data
  const r = await pgRun(['tool', 'list'], 120000)
  const parsed = r.ok ? pgParseJson(r.stdout) : null
  if (!Array.isArray(parsed)) return null
  pgToolCache.data = parsed
  return parsed
}

/**
 * 取某一条上游工具的完整定义（含 inputSchema）。
 *
 * ⚠️ 回执形状**只有一种**：`{ ok:true, tool:<entry> }`。
 * 之前这里是"命中缓存回 `tool`、没命中就退回 `pgResult()` 的 `value`"——
 * 同一个路由在缓存冷 / 热两种状态下回两种形状，调用方（面板、MCP server、探针）
 * 必须两种都认才不出错。实测踩到过：探针按 `tool` 取到 null。
 * 现在无论冷热都归一到 `tool`（缓存没命中就现调 `tool describe` 并补进缓存）。
 */
async function pgDescribeTool(name) {
  const wanted = String(name || '').trim()
  if (wanted === '') return { ok: false, error: 'tool 需要 name' }
  const catalog = await pgLoadCatalog()
  if (Array.isArray(catalog)) {
    const found = catalog.find((t) => t && t.name === wanted)
    if (found !== undefined) return { ok: true, tool: found }
  }
  const r = pgResult(await pgRun(['tool', 'describe', wanted], 120000))
  if (r.ok !== true) return r
  return { ok: true, tool: r.value }
}

function sendJson(res, code, value) {
  const body = JSON.stringify(value)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 65536) { resolve(''); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

export function apply(ctx) {
  const cache = { at: 0, data: null, inflight: null }
  // ── 快照的**后台预热**（2026-10-03 用户问"读取时启动画面等很久"之后加的）──────────
  //   现场：`/snapshot` 冷启动要跑一个 PowerShell 采集脚本，实测 **25 秒**（逐组织调钉钉 CLI）；
  //         而它命中缓存时只有 **3~19 毫秒**。用户每次打开面板大多是冷缓存 ⇒ 每次都等二十几秒。
  //   做法：① 开机先热一次（一次性 25 秒，不占用户时间）；
  //         ② 之后**只在"最近有人要过快照"时**滚动预热（15 分钟没人看就不白跑）。
  //   ⚠️ `ps()` / `run()` 走 `execFile`（异步）⇒ 后台预热**不会**挡住别的路由
  //      （不是 `spawnSync` 那种卡事件循环的写法）。
  //   ⚠️ 写口（日程取消 / 处置 / 待办回写）本来就会 `cache.data = null` 失效缓存；
  //      预热只会在下一拍重取，不会把失效又写回旧的。
  let lastSnapshotAskAt = 0
  const SNAPSHOT_WARM_IDLE_MS = 15 * 60000
  const SNAPSHOT_WARM_MS = Math.max(60000, CACHE_MS - 15000)
  function warmSnapshot(forceRun) {
    if (cache.inflight !== null) return          // 有人在跑就别叠一次（CLI 很贵）
    if (forceRun !== true && (lastSnapshotAskAt === 0 || Date.now() - lastSnapshotAskAt > SNAPSHOT_WARM_IDLE_MS)) return
    snapshot(true).catch(() => { /* 静默：失败时下次请求自然重试 */ })
  }
  if (typeof ctx.interval === 'function') {
    ctx.interval(() => warmSnapshot(false), SNAPSHOT_WARM_MS)
    // 开机先热一次：让"DSH 起来后的第一次打开面板"也能命中缓存
    Promise.resolve().then(() => warmSnapshot(true)).catch(() => {})
  }
  // 数据层有自己的缓存（与钉钉取数解耦：钉钉贵、读产物便宜）
  const pwbCache = { at: 0, data: null }
  // 待响应触发清单缓存（T32）：`/triggers` 要转调 CLI（起一个 node 进程）才能拿到
  // 冻结层算出的分组，不能每次渲染都跑。写路由（/trigger/respond）会主动清掉它。
  const triggerCache = { at: 0, data: null }
  // 「系统」卡开关的单实例守卫：写口只允许一次切换在途（连点两次不该并发跑两次 schtasks /run）。
  //   跨进程那一层由消费者自己的单实例锁兜底（`im-event-consume.lock`），两层不重复。
  let systemSwitchBusy = false

  // ── 关闭条件自动检测（2026-09-15 需求：每轮事务变动就自动检测可关闭项）────────
  // 触发：/state 发现事务指纹变化。约束：节流 60s、不并发、**尊重人工重开**
  //（被人工重开过的事务不再自动关闭 —— 人的决定优先于机械条件）。
  let lastMatterSig = ''
  let lastAutoCheckAt = 0
  let autoCheckBusy = false
  async function autoCheckMatters() {
    if (autoCheckBusy) return
    if (Date.now() - lastAutoCheckAt < AUTO_CHECK_MS) return
    autoCheckBusy = true
    lastAutoCheckAt = Date.now()
    try {
      const ovr = await readJson(PWB_MATTER_OVR)
      const reopened = new Set(((ovr && ovr.overrides) || [])
        .filter((o) => o && o.action === 'reopen')
        .map((o) => String(o.id)))
      const j = await runMatterCheck(['--all'])
      if (j.ok !== true) return
      const hits = (j.closable || []).filter((c) => c && !reopened.has(String(c.id)))
      if (hits.length === 0) return
      let closedCount = 0
      for (const c of hits) {
        const r = await closeMatterViaCli(c.id, c.note)
        if (r.ok === true) closedCount += 1
        ctx.logger?.info?.(`dsh-workdesktop: 关闭条件命中 ${c.id} → ${r.ok === true ? '已自动关闭并记录证据' : '关闭失败: ' + String(r.error || '')}`)
      }
      if (closedCount > 0) {
        pwbCache.data = null
        pwbCache.at = 0
      }
    } finally {
      autoCheckBusy = false
    }
  }

  // 周期触发（定时检测点）：与「事务指纹变化」的事件触发互补 ——
  //   · 事件触发：事务新增/调整时（/state 发现指纹变化）
  //   · 周期触发：产出物落盘时（没有任何事件会发生，只能靠定时扫）
  if (CHECK_INTERVAL_MS > 0) {
    ctx.effect(() => {
      const t = setInterval(() => { autoCheckMatters().catch(() => { /* 后台检测失败不影响主流程 */ }) }, CHECK_INTERVAL_MS)
      if (typeof t.unref === 'function') t.unref()   // 不阻止进程退出
      return () => { clearInterval(t) }
    })
  }

  /**
   * ★ 2026-09-21 修（真机 `SBT-SC2` 抓到的**真 bug**）：把「取消台账」也应用到 **`/snapshot` 载荷**。
   *
   * 病灶（两轮真机实测 + 台账取证）：日程卡读的是 `/snapshot`（本文件 `collect()` **现场采的** dws 日历），
   *   而 `schedule-cancels.json` 此前**只在 `/state` 侧应用**（见 `workbenchState()` 里的 `applyScheduleCancels`）
   *   ⇒ 面板点 ✕ 之后：**台账确实写了**（实测 `schedule-cancels.json` 新增 `trip|trip-…`），
   *   但日程卡那一行**永远不消失**（两轮实测：7 行 → 点取消 → 20 秒后仍 7 行）。
   *
   * 修法：**复用同一个纯函数** `applyScheduleCancels()` 在这里再应用一次 —— 不另写一套判据，
   *   于是 `/snapshot` 与 `/state` 的日历**同源同口径**（卡头计数 == 列表条数），
   *   `cancelled` 直接成为面板「恢复」入口的数据源（`key` 原样回传给 `/schedule/act`）。
   * ⚠️ host 半体改动，**需重启 DSH 生效**；client 侧无需改动（它点完 ✕ 本来就会 `load(true)`
   *   重新拉 `/snapshot?force=1`，只是以前那份载荷没被过滤）。
   */
  async function snapshotWithCancels(data) {
    if (data === null || data === undefined || data.calendar === null || data.calendar === undefined) return data
    let cancels = []
    try {
      const doc = await readJson(PWB_SCHED_CANCELS)
      cancels = (doc && Array.isArray(doc.cancels)) ? doc.cancels : []
    } catch { cancels = [] }
    if (cancels.length === 0) return data
    const cal = data.calendar
    const events = []
      .concat(Array.isArray(cal.today) ? cal.today : [])
      .concat(Array.isArray(cal.tomorrow) ? cal.tomorrow : [])
      .concat(Array.isArray(cal.days) ? cal.days.flatMap((d) => (d && Array.isArray(d.items) ? d.items : [])) : [])
    const view = applyScheduleCancels(events, cancels, new Date())
    return Object.assign({}, data, {
      calendar: Object.assign({}, cal, {
        days: view.days, today: view.today, tomorrow: view.tomorrow, counts: view.counts, cancelled: view.cancelled,
      }),
    })
  }

  async function snapshot(force) {
    const fresh = cache.data !== null && Date.now() - cache.at < CACHE_MS
    if (force !== true && fresh) return cache.data
    if (cache.inflight !== null) return cache.inflight
    const pending = collect()
      .then(snapshotWithCancels)
      .then((data) => { cache.data = data; cache.at = Date.now(); return data })
      .catch((e) => ({ ok: false, error: String((e && e.message) || e) }))
      .finally(() => { cache.inflight = null })
    cache.inflight = pending
    return pending
  }

  async function state(force) {
    if (force !== true && pwbCache.data !== null && Date.now() - pwbCache.at < PWB_CACHE_MS) return pwbCache.data
    const data = await workbenchState().catch((e) => ({ ok: false, error: String((e && e.message) || e) }))
    pwbCache.data = data
    pwbCache.at = Date.now()
    // 事务变动（新增/调整/状态变化）→ 每轮变动自动检测一次可关闭的事务（节流 + 不并发）
    if (typeof data.matterSig === 'string' && data.matterSig.length > 0 && data.matterSig !== lastMatterSig) {
      lastMatterSig = data.matterSig
      autoCheckMatters().catch(() => { /* 后台检测失败不影响读数 */ })
    }
    return data
  }

  // ── B 块：活跃关注域 —— 自动读会话（会话标题 + 近期用户消息）→ 库内 CLI 匹配 ──
  const sessionQuery = ctx.get('sessionQuery')
  const agentsSvc = ctx.get('agents')

  /** 读指定会话的标题与近期用户消息文本（读不到则返回 null） */
  async function readSessionText(sessionId) {
    if (sessionQuery === undefined || !sessionId) return null
    try {
      const titleSnap = await sessionQuery.readTitleSnapshot(sessionId).catch(() => null)
      const title = titleSnap?.title?.title ?? null
      const surf = await sessionQuery.readSurface(sessionId).catch(() => null)
      const texts = []
      // ── 2026-09-16（D1）：提取改为**多形态兼容 + 自带诊断** ─────────────────
      //    起因：真机实测 `scannedChars: 0` —— 面板与工具两条路径都读不到消息文本，
      //    自动匹配只能靠标题（"建议"因此很薄）。原实现把事件类型写死成 `user/message`
      //    且只认 `data.message.content[].text` 一种形态 ⇒ 形态一变就**静默扫零**。
      //    现在：① 事件类型不再写死（能识别 message/role 即取）；
      //         ② 兼容 message.content / content / parts / blocks / text 五种形态；
      //         ③ 把真实事件类型分布写进输入文件的 `diagnostics` ——
      //            下次真机一跑就知道形态，不靠猜。
      const eventTypes = {}
      let textBlocks = 0
      const pushText = (v) => { if (typeof v === 'string' && v.trim()) { texts.push(v); textBlocks++ } }
      const harvestBlocks = (blocks) => {
        if (!Array.isArray(blocks)) return
        for (const b of blocks) {
          if (!b) continue
          if (typeof b === 'string') { pushText(b); continue }
          if (b.type === 'text' || b.kind === 'text' || typeof b.text === 'string') pushText(b.text ?? b.value ?? b.content)
          else if (Array.isArray(b.content)) harvestBlocks(b.content)
        }
      }
      if (surf && Array.isArray(surf.events)) {
        for (const ev of surf.events) {
          if (!ev || typeof ev !== 'object') continue
          const t = String(ev.type ?? ev.kind ?? '(none)')
          eventTypes[t] = (eventTypes[t] ?? 0) + 1
          const role = String(ev?.data?.message?.role ?? ev?.data?.role ?? ev?.role ?? '')
          if (!/message/.test(t) && !/user|human|assistant/.test(role)) continue
          const d = ev.data ?? {}
          harvestBlocks(d?.message?.content)
          harvestBlocks(d?.content)
          harvestBlocks(d?.parts)
          harvestBlocks(d?.blocks)
          if (typeof d?.text === 'string') pushText(d.text)
          if (typeof ev.text === 'string') pushText(ev.text)
        }
      }
      return {
        sessionId: String(sessionId),
        title: title ?? '',
        texts: texts.slice(-24),
        diagnostics: {
          at: new Date().toISOString(),
          eventTotal: Array.isArray(surf?.events) ? surf.events.length : 0,
          eventTypes,
          textBlocks,
          surfaceKeys: surf && typeof surf === 'object' ? Object.keys(surf).slice(0, 12) : [],
        },
      }
    } catch (e) { return null }
  }

  /** 取一个可匹配的会话：优先「最近有用户活动」的会话（事件驱动），否则当前发起者 / 最新 live 会话 */
  async function pickSessionId() {
    if (lastActivity.sessionId !== null) return lastActivity.sessionId
    if (agentsSvc !== undefined) {
      try { const init = agentsSvc.currentInitiator()?.id ?? null; if (init) return init } catch (e) { /* 忽略 */ }
    }
    try {
      const list = await sessionQuery.listSessions()
      const live = list.find((r) => r && r.live === true) ?? list[0]
      return live?.header?.id ?? null
    } catch (e) { return null }
  }

  // ── 事件驱动（T25 评估结论：实现）：api-session/activity 每次用户消息都触发（unscoped + sessionId）──
  // 尾随去抖 15 秒 + 单飞：消息流中只做一次重匹配；轮询兜底（/state）保留给"启动后无活动"的场景。
  const lastActivity = { sessionId: null, updatedAt: 0 }
  let adDebounceTimer = null
  const AD_DEBOUNCE_MS = 15000
  function scheduleAdMatch() {
    if (adDebounceTimer !== null) clearTimeout(adDebounceTimer)
    adDebounceTimer = setTimeout(() => {
      adDebounceTimer = null
      matchActiveDomains(true).catch(() => {})
    }, AD_DEBOUNCE_MS)
  }
  ctx.effect(() => {
    const off = ctx.on('api-session/activity', (sessionId) => {
      lastActivity.sessionId = sessionId
      lastActivity.updatedAt = Date.now()
      scheduleAdMatch()
    })
    return () => {
      if (typeof off === 'function') off()
      if (adDebounceTimer !== null) { clearTimeout(adDebounceTimer); adDebounceTimer = null }
    }
  })

  // ── 实时活动追踪（2026-09-15 需求）：包住每次工具派发，期间即"正在调用/操作" ──
  // waterfall 语义：必须调用并返回 next() —— 本层绝不改写结果，只在前后记状态。
  ctxTools = ctx.get('tools')
  ctx.effect(() => {
    const off = ctx.on('tools/execute', async (exec, next) => {
      const name = String((exec && (exec.name || exec.toolName)) || '')
      if (name.length === 0) return next()
      const c = classifyTool(name)
      const id = (exec && (exec.callId || exec.id)) || `${name}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`
      activity.active.set(String(id), { name, kind: c.kind, label: c.label, tool: c.tool, startedAt: Date.now() })
      try {
        return await next()
      } finally {
        activity.active.delete(String(id))
        activity.recent.unshift({ name, kind: c.kind, label: c.label, endedAt: Date.now() })
        if (activity.recent.length > 10) activity.recent.length = 10
      }
    })
    return () => { if (typeof off === 'function') off() }
  })

  const adCache = { at: 0, data: null, inflight: null }
  async function matchActiveDomains(force) {
    const fresh = adCache.data !== null && Date.now() - adCache.at < AD_MATCH_MS
    if (force !== true && fresh) return adCache.data
    if (adCache.inflight !== null) return adCache.inflight
    const pending = (async () => {
      const session = await readSessionText(await pickSessionId())
      if (session === null) return { ok: false, error: '当前进程没有可读的会话（sessionQuery 不可用或会话列表为空）' }
      await writeFile(PWB_AD_INPUT, JSON.stringify(session), 'utf8')
      const r = await run(NODE, [PWB_AD_CLI, 'match', '--input', PWB_AD_INPUT], 30000)
      const j = parseJsonLoose(r.stdout)
      return j ?? { ok: false, error: String(r.error || r.stderr || 'no output').slice(0, 300) }
    })()
      .then((data) => { adCache.data = data; adCache.at = Date.now(); return data })
      .catch((e) => ({ ok: false, error: String((e && e.message) || e) }))
      .finally(() => { adCache.inflight = null })
    adCache.inflight = pending
    return pending
  }

  // ── DSH 工具：专注块入口（与面板按钮共用 cli-focus.mjs 这**一条**写通道）──
  // 2026-09-14 裁定「专注块入口两个都要用」：面板按钮（/focus 路由）+ 本工具。
  // 工具只做「调用 CLI + 回传 JSON」，不复制任何专注逻辑（P2 一个真相源）。
  const tools = ctx.get('tools')
  if (tools !== undefined) {
    // ── DSH 工具：个人待办（待办卡「个人」源）──
    // 用户 2026-09-16 口径：「待办的个人匹配的是**手动创建的**或者**在 dsh 会话中创建的**」
    //   ⇒ 手动 = 直接往 `Other/Todo/` 放文件；会话内 = 本工具（落到同一个真相源与同一条 CLI）。
    // 工具只做「调用 CLI + 回传 JSON」，不复制任何逻辑（P2 一个真相源）。
    ctx.effect(() => tools.register({
      name: 'workbench_todo',
      description: '个人工作台「待办」卡·个人源入口：add 新建个人待办 / list 列出未完成 / '
        + 'done 标记完成（= 已关闭，此后不再出现在待办里）/ reopen 重新打开。'
        + '写操作经由库内 cli-todo.mjs —— 与"手动往 Other/Todo/ 放文件"是同一个真相源。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'list', 'done', 'reopen'], description: 'add=新建 · list=列出未完成 · done=标记完成（视为已关闭）· reopen=重新打开' },
          title: { type: 'string', description: 'add 必填：待办标题' },
          due: { type: 'string', description: '截止日期（YYYY-MM-DD，可选）' },
          id: { type: 'string', description: 'done/reopen 必填：待办 id（如 PD-20260916-001）' },
          note: { type: 'string', description: '备注（add）/ 完成说明（done），可选' },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
      },
      timeoutMs: 30000,
      async execute(args) {
        const action = String(args.action || 'list')
        let argv = ['list']
        if (action === 'add') {
          const title = String(args.title || '').trim()
          if (title.length === 0) return { ok: false, error: 'add 需要 title' }
          argv = ['add', '--title', title.slice(0, 200), '--source', 'dsh-session', '--origin', 'agent:workbench_todo（会话内创建）']
          if (typeof args.due === 'string' && args.due.trim()) argv.push('--due', args.due.trim())
          if (typeof args.note === 'string' && args.note.trim()) argv.push('--note', args.note.trim().slice(0, 500))
        } else if (action === 'done' || action === 'reopen') {
          const id = String(args.id || '').trim()
          if (id.length === 0) return { ok: false, error: `${action} 需要 id` }
          argv = [action, '--id', id]
          if (action === 'done' && typeof args.note === 'string' && args.note.trim()) argv.push('--note', args.note.trim().slice(0, 500))
        }
        const r = await run(NODE, [PWB_TODO_CLI, ...argv], 30000)
        return parseJsonLoose(r.stdout) ?? { ok: false, error: String(r.error || r.stderr || 'no output').slice(0, 300) }
      },
    }))
    ctx.effect(() => tools.register({
      name: 'workbench_focus',
      description: '个人工作台「专注块」入口（C1 收敛）：declare 声明专注 / end 结束当前专注 / status 查看状态。'
        + '声明专注后，工作台只把「块期间新到达且命中专注目标」的流入穿透到右栏第 1 级，其余静默入队不打扰。'
        + '写操作经由库内 cli-focus.mjs（与面板按钮同一通道，单真相源）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['declare', 'end', 'status'], description: 'declare=声明专注（另需 kind/id） · end=结束当前专注 · status=查看状态' },
          kind: { type: 'string', enum: ['domain', 'project', 'matter'], description: '专注目标类型（declare 时必填）：domain=关注域 · project=项目 · matter=具体事务' },
          id: { type: 'string', description: '专注目标 id（declare 时必填）：关注域 id（如 example-domain）/ 项目路径 / 事务 id' },
          label: { type: 'string', description: '专注目标显示名（可选，默认取 id）' },
          minutes: { type: 'number', description: '计划专注分钟数（1–480，默认 50）' },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
      },
      timeoutMs: 30000,
      async execute(args) {
        let argv = ['status']
        if (args.action === 'declare') {
          argv = ['declare', '--kind', String(args.kind || 'domain'), '--id', String(args.id || '').trim(), '--minutes', String(args.minutes ?? 50)]
          if (typeof args.label === 'string' && args.label.trim().length > 0) argv.push('--label', args.label.trim().slice(0, 40))
        } else if (args.action === 'end') {
          argv = ['end']
        }
        const r = await run(NODE, [PWB_FOCUS_CLI, ...argv], 30000)
        return parseJsonLoose(r.stdout) ?? { ok: false, error: String(r.error || r.stderr || 'no output').slice(0, 300) }
      },
    }))

    /**
     * 活跃关注域的**唯一动作入口**（2026-09-17 提取 · 单真相源）：
     * DSH 工具 `workbench_active_domains` 与面板 `POST /active-domains` **共用这一份实现**——
     * 判据与副作用只有一处；host 内**不新增任何判定**：declare/clear 一律经库内
     * `cli-active-domains.mjs`（与面板按钮、agent 工具同一通道）。
     * @param {{action?:string, domains?:Array<{id:string,label?:string}>, note?:string}} args
     */
    async function activeDomainsAction(args) {
      const a = args || {}
      if (a.action === 'declare') {
        const domains = Array.isArray(a.domains) ? a.domains : null
        if (!domains || domains.length === 0 || !domains.every((d) => d && typeof d.id === 'string')) {
          return { ok: false, error: 'declare 需要 domains 数组，每项 {id, label?}' }
        }
        const argv = ['declare', '--domains', JSON.stringify(domains.map((d) => ({ id: String(d.id), label: String(d.label ?? d.id) })))]
        if (typeof a.note === 'string' && a.note.trim()) argv.push('--note', a.note.trim().slice(0, 200))
        const r = await run(NODE, [PWB_AD_CLI, ...argv], 30000)
        return parseJsonLoose(r.stdout) ?? { ok: false, error: String(r.error || r.stderr || 'no output').slice(0, 300) }
      }
      if (a.action === 'clear') {
        const r = await run(NODE, [PWB_AD_CLI, 'clear'], 30000)
        return parseJsonLoose(r.stdout) ?? { ok: false, error: String(r.error || r.stderr || 'no output').slice(0, 300) }
      }
      if (a.action === 'match-now') return await matchActiveDomains(true)
      return await readJson(PWB_AD_DOC) ?? { ok: true, empty: true, effective: [] }
    }

    // ── DSH 工具：活跃关注域（B 块 2026-09-14 裁定 ②「两者都要」）──
    // ① match-now = **自动读当前会话**（标题 + 近期用户消息）→ 库内匹配关注域注册表；
    // ② declare/clear = **agent 主动声明覆盖**（声明期间 effective 只取声明，auto 保留展示）。
    ctx.effect(() => tools.register({
      name: 'workbench_active_domains',
      description: '个人工作台「活跃关注域」（B 块）：把当前 agent 会话动态匹配到关注域注册表。'
        + 'match-now 自动读当前会话（标题+近期消息）并匹配；declare 由 agent 主动声明本会话相关的关注域（覆盖自动匹配）；'
        + 'clear 撤销声明回到自动匹配；status 查看当前结果。写操作经由库内 cli-active-domains.mjs（与面板同一通道）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'match-now', 'declare', 'clear'], description: 'status=查看 · match-now=自动读当前会话并匹配 · declare=声明覆盖（另需 domains） · clear=撤销声明' },
          domains: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } } }, description: 'declare 时：要声明的关注域列表 [{id,label}]（id 取注册表关注域 id）' },
          note: { type: 'string', description: 'declare 时的说明（可选）' },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
      },
      timeoutMs: 30000,
      async execute(args) {
        // 判据只有一处：与面板 `POST /active-domains` 共用 `activeDomainsAction()`（2026-09-17 提取）
        return await activeDomainsAction(args)
      },
    }))

    // ── DSH 工具：事务处置（C3 闭环 · 批次二第 ① 块）──
    // close/reopen 走库内 cli-matter.mjs（与面板按钮同一通道，单真相源）；
    // M7d 机制在库内强制：过期事务关闭必须带结束反馈记录。
    ctx.effect(() => tools.register({
      name: 'workbench_matter',
      description: '个人工作台「事务」入口（C3 闭环）：add 新增事务 / close 关闭 / reopen 重新打开 / '
        + 'overdue 列出已过期未关闭的事务 / status 查看单个事务。'
        + '**add 必须遵守 `02-规范与标准/SPEC_会话新增事务.md`**：'
        + '① 查重（给 dedup_key / origin_inbound / 具体 source_ref，命中即幂等返回既有 id，不新建）；'
        + '② 不要自己编号（系统原子预留 MT-M-###）；③ domain 必须已在 domains.yml 且 active；'
        + '④ done_when 必须可机器求值（含路径/产出物/编号/计数/可观测状态，禁用"完成即可/尽快"）；'
        + '⑤ 至少一条**具体**溯源（只有 origin_project 目录级不算）；⑥ 新增后可跑 cli-matter-check 自检。'
        + '过期事务的关闭必须带 note（结束反馈记录）—— 由库内 M7d 机制强制。'
        + '写操作经由库内 cli-matter.mjs（与面板按钮同一通道，单真相源）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'close', 'reopen', 'overdue', 'status'], description: 'add=新增（按 SPEC 受理）· close=关闭（过期事务必须带 note）· reopen=重新打开 · overdue=列出已过期未关闭事务 · status=查看单个事务' },
          id: { type: 'string', description: '事务 id（close/reopen/status 时必填，如 MT-20260826-106；add 时留空则系统预留 MT-M-###）' },
          note: { type: 'string', description: '关闭时的结束反馈记录（1–1000 字；**过期事务必填**，否则被 M7d 拒绝）' },
          title: { type: 'string', description: 'add 必填：标题，形如「示例客户A-0913 · 场次配置单」' },
          domain: { type: 'string', description: 'add 必填：关注域 id（须已在 domains.yml 且 status: active）' },
          done_when: { type: 'string', description: 'add 必填：关闭条件（可机器求值，例「Work/<客户>/Output/场次/X 出现 00-场次配置单.md」）' },
          origin_inbound: { type: 'string', description: 'add：流入 id（如 IN-20260913-001）——同时充当去重键' },
          origin_project: { type: 'string', description: 'add：项目/场次锚点目录（**单独给不算具体溯源**，需配 source_ref 或 origin_inbound）' },
          source_ref: { type: 'string', description: 'add：具体依据（听记/纪要路径、PC-候选编号、带 #步骤 的产出物）' },
          dedup_key: { type: 'string', description: 'add：外部事件的去重键，建议 <source>:<外部 id>（如 dingtalk:task-88231）' },
          due: { type: 'string', description: 'add：截止日 YYYY-MM-DD 或 ISO（尽量填；确实无日期才留空）' },
          direction: { type: 'string', enum: ['mine', 'theirs'], description: 'add：mine=我欠 / theirs=别人欠我（默认 mine）' },
          counterparty: { type: 'string', description: 'add：相对方（默认「我」）' },
          allow_duplicate: { type: 'boolean', description: 'add：确实与既有事务是两件事时置 true —— 必须同时给 reason' },
          reason: { type: 'string', description: 'add：放行重复的理由（写入登记表，可审计）' },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
      },
      timeoutMs: 30000,
      async execute(args) {
        const act = String(args.action || 'overdue')
        if (act === 'add') {
          // 受理判据一律在库内（`matter-intake.mjs`），host 只做**参数转递**与错误透传 ——
          // 在 host 里再写一份规则会让 CLI 与工具长出两套判据（T2 已认定过这类分叉）。
          const title = String(args.title || '').trim()
          const domain = String(args.domain || '').trim()
          const doneWhen = String(args.done_when || '').trim()
          if (title.length === 0) return { ok: false, error: 'add 需要 title（形如「对象 · 动作」）' }
          if (domain.length === 0) return { ok: false, error: 'add 需要 domain（须已在 domains.yml 且 active）' }
          if (doneWhen.length === 0) return { ok: false, error: 'add 需要 done_when（可机器求值的关闭条件）' }
          const argv = ['add', '--title', title.slice(0, 200), '--domain', domain, '--done-when', doneWhen]
          const push = (flag, v) => { const s = String(v || '').trim(); if (s.length > 0) argv.push(flag, s) }
          push('--id', args.id)
          push('--origin-inbound', args.origin_inbound)
          push('--origin-project', args.origin_project)
          push('--ref', args.source_ref)
          push('--dedup-key', args.dedup_key)
          push('--due', args.due)
          push('--direction', args.direction)
          push('--counterparty', args.counterparty)
          if (args.allow_duplicate === true) {
            const why = String(args.reason || '').trim()
            if (why.length === 0) return { ok: false, error: 'allow_duplicate 必须同时给 reason（为什么确实是两件事）；没有理由不放行' }
            argv.push('--allow-duplicate', '--reason', why.slice(0, 300))
          }
          const r = await run(NODE, [PWB_MATTER_CLI, ...argv], 30000)
          const parsed = parseJsonLoose(r.stdout)
          // 受理被拒时 CLI 输出的是**多行文本**（含 [错误码] 与「下一步」）⇒ 原样透传给会话，别吞掉
          if (parsed === null) return { ok: false, error: String(r.stdout || r.error || r.stderr || 'no output').trim().slice(0, 2000) }
          return parsed
        }
        let argv = ['overdue']
        if (act === 'close') {
          const id = String(args.id || '').trim()
          if (id.length === 0) return { ok: false, error: 'close 需要 id' }
          argv = ['close', '--id', id]
          if (typeof args.note === 'string' && args.note.trim().length > 0) argv.push('--note', args.note.trim().slice(0, 1000))
        } else if (act === 'reopen') {
          const id = String(args.id || '').trim()
          if (id.length === 0) return { ok: false, error: 'reopen 需要 id' }
          argv = ['reopen', '--id', id]
        } else if (act === 'status') {
          const id = String(args.id || '').trim()
          if (id.length === 0) return { ok: false, error: 'status 需要 id' }
          argv = ['status', '--id', id]
        }
        const r = await run(NODE, [PWB_MATTER_CLI, ...argv], 30000)
        return parseJsonLoose(r.stdout) ?? { ok: false, error: String(r.error || r.stderr || 'no output').slice(0, 300) }
      },
    }))

    /* ── DSH 工具：工程图（Project Graph）────────────────────────────────────
     * 一个入口，把**上游那 29 个内置工具**原样开给会话 —— 不重命名、不改语义、
     * 不加本插件自己的判定。所以"上游能做的"与"会话里能做的"是同一集合：
     *   建（expand_node_tree_from_node / breadth·depth_expand_node / create_edges）
     *   改（edit_text_node / edit_image_node / change_edge_text / batch_change_color / auto_layout_dag）
     *   删（delete_node / delete_nodes / delete_all_nodes）
     *   读（get_all_nodes / search_text_nodes_by_regex / get_children / get_parents / get_object_details / check_connections）
     * 用法固定三步：`tools` 看清单 → `describe` 看某条的入参 schema → `invoke` 执行。
     * ⚠️ 需要打开态的 10 条（`create_text_node` 等）在关闭态会被上游拒绝，
     *    错误码 `PROJECT_MUST_BE_OPEN` 原样回传 —— 本工具不改写、不吞掉。
     */
    ctx.effect(() => tools.register({
      name: 'project_graph',
      description: '「工程图」（Project Graph）入口 —— 用 DSH 会话直接建 / 改 / 删本机工程图里的内容。'
        + '工程 = 一个 .prg 文件（工作区见 action=status 的 projectsDir）。'
        + '读：action=projects 列工程 · action=tools 列上游全部内置工具 · action=describe 看某条的入参 schema '
        + '· action=graph 取一张图的节点与连线。'
        + '写：action=invoke 执行任意一条上游内置工具（tool/input 原样透传）；'
        + 'action=create 建空工程 · action=rename / action=delete 改删工程文件本身。'
        + '新工程自带一个根节点（ref=n1）；关闭态下"加节点"用 expand_node_tree_from_node（ref=n1 + 缩进文本）。'
        + '正确顺序：先 tools 或 describe 拿到准确入参，再 invoke —— 本工具不做任何参数改写。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'projects', 'create', 'rename', 'delete', 'tools', 'describe', 'invoke', 'graph', 'open'],
            description: 'status=可用性自检 · projects=列工程 · create/rename/delete=工程文件 · '
              + 'tools=上游工具清单 · describe=某条工具的 schema · invoke=执行工具 · graph=取节点 · open=把面板弹出来',
          },
          project: { type: 'string', description: '工程名（可省 .prg）或绝对路径。invoke / graph 必填' },
          to: { type: 'string', description: 'rename 的目标工程名' },
          tool: { type: 'string', description: 'invoke / describe 用的上游工具名（如 expand_node_tree_from_node、edit_text_node、delete_node、auto_layout_dag）' },
          input: { type: 'object', description: 'invoke 的入参对象，**原样**交给上游（键名以 action=describe 的 schema 为准）', additionalProperties: true },
          allowUpgrade: { type: 'boolean', description: 'invoke 时允许上游对旧版本工程做升级迁移（默认否；遇到 PROJECT_UPGRADE_REQUIRED 时可置真重试）' },
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
      },
      timeoutMs: 240000,
      async execute(args) {
        const action = String((args && args.action) || 'status')
        if (action === 'status') return await pgStatus()
        if (action === 'projects') return { ok: true, projectsDir: PG_PROJECTS, projects: await pgListProjects() }
        if (action === 'create') {
          try {
            const target = pgProjectPath(args.project)
            if (existsSync(target)) return { ok: false, error: `工程已存在：${target}` }
            const seed = await pgEnsureSeed()
            if (seed.ok !== true) return seed
            const { copyFile } = await import('node:fs/promises')
            await mkdir(PG_PROJECTS, { recursive: true })
            await copyFile(seed.seed, target)
            // 立刻分一次引用：这样"新工程自带根节点 n1"是真的契约，而不是等第一次读才有。
            await pgEnsureReferences(target)
            pgPushEvent('projects', {})
            return { ok: true, project: target, name: target.split('\\').pop(), note: '空工程已建好，自带根节点 n1；接着用 action=invoke + expand_node_tree_from_node 往里加内容' }
          } catch (error) { return { ok: false, error: String((error && error.message) || error) } }
        }
        if (action === 'rename' || action === 'delete') {
          try {
            const from = pgProjectPath(args.project)
            if (!existsSync(from)) return { ok: false, error: `没有这个工程：${from}` }
            if (action === 'delete') {
              await rm(from, { force: true })
              pgPushEvent('projects', {})
              return { ok: true, deleted: from }
            }
            const to = pgProjectPath(args.to)
            if (existsSync(to)) return { ok: false, error: `目标已存在：${to}` }
            const { rename } = await import('node:fs/promises')
            await rename(from, to)
            pgPushEvent('projects', {})
            return { ok: true, project: to }
          } catch (error) { return { ok: false, error: String((error && error.message) || error) } }
        }
        if (action === 'tools') {
          const catalog = await pgLoadCatalog()
          if (catalog === null) return { ok: false, error: '取不到上游工具清单（见 action=status）' }
          return {
            ok: true,
            count: catalog.length,
            tools: catalog.map((t) => ({ name: t && t.name, description: t && t.description })),
            note: '入参 schema 用 action=describe 取',
          }
        }
        if (action === 'describe') return await pgDescribeTool(args.tool)
        if (action === 'graph') {
          const r = await pgInvoke('get_all_nodes', args.project, {}, false)
          if (r.ok !== true) return r
          return {
            ok: true,
            project: String(args.project || ''),
            objects: (r.value && Array.isArray(r.value.objects)) ? r.value.objects : [],
          }
        }
        if (action === 'open') {
          pgPushEvent('open', { project: String(args.project || '') })
          return { ok: true, opened: true, project: String(args.project || '') }
        }
        if (action === 'invoke') {
          const result = await pgInvoke(args.tool, args.project, args.input, args.allowUpgrade === true)
          if (result.ok === true) pgPushEvent('graph', { project: String(args.project || '') })
          return result
        }
        return { ok: false, error: `不认识的动作：${action}` }
      },
    }))
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: async (req, res) => {
      let url
      try { url = new URL(req.url || '/', 'http://127.0.0.1') } catch { sendJson(res, 400, { error: 'bad url' }); return }
      const path = url.pathname.slice(ROUTE.length)

      if (path === '/snapshot') {
        // 记下"有人要过快照" —— 后台预热据此判断"现在有人在看面板吗"（15 分钟没人看就不白跑）
        lastSnapshotAskAt = Date.now()
        sendJson(res, 200, await snapshot(url.searchParams.get('force') === '1'))
        return
      }

      /* ── 工程图（Project Graph）─────────────────────────────────────────────
       * 全部走**上游 CLI**：本插件不复制图模型、不自己判定能不能做某个动作。
       * 面板（浏览器半段）与 agent 工具（project_graph）共用这一组路由，
       * 所以"面板上能做的"与"会话里能做的"是同一批动作。
       */
      if (path === '/pg/status' && req.method === 'GET') {
        sendJson(res, 200, await pgStatus())
        return
      }

      if (path === '/pg/projects' && req.method === 'GET') {
        const projects = await pgListProjects()
        sendJson(res, 200, { ok: true, projectsDir: PG_PROJECTS, projects })
        return
      }

      // 工程的新建 / 改名 / 删除。**这是本插件唯一自己写盘的地方**（只碰 .prg 文件本身，
      // 不动图内容）：新建 = 复制空模板，改名 / 删除 = 文件系统操作。
      if (path === '/pg/project' && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        const action = String(body.action || '')
        try {
          if (action === 'create') {
            const target = pgProjectPath(body.name)
            if (existsSync(target)) { sendJson(res, 200, { ok: false, error: `工程已存在：${target}` }); return }
            const seed = await pgEnsureSeed()
            if (seed.ok !== true) { sendJson(res, 200, seed); return }
            const { copyFile } = await import('node:fs/promises')
            await mkdir(PG_PROJECTS, { recursive: true })
            await copyFile(seed.seed, target)
            // 立刻分一次引用：这样"新工程自带根节点 n1"是真的契约，而不是等第一次读才有。
            await pgEnsureReferences(target)
            pgPushEvent('projects', {})
            sendJson(res, 200, { ok: true, project: target, name: target.split('\\').pop() })
            return
          }
          if (action === 'rename') {
            const from = pgProjectPath(body.name)
            const to = pgProjectPath(body.to)
            if (!existsSync(from)) { sendJson(res, 200, { ok: false, error: `没有这个工程：${from}` }); return }
            if (existsSync(to)) { sendJson(res, 200, { ok: false, error: `目标已存在：${to}` }); return }
            const { rename } = await import('node:fs/promises')
            await rename(from, to)
            pgPushEvent('projects', {})
            sendJson(res, 200, { ok: true, project: to })
            return
          }
          if (action === 'delete') {
            const target = pgProjectPath(body.name)
            if (!existsSync(target)) { sendJson(res, 200, { ok: false, error: `没有这个工程：${target}` }); return }
            await rm(target, { force: true })
            pgPushEvent('projects', {})
            sendJson(res, 200, { ok: true, deleted: target })
            return
          }
          sendJson(res, 200, { ok: false, error: `不认识的动作：${action}（可用 create / rename / delete）` })
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String((error && error.message) || error) })
        }
        return
      }

      // 上游内置工具目录（29 条）：慢（tsx 冷启动），所以进程内缓存一次。
      if (path === '/pg/tools' && req.method === 'GET') {
        const catalog = await pgLoadCatalog()
        if (catalog === null) {
          sendJson(res, 200, { ok: false, error: '取不到上游工具清单（先看 /pg/status）' })
          return
        }
        sendJson(res, 200, { ok: true, tools: catalog })
        return
      }

      if (path === '/pg/tool' && req.method === 'GET') {
        sendJson(res, 200, await pgDescribeTool(url.searchParams.get('name')))
        return
      }

      // 调一条内置工具 —— 面板按钮与 agent 工具 project_graph 都走这里。
      if (path === '/pg/invoke' && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        const result = await pgInvoke(body.tool, body.project, body.input, body.allowUpgrade === true)
        if (result.ok === true) pgPushEvent('graph', { project: String(body.project || '') })
        sendJson(res, 200, result)
        return
      }

      // 一张图的节点 + 连线：直接从 `get_all_nodes` 取（上游把连线也作为 LineEdge 对象返回，
      // 带 sourceRef / targetRef），本插件不再自己拼一套。
      // 回执把上游的载荷**摊平**成 `objects`：面板与工具都只认这一个形状，
      // 免得每处各写一遍 `value.objects` 这种嵌套取法。
      if (path === '/pg/graph' && req.method === 'GET') {
        const project = String(url.searchParams.get('project') || '')
        let file = ''
        try { file = pgProjectPath(project) } catch { file = '' }
        if (file === '' || !existsSync(file)) {
          sendJson(res, 200, { ok: false, error: `没有这个工程：${project}`, code: 'PROJECT_NOT_FOUND' })
          return
        }
        const r = await pgInvoke('get_all_nodes', file, {}, false)
        if (r.ok !== true) { sendJson(res, 200, r); return }
        sendJson(res, 200, {
          ok: true,
          project: file,
          name: file.split('\\').pop(),
          objects: (r.value && Array.isArray(r.value.objects)) ? r.value.objects : [],
        })
        return
      }

      // ── 文档层（画布交互走这里）─────────────────────────────────────────
      // 上游 CLI 那一层只认引用（`n1`），一次只能动一个对象；画布拖动要一次动十几个、
      // 还要能删没有引用的对象、在任意位置新建。所以这几条直接读写 `.prg`。
      // ⚠️ 不经过上游的所有权锁：同一时刻只应有一个写者。
      if (path === '/pg/document' && req.method === 'GET') {
        const result = await pgDocumentSummary(String(url.searchParams.get('project') || ''))
        sendJson(res, 200, result)
        return
      }

      if (path === '/pg/locate' && req.method === 'GET') {
        const result = await pgLocate(String(url.searchParams.get('project') || ''))
        sendJson(res, 200, result)
        return
      }

      // 批量改几何：拖动的落点一次写盘。`moves: [{ uuid, x?, y?, width?, height? }]`
      if (path === '/pg/move' && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        const loaded = await pgDocLoad(body.project)
        if (loaded.ok !== true) { sendJson(res, 200, loaded); return }
        pgMarkUndo(loaded)
        const moves = Array.isArray(body.moves) ? body.moves : []
        if (moves.length === 0) { sendJson(res, 200, { ok: false, error: 'moves 为空' }); return }
        const before = new Map()
        for (const move of moves) {
          const object = loaded.stage.find((item) => item && item.uuid === move.uuid)
          if (object === undefined) continue
          before.set(move.uuid, pgSummarize(object, -1))
        }
        let moved
        try {
          moved = pgMoveBatch(loaded.stage, moves)
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String((error && error.message) || error) })
          return
        }
        const written = pgDocWrite(loaded)
        if (written.ok !== true) { sendJson(res, 200, written); return }
        const after = moves
          .map((move) => {
            const object = loaded.stage.find((item) => item && item.uuid === move.uuid)
            return object === undefined ? null : { uuid: move.uuid, ...pgSummarize(object, -1) }
          })
          .filter((item) => item !== null)
        pgPushEvent('graph', { project: String(body.project || ''), op: 'move' })
        sendJson(res, 200, {
          ok: true,
          moved: moved.moved,
          missing: moved.missing,
          bytes: written.bytes,
          objects: after.map((item) => ({
            uuid: item.uuid, type: item.type, location: item.location, size: item.size,
            before: before.has(item.uuid) ? { location: before.get(item.uuid).location, size: before.get(item.uuid).size } : null,
          })),
        })
        return
      }

      // 新建节点：**克隆文档里已有的 TextNode**（形状随版本走，不写死模板）
      if (path === '/pg/insert' && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        const loaded = await pgDocLoad(body.project)
        if (loaded.ok !== true) { sendJson(res, 200, loaded); return }
        pgMarkUndo(loaded)
        const specs = Array.isArray(body.nodes) ? body.nodes : [body.nodes || body]
        const made = []
        for (const spec of specs) {
          const node = pgMakeTextNode(loaded.stage, spec || {})
          if (node.ok !== true) { sendJson(res, 200, node); return }
          made.push(node.node)
        }
        let next
        try {
          next = pgInsertObjects(loaded.stage, made, body.at === undefined ? null : body.at)
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String((error && error.message) || error) })
          return
        }
        loaded.stage = next
        const written = pgDocWrite(loaded)
        if (written.ok !== true) { sendJson(res, 200, written); return }
        pgPushEvent('graph', { project: String(body.project || ''), op: 'insert' })
        sendJson(res, 200, {
          ok: true,
          bytes: written.bytes,
          created: made.map((node, index) => ({ uuid: node.uuid, text: node.text, index: next.indexOf(node), at: index })),
        })
        return
      }

      // 删除对象（按 uuid）：**连带删掉因此悬空的连线**（与上游 delete_node 的语义一致）
      if (path === '/pg/delete' && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        const loaded = await pgDocLoad(body.project)
        if (loaded.ok !== true) { sendJson(res, 200, loaded); return }
        pgMarkUndo(loaded)
        const uuids = Array.isArray(body.uuids) ? body.uuids.map(String) : []
        if (uuids.length === 0) { sendJson(res, 200, { ok: false, error: 'uuids 为空' }); return }
        const indexes = []
        const missing = []
        for (const uuid of uuids) {
          const index = loaded.stage.findIndex((object) => object && object.uuid === uuid)
          if (index < 0) { missing.push(uuid); continue }
          indexes.push(index)
        }
        if (indexes.length === 0) { sendJson(res, 200, { ok: false, error: '这些 uuid 一个都不在文档里', missing }); return }
        const beforeCount = loaded.stage.length
        let next
        try {
          next = pgRemoveWithEdges(loaded.stage, indexes)
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String((error && error.message) || error) })
          return
        }
        loaded.stage = next
        const written = pgDocWrite(loaded)
        if (written.ok !== true) { sendJson(res, 200, written); return }
        pgPushEvent('graph', { project: String(body.project || ''), op: 'delete' })
        sendJson(res, 200, {
          ok: true,
          bytes: written.bytes,
          removed: beforeCount - next.length,
          removedEdges: beforeCount - next.length - indexes.length,
          missing,
        })
        return
      }

      // 写详细信息（`details`）—— 规范说任何实体都可写，上游 29 条里没有这条
      if (path === '/pg/details' && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        const loaded = await pgDocLoad(body.project)
        if (loaded.ok !== true) { sendJson(res, 200, loaded); return }
        pgMarkUndo(loaded)
        const object = loaded.stage.find((item) => item && item.uuid === String(body.uuid || ''))
        if (object === undefined) { sendJson(res, 200, { ok: false, error: `没有这个 uuid：${body.uuid}` }); return }
        if (!Object.prototype.hasOwnProperty.call(object, 'details')) {
          sendJson(res, 200, { ok: false, error: `这个对象（${object._}）上没有 details 字段，拒绝新造一个` })
          return
        }
        const before = object.details
        object.details = body.value === undefined ? [] : body.value
        const written = pgDocWrite(loaded)
        if (written.ok !== true) { sendJson(res, 200, written); return }
        sendJson(res, 200, { ok: true, uuid: object.uuid, type: object._, before, after: object.details, bytes: written.bytes })
        return
      }

      // 改文本（按 uuid）—— 面板双击改名就走这条，不必绕上游 CLI（那条要 3~5 秒）
      if (path === '/pg/text' && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        const loaded = await pgDocLoad(body.project)
        if (loaded.ok !== true) { sendJson(res, 200, loaded); return }
        pgMarkUndo(loaded)
        const object = loaded.stage.find((item) => item && item.uuid === String(body.uuid || ''))
        if (object === undefined) { sendJson(res, 200, { ok: false, error: `没有这个 uuid：${body.uuid}` }); return }
        if (typeof object.text !== 'string') {
          sendJson(res, 200, { ok: false, error: `这个对象（${object._}）上没有 text 字段，拒绝新造一个` })
          return
        }
        const before = object.text
        object.text = String(body.text === undefined ? '' : body.text)
        const written = pgDocWrite(loaded)
        if (written.ok !== true) { sendJson(res, 200, written); return }
        pgPushEvent('graph', { project: String(body.project || ''), op: 'text' })
        sendJson(res, 200, { ok: true, uuid: object.uuid, type: object._, before, after: object.text, bytes: written.bytes })
        return
      }

      // ── 连线（P2：从节点拖出连线 / 拖端点改接线）────────────────────────
      // 新连线一律**追加在舞台末尾**：`insertObjects` 只在"插入点之后"重编号，
      // 追加时插入点 = 长度，什么都不动，所以新连线自己写的 `$`（指向已有实体的下标）
      // 天然是对的。插在中间就得连它自己的引用一起算，容易错。
      if (path === '/pg/connect' && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        const loaded = await pgDocLoad(body.project)
        if (loaded.ok !== true) { sendJson(res, 200, loaded); return }
        pgMarkUndo(loaded)
        const indexOf = (uuid) => loaded.stage.findIndex((o) => o && o.uuid === String(uuid || ''))
        const source = indexOf(body.source)
        const target = indexOf(body.target)
        if (source < 0) { sendJson(res, 200, { ok: false, error: `没有这个起点：${body.source}` }); return }
        if (target < 0) { sendJson(res, 200, { ok: false, error: `没有这个终点：${body.target}` }); return }
        if (source === target) { sendJson(res, 200, { ok: false, error: '起点和终点是同一个对象，拒绝连自环' }); return }
        const made = pgMakeEdge(loaded.stage, source, target, { text: body.text === undefined ? '' : body.text })
        if (made.ok !== true) { sendJson(res, 200, made); return }
        let next
        try {
          next = pgInsertObjects(loaded.stage, [made.edge], null)
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String((error && error.message) || error) })
          return
        }
        loaded.stage = next
        const written = pgDocWrite(loaded)
        if (written.ok !== true) { sendJson(res, 200, written); return }
        pgPushEvent('graph', { project: String(body.project || ''), op: 'connect' })
        sendJson(res, 200, {
          ok: true, uuid: made.edge.uuid, bytes: written.bytes,
          cloned: made.cloned, index: next.indexOf(made.edge),
        })
        return
      }

      // 拖端点改接线：只改这条连线内部的 `$`，不动数组 —— 所以不需要重编号（比插对象安全）
      if (path === '/pg/reconnect' && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        const loaded = await pgDocLoad(body.project)
        if (loaded.ok !== true) { sendJson(res, 200, loaded); return }
        pgMarkUndo(loaded)
        const result = pgReconnectEdge(loaded.stage, body.uuid, body.source, body.target)
        if (result.ok !== true) { sendJson(res, 200, result); return }
        loaded.stage = result.stage
        const written = pgDocWrite(loaded)
        if (written.ok !== true) { sendJson(res, 200, written); return }
        pgPushEvent('graph', { project: String(body.project || ''), op: 'reconnect' })
        sendJson(res, 200, { ok: true, uuid: String(body.uuid || ''), from: result.from, to: result.to, bytes: written.bytes })
        return
      }

      // ── 分区（P3：折叠展开 / 把对象拖进拖出分区）────────────────────────
      // 分区的开关只改字段；归入/拿出只在 `children` 里加/减一条 `{$:'/N'}` 引用 ——
      // **都不动舞台数组**，所以不需要重编号。
      if (path === '/pg/section' && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        const loaded = await pgDocLoad(body.project)
        if (loaded.ok !== true) { sendJson(res, 200, loaded); return }
        pgMarkUndo(loaded)
        // 建分区：把若干已有对象装进去。children 里写的是 {$:'/N'} 引用，
        // **不动舞台数组**，所以不需要重编号。
        if (body.create !== undefined && body.create !== null) {
          const made = pgMakeSection(loaded.stage, {
            text: body.create.text, children: body.create.children, borderStyle: body.create.borderStyle,
          })
          if (made.ok !== true) { sendJson(res, 200, made); return }
          let nextSection
          try {
            nextSection = pgInsertObjects(loaded.stage, [made.section], null)
          } catch (error) {
            sendJson(res, 200, { ok: false, error: String((error && error.message) || error) })
            return
          }
          loaded.stage = nextSection
          const w = pgDocWrite(loaded)
          if (w.ok !== true) { sendJson(res, 200, w); return }
          pgPushEvent('graph', { project: String(body.project || ''), op: 'section-create' })
          sendJson(res, 200, { ok: true, uuid: made.section.uuid, box: made.box, picked: made.childIndexes.length, bytes: w.bytes })
          return
        }
        const result = pgSetSectionFlags(loaded.stage, body.uuid, {
          collapsed: body.collapsed, locked: body.locked, borderStyle: body.borderStyle,
        })
        if (result.ok !== true) { sendJson(res, 200, result); return }
        loaded.stage = result.stage
        const written = pgDocWrite(loaded)
        if (written.ok !== true) { sendJson(res, 200, written); return }
        pgPushEvent('graph', { project: String(body.project || ''), op: 'section' })
        sendJson(res, 200, { ok: true, uuid: String(body.uuid || ''), applied: result.applied, state: result.state, bytes: written.bytes })
        return
      }

      // 归入分区 / 从分区拿出来：`section` 给 null 就是拿出来
      if (path === '/pg/reparent' && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        const loaded = await pgDocLoad(body.project)
        if (loaded.ok !== true) { sendJson(res, 200, loaded); return }
        pgMarkUndo(loaded)
        const child = body.child === undefined ? (Array.isArray(body.children) ? body.children[0] : undefined) : body.child
        const kids = Array.isArray(body.children) && body.children.length > 0 ? body.children : [child]
        let stage = loaded.stage
        const done = []
        for (const one of kids) {
          const result = pgSetParent(stage, one, body.section === undefined ? null : body.section)
          if (result.ok !== true) { sendJson(res, 200, result); return }
          stage = result.stage
          done.push({ uuid: String(one || ''), sectionIndex: result.sectionIndex, removedFrom: result.removedFrom })
        }
        loaded.stage = stage
        const written = pgDocWrite(loaded)
        if (written.ok !== true) { sendJson(res, 200, written); return }
        pgPushEvent('graph', { project: String(body.project || ''), op: 'reparent' })
        sendJson(res, 200, { ok: true, done, bytes: written.bytes })
        return
      }

      if ((path === '/pg/undo' || path === '/pg/redo') && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        sendJson(res, 200, pgUndoStep(body.project, path === '/pg/redo' ? 'redo' : 'undo'))
        return
      }

      if (path === '/pg/history' && req.method === 'GET') {
        let file = ''
        try { file = pgProjectPath(String(url.searchParams.get('project') || '')) } catch { file = '' }
        const entry = file === '' ? { past: [], future: [] } : pgUndoEntry(file)
        sendJson(res, 200, { ok: true, canUndo: entry.past.length > 0, canRedo: entry.future.length > 0, past: entry.past.length, future: entry.future.length })
        return
      }

      // 调层级：舞台数组的顺序就是绘制顺序（位移用置换改写引用下标，不产生孤儿引用）
      if (path === '/pg/reorder' && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        const loaded = await pgDocLoad(body.project)
        if (loaded.ok !== true) { sendJson(res, 200, loaded); return }
        pgMarkUndo(loaded)
        const result = pgReorderObject(loaded.stage, body.uuid, body.where)
        if (result.ok !== true) { sendJson(res, 200, result); return }
        loaded.stage = result.stage
        const written = pgDocWrite(loaded)
        if (written.ok !== true) { sendJson(res, 200, written); return }
        pgPushEvent('graph', { project: String(body.project || ''), op: 'reorder' })
        sendJson(res, 200, { ok: true, moved: result.moved, from: result.from, to: result.to, bytes: written.bytes })
        return
      }

      // 附件字节（图片节点要渲染）。id 是不带扩展名的 attachmentId。
      if (path === '/pg/attachment' && req.method === 'GET') {
        const project = String(url.searchParams.get('project') || '')
        const id = String(url.searchParams.get('id') || '')
        let file = ''
        try { file = pgProjectPath(project) } catch { file = '' }
        if (file === '' || !existsSync(file)) {
          sendJson(res, 200, { ok: false, error: `没有这个工程：${project}`, code: 'PROJECT_NOT_FOUND' })
          return
        }
        const got = pgReadAttachment(file, id)
        if (got.ok !== true) { sendJson(res, 200, got); return }
        res.writeHead(200, {
          'content-type': got.contentType,
          'content-length': got.data.length,
          // 附件按 id 寻址、内容不可变，可以长缓存
          'cache-control': 'private, max-age=3600',
        })
        res.end(got.data)
        return
      }
      if (path === '/pg/events' && req.method === 'GET') {
        const since = Number(url.searchParams.get('since') || 0)
        const list = pgEvents.list.filter((item) => item.rev > (Number.isFinite(since) ? since : 0))
        sendJson(res, 200, { rev: pgEvents.rev, events: list })
        return
      }

      // 让面板自己弹出来（与 agent 工具 project_graph action=open 同一条事件通道）。
      if (path === '/pg/open' && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        pgPushEvent('open', { project: String(body.project || '') })
        sendJson(res, 200, { ok: true, rev: pgEvents.rev })
        return
      }

      // ── 库内仪表盘（驾驶舱 HTML）：只读产物，供 better-sidebar「驾驶舱」tab 内嵌 ──
      // 自包含页面（零外链），故直接回 HTML；不缓存，重建后刷新即得新内容。
      if (path === '/dashboard' && req.method === 'GET') {
        let html = null
        try { html = await readFile(PWB_DASHBOARD, 'utf8') } catch { /* 尚未生成 */ }
        if (html === null) {
          sendJson(res, 200, { ok: false, error: '未找到 ' + PWB_DASHBOARD + ' —— 先运行库内的 build-snapshot.mjs' })
          return
        }
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(html),
        })
        res.end(html)
        return
      }

      if (path === '/event') {
        const id = url.searchParams.get('event') || ''
        if (id.length === 0 || /["\r\n]/.test(id)) { sendJson(res, 400, { ok: false, error: 'bad event id' }); return }
        const r = await ps(['-NoProfile', '-NonInteractive', '-Command', `dws calendar +attendee-list --event ${id}`], 60000)
        const out = r.stdout.includes('"attendees"') ? r.stdout : (r.stderr.includes('"attendees"') ? r.stderr : r.stdout)
        const j = parseJsonLoose(out)
        if (j === null) { sendJson(res, 200, { ok: false, error: String(r.error || r.stderr.trim() || 'no data').slice(0, 200) }); return }
        const attendees = (Array.isArray(j.attendees) ? j.attendees : []).map((a) => ({
          name: String((a && a.displayName) || ''),
          status: String((a && a.responseStatus) || ''),
        }))
        sendJson(res, 200, { ok: true, attendees })
        return
      }

      if (path === '/open' && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        const target = String(body.path || '')
        if (!target.startsWith(KNOWLEDGE)) { sendJson(res, 200, { ok: false, error: 'path not allowed' }); return }
        const safe = target.replace(/"/g, '')
        const r = await ps(['-NoProfile', '-NonInteractive', '-Command', `Invoke-Item -LiteralPath "${safe}"`], 30000)
        if (r.ok) { sendJson(res, 200, { ok: true, path: safe }); return }
        const dir = safe.slice(0, safe.lastIndexOf('\\'))
        const r2 = dir.length > 0 ? await ps(['-NoProfile', '-NonInteractive', '-Command', `Invoke-Item -LiteralPath "${dir}"`], 30000) : { ok: false }
        sendJson(res, 200, r2.ok ? { ok: true, path: safe, opened: 'folder' } : { ok: false, error: String(r.error || r.stderr.trim() || 'open failed') })
        return
      }

      // ── 底部系统在线状态（DWS / MCP / 本地工具 / 浏览器）──
      if (path === '/sysstatus') {
        sendJson(res, 200, await sysStatus(url.searchParams.get('force') === '1'))
        return
      }

      // ── 实时活动（免缓存：纯内存读，客户端 3s 轮询）──
      if (path === '/activity') {
        sendJson(res, 200, activitySnapshot())
        return
      }

      // ── 业务对象层产物（2026-09-16 · 只读透传，host 不加工）──
      //    /objects      对象索引（对象数组 + byRecord 查询表）→ **撤卡后仍是属性来源**：
      //                  事务卡行内 / 事务详情 / 流入未归属 / 洞察证据段 / 域下钻（2026-09-21 P2b）
      //    /disposition  处置台账（处置率 / 无落点清单 / 活跃域排序）→ 流入卡 / 指标卡
      //    /crosscheck   多源校验（溯源 / 支撑 / 计划↔实际 / 承诺↔交付 / 矛盾）→ 指标卡 / 待定夺区块
      //    /domain-health 域健康度（观察面 + 建议 + 域→对象下钻面）→ 活跃关注域卡
      if (path === '/assets') {
        // 「资产」卡一期（2026-09-23）：只读透传；未生成给 503 + 明确指引（卡面据此显示错误而非 0）
        const doc = await readJson(PWB_ASSETS)
        sendJson(res, doc ? 200 : 503, doc ?? { error: 'assets.json 尚未生成（跑 node <库内>/build-assets.mjs）' })
        return
      }
      if (path === '/assets/refresh' && req.method === 'POST') {
        // 动作按钮专用：重建 assets.json（stats+map ≈2–3s，**不走向量**）。
        // 失败必须显式回传（卡面显示原因），不得静默成功。
        const r = await run(NODE, [PWB_ASSETS_BUILD], 120000)
        const j = parseJsonLoose(r.stdout)
        const doc = await readJson(PWB_ASSETS)
        // ⚠️ 2026-09-23 修复：`run()`/`ps()` 返回的是 `{ok, stdout, stderr, error}`，**没有 `code` 字段**。
        //    原判据 `r.code === 0` 恒为假 ⇒ 构建成功也回 `ok:false`，错误信息还是 `exit undefined`
        //    （卡面「刷新」因此永远报错）。改为按 `ok` 判定，并把 err.message 一并带出便于诊断。
        sendJson(res, 200, (r.ok === true && j && j.ok === true)
          ? { ok: true, summary: j, assets: doc }
          : { ok: false, error: String((j && j.error) || r.error || r.stderr || 'build failed').slice(0, 300), summary: j ?? null })
        return
      }
      if (path === '/objects') {
        const doc = await readJson(PWB_OBJECTS)
        sendJson(res, doc ? 200 : 503, doc ?? { error: 'objects.json 尚未生成（跑 node <库内>/run-objects-pipeline.mjs）' })
        return
      }
      if (path === '/disposition') {
        const doc = await readJson(PWB_DISPOSITION)
        sendJson(res, doc ? 200 : 503, doc ?? { error: 'disposition.json 尚未生成' })
        return
      }
      if (path === '/crosscheck') {
        const doc = await readJson(PWB_CROSSCHECK)
        sendJson(res, doc ? 200 : 503, doc ?? { error: 'crosscheck.json 尚未生成' })
        return
      }
      if (path === '/domain-health') {
        const doc = await readJson(PWB_DOMAIN_HEALTH)
        if (doc) {
          // D6（2026-09-16）：建议**读时合并**本轮 active-domains.json 的 auto 匹配 ——
          // 否则 /active-domains?match=1 匹配出的新建议要等产物重建才可见（卡上看不到）。
          const adLive = await readJson(PWB_AD_DOC)
          const declaredIds = new Set([...(adLive?.effective ?? []).filter((d) => d.source === 'declared').map((d) => d.id),
            ...(adLive?.declared?.domains ?? []).map((d) => d.id)])
          const sugs = (adLive?.auto?.matches ?? []).filter((m) => !declaredIds.has(m.id))
            .map((m) => ({ id: m.id, name: m.name, via: m.via ?? null, reason: m.reason ?? null, matched_signals: m.matched_signals ?? [] }))
          doc.active = { ...(doc.active ?? {}), declared: [...declaredIds].sort(), suggestions: sugs,
            auto_basis: { sessionId: adLive?.auto?.sessionId ?? null, title: adLive?.auto?.title ?? null,
              scannedChars: adLive?.auto?.scannedChars ?? 0, matches: (adLive?.auto?.matches ?? []).length } }
        }
        sendJson(res, doc ? 200 : 503, doc ?? { error: 'domain-health.json 尚未生成' })
        return
      }
      // T31 能力①/⑤（2026-09-16 · 只读透传，host 不加工）：
      //   /brief     今日决策面（昨夜动向 / 今日必办 / 待定等对方）→ 首屏「今日决策面」卡
      //   /insights  跨源洞察（≤3 条，每条带证据链 + 支撑强度 + 可反驳入口）→ 「跨源洞察」卡
      //   两者都由库内 objects 管线生成；缺产物时**明确 503 + 下一步命令**（不静默返回空对象，
      //   否则面板会把"没产物"读成"今天没事"）。
      if (path === '/brief') {
        const doc = await readJson(PWB_BRIEF)
        sendJson(res, doc ? 200 : 503, doc ?? { error: 'brief.json 尚未生成（跑 node <库内>/run-objects-pipeline.mjs）' })
        return
      }
      if (path === '/insights') {
        const doc = await readJson(PWB_INSIGHTS)
        sendJson(res, doc ? 200 : 503, doc ?? { error: 'insights.json 尚未生成（跑 node <库内>/run-objects-pipeline.mjs）' })
        return
      }
      // 判断质量台账（T31 建议 5 · 能力③）：GET 只读透传；POST 走 CLI（host 不另写判定逻辑）。
      // 纪律：驳回/修正必须带理由与 rule_key（CLI 在源头拦）；达阈值只出「待裁定」条目，**绝不自动改判断层**。
      if (path === '/feedback' && req.method === 'GET') {
        const doc = await readJson(PWB_FEEDBACK)
        sendJson(res, doc ? 200 : 503, doc ?? { error: 'feedback.json 尚未生成（尚无任何裁决记录）' })
        return
      }
      // ── 待办**源头回写**（2026-09-17 用户要求）────────────────────────────
      //   用户原话：「我希望我在工作台关闭待办之后，在源头端也标记完成，重新打开，源头端也标记未完成。」
      //   三个源各有其唯一写通道，**host 只做参数校验 + 转调**（不复制任何判断）：
      //     · dingtalk → `dws todo task done --task-id <id> --status true|false`（带 --profile 定位组织）
      //     · feishu   → `lark-cli task +complete|+reopen --task-id <guid> --as user`
      //     · personal → 库内 `cli-todo.mjs done|reopen --id … | --path …`（与面板/工具同一真相源）
      //   ⚠️ 失败**原样上报**（含源端 stderr），绝不假装成功 —— 面板据此显示"未同步 + 原因"。
      if (path === '/todo/act' && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        const source = String(body.source || '')
        const action = String(body.action || '')
        const id = String(body.id || '').trim()
        const filePath = String(body.path || '').trim()
        const profile = String(body.profile || '').trim()
        const title = String(body.title || '').slice(0, 200)
        // 服务端最近一次采集里命中的条目（策略判定要用它；台账标题兜底也用它）
        let foundItem = null
        let personalTitleCache = null
        /** 个人待办：台账标题在客户端没带时，从**被改的那个文件**里取（改完仍保留 frontmatter/title） */
        const resolvePersonalTitle = async () => {
          if (personalTitleCache !== null) return personalTitleCache
          personalTitleCache = ''
          if (source === 'personal' && filePath.length > 0) {
            try {
              const text = await readFile(filePath, 'utf8')
              const t = parsePersonalTodoText(text, filePath.split(/[\\/]/).pop() || '')
              personalTitleCache = String((t && t.title) || '')
            } catch { /* 读不到就留空，不猜 */ }
          }
          return personalTitleCache
        }
        // 动作台账：**每次回写都留痕**（成功/失败都记）—— 它同时是「最近关闭 → 可重新打开」的数据源
        //   （面板不展示已完成项，所以"重新打开"必须先知道"刚才关了哪条、它的源头 id 是什么"）。
        //   ★ 2026-09-17 实测补：二级详情那条路径**原先不带标题** ⇒ 台账里 title 为空 ⇒ 「最近关闭」那一行
        //     只能显示一串 taskId。现在三层兜底：客户端标题 → 服务端采集到的标题 → 个人文件里的标题。
        const logAction = async (ok, errorText) => {
          try {
            const prev = (await readJson(PWB_TODO_ACTIONS)) || { version: 1, actions: [] }
            const arr = Array.isArray(prev.actions) ? prev.actions : []
            arr.push({
              at: new Date().toISOString(), source, action, id, path: filePath, profile,
              title: ledgerTitle(title, foundItem, await resolvePersonalTitle()),
              ok: ok === true, error: ok === true ? null : String(errorText || '').slice(0, 200),
            })
            await writeFile(PWB_TODO_ACTIONS, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), actions: arr.slice(-50) }, null, 2), 'utf8')
          } catch { /* 台账写失败不影响动作本身 */ }
        }
        if (action !== 'done' && action !== 'reopen') {
          sendJson(res, 400, { ok: false, error: 'action 必须是 done（标记完成）或 reopen（重新打开）' })
          return
        }
        // ★ 回写策略**在服务端强制**（用户 2026-09-17 精确裁定）：
        //   「我自己或别人安排给我的，可以由我关闭/重开并反馈到源头；**我安排给别人的，我只读，不反馈**。」
        //   判定以**服务端最近一次采集**为准（不是客户端传来的 category —— 那只是渲染用的字段，可伪造）。
        //   取不到该条（缓存过期 / 刚被移除）⇒ **拒绝写**（写操作宁可失败也不猜）。
        if (source === 'dingtalk' || source === 'feishu') {
          const snapNow = cache.data
          const listed = snapNow && snapNow.todos
            ? (source === 'dingtalk' ? (snapNow.todos.items || []) : ((snapNow.todos.feishu && snapNow.todos.feishu.items) || []))
            : []
          const found = listed.find((x) => String((source === 'dingtalk' ? x.taskId : x.id) || '') === id)
          foundItem = found || null
          const decision = found ? todoWritePolicy({ source, category: found.category, owners: found.owners }) : null
          if (decision === null || decision.writable !== true) {
            sendJson(res, 200, {
              ok: false, source, action, id,
              error: decision === null
                ? '无法确认该条是否由我执行（服务端最近一次采集里没有它）⇒ 拒绝回写，请刷新后重试'
                : `该条只读：${decision.reason}`,
            })
            return
          }
        }
        if (source === 'dingtalk') {
          if (id.length === 0) { sendJson(res, 400, { ok: false, error: '钉钉待办需要 taskId' }); return }
          const args = ['todo', 'task', 'done', '--task-id', id, '--status', action === 'done' ? 'true' : 'false']
          if (profile.length > 0) args.push('--profile', profile)
          args.push('--format', 'json')
          const script = "$ErrorActionPreference='SilentlyContinue'; try { [Console]::OutputEncoding=[Text.Encoding]::UTF8 } catch {}; "
            + `& ${DWS_CLI} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')} 2>&1 | Out-String`
          const r = await ps(['-NoProfile', '-NonInteractive', '-Command', script], 60000)
          const j = parseJsonLoose(r.stdout)
          const ok = j !== null && j.success === true
          const errText = ok ? null : String((j && j.error && j.error.message) || r.error || r.stderr || r.stdout || '无输出').slice(0, 300)
          await logAction(ok, errText)
          sendJson(res, 200, ok ? { ok: true, source, action, id, sourceResult: j } : { ok: false, source, action, id, error: errText })
          return
        }
        if (source === 'feishu') {
          if (id.length === 0) { sendJson(res, 400, { ok: false, error: '飞书任务需要 guid' }); return }
          const argv = ['task', action === 'done' ? '+complete' : '+reopen', '--task-id', id, '--as', 'user', '--format', 'json']
          const script = "$ErrorActionPreference='SilentlyContinue'; try { [Console]::OutputEncoding=[Text.Encoding]::UTF8 } catch {}; "
            + `& ${LARK_CLI} ${argv.join(' ')} 2>&1 | Out-String`
          const r = await ps(['-NoProfile', '-NonInteractive', '-Command', script], 60000)
          const j = parseJsonLoose(r.stdout)
          const ok = j !== null && j.ok === true
          const errText = ok ? null : String((j && j.error && j.error.message) || r.error || r.stderr || r.stdout || '无输出').slice(0, 300)
          await logAction(ok, errText)
          sendJson(res, 200, ok ? { ok: true, source, action, id, sourceResult: j.data || j } : { ok: false, source, action, id, error: errText })
          return
        }
        if (source === 'personal') {
          const argv = [action]
          if (id.length > 0) argv.push('--id', id)
          else if (filePath.length > 0) argv.push('--path', filePath)
          else { sendJson(res, 400, { ok: false, error: '个人待办需要 id 或 path' }); return }
          const r = await run(NODE, [PWB_TODO_CLI, ...argv], 30000)
          const j = parseJsonLoose(r.stdout)
          const ok = j !== null && j.ok === true
          await logAction(ok, ok ? null : String((j && j.error) || r.error || r.stderr || '无输出').slice(0, 300))
          sendJson(res, 200, j !== null ? j : { ok: false, source, action, error: String(r.error || r.stderr || '无输出').slice(0, 300) })
          return
        }
        sendJson(res, 400, { ok: false, error: `未知来源: ${source || '(空)'}` })
        return
      }

      if (path === '/feedback' && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        const args = ['record']
        for (const [flag, key] of [['--type', 'type'], ['--ruling', 'ruling'], ['--content', 'content'],
          ['--basis', 'basis'], ['--reason', 'reason'], ['--rule-key', 'rule_key']]) {
          const v = body[key]
          if (v !== undefined && v !== null && String(v).trim().length > 0) args.push(flag, String(v))
        }
        const r = await run(NODE, [PWB_FEEDBACK_CLI, ...args, '--file', PWB_FEEDBACK], 30000)
        const j = parseJsonLoose(r.stdout)
        sendJson(res, 200, j === null
          ? { ok: false, error: String(r.error || r.stderr || 'no output').slice(0, 300) }
          : j)
        return
      }

      if (path === '/state') {
        // B 块兜底：面板轮询 /state 时，若活跃关注域超过阈值未重匹配，就后台触发一次（不阻塞响应）
        if (Date.now() - adCache.at > AD_MATCH_MS) { matchActiveDomains().catch(() => {}) }
        sendJson(res, 200, await state(url.searchParams.get('force') === '1'))
        return
      }

      // ── 专注块（C1）：运行时写路径 —— 面板按钮与 DSH 工具共用 cli-focus.mjs ──
      // 读：GET /focus → 当前专注状态；写：POST /focus {action: declare|end, ...}
      // ⚠️ `GET /focus` 已**删除**（2026-09-16 · 不留悬空路由）：
      //   它读 `cli-focus.mjs status`，与 `/state` 下发的 `focus` 字段构成**两条读路径** ——
      //   面板只读 `/state.focus`（专注卡），该 GET 从上线起就没有任何消费方
      //   （审计实测：client 只 POST、不 GET）。两条读路径 = 第二真相源，宁可删掉。
      //   写路径 `POST /focus`（declare/end）保留，仍是面板与 DSH 工具共用的唯一写通道。
      //   若将来真需要"进程外读专注态"，从 `/state` 扩展而非恢复本路由。
      if (path === '/focus' && req.method === 'GET') {
        sendJson(res, 410, { ok: false, error: 'GET /focus 已删除：专注态请读 /state.focus（单一真相源）' })
        return
      }
      if (path === '/focus' && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        const action = String(body.action || '')
        let args = []
        if (action === 'declare') {
          const kind = String(body.kind || 'domain')
          const id = String(body.id || '').trim()
          const minutes = String(body.minutes || '50')
          const label = String(body.label || '').trim()
          if (!/^[a-z]+$/.test(kind) || id.length === 0 || !/^\d+$/.test(minutes)) {
            sendJson(res, 200, { ok: false, error: 'declare 需要合法 kind/id/minutes' }); return
          }
          args = ['declare', '--kind', kind, '--id', id, '--minutes', minutes]
          if (label.length > 0) args.push('--label', label)
        } else if (action === 'end') {
          args = ['end']
        } else {
          sendJson(res, 200, { ok: false, error: 'action 必须为 declare 或 end' }); return
        }
        const r = await run(NODE, [PWB_FOCUS_CLI, ...args], 30000)
        const j = parseJsonLoose(r.stdout)
        // 专注态是**实时读**的（见 workbenchState 里的 liveFocus），但仍要让
        // `/state` 的 30 秒缓存失效，否则面板可能继续拿到写之前的整块状态。
        pwbCache.data = null
        pwbCache.at = 0
        sendJson(res, 200, j ?? { ok: false, error: String(r.error || r.stderr || 'no output').slice(0, 300) })
        return
      }

      // ── 活跃关注域（B 块）：读文档；?match=1 强制重匹配当前会话 ──
      if (path === '/active-domains' && req.method === 'GET') {
        if (url.searchParams.get('match') === '1') await matchActiveDomains(true)
        const doc = await readJson(PWB_AD_DOC)
        sendJson(res, 200, doc ?? { ok: true, empty: true, effective: [] })
        return
      }

      // ── 活跃关注域**写入口**（2026-09-17 新增 · 面板「声明 / 清除」用）──
      //   与 DSH 工具 `workbench_active_domains` **共用 `activeDomainsAction()`**（单真相源）；
      //   host 内不新增判定：declare/clear 全部经库内 `cli-active-domains.mjs`。
      //   语义（由库内 CLI 决定，host 不解释）：声明期间 `effective` 只取声明，`auto` 保留展示。
      if (path === '/active-domains' && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        const action = String(body.action || '')
        if (action !== 'declare' && action !== 'clear') {
          sendJson(res, 200, { ok: false, error: 'action 必须是 declare（声明，另需 domains）或 clear（清除声明）' })
          return
        }
        const j = await activeDomainsAction({ action, domains: body.domains, note: body.note })
        // 写后让读缓存失效：下一次 GET /state 会重新读文档（**不**强制重匹配会话）
        adCache.data = null
        adCache.at = 0
        sendJson(res, 200, j === null ? { ok: false, error: 'no output' } : j)
        return
      }

      // ── 事务详情卡（E 块）：读详情 + 记录/关闭/重开 三个写路由 ──
      // 写操作统一经过 mutateMatterActions → matter-actions.json（单一写通道，串行化）
      if (path === '/matter' && req.method === 'GET') {
        const id = String(url.searchParams.get('id') || '')
        if (!MATTER_ID_RE.test(id)) { sendJson(res, 200, { ok: false, error: 'bad matter id' }); return }
        const base = await loadMattersBase()
        const bm = findMatter(base, id)
        if (bm === null) { sendJson(res, 200, { ok: false, error: '事务库中没有 id=' + id + '（未立案；承诺候选需先经库内立项转事务）' }); return }
        const actions = await loadMatterActions()
        sendJson(res, 200, { ok: true, matter: effectiveMatter(bm, actions, id) })
        return
      }

      if (path === '/matter/record' && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        const id = String(body.id || '')
        const text = String(body.text || '').trim()
        const kind = RECORD_KINDS.indexOf(body.kind) >= 0 ? String(body.kind) : 'note'
        const p = typeof body.path === 'string' ? body.path.trim() : ''
        if (!MATTER_ID_RE.test(id)) { sendJson(res, 200, { ok: false, error: 'bad matter id' }); return }
        if (text.length === 0 || text.length > 500) { sendJson(res, 200, { ok: false, error: '记录内容必填（1–500 字）' }); return }
        if (p.length > 0 && !p.startsWith(KNOWLEDGE)) { sendJson(res, 200, { ok: false, error: '关联路径必须在知识库内' }); return }
        const base = await loadMattersBase()
        const bm = findMatter(base, id)
        if (bm === null) { sendJson(res, 200, { ok: false, error: '事务库中没有 id=' + id + '（承诺候选需先经库内立项）' }); return }
        const rec = { ts: new Date().toISOString(), kind, text: text.slice(0, 500) }
        if (p.length > 0) rec.path = p
        const actions = await mutateMatterActions((cur) => {
          const list = Array.isArray(cur.records[id]) ? cur.records[id].slice() : []
          list.push(rec)
          cur.records[id] = list.slice(-200)
          return cur
        })
        pwbCache.data = null
        pwbCache.at = 0
        sendJson(res, 200, { ok: true, matter: effectiveMatter(bm, actions, id) })
        return
      }

      // ── 关闭条件检测（2026-09-15 需求）：详情卡「关闭条件」旁的「检测」按钮 ──
      // 当场求值（库内 CLI，同一个观测判定）→ 满足即**记录证据并关闭**（走同一写通道）
      if (path === '/matter/check' && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        const id = String(body.id || '')
        if (!MATTER_ID_RE.test(id)) { sendJson(res, 200, { ok: false, error: 'bad matter id' }); return }
        const j = await runMatterCheck(['--id', id])
        if (j.ok !== true) { sendJson(res, 200, j); return }
        const hit = (j.closable || [])[0] || null
        if (hit === null) {
          const miss = (j.notClosable || [])[0] || null
          const man = (j.manual || [])[0] || null
          sendJson(res, 200, {
            ok: true, matched: false,
            reason: (miss && miss.reason) || (man && man.reason) || '关闭条件未满足',
            done_when: (miss && miss.done_when) || null,
          })
          return
        }
        const closed = await closeMatterViaCli(id, hit.note)
        pwbCache.data = null
        pwbCache.at = 0
        sendJson(res, 200, {
          ok: closed.ok === true,
          matched: true,
          closed: closed.ok === true,
          note: hit.note,
          evidence: hit.evidence || null,
          error: closed.ok === true ? null : String(closed.error || '关闭失败'),
        })
        return
      }

      if (path === '/matter/close' && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        const id = String(body.id || '')
        const note = String(body.note || '').trim()
        if (!MATTER_ID_RE.test(id)) { sendJson(res, 200, { ok: false, error: 'bad matter id' }); return }
        // 关闭走库内 CLI：M7d 机制在库内强制（过期事务无反馈记录会被拒绝），本层不再另起一套判定
        const args = ['close', '--id', id, '--file', PWB_MATTERS, '--overrides', PWB_MATTER_OVR]
        if (note.length > 0) args.push('--note', note.slice(0, 1000))
        const r = await run(NODE, [PWB_MATTER_CLI, ...args], 30000)
        const j = parseJsonLoose(r.stdout)
        if (j && j.ok === true) {
          // 立即重建快照 —— 面板事务卡读 snapshot.json，不重建会显示旧状态
          await rebuildArtifacts()
          pwbCache.data = null
          pwbCache.at = 0
        }
        const base = await loadMattersBase()
        const bm = findMatter(base, id)
        const actions = await loadMatterActions()
        sendJson(res, 200, j === null
          ? { ok: false, error: String(r.error || r.stderr || 'no output').slice(0, 300) }
          : (j.ok === true
            ? { ok: true, matter: bm === null ? null : effectiveMatter(bm, actions, id), cli: j }
            : { ok: false, error: String(j.error || 'close failed') }))
        return
      }

      // 决策卡的退出动作①「重定截止」（matter / delivery 的 exits 里的 reschedule）。
      // host 只做**入参校验 + 转调 + 重建**：判定与留痕全在库内 cli-matter.mjs
      // （写 matter-overrides.json 后立即套用到 matters.json ⇒ 管线重建后不丢）。
      // 旗标就是 cli-matter 的既有契约：`reschedule --id <id> --due <YYYY-MM-DD|ISO>`
      //   （`--file/--overrides` 显式给出，与 /matter/close 同一套，避免依赖 CLI 的默认路径）。
      if (path === '/matter/reschedule' && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        const id = String(body.id || '')
        const dueAt = String(body.due_at || '').trim()
        if (!MATTER_ID_RE.test(id)) { sendJson(res, 200, { ok: false, error: 'bad matter id' }); return }
        if (dueAt === '') {
          sendJson(res, 200, { ok: false, error: '必须填新截止日 due_at（YYYY-MM-DD 或 ISO 时刻）' }); return
        }
        if (Number.isNaN(Date.parse(dueAt))) {
          sendJson(res, 200, { ok: false, error: 'due_at 不可解析: ' + dueAt.slice(0, 32) }); return
        }
        const r = await run(NODE, [PWB_MATTER_CLI, 'reschedule', '--id', id, '--due', dueAt,
          '--file', PWB_MATTERS, '--overrides', PWB_MATTER_OVR], 30000)
        const j = parseJsonLoose(r.stdout)
        if (j && j.ok === true) {
          // 改了 due_at ⇒ snapshot（事务卡）与 brief（决策卡的桶）都要重建，否则条目仍留在原桶
          await rebuildArtifacts()
          pwbCache.data = null
          pwbCache.at = 0
        }
        sendJson(res, 200, j === null
          ? { ok: false, error: String(r.error || r.stderr || 'no output').slice(0, 300) }
          : (j.ok === true ? { ok: true, cli: j } : { ok: false, error: String(j.error || 'reschedule failed') }))
        return
      }

      if (path === '/matter/reopen' && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        const id = String(body.id || '')
        if (!MATTER_ID_RE.test(id)) { sendJson(res, 200, { ok: false, error: 'bad matter id' }); return }
        const r = await run(NODE, [PWB_MATTER_CLI, 'reopen', '--id', id, '--file', PWB_MATTERS, '--overrides', PWB_MATTER_OVR], 30000)
        const j = parseJsonLoose(r.stdout)
        if (j && j.ok === true) {
          await rebuildArtifacts()
          pwbCache.data = null
          pwbCache.at = 0
        }
        const base = await loadMattersBase()
        const bm = findMatter(base, id)
        const actions = await loadMatterActions()
        sendJson(res, 200, j === null
          ? { ok: false, error: String(r.error || r.stderr || 'no output').slice(0, 300) }
          : (j.ok === true
            ? { ok: true, matter: bm === null ? null : effectiveMatter(bm, actions, id), cli: j }
            : { ok: false, error: String(j.error || 'reopen failed') }))
        return
      }

      // 幂等重建：跑库内 build-snapshot.mjs + build-brief.mjs（决策卡读后者）。
      // ⚠️ 这是**重建**（输入的确定性函数），不是状态变更 —— 与 P2「写操作归 DSH」不冲突：
      //    它由 DSH 侧的 host 半段触发，且 HTML 侧仍是只读的。
      if (path === '/rebuild' && req.method === 'POST') {
        const r = await run(NODE, [PWB_BUILD], 180000)
        const r2 = await run(NODE, [PWB_BRIEF_BUILD], 60000)
        pwbCache.data = null
        pwbCache.at = 0
        const tail = (r.stdout + r.stderr + r2.stdout + r2.stderr).trim().split('\n').slice(-4).join(' | ')
        const ok = r.ok === true && r2.ok === true
        sendJson(res, 200, { ok, error: ok ? null : String(r.error || r2.error || tail).slice(0, 300), tail: tail.slice(0, 400) })
        return
      }

      // ── 待议流入的处置（流入卡 · 2026-09-16）────────────────────────
      // 本路由只做"转调 + 缓存失效"，判定与留痕全部由 cli-disposition.mjs 内的
      // gate.resolvePending() 负责（冻结内核，不在此另起一套判断）。
      if (path === '/disposition/act' && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        const id = String(body.id || '')
        const action = String(body.action || '')
        const reason = String(body.reason || '').trim()
        const source = body.source ? String(body.source) : null
        if (!id) { sendJson(res, 200, { ok: false, error: '缺 id' }); return }
        if (action !== 'reject' && action !== 'forward') { sendJson(res, 200, { ok: false, error: 'action 只能是 reject | forward' }); return }
        if (!reason) { sendJson(res, 200, { ok: false, error: '必须填写理由（人工处置要留痕）' }); return }
        const args = [action, '--id', id, '--reason', reason.slice(0, 500)]
        if (source === 'A' || source === 'B') args.push('--source', source)
        const r = await run(NODE, [PWB_DISP_CLI, ...args], 30000)
        const j = parseJsonLoose(r.stdout)
        if (j && j.ok === true) {
          // 闸产物变了 ⇒ 快照里的 counts（待议/域外拦截）必须重建，否则卡上显示旧世界
          await rebuildArtifacts()
          pwbCache.data = null
          pwbCache.at = 0
        }
        sendJson(res, 200, j === null
          ? { ok: false, error: String(r.error || r.stderr || 'no output').slice(0, 300) }
          : j)
        return
      }

      // ── 待响应触发（T32 · 2026-09-16）──────────────────────────────────────
      // 读：转调 cli-trigger list（分组用冻结层选择器算，host 不重算判断），15s 缓存。
      // 写：转调 cli-trigger respond/dismiss/undo（登记表 + 立即回放），host 只做参数校验。
      if (path === '/triggers' && req.method === 'GET') {
        const now = Date.now()
        if (triggerCache.data !== null && now - triggerCache.at < TRIGGER_CACHE_MS) {
          sendJson(res, 200, triggerCache.data)
          return
        }
        const r = await run(NODE, [PWB_TRIGGER_CLI, 'list', '--open'], 30000)
        const j = parseJsonLoose(r.stdout)
        if (j === null || j.ok !== true) {
          sendJson(res, 200, { ok: false, error: String(r.error || r.stderr || 'cli-trigger list 无输出').slice(0, 300) })
          return
        }
        const reg = await readJson(PWB_TRIGGER_REG)
        const doc = {
          ok: true,
          counts: j.counts ?? null,
          responseStats: j.responseStats ?? null,
          rows: j.rows ?? [],
          // ★ 2026-09-24：自动回复台账的**按会话聚合**（`reply-threads.mjs` 算好，host 只透传）。
          //   为什么不在这里算：判定与裁剪只有一份（库内纯函数、有夹具自检）；host 保持"只搬运"。
          //   `null` = 这次 CLI 没给（旧版 CLI）⇒ 面板按"取不到"呈现，不画成"没有会话"。
          threads: j.threads ?? null,
          registry: reg === null ? null : { updatedAt: reg.updatedAt ?? null, responses: reg.responses ?? [] },
          generatedAt: new Date().toISOString(),
        }
        triggerCache.data = doc
        triggerCache.at = now
        sendJson(res, 200, doc)
        return
      }

      if (path === '/trigger/respond' && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        const id = String(body.id || '')
        const kind = String(body.action || 'responded')
        if (!TRIGGER_ID_RE.test(id)) { sendJson(res, 200, { ok: false, error: 'bad trigger id' }); return }
        if (kind !== 'responded' && kind !== 'dismissed' && kind !== 'undo') {
          sendJson(res, 200, { ok: false, error: 'action 必须为 responded / dismissed / undo' }); return
        }
        const req = { id }
        if (kind === 'responded') {
          const act = String(body.response_action || '').trim()
          if (act.length === 0) { sendJson(res, 200, { ok: false, error: '必须写明响应动作（写了什么才算已响应）' }); return }
          req.action = 'responded'
          req.response_action = act.slice(0, 200)
          if (body.ref) req.ref = String(body.ref).slice(0, 200)
          if (body.note) req.note = String(body.note).slice(0, 500)
        } else if (kind === 'dismissed') {
          const reason = String(body.reason || '').trim()
          if (reason.length === 0) { sendJson(res, 200, { ok: false, error: '必须写明理由（忽略要留痕）' }); return }
          req.action = 'dismissed'
          req.reason = reason.slice(0, 500)
        }
        // 中文参数走 JSON 文件（Windows argv 转码风险），与 cli-matter 的 --from-json 同处理。
        // 落在 `.runtime/` 子目录：产物根 `_meta/out/*.json` 有登记表守卫（未登记即红），
        // 一个只活几毫秒的请求体不该被登记成产物。
        await mkdir(join(PWB_DIR, '.runtime'), { recursive: true })
        await writeFile(PWB_TRIGGER_REQ, JSON.stringify({ response: req }), 'utf8')
        const args = kind === 'undo' ? ['undo', '--id', id] : [kind, '--from-json', PWB_TRIGGER_REQ]
        const r = await run(NODE, [PWB_TRIGGER_CLI, ...args], 30000)
        const j = parseJsonLoose(r.stdout)
        if (j !== null && j.ok === true) {
          // 产物变了 ⇒ 面板的 /state（含 respond 区块与响应率）必须失效
          pwbCache.data = null
          pwbCache.at = 0
          triggerCache.data = null
          triggerCache.at = 0
        }
        sendJson(res, 200, j === null
          ? { ok: false, error: String(r.error || r.stderr || 'no output').slice(0, 300) }
          : j)
        return
      }

      // ── 决策卡的退出动作③④：响应 / 忽略归档（trigger 的 exits）────────────────
      // 与 `/trigger/respond` 是**同一件事的两种入参形态**（那条是既有卡在用的 `action: responded|dismissed`）：
      // 本路由是决策卡二级详情页的形态 `{id, action:'respond'|'dismiss', response_action, ref, reason}`，
      // 二者最终都转调同一个 `cli-trigger.mjs`（写登记表 + 立即回放 ⇒ 管线重建后持久），本层不新造判定。
      // 中文入参（响应动作 / 忽略理由）走 `--from-json`：Windows 把非 ASCII 参数交给 node 时可能已被
      //   转码（cli-trigger.mjs 自己的文档也这么建议）。请求体落在 `.runtime/`，不污染产物根。
      if (path === '/trigger/act' && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        const id = String(body.id || '')
        const action = String(body.action || '')
        if (!TRIGGER_ID_RE.test(id)) { sendJson(res, 200, { ok: false, error: 'bad trigger id' }); return }
        if (action !== 'respond' && action !== 'dismiss') {
          sendJson(res, 200, { ok: false, error: "action 只能是 respond | dismiss" }); return
        }
        const reqDoc = { response: { id } }
        if (action === 'respond') {
          const act = String(body.response_action || '').trim()
          if (act.length === 0) {
            sendJson(res, 200, { ok: false, error: '必须写明响应动作（写了什么才算已响应）' }); return
          }
          // 旗标契约（cli-trigger.mjs respond）：--id / --action <响应动作> / [--ref <凭证>]
          reqDoc.response.action = 'responded'
          reqDoc.response.response_action = act.slice(0, 200)
          const ref = String(body.ref || '').trim()
          if (ref.length > 0) reqDoc.response.ref = ref.slice(0, 200)
        } else {
          const reason = String(body.reason || '').trim()
          if (reason.length === 0) {
            sendJson(res, 200, { ok: false, error: '忽略理由必填（事后要能复核）' }); return
          }
          // 旗标契约（cli-trigger.mjs dismiss）：--id / --reason <理由>
          reqDoc.response.action = 'dismissed'
          reqDoc.response.reason = reason.slice(0, 500)
        }
        await mkdir(join(PWB_DIR, '.runtime'), { recursive: true })
        await writeFile(PWB_TRIGGER_REQ, JSON.stringify(reqDoc), 'utf8')
        const r = await run(NODE, [PWB_TRIGGER_CLI, action, '--from-json', PWB_TRIGGER_REQ], 30000)
        const j = parseJsonLoose(r.stdout)
        if (j !== null && j.ok === true) {
          // 触发状态变了 ⇒ snapshot（触发卡/响应率）与 brief（决策卡的桶）都要重建，否则条目仍留在原桶
          await rebuildArtifacts()
          pwbCache.data = null
          pwbCache.at = 0
          triggerCache.data = null
          triggerCache.at = 0
        }
        sendJson(res, 200, j === null
          ? { ok: false, error: String(r.error || r.stderr || 'no output').slice(0, 300) }
          : j)
        return
      }

      // 转事务：把触发变成事务（事务创建走 cli-matter，本层只转发 + 重建快照）
      if (path === '/trigger/to-matter' && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        const id = String(body.id || '')
        const title = String(body.title || '').trim()
        const domain = String(body.domain || '').trim()
        const doneWhen = String(body.done_when || '').trim()
        if (!TRIGGER_ID_RE.test(id)) { sendJson(res, 200, { ok: false, error: 'bad trigger id' }); return }
        if (title.length === 0) { sendJson(res, 200, { ok: false, error: '必须填事务标题' }); return }
        if (domain.length === 0) { sendJson(res, 200, { ok: false, error: '必须填归属关注域（P3：写不出归属的不成事务）' }); return }
        if (doneWhen.length === 0) { sendJson(res, 200, { ok: false, error: '必须填关闭条件（P3：写不出关闭条件的不成事务）' }); return }
        const reqDoc = {
          response: {
            id,
            title: title.slice(0, 200),
            domain: domain.slice(0, 64),
            done_when: doneWhen.slice(0, 500),
            due_at: body.due_at ? String(body.due_at).slice(0, 32) : null,
            counterparty: body.counterparty ? String(body.counterparty).slice(0, 64) : null,
          },
        }
        await writeFile(PWB_TRIGGER_REQ, JSON.stringify(reqDoc), 'utf8')
        const r = await run(NODE, [PWB_TRIGGER_CLI, 'to-matter', '--from-json', PWB_TRIGGER_REQ], 60000)
        const j = parseJsonLoose(r.stdout)
        if (j !== null && j.ok === true) {
          // 事务入了 matters.json ⇒ 快照/首屏（含今日决策面、事务卡）必须重建
          await rebuildArtifacts()
          pwbCache.data = null
          pwbCache.at = 0
          triggerCache.data = null
          triggerCache.at = 0
        }
        sendJson(res, 200, j === null
          ? { ok: false, error: String(r.error || r.stderr || 'no output').slice(0, 300) }
          : j)
        return
      }

      // ── 卡片顺序覆盖层（2026-09-16 用户裁定：可拖动排序）─────────────────────
      //  两层结构：`CARD_ORDER`（client 里的**默认顺序**，是契约、被 T16-58/SBT-23 断言）
      //           + 本文件（**用户覆盖层**，只影响渲染，不改默认表）。
      //  为什么落 host 而不是 localStorage：跨刷新、跨设备、跨插件重载都要一致；
      //  而且覆盖层必须是**可读、可审计、可测试**的文件（localStorage 读不出来也断言不了）。
      //  校验只有一条：只接受**已知卡片 key**；未知 key 忽略并回报（不报错、不崩）。
      // ── 「系统」卡：两张能力小卡片的四态（只读）+ 手动开关（写）────────────────────
      //   ⚠️ 这是**写入口**：开关只在库内那一个文件（库内开关文件，单一写者维护），
      //      写者只有 `system-switches.mjs#writeSwitch`（原子写）——host 不自己写文件。
      //   ⚠️ **不启停消费者的进程**：两个能力共用同一个常驻消费者（`im-event-consume.mjs`），
      //      开关是**分支闸**（闸在能力模块里），关一个不影响另一个。开关打开时只做一件事：
      //      若消费者任务不在 Running ⇒ `schtasks /run` 把它拉起来（**幂等**：任务本来就每 5 分钟
      //      重复拉起，靠消费者自己的单实例锁兜底）。**从不 `/end`** —— 见 system-switches.mjs 的说明。
      if (path === '/system-state' && req.method === 'GET') {
        const r = await run(NODE, [PWB_SYSTEM_CLI, '--json'], 40000)
        const j = parseJsonLoose(r.stdout)
        if (j === null) {
          sendJson(res, 200, { ok: false, error: '系统卡状态取不到：' + String(r.error || r.stderr || r.stdout || 'no output').trim().slice(0, 300) })
          return
        }
        sendJson(res, 200, j)
        return
      }
      if (path === '/system-switch' && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        //   ⚠️ **host 不认能力名**：词表只在库内 `system-switches.mjs#CAPABILITIES` 一份。
        //      这里原先把两个能力名写死成白名单，结果 2026-09-23 库内加第三个能力
        //      （`vector_search`，系统卡上确实渲染出了那盏灯、也挂了点击）时，host 一句
        //      「未知能力名」把点击挡掉 —— **灯亮了、开关是死的**。改法：只校验类型，
        //      名字原样交给库内 CLI 判（它是词表的唯一产地，拒绝理由也由它给）。
        const cap = String(body.capability || '')
        // 只挡"空名字"（这是**格式**问题，不是词表问题）：名字本身合法与否由库内 CLI 判。
        if (cap.trim() === '') {
          sendJson(res, 200, { ok: false, error: 'capability 不能为空' })
          return
        }
        if (typeof body.enabled !== 'boolean') {
          sendJson(res, 200, { ok: false, error: 'enabled 必须是布尔值（true=开 / false=关）' })
          return
        }
        // 单实例守卫（写口一层）：连点两次不该并发跑两次 schtasks——第二次直接如实说"上一次还没完"
        if (systemSwitchBusy) { sendJson(res, 200, { ok: false, error: '上一次开关切换还在进行中，请稍后再点' }); return }
        systemSwitchBusy = true
        try {
          const r = await run(NODE, [PWB_SYSTEM_CLI, '--set', cap, body.enabled ? 'on' : 'off', '--by', 'panel', '--ensure', '--json'], 60000)
          const j = parseJsonLoose(r.stdout)
          if (j === null) {
            // ⚠️ 2026-09-23 重启后真机验证发现：库内 CLI **拒绝非法输入**时是把理由写在 stderr
            //    首行（形如 `✗ 未知能力名（只认 realtime_reply / voice_command / vector_search）`）
            //    并退出码 2；而 stdout 空 ⇒ `parseJsonLoose` 得 null。原先这里把**整坨** stderr
            //    （Node 的 `Command failed: …` 前缀 + 之后一大段用法帮助）当错误回传 ⇒ 用户看到的是
            //    "开关写入没有回执"这种**像基础设施故障**的说法，而不是"这个名字不认识"。
            //    改成：优先把库内那句话捞出来当理由（去掉行首的 ✗），捞不到才回退。
            const stderrLines = String(r.stderr || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0)
            const reason = (stderrLines.find((s) => s.startsWith('✗')) || stderrLines[0] || '').replace(/^✗\s*/, '')
            sendJson(res, 200, {
              ok: false,
              error: (reason || '开关写入没有回执（库内 CLI 没有输出可读的理由）') + '（库内退出码 ' + String(r.status ?? '?') + '）',
            })
            return
          }
          // 回执里带**写后的完整状态**（含 action：写了什么 / 有没有拉起任务）⇒ 客户端一次往返就能刷新
          sendJson(res, 200, j)
        } finally { systemSwitchBusy = false }
        return
      }

      if (path === '/ui-prefs' && req.method === 'GET') {
        const doc = await readJson(PWB_UI_PREFS)
        // 文件不存在 → 明确告知"没有覆盖层"（面板据此用默认顺序），**不当成空数据**
        sendJson(res, 200, {
          ok: true,
          known: KNOWN_CARD_KEYS,
          fields: UI_PREF_FIELDS,
          exists: doc !== null,
          prefs: doc === null ? null : {
            version: doc.version ?? 1,
            updatedAt: doc.updatedAt ?? null,
            cardOrder: Array.isArray(doc.cardOrder) ? doc.cardOrder : [],
            briefSeenAt: typeof doc.briefSeenAt === 'string' ? doc.briefSeenAt : null,
          },
        })
        return
      }
      if (path === '/ui-prefs' && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        // ── 读改写（merge）：见 mergeUiPrefs 的说明（两字段各有唯一写入口，整份覆盖会互相抹掉）──
        const prev = await readJson(PWB_UI_PREFS)
        const merged = mergeUiPrefs(prev, body)
        if (merged.ok !== true) { sendJson(res, 200, { ok: false, error: merged.error }); return }
        const updated = merged.updated
        try {
          await mkdir(PWB_DIR, { recursive: true })
          await writeFile(PWB_UI_PREFS, JSON.stringify(updated, null, 2), 'utf8')
        } catch (e) {
          sendJson(res, 200, { ok: false, error: String((e && e.message) || e).slice(0, 200) })
          return
        }
        // 写入改变了"已读/游标" ⇒ brief 产物必须重建：卡上的「N 条新」、逐条 ○/● 与游标文案
        // 都直接读 brief.json，不重建就会出现"写成功但界面没变"（用户以为没生效）。
        // ⚠️ 2026-09-17 修复：原判据只看 `merged.hasSeen` ⇒ **逐条已读（briefRead）不触发重建**。
        //    判据已抽成纯函数 `shouldRebuildBrief()`（单测 WB-15..17 + selftest-uiprefs-rebuild.mjs）。
        if (shouldRebuildBrief(merged)) {
          await run(NODE, [PWB_BRIEF_BUILD], 60000)
        }
        sendJson(res, 200, {
          ok: true,
          prefs: {
            version: updated.version,
            updatedAt: updated.updatedAt,
            cardOrder: merged.kept,
            briefSeenAt: typeof updated.briefSeenAt === 'string' ? updated.briefSeenAt : null,
          },
          ignored: merged.ignored, duplicated: merged.duplicated,
          ignoredKeys: merged.ignoredKeys, known: KNOWN_CARD_KEYS,
        })
        return
      }
      if (path === '/ui-prefs' && req.method === 'DELETE') {
        // 「恢复默认顺序」= 删除覆盖层文件（默认表不受影响）
        try { await rm(PWB_UI_PREFS, { force: true }) } catch { /* 已不存在即达成目标 */ }
        sendJson(res, 200, { ok: true, prefs: null })
        return
      }

      // ── 日程**取消 / 恢复**（2026-09-20 用户规格 · 第三条）─────────────────────────
      //   ⚠️ 这是**写入口**：新增写控件已在 `write-controls.json` 登记
      //     （`schedule-act`，count=1：取消与恢复共用一个调用点），并已登记进 run-t16 的
      //     `ROUTE_WHITELIST`（`schedule`）—— 两处都漏一处，T16-4 / T16-88 直接红。
      //   语义边界（必须写清，免得被当成"取消钉钉会议"）：
      //     · 只写**面板自己的覆盖层** `schedule-cancels.json`，**不调任何源头 API** ——
      //       钉钉/飞书里的真事件一条都没动，所以「取消」是**可恢复**的（restore 删记录即回）；
      //     · 键由 host 用事件身份字段算（`schedKeyOf`），客户端只回传 host 给过的 key。
      if (path === '/schedule/act' && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        const action = String(body.action || '')
        // 取消：客户端给**事件身份**（source/id/start/title），host 算键；恢复：只给 host 发过的 key
        const key = action === 'restore' ? String(body.key || '') : schedKeyOf(body)
        const prevDoc = await readJson(PWB_SCHED_CANCELS)
        const prevList = (prevDoc && Array.isArray(prevDoc.cancels)) ? prevDoc.cancels : []
        const r = applySchedCancel(prevList, action, {
          key,
          title: body.title,
          source: action === 'cancel' ? String(body.source || 'dingtalk') : body.source,
          start: body.start,
          // 2026-09-24：`end` 也记（跨天条目的窗口判定要用；客户端从事件里带过来，缺则空串）
          end: body.end,
          reason: body.reason,
        })
        if (r.ok !== true) { sendJson(res, 200, { ok: false, error: r.error }); return }
        try {
          await mkdir(PWB_DIR, { recursive: true })
          await writeFile(PWB_SCHED_CANCELS, JSON.stringify({
            version: 1, updatedAt: new Date().toISOString(), cancels: r.cancels,
          }, null, 2), 'utf8')
        } catch (e) {
          sendJson(res, 200, { ok: false, error: String((e && e.message) || e).slice(0, 200) })
          return
        }
        // 写的是**面板窗口的口径** ⇒ 两份缓存都必须失效，否则界面看起来"点了没反应"：
        //   · `pwbCache` = `/state` 的口径（原来只清了它）；
        //   · `cache`    = `/snapshot` 的口径（**日程卡读的是它**；不清的话非 force 的读会拿到
        //                  旧的、还带着那一行的载荷，直到 15s 缓存过期 —— 2026-09-24 补）。
        pwbCache.data = null
        pwbCache.at = 0
        cache.data = null
        cache.at = 0
        sendJson(res, 200, { ok: true, action, key, count: r.cancels.length, changed: r.changed === true })
        return
      }

      // ── 听记 → 事务（2026-09-20 用户规格 · 第四条）：**一键 + 幂等** ─────────────────
      //   判定一律在库内：`cli-matter.mjs add` → `matter-intake.mjs`（查重 + 原子 ID 预留），
      //   host **只做参数转递 + 错误透传 + 写后重建**（与 `/trigger/to-matter` 同一形态）。
      //   幂等：`dedup_key` 由客户端按**来源**派生（`minutes:<url|title>`）⇒ 重复点由库内查重命中，
      //   返回 `{ok:true, action:'dedup-hit', id:<既有 id>, existed:true}` —— 面板据此说"未重复新建"。
      // ── 听记 → 事务**草稿**（2026-09-26 · 第六条）──────────────────────────────
      //   入参 `{ source: 'feishu'|'dingtalk', id|token, title?, url? }`（dingtalk 的 `url` 是兜底寻址）。
      //   出参 = **引擎的出参原样**（九个契约字段 + 附加项，含 `submit_ready`），另外多两个
      //   **采集层**字段：`collection`（这次正文是怎么取到的：CLI / exit / 逐字稿字节数 / 缺哪个 scope /
      //   has_next 这类事实）与 `unavailable` 时的 `unavailable_reason`（采集原因 + 引擎原因）。
      //   ⚠️ **host 不重写任何判定**：域建议、标题、关闭条件、锚点候选全部来自引擎；
      //      「取不到正文」也**不在这里手搭一个空壳** —— 而是把空入参交给引擎，让引擎自己走
      //      `unavailable_reason` 分支（形状由引擎产，host 只在原因前拼上采集层的真实原因）。
      if (path === '/matter/draft-from-minutes' && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        const source = String(body.source || '').trim()
        const panelTitle = String(body.title || '').trim()
        const ref = minuteRefOf(source, body.id !== undefined ? body.id : body.token, body.url)
        const nowIso = new Date().toISOString()
        // 采集（只在这一层碰 CLI 与文件系统）
        let collected = { ok: false, error: ref.ok ? null : ref.error, source, id: ref.id || null }
        let reqDoc = { source, id: ref.id || undefined, title: panelTitle || undefined }
        if (ref.ok && source === 'feishu') {
          const c = await collectFeishuMinuteDetail(ref.id)
          collected = {
            source, id: ref.id, ok: c.ok === true, error: c.ok === true ? null : c.error,
            cli: LARK_CLI, profile: c.profile, exit: c.exit, output_dir: c.dir,
            transcript_file: c.transcript_file, transcript_chars: String(c.text || '').length,
            missing_scopes: c.missing_scopes, warning: c.warning,
          }
          if (c.ok === true) {
            // 整份 CLI payload + 逐字稿文本一起交给引擎（引擎自动取 data.minutes[0] 的 title/artifacts）
            reqDoc = { ...c.payload, source: 'feishu', id: ref.id, text: c.text, transcript_file: c.transcript_file }
          }
        } else if (ref.ok && source === 'dingtalk') {
          const c = await collectDingMinuteDetail(ref.id)
          collected = {
            source, id: ref.id, ok: c.ok === true, error: c.ok === true ? null : c.error,
            cli: DWS_CLI, profile: null, exit: c.exit, output_dir: null,
            transcript_file: null, transcript_chars: String(c.text || '').length,
            missing_scopes: null, warning: c.warning,
            has_next: c.ok === true ? c.has_next === true : null,
            keywords: c.ok === true ? c.keywords : null,
          }
          if (c.ok === true) {
            reqDoc = {
              source: 'dingtalk', id: ref.id, title: panelTitle || c.title || undefined,
              text: c.text, artifacts: c.artifacts,
            }
          }
        }
        // 取不到正文 ⇒ 入参里**只有来源与标题**：引擎据此回标准 unavailable 壳（不在 host 手搭）
        if (collected.ok !== true) {
          reqDoc = { source, id: ref.id || undefined, title: panelTitle || undefined }
        }
        const engine = await runMatterDraft(reqDoc, nowIso)
        if (engine.ok !== true) {
          // 引擎本身跑不起来（装错路径 / node 起不来）—— 这不是"没取到正文"，是**环境坏了**，如实报
          sendJson(res, 200, { ok: false, error: engine.error, collection: collected, engine: { cli: PWB_MATTER_DRAFT_CLI, args_file: engine.req_path } })
          return
        }
        const draft = engine.draft
        const out = {
          ok: true,
          ...draft,
          submit_ready: draft.submit_ready === true,
          collection: collected,
          engine: { cli: PWB_MATTER_DRAFT_CLI, args_file: engine.req_path, now: nowIso },
        }
        if (collected.ok !== true) {
          out.unavailable_reason = `${String(collected.error || '未取到正文')} · 引擎：${String(draft.unavailable_reason || '（未给原因）')}`
        }
        sendJson(res, 200, out)
        return
      }

      if (path === '/intake' && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        const title = String(body.title || '').trim()
        const domain = String(body.domain || '').trim()
        const doneWhen = String(body.done_when || '').trim()
        if (title.length === 0) { sendJson(res, 200, { ok: false, error: '必须填事务标题' }); return }
        if (domain.length === 0) { sendJson(res, 200, { ok: false, error: '必须填归属关注域（P3：写不出归属的不成事务）' }); return }
        if (doneWhen.length === 0) { sendJson(res, 200, { ok: false, error: '必须填关闭条件（P3：写不出关闭条件的不成事务）' }); return }
        const reqDoc = {
          matter: {
            title: title.slice(0, 200),
            domain: domain.slice(0, 64),
            done_when: doneWhen.slice(0, 500),
            due_at: body.due_at ? String(body.due_at).slice(0, 32) : null,
            source_ref: String(body.source_ref || '').slice(0, 500) || null,
            dedup_key: String(body.dedup_key || '').slice(0, 300) || null,
            origin_project: body.origin_project ? String(body.origin_project).slice(0, 500) : null,
            // ★ 2026-09-26 补：**M1 的两条出路**都要能走通 —— 事务契约（matterFromOverride）要求
            //   `origin_inbound` 或 `origin_project` **至少一个非空**。此前这条路由只透传 origin_project
            //   ⇒ 面板上"这份听记对应某条流入"的情形**根本无法提交**（不是用户没填，是通道没这个字段）。
            //   与 `origin_project` 同款处理：只在非空时下发，空串一律 null（别把一个空字符串当锚点）。
            origin_inbound: body.origin_inbound ? String(body.origin_inbound).slice(0, 64) : null,
            counterparty: body.counterparty ? String(body.counterparty).slice(0, 64) : null,
            direction: 'mine',
          },
        }
        await writeFile(PWB_INTAKE_REQ, JSON.stringify(reqDoc), 'utf8')
        const r = await run(NODE, [PWB_MATTER_CLI, 'add', '--from-json', PWB_INTAKE_REQ], 60000)
        const j = parseJsonLoose(r.stdout)
        if (j !== null && j.ok === true && j.existed !== true) {
          // 真新建 ⇒ 快照必须重建（事务卡要立刻出现）；dedup-hit 时**不重建**（什么都没变）
          await rebuildArtifacts()
          pwbCache.data = null
          pwbCache.at = 0
          triggerCache.data = null
          triggerCache.at = 0
        }
        sendJson(res, 200, j === null
          ? { ok: false, error: String(r.error || r.stderr || 'no output').slice(0, 300) }
          : j)
        return
      }

      sendJson(res, 404, { error: 'unknown route' })
    },
  }))

  ctx.logger?.info?.(`dsh-workdesktop: routes mounted at ${ROUTE} (knowledge=${KNOWLEDGE})`)
}

// 纯函数测试钩子：飞书日历解析在 Node 里可直接验证（selftest-lark.mjs，无需真机数据）。
// 模块加载契约只用 apply/inject/name，附加导出不影响加载。
export const __test = { parseLarkAgenda, parseLarkTasks, parseLarkTaskDetail, parseLarkMinutes, minutesPayload, dingMinutesOf, enrichFeishuTasks, parsePersonalTodoText, todoWritePolicy, pickRecentClosed, ledgerTitle, collectPersonalTodos, classifyTodoItems, toIso, toLoc, ymdLocal, collectFeishuCalendar, collectFeishuTasks, collectFeishuMinutes, eventsFromAgenda, bucketByNext3Days, collect, SCRIPT, mergeUiPrefs, shouldRebuildBrief, KNOWN_CARD_KEYS, UI_PREF_FIELDS, MINUTES_CAP,
  // 日程取消/恢复（2026-09-20 第三条）：纯函数核 —— 键 / 台账读改写 / 窗口套用
  //   （run-t16 的 T16-18x 组直接跑这三条；真机侧由 SBT 的 host 闸门守着）
  schedKeyOf, applySchedCancel, applyScheduleCancels, SCHED_CANCEL_KEEP_DAYS,
  // 听记 → 事务草稿（2026-09-26 · 第六条）：**纯函数段**可被 Node 级直接跑（真机侧由路由守）
  //   · `minuteRefOf`    —— 寻址白名单（飞书 token / 钉钉 taskUuid 含从 url 尾段兜底）
  //   · `dingDetailInput`—— 钉钉 `+detail` payload → 引擎入参（只搬运，不判定）
  //   · 采集与引擎转调也导出：真机探针（HTTP 级）之外，验收套件可以**直接跑一次真采集**
  minuteRefOf, dingDetailInput, collectFeishuMinuteDetail, collectDingMinuteDetail, runMatterDraft,
  PWB_MATTER_DRAFT_CLI, MINUTE_TOKEN_RE, DING_MINUTE_ID_RE }
