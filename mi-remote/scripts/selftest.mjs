#!/usr/bin/env node
/**
 * dsh-mi-remote 自测（Node 级，不需要浏览器）
 *
 * 跑法：node selftest.mjs          （纯函数与静态检查）
 *       node selftest.mjs --probe  （连真实探针：probe.ps1 + audio-device.ps1）
 */

import { readFileSync } from 'node:fs'
import { execFile, execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WITH_PROBE = process.argv.includes('--probe')

let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log('  PASS  ' + name) }
  else { fail += 1; console.log('  FAIL  ' + name + (detail === undefined ? '' : '  →  ' + detail)) }
}

console.log('dsh-mi-remote selftest')
console.log('')

/* ── [0] 执行器文件编码（PS 5.1 的 BOM 硬要求）────────────────────────── */
console.log('[0] 执行器文件编码')
for (const name of ['audio-device.ps1', 'probe.ps1']) {
  const bytes = readFileSync(join(HERE, 'audio', name))
  check(name + ' 有 UTF-8 BOM', bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF,
    '头三字节 ' + [bytes[0], bytes[1], bytes[2]].map((b) => b.toString(16).toUpperCase()).join(' '))
  check(name + ' 是合法 UTF-8', !bytes.toString('utf8').includes('\ufffd'))
  const text = bytes.toString('utf8')
  const backtickLines = text.split(/\r?\n/).map((line, i) => ({ line, n: i + 1 })).filter((r) => /^\s*#/.test(r.line) && r.line.includes('`'))
  check(name + ' 注释里没有反引号', backtickLines.length === 0, backtickLines.map((r) => 'L' + r.n).join(' '))
}

/* ── [1] 清单与 patch ──────────────────────────────────────────────────── */
console.log('')
console.log('[1] 包清单与 patch')
const manifest = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))
check('name 是 dsh-mi-remote', manifest.name === 'dsh-mi-remote', manifest.name)
check('type=module', manifest.type === 'module')
check('main 指向 lib/index.js', manifest.main === 'lib/index.js')
check('exports 有 ./client', manifest.exports && manifest.exports['./client'] !== undefined)
check('dsh.bundle.patch 指了 patch', manifest.dsh?.bundle?.patch === './cordis.patch.yml')
check('client.platform = web', manifest.dsh?.client?.platform === 'web')
check('声明了 icon', typeof manifest.icon === 'string')
const patch = readFileSync(join(HERE, 'cordis.patch.yml'), 'utf8')
check('patch 插入了 mi-remote 行', /id:\s*mi-remote/.test(patch) && /name:\s*'dsh-mi-remote'/.test(patch))

const clientSource = readFileSync(join(HERE, 'lib', 'client.js'), 'utf8')
try { new Function(clientSource); check('lib/client.js 可解析', true) } catch (e) { check('lib/client.js 可解析', false, String(e.message)) }

/*
 * 静态防线：**不许把 `key` 当数据 prop 读**。
 *
 * `key`（和 `ref`）是 React 的保留字段，不会传进组件 —— 用 key 当 prop 名时，组件里读到
 * 的永远是 undefined，一读属性就抛 `Cannot read properties of undefined`，被 slot 的错误
 * 边界一捕获就把**整个面板条目退位**，表现是右栏纯白（2026-10-08 白屏的真凶）。
 * 渲染桩已同步改成剥离 key（第一道防线）；这条读源码，桩写宽了也拦得住。
 * 逐行看不含注释里的举例，只看真正的代码。
 */
const codeLines = clientSource.split('\n')
  .map((line, index) => ({ line: line, no: index + 1 }))
  .filter((row) => {
    const trimmed = row.line.trim()
    return trimmed.startsWith('//') !== true && trimmed.startsWith('*') !== true && trimmed.startsWith('/*') !== true
  })
const keyMisuse = codeLines.filter((row) => /(?:given|props)\.key\b/u.test(row.line)).map((row) => row.no)
check('客户端源码里没有把 `key` 当 prop 读的地方', keyMisuse.length === 0,
  keyMisuse.length === 0 ? '' : '出现 ' + keyMisuse.length + ' 处（第 ' + keyMisuse.join(',') + ' 行；key 是 React 保留字段）')
const refMisuse = codeLines.filter((row) => /(?:given|props)\.ref\b/u.test(row.line)).map((row) => row.no)
check('客户端源码里没有把 `ref` 当 prop 读的地方', refMisuse.length === 0, '第 ' + refMisuse.join(',') + ' 行')

/*
 * ── [1b] 浏览器半段的 inject 契约（静态读源码，不看桩）────────────────────
 *
 * 客户端插件返回的 `{ apply, inject, name }` 里，`inject` 必须覆盖 apply 真正读的 ctx 成员。
 * `ctx.interval()` / `ctx.timeout()` / `ctx.throttle()` / `ctx.debounce()` 不是 Context 自己的
 * 方法，而是 TimerService 用 `ctx.mixin('timer', [...])` 混上去的 accessor —— cordis 的 ctx
 * 代理只允许读 inject 里列过的服务。少了 `timer`，apply 当场抛
 * `cannot get property "interval" without inject`，条目进 failed，启动页显示
 * 「Failed to load plugins / dsh-mi-remote」。
 *
 * 为什么非要在源码上守一道：渲染自测的 ctx 桩是**手写的**，写宽了（无条件提供 interval）
 * 就永远测不出来 —— 2026-10-08 这个坑连踩两次（dsh-remote-mic 一次，本插件从它派生时又带了一次），
 * 两次三套自测全绿。这条直接读 lib/client.js，桩再宽也拦得住。
 */
