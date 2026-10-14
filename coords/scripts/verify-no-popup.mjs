/**
 * 真机回归：这一栏**不许自己弹回来**。
 *   1) 用 host 事件把卡打开（等价 agent 调 coords_open）
 *   2) 关掉它
 *   3) 等 4 个轮询周期（3s 一轮），它必须还是关着的
 *   4) 刷新页面（此时 host 里那条 open 事件已经是"旧的"），它同样不许自己弹出来
 *
 *   node verify-no-popup.mjs "<带 token 的 URL>" [apiBase]
 */
import { chromium } from 'playwright'

const url = process.argv[2]
const apiBase = process.argv[3] ?? 'http://127.0.0.1:3181'
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`) }

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
const errors = []
page.on('pageerror', e => errors.push(String(e).slice(0, 160)))
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)) })

const openState = () => page.evaluate(() => {
  const panel = document.querySelector('[data-sidebar-right-panel]')
  const card = document.querySelector('.dshco-root')
  const tab = document.querySelector('[data-dockkit-tab-active="true"], [class*="tab"][aria-selected="true"]')
  return {
    panelHidden: panel === null ? null : panel.getAttribute('aria-hidden'),
    panelW: panel === null ? 0 : Math.round(panel.getBoundingClientRect().width),
    card: card !== null,
    cardVisible: card !== null && card.getBoundingClientRect().width > 0 && rootVisible(card),
    activeTab: tab === null ? null : (tab.textContent || '').trim().slice(0, 12),
  }
  function rootVisible(node) { const r = node.getBoundingClientRect(); return r.height > 0 && r.top < window.innerHeight && r.bottom > 0 }
})

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForTimeout(3500)
const beta = page.locator('[role="dialog"] button:has-text("继续")').first()
if (await beta.count() > 0) { await beta.click({ timeout: 5000 }).catch(() => { }); await page.waitForTimeout(500) }
for (const label of ['在“Knowledge”中新建会话', '新建会话']) {
  const t = page.locator(`button[aria-label="${label}"]`).first()
  if (await t.count() > 0) { await t.click({ timeout: 8000 }).catch(() => { }); break }
}
await page.waitForTimeout(9000)

// ① agent 唤出
await fetch(`${apiBase}/coords/api/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
for (let i = 0; i < 20; i += 1) { if (await page.locator('.dshco-root').count() > 0) break; await page.waitForTimeout(1000) }
await page.waitForTimeout(1500)
const afterOpen = await openState()
check('① agent 唤出后卡片出现', afterOpen.card === true && afterOpen.panelHidden !== 'true', JSON.stringify(afterOpen))

// ② 关掉它：官方右栏的关闭入口（aria-label 里带"收起/关闭/隐藏"）
const closedBy = await page.evaluate(() => {
  const labels = ['收起右侧边栏', '关闭右侧边栏', '隐藏右侧边栏', '收起侧栏']
  for (const label of labels) {
    const button = Array.from(document.querySelectorAll('button')).find(node => (node.getAttribute('aria-label') ?? '') === label)
    if (button !== undefined) { button.click(); return label }
  }
  return null
})
await page.waitForTimeout(1500)
const afterClose = await openState()
check('② 能找到并点掉关闭入口', closedBy !== null, `用了「${closedBy}」`)
check('② 关掉之后卡片不再占屏', afterClose.cardVisible === false || afterClose.panelHidden === 'true', JSON.stringify(afterClose))

// ③ 等 4 个轮询周期：不许自己弹回来
await page.waitForTimeout(13000)
const afterWait = await openState()
check('③ 等 13 秒（4 个轮询周期）后仍然是关着的', afterWait.panelHidden === 'true' || afterWait.cardVisible === false, JSON.stringify(afterWait))

// ④ 刷新页面：host 里那条 open 事件已经是旧的（>15s），不许重放。
//    注意判据是**本卡在不在**，不是"右栏有没有开" —— 右栏由官方/工作台自己的
//    默认行为决定（实测刷新后它开着但停在「工作台」那一页，那不算我们弹的）。
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(9000)
const afterReload = await openState()
check('④ 刷新页面后本卡不许自己弹出来（历史事件不重放）', afterReload.card === false && afterReload.activeTab !== '坐标系', JSON.stringify(afterReload))

console.log('=== 报错 ===', errors.slice(-5).join(' | ') || '(无)')
const bad = results.filter(r => !r.ok)
console.log(`\n${results.length - bad.length} PASS / ${bad.length} FAIL`)
await browser.close()
if (bad.length > 0) process.exitCode = 1
