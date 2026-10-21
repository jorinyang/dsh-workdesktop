/**
 * dsh-mi-remote · 宿主半段
 *
 * 「小米遥控器」面板的后端。三个能力域，全部走 /mi-remote/api：
 *
 *   一、链路体检（/link）    ：遥控器配对（蓝牙 VID_2717）· SayAll 安装/运行 ·
 *                              VB-CABLE · 微信输入法 —— SayAll Windows 的链路有四段，
 *                              哪段缺了面板上说哪段。执行器：audio/probe.ps1。
 *   二、语音输入路径（/voice/*）：把系统默认录音设备切到 CABLE Output / UU远程虚拟音频 /
 *                              本地麦克风（三条路径的切换点）。执行器：audio/audio-device.ps1。
 *   三、按键映射（/mapping）  ：遥控器 11 键 × 单击/双击/长按 → DSH 动作/组合键/打开应用。
 *                              落盘 %LOCALAPPDATA%\dsh-mi-remote\mapping.json。
 *                              真正执行注入的是 SayAll（装好后把这里的方案照着录进去）；
 *                              这份落盘是「方案的单一真相源」，导出/对录都以它为准。
 *
 * ⚠️ 两个 .ps1 都是「UTF-8 带 BOM」硬要求（PS 5.1 无 BOM 按 ANSI 解，中文会烂）。
 *   改完跑 `node fix-bom.mjs`。
 *
 * 运行期参数（环境变量，不需要 Config schema）：
 *   DSH_MIREMOTE_PS            powershell.exe 路径（默认系统 Windows PowerShell 5.1）
 *   DSH_MIREMOTE_SCRIPT_DIR    两个 .ps1 所在目录（默认本包 audio/）
 *   DSH_MIREMOTE_STATE_DIR     mapping 与路由状态目录（默认 %LOCALAPPDATA%\dsh-mi-remote）
 *   DSH_MIREMOTE_CACHE_MS      读取缓存时长（默认 8000）
 *   DSH_MIREMOTE_DEADLINE_MS   单次执行器超时（默认 20000）
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, openSync, closeSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本插件的 HTTP 路由前缀。 */
export const ROUTE = '/mi-remote/api'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')

/* ── 语音路径：远程麦克风类设备的识别规则（与原 dsh-remote-mic 一致，只有一个产地）── */

export const REMOTE_MIC_PATTERN = /(cable\s*(out|output|in)|vb-?audio|vb-?cable|虚拟音频|uu远程|virtual\s*audio|virtual\s*cable|wireless\s*mic|远程麦克风|无线麦|mi\s*remote)/i

const SOURCE_HINTS = [
  { re: /cable\s*(out|output)|vb-?audio|vb-?cable/i, source: 'sayall', label: '无线麦 SayAll' },
  { re: /uu远程/i, source: 'uuremote', label: 'UU远程' },
  { re: /虚拟音频|virtual\s*audio|virtual\s*cable/i, source: 'virtual', label: '虚拟声卡' },
  { re: /wireless\s*mic|远程麦克风|无线麦|mi\s*remote/i, source: 'wireless', label: '无线麦' },
]

export const isRemoteMicName = (name) => REMOTE_MIC_PATTERN.test(String(name || ''))

export const sourceOf = (name) => {
  const text = String(name || '')
  for (const hint of SOURCE_HINTS) if (hint.re.test(text)) return { source: hint.source, label: hint.label }
  return { source: 'other', label: '其他输入' }
}

/* ── 按键映射：DSH 快捷键预设 ────────────────────────────────────────────────
 *
 * ⚠️ 2026-10-11 全部重核（查的是 D:\deepseek-harness\packages\client\*\src\**\apply.ts）。
 *
 * 之前这份表是**凭印象写的**，里面有几个 DSH 根本不存在的命令，所以按下遥控器毫无反应：
 *     dsh.newSession / dsh.searchSessions —— DSH 里没有这两个命令
 *     dsh.toggleLeft / toggleRight / openWorkspace —— 命令存在，但**没有默认键位**，
 *                                                     必须用户自己在 DSH 里绑，否则没人听
 * 而 DSH 的快捷键是"命令 + 用户绑键"，存在浏览器 localStorage 的 `dsh.keybindings.v1` 里。
 *
 * DSH 真正**内置**的键位（不用绑就能用）：
 *     fixed.send           Enter
 *     fixed.newline        Shift+Enter
 *     fixed.complementary  Ctrl+Enter
 *     fixed.slash          /
 *     fixed.mention        @
 *     response.stop        **Esc Esc（连着按两下）**，不是单按
 * 其余命令（sidebar.left.toggle / sidebar.right.toggle / workspace.openLocal / settings.open /
 * terminal.new / browser.new / workspace.files / approval.* / shortcuts.open）都要用户自己绑。
 *
 * 所以下面分两类，`needsBind` 标出"必须先绑"的 —— 面板会照着显示，用户绑完就能用。
 */
export const DSH_PRESETS = [
  /*
   * ⚠️⚠️ 下面这些 `combo` **必须**与 DSH 源码里那个命令的 `defaults` 逐字对上。
   *
   * 2026-10-11 发现：这张表原来有 **6 条是编的** —— 当时没去查 DSH 源码，凭印象写了一组
   * 看起来合理的组合键。后果是用户照着面板去 DSH 里绑键、绑到一个根本不存在的组合，
   * 按下去毫无反应（他报"快捷键未生效"里就有这一部分）。
   *
   * 每一条的依据（都是 `defaults['web:windows']`）：
   *   sidebar.left.toggle    ui-layout/src/client/index.ts:190        KeyB + primary,alt
   *   sidebar.right.toggle   ui-sidebar-right/src/client/shortcuts.ts:34  KeyB + primary,shift
   *   workspace.openLocal    ui-open-in-app/src/client/index.ts:70    KeyO + primary,shift
   *   settings.open          ui-settings-general/src/client/index.ts:186  Comma + primary,alt
   *   shortcuts.open         ui-shortcuts/src/client/index.ts:54      Slash + primary
   *   terminal.new           ui-sidebar-terminal/src/client/index.ts:61   Backquote + control
   * 改这张表之前，先去那几行看一眼。**凭印象写就是上一次出错的原因。**
   */

  // ── 内置键位：不用绑，配了就能用 ──
  { id: 'dsh.send',          label: '发送消息（Enter）',        combo: 'Enter',            builtin: true },
  { id: 'dsh.newline',       label: '换行（Shift+Enter）',      combo: 'Shift+Enter',      builtin: true },
  { id: 'dsh.stopReply',     label: '停止回复（Esc 连按两下）', combo: 'Esc+Esc',          builtin: true },
  /*
   * ── 批准 / 拒绝：**由本插件注册，有默认键位、可绑可改** ──
   *
   * 为什么不是 DSH 自带的 `approval.allow` / `approval.reject`：
   * 那两个用 `shortcuts.registerFixed`（ui-approval/src/client/index.ts:81/84）注册，
   * 定义是"只读输入动作，键位**不可**被分配给可编辑命令"，在 `definitions()` 里报
   * `defaults: {}` —— **DSH 设置页里没有它们的可绑项**，用户配不了。
   *
   * 本插件改为注册自己的两条普通命令（客户端半段 `remote.approval.allow` /
   * `remote.approval.reject`），默认键位就是下面这两个组合，用户可以改。
   * 它们**只在真有批准请求时才做事**，所以没有"按一下把消息发出去"那种副作用。
   *
   * 2026-10-11 用户选定此方案（B）；在那之前这两条写的是 `Ctrl+Alt+Y` / `Ctrl+Alt+X`
   * 加 `needsBind`，属于编造 —— 那两个命令根本不可绑，照着绑必然没反应。
   */
  { id: 'dsh.approve',       label: '批准（允许一次）',         combo: 'Ctrl+Alt+Y',     builtin: true },
  { id: 'dsh.reject',        label: '拒绝',                     combo: 'Ctrl+Alt+X',     builtin: true },
  // ── 需要先在 DSH 里绑键（设置 → 快捷键）；键位必须与 DSH 源码一致，见上面的依据表 ──
  { id: 'dsh.toggleLeft',    label: '开关左侧栏',               combo: 'Ctrl+Alt+B',     needsBind: 'sidebar.left.toggle' },
  { id: 'dsh.toggleRight',   label: '开关右侧栏（工作台在这）', combo: 'Ctrl+Shift+B',   needsBind: 'sidebar.right.toggle' },
  { id: 'dsh.openLocal',     label: '在本地打开工作区',         combo: 'Ctrl+Shift+O',   needsBind: 'workspace.openLocal' },
  { id: 'dsh.openSettings',  label: '打开设置',                 combo: 'Ctrl+Alt+,',     needsBind: 'settings.open' },
  { id: 'dsh.openShortcuts', label: '打开快捷键设置',           combo: 'Ctrl+/',         needsBind: 'shortcuts.open' },
  { id: 'dsh.newTerminal',   label: '新建终端',                 combo: 'Ctrl+`',         needsBind: 'terminal.new' },
  /*
   * 本插件自己注册的七条快捷命令（2026-10-11 用户需求）。
   *
   * 与上面那批的区别：**这些不需要用户先去 DSH 里绑**。命令由本插件的客户端半段
   * 通过 `ctx.shortcuts.register` 注册，并且**自带默认键位** —— 只给 web:windows / web:macos，
   * 因为 `isWebBindingAllowed`（shortcuts/src/binding.ts）对 web:linux 不放行
   * "两修饰键且含 primary + alt/shift"这类组合，给了会直接抛 `Unsupported Web shortcut`。
   * 所以用户装上插件、在面板里选一下就能按，`builtin: true` 表达的正是这个意思。
   *
   * ⚠️ `combo` 必须与 lib/client.js 里 `PANEL_ACTIONS` / `SHORTCUT_ACTIONS` 的 `code` 对得上，
   *    否则面板显示一个键、实际按的是另一个。scripts/selftest.mjs 会查这条一致性。
   */
  { id: 'dsh.openWorkbench',    label: '打开工作台',                   combo: 'Ctrl+Alt+1', builtin: true, remoteCmd: 'remote.panel.workbench' },
  { id: 'dsh.openDashboard',    label: '打开驾驶舱',                   combo: 'Ctrl+Alt+2', builtin: true, remoteCmd: 'remote.panel.dashboard' },
  { id: 'dsh.openProjectGraph', label: '打开工程图',                   combo: 'Ctrl+Alt+3', builtin: true, remoteCmd: 'remote.panel.projectGraph' },
  { id: 'dsh.openCoords',       label: '打开坐标系',                   combo: 'Ctrl+Alt+4', builtin: true, remoteCmd: 'remote.panel.coords' },
  { id: 'dsh.openModeling',     label: '打开建模中心',                 combo: 'Ctrl+Alt+5', builtin: true, remoteCmd: 'remote.panel.modeling' },
  { id: 'dsh.focusComposer',    label: '聚焦聊天输入框',               combo: 'Ctrl+Alt+F', builtin: true, remoteCmd: 'remote.focus.composer' },
  { id: 'dsh.sessionFirst',     label: '打开第一条会话（配合搜索框）', combo: 'Ctrl+Alt+Q', builtin: true, remoteCmd: 'remote.session.first' },
  { id: 'key.up',            label: '方向键 上',                combo: 'ArrowUp' },
  { id: 'key.down',          label: '方向键 下',                combo: 'ArrowDown' },
  { id: 'key.left',          label: '方向键 左',                combo: 'ArrowLeft' },
  { id: 'key.right',         label: '方向键 右',                combo: 'ArrowRight' },
  // 音量键（2026-10-08 用户要求补上）：遥控器上那两个键以前只展示、不能映射。
  { id: 'key.volumeUp',      label: '音量 +',                   combo: 'VolumeUp' },
  { id: 'key.volumeDown',    label: '音量 −',                   combo: 'VolumeDown' },
  /*
   * 鼠标移动（2026-10-11 用户需求：长按方向键连续移动光标）。
   * 这四个是**动作**不是键 —— 引擎在 RunBridge 里用 IsMoveAction 分流到 Injector.Move，
   * 而且**只有它们会被长按重复触发**：按住时每 60ms 挪一次，抬键立刻停。
   * 名字刻意不叫 MouseUp/MouseLeft —— MouseLeft/Right/Middle 已经是"鼠标按键"了。
   */
  { id: 'move.up',           label: '鼠标上移',                 combo: 'MoveUp' },
  { id: 'move.down',         label: '鼠标下移',                 combo: 'MoveDown' },
  { id: 'move.left',         label: '鼠标左移',                 combo: 'MoveLeft' },
  { id: 'move.right',        label: '鼠标右移',                 combo: 'MoveRight' },
]

/** 按键映射的可配按键（语音键不参与映射：SayAll 在「语音输入设置」里按输入工具自动配）。 */
export const BUTTONS = [
  { id: 'ok',    label: 'OK / 确定' },
  { id: 'up',    label: '上' },
  { id: 'down',  label: '下' },
  { id: 'left',  label: '左' },
  { id: 'right', label: '右' },
  { id: 'back',  label: '返回' },
  { id: 'home',  label: '主页' },
  { id: 'menu',  label: '菜单' },
  { id: 'tv',    label: 'TV' },
  { id: 'power', label: '电源' },
  { id: 'volup',   label: '音量 +' },
  { id: 'voldown', label: '音量 −' },
  // 语音键也能映射（用户 2026-10-11 要求）：点按 = 右 Win + 右 Shift，长按 = 按住 Alt。
  { id: 'voice',   label: '语音键' },
]

export const SLOTS = [
  { id: 'click', label: '单击' },
  { id: 'double', label: '双击' },
  { id: 'hold',  label: '长按' },
]

/*
 * 「按住不放」型动作（用户 2026-10-11 的语音键需求）：
 * 长按触发时把 combo 按住，**等那颗遥控器键松开时才放开** —— 微信输入法那种"按住说话"要的就是这个。
 * 和普通 key 动作的区别：key 是"按下+抬起"一条龙，holdkey 只按下，抬起由物理键的松开事件驱动。
 */
