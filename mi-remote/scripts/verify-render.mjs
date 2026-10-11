#!/usr/bin/env node
/**
 * verify-render.mjs — 浏览器半段的真渲染冒烟（不需要浏览器）
 *
 * 桩的纪律（沿用 dsh-remote-mic 时踩过的坑，见各注释）：
 *   useState 的 setter 要推送更新；useEffect 要真执行；useCallback 要按 deps 记忆化
 *   且连函数本身一起存；setState 批量在微任务边界合并 —— 否则全是假绿。
 *
 * 跑法：node verify-render.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_PATH = join(HERE, 'lib', 'client.js')

let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log('  PASS  ' + name) }
  else { fail += 1; console.log('  FAIL  ' + name + (detail === undefined ? '' : '  →  ' + detail)) }
}

/* ── React 桩（与 dsh-remote-mic 同一套，被实测校准过）────────────────── */

function makeReact() {
  const hooks = []
  let cursor = 0
  let pending = []
  let scheduled = null
  const stats = { renders: 0, effectCalls: 0, flushed: 0, sets: 0 }
  const rerenderRef = { current: null }

  const schedule = (apply) => {
    if (scheduled === null) {
      scheduled = []
      queueMicrotask(() => {
        const batch = scheduled
        scheduled = null
        for (const one of batch) one()
        if (rerenderRef.current !== null) rerenderRef.current()
      })
    }
    scheduled.push(apply)
  }

  // class 组件的基类：React 的错误边界必须是 class，所以桩也得给一个 Component。
  class StubComponent {
    constructor(props) {
      this.props = props === undefined || props === null ? {} : props
      this.state = {}
    }
    setState(next) {
      const patch = typeof next === 'function' ? next(this.state) : next
      if (patch !== null && patch !== undefined && typeof patch === 'object') this.state = { ...this.state, ...patch }
    }
  }

  const React = {
    Component: StubComponent,
    createElement(type, props, ...children) {
      const merged = props ? { ...props } : {}
      /*
       * ⭐ 真实 React 把 `key`（和 `ref`）当**保留字段，不会传进组件** —— 桩必须照做。
       * 桩以前原样传下去，于是「拿 key 当数据 prop」这种写法在桩里全绿、在真机上直接抛
       * `Cannot read properties of undefined`，被 slot 的错误边界一捕获就把整个面板退位成白屏
       * （2026-10-08 的真凶）。现在照真实规则剥离，同类错误在离线自测就会当场炸出来。
       */
      delete merged.key
      delete merged.ref
      if (children.length > 0) merged.children = children.length === 1 ? children[0] : children
      // 函数组件就地展开（第一版桩不展开 ⇒ 面板的子组件 hooks 全没跑，全是假绿）。
      // 全部子组件的 hooks 都在渲染开头无条件调用，全局数组按序分配是安全的。
      if (typeof type === 'function') {
        // class 组件（React 的错误边界必须是 class）：new 出来跑 render。
        // 桩只走正常路径 —— getDerivedStateFromError / componentDidCatch 不模拟。
        if (type.prototype !== undefined && typeof type.prototype.render === 'function') {
          const instance = new type(merged)
          instance.props = merged
          if (instance.state === undefined || instance.state === null) instance.state = {}
          return instance.render()
        }
        return type(merged)
      }
      return {
        __el: true, type, props: merged,
        children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
      }
    },
    useEffect(fn, deps) {
      stats.effectCalls += 1
      const index = cursor
      cursor += 1
      const previous = hooks[index]
      const changed = previous === undefined || deps === undefined || previous.deps === undefined
        || deps.length !== previous.deps.length || deps.some((d, i) => !Object.is(d, previous.deps[i]))
      if (!changed) return
      if (previous !== undefined && typeof previous.cleanup === 'function') pending.push(previous.cleanup)
      pending.push(() => {
        stats.flushed += 1
        const cleanup = fn()
        const cell = hooks[index] === undefined ? {} : hooks[index]
        cell.deps = deps
        cell.cleanup = typeof cleanup === 'function' ? cleanup : undefined
        hooks[index] = cell
      })
    },
    useLayoutEffect() {},
    useRef(initial) {
      const index = cursor
      cursor += 1
      if (hooks[index] === undefined) hooks[index] = { current: initial }
      return hooks[index]
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      if (hooks[index] === undefined) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      const cell = hooks[index]
      const set = (next) => {
        schedule(() => {
          const value = typeof next === 'function' ? next(cell.value) : next
          if (Object.is(value, cell.value)) return
          cell.value = value
          stats.sets += 1
        })
      }
      return [cell.value, set]
    },
    useCallback(fn, deps) {
      const index = cursor
      cursor += 1
      const previous = hooks[index]
      // ⚠️ 这里曾经把判据写反（写成 `!Object.is(...)` 却赋给变量 same），于是 deps 变了反而
      // 返回旧闭包 —— 桩于是会"记忆化"住过期的 state，测出来的行为跟真 React 不一致。
      const unchanged = previous !== undefined && deps !== undefined && previous.deps !== undefined
        && deps.length === previous.deps.length && deps.every((d, i) => Object.is(d, previous.deps[i]))
      if (unchanged) return previous.fn
      hooks[index] = { fn, deps }
      return fn
    },
    useMemo(fn, deps) {
      const index = cursor
      cursor += 1
      const previous = hooks[index]
      const same = previous !== undefined && deps !== undefined && previous.deps !== undefined
        && deps.length === previous.deps.length && deps.every((d, i) => !Object.is(d, previous.deps[i]))
      if (same) return previous.value
      const value = fn()
      hooks[index] = { value, deps }
      return value
    },
  }
  return { React, stats, rerenderRef, resetCursor: () => { cursor = 0 }, takeEffects: () => { const q = pending; pending = []; return q } }
}

