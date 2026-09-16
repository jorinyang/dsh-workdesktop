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
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
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
const PWB_INSIGHTS = join(PWB_DIR, 'insights.json')
const PWB_MATTER_CLI = process.env.DSH_WORKBENCH_MATTER_CLI || join(KNOWLEDGE, '_meta', 'workbench', 'cli-matter.mjs')
// 待议流入的处置写入口（2026-09-16 · 流入处置卡专用）：
//   闸判 `pending`（未命中任何关注域、需人定边界）后，系统里原本**没有任何出口** ——
//   `gate.resolvePending()` 只在测试 run-t4.mjs 里被调用，host 无路由、库里无 CLI。
//   本路由转调 cli-disposition.mjs（它负责"必须写理由 / 只能处置 pending / id 碰撞要 --source"三条纪律）。
const PWB_DISP_CLI = process.env.DSH_WORKBENCH_DISP_CLI || join(KNOWLEDGE, '_meta', 'workbench', 'cli-disposition.mjs')
// 判断质量台账（T31 建议 5）：产物 + 唯一写入口 CLI（与 DSH 工具/面板共用 ⇒ P2 单真相源）
const PWB_FEEDBACK = join(PWB_DIR, 'feedback.json')
const PWB_FEEDBACK_CLI = process.env.DSH_WORKBENCH_FEEDBACK_CLI || join(KNOWLEDGE, '_meta', 'workbench', 'cli-feedback.mjs')
// 个人待办目录 + 其唯一写入口（手动放置 / 会话内创建 同一真相源）
const TODO_DIR = process.env.DSH_WORKBENCH_TODO_DIR || join(KNOWLEDGE, 'Other', 'Todo')
const PWB_TODO_CLI = process.env.DSH_WORKBENCH_TODO_CLI || join(KNOWLEDGE, '_meta', 'workbench', 'cli-todo.mjs')
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
  $t = (& $dws todo +get-my-tasks --profile $pf.profile --role-types creator,executor,participant --status false --size 50 2>&1 | Out-String)
  # 个人视角日程：+agenda（默认 primary 主日历，即"我的日程"），逐组织拉，
  # 后续在 JS 里按日期归并为 今天/明天 两栏（并保留组织标签）。
  $ag = (& $dws calendar +agenda --profile $pf.profile --start $agStart --end $agEnd --limit 100 2>&1 | Out-String)
  $perOrg += [ordered]@{ corpId = $pf.corpId; corpName = $pf.corpName; status = $pf.status; todos = $t; agenda = $ag }
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

