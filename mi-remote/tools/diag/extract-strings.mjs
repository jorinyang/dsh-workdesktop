// extract-strings.mjs —— 从 sayall-helper.exe 里挖出"内嵌的 Frida 脚本"痕迹。
//
// 思路：SayAll 在 Windows 上靠 Frida 注入蓝牙驱动宿主（WUDFHost）拿按键，
// 而它的脚本（hook 了哪些函数、怎么读报告）必然以字符串形式躺在那个 exe 里。
// 挖出它，就知道该 hook 什么 —— 这比从零做二进制特征码扫描省几个数量级。
import fs from 'node:fs'

const target = process.argv[2]
const buf = fs.readFileSync(target)
console.log(`文件: ${target}`)
console.log(`大小: ${(buf.length / 1048576).toFixed(1)} MB`)

// 提取 ASCII 字符串（长度 >= 5）
const ascii = []
let cur = []
for (let i = 0; i < buf.length; i++) {
  const c = buf[i]
  if (c >= 0x20 && c < 0x7f) { cur.push(c); continue }
  if (cur.length >= 5) ascii.push(Buffer.from(cur).toString('latin1'))
  cur = []
}
if (cur.length >= 5) ascii.push(Buffer.from(cur).toString('latin1'))

// 提取 UTF-16LE 字符串
const wide = []
cur = []
for (let i = 0; i + 1 < buf.length; i += 2) {
  const c = buf[i]
  const hi = buf[i + 1]
  if (hi === 0 && c >= 0x20 && c < 0x7f) { cur.push(c); continue }
  if (cur.length >= 5) wide.push(Buffer.from(cur).toString('latin1'))
  cur = []
}
if (cur.length >= 5) wide.push(Buffer.from(cur).toString('latin1'))

console.log(`ASCII 字符串 ${ascii.length} 条 · UTF-16 字符串 ${wide.length} 条`)
console.log('')

// 关心这些关键词：Frida API、驱动/HID 相关、函数名
const groups = {
  'Frida API': /Interceptor|attach|detach|Module\.|Memory\.|NativeFunction|addInvocationListener|Process\.|Thread\.backtrace|send\(|recv\(|rpc\./i,
  '驱动/HID': /Wdf|WUDF|Hid|HID|Report|Gatt|Bth|Bluetooth|kbdclass|i8042|Keybd|input/i,
  '函数名形态': /^[A-Z][A-Za-z0-9]{4,}(W|A|Ex)?$|_[A-Za-z]+@\d+/,
  '脚本痕迹': /\.js$|script|payload|gadget|hook|intercept/i,
}

for (const [name, re] of Object.entries(groups)) {
  const hits = [...new Set([...ascii, ...wide].filter((s) => re.test(s)))]
  console.log(`=== ${name}（${hits.length} 条，最多列 60）===`)
  for (const h of hits.slice(0, 60)) console.log('  ' + h.slice(0, 160))
  console.log('')
}
