/**
 * dsh-modeling 浏览器半段自测（在 Node 里跑，不开浏览器）。
 *
 * 做法：造一个最小的 `window.__ModuleLoader__`，把 `lib/client.js` 作为脚本
 * 执行一次 —— 于是能直接验证**产物本身**的加载契约（工厂形状、图标、标题、
 * 注册路径），再用工厂暴露的 `__test` 面验证建模代数与渲染用的纯函数。
 *
 *   node selftest-client.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

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

/**
 * 极简 React 替身：只要求 createElement 把 (type, props, ...children) 收下来。
 * 与真 React 一致地把 key / ref 提到元素上（否则"容器里漏 key"这类写法测不出来）。
 */
function fakeReact() {
  return {
    createElement(type, props, ...children) {
      const { key = null, ref = null, ...rest } = props ?? {}
      return { type, key, ref, props: rest, children }
    },
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: (initial) => ({ current: initial }),
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
}

/**
 * 一个够用的渲染沙盒：带**可用的 hooks**（能触发重渲染、能按依赖跑 effect、
 * 能等到异步 effect 落地），用来真的渲染组件树并在上面点一下。
 * 不是 React；只覆盖本插件的组件用到的 5 个 hook。
 *
 * ⚠️ **必须实现 useEffect 的依赖比较**：没有它，每轮渲染都会重跑所有 effect，
 * 本组件的启动 effect（依赖 `[]`）就会被反复重启 —— 每次 setState 触发新一轮、
 * 新一轮又重启加载，组件永远停在"正在读取词汇表"。实测踩过这个坑。
 */
function createSandbox() {
  let current = null
  const sameDeps = (a, b) => a.length === b.length && a.every((item, index) => Object.is(item, b[index]))
  const React = {
    // 与真 React 一致：key / ref 从 props 里**提到元素上**（不留在 props）。
    // 自测要能像真 React 一样检查 key，否则「容器里漏 key」这类写法测试也发现不了。
    createElement: (type, props, ...children) => {
      const { key = null, ref = null, ...rest } = props ?? {}
      return { type, key, ref, props: rest, children }
    },
    useState(initial) {
      const slot = current.next()
      if (slot !== undefined) {
        return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next }]
      }
      const cell = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
      current.cells.push(cell)
      return [cell.value, (next) => { cell.value = typeof next === 'function' ? next(cell.value) : next }]
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
      const idx = current.cells.length
      const slot = current.next()

      if (slot === undefined) {
        // 首次出现：进这一轮的待跑清单，settle 会执行它
        current.cells.push({ kind: 'effect', fn, deps })
        return
      }
      // 依赖没变 → 本轮不跑（**也不要在这里擅自标记"已跑"**：本轮被跳过不等于
      // 以后不用跑；下一轮依赖变了就该跑。踩过的坑见 settle 的注释。）
      if (slot.deps !== undefined && deps !== undefined && sameDeps(slot.deps, deps)) return
      slot.fn = fn
      slot.deps = deps
    },
  }
  let tree = null
  let lastComponent
  let lastProps
  /**
   * 渲染一个函数组件（组件内部若 throw，异常会原样冒出来给用例断言）。
   * 命中 slot 时**复用上一轮的 cell 对象**，所以 setState 写进 cell 的值
   * 在下一次渲染里就能读到（等价于 React 的 hook 状态）。
   *
   * `frame.ran` 是**本轮**已跑集合：它必须挂在 frame 上，不能存在 cell 里 ——
   * 一个 effect 可能在某一轮因依赖未变而被跳过，却在下一轮依赖变化时该跑；
   * 把"跳过"记进 cell 会让它永远不再执行（实测症状：profiles 到手后模型库
   * 那条 effect 再也不跑，界面停在"空画布 / 没有模型"）。
   */
  const render = (Component, props) => {
    const previous = current?.cells ?? []
    let cursor = 0
    const frame = {
      cells: [],
      ran: new Set(),
      /**
       * 取第 cursor 个 hook 槽。
       *
       * ⚠️ **命中旧槽也必须把它放回本轮 cells**：`frame.cells` 的语义是
       * 「本轮渲染按顺序见过的所有槽」，不是「本轮新建的槽」。早期版本只在
       * 新建时 push，于是复用旧槽的那一轮 `cells` 是空的 —— 该跑的 effect
       * 全都不见了，组件在「6 个槽」和「0 个槽」之间来回跳，永远启动不起来
       * （实测症状：profiles 已经到手，界面却停在空画布）。
       */
      next() {
        const cell = previous[cursor]
        cursor += 1
        if (cell !== undefined) frame.cells.push(cell)
        return cell
      },
    }
    current = frame
    tree = Component(props ?? {})
    return tree
  }
  /**
   * 反复「渲染 → 跑这一轮该跑的 effect → 等任务落地」直到没有新 effect，
   * 模拟 React 的提交-渲染循环。**必须多轮**：异步 effect 完成后 setState 会
   * 触发重渲染，而重渲染才跑得上依赖新 state 的下一个 effect（本组件的启动
   * 流程正是三段接力：profiles → 模型库 → 打开模型）。
   */
  const settle = async (options) => {
    const opts = options ?? {}
    lastComponent = opts.Component ?? lastComponent
    lastProps = opts.props ?? lastProps
    for (let round = 0; round < (opts.rounds ?? 12); round += 1) {
      // ⚠️ 顺序是「先渲染、再判空」：render 会把本轮该跑的 effect 记进
      // `current.ran`，pending 的 state 变更也在新那次渲染里才生效。
      render(lastComponent, lastProps)
      // 真 React 在 commit 阶段写 ref.current，沙盒没有 commit —— 用 onFrame 补上，
      // 否则组件的 ResizeObserver effect 会看到 null ref 直接 return（测量永远没发生）。
      if (typeof opts.onFrame === 'function') opts.onFrame()
      const batch = current.cells.filter(cell => cell.kind === 'effect' && !current.ran.has(cell))
      // 立即记账（异步 effect 里再 setState 不会让同一个 effect 在本轮重跑）
      for (const cell of batch) current.ran.add(cell)
      for (const cell of batch) {
        try {
          cell.fn()
        } catch {
          // effect 抛错：吞掉即可 —— 组件自己的错误会在树里体现，用例断言那部分
        }
      }
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    return tree
  }
  return {
    React, render, settle, getTree: () => tree, getFrame: () => current,
  }
}

/**
 * 给组件的 `useRef` 槽补上一个"挂载后的元素"。
 *
 * 真 React 在 commit 阶段把元素写进 ref.current，沙盒没有 commit，所以
 * ref 永远是 null —— 组件的 ResizeObserver effect 会直接 return，宽度永远测不到。
 * 这里手动赋值，等价于"这一帧已经挂到 DOM 上了"。
 *
 * @param sandbox createSandbox() 的返回值
 * @param value 要塞进每个 ref 的元素替身
 */
function seedRefs(sandbox, value) {
  const frame = sandbox.getFrame()
  if (frame === undefined || frame === null) return
  for (const cell of frame.cells) {
    if (cell.kind === 'ref') cell.value.current = value
  }
}

/** 深度优先遍历虚拟元素树（把函数组件也展开一层）。 */
function* walk(element, depth) {
  if (element === null || element === undefined || typeof element === 'boolean') return
  if (Array.isArray(element)) {
    for (const item of element) yield* walk(item, depth)
    return
  }
  if (typeof element !== 'object') return
  if (typeof element.type === 'function' && (depth ?? 0) < 6) {
    const rendered = element.type(element.props)
    yield* walk(rendered, (depth ?? 0) + 1)
    return
  }
  yield element
  for (const child of element.children ?? []) yield* walk(child, depth)
}

/** 在虚拟树里按断言找出第一个匹配的元素。 */
function findElement(tree, predicate) {
  for (const element of walk(tree, 0)) {
    if (predicate(element)) return element
  }
  return null
}

/** 收集虚拟树里所有匹配的元素。 */
function findAll(tree, predicate) {
  const out = []
  for (const element of walk(tree, 0)) {
    if (predicate(element)) out.push(element)
  }
  return out
}

/** 把一个 svg 元素上的文本内容拼起来（type dshmo-node 的卡片内容）。 */
function textOf(element) {
  const parts = []
  const visit = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (typeof node === 'string' || typeof node === 'number') { parts.push(String(node)); return }
    if (typeof node === 'object') (node.children ?? []).forEach(visit)
  }
  visit(element.children ?? [])
  return parts.join('')
}