export const holdKey = (combo) => ({ type: 'holdkey', id: 'holdkey:' + combo, label: '按住 ' + combo, combo })

/** 默认映射方案：高频=单击、面板类=双击、可连续=方向键（与 README 的建议表一致）。 */
export function defaultMapping() {
  const of = (id) => {
    if (id === null || id === undefined) return null
    const preset = DSH_PRESETS.find((row) => row.id === id)
    if (preset !== undefined) return { type: 'dsh', id: preset.id, label: preset.label, combo: preset.combo }
    return null
  }
  const app = (name) => ({ type: 'app', id: 'app:' + name, label: '打开 ' + name, combo: name })
  return {
    version: 1,
    updatedAt: null,
    buttons: {
      ok:    { click: of('dsh.send'), double: null, hold: null },
      up:    { click: of('key.up'), double: null, hold: null },
      down:  { click: of('key.down'), double: null, hold: null },
      left:  { click: of('key.left'), double: null, hold: null },
      right: { click: of('key.right'), double: null, hold: null },
      back:  { click: of('dsh.stopReply'), double: of('dsh.toggleRight'), hold: of('dsh.toggleLeft') },
      // 主页 / 菜单 / TV / 电源：改用 DSH **真实存在**的命令（原来那几个 DSH 里根本没有）
      home:  { click: of('dsh.openLocal'), double: app('Codex'), hold: null },
      menu:  { click: of('dsh.toggleRight'), double: app('cmux'), hold: null },
      tv:    { click: of('dsh.toggleLeft'), double: null, hold: null },
      power: { click: of('dsh.openSettings'), double: null, hold: null },
      // 音量键：默认给系统音量（引擎的键表认得 VolumeUp / VolumeDown 这两个媒体键）
      volup:   { click: of('key.volumeUp'), double: null, hold: null },
      voldown: { click: of('key.volumeDown'), double: null, hold: null },
      /*
       * 语音键：**三档都留空** —— 它不走引擎注入，改由采集器在 HID 报告层直接处理。
       *
       * 为什么不能用 SendInput：那个事件强制带 LLKHF_INJECTED 标志，**微信输入法一看是模拟的
       * 就丢掉**（实测：环回测试证明 RWin/RShift/LAlt 都发出去了，输入法毫无反应）。
       * 现在改成抄 SayAll 的做法 —— 在报告里把语音键的 usage 0x003E 改写成 0x00E2（左Alt），
       * 让 Windows 的 HID 驱动产生**货真价实的硬件级按键**，没有 injected 标志。
       * 而且语义改成了"锁存"：第 1 次按 = Alt 按住（开始说话），第 2 次按 = Alt 放开（结束）。
       *
       * ⚠️ 这里必须留空，否则引擎的 SendInput 会**和锁存打架** ——
       * 它在物理抬手时会发一次 LAlt 抬起，正好把锁存中的 Alt 放掉。
       * 引擎仍会识别 voice 并写日志（面板和排查都要用），只是不再产生动作。
       */
      voice: { click: null, double: null, hold: null },
    },
    /*
     * vkeys：按键名 → 遥控器在 Windows 里**实际报的键码**（十进制 VKey）。
     *
     * 为什么必须有这张表：遥控器各键报什么码事先无从得知（要按一下才知道），而引擎要按码
     * 才能认出「这是 OK 键」。所以流程是：面板里学一次 → 把学到的码指定给某个键名 → 存这里
     * → 引擎 run 时读它做匹配。空表 = 引擎认得设备但认不出按键，会打印 unmapped。
     */
    vkeys: {},
  }
}

/* ── 配置与执行器 ──────────────────────────────────────────────────────── */

const env = (key, fallback) => {
  const value = process.env[key]
  return value === undefined || value === '' ? fallback : value
}

const defaultPowerShell = () => {
  if (process.platform !== 'win32') return 'pwsh'
  const root = process.env.SystemRoot || 'C:\\Windows'
  const classic = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(classic) ? classic : 'powershell.exe'
}

/*
 * 运行期状态目录。
 *
 * 原来放在 %LOCALAPPDATA%\dsh-mi-remote，2026-10-11 发现一个硬问题：
 * **在那个目录里"新建"文件会被拒绝（UnauthorizedAccessException）**，只有"追加到已存在的文件"才行。
 * 表现就是引擎的 --out 日志（bridge-run.jsonl）死活不生成，而进程又把异常吞了，查了很久。
 * 证据：同一份 exe，--out 指向插件目录能生成、指向 %LOCALAPPDATA% 就 UnauthorizedAccessException；
 *      而 keys.jsonl 能一直写入，只因为它早就存在（追加 vs 新建）。
 *
 * 插件目录属于工作区，新建文件正常，所以运行期状态统一放这儿。
 */
const LEGACY_STATE_DIR = join(process.env.LOCALAPPDATA || PKG_ROOT, 'dsh-mi-remote')

const settings = () => ({
  powershell: env('DSH_MIREMOTE_PS', defaultPowerShell()),
  scriptDir: env('DSH_MIREMOTE_SCRIPT_DIR', join(PKG_ROOT, 'audio')),
  stateDir: env('DSH_MIREMOTE_STATE_DIR', join(PKG_ROOT, 'state')),
  cacheMs: Number(env('DSH_MIREMOTE_CACHE_MS', '8000')) || 8000,
  deadlineMs: Number(env('DSH_MIREMOTE_DEADLINE_MS', '20000')) || 20000,
})

/** 旧状态目录里那份映射：新目录还没有时迁过来，别让用户保存过的配置白丢。 */
function migrateLegacyMapping(target) {
  try {
    if (existsSync(target)) return
    const legacy = join(LEGACY_STATE_DIR, 'mapping.json')
    if (!existsSync(legacy)) return
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, readFileSync(legacy, 'utf8'), 'utf8')
  } catch (error) { /* 迁不动就按默认方案走，不阻塞 */ }
}

/**
 * 把上一轮 dsh 留下的残留进程清掉。
 *
 * 为什么需要：引擎和采集器是用 WMI 起的（脱离父进程），**dsh 重启不会把它们带走**。
 * 于是重启几次之后就同时挂着好几个采集器（都挂在同一个蓝牙驱动宿主上，互相干扰），
 * 引擎也可能重复注入。2026-10-11 就是"起了两个采集器"，看到的按键流是两份交错的。
 */
function killStrayPipeline() {
  return new Promise((resolvePromise) => {
    /*
     * ⚠️ 名单必须把**每一种引擎实现**都列上 —— 2026-10-11 的教训。
     *
     * 原来只清了 `KeyBridge.exe read` 和 `rc003-tap`（采集器），**漏了 python 版引擎
     * `read-engine.py`**。于是每次 /bridge/auto 起一个新引擎，旧的不被回收
     * （Windows 上父进程死了子进程不跟着死），越攒越多。
     * 实测攒到 **4 个引擎同时读同一个 keys.jsonl、各注入一次**，症状是：
     *   · 音量键"一按触发两次"
     *   · 返回键的 Backspace 与僵尸引擎的旧动作打架
     *   · 长按被三连击打成"没反应"
     *
     * 以后加新引擎实现，**务必同步加到这里**。
     */
    const ps = 'Get-CimInstance Win32_Process | Where-Object { ' +
      '($_.Name -eq \'KeyBridge.exe\' -and $_.CommandLine -match \'read\') -or ' +
      '($_.Name -eq \'python.exe\' -and ($_.CommandLine -match \'rc003-tap\' -or $_.CommandLine -match \'read-engine\')) } | ' +
      'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 20000 }, () => resolvePromise())
  })
}

/**
 * 只清**引擎**（不动采集器）。
 *
 * 为什么单独要一个：/bridge/auto 有两条路 —— "复用采集器"和"重建整套"。
 * 复用那条路原来只判断 `runChild` 还在不在，**管不到别的实例漏下来的引擎**；
 * 而引擎一多就会每个都注入一次（音量触发两次、返回键动作打架）。
 * 所以每次 /bridge/auto 开头都先无条件把场上所有引擎清掉，再按需起一个。
 */
function killStrayEngines() {
  return new Promise((resolvePromise) => {
    const ps = 'Get-CimInstance Win32_Process | Where-Object { ' +
      '($_.Name -eq \'KeyBridge.exe\' -and $_.CommandLine -match \'read\') -or ' +
      '($_.Name -eq \'python.exe\' -and $_.CommandLine -match \'read-engine\') } | ' +
      'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 20000 }, () => resolvePromise())
  })
}

/**
 * 起一次 .ps1 并解析结果。stdout 只认最后一行 `RESULT_JSON=`（UTF-8 字节直写，见脚本头注释）。
 *
 * `options.timeoutMs` 可按次覆盖 `cfg.deadlineMs`（默认 20 秒）。
 * **蓝牙搜索必须覆盖**：枚举未配对设备要网卡做主动搜索，实测 20 秒回不来，
 * 用默认值会被 execFile 掐断、一个结果都拿不到。详见 `audio/bt-pair.ps1`。
 */
function runScript(scriptName, args, options) {
  const cfg = settings()
  const script = join(cfg.scriptDir, scriptName)
  if (!existsSync(script)) {
    return Promise.resolve({ ok: false, error: 'script-missing', script })
  }
  const timeoutMs = options !== null && options !== undefined && Number.isFinite(options.timeoutMs)
    ? options.timeoutMs
    : cfg.deadlineMs
  const argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args]
  return new Promise((resolvePromise) => {
    try {
      execFile(cfg.powershell, argv, {
        windowsHide: true, // 用户 2026-09-24 裁定：一律静默，不留窗口
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'buffer',
      }, (error, stdout, stderr) => {
        const text = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout || '')
        const errText = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || '')
        const lines = text.split(/\r?\n/).filter((line) => line.startsWith('RESULT_JSON='))
        if (lines.length === 0) {
          resolvePromise({
            ok: false,
            error: error ? 'helper-failed' : 'helper-no-result',
            message: error ? String(error.message || error) : '',
            stderr: errText.slice(-600),
          })
          return
        }
        try {
          resolvePromise(JSON.parse(lines[lines.length - 1].slice('RESULT_JSON='.length)))
        } catch (parseError) {
          resolvePromise({ ok: false, error: 'helper-bad-json', message: String(parseError && parseError.message) })
        }
      })
    } catch (spawnError) {
      resolvePromise({ ok: false, error: 'helper-spawn-failed', message: String(spawnError && spawnError.message) })
    }
  })
}

/* ── 一、链路体检 ──────────────────────────────────────────────────────── */

const linkCache = { at: 0, value: null, inflight: null }

/**
 * 遥控器的 HID-over-GATT 通道是否正常。
 *
 * 为什么必须单独查这一条：那个设备节点一旦被禁用（ConfigFlags=1 / CM_PROB_DISABLED），
 * 整条链路会**静默地什么都不做** —— 采集器 hook 到空壳、引擎照跑、界面全绿，按了没反应，
 * 从外部完全看不出问题。2026-10-11 就是这样耗掉的：设备是被早先折腾 Disable-PnpDevice 时
 * 禁掉的（当时那条命令还报"不支持"，看着像没生效）。
 *
 * 返回 { state: 'ok' | 'disabled' | 'missing' | 'unknown', ready }
 */
function readRemoteHidState() {
  return new Promise((resolvePromise) => {
    const ps = 'Get-PnpDevice -ErrorAction SilentlyContinue | ' +
      'Where-Object { $_.InstanceId -match \'BTHLEDEVICE.\\{00001812\' } | ' +
      'Select-Object -First 1 | ' +
      'ForEach-Object { [pscustomobject]@{ status = [string]$_.Status; problem = [string]$_.Problem } } | ' +
      'ConvertTo-Json -Compress'
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 20000, encoding: 'utf8' }, (error, stdout) => {
        if (error) { resolvePromise({ state: 'unknown', ready: false }); return }
        const text = String(stdout || '').trim()
        if (text === '') { resolvePromise({ state: 'missing', ready: false }); return }
        try {
          const parsed = JSON.parse(text)
          const row = Array.isArray(parsed) ? parsed[0] : parsed
          if (row === null || row === undefined) { resolvePromise({ state: 'missing', ready: false }); return }
          const status = String(row.status || '')
          const problem = String(row.problem || '')
          if (problem === 'CM_PROB_DISABLED' || status === 'Error') {
            resolvePromise({ state: 'disabled', ready: false, problem })
          } else if (status === 'OK') {
            resolvePromise({ state: 'ok', ready: true })
          } else {
            resolvePromise({ state: 'unknown', ready: false, status })
          }
        } catch (parseError) {
          resolvePromise({ state: 'unknown', ready: false })
        }
      })
  })
}

/*
 * 遥控器电量。走 BLE 的电池服务（0x180F / 0x2A19），一次读要建连接、两秒上下，
 * 所以单独缓存、TTL 比链路体检长得多（电池不会几秒钟就变）。读不到就返回 null ——
 * 面板上如实显示"未读取"，不编数字。
 */
const batteryCache = { at: 0, level: null, inflight: null }
const BATTERY_TTL_MS = 5 * 60 * 1000

function readBatteryCached() {
  if (Date.now() - batteryCache.at < BATTERY_TTL_MS) return Promise.resolve(batteryCache.level)
  if (batteryCache.inflight !== null) return batteryCache.inflight
  batteryCache.inflight = runScript('read-battery.ps1', [])
    .then((result) => {
      batteryCache.inflight = null
      batteryCache.at = Date.now()
      batteryCache.level = result !== null && result !== undefined && result.ok === true && Number.isFinite(result.level)
        ? Number(result.level)
        : null
      return batteryCache.level
    })
    .catch(() => {
      batteryCache.inflight = null
      batteryCache.at = Date.now()
      batteryCache.level = null
      return null
    })
  return batteryCache.inflight
}