const TIMER_VERBS = new Set(['timeout', 'interval', 'setTimeout', 'setInterval', 'throttle', 'debounce'])
const CORE_VERBS = new Set([
  'effect', 'on', 'once', 'provide', 'get', 'set', 'accessor', 'mixin',
  'fiber', 'registry', 'reflect', 'plugin', 'emit', 'parallel', 'serial', 'bail', 'waterfall',
])
/*
 * 把 JS 源码里的注释和字符串字面量抹掉，只留真正会被执行的代码。
 *
 * 为什么需要：下面用正则扫 `ctx.<服务>` 来判断"用了哪些服务"，
 * 但**注释里、字符串里**出现的 `ctx.shortcuts.register` 并不是真的调用。
 * 2026-10-11 就因此误报过一次 —— 我在宿主注释里写了这个词，
 * 自检立刻报"宿主用了 shortcuts 但没声明"，其实宿主一个字节都没调它。
 * 扫描前先抹掉这两类内容，检测才反映实际代码。
 */
function stripNonCode(src) {
  let out = ''
  let i = 0
  let state = 'code' // code | line | block | single | double | template
  while (i < src.length) {
    const c = src[i]
    const c2 = src[i + 1]
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; i += 2; continue }
      if (c === '/' && c2 === '*') { state = 'block'; i += 2; continue }
      if (c === "'") { state = 'single'; i += 1; continue }
      if (c === '"') { state = 'double'; i += 1; continue }
      if (c === '`') { state = 'template'; i += 1; continue }
      out += c; i += 1; continue
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += c } i += 1; continue }
    if (state === 'block') { if (c === '*' && c2 === '/') { state = 'code'; i += 2; continue } i += 1; continue }
    if (state === 'single') { if (c === '\\') { i += 2; continue } if (c === "'") state = 'code'; i += 1; continue }
    if (state === 'double') { if (c === '\\') { i += 2; continue } if (c === '"') state = 'code'; i += 1; continue }
    if (state === 'template') { if (c === '\\') { i += 2; continue } if (c === '`') state = 'code'; i += 1; continue }
  }
  return out
}

