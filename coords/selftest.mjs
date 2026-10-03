/**
 * dsh-coords host 半段自测（在 Node 里跑，不启动 DSH、不碰真实数据目录）。
 *
 * 做法：把 `lib/index.js`（构建产物）当 ESM 载入，造一个假的 cordis 上下文
 * （webServer / tools / effect / logger），跑一次 `apply()` 拿到真实注册的
 * 路由与工具定义，再直接调它们 —— 因此测的是**产物本身**，不是源码。
 *
 *   node selftest.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { deflateRawSync } from 'node:zlib'

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

/* ── 临时数据根 ────────────────────────────────────────────────────────── */

const sandbox = await mkdtemp(join(tmpdir(), 'dsh-coords-'))
process.env.DSH_COORDS_DIR = sandbox
process.env.DSH_HOME = sandbox

const mod = await import('./lib/index.js')
const internals = mod.__internals

/* ── 假 cordis 上下文 ──────────────────────────────────────────────────── */

function fakeCtx() {
  const routes = []
  const tools = []
  const disposers = []
  const ctx = {
    // host 半段按 inject 声明直读 ctx.webServer（cordis 保证注入后才可读）
    webServer: { register(route) { routes.push(route); return () => { } } },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    get(name) {
      if (name === 'tools') {
        return { register(tool) { tools.push(tool); return () => { } } }
      }
      return undefined
    },
    logger: { info() { }, warn() { } },
  }
  return { ctx, routes, tools, disposers }
}

const { ctx, routes, tools } = fakeCtx()
mod.apply(ctx)

/** 找出某条路由（按精确 path）。 */
function routeOf(path) {
  const route = routes.find(item => item.path === path)
  assert.ok(route !== undefined, `没有注册路由 ${path}`)
  return route
}

/** 直接调一个路由处理函数，回 { status, json }。 */
async function call(path, method, { query = '', body, raw } = {}) {
  const route = routeOf(path)
  const req = {
    method,
    url: path + (query === '' ? '' : `?${query}`),
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
      if (raw !== undefined) yield Buffer.from(raw)
    },
  }
  const res = {
    statusCode: 0,
    headers: null,
    chunks: [],
    writeHead(status, headers) { this.statusCode = status; this.headers = headers },
    end(chunk) { if (chunk !== undefined) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')) },
  }
  await route.handler(req, res)
  const text = Buffer.concat(res.chunks).toString('utf8')
  let json = null
  try { json = text === '' ? null : JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.statusCode, json, text }
}

/* ── 最小 xlsx 生成器（stored zip + sheet1 + sharedStrings）────────────── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 打一个 zip（deflate），只为自测 xlsx 读取路径。 */
function zip(entries) {
  const locals = []
  const central = []
  let offset = 0
  for (const [name, content] of entries) {
    const nameBuffer = Buffer.from(name, 'utf8')
    const raw = Buffer.from(content, 'utf8')
    const deflated = deflateRawSync(raw)
    const crc = crc32(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(deflated.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    locals.push(local, nameBuffer, deflated)
    const head = Buffer.alloc(46)
    head.writeUInt32LE(0x02014b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(20, 6)
    head.writeUInt16LE(0, 8)
    head.writeUInt16LE(8, 10)
    head.writeUInt32LE(crc, 16)
    head.writeUInt32LE(deflated.length, 20)
    head.writeUInt32LE(raw.length, 24)
    head.writeUInt16LE(nameBuffer.length, 28)
    head.writeUInt32LE(offset, 42)
    central.push(head, nameBuffer)
    offset += local.length + nameBuffer.length + deflated.length
  }
  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuffer, end])
}

/** 造一个两行表头的 xlsx：场景 / 价值 / 难度 / 赛道。 */
function makeXlsx() {
  const shared = ['场景', '价值', '难度', '赛道', '自动核价', '订单跟踪', 'A', 'B']
  const sharedXml = '<?xml version="1.0"?><sst xmlns="x" count="8" uniqueCount="8">'
    + shared.map(text => `<si><t>${text}</t></si>`).join('') + '</sst>'
  // 单元格：数字 = 数值单元；{s: 下标} = 共享字符串（真实 xlsx 的文本就是这样）
  const row = (r, cells) => `<row r="${r}">${cells.map((value, index) => {
    const ref = String.fromCharCode(65 + index) + r
    return (value !== null && typeof value === 'object' && value.s !== undefined)
      ? `<c r="${ref}" t="s"><v>${value.s}</v></c>`
      : `<c r="${ref}"><v>${value}</v></c>`
  }).join('')}</row>`
  const sheet = '<?xml version="1.0"?><worksheet xmlns="x"><sheetData>'
    + row(1, [{ s: 0 }, { s: 1 }, { s: 2 }, { s: 3 }])
    + row(2, [{ s: 4 }, 4.6, 2.0, { s: 6 }])
    + row(3, [{ s: 5 }, 4.2, 3.6, { s: 7 }])
    + '</sheetData></worksheet>'
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
    ['xl/sharedStrings.xml', sharedXml],
    ['xl/worksheets/sheet1.xml', sheet],
  ])
}

