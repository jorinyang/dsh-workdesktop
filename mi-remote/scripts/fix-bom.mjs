/**
 * fix-bom.mjs — 给插件里所有 .ps1 补 UTF-8 BOM
 *
 * 为什么：编辑工具写入文件时不带 BOM，而 Windows PowerShell 5.1 读 .ps1 时
 * 没有 BOM 就按 ANSI(GBK) 解 —— 中文被撕碎、脚本解析失败。
 *
 * ★ 2026-10-11 扩到全插件范围。原来只列了 audio/ 下那两个文件，于是
 *   `engine/build.ps1` 丢了 BOM 没人管，编译直接挂在这种错上：
 *       throw '娌℃壘鍒?csc.exe锛堣 VS BuildTools 鎴?.NET Framework 鍧囧彲锛?
 *       The string is missing the terminator: '.
 *   —— 中文被当 GBK 解，把字符串的收尾单引号吃掉了。
 *   规则：**改过本插件里任何 .ps1 之后，跑一次 `node scripts/fix-bom.mjs`。**
 *
 * 做法：扫全插件（排除 node_modules / state / tmp / assets），凡是 .ps1 就检查 BOM。
 * 幂等：已带 BOM 的不动。
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BOM = Buffer.from([0xEF, 0xBB, 0xBF])
const SKIP_DIRS = new Set(['node_modules', 'state', 'tmp', 'assets', '.git', '__pycache__'])

/** 递归收集所有 .ps1（排除运行时与第三方目录）。 */
function collect(dir, out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      collect(join(dir, e.name), out)
    } else if (extname(e.name).toLowerCase() === '.ps1') {
      out.push(join(dir, e.name))
    }
  }
  return out
}

const targets = collect(HERE).sort()
console.log('扫到 ' + targets.length + ' 个 .ps1：')

let changed = 0
let bad = 0
for (const target of targets) {
  const rel = target.slice(HERE.length + 1)
  let bytes
  try { bytes = readFileSync(target) } catch (error) {
    console.error('  读不到：' + rel + ' → ' + error.message)
    bad += 1
    continue
  }
  const has = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF
  if (has) {
    console.log('  OK   已带 BOM  ' + rel)
    continue
  }
  const text = bytes.toString('utf8')
  if (text.includes('\uFFFD')) {
    console.error('  !!   内容不是合法 UTF-8，先修内容再加 BOM：' + rel)
    bad += 1
    continue
  }
  writeFileSync(target, Buffer.concat([BOM, bytes]))
  changed += 1
  console.log('  修   已加 BOM  ' + rel)
}

console.log('')
if (bad > 0) {
  console.error('有 ' + bad + ' 个文件需要人工处理。')
  process.exitCode = 1
} else {
  console.log(changed === 0 ? '全部已带 BOM，无事可做。' : '补了 ' + changed + ' 个文件的 BOM。')
}