export async function linkStatus(force) {
  const cfg = settings()
  if (!force && linkCache.value !== null && Date.now() - linkCache.at < cfg.cacheMs) {
    return linkCache.value
  }
  if (linkCache.inflight !== null) return linkCache.inflight

  const probe = runScript('probe.ps1', [])
  const voice = runScript('audio-device.ps1', ['status'])
  const battery = readBatteryCached()
  const hid = readRemoteHidState()
  /*
   * 链路两段的真实状态（扫进程，2 秒缓存）。塞进同一个 Promise.all：
   * 面板每 10 秒读一次 `/link`，多等这一项不会加长整体耗时（其它几项本来就慢）。
   */
  const childrenPromise = bridgeChildrenStateCached()
  linkCache.inflight = Promise.all([probe, voice, battery, hid, childrenPromise]).then(([probeResult, voiceResult, batteryLevel, hidState, children]) => {
    linkCache.inflight = null

    const devices = Array.isArray(voiceResult.devices) ? voiceResult.devices : []
    const cable = devices.filter((device) => device && device.flow === 'capture' && /cable\s*(out|output)|vb-?audio|vb-?cable/i.test(String(device.name || '')))
    const uu = devices.filter((device) => device && device.flow === 'capture' && /uu远程/i.test(String(device.name || '')))

    const remotes = Array.isArray(probeResult.remotes) ? probeResult.remotes : []
    const value = {
      ok: true,
      platform: process.platform,
      link: {
        remote: {
          ok: remotes.length > 0,
          state: remotes.length > 0 ? 'ready' : 'missing',
          devices: remotes,
          battery: batteryLevel,
          /*
           * 按键链路的两段是否活着 —— 面板上要如实显示，别让人以为"绿了就一定在收键"。
           * collector = Frida 采集器（Python，挂在蓝牙驱动宿主上读 HID 报告）
           * engine    = read 模式的引擎（读采集器写的 JSON 行 → 判定 → 注入）
           *
           * ⚠️ 2026-10-21 改：原来只看进程句柄，会骗人 ——
           *   · `/bridge/auto` 的"复用采集器"分支**不给句柄**（collectorChild 仍是 null），
           *     于是采集器明明在跑、这里却报 false；
           *   · dsh 重启后上一轮起的进程可能还活着（Windows 上父子不连坐），句柄也是 null。
           * 现在统一走 `bridgeChildrenStateCached()`（扫真实进程，2 秒缓存）：
           * 开关读的和这张卡显示的必须是**同一个事实**，否则开关点了没反应、卡片却绿着。
           */
          bridge: {
            collector: children.collector.running,
            engine: children.engine.running,
            filter: runFilter,
            collectorPid: children.collector.pid,
            enginePid: children.engine.pid,
          },
          /*
           * HID 通道状态。被禁用时上面那些全都"正常"，但按键一个都进不来 ——
           * 面板要把它标红，别让人对着一个全绿的界面怀疑自己。
           */
          hid: hidState,
          howto: 'Windows 设置 → 蓝牙和其他设备 → 添加设备 → 蓝牙；遥控器长按「菜单+主页」进配对模式。已连过别的机器要先在那台断开，RC003 同一时间只连一台。',
        },
        sayall: {
          ok: probeResult.sayallRunning === true,
          state: probeResult.sayallInstall !== undefined && probeResult.sayallInstall !== null
            ? (probeResult.sayallRunning === true ? 'ready' : 'installed-not-running')
            : 'missing',
          install: probeResult.sayallInstall || null,
          howto: '装「无线麦 SayAll」Windows 版：github.com/GetSayAll/remote-mic-app-windows/releases。装完它常驻托盘；语音设备选 CABLE Input（播放端）。',
        },
        cable: {
          ok: cable.length > 0,
          state: cable.length > 0 ? 'ready' : 'missing',
          devices: cable,
          howto: '装 VB-CABLE：vb-audio.com/Cable → 管理员运行 VBCABLE_Setup_x64 → 重启 Windows。装完录音端会出现 CABLE Output。',
        },
        wetype: {
          ok: probeResult.wetypeRunning === true,
          state: probeResult.wetypeRunning === true ? 'ready' : 'missing',
          // 状态卡要"有具体参数"：把探针报回来的进程列表原样带出去（没有就不带，不编）。
          process: Array.isArray(probeResult.wetypeProcess) ? probeResult.wetypeProcess : [],
          howto: '微信输入法已在运行时只差麦克风选择：语音设置里选 CABLE Output，没有选项就把系统默认录音设备切过去（本面板「语音输入路径」一键切）。',
        },
      },
      voiceEndpoints: {
        uuActive: uu.some((device) => device.state === 'active'),
      },
    }
    linkCache.value = value
    linkCache.at = Date.now()
    return value
  }, (error) => {
    linkCache.inflight = null
    return { ok: false, error: 'link-rejected', message: String(error && error.message) }
  })
  return linkCache.inflight
}

const invalidateLink = () => { linkCache.at = 0; linkCache.value = null }

/* ── 二、语音输入路径 ──────────────────────────────────────────────────── */

const voiceCache = { at: 0, value: null, inflight: null }

export async function voiceStatus(force) {
  const cfg = settings()
  if (!force && voiceCache.value !== null && Date.now() - voiceCache.at < cfg.cacheMs) return voiceCache.value
  if (voiceCache.inflight !== null) return voiceCache.inflight
  voiceCache.inflight = runScript('audio-device.ps1', ['status']).then((raw) => {
    voiceCache.inflight = null
    if (!raw || raw.ok !== true) return { ok: false, error: (raw && raw.error) || 'status-unavailable' }
    const devices = (Array.isArray(raw.devices) ? raw.devices : [])
      .filter((device) => device && device.flow === 'capture')
      .map((device) => {
        const hint = sourceOf(device.name)
        return {
          id: device.id,
          name: device.name,
          state: device.state,
          active: device.state === 'active',
          isDefault: device.state === 'active' && device.id === raw.defaultId,
          isRemoteMic: isRemoteMicName(device.name),
          source: hint.source,
          sourceLabel: hint.label,
        }
      })
    const rank = { sayall: 0, uuremote: 1, virtual: 2, wireless: 3, other: 4 }
    const remote = devices.filter((device) => device.isRemoteMic && device.active)
      .sort((a, b) => (rank[a.source] ?? 9) - (rank[b.source] ?? 9))
    return {
      ok: true,
      current: devices.find((device) => device.isDefault) || null,
      devices,
      remoteDevices: remote,
      suggest: remote.length > 0 ? remote[0] : null,
      savedPrevious: raw.savedPreviousId ? { id: raw.savedPreviousId, name: raw.savedPreviousName } : null,
    }
  })
  return voiceCache.inflight
}

const invalidateVoice = () => { voiceCache.at = 0; voiceCache.value = null }

export async function voiceApply(query) {
  const result = await runScript('audio-device.ps1', ['apply', '-Query', String(query || '')])
  invalidateVoice()
  invalidateLink()
  return result
}

export async function voiceRestore() {
  const result = await runScript('audio-device.ps1', ['restore'])
  invalidateVoice()
  invalidateLink()
  return result
}

/* ── 三、按键映射 ──────────────────────────────────────────────────────── */

const mappingPath = () => {
  const cfg = settings()
  const target = join(cfg.stateDir, 'mapping.json')
  migrateLegacyMapping(target)   // 状态目录从 %LOCALAPPDATA% 搬过来时把已存方案带过来（只做一次）
  return target
}

/* ── 按键桥引擎（engine/KeyBridge.exe）────────────────────────────────────
 * 面板负责「配置」；让配置真正生效的是这个引擎：Raw Input 监听遥控器 →
 * 单击/双击/长按判定 → SendInput 注入。为什么在 DSH 侧自己做一份：SayAll 的按键映射
 * 由它自己的界面独占，它的官方 AI 协议也明确禁止外部脚本改它的私有配置
 * （详见 engine/KeyBridge.cs 顶部注释）。
 */
// HERE 是 lib/ 目录，引擎在插件根的 engine/ —— 差一层，resolve 掉".."。
const ENGINE = process.env.DSH_MIREMOTE_ENGINE || resolve(HERE, '..', 'engine', 'KeyBridge.exe')
/** Frida 采集器：hook 蓝牙驱动宿主的 NtDeviceIoControlFile，把 HID 报告写成 JSON 行。 */
const COLLECTOR = resolve(HERE, '..', 'engine', 'rc003-tap.py')

/**
 * 采集器的启动参数。
 *
 * `voiceOwner` 决定语音键归谁：
 *   'sayall' —— SayAll 自己的 gadget 也在同一个驱动宿主里盯着同一个 IOCTL，两边同时改写会互相
 *               打架。这一档我们**只观察不改写**（加 --sayall-owns-voice），把语音整条路让给它；
 *               按键映射不受影响，那是引擎注入的事。
 *   'dsh'    —— 我们接管：在报告里把语音键 usage 改写成左 Alt，并做锁存（按一下按住、再按放开）。
 */
function collectorArgs(python, hostPid, keysFile) {
  const argv = [COLLECTOR, String(hostPid), keysFile]
  /*
   * `--sayall-owns-voice` 的实际含义是「**一个字节都不要改写**」，不只是语音键。
   * 所以两种情形都要带上它：
   *   · `voiceOwner === 'sayall'` —— 语音通道归 SayAll；
   *   · `remoteOwner === 'sayall'` —— 整台遥控器归 SayAll（更强的"放手"）。
   * 参数名带 voice 是历史原因（它最早只为语音做），**别被名字骗了**。
   */
  if (voiceOwner() === 'sayall' || remoteOwner() === 'sayall') argv.push('--sayall-owns-voice')
  return argv
}

/**
 * 找出正在跑的采集器（返回 { pid, sayallOwns } 或 null）。
 *
 * 为什么要有这个：/bridge/auto 原来每次都"先清残留再起新的"，而面板重新挂载时会再调一次 ——
 * 后一次调用把前一次刚起的采集器杀掉，自己也活不到下一次。表现就是"采集器永远起不来、
 * 引擎孤零零在跑、按键全无反应"（2026-10-11 卡了半天）。
 * 现在先看有没有在跑的：模式一致就直接复用，不动它。
 */
function findRunningCollector() {
  return new Promise((resolvePromise) => {
    const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'python.exe\'" -ErrorAction SilentlyContinue | ' +
      'Where-Object { $_.CommandLine -match \'rc003-tap\' } | Select-Object -First 1 | ' +
      'ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; owns = [bool]($_.CommandLine -match \'sayall-owns-voice\') } } | ' +
      'ConvertTo-Json -Compress'
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 15000, encoding: 'utf8' }, (error, stdout) => {
        if (error) { resolvePromise(null); return }
        const text = String(stdout || '').trim()
        if (text === '') { resolvePromise(null); return }
        try {
          const row = JSON.parse(text)
          const one = Array.isArray(row) ? row[0] : row
          if (one === null || one === undefined || !Number.isInteger(Number(one.pid))) { resolvePromise(null); return }
          resolvePromise({ pid: Number(one.pid), sayallOwns: one.owns === true })
        } catch (parseError) { resolvePromise(null) }
      })
  })
}

/** 语音独占归谁：'sayall' | 'dsh'。存在 bridge 状态里，面板和 host 都读它。 */
function voiceOwner() {
  const saved = readBridgeState()
  return saved !== null && saved !== undefined && saved.voiceOwner === 'dsh' ? 'dsh' : 'sayall'
}

/**
 * 遥控器的**整机**归属：'dsh' | 'sayall'（2026-10-21 用户要求）。
 *
 * 和 `voiceOwner` 的区别（别混）：
 *   · `voiceOwner` 只管**语音键那一个通道**（ATVV），
 *   · `remoteOwner` 管**整个遥控器**——所有按键算谁的。
 *
 * 为什么需要它：用户实测「SayAll 在抓遥控器按键，但除语音键之外都被 DSH 占了、抓不到」。
 * 根因不在改写（当时 `voiceOwner='sayall'`，采集器一个字节都没改），而在**引擎还在注入** ——
 * 遥控器每按一下，DSH 就往系统里打一串快捷键，SayAll 那边等于在跟一堆注入事件抢。
 *
 *   `'sayall'` ⇒ **引擎不跑**（DSH 一个键都不注入）+ 采集器不改写 ⇒ SayAll 独占整台遥控器。
 *   `'dsh'`    ⇒ 正常：采集器改写 + 引擎注入，遥控器是 DSH 的输入设备。
 *
 * ⚠️ 与 `voiceOwner` 冲突时的优先级：**`remoteOwner='sayall'` 赢**。
 *    道理很简单——"整台给 SayAll"本来就包含语音通道；反过来只把语音给 SayAll 才需要单独设。
 *    这条优先级写在 `collectorArgs` 与 `ensureBridgeRunning` 里，改的时候两处一起看。
 */
function remoteOwner() {
  const saved = readBridgeState()
  return saved !== null && saved !== undefined && saved.remoteOwner === 'sayall' ? 'sayall' : 'dsh'
}

/** DSH 到底该不该碰这台遥控器（不该碰 = 采集器不改写、引擎不注入）。 */
function dshOwnsRemote() {
  return remoteOwner() !== 'sayall'
}

/**
 * 起采集器。**不要用 `stdio: 'ignore'`** —— 2026-10-11 实测：那样起的进程会**立刻静默退出**，
 * 连一条错误都留不下（Frida 的 Python binding attach 时要用到 stdio，句柄无效就抛异常，
 * 而异常写不出去就什么都没了）。表现是"spawn 返回了 pid、下一秒进程就不见了、
 * 引擎孤零零在跑、按键全无反应"，查了很久才定位到。
 *
 * 现在把它的 stdout/stderr 落到 state/collector.log：既让 stdio 有效，也留下排查依据。
 */