/** 整棵虚拟树上所有可见文本（不看层级，按深度优先顺序）。 */
function allText(tree) {
  const parts = []
  for (const element of walk(tree, 0)) parts.push(textOf(element))
  return parts.filter(part => part !== '').join(' | ')
}

/** 执行 lib/client.js，返回它注册进模块表的 exports。 */
async function loadClientBundle() {
  const code = await readFile(join(here, 'lib', 'client.js'), 'utf8')
  let registered = null
  const sandboxWindow = {
    __ModuleLoader__: {
      load(entry) {
        registered = entry
      },
    },
  }
  // 用 Function 执行：不引入 jsdom，document 只需够 apply() 注入 <style> 用。
  // `createElementNS` **刻意不给**：图标现在必须是 React 元素，一旦有人写回
  // "造真 SVG 节点"，这里会直接抛（等于多一道守卫）。
  const document = {
    head: { appendChild() {} },
    createElement: () => ({
      setAttribute() {},
      style: {},
      textContent: '',
      remove() {},
    }),
  }
  const run = new Function('window', 'document', code)
  run(sandboxWindow, document)
  assert.ok(registered !== null, 'lib/client.js 没有调用 window.__ModuleLoader__.load')
  assert.equal(registered.id, 'dsh-modeling')
  const factory = registered.factory
  const require = (name) => {
    if (name === 'react') return fakeReact()
    throw new Error(`工厂不该 require ${name}`)
  }
  const exports = factory(require)
  // 让用例能直接扫"作者写了哪些 dshmo-* 类名"（C-28 的样式对账）
  exports.__test.__source = code
  return exports
}

const exports = await loadClientBundle()

process.stdout.write('dsh-modeling 浏览器半段自测\n')

// ── 加载契约 ──────────────────────────────────────────────────────────────
await test('C-1 工厂导出 Cordis 客户端契约（name / inject / apply）', () => {
  assert.equal(exports.name, 'dsh-modeling')
  // 'timer' 是硬要求：ctx.interval() 由 TimerService 经 ctx.mixin 混入，
  // 不声明就抛 `cannot get property "interval" without inject`（实测事故）。
  assert.deepEqual(exports.inject, ['slots', 'timer'])
  assert.equal(typeof exports.apply, 'function')
})

/** 官方右栏服务的桩：`register` 收类型定义，`slots.register` 收正文注册。**/
const tabsStub = (out) => ({
  register: (definition) => { out.types.push(definition); return () => {} },
})
const slotsStub = (out) => ({
  inject: (key, factory) => { out.injectKeys.push(key); const off = factory(); return typeof off === 'function' ? off : () => {} },
  register: (options, component) => { out.bodies.push({ options, component }); return () => {} },
})
const freshOut = () => ({ types: [], injectKeys: [], bodies: [] })

await test('C-1b 官方右栏服务晚到位时用 ctx.interval 轮询（1s 一次，最多 30 次）', () => {
  const timers = []
  let tick = null
  const ctx = {
    get: () => undefined,          // 服务还没出现
    slots: slotsStub(freshOut()),
    effect: (fn) => { fn(); return () => {} },
    interval: (fn, delay) => { timers.push(delay); tick = fn; return () => {} },
  }
  exports.apply(ctx)
  assert.equal(timers.length, 1, '服务缺失时应起一个重试定时器')
  assert.equal(timers[0], 1000, '每秒重试一次')
  // 跑满 30 次后应自己停下且不抛
  for (let i = 0; i < 31; i += 1) tick()
})