/* ── 用例 ──────────────────────────────────────────────────────────────── */

process.stdout.write('dsh-coords host 自测\n')

await test('H-01 路由全部注册（10 条，每个路径一条）', () => {
  const want = ['/coords/api/meta', '/coords/api/sets', '/coords/api/set', '/coords/api/templates', '/coords/api/template', '/coords/api/parse', '/coords/api/intake', '/coords/api/events', '/coords/api/open', '/coords/api/sample']
  for (const path of want) assert.ok(routes.some(route => route.path === path), `缺少 ${path}`)
  assert.equal(routes.length, want.length)
})

await test('H-01b POST /open 推一条 open 事件（脚本/排障也能唤出卡片）', async () => {
  const before = internals.events.rev
  const { status, json } = await call('/coords/api/open', 'POST', { body: { name: 'x' } })
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.ok(json.rev > before)
})

await test('H-02 工具全部注册（6 个 coords_*）', () => {
  const names = tools.map(tool => tool.name).sort()
  assert.deepEqual(names, ['coords_get', 'coords_list', 'coords_open', 'coords_read', 'coords_save', 'coords_template'])
  for (const tool of tools) {
    assert.ok(typeof tool.execute === 'function', `${tool.name} 没有 execute`)
    assert.ok(tool.parameters?.type === 'object', `${tool.name} 缺 parameters`)
  }
})

await test('H-03 GET /meta 给出模式 / 模板 / 落盘目录', async () => {
  const { status, json } = await call('/coords/api/meta', 'GET')
  assert.equal(status, 200)
  assert.equal(json.dataRoot, sandbox)
  assert.deepEqual(Object.keys(json.modes).sort(), ['2d', '3d'])
  assert.ok(json.templates.length >= 3)
  assert.ok(json.templates.some(template => template.mode === '3d'))
})

await test('H-04 越界名字仍落在数据根内（路径穿越挡住）', async () => {
  const spec = await internals.writeSet({ name: '../../evil', mode: '2d', points: [{ name: 'A', values: { x: 1, y: 2 } }] })
  const file = internals.setPath(spec.name)
  assert.equal(dirname(file), sandbox, `落到了 ${file}`)
  assert.ok(file.startsWith(sandbox))
})

await test('H-05 POST /set 落盘 → /sets 列出 → GET 读回', async () => {
  const spec = {
    name: '价值坐标-测试', mode: '2d', intent: '测一下落盘',
    axes: [{ key: 'x', name: '难度', min: 0, max: 5 }, { key: 'y', name: '价值', min: 0, max: 5 }],
    groups: [{ id: 'A', label: 'A 赛道' }],
    points: [
      { name: '自动核价', values: { x: 2, y: 4.6 }, group: 'A', note: '高价值低难度' },
      { name: '招聘管道', values: { x: 9, y: -3 }, group: 'Z' },
    ],
  }
  const saved = await call('/coords/api/set', 'POST', { body: { spec } })
  assert.equal(saved.status, 200)
  // 越界值被夹进轴范围、未知分组被补出来 —— 如实收敛，不静默丢
  assert.equal(saved.json.spec.points[1].values.x, 5)
  assert.equal(saved.json.spec.points[1].values.y, 0)
  assert.ok(saved.json.spec.groups.some(group => group.id === 'Z'))

  const list = await call('/coords/api/sets', 'GET')
  assert.equal(list.status, 200)
  assert.ok(list.json.sets.some(item => item.name === '价值坐标-测试'))

  const back = await call('/coords/api/set', 'GET', { query: `name=${encodeURIComponent('价值坐标-测试')}` })
  assert.equal(back.status, 200)
  assert.equal(back.json.spec.points.length, 2)
  assert.equal(back.json.spec.points[0].note, '高价值低难度')
})