/** 关闭 + 立即重建快照（面板事务卡读 snapshot.json，不重建会显示旧状态） */
async function closeMatterViaCli(id, note) {
  const args = ['close', '--id', id, '--file', PWB_MATTERS, '--overrides', PWB_MATTER_OVR]
  if (typeof note === 'string' && note.trim().length > 0) args.push('--note', note.trim().slice(0, 1000))
  const r = await run(NODE, [PWB_MATTER_CLI, ...args], 60000)
  const j = parseJsonLoose(r.stdout)
  if (j !== null && j.ok === true) await run(NODE, [PWB_BUILD], 180000)
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
 * 数据层状态：**只读驾驶舱产物**，不重新派生。
 *
 * 返回里刻意带上 `dataAsOf` 与 `staleMs` —— 渲染层据此显示"数据有多旧"，
 * 而不是把一份陈旧快照当实时数据展示（V5 审计里那条教训：陈旧数据必须对读者可见）。
 */
async function workbenchState() {
  const snap = await readJson(PWB_SNAPSHOT)
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
    focus: snap.focus ?? null,
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
      metrics: Array.isArray(metrics.metrics) ? metrics.metrics : [],
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
  let todoClosed = 0

  for (const org of perOrg) {
    const label = shortOrg(org && org.corpName)
    const tj = parseJsonLoose(org && org.todos)
    const arr = tj && Array.isArray(tj.todos) ? tj.todos : []
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
      //   已完成的**不进列表**但计数留存（`counts.dingtalkClosed`），不静默丢失信息。
      if (done) { todoClosed += 1; continue }
      open += 1
      todos.push({ title: String(t.subject || t.title || ''), due: num(t.dueTime), done: false, org: label })
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
      counts: {
        // dingtalk = **未完成**条数（= items.length，两条口径一致）
        dingtalk: todos.length,
        // 已完成（= 已关闭）计数：不展示，但留存供诊断/将来"已关闭"视图
        dingtalkClosed: todoClosed,
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
        if (args.action === 'declare') {
          const domains = Array.isArray(args.domains) ? args.domains : null
          if (!domains || domains.length === 0 || !domains.every((d) => d && typeof d.id === 'string')) {
            return { ok: false, error: 'declare 需要 domains 数组，每项 {id, label?}' }
          }
          const argv = ['declare', '--domains', JSON.stringify(domains.map((d) => ({ id: String(d.id), label: String(d.label ?? d.id) })))]
          if (typeof args.note === 'string' && args.note.trim()) argv.push('--note', args.note.trim().slice(0, 200))
          const r = await run(NODE, [PWB_AD_CLI, ...argv], 30000)
          return parseJsonLoose(r.stdout) ?? { ok: false, error: String(r.error || r.stderr || 'no output').slice(0, 300) }
        }
        if (args.action === 'clear') {
          const r = await run(NODE, [PWB_AD_CLI, 'clear'], 30000)
          return parseJsonLoose(r.stdout) ?? { ok: false, error: String(r.error || r.stderr || 'no output').slice(0, 300) }
        }
        if (args.action === 'match-now') {
          const j = await matchActiveDomains(true)
          return j
        }
        return await readJson(PWB_AD_DOC) ?? { ok: true, empty: true, effective: [] }
      },
    }))

    // ── DSH 工具：事务处置（C3 闭环 · 批次二第 ① 块）──
    // close/reopen 走库内 cli-matter.mjs（与面板按钮同一通道，单真相源）；
    // M7d 机制在库内强制：过期事务关闭必须带结束反馈记录。
    ctx.effect(() => tools.register({
      name: 'workbench_matter',
      description: '个人工作台「事务处置」入口（C3 闭环）：close 关闭事务 / reopen 重新打开已关闭事务 / '
        + 'overdue 列出已过期且未关闭的事务 / status 查看单个事务。'
        + '过期事务的关闭必须带 note（结束反馈记录）—— 由库内 M7d 机制强制，写不出反馈会被拒绝。'
        + '写操作经由库内 _meta/workbench/cli-matter.mjs（与面板按钮同一通道，单真相源）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['close', 'reopen', 'overdue', 'status'], description: 'close=关闭（过期事务必须带 note）· reopen=重新打开 · overdue=列出已过期未关闭事务 · status=查看单个事务' },
          id: { type: 'string', description: '事务 id（close/reopen/status 时必填，如 MT-20250101-001）' },
          note: { type: 'string', description: '关闭时的结束反馈记录（1–1000 字；**过期事务必填**，否则被 M7d 拒绝）' },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
      },
      timeoutMs: 30000,
      async execute(args) {
        let argv = ['overdue']
        if (args.action === 'close') {
          const id = String(args.id || '').trim()
          if (id.length === 0) return { ok: false, error: 'close 需要 id' }
          argv = ['close', '--id', id]
          if (typeof args.note === 'string' && args.note.trim().length > 0) argv.push('--note', args.note.trim().slice(0, 1000))
        } else if (args.action === 'reopen') {
          const id = String(args.id || '').trim()
          if (id.length === 0) return { ok: false, error: 'reopen 需要 id' }
          argv = ['reopen', '--id', id]
        } else if (args.action === 'status') {
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
      //    /disposition  处置台账（处置率 / 无落点清单 / 活跃域排序）→ 流入处置卡 / 指标卡
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
          await run(NODE, [PWB_BUILD], 180000)
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

      if (path === '/matter/reopen' && req.method === 'POST') {
        const body = parseJsonLoose(await readBody(req)) || {}
        const id = String(body.id || '')
        if (!MATTER_ID_RE.test(id)) { sendJson(res, 200, { ok: false, error: 'bad matter id' }); return }
        const r = await run(NODE, [PWB_MATTER_CLI, 'reopen', '--id', id, '--file', PWB_MATTERS, '--overrides', PWB_MATTER_OVR], 30000)
        const j = parseJsonLoose(r.stdout)
        if (j && j.ok === true) {
          await run(NODE, [PWB_BUILD], 180000)
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

      // 幂等重建：跑库内 build-snapshot.mjs。
      // ⚠️ 这是**重建**（输入的确定性函数），不是状态变更 —— 与 P2「写操作归 DSH」不冲突：
      //    它由 DSH 侧的 host 半段触发，且 HTML 侧仍是只读的。
      if (path === '/rebuild' && req.method === 'POST') {
        const r = await run(NODE, [PWB_BUILD], 180000)
        pwbCache.data = null
        pwbCache.at = 0
        const tail = (r.stdout + r.stderr).trim().split('\n').slice(-4).join(' | ')
        sendJson(res, 200, { ok: r.ok, error: r.ok ? null : String(r.error || tail).slice(0, 300), tail: tail.slice(0, 400) })
        return
      }

      // ── 待议流入的处置（流入处置卡 · 2026-09-16）────────────────────────
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
          await run(NODE, [PWB_BUILD], 180000)
          pwbCache.data = null
          pwbCache.at = 0
        }
        sendJson(res, 200, j === null
          ? { ok: false, error: String(r.error || r.stderr || 'no output').slice(0, 300) }
          : j)
        return
      }

      sendJson(res, 404, { error: 'unknown route' })
    },
  }))

  ctx.logger?.info?.(`dsh-workbench: routes mounted at ${ROUTE} (knowledge=${KNOWLEDGE})`)
}

// 纯函数测试钩子：飞书日历解析在 Node 里可直接验证（selftest-lark.mjs，无需真机数据）。
// 模块加载契约只用 apply/inject/name，附加导出不影响加载。
export const __test = { parseLarkAgenda, parseLarkTasks, parseLarkTaskDetail, enrichFeishuTasks, parsePersonalTodoText, collectPersonalTodos, toIso, toLoc, ymdLocal, collectFeishuCalendar, collectFeishuTasks, eventsFromAgenda, bucketByNext3Days, collect, SCRIPT }
