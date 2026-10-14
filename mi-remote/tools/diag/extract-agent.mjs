// extract-agent.mjs —— 从 sayall-helper.exe 里把内嵌的 rc003_agent.js 整段抠出来。
//
// 为什么要它：SayAll 靠这个脚本注入蓝牙驱动宿主（WUDFHost）拿按键，脚本里写着
// "hook 哪个函数、怎么识别报告、怎么读写缓冲区"。把它读出来，等于拿到一份
// "在这个进程里怎么收遥控器按键"的现成答案 —— 比从零做二进制特征码扫描省太多。
import fs from 'node:fs'

const target = process.argv[2]
const outPath = process.argv[3]
const buf = fs.readFileSync(target)

// 脚本以 'use strict'; 开头。找所有出现位置，取最长的一段可打印文本。
const markers = []
let idx = buf.indexOf("'use strict';")
while (idx >= 0) { markers.push(idx); idx = buf.indexOf("'use strict';", idx + 1) }
console.log(`文件 ${target} (${(buf.length / 1048576).toFixed(1)} MB)`)
console.log(`找到 ${markers.length} 处 'use strict';`)

let best = null
for (const start of markers) {
  // 从该处往后扫。注意不能"遇到非 ASCII 就停" —— 脚本里有中文注释（UTF-8），
  // 那在上一次的实现里被当成"不可打印"，扫到第一段中文就断了（只抠出 421 字节）。
  // 正确的停止条件是"连续一大段 0x00"（真正的填充/结束）。
  let end = start
  let zeros = 0
  while (end < buf.length && zeros < 256) {
    if (buf[end] === 0x00) { zeros++ } else { zeros = 0 }
    end++
  }
  const text = buf.subarray(start, end - zeros).toString('utf8')
  if (!best || text.length > best.length) best = text
  console.log(`  起点 ${start}: 抠出 ${text.length} 字节`)
}

if (!best) { console.log('没抠到脚本'); process.exit(1) }

fs.writeFileSync(outPath, best, 'latin1')
console.log(`\n最长的一段 ${best.length} 字节已写入 ${outPath}`)
console.log('--- 前 40 行 ---')
for (const line of best.split('\n').slice(0, 40)) console.log('  ' + line.slice(0, 170))