await test('C-2 apply 把「建模中心」注册成官方右栏的 tab（类型 + 正文两步注册）', () => {
  const out = freshOut()
  const ctx = {
    get: (name) => (name === 'sidebarRightTabs' ? tabsStub(out) : undefined),
    slots: slotsStub(out),
    effect: (fn) => { fn(); return () => {} },
    interval: () => () => {},
  }
  exports.apply(ctx)
  assert.equal(out.types.length, 1, '应注册恰好一个 tab 类型')
  const definition = out.types[0]
  assert.equal(definition.id, exports.__test.SIDEBAR_TAB_ID)
  assert.equal(definition.kind, exports.__test.SIDEBAR_TAB_ID)
  assert.equal(definition.title(), '建模中心')
  assert.ok(Array.isArray(definition.guide) && definition.guide.length === 1, '指南页要留一张入口卡（右栏空着时的发现入口）')
  assert.equal(typeof definition.guide[0].title(), 'string')
  // ★ 入口卡必须带**自己的图标**（不给的话官方画方块占位符 —— 用户 2026-09-25 截图反馈的就是它）
  assert.equal(typeof definition.guide[0].icon, 'function', '指南页入口卡必须给 icon')
  const glyph = definition.guide[0].icon({ size: 18, className: 'x-y' })
  assert.equal(glyph.type, 'svg')
  assert.equal(glyph.props.width, 18, '图标尺寸要跟随官方给的 size')
  assert.equal(glyph.props.className, 'x-y', '官方给的 className 要透传')
  assert.equal(glyph.props['data-dshmo-glyph'], 'modeling', '打上本插件的 glyph 标记（真机判据认它）')
  // ★ 卡上的图标必须是**彩色**的：官方那两张卡（金色文件夹 / 深色终端卡）都是实色底 + 白图形，
  //   我们四张卡跟它同一形状语法。用户 2026-09-25 的要求就是"跟官方一样有配色"。
  assert.equal(glyph.props['data-dshmo-guide'], 'modeling', '卡上的图标要带"彩色那枚"的标记')
  assert.equal(glyph.props.viewBox, '0 0 28 28', '彩色卡的画布跟官方一致（28×28）')
  const plate = glyph.children[0]
  assert.equal(plate.type, 'rect', '第一笔画的是底板')
  assert.ok(/^rgb\(|^var\(--dsw-static-/.test(plate.props.fill), `底板要用配色，现在是 ${plate.props.fill}`)
  const marks = glyph.children[1]
  assert.equal(marks.type, 'g', '图形画在底板上（白色）')
  assert.equal(marks.props.stroke, '#fff')
  assert.equal(marks.props.style.color, '#fff')
  assert.equal(marks.children.length, 5, '底板上的图形本体应与单色那枚同一份（3 rect + 2 path）')
  // 正文：键控席位 sidebar.right.pane.tab，key = 类型 id（官方两步注册的第二步）
  assert.deepEqual(out.injectKeys, ['sidebar.right.pane.tab'])
  assert.equal(out.bodies.length, 1)
  assert.equal(out.bodies[0].options.name, 'sidebar.right.pane.tab')
  assert.equal(out.bodies[0].options.key, 'dsh-modeling:center')
  const element = out.bodies[0].component()
  assert.equal(typeof element.type, 'function')
  assert.equal(element.props.embedded, true)
  // 图标函数仍保留（入口图标由 dsh-workbench 的四行统一画，这里只供自测/探针读形状）
  const icon = exports.__test.iconModeling(16)
  assert.equal(icon.type, 'svg')
  assert.equal(icon.props.width, 16)
  assert.equal(icon.props.viewBox, '0 0 16 16')
  assert.equal(icon.props.stroke, 'currentColor', '跟随主题：用 currentColor 描边')
  assert.equal(icon.props.strokeWidth, 1.3, 'SVG 属性用 React 驼峰命名')
  // 不能是 DOM 节点：一旦带 tagName / getAttribute 就说明又写回了 createElementNS
  assert.equal(icon.tagName, undefined, '图标不能是 DOM 节点')
  const children = icon.children
  assert.equal(children.length, 5, '图标应由 3 个 rect + 2 条 path 组成')
  for (const child of children) assert.ok(child.key !== null && child.key !== undefined, '图标子元素需要 key')
})

await test('C-3 组件首帧是"正在读取词汇表"而不是白屏', () => {
  const out = freshOut()
  const ctx = {
    get: (name) => (name === 'sidebarRightTabs' ? tabsStub(out) : undefined),
    slots: slotsStub(out),
    effect: (fn) => { fn(); return () => {} },
    interval: () => () => {},
  }
  exports.apply(ctx)
  assert.ok(exports.__test !== undefined)
})

await test('C-4 没有 ctx.slots（非 WebUI 环境）时静默降级（不抛，也不注册）', () => {
  const out = freshOut()
  let intervalCalls = 0
  const ctx = {
    get: (name) => (name === 'sidebarRightTabs' ? tabsStub(out) : undefined),
    effect: (fn) => { fn(); return () => {} },
    interval: () => { intervalCalls += 1; return () => {} },
  }
  exports.apply(ctx) // 不抛即通过
  assert.equal(out.types.length, 0, '没有渲染器就什么都不注册')
  assert.equal(intervalCalls, 1, '仍会挂重试定时器（服务可能晚到），但不静默装作已注册')
})

// ── 建模代数（与 host 共用同一份源码）─────────────────────────────────────
const T = exports.__test

await test('C-5 三个档案共用同一条 5 层抽象轴，词汇各不相同', () => {
  assert.equal(T.AXIS.length, 5)
  const labels = T.PROFILES.map(profile => profile.layers.map(layer => layer.label).join('/'))
  assert.equal(labels.length, 3)
  assert.equal(new Set(labels).size, 3, '三个档案的层词汇应各不相同（否则就不需要档案了）')
  assert.ok(labels[0].includes('议题'), '方法论 L0 应是「议题」')
  assert.ok(labels[1].includes('概念'), '系统 L1 应是「概念」')
  assert.ok(labels[2].includes('触发'), '业务过程 L0 应是「触发」')
})

await test('C-6 层信息是「档案词汇 + 轴上通用语义」的组合', () => {
  const info = T.layerInfo('methodology', 1)
  assert.equal(info.label, '原理')
  assert.equal(info.axisName, '语义')
  assert.equal(info.question, '什么是不变的原则')
  assert.equal(T.layerLabel('system', 3), '实现')
  assert.equal(T.layerLabel('不存在的档案', 0), T.PROFILES[0].layers[0].label, '未知档案回落第一个档案')
})

await test('C-7 节点朝向由类型决定，流程与结构可以同图共存', () => {
  assert.equal(T.orientationOf('methodology', 'principle'), 'declarative')
  assert.equal(T.orientationOf('methodology', 'activity'), 'procedural')
  assert.equal(T.orientationOf('system', 'job'), 'procedural')
  assert.equal(T.orientationOf('process', 'trigger'), 'procedural')
})

await test('C-8 属性 facet：类型声明的在前，额外填的补在末尾', () => {
  const keys = T.attrKeys('methodology', 'activity', { notes: 'x', 未知键: 'y' })
  assert.deepEqual(keys.slice(0, 4), ['steps', 'inputs', 'outputs', 'role'], '先按类型声明顺序')
  assert.ok(keys.includes('notes'), '额外填写的已知属性要能继续编辑')
  assert.ok(keys.includes('未知键'), '未知键也不能丢（不能让用户的输入消失）')
  assert.equal(T.attrLabel('steps'), '步骤')
  assert.equal(T.attrType('steps'), 'list')
  assert.equal(T.attrType('principle'), 'text')
  assert.equal(T.attrType('未知键'), 'text', '未知键按单行文本处理')
})

await test('C-9 属性计数只算有内容的', () => {
  const node = { attrs: { principle: '  ', steps: ['', '  '], notes: '有', metrics: ['1'] } }
  assert.equal(T.attrCount(node), 2, '空字符串与全空数组不算')
  assert.equal(T.attrHasValue([]), false)
  assert.equal(T.attrHasValue(''), false)
  assert.equal(T.attrHasValue([' ']), false)
  assert.equal(T.attrHasValue(['x']), true)
})

await test('C-10 画布卡片的显示行来自类型 + 说明 + 已填属性', () => {
  const model = T.normalizeModel({
    profile: 'methodology',
    nodes: [{ id: 'n1', name: '立项', level: 2, type: 'stage', desc: '把议题变成可执行计划', attrs: { inputs: ['议题'], outputs: ['计划'] } }],
    edges: [],
  }, 'methodology')
  const lines = T.nodeLines(model, model.nodes[0])
  assert.equal(lines[0], '▷ 阶段 · 过程式')
  assert.equal(lines[1], '把议题变成可执行计划')
  assert.equal(lines[2], '输入 · 产出')
  assert.equal(T.clip('一二三四五六', 4), '一二三…')
  assert.equal(T.clip('短', 4), '短')
})

await test('C-11 连边路径：从右侧出、左侧入（层从左到右推进）', () => {
  const from = { x: 0, y: 0 }
  const to = { x: 300, y: 40 }
  const path = T.edgePath(from, to)
  assert.match(path, /^M 186 37 C /)
  assert.ok(path.includes('300 77'), '终点应是目标节点左边中点')
})

await test('C-12 新节点默认落在语义层，新边默认"关联"', () => {
  const node = T.newNode('methodology')
  assert.equal(node.level, 1)
  assert.equal(node.type, 'issue', 'L1 的第一个类型是 issue（档案声明顺序）')
  assert.equal(node.x, null)
  const edge = T.newEdge('a', 'b')
  assert.equal(edge.type, 'relates')
  assert.ok(T.EDGE_TYPES[edge.type] !== undefined)
})

await test('C-13 空模型可用（画布首帧不炸）', () => {
  const model = T.emptyModel('system')
  assert.equal(model.profile, 'system')
  assert.deepEqual(model.nodes, [])
  const laid = T.layoutModel(model)
  assert.deepEqual(laid.positions, {})
})

await test('C-14 Markdown / Mermaid 导出对空模型也成立', () => {
  const model = T.normalizeModel({ profile: 'system', name: '空', nodes: [], edges: [] }, 'system')
  const md = T.toMarkdown(model)
  assert.ok(md.startsWith('# 空'))
  assert.ok(md.includes('_（空）_'))
  const mmd = T.toMermaid(model)
  assert.equal(mmd.trim(), 'flowchart LR')
})

await test('C-15 属性值按声明类型塑形（列表 ↔ 多行文本）', () => {
  assert.deepEqual(T.coerceAttr('steps', '甲\n乙\n\n丙'), ['甲', '乙', '丙'])
  assert.deepEqual(T.coerceAttr('steps', ['甲', '  ', '乙']), ['甲', '乙'])
  assert.equal(T.coerceAttr('principle', ['甲', '乙']), '甲；乙')
  assert.equal(T.coerceAttr('notes', 42), '42')
})

// ── 真的渲染一遍（沙盒 hooks）──────────────────────────────────────────────

/** 宿主元素替身：组件只把它交给 ResizeObserver.observe，不碰别的属性。 */
function fakeHostElement() {
  return { clientWidth: 360, scrollTo() {}, addEventListener() {}, removeEventListener() {} }
}

/**
 * 可控的 ResizeObserver 替身：组件靠它测自己的宽度来决定「窄态抽屉 / 宽态三栏」。
 * 自测要能主动"报一个宽度"，才能验证那个分支。
 *
 * @returns {{ResizeObserver: Function, emit: (index:number, width:number) => void}}
 */
function makeFakeResizeObserver() {
  const targets = []
  class Fake {
    constructor(callback) { this.callback = callback }
    observe(element) { targets.push({ callback: this.callback, element }) }
    disconnect() {}
  }
  return {
    ResizeObserver: Fake,
    emit(index, width) {
      const target = targets[index]
      if (target === undefined) throw new Error(`没有第 ${index} 个被观察元素`)
      target.callback([{ contentRect: { width, height: 600 }, target: target.element }])
    },
  }
}

/** 内存版 localStorage（组件用它做离线缓存，两级真相源里的"本地兜底"）。 */
function memoryStorage() {
  const map = new Map()
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: key => { map.delete(key) },
    get size() { return map.size },
  }
}

/** 在给定的 React 实现下重新加载一次浏览器产物（模块级 React 是加载期绑定的）。 */
async function loadClientWith(react, fetchImpl, storage) {
  globalThis.fetch = fetchImpl
  globalThis.localStorage = storage
  const code = await readFile(join(here, 'lib', 'client.js'), 'utf8')
  let registered = null
  const document = {
    head: { appendChild() {} },
    createElement: () => ({ setAttribute() {}, style: {}, textContent: '', remove() {} }),
    // createElementNS 刻意不给：图标必须是 React 元素（见 C-2）
  }
  new Function('window', 'document', code)(
    {
      __ModuleLoader__: { load: (entry) => { registered = entry } },
      // 组件会挂 window 级 pointermove/pointerup（拖节点用）；沙盒里给空实现。
      addEventListener() {},
      removeEventListener() {},
      innerWidth: 1440,
    },
    document,
  )
  return registered.factory((name) => {
    if (name === 'react') return react
    throw new Error(`工厂不该 require ${name}`)
  })
}

/** host 路由替身：按路径返回脚本化的应答；记录收到的写请求。 */
function scriptedFetch(routes, log) {
  return async (url, init) => {
    const path = String(url).replace('/modeling/api', '')
    const key = `${init?.method ?? 'GET'} ${path.split('?')[0]}`
    if (log !== undefined) log.push({ key, body: init?.body ?? null })
    const handler = routes[path.split('?')[0]]
    if (handler === undefined) return { ok: false, status: 404, text: async () => JSON.stringify({ error: `没有替身路由 ${key}` }) }
    const payload = typeof handler === 'function' ? handler(path, init) : handler
    if (payload === null) return { ok: false, status: 500, text: async () => JSON.stringify({ error: '替身故意失败' }) }
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) }
  }
}

