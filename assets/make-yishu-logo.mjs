#!/usr/bin/env node
/**
 * make-yishu-logo.mjs —— 生成「弈枢」毛笔正楷水墨风名称图（背景透明）。
 *
 *   为什么要自己渲染、不用生图模型：**字形必须绝对正确**。「弈枢」是要挂到产品上的名字，
 *   生图模型对不常见的汉字经常写错（少笔、错字、糊成一团），而本机有楷体（`simkai.ttf`，正楷骨架），
 *   用「楷体字形 + 水墨滤镜」既能保证字形，又能做出毛笔的笔锋与飞白。
 *
 *   水墨处理（都是 SVG 滤镜，可复现、可微调）：
 *     ① feTurbulence + feDisplacementMap ⇒ 边缘不规则（机械字形 → 手写的抖动）
 *     ② 细颗粒噪声当遮罩，压出**飞白**（笔画里的干笔断续）
 *     ③ 柔化一层垫在下面 ⇒ 墨在宣纸上的洇
 *     ④ 两字分别给一点缩放/倾斜/错位 ⇒ 不是印刷排字，是两个字写出来的
 *
 *   产出两张（同一套字形，只换颜色）：
 *     · `yishu-logo-ink.png`   墨色（#1b1917）透明底 —— 给人看/别处用
 *     · `yishu-logo-mask.png`  纯白透明底，宽 480 —— 嵌进插件当 CSS mask（颜色由主题令牌给）
 *   用法：node make-yishu-logo.mjs [输出目录]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'

const HERE = import.meta.dirname
const OUT = process.argv[2] || path.join(HERE, 'out')
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']
  .find((p) => { try { return fs.existsSync(p) } catch { return false } })
const PORT = await new Promise((res) => { const s = net.createServer(); s.once('error', () => res(9812 + (process.pid % 40))); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'wblogo-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ws = null, id = 0
const pending = new Map()
const rpc = (m, p) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method: m, params: p })); setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error('timeout ' + m)) } }, 30000) })
async function ev(e) { const r = await rpc('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result?.value }
async function cleanup(code) {
  try { await Promise.race([rpc('Browser.close', {}), sleep(1200)]) } catch { }
  await sleep(200)
  try {
    const ps = spawnSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" | Where-Object { $_.CommandLine -like \'*' + path.basename(PROFILE) + '*\' } | ForEach-Object { $_.ProcessId }'], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
    String(ps.stdout || '').split(/\s+/).filter(Boolean).forEach((p) => spawnSync('taskkill', ['/F', '/T', '/PID', p], { stdio: 'ignore', windowsHide: true }))
  } catch { }
  try { fs.rmSync(PROFILE, { recursive: true, force: true }) } catch { }
  process.exit(code)
}

/** 生成一张：ink = 墨色 / mask = 白色（都带透明底）
 *  ⚠️ 画稿坐标系固定 1200×640（字的坐标写死在里面），**输出像素尺寸靠 `clip.scale` 缩放** ——
 *     第一版把 stage 尺寸当输出尺寸传进去，结果 mask 那张的 viewBox 只有 480 宽、第二个字跑到框外去了。 */
function html(color) {
  const W = 1200, H = 640
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent}
  #stage{width:${W}px;height:${H}px}
  svg{display:block}
  text{font-family:"KaiTi","楷体","STKaiti","Noto Serif SC",serif;fill:${color};stroke:${color};stroke-width:3;stroke-linejoin:round;stroke-linecap:round;paint-order:stroke fill}
</style></head><body><div id="stage">
<svg id="art" xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <!-- ① 边缘抖动：机械字形 → 手写（低频大幅 ⇒ 笔画有粗细起伏，不是均匀的"描边"） -->
    <filter id="ink" x="-14%" y="-14%" width="128%" height="128%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.010 0.016" numOctaves="3" seed="11" result="n1"/>
      <feDisplacementMap in="SourceGraphic" in2="n1" scale="17" xChannelSelector="R" yChannelSelector="G" result="warp"/>
      <!-- ③ 洇：柔化一层垫底，墨在宣纸上往外化一点 -->
      <feGaussianBlur in="warp" stdDeviation="3.2" result="soft"/>
      <feComponentTransfer in="soft" result="halo">
        <feFuncA type="linear" slope="0.26" intercept="0"/>
      </feComponentTransfer>
      <!-- ② 飞白：细颗粒噪声当遮罩，抠掉一部分墨（干笔的断续） -->
      <feTurbulence type="fractalNoise" baseFrequency="0.52 0.66" numOctaves="3" seed="5" result="n2"/>
      <feColorMatrix in="n2" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 3.4 -0.86" result="grainA"/>
      <feComposite in="warp" in2="grainA" operator="in" result="dry"/>
      <feMerge>
        <feMergeNode in="halo"/>
        <feMergeNode in="dry"/>
      </feMerge>
    </filter>
    <!-- 浓墨第二层：同一条抖动、收得更紧 ⇒ 笔道中间浓、边上薄 -->
    <filter id="core" x="-14%" y="-14%" width="128%" height="128%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.010 0.016" numOctaves="3" seed="11" result="n1"/>
      <feDisplacementMap in="SourceGraphic" in2="n1" scale="17" xChannelSelector="R" yChannelSelector="G" result="warp"/>
      <feGaussianBlur in="warp" stdDeviation="0.9" result="s"/>
      <feComponentTransfer in="s" result="hard">
        <feFuncA type="linear" slope="2.6" intercept="-0.62"/>
      </feComponentTransfer>
    </filter>
  </defs>
  <g id="glyphs">
    <text filter="url(#ink)"  x="300" y="470" font-size="392" text-anchor="middle" transform="rotate(-1.6 300 470)">弈</text>
    <text filter="url(#ink)"  x="880" y="474" font-size="406" text-anchor="middle" transform="rotate(1.1 880 474)">枢</text>
    <text filter="url(#core)" x="300" y="470" font-size="392" text-anchor="middle" transform="rotate(-1.6 300 470)">弈</text>
    <text filter="url(#core)" x="880" y="474" font-size="406" text-anchor="middle" transform="rotate(1.1 880 474)">枢</text>
  </g>
</svg></div></body></html>`
}

try {
  fs.mkdirSync(OUT, { recursive: true })
  spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
    '--force-device-scale-factor=1', '--hide-scrollbars', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--window-size=1400,760',
    'data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><title>logo</title>')], { stdio: 'ignore', windowsHide: true })
  for (let i = 0; i < 90; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const t = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl)
      if (t) {
        ws = new WebSocket(t.webSocketDebuggerUrl)
        await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
        ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(e.data) } catch { return } if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) } })
        await rpc('Runtime.enable', {}); await rpc('Page.enable', {})
        break
      }
    } catch { }
    await sleep(300)
  }
  // 透明底：把页面的默认背景设成全透明，截图才会带 alpha
  await rpc('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })

  const shots = [
    { file: 'yishu-logo-ink.png', color: '#1b1917', scale: 1 },
    { file: 'yishu-logo-mask.png', color: '#ffffff', scale: 0.26 },
  ]
  for (const s of shots) {
    const doc = html(s.color)
    await rpc('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(doc) })
    // ⚠️ 透明底必须**导航之后**再设一次：Page.navigate 会把上一次的覆盖重置掉
    //    （第一版就是在这里吃的亏：字形对了，但底是白的）
    await rpc('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
    await sleep(1000)
    // 按**墨迹实际外框**裁（getBBox 是未滤镜的用户单位，与像素 1:1：viewBox 与 svg 同尺寸）
    const box = JSON.parse(await ev(`(function(){
      var g=document.getElementById('glyphs').getBBox();
      var svg=document.getElementById('art').getBoundingClientRect();
      var pad=26;
      return JSON.stringify({ x: Math.max(0, svg.left+g.x-pad), y: Math.max(0, svg.top+g.y-pad), width: Math.min(svg.width, g.width+pad*2), height: Math.min(svg.height, g.height+pad*2) });
    })()`))
    const img = await rpc('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
      clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: s.scale },
    })
    const buf = Buffer.from(img.data, 'base64')
    fs.writeFileSync(path.join(OUT, s.file), buf)
    console.log(s.file + '  裁框 ' + Math.round(box.width) + '×' + Math.round(box.height) + ' @×' + s.scale
      + ' ⇒ ' + Math.round(box.width * s.scale) + '×' + Math.round(box.height * s.scale) + '  ' + buf.length + ' 字节  base64≈' + Math.round(buf.length * 4 / 3))
  }
  // 顺手报一下页面里有没有报错（字体没吃到会体现在字形上）
  console.log('就绪状态: ' + await ev(`document.fonts ? document.fonts.status : 'n/a'`))
  await cleanup(0)
} catch (e) { console.log('生成异常: ' + (e && e.message)); await cleanup(1) }
