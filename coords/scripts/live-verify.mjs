/**
 * 线上实例验收（**不新建会话**，纯净）：
 *   ① host 半段：/coords/api/meta 是否 200
 *   ② 客户端半段：GUI 首页加载后是否注入了 data-dsh-coords 样式（apply 跑过的硬证据）
 *   ③ 事件轮询是否真的在跑（对 /coords/api/events 的请求）
 *   ④ 控制台有无与 dsh-coords 相关的报错
 *
 *   node live-verify.mjs "<带 token 的 URL>" [apiBase]
 */
import { chromium } from 'playwright'

const url = process.argv[2]
const apiBase = process.argv[3] ?? 'http://127.0.0.1:3080'
if (url === undefined) throw new Error('用法：node live-verify.mjs <url-with-token> [apiBase]')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : '  ' + detail}`)
}

// ① host 半段
const meta = await fetch(`${apiBase}/coords/api/meta`).then(async r => ({ status: r.status, body: await r.json().catch(() => null) })).catch(e => ({ status: 0, error: String(e) }))
check('host 半段挂上：GET /coords/api/meta = 200', meta.status === 200, meta.status === 200 ? `模板 ${meta.body?.templates?.length ?? '?'} 套 · 数据根 ${meta.body?.dataRoot}` : JSON.stringify(meta).slice(0, 140))

// ②③④ 客户端半段
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const logs = []
const requests = []
page.on('console', m => logs.push(`[${m.type()}] ${m.text().slice(0, 200)}`))
page.on('pageerror', e => logs.push(`[pageerror] ${String(e).slice(0, 300)}`))
page.on('request', r => { if (r.url().includes('/coords/')) requests.push(r.url()) })
page.on('response', r => { if (r.url().includes('/coords/')) requests.push(`${r.status()} ${r.url()}`) })

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForTimeout(9000)

const state = await page.evaluate(() => ({
  style: document.querySelector('style[data-dsh-coords]') !== null,
  cssProbe: (() => {
    // 样式里必须真的有卡片那套类名（避免"标记在、内容是空的"）
    const node = document.querySelector('style[data-dsh-coords]')
    return node === null ? false : node.textContent.includes('.dshco-root') && node.textContent.includes('0 0 5%')
  })(),
  title: document.title,
  root: document.querySelector('#root') !== null,
}))
check('客户端半段加载：注入了 data-dsh-coords 样式', state.style === true)
check('样式内容完整（卡片类名与 5% 上带都在）', state.cssProbe === true)
const polled = requests.some(item => item.includes('/coords/api/events'))
check('事件轮询在跑（卡片会被 agent 唤出）', polled, requests.slice(0, 3).join(' | '))

const bad = logs.filter(line => /dsh-coords/i.test(line))
check('控制台没有 dsh-coords 相关报错', bad.length === 0, bad.slice(0, 3).join(' | '))

if (logs.length > 0) {
  console.log('=== 控制台尾部 ===')
  console.log(logs.slice(-8).join('\n'))
}
await page.screenshot({ path: 'C:/Users/<用户>/.dsh-coords-verify/live-home.png' })
await browser.close()

const failed = results.filter(item => !item.ok)
console.log(`\n${results.length - failed.length} PASS / ${failed.length} FAIL`)
if (failed.length > 0) process.exitCode = 1