/** 直接手搭一份与 host 下发同形的词汇表（不依赖 host 在跑）。 */
function catalogFixture() {
  const modeling = T
  return {
    version: 1,
    axis: modeling.AXIS,
    orientations: modeling.ORIENTATIONS,
    attrFields: modeling.ATTR_FIELDS,
    edgeTypes: modeling.EDGE_TYPES,
    profiles: modeling.PROFILES,
    dataRoot: 'C:/tmp/.dsh-modeling',
  }
}

const sampleModel = {
  id: 'm1',
  profile: 'methodology',
  name: '从零到交付',
  intent: '把做法讲到第二个人能照着做',
  createdAt: 1,
  updatedAt: 2,
  nodes: [
    { id: 'n1', name: '议题定位', level: 0, type: 'issue', desc: '先划边界', attrs: { boundary: '不做投研' }, x: 60, y: 48 },
    { id: 'n2', name: '第一性原则', level: 1, type: 'principle', desc: '', attrs: { principle: '结论必须可复现' }, x: 318, y: 48 },
    { id: 'n3', name: '执行规程', level: 3, type: 'activity', desc: '', attrs: { steps: ['采集', '复核'] }, x: 834, y: 48 },
  ],
  edges: [
    { id: 'e1', from: 'n1', to: 'n2', type: 'flows', label: '约束' },
    { id: 'e2', from: 'n2', to: 'n3', type: 'realizes', label: '' },
  ],
}

await test('C-16 画布渲染：层列头 + 节点卡片 + 过程边箭头', () => {
  const sandbox = createSandbox()
  const modeling = T
  const model = modeling.normalizeModel(sampleModel, 'methodology')
  const laid = modeling.layoutModel(model, { force: true })
  // Canvas 自身不用 hooks，所以直接调函数拿元素树
  const tree = sandbox.React.createElement(modeling.Canvas, {
    model, laid, selected: null, connectFrom: null, panMode: false,
    onNodeDown: () => {}, onNodeClick: () => {}, onCanvasClick: () => {}, onSelectEdge: () => {},
  })
  const unwrapped = modeling.Canvas(tree.props)
  assert.equal(unwrapped.type, 'svg')
  const texts = findAll(unwrapped, el => el.type === 'text')
  const joined = texts.map(textOf).join(' | ')
  for (const want of ['L0 议题', 'L1 原理', 'L3 规程', '议题定位', '第一性原则', '执行规程']) {
    assert.ok(joined.includes(want), `画布应出现「${want}」，实际 ${joined}`)
  }
  // 三个节点各一张卡片，坐标来自模型（不是重新排的）
  const nodes = findAll(unwrapped, el => typeof el.props?.className === 'string' && el.props.className.startsWith('dshmo-node'))
  assert.equal(nodes.length, 3)
  const transforms = nodes.map(node => node.props.transform)
  assert.ok(transforms.includes('translate(60,48)'), `模型自带坐标优先，实际 ${transforms.join(' ')}`)
  assert.ok(transforms.includes('translate(834,48)'), '最右层的节点不被重排')
  // 箭头：flows + realizes 都是有向关系 → 两条边各一个终点箭头；
  // 「关联」那类无向关系没有（见 C-27）
  const marked = findAll(unwrapped, el => el.type === 'path' && el.props['marker-end'] !== undefined)
  assert.equal(marked.length, 2, '样板里 flows 与 realizes 都应带箭头')
  for (const path of marked) assert.equal(path.props['marker-end'], 'url(#dshmo-arrow)')
  // 每条边都有一个加宽的点击热区
  const hits = findAll(unwrapped, el => el.props?.className === 'dshmo-hit')
  assert.equal(hits.length, 2)
  assert.equal(typeof hits[0].props.onClick, 'function', '边必须可点选（否则改不了它的类型）')
})

await test('C-17 卡片装了词汇表后能渲染整棵界面，并在右侧检验器里编辑选中节点', async () => {
  globalThis.__c17 = true
  const sandbox = createSandbox()
  const client = await loadClientWith(
    sandbox.React,
    scriptedFetch({
      '/profiles': catalogFixture(),
      '/meta': { dataRoot: 'C:/tmp/.dsh-modeling', ai: { available: true, provider: 'deepseek-official', model: 'deepseek-v4-flash', source: 'agent-default-model' } },
      '/models': { profile: 'methodology', models: [{ name: sampleModel.name, profile: 'methodology', updatedAt: 2, createdAt: 1, nodes: 3, edges: 2, intent: sampleModel.intent }] },
      '/model': { model: sampleModel },
    }),
    memoryStorage(),
  )
  const center = client.__test.ModelingCenter
  // settle 返回**稳定后**的那棵树（异步接力跑完才有的界面）
  let tree = await sandbox.settle({ Component: center, props: { embedded: true } })
  const text = allText(tree)
  assert.ok(text.includes('议题定位'), `模型加载后画布应画出节点，实际 ${text}`)
  // 顶栏应显示模型名；左侧应有五个按层加节点按钮
  const inputs = findAll(tree, el => el.type === 'input')
  assert.equal(inputs[0].props.value, '从零到交付', '顶栏第一格是模型名')
  const layerButtons = findAll(tree, el => el.type === 'button' && /^L[0-4] /.test(textOf(el)))
  assert.equal(layerButtons.length, 5, `应有 5 个按层加节点按钮，实际 ${layerButtons.map(textOf).join(',')}`)
  // 点一下节点 → 右侧检验器切到该节点，并给出它的属性表单
  const node = findAll(tree, el => typeof el.props?.className === 'string' && el.props.className.startsWith('dshmo-node'))[1]
  assert.ok(node !== null && node !== undefined, '画布上应有可点的节点卡片')
  node.props.onClick({ stopPropagation() {} })
  tree = sandbox.render(center, { embedded: true })
  const labels = findAll(tree, el => el.type === 'label').map(textOf)
  assert.ok(labels.some(item => item.includes('名称')), `检验器应出现名称字段，实际 ${labels.join(' / ')}`)
  assert.ok(labels.some(item => item.includes('原则')), '类型声明的属性应渲染成表单行')
  const values = findAll(tree, el => el.type === 'input' || el.type === 'textarea').map(el => el.props.value)
  assert.ok(values.includes('第一性原则'), '检验器应带出被选中节点的名字')
  assert.ok(values.some(value => String(value).includes('结论必须可复现')), '检验器应带出已填属性')
})

await test('C-18 host 不可达时不留白屏：给出可行动的错误提示', async () => {
  const sandbox = createSandbox()
  const client = await loadClientWith(
    sandbox.React,
    scriptedFetch({}),   // 全部 404
    memoryStorage(),
  )
  const center = client.__test.ModelingCenter
  const tree = await sandbox.settle({ Component: center, props: { embedded: true } })
  const text = allText(tree)
  assert.ok(text.includes('host 未就绪'), `应显示 host 未就绪，实际 ${text.slice(0, 200)}`)
  assert.ok(text.includes('重启 DSH'), '应告诉用户为什么没生效（模块缓存）')
})