function spawnCollector(python, hostPid, keysFile) {
  const argv = collectorArgs(python, hostPid, keysFile)
  const cfg = settings()
  let out = null
  try {
    mkdirSync(cfg.stateDir, { recursive: true })
    out = openSync(join(cfg.stateDir, 'collector.log'), 'a')
  } catch (error) { out = null }
  const child = spawn(python, argv, out === null
    ? { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    : { windowsHide: true, stdio: ['ignore', out, out] })
  child.on('error', () => { /* 起不来由上层判空 */ })
  if (out !== null) child.on('exit', () => { try { closeSync(out) } catch (error) { /* 已关 */ } })
  return child
}

/** SayAll 装在哪、主程序叫什么。 */
const SAYALL_EXE = 'C:\\Program Files\\无线麦 SayAll\\sayall-windows-app.exe'

/** SayAll 在跑吗。 */
function sayallRunning() {
  return new Promise((resolvePromise) => {
    const ps = 'Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match \'sayall\' } | ' +
      'Select-Object -First 1 -ExpandProperty ProcessName'
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 15000, encoding: 'utf8' }, (error, stdout) => {
        resolvePromise(!error && String(stdout || '').trim() !== '')
      })
  })
}

/** 拉起 SayAll（它常驻托盘）。已经开着就返回 already。 */
async function sayallStart() {
  if (await sayallRunning()) return { ok: true, already: true }
  if (!existsSync(SAYALL_EXE)) return { ok: false, error: 'sayall-missing', path: SAYALL_EXE }
  try {
    // 用 WMI 起，脱离本进程 —— 这样 dsh 重启不会把它带走，也不会留可见窗口
    const encoded = Buffer.from(
      'Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = \'"' + SAYALL_EXE + '"\' } | Out-Null',
      'utf16le').toString('base64')
    await new Promise((resolvePromise) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        { windowsHide: true, timeout: 20000 }, () => resolvePromise())
    })
    await delay(1500)
    return { ok: true, started: true }
  } catch (error) {
    return { ok: false, error: 'sayall-start-failed', message: String(error && error.message) }
  }
}

/** 停掉 SayAll（切到 DSH 取时用，两边必须互斥）。 */
function sayallStop() {
  return new Promise((resolvePromise) => {
    const ps = 'Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match \'sayall\' } | ' +
      'ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }'
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 15000 }, () => resolvePromise({ ok: true }))
  })
}

/** 采集器写的按键流（引擎 read 模式读它）。 */
const keysPath = () => join(settings().stateDir, 'keys.jsonl')

/**
 * Python 解释器：先看设置里指定的，再依次试几个常见位置（Frida 采集器跑在 Python 侧）。
 *
 * 候选里**不放任何本机绝对路径**。原来这一行写着作者自己那台机器的 venv 路径
 * （`D:\.hermes\venv\Scripts\python.exe`），发布到公开仓库时属于"暴露本机布局"，
 * 而且对别人毫无用处 —— 换成通用的三个名字，交给 PATH 解析。
 * 需要指定解释器的人用 `DSH_MIREMOTE_PYTHON` 环境变量（或设置里的 `python` 字段）。
 */
function findPython() {
  const configured = settings().python
  const candidates = []
  if (typeof configured === 'string' && configured !== '') candidates.push(configured)
  candidates.push('python', 'python3', 'py')
  for (const candidate of candidates) {
    try {
      if (candidate.includes('\\') || candidate.includes('/')) {
        if (existsSync(candidate)) return candidate
      } else {
        return candidate   // 交给 PATH 解析；起不来会在 error 回调里体现
      }
    } catch (error) { /* 继续试下一个 */ }
  }
  return null
}

/**
 * 找出**真正承载遥控器**的 WUDFHost.exe。
 *
 * ⚠️⚠️ 判据 2026-10-21 改过 —— 原来按"创建时间取最新"，那是**错的**。
 *
 * 原实现：`Sort-Object CreationDate -Descending | Select-Object -First 1`。
 * 本机三个 WUDFHost（8608 / 9932 / 11200）**都是 10/15 13:45 创建、相差不到 1 秒**，
 * 于是"最新"选中了 11200 —— 而它根本不是管遥控器的那个：
 *
 *   PID 8608   装了 microsoft.bluetooth.profiles.hidovergatt.dll  ← ★ HID over GATT，真正管遥控器
 *   PID 9932   只有 WUDFx.dll
 *   PID 11200  只有 WUDFx02000.dll（在忙别的设备，读计数一直很高，很有迷惑性）
 *
 * 后果：采集器往 11200 挂钩子，`hooked` 成功、界面全绿，但**那个 IOCTL 永不被调用** ——
 * 用户按一堆键，`keys.jsonl` 里一条真实报告都没有。这一条查了很久。
 *
 * 现在按**模块**判：带 `hidovergatt` 的才是 BLE HID 宿主。
 * 模块拿不到（权限/保护进程）就退回"最新"，不至于完全不可用。
 */
function findRemoteHostPid() {
  return new Promise((resolvePromise) => {
    const ps = [
      '$rows = @(Get-Process WUDFHost -ErrorAction SilentlyContinue | ForEach-Object {',
      '  $mods = @(); try { $mods = @($_.Modules) } catch { $mods = @() }',
      '  [pscustomobject]@{',
      '    pid = $_.Id;',
      '    created = $_.StartTime;',
      "    hid = [bool](@($mods | Where-Object { $_.ModuleName -match 'hidovergatt' }).Count -gt 0)",
      '  }',
      '})',
      '$hit = @($rows | Where-Object { $_.hid })',
      'if ($hit.Count -gt 0) { ($hit | Sort-Object created -Descending | Select-Object -First 1).pid }',
      'elseif ($rows.Count -gt 0) { ($rows | Sort-Object created -Descending | Select-Object -First 1).pid }',
    ].join(' ')
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 25000, encoding: 'utf8' }, (error, stdout) => {
        if (error) { resolvePromise(null); return }
        const pid = Number(String(stdout || '').trim())
        resolvePromise(Number.isInteger(pid) && pid > 0 ? pid : null)
      })
  })
}

const delay = (ms) => new Promise((resolvePromise) => { setTimeout(resolvePromise, ms) })
const learnFilePath = () => join(settings().stateDir, 'learn.jsonl')
const runLogPath = () => join(settings().stateDir, 'bridge-run.jsonl')
const bridgeStatePath = () => join(settings().stateDir, 'bridge.json')
let learnChild = null
let runChild = null
/** Frida 采集器进程（Python）。引擎跑 read 模式时和它配对：它写 JSON 行、引擎读。 */
let collectorChild = null
let runFilter = null

/** 跑一次会自己退出的短命令（list / tap），拿它的 stdout。 */
function engineOnce(args) {
  return new Promise((resolve) => {
    if (existsSync(ENGINE) !== true) { resolve({ ok: false, error: 'engine-missing' }); return }
    execFile(ENGINE, args, { windowsHide: true, timeout: 20000, encoding: 'utf8' }, (error, stdout, stderr) => {
      const out = String(stdout || '')
      if (error !== null && error !== undefined && out.trim() === '') {
        resolve({ ok: false, error: String((error && error.message) || error), stderr: String(stderr || '').slice(0, 400) })
        return
      }
      resolve({ ok: true, stdout: out, stderr: String(stderr || '').slice(0, 400) })
    })
  })
}