function makeRenderer(stub, Component, props) {
  const frames = []
  const render = () => {
    if (frames.length >= 60) return frames[frames.length - 1]
    stub.stats.renders += 1
    stub.resetCursor()
    stub.rerenderRef.current = render
    const tree = Component(props)
    frames.push(tree)
    for (const effect of stub.takeEffects()) effect()
    return tree
  }
  render()
  return { frames, render, get tree() { return frames[frames.length - 1] } }
}

const settle = async (rounds = 24) => { for (let i = 0; i < rounds; i += 1) await Promise.resolve() }

function findAll(node, predicate, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { for (const item of node) findAll(item, predicate, out); return out }
  if (typeof node !== 'object' || node.__el !== true) return out
  if (predicate(node)) out.push(node)
  for (const child of node.children || []) findAll(child, predicate, out)
  return out
}
function textOf(node, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { for (const item of node) textOf(item, out); return out }
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (typeof node !== 'object') return out
  for (const child of node.children || []) textOf(child, out)
  return out
}

/* ── 三个 API 的假数据 ─────────────────────────────────────────────────── */

const apiCalls = []
const intervals = []
// 客户端用 ctx.shortcuts.register 注册的命令都会记到这里（见 makeCtx 的 shortcuts 桩）
const registeredShortcuts = []

const STUB_LINK = {
  ok: true,
  link: {
    remote: { ok: false, state: 'missing', devices: [], howto: '配对方法：长按菜单+主页。' },
    sayall: { ok: false, state: 'missing', howto: '装无线麦 SayAll Windows 版。' },
    cable: { ok: false, state: 'missing', devices: [], howto: '装 VB-CABLE 并重启。' },
    wetype: { ok: true, state: 'ready', howto: '语音设置选 CABLE Output。' },
  },
  voiceEndpoints: { uuActive: true },
}

const STUB_VOICE = {
  ok: true,
  current: { id: 'dev-speaker', name: '麦克风 (Wireless Stereo Headset)', state: 'active', active: true, isDefault: true, isRemoteMic: false, source: 'other', sourceLabel: '其他输入' },
  devices: [
    { id: 'dev-uu', name: '麦克风阵列 (UU远程虚拟音频设备)', state: 'active', active: true, isDefault: false, isRemoteMic: true, source: 'uuremote', sourceLabel: 'UU远程' },
    { id: 'dev-speaker', name: '麦克风 (Wireless Stereo Headset)', state: 'active', active: true, isDefault: true, isRemoteMic: false, source: 'other', sourceLabel: '其他输入' },
  ],
  remoteDevices: [{ id: 'dev-uu', name: '麦克风阵列 (UU远程虚拟音频设备)', state: 'active', active: true, isDefault: false, isRemoteMic: true, source: 'uuremote', sourceLabel: 'UU远程' }],
  suggest: { id: 'dev-uu', name: '麦克风阵列 (UU远程虚拟音频设备)', state: 'active', active: true, isDefault: false, isRemoteMic: true, source: 'uuremote', sourceLabel: 'UU远程' },
  savedPrevious: null,
}