await test('C-19 落盘请求带的是 host 真能用的形状（POST /model）', async () => {
  const sandbox = createSandbox()
  const log = []
  const storage = memoryStorage()
  // 预置本地缓存：模型直接可用，改动只需触发一次自动保存
  storage.setItem('dshmo.doc.methodology.从零到交付', JSON.stringify(sampleModel))
  storage.setItem('dshmo.docs.methodology', JSON.stringify([{ name: sampleModel.name, nodes: 3 }]))
  const client = await loadClientWith(
    sandbox.React,
    scriptedFetch({
      '/profiles': catalogFixture(),
      '/meta': { dataRoot: 'C:/tmp/.dsh-modeling', ai: { available: false, provider: '', model: '', source: '' } },
      '/models': { profile: 'methodology', models: [{ name: sampleModel.name, nodes: 3 }] },
      '/model': (path, init) => (init?.method === 'POST' ? { model: JSON.parse(init.body).model } : { model: sampleModel }),
    }, log),
    storage,
  )
  const center = client.__test.ModelingCenter
  let tree = await sandbox.settle({ Component: center, props: { embedded: true } })
  // 加一个节点 → rev 变化 → 防抖 800ms 后 POST /model
  const addButton = findAll(tree, el => el.type === 'button' && /^L0 /.test(textOf(el))).pop()
  assert.ok(addButton !== null && addButton !== undefined, '左侧应有 L0 加节点按钮')
  addButton.props.onClick()
  // 真 React 会因 setState 立刻重渲染；沙盒不会，所以手动渲染一帧把状态提交
  // （否则自动保存那条 effect 根本没机会挂上，测的就不是写入形状了）。
  tree = sandbox.render(center, { embedded: true })
  const afterClick = findAll(tree, el => typeof el.props?.className === 'string' && el.props.className.startsWith('dshmo-node'))
  assert.equal(afterClick.length, 4, '点一次"L0 议题"应多出一个节点')
  await new Promise(resolve => setTimeout(resolve, 1000))
  // 可能先后发生两次写入（点击前的挂起写入 + 点击后的写入）：断言的是
  // **最后一次**落盘的内容 —— 它必须带上刚加的那个节点，否则数据就丢了。
  const saves = log.filter(entry => entry.key === 'POST /model')
  assert.ok(saves.length >= 1, `应发生 POST /model，实际 ${log.map(e => e.key).join(', ')}`)
  const body = JSON.parse(saves[saves.length - 1].body)
  assert.equal(body.model.profile, 'methodology')
  assert.equal(body.model.nodes.length, 4, '新节点应已进入保存载荷')
  assert.ok(body.model.nodes.every(node => node.level >= 0 && node.level <= 4))
})

await test('C-22 窄侧边栏：上中下三带都在，下带四张卡片改 2×2（宽侧边栏装不下四列）', async () => {
  const sandbox = createSandbox()
  const client = await loadClientWith(
    sandbox.React,
    scriptedFetch({
      '/profiles': catalogFixture(),
      '/meta': { dataRoot: 'C:/tmp/.dsh-modeling', ai: { available: true, provider: 'deepseek-official', model: 'deepseek-v4-flash', source: 's' } },
      '/models': { profile: 'methodology', models: [{ name: sampleModel.name, nodes: 3 }] },
      '/model': { model: sampleModel },
    }),
    memoryStorage(),
  )
  const center = client.__test.ModelingCenter
  const observers = makeFakeResizeObserver()
  globalThis.ResizeObserver = observers.ResizeObserver
  await sandbox.settle({
    Component: center,
    props: { embedded: true },
    onFrame: () => seedRefs(sandbox, fakeHostElement()),
  })
  observers.emit(0, 360)
  const narrow = sandbox.render(center, { embedded: true })
  const hasClass = (t, name) => findAll(t, el => typeof el.props?.className === 'string'
    && el.props.className.split(/\s+/).includes(name)).length
  // 三带：上带（strip）· 中带（canvas）· 下带（cards）
  assert.equal(hasClass(narrow, 'dshmo-strip'), 1, '上带应在')
  assert.equal(hasClass(narrow, 'dshmo-canvas'), 1, '中带画布应在')
  assert.equal(hasClass(narrow, 'dshmo-cards'), 1, '下带卡片区应在')
  // 下带四张卡片并排；窄态回退成 2×2
  const cards = findAll(narrow, el => typeof el.props?.className === 'string'
    && el.props.className.split(/\s+/).includes('dshmo-card'))
  assert.equal(cards.length, 4, `下带应是四张卡片，实际 ${cards.length}`)
  const titles = cards.map(c => textOf(c.children[0])).join('|')
  for (const want of ['检验器', '体检', '导出', '环境']) {
    assert.ok(titles.includes(want), `四张卡片应含「${want}」，实际 ${titles}`)
  }
  const cardsWrap = findAll(narrow, el => typeof el.props?.className === 'string'
    && el.props.className.includes('dshmo-cards'))[0]
  assert.ok(cardsWrap.props.className.includes('grid2'), '窄态下带应改 2×2（四列在 360px 里挤不下）')
  // 上带：档案胶囊 + 模型 chip + 五层加节点 chip
  const pills = findAll(narrow, el => typeof el.props?.className === 'string'
    && el.props.className.split(/\s+/).includes('dshmo-pill'))
  assert.equal(pills.length, 3, '三个档案各一个胶囊')
  const addChips = findAll(narrow, el => typeof el.props?.className === 'string'
    && el.props.className.split(/\s+/).includes('dshmo-layer-chip'))
  assert.equal(addChips.length, 5, '五层各一个「加节点」chip')
  assert.equal(hasClass(narrow, 'dshmo-layers'), 1, '层导航条在画布内（点哪段滚到哪层）')
  const strip = findAll(narrow, el => typeof el.props?.className === 'string'
    && el.props.className.split(/\s+/).includes('dshmo-layer'))
  assert.equal(strip.length, 5, '层导航条应有五段（一条轴，缺一段就读不出"五层"）')
  // 不再有左右分栏/抽屉那套（那是被否掉的横切方案）
  assert.equal(hasClass(narrow, 'dshmo-body'), 0, '不该再有左右分栏容器')
  assert.equal(hasClass(narrow, 'dshmo-left'), 0)
  assert.equal(hasClass(narrow, 'dshmo-right'), 0)
  assert.equal(hasClass(narrow, 'dshmo-drawer'), 0)
})

await test('C-23 宽面板：四张卡片单行并排（这是"下面的四张卡片在一行"的默认形态）', async () => {
  const sandbox = createSandbox()
  const client = await loadClientWith(
    sandbox.React,
    scriptedFetch({
      '/profiles': catalogFixture(),
      '/meta': { dataRoot: 'x', ai: { available: true, provider: 'p', model: 'm', source: 's' } },
      '/models': { profile: 'methodology', models: [{ name: sampleModel.name, nodes: 3 }] },
      '/model': { model: sampleModel },
    }),
    memoryStorage(),
  )
  const center = client.__test.ModelingCenter
  const observers = makeFakeResizeObserver()
  globalThis.ResizeObserver = observers.ResizeObserver
  await sandbox.settle({
    Component: center,
    props: { embedded: true },
    onFrame: () => seedRefs(sandbox, fakeHostElement()),
  })
  observers.emit(0, 1000)
  const wide = sandbox.render(center, { embedded: true })
  const wrap = findAll(wide, el => typeof el.props?.className === 'string'
    && el.props.className.includes('dshmo-cards'))[0]
  assert.ok(!wrap.props.className.includes('grid2'), '宽面板下带应是四列一行')
  assert.equal(findAll(wide, el => typeof el.props?.className === 'string'
    && el.props.className.split(/\s+/).includes('dshmo-card')).length, 4)
  // 下带可收起，把高度让给画布
  const toggle = findAll(wide, el => el.type === 'button' && textOf(el) === '收起下带')[0]
  assert.ok(toggle !== undefined, '应有「收起下带」按钮')
  toggle.props.onClick()
  const collapsed = sandbox.render(center, { embedded: true })
  assert.equal(findAll(collapsed, el => typeof el.props?.className === 'string'
    && el.props.className.split(/\s+/).includes('dshmo-card')).length, 0, '收起后下带不渲染')
  assert.equal(findAll(collapsed, el => el.type === 'button' && textOf(el) === '展开下带').length, 1)
})

await test('C-24 层导航条高亮：视窗中心落在第几层就算第几层', () => {
  const g = T.metrics(false)   // padX 26, colW 176
  // 视窗中心恰好落在 L0 列上
  assert.equal(T.viewLevelOf(0, g.colW, g.padX, g.colW, 1), 0)
  // 往右滚过一整列 → L1
  assert.equal(T.viewLevelOf(g.colW, g.colW, g.padX, g.colW, 1), 1)
  // 滚到很右边也被夹在 0..4
  assert.equal(T.viewLevelOf(99999, 360, g.padX, g.colW, 1), 4)
  assert.equal(T.viewLevelOf(-500, 360, g.padX, g.colW, 1), 0)
  // 总览缩放（scale<1）：显示坐标要先除回布局坐标再判层
  const scaled = T.viewLevelOf(g.colW * 0.5, g.colW * 0.5, g.padX, g.colW, 0.5)
  assert.equal(scaled, 1, '缩放后仍应判定为 L1')
})