await test('H-06 DELETE /set 真的删掉', async () => {
  await call('/coords/api/set', 'POST', { body: { name: '临时', mode: '2d', points: [] } })
  const del = await call('/coords/api/set', 'DELETE', { query: 'name=临时' })
  assert.equal(del.status, 200)
  const miss = await call('/coords/api/set', 'GET', { query: 'name=临时' })
  assert.equal(miss.status, 404)
})

await test('H-07 方法不对回 405（不是 404）', async () => {
  const { status, json } = await call('/coords/api/set', 'PATCH')
  assert.equal(status, 405)
  assert.ok(/不支持 PATCH/.test(json.error))
})

await test('H-08 CSV 解析 → 轴/分组/点名自动匹配', async () => {
  const csv = [
    '场景,业务价值,实施难度,赛道',
    '自动核价,4.6,2.0,A',
    '订单跟踪,4.2,3.6,B',
    'BOM 翻译,3.2,1.4,A',
    '工价导入,3.8,2.6,A',
  ].join('\n')
  const { status, json } = await call('/coords/api/parse', 'POST', { body: { filename: 'x.csv', text: csv, mode: '2d', name: '来自 csv' } })
  assert.equal(status, 200)
  assert.equal(json.rowCount, 4)
  assert.equal(json.spec.mode, '2d')
  assert.equal(json.spec.axes[0].name, '业务价值')
  assert.equal(json.spec.axes[1].name, '实施难度')
  assert.deepEqual(json.spec.axes[0].min !== undefined, true)
  assert.equal(json.spec.points.length, 4)
  assert.equal(json.spec.points[0].name, '自动核价')
  assert.ok(json.spec.groups.length >= 2, '赛道列应被认成分组')
})

await test('H-09 3D 解析取三根数值轴', async () => {
  const rows = [
    { 场景: 'A 场景', 范围: 3.4, 成熟度: 4.2, 适用面: 4.0, 赛道: 'A' },
    { 场景: 'B 场景', 范围: 1.6, 成熟度: 2.0, 适用面: 4.6, 赛道: 'B' },
  ]
  const { json } = await call('/coords/api/parse', 'POST', { body: { filename: 'x.json', text: JSON.stringify(rows), mode: '3d', name: '三维' } })
  assert.equal(json.spec.mode, '3d')
  assert.equal(json.spec.axes.length, 3)
  assert.equal(json.spec.axes[0].name, '范围')
  assert.equal(json.spec.axes[2].name, '适用面')
  assert.equal(json.spec.points[0].values.z, 4.0)
})

await test('H-10 markdown 表格也能认出来', async () => {
  const md = [
    '| 场景 | 价值 | 难度 |',
    '| --- | --- | --- |',
    '| 自动核价 | 4.6 | 2.0 |',
    '| 订单跟踪 | 4.2 | 3.6 |',
  ].join('\n')
  const { json } = await call('/coords/api/parse', 'POST', { body: { filename: 'x.md', text: md, mode: '2d' } })
  assert.equal(json.rowCount, 2)
  assert.equal(json.spec.axes[0].name, '价值')
})

await test('H-11 自由文本不被假装解析成功', async () => {
  const { json } = await call('/coords/api/parse', 'POST', { body: { filename: 'x.md', text: '# 一段说明\n\n这里只是一段话，没有表格。', mode: '2d' } })
  assert.equal(json.kind, 'text')
  assert.equal(json.table, null)
})

await test('H-12 xlsx 读取（自造最小 xlsx：zip + sharedStrings + sheet1）', async () => {
  const buffer = makeXlsx()
  const table = internals.tableFromXlsx(buffer)
  assert.deepEqual(table.columns, ['场景', '价值', '难度', '赛道'])
  assert.equal(table.rows.length, 2)
  assert.equal(table.rows[0][0], '自动核价')
  assert.equal(table.rows[1][1], '4.2')
  const { json } = await call('/coords/api/parse', 'POST', { body: { filename: 'x.xlsx', base64: buffer.toString('base64'), mode: '2d' } })
  assert.equal(json.rowCount, 2)
  assert.equal(json.spec.axes[0].name, '价值')
})