/** 命令行参数引用：含空格或引号就包起来 —— WMI 那边要的是完整命令行字符串。 */
function quoteArg(value) {
  const text = String(value)
  if (text.length > 0 && !/[\s"]/.test(text)) return text
  return '"' + text.replace(/"/g, '\\"') + '"'
}

/**
 * 起一个常驻引擎（learn / run）。
 *
 * ⚠️ 为什么不用 spawn —— 2026-10-11 实测结论：
 * Node 的 `spawn(..., { windowsHide: true })` 等价于给进程加 **CREATE_NO_WINDOW** 标志，
 * 而**带这个标志的进程收不到全局键盘钩子**。对照实验（同一份引擎、同一个会话、同一个用户）：
 *   · `Start-Process -WindowStyle Hidden`  → 能收到键 ✓
 *   · WMI `Win32_Process.Create`           → 能收到键 ✓
 *   · `spawn({windowsHide:true})`          → 收不到 ✗
 *   · 引擎自己 `ShowWindow(0)` 藏窗口      → 收不到 ✗
 * 也就是说"创建那一刻就隐藏"和"事后隐藏"不等价，而 Node 只有前者里坏的那一种。
 * 所以改走 WMI：进程由 WMI 服务创建，跟"谁发起这次调用"无关，也就绕开了这个标志。
 *
 * 代价：WMI 起的进程没有 child handle —— 所以
 *   · 输出全靠 `--out` 文件（本来就是这样）
 *   · 停止靠 `taskkill /PID`
 *   · "还在不在"靠查进程表
 * 返回一个仿 child 的对象（pid / kill / killed），调用方逻辑不用改。
 */
/**
 * 探一次 KeyBridge.exe 的完整性级别，缓存结果。
 *
 * 为什么要探：这台机器上 360 的沙箱驱动（360Box64 / 360AntiHijack）会把**未签名的可执行文件**
 * 降级到低完整性（Low 4096），而 Windows 的 UIPI 规定低完整性进程注入到更高完整性的窗口
 * 会被**静默丢弃**（SendInput 照样返回成功）。于是引擎日志全绿、界面毫无反应。
 * python.exe 有数字签名，不受影响（实测 12288 High）。
 *
 * 所以启动引擎前先跑 2 秒看一眼它自报的级别：能用就用原版（C#，边界情况更熟），
 * 被降级就自动切到 python 版（engine/read-engine.py）。
 * 卸载 360 并重启之后这里会自然回到原版，不需要再改代码。
 */
let engineIntegrityCache = null
/** 当前选定的引擎实现（由 /bridge/auto 在起引擎前先探一次决定）。 */
let enginePick = null

function probeEngineIntegrity() {
  if (engineIntegrityCache !== null) return Promise.resolve(engineIntegrityCache)
  return new Promise((resolvePromise) => {
    const cfg = settings()
    const scratch = join(cfg.stateDir, '_probe-keys.jsonl')
    const logPath = join(cfg.stateDir, '_probe-integrity.jsonl')
    try {
      mkdirSync(cfg.stateDir, { recursive: true })
      writeFileSync(scratch, '', 'utf8')
      rmSync(logPath, { force: true })
    } catch (error) { resolvePromise(0); return }
    let child = null
    try {
      child = spawn(ENGINE, ['read', '--config', mappingPath(), '--file', scratch, '--out', logPath],
        { windowsHide: true, stdio: 'ignore' })
    } catch (error) { resolvePromise(0); return }
    const done = (level) => {
      engineIntegrityCache = level
      try { if (child !== null) child.kill() } catch (error) { /* 已退出 */ }
      resolvePromise(level)
    }
    setTimeout(() => {
      let level = 0
      try {
        const first = readFileSync(logPath, 'utf8').split(/\r?\n/u)[0] || ''
        const parsed = JSON.parse(first)
        if (Number.isInteger(parsed.integrity)) level = parsed.integrity
      } catch (error) { level = 0 }
      done(level)
    }, 2600)
  })
}

/** 引擎要用的"实现"：原版 C# 还是 python 版。 */
async function pickEngine() {
  const level = await probeEngineIntegrity()
  const py = findPython()
  // 级别 >= Medium(0x2000) 才允许注入到普通窗口；否则切 python
  if (level >= 0x2000 || py === null) {
    return { kind: 'keybridge', exe: ENGINE, level, note: level >= 0x2000 ? 'ok' : 'python-unavailable' }
  }
  return { kind: 'python', exe: py, level, note: 'engine-downgraded' }
}

function spawnEngine(args, onExit) {
  if (existsSync(ENGINE) !== true) return null
  /*
   * ⚠️ **不要用 WMI（Win32_Process.Create）起引擎** —— 这是 2026-10-11 查到的根因。
   *
   * WMI 那条路给出的令牌是**降级的（Low 完整性 4096）**；而 dsh 自己是 High(12288)，
   * 用普通 spawn 起的采集器也继承 High。于是：
   *     引擎(Low) --SendInput--> 浏览器(Medium/High)   → **被 UIPI 静默丢弃**
   * `SendInput` 照样返回成功、日志里全是 ok:true，界面毫无反应。
   *
   * 当初改用 WMI 的理由是"用 CREATE_NO_WINDOW 起的进程收不到全局键盘钩子"。但引擎现在跑的是
   * **read 模式** —— 它只读采集器写的 JSON 行文件，一个钩子都不装，那个理由已经不成立。
   * 所以回到普通 spawn，让它继承 dsh 的完整性级别，注入才到得了浏览器。
   *
   * windowsHide: true —— 用户 2026-09-24 裁定：一律静默，不留可见窗口。
   */
  const cfg0 = settings()
  let engOut = null
  try {
    mkdirSync(cfg0.stateDir, { recursive: true })
    engOut = openSync(join(cfg0.stateDir, 'engine.log'), 'a')
  } catch (error) { engOut = null }
  const opts = engOut === null
    ? { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    : { windowsHide: true, stdio: ['ignore', engOut, engOut] }

  /*
   * 引擎的实现是**异步探出来**的（要看它自报的完整性级别），但 spawnEngine 是同步接口
   * —— 调用方（/bridge/auto、/voice/owner）都当它是同步的。
   * 所以这里先按当前已知情况起：探过且发现被降级 → 直接起 python 版；
   * 还没探过 → 先起原版，同时后台探一次，探到被降级就**把引擎换掉**（重起一个 python 版）。
   * 这样"第一次可能白起一个"，但之后就一直是正确的实现，不需要重启 dsh。
   */
  const usePython = enginePick !== null && enginePick.kind === 'python'
  const argv = usePython ? pythonEngineArgs(args) : args
  const exe = usePython ? enginePick.exe : ENGINE

  const child = spawn(exe, argv, opts)
  if (engOut !== null) child.on('exit', () => { try { closeSync(engOut) } catch (error) { /* 已关 */ } })
  const handle = {
    pid: child.pid === undefined ? 0 : child.pid,
    killed: false,
    python: usePython,
    kill() {
      handle.killed = true
      try { child.kill() } catch (error) { /* 已退出 */ }
      return true
    },
  }
  child.on('error', () => { try { onExit() } catch (error) { /* 忽略 */ } })
  child.on('exit', () => { if (handle.killed !== true) { try { onExit() } catch (error) { /* 忽略 */ } } })
  return handle
}

/** 把原版引擎的参数翻成 python 版的（去掉开头的 'read'）。 */
function pythonEngineArgs(args) {
  return [resolve(HERE, '..', 'engine', 'read-engine.py')].concat(args.filter((a) => a !== 'read'))
}

function readBridgeState() {
  try { return JSON.parse(readFileSync(bridgeStatePath(), 'utf8')) } catch (error) { return {} }
}
function writeBridgeState(value) {
  try {
    mkdirSync(settings().stateDir, { recursive: true })
    writeFileSync(bridgeStatePath(), JSON.stringify(value, null, 2), 'utf8')
  } catch (error) { /* 状态写不进去不影响主流程 */ }
}

const KNOWN_BUTTONS = new Set(['ok', 'up', 'down', 'left', 'right', 'back', 'home', 'menu', 'tv', 'power', 'volup', 'voldown', 'voice'])
const KNOWN_SLOTS = new Set(['click', 'double', 'hold'])

/** 读映射：文件缺/坏都回默认方案，不让面板白屏。 */
/** vkeys 的读入校验：键必须是已知按键名，值是 1..255 的整数（VKey 码）。 */
function readVKeys(value) {
  const clean = {}
  if (value === null || value === undefined || typeof value !== 'object') return clean
  for (const button of KNOWN_BUTTONS) {
    const code = Number(value[button])
    if (Number.isInteger(code) && code >= 1 && code <= 255) clean[button] = code
  }
  return clean
}

/**
 * 读映射的**安全版**：把"没存过"和"读坏了"分开。
 *
 * 为什么必须有这个（2026-10-11 用户报"我之前做的设置消失了"，查出来的真 bug）：
 *   `readMapping()` 的 catch 分支是 `return defaultMapping()` —— 读失败就返回默认值。
 *   而 /bridge/auto 里有 `writeMapping(readMapping())`（读回来立刻写回去，本意是同步固定映射）。
 *   两者一撞：**只要 mapping.json 有一瞬间读不了**（面板正在写、杀软占着文件、写到一半），
 *   就会把默认映射写回磁盘 —— **用户的配置当场被抹掉**。
 *
 * 语义分清楚：
 *   · 文件不存在       → 没存过，返回默认值（正常）
 *   · 文件存在但读不动  → 绝不能拿默认值去覆盖，返回 ok:false 让调用方停手
 */
export function readMappingSafe() {
  const path = mappingPath()
  if (existsSync(path) !== true) return { ok: true, mapping: defaultMapping(), fresh: true }
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    return { ok: false, error: 'mapping-unreadable', message: String(error && error.message) }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, error: 'mapping-bad-json', message: String(error && error.message) }
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.version !== 1) {
    return { ok: false, error: 'mapping-bad-shape' }
  }
  return { ok: true, mapping: readMapping() }
}

export function readMapping() {
  try {
    const raw = readFileSync(mappingPath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || parsed.version !== 1) throw new Error('bad version')
    const base = defaultMapping()
    for (const button of KNOWN_BUTTONS) {
      const row = parsed.buttons && parsed.buttons[button]
      if (row === null || typeof row !== 'object') continue
      for (const slot of KNOWN_SLOTS) {
        if (row[slot] === null || row[slot] === undefined) { base.buttons[button][slot] = null; continue }
        const action = row[slot]
        if (typeof action !== 'object' || typeof action.type !== 'string') continue
        if (action.type === 'dsh') {
          const preset = DSH_PRESETS.find((candidate) => candidate.id === action.id)
          base.buttons[button][slot] = preset === undefined ? null
            : { type: 'dsh', id: preset.id, label: preset.label, combo: preset.combo }
        } else if (action.type === 'key') {
          if (typeof action.combo !== 'string' || action.combo.length === 0 || action.combo.length > 64) continue
          base.buttons[button][slot] = { type: 'key', id: 'key:' + action.combo, label: action.combo, combo: action.combo }
        } else if (action.type === 'app') {
          const name = String(action.combo || '').slice(0, 64)
          if (name.length === 0) continue
          base.buttons[button][slot] = { type: 'app', id: 'app:' + name, label: '打开 ' + name, combo: name }
        } else if (action.type === 'holdkey') {
          // 读盘时也要认，否则存过的"按住 Alt"会在下次读回时被悄悄丢掉。
          const combo = String(action.combo || '').slice(0, 64)
          if (combo.length === 0) continue
          base.buttons[button][slot] = holdKey(combo)
        }
      }
    }
    base.updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null
    base.vkeys = readVKeys(parsed.vkeys)
    /*
     * 语音键是**固定映射**（用户 2026-10-11 裁定：不改），所以永远用代码里那一份，
     * 不从磁盘读、也不因为文件里缺它就没配。
     *
     * 这个坑当场踩过：磁盘上那份 mapping.json 是加语音键之前存的，里面没有 voice 这一项；
     * 于是引擎 ready 时只报 buttons:12，按 mic 键完全没反应 —— 而采集器那边明明是收到的。
     * 类型是"固定映射"的东西就不该依赖用户文件的完整性。
     */
    base.buttons.voice = defaultMapping().buttons.voice
    return base
  } catch {
    return defaultMapping()
  }
}

/** 写映射：只接受结构合法的整份（面板是唯一编辑器，不接受部分补丁）。 */
export function writeMapping(next) {
  if (next === null || typeof next !== 'object' || next.version !== 1 || next.buttons === null || typeof next.buttons !== 'object') {
    return { ok: false, error: 'bad-mapping-shape' }
  }
  /*
   * 覆盖前先留一份备份。
   *
   * 2026-10-11：用户报"我之前做的设置消失了"。根因是读失败会返回默认值、又被立刻写回去
   * （见 readMappingSafe 的注释）。那道闸已经堵了，但**配置这种东西必须有后悔药** ——
   * 万一还有别的路径会写坏，至少能从 mapping.bak.json 捞回来。
   */
  try {
    if (existsSync(mappingPath())) copyFileSync(mappingPath(), join(settings().stateDir, 'mapping.bak.json'))
  } catch (error) { /* 备份失败不阻断写入 */ }
  const clean = defaultMapping()
  let actions = 0
  for (const button of KNOWN_BUTTONS) {
    const row = next.buttons[button]
    if (row === null || typeof row !== 'object') continue
    for (const slot of KNOWN_SLOTS) {
      const action = row[slot]
      if (action === null || action === undefined) { clean.buttons[button][slot] = null; continue }
      if (typeof action !== 'object') return { ok: false, error: 'bad-action', button, slot }
      if (action.type === 'dsh') {
        const preset = DSH_PRESETS.find((candidate) => candidate.id === action.id)
        if (preset === undefined) return { ok: false, error: 'unknown-preset', button, slot, id: action.id }
        clean.buttons[button][slot] = { type: 'dsh', id: preset.id, label: preset.label, combo: preset.combo }
        actions += 1
      } else if (action.type === 'key') {
        const combo = String(action.combo || '').trim()
        if (combo.length === 0 || combo.length > 64) return { ok: false, error: 'bad-combo', button, slot }
        clean.buttons[button][slot] = { type: 'key', id: 'key:' + combo, label: combo, combo }
        actions += 1
      } else if (action.type === 'app') {
        const name = String(action.combo || '').trim().slice(0, 64)
        if (name.length === 0) return { ok: false, error: 'bad-app-name', button, slot }
        clean.buttons[button][slot] = { type: 'app', id: 'app:' + name, label: '打开 ' + name, combo: name }
        actions += 1
      } else if (action.type === 'holdkey') {
        // 按住不放型：长按触发时把这个键按住，遥控器键松开时才放开（语音键要的就是这个）。
        const combo = String(action.combo || '').trim()
        if (combo.length === 0 || combo.length > 64) return { ok: false, error: 'bad-combo', button, slot }
        clean.buttons[button][slot] = holdKey(combo)
        actions += 1
      } else {
        return { ok: false, error: 'unknown-action-type', button, slot, type: action.type }
      }
    }
  }
  clean.updatedAt = new Date().toISOString()
  clean.vkeys = readVKeys(next.vkeys)
  const cfg = settings()
  try {
    mkdirSync(cfg.stateDir, { recursive: true })
    writeFileSync(mappingPath(), JSON.stringify(clean, null, 2), 'utf8')
    return { ok: true, actions, path: mappingPath(), mapping: clean }
  } catch (error) {
    return { ok: false, error: 'write-failed', message: String(error && error.message) }
  }
}

/**
 * 只改 vkeys 表（把学到的键码指定给某个按键名），动作映射保持现状。
 * 面板上「学习 → 指定为某个键」这条路走这里。
 */
export function writeVKeys(vkeys) {
  const current = readMapping()
  const result = writeMapping({
    version: 1,
    updatedAt: new Date().toISOString(),
    buttons: current.buttons,
    vkeys: vkeys,
  })
  return result
}

export function resetMapping() {
  const result = writeMapping(defaultMapping())
  return { ...result, reset: true }
}

/* ── HTTP 路由与工具 ──────────────────────────────────────────────────── */

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
  return new Promise((resolvePromise) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 256 * 1024) { req.destroy(); resolvePromise(null); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text === '') { resolvePromise({}); return }
      try { resolvePromise(JSON.parse(text)) } catch { resolvePromise(null) }
    })
    req.on('error', () => resolvePromise(null))
  })
}

/** 工具返回值的统一渲染。 */
const plainOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
}

export const name = 'dsh-mi-remote'
export const inject = ['webServer']

/** 最近一次由浏览器半段上报的布局诊断（见路由里的 /diag 注释）。 */
let lastDiag = null
/** 事件类诊断（渲染错误、面板挂载探测…）—— 面板白屏时这是唯一能看到原因的地方。 */
const diagnostics = []

/**
 * 把整条按键链路拉起来（采集器 + 引擎），返回结果对象。
 *
 * 从 `/bridge/auto` 的那段处理里抽出来的 —— 因为现在有**两个入口**要调它：
 *   ① 面板挂载时调的 `POST /bridge/auto`（原有的路）
 *   ② **DSH 启动时宿主自己调一次**（2026-10-11 用户要求：「DSH启动的时候自动启动遥控器的引擎」）
 * 两条路必须走同一份逻辑，否则两边对"采集器要不要复用""引擎算不算残留"的判断会分叉。
 *
 * 行为要点（每一条都是踩出来的，改动前先读）：
 *   · **读不动映射就不写**（`readMappingSafe`）—— 否则用户配置被默认值覆盖；
 *   · **无条件先清掉场上所有引擎**再按需起一个 —— dsh 重启后旧引擎不一定跟着退；
 *   · **采集器在跑且模式一致就复用** —— 面板重新挂载会再调一次，两边互相残杀过一次；
 *   · 起引擎前**先探完整性级别**，被安全软件降到 Low 就改用 python 版（否则静默失效）。
 */
