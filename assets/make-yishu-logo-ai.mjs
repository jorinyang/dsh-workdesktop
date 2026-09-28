#!/usr/bin/env node
/**
 * make-yishu-logo-ai.mjs —— 把**生图模型**出的「弈枢」水墨图处理成可用的透明底素材（2026-09-27）。
 *
 *   为什么还要处理：生图模型给的是**白底**（或近白底）的 JPG/PNG，而工作台要的是"背景透明"。
 *   本脚本做三件事（都是确定性的像素运算，不依赖任何图形库）：
 *     ① **抠白底**：按亮度把近白像素变成透明，笔画边缘按亮度做半透明过渡（保持毛笔的飞白与洇）；
 *     ② **裁到墨迹外框**（留一点边距）—— 生图四周通常留一大片白，不裁的话插进界面会缩得很小；
 *     ③ 出两张：`yishu-ai-ink.png`（原尺寸·墨色透明底，给人看/别处用）与
 *        `yishu-ai-mask.png`（纯白·宽约 272px，给插件的 CSS 遮罩用）。
 *
 *   PNG 的读与写都在这里手写（zlib + CRC32）：本机没装 sharp/jimp，而"装一个图形库"对这个一次性
 *   任务太重。只支持 8 位非隔行的 RGB/RGBA（生图产出的都是这两种）。
 *
 *   用法：node make-yishu-logo-ai.mjs <生图目录或文件> [输出目录]
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const SRC = process.argv[2]
const OUT = process.argv[3] || path.dirname(SRC)
if (!SRC) { console.log('用法: node make-yishu-logo-ai.mjs <生图目录或文件> [输出目录]'); process.exit(1) }

// ── PNG 读 ────────────────────────────────────────────────────────────────────
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
function decodePng(buf) {
  let pos = 8, ihdr = null
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] }
    if (type === 'IDAT') idat.push(data)
    pos += 12 + len
  }
  if (ihdr === null || ihdr.interlace !== 0 || ihdr.depth !== 8) throw new Error('只支持 8 位非隔行 PNG')
  const ch = CHANNELS[ihdr.color]
  if (ch === undefined) throw new Error('不支持的 PNG 色型 ' + ihdr.color)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = ihdr.w * ch
  const out = Buffer.alloc(stride * ihdr.h)
  let p = 0
  for (let y = 0; y < ihdr.h; y += 1) {
    const ft = raw[p]; p += 1
    const line = raw.subarray(p, p + stride); p += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride)
    for (let x = 0; x < stride; x += 1) {
      const a = x >= ch ? cur[x - ch] : 0
      const b = prev[x]
      const c = x >= ch ? prev[x - ch] : 0
      let v = line[x]
      if (ft === 1) v = (v + a) & 0xff
      else if (ft === 2) v = (v + b) & 0xff
      else if (ft === 3) v = (v + ((a + b) >> 1)) & 0xff
      else if (ft === 4) {
        const pp = a + b - c
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c)
        v = (v + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 0xff
      }
      cur[x] = v
    }
  }
  return { w: ihdr.w, h: ihdr.h, ch, px: out }
}

// ── PNG 写（RGBA8，filter 0）──────────────────────────────────────────────────
let CRC_TABLE = null
function crc32(buf) {
  if (CRC_TABLE === null) {
    CRC_TABLE = new Int32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
      CRC_TABLE[n] = c
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0)
  return Buffer.concat([len, td, crc])
}
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const stride = w * 4
  const raw = Buffer.alloc((stride + 1) * h)
  for (let y = 0; y < h; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── 抠白 + 裁框 + 缩到遮罩尺寸 ─────────────────────────────────────────────────
/** 亮度 → alpha：>=hi 全透明，<=lo 全不透明，中间线性过渡（保住飞白与淡墨）
 *  ⚠️ 这两个阈值决定"远处的淡墨山影留不留"：默认偏松（留一点氛围），
 *     命令行 `--hi=` / `--lo=` 可收紧（例如 `--hi 205 --lo 120` 只留浓墨的笔画）。 */
