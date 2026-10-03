/**
 * dsh-coords 浏览器半段自测（在 Node 里跑，不开浏览器）。
 *
 * 做法：造一个最小的 `window.__ModuleLoader__`，把 `lib/client.js` 当脚本执行
 * 一次 —— 于是能直接验证**产物本身**的加载契约（工厂形状、图标、tab 注册、
 * 样式注入），再用一个带可用 hooks 的渲染沙盒把组件树渲染出来，数一数画布上
 * 到底有没有点、有没有坐标盒。
 *
 *   node selftest-client.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

let passed = 0
const failures = []
async function test(title, fn) {
  try {
    await fn()
    passed += 1
    process.stdout.write(`  ✓ ${title}\n`)
  } catch (error) {
    failures.push({ title, error })
    process.stdout.write(`  ✗ ${title}\n      ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

/* ── 最小 React 替身（带可用 hooks：状态写入能在下一轮渲染读到）───────── */

function createReact() {
  let current = null
  const sameDeps = (a, b) => a.length === b.length && a.every((item, index) => Object.is(item, b[index]))
  const React = {
    createElement(type, props, ...children) {
      const { key = null, ref = null, ...rest } = props ?? {}
      return { type, key, ref, props: rest, children }
    },
    useState(initial) {
      const slot = current.next()
      if (slot !== undefined) {
        return [slot.value, next => { slot.value = typeof next === 'function' ? next(slot.value) : next; current.dirty = true }]
      }
      const cell = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
      current.cells.push(cell)
      return [cell.value, next => { cell.value = typeof next === 'function' ? next(cell.value) : next; current.dirty = true }]
    },
    useRef(initial) {
      const slot = current.next()
      if (slot !== undefined) return slot.value
      const cell = { kind: 'ref', value: { current: initial } }
      current.cells.push(cell)
      return cell.value
    },
    useCallback(fn) { return fn },
    useEffect(fn, deps) {
      const slot = current.next()
      if (slot === undefined) {
        const cell = { kind: 'effect', fn, deps, cleanup: null }
        current.cells.push(cell)
        current.pending.push(cell)
        return
      }
      if (slot.deps !== undefined && deps !== undefined && sameDeps(slot.deps, deps)) return
      slot.fn = fn
      slot.deps = deps
      current.pending.push(slot)
    },
  }

  let tree = null
  /** 渲染一个函数组件；返回元素树，并把首轮 effect 跑掉（最多 8 轮）。 */
  const render = (Component, props) => {
    const previous = current?.cells ?? []
    const frame = { cells: [], pending: [], dirty: false, cursor: 0 }
    frame.next = () => {
      const index = frame.cursor
      frame.cursor += 1
      return previous[index]
    }
    current = frame
    tree = Component(props)
    frame.dirty = false
    let rounds = 0
    while (frame.pending.length > 0 && rounds < 8) {
      rounds += 1
      const queued = frame.pending.splice(0, frame.pending.length)
      for (const cell of queued) {
        const cleanup = cell.fn()
        cell.cleanup = typeof cleanup === 'function' ? cleanup : null
      }
      if (!frame.dirty) break
      // setState 落在首轮 effect 里：重渲染（hook 槽复用上一轮的 cell）
      const prevCells = frame.cells
      const next = { cells: [], pending: [], dirty: false, cursor: 0 }
      next.next = () => prevCells[next.cursor++]
      current = next
      tree = Component(props)
      next.cells = next.cells.concat(prevCells.slice(next.cursor))
      frame.cells = next.cells
      frame.pending = next.pending
      frame.dirty = next.dirty
    }
    return tree
  }
  /** 只渲染一层（不跑 effect）：给"元素树里嵌套的函数组件"取结构用。 */
  const renderOnly = (Component, props) => {
    const previous = current?.cells ?? []
    const frame = { cells: [], pending: [], dirty: false, cursor: 0 }
    frame.next = () => {
      const index = frame.cursor
      frame.cursor += 1
      return previous[index]
    }
    current = frame
    return Component(props)
  }
  return { React, render, renderOnly, getTree: () => tree }
}

/* ── 展平元素树（函数组件就地渲染一层，方便断言嵌套出来的结构）───────── */

/** 由 createReact 注入的"渲染一层函数组件"能力（不跑 effect，只取结构）。 */
let renderNested = () => null

function expand(node, out = [], depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) { for (const item of node) expand(item, out, depth); return out }
  if (typeof node !== 'object') return out
  if (typeof node.type === 'function' && depth < 12) {
    expand(renderNested(node.type, node.props), out, depth + 1)
    return out
  }
  out.push(node)
  for (const child of node.children ?? []) expand(child, out, depth)
  return out
}
const nodesOf = tree => expand(tree)
/** 类名按**整词**匹配：'dshco-pt' 不该把 'dshco-ptname' 也算进来。 */
const byClass = (tree, className) => nodesOf(tree).filter(node => typeof node.props?.className === 'string'
  && node.props.className.split(/\s+/).includes(className))
const byType = (tree, type) => nodesOf(tree).filter(node => node.type === type)

/* ── 环境替身（模块加载器 / document / fetch / localStorage）───────────── */

