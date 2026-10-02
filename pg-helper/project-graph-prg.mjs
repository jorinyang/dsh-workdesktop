/**
 * 工程图 `.prg` 容器编解码（**零依赖**，只用 `node:zlib`）
 *
 * 上游 CLI 的 29 条工具覆盖的是"节点/连线"那一层；`.prg` 文档本身还有容器层的内容
 * （`metadata.msgpack` / `attachments/` / 序列化器认得的全部舞台对象类型）。
 * 这一层 CLI 没有工具，所以这里按 https://graphif.dev/docs/spec/prg 自己实现。
 *
 * ── 格式（照规范逐条对齐）────────────────────────────────────────────────
 *   · `.prg` **必须是合法 ZIP**；条目路径用 `/`；文件名 UTF-8。
 *   · 根目录 **必须有** `metadata.msgpack`，且 **至少有** `stage.msgpack` 或 `extension.js` 之一。
 *   · `metadata.msgpack` = MessagePack 序列化的对象，至少含 `version`（语义化版本字符串）。
 *   · `stage.msgpack`   = MessagePack 序列化的**数组**，每项是一个"舞台对象"，
 *                         每项至少含 `uuid`；其余字段由 Graphif 序列化器规范定义
 *                         （形状是 `{ _: '类名', …字段 }`，同实例用 `{ $: '路径' }` 复用）。
 *   · `attachments/<uuid>.<ext>` = 附件；舞台对象用 **不带扩展名的 uuid 字符串**引用它。
 *
 * ── 这个实现**不假装**是完整实现（诚实清单）────────────────────────────────
 *   · **不做** 序列化器的类还原：解出来的是**纯对象树**，不是「Section / TextNode 实例」。
 *     写回时按纯对象原样编码，因此**只改字段、不改形状**的操作是安全的；
 *     想"新建一个 TextNode"就得自己拼出与序列化器完全一致的形状 —— 那是另一件事，没做。
 *   · **不做** `sub/` 子舞台、`versions/`、`settings.msgpack`（规范里都还是"未来考虑"一节）。
 *   · ZIP 只处理 **stored(0)** 与 **deflate(8)** 两种压缩法（上游就这两种）；
 *     别的一律如实报错，不猜。
 *   · 规范 6.1 的体积上限（1000 条目 / 单文件 200MB / 总计 500MB）在这里**默认执行**，
 *     可用 options 放宽 —— 压缩炸弹不该由调用方记得防。
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib'

/* ── MessagePack ────────────────────────────────────────────────────────── */

/** 编码：只覆盖 stage/metadata 里真实出现的类型；不认识的类型如实抛错。 */
export function msgpackEncode(value) {
  const chunks = []
  write(value, chunks)
  return Buffer.concat(chunks)
}