const STUB_MAPPING = {
  ok: true,
  mapping: {
    version: 1,
    updatedAt: null,
    buttons: {
      ok: { click: { type: 'dsh', id: 'dsh.send', label: '发送消息（Enter）', combo: 'Enter' }, double: null, hold: null },
      up: { click: { type: 'dsh', id: 'key.up', label: '方向键 上', combo: 'ArrowUp' }, double: null, hold: null },
      down: { click: { type: 'dsh', id: 'key.down', label: '方向键 下', combo: 'ArrowDown' }, double: null, hold: null },
      left: { click: { type: 'dsh', id: 'key.left', label: '方向键 左', combo: 'ArrowLeft' }, double: null, hold: null },
      right: { click: { type: 'dsh', id: 'key.right', label: '方向键 右', combo: 'ArrowRight' }, double: null, hold: null },
      back: { click: { type: 'dsh', id: 'dsh.stopReply', label: '停止回复（Esc）', combo: 'Esc' }, double: { type: 'dsh', id: 'dsh.toggleRight', label: '开关右侧栏（工作台在这）', combo: 'Ctrl+Shift+B' }, hold: { type: 'dsh', id: 'dsh.toggleLeft', label: '开关左侧栏', combo: 'Ctrl+Alt+B' } },
      home: { click: { type: 'dsh', id: 'dsh.newSession', label: '新会话', combo: 'Ctrl+Alt+N' }, double: { type: 'app', id: 'app:Codex', label: '打开 Codex', combo: 'Codex' }, hold: null },
      menu: { click: { type: 'dsh', id: 'dsh.searchSessions', label: '搜索会话', combo: 'Ctrl+Alt+K' }, double: { type: 'app', id: 'app:cmux', label: '打开 cmux', combo: 'cmux' }, hold: null },
      tv: { click: { type: 'dsh', id: 'dsh.openWorkspace', label: '打开工作区', combo: 'Ctrl+Alt+O' }, double: null, hold: null },
      power: { click: { type: 'dsh', id: 'dsh.stopReply', label: '停止回复（Esc）', combo: 'Esc' }, double: null, hold: null },
    },
  },
  buttons: [], slots: [], presets: [],
}

const sandbox = {
  window: null,
  navigator: { language: 'zh-CN', languages: ['zh-CN'] },
  document: {
    documentElement: { lang: 'zh-CN' },
    getElementById: () => null,
    head: { appendChild: () => {} },
    createElement: () => ({ style: {}, appendChild() {}, addEventListener() {}, remove() {}, focus() {}, set value(v) { this._v = v }, get value() { return this._v }, showPicker() {} }),
    body: { appendChild() {} },
    hidden: false,
    addEventListener() {}, removeEventListener() {},
  },
  fetch: (url, init) => {
    apiCalls.push(String(url))
    const pick = String(url).includes('/link') ? STUB_LINK
      : String(url).includes('/voice/status') ? STUB_VOICE
      : String(url).includes('/mapping') ? STUB_MAPPING
      : { ok: false, error: 'unexpected-url' }
    return Promise.resolve({ status: 200, text: () => Promise.resolve(JSON.stringify(pick)) })
  },
  console,
  AbortSignal,
}

function loadPlugin(reactStub) {
  const windowStub = {
    __ModuleLoader__: {
      load(entry) {
        const module = { exports: {} }
        module.exports = entry.factory((id) => (id === 'react' ? reactStub.React : {}))
        windowStub.__plugin = module.exports
      },
    },
    localStorage: { map: new Map(), getItem(k) { return this.map.has(k) ? this.map.get(k) : null }, setItem(k, v) { this.map.set(k, String(v)) } },
    setTimeout: () => 0, clearTimeout: () => {},
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length }, clearInterval: () => {},
  }
  sandbox.window = windowStub
  new Function(...Object.keys(sandbox), readFileSync(CLIENT_PATH, 'utf8'))(...Object.keys(sandbox).map((k) => sandbox[k]))
  return windowStub.__plugin
}

/**
 * cordis 的 ctx 代理只允许读 inject 里列过的服务。`interval` / `timeout` / `throttle` … 不是
 * Context 自己的方法，而是 TimerService 用 `ctx.mixin('timer', [...])` 混上去的 accessor ——
 * 没在 inject 里声明 `timer` 就读它，运行时当场抛
 * `cannot get property "interval" without inject`，客户端条目进 failed，
 * 启动页显示「Failed to load plugins / <包名>」。
 *
 * 桩这里照抄那条规则。以前这个桩无条件提供 interval，于是「漏声明 timer」这类错误
 * 三套自测全绿、只有真机启动才发现 —— dsh-remote-mic 与 dsh-mi-remote 各栽过一次。
 */
const TIMER_VERBS = new Set(['timeout', 'interval', 'setTimeout', 'setInterval', 'throttle', 'debounce'])

