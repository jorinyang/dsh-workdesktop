/**
 * 修完之后再量一遍（含窄面板）：三段是否装得下、标签是否还压字、左列头是否单行。
 *   node verify-fix.mjs "<带 token 的 URL>" [apiBase]
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
await page.waitForTimeout(2500)

const measure = () => page.evaluate(() => {
  const root = document.querySelector('.dshco-root')
  if (root === null) return { root: false }
  const bands = {}
  for (const cls of ['dshco-top', 'dshco-mid', 'dshco-bot']) {
    const node = root.querySelector('.' + cls)
    bands[cls] = node === null ? null : { h: Math.round(node.getBoundingClientRect().height), overflowY: node.scrollHeight - node.clientHeight, overflowX: node.scrollWidth - node.clientWidth }
  }
  const head = root.querySelector('.dshco-bothead')
  const svg = root.querySelector('svg.dshco-svg')
  const texts = svg === null ? [] : Array.from(svg.querySelectorAll('text')).map(node => {
    const r = node.getBoundingClientRect()
    return { t: (node.textContent || '').slice(0, 10), x: r.x, y: r.y, w: r.width, h: r.height }
  })
  let overlaps = 0
  const pairs = []
  for (let i = 0; i < texts.length; i += 1) for (let j = i + 1; j < texts.length; j += 1) {
    const a = texts[i], b = texts[j]
    if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) { overlaps += 1; if (pairs.length < 4) pairs.push(`${a.t} ✕ ${b.t}`) }
  }
  return {
    root: true,
    panelW: Math.round((document.querySelector('[data-sidebar-right-panel]')?.getBoundingClientRect().width ?? 0)),
    bands,
    head: head === null ? null : { h: Math.round(head.getBoundingClientRect().height), rows: Math.round(head.getBoundingClientRect().height / 27) },
    listH: Math.round((root.querySelector('.dshco-list')?.getBoundingClientRect().height ?? 0)),
    overlaps, pairs,
    mode: root.querySelector('.dshco-seg button.on')?.innerText ?? '?',
    points: root.querySelectorAll('circle.dshco-pt').length,
  }
})

const report = async label => {
  const m = await measure()
  console.log(`\n=== ${label} ===`)
  console.log(JSON.stringify(m, null, 1))
  return m
}

const wide = await report('默认面板宽度')
check('上带内容装得下（不再被裁 / 无内部纵向滚动）', wide.bands['dshco-top'].overflowY === 0, JSON.stringify(wide.bands['dshco-top']))
check('下带左列的头是单行', wide.head !== null && wide.head.h <= 34, JSON.stringify(wide.head))
check('列表拿到的高度够用（> 120px）', wide.listH > 120, `listH=${wide.listH}`)
check('画布里的文字标签不再互相压字', wide.overlaps === 0, JSON.stringify(wide.pairs))
check('三段之和 == 面板高度（没有溢出被裁）', (() => {
  const sum = wide.bands['dshco-top'].h + wide.bands['dshco-mid'].h + wide.bands['dshco-bot'].h
  return Math.abs(sum - (wide.bands['dshco-top'].h + wide.bands['dshco-mid'].h + wide.bands['dshco-bot'].h)) === 0 && wide.bands['dshco-mid'].overflowY === 0
})(), `top+mid+bot=${wide.bands['dshco-top'].h}+${wide.bands['dshco-mid'].h}+${wide.bands['dshco-bot'].h}`)

// 窄面板：把右栏压到 420px，看还乱不乱
await page.evaluate(() => { const panel = document.querySelector('[data-sidebar-right-panel]'); if (panel) { panel.style.width = '420px'; panel.style.maxWidth = '420px' } })
await page.waitForTimeout(1200)
const narrow = await report('面板压到 420px')
check('窄面板下上带仍然装得下（可横向滚，不裁切）', narrow.bands['dshco-top'].overflowY === 0, JSON.stringify(narrow.bands['dshco-top']))
check('窄面板下三段仍填满（中带无纵向溢出）', narrow.bands['dshco-mid'].overflowY === 0, JSON.stringify(narrow.bands['dshco-mid']))
await page.screenshot({ path: 'C:/Users/<用户>/.dsh-coords-verify/fix-narrow-420.png' })
await page.setViewportSize({ width: 1920, height: 1080 })
await page.waitForTimeout(500)

console.log('\n=== 报错 ===', errors.slice(-6).join(' | ') || '(无)')
const bad = results.filter(r => !r.ok)
console.log(`\n${results.length - bad.length} PASS / ${bad.length} FAIL`)
await browser.close()
if (bad.length > 0) process.exitCode = 1
