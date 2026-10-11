#!/usr/bin/env node
/**
 * verify-live.mjs — 对正在跑的 DSH web 做端到端验证
 *
 * 查什么：
 *   ① 页面启动图（__DSH_BOOT__）里有 dsh-mi-remote 一条；
 *   ② combo bundle 能真的取回，且里面有本插件的关键标记；
 *   ③ 宿主路由 /mi-remote/api/link 与 /mapping 活着、中文完好；
 *   ④ 旧插件 dsh-remote-mic 已从启动图消失（换装干净）。
 *
 * 鉴权：host 的 cookie 契约是公开的（packages/client/connection/src/browser-auth.ts），
 * 密钥在 $DSH_HOME/.credentials.yaml ⇒ 内存里签一个短时效只读 cookie。
 * ⚠️ 值不打印、不落盘。
 *
 * 跑法：node verify-live.mjs [baseUrl]
 */

import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE = process.argv[2] || 'http://127.0.0.1:3080'
const AUTHORITY = new URL(BASE).host
const PKG = 'dsh-mi-remote'
const OLD_PKG = 'dsh-remote-mic'

let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log('  PASS  ' + name) }
  else { fail += 1; console.log('  FAIL  ' + name + (detail === undefined ? '' : '  →  ' + detail)) }
}

const b64u = (buf) => Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')