const returnAt = clientSource.indexOf("name: 'dsh-mi-remote'")
const returnWindow = returnAt === -1 ? '' : clientSource.slice(Math.max(0, returnAt - 400), returnAt)
const injectMatch = /inject:\s*\[([^\]]*)\]/.exec(returnWindow)
const declaredInject = injectMatch === null
  ? []
  : injectMatch[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter((s) => s !== '')
check('客户端返回对象声明了 inject', injectMatch !== null,
  injectMatch === null ? '在 name 前 400 字符里没找到 inject: [...]' : injectMatch[0])
const usedCtx = [...new Set([...stripNonCode(clientSource).matchAll(/ctx\.([a-zA-Z_$][\w$]*)/g)].map((m) => m[1]))]
const timerUsed = usedCtx.filter((v) => TIMER_VERBS.has(v))
check('用到的 timer 动词都有 timer 声明', !(timerUsed.length > 0 && !declaredInject.includes('timer')),
  '用到 ' + (timerUsed.join(', ') || '无') + ' · inject=' + JSON.stringify(declaredInject))
const undeclaredServices = usedCtx
  .filter((v) => !CORE_VERBS.has(v) && !TIMER_VERBS.has(v))
  .filter((v) => !declaredInject.includes(v))
check('ctx.<服务> 都在 inject 里', undeclaredServices.length === 0,
  '未声明 ' + JSON.stringify(undeclaredServices) + ' · inject=' + JSON.stringify(declaredInject))

/* ── [2] 宿主半段（动态导入即证据）─────────────────────────────────────── */
console.log('')
console.log('[2] 宿主半段')
const host = await import('../lib/index.js')
check('可导入（ESM）', true)
check('导出 apply/name/ROUTE', typeof host.apply === 'function' && host.name === 'dsh-mi-remote' && host.ROUTE === '/mi-remote/api')
check('注入 webServer 服务', Array.isArray(host.inject) && host.inject.includes('webServer'))
check('导出 DSH 预设表', Array.isArray(host.DSH_PRESETS) && host.DSH_PRESETS.length >= 10)
/*
 * ⚠️ 这里原来查的是 `dsh.newSession` —— 那个预设早在重写预设表（改成真实 DSH 命令）时就去掉了，
 *    于是断言拿到 `undefined` 再读 `.combo`，自检不是"失败"而是**直接 TypeError 崩掉**。
 *    查一个不存在的 id 时**必须先判存在**，否则断言本身会把整个自检带崩。
 */
const presetOf = (id) => host.DSH_PRESETS.find((p) => p.id === id)
check('预设含核心动作',
  ['dsh.send', 'dsh.newline', 'dsh.stopReply', 'dsh.toggleRight'].every((id) => presetOf(id) !== undefined))
check('预设组合键与源码一致', presetOf('dsh.newline')?.combo === 'Shift+Enter', presetOf('dsh.newline')?.combo)
check('预设右栏组合键正确', presetOf('dsh.toggleRight')?.combo === 'Ctrl+Shift+B', presetOf('dsh.toggleRight')?.combo)

/*
 * ── [2a-2] 新增七条命令：预设表 ↔ 客户端注册 的一致性（2026-10-11 补）──────
 *
 * 面板的下拉列表读的是宿主这份 `DSH_PRESETS`，而真正响应按键的是客户端
 * `ctx.shortcuts.register` 里那个 `code`。两处写岔了，症状是"面板显示 Ctrl+Alt+4、
 * 按下去却什么都不发生"—— 静默、难查。所以这里把两边对齐关系固化成断言。
 */
const clientSrc = readFileSync(join(HERE, 'lib', 'client.js'), 'utf8')
const REMOTE_CMDS = [
  ['remote.panel.workbench', 'Ctrl+Alt+1'],
  ['remote.panel.dashboard', 'Ctrl+Alt+2'],
  ['remote.panel.projectGraph', 'Ctrl+Alt+3'],
  ['remote.panel.coords', 'Ctrl+Alt+4'],
  ['remote.panel.modeling', 'Ctrl+Alt+5'],
  ['remote.focus.composer', 'Ctrl+Alt+F'],
  ['remote.session.first', 'Ctrl+Alt+Q'],
]
let cmdOk = true
const cmdDetail = []
for (const [cmdId, combo] of REMOTE_CMDS) {
  // 预设表里要有它，且标成"装上就能用"
  const preset = host.DSH_PRESETS.find((p) => p.remoteCmd === cmdId)
  // 客户端源码里要有这条注册，且 code 与预设 combo 对得上
  const key = combo.split('+').pop()
  const code = key.length === 1 && /[0-9]/.test(key) ? 'Digit' + key : 'Key' + key
  const inClient = clientSrc.includes("'" + cmdId + "'") && clientSrc.includes("'" + code + "'")
  const comboOk = preset !== undefined && preset.combo === combo
  if (!(inClient && comboOk)) {
    cmdOk = false
    cmdDetail.push(cmdId + '(客户端=' + inClient + ' 预设=' + comboOk + ')')
  }
}
check('七条新命令：预设表与客户端注册一致', cmdOk, cmdDetail.join(' ') || REMOTE_CMDS.length + ' 条全对上')
check('七条新命令都标了 builtin（自带默认键位，不用先绑）',
  REMOTE_CMDS.every(([id]) => host.DSH_PRESETS.find((p) => p.remoteCmd === id)?.builtin === true))

/*
 * 13 个可配按键 + 3 个档位。
 * 12 → 13 是 2026-10-08 加的音量 + / 音量 −；再之后又补了语音键（voice），
 * 所以断言不要写死数字，按 BUTTONS 表自己的长度对 —— 但档位必须是 3（单击/双击/长按）。
 */
check('导出按键与档位表', host.BUTTONS.length >= 13 && host.SLOTS.length === 3,
  String(host.BUTTONS.length) + ' 键 / ' + String(host.SLOTS.length) + ' 档')

/*
 * ── [2b] 宿主半段的 inject 契约 + apply 真跑（2026-10-08 补）──────────────
 *
 * 同一把尺量宿主侧：静态读 `lib/index.js` 的 ctx.<服务> 用法，与 `host.inject` 对照。
 * 再加一遍**真跑 apply** —— 在这之前宿主 apply 从未在任何测试里被调用过，
 * 两个注册路径（HTTP 路由 / agent 工具）等于没有测试覆盖。
 * ctx 桩同样按 inject 约束拒绝未声明的服务，与真实 cordis 读取规则一致。
 */
const hostSource = readFileSync(join(HERE, 'lib', 'index.js'), 'utf8')
const hostUsed = [...new Set([...stripNonCode(hostSource).matchAll(/ctx\.([a-zA-Z_$][\w$]*)/g)].map((m) => m[1]))]
const hostDeclared = Array.isArray(host.inject) ? host.inject : []
const hostUndeclared = hostUsed
  .filter((v) => !CORE_VERBS.has(v) && !TIMER_VERBS.has(v))
  .filter((v) => !hostDeclared.includes(v))
check('宿主 ctx.<服务> 都在 inject 里', hostUndeclared.length === 0,
  '用到 ' + JSON.stringify(hostUsed) + ' · 未声明 ' + JSON.stringify(hostUndeclared) + ' · inject=' + JSON.stringify(host.inject))

const hostRegistered = []
let hostApplyThrew = null
try {
  const declaredHost = new Set(hostDeclared)
  const base = {
    get(name) {
      if (name === 'tools') return { register(definition) { hostRegistered.push({ kind: 'tool', definition }); return () => {} } }
      return undefined
    },
    effect(fn) { const off = fn(); return typeof off === 'function' ? off : () => {} },
    on() { return () => {} },
    emit() {},
  }
  if (declaredHost.has('webServer')) {
    base.webServer = { register(route) { hostRegistered.push({ kind: 'route', route }); return () => {} } }
  }
  const hostCtx = new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop !== 'then' && !(prop in target) && !CORE_VERBS.has(prop)) {
        throw new Error('cannot get property "' + prop + '" without inject')
      }
      return Reflect.get(target, prop, receiver)
    },
  })
  host.apply(hostCtx)
} catch (error) { hostApplyThrew = error }
check('宿主 apply 在 inject 约束下不抛', hostApplyThrew === null, String(hostApplyThrew && hostApplyThrew.message))
check('宿主 apply 注册了 HTTP 路由 /mi-remote/api',
  hostRegistered.some((r) => r.kind === 'route' && r.route && r.route.path === '/mi-remote/api'),
  JSON.stringify(hostRegistered.filter((r) => r.kind === 'route').map((r) => r.route && r.route.path)))
check('宿主 apply 注册了 agent 工具 mi_remote',
  hostRegistered.some((r) => r.kind === 'tool' && r.definition && r.definition.name === 'mi_remote'),
  JSON.stringify(hostRegistered.filter((r) => r.kind === 'tool').map((r) => r.definition && r.definition.name)))

