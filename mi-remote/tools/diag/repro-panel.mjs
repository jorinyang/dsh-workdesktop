// repro-panel.mjs — 用**真 React** 渲染面板，复现那个被 slot 系统吞掉的渲染错误。
//
// 背景：inspect 显示我的注册 active:false —— slot 系统的 `abdicated` 机制把"渲染时崩过的条目"
// 退位了，而且只通知内部监听者、不冒到 window.onerror，所以错误上报什么都收不到。
// verify-render 用的是自造桩 React，测不出真实 React 才会触发的问题；这里换成真货。
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const req = createRequire('D:/deepseek-harness/apps/web/package.json')
const React = req('react')
const Server = req('react-dom/server')
console.log('react', React.version)

const noop = () => {}
const fakeElement = () => ({
  style: {}, dataset: {}, appendChild: noop, addEventListener: noop, removeEventListener: noop,
  remove: noop, setAttribute: noop, querySelector: () => null, querySelectorAll: () => [],
})
const doc = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: fakeElement,
  addEventListener: noop, removeEventListener: noop,
  head: fakeElement(), body: fakeElement(),
  documentElement: { lang: 'zh-CN' },
}
const windowStub = {
  __ModuleLoader__: {
    load(entry) {
      const module = { exports: {} }
      module.exports = entry.factory((id) => (id === 'react' ? React : {}))
      windowStub.__plugin = module.exports
    },
  },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  setTimeout, clearTimeout, setInterval, clearInterval,
  addEventListener: noop, removeEventListener: noop,
  document: doc,
  navigator: { language: 'zh-CN' },
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, mapping: { version: 1, buttons: {}, vkeys: {} }, link: {}, presets: [] }) }),
  getComputedStyle: () => ({ display: 'flex', flexDirection: 'column' }),
}

const sandbox = {
  window: windowStub, document: doc, navigator: windowStub.navigator, console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  fetch: windowStub.fetch, Promise, Object, Array, JSON, Math, String, Number, Boolean, Error,
  RegExp, Date, Map, Set, Symbol, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
}

new Function(...Object.keys(sandbox), readFileSync('lib/client.js', 'utf8'))(...Object.keys(sandbox).map((k) => sandbox[k]))
const plugin = windowStub.__plugin
console.log('client 加载:', plugin !== null && typeof plugin.apply === 'function')

const slots = []
const ctx = {
  get: (name) => {
    if (name === 'sidebarRightTabs') return { register: (o) => { slots.push({ options: o, from: 'tabs' }); return noop } }
    if (name === 'sidebarRight') return { openTab: noop }
    return undefined
  },
  effect: (fn) => { const off = fn(); return typeof off === 'function' ? off : noop },
  slots: { inject: (k, cb) => cb(), register: (o, c) => { slots.push({ options: o, Component: c }); return noop } },
  interval: () => noop,
}
try { plugin.apply(ctx) } catch (error) { console.log('apply 抛错:', String(error && error.message)) }

const paneReg = slots.find((r) => r.options && r.options.name === 'sidebar.right.pane.tab')
const footerReg = slots.find((r) => r.options && r.options.name === 'sidebar.footer.action')
console.log('注册到的席位: tabs=' + slots.filter((r) => r.from === 'tabs').length +
  ' · pane=' + (paneReg !== undefined) + ' · footer=' + (footerReg !== undefined))

function tryRender(label, Component) {
  if (Component === undefined) { console.log(label + ': 没有组件可渲染'); return }
  try {
    const html = Server.renderToString(React.createElement(Component, {}))
    console.log(label + ': ✓ 渲染成功 · ' + html.length + ' 字节')
  } catch (error) {
    console.log('★★★ ' + label + ' 渲染抛错 ★★★')
    console.log('  ' + String(error && error.message))
    const stack = String((error && error.stack) || '').split('\n')
    for (const line of stack.slice(1, 12)) console.log('  ' + line.trim())
  }
}

if (paneReg !== undefined) tryRender('面板（pane.tab）', paneReg.Component)