function readSecret() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const text = readFileSync(join(home, '.credentials.yaml'), 'utf8')
  const at = text.indexOf('client-connection/browser-session:')
  if (at === -1) throw new Error('凭据里没有 browser-session 记录')
  const match = /secret:\s*(\S+)/.exec(text.slice(at))
  if (match === null) throw new Error('没读到 secret')
  return Buffer.from(match[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64')
}

const secret = readSecret()
const name = 'dsh-auth-' + b64u(createHash('sha256').update(AUTHORITY).digest())
const now = Date.now()
const body = b64u(Buffer.from(JSON.stringify({ version: 1, authority: AUTHORITY, issuedAt: now, expiresAt: now + 3600_000 }), 'utf8'))
const value = 'v1.' + body + '.' + b64u(createHmac('sha256', secret).update(body).digest())
const withCookie = (init) => ({ ...init, headers: { ...(init && init.headers), cookie: name + '=' + value } })

console.log('verify-live  base=' + BASE + '  cookie=' + name + '（值不打印）')
console.log('')

/* ── ① 启动图 ─────────────────────────────────────────────────────────── */
console.log('[1] 页面启动图')
let html = ''
try {
  const res = await fetch(BASE + '/', withCookie({ signal: AbortSignal.timeout(30000) }))
  html = await res.text()
  check('GET / 拿到页面', res.status === 200, 'HTTP ' + res.status)
} catch (error) {
  check('GET / 拿到页面', false, String(error && error.message))
}
check('页面带 __DSH_BOOT__', html.includes('__DSH_BOOT__'))
check('启动图提到 ' + PKG, html.includes(PKG))
check('旧插件 ' + OLD_PKG + ' 已不在启动图', !html.includes(OLD_PKG), '还残留')

let comboUrls = []
let bootEntry = null
const bootAt = html.indexOf('__DSH_BOOT__')
if (bootAt !== -1) {
  const assignAt = html.indexOf('=', bootAt)
  const jsonStart = html.indexOf('{', assignAt)
  let depth = 0, inString = false, escaped = false, end = -1
  for (let i = jsonStart; i < html.length; i += 1) {
    const ch = html[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') depth += 1
    else if (ch === '}') { depth -= 1; if (depth === 0) { end = i + 1; break } }
  }
  if (end !== -1) {
    try {
      const boot = JSON.parse(html.slice(jsonStart, end))
      const graph = boot.graph || boot
      const entries = Array.isArray(graph.entries) ? graph.entries : []
      bootEntry = entries.find((e) => e && e.id === PKG) || null
      check('启动图里有 ' + PKG + ' 一条', bootEntry !== null)
      if (bootEntry !== null) {
        console.log('    条目：' + JSON.stringify(bootEntry).slice(0, 200))
        check('条目带自己的地址与 rev', typeof bootEntry.url === 'string' && typeof bootEntry.rev === 'string')
      }
      comboUrls = (Array.isArray(graph.batches) ? graph.batches : [])
        .map((b) => (typeof b === 'string' ? b : b && b.url)).filter((u) => typeof u === 'string' && u.length > 0)
    } catch (error) {
      check('启动图是结构化 JSON', false, String(error && error.message))
    }
  }
}

/* ── ② combo bundle ───────────────────────────────────────────────────── */
console.log('')
console.log('[2] 插件 bundle（浏览器加载的就是 combo 这一份）')
let loaded = ''
for (const raw of comboUrls) {
  const url = raw.startsWith('http') ? raw : BASE + '/' + raw.replace(/^\.?\//, '')
  try {
    const res = await fetch(url, withCookie({ signal: AbortSignal.timeout(40000) }))
    const text = await res.text()
    if (text.includes(PKG)) { loaded = text; break }
  } catch (error) { /* 下一批 */ }
}
check('combo 里取到含本插件的那一批', loaded !== '')
if (loaded !== '') {
  const markers = [
    ['注册 id 是 ' + PKG, loaded.includes("id: '" + PKG + "'") || loaded.includes('id: "' + PKG + '"')],
    ['带宿主路由前缀 /mi-remote/api', loaded.includes('/mi-remote/api')],
    ['带左栏席位 sidebar.footer.action', loaded.includes('sidebar.footer.action')],
    ['带右栏 Tab 席位 id', loaded.includes('dsh-mi-remote:panel')],
    ['带指南卡 order 31.5（驾驶舱 31 之后、坐标系 32 之前）', loaded.includes('order: 31.5')],
    ['带指南卡图标（缺了官方画方块占位符）', loaded.includes('data-dsmr-guide')],
    ['带左栏行标记 data-dsmr-footer', loaded.includes('data-dsmr-footer')],
    // 2026-10-08：映射编辑器改成图形化（遥控器实物图 + 按键卡片），守住它别再退回表格。
    ['带图形化映射标记（遥控器图形 / 按键卡片）',
      loaded.includes('data-dsmr-figure') && loaded.includes('data-dsmr-card') && loaded.includes('data-dsmr-key')],
    ['旧麦克风标记不在 bundle', !loaded.includes('data-dshr-footer')],
  ]
  for (const [label, ok] of markers) check('bundle 里 ' + label, ok)

  /*
   * 单独守一条**运行时才会炸**的契约：浏览器半段返回的插件对象里，inject 必须声明 `timer`。
   * `ctx.interval()` 是 TimerService 用 `ctx.mixin` 混进 Context 的动词，cordis 只允许读
   * inject 里列过的服务 —— 少了 `timer`，apply() 当场抛
   * `cannot get property "interval" without inject`，条目进 failed，启动页显示
   * 「Failed to load plugins / dsh-mi-remote」。2026-10-08 这个坑连踩两次
   * （dsh-remote-mic 一次，本插件从它派生时又带过来一次），而离线自测当时全绿
   * （桩无条件提供 interval），所以这条只认真机发出去的那份字节。
   * 判据定位到本插件自己的返回对象（`name: 'dsh-mi-remote'` 前那段），
   * 不看整批 combo —— 同批的兄弟插件也声明 timer，含不含都说明不了本插件。
   */
  const nameAt = loaded.indexOf("name: '" + PKG + "'")
  const ownReturn = nameAt === -1 ? '' : loaded.slice(Math.max(0, nameAt - 400), nameAt)
  check('bundle 里本插件 inject 声明带 timer（缺了 apply 会抛 without inject）',
    /inject:\s*\[[^\]]*'timer'[^\]]*\]/.test(ownReturn),
    nameAt === -1 ? '没定位到本插件的返回对象' : ownReturn.slice(-160).replace(/\s+/g, ' '))
  // 补强（2026-10-08）：同一个洞的另一半 —— `slots` 也是 mixin 服务，漏了照样当场抛。
  check('bundle 里本插件 inject 声明带 slots（同一个洞的另一半）',
    /inject:\s*\[[^\]]*'slots'[^\]]*\]/.test(ownReturn),
    nameAt === -1 ? '没定位到本插件的返回对象' : ownReturn.slice(-160).replace(/\s+/g, ' '))
  // 用户 2026-10-08 裁定：入口名称用「遥控器」，不再叫「小米遥控器」。
  check('bundle 里入口名称已是「遥控器」',
    /PANEL_TITLE\s*=\s*'遥控器'/.test(loaded),
    (loaded.match(/PANEL_TITLE\s*=\s*'[^']*'/) || ['(没找到 PANEL_TITLE)'])[0])
}

/* ── ③ 宿主路由 ───────────────────────────────────────────────────────── */
console.log('')
console.log('[3] 宿主路由')
for (const [path, probe] of [
  ['/link', (j) => j.link && ['remote', 'sayall', 'cable', 'wetype'].every((k) => j.link[k])],
  ['/mapping', (j) => j.mapping && j.mapping.buttons && j.mapping.buttons.ok],
  ['/voice/status', (j) => Array.isArray(j.devices)],
  // 宿主半段的改动不像界面那样热更新：这条同时充当「服务器有没有加载到新宿主模块」的探针。
  // 返回 unknown-route 就说明还跑着旧模块，得重启 DSH 才生效。
  ['/bridge', (j) => typeof j.engine === 'boolean'],
]) {
  try {
    const res = await fetch(BASE + '/mi-remote/api' + path + '?force=1', { signal: AbortSignal.timeout(30000) })
    const text = await res.text()
    const json = JSON.parse(text)
    check(path + ' HTTP 200 且结构对', res.status === 200 && json.ok === true && probe(json) !== false,
      'HTTP ' + res.status + ' ' + text.slice(0, 100))
    check(path + ' 中文没烂', !text.includes('\uFFFD'))
  } catch (error) {
    check(path + ' 可取', false, String(error && error.message))
  }
}
try {
  const res = await fetch(BASE + '/mi-remote/api/link?force=1', { signal: AbortSignal.timeout(30000) })
  const json = await res.json()
  const states = ['remote', 'sayall', 'cable', 'wetype'].map((k) => k + '=' + (json.link[k].ok ? '就绪' : '缺')).join(' · ')
  console.log('    链路：' + states)
} catch (error) { console.log('    链路读取失败：' + String(error && error.message)) }
try {
  const res = await fetch(BASE + '/remote-mic/api/status', { signal: AbortSignal.timeout(10000) })
  check('旧路由 /remote-mic/api 已下线（404）', res.status === 404, 'HTTP ' + res.status)
} catch (error) {
  check('旧路由 /remote-mic/api 已下线', false, String(error && error.message))
}

console.log('')
console.log('结果：PASS ' + pass + ' / FAIL ' + fail)
process.exit(fail === 0 ? 0 : 1)