await test('H-13 POST /intake 把原始内容落进 _sources', async () => {
  const { status, json } = await call('/coords/api/intake', 'POST', { body: { filename: '原始.md', text: '# 内容' } })
  assert.equal(status, 200)
  assert.ok(json.path.includes('_sources'))
  const text = await readFile(json.path, 'utf8')
  assert.equal(text, '# 内容')
})

await test('H-14 /events 递增且能被 since 过滤', async () => {
  const first = await call('/coords/api/events', 'GET')
  const rev = first.json.rev
  await call('/coords/api/set', 'POST', { body: { name: '事件用', mode: '2d', points: [] } })
  const after = await call('/coords/api/events', 'GET', { query: `since=${rev}` })
  assert.ok(after.json.rev > rev)
  assert.ok(after.json.events.length >= 1)
  assert.equal(after.json.events[after.json.events.length - 1].type, 'save')
})

await test('H-15 GET /sample 给出可画的示例', async () => {
  const two = await call('/coords/api/sample', 'GET', { query: 'mode=2d' })
  assert.equal(two.json.spec.mode, '2d')
  assert.ok(two.json.spec.points.length > 0)
  const three = await call('/coords/api/sample', 'GET', { query: 'mode=3d' })
  assert.equal(three.json.spec.mode, '3d')
  assert.equal(three.json.spec.axes.length, 3)
})

await test('H-16 工具 coords_save → coords_get → coords_list', async () => {
  const save = tools.find(tool => tool.name === 'coords_save')
  const result = await save.execute({
    name: '工具落盘', mode: '3d', intent: 'agent 建的',
    axes: [
      { key: 'x', name: '范围 S', min: 0, max: 5 },
      { key: 'y', name: '成熟度 M', min: 0, max: 5 },
      { key: 'z', name: '适用面 R', min: 0, max: 5 },
    ],
    groups: [{ id: 'A', label: 'A 赛道' }],
    points: [{ name: '自动核价', values: { x: 3.4, y: 4.2, z: 4.0 }, group: 'A' }],
    source_ref: '会话里说的',
  })
  assert.equal(result.ok, true)
  assert.equal(result.points, 1)
  const get = tools.find(tool => tool.name === 'coords_get')
  const read = await get.execute({ name: '工具落盘' })
  assert.equal(read.ok, true)
  assert.equal(read.set.mode, '3d')
  assert.equal(read.set.points[0].values.z, 4.0)
  const list = tools.find(tool => tool.name === 'coords_list')
  const listed = await list.execute({})
  assert.ok(listed.sets.some(item => item.name === '工具落盘'))
})

await test('H-17 工具 coords_read 读表格并给初步匹配', async () => {
  const file = join(sandbox, '读我.csv')
  await writeFile(file, '场景,价值,难度,赛道\n自动核价,4.6,2.0,A\n订单跟踪,4.2,3.6,B\n', 'utf8')
  const read = tools.find(tool => tool.name === 'coords_read')
  const result = await read.execute({ path: file, mode: '2d' })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'table')
  assert.equal(result.rowCount, 2)
  assert.equal(result.guessed.axes[0].name, '价值')
  const missing = await read.execute({ path: join(sandbox, '不存在.csv') })
  assert.equal(missing.ok, false)
})

await test('H-17b 编号/ID 列不会被当成轴（实测踩过的坑）', async () => {
  const csv = [
    '编号,名称,范围,成熟度,适用面,赛道',
    '143,甲场景,3.4,4.2,4.0,A',
    '19,乙场景,1.6,2.0,4.6,B',
    '58,丙场景,4.8,3.1,2.2,A',
  ].join('\n')
  const { json } = await call('/coords/api/parse', 'POST', { body: { filename: 'x.csv', text: csv, mode: '3d', name: '编号列' } })
  assert.deepEqual(json.spec.axes.map(axis => axis.name), ['范围', '成熟度', '适用面'])
  // 取值也必须来自选中的那几列（不是"前三个数值列"，否则轴名与数值错位）
  assert.equal(json.spec.points[0].values.x, 3.4)
  assert.equal(json.spec.points[0].values.z, 4.0)
  assert.equal(json.spec.points[0].name, '甲场景')
})

