/**
 * dsh-coords — 卡片的 DOM/React 代码（工厂内联用）。
 *
 * 本文件**不是模块**：`scripts/build.mjs` 把它与 `coords.mjs` 一起内联进
 * `lib/client.js` 的 `window.__ModuleLoader__.load({ factory })` 里，所以：
 *   · 只用 `React` 一个外部量（工厂从模块表 require 进来）；
 *   · 不写 import / export（内联后就是同一个函数作用域）；
 *   · 样式自带 `dshco-` 前缀并在 apply 时注入一次，卸载即移除。
 *
 * 版式按用户裁定：上 5% = 2D/3D 选择 + 维度（轴名/范围）+ 导入入口；
 * 中 75% = 坐标系图（2D 四象限散点 / 3D 可旋转坐标系）；下 20% = 点信息。
 */

/* ── 常量 ──────────────────────────────────────────────────────────────── */

/** 主面板 id（`main` 键控席位；同一 id 的面板只会有一个实例）。 */
const PANEL_ID = 'dsh-coords:center'
/** 旧名保留：既有套件按这个出口读值，值就是主面板 id。 */
const SIDEBAR_TAB_ID = PANEL_ID

/** 三段高度比例（用户 2026-09-25 裁定：上 5% / 中 75% / 下 20%）。自测 C-02 守这三个值。 */
const BAND_TOP = '5%'
const BAND_MID = '75%'
const BAND_BOT = '20%'
/** 同三个比例的**数字**形态（拖动分隔条时代替 CSS 用；与上面三行必须同步，自测 C-02 对账）。 */
const BAND_TOP_PCT = 5
const BAND_MID_PCT = 75
const BAND_BOT_PCT = 20
/** 下带左右两列的默认比例（左列占下带宽度的百分比）。 */
const SPLIT_LEFT_PCT = 30

/**
 * 三段比例的**合法区间**（2026-09-25 用户报"结构不对"后加的硬约束）。
 *
 * 为什么必须有：比例会被拖、也会存在 localStorage 里跨会话带来带去。一旦存进来的值很歪
 * （实测：`{top:70,mid:10,bot:20}`、`{top:5,mid:5,bot:90}`），结构就会塌 ——
 * 中带（图）被压到 120px 的 min-height 地板、三段之和超过容器高度、最后一段被裁掉。
 * 用户看到的就是"页面结构全乱了"。
 *
 * 规则：**中带永远是算出来的**（`mid = 100 - top - bot`，不再直接采用存进来的 mid），
 * 并且 top/bot 各自有上下限 —— 于是 mid 恒在 [100-22-40, 100-4-10] = [38, 86] 之间，
 * 图永远有足够高的一块。歪值会在读取时被夹回合法区间并**写回去自愈**。
 */
const BAND_TOP_MIN_PCT = 4
const BAND_TOP_MAX_PCT = 22
const BAND_BOT_MIN_PCT = 10
const BAND_BOT_MAX_PCT = 40
/** 中带（图）在任何情况下都必须留出的比例地板；top/bot 夹取后仍撞到它 ⇒ 整体回落默认值。 */
const BAND_MID_MIN_FLOOR_PCT = 38

/** 上带的最小高度（px）：装得下两行控件（24 + 3 间隙 + 22 + 10 内边距 = 59 ⇒ 60）。
 *  2026-09-25 实测的坑：上带按 5% 只有 52px，第二行被裁 7px、内部冒滚动条 —— 用户报的
 *  "打开之后页面混乱"就是这个。所以上带的 flex-basis 取 `max(5%, 60px)`：
 *  比例照旧（拖得动），但永远不小于内容所需。 */
const TOP_MIN_PX = 60

/** 「把这一栏打开」这类请求的时效（ms）：打不开就欠着补开，但**最多欠这么久**；
 *  首次拉取事件时也只认这么新的历史事件。两条都是 2026-09-25 用户报障"关了还一直弹"的修法。 */
const OPEN_EVENT_FRESH_MS = 15000
const PENDING_OPEN_TTL_MS = 20000

/** 数值夹紧（`clip` 是文本截断，不是这个用途）。 */
function clampNum(value, min, max) {
  if (!Number.isFinite(value)) return min
  return value < min ? min : (value > max ? max : value)
}

/**
 * 把任意一组比例夹到合法区间，并**由 top/bot 推出 mid**。
 * 传 null / 坏值 ⇒ 裁定默认值（5 / 75 / 20）。
 */
function sanityBands(input) {
  const topRaw = Number(input?.top)
  const botRaw = Number(input?.bot)
  if (!Number.isFinite(topRaw) || !Number.isFinite(botRaw)) {
    return { top: BAND_TOP_PCT, mid: BAND_MID_PCT, bot: BAND_BOT_PCT }
  }
  const top = clampNum(topRaw, BAND_TOP_MIN_PCT, BAND_TOP_MAX_PCT)
  const bot = clampNum(botRaw, BAND_BOT_MIN_PCT, BAND_BOT_MAX_PCT)
  if (top + bot > 100 - BAND_MID_MIN_FLOOR_PCT) {
    // 两个都顶到上限时给中带留出地板（正常情况下上面两个夹取已经保证了）
    return { top: BAND_TOP_PCT, mid: BAND_MID_PCT, bot: BAND_BOT_PCT }
  }
  return { top, mid: 100 - top - bot, bot }
}

/**
 * 读用户拖过的三段比例。
 * ⚠️ 存进来的 mid **不直接采用**（它由 top/bot 推出来）；歪值被夹回后**写回去自愈**，
 * 否则每次加载都要拿一个坏值重算一遍结构。
 */
function readBands() {
  let parsed = null
  try {
    const raw = lsGet('dshco.bands')
    if (raw !== null && raw !== '') parsed = JSON.parse(raw)
  } catch { parsed = null }
  const bands = sanityBands(parsed)
  const drifted = parsed !== null && (Number(parsed.top) !== bands.top || Number(parsed.bot) !== bands.bot)
  if (drifted) {
    try { lsSet('dshco.bands', JSON.stringify(bands)) } catch { /* 写不进去就只当本次有效 */ }
  }
  return bands
}

/** 读用户拖过的下带左右比例（越界 / 缺失 ⇒ 默认 30）。 */
function readSplitL() {
  const raw = lsGet('dshco.splitL')
  const value = raw === null || raw === '' ? NaN : Number(raw)
  return Number.isFinite(value) && value >= 12 && value <= 80 ? value : SPLIT_LEFT_PCT
}

/** 折线/虚线的统一视觉。 */
const GUIDE_COLOR = '#d32f2f'
const DASH = '5 3'

/* ── 样式 ──────────────────────────────────────────────────────────────── */