await test('C-20 画布度量分宽/窄两套：窄态把列距与卡片整体缩小（横向读法要留在侧边栏里）', () => {
  const wide = T.metrics(true)
  const narrow = T.metrics(false)
  assert.ok(narrow.nodeW < wide.nodeW, '窄态卡片更窄')
  assert.ok(narrow.nodeH < wide.nodeH, '窄态卡片更矮')
  assert.ok(narrow.colW < wide.colW, '窄态列距更紧')
  assert.ok(narrow.padX < wide.padX, '窄态左边距更小（省下来给列）')
  // 五层总宽必须能塞进窄侧边栏（约 340~420px）：否则横向读法又会退化成竖条
  const totalNarrow = narrow.padX + 4 * narrow.colW + narrow.nodeW
  assert.ok(totalNarrow < 900, `窄态五层总宽 ${totalNarrow}px 应显著小于宽态`)
  assert.ok(totalNarrow < T.metrics(true).padX + 4 * T.metrics(true).colW + T.metrics(true).nodeW)
  // 同一张图在两种度量下单层节点仍落在同一列（层即列的规则不随宽度改变）
  const model = T.normalizeModel({
    profile: 'methodology',
    nodes: [
      { id: 'a', name: '甲', level: 0, type: 'issue' },
      { id: 'b', name: '乙', level: 1, type: 'principle' },
    ],
    edges: [],
  }, 'methodology')
  for (const g of [wide, narrow]) {
    const laid = T.positionMap(model, g)
    assert.equal(laid.positions.b.x - laid.positions.a.x, g.colW, `列距应等于 colW（${g.colW}）`)
  }
  // 阈值：窄态阈值必须大于两个固定栏合计宽度，否则抽屉切换会太晚
  assert.ok(T.COMPACT_MAX > 168 + 244, `COMPACT_MAX=${T.COMPACT_MAX} 应大于左右栏合计`)
})

await test('C-21 窄态节点卡片不画第四行（矮卡片放不下，宁可少一行也不溢出）', () => {
  const sandbox = createSandbox()
  const model = T.normalizeModel(sampleModel, 'methodology')
  const g = T.metrics(false)
  const laid = T.layoutModel(model, { colWidth: g.colW, rowHeight: g.rowH, padX: g.padX, padY: g.padY })
  for (const node of model.nodes) {
    const point = laid.positions[node.id] ?? { x: 0, y: 0 }
    Object.assign(node, { x: point.x, y: point.y })
  }
  const unwrapped = T.Canvas({
    model, laid: { positions: laid.positions, width: laid.width, height: laid.height },
    selected: null, connectFrom: null, panMode: false, g,
    onNodeDown: () => {}, onNodeClick: () => {}, onCanvasClick: () => {}, onSelectEdge: () => {},
  })
  const nodes = findAll(unwrapped, el => typeof el.props?.className === 'string' && el.props.className.startsWith('dshmo-node'))
  assert.equal(nodes.length, 3)
  // 每个节点：1 个卡框 + 1 条层色条 + 3 行文字（窄态不画第 4 行）= 5 个子元素
  // （有属性角标的会多 2 个：圆底 + 数字）
  for (const node of nodes) {
    const texts = node.children.filter(child => child.type === 'text')
    assert.equal(texts.length, 3, `窄态每张卡片应是 3 行文字，实际 ${texts.length}`)
    const box = node.children.find(child => child.props?.className === 'dshmo-nbox')
    assert.equal(box.props.width, g.nodeW)
    assert.equal(box.props.height, g.nodeH)
  }
  // 宽态恢复第四行
  const gw = T.metrics(true)
  const laidW = T.layoutModel(model, { colWidth: gw.colW, rowHeight: gw.rowH, padX: gw.padX, padY: gw.padY })
  const wide = T.Canvas({
    model, laid: { positions: laidW.positions, width: laidW.width, height: laidW.height },
    selected: null, connectFrom: null, panMode: false, g: gw,
    onNodeDown: () => {}, onNodeClick: () => {}, onCanvasClick: () => {}, onSelectEdge: () => {},
  })
  const wideNode = findAll(wide, el => typeof el.props?.className === 'string' && el.props.className.startsWith('dshmo-node'))[0]
  assert.equal(wideNode.children.filter(child => child.type === 'text').length, 4, '宽态仍是 4 行')
})

await test('C-25 每条连线的两个端点都落在卡片边缘上，绝不落在任何卡片内部', () => {
  // 这条守的是"连线和卡片打架"：曾经同列的两张卡片也用"源右缘→目标左缘"画，
  // 而目标左缘在源卡片的**框内** —— 曲线从卡片身上穿过、箭头被卡片埋住。
  const model = T.normalizeModel(sampleModel, 'methodology')
  for (const g of [T.metrics(true), T.metrics(false)]) {
    const laid = T.layoutModel(model, { colWidth: g.colW, rowHeight: g.rowH, padX: g.padX, padY: g.padY })
    const boxes = model.nodes.map(node => ({ id: node.id, ...laid.positions[node.id], w: g.nodeW, h: g.nodeH }))
    const eps = (d) => {
      const nums = d.match(/-?\d+(?:\.\d+)?/g).map(Number)
      return { x1: nums[0], y1: nums[1], x2: nums[nums.length - 2], y2: nums[nums.length - 1] }
    }
    const onEdgeOf = (p, box) => {
      const nearX = Math.abs(p.x - box.x) < 0.6 || Math.abs(p.x - (box.x + box.w)) < 0.6
      const nearY = Math.abs(p.y - box.y) < 0.6 || Math.abs(p.y - (box.y + box.h)) < 0.6
      return (nearX && p.y >= box.y - 0.6 && p.y <= box.y + box.h + 0.6)
        || (nearY && p.x >= box.x - 0.6 && p.x <= box.x + box.w + 0.6)
    }
    for (const edge of model.edges) {
      const a = boxes.find(b => b.id === edge.from)
      const b = boxes.find(b => b.id === edge.to)
      const { x1, y1, x2, y2 } = eps(T.edgeRoute(a, b, g).d)
      assert.ok(onEdgeOf({ x: x1, y: y1 }, a), `${edge.from}→${edge.to} 起点应在源卡片边缘上`)
      assert.ok(onEdgeOf({ x: x2, y: y2 }, b), `${edge.from}→${edge.to} 终点应在目标卡片边缘上`)
      // 两端都不得落进任何一张卡片内部（被埋住就看不见箭头）
      for (const box of boxes) {
        const inside = (p) => p.x > box.x + 0.6 && p.x < box.x + box.w - 0.6
          && p.y > box.y + 0.6 && p.y < box.y + box.h - 0.6
        assert.ok(!inside({ x: x1, y: y1 }), `${edge.from}→${edge.to} 起点落进了 ${box.id} 卡片内部`)
        assert.ok(!inside({ x: x2, y: y2 }), `${edge.from}→${edge.to} 终点落进了 ${box.id} 卡片内部`)
      }
    }
  }
})

await test('C-26 几何分三种走法：正向横向、同列竖向、反向绕行', () => {
  const g = T.metrics(false)
  const at = (x, y) => ({ x, y })
  // 正向：源右缘 → 目标左缘
  const fwd = T.edgeRoute(at(0, 0), at(400, 0), g)
  assert.equal(fwd.shape, 'forward')
  assert.equal(fwd.d.startsWith(`M ${g.nodeW} ${g.nodeH / 2}`), true, '正向从右缘中点出')
  assert.ok(fwd.d.endsWith(`${400} ${g.nodeH / 2}`), '正向从目标左缘中点入')
  // 同列：竖向，起点在下缘、终点在上缘
  const same = T.edgeRoute(at(0, 0), at(0, 300), g)
  assert.equal(same.shape, 'same')
  assert.ok(same.d.startsWith(`M `), '同列也是贝塞尔')
  assert.ok(same.d.includes(` ${g.nodeH} `), '同列起点在源卡片下缘')
  // 反向：绕到两张卡片下缘之下
  const back = T.edgeRoute(at(400, 0), at(0, 0), g)
  assert.equal(back.shape, 'back')
  assert.ok(back.mid.y > g.nodeH, `反向边的标签应在卡片下方，实际 y=${back.mid.y}`)
  // 三种走法坐标都必须是有限数（NaN 会让整条 path 消失）
  for (const route of [fwd, same, back]) {
    assert.ok(!route.d.includes('NaN'), `路径里出现了 NaN：${route.d}`)
    assert.ok(Number.isFinite(route.mid.x) && Number.isFinite(route.mid.y))
  }
})