async function ensureBridgeRunning() {
  // ① 映射文件不存在就先补一份默认的（引擎读不到配置会直接退出）
  if (existsSync(mappingPath()) !== true) {
    const seeded = writeMapping(defaultMapping())
    if (seeded.ok !== true) return { ok: false, error: 'seed-mapping-failed', detail: seeded.error }
  }
  /*
   * ② 每次拉起都把"补齐后的映射"落一次盘 —— 引擎是自己读磁盘的，磁盘上那份可能
   *    还是老版本存的、没有 voice 键。但**读失败时绝不能写**（覆盖用户配置的根因）。
   */
  const readBack = readMappingSafe()
  if (readBack.ok !== true) {
    return {
      ok: false, error: 'mapping-unreadable-kept-untouched',
      detail: readBack.error, message: readBack.message,
      hint: '映射文件读不动，已跳过"写回"这一步以免覆盖你的配置。请再试一次；若反复出现，看 state/mapping.bak.json',
    }
  }
  const synced = writeMapping(readBack.mapping)
  if (synced.ok !== true) return { ok: false, error: 'sync-mapping-failed', detail: synced.error }

  // ③ 无条件清掉场上所有引擎（不能只判断"我记着的那个"）
  await killStrayEngines()
  runChild = null

  /*
   * ★ 遥控器整台让给 SayAll 时，**连采集器都不起**，直接返回。
   *
   * 2026-10-21 实测纠正：原来这里只跳过引擎、照旧起采集器（只观察不改写），
   * 以为"不改写就等于让开"——**错**。两个 Frida 钩子挂在同一个 IOCTL 上，
   * 只要还挂着就在抢；证据是采集器 `hooked` 成功但 `keys.jsonl` 一条真实报告都没有，
   * 而场上 9 个 frida-helper、停掉 DSH 那份后降到 6 个。
   *
   * 所以这里**必须早退**，一个进程都不起。切回 DSH 时 `/remote/owner` 会重新走
   * 正常的拉起流程（它调的就是这个函数）。
   */
  if (dshOwnsRemote() !== true) {
    return {
      ok: true, mode: 'hands-off', remoteOwner: remoteOwner(),
      engineSuppressed: true, collectorSuppressed: true,
      collectorPid: null, enginePid: null,
      note: '遥控器归 SayAll：DSH 不 attach、不注入，一个进程都不起',
    }
  }

  // ④ 采集器：已经在跑且模式一致就复用，不动它
  /*
   * `wantOwns` 要与 `collectorArgs` 同口径 —— 那边只要 voiceOwner 或 remoteOwner
   * 有一个是 sayall 就带 `--sayall-owns-voice`。不同口径会让"复用"判断永远不等、
   * 每次 /bridge/auto 都把采集器重建一遍。
   */
  const wantOwns = voiceOwner() === 'sayall' || remoteOwner() === 'sayall'
  const existing = await findRunningCollector()
  if (enginePick === null) enginePick = await pickEngine()
  if (existing !== null && existing.sayallOwns === wantOwns) {
    /*
     * ⚠️ 遥控器归 SayAll 时**不启引擎** —— 这是"整台给 SayAll"的核心：
     * DSH 一个键都不注入，SayAll 才能独占。否则上面那些开关设了等于没设
     * （下次自动启动或面板挂载又会把引擎拉起来）。
     */
    if (dshOwnsRemote() && (runChild === null || runChild.killed === true)) {
      runChild = spawnEngine(['read', '--config', mappingPath(), '--file', keysPath(),
        '--verbose', '--out', runLogPath()], () => { runChild = null })
    }
    return {
      ok: true, mode: 'read', reused: true, python: findPython(),
      engineImpl: enginePick.kind, engineIntegrity: enginePick.level,
      collectorPid: existing.pid, enginePid: runChild === null ? null : runChild.pid,
      voiceOwner: voiceOwner(),
      remoteOwner: remoteOwner(),
      engineSuppressed: dshOwnsRemote() !== true,
    }
  }

  // ⑤ 模式不一致（或压根没在跑）：清掉残留，按当前模式起一套干净的
  await killStrayPipeline()
  runChild = null
  collectorChild = null
  const python = findPython()
  if (python === null) {
    return { ok: false, error: 'python-not-found', hint: 'Frida 采集器要 Python，装一个或把路径写进设置' }
  }
  const hostPid = await findRemoteHostPid()
  if (hostPid === null) {
    return { ok: false, error: 'wudfhost-not-found', hint: '没找到承载遥控器的 WUDFHost.exe，先确认遥控器已连上' }
  }
  const keysFile = keysPath()
  try { rmSync(keysFile, { force: true }) } catch (error) { /* 不存在就算了 */ }
  collectorChild = spawnCollector(python, hostPid, keysFile)
  collectorChild.on('error', () => { collectorChild = null })
  await delay(1200)   // 等采集器把 hook 装上并写出 ready 行
  // 遥控器归 SayAll 时只起采集器（观察），引擎不启 —— 见上面 ④ 的说明
  if (dshOwnsRemote()) {
    runChild = spawnEngine(['read', '--config', mappingPath(), '--file', keysFile,
      '--verbose', '--out', runLogPath()], () => { runChild = null })
  } else {
    runChild = null
  }
  runFilter = 'frida:' + String(hostPid)
  writeBridgeState({ ...readBridgeState(), filter: runFilter, startedAt: Date.now(), mode: 'read' })
  return {
    ok: true, mode: 'read', hostPid, python,
    engineImpl: enginePick === null ? 'keybridge' : enginePick.kind,
    engineIntegrity: enginePick === null ? null : enginePick.level,
    collectorPid: collectorChild === null ? null : collectorChild.pid,
    enginePid: runChild === null ? null : runChild.pid,
    remoteOwner: remoteOwner(),
    engineSuppressed: dshOwnsRemote() !== true,
  }
}

/*
 * ── DSH 启动时自动把链路拉起来（2026-10-11 用户要求）──────────────────────
 *
 * 背景：原来只有**面板挂载**时才调 `/bridge/auto`。结果是"DSH 重启后遥控器就不灵了，
 * 必须先去把那个面板点开一次"。用户的要求是「DSH启动的时候自动启动遥控器的引擎」。
 *
 * 为什么不能起来就立刻调：
 *   · 蓝牙驱动宿主（WUDFHost）可能还没就绪，那时查到的是 `wudfhost-not-found`；
 *   · 遥控器也可能还没连上（用户可能稍后才开遥控器）。
 * 所以做成**有限次重试**：先等几秒，失败就隔一段时间再来，最多试 N 轮。
 * 超过之后不再试 —— 那种情况下用户开面板会走 `/bridge/auto`，那条路一直都在。
 *
 * 关掉它：环境变量 `DSH_MIREMOTE_AUTOSTART=0`。
 */
const AUTO_START_FIRST_DELAY_MS = 6000
const AUTO_START_RETRY_MS = 30000
const AUTO_START_MAX_TRIES = 8
/** 自动启动的最近一次结果（`/bridge` 会报给面板，便于排查"为什么没自动起来"）。 */
let autoStartState = { enabled: false, tries: 0, ok: null, error: null, at: null }

function scheduleAutoStart(ctx) {
  const flag = String(process.env.DSH_MIREMOTE_AUTOSTART ?? '').trim().toLowerCase()
  if (flag === '0' || flag === 'false' || flag === 'off') {
    autoStartState = { enabled: false, tries: 0, ok: null, error: 'disabled-by-env', at: Date.now() }
    return
  }
  autoStartState = { enabled: true, tries: 0, ok: null, error: null, at: null }
  let tries = 0
  const attempt = async () => {
    tries += 1
    let result
    try {
      result = await ensureBridgeRunning()
    } catch (error) {
      result = { ok: false, error: 'threw', detail: String((error && error.message) || error) }
    }
    autoStartState = {
      enabled: true, tries,
      ok: result.ok === true,
      error: result.ok === true ? null : String(result.error || 'unknown'),
      at: Date.now(),
    }
    /*
     * 成功就收工。失败看是什么原因：
     *   · `wudfhost-not-found` / `python-not-found` —— 环境还没就绪，值得再试；
     *   · 其余（映射读不动等）重试也没用，但重试次数有限，不至于刷屏。
     */
    if (result.ok !== true && tries < AUTO_START_MAX_TRIES) {
      const timer = setTimeout(() => { void attempt() }, AUTO_START_RETRY_MS)
      if (timer && typeof timer.unref === 'function') timer.unref()
    }
  }
  const first = setTimeout(() => { void attempt() }, AUTO_START_FIRST_DELAY_MS)
  if (first && typeof first.unref === 'function') first.unref()
  void ctx
}

/**
 * 扫一遍场上真实的链路进程（采集器 / 引擎），回 pid 列表。
 *
 * 为什么不看 `collectorChild` / `runChild` 那两个句柄：
 *   · 采集器可能是**上一次 dsh 起的**（`/bridge/auto` 的"复用"分支就不会给句柄，
 *     见 `findRunningCollector` 那段），句柄 null 但进程在跑；
 *   · Windows 上父进程死了子进程不跟着死，孤儿很常见。
 * 面板上的开关必须反映**真实在不在跑**，否则用户点"关"没反应、点"开"又说已经在跑。
 *
 * 返回 `{ collector: [pid…], engine: [pid…] }`。查询失败一律当空数组（不抛）。
 */
function scanPipelineProcesses() {
  return new Promise((resolvePromise) => {
    /*
     * ⚠️ 名单必须覆盖**每一种引擎实现** —— 2026-10-11 的教训：漏了 python 版引擎，
     * 结果攒到 4 个引擎同时注入。加新引擎实现时，这里和 killStrayEngines 一起改。
     */
    const ps = 'Get-CimInstance Win32_Process | Where-Object { ' +
      '($_.Name -eq \'KeyBridge.exe\' -and $_.CommandLine -match \'read\') -or ' +
      '($_.Name -eq \'python.exe\' -and ($_.CommandLine -match \'rc003-tap\' -or $_.CommandLine -match \'read-engine\')) } | ' +
      'ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; line = $_.CommandLine } } | ConvertTo-Json -Compress'
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        const out = { collector: [], engine: [] }
        if (error) { resolvePromise(out); return }
        const text = String(stdout || '').trim()
        if (text === '') { resolvePromise(out); return }
        let rows
        try {
          const parsed = JSON.parse(text)
          rows = Array.isArray(parsed) ? parsed : [parsed]
        } catch (parseError) { resolvePromise(out); return }
        for (const row of rows) {
          if (row === null || row === undefined) continue
          const line = String(row.line || '')
          const pid = Number(row.pid)
          if (!Number.isFinite(pid)) continue
          if (line.indexOf('rc003-tap') >= 0) out.collector.push(pid)
          else if (line.indexOf('read-engine') >= 0 || /KeyBridge\.exe/i.test(line)) out.engine.push(pid)
        }
        resolvePromise(out)
      })
  })
}

/** 只收**采集器**（不动引擎）。开关"关"那一档要用它。 */
function killStrayCollectors() {
  return new Promise((resolvePromise) => {
    const ps = 'Get-CimInstance Win32_Process | Where-Object { ' +
      '$_.Name -eq \'python.exe\' -and $_.CommandLine -match \'rc003-tap\' } | ' +
      'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 20000 }, () => resolvePromise())
  })
}

/**
 * 采集器 / 引擎此刻到底在不在跑（一次扫描，两个布尔 + pid）。
 * 给面板的开关读状态用。
 *
 * 带 **2 秒缓存**：面板每 10 秒轮询一次 `/link`，如果每次都去扫全进程表
 * （起一个 powershell、枚举 Win32_Process），既慢又没必要 —— 开关状态
 * 差两秒完全够用。缓存只作用于"读"，写（`setChildPower`）之后会主动清掉。
 */
let childrenCache = { at: 0, value: null }
async function bridgeChildrenState() {
  const scanned = await scanPipelineProcesses()
  const collectorHandleAlive = collectorChild !== null && collectorChild !== undefined && collectorChild.killed !== true
  const engineHandleAlive = runChild !== null && runChild !== undefined && runChild.killed !== true
  const value = {
    collector: {
      running: collectorHandleAlive || scanned.collector.length > 0,
      pid: scanned.collector.length > 0 ? scanned.collector[0]
        : (collectorHandleAlive ? collectorChild.pid : null),
      count: scanned.collector.length,
    },
    engine: {
      running: engineHandleAlive || scanned.engine.length > 0,
      pid: scanned.engine.length > 0 ? scanned.engine[0]
        : (engineHandleAlive ? runChild.pid : null),
      count: scanned.engine.length,
    },
  }
  // 顺手刷新缓存：这样开关"写完立刻读"不会拿到两秒前的旧值。
  childrenCache = { at: Date.now(), value }
  return value
}

/** 带 2 秒缓存的那份（给高频读取用）。见 `childrenCache` 的说明。 */
const CHILDREN_CACHE_MS = 2000
async function bridgeChildrenStateCached() {
  if (childrenCache.value !== null && Date.now() - childrenCache.at < CHILDREN_CACHE_MS) {
    return childrenCache.value
  }
  const value = await bridgeChildrenState()
  childrenCache = { at: Date.now(), value }
  return value
}

/**
 * 采集器或引擎单独开 / 关。`which` 取 `'collector'` 或 `'engine'`。
 *
 * 为什么允许单独开关（而不是只做一个总闸）：
 *   · 单独重启引擎是**真实有用的工况** —— 改了映射方案要重载，但不想重新挂 Frida
 *     （重挂要 1.2 秒且偶尔要重试），只换引擎最快；
 *   · 但两个单独关掉都会让遥控器失效，所以面板上会给出耦合提示，
 *     见 `bridgeChildrenState` 的调用方。**开关各管各的，不做隐式联动** ——
 *     "点了个开关，另一个也动了"是最容易让人困惑的行为。
 */
