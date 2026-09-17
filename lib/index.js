/**
 * dsh-workbench — host half.
 *
 * Collects the workbench snapshot (DingTalk calendar/todos/minutes across every
 * signed-in organization, plus the local knowledge base) and serves it to the
 * browser half over three routes under `/workbench/api`.
 *
 * Deliberately dependency-free: only `node:` builtins are imported, so the same
 * package boots on the checkout runtime and on the packaged runtime shipped by
 * the DSH Desktop app, whose @deepseek-ai versions differ.
 */
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
// 同步读（仅用于 MCP 配置行扫描：几行 YAML，几毫秒；带 120s 缓存）
import { readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-workbench'
export const inject = ['webServer']

const PS = process.env.DSH_WORKBENCH_POWERSHELL
  || 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const HOME = process.env.USERPROFILE || ''
// ⚠️ 脱敏后不提供任何默认路径：缺少环境变量时**直接报错**，不静默回落到某个人的桌面目录。
const KNOWLEDGE = process.env.DSH_WORKBENCH_KNOWLEDGE || ''
if (KNOWLEDGE.length === 0) {
  throw new Error(
    'dsh-workdesktop: 未设置环境变量 DSH_WORKBENCH_KNOWLEDGE（你的知识库根目录）。\n'
    + '  PowerShell: $env:DSH_WORKBENCH_KNOWLEDGE="D:\\my-vault"\n'
    + '  bash:       export DSH_WORKBENCH_KNOWLEDGE="$HOME/my-vault"',
  )
}
const HERMES_URL = process.env.DSH_WORKBENCH_HERMES_URL || 'http://127.0.0.1:8787'
const CACHE_MS = Number(process.env.DSH_WORKBENCH_CACHE_MS || 120000)
const RUN_DIR = join(tmpdir(), 'dsh-workbench')
const SCRIPT_PATH = join(RUN_DIR, 'snapshot.ps1')
const ROUTE = '/workbench/api'

// ── 数据层（personal-workbench）─────────────────────────────────────────────
// ⚠️ **不复制逻辑，只读产物** —— P2「一个真相源」：
//   本插件**复用驾驶舱自己的 `_meta/out/snapshot.json`**，不另建一套派生。
//   该文件由 `_meta/workbench/build-snapshot.mjs` 幂等生成（run-t4 / run-ingest 会自动重建）。
//   插件因此只依赖**文件格式**，不依赖库内任何模块 —— 库内 345 项验收怎么改都不影响它。
const PWB_DIR = join(KNOWLEDGE, '_meta', 'out')
const PWB_SNAPSHOT = join(PWB_DIR, 'snapshot.json')
const PWB_METRICS = join(PWB_DIR, 's-metrics.json')
// 库内仪表盘（驾驶舱 HTML）：better-sidebar 的「驾驶舱」tab 用 iframe 内嵌这份自包含产物
const PWB_DASHBOARD = join(PWB_DIR, 'dashboard.html')
const PWB_BUILD = process.env.DSH_WORKBENCH_BUILD || join(KNOWLEDGE, '_meta', 'workbench', 'build-snapshot.mjs')
// 专注块的运行时写路径：面板按钮与 DSH 工具共用这一个 CLI（P2 一个真相源）
const PWB_FOCUS_CLI = join(KNOWLEDGE, '_meta', 'workbench', 'cli-focus.mjs')
// 活跃关注域（B 块 2026-09-14 裁定 ②「两者都要」）：自动读会话 + agent 声明覆盖，共用这一个 CLI
const PWB_AD_CLI = join(KNOWLEDGE, '_meta', 'workbench', 'cli-active-domains.mjs')
const PWB_AD_INPUT = join(PWB_DIR, 'active-domains-input.json')
const PWB_AD_DOC = join(PWB_DIR, 'active-domains.json')
const AD_MATCH_MS = Number(process.env.DSH_WORKBENCH_AD_MATCH_MS || 60000)
const NODE = process.env.DSH_WORKBENCH_NODE || process.execPath || 'node'
const PWB_CACHE_MS = Number(process.env.DSH_WORKBENCH_PWB_CACHE_MS || 30000)

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
const PWB_MATTERS = process.env.DSH_WORKBENCH_MATTERS || join(PWB_DIR, 'matters.json')
const PWB_MACTIONS = process.env.DSH_WORKBENCH_MATTER_ACTIONS || join(PWB_DIR, 'matter-actions.json')
// ── 业务对象层产物（聚合平面 · 2026-09-16）：卡片按需取数，host 只做透传，不加工 ──
const PWB_OBJECTS = join(PWB_DIR, 'objects.json')
const PWB_DISPOSITION = join(PWB_DIR, 'disposition.json')
const PWB_CROSSCHECK = join(PWB_DIR, 'crosscheck.json')
const PWB_DOMAIN_HEALTH = join(PWB_DIR, 'domain-health.json')
const PWB_BRIEF = join(PWB_DIR, 'brief.json')
// 决策卡（2026-09-17 改名）读的就是 `brief.json`。**写操作之后必须把它重建**，否则卡上还是旧世界
// （条目关了/重定了截止却仍在原来的桶里）—— 用的就是 run-objects-pipeline 里那一步的**同一个文件**，
// 本层不复制它的任何判定（实测 ~120ms，且对同一组输入逐字节可复现）。
const PWB_BRIEF_BUILD = process.env.DSH_WORKBENCH_BRIEF_BUILD || join(KNOWLEDGE, '_meta', 'workbench', 'build-brief.mjs')
const PWB_INSIGHTS = join(PWB_DIR, 'insights.json')
const PWB_MATTER_CLI = process.env.DSH_WORKBENCH_MATTER_CLI || join(KNOWLEDGE, '_meta', 'workbench', 'cli-matter.mjs')
// ── 触发响应写入口（T32 · 2026-09-16）───────────────────────────────────────
//   triggers.json 是**判断层产物**（每次管线重建从零派生）⇒ 人工响应不得直改产物，
//   必须写登记表 `trigger-responses.json`，再由管线步骤 `apply-trigger-responses.mjs` 回放
//   —— 与 matter-overrides 完全同构（写通道单一：面板与 DSH 工具共用 cli-trigger.mjs）。
//   分组（已超时 / 今日到期 / 其它未响应）由 CLI 用**冻结层选择器**算好，host 只透传；
//   用户在面板里写的中文走 `--from-json`（Windows 传非 ASCII argv 可能被转码，与 cli-matter 同处理）。
const PWB_TRIGGERS = process.env.DSH_WORKBENCH_TRIGGERS || join(PWB_DIR, 'triggers.json')
const PWB_TRIGGER_REG = process.env.DSH_WORKBENCH_TRIGGER_RESPONSES || join(PWB_DIR, 'trigger-responses.json')
const PWB_TRIGGER_CLI = process.env.DSH_WORKBENCH_TRIGGER_CLI || join(KNOWLEDGE, '_meta', 'workbench', 'cli-trigger.mjs')
const PWB_TRIGGER_REQ = join(PWB_DIR, '.runtime', 'trigger-request.json')
const TRIGGER_ID_RE = /^TR-[A-Za-z0-9-]{1,40}$/
const TRIGGER_CACHE_MS = Number(process.env.DSH_WORKBENCH_TRIGGER_CACHE_MS || 15000)
// 待议流入的处置写入口（2026-09-16 · 流入卡专用）：
//   闸判 `pending`（未命中任何关注域、需人定边界）后，系统里原本**没有任何出口** ——
//   `gate.resolvePending()` 只在测试 run-t4.mjs 里被调用，host 无路由、库里无 CLI。
//   本路由转调 cli-disposition.mjs（它负责"必须写理由 / 只能处置 pending / id 碰撞要 --source"三条纪律）。
const PWB_DISP_CLI = process.env.DSH_WORKBENCH_DISP_CLI || join(KNOWLEDGE, '_meta', 'workbench', 'cli-disposition.mjs')
// 判断质量台账（T31 建议 5）：产物 + 唯一写入口 CLI（与 DSH 工具/面板共用 ⇒ P2 单真相源）
const PWB_FEEDBACK = join(PWB_DIR, 'feedback.json')
const PWB_FEEDBACK_CLI = process.env.DSH_WORKBENCH_FEEDBACK_CLI || join(KNOWLEDGE, '_meta', 'workbench', 'cli-feedback.mjs')
// 卡片顺序**覆盖层**（2026-09-16 用户裁定：面板可拖动排序）——
//   默认顺序在 client 的 `CARD_ORDER`（契约，被断言）；本文件只是用户覆盖，只影响渲染。
//   落 host 的理由：跨刷新/跨设备一致，且**可读可断言**（localStorage 读不出来也测不了）。
const PWB_UI_PREFS = process.env.DSH_WORKBENCH_UI_PREFS || join(PWB_DIR, 'ui-prefs.json')
// ⚠️ 已知卡片 key 的**唯一来源是 client 的 CARD_ORDER**（默认顺序表）。这里重复一份是为了
//    在 host 侧做"未知 key 忽略"的校验（host 不引入 client 的 React 依赖）。
//    T16-59 会断言两者**逐项一致** ⇒ 将来新增卡片而忘了同步，回归会红，不会静默失配。
//    ⚠️ 顺序敏感：必须与 client.js 的 CARD_ORDER **逐项**一致（同步自「用户裁定 2026-09-16 · 三带布局」）。
//    这份表漏改的后果不是报错而是**静默丢卡**：`/ui-prefs` 会用本表过滤覆盖层，
//    本表里没有的 key 会被当成"未知 key"忽略 ⇒ 用户拖动过的卡片位置失效、甚至退回默认。
const KNOWN_CARD_KEYS = ['brief', 'triggers', 'matters', 'schedule', 'todos', 'focus', 'objects', 'inflow', 'insights', 'recall', 'domains', 'metrics', 'kb', 'minutes', 'system']
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
const TODO_DIR = process.env.DSH_WORKBENCH_TODO_DIR || join(KNOWLEDGE, 'Other', 'Todo')
const PWB_TODO_CLI = process.env.DSH_WORKBENCH_TODO_CLI || join(KNOWLEDGE, '_meta', 'workbench', 'cli-todo.mjs')
// 待办回写动作台账（成功/失败都记）：既是审计留痕，也是「最近关闭 → 可重新打开」的数据源
const PWB_TODO_ACTIONS = process.env.DSH_WORKBENCH_TODO_ACTIONS || join(PWB_DIR, 'todo-actions.json')
const PWB_MATTER_OVR = process.env.DSH_WORKBENCH_MATTER_OVERRIDES || join(PWB_DIR, 'matter-overrides.json')
// 关闭条件求值（2026-09-15 需求）：库内 CLI，复用适配器观测判定 —— 本层不复制 marker 匹配逻辑
const PWB_MATTER_CHECK_CLI = process.env.DSH_WORKBENCH_MATTER_CHECK_CLI || join(KNOWLEDGE, '_meta', 'workbench', 'cli-matter-check.mjs')
// 自动检测节流（自测里设为 0 可让每次指纹变化都触发）
const AUTO_CHECK_MS = Number(process.env.DSH_WORKBENCH_AUTOCHECK_MS || 60000)
// 周期兜底检测间隔（2026-09-15 需求）：关闭条件的证据是**产出物落盘**，那不是"流入事件"，
// 不会触发 ingest 派生 —— 所以必须有一个定时检测点，否则只能等面板被打开/有人跑管线才被发现。
const CHECK_INTERVAL_MS = Number(process.env.DSH_WORKBENCH_CHECK_INTERVAL_MS || 300000)
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
$K = $env:DSH_WORKBENCH_KNOWLEDGE
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

/** Run any executable; never rejects. */
function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs || 180000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: err === null,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: err === null ? null : String(err.message || err),
      })
    })
  })
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
    const r = await ps(['-NoProfile', '-NonInteractive', '-Command',
      "$d = (Get-Command dws -ErrorAction SilentlyContinue); if (-not $d) { $c = Join-Path (Join-Path $env:APPDATA 'npm') 'dws.cmd'; if (Test-Path $c) { $d = $c } }; " +
      "$dv = if ($d) { (& $d --version 2>&1 | Out-String).Trim() } else { '' }; " +
      "$nv = (node --version 2>&1 | Out-String).Trim(); $np = (npm --version 2>&1 | Out-String).Trim(); $gv = (git --version 2>&1 | Out-String).Trim(); " +
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
      error: `未找到或无法解析 ${PWB_SNAPSHOT} —— 先运行 node _meta/workbench/build-snapshot.mjs`,
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
const LARK_CLI = process.env.DSH_WORKBENCH_LARK_CLI || 'lark-cli'
// 钉钉 CLI（待办源头回写用：`dws todo task done --task-id … --status true|false`）
const DWS_CLI = process.env.DSH_WORKBENCH_DWS_CLI || 'dws'

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
  const script = "$ErrorActionPreference='SilentlyContinue'; try { [Console]::OutputEncoding=[Text.Encoding]::UTF8 } catch {}; "
    + `& ${LARK_CLI} calendar +agenda --start ${from} --end ${to} --as user --format json 2>&1 | Out-String`
  const r = await ps(['-NoProfile', '-NonInteractive', '-Command', script], 60000)
  const parsed = parseLarkAgenda(parseJsonLoose(r.stdout))
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
  const script = "$ErrorActionPreference='SilentlyContinue'; try { [Console]::OutputEncoding=[Text.Encoding]::UTF8 } catch {}; "
    + `& ${LARK_CLI} auth status --json 2>&1 | Out-String`
  const r = await ps(['-NoProfile', '-NonInteractive', '-Command', script], 20000)
  const j = parseJsonLoose(r.stdout)
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
  const script = "$ErrorActionPreference='SilentlyContinue'; try { [Console]::OutputEncoding=[Text.Encoding]::UTF8 } catch {}; "
    + `& ${LARK_CLI} task tasks get --task-guid ${guid} --as user --format json 2>&1 | Out-String`
  const r = await ps(['-NoProfile', '-NonInteractive', '-Command', script], 45000)
  const d = parseLarkTaskDetail(parseJsonLoose(r.stdout))
  return d.ok === true ? d : null
}

/** 详情补齐的条数上限（**规模化保护**：列表接口不返回 due ⇒ 只能逐条取，必须封顶） */
const FEISHU_DETAIL_CAP = Number(process.env.DSH_WORKBENCH_FEISHU_DETAIL_CAP || 6)

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
  const script = "$ErrorActionPreference='SilentlyContinue'; try { [Console]::OutputEncoding=[Text.Encoding]::UTF8 } catch {}; "
    + `& ${LARK_CLI} task +get-related-tasks --include-complete=false --page-limit 5 --as user --format json 2>&1 | Out-String`
  const r = await ps(['-NoProfile', '-NonInteractive', '-Command', script], 60000)
  const parsed = parseLarkTasks(parseJsonLoose(r.stdout), selfId)
  if (parsed.ok === true && parsed.items.length > 0) {
    try { await enrichFeishuTasks(parsed.items) } catch { /* 补齐失败不降级主数据 */ }
  }
  return {
    ...parsed,
    scopeNote: '个人视角（与我相关：负责/创建/关注）· 仅未完成',
    detailNote: `截止时间由详情接口逐条补齐（列表接口实测不返回 due），上限 ${FEISHU_DETAIL_CAP} 条`,
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

/** 组织全名 → 简称（通用规则；仅用于展示，不做归属判定） */
function shortOrg(corpName) {
  const n = String(corpName || '')
  if (n.length === 0) return '未知组织'
  // 通用剥离：地域前缀 + 常见机构后缀（不针对任何具体公司）
  const s = n
    .replace(/^[\u4e00-\u9fa5]{2,5}(市|省)/, '')
    .replace(/(股份|有限|责任|集团|控股|科技|网络|信息|技术|实业|公司)/g, '')
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
  const data = run.ok === true ? parseJsonLoose(run.stdout) : null

  if (data === null) {
    const why = run.error || run.stderr.trim() || 'no json'
    return {
      ok: true,
      at: Date.now(),
      diag: `script failed: ${String(why).slice(0, 300)}`,
      knowledgePath: KNOWLEDGE,
      hermesUrl: HERMES_URL,
      calendar: { today: [], tomorrow: [], orgs: [], days: [], counts: { dingtalk: 0, feishu: 0, trip: 0 }, feishu: { ok: false, error: 'host 采集脚本失败，飞书日程未取', authorized: null, items: [] } },
      todos: { items: [], orgs: [], files: [], feishu: { ok: false, authorized: null, error: 'host 采集脚本失败，飞书任务未取', items: [] }, counts: { dingtalk: 0, feishu: 0, personal: 0 } },
      minutes: { items: [] },
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

  const minRaw = parseJsonLoose(data.minutes)
  const rawMinutes = minRaw && Array.isArray(minRaw.minutes) ? minRaw.minutes : []
  const minutes = rawMinutes.slice(0, 10).map((m) => ({
    title: String((m && m.title) || ''),
    start: num(m && m.startTime),
    url: String((m && m.url) || ''),
  }))

  // 飞书日历：与钉钉并行采集（任一源失败不影响另一源 —— 诚实降级）
  const feishu = await collectFeishuCalendar()
  for (const e of (feishu.items || [])) calEvents.push(e)

  // 飞书任务（待办第二源，2026-09-15 用户要求）：与钉钉待办并列，失败如实上报
  const feishuTasks = await collectFeishuTasks()
  const personalTodos = await collectPersonalTodos()
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
  const next3 = bucketByNext3Days(calEvents, new Date())
  const days = next3.days
  const today = next3.today
  const tomorrow = next3.tomorrow
  const calCounts = next3.counts

  return {
    ok: true,
    at: Date.now(),
    diag: `PS ${String(data.psVersion || '?')} · 组织 ${perOrg.length} · 待办 ${todos.length}(未完成 ${todos.filter((t) => !t.done).length})`
      + ` · 日程(近三天) 钉钉${calCounts.dingtalk} 飞书${feishu.ok ? calCounts.feishu : (feishu.authorized === false ? '未授权' : '读取失败')} 行程${calCounts.trip}`
      + ` · files=${num(data.totalFiles)}`,
    knowledgePath: KNOWLEDGE,
    hermesUrl: HERMES_URL,
    // days = 近三天（今天/明天/后天）的三源聚合结果；today/tomorrow 保留给旧消费方
    calendar: { today, tomorrow, days, counts: calCounts, orgs: calOrgs, trips, feishu },
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
    minutes: { items: minutes },
    knowledge: {
      total: num(data.totalFiles),
      counts: data.counts || {},
      recent: Array.isArray(data.recent) ? data.recent : [],
      byCategory: data.byCategory || {},
    },
  }
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
  // 数据层有自己的缓存（与钉钉取数解耦：钉钉贵、读产物便宜）
  const pwbCache = { at: 0, data: null }
  // 待响应触发清单缓存（T32）：`/triggers` 要转调 CLI（起一个 node 进程）才能拿到
  // 冻结层算出的分组，不能每次渲染都跑。写路由（/trigger/respond）会主动清掉它。
  const triggerCache = { at: 0, data: null }

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
        ctx.logger?.info?.(`dsh-workbench: 关闭条件命中 ${c.id} → ${r.ok === true ? '已自动关闭并记录证据' : '关闭失败: ' + String(r.error || '')}`)
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

  async function snapshot(force) {
    const fresh = cache.data !== null && Date.now() - cache.at < CACHE_MS
    if (force !== true && fresh) return cache.data
    if (cache.inflight !== null) return cache.inflight
    const pending = collect()
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
        + '写操作经由库内 _meta/workbench/cli-todo.mjs —— 与"手动往 Other/Todo/ 放文件"是同一个真相源。',
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
        + '写操作经由库内 _meta/workbench/cli-focus.mjs（与面板按钮同一通道，单真相源）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['declare', 'end', 'status'], description: 'declare=声明专注（另需 kind/id） · end=结束当前专注 · status=查看状态' },
          kind: { type: 'string', enum: ['domain', 'project', 'matter'], description: '专注目标类型（declare 时必填）：domain=关注域 · project=项目 · matter=具体事务' },
          id: { type: 'string', description: '专注目标 id（declare 时必填）：关注域 id（如 qianwen-office）/ 项目路径 / 事务 id' },
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
        + '**add 必须遵守 `Research/Output/个人工作台/02-规范与标准/SPEC_会话新增事务.md`**：'
        + '① 查重（给 dedup_key / origin_inbound / 具体 source_ref，命中即幂等返回既有 id，不新建）；'
        + '② 不要自己编号（系统原子预留 MT-M-###）；③ domain 必须已在 domains.yml 且 active；'
        + '④ done_when 必须可机器求值（含路径/产出物/编号/计数/可观测状态，禁用"完成即可/尽快"）；'
        + '⑤ 至少一条**具体**溯源（只有 origin_project 目录级不算）；⑥ 新增后可跑 cli-matter-check 自检。'
        + '过期事务的关闭必须带 note（结束反馈记录）—— 由库内 M7d 机制强制。'
        + '写操作经由库内 _meta/workbench/cli-matter.mjs（与面板按钮同一通道，单真相源）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'close', 'reopen', 'overdue', 'status'], description: 'add=新增（按 SPEC 受理）· close=关闭（过期事务必须带 note）· reopen=重新打开 · overdue=列出已过期未关闭事务 · status=查看单个事务' },
          id: { type: 'string', description: '事务 id（close/reopen/status 时必填，如 MT-20250101-001；add 时留空则系统预留 MT-M-###）' },
          note: { type: 'string', description: '关闭时的结束反馈记录（1–1000 字；**过期事务必填**，否则被 M7d 拒绝）' },
          title: { type: 'string', description: 'add 必填：标题，形如「示例客户-0913 · 场次配置单」' },
          domain: { type: 'string', description: 'add 必填：关注域 id（须已在 domains.yml 且 status: active）' },
          done_when: { type: 'string', description: 'add 必填：关闭条件（可机器求值，例「Work/<客户>/Output/场次/X 出现 00-场次配置单.md」）' },
          origin_inbound: { type: 'string', description: 'add：流入 id（如 IN-20250101-001）——同时充当去重键' },
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
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: async (req, res) => {
      let url
      try { url = new URL(req.url || '/', 'http://127.0.0.1') } catch { sendJson(res, 400, { error: 'bad url' }); return }
      const path = url.pathname.slice(ROUTE.length)

      if (path === '/snapshot') {
        sendJson(res, 200, await snapshot(url.searchParams.get('force') === '1'))
        return
      }

      // ── 库内仪表盘（驾驶舱 HTML）：只读产物，供 better-sidebar「驾驶舱」tab 内嵌 ──
      // 自包含页面（零外链），故直接回 HTML；不缓存，重建后刷新即得新内容。
      if (path === '/dashboard' && req.method === 'GET') {
        let html = null
        try { html = await readFile(PWB_DASHBOARD, 'utf8') } catch { /* 尚未生成 */ }
        if (html === null) {
          sendJson(res, 200, { ok: false, error: '未找到 ' + PWB_DASHBOARD + ' —— 先运行 _meta/workbench/build-snapshot.mjs' })
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
      //    /objects      对象索引（15 个对象 + byRecord 查询表）→ 对象卡 / 事务分组 / 触发行标签
      //    /disposition  处置台账（处置率 / 无落点清单 / 活跃域排序）→ 流入卡 / 指标卡
      //    /crosscheck   多源校验（溯源 / 支撑 / 计划↔实际 / 承诺↔交付 / 矛盾）→ 指标卡 / 待定夺区块
      //    /domain-health 域健康度（观察面 + 建议 + 域→对象下钻面）→ 活跃关注域卡
      if (path === '/objects') {
        const doc = await readJson(PWB_OBJECTS)
        sendJson(res, doc ? 200 : 503, doc ?? { error: 'objects.json 尚未生成（跑 node _meta/workbench/run-objects-pipeline.mjs）' })
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
        sendJson(res, doc ? 200 : 503, doc ?? { error: 'brief.json 尚未生成（跑 node _meta/workbench/run-objects-pipeline.mjs）' })
        return
      }
      if (path === '/insights') {
        const doc = await readJson(PWB_INSIGHTS)
        sendJson(res, doc ? 200 : 503, doc ?? { error: 'insights.json 尚未生成（跑 node _meta/workbench/run-objects-pipeline.mjs）' })
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

      sendJson(res, 404, { error: 'unknown route' })
    },
  }))

  ctx.logger?.info?.(`dsh-workbench: routes mounted at ${ROUTE} (knowledge=${KNOWLEDGE})`)
}

// 纯函数测试钩子：飞书日历解析在 Node 里可直接验证（selftest-lark.mjs，无需真机数据）。
// 模块加载契约只用 apply/inject/name，附加导出不影响加载。
export const __test = { parseLarkAgenda, parseLarkTasks, parseLarkTaskDetail, enrichFeishuTasks, parsePersonalTodoText, todoWritePolicy, pickRecentClosed, ledgerTitle, collectPersonalTodos, classifyTodoItems, toIso, toLoc, ymdLocal, collectFeishuCalendar, collectFeishuTasks, eventsFromAgenda, bucketByNext3Days, collect, SCRIPT, mergeUiPrefs, shouldRebuildBrief, KNOWN_CARD_KEYS, UI_PREF_FIELDS }
