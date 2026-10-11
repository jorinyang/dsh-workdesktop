import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// _hmr-probe.mjs —— 碰一下客户端文件，看 /plugins/events 有没有报 rebuilt。
//
// 为什么查这个：用户报"快捷键未生效"。改了 lib/client.js 之后，浏览器要拿到新代码才可能生效 ——
// 要么 HMR 推了 rebuilt，要么用户手动刷新。这个脚本确认 HMR 到底有没有动静。
import http from 'node:http'
import { utimesSync } from 'node:fs'

const HOST = '127.0.0.1'
const PORT = 3080
const CLIENT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'client.js')

const events = []
const req = http.get({ host: HOST, port: PORT, path: '/plugins/events' }, (res) => {
  console.log('  /plugins/events HTTP ' + res.statusCode)
  res.setEncoding('utf8')
  res.on('data', (chunk) => {
    for (const line of chunk.split('\n')) {
      if (line.trim() !== '') events.push(line.trim().slice(0, 200))
    }
  })
})
req.on('error', (e) => console.log('  连不上: ' + e.message))
req.setTimeout(12000, () => req.destroy())

await new Promise((r) => setTimeout(r, 1500))

// 碰一下文件（改 mtime，内容不动）
const now = new Date()
utimesSync(CLIENT, now, now)
console.log('  已触发 ' + CLIENT.split('/').pop() + ' 的 mtime')

await new Promise((r) => setTimeout(r, 6000))
req.destroy()

console.log('  收到 ' + events.length + ' 条事件：')
for (const e of events.slice(0, 14)) console.log('    ' + e)
if (events.length === 0) {
  console.log('    （没有事件 —— HMR 没推，说明必须手动刷新页面才会拿到新代码）')
}