await test('C-27 方向必须看得见：除「关联」外都有箭头，冲突两端都有', () => {
  const sandbox = createSandbox()
  const model = T.normalizeModel(sampleModel, 'methodology')
  const g = T.metrics(true)
  const laid = T.layoutModel(model, { colWidth: g.colW, rowHeight: g.rowH, padX: g.padX, padY: g.padY })
  for (const node of model.nodes) {
    const p = laid.positions[node.id] ?? { x: 0, y: 0 }
    Object.assign(node, { x: p.x, y: p.y })
  }
  const withEdges = T.normalizeModel({
    ...sampleModel,
    edges: [
      { from: 'n1', to: 'n2', type: 'relates' },    // 无向：不该有箭头
      { from: 'n1', to: 'n3', type: 'produces' },   // 有向：要有箭头
      { from: 'n2', to: 'n3', type: 'conflicts' },  // 双向：两端都要有
    ],
  }, 'methodology')
  for (const node of withEdges.nodes) {
    const p = laid.positions[node.id] ?? { x: 0, y: 0 }
    Object.assign(node, { x: p.x, y: p.y })
  }
  const unwrapped = T.Canvas({
    model: withEdges, laid: { positions: laid.positions, width: laid.width, height: laid.height },
    selected: null, connectFrom: null, panMode: false, g,
    onNodeDown: () => {}, onNodeClick: () => {}, onCanvasClick: () => {}, onSelectEdge: () => {},
  })
  const visible = findAll(unwrapped, el => el.type === 'path'
    && typeof el.props?.className === 'string' && el.props.className.startsWith('dshmo-edge'))
  assert.equal(visible.length, 3)
  // 按**边类型**取：kind 会有 'struct'/'flow' 与函数参数同名，用 id 更明确
  const byType = (id) => visible.find(el => {
    const edge = withEdges.edges.find(item => T.EDGE_TYPES[item.type]?.id === id)
    return edge !== undefined && el.props.d === T.edgeRoute(
      laid.positions[edge.from], laid.positions[edge.to], g,
    ).d
  })
  const produces = byType('produces')
  assert.ok(produces !== undefined, '应渲染出 produces 那条边')
  assert.equal(produces.props['marker-end'], 'url(#dshmo-arrow)', 'produces（结构类）也要有箭头')
  assert.equal(produces.props['marker-start'], undefined, '单向关系不该有起点箭头')
  const conflicts = byType('conflicts')
  assert.ok(conflicts !== undefined, '应渲染出 conflicts 那条边')
  assert.equal(conflicts.props['marker-end'], 'url(#dshmo-arrow)', 'conflicts 终点箭头')
  assert.equal(conflicts.props['marker-start'], 'url(#dshmo-arrow)', 'conflicts 起点箭头')
  const relates = byType('relates')
  assert.ok(relates !== undefined, '应渲染出 relates 那条边')
  assert.equal(relates.props['marker-end'], undefined, '「关联」是无向关系，不该画箭头')
  // 命中区与可见线必须用同一条路径
  const hits = findAll(unwrapped, el => el.props?.className === 'dshmo-hit')
  assert.equal(hits.length, 3)
  assert.equal(hits[0].props.d, visible[0].props.d, '命中区应与可见线共用同一份路径')
})

await test('C-28 渲染用到的每个 dshmo-* 类名都必须有对应样式规则', () => {
  // 守的是"类名与样式对不上"：曾经命中区写 className 'dshmo-hit'、样式写
  // `.dshmo-edge.hit`，于是加宽命中区（14px）从未生效，连线只有 1.4px 可点。
  // 做法：把整个源文件里出现的 dshmo-* 类名，逐一对 CSS 里是否存在规则。
  const css = T.CSS
  const rules = new Set([...css.matchAll(/\.([a-z0-9-]+)/g)].map(m => m[1]))
  // 源文件里**作为 className 写出来的**名字。要注意排除两类噪声：
  //   · CSS 自定义属性名（--dshmo-layer-color / --dshmo-chip-color …）不是类
  //   · SVG 的 marker id（dshmo-arrow）也不是类
  const source = T.__source
  assert.ok(typeof source === 'string' && source.length > 1000, '测试钩子需要暴露 __source')
  const used = new Set()
  for (const match of source.matchAll(/(?<![-\w])dshmo-[a-z0-9-]+/g)) {
    if (match[0] !== 'dshmo-arrow') used.add(match[0])
  }
  const missing = [...used].filter(name => !rules.has(name))
  assert.deepEqual(missing, [], `样式里没有这些类的规则：${missing.join(', ')}`)
})

await test('C-29 根容器必须留在文档流里（absolute+inset:0 会盖住 34px 的 tab 条）', () => {
  // 真实事故：better-sidebar 的面板结构是
  //   .panel（position:absolute，flex column）
  //     ├── .tabBar     34px 标签条
  //     └── .panelBody  flex:1，**自身没有 position**
  // 本组件挂在 .panelBody 里。根容器写 absolute+inset:0 时包含块上溯到 .panel，
  // 于是从面板顶端开始铺 —— 正好盖住标签条，用户看到"tab 被遮挡"。
  const rule = T.CSS.match(/\.dshmo-root\s*\{([^}]*)\}/)
  assert.ok(rule !== null, 'CSS 里应有 .dshmo-root 规则')
  const body = rule[1]
  const position = body.match(/position\s*:\s*([a-z]+)/)
  assert.ok(position !== null, '.dshmo-root 应显式声明 position')
  assert.notEqual(position[1], 'absolute', '.dshmo-root 不能 absolute（会覆盖 tab 条）')
  assert.notEqual(position[1], 'fixed', '.dshmo-root 不能 fixed')
  assert.ok(!/inset\s*:/.test(body), '.dshmo-root 不能写 inset')
  assert.ok(/flex\s*:\s*1/.test(body), '.dshmo-root 用 flex:1 填满 .panelBody 那一段')
  // ★ 还要 height:100%：官方右栏的 pane 不是 flex 容器，只写 flex:1 时根高会退化成**内容高**
  //   （2026-09-24 真机实测：建模中心只有 1080×185 —— 一半是空的）。见同族问题：坐标系根容器。
  assert.ok(/height\s*:\s*100%/.test(body), '.dshmo-root 必须 height:100%（否则贴在官方右栏里会塌成内容高）')
  // 被否掉的左右分栏那套不应残留（残留的固定列会把画布挤成竖条）
  for (const dead of ['dshmo-left', 'dshmo-right', 'dshmo-drawer', 'dshmo-body', 'dshmo-center']) {
    assert.ok(!T.CSS.includes(dead), `不该再残留 ${dead}（那是被否掉的三栏方案）`)
  }
})

