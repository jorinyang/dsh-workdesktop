/**
 * 线上零污染验收：不新建会话，只在首页打开「设置」，看侧边卡片的清单里
 * 是否列出了既有卡片（建模中心）与本插件的新卡片（坐标系）。
 * 用既有卡片当对照组：清单能列出建模中心，才说明这个位置确实是"已注册卡片一览"。
 *
 *   node live-register.mjs "<带 token 的 URL>"
 */
import { chromium } from 'playwright'

const url = process.argv[2]
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const logs = []
page.on('console', m => logs.push(`[${m.type()}] ${m.text().slice(0, 200)}`))
page.on('pageerror', e => logs.push(`[pageerror] ${String(e).slice(0, 300)}`))

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForTimeout(5000)

const opened = await page.evaluate(() => {
  const button = Array.from(document.querySelectorAll('button')).find(node => (node.getAttribute('aria-label') ?? node.innerText ?? '').trim() === '设置')
  if (button === undefined) return false
  button.click()
  return true
})
await page.waitForTimeout(2500)

const found = await page.evaluate(() => {
  const text = document.body.innerText
  const cards = Array.from(document.querySelectorAll('[title]')).map(node => node.getAttribute('title')).filter(Boolean)
  return {
    hasModeling: cards.includes('建模中心') || text.includes('建模中心'),
    hasCoords: cards.includes('坐标系') || text.includes('坐标系'),
    coordTitles: cards.filter(title => title === '坐标系' || title === '建模中心' || title === '工作台'),
    settingsVisible: /设置|偏好|外观/.test(text.slice(0, 400)),
  }
})
console.log('打开了设置：', opened)
console.log('卡片清单里 — 建模中心（对照）:', found.hasModeling, '｜ 坐标系（本插件）:', found.hasCoords)
console.log('命中的卡片标题：', JSON.stringify(found.coordTitles))
await page.screenshot({ path: 'C:/Users/<用户>/.dsh-coords-verify/live-settings.png' })
if (logs.length > 0) console.log('控制台尾部：\n' + logs.slice(-6).join('\n'))
await browser.close()
if (!(found.hasModeling && found.hasCoords)) process.exitCode = 1