const CSS = `
/* 根容器：**留在文档流里**，不要 absolute + inset:0。
   better-sidebar 的面板结构是 .panel（position:absolute，flex column）：
       .panel ├── .tabBar(34px) └── .panelBody(flex:1，自身没有 position)
   本组件挂在 .panelBody 里；根容器一旦 absolute+inset:0，包含块会上溯到
   .panel，从面板顶端铺起，正好盖住 tab 条。 */
/* ★ 根容器必须**占满那一栏的高度**：三段比例是百分比，只有在父容器高度确定时才成立。
   2026-09-24 实测（真机 2400×1100，卡片挂在官方右栏里）：只写 flex:1 1 auto 时父容器不是
   flex ⇒ 根高变成**内容高**（实测 1775px）⇒ 三段比例全崩（上带 60px、中带只剩 min-height 120px、
   下带被列表撑到 1595px —— 用户看到的"结构不对"就是它）。补 height:100% 与官方右栏的
   pane 高度契约对齐（工作台面板的 .dshw-root.dshw-embedded 一直就是这么写的，所以它是满的）。
   ⚠️ 这段是模板字符串里的 CSS：注释里**绝不能出现反引号**，否则模板会被提前截断、
   整棵客户端插件树报 SyntaxError 加载失败（本轮真机实测踩到过）。*/
.dshco-root{position:relative;flex:1 1 auto;height:100%;display:flex;flex-direction:column;min-height:0;min-width:0;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font:var(--dsw-font-xxs-12,12px/1.5 system-ui,sans-serif);overflow:hidden}
.dshco-root *{box-sizing:border-box}
/* ── 分隔条（2026-09-25 用户裁定：三段高度 + 下带左右都能拖）────────────────
   走**绝对定位覆盖**在边界上：不占布局，所以三段百分比仍然精确（不会因为多出几条 7px 的条而溢出）。
   拖动按百分比换算，交界两侧的最小尺寸由 JS 夹住（上带 34px / 中带 120px / 下带 96px；
   左列 140px / 右列 160px）。双击复位到用户裁定的默认值。 */
.dshco-hsplit{position:absolute;left:0;right:0;height:7px;margin-top:-3.5px;z-index:6;cursor:row-resize;touch-action:none}
.dshco-vsplit{position:absolute;top:0;bottom:0;width:7px;margin-left:-3.5px;z-index:6;cursor:col-resize;touch-action:none}
.dshco-hsplit:hover,.dshco-vsplit:hover,.dshco-hsplit.on,.dshco-vsplit.on{background:var(--dsw-alias-brand-primary);opacity:.35}
body.dshco-dragging{user-select:none}
/* ── 上带：默认 5%，但**永远不小于两行控件所需的高度**（24 + 3 间隙 + 22 + 10 内边距 = 59 ⇒ 60）。
   2026-09-25 实测的真问题：上带是两行（第一行 模式/集合/名字/动作，第二行 三根轴的名称与范围），
   而 5% 在 1042px 面板上只有 52px ⇒ 第二行被裁掉 7px、上带里冒出一条内部滚动条 ——
   用户报的"打开之后页面是混乱的"就是这个（比例对了，内容装不下）。
   为什么把 min-height 加大**不会**像以前那样"把比例顶掉"：中带改成 flex:1 1 auto（吸收余量），
   上/下带撑出来的那几像素由中带让出去，三段之和恒等于容器高度，不再溢出。
   两行都必须能横向滚动（面板窄时按钮不换行、不裁切）。 */
.dshco-top{flex:0 0 5%;min-height:60px;display:flex;flex-direction:column;gap:3px;padding:5px 7px;
  overflow-x:auto;overflow-y:hidden;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dshco-row{display:flex;align-items:center;gap:4px;flex-wrap:nowrap;min-width:0}
.dshco-row.wrap{flex-wrap:wrap}
.dshco-seg{display:inline-flex;flex:0 0 auto;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;overflow:hidden}
.dshco-seg button{border:0;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);
  font:inherit;padding:2px 9px;cursor:pointer}
.dshco-seg button+button{border-left:1px solid var(--dsw-alias-border-l1)}
.dshco-seg button.on{background:var(--dsw-alias-interactive-bg-hover-accent,rgba(77,107,254,.16));color:var(--dsw-alias-brand-primary);font-weight:600}
.dshco-btn{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border-radius:6px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-primary);font:inherit;white-space:nowrap}
.dshco-btn:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-1))}
.dshco-btn.primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dshco-btn.sm{height:19px;padding:0 6px;font-size:11px}
.dshco-btn:disabled{opacity:.45;cursor:default}
.dshco-in,.dshco-sel{height:22px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;padding:0 6px;min-width:0}
.dshco-in:focus,.dshco-sel:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dshco-name{flex:0 1 130px;font-weight:600}
.dshco-sets{flex:0 1 150px}
.dshco-axis{display:inline-flex;align-items:center;gap:3px;flex:0 0 auto;padding:1px 5px;border-radius:5px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.dshco-axis .k{font-size:10px;font-weight:700}
.dshco-axis .in{width:74px;height:18px;font-size:11px;padding:0 4px}
.dshco-axis .num{width:46px;height:18px;font-size:11px;padding:0 4px}
.dshco-hint{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:10px}
/* ── 中带：**吸收余量**（flex:1 1 auto），不再写死 75%。
   写死 75% 时，上/下带一旦因为 min-height 变高，三者之和就超过容器高度 ⇒
   最后一段被裁（root overflow:hidden）—— 这就是"上带不能有 min-height"那条教训的根因。
   改成吸收余量后：上带 5%、下带 20% 仍然按比例走，中间那段拿剩下的，永远不会溢出。── */
.dshco-mid{flex:1 1 auto;min-height:120px;position:relative;overflow:hidden;
  background:var(--dsw-alias-bg-base)}
.dshco-svg{display:block;width:100%;height:100%}
.dshco-overlay{position:absolute;left:6px;right:6px;top:5px;display:flex;align-items:flex-start;gap:6px;pointer-events:none}
.dshco-legend{display:flex;flex-wrap:wrap;gap:6px;font-size:10px;
  color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:2px 6px;opacity:.94;pointer-events:auto}
.dshco-legend i{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:3px}
.dshco-viewbtn{margin-left:auto;pointer-events:auto}
.dshco-tip{position:absolute;z-index:3;pointer-events:none;max-width:230px;
  border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 6px;font-size:11px;line-height:1.45;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);
  box-shadow:var(--dsw-shadow-lv2,0 4px 14px rgba(0,0,0,.28))}
.dshco-notice{position:absolute;left:6px;right:6px;bottom:5px;z-index:4;display:flex;gap:6px;align-items:center;
  border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:3px 7px;font-size:11px;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dshco-notice.err{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dshco-notice .x{margin-left:auto;border:0;background:none;color:inherit;cursor:pointer;font:inherit;opacity:.6}
.dshco-axislabel{font:600 10px/1 system-ui}
.dshco-tick{font:9px/1 system-ui}
.dshco-pt{cursor:pointer}
.dshco-ptname{font:9px/1 system-ui}
.dshco-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:8px;text-align:center;padding:18px;color:var(--dsw-alias-label-secondary);pointer-events:none}
.dshco-empty .dshco-btn{pointer-events:auto}
/* ── 下带 20%：左 30% 列表 + 右 70% 详情（用户 2026-09-25 裁定）── */
.dshco-bot{position:relative;flex:0 0 20%;min-height:96px;display:flex;flex-direction:row;min-width:0;
  border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dshco-col{display:flex;flex-direction:column;min-width:0;min-height:0}
.dshco-col.left{flex:0 0 30%;border-right:1px solid var(--dsw-alias-border-l1)}
.dshco-col.right{flex:1 1 70%;overflow:auto}
/* 下带左列的头：搜索 + 分组筛选。**必须单行**并横向滚动 ——
   换行时 3 个 chip 会吃掉左列一半高度（实测 54/207），列表只剩一百来像素，看着就是"挤成一团"。 */
.dshco-bothead{display:flex;align-items:center;gap:4px;padding:4px 7px;flex:0 0 auto;
  flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dshco-bothead::-webkit-scrollbar{height:0}
.dshco-chip{height:19px;padding:0 7px;border-radius:10px;cursor:pointer;font:inherit;font-size:11px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.dshco-chip.on{color:var(--dsw-alias-label-primary);border-color:var(--dswco-chip-color,var(--dsw-alias-brand-primary));
  background:color-mix(in srgb, var(--dswco-chip-color,var(--dsw-alias-brand-primary)) 14%, transparent)}
.dshco-detail{flex:1 1 auto;min-height:0;overflow:auto;padding:7px 9px}
.dshco-detail.empty{display:flex;align-items:center;justify-content:center;text-align:center;
  color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;padding:12px}
.dshco-detailhead{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.dshco-detailhead .nm{font-weight:600}
.dshco-badge{font-size:10px;padding:1px 6px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1)}
.dshco-vals{display:flex;flex-wrap:wrap;gap:5px;margin-top:4px}
.dshco-val{display:flex;flex-direction:column;gap:1px;min-width:64px;padding:3px 7px;border-radius:6px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.dshco-val .k{font-size:9px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.dshco-val .v{font-size:13px;font-weight:600}
.dshco-note{margin-top:5px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}
.dshco-list{flex:1 1 auto;min-height:0;overflow:auto;padding:2px 0}
.dshco-item{display:flex;align-items:center;gap:6px;padding:3px 8px;cursor:pointer;font-size:11px;
  border-left:2px solid transparent}
.dshco-item:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.dshco-item.on{background:var(--dsw-alias-interactive-bg-hover-accent,rgba(77,107,254,.12));
  border-left-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.dshco-item .dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto}
.dshco-item .nm{flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshco-item .num{margin-left:auto;flex:0 0 auto;font:10px/1.4 ui-monospace,Consolas,monospace;
  color:var(--dsw-alias-label-secondary);white-space:nowrap}
/* ── 弹窗（导入 / 模板）── */
.dshco-modal{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;
  background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45));padding:18px}
.dshco-dialog{width:min(580px,92vw);max-height:86vh;display:flex;flex-direction:column;overflow:hidden;
  border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2);
  box-shadow:var(--dsw-shadow-lv3,0 12px 40px rgba(0,0,0,.35))}
.dshco-dialog h3{margin:0;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);
  font:var(--dsw-font-xs-strong-13,600 13px/1.4 system-ui)}
.dshco-dialog .body{padding:10px 12px;overflow:auto;min-height:0;display:flex;flex-direction:column;gap:8px}
.dshco-dialog .foot{display:flex;gap:6px;align-items:center;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1)}
.dshco-dialog .foot .push{margin-left:auto}
.dshco-field{display:flex;flex-direction:column;gap:3px}
.dshco-field label{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px}
.dshco-ta{width:100%;min-height:110px;resize:vertical;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:11px/1.5 ui-monospace,Consolas,monospace;padding:5px 7px}
.dshco-ta:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dshco-preview{border:1px solid var(--dsw-alias-border-l1);border-radius:6px;max-height:200px;overflow:auto}
.dshco-preview table{border-collapse:collapse;font-size:10px;width:100%}
.dshco-preview th,.dshco-preview td{border:1px solid var(--dsw-alias-border-l1);padding:2px 5px;text-align:left;white-space:nowrap}
.dshco-err{color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:1.5;word-break:break-word}
.dshco-warn{color:var(--dsw-alias-state-warn-primary);font-size:11px;line-height:1.5}
.dshco-tplrow{display:flex;align-items:center;gap:6px;padding:4px 2px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dshco-tplrow .nm{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`

/* ── 小组件与工具 ──────────────────────────────────────────────────────── */

const h = React.createElement

/** 浏览器存储／网络面（Node 自测会给 globalThis 补替身）。 */
const browser = {
  fetch: (...args) => globalThis.fetch(...args),
  localStorage: () => globalThis.localStorage,
}

/** 调 host 路由，非 2xx / 带 error 一律 throw。 */
function api(path, init) {
  const options = init ?? {}
  return browser.fetch('/coords/api' + path, {
    method: options.method || 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body,
  }).then(async (response) => {
    const text = await response.text()
    let data = null
    try { data = text === '' ? null : JSON.parse(text) } catch { throw new Error('host 返回了非 JSON（' + response.status + '）') }
    if (!response.ok) throw new Error((data && data.error) || ('HTTP ' + response.status))
    return data
  })
}

function lsGet(key) { try { return browser.localStorage()?.getItem(key) ?? null } catch { return null } }
function lsSet(key, value) { try { browser.localStorage()?.setItem(key, value) } catch { /* 隐私模式 */ } }

/** 颜色：分组按序取调色板（与 host 侧同一份 PALETTE）。 */
function groupColor(spec, groupId) {
  const group = spec.groups.find(item => item.id === groupId)
  if (group !== undefined && group.color) return group.color
  const index = spec.groups.findIndex(item => item.id === groupId)
  return PALETTE[(index < 0 ? 0 : index) % PALETTE.length]
}

/** 模式对应的轴（2D 取 x/y，3D 取 x/y/z）。 */
function axesOf(spec) { return spec.axes }

/** 一个点在列表里显示的数值串。 */
function valuesText(point, spec) {
  return spec.axes.map(axis => formatValue(axis, point.values[axis.key])).join(' · ')
}

/* ── 卡片主组件 ────────────────────────────────────────────────────────── */

/**
 * 「坐标系」tab 主体。
 *
 * @param props.ctx     客户端 cordis 上下文
 * @param props.scope   当前会话作用域（{sessionId, cwd}）
 * @param props.embedded 侧边栏嵌入态（true）
 */