function write(value, out) {
  if (value === null || value === undefined) { out.push(Buffer.from([0xc0])); return }
  if (value === true) { out.push(Buffer.from([0xc3])); return }
  if (value === false) { out.push(Buffer.from([0xc2])); return }
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) {
      if (value >= 0 && value < 128) { out.push(Buffer.from([value])); return }
      if (value < 0 && value >= -32) { out.push(Buffer.from([0xe0 | (value + 32)])); return }
      if (value >= 0) {
        if (value <= 0xff) { out.push(Buffer.from([0xcc, value])); return }
        if (value <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xcd; b.writeUInt16BE(value, 1); out.push(b); return }
        if (value <= 0xffffffff) { const b = Buffer.alloc(5); b[0] = 0xce; b.writeUInt32BE(value, 1); out.push(b); return }
        const b = Buffer.alloc(9); b[0] = 0xcf; b.writeBigUInt64BE(BigInt(value), 1); out.push(b); return
      }
      if (value >= -0x80) { const b = Buffer.alloc(2); b[0] = 0xd0; b.writeInt8(value, 1); out.push(b); return }
      if (value >= -0x8000) { const b = Buffer.alloc(3); b[0] = 0xd1; b.writeInt16BE(value, 1); out.push(b); return }
      if (value >= -0x80000000) { const b = Buffer.alloc(5); b[0] = 0xd2; b.writeInt32BE(value, 1); out.push(b); return }
      const b = Buffer.alloc(9); b[0] = 0xd3; b.writeBigInt64BE(BigInt(value), 1); out.push(b); return
    }
    const b = Buffer.alloc(9); b[0] = 0xcb; b.writeDoubleBE(value, 1); out.push(b); return
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8')
    if (bytes.length < 32) { out.push(Buffer.from([0xa0 | bytes.length])); out.push(bytes); return }
    if (bytes.length <= 0xff) { out.push(Buffer.from([0xd9, bytes.length])); out.push(bytes); return }
    if (bytes.length <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xda; b.writeUInt16BE(bytes.length, 1); out.push(b); out.push(bytes); return }
    const b = Buffer.alloc(5); b[0] = 0xdb; b.writeUInt32BE(bytes.length, 1); out.push(b); out.push(bytes); return
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const bytes = Buffer.from(value)
    if (bytes.length <= 0xff) { out.push(Buffer.from([0xc4, bytes.length])); out.push(bytes); return }
    if (bytes.length <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xc5; b.writeUInt16BE(bytes.length, 1); out.push(b); out.push(bytes); return }
    const b = Buffer.alloc(5); b[0] = 0xc6; b.writeUInt32BE(bytes.length, 1); out.push(b); out.push(bytes); return
  }
  if (Array.isArray(value)) {
    if (value.length < 16) { out.push(Buffer.from([0x90 | value.length])) } else if (value.length <= 0xffff) {
      const b = Buffer.alloc(3); b[0] = 0xdc; b.writeUInt16BE(value.length, 1); out.push(b)
    } else { const b = Buffer.alloc(5); b[0] = 0xdd; b.writeUInt32BE(value.length, 1); out.push(b) }
    for (const item of value) write(item, out)
    return
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value)
    if (keys.length < 16) { out.push(Buffer.from([0x80 | keys.length])) } else if (keys.length <= 0xffff) {
      const b = Buffer.alloc(3); b[0] = 0xde; b.writeUInt16BE(keys.length, 1); out.push(b)
    } else { const b = Buffer.alloc(5); b[0] = 0xdf; b.writeUInt32BE(keys.length, 1); out.push(b) }
    for (const key of keys) { write(key, out); write(value[key], out) }
    return
  }
  throw new TypeError(`msgpackEncode: 不支持的类型 ${typeof value}`)
}

/** 解码：整段读完；尾部有多余字节就报错（不静默吞）。 */
export function msgpackDecode(buffer) {
  const state = { buf: Buffer.from(buffer), at: 0 }
  const value = read(state)
  if (state.at !== state.buf.length) {
    throw new Error(`msgpackDecode: 尾部还有 ${state.buf.length - state.at} 字节没读（格式不认识）`)
  }
  return value
}

function read(state) {
  const b = state.buf
  if (state.at >= b.length) throw new Error('msgpackDecode: 数据提前结束')
  const head = b[state.at]; state.at += 1
  if (head <= 0x7f) return head
  if (head >= 0xe0) return head - 0x100
  if ((head & 0xe0) === 0xa0) return readString(state, head & 0x1f)
  if ((head & 0xf0) === 0x90) return readArray(state, head & 0x0f)
  if ((head & 0xf0) === 0x80) return readMap(state, head & 0x0f)
  switch (head) {
    case 0xc0: return null
    case 0xc2: return false
    case 0xc3: return true
    case 0xc4: return readBytes(state, readUInt(state, 1))
    case 0xc5: return readBytes(state, readUInt(state, 2))
    case 0xc6: return readBytes(state, readUInt(state, 4))
    case 0xca: { const v = b.readFloatBE(state.at); state.at += 4; return v }
    case 0xcb: { const v = b.readDoubleBE(state.at); state.at += 8; return v }
    case 0xcc: return readUInt(state, 1)
    case 0xcd: return readUInt(state, 2)
    case 0xce: return readUInt(state, 4)
    case 0xcf: return Number(b.readBigUInt64BE(take(state, 8)))
    case 0xd0: { const v = b.readInt8(state.at); state.at += 1; return v }
    case 0xd1: { const v = b.readInt16BE(state.at); state.at += 2; return v }
    case 0xd2: { const v = b.readInt32BE(state.at); state.at += 4; return v }
    case 0xd3: return Number(b.readBigInt64BE(take(state, 8)))
    case 0xd9: return readString(state, readUInt(state, 1))
    case 0xda: return readString(state, readUInt(state, 2))
    case 0xdb: return readString(state, readUInt(state, 4))
    case 0xdc: return readArray(state, readUInt(state, 2))
    case 0xdd: return readArray(state, readUInt(state, 4))
    case 0xde: return readMap(state, readUInt(state, 2))
    case 0xdf: return readMap(state, readUInt(state, 4))
    default:
      throw new Error(`msgpackDecode: 不认识的类型字节 0x${head.toString(16)}（扩展类型这里没实现）`)
  }
}

function take(state, n) {
  if (state.at + n > state.buf.length) throw new Error('msgpackDecode: 数据提前结束')
  const at = state.at; state.at += n
  return at
}
function readUInt(state, n) {
  const at = take(state, n)
  const b = state.buf
  if (n === 1) return b.readUInt8(at)
  if (n === 2) return b.readUInt16BE(at)
  return b.readUInt32BE(at)
}
function readBytes(state, n) {
  const at = take(state, n)
  return Buffer.from(state.buf.subarray(at, at + n))
}
function readString(state, n) {
  const at = take(state, n)
  return state.buf.toString('utf8', at, at + n)
}
function readArray(state, n) {
  const out = new Array(n)
  for (let i = 0; i < n; i++) out[i] = read(state)
  return out
}
function readMap(state, n) {
  const out = {}
  for (let i = 0; i < n; i++) { const key = read(state); out[String(key)] = read(state) }
  return out
}

/* ── ZIP（只做 stored / deflate 两种）───────────────────────────────────── */

const MAX_ENTRIES = 1000
const MAX_TOTAL = 500 * 1024 * 1024
const MAX_ONE = 200 * 1024 * 1024

/** 规范 6.1：会拒绝绝对路径 / 盘符 / `..` 段（防路径穿越）。 */
function assertSafeName(name) {
  const raw = String(name)
  if (raw.startsWith('/') || raw.startsWith('\\') || /^[A-Za-z]:/.test(raw)) {
    throw new Error(`ZIP 条目名是绝对路径，拒绝：${raw}`)
  }
  if (raw.split('/').includes('..')) throw new Error(`ZIP 条目名含 .. 段，拒绝：${raw}`)
  return raw
}

/** 读一个 ZIP → `[{ name, method, data(Buffer) }]`。 */
export function zipRead(buffer, options = {}) {
  const maxEntries = options.maxEntries || MAX_ENTRIES
  const maxTotal = options.maxTotalBytes || MAX_TOTAL
  const maxOne = options.maxEntryBytes || MAX_ONE
  const buf = Buffer.from(buffer)

  // 从尾部找 EOCD（0x06054b50），注释最长 65535 字节
  let eocd = -1
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是合法 ZIP：找不到 EOCD')
  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (count > maxEntries) throw new Error(`ZIP 条目数 ${count} 超过上限 ${maxEntries}（规范 6.1）`)
  if (cdOffset + cdSize > buf.length) throw new Error('ZIP 中央目录越界')

  const out = []
  let total = 0
  let at = cdOffset
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error(`ZIP 中央目录第 ${i} 条签名不对`)
    const method = buf.readUInt16LE(at + 10)
    const compressedSize = buf.readUInt32LE(at + 20)
    const uncompressedSize = buf.readUInt32LE(at + 24)
    const nameLen = buf.readUInt16LE(at + 28)
    const extraLen = buf.readUInt16LE(at + 30)
    const commentLen = buf.readUInt16LE(at + 32)
    const localOffset = buf.readUInt32LE(at + 42)
    const name = assertSafeName(buf.toString('utf8', at + 46, at + 46 + nameLen))
    at += 46 + nameLen + extraLen + commentLen

    if (uncompressedSize > maxOne) throw new Error(`ZIP 条目 ${name} 解压后 ${uncompressedSize} 字节，超过单文件上限（规范 6.1）`)
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`ZIP 条目 ${name} 的本地头签名不对`)
    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataAt = localOffset + 30 + lNameLen + lExtraLen
    const raw = buf.subarray(dataAt, dataAt + compressedSize)

    let data
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = inflateRawSync(raw)
    else throw new Error(`ZIP 条目 ${name} 用了压缩法 ${method}（只支持 0=stored / 8=deflate）`)

    total += data.length
    if (total > maxTotal) throw new Error(`ZIP 解压总量超过 ${maxTotal} 字节上限（规范 6.1）`)
    out.push({ name, method, data })
  }
  return out
}

/** 写一个 ZIP（deflate 压缩，UTF-8 名字，规范要求的 `/` 分隔）。 */
export function zipWrite(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = assertSafeName(entry.name)
    const nameBytes = Buffer.from(name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data)
    const compressed = deflateRawSync(data, { level: 9 })
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)          // version needed
    local.writeUInt16LE(0x0800, 6)      // UTF-8 名字标志
    local.writeUInt16LE(8, 8)           // deflate
    local.writeUInt16LE(0, 10)          // time
    local.writeUInt16LE(0x21, 12)       // date（1980-01-01，固定值：可复现）
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBytes, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)

    offset += local.length + nameBytes.length + compressed.length
  }
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

