/**
 * dsh-coords 浏览器半段 —— `lib/client.js` 的**源码模板**，不直接运行。
 *
 * 由 `scripts/build.mjs` 生成 `lib/client.js`：把
 *   · `src/coords.mjs`（共用代数，剥掉 export 关键字）
 *   · `src/client.dom.js`（卡片 UI）
 * 内联进下面这个 `window.__ModuleLoader__.load({ factory })` 工厂里。
 *
 * 形状与 DSH 客户端模块加载器约定一致（与 dsh-modeling / dsh-workdesktop 同款）：
 *   factory(require) → { apply, inject, name }
 * React 从模块表 require；本插件不用 portal，所以不 require react-dom。
 */
window.__ModuleLoader__.load({
  id: 'dsh-coords',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')

    /* __INLINE_coords.mjs__ */

    /* __INLINE_client.dom.js__ */

    /**
     * 客户端需要的服务。
     *
     * ⚠️ `timer` **必须声明**：`ctx.interval()` 是 TimerService 通过
     * `ctx.mixin` 混进 Context 的，cordis 要求先列进 `inject` 才允许读；
     * 少了它运行时直接抛 `cannot get property "interval" without inject`，
     * 整个客户端插件树报 "Failed to load plugins"。
     *
     * `betterSidebar` 已随席位迁移一并撤掉（2026-09-24 用户裁定）。现在只用官方服务：
     * `ctx.slots`（主面板 = `main` 键控席位）与 `ctx.layout`（切页），两者都由 DSH 自带包提供。
     *
     * ⚠️ 2026-09-25 修复：这里必须列全**所有被直接属性读取**的服务——cordis 严格模式下
     * 读未声明的服务会当场抛 `cannot get property "<name>" without inject`，整个客户端
     * 插件树报 "Failed to load plugins"：`slots`（apply 里注册席位）与 `sessions`
     * （pushToSession 读会话作用域）在 09-24 席位迁移后是直读但漏声明的，网页端启动
     * 即报 "1 entry did not activate"。
     *
     * 切页（`ctx.layout`）与放进输入框（`ctx.get('conversation')`）走 `ctx.get()`
     * 安全形式（读不到返回 undefined、调用方兜底），所以无需声明。
     */
    const inject = ['slots', 'sessions', 'timer']

    /**
     * 客户端插件入口。
     *
     * 图标：本插件不再自己画侧边栏图标（入口在左侧栏底部的图标行，由 dsh-workdesktop 统一
     * 渲染）；`iconCoords` 保留给探针 / 自测读形状，官方指南页入口卡用的是彩色那枚
     * `guideCoords`（同一份图形 + 一块紫色底板）。
     *
     * @param ctx 客户端 cordis 上下文（timer）
     */
    function apply(ctx) {
      // 样式随插件生命周期挂载 / 卸载（HMR 与禁用都不留残留）。
      const style = document.createElement('style')
      style.setAttribute('data-dsh-coords', '')
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(() => () => { try { style.remove() } catch (e) { /* 已摘除 */ } })

      // ── 席位接线（2026-09-24 用户裁定）：坐标系 = **DSH 自带右侧栏的一个 Tab** ——
      //    类型进 `ctx.sidebarRightTabs`，正文进键控席位 `sidebar.right.pane.tab`（key = 类型 id）。
      //    全屏 / 双栏分屏 / 拖拽都吃官方那条栏自带的一套；左侧栏底部那一行只负责把它打开。
      //    ⚠️ 不再注册 `main` 主面板（那会把中间的对话页换下去）。
      let registered = false
      function tryRegister() {
        if (registered) return
        // 非 WebUI 环境（没有渲染器）时静默降级：宁可什么都不注册，也不要让插件整体加载失败
        if (typeof ctx.slots?.inject !== 'function') return
        let tabs
        try { tabs = ctx.get('sidebarRightTabs') } catch (e) { tabs = undefined }
        if (tabs === undefined || tabs === null || typeof tabs.register !== 'function') return
        registered = true
        ctx.effect(() => tabs.register({
          id: PANEL_ID,
          kind: PANEL_ID,
          title: () => '坐标系',
          guide: [{
            id: 'coords', order: 32,
            title: () => '坐标系',
            description: () => '2D 四象限散点 / 3D 坐标系（点云 · 一点多看）',
            // 指南页入口卡上的图标（官方 IconProps：{size, className}）——没给的话官方画方块占位符
            // （用户 2026-09-25 截图反馈：四张卡都只有一个方块）。
            // 卡上用**彩色**那枚（官方那两张卡也是彩色）；单色的 iconCoords 留给标题条/左侧栏。
            icon: guideCoords,
          }],
        }))
        // 这一栏是**会话作用域**的席位 ⇒ 正文组件直接拿到 `sessionId`（root 作用域才需要自己去钩子取），
        // 按卡片原本的形状传 `{ sessionId }`（它要用它把识别提示词推回会话）。
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: PANEL_ID },
          function CoordsPanel(props) {
            const sessionId = props.sessionId
            return React.createElement(CoordsCenter, {
              ctx,
              scope: sessionId === undefined || sessionId === null ? undefined : { sessionId },
              embedded: true,
            })
          },
        )))
      }

      tryRegister()
      if (!registered) {
        // 官方右栏服务晚到位 → 每秒重试，最多 30 次；仍没有就静默降级（不报错）。
        let tries = 0
        const stopRetry = ctx.interval(() => {
          tries += 1
          tryRegister()
          if (registered || tries >= 30) { try { stopRetry() } catch (e) { /* 已停 */ } }
        }, 1000)
      }

      // host 事件轮询：agent 在会话里 coords_open / coords_save 时，卡片可能还没
      // 挂载，所以轮询必须在 apply 层就跑起来（组件只订阅结果）。
      ctx.effect(() => startHostEvents(ctx))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-coords'
    // 测试钩子（selftest-client.mjs 在 Node 里直接验证代数与组件树，
    // 无需浏览器、无需真 React）
    exports.__test = {
      MODES, AXIS_KEYS, AXIS_COLORS, AXIS_LABELS, TEMPLATES, DEFAULT_QUADRANTS, LIMITS,
      normalizeSpec, emptySpec, defaultAxes, normalizeAxis, normalizePoint,
      axisTicks, ratioOf, spanOf, formatValue, quadrantOf, auditSpec,
      parseTable, profileTable, guessAxes, specFromTable, specFromTemplate, sampleSpec,
      project2d, project3d, projectWorld, worldOf, worldPointOf, worldPointOfRaw, rotate3d, viewOf,
      guideBoxes, axisRails, toMarkdown, toCsv, buildRecognizePrompt, extractJson, slugOf, clip,
      CoordsCenter, TopBand, Canvas2D, Canvas3D, BottomBand, PointInspector, IntakeDialog, TemplateDialog,
      pushToSession, openCard, tryOpen, takePendingSetName, startHostEvents, hostEvents, iconCoords, guideCoords, CSS,
      pendingOpen, OPEN_EVENT_FRESH_MS, PENDING_OPEN_TTL_MS,
      BAND_TOP, BAND_MID, BAND_BOT, SIDEBAR_TAB_ID,
      // 分隔条拖动用的三件套（自测 C-31 直接读；纯函数，Node 里可测）
      BAND_TOP_PCT, BAND_MID_PCT, BAND_BOT_PCT, SPLIT_LEFT_PCT, clampNum,
      // 三段比例的合法区间 + "夹回 + 自愈"（自测 C-02c 守：歪值不许把结构压塌）
      sanityBands, readBands, readSplitL, TOP_MIN_PX,
      BAND_TOP_MIN_PCT, BAND_TOP_MAX_PCT, BAND_BOT_MIN_PCT, BAND_BOT_MAX_PCT, BAND_MID_MIN_FLOOR_PCT,
    }
    return module.exports
  },
})