function CoordsCenter(props) {
  const ctx = props.ctx
  const sessionId = props.scope?.sessionId
  const [boot, setBoot] = React.useState(() => ({ state: 'loading', error: '', meta: null }))
  const [sets, setSets] = React.useState([])
  const [spec, setSpec] = React.useState(null)
  const [selected, setSelected] = React.useState(null)
  const [notice, setNotice] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [intakeOpen, setIntakeOpen] = React.useState(false)
  const [tplOpen, setTplOpen] = React.useState(false)
  const [templates, setTemplates] = React.useState([])
  const [filter, setFilter] = React.useState({ q: '', group: '' })
  const [view, setView] = React.useState(() => ({ ...DEFAULT_VIEW }))
  const [compact, setCompact] = React.useState(false)
  const rootRef = React.useRef(null)
  const specRef = React.useRef(null)
  specRef.current = spec

  // ── 三条分隔条（2026-09-25 用户裁定：上/中/下三段高度可拖、下带左右两列宽度可拖）──
  //  比例与用户拖过的值都存 localStorage（刷新 / 换会话保持）；双击分隔条复位到裁定默认值。
  const [bands, setBands] = React.useState(() => readBands())
  const [splitL, setSplitL] = React.useState(() => readSplitL())
  const bandsRef = React.useRef(bands)
  const splitRef = React.useRef(splitL)
  bandsRef.current = bands
  splitRef.current = splitL
  const dragRef = React.useRef(null)

  React.useEffect(() => {
    const onMove = (event) => {
      const drag = dragRef.current
      if (drag === null) return
      // 换算成百分比再夹：夹的是**合法区间**（不是只夹像素下限）——
      // 只夹像素下限时能拖出 `{top:70,mid:10,bot:20}` 这种结构，中带（图）被压到 120px 地板、
      // 三段之和超过容器高度、最后一段被裁（用户报的"结构全乱"就是这么来的）。
      const pct = (px, whole) => (whole > 0 ? (px / whole) * 100 : 0)
      if (drag.kind === 'row') {
        const delta = pct(event.clientY - drag.y0, drag.height)
        if (drag.which === 'top') {
          // 上带：像素下限（装得下两行）与比例区间取交
          const top = clampNum(drag.bands.top + delta, Math.max(pct(TOP_MIN_PX, drag.height), BAND_TOP_MIN_PCT), BAND_TOP_MAX_PCT)
          setBands({ top, mid: 100 - top - drag.bands.bot, bot: drag.bands.bot })
        } else {
          const bot = clampNum(drag.bands.bot - delta, BAND_BOT_MIN_PCT, BAND_BOT_MAX_PCT)
          setBands({ top: drag.bands.top, mid: 100 - drag.bands.top - bot, bot })
        }
      } else {
        const left = clampNum(drag.splitL + pct(event.clientX - drag.x0, drag.width), pct(140, drag.width), 100 - pct(160, drag.width))
        setSplitL(left)
      }
    }
    const onUp = () => {
      if (dragRef.current === null) return
      dragRef.current = null
      document.body.classList.remove('dshco-dragging')
      // 落盘放在**松手**这一下（拖动过程中每帧写 localStorage 没必要，也拖慢手感）
      try {
        lsSet('dshco.bands', JSON.stringify(bandsRef.current))
        lsSet('dshco.splitL', String(Math.round(splitRef.current * 10) / 10))
      } catch { /* 写不进去就只当本次有效 */ }
    }
    // ⚠️ 自测里本组件的树是用**桩 React** 渲染的（没有真 window）⇒ 先确认这两个方法在，
    //    否则 `useEffect` 一跑就抛，把 C-06/C-12 那一族判成"组件坏了"。
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      if (typeof window.removeEventListener !== 'function') return
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [])
  /** 按住分隔条：记起点与当前比例（用 ref 读，避免闭包里拿到过期值）。 */
  const startDrag = (which, kind) => (event) => {
    const root = rootRef.current
    if (root === null) return
    const rect = root.getBoundingClientRect()
    event.preventDefault()
    dragRef.current = {
      which, kind, y0: event.clientY, x0: event.clientX,
      height: rect.height, width: rect.width,
      bands: { ...bandsRef.current }, splitL: splitRef.current,
    }
    document.body.classList.add('dshco-dragging')
  }
  const resetBands = () => {
    setBands({ top: BAND_TOP_PCT, mid: BAND_MID_PCT, bot: BAND_BOT_PCT })
    try { lsSet('dshco.bands', '') } catch { /* 忽略 */ }
  }
  const resetSplit = () => {
    setSplitL(SPLIT_LEFT_PCT)
    try { lsSet('dshco.splitL', '') } catch { /* 忽略 */ }
  }

  // 窄侧边栏里上带两行会被挤扁：先量一次宽度，按宽窄换排布。
  React.useEffect(() => {
    const element = rootRef.current
    if (!element) return undefined
    const measured = element.clientWidth
    if (Number.isFinite(measured) && measured > 0) setCompact(measured < 420)
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect?.width ?? element.clientWidth ?? 0
      if (width > 0) setCompact(width < 420)
    })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])

  /** 读一套已落盘的坐标系（host 不可达时用 localStorage 兜底，只读）。 */
  const openSet = React.useCallback(async (name) => {
    if (!name) return
    try {
      const data = await api('/set?name=' + encodeURIComponent(name))
      const next = normalizeSpec(data.spec, name)
      setSpec(next)
      lsSet('dshco.last', name)
      lsSet('dshco.cache.' + name, JSON.stringify(next))
      setSelected(null)
    } catch (error) {
      const cached = lsGet('dshco.cache.' + name)
      if (cached !== null) {
        try { setSpec(normalizeSpec(JSON.parse(cached), name)); setNotice({ text: 'host 没响应，显示本地缓存（只读）', err: true }) } catch { /* 缓存坏了就算了 */ }
      } else {
        setNotice({ text: '读不到这套坐标系：' + (error instanceof Error ? error.message : String(error)), err: true })
      }
    }
  }, [])

  const refreshSets = React.useCallback(async () => {
    try {
      const data = await api('/sets')
      setSets(data.sets ?? [])
      return data.sets ?? []
    } catch {
      return []
    }
  }, [])

  // 启动：取 meta（模板/限制/落盘目录）→ 取已有坐标系列表 → 打开上次那套。
  React.useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const meta = await api('/meta')
        if (!alive) return
        setBoot({ state: 'ready', error: '', meta })
        const list = await refreshSets()
        if (!alive) return
        // agent 刚"点名"要开的那一套优先（卡片是被这次 open 才创建的，它收不到那条事件）
        const wanted = takePendingSetName()
        const last = lsGet('dshco.last')
        const pick = (wanted && list.some(item => item.name === wanted))
          ? wanted
          : ((last && list.some(item => item.name === last)) ? last : (list[0]?.name ?? ''))
        if (pick) await openSet(pick)
      } catch (error) {
        if (!alive) return
        // host 半段没挂（没重启过 DSH）时不留白屏：给可操作的提示，而不是空转。
        setBoot({ state: 'offline', error: error instanceof Error ? error.message : String(error), meta: null })
      }
    })()
    return () => { alive = false }
  }, [openSet, refreshSets])

  // 订阅 apply 层的事件轮询：agent 落盘 → 刷新；agent 要求开卡 → 切到那一套。
  React.useEffect(() => {
    const off = hostEvents.subscribe(event => {
      if (event.type === 'save') { void refreshSets().then(() => { if (event.name) void openSet(event.name) }) }
      else if (event.type === 'open' && event.name) void openSet(event.name)
    })
    return off
  }, [openSet, refreshSets])

  /** 保存当前这套（host 落盘；失败如实说）。 */
  const save = React.useCallback(async (next) => {
    const payload = normalizeSpec(next ?? specRef.current, specRef.current?.name)
    payload.updatedAt = Date.now()
    setSpec(payload)
    setBusy(true)
    try {
      const data = await api('/set', { method: 'POST', body: JSON.stringify({ spec: payload }) })
      const saved = normalizeSpec(data.spec, payload.name)
      setSpec(saved)
      lsSet('dshco.last', saved.name)
      lsSet('dshco.cache.' + saved.name, JSON.stringify(saved))
      await refreshSets()
      const issues = Array.isArray(data.issues) ? data.issues : []
      setNotice({ text: `已保存 ${saved.name}（${saved.points.length} 个点）` + (issues.length > 0 ? ` · ${issues[0].text}` : ''), err: false })
    } catch (error) {
      setNotice({ text: '保存失败：' + (error instanceof Error ? error.message : String(error)), err: true })
    } finally {
      setBusy(false)
    }
  }, [refreshSets])

  /** 改一处 spec（点/轴/分组都走它），并同步到 state。 */
  const patch = React.useCallback((mutate) => {
    setSpec(current => {
      if (current === null) return current
      const draft = normalizeSpec(JSON.parse(JSON.stringify(current)), current.name)
      mutate(draft)
      return normalizeSpec(draft, current.name)
    })
  }, [])

  /** 换模式：按新模式重建轴（保留能对上的轴名与点值）。 */
  const switchMode = (mode) => {
    if (spec === null || spec.mode === mode) return
    const rebuilt = normalizeSpec({
      ...spec,
      mode,
      axes: MODES[mode].axisKeys.map((key, index) => {
        const found = spec.axes.find(axis => axis.key === key)
        return found ?? defaultAxes(mode)[index]
      }),
    }, spec.name)
    setSpec(rebuilt)
    setSelected(null)
  }

  const applyTemplate = async (id) => {
    try {
      const data = await api('/template?id=' + encodeURIComponent(id))
      const next = specFromTemplate(data.template, spec?.name ?? data.template.label)
      // 模板只换轴/分组/象限，点保留（用户多半是想换个骨架继续用同一批点）
      const merged = normalizeSpec({ ...next, name: spec?.name ?? next.name, points: spec?.points ?? [] }, next.name)
      setSpec(merged)
      setTplOpen(false)
      setNotice({ text: `已套用模板：${data.template.label}`, err: false })
    } catch (error) {
      setNotice({ text: '取模板失败：' + (error instanceof Error ? error.message : String(error)), err: true })
    }
  }

  const points = spec === null ? [] : spec.points
  const groups = spec === null ? [] : spec.groups
  const filteredPoints = points.filter(point => {
    if (filter.group !== '' && point.group !== filter.group) return false
    if (filter.q !== '' && !(point.name + ' ' + point.note + ' ' + point.group).toLowerCase().includes(filter.q.toLowerCase())) return false
    return true
  })
  const selectedPoint = points.find(point => point.id === selected) ?? null

  return h('div', { className: 'dshco-root', ref: rootRef },
    h(TopBand, {
      spec, sets, boot, busy, compact, templates,
      style: { flex: `0 0 max(${bands.top}%, ${TOP_MIN_PX}px)` },
      onMode: switchMode,
      onOpenSet: name => { void openSet(name) },
      onRename: name => patch(draft => { draft.name = name }),
      onAxis: (key, field, value) => patch(draft => {
        const axis = draft.axes.find(item => item.key === key)
        if (axis === undefined) return
        if (field === 'name' || field === 'unit') axis[field] = value
        else {
          const n = Number(value)
          if (Number.isFinite(n)) axis[field] = n
        }
        // 范围可能被改反：这里把 min/max 顺过来，别留给投影去处理。
        if (axis.max <= axis.min) {
          if (field === 'min') axis.max = axis.min + 1
          else axis.min = axis.max - 1
        }
      }),
      onSave: () => { void save(spec) },
      onIntake: () => setIntakeOpen(true),
      onTemplate: () => { void (async () => { try { const data = await api('/templates'); setTemplates(data.templates ?? []) } catch { setTemplates([]) } setTplOpen(true) })() },
      onSample: () => { setSpec(sampleSpec(spec?.mode ?? '2d')); setSelected(null); setNotice({ text: '已装载示例（未保存）', err: false }) },
      onDelete: () => { void (async () => {
        if (spec === null) return
        try {
          await api('/set?name=' + encodeURIComponent(spec.name), { method: 'DELETE' })
          setNotice({ text: `已删除 ${spec.name}`, err: false })
          const list = await refreshSets()
          if (list[0]) await openSet(list[0].name); else setSpec(emptySpec(spec.mode, '未命名坐标系'))
        } catch (error) { setNotice({ text: '删除失败：' + (error instanceof Error ? error.message : String(error)), err: true }) }
      })() },
      onNew: () => { setSpec(emptySpec(spec?.mode ?? '2d', '未命名坐标系')); setSelected(null) },
    }),

    // 上带与中带之间的分隔条（拖动改上带高度 / 双击复位）
    h('div', {
      className: 'dshco-hsplit', 'data-dshco-split': 'top', role: 'separator', 'aria-orientation': 'horizontal',
      // 与上带的 flex-basis 用**同一个表达式**，否则分隔条会浮在真正的接缝上方 8px
      title: '拖动改变上带高度（双击复位）', style: { top: `max(${bands.top}%, ${TOP_MIN_PX}px)` },
      onPointerDown: startDrag('top', 'row'), onDoubleClick: resetBands,
    }),

    h('div', { className: 'dshco-mid', style: { flex: '1 1 auto' } },
      spec === null
        ? h('div', { className: 'dshco-empty' },
          h('div', null, boot.state === 'offline' ? '坐标系卡片连不上 host 半段' : (boot.state === 'loading' ? '正在读取…' : '还没有坐标系')),
          boot.state === 'offline' && h('div', { className: 'dshco-hint' }, 'host 路由未挂载（装了插件但没重启 DSH 时会这样）：' + boot.error),
          h('div', { className: 'dshco-row' },
            h('button', { className: 'dshco-btn', type: 'button', onClick: () => setIntakeOpen(true) }, '导入内容'),
            h('button', { className: 'dshco-btn', type: 'button', onClick: () => { setSpec(emptySpec('2d', '未命名坐标系')); setSelected(null) } }, '新建空的'),
            h('button', { className: 'dshco-btn', type: 'button', onClick: () => { setSpec(sampleSpec('2d')); setSelected(null) } }, '看示例')))
        : (spec.mode === '3d'
          ? h(Canvas3D, { spec, selected, onSelect: setSelected, view, setView, compact })
          : h(Canvas2D, { spec, selected, onSelect: setSelected, compact })),
      spec !== null && h('div', { className: 'dshco-overlay' },
        h('div', { className: 'dshco-legend' },
          spec.axes.map(axis => h('span', { key: axis.key },
            h('i', { style: { background: (AXIS_COLORS[axis.key] || AXIS_COLORS.x).light } }),
            `${AXIS_LABELS[axis.key]} ${axis.name}`)),
          spec.groups.length > 0 && h('span', { style: { opacity: '.8' } }, '·'),
          spec.groups.map(group => h('span', { key: group.id },
            h('i', { style: { background: groupColor(spec, group.id) } }), group.label))),
        spec.mode === '3d' && h('button', {
          className: 'dshco-btn sm dshco-viewbtn', type: 'button',
          onClick: () => setView({ ...DEFAULT_VIEW }),
        }, '重置视角')),
      notice !== null && h('div', { className: 'dshco-notice' + (notice.err ? ' err' : '') },
        h('span', null, notice.text),
        h('button', { className: 'x', type: 'button', onClick: () => setNotice(null) }, '✕'))),

    // 中带与下带之间的分隔条（拖动改中带/下带高度 / 双击复位）
    h('div', {
      className: 'dshco-hsplit', 'data-dshco-split': 'bot', role: 'separator', 'aria-orientation': 'horizontal',
      title: '拖动改变中带 / 下带高度（双击复位）', style: { top: (bands.top + bands.mid) + '%' },
      onPointerDown: startDrag('bot', 'row'), onDoubleClick: resetBands,
    }),

    h(BottomBand, {
      spec, points: filteredPoints, total: points.length, groups, filter, setFilter,
      selected: selectedPoint, selectedId: selected, onSelect: setSelected,
      style: { flex: '0 0 ' + bands.bot + '%' }, splitL, startDrag, resetSplit,
    }),

    intakeOpen && h(IntakeDialog, {
      ctx, sessionId, spec, onClose: () => setIntakeOpen(false),
      onNotice: setNotice,
      onApply: next => { setSpec(next); setSelected(null); setIntakeOpen(false); setNotice({ text: `已从内容生成 ${next.points.length} 个点（还没保存）`, err: false }) },
    }),
    tplOpen && h(TemplateDialog, {
      templates, onClose: () => setTplOpen(false), onPick: applyTemplate,
      current: spec,
      onSaveAs: async label => {
        try {
          const data = await api('/template', { method: 'POST', body: JSON.stringify({ template: { ...spec, label, id: label, desc: spec.intent, spec } }) })
          setNotice({ text: `已存模板：${data.template.label}`, err: false })
          const list = await api('/templates')
          setTemplates(list.templates ?? [])
        } catch (error) { setNotice({ text: '存模板失败：' + (error instanceof Error ? error.message : String(error)), err: true }) }
      },
    }))
}