async function setChildPower(which, on) {
  if (which !== 'engine' && which !== 'collector') {
    return { ok: false, error: 'bad-which', which }
  }
  const before = await bridgeChildrenState()

  if (which === 'engine') {
    if (on !== true) {
      await killStrayEngines()
      runChild = null
      const after = await bridgeChildrenState()
      return { ok: true, which, running: after.engine.running, changed: before.engine.running }
    }
    if (before.engine.running) {
      return { ok: true, which, running: true, reused: true, pid: before.engine.pid }
    }
    /*
     * 遥控器整台给了 SayAll 时**拒绝开引擎** —— 否则这个开关会把"让给 SayAll"
     * 悄悄破坏掉：用户点一下引擎开关，DSH 又开始抢按键，而面板上那个
     * 「遥控器归属」还显示着 SayAll，两边自相矛盾。
     * 想开引擎就先把归属切回 DSH（错误信息里直接告诉他）。
     */
    if (dshOwnsRemote() !== true) {
      return {
        ok: false, which, running: false, error: 'remote-owned-by-sayall',
        hint: '遥控器当前归 SayAll 使用（「遥控器归属」= SayAll）。要 DSH 用，先把归属切回 DSH。',
      }
    }
    // 起引擎前先保证映射文件在（引擎读不到配置会直接退出）
    if (existsSync(mappingPath()) !== true) {
      const seeded = writeMapping(defaultMapping())
      if (seeded.ok !== true) return { ok: false, which, error: 'seed-mapping-failed', detail: seeded.error }
    }
    runChild = spawnEngine(['read', '--config', mappingPath(), '--file', keysPath(),
      '--verbose', '--out', runLogPath()], () => { runChild = null })
    if (runChild === null) {
      return { ok: false, which, error: 'engine-missing', hint: '找不到引擎可执行文件（engine/KeyBridge.exe）' }
    }
    await delay(400)
    const after = await bridgeChildrenState()
    return { ok: true, which, running: after.engine.running, reused: false, pid: after.engine.pid }
  }

  // which === 'collector'
  if (on !== true) {
    await killStrayCollectors()
    collectorChild = null
    const after = await bridgeChildrenState()
    return { ok: true, which, running: after.collector.running, changed: before.collector.running }
  }
  if (before.collector.running) {
    return { ok: true, which, running: true, reused: true, pid: before.collector.pid }
  }
  /*
   * 遥控器整台给了 SayAll 时**拒绝起采集器** —— 理由同引擎那条：
   * 采集器一 attach 就占住那个 IOCTL，SayAll 立刻收不到按键（2026-10-21 实测）。
   * 想用 DSH 就先把归属切回 DSH。
   */
  if (dshOwnsRemote() !== true) {
    return {
      ok: false, which, running: false, error: 'remote-owned-by-sayall',
      hint: '遥控器当前归 SayAll 使用。采集器一挂上钩子 SayAll 就收不到按键，所以这里不让开。要 DSH 用，先把归属切回 DSH。',
    }
  }
  const python = findPython()
  if (python === null) {
    return { ok: false, which, error: 'python-not-found', hint: 'Frida 采集器要 Python，装一个或把路径写进设置' }
  }
  const hostPid = await findRemoteHostPid()
  if (hostPid === null) {
    return { ok: false, which, error: 'wudfhost-not-found', hint: '没找到承载遥控器的 WUDFHost.exe，先确认遥控器已连上' }
  }
  const keysFile = keysPath()
  try { rmSync(keysFile, { force: true }) } catch (error) { /* 不存在就算了 */ }
  collectorChild = spawnCollector(python, hostPid, keysFile)
  collectorChild.on('error', () => { collectorChild = null })
  await delay(1200)   // 等采集器把 hook 装上并写出 ready 行
  runFilter = 'frida:' + String(hostPid)
  writeBridgeState({ ...readBridgeState(), filter: runFilter, startedAt: Date.now(), mode: 'read' })
  const after = await bridgeChildrenState()
  return { ok: true, which, running: after.collector.running, reused: false, pid: after.collector.pid }
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: async (req, res) => {
      let url
      try { url = new URL(req.url || '/', 'http://127.0.0.1') } catch { sendJson(res, 400, { ok: false, error: 'bad-url' }); return }
      const path = url.pathname.slice(ROUTE.length)
      const method = String(req.method || 'GET').toUpperCase()

      try {
        if (path === '/link' && method === 'GET') {
          sendJson(res, 200, await linkStatus(url.searchParams.get('force') === '1'))
          return
        }
        /*
         * ── 「状态卡点了就能修」那三个动作的后端（2026-10-11 用户要求）──────────
         *
         * 用户原话：「设备如果是未连接状态，则默认显示可连接设备，点击链接；
         *            采集器/引擎如果是未运行状态，点击之后开始运行；
         *            VB-CABLE 卡片中同样，如果状态是离线，则点击之后加载激活」
         *
         * 三件事的难度差得很远，如实记在这里：
         *   · 采集器/引擎  → 复用 `POST /bridge/auto`，现成的，不用新路由；
         *   · 遥控器连接    → 需要蓝牙枚举 + 配对，走 audio/bt-pair.ps1（新）；
         *   · VB-CABLE     → 走 audio/cable-activate.ps1（新），**装驱动那一步做不了**
         *                    （要管理员 + 安装包），脚本会如实回 `action: install` 并给出指引。
         */
        if (path === '/bt/scan' && method === 'POST') {
          /*
           * ⚠️ 超时必须覆盖：枚举**未配对**设备要网卡做主动搜索（inquiry），
           *    实测 20 秒回不来（默认 deadlineMs 就会被掐断）。给 60 秒。
           *    界面那边要有"搜索中…"状态 —— 这个请求本来就要等这么久。
           */
          sendJson(res, 200, await runScript('bt-pair.ps1', ['scan'], { timeoutMs: 60000 }))
          return
        }
        if (path === '/bt/pair' && method === 'POST') {
          const body = await readBody(req)
          const deviceId = String((body && (body.id || body.deviceId)) || '')
          if (deviceId === '') { sendJson(res, 400, { ok: false, error: 'need-device-id' }); return }
          // pair = 没配对过；connect = 配对过但断了。（底层是两件事，见脚本头注释）
          const action = body && body.alreadyPaired === true ? 'connect' : 'pair'
          const result = await runScript('bt-pair.ps1', [action, deviceId], { timeoutMs: 45000 })
          /*
           * 配对/连接成功之后，链路要重拉一次 —— 遥控器刚连上时 WUDFHost 才有那个接口，
           * 而自动启动那轮可能已经跑完并失败了。这里顺手拉一次，用户不用再点一下。
           */
          if (result && result.ok === true) {
            try { await ensureBridgeRunning() } catch (error) { /* 拉不起来不影响配对结果本身 */ }
          }
          sendJson(res, 200, result)
          return
        }
        if (path === '/cable/activate' && method === 'POST') {
          sendJson(res, 200, await runScript('cable-activate.ps1', ['activate'], { timeoutMs: 40000 }))
          return
        }
        if (path === '/voice/status' && method === 'GET') {
          sendJson(res, 200, await voiceStatus(url.searchParams.get('force') === '1'))
          return
        }
        if (path === '/voice/apply' && method === 'POST') {
          const body = await readBody(req)
          const query = String((body && (body.query || body.id || body.name)) || '')
          if (query === '') { sendJson(res, 400, { ok: false, error: 'query-required' }); return }
          sendJson(res, 200, await voiceApply(query))
          return
        }
        if (path === '/voice/restore' && method === 'POST') {
          sendJson(res, 200, await voiceRestore())
          return
        }
        /*
         * 语音独占归谁：'sayall' | 'dsh'。**这个开关是真的**（原来只记个状态，是摆设）。
         *
         * 为什么必须二选一：SayAll 的 gadget 和我们的采集器都挂在同一个蓝牙驱动宿主上、
         * 盯同一个 IOCTL（0x80018483）。两边同时改写同一份报告会互相打架。
         *
         *   sayall —— 拉起 SayAll；采集器带 --sayall-owns-voice 重启（只观察不改写），
         *             语音整条路让给它。按键映射照常（那是引擎注入，与报告无关）。
         *   dsh    —— 停掉 SayAll；采集器按正常模式重启（报告里把语音键改写成左Alt + 锁存）。
         */
        if (path === '/voice/owner' && method === 'POST') {
          const body = await readBody(req)
          const want = body !== null && body !== undefined && body.owner === 'dsh' ? 'dsh' : 'sayall'
          writeBridgeState({ ...readBridgeState(), voiceOwner: want })

          let sayall = { ok: true }
          if (want === 'sayall') sayall = await sayallStart()
          else await sayallStop()

          /*
           * 重启采集器让它按新模式跑。引擎不用动 —— 它读的是采集器写的 JSON 行，格式没变。
           * 用 killStrayPipeline 收掉旧的，再按当前模式起一个新的（跟 /bridge/auto 同一套做法）。
           */
          await killStrayPipeline()
          collectorChild = null
          const python = findPython()
          const hostPid = python === null ? null : await findRemoteHostPid()
          let collectorPid = null
          if (python !== null && hostPid !== null) {
            collectorChild = spawnCollector(python, hostPid, keysPath())
            collectorChild.on('error', () => { collectorChild = null })
            collectorPid = collectorChild.pid
          }
          sendJson(res, 200, {
            ok: true, voiceOwner: want, sayall, python, hostPid, collectorPid,
            note: want === 'sayall'
              ? 'SayAll 接管语音；采集器只观察不改写'
              : 'DSH 接管语音；报告里把语音键改写成左Alt 并锁存',
          })
          return
        }
        /*
         * 遥控器整台归谁：'dsh' | 'sayall'（2026-10-21 用户要求）。
         *
         * 用户原话：「无线麦 sayall 正在抓取小米遥控器上的按键，但是除了语音键之外，
         *            其他的都被 dsh 的遥控器占用了，抓取不到……能否做一个类似于
         *            语音输入路径的语音独占那样的切换功能？」
         *
         * **根因不在改写，在注入。** 当时 `voiceOwner` 已经是 'sayall'，采集器带着
         * `--sayall-owns-voice`，一个字节都没改写；但引擎还在跑，每按一下就往系统里
         * 打一串快捷键 —— SayAll 那边等于在跟一堆注入事件抢同一台遥控器。
         *
         *   sayall —— **把引擎停掉**（DSH 一个键都不注入）+ 采集器保持只观察 ⇒ 整台让出去。
         *   dsh    —— 恢复：采集器按当前语音归属重启，引擎拉起来。
         */
        if (path === '/remote/owner' && method === 'POST') {
          const body = await readBody(req)
          const want = body !== null && body !== undefined && body.owner === 'sayall' ? 'sayall' : 'dsh'
          writeBridgeState({ ...readBridgeState(), remoteOwner: want })

          if (want === 'sayall') {
            /*
             * ⚠️ **采集器也必须停掉**，不能只"只观察不改写" —— 2026-10-21 实测纠正。
             *
             * 我最初以为 `--sayall-owns-voice`（只观察、不改写）就等于让开。**错的。**
             * 证据：切到 sayall 后 DSH 采集器注入成功（`hooked @ 0x7fff…`）、引擎已停，
             * 但 `keys.jsonl` 里只有一条**空报告** —— 用户按了一堆键，一条都没进来；
             * 同时场上挂着 **9 个 `frida-helper`**（SayAll 自己也在 attach WUDFHost）。
             * 停掉 DSH 采集器之后 frida-helper **9 → 6**，说明 DSH 那份会话确实还占着钩子。
             *
             * 结论：**两个 Frida 钩子打在同一个 IOCTL（0x80018483）上，只要还挂着就在抢**，
             * "不改写"不等于"不打扰"。想让 SayAll 拿到按键，DSH 必须**完全不 attach**。
             */
            await killStrayEngines()
            await killStrayCollectors()
            runChild = null
            collectorChild = null
            sendJson(res, 200, {
              ok: true, remoteOwner: 'sayall', collectorPid: null, enginePid: null,
              note: '遥控器整台让给 SayAll：引擎与采集器都已停，DSH 完全不碰这台设备',
            })
            return
          }

          /*
           * 采集器的模式跟着变：`--sayall-owns-voice` 的取舍见 `collectorArgs`。
           * 已经在跑且模式一致就复用（`/bridge/auto` 那套判断），避免每切一次都重挂。
           */
          const wantOwns = voiceOwner() === 'sayall' || want === 'sayall'
          const existing = await findRunningCollector()
          let collectorPid = existing === null ? null : existing.pid
          if (existing === null || existing.sayallOwns !== wantOwns) {
            await killStrayPipeline()
            collectorChild = null
            const python = findPython()
            const hostPid = python === null ? null : await findRemoteHostPid()
            if (python !== null && hostPid !== null) {
              collectorChild = spawnCollector(python, hostPid, keysPath())
              collectorChild.on('error', () => { collectorChild = null })
              collectorPid = collectorChild.pid
            }
          }

          // 切回 DSH 时把引擎拉起来（用统一入口，别在这里另写一套）
          let enginePid = null
          if (want === 'dsh') {
            const ensured = await ensureBridgeRunning()
            enginePid = ensured !== null && ensured !== undefined && ensured.enginePid !== undefined
              ? ensured.enginePid : null
          }

          sendJson(res, 200, {
            ok: true, remoteOwner: want, collectorPid, enginePid,
            note: want === 'sayall'
              ? '遥控器整台让给 SayAll：引擎已停（DSH 不注入），采集器只观察不改写'
              : '遥控器归 DSH：采集器按当前语音归属重启，引擎已拉起',
          })
          return
        }
        if (path === '/mapping' && method === 'GET') {
          sendJson(res, 200, { ok: true, mapping: readMapping(), buttons: BUTTONS, slots: SLOTS, presets: DSH_PRESETS })
          return
        }
        if (path === '/mapping' && method === 'POST') {
          const body = await readBody(req)
          if (body === null || body.mapping === undefined) { sendJson(res, 400, { ok: false, error: 'mapping-required' }); return }
          const result = writeMapping(body.mapping)
          sendJson(res, result.ok === true ? 200 : 400, result)
          return
        }
        if (path === '/mapping/reset' && method === 'POST') {
          sendJson(res, 200, resetMapping())
          return
        }
        /*
         * 布局诊断出口（2026-10-08 加）：浏览器半段把左侧栏底部那两块的真实几何上报到这里，
         * 供 agent 在**没有浏览器控制权**的情况下核对「遥控器那一行到底在谁上面」。
         * 起因：用户连着两轮反馈位置不对，而截图只能证明现象、证明不了根因
         * （父容器是不是同一个、flex 方向是什么、谁在上面 —— 这些只有页面自己知道）。
         */
        if (path === '/diag' && method === 'POST') {
          const body = await readBody(req)
          /*
           * 带 kind 的是**事件类**上报（渲染错误、面板挂载探测），攒成数组；
           * 不带的仍是布局快照，只留最新一份。分开存是因为前者要"看全"，后者只要"看现在"。
           */
          if (body !== null && typeof body.kind === 'string') {
            diagnostics.push({ at: Date.now(), ...body })
            while (diagnostics.length > 40) diagnostics.shift()
          } else {
            lastDiag = body
          }
          sendJson(res, 200, { ok: true, stored: true, events: diagnostics.length })
          return
        }
        if (path === '/diag' && method === 'GET') {
          sendJson(res, 200, { ok: true, diag: lastDiag, diagnostics })
          return
        }

        /* ── 按键桥引擎 ────────────────────────────────────────────────────
         * 面板只负责「配置」；让配置真正生效的是 engine/KeyBridge.exe：
         * Raw Input 监听遥控器 → 单击/双击/长按判定 → SendInput 注入。
         * 为什么自己在 DSH 侧做一份：SayAll 的按键映射由它自己的界面独占，
         * 它的官方 AI 协议也明确禁止外部脚本改它的私有配置（见 engine/KeyBridge.cs 顶部）。
         */
        if (path === '/bridge' && method === 'GET') {
          const savedBridge = readBridgeState()
          /*
           * `children` 是给面板开关读的**真实**运行状态（扫进程，不是看句柄）。
           * 和上面的 `run` 不同：`run` 只反映"这个 dsh 进程起的那个引擎"，
           * 采集器被复用时它是 null，孤儿进程也看不见 —— 拿它驱动开关会骗人。
           */
          const children = await bridgeChildrenStateCached()
          sendJson(res, 200, {
            ok: true,
            engine: existsSync(ENGINE),
            // 总闸：参考图里那个「启用自定义按键功能」。缺省视为开（不阻断），关掉时下面会停引擎。
            enabled: savedBridge.enabled !== false,
            learn: learnChild === null ? null : { pid: learnChild.pid, file: learnFilePath() },
            run: runChild === null ? null : { pid: runChild.pid, filter: runFilter },
            children,
            /* 遥控器整台归谁（'dsh' | 'sayall'）—— 面板那个「遥控器归属」开关读它 */
            remoteOwner: remoteOwner(),
            voiceOwner: voiceOwner(),
            saved: savedBridge,
            /*
             * DSH 启动时那次自动拉起的结果。
             * 报出来是为了能回答"为什么重启 DSH 之后遥控器没反应"——
             * 光看 run=null 分不清是"没试"、"试了但没找到 WUDFHost"还是"被环境变量关了"。
             */
            autoStart: autoStartState,
          })
          return
        }
        if (path === '/bridge/enabled' && method === 'POST') {
          const body = await readBody(req)
          const enabled = body !== null && body.enabled === true
          writeBridgeState({ ...readBridgeState(), enabled })
          if (enabled !== true) {
            // 关掉 = 立刻停手：正在跑的学习/执行进程都要收掉，否则"关了还在动"。
            for (const child of [learnChild, runChild]) {
              if (child === null) continue
              try { child.kill() } catch (error) { /* 已退出 */ }
            }
            learnChild = null
            runChild = null
            runFilter = null
          }
          sendJson(res, 200, { ok: true, enabled })
          return
        }
        if (path === '/bridge/devices' && method === 'POST') {
          const result = await engineOnce(['list'])
          if (result.ok !== true) { sendJson(res, 200, { ok: false, error: result.error, stderr: result.stderr }); return }
          const devices = []
          for (const line of result.stdout.split(/\r?\n/u)) {
            const trimmed = line.trim().replace(/^,+/u, '')
            if (trimmed.startsWith('{') !== true) continue
            try {
              const item = JSON.parse(trimmed)
              if (typeof item.name === 'string') devices.push({ name: item.name, xiaomi: item.xiaomi === true })
            } catch (error) { /* 拼行时可能截断，跳过 */ }
          }
          sendJson(res, 200, { ok: true, devices })
          return
        }
        if (path === '/bridge/learn/start' && method === 'POST') {
          const seconds = 45
          if (learnChild !== null) { try { learnChild.kill() } catch (error) { /* 已退出 */ } }
          try { rmSync(learnFilePath(), { force: true }) } catch (error) { /* 不存在 */ }
          learnChild = spawnEngine(['learn', '--any', '--seconds', String(seconds), '--out', learnFilePath()],
            () => { learnChild = null })
          sendJson(res, 200, { ok: learnChild !== null, pid: learnChild === null ? null : learnChild.pid, seconds, file: learnFilePath() })
          return
        }
        if (path === '/bridge/learn/result' && method === 'POST') {
          let text = ''
          try { text = readFileSync(learnFilePath(), 'utf8') } catch (error) { text = '' }
          const keys = []
          const seen = new Set()
          for (const line of text.split(/\r?\n/u)) {
            if (line.trim() === '') continue
            let event
            try { event = JSON.parse(line) } catch (error) { continue }
            if (event.type !== 'key') continue
            const key = String(event.device || '') + '#' + String(event.vkey)
            if (seen.has(key)) continue
            seen.add(key)
            keys.push({
              device: String(event.device || ''),
              vkey: Number(event.vkey),
              hex: String(event.hex || ''),
              makeCode: Number(event.makeCode),
              injected: event.injected === true,
              down: event.down === true,
            })
          }
          sendJson(res, 200, { ok: true, keys, lines: text.split(/\r?\n/u).length, learning: learnChild !== null })
          return
        }
        /*
         * /bridge/auto —— 面板打开时把整条链路自动拉起来，不需要用户在界面上开总闸。
         *
         * 三步：
         *   ① 找到承载遥控器的 WUDFHost.exe（按创建时间取最新那个）
         *   ② 起 Frida 采集器（engine/rc003-tap.py）—— 它 hook ntdll!NtDeviceIoControlFile，
         *      过滤 IOCTL 0x80018483，把每次 HID 报告写成一行 JSON
         *   ③ 起引擎的 read 模式，读那个 JSON 文件 → usage 映射成按键 → 判定 → 注入
         *
         * 为什么非得这么绕（2026-10-11 整夜实测的结论）：
         *   · 低级键盘钩子只对"本进程在前台"时有效，且拿不到 返回/音量
         *   · Raw Input（RIDEV_INPUTSINK）和 GetAsyncKeyState 在这台机器上完全收不到真实按键
         *   · 只有从蓝牙驱动宿主进程里读报告，才拿得到全部 12 个键、且不受前台焦点影响
         * 做法照搬 sayall-helper.exe 里内嵌的 rc003_agent.js（从那个 exe 里提取出来的）。
         */
        if (path === '/bridge/auto' && method === 'POST') {
          /*
           * 两条入口共用同一份逻辑：
           *   ① 这里 —— 面板挂载时调的；
           *   ② `apply` 里的 `scheduleAutoStart` —— DSH 启动时宿主自己调的。
           * 具体行为与每条约束的来由，见 `ensureBridgeRunning` 的注释。
           */
          sendJson(res, 200, await ensureBridgeRunning())
          return
        }
        if (path === '/bridge/run' && method === 'POST') {
          const body = await readBody(req)
          const filter = typeof body.filter === 'string' ? body.filter.trim() : ''
          if (filter === '') { sendJson(res, 200, { ok: false, error: 'need-filter' }); return }
          if (runChild !== null) { try { runChild.kill() } catch (error) { /* 已退出 */ } }
          /*
           * 引擎启动时要读 mapping.json。用户一直用默认方案、从没保存过的话这个文件并不存在，
           * 引擎会以 config-missing 直接退出 —— 面板上就表现成"点了启动、状态却一直没在跑"。
           * 所以这里先把默认方案落一份（2026-10-08 真机端到端验出来的缺陷）。
           */
          if (existsSync(mappingPath()) !== true) {
            const seeded = writeMapping(defaultMapping())
            if (seeded.ok !== true) {
              sendJson(res, 200, { ok: false, error: 'seed-mapping-failed', detail: seeded.error })
              return
            }
          }
          // 引擎跑起来后自己读 mapping.json；这里只负责把它拉起来并把过滤串记下来。
          const saved = readBridgeState()
          writeBridgeState({ ...saved, filter, startedAt: Date.now() })
          runChild = spawnEngine(['run', '--config', mappingPath(), '--filter', filter, '--out', runLogPath()],
            () => { runChild = null })
          runFilter = filter
          sendJson(res, 200, { ok: runChild !== null, pid: runChild === null ? null : runChild.pid, filter })
          return
        }
        if (path === '/bridge/stop' && method === 'POST') {          // 采集器要一起停：它和 read 模式的引擎是配对的，只停引擎的话 Frida 还挂在驱动宿主上。
          for (const child of [learnChild, runChild, collectorChild]) {
            if (child === null || child === undefined) continue
            try { child.kill() } catch (error) { /* 已退出 */ }
          }
          learnChild = null
          runChild = null
          collectorChild = null
          runFilter = null
          sendJson(res, 200, { ok: true })
          return
        }
        if (path === '/bridge/vkeys' && method === 'POST') {
          const body = await readBody(req)
          sendJson(res, 200, writeVKeys(body === null ? null : body.vkeys))
          return
        }
        /*
         * 采集器 / 引擎的**单独开关**（2026-10-21 用户要求：
         * 「为采集器和引擎配置开关功能，可以点击开启/关闭」）。
         *
         * 入参 `{ which: 'collector'|'engine', on: true|false }`。
         * 为什么不复用 `/bridge/stop`：那条是**总闸**（三个子件一起停），
         * 而开关需要"只停一个"；也只停采集器要单独收 Frida 进程。
         * 具体行为与耦合说明见 `setChildPower`。
         */
        if (path === '/bridge/power' && method === 'POST') {
          const body = await readBody(req)
          const which = String((body && body.which) || '')
          const on = body !== null && body !== undefined && body.on === true
          sendJson(res, 200, await setChildPower(which, on))
          return
        }
        /*
         * 「打开应用」这个动作能不能真的启动，取决于那个名字在不在 PATH / App Paths 里。
         * 找不到的话，用户按了键只会看到没反应、也不知道为什么 —— 所以让面板提前查一次。
         * 走 where.exe（系统自带），不自己解析 PATH。
         */
        if (path === '/bridge/check-app' && method === 'POST') {
          const body = await readBody(req)
          const name = body !== null && typeof body.name === 'string' ? body.name.trim() : ''
          if (name === '' || name.length > 200) {
            sendJson(res, 200, { ok: true, found: false, path: null, reason: 'empty' })
            return
          }
          if (/[\\/]/u.test(name)) {
            const hit = existsSync(name)
            sendJson(res, 200, { ok: true, found: hit, path: hit ? name : null, how: 'path' })
            return
          }
          execFile('where', [name], { windowsHide: true, timeout: 8000, encoding: 'utf8' }, (error, stdout) => {
            const first = String(stdout || '')
              .split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '')[0]
            sendJson(res, 200, {
              ok: true,
              found: error === null && first !== undefined,
              path: first === undefined ? null : first,
              how: 'where',
            })
          })
          return
        }
        /*
         * 通路自测：拿**你自己的键盘**跑一遍完整链路（监听 → 单击判定 → 注入）。
         *
         * 为什么需要它：遥控器还没配对时，整条链一个环节都没在真机上跑过。有了这条，
         * 随便按一个键就能确认「引擎真的能听见、真的能注入」——不必等遥控器。
         * 用的是**临时配置**，绝不碰用户的 mapping.json。
         */
        if (path === '/bridge/selftest-run' && method === 'POST') {
          const body = await readBody(req)
          const filter = body !== null && typeof body.filter === 'string' ? body.filter.trim() : ''
          const vkey = body === null ? NaN : Number(body.vkey)
          const combo = body !== null && typeof body.combo === 'string' && body.combo.trim() !== '' ? body.combo.trim() : 'Enter'
          if (filter === '' || Number.isInteger(vkey) !== true || vkey < 1 || vkey > 255) {
            sendJson(res, 200, { ok: false, error: 'bad-selftest-args' })
            return
          }
          const tempConfig = join(settings().stateDir, 'selftest-mapping.json')
          const tempLog = join(settings().stateDir, 'selftest-run.jsonl')
          try {
            mkdirSync(settings().stateDir, { recursive: true })
            writeFileSync(tempConfig, JSON.stringify({
              version: 1,
              buttons: { ok: { click: { type: 'dsh', id: 'dsh.send', combo }, double: null, hold: null } },
              vkeys: { ok: vkey },
            }, null, 2), 'utf8')
            rmSync(tempLog, { force: true })
          } catch (error) {
            sendJson(res, 200, { ok: false, error: 'temp-write-failed', message: String(error && error.message) })
            return
          }
          if (runChild !== null) { try { runChild.kill() } catch (error) { /* 已退出 */ } }
          runChild = spawnEngine(['run', '--config', tempConfig, '--filter', filter, '--seconds', '120', '--out', tempLog],
            () => { runChild = null })
          runFilter = filter
          sendJson(res, 200, {
            ok: runChild !== null, pid: runChild === null ? null : runChild.pid,
            filter, vkey, combo, log: tempLog, seconds: 120,
          })
          return
        }
        if (path === '/bridge/run/log' && method === 'GET') {
          let text = ''
          try { text = readFileSync(runLogPath(), 'utf8') } catch (error) { text = '' }
          const events = []
          const rows = text.split(/\r?\n/u)
          for (const line of rows.slice(-40)) {
            if (line.trim() === '') continue
            try { events.push(JSON.parse(line)) } catch (error) { /* 跳过半行 */ }
          }
          sendJson(res, 200, { ok: true, events })
          return
        }
        sendJson(res, 404, { ok: false, error: 'unknown-route', path })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: 'handler-failed', message: String(error && error.message) })
      }
    },
  }))

  // agent 工具：会话里也能体检/切路径/读写映射（与面板同一批函数，判定只有一份）。
  const tools = ctx.get('tools')
  if (tools !== undefined && tools !== null && typeof tools.register === 'function') {
    ctx.effect(() => tools.register({
      name: 'mi_remote',
      description: '小米遥控器控制台。action=link 链路体检（配对/SayAll/VB-CABLE/输入法）；'
        + 'action=voice_list 语音输入路径设备；action=voice_use 切默认录音设备；action=voice_restore 还原；'
        + 'action=mapping_get 读按键映射；action=mapping_reset 恢复默认方案。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['link', 'voice_list', 'voice_use', 'voice_restore', 'mapping_get', 'mapping_reset'], description: '要做的动作' },
          query: { type: 'string', description: 'voice_use 时的目标设备：名字或 id 片段' },
        },
        required: ['action'],
      },
      output: plainOutput,
      timeoutMs: 30000,
      async execute(args) {
        const action = String((args && args.action) || 'link')
        if (action === 'link') return await linkStatus(args && args.force === true)
        if (action === 'voice_list') return await voiceStatus(args && args.force === true)
        if (action === 'voice_use') return await voiceApply(String((args && args.query) || ''))
        if (action === 'voice_restore') return await voiceRestore()
        if (action === 'mapping_get') return { ok: true, mapping: readMapping(), buttons: BUTTONS, presets: DSH_PRESETS }
        if (action === 'mapping_reset') return resetMapping()
        return { ok: false, error: 'unknown-action', action }
      },
    }))
  }

  /*
   * DSH 启动时自动把按键链路拉起来（2026-10-11 用户要求）。
   *
   * 放在最后：上面那几件事（注册路由、注册工具）才是"插件能不能用"的前提，
   * 自动启动是**锦上添花**，不该抢在它们前面 —— 万一它慢（要等 WUDFHost、要探完整性），
   * 也不至于拖住插件的加载。
   *
   * 它自己带延迟与重试（见 scheduleAutoStart），所以这里调用是立即返回的。
   * 想关掉：环境变量 DSH_MIREMOTE_AUTOSTART=0。
   */
  scheduleAutoStart(ctx)
}