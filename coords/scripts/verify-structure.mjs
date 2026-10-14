/**
 * 结构回归：三段比例不管被存成什么（包括被拖坏的歪值），结构都必须成立 ——
 *   ① 中带（图）≥ 38%（不被压到 min-height 地板）
 *   ② 三段之和 == 卡片高度（没有一段被挤出容器）
 *   ③ 画布 SVG 不越出中带
 *   ④ 歪值读出来被夹回并写回去（自愈）
 *
 *   node verify-structure.mjs "<带 token 的 URL>" [apiBase]
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

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForTimeout(3500)
const beta = page.locator('[role="dialog"] button:has-text("继续")').first()
if (await beta.count() > 0) { await beta.click({ timeout: 5000 }).catch(() => { }); await page.waitForTimeout(500) }
for (const label of ['在“Knowledge”中新建会话', '新建会话']) {
  const t = page.locator(`button[aria-label="${label}"]`).first()
  if (await t.count() > 0) { await t.click({ timeout: 8000 }).catch(() => { }); break }
}
await page.waitForTimeout(9000)
await fetch(`${apiBase}/coords/api/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
for (let i = 0; i < 25; i += 1) { if (await page.locator('.dshco-root').count() > 0) break; await page.waitForTimeout(1000) }
await page.waitForTimeout(2000)

const measure = () => page.evaluate(() => {
  const root = document.querySelector('.dshco-root')
  if (root === null) return { root: false }
  const rect = cls => { const node = root.querySelector('.' + cls); return node === null ? null : node.getBoundingClientRect() }
  const rootRect = root.getBoundingClientRect()
  const top = rect('dshco-top'); const mid = rect('dshco-mid'); const bot = rect('dshco-bot')
  const svg = rect('svg.dshco-svg')
  const sum = top.height + mid.height + bot.height
  return {
    root: true,
    rootH: Math.round(rootRect.height),
    top: Math.round(top.height),
    mid: Math.round(mid.height),
    bot: Math.round(bot.height),
    midPct: Math.round(mid.height / rootRect.height * 1000) / 10,
    sum: Math.round(sum),
    over: Math.round(sum - rootRect.height),
    botInside: bot.bottom <= rootRect.bottom + 1,
    svgInsideMid: svg === null ? null : (svg.bottom <= mid.bottom + 1 && svg.right <= mid.right + 1),
    stored: (() => { try { return localStorage.getItem('dshco.bands') } catch { return null } })(),
  }
})

const cases = [
  ['默认（没有存过比例）', null],
  ['曾经拖坏：top 70 / bot 20', { top: 70, mid: 10, bot: 20 }],
  ['曾经拖坏：top 5 / bot 90', { top: 5, mid: 5, bot: 90 }],
  ['极端：top 1 / bot 98', { top: 1, mid: 1, bot: 98 }],
]

for (const [label, planted] of cases) {
  await page.evaluate(value => {
    if (value === null) localStorage.removeItem('dshco.bands')
    else localStorage.setItem('dshco.bands', JSON.stringify(value))
  }, planted)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(9000)
  if (await page.locator('.dshco-root').count() === 0) {
    await fetch(`${apiBase}/coords/api/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    for (let i = 0; i < 20; i += 1) { if (await page.locator('.dshco-root').count() > 0) break; await page.waitForTimeout(1000) }
  }
  await page.waitForTimeout(1500)
  const m = await measure()
  console.log(`\n--- ${label} ---`)
  console.log(JSON.stringify(m))
  check(`${label}：结构成立（图 ≥38% · 三段合得上 · 不出容器 · 画布不越界）`,
    m.root === true && m.midPct >= 38 && Math.abs(m.over) <= 1 && m.botInside === true && m.svgInsideMid !== false,
    `top=${m.top} mid=${m.mid}(${m.midPct}%) bot=${m.bot} 越界=${m.over}px 画布=${m.svgInsideMid === null ? '空态无画布' : (m.svgInsideMid ? '在中带内' : '越界了')}`)
  if (planted !== null) {
    const healed = m.stored === null ? null : JSON.parse(m.stored)
    check(`${label}：歪值已自愈（写回合法区间）`,
      healed !== null && healed.top <= 22 && healed.bot <= 40 && healed.mid >= 38,
      `存回来的是 ${m.stored}`)
  }
  await page.screenshot({ path: `C:/Users/<用户>/.dsh-coords-verify/structfix-${label.replace(/[^\w\u4e00-\u9fa5]+/g, '_')}.png` })
}

console.log('\n=== 报错 ===', errors.slice(-5).join(' | ') || '(无)')
const bad = results.filter(r => !r.ok)
console.log(`\n${results.length - bad.length} PASS / ${bad.length} FAIL`)
await browser.close()
if (bad.length > 0) process.exitCode = 1