/* ── 上带：2D/3D + 维度 + 导入入口 ─────────────────────────────────────── */

function TopBand(props) {
  const { spec, sets, boot, busy, compact, onMode, onOpenSet, onRename, onAxis, onSave, onIntake, onTemplate, onSample, onDelete, onNew, style } = props
  const mode = spec?.mode ?? '2d'
  return h('div', { className: 'dshco-top', style },
    h('div', { className: 'dshco-row' + (compact ? ' wrap' : '') },
      h('div', { className: 'dshco-seg' },
        ['2d', '3d'].map(id => h('button', {
          key: id, type: 'button', className: mode === id ? 'on' : '',
          onClick: () => onMode(id), title: MODES[id].desc,
        }, MODES[id].label))),
      h('select', {
        className: 'dshco-sel dshco-sets', value: spec?.name ?? '',
        onChange: event => onOpenSet(event.currentTarget.value),
      },
      h('option', { value: '' }, sets.length === 0 ? '（还没有保存的坐标系）' : '打开已存的…'),
      sets.map(item => h('option', { key: item.name, value: item.name }, `${item.name}（${item.points}）`))),
      h('input', {
        className: 'dshco-in dshco-name', value: spec?.name ?? '', placeholder: '名字',
        onChange: event => onRename(event.currentTarget.value),
      }),
      h('button', { className: 'dshco-btn primary', type: 'button', disabled: busy || spec === null, onClick: onSave }, busy ? '保存中…' : '保存'),
      h('button', { className: 'dshco-btn', type: 'button', onClick: onIntake }, '导入'),
      h('button', { className: 'dshco-btn', type: 'button', onClick: onTemplate }, '模板'),
      h('button', { className: 'dshco-btn sm', type: 'button', onClick: onNew }, '新建'),
      h('button', { className: 'dshco-btn sm', type: 'button', onClick: onSample }, '示例'),
      spec !== null && sets.some(item => item.name === spec.name) && h('button', { className: 'dshco-btn sm', type: 'button', onClick: onDelete }, '删除')),
    h('div', { className: 'dshco-row' },
      spec === null
        ? h('span', { className: 'dshco-hint' },
          boot.state === 'offline'
            ? 'host 半段未挂载：装了插件但没重启 DSH 时会这样'
            : (boot.state === 'loading' ? '正在读取…' : '还没有坐标系：点「导入」把内容变坐标系，或点「示例」看效果'))
        : spec.axes.map(axis => h('span', { key: axis.key, className: 'dshco-axis' },
          h('span', { className: 'k', style: { color: (AXIS_COLORS[axis.key] || AXIS_COLORS.x).light } }, AXIS_LABELS[axis.key]),
          h('input', {
            className: 'dshco-in in', value: axis.name, title: '轴名（按内容自动匹配，可改）',
            onChange: event => onAxis(axis.key, 'name', event.currentTarget.value),
          }),
          h('input', {
            className: 'dshco-in num', type: 'number', value: axis.min, title: '取值范围下限',
            onChange: event => onAxis(axis.key, 'min', event.currentTarget.value),
          }),
          h('span', { className: 'dshco-hint' }, '–'),
          h('input', {
            className: 'dshco-in num', type: 'number', value: axis.max, title: '取值范围上限',
            onChange: event => onAxis(axis.key, 'max', event.currentTarget.value),
          })),
        h('span', { className: 'dshco-hint' }, `${spec.points.length} 个点`)))
  )
}

/* ── 中带：2D 画布 ─────────────────────────────────────────────────────── */

/** 量容器尺寸（SVG 用像素坐标画，避免缩放后线宽/字号失真）。 */
function useSize(ref) {
  const [size, setSize] = React.useState(() => ({ w: 0, h: 0 }))
  React.useEffect(() => {
    const element = ref.current
    if (!element) return undefined
    const measure = () => {
      const rect = element.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) setSize({ w: Math.round(rect.width), h: Math.round(rect.height) })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [ref])
  return size
}

/** 2D：平面四象限散点。横轴 x、纵轴 y，中点即象限分界。 */
function Canvas2D(props) {
  const { spec, selected, onSelect, compact } = props
  const ref = React.useRef(null)
  const size = useSize(ref)
  const [hover, setHover] = React.useState(null)
  const pad = { l: compact ? 28 : 36, r: 12, t: 14, b: 22 }
  const w = Math.max(1, size.w)
  const hgt = Math.max(1, size.h)
  const innerW = Math.max(1, w - pad.l - pad.r)
  const innerH = Math.max(1, hgt - pad.t - pad.b)
  const xAxis = spec.axes.find(axis => axis.key === 'x') ?? spec.axes[0]
  const yAxis = spec.axes.find(axis => axis.key === 'y') ?? spec.axes[1] ?? spec.axes[0]
  const px = ratio => pad.l + ratio * innerW
  const py = ratio => pad.t + (1 - ratio) * innerH
  const children = []

  // 四象限底色 + 角标
  const quadFills = ['rgba(56,170,110,.07)', 'rgba(77,107,254,.07)', 'rgba(120,130,150,.07)', 'rgba(211,47,47,.07)']
  const corners = [[pad.l, pad.t], [pad.l + innerW / 2, pad.t], [pad.l, pad.t + innerH / 2], [pad.l + innerW / 2, pad.t + innerH / 2]]
  spec.quadrants.forEach((quad, index) => {
    children.push(h('rect', {
      key: 'q' + quad.id, x: corners[index][0], y: corners[index][1],
      width: innerW / 2, height: innerH / 2, fill: quadFills[index],
    }))
    children.push(h('text', {
      key: 'qt' + quad.id, x: corners[index][0] + 6, y: corners[index][1] + (index < 2 ? 12 : innerH / 2 - 6),
      className: 'dshco-tick', fill: 'var(--dsw-alias-label-tertiary, #8b93a7)',
    }, quad.label))
  })

  // 刻度网格（x 轴的**最大值刻度不画文字**：它正好落在轴名那一格上，
  // 实测叠出 "5 ✕ 范围 S" 这种压字；轴名比重复一遍上限值更有信息量）
  const ticksX = axisTicks(xAxis)
  const ticksY = axisTicks(yAxis)
  for (const tick of ticksX) {
    const x = px(ratioOf(xAxis, tick))
    children.push(h('line', { key: 'gx' + tick, x1: x, y1: pad.t, x2: x, y2: pad.t + innerH, stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 1 }))
    if (tick >= xAxis.max) continue
    children.push(h('text', { key: 'tx' + tick, x, y: pad.t + innerH + 13, className: 'dshco-tick', textAnchor: 'middle', fill: 'var(--dsw-alias-label-tertiary, #8b93a7)' }, String(tick)))
  }
  for (const tick of ticksY) {
    const y = py(ratioOf(yAxis, tick))
    children.push(h('line', { key: 'gy' + tick, x1: pad.l, y1: y, x2: pad.l + innerW, y2: y, stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 1 }))
    children.push(h('text', { key: 'ty' + tick, x: pad.l - 4, y: y + 3, className: 'dshco-tick', textAnchor: 'end', fill: 'var(--dsw-alias-label-tertiary, #8b93a7)' }, String(tick)))
  }

  // 象限分界线（两轴中点）
  children.push(h('line', { key: 'midx', x1: px(0.5), y1: pad.t, x2: px(0.5), y2: pad.t + innerH, stroke: 'var(--dsw-alias-border-l2)', strokeWidth: 1, strokeDasharray: '3 3' }))
  children.push(h('line', { key: 'midy', x1: pad.l, y1: py(0.5), x2: pad.l + innerW, y2: py(0.5), stroke: 'var(--dsw-alias-border-l2)', strokeWidth: 1, strokeDasharray: '3 3' }))

  // 轴名：x 轴名放右下角（最大值刻度文字已让位），y 轴名**竖排**在左边缘 ——
  // 横排时它正好压住左上角那个象限标签（实测 "Ⅰ 金矿区 ✕ 成熟度 M"）
  children.push(h('text', { key: 'axname', x: pad.l + innerW, y: pad.t + innerH + 13, className: 'dshco-axislabel', textAnchor: 'end', fill: AXIS_COLORS.x.light }, xAxis.name))
  children.push(h('text', {
    key: 'ayname', x: 9, y: pad.t + innerH / 2, className: 'dshco-axislabel', textAnchor: 'middle', fill: AXIS_COLORS.y.light,
    transform: `rotate(-90 9 ${pad.t + innerH / 2})`,
  }, yAxis.name))

  // 点
  const sorted = spec.points.map(point => ({ point, at: project2d(point, spec) }))
  for (const item of sorted) {
    const cx = px(item.at.x)
    const cy = py(item.at.y)
    const on = selected === item.point.id
    children.push(h('circle', {
      key: 'p' + item.point.id, className: 'dshco-pt', cx, cy, r: on ? 6 : 4.5,
      fill: groupColor(spec, item.point.group),
      stroke: on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-base)', strokeWidth: on ? 2 : 1.2,
      onClick: () => onSelect?.(item.point.id),
      onMouseEnter: event => setHover({ point: item.point, x: event.clientX, y: event.clientY }),
      onMouseLeave: () => setHover(null),
    }))
    if (on || spec.points.length <= 12) {
      children.push(h('text', {
        key: 'n' + item.point.id, x: cx + 7, y: cy - 5, className: 'dshco-ptname',
        fill: on ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
      }, item.point.name))
    }
    if (on) {
      children.push(h('line', { key: 'dx' + item.point.id, x1: cx, y1: cy, x2: cx, y2: pad.t + innerH, stroke: GUIDE_COLOR, strokeWidth: 1, strokeDasharray: DASH }))
      children.push(h('line', { key: 'dy' + item.point.id, x1: pad.l, y1: cy, x2: cx, y2: cy, stroke: GUIDE_COLOR, strokeWidth: 1, strokeDasharray: DASH }))
    }
  }

  return h('div', { style: { position: 'absolute', inset: 0 }, ref },
    h('svg', { className: 'dshco-svg', width: w, height: hgt, viewBox: `0 0 ${w} ${hgt}`, style: { maxWidth: '100%', maxHeight: '100%' } }, children),
    hover !== null && h('div', {
      className: 'dshco-tip',
      style: {
        left: Math.max(4, Math.min((size.w || 200) - 200, hover.x - (ref.current?.getBoundingClientRect().left ?? 0) + 12)) + 'px',
        top: Math.max(4, hover.y - (ref.current?.getBoundingClientRect().top ?? 0) + 10) + 'px',
      },
    },
    h('div', { style: { fontWeight: 600 } }, hover.point.name),
    h('div', null, valuesText(hover.point, spec)),
    hover.point.group !== '' && h('div', { style: { opacity: .75 } }, spec.groups.find(group => group.id === hover.point.group)?.label ?? hover.point.group)))
}

/* ── 中带：3D 画布 ─────────────────────────────────────────────────────── */

/**
 * 3D：自绘投影（不引 three.js）。
 *
 * 参考实现（coord3d）用 three.js + OrbitControls；卡片里不能带 1.3MB 的
 * vendored 依赖，所以把同一套几何自己算：绕 Y 轴 yaw、绕 X 轴 pitch，
 * 带一点透视；拖拽旋转 / 滚轮缩放 / 右键平移 / 点击圆点看坐标 —— 交互语义
 * 与参考页一致。选中后画**坐标盒**：三条阶梯 + 三条闭合棱，全是红色虚线。
 */
