/**
 * 构建产物体检 —— 在跑任何功能用例之前，先确认 `lib/` 是可信的。
 *
 * 为什么需要：`lib/index.js` 由 `scripts/build.mjs` 从 `src/` 生成。构建脚本
 * 的"剥 ESM 语法"一旦多吃了源码，产物**依然语法合法**，只是少了一批符号 ——
 * 此时所有功能用例都会以 `Cannot read properties of undefined` 这种误导性方式
 * 失败，看不出根因。所以把"产物结构"作为第一类断言单独拎出来。
 *
 * 用法：node selftest-build.mjs
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

process.stdout.write('dsh-modeling 构建产物体检\n')

const host = await import('./lib/index.js')

await test('B-1 host 入口导出了 Cordis 需要的具名成员', () => {
  assert.equal(host.name, 'dsh-modeling')
  assert.deepEqual(host.inject, ['webServer'])
  assert.equal(typeof host.apply, 'function')
})

await test('B-2 host 内联源依赖的 node 内置符号都还在（构建没吞源码）', () => {
  // dataRoot 用到 resolve / join / homedir；pathOf 用到 sep；都是 file:// 内置
  assert.ok(host.__internals.dataRoot().length > 0)
  const path = host.__internals.pathOf('methodology', '体检')
  assert.match(path, /\.json$/)
})

await test('B-3 __internals 的内部面齐全', () => {
  for (const key of ['ROUTE', 'dataRoot', 'pathOf', 'slugOf', 'listModels', 'readModel',
    'writeModel', 'deleteModel', 'extractJson', 'buildSystemPrompt', 'draftBrief',
    'emptyModel', 'nodeTypeOf', 'orientationOf', 'attrKeys', 'attrLabel']) {
    assert.ok(host.__internals[key] !== undefined, `缺少 ${key}`)
  }
  assert.equal(host.__internals.ROUTE, '/modeling/api')
})

await test('B-4 浏览器产物存在且是模块加载器形状（无 ESM 语法）', async () => {
  const client = await readFile(join(here, 'lib', 'client.js'), 'utf8')
  assert.ok(client.includes('window.__ModuleLoader__.load('), '缺少模块加载器注册')
  assert.ok(client.includes("id: 'dsh-modeling'"), '缺少模块 id')
  assert.ok(client.includes('sidebarRightTabs'), '缺少官方右栏 tab 类型的注册调用')
  assert.ok(client.includes("'sidebar.right.pane.tab'"), '缺少键控席位 sidebar.right.pane.tab 的正文注册')
  assert.ok(client.includes('key: PANEL_ID'), '正文 key 必须引用常量 PANEL_ID')
  assert.ok(client.includes('ModelingCenter'), '正文内容应是建模中心组件')
  assert.ok(client.includes('iconModeling'), '图标函数应保留（入口图标在 dsh-workdesktop 的四行里）')
  assert.ok(/const inject = \['slots', 'timer'\]/.test(client), "缺少 inject 声明（应为 ['slots','timer']）")
  assert.ok(!/^\s*(import|export)\b/m.test(client), '浏览器产物里不该有 ESM 语法（工厂内联，无法解析相对导入）')
  assert.ok(!client.includes('__INLINE_'), '占位符没替换干净')
})

await test('B-5 产物里没有把宿主模块名硬编码成相对路径（客户端不 import 任何东西）', async () => {
  const client = await readFile(join(here, 'lib', 'client.js'), 'utf8')
  const body = client.slice(client.indexOf('factory: (require)'))
  assert.ok(!/\bimport\s*\(/.test(body), '工厂里出现了动态 import')
  assert.ok(!/\brequire\(['"]\./.test(body), '工厂里出现了相对 require')
})

await test('B-6 产物里的路由注册是「每路径一条」（防启动崩溃回归）', async () => {
  // 这条守卫 2026-09-16 那次真实事故：webServer.register 用 (kind, path) 判重、
  // **不看 method**，所以同一路径注册多条 → 抛 duplicate exact route →
  // 整棵插件树 boot 失败（dsh web 退出码 1，profile 的 bundle 行还被自动摘掉）。
  const source = await readFile(join(here, 'lib', 'index.js'), 'utf8')
  const matches = source.match(/\['(\/[a-z]+)', \['[A-Z', ]+'\]\]/g) ?? []
  const paths = matches.map(item => item.match(/'(\/[a-z]+)'/)[1])
  assert.equal(paths.length, 6, `应有 6 条路由声明，实际 ${paths.join(', ')}`)
  assert.equal(new Set(paths).size, paths.length, `路径不得重复：${paths.join(', ')}`)
  assert.ok(source.includes('req.method'), 'handler 必须自己按 req.method 分发')
  assert.ok(source.includes('405'), '不支持的方法应回 405')
})

await test('B-7 客户端直读的每个 ctx.<名字> 都必须在 inject 里声明（或由它授权）', async () => {
  // 守卫 2026-09-16 的第二次事故：客户端用了 ctx.interval() 却没把 'timer'
  // 列进 inject，运行时抛 `cannot get property "interval" without inject`
  // → 客户端整棵树 "Failed to load plugins"。
  //
  // 规则有两层，别把第二层漏掉：
  //   ① `ctx.<service>` 直读 → 该 service 必须出现在 inject；
  //   ② 服务可以用 `ctx.mixin(name, [方法…])` 往 Context 上混方法 —— 声明
  //      `timer` 正是**授权** `ctx.interval/timeout/throttle/debounce/
  //      setTimeout/setInterval` 的方式，所以这些名字算"已声明"。
  const client = await readFile(join(here, 'lib', 'client.js'), 'utf8')
  const declared = new Set(['slots', 'timer'])
  // 由 inject 授权的 mixin 方法（见 @deepseek-ai/cordis-plugin-timer 的
  // `ctx.mixin('timer', [...])`）
  const mixed = new Set(['interval', 'timeout', 'throttle', 'debounce', 'setTimeout', 'setInterval'])
  // cordis Context 自带、无需 inject 的成员（fiber 生命周期、事件、mixin 工具）
  const builtin = new Set([
    'effect', 'get', 'inject', 'provide', 'isolate', 'on', 'once', 'off', 'emit',
    'parallel', 'emitAsync', 'bail', 'start', 'stop', 'logger', 'scope', 'fiber',
    'mixin', 'set', 'setInterval', 'setTimeout',
  ])
  // 只看**代码路径**上的直读：字符串字面量里的示意写法（如
  // console.warn('… ctx.betterSidebar …')）与整行注释都要排除。
  const codeOnly = client
    .split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
  const reads = new Set()
  for (const match of codeOnly.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) {
    // 该名字之前最近的引号若未闭合，说明它在字符串字面量里 → 不是直读
    const before = codeOnly.slice(Math.max(0, match.index - 240), match.index)
    const quotes = (before.match(/['"`]/g) ?? []).length
    if (quotes % 2 === 1) continue
    reads.add(match[1])
  }
  const undeclared = [...reads]
    .filter(name => !declared.has(name) && !mixed.has(name) && !builtin.has(name))
  assert.deepEqual(undeclared, [], `这些 ctx 直读既没写进 inject、也不是自带成员：${undeclared.join(', ')}`)
  // 反向护栏：声明了 timer 就得真的用到它，否则是死声明
  assert.ok(/ctx\.(interval|timeout|throttle|debounce)/.test(client), 'inject 声明了 timer 却没用到')
})

process.stdout.write(`\n通过 ${passed} 项，失败 ${failures.length} 项\n`)
if (failures.length > 0) {
  for (const failure of failures) process.stdout.write(`\n失败：${failure.title}\n${failure.error?.stack ?? failure.error}\n`)
  process.exitCode = 1
}