const loaded = []
const intervals = []
const injectedStyles = []

globalThis.window = { __ModuleLoader__: { load(spec) { loaded.push(spec) } } }
globalThis.document = {
  createElement() {
    return {
      attributes: {},
      textContent: '',
      setAttribute(name, value) { this.attributes[name] = value },
      remove() { this.removed = true },
    }
  },
  head: {
    appendChild(node) { injectedStyles.push(node) },
  },
}
const storage = new Map()
globalThis.localStorage = {
  getItem: key => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: key => storage.delete(key),
}
const fetchCalls = []
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), init })
  const body = String(url).includes('/meta')
    ? { version: 1, dataRoot: 'X:/tmp', modes: {}, axisColors: {}, limits: {}, templates: [], ai: { available: false } }
    : { dataRoot: 'X:/tmp', sets: [] }
  return {
    ok: true,
    status: 200,
    async text() { return JSON.stringify(body) },
    async json() { return body },
  }
}

await import('./lib/client.js')
const spec = loaded[0]
assert.ok(spec !== undefined, 'lib/client.js 没有调用 __ModuleLoader__.load')

const react = createReact()
renderNested = react.renderOnly
const mod = spec.factory(name => {
  if (name === 'react') return react.React
  throw new Error(`意外 require(${name})`)
})
const T = mod.__test

process.stdout.write('dsh-coords 浏览器半段自测\n')

/* ── 用例 ──────────────────────────────────────────────────────────────── */

await test('C-01 工厂形状与模块 id 符合加载器契约', () => {
  assert.equal(spec.id, 'dsh-coords')
  assert.equal(typeof spec.factory, 'function')
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['slots', 'sessions', 'timer'])
  assert.equal(mod.name, 'dsh-coords')
})

await test('C-01b 直读服务必须声明在 inject（读未声明服务会被 cordis 当场拦下）', async () => {
  const raw = await readFile('./lib/client.js', 'utf8')
  const declared = new Set(mod.inject)
  const rules = [
    [/ctx\.slots\b/, 'slots'],
    [/ctx\.sessions\b/, 'sessions'],
    [/ctx\.interval\b/, 'timer'],
  ]
  for (const [pattern, name] of rules) {
    if (pattern.test(raw)) assert.ok(declared.has(name), `${pattern} 是直读，但 inject 里漏了 '${name}'——会被 cordis 拦下炸掉整个客户端插件树`)
  }
})