function Canvas3D(props) {
  const { spec, selected, view, setView, compact } = props
  const ref = React.useRef(null)
  const size = useSize(ref)
  const [hover, setHover] = React.useState(null)
  const drag = React.useRef(null)
  const w = Math.max(1, size.w)
  const hgt = Math.max(1, size.h)
  const scale = Math.min(w, hgt) * 0.43
  const toX = value => w / 2 + value * scale
  const toY = value => hgt / 2 + value * scale

  // 世界坐标 → 屏幕像素
  const project = world => {
    const p = projectWorld(world, view)
    return { x: toX(p.x), y: toY(p.y), depth: p.depth }
  }

  const children = []
  const rails = axisRails(spec)
  const tickCount = compact ? 3 : 5

  // 底面网格（在最低的 y 平面上）
  const yAxis = spec.axes.find(axis => axis.key === 'y')
  const xAxis = spec.axes.find(axis => axis.key === 'x')
  const zAxis = spec.axes.find(axis => axis.key === 'z') ?? xAxis
  if (yAxis && xAxis && zAxis) {
    const floor = yAxis.min
    const gx = axisTicks(xAxis, tickCount)
    const gz = axisTicks(zAxis, tickCount)
    for (const x of gx) {
      const a = project(worldPointOfRaw({ x, y: floor, z: zAxis.min }, spec))
      const b = project(worldPointOfRaw({ x, y: floor, z: zAxis.max }, spec))
      children.push(h('line', { key: 'fgx' + x, x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 1 }))
    }
    for (const z of gz) {
      const a = project(worldPointOfRaw({ x: xAxis.min, y: floor, z }, spec))
      const b = project(worldPointOfRaw({ x: xAxis.max, y: floor, z }, spec))
      children.push(h('line', { key: 'fgz' + z, x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 1 }))
    }
  }

  // 三条轴 + 刻度 + 轴名
  for (const rail of rails) {
    const axis = spec.axes.find(item => item.key === rail.axis)
    const color = (AXIS_COLORS[rail.axis] || AXIS_COLORS.x).light
    const a = project(rail.from)
    const b = project(rail.to)
    children.push(h('line', { key: 'rail' + rail.axis, x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: color, strokeWidth: 1.6 }))
    // 箭头
    const angle = Math.atan2(b.y - a.y, b.x - a.x)
    const head = 7
    children.push(h('path', {
      key: 'head' + rail.axis,
      d: `M${b.x} ${b.y} L${b.x - head * Math.cos(angle - 0.4)} ${b.y - head * Math.sin(angle - 0.4)} L${b.x - head * Math.cos(angle + 0.4)} ${b.y - head * Math.sin(angle + 0.4)} Z`,
      fill: color,
    }))
    // 轴名往外让开一点（原来 6px，正好压在箭头尖上那枚刻度文字上：实测 "Y 轴 成熟度 M ✕ 5"）
    children.push(h('text', {
      key: 'al' + rail.axis,
      x: b.x + 14 * Math.cos(angle), y: b.y + 14 * Math.sin(angle) + (Math.sin(angle) > 0 ? 8 : -4),
      className: 'dshco-axislabel', fill: color, textAnchor: Math.cos(angle) < -0.3 ? 'end' : 'start',
    }, `${AXIS_LABELS[rail.axis]} ${axis.name}`))
    const ticks = axisTicks(axis, tickCount)
    for (const tick of ticks) {
      // 两端不画文字：min 那格三条轴的 "0" 会在原点挤成一坨（实测 3 处压字），
      // max 那格就是箭头尖、和轴名打架。中间刻度才是读数用的。
      if (Math.abs(tick - axis.max) < 1e-9 || Math.abs(tick - axis.min) < 1e-9) continue
      const values = {}
      for (const item of spec.axes) values[item.key] = item.min
      values[rail.axis] = tick
      const at = project(worldPointOfRaw(values, spec))
      children.push(h('circle', { key: 'tk' + rail.axis + tick, cx: at.x, cy: at.y, r: 1.6, fill: color, opacity: .8 }))
      children.push(h('text', {
        key: 'tkt' + rail.axis + tick, x: at.x + 4, y: at.y - 3, className: 'dshco-tick', fill: 'var(--dsw-alias-label-tertiary, #8b93a7)',
      }, String(tick)))
    }
  }

  // 选中点 → 坐标盒（三条阶梯 + 三条闭合棱，全部红虚线）
  const focus = spec.points.find(point => point.id === selected) ?? null
  if (focus !== null) {
    const box = guideBoxes(focus, spec)
    const drawPath = (points, key) => {
      const screen = points.map(project)
      children.push(h('polyline', {
        key, points: screen.map(p => `${p.x},${p.y}`).join(' '), fill: 'none',
        stroke: GUIDE_COLOR, strokeWidth: 1.2, strokeDasharray: DASH, opacity: .95,
      }))
    }
    box.stairs.forEach((stair, index) => {
      drawPath(stair.points, 'stair' + index)
      const color = (AXIS_COLORS[stair.axis] || AXIS_COLORS.x).light
      for (let i = 0; i < stair.points.length - 1; i += 1) {
        const at = project(stair.points[i])
        children.push(h('circle', { key: `anchor${index}-${i}`, cx: at.x, cy: at.y, r: 2.4, fill: color }))
      }
    })
    box.closers.forEach((closer, index) => drawPath(closer.points, 'closer' + index))
    const originAt = project(box.origin)
    children.push(h('circle', { key: 'origin', cx: originAt.x, cy: originAt.y, r: 2.2, fill: 'none', stroke: 'var(--dsw-alias-label-tertiary, #8b93a7)', strokeWidth: 1 }))
    if (!compact) {
      const labels = [['Xa', box.anchors.Xa], ['Ya', box.anchors.Ya], ['Za', box.anchors.Za]]
      labels.forEach(([label, world], index) => {
        const at = project(world)
        children.push(h('text', { key: 'an' + index, x: at.x + 3, y: at.y - 3, className: 'dshco-tick', fill: 'var(--dsw-alias-label-secondary)' }, label))
      })
    }
  }

  // 点云：远的先画（painter's algorithm），选中态最后画在最上层
  const projected = spec.points.map(point => ({ point, at: project(worldPointOf(point, spec)) }))
  projected.sort((a, b) => a.at.depth - b.at.depth)
  for (const item of projected) {
    if (item.point.id === selected) continue
    const r = 3.4 + (item.at.depth + 8) / 32
    children.push(h('circle', {
      key: 'p' + item.point.id, className: 'dshco-pt', cx: item.at.x, cy: item.at.y, r: Math.max(2.4, Math.min(5, r)),
      fill: groupColor(spec, item.point.group), stroke: 'var(--dsw-alias-bg-base)', strokeWidth: 1,
      onClick: event => { event.stopPropagation(); onSelectPoint(item.point.id) },
      onMouseEnter: event => setHover({ point: item.point, x: event.clientX, y: event.clientY }),
      onMouseLeave: () => setHover(null),
    }))
  }
  if (focus !== null) {
    const at = project(worldPointOf(focus, spec))
    children.push(h('circle', { key: 'sel', cx: at.x, cy: at.y, r: 6, fill: groupColor(spec, focus.group), stroke: '#38d878', strokeWidth: 2 }))
    children.push(h('text', { key: 'selname', x: at.x + 8, y: at.y - 6, className: 'dshco-ptname', fill: 'var(--dsw-alias-label-primary)' }, focus.name))
  }

  /** 点选：按投影距离取最近的点（阈值内才算）。 */
  function onSelectPoint(id) {
    props.onSelect?.(id)
  }

  const pick = (clientX, clientY) => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return null
    const x = clientX - rect.left
    const y = clientY - rect.top
    let best = null
    for (const item of projected) {
      const distance = Math.hypot(item.at.x - x, item.at.y - y)
      if (distance <= 9 && (best === null || distance < best.distance)) best = { id: item.point.id, distance }
    }
    return best === null ? null : best.id
  }

  const onPointerDown = event => {
    drag.current = { x: event.clientX, y: event.clientY, yaw: view.yaw, pitch: view.pitch, panX: view.panX, panY: view.panY, moved: 0, pan: event.button === 2 || event.shiftKey }
    try { event.currentTarget.setPointerCapture?.(event.pointerId) } catch { /* 无捕获能力 */ }
  }
  const onPointerMove = event => {
    if (drag.current === null) return
    const dx = event.clientX - drag.current.x
    const dy = event.clientY - drag.current.y
    drag.current.moved = Math.max(drag.current.moved, Math.hypot(dx, dy))
    if (drag.current.pan) {
      setView({ ...view, panX: drag.current.panX + dx / scale, panY: drag.current.panY + dy / scale })
    } else {
      // 只转视角：俯仰夹在 ±85°，避免翻面后读不出上下。
      const pitch = Math.max(-1.48, Math.min(1.48, drag.current.pitch + dy * 0.008))
      setView({ ...view, yaw: drag.current.yaw + dx * 0.01, pitch })
    }
  }
  const onPointerUp = event => {
    const state = drag.current
    drag.current = null
    if (state === null || state.moved > 4) return
    const id = pick(event.clientX, event.clientY)
    props.onSelect?.(id)
  }
  const onWheel = event => {
    const factor = event.deltaY > 0 ? 0.92 : 1.08
    setView({ ...view, zoom: Math.max(0.4, Math.min(2.6, view.zoom * factor)) })
  }

  return h('div', { style: { position: 'absolute', inset: 0 }, ref },
    h('svg', {
      className: 'dshco-svg', width: w, height: hgt, viewBox: `0 0 ${w} ${hgt}`,
      style: { cursor: drag.current === null ? 'grab' : 'grabbing', touchAction: 'none', maxWidth: '100%', maxHeight: '100%' },
      onPointerDown, onPointerMove, onPointerUp,
      onPointerLeave: () => { drag.current = null; setHover(null) },
      onWheel, onContextMenu: event => event.preventDefault(),
    }, children),
    compact ? null : h('div', { className: 'dshco-hint', style: { position: 'absolute', left: 6, bottom: 4 } },
      '拖拽旋转 · 滚轮缩放 · 右键/Shift 拖拽平移 · 点击圆点看坐标'),
    hover !== null && h('div', {
      className: 'dshco-tip',
      style: {
        left: Math.max(4, Math.min(w - 210, hover.x - (ref.current?.getBoundingClientRect().left ?? 0) + 12)) + 'px',
        top: Math.max(4, hover.y - (ref.current?.getBoundingClientRect().top ?? 0) + 10) + 'px',
      },
    },
    h('div', { style: { fontWeight: 600 } }, hover.point.name),
    h('div', null, valuesText(hover.point, spec))))
}

/* ── 下带：左列点列表（30%）· 右列点信息（70%）─────────────────────────── */

function BottomBand(props) {
  const { spec, points, total, groups, filter, setFilter, selected, selectedId, onSelect, style, splitL } = props
  // 拖动回调由父组件注入；单独渲染本组件时（自测 C-12/C-12b/C-13 就是这么干的）给个空实现，
  // 免得"没传就炸"——它只是分隔条的处理器，缺了不影响内容渲染。
  const startDrag = typeof props.startDrag === 'function' ? props.startDrag : () => () => { }
  const resetSplit = typeof props.resetSplit === 'function' ? props.resetSplit : () => { }
  const left = Number.isFinite(splitL) ? splitL : SPLIT_LEFT_PCT
  const leftStyle = { flex: '0 0 ' + left + '%' }
  // 下带中间的竖向分隔条（拖动改左右宽度 / 双击复位）—— 绝对定位覆盖在交界线上，不占布局
  const splitter = h('div', {
    className: 'dshco-vsplit', 'data-dshco-split': 'cols', role: 'separator', 'aria-orientation': 'vertical',
    title: '拖动改变左右宽度（双击复位）', style: { left: left + '%' },
    onPointerDown: startDrag('cols', 'col'), onDoubleClick: resetSplit,
  })
  if (spec === null) {
    // 空态也把两列与分隔条画出来：分隔条从一进来就能拖，不至于"等有数据了才出现"
    return h('div', { className: 'dshco-bot', style },
      h('div', { className: 'dshco-col left', style: leftStyle },
        h('div', { className: 'dshco-bothead' }, h('span', { className: 'dshco-hint' }, '还没有坐标系'))),
      splitter,
      h('div', { className: 'dshco-col right' },
        h('div', { className: 'dshco-detail empty' }, '先在上带导入内容，或打开一套已存的坐标系')))
  }
  return h('div', { className: 'dshco-bot', style },
    // 左列：搜索 / 分组筛选 / 点列表
    h('div', { className: 'dshco-col left', style: leftStyle },
      h('div', { className: 'dshco-bothead' },
        h('input', {
          className: 'dshco-in', style: { flex: '1 1 60px' }, placeholder: '搜点',
          value: filter.q, onChange: event => setFilter({ ...filter, q: event.currentTarget.value }),
        }),
        h('button', {
          className: 'dshco-chip' + (filter.group === '' ? ' on' : ''), type: 'button',
          onClick: () => setFilter({ ...filter, group: '' }),
        }, `全部 ${total}`),
        groups.map(group => h('button', {
          key: group.id, type: 'button', className: 'dshco-chip' + (filter.group === group.id ? ' on' : ''),
          style: { '--dswco-chip-color': groupColor(spec, group.id) },
          onClick: () => setFilter({ ...filter, group: filter.group === group.id ? '' : group.id }),
        }, `${group.label} ${spec.points.filter(point => point.group === group.id).length}`))),
      h('div', { className: 'dshco-list' },
        points.length === 0 && h('div', { className: 'dshco-hint', style: { padding: '8px' } },
          total === 0 ? '还没有点：点「导入」把内容变成坐标系' : '没有匹配的点'),
        points.map(point => {
          const quad = spec.mode === '2d' ? quadrantOf(point, spec) : null
          return h('div', {
            key: point.id, className: 'dshco-item' + (selectedId === point.id ? ' on' : ''),
            onClick: () => onSelect(point.id),
          },
          h('i', { className: 'dot', style: { background: groupColor(spec, point.group) } }),
          h('span', { className: 'nm' }, point.name),
          quad !== null && h('span', { className: 'dshco-hint' }, quad.label),
          h('span', { className: 'num' }, valuesText(point, spec)))
        }))),

    splitter,

    // 右列：选中那个点的全部信息
    h('div', { className: 'dshco-col right' },
      selected === null
        ? h('div', { className: 'dshco-detail empty' }, points.length === 0 ? '左边还没有点' : '点左边的点，这里显示它的各轴坐标、分组与说明')
        : h(PointInspector, { spec, point: selected, onClose: () => onSelect(null) })))
}

/** 下带的详情：选中那个点的全部信息（各轴数值 / 分组 / 象限 / 说明）。 */
function PointInspector(props) {
  const { spec, point, onClose } = props
  const quad = spec.mode === '2d' ? quadrantOf(point, spec) : null
  const group = spec.groups.find(item => item.id === point.group)
  return h('div', { className: 'dshco-detail' },
    h('div', { className: 'dshco-detailhead' },
      h('span', { className: 'nm' }, point.name),
      h('span', { className: 'dshco-badge', style: { borderColor: groupColor(spec, point.group) } }, group?.label ?? (point.group === '' ? '未分组' : point.group)),
      quad !== null && h('span', { className: 'dshco-badge' }, quad.label),
      h('button', { className: 'dshco-btn sm', style: { marginLeft: 'auto' }, type: 'button', onClick: onClose }, '取消选中')),
    h('div', { className: 'dshco-vals' },
      spec.axes.map(axis => h('div', { key: axis.key, className: 'dshco-val' },
        h('span', { className: 'k' }, `${AXIS_LABELS[axis.key]} ${axis.name}`),
        h('span', { className: 'v', style: { color: (AXIS_COLORS[axis.key] || AXIS_COLORS.x).light } }, formatValue(axis, point.values[axis.key]))))),
    point.note !== '' && h('div', { className: 'dshco-note' }, point.note))
}

/* ── 弹窗：导入 / 贴内容 / 识别 ────────────────────────────────────────── */

/**
 * 导入弹窗。两条出口，**都如实说明各自动了什么**：
 *   ① 解析成坐标系：确定性规则（表头→轴名、数值列→轴范围、分类列→分组），
 *      不调模型，立刻能画；
 *   ② 交给会话识别：内容先落进 `.dsh-coords/_sources/`，再把一段提示词塞进
 *      当前会话的输入框 —— 识别由这个会话的 agent 做（用户 2026-09-25 裁定：
 *      卡片里不做 AI 对话框，复用 DSH 会话）。
 */
