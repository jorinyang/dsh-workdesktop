/**
 * dsh-modeling host 半段自测（不需要 DSH 在跑，不碰真实数据目录）。
 *
 * 覆盖：落盘 / 读回 / 列表 / 删除 / 路径穿越防护 / AI 输出的 JSON 抽取 /
 * 生成提示是否带上档案真实词汇 / 路由注册契约 / 生成端点的降级报错。
 *
 *   node selftest.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const TMP = await mkdtemp(join(tmpdir(), 'dsh-modeling-test-'))
process.env.DSH_MODELING_DIR = TMP

const host = await import('./lib/index.js')
const model = await import('./src/modeling.mjs')
const { __internals: inner } = host

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

process.stdout.write('dsh-modeling host 半段自测\n')

// ── 1. 模型代数 ───────────────────────────────────────────────────────────
await test('H-1 词汇表自洽：三个档案都在同一条 5 层抽象轴上', () => {
  assert.equal(model.AXIS.length, 5)
  for (const profile of model.PROFILES) {
    assert.equal(profile.layers.length, 5, `${profile.id} 的层数`)
    for (const [type, def] of Object.entries(profile.nodeTypes)) {
      assert.ok(['declarative', 'procedural'].includes(def.orientation), `${profile.id}.${type} 朝向`)
      for (const attr of def.attrs) assert.ok(model.ATTR_FIELDS[attr] !== undefined, `${type}.${attr} 不在属性表里`)
    }
  }
})

await test('H-2 抽象层即列：同层节点落同一 x，跨层递增', () => {
  const draft = model.normalizeModel({
    profile: 'methodology',
    nodes: [
      { id: 'a', name: 'A', level: 0, type: 'issue' },
      { id: 'b', name: 'B', level: 1, type: 'principle' },
      { id: 'c', name: 'C', level: 1, type: 'criterion' },
      { id: 'd', name: 'D', level: 3, type: 'activity' },
    ],
    edges: [{ from: 'a', to: 'b', type: 'flows' }],
  }, 'methodology')
  const laid = model.layoutModel(draft, { force: true })
  assert.equal(laid.positions.a.x, laid.positions.b.x - 260, 'L0 应在 L1 左边一列')
  assert.equal(laid.positions.b.x, laid.positions.c.x, '同层同列')
  assert.notEqual(laid.positions.b.y, laid.positions.c.y, '同层不同行')
  assert.ok(laid.positions.d.x > laid.positions.b.x)
})

await test('H-2b 手工摆放的坐标永远优先（画布热路径必须保住拖拽结果）', () => {
  const draft = model.normalizeModel({
    profile: 'methodology',
    nodes: [
      { id: 'a', name: '拖过的', level: 0, type: 'issue', x: 500, y: 700 },
      { id: 'b', name: '没摆过的', level: 0, type: 'principle' },
    ],
    edges: [],
  }, 'methodology')
  const laid = model.layoutModel(draft)
  assert.deepEqual(laid.positions.a, { x: 500, y: 700 }, '非 force 时保留手工坐标')
  assert.equal(laid.positions.b.x, 40, '没摆过的按 L0 第一列落位')
  assert.notEqual(laid.positions.b.y, 700, '未摆放的节点走自动排位，不跟着手工坐标走')
  // force 也不该抹掉手工坐标：整图重排必须由调用方先清空坐标再调（见静态布局说明）
  const forced = model.layoutModel(draft, { force: true })
  assert.deepEqual(forced.positions.a, { x: 500, y: 700 }, 'force 依然不抹手工坐标')
  // 客户端"整理布局"的做法：先清空再 force → 全部回到网格
  const cleared = { ...draft, nodes: draft.nodes.map(node => ({ ...node, x: null, y: null })) }
  const reflowed = model.layoutModel(cleared, { force: true })
  assert.equal(reflowed.positions.a.x, 40, '清空后重排回到 L0 网格')
  assert.equal(reflowed.positions.a.y, reflowed.positions.b.y - 96, '同层按 y 依次排开')
})

await test('H-3 规范化：越界层被收敛、非法类型回落、悬空边被丢弃、属性被塑形', () => {
  const draft = model.normalizeModel({
    profile: 'system',
    nodes: [
      { id: 'a', name: '甲', level: 99, type: '不存在的类型', attrs: { steps: '一\n二', principle: '', notes: 5 } },
      { id: 'b', name: '乙', level: 3, type: 'table', attrs: { artifacts: ['x.sql'] } },
    ],
    edges: [
      { from: 'a', to: 'b', type: '不存在的边' },
      { from: 'a', to: 'zzz' },
      { from: 'a', to: 'a' },
    ],
  }, 'system')
  assert.equal(draft.nodes[0].level, 4, 'level 99 → 收敛到 4')
  // 回落的是**收敛后那一层**的默认类型：层被改了类型必须跟着层走，
  // 否则会留下"L4 上的 L1 类型"这种自相矛盾的节点。
  assert.equal(draft.nodes[0].type, 'domain', '未知类型 → 收敛后那层的默认类型')
  assert.deepEqual(draft.nodes[0].attrs.steps, ['一', '二'], '数组属性按行切')
  assert.equal(draft.nodes[0].attrs.principle, undefined, '空值不落库')
  assert.equal(draft.nodes[0].attrs.notes, '5', '数值被塑形成字符串')
  assert.equal(draft.edges.length, 1, '悬空边与自环被丢弃')
  assert.equal(draft.edges[0].type, 'relates', '未知边类型回落关联')
})

// ── 2. 落盘层 ─────────────────────────────────────────────────────────────
await test('H-4 写 / 读 / 列表 / 删除：一个模型一个文件', async () => {
  const draft = model.normalizeModel({
    profile: 'methodology',
    name: '从零到交付',
    intent: '把做法讲到第二个人能照着做',
    nodes: [{ id: 'a', name: '议题', level: 0, type: 'issue' }],
    edges: [],
  }, 'methodology')
  const saved = await inner.writeModel(draft)
  const file = inner.pathOf('methodology', '从零到交付')
  const raw = await readFile(file, 'utf8')
  assert.ok(raw.includes('从零到交付'), '落盘内容含中文原名')
  assert.equal(await inner.readModel('methodology', '从零到交付') !== null, true)
  assert.equal(inner.pathOf('methodology', '从零到交付').startsWith(TMP), true, '落在数据根内')
  const list = await inner.listModels('methodology')
  assert.equal(list.length, 1)
  assert.equal(list[0].name, '从零到交付')
  assert.equal(list[0].nodes, 1)
  assert.ok(list[0].updatedAt >= saved.createdAt)
  await inner.deleteModel('methodology', '从零到交付')
  assert.equal(await inner.readModel('methodology', '从零到交付'), null)
  assert.equal((await inner.listModels('methodology')).length, 0)
})

await test('H-5 模型名里的斜杠不会变成目录穿越', async () => {
  const draft = model.normalizeModel({ profile: 'system', name: '../../逃逸', nodes: [], edges: [] }, 'system')
  const saved = await inner.writeModel(draft)
  const file = inner.pathOf('system', saved.name)
  assert.ok(file.startsWith(join(TMP, 'system')), `必须仍在档案目录内，实际 ${file}`)
  const escaped = join(TMP, '..', '逃逸.json')
  assert.notEqual(file, escaped)
  // 名字里的分隔符被替换成 __，落盘后仍能读回
  assert.equal((await inner.readModel('system', saved.name))?.name, saved.name)
  await inner.deleteModel('system', saved.name)
})

await test('H-6 读不存在的模型返回 null（不抛）', async () => {
  assert.equal(await inner.readModel('methodology', '并不存在'), null)
})

await test('H-7 损坏的 JSON 出现在列表里但不炸列表', async () => {
  const broken = inner.pathOf('process', '坏文件')
  await mkdir(dirname(broken), { recursive: true })
  await writeFile(broken, '{ 这不是 json', 'utf8')
  const list = await inner.listModels('process')
  assert.equal(list.length, 1)
  assert.equal(list[0].broken, true)
  await rm(broken, { force: true })
})

// ── 3. AI 生成 ────────────────────────────────────────────────────────────
await test('H-8 JSON 抽取：容忍代码围栏与前后废话', () => {
  const parsed = inner.extractJson('好的，这是模型：\n```json\n{"nodes":[{"id":"n1"}]}\n```\n希望有帮助')
  assert.equal(parsed.nodes[0].id, 'n1')
  assert.equal(inner.extractJson('{"a":1}').a, 1)
  assert.throws(() => inner.extractJson('完全没有 JSON'), /没有返回 JSON/)
})

await test('H-9 生成提示带上了当前档案的真实词汇与朝向规则', () => {
  const profile = model.PROFILES.find(item => item.id === 'methodology')
  const prompt = inner.buildSystemPrompt(profile, 2)
  assert.ok(prompt.includes('研究方法论'), '含档案名')
  assert.ok(prompt.includes('L3 抽象层「规程」'), '含层本地词汇')
  assert.ok(prompt.includes('activity('), '含节点类型 id')
  assert.ok(prompt.includes('flows('), '含连边类型 id')
  assert.ok(prompt.includes('principle('), '含属性 facet id')
  assert.ok(prompt.includes('声明式回答'), '含朝向规则')
  assert.ok(prompt.includes('本次重点'), '指定层时提示重点')
})

await test('H-10 每个档案都能生成提示且不抛', () => {
  for (const profile of model.PROFILES) {
    const prompt = inner.buildSystemPrompt(profile, undefined)
    assert.ok(prompt.length > 200, `${profile.id} 提示过短`)
  }
})

await test('H-11 无 llm 服务时 /generate 返回可读报错而不是崩', async () => {
  const ctx = fakeCtx({})
  const handler = collect(ctx)
  const response = await handler( 'POST', '/generate', { profile: 'methodology', brief: '测试议题' })
  assert.equal(response.status, 500)
  assert.match(response.body.error, /llm 服务/)
})

await test('H-12 空 brief 被拒（并给行动指引）', async () => {
  const ctx = fakeCtx({})
  const handler = collect(ctx)
  const response = await handler( 'POST', '/generate', { profile: 'methodology', brief: '   ' })
  assert.equal(response.status, 400)
  assert.match(response.body.error, /先写一句/)
})

await test('H-13 假 llm 服务：一次完整生成 → 规范化 → 分层落位', async () => {
  const chunks = [
    { type: 'text-delta', text: '{"name":"交付方法论","intent":"让人能照着做",' },
    { type: 'text-delta', text: '"nodes":[{"id":"n1","name":"议题","level":0,"type":"issue"},' },
    { type: 'text-delta', text: '{"id":"n2","name":"原则","level":1,"type":"principle"},' },
    { type: 'text-delta', text: '{"id":"n3","name":"规程","level":3,"type":"activity","attrs":{"steps":["甲","乙"]}}],' },
    { type: 'text-delta', text: '"edges":[{"from":"n1","to":"n2","type":"flows"},{"from":"n2","to":"n3","type":"realizes"}]}' },
    { type: 'finish', reason: 'stop' },
  ]
  const ctx = fakeCtx({ llm: { stream: () => asyncIterable(chunks), listProviders: () => [{ provider: 'fake' }] } })
  const handler = collect(ctx)
  const response = await handler( 'POST', '/generate', { profile: 'methodology', brief: '从零到交付的做法' })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  const draft = response.body.model
  assert.equal(draft.nodes.length, 3)
  assert.equal(draft.edges.length, 2)
  assert.deepEqual(draft.nodes[2].attrs.steps, ['甲', '乙'])
  assert.equal(response.body.provider, 'deepseek-official')
  // 每个节点都被落了坐标，且按层分列
  const xs = new Set(draft.nodes.map(node => node.x))
  assert.equal(xs.size, 3, '三个不同层应是三个不同 x')
  for (const node of draft.nodes) assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y))
})

await test('H-14 /draft 模板引用当前档案的层词汇', async () => {
  const ctx = fakeCtx({})
  const handler = collect(ctx)
  const response = await handler( 'GET', '/draft?profile=process', null)
  assert.equal(response.status, 200)
  assert.ok(response.body.brief.includes('阶段'), '含 process 档案的 L2 词汇')
})

// ── 4. 路由注册契约 ───────────────────────────────────────────────────────
await test('H-15 apply 把 6 条 /modeling/api 路由挂上 webServer（每路径一条、按 req.method 分发），且全部挂在 fiber 上可回收', async () => {
  const registered = []
  const disposers = []
  const ctx = {
    webServer: {
      // 与真实 webServer 同款判重：同一 (kind, path) 只能注册一条 —— 现行方案
      // 是每路径挂一条、handler 按 req.method 分发（旧版「一个方法一条注册」
      // 会撞上这条判重，导致 2026-09-16 的启动崩溃）。
      register: (route) => {
        const key = `${route.kind} ${route.path}`
        if (registered.some(item => `${item.kind} ${item.path}` === key)) {
          throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
        }
        registered.push(route); const off = () => {}; disposers.push(off); return off
      },
    },
    effect: (fn) => { const off = fn(); return typeof off === 'function' ? off : () => {} },
    logger: { info: () => {} },
  }
  host.apply(ctx)
  const paths = registered.map(route => `${route.kind} ${route.path}`)
  for (const want of [
    'exact /modeling/api/profiles', 'exact /modeling/api/meta', 'exact /modeling/api/draft',
    'exact /modeling/api/models', 'exact /modeling/api/model', 'exact /modeling/api/generate',
  ]) assert.ok(paths.includes(want), `缺路由 ${want}`)
  assert.equal(registered.length, 6, '每路径一条；/model 的 GET/POST/DELETE 由 handler 按 req.method 分发')
  for (const route of registered) assert.equal(typeof route.handler, 'function')
  assert.equal(disposers.length, 6, '全部挂在 fiber 上可回收')
  // 分发冒烟：路径存在但方法不对 → 405（不是 404），且不能命中别的分支
  const modelRoute = registered.find(route => route.path === '/modeling/api/model')
  const response = capture()
  await modelRoute.handler({ url: '/modeling/api/model', method: 'PATCH', headers: {} }, response.res)
  const outcome = response.result()
  assert.equal(outcome.status, 405, 'PATCH /model 应落 405')
  assert.match(outcome.body.error, /不支持 PATCH/)
})

// ── 5. 导出 ───────────────────────────────────────────────────────────────
await test('H-16 Markdown 导出：五层分节 + 属性 + 关系清单', () => {
  const draft = model.normalizeModel({
    profile: 'methodology',
    name: '导出测试',
    intent: '验证导出',
    nodes: [
      { id: 'a', name: '议题', level: 0, type: 'issue', desc: '背景', attrs: { boundary: '不做 X' } },
      { id: 'b', name: '交付物', level: 4, type: 'deliverable', attrs: { deliverable: '一份 SOP', template: ['模板一'], criterion: '第二个人能独立跑通' } },
    ],
    edges: [{ from: 'a', to: 'b', type: 'produces', label: '产出' }],
  }, 'methodology')
  const md = model.toMarkdown(draft)
  assert.ok(md.startsWith('# 导出测试'))
  assert.ok(md.includes('## L0 议题'))
  assert.ok(md.includes('## L4 产物'))
  assert.ok(md.includes('- 边界：不做 X'))
  assert.ok(md.includes('  - 模板一'), '数组属性逐条展开')
  assert.ok(md.includes('**议题** —产生（产出）→ **交付物**'))
})

await test('H-17 Mermaid 导出：层作为 subgraph，过程边用箭头', () => {
  const draft = model.normalizeModel({
    profile: 'process',
    name: 'M',
    nodes: [
      { id: 'a', name: '触发', level: 0, type: 'trigger' },
      { id: 'b', name: '阶段一', level: 2, type: 'phase' },
    ],
    edges: [{ from: 'a', to: 'b', type: 'flows' }],
  }, 'process')
  const mmd = model.toMermaid(draft)
  assert.ok(mmd.startsWith('flowchart LR'))
  assert.ok(mmd.includes('subgraph L0["触发"]'))
  assert.ok(mmd.includes('-->'), '过程边是箭头')
})

await test('H-18 体检：空层、孤点、缺判据的产出节点都被指出', () => {
  const draft = model.normalizeModel({
    profile: 'methodology',
    name: 'T',
    nodes: [
      { id: 'a', name: '孤点', level: 0, type: 'issue' },
      { id: 'b', name: '交付物', level: 4, type: 'deliverable' },
    ],
    edges: [],
  }, 'methodology')
  const issues = model.auditModel(draft)
  assert.ok(issues.some(issue => issue.text.includes('缺') === false && issue.text.includes('判据')), '指出产出节点缺判据')
  assert.ok(issues.some(issue => issue.text.includes('孤点')))
  assert.ok(issues.some(issue => issue.text.includes('空')), `指出空层，实际：${issues.map(i => i.text).join(' / ')}`)
})

// ── 收尾 ──────────────────────────────────────────────────────────────────
await rm(TMP, { recursive: true, force: true })
process.stdout.write(`\n通过 ${passed} 项，失败 ${failures.length} 项\n`)
if (failures.length > 0) {
  for (const failure of failures) process.stdout.write(`\n失败：${failure.title}\n${failure.error?.stack ?? failure.error}\n`)
  process.exitCode = 1
}

/* ── 测试用替身 ──────────────────────────────────────────────────────── */

/** 构造一个够用的 ctx 替身（只需 webServer / llm / agentDefaultModel / effect / logger）。 */
function fakeCtx(services) {
  const store = { ...services }
  return {
    ...store,
    get: (name) => store[name],
    effect: (fn) => { const off = fn(); return typeof off === 'function' ? off : () => {} },
    logger: { info: () => {} },
  }
}

/**
 * 在给定的服务替身上挂一个会记录路由的 webServer，跑 apply，返回调用入口。
 * @param ctx 由 fakeCtx(...) 造出来的上下文替身（本函数会补上 webServer）
 */
function collect(ctx) {
  const routes = []
  ctx.webServer = { register: (route) => { routes.push(route); return () => {} } }
  host.apply(ctx)
  return async (method, path, body) => {
    const route = routes.find(item => item.path === `/modeling/api${path.split('?')[0]}`)
    if (route === undefined) throw new Error(`没有注册路由 ${path}`)
    const response = capture()
    const request = {
      url: path,
      method,
      headers: { 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() {
        if (body !== null && body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
      },
    }
    await route.handler(request, response.res)
    return response.result()
  }
}
/** 一个只有 statusCode/writeHead/end 的最小响应替身。 */
function capture() {
  let status = 200
  let text = ''
  return {
    res: {
      set statusCode(value) { status = value },
      get statusCode() { return status },
      writeHead(code) { status = code },
      end(chunk) { if (chunk !== undefined) text += String(chunk) },
    },
    result() {
      let body = null
      try { body = JSON.parse(text) } catch { body = { raw: text } }
      return { status, body }
    },
  }
}

/** 同步数组 → 异步可迭代（模拟 llm.stream）。 */
function asyncIterable(items) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item
    },
  }
}