await test('H-17c coords_read 的相对路径按会话工作目录解析', async () => {
  const dir = join(sandbox, '会话目录')
  await import('node:fs/promises').then(fs => fs.mkdir(dir, { recursive: true }))
  await writeFile(join(dir, '相对.csv'), '名称,价值,难度\n甲,4.0,2.0\n乙,3.0,1.0\n', 'utf8')
  const read = tools.find(tool => tool.name === 'coords_read')
  // 没有 exec 上下文时相对路径会落到宿主进程目录 → 读不到（如实报错）
  const without = await read.execute({ path: '相对.csv' })
  assert.equal(without.ok, false)
  // 给了会话 cwd 就能读到
  const withCwd = await read.execute({ path: '相对.csv' }, { agent: { session: { header: { cwd: dir } } } })
  assert.equal(withCwd.ok, true)
  assert.equal(withCwd.rowCount, 2)
  assert.equal(withCwd.guessed.axes[0].name, '价值')
})

await test('H-18 工具 coords_read 对自由文本给摘录而不是假装成表', async () => {
  const file = join(sandbox, '说明.md')
  await writeFile(file, '# 只有话\n\n没有表格。', 'utf8')
  const read = tools.find(tool => tool.name === 'coords_read')
  const result = await read.execute({ path: file })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'text')
  assert.ok(result.excerpt.includes('没有表格'))
})

await test('H-19 工具 coords_template：list / save / delete', async () => {
  const template = tools.find(tool => tool.name === 'coords_template')
  const saved = await template.execute({ action: 'save', id: '我的模板', label: '我的模板', name: '工具落盘' })
  assert.equal(saved.ok, true)
  const listed = await template.execute({ action: 'list' })
  assert.ok(listed.templates.some(item => item.id === '我的模板' && item.user === true))
  assert.ok(listed.templates.some(item => item.user === false), '预置模板也要在')
  const removed = await template.execute({ action: 'delete', id: '我的模板' })
  assert.equal(removed.ok, true)
  const after = await template.execute({ action: 'list' })
  assert.ok(!after.templates.some(item => item.id === '我的模板'))
})

await test('H-20 工具 coords_open 推一条 open 事件（卡片据此弹出来）', async () => {
  const open = tools.find(tool => tool.name === 'coords_open')
  const before = internals.events.rev
  const result = await open.execute({ name: '价值坐标-测试' })
  assert.equal(result.ok, true)
  assert.ok(internals.events.rev > before)
  assert.equal(internals.events.list[internals.events.list.length - 1].type, 'open')
})

await test('H-21 体检如实列问题（不粉饰）', () => {
  const spec = internals.normalizeSpec({
    mode: '2d', name: 'x',
    axes: [{ key: 'x', name: 'X 维度', min: 0, max: 5 }, { key: 'y', name: 'Y 维度', min: 0, max: 5 }],
    points: [{ name: '点 1', values: { x: 1, y: 1 } }, { name: '点 2', values: { x: 1, y: 1 } }],
  })
  const issues = internals.auditSpec(spec)
  assert.ok(issues.length >= 2, `体检应当至少报两条，实际 ${issues.length}`)
  assert.ok(issues.some(issue => /占位名/.test(issue.text)))
  assert.ok(issues.some(issue => /同一处/.test(issue.text)))
})

await test('H-22 破损文件不崩：列表里标 broken', async () => {
  await writeFile(join(sandbox, '坏文件.json'), '{ 这不是 JSON', 'utf8')
  const { json } = await call('/coords/api/sets', 'GET')
  assert.ok(json.sets.some(item => item.name === '坏文件' && item.broken === true))
})

await test('H-23 响应头 no-store（每次都是新的图）', async () => {
  const route = routeOf('/coords/api/meta')
  const req = { method: 'GET', url: '/coords/api/meta', headers: {}, async *[Symbol.asyncIterator]() { } }
  const res = { writeHead(status, headers) { this.status = status; this.headers = headers }, end() { } }
  await route.handler(req, res)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.ok(String(res.headers['content-type']).startsWith('application/json'))
})

/* ── 收尾 ──────────────────────────────────────────────────────────────── */

await rm(sandbox, { recursive: true, force: true })
process.stdout.write(`\n${passed} PASS / ${failures.length} FAIL\n`)
if (failures.length > 0) {
  for (const failure of failures) process.stdout.write(`  ✗ ${failure.title}: ${failure.error?.stack ?? failure.error}\n`)
  process.exitCode = 1
}
