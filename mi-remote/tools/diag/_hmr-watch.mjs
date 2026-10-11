// _hmr-watch.mjs —— 被动监听 /plugins/events 若干秒，什么都不碰。
//
// 为什么要这样查：用户报"双击主页之后页面一直在刷新"。
// 如果 HMR 在我们没改任何文件的情况下自己反复报 rebuilt，就说明存在重建循环
// （典型成因：客户端往插件目录里的文件写东西 → 文件监视触发重建 → 页面重载 → 再写）。
import http from 'node:http'

const SECONDS = Number(process.argv[2] ?? 12)
const counts = new Map()
const lines = []

const req = http.get({ host: '127.0.0.1', port: 3080, path: '/plugins/events' }, (res) => {
  console.log('  /plugins/events HTTP ' + res.statusCode)
  res.setEncoding('utf8')
  res.on('data', (chunk) => {
    for (const raw of chunk.split('\n')) {
      const line = raw.trim()
      if (!line.startsWith('data:')) continue
      const json = line.slice(5).trim()
      let type = '?'
      let id = ''
      try {
        const o = JSON.parse(json)
        type = o.type ?? '?'
        id = o.id ?? ''
        if (type === 'rebuilt' && o.rev) id += ' rev=' + o.rev
      } catch { /* graph 那些大对象只记类型 */ }
      const key = type + (id ? ' ' + id : '')
      counts.set(key, (counts.get(key) ?? 0) + 1)
      if (lines.length < 40) lines.push(key)
    }
  })
})
req.on('error', (e) => console.log('  连不上: ' + e.message))
req.setTimeout((SECONDS + 4) * 1000, () => req.destroy())

await new Promise((r) => setTimeout(r, SECONDS * 1000))
req.destroy()

console.log('  监听 ' + SECONDS + ' 秒（期间没碰任何文件）')
console.log('  事件分类：')
for (const [k, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log('    ' + String(n).padStart(3) + ' × ' + k.slice(0, 110))
}
const rebuilt = [...counts.entries()].filter(([k]) => k.startsWith('rebuilt'))
if (rebuilt.length === 0) {
  console.log('  ✓ 没有 rebuilt —— 不存在重建循环')
} else {
  console.log('  ⚠ 出现了 ' + rebuilt.reduce((s, [, n]) => s + n, 0) + ' 次 rebuilt（没碰文件的情况下）—— 有东西在反复触发重建')
}
