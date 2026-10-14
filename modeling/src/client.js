/**
 * dsh-modeling 浏览器半段 —— `lib/client.js` 的**源码模板**，不直接运行。
 *
 * 由 `scripts/build.mjs` 生成 `lib/client.js`：把
 *   · `src/modeling.mjs`（共用模型，剥掉 export 关键字）
 *   · `src/client.dom.js`（画布与面板）
 * 内联进下面这个 `window.__ModuleLoader__.load({ factory })` 工厂里。
 *
 * 形状与 DSH 客户端模块加载器约定一致（与 dsh-workbench 同款）：
 *   factory(require) → { apply, inject, name }
 * React 从模块表 require（本插件不需要 portal，所以不 require react-dom）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-modeling',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')

    /* __INLINE_modeling.mjs__ */

    /* __INLINE_client.dom.js__ */

    /** 主面板 id（`main` 键控席位；同一 id 的面板只会有一个实例）。 */
    const PANEL_ID = 'dsh-modeling:center'
    /** 旧名保留：既有套件按这个出口读值，值就是主面板 id。 */
    const SIDEBAR_TAB_ID = PANEL_ID

    /**
     * 客户端需要的服务。
     *
     * ⚠️ `timer` **必须声明**。`ctx.interval()`（连同 timeout / throttle /
     * debounce）是 `@deepseek-ai/cordis-plugin-timer` 的 TimerService 通过
     * `ctx.mixin` 混进 Context 的，cordis 要求先列进 `inject` 才允许读：
     * 少了它运行时直接抛 `cannot get property "interval" without inject`，
     * 整个客户端插件树报 "Failed to load plugins"（实测踩过）。
     * 同理，**今后任何 `ctx.<名字>` 的直读都必须先在这里声明**。
     *
     * `betterSidebar` 已随席位迁移一并撤掉（2026-09-24 用户裁定：四个工作台改挂 DSH
     * WebUI 自带的席位）。现在只用官方服务：`ctx.slots`（主面板 = `main` 键控席位）。
     */
    const inject = ['slots', 'timer']

    /**
     * 客户端插件入口。
     *
     * 入口在左侧栏底部的图标行里（由 dsh-workbench 统一渲染三枚图标），本插件只负责
     * 把主面板注册上；图标形状由该图标行自己画（同图两份，改一起改）。
     *
     * @param ctx 客户端 cordis 上下文（slots / timer）
     */
    function apply(ctx) {
      // 样式随插件生命周期挂载 / 卸载（HMR 与禁用都不留残留）。
      const style = document.createElement('style')
      style.setAttribute('data-dsh-modeling', '')
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(() => () => { try { style.remove() } catch (e) { /* 已摘除 */ } })

      // ── 席位接线（2026-09-24 用户裁定）：建模中心 = **DSH 自带右侧栏的一个 Tab** ——
      //    类型进 `ctx.sidebarRightTabs`，正文进键控席位 `sidebar.right.pane.tab`（key = 类型 id），
      //    与官方 `ui-sidebar-documentpreview` / `ui-sidebar-files` 同一条公开路径。
      //    这样"全屏 / 双栏分屏 / 拖拽"直接吃官方那条栏自带的一套；左侧栏底部那一行只负责把它打开。
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
          title: () => '建模中心',
          guide: [{
            id: 'modeling', order: 41,
            title: () => '建模中心',
            description: () => '数据/服务架构与方法论建模（五层画布）',
            // 指南页入口卡上的图标（官方 IconProps：{size, className}）——没给的话官方画方块占位符。
            // 卡上用**彩色**那枚（官方那两张卡也是彩色）；单色的 iconModeling 留给标题条/左侧栏。
            icon: guideModeling,
          }],
        }))
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: PANEL_ID },
          () => React.createElement(ModelingCenter, { embedded: true }),
        )))
      }

      tryRegister()
      if (!registered) {
        // 官方右栏服务晚到位（激活顺序不保证）→ 每秒重试，最多 30 次；仍没有就静默降级（不报错）。
        let tries = 0
        const stopRetry = ctx.interval(() => {
          tries += 1
          tryRegister()
          if (registered || tries >= 30) { try { stopRetry() } catch (e) { /* 已停 */ } }
        }, 1000)
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-modeling'
    // 测试钩子（selftest-client.mjs 在 Node 里直接验证建模代数与组件树，
    // 无需浏览器、无需真 React）
    exports.__test = {
      AXIS, LEVEL_COUNT, PROFILES, ATTR_FIELDS, EDGE_TYPES, ORIENTATIONS, LEVEL_COLORS,
      profileOf, layerInfo, layerLabel, nodeTypesOf, nodeTypeOf, orientationOf,
      attrKeys, attrLabel, attrType, attrHasValue, attrCount,
      normalizeModel, layoutModel, auditModel, toMarkdown, toMermaid,
      newId, newNode, newEdge, emptyModel, defaultNodeType, coerceAttr,
      clip, nodeLines, edgePath, edgeMid, edgeRoute, api, CSS,
      metrics, COMPACT_MAX, positionMap, compactHint, viewLevelOf,
      ModelingCenter, Canvas, NodeInspector, EdgeInspector, AiDialog, iconModeling, guideModeling,
      SIDEBAR_TAB_ID,
      // 三段高度 / 四张卡宽度那套（自测 C-30/C-31 直接读这些名字，不靠 grep 渲染代码猜）
      BAND_TOP_PCT, BAND_BOT_PCT, BAND_TOP_MIN_PX, BAND_MID_MIN_PX, BAND_BOT_MIN_PX,
      CARD_SPLIT_PX, CARD_FR, CARD_MIN_PX, clampNum, readBands, readCardFr, frColumns,
    }
    return module.exports
  },
})