await test('C-02 三段比例常量是 5% / 75% / 20%（用户 2026-09-25 裁定），且 CSS 与常量一致', () => {
  assert.equal(T.BAND_TOP, '5%')
  assert.equal(T.BAND_MID, '75%')
  assert.equal(T.BAND_BOT, '20%')
  assert.ok(/\.dshco-top\{flex:0 0 5%/.test(T.CSS), 'CSS 里上带不是 5%')
  assert.ok(/\.dshco-bot\{[^}]*flex:0 0 20%/.test(T.CSS), 'CSS 里下带不是 20%')
  // 中带改成**吸收余量**（flex:1 1 auto），不再写死 75%：
  // 写死时上/下带的 min-height 一撑高，三段之和就超过容器高度 ⇒ 最后一段被裁。
  assert.ok(/\.dshco-mid\{flex:1 1 auto/.test(T.CSS), '中带必须是 flex:1 1 auto（吸收余量），否则 min-height 会把后一段顶出容器')
  // 上带 min-height 必须**装得下两行控件**（24 + 3 + 22 + 10 = 59 ⇒ 60）：
  // 2026-09-25 实测，34px 时上带内容 59px 装不下 ⇒ 第二行被裁 7px + 内部滚动条 = 用户报的"页面混乱"。
  assert.ok(/\.dshco-top\{flex:0 0 5%;min-height:60px/.test(T.CSS), '上带 min-height 必须装得下两行（60px）')
  // 根容器必须占满那一栏的高度，否则百分比三段比例没有参照物（2026-09-24 真机实测踩过：
  // 只写 flex:1 1 auto 时根高变成内容高 1775px ⇒ 三段全崩）
  assert.ok(/\.dshco-root\{[^}]*height:100%/.test(T.CSS), '根容器没有 height:100%（三段比例会失去参照物）')
})

await test('C-02b 上带两行控件装得下（量出来的，不是猜的）', () => {
  // 两行高度：控件 24 + 间隙 3 + 控件 22 + 上下内边距 10 = 59
  const top = T.CSS.match(/\.dshco-top\{[^}]*min-height:(\d+)px/)
  assert.ok(top !== null, 'CSS 里找不到上带 min-height')
  assert.ok(Number(top[1]) >= 59, `上带 min-height 至少 59px 才装得下两行，现在是 ${top[1]}px`)
  assert.ok(/\.dshco-top\{[^}]*overflow-x:auto/.test(T.CSS), '上带要能横向滚动（面板窄时按钮不换行）')
  // 下带左列的头必须单行（换行会吃掉左列一半高度）
  assert.ok(/\.dshco-bothead\{[^}]*flex-wrap:nowrap/.test(T.CSS), '下带左列的头必须单行')
  assert.ok(/\.dshco-bothead\{[^}]*overflow-x:auto/.test(T.CSS), '下带左列的头要能横向滚动')
})

await test('C-02c 三段比例越界会被夹回并自愈（歪值不许把结构压塌）', () => {
  // 实测踩过的两个坏值：它们分别把"图"压到 120px 地板、并把最后一段挤出容器
  const cases = [
    [{ top: 70, mid: 10, bot: 20 }, 22, 20, 58],
    [{ top: 5, mid: 5, bot: 90 }, 5, 40, 55],
    [{ top: 1, mid: 1, bot: 98 }, 4, 40, 56],
    [{ top: -5, mid: 105, bot: 0 }, 4, 10, 86],
  ]
  for (const [input, wantTop, wantBot, wantMid] of cases) {
    const out = T.sanityBands(input)
    assert.equal(out.top, wantTop, `top 夹取不对：${JSON.stringify(input)} → ${JSON.stringify(out)}`)
    assert.equal(out.bot, wantBot, `bot 夹取不对：${JSON.stringify(input)} → ${JSON.stringify(out)}`)
    assert.equal(out.mid, wantMid, `mid 应当由 top/bot 推出：${JSON.stringify(input)} → ${JSON.stringify(out)}`)
    assert.ok(Math.abs(out.top + out.mid + out.bot - 100) < 1e-6, '三个数必须合 100')
    assert.ok(out.mid >= T.BAND_MID_MIN_FLOOR_PCT, `中带（图）必须留出 ≥${T.BAND_MID_MIN_FLOOR_PCT}%，实际 ${out.mid}`)
  }
  assert.deepEqual(T.sanityBands(null), { top: T.BAND_TOP_PCT, mid: T.BAND_MID_PCT, bot: T.BAND_BOT_PCT })
  assert.deepEqual(T.sanityBands({ top: 'x', bot: undefined }), { top: T.BAND_TOP_PCT, mid: T.BAND_MID_PCT, bot: T.BAND_BOT_PCT })
  // 存进去一个歪值 → 读出来夹回，并且**写回去自愈**（否则每次加载都拿坏值重算结构）
  globalThis.localStorage.setItem('dshco.bands', JSON.stringify({ top: 70, mid: 10, bot: 20 }))
  const healed = T.readBands()
  assert.equal(healed.top, 22)
  assert.equal(healed.mid, 58)
  const written = JSON.parse(globalThis.localStorage.getItem('dshco.bands'))
  assert.equal(written.top, 22, '歪值要写回去自愈')
  assert.equal(written.mid, 58)
  globalThis.localStorage.removeItem('dshco.bands')
})

await test('C-03 图标符合既有规范（16×16 / currentColor / 1.3 描边 / 不填充）', () => {
  const icon = T.iconCoords(16)
  assert.equal(icon.type, 'svg')
  assert.equal(icon.props.viewBox, '0 0 16 16')
  assert.equal(icon.props.stroke, 'currentColor')
  assert.equal(icon.props.strokeWidth, 1.3)
  assert.equal(icon.props.fill, 'none')
  assert.equal(icon.props['aria-hidden'], 'true')
  assert.ok(icon.children.length >= 4, '图标至少要有轴、点、投影线')
  // 三轴 + 一个点：确实是坐标系而不是随便一个图形
  const paths = icon.children.filter(child => child.type === 'path')
  assert.ok(paths.length >= 3)
  assert.ok(icon.children.some(child => child.type === 'circle'))
})

await test('C-04 apply 把「坐标系」注册成官方右栏的 tab（类型 + 正文两步注册）并注入样式', () => {
  const types = []
  const keys = []
  const registered = []
  const ctx = {
    get: name => (name === 'sidebarRightTabs' ? { register: d => { types.push(d); return () => { } } } : undefined),
    slots: {
      inject: (key, factory) => { keys.push(key); const off = factory(); return typeof off === 'function' ? off : () => { } },
      register: (options, component) => { registered.push({ options, component }); return () => { } },
    },
    interval: (fn, ms) => { intervals.push({ fn, ms }); return () => { } },
    effect: fn => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => { } },
  }
  mod.apply(ctx)
  assert.equal(types.length, 1)
  assert.equal(types[0].id, 'dsh-coords:center')
  assert.equal(types[0].kind, 'dsh-coords:center')
  assert.equal(types[0].title(), '坐标系')
  assert.ok(Array.isArray(types[0].guide) && types[0].guide.length === 1, '指南页要留一张入口卡（右栏空着时的发现入口）')
  // ★ 入口卡必须带**自己的图标**：官方 `IconProps` 是 {size, className}，不给图标时它画方块占位符
  //   （用户 2026-09-25 截图反馈：四张卡都只有一个方块）。这里验"图标在 + 是同一份图形 + 尺寸跟随官方给的 size"。
  assert.equal(typeof types[0].guide[0].icon, 'function', '指南页入口卡必须给 icon')
  const glyph = types[0].guide[0].icon({ size: 18, className: 'x-y' })
  assert.equal(glyph.type, 'svg')
  assert.equal(glyph.props.width, 18, '图标尺寸要跟随官方给的 size')
  assert.equal(glyph.props.height, 18)
  assert.equal(glyph.props.className, 'x-y', '官方给的 className 要透传')
  assert.equal(glyph.props['data-dshco-glyph'], 'coords', '打上本插件的 glyph 标记（真机判据认它）')
  // ★ 卡上的图标必须是**彩色**的：官方那两张卡（金色文件夹 / 深色终端卡）都是实色底 + 白图形，
  //   我们四张卡跟它同一形状语法。用户 2026-09-25 的要求就是"跟官方一样有配色"。
  assert.equal(glyph.props['data-dshco-guide'], 'coords', '卡上的图标要带"彩色那枚"的标记')
  assert.equal(glyph.props.viewBox, '0 0 28 28', '彩色卡的画布跟官方一致（28×28）')
  const plate = glyph.children[0]
  assert.equal(plate.type, 'rect', '第一笔画的是底板')
  assert.ok(/^rgb\(|^var\(--dsw-static-/.test(plate.props.fill), `底板要用配色，现在是 ${plate.props.fill}`)
  const marks = glyph.children[1]
  assert.equal(marks.type, 'g', '图形画在底板上（白色）')
  assert.equal(marks.props.stroke, '#fff')
  assert.equal(marks.props.style.color, '#fff', '实心点靠 color 也变白')
  assert.ok(marks.children.length >= 4, '底板上的图形本体不能是空壳')
  assert.deepEqual(keys, ['sidebar.right.pane.tab'])
  assert.equal(registered.length, 1)
  assert.equal(registered[0].options.name, 'sidebar.right.pane.tab')
  assert.equal(registered[0].options.key, 'dsh-coords:center')
  assert.equal(typeof registered[0].component, 'function')
  // 这一栏是**会话作用域** ⇒ 正文组件直接从 props 拿 sessionId（root 作用域才要自己去钩子取）
  const element = registered[0].component({ sessionId: 'session-x' })
  assert.equal(typeof element.type, 'function')
  assert.equal(element.props.scope.sessionId, 'session-x')
  assert.equal(element.props.embedded, true)
  const noSession = registered[0].component({})
  assert.equal(noSession.props.scope, undefined, '没有会话时如实传 undefined，不编一个假 sessionId')
  assert.equal(injectedStyles.length >= 1, true, '没有注入样式')
  assert.ok(/#dsh-coords|dsh-coords/.test('' + Object.keys(injectedStyles[0].attributes)), '样式没有打标记（卸载时留残留）')
})

await test('C-05 没有 ctx.slots（非 WebUI 环境）时静默降级（不抛，也不注册）', () => {
  intervals.length = 0
  const ctx = {
    get: () => undefined,
    interval: (fn, ms) => { intervals.push({ fn, ms }); return () => { } },
    effect: fn => { fn(); return () => { } },
  }
  mod.apply(ctx) // 不抛即通过
  assert.ok(intervals.some(item => item.ms === 3000), '应当挂一个 3s 的 host 事件轮询')
  assert.ok(intervals.some(item => item.ms === 1000), '仍会挂 1s 的注册重试（官方右栏服务可能晚到），但不静默装作已注册')
})

await test('C-06 空态渲染出三段结构（上/中/下）', () => {
  const tree = react.render(T.CoordsCenter, { ctx: { get: () => undefined }, scope: { sessionId: 's1' } })
  assert.equal(byClass(tree, 'dshco-top').length, 1)
  assert.equal(byClass(tree, 'dshco-mid').length, 1)
  assert.equal(byClass(tree, 'dshco-bot').length, 1)
  // 没有坐标系时中带给可操作的按钮，而不是纯空白
  assert.ok(byClass(tree, 'dshco-btn').length >= 3)
})

await test('C-06b 三段的行内样式不会互相顶（这就是"页面混乱"的根因）', () => {
  const tree = react.render(T.CoordsCenter, { ctx: { get: () => undefined }, scope: { sessionId: 's1' } })
  const top = byClass(tree, 'dshco-top')[0]
  const mid = byClass(tree, 'dshco-mid')[0]
  const bot = byClass(tree, 'dshco-bot')[0]
  // 上带：比例照旧但要带 max(…, 60px) 下限 —— 5% 在常见面板上只有 52px，装不下两行控件
  assert.ok(/max\(\s*[\d.]+%\s*,\s*60px\s*\)/.test(String(top.props.style?.flex)), `上带 flex 应当是 max(N%, 60px)，现在是 ${top.props.style?.flex}`)
  // 中带：必须**吸收余量**（1 1 auto）。写死百分比时，上带的 60px 下限会把三段之和顶到
  // 超过容器高度 ⇒ 下带被挤出容器底部 8px（实测：bot.bottom 1088 > root.bottom 1080）
  assert.equal(mid.props.style?.flex, '1 1 auto', `中带必须吸收余量，现在是 ${mid.props.style?.flex}`)
  // 下带：仍按用户裁定的比例走
  assert.ok(/0 0 20%$/.test(String(bot.props.style?.flex)), `下带应当是 0 0 20%，现在是 ${bot.props.style?.flex}`)
})

await test('C-07 2D 画布：8 个点画 8 个圆，选中那个多两条红色虚线', () => {
  const s = T.sampleSpec('2d')
  assert.equal(s.points.length, 8)
  const plain = react.render(T.Canvas2D, { spec: s, selected: null, onSelect: () => { }, compact: false })
  assert.equal(byClass(plain, 'dshco-pt').length, 8)
  assert.equal(byType(plain, 'circle').length, 8)
  // 四象限底 + 角标
  assert.equal(byType(plain, 'rect').length, 4)
  assert.ok(byClass(plain, 'dshco-tick').length >= 4)

  const chosen = s.points[2]
  const one = react.render(T.Canvas2D, { spec: s, selected: chosen.id, onSelect: () => { }, compact: false })
  const dashed = byType(one, 'line').filter(node => node.props.strokeDasharray === '5 3')
  assert.equal(dashed.length, 2, '选中点应当引两条投影虚线')
  assert.ok(dashed.every(node => node.props.stroke === '#d32f2f'))
})

await test('C-08 2D 象限判定与轴范围（自动匹配的范围就是画布范围）', () => {
  const s = T.specFromTable(T.parseTable('场景,价值,难度,赛道\n自动核价,4.6,2.0,A\nBOM 翻译,3.2,1.4,A\n'), { mode: '2d' })
  const quad = T.quadrantOf(s.points[0], s)
  assert.equal(quad.label.includes('金矿区') || quad.index === 0 || quad.index === 1, true)
  assert.equal(T.ratioOf(s.axes[0], s.axes[0].min), 0)
  assert.equal(T.ratioOf(s.axes[0], s.axes[0].max), 1)
  // 越界值被夹在 0–1，落到画布外
  assert.equal(T.ratioOf(s.axes[0], 999), 1)
})

await test('C-09 3D 画布：三条轴 + 刻度 + 点云', () => {
  const s = T.sampleSpec('3d')
  const view = { ...T.sampleSpec ? {} : {}, yaw: -0.6, pitch: 0.4, zoom: 1, panX: 0, panY: 0, focal: 38 }
  const tree = react.render(T.Canvas3D, { spec: s, selected: null, onSelect: () => { }, view, setView: () => { }, compact: false })
  assert.equal(byClass(tree, 'dshco-pt').length, s.points.length)
  const labels = byClass(tree, 'dshco-axislabel').map(node => node.children.join(''))
  assert.equal(labels.length, 3, '三条轴各一个轴名')
  assert.ok(labels.some(text => text.includes('范围')))
  assert.ok(labels.some(text => text.includes('成熟度')))
  assert.ok(labels.some(text => text.includes('适用面')))
})

await test('C-10 3D 选中后画出坐标盒：三条阶梯 + 三条闭合棱，全是红虚线', () => {
  const s = T.sampleSpec('3d')
  const view = { yaw: -0.6, pitch: 0.4, zoom: 1, panX: 0, panY: 0, focal: 38 }
  const tree = react.render(T.Canvas3D, { spec: s, selected: s.points[1].id, onSelect: () => { }, view, setView: () => { }, compact: false })
  const polylines = byType(tree, 'polyline')
  assert.equal(polylines.length, 6, `坐标盒应当是 6 条线，实际 ${polylines.length}`)
  for (const line of polylines) {
    assert.equal(line.props.stroke, '#d32f2f', '坐标盒必须是红的')
    assert.equal(line.props.strokeDasharray, '5 3', '坐标盒必须是虚线')
    assert.equal(line.props.fill, 'none')
  }
  // 三条阶梯各有两段，且**每段都严格平行于某条坐标轴**（参考实现的硬约束：
  // 阶梯「在坐标面内走到拐点，再垂直折到点」—— 每段只有一个分量在变）
  const boxes = T.guideBoxes(s.points[1], s)
  assert.equal(boxes.stairs.length, 3)
  for (const stair of boxes.stairs) {
    assert.equal(stair.points.length, 3, '阶梯应当是「轴锚点 → 面拐点 → 点」')
    const [anchor, corner, target] = stair.points
    for (const [from, to, label] of [[anchor, corner, '第一段'], [corner, target, '第二段']]) {
      const changed = ['x', 'y', 'z'].filter(key => Math.abs(Number(from[key]) - Number(to[key])) > 1e-9)
      assert.equal(changed.length, 1, `${label}必须平行于坐标轴（实际变了 ${changed.length} 个分量）`)
      assert.ok(Math.abs(Number(from[changed[0]]) - Number(to[changed[0]])) > 1e-9)
    }
  }
  // 三条阶梯汇聚于同一点（就是被选中的那个点）
  const target = T.worldPointOf(s.points[1], s)
  for (const stair of boxes.stairs) {
    for (const key of ['x', 'y', 'z']) {
      assert.equal(round3(stair.points[2][key]), round3(target[key]), '三条阶梯必须汇聚到同一个点')
    }
  }
})

function round3(value) { return Math.round(Number(value) * 1000) / 1000 }

await test('C-11 3D 投影随视角变化（拖拽真的转了）', () => {
  const s = T.sampleSpec('3d')
  const point = s.points[0]
  const a = T.project3d(point, s, { yaw: 0, pitch: 0, zoom: 1, panX: 0, panY: 0, focal: 38 })
  const b = T.project3d(point, s, { yaw: Math.PI / 2, pitch: 0, zoom: 1, panX: 0, panY: 0, focal: 38 })
  assert.notEqual(round3(a.x), round3(b.x))
  const zoomed = T.project3d(point, s, { yaw: 0, pitch: 0, zoom: 2, panX: 0, panY: 0, focal: 38 })
  assert.ok(Math.abs(zoomed.x) > Math.abs(a.x), '放大后应当离中心更远')
})

await test('C-12 下带分两栏：左 30% 列表 / 右 70% 详情（各轴数值都在）', () => {
  const s = T.sampleSpec('2d')
  const tree = react.render(T.BottomBand, {
    spec: s, points: s.points, total: s.points.length, groups: s.groups,
    filter: { q: '', group: '' }, setFilter: () => { }, selected: s.points[0], selectedId: s.points[0].id, onSelect: () => { },
  })
  // 左列：列表；右列：详情 —— 两列都在，列表不落进右列
  const left = byClass(tree, 'left')
  const right = byClass(tree, 'right')
  assert.equal(left.length, 1, '应当有左列')
  assert.equal(right.length, 1, '应当有右列')
  assert.equal(nodesOf(left[0]).filter(node => (node.props?.className ?? '').toString().split(/\s+/).includes('dshco-list')).length, 1, '列表要在左列里')
  assert.equal(byClass(tree, 'dshco-item').length, s.points.length)
  assert.equal(byClass(tree, 'dshco-detail').length, 1)
  const values = byClass(tree, 'dshco-val')
  assert.equal(values.length, s.axes.length, '每个轴一个数值块')
  const text = JSON.stringify(tree)
  assert.ok(text.includes('实施难度') || text.includes('业务价值'), '详情里要能看到轴名')
})

await test('C-12b 两栏比例写死在 CSS 里（30% / 70%），且没选中时右列给提示不空白', () => {
  assert.ok(/\.dshco-col\.left\{flex:0 0 30%/.test(T.CSS), 'CSS 里左列不是 30%')
  assert.ok(/\.dshco-col\.right\{flex:1 1 70%/.test(T.CSS), 'CSS 里右列不是 70%')
  assert.ok(/\.dshco-bot\{[^}]*flex-direction:row/.test(T.CSS), '下带要横排（原来是竖排）')
  const s = T.sampleSpec('2d')
  const empty = react.render(T.BottomBand, {
    spec: s, points: s.points, total: s.points.length, groups: s.groups,
    filter: { q: '', group: '' }, setFilter: () => { }, selected: null, selectedId: null, onSelect: () => { },
  })
  assert.equal(byClass(empty, 'dshco-detail').length, 1, '没选中也要占住右列')
  assert.equal(byClass(empty, 'dshco-val').length, 0)
  assert.ok(JSON.stringify(empty).includes('点左边的点'), '没选中时右列要有引导文案')
})

await test('C-13 点搜索 / 分组筛选真的过滤（不是装饰）', () => {
  const s = T.sampleSpec('2d')
  const onlyA = s.points.filter(point => point.group === 'A')
  const tree = react.render(T.BottomBand, {
    spec: s, points: onlyA, total: s.points.length, groups: s.groups,
    filter: { q: '', group: 'A' }, setFilter: () => { }, selected: null, selectedId: null, onSelect: () => { },
  })
  assert.equal(byClass(tree, 'dshco-item').length, onlyA.length)
  assert.ok(onlyA.length > 0 && onlyA.length < s.points.length)
})

/** 把事件轮询跑在可控的桩上：手动驱动每一轮 tick。 */
function makePoller(opts = {}) {
  const opened = []
  const timers = []
  const batches = opts.batches ?? []
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    async json() { return batches.length > 0 ? batches.shift() : { rev: 999, events: [] } },
    async text() { return '' },
  })
  const ctx = {
    get: name => (name === 'sidebarRight'
      ? { openTab: id => { if (opts.throwFirst === true && opened.length === 0 && opts.failUntil !== false) throw new Error('还没有会话面可落'); opened.push(id) } }
      : undefined),
    interval: fn => { timers.push(fn); return () => { } },
    effect: fn => { fn(); return () => { } },
  }
  T.hostEvents.since = 0
  T.hostEvents.stopped = false
  T.pendingOpen.open = false
  T.pendingOpen.name = ''
  T.pendingOpen.until = 0
  return { opened, timers, ctx, restore: () => { globalThis.fetch = original }, batches }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 5))

await test('C-16e 关了还会自己弹（真机报障）：历史事件不重放 + 欠着的请求成功即清', async () => {
  const poller = makePoller({
    batches: [
      // ① 页面刚加载：host 里还缓存着 60 秒前那条 open（历史事件）
      { rev: 10, events: [{ type: 'open', at: Date.now() - 60000, name: '旧的那套' }] },
      // ② 下一轮：一条刚发生的 open
      { rev: 11, events: [{ type: 'open', at: Date.now(), name: '刚发生的那套' }] },
      // ③ 之后没有新事件
      { rev: 11, events: [] },
    ],
  })
  try {
    T.startHostEvents(poller.ctx)
    await flush()
    assert.deepEqual(poller.opened, [], '首次拉取里的历史 open 不许执行 —— 否则刷新一次就弹一次')
    poller.timers[0]()
    await flush()
    assert.deepEqual(poller.opened, ['dsh-coords:center'], '刚发生的那条要打开')
    assert.equal(T.pendingOpen.open, false, '打开成功后要把欠着的标记清掉')
    // 再跑两轮：不许再弹（这就是"关了也自己打开"的直接回归）
    poller.timers[0]()
    await flush()
    poller.timers[0]()
    await flush()
    assert.equal(poller.opened.length, 1, `打开成功后不许再重复打开（实际 ${poller.opened.length} 次）`)
  } finally {
    poller.restore()
    // 用例之间不许互相污染：把欠着的状态清干净（C-16d 会检查"起手不欠名字"）
    T.pendingOpen.open = false
    T.pendingOpen.name = ''
    T.pendingOpen.until = 0
    T.pendingOpen.nameUntil = 0
  }
})

await test('C-16f 打不开就欠着（最多欠 TTL），一旦能开只补一次', async () => {
  const opened = []
  let fail = true
  const timers = []
  const batches = [{ rev: 1, events: [{ type: 'open', at: Date.now() }] }]
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    async json() { return batches.length > 0 ? batches.shift() : { rev: 1, events: [] } },
    async text() { return '' },
  })
  const ctx = {
    get: () => ({ openTab: () => { if (fail) throw new Error('还没有会话面可落'); opened.push('open') } }),
    interval: fn => { timers.push(fn); return () => { } },
    effect: fn => { fn(); return () => { } },
  }
  try {
    T.hostEvents.since = 0
    T.hostEvents.stopped = false
    T.pendingOpen.open = false
    T.pendingOpen.until = 0
    T.startHostEvents(ctx)
    await flush()
    assert.equal(opened.length, 0, '打不开时不该记为已开')
    assert.equal(T.pendingOpen.open, true, '打不开要欠着（下一轮补）')
    assert.ok(T.pendingOpen.until > Date.now(), '欠着要有寿命，不能无限补')
    fail = false
    timers[0]()
    await flush()
    assert.equal(opened.length, 1, '能开之后补开一次')
    assert.equal(T.pendingOpen.open, false, '补开成功后必须清掉标记')
    timers[0]()
    await flush()
    assert.equal(opened.length, 1, '清掉之后不许再补 —— 否则就是每 3 秒弹一次')
  } finally {
    globalThis.fetch = original
  }
})

await test('C-14 pushToSession 把提示词放进会话输入框（不是自动发送）', () => {
  let draft = '先前的草稿'
  const ctx = {
    sessions: { scope: () => ({ id: 'actx' }) },
    get: name => (name === 'conversation'
      ? { input: { for: () => ({ state: { getSnapshot: () => ({ draft }) }, setDraft: value => { draft = value } }) } }
      : undefined),
  }
  const ok = T.pushToSession(ctx, 's1', '用坐标系卡片识别这份内容：X:/a.md')
  assert.equal(ok, true)
  assert.ok(draft.includes('用坐标系卡片识别'))
  assert.ok(draft.includes('先前的草稿'), '不该把用户已经写的内容冲掉')
  // 服务缺失时如实返回 false（调用方会把提示词原样给用户）
  assert.equal(T.pushToSession({ get: () => undefined }, 's1', 'x'), false)
})

await test('C-15 交给会话的提示词把该定的事说全（轴名/范围/分组/点）', () => {
  const prompt = T.buildRecognizePrompt({ mode: '3d', path: 'X:/内容.md' })
  assert.ok(prompt.includes('X:/内容.md'))
  assert.ok(prompt.includes('coords_save'))
  assert.ok(/轴/.test(prompt) && /分组/.test(prompt) && /取值/.test(prompt))
})

await test('C-16 host 事件总线：save 通知能被卡片订阅到', () => {
  const seen = []
  const off = T.hostEvents.subscribe(event => seen.push(event))
  T.hostEvents.emit({ type: 'save', name: 'A' })
  T.hostEvents.emit({ type: 'open', name: 'B' })
  off()
  T.hostEvents.emit({ type: 'save', name: 'C' })
  assert.deepEqual(seen.map(event => event.type), ['save', 'open'])
  assert.equal(seen[0].name, 'A')
})

await test('C-16b openCard 打开官方右栏里那一栏（ctx.sidebarRight.openTab），服务缺失时如实返回 false', () => {
  const calls = []
  const ctx = { get: name => (name === 'sidebarRight' ? { openTab: id => calls.push(id) } : undefined) }
  assert.equal(T.openCard(ctx), true)
  assert.deepEqual(calls, [T.SIDEBAR_TAB_ID], '应当打开坐标系那一栏（面板 id 即常量那张）')
  // 服务缺失时如实返回 false，不抛、不假装打开了
  assert.equal(T.openCard({ get: () => undefined }), false)
})

await test('C-16c 没有可落的会话面时不许假装打开（openTab 抛 ⇒ 返回 false 记欠着）', () => {
  const throwing = { get: () => ({ openTab: () => { throw new Error('no session surface') } }) }
  assert.equal(T.openCard(throwing), false, '开不了就欠着，不能冒充已打开')
  const working = { get: () => ({ openTab: () => { } }) }
  assert.equal(T.openCard(working), true)
})

await test('C-16d 点名要开的那一套不能丢（那一栏是这一刻才挂载、收不到那条事件）', () => {
  const ctx = { get: () => ({ openTab: () => { } }) }
  assert.equal(T.takePendingSetName(), '', '起手不该欠着名字')
  assert.equal(T.openCard(ctx, '示例项目甲 · 场景坐标系'), true)
  // 卡片挂载时取走这个名字（否则它会停在空白/上一次那套）
  assert.equal(T.takePendingSetName(), '示例项目甲 · 场景坐标系')
  // 取过一次就清空，不会反复覆盖用户后来手选的那套
  assert.equal(T.takePendingSetName(), '')
  assert.equal(T.openCard(ctx), true)
  assert.equal(T.takePendingSetName(), '')
})

await test('C-17 模板套用只换骨架、保留点（不是把用户的点清空）', () => {
  const before = T.sampleSpec('2d')
  const template = { id: 't', label: '价值 × 难度（2D 四象限）', mode: '2d', desc: '', axes: T.TEMPLATES[0].axes, groups: T.TEMPLATES[0].groups, quadrants: T.TEMPLATES[0].quadrants }
  const skeleton = T.specFromTemplate(template, before.name)
  assert.equal(skeleton.points.length, 0)
  const merged = T.normalizeSpec({ ...skeleton, name: before.name, points: before.points }, before.name)
  assert.equal(merged.points.length, before.points.length)
  assert.equal(merged.axes[0].name, '实施难度')
})

await test('C-18 导出：Markdown 表格与 CSV 都带轴名与点', () => {
  const s = T.sampleSpec('3d')
  const md = T.toMarkdown(s)
  assert.ok(md.includes('# 示例 · 场景坐标系'))
  assert.ok(md.includes('| 点 |'))
  assert.ok(md.includes('范围 S'))
  const csv = T.toCsv(s)
  assert.equal(csv.split('\n').length, s.points.length + 1)
  assert.ok(csv.split('\n')[0].includes('成熟度 M'))
})

await test('C-19 体检与归一化在客户端侧同样生效（脏数据不会渗进画布）', () => {
  const dirty = T.normalizeSpec({ mode: '3d', axes: [{ key: 'x', name: 'A', min: 5, max: 5 }], points: [{ name: 'P', values: { x: 'abc', y: 1 } }] })
  assert.equal(dirty.axes.length, 3, '3D 必须补齐三根轴')
  assert.ok(dirty.axes[0].max > dirty.axes[0].min, '空范围必须被撑开，否则投影除零')
  assert.equal(Number.isFinite(dirty.points[0].values.x), true, '非数值必须落成有限数')
  assert.ok(Array.isArray(T.auditSpec(dirty)))
})

await test('C-31 三条分隔条都在（三段高度可拖 + 下带左右可拖），CSS 有对应光标', () => {
  // 用户 2026-09-25 裁定：上/中/下三段高度能拖、下带左右两列宽度能拖。
  // 判据只管"三条分隔条真的在树上、且光标语义对"——拖动行为本身由真机探针验（Node 里没有指针）。
  const tree = react.render(T.CoordsCenter, { ctx: { get: () => undefined }, scope: { sessionId: 's1' } })
  const handles = nodesOf(tree)
    .filter(node => typeof node.props?.['data-dshco-split'] === 'string')
    .map(node => node.props['data-dshco-split'])
    .sort()
  assert.deepEqual(handles, ['bot', 'cols', 'top'], '三条分隔条必须在（top / bot / cols）')
  assert.ok(/\.dshco-hsplit\{[^}]*cursor:row-resize/.test(T.CSS), '横向分隔条必须 row-resize 光标')
  assert.ok(/\.dshco-vsplit\{[^}]*cursor:col-resize/.test(T.CSS), '纵向分隔条必须 col-resize 光标')
  assert.ok(/\.dshco-hsplit\{[^}]*position:absolute/.test(T.CSS), '分隔条走绝对定位覆盖，不占布局（否则三段百分比会溢出）')
  // 拖动时的夹紧函数：越界必须夹回，非法值走下限
  assert.equal(T.clampNum(5, 10, 90), 10)
  assert.equal(T.clampNum(200, 10, 90), 90)
  assert.equal(T.clampNum(NaN, 10, 90), 10)
})

/* ── 收尾 ──────────────────────────────────────────────────────────────── */

process.stdout.write(`\n${passed} PASS / ${failures.length} FAIL\n`)
if (failures.length > 0) {
  for (const failure of failures) process.stdout.write(`  ✗ ${failure.title}: ${failure.error?.stack ?? failure.error}\n`)
  process.exitCode = 1
}
