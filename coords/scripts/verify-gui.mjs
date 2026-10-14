/**
 * 真机验收（端到端）：在隔离试运行实例上，
 *   ① 打开 GUI 与会话 → ② 用 host 的 /coords/api/open 事件让卡片自己弹出来
 *   → ③ 断言三段高度、2D 点云、下带点信息、3D 轴与坐标盒 → ④ 截图。
 *
 *   node verify-e2e.mjs <url-with-token> [apiBase]
 */
import { chromium } from 'playwright'

const url = process.argv[2]
const apiBase = process.argv[3] ?? 'http://127.0.0.1:3181'
if (url === undefined) throw new Error('用法：node verify-e2e.mjs <url-with-token> [apiBase]')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : '  ' + detail}`)
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 2400, height: 1100 } })
const logs = []
page.on('console', message => logs.push(`[${message.type()}] ${message.text().slice(0, 300)}`))
page.on('pageerror', error => logs.push(`[pageerror] ${String(error).slice(0, 400)}`))

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForTimeout(4000)

// ⓪ 先关掉「内测声明」弹窗：新浏览器 profile 每次都会弹，它带一层全屏 mask，
//    坐标点击会被 mask 吃掉（elementFromPoint 命中的是 ._mask_）—— 实测踩过，
//    表现为"脚本点不动卡片里的任何按钮"，但用户那边早就关过这个弹窗了。
const beta = page.locator('[role="dialog"] button:has-text("继续")').first()
if (await beta.count() > 0) {
  await beta.click({ timeout: 5000 }).catch(() => { })
  await page.waitForTimeout(600)
}
const maskGone = await page.evaluate(() => document.querySelector('[class*="mask"]') === null)
console.log(`· 内测声明弹窗已关：${maskGone}（全屏 mask ${maskGone ? '已消失' : '仍在，坐标点击会被吃掉'}）`)

// ① 开一个会话（better-sidebar 需要活动会话才显示 tab 条）
let opened = false
for (const label of ['在“Knowledge”中新建会话', '新建会话']) {
  const target = page.locator(`button[aria-label="${label}"]`).first()
  if (await target.count() > 0) { await target.click({ timeout: 8000 }).catch(() => { }); opened = true; break }
}
// 没有新建按钮（已有会话自动打开）也算开着了 —— 用右栏 tab 条作为判据
let tabBar = false
for (let i = 0; i < 30; i += 1) {
  tabBar = await page.evaluate(() => document.querySelector('[data-dockkit-add-tab], [data-slot="rightbar.session"] button[aria-label="新标签页"]') !== null)
  if (tabBar) break
  await page.waitForTimeout(1000)
}
// 右栏 tab 条只是过程观察，不当判定项：真正的判据是"卡片能不能开出来"（下一项）。
console.log(`· 右栏 tab 条可见：${tabBar}（${opened ? '点了新建会话' : '复用已打开的会话'}）`)

// ② 用 host 事件叫卡片出来（等同 agent 调 coords_open）
const fired = await fetch(`${apiBase}/coords/api/open`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: '' }),
}).then(async response => ({ status: response.status, body: await response.json() })).catch(error => ({ status: 0, error: String(error) }))
check('host /coords/api/open 推事件', fired.status === 200, JSON.stringify(fired).slice(0, 120))

// 等卡片真的出现（客户端 3s 轮询一次；没会话时它欠着，会话一出现就补开）
let appeared = false
for (let i = 0; i < 40; i += 1) {
  if (await page.locator('.dshco-root').count() > 0) { appeared = true; break }
  await page.waitForTimeout(1000)
}
check('卡片被自动打开（agent 唤出这条路走通）', appeared)
await page.waitForTimeout(2000)

// ③ 三段高度
const layout = await page.evaluate(() => {
  const root = document.querySelector('.dshco-root')
  if (root === null) return null
  const total = root.getBoundingClientRect().height
  const band = cls => {
    const node = root.querySelector('.' + cls)
    if (node === null) return null
    const rect = node.getBoundingClientRect()
    return { h: Math.round(rect.height), pct: Math.round(rect.height / total * 1000) / 10 }
  }
  return {
    total: Math.round(total),
    top: band('dshco-top'),
    mid: band('dshco-mid'),
    bot: band('dshco-bot'),
    title: root.innerText.split('\n').slice(0, 3).join(' | '),
  }
})
check('卡片渲染出 .dshco-root', layout !== null, JSON.stringify(layout))
if (layout !== null) {
  // 用户 2026-09-25 裁定：5% / 75% / 20%，但上带**必须装得下两行控件**（≥60px）——
  // 只按 5% 时第二行被裁、内部冒滚动条，就是"打开之后页面混乱"的来源。
  check('上带 ≥60px 且装得下内容', layout.top !== null && layout.top.h >= 60, `实测 ${layout.top?.h}px（${layout.top?.pct}%）`)
  check('下带 ≈20%', layout.bot !== null && layout.bot.pct >= 15 && layout.bot.pct <= 26, `实测 ${layout.bot?.pct}%`)
  check('中带拿走剩下的（≈75%）', layout.mid !== null && layout.mid.pct >= 65 && layout.mid.pct <= 82, `实测 ${layout.mid?.pct}%`)
}
// 三段之和必须正好等于卡片高度：多出来的部分会被 root 的 overflow:hidden 裁掉（实测下带曾多出 8px）
const bandsFit = await page.evaluate(() => {
  const root = document.querySelector('.dshco-root')
  if (root === null) return null
  const sum = ['dshco-top', 'dshco-mid', 'dshco-bot'].reduce((acc, cls) => acc + (root.querySelector('.' + cls)?.getBoundingClientRect().height ?? 0), 0)
  const h = root.getBoundingClientRect().height
  const bot = root.querySelector('.dshco-bot').getBoundingClientRect()
  return { sum: Math.round(sum), rootH: Math.round(h), over: Math.round(sum - h), botBottomInside: bot.bottom <= root.getBoundingClientRect().bottom + 1 }
})
check('三段之和 == 卡片高度（没有一段被挤出容器）', bandsFit !== null && Math.abs(bandsFit.over) <= 1 && bandsFit.botBottomInside === true, JSON.stringify(bandsFit))
// 上带不能有内部纵向滚动条（那是"内容装不下"的症状）
const topOverflow = await page.evaluate(() => {
  const top = document.querySelector('.dshco-top')
  return top === null ? null : { overflowY: top.scrollHeight - top.clientHeight }
})
check('上带没有内部纵向滚动（内容不再被裁）', topOverflow !== null && topOverflow.overflowY === 0, JSON.stringify(topOverflow))

// ③b 下带分两栏：左 30% 列表 / 右 70% 详情（用户 2026-09-25 裁定）
const columns = await page.evaluate(() => {
  const bot = document.querySelector('.dshco-bot')
  if (bot === null) return null
  const width = bot.getBoundingClientRect().width
  const left = bot.querySelector('.dshco-col.left')
  const right = bot.querySelector('.dshco-col.right')
  if (left === null || right === null) return { left: null, right: null }
  return {
    leftPct: Math.round(left.getBoundingClientRect().width / width * 1000) / 10,
    rightPct: Math.round(right.getBoundingClientRect().width / width * 1000) / 10,
    listInLeft: left.querySelector('.dshco-list') !== null,
    detailInRight: right.querySelector('.dshco-detail') !== null,
  }
})
check('下带两栏：左列约 30% 且装着列表', columns !== null && columns.leftPct >= 25 && columns.leftPct <= 35 && columns.listInLeft === true, JSON.stringify(columns))
check('下带两栏：右列约 70% 且装着详情', columns !== null && columns.rightPct >= 65 && columns.rightPct <= 75 && columns.detailInRight === true, JSON.stringify(columns))
await page.screenshot({ path: 'C:/Users/<用户>/.dsh-coords-verify/e2e-1-open.png' })

// ④ 先切 2D → 新建（清空）→ 示例：隔离实例与线上共用数据根，卡片可能自动
//    打开了真实那套 64 点 3D，不能假设起手是空白、也不能假设起手是 2D。
await page.locator('.dshco-root .dshco-seg button:has-text("2D")').first().click({ timeout: 5000 }).catch(() => { })
await page.waitForTimeout(500)
await page.locator('.dshco-root button:has-text("新建")').first().click({ timeout: 5000 }).catch(() => { })
await page.waitForTimeout(600)
await page.locator('.dshco-root button:has-text("示例")').first().click({ timeout: 5000 }).catch(() => { })
await page.waitForTimeout(1500)
const two = await page.evaluate(() => {
  const root = document.querySelector('.dshco-root')
  return root === null ? null : {
    points: root.querySelectorAll('circle.dshco-pt').length,
    items: root.querySelectorAll('.dshco-item').length,
    quadrants: root.querySelectorAll('rect').length,
    axisInputs: root.querySelectorAll('.dshco-axis .in').length,
    axisNums: root.querySelectorAll('.dshco-axis .num').length,
  }
})
check('2D 画出 8 个点 + 8 个列表项', two !== null && two.points === 8 && two.items === 8, JSON.stringify(two))
check('上带给出轴名与取值范围输入（2D 两根轴）', two !== null && two.axisInputs === 2 && two.axisNums === 4, JSON.stringify(two))
await page.screenshot({ path: 'C:/Users/<用户>/.dsh-coords-verify/e2e-2-2d.png' })

// ⑤ 点一个点 → 右列详情（数值块数量要跟当前轴数一致，别写死 2/3）
await page.locator('.dshco-root .dshco-item').first().click({ timeout: 5000 }).catch(() => { })
await page.waitForTimeout(800)
const detail = await page.evaluate(() => {
  const node = document.querySelector('.dshco-detail')
  const axes = document.querySelectorAll('.dshco-root .dshco-axis .in').length
  return node === null ? null : {
    values: document.querySelectorAll('.dshco-val').length,
    axes,
    inRight: document.querySelector('.dshco-col.right .dshco-detail') !== null,
    text: node.innerText.replace(/\n/g, ' | ').slice(0, 200),
  }
})
check('右列展示选中点的各轴数值（块数 = 轴数）', detail !== null && detail.values === detail.axes && detail.axes > 0 && detail.inRight === true, JSON.stringify(detail).slice(0, 200))
await page.screenshot({ path: 'C:/Users/<用户>/.dsh-coords-verify/e2e-3-2d-selected.png' })

// ⑥ 切 3D
await page.locator('.dshco-root .dshco-seg button:has-text("3D")').first().click({ timeout: 5000 }).catch(() => { })
await page.waitForTimeout(1500)
const three = await page.evaluate(() => {
  const root = document.querySelector('.dshco-root')
  if (root === null) return null
  const labels = Array.from(root.querySelectorAll('.dshco-axislabel')).map(node => node.textContent)
  return {
    points: root.querySelectorAll('circle.dshco-pt').length,
    // 选中那个点是单独画的高亮标记（不带 dshco-pt），所以点云数 = 总数 - 1
    selectedMarker: root.querySelectorAll('circle[stroke="#38d878"]').length,
    axisLabels: labels,
    axisInputs: root.querySelectorAll('.dshco-axis .in').length,
    items: root.querySelectorAll('.dshco-item').length,
  }
})
check('3D 画出点云与三条轴名', three !== null && (three.points + three.selectedMarker) === 8 && three.axisLabels.length === 3, JSON.stringify(three))
check('切到 3D 后上带变成三根轴', three !== null && three.axisInputs === 3)
await page.screenshot({ path: 'C:/Users/<用户>/.dsh-coords-verify/e2e-4-3d.png' })

// ⑦ 选点 → 坐标盒
await page.locator('.dshco-root .dshco-item').nth(1).click({ timeout: 5000 }).catch(() => { })
let box = { count: 0, dashed: 0, red: 0 }
for (let i = 0; i < 10; i += 1) {
  box = await page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll('.dshco-root polyline'))
    return {
      count: lines.length,
      dashed: lines.filter(node => node.getAttribute('stroke-dasharray') === '5 3').length,
      red: lines.filter(node => node.getAttribute('stroke') === '#d32f2f').length,
    }
  })
  if (box.count > 0) break
  await page.waitForTimeout(500)
}
const selectedName = await page.evaluate(() => document.querySelector('.dshco-detail .nm')?.textContent ?? '')
check('选中点画出坐标盒（6 条红色虚线）', box.count === 6 && box.dashed === 6 && box.red === 6, JSON.stringify(box) + ' 选中=' + selectedName)
await page.screenshot({ path: 'C:/Users/<用户>/.dsh-coords-verify/e2e-5-3d-box.png' })

// ⑧ 拖拽旋转：视角真的变了
const before = await page.evaluate(() => {
  const node = document.querySelector('.dshco-root svg.dshco-svg polyline')
  return node === null ? null : node.getAttribute('points')
})
const svg = page.locator('.dshco-root svg.dshco-svg')
const rect = await svg.boundingBox()
if (rect !== null) {
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
  await page.mouse.down()
  await page.mouse.move(rect.x + rect.width / 2 + 140, rect.y + rect.height / 2 + 30, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(800)
}
const after = await page.evaluate(() => {
  const node = document.querySelector('.dshco-root svg.dshco-svg polyline')
  return node === null ? null : node.getAttribute('points')
})
check('拖拽真的旋转了视角（坐标盒顶点变了）', before !== null && after !== null && before !== after, before === null ? '没有坐标盒可比较' : '')
await page.screenshot({ path: 'C:/Users/<用户>/.dsh-coords-verify/e2e-6-3d-rotated.png' })

// ⑨ 导入弹窗（文件 / 粘贴 / 交给会话识别三个入口都在）
await page.locator('.dshco-root button:has-text("导入")').first().click({ timeout: 5000 }).catch(() => { })
await page.waitForTimeout(800)
const dialog = await page.evaluate(() => {
  const modal = document.querySelector('.dshco-modal')
  if (modal === null) return null
  return {
    title: modal.querySelector('h3')?.textContent ?? '',
    fileInput: modal.querySelectorAll('input[type="file"]').length,
    textarea: modal.querySelectorAll('textarea').length,
    buttons: Array.from(modal.querySelectorAll('button')).map(node => node.innerText.trim()),
  }
})
check('导入弹窗给出文件 / 粘贴 / 交给会话识别三个入口',
  dialog !== null && dialog.fileInput === 1 && dialog.textarea === 1
  && dialog.buttons.includes('解析成坐标系') && dialog.buttons.includes('交给会话识别'),
  JSON.stringify(dialog))
await page.screenshot({ path: 'C:/Users/<用户>/.dsh-coords-verify/e2e-7-import.png' })
await page.keyboard.press('Escape').catch(() => { })
await page.locator('.dshco-modal button:has-text("关闭")').first().click({ timeout: 5000 }).catch(() => { })
await page.waitForTimeout(500)

// ⑩ 落盘：保存 → host 列表里真的出现 → 删掉（收尾不留垃圾）
const name = '验收-' + Date.now().toString(36)
await page.locator('.dshco-root .dshco-name').first().fill(name)
await page.waitForTimeout(300)
await page.locator('.dshco-root button:has-text("保存")').first().click({ timeout: 5000 }).catch(() => { })
await page.waitForTimeout(2000)
const saved = await fetch(`${apiBase}/coords/api/sets`).then(r => r.json()).catch(() => ({ sets: [] }))
check('保存真的落到 host（/sets 里出现）', (saved.sets ?? []).some(item => item.name === name), JSON.stringify((saved.sets ?? []).map(item => item.name)))
await page.screenshot({ path: 'C:/Users/<用户>/.dsh-coords-verify/e2e-8-saved.png' })
const removed = await fetch(`${apiBase}/coords/api/set?name=${encodeURIComponent(name)}`, { method: 'DELETE' }).then(r => r.json()).catch(() => null)
check('验收数据已清理（不留在用户的数据目录里）', removed !== null && removed.ok === true)

console.log('=== console（最后 15 条）===')
console.log(logs.slice(-15).join('\n'))
const bad = results.filter(item => !item.ok)
console.log(`\n${results.length - bad.length} PASS / ${bad.length} FAIL`)
await browser.close()
if (bad.length > 0) process.exitCode = 1