let crcTable = null
function crc32(buffer) {
  if (crcTable === null) {
    crcTable = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buffer.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buffer[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

/* ── 文档层 ─────────────────────────────────────────────────────────────── */

/** 解一个 `.prg` → `{ entries, metadata, stage, attachments, extension }`。 */
export function readPrg(buffer, options = {}) {
  const entries = zipRead(buffer, options)
  const byName = new Map(entries.map((e) => [e.name, e]))
  const metadataEntry = byName.get('metadata.msgpack') || byName.get('metadata.json')
  const stageEntry = byName.get('stage.msgpack')
  const extensionEntry = byName.get('extension.js')
  if (metadataEntry === undefined) throw new Error('不是合法 .prg：缺 metadata.msgpack（规范 §2）')
  if (stageEntry === undefined && extensionEntry === undefined) {
    throw new Error('不是合法 .prg：stage.msgpack 与 extension.js 都没有（规范 §2）')
  }
  const metadata = metadataEntry.name.endsWith('.json')
    ? JSON.parse(metadataEntry.data.toString('utf8'))
    : msgpackDecode(metadataEntry.data)
  const stage = stageEntry === undefined ? null : msgpackDecode(stageEntry.data)
  if (stage !== null && !Array.isArray(stage)) throw new Error('stage.msgpack 解出来不是数组（规范 §4.1.2）')
  const attachments = entries
    .filter((e) => e.name.startsWith('attachments/') && !e.name.endsWith('/'))
    .map((e) => {
      const file = e.name.slice('attachments/'.length)
      const dot = file.lastIndexOf('.')
      return {
        name: e.name,
        uuid: dot < 0 ? file : file.slice(0, dot),
        ext: dot < 0 ? '' : file.slice(dot + 1),
        bytes: e.data.length,
      }
    })
  return {
    entries, metadata, stage, attachments,
    extension: extensionEntry === undefined ? null : extensionEntry.data.toString('utf8'),
  }
}

/**
 * 把改过的 `stage` 写回一个 `.prg`。
 * **只替换 `stage.msgpack` 与 `metadata.msgpack`，其余条目（附件、extension.js…）原样搬运** ——
 * 不重打包附件就不会把图片弄坏。
 */
export function writePrg(document, options = {}) {
  const stage = options.stage === undefined ? document.stage : options.stage
  const metadata = options.metadata === undefined ? document.metadata : options.metadata
  const out = []
  let wroteMetadata = false
  let wroteStage = false
  for (const entry of document.entries) {
    if (entry.name === 'metadata.msgpack') { out.push({ name: entry.name, data: msgpackEncode(metadata) }); wroteMetadata = true; continue }
    if (entry.name === 'metadata.json') { continue }   // 有 .msgpack 就不要 .json（规范 §3.2 优先规则）
    if (entry.name === 'stage.msgpack') { out.push({ name: entry.name, data: msgpackEncode(stage) }); wroteStage = true; continue }
    out.push({ name: entry.name, data: entry.data })
  }
  if (!wroteMetadata) out.unshift({ name: 'metadata.msgpack', data: msgpackEncode(metadata) })
  if (!wroteStage && stage !== null) out.push({ name: 'stage.msgpack', data: msgpackEncode(stage) })
  return zipWrite(out)
}

/** 舞台对象 → 便于阅读的摘要（不还原类实例，只认字段）。 */
export function stageObjectSummary(object, index) {
  if (object === null || typeof object !== 'object') return { index, broken: true }
  const className = typeof object._ === 'string' ? object._ : null
  const location = object.location && typeof object.location === 'object'
    ? { x: numberOrNull(object.location.x), y: numberOrNull(object.location.y) }
    : null
  const size = object.size && typeof object.size === 'object'
    ? { width: numberOrNull(object.size.width), height: numberOrNull(object.size.height) }
    : null
  return {
    index,
    uuid: typeof object.uuid === 'string' ? object.uuid : null,
    type: className,
    keys: Object.keys(object),
    text: typeof object.text === 'string' ? object.text : undefined,
    details: typeof object.details === 'string' && object.details !== '' ? object.details : undefined,
    location,
    size,
  }
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