/*
 * ── [2c] 宿主 HTTP 路由：直接调 handler，不依赖服务器是否重载 ──────────────
 *
 * 宿主半段的改动**不像界面那样热更新**：新增路由要重启 DSH 才对外可用
 * （2026-10-08 实测：/bridge 一直返回 unknown-route，因为服务器还跑着旧模块）。
 * 所以这里绕过网络层，把注册进来的 handler 拿来用桩 req/res 走一遍 —— 路由逻辑
 * 当场就能验，不必等重启后才发现 404。
 */
const { EventEmitter } = await import('node:events')
const API_PATH = host.ROUTE
const routeEntry = hostRegistered.find((r) => r.kind === 'route' && r.route && r.route.path === API_PATH)
check('宿主注册了 HTTP 路由 ' + API_PATH, routeEntry !== undefined,
  JSON.stringify(hostRegistered.filter((r) => r.kind === 'route').map((r) => r.route && r.route.path)))

if (routeEntry !== undefined) {
  const callRoute = async (method, subPath, body) => {
    const req = new EventEmitter()
    req.method = method
    req.url = API_PATH + subPath
    req.destroy = () => {}
    const box = { code: 0, body: '' }
    const res = {
      writeHead(code) { box.code = code },
      end(text) { box.body = String(text === undefined || text === null ? '' : text) },
    }
    const done = routeEntry.route.handler(req, res)
    setImmediate(() => {
      if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
      req.emit('end')
    })
    await done
    // handler 里有"回调里才回包"的异步（比如 where.exe 查完才 sendJson），
    // 所以等响应体出现为止（最多约 2 秒）—— 否则会读到空 body、把好路由判成坏路由。
    for (let i = 0; i < 40 && box.body === ''; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    let json = null
    try { json = JSON.parse(box.body) } catch (error) { json = null }
    return { code: box.code, json }
  }

  const statusRoute = await callRoute('GET', '/bridge')
  check('/bridge 返回引擎与运行状态', statusRoute.json !== null && statusRoute.json.ok === true,
    JSON.stringify(statusRoute.json).slice(0, 180))
  check('  /bridge 报告引擎是否存在（键是布尔）', typeof (statusRoute.json || {}).engine === 'boolean',
    String((statusRoute.json || {}).engine))

  const devicesRoute = await callRoute('POST', '/bridge/devices')
  const devices = (devicesRoute.json || {}).devices
  check('/bridge/devices 列出键盘设备', devicesRoute.json !== null && devicesRoute.json.ok === true && Array.isArray(devices),
    JSON.stringify(devicesRoute.json).slice(0, 200))
  check('  至少列出一个设备（真机上是 11 个）', Array.isArray(devices) && devices.length > 0, String(devices && devices.length))
  check('  每个设备带 xiaomi 标记', Array.isArray(devices) && devices.every((d) => typeof d.xiaomi === 'boolean'))

  const learnStart = await callRoute('POST', '/bridge/learn/start')
  check('/bridge/learn/start 能拉起学习进程', learnStart.json !== null && learnStart.json.ok === true && learnStart.json.pid !== null,
    JSON.stringify(learnStart.json))
  const learnResult = await callRoute('POST', '/bridge/learn/result')
  check('/bridge/learn/result 返回按键数组与学习状态',
    learnResult.json !== null && Array.isArray(learnResult.json.keys) && typeof learnResult.json.learning === 'boolean',
    JSON.stringify(learnResult.json).slice(0, 160))
  const stopRoute = await callRoute('POST', '/bridge/stop')
  check('/bridge/stop 能停掉引擎（不留后台进程）', stopRoute.json !== null && stopRoute.json.ok === true, JSON.stringify(stopRoute.json))
  const unknownRoute = await callRoute('GET', '/nope')
  check('未知子路由返回 404', unknownRoute.code === 404, String(unknownRoute.code))

  /*
   * vkeys 表：把学到的键码指定给某个按键名（旧 Raw Input 通路用它认出「这是 OK 键」）。
   * 这条会真的写 mapping.json，所以**先备份、测完恢复** —— 自测绝不能污染用户正在用的映射。
   *
   * ⚠️ 路径过去写的是 `%LOCALAPPDATA%\dsh-mi-remote\mapping.json`（插件迁移前的老落点）。
   *    插件改成默认 `PKG_ROOT/state` 之后，那条路径指向一个**另一份文件**：
   *    写入走的是新落点、备份读的是老落点 ⇒ **恢复等于没做**。
   *    2026-10-11 查出来就是这个后果：用户真实映射里的 `vkeys` 变成了本段测试写的
   *    `{ok:13, up:38}`，而他原本那张完整学习表（down/left/right/home/menu/tv/power）
   *    只留在旧落点那份里。**备份和恢复必须读写同一个文件**，所以这里跟插件用同一个落点。
   */
  const stateDir = process.env.DSH_MIREMOTE_STATE_DIR || join(HERE, 'state')
  const mappingFile = join(stateDir, 'mapping.json')
  const backup = existsSync(mappingFile) ? readFileSync(mappingFile, 'utf8') : null
  try {
    const vkeysRoute = await callRoute('POST', '/bridge/vkeys', { vkeys: { ok: 13, up: 38, bogus: 99, back: 999 } })
    check('/bridge/vkeys 接受按键码', vkeysRoute.json !== null && vkeysRoute.json.ok === true,
      JSON.stringify(vkeysRoute.json).slice(0, 160))
    const saved = (vkeysRoute.json && vkeysRoute.json.mapping && vkeysRoute.json.mapping.vkeys) || {}
    check('  ok=13 / up=38 写入', saved.ok === 13 && saved.up === 38, JSON.stringify(saved))
    check('  未知按键名被丢弃（bogus）', saved.bogus === undefined, JSON.stringify(saved))
    check('  越界码被丢弃（back=999）', saved.back === undefined, JSON.stringify(saved))
    const reread = host.readMapping()
    check('  已落盘：重新读回还是这张表', reread.vkeys.ok === 13 && reread.vkeys.up === 38, JSON.stringify(reread.vkeys))
  } finally {
    if (backup === null) { try { rmSync(mappingFile, { force: true }) } catch (error) { /* 本来就没有 */ } }
    else writeFileSync(mappingFile, backup, 'utf8')
  }
  check('自测后已恢复原映射（不污染用户配置）',
    backup === null ? !existsSync(mappingFile) : readFileSync(mappingFile, 'utf8') === backup)

  /*
   * 通路自测：拿真实键盘把整条链跑一遍（监听 → 单击判定 → 注入）。遥控器没配对时，
   * 这是唯一能确认「引擎真能听见、真能注入」的入口。它用临时配置，不动 mapping.json。
   */
  const selftestRoute = await callRoute('POST', '/bridge/selftest-run', { filter: 'VID_2717&PID_87C1', vkey: 120, combo: 'Enter' })
  check('/bridge/selftest-run 能拉起通路自测',
    selftestRoute.json !== null && selftestRoute.json.ok === true && selftestRoute.json.pid !== null,
    JSON.stringify(selftestRoute.json).slice(0, 200))
  check('  自测走临时配置与临时日志（文件名带 selftest）',
    String((selftestRoute.json || {}).log || '').includes('selftest'))
  const badSelftest = await callRoute('POST', '/bridge/selftest-run', { filter: '', vkey: 999 })
  check('  参数不合法时拒绝（filter 空 / vkey 越界）',
    badSelftest.json !== null && badSelftest.json.ok === false, JSON.stringify(badSelftest.json))
  const stopAfterSelftest = await callRoute('POST', '/bridge/stop')
  check('  自测进程能停干净', stopAfterSelftest.json !== null && stopAfterSelftest.json.ok === true)

  /*
   * 「打开应用」这个动作能不能真启动，取决于名字在不在 PATH / App Paths 里。
   * 用 cmd（一定找得到）和瞎编的名字（一定找不到）两头夹一下，确认它不误报。
   */
  const appHit = await callRoute('POST', '/bridge/check-app', { name: 'cmd' })
  check('/bridge/check-app 能查到存在的命令', appHit.json !== null && appHit.json.ok === true && appHit.json.found === true,
    JSON.stringify(appHit.json))
  check('  返回可执行文件的完整路径',
    typeof (appHit.json || {}).path === 'string' && String((appHit.json || {}).path).toLowerCase().includes('cmd'),
    String((appHit.json || {}).path))
  const appMiss = await callRoute('POST', '/bridge/check-app', { name: 'definitely-not-a-real-app-xyz' })
  check('  瞎编的名字报告找不到（不会误报成可用）',
    appMiss.json !== null && appMiss.json.found === false, JSON.stringify(appMiss.json))
  const appEmpty = await callRoute('POST', '/bridge/check-app', { name: '' })
  check('  空名字直接拒', appEmpty.json !== null && appEmpty.json.found === false, JSON.stringify(appEmpty.json))

  /*
   * 执行模式：引擎启动要读 mapping.json，而用户没保存过时它并不存在 —— 宿主必须先补一份默认的，
   * 否则引擎以 config-missing 退出，面板上就表现成"点了启动、状态却一直没在跑"。
   * （2026-10-08 真机端到端验出来的缺陷。）这条会真的拉起引擎：键码表为空 ⇒ 不会注入任何键。
   *
   * ⚠️ 这一段**必须跑在临时 state 目录里**，别去动用户真实的 mapping.json。
   *    原来它指向 `%LOCALAPPDATA%\dsh-mi-remote\mapping.json`（插件迁移前的老落点），
   *    插件改成默认 `PKG_ROOT/state` 之后这条就永远失败了 —— 而且它做的是
   *    "先 rmSync 再检查有没有补回来"，一旦把路径"修对"成真实目录、
   *    测试中途又崩了，用户的映射就真没了。所以正确做法是**换到临时目录**，不是改路径。
   *    `DSH_MIREMOTE_STATE_DIR` 是懒读的（上面第 [4] 段就是靠这一点切目录），改完即时生效。
   */
  const runStateDir = mkdtempSync(join(tmpdir(), 'mi-run-'))
  const prevStateDir = process.env.DSH_MIREMOTE_STATE_DIR
  process.env.DSH_MIREMOTE_STATE_DIR = runStateDir
  const runMappingFile = join(runStateDir, 'mapping.json')
  try {
    const started = await callRoute('POST', '/bridge/run', { filter: 'VID_2717&PID_87C1&MI_01&Col03' })
    check('/bridge/run 在没有 mapping.json 时也能起来（自动补默认方案）',
      started.json !== null && started.json.ok === true && started.json.pid !== null, JSON.stringify(started.json))
    check('  确实补出了 mapping.json', existsSync(runMappingFile))
    await new Promise((resolve) => setTimeout(resolve, 900))
    const statusRun = await callRoute('GET', '/bridge')
    check('  引擎真的在跑（不是起了就退）', (statusRun.json || {}).run !== null, JSON.stringify((statusRun.json || {}).run))
    const stoppedRun = await callRoute('POST', '/bridge/stop')
    check('  能停干净', stoppedRun.json !== null && stoppedRun.json.ok === true)
    await new Promise((resolve) => setTimeout(resolve, 700))
    const afterRun = await callRoute('GET', '/bridge')
    check('  停完 run=null', (afterRun.json || {}).run === null, JSON.stringify((afterRun.json || {}).run))
  } finally {
    if (prevStateDir === undefined) delete process.env.DSH_MIREMOTE_STATE_DIR
    else process.env.DSH_MIREMOTE_STATE_DIR = prevStateDir
    try { rmSync(runStateDir, { recursive: true, force: true }) } catch (error) { /* 临时目录，删不掉也不影响 */ }
  }
  check('  这段跑在临时目录里（没碰用户真实映射）',
    runMappingFile.startsWith(runStateDir) && !existsSync(runMappingFile))

  /*
   * 总闸「启用自定义按键功能」（参考图顶部那个开关）：关掉 = 按键桥不许启动、正在跑的立刻停。
   * 它会写 bridge.json，所以先备份、测完恢复 —— 自测不动用户改过的设置。
   * 路径同样必须跟插件一个落点（理由见上面 vkeys 那段）。
   */
  const bridgeFile = join(stateDir, 'bridge.json')
  const bridgeBackup = existsSync(bridgeFile) ? readFileSync(bridgeFile, 'utf8') : null
  try {
    const off = await callRoute('POST', '/bridge/enabled', { enabled: false })
    check('总闸能关掉', off.json !== null && off.json.ok === true && off.json.enabled === false, JSON.stringify(off.json))
    const afterOff = await callRoute('GET', '/bridge')
    check('  关掉后 /bridge 报告 enabled=false', (afterOff.json || {}).enabled === false, JSON.stringify(afterOff.json).slice(0, 140))
    check('  关掉时把学习/执行进程一并收干净',
      (afterOff.json || {}).learn === null && (afterOff.json || {}).run === null,
      JSON.stringify({ learn: (afterOff.json || {}).learn, run: (afterOff.json || {}).run }))
    const on = await callRoute('POST', '/bridge/enabled', { enabled: true })
    check('  能再打开', on.json !== null && on.json.ok === true && on.json.enabled === true, JSON.stringify(on.json))
  } finally {
    if (bridgeBackup === null) { try { rmSync(bridgeFile, { force: true }) } catch (error) { /* 本来就没有 */ } }
    else writeFileSync(bridgeFile, bridgeBackup, 'utf8')
  }
  check('  测完已恢复 bridge.json',
    bridgeBackup === null ? !existsSync(bridgeFile) : readFileSync(bridgeFile, 'utf8') === bridgeBackup)
}

/*
 * ── [2d] 注入组合键：每个动作能不能被翻译成键码 ──────────────────────────
 *
 * 映射能不能生效，先看组合键能不能被引擎认出来。这里用 --dry-run（只解析、不注入，
 * 零副作用）把宿主那 11 个动作全过一遍，再确认写错的会被明确拒绝 ——
 * 「Ctrl+」这种没写完的以前会被静默降级成单键 Ctrl，那种误触发比报错难查得多。
 * 引擎没编译就跳过这一段，不假装验过。
 */
const enginePath = join(HERE, 'engine', 'KeyBridge.exe')
if (!existsSync(enginePath)) {
  check('引擎已编译（engine/KeyBridge.exe）', false, '先跑 engine/build.ps1')
} else {
  const dryRun = (combo) => {
    try {
      const out = execFileSync(enginePath, ['tap', '--dry-run', combo],
        { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      return JSON.parse(out.trim())
    } catch (error) {
      try { return JSON.parse(String(error.stdout || '{}').trim() || '{}') } catch { return { ok: false, error: 'exec-failed' } }
    }
  }
  /*
   * 只查**按键类**预设能不能翻译成键码。
   *
   * `MoveUp` / `MoveDown` / `MoveLeft` / `MoveRight` 是**动作**不是组合键 ——
   * 引擎在 RunBridge 里用 IsMoveAction 分流到 Injector.Move，压根不过键码表。
   * 拿它们去 dryRun 必然 unknown-key，原来那条断言因此常红（不是实现坏了，是尺子量错了对象）。
   */
  const isMoveAction = (combo) => /^Move(Up|Down|Left|Right)$/.test(String(combo))
  const keyPresets = host.DSH_PRESETS.filter((preset) => !isMoveAction(preset.combo))
  const failedPresets = keyPresets.filter((preset) => dryRun(preset.combo).ok !== true)
  check('按键类预设的组合键全能翻译成键码（' + keyPresets.length + ' 条，Move 动作另算）', failedPresets.length === 0,
    JSON.stringify(failedPresets.map((p) => p.combo + ' → ' + dryRun(p.combo).error)))
  check('  Enter 译成 VK 13', dryRun('Enter').vkeys === '13', String(dryRun('Enter').vkeys))
  check('  Ctrl+Alt+N 译成 17,18,78', dryRun('Ctrl+Alt+N').vkeys === '17,18,78', String(dryRun('Ctrl+Alt+N').vkeys))
  check('  ArrowUp 译成 38', dryRun('ArrowUp').vkeys === '38', String(dryRun('ArrowUp').vkeys))
  check('  媒体键 MediaPlayPause 译成 179', dryRun('MediaPlayPause').vkeys === '179', String(dryRun('MediaPlayPause').vkeys))
  for (const bad of ['Ctrl+', 'NotAKey', 'F99', 'Ctrl++N']) {
    check('  写错的被拒：' + JSON.stringify(bad), dryRun(bad).ok !== true, JSON.stringify(dryRun(bad)))
  }
  if (process.env.DSH_MIREMOTE_SKIP_TAP === '1') {
    // 你在打游戏/开会/演示时，别往系统里注入按键 —— 设这个环境变量就跳过真注入那一步。
    console.log('  [跳过] 真注入 F24（DSH_MIREMOTE_SKIP_TAP=1）')
  } else {
    const tapped = (() => {
      try { return JSON.parse(execFileSync(enginePath, ['tap', 'F24'], { encoding: 'utf8', windowsHide: true }).trim()) }
      catch (error) { return { ok: false, error: String(error && error.message) } }
    })()
    check('  真注入一次 F24（F24 普通键盘没有，不打扰使用）', tapped.ok === true, JSON.stringify(tapped))
  }

  /*
   * 判定逻辑（单击 / 双击 / 长按）是引擎最核心的一段，平时要靠真实按键时序才跑得到。
   * 引擎自带 testclassifier：用模拟时序跑四个场景，全程不碰系统（不注册 Raw Input、不注入）。
   */
  const classifierRun = (() => {
    try {
      return JSON.parse(execFileSync(enginePath, ['testclassifier'], { encoding: 'utf8', windowsHide: true }).trim())
    } catch (error) {
      try { return JSON.parse(String(error.stdout || '{}').trim() || '{}') } catch { return { ok: false } }
    }
  })()
  check('单击/双击/长按判定正确（模拟时序跑，不碰系统）', classifierRun.ok === true, JSON.stringify(classifierRun))
  check('  四个场景都对：单击 / 双击 / 长按 / 连发只算一次',
    JSON.stringify(classifierRun.events) === JSON.stringify(['1:click', '2:double', '3:hold', '4:click']),
    JSON.stringify(classifierRun.events))

  /*
   * 一键体检（doctor）：设备数 / 监听注册 / 判定逻辑一条命令全报出来，出问题先跑它。
   * 默认**不注入** —— 正在用电脑的人不该因为一次自测收到莫名其妙的按键。
   */
  const doctorRun = (() => {
    try {
      return JSON.parse(execFileSync(enginePath, ['doctor'], { encoding: 'utf8', windowsHide: true }).trim())
    } catch (error) {
      try { return JSON.parse(String(error.stdout || '{}').trim() || '{}') } catch { return {} }
    }
  })()
  check('doctor：监听能注册（建窗口 + RegisterRawInputDevices）', doctorRun.listen === 'ok', JSON.stringify(doctorRun.listen))
  check('doctor：判定逻辑三项都对', doctorRun.classifierOk === true, String(doctorRun.classifier))
  check('doctor：报出键盘类设备数，并区分真实/虚拟',
    typeof doctorRun.keyboards === 'number' && doctorRun.keyboards > 0 && typeof doctorRun.realKeyboards === 'number',
    JSON.stringify({ keyboards: doctorRun.keyboards, real: doctorRun.realKeyboards }))
  check('doctor：默认不注入（不打扰正在用电脑的人）', doctorRun.injectTested === false, String(doctorRun.injectTested))

  /*
   * 鼠标注入（2026-10-08 加）：面板的录制区能认鼠标左/中/右键，引擎这边要真的发得出去。
   * 引擎**不真发点击**（会点到用户屏幕上正指着的东西），只验造出来的 INPUT 结构对不对 ——
   * "按下与抬起的 flag 弄反或复用同一个"那种错，在系统里的表现是**只按不松**，极难查。
   */
  const mouseRun = (() => {
    try {
      return JSON.parse(execFileSync(enginePath, ['testmouse'], { encoding: 'utf8', windowsHide: true }).trim())
    } catch (error) {
      try { return JSON.parse(String(error.stdout || '{}').trim() || '{}') } catch { return {} }
    }
  })()
  check('鼠标左/中/右键都造得出正确的注入结构', mouseRun.ok === true, JSON.stringify(mouseRun.cases))
  check('  按下与抬起是两套不同的 flag（复用同一个会"只按不松"）',
    Array.isArray(mouseRun.cases) && mouseRun.cases.length === 3
    && mouseRun.cases.every((c) => c.ok === true && c.down !== c.up),
    JSON.stringify((mouseRun.cases || []).map((c) => c.key + ':' + c.down + '/' + c.up)))
  check('  键盘那条路没被改坏', mouseRun.keyboardIntact === true, String(mouseRun.keyboardIntact))
  const mouseParse = ['MouseLeft', 'MouseRight', 'MouseMiddle', 'Ctrl+MouseLeft'].map((combo) => {
    try {
      return JSON.parse(execFileSync(enginePath, ['tap', combo, '--dry-run'], { encoding: 'utf8', windowsHide: true }).trim())
    } catch (error) { return { ok: false } }
  })
  check('四个鼠标组合键都认得出来（含带修饰键的）', mouseParse.every((r) => r.ok === true),
    mouseParse.map((r) => String(r.vkeys)).join(' / '))
}

/* ── [3] 默认映射方案 ──────────────────────────────────────────────────── */
console.log('')
console.log('[3] 默认映射方案')
const def = host.defaultMapping()
check('version=1', def.version === 1)
check('十二个按键齐全', host.BUTTONS.every((b) => def.buttons[b.id] !== undefined))
check('OK 单击=Enter', def.buttons.ok.click?.combo === 'Enter')
check('返回 单击=停止回复（Esc 连按两下）', def.buttons.back.click?.combo === 'Esc+Esc', def.buttons.back.click?.combo)
check('返回 双击=开关右栏', def.buttons.back.double?.combo === 'Ctrl+Shift+B')
check('返回 长按=开关左栏', def.buttons.back.hold?.combo === 'Ctrl+Alt+B')
check('主页 单击=在本地打开工作区', def.buttons.home.click?.combo === 'Ctrl+Alt+O', def.buttons.home.click?.combo)
check('主页 双击=打开应用', def.buttons.home.double?.type === 'app' && def.buttons.home.double.combo === 'Codex')
check('菜单 双击=打开 cmux', def.buttons.menu.double?.combo === 'cmux')
check('方向键四向', ['up', 'down', 'left', 'right'].every((b) => def.buttons[b].click?.combo === 'Arrow' + b[0].toUpperCase() + b.slice(1)))

/* ── [4] 映射读写往返（临时目录隔离，不碰真实状态）───────────────────── */
console.log('')
console.log('[4] 映射读写往返')
const tmp = mkdtempSync(join(tmpdir(), 'dsmr-test-'))
process.env.DSH_MIREMOTE_STATE_DIR = tmp
const host2 = await import('../lib/index.js?test=2') // 环境变了重导（模块级无状态，安全）
const custom = host.defaultMapping()
custom.buttons.ok.double = { type: 'key', id: 'key:Ctrl+Shift+Enter', label: 'Ctrl+Shift+Enter', combo: 'Ctrl+Shift+Enter' }
custom.buttons.tv.hold = { type: 'app', id: 'app:Obs', label: '打开 Obs', combo: 'Obs' }
const writeResult = host2.writeMapping(custom)
check('写入自定义方案 ok', writeResult.ok === true, JSON.stringify(writeResult).slice(0, 120))
const readBack = host2.readMapping()
check('读回：自定义组合键在', readBack.buttons.ok.double?.combo === 'Ctrl+Shift+Enter')
check('读回：自定义应用在', readBack.buttons.tv.hold?.combo === 'Obs')
check('读回：默认项仍在', readBack.buttons.ok.click?.combo === 'Enter')
check('写入时记了时间戳', typeof readBack.updatedAt === 'string' && readBack.updatedAt !== null)

const bad1 = host2.writeMapping({ version: 2, buttons: {} })
check('version≠1 被拒', bad1.ok === false && bad1.error === 'bad-mapping-shape')
const bad2 = host2.writeMapping({ version: 1, buttons: { ok: { click: { type: 'magic' }, double: null, hold: null } } })
check('未知动作类型被拒', bad2.ok === false && bad2.error === 'unknown-action-type', JSON.stringify(bad2))
const bad3 = host2.writeMapping({ version: 1, buttons: { ok: { click: { type: 'dsh', id: 'dsh.nope' }, double: null, hold: null } } })
check('未知预设被拒', bad3.ok === false && bad3.error === 'unknown-preset')
const resetResult = host2.resetMapping()
check('重置回默认 ok', resetResult.ok === true && host2.readMapping().buttons.ok.click?.combo === 'Enter')
rmSync(tmp, { recursive: true, force: true })
delete process.env.DSH_MIREMOTE_STATE_DIR

/* ── [5] 探针连通（可选）──────────────────────────────────────────────── */
console.log('')
console.log('[5] 探针' + (WITH_PROBE ? '' : '（跳过：加 --probe 才连真设备）'))
if (WITH_PROBE) {
  const ps = process.env.DSH_MIREMOTE_PS || join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const run = (script, args) => new Promise((resolvePromise) => {
    execFile(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'audio', script), ...args],
      { windowsHide: true, timeout: 30000, encoding: 'buffer' },
      (error, stdout) => {
        const text = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout || '')
        const line = text.split(/\r?\n/).filter((row) => row.startsWith('RESULT_JSON=')).pop()
        if (line === undefined) { resolvePromise({ ok: false, error: 'no-result', stderr: String(error && error.message) }); return }
        try { resolvePromise(JSON.parse(line.slice('RESULT_JSON='.length))) } catch { resolvePromise({ ok: false, error: 'bad-json' }) }
      })
  })

  const probe = await run('probe.ps1', [])
  check('probe ok:true', probe.ok === true, JSON.stringify(probe).slice(0, 160))
  check('报出遥控器配对态', typeof probe.remotePaired === 'boolean', String(probe.remotePaired))
  check('配对检测不吃 USB 键鼠误报', probe.remotePaired === false
    || (Array.isArray(probe.remotes) && probe.remotes.every((r) => r.transport === 'bluetooth' || r.transport === 'name')),
    JSON.stringify((probe.remotes || []).map((r) => r.name)))
  check('报出 SayAll 状态', typeof probe.sayallRunning === 'boolean')
  check('报出输入法状态', typeof probe.wetypeRunning === 'boolean')
  const cjk = (probe.remotes || []).map((r) => r.name).filter((n) => /[\u4e00-\u9fff]/.test(String(n)))
  check('中文设备名没烂', cjk.every((n) => !/\ufffd/.test(n)), cjk.join(' | '))

  const voice = await run('audio-device.ps1', ['status'])
  check('audio-device ok:true', voice.ok === true, JSON.stringify(voice).slice(0, 120))
  check('音频枚举有中文设备', (voice.devices || []).some((d) => /[\u4e00-\u9fff]/.test(String(d.name))))
  check('音频枚举没有替换字符', JSON.stringify(voice.devices || []).includes('\ufffd') === false)

  // 链路体检的合并视图（link 状态机）
  const link = await host.linkStatus(true)
  check('link 视图 ok:true', link.ok === true, JSON.stringify(link).slice(0, 160))
  check('四段链路齐', ['remote', 'sayall', 'cable', 'wetype'].every((k) => link.link[k] && typeof link.link[k].ok === 'boolean'))
  check('缺的段带补法说明', ['remote', 'sayall', 'cable', 'wetype'].every((k) => typeof link.link[k].howto === 'string' && link.link[k].howto.length > 10))
}

console.log('')
console.log('结果：PASS ' + pass + ' / FAIL ' + fail)
process.exit(fail === 0 ? 0 : 1)