function IntakeDialog(props) {
  const { ctx, sessionId, spec, onClose, onApply, onNotice } = props
  const [name, setName] = React.useState(() => (spec?.name ? `${spec.name} · 导入` : '导入的坐标系'))
  const [mode, setMode] = React.useState(() => spec?.mode ?? '2d')
  const [text, setText] = React.useState('')
  const [filename, setFilename] = React.useState('')
  const [base64, setBase64] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [preview, setPreview] = React.useState(null)

  const isXlsx = /\.(xlsx|xlsm)$/i.test(filename)

  const onFile = async event => {
    const file = event.currentTarget.files?.[0]
    if (!file) return
    setError('')
    setPreview(null)
    setFilename(file.name)
    try {
      if (/\.(xlsx|xlsm)$/i.test(file.name)) {
        const buffer = await file.arrayBuffer()
        setBase64(bytesToBase64(new Uint8Array(buffer)))
        setText('')
      } else {
        const content = await file.text()
        setText(content)
        setBase64('')
      }
    } catch (caught) {
      setError('读文件失败：' + (caught instanceof Error ? caught.message : String(caught)))
    }
  }

  const parse = async () => {
    setBusy(true); setError('')
    try {
      const data = await api('/parse', { method: 'POST', body: JSON.stringify({ filename: filename || `${name}.txt`, text, base64, mode, name }) })
      if (data.table === null) {
        setPreview({ kind: data.kind, note: data.note })
        setError('这份内容不是表格（md/txt 这类自由文本）—— 走「交给会话识别」那条路')
      } else {
        setPreview({ kind: data.kind, spec: normalizeSpec(data.spec, name), columns: data.columns, rowCount: data.rowCount })
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const handoff = async () => {
    setBusy(true); setError('')
    try {
      const data = await api('/intake', { method: 'POST', body: JSON.stringify({ filename: filename || `${name}.txt`, text, base64 }) })
      const prompt = buildRecognizePrompt({ mode, path: data.path })
      const pushed = pushToSession(ctx, sessionId, prompt)
      onNotice?.({
        text: pushed
          ? '已把内容存到 ' + data.path + '，识别提示词已放进输入框（回车发送即可）'
          : '已把内容存到 ' + data.path + '，但没接上会话输入框：把这段贴到对话里即可 —— ' + prompt,
        err: false,
      })
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const fields = []
  fields.push(h('div', { className: 'dshco-field', key: 'file' },
    h('label', null, '选文件（md / txt / json / csv / tsv / xlsx）'),
    h('input', { type: 'file', accept: '.md,.txt,.json,.csv,.tsv,.xlsx,.xlsm', onChange: onFile })))
  fields.push(h('div', { className: 'dshco-row', key: 'name' },
    h('div', { className: 'dshco-field', style: { flex: '1 1 100px' } },
      h('label', null, '坐标系名字'),
      h('input', { className: 'dshco-in', value: name, onChange: event => setName(event.currentTarget.value) })),
    h('div', { className: 'dshco-field' },
      h('label', null, '模式'),
      h('select', { className: 'dshco-sel', value: mode, onChange: event => setMode(event.currentTarget.value) },
        h('option', { value: '2d' }, '2D 四象限'),
        h('option', { value: '3d' }, '3D 坐标系')))))
  fields.push(h('div', { className: 'dshco-field', key: 'text' },
    h('label', null, isXlsx ? '已选 xlsx（正文在文件里，不用贴）' : '或者直接把内容贴在这里'),
    h('textarea', {
      className: 'dshco-ta', value: text, placeholder: '表格 / JSON / 一份说明都行；不是表格的内容会走「交给会话识别」',
      onChange: event => { setText(event.currentTarget.value); setBase64('') },
    })))
  if (error !== '') fields.push(h('div', { className: 'dshco-err', key: 'err' }, error))
  if (preview !== null && preview.spec !== undefined) fields.push(h('div', { className: 'dshco-field', key: 'preview' },
    h('label', null, '解析结果：' + preview.rowCount + ' 行 · 轴 = ' + preview.spec.axes.map(axis => `${axis.name}(${axis.min}–${axis.max})`).join(' / ') + ' · 分组 ' + preview.spec.groups.length + ' 个'),
    h('div', { className: 'dshco-preview' },
      h('table', null,
        h('thead', null, h('tr', null, preview.columns.slice(0, 6).map((column, index) => h('th', { key: index }, column.name)))),
        h('tbody', null, preview.spec.points.slice(0, 8).map(point => h('tr', { key: point.id },
          preview.columns.slice(0, 6).map((column, index) => h('td', { key: index }, cellText(preview.spec, point, index))))))))))

  const foot = []
  foot.push(h('button', { className: 'dshco-btn', type: 'button', disabled: busy || (text.trim() === '' && base64 === ''), onClick: parse }, busy ? '处理中…' : '解析成坐标系'))
  if (preview !== null && preview.spec !== undefined) {
    foot.push(h('button', { className: 'dshco-btn primary', type: 'button', onClick: () => onApply(preview.spec) }, '用这份结果开画'))
  }
  foot.push(h('button', { className: 'dshco-btn', type: 'button', disabled: busy || (text.trim() === '' && base64 === ''), onClick: handoff }, '交给会话识别'))
  foot.push(h('button', { className: 'dshco-btn push', type: 'button', onClick: onClose }, '关闭'))

  return h('div', { className: 'dshco-modal', onMouseDown: event => { if (event.target === event.currentTarget) onClose() } },
    h('div', { className: 'dshco-dialog' },
      h('h3', null, '导入内容 → 坐标系'),
      h('div', { className: 'body' }, fields),
      h('div', { className: 'foot' }, foot)))
}

/** 预览表格里第 index 列显示什么（0 = 点名，其后按轴顺序取数值）。 */
function cellText(spec, point, index) {
  if (index === 0) return point.name
  const axis = spec.axes[index - 1]
  return axis === undefined ? '' : formatValue(axis, point.values[axis.key])
}

/** 模板弹窗：预置 + 用户存的（历史记录）。 */
function TemplateDialog(props) {
  const { templates, onClose, onPick, onSaveAs, current } = props
  const [label, setLabel] = React.useState(() => (current?.name ?? ''))
  const rows = templates.map(template => h('div', { key: template.id, className: 'dshco-tplrow' },
    h('button', { className: 'dshco-btn', type: 'button', onClick: () => onPick(template.id) }, '套用'),
    h('span', { className: 'nm' }, template.label + (template.user ? '（我存的）' : '')),
    h('span', { className: 'dshco-hint' }, `${MODES[template.mode]?.label ?? template.mode} · ${template.desc ?? ''}`)))
  if (rows.length === 0) rows.push(h('div', { key: 'none', className: 'dshco-hint' }, '还没有模板'))
  rows.push(h('div', { key: 'save', className: 'dshco-field' },
    h('label', null, '把当前这套的轴 / 分组 / 象限存成模板（不存点）'),
    h('div', { className: 'dshco-row' },
      h('input', { className: 'dshco-in', style: { flex: '1 1 auto' }, value: label, onChange: event => setLabel(event.currentTarget.value) }),
      h('button', { className: 'dshco-btn', type: 'button', disabled: label.trim() === '', onClick: () => { void onSaveAs(label.trim()) } }, '存为模板'))))

  return h('div', { className: 'dshco-modal', onMouseDown: event => { if (event.target === event.currentTarget) onClose() } },
    h('div', { className: 'dshco-dialog' },
      h('h3', null, '坐标系模板'),
      h('div', { className: 'body' }, rows),
      h('div', { className: 'foot' },
        h('button', { className: 'dshco-btn push', type: 'button', onClick: onClose }, '关闭'))))
}

/* ── 会话联动 ──────────────────────────────────────────────────────────── */

/**
 * 把一段提示词放进当前会话的输入框（**不自动发送**）—— 「通过 agent 交互
 * 识别内容」的落点：识别交给这个会话的 agent，卡片只负责把内容与诉求摆好。
 * 服务缺失时返回 false，调用方把提示词原样给用户。
 */
function pushToSession(ctx, sessionId, prompt) {
  try {
    if (ctx === undefined || ctx === null || sessionId === undefined) return false
    const actx = ctx.sessions?.scope?.(sessionId)
    if (actx === undefined || actx === null) return false
    const conversation = ctx.get?.('conversation')
    const input = conversation?.input?.for?.(actx)
    if (input === undefined || input === null || typeof input.setDraft !== 'function') return false
    const current = input.state?.getSnapshot?.().draft ?? ''
    input.setDraft(current.trim() === '' ? prompt : `${current}\n\n${prompt}`)
    return true
  } catch (error) {
    try { console.warn('[dsh-coords] 放进输入框失败：', error) } catch { /* 忽略 */ }
    return false
  }
}

/** ArrayBuffer → base64（分块，避免大表把参数撑爆）。 */
function bytesToBase64(bytes) {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/**
 * host 事件轮询的客户端总线：apply() 里那个轮询把事件推进来，卡片订阅它。
 * 为什么需要它：agent 在会话里调 coords_save / coords_open 时，卡片组件可能
 * 还没挂载（tab 没开），所以轮询必须在 apply 层跑，组件只订阅结果。
 */
const hostEvents = {
  listeners: new Set(),
  since: 0,
  stopped: false,
  emit(event) { for (const listener of [...this.listeners]) { try { listener(event) } catch { /* 单个订阅者出错不影响其它 */ } } },
  subscribe(listener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  },
}

/**
 * 启动事件轮询（apply 层调用一次）。
 * host 半段没挂时第一个请求就 404 → 停掉轮询，不再打扰。
 *
 * 收到 `open` 事件时把**坐标系那一栏打开到屏上**（`ctx.sidebarRight.openTab`，官方右栏的公开入口）。
 * 那一栏是会话作用域的：页面刚加载 / 没有活动会话时 `openTab` 会抛（没有可落的面）⇒ 记 `pendingOpen`
 * 欠着，会话出现或下一轮轮询再补开（实测踩过：agent 说"图给你打开了"，而栏还折着、用户什么也看不到）。
 */
function startHostEvents(ctx) {
  // ⚠️ 首次拉取只当基线（只认"刚刚发生"的那几条），之后每轮才逐条执行。
  // 不这么做的话，页面每次加载都会把 host 里缓存的历史事件**重放**一遍：
  // 之前 agent 打开过的那些 open 事件会再执行一次 —— 用户体感就是"关掉的栏自己又弹出来"。
  let primed = false

  /** 补开欠着的那次；成功就把它清掉。**不清就会每 3 秒弹一次**（用户报障的根因）。 */
  const flushPending = () => {
    if (!pendingOpen.open) return
    if (Date.now() > pendingOpen.until) {
      // 过期就忘掉：别在用户几分钟后才切到某个会话时，突然把这一栏顶出来
      pendingOpen.open = false
      pendingOpen.name = ''
      return
    }
    if (tryOpen(ctx)) pendingOpen.open = false
  }

  const tick = async () => {
    if (hostEvents.stopped) return
    flushPending()
    try {
      const response = await browser.fetch(`/coords/api/events?since=${hostEvents.since}`, { cache: 'no-store' })
      if (!response.ok) { hostEvents.stopped = true; return }
      const data = await response.json()
      const rev = Number.isFinite(Number(data.rev)) ? Number(data.rev) : hostEvents.since
      const batch = data.events ?? []
      const first = !primed
      primed = true
      hostEvents.since = rev
      for (const event of batch) {
        const at = Number(event?.at)
        if (first && !(Number.isFinite(at) && Date.now() - at <= OPEN_EVENT_FRESH_MS)) continue
        if (event.type === 'open') openCard(ctx, event.name)
        hostEvents.emit(event)
      }
    } catch {
      // 一次网络抖动不算停：下一轮再试
    }
  }

  // 旧 better-sidebar 的"会话一出现就补开"订阅随该栏一起撤掉：主面板不依赖会话，tryOpen
  // 第一次就成；万一布局服务还没到位，下面 3 秒一轮的轮询会补上。

  void tick()
  if (typeof ctx?.interval === 'function') {
    const stop = ctx.interval(() => { void tick() }, 3000)
    return stop
  }
  return () => { hostEvents.stopped = true }
}

/** 欠着的"把坐标系那页切到屏上"的请求（布局服务还没到位时先记下，下一轮轮询补）。 */
const pendingOpen = { open: false, name: '', until: 0, nameUntil: 0 }

/** 事件里点名要打开的那套坐标系，留给"卡片刚挂载"这一帧消费（见 openCard）。
 *  同样有寿命：过期的名字丢掉，免得卡片几分钟后才挂载时莫名其妙切到旧目标。 */
function takePendingSetName() {
  const fresh = pendingOpen.nameUntil === 0 || Date.now() <= pendingOpen.nameUntil
  const name = fresh ? pendingOpen.name : ''
  pendingOpen.name = ''
  pendingOpen.nameUntil = 0
  return name
}

/** 现在就把坐标系那一栏打开/聚焦到屏上；服务或会话面还没到位时返回 false（不抛）。 */
function tryOpen(ctx) {
  let right
  try { right = ctx?.get?.('sidebarRight') } catch { right = undefined }
  if (right === undefined || right === null || typeof right.openTab !== 'function') return false
  try {
    // 走官方右栏的公开入口：需要时它自己会把这一栏展开（内容看不见就不算打开）
    right.openTab(PANEL_ID)
    return true
  } catch (error) {
    // 最常见的是"还没有会话面可落"（页面停在无会话态）⇒ 返回 false，由轮询补开
    return false
  }
}

/**
 * 把坐标系那页切到屏上；切不了就欠着，下一轮轮询 / 布局服务到位后再补。
 *
 * ⚠️ 事件里的 `name`（要顺带切到哪一套）必须**先存下来**：面板是这一刻才被切过来、下一帧才
 * 挂载，那时组件才会订阅 hostEvents —— 本次事件它收不到。所以名字存进 pendingOpen，由组件
 * 挂载时用 takePendingSetName() 取走。
 */
function openCard(ctx, name) {
  if (typeof name === 'string' && name !== '') {
    pendingOpen.name = name
    pendingOpen.nameUntil = Date.now() + PENDING_OPEN_TTL_MS
  }
  const ok = tryOpen(ctx)
  pendingOpen.open = !ok
  // 欠着的请求有**寿命**：过了就不补了（否则用户几分钟后才切会话时会被莫名其妙顶一下）
  if (!ok) pendingOpen.until = Date.now() + PENDING_OPEN_TTL_MS
  return ok
}

/* ── 图标（规范：16×16 viewBox、currentColor 描边、round 端点/连接、无填充）── */

/**
 * 「坐标系」卡片图标：三轴 + 一个带投影虚线的点。
 * 折叠态只显示它，所以必须在 16px 下也认得出。
 */
function iconCoords(size, className, glyph) {
  const s = size || 16
  return h('svg', {
    width: s,
    height: s,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.3,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    className: className || undefined,
    'data-dshco-glyph': glyph || undefined,
  },
  h('path', { key: 'axes', d: 'M3.2 2.4v10.4h10.2' }),
  h('path', { key: 'depth', d: 'M3.2 12.8 7.4 8.6' }),
  h('path', { key: 'dx', d: 'M10.3 12.8V6.1', strokeDasharray: '1.7 1.4' }),
  h('path', { key: 'dy', d: 'M3.2 6.1h7.1', strokeDasharray: '1.7 1.4' }),
  h('circle', { key: 'pt', cx: 10.3, cy: 6.1, r: 1.35 }))
}

/**
 * 指南页入口卡上的**彩色**图标（官方 `IconProps`：`{size, className}`）。
 *
 * 官方那两张卡就是这么画的 —— `FileTypeIcon kind="folder"` = 金色文件夹 + 白线，
 * `TerminalGuideIcon` = 深色圆角卡 + 白色提示符：**实色圆角底板 + 上面的图形画成白色**。
 * 四个工作台卡沿用同一套形状语法（28×28 画布，与官方同），只换底板颜色：
 * 工作台=蓝 · 驾驶舱=绿 · 坐标系=紫 · 建模中心=橙（前三个取官方设计变量）。
 * 紫色官方没有对应变量，沿用官方 `FileTypeIcon.module.css` 里同样的做法写死一个 rgb。
 *
 * ⚠️ tab 标题条 / 左侧栏那几处仍是上面那枚 16×16 单色 `currentColor` —— 与官方一致：
 *    官方也是两套（`TerminalIcon` 单色给标题条、`TerminalGuideIcon` 彩色给指南卡）。
 */
function guideCoords(props) {
  const given = props === null || props === undefined ? {} : props
  const size = Number.isFinite(given.size) ? given.size : 26
  return h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 28 28',
    fill: 'none',
    'aria-hidden': 'true',
    className: given.className || undefined,
    'data-dshco-glyph': 'coords',
    'data-dshco-guide': 'coords',
  },
  h('rect', {
    key: 'plate', x: 1.2, y: 1.2, width: 25.6, height: 25.6, rx: 7, fill: 'rgb(139, 118, 246)',
  }),
  h('g', {
    key: 'marks',
    transform: 'translate(4.8 4.8) scale(1.15)',
    stroke: '#fff',
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    style: { color: '#fff' },
  },
  h('path', { key: 'axes', d: 'M3.2 2.4v10.4h10.2' }),
  h('path', { key: 'depth', d: 'M3.2 12.8 7.4 8.6' }),
  h('path', { key: 'dx', d: 'M10.3 12.8V6.1', strokeDasharray: '1.7 1.4' }),
  h('path', { key: 'dy', d: 'M3.2 6.1h7.1', strokeDasharray: '1.7 1.4' }),
  h('circle', { key: 'pt', cx: 10.3, cy: 6.1, r: 1.35 })))
}