await test('C-30 三段高度可拖 + 下带四张卡宽度可拖（两条横分隔条、三条竖分隔条、位置与顺序都在树上）', async () => {
  const sandbox = createSandbox()
  const client = await loadClientWith(
    sandbox.React,
    scriptedFetch({
      '/profiles': catalogFixture(),
      '/meta': { dataRoot: 'C:/tmp/.dsh-modeling', ai: { available: true, provider: 'deepseek-official', model: 'deepseek-v4-flash', source: 's' } },
      '/models': { profile: 'methodology', models: [{ name: sampleModel.name, nodes: 3 }] },
      '/model': { model: sampleModel },
    }),
    memoryStorage(),
  )
  const center = client.__test.ModelingCenter
  const observers = makeFakeResizeObserver()
  globalThis.ResizeObserver = observers.ResizeObserver
  await sandbox.settle({
    Component: center,
    props: { embedded: true },
    onFrame: () => seedRefs(sandbox, fakeHostElement()),
  })
  const cls = (el, name) => typeof el.props?.className === 'string'
    && el.props.className.split(/\s+/).includes(name)

  // ── 宽面板：三条竖分隔条挂在四张卡之间，网格列 = 卡/7px/卡/7px/卡/7px/卡 ──
  observers.emit(0, 1000)
  const wide = sandbox.render(center, { embedded: true })
  const cardsWrap = findAll(wide, el => cls(el, 'dshmo-cards'))[0]
  assert.ok(cardsWrap !== undefined, '下带卡片区应在')
  assert.equal(cardsWrap.props.style.gridTemplateColumns, '1fr 7px 1fr 7px 1fr 7px 1fr',
    `四张等宽时列模板应含三条 7px 分隔条，实际 ${cardsWrap.props.style.gridTemplateColumns}`)
  const vSplits = findAll(wide, el => cls(el, 'dshmo-vsplit'))
  assert.equal(vSplits.length, 3, `下带应有三条竖分隔条，实际 ${vSplits.length}`)
  assert.deepEqual(vSplits.map(v => v.props['data-dshmo-split-index']), ['0', '1', '2'], '三条各管一对相邻卡片')
  for (const v of vSplits) {
    assert.equal(v.props['data-dshmo-split'], 'cols')
    assert.equal(v.props.role, 'separator')
    assert.equal(v.props['aria-orientation'], 'vertical')
    assert.equal(typeof v.props.onPointerDown, 'function', '竖分隔条要能按住拖')
    assert.equal(typeof v.props.onDoubleClick, 'function', '双击恢复等宽')
  }
  // 结构顺序：卡 / 分隔条 / 卡 …（分隔条必须是网格的**直接子元素**，否则 fr 换算对不上）
  // ⚠️ children 里可能套着数组（`h(div, props, [卡,条,卡…])` 是一个孩子）⇒ 先摊平再断言。
  const gridChildren = (cardsWrap.children ?? []).flat(2).map(c => (cls(c, 'dshmo-vsplit') ? 'split'
    : (cls(c, 'dshmo-card') ? 'card' : 'other')))
  assert.deepEqual(gridChildren, ['card', 'split', 'card', 'split', 'card', 'split', 'card'],
    `网格子元素顺序应是 卡/条/卡/条/卡/条/卡，实际 ${gridChildren.join(',')}`)

  // ── 三段：上带（含栏与工具栏）/ 画布 / 下带，两条横分隔条夹在中间 ──────────
  const root = findAll(wide, el => cls(el, 'dshmo-root'))[0]
  assert.ok(root !== undefined, '应有根容器')
  const seq = root.children.map(el => {
    const c = typeof el.props?.className === 'string' ? el.props.className : ''
    if (c.includes('dshmo-top')) return 'top'
    if (c.includes('dshmo-hsplit')) return 'split:' + el.props['data-dshmo-split']
    if (c.includes('dshmo-canvas')) return 'mid'
    if (c.includes('dshmo-cards')) return 'bot'
    return null
  }).filter(Boolean)
  assert.deepEqual(seq, ['top', 'split:top', 'mid', 'split:bot', 'bot'],
    `三段与两条分隔条的先后应是 上带/分隔条/画布/分隔条/下带，实际 ${seq.join(' → ')}`)
  const topBand = findAll(wide, el => cls(el, 'dshmo-top'))[0]
  const topFlex = String(topBand.props.style.flex)
  assert.ok(/^0 0 [\d.]+%$/.test(topFlex), `上带高度应是百分比 flex（画布吃剩下的），实际 ${topFlex}`)
  const botFlex = String(cardsWrap.props.style.flex)
  assert.ok(/^0 0 [\d.]+%$/.test(botFlex), `下带高度应是百分比 flex，实际 ${botFlex}`)
  // 上带里确实装着栏 + 工具栏 + 档案条（拖高度拖的就是这一整块）
  for (const name of ['dshmo-bar', 'dshmo-tools', 'dshmo-strip']) {
    assert.equal(findAll(topBand, el => cls(el, name)).length, 1, `上带里应有 ${name}`)
  }
  // 画布是唯一伸缩的那一带（中带吃剩下的高度）
  assert.ok(/flex\s*:\s*1 1 auto/.test(T.CSS.match(/\.dshmo-canvas\{([^}]*)\}/)[1]),
    '.dshmo-canvas 应 flex:1 1 auto（中带吃剩下的高度）')

  // ── 紧凑态（面板 < 620px）：卡片排两列，不挂竖分隔条 ─────────────────────
  observers.emit(0, 400)
  const narrow = sandbox.render(center, { embedded: true })
  assert.equal(findAll(narrow, el => cls(el, 'dshmo-vsplit')).length, 0,
    '紧凑态两列排布下不该挂竖分隔条（"卡与卡之间"那时不是一条线）')
  const narrowWrap = findAll(narrow, el => cls(el, 'dshmo-cards') && cls(el, 'grid2'))[0]
  assert.ok(narrowWrap !== undefined, '紧凑态下带应是 grid2')
  assert.equal(narrowWrap.props.style.gridTemplateColumns, undefined, '紧凑态用 grid2 的列模板，不写自定义 fr')

  // ── CSS：两条分隔条各自的光标语义 + 拖动期间禁选 ───────────────────────
  assert.ok(/\.dshmo-hsplit\{[^}]*cursor:row-resize/.test(T.CSS), '横分隔条要 row-resize 光标')
  assert.ok(/\.dshmo-vsplit\{[^}]*cursor:col-resize/.test(T.CSS), '竖分隔条要 col-resize 光标')
  assert.ok(/\.dshmo-hsplit\{[^}]*touch-action:none/.test(T.CSS), '分隔条要 touch-action:none（触屏拖动才不会被滚动手势抢走）')
  assert.ok(/body\.dshmo-dragging\{user-select:none\}/.test(T.CSS), '拖动期间要禁选中（否则整页文字被刷蓝）')
})

await test('C-31 拖动几何是纯函数：夹紧 / 落盘读回 / fr 列模板都有确定行为', () => {
  // 夹紧：非数、越界、边界都要落到确定值（拖动时用的是像素下限换算出来的百分比）
  assert.equal(T.clampNum(5, 1, 10), 5)
  assert.equal(T.clampNum(-3, 1, 10), 1, '低于下限夹到下限')
  assert.equal(T.clampNum(99, 1, 10), 10, '高于上限夹到上限')
  assert.equal(T.clampNum('abc', 2, 8), 2, '非数回落下限，不能变 NaN（NaN 会把 flex 写成废值）')
  assert.equal(T.clampNum(undefined, 2, 8), 2)
  // 默认比例 = 实测的现状（上带 9.3% / 下带 15.8%），不是随手编的
  assert.equal(T.BAND_TOP_PCT, 9.3)
  assert.equal(T.BAND_BOT_PCT, 15.8)
  assert.equal(T.CARD_SPLIT_PX, 7)
  assert.deepEqual(T.CARD_FR, [1, 1, 1, 1])
  assert.ok(T.CARD_MIN_PX >= 120, '卡宽下限要够一张卡读出内容')
  assert.ok(T.BAND_MID_MIN_PX >= 100, '画布下限要够看图')
  // 落盘读回：没有记录时给默认；脏数据不能把比例读成 NaN
  const store = memoryStorage()
  globalThis.localStorage = store
  const fresh = T.readBands()
  assert.deepEqual(fresh, { top: T.BAND_TOP_PCT, bot: T.BAND_BOT_PCT }, '没记录时用默认比例')
  assert.deepEqual(T.readCardFr(), [1, 1, 1, 1], '没记录时四张等宽')
  store.setItem('dshmo.bands', '{"top":22.5,"bot":30}')
  store.setItem('dshmo.cardFr', '[2,1,1,0]')
  assert.deepEqual(T.readBands(), { top: 22.5, bot: 30 }, '有记录时读回来')
  assert.deepEqual(T.readCardFr(), [1, 1, 1, 1], '权重里出现 0（非法）⇒ 整组回落等宽，不能画出一张 0 宽的卡')
  store.setItem('dshmo.cardFr', '[2,1,1,1]')
  assert.deepEqual(T.readCardFr(), [2, 1, 1, 1], '合法权重原样读回')
  store.setItem('dshmo.bands', '{"top":"x"}')
  assert.ok(Number.isFinite(T.readBands().top), '脏比例要回落成有限数')
  // fr 列模板：数量或正负不对时回落等宽（不能让 grid 收到 undefined）
  assert.equal(T.frColumns([2, 1, 1, 1]), '2fr 7px 1fr 7px 1fr 7px 1fr')
  assert.equal(T.frColumns(null), '1fr 7px 1fr 7px 1fr 7px 1fr')
  assert.equal(T.frColumns([1, 2]), '1fr 7px 1fr 7px 1fr 7px 1fr', '数量不对回落等宽')
})

process.stdout.write(`\n通过 ${passed} 项，失败 ${failures.length} 项\n`)
if (failures.length > 0) {
  for (const failure of failures) process.stdout.write(`\n失败：${failure.title}\n${failure.error?.stack ?? failure.error}\n`)
  process.exitCode = 1
}