const argOf = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='))
  return hit === undefined ? dflt : Number(hit.split('=')[1])
}
const HI = argOf('hi', 244), LO = argOf('lo', 178)
function keyOutWhite(img) {
  const { w, h, ch, px } = img
  const rgba = Buffer.alloc(w * h * 4)
  const hasAlpha = (ch === 4 || ch === 6)
  for (let i = 0; i < w * h; i += 1) {
    const r = px[i * ch], g = px[i * ch + 1], b = px[i * ch + 2]
    const srcA = hasAlpha ? px[i * ch + (ch - 1)] : 255
    const lum = 0.299 * r + 0.587 * g + 0.114 * b
    let a = 255
    if (lum >= HI) a = 0
    else if (lum > LO) a = Math.round(255 * (HI - lum) / (HI - LO))
    // ⚠️ 原图**自带 alpha** 时要一起算（否则"墨在透明底上"的输入会被当成"黑 = 该不透明"，
    //   整张背景直接变成实心黑 —— 这条是拿自己上一步产出的图试出来的）
    a = Math.round(a * srcA / 255)
    // 墨色统一压到"最深的那个颜色"，避免生图里发灰发蓝的杂色（水墨只该有墨与纸）
    const k = Math.max(0, Math.min(255, Math.round(lum * 0.55)))
    rgba[i * 4] = k; rgba[i * 4 + 1] = k; rgba[i * 4 + 2] = k; rgba[i * 4 + 3] = a
  }
  return { w, h, rgba }
}
function inkBox(img, pad) {
  const { w, h, rgba } = img
  let x0 = w, y0 = h, x1 = -1, y1 = -1
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (rgba[(y * w + x) * 4 + 3] > 24) {
        if (x < x0) x0 = x; if (x > x1) x1 = x
        if (y < y0) y0 = y; if (y > y1) y1 = y
      }
    }
  }
  if (x1 < 0) return null
  return {
    x: Math.max(0, x0 - pad), y: Math.max(0, y0 - pad),
    w: Math.min(w - Math.max(0, x0 - pad), (x1 - x0 + 1) + pad * 2),
    h: Math.min(h - Math.max(0, y0 - pad), (y1 - y0 + 1) + pad * 2),
  }
}
function crop(img, box) {
  const out = Buffer.alloc(box.w * box.h * 4)
  for (let y = 0; y < box.h; y += 1) {
    img.rgba.copy(out, y * box.w * 4, ((box.y + y) * img.w + box.x) * 4, ((box.y + y) * img.w + box.x + box.w) * 4)
  }
  return { w: box.w, h: box.h, rgba: out }
}
/** 面积平均缩放（缩图更干净；最近邻会把笔画缩断） */
function scale(img, tw) {
  const th = Math.max(1, Math.round(img.h * tw / img.w))
  const out = Buffer.alloc(tw * th * 4)
  const sx = img.w / tw, sy = img.h / th
  for (let y = 0; y < th; y += 1) {
    for (let x = 0; x < tw; x += 1) {
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let yy = Math.floor(y * sy); yy < Math.min(img.h, Math.ceil((y + 1) * sy)); yy += 1) {
        for (let xx = Math.floor(x * sx); xx < Math.min(img.w, Math.ceil((x + 1) * sx)); xx += 1) {
          const i = (yy * img.w + xx) * 4
          r += img.rgba[i]; g += img.rgba[i + 1]; b += img.rgba[i + 2]; a += img.rgba[i + 3]; n += 1
        }
      }
      const o = (y * tw + x) * 4
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n)
    }
  }
  return { w: tw, h: th, rgba: out }
}
/** 白版（给 CSS 遮罩）：只保留 alpha，颜色全白。
 *  ⚠️ 顺手把 alpha **量化成 32 级**（5 位）：这张图要 base64 内联进 client.js，
 *     水墨的半透明过渡是"噪声"，不量化的话 PNG 压不动（实测 27 KB ⇒ 8 KB 量级）。 */
function whiteMask(img) {
  const out = Buffer.from(img.rgba)
  for (let i = 0; i < img.w * img.h; i += 1) {
    out[i * 4] = 255; out[i * 4 + 1] = 255; out[i * 4 + 2] = 255
    const a = out[i * 4 + 3]
    out[i * 4 + 3] = a === 0 ? 0 : Math.max(8, Math.round(a / 255 * 31) * (255 / 31))
  }
  return { w: img.w, h: img.h, rgba: out }
}
function alphaStats(img) {
  let zero = 0, semi = 0, full = 0
  const total = img.w * img.h
  for (let i = 0; i < total; i += 1) {
    const a = img.rgba[i * 4 + 3]
    if (a === 0) zero += 1; else if (a === 255) full += 1; else semi += 1
  }
  const pct = (n) => (n / total * 100).toFixed(1) + '%'
  return '全透明 ' + pct(zero) + ' · 半透明 ' + pct(semi) + ' · 不透明 ' + pct(full)
}

// ── 跑 ────────────────────────────────────────────────────────────────────────
const stat = fs.statSync(SRC)
const files = stat.isDirectory()
  ? fs.readdirSync(SRC).filter((f) => /\.png$/i.test(f)).map((f) => path.join(SRC, f))
  : [SRC]
if (files.length === 0) { console.log('没找到 PNG：' + SRC); process.exit(1) }
fs.mkdirSync(OUT, { recursive: true })

for (const f of files) {
  const base = path.basename(f, path.extname(f))
  const raw = decodePng(fs.readFileSync(f))
  const keyed = keyOutWhite(raw)
  const box = inkBox(keyed, 18)
  if (box === null) { console.log(base + '  整张都是白底？跳过'); continue }
  const ink = crop(keyed, box)
  const mask = whiteMask(scale(ink, argOf('mask', 272)))
  const inkFile = path.join(OUT, base + '-ink.png')
  const maskFile = path.join(OUT, base + '-mask.png')
  fs.writeFileSync(inkFile, encodePng(ink.w, ink.h, ink.rgba))
  fs.writeFileSync(maskFile, encodePng(mask.w, mask.h, mask.rgba))
  console.log(base + '  ' + raw.w + '×' + raw.h + ' ⇒ 裁框 ' + ink.w + '×' + ink.h
    + ' · ' + alphaStats(ink) + ' · mask ' + mask.w + '×' + mask.h + '（' + fs.statSync(maskFile).size + ' 字节）')
}
console.log('\n下一步：挑一张，把它复制成插件的 assets/yishu-logo-ink.png 与 assets/yishu-logo-mask.png，')
console.log('再把遮罩注进 client.js 的 `__YISHU_MASK__` 占位符（注入脚本是一次性工具，未随本仓库发布，换字形时按同样办法自建）。')