/** 按插件自己的 inject 建一个会拒绝未声明动词的 ctx 桩（与真运行时的读取规则一致）。 */
function makeCtx(plugin, { slots, events, withTabs }) {
  const declared = new Set(Array.isArray(plugin.inject) ? plugin.inject : Object.keys(plugin.inject || {}))
  const timer = {
    interval(fn, ms) { intervals.push({ fn, ms }); return () => {} },
    timeout(fn, ms) { intervals.push({ fn, ms }); return () => {} },
    setTimeout(fn, ms) { intervals.push({ fn, ms }); return () => {} },
    setInterval(fn, ms) { intervals.push({ fn, ms }); return () => {} },
    throttle(fn) { return fn },
    debounce(fn) { return fn },
  }
  const base = {
    get(name) {
      events.push('get:' + name)
      if (name === 'sidebarRightTabs') {
        return withTabs ? { register(options) { slots.push({ options, from: 'tabs' }); return () => {} } } : undefined
      }
      if (name === 'sidebarRight') return { openTab() {} }
      return undefined
    },
    effect(fn) { const off = fn(); return typeof off === 'function' ? off : () => {} },
    slots: {
      inject(ownerKey, cb) { events.push('inject:' + ownerKey); return cb() },
      register(options, Component) { slots.push({ options, Component }); return () => {} },
    },
    /*
     * shortcuts 桩（2026-10-11 补）。
     *
     * 客户端从这天起用 `ctx.shortcuts.register` 注册七条命令（打开工作台/坐标系/…）。
     * 桩里原来没有这个服务，于是那七次注册全走 catch、控制台刷 21 行警告，
     * 而且**没有任何断言覆盖"命令到底注册成了什么样"**。
     * 补上之后：注册会被记进 registeredShortcuts，下面就能断言 id 与默认键位。
     */
    shortcuts: {
      register(command) { registeredShortcuts.push(command); return () => {} },
    },
  }
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop === 'string') {
        if (TIMER_VERBS.has(prop)) {
          if (!declared.has('timer')) throw new Error('cannot get property "' + prop + '" without inject')
          return timer[prop] || (() => () => {})
        }
        // 补强（2026-10-08）：`slots` 也是同一类 mixin 服务，漏声明一样要抛。
        // 只约束 timer 的话，「漏声明 slots」仍会三套全绿、真机才炸 —— 和 timer 是同一个洞的另一半。
        if (prop === 'slots' && !declared.has('slots')) {
          throw new Error('cannot get property "slots" without inject')
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

function applyPlugin(plugin, withTabs) {
  const slots = []
  const events = []
  let threw = null
  try { plugin.apply(makeCtx(plugin, { slots, events, withTabs })) } catch (error) { threw = error }
  return { slots, events, threw }
}

console.log('verify-render（真渲染冒烟 · 非浏览器级证据）')
console.log('')

const stub = makeReact()
const plugin = loadPlugin(stub)
check('client 工厂加载成功', plugin !== null && typeof plugin.apply === 'function')

const { slots, events, threw } = applyPlugin(plugin, true)
check('客户端 inject 声明了 timer（ctx.interval 的前提）',
  Array.isArray(plugin.inject) && plugin.inject.includes('timer'), JSON.stringify(plugin.inject))
check('客户端 inject 声明了 slots（ctx.slots 的前提）',
  Array.isArray(plugin.inject) && plugin.inject.includes('slots'), JSON.stringify(plugin.inject))
check('apply 不抛异常（桩按 inject 约束拒绝未声明服务）', threw === null, threw === null ? '' : String(threw.message))
// 那一行的所有权已移交 dsh-workdesktop 的 WORKSPACES 数组（slot 插不进别的组件内部），
// 所以这里断言的是「**不再**注入这个席位」——注入回去会让那一列出现两行「遥控器」。
check('不再注入 sidebar.footer.action', !events.includes('inject:sidebar.footer.action'),
  events.filter((e) => e.includes('footer')).join(','))
check('注入 shell.overlay 兜底', events.includes('inject:shell.overlay'))
check('注册右栏 Tab（本桩右栏就绪）', slots.some((row) => row.from === 'tabs'))

const footerReg = slots.find((row) => row.options.name === 'sidebar.footer.action')
// 2026-10-08 用户最终裁定：遥控器要落在「驾驶舱下方、坐标系上方」。那 5 行是 workdesktop
// **一个组件内部**渲染的，slot 插不进去 —— 所以那一行的所有权移交给了它的 `WORKSPACES` 数组
// （与 dsh-coords / dsh-modeling 同一模式）。本插件**不再注册**这个席位：
// 注册了就会出现两行「遥控器」。
check('不再注册 sidebar.footer.action（那一行改由 workdesktop 的 WORKSPACES 承载）',
  footerReg === undefined,
  footerReg === undefined ? '' : '仍在注册：order=' + String(footerReg.options.order))

const tabType = slots.find((row) => row.from === 'tabs')
check('注册右栏 Tab 类型', tabType !== undefined)
if (tabType !== undefined) {
  check('  Tab id 是 dsh-mi-remote:panel', tabType.options.id === 'dsh-mi-remote:panel', String(tabType.options.id))
  // workdesktop 的 WORKSPACES 里那一行用的就是这个 kind，改了两边就对不上。
  check('  Tab kind 与 workdesktop 那一行引用的字符串一致', tabType.options.kind === 'dsh-mi-remote:panel', String(tabType.options.kind))
  check('  title=遥控器', tabType.options.title() === '遥控器')
  const guide = Array.isArray(tabType.options.guide) ? tabType.options.guide[0] : null
  // 用户 2026-10-08 裁定：右栏指南卡排在**驾驶舱（31）之后、坐标系（32）之前** ⇒ 31.5。
  // 官方按 order 升序排且允许小数，所以能插进相邻整数之间。
  check('  指南卡 order=31.5（驾驶舱 31 之后、坐标系 32 之前）', guide !== null && guide.order === 31.5, String(guide && guide.order))
  // 不提供 icon 时官方在卡上画方块占位符 —— 用户报的「图标还没换」就是这个，守住它。
  check('  指南卡提供了图标组件（缺了官方画方块占位符）', guide !== null && typeof guide.icon === 'function',
    guide === null ? '没有 guide' : typeof guide.icon)
}

/* 指南卡图标真渲染（官方只给 {size, className}） */
{
  const Icon = plugin.__test && plugin.__test.GuideIcon
  check('暴露 GuideIcon 以便回归', typeof Icon === 'function')
  if (typeof Icon === 'function') {
    const tree = makeRenderer(stub, Icon, { size: 26 }).tree
    const svg = findAll(tree, (n) => n.type === 'svg')[0]
    check('  指南图标渲染出 svg', svg !== undefined)
    check('  尺寸跟随官方传入的 size', svg?.props.width === 26 && svg?.props.height === 26, String(svg?.props.width))
    check('  走 viewBox 0 0 28 28（与官方指南卡同规格）', svg?.props.viewBox === '0 0 28 28', String(svg?.props.viewBox))
    /*
     * 底板必须是**明确的色值**，不能依赖 CSS 令牌。
     * 2026-10-08 实测：原本写 `var(--dsw-alias-brand-primary)`，在 SVG 的 fill 上没解析出来，
     * computed fill 退回 rgb(15,17,21) 近黑 —— 真机验收 SBT-WS10 正是靠"期望色"抓到这个的
     * （它那条判据的注释里就写着"要能抓住令牌没解析出来这类失效"）。
     */
    const plates = findAll(tree, (n) => n.props && typeof n.props.fill === 'string' && /^#[0-9a-fA-F]{6}$/u.test(n.props.fill))
    check('  底板是明确的色值（不依赖令牌，令牌在 SVG fill 上可能解析失败退回近黑）', plates.length === 1,
      JSON.stringify(findAll(tree, (n) => n.props && n.props.fill !== undefined).map((n) => n.props.fill)))
    check('  底板色不是近黑（近黑 = 令牌解析失败的典型症状）', plates.length === 1 && plates[0].props.fill.toLowerCase() !== '#0f1115',
      plates.length === 1 ? String(plates[0].props.fill) : '')
  }
}

/* 左栏行真渲染：不再注册，但组件保留作回退，仍要能渲染 */
{
  const Entry = plugin.__test && plugin.__test.FooterEntry
  check('暴露 FooterEntry 以便回归（不再注册但保留实现）', typeof Entry === 'function')
  if (typeof Entry === 'function') {
    const r = makeRenderer(stub, Entry, { wide: true })
    await settle()
    const tree = r.tree
    // 这一行**外层包一个 .dsmr-wsrows 容器**（与 workdesktop 的 5 行同构），标记挂在容器上。
    const holder = findAll(tree, (n) => n.props && n.props['data-dsmr-footer'] !== undefined)
    check('左栏行有外层容器且带 data-dsmr-footer', holder.length === 1, String(holder.length))
    check('  容器 class 是 dsmr-wsrows（与那 5 行同构）', holder[0]?.props.className === 'dsmr-wsrows', String(holder[0]?.props.className))
    const buttons = findAll(tree, (n) => n.type === 'button')
    check('  渲染出一个按钮', buttons.length === 1, String(buttons.length))
    check('  按钮 class 是 dsmr-wsrow（不是 rail）', buttons[0]?.props.className === 'dsmr-wsrow', String(buttons[0]?.props.className))
    check('  有点击与右键处理', typeof buttons[0]?.props.onClick === 'function' && typeof buttons[0]?.props.onContextMenu === 'function')
    // 桩会把 RemoteIcon 这类函数组件就地展开 ⇒ 树里看到的是 svg 的 width/height，不是组件的 size prop。
    check('  图标按 wide 取 16px', findAll(tree, (n) => n.type === 'svg' && n.props && n.props.width === 16).length === 1,
      String(findAll(tree, (n) => n.type === 'svg').map((n) => n.props && n.props.width).join(',')))
    const texts = textOf(tree).join('')
    check('  行内文字是「遥控器」', texts.includes('遥控器'), texts)
    check('  行上不再有状态点（保住与其余行的一致性）', findAll(tree, (n) => typeof n.props?.className === 'string' && n.props.className.includes('fdot')).length === 0)
    check('  挂载副作用跑了（fetch>0）', apiCalls.length > 0, String(apiCalls.length))
  }
}

/* 面板真渲染（独立实例取正文组件） */
{
  const panelStub = makeReact()
  const secondPlugin = loadPlugin(panelStub)
  const applied = applyPlugin(secondPlugin, true)
  const paneReg = applied.slots.find((row) => row.options && row.options.name === 'sidebar.right.pane.tab')
  check('注册右栏正文席位', paneReg !== undefined)

  if (paneReg !== undefined && typeof paneReg.Component === 'function') {
    // 桩会就地展开函数组件 ⇒ 直接渲染正文包装组件，树即完整面板
    const fresh = makeReact()
    const third = loadPlugin(fresh)
    const local = []
    third.apply(makeCtx(third, { slots: local, events: [], withTabs: true }))
    const thirdPane = local.find((row) => row.options && row.options.name === 'sidebar.right.pane.tab')
    check('第三个实例也注册了正文席位', thirdPane !== undefined)

    const rendered = makeRenderer(fresh, thirdPane.Component, {})
    await settle()
    const tree = rendered.tree
    const count = (key) => findAll(tree, (n) => n.props && n.props[key] !== undefined).length

    check('面板带 data-dsmr-panel 标记', count('data-dsmr-panel') === 1, String(count('data-dsmr-panel')))
    /*
     * 状态列四张卡：遥控器（含电量）/ VB-CABLE / 输入法 / 语音输入路径。
     *
     * 2026-10-11 用户逐条核对时确认：
     *   · 「无线麦 SayAll」那张**是他要求删除的**，不该再出现在期望里（原来期望含 sayall）；
     *   · 「语音独占」**不是独立卡片，是包含在语音输入路径卡片中的**一行开关
     *     —— 所以它不再挂 `data-dsmr-link`（见 client.js 里那段注释），卡数就是 4。
     */
    check('状态列四张卡', count('data-dsmr-link') === 4, String(count('data-dsmr-link')))
    check('  四张卡各一份（遥控器 / VB-CABLE / 输入法 / 语音输入路径）',
      ['remote', 'cable', 'wetype', 'voicelane']
        .every((k) => findAll(tree, (n) => n.props && n.props['data-dsmr-link'] === k).length === 1),
      '缺或不唯一的卡：' + ['remote', 'cable', 'wetype', 'voicelane']
        .filter((k) => findAll(tree, (n) => n.props && n.props['data-dsmr-link'] === k).length !== 1).join(','))
    check('  语音独占挂在语音输入路径卡里（不是独立卡片）',
      findAll(tree, (n) => n.props && n.props['data-dsmr-owner'] === 'voiceowner').length === 1)
    check('  已删除的「无线麦 SayAll」卡确实不在', 
      findAll(tree, (n) => n.props && n.props['data-dsmr-link'] === 'sayall').length === 0)
    // 2026-10-08 起映射编辑器是**图形化**的（用户要「参考图片那样的界面」）：
    // 遥控器实物图 + 每键一张卡片 + 三档并排。表格版退役（MappingSectionLegacy 留作回退）。
    check('遥控器图形存在（data-dsmr-figure）', count('data-dsmr-figure') === 1, String(count('data-dsmr-figure')))
    // 13 个热点 = 12 个可映射键 + 语音键（语音键归 SayAll 管，只展示、不参与映射）。
    check('图形上的按键热点 13 个（12 个可映射 + 语音键）', count('data-dsmr-key') === 13, String(count('data-dsmr-key')))
    check('可映射键各有一张卡片（12 张，含音量 ±）', count('data-dsmr-card') === 12, String(count('data-dsmr-card')))
    check('每张卡片三档动作格子（12 × 3 = 36）', count('data-dsmr-cell') === 36, String(count('data-dsmr-cell')))
    /*
     * 版式（用户 2026-10-11 核对时确认）：**按键映射左栏 / 按键映射右栏 / 状态栏**。
     * 列的内部代号是 `col1` / `col2`（原来叫 left/right，改名后这条断言一直红着）。
     */
    const colLeft = findAll(tree, (n) => n.props && n.props['data-dsmr-col'] === 'col1')
    const colRight = findAll(tree, (n) => n.props && n.props['data-dsmr-col'] === 'col2')
    check('按键映射分左右两栏（遥控器图在中间）', colLeft.length === 1 && colRight.length === 1,
      'col1=' + colLeft.length + ' col2=' + colRight.length)
    check('  音量键现在也能映射（不再是固定键）',
      findAll(tree, (n) => n.props && (n.props['data-dsmr-card'] === 'volup' || n.props['data-dsmr-card'] === 'voldown')).length === 2,
      'volup/voldown 卡片数')
    check('  两栏的键不重不漏（共 12 个，每个恰好一张卡）',
      ['power', 'up', 'down', 'left', 'right', 'ok', 'back', 'home', 'menu', 'volup', 'voldown', 'tv']
        .every((id) => count('data-dsmr-card') === 12 && findAll(tree, (n) => n.props && n.props['data-dsmr-card'] === id).length === 1),
      '缺或不唯一的键：' + ['power', 'up', 'down', 'left', 'right', 'ok', 'back', 'home', 'menu', 'volup', 'voldown', 'tv']
        .filter((id) => findAll(tree, (n) => n.props && n.props['data-dsmr-card'] === id).length !== 1).join(','))
    check('设备行存在（呼应参考图片的「已配对」卡）', count('data-dsmr-devrow') === 1, String(count('data-dsmr-devrow')))
    check('表格版标记已彻底退场', count('data-dsmr-table') === 0, String(count('data-dsmr-table')))
    check('语音路径设备 2 行', count('data-dsmr-device') === 2, String(count('data-dsmr-device')))
    const actionButtons = findAll(tree, (n) => n.type === 'button' && n.props['data-dsmr-action'] !== undefined)
    const names = actionButtons.map((n) => n.props['data-dsmr-action']).sort()
    /*
     * 面板上的动作按钮**只有语音那三个**。
     *
     * 用户 2026-10-11 核对时确认：「保存 / 重置**不在面板上，在弹窗页里**」。
     * 原来期望里含 reset / save / bridge-open 三个，因此常红 —— 它们分别属于
     * MappingSectionLegacy（已退役、不再渲染）和详情页。
     */
    const wantActions = ['voice-apply', 'voice-refresh', 'voice-restore']
    const movedActions = ['bridge-devices', 'bridge-learn', 'bridge-selftest', 'bridge-guide', 'reset', 'save']
    check('面板上的动作按钮就是语音那三个', names.length === wantActions.length && wantActions.every((a) => names.includes(a)),
      names.join(','))
    check('  保存/重置与四个设置按钮都不在面板上（它们在上层页面里）',
      movedActions.every((a) => names.includes(a) === false), names.join(','))
    /*
     * 面板只剩**两段**：按键映射 + 状态。
     *
     * 用户 2026-10-11 核对时确认：「只需要映射/状态，其余信息可移除」。
     * 原来期望 4 段（链路体检/映射/按键桥/语音），按键桥那段已整体移除。
     */
    check('面板两段（按键映射 / 状态）', count('data-dsmr-sec') === 2, String(count('data-dsmr-sec')))
    check('  两段各一份且用对了 key',
      findAll(tree, (n) => n.props && n.props['data-dsmr-sec'] === 'mapping').length === 1
      && findAll(tree, (n) => n.props && n.props['data-dsmr-sec'] === 'link').length === 1,
      'mapping=' + findAll(tree, (n) => n.props && n.props['data-dsmr-sec'] === 'mapping').length
      + ' link=' + findAll(tree, (n) => n.props && n.props['data-dsmr-sec'] === 'link').length)
    /*
     * 已按用户要求移除的三段，验它们**确实不在**（而不是删掉断言了事）：
     *   · 「引擎就绪」提示              → data-dsmr-engine
     *   · 「启用自定义按键功能」总闸     → data-dsmr-switch="bridge"
     *   · 「锁定当前按键」锁             → data-dsmr-switch="lock"
     *   · 「按键桥」运行状态标记         → data-dsmr-bridge-state
     * 原文（client.js:1672）：用户 2026-10-11 明确要求全部移除，面板上只留"改绑定"这一件事。
     */
    check('已移除的三段确实不在（引擎就绪 / 总闸 / 锁定 / 按键桥状态）',
      count('data-dsmr-engine') === 0
      && findAll(tree, (n) => n.props && n.props['data-dsmr-switch'] === 'bridge').length === 0
      && findAll(tree, (n) => n.props && n.props['data-dsmr-switch'] === 'lock').length === 0
      && count('data-dsmr-bridge-state') === 0,
      'engine=' + count('data-dsmr-engine') + ' bridge-state=' + count('data-dsmr-bridge-state'))

    /*
     * 上层页面（用户 2026-10-08：点「自定义按键功能」弹出详情页）。
     *
     * ⚠️ 这一条**离线桩只能验到一半**：桩的 hook 是按渲染顺序用**全局数组**分配的，
     * 弹窗一插进树里，它后面所有组件（语音段等）的 hook 就整体错位 —— 点了必崩，
     * 而真 React 用 fiber 树管理、不存在这个问题。
     * 所以这里只验"面板上确实没有那四个按钮、且有一个入口"；**"点开之后页里有什么"
     * 由真机验**（README 的"未覆盖"一节如实写着）。
     */
    /*
     * 「打开设置」入口 —— 用户 2026-10-11 核对时确认：**移除**。
     *
     * 面板上只留"改绑定"这一件事；按键桥那段（含它的入口按钮与弹窗）整体不要了，
     * 所以这里验的是**它确实不在**，而不是"有没有入口"。
     * 弹窗相关的那两条（默认不渲染 / 四个设置按钮只在弹窗里）也一并去掉 ——
     * 面板上不再有任何通往那个弹窗的入口，再断言"弹窗没渲染"就没有意义了。
     */
    check('已移除的「打开设置」入口确实不在',
      findAll(tree, (n) => n.props && n.props['data-dsmr-action'] === 'bridge-open').length === 0
      && findAll(tree, (n) => n.props && n.props['data-dsmr-action'] === 'bridge-open-row').length === 0)
    check('  四个设置按钮也不在面板上', movedActions.every((a) => names.includes(a) === false), names.join(','))

    /*
     * 引导学习：入口现在也在弹窗里了 —— 所以**面板上不该**有它。
     *
     * 它点下去之后的那段交互（提示「请按 OK」、遥控器图上对应键高亮、跳过/结束、进度 1/10）
     * **离线桩里验不了**：那得先点开弹窗，而桩的 hook 是全局按顺序分配的、树结构一变就整体错位
     *（真 React 用 fiber 树，不存在这个问题）。这块由真机验 —— README 的"未覆盖"一节如实写着，
     * 下面那段 `guideBtn !== undefined` 的交互断言在离线环境会自动跳过，不当成通过。
     */
    const guideBtn = findAll(tree, (n) => n.props && n.props['data-dsmr-action'] === 'bridge-guide')[0]
    check('引导学习按钮不在面板上（它也进弹窗了）', guideBtn === undefined)
    if (guideBtn !== undefined && typeof guideBtn.props.onClick === 'function') {
      guideBtn.props.onClick()
      await settle()
      await settle()
      const guideBoxes = findAll(rendered.tree, (n) => n.props && n.props['data-dsmr-guide'] !== undefined)
      check('  点一下进入引导模式', guideBoxes.length === 1, String(guideBoxes.length))
      check('  第一步就是提示按 OK', guideBoxes[0]?.props['data-dsmr-guide'] === 'ok', String(guideBoxes[0]?.props['data-dsmr-guide']))
      const guideTexts = textOf(rendered.tree).join('')
      check('  提示语里带「请按遥控器上的」', guideTexts.includes('请按遥控器上的'), guideTexts.slice(0, 120))
      check('  进度从 1 / 10 开始', guideTexts.includes('进度 1 / 10'), guideTexts.slice(0, 160))
      const skipBtn = findAll(rendered.tree, (n) => n.props && n.props['data-dsmr-action'] === 'guide-skip')[0]
      check('  有「跳过这个」可用', skipBtn !== undefined && typeof skipBtn.props.onClick === 'function')
      if (skipBtn !== undefined) {
        skipBtn.props.onClick()
        await settle()
        // 桩把 setState 攒到微任务批次里再重渲，单靠 settle() 偶尔赶不上；这里放一拍真实事件循环。
        await new Promise((resolve) => setTimeout(resolve, 20))
        await settle()
        const afterSkip = findAll(rendered.tree, (n) => n.props && n.props['data-dsmr-guide'] !== undefined)
        check('  跳过后引导还在（没退出）', afterSkip.length === 1, String(afterSkip.length))
        check('  跳过后进度确实前进了一步', afterSkip[0]?.props['data-dsmr-guide'] !== 'ok', String(afterSkip[0]?.props['data-dsmr-guide']))
        console.log('    [诊断] 跳过后的目标键 = ' + String(afterSkip[0] && afterSkip[0].props['data-dsmr-guide']))
      }
    }
    const texts = textOf(tree).join('')
    check('文案有遥控器定位', texts.includes('遥控器'), texts.slice(0, 80))
    check('缺段有补法文案（VB-CABLE）', texts.includes('VB-CABLE'))
    /*
     * 「语音键说明在」这条已按用户 2026-10-11 核对结论**移除**。
     * 那段文案（locale 的 `voiceKey`）还在代码里，但它属于 `MappingSectionLegacy` ——
     * 新版面板不再渲染那个组件，所以在面板的文案里找不到它，是对的。
     * 留在这里只会一直红；文案本身有没有、准不准，属于 locale 表的检查，不在渲染冒烟的范围。
     */
    check('UU远程路径标签在', texts.includes('UU远程'))
    check('OK 单击显示 Enter', texts.includes('Enter'))
    check('微信输入法在链路卡上', texts.includes('微信输入法'))
    console.log('    [诊断] 面板渲染 ' + fresh.stats.renders + ' 帧 · flush ' + fresh.stats.flushed + ' 个 effect · setState ' + fresh.stats.sets)
  }
}

console.log('')
console.log('结果：PASS ' + pass + ' / FAIL ' + fail)
console.log('未覆盖（如实列出）：真实布局与几何、主题令牌渲染、hover/焦点、下拉/输入的真实交互、点击到宿主路由的往返。')
process.exit(fail === 0 ? 0 : 1)
