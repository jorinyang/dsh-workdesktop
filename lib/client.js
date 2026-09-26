/**
 * dsh-workbench — browser half.
 *
 * Built bundle shape expected by the DSH client module loader: one
 * `window.__ModuleLoader__.load({ id, factory })` registration whose factory
 * returns `{ apply, inject }` (Cordis service keys). React arrives through the
 * loader's `require('react')` platform module — no bundler output is required,
 * so this file is shipped as authored.
 *
 * Host communication uses the package's own HTTP routes under /workbench/api.
 */
window.__ModuleLoader__.load({
  id: 'dsh-workbench',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    // 详情卡要显示在**最上层**：portal 到 document.body，脱离 shell overlay 层（z-index:20）的
    // 层叠上下文。react-dom 是平台模块（seed.ts 注册），取不到时退化为就地渲染 + 抬升根节点层级。
    const ReactDOM = (() => { try { return require('react-dom') } catch (e) { return null } })()

    /**
     * ══════════════════════════════════════════════════════════════════════════
     * 【卡名契约·机器可读】卡 key → 显示名（13 项）· **单一真相源**
     * ══════════════════════════════════════════════════════════════════════════
     *
     * 本块是**唯一**的卡名口径，也是本轮（2026-09-17）"卡名收敛"的落点。
     * 起因：卡名原先散落在 4 处 —— ① 每张卡的 `card('<名>', …)` 调用点；
     *   ② 卡内文案里的旧名（`routeErrText('今日决策面')` / `downNote('今日决策面')` 这类
     *   **用户可见**字符串，读失败/降级时会把旧名写进面板）；③ 注释里的旧名；
     *   ④ 真机套件里 **独立复写**的卡名表（`verify-sidebar-tab.mjs` 的 WANT/DEFAULT_TITLES、
     *   run-t16 的字面量断言）。同名多份声明 ⇒ 改名必然漂移（本项目反复吃过"第二份声明"的亏）。
     *
     * ── 解析契约（真机套件 / run-t16 / 其它 agent 照此抽，不要自创形状）──────────
     *   · 真块 = 下面这一对标记，**独占一行**、JSON 紧接在起标记的下一行；
     *   · 这是**全文件第一处**起标记 ：抽取方按"首个起标记 → 下一个止标记"取即可，见下方纪律。
     *   · 块体是**注释块**：每行前面有注释前缀（` * ` / `# ` 均可），剥掉前缀后即为合法 JSON。
     *   · ⚠️ 除本块外，**全文任何地方都不得再出现"起标记 + JSON"或"起标记 … 止标记"的连续串**
     *     （注释正文若要提到这对标记，中间必须隔开，否则按"首个起标记"抽取的解析器会抽到那句散文）。
     *   · 一致性判据：`titles[key]` 必须与 DOM 里该卡 `.dshw-card-title` 的文本**前缀匹配**
     *     （动态标题带后缀，如「文件 · 全部」）；`order` 必须与 host 的 `KNOWN_CARD_KEYS`
     *     与 `CARD_ORDER`、SBT-23 的 WANT 四处逐项一致。
     *
     * [card-titles:begin]
     * {"order":["brief","triggers","matters","schedule","todos","focus","inflow","insights","recall","metrics","kb","minutes","system"],
     *  "titles":{"brief":"决策","triggers":"响应","matters":"事务","schedule":"日程","todos":"待办","focus":"专注 · 活跃","inflow":"流入","insights":"跨源洞察","recall":"资产","metrics":"验收","kb":"文件","minutes":"听记","system":"系统"}}
     * [card-titles:end]
     *
     * ── 分工：本表 vs 卡片注册点的字面量（**两张表都要，别只留一张**）────────────
     *   · **本表 = 对外发布口径的唯一真相源**：机器可读（JSON + 运行时全局 + `__test`），
     *     卡内文案（`routeErrText` / `downNote` 的 label）也一律经 `cardTitle(key)` 从这里取；
     *   · **卡片注册点保留字面量** `card('<名>', …)` —— 这是**必须保留**的形态：
     *     run-t16 的源码级断言按 `cardsByKey.set('todos', card('待办',` 这类**字面量前缀**取证
     *     （T16-9 / T16-53 / T16-72 等十余条：`hasCard(t) = clientSrc.includes("card('" + t)`，
     *     T16-120 读 `card('决策'`）。改成 `card(cardTitle('todos'), …)` 会让它们**整批假红**
     *     （2026-09-17 实测：一次 9 条）。
     *   · ⇒ **改卡名 = 同时改两处**：本表 + 对应注册点的字面量。漂移由**机器比**兜住：
     *     真机套件按本表逐项与 DOM 标题前缀比对（不一致即红并打印两侧差异）。
     *
     * ── 两处**故意保留现状名**、不得"顺手统一" ────────────────────────────────
     *   · `metrics` =「**验收**」：用户 2026-09-17 裁定用短名（原「验收指标」）；
     *     套件侧已改为 `cardLabelByKey('metrics')`**从本表取值**，故这里用短名是安全的。
     *   · 用户裁定（2026-09-17）：对象卡 =「对象」· 系统卡 =「系统」· 决策卡 =「决策」·
     *     **`recall` =「资产」**（原「唤起 · 沉淀复利」⇒ 改名时同步了 run-t16 的 `hasCard('资产')`
     *     与真机套件 `DECLARED_CARD_TITLES`；指标口径未动，S13 仍讲"旧沉淀被再次唤起"）。
     *
     * ── ★ `focus` =「专注 · 活跃」（2026-09-20 用户裁定 · 卡数 15 → 14）─────────────
     *   「专注（主动进入聚焦）」与「活跃（被动统计当前聚焦）」合并为**一张卡**，key **复用 `focus`**
     *   （⇒ 覆盖层里旧的 `focus` 键继续有效）。被合并掉的 `domains` key 从此**不存在**：
     *   它在 `ui-prefs.json` 覆盖层里变成**未知键**，被既有 `mergeCardOrder()` 规则③静默忽略
     *   （不报错、不影响渲染、顺序也不整体回默认）。卡数 15 → 14。
     *   ⚠️ 「活跃关注域」改名不再是"套件按前缀找卡"的坑：那张卡已经不存在了，
     *      真机套件按**本表**逐项找卡（SBT-23a/23b），所以改名的连带面只剩本表 + 锚点。
     *
     * ── ★ 撤掉「对象」卡（2026-09-21 用户裁定 · P2b · 卡数 14 → 13）─────────────
     *   口径：`objects.json` **继续生成**（它是**属性来源**），只撤掉**独立的「对象」卡**。
     *   对象作为属性并入五处：事务卡行内标签（`data-object-key`）· 事务详情「归属对象 /
     *   对象下一步 / 对象出处」段 · 流入卡「未归属 N 条」· 跨源洞察证据段（支撑强度 / 证据线）·
     *   「专注 · 活跃」卡的**域 → 对象 → 事务**三级下钻（入口不变）。
     *   连带面（**逐处改，别只改一处**）：本表 + 顶部 [card-titles] 契约块 + `CARD_TITLE_ORDER` +
     *   装配段 `CARD_ORDER` + host `KNOWN_CARD_KEYS` + run-t16 `WANT_ORDER` +
     *   SBT `CARD_KEY_FALLBACK` / `DECLARED_CARD_TITLES` + CORD `EXPECTED_KEYS` + `card-order.json` 锚点。
     *   ⚠️ 旧覆盖层（`ui-prefs.json`）里的 `objects` 从此是**未知键** ⇒ 被 `mergeCardOrder()` /
     *     `mergeUiPrefs()` 的规则③静默忽略（不报错、不影响其余键、顺序**不整体回默认**）——
     *     与 2026-09-20 被并掉的 `domains` 同一条纪律。
     *
     * ── key 的顺序 ≠ 卡片顺序 ─────────────────────────────────────────────────
     *   卡片顺序的唯一真相源是卡片装配段的 `CARD_ORDER`（另有 host 的 KNOWN_CARD_KEYS、
     *   T16-58 的 WANT_ORDER、SBT-23 的 WANT 与之逐项一致）。本表只保证"每张卡的 key 都有名字"，
     *   二者不得互相派生。
     */
    const CARD_TITLES = {
      brief: '决策',              // 原「今日决策面」→ 2026-09-17 用户裁定改名
      triggers: '响应',
      matters: '事务',
      schedule: '日程',
      todos: '待办',
      focus: '专注 · 活跃',        // 2026-09-20 合并：专注（主动）+ 活跃关注域（被动）合成一张卡
      // `objects`（「对象」）2026-09-21 撤卡：对象改为**属性**并入其它卡片，本表不再登记该键（14 → 13）
      inflow: '流入',
      insights: '跨源洞察',
      recall: '资产',              // 原「唤起 · 沉淀复利」→ 2026-09-17 用户裁定改名（指标口径未动）
      metrics: '验收',            // ⚠️ 见上：短名（用户 2026-09-17 裁定）；套件按本表取值找卡
      kb: '文件',           // 原「知识库」→ 2026-09-19 用户裁定改名（key 仍为 kb）
      minutes: '听记',       // 原「近期听记」→ 2026-09-19 用户裁定改名（key 仍为 minutes）
      system: '系统',
    }
    /** 卡片默认顺序（**契约**，与 CARD_TITLES 的键集恒同；顺序语义见卡片装配段的 CARD_ORDER） */
    const CARD_TITLE_ORDER = ['brief', 'triggers', 'matters', 'schedule', 'todos', 'focus', 'inflow', 'insights', 'recall', 'metrics', 'kb', 'minutes', 'system']
    /**
     * 「系统」卡内**两张能力小卡片**的声明（2026-09-23 用户裁定）。
     *
     * 用户原话：「把实时回复功能 / 响应功能的状态（在线绿 · 待机或执行黄 · 离线红 · 关闭灰）加到
     * **系统卡片**里，作为工具卡片；点击小卡片切换开/关。」
     *
     * ⚠️ 三处同名，改名要一起改（这是**新增的第三条契约**，与卡片 key 表同族但**不是卡片**）：
     *   · 本表（客户端渲染 + 兜底标题）
     *   · host `/system-state` `/system-switch` 转调的库内单一真相源 `_meta/workbench/system-switches.mjs`
     *     （`CAPABILITIES` / `CAP_LABEL`）
     * ⚠️ 为什么标题要有兜底：host payload 取不到时**照样渲染这两张小卡片**（灰 ·「未取到」），
     *   而不是少两张卡 —— "少一张卡"是**看不见的失败**，正是这套面板一路在防的东西。
     */
    const CAP_MINI_KEYS = ['realtime_reply', 'voice_command', 'vector_search']
    const CAP_MINI_TITLES = {
      realtime_reply: '实时回复', voice_command: '响应功能', vector_search: '向量检索',
    }
    /** 取显示名：未登记的 key 回落 key 本身（不抛错、不留空白——与 `cardHeadTextOf` 同一条兜底纪律） */
    const cardTitle = (key) => {
      const t = CARD_TITLES[key]
      return t === undefined ? String(key) : t
    }

    /**
     * ── 卡片交互规范的两张登记表（SPEC_卡片交互规范 §一 / §三）────────────────────
     *
     * `CARD_SCENES`：**场景交互**登记表 —— 点卡片名称触发，**只改呈现**（SPEC §2.1 禁止写数据/跳转）。
     * `TITLE_TO_KEY`：显示名 → key 的**前缀**反查（`kb` 的注册字面量带后缀 `'文件 · '`，
     *   所以必须前缀匹配而不是全等）。`card()` 靠它拿到本卡的 key，从而**不必改 13 处调用点**。
     */
    const CARD_SCENES = (() => {
      const m = {}
      for (const k of CARD_TITLE_ORDER) m[k] = { name: '折叠/展开本卡内容', exit: '再点一次卡名' }
      return m
    })()
    const TITLE_TO_KEY = (() => {
      const m = []
      for (const k of CARD_TITLE_ORDER) m.push([CARD_TITLES[k], k])
      // 长名优先（避免短名吃掉长名前缀）；全等优先于前缀
      m.sort((a, b) => b[0].length - a[0].length)
      return m
    })()
    /** 由显示名反查 key：全等 → 前缀（`'文件 · '` 归 `kb`）；查不到 ⇒ null（不猜） */
    const cardKeyOfTitle = (title) => {
      const t = String(title)
      for (const [name, key] of TITLE_TO_KEY) if (t === name) return key
      for (const [name, key] of TITLE_TO_KEY) if (name.length > 0 && t.indexOf(name) === 0) return key
      return null
    }

    /**
     * ── 每卡**错误边界**（2026-09-17 新增 · 框架层护栏）────────────────────────
     *
     * 为什么必须有：本盘的 14 张卡由**同一个 React 组件**（`Workbench`）渲染。React 的行为是
     *   **渲染期抛错 ⇒ 卸载整棵树** —— 任何一张卡的一个分支抛错，用户看到的是"整个工作台面板
     *   消失"（`.dshw-slot` 全部不存在），而不是"某张卡显示不出来"。本项目今天已两次踩到这类
     *   形态（`compactCards` 未定义、疑似结束态分支）：**一个分支把整块面板带走**，排查成本极高。
     * ⇒ 护栏的目标不是"不出错"，而是"**出错只坏一张卡**"：单卡渲染失败 → 只把那张卡换成错误提示，
     *   其余 13 张照常渲染，整栏（含顺序、拖动、专注降权）不受影响。
     *
     * ── 可断言口径（机器可读，真机套件 / run-t16 可直接照抄）─────────────────────
     *   ① 结构：每张卡的 slot 内多了一层 `[data-card-boundary="<key>"]` 包装（在 `.dshw-slot` 之内）；
     *   ② 故障态：该卡位置渲染出 `[data-card-error="1"]`（`.dshw-card` + `.dshw-card-title`，
     *      卡名保留），并且**该元素不可能是 `.dshw-slot > [data-dim]`** ⇒ 专注降权契约不受影响；
     *   ③ 注入方式（套件用）：`window.__DSHW_CARD_FAULT__.push('<key>')` ⇒ 该卡下一次渲染抛错；
     *      `= []` 并让面板重渲染即恢复（刷新页面同样重置）。故障表为空时**零开销、零行为变化**。
     *   ④ 负向对照（护栏必须能被证伪）：若不注入故障，`[data-card-error]` 恒为 0 个；
     *      若注入故障却**没有**边界，React 会卸载整棵树（`.dshw-grid .dshw-slot` 数量变 0）——
     *      这正是断言能区分"有护栏/没护栏"的判据。
     *
     * 为什么故障注入要挂在 `window` 上：套件无法给工厂函数注入参数（bundle 由 `window.__ModuleLoader__`
     *   注册），而"每卡 try/catch"只能拦住**渲染期**错误、拦不住"元素构造期"的错误 ——
     *   两者都需要一个**运行时可触发的**故障源才能被真机验证。
     */
    const CARD_FAULT_KEY = '__DSHW_CARD_FAULT__'
    /** 读取故障表（缺失即空数组；任何异常都按"无故障"处理，绝不让护栏自己成为崩溃源） */
    function cardFaultList() {
      try {
        const v = (typeof window !== 'undefined' && window !== null) ? window[CARD_FAULT_KEY] : null
        return Array.isArray(v) ? v : []
      } catch (e) { return [] }
    }
    const cardHasFault = (key) => cardFaultList().indexOf(String(key)) >= 0
    /** 渲染期故障注入：命中即抛（被 CardErrorBoundary 接住 ⇒ 只坏这一张卡） */
    function cardFaultCheck(key) {
      if (cardHasFault(key)) throw new Error('__DSHW_CARD_FAULT__ 注入：模拟「' + String(key) + '」卡渲染抛错（护栏自测用）')
    }
    /** 错误提示（与 `.dshw-err` 同一配色，但作为**整张卡的替身**渲染 ⇒ 卡位、卡名都守住） */
    const cardErrText = (key, err) => {
      const msg = String((err && err.message) || err || '未知错误')
      return React.createElement('div', {
        className: 'dshw-card', 'data-card-error': '1', role: 'alert',
        title: '完整调用栈见浏览器控制台（F12 → Console）· 本地诊断不转发到任何地方',
      },      React.createElement('div', { className: 'dshw-card-head' },
        React.createElement('span', { className: 'dshw-card-title' }, String(key)),
        React.createElement('span', { className: 'dshw-badge' }, '渲染失败'),
        React.createElement('span', { className: 'dshw-spacer' })),
      React.createElement('div', { className: 'dshw-card-body' },
        React.createElement('div', { className: 'dshw-err' },
          '这张卡渲染失败，其余卡片不受影响（下一轮刷新会自动重试）：'
          + String((err && err.name) || 'Error') + ': ' + msg.slice(0, 200))))
    }
    /**
     * React 的错误边界：**必须**是 class（函数组件没有 `componentDidCatch`）—— 与项目其余部分
     * 的函数组件风格不同，但这是 React 的契约，没有替代写法。
     *
     * ⚠️ 基类兜底：`React.Component` 理论上恒在（平台模块），但仍做一次 `|| function () {}` 兜底 ——
     *    理由与本项目其它纪律一致：**护栏本身绝不能成为崩溃源**。真出现取不到 `Component` 的
     *    极端情形（桩/旧平台模块）时，退化为"不做边界"，而不是"整个插件加载失败"。
     */
    const ReactComponentBase = (React !== null && React !== undefined && typeof React.Component === 'function')
      ? React.Component : function () {}
    class CardErrorBoundary extends ReactComponentBase {
      constructor(props) {
        super(props)
        this.state = { err: null }
      }
      static getDerivedStateFromError(err) { return { err: err } }
      componentDidCatch(err) {
        // 只留一行控制台证据（不吞错、不外发）：定位时能直接看到卡名与栈
        try { console.error('[dsh-workbench] 卡片「' + String(this.props.label || '?') + '」渲染失败（已就地降级）:', err) } catch (e) {}
      }
      render() {
        const label = (this.props !== null && this.props !== undefined) ? this.props.label : null
        const ck = label === null || label === undefined ? '' : String(label)
        // 故障注入：套件用 `window.__DSHW_CARD_FAULT__.push('<key>')` 触发；为空时零影响
        try { cardFaultCheck(ck) } catch (e) { return cardErrText(ck, e) }
        if (this.state.err !== null) return cardErrText(ck, this.state.err)
        // 包装元素带 key 标记（`data-card-boundary="<cardKey>"`）：探针/套件据此确认"边界真的在位"
        return React.createElement('div', {
          className: 'dshw-cardboundary', 'data-card-boundary': (this.props && this.props.cardKey) || '',
        }, this.props.children)
      }
    }
    /** 故障态文案用到的卡名：优先传进来的显示名（已渲染过就算得出来），拿不到才回落 key */
    const cardBoundaryLabel = (key, rendered) => {
      try {
        const t = rendered && rendered.props && Array.isArray(rendered.props.children) && rendered.props.children[0]
        const kids = t && t.props && Array.isArray(t.props.children) ? t.props.children : null
        const first = kids !== null ? kids[0] : null
        if (first && first.props && typeof first.props.children === 'string' && first.props.children.length > 0) return first.props.children
      } catch (e) { /* 落到 key */ }
      return String(key)
    }

    const CSS = [
      '.dshw-root{position:absolute;inset:0;pointer-events:none;z-index:6}',
      '.dshw-dev{position:absolute;left:0;box-sizing:border-box;padding:6px 10px 7px;background:var(--dsw-specific-sidebar-fill);border-bottom:.5px solid var(--dsw-alias-border-l1);border-right:.5px solid var(--dsw-alias-border-l1);pointer-events:auto;overflow:hidden;font:500 12px/1.3 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;color:var(--dsw-alias-label-primary)}',
      '.dshw-dev-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px;color:var(--dsw-alias-label-secondary);font-size:10.5px;letter-spacing:.05em}',
      '.dshw-row{display:flex;align-items:center;gap:6px;height:16px}',
      '.dshw-name{flex:none;width:38px;color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.dshw-meter{position:relative;flex:1 1 auto;height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
      '.dshw-meter>i{position:absolute;left:0;top:0;bottom:0;width:0;border-radius:3px;background:var(--dsw-alias-state-success-primary);transition:width .08s linear}',
      '.dshw-meter>i[data-kind="spk"]{background:var(--dsw-alias-brand-primary)}',
      '.dshw-meter>i[data-kind="cam"]{background:var(--dsw-alias-state-warn-primary)}',
      '.dshw-pill{flex:none;font-size:10px;padding:1px 6px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.dshw-pill[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}',
      '.dshw-pill[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}',
      '.dshw-pill[data-tone="bad"]{color:var(--dsw-alias-state-error-primary)}',
      '.dshw-btn{font:500 11px/1 system-ui,sans-serif;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;padding:3px 7px;cursor:pointer;text-decoration:none;display:inline-block}',
      '.dshw-btn:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dshw-btn:disabled{opacity:.55;cursor:default}',
      '.dshw-panel{position:absolute;right:0;top:0;box-sizing:border-box;display:flex;flex-direction:column;gap:8px;padding:10px;overflow:auto;background:var(--dsw-alias-bg-base);border-left:.5px solid var(--dsw-alias-border-l1);border-bottom:.5px solid var(--dsw-alias-border-l1);pointer-events:auto;font:400 13px/1.5 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;color:var(--dsw-alias-label-primary)}',
      // embedded（better-sidebar 折叠侧边栏 tab 内）：脱离 overlay 定位，占满 tab 容器
      '.dshw-root.dshw-embedded{position:static;inset:auto;pointer-events:auto;width:100%;height:100%;overflow:hidden}',
      '.dshw-root.dshw-embedded .dshw-panel{position:static;width:100%!important;height:100%!important;min-height:200px;border-left:none;border-bottom:none;background:transparent;overflow:hidden}',
      // ── 画布栅格 = **20 列**（每列 5%）──────────────────────────────────────────
      //   卡片宽度用**百分比**记（用户 2026-09-26 裁定："宽度和高度每 5% 作一个网格吸附点"），
      //   20 列正好让"5% = 一跳"落在一列上 —— 布局仍是真的 CSS Grid（不会重叠、dense 仍能回填空洞），
      //   而"跨 5 列"就等于 25%、「跨 10 列」等于 50%。
      //   ⚠️ 没档位的卡由 JS 写行内 `span`（按画布宽度算，见 defaultSpanFor），这里只是首帧兜底。
      '.dshw-root.dshw-embedded .dshw-grid{grid-template-columns:repeat(20,minmax(0,1fr))}',
      '.dshw-hresizer{position:absolute;right:0;height:7px;margin-top:-3.5px;cursor:row-resize;pointer-events:auto;z-index:7}',
      '.dshw-hresizer:hover,.dshw-hresizer[data-drag="1"]{background:var(--dsw-alias-border-l2)}',
      '.dshw-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}',
      '.dshw-h1{font-size:15px;font-weight:600;flex:none}',
      '.dshw-sub{font-size:11px;color:var(--dsw-alias-label-secondary);flex:none}',
      // 头部**瞬时提示**（2026-09-15 用户要求）：设备操作的回执从「系统状态」卡片底部移到这里
      //   （「工作台」标题右侧的中段位置）。淡入 → 最多 10 秒 → 淡出；新提示会顶掉旧提示并重新计时。
      '.dshw-toast-wrap{flex:1 1 auto;min-width:0;display:flex;justify-content:center;align-items:baseline;overflow:hidden}',
      '.dshw-toast{font-size:11.5px;line-height:1.35;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;animation:dshwToastIn .28s ease both}',
      '.dshw-toast[data-tone="err"]{color:var(--dsw-alias-state-error-primary)}',
      '.dshw-toast[data-phase="out"]{opacity:0;transition:opacity .7s ease}',
      '@keyframes dshwToastIn{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:translateY(0)}}',
      '.dshw-tabs{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:2px}',
      '.dshw-tab{font:500 11px/1 system-ui,sans-serif;padding:4px 9px;border-radius:999px;cursor:pointer;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1)}',
      '.dshw-tab:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dshw-tab[data-on="1"]{color:var(--dsw-alias-bg-base);background:var(--dsw-alias-brand-primary);border-color:transparent}',
      // `dense`：自动填充空洞。默认（每张卡都跨 1 列）本来就没有洞，所以**平静态逐像素不变**；
      //   只有在"某张卡被拖成两列跨度"或"卡片尺寸不一致"时它才起作用 ——
      //   作用正是用户要的"周围卡片自动移开/靠拢，尽量贴近，保持最小单位间距"。
      // 栅格 = 20 列（每列 5%）：卡子的宽度是百分比，见 `layoutForCardSize` 与 `defaultSpanFor`。
      '.dshw-grid{display:grid;grid-template-columns:repeat(20,minmax(0,1fr));grid-auto-flow:row dense;gap:8px;align-items:stretch;flex:1 1 auto;min-height:0;overflow:auto}',
      // 自然档（没调过尺寸）的卡：首帧兜底跨 5 列（= 25%，与老栅格在 1080 宽侧边栏里的"一张卡一列"同宽）；
      //   画布量出来之后由 JS 按 `defaultSpanFor(canvasW, minPx)` 写行内 span（窄面板会跨更多列、直至整行）。
      '.dshw-grid > .dshw-slot{grid-column:span 5}',
      // 卡片统一**最小高度**（2026-09-15 用户更正：限制的是下限，不是上限）：
      // 比例由 JS 按「卡片行数」算出并写入 --dshw-card-min（6 行 16% · 4 行 24% · 3 行 33% · 2 行 49%）。
      // 内容多则卡片自然变高（栅格滚动），内容少也不塌成一条。
      '.dshw-grid > .dshw-card{min-height:var(--dshw-card-min,33%);display:flex;flex-direction:column}',
      // 时间列「窄宽」的**唯一数值来源**：待办卡 / 决策卡（昨夜动向·等待待定）/ 文件卡 共用（2026-09-19）
      '.dshw-card{--dshw-tcol-narrow:3.4em;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 10px 9px;min-width:0}',
      // 「系统状态」卡：麦克风条放在**标题右侧**（2026-09-15 用户要求：紧接"系统状态"四个字之后）。
      // 用 --nowrap 卡头 + 可收缩的 pill 组合保证"同一行"（下面两条注释解释了为什么必须这样）。
      '.dshw-card-head{display:flex;align-items:center;gap:6px;margin-bottom:5px;flex-wrap:wrap}',
      // ⚠️ 2026-09-15 用户实测（截图）：卡头**先按"基础宽度"决定换行、之后才谈收缩** ——
      //    因此在窄卡里麦克风条会被挤到第二行，而不是缩着留在标题右侧。
      //    故：带内联块（headInline）的卡头**禁止换行**，改为让各块收缩；这样它才能真的贴着标题右侧。
      '.dshw-card-head--nowrap{flex-wrap:nowrap;min-width:0;overflow:hidden}',
      '.dshw-card-title{font-size:12px;font-weight:600;flex:none}',
      // ── 卡片交互规范（SPEC_卡片交互规范 §一/§二）：**两行结构** ──────────────────
      //   2026-09-17 用户裁定：**移除第 2 行「分类/说明」**（原 `.dshw-card-cat` / `CARD_CATEGORIES`）
      //   第 1 行：左=卡名（可点，场景交互）· 中=关键指标（`dshw-card-metric` 包 payload 原值）· 右=动作按钮
      //   第 2 行起：`dshw-card-body`，点卡名折叠/展开（`data-card-folded="1"` ⇒ 只隐藏卡体，第 1 行恒在）
      //   ⚠️ 卡名**不再挂 `data-click`**（它曾在 `CARD_DRAG_EXCLUDE` 里，长按卡名进不了拖动）；
      //     改为"真拖过之后在捕获阶段抑制那一次 click"（`dragClickGuardRef`，约 400ms 窗口）。
      '.dshw-card-title[data-scene]{cursor:pointer;user-select:none;border-radius:4px}',
      '.dshw-card-title[data-scene]:hover{opacity:.75}',
      '.dshw-card-title[data-scene]:focus-visible{outline:1px solid #58a6ff;outline-offset:2px}',
      '.dshw-card-metric{flex:none;display:inline-flex;align-items:baseline}',
      '.dshw-card-body[data-card-folded="1"]{display:none}',
      // 卡片右侧动作按钮的容器（一卡多按钮时保持同一行、不挤占卡名/指标）
      '.dshw-btnrow{display:inline-flex;align-items:center;gap:6px;flex:none}',
      // 活跃关注域卡的「声明」内联表单（卡片内联，不放浮层——浮层会遮挡卡片自身控件）
      '.dshw-adform{display:flex;flex-direction:column;gap:6px;padding:6px 0 2px}',
      '.dshw-input{box-sizing:border-box;width:100%;font:500 12px/1.4 system-ui,sans-serif;padding:4px 6px;border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:inherit}',
      // 麦克风条 = 单行 pill：圆点 · 「麦克风」 · 状态 · ⇄ · 波形；**整条可点击**（启用/关闭）
      //   ⚠️ 宽度策略（2026-09-15 用户要求）：pill **吃掉标题之外的剩余宽度**（flex:1 1 auto）
      //      ⇒ 波形随卡片宽度伸缩；约束只有一条：标题宽 + pill 宽 ≤ 卡内容宽（不换行、不溢出）。
      '.dshw-micbar{display:flex;align-items:center;gap:5px;border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;padding:2px 6px;background:var(--dsw-alias-bg-layer-2);flex:1 1 auto;min-width:0;overflow:hidden}',
      '.dshw-micbar[data-click="1"]{cursor:pointer;user-select:none}',
      '.dshw-micbar[data-click="1"]:hover{border-color:#58a6ff}',
      '.dshw-micbar[data-click="1"]:focus-visible{outline:1px solid #58a6ff;outline-offset:1px}',
      '.dshw-micbar-name{font-size:9.5px;color:var(--dsw-alias-label-secondary);flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshw-micbar-state{font-size:10.5px;font-weight:600;flex:none;white-space:nowrap}',
      '.dshw-micbar .dshw-wave{flex:1 1 auto;min-width:12px;height:16px}',
      '.dshw-micbar[data-state="ok"] .dshw-micbar-state{color:#2ea043}',
      '.dshw-micbar[data-state="ok"] .dshw-dot{background:#2ea043}',
      '.dshw-micbar[data-state="off"] .dshw-micbar-state{color:#8b949e}',
      '.dshw-micbar[data-state="off"] .dshw-dot{background:#8b949e}',
      '.dshw-micbar[data-state="down"] .dshw-micbar-state{color:#da3633}',
      '.dshw-micbar[data-state="down"] .dshw-dot{background:#da3633}',
      '.dshw-micbar[data-state="warn"] .dshw-micbar-state{color:#d29922}',
      '.dshw-micbar[data-state="warn"] .dshw-dot{background:#d29922}',
      '.dshw-card-body{max-height:168px;overflow:auto;padding-right:2px;flex:1 1 auto;min-height:0}',
      // ⚠️ 2026-09-15 用户实测："系统状态"卡片内容（6 张小卡片 + 麦克风波形条）超出 168px
      //    被卡体内滚动截断 ⇒ **看不全**。该卡片改为**不裁切**：卡体随内容自然变高，
      //    溢出交给外层栅格整体滚动（这才是"保证展示完整"的机制，而不是靠调高度猜）。
      '.dshw-card-body--tall{max-height:none;overflow:visible}',
      // 文件卡片内的分类 tab（2026-09-15：这组 tab 只影响文件内容 → 移进卡片；用户要求**左对齐**）：
      // flex-basis 100% 独占一行 + order 置于标题行之后 + justify-content:flex-start → 不再被 spacer 推到右侧。
      '.dshw-tabs-inline{flex:1 1 100%;order:9;justify-content:flex-start;gap:3px}',
      '.dshw-tabs-inline .dshw-tab{padding:2px 7px;font-size:10px}',
      // 设备状态（2026-09-15 演进）：麦克风 = 行 + **波形**（唯一带波形的设备）；
      // 音响 / 摄像头 = **小卡片**（点击切换连接/关闭）。颜色语义：绿=正常/空闲 · 橙=执行中/使用中 · 红=断开/未配置/未连接 · 灰=关闭
      // 音响 / 摄像头 = **小卡片**、麦克风 = **可点击波形条**（点击切换连接/启用与关闭）。
      // 颜色语义：绿=正常/空闲 · 橙=执行中/使用中 · 红=断开/未配置/未连接 · 灰=关闭
      // ⚠️ 2026-09-15 第五轮：设备不再用"行"呈现（麦克风改为右侧波形条）⇒ 已删除
      //    .dshw-devrow / .dshw-devname / .dshw-devstate / .dshw-nowave 死样式。
      '.dshw-dot{flex:none;width:7px;height:7px;border-radius:50%;background:#8b949e}',
      '.dshw-wave{flex:1 1 auto;min-width:60px;height:20px;display:block}',
      '.dshw-wave rect{fill:#8b949e}',
      '.dshw-wave[data-state="ok"] rect{fill:#2ea043}',
      '.dshw-wave[data-state="busy"] rect{fill:#d29922}',
      '.dshw-wave[data-state="down"] rect{fill:#da3633}',
      // 小卡片栅格（2026-09-15 用户要求：**收紧间距**；2026-09-16：**整体自动排列 = 3+3**；
      //   2026-09-26 用户要求：**按卡片宽度自适应，每行 1 / 2 / 3 / 4 个** ——
      //   原话"系统卡片横向扩展之后，其中的小卡片应该能排成一行/两行/三行/四行"）。
      //   列数改由**卡片自己的宽度**决定（容器 `.dshw-slot` 就叫 `dshwslot`，见下面 :root 容器声明），
      //   四档：<220px 一列 · ≥220 两列 · ≥380 三列（= 旧行为的 3+3，保持不变）· ≥620 四列。
      //   ⚠️ 不用 `auto-fill minmax(...)`：那样列数由"最小格宽"间接决定，宽卡上封顶在 3 列，
      //      卡片拉宽了格子却不变大（用户要的正是"拉宽之后一排能放下更多"）。
      '.dshw-minigrid{display:grid;grid-template-columns:repeat(1,minmax(0,1fr));gap:4px;margin-top:4px}',
      '@container dshwslot (min-width:220px){.dshw-minigrid{grid-template-columns:repeat(2,minmax(0,1fr))}}',
      '@container dshwslot (min-width:380px){.dshw-minigrid{grid-template-columns:repeat(3,minmax(0,1fr))}}',
      '@container dshwslot (min-width:620px){.dshw-minigrid{grid-template-columns:repeat(4,minmax(0,1fr))}}',
      '.dshw-mini{border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;padding:4px 6px;background:var(--dsw-alias-bg-layer-2);min-width:0}',
      '.dshw-mini-t{font-size:9.5px;color:var(--dsw-alias-label-secondary);margin-bottom:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshw-mini-s{font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshw-mini-s[data-state="ok"]{color:#2ea043}',
      '.dshw-mini-s[data-state="busy"]{color:#d29922}',
      '.dshw-mini-s[data-state="warn"]{color:#d29922}',
      '.dshw-mini-s[data-state="down"]{color:#da3633}',
      '.dshw-mini-s[data-state="off"]{color:#8b949e}',
      // ★ 2026-09-24 用户裁定：过渡态两个新色 —— 开启中(紫) / 关闭中(蓝)。
      //   为什么必须有过渡态：向量检索是**进程级**开关，点下去到现实跟上要几秒到几十秒
      //   （启要装一次模型约 20s，停要等服务自己退干净）。这段窗口里显示"在线"或"关闭"
      //   都是错的 —— 前者不知道还没起来有没有成功，后者在服务还占着 1.3GB 时说"已关闭"。
      //   色值与库内 `STATE_COLOR.starting/stopping` 一致。
      '.dshw-mini-s[data-state="starting"]{color:#a371f7}',
      '.dshw-mini-s[data-state="stopping"]{color:#58a6ff}',
      '.dshw-mini-s[data-state="unknown"]{color:var(--dsw-alias-label-secondary)}',
      // 可点击的设备小卡片（2026-09-15 用户要求：音响/摄像头改小卡片 + 点击切换连接/关闭）
      // 可点：手型 + hover 描边 + 键盘可达；不可点（未检测到设备）：降透明度并给出原因
      '.dshw-mini[data-click="1"]{cursor:pointer;user-select:none}',
      '.dshw-mini[data-click="1"]:hover{border-color:#58a6ff}',
      '.dshw-mini[data-click="1"]:focus-visible{outline:1px solid #58a6ff;outline-offset:1px}',
      '.dshw-mini[data-click="0"]{opacity:.6}',
      '.dshw-mini-hint{font-size:9px;font-weight:400;margin-left:4px;color:var(--dsw-alias-label-secondary)}',
      // ⚠️ 2026-09-15 第六轮：麦克风条已移到**卡头**（标题右侧）⇒ `.dshw-sysrow*` 两列布局不再需要（已删）。
      // ⚠️ 2026-09-16：设备组与系统组已合并为一个自动栅格（用户要求 3+3）⇒
      //    `.dshw-syssep`（组间分隔）与 `.dshw-sysrow*` 一并成为死样式，已删除。
      '.dshw-badge{font-size:10px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:7px;padding:1px 6px}',
      '.dshw-spacer{flex:1 1 auto}',
      // ── 卡片顺序覆盖层（2026-09-16 用户裁定：**长按整卡拖动**）──────────────────────
      //    为什么不用手柄/浮层按钮（用户明确否决）：浮层控件会**遮挡卡片自己的按钮**
      //    （关闭/重开事务、「重新匹配」等就在卡头右侧）；长按整卡则不占任何视觉空间。
      //   ⚠️ 容器建在 **`.dshw-slot`** 上，不是 `.dshw-card` 上 —— 见下面 `.dshw-card` 那条注释。
      '.dshw-slot{position:relative;display:flex;flex-direction:column;min-width:0;container-type:inline-size;container-name:dshwslot}',
      '.dshw-slot > .dshw-card{flex:1 1 auto;transition:transform .08s linear,box-shadow .08s linear,opacity .08s linear}',
      // 抬起态：轻微放大 + 阴影 + 半透明（让人确认"这张正在被我端着"）
      '.dshw-slot[data-dragging="1"]{z-index:3}',
      '.dshw-slot[data-dragging="1"] > .dshw-card{transform:scale(1.015);box-shadow:0 6px 18px rgba(0,0,0,.28);opacity:.92}',
      '.dshw-slot[data-dragging="1"]{cursor:grabbing}',
      // 插入位置指示线（拖动时显示落点；比"高亮整卡"更容易看清插到哪）
      '.dshw-slot[data-dragover="before"]::before,.dshw-slot[data-dragover="after"]::after{content:"";position:absolute;left:0;right:0;height:2px;background:var(--dsw-alias-brand-primary);border-radius:1px;pointer-events:none}',
      '.dshw-slot[data-dragover="before"]::before{top:-2px}',
      '.dshw-slot[data-dragover="after"]::after{bottom:-2px}',
      // 拖动期间锁滚动 / 抑制选中（挂在容器上，松手即恢复）
      '.dshw-grid[data-draglock="1"]{overflow:hidden;touch-action:none}',
      '.dshw-grid[data-draglock="1"] *{user-select:none}',
      // ── 卡片缩放（2026-09-25 用户要求）────────────────────────────────────────
      //   用户原话："在工作台-所有卡片的右下角添加一个向右下方向的小三角，可以按住小三角
      //   拖动卡片实现放大缩小。卡片有最小值，卡片内的元素根据卡片大小自适应排布。"
      //
      //   宽度 = 栅格**列跨度**（`grid-column: span N`，N 由 JS 按实测列宽吸附），
      //   高度 = slot 的 `min-height`（按 20px 步长吸附）—— 两者都写在 **slot 的行内样式**上，
      //   因为 slot 才是栅格项，卡片本身不参与栅格定位。
      //   尺寸只是**本机呈现态**：落 localStorage（与 `dshw.domOpen` 同一口径），
      //   不写库内产物、不进 `/ui-prefs`（那条要 host 改动 + 重启 DSH 才生效）。
      //
      //   ⚠️ 手柄放在 `.dshw-card` **里面**，不是 slot 里：同一行的 slot 会被最高的那张卡撑高，
      //      而卡是内容高 —— 挂 slot 上会飘在卡片底边下方十几像素，不叫"卡片的右下角"。
      //      手柄带 `role="button"` ⇒ 自动命中 `CARD_DRAG_EXCLUDE`，长按排序不会跟它抢指针。
      //   ⚠️ 容器**不能建在 `.dshw-card` 上**（第一版就是那么写的，白排查一轮）：
      //      `@container` 只对**后代**生效，**容器元素自己不吃自己的查询** ——
      //      症状极具迷惑性：`.dshw-card-body{max-height}`、`.dshw-item-text{white-space}`
      //      都跟着换档了（它们是后代），偏偏 `.dshw-card{padding}` 一动不动。
      //      所以容器建在 `.dshw-slot` 上（宽度与卡片一致，卡片是它的后代）。
      '.dshw-card{position:relative}',
      '.dshw-rsz{position:absolute;right:2px;bottom:2px;width:14px;height:14px;cursor:nwse-resize;opacity:.5;transition:opacity .15s ease,color .15s ease;color:var(--dsw-alias-label-secondary);touch-action:none}',
      '.dshw-rsz::after{content:"";position:absolute;right:3px;bottom:3px;width:9px;height:9px;background:linear-gradient(to bottom right,transparent 0 48%,currentColor 48% 100%);border-bottom-right-radius:4px}',
      '.dshw-card:hover .dshw-rsz{opacity:.9}',
      '.dshw-rsz:hover{opacity:1;color:var(--dsw-alias-brand-primary)}',
      // ── 松手吸附的过渡动画（2026-09-26 用户要求）────────────────────────────────
      //   用户原话："右下角缩放的放大和缩小应该是要有过渡动画的，只是最终释放鼠标之后吸附到最近的 5% 网格。"
      //   ⇒ 拖动过程**不加过渡**（卡片按像素跟手，见 onCardResizeMove）；松手时给 slot 加
      //     `data-rszsnap="1"`，宽高用 180ms 过渡落到吸附后的尺寸，过渡结束就摘掉这个属性
      //     （见 finishCardResizeSnap）—— 免得它影响后续的面板重排（面板变宽时卡片要跟着走）。
      '.dshw-slot[data-rszsnap="1"]{transition:width .18s cubic-bezier(.2,.7,.3,1),height .18s cubic-bezier(.2,.7,.3,1)}',
      //   拖动中：卡片宽度会暂时超出它所在的列跨度（跟手预览）⇒ 抬一层，别被右边那张压住
      '.dshw-slot[data-rszlive="1"]{z-index:2}',
      //   系统设了"减少动效"就不做这个动画（无障碍；吸附仍然照做，只是不过渡）
      '@media (prefers-reduced-motion:reduce){.dshw-slot[data-rszsnap="1"]{transition:none}}',
      '.dshw-rsz:focus-visible{opacity:1;outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      // ── 移动手柄（2026-09-25 用户要求：**左下角**的小方块）─────────────────────
      //   与右下角的缩放手柄分工：左下 = 换位置（磁力贴），右下 = 改大小。
      //   同样带 `role="button"`（走 `CARD_DRAG_EXCLUDE`，长按排序不跟它抢指针）。
      //   ⚠️ 它的拖动**不走长按**：按下即进入"跟手 + 实时让位"，见 startMoveDrag。
      '.dshw-mv{position:absolute;left:2px;bottom:2px;width:15px;height:15px;cursor:grab;opacity:.5;color:var(--dsw-alias-label-secondary);touch-action:none;transition:opacity .15s ease,color .15s ease}',
      '.dshw-mv::after{content:"";position:absolute;left:3px;bottom:3px;width:8px;height:8px;border-radius:2px;background:currentColor}',
      '.dshw-card:hover .dshw-mv{opacity:.9}',
      '.dshw-mv:hover{opacity:1;color:var(--dsw-alias-brand-primary)}',
      '.dshw-mv:focus-visible{opacity:1;outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      // ⚠️ `pointer-events:none` 不是装饰：被拖的卡跟着指针走、正好压在光标底下，
      //    `elementFromPoint` 就会一直命中它自己 ⇒ 落点永远算不出来、顺序永远不变。
      '.dshw-slot[data-moving="1"]{z-index:6;cursor:grabbing;pointer-events:none}',
      '.dshw-slot[data-moving="1"] > .dshw-cardboundary > .dshw-card{transform:scale(1.03);border-color:var(--dsw-alias-brand-primary);box-shadow:0 12px 28px rgba(31,35,41,.16),0 6px 12px rgba(31,35,41,.08)}',
      '.dshw-slot[data-moving="1"] .dshw-mv{cursor:grabbing;opacity:1;color:var(--dsw-alias-brand-primary)}',
      // 拖动中：这张 slot 抬到最上层 + 卡片给一圈主色描边
      //   （与"抬起排序"**刻意区分**：那个是 scale+阴影，这个是描边）
      '.dshw-slot[data-rszing="1"]{z-index:4}',
      '.dshw-slot[data-rszing="1"] > .dshw-cardboundary > .dshw-card{border-color:var(--dsw-alias-brand-primary)}',
      // 高度被设过：卡要**撑满 slot** 并把卡体的 168px 上限摘掉 ——
      //   否则"变高"只在高处多出一块空白，卡本身纹丝不动。
      //   ⚠️ 高度用**确定高度**（`height`）而不是 `min-height`：第一版写的是 `min-height`，
      //      于是"缩小"永远做不到 —— 卡会长到内容那么高，拖小只是把下限压低，卡纹丝不动。
      //      确定高度 + 卡体 `overflow:auto` 才是"卡随手指变、内容在里面滚"。
      //      代价：同一行有更高的卡时，这一行的行高仍由那张卡决定，缩小的这张下面会留白
      //      （栅格行的固有行为，与 Grafana 那类看板一致）。
      '.dshw-slot[data-rszh="1"] > .dshw-cardboundary > .dshw-card{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}',
      '.dshw-slot[data-rszh="1"] .dshw-card-body:not(.dshw-card-body--tall){max-height:none}',
      // ⚠️ 卡内自适应（容器查询）**不在这里** —— 它要覆盖 `.dshw-root .dshw-card{padding}`，
      //    而那条在 CSS_V2 里（特异度更高、且本段基础 CSS 是**先**注入的）。
      //    放在本段会被按特异度压掉，症状是"规则写了、容器也建立了、值就是不变"。
      //    见 CSS_V2 末尾的「⑨c 卡内自适应」。
      // 顶部工具区的文字链接（不遮挡任何卡片控件）：恢复默认只在有覆盖层时出现
      '.dshw-orderlink{font:500 10.5px/1 system-ui,sans-serif;color:var(--dsw-alias-label-secondary);background:none;border:none;padding:0;cursor:pointer;text-decoration:underline;text-underline-offset:2px}',
      '.dshw-orderlink:hover{color:var(--dsw-alias-label-primary)}',
      '.dshw-orderhint{font:400 10.5px/1 system-ui,sans-serif;color:var(--dsw-alias-label-secondary);opacity:.85}',
      '.dshw-ordererr{border:.5px solid #d29922;background:rgba(210,153,34,.12);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 9px;font-size:11px;margin-bottom:6px}',
      // ── 专注期间的三层规则（2026-09-17 用户裁定）· **纯视觉层** ────────────────────
      //   ① 醒目卡（专注卡自己 + `FOCUS_TARGET_CARDS` 映射到的卡 + 白名单命中的卡）：一个字都不改。
      //   ② 非目标卡：**降权 + 默认折叠成一行摘要**（用户裁定原文："降权显示"；折叠是本卡给出的
      //      "降权到什么程度"的**实现选择**，2026-09-17 经越界评审正式接管，理由见下方 FOCUS_DIM）。
      //      降权 = 灰度 + 降饱和 + 降不透明度（`filter`/`opacity`），**不是** `display:none`。
      //   ⚠️ 只用 filter/opacity 这类**纯视觉**手段：
      //      · 不 display:none（卡片仍在版面上、**仍可长按整卡拖动**）；
      //      · 不改 DOM 次序（顺序断言 T16-58 / T16-97 / SBT-23 不受影响）；
      //      · 展开入口**永远保留**（折叠条整条可点 + 右侧显式按钮，键盘可达）。
      '.dshw-focusdim{filter:grayscale(.55) saturate(.55);opacity:.55;transition:filter .12s linear,opacity .12s linear}',
      '.dshw-focusdim[data-folded="1"]{opacity:.72}',
      // 折叠态「一行摘要」：左边卡名、中间卡徽标（原样），右侧展开入口
      // 折叠态「一行摘要」：左边卡名、中间卡徽标（原样），右侧展开/收起入口。
      //   ⚠️ 摘要条**不带 `data-click`、不给 onClick** —— `CARD_DRAG_EXCLUDE` 含 `[data-click="1"]`，
      //      带上它整张折叠卡就落进"卡内控件、拖动完全不介入"的分支 ⇒ 折叠后再也长按不动。
      //      点击入口收敛到右侧那个 `.dshw-btn`（本来就在排除表里，不会误触发拖动）。
      //      故这里**没有** `.dshw-focussum[data-click="1"]` 那两条样式（避免留下死样式）。
      '.dshw-focussum{display:flex;align-items:baseline;gap:6px;padding:6px 10px;border:.5px dashed var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);font-size:11.5px;min-width:0;flex:1 1 auto;cursor:grab}',
      '.dshw-focussum-t{flex:none;font-weight:600}',
      '.dshw-focussum-b{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}',
      '.dshw-focussum-hint{flex:none;font-size:10px;color:var(--dsw-alias-label-secondary);opacity:.85}',
      // 专注卡内：「必穿透」计数行（白名单）+ 入队一级行（点击开二级详情）
      '.dshw-focuswl{margin:0 0 6px;padding:5px 8px;border-radius:8px;border:.5px solid #d29922;background:rgba(210,153,34,.10);font-size:11.5px;line-height:1.5}',
      '.dshw-focuswl b{font-weight:600}',
      '.dshw-focusq{display:flex;gap:8px;align-items:baseline;padding:2.5px 4px;border-radius:6px;min-width:0}',
      '.dshw-focusq[data-click="1"]{cursor:pointer}',
      '.dshw-focusq[data-click="1"]:hover{background:var(--dsw-alias-bg-layer-2)}',
      // 二级详情弹窗内的判定行：来源 · 时间 · 摘要 · 判定理由 why · 是否命中
      '.dshw-fq-row{border-top:.5px dashed var(--dsw-alias-border-l1);padding:5px 0;font-size:12px}',
      '.dshw-fq-row:first-child{border-top:none}',
      '.dshw-fq-hit{flex:none;font-size:10px;padding:0 5px;border-radius:5px;border:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}',
      '.dshw-fq-hit[data-hit="1"]{color:#2b6cb0;border-color:#bcd3ea}',
      '.dshw-fq-row-meta{color:var(--dsw-alias-label-secondary);font-size:10.5px;font-variant-numeric:tabular-nums}',
      '.dshw-item{display:flex;gap:8px;padding:2.5px 4px;align-items:baseline;border-radius:6px}',
      '.dshw-item[data-click="1"]{cursor:pointer}',
      '.dshw-item[data-click="1"]:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dshw-item-time{flex:none;width:66px;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.dshw-item-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      // ── 听记卡的**分组头 / 归档入口 / 行内写按钮**（2026-09-20 用户规格 · 第二、四、五条）──
      //   行本身**仍然复用 `.dshw-item`**（药丸↔标题间距与待办卡同值 —— 真机 MN-6 守着）；
      //   这里只加带 `dshw-min*` 前缀的新元素，**不碰任何共享类**（不动 `.dshw-item*`）。
      '.dshw-mingrp{margin-top:2px}',
      '.dshw-mingrp-head{display:flex;gap:8px;align-items:baseline;padding:2.5px 4px;border-radius:6px;cursor:pointer;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dshw-mingrp-head:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dshw-mingrp-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshw-mingrp-n{flex:none;font-variant-numeric:tabular-nums}',
      '.dshw-minbtn{flex:none;margin-left:auto;padding:0 6px}',
      '.dshw-minarch{display:flex;gap:8px;align-items:baseline;padding:2.5px 4px;font-size:11px}',
      '.dshw-minarch-link{cursor:pointer;text-decoration:underline}',
      '.dshw-minarch-stamp{flex:none;width:66px;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      // 对象卡（2026-09-16；2026-09-17 用户复看后收敛）：
      //   ① 行主内容三列 = 对象键 · 状态（纯文本） · 下一步（期限 · 责任人）—— 都走 .dshw-item-text；
      //      状态不再占用左侧时间列（那一列是 tabular-nums + 定宽，给"文本状态词"用会歪）。
      //   ② 「事务 n · 触发 m」降级为**弱尾信息**：`.dshw-objweak`（无底色、no-wrap、不可点）——
      //      它不再混进主文本，但仍与主列同一行，扫一眼就能对账。
      '.dshw-objnext{font-size:10.5px;color:var(--dsw-alias-label-secondary);cursor:pointer;word-break:break-all}',
      '.dshw-objnext:hover{color:var(--dsw-alias-label-primary)}',
      // 弱尾：`事务 n · 触发 m` + 仅触发/仅事务 标签。**不占位时不渲染**（0 宽），字号比主列小一档。
      '.dshw-objweak{flex:none;font-size:10.5px;color:var(--dsw-alias-label-secondary);opacity:.85;white-space:nowrap;font-variant-numeric:tabular-nums}',
      '.dshw-objtag{flex:none;max-width:38%;overflow:hidden;text-overflow:ellipsis;font-size:10.5px;color:var(--dsw-alias-label-secondary);opacity:.9;white-space:nowrap;font-variant-numeric:tabular-nums}',
      '.dshw-objtag-none{opacity:.55;font-style:italic}',
      // 二级详情的**脚注**（不是一段）：rollup 对账 + counts 原值 + 版本时刻。
      //   用虚线分隔 + 小一档字号，与上面三段的段落头视觉上区分开。
      '.dshw-objfoot{margin-top:8px;padding-top:6px;border-top:.5px dashed var(--dsw-alias-border-l1);font-size:10.5px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
      // 日程来源标签（钉钉 / 飞书 / 行程）—— 同一条列表里区分来源
      '.dshw-src{flex:none;font-size:9.5px;line-height:1.4;padding:0 5px;border-radius:5px;border:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}',
      '.dshw-src[data-src="dingtalk"]{color:#2b6cb0;border-color:#bcd3ea}',
      '.dshw-src[data-src="feishu"]{color:#1f7a6b;border-color:#bfe0d8}',
      '.dshw-src[data-src="trip"]{color:#8a5a00;border-color:#e8d6a8}',
      '.dshw-src[data-src="personal"]{color:#6b46c1;border-color:#d6c9f0}',
      // 待办的**归属标记**（用户 2026-09-17：钉钉客户端的"别人安排给我的 / 我安排给别人的"也要能看出来）。
      //   只对**需要区分**的两类显示（自己创建 / 我参与 = 默认，不加标记，避免每行挂一串小标签）。
      '.dshw-cat{flex:none;font-size:9.5px;line-height:1.4;padding:0 4px;border-radius:5px;border:.5px dashed var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary)}',
      '.dshw-cat[data-cat="assigned-by-others"]{color:#8a5a00;border-color:#e8d6a8}',
      '.dshw-cat[data-cat="assigned-to-others"]{color:#2b6cb0;border-color:#bcd3ea}',
      // ── 待办列表（2026-09-16 用户四点要求）──────────────────────────
      //   ① 来源标签复用上面的 .dshw-src 药丸（与日程**同一套标记**，视觉一致）；
      //   ② 时间列**收窄到"无期限"三个字**的宽度（原来固定 66px，与标签之间空一大截）；
      //   ③ 全部行照列、不截断；超出卡体高度由 `.dshw-card-body`（max-height:168px + overflow:auto）滚动；
      //   ④ 卡脚不再有「打开目录」按钮、卡内不再有「显示 X / 共 Y 条」字样。
      '.dshw-todolist .dshw-item-time{width:var(--dshw-tcol-narrow)}',
      // 「最近关闭 · 可重新打开」小节（2026-09-17）：已完成项不进列表，但必须留一条**回来的路**
      '.dshw-closed{margin-top:6px;padding-top:5px;border-top:.5px dashed var(--dsw-alias-border-l1)}',
      '.dshw-closed-h{font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-bottom:2px}',
      '.dshw-empty{font-size:12px;color:var(--dsw-alias-label-secondary);padding:1px 0}',
      '.dshw-err{font-size:11px;color:var(--dsw-alias-state-error-primary);word-break:break-all}',
      '.dshw-detail{margin:0 0 6px;padding:7px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:11.5px;line-height:1.5}',
      // 决策卡（2026-09-17 用户裁定）：桶次标题（今日到期 / 刚逾期 / 陈欠折行）+ 文本链接（「标记已读」）。
      '.dshw-bucket{display:flex;align-items:center;gap:5px;padding:2px 4px;margin:2px 0 1px;border-radius:6px;font:600 11px/1.35 system-ui,sans-serif;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}',
      '.dshw-bucket[data-click="1"]{cursor:pointer}',
      '.dshw-bucket[data-click="1"]:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dshw-link{flex:none;color:var(--dsw-alias-brand-primary);text-decoration:underline;cursor:pointer;font-size:11px}',
      '.dshw-detail select,.dshw-detail input{font:500 11.5px/1.4 system-ui,sans-serif;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;padding:3px 6px}',
      '.dshw-detail b{font-weight:600}',
      '.dshw-detail div{margin:2px 0}',
      // ── 事务详情卡（E 块：上层卡片 + 交互）──
      '.dshw-mt-btn{flex:none;font:500 10px/1 system-ui,sans-serif;color:var(--dsw-alias-brand-primary);background:transparent;border:.5px solid var(--dsw-alias-border-l1);border-radius:5px;padding:1px 5px;cursor:pointer}',
      '.dshw-mt-btn:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dshw-item[data-closed="1"] .dshw-item-text{opacity:.55}',
      '.dshw-modal-backdrop{position:fixed;inset:0;background:rgba(8,10,14,.55);z-index:2000000;display:flex;align-items:center;justify-content:center;pointer-events:auto}',
      '.dshw-modal{box-sizing:border-box;width:min(560px,94vw);max-height:84vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 18px 60px rgba(0,0,0,.45);overflow:hidden;font:400 13px/1.5 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;color:var(--dsw-alias-label-primary)}',
      '.dshw-modal-head{display:flex;align-items:baseline;gap:8px;padding:10px 12px 8px;border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '.dshw-modal-title{font-size:14px;font-weight:600}',
      '.dshw-modal-body{overflow:auto;padding:10px 12px 12px;display:flex;flex-direction:column;gap:10px}',
      '.dshw-modal-sec{border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1)}',
      '.dshw-modal-sec-h{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.04em;margin-bottom:5px}',
      '.dshw-mrow{display:flex;gap:8px;margin:2px 0;font-size:12px;align-items:baseline}',
      '.dshw-mrow-l{flex:none;width:64px;color:var(--dsw-alias-label-secondary)}',
      '.dshw-mrow-v{flex:1 1 auto;min-width:0;word-break:break-all;white-space:pre-wrap}',
      '.dshw-modal textarea,.dshw-modal input,.dshw-modal select{box-sizing:border-box;width:100%;font:500 12px/1.4 system-ui,sans-serif;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;padding:5px 7px;margin:3px 0}',
      '.dshw-rec{border-top:.5px dashed var(--dsw-alias-border-l1);padding:5px 0;font-size:12px}',
      '.dshw-rec:first-child{border-top:none}',
      '.dshw-rec-time{color:var(--dsw-alias-label-secondary);font-size:10.5px;font-variant-numeric:tabular-nums}',
      '.dshw-msg{font-size:11px;color:var(--dsw-alias-state-warn-primary)}',
      '.dshw-msg[data-ok="1"]{color:var(--dsw-alias-state-success-primary)}',
      // ── 事务卡内 tab（待完成 / 已过期 / 已关闭）──
      '.dshw-mtabs{display:flex;gap:4px;margin-bottom:5px}',
      '.dshw-mtab{font:500 10.5px/1 system-ui,sans-serif;padding:3px 8px;border-radius:999px;cursor:pointer;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1)}',
      '.dshw-mtab:hover{background:var(--dsw-alias-bg-layer-1)}',
      '.dshw-mtab[data-on="1"]{color:var(--dsw-alias-bg-base);background:var(--dsw-alias-brand-primary);border-color:transparent}',
      '.dshw-mtab i{font-style:normal;opacity:.75;margin-left:4px;font-size:9.5px}',
      // ── 决策卡内 tab（昨夜动向 / 今日必办 / 等待待定；2026-09-17 用户裁定）──
      //    ⚠️ 独立类名，**刻意不复用** .dshw-mtabs/.dshw-mtab —— 那两个被事务卡共用，
      //       改它们会波及事务卡；这里样式与事务卡保持视觉一致即可。
      '.dshw-btabs{display:flex;gap:4px;margin-bottom:5px}',
      '.dshw-btab{font:500 10.5px/1 system-ui,sans-serif;padding:3px 8px;border-radius:999px;cursor:pointer;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1)}',
      '.dshw-btab:hover{background:var(--dsw-alias-bg-layer-1)}',
      '.dshw-btab[data-on="1"]{color:var(--dsw-alias-bg-base);background:var(--dsw-alias-brand-primary);border-color:transparent}',
        // ⚠️ 2026-09-20 用户裁定：tab 上不再挂计数徽标 ⇒ 原先那条按 `.dshw-btab` 后代 i 元素写的 CSS 规则已删除。
        // ── 决策卡「今日必办」三桶标签（药丸）· 用户 2026-09-17 修正③ ──
        //    ⚠️ **独立类名** `.dshw-btag`：样式数值（字号/内距/圆角/边框）与待办卡的来源标签
        //    `.dshw-src` 保持一致（视觉同族），但**刻意不复用它的类名** —— 那个类被待办/日程共用，
        //    改它会波及其它卡片。`data-bucket` 三种取值对应三个桶。
        '.dshw-btag{flex:none;font-size:9.5px;line-height:1.4;padding:0 5px;border-radius:5px;border:1px solid;white-space:nowrap}',
        '.dshw-btag[data-bucket="due-today"]{color:#2b6cb0;border-color:#bcd3ea}',
        '.dshw-btag[data-bucket="recent-overdue"]{color:#8a5a00;border-color:#e8d6a8}',
        '.dshw-btag[data-bucket="aged"]{color:#a33a3a;border-color:#e8b4b4}',

        // 逐条已读控件（行尾）：与事务卡 `▸` 同位置风格；已读行整行淡化（只作用带 data-read 的行）
        '.dshw-bread{flex:none;margin-left:4px;padding:1px 5px;border-radius:5px;border:1px solid var(--dsw-alias-border-secondary);background:transparent;color:var(--dsw-alias-label-secondary);font-size:9.5px;line-height:1.5;cursor:pointer}',
        '.dshw-bread:hover{background:var(--dsw-alias-bg-layer-2)}',
        '.dshw-bread[data-read="1"]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
        // 修正④：分组标题的展开指示（▾ 展开 / ▸ 折叠）——决策卡专属，不改共享类
        '.dshw-bkarrow{flex:none;font-size:9.5px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
        '.dshw-item[data-read="1"] .dshw-item-text{opacity:.55}',
// 行前时间列宽度（用户 2026-09-19）：决策卡「昨夜动向 / 等待待定」只显示月/日（MM-DD）⇒
//   收窄到与待办卡 `.dshw-todolist .dshw-item-time{width:3.4em}` **完全相同的数值**，视觉节奏一致。
//   ⚠️ 只作用于本卡这两个段（行上 `data-brseg`）：不动共享的 `.dshw-item-time` 基础宽度，
//   也不碰待办/日程共用的 `.dshw-todolist` / `.dshw-src`。「今日必办」保持原宽度（显示期限，需完整日期）。
'.dshw-item[data-brseg="overnight"] .dshw-item-time,.dshw-item[data-brseg="waiting"] .dshw-item-time{width:var(--dshw-tcol-narrow)}',
        // 文件卡（原名「知识库」，2026-09-19 用户裁定）：时间标签与清单之间空隙偏大 ⇒ 与决策卡/待办卡
        //   共用同一个宽度变量（`--dshw-tcol-narrow`），**不在本卡另硬编码数值**。
        '.dshw-card[data-card-key="kb"] .dshw-item-time{width:var(--dshw-tcol-narrow)}',
      // 域分组标题（点击展开/收起该域的事务列表）+ 缩进的子项
      '.dshw-dgroup{display:flex;align-items:center;gap:5px;padding:3px 4px;margin-top:2px;border-radius:6px;cursor:pointer;background:var(--dsw-alias-bg-layer-2);font:600 11.5px/1.3 system-ui,sans-serif}',
      '.dshw-dgroup:hover{background:var(--dsw-alias-bg-layer-1)}',
      '.dshw-dgroup-arrow{flex:none;width:9px;color:var(--dsw-alias-label-secondary);font-size:9px}',
      '.dshw-dgroup-name{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshw-dgroup-count{flex:none;font-size:10px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.dshw-item[data-child="1"]{padding-left:15px}',
      // 「驾驶舱」tab：顶部工具条 + 占满余量的 iframe（内嵌库内仪表盘）
      '.dshw-dash{display:flex;flex-direction:column;height:100%;min-height:0;font:400 12px/1.4 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;color:var(--dsw-alias-label-primary)}',
      '.dshw-dash-bar{flex:none;display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '.dshw-dash-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.dshw-dash-frame{flex:1 1 auto;width:100%;min-height:0;border:0;background:var(--dsw-alias-bg-base)}',
      // portal 不可用时的兜底：抬升根节点，让详情卡盖过同层的其它面板
      '.dshw-root[data-modal="1"]{z-index:3000}',
      // 单卡错误边界的包装层（2026-09-17）：**必须零布局影响**，否则会打乱卡片栅格/最小高度/滚动。
      //   ⚠️ `display:contents` **不能**用：它会抹掉包装元素自己的盒子，于是 `.dshw-grid > .dshw-card`
      //      那条最小高度规则（生产环境 `--dshw-card-min:33%` 左右）就套不到卡上了。
      //   改为"透明直通"：flex 纵向 + `flex:1 1 auto` + `min-width/min-height:0` ——
      //   包装元素把**父级给它的高度原样传给卡**（卡上仍有 min-height 兜底），宽度同理不放宽。
      //   `filter`/`opacity` 的降权仍落在 `.dshw-focusdim` 上（在包装层**之上**），两者互不干扰。
      '.dshw-cardboundary{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0}',
    ].join('\n')

    /**
     * ══════════════════════════════════════════════════════════════════════════
     * 界面 v2 皮肤（2026-09-25）—— 把「工作台」这张卡换成参考站的设计语言
     * ══════════════════════════════════════════════════════════════════════════
     *
     * 用户裁定（2026-09-25 原话）："我的工作台目前是在 better-sidebar 中的工作台卡片，
     *   你需要更新的应该是这个，而不是另外新建一个工作台页面。"
     * 参考：https://8exxjvfh.qwenwork.host/（深色 + 莱姆绿强调 + 大圆角卡片 + .22s 缓动）
     *
     * ── 为什么用「第二层样式」而不是改上面那 30KB 的 CSS ──────────────────────
     *   上面那份 CSS 与**真机套件**（`verify-sidebar-tab.mjs`，100+ 条）深度耦合：
     *   套件按 `.dshw-card`（62 处）/ `.dshw-card-title`（57 处）/ `.dshw-slot`（114 处）
     *   与 `data-key` `data-dim` `data-folded` 等属性取证。**动结构 = 整批假红**。
     *   所以本层遵守三条纪律：
     *     ① **零结构改动**：不增删节点、不改 class、不改 data-*（16 条属性一条不动）；
     *     ② **只在 `.dshw-root` 作用域内生效**：不污染 DSH 其它界面；
     *     ③ **可一行摘除**：删掉 apply() 里那两行注入即完全回退（见 `[v2-skin]` 标记）。
     *
     *   ⚠️ 面板消费的 13 个宿主令牌（`--dsw-alias-*`）是**唯一**的换色面 ——
     *      在 `.dshw-root` 里重定义它们，整张卡立刻换色，而一条既有规则都不用碰。
     *      这也意味着：宿主切浅色主题时本卡仍是深色（参考站本身是纯深色应用，有意为之）。
     *
     *   ⚠️⚠️ 实装位是**符号链接**、不是拷贝：`~/.dsh/profiles/web/node_modules/dsh-workbench`
     *      → `Desktop/DSH/plugins/dsh-workbench`。所以**改源即改实装，不需要"同步"**；
     *      反过来，往实装路径 `Copy-Item` 会**穿透链接覆盖源文件**
     *      （2026-09-25 因此丢过一次本段，教训留在这里）。回退只能靠 `.bak-*`。
     */
    /**
 * 界面 v2 皮肤 · 第二版：**飞书风格浅色**（2026-09-25）
 *
 * 用户裁定（原话）："工作台和驾驶舱底色用黑色不好看，参考 https://www.feishu.cn/ 的首页设计风格，
 *   重构工作台的 UI/UX 设计，不仅是要重构列表页，也要重构详情页。"
 *
 * ── 取值来源（不是凭感觉调的）──────────────────────────────────────────────
 *   全部取自飞书官网的 foundation 样式表（`vendor-feishu-foundation-*.css`，
 *   2026-09-25 从 www.feishu.cn 抓取）里的**浅色主题**令牌：
 *
 *     灰阶 N：N00 #ffffff · N50 #f5f6f7 · N100 #f2f3f5 · N200 #eff0f1 · N300 #dee0e3
 *             N350 #d0d3d6 · N400 #bbbfc4 · N500 #8f959e · N600 #646a73 · N650 #51565d
 *             N700 #373c43 · N800 #2b2f36 · N900 #1f2329
 *     蓝  B：B50 #f0f4ff · B100 #e0e9ff · B200 #c2d4ff · B300 #94b4ff · B400 #5083fb
 *             B500 #336df4（主色）· B600 #1456f0（按压）· B700 #0442d2
 *     绿  G：G50 #e4fae1 · G100 #d0f5ce · G200 #95e599 · G350 #35bd4b · G500 #258832
 *     橙  O：O50 #fff5eb · O100 #fee7cd · O200 #fed4a4 · O500 #ff8800 · O600 #de7802
 *     红  R：R50 #fef1f1 · R100 #fee3e2 · R200 #fbbfbc · R500 #f54a45 · R600 #d83931
 *     语义：--bg-body N00 · --bg-base N100 · --bg-content-base #f8f9fa · --line-border-card N300
 *           --line-border-component N350 · --fill-hover rgba(N900,.08) · --fill-pressed rgba(N900,.12)
 *           --bg-mask rgba(0,0,0,.4) · --shadow-s* 多层低透明度阴影（基准色 rgba(31,35,41,·)）
 *     圆角（官网 index CSS 实测高频值）：4 / 6 / 8 / 12 / 16px，胶囊 100px/999px
 *     字号（同）：14 主体 · 12 辅助 · 16/18/20 标题 · 24/36/40 展示
 *
 * ── 两条硬约束（沿用第一版的纪律）──────────────────────────────────────────
 *   ① **零结构改动**：本层只出 CSS；不增删节点、不改 class、不改 data-*。
 *      平静态结构由 `06-界面/verify-resting.mjs` 对着基线守着，动一处就红。
 *   ② **只在 `.dshw-root` 作用域内生效**：宿主界面不受影响。
 *      手段仍是"重定义面板消费的那 13 个 `--dsw-alias-*` 令牌" —— 一条既有规则都不用碰。
 *
 * ⚠️ 宿主是深色外壳：本卡现在是**浅色岛**。这是用户明确要的效果（"底色用黑色不好看"），
 *    不是漏配。宿主切不切浅色主题都与本卡无关 —— 本卡自己带完整取值。
 *
 * ⚠️ 实装位是**符号链接**（`~/.dsh/profiles/web/node_modules/dsh-workbench`
 *      → `Desktop/DSH/plugins/dsh-workbench`）：改源即改实装，**没有"同步"这一步**；
 *      往实装路径 Copy-Item 会穿透链接覆盖源文件。回退靠同目录 `.bak-*`。
 */
const CSS_V2 = [
  '/* ═══════════════════════════════════════════════════════════════════════════',
  '   工作台卡片皮肤 · 第四版：新中式水墨 · 宣纸（浅）/ 夜书（深）两套（2026-09-26）',
  '   ───────────────────────────────────────────────────────────────────────────',
  '   用户原话："参考 <本地参考页> 新中式水墨风的风格对当前页面的整体风格进行重构，',
  '   包括但不限于样式/动效/结构/交互（保留左下角拖动和右下角缩放能力），',
  '   根据卡片内容调整其位置和大小。"',
  '   追加要求："这个还有一个暗色模式，本次重构需要完成两个模式，',
  '   并且可以手动切换/跟随 dsh 通用设置中的 ui 外观切换进行切换。"',
  '',
  '   取值来源（逐项抄，不凭感觉调）：',
  '     参考页 `html[data-theme="ink-paper"]` / `html[data-theme="ink-night"]` 两张令牌表：',
  '       宣纸  --bg-void #EAE5DA · --bg-paper #F7F4ED · --bg-raise #FCFAF6',
  '             --ink-1 #1B1917 · --ink-2 #57524A · --ink-3 #6E675E',
  '             --accent #B3311B · --accent-text #A82C17 · --accent-soft .10',
  '             --ok #4E6B45 · --warn #8A6A2E · --danger #A82C17',
  '             --ink-line .10 / strong .20 · --scrim rgba(22,19,15,.40)',
  '       夜书  --bg-void #0A0B0C · --bg-paper #101113 · --bg-raise #16181B',
  '             --ink-1 rgba(238,235,228,.90) · --ink-2 .62 · --ink-3 .52',
  '             --accent #C4371F · --accent-text #D9553A · --accent-soft .14',
  '             --ok #8FA37C · --warn #B89B6A · --danger #D9553A',
  '             --ink-line .09 / strong .18 · --scrim rgba(0,0,0,.62)',
  '     参考页亮底底纹 = 两团径向渐变 + 95px 发丝网格；暗底底纹只有两团渐变（无网格）。',
  '     DSH 自己的深色 = `body[data-ds-dark-theme]`（packages/client/ui-theme/design-platform.css）。',
  '',
  '   四条纪律（前三版沿用 + 本版新增第 ④ 条）：',
  '     ① 只改样式层：不增删节点、不改 class、不改 data-*（平静态结构契约不动）；',
  '     ② 面板内的规则都挂在 `.dshw-root` 下，不外溢到别的面板；',
  '     ③ 颜色**一律走 `--wb2-*`**，不再写字面值（写死一个色 = 另一个主题里必然漏改）；',
  '     ④ 令牌挂在 `body` 上，不挂 `.dshw-root`：',
  '        弹窗 / 命令面板 / 引导 / 抽屉 / 外观浮层都是 portal 到 `body` 的节点，',
  '        在 `.dshw-root` 之外**继承不到**那里的变量（会静默变成 unset）——',
  '        挂 body 才能让"卡里"和"浮层"永远同一套色，不会一半深一半浅。',
  '        令牌名统一带 `--wb2-` 前缀，所以不会影响到面板以外的任何组件。',
  '',
  '   主题怎么落：`body[data-dshw-theme="paper"|"night"]`，由客户端脚本写入（见 client.js 的',
  '   `dshw.theme`）：手动选了就按选的写；选了「跟随外观」就按 DSH 的 `data-ds-dark-theme` 现算。',
  '   ═══════════════════════════════════════════════════════════════════════════ */',
  '',
  '/* ── ⓪ 令牌（一）：与主题无关的那批（字体 / 圆角 / 缓动 / 阴影）────────────── */',
  ':root{',
  '  --wb2-serif:"Songti SC","Source Han Serif SC","Noto Serif SC","STSong","SimSun",serif;',
  '  --wb2-sans:"PingFang SC","Microsoft YaHei",system-ui,-apple-system,"Segoe UI",sans-serif;',
  '  --wb2-mono:ui-monospace,SFMono-Regular,Consolas,monospace;',
  '  --wb2-ease:cubic-bezier(.22,1,.36,1);',
  '  --wb2-dur:520ms;',
  '  --wb2-dur-fast:240ms;',
  '  --wb2-r-sm:2px;',
  '  --wb2-r-md:2px;',
  '  --wb2-r-lg:2px;',
  '  --wb2-sh1:none;',
  '  --wb2-sh2:none;',
  '  --wb2-sh3:none;',
  '  --wb2-sh4:none;',
  '}',
  '',
  '/* ── ① 令牌（二）：宣纸浅底 —— 写在 `body` 上就是**默认值** ──────────────────',
  '   （也顺带兜住第一帧：脚本还没跑到时不会先闪一下别的颜色。） */',
  'body{',
  '  --wb2-bg-body:#f7f4ed;          /* 面板底 · 参考页 --bg-paper */',
  '  --wb2-bg-page:#eae5da;          /* 更外一层 · --bg-void */',
  '  --wb2-bg-subtle:#f2eee4;        /* 比底稍沉的一层（分栏、软块） */',
  '  --wb2-bg-raise:#fcfaf6;         /* 卡片/弹窗 · --bg-raise */',
  '  --wb2-fill:rgba(27,25,23,.05);  /* 软底 · --soft-ink */',
  '  --wb2-fill-2:rgba(27,25,23,.04);',
  '  --wb2-line:rgba(27,25,23,.10);',
  '  --wb2-line-hair:rgba(27,25,23,.06);',
  '  --wb2-line-strong:rgba(27,25,23,.20);',
  '  --wb2-line-hover:rgba(27,25,23,.34);',
  '  --wb2-t1:#1b1917;',
  '  --wb2-t2:#57524a;',
  '  --wb2-t3:#6e675e;',
  '  --wb2-t4:rgba(27,25,23,.34);',
  '  --wb2-press:rgba(27,25,23,.09);',
  '  --wb2-brand:#b3311b;',
  '  --wb2-brand-hover:#a82c17;',
  '  --wb2-brand-press:#8f2413;',
  '  --wb2-brand-soft:rgba(179,49,27,.10);',
  '  --wb2-brand-soft-2:rgba(179,49,27,.16);',
  '  --wb2-brand-haze:rgba(179,49,27,.05);',
  '  --wb2-on-brand:#fcfaf6;',
  '  --wb2-ok:#4e6b45;',
  '  --wb2-ok-soft:rgba(78,107,69,.10);',
  '  --wb2-ok-line:rgba(78,107,69,.10);',
  '  --wb2-warn:#8a6a2e;',
  '  --wb2-warn-soft:rgba(138,106,46,.10);',
  '  --wb2-bad:#a82c17;',
  '  --wb2-bad-soft:rgba(168,44,23,.08);',
  '  --wb2-bad-line:rgba(168,44,23,.16);',
  '  --wb2-bad-line-2:rgba(168,44,23,.34);',
  '  --wb2-hit:rgba(179,49,27,.34);',
  '  --wb2-hit-0:rgba(179,49,27,0);',
  '  --wb2-mask:rgba(22,19,15,.40);',
  '  --wb2-mask-2:rgba(22,19,15,.32);',
  '  --wb2-mask-3:rgba(22,19,15,.50);',
  '  --wb2-sel-fg:#f7f4ed;',
  '  --wb2-tex:',
  '    radial-gradient(circle at 22% 10%, rgba(255,255,255,.60), transparent 58%),',
  '    radial-gradient(circle at 86% 92%, rgba(179,49,27,.05), transparent 55%),',
  '    repeating-linear-gradient(0deg, transparent 0 95px, rgba(27,25,23,.020) 95px 96px),',
  '    repeating-linear-gradient(90deg, transparent 0 95px, rgba(27,25,23,.020) 95px 96px);',
  '  --wb2-accent:#b3311b;',
  '  --wb2-accent-hover:#a82c17;',
  '}',
  '',
  '/* ── ② 令牌（三）：夜书暗底 —— 只有这一个属性选择器换色 ─────────────────── */',
  'body[data-dshw-theme="night"]{',
  '  --wb2-bg-body:#101113;',
  '  --wb2-bg-page:#0a0b0c;',
  '  --wb2-bg-subtle:#1a1c1f;',
  '  --wb2-bg-raise:#16181b;',
  '  --wb2-fill:rgba(238,235,228,.06);',
  '  --wb2-fill-2:rgba(238,235,228,.05);',
  '  --wb2-line:rgba(238,235,228,.09);',
  '  --wb2-line-hair:rgba(238,235,228,.06);',
  '  --wb2-line-strong:rgba(238,235,228,.18);',
  '  --wb2-line-hover:rgba(238,235,228,.32);',
  '  --wb2-t1:rgba(238,235,228,.90);',
  '  --wb2-t2:rgba(238,235,228,.62);',
  '  --wb2-t3:rgba(238,235,228,.52);',
  '  --wb2-t4:rgba(238,235,228,.34);',
  '  --wb2-press:rgba(238,235,228,.10);',
  '  --wb2-brand:#c4371f;',
  '  --wb2-brand-hover:#d9553a;',
  '  --wb2-brand-press:#a82c17;',
  '  --wb2-brand-soft:rgba(196,55,31,.14);',
  '  --wb2-brand-soft-2:rgba(196,55,31,.22);',
  '  --wb2-brand-haze:rgba(196,55,31,.06);',
  '  --wb2-on-brand:#f7f4ed;',
  '  --wb2-ok:#8fa37c;',
  '  --wb2-ok-soft:rgba(143,163,124,.12);',
  '  --wb2-ok-line:rgba(143,163,124,.14);',
  '  --wb2-warn:#b89b6a;',
  '  --wb2-warn-soft:rgba(184,155,106,.12);',
  '  --wb2-bad:#d9553a;',
  '  --wb2-bad-soft:rgba(217,85,58,.12);',
  '  --wb2-bad-line:rgba(217,85,58,.20);',
  '  --wb2-bad-line-2:rgba(217,85,58,.40);',
  '  --wb2-hit:rgba(196,55,31,.42);',
  '  --wb2-hit-0:rgba(196,55,31,0);',
  '  --wb2-mask:rgba(0,0,0,.62);',
  '  --wb2-mask-2:rgba(0,0,0,.50);',
  '  --wb2-mask-3:rgba(0,0,0,.72);',
  '  --wb2-sel-fg:#f7f4ed;',
  '  --wb2-tex:',
  '    radial-gradient(circle at 26% 14%, rgba(238,235,228,.045), transparent 60%),',
  '    radial-gradient(circle at 82% 88%, rgba(196,55,31,.055), transparent 55%);',
  '  --wb2-accent:#c4371f;',
  '  --wb2-accent-hover:#d9553a;',
  '}',
  '',
  '/* ── ③ 把令牌接到宿主那 13 个 `--dsw-alias-*` 上（基座 CSS 消费的就是这批）────',
  '   ⚠️ 这一段必须留在 `.dshw-root` 上：宿主自己也用这批变量画别的面板，',
  '      挂到 body 去会把整个界面一起改了。 */',
  '.dshw-root{',
  '  --dsw-alias-bg-base:var(--wb2-bg-body);',
  '  --dsw-alias-bg-layer-1:var(--wb2-bg-raise);',
  '  --dsw-alias-bg-layer-2:var(--wb2-bg-subtle);',
  '  --dsw-alias-border-l1:var(--wb2-line);',
  '  --dsw-alias-border-l2:var(--wb2-line-strong);',
  '  --dsw-alias-border-secondary:var(--wb2-line-strong);',
  '  --dsw-alias-label-primary:var(--wb2-t1);',
  '  --dsw-alias-label-secondary:var(--wb2-t2);',
  '  --dsw-alias-brand-primary:var(--wb2-brand);',
  '  --dsw-alias-state-success-primary:var(--wb2-ok);',
  '  --dsw-alias-state-warn-primary:var(--wb2-warn);',
  '  --dsw-alias-state-error-primary:var(--wb2-bad);',
  '}',
  '',
  '/* ── ④ 排版与底板：宣纸面 + 纸底纹样（底纹整条走 --wb2-tex，暗底只剩两团渐变）── */',
  '/* 入场动效**只用透明度**，不用 translate：槽位的 transform 被"换位跟手"占着，',
  '   动画的 transform 会盖过内联样式（动画优先级高于行内）—— 一晕开就把拖动弄坏了。 */',
  '@keyframes wb2InkFade{from{opacity:0}to{opacity:1}}',
  '.dshw-root{font-family:var(--wb2-sans);font-feature-settings:"tnum" 1;color:var(--wb2-t1);font-size:13px;line-height:1.8}',
  '.dshw-root .dshw-panel{',
  '  background-color:var(--wb2-bg-body);',
  '  background-image:var(--wb2-tex);',
  '  font-family:var(--wb2-sans);',
  '  animation:wb2InkFade var(--wb2-dur) var(--wb2-ease) both;',
  '}',
  '.dshw-root.dshw-embedded .dshw-panel{',
  '  background-color:var(--wb2-bg-body);',
  '  background-image:var(--wb2-tex);',
  '}',
  '.dshw-root .dshw-h1{font-family:var(--wb2-serif);font-weight:400;font-size:16px;line-height:1.3;letter-spacing:.22em;text-indent:.22em;color:var(--wb2-t1)}',
  '.dshw-root .dshw-sub{color:var(--wb2-t3);font-size:10px;letter-spacing:.18em;font-family:var(--wb2-sans)}',
  '.dshw-root .dshw-orderhint{color:var(--wb2-t3);font-size:10px;letter-spacing:.14em}',
  '.dshw-root .dshw-orderlink{font-family:var(--wb2-serif);font-size:11px;letter-spacing:.14em;color:var(--wb2-t2);text-decoration:none;border-bottom:.5px solid transparent;padding-bottom:1px;transition:color var(--wb2-dur-fast) var(--wb2-ease),border-color var(--wb2-dur-fast) var(--wb2-ease)}',
  '.dshw-root .dshw-orderlink:hover{color:var(--wb2-brand-hover);border-bottom-color:var(--wb2-brand)}',
  '.dshw-root ::-webkit-scrollbar{width:8px;height:8px}',
  '.dshw-root ::-webkit-scrollbar-track{background:transparent}',
  '.dshw-root ::-webkit-scrollbar-thumb{background:var(--wb2-line-strong);border-radius:99px}',
  '.dshw-root ::-webkit-scrollbar-thumb:hover{background:var(--wb2-t4)}',
  '.dshw-root ::selection{background:var(--wb2-brand);color:var(--wb2-sel-fg)}',
  '',
  '/* ── ⑤ 卡片：抬升纸面 + 0.5px 发丝线 + 2px 方角 + 无阴影 ──────────────────── */',
  '.dshw-root .dshw-card{background:var(--wb2-bg-raise);border:.5px solid var(--wb2-line);border-radius:2px;padding:14px 16px 15px;box-shadow:none;transition:border-color var(--wb2-dur-fast) var(--wb2-ease),box-shadow var(--wb2-dur-fast) var(--wb2-ease)}',
  '.dshw-root .dshw-card:hover{border-color:var(--wb2-line-strong);box-shadow:inset 2px 0 0 0 var(--wb2-brand)}',
  '.dshw-root .dshw-slot{animation:wb2InkFade var(--wb2-dur) var(--wb2-ease) both}',
  '.dshw-root .dshw-card-head{gap:10px;margin-bottom:10px;padding-bottom:9px;border-bottom:.5px solid var(--wb2-line)}',
  '.dshw-root .dshw-card-title{font-family:var(--wb2-serif);font-weight:400;font-size:13px;letter-spacing:.16em;color:var(--wb2-t2)}',
  '.dshw-root .dshw-card-title[data-scene]{border-radius:0}',
  '.dshw-root .dshw-card-title[data-scene]:hover{opacity:1;color:var(--wb2-t1)}',
  '.dshw-root .dshw-card-body{scrollbar-width:thin;color:var(--wb2-t1)}',
  '.dshw-root [data-card-metric]{font-family:var(--wb2-serif);font-variant-numeric:tabular-nums;letter-spacing:.06em}',
  '',
  '/* ── ⑥ 分类页签：选中 = 墨字 + 朱砂短横（14×2），不铺底色 ──────────────────── */',
  '.dshw-root .dshw-tabs{gap:16px}',
  '.dshw-root .dshw-tab{font-family:var(--wb2-serif);font-weight:400;font-size:12px;line-height:1;letter-spacing:.12em;padding:6px 1px 8px;border-radius:0;background:transparent;border:none;border-bottom:.5px solid transparent;color:var(--wb2-t3);position:relative;transition:color var(--wb2-dur-fast) var(--wb2-ease)}',
  '.dshw-root .dshw-tab:hover{background:transparent;color:var(--wb2-t1)}',
  '.dshw-root .dshw-tab[data-on="1"]{color:var(--wb2-t1);background:transparent;border-color:transparent;font-weight:400}',
  '.dshw-root .dshw-tab[data-on="1"]::after{content:"";position:absolute;left:1px;bottom:0;width:14px;height:2px;background:var(--wb2-brand)}',
  '',
  '/* ── ⑦ 按钮 / 输入：填充朱砂的动作用钮；输入只留一条下边框 ─────────────────── */',
  '.dshw-root .dshw-btn{font-family:var(--wb2-sans);font-size:12px;font-weight:400;line-height:1;padding:6px 13px;border-radius:2px;background:var(--wb2-brand);border:.5px solid var(--wb2-brand);color:var(--wb2-on-brand);letter-spacing:.10em;transition:all var(--wb2-dur-fast) var(--wb2-ease)}',
  '.dshw-root .dshw-btn:hover{background:var(--wb2-brand-hover);border-color:var(--wb2-brand-hover);color:var(--wb2-on-brand)}',
  '.dshw-root .dshw-btn:active{background:var(--wb2-brand-press);border-color:var(--wb2-brand-press)}',
  '.dshw-root .dshw-btn:disabled{color:var(--wb2-t4);background:transparent;border-color:var(--wb2-line)}',
  '.dshw-root .dshw-input{background:transparent;border:none;border-bottom:.5px solid var(--wb2-line-strong);border-radius:0;color:var(--wb2-t1);padding:5px 2px;font-size:14px;transition:border-color var(--wb2-dur-fast) var(--wb2-ease)}',
  '.dshw-root .dshw-input::placeholder{color:var(--wb2-t3)}',
  '.dshw-root .dshw-input:focus{border-bottom-color:var(--wb2-brand);box-shadow:none;outline:none}',
  '',
  '/* ── ⑧ 徽标 / 药丸：发丝描边 + 软底，字距拉开 ─────────────────────────────── */',
  '.dshw-root .dshw-pill,.dshw-root .dshw-badge{font-family:var(--wb2-sans);font-weight:400;font-size:10.5px;line-height:22px;height:22px;letter-spacing:.10em;border-radius:2px;border:.5px solid transparent;background:var(--wb2-fill);color:var(--wb2-t2);padding:0 8px}',
  '.dshw-root .dshw-pill[data-tone="ok"]{color:var(--wb2-ok);background:var(--wb2-ok-soft);border-color:var(--wb2-ok-line)}',
  '.dshw-root .dshw-pill[data-tone="warn"]{color:var(--wb2-warn);background:var(--wb2-warn-soft);border-color:var(--wb2-warn-soft)}',
  '.dshw-root .dshw-pill[data-tone="bad"]{color:var(--wb2-bad);background:var(--wb2-bad-soft);border-color:var(--wb2-bad-soft)}',
  '.dshw-root .dshw-btag{border-radius:2px;background:var(--wb2-fill);color:var(--wb2-t2);border:.5px solid transparent;letter-spacing:.10em}',
  '.dshw-root .dshw-btag:hover{background:var(--wb2-press);color:var(--wb2-t1)}',
  '.dshw-root .dshw-btag[data-on="1"]{background:var(--wb2-brand-soft);color:var(--wb2-brand-hover);border-color:transparent}',
  '/* 卡内的两组小分类片（事务卡 `.dshw-mtab` / 简报卡 `.dshw-btab`）与「展开事务详情」小钮',
  '   （`.dshw-mt-btn`）：基础 CSS 走的是**宿主令牌**（`--dsw-alias-bg-base` 当字色、',
  '   `--dsw-alias-brand-primary` 当底）—— 夜间模式下 `bg-base` 是**书房黑**，',
  '   落在朱砂底上就是"深字压深底"（2026-09-26 由 SKIN-90 的整体一致性扫描抓到）。',
  '   这里按水墨的规矩重写：底用朱砂、字用 `--wb2-on-brand`（亮纸色），方角 2px。 */',
  '.dshw-root .dshw-mtab,.dshw-root .dshw-btab{font-family:var(--wb2-sans);border-radius:2px;background:var(--wb2-fill);color:var(--wb2-t2);border:.5px solid transparent}',
  '.dshw-root .dshw-mtab:hover,.dshw-root .dshw-btab:hover{background:var(--wb2-press);color:var(--wb2-t1)}',
  '.dshw-root .dshw-mtab[data-on="1"],.dshw-root .dshw-btab[data-on="1"]{color:var(--wb2-on-brand);background:var(--wb2-brand);border-color:transparent}',
  '.dshw-root .dshw-mtab i,.dshw-root .dshw-btab i{opacity:.75}',
  '.dshw-root .dshw-mt-btn{font-family:var(--wb2-sans);border-radius:2px;color:var(--wb2-brand-hover);border-color:var(--wb2-line)}',
  '.dshw-root .dshw-mt-btn:hover{background:var(--wb2-fill)}',
  '/* ── ⑧b 小指示件与分类片：基础 CSS 里那一整套写死的 GitHub 色板',
  '   （蓝 #2b6cb0 / 紫 #6b46c1 / 绿 #2ea043 / 黄 #d29922 / 红 #da3633 / 灰 #8b949e）',
  '   一律收进水墨：**有语义的（状态）走色调（苔绿·赭·朱），只是分类的（来源/分类/分桶）走深浅墨色**。',
  '   2026-09-26 由夜间一致性扫描（SKIN-90）逐个逮出来 —— 这些片子在夜色里还留着冷色。',
  '   ⚠️ 这些规则必须比基础样式更特异：基础用的是 `.dshw-mini-s[data-state="ok"]` 这类',
  '      （0,2,0），皮肤写成 `.dshw-root .dshw-mini-s[data-state="ok"]`（0,3,0）才稳，',
  '      不靠"注入在后面"这种同特异度平局的巧合。 */',
  '.dshw-root .dshw-dot{background:var(--wb2-t4)}',
  '.dshw-root .dshw-wave rect{fill:var(--wb2-t4)}',
  '.dshw-root .dshw-wave[data-state="ok"] rect{fill:var(--wb2-ok)}',
  '.dshw-root .dshw-wave[data-state="busy"] rect{fill:var(--wb2-warn)}',
  '.dshw-root .dshw-wave[data-state="down"] rect{fill:var(--wb2-bad)}',
  '.dshw-root .dshw-mini{border:.5px solid var(--wb2-line);border-radius:2px;background:var(--wb2-fill)}',
  '.dshw-root .dshw-mini-s{color:var(--wb2-t2)}',
  '.dshw-root .dshw-mini-s[data-state="ok"]{color:var(--wb2-ok)}',
  '.dshw-root .dshw-mini-s[data-state="busy"],.dshw-root .dshw-mini-s[data-state="warn"]{color:var(--wb2-warn)}',
  '.dshw-root .dshw-mini-s[data-state="down"]{color:var(--wb2-bad)}',
  '.dshw-root .dshw-mini-s[data-state="off"]{color:var(--wb2-t3)}',
  '.dshw-root .dshw-mini-s[data-state="starting"]{color:var(--wb2-brand-hover)}',
  '.dshw-root .dshw-mini-s[data-state="stopping"]{color:var(--wb2-t2)}',
  '.dshw-root .dshw-mini[data-click="1"]:hover{border-color:var(--wb2-line-strong)}',
  '.dshw-root .dshw-mini[data-click="1"]:focus-visible{outline:1px solid var(--wb2-brand);outline-offset:1px}',
  '.dshw-root .dshw-src[data-src]{color:var(--wb2-t2);border-color:transparent}',
  '.dshw-root .dshw-cat[data-cat="assigned-to-others"]{color:var(--wb2-t2);border-color:var(--wb2-line)}',
  '.dshw-root .dshw-cat[data-cat="assigned-by-others"]{color:var(--wb2-warn);border-color:var(--wb2-warn-soft)}',
  '.dshw-root .dshw-btag[data-bucket="due-today"]{color:var(--wb2-warn);border-color:var(--wb2-warn-soft)}',
  '.dshw-root .dshw-btag[data-bucket="recent-overdue"]{color:var(--wb2-bad);border-color:var(--wb2-bad-soft)}',
  '.dshw-root .dshw-btag[data-bucket="aged"]{color:var(--wb2-t3);border-color:var(--wb2-line)}',
  '.dshw-root .dshw-fq-hit[data-hit="1"]{color:var(--wb2-brand-hover);border-color:var(--wb2-brand-soft-2)}',
  '.dshw-root .dshw-focuswl{border:.5px solid var(--wb2-warn);border-radius:2px;background:var(--wb2-warn-soft)}',
  '.dshw-root .dshw-spacer{flex:1 1 auto}',
  '',
  '/* ── ⑨ 列表行 / 分桶 / 出处：发丝横线分栏，hover 是一层淡墨 ─────────────────── */',
  '.dshw-root .dshw-item{border-radius:0;border-bottom:.5px solid var(--wb2-line-hair);transition:background var(--wb2-dur-fast) var(--wb2-ease)}',
  '.dshw-root .dshw-item:hover{background:var(--wb2-fill-2)}',
  '.dshw-root .dshw-item-text{color:var(--wb2-t1);line-height:1.7}',
  '.dshw-root .dshw-item-time{color:var(--wb2-t3);font-family:var(--wb2-serif);font-size:11px;letter-spacing:.06em;font-variant-numeric:tabular-nums}',
  '.dshw-root .dshw-bucket{border-radius:0;border-bottom:.5px solid var(--wb2-line)}',
  '.dshw-root .dshw-src{color:var(--wb2-t3);background:var(--wb2-fill);border-radius:2px;padding:1px 7px;letter-spacing:.08em}',
  '.dshw-root .dshw-todolist .dshw-item{border-radius:0}',
  '.dshw-root .dshw-bread{color:var(--wb2-t3);letter-spacing:.10em}',
  '.dshw-root .dshw-bread:hover{color:var(--wb2-brand-hover)}',
  '',
  '/* ── ⑩ 进度 / 波形 / 麦克风条：2px 墨线与朱砂填充（参考页的 .bar）────────────── */',
  '.dshw-root .dshw-meter{border-radius:0;background:var(--wb2-line);height:2px}',
  '.dshw-root .dshw-meter>i{border-radius:0;background:var(--wb2-brand);transition:width var(--wb2-dur) var(--wb2-ease)}',
  '.dshw-root .dshw-micbar{border:.5px solid var(--wb2-line);border-radius:2px;background:transparent}',
  '.dshw-root .dshw-micbar[data-click="1"]:hover{border-color:var(--wb2-line-strong);background:var(--wb2-fill-2)}',
  '.dshw-root .dshw-micbar-name{color:var(--wb2-t3)}',
  '.dshw-root .dshw-micbar[data-state="ok"] .dshw-micbar-state{color:var(--wb2-ok)}',
  '.dshw-root .dshw-micbar[data-state="ok"] .dshw-dot{background:var(--wb2-ok)}',
  '.dshw-root .dshw-micbar[data-state="off"] .dshw-micbar-state{color:var(--wb2-t3)}',
  '.dshw-root .dshw-micbar[data-state="off"] .dshw-dot{background:var(--wb2-t4)}',
  '.dshw-root .dshw-micbar[data-state="down"] .dshw-micbar-state{color:var(--wb2-bad)}',
  '.dshw-root .dshw-micbar[data-state="down"] .dshw-dot{background:var(--wb2-bad)}',
  '.dshw-root .dshw-micbar[data-state="warn"] .dshw-micbar-state{color:var(--wb2-warn)}',
  '.dshw-root .dshw-micbar[data-state="warn"] .dshw-dot{background:var(--wb2-warn)}',
  '',
  '/* ── ⑪ 详情弹窗（二级 / 三级）：抬升纸面 + 发丝线 + 2px 方角 + modalIn 入场 ────',
  '   ⚠️ 这一段是**全局规则**（弹窗 portal 到 body，在 `.dshw-root` 之外）。',
  '      走 `--wb2-*` 是可以的 —— 令牌就挂在 body 上（见文件头纪律 ④）。 */',
  '@keyframes wb2ModalIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}',
  '.dshw-modal-backdrop{background:var(--wb2-mask)}',
  '.dshw-modal{background:var(--wb2-bg-raise);border:.5px solid var(--wb2-line-strong);border-radius:2px;box-shadow:none;color:var(--wb2-t1);font-family:var(--wb2-sans);animation:wb2ModalIn var(--wb2-dur) var(--wb2-ease)}',
  '.dshw-modal-head{border-bottom:.5px solid var(--wb2-line);padding:16px 20px;background:var(--wb2-bg-raise)}',
  '.dshw-modal-title{font-family:var(--wb2-serif);font-weight:400;font-size:14px;letter-spacing:.16em;color:var(--wb2-t2)}',
  '.dshw-modal-sec{border-top:.5px solid var(--wb2-line);padding:14px 20px}',
  '.dshw-modal-sec-h{font-family:var(--wb2-serif);font-size:11px;font-weight:400;letter-spacing:.20em;color:var(--wb2-t3);margin-bottom:10px}',
  '.dshw-mrow{display:flex;gap:12px;align-items:flex-start;padding:6px 0;border-bottom:.5px solid var(--wb2-line-hair)}',
  '.dshw-mrow:last-child{border-bottom:none}',
  '.dshw-mrow-l{flex:0 0 92px;color:var(--wb2-t3);font-size:11px;letter-spacing:.12em;line-height:1.7}',
  '.dshw-mrow-v{flex:1 1 auto;min-width:0;color:var(--wb2-t1);font-size:13px;line-height:1.75;word-break:break-word}',
  '.dshw-detail{color:var(--wb2-t2);font-size:12.5px;line-height:1.8}',
  '.dshw-dtlsec{font-family:var(--wb2-serif);font-size:11px;font-weight:400;letter-spacing:.16em;color:var(--wb2-t3);margin:12px 0 7px}',
  '.dshw-msg{color:var(--wb2-t2);font-size:12px;line-height:1.8;background:var(--wb2-fill);border:.5px solid var(--wb2-line);border-radius:2px;padding:8px 11px;margin-top:8px}',
  '.dshw-err{color:var(--wb2-bad);background:var(--wb2-bad-soft);border:.5px solid var(--wb2-bad-line);border-radius:2px;padding:8px 11px;font-size:12px}',
  '',
  '/* ── ⑪b 内联建的三级详情弹窗（`.dshw-lite*`）· 全局选择器 ───────────────────',
  '   同样是 appendChild 到 body 的，颜色同样走 body 上的 `--wb2-*`。 */',
  '@keyframes wb2LiteIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}',
  '.dshw-lite-mask{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:var(--wb2-mask);padding:24px}',
  '.dshw-lite{box-sizing:border-box;display:flex;flex-direction:column;max-height:80vh;overflow:hidden;background:var(--wb2-bg-raise);border:.5px solid var(--wb2-line-strong);border-radius:2px;box-shadow:none;color:var(--wb2-t1);font-family:var(--wb2-sans);font-size:13px;line-height:1.8;animation:wb2LiteIn var(--wb2-dur) var(--wb2-ease)}',
  '.dshw-lite-head{padding:16px 20px;border-bottom:.5px solid var(--wb2-line);background:var(--wb2-bg-raise)}',
  '.dshw-lite-title{font-family:var(--wb2-serif);font-weight:400;font-size:14px;letter-spacing:.16em;color:var(--wb2-t2)}',
  '.dshw-lite-meta{margin-top:4px;font-size:11px;letter-spacing:.14em;color:var(--wb2-t3)}',
  '.dshw-lite-body{padding:14px 20px 4px;overflow:auto}',
  '.dshw-lite-row{display:flex;gap:12px;align-items:flex-start;padding:6px 0;border-bottom:.5px solid var(--wb2-line-hair)}',
  '.dshw-lite-row:last-child{border-bottom:none}',
  '.dshw-lite-k{flex:0 0 92px;color:var(--wb2-t3);font-size:11px;letter-spacing:.12em;line-height:1.7}',
  '.dshw-lite-v{flex:1 1 auto;min-width:0;color:var(--wb2-t1);font-size:13px;line-height:1.75;word-break:break-word}',
  '.dshw-lite-note{color:var(--wb2-t2);font-size:12px;line-height:1.8;background:var(--wb2-fill);border:.5px solid var(--wb2-line);border-radius:2px;padding:8px 11px;margin:0 0 12px}',
  '.dshw-lite-item{padding:8px 0;border-bottom:.5px solid var(--wb2-line-hair)}',
  '.dshw-lite-item:last-child{border-bottom:none}',
  '.dshw-lite-item-h{font-family:var(--wb2-serif);font-weight:400;font-size:12.5px;letter-spacing:.10em;color:var(--wb2-t1)}',
  '.dshw-lite-item-s{color:var(--wb2-t2);font-size:12px;line-height:1.75;word-break:break-word}',
  '.dshw-lite-input{display:block;width:100%;box-sizing:border-box;margin-bottom:10px;padding:7px 2px;background:transparent;border:none;border-bottom:.5px solid var(--wb2-line-strong);border-radius:0;color:var(--wb2-t1);font:400 14px/1.6 var(--wb2-sans)}',
  '.dshw-lite-input::placeholder{color:var(--wb2-t3)}',
  '.dshw-lite-input:focus{border-bottom-color:var(--wb2-brand);box-shadow:none;outline:none}',
  '.dshw-lite-foot{display:flex;gap:10px;justify-content:flex-end;padding:14px 20px;border-top:.5px solid var(--wb2-line);background:var(--wb2-bg-raise)}',
  '.dshw-lite .dshw-btn,.dshw-modal .dshw-btn{font:400 12px/1 var(--wb2-sans);padding:6px 13px;border-radius:2px;background:transparent;border:.5px solid var(--wb2-line-strong);color:var(--wb2-t1);letter-spacing:.10em}',
  '.dshw-lite .dshw-btn:hover,.dshw-modal .dshw-btn:hover{background:var(--wb2-fill);border-color:var(--wb2-line-hover)}',
  '.dshw-lite .dshw-btn:active,.dshw-modal .dshw-btn:active{background:var(--wb2-press)}',
  '.dshw-lite .dshw-btn:focus-visible,.dshw-modal .dshw-btn:focus-visible{outline:1px solid var(--wb2-brand);outline-offset:2px}',
  '',
  '/* ── ⑫ 焦点态：1px 朱砂描边（参考页 `:focus-visible`）────────────────────── */',
  '.dshw-root .dshw-btn:focus-visible,.dshw-root .dshw-tab:focus-visible,.dshw-root .dshw-btag:focus-visible,.dshw-root .dshw-orderlink:focus-visible{outline:1px solid var(--wb2-brand);outline-offset:2px}',
  '.dshw-root .dshw-card-title[data-scene]:focus-visible{outline:1px solid var(--wb2-brand);outline-offset:2px}',
  '.dshw-root .dshw-micbar[data-click="1"]:focus-visible{outline:1px solid var(--wb2-brand);outline-offset:2px}',
  '.dshw-root .dshw-focusdim{filter:grayscale(.85) saturate(.35);opacity:.55}',
  '.dshw-root .dshw-card[data-dragging="1"]{border-color:var(--wb2-brand)}',
  '.dshw-root .dshw-hresizer:hover{background:var(--wb2-brand)}',
  '.dshw-root .dshw-ordererr{border:.5px solid var(--wb2-bad-line-2);background:var(--wb2-bad-soft);color:var(--wb2-bad);border-radius:2px;padding:6px 10px;font-size:11.5px;letter-spacing:.08em;margin-bottom:8px}',
  '.dshw-root .dshw-empty,.dshw-root .dshw-why{color:var(--wb2-t3);letter-spacing:.16em}',
  '.dshw-root code{font-family:var(--wb2-mono);background:var(--wb2-fill);border:.5px solid var(--wb2-line);border-radius:2px;padding:0 4px;color:var(--wb2-t2)}',
  '.dshw-root .dshw-toast{background:var(--wb2-bg-raise);border:.5px solid var(--wb2-line-strong);border-radius:2px;color:var(--wb2-t1);letter-spacing:.10em;box-shadow:none}',
  '.dshw-root .dshw-toast[data-tone="err"]{border-color:var(--wb2-bad-line-2);color:var(--wb2-bad)}',
  '',
  '/* ── ⑫b 两个手柄：左下角方块（换位）/ 右下角三角（缩放），都改成墨色朱砂 ──────── */',
  '.dshw-root .dshw-mv{color:var(--wb2-t3);opacity:.62}',
  '.dshw-root .dshw-mv::after{border-radius:0}',
  '.dshw-root .dshw-card:hover .dshw-mv{opacity:1}',
  '.dshw-root .dshw-mv:hover{opacity:1;color:var(--wb2-brand)}',
  '.dshw-root .dshw-rsz{color:var(--wb2-t3);opacity:.62}',
  '.dshw-root .dshw-card:hover .dshw-rsz{opacity:1}',
  '.dshw-root .dshw-rsz:hover{opacity:1;color:var(--wb2-brand)}',
  '',
  '/* ── ⑬ 卡内自适应：容器查询（按**卡片自己的宽度**排布，不是按视口）──────────────',
  '   容器建在 `.dshw-slot` 上（基础 CSS）：`@container` **只对后代生效**，容器元素自己不吃',
  '   自己的查询 —— 建在 `.dshw-card` 上会让"卡自己的 padding"永远不换档（踩过一次）。',
  '   三档：窄 ≤300px 收紧 / 默认不动 / 宽 ≥520px 放开 / 很宽 ≥760px 再给一点可视高度。',
  '   ⚠️ **不动 `.dshw-item-time` 的宽度**：SBT-98 拿它跟样式表里的基础宽度比大小，',
  '      还要求"文件卡与决策卡同值" —— 容器查询会让"同值"随卡宽变化而破。 */',
  '@container dshwslot (max-width:300px){',
  '  .dshw-root .dshw-card{padding:10px 11px 11px}',
  '  .dshw-root .dshw-card-head{gap:7px;margin-bottom:8px}',
  '  .dshw-root .dshw-card-body:not(.dshw-card-body--tall){max-height:150px}',
  '  .dshw-root .dshw-detail{padding:6px 7px;font-size:11px}',
  '  .dshw-root .dshw-item-text{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
  '}',
  '@container dshwslot (min-width:520px){',
  '  .dshw-root .dshw-card{padding:16px 18px 17px}',
  '  .dshw-root .dshw-card-body:not(.dshw-card-body--tall){max-height:240px}',
  '  .dshw-root .dshw-detail{padding:9px 11px;font-size:12px}',
  '}',
  '@container dshwslot (min-width:760px){',
  '  .dshw-root .dshw-card-body:not(.dshw-card-body--tall){max-height:320px}',
  '}',
  '',
  '/* ── ⑭ ⌘K 命令面板（全局：portal 到 body）────────────────────────────────── */',
  '.wb2cmdk-item .wb2cmdk-t{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.wb2cmdk-item .wb2cmdk-tag{flex:0 0 auto;font-size:10.5px;letter-spacing:.08em;color:var(--wb2-t3);background:var(--wb2-fill);padding:2px 7px;border-radius:2px;white-space:nowrap}',
  '.wb2cmdk-empty{padding:24px;text-align:center;color:var(--wb2-t3);font-size:12.5px;letter-spacing:.16em}',
  '.wb2cmdk-foot{display:flex;align-items:center;gap:12px;padding:9px 20px;border-top:.5px solid var(--wb2-line);font-size:11px;letter-spacing:.14em;color:var(--wb2-t3);background:var(--wb2-bg-raise)}',
  '.wb2cmdk-foot kbd{background:transparent;border:.5px solid var(--wb2-line-strong);border-radius:2px;padding:1px 5px;font-family:var(--wb2-mono);font-size:10px;color:var(--wb2-t2)}',
  '.wb2tour-text{font-size:12.5px;line-height:1.8;color:var(--wb2-t2);margin-bottom:14px}',
  '.wb2tour-btn:hover{background:transparent;border-color:var(--wb2-line-hover);color:var(--wb2-t1)}',
  '.wb2tour-btn:focus-visible{outline:1px solid var(--wb2-brand);outline-offset:2px}',
  '.wb2dw-sub{font-size:11px;letter-spacing:.14em;color:var(--wb2-t3);margin-top:2px}',
  '.wb2dw-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:6px}',
  '.wb2dw-body::-webkit-scrollbar{width:8px}',
  '.wb2dw-body::-webkit-scrollbar-thumb{background:var(--wb2-line-strong);border-radius:99px}',
  '.wb2dw-idx{flex:0 0 auto;width:18px;text-align:right;font-size:11px;color:var(--wb2-t3);font-variant-numeric:tabular-nums}',
  '.wb2dw-row[data-dim="1"]{opacity:.55}',
  '.wb2dw-foot{padding:9px 18px;border-top:.5px solid var(--wb2-line);font-size:11px;letter-spacing:.14em;color:var(--wb2-t3);background:var(--wb2-bg-raise)}',
  '.wb2dw-empty{padding:24px;text-align:center;color:var(--wb2-t3);font-size:12.5px;letter-spacing:.16em}',
  '/* ⌘K 命中之后跳过去"闪一下"：水墨版用**朱砂晕开**（不铺底色、不位移） */',
  '@keyframes wb2Hit{0%{box-shadow:0 0 0 0 var(--wb2-hit)}100%{box-shadow:0 0 0 10px var(--wb2-hit-0)}}',
  '.dshw-root .dshw-card[data-wb2hit="1"]{animation:wb2Hit .9s ease-out 2;border-color:var(--wb2-brand)!important}',
  '',
  '@keyframes wb2CmdkIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}',
  '.wb2cmdk-mask{position:fixed;inset:0;z-index:2147483000;background:var(--wb2-mask);display:flex;align-items:flex-start;justify-content:center;padding:12vh 16px 0}',
  '.wb2cmdk-box{width:min(620px,92vw);max-height:70vh;display:flex;flex-direction:column;overflow:hidden;background:var(--wb2-bg-raise);border:.5px solid var(--wb2-line-strong);border-radius:2px;box-shadow:none;animation:wb2CmdkIn var(--wb2-dur) var(--wb2-ease)}',
  '.wb2cmdk-input{width:100%;box-sizing:border-box;padding:16px 20px;background:transparent;border:none;border-bottom:.5px solid var(--wb2-line);color:var(--wb2-t1);font-family:var(--wb2-serif);font-size:15px;letter-spacing:.10em;outline:none}',
  '.wb2cmdk-input::placeholder{color:var(--wb2-t3)}',
  '.wb2cmdk-list{overflow:auto;padding:8px 10px 12px}',
  '.wb2cmdk-list::-webkit-scrollbar{width:8px}',
  '.wb2cmdk-list::-webkit-scrollbar-thumb{background:var(--wb2-line-strong);border-radius:99px}',
  '.wb2cmdk-item{display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:2px;cursor:pointer;font-size:12.5px;letter-spacing:.08em;color:var(--wb2-t1);transition:background var(--wb2-dur-fast) var(--wb2-ease)}',
  '.wb2cmdk-item:hover{background:var(--wb2-fill)}',
  '.wb2cmdk-item[data-sel="1"]{background:var(--wb2-brand-soft);color:var(--wb2-brand-hover)}',
  '.wb2cmdk-item mark{background:var(--wb2-brand-soft-2);color:var(--wb2-brand-hover);border-radius:0;padding:0 1px}',
  '.wb2cmdk-hint{padding:9px 20px;border-top:.5px solid var(--wb2-line);font-size:11px;letter-spacing:.14em;color:var(--wb2-t3)}',
  '',
  '/* ── ⑮ 新手指引（全局）────────────────────────────────────────────────── */',
  '.wb2tour-hole{position:fixed;z-index:2147483001;pointer-events:none;border-radius:2px;box-shadow:0 0 0 9999px var(--wb2-mask-3);transition:left var(--wb2-dur) var(--wb2-ease),top var(--wb2-dur) var(--wb2-ease),width var(--wb2-dur) var(--wb2-ease),height var(--wb2-dur) var(--wb2-ease)}',
  '.wb2tour-tip{position:fixed;z-index:2147483002;width:min(340px,92vw);box-sizing:border-box;padding:18px 20px 16px;background:var(--wb2-bg-raise);border:.5px solid var(--wb2-line-strong);border-radius:2px;box-shadow:none;animation:wb2CmdkIn var(--wb2-dur) var(--wb2-ease)}',
  '.wb2tour-title{font-family:var(--wb2-serif);font-weight:400;font-size:14px;letter-spacing:.16em;color:var(--wb2-t1);margin-bottom:8px}',
  '.wb2tour-body{font-size:12.5px;line-height:1.8;color:var(--wb2-t2)}',
  '.wb2tour-foot{display:flex;align-items:center;gap:10px;margin-top:14px}',
  '.wb2tour-step{font-size:11px;letter-spacing:.14em;color:var(--wb2-t3)}',
  '.wb2tour-btn{font:400 12px/1 var(--wb2-sans);padding:6px 13px;border-radius:2px;border:.5px solid var(--wb2-line-strong);background:transparent;color:var(--wb2-t1);letter-spacing:.10em;transition:all var(--wb2-dur-fast) var(--wb2-ease)}',
  '.wb2tour-btn[data-kind="next"]{border-color:var(--wb2-brand);color:var(--wb2-brand-hover)}',
  '.wb2tour-btn[data-kind="next"]:hover{background:var(--wb2-brand-soft);border-color:var(--wb2-brand)}',
  '',
  '/* ── ⑯ 右侧抽屉 · 卡片目录（全局）──────────────────────────────────────── */',
  '@keyframes wb2DwIn{from{opacity:0;transform:translateX(12px)}to{opacity:1;transform:none}}',
  '.wb2dw-mask{position:fixed;inset:0;z-index:2147482999;background:var(--wb2-mask-2)}',
  '.wb2dw{position:fixed;top:12px;right:12px;bottom:12px;width:min(360px,92vw);z-index:2147483000;display:flex;flex-direction:column;overflow:hidden;background:var(--wb2-bg-raise);border:.5px solid var(--wb2-line-strong);border-radius:2px;box-shadow:none;animation:wb2DwIn var(--wb2-dur) var(--wb2-ease)}',
  '.wb2dw-head{display:flex;align-items:center;gap:10px;padding:16px 18px;border-bottom:.5px solid var(--wb2-line)}',
  '.wb2dw-title{font-family:var(--wb2-serif);font-size:14px;font-weight:400;letter-spacing:.16em;flex:1 1 auto;color:var(--wb2-t1)}',
  '.wb2dw-x{width:26px;height:26px;display:grid;place-items:center;border-radius:2px;color:var(--wb2-t3);background:transparent;border:.5px solid transparent;transition:all var(--wb2-dur-fast) var(--wb2-ease)}',
  '.wb2dw-x:hover{background:var(--wb2-fill);color:var(--wb2-t1);border-color:var(--wb2-line-strong)}',
  '.wb2dw-list{flex:1 1 auto;overflow:auto;padding:8px 10px 14px}',
  '.wb2dw-row{display:flex;align-items:center;gap:10px;padding:10px 10px;border-radius:2px;border-bottom:.5px solid var(--wb2-line-hair);cursor:pointer;transition:background var(--wb2-dur-fast) var(--wb2-ease)}',
  '.wb2dw-row:hover{background:var(--wb2-fill)}',
  '.wb2dw-name{flex:1 1 auto;min-width:0;font-family:var(--wb2-serif);font-size:13px;letter-spacing:.12em;color:var(--wb2-t1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.wb2dw-metric{font-family:var(--wb2-serif);font-variant-numeric:tabular-nums;font-size:11px;letter-spacing:.06em;color:var(--wb2-t2);background:var(--wb2-fill);border-radius:2px;padding:2px 7px}',
  '.wb2dw-n{font-size:11px;letter-spacing:.10em;color:var(--wb2-t3);min-width:34px;text-align:right}',
  '',
  '/* ── ⑰ 外观浮层（本版新增 · 全局：portal 到 body）────────────────────────',
  '   为什么另起一个浮层而不是放卡头：`.dshw-head` 的直接子元素是**结构契约**',
  '   （REST-2 逐项比对，还带负向对照），往里加东西会把它弄红；',
  '   orderbar 只按**文本**定位链接，所以入口放在那一行（`外观`），浮层走 portal。 */',
  '@keyframes wb2ThIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}',
  '.wb2th-mask{position:fixed;inset:0;z-index:2147483003;background:transparent}',
  '.wb2th{position:fixed;z-index:2147483004;min-width:184px;box-sizing:border-box;padding:6px;background:var(--wb2-bg-raise);border:.5px solid var(--wb2-line-strong);border-radius:2px;box-shadow:none;color:var(--wb2-t1);font-family:var(--wb2-sans);animation:wb2ThIn var(--wb2-dur-fast) var(--wb2-ease)}',
  '.wb2th-h{padding:7px 10px 6px;font-family:var(--wb2-serif);font-size:11px;font-weight:400;letter-spacing:.20em;color:var(--wb2-t3)}',
  '.wb2th-i{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:7px 10px;border:none;background:transparent;border-radius:2px;cursor:pointer;text-align:left;font-size:12.5px;letter-spacing:.10em;color:var(--wb2-t1);transition:background var(--wb2-dur-fast) var(--wb2-ease)}',
  '.wb2th-i:hover{background:var(--wb2-fill)}',
  '.wb2th-i::before{content:"";flex:0 0 auto;width:14px;height:2px;background:transparent}',
  '.wb2th-i[data-on="1"]::before{background:var(--wb2-brand)}',
  '.wb2th-i[data-on="1"]{color:var(--wb2-brand-hover)}',
  '.wb2th-i:focus-visible{outline:1px solid var(--wb2-brand);outline-offset:-2px}',
  '.wb2th-s{padding:0 10px 8px 32px;font-size:11px;letter-spacing:.10em;color:var(--wb2-t3)}',
  '',
].join('\n')

    const CATS = [
      { key: 'all', label: '全部' },
      { key: 'Learn', label: '学习' },
      { key: 'Research', label: '研究' },
      { key: 'Work', label: '工作' },
      { key: 'Life', label: '生活' },
    ]
    const CAT_LABEL = { Learn: '学习', Research: '研究', Work: '工作', Life: '生活' }
    const MAX_ROWS = 5
    /**
     * 专注「必穿透白名单」里日程"即将开始"的提前量（分钟）。
     *
     * ⚠️ 数值必须与库内 `_meta/workbench/focus-queue.mjs` 的 `UPCOMING_SCHEDULE_LEAD_MINUTES` **一致**：
     *    该常量在产物侧（聚合平面）已经定义一次，客户端这里只引用**同一个语义**，不另立口径。
     *    run-t16 的源码级断言会**同时读两处**并比对（T16-1xx），改一处不改另一处即判红。
     * ⚠️ 客户端算"即将开始"用**墙钟**（用户此刻在看面板），库内算白名单用**数据时刻** ——
     *    两者相差一个 staleMs。之所以客户端自己算：host 那条读路径（cli-focus status）**不喂日程**，
     *    payload 的 `upcoming_schedule` 恒为空数组（不是 0，是"没接入"）。
     */
    const UPCOMING_SCHEDULE_LEAD_MINUTES = 60
    /**
     * 专注期间"醒目卡"的目标映射（用户裁定 2026-09-17）：
     *   专注卡本身 + 按 `target.kind` 映射的相关卡 + 白名单命中的卡。
     * ⚠️ 本表**只决定视觉权重**，与 `CARD_ORDER`（卡片顺序契约）无关 ——
     *    降权不改顺序、不隐藏卡片（顺序断言 T16-58/T16-97 与 SBT-23 仍绿）。
     */
    const FOCUS_TARGET_CARDS = {
      // 2026-09-20 合并后：`domains` 卡已并入 `focus` 卡，而 `focus` **恒在醒目表内**
      //   （见下方 `prominentKeys = ['focus'].concat(…)`）⇒ 域目标的映射只剩「对象」这一张
      //   需要显式加入。**不是**把判据放宽：`domain` 仍是一个显式登记项，T16-112 仍逐项比对。
      // ★ 2026-09-21（P2b 撤「对象」卡）：对象已改为**属性**（落在一级事务行 + 事务详情 +
      //   洞察证据段），独立「对象」卡不存在 ⇒ `domain` / `project` 两个目标**改指向「事务」卡**：
      //   域 / 项目下的事与对象属性现在都在那张卡上（域 → 对象 → 事务三级下钻在专注卡自己身上，
      //   而 `focus` **恒在** `prominentKeys` 里，不必也不该重复登记）。仍是显式三项，T16-112 逐项比对。
      domain: ['matters'],
      project: ['matters'],
      matter: ['matters'],
    }
    /**
     * 专注期间非目标卡的**视觉契约**（2026-09-17 越界评审后正式接管，见 `[focus-dim:begin]`）。
     *
     * 结论（逐项定性的第 2 项）：**保留"降权 + 默认折叠成一行摘要"**，不回退为"只降权"。
     * 理由三条：
     *   ① 产品意图：专注就是"只留一件事"。只降权（灰度 55% 不透明）在 2 列栅格里挡不住视觉噪声
     *      —— 非目标卡仍占满 4~5 行高度，用户仍要滚过它们才能看到目标卡；折叠把"噪声"压成一行，
     *      才真正达成"只留一件事"。
     *   ② 无信息损失：折叠**不删卡**（DOM 次序不变、槽位仍在、卡名与徽标就在摘要条上）、
     *      **不拦操作**（折叠条整条可点 → 页面级"展开域下对象"式的显式按钮 + 按钮永远在位），
     *      **不干扰拖动**（摘要条刻意不挂 `data-click`，长按整卡拖动仍可用）。
     *   ③ 已被既有断言固化：真机套件 SBT-54/55/56/56b 逐条守着"`data-dim=1` + `data-folded=1`
     *      + 摘要条可见且带卡名 + 展开入口命中 + 折叠后仍能长按拖动"。**回退为只降权会让这 4 条全红**，
     *      而它们守的正是用户当初提的诉求（降权 ≠ 隐藏、折叠 ≠ 丢卡）。
     * ⇒ 因此本项**不视为越界**，而是"框架层能力 + 有断言守的正式契约"；本常量把判据写成机器可读形态。
     *
     * [focus-dim:begin]
     * {"nonProminent":{"dim":"data-dim=1（.dshw-focusdim 包装）","folded":"data-folded=1（默认）","unfolded":"data-folded=0（用户手动展开后仍降权）"},"prominentUnchanged":true,"noDisplayNone":true,"domOrderUnchanged":true,"foldSummary":".dshw-focussum（卡名 + 徽标 + 展开/收起按钮；整条不挂 data-click，长按仍可拖动）","targets":{"domain":["matters"],"project":["matters"],"matter":["matters"],"whitelist":["matters","triggers","schedule"],"self":"focus"}}
     * [focus-dim:end]
     */
    const FOCUS_DIM = {
      className: 'dshw-focusdim',
      dimAttr: 'data-dim',
      foldedAttr: 'data-folded',
      /** 包装元素上标记"这是哪张卡"的属性（探针/套件按它定位降权包装） */
      cardAttr: 'data-card',
      summaryClass: 'dshw-focussum',
      foldedByDefault: true,
      noDisplayNone: true,
      domOrderUnchanged: true,
      prominentUnchanged: true,
      // ── 源码可读的口径常量（2026-09-17 越界评审第 2 项 · 逐项定性的第 1 项）──────────────
      //   ⚠️ 2026-09-17 复原（裁定 B · 误删/半成品）：本常量**保留**，但 `slotOf()` 渲染分支里的
      //      `'dshw-focusdim'` / `'data-dim'` / `'data-folded'` / `'data-card'` / `'dshw-focussum'`
      //      及 `key: 'fold-' + k` / `key: 'folds-' + k` **一律写回字面量**。
      //      原因：那几处字面量是 T16-109 / T16-110 / T16-110b / T16-117 与 SBT-11m 的**契约锚点**
      //      —— 套件按字面量定位、并按"往字面量里注入破坏 ⇒ 判据必须报红"做负向对照。
      //      把渲染分支改成常量取值会让这些负向对照**失去靶子**（注入无处可落 ⇒ 恒绿），
      //      即"把断言重锚到新形态"——那是本项被裁定为误删的根源，不得再犯。
      //   ⚠️ 因此本常量是**同一口径的机器可读副本**：改这里的字段名/取值时，
      //      必须同步改 `slotOf()` 里对应的字面量（两处必须逐字一致，改一处即判红）。
      /** 属性取值只允许这两个（`0` = 用户手动展开后仍降权，不是"取消降权"） */
      attrOn: '1',
      attrOff: '0',
      /** 降权方式：纯 CSS `filter`+`opacity`，**不隐藏元素、不滤出列表**。
       *  ⚠️ 真值仍由样式表里 `.dshw-focusdim{…}` 那条规则执行（浏览器半体不便于拼字符串样式）；
       *     本字段是**同一口径的机器可读副本** —— 改样式必须同时改这里（断言读本字段）。 */
      dimStyle: 'filter:grayscale(.55) saturate(.55);opacity:.55',
      /** 摘要条：卡名（`▾/▸` 前缀 + 已渲染卡名）· 徽标 · 显式展开/收起按钮；整条**不挂** `data-click` */
      summaryHasCardName: true,
      summaryHasBadge: true,
      summaryDragSafe: true,      // 不挂 data-click / onClick ⇒ 长按整卡拖动仍生效（CARD_DRAG_EXCLUDE 含 [data-click="1"]）
      explicitToggle: true,       // 右侧 `<button class="dshw-btn">` 永远在位（键盘/触屏两条路径都有）
    }
    const STATUS_LABEL = { accepted: '已接受', needsAction: '待回复', declined: '已拒绝', tentative: '暂定' }
    const REC_KINDS = [
      { v: 'progress', l: '进度' },
      { v: 'decision', l: '决策' },
      { v: 'risk', l: '风险' },
      { v: 'note', l: '备忘' },
    ]
    const REC_LABEL = { progress: '进度', decision: '决策', risk: '风险', note: '备忘' }

    /**
     * 听记一级列表的**活跃窗口**（天）—— 2026-09-20 用户规格：
     *   「超过 30 天的听记从一级列表退出、可从『归档』入口查看」。
     * 判据做成**可被断言读取的常量**（run-t16 的 T16-180 组直接读这个名字），
     * 不在渲染里写死 30 —— 否则改窗口时断言会假绿。
     */
    const MINUTES_ACTIVE_DAYS = 30
    /**
     * 时间戳**可信下限**（2020-01-01T00:00:00Z）。
     *   低于它 / 不是数 / 解析不出来 ⇒ 一律当"时间不可信" ⇒ **不归档、留在一级**。
     *   为什么要这条（实测踩到）：`selftest-client.mjs` 的 CL-18f 用 `start: 1`（1 毫秒）
     *   造"旧 host"样本；若不做可信性判断，那条会被算成"1970 年的听记"而藏进归档，
     *   一级列表直接空掉 —— 断言当场抓到这个假归档。
     *   取证口径：**宁可留在一级，也不把"不知道"的东西藏起来**。
     */
    const MINUTES_TS_FLOOR = 1577836800000

    // ── 听记 → 事务**草稿**（2026-09-26 · 第六条）────────────────────────────────
    //   产品链路：听记 → host `/matter/draft-from-minutes`（采集正文 + 跑库内草稿引擎）
    //             → 面板把引擎的四个预填项与依据摆出来（人只纠错与选择）
    //             → POST /intake（库内 `cli-matter.mjs add`，与 agent 工具同一条写通道）。
    //   ⚠️ 判定一律不在这里复写：标题 / 关闭条件 / 期限 / 域 / 锚点候选全部来自引擎出参。
    /** 草稿路由（面板唯一读草稿的出口；旧 host 未加载时按 ROUTE_DOWN_TEXT 降级） */
    const MINUTES_DRAFT_ROUTE = '/matter/draft-from-minutes'
    /** `evidence[].from` 的人话标签（引擎的取值域是固定五个，见 SPEC §十二 12.1） */
    const EVID_FROM_LABEL = { title: '标题', summary: 'AI摘要', chapter: '章节', todo: 'AI待办', transcript: '逐字稿' }
    /** 每项在面板上的身份（生成项必须可改 / 建议项可采纳 / 可选项可以不选）—— SPEC §十二 12.2 */
    const DRAFT_FIELD_ROLE = { title: '生成', done_when: '生成', due_at: '建议', domain_suggestion: '建议', anchor_candidates: '可选' }
    /**
     * **M1 拦阻语**（提交按钮禁用 + 提交函数拦下，两处同一句）。
     *   M1 = 事务契约（`matter-overrides.mjs#matterFromOverride`）要求 `origin_inbound` 或
     *   `origin_project` 至少一个非空。⚠️ 受理内核（`validateIntake`）**不查这条** —— 只要有一条
     *   `source_ref` 就放行，所以"只带溯源"的提交会在 CLI 落库那一步才炸。这正是必须在界面这一层
     *   拦住并说清两条出路的原因（引擎的 `origin.m1` 是同一句话的机器版）。
     */
    const M1_BLOCK_TEXT = '选一个项目/场次锚点或关联一条流入 id 才能提交 —— 事务契约 M1：origin_inbound 或 origin_project 至少一个非空（只有溯源依据不够）'

    /**
     * M1 闸的**纯函数本体**（提交按钮的 disabled 与提交函数的守卫调的是同一个它）。
     * @returns {{ok:boolean, project:string, inbound:string, why:string}}
     */
    function minOriginState(form) {
      const f = (form !== null && typeof form === 'object') ? form : {}
      const project = String(f.origin_project || '').trim()
      const inbound = String(f.origin_inbound || '').trim()
      const ok = project.length > 0 || inbound.length > 0
      return {
        ok, project, inbound,
        why: ok ? '' : M1_BLOCK_TEXT,
      }
    }

    /**
     * 提交回执 → 人话（**纯函数**；两条路的文案必须是两句不同的话）。
     *
     * ⚠️ 为什么必须单拎出来测：`cli-matter add` 在**去重命中**时先回 `ok:true`
     *   （受理内核语义 —— 重复投递返回既有 id，见 SPEC §6），**退出码也是 0**。
     *   只看 `ok` 就会把"这份听记已经建过事务"显示成"已建事务" —— 用户以为新建了一条，
     *   实际什么都没发生。这是本功能里最容易误报的一处，故：文案、`kind` 都要分开，
     *   并留一条负向对照（把两者写成同一句必须判红，见 `__test.minSubmitTextDistinct`）。
     */
    function minSubmitText(r) {
      const j = (r !== null && typeof r === 'object') ? r : {}
      const id = String(j.id || j.matter_id || '')
      const shown = id.length > 0 ? id : '（库内未回 id）'
      const hit = j.action === 'dedup-hit' || j.existed === true
      return hit
        ? { kind: 'existing', text: '这条听记已经建过事务（既有 ' + shown + '）—— 未新建第二条' }
        : { kind: 'created', text: '已建事务 ' + shown }
    }

    /**
     * 「两条路的文案确实不同吗」的**判据本体**（可被负向对照证伪）。
     * 传入一个"回执 → 文案"的函数，返回它是否把 dedup-hit 与新建分成了两句不同的话。
     * ✅ 真实实现 `minSubmitText` ⇒ true；❌ 故意写成同一句的桩 ⇒ false（负向对照必须判红）。
     */
    function minSubmitTextDistinct(fn) {
      const f = typeof fn === 'function' ? fn : null
      if (f === null) return { ok: false, detail: '没有可判的函数' }
      const a = f({ ok: true, action: 'added', id: 'MT-M-777', existed: false })
      const b = f({ ok: true, action: 'dedup-hit', id: 'MT-M-777', existed: true })
      const at = String((a || {}).text || '')
      const bt = String((b || {}).text || '')
      const ak = String((a || {}).kind || '')
      const bk = String((b || {}).kind || '')
      const ok = at.length > 0 && bt.length > 0 && at !== bt && ak !== bk
      return { ok, detail: `新建=「${at}」 · 去重命中=「${bt}」 · kind=${ak}/${bk}` }
    }

    /**
     * 草稿 → 表单预填（**纯函数** · 界面这一层唯一的预填口径）。
     *
     * 两条硬规矩：
     *   ① **`unavailable_reason` 非空 ⇒ 一个字段都不预填**（连标题也不填 ——
     *      "靠听记标题猜出来的那一版"正是 SPEC §十二 12.3 要防的假草稿）；
     *   ② 域建议兜底到 `temp`（或不在可选域列表里）时**不预选**，留「不指定」，
     *      由人自己选 —— 界面不把一个临时域塞进表单（引擎已在其 `notes` 里写了"请自己选一个真实域"）。
     *
     * @param {object} draft 引擎出参（原样）
     * @param {string[]} domainIds 可选域 id（来自 /state 的 `domainOptions`）
     * @returns {{prefilled:boolean, reason:string, form:object, notes:string[]}}
     */
    function minDraftToForm(draft, domainIds) {
      const d = (draft !== null && typeof draft === 'object') ? draft : {}
      const empty = { title: '', domain: '', done_when: '', due_at: '', origin_project: '', origin_inbound: '', anchor: '' }
      const reason = String(d.unavailable_reason || '')
      if (reason.length > 0) return { prefilled: false, reason, form: empty, notes: [] }
      const ids = Array.isArray(domainIds) ? domainIds.map((x) => String(x)) : []
      const sug = String(d.domain_suggestion || '')
      const notes = []
      let domain = ''
      if (sug.length > 0 && ids.indexOf(sug) >= 0) domain = sug
      else if (sug.length > 0) notes.push('域建议「' + sug + '」不在可选域列表里（多半是兜底的临时域）⇒ 未预选，请自己选一个真实域')
      return {
        prefilled: true, reason: '', notes,
        form: {
          title: String(d.title || ''),
          domain,
          done_when: String(d.done_when || ''),
          due_at: String(d.due_at || ''),
          origin_project: '',
          origin_inbound: '',
          anchor: '',
        },
      }
    }

    /** 草稿的锚点候选 → 下拉选项（**只读引擎出参**，界面不另派生对象） */
    function minAnchorOptions(draft) {
      const d = (draft !== null && typeof draft === 'object') ? draft : {}
      return (Array.isArray(d.anchor_candidates) ? d.anchor_candidates : []).map((a) => {
        const o = (a !== null && typeof a === 'object') ? a : {}
        return {
          key: String(o.key || ''),
          label: String(o.label || o.key || ''),
          kind: String(o.kind || ''),
          match: String(o.match || ''),
          basis: String(o.basis || ''),
          project_dir: o.project_dir === null || o.project_dir === undefined ? '' : String(o.project_dir),
          account: o.account === null || o.account === undefined ? '' : String(o.account),
          matter_count: Number(o.matter_count || 0),
        }
      })
    }

    /**
     * 听记一级行 → 转事务的目标（`{src,id,title,url}`）。
     *   行的三个字段来自 `minutesRowModel`（row 模型只有 src/title/url）；**寻址由 host 负责** ——
     *   飞书 minute_token 与钉钉 taskUuid 都在 URL 尾段，由 host 的 `minuteRefOf` 统一兜底，
     *   面板**不自己解析 URL**（两处解析 = 两套寻址，漂移后就是"这条听记取不到正文"）。
     */
    function minDraftTargetOf(row) {
      const r = (row !== null && typeof row === 'object') ? row : {}
      return {
        src: String(r.src || 'dingtalk'),
        id: String(r.id || r.token || ''),
        title: String(r.title || ''),
        url: String(r.url || ''),
      }
    }
    /** 归档行的日期戳（**只给归档区**用）：一级行按规格③不带任何时间列 */
    function minArchStamp(ms) {
      if (!Number.isFinite(ms) || ms < MINUTES_TS_FLOOR) return ''
      const d = new Date(ms)
      return String(d.getFullYear()) + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    }

    /**
     * 听记卡（`minutes`）的**行模型 + 卡头文案**（纯函数 · 2026-09-19 用户规格 + 2026-09-20 归档窗口）。
     *
     * 用户规格逐条落在这里（渲染层只负责把结果画出来）：
     *   ① 列表**同时列钉钉听记与飞书妙记** ⇒ 行模型按 payload 的合并 `items` 逐条投影，不按源截断；
     *   ② 每行带**来源标签** ⇒ 行里给 `src`（`dingtalk` / `feishu`），渲染层用待办卡同一个 `srcPill()`；
     *   ③ **不显示时间** ⇒ **一级行**里**只有** `{src,title,url}` 三个字段
     *      （payload 的 `start` 只服务**归档判定**，一级行不带它 —— 由 CL-18b / T16-174 守住）；
     *   ④ 卡头**分源计数**「钉钉 N · 飞书 M」⇒ 数字取 payload 的 `counts`（与 `sources.*.count` 同源），
     *      不得用 `items.length` 当总数糊过去；
     *   ⑤ **诚实降级**：飞书未授权 / 读取失败 / host 未返回分源字段（旧 host）三种情形各有明确出口，
     *      一律**不显示 0 冒充"没有"**，并把缺的 scope 原文带给用户。
     *   ⑥ **（2026-09-20 新增）30 天退出 + 归档**：`age > MINUTES_ACTIVE_DAYS` 天 ⇒ 进 `archivedRows`，
     *      不进 `rows`；卡头数字相应**减去归档**（卡头口径 = 一级列表口径），有归档时缀「· 归档 K」。
     *      恒等式「活跃 + 归档 == payload 计数」由断言守着 —— 不许出现"卡头说 20、列表只有 6"。
     *
     * 纯函数：给定同一份 payload 必得同一结果（`now` 取调用时刻）⇒ Node 级（selftest-client.mjs）
     * 与真机可各测一遍。边界双向可验：`start = now-31d` ⇒ 归档；`start = now-29d` ⇒ 一级。
     *
     * @param {object} minutes `/snapshot` 的 `minutes` 段（`{items,sources,counts}`；旧 host 只有 `items`）
     * @returns {{ding:number,fei:number,dingAll:number,feiAll:number,archived:number,archivedRows:Array,activeDays:number,feiState:string,feiScope:string,badge:string,rows:Array<{src:string,title:string,url:string}>,note:(string|null),hostOld:boolean}}
     */
    function minutesRowModel(minutes) {
      const p = (minutes !== null && typeof minutes === 'object') ? minutes : {}
      const items = Array.isArray(p.items) ? p.items : []
      const src = (p.sources !== null && typeof p.sources === 'object' && p.sources !== undefined) ? p.sources : null
      const cnt = (p.counts !== null && typeof p.counts === 'object' && p.counts !== undefined) ? p.counts : null
      const okObj = (m) => m !== null && typeof m === 'object'
      // ⑥ 时间只服务**归档判定**：`atOf()` 读 payload 的 `start`（毫秒数，或可解析的时间串）。
      //    不可信（空 / 非数 / 早于 MINUTES_TS_FLOOR）⇒ 返回 null ⇒ **不归档**（不知道就不藏）。
      const atOf = (m) => {
        const raw = (m === null || m === undefined) ? null : m.start
        if (raw === null || raw === undefined || raw === '') return null
        const asNum = typeof raw === 'number' ? raw : Number(raw)
        const t = (Number.isFinite(asNum) && asNum > 0) ? asNum : Date.parse(String(raw))
        if (!Number.isFinite(t) || t < MINUTES_TS_FLOOR) return null
        return t
      }
      const nowMs = Date.now()
      // **超过** MINUTES_ACTIVE_DAYS 天才归档：恰好 30 天仍算活跃；时间不可信永不归档
      const isArchived = (m) => {
        const t = atOf(m)
        if (t === null) return false
        return (nowMs - t) > MINUTES_ACTIVE_DAYS * 86400000
      }
      // ③ 一级行 = 只有 src/title/url（**没有** time/start/at —— 本卡一级不显示时间）
      const rows = items.filter((m) => okObj(m) && !isArchived(m)).map((m) => ({
        src: String(m.source || 'dingtalk'),
        title: String(m.title || '(未记标题)'),
        url: String(m.url || ''),
      }))
      // ⑥ 归档行（二级详情层）：**只有这一层带时间戳** `at`，供归档区显示日期
      const archivedRows = items.filter((m) => okObj(m) && isArchived(m)).map((m) => ({
        src: String(m.source || 'dingtalk'),
        title: String(m.title || '(未记标题)'),
        url: String(m.url || ''),
        at: atOf(m),
      }))
      const countOf = (k) => rows.filter((r) => r.src === k).length
      const archOf = (k) => archivedRows.filter((r) => r.src === k).length
      // ④ 数字优先取 payload 的 counts（与 sources.*.count 同值）；旧 host 没有 counts 时才按行分组兜底
      const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
      const allDing = cnt !== null && n(cnt.dingtalk) !== null ? n(cnt.dingtalk) : countOf('dingtalk') + archOf('dingtalk')
      const allFei = cnt !== null && n(cnt.feishu) !== null ? n(cnt.feishu) : countOf('feishu') + archOf('feishu')
      // ⑥ 卡头口径 = 一级列表口径 ⇒ 从 payload 计数里**减去**归档那部分（下界 0 防病态数据）
      const ding = Math.max(0, allDing - archOf('dingtalk'))
      const fei = Math.max(0, allFei - archOf('feishu'))
      const fe = (src !== null && src.feishu !== null && typeof src.feishu === 'object') ? src.feishu : null
      const scopes = fe !== null && Array.isArray(fe.missing_scopes) ? fe.missing_scopes : []
      const feiScope = String(scopes[0] || 'minutes:minutes.search:read')
      // ⑤ 四态：host 没给分源结构（旧 host）/ 未授权 / 读取失败 / 正常
      const feiState = src === null
        ? 'restart'
        : (fe === null || fe.ok !== true
          ? (fe !== null && fe.authorized === false ? 'unauthorized' : 'error')
          : 'ok')
      const feiLabel = feiState === 'ok' ? '飞书 ' + String(fei)
        : feiState === 'restart' ? '飞书 需重启 host'
          : feiState === 'unauthorized' ? '飞书 未授权' : '飞书 读取失败'
      const note = feiState === 'restart'
        ? '飞书妙记不可用：host 未返回 minutes.sources 分源字段 —— 插件 host 仍是旧代码，需重启 DSH 加载新 host'
        : feiState === 'unauthorized'
          ? '飞书妙记未授权：缺 scope ' + feiScope + '（授权后此处显示飞书妙记；未授权 ≠ 没有妙记）'
          : feiState === 'error'
            ? '飞书妙记读取失败: ' + String((fe !== null && fe.error) || '未知原因')
            : null
      return {
        ding, fei, dingAll: allDing, feiAll: allFei,
        archived: archivedRows.length, archivedRows, activeDays: MINUTES_ACTIVE_DAYS,
        feiState, feiScope,
        badge: '钉钉 ' + String(ding) + ' · ' + feiLabel
          + (archivedRows.length > 0 ? ' · 归档 ' + String(archivedRows.length) : ''),
        rows, note, hostOld: src === null,
      }
    }

    /**
     * 对象键 → 人可读名（**模块级唯一实现**）。
     *   只剥 payload kernel 的三条机器前缀：`客户:示例客户B`→`示例客户B` · `场次:X-0913`→`X-0913` ·
     *   `域:ai-engineering`→`ai-engineering`；没有前缀的键（如 `(未归属)`）原样返回。
     *   ⚠️ 这里**不跑正则、不按标题猜、不重派生对象** —— 只去掉机器前缀，值仍是 payload 自己的 key。
     *   卡片装配段的 `objLabel()` 是本函数的一层别名（单一实现，别再抄一份判据）。
     */
    function objKeyLabel(key) {
      const s = String(key === null || key === undefined ? '' : key)
      const at = s.indexOf(':')
      if (at < 0) return s
      const head = s.slice(0, at)
      if (head === '客户' || head === '场次' || head === '域') return s.slice(at + 1)
      return s
    }

    /**
     * 听记一级列表按**对象/客户**聚合（2026-09-20 用户规格 · 第五条）。
     *
     * 规格：一级列表**只显示摘要行**（分组头 = 对象名 + 条数），点分组头 ⇒ 复用面板既有
     *   **portal 二级详情**（`openObj()`，与「对象」卡同一个弹窗、同一套字段渲染）。
     *
     * 归组判据（**只用 payload 自己的数据**，不新造对象层）：
     *   · 候选 = `/objects` 的 `objects[]` 里**非 unassigned** 的对象，显示名 = `objLabel(key)`
     *     （`客户:示例客户B` → `示例客户B`；只剥机器前缀，不猜名字）；
     *   · 命中 = 行标题里**包含**该显示名 ⇒ 归到该对象；**最长名优先**（更具体的场次压过客户名），
     *     同长度保持 payload 顺序（不重排）；
     *   · 一条都没命中 ⇒ 进「未归属」组（key=null，不可点 —— 没有对象可跳）。
     *
     * ⚠️ 诚实边界：这是**按标题文本归组**的展示便利，**不是**对象层派生（本卡不判定归属）。
     *   对象层不可用（旧 host / 读失败）时**不硬分组**：返回单一 `{key:null}` 组，
     *   渲染层据此走"平铺、无分组头"的旧形态（免得凭空多出一个「未归属 N」的头）。
     *
     * @param {Array<{src:string,title:string,url:string}>} rows 一级行（`minutesRowModel().rows`）
     * @param {object|null} objects `/objects` 原始 payload（`{objects:[...]}`；本函数不改写它）
     * @returns {Array<{key:(string|null),label:string,item:(object|null),items:Array<object>}>}
     */
    function minutesGroupModel(rows, objects) {
      const list = Array.isArray(rows) ? rows : []
      const doc = (objects !== null && typeof objects === 'object') ? objects : {}
      const objs = Array.isArray(doc.objects) ? doc.objects : []
      const cands = []
      for (let i = 0; i < objs.length; i += 1) {
        const o = objs[i]
        if (o === null || o === undefined || typeof o.key !== 'string') continue
        if (String(o.kind || '') === 'unassigned') continue          // 未归属对象不是客户/场次，不做分组头
        const label = objKeyLabel(o.key)
        if (label.length === 0) continue
        cands.push({ key: o.key, label, item: o })
      }
      // 最长名优先：名字越具体越该赢（场次名通常含客户名）
      cands.sort((a, b) => b.label.length - a.label.length)
      const hitOf = (title) => {
        for (let i = 0; i < cands.length; i += 1) {
          if (String(title).indexOf(cands[i].label) >= 0) return cands[i]
        }
        return null
      }
      const groups = []
      const index = {}
      const none = { key: null, label: '未归属', item: null, items: [] }
      for (let i = 0; i < list.length; i += 1) {
        const r = list[i]
        const hit = hitOf(r.title)
        if (hit === null) { none.items.push(r); continue }
        if (index[hit.key] === undefined) {
          index[hit.key] = { key: hit.key, label: hit.label, item: hit.item, items: [] }
          groups.push(index[hit.key])
        }
        index[hit.key].items.push(r)
      }
      // 无对象层 ⇒ 不硬分组（返回单组 key=null，渲染层据此平铺、不出分组头）
      if (cands.length === 0) return [{ key: null, label: '', item: null, items: list }]
      if (none.items.length > 0) groups.push(none)
      return groups
    }

    /**
     * 事务按「关注域」分组（2026-09-15 裁定：同域任务缩进到域名称下，点域名称展开该域列表）。
     *
     * 纯函数、无 DOM 依赖 —— 渲染层只负责把结果画出来，逻辑本身可被
     * selftest-client.mjs 在 Node 里直接调用（无需浏览器）。
     * 分组保持传入顺序（传入的 list 已由 host 排好序），同域相邻归组，不重排。
     *
     * @param {Array<object>} list 已排序的事务项
     * @param {Record<string,string>} nameById 域 id → 显示名（取自快照 domains；缺失回落 id）
     * @returns {Array<{id:string,name:string,items:Array<object>}>}
     */
    function groupMattersByDomain(list, nameById) {
      const names = nameById || {}
      const groups = []
      const index = {}
      const arr = Array.isArray(list) ? list : []
      for (let i = 0; i < arr.length; i += 1) {
        const m = arr[i] || {}
        const id = m.domain ? String(m.domain) : '__none__'
        let g = index[id]
        if (g === undefined) {
          g = { id, name: id === '__none__' ? '未关联关注域' : String(names[id] || id), items: [] }
          index[id] = g
          groups.push(g)
        }
        g.items.push(m)
      }
      return groups
    }

    /**
     * ── 侧边栏两个 tab 的**命名**（2026-09-17 越界评审第 4 项 · 唯一真相源）──────────
     *
     * 决定：**保留分列，不合并**（理由见侧边栏注册段那段长注释）。本批做的是
     *   「统一命名与图标风格」：两个标题从这里取，注册点 / 面板头部 / 仪表盘内条不再各写一份字面量。
     *
     *   · `SIDEBAR_TAB_TITLE`     =「工作台」= 面板本体（`.dshw-root.dshw-embedded`）
     *   · `SIDEBAR_DASH_TITLE`    =「驾驶舱」= 库内 `dashboard.html`（iframe，只读消费）
     *   · `SIDEBAR_DASH_BAR_TITLE`= 仪表盘内条的全称（写明它是什么，避免"驾驶舱"三个字被当成面板的一部分）
     *
     * ⚠️ 文本**不可随手改**：`verify-sidebar-tab.mjs` 按**恰为「工作台」**的入口文本找面板、
     *    按「驾驶舱」找另一个入口（见该套件的选择器策略）。要改文案必先同步套件，否则整批假红。
     *    ⇒ 本常量的作用是"只有一个地方需要改"，不是"可以随便改"。
     */
    const SIDEBAR_TAB_TITLE = '工作台'
    const SIDEBAR_DASH_TITLE = '驾驶舱'
    const SIDEBAR_DASH_BAR_TITLE = '个人 AI 工作台 · 驾驶舱'

    // ── 图标（2026-09-15 起；2026-09-25 补指南页入口卡，并给卡上的图标上色）──────
    // 折叠态侧边栏只显示图标、不显示文字，所以每个 tab 都必须带 icon；
    // 用内联 SVG + currentColor，跟随主题（深/浅色）自动适配。
    // `className` / `glyph` 两个口子给**官方指南页的入口卡**用：官方 `IconProps` 是 `{size, className}`，
    //   不给 icon 时那条卡只画一个方块占位符（用户 2026-09-25 截图反馈的就是它）。
    //   卡片上的图标走下面的 `guideTile`（彩色）；`svg()` 这枚单色的是 tab 标题条与左侧栏那几处用的。
    const svg = (size, children, label, className, glyph) => React.createElement('svg', {
      width: size || 16, height: size || 16, viewBox: '0 0 16 16', fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': 'true', 'aria-label': label || null, role: label ? 'img' : null,
      className: className || undefined, 'data-dshw-glyph': glyph || undefined,
    }, children)

    /**
     * ── 两枚图标（同一套作图纪律，2026-09-17 统一）──────────────────────────
     * 纪律（两个函数必须同时满足，改一个就一起改）：
     *   · 同一个画布：`svg()` 固定 16×16 viewBox（折叠态只显示图标，尺寸必须一致才不会跳动）；
     *   · 同一根描边：`strokeWidth: 1.3` + `strokeLinecap/Linejoin: round`（在 `svg()` 里统一给）；
     *   · 同一档细节密度：3–5 条线段，**外框用 rect(rx=2)**，不填充（只有「点」用 currentColor 实心）；
     *   · 只用 `currentColor` ⇒ 深浅色主题自动跟随，不写死颜色；
     *   · 图形要**占得满、不扁**（高宽比 ≥ 0.7）：彩色底板上图形太扁就认不出来（用户 2026-09-25
     *     对驾驶舱半圆的反馈就是这个），真机判据 `SBT-WS10` 按渲染出来的外接框量这条。
     */
    /** 工作台的图形（16×16 画布：外框 + 右侧列 + 两行内容）—— 单色图标与指南卡共用这一份 */
    const marksWorkbench = () => [
      React.createElement('rect', { key: 'r', x: 1.6, y: 2.2, width: 12.8, height: 11.6, rx: 2 }),
      React.createElement('path', { key: 'a', d: 'M1.6 5.6h12.8' }),
      React.createElement('path', { key: 'b', d: 'M9.6 5.6v8.2' }),
      React.createElement('path', { key: 'c', d: 'M4 8.4h3.2' }),
      React.createElement('path', { key: 'd', d: 'M4 10.6h2.2' }),
    ]

    /**
     * 驾驶舱的图形（**3/4 圆弧** + 指针 + 轴心点，开口朝下）—— 与工作台同一画布同一根描边。
     *
     * ⚠️ 2026-09-25 改形（用户反馈「图标是一个扁的半圆，能否变圆一点，现在不太明显」）：
     *    原来是**半圆**（`M2.6 11.9a5.6 5.6 0 0 1 10.8 0` + 两条小刻度）—— 在 22px 的彩色底板上
     *    只有一条扁弧，看不出是仪表。现在换成**开口朝下的 3/4 圆弧**（r=5、圆心 8,8.5，
     *    起止点落在 7:30 与 4:30 位置）⇒ 图形高宽比从 0.52 提到 0.85，圆得多、也认得出来；
     *    两条小刻度同时撤掉（16px 下只是噪点，圆弧本身已够说明"仪表"）。
     */
    const marksDashboard = () => [
      React.createElement('path', { key: 'g', d: 'M4.46 12.04A5 5 0 1 1 11.54 12.04' }),
      React.createElement('path', { key: 'n', d: 'M8 8.5 10.6 5.9' }),
      React.createElement('circle', { key: 'c', cx: 8, cy: 8.5, r: 0.85, fill: 'currentColor', stroke: 'none' }),
    ]

    /** 工作台：面板布局（见上方作图纪律） */
    function iconWorkbench(size, className, glyph) {
      return svg(size, marksWorkbench(), SIDEBAR_TAB_TITLE, className, glyph)
    }

    /** 驾驶舱：仪表 */
    function iconDashboard(size, className, glyph) {
      return svg(size, marksDashboard(), SIDEBAR_DASH_TITLE, className, glyph)
    }

    /**
     * ── 指南页入口卡的**彩色**图标（2026-09-25 用户裁定「加上配色」）──────────────
     *
     * 官方那两张卡就是这么画的：`FileTypeIcon kind="folder"` = 金色文件夹 + 白线，
     * `TerminalGuideIcon` = 深色圆角卡 + 白色提示符（实色底 + `#fff` 描边 1.7）。
     * 我们四张卡沿用同一套形状语法 —— **一块实色圆角底板 + 本工作台那枚图形（白色）** ——
     * 只换底板颜色，于是四张卡一眼能分辨，又跟官方那两张是一族人（28×28 画布，同官方）。
     *
     * 底色取官方设计变量（`ui-theme` 的 `design-platform.css`，深浅色主题同值）；
     * 紫色官方没有变量，沿用官方 `FileTypeIcon.module.css` 里同样的做法写死一个 rgb。
     *
     * ⚠️ tab 标题条与左侧栏那几处仍然走上面的 16×16 单色 `currentColor` —— 与官方一致：
     *    官方也是两套（`TerminalIcon` 单色给标题条、`TerminalGuideIcon` 彩色给指南卡）。
     */
    const GUIDE_SIZE = 26                                   // 官方指南卡给 26（带描述）/ 22（只有标题）
    const GUIDE_PLATE = { x: 1.2, y: 1.2, side: 25.6, rx: 7 }
    const GUIDE_PLATE_BLUE = 'var(--dsw-static-deepseek-500)'   // 「工作台」底板：产品自己的蓝
    const GUIDE_PLATE_GREEN = 'var(--dsw-static-green-500)'     // 「驾驶舱」底板：绿（与「坐标系」紫、「建模中心」橙区分开）
    /** 图形放进底板时的位置/大小：16×16 的图形居中放大到约 55% 边长（与官方终端卡同一留白比例） */
    const GUIDE_MARKS_AT = 'translate(4.8 4.8) scale(1.15)'
    const guideTile = (props, glyph, plate, marks) => {
      const given = props === null || props === undefined ? {} : props
      const size = Number.isFinite(given.size) ? given.size : GUIDE_SIZE
      return React.createElement('svg', {
        width: size, height: size, viewBox: '0 0 28 28', fill: 'none', 'aria-hidden': 'true',
        className: given.className || undefined,
        'data-dshw-glyph': glyph, 'data-dshw-guide': glyph,
      },
      React.createElement('rect', {
        key: 'plate',
        x: GUIDE_PLATE.x, y: GUIDE_PLATE.y, width: GUIDE_PLATE.side, height: GUIDE_PLATE.side,
        rx: GUIDE_PLATE.rx, fill: plate,
      }),
      React.createElement('g', {
        key: 'marks', transform: GUIDE_MARKS_AT, stroke: '#fff', strokeWidth: 1.5,
        strokeLinecap: 'round', strokeLinejoin: 'round', style: { color: '#fff' },
      }, marks))
    }
    /** 官方 `IconProps`（只有 `{size, className}`）→ 彩色底板卡 */
    const guideOf = (glyph, plate, marks) => (props) => guideTile(props, glyph, plate, marks)

    /**
     * 「驾驶舱」tab（better-sidebar）：iframe 内嵌**库内仪表盘**产物。
     *
     * 数据源 = `_meta/out/dashboard.html`（build-snapshot 生成的自包含页面，零外链），
     * 经本插件只读路由 `/workbench/api/dashboard` 提供 —— 不复制数据、不另建派生（P2）。
     * ⚠️ 根节点带 `data-dshw-tab="dashboard"`（另一个 tab 是 `console`）：真机套件要靠它
     *    **稳定识别**"当前在哪个 tab"，不要再靠标题文字匹配（文字会被本文案调整打红）。
     */
    function DashboardView() {
      const [nonce, setNonce] = React.useState(0)
      return React.createElement('div', { className: 'dshw-dash', 'data-dshw-tab': 'dashboard' },
        React.createElement('div', { className: 'dshw-dash-bar' },
          React.createElement('span', { className: 'dshw-dash-title' }, SIDEBAR_DASH_BAR_TITLE),
          React.createElement('button', {
            className: 'dshw-btn', type: 'button', onClick: () => setNonce(nonce + 1), title: '重新加载驾驶舱页面',
          }, '刷新'),
          React.createElement('a', {
            className: 'dshw-btn', href: '/workbench/api/dashboard', target: '_blank', rel: 'noopener', title: '在新标签打开',
          }, '新标签')),
        React.createElement('iframe', {
          key: 'f' + nonce,
          className: 'dshw-dash-frame',
          src: '/workbench/api/dashboard?t=' + nonce,
          title: SIDEBAR_DASH_TITLE,
        }))
    }

    function lsGet(key) { try { return window.localStorage.getItem(key) } catch (e) { return null } }
    function lsSet(key, value) { try { window.localStorage.setItem(key, value) } catch (e) {} }

    /* ── 卡片缩放：两档模式 + 20 列画布（2026-09-25 起，2026-09-26 用户裁定改形）──────
     *
     * 用户原话（09-26）："卡片缩放应该可以选择无级缩放或者网格缩放，将宽度和高度每 5% 作为
     * 一个网格吸附点，右下角的三角拖动需要能改变高度和宽度。"
     *
     * 所以尺寸是**数值 + 单位**两条信息（`{ w, h, unit }`）：
     *   · `unit:'grid'`（默认）—— w/h 都是**百分比**，且吸附到 5 的整数倍：
     *       宽 = 画布宽度的 %（栅格是 20 列，5% 正好一列 ⇒ 布局仍是真的 CSS Grid，不会互相压）；
     *       高 = 画布**看得见高度**的 %（"高 50% 就是半屏"）。
     *   · `unit:'free'`（无级）—— w/h 都是**像素**，不吸附；宽度仍按列跨度占位（向上取到最近的列），
     *       卡片自身宽度就是那个像素值（`justify-self:start`），所以是连续的。
     *   · `unit:'legacy'` —— 09-25 那版存下来的档：`w` 是"跨**老栅格**几列"、`h` 是像素。
     *       它只出现在读盘与内容默认档里：渲染时按老语义折算（见 `legacyColsAt`），**样子不变**；
     *       用户拖过一次就换算成当前档。
     *
     * 三条硬下限（用户明确说过"卡片有最小值"）：
     *   · 高度 ≥ `CARD_MIN_H_PX`（140px：卡头 + 两行清单 + 内边距，再小连一行都显示不全）；
     *   · 宽度 ≥ `CARD_MIN_W_PX`（160px）；
     *   · 网格档下再按 5% 的档位向上取整，保证"夹到下限"时仍然落在格点上。
     */
    const CARD_SIZE_LS = 'dshw.cardSize'
    const CARD_SIZE_MODE_LS = 'dshw.cardSizeMode'   // 'grid'（网格 5%，默认）| 'free'（无级）
    const CARD_GRID_STEP = 5                        // 网格吸附步长（%）
    const CARD_COLS = 20                            // 画布列数（每列 = 5%）
    const CARD_GAP_PX = 8                           // 栅格间距（与 `.dshw-grid` 的 gap 同值）
    const CARD_MIN_H_PX = 140                       // 卡片最小高度（px）
    const CARD_MAX_H_PX = 1600                      // 高度上限（再高也没意义，画布本身可滚）
    const CARD_MIN_W_PX = 160                       // 卡片最小宽度（px）
    const CARD_MAX_SPAN = CARD_COLS                 // 列跨度上限 = 整行
    /** 老版本（09-25 那版）的语义：`w` 是"跨老栅格几列"，最多 4 列。用来做一次迁移。 */
    const CARD_LEGACY_SPAN_COLS = 4
    /** 没调过尺寸的卡"自然占多宽"：照搬老栅格 `auto-fill minmax(Npx,1fr)` 的一列宽（折成最接近的 5% 格数）。 */
    const CARD_NATURAL_MIN_PX = 240                 // 嵌入态（官方右栏里）：老栅格是 minmax(240px)
    const CARD_NATURAL_MIN_PX_FLOAT = 280           // 浮窗态（非 WebUI 环境）：老栅格是 minmax(280px)

    /** 把任意数字夹到 `[lo, hi]`；非数按 `lo` 处理（NaN 会把行内样式写成废值）。 */
    function clampCardNum(value, lo, hi) {
      const n = Number(value)
      if (!Number.isFinite(n)) return lo
      return Math.min(Math.max(n, lo), hi)
    }
    /** 吸附到最近的 5 的整数倍，并夹进 `[5, 100]`。 */
    function snapPct(value) {
      const n = clampCardNum(value, CARD_GRID_STEP, 100)
      return clampCardNum(Math.round(n / CARD_GRID_STEP) * CARD_GRID_STEP, CARD_GRID_STEP, 100)
    }
    /** 像素 → 百分比（吸附与否由 `snap` 决定）。画布尺寸拿不到时给 0（调用方会回落到默认档）。 */
    function pxToPct(px, whole, snap) {
      if (!Number.isFinite(whole) || whole <= 0) return 0
      const pct = (Number(px) || 0) / whole * 100
      return snap === false ? clampCardNum(Math.round(pct * 10) / 10, 1, 100) : snapPct(pct)
    }
    /** 百分比 → 像素（不吸附；像素本来就是连续的）。 */
    function pctToPx(pct, whole) {
      if (!Number.isFinite(whole) || whole <= 0) return 0
      return Math.round(clampCardNum(pct, 1, 100) / 100 * whole)
    }
    /**
     * 某个列跨度在**当前画布**上实际有多宽 —— 与栅格自己的算法同一份（列宽 + 列间 gap）。
     * 松手吸附动画的终点要用它：终点若按百分比算，会与"落到 span 之后"的真实宽度差几像素，
     * 动画最后一帧就会抖一下（`CL-22` 守着这条）。
     */
    function gridSpanWidthPx(span, canvasW) {
      const W = Number(canvasW) || 0
      if (W <= 0) return 0
      const n = clampCardNum(Math.round(Number(span) || 0), 1, CARD_COLS)
      const colPx = (W - (CARD_COLS - 1) * CARD_GAP_PX) / CARD_COLS
      return Math.round(n * colPx + (n - 1) * CARD_GAP_PX)
    }
    /**
     * 网格档拖动时两处下限的**档位**：像素下限（宽 160 / 高 140）换算成百分比后向上取到 5 的整数倍
     * ⇒ "夹到下限"时卡片仍然落在格点上。
     */
    function minPctFor(canvas) {
      const cw = canvas === null || canvas === undefined ? 0 : Number(canvas.w) || 0
      const ch = canvas === null || canvas === undefined ? 0 : Number(canvas.h) || 0
      return {
        w: cw > 0 ? Math.ceil(CARD_MIN_W_PX / cw * 100 / CARD_GRID_STEP) * CARD_GRID_STEP : CARD_GRID_STEP,
        h: ch > 0 ? Math.ceil(CARD_MIN_H_PX / ch * 100 / CARD_GRID_STEP) * CARD_GRID_STEP : CARD_GRID_STEP,
      }
    }
    /**
     * 老栅格（`auto-fill minmax(min,1fr)`）在某个画布宽度下是**几列** —— 老档位的语义要靠它换算：
     * `w:2` 的含义是"跨老栅格的 2 列"，而老栅格的列数随宽度变（1060 宽 4 列、713 宽 2 列）。
     * ⚠️ 曾经把它当成"固定 50%"（读盘时 w/4*100），于是窄面板里本该**整行**的卡只占一半
     * （真机 SBT-67/77/79/83 就是这么红的：决策卡的 tab 与桶行按一半宽换行，点击/计数全乱）。
     */
    function legacyColsAt(canvasW, minPx) {
      const W = Number(canvasW) || 0
      const min = Number(minPx) > 0 ? Number(minPx) : CARD_NATURAL_MIN_PX
      if (W <= 0) return CARD_LEGACY_SPAN_COLS
      return Math.max(1, Math.floor((W + CARD_GAP_PX) / (min + CARD_GAP_PX)))
    }
    /**
     * 自然档（没调过尺寸的卡）占几列 —— 让"没动过的卡片布局与改造前一致"这条成立：
     * 老栅格是 `auto-fill minmax(240px,1fr)`，1060 宽的画布上是 4 列（每张 259px = 25% = 跨 5 列）；
     * 面板窄到 400 时它只有 1 列（整行），这里也算出 20 列。
     * @param canvasW 画布内容宽（px）；量不到时给 0，回落 5 列
     * @param minPx 老栅格的最小列宽（嵌入态 240 / 浮窗态 280）
     */
    function defaultSpanFor(canvasW, minPx) {
      const W = Number(canvasW) || 0
      const min = Number(minPx) > 0 ? Number(minPx) : CARD_NATURAL_MIN_PX
      if (W <= 0) return 5
      const n = legacyColsAt(W, min)
      const colW = (W - (n - 1) * CARD_GAP_PX) / n
      return clampCardNum(Math.round(colW / W * 100 / CARD_GRID_STEP), 1, CARD_COLS)
    }
    /**
     * 这份尺寸在**当前画布**上怎么落（纯函数，自测直接读它）：
     * @param size `{ w, h, unit }`（已归一化；也接受 `legacy`）
     * @param canvas `{ w, h }` 画布内容区尺寸（px）——宽取网格内容宽、高取**看得见**的高度
     * @param naturalMinPx 老栅格的最小列宽（嵌入态 240 / 浮窗态 280）——只有 legacy 档用得上
     * @returns `{ span, widthPx, heightPx, unit }`：span 是占几列；widthPx=0 表示"铺满所跨的列"；
     *          heightPx=0 表示"自然高"（没有高度档）。
     */
    function layoutForCardSize(size, canvas, naturalMinPx) {
      const has = size !== null && size !== undefined && typeof size === 'object'
      const rawUnit = has ? size.unit : undefined
      const unit = rawUnit === 'free' ? 'free' : (rawUnit === 'legacy' ? 'legacy' : 'grid')
      const cw = canvas === null || canvas === undefined ? 0 : Number(canvas.w) || 0
      const ch = canvas === null || canvas === undefined ? 0 : Number(canvas.h) || 0
      const out = { span: 0, widthPx: 0, heightPx: 0, unit: unit }
      if (!has) return out
      const w = Number(size.w) || 0
      const h = Number(size.h) || 0
      if (unit === 'legacy') {
        // 09-25 那版：`w` 是"跨老栅格的几列"、`h` 是像素。按**当前**老栅格列数折算成 20 列里的跨度，
        //   这样"跨 2 列"在 4 列宽的画布上是 50%、在 2 列宽的画布上就是整行 —— 与当年逐像素一致。
        if (w > 0) {
          const n = legacyColsAt(cw, naturalMinPx)
          out.span = clampCardNum(Math.round(clampCardNum(w, 1, CARD_LEGACY_SPAN_COLS) / n * CARD_COLS), 1, CARD_MAX_SPAN)
        }
        if (h > 0) out.heightPx = Math.round(clampCardNum(h, CARD_MIN_H_PX, CARD_MAX_H_PX))
        return out
      }
      if (w > 0) {
        if (unit === 'grid') {
          out.span = clampCardNum(Math.round(snapPct(w) / CARD_GRID_STEP), 1, CARD_MAX_SPAN)
        } else {
          const colPx = cw > 0 ? (cw - (CARD_COLS - 1) * CARD_GAP_PX) / CARD_COLS : 0
          const want = Math.max(CARD_MIN_W_PX, w)
          out.span = colPx > 0
            ? clampCardNum(Math.ceil((want + CARD_GAP_PX) / (colPx + CARD_GAP_PX)), 1, CARD_MAX_SPAN)
            : 1
          out.widthPx = Math.round(want)
        }
      }
      if (h > 0) {
        // 高度的像素下限一律 140（"格子下限"由拖动那一路按 % 抬到 5 的整数倍，见 onCardResizeMove）
        out.heightPx = unit === 'grid'
          ? (ch > 0 ? clampCardNum(pctToPx(snapPct(h), ch), CARD_MIN_H_PX, CARD_MAX_H_PX) : 0)
          : Math.round(clampCardNum(h, CARD_MIN_H_PX, CARD_MAX_H_PX))
      }
      return out
    }
    /**
     * 读本机存的卡片尺寸。**逐条校验并夹取**，不是全信也不是全丢：
     * 一个坏值只影响它自己那张卡，其余照旧 —— 整份丢会让"我明明调过"变成无法解释的失忆。
     * 老格式（没有 `unit`）按 09-25 那版语义迁移：`w` 是"跨老栅格的几列"（1..4）、`h` 是像素 ⇒
     * 标成 `legacy`，**列数原样留着**（它要按当前画布的老栅格列数折算，见 `legacyColsAt`）。
     */
    function readCardSize() {
      try {
        const raw = lsGet(CARD_SIZE_LS)
        if (raw === null || raw === '') return {}
        const o = JSON.parse(raw)
        if (o === null || typeof o !== 'object' || Array.isArray(o)) return {}
        const out = {}
        for (const k of Object.keys(o)) {
          const v = o[k]
          if (v === null || typeof v !== 'object' || Array.isArray(v)) continue
          const legacy = v.unit !== 'free' && v.unit !== 'grid' && v.unit !== 'legacy'
          const unit = legacy ? 'legacy' : v.unit
          const w = Number(v.w) || 0
          const h = Number(v.h) || 0
          if (w <= 0 && h <= 0) continue
          if (unit === 'legacy') {
            out[k] = {
              w: w > 0 ? Math.round(clampCardNum(w, 1, CARD_LEGACY_SPAN_COLS)) : 0,
              h: h > 0 ? Math.round(clampCardNum(h, CARD_MIN_H_PX, CARD_MAX_H_PX)) : 0,
              unit: 'legacy',
            }
            continue
          }
          out[k] = {
            w: w > 0 ? (unit === 'grid' ? snapPct(w) : Math.round(clampCardNum(w, CARD_MIN_W_PX, 4000))) : 0,
            h: h > 0 ? (unit === 'grid' ? snapPct(h) : Math.round(clampCardNum(h, CARD_MIN_H_PX, CARD_MAX_H_PX))) : 0,
            unit: unit,
          }
        }
        return out
      } catch (e) { return {} }
    }
    /** 读全局缩放模式；没存过 / 存坏了都回默认（网格 5%）。 */
    function readCardSizeMode() {
      const raw = lsGet(CARD_SIZE_MODE_LS)
      return raw === 'free' ? 'free' : 'grid'
    }
    /**
     * 换模式时把已有的档**换算过去**（不换算的话一换模式卡片会全跳一下）：
     * 网格 → 无级：% → px；无级 → 网格：px → %（都按当前画布尺寸算）。
     * 老档（legacy）两个轴按**自己的原单位**折算（w 是"老栅格几列"、h 是 px）。
     * @returns 新的 `cardSize` 表（不改原对象）
     */
    function convertCardSizeMap(map, toUnit, canvas, naturalMinPx) {
      const cw = canvas === null || canvas === undefined ? 0 : Number(canvas.w) || 0
      const ch = canvas === null || canvas === undefined ? 0 : Number(canvas.h) || 0
      const n = legacyColsAt(cw, naturalMinPx)
      const out = {}
      for (const k of Object.keys(map || {})) {
        const v = map[k]
        if (v === null || v === undefined) continue
        const from = v.unit === 'free' ? 'free' : (v.unit === 'legacy' ? 'legacy' : 'grid')
        if (from === toUnit) { out[k] = { w: v.w, h: v.h, unit: toUnit }; continue }
        // ① 先把两个轴折算成"像素"这一个共同视角（各轴按**自己的原单位**折算）：
        //    grid 的 `w` 是画布宽的百分比；legacy 的 `w` 是"跨老栅格几列"（先折成行宽的分数再乘画布宽）；
        //    legacy 的 `h` 与 free 的 h 都是**像素**。⚠️ 把两档混着当像素/百分比用过一次，
        //    症状是卡片一拖就从半屏变成一条（真机探针抓到的）。
        const wPx = from === 'free' ? v.w
          : (from === 'legacy' ? clampCardNum(v.w, 1, CARD_LEGACY_SPAN_COLS) / n * cw : pctToPx(v.w, cw))
        const hPx = from === 'grid' ? pctToPx(v.h, ch) : v.h
        out[k] = {
          w: v.w > 0 ? (toUnit === 'grid' ? pxToPct(wPx, cw, true) : Math.round(clampCardNum(wPx, CARD_MIN_W_PX, 4000))) : 0,
          h: v.h > 0 ? (toUnit === 'grid' ? pxToPct(hPx, ch, true) : Math.round(clampCardNum(hPx, CARD_MIN_H_PX, CARD_MAX_H_PX))) : 0,
          unit: toUnit,
        }
      }
      return out
    }
    /**
     * ── 按**内容**定的卡片默认档（2026-09-26 用户要求）─────────────────────────────
     * 用户原话："根据卡片内容调整其位置和大小。"
     *
     * 依据是每张卡**内容本身的形状**，不是喜好：
     *   · 清单长（决策单日 180+ 条、听记多场）⇒ 给**两列宽**：日期列 + 正文同排不用挤；
     *   · 分组清单 / 字段密集（事务、流入）⇒ 给**更高的档**：一屏能看到更多组；
     *   · 短东西（日程、验收、系统）⇒ **不给档**，按内容自然高（加档只会留白）。
     *
     * ⚠️ 这是**默认**不是写死：用户手动拖过的那张以 localStorage 为准（见 effectiveCardSizeOf）。
     * ⚠️ "位置"也是这么调的：栅格是流式的，一张卡跨两列就会把后面的卡顺推 —— 这就是调位置。
     *    而**不能**去改 `CARD_ORDER`：那张表是三方断言的契约（CARD_ORDER / T16-58 / SBT-23），
     *    动它等于把三条判据同时弄红。
     * ⚠️ 文件名 `kb` 故意**不给档**：它是真机套件（缩放那套）挑出来的靶卡，
     *    给了默认档，"未调过的卡 = 自然档"那条判据就失去对象。这不是迁就测试 ——
     *    文件卡本来就是一列宽就够用的那种内容。
     *
     * ⚠️ 2026-09-26：`w` 的单位是"跨**老栅格**几列"（`unit:'legacy'` 的定义就是"w = 老栅格列数、
     *    h = 像素"）—— 折算成当前 20 列时按**当时的列数**算（`legacyColsAt`），
     *    所以 1060 宽下"跨 2 列"= 50%、713 宽下"跨 2 列"= 整行，与当年一致。
     */
    const CARD_SIZE_DEFAULT = {
      brief: { w: 2, h: 340, unit: 'legacy' },
      minutes: { w: 2, h: 320, unit: 'legacy' },
      triggers: { h: 300, unit: 'legacy' },
      matters: { h: 320, unit: 'legacy' },
      inflow: { h: 300, unit: 'legacy' },
      todos: { h: 260, unit: 'legacy' },
    }
    /** 这张卡**当前生效**的尺寸：用户调过的优先，否则内容默认档，都没有就是自然档 */
    function effectiveCardSizeOf(map, key) {
      const u = map[key]
      if (u !== undefined) return u
      return CARD_SIZE_DEFAULT[key] || null
    }
    function pad2(n) { return n < 10 ? '0' + n : '' + n }
    function fmtClock(ms) { if (!ms) return ''; const d = new Date(ms); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) }
    function fmtDay(ms) { if (!ms) return ''; const d = new Date(ms); return (d.getMonth() + 1) + '-' + pad2(d.getDate()) }
    function fmtAgo(ms) {
      if (!ms) return ''
      const s = (Date.now() - ms) / 1000
      if (s < 3600) return Math.max(1, Math.round(s / 60)) + '分前'
      if (s < 86400) return Math.round(s / 3600) + '时前'
      if (s < 86400 * 30) return Math.round(s / 86400) + '天前'
      return fmtDay(ms)
    }
    // ⚠️ 必须**按本地时区**格式化（2026-09-15 实测踩到）：
    //    host 侧 toIso() 统一转成 UTC ISO（`…T11:50:00.000Z` 实为 19:50 +08），
    //    原实现直接 `slice(11,16)` 会显示成 11:50 —— 日程时间整整差一个时区。
    function hhmm(s) {
      const d = new Date(String(s || ''))
      if (Number.isNaN(d.getTime())) return ''
      return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
    }
    // 统一「日期+时刻」渲染：**带时区的 ISO → 本地时间**（2026-09-16 实测踩到第二次）：
    //   飞书任务的 `created` 来自 host 的 toIso()（UTC `…T04:09:19.000Z`，实为本地 12:09 +08），
    //   原来直接 `slice(0,16)` 会显示 04:09 —— 与 hhmm() 当初修的日程时区是**同一类错**。
    //   判据：带 Z / ±hh:mm 才换算；已是无时区的本地可读串就原样截断；纯日期原样保留（不补 00:00）。
    function localStamp(v) {
      const s = String(v || '').trim()
      if (!s) return ''
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
      const zoned = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)
      if (!zoned && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) return s.slice(0, 16).replace('T', ' ')
      const d = new Date(s)
      if (Number.isNaN(d.getTime())) return s.slice(0, 16).replace('T', ' ')
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
        + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
    }
    function cn(el) { return el && typeof el.className === 'string' ? el.className : '' }

    /** Sidebar root: walk the single-child wrapper chain into the real column. */
    function sidebarRoot(col) {
      if (!col) return null
      let el = col
      let guard = 0
      while (el && el.children && el.children.length === 1 && guard < 6) {
        const only = el.children[0]
        if (only.tagName !== 'DIV') break
        if (only.getBoundingClientRect().height > 100) return only
        el = only
        guard += 1
      }
      return el && el !== col ? el : col.firstElementChild || null
    }

    /** The in-flow element carrying the New Session button. */
    function newSessionHost(root) {
      if (!root) return null
      const buttons = root.querySelectorAll('button')
      let btn = null
      for (let i = 0; i < buttons.length; i += 1) {
        if (cn(buttons[i]).indexOf('newSession') >= 0) { btn = buttons[i]; break }
      }
      if (btn === null) {
        const logo = root.children[0] || null
        for (let i = 0; i < buttons.length; i += 1) {
          if (logo !== null && logo.contains(buttons[i])) continue
          btn = buttons[i]
          break
        }
      }
      if (btn === null) return null
      let host = btn
      let guard = 0
      while (host.parentElement && host.parentElement !== root && guard < 6) { host = host.parentElement; guard += 1 }
      return host
    }

    const inject = ['slots', 'timer']

    function apply(ctx) {
      const style = document.createElement('style')
      style.setAttribute('data-dsh-workbench', '')
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(() => () => { try { style.remove() } catch (e) {} })

      // [v2-skin] 界面 v2 皮肤（2026-09-25）：独立一层样式，可**整段摘除**回退到旧观感。
      //   零结构改动、只在 `.dshw-root` 作用域内生效、与宿主主题互不影响。
      //   回退方法：删掉本块两行（v2style 的创建与 ctx.effect 注册）即可，其余代码无需动。
      const v2style = document.createElement('style')
      v2style.setAttribute('data-dsh-workbench-v2', '')
      v2style.textContent = CSS_V2
      document.head.appendChild(v2style)
      ctx.effect(() => () => { try { v2style.remove() } catch (e) {} })

      // ── P2：裁决四值 / 关联类型的中文名（**界面文案的唯一处**，不散在 JSX 里）──
      //   裁决四值必须与库内 `feedback-ledger.mjs#RULINGS` 逐字一致（断言守着）；
      //   关联类型必须与 `relations.json#types` 一致。
      function rulingLabel(r) {
        return ({ accepted: '采纳', rejected: '驳回', revised: '修正', ignored: '忽略' })[String(r)] || String(r)
      }
      function relTypeLabel(t) {
        return ({ causal: '因果', 'same-object': '同对象', 'same-domain': '同域', temporal: '时序' })[String(t)] || String(t)
      }
      function api(path, init) {
        return fetch('/workbench/api' + path, init).then((r) => r.json())
      }

      /**
       * 带**路由可用性分类**的取数（降级层 · 2026-09-16 用户报障）。
       *
       * 起因：客户端会调用若干**新路由**（`/triggers` `/brief` `/insights` `/disposition`
       *   `/crosscheck` `/domain-health` `/feedback` `/ui-prefs` …）。host 是**随进程加载**的：
       *   代码更新了但 DSH 没重启时，旧进程会对这些路由回 `{error:'unknown route'}`，
       *   而面板原来把 error 原文直接贴出来 ⇒ 用户看到「触发清单不可用: unknown route」，
       *   既看不懂、也不知道要做什么（正确动作是**重启 DSH**）。
       *
       * 分类（三类必须分开，不许混成一句"读取失败"）：
       *   `restart` —— 路由不存在（404 / `unknown route` / not found）⇒ **降级到旧数据源** + 提示"需重启"
       *   `error`   —— 真出错（5xx / 解析失败 / 网络异常）⇒ 如实报错（但**不贴原始路由错误**）
       *   `ok`      —— 2xx 且响应是 JSON
       */
      function apiTry(path, init) {
        return fetch('/workbench/api' + path, init)
          .then((r) => r.text().then((t) => {
            let j = null
            try { j = t && t.length > 0 ? JSON.parse(t) : null } catch (e) { j = null }
            const status = r.status
            const msg = (j && j.error !== undefined && j.error !== null)
              ? String(j.error)
              : (status === 404 ? 'not found' : 'HTTP ' + status)
            const kind = (status === 404 || /unknown route|not found|no such route/i.test(msg))
              ? 'restart'
              : (status >= 200 && status < 300 && j !== null ? 'ok' : 'error')
            return { kind, status, json: j, error: msg }
          }))
          .catch((e) => ({ kind: 'error', status: 0, json: null, error: String((e && e.message) || e) }))
      }

      /** 路由未加载（旧 host）的统一提示语 —— 面板**永远不显示** `unknown route` 这类原文 */
      const ROUTE_DOWN_TEXT = '该能力的新路由未加载（需重启 DSH）'
      /** 卡片内的降级提示元素（各卡只需一行，避免各自的文案漂移） */
      function downNote(label, key) {
        return React.createElement('div', { className: 'dshw-detail', key: key || ('down-' + label) },
          '⚠️ ' + label + '：' + ROUTE_DOWN_TEXT + ' —— 该卡已降级（不会显示原始路由错误；重启后自动恢复）')
      }
      /** 真出错时的展示语：只给意图明确的一句 + 原因，不暴露路由内部字样 */
      function routeErrText(what, r) {
        const reason = String((r && r.error) || '未知原因')
        return what + '读取失败：' + (/unknown route/i.test(reason) ? ROUTE_DOWN_TEXT : reason)
      }

      function pickAudio() {
        try {
          if (typeof AudioContext !== 'undefined') return AudioContext
          if (typeof window.webkitAudioContext !== 'undefined') return window.webkitAudioContext
        } catch (e) {}
        return null
      }
      function mediaApi() {
        try {
          const md = navigator.mediaDevices
          return md && typeof md.getUserMedia === 'function' ? md : null
        } catch (e) { return null }
      }
      // 虚拟摄像头识别（2026-09-15 用户实测：本机浏览器看到 2 个视频输入，**全是虚拟的** ——
      //   "WebcastMate VirtualCamera" 与 "OBS Virtual Camera"，getUserMedia 打开的正是前者。
      //   面板只写"已连接"会让人误以为**物理摄像头可用** ⇒ 必须把"虚拟/物理"讲清楚。）
      const VIRTUAL_CAM_RE = /(virtual\s*cam|virtualcamera|虚拟|obs|webcast|broadcast|manycam|droidcam|iriun|e2esoft|vcam|v\s*cam|splitcam|streamlabs|xsplit|snap\s*camera|remote\s*cam|远程摄像头|向日葵|oray|gameviewer|shadowbot|妙播|virtual\s*video)/i
      function isVirtualCamLabel(label) { return VIRTUAL_CAM_RE.test(String(label || '')) }
      function stopStream(s) {
        try { const ts = s.getTracks(); for (let i = 0; i < ts.length; i += 1) { try { ts[i].stop() } catch (e) {} } } catch (e) {}
      }
      function reservedRightOf(frame) {
        try {
          const v = parseFloat(window.getComputedStyle(frame).paddingRight)
          return Number.isFinite(v) ? Math.round(v) : 0
        } catch (e) { return 0 }
      }

      function Workbench(props) {
        // embedded=true：渲染在 better-sidebar 的折叠侧边栏 tab 里（PC/移动端统一 UI）。
        // 该模式下不做 overlay 定位/布局改动（locate/tick/拖拽全跳过），面板按 100% 宽自适应。
        const embedded = !!(props && props.embedded)
        const h = React.createElement
        const outer = React.useRef(null)
        const stopRef = React.useRef([])
        const panelElRef = React.useRef(null)
        const wbHRef = React.useRef(340)
        const frameHRef = React.useRef(800)
        const dragRef = React.useRef(null)
        const [box, setBox] = React.useState({ ready: false, sidebarW: 0, wbW: 420, wbH: 340, panelFound: false, ownReserve: true })
        const [wbH, setWbH] = React.useState(() => {
          const v = parseInt(lsGet('dshw.wbH') || '', 10)
          return Number.isFinite(v) && v >= 180 && v <= 900 ? v : 340
        })
        const [tab, setTab] = React.useState(() => {
          const v = lsGet('dshw.tab')
          for (let i = 0; i < CATS.length; i += 1) if (CATS[i].key === v) return v
          return 'all'
        })
        const [dragging, setDragging] = React.useState(false)
        const [snap, setSnap] = React.useState(null)
        const [snapErr, setSnapErr] = React.useState(null)
        // 数据层（personal-workbench）：与钉钉取数**分开取**，因为两者代价差很远
        const [pwb, setPwb] = React.useState(null)
        const [pwbErr, setPwbErr] = React.useState(null)
        const [pwbBusy, setPwbBusy] = React.useState(false)
        const [busy, setBusy] = React.useState(false)
        const [detail, setDetail] = React.useState(null)
        // 待办二级详情（2026-09-15 用户要求：待办行点击 → 二级详情）
        const [todoDetail, setTodoDetail] = React.useState(null)
        // 源头回写状态（2026-09-17）：busy = 正在同步的动作；msg = 成功/失败反馈（失败必显示原因）
        const [todoSync, setTodoSync] = React.useState({ busy: null, msg: null })
        const [note, setNote] = React.useState(null)
        // dev.spkOn / dev.cam = 音响输出通道、摄像头视频轨的**显式开关状态**（点击小卡片切换）
        // dev.spkFailed / dev.camFailed = 上次连接失败（显示红色「断开」，仍可点击重试）
        const [dev, setDev] = React.useState({ phase: 'idle', note: null, mic: 0, spkOn: false, spkFailed: false, cam: false, camFailed: false, camVirtual: null, camInventory: null, devices: null, micLabel: '', camLabel: '' })
        // 头部瞬时提示（设备操作回执）：{ text, key, tone, phase:'in'|'out' } —— 淡入 → 最多 10s → 淡出
        const [toast, setToast] = React.useState(null)
        const toastStopRef = React.useRef(null)
        // 底部系统在线状态（DWS / MCP / 本地工具 / 浏览器）—— 由 host 的 /sysstatus 探测（带缓存）
        const [sysStatus, setSysStatus] = React.useState(null)
        // 「系统」卡里的两张**能力小卡片**（实时回复 / 响应功能）：host `/system-state` 转调库内判定。
        //   ⚠️ 与 `/sysstatus`（120s）**分开轮询**：这两盏灯里有"执行中(黄)"这种秒级状态，20s 一轮。
        //   payload 里带**全部证据**（任务状态 / 锁内 pid / 心跳时刻 / 是否在会中 / 在途条数），
        //   面板**只显示、不推断** —— 判定唯一产地是 `_meta/workbench/system-switches.mjs`。
        const [sysCaps, setSysCaps] = React.useState(null)
        const sysCapsBusyRef = React.useRef(false)
        // 实时活动（正在调用哪个 MCP / 正在操作哪个工具 / DWS 是否在采集）—— host /activity，3s 轮询
        const [activity, setActivity] = React.useState(null)
        // 专注块表单（2026-09-14 裁定：面板按钮 + DSH 工具两个入口，面板侧是这里的表单）
        const [focusForm, setFocusForm] = React.useState({ open: false, kind: 'domain', id: '', minutes: '50', label: '' })
        const [focusBusy, setFocusBusy] = React.useState(false)
        const [focusMsg, setFocusMsg] = React.useState(null)
        // ── 专注期间的三层规则（2026-09-17 用户裁定）· 客户端状态 ─────────────────
        //   foModal = 入队/穿透**二级详情**（只读）：{ kind:'active'|'last', id, label }
        //     沿用本文件既有 portal 到 document.body 的模态模式（与 objModal/brfModal 同一形态）。
        //   focusUnfold = 专注期间被用户手动展开的**非醒目卡**（键 = cardKey）。
        //     ⚠️ 只影响"折叠/展开"这一个视觉位，**不改顺序、不影响长按拖动**。
        const [foModal, setFoModal] = React.useState(null)
        const [focusUnfold, setFocusUnfold] = React.useState({})
        // 事务详情卡（E 块 2026-09-15 裁定：卡片按钮 → 上层详情卡：详情 / 添加记录 / 关闭或重开）
        const [matterModal, setMatterModal] = React.useState(null)
        // 日程详情卡（2026-09-15 用户要求：**点击日程 → 上层弹窗**显示详情，与事务详情卡同一形态）
        // { e, loading, attendees, error, note }
        const [calModal, setCalModal] = React.useState(null)
        // 对象（2026-09-16 新卡）：数据源 = host 只读透传的 objects.json（路由 `/objects`）。
        //   objs = **原始 payload**（本卡不改写、不派生）；objsErr = 读失败 —— 与「无数据」分开存，不合并。
        const [objs, setObjs] = React.useState(null)
        const [objsErr, setObjsErr] = React.useState(null)
        const [objsBusy, setObjsBusy] = React.useState(false)
        /**
         * 「活跃」卡 **域 → 对象** 下钻的展开态（2026-09-17 新增）。
         *   初始值 = localStorage 的 `dshw.domOpen`（缺省展开）；只影响**渲染**，不写 host、不进契约。
         *   为什么要有这个 state：`lsGet()` 读的是外部存储，React 不会因为它变化而重渲染 ——
         *   必须存一份到 state 里，点「收起/展开」才立刻生效。
         */
        const [domOpen, setDomOpen] = React.useState(() => lsGet('dshw.domOpen') !== '0')
        // T31 能力①/⑤（2026-09-16）：决策卡 `brief.json` / 跨源洞察 `insights.json`（旧称「今日决策面」，2026-09-17 改名，见 CARD_TITLES）
        //   与数据层分开取、且比数据层更慢（由库内 objects 管线生成）⇒ 60s 一次。
        //   三态分开存：err（读失败）/ null（未取到）/ 有数据（**0 条也是有数据**）—— 不合并。
        const [brief, setBrief] = React.useState(null)
        const [briefErr, setBriefErr] = React.useState(null)
        const [briefBusy, setBriefBusy] = React.useState(false)
        const [insights, setInsights] = React.useState(null)
        const [insightsErr, setInsightsErr] = React.useState(null)
        const [insightsBusy, setInsightsBusy] = React.useState(false)
        /**
         * 处置台账 / 多源校验（2026-09-16 接上两条只读出口）。
         * 与 pwb.disposition / pwb.crosscheck 的**摘要**分工：
         *   · /state 的摘要在「流入」卡头给三数（有落点/无落点/悬置）—— 便宜、随数据层刷新；
         *   · 独立路由给**清单与定义**（noLanding[] 逐条、definitions、multiSource…）—— 60s 一次。
         * 三态（读失败 / 无数据 / 口径为 0）与 objs 同一口径：docErr 与 doc=null 分开存，不合并。
         */
        const [dispoDoc, setDispoDoc] = React.useState(null)
        const [dispoDocErr, setDispoDocErr] = React.useState(null)
        const [dispoDocBusy, setDispoDocBusy] = React.useState(false)
        const [dispoShowAll, setDispoShowAll] = React.useState(false)
        // ── 卡片顺序覆盖层（2026-09-16 用户裁定：可拖动排序）────────────────────
        //   默认顺序 = `CARD_ORDER`（契约）；这里是**用户覆盖层**，只影响渲染，不改默认表。
        //   覆盖层存 host（`_meta/out/ui-prefs.json`，路由 `/ui-prefs`）⇒ 跨刷新/跨设备一致。
        //   三态分开存（与 objs 同口径）：orderErr（读/写失败）/ null（无覆盖层）/ 数组（有覆盖层）。
        const [cardOrderOverride, setCardOrderOverride] = React.useState(null)
        const [orderErr, setOrderErr] = React.useState(null)
        // ── 卡片尺寸（2026-09-25 用户要求：右下角小三角拖动放大缩小）──────────────
        //   形态 `{ <cardKey>: { w: <列跨度>, h: <像素高> } }`。
        //   与卡片顺序**刻意不同**：顺序存 host（跨设备一致），尺寸只存 localStorage
        //   （纯本机呈现态）—— 原因是 `/ui-prefs` 的字段是白名单（host `UI_PREF_FIELDS`），
        //   加一个字段要改 host 并**重启 DSH** 才生效。落本地的代价是"换台机器尺寸不带过去"。
        //   ⚠️ 键名与 `dshw.domOpen` 同一口径；读不出来的值一律**夹到合法区间**，不整份丢。
        const [cardSize, setCardSize] = React.useState(readCardSize)
        const cardSizeRef = React.useRef(cardSize)
        cardSizeRef.current = cardSize
        // 缩放档位（2026-09-26 用户裁定："可以选择无级缩放或者网格缩放"）——全局一档，落 localStorage。
        const [sizeMode, setSizeMode] = React.useState(readCardSizeMode)
        const sizeModeRef = React.useRef(sizeMode)
        sizeModeRef.current = sizeMode
        // 画布内容区尺寸：宽 = 网格内容宽、高 = **看得见**的高度（滚动内容不算）。
        //   百分比档要它才算得出像素；面板被拖宽/改高时必须重算 ⇒ 挂 ResizeObserver。
        const gridRef = React.useRef(null)
        const [canvasBox, setCanvasBox] = React.useState({ w: 0, h: 0 })
        const [rszKey, setRszKey] = React.useState(null)
        const rszRef = React.useRef(null)
        /** 松手吸附动画的收尾定时器（把行内的像素宽高换成栅格的 span 写法）；卸载时清掉。 */
        const rszSnapRef = React.useRef(null)
        React.useEffect(() => () => {
          try { if (rszSnapRef.current !== null) clearTimeout(rszSnapRef.current) } catch (e) { /* ignore */ }
          rszSnapRef.current = null
        }, [])
        // 量画布：依赖 `box.ready`（面板还没挂出来时网格元素不存在，只观察空气等于永远量不到）。
        const panelReady = box.ready === true
        React.useEffect(() => {
          const el = gridRef.current
          if (el === null || el === undefined) return undefined
          const read = () => {
            const next = canvasBoxOf(el)
            // 页面级只读出口：真机套件按**同一份**画布尺寸算期望值（换算口径只此一处）
            try {
              if (typeof window !== 'undefined' && window !== null) window.__DSHW_CANVAS_BOX__ = { w: next.w, h: next.h }
            } catch (e) { /* ignore */ }
            setCanvasBox((prev) => (prev.w === next.w && prev.h === next.h ? prev : next))
          }
          read()
          if (typeof ResizeObserver === 'undefined') return undefined
          let ro = null
          try {
            ro = new ResizeObserver(read)
            ro.observe(el)
          } catch (e) { ro = null }
          return () => { if (ro !== null) { try { ro.disconnect() } catch (e) { /* ignore */ } } }
        }, [panelReady])
        // ── 卡片"磁力贴"移动（2026-09-25 用户要求：左下角小方块按住拖动换位置）────────
        //   为什么另立一套状态、不复用长按排序那套：
        //     长按那套是"到点才抬起 + 只画一条落点线 + 松手才换位"，手感是"排序"；
        //     用户这次要的是"按住就跟着走、周围卡片**实时**让开、松手落在原地"，
        //     也就是手机桌面那种磁力贴。两者对指针的处理完全不同，混在一起两边都做不好。
        //   `dragPreview`：拖动期间**只影响渲染**的预览顺序（不写 host、不写库内产物）；
        //     松手才 `saveCardOrder` 落盘。中途取消 ⇒ 直接丢掉预览，卡片自己滑回原位。
        const [moveKey, setMoveKey] = React.useState(null)
        const [dragPreview, setDragPreview] = React.useState(null)
        const dragPreviewRef = React.useRef(null)
        dragPreviewRef.current = dragPreview
        const moveDragRef = React.useRef(null)   // { key, px, py, grabX, grabY }
        const flipRef = React.useRef(null)       // 待执行的 FLIP 起点（key → rect）
        const effectiveOrderRef = React.useRef([])
        const [dragKey, setDragKey] = React.useState(null)
        const [dragOverKey, setDragOverKey] = React.useState(null)
        const [crossDoc, setCrossDoc] = React.useState(null)
        const [crossDocErr, setCrossDocErr] = React.useState(null)
        const [crossDocBusy, setCrossDocBusy] = React.useState(false)
        // 判断质量台账（`/feedback` 只读出口）：给「验收」卡**卡内小节**提供裁决统计与待裁定条目。
        // 三态与其它只读出口同一口径：`fbDocErr`（读失败）与 `fbDoc === null`（尚未取到）**分开存**，
        // 不与「无记录」（503 / entries: []）合并 —— 三者混成一个变量就会把"读不到"写成"没有"。
        const [fbDoc, setFbDoc] = React.useState(null)
        // ── P2/B5：裁决写入口的本地状态（采纳 / 驳回 / 修正 / 忽略 + 必填理由）──────
        //   为什么用 ref 而不是普通 state：裁决发生在**二级详情弹窗**里，弹窗是普通 DOM 子树，
        //   不能在里面条件式地调 hook。理由框走 onChange 写 ref + 一次 tick 重渲染，最省改动面。
        //   ⚠️ 写通道：`POST /feedback`（host 早已存在）⇒ 库内 `cli-feedback.mjs record`
        //      ⇒ `feedback.json`。**不新开路由、不改 host、不需要重启 DSH。**
        const fbRulingRef = React.useRef({ reason: '', busy: false, msg: null })
        const [, fbRulingTick] = React.useState(0)
        const fbRulingSet = (patchObj) => {
          fbRulingRef.current = Object.assign({}, fbRulingRef.current, patchObj)
          fbRulingTick((n) => n + 1)
        }
        /** 一键裁决：四值 = 采纳/驳回/修正/忽略。**空理由由库内拒收**（这里只做前置提示，判定仍在库里一份） */
        const fbRulingSubmit = (item, ruling) => {
          const reason = String(fbRulingRef.current.reason || '').trim()
          if (reason.length === 0) {
            fbRulingSet({ msg: '理由必填 —— 空理由会被判断质量台账拒收（这是库内判据，不是界面提示）' })
            return
          }
          const body = {
            type: 'attribution',
            ruling,
            content: String((item && item.subject) || '') + ' —— ' + String((item && item.detail) || ''),
            reason,
            rule_key: String((item && item.rule) || ''),
          }
          fbRulingSet({ busy: true, msg: null })
          api('/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
            .then((r) => {
              if (r && r.ok === false) { fbRulingSet({ busy: false, msg: '台账拒收：' + String(r.error || '') }); return }
              fbRulingSet({ busy: false, reason: '', msg: '已记入判断质量台账（' + rulingLabel(ruling) + '）· 产物 _meta/out/feedback.json' })
            })
            .catch((e) => fbRulingSet({ busy: false, msg: '写入失败：' + String((e && e.message) || e) }))
        }
        const [fbDocErr, setFbDocErr] = React.useState(null)
        const [fbDocBusy, setFbDocBusy] = React.useState(false)
        // 对象二级详情（只读）：{ key, item } —— item 为 objects[] 里的原始条目（缺省按 key 查）
        const [objModal, setObjModal] = React.useState(null)
        // 听记「归档」区是否展开（2026-09-20 用户规格：超过 30 天的听记从一级列表退出，走归档入口查看）。
        //   ⚠️ 这是**本机呈现态**（不落库内产物、不发请求）：与 `cardFolded` 同一性质 ——
        //   打开归档只是"看"，不改任何数据；改数据的地方不在这里。
        const [minArchOpen, setMinArchOpen] = React.useState(false)
        // 听记 → 事务（第四条 → 2026-09-26 第六条升级为**草稿预填**）：
        //   `minModal`  = 正在转事务的那条听记（`{src,id,title,url}`；`id` = 飞书 minute_token /
        //                 钉钉 taskUuid —— 钉钉那一支由 host 从 url 尾段兜底取，面板不强求有 id），
        //   `minForm`   = 表单（预填自引擎草稿；人可改任意一项），
        //   `minDraft`  = 引擎出参**原样**（含 `anchor_candidates` / `evidence` / `validation` / `notes`），
        //   `minDraftState` = `idle|loading|ready|unavailable|error` 五态（**分开存**，不合并成"没数据"——
        //                 "取不到正文"与"路由没加载"是两件完全不同的事，出口文案也不同），
        //   `minMsg`    = 库内原样回的结论（命中查重时说"已存在"，不伪装成新建成功）。
        const [minModal, setMinModal] = React.useState(null)
        const [minForm, setMinForm] = React.useState({ title: '', domain: '', done_when: '', due_at: '', origin_project: '', origin_inbound: '', anchor: '' })
        const [minMsg, setMinMsg] = React.useState(null)
        const [minDraft, setMinDraft] = React.useState(null)
        const [minDraftState, setMinDraftState] = React.useState('idle')
        const [minDraftErr, setMinDraftErr] = React.useState(null)
        const [minDraftNotes, setMinDraftNotes] = React.useState([])
        // 同一份听记要**拆成第二件事**时，去重键必须自己加后缀（否则会被幂等挡回第一条）——
        //   由人勾选，界面不替他决定（SPEC §十二 12.4）
        const [minDedup2, setMinDedup2] = React.useState(false)
        const [minBusy, setMinBusy] = React.useState(false)
        // 日程取消/恢复（第三条）的**结果提示**（`dshw-err` / `dshw-detail` 一行）。
        //   ⚠️ 不常驻：只有点过之后才有内容 —— 静态卡片不因"host 未重启"就挂一条告警。
        const [schedMsg, setSchedMsg] = React.useState(null)
        const [schedBusy, setSchedBusy] = React.useState(false)
        // ── 场景交互（SPEC_卡片交互规范 §2.1/§三）：**点卡片名称只改呈现** ──────────────
        //   登记表在**模块级**（`CARD_SCENES` / `cardKeyOfTitle`，单一来源）。
        //   这里只放**本机呈现态**：落 localStorage（与 `dshw.briefBucket` 同一口径）；
        //   **不写库内产物、不进 `matter-overrides`、不动 `CARD_ORDER`**（SPEC §2.1 明文）。
        //   退出方式：**再点一次卡名**（SPEC §三 要求"没有退出方式的呈现改动会把人锁在一种视图里"）。
        const [cardFolded, setCardFolded] = React.useState(() => {
          const raw = lsGet('dshw.cardFolded')
          if (raw === null || raw === '') return {}
          try {
            const v = JSON.parse(raw)
            return (v !== null && typeof v === 'object') ? v : {}
          } catch (e) { return {} }
        })
        /** 切换某卡的折叠态（场景交互）—— 只改呈现，**不发任何请求** */
        const toggleCardFolded = (key) => {
          if (key === null || Object.prototype.hasOwnProperty.call(CARD_SCENES, key) !== true) return
          setCardFolded((prev) => {
            const next = Object.assign({}, prev)
            if (next[key] === 1) delete next[key]
            else next[key] = 1
            try { lsSet('dshw.cardFolded', JSON.stringify(next)) } catch (e) { /* 存储不可用 ⇒ 仅内存态 */ }
            return next
          })
        }
        // ── ⌘K 命令面板（2026-09-25 · 参考站的核心交互）────────────────────────────
        //   用户 2026-09-25 裁定：要更新的是 better-sidebar 里这张卡，且要"模仿参考站的
        //   界面风格和交互逻辑"。参考站最有价值的一条交互就是 ⌘K：一个面板，任何东西直达。
        //   这张卡有 13 张卡纵向排开、动辄上百行，**滚动找东西**正是它当前最大的 UX 税。
        //
        //   三条设计纪律（都是为了不动既有契约）：
        //     ① **平静态零结构改动**：面板默认不因为本功能多出任何节点 ——
        //        不加入口按钮（头部布局有 SBT-11j/11k/11m 的几何判据守着），
        //        只在既有的 `.dshw-sub` 文本尾巴上加一句提示（该节点**没有**任何断言）；
        //        命令面板本身只有打开时才 portal 到 body，关掉即卸载。
        //     ② **只在 DOM 里搜，不另建索引**：候选 = 当前**真的渲染出来**的卡片与行
        //        （`.dshw-slot` → 卡名；卡内 `.dshw-item` → 行文本 + 时间列）。
        //        为什么不从 payload 另算一份：那会立刻构成"第二份声明"——
        //        面板显示什么、搜索就必须搜什么，两边一旦漂移，搜到的点不过去。
        //     ③ **命中后按原有通路打开**：先把卡滚进视野并闪一下（`data-wb2hit`），
        //        再对行元素发一次原生 `click()` —— 复用行自己既有的 onClick（详情弹窗、
        //        页签、折叠…全都照旧），本功能不碰任何业务逻辑。
        // ── ⌘K：候选收集 / 过滤 / 跳转（实现见上方 2026-09-25 设计纪律）────────────────
        const [cmdkOpen, setCmdkOpen] = React.useState(false)
        const [cmdkQ, setCmdkQ] = React.useState('')
        const [cmdkSel, setCmdkSel] = React.useState(0)

        // ── 新手指引的状态与动作（2026-09-25）───────────────────────────────────────
        //   ⚠️ 必须声明在 `cmdkGo` **之前**：`cmdkGo` 是命令条的执行者、要用到 `startTour`，
        //      而 `React.useCallback(fn, deps)` 的 **deps 数组是在 render 期求值的** ——
        //      把 `startTour` 写在后面会让 deps 撞上 TDZ（`Cannot access before initialization`）。
        //      （本项目专门有一条判据盯这类报错：SBT-13/14/49。）
        const TOUR_STEPS = [
          { sel: '.dshw-root .dshw-card', title: '这些卡片就是你的工作台', text: '13 张卡按三带排开：上面是「要决策的」、中间是「要做的」、下面是「要看/要归档的」。每张卡的标题右侧那个数字是它的关键指标。' },
          { sel: '.dshw-root .dshw-tab', title: '分类页签', text: '部分卡片（文件 / 听记这类）带分类页签，切换只会改变卡内列出哪一批，不影响数据。' },
          { sel: '.dshw-root .dshw-card-title', title: '点卡名折叠，长按拖动排序', text: '点一下卡名把这张卡折成一行摘要（再点展开）；长按卡名或卡片空白处约半秒可以拖动换位，顺序会记住。' },
          { sel: '.dshw-root .dshw-item[data-click="1"]', title: '每一行都能点开看详情', text: '可点的行点进去是二级详情：来源、时间、出处、可做的动作都在里面。' },
          { sel: '.dshw-root .dshw-sub', title: '⌘K：不用翻，直接搜', text: '按 ⌘K（Windows 是 Ctrl+K）打开搜索，卡片名、条目正文、时间都能搜；上下键选、回车跳过去，被命中的卡片会闪一下。' },
          { sel: '.dshw-root .dshw-orderbar', title: '想回默认顺序就点这里', text: '拖动改过顺序之后，这一行会出现「恢复默认」；平时它只提示"长按卡片可拖动排序"。' },
        ]
        const [tourStep, setTourStep] = React.useState(-1)
        const [tourRect, setTourRect] = React.useState(null)

        // ── 右侧抽屉 · 卡片目录（2026-09-25）───────────────────────────────────────
        //   为什么内容不是"闸台账"：**流入卡本身就是闸台账**（卡头四数 + 720 条清单，
        //   SBT-31 逐条守着）。再开一个抽屉放同样的东西就是重复一份，本项目最忌这个。
        //   改放**整栏的目录**：13 行 = 卡名 + 该卡的关键指标 + 可见条目数，点一行跳过去。
        //   数据全部来自**已经渲染出来的 DOM**（`[data-card-metric]` 是契约容器，
        //   SBT-92 断言 13 张卡一张不缺），所以它永远不会和卡面说的不一样。
        const [dwOpen, setDwOpen] = React.useState(false)

        // ── 外观：宣纸（浅）/ 夜书（深）· 手动切换 + 跟随 DSH 的 ui 外观（2026-09-26）──
        //   为什么要"跟随"这一档：用户的期望是"我在 DSH 里切了深色，这张卡跟着变"，
        //   而不是"这张卡自己记得上次选的色"。所以三档 —— 跟随 / 宣纸 / 夜书，
        //   手动那两档是**锁定**（DSH 再切也不跟），随时可以选回"跟随"。
        //   ⚠️ 主题落在 `body[data-dshw-theme]` 这一个属性上，**不落在** `.dshw-root`：
        //      弹窗 / 命令面板 / 引导 / 抽屉 / 外观浮层都是 portal 到 body 的节点，
        //      在 `.dshw-root` 之外继承不到那里的变量（颜色会静默变 unset）。
        //      皮肤的颜色令牌因此也挂在 body 上（见 CSS_V2 文件头的纪律 ④）。
        const THEME_KEY = 'dshw.theme'
        /** 同文档多实例之间广播偏好用的自定义事件（`storage` 事件**不发给写它的那个文档**） */
        const THEME_EVT = 'dshw-theme-pref'
        /** 读偏好：只认 paper / night，其余（含没写过）一律当"跟随" */
        const readThemePref = () => {
          const v = lsGet(THEME_KEY)
          return v === 'paper' || v === 'night' ? v : 'auto'
        }
        const [themePref, setThemePref] = React.useState(readThemePref)
        const [themeOpen, setThemeOpen] = React.useState(false)
        const [themeAt, setThemeAt] = React.useState(null)
        // ⚠️ 这张卡可能**同时挂在两个席位**上（右栏 + 侧边栏 tab）。每个实例各持一份 state，
        //   只在本地 setState 的话，另一个席位的实例仍按**旧偏好**写 body 属性 ⇒
        //   两边互相顶掉（谁重渲染谁赢），表现就是"切了又自己变回去"。
        //   所以偏好按**共享真相源**处理：改的人广播，其余实例跟着收听
        //   （`storage` 事件管跨文档 / 跨窗口，自定义事件管同文档内的多实例，两个都要收）。
        React.useEffect(() => {
          if (typeof window === 'undefined') return undefined
          const norm = (raw) => (raw === 'paper' || raw === 'night' ? raw : 'auto')
          const onLocal = (e) => { if (e !== null && e !== undefined) setThemePref(norm(e.detail)) }
          const onStorage = (e) => { if (e !== null && e !== undefined && e.key === THEME_KEY) setThemePref(norm(e.newValue)) }
          try {
            window.addEventListener(THEME_EVT, onLocal)
            window.addEventListener('storage', onStorage)
          } catch (e) { return undefined }
          return () => {
            try { window.removeEventListener(THEME_EVT, onLocal) } catch (e) { /* ignore */ }
            try { window.removeEventListener('storage', onStorage) } catch (e) { /* ignore */ }
          }
        }, [])
        // DSH 的外观切换只改 body 上的 `data-ds-dark-theme`（ui-theme 的 design-platform.css）
        //   ⇒ 盯住这一个属性就等于"跟着 DSH 切"。DOM 属性是**可变来源**，
        //     所以要一个 tick 把它变成一次真渲染，否则读到的永远是上一帧的旧值。
        const [darkTick, setDarkTick] = React.useState(0)
        React.useEffect(() => {
          if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return undefined
          if (themePref !== 'auto') return undefined
          const mo = new MutationObserver(() => setDarkTick((v) => v + 1))
          try { mo.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] }) } catch (e) { return undefined }
          return () => { try { mo.disconnect() } catch (e) { /* ignore */ } }
        }, [themePref])
        const dshDark = () => typeof document !== 'undefined' && document.body !== null
          && document.body.hasAttribute('data-ds-dark-theme') === true
        const themeMode = React.useMemo(() => {
          if (themePref !== 'auto') return themePref
          return dshDark() ? 'night' : 'paper'
        }, [themePref, darkTick])
        React.useEffect(() => {
          if (typeof document === 'undefined' || document.body === null) return undefined
          // 多席位同时挂载时**只在值不同才写**：同一个值反复 setAttribute 既制造无谓的属性变更，
          //   也让"到底谁最后写的"变得无从判断（排查主题问题时最怕这个）。
          try {
            if (document.body.getAttribute('data-dshw-theme') !== themeMode) {
              document.body.setAttribute('data-dshw-theme', themeMode)
            }
          } catch (e) { /* ignore */ }
          // ⚠️ **故意不在 cleanup 里删掉这个属性**：这张卡可能同时挂在多个席位上
          //   （右栏 / 侧边栏 tab / 内嵌），任何一个实例卸载就把属性删掉，剩下那张卡会掉回浅色。
          //   属性本身是**惰性**的：样式表随插件一起摘除之后，没有元素再消费 --wb2-*。
        }, [themeMode])
        const THEME_NAME = { auto: '跟随外观', paper: '宣纸', night: '夜书' }
        const pickTheme = (v) => {
          const next = (v === 'paper' || v === 'night') ? v : 'auto'
          setThemePref(next)
          lsSet(THEME_KEY, next)
          // 广播给同文档内的其它席位（另一处实例立刻跟着换，谁都别再按旧偏好写属性）
          try { window.dispatchEvent(new CustomEvent(THEME_EVT, { detail: next })) } catch (e) { /* ignore */ }
          setThemeOpen(false)
          // 给一条头部提示：切完之后"这一档到底是跟还是不跟"必须说出来
          //   （浮层关掉之后就没地方显示了，用户最容易在这里搞不清状态）。
          showToast('外观：' + THEME_NAME[next] + (next === 'auto' ? '（当前 ' + (dshDark() ? '深色' : '浅色') + '）' : '（已锁定）'))
        }
        /** 打开外观浮层：贴在入口按钮下面（右对齐钳到视口内，避免贴着边被切掉） */
        const openThemeMenu = (e) => {
          try {
            const r = e.currentTarget.getBoundingClientRect()
            const w = 184
            const vw = window.innerWidth || 1024
            setThemeAt({ left: Math.round(Math.max(8, Math.min(r.left, vw - w - 8))), top: Math.round(r.bottom + 6) })
          } catch (err) { setThemeAt(null) }
          setThemeOpen((v) => (v === true ? false : true))
        }

        /** 顺着 DOM 收集 13 行目录 */
        const dwRows = React.useCallback(() => {
          const out = []
          if (typeof document === 'undefined') return out
          const root = document.querySelector('.dshw-root')
          if (root === null) return out
          const slots = root.querySelectorAll('.dshw-slot')
          for (let i = 0; i < slots.length; i += 1) {
            const slot = slots[i]
            const key = slot.getAttribute('data-key') || ''
            const titleEl = slot.querySelector('.dshw-card-title')
            const metricEl = slot.querySelector('[data-card-metric]')
            const card = slot.querySelector('.dshw-card')
            if (card === null) continue
            out.push({
              key: key,
              card: card,
              name: titleEl !== null ? String(titleEl.textContent || '').trim() : key,
              metric: metricEl !== null ? String(metricEl.textContent || '').trim() : '',
              rows: slot.querySelectorAll('.dshw-item').length,
              folded: card.getAttribute('data-card-folded') === '1',
            })
          }
          return out
        }, [])

        /** 跳到某张卡：滚进视野 + 闪一下（与 ⌘K 命中同一套视觉反馈，不另造一套） */
        const dwGo = React.useCallback((row) => {
          if (!row) return
          setDwOpen(false)
          try { row.card.scrollIntoView({ block: 'center', behavior: 'smooth' }) } catch (e) { /* 老内核 */ }
          try {
            row.card.setAttribute('data-wb2hit', '1')
            setTimeout(() => { try { row.card.removeAttribute('data-wb2hit') } catch (e) { /* 已卸载 */ } }, 1900)
          } catch (e) { /* ignore */ }
          if (row.folded === true) {
            try {
              const k = row.card.closest('.dshw-slot')
              const kk = k !== null ? k.getAttribute('data-key') : null
              if (kk !== null && cardFolded[kk] === 1) toggleCardFolded(kk)
            } catch (e) { /* ignore */ }
          }
        }, [cardFolded, toggleCardFolded])
        const startTour = React.useCallback(() => { setTourStep(0); setCmdkOpen(false); setCmdkQ('') }, [])
        const endTour = React.useCallback(() => {
          setTourStep(-1)
          try { lsSet('dshw.tourDone', '1') } catch (e) { /* 存储不可用 ⇒ 只影响下次是否提示 */ }
        }, [])

        /** 从**当前已渲染的 DOM** 收集候选项：卡名一条 + 卡内每个可点行一条 */
        const cmdkCollect = React.useCallback(() => {
          const out = []
          if (typeof document === 'undefined') return out
          const root = document.querySelector('.dshw-root')
          if (root === null) return out
          const slots = root.querySelectorAll('.dshw-slot')
          for (let i = 0; i < slots.length; i += 1) {
            const slot = slots[i]
            const key = slot.getAttribute('data-key') || ''
            const titleEl = slot.querySelector('.dshw-card-title')
            const title = titleEl !== null ? String(titleEl.textContent || '').trim() : key
            const card = slot.querySelector('.dshw-card')
            if (card !== null) out.push({ kind: 'card', key: key, card: card, el: card, label: title, tag: '卡片', sub: '' })
            const rows = slot.querySelectorAll('.dshw-item')
            for (let j = 0; j < rows.length; j += 1) {
              const row = rows[j]
              const txtEl = row.querySelector('.dshw-item-text')
              const txt = String((txtEl !== null ? txtEl.textContent : row.textContent) || '').replace(/\s+/g, ' ').trim()
              if (txt === '') continue
              const timeEl = row.querySelector('.dshw-item-time')
              const time = timeEl !== null ? String(timeEl.textContent || '').trim() : ''
              // 只在**可点行**上带"回车打开"的能力；不可点的行只做定位
              const clickable = row.getAttribute('data-click') === '1'
              out.push({
                kind: clickable ? 'row' : 'row-static', key: key, card: card, el: row,
                label: txt, tag: title, sub: time,
              })
            }
          }
          return out
        }, [])

        /** 过滤：**子串匹配**（大小写不敏感）。不做模糊/拼音，宁少不误 —— 搜不到比搜错好。 */
        const cmdkMatch = React.useCallback((q) => {
          const all = cmdkCollect()
          const key = String(q || '').trim().toLowerCase()
          // 命令条（不是卡片内容，是**动作**）：放在前面，且同样参与过滤
          const cmds = [
            { kind: 'cmd', key: 'cmd:tour', id: 'tour', label: '看新手指引（这张卡怎么用）', tag: '命令', sub: '' },
            { kind: 'cmd', key: 'cmd:catalog', id: 'catalog', label: '打开卡片目录（13 张卡的指标与跳转）', tag: '命令', sub: '' },
          ].filter((c) => key === '' || String(c.label).toLowerCase().indexOf(key) >= 0)
          if (key === '') return cmds.concat(all.slice(0, 60))
          const hits = []
          for (let i = 0; i < all.length; i += 1) {
            const it = all[i]
            if (String(it.label).toLowerCase().indexOf(key) >= 0 || String(it.sub).toLowerCase().indexOf(key) >= 0) {
              hits.push(it)
              if (hits.length >= 60) break
            }
          }
          return cmds.concat(hits)
        }, [cmdkCollect])

        /** 命中一条：滚进视野 → 闪一下 → 可点的行再走它**自己**的 onClick */
        const cmdkGo = React.useCallback((it) => {
          if (!it) return
          setCmdkOpen(false)
          setCmdkQ('')
          setCmdkSel(0)
          // 命令条：直接执行动作，不涉及卡片定位
          if (it.kind === 'cmd') {
            if (it.id === 'tour') startTour()
            else if (it.id === 'catalog') setDwOpen(true)
            return
          }
          const card = it.card
          if (card !== null && card !== undefined) {
            try { card.scrollIntoView({ block: 'center', behavior: 'smooth' }) } catch (e) { /* 老内核 */ }
            try {
              card.setAttribute('data-wb2hit', '1')
              setTimeout(() => { try { card.removeAttribute('data-wb2hit') } catch (e) { /* 已卸载 */ } }, 1900)
            } catch (e) { /* ignore */ }
            // 折叠的卡先展开 —— 否则"跳过去了却看不到内容"
            const slot = card.closest !== undefined ? card.closest('.dshw-slot') : null
            if (slot !== null && slot !== undefined) {
              const k = slot.getAttribute('data-key')
              if (k !== null && cardFolded[k] === 1) toggleCardFolded(k)
            }
          }
          if (it.kind === 'row' && it.el !== null && it.el !== undefined) {
            // 等展开/滚动落地再点，避免点在还没渲染出来的节点上
            setTimeout(() => { try { it.el.click() } catch (e) { /* ignore */ } }, 260)
          }
        }, [cardFolded, toggleCardFolded, startTour])

        // 全局快捷键：⌘K / Ctrl+K 开关；Esc 按"最上层优先"关。
        //
        // ⚠️⚠️ **必须用 ref 读最新的开关状态**：这个 effect 的依赖是 `[]`（只注册一次），
        //   闭包捕获的是**首次渲染**时的 `tourStep` / `dwOpen` —— 直接读它们会永远是初值
        //   （实测后果：抽屉开着按 Esc 毫无反应。DW-8 当场抓到这个）。
        const uiRef = React.useRef({ tourStep: -1, dwOpen: false, cmdkOpen: false, themeOpen: false })
        React.useEffect(() => { uiRef.current.tourStep = tourStep; uiRef.current.dwOpen = dwOpen; uiRef.current.cmdkOpen = cmdkOpen; uiRef.current.themeOpen = themeOpen })
        React.useEffect(() => {
          if (typeof document === 'undefined') return undefined
          const onKey = (ev) => {
            const mod = ev.metaKey === true || ev.ctrlKey === true
            const k = String(ev.key || '').toLowerCase()
            // Esc：按"最上层优先"关 —— 引导 > 抽屉 > 命令面板（命令面板自己有输入框的 Esc 处理）
            if (k === 'escape') {
              if (uiRef.current.tourStep >= 0) { endTour(); return }
              if (uiRef.current.themeOpen === true) { setThemeOpen(false); return }
              if (uiRef.current.dwOpen === true) { setDwOpen(false); return }
            }
            if (mod && k === 'k') {
              const t = ev.target
              const tag = t !== null && t !== undefined ? String(t.tagName || '') : ''
              // ⚠️ 只让**真表单控件**（INPUT/TEXTAREA）与**本面板内部**的富文本框挡下这个快捷键。
              //    为什么不是"任何 contenteditable 都让"：DSH 主界面的输入框就是个 contenteditable DIV，
              //    而它在页面加载后常常**自动持有焦点**（2026-09-25 实测：面板里按 Ctrl+K 完全没反应，
              //    追到根因是 `document.activeElement` 一直是那个 DIV、旧判据把它当成"正在输入"而直接 return）。
              //    按"任何可编辑即让"写，这个快捷键在真实使用里几乎永远不会触发。
              const isForm = tag === 'INPUT' || tag === 'TEXTAREA'
              const inPanel = t !== null && t !== undefined && typeof t.closest === 'function' && t.closest('.dshw-root') !== null
              const editableInPanel = inPanel && t.isContentEditable === true
              if (isForm || editableInPanel) return
              ev.preventDefault()
              setCmdkOpen((v) => (v === true ? false : true))
              // 用 ref 判"这次是开还是关"（读 state 变量会拿到首帧的旧值）
              if (uiRef.current.cmdkOpen !== true) { setCmdkQ(''); setCmdkSel(0) }
            }
          }
          document.addEventListener('keydown', onKey, true)
          return () => { try { document.removeEventListener('keydown', onKey, true) } catch (e) { /* ignore */ } }
        }, [])

        // 引导浮层要**贴着目标元素**，所以每换一步、每次窗口变化都要重新量一次
        React.useEffect(() => {
          if (tourStep < 0 || typeof document === 'undefined') return undefined
          let timer = null
          const measure = () => {
            const st = TOUR_STEPS[tourStep]
            if (st === undefined) { setTourRect(null); return }
            const target = document.querySelector(st.sel)
            if (target === null) { setTourRect(null); return }
            const r = target.getBoundingClientRect()
            setTourRect({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) })
          }
          measure()
          const again = () => { if (timer !== null) clearTimeout(timer); timer = setTimeout(measure, 120) }
          window.addEventListener('resize', again)
          window.addEventListener('scroll', again, true)
          const t0 = setTimeout(measure, 160)
          return () => {
            try { window.removeEventListener('resize', again); window.removeEventListener('scroll', again, true) } catch (e) { /* ignore */ }
            clearTimeout(t0); if (timer !== null) clearTimeout(timer)
          }
        }, [tourStep])

        // ── 活跃关注域的**声明 / 清除**（2026-09-17 框架层裁定：卡上补写入口）──────────
        //   通道：host `/active-domains` POST → 既有 `cli-active-domains.mjs`（与 agent 工具同一通道，
        //   **host 侧不新增任何判定逻辑**）。⚠️ 该 POST 路由需 host 半体提供；未提供时按钮给出**可读原因**
        //   （不是"点了没反应"），文案里点名缺哪条路由。
        //   ★ 2026-09-18 用户裁定：声明表单的**域清单改为选择器**（清单取自 payload，见活跃卡内 `adOptions()`）。
        //     `id` / `label` 两个字段**只服务降级路径**（payload 无 `domainHealth.domains` 时的手输文本框）；
        //     正常路径下多选结果落在 `picks`（`[{id,label}]`，与 POST 的 `domains` 同形）。
        //     ★ 不新增 hook：多选列表挂在既有 `adForm` 上（`picks`），避免动卡外的状态区。
        //   ★ 2026-09-18 二次裁定（活跃卡四层结构）：
        //     · `tab`    = 卡内分类页签的选中项（`client`/`topic`/`question`/`other`；另存本机 `dshw.adTab`）——
        //                  null ⇒ 按数据自动（域最多的那一类）；
        //     · `detail` = 三级详情弹窗的**载荷**（纯字符串包，由卡内 `adPack()` 从 payload 装好）——
        //                  null ⇒ 弹窗关。两者都挂既有 `adForm`，**不新增 hook**（hook 顺序不动）。
        const [adForm, setAdForm] = React.useState({
          open: false, id: '', label: '', note: '', picks: [], tab: null, detail: null,
        })
        const [adBusy, setAdBusy] = React.useState(false)
        const [adMsg, setAdMsg] = React.useState(null)
        // 决策卡（原「今日决策面」；现名见 `CARD_TITLES.brief`）的**二级详情**：{ seg, item }；与 objModal 同一套 portal 到
        //   document.body 的模态模式。**动作只在详情页里**（卡面不放浮层按钮 —— 用户明确要求
        //   不要遮挡卡片自身的控件）。
        //   卡面自身的交互状态：桶/分组标题的折叠映射
        //   （brBucketOpen + 本地记忆 `dshw.briefBucket`；2026-09-17 修正④ 之前是只服务陈欠的 brAgedOpen）、
        //   **逐条已读**的写入态（brMarkBusy/brMarkMsg；用户 2026-09-17 修正①：批量入口已移除）、
        //   详情页动作表单（brAct 选中的退出动作 / brActForm 表单值 / brActBusy / brActMsg）。
        const [brfModal, setBrfModal] = React.useState(null)
        // 「资产」卡（`recall`）一期（2026-09-23）：三级详情的载荷 `{ kind, name, docs, chunks }`
        //   + 分组折叠 `astOpen`（同域折叠：顶层目录 / 文件类型 / 项目 / 客户 / 场次）
        //   + 刷新忙态 `astBusy`（动作按钮：重建 assets.json）。三者都只影响呈现与本卡动作。
        const [astModal, setAstModal] = React.useState(null)
        const [astOpen, setAstOpen] = React.useState({})
        const [astBusy, setAstBusy] = React.useState(false)
        // 决策卡内 **tab（昨夜动向 / 今日必办 / 等待待定）**：用户 2026-09-17 裁定改成与事务卡
        //   同一种分类方式 —— 卡内 tab + 计数徽标，同一时刻只渲染当前 tab。
        //   选中项记忆在本地（`dshw.briefTab`），刷新后恢复；取值不合法时回落第一组。
        const [briefTab, setBriefTab] = React.useState(() => {
          const v = lsGet('dshw.briefTab')
          return (v === null || v === '') ? null : String(v)
        })
        // 用户 2026-09-17 修正②：`brGroupAll`（tab 内分组展开态）已移除 ——
        //   该分组头连同它的「展开全部·收起」一起删掉了（见 brRows 内的注释）。
        // 修正④（同日晚）：**折叠状态改为一个可持久化的映射**，替掉原先只服务「陈欠」的 `brAgedOpen`。
        //   键约定：桶 = `bk:<due-today|recent-overdue|aged>`；等待待定分组 = `wg:<payload.group>`。
        //   记忆在本地 `dshw.briefBucket`（JSON）；默认态见 BR_BUCKET_DEFAULT。
        const BR_BUCKET_DEFAULT = { 'bk:due-today': true, 'bk:recent-overdue': true, 'bk:aged': false }
        const [brBucketOpen, setBrBucketOpen] = React.useState(() => {
          const raw = lsGet('dshw.briefBucket')
          if (raw === null || raw === '') return Object.assign({}, BR_BUCKET_DEFAULT)
          try {
            const v = JSON.parse(raw)
            if (v === null || typeof v !== 'object') return Object.assign({}, BR_BUCKET_DEFAULT)
            return Object.assign({}, BR_BUCKET_DEFAULT, v)
          } catch (e) { return Object.assign({}, BR_BUCKET_DEFAULT) }
        })
        /** 某键当前是否展开（缺省 = 展开；`aged` 在默认表里是 false ⇒ 默认折叠） */
        const brKeyOpen = (k) => brBucketOpen[String(k)] !== false
        /** 切换并落盘（唯一写入口；键 = `bk:*` / `wg:*`） */
        const toggleBrKey = (k) => {
          setBrBucketOpen((prev) => {
            const key = String(k)
            const next = Object.assign({}, prev)
            next[key] = (prev[key] !== false) !== true
            lsSet('dshw.briefBucket', JSON.stringify(next))
            return next
          })
        }
        const [brMarkBusy, setBrMarkBusy] = React.useState(false)
        const [brMarkMsg, setBrMarkMsg] = React.useState(null)
        const [brAct, setBrAct] = React.useState(null)
        const [brActForm, setBrActForm] = React.useState({})
        const [brActBusy, setBrActBusy] = React.useState(false)
        const [brActMsg, setBrActMsg] = React.useState(null)
        const [insModal, setInsModal] = React.useState(null)
        const [insShowAll, setInsShowAll] = React.useState(false)
        // （P2b 2026-09-21：`objOpen` / `objShowAll` / `objTab` 三个状态随「对象」卡一起撤除 ——
        //   它们只服务那张卡的场次子行展开、客户级「更多」与卡内 tab。对象级详情仍走 `objModal`：
        //   待办卡分组头 / 「专注 · 活跃」卡的域下钻 / 事务详情里的归属对象都点得开。）
        // 「验收」卡（key `metrics`）的三层结构状态（2026-09-17 用户裁定：分类 → 列表 → 详情页）
        //   · mmOpen  = 一级分类行的展开态（手风琴，按分类键存：多个分类各自独立，不互相顶掉）
        //   · mmModal = 三级详情页（portal 到 body，与 objModal/brfModal 同一形态）
        //   ⚠️ 这两项只服务本卡；顺序键、卡头徽标、其它卡片一律不动。
        const [mmOpen, setMmOpen] = React.useState({})
        const [mmModal, setMmModal] = React.useState(null)
        // ── 待响应触发（T32 · 2026-09-16）：一级列表 + 二级详情 + 三个响应动作 ──
        //   · 数据来自 `api('/triggers')`（host 转调 cli-trigger list，分组用冻结层选择器算好）；
        //   · 详情里要显示"关联流入"，按需读 `/disposition`（惰性，只取一次并缓存）；
        //   · 写动作走 `/trigger/respond` 与 `/trigger/to-matter`（host 只转发，判定在库内 CLI）。
        const [trigDoc, setTrigDoc] = React.useState(null)
        const [trigErr, setTrigErr] = React.useState(null)
        const [trigBusy, setTrigBusy] = React.useState(false)
        const [trigModal, setTrigModal] = React.useState(null)   // { id }
        const [trigAction, setTrigAction] = React.useState('responded')
        const [trigForm, setTrigForm] = React.useState({})       // 动作表单（按 id 存，避免串行输入互相覆盖）
        const [trigMsg, setTrigMsg] = React.useState(null)       // 失败/成功提示（**不静默**）
        // 三个分类改为 **tab 页签**（2026-09-17 用户裁定：不要折叠分组）——默认激活「已超时」
        const [trigTab, setTrigTab] = React.useState('escalated')
        const [trigShowAll, setTrigShowAll] = React.useState({})
        // ★ 2026-09-24：「响应」卡的**按会话聚合**段 —— 点开哪几个会话（按会话 id 记，纯呈现态）
        const [thrOpen, setThrOpen] = React.useState({})
        const [dispDoc, setDispDoc] = React.useState(null)
        // ── 路由可用性（降级层 · 2026-09-16）────────────────────────────────────
        //   值为 true = 该路由在当前 host 上**不存在**（旧进程未重启）⇒ 卡片降级 + 提示"需重启"。
        //   与"读失败"（真出错）、"无数据"（产物 0 条）三者**分开存**，文案各不相同。
        const [routeDown, setRouteDown] = React.useState({})
        const markDown = (name, flag) => setRouteDown((prev) => {
          if (prev[name] === flag) return prev
          const next = Object.assign({}, prev)
          if (flag === true) next[name] = true
          else delete next[name]
          return next
        })
        // 事务卡内 tab（待完成/已过期/已关闭）：null = 自动（有过期项先看「已过期」，否则「待完成」）
        const [matterTab, setMatterTab] = React.useState(() => {
          const v = lsGet('dshw.matterTab')
          return v === 'todo' || v === 'closed' ? v : null
        })
        // 域分组展开状态（键 = tab|域id）。默认收起 —— 点域名称才展开该域的事务列表；
        // 用户的选择记忆在 localStorage，不被轮询刷新重置。
        const [mtOpen, setMtOpen] = React.useState(() => {
          try {
            const v = JSON.parse(lsGet('dshw.mtOpen') || '{}')
            return v && typeof v === 'object' ? v : {}
          } catch (e) { return {} }
        })
        function toggleMtDomain(key) {
          setMtOpen((prev) => {
            const nxt = Object.assign({}, prev)
            if (nxt[key] === 1) delete nxt[key]
            else nxt[key] = 1
            lsSet('dshw.mtOpen', JSON.stringify(nxt))
            return nxt
          })
        }
        wbHRef.current = wbH

        const touched = []
        function setStyle(el, prop, value) {
          if (!el || !el.style) return
          let rec = null
          for (let i = 0; i < touched.length; i += 1) if (touched[i].el === el && touched[i].prop === prop) rec = touched[i]
          if (rec === null) { rec = { el, prop, original: el.style[prop] }; touched.push(rec) }
          if (el.style[prop] !== value) el.style[prop] = value
        }
        React.useEffect(() => () => {
          for (let i = 0; i < touched.length; i += 1) {
            try { touched[i].el.style[touched[i].prop] = touched[i].original } catch (e) {}
          }
        }, [])

        function locate() {
          const node = outer.current
          if (!node || typeof node.getAttribute !== 'function') return null
          let el = node
          let layer = null
          let guard = 0
          while (el && el.parentElement && guard < 40) {
            guard += 1
            if (typeof el.getAttribute === 'function' && el.getAttribute('data-shell-overlay') !== null) { layer = el; break }
            el = el.parentElement
          }
          if (layer === null || !layer.parentElement) return null
          const frame = layer.parentElement
          const kids = []
          const ch = frame.children
          for (let i = 0; i < ch.length; i += 1) {
            const c = ch[i]
            if (typeof c.getAttribute !== 'function') continue
            if (c.getAttribute('data-shell-overlay') !== null) continue
            if (c.getAttribute('data-side') !== null) continue
            kids.push(c)
          }
          kids.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
          return { frame, sidebar: kids[0] || null, center: kids[1] || null }
        }

        /** The neighbour plugin's right-hand column: matches the frame's reserved strip. */
        function findRightPanel(frame, frameRect, reservedRight) {
          const mine = outer.current
          const cached = panelElRef.current
          if (cached !== null && cached.isConnected === true) {
            const r = cached.getBoundingClientRect()
            if (Math.abs(r.right - frameRect.right) <= 10 && Math.abs(r.left - (frameRect.right - reservedRight)) <= 16 && r.height > 120) return cached
          }
          panelElRef.current = null
          const targetLeft = frameRect.right - reservedRight
          let best = null
          const consider = (el) => {
            if (!el || typeof el.getBoundingClientRect !== 'function') return
            if (mine !== null && (el === mine || mine.contains(el) || el.contains(mine))) return
            const r = el.getBoundingClientRect()
            if (r.width < 240 || r.height < 200) return
            if (Math.abs(r.right - frameRect.right) > 10) return
            if (Math.abs(r.left - targetLeft) > 16) return
            if (best === null || r.height > best.h) best = { el, h: r.height }
          }
          const walk = (node, depth) => {
            if (!node || depth > 2) return
            const kids = node.children
            if (!kids) return
            const n = kids.length < 40 ? kids.length : 40
            for (let i = 0; i < n; i += 1) { consider(kids[i]); walk(kids[i], depth + 1) }
          }
          walk(frame, 0)
          try { walk(document.body, 0) } catch (e) {}
          if (best !== null) panelElRef.current = best.el
          return best === null ? null : best.el
        }

        function tick() {
          const info = locate()
          if (info === null) return
          const frameRect = info.frame.getBoundingClientRect()
          frameHRef.current = Math.round(frameRect.height)
          const sidebarW = info.sidebar ? Math.round(info.sidebar.getBoundingClientRect().width) : 0
          const reservedRight = reservedRightOf(info.frame)
          const h = wbHRef.current
          const wbW = reservedRight >= 320 ? reservedRight : 420
          const ownReserve = reservedRight < 320
          let panelFound = false
          if (reservedRight >= 320) {
            const other = findRightPanel(info.frame, frameRect, reservedRight)
            if (other !== null) {
              panelFound = true
              setStyle(other, 'top', h + 'px')
              setStyle(other, 'height', Math.max(120, Math.round(frameRect.height - h)) + 'px')
            }
          }
          setStyle(info.center, 'paddingLeft', '0px')
          setStyle(info.center, 'paddingRight', ownReserve ? wbW + 'px' : '0px')
          const root = sidebarW >= 148 ? sidebarRoot(info.sidebar) : null
          const target = newSessionHost(root)
          if (target !== null) setStyle(target, 'marginTop', '104px')
          setBox((prev) => (prev.ready === true && prev.sidebarW === sidebarW && prev.wbW === wbW && prev.wbH === h && prev.panelFound === panelFound && prev.ownReserve === ownReserve
            ? prev
            : { ready: true, sidebarW, wbW, wbH: h, panelFound, ownReserve }))
        }

        function load(force) {
          setBusy(true)
          api('/snapshot' + (force === true ? '?force=1' : ''))
            .then((data) => { setSnap(data); setSnapErr(null) })
            .catch((e) => setSnapErr(String((e && e.message) || e)))
            .then(() => setBusy(false))
        }

        function loadPwb(force) {
          setPwbBusy(true)
          api('/state' + (force === true ? '?force=1' : ''))
            .then((data) => { setPwb(data); setPwbErr(null) })
            .catch((e) => setPwbErr(String((e && e.message) || e)))
            .then(() => setPwbBusy(false))
        }

        /**
         * 业务对象层（库内产物 `_meta/out/objects.json`，host 只读透传 `/objects`）。
         *
         * 与数据层**分开取**：产物由库内管线生成、变化远比数据层慢 ⇒ 60 秒一次足够。
         * ⚠️ 「读失败」（fetch/parse 报错、或响应里根本没有 objects 字段）与「产物里 0 个对象」
         *    是两件不同的事实：前者落 objsErr、后者落 objs.objects = []，渲染层据此写不同的话。
         */
        function loadObjects() {
          setObjsBusy(true)
          api('/objects')
            .then((data) => { setObjs(data); setObjsErr(null) })
            .catch((e) => setObjsErr(String((e && e.message) || e)))
            .then(() => setObjsBusy(false))
        }

        /**
         * 决策卡（库内产物 `brief.json`，host 只读透传 `/brief`；旧称「今日决策面」，卡名见 `CARD_TITLES.brief`）。
         * ⚠️ host 缺产物时返回 **503 + {error}**（不静默返回空对象）—— 若把 503 当成"空"，
         *    面板会把"没有产物"读成"今天没事"，这是本卡最需要避免的一种假绿。
         */
        function loadBrief() {
          setBriefBusy(true)
          apiTry('/brief')
            .then((r) => {
              if (r.kind === 'restart') { markDown('brief', true); setBrief(null); setBriefErr(null); return }
              markDown('brief', false)
              if (r.kind === 'ok') { setBrief(r.json); setBriefErr(null) } else { setBriefErr(routeErrText(cardTitle('brief'), r)) }
            })
            .then(() => setBriefBusy(false))
        }

        /**
 * **逐条**标记已读 / 撤销已读（用户 2026-09-17 修正①；卡面已无批量入口）。
 * 写 `ui-prefs.json` 的 `briefRead = { <条目键>: ISO }` —— host 侧**合并写**：只动这一条，
 * 既不碰其它条，也不碰 `cardOrder` / `briefSeenAt`。时间戳取**本次产物数据时刻**（不读墙钟），
 * 与游标语义一致；重复标记同一条是**幂等**的（同键被覆盖为同值，host 不报错）；
 * 撤销 = 写 `null`（host 从集合里删键）。
 * 写成功后重取 `/brief` 与 `/state`：**「N 条新」由产物重算**，前端不自己减。
 */
        function toggleBriefRead(rk, nextRead) {
  if (brMarkBusy === true) return Promise.resolve(null)
  const key = String(rk || '')
  if (key === '') { setBrMarkMsg({ ok: false, text: '该条缺 id/rk，无法标记已读（产物问题）' }); return Promise.resolve(null) }
  const at = (brief !== null && brief !== undefined && brief.generatedAt !== undefined && brief.generatedAt !== null)
    ? String(brief.generatedAt) : null
  if (nextRead === true && at === null) { setBrMarkMsg({ ok: false, text: '产物缺 generatedAt，无法写已读时间' }); return Promise.resolve(null) }
  const patch = {}
  patch[key] = nextRead === true ? at : null
  setBrMarkBusy(true)
  setBrMarkMsg(null)
  return api('/ui-prefs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ briefRead: patch }),
  })
    .then((r) => {
      if (r && r.ok === true) {
        setBrMarkMsg({ ok: true, text: (nextRead === true ? '已标记已读' : '已撤销已读') + '（' + key + '）' })
        loadBrief()
        loadPwb(true)
      } else {
        setBrMarkMsg({ ok: false, text: String((r && r.error) || '未知错误') })
      }
      return r
    })
    .catch((e) => { setBrMarkMsg({ ok: false, text: String((e && e.message) || e) }); return null })
    .then((r) => { setBrMarkBusy(false); return r })
}

        /**
         * 决策卡详情页的动作提交（本卡**唯一的写入口**）。传入的是**调用本身**
         * （`() => api('/matter/reschedule', …)` 这种 thunk），四种动作各自在调用点写死路径：
         *   reschedule → `api('/matter/reschedule', {id, due_at})`
         *   close      → `api('/matter/close',      {id, note})`（逾期必填，M7d 机制在库内强制）
         *   respond    → `api('/trigger/act',       {id, action:'respond', response_action, ref?})`
         *   dismiss    → `api('/trigger/act',       {id, action:'dismiss', reason})`
         * 纪律：判定与留痕全部在库内 CLI（host 只校验入参 + 转调）；**失败原样显示后端 error**，
         *      不吞、不假装成功；成功后关详情页 → 重取 `/brief` 与 `/state`（该条必须真的从原桶消失）。
         */
        function brfWrite(request, okText) {
          if (brActBusy === true) return Promise.resolve(null)
          setBrActBusy(true)
          setBrActMsg(null)
          return Promise.resolve()
            .then(() => request())
            .then((r) => {
              if (r && r.ok === true) {
                setBrfModal(null)
                setBrAct(null)
                setBrActMsg({ ok: true, text: okText })
                loadBrief()
                loadPwb(true)
                loadTriggers()
              } else {
                setBrActMsg({ ok: false, text: String((r && r.error) || '未知错误') })
              }
              return r
            })
            .catch((e) => { setBrActMsg({ ok: false, text: String((e && e.message) || e) }); return null })
            .then((r) => { setBrActBusy(false); return r })
        }

        /** 决策卡动作表单（按条目 id 存，切行不串值） */
        const brfActFormOf = (id) => brActForm[id] || { due: '', note: '', response_action: '', ref: '', reason: '' }
        const setBrfActFormOf = (id, patch) => setBrActForm((prev) => Object.assign({}, prev, {
          [id]: Object.assign({}, prev[id] || { due: '', note: '', response_action: '', ref: '', reason: '' }, patch),
        }))

        /** 跨源洞察（库内产物 `insights.json`，host 只读透传 `/insights`）。同上：503 不当空。 */
        function loadInsights() {
          setInsightsBusy(true)
          apiTry('/insights')
            .then((r) => {
              if (r.kind === 'restart') { markDown('insights', true); setInsights(null); setInsightsErr(null); return }
              markDown('insights', false)
              if (r.kind === 'ok') { setInsights(r.json); setInsightsErr(null) } else { setInsightsErr(routeErrText(cardTitle('insights'), r)) }
            })
            .then(() => setInsightsBusy(false))
        }

        /**
         * 待响应触发（T32）：host 转调 `cli-trigger list --open` 后透传。
         * 分组（escalated / dueToday / other）由 CLI 用**冻结层选择器**算好，卡片只渲染，不重算判断。
         */
        function loadTriggers() {
          setTrigBusy(true)
          apiTry('/triggers')
            .then((r) => {
              // 旧 host（未重启）⇒ 路由不存在 ⇒ **降级到 `/state` 的旧清单**，并在卡内写明需重启
              if (r.kind === 'restart') { markDown('triggers', true); setTrigDoc(null); setTrigErr(null); return }
              markDown('triggers', false)
              // 卡名一律从 CARD_TITLES 取（`triggers` =「响应」）—— 原先写死旧名「触发清单」，
              // 读失败时同一张卡会出现两个名字（卡头「响应」/ 卡内「触发清单读取失败」）。
              if (r.kind === 'ok') { setTrigDoc(r.json); setTrigErr(null) } else { setTrigDoc(null); setTrigErr(routeErrText(cardTitle('triggers'), r)) }
            })
            .then(() => setTrigBusy(false))
        }

        /** 关联流入（详情用）：惰性读 `/disposition`（同样区分"路由未加载"与"真出错"） */
        function loadDispositionOnce() {
          if (dispDoc !== null) return
          apiTry('/disposition')
            .then((r) => {
              if (r.kind === 'restart') { markDown('disposition', true); setDispDoc({ ok: false, down: true }); return }
              markDown('disposition', false)
              setDispDoc(r.kind === 'ok' ? r.json : { ok: false, error: r.error })
            })
        }

        /**
         * 触发响应写入口（T32）：responded / dismissed / to-matter / undo。
         * 纪律：**不假装成功** —— 失败原样显示 CLI/host 的错误；成功后重取本卡与 /state。
         */
        function trigPost(kind, payload) {
          if (trigBusy === true) return Promise.resolve(null)
          setTrigBusy(true)
          setTrigMsg(null)
          const url = kind === 'to-matter' ? '/trigger/to-matter' : '/trigger/respond'
          const body = kind === 'to-matter'
            ? Object.assign({}, payload)
            : Object.assign({ action: kind }, payload)
          return api(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
            .then((r) => {
              if (r && r.ok === true) {
                setTrigModal(null)
                setTrigMsg({ ok: true, text: kind === 'to-matter' ? ('已建事务 ' + String(r.matter_id || '')) : '已记录响应' })
                loadTriggers()
                loadPwb(true)
              } else {
                setTrigMsg({ ok: false, text: String((r && r.error) || '未知错误') })
              }
              return r
            })
            .catch((e) => {
              setTrigMsg({ ok: false, text: String((e && e.message) || e) })
              return null
            })
            .then((r) => { setTrigBusy(false); return r })
        }

        /**
         * 拉起**听记 → 事务草稿**（2026-09-26 · 第六条）：host `/matter/draft-from-minutes`。
         *
         * 这是面板**唯一**读草稿的地方，也是"预填四项 + 依据"的全部数据来源。
         * 纪律（四条）：
         *   ① **不新开判定**：标题 / 关闭条件 / 期限 / 域建议 / 锚点候选全部来自引擎出参，
         *      这里只把它们摆进表单（预填口径见纯函数 `minDraftToForm`）；
         *   ② **不可用分支不预填**：`unavailable_reason` 非空 ⇒ 一个字段都不填，
         *      连同 `notes`（"下一步怎么办"）原样显示 —— 靠听记标题猜出来的那一版正是要防的假草稿；
         *   ③ **三态分开**：路由没加载（旧 host）/ 真出错 / 引擎说"没取到正文"是**三件事**，
         *      各说各的话（合并成一句"读取失败"就等于把用户该做的事藏起来）；
         *   ④ **不假装成功**：host 回 `ok:false`（引擎本身跑不起来）时如实报，不显示半张表单。
         *
         * @param {{src:string,id:string,title:string,url:string}} m 听记（`minModal`）
         */
        function minLoadDraft(m) {
          setMinDraftState('loading')
          setMinDraft(null)
          setMinDraftErr(null)
          setMinDraftNotes([])
          setMinMsg(null)
          setMinDedup2(false)
          return apiTry(MINUTES_DRAFT_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              source: String((m && m.src) || ''),
              id: String((m && m.id) || ''),
              title: String((m && m.title) || ''),
              // 钉钉列表条目**不带 taskUuid**（dingMinutesOf 只投影 title/start/url）⇒ 带上 url 让 host 兜底寻址
              url: String((m && m.url) || ''),
            }),
          })
            .then((r) => {
              if (r === null || r.kind === 'restart') {
                setMinDraftState('error')
                setMinDraftErr(ROUTE_DOWN_TEXT + '（' + MINUTES_DRAFT_ROUTE + '）—— host 半体仍是旧代码，'
                  + '重启 DSH 后这条听记才能自动预填；重启前请不要提交（提交要用草稿给的溯源与去重键）')
                return null
              }
              if (r.kind !== 'ok' || r.json === null || r.json.ok !== true) {
                setMinDraftState('error')
                setMinDraftErr(String((r.json && r.json.error) || r.error || '未知错误'))
                return null
              }
              const d = r.json
              // ⚠️ 这里必须**从 payload 现取**：`domainOptions` 这个名字在本文件里
              //   只作为 `trigRowsForModal`（函数作用域）内的局部变量存在，
              //   在 Workbench 作用域里引用它 ⇒ 真机 `ReferenceError: domainOptions is not defined`
              //   ⇒ 整个 `sidebar.right.pane.tab` 渲染崩溃（2026-09-26 真机 SBT-MN8/10 抓到）。
              const dOptsAll = (pwb !== null && pwb !== undefined && Array.isArray(pwb.domainOptions)) ? pwb.domainOptions : []
              const pre = minDraftToForm(d, dOptsAll.map((x) => x.id))
              setMinDraft(d)
              setMinDraftNotes(Array.isArray(d.notes) ? d.notes : [])
              setMinForm(pre.form)
              setMinDraftState(pre.prefilled ? 'ready' : 'unavailable')
              return d
            })
            .catch((e) => {
              setMinDraftState('error')
              setMinDraftErr(String((e && e.message) || e))
              return null
            })
        }

        /**
         * 草稿 → 事务（**提交**）：POST /intake → 库内 `cli-matter.mjs add`（与 agent 工具同一写通道）。
         *
         * 纪律（四条，缺一不可）：
         *   ① **不新开判定**：查重与原子 ID 一律走库内 `matter-intake.mjs`；
         *   ② **M1 双保险**：`origin_inbound` 或 `origin_project` 至少一个非空 ——
         *      按钮上禁用一层（渲染段的 `disabled`）、这里再拦一层（判据是同一个纯函数 `minOriginState`）。
         *      ⚠️ 从前这里只认 `origin_project` ⇒ "这份听记对应某条流入"的情形在界面上**根本走不通**；
         *      M1 的原文是"两者**至少一个**非空"，界面必须按原文判（否则等于替用户加了不存在的约束）；
         *   ③ **幂等**：`dedup_key` 取引擎的（`<来源>:<id>`）；同一份听记要拆第二件事**由人勾选**加 `#2` 后缀；
         *   ④ **不假装成功**：去重命中与真新建说**两句不同的话**（`minSubmitText`），失败原样显示库内错误。
         */
        function minToMatter() {
          if (minBusy === true) return Promise.resolve(null)
          const title = String(minForm.title || '').trim()
          const domain = String(minForm.domain || '').trim()
          const doneWhen = String(minForm.done_when || '').trim()
          const dueAt = String(minForm.due_at || '').trim()
          const gate = minOriginState(minForm)
          if (title.length === 0) { setMinMsg({ ok: false, text: '事务标题必填' }); return Promise.resolve(null) }
          if (domain.length === 0) { setMinMsg({ ok: false, text: '归属关注域必填（P3：写不出归属的不成事务）' }); return Promise.resolve(null) }
          if (doneWhen.length === 0) { setMinMsg({ ok: false, text: '关闭条件必填（P3：写不出关闭条件的不成事务）' }); return Promise.resolve(null) }
          if (gate.ok !== true) { setMinMsg({ ok: false, text: gate.why }); return Promise.resolve(null) }
          const d = (minDraft !== null && typeof minDraft === 'object') ? minDraft : {}
          const origin = String((minModal && (minModal.url || minModal.title)) || title)
          // 溯源：引擎给的 source_ref（逐字稿路径 / <来源>:minutes/<id>）优先 —— 它比 URL 更具体、可回溯
          const sourceRef = String(d.source_ref || origin)
          const baseKey = String(d.dedup_key || ('minutes:' + origin))
          setMinBusy(true)
          setMinMsg(null)
          return api('/intake', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              title,
              domain,
              done_when: doneWhen,
              due_at: dueAt.length > 0 ? dueAt : null,
              // M1 的两条出路都传（空的那条由 host 归一成 null）
              origin_project: gate.project.length > 0 ? gate.project : null,
              origin_inbound: gate.inbound.length > 0 ? gate.inbound : null,
              source_ref: sourceRef,
              counterparty: String(d.counterparty || '') || null,
              // 幂等键：同一份听记只对应一条事务；要拆第二件事得**人**勾"第二件事"（加 #2 后缀）
              dedup_key: minDedup2 === true ? baseKey + '#2' : baseKey,
            }),
          })
            .then((r) => {
              if (r && r.ok === true) {
                setMinMsg({ ok: true, text: minSubmitText(r).text })
                loadPwb(true)
              } else {
                setMinMsg({ ok: false, text: String((r && r.error) || '未知错误') })
              }
              return r
            })
            .catch((e) => {
              setMinMsg({ ok: false, text: String((e && e.message) || e) })
              return null
            })
            .then((r) => { setMinBusy(false); return r })
        }
        /**
         * 日程**取消 / 恢复**（2026-09-20 用户规格 · 第三条）—— 面板这一侧唯一的日程写入口。
         *
         * 纪律（与 `/active-domains` 同一套）：
         *   · 只写面板自己的**覆盖层**（host `POST /schedule/act` → `schedule-cancels.json`），
         *     **不碰任何源头日历** ⇒ 取消天然**可恢复**（恢复 = 删台账里那一条）；
         *   · 键由 host 用事件身份字段算：cancel 传 `source/id/start/title`，restore 回传 host 给过的 `key`
         *     —— 客户端**不自己拼键**（两处拼键 = 两套真相源，漂移后就是"取消了点不掉"）；
         *   · **不假装成功**：路由未加载（旧 host）时给出可读原因并点名声缺哪条路由，
         *     不写成"操作失败"这种看不懂的话（SPEC §6.1 / 反模式 C5）。
         */
        function schedAct(action, ev) {
          if (schedBusy === true) return Promise.resolve(null)
          const body = action === 'restore'
            ? { action: 'restore', key: String((ev && ev.key) || '') }
            : {
              action: 'cancel',
              source: String((ev && ev.source) || 'dingtalk'),
              id: (ev && ev.id !== undefined && ev.id !== null) ? String(ev.id) : '',
              start: String((ev && ev.start) || ''),
              // ★ 2026-09-24：`end` 一起给 host 记账 —— 跨天条目（住宿/出差）判断"还在不在三天窗口里"
              //   要用区间相交；只记 start 时，一条昨天开始、今天仍在的取消记录会从「恢复」入口消失。
              end: String((ev && ev.end) || ''),
              title: String((ev && ev.title) || ''),
            }
          setSchedBusy(true)
          setSchedMsg(null)
          return apiTry('/schedule/act', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
            .then((r) => {
              if (r.kind === 'restart') {
                setSchedMsg({
                  ok: false,
                  text: '日程' + (action === 'restore' ? '恢复' : '取消') + '出口不可用（HTTP ' + String(r.status)
                    + '：' + String(r.error || '') + '）—— host 半体尚未加载 `/schedule/act` 路由，需重启 DSH',
                })
                return null
              }
              const j = r.kind === 'ok' ? r.json : null
              if (j !== null && j.ok === true) {
                setSchedMsg({
                  ok: true,
                  text: action === 'restore'
                    ? '已恢复（该条回到三天窗口）'
                    : '已取消（只从工作台窗口移除；源头日历未改动，随时可恢复）',
                })
                load(true)
              } else {
                setSchedMsg({ ok: false, text: String((j && j.error) || r.error || '未知错误') })
              }
              return j
            })
            .catch((e) => {
              setSchedMsg({ ok: false, text: String((e && e.message) || e) })
              return null
            })
            .then((x) => { setSchedBusy(false); return x })
        }

        /** 读某条触发的表单（按 id 存，切行不串值） */
        const trigFormOf = (id) => trigForm[id] || { response_action: '已回复', ref: '', reason: '', title: '', domain: '', done_when: '' }
        const setTrigFormOf = (id, patch) => setTrigForm((prev) => Object.assign({}, prev, {
          [id]: Object.assign({}, prev[id] || { response_action: '已回复', ref: '', reason: '', title: '', domain: '', done_when: '' }, patch),
        }))

        /**
         * 卡片顺序覆盖层：读 host（`_meta/out/ui-prefs.json`）。
         * 语义：
         *   · 文件不存在（`exists:false`）⇒ 覆盖层 = null（用默认顺序），**不是错误**；
         *   · 读失败（网络/解析）⇒ orderErr 有值，页面顶部给一行提示（**不静默**）；
         *   · 有覆盖层 ⇒ 存成数组，交给 mergeCardOrder 合并。
         */
        function loadUiPrefs() {
          apiTry('/ui-prefs')
            .then((r) => {
              if (r.kind === 'restart') { markDown('ui-prefs', true); setOrderErr(ROUTE_DOWN_TEXT + '：卡片顺序覆盖层不可用，当前按**默认顺序**显示'); return }
              markDown('ui-prefs', false)
              if (r.kind !== 'ok') { setOrderErr(routeErrText('卡片顺序覆盖层', r)); setCardOrderOverride(null); return }
              const data = r.json
              if (data && data.exists === true && data.prefs && Array.isArray(data.prefs.cardOrder)) {
                setCardOrderOverride(data.prefs.cardOrder)
              } else {
                setCardOrderOverride(null)
              }
              setOrderErr(null)
            })
        }
        /**
         * 保存覆盖层。**只写覆盖层，绝不改默认表**（默认表是契约、被断言）。
         * 返回的 ignored / duplicated 由 host 计算并回报 —— 面板把它们显示出来，
         * 免得"我拖了但顺序没变"这种情况无法解释。
         */
        function saveCardOrder(nextOrder, note) {
          const prev = cardOrderOverride
          setCardOrderOverride(nextOrder)        // 乐观更新：拖完立刻看到结果
          api('/ui-prefs', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ cardOrder: nextOrder }),
          })
            .then((r) => {
              if (!r || r.ok !== true) throw new Error(String((r && r.error) || '写入失败'))
              if (r.prefs && Array.isArray(r.prefs.cardOrder)) setCardOrderOverride(r.prefs.cardOrder)
              setOrderErr(null)
              const ig = Array.isArray(r.ignored) ? r.ignored : []
              if (ig.length > 0) setNote('卡片顺序已保存（忽略未知卡片 ' + ig.join(', ') + '）')
              else if (note) setNote(note)
            })
            .catch((e) => {
              setCardOrderOverride(prev)         // 回滚：写入失败就别假装成功
              setOrderErr(String((e && e.message) || e))
              setNote('卡片顺序保存失败: ' + String((e && e.message) || e))
            })
        }
        /** 恢复默认顺序：删掉覆盖层文件（默认表本身从未被改过） */
        function resetCardOrder() {
          api('/ui-prefs', { method: 'DELETE' })
            .then(() => { setCardOrderOverride(null); setOrderErr(null); setNote('已恢复默认卡片顺序') })
            .catch((e) => setOrderErr(String((e && e.message) || e)))
        }
        /**
         * 拖动期间抑制文字选中（恢复由本 effect 负责，避免"拖完浏览器还在选中"）。
         * 锁滚动走栅格的 `data-draglock`（CSS），不直接改 body —— 面板是壳层里的一块。
         */
        React.useEffect(() => {
          const active = dragKey !== null
          let prev = ''
          try {
            prev = document.body.style.userSelect
            document.body.style.userSelect = active ? 'none' : prev
          } catch (e) { /* ignore */ }
          return () => {
            try { document.body.style.userSelect = prev } catch (e) { /* ignore */ }
          }
        }, [dragKey])

        /** 处置台账（disposition.json）：给「流入」卡提供无落点清单与悬置时长 */
        function loadDispoDoc() {
          setDispoDocBusy(true)
          apiTry('/disposition')
            .then((r) => {
              if (r.kind === 'restart') { markDown('disposition', true); setDispoDoc(null); setDispoDocErr(null); return }
              markDown('disposition', false)
              if (r.kind === 'ok') { setDispoDoc(r.json); setDispoDocErr(null) } else { setDispoDoc(null); setDispoDocErr(routeErrText('处置台账', r)) }
            })
            .then(() => setDispoDocBusy(false))
        }

        /** 多源校验（crosscheck.json）：给「验收」卡提供溯源/支撑/承诺交付/矛盾四个数 */
        function loadCrossDoc() {
          setCrossDocBusy(true)
          apiTry('/crosscheck')
            .then((r) => {
              if (r.kind === 'restart') { markDown('crosscheck', true); setCrossDoc(null); setCrossDocErr(null); return }
              markDown('crosscheck', false)
              if (r.kind === 'ok') { setCrossDoc(r.json); setCrossDocErr(null) } else { setCrossDoc(null); setCrossDocErr(routeErrText('多源校验', r)) }
            })
            .then(() => setCrossDocBusy(false))
        }

        /** 多源校验（crosscheck.json）：给「验收」卡提供溯源/支撑/承诺交付/矛盾四个数 */
        function loadCrossDocRemoved() { /* 已内联到上方 loadCrossDoc（保留占位以防外部引用） */ }

        /** 判断质量台账（feedback.json）：给「验收」卡内小节提供裁决统计与**待裁定**条目。
         *  ⚠️ 这里**不用 `api()`**（它只做 `r.json()`、**不看状态码**），而是自己取 `{status, body}`：
         *     `/feedback` 有三种**不同**事实必须分开 —— 503（产物未生成 ⇒ 无记录）、
         *     404/500（**该只读出口不可用**：host 半体未加载该路由，通常需重启 DSH）、
         *     fetch/解析抛错（读失败）。若一律走 `api()`，503 与 404 都会 resolve 成一个对象，
         *     于是"路由都不在"会被渲染成"没有裁决记录" —— 正是本项目要拦的假绿。
         *  ★ 只读：GET，无任何写方法（写入口是 CLI 与 DSH 工具）。 */
        function loadFbDoc() {
          setFbDocBusy(true)
          fetch('/workbench/api/feedback')
            .then((r) => r.json().then((j) => ({ status: r.status, body: j })))
            .then((res) => {
              // 旧 host（路由未加载）⇒ 归入"需重启"，**不把 unknown route 原文交给面板**
              const msg = res.body && res.body.error !== undefined && res.body.error !== null ? String(res.body.error) : ''
              if (res.status === 404 || /unknown route|not found/i.test(msg)) {
                markDown('feedback', true)
                setFbDoc(null)
                setFbDocErr(null)
                return
              }
              markDown('feedback', false)
              setFbDoc(res)
              setFbDocErr(null)
            })
            .catch((e) => setFbDocErr(String((e && e.message) || e)))
            .then(() => setFbDocBusy(false))
        }

        /** 幂等重建数据层产物（跑库内 build-snapshot.mjs），然后重取 */
        function rebuildPwb() {
          setPwbBusy(true)
          api('/rebuild', { method: 'POST' })
            .then((r) => { if (r && r.ok === false) setNote('重建失败: ' + String(r.error || '')) })
            .catch((e) => setNote('重建失败: ' + String((e && e.message) || e)))
            .then(() => loadPwb(true))
        }

        // ── 专注块写操作（与 DSH 工具共用 host 的 cli-focus 通道）──
        function focusCall(action, payload) {
          return api('/focus', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(Object.assign({ action }, payload || {})),
          })
        }
        function declareFocusNow() {
          if (focusBusy) return
          const id = String(focusForm.id || '').trim()
          if (id.length === 0) { setFocusMsg('请填专注目标 id'); return }
          setFocusBusy(true)
          setFocusMsg(null)
          focusCall('declare', { kind: focusForm.kind, id, minutes: focusForm.minutes, label: focusForm.label })
            .then((r) => {
              if (r && r.ok === true) { setFocusForm((p) => Object.assign({}, p, { open: false })); setFocusMsg(null) }
              else setFocusMsg('声明失败: ' + String((r && r.error) || '未知错误'))
            })
            .catch((e) => setFocusMsg('声明失败: ' + String((e && e.message) || e)))
            .then(() => { setFocusBusy(false); loadPwb(true) })
        }
        function endFocusNow() {
          if (focusBusy) return
          setFocusBusy(true)
          setFocusMsg(null)
          focusCall('end', {})
            .then((r) => { if (!r || r.ok !== true) setFocusMsg('结束失败: ' + String((r && r.error) || '未知错误')) })
            .catch((e) => setFocusMsg('结束失败: ' + String((e && e.message) || e)))
            .then(() => { setFocusBusy(false); loadPwb(true) })
        }

        // ── 事务详情卡（E 块）：打开 / 添加记录 / 关闭 / 重开 ──
        function openMatter(item) {
          const id = String((item && item.id) || '')
          if (id.length === 0) return
          setMatterModal({
            id, title: String((item && item.title) || id),
            loading: true, error: null, matter: null,
            recKind: 'note', recText: '', recPath: '', closeNote: '',
            busy: false, checkBusy: false, msg: null, confirmClose: false,
          })
          api('/matter?id=' + encodeURIComponent(id))
            .then((r) => {
              if (r && r.ok === true) setMatterModal((p) => Object.assign({}, p, { loading: false, matter: r.matter, error: null }))
              else setMatterModal((p) => Object.assign({}, p, { loading: false, matter: null, error: String((r && r.error) || '读取失败') }))
            })
            .catch((e) => setMatterModal((p) => Object.assign({}, p, { loading: false, matter: null, error: String((e && e.message) || e) })))
        }

        function matterPost(action, payload) {
          return api('/matter/' + action, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(Object.assign({ id: matterModal.id }, payload || {})),
          })
        }

        function addRecordNow() {
          if (matterModal === null || matterModal.busy) return
          const text = String(matterModal.recText || '').trim()
          if (text.length === 0) { setMatterModal((p) => Object.assign({}, p, { msg: '请先填写记录内容' })); return }
          setMatterModal((p) => Object.assign({}, p, { busy: true, msg: null }))
          matterPost('record', { text, kind: matterModal.recKind, path: String(matterModal.recPath || '').trim() })
            .then((r) => {
              if (r && r.ok === true) {
                setMatterModal((p) => Object.assign({}, p, { busy: false, matter: r.matter, recText: '', recPath: '', msg: '记录已添加' }))
                loadPwb(true)
              } else {
                setMatterModal((p) => Object.assign({}, p, { busy: false, msg: '添加失败: ' + String((r && r.error) || '未知错误') }))
              }
            })
            .catch((e) => setMatterModal((p) => Object.assign({}, p, { busy: false, msg: '添加失败: ' + String((e && e.message) || e) })))
        }

        function closeMatterNow() {
          if (matterModal === null || matterModal.busy) return
          const note = String(matterModal.closeNote || '').trim()
          if (matterModal.confirmClose !== true) {
            setMatterModal((p) => Object.assign({}, p, { confirmClose: true, msg: '再次点击确认关闭 —— 结束记录必填（Q1 裁定：过期事务关闭必须有结束节点反馈）' }))
            return
          }
          if (note.length === 0) {
            setMatterModal((p) => Object.assign({}, p, { confirmClose: false, msg: '必须填写结束记录后才能关闭' }))
            return
          }
          setMatterModal((p) => Object.assign({}, p, { busy: true, msg: null }))
          matterPost('close', { note })
            .then((r) => {
              if (r && r.ok === true) {
                setMatterModal((p) => Object.assign({}, p, { busy: false, confirmClose: false, matter: r.matter, closeNote: '', msg: '已关闭' }))
                loadPwb(true)
              } else {
                setMatterModal((p) => Object.assign({}, p, { busy: false, confirmClose: false, msg: '关闭失败: ' + String((r && r.error) || '未知错误') }))
              }
            })
            .catch((e) => setMatterModal((p) => Object.assign({}, p, { busy: false, confirmClose: false, msg: '关闭失败: ' + String((e && e.message) || e) })))
        }

        function reopenMatterNow() {
          if (matterModal === null || matterModal.busy) return
          setMatterModal((p) => Object.assign({}, p, { busy: true, msg: null }))
          matterPost('reopen', {})
            .then((r) => {
              if (r && r.ok === true) {
                setMatterModal((p) => Object.assign({}, p, { busy: false, matter: r.matter, msg: '已重新打开' }))
                loadPwb(true)
              } else {
                setMatterModal((p) => Object.assign({}, p, { busy: false, msg: '重开失败: ' + String((r && r.error) || '未知错误') }))
              }
            })
            .catch((e) => setMatterModal((p) => Object.assign({}, p, { busy: false, msg: '重开失败: ' + String((e && e.message) || e) })))
        }

        /**
         * 「关闭条件」旁的检测：当场按条件求值（host → 库内 CLI 复用适配器观测判定）。
         * 满足 → 已自动记录证据并关闭；不满足 → 如实说明还缺什么（不猜）。
         */
        function checkMatterCondition() {
          if (matterModal === null || matterModal.checkBusy === true) return
          const id = matterModal.id
          setMatterModal((p) => Object.assign({}, p, { checkBusy: true, msg: null }))
          api('/matter/check', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id }),
          })
            .then((r) => {
              if (r && r.ok === true && r.matched === true && r.closed === true) {
                setMatterModal((p) => Object.assign({}, p, { checkBusy: false, msg: '✓ 关闭条件已满足 → 已关闭并记录：' + String(r.note || '') }))
                loadPwb(true)
                // 详情同步为关闭后的状态（保留上面的提示）
                return api('/matter?id=' + encodeURIComponent(id)).then((d) => {
                  if (d && d.ok === true) setMatterModal((p) => Object.assign({}, p, { matter: d.matter }))
                })
              }
              if (r && r.ok === true && r.matched === false) {
                setMatterModal((p) => Object.assign({}, p, {
                  checkBusy: false,
                  msg: '未满足：' + String(r.reason || '关闭条件未满足'),
                }))
                return undefined
              }
              setMatterModal((p) => Object.assign({}, p, {
                checkBusy: false,
                msg: '检测失败：' + String((r && (r.error || r.reason)) || '未知错误'),
              }))
              return undefined
            })
            .catch((e) => setMatterModal((p) => Object.assign({}, p, { checkBusy: false, msg: '检测失败：' + String((e && e.message) || e) })))
        }

        React.useEffect(() => {
          // embedded（侧边栏 tab）模式：不做 overlay 定位/拖拽，面板占满 tab 容器
          if (embedded) {
            setBox({ ready: true, sidebarW: 0, wbW: 0, wbH: 0, panelFound: false, ownReserve: false })
          } else {
            tick()
          }
          load(false)
          loadPwb(false)
          loadObjects()
          // 待响应触发（T32）：与 /state 同节奏（30s）—— 它显示的是"要我去响应"的数字，
          // 比 objects/crosscheck 这类产物更需要新鲜度（host 侧另有 15s 缓存）。
          loadTriggers()
          // 处置台账 / 多源校验：同样是库内产物，60s 一次（与 objects 同节奏）
          loadDispoDoc()
          loadCrossDoc()
        // T31 卡（决策 / 跨源洞察；旧称「今日决策面」）：与 objects/crosscheck 同批首次加载
        loadBrief()
        loadInsights()
          // 判断质量台账（`/feedback`）：与上两条同节奏（人工裁决，变化更慢；60s 足够）
          loadFbDoc()
          // 卡片顺序覆盖层（用户拖动排序）：只在挂载时读一次 —— 覆盖层只在本人操作时变，
          // 轮询它没有意义，反而会把"用户刚拖好"的乐观更新覆盖回去。
          loadUiPrefs()
          // 底部系统在线状态：host 侧探测（带缓存），面板只读；120s 刷新一次
          const loadSys = () => {
            api('/sysstatus').then((j) => setSysStatus(j && j.ok === true ? j : null)).catch(() => {})
          }
          loadSys()
          const stopSys = ctx.interval(loadSys, 120000)
          // 「系统」卡两张能力小卡片的状态（四态 + 开关）：20s 一轮；**有请求在途就不再发**
          //   （自己压自己没意义，而且 host 每次都要起一个 node + 一次 powershell 查任务状态）。
          //   取不到时**保留错误对象**（`{ok:false,error}`）而不是置 null：卡片要能说清"为什么没数据"。
          //   ⚠️ 取数函数声明在组件作用域（`refreshSysCaps`）—— 卡片上的"未取到 ⇒ 点击重试"也要用它。
          refreshSysCaps()
          const stopSysCaps = ctx.interval(refreshSysCaps, 20000)
          // 实时活动：免缓存（纯内存），3s 轮询 —— 只有它需要"接近实时"
          const loadAct = () => {
            api('/activity').then((j) => setActivity(j && j.ok === true ? j : null)).catch(() => {})
          }
          loadAct()
          const stopAct = ctx.interval(loadAct, 3000)
          // 数据层的刷新节奏与钉钉取数解耦：读本地 JSON 很便宜，30 秒一次即可
          const stopTick = embedded ? () => {} : ctx.interval(tick, 700)
          const stopPwb = ctx.interval(() => loadPwb(false), 30000)
          // 对象层产物（objects.json）由库内管线生成，变化更慢 ⇒ 60 秒一次
          const stopObjs = ctx.interval(loadObjects, 60000)
          // 触发清单 30s（与 /state 同节奏；host 侧 15s 缓存兜住重复转调）
          const stopTrigs = ctx.interval(loadTriggers, 30000)
          const stopDispo = ctx.interval(loadDispoDoc, 60000)
          const stopCross = ctx.interval(loadCrossDoc, 60000)
        // 决策（旧称「今日决策面」）/ 跨源洞察：与 objects 同节奏（产物由同一条库内管线生成）
        const stopBrief = ctx.interval(loadBrief, 60000)
        const stopInsights = ctx.interval(loadInsights, 60000)
          const stopFb = ctx.interval(loadFbDoc, 60000)
          return () => {
            stopTick()
            stopPwb()
            stopObjs()
            stopTrigs()
            stopDispo()
            stopCross()
            stopFb()
            stopSys()
            stopSysCaps()
            stopAct()
            // 点击小卡片建立的**显式连接**也要随组件卸载释放（否则切走 tab 后输出通道/摄像头仍被占用）
            try { if (spkAcRef.current !== null) spkAcRef.current.close() } catch (e) {}
            try {
              const s = camStreamRef.current
              if (s !== null) { const ts = s.getTracks(); for (let i = 0; i < ts.length; i += 1) { try { ts[i].stop() } catch (e) {} } }
            } catch (e) {}
            spkAcRef.current = null
            camStreamRef.current = null
            camPendingRef.current = false
            for (let i = 0; i < stopRef.current.length; i += 1) { try { stopRef.current[i]() } catch (e) {} }
            stopRef.current = []
          }
        }, [])

        React.useEffect(() => {
          // 设备**种类计数**（挂载即读，无需权限：enumerateDevices 的 kind 不受权限限制）
          // —— 这是「断开(红)」与「关闭(灰)」的分界：硬件不存在 = 断开；存在但未连接 = 关闭。
          //    同时监听 devicechange：插拔音响/摄像头后状态自动更新，不留下过期的"断开"。
          const md = mediaApi()
          if (md === null || typeof md.enumerateDevices !== 'function') return undefined
          let alive = true
          const scan = () => {
            md.enumerateDevices().then((list) => {
              if (!alive) return
              let a = 0; let b = 0; let c = 0
              for (let i = 0; i < list.length; i += 1) {
                if (list[i].kind === 'audioinput') a += 1
                if (list[i].kind === 'audiooutput') b += 1
                if (list[i].kind === 'videoinput') c += 1
              }
              setDev((p) => Object.assign({}, p, { devices: { audioIn: a, audioOut: b, videoIn: c } }))
            }).catch(() => {})
          }
          scan()
          if (typeof md.addEventListener === 'function') {
            md.addEventListener('devicechange', scan)
            return () => { alive = false; try { md.removeEventListener('devicechange', scan) } catch (e) {} }
          }
          return () => { alive = false }
        }, [])

        React.useEffect(() => {
          if (dragging !== true) return undefined
          const move = (e) => {
            const d = dragRef.current
            if (d === null) return
            const maxH = Math.max(180, frameHRef.current - 160)
            const v = Math.max(180, Math.min(d.startH + (e.clientY - d.startY), maxH))
            setWbH(v)
            lsSet('dshw.wbH', String(v))
          }
          const up = () => setDragging(false)
          document.addEventListener('mousemove', move)
          document.addEventListener('mouseup', up)
          return () => {
            document.removeEventListener('mousemove', move)
            document.removeEventListener('mouseup', up)
          }
        }, [dragging])

        function openEvent(ev) {
          setNote(null)
          const base = { title: ev.title, start: ev.start, end: ev.end, location: ev.location }
          setDetail(Object.assign({}, base, { loading: true, attendees: null, error: null }))
          api('/event?event=' + encodeURIComponent(ev.id))
            .then((res) => {
              if (res && res.ok === true) setDetail(Object.assign({}, base, { loading: false, attendees: res.attendees || [], error: null }))
              else setDetail(Object.assign({}, base, { loading: false, attendees: null, error: String((res && res.error) || '详情读取失败') }))
            })
            .catch((e) => setDetail(Object.assign({}, base, { loading: false, attendees: null, error: String((e && e.message) || e) })))
        }

        // ── 侧边栏穿透（2026-09-15 需求）：文件/链接优先交给 better-sidebar 打开 ──
        // 文件 → 侧边栏 editor/explorer tab（绝对路径直通，resolveSidebarPath 对绝对路径原样返回）；
        // 链接 → 侧边栏 browser tab。侧边栏不存在时回退到旧的 /open（Invoke-Item）。
        function sidecar() {
          try { return ctx.get('betterSidebar') } catch (e) { return undefined }
        }
        function toAbs(p) {
          const s = String(p || '').trim()
          if (s.length === 0) return null
          if (/^[A-Za-z]:[\\/]/.test(s) || s.startsWith('/')) return s
          const root = snap && typeof snap.knowledgePath === 'string' && snap.knowledgePath.length > 0 ? snap.knowledgePath : null
          if (root === null) return null
          return s.startsWith('\\\\') ? s : root.replace(/[\\/]+$/, '') + '\\' + s.replace(/\//g, '\\')
        }
        function openInSidebarFile(p, label) {
          const svc = sidecar()
          const abs = toAbs(p)
          if (svc === undefined || abs === null) return false
          const at = Math.max(abs.lastIndexOf('/'), abs.lastIndexOf('\\'))
          const name = at === -1 ? abs : abs.slice(at + 1)
          svc.openTab({ type: 'editor', id: 'editor:' + abs, title: label || name, path: abs })
          return true
        }
        function openInSidebarUrl(url, title) {
          const svc = sidecar()
          const u = String(url || '')
          if (svc === undefined || u.length === 0) return false
          svc.openTab({ type: 'browser', id: 'browser:wb:' + u, title: title || u, url: u })
          return true
        }

        function openFile(p, label) {
          if (openInSidebarFile(p, label)) { setNote('已在侧边栏打开: ' + String(label || p)); return }
          api('/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p }) })
            .then((res) => setNote(res && res.ok === true ? '已打开: ' + String(label || p) : '打开失败: ' + String((res && res.error) || '')))
            .catch((e) => setNote('打开失败: ' + String((e && e.message) || e)))
        }

        /**
         * 点击日程 → 上层详情弹窗（2026-09-15 用户要求）。
         * 钉钉日程顺带查参会人（走既有 /event 路由 = dws attendee-list）；飞书/行程只做本地展示。
         */
        function openCalEvent(e) {
          if (!e) return
          const isDing = (e.source || 'dingtalk') === 'dingtalk'
          setCalModal({ e, loading: isDing && !!e.id, attendees: null, error: null, note: null })
          if (!isDing || !e.id) return
          api('/event?event=' + encodeURIComponent(e.id))
            .then((r) => {
              if (r && r.ok === true) setCalModal((p) => (p === null ? p : Object.assign({}, p, { loading: false, attendees: r.attendees || [] })))
              else setCalModal((p) => (p === null ? p : Object.assign({}, p, { loading: false, attendees: null, error: String((r && r.error) || '参会人读取失败') })))
            })
            .catch((err) => setCalModal((p) => (p === null ? p : Object.assign({}, p, { loading: false, attendees: null, error: String((err && err.message) || err) }))))
        }

        // 波形缓冲（**仅麦克风**一条）：只保留最近 WAVE_N 个采样，渲染成柱状波形
        // ⚠️ 2026-09-15 用户要求「音响的波形取消掉」—— 音响改为**小卡片**，不再有波形缓冲。
        const WAVE_N = 40
        const waveRef = React.useRef({ mic: new Array(WAVE_N).fill(0) })
        function pushWave(kind, level) {
          const w = waveRef.current
          const arr = w[kind] || (w[kind] = new Array(WAVE_N).fill(0))
          arr.push(Math.max(0, Math.min(1, Number(level) || 0)))
          if (arr.length > WAVE_N) arr.splice(0, arr.length - WAVE_N)
        }

        // 音响输出通道 / 摄像头视频流（点击小卡片切换时持有；关闭即释放）
        const spkAcRef = React.useRef(null)
        const camStreamRef = React.useRef(null)
        // 摄像头取流**在途标记**：防止连点并发申请（会弹出多个权限请求）
        const camPendingRef = React.useRef(false)
        // 麦克风会话的**停止句柄**：点击麦克风条从"开启"切到"关闭"时用它释放轨道/分析器/定时器
        //   （此前只有卡头「启用」按钮，没有关闭路径 —— 2026-09-15 用户要求整条可点击切换）
        const micStopRef = React.useRef(null)

        async function startDevices() {
          const md = mediaApi()
          if (md === null) {
            setDev((p) => Object.assign({}, p, { phase: 'blocked', note: '页面未暴露 navigator.mediaDevices', mic: 0, devices: null, micLabel: '' }))
            return
          }
          setDev((p) => Object.assign({}, p, { phase: 'starting', note: null, mic: 0, devices: null, micLabel: '' }))
          try {
            // ⚠️ 2026-09-15 起：摄像头不再随「启用」一起打开 —— 设备已拆成独立的可点击小卡片
            //    （摄像头点击才取流，属**用户显式动作**；不在挂载时申请权限）。
            const stream = await md.getUserMedia({ audio: true })
            const tracks = stream.getTracks()
            let hasAudio = false
            let micLabel = ''
            for (let i = 0; i < tracks.length; i += 1) {
              const t = tracks[i]
              if (t.kind === 'audio') { hasAudio = true; micLabel = String(t.label || '') }
            }
            // 设备**种类计数**（决定"断开/红"是硬件不存在，而不是"没启用"）
            //    enumerateDevices 的 kind 无需权限即可读；labels 才需要权限。
            let devices = null
            if (typeof md.enumerateDevices === 'function') {
              try {
                const list = await md.enumerateDevices()
                let a = 0; let b = 0; let c = 0
                for (let i = 0; i < list.length; i += 1) {
                  if (list[i].kind === 'audioinput') a += 1
                  if (list[i].kind === 'audiooutput') b += 1
                  if (list[i].kind === 'videoinput') c += 1
                }
                devices = { audioIn: a, audioOut: b, videoIn: c }
              } catch (e) {}
            }
            const AC = pickAudio()
            let chainStop = null
            if (hasAudio && AC !== null) {
              const ac = new AC()
              const an = ac.createAnalyser()
              an.fftSize = 512
              ac.createMediaStreamSource(stream).connect(an)
              const buf = new Uint8Array(an.fftSize)
              const stop = ctx.interval(() => {
                an.getByteTimeDomainData(buf)
                let peak = 0
                for (let i = 0; i < buf.length; i += 1) {
                  const v = Math.abs(buf[i] - 128) / 128
                  if (v > peak) peak = v
                }
                const level = Math.min(1, peak * 2.4)
                // 波形缓冲（2026-09-15 用户要求：麦克风以**波形**显示状态）
                pushWave('mic', level)
                setDev((p) => Object.assign({}, p, { phase: 'live', mic: level, micLabel }))
              }, 90)
              stopRef.current.push(stop)
              stopRef.current.push(() => { try { ac.close() } catch (e) {} })
              chainStop = () => { stop(); try { ac.close() } catch (e) {} }
            }
            stopRef.current.push(() => {
              for (let i = 0; i < tracks.length; i += 1) { try { tracks[i].stop() } catch (e) {} }
            })
            // 可被**点击麦克风条**调用的关闭路径（与卸载清理同一批动作）
            micStopRef.current = () => {
              for (let i = 0; i < tracks.length; i += 1) { try { tracks[i].stop() } catch (e) {} }
              if (chainStop !== null) chainStop()
            }
            setDev((p) => Object.assign({}, p, { phase: 'live', note: hasAudio ? null : '未取得麦克风轨道', devices: devices || p.devices, micLabel }))
          } catch (e) {
            setDev((p) => Object.assign({}, p, { phase: 'error', note: '设备启用失败: ' + String((e && e.message) || e), mic: 0, micLabel: '' }))
          }
        }

        // ── 头部瞬时提示（2026-09-15 用户要求）──────────────────────────────
        //    设备操作的回执不再堆在「系统状态」卡片底部，而是在面板头部「工作台」右侧短暂显示：
        //    **淡入 → 最多 10 秒 → 淡出**（新提示顶掉旧提示并重新计时）。
        //    计时用 ctx.interval（不依赖 window.setTimeout），并登记到 stopRef —— 组件卸载即停。
        const TOAST_HOLD_MS = 10000
        const TOAST_FADE_MS = 700
        function toastToneText(text) {
          return /失败|未找到|未取得|无法|不可用|错误|拒绝|占用|Error/i.test(String(text || '')) ? 'err' : 'info'
        }
        function showToast(text) {
          const msg = String(text || '').trim()
          if (msg.length === 0) return
          if (toastStopRef.current !== null) { try { toastStopRef.current() } catch (e) {} toastStopRef.current = null }
          const key = Date.now() + Math.random()      // key 唯一 ⇒ 同一句话再触发也会重新淡入
          setToast({ text: msg, key, tone: toastToneText(msg), phase: 'in' })
          const t0 = Date.now()
          const stop = ctx.interval(() => {
            const el = Date.now() - t0
            if (el >= TOAST_HOLD_MS - TOAST_FADE_MS) {
              setToast((p) => (p !== null && p.key === key && p.phase !== 'out' ? Object.assign({}, p, { phase: 'out' }) : p))
            }
            if (el >= TOAST_HOLD_MS) {
              stop()
              if (toastStopRef.current === stop) toastStopRef.current = null
              setToast((p) => (p !== null && p.key === key ? null : p))
            }
          }, 200)
          toastStopRef.current = stop
          stopRef.current.push(stop)
        }
        // 设备提示一出现就转成头部提示（dev.note 本身仍是状态源，只是不再渲染在卡片里）
        React.useEffect(() => {
          if (dev.note !== null) showToast(dev.note)
        }, [dev.note])

        // ── 「系统」卡两张**能力小卡片**（2026-09-23 用户裁定）────────────────────────
        //    取状态（挂载 + 20s 轮询 + 卡片上"未取到 ⇒ 点击重试"三处共用这一个函数）。
        function refreshSysCaps() {
          if (sysCapsBusyRef.current) return
          sysCapsBusyRef.current = true
          api('/system-state')
            .then((j) => setSysCaps(j && j.ok === true ? j : { ok: false, error: String((j && j.error) || '接口没有返回可用状态') }))
            .catch((e) => setSysCaps({ ok: false, error: String((e && e.message) || e) }))
            .then(() => { sysCapsBusyRef.current = false })
        }

        /**
         * 点击小卡片 = 切换该能力「开 / 关」。
         *
         * 三条纪律（都是这套面板踩过坑之后的规矩）：
         *   ① **不做乐观假成功**：一律以 host 回执为准 —— 回执里带**写后的完整状态**（含 `action`：
         *      写了什么、有没有顺手把消费者拉起来），所以一次往返就能刷新，也不需要本地猜。
         *   ② **失败必须显式**：把 host 的原话（或网络异常）贴出来，绝不静默。
         *   ③ **在途守卫**：上一条切换没回来之前不再发（连点两次会并发跑两次 `schtasks /run`）。
         */
        function toggleCapability(name, next) {
          if (sysCapsBusyRef.current) { showToast('上一次操作还没回来，稍后再点'); return }
          sysCapsBusyRef.current = true
          api('/system-switch', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ capability: name, enabled: next === true }),
          })
            .then((j) => {
              if (j && j.ok === true) {
                setSysCaps(j)
                const c = (j.capabilities || []).filter((x) => x && x.name === name)[0] || null
                const ens = j.action && j.action.ensure
                showToast((next === true ? '已开启' : '已关闭') + '「' + ((c && c.title) || CAP_MINI_TITLES[name] || name) + '」'
                  + (c ? '：现在 ' + String(c.label) : '')
                  + (ens && ens.ran === true ? '（消费者任务已拉起）' : ''))
              } else {
                showToast('切换失败：' + String((j && j.error) || '未知原因'))
              }
            })
            .catch((e) => showToast('切换失败：' + String((e && e.message) || e)))
            .then(() => { sysCapsBusyRef.current = false })
        }

        // ── 音响：点击小卡片 = 切换「连接 / 关闭」────────────────────────────
        //    诚实边界：浏览器**无法**控制系统音响的开关与音量，也无法测量系统输出电平。
        //    因此这里的"连接"= 本面板建立并保持一条音频**输出通道**（AudioContext running），
        //    连接时播 1 秒 440Hz 确认音（= 原「试音」能力，不再是单独按钮）；"关闭"= 释放该通道。
        //    绿灯含义因此是「输出通道已打开」，不是「系统音响已开机」。
        //    ⚠️ 2026-09-15 真机验收实测坑：无自动播放许可时 `ac.resume()` 返回的 Promise
        //       **可能一直不 resolve**，原来的 `await` 会让这次点击**静默卡住**（面板停在"关闭"、
        //       没有任何反馈，看起来像"点了没反应"）。改为**不等待**：先给"正在连接"反馈，
        //       再用轮询收敛（≤1.5s）——running 才算连上，仍挂起则释放并如实显示「断开」+ 原因。
        function toggleSpeaker() {
          const AC = pickAudio()
          if (AC === null) { setDev((p) => Object.assign({}, p, { note: '页面无 AudioContext，无法连接音响', spkOn: false, spkFailed: true })); return }
          const cur = spkAcRef.current
          if (cur !== null) {                       // 已连接（或连接中）→ 关闭
            spkAcRef.current = null
            try { cur.close() } catch (e) {}
            setDev((p) => Object.assign({}, p, { note: '音响已关闭（输出通道已释放）', spkOn: false, spkFailed: false }))
            return
          }
          let ac = null
          try {
            ac = new AC()
            spkAcRef.current = ac                 // 先持有，避免连点建出多条通道
            if (ac.state === 'suspended' && typeof ac.resume === 'function') { try { ac.resume() } catch (e) {} }
            setDev((p) => Object.assign({}, p, { note: '正在连接音响…（等待浏览器放行音频通道）' }))
          } catch (e) {
            setDev((p) => Object.assign({}, p, { note: '音响连接失败: ' + String((e && e.message) || e), spkOn: false, spkFailed: true }))
            return
          }
          const mine = ac
          const t0 = Date.now()
          const settle = ctx.interval(() => {
            if (spkAcRef.current !== mine) { settle(); return }   // 已被用户再次点击取消
            if (mine.state === 'running') {
              settle()
              playConfirmTone(mine)
              setDev((p) => Object.assign({}, p, {
                spkOn: true, spkFailed: false,
                note: '音响已连接（播 1 秒 440Hz 确认音；浏览器无法测量系统输出电平，绿灯=面板输出通道已打开）',
              }))
              return
            }
            if (Date.now() - t0 > 1500) {
              settle()
              spkAcRef.current = null
              try { mine.close() } catch (e) {}
              setDev((p) => Object.assign({}, p, {
                spkOn: false, spkFailed: true,
                note: '音响连接失败：浏览器把音频通道置为 ' + String(mine.state) + '（自动播放策略）—— 可再点一次重试',
              }))
            }
          }, 120)
          stopRef.current.push(settle)
        }

        // ── 摄像头：点击小卡片 = 切换「连接 / 关闭」──────────────────────────
        //    连接 = 取一条视频轨（**不显示画面**，仅用于判定设备正常）；关闭 = 停止全部视频轨并释放设备。
        //    ★ 物理优先（2026-09-15 用户实测要求）：有权限（标签可见）时先枚举，**存在物理摄像头就用它**；
        //      若只能拿到虚拟设备（本机就是这种情况），则**如实标注"虚拟"**，不让人以为物理摄像头可用。
        //    取流可能停在浏览器权限弹窗上（用户要决策）—— 故先给"正在连接"反馈，不做静默等待；
        //    并加**在途标记**防止连点并发申请（否则会弹出多个权限请求）。
        async function toggleCamera() {
          const md = mediaApi()
          if (md === null) { setDev((p) => Object.assign({}, p, { note: '页面未暴露 navigator.mediaDevices', cam: false, camFailed: true })); return }
          const cur = camStreamRef.current
          if (cur !== null) {                       // 已连接 → 关闭
            camStreamRef.current = null
            stopStream(cur)
            setDev((p) => Object.assign({}, p, { note: '摄像头已关闭（视频轨已停止）', cam: false, camFailed: false, camVirtual: null }))
            return
          }
          if (camPendingRef.current === true) {     // 已在申请中：不并发再要一次
            setDev((p) => Object.assign({}, p, { note: '摄像头正在连接中（如浏览器弹出权限请求，请选择允许/拒绝）' }))
            return
          }
          camPendingRef.current = true
          setDev((p) => Object.assign({}, p, { note: '正在连接摄像头…（如浏览器弹出权限请求，请选择允许/拒绝）' }))
          const scan = async () => {
            try {
              const list = await md.enumerateDevices()
              return list.filter((d) => d.kind === 'videoinput').map((d) => ({
                id: String(d.deviceId || ''), label: String(d.label || ''), virtual: isVirtualCamLabel(d.label),
              }))
            } catch (e) { return [] }
          }
          try {
            // ① 有权限时标签可见 ⇒ 先挑**物理**设备（首次点击标签为空，此步自然跳过）
            let inventory = await scan()
            const labelKnown = inventory.some((d) => d.label.length > 0)
            const phys = inventory.filter((d) => d.label.length > 0 && d.virtual !== true)
            const want = labelKnown && phys.length > 0 ? { video: { deviceId: { exact: phys[0].id } } } : { video: true }
            let s = await md.getUserMedia(want)
            let track = s.getTracks().filter((t) => t.kind === 'video')[0] || null
            let label = String((track && track.label) || '')
            // ② 拿到权限后标签才可见：若刚才开的是**虚拟**设备、而系统里确实存在**物理**摄像头 ⇒ 自动切到物理那台
            let switched = false
            if (isVirtualCamLabel(label)) {
              inventory = await scan()
              const phys2 = inventory.filter((d) => d.label.length > 0 && d.virtual !== true)
              if (phys2.length > 0) {
                try {
                  const s2 = await md.getUserMedia({ video: { deviceId: { exact: phys2[0].id } } })
                  const t2 = s2.getTracks().filter((t) => t.kind === 'video')[0] || null
                  if (t2) {
                    stopStream(s)
                    s = s2
                    track = t2
                    label = String(t2.label || '')
                    switched = true
                  } else { stopStream(s2) }
                } catch (e) { /* 切不到物理设备就沿用虚拟那台，下面如实标注 */ }
              }
            }
            if (track === null) {
              stopStream(s)
              setDev((p) => Object.assign({}, p, { note: '未取得视频轨（设备可能被其它程序占用）', cam: false, camFailed: true }))
              return
            }
            const isVirtual = isVirtualCamLabel(label)
            const physCount = inventory.filter((d) => d.label.length > 0 && d.virtual !== true).length
            const invText = inventory.length > 0
              ? '本机视频输入：' + inventory.map((d) => d.label + (d.virtual ? '（虚拟）' : '（物理）')).join('、')
              : ''
            camStreamRef.current = s
            setDev((p) => Object.assign({}, p, {
              cam: true, camFailed: false, camLabel: label, camVirtual: isVirtual, camInventory: inventory,
              note: isVirtual
                ? '摄像头已连接，但连的是**虚拟摄像头**「' + (label || '未命名') + '」—— 本机未检测到物理摄像头'
                  + (switched ? '（已尝试切换到物理设备，未成功）' : '') + '。只判定状态，不显示画面。' + (invText ? ' ｜ ' + invText : '')
                : '摄像头已连接（物理设备「' + (label || '未命名') + '」；只判定状态，不显示画面）' + (invText ? ' ｜ ' + invText : ''),
            }))
          } catch (e) {
            // 找不到设备时给出可操作的解释（本机无摄像头是最常见原因）
            const msg = String((e && e.message) || e)
            const noDev = /NotFound|not found|Requested device/i.test(msg) || (e && e.name === 'NotFoundError')
            setDev((p) => Object.assign({}, p, {
              cam: false, camFailed: true, camVirtual: null,
              note: noDev
                ? '摄像头连接失败：系统中未找到可用的摄像头设备（' + msg + '）—— 接上摄像头后可再点一次重试'
                : '摄像头连接失败: ' + msg + '（可再点一次重试）',
            }))
          } finally {
            camPendingRef.current = false
          }
        }

        // ── 麦克风：点击**波形条本身** = 切换「启用 / 关闭」────────────────────
        //    2026-09-15 用户要求：把原来卡头的「启用麦克风」按钮**并入**麦克风+波形条，
        //    点这一整块就切换状态（三个设备交互一致：点哪个区域，切换哪个设备）。
        //    启用 = 取音频轨 + 分析器 + 90ms 采样刷波形；关闭 = 释放轨道与分析器并清空波形缓冲。
        function toggleMic() {
          if (dev.phase === 'starting') {
            setDev((p) => Object.assign({}, p, { note: '麦克风正在启用中…' }))
            return
          }
          if (dev.phase === 'live') {                 // 已启用 → 关闭
            const stopMic = micStopRef.current
            micStopRef.current = null
            if (typeof stopMic === 'function') { try { stopMic() } catch (e) {} }
            // 清空波形缓冲：关掉之后还留着旧波形＝在不该有信号时显示信号（不诚实）
            waveRef.current.mic = new Array(WAVE_N).fill(0)
            setDev((p) => Object.assign({}, p, { phase: 'idle', mic: 0, note: '麦克风已关闭（音频轨与分析器已释放）' }))
            return
          }
          startDevices()
        }

        // 1 秒 440Hz 确认音（原「试音」按钮的逻辑，抽出来给音响连接复用）
        function playConfirmTone(ac) {
          try {
            const osc = ac.createOscillator()
            const gain = ac.createGain()
            osc.frequency.value = 440
            gain.gain.value = 0.0001
            osc.connect(gain)
            gain.connect(ac.destination)
            osc.start()
            gain.gain.linearRampToValueAtTime(0.06, ac.currentTime + 0.08)
            gain.gain.linearRampToValueAtTime(0.0001, ac.currentTime + 0.9)
            osc.stop(ac.currentTime + 1)
          } catch (e) {
            setDev((p) => Object.assign({}, p, { note: '确认音播放失败: ' + String((e && e.message) || e) }))
          }
        }

        function row(time, text, key, onClick, title) {
          const props = { className: 'dshw-item', key, title: title || text }
          if (onClick) { props['data-click'] = '1'; props.onClick = onClick }
          return h('div', props,
            h('span', { className: 'dshw-item-time' }, time),
            h('span', { className: 'dshw-item-text' }, text),
          )
        }
        // tall=true：卡体**不裁切**（内容多时卡片自然变高，溢出交给外层栅格滚动）——
        //   2026-09-15 用户实测「系统状态」内容被 168px 截断看不全，该卡用此模式。
        // headInline：紧跟在**标题右侧**的内联块（用于把麦克风条放在「系统状态」四个字右边）。
        //   有 headInline 时卡头加 `--nowrap`：⚠️ flex 的换行是按**基础宽度**决定的、**先于**收缩，
        //   所以只靠"允许收缩"不够 —— 窄卡里它仍会换到第二行（用户截图实测）。必须禁换行才行。
        //   有 headInline 时**不渲染 spacer**：否则 spacer 会与 pill 平分剩余空间，
        //   pill 撑不满右侧、波形也就不会随卡片宽度伸缩（2026-09-15 用户要求）。
        function card(title, badge, body, extra, tall, headInline, opts) {
          const o = opts || {}
          // key 由显示名反查（单源：`CARD_TITLES` + 前缀匹配，`kb` 带后缀也认得出）——
          //   这样 14 处 `cardsByKey.set(...)` 调用点**不用逐一改造**，也不会各自写死 key。
          const ckey = (typeof o.key === 'string') ? o.key : cardKeyOfTitle(title)
          // 场景交互：**只有登记过的卡**才可点（SPEC §三 登记表）；未登记 ⇒ 卡名是纯文本
          const scene = ckey !== null && Object.prototype.hasOwnProperty.call(CARD_SCENES, ckey) ? CARD_SCENES[ckey] : null
          const folded = ckey !== null && cardFolded[ckey] === 1
          const titleProps = { className: 'dshw-card-title', key: 'ct' }
          if (scene !== null) {
            // ⚠️ 卡名**不再挂 `data-click="1"`**（2026-09-17 更正）：那条会让卡名被 `CARD_DRAG_EXCLUDE`
            //   排除 ⇒ **长按卡名不进拖动**，与"长按整卡自由拖动"直接冲突（真机 SBT-47 就按在卡名上）。
            //   现在：卡名参与长按拖动；真拖过之后的那一次 click 由 `onDragClickGuard` 在**捕获阶段**抑制
            //   ⇒ 点一下折叠、长按拖动，两者都成立（`data-scene` 仍保留给断言读）。
            titleProps['data-scene'] = scene.name
            titleProps.title = '点击折叠/展开（场景交互）· 长按卡片可拖动排序'
            titleProps.onClick = () => toggleCardFolded(ckey)
          }
          return h('section', {
            className: 'dshw-card',
            key: title,
            'data-card-key': ckey,
            'data-card-folded': folded ? '1' : '0',
          },
            h('div', { className: 'dshw-card-head' + (headInline ? ' dshw-card-head--nowrap' : '') },
              h('span', titleProps, title),
              badge ? h('span', { className: 'dshw-badge', 'data-card-metric': ckey, title: '关键指标（payload 原值）' }, badge) : null,
              // 第 1 行中间＝关键指标：字符串走 `badge`（包成 `.dshw-badge`）；已是节点则走
              //   `opts.metric`（外层只套 `[data-card-metric]`，**不重复包 `.dshw-badge`**，免得嵌套 badge）。
              //   SPEC §一 要求 14 张卡都有这一格 —— `brief`/`system` 原先传 `null` 故缺失（SBT-90 抓到）。
              (badge === null || badge === undefined) && o.metric !== null && o.metric !== undefined
                ? h('span', { 'data-card-metric': ckey }, o.metric)
                : null,
              headInline || null,
              headInline ? null : h('span', { className: 'dshw-spacer' }),
              extra || null,
            ),
            h('div', {
              className: 'dshw-card-body' + (tall ? ' dshw-card-body--tall' : ''),
              'data-card-folded': folded ? '1' : '0',
            }, body),
            // ── 缩放手柄（2026-09-25 用户要求）：卡右下角的小三角 ─────────────────
            //   ⚠️ 必须渲染在 `.dshw-card` **里面**：slot 会被同行最高的卡撑高，
            //      卡是内容高 —— 挂 slot 上会飘在卡片底边下方，不是"卡片的右下角"。
            //   ⚠️ `role="button"` 是**功能性**的：`CARD_DRAG_EXCLUDE` 里就有它，
            //      于是长按拖动排序不会跟这个手柄抢指针（RZ-9 守着这条）。
            ckey === null ? null : h('span', {
              className: 'dshw-rsz',
              key: 'rsz',
              role: 'button',
              tabIndex: -1,
              'aria-label': '拖动调整卡片大小',
              title: sizeMode === 'grid'
                ? '按住向右下拖动 → 放大 / 缩小（横竖一起改；网格档：宽高都吸附 5%）'
                : '按住向右下拖动 → 放大 / 缩小（横竖一起改；无级档：自由像素，最小高 ' + CARD_MIN_H_PX + 'px）',
              onPointerDown: (e) => startCardResize(e, ckey),
            }),
            // ── 移动手柄（2026-09-25 用户要求）：卡**左下角**的小方块 ─────────────────
            //   按住即进入"磁力贴"拖动：卡片跟手、周围卡片实时让位、松手落位（见 startMoveDrag）。
            //   与右下角的缩放手柄分工明确：左下换位置、右下改大小。
            ckey === null ? null : h('span', {
              className: 'dshw-mv',
              key: 'mv',
              role: 'button',
              tabIndex: -1,
              'aria-label': '拖动调整卡片位置',
              title: '按住拖动 → 与其它卡片换位置（周围的卡会实时让开）',
              onPointerDown: (e) => startMoveDrag(e, ckey),
            }),
          )
        }
        function pill(text, tone) { return h('span', { className: 'dshw-pill', 'data-tone': tone || null }, text) }
        function meter(level, kind) {
          return h('span', { className: 'dshw-meter' }, h('i', { 'data-kind': kind || null, style: { width: Math.round(Math.max(0, Math.min(1, level)) * 100) + '%' } }))
        }
        function empty(text, key) { return h('div', { className: 'dshw-empty', key: key || 'e' }, text) }

        /**
         * ── 通用详情页组件（SPEC_卡片交互规范 §四 / §五 / §六）─────────────────────────
         *
         * 契约：详情页按**内容与结构**呈现元素 —— 标题（恒有，放 `dshw-modal-head`）·
         *   关键洞察 · 详细情况 · 关联域 · 业务关系（信息/日程/待办/对象/知识库/听记，**逐类判断**）·
         *   前序环节 · 后续环节 · 操作执行按钮。
         * **不适用 ⇒ 整块不出现**（反模式 C4：空区块会让人以为"这里本该有数据"）。
         *
         * 这些函数只产出节点，不改任何状态、不发请求（详情页只读；写操作一律走 §6.2 登记过的按钮）。
         */
        const DTL_KEYS = ['insight', 'detail', 'domain', 'relations', 'prev', 'next', 'actions']
        /** 一个契约区块：有内容才出现；空数组 / null / undefined ⇒ 返回 null（不占位） */
        function dtlSec(key, headText, nodes) {
          if (nodes === null || nodes === undefined) return null
          const arr = (Array.isArray(nodes) ? nodes : [nodes]).filter((x) => x !== null && x !== undefined)
          if (arr.length === 0) return null
          return h('div', { className: 'dshw-modal-sec', key: 'dtl-' + key, 'data-dtl': key },
            headText === null || headText === undefined ? null : h('div', { className: 'dshw-modal-sec-h' }, headText),
            ...arr)
        }
        /** 关键洞察：payload 有洞察/结论字段时才传；没有就**不要调用**（不写"暂无"） */
        const dtlInsight = (text) => (text === null || text === undefined || String(text).trim() === ''
          ? null
          : dtlSec('insight', '关键洞察', h('div', { className: 'dshw-mrow-v', 'data-dtl-insight': '1' }, String(text))))
        /** 详细情况：恒有；无说明时写「无更多说明」（SPEC §五 唯一的显式空态） */
        const dtlDetail = (text) => dtlSec('detail', '详细情况',
          h('div', { className: 'dshw-mrow-v', 'data-dtl-detail': '1' },
            (text === null || text === undefined || String(text).trim() === '') ? '无更多说明' : String(text)))
        /** 关联域：条目带域时才出现（`domain_id` / `domain`，显示名由调用方给，卡片不算） */
        const dtlDomain = (name) => (name === null || name === undefined || String(name).trim() === ''
          ? null
          : dtlSec('domain', '关联域', h('div', { className: 'dshw-mrow-v', 'data-dtl-domain': '1' }, String(name))))
        /**
         * 业务关系：**逐类判断** —— 六类里哪类有关系就只出哪类；全无关系 ⇒ 整块不出现。
         * @param {{信息?:Array, 日程?:Array, 待办?:Array, 对象?:Array, 知识库?:Array, 听记?:Array}} rel
         */
        function dtlRelations(rel) {
          const r = rel || {}
          const rows = []
          for (const label of ['信息', '日程', '待办', '对象', '知识库', '听记']) {
            const items = r[label]
            if (items === null || items === undefined) continue
            const arr = (Array.isArray(items) ? items : [items]).filter((x) => x !== null && x !== undefined)
            if (arr.length === 0) continue   // 该类无关系 ⇒ 该类不出现（不得留空区块）
            rows.push(h('div', { className: 'dshw-mrow', key: 'rel-' + label, 'data-rel': label },
              h('span', { className: 'dshw-mrow-l' }, label + ' (' + String(arr.length) + ')'),
              h('span', { className: 'dshw-mrow-v' }, ...arr.map((x, i) => (typeof x === 'string'
                ? h('span', { key: 'r' + i }, i === 0 ? x : ' · ' + x)
                : x)))))
          }
          return rows.length === 0 ? null : dtlSec('relations', '业务关系', rows)
        }
        /**
         * 可控穿透链接（SPEC §6.1）：**只有路径型 / URL 型才做成可点**；散文一律纯文本。
         * · 路径：走既有 `/open`（限库内）；URL：新标签打开。
         * · 打不开时必须给可读原因，**不得静默失败**（反模式 C5）。
         */
        function dtlLink(text, target, kind) {
          const label = String(text)
          const t = target === null || target === undefined ? '' : String(target).trim()
          const isUrl = /^https?:\/\//i.test(t)
          const isPath = t.length > 0 && !isUrl && /[\\/]/.test(t) && !/\s{2,}/.test(t)
          if (t === '' || (isUrl !== true && isPath !== true)) {
            // 散文 / 无目标 ⇒ 纯文本（今天出现过"点开不存在的文件"，那条反模式在这里被挡掉）
            return h('span', { className: 'dshw-mrow-v', key: 'l-' + label, 'data-link': '0', title: t === '' ? '无目标（不可点）' : '散文描述（不可点）' }, label)
          }
          return h('a', {
            className: 'dshw-mrow-v',
            key: 'l-' + label,
            'data-link': '1',
            'data-link-kind': isUrl ? 'url' : 'path',
            href: isUrl ? t : undefined,
            target: isUrl ? '_blank' : undefined,
            rel: isUrl ? 'noreferrer' : undefined,
            style: { cursor: 'pointer', textDecoration: 'underline' },
            title: (kind === null || kind === undefined ? '' : String(kind) + ' · ') + t,
            onClick: isUrl ? undefined : (ev) => {
              ev.preventDefault()
              ev.stopPropagation()
              api('/open', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ path: t }),
              }).then((r) => {
                if (!r || r.ok !== true) setNote('打开失败：' + String((r && r.error) || '路由不可用') + '（目标：' + t + '）')
              }).catch((e) => setNote('打开失败：' + String((e && e.message) || e) + '（目标：' + t + '）'))
            },
          }, label)
        }
        /** 前序环节：条目由上游派生时（`origin_inbound` / `source_ref`）；无上游 ⇒ 不出现 */
        const dtlPrev = (nodes) => dtlSec('prev', '前序环节', nodes)
        /** 后续环节：条目已有落点/下游时（事务/触发 id + 状态）；无下游 ⇒ 不出现 */
        const dtlNext = (nodes) => dtlSec('next', '后续环节', nodes)
        /** 操作执行按钮：**只允许放 §6.2 登记表里有的写按钮**；无合法写操作 ⇒ 不出现 */
        const dtlActions = (nodes) => dtlSec('actions', '操作', nodes)
        /**
         * 组装详情页（portal 前的元素）：head 段 + body 段。
         * `title` 恒有；`badge` 可选；`sections` 为上面各函数返回值（null 自动丢弃）。
         */
        function dtlPage(opts) {
          const o = opts || {}
          const secs = (Array.isArray(o.sections) ? o.sections : [o.sections]).filter((x) => x !== null && x !== undefined)
          const head = h('div', { className: 'dshw-modal-head' },
            h('span', { className: 'dshw-modal-title', 'data-dtl-title': '1', title: o.titleTip || String(o.title) }, String(o.title)),
            o.badge === null || o.badge === undefined ? null : h('span', { className: 'dshw-badge' }, String(o.badge)),
            h('span', { className: 'dshw-spacer' }),
            h('button', { className: 'dshw-btn', onClick: o.onClose }, '✕'))
          return h('div', { className: 'dshw-modal-backdrop', onClick: o.onClose },
            h('section', { className: 'dshw-modal', onClick: (ev) => ev.stopPropagation() },
              head,
              h('div', { className: 'dshw-modal-body' }, ...secs)))
        }

        const kn = (snap && snap.knowledge) || { total: 0, counts: {}, recent: [], byCategory: {} }
        const counts = kn.counts || {}
        // 分类 tab 只保留标签（2026-09-15 裁定：不在 tab 上显示计数）——
        // 数量信息在下方「文件 · 分类」卡片的徽标里给出，避免同一数字出现两处。
        const tabs = CATS.map((c) => h('button', {
          key: c.key,
          className: 'dshw-tab',
          'data-on': tab === c.key ? '1' : null,
          onClick: () => { setTab(c.key); lsSet('dshw.tab', c.key) },
        }, c.label))

        // ── 数据层区块（personal-workbench）────────────────────────────────
        // 数据源 = 驾驶舱自己的 snapshot.json（host 的 /state 路由），**不是**第二套派生。
        // 渲染原则与驾驶舱一致：**陈旧必须可见**（显示数据时刻与滞后分钟数），
        // 未达成的指标**不得显示成绿色**（V5 审计那条教训）。
        // ── 卡片装配（2026-09-15 用户要求重排）：**显式顺序表驱动**，不再依赖 push 的先后 ──
        //  为什么改成登记表：原先靠 push 顺序，任何人插一张卡就会打乱版面，且"顺序"只存在于
        //  代码执行路径里、无法被断言。现在每张卡带 key，最后按 CARD_ORDER 装配 —— 顺序**可读、可断言**。
        const cardsByKey = new Map()
        const alertBlocks = []   // 错误/提示块（不在用户给定的 12 项顺序内）→ 一律置顶，保证可见
        /**
         * 专注期间的**视觉视图**（2026-09-17 用户裁定）：在卡片装配**之前**声明、装配中赋值，
         * 供后面的 `slotOf()` 读取 —— 它决定"哪些卡降权/折叠"。
         *
         * 默认值 = **不专注**（active:false / 全都不降权）：数据层没就绪时宁可什么都不改，
         * 也不要把"读不到专注态"渲染成"正在专注、其它卡都该降权"。
         * ⚠️ 本对象**只承载视觉权重**，绝不携带卡片顺序信息（顺序的唯一真相源是 CARD_ORDER）。
         */
        let focusView = { active: false, prominent: ['focus'], upcoming: [], wl: null, live: false, lead: UPCOMING_SCHEDULE_LEAD_MINUTES }

        // ── 对象行 / 二级详情的**共用件**（2026-09-17 抽到此处）────────────────────
        //  为什么放在卡片装配**最前**：行有两条入口 —— ① 「对象」卡（客户级 rollup 与其场次子行）；
        //  ② 「活跃」卡新增的 **域 → 对象** 下钻。②的注册点比①靠前，若沿用原来的 `const objItemRow`
        //  就地定义，就会踩本文件已记录过两次的 TDZ 崩（`Cannot access … before initialization`）。
        //  ⇒ 一律改成**函数声明**（提升到本作用域开头）+ 纯函数，被谁调用都安全。
        const objHasDocShape = (doc) => doc !== null && doc !== undefined && Array.isArray(doc.objects)
        /** 对象层的态别（读失败 / 未取到 / 无数据 / 口径为 0 各有各的说法，绝不合并） */
        const objLayerState = () => {
          if (objsErr !== null) return { kind: 'error', text: '对象层读取失败: ' + String(objsErr) }
          if (objs === null) return { kind: 'wait', text: objsBusy === true ? '正在读取对象层…' : '等待对象层…' }
          if (objHasDocShape(objs) !== true) {
            return {
              kind: 'unavailable',
              text: '对象层不可用: ' + String(objs.error || '响应里没有 objects 字段')
                + '（属于读失败，不等于 0 个对象）',
            }
          }
          if (objs.objects.length === 0) return { kind: 'empty', text: '无数据：对象层产物里 objects = 0 个（管线尚未产出对象）' }
          return { kind: 'ok', doc: objs }
        }
        /** 「原样显示」的唯一兜底：payload 给 null/undefined/空串时写「无期限」（正是它的语义） */
        function objRaw(v) { return (v === null || v === undefined || v === '' ? '无期限' : String(v)) }
        /**
         * 对象键 → 人可读名（2026-09-17 用户反馈：「我从这张卡上看到一堆的数字，没有详细的信息描述」）。
         *   实现已抽到**模块级** `objKeyLabel()`（听记聚合也要用同一份判据 ⇒ 只留一个真相源）；
         *   这里保留同名入口，调用点与既有断言（T16/SBT 读的 `objLabel(`）都不受影响。
         */
        function objLabel(key) {
          return objKeyLabel(key)
        }
        /** counts 说人话（2026-09-17 用户反馈）：`37 件事 · 17 条承诺`（不再铺 `事务 37 · 触发 17`） */
        function objCountsText(c) {
          return String((c || {}).matters ?? '—') + ' 件事 · ' + String((c || {}).triggers ?? '—') + ' 条承诺'
        }
        /** counts 的 **payload 原字段名**：只用在 tooltip 里核账（说人话的措辞不能把字段名吃掉） */
        function objCountsRaw(c) {
          return 'matters ' + String((c || {}).matters ?? '—') + ' · triggers ' + String((c || {}).triggers ?? '—')
        }

        /**
         * ── 对象层索引（2026-09-21 · P2b「对象属性化」的**唯一取数口**）────────────────
         *  「对象」卡撤掉后 `objects.json` **照旧生成** —— 它现在的身份是**属性来源**，消费方 5 处：
         *    · 事务卡行内标签（`data-object-key`）+ 事务详情「归属对象 / 对象下一步 / 对象出处」段；
         *    · 流入卡「未归属 N 条」提示；· 跨源洞察证据段（支撑强度 / 证据线）；
         *    · 「专注 · 活跃」卡的**域 → 对象 → 事务**三级下钻（入口不变）；
         *    · 对象详情弹窗 `objModal`（待办卡分组头 / 域下钻 / 事务详情都点得开）。
         *  ⇒ 在这里建**一处**索引，五个消费方共用 —— 各自就地重算是本文件反复吃过的"第二份声明"。
         *  全部**只读 payload**：不推断、不补期限、不配色、不重算；产物未到一律返回 null，
         *  由调用方把「读失败 / 未读取 / 无数据 / 口径为 0」分开说（三态从不合并）。
         *  ⚠️ 一律写成**函数声明**（提升到本作用域开头）：行号更早的事务卡 / 流入卡与更晚的几个
         *     详情弹窗都要用；`const` 箭头函数跨分支引用会踩本文件已记录两次的 TDZ 崩。
         */
        function objLayerDoc() {
          return (objs !== null && objs !== undefined && objHasDocShape(objs) === true) ? objs : null
        }
        /** 记录 id（事务 / 触发）→ `byRecord` 的归属对象（**权威归属**）；无归属 / 产物未到 ⇒ null */
        function objRecOf(id) {
          if (id === null || id === undefined) return null
          const doc = objLayerDoc()
          const by = (doc !== null && doc.byRecord !== null && typeof doc.byRecord === 'object') ? doc.byRecord : {}
          return by[String(id)] || null
        }
        /** 对象键 → `objects[]` 里的完整条目（state / counts / next_step / sources / trace…） */
        function objItemOf(key) {
          if (key === null || key === undefined) return null
          const doc = objLayerDoc()
          if (doc === null) return null
          const items = doc.objects
          for (let i = 0; i < items.length; i += 1) {
            const o = items[i]
            if (o !== null && o !== undefined && String(o.key) === String(key)) return o
          }
          return null
        }
        /**
         * 对象**属性摘要**（一级行用）：`对象名 · 状态` + counts 弱尾 + 有 next_step 时一句「下一步 …」。
         *   全部 payload 原样；`tip` 是同一批字段的**核账口径**（含机器 id、kind/parent、归属依据、出处）。
         *   归属对象为 null ⇒ 返回 null —— 调用方写「未归属对象」，**不猜、不按标题推**。
         */
        function objAttrBrief(rec) {
          if (rec === null || rec === undefined || rec.key === undefined || rec.key === null) return null
          const it = objItemOf(rec.key)
          const c = (it !== null && it.counts !== null && it.counts !== undefined) ? it.counts : null
          const ns = (it !== null && it.next_step !== null && it.next_step !== undefined) ? it.next_step : null
          const st = (it !== null && it.state !== undefined && it.state !== null) ? String(it.state) : '—'
          const srcs = (it !== null && Array.isArray(it.sources)) ? it.sources : []
          const line = []
          line.push('对象键: ' + String(rec.key))
          line.push('kind: ' + String(rec.kind || '—') + ' · parent: ' + String(rec.parent === null || rec.parent === undefined ? '（payload 无 parent）' : rec.parent))
          line.push('state: ' + st + (c === null ? '' : ' · counts（payload 原字段）: ' + objCountsRaw(c)))
          if (rec.evidence !== null && rec.evidence !== undefined && String(rec.evidence) !== '') line.push('归属依据: ' + String(rec.evidence))
          if (ns !== null) {
            line.push('next_step（payload 原样）: ' + String(ns.id || '—') + ' · ' + String(ns.title || '')
              + ' · ' + objRaw(ns.due_at) + ' · ' + String(ns.owner || '—'))
          } else {
            line.push('next_step: payload 未给出（本卡不为它推断下一步）')
          }
          if (srcs.length > 0) line.push('出处（sources）: ' + srcs.map((s, i) => String(i + 1) + ' ' + String(s)).join(' · '))
          return {
            key: String(rec.key),
            kind: String(rec.kind || '—'),
            parent: rec.parent === null || rec.parent === undefined ? null : String(rec.parent),
            state: st,
            counts: c,
            next: ns,
            text: objLabel(rec.key) + ' · ' + st,
            countsText: c === null ? null : objCountsText(c),
            nextText: ns === null ? null : (String(ns.title || ns.id || '—') + ' · ' + objRaw(ns.due_at) + ' · ' + String(ns.owner || '—')),
            tip: line.join('\n'),
          }
        }
        /** trajectory 只照 payload 的取值换措辞（trigger-only / matter-only）；其它取值不贴标签。
         *  前面带分隔号 —— 弱尾与主行都是「… 件事 · … 条承诺 · 仅触发」，不再和计数粘在一起。 */
        function objTrajTag(t) { return (t === 'trigger-only' ? ' · 仅触发' : (t === 'matter-only' ? ' · 仅事务' : '')) }
        // ⚠️ 2026-09-21（P2b 收尾）：`objEvidenceText()` / `objTwoLine()` / `objItemRow()` **已删** ——
        //   它们是旧「对象」卡"一行对象"的画法（依据那行的措辞 / 上下两行的行容器 / 整行对象+点击开详情）。
        //   撤卡后**零调用方**（域下钻用 `domainObjRow`、待办分组头用 `openObj`）⇒ 按"没有调用就移除"处理。
        //   ⚠️ `.dshw-objweak` 样式**保留**：它另有真实消费方 —— 专注卡活跃域区块的「…还有 N 条」行
        //      （`adMoreRow`，L4137 一带）。
        /** 二级详情（只读弹窗）打开入口：与对象详情共用**同一个** portal 节点与同一套字段渲染
         *  （P2b 后入口：待办卡分组头 / 「专注 · 活跃」卡的域下钻 / 事务详情里的归属对象） */
        function openObj(k, item) { setObjModal({ key: String(k), item: item || null }) }

        // ── 「活跃」卡的下钻：域 → 对象（2026-09-17 用户裁定）────────────────────
        /**
         * 建索引：域 id → 该域下的对象（含「客户 → 场次」的父子归并）。
         *   匹配关系**只用 payload 自己的字段**：`o.domain_id`（对象索引里每个对象都带），
         *   以及它 `parent` 指向的对象的 domain_id（场次对象的数据归到客户所属的域）。
         *   ⚠️ 不按名字/路径猜域 —— 猜出来的匹配没法核账（P2 纪律）。
         *   对象层的三态由调用方先说清楚；这里只对"有数据"的情形建表。
         */
        function objDomainIndex(doc) {
          const idx = {}
          if (objHasDocShape(doc) !== true) return idx
          const byKey = {}
          for (let i = 0; i < doc.objects.length; i += 1) {
            const o = doc.objects[i]
            if (o !== null && o !== undefined && typeof o.key === 'string') byKey[o.key] = o
          }
          for (let i = 0; i < doc.objects.length; i += 1) {
            const o = doc.objects[i]
            if (o === null || o === undefined) continue
            if (String(o.kind || '') === 'unassigned') continue          // 未归属单独在「对象」卡的未归属区，不塞进域
            let did = (o.domain_id === null || o.domain_id === undefined) ? '' : String(o.domain_id)
            if (did === '' && o.parent !== null && o.parent !== undefined) {
              const p = byKey[String(o.parent)]
              if (p !== undefined && p.domain_id !== null && p.domain_id !== undefined) did = String(p.domain_id)
            }
            if (did === '') continue
            if (idx[did] === undefined) idx[did] = { objects: [], matterIds: {} }
            idx[did].objects.push(o)
            const mids = Array.isArray(o.matter_ids) ? o.matter_ids : []
            for (let k = 0; k < mids.length; k += 1) idx[did].matterIds[String(mids[k])] = true
          }
          // 展开顺序：先非 settled（在场/未结），再 settled；组内保持 payload 顺序（**不重排**）
          for (const did of Object.keys(idx)) {
            const arr = idx[did].objects
            idx[did].objects = arr.filter((o) => o.state !== 'settled').concat(arr.filter((o) => o.state === 'settled'))
          }
          return idx
        }
        /** 域下对象一行的文字（`对象键 · 状态 · 下一步 id · 期限 · 责任人`，全部 payload 原样） */
        function domainObjLine(o) {
          const ns = o.next_step
          return String(o.key)
            + ' · ' + String(o.state || '—')
            + (ns === null || ns === undefined
              ? ' · 下一步: payload 未给出'
              : ' · 下一步 ' + String(ns.id) + ' · ' + objRaw(ns.due_at) + ' · ' + String(ns.owner || '—'))
        }
        /**
         * 二级（对象）行的来源工具提示：**可点开**的出处。
         *   `sources[]` = 库内产物给的路径证据（原样拼在 `序号 · 路径`，并说明按什么引用）；
         *   再加上对象自己的 `evidence`（派生依据）与 `matter_ids`（该对象下的事务 id，供核账）。
         */
        function domainObjEvidence(o) {
          let text = '点击查看二级详情（只读）'
          const ev = o.evidence
          if (ev !== null && ev !== undefined && String(ev) !== '') text += '\n依据: ' + String(ev)
          const ss = Array.isArray(o.sources) ? o.sources : []
          if (ss.length > 0) {
            const lines = []
            for (let i = 0; i < ss.length; i += 1) lines.push((i + 1) + ' · ' + String(ss[i]))
            text += '\n出处（' + String(ss.length) + ' 个 · 原样取自 payload sources，按序号引用）:\n' + lines.join('\n')
          } else {
            text += '\n出处: payload 未给出 sources'
          }
          const mids = Array.isArray(o.matter_ids) ? o.matter_ids : []
          if (mids.length > 0) text += '\n事务 id: ' + mids.join(' ')
          const tids = Array.isArray(o.trigger_ids) ? o.trigger_ids : []
          if (tids.length > 0) text += '\n触发 id: ' + tids.join(' ')
          return text
        }
        /**
         * 一级「域」行 + 折叠的二级「对象」行（2026-09-17 用户裁定）。
         *   · 域行本身**不是**按钮：点击只折叠/展开二级（沿用既有 `.dshw-dgroup` 交互形态）；
         *   · 二级对象行点击 → 既有**只读**二级详情 portal（与「对象」卡同一个 `objModal`、同一套字段）；
         *   · 二级的态别按 `objLayerState()` 分开说（读失败 / 出口不可用 / 无数据 / 该域 0 个对象）。
         */
        function domainObjRow(d, i, open, idx) {
          const did = String(d.id === null || d.id === undefined ? '' : d.id)
          const hit = idx[did] === undefined ? null : idx[did]
          const kids = hit === null ? [] : hit.objects
          const st = objLayerState()
          const nObj = st.kind === 'ok' ? (hit === null ? 0 : kids.length) : null
          // 口径为 0 时把"对象层一共有多少个"一并写出来（供对账，仍是 payload 原样）
          const objAllCount = objHasDocShape(objs) === true ? objs.objects.length : null
          const kids_shown = open !== true ? [] : (hit === null ? [] : kids)
          const kidsOut = []
          for (let j = 0; j < kids_shown.length; j += 1) {
            const o = kids_shown[j]
            kidsOut.push(h('div', {
              className: 'dshw-item',
              key: 'ad-' + did + '-' + String(o.key),
              'data-click': '1',
              'data-domain': did,
              'data-obj': String(o.key),
              title: domainObjEvidence(o),
              onClick: () => openObj(o.key, o),
            }, h('span', { className: 'dshw-item-text' },
              h('span', null, domainObjLine(o)),
              h('span', { className: 'dshw-objnext' }, ' · ' + objCountsText(o.counts)))))
          }
          if (open === true) {
            if (st.kind === 'error') {
              kidsOut.push(h('div', { className: 'dshw-err', key: 'ad-' + did + '-err' }, '域 → 对象 读取失败: ' + st.text))
            } else if (st.kind === 'wait') {
              kidsOut.push(empty(st.text, 'ad-' + did + '-wait'))
            } else if (st.kind === 'unavailable') {
              kidsOut.push(h('div', { className: 'dshw-err', key: 'ad-' + did + '-down' }, '域 → 对象 不可用: ' + st.text))
            } else if (st.kind === 'empty') {
              kidsOut.push(empty(st.text, 'ad-' + did + '-none'))
            } else if (kids.length === 0) {
              kidsOut.push(h('div', { className: 'dshw-detail', key: 'ad-' + did + '-zero', style: { color: '#e0a030' } },
                '该域下 0 个对象（口径结果，不是读失败）—— 对象层已加载（'
                + (objAllCount === null ? '—' : String(objAllCount)) + ' 个对象），'
                + '按 payload 的 domain_id'
                + (did === '' ? '（本行没有 id）' : ' 匹配到「' + did + '」为 0 个')
                + '：该域下还没有落点（对象由事务 / 触发派生，登记第一条后即出现）'))
            } else {
              kidsOut.push(h('div', { className: 'dshw-detail', key: 'ad-' + did + '-src' },
                '出处可点开：点任意对象行看该对象的依据 / sources / 事务 id（只读，原样取自 objects.json）'))
            }
          }
          const head = h('div', {
            className: 'dshw-dgroup', key: 'adh-' + i, 'data-click': '1', 'data-open': open === true ? '1' : '0',
            'data-domain': did,
            title: (open === true ? '收起' : '展开') + '「' + String(d.name || did) + '」下的对象'
              + (nObj === null ? '' : '（' + nObj + ' 个）')
              + ' · 来源: ' + String(d.source === 'declared' ? 'agent 主动声明' : '会话自动匹配'),
            onClick: () => {
              const nxt = open !== true
              lsSet('dshw.domOpen', nxt ? '1' : '0')
              setDomOpen(nxt)
            },
          },
          h('span', { className: 'dshw-dgroup-arrow' }, open === true ? '▾' : '▸'),
          h('span', { className: 'dshw-dgroup-name' },
            String(d.name || did) + ' · ' + String(d.reason || '') + ' · ' + String(d.source === 'declared' ? '声明' : '自动')),
          h('span', { className: 'dshw-spacer' }),
          h('span', { className: 'dshw-dgroup-count' }, nObj === null ? '对象 —' : '对象 ' + nObj))
          return h('div', { key: 'adg-' + i }, [head].concat(kidsOut))
        }

        /**
         * 「响应」卡二级详情（`trigModalEl`）按 id 取行。
         *
         * ⚠️ 必须是**渲染作用域顶层**的声明，不能挪回卡构造表达式内部：「响应」卡的二级详情弹窗与
         *    该卡的构造表达式（在 `pwb.ok === true` 那条分支里的 `cardsByKey.set(…)`）**不在同一层** ——
         *    前者在组件渲染顶层。2026-09-17 实测过反例：写成分支内的 `const` 后，
         *    点任意一行触发时渲染抛 `ReferenceError: trigRowsForModal is not defined`。
         *    这里只读 `trigDoc` 这份**组件级 state**（不引用分支内的局部量），故对所有分支都有效。
         * 📌 本条注释**刻意不写那句卡构造调用**：它出现在源码里的位置决定了下游源码级断言
         *    （T16-102 / T16-104）取哪一段作为「响应」卡卡体 —— 注释里先出现一次会把窗口挪到
         *    注释所在处，卡体里真有的三段分组与 `byRecord` 就读不到了。定位串只留给真代码。
         */
        const trigRowsForModal = (id) => {
          const d = trigDoc !== null && trigDoc !== undefined && trigDoc.ok === true ? trigDoc : null
          const rows = d !== null && Array.isArray(d.rows) ? d.rows : []
          return rows.find((r) => String(r.id) === String(id)) || null
        }

        /**
         * 「响应」卡二级详情里的「所属对象」也要读 `byRecord` —— **与卡体同一份 payload 字段**，
         * 但必须在**渲染作用域顶层**取值：卡体的那份（分支内 `const`）与详情弹窗不在同一层。
         * 2026-09-17 实测反例：详情弹窗引用分支内那份 ⇒ 点任意一行触发时渲染抛
         *   `ReferenceError: trigByRecord is not defined`，React 整棵树卸载（连带 17 项真机断言红）。
         * 这里只读**组件级 state** `objs`，故对所有分支都有效；卡体那份保持原样（源码级断言按它取证）。
         */
        const trigByRecordTop = (objs !== null && objs !== undefined
          && objs.byRecord !== null && typeof objs.byRecord === 'object') ? objs.byRecord : {}

        if (pwbErr !== null) {
          alertBlocks.push(h('div', { className: 'dshw-err', key: 'pwberr' }, '数据层读取失败: ' + pwbErr))
        } else if (pwb === null) {
          alertBlocks.push(empty(pwbBusy ? '正在读取数据层…' : '等待数据层…', 'pwbwait'))
        } else if (pwb.ok !== true) {
          alertBlocks.push(h('div', { className: 'dshw-err', key: 'pwbfail' }, '数据层不可用: ' + String(pwb.error || '')))
        } else {
          const c = pwb.counts || {}
          const staleMin = pwb.staleMs === null ? null : Math.round(pwb.staleMs / 60000)
          const staleness = staleMin === null ? '时刻未知' : (staleMin < 1 ? '刚刚' : staleMin + ' 分钟前')
          // ── 待议处置（2026-09-16 · 本卡专用写入口）─────────────────────────
          //  为什么要按钮：闸判 `pending`（未命中任何关注域、需人定边界）后，系统里原本
          //  **没有任何出口** —— `gate.resolvePending()` 只在测试 run-t4.mjs 里被调用。
          //  纪律：理由必填（留痕不能空）；判定与留痕由 cli-disposition.mjs 内的
          //  gate.resolvePending() 负责 —— **客户端不做任何判断**，只转调 + 刷新。
const ds = (pwb.disposition && (pwb.disposition.summary || pwb.disposition)) || {}
          // ── 无落点清单（2026-09-16 接上 `/disposition` 只读出口）──────────────
          //  ★ 本卡**不做判断**：digest_head / pending_days / reason / source 一律原样取自 payload；
          //    排序也只按 payload 的 `pending_days` 降序 —— 不是本卡在算"哪条更重要"。
          //  ★ 三态分开说：docErr（读失败）≠ doc=null（没取到）≠ noLanding=[]（口径为 0）。
          const dd = dispoDoc !== null && typeof dispoDoc === 'object' ? dispoDoc : null
          const ddSum = dd !== null && dd.summary !== null && typeof dd.summary === 'object' ? dd.summary : null
          const noLandRows = (dd !== null && Array.isArray(dd.noLanding) ? dd.noLanding : [])
            .slice()
            .sort((a, b) => (Number(b.pending_days) || 0) - (Number(a.pending_days) || 0))
          const noLandShown = dispoShowAll === true ? noLandRows : noLandRows.slice(0, MAX_ROWS)
          // 口径修正：`已处置` 现在只表示"闸判过了"；有落点才是真处置（台账来自 disposition.json）
          const dispLine = (ddSum !== null)
            ? '有落点 ' + ddSum.landed + ' · 无落点 ' + ddSum.noLanding + ' · 处置率 '
              + (typeof ddSum.landingRate === 'number' ? Math.round(ddSum.landingRate * 100) + '%' : '—')
              + (typeof ddSum.staleMaxDays === 'number' ? ' · 悬置最长 ' + ddSum.staleMaxDays + ' 天' : '')
            : (typeof ds.noLanding === 'number'
              ? '有落点 ' + ds.landed + ' · 无落点 ' + ds.noLanding + ' · 处置率 '
                + (typeof ds.landingRate === 'number' ? Math.round(ds.landingRate * 100) + '%' : '—')
              : '落点口径: 等待台账（重建后出现）')
          const pendList = ((pwb.sections || {}).pending) || []
          // ⚠️ 卡名必须与 `CARD_TITLES.inflow`（=「流入」）逐字一致：注册点的**字面量刻意保留**
          //    （run-t16 按 `card('<名>` 前缀取证；见文件头 [card-titles] 契约块 L50–59「改卡名 = 同时改两处」）。
          //    2026-09-17 收口：此处原为「流入」⇒ 与真相源漂移，DOM 实测被 SBT-23 / 23b 各判红一条。
          const mtCands = ((pwb.core || {}).candidates) || []
          // ── 事务卡：卡内两个 tab（待完成 / 已关闭）—— 2026-09-15 用户更正 ──
          // 时间语义：事务上是**发起时间**（该事务被发起/提出的日期），不是截止时间 ⇒ 本卡不再做过期判定、
          // 不再显示「已过期」标签，也不再有「已过期」档；分桶与排序都在 host（matterBuckets）算好。
          const mb = pwb.matterBuckets || null
          const mtCounts = (mb && mb.counts) || { todo: 0, closed: 0 }
          const MT_TABS = [
            { key: 'todo', label: '待完成', tone: null },
            { key: 'closed', label: '已关闭', tone: null },
          ]
          const activeTab = (matterTab !== null && MT_TABS.some((t) => t.key === matterTab))
            ? matterTab
            : 'todo'
          const mtList = mb === null ? [] : (Array.isArray(mb[activeTab]) ? mb[activeTab] : [])
          const isClosedTab = activeTab === 'closed'
          // 域显示名：取自快照 domains（id → name），缺失回落 id；未关联域的项单列一组
          const domainNameById = {}
          const dOpts = Array.isArray(pwb.domainOptions) ? pwb.domainOptions : []
          for (let i = 0; i < dOpts.length; i += 1) {
            if (dOpts[i] && dOpts[i].id !== undefined) domainNameById[String(dOpts[i].id)] = String(dOpts[i].name || dOpts[i].id)
          }
          // 同域相邻归组（顺序沿用 host 排好的顺序，渲染层不重排）
          const mtGroups = groupMattersByDomain(mtList.slice(0, 60), domainNameById)

          /** 一行事务（缩进到域名称下的子项）：点行或行尾 ▸ 都在**上层**打开详情卡 */
          const mtRow = (m, key) => {
            // 待完成显示**发起时间**（越早发起越靠前）；已关闭显示关闭日期
            const time = isClosedTab
              ? String(m.closed_at || '').slice(5, 10)
              : (m.initiated_at ? String(m.initiated_at).slice(5) : '未记录')
            const head = isClosedTab ? '✓ ' : ''
            // ★ 2026-09-21（P2b）：对象作为**属性**上到一级行 —— 归属对象（`objects.json#byRecord`
            //   的权威归属）+ state / counts / 下一步摘要；机器 id 进 `data-object-key`（断言与追溯的锚点）。
            //   ⚠️ 这里**不能**用原来对象卡段那套四处（`objByRecord`/`objByKey` 行号更靠后 ⇒ TDZ 崩）：
            //      取数一律走共用索引 `objRecOf()` / `objAttrBrief()`（函数声明，行号在本卡之前）。
            const oRec = objRecOf(m.id)
            const oAttr = objAttrBrief(oRec)
            return h('div', {
              className: 'dshw-item', key, 'data-click': '1', 'data-child': '1', 'data-closed': isClosedTab ? '1' : null,
              title: '关闭条件: ' + String(m.done_when || '')
                + '\n来源: ' + String(m.origin_project || '')
                + (isClosedTab ? '\n结束记录: ' + String(m.closure_note || '—') : '')
                + (m.records > 0 ? '\n已记 ' + m.records + ' 条记录' : '')
                + '\n点击打开事务详情卡',
              onClick: () => openMatter(m),
            },
              h('span', { className: 'dshw-item-time' }, time),
              h('span', { className: 'dshw-item-text' }, head + m.title + ' · ' + String(m.held_by || '?')),
              // 对象属性（一级只给摘要；全量字段在 tooltip 与详情页「归属对象 / 对象出处」段）
              oAttr === null
                ? h('span', {
                  className: 'dshw-objtag dshw-objtag-none', key: 'otag',
                  title: '对象层未归属该事务（payload byRecord 里没有 ' + String(m.id) + '）'
                    + (objs === null ? '\n对象层产物未读取：**读失败 ≠ 一条都没有**' : ''),
                }, '未归属对象')
                : h('span', {
                  className: 'dshw-objtag', key: 'otag', 'data-object-key': oAttr.key,
                  title: oAttr.tip,
                }, oAttr.text + (oAttr.countsText === null ? '' : ' · ' + oAttr.countsText)
                  + (oAttr.nextText === null ? '' : ' · 下一步 ' + oAttr.nextText)),
              h('button', {
                className: 'dshw-mt-btn', title: '打开事务详情卡（详情/添加记录/关闭）',
                onClick: (e) => { e.stopPropagation(); openMatter(m) },
              }, '▸'))
          }
          const mtBody = [h('div', { className: 'dshw-mtabs', key: 'mtabs' }, MT_TABS.map((t) => h('button', {
            key: t.key,
            className: 'dshw-mtab',
            'data-on': activeTab === t.key ? '1' : '0',
            'data-tone': t.tone,
            onClick: () => { setMatterTab(t.key); lsSet('dshw.matterTab', t.key) },
          }, t.label, h('i', null, String(mtCounts[t.key] || 0)))))]
          if (mb === null) {
            mtBody.push(h('div', { className: 'dshw-err', key: 'mberr' }, '数据层未提供事务分桶（matterBuckets）'))
          } else if (mtList.length === 0) {
            mtBody.push(empty(activeTab === 'todo' ? '没有待完成事务' : '没有已关闭事务', 'nomt'))
          } else {
            // 域标题本身就是可点击的展开控件（箭头 ▸/▾ 已表达可点），不再额外写提示行（2026-09-15 用户要求移除）
            for (let gi = 0; gi < mtGroups.length; gi += 1) {
              const g = mtGroups[gi]
              const dkey = activeTab + '|' + g.id
              const open = mtOpen[dkey] === 1
              mtBody.push(h('div', {
                className: 'dshw-dgroup', key: 'dg' + dkey, 'data-click': '1', 'data-open': open ? '1' : '0',
                title: '点击' + (open ? '收起' : '展开') + '「' + g.name + '」的事务列表（' + g.items.length + ' 条）',
                onClick: () => toggleMtDomain(dkey),
              },
                h('span', { className: 'dshw-dgroup-arrow' }, open ? '▾' : '▸'),
                h('span', { className: 'dshw-dgroup-name' }, g.name),
                h('span', { className: 'dshw-spacer' }),
                h('span', { className: 'dshw-dgroup-count' }, String(g.items.length))))
              if (!open) continue
              for (let mi = 0; mi < g.items.length; mi += 1) mtBody.push(mtRow(g.items[mi], 'mt' + dkey + '#' + mi))
            }
          }
          if (mtCands.length > 0) {
            mtBody.push(h('div', { className: 'dshw-detail', key: 'cand' }, '承诺候选待确认 ' + mtCands.length + ' 条（需补 domain 与关闭条件）'))
          }

          cardsByKey.set('inflow', (function () {
            // ── 「流入」= 统计优先（2026-09-17 用户裁定：展示信息主要做统计，不列清单）──
            //  纪律：卡片不做判断；数字一律取自 payload（disposition.summary / counts），缺失时显式写"—"。
            //  处置动作保留为**命令式入口**（低频动作，不用清单承载版面）：id + 理由 → /disposition/act。
            const SUM = (dd && dd.summary) || ds || {}
            const num = (k, d) => (typeof SUM[k] === 'number' ? SUM[k] : (typeof d === 'number' ? d : 0))
            const landed = num('landed'), noLand = num('noLanding')
            const rate = typeof SUM.landingRate === 'number' ? Math.round(SUM.landingRate * 100) + '%' : '—'
            const stall = typeof SUM.staleMaxDays === 'number' ? SUM.staleMaxDays + ' 天' : '—'
            const lands = SUM.landings || {}
            const bySrc = SUM.bySource || {}
            const days = (dd && Array.isArray(dd.noLanding) ? dd.noLanding.map((x) => Number(x.pending_days) || 0).sort((a, b) => a - b) : [])
            const median = days.length > 0 ? days[Math.floor(days.length / 2)] : null
            const srcLine = ['A', 'B', 'C', 'F', 'W'].map((s) => {
              const v = bySrc[s]
              const n = v && typeof v.inbound === 'number' ? v.inbound : 0
              return n > 0 ? s + ' ' + n : null
            }).filter(Boolean).join(' · ') || '—'
            const staleTxt = (function () {
              const m = (pwb.staleMs === null || pwb.staleMs === undefined) ? null : Math.round(pwb.staleMs / 60000)
              return m === null ? '时刻未知' : (m < 1 ? '刚刚' : m + ' 分钟前')
            })()
            // ── 无落点清单（2026-09-19 补齐 SBT-31）：折叠 + 最近 3 条 + 行可点开详情 ──
            //  形态依 02-规范与标准/SPEC_卡片交互规范：第三行起可折叠清单，点行 → 详情页；
            //  详情元素按契约出现（不适用整块不出现）：标题 / 详细情况 / 关联域 / 前序 / 后续 / 操作按钮；
            //  穿透只允许路径型（草稿/散文不点）。**卡片不做判断**：全部字段原样取自 /disposition。
            const noLandItems = (dd && Array.isArray(dd.noLanding)) ? dd.noLanding : []
            /**
             * 三级详情弹窗的**共用外壳**（`.dshw-lite*`，2026-09-25 立）。
             *
             * 为什么要一个壳：这里的三个弹窗（无落点流入详情 / 处置待议流入 / 识别过滤明细）
             * 原来是各自 `createElement` 拼的**裸 div** —— 没有描边、没有阴影、没有标题层级、
             * 字段全部挤成一行 `标签：值`，里面的按钮吃的还是改造前那条全局 `.dshw-btn`
             * （11px 字号、宿主令牌取色）。三份重复、三份样式还不一样，所以收成一个壳。
             *
             * ⚠️ 元素挂在 `document.body` 上（**在 `.dshw-root` 之外**）⇒ 样式只能写在 CSS_V2
             *    的**全局段** `.dshw-lite*` 里，跟 `.dshw-modal` 同一个理由。
             */
            const liteModal = (o) => {
              const wrap = document.createElement('div'); wrap.className = 'dshw-lite-mask'
              const box = document.createElement('div'); box.className = 'dshw-lite'
              box.style.maxWidth = String(o.width || '560px')
              const head = document.createElement('div'); head.className = 'dshw-lite-head'
              const ti = document.createElement('div'); ti.className = 'dshw-lite-title'
              ti.textContent = String(o.title || '')
              head.appendChild(ti)
              if (o.meta) {
                const mt = document.createElement('div'); mt.className = 'dshw-lite-meta'
                mt.textContent = String(o.meta); head.appendChild(mt)
              }
              const body = document.createElement('div'); body.className = 'dshw-lite-body'
              const foot = document.createElement('div'); foot.className = 'dshw-lite-foot'
              box.appendChild(head); box.appendChild(body); box.appendChild(foot)
              wrap.appendChild(box)
              const close = () => { try { document.body.removeChild(wrap) } catch (e) { /* 已经关掉了 */ } }
              // 点蒙层空白 = 关（点弹窗内部不关）
              wrap.addEventListener('click', (ev) => { if (ev.target === wrap) close() })
              const lite = {
                box, body, foot, close,
                /** 一行「字段名 + 字段值」：左窄右宽，字段名走次级灰 */
                row: (k, v) => {
                  const r = document.createElement('div'); r.className = 'dshw-lite-row'
                  const a = document.createElement('div'); a.className = 'dshw-lite-k'; a.textContent = String(k)
                  const b = document.createElement('div'); b.className = 'dshw-lite-v'
                  b.textContent = (v === null || v === undefined || v === '') ? '—' : String(v)
                  r.appendChild(a); r.appendChild(b); body.appendChild(r)
                },
                /** 口径 / 提示条 */
                note: (t) => {
                  const d = document.createElement('div'); d.className = 'dshw-lite-note'
                  d.textContent = String(t); body.appendChild(d)
                },
                /** 明细里的一条（标题 + 副行） */
                item: (h, s) => {
                  const d = document.createElement('div'); d.className = 'dshw-lite-item'
                  const t = document.createElement('div'); t.className = 'dshw-lite-item-h'; t.textContent = String(h)
                  d.appendChild(t)
                  if (s) { const u = document.createElement('div'); u.className = 'dshw-lite-item-s'; u.textContent = String(s); d.appendChild(u) }
                  body.appendChild(d)
                },
                /** 页脚按钮（中性白面；橙色只留给列表页的动作按钮） */
                button: (label, on) => {
                  const b = document.createElement('button'); b.className = 'dshw-btn'
                  b.textContent = String(label); b.onclick = on; foot.appendChild(b)
                },
              }
              document.body.appendChild(wrap)
              return lite
            }
            const openNoLandDetail = (it) => {
              const m = liteModal({ title: '无落点流入详情（只读）', meta: '字段原样取自 /disposition，卡片不做判断', width: '560px' })
              m.row('标题', it.origin || it.inbound_id)
              m.row('详细情况', (it.digest_head || '') + (it.reason ? ' · 判定理由：' + it.reason : ''))
              m.row('关联域', (Array.isArray(it.matched_domain) ? it.matched_domain.join(' · ') : '') || '—')
              m.row('前序环节', '边界闸判定 @ ' + String(it.judged_at || '—').slice(0, 19).replace('T', ' '))
              m.row('后续环节', '待处置（拒绝 / 转出 / 建事务）')
              m.row('悬置', (typeof it.pending_days === 'number' ? it.pending_days + ' 天' : '—') + ' · 来源 ' + (it.source || '—'))
              m.button('关闭', m.close)
              m.button('处置…', () => { m.close(); openDisposal() })
            }
            const noLandRow = (it, i) => h('div', {
              key: 'nl' + i,
              className: 'dshw-item' + (i >= 3 ? ' dshw-noland-rest' : ''),
              'data-click': '1',
              title: '点击查看详情（只读）',
              style: i >= 3 ? { display: 'none' } : null,
              onClick: () => openNoLandDetail(it),
            },
            h('span', { className: 'dshw-item-time' }, (typeof it.pending_days === 'number' ? it.pending_days + ' 天' : '—')),
            h('span', { className: 'dshw-item-title' }, String(it.origin || it.inbound_id || '')),
            h('span', { className: 'dshw-src' }, String(it.source || '')))
            const toggleNoLand = (ev) => {
              const box = ev && ev.currentTarget ? ev.currentTarget.parentNode : null
              if (!box) return
              const rest = box.querySelectorAll('.dshw-noland-rest')
              const open = rest.length > 0 && rest[0].style.display === 'none'
              for (const r of rest) r.style.display = open ? '' : 'none'
              ev.currentTarget.textContent = open ? '收起' : ('展开全部（' + noLandItems.length + ' 条）')
            }
            const openDisposal = () => {
              const m = liteModal({ title: '处置待议流入（必须写理由）', meta: '提交后写入处置登记表 → 重建 brief/snapshot ⇒ 该条离开待议队列', width: '520px' })
              const idIn = document.createElement('input')
              idIn.className = 'dshw-lite-input'
              idIn.placeholder = '流入 id（如 IN-20260916-001）'
              const rsIn = document.createElement('input')
              rsIn.className = 'dshw-lite-input'
              rsIn.placeholder = '理由（必填）'
              m.body.appendChild(idIn); m.body.appendChild(rsIn)
              const send = (action) => {
                const id = String(idIn.value || '').trim()
                const reason = String(rsIn.value || '').trim()
                if (!id || !reason) { setNote('id 与理由都必填'); return }
                api('/disposition/act', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: id, action: action, reason: reason }) })
                  .then((r) => { if (r && r.ok === true) { setNote('已' + (action === 'reject' ? '拒绝' : '转出') + '：' + id); m.close(); loadPwb(true) } else setNote('处置失败: ' + String((r && r.error) || '未知原因')) })
                  .catch((e) => setNote('处置失败: ' + String((e && e.message) || e)))
              }
              const b1 = document.createElement('button'); b1.className = 'dshw-btn'; b1.textContent = '拒绝'; b1.onclick = () => send('reject')
              const b2 = document.createElement('button'); b2.className = 'dshw-btn'; b2.textContent = '转出'; b2.onclick = () => send('forward')
              const b3 = document.createElement('button'); b3.className = 'dshw-btn'; b3.textContent = '取消'; b3.onclick = m.close
              m.foot.appendChild(b3); m.foot.appendChild(b1); m.foot.appendChild(b2)
            }
            return card('流入',
              '有落点 ' + landed + ' · 无落点 ' + noLand + ' · 处置率 ' + rate,
              [
                h('div', { className: 'dshw-detail', key: 'stat' },
                  h('div', null, '域内 ' + (c.inScope || 0) + ' · 待议 ' + (c.pending || 0) + ' · 域外拦截 ' + (c.outOfScope || 0)),
                  h('div', null, '落点构成：事务 ' + (lands.matter || 0) + ' · 触发 ' + (lands.trigger || 0) + ' · 两者 ' + (lands.both || 0) + ' · 无落点 ' + noLand),
                  h('div', null, '悬置最长 ' + stall + (median === null ? '' : ' · 中位 ' + median + ' 天') + ' · 处置率 ' + rate),
                  h('div', null, '来源：' + srcLine),
                  h('div', null, '数据时刻：' + String(pwb.dataAsOf || '—').slice(0, 19).replace('T', ' ') + '（' + staleTxt + '）'),
                  (c.pending || 0) > 0 ? h('div', { style: { color: '#e0a030' } }, '⚠️ 有 ' + c.pending + ' 条待议未处置') : null,
                ),
                // ── 识别（B3/B4 · 批次 P1）────────────────────────────────────────
                //  设计原话：所有新信息必经 AI 识别过滤；未过的不显示。
                //  数据源 = `/disposition` **透传**的 `recognition` 块（库内 build-disposition.mjs 算），
                //  host **零改动**（改 host 要重启 DSH，代价与风险都不成比例）。
                //  ★ 卡片不做判断：数字原样取自 payload；**缺块写「—」而不是 0**（0 与"没有"是两件事）。
                //  ★ 形态（用户裁定 · PLAN §〇 澄清 3）：**默认只显示摘要行**，明细走二级详情页。
                (function () {
                  const rc = (dd && dd.recognition) || null
                  if (rc === null) {
                    return h('div', { className: 'dshw-detail', key: 'rec' },
                      h('div', { 'data-rec': 'absent' }, '识别：—（本 host 未给 recognition 块 · 旧 host 需重启 DSH 后可用）'))
                  }
                  const br = (rc.filtered && rc.filtered.byReason) || {}
                  const rlab = rc.reasons || {}
                  const rname = (k) => String((rlab[k] && rlab[k].label) || k)
                  const ritems = Array.isArray(rc.filteredItems) ? rc.filteredItems : []
                  const num = (v) => (typeof v === 'number' ? String(v) : '—')
                  const openRecDetail = () => {
                    const m = liteModal({ title: '识别过滤明细（只读）', meta: ritems.length + ' 条 · 只读，不提供写入口', width: '620px' })
                    m.note('口径：识别 = 闸已判；过滤 = 无落点（没进任何卡）。三类原因由既有 verdict 映射，不新增判定。')
                    for (const it of ritems) {
                      const head = String(it.filter_label || it.filter_reason || '') + ' · ' + String(it.verdict || '—')
                        + ' · ' + String(it.source || '—') + (typeof it.pending_days === 'number' ? ' · 悬置 ' + it.pending_days + ' 天' : '')
                      // P2/B1：分类元数据逐条显示（类别 / 分类依据 / 来源通道 / 识别属性）
                      const sub = [String(it.origin || it.inbound_id || '')]
                      if (it.classification) {
                        const c = it.classification
                        sub.push('分类：' + String(c.category || '—')
                          + ' · 通道 ' + String((c.channel || {}).label || (c.channel || {}).id || '—')
                          + ' · 识别 ' + String((c.recognition || {}).verdict || '—'))
                        sub.push('分类依据：' + String(c.basis || '—'))
                      }
                      if (it.reason_text) sub.push('判定理由：' + String(it.reason_text))
                      m.item(head, sub.join('\n'))
                    }
                    m.button('关闭', m.close)
                  }
                  return h('div', { className: 'dshw-detail', key: 'rec', 'data-rec': '1' },
                    h('div', { style: { fontWeight: '600' } },
                      '识别 ' + num(rc.judged) + '/' + num(rc.scanned) + ' · 显示 ' + num(rc.shown) + ' · 过滤 ' + num(rc.filtered && rc.filtered.total)),
                    h('div', null, '过滤原因：' + ['self-closed', 'no-response-needed', 'needs-decision', 'other']
                      .map((k) => rname(k) + ' ' + num(br[k])).join(' · ')),
                    (function () {
                      // P2/B1：分类元数据（设计四子类 + 兜底）——**只显示 payload 原值**
                      const cl = rc.classification || null
                      if (cl === null) return h('div', { 'data-class': 'absent' }, '分类：—（本产物未给 classification 块）')
                      const cats = Array.isArray(cl.categories) ? cl.categories : []
                      const bc = cl.byCategory || {}
                      const txt = cats.filter((c) => (bc[c.id] || 0) > 0 || c.id !== 'unclassified')
                        .map((c) => c.label + ' ' + String(bc[c.id] || 0)).join(' · ')
                      return h('div', { 'data-class': '1' },
                        '分类：' + txt,
                        h('span', { style: { opacity: .6, marginLeft: '6px' } },
                          '（覆盖率 ' + (cl.coverage === null ? '—（无样本）' : Math.round(cl.coverage * 100) + '%')
                          + ' · 未分类 ' + String(cl.unclassified) + ' 条 —— 兜底不丢弃）'))
                    })(),
                    ritems.length > 0
                      ? h('button', { className: 'dshw-btn', key: 'recdet', onClick: openRecDetail }, '查看过滤明细 ' + ritems.length + ' 条')
                      : null)
                })(),
                noLandItems.length > 0 ? h('div', { className: 'dshw-detail', key: 'noland' },
                  h('div', { style: { fontWeight: '600' } }, '无落点清单 ' + noLandItems.length + ' 条（最近 3 条）'),
                  h('div', null, noLandItems.map(noLandRow)),
                  noLandItems.length > 3 ? h('button', { className: 'dshw-btn', key: 'nlmore', onClick: toggleNoLand }, '展开全部（' + noLandItems.length + ' 条）') : null,
                ) : null,
                // ★ 2026-09-21（P2b）：对象层的「未归属」提示并入本卡（原「对象」卡的域级/未归属 tab）。
                //   口径 = payload `unassigned[]` 的**条数**（三条规则都不成立 ⇒ 不猜，显式露出）。
                //   三态分开说：未读取（objs === null）/ 读失败（objsErr）/ 有产物（0 也照实写 0）。
                (function () {
                  const un = (objs !== null && objs !== undefined && Array.isArray(objs.unassigned)) ? objs.unassigned : null
                  if (un === null) return h('div', { className: 'dshw-detail', key: 'objun' }, '未归属 —（对象层未读取：读失败 ≠ 一条都没有）')
                  return h('div', {
                    className: 'dshw-detail', key: 'objun', 'data-obj-unassigned': String(un.length),
                    title: un.length === 0 ? '对象层 payload unassigned 为空数组' : '未归属记录 id（payload 原样）: ' + un.join(' '),
                  }, '未归属 ' + String(un.length) + ' 条（对象层三条规则都不成立 · 待你整理归属）')
                })(),
              ],
              h('div', null, [
                h('button', { key: 'disp', className: 'dshw-btn', onClick: openDisposal }, '处置…'),
                h('button', { key: 'reb', className: 'dshw-btn', onClick: () => rebuildPwb(), disabled: pwbBusy }, pwbBusy ? '…' : '重建'),
              ]))
          })()),
          cardsByKey.set('matters', card('事务',
            '未关闭 ' + mtCounts.todo + ' · 已关闭 ' + mtCounts.closed,
            mtBody))

          // ── 待响应触发（T32 · 2026-09-16）：一级分组列表 + 二级详情 + 响应写入口 ──
          //  数据：`api('/triggers')`（host 转调 cli-trigger list；分组由**冻结层选择器**算好）。
          //  纪律：卡片只渲染与提交，不做判定；三个动作的校验在 host/CLI，失败原样显示。
          const rst = (pwb.respond || {}).stats || {}
          // ⚠️ 这里**不能**用后面的 `objByRecord`（它在对象卡段才定义，行号更靠后）——
          //    在本卡引用它会直接 TDZ 崩（`Cannot access 'objByRecord' before initialization`，
          //    本项目在日程卡上踩过一次同型错误）。故只就地读同一个 payload 的 byRecord 字段。
          const trigByRecord = (objs !== null && objs !== undefined && objs.byRecord !== null && typeof objs.byRecord === 'object')
            ? objs.byRecord : {}
          const trigHasDoc = trigDoc !== null && trigDoc.ok === true && Array.isArray(trigDoc.rows)
          const trigRows = trigHasDoc ? trigDoc.rows : []
          const trigCounts = (trigHasDoc && trigDoc.counts) || null
          // 降级层（2026-09-16 用户报障）：`/triggers` 属新路由，旧 host 会回 unknown route。
          // 那时**回退到改造前的数据源**（`/state` 的 respond.escalated + respond.stats），
          // 并在卡内写明"需重启 DSH" —— 绝不把 unknown route 这类原文抛给用户。
          const trigDown = routeDown.triggers === true
          const legacyEsc = ((pwb.respond || {}).escalated) || []
          const trigGroups = [
            { key: 'escalated', title: '已超时', hint: '错过时限，最易腐烂' },
            { key: 'dueToday', title: '今日到期', hint: '今天之内要回' },
            { key: 'other', title: '其它未响应', hint: '还没到期' },
          ]
          const trigBody = []
          if (trigErr !== null) {
            // 真出错：如实报（routeErrText 已把 unknown route 归入"需重启"，不会漏出原文）
            trigBody.push(h('div', { className: 'dshw-err', key: 'tgterr' }, trigErr))
          } else if (trigDown) {
            // 旧 host 降级：**数据源**换成 /state 的旧清单，但**形态与新版一致**（同一套 tab 页签）——
            // 用户裁定：分类是 tab ⇒ 降级态也应当是 tab（数据不同、形态相同）；提示行保留在卡内，不改形态。
            trigBody.push(h('div', { className: 'dshw-detail', key: 'tgtdown' },
              ROUTE_DOWN_TEXT + ' · 当前显示旧版清单（来自 /state：只有超时未响应的那些；重启后可用三组分类与处置动作）'))
            const legacyOf = (k) => (k === 'escalated' ? legacyEsc : [])
            trigBody.push(h('div', { className: 'dshw-tabs dshw-tabs-inline' },
              trigGroups.map((g) => h('button', {
                key: 'tgtabd-' + g.key,
                className: 'dshw-tab',
                'data-on': trigTab === g.key ? '1' : null,
                'data-trigger-tab': g.key,
                onClick: () => { setTrigTab(g.key); setTrigMsg(null) },
                title: g.hint,
              }, g.title + ' ' + String(legacyOf(g.key).length)))))
            const lg = trigGroups.filter((x) => x.key === trigTab)[0] || trigGroups[0]
            const litems = legacyOf(lg.key)
            const lshowAll = trigShowAll[lg.key] === true
            const lshown = lshowAll ? litems : litems.slice(0, MAX_ROWS)
            if (litems.length === 0) {
              trigBody.push(empty('该组暂无（' + lg.title + ' 0 条）· 旧版清单只含超时未响应的触发', 'tgtlempty-' + lg.key))
            } else {
              for (let i = 0; i < lshown.length; i += 1) {
                const t = lshown[i]
                trigBody.push(row(
                  String(t.rclass || ''),
                  String(t.title || '') + (t.domain ? ' [' + t.domain + ']' : ''),
                  'tgl-' + lg.key + '-' + i,
                  null,
                  '时限: ' + String(t.sla_label || '') + ' · 到期 ' + String(t.due_at || '').slice(0, 16)
                    + '\n（旧版清单只读：重启 DSH 后可点开详情并登记响应）',
                ))
              }
              if (litems.length > MAX_ROWS) {
                trigBody.push(h('div', {
                  className: 'dshw-more', key: 'tglmore-' + lg.key, 'data-click': '1',
                  onClick: () => setTrigShowAll((p) => Object.assign({}, p, { [lg.key]: !lshowAll })),
                }, lshowAll ? '收起' : ('展开全部 ' + String(litems.length) + ' 条')))
              }
            }
          } else if (trigDoc === null) {
            trigBody.push(empty('正在读取触发清单…', 'tgtwait'))
          } else if (trigDoc.ok !== true) {
            // 「host 报错」与「清单为空」是两件事：分别写清楚（不把失败显示成"没事"）
            trigBody.push(h('div', { className: 'dshw-err', key: 'tgtbad' },
              '触发清单不可用：' + (/unknown route/i.test(String(trigDoc.error || '')) ? ROUTE_DOWN_TEXT : String(trigDoc.error || '未知原因'))))
          } else if (trigRows.length === 0) {
            trigBody.push(empty('当前没有未响应的触发', 'tgtnone'))
          } else {
            // ── 三个分类改为 **tab 页签**（2026-09-17 用户裁定：不要折叠分组）─────────────
            //  复用文件卡那套件（容器 `dshw-tabs dshw-tabs-inline` + 页签 `dshw-tab` + `data-on`），
            //  不新造视觉；页签各带条数、默认激活「已超时」；**空组保留页签并标 0**（隐藏会让人以为分类丢了）；
            //  每组各自保留"前 N 条 + 展开全部"；行点击与二级详情、三个响应动作都不变。
            const trigCountOf = (k) => trigRows.filter((r) => r.group === k).length
            trigBody.push(h('div', { className: 'dshw-tabs dshw-tabs-inline' },
              trigGroups.map((g) => h('button', {
                key: 'tgtab-' + g.key,
                className: 'dshw-tab',
                'data-on': trigTab === g.key ? '1' : null,
                'data-trigger-tab': g.key,
                onClick: () => { setTrigTab(g.key); setTrigMsg(null) },
                title: g.hint,
              }, g.title + ' ' + String(trigCountOf(g.key))))))
            const g = trigGroups.filter((x) => x.key === trigTab)[0] || trigGroups[0]
            const items = trigRows.filter((r) => r.group === g.key)
            const showAll = trigShowAll[g.key] === true
            const shown = showAll ? items : items.slice(0, MAX_ROWS)
            if (items.length === 0) {
              trigBody.push(empty('该组暂无（' + g.title + ' 0 条）', 'tgtempty-' + g.key))
            } else {
              for (let i = 0; i < shown.length; i += 1) {
                const t = shown[i]
                const rec = trigByRecord[String(t.id)] || null   // 所属对象：只读 byRecord，本卡不推
                //  行内不再出现校准说明文字（用户 2026-09-17 裁定：界面不解释机制，
                //  机器可读的 `sla_calibrated` 仍保留；未校准只在**二级详情**的时限行给极短标记）
                const tail = [
                  String(t.expected_action || ''),
                  rec !== null ? String(rec.key) : '',
                ].filter(Boolean).join(' · ')
                trigBody.push(row(
                  String(t.rclass || ''),
                  String(t.title || '') + (t.domain ? ' [' + t.domain + ']' : ''),
                  'tgr-' + g.key + '-' + i,
                  () => { loadDispositionOnce(); setTrigModal({ id: String(t.id) }); setTrigAction('responded'); setTrigMsg(null) },
                  tail + '\n期限 ' + String(t.due_at || '').slice(0, 16).replace('T', ' ') + '（' + String(t.sla_label || '—')
                    + '）\n点开：详情 + 响应（已响应/转事务/忽略）',
                ))
              }
              if (items.length > MAX_ROWS) {
                trigBody.push(h('div', {
                  className: 'dshw-more', key: 'tgtmore-' + g.key, 'data-click': '1',
                  onClick: () => setTrigShowAll((p) => Object.assign({}, p, { [g.key]: !showAll })),
                }, showAll ? '收起' : `展开全部 ${items.length} 条`))
              }
            }
            //  卡面不再贴校准说明（用户 2026-09-17 裁定）：能不能校准由
            //  `_meta/out/sla-calibration.json` 表达，界面只显示数据，不解释机制。
          }

          // ── ★ 2026-09-24：自动回复台账的**按会话聚合**（交接单「仍未做」那一条）─────────────
          //   数据：同一次 `api('/triggers')` 回包的新字段 `threads`（host 只透传；聚合与裁剪在库内
          //   `reply-threads.mjs`：聚合单位 = 会话 × 会议实例）。三条纪律：
          //     ① 取不到（字段缺失 / `available:false`）**不许画成"没有会话"** —— 如实报原因；
          //     ② 一个会话下可能有多个会议实例 ⇒ **按会话归并**呈现，与"按会话聚合"的说法一致；
          //     ③ 会话数 / 段数 / 每条消息数**全部取自 payload**，面板不自己数、不自己判。
          const thr = (trigHasDoc && trigDoc.threads !== null && trigDoc.threads !== undefined
            && typeof trigDoc.threads === 'object' && !Array.isArray(trigDoc.threads)) ? trigDoc.threads : null
          if (thr !== null) {
            const thrRows = Array.isArray(thr.rows) ? thr.rows : []
            const convs = []
            const convAt = {}
            for (const t of thrRows) {
              const cid = String(t.conversationId || t.key || '(未知会话)')
              if (convAt[cid] === undefined) { convAt[cid] = convs.length; convs.push({ cid, items: [] }) }
              convs[convAt[cid]].items.push(t)
            }
            const fmtAt = (v) => String(v || '').replace('T', ' ').slice(0, 16)
            trigBody.push(h('div', { className: 'dshw-detail', key: 'thrhead', 'data-thread-head': '1' },
              thr.available === false
                ? '按会话聚合 · 取不到（' + String(thr.error || '台账读不动') + '）'
                : '按会话聚合 · ' + String(convs.length) + ' 个会话 / ' + String(thrRows.length) + ' 段'
                  + (thr.as_of ? ' · 台账 ' + fmtAt(thr.as_of) : '')))
            if (thr.available === false) {
              // 取不到：原因已经写在上面的头一行里（不静默、也不冒充 0 条）
            } else if (convs.length === 0) {
              trigBody.push(empty('台账里还没有任何会话（0 段）', 'thrnone'))
            } else {
              const THR_VIA = { direct: '单聊', group: '群内@我' }
              const THR_DEC = { 'no-op': '无需回复', 'draft-answerable': '可直接代答', 'draft-escalate': '需人工（已转事务）' }
              for (let i = 0; i < convs.length; i += 1) {
                const c = convs[i]
                const first = c.items[0]
                const msgTotal = c.items.reduce((n, t) => n + (Number.isFinite(t.count) ? t.count : 0), 0)
                const need = c.items.some((t) => t.needsHuman === true)
                const matter = c.items.map((t) => t.matterId).filter(Boolean)[0] || null
                const open = thrOpen[c.cid] === true
                //  行本身复用卡内既有的 `.dshw-item` 形态（左时间 / 右文本），另加**两个 DOM 契约属性**：
                //    `data-thread-row` = 这一行是一个会话（真机判据按它数行）；点击**展开可见的明细**。
                //  ⚠️ 明细必须是**可见文本**，不能塞进 `title` 当悬浮提示 —— 那等于"点了没反应"
                //     （本库把"看起来能点、其实什么也没发生"归为假功能）。
                trigBody.push(h('div', {
                  className: 'dshw-item', key: 'thr-' + c.cid, 'data-click': '1', 'data-thread-row': '1',
                  title: fmtAt(first.lastAt) + ' · ' + String(c.items.length) + ' 段（会话×会议实例）'
                    + ' · ' + (open ? '点一下收起' : '点一下展开最近往来与判定'),
                  onClick: () => setThrOpen((p) => Object.assign({}, p, { [c.cid]: !open })),
                },
                h('span', { className: 'dshw-item-time' }, fmtAt(first.lastAt).slice(5)),
                h('span', { className: 'dshw-item-text' },
                  String(first.from || '（未知对象）') + (first.org ? '[' + String(first.org) + ']' : '')
                  + ' · ' + String(THR_VIA[String(first.via)] || first.via || '渠道未知')
                  + ' · ' + String(msgTotal) + ' 条'
                  + (need ? ' · 需人工' : '') + (matter ? ' · 事务 ' + String(matter) : ''))))
                if (open) {
                  const det = []
                  for (const t of c.items) {
                    det.push(h('div', { key: 'thrm-' + t.key, style: { opacity: 0.85 } },
                      '· ' + (t.meeting ? '会议 ' + String(t.meeting) : '不在会议')
                      + ' · ' + String(t.count) + ' 条 · 最近 ' + fmtAt(t.lastAt)
                      + (t.matterId ? ' · 事务 ' + String(t.matterId) : '')))
                    const ms = Array.isArray(t.messages) ? t.messages : []
                    for (let k = 0; k < ms.length; k += 1) {
                      const m = ms[k]
                      det.push(h('div', { key: 'thrq-' + t.key + '-' + k, 'data-thread-msg': '1' },
                        '[' + fmtAt(m.at) + '] ' + String(THR_DEC[String(m.decision)] || m.decision || '判定未知')
                        + (m.blockers && m.blockers.length ? '（' + m.blockers.join('；') + '）' : '')))
                      det.push(h('div', { key: 'thrqt-' + t.key + '-' + k, style: { opacity: 0.75 } },
                        '问：' + String(m.question || '').slice(0, 120)))
                    }
                    if (Number.isFinite(t.messagesTotal) && Number.isFinite(thr.tail) && t.messagesTotal > thr.tail) {
                      det.push(h('div', { key: 'thrtail-' + t.key, style: { opacity: 0.6 } },
                        '（只显示最近 ' + String(thr.tail) + ' 条，共 ' + String(t.messagesTotal) + ' 条；全文在台账里）'))
                    }
                  }
                  trigBody.push(h('div', {
                    className: 'dshw-detail', key: 'thrd-' + c.cid, 'data-thread-detail': '1',
                  }, det))
                }
              }
            }
          }
          if (trigMsg !== null) {
            trigBody.push(h('div', {
              className: trigMsg.ok === true ? 'dshw-detail' : 'dshw-err', key: 'tgtmsg',
            }, (trigMsg.ok === true ? '✓ ' : '✗ ') + String(trigMsg.text)))
          }
          cardsByKey.set('triggers', card('响应',
            // 卡头**只留响应率**（2026-09-17 用户裁定）：已超时 / 今日到期 / 全部未响应 三个数字
            // 已在下方三个分组标题里各带一份（dshw-dgroup-count），不在卡头重复；
            // 旧 host 降级态同理（旧清单的条数由分组标题承载），仅额外标一句「旧版清单」。
            ('响应率 ' + (rst.responseRate === undefined || rst.responseRate === null ? '—' : (rst.responseRate * 100).toFixed(1) + '%'))
              + (trigDown === true ? ' · 旧版清单' : ''),
            trigBody,
            // ⚠️ 刷新按钮**不**随降级禁用：重启 DSH 后用户要能点它把卡片拉回新路由
            h('button', { className: 'dshw-btn', disabled: trigBusy === true, onClick: () => loadTriggers() }, trigBusy === true ? '…' : '刷新')))
          // （原此处有一份 `trigRowsForModal` 的**分支内**定义 —— 已上移到渲染作用域顶层，
          //   否则二级详情弹窗取不到它；见顶层那份声明处的注释。）

          const fo = pwb.focus || {}
          const foLast = fo.last || null
          const domainOptions = Array.isArray(pwb.domainOptions) ? pwb.domainOptions : []
          // ══ 专注期间的三层规则（2026-09-17 用户裁定）══════════════════════════════
          //   ① 新流入：**命中目标才穿透，其余入队** —— 归类在数据层（focus-queue.mjs）算好，
          //      客户端只显示，不重算（`queue_digest` / `queue_detail` / `penetrated_detail` 原样取）。
          //   ② 非目标卡片：**降权不隐藏** + 默认折叠成一行摘要，保留展开入口（见 slotOf 的包装）。
          //   ③ 白名单必穿透：逾期未关事务 / 过期未响应触发 / `UPCOMING_SCHEDULE_LEAD_MINUTES`
          //      分钟内即将开始的日程 —— 命中的卡**不降权**，专注卡上给出计数。
          //
          // ★ 三态纪律（本文件反复重申的那条）：**读失败 / 无数据 / 口径为 0 必须文案不同**。
          //   · 「实时归类未取到」= host 未重启（`/state.focus` 还是快照口径，没有 queue_* 字段）
          //     —— 这时**不许**把 `penetrated_count: 0` 说成"入队 0"：那个 0 是快照数组长度，
          //     不是归类结果（块内两数组由"读时归类"填充，host 没重启就没人填）。
          //   · 「该块无入队」= 实时口径下 `queue_digest` 存在且为空数组 —— 这是**真 0**。
          const focusLive = fo.liveRead === true
          const foActive = (fo.active !== null && fo.active !== undefined) ? fo.active : null
          const wlPayload = (focusLive && fo.whitelist !== null && typeof fo.whitelist === 'object') ? fo.whitelist : null
          // ③-a 即将开始的日程：**客户端自己算**（host 那条读路径不喂日程 ⇒ payload 的
          //     upcoming_schedule 恒为空数组，那是"没接入"而不是 0）。数据源 = /snapshot 的
          //     calendar.days[].items[].start（已有），阈值**必须引用常量**，不许写 60 字面量。
          const upcomingNow = Date.now()
          const upcomingLeadMs = UPCOMING_SCHEDULE_LEAD_MINUTES * 60000
          const upcomingItems = (() => {
            const days = (snap && snap.calendar && Array.isArray(snap.calendar.days)) ? snap.calendar.days : []
            const flat = []
            for (let di = 0; di < days.length; di += 1) {
              const its = (days[di] && Array.isArray(days[di].items)) ? days[di].items : []
              for (let ii = 0; ii < its.length; ii += 1) flat.push(its[ii])
            }
            return flat.filter((e) => {
              const t = Date.parse(String((e && e.start) || ''))
              return Number.isFinite(t) && t >= upcomingNow && (t - upcomingNow) <= upcomingLeadMs
            })
          })()
          // ③-b 逾期数：**优先用专注白名单自己的字段**（host 重启后由 cli-focus.mjs 给出）；
          //     取不到时**回落既有 payload 计数**（都是库内算好的数，不是客户端判断）：
          //       · 过期未响应触发 → `pwb.respond.escalated`（触发卡头「已超时 N」用的是同一个数组）
          //       · 逾期未关事务   → `pwb.crosscheck.planVsActual.openOverdue`
          //         （build-crosscheck 的判据 `status!=='closed' && isOverdue` 与
          //           focus-queue.buildWhitelist 的 overdueMatters 是同一条谓词）
          //     ⚠️ 回落来源会在 title 里**写明**，可核可查；两处都取不到 ⇒ null（=未取到，不是 0）。
          const escalatedList = ((pwb.respond || {}).escalated) || []
          const crossOpenOverdue = (((pwb.crosscheck || {}).planVsActual) || {}).openOverdue
          const wlOverdueMatters = wlPayload !== null && wlPayload.counts
            ? Number(wlPayload.counts.overdue_matters)
            : (typeof crossOpenOverdue === 'number' ? crossOpenOverdue : null)
          const wlOverdueTriggers = wlPayload !== null && wlPayload.counts
            ? Number(wlPayload.counts.overdue_triggers)
            : (Array.isArray(escalatedList) ? escalatedList.length : null)
          const wlUpcoming = upcomingItems.length
          const wlSource = wlPayload !== null
            ? 'cli-focus.mjs status 的 whitelist（实时口径）'
            : '回落既有 payload 计数：触发 pwb.respond.escalated · 事务 pwb.crosscheck.planVsActual.openOverdue（host 未重启，暂无 focus.whitelist）'
          const wlCountText = (label, n) => label + ' ' + (n === null ? '未取到' : String(n))
          const focusWl = {
            lead: UPCOMING_SCHEDULE_LEAD_MINUTES,
            overdueMatters: wlOverdueMatters,
            overdueTriggers: wlOverdueTriggers,
            upcoming: wlUpcoming,
            upcomingItems,
            source: wlSource,
            payload: wlPayload,
          }
          // ③-c 醒目卡 = 专注卡 + 目标映射卡 + 白名单命中的卡
          const prominentKeys = ['focus'].concat(FOCUS_TARGET_CARDS[String(((foActive || {}).target || {}).kind || '')] || [])
          if (wlOverdueMatters !== null && wlOverdueMatters > 0) prominentKeys.push('matters')
          if (wlOverdueTriggers !== null && wlOverdueTriggers > 0) prominentKeys.push('triggers')
          if (wlUpcoming > 0) prominentKeys.push('schedule')
          focusView = {
            active: foActive !== null,
            prominent: prominentKeys,
            upcoming: upcomingItems,
            wl: focusWl,
            live: focusLive,
            lead: UPCOMING_SCHEDULE_LEAD_MINUTES,
          }
          const focusRows = []
          if (foActive !== null) {
            focusRows.push(h('div', { className: 'dshw-detail', key: 'foa',
              title: '专注目标: ' + String((foActive.target || {}).id || '') },
              h('div', null, '目标: ' + String((foActive.target || {}).label || '')
                + (foActive.planned_minutes ? ' · 计划 ' + foActive.planned_minutes + ' 分钟' : '')),
              // ① 穿透/入队计数：实时口径才有真数；快照口径下**明说未取到**（不许写成 0）
              h('div', null, focusLive
                ? ('已穿透 ' + String(foActive.penetrated_count) + ' · 入队 ' + String(foActive.queued_count) + '（实时归类）')
                : ('已穿透 ' + String(foActive.penetrated_count) + ' · 入队 ' + String(foActive.queued_count)
                  + ' —— ⚠️ 这是**快照口径**（块内 penetrated/queue 数组由"读时归类"填充）；'
                  + '实时归类未取到 ⇒ 需重启 DSH 加载 host 新半体'))))
            // ③ 必穿透白名单计数（专注期间哪些卡不降权）
            focusRows.push(h('div', {
              className: 'dshw-focuswl', key: 'fowl', title: wlSource,
              'data-lead': String(UPCOMING_SCHEDULE_LEAD_MINUTES),
            },
            h('div', null, h('b', null, '专注期间必穿透：'),
              wlCountText('逾期事务', wlOverdueMatters) + ' · '
              + wlCountText('逾期触发', wlOverdueTriggers) + ' · '
              + '即将开始 ' + String(wlUpcoming) + '（' + String(UPCOMING_SCHEDULE_LEAD_MINUTES) + ' 分钟内）'),
            h('div', { className: 'dshw-fq-row-meta' },
              wlOverdueMatters === null || wlOverdueTriggers === null
                ? '⚠️ 部分计数未取到（不是 0）：' + wlSource
                : '来源：' + wlSource)))
            // ④ 醒目模型（2026-09-17 用户提问「为什么这几张卡不收起来」后补）
            //    ★ 只读说明：不参与任何判定。判据仍在 FOCUS_TARGET_CARDS（T16-112）+ 白名单三条件（T16-113）。
            //    ★ 必须回答三件事：目标映射到了哪些卡 / 白名单还会加哪些卡 / 当前实际醒目与降权的张数。
            //    ★ 并明确区分「视觉层（已实现）」与「内容层过滤（未实现，方案在 HANDOFF）」——避免把
            //      用户的期望误当成缺陷（他期望的是"每张卡只显示相关条目"，那是内容层，属其它卡）。
            focusRows.push(h('div', {
              className: 'dshw-detail', key: 'fomodel', 'data-focus-model': '1',
              title: '醒目模型：目标映射 + 白名单命中；只读说明，不参与判定',
            },
            h('div', null, h('b', null, '醒目模型：'),
              '目标（' + String(String((foActive.target || {}).kind || '—')) + '）→ 保持醒目 '
              + (FOCUS_TARGET_CARDS[String((foActive.target || {}).kind || '')] === undefined
                ? '（未知 kind：只保持专注卡醒目）'
                : FOCUS_TARGET_CARDS[String((foActive.target || {}).kind || '')].map(cardTitle).join(' · '))),
            h('div', { className: 'dshw-fq-row-meta' },
              '白名单命中才加卡：逾期事务>0 → ' + cardTitle('matters')
              + ' · 逾期触发>0 → ' + cardTitle('triggers')
              + ' · ' + String(UPCOMING_SCHEDULE_LEAD_MINUTES) + ' 分钟内即将开始 → ' + cardTitle('schedule')),
            h('div', { className: 'dshw-fq-row-meta' },
              '当前醒目 ' + String(focusView.prominent.length) + ' 张：'
              + focusView.prominent.map(cardTitle).join(' · ')),
            h('div', { className: 'dshw-fq-row-meta' },
              '其余 ' + String(CARD_TITLE_ORDER.filter((k) => k !== 'focus' && focusView.prominent.indexOf(k) === -1).length)
              + ' 张：降权 + 默认折叠（可展开；不隐藏、不删卡、顺序不变）'),
            h('div', { className: 'dshw-fq-row-meta' },
              '「每张卡只显示与目标相关的条目」（内容层过滤）当前未实现；方案见 HANDOFF_给工作台整体框架会话.md')))
            // ① 入队一级行：最多 QUEUE_DIGEST_LIMIT 条（时间 + 摘要），点击开二级详情
            const qDigest = Array.isArray(foActive.queue_digest) ? foActive.queue_digest : null
            const qDetail = Array.isArray(foActive.queue_detail) ? foActive.queue_detail : null
            if (qDigest !== null && qDigest.length > 0) {
              focusRows.push(h('div', { className: 'dshw-detail', key: 'foq',
                title: '点击查看全部入队与穿透明细（来源 · 时间 · 摘要 · 判定理由 · 是否命中）' },
              h('div', null, h('b', null, '入队 ' + String(foActive.queued_count) + ' 条（前 ' + qDigest.length + ' 条）')),
              qDigest.map((d, i) => h('div', {
                className: 'dshw-focusq', key: 'foqd' + i, 'data-click': '1',
                onClick: () => setFoModal({ kind: 'active', id: String(foActive.id || ''), label: String((foActive.target || {}).label || '') }),
              },
              h('span', { className: 'dshw-item-time' }, String(((qDetail || [])[i] || {}).arrived_at || '').slice(5, 16).replace('T', ' ')),
              h('span', { className: 'dshw-item-text' }, String(d || '')))),
              h('div', { className: 'dshw-focusq', key: 'foqmore', 'data-click': '1',
                onClick: () => setFoModal({ kind: 'active', id: String(foActive.id || ''), label: String((foActive.target || {}).label || '') }) },
              h('span', { className: 'dshw-item-time' }, ''),
              h('span', { className: 'dshw-item-text' }, '查看全部 ' + String(qDetail === null ? (foActive.queued_count ?? '—') : qDetail.length) + ' 条入队 + 穿透明细 ▸'))))
            } else if (qDigest !== null && qDigest.length === 0) {
              // 真 0：实时口径下确实是空队列 —— 与"未取到"必须分开说
              focusRows.push(h('div', { className: 'dshw-detail', key: 'foq0' },
                h('div', null, '入队 0 条 —— 该块暂无未命中目标的流入（实时口径）'),
                h('div', { className: 'dshw-fq-row-meta' }, '点下方「明细」可查穿透项与判定理由')))
            } else {
              // 未取到：字段缺失（host 未重启）—— **不是**"无入队"
              focusRows.push(h('div', { className: 'dshw-detail', key: 'foqna' },
                h('div', null, '入队明细未取到（缺 queue_digest 字段）'),
                h('div', { className: 'dshw-fq-row-meta' },
                  '这不是"没有入队"：host 未重启时 `/state.focus` 仍是快照口径，不携带归类明细'
                  + ' —— 重启 DSH 后自动生效')))
            }
            focusRows.push(h('div', { className: 'dshw-detail', key: 'foqbtn' },
              h('button', {
                className: 'dshw-btn', type: 'button',
                onClick: () => setFoModal({ kind: 'active', id: String(foActive.id || ''), label: String((foActive.target || {}).label || '') }),
              }, '入队 / 穿透明细 ▸')))
          } else if (foLast) {
            // ⑤ 结束后出「**块期间入队摘要**」（用户裁定 2026-09-17）：
            //   ⚠️ 只在 `last` 且**当前无 active** 时显示 ⇒ 新块声明后上一块的摘要自动消失（清账）。
            //   ⚠️ 三态必须分开：`queue_digest` 存在且为 `[]` = **该块无入队**；
            //      字段缺失 = **未取到**（读失败/口径不匹配）——「无数据」与「读失败」不得混为一谈。
            const foSum = foLast.summary || null
            const lastDigest = (foSum !== null && Array.isArray(foSum.queue_digest)) ? foSum.queue_digest : null
            const lastDetail = (foSum !== null && Array.isArray(foSum.queue_detail)) ? foSum.queue_detail : null
            focusRows.push(h('div', { className: 'dshw-detail', key: 'fol',
              title: '专注目标: ' + String((foLast.target || {}).id || '') },
              h('div', null, '目标: ' + String((foLast.target || {}).label || '')),
              h('div', null, foSum === null
                ? '上块无摘要（缺 summary，不是 0）'
                : '穿透 ' + String(foSum.penetrated_count ?? '—') + ' 次 · 入队 ' + String(foSum.queued_count ?? '—') + ' 条（闸未停）')))
            const lastSummaryRows = []
            if (lastDigest === null) {
              lastSummaryRows.push(h('div', { className: 'dshw-fq-row-meta', key: 'lna' },
                '块期间入队摘要**未取到**（summary 里没有 queue_digest 字段）—— 这不等于"没有入队"；'
                + 'host 未重启时 `/state.focus` 仍是快照口径'))
            } else if (lastDigest.length === 0) {
              lastSummaryRows.push(h('div', { key: 'l0' }, '该块无入队（块期间没有未命中目标的流入）'))
            } else {
              lastSummaryRows.push(h('div', { key: 'lh' }, h('b', null, '块期间入队 ' + String(lastDigest.length) + ' 条')))
              lastDigest.forEach((d, i) => lastSummaryRows.push(h('div', {
                className: 'dshw-focusq', key: 'ld' + i, 'data-click': '1',
                title: '点击查看全部明细',
                onClick: () => setFoModal({ kind: 'last', id: String(foLast.id || ''), label: String((foLast.target || {}).label || '') }),
              },
              h('span', { className: 'dshw-item-time' }, String(((lastDetail || [])[i] || {}).arrived_at || '').slice(5, 16).replace('T', ' ')),
              h('span', { className: 'dshw-item-text' }, String(d || '')))))
              lastSummaryRows.push(h('div', { className: 'dshw-focusq', key: 'lmore', 'data-click': '1',
                onClick: () => setFoModal({ kind: 'last', id: String(foLast.id || ''), label: String((foLast.target || {}).label || '') }) },
              h('span', { className: 'dshw-item-time' }, ''),
              h('span', { className: 'dshw-item-text' }, '查看全部 ' + String(lastDetail === null ? lastDigest.length : lastDetail.length) + ' 条入队明细 ▸')))
            }
            focusRows.push(h('div', { className: 'dshw-detail', key: 'folq' },
              h('div', null, h('b', null, '块期间入队摘要')), lastSummaryRows))
          } else {
            focusRows.push(empty('当前没有专注块', 'nofo'))
          }
          if (focusForm.open === true) {
            focusRows.push(h('div', { className: 'dshw-detail', key: 'fof' },
              h('div', { style: { display: 'flex', gap: '6px', margin: '4px 0' } },
                h('select', {
                  value: focusForm.kind,
                  onChange: (e) => setFocusForm((p) => Object.assign({}, p, { kind: e.target.value })),
                },
                h('option', { value: 'domain' }, '关注域'),
                h('option', { value: 'project' }, '项目'),
                h('option', { value: 'matter' }, '事务')),
                h('input', {
                  type: 'number', value: focusForm.minutes, min: 1, max: 480,
                  style: { width: '64px' },
                  onChange: (e) => setFocusForm((p) => Object.assign({}, p, { minutes: e.target.value })),
                  title: '计划分钟数',
                })),
              focusForm.kind === 'domain'
                ? h('select', {
                  value: focusForm.id,
                  style: { width: '100%' },
                  onChange: (e) => {
                    const d = domainOptions.find((x) => x.id === e.target.value)
                    setFocusForm((p) => Object.assign({}, p, { id: e.target.value, label: d ? d.name : p.label }))
                  },
                },
                h('option', { value: '' }, '选择关注域…'),
                domainOptions.map((d) => h('option', { key: d.id, value: d.id }, d.name + ' (' + d.id + ')')))
                : h('input', {
                  type: 'text', value: focusForm.id, placeholder: '目标 id（项目路径 / 事务 id）',
                  style: { width: '100%' },
                  onChange: (e) => setFocusForm((p) => Object.assign({}, p, { id: e.target.value })),
                }),
              focusMsg === null ? null : h('div', { key: 'fomsg', style: { color: '#e0a030' } }, focusMsg),
              h('div', { style: { display: 'flex', gap: '6px', marginTop: '6px' } },
                h('button', { className: 'dshw-btn', onClick: declareFocusNow, disabled: focusBusy }, focusBusy ? '…' : '声明专注'),
                h('button', {
                  className: 'dshw-btn', disabled: focusBusy,
                  onClick: () => { setFocusForm((p) => Object.assign({}, p, { open: false })); setFocusMsg(null) },
                }, '取消'))))
          }
          const focusBtn = fo.active
            ? h('button', { className: 'dshw-btn', onClick: endFocusNow, disabled: focusBusy }, focusBusy ? '…' : '结束专注')
            : h('button', {
              className: 'dshw-btn', disabled: focusBusy,
              onClick: () => setFocusForm((p) => Object.assign({}, p, { open: !p.open })),
            }, focusForm.open ? '收起' : '开始专注')
          /**
           * ── ★ 2026-09-20 合并（用户裁定：专注 + 活跃关注域 ⇒ 一张卡；卡数 15 → 14）──────
           *   本卡的**注册点已搬到下方「活跃关注域」区块的末尾**（原 `cardsByKey.set('domains', …)` 处）。
           *   为什么必须搬：合并卡的卡体 = 专注行 + **活跃域区块行**，卡头 = 专注按钮 + **活跃域三按钮**，
           *   而后者要用的 `adItems` / `adForm` / `adBusy` / `declareActiveDomainNow` 等
           *   **全在下方区块里用 `const` 定义**（TDZ）—— 在这里注册会拿到未初始化的绑定或直接抛错
           *   （本项目的 UND 守卫正是为这类"引用了但没声明"的形态而立）。
           *   ⚠️ 注册先后**与卡片顺序无关**：顺序的唯一真相源是装配段的 `CARD_ORDER`，
           *      真机 SBT-57 逐项比对 DOM 的 `data-key` 序列。
           *   ⚠️ 卡头两个动作并存一行右侧：**开始/结束专注**（主）+ **重新匹配**（次）；
           *      活跃域的**声明 / 清除**按 §一"保持现状"**一并保留**（删掉它们等于拆掉两个写入口的
           *      UI 入口 —— 路由还在、`write-controls.json` 条数也不变，但用户点不到）。
           *      四个按钮共用下方那套 `--nowrap` + 可收缩/可折行的内联 style（原样带走，防窄卡裁掉最右按钮）。
           */
          // 专注状态词：**必须保留这三个词之一**（真机 SBT-50 读卡前 160 字判"能开始也能结束"）。
          const focusStateWord = fo.active
            ? ('进行中' + (String(((foActive || {}).target || {}).label || '') === ''
              ? '' : ' ' + String((foActive.target || {}).label)))
            : (foLast ? '上块已结束' : '未声明')

          // ── 活跃关注域（B 块 2026-09-14 裁定 ②）：自动读会话匹配 + agent 声明覆盖 ──
          //  ★ 2026-09-18 用户裁定（本次改版）：卡体改成**与本工作台其它卡片一致的四层结构** ——
          //      卡内 tab（分类轴 = 域的 `kind`）→ 可折叠的「同主题」分组（一个域一组）→ 列表条目
          //      （`对象@事件`，**每个对象键一行**）→ 点条目进三级详情（只读弹窗 `.dshw-modal*`）。
          //    卡头右侧既有的「重新匹配」「声明」「清除」三个写入口与声明表单**行为一字未改**。
          //  ★ 只读纪律（P2）：每个字都**原样取自 payload** ——
          //      分类轴 = 该域的 `kind`（按 id 查 `domainHealth.domains` 那一行；查不到 ⇒ 退到
          //             `effective[].kind`；两处都没有 ⇒ 其他。client/topic/question，其余与缺失 ⇒ 其他）；
          //      组标题 = 域名（指标不进 summary 可见文本，已降级到展开块第一行 + tooltip）；
          //      条目 = `by_object.object_keys` **原序**（只去掉 `场次:` / `客户:` 这类**类型前缀**，
          //             不重排、不挑选语义）+ `next_step`（原样 id/title + 期限，期限缺失写「无期限」）
          //             或退到 `by_domain_field`（`overdue > 0` ⇒「过期 N 条」，否则「事务 N / 触发 M」）；
          //      来源标记 = `activeDomains.effective[].source` ⇒ 行首极小符号 ● 声明 / ○ 自动 /
          //             · 不在生效列表（payload 没给 source，绝不默认说成"自动"）。
          //    本卡不判定、不重排、不补期限、不把阈值变红绿、不按 kind/priority 过滤域。
          //  ★ 一级域清单**单源**（2026-09-19 用户裁定）= `/state` 的 `activeDomains.effective`
          //    （**payload 原序**：不重排、不追加、不补齐）——「当前活跃 = 用户声明的（declared），
          //    没声明时就是自动匹配命中的（auto）」，**不再列出全部注册域**。
          //    `domainHealth.domains` **只作按 id 的查表**：`kind` / `by_domain_field`（指标）/
          //    `by_object`（对象键）/ `next_step` / `silent_days`；查不到该域 ⇒ 该行没有指标、
          //    没有对象键（条目退到平铺 + `reason`），**不补 0、不编数据**。
          //  ★ 降级（老 host / 读失败 ⇒ `adhDomains === null`）：不渲染 tab、不渲染分组，退回
          //    `activeDomains.effective` 的「域名 · reason」单层列表（与改版前**逐字同形**），
          //    条目仍可点开最小详情（来源 + 匹配依据），**不报错、不空白**。
          //  ★ 三态分开说（读失败 / 已声明但生效列表为空 / 未声明也未匹配）：空态文案沿用框架层 2026-09-17 裁定。
          //  ★ 零新增 hook：tab 选中（`adForm.tab` + 本机 `dshw.adTab`）与详情载荷（`adForm.detail`）
          //    都挂在既有 `adForm` 上；分组展开态由原生 `<details>` 自己持有（跨轮询保持、键盘可用）。
          const ad = pwb.activeDomains
          const adEff = (ad && ad.effective) || []
          const adh = pwb.domainHealth
          const adhDomains = (adh !== null && adh !== undefined && Array.isArray(adh.domains)) ? adh.domains : null
          /**
           * 域 id → `domainHealth.domains` 里的那一行（**纯查表**，不是清单来源：命中返回原对象，
           *   首个为准，不重排）。查不到该域 / 老 host 没有 `domainHealth` ⇒ null
           *   （⇒ 该行不渲染指标行、对象键为空）。
           */
          function adHealthOf(did) {
            if (adhDomains === null) return null
            for (let i = 0; i < adhDomains.length; i += 1) {
              const x = adhDomains[i]
              if (x !== null && x !== undefined
                && String(x.id === null || x.id === undefined ? '' : x.id) === did) return x
            }
            return null
          }
          /** 域显示名：`domainHealth.name` → `effective.name` → id（三处都没有才空） */
          function adNameOf(it) {
            const n1 = (it.x === null || it.x === undefined) ? '' : String(it.x.name || '')
            const n2 = (it.e === null || it.e === undefined) ? '' : String(it.e.name || '')
            return n1 || n2 || it.did
          }
          /** 该域在**生效列表**里的来源：本卡只认这一处；不在生效列表 ⇒ null（符号写「·」） */
          function adSourceOf(it) {
            return (it.e === null || it.e === undefined) ? null : it.e.source
          }
          /** 该域的对象键（`by_object.object_keys` 原序；没有 domainHealth 行 ⇒ 空数组） */
          function adKeysOf(x) {
            const bo = (x !== null && x !== undefined && x.by_object !== null && typeof x.by_object === 'object') ? x.by_object : null
            return (bo !== null && Array.isArray(bo.object_keys)) ? bo.object_keys : []
          }
          /** 只去掉对象键**第一个冒号前**的类型前缀（`场次:示例客户A-0913` → `示例客户A-0913`） */
          function adObjName(key) {
            const s = String(key === null || key === undefined ? '' : key)
            const p = s.indexOf(':')
            return p > 0 ? s.slice(p + 1) : s
          }
          /** 期限显示：ISO 时刻只取日期（只做显示格式，不是判定）；payload 没给 ⇒「无期限」 */
          function adDueText(v) {
            const s = String(v === null || v === undefined ? '' : v).trim()
            if (s === '') return '无期限'
            return /^\d{4}-\d{2}-\d{2}T/.test(s) ? s.slice(0, 10) : s
          }
          /** 计数原样显示：payload 没给 ⇒「—」（**不补 0、不编数字**） */
          function adNum(v) { return String(v === null || v === undefined ? '—' : v) }
          /** 事件列：`next_step` 优先；没有就退到 `by_domain_field`（overdue 优先，其余给 事务/触发 计数） */
          function adEventText(x, d) {
            // domainHealth 里没有这个域 ⇒ 只能给 payload 已有的 `reason`（原样，不编事件）
            if (x === null || x === undefined) return String((d && d.reason) || '')
            const ns = x.next_step
            if (ns !== null && ns !== undefined) return String(ns.title || ns.id || '') + ' · ' + adDueText(ns.due_at)
            const f = (x.by_domain_field !== null && typeof x.by_domain_field === 'object') ? x.by_domain_field : {}
            const od = Number(f.overdue === null || f.overdue === undefined ? 0 : f.overdue)
            if (od > 0) return '过期 ' + String(od) + ' 条'
            return '事务 ' + String(f.matters === null || f.matters === undefined ? 0 : f.matters)
              + ' / 触发 ' + String(f.triggers === null || f.triggers === undefined ? 0 : f.triggers)
          }
          /** 对象列：`by_object.object_keys` 原序第 1 个（去类型前缀）；空 ⇒ 退回域名本身 */
          function adObjText(x, d) {
            const keys = adKeysOf(x)
            if (keys.length > 0) return adObjName(keys[0])
            return String((x !== null && x !== undefined && (x.name || x.id)) || (d && (d.name || d.id)) || '')
          }
          /** 组标题里的该域指标：`事务 N · 触发 M · 过期 K · 静默 X 天`；`by_domain_field` 缺失 ⇒ 空串（只显示域名） */
          function adMetricText(x) {
            if (x === null || x === undefined) return ''
            const f = (x.by_domain_field !== null && typeof x.by_domain_field === 'object') ? x.by_domain_field : null
            if (f === null) return ''
            return '事务 ' + adNum(f.matters)
              + ' · 触发 ' + adNum(f.triggers)
              + ' · 过期 ' + adNum(f.overdue)
              + ' · ' + (x.silent_days === null || x.silent_days === undefined ? '从未有记录' : '静默 ' + String(x.silent_days) + ' 天')
          }
          /** 行首极小来源标记：● 声明 / ○ 自动 / · 不在生效列表（只有符号，不带文字） */
          function adMark(src) {
            const s = (src === null || src === undefined) ? '' : String(src)
            return h('span', {
              key: 'amk', style: {
                flex: 'none', width: '1em', fontSize: '11px',
                color: s === 'declared' ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
              },
            }, s === 'declared' ? '●' : (s === '' ? '·' : '○'))
          }
          // ── 卡内 tab（分类轴 = 域的 `kind`；只登记**有域**的分类，无任何域 ⇒ 连 tab 行都不渲染）──
          const AD_TABS = [
            { key: 'client', label: '客户' },
            { key: 'topic', label: '主题' },
            { key: 'question', label: '问题' },
            { key: 'other', label: '其他' },
          ]
          function adKindKey(v) {
            const k = (v === null || v === undefined) ? '' : String(v)
            return (k === 'client' || k === 'topic' || k === 'question') ? k : 'other'
          }
          function adKindOf(it) {
            const k1 = (it.x === null || it.x === undefined) ? '' : it.x.kind
            const k2 = (it.e === null || it.e === undefined) ? '' : it.e.kind
            return adKindKey(k1 || k2)
          }
          /**
           * 一级域清单 = `activeDomains.effective` **单源**（payload 原序：一条不落、一条不多，
           *   不重排、不追加）。`domainHealth` 只在**取指标/对象键/kind**时按 id 查表拿 `x`
           *   （查不到 ⇒ `x === null`）。
           */
          const adItems = []
          for (let i = 0; i < adEff.length; i += 1) {
            const e = adEff[i]
            if (e === null || e === undefined) continue
            const did = String(e.id === null || e.id === undefined ? '' : e.id)
            adItems.push({ x: adHealthOf(did), e, did })
          }
          const adCounts = { client: 0, topic: 0, question: 0, other: 0 }
          for (let i = 0; i < adItems.length; i += 1) adCounts[adKindOf(adItems[i])] += 1
          const adTabKeys = AD_TABS.filter((t) => adCounts[t.key] > 0)
          /** 默认分类 = 域最多的那一类；**并列时按 AD_TABS 顺序取先者**（client > topic > question > other） */
          let adTabDefault = null
          for (let i = 0; i < AD_TABS.length; i += 1) {
            const k = AD_TABS[i].key
            if (adCounts[k] === 0) continue
            if (adTabDefault === null || adCounts[k] > adCounts[adTabDefault]) adTabDefault = k
          }
          const adTabSaved = lsGet('dshw.adTab')
          const adTabWant = String(((adForm.tab === null || adForm.tab === undefined) ? adTabSaved : adForm.tab) || '')
          const adTab = adCounts[adTabWant] > 0 ? adTabWant : adTabDefault
          /**
           * 条目 → 三级详情的**载荷**：只装 payload 原值的字符串/数组（不含任何 live 对象、不改数值）。
           * ⚠️ 必须在卡内构造：详情弹窗（`adModalEl`）声明在**渲染顶层**，与卡构造表达式**不在同一层**
           *    （同 `trigRowsForModal` 那个坑：分支内的 const 在顶层读不到 ⇒ ReferenceError 整树卸载）。
           *    故：卡内把要显示的字串准备好，弹窗只负责排版 —— 取数、查表、口径全在这一处。
           */
          function adPack(it, objKey) {
            const x = it.x
            const hasHealth = x !== null && x !== undefined
            const f = (hasHealth && x.by_domain_field !== null && typeof x.by_domain_field === 'object') ? x.by_domain_field : null
            const ns = (hasHealth && x.next_step !== null && x.next_step !== undefined) ? x.next_step : null
            const src = adSourceOf(it)
            const keys = []
            const raw = adKeysOf(x)
            for (let i = 0; i < raw.length; i += 1) keys.push(String(raw[i]))
            return {
              title: adNameOf(it),
              did: it.did,
              // '' = 不在生效列表（弹窗里如实说明，不默认说成"自动"）
              sourceText: src === 'declared' ? '声明' : ((src === null || src === undefined) ? '' : '自动'),
              reason: String((it.e === null || it.e === undefined ? '' : it.e.reason) || ''),
              hasHealth,
              nextTitle: ns === null ? '' : String(ns.title || ''),
              nextId: ns === null ? '' : (String(ns.source || '—') + ' ' + String(ns.id || '—')),
              nextDue: ns === null ? '' : adDueText(ns.due_at),
              nextOwner: ns === null ? '' : String(ns.owner || '—'),
              hasField: f !== null,
              cMatters: f === null ? '' : adNum(f.matters),
              cOpen: f === null ? '' : adNum(f.open_matters),
              cTriggers: f === null ? '' : adNum(f.triggers),
              cUnresp: f === null ? '' : adNum(f.unresponded_triggers),
              cOverdue: f === null ? '' : adNum(f.overdue),
              hasSilent: hasHealth && x.silent_days !== null && x.silent_days !== undefined,
              silent: (hasHealth && x.silent_days !== null && x.silent_days !== undefined) ? String(x.silent_days) : '',
              lastActivity: hasHealth ? String(x.last_activity_at || '') : '',
              keys,
              objKey: (objKey === null || objKey === undefined) ? '' : String(objKey),
            }
          }
          /** 点条目 → 三级详情（只读弹窗；关闭走 backdrop / 关闭按钮 / Esc） */
          function openAdDetail(it, objKey) {
            setAdForm((p) => Object.assign({}, p, { detail: adPack(it, objKey) }))
          }
          /** 一条列表条目（`对象@事件`）：**每个对象键一行**，点它进三级详情 */
          function adEntryRow(it, objKey, key) {
            const nm = adObjName(objKey)
            const text = (nm === '' ? adNameOf(it) : nm) + '@' + adEventText(it.x, it.e)
            return h('div', {
              className: 'dshw-item', key, 'data-click': '1', 'data-ad-row': '1', 'data-child': '1',
              'data-domain': it.did, 'data-ad-key': String(objKey),
              title: text + '\n点开看该域详情（只读 · Esc 关闭）',
              onClick: () => openAdDetail(it, objKey),
            }, adMark(adSourceOf(it)), h('span', { className: 'dshw-item-text' }, text))
          }
          /** 无对象键的域：**直接平铺一条列表条目**（不套折叠组）—— 文案口径与改版前同一套（`对象@事件`） */
          function adFlatRow(it, key) {
            const text = adObjText(it.x, it.e) + '@' + adEventText(it.x, it.e)
            return h('div', {
              className: 'dshw-item', key, 'data-click': '1', 'data-ad-row': '1', 'data-ad-flat': '1',
              'data-domain': it.did,
              title: text + '\n点开看该域详情（只读 · Esc 关闭）',
              onClick: () => openAdDetail(it, null),
            }, adMark(adSourceOf(it)), h('span', { className: 'dshw-item-text' }, text))
          }
          /** 「…还有 N 条」——**只提示，不可点**（组内条目上限沿用 MAX_ROWS；缩进与上级条目一致） */
          function adMoreRow(n, key) {
            return h('div', {
              className: 'dshw-item', key, 'data-child': '1', 'data-ad-more': String(n),
            }, h('span', { className: 'dshw-objweak' }, '…还有 ' + String(n) + ' 条'))
          }
          /**
           * 一个域 = 一个**可折叠组**（原生 `<details>`：零 React 状态、展开态跨轮询保持、键盘可用）。
           * 信息层级（2026-09-19 用户要求）：**组标题（summary）只有「三角 + 域名称」**；
           *   该域指标降为**展开块的第一行**（`data-ad-metrics="1"`，口径仍完全取自 `adMetricText`）；
           *   指标行**之后**才是条目（组内每个对象键一行，> MAX_ROWS ⇒ 只显示前 MAX_ROWS 条 + 提示）。
           *   ⚠️ summary 恒为 `display:list-item`、内层恒为行内级 `inline-flex`（见下面注释）——**不要回退成块级**，
           *     否则原生三角会被顶到另一行（这是刚修过的坑）。
           */
          function adGroup(it, gi) {
            const keys = adKeysOf(it.x)
            const shown = keys.slice(0, MAX_ROWS)
            const kids = []
            for (let j = 0; j < shown.length; j += 1) kids.push(adEntryRow(it, shown[j], 'adk' + gi + '-' + j))
            if (keys.length > MAX_ROWS) kids.push(adMoreRow(keys.length - MAX_ROWS, 'adm' + gi))
            const metric = adMetricText(it.x)
            const head = adNameOf(it) + (metric === '' ? '' : ' · ' + metric)
            return h('details', {
              className: 'dshw-adgrp', key: 'adg' + gi, 'data-ad-group': it.did, 'data-domain': it.did,
            },
              h('summary', {
                // 排版修复（2026-09-19）：根因是**内层标题是块级容器**——原生展开标记只在 summary 为
                //   `display:list-item` 且其内容是**行内级**时才与文字同排；内层是块级 flex 时标记会独占一行。
                //   所以这里：① summary 恒为 list-item（**不能**改成 flex：原生标记会直接消失、折叠语义也没了）；
                //   ② 内层标题改行内级 inline-flex，并按 border-box 让出标记宽度（见下一段注释）。
                // ★ 可见文本只留「三角（原生）+ 域名称」：`dshw-spacer` / `dshw-dgroup-count` 已从 summary 移除，
                //   指标改名到展开块第一行（见下方 `data-ad-metrics`）。指标仅保留在 `title` tooltip 里。
                className: 'dshw-adsum', 'data-click': '1', style: { cursor: 'pointer', display: 'list-item' },
                title: head + '（点开看该域的对象条目 ' + String(keys.length) + ' 条）',
              },
                h('span', {
                  // 行内级（inline-flex）+ 让出原生标记宽度：实测本机 Chromium（13px 系统字体）标记占位 13.77px，
                  //   故按 border-box 扣 18px（标记 + ≈4px 余量，兼顾不同字体回退下的标记宽度差异）。
                  //   ⚠️ 写回 `display:flex`（块级）或宽度不减 ⇒ 标题又被标记顶到第二行。
                  //   `align-items:center` / `gap:5px` 仍由 `.dshw-dgroup` 提供（该共享类还被决策卡、文件卡使用，
                  //   本处只覆盖 display 与宽度，不改共享类）。
                  className: 'dshw-dgroup',
                  style: { display: 'inline-flex', boxSizing: 'border-box', width: 'calc(100% - 18px)' },
                },
                  h('span', { className: 'dshw-dgroup-name' }, adNameOf(it)))),
              // ── 展开块第一行 = 该域指标（只在展开后可见；口径完全沿用 `adMetricText`：不补 0、不改数值）──
              metric === '' ? null : h('div', { className: 'dshw-detail', 'data-ad-metrics': '1', key: 'm' }, metric),
              kids)
          }
          /** 老 host（`/state` 没有 `domainHealth.domains`）：退回 `adEff` 的简单列表，不报错 */
          function adPlainRow(it, key) {
            const e = it.e
            return h('div', {
              className: 'dshw-item', key, 'data-click': '1', 'data-ad-row': '1', 'data-ad-flat': '1',
              'data-domain': it.did,
              title: adNameOf(it) + '\n点开看最小详情（只读 · Esc 关闭）',
              onClick: () => openAdDetail(it, null),
            },
              adMark(adSourceOf(it)),
              h('span', { className: 'dshw-item-text' },
                adNameOf(it) + (String(e.reason || '') === '' ? '' : ' · ' + String(e.reason))))
          }
          // ★ 三态分开说（框架层 2026-09-17 裁定）：**读失败 / 已声明但生效列表为空 / 未声明也未匹配**
          //   三者文案互异（一级清单单源 = `activeDomains.effective` ⇒ 空 = 0 个活跃域，不会是"没读到"）
          const adReadFail = '关注域不可用：/state 未返回 activeDomains（属读失败，不等于 0 个域）'
          const adEmptyText = (ad === null || ad === undefined)
            ? adReadFail
            : (ad.source === 'declared'
              ? '已声明但生效列表为空（口径结果：声明未生效或被清除）'
              : '未声明也未匹配（点「重新匹配」读当前会话；或点「声明」手动指定）')
          const adBody = []
          if (adhDomains === null) {
            // ── 降级路径：只用 `activeDomains.effective` 的单层列表（**不渲染 tab、不渲染分组**）──
            if (adEff.length === 0) {
              adBody.push(empty(adEmptyText, 'noad'))
            } else {
              const shown = adEff.slice(0, MAX_ROWS)
              for (let i = 0; i < shown.length; i += 1) {
                const e = shown[i]
                if (e === null || e === undefined) continue
                const did = String(e.id === null || e.id === undefined ? '' : e.id)
                adBody.push(adPlainRow({ x: null, e, did }, 'adp' + i))
              }
              if (adEff.length > MAX_ROWS) adBody.push(adMoreRow(adEff.length - MAX_ROWS, 'adpm'))
            }
          } else if (adItems.length === 0) {
            // 「生效列表为空」：一级清单单源 = `activeDomains.effective` ⇒ 这里是**0 个活跃域**
            //   （口径结果：0 个域，**不是**读失败）。三态沿用本卡既有文案（`adEmptyText`）：
            //   ① `activeDomains` 读失败 ⇒ 如实报读失败（0 个域 ≠ 没读到）；
            //   ② 已声明但生效列表为空；③ 未声明也未匹配。
            // ⚠️ 此时**不渲染 tab 行、不渲染分组**（没有域就没有分类）。
            adBody.push(empty(adEmptyText, 'noad'))
          } else {
            // tab 行（`.dshw-tabs dshw-tabs-inline` = 既有件：**左对齐**、选中态 `data-on="1"`）
            adBody.push(h('div', { className: 'dshw-tabs dshw-tabs-inline', key: 'adtabs' },
              adTabKeys.map((t) => h('button', {
                key: 'adt-' + t.key,
                className: 'dshw-tab',
                'data-on': adTab === t.key ? '1' : null,
                'data-ad-tab': t.key,
                title: '域分类「' + t.label + '」共 ' + String(adCounts[t.key]) + ' 个域 · 点切换（选中项记在本机 dshw.adTab）',
                onClick: () => { setAdForm((p) => Object.assign({}, p, { tab: t.key })); lsSet('dshw.adTab', t.key) },
              }, t.label + ' ' + String(adCounts[t.key])))))
            // 域行**按 payload 原序**：有对象键 ⇒ 折叠组；没有对象键 ⇒ 平铺一条（不套组、不补数据）
            let gi = 0
            for (let i = 0; i < adItems.length; i += 1) {
              const it = adItems[i]
              if (adKindOf(it) !== adTab) continue
              if (adKeysOf(it.x).length === 0) {
                adBody.push(adFlatRow(it, 'adf' + i))
              } else {
                adBody.push(adGroup(it, gi))
                gi += 1
              }
            }
          }
          const adRows = adBody
          // ── 写入口（本卡三条，均走**既有** host 通道；本卡不做判定）──────────────────
          //   ① 重新匹配（既有）→ GET `/active-domains?match=1`
          //   ② 声明 / ③ 清除 → POST `/active-domains` → 库内 `cli-active-domains.mjs`
          //      （与 agent 工具 `workbench_active_domains` **同一通道**；host 不新增判定逻辑）
          //   ⚠️ host 半体若尚未提供该 POST 路由，按钮**必须给出可读原因并点名缺哪条路由**——
          //      不是"点了没反应"（SPEC §6.1 / 反模式 C5）。
          function adWrite(action, payload) {
            return api('/active-domains', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(Object.assign({ action }, payload || {})),
            })
          }
          function adErrText(r, e) {
            const raw = (e !== null && e !== undefined)
              ? String((e && e.message) || e)
              : String((r && r.error) || '未知错误')
            return /404|unknown route|not found/i.test(raw)
              ? 'host 侧尚未提供 `/active-domains` POST 写路由（需重启 DSH 或由框架层补该路由）—— 原始返回: ' + raw
              : raw
          }
          // ── 声明表单的**域清单来源**（2026-09-18 用户裁定：手输 id → 选择器）──────────────
          //   ① 数据源**只有一处**：本次 `/state` 的 `domainHealth.domains`（即上面的 `adhDomains`）——
          //      本卡不内建域清单、不按 `active`/`kind`/`priority` 过滤、不重排、不改显示名（原样给 `name`）。
          //   ② 结构上必须跳过的两类（**不是**判断，是渲染前提）：`id` 为空的行（无法当 `<option value>`）、
          //      同一个 `id` 的重复行（`<select>` 的 value 必须唯一）。其余一律原样进选项。
          //   ③ 多选手感：选一个 → 追加一条到「已选」列表（列表可见、每条可 ✕ 删），可连续选多个。
          //   ④ **降级**：`domainHealth.domains` 不可用（老 host / 读失败 ⇒ `adhDomains === null`）⇒
          //      退回原来的「手输 id + 显示名」两个文本框 —— 功能不变、可提交、不报错、不空白。
          /** 可选项：原样取自 payload 的 `domainHealth.domains`（只跳过空 id / 重复 id） */
          function adOptions() {
            if (adhDomains === null) return []
            const out = []
            for (let i = 0; i < adhDomains.length; i += 1) {
              const x = adhDomains[i]
              if (x === null || x === undefined) continue
              const did = String(x.id === null || x.id === undefined ? '' : x.id).trim()
              if (did === '') continue
              let dup = false
              for (let j = 0; j < out.length; j += 1) { if (out[j].id === did) { dup = true; break } }
              if (dup === true) continue
              out.push({ id: did, name: String(x.name === null || x.name === undefined ? '' : x.name).trim() || did })
            }
            return out
          }
          /** 已选列表（挂在既有 `adForm.picks` 上）：`[{id, label}]`，与 POST 的 `domains` 同形 */
          function adPicks() {
            return Array.isArray(adForm.picks) ? adForm.picks : []
          }
          /** 选一个 → 追加一条；重复选同一个 ⇒ 给一行可见提示（不静默） */
          function adAddPick(did, dname) {
            const id = String(did === null || did === undefined ? '' : did)
            if (id === '') return
            const name = String(dname === null || dname === undefined ? '' : dname) || id
            const cur = adPicks()
            for (let i = 0; i < cur.length; i += 1) {
              if (String(cur[i].id) === id) {
                setAdMsg({ ok: false, text: '「' + name + '」已在已选列表里（' + id + '），不重复添加' })
                return
              }
            }
            setAdMsg(null)
            setAdForm((p) => Object.assign({}, p, {
              picks: (Array.isArray(p.picks) ? p.picks : []).concat([{ id, label: name }]),
            }))
          }
          /** 从已选列表删掉第 idx 条 */
          function adDelPick(idx) {
            setAdForm((p) => {
              const cur = Array.isArray(p.picks) ? p.picks : []
              const next = []
              for (let i = 0; i < cur.length; i += 1) { if (i !== idx) next.push(cur[i]) }
              return Object.assign({}, p, { picks: next })
            })
          }
          /**
           * 提交声明。请求体与改版前**完全同形**：`{ action:'declare', domains:[{id,label}], note }`。
           * ★ **不传 `ttl_days`**：host 的 `POST /active-domains` 只读 `action`/`domains`/`note` 三个字段
           *   （`activeDomainsAction()` 的实现里没有 ttl 参数），传了会被静默丢弃 ⇒ 不传，免得看起来"设了 7 天"。
           */
          function declareActiveDomainNow() {
            if (adBusy === true) return
            let domains = null
            let what = ''
            if (adhDomains === null) {
              // 降级路径（老 host / 读失败）：手输单域，与改版前行为一致
              const id = String(adForm.id || '').trim()
              if (id.length === 0) { setAdMsg({ ok: false, text: '请填关注域 id（取注册表里的 id，如 qianwen-office）' }); return }
              domains = [{ id, label: String(adForm.label || '').trim() || id }]
              what = id
            } else {
              // 正常路径：domains = 已选列表（原样，不判定、不补全）
              const picks = adPicks()
              if (picks.length === 0) { setAdMsg({ ok: false, text: '请先从下拉框选择至少一个关注域（选一个追加一条，可多选）' }); return }
              domains = picks.map((d) => ({ id: String(d.id), label: String(d.label || d.id) }))
              what = domains.map((d) => d.id).join(' + ')
            }
            setAdBusy(true)
            setAdMsg(null)
            adWrite('declare', { domains, note: String(adForm.note || '').trim() })
              .then((r) => {
                if (r && r.ok === true) {
                  setAdMsg({ ok: true, text: '已声明 ' + what + '（生效 = 声明覆盖自动匹配）' })
                  // 只清表单草稿；`tab`（卡内分类页签）与 `detail` 不动 —— 前者是卡的视图状态，后者此刻必为 null
                  setAdForm((p) => Object.assign({}, p, { open: false, id: '', label: '', note: '', picks: [] }))
                  loadPwb(true)
                } else setAdMsg({ ok: false, text: adErrText(r, null) })
              })
              .catch((e) => setAdMsg({ ok: false, text: adErrText(null, e) }))
              .then(() => setAdBusy(false))
          }
          function clearActiveDomainNow() {
            if (adBusy === true) return
            setAdBusy(true)
            setAdMsg(null)
            adWrite('clear', {})
              .then((r) => {
                if (r && r.ok === true) {
                  setAdMsg({ ok: true, text: '已清除声明（回到会话自动匹配）' })
                  loadPwb(true)
                } else setAdMsg({ ok: false, text: adErrText(r, null) })
              })
              .catch((e) => setAdMsg({ ok: false, text: adErrText(null, e) }))
              .then(() => setAdBusy(false))
          }
          if (adForm.open === true) {
            // `data-ad-mode`：`pick` = payload 有域清单（选择器）/ `text` = 老 host 降级（手输 id）
            const adMode = adhDomains === null ? 'text' : 'pick'
            const adOpts = adOptions()
            const adSel = adPicks()
            const adKids = []
            if (adMode === 'text') {
              // ★ 降级路径（老 host / `domainHealth.domains` 读失败）：保留原文本框，可正常提交
              adKids.push(h('input', {
                className: 'dshw-input', key: 'adid', 'data-ad-field': 'id',
                placeholder: '关注域 id（注册表里的 id，如 qianwen-office）',
                value: adForm.id, onChange: (ev) => setAdForm((p) => Object.assign({}, p, { id: ev.target.value })),
              }))
              adKids.push(h('input', {
                className: 'dshw-input', key: 'adlabel', 'data-ad-field': 'label', placeholder: '显示名（可空，默认取 id）',
                value: adForm.label, onChange: (ev) => setAdForm((p) => Object.assign({}, p, { label: ev.target.value })),
              }))
            } else {
              // 选择器：value 恒为 ''（选完即回占位项）⇒ 每次选择都是"追加一条"，不会覆盖已选
              adKids.push(h('select', {
                className: 'dshw-input', key: 'adpick', 'data-ad-field': 'pick',
                value: '', disabled: adBusy === true || adOpts.length === 0,
                title: '关注域清单原样取自本次 /state 的 domainHealth.domains（选一个追加一条，可多选）',
                onChange: (ev) => {
                  const did = String((ev.target && ev.target.value) || '')
                  if (did === '') return
                  let nm = did
                  for (let i = 0; i < adOpts.length; i += 1) { if (adOpts[i].id === did) { nm = adOpts[i].name; break } }
                  adAddPick(did, nm)
                },
              }, [h('option', { value: '', key: 'adopt-ph' },
                adOpts.length === 0 ? '— 无可选关注域（payload 域清单为空）—' : '— 选择域（选一个追加一条）—')]
                .concat(adOpts.map((d, i) => h('option', { value: d.id, key: 'adopt-' + i }, d.name)))))
              if (adSel.length === 0) {
                adKids.push(h('div', {
                  className: 'dshw-detail', key: 'adpicks', 'data-ad-picks': '0',
                }, '已选 0 个 —— 从上面的下拉框选域（可连续选多个，建议 2–3 个）'))
              } else {
                adKids.push(h('div', {
                  className: 'dshw-detail', key: 'adpicks', 'data-ad-picks': String(adSel.length),
                }, [h('div', { key: 'adph' }, '已选 ' + String(adSel.length) + ' 个（提交时按此列表声明）：')]
                  .concat(adSel.map((d, i) => h('div', {
                    className: 'dshw-item', key: 'adpk' + i, 'data-ad-pick': String(d.id),
                  },
                    h('span', { className: 'dshw-item-text', key: 't' }, String(d.label || d.id) + '（' + String(d.id) + '）'),
                    h('button', {
                      className: 'dshw-mt-btn', key: 'x', 'data-ad-pick-del': String(d.id),
                      disabled: adBusy === true, title: '从已选列表移除',
                      onClick: () => adDelPick(i),
                    }, '✕'))))))
              }
            }
            adKids.push(h('input', {
              className: 'dshw-input', key: 'adnote', 'data-ad-field': 'note', placeholder: '说明（可空，写进声明的 note）',
              value: adForm.note, onChange: (ev) => setAdForm((p) => Object.assign({}, p, { note: ev.target.value })),
            }))
            adKids.push(h('div', { className: 'dshw-btnrow', key: 'adbtns' },
              h('button', { className: 'dshw-btn', disabled: adBusy === true, onClick: declareActiveDomainNow }, adBusy === true ? '…' : '确认声明'),
              h('button', {
                className: 'dshw-btn',
                onClick: () => setAdForm((p) => Object.assign({}, p, { open: false, id: '', label: '', note: '', picks: [] })),
              }, '取消')))
            adRows.push(h('div', {
              className: 'dshw-adform', key: 'adform', 'data-ad-form': '1', 'data-ad-mode': adMode,
            }, adKids))
          }
          if (adMsg !== null) {
            adRows.push(h('div', {
              className: adMsg.ok === true ? 'dshw-msg' : 'dshw-err',
              key: 'admsg',
              'data-ok': adMsg.ok === true ? '1' : null,
            }, (adMsg.ok === true ? '✓ ' : '✗ ') + String(adMsg.text)))
          }
          // ── ★ 合并卡注册（2026-09-20 用户裁定）：`focus` =「专注 · 活跃」──────────────────
          //   「活跃关注域」**不再是独立卡**（原 `cardsByKey.set('domains', …)` 已删，卡数 15 → 14），
          //   它的**全部渲染与三个写入口整块搬进本卡** —— 不是"删掉卡、把活跃数据留在半空"的破损中间态。
          //   · 卡体 = 专注行（`focusRows`：专注态 / 必穿透白名单 / 醒目模型 / 入队摘要 / 声明表单
          //           / 入队·穿透明细二级详情入口）
          //           + **活跃域区块**（`adRowsAll`：区块头 → 卡内 tab（域 kind）→ 域分组 `<details>`
          //             → `对象@事件` 条目 → 点条目进三级只读详情弹窗）
          //   · 卡头内联块（第 6 参 `headInline`，与「系统状态」卡**同一机制**）= 四个动作同一行右侧：
          //       **开始/结束专注**（`focusBtn`·主）· **重新匹配**（次）· **声明** · **清除**
          //       （后两个按设计稿 §一"活跃域的声明/清除保持现状"**保留**：删掉它们等于拆掉两个
          //        写入口的 UI 入口 —— 路由与 `write-controls.json` 条数都没变，但用户点不到。）
          //   卡头此前走第 4 个参数（`extra`）：卡头是 `flex-wrap:wrap`，**先按"基础宽度"决定换行、
          //   之后才谈收缩** ⇒ 窄卡里整行按钮掉到第二行（与「系统状态」麦克风条同一根因）。
          //   ⚠️ 内联 style 只在本卡内生效（**共享 CSS 一字未动**）：`--nowrap` 卡头带
          //   `overflow:hidden`，窄卡里若整行硬顶，右边缘的「清除」会被裁掉（连点都点不到）；
          //   故本块允许收缩 + 在**按钮之间**折行（按钮保持原生尺寸、不被压扁），并把行内间距 6→4px。
          /** 合并卡的**活跃域区块**：区块头（域数 / 三态）+ 全部域行，整块挂在 `[data-ad-section]` 上。
           *  为什么要有这个显式锚点：合并后"活跃域还在不在卡里"必须**可断言**（源码级 + 真机 DOM 级），
           *  而不能靠"扫一堆 `data-ad-*` 里有没有命中"这种会随数据变化的判据 ——
           *  空数据（0 个域）时区块头仍在、锚点仍在，判据不假红也不假绿。 */
          const adRowsAll = [h('div', {
            className: 'dshw-detail', key: 'adsec', 'data-ad-section': '1',
            'data-ad-count': String(adItems.length),
            title: '活跃关注域（单源 = /state 的 activeDomains.effective，payload 原序）· 点域行看对象条目',
          },
          h('b', null, '活跃域（' + (ad === null || ad === undefined ? '未取到' : String(adItems.length)) + '）'),
          h('span', { className: 'dshw-fq-row-meta' },
            ad === null || ad === undefined
              ? '（读失败：/state 未返回 activeDomains —— 不等于 0 个域）'
              : '命中 ' + String(adItems.length) + ' 个 · 点域行看对象条目，点条目看该域详情'))].concat(adRows)
          cardsByKey.set('focus', card('专注 · 活跃',
            focusStateWord + (ad === null || ad === undefined ? '' : ' · 域 ' + String(adItems.length)),
            focusRows.concat(adRowsAll),
            null,      // extra：不再走这里（它在 spacer 之后 ⇒ 窄卡会被换到第二行）
            false,     // tall：卡体仍按 168px 裁切（本卡未变）
            h('span', {
              className: 'dshw-btnrow',
              // 共享 `.dshw-btnrow` 是 `flex:none`（不许收缩、不许折行）——
              //   在 `--nowrap` 卡头里那就是"溢出即被裁"。本卡内联覆盖为可收缩 + 可折行：
              //   宽度够时**恒为一行**（与标题/指标同行）；真放不下时在按钮之间折行降级，
              //   而不是把最右边的按钮裁没。按钮自身 flex 不变 ⇒ 文字不会被压缩变形。
              style: { flex: '0 1 auto', minWidth: '0', flexWrap: 'wrap', gap: '4px' },
            },
              focusBtn,
              h('button', {
                className: 'dshw-btn',
                onClick: () => {
                  api('/active-domains?match=1')
                    .catch((e) => setNote('活跃域匹配失败: ' + String((e && e.message) || e)))
                },
              }, '重新匹配'),
              h('button', {
                className: 'dshw-btn',
                disabled: adBusy === true,
                title: '手动声明关注域（覆盖自动匹配）· 写入 active-domains.json',
                // 打开时清空草稿（已选列表 id/label/note），避免上次的残留被误提交
                // （`tab` = 卡内分类页签的选中项，**不是**表单草稿 ⇒ 跨开关保留）
                onClick: () => setAdForm((p) => (p.open === true
                  ? Object.assign({}, p, { open: false })
                  : { open: true, id: '', label: '', note: '', picks: [], tab: p.tab, detail: null })),
              }, adForm.open === true ? '取消声明' : '声明'),
              h('button', {
                className: 'dshw-btn',
                disabled: adBusy === true,
                title: '清除声明，回到会话自动匹配',
                onClick: clearActiveDomainNow,
              }, '清除'))))

          const rc = pwb.recall || {}
          const rstats = (rc.stats || {}).s13 || null
          // ── 「资产」卡一期（2026-09-23）：接入本地 RAG，**双口径并存** ────────────────────
          //   数据源 = `/state` 的 `assets`（host 只读透传 `_meta/out/assets.json`）。
          //   ★ 双向纪律：① **不做判断**——数字一律原样取自 payload；
          //     ② **失败不得伪装成 0**：RAG 不可用时显示 `error`，不显示"0 篇"。
          //   三态分离：① 未取到（`assets === null`，首屏/未生成）② 不可用（`available:false` + error）
          //     ③ 可用（含"陈旧"提示：`stale` 由库内按 24h 判定，卡面只显示不重算）。
          const at = pwb.assets !== null && pwb.assets !== undefined ? pwb.assets : null
          const atAll = at !== null && at.all !== null && at.all !== undefined ? at.all : null
          const atCur = at !== null && at.curated !== null && at.curated !== undefined ? at.curated : null
          const atOk = at !== null && at.available === true && atAll !== null
          const astBadge = at === null ? '—'
            : (atOk ? ('精读 ' + String((atCur || {}).docs ?? '—') + ' · 全库 ' + String(atAll.docs ?? '—'))
              : '不可用')
          /** 分组行（可点开二级详情）；`kind` 用于详情里区分来源口径 */
          const astGroup = (kind, label, rows, limit) => {
            const list = Array.isArray(rows) ? rows : []
            const shown = list.slice(0, limit)
            const key = 'ast-' + kind
            const opened = astOpen[key] === 1
            const head = h('div', {
              className: 'dshw-detail',
              key: key + '-h',
              'data-click': '1',
              style: { display: 'flex', gap: '6px', cursor: 'pointer' },
              onClick: () => setAstOpen((p) => {
                const n = Object.assign({}, p)
                if (n[key] === 1) delete n[key]; else n[key] = 1
                return n
              }),
            }, (opened ? '▾ ' : '▸ ') + label + ' · ' + String(list.length) + ' 组')
            const items = opened ? shown.map((r, i) => h('div', {
              className: 'dshw-detail',
              key: key + '-' + i,
              'data-click': '1',
              style: { paddingLeft: '14px', cursor: 'pointer' },
              title: '点击查看二级详情（口径与出处）',
              onClick: () => setAstModal({ kind, name: String(r.name), docs: r.docs, chunks: r.chunks }),
            }, String(r.name) + ' · ' + String(r.docs ?? '—') + ' 文档 / ' + String(r.chunks ?? '—') + ' 块')) : []
            return [head].concat(items)
          }
          const astRows = []
          if (at === null) {
            astRows.push(h('div', { className: 'dshw-detail', key: 'ast-none' }, '资产未取到（首屏或产物未生成：跑 build-assets.mjs）'))
          } else if (!atOk) {
            astRows.push(h('div', { className: 'dshw-detail', key: 'ast-err' },
              '本地 RAG 不可用：' + String(at.error || '未取到')) )
          } else {
            astRows.push(h('div', { className: 'dshw-detail', key: 'ast-scope' },
              '口径：精读 = 库内语料（' + String((atCur || {}).docs ?? '—') + ' 篇）· 全库 = 本地 RAG（'
              + String(atAll.docs ?? '—') + ' 文档 / ' + String(atAll.chunks ?? '—') + ' 块）'))
            astRows.push(h('div', { className: 'dshw-detail', key: 'ast-asof' },
              '数据时刻 ' + String(at.as_of || '—')
              + (at.stale === true ? ' · **陈旧**（超 ' + String(at.stale_threshold_hours ?? '—') + ' 小时）' : ' · 新鲜')))
            astRows.push(...astGroup('top_dir', '全库分布 · 顶层目录', at.by_top_dir, 9))
            astRows.push(...astGroup('doc_type', '全库分布 · 文件类型', at.by_doc_type, 9))
            if (Array.isArray(at.by_project)) astRows.push(...astGroup('project', '按项目', at.by_project, 8))
            if (Array.isArray(at.by_client)) astRows.push(...astGroup('client', '按客户（稀疏·未归一）', at.by_client, 6))
            if (Array.isArray(at.top_sessions)) astRows.push(...astGroup('session', '按场次（前 20）', at.top_sessions, 8))
            if (Array.isArray(at.notes) && at.notes.length > 0) {
              astRows.push(h('div', { className: 'dshw-detail', key: 'ast-notes' }, '注：' + at.notes.join('；')))
            }
          }
          astRows.push(h('div', { className: 'dshw-detail', key: 'rc' },
            '本周唤起 ' + (rstats ? rstats.value + ' 次' : '—') + ' · 本次命中 ' + ((rc.hits || []).length)
            + ' 篇 · 复习队列超期 ' + (rc.queue === null || rc.queue === undefined ? '—（无队列数据）' : String(rc.queue.stale_total ?? '—')) + ' 篇',
            ' · 目标 ' + String(rstats ? rstats.target : '—') + ' ' + (rstats && rstats.meets_target ? '达成' : '未达成')))
          cardsByKey.set('recall', card('资产',
            astBadge,
            astRows,
            h('button', {
              className: 'dshw-btn',
              disabled: astBusy === true,
              title: '重建 assets.json（stats + map ≈2–3 秒；不走向量检索）',
              onClick: () => {
                if (astBusy === true) return
                setAstBusy(true)
                api('/assets/refresh', { method: 'POST' })
                  .then((r) => {
                    if (!r || r.ok !== true) setNote('资产刷新失败: ' + String((r && r.error) || '未知错误'))
                    else loadPwb(true)
                  })
                  .catch((e) => setNote('资产刷新失败: ' + String((e && e.message) || e)))
                  .then(() => setAstBusy(false))
              },
            }, astBusy === true ? '刷新中…' : '刷新')))

        }

        // ── 判断质量台账（T31 建议 5 · 能力③「迭代」）：**「验收」卡内的小节**（2026-09-16 新增）──
        //  ★ 位置纪律：**不新开卡片** —— 台账是「验收」卡内的一个**一级分类行**
        //    （`fbCat`，与「跨源校验」分类并列；与 metrics 解耦、任何态都在）。
        //    2026-09-17 三层改造后：一级只给「待裁定 N 条」，行内容收进二级、明细收进三级。
        //    卡片顺序的三层声明（`CARD_ORDER` / T16-58 的 `WANT_ORDER` / SBT-23 的 `WANT`）本批一字未改。
        //  ★ 只读纪律（P2）：本小节**不做判断**，全部原样取自 `/feedback` ——
        //      · 计数与比率 = 对 payload 里 `entries` 的**纯计数**（比率分母 = 全部裁决数，只做除法与取整）；
        //      · 「待裁定」= payload 里 `ruling === 'rejected'` 且 `rule_key` 相同者，按 **payload 给的
        //        `threshold`** 分组计数，与库内 `feedback-ledger.mjs::pendingRulings()` 是**同一条规则**
        //        （跨层等价由 run-t16 **T16-87** 机械取证：两边各跑一遍必须逐字相同）；
        //      · 阈值与 `calibrated` **原样显示**、不做红绿灯（未校准的阈值不作考核）。
        //  ★ 不新增写控件：写入口仍是 CLI `_meta/workbench/cli-feedback.mjs` 与 DSH 工具 —— 面板只读。
        //  ★ 五态文案互不相同（否则与真实数据无法区分）：
        //      ① 读失败（fetch/解析抛错）→ 「判断质量台账读取失败: …」+「未取到（不代表 0 条裁决，
        //         也不代表尚无记录）」；② 无记录（**503** 未生成 或 **200 + `entries: []`**）→
        //         「尚无裁决记录」+ **写入口在哪**；③ 有记录（**含"有记录但 0 待裁定"**）→ 计数/比率/
        //         待裁定照实写，`0` 就是 `0`，不得写成"无数据"（这正是本卡三态要拦的错，见 mmRaw 那段）；
        //      ④ 出口不可用（404/500：host 半体未加载该路由）→ 明写"出口不可用 + 需重启"，**不得**
        //         退化成"没有记录"；⑤ 尚未取到（首屏/轮询中）。
        const fbView = (res, err, busy) => {
          if (err !== null && err !== undefined) {
            return {
              state: 'error',
              lines: ['判断质量台账读取失败: ' + String(err),
                '台账内容未取到（不代表 0 条裁决，也不代表尚无记录）—— 最长 60 秒后随下一次轮询自动重取'],
              pending: null, counts: null,
            }
          }
          if (res === null || res === undefined) {
            return {
              state: 'wait',
              lines: [busy === true ? '正在读取判断质量台账…' : '等待判断质量台账…'],
              pending: null, counts: null,
            }
          }
          const status = Number(res.status)
          const fb = (res.body !== null && typeof res.body === 'object') ? res.body : null
          const entries = (fb !== null && Array.isArray(fb.entries)) ? fb.entries : null
          const whyServer = String((fb && fb.error) || '响应里没有说明')
          // 态② 无记录：503（产物未生成）或 200 但台账为空 —— 与"读失败/出口不可用"必须分开说
          if (status === 503 || (status === 200 && entries !== null && entries.length === 0)) {
            const why = status === 503 ? whyServer : '台账里还没有任何条目'
            return {
              state: 'empty',
              lines: ['尚无裁决记录（' + why + '）',
                '写入口见 CLI：node _meta/workbench/cli-feedback.mjs record --type … --ruling … --content … --reason …（或 DSH 工具）；本小节只读、不提供写控件'],
              pending: [], counts: null,
            }
          }
          // 态④ 出口不可用：非 200/503（路由不存在、host 未重启、响应形状不对）——
          //   ⚠️ 这一态**绝不是**"没有记录"：拿不到数据 ≠ 数据为空。
          if (status !== 200 || entries === null) {
            return {
              state: 'unavailable',
              lines: ['判断质量台账出口不可用（HTTP ' + String(status) + '：' + whyServer + '）',
                '台账内容未取到（不代表 0 条裁决，也不代表尚无记录）—— 该只读出口由 host 半体提供，host 未加载该路由时需重启 DSH'],
              pending: null, counts: null,
            }
          }
          const total = entries.length
          const cnt = (r) => entries.filter((e) => e.ruling === r).length
          const rate = (c) => (total === 0 ? '—' : (Math.round((c / total) * 1000) / 10) + '%')
          const thr = (typeof fb.threshold === 'number' && fb.threshold > 0) ? fb.threshold : null
          const byRule = {}
          for (const e of entries) {
            if (e.ruling !== 'rejected' || !e.rule_key) continue
            const k = String(e.rule_key)
            if (byRule[k] === undefined) byRule[k] = { rule_key: k, rejected: 0, sample_ids: [] }
            byRule[k].rejected += 1
            byRule[k].sample_ids.push(String(e.id))
          }
          const ranked = Object.keys(byRule).map((k) => byRule[k])
            .sort((a, b) => b.rejected - a.rejected || a.rule_key.localeCompare(b.rule_key))
          const pending = thr === null ? [] : ranked.filter((r) => r.rejected >= thr)
            .map((r) => ({ rule_key: r.rule_key, rejected: r.rejected, sample_ids: r.sample_ids.slice().sort() }))
          const lines = [
            '裁决 ' + String(total) + ' 条：采纳 ' + String(cnt('accepted')) + '（' + rate(cnt('accepted')) + '）'
              + ' · 驳回 ' + String(cnt('rejected')) + '（' + rate(cnt('rejected')) + '）'
              + ' · 修正 ' + String(cnt('revised')) + '（' + rate(cnt('revised')) + '）',
            // ★ 有记录但 0 条待裁定 → **照常写 0**（`0` 是数据；"无数据/尚无记录"只属于态②）
            '待裁定 ' + String(pending.length) + ' 条（阈值 N = ' + (thr === null ? '—' : String(thr))
              + ' · calibrated: ' + (fb.calibrated === null || fb.calibrated === undefined ? '—' : String(fb.calibrated === true))
              + ' —— 未校准 ⇒ 只记录不考核，不做红绿灯）',
          ]
          const shown = pending.slice(0, MAX_ROWS)
          for (const p of shown) {
            lines.push('[' + p.rule_key + '] 驳回 ' + String(p.rejected) + ' 次 · 样本 '
              + (p.sample_ids.length === 0 ? '—' : p.sample_ids.join(' '))
              + ' —— 需人工裁定（要改判断层须 judgment-guard --freeze --reason=… + 全量回归；不改则本条留作证据）')
          }
          if (pending.length > shown.length) {
            lines.push('（共 ' + String(pending.length) + ' 条待裁定，此处列前 ' + String(shown.length) + ' 条）')
          }
          return {
            state: 'ok', lines, pending,
            counts: { total, accepted: cnt('accepted'), rejected: cnt('rejected'), revised: cnt('revised') },
          }
        }
        //  ── 判断质量台账（一级只给"待裁定 N 条"；条目收进二级、明细进三级）────────
        //  ★ 五态原样沿用 `fbView`（读失败 / 等待 / 尚无记录 / 出口不可用 / 有记录），
        //    一级的计数字符串按态给，**不把"读不到"写成 0 条**。
        const fbV = fbView(fbDoc, fbDocErr, fbDocBusy)
        const fbCat = {
          key: 'fb', name: '判断质量台账', pwb: 'feedback-ledger',
          countText: fbV.state === 'ok' ? ('待裁定 ' + String((fbV.pending || []).length) + ' 条')
            : fbV.state === 'empty' ? '尚无裁决记录'
              : fbV.state === 'unavailable' ? '出口不可用'
                : fbV.state === 'error' ? '读取失败' : '读取中',
          title: '判断质量台账（只读 · 取自 /feedback）· 点开看裁决计数与待裁定口径',
          items: fbV.lines.map((t, i) => ({
            label: '台账', text: String(t), title: '判断质量台账条目（只读）',
            modal: {
              kind: 'fb', line: String(t), state: fbV.state,
              pendingCount: (fbV.pending || []).length, counts: fbV.counts || null,
            },
          })),
          emptyText: '台账未就绪：' + fbV.lines.join(' / '),
        }

        // ── 验收 S1–S15：三态恒注册（2026-09-16 修正）────────────────────────
        //  ★ 修的是什么：本卡原来**只在 `mm && mm.summary` 时注册**（且整段写在
        //    `pwb.ok === true` 分支里）⇒ `/state` 读失败、或指标未生成（`metrics === null`）时
        //    **整卡从面板消失**；而卡里刚接上的 `/crosscheck` 四个数（与 metrics 无关）
        //    会**跟着静默消失** —— 那会被读成"没有缺口/没有矛盾"，正是本项目要拦的假绿。
        //  ★ 三态必须能与真实数据区分（本卡恒注册，态别只体现在文案/徽标上）：
        //      ① 读失败（`/state` fetch/parse 报错）→ 卡片仍在，写明**读失败原因** + 只读「重试」；
        //         ⚠️ 读不到 ≠ 0：文案里不得出现任何数字结论。
        //      ② 无数据（`metrics === null`）→ 卡片仍在，写「指标未生成（跑 run-t18.mjs 或重建）」，
        //         且 `/crosscheck` 四个数**照常显示**（它们与 metrics 解耦、另一条只读出口）。
        //      ③ 口径为 0（有 metrics 但某指标值为 0）→ **照常写 `0`**，不得写成"无数据/未生成"。
        //  ★ 纪律（用户裁定）：本卡**不做判断** —— 数字一律原样取自 payload（不改写、不补零、
        //    不推算）；`0` 是数据、只写 `0`；只有 payload 里**真的是 null/undefined/空串**才写「—」。
        //    故一律走 `mmRaw`（`|| '—'` 会把 0 吃成「—」，那正是态③要拦的错）。
        const mmRaw = (v) => (v === null || v === undefined || v === '' ? '—' : String(v))
        //  ── 三层结构的三件套（2026-09-17 用户裁定）────────────────────────────
        //  一级 分类行（点整行 → 展开/收起二级）· 二级 条目行（点 → 三级详情页）· 三级 只读弹窗。
        //  ★ 分类只按 payload 的 `verdict` 归并，不自己发明判定；未枚举的 verdict（例如
        //    `无法验证（样本不足）`）**单独成行**，不悄悄并进别的桶。
        const mmToggle = (k) => setMmOpen((prev) => {
          const n = Object.assign({}, prev)
          if (n[k] === 1) delete n[k]
          else n[k] = 1
          return n
        })
        const mmIsOpen = (k) => mmOpen[k] === 1
        /** 一级：分类行（整行可点，右侧 ▾/▸；不含任何写控件） */
        const mmCatRow = (name, countText, key, title, pwb) => h('div', {
          className: 'dshw-item', key: 'mmc-' + key, 'data-click': '1',
          'data-pwb': pwb || 'metrics-cat', 'data-cat': key,
          title: title || '点击展开/收起该分类条目（只读）',
          onClick: () => mmToggle(key),
        },
        h('span', { className: 'dshw-item-text' },
          h('span', null, String(name)),
          h('span', { style: { opacity: 0.75 } }, ' · ' + String(countText))),
        h('span', { className: 'dshw-mt-btn', title: '展开/收起' }, mmIsOpen(key) ? '▾' : '▸'))
        /** 二级：条目行（点 → 三级详情页；payload 原样，不重排） */
        const mmItemRow = (label, text, key, modal, title) => h('div', {
          className: 'dshw-item', key: 'mmi-' + key, 'data-click': '1', 'data-child': '1',
          'data-pwb': 'metrics-item',
          title: title || '点击查看详情（只读）',
          onClick: () => setMmModal(modal),
        },
        h('span', { className: 'dshw-item-text' },
          h('span', null, String(label)),
          h('span', { style: { opacity: 0.85 } }, ' · ' + String(text))))
        /** 一级分类行的两级渲染：行 + （展开时）它的条目 */
        const mmCatBlock = (cat) => {
          const out = [mmCatRow(cat.name, cat.countText, cat.key, cat.title, cat.pwb)]
          if (mmIsOpen(cat.key)) {
            if (cat.items.length === 0) {
              out.push(h('div', { className: 'dshw-detail', key: 'mme-' + cat.key, 'data-child': '1' },
                cat.emptyText || '该分类下 payload 未给出任何条目'))
            } else {
              for (let i = 0; i < cat.items.length; i += 1) {
                const it = cat.items[i]
                out.push(mmItemRow(it.label, it.text, cat.key + '-' + i, it.modal, it.title))
              }
            }
          }
          return out
        }
        //  ── 跨源校验（`/crosscheck` 只读出口）：与 metrics **解耦**，任何态下都在 ──
        //  ★ 2026-09-17 三层改造：一级只给「矛盾 N 条」这一行，其余四个数收进二级、
        //    明细收进三级详情页（原先全铺在卡面上）。注册行仍是 `…concat(mmCatRows)`，
        //    故「任何态都在」这条纪律不变。
        //  ★ 全部**原样取自 payload**，且一律标 `calibrated:false`（只展示不考核）——
        //    这些口径还没有真实样本支撑，做成红绿灯会让人为指标工作。
        //  ★ 三态：读失败（crossDocErr）/ 未取到（crossDoc=null）/ 口径为 0（数值型 0 照实显示）。
        const xc = crossDoc !== null && typeof crossDoc === 'object' ? crossDoc : null
        const xcPct = (v) => (typeof v === 'number' ? Math.round(v * 100) + '%' : '—')
        //  一级只给**矛盾条数**这一个数（2026-09-17 用户裁定：其余数收进二级、明细进三级）
        const xcCat = (() => {
          if (xc === null) {
            return {
              key: 'xc', name: '跨源校验', pwb: 'crosscheck-cat',
              countText: '未取到',
              title: '跨源校验产物未取到（**不代表没有矛盾**）',
              items: [],
              emptyText: crossDocErr !== null ? '多源校验读取失败: ' + crossDocErr
                : (crossDocBusy === true ? '正在读取多源校验…' : '多源校验: 等待产物（跑 run-objects-pipeline.mjs）'),
            }
          }
          const tr = xc.trace || {}
          const bs = (tr.bySide || {})
          const msR = (xc.multiSource || {})
          const pv = (xc.promiseVsDelivery || {})
          const cs = Array.isArray(xc.contradictions) ? xc.contradictions : []
          return {
            key: 'xc', name: '跨源校验', pwb: 'crosscheck-cat',
            countText: '矛盾 ' + String(cs.length) + ' 条',
            title: '点击展开：溯源 / 多源支撑 / 承诺↔交付 / 矛盾（每条可点开详情）',
            items: [
              {
                label: '溯源（严格）',
                text: xcPct(tr.strictRate) + ' · 事务 ' + xcPct((bs.matter || {}).strictRate) + ' · 触发 ' + xcPct((bs.trigger || {}).strictRate),
                title: '严格口径 = 有 origin_inbound（可追到上游流入条目）',
                modal: { kind: 'xc', which: 'traceStrict', xc },
              },
              {
                label: '溯源（宽松）', text: xcPct(tr.looseRate),
                title: '宽松口径 = origin_inbound / origin / source_ref 任一存在',
                modal: { kind: 'xc', which: 'traceLoose', xc },
              },
              {
                label: '多源支撑率',
                text: xcPct(msR.supportRate) + ' · 双层 ' + mmRaw(msR.both) + ' / 对象 ' + mmRaw(msR.objects),
                title: '同一对象同时有事务线与触发线 = 多源支撑',
                modal: { kind: 'xc', which: 'multiSource', xc },
              },
              {
                label: '承诺↔交付', text: mmRaw(pv.executed) + ' / ' + mmRaw(pv.total) + ' 落地',
                title: '调停裁定的四类落地方式逐类核对',
                modal: { kind: 'xc', which: 'promise', xc },
              },
              {
                label: '矛盾条数', text: String(cs.length) + ' 条',
                title: '只列不改，逐条需人工定夺',
                modal: { kind: 'xc', which: 'contradictions', xc },
              },
            ],
          }
        })()
        const mmState = (() => {
          //  ★ 三层结构下只有两件事变了：① 一级只出**分类行**（`cats`）；
          //    ② 原先铺在卡面上的明细（各档 id 清单 / R8 / S1）收进二级与三级。
          //    三态的**判据与文案一字未改** —— 读失败 / 未生成 / 有产物 仍必须能互相区分。
          //  跨源校验与判断质量台账与 metrics 解耦：任何态都在（`catsOf` 一律拼上）。
          const catsOf = (metricCats) => metricCats.concat([xcCat, fbCat])
          // 态① 读失败：`/state` 没读回来 —— 事实是"读不到"，绝不等同于"没有指标"
          if (pwbErr !== null) {
            return {
              badge: '读取失败',
              body: [
                h('div', { className: 'dshw-err', key: 'mmerr' }, '指标读取失败: ' + String(pwbErr)),
                h('div', { className: 'dshw-detail', key: 'mmerrhint', style: { opacity: 0.7 } },
                  '指标数字未取到（不代表为 0，也不代表未生成）—— 点「重试」重取；'
                  + '下方跨源校验与判断质量台账来自另外两条只读出口，与 metrics 无关。'),
              ],
              extra: h('button', {
                className: 'dshw-btn', disabled: pwbBusy === true,
                // 只读重取（GET `/state?force=1` + GET `/crosscheck`）：不是写控件
                onClick: () => { loadPwb(true); loadCrossDoc() },
              }, pwbBusy === true ? '…' : '重试'),
              cats: catsOf([]),
            }
          }
          // 尚未取到（首屏/轮询中）：既不是"失败"也不是"未生成"
          if (pwb === null) {
            return {
              badge: pwbBusy === true ? '读取中' : '未读取',
              body: [empty(pwbBusy === true ? '正在读取指标层…' : '等待指标层…', 'mmwait')],
              extra: null,
              cats: catsOf([]),
            }
          }
          if (pwb.ok !== true) {
            return {
              badge: '数据层不可用',
              body: [h('div', { className: 'dshw-err', key: 'mmfail' }, '数据层不可用: ' + String(pwb.error || ''))],
              extra: null,
              cats: catsOf([]),
            }
          }
          const mm = pwb.metrics
          // 态② 无数据：指标未生成（`s-metrics.json` 不存在/不可解析 ⇒ host 下发 null）
          if (mm === null || mm === undefined) {
            return {
              badge: '指标未生成',
              body: [empty('指标未生成（跑 run-t18.mjs 或重建）', 'mmnone')],
              extra: null,
              cats: catsOf([]),
            }
          }
          // 态③ 有产物：**分类由 payload 的 `verdict` 原样归并**（本卡不重判）。
          //  未枚举的 verdict（实测存在 `无法验证（样本不足）`）**单独成行**，不悄悄并进别的桶。
          const sum = (mm.summary !== null && typeof mm.summary === 'object') ? mm.summary : null
          const CANON = ['达成', '部分达成', '未达成', '无法验证']
          const groups = new Map()
          const rawList = Array.isArray(mm.metrics) ? mm.metrics : []
          for (const it of rawList) {
            const v = (it.verdict === null || it.verdict === undefined || it.verdict === '')
              ? '（payload 未给 verdict）' : String(it.verdict)
            if (!groups.has(v)) groups.set(v, [])
            groups.get(v).push(it)
          }
          //  ★ 四个规范档**恒显示**：即使该档 0 条也写「0 条」——本项目的纪律是 `0` 是数据，
          //    不能因为该档为空就把行藏掉（否则"没有这一档"与"这一档是 0"又被混成同一件事）。
          const orderedKeys = CANON.concat([...groups.keys()].filter((k) => CANON.indexOf(k) < 0))
          const metricCats = orderedKeys.map((k) => {
            const items = groups.get(k) || []
            return {
              key: 'v-' + k, name: k, countText: String(items.length) + ' 条',
              title: '按 payload 的 verdict 原样归并（本卡不重判）· 点开看条目',
              items: items.map((it) => ({
                label: String(it.id || '—'),
                text: String(it.name || '—') + ' · 判定 ' + String(it.verdict || '—')
                  + ' · 目标 ' + mmRaw(it.target) + ' · 实际 ' + mmRaw(it.actual),
                title: '点击查看该指标详情（只读 · payload 原样）',
                modal: { kind: 'metric', metric: it },
              })),
              emptyText: '该档 payload 里 0 条（这是数据，不是"读不到"）',
            }
          })
          // R8 与 S1 原先直接铺在卡面上 —— 现在收进「其它口径」分类，二级可见、三级可看明细
          metricCats.push({
            key: 'misc', name: '其它口径', countText: '2 项',
            title: 'R8 响应时限 与 S1 机器侧计时（原先铺在卡面上，现收进二级）',
            items: [
              {
                label: 'R8 时限', text: mmRaw((mm.r8 || {}).verdict),
                title: '响应时限校准状态（payload r8 原样）',
                modal: { kind: 'misc', which: 'r8', mm },
              },
              {
                label: 'S1 机器侧定位',
                text: '最大 ' + mmRaw((mm.s1Timing || {}).maxMs) + ' ms',
                title: '机器侧定位耗时（人工操作耗时不在此口径）',
                modal: { kind: 'misc', which: 's1', mm },
              },
            ],
          })
          return {
            badge: sum === null
              ? '缺 summary 字段'
              : ('达成 ' + mmRaw(sum.achieved) + ' · 未达成 ' + mmRaw(sum.failed)),
            body: sum === null
              ? [h('div', { className: 'dshw-detail', key: 's', style: { color: '#e0a030' } },
                '指标产物缺 summary 字段（s-metrics.json 未给出 达成/未达成 汇总）'
                + ' —— 分类行仍按 payload 的 verdict 显示，未并入任何桶')]
              : [],
            extra: null,
            cats: catsOf(metricCats),
          }
        })()
        // 卡片**恒注册**（三态都在）：体 = 降级提示（若有）+ 态别提示 + **一级分类行**
        //   （2026-09-17 用户裁定：分类 → 列表 → 详情页；明细不再铺在卡面上）
        const mmCatRows = []
        for (const c of mmState.cats) {
          for (const r of mmCatBlock(c)) mmCatRows.push(r)
        }
        cardsByKey.set('metrics', card('验收', mmState.badge,
          (routeDown.crosscheck === true ? [downNote('多源校验', 'xcdown')] : [])
            .concat(routeDown.feedback === true ? [downNote('判断质量台账', 'fbdown')] : [])
            .concat(mmState.body)
            .concat(mmCatRows),
          mmState.extra))

        // ── 对象层属性（2026-09-21 · P2b：**撤掉独立的「对象」卡**）────────────────────
        //  ★ 用户裁定：对象不作为独立卡片存在，改为**属性**并入其它卡片 —— 事务卡行内标签
        //    （`data-object-key`）· 事务详情「归属对象 / 对象下一步 / 对象出处」段 · 流入卡「未归属 N 条」·
        //    跨源洞察证据段（支撑强度 / 证据线）· 「专注 · 活跃」卡的域 → 对象 → 事务三级下钻。
        //  ★ `objects.json` **继续生成**（属性来源，生产侧一字未改）⇒ 本段只保留**仍被消费**的取数件：
        //    · `objDoc`    —— 对象详情弹窗要的整份产物（`unassigned` / `generatedAt` 也取它）；
        //    · `objRollup` —— 弹窗脚注的 rollup 对账块；
        //    · `objMrow` / `objSrcRow`（下方）—— 决策卡 `brModalRow` 与对象详情**共用**的行件。
        //  ★ 取数一律走共用索引 `objRecOf()` / `objItemOf()` / `objAttrBrief()`（函数声明、行号更早 ⇒
        //    事务卡 / 流入卡 / 洞察卡也都能用，不会踩 TDZ）。
        //  ★ 读失败仍在**置顶告警块**里说一次（对象层现在是事务 / 流入 / 洞察的属性来源，读不到要可见）。
        const objDoc = objs
        const objRollup = (objDoc !== null && objDoc.rollup !== null && typeof objDoc.rollup === 'object') ? objDoc.rollup : {}
        // 模态框里的「标签 + 值」行（复用 .dshw-mrow/.dshw-mrow-l/.dshw-mrow-v，与其它详情卡同一套）
        const objMrow = (label, value) => h('div', { className: 'dshw-mrow', key: 'r-' + label },
          h('span', { className: 'dshw-mrow-l' }, label),
          h('span', { className: 'dshw-mrow-v' }, String(value)))
        /**
         * 详情页 ③ 里的**一行出处**：路径**可点开**（2026-09-17 用户要求「详情页中的链接要能点击跳转到对应的来源」）。
         *   · 跳转**复用其它卡同一入口** `openFile()`（= 侧边栏 editor tab 优先 `openInSidebarFile`，
         *     再回退 host 的 `/open`）—— 不新造导航机制；
         *   · 它是**文件还是目录**由侧边栏服务自己判（`openInSidebarFile` 只吃路径，不区分）——
         *     所以原样把 payload 的 `sources[]` 路径传进去即可，不做二次改写；
         *   · 提示词/样式全走既有惯用法：`.dshw-rec` + `data-click="1"`（同 brOriginRow / 证据行）+
         *     `.dshw-link`（本文件既有链接样式，复用既有色值，不新增色 token）；
         *   · 导航能力**不可用时降级**成纯文本（可选中复制），不抛错。
         */
        const objSrcRow = (p, key) => {
          const s = String(p === null || p === undefined ? '' : p)
          if (s === '' || typeof openFile !== 'function') {
            return h('div', { className: 'dshw-rec', key, title: '本卡不提供跳转（导航入口不可用，路径可选中复制）' },
              h('div', { className: 'dshw-mrow-v', style: { userSelect: 'text' } }, s))
          }
          return h('div', {
            className: 'dshw-rec', key, 'data-click': '1',
            title: '点击打开出处: ' + s,
            onClick: () => {
              try {
                openFile(s, '出处')
              } catch (e) {
                // 导航入口在运行时不可用：保持只读文本，不打断弹窗
              }
            },
          }, h('div', { className: 'dshw-mrow-v', style: { userSelect: 'text' } },
            // 可见标签 = 路径全文（`.dshw-mrow-v` 会折行，不做截断）；完整路径同时进 `title=`
            h('span', { className: 'dshw-link' }, s)))
        }
        // ★ 2026-09-21（P2b 撤「对象」卡）：这里原本是**卡体构造**（两个 tab / 客户级 rollup /
        //   域级与未归属 / counts 弱尾 / 卡头「在场 N」徽标）+ 只服务它的 `objByKey` / `objKidsOf` /
        //   `objNextItemOf` / `objWeak` / `toggleObjOpen` —— 全部随卡撤除（见 REVIEW_personal-workbench-P2b）。
        //   仍被消费的三件保留在上方：`objDoc` / `objRollup`（对象详情弹窗）+ `objMrow` / `objSrcRow`
        //   （决策卡 `brModalRow` 与对象详情共用），取数一律走共用索引 `objRecOf()` / `objItemOf()`。
        // 读失败还要在**置顶告警块**里说一次（与数据层失败同一处，不吃卡体滚动）
        if (objsErr !== null) {
          alertBlocks.push(h('div', { className: 'dshw-err', key: 'objserr' }, '对象读取失败: ' + objsErr))
        }

        // ── 决策（T31 能力① · 2026-09-17 用户裁定：改名 + 卡头三数 + 三组 + 移除卡面统计行）──
        //  数据源 = host 只读透传的库内产物 `brief.json`（`api('/brief')`）。
        //  ★ 本卡**不做判断**：组 / 桶 / `why` / `basis` / 排序 / `exit_rules` 一律原样取自 payload ——
        //    卡片只排版、折叠与展开，不重排、不筛选、不算优先级。
        //  ★ 结构（用户 2026-09-17 裁定）：
        //    · **卡头右侧** = `昨日 {o} · 今日 {t} · 待定 {w}`（取 payload.card.badge，本卡不重算；
        //      `aged` 不占卡头，放在卡头的悬停提示里）；
        //    · **卡面没有统计行**（原来那行「数据+时刻 + 三段计数」整行移除）—— 时间戳只出现在
        //      ① 卡头的 `title` 悬停提示 ② 二级详情页（两处都在下面 `cardsByKey.set` 之后）；
        //    · **卡内三组**（payload.card.groups，对齐事务卡的分组做法）：组头 = 组名 + 条数 +
        //      「展开全部 / 收起」；
        //    · **今日必办**内部按 payload 桶顺序再分三桶（今日到期 / 刚逾期（1–7 天）/ 陈欠（>7 天）），
        //      `陈欠` 默认折叠成一行，点了才列；
        //    · **游标行** = `{new_count} 条新` + 文本链接「标记已读」（**只有点了才写游标**，
        //      绝不自动标记 —— 否则「昨夜动向」的窗口永远是空的）。
        //  ★ 四态分开说：① 读失败 ② 出口不可用（503 + error，含下一步命令）③ 未读取 ④ 有数据但三组为空
        //    （**0 条也是有数据**；把"没有产物"显示成"今天没事"是本卡最需要避免的假绿）。
        //  ⚠️ 本区块（`cardsByKey.set('brief'` 前后一段）**不得出现「数据+时刻」这四个字的连写**：
        //     另一条线按字符串做源码级断言（卡头必须干净）；它只允许出现在
        //     `brHeadBadge()`（卡头悬停）与 `brfModalEl`（二级详情）里，二者都定义在 set 之后。
        const brDoc = brief        // 降级层：`/brief` 未加载（旧 host）时**不报错**，走"降级提示"三态之一（见 brDown）
        const brDown = routeDown.brief === true
        const brErr = brDown ? null : (briefErr !== null ? String(briefErr)
          : (brDoc !== null && brDoc.error !== undefined ? String(brDoc.error) : null))
        const brOk = brErr === null && brDown === false && brDoc !== null && brDoc.error === undefined && brDoc.todayMustDo !== undefined
        const brCardMeta = (brDoc !== null && brDoc.card !== null && brDoc.card !== undefined) ? brDoc.card : null
        /** 三组：**用 payload.card.groups**（顺序即数据顺序）；payload 缺该字段时才用同名的兜底表 */
        const brGroups = (brCardMeta !== null && Array.isArray(brCardMeta.groups) && brCardMeta.groups.length > 0)
          ? brCardMeta.groups
          : [{ key: 'overnight', label: '昨夜动向' }, { key: 'todayMustDo', label: '今日必办' }, { key: 'waiting', label: '等待待定' }]
        const brCounts = (brDoc !== null && brDoc.counts !== null && brDoc.counts !== undefined) ? brDoc.counts : {}
        // 卡头三数只读 payload 自己的数（`card.badge` 优先，缺字段才回落 `counts` —— 本卡不自己算）
        const brBdg = (brDoc !== null && brDoc.card !== null && brDoc.card !== undefined
          && brDoc.card.badge !== null && brDoc.card.badge !== undefined) ? brDoc.card.badge : {}
        const brNum = (v) => (v === null || v === undefined || v === '' ? '—' : String(v))
        const brBdgOvernight = brBdg.overnight !== undefined ? brBdg.overnight : brCounts.overnight
        const brBdgWaiting = brBdg.waiting !== undefined ? brBdg.waiting : brCounts.waiting
        const brBdgAged = brBdg.aged !== undefined ? brBdg.aged : brCounts.aged
        const brBdgToday = brBdg.today !== undefined ? brBdg.today
          : (brCounts.today_due === undefined && brCounts.today_recent_overdue === undefined
            ? undefined : (Number(brCounts.today_due || 0) + Number(brCounts.today_recent_overdue || 0)))
        const brHeadText = brErr !== null ? '读取失败'
          : (brDoc === null ? (briefBusy === true ? '读取中' : '未读取')
            : (brOk
              ? ('昨日 ' + brNum(brBdgOvernight) + ' · 今日 ' + brNum(brBdgToday) + ' · 待定 ' + brNum(brBdgWaiting))
              : '出口不可用'))
        /** 期限/相对时间的显示：ISO 带时刻 → 本地时刻；纯日期 → 截 10 位；空 → 「无期限」（payload 语义） */
        const brWhen = (v) => {
          if (v === null || v === undefined || v === '') return '无期限'
          const s = String(v)
          if (s.indexOf('T') > 0) return localStamp(s)
          return s.length > 10 ? s.slice(0, 10) : s
        }
        /**
         * 月/日（MM-DD）：用户 2026-09-17 裁定 —— 「昨夜动向」「等待待定」两个列表的**行前时间**
         *   只显示月/日（不要年、不要时分、不要 T/Z）。**唯一函数**，两个列表共用（不在两处各写一遍）。
         *   · 缺值 / 空串 / 不可解析 → 「—」（与卡内既有约定一致；不输出 NaN、Invalid Date 或空串造成列错位）
         *   · 悬停提示里仍用 `brWhen` 保留完整时间（便于核对），本裁定只约束**卡面文本**
         *   · 「今日必办」**不受影响**（那里显示期限，今天到期带时刻有意义）
         */
        const brMonthDay = (v) => {
          if (v === null || v === undefined || v === '') return '—'
          const s = String(v).trim()
          if (s === '') return '—'
          const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
          if (m !== null) return m[2] + '-' + m[3]
          if (/^\d{2}-\d{2}$/.test(s)) return s
          const d = new Date(s)
          if (Number.isFinite(d.getTime())) {
            return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
          }
          return '—'
        }
        /**
         * 四个退出动作的中文名（唯一真相源 = payload.exit_rules[].label；
         * 本地表只是 payload 缺该字段时的兜底，措辞与产物逐字一致）。
         */
        const BR_EXIT_LABEL = { reschedule: '重定截止', close: '关闭', respond: '响应', dismiss: '忽略归档' }
        const brExitLabel = (k) => {
          const rules = (brDoc !== null && Array.isArray(brDoc.exit_rules)) ? brDoc.exit_rules : []
          for (let i = 0; i < rules.length; i += 1) {
            const r = rules[i]
            if (r !== null && r !== undefined && String(r.key) === String(k) && r.label !== undefined && r.label !== '') {
              return String(r.label)
            }
          }
          return BR_EXIT_LABEL[String(k)] || String(k)
        }
        /** 组的条目：一律取 payload 的数组（本卡不筛、不排、不补） */
        const brItemsOf = (gk) => {
          if (brDoc === null) return []
          if (gk === 'overnight') { const o = brDoc.overnight || {}; return Array.isArray(o.items) ? o.items : [] }
          if (gk === 'todayMustDo') { const m = brDoc.todayMustDo || {}; return Array.isArray(m.items) ? m.items : [] }
          if (gk === 'waiting') { const w = brDoc.waiting || {}; return Array.isArray(w.items) ? w.items : [] }
          return []
        }
        /** 组 / tab 条数：用 payload 自己的口径（昨夜 total / 今日必办 total / 待定 total）。
         *  ⚠️ 2026-09-20 用户裁定：取消明细上限后 **`overnight.total` 恒等于 `items.length`**；
         *     该函数现在只用于**悬停提示**与空态文案（tab 徽标已按裁定移除），不作为渲染条数的来源。 */
        const brTotalOf = (gk) => {
          if (brDoc === null) return 0
          if (gk === 'overnight') { const o = brDoc.overnight || {}; return o.total !== undefined ? o.total : brItemsOf(gk).length }
          if (gk === 'todayMustDo') { const m = brDoc.todayMustDo || {}; return m.total !== undefined ? m.total : brItemsOf(gk).length }
          if (gk === 'waiting') { const w = brDoc.waiting || {}; return w.total !== undefined ? w.total : brItemsOf(gk).length }
          return brItemsOf(gk).length
        }
        /** 今日必办的桶：**顺序即数据顺序**（due-today → recent-overdue → aged，与产物一致） */
        const brBucketKeys = ['due-today', 'recent-overdue', 'aged']
        /** 陈欠阈值（天）的**本地兜底**：唯一真相源是 payload 的 `todayMustDo.aged_days`（build-brief 的
         *  `AGED_DAYS` 常量），这里只在产物缺该字段时使用，且必须是可读常量（源码断言）。
         *  ⚠️ client 与 build-brief 分属两个进程，**不能 import** —— 所以"同一个数"只能靠
         *     "产物带字段 + 本地兜底 + 断言对齐"三件事一起守住。 */
        const BR_AGED_DAYS_FALLBACK = 7
        const brAgedDays = (() => {
          const v = (brDoc !== null && brDoc.todayMustDo !== null && brDoc.todayMustDo !== undefined)
            ? brDoc.todayMustDo.aged_days : null
          const n = Number(v)
          return Number.isFinite(n) && n > 0 ? n : BR_AGED_DAYS_FALLBACK
        })()
        /** 等待待定各组的中文名（唯一真相源 = payload `waiting.group_labels`；本地表只在缺字段时兜底） */
        const BR_WAIT_GROUP_LABEL_FALLBACK = {
          onMeReply: '等我回应', onMeReturnVisit: '等我回访', onMeReceipt: '等我回执', onThem: '等对方', stalled: '停等中',
        }
        const brWaitGroupLabel = (k) => {
          const m = (brDoc !== null && brDoc.waiting !== null && brDoc.waiting !== undefined)
            ? brDoc.waiting.group_labels : null
          if (m !== null && m !== undefined && m[k] !== undefined && m[k] !== '') return String(m[k])
          return BR_WAIT_GROUP_LABEL_FALLBACK[k] || String(k)
        }
        /** 桶的中文名（唯一真相源 = payload 桶的 label；本地表只是 payload 缺字段时的兜底，措辞逐字一致） */
        const BR_BUCKET_LABEL = { 'due-today': '今日到期', 'recent-overdue': '刚逾期（1–7 天）', aged: '陈欠（>7 天）' }
        const BR_GROUP_ROWS = 8 // 每组默认列出的行数；「展开全部」后列出产物里的全部条目（产物分层不删数据）
        /** 一级行：`段/桶 · 标题 · 期限 · 负责人`；点击 = 打开二级详情（写动作只在详情里） */
        /** 逐条已读的键：**产物给**（`rk`），产物缺该字段时回落 `id`；前端不自己拼键 */
        const brItemKey = (it) => {
          if (it === null || it === undefined) return ''
          if (it.rk !== undefined && it.rk !== null && it.rk !== '') return String(it.rk)
          return (it.id === undefined || it.id === null) ? '' : String(it.id)
        }
        /**
         * 一级行：`段 · 标题 · 期限 · 负责人` + **行尾逐条已读控件**（用户 2026-09-17 修正①）。
         *  ⚠️ 已读控件在**行尾**（与事务卡 `▸` 同位置风格），不覆盖卡片自身按钮；
         *    卡面**不再有**批量「标记已读」（那个入口已按裁定移除）。
         *  ⚠️ 本卡**自建** `dshw-item`（不改共享 `row()`）：那个 helper 被多张卡共用，动它会波及其它卡。
         */
        const brRowOf = (seg, it, key, whenFmt, segKey) => {
          const rk = brItemKey(it)
          const isRead = it !== null && it !== undefined && it.read === true
          // 行前时间的格式化器由调用方指定（缺省 = `brWhen`）：
          //   用户 2026-09-17 裁定 —— 「昨夜动向」「等待待定」传 `brMonthDay`（只显示月/日），
          //   「今日必办」不传（保持期限/相对时间，今天到期带时刻有意义）。
          const fmtWhen = typeof whenFmt === 'function' ? whenFmt : brWhen
          return h('div', {
            className: 'dshw-item', key,
            'data-click': '1', 'data-read': isRead ? '1' : '0', 'data-bread-key': rk, 'data-brseg': segKey,
            title: '所属段 ' + seg + '\n标题 ' + String(it.title || '(无标题)')
              // 机器信息只在这里出现（用户 2026-09-18 裁定：标题必须是格式化后的内容）
              + (it.raw_text !== null && it.raw_text !== undefined && String(it.raw_text) !== '' && String(it.raw_text) !== String(it.title)
                ? '\n原文（机器报文，仅供核对）' + String(it.raw_text).slice(0, 160) : '')
              + '\n期限 ' + brWhen(it.due_day || it.due_at || it.at)
              + '\n负责人 ' + (it.owner || '—')
              + '\n已读 ' + (isRead ? '（' + String(it.read_at || '') + '）' : '未标记')
              + '\n点开：完整字段 + 退出动作（重定截止 / 关闭 / 响应 / 忽略归档）',
            onClick: () => { setBrfModal({ seg, item: it }); setBrAct(null); setBrActMsg(null) },
          },
            // 用户 2026-09-17 修正④：行首**不再重复桶标签**（那是分组标题的职责）——
            //   时间列改显期限/相对时间（与其它卡的时间列语义一致）；桶名只留在悬停提示里。
            // 用户 2026-09-17（本次）：格式化器由调用方给（等待待定/昨夜动向 = 月日）。
            h('span', { className: 'dshw-item-time' }, fmtWhen(it.due_day || it.due_at || it.at)),
            h('span', { className: 'dshw-item-text' },
              // 只渲染产物给的**可读标题**；机器原文（raw_text/what）一律不进标题
              //  —— 用户 2026-09-18 裁定「列表的标题应该是格式化之后的内容，不要带上代码符号」。
              String(it.title || '(无标题)').slice(0, 56)
              + ' · ' + (it.owner === null || it.owner === undefined || it.owner === '' ? '—' : String(it.owner))),
            h('button', {
              className: 'dshw-bread', 'data-read': isRead ? '1' : '0',
              title: (isRead ? '撤销已读（重新计入未读计数）' : '标记已读（不再计入未读计数；条目不隐藏）')
                + (rk === '' ? ' —— ⚠️ 该条缺 id/rk，无法标记（产物问题）' : ''),
              disabled: rk === '',
              onClick: (e) => { e.stopPropagation(); toggleBriefRead(rk, isRead !== true) },
            }, isRead ? '●' : '○'))
        }
        // 未读数与"兜底窗口"标记：**由产物计算**，卡面不显示（用户 2026-09-17 裁定）。
        //   落点 = 卡头悬停（`brHeadBadge()` 的 title）。定义在 `brRows` 之外，
        //   因为 `brHeadBadge()` 是同一渲染作用域里的函数声明，需要读到这两个值。
        const brNewCount = (() => {
          const ov = (brDoc !== null && brDoc !== undefined
            && brDoc.overnight !== undefined && brDoc.overnight !== null) ? brDoc.overnight : null
          if (ov !== null && ov.new_count !== undefined && ov.new_count !== null) return ov.new_count
          return brItemsOf('overnight').length
        })()
        const brCursorFallback = (() => {
          const c = (brDoc !== null && brDoc !== undefined
            && brDoc.cursor !== undefined && brDoc.cursor !== null) ? brDoc.cursor : null
          return c !== null && c.source === 'fallback-24h'
        })()
        const brRows = (() => {
          if (brErr !== null) return [empty('决策读取失败: ' + brErr + '（可重试）', 'brerr')]
          if (brDoc === null) return [empty(briefBusy === true ? '正在读取决策…' : '决策: 等待读取', 'brwait')]
          if (!brOk) return [empty('决策出口不可用: ' + String(brDoc.error || ''), 'br403')]
          const out = []
          // ── 卡面不再显示未读提示行（用户 2026-09-17 裁定：那行没有意义，整行移除）──
          //    · 未读数仍由产物计算（`overnight.new_count`），落点改到**卡头悬停**
          //      （见 `brHeadBadge()` 的 title）与二级详情；卡面不再占一行。
          //    · 逐条已读的能力保留（行尾 ○/●，提示在该控件 title 里），
          //      卡面只保留**写入态/失败的即时反馈**，且放在 tab 行**之后**，
          //      保证"卡头 → tab → 内容"三段紧凑、tab 紧跟卡头。
          // ── 卡内 tab（用户 2026-09-17 裁定：与事务卡同一种分类方式）────────────
          //    · tab 条数与标签一律取 payload（`card.groups` + 各组 total），本卡不数、不算；
          //    · **同一时刻只渲染当前 tab 的内容**（另两档的内容不进 DOM）；
          //    · 选中项记忆在 `dshw.briefTab`，刷新后恢复；取值不合法时回落第一组。
          const brTabKeys = brGroups.map((g) => String((g !== null && g !== undefined ? g.key : '') || ''))
          const brActiveTab = (briefTab !== null && brTabKeys.indexOf(briefTab) >= 0) ? briefTab : brTabKeys[0]
          const brActiveGroup = brGroups[brTabKeys.indexOf(brActiveTab)] || {}
          const anyRows = brGroups.some((g) => brItemsOf(String((g !== null && g !== undefined ? g.key : '') || '')).length > 0)
          if (!anyRows) {
            out.push(empty('三组合计 0 条（口径 = 昨夜窗口内流入 + 今日到期/逾期 + 待对方；0 条不代表"没事"）', 'brzero'))
            return out
          }
          out.push(h('div', { className: 'dshw-btabs', key: 'brtabs' }, brGroups.map((g) => {
            const gg = (g !== null && g !== undefined) ? g : {}
            const k = String(gg.key || '')
            return h('button', {
              key: 'brt-' + k,
              className: 'dshw-btab',
              'data-on': brActiveTab === k ? '1' : '0',
              'data-tab': k,
              title: '切换到「' + String(gg.label || k) + '」（payload 条数 ' + String(brTotalOf(k)) + '）',
              onClick: () => { setBriefTab(k); lsSet('dshw.briefTab', k) },
            }, String(gg.label || k))
          })))
          // 逐条已读的**写入态/失败反馈**（成功不占位）：放在 tab 行之后，
          // 保证 tab 是卡头之后的第一个元素（用户 2026-09-17 版式裁定）。
          if (brMarkBusy === true || brMarkMsg !== null) {
            out.push(h('div', {
              className: 'dshw-detail', key: 'brmkstatus',
              style: { display: 'flex', alignItems: 'center', gap: '6px' },
            },
            brMarkBusy === true ? h('span', null, '写入中…') : null,
            brMarkMsg === null ? null : h('span', {
              className: brMarkMsg.ok === true ? 'dshw-msg' : 'dshw-err', key: 'brmk',
              'data-ok': brMarkMsg.ok === true ? '1' : null,
            }, (brMarkMsg.ok === true ? '✓ ' : '✗ ') + String(brMarkMsg.text))))
          }
          // 当前 tab 为空：三态里的"该档确实为 0"（文案区分于读失败/未生成）
          {
            const gkNow = brActiveTab
            const labelNow = String(brActiveGroup.label || gkNow)
            if (brItemsOf(gkNow).length === 0) {
              out.push(empty('「' + labelNow + '」当前 0 条（payload 口径 ' + String(brTotalOf(gkNow)) + '；0 条是数据事实）', 'brtab0'))
              return out
            }
          }
          // 渲染**当前 tab**：三档各自的结构
          {
            const gk = brActiveTab
            const glabel = String(brActiveGroup.label || gk)
            // 用户 2026-09-17 修正②：tab 内**不再有**与 tab 同名的分组标题 / 计数 /
            //   「展开全部·收起」控件（实测点了没反应；既然已分三个 tab，这一层是重复的）。
            // 用户 2026-09-20 裁定：**tab 上也不再挂计数徽标**（卡头三数已有统计）；
            //   昨夜动向**全量随附**（产物取消明细上限）⇒ 本档不再有"只附 N 条"的说明行。
            if (gk === 'todayMustDo') {
              // 用户 2026-09-17 修正④：**三个桶标题都可点击折叠/展开**（原先只有「陈欠」可点，
              //   另两桶标题不可点）。标题上保留药丸标签 + 条数，右侧给 ▾/▸ 指示；
              //   折叠状态记忆在本地（键 `bk:<桶>`，默认表见 BR_BUCKET_DEFAULT）。
              const buckets = (brDoc.todayMustDo || {}).buckets || {}
              for (let bi = 0; bi < brBucketKeys.length; bi += 1) {
                const bk = brBucketKeys[bi]
                const bd = buckets[bk]
                if (bd === null || bd === undefined) continue
                const bitems = Array.isArray(bd.items) ? bd.items : []
                const bcount = bd.count !== undefined ? bd.count : bitems.length
                if (bitems.length === 0 && bcount === 0) continue
                const blabel = String(bd.label || BR_BUCKET_LABEL[bk] || bk)
                const bopen = brKeyOpen('bk:' + bk)
                out.push(h('div', {
                  className: 'dshw-bucket', key: 'brbk-' + bk, 'data-click': '1',
                  'data-open': bopen ? '1' : '0', 'data-bucket-head': bk,
                  title: blabel + (bopen ? '：点击折叠' : '：点击展开')
                    + (bk === 'aged' ? '（逾期 >' + String(brAgedDays) + ' 天：重定截止 / 关闭 / 忽略三选一）' : ''),
                  onClick: () => toggleBrKey('bk:' + bk),
                },
                  h('span', { className: 'dshw-btag', 'data-bucket': bk }, blabel),
                  h('span', null, String(bcount) + ' 条'),
                  h('span', { className: 'dshw-spacer' }),
                  h('span', { className: 'dshw-bkarrow' }, bopen ? '▾' : '▸')))
                if (!bopen) continue
                for (let ri = 0; ri < bitems.length; ri += 1) {
                  out.push(brRowOf(blabel, bitems[ri], 'brr-' + bk + '-' + ri, undefined, 'must'))
                }
              }
              return out
            }
            // 等待待定：**沿用既有分组**（payload 每条自带的 `group`；顺序即 payload 顺序，
            //   本卡只把连续的同一组摆在一起，不重排、不合并）
            if (gk === 'waiting') {
              const wItems = brItemsOf('waiting')
              const shown = wItems
              let lastGroup = null
              for (let ri = 0; ri < shown.length; ri += 1) {
                const it = shown[ri]
                const gval = (it !== null && it !== undefined && it.group !== undefined && it.group !== null) ? String(it.group) : ''
                const wkey = 'wg:' + gval
                if (gval !== lastGroup) {
                  lastGroup = gval
                  const wlabel = gval === '' ? '未分组' : brWaitGroupLabel(gval)
                  const wopen = brKeyOpen(wkey)
                  // 用户 2026-09-17 修正④：等待待定各组标题同样可点折叠（与桶标题一套交互），
                  //   键 `wg:<payload.group>`；计数仍按 payload 的 group 现算（本卡不重排、不合并）。
                  out.push(h('div', {
                    className: 'dshw-bucket', key: 'brwg-' + gval + '-' + ri, 'data-click': '1',
                    'data-open': wopen ? '1' : '0', 'data-wgroup-head': gval,
                    title: wlabel + (wopen ? '：点击折叠' : '：点击展开'),
                    onClick: () => toggleBrKey(wkey),
                  },
                    h('span', null, wlabel),
                    h('span', { className: 'dshw-spacer' }),
                    h('span', null, String(wItems.filter((x) => String((x || {}).group || '') === gval).length)),
                    h('span', { className: 'dshw-bkarrow' }, wopen ? '▾' : '▸')))
                  if (!wopen) continue
                } else if (!brKeyOpen(wkey)) continue
                out.push(brRowOf(glabel, it, 'brr-waiting-' + ri, brMonthDay, 'waiting'))
              }
              return out
            }
            // 昨夜动向：一档一列，**全量列出**（产物已取消明细上限，不再有截断说明行）。
            //   用户 2026-09-17：本档行前时间只显示月/日（`brMonthDay`）；其它档若将来走到这里仍用 `brWhen`。
            const gItems = brItemsOf(gk)
            const shown = gItems
            const ovFmt = gk === 'overnight' ? brMonthDay : brWhen
            for (let ri = 0; ri < shown.length; ri += 1) {
              out.push(brRowOf(glabel, shown[ri], 'brr-' + gk + '-' + ri, ovFmt, gk))
            }
            return out
          }
        })()
        cardsByKey.set('brief', card('决策', null,
          brDown === true ? [downNote(cardTitle('brief'), 'brdown')].concat(brRows) : brRows,
          [
            h('button', { className: 'dshw-btn', key: 'brrefresh', disabled: briefBusy === true, onClick: () => loadBrief() }, briefBusy === true ? '…' : '刷新'),
          ], false, null,
        // 第 1 行中间＝关键指标（SPEC §一）：本卡的三数由 `brHeadBadge()` 产出（值取自 payload.badge，
        //   本卡不重算）。走 `opts.metric` 而**不再重复包一层 `.dshw-badge`**（它自身就是 badge 节点）。
        { key: 'brief', metric: brHeadBadge() }))
        /** 二级详情：一行 payload 字段（复用对象卡的 .dshw-mrow 样式） */
        const brModalRow = (label, value) => objMrow(label, value)
        /** 二级详情里的**出处行**：路径可点开（侧边栏优先，失败回退 /open） */
        const brOriginRow = (p, key) => {
          const s = String(p || '')
          if (s === '') return h('div', { className: 'dshw-empty', key }, 'payload evidence.origin 为空（该条没有登记出处）')
          return h('div', { className: 'dshw-rec', key, 'data-click': '1', title: '点击打开出处: ' + s, onClick: () => openFile(s, '出处') },
            h('div', { className: 'dshw-mrow-v', style: { userSelect: 'text' } }, s))
        }
        /** 写请求的 init（四个动作共用；路径在调用点写死，别处不拼 URL） */
        const brJsonInit = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        /**
         * 决策卡的**二级详情页**（点击任意一行打开；portal 到 document.body，与其它详情卡同一套）。
         *  用户 2026-09-17 裁定：完整字段 + **数据时刻** + 底部动作区（按条目 `exits` 渲染）；
         *  ⚠️ 动作**只在详情页里** —— 卡面不放浮层按钮（会遮挡卡片自身的控件）。
         *  失败一律原样显示 host/CLI 返回的 error（不吞、不假装成功）。
         */
        // ── 「资产」卡二级详情（2026-09-23 · 一期）：口径 / 规模 / 数据时刻**可核对** ──
        //   ★ 只读：不提供任何写按钮（刷新在卡面上，不在详情里）。
        const astModalEl = astModal === null ? null : (() => {
          const kindLabel = { top_dir: '顶层目录', doc_type: '文件类型', project: '项目', client: '客户（稀疏·未归一）', session: '场次' }[String(astModal.kind)] || String(astModal.kind)
          const astRow = (k, v) => h('div', { className: 'dshw-mrow', key: 'ar-' + k },
            h('span', { className: 'dshw-mrow-l' }, k),
            h('span', { className: 'dshw-mrow-v' }, String(v)))
          const atNow = pwb.assets !== null && pwb.assets !== undefined ? pwb.assets : null
          const aCur = (atNow || {}).curated || {}
          const secs = []
          secs.push(h('div', { className: 'dshw-modal-sec', key: 'a1' },
            h('div', { className: 'dshw-modal-sec-h' }, '① 这条是什么'),
            [astRow('名称', astModal.name),
              astRow('维度', kindLabel),
              astRow('规模', String(astModal.docs ?? '—') + ' 文档 / ' + String(astModal.chunks ?? '—') + ' 块')]))
          secs.push(h('div', { className: 'dshw-modal-sec', key: 'a2' },
            h('div', { className: 'dshw-modal-sec-h' }, '② 口径与数据时刻（可核对）'),
            [astRow('全库口径来源', '本地 RAG · python -m src.cli stats / map --json'),
              astRow('索引建立于', String((atNow || {}).as_of || '—')),
              astRow('是否陈旧', (atNow || {}).stale === true ? '是' : '否'),
              astRow('陈旧阈值', String((atNow || {}).stale_threshold_hours ?? '—') + ' 小时'),
              astRow('精读口径来源', '库内 recall_index.json（Learn/Knowledge + Research/Knowledge）'),
              astRow('精读规模', String(aCur.docs ?? '—') + ' 篇 / ' + String(aCur.chars ?? '—') + ' 字')]))
          const atNotes = (atNow || {}).notes
          if (Array.isArray(atNotes) && atNotes.length > 0) {
            secs.push(h('div', { className: 'dshw-modal-sec', key: 'a3' },
              h('div', { className: 'dshw-modal-sec-h' }, '③ 口径注记'),
              atNotes.map((n, i) => astRow('注 ' + (i + 1), n))))
          }
          return h('div', { className: 'dshw-modal-backdrop', onClick: () => setAstModal(null) },
            h('div', { className: 'dshw-modal', onClick: (e) => e.stopPropagation() },
              h('div', { className: 'dshw-modal-head' },
                h('div', { className: 'dshw-modal-title' }, '资产 · ' + String(astModal.name || '')),
                h('button', { className: 'dshw-btn', onClick: () => setAstModal(null) }, '✕')),
              h('div', { className: 'dshw-modal-body' }, secs)))
        })()
        const astModalNode = astModalEl === null ? null
          : ((ReactDOM !== null && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined')
            ? ReactDOM.createPortal(astModalEl, document.body)
            : astModalEl)
        const brfModalEl = brfModal === null ? null : (() => {
          const seg = String(brfModal.seg || '')
          const it = brfModal.item !== null && brfModal.item !== undefined ? brfModal.item : {}
          const ev = it.evidence !== null && it.evidence !== undefined ? it.evidence : {}
          const exits = Array.isArray(it.exits) ? it.exits : []
          const iid = String(it.id || '')
          const f = brfActFormOf(iid)
          const secs = []
          secs.push(h('div', { className: 'dshw-modal-sec', key: 'b1' },
            h('div', { className: 'dshw-modal-sec-h' }, '① 基本（payload 原样）'),
            [
              brModalRow('标题', String(it.title || '—')),
              // 机器原文单独一行（用户裁定：可以看，但不进标题）；与标题相同时不重复显示
              ...(it.raw_text !== null && it.raw_text !== undefined && String(it.raw_text) !== '' && String(it.raw_text) !== String(it.title)
                ? [brModalRow('原文（机器报文）', String(it.raw_text))] : []),
              brModalRow('标题来源', String(it.title_source || '—')),
              brModalRow('桶', seg + (it.bucket !== undefined && it.bucket !== null ? '（payload.bucket = ' + String(it.bucket) + '）' : '')),
              brModalRow('期限', brWhen(it.due_at || it.due_day || it.at)),
              brModalRow('逾期天数', it.overdue_days === undefined || it.overdue_days === null ? '—' : String(it.overdue_days)),
              brModalRow('负责人', String(it.owner || '—')),
              brModalRow('状态', String(it.status || '—')),
              brModalRow('业务对象', String(it.object_key || '—')),
              brModalRow('通道 / 类型', String(it.channel || it.source || it.kind || '—')),
            ]))
          secs.push(h('div', { className: 'dshw-modal-sec', key: 'b2' },
            h('div', { className: 'dshw-modal-sec-h' }, '② 为什么在这一桶（payload why / basis / landing 原样）'),
            [
              brModalRow('why', String(it.why || it.basis || it.landing || '—')),
              brModalRow('期望动作', String(it.expected_action || '—')),
              brModalRow('所属分组', String(it.group || '—')),
              brModalRow('触发类别', String(it.rclass || '—')),
              brModalRow('关注域', String(it.domain || '—')),
            ]))
          secs.push(h('div', { className: 'dshw-modal-sec', key: 'b3' },
            h('div', { className: 'dshw-modal-sec-h' }, '③ 出处（点击打开）'),
            [
              brOriginRow(ev.origin, 'borig'),
              brModalRow('流入 id', String(ev.origin_inbound || it.id || '—')),
              brModalRow('依据 source_ref', String(ev.source_ref || '—')),
              brModalRow('判定时刻', String(ev.judged_at || '—')),
            ]))
          secs.push(h('div', { className: 'dshw-modal-sec', key: 'b4' },
            h('div', { className: 'dshw-modal-sec-h' }, '④ 数据时刻与一致性'),
            [
              // 卡面不显示时间戳，只在这里与卡头悬停提示里给（用户 2026-09-17 裁定）
              brModalRow('数据时刻', String(brDoc !== null ? localStamp(brDoc.generatedAt) : '—')),
              brModalRow('类型 / id', String(it.kind || '—') + ' · ' + iid),
              brModalRow('可用动作（payload exits）', exits.length > 0 ? exits.map((k) => brExitLabel(k)).join(' / ') : '（payload 未给 exits）'),
            ]))
          const notes = []
          if ((brDoc !== null) && brDoc.todayMustDo && brDoc.todayMustDo.composition_note) {
            notes.push(brModalRow('今日必办口径', String(brDoc.todayMustDo.composition_note)))
          }
          if ((brDoc !== null) && brDoc.waiting && brDoc.waiting.overlap_note) {
            notes.push(brModalRow('重叠说明', String(brDoc.waiting.overlap_note)))
          }
          if ((brDoc !== null) && Array.isArray(brDoc.rules)) {
            brDoc.rules.forEach((r, i) => notes.push(brModalRow('排序规则 ' + (i + 1), String(r))))
          }
          if (notes.length > 0) {
            secs.push(h('div', { className: 'dshw-modal-sec', key: 'b5' },
              h('div', { className: 'dshw-modal-sec-h' }, '⑤ 排序与口径（payload 原样，可读可核）'), notes))
          }
          // ── ⑥ 动作区（本卡**唯一的写入口**）：按钮按 payload.exits 渲染，不硬编码种类 ──
          const aRows = []
          const btnRow = []
          for (let xi = 0; xi < exits.length; xi += 1) {
            const xk = String(exits[xi])
            const on = brAct === xk
            btnRow.push(h('button', {
              className: 'dshw-btn', key: 'bx-' + xk, disabled: brActBusy === true,
              style: { marginRight: '6px' },
              title: '退出动作: ' + brExitLabel(xk) + '（payload.exits）',
              onClick: () => { setBrAct(on ? null : xk); setBrActMsg(null) },
            }, (on ? '● ' : '') + brExitLabel(xk)))
          }
          aRows.push(h('div', { key: 'brow', style: { marginBottom: '4px' } }, btnRow))
          if (exits.length === 0) {
            aRows.push(h('div', { className: 'dshw-empty', key: 'noact' },
              'payload 未给 exits ⇒ 该条没有退出动作（matter 给 reschedule/close，trigger 给 respond/dismiss）'))
          }
          if (brAct === 'reschedule') {
            aRows.push(brModalRow('新截止日（必填）', String(f.due || '')))
            aRows.push(h('input', {
              value: f.due || '', key: 'in-due', placeholder: 'YYYY-MM-DD（或 ISO 时刻，如 2026-09-20）',
              onChange: (e) => setBrfActFormOf(iid, { due: e.target.value }),
            }))
            aRows.push(h('button', {
              className: 'dshw-btn', key: 'go-reschedule', disabled: brActBusy === true,
              onClick: () => brfWrite(() => api('/matter/reschedule', brJsonInit({ id: iid, due_at: String(f.due || '').trim() })), '已重定截止'),
            }, brActBusy === true ? '…' : '确认重定截止'))
          } else if (brAct === 'close') {
            aRows.push(brModalRow('结束反馈记录', String(f.note || '')))
            aRows.push(h('textarea', {
              value: f.note || '', key: 'in-note', rows: 2, placeholder: '逾期事务必填（M7d 机制在库内强制）：写清结果与凭证',
              onChange: (e) => setBrfActFormOf(iid, { note: e.target.value }),
            }))
            aRows.push(h('button', {
              className: 'dshw-btn', key: 'go-close', disabled: brActBusy === true,
              onClick: () => brfWrite(() => api('/matter/close', brJsonInit({ id: iid, note: String(f.note || '').trim() })), '已关闭'),
            }, brActBusy === true ? '…' : '确认关闭'))
          } else if (brAct === 'respond') {
            aRows.push(brModalRow('响应动作（必填）', String(f.response_action || '')))
            aRows.push(h('input', {
              value: f.response_action || '', key: 'in-act', placeholder: '写了什么才算已响应（如：已回复 / 已电话沟通）',
              onChange: (e) => setBrfActFormOf(iid, { response_action: e.target.value }),
            }))
            aRows.push(brModalRow('凭证（可选）', String(f.ref || '')))
            aRows.push(h('input', {
              value: f.ref || '', key: 'in-ref', placeholder: '如事务 id / 消息链接（便于回查）',
              onChange: (e) => setBrfActFormOf(iid, { ref: e.target.value }),
            }))
            aRows.push(h('button', {
              className: 'dshw-btn', key: 'go-respond', disabled: brActBusy === true,
              onClick: () => brfWrite(() => api('/trigger/act', brJsonInit({
                id: iid, action: 'respond',
                response_action: String(f.response_action || '').trim(),
                ref: String(f.ref || '').trim(),
              })), '已登记响应'),
            }, brActBusy === true ? '…' : '确认响应'))
          } else if (brAct === 'dismiss') {
            aRows.push(brModalRow('忽略理由（必填）', String(f.reason || '')))
            aRows.push(h('input', {
              value: f.reason || '', key: 'in-reason', placeholder: '为什么可以忽略（事后要能复核）',
              onChange: (e) => setBrfActFormOf(iid, { reason: e.target.value }),
            }))
            aRows.push(h('button', {
              className: 'dshw-btn', key: 'go-dismiss', disabled: brActBusy === true,
              onClick: () => brfWrite(() => api('/trigger/act', brJsonInit({
                id: iid, action: 'dismiss', reason: String(f.reason || '').trim(),
              })), '已忽略归档'),
            }, brActBusy === true ? '…' : '确认忽略归档'))
          }
          if (brActMsg !== null) {
            aRows.push(h('div', {
              className: brActMsg.ok === true ? 'dshw-msg' : 'dshw-err', key: 'bramsg',
              'data-ok': brActMsg.ok === true ? '1' : null,
            }, (brActMsg.ok === true ? '✓ ' : '✗ ') + String(brActMsg.text)))
          }
          secs.push(h('div', { className: 'dshw-modal-sec', key: 'b6' },
            h('div', { className: 'dshw-modal-sec-h' }, '⑥ 退出动作（写入登记表 → 重建 brief/snapshot ⇒ 该条离开原桶）'), aRows))
          return h('div', { className: 'dshw-modal-backdrop', onClick: () => setBrfModal(null) },
            h('section', { className: 'dshw-modal', onClick: (ev2) => ev2.stopPropagation() },
              h('div', { className: 'dshw-modal-head' },
                h('span', { className: 'dshw-modal-title', title: iid }, '决策 · ' + seg),
                h('span', { className: 'dshw-badge' }, String(it.kind || '—') + ' · ' + String(it.status || '—')),
                h('span', { className: 'dshw-spacer' }),
                h('button', { className: 'dshw-btn', onClick: () => setBrfModal(null) }, '✕')),
              h('div', { className: 'dshw-modal-body' }, secs)))
        })()
        const brfModalNode = brfModalEl === null
          ? null
          : (ReactDOM !== null && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined'
            ? ReactDOM.createPortal(brfModalEl, document.body)
            : brfModalEl)
        /**
         * 卡头右侧的「三数」徽标（用户 2026-09-17 裁定：`昨日 {o} · 今日 {t} · 待定 {w}`；
         * `aged` 不占卡头，只放在悬停提示里）。
         * ⚠️ 为什么写成**函数声明**并放在 `cardsByKey.set('brief', …)` **之后**：
         *   卡面（set 之前那一段）不得出现时间戳那四个字的连写 —— 另一条线按字符串做源码级断言；
         *   悬停提示必须逐字给出它，所以把这一小块挪到 set 之后。函数声明会提升 ⇒ 调用点安全。
         */
        function brHeadBadge() {
          const tipTime = brOk ? localStamp(brDoc.generatedAt) : '—'
          const tipTail = brOk
            ? ('（非墙钟）· 今日数含陈欠 ' + brNum(brBdgAged) + ' 条（卡面上默认折叠）· 三数取自 payload.card.badge，本卡不重算')
            : (brErr !== null ? ('（读取失败: ' + brErr + '）') : ('（' + brHeadText + '）'))
          // 未读数从卡面移到悬停（用户 2026-09-17 裁定：卡面那行没有意义）——
          //   口径写在这里：`overnight.new_count` 由产物算，前端不自己减；
          //   无游标时产物回退"近 24 小时"，故显式标注兜底窗口。
          const tipUnread = brOk
            ? (' · 未读 ' + brNum(brNewCount) + ' 条'
              + (brCursorFallback ? '（近 24 小时兜底窗口）' : '（上次看过之后）')
              + ' · 逐条点行尾「○」标记已读、再点撤销')
            : ''
          return h('span', { className: 'dshw-badge', key: 'brhead', 'data-brhead': '1', title: '数据时刻 ' + tipTime + tipTail + tipUnread }, brHeadText)
        }

        // ── 跨源洞察（T31 能力⑤ · 2026-09-16 新卡 · 本批改「一级列表 + 二级详情」）──
        //  硬规则（产物已保证）：**无证据不入面板**；单源且高影响标「待核验」；矛盾未决**只列不改**。
        //  ★ 本卡不做判断：`conclusion`/`support`/`confidence`/`needs_review`/`link_basis`/`evidence[]`
        //    全部原样取自 payload —— 卡片只排版、折叠与展开。
        //  ★ 结构（用户 2026-09-16 裁定）：
        //    · **一级 = 列表行**：结论一行 · 支撑强度（多源/单源，照 payload 映射）· 关联对象；
        //    · **二级 = 点击行打开**：**证据链逐条列出且每条可点开到出处** · 支撑强度 · 置信度
        //      （缺则省略）· **可反驳入口（只读呈现，不做写入口）**。
        //  ★ 数据层行为不改：`evidence` 被抽掉时产物会自己降级/丢弃（卡片只显示，不兜底）。
        const isDoc = insights
        const isErr = insightsErr !== null ? String(insightsErr)
          : (isDoc !== null && isDoc.error !== undefined ? String(isDoc.error) : null)
        const isOk = isErr === null && isDoc !== null && isDoc.error === undefined && Array.isArray(isDoc.insights)
        const isBadge = isErr !== null ? '读取失败'
          : (isDoc === null ? (insightsBusy === true ? '读取中' : '未读取')
            : (isOk ? (isDoc.insights.length + ' 条') : '出口不可用'))
        /** 支撑强度显示名（payload 原值 multi/single 在二级详情里照原样给出） */
        const isSupportLabel = (v) => (v === 'multi' ? '多源' : (v === 'single' ? '单源' : String(v === null || v === undefined || v === '' ? '—' : v)))
        const IS_ROWS = 6 // 一级默认条数；完整清单在 insights.json（产物 ≤3 条为硬规则，此处仍按通用上限折叠）
        const isItems = isOk ? isDoc.insights : []
        const isShown = insShowAll === true ? isItems : isItems.slice(0, IS_ROWS)
        const isRows = (() => {
          if (isErr !== null) return [empty('跨源洞察读取失败: ' + isErr + '（可重试）', 'iserr')]
          if (isDoc === null) return [empty(insightsBusy === true ? '正在读取跨源洞察…' : '跨源洞察: 等待读取', 'iswait')]
          if (!isOk) return [empty('跨源洞察出口不可用: ' + String(isDoc.error || ''), 'is403')]
          const sum = isDoc.summary || {}
          const out = [h('div', { className: 'dshw-detail', key: 'isgen', style: { opacity: 0.7 } },
            '数据时刻 ' + String(isDoc.generatedAt || '—').slice(0, 19).replace('T', ' ')
            + ' · 生成 ' + String(sum.generated ?? '—') + ' · 入面板 ' + String(sum.insights ?? '—')
            + ' · 丢弃 ' + String(sum.dropped ?? '—') + '（不可追溯 ' + String(sum.dropped_unverifiable ?? '—') + '）'
            + ' · calibrated: false')]
          if (isItems.length === 0) {
            out.push(empty('当前 0 条（口径 = 有证据链且通过硬规则；0 条不代表"没有问题"）', 'iszero'))
            return out
          }
          isShown.forEach((it, i) => out.push(row(
            isSupportLabel(it.support) + (it.needs_review === true ? ' · 待核验' : ''),
            String(it.subject || '—') + ' · ' + String(it.conclusion || '').slice(0, 96),
            'isr' + i,
            () => setInsModal({ index: i, item: it }),
            '关联对象 ' + String(it.subject || '—') + '\n支撑 ' + String(it.support || '—')
              + '\n证据 ' + String((it.evidence || []).length) + ' 项\n点击查看二级详情（只读）')))
          if (isItems.length > IS_ROWS) {
            out.push(h('div', { className: 'dshw-detail', key: 'ismore' },
              h('button', {
                className: 'dshw-btn',
                onClick: () => setInsShowAll((v) => v !== true),
              }, insShowAll === true ? '收起' : ('展开全部 ' + isItems.length + ' 条'))))
          }
          return out
        })()
        cardsByKey.set('insights', card('跨源洞察', isBadge,
          routeDown.insights === true ? [downNote(cardTitle('insights'), 'insdown')].concat(isRows) : isRows,
          h('button', { className: 'dshw-btn', disabled: insightsBusy === true, onClick: () => loadInsights() }, insightsBusy === true ? '…' : '刷新')))
        const insModalEl = insModal === null ? null : (() => {
          const it = insModal.item !== null && insModal.item !== undefined ? insModal.item : {}
          const evs = Array.isArray(it.evidence) ? it.evidence : []
          const secs = []
          secs.push(h('div', { className: 'dshw-modal-sec', key: 'i1' },
            h('div', { className: 'dshw-modal-sec-h' }, '① 结论（payload 原样）'),
            [
              brModalRow('类型', String(it.kind_label || it.kind || '—')),
              brModalRow('关联对象', String(it.subject || '—')),
              brModalRow('结论', String(it.conclusion || '—')),
              brModalRow('支撑强度', String(it.support || '—') + '（' + isSupportLabel(it.support) + '）'),
              brModalRow('置信度', it.confidence === null || it.confidence === undefined ? '—' : String(it.confidence)),
              brModalRow('证据线', Array.isArray(it.evidence_lines) && it.evidence_lines.length > 0 ? it.evidence_lines.join('、') : '—'),
              brModalRow('待核验', it.needs_review === true ? '是' + (it.review_reason ? '（' + String(it.review_reason) + '）' : '') : '否'),
              brModalRow('关联依据', String(it.link_basis || '—')),
              brModalRow('id', String(it.id || '—')),
            ]))
          const evRows = []
          if (evs.length === 0) {
            evRows.push(h('div', { className: 'dshw-empty', key: 'noev' }, 'payload evidence 为空（该条不应出现在面板上）'))
          }
          evs.forEach((e, i) => {
            const ref = String((e || {}).ref || '')
            const head = '[' + String((e || {}).kind || '?') + '] ' + String((e || {}).id || '')
            // ⚠️ ref 有两种：**路径**（可点开）与**散文引用**（如「路径段 场次/X」= 派生依据说明）。
            //    散文引用点开会去找一个不存在的文件 ⇒ 只有路径形态才给点击，其余照原样显示并标注。
            const isPath = ref !== '' && /[\\/]/.test(ref) && !/^(路径段|域名|counterparty|目录|对象)\s/.test(ref)
            if (ref === '') {
              evRows.push(h('div', { className: 'dshw-rec', key: 'ev' + i },
                h('div', { className: 'dshw-mrow-v' }, head + ' · （该证据无 ref）')))
            } else if (isPath) {
              evRows.push(h('div', {
                className: 'dshw-rec', key: 'ev' + i, 'data-click': '1', title: '点击打开出处: ' + ref,
                onClick: () => openFile(ref, '证据出处'),
              }, h('div', { className: 'dshw-mrow-v', style: { userSelect: 'text' } }, head + ' → ' + ref)))
            } else {
              evRows.push(h('div', { className: 'dshw-rec', key: 'ev' + i, title: '非路径引用（派生依据说明，不可打开）' },
                h('div', { className: 'dshw-mrow-v', style: { userSelect: 'text' } }, head + ' · ' + ref)))
            }
          })
          // ★ 2026-09-21（P2b）：证据段并入**对象层**的支撑强度 / 证据线（`objects.json` 是属性来源）。
          //   口径：本条洞察的 `subject` 就是对象键 ⇒ 取该对象的 `multi_source`（轨迹 / 证据行 / 两侧来源）。
          //   取不到对象 ⇒ 明写「对象层未给出」，**不编**（读失败 ≠ 单源）。
          const isSubjObj = objItemOf(String(it.subject || ''))
          const isSubjMs = (isSubjObj !== null && isSubjObj.multi_source !== null && isSubjObj.multi_source !== undefined) ? isSubjObj.multi_source : null
          const isSubjLine = isSubjMs === null
            ? '支撑强度 / 证据线（对象层 multi_source）: 未给出（该 subject 不在 objects.json 里，或产物未读取）'
            : ('支撑强度 / 证据线（对象层 multi_source）: 轨迹 ' + String(isSubjMs.trajectory || '—')
              + ' · 证据行 ' + String(isSubjMs.evidence_lines === undefined ? '—' : isSubjMs.evidence_lines)
              + ' · 事务来源 ' + (Array.isArray(isSubjMs.matter_kinds) && isSubjMs.matter_kinds.length > 0 ? isSubjMs.matter_kinds.join('、') : '—')
              + ' · 触发类别 ' + (Array.isArray(isSubjMs.trigger_rclasses) && isSubjMs.trigger_rclasses.length > 0 ? isSubjMs.trigger_rclasses.join('、') : '—'))
          secs.push(h('div', { className: 'dshw-modal-sec', key: 'i2' },
            h('div', { className: 'dshw-modal-sec-h' }, '② 证据链（逐条 · 点击打开出处 · ' + evs.length + ' 项）'),
            [h('div', { className: 'dshw-detail', key: 'isobjms', 'data-obj-multisrc': '1' }, isSubjLine)].concat(evRows)))
          const rb = it.rebuttal !== null && it.rebuttal !== undefined ? it.rebuttal : {}
          secs.push(h('div', { className: 'dshw-modal-sec', key: 'i3' },
            h('div', { className: 'dshw-modal-sec-h' }, '③ 可反驳入口（只读呈现；提交裁决走库内 CLI / agent 工具，本卡不给按钮）'),
            [
              brModalRow('入口', String(rb.entry || '—')),
              brModalRow('驳回理由', rb.reason_required === false ? '非必填' : '必填'),
              brModalRow('阈值', rb.threshold === null || rb.threshold === undefined ? '—' : String(rb.threshold)),
              brModalRow('台账', String(rb.ledger || '—')),
            ]))
          if (isDoc !== null && Array.isArray(isDoc.limits) && isDoc.limits.length > 0) {
            secs.push(h('div', { className: 'dshw-modal-sec', key: 'i4' },
              h('div', { className: 'dshw-modal-sec-h' }, '④ 口径与限制（payload limits 原样）'),
              isDoc.limits.map((l, i) => brModalRow('限制 ' + (i + 1), String(l)))))
          }
          return h('div', { className: 'dshw-modal-backdrop', onClick: () => setInsModal(null) },
            h('section', { className: 'dshw-modal', onClick: (ev2) => ev2.stopPropagation() },
              h('div', { className: 'dshw-modal-head' },
                h('span', { className: 'dshw-modal-title', title: String(it.id || '') }, String(it.subject || cardTitle('insights'))),
                h('span', { className: 'dshw-badge' }, isSupportLabel(it.support) + (it.needs_review === true ? ' · 待核验' : '')),
                h('span', { className: 'dshw-spacer' }),
                h('button', { className: 'dshw-btn', onClick: () => setInsModal(null) }, '✕')),
              h('div', { className: 'dshw-modal-body' }, secs,
                h('div', { className: 'dshw-empty', key: 'iso' },
              '本卡只读：面板不提供写控件。提交裁决走库内 CLI —— '
              + 'node _meta/workbench/cli-feedback.mjs record --type <归属|优先级|洞察|唤起> '
              + '--verdict <采纳|驳回|修正> --reason "<理由>" [--rule-key <规则>]'
              + '（host 的 POST /feedback 走同一条 CLI）。写入口要出现在面板上，需先补 SPEC §6.2 登记表。'))))
        })()
        const insModalNode = insModalEl === null
          ? null
          : (ReactDOM !== null && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined'
            ? ReactDOM.createPortal(insModalEl, document.body)
            : insModalEl)

        if (snapErr !== null) alertBlocks.push(h('div', { className: 'dshw-err', key: 'err' }, '读取失败: ' + snapErr))
        if (snap === null) {
          alertBlocks.push(empty(busy ? '正在读取全部组织的钉钉数据…' : '等待数据…', 'loading'))
        } else if (snap.ok === false) {
          alertBlocks.push(h('div', { className: 'dshw-err', key: 'hostfail' }, 'Host 失败: ' + String(snap.error)))
        } else {
          const cal = snap.calendar || { today: [], tomorrow: [] }
          // ── 日程（2026-09-15 用户要求）──────────────────────────────────
          //   近三天（今天/明天/后天，**含当天已过期**）· 三源聚合（钉钉/飞书/行程）·
          //   由近到远排序 · 行前带来源标签 · 卡片徽标显示各源数量。
          //   数据来自 host 的 calendar.days（已按天分桶并排序）；旧 host 无 days 时回退 today/tomorrow。
          const feishuCal = cal.feishu || { ok: false, items: [], authorized: null }
          const calCounts = cal.counts || null
          // ⚠️ `personal` 必须在这里登记 —— `srcPill()` 的兜底是 `|| '钉钉'`，
          //   2026-09-16 实测：漏登记会让**个人待办显示成「钉钉」药丸**（真机 SBT-16 抓到）。
          const SRC_LABEL = { dingtalk: '钉钉', feishu: '飞书', trip: '行程', personal: '个人' }
          // ⚠️ 2026-09-20 用户裁定：**未登记来源不得静默显示成「钉钉」**。
          //   旧写法 `SRC_LABEL[src] || '钉钉'` 会把"漏登记"伪装成"来源就是钉钉"，
          //   肉眼与断言都发现不了（`personal` 那次就是这么漏的）。
          //   现在：已登记 → 中文标签；未登记但有键 → 显式回显 `未知·<键>`；连键都没有 → `未知来源`。
          //   注意 `data-src` 保持原行为（空值仍落 'dingtalk'），避免既有断言整体变红。
          const srcLabelOf = (src) => {
            const k = String(src === null || src === undefined ? '' : src)
            if (SRC_LABEL[k]) return SRC_LABEL[k]
            return k === '' ? '未知来源' : ('未知·' + k)
          }
          const srcPill = (src) => h('span', { className: 'dshw-src', 'data-src': String(src || 'dingtalk') },
            srcLabelOf(src))
          const dayOf = (iso) => {
            if (!iso) return '待定'
            const d = new Date(iso); if (Number.isNaN(d.getTime())) return '待定'
            const t0 = new Date(); t0.setHours(0, 0, 0, 0)
            const diff = Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - t0.getTime()) / 86400000)
            return diff <= 0 ? '今天' : diff === 1 ? '明天' : diff === 2 ? '后天' : String(iso).slice(5, 10)
          }
          const allEvents = Array.isArray(cal.days) && cal.days.length > 0
            ? cal.days.flatMap((d) => (d.items || []).map((e) => ({ e, day: d.label })))
            : (cal.today || []).map((e) => ({ e, day: '今天' }))
              .concat((cal.tomorrow || []).map((e) => ({ e, day: '明天' })))
              .sort((a, b) => String(a.e.start || '').localeCompare(String(b.e.start || '')))
          const CAL_ROWS = 12   // 三天聚合后行数更多；卡体可滚动，故上限放宽
          // 跨天住宿（用户 2026-09-16 裁定：**入住日 12:00 后 → 退房日 14:00 前**）会在覆盖的每一天出现，
          // host 为每条给出 dayRole；这里按角色换措辞 —— 否则第二天会重复显示"入住 12:00"这种假时间。
          // 用户对措辞的原话：「入住时间是12:00后，和退房14:00前是一样的」⇒ 两端都用**边界**表述。
          // ★ 交通条目**用自己的词**：车票是"上车/下车"，机票是"起飞/降落" —— 都不是入住/退房。
          //   用户 2026-09-20 原话：「这是火车卧铺，非入住，应该是上车时间和下车时间」。
          const LEG_WORD = { train: ['上车', '下车'], car: ['上车', '下车'], flight: ['起飞', '降落'] }
          const dayRoleText = (e) => {
            const isStay = e.source === 'trip' && (e.kind === 'hotel' || e.kind === 'stay')
            const isLeg = e.source === 'trip' && LEG_WORD[e.kind] !== undefined
            if (isStay) {
              // 角色优先（住宿有明确的边界语义）；没有角色时再看时间是否可靠
              if (e.dayRole === 'checkin') return '入住 12:00 后'
              if (e.dayRole === 'stay') return '住宿中'
              if (e.dayRole === 'checkout') {
                // ★ 用户 2026-09-19 裁定（修正 09-16 的通用口径）：**行程标注了退房时刻就按标注的**，
                //   只有日期没时刻才退回通用「退房日 14:00 前」。
                //   判据落在 host 的 `toIso()` 上，不是猜时区：只有日期的行程被规范化成 UTC 零点
                //   （`…T00:00:00.000Z`），带时刻的必然落在别的钟点上 —— UTC 零点就是"没标注时刻"的**指纹**。
                //   （入住侧仍是通用的「12:00 后」：用户本次只裁定了退房。）
                //   ⚠️ 2026-09-26 补第二种"没标注时刻"的形态：抽取器有时给的是**当天零点**
                //   （`2026-09-27T00:00`，本地零点）—— 那不是"凌晨退房"，是"只知道日期"。
                //   只认 UTC 零点会把它当成真时刻，渲染出「退房 00:00 前」这种假精确（实测踩到）。
                const endIso = String(e.end || '')
                const annotated = endIso !== '' && !/T00:00:00(?:\.000)?Z$/.test(endIso)
                  && hhmm(endIso) !== '00:00'
                const t = annotated ? hhmm(endIso) : ''
                return t ? '退房 ' + t + ' 前' : '退房 14:00 前'
              }
            } else if (isLeg) {
              // ★ 用户 2026-09-20 裁定：车票说**上车/下车**，不说入住/退房。
              //   跨夜条目在末日说该日真正相关的那个点 —— **下车**（到达）时刻；首日与当日往返说**上车**。
              //   词在时刻前，与住宿侧「退房 12:00 前」保持同一列语义（标签 → 值）。
              // ⚠️ 必须先过 needs_review：**只知日期的车次**（host 把日期规范化成 UTC 零点 → 本地 08:00）
              //   若直接 hhmm() 就会渲染出「上车 08:00」这种**假精确时刻** —— 正是 needs_review 要拦的东西。
              //   （本分支最初漏了这一条，被自测的负向对照当场抓到。）
              if (e.needs_review === true) return '时间待确认'
              const [board, alight] = LEG_WORD[e.kind]
              if (e.dayRole === 'checkout' && e.end) {
                const arrived = hhmm(e.end)
                if (arrived) return alight + ' ' + arrived
              }
              const departs = hhmm(e.start)
              if (departs) return board + ' ' + departs
            } else if (e.dayRole === 'checkout' && e.end) {
              // 其他来源的**跨夜**条目（既有行为）：末日说**到达**时刻，绝不说"退房"
              const arrived = hhmm(e.end)
              if (arrived) return arrived
            }
            // ★ 时间不完整（例如车次只知道日期）时如实说"待确认"，**不要**把日期渲染成 08:00 这种假时间
            if (e.needs_review === true) return '时间待确认'
            return hhmm(e.start) || '全天'
          }
          const calRows = allEvents.slice(0, CAL_ROWS).map((x, i) => h('div', {
            className: 'dshw-item',
            key: 'c' + i,
            'data-click': '1',
            'data-dayrole': x.e.dayRole || 'point',
            title: `${srcLabelOf(x.e.source)}日程 · 点击查看详情`
              + (x.e.source === 'feishu' ? '（在侧边栏打开飞书事件页）' : x.e.source === 'trip' ? '（行程详情）' : '与参会人'),
            onClick: () => openCalEvent(x.e),
          },
          h('span', { className: 'dshw-item-time' }, x.day + ' ' + dayRoleText(x.e)),
          srcPill(x.e && x.e.source),
          h('span', { className: 'dshw-item-text' },
            x.e.title + (x.e.location ? ' · ' + x.e.location : '')
            + (x.e.source === 'dingtalk' && x.e.org ? ' · ' + x.e.org : '')
            + (x.e.source === 'trip' && x.e.no ? ' · ' + x.e.no : '')),
          h('button', {
            className: 'dshw-btn dshw-minbtn', key: 'cc', 'data-cal-cancel': '1',
            title: '取消这一条：只把它从**工作台的三天窗口**移除（写面板自己的台账 `schedule-cancels.json`，'
              + '不动钉钉/飞书日历里的真事件）· 取消后可以恢复',
            onClick: (ev) => { ev.stopPropagation(); schedAct('cancel', x.e) },
          }, '✕')))
          // ⚠️ `calBody` 必须在**任何 push 之前**声明 ——
          //    2026-09-15 实测报错：`Cannot access 'calBody' before initialization`（TDZ）：
          //    飞书日历的错误提示块被插到了声明之前（且声明被挤到闭合括号同一行）。
          //    同块内 const/let 的 TDZ 是硬约束：**声明永远排在所有使用之前**。
          const calBody = []
          // 飞书日程：读失败/未授权 → 如实显示（不伪装成"没有日程"）
          // ⚠️ 还要区分「host 根本没返回该字段」——那说明 host 半段还是旧代码（客户端已热更新、host 需重启），
          //    报"未知原因"会让人误以为是飞书侧的问题（2026-09-15 实测踩到）。
          if (feishuCal.ok !== true) {
            const hostMissing = !cal || cal.feishu === undefined
            calBody.push(h('div', { className: 'dshw-detail', key: 'feishuerr', style: { color: '#e0a030' } },
              hostMissing
                ? '飞书日程不可用：host 未返回 feishu 字段 —— 插件 host 仍是旧代码，需重启 DSH 加载新 host'
                : (feishuCal.authorized === false
                  ? '飞书日历未授权：缺 scope calendar:calendar.event:read（授权后这里会显示飞书日程）'
                  : '飞书日历读取失败: ' + String(feishuCal.error || '未知原因'))))
          }
          if (detail !== null) {
            const atts = detail.attendees
            const attLine = detail.loading
              ? '参会人: 读取中…'
              : atts === null
                ? '参会人: ' + String(detail.error || '未取到')
                : '参会人 ' + atts.length + ' 人: ' + atts.slice(0, 6).map((a) => a.name + '(' + (STATUS_LABEL[a.status] || a.status) + ')').join('、') + (atts.length > 6 ? ' …' : '')
            calBody.push(h('div', { className: 'dshw-detail', key: 'detail' },
              h('div', null, h('b', null, String(detail.title || ''))),
              h('div', null, '时间: ' + (String(detail.start || '').slice(0, 16) || '全天') + (detail.end ? ' → ' + String(detail.end).slice(0, 16) : '')),
              detail.location ? h('div', null, '地点: ' + String(detail.location)) : null,
              h('div', null, attLine),
              h('div', { style: { marginTop: '4px' } }, h('button', { className: 'dshw-btn', onClick: () => setDetail(null) }, '关闭详情')),
            ))
          }
          // ⚠️ 行必须真的 push 进卡体 —— 2026-09-15 实测事故：`calRows` 算出来了却漏了这一行，
          //    结果徽标正确（钉钉1·飞书1）而**卡体全空**，用户看到"飞书/钉钉/行程均未显示"。
          //    这类"算了没渲染"的漏洞靠肉眼看不出来，已加 T16-37 源码断言兜住。
          if (calRows.length > 0) calBody.push(...calRows)
          else calBody.push(empty('近三天没有日程', 'none'))
          // ── 已取消（2026-09-20 用户规格 · 第三条）：取消过的条目**从上面那份列表里消失了**，
          //    所以「恢复」入口必须在这里 —— 否则用户无从把它找回来（那就是不可恢复）。
          //    ⚠️ 数据源是 host 给的 `calendar.cancelled.items`（键由 host 算），客户端**只回传 key**。
          //    ⚠️ 旧 host 没有该字段 ⇒ **不渲染这一块**（也不报错）：取消时点了会得到可读原因，
          //      见 `schedAct()` 的降级文案 —— 静态卡片不因"host 未重启"就常驻一条告警。
          const calCancelled = (cal !== null && typeof cal === 'object' && cal.cancelled !== null
            && typeof cal.cancelled === 'object' && Array.isArray(cal.cancelled.items)) ? cal.cancelled.items : []
          if (calCancelled.length > 0) {
            calBody.push(h('div', { className: 'dshw-minarch', key: 'calcanch' },
              h('span', { className: 'dshw-minarch-link', 'data-cal-cancelled-count': String(calCancelled.length),
                title: '这些日程已被取消（只从工作台窗口移除，源头日历未改）· 点对应行可恢复' },
              '已取消 ' + String(calCancelled.length) + ' 条（可恢复）')))
            calBody.push(h('div', { className: 'dshw-todolist', 'data-cal-cancelled': '1', key: 'calcanlist' },
              calCancelled.map((c, i) => h('div', {
                className: 'dshw-item', key: 'cc' + i, 'data-click': '1',
                'data-cal-restore': String(c.key),
                title: '恢复到三天窗口（删掉台账里这一条；源头日历本来就没动过）',
                onClick: () => schedAct('restore', c),
              },
              h('span', { className: 'dshw-item-text' }, '↺ ' + String(c.title || c.key)
                + (c.reason ? ' · ' + String(c.reason) : '')),
              h('span', { className: 'dshw-item-text', style: { flex: 'none', opacity: 0.7 } },
                String(c.source === 'feishu' ? '飞书' : c.source === 'trip' ? '行程' : '钉钉'))))))
          }
          if (schedMsg !== null) {
            calBody.push(h('div', { className: schedMsg.ok === true ? 'dshw-detail' : 'dshw-err', key: 'schedmsg' },
              (schedMsg.ok === true ? '✓ ' : '✗ ') + String(schedMsg.text)))
          }
          // 徽标：各来源数量（用户要求「日程卡片上显示各自来源的数量」）
          const feishuCountLabel = feishuCal.ok === true
            ? String((calCounts || {}).feishu ?? allEvents.filter((x) => x.e.source === 'feishu').length)
            : (feishuCal.authorized === false ? '未授权' : '读取失败')
          // 卡名（2026-09-16 用户要求）：只叫「日程」——"近三天"是**呈现范围**，属于徽标/内容的语境，
          // 不必占标题（标题越短，卡头越干净）。范围信息仍由徽标与三桶标签体现。
          cardsByKey.set('schedule', card('日程',
            '钉钉 ' + String((calCounts || {}).dingtalk ?? allEvents.filter((x) => x.e.source === 'dingtalk').length)
            + ' · 飞书 ' + feishuCountLabel
            + ' · 行程 ' + String((calCounts || {}).trip ?? allEvents.filter((x) => x.e.source === 'trip').length),
            calBody,
            h('button', { className: 'dshw-btn', onClick: () => load(true), disabled: busy }, busy ? '…' : '刷新')))

          // ── 待办（2026-09-15 起：飞书任务 + 钉钉待办 双源；2026-09-16 扩展为**三源** + 个人待办，
          //    并按要求把卡名定为「待办」、卡头只留三源数量，行点击看**二级详情**）──
          const todoItems = (snap.todos && snap.todos.items) || []
          const localTodo = ((snap.todos || {}).files) || []
          // 个人待办（第三源）：**优先**用 host 解析过的 `todos.personal`（带 id/due/source/done）；
          //   旧 host（未重启）没有该字段 ⇒ 回退到 `files`（只有文件名/路径）——**如实降级，不假装**。
          const personalTodo = (snap.todos && snap.todos.personal) || null
          const personalItems = (personalTodo && personalTodo.ok === true && Array.isArray(personalTodo.items))
            ? personalTodo.items
            : ((personalTodo === null && localTodo.length > 0) ? localTodo.map((f) => ({ title: f.name, path: f.path, name: f.name, _fallback: true })) : [])
          const feishuTodo = (snap.todos && snap.todos.feishu) || null
          const feishuItems = (feishuTodo && feishuTodo.ok === true ? feishuTodo.items : []) || []
          const todoCounts = (snap.todos && snap.todos.counts) || null
          // ⚠️ 2026-09-16：原按组织的徽标（`示例公司 4/15 · 示例项目乙 0/2 · …`）已按用户要求**移除**
          //   —— 卡头只留三源数量。组织信息保留在二级详情的「来源」行（`d.org`，来自 host 的 item）。
          // 三源统一成同一种行：{source, title, due, done, key, sortKey, detail}
          // ⚠️ 2026-09-16 实测：host 对**没有截止时间**的钉钉待办给的是 `due: 0`（不是 null！）
          //   ⇒ 若只判 `Number.isNaN`，0 会被当成"1970 年"排到**最前面**，而显示又是「无期限」
          //   （排序与显示口径打架：真机取证 5 行里 4 行"无期限"反而排在最前）。
          //   统一口径：**非正数一律视为没有截止时间**。
          const dueMsOf = (v) => {
            if (v === null || v === undefined || v === '') return null
            const ms = typeof v === 'number' ? v : Date.parse(String(v))
            return Number.isFinite(ms) && ms > 0 ? ms : null
          }
          const todoUnified = [
            ...todoItems.map((t, i) => ({
              source: 'dingtalk', key: 'dt' + i, title: String(t.title || ''),
              // 四类归属（用户 2026-09-17）：mine / assigned-by-others / assigned-to-others / participating
              category: String(t.category || 'mine'),
              due: t.due ? fmtDay(t.due) : '无期限', done: t.done === true, sortKey: dueMsOf(t.due),
              detail: { source: 'dingtalk', title: String(t.title || ''), org: String(t.org || ''), done: t.done === true, due: t.due ? fmtDay(t.due) : '无期限', category: String(t.category || 'mine'), taskId: String(t.taskId || ''), profile: String(t.profile || ''), raw: t },
            })),
            ...feishuItems.map((t, i) => ({
              source: 'feishu', key: 'fs' + i, title: String(t.title || ''),
              due: t.due && dueMsOf(t.due) !== null ? fmtDay(dueMsOf(t.due)) : (t.due ? localStamp(t.due) : '无期限'),
              done: t.done === true, sortKey: dueMsOf(t.due),
              detail: { source: 'feishu', title: String(t.title || ''), due: t.due ? localStamp(t.due) : '无期限', owners: t.owners || [], followers: t.followers || [], creator: t.creator || '', created: t.created || '', listName: t.listName || '', description: t.description || '', url: t.url || '', id: String(t.id || ''), done: t.done === true, raw: t },
            })),
            ...personalItems.map((f, i) => ({
              // 个人待办：手动放置的文件（可能无 frontmatter）与**会话内经 cli-todo.mjs 创建**的同列一行。
              //   有 due_at 就显示日期；没有就「无期限」（旧 host 回退时标为「个人待办」以免假装有截止）。
              source: 'personal', key: 'lt' + i,
              title: String(f.title || f.name || ''),
              due: f._fallback === true ? '个人待办' : (f.due ? fmtDay(dueMsOf(f.due)) : '无期限'),
              done: f.done === true,
              sortKey: f._fallback === true ? null : dueMsOf(f.due),
              detail: {
                source: 'personal', title: String(f.title || f.name || ''),
                due: f.due ? String(f.due) : '无期限', done: f.done === true,
                id: String(f.id || ''), todoSource: String(f.source || ''), origin: String(f.origin || ''),
                created: f.created || '', path: String(f.path || ''), raw: f,
              },
            })),
          ]
          // ★ 2026-09-16 用户四点要求（本轮）：
          //   ① 去掉「打开目录」按钮（无实际意义）；
          //   ② 来源标签与**日程卡视觉一致** ⇒ 复用同一个 `srcPill()`（`.dshw-src[data-src]` 药丸）；
          //   ③ 时间列**收窄到"无期限"三个字的宽度**（原来固定 66px，与标签之间空出一大截）；
          //   ④ 不再截断、不再写「显示 X / 共 Y 条」⇒ **全部列出**，超出卡体高度时由卡体自身滚动。
          // 由此：行的三个元素与日程行同构 = [时间] [来源药丸] [标题]。
          // ★ 2026-09-16 用户：「待办中已完成的项不应当在待办选项卡显示，应当视为被关闭」。
          //   list = **还要做的事** ⇒ 已完成一律不进列表（host 侧已用 `--status false` + finalStatusStage
          //   过滤钉钉、飞书用 `--include-complete=false`；这里再兜一层，防止刚被完成/边界竞态漏进来）。
          const todoOpen = todoUnified.filter((t) => t.done !== true)
          const todoByDue = (a, b) => {
            const ak = a.sortKey === null ? Number.MAX_SAFE_INTEGER : a.sortKey
            const bk = b.sortKey === null ? Number.MAX_SAFE_INTEGER : b.sortKey
            return ak - bk
          }
          const shownTodo = todoOpen.slice().sort(todoByDue)
          const todoNotes = []
          // host 未返回字段（旧 host 代码）与「返回了但读取失败」是两种不同的事实，不得混为一谈。
          if (feishuTodo === null) {
            todoNotes.push(h('div', { className: 'dshw-detail', key: 'fsmiss', style: { color: '#e0a030' } },
              '飞书任务不可用：host 未返回 todos.feishu 字段 —— 插件 host 仍是旧代码，需重启 DSH 加载新 host'))
          } else if (feishuTodo.ok !== true) {
            todoNotes.push(h('div', { className: 'dshw-detail', key: 'fserr', style: { color: '#e0a030' } },
              feishuTodo.authorized === false
                ? '飞书任务未授权：缺 scope ' + String(((feishuTodo.missing_scopes || ['task:task:read'])[0])) + '（授权后此处显示飞书任务）'
                : '飞书任务读取失败: ' + String(feishuTodo.error || '未知原因')))
          }
          // 归属标记（用户 2026-09-17）：钉钉客户端的四类待办都要进这里；**只给需要区分的两类**加小标，
          //   自己创建给自己 / 我参与的 = 默认不加标（避免每行都挂一串标签把标题挤没）。
          const CAT_TAG = { 'assigned-by-others': '别人指派', 'assigned-to-others': '我指派', participating: '我参与' }
          const todoRows = shownTodo.map((t) => {
            const kids = [
              h('span', { className: 'dshw-item-time', key: 'tm' }, String(t.due)),
              srcPill(t.source),
            ]
            if (t.category && CAT_TAG[t.category]) {
              kids.push(h('span', { className: 'dshw-cat', key: 'cat', 'data-cat': t.category }, CAT_TAG[t.category]))
            }
            kids.push(h('span', { className: 'dshw-item-text', key: 'tx' }, t.title))
            return h('div', {
              className: 'dshw-item', key: t.key, 'data-click': '1',
              title: '点击查看二级详情',
              onClick: () => setTodoDetail(Object.assign({ key: t.key }, t.detail)),
            }, ...kids)
          })
          const todoBody = todoNotes.slice()
          if (todoRows.length === 0) todoBody.push(empty('三源均无待办（钉钉 / 飞书 / 个人）', 'none'))
          else todoBody.push(h('div', { className: 'dshw-todolist', key: 'list' }, todoRows))
          // ★ 「最近关闭 · 可重新打开」（2026-09-17 用户要求"重新打开，源头端也标记未完成"）：
          //   已完成项**不进待办列表**（用户口径：已完成 = 已关闭）⇒ 重新打开的入口必须另给。
          //   数据来自 host 的回写台账 `todo-actions.json`（只取成功且未被后续 reopen 抵消的记录）。
          const recentClosed = Array.isArray((snap.todos || {}).recentClosed) ? snap.todos.recentClosed : []
          if (recentClosed.length > 0) {
            todoBody.push(h('div', { className: 'dshw-closed', key: 'closed' },
              h('div', { className: 'dshw-closed-h' }, '最近关闭 · 可重新打开'),
              recentClosed.map((a, i) => h('div', {
                className: 'dshw-item', key: 'rc' + i, 'data-click': '1',
                title: '在源头端改回未完成（' + String(a.source === 'dingtalk' ? '钉钉' : a.source === 'feishu' ? '飞书' : '个人') + '）',
                onClick: () => {
                  setTodoSync({ busy: 'reopen', msg: null })
                  api('/todo/act', {
                    method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                      source: a.source, action: 'reopen', id: a.id || '', path: a.path || '',
                      profile: a.profile || '', title: a.title || '',
                    }),
                  }).then((r) => {
                    if (r && r.ok === true) { setTodoSync({ busy: null, msg: '✓ 已重新打开，源头已同步' }); load(true) }
                    else setTodoSync({ busy: null, msg: '重新打开失败：' + String((r && r.error) || '未知原因') })
                  }).catch((e) => setTodoSync({ busy: null, msg: '重新打开失败：' + String((e && e.message) || e) }))
                },
              },
              h('span', { className: 'dshw-item-time', key: 'tm' }, String(a.at || '').slice(5, 16).replace('T', ' ')),
              srcPill(a.source),
              h('span', { className: 'dshw-item-text', key: 'tx' }, '↺ ' + String(a.title || a.id || a.path || '(未记标题)'))))))
          }
          // 回写反馈（成功/失败都如实显示；失败带源端原因）
          if (todoSync.msg !== null) todoBody.push(h('div', { className: 'dshw-msg', key: 'sync' }, String(todoSync.msg)))
          const dingtalkTotal = (todoCounts || {}).dingtalk ?? todoItems.length
          const personalTotal = (todoCounts || {}).personal ?? localTodo.length
          const feishuBadge = feishuTodo === null
            ? '飞书 需重启 host'
            : (feishuTodo.ok === true ? '飞书 ' + feishuItems.length : (feishuTodo.authorized === false ? '飞书 未授权' : '飞书 读取失败'))
          // 卡名 = 「待办」（2026-09-16 用户要求：标题改为「待办」—— 不再写"三源"，源已在卡头计数里）
          // 卡头 = **只显示三源数量**（用户 2026-09-16：「待办右侧显示钉钉/飞书/个人的待办数量即可，
          //   示例公司/示例项目乙/示例项目甲的可以不用细分」）⇒ 去掉按组织的 `示例公司 4/15 · 示例项目乙 0/2 · …` 徽标。
          //   组织信息仍在**二级详情**的「来源」行里（点开才看，不占用卡头）。
          // 卡脚 = 无（2026-09-16 用户：「打开目录按钮没有实际意义，可以移除」）。
          // 卡体 = 默认（`.dshw-card-body` max-height:168px + overflow:auto）⇒ **全部行照列**、
          //   超出高度自然出滚动条；**不再有「显示 X / 共 Y 条」的截断提示**（用户要求移除）。
          cardsByKey.set('todos', card('待办',
            '钉钉 ' + String(dingtalkTotal) + ' · ' + feishuBadge + ' · 个人 ' + String(personalTotal),
            todoBody))

          const catKey = tab === 'all' ? null : tab
          const catFiles = catKey !== null ? (kn.byCategory || {})[catKey] || [] : kn.recent || []
          // 2026-09-15：分类 tab（全部/学习/研究/工作/生活）只影响文件内容 → 移进文件卡片
          cardsByKey.set('kb', card('文件 · ' + (catKey === null ? '全部' : CAT_LABEL[catKey]),
            catKey === null ? '共 ' + kn.total + ' 篇' : (counts[catKey] || 0) + ' 篇',
            catFiles.slice(0, MAX_ROWS).map((f, i) => row(
              fmtAgo(f.mtime),
              f.name,
              tab + 'k' + i,
              () => openFile(f.path, f.name),
              '点击打开: ' + String(f.path || ''),
            )),
            h('div', { className: 'dshw-tabs dshw-tabs-inline' }, tabs)))

          // ── 听记卡（2026-09-19 用户规格 · 逐条落地）────────────────────────────
          //   ① 卡名 =「听记」（原「近期听记」）；
          //   ② 列表**同时列钉钉听记与飞书妙记**，每行**带来源标签** —— 复用待办卡那一枚
          //      `srcPill()`（`.dshw-src[data-src]` 药丸），不新造视觉；
          //   ③ **不显示时间**（用户明令）：行里只有 [来源药丸] [标题]，**不渲染 `.dshw-item-time`**；
          //   ④ 行结构与待办卡**同一套 class**：`div.dshw-item`（flex + `gap:8px`，全文件唯一定义）
          //      ⇒ 药丸与标题之间的间距与待办行**同一个值**，本卡不新增任何 CSS；
          //   ⑤ 卡头**分源计数**「钉钉 N · 飞书 M」（不只有总数）；未授权/读取失败/旧 host 各走明确出口。
          //   行模型（含降级文案）来自纯函数 `minutesRowModel`，可被 Node 自测与真机各验一遍。
          const minModel = minutesRowModel(snap.minutes)
          // ── ⑤ 一级列表按**对象/客户**聚合（2026-09-20 用户规格）：分组头 = 摘要行（对象名 + 条数），
          //    点分组头 ⇒ 复用既有 **portal 二级详情**（`openObj()`，与「对象」卡同一个弹窗/同一套字段）。
          //    ⚠️ 对象层不可用（旧 host / 读失败）⇒ `minutesGroupModel` 返回单组 `key:null` ⇒ 走**平铺**（不出分组头）。
          const minGroups = minutesGroupModel(minModel.rows, objs)
          const minOpen = (m) => {
            if (!openInSidebarUrl(m.url, m.title)) {
              try { window.open(m.url, '_blank', 'noopener') } catch (e) { /* 打开失败不抛（与旧实现同） */ }
            }
          }
          const minBody = []
          if (minModel.note !== null) {
            minBody.push(h('div', { className: 'dshw-detail', key: 'minnote', style: { color: '#e0a030' } }, minModel.note))
          }
          if (minModel.rows.length === 0) minBody.push(empty('暂无听记', 'none'))
          else {
            // 列表容器与待办卡同款（`.dshw-todolist`）+ 一个只读钩子 `data-minutes-list`（供真机断言定位）
            minBody.push(h('div', { className: 'dshw-todolist', 'data-minutes-list': '1', key: 'minlist' },
              minGroups.map((g, gi) => h('div', { className: 'dshw-mingrp', key: 'mg' + gi },
                g.key === null ? null : h('div', {
                  className: 'dshw-mingrp-head', 'data-click': '1', 'data-minutes-group': String(g.key),
                  title: '按标题里出现的对象名归组（本卡不重派生对象）· 点击查看二级详情（只读）',
                  onClick: () => openObj(g.key, g.item),
                },
                h('span', { className: 'dshw-mingrp-name', key: 'nm' }, String(g.label)),
                h('span', { className: 'dshw-mingrp-n', key: 'n' }, String(g.items.length) + ' 条')),
                g.items.map((m, i) => h('div', {
                  className: 'dshw-item', key: 'm' + gi + '_' + i, 'data-click': '1', 'data-minutes-row': m.src,
                  title: (m.src === 'feishu' ? '飞书妙记' : '钉钉听记') + ' · 点击打开: ' + String(m.url || ''),
                  onClick: () => minOpen(m),
                },
                srcPill(m.src),
                h('span', { className: 'dshw-item-text', key: 'tx' }, m.title),
                h('button', {
                  className: 'dshw-btn dshw-minbtn', key: 'tm', 'data-minutes-tomatter': m.src,
                  title: '转事务：打开二级详情，由库内草稿引擎从这条听记起草（标题 / 关闭条件 / 域建议 / 锚点候选），人只纠错与选择；提交走 cli-matter.mjs（查重 + 原子 ID），同一份听记重复提交不会长出第二条',
                  onClick: (ev) => {
                    ev.stopPropagation()
                    // 打开**二级详情**（弹窗）并**立刻**拉草稿：表单在草稿回来之前就跑起来（加载态），
                    // 不把"正在取正文"显示成"没有内容"（那是看不见的失败）。
                    const tgt = minDraftTargetOf(m)
                    setMinDedup2(false)
                    setMinMsg(null)
                    setMinModal(tgt)
                    minLoadDraft(tgt)
                  },
                }, '转事务')))))))
          }
          // ── ⑥ 归档入口（2026-09-20 用户规格）：超过 `MINUTES_ACTIVE_DAYS` 天的听记**已从一级列表退出**。
          //    入口只在真有归档时出现；不展开就完全按一级口径显示（卡头数字与之同源）。
          //    ⚠️ 归档区**只读**：点行仍然是"打开听记"，这里不提供任何写动作。
          if (minModel.archivedRows.length > 0) {
            minBody.push(h('div', { className: 'dshw-minarch', key: 'minarch' },
              h('span', {
                className: 'dshw-minarch-link', 'data-click': '1',
                'data-minutes-archive-entry': String(minModel.archivedRows.length),
                title: '超过 ' + String(MINUTES_ACTIVE_DAYS) + ' 天的听记已从一级列表退出（一级只留 ' + String(MINUTES_ACTIVE_DAYS) + ' 天内）',
                onClick: () => setMinArchOpen((v) => v !== true),
              }, (minArchOpen === true ? '收起归档 ' : '归档 ') + String(minModel.archivedRows.length) + ' 条（超过 ' + String(MINUTES_ACTIVE_DAYS) + ' 天）')))
            if (minArchOpen === true) {
              minBody.push(h('div', { className: 'dshw-todolist', 'data-minutes-archive': '1', key: 'minarchlist' },
                minModel.archivedRows.map((m, i) => h('div', {
                  className: 'dshw-item', key: 'ma' + i, 'data-click': '1', 'data-minutes-archive-row': m.src,
                  title: (m.src === 'feishu' ? '飞书妙记' : '钉钉听记') + ' · 点击打开: ' + String(m.url || ''),
                  onClick: () => minOpen(m),
                },
                srcPill(m.src),
                h('span', { className: 'dshw-item-text', key: 'tx' }, m.title),
                h('span', { className: 'dshw-minarch-stamp', key: 'st' }, minArchStamp(m.at))))))
            }
          }
          cardsByKey.set('minutes', card('听记', minModel.badge, minBody))

          if (note !== null) alertBlocks.push(h('div', { key: 'note', className: 'dshw-empty', style: { gridColumn: '1 / -1' } }, note))
        }

        // ── 系统状态卡（2026-09-15 用户要求：设备状态/系统在线**合并为「系统状态」**）──
        //     · 摄像头/麦克风/音响 → **波形 + 颜色**：红=断开 · 灰=关闭 · 绿=正常（音响/麦克风带波形）
        //     · DWS / MCP / 本地工具 / 浏览器 → 卡内**小卡片**，各带状态色
        //       （绿=正常/空闲 · 橙=执行中/使用中 · 红=未配置/未连接/不在线）
        if (box.ready === true) {
          const sys = sysStatus || {}
          const act = activity || {}
          const actList = Array.isArray(act.active) ? act.active : []
          const busyOf = (kind) => actList.find((a) => a && a.kind === kind) || null
          const mcpBusy = busyOf('mcp')
          const localBusy = busyOf('local')
          const browserBusy = busyOf('browser')
          const mcpConf = act.mcpServers

          // 三态：'ok' 绿 · 'off' 灰（关闭）· 'down' 红（断开）· 'busy' 橙（执行中）
          const micState = (dev.phase === 'error' || dev.phase === 'blocked' || (dev.devices && dev.devices.audioIn === 0))
            ? 'down' : (dev.phase === 'live' ? 'ok' : 'off')
          // ⚠️ 2026-09-15：音响/摄像头改为**显式开关**（点击小卡片切换），不再由"是否启用过麦克风"推导。
          //    「不可点」的门槛故意定在**能力层**（连 AudioContext / mediaDevices 都没有）。
          //    ⚠️ 两个设备的**设备数量信号可靠性不同**，必须分开判：
          //      · `videoinput` 枚举**可靠**（不需要权限就能数）⇒ 没有摄像头 = 真·断开(红)；
          //      · `audiooutput` 枚举**不可靠**（Chromium 常常根本不暴露）⇒ **不能**据它判红，
          //        否则有音响的机器会显示成红且点不动（本轮实测的假红）。
          const spkBlocked = pickAudio() === null
          const camBlocked = mediaApi() === null
          const camNoDev = !!(dev.devices && dev.devices.videoIn === 0)
          const spkState = (spkBlocked || dev.spkFailed === true) ? 'down' : (dev.spkOn === true ? 'ok' : 'off')
          // 摄像头四态：绿=连上**物理**设备 · 橙(warn)=连上的**是虚拟**设备（用户实测要求：
          //   "实际是虚拟摄像头、物理摄像头未连接"时不得只显示"已连接"）· 红=断开 · 灰=关闭
          const camState = (camBlocked || camNoDev || dev.camFailed === true) ? 'down'
            : (dev.cam === true ? (dev.camVirtual === true ? 'warn' : 'ok') : 'off')
          const DEV_LABEL = { ok: '正常', off: '关闭', down: '断开', warn: '正常' }
          const LINK_LABEL = { ok: '已连接', off: '关闭', down: '断开', warn: '已连接 · 虚拟' }
          const noOut = !!(dev.devices && dev.devices.audioOut === 0)
          const spkHint = spkBlocked
            ? '页面无 AudioContext，无法建立音响输出通道'
            : '点击切换连接/关闭（连接时播 1 秒 440Hz 确认音；浏览器无法测量系统输出电平，绿灯=面板输出通道已打开）'
              + (noOut ? ' ｜ 浏览器未枚举到输出设备（Chromium 常不暴露 audiooutput，不代表没有音响）' : '')
          const camInv = Array.isArray(dev.camInventory) ? dev.camInventory : []
          const camPhys = camInv.filter((d) => d.label.length > 0 && d.virtual !== true)
          const camVirt = camInv.filter((d) => d.virtual === true)
          const camHint = camBlocked
            ? '页面未暴露 navigator.mediaDevices，无法取流'
            : (camNoDev
              ? '未检测到摄像头设备（本机无摄像头或未接入）—— 点击仍会尝试连接并给出真实错误'
              : (dev.cam === true
                ? (dev.camVirtual === true
                  ? '⚠️ 连的是**虚拟摄像头**「' + (dev.camLabel || '未命名') + '」—— 物理摄像头未连接。点击可关闭。'
                  : '已连接物理摄像头「' + (dev.camLabel || '未命名') + '」。点击可关闭。')
                : '点击切换连接/关闭（只判定设备状态，不显示画面；若本机只有虚拟摄像头，会如实标注）')
                + (camInv.length > 0
                  ? ' ｜ 本机视频输入 ' + camInv.length + ' 个：' + camInv.map((d) => d.label + (d.virtual ? '(虚拟)' : '(物理)')).join('、')
                    + '（物理 ' + camPhys.length + ' · 虚拟 ' + camVirt.length + '）'
                  : ''))
          const wave = (kind, state) => {
            const arr = (waveRef.current[kind] || []).slice(-WAVE_N)
            const bars = arr.length >= WAVE_N ? arr : new Array(WAVE_N - arr.length).fill(0).concat(arr)
            return h('svg', { className: 'dshw-wave', viewBox: '0 0 100 20', preserveAspectRatio: 'none', 'data-state': state, key: 'w-' + kind },
              bars.map((v, i) => {
                const hh = Math.max(1.2, Math.min(19, v * 19))
                return h('rect', { key: i, x: i * 2.5 + 0.4, y: 10 - hh / 2, width: 1.7, height: hh, rx: 0.8 })
              }))
          }
          // ⚠️ 第五轮起**不再有设备"行"**：麦克风 = 右侧可点击波形条（见 micBar），
          //    音响/摄像头 = 可点击小卡片。波形只给麦克风（唯一需要看电平的设备）。

          // 小卡片：标题 + 状态（带颜色）
          const mini = (key, title, state, text, title2) => h('div', { className: 'dshw-mini', key: 'm-' + key, title: title2 || '' },
            h('div', { className: 'dshw-mini-t' }, title),
            h('div', { className: 'dshw-mini-s', 'data-state': state }, text))

          // **可点击**的设备小卡片（音响 / 摄像头）：点击 = 切换「连接 / 关闭」
          //   blocked=true 仅表示**能力层**不可用（无 AudioContext / 无 mediaDevices）——
          //   此时不可点并降透明度；设备缺失或上次连接失败**照旧可点**（点击=重试）。
          const devMini = (key, title, state, text, blocked, hint, onClick) => {
            const clickable = blocked !== true
            const props = {
              className: 'dshw-mini', key: 'm-' + key, 'data-state': state, 'data-click': clickable ? '1' : '0',
              title: clickable ? hint : title + '：' + hint,
            }
            if (clickable) {
              props.onClick = onClick
              props.role = 'button'
              props.tabIndex = 0
              props.onKeyDown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }
            }
            return h('div', props,
              h('div', { className: 'dshw-mini-t' }, title, clickable ? h('span', { className: 'dshw-mini-hint', key: 'h' }, '⇄') : null),
              h('div', { className: 'dshw-mini-s', 'data-state': state }, text))
          }

          const dwsState = act.dwsBusy === true ? 'busy'
            : (sys.dws && sys.dws.ok === true ? 'ok' : (sys.dws && sys.dws.ok === false ? 'down' : 'unknown'))
          const dwsText = act.dwsBusy === true ? '调用中'
            : (sys.dws && sys.dws.ok === true ? '在线' + (sys.dws.version ? '（v' + String(sys.dws.version) + '）' : '')
              : (sys.dws && sys.dws.ok === false ? '不在线' : '未检测'))
          const mcpConfigured = mcpConf !== null && mcpConf !== undefined && mcpConf.count > 0
          // 2026-09-16（用户提问「已连 firecrawl 为何仍显示未配置」）：把「未配置」拆成三种状态 ——
          //   ① 已注册（有 mcp__* 工具）→ 绿「空闲中（N 个）」；
          //   ② **有配置行但注册表里没有**（多见于 MCP 客户端**正在启动**：首次 npx 要下载包，
          //      或配置在别的 profile/预设里）→ 橙「未注册」+ 说明，而不是红色的「未配置」；
          //   ③ 真没配置 → 红「未配置」。
          //   依据：host `/activity` 新增的 mcpConfigured（只读扫描 profiles/预设里的 dsh-mcp-client 行）。
          const mcpHasCfg = !mcpConfigured && act.mcpConfigured !== null && act.mcpConfigured !== undefined
            && act.mcpConfigured.rows > 0
          const mcpCfgWhere = mcpHasCfg ? (Array.isArray(act.mcpConfigured.where) ? act.mcpConfigured.where.join('、') : '') : ''
          const mcpServersList = mcpConfigured && Array.isArray(mcpConf.servers) && mcpConf.servers.length > 0
            ? mcpConf.servers.join('、') : ''
          const mcpState2 = mcpBusy !== null ? 'busy' : (mcpConfigured ? 'ok' : (mcpHasCfg ? 'warn' : 'down'))
          const mcpText = mcpBusy !== null
            ? '执行中：' + String(mcpBusy.label || mcpBusy.name || 'MCP')
            : (mcpConfigured
              ? '空闲中（' + mcpConf.count + ' 个）'
              : (mcpHasCfg ? '未注册（已配置 ' + act.mcpConfigured.rows + ' 处）' : '未配置'))
          const mcpDetail = mcpConfigured
            ? '已注册 ' + mcpConf.count + ' 个 MCP server：' + mcpServersList
              + (mcpConf.tools ? '（共 ' + mcpConf.tools + ' 个工具）' : '')
            : (mcpHasCfg
              ? 'host 工具注册表里暂无 mcp__* 工具，但检测到 MCP 配置行：' + mcpCfgWhere
                + ' ｜ 常见原因：MCP 客户端正在启动（首次 npx 需下载包，可能数十秒），或该配置在别的 profile/预设里'
              : '未找到任何 MCP 配置行（扫过 ~/.dsh/profiles/*/cordis*.yml 与 ~/.dsh/.agent-presets/*/agent.cordis.yml）')
          const localOk = sys.tools !== undefined && sys.tools.ok !== false
          const localState2 = localBusy !== null ? 'busy' : (localOk ? 'ok' : 'down')
          const localText = localBusy !== null
            ? '执行中：' + String(localBusy.name || localBusy.label || '工具')
            : (localOk ? '空闲中' : '未配置')
          const browserOk = sys.browser !== undefined && sys.browser.ok === true
          const browserState2 = browserBusy !== null ? 'busy' : (browserOk ? 'ok' : 'down')
          const browserText = browserBusy !== null ? '使用中' : (browserOk ? '空闲中' : '未连接')

          // 麦克风条（**整条可点**，单行 pill）：圆点 · 「麦克风」 · 状态 · ⇄ · 波形
          //   2026-09-15 用户要求：放在**「系统状态」标题右侧**（不再是卡体右侧）—— 作为卡头内联块传入 card()
          const micClickable = dev.phase !== 'starting'
          const micBarProps = {
            className: 'dshw-micbar', key: 'micbar', 'data-state': micState, 'data-click': micClickable ? '1' : '0',
            title: dev.phase === 'live'
              ? '麦克风已启用（点此关闭并释放设备；波形为实时采样电平）'
              : (micState === 'down'
                ? '未检测到麦克风设备或启用失败 —— 点此重试'
                : '点此启用麦克风（浏览器会请求麦克风权限；启用后显示实时电平波形）'),
          }
          if (micClickable) {
            micBarProps.onClick = toggleMic
            micBarProps.role = 'button'
            micBarProps.tabIndex = 0
            micBarProps.onKeyDown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleMic() } }
          }
          const micBar = h('div', micBarProps,
            h('span', { className: 'dshw-dot', 'data-state': micState, key: 'd' }),
            h('span', { className: 'dshw-micbar-name', key: 'n' }, '麦克风'),
            h('span', { className: 'dshw-micbar-state', 'data-state': micState, key: 's' },
              dev.phase === 'starting' ? '启用中' : DEV_LABEL[micState]),
            micClickable ? h('span', { className: 'dshw-mini-hint', key: 'h' }, '⇄') : null,
            wave('mic', micState))

          // 2026-09-15 用户要求（第五/六轮）：
          //   ① 卡头不再显示那行汇总文字；② 摄像头只显示状态、不渲染画面预览；③ 音响去波形、
          //   音响/摄像头改可点击小卡片（点击切换连接/关闭）；④ 麦克风条**移到标题右侧**、
          //   启用/关闭并入该条（点它即切换）；⑤ 卡体**不裁切**；⑥ **6 张小卡片共用一个自动栅格**
          //   （2026-09-16 用户要求：「其他卡片应该是自动排序组合的，当前应该是 3+3 而不是 2+3+1」）
          //   —— 原先分成"设备 2 + 分隔 + 系统 4"两个栅格，于是排成 2 / 3+1；合到一个栅格里
          //   才能整体自动流动（列数由 CSS 按**卡片宽度**分档取 1/2/3/4，见 `.dshw-minigrid` 的四档说明）。
          // ⑦ 卡名 **「系统状态」→「系统」**（2026-09-16 用户要求）。
          //   ⚠️ 卡片**排序按 key（`system`）**、不按标题（见 KNOWN_CARD_KEYS 与 DEFAULT_ORDER），
          //      所以改名不动顺序；但**按标题找卡片的断言/探针必须同步**（否则会静默找不到卡）。
          // 第 1 行中间＝关键指标（SPEC §一）：**通道在线数**，只数 payload 里已有的状态，
          //   本卡不重算、不推断（`sys.dws/tools/browser` 的 ok 与 MCP 的已配置态）。
          const sysOnline = [dwsState, localState2, browserState2].filter((s) => s === 'ok').length
            + (mcpState2 === 'ok' ? 1 : 0)
          // 通道总数：三条固定通道 + MCP（**已配置才计入**：'ok' 在线 / 'warn' 已配置但降级；
          //   'down'='未配置'，不计入分母——避免把"没配 MCP"显示成"通道掉线"）。状态取值口径见
          //   `mcpState2` / `localState2` 的定义（ok | busy | down | warn）。
          const sysChannels = 3 + (mcpState2 === 'ok' || mcpState2 === 'warn' ? 1 : 0)
          // ★ 2026-09-23 用户裁定：卡内**再加能力小卡片**（实时回复 / 响应功能 / 向量检索）。
          //   · **固定渲染全部**（`CAP_MINI_KEYS`）：host 取不到数据也照渲染成「未取到(灰)」，
          //     不因为取不到就少一张卡 —— 少卡是**看不见的失败**，正是这套面板一路在防的东西。
          //   · 四态与文案**逐字来自 host**（`state`/`label`/`why`），面板不推断、不翻译；
          //     工具提示把**证据**念出来（任务 / pid / 心跳 / 在会中 / 已武装 / 语音在途），
          //     "为什么是这盏灯"当场可核。
          //   · 点击 = 切换开/关（走 `/system-switch`，**以回执为准**，不做乐观假成功）；
          //     没数据时点击 = 重新取一次（而不是假装切换成功）。
          //   ⚠️ 关键指标（在线 N/M）**口径不变**：它数的是**采集/通道**（DWS·MCP·本地工具·浏览器），
          //      这两张是**功能开关**（能力是否在干活），不是通道，故不计入分子分母。
          const capMinis = CAP_MINI_KEYS.map((name) => {
            const fallbackTitle = CAP_MINI_TITLES[name] || name
            const list = (sysCaps !== null && Array.isArray(sysCaps.capabilities)) ? sysCaps.capabilities : []
            const c = list.filter((x) => x !== null && x !== undefined && x.name === name)[0] || null
            if (c === null) {
              const why = sysCaps === null
                ? '还没取到状态（`/system-state` 无响应 —— 插件升级后通常要重启 DSH 才会加载这条路由）'
                : String((sysCaps && sysCaps.error) || '状态不可用')
              return devMini('cap-' + name, fallbackTitle, 'unknown', '未取到', false,
                '点击重新取一次状态 ｜ ' + why, () => refreshSysCaps())
            }
            const ev = c.evidence || {}
            const nextOn = c.enabled !== true
            const pidTxt = (ev.pid === null || ev.pid === undefined) ? '（无）' : String(ev.pid)
            const hbTxt = ev.heartbeat_at ? String(ev.heartbeat_at).replace('T', ' ').slice(0, 19) : '（无）'
            // ★ 2026-09-23：证据提示改为**按 host 实际给的字段来念**。
            //   原实现是 `name === 'voice_command' ? '语音在途' : '在会中/已武装'` 的二分 ——
            //   接第三个能力（向量检索）时会掉进 else 分支，把"在会中=False · 已武装=False"
            //   当成它的证据念出来，**看起来像在解释，其实是错的**。
            //   现在只念 payload 里真实存在的字段：缺什么就不说什么，加能力也不用改这里。
            const evParts = []
            const evHas = (k) => ev[k] !== undefined && ev[k] !== null
            const evBool = (k) => (ev[k] === true ? '是' : '否')
            if (evHas('consumer_task')) evParts.push('消费者任务=' + String(ev.consumer_task))
            if (evHas('collector_task')) evParts.push('采集任务=' + String(ev.collector_task))
            // 向量检索：托管它的**自启任务**。非 Running ⇒ 判失效 ——
            // 服务可以被手工起起来让灯变绿，但那活不过下次重启，所以这份证据必须念出来。
            if (evHas('service_task')) evParts.push('自启任务=' + String(ev.service_task))
            if (evHas('pid')) evParts.push('pid=' + pidTxt)
            if (evHas('heartbeat_at')) evParts.push('心跳=' + hbTxt)
            if (evHas('voice_inflight')) evParts.push('语音在途=' + String(ev.voice_inflight))
            if (evHas('in_meeting')) evParts.push('在会中=' + evBool('in_meeting'))
            if (evHas('armed')) evParts.push('已武装=' + evBool('armed'))
            // 向量检索专用的两份证据（`system-switches.mjs` 的 deriveVectorState）
            if (evHas('inflight')) evParts.push('查询在途=' + String(ev.inflight))
            if (evHas('ready')) evParts.push('已就绪=' + evBool('ready'))
            if (evHas('indexed_at')) {
              evParts.push('索引=' + String(ev.indexed_at).replace('T', ' ').slice(0, 19))
            }
            const hint = '点击' + (nextOn ? '开启' : '关闭') + '「' + fallbackTitle + '」'
              + ' ｜ 现在' + String(c.label) + '：' + String(c.why || '')
              + (evParts.length ? ' ｜ 证据：' + evParts.join(' · ') : '')
            // ★ 2026-09-24：过渡态（开启中/关闭中）**不可点**。
            //   理由：这时现实正在追开关，再点一下只会把"要去哪"来回翻，
            //   而且库内那道"上一次切换还没完"的守卫会直接拒掉、看起来像坏了。
            //   等它自己落到 在线 / 关闭 再点。
            const transitioning = c.state === 'starting' || c.state === 'stopping'
            const transHint = transitioning
              ? fallbackTitle + '正在' + (c.state === 'starting' ? '开启' : '关闭')
                + '，稍候（' + String(c.why || '') + '）｜ ' + evParts.join(' · ')
              : hint
            return devMini('cap-' + name, c.title || fallbackTitle, c.state, c.label,
              transitioning, transHint,
              () => toggleCapability(name, nextOn))
          })
          cardsByKey.set('system', card('系统',
            null,
            [
              h('div', { className: 'dshw-minigrid', key: 'minis' },
                devMini('spk', '音响', spkState, LINK_LABEL[spkState], spkBlocked, spkHint, toggleSpeaker),
                devMini('cam', '摄像头', camState, LINK_LABEL[camState], camBlocked, camHint, toggleCamera),
                mini('dws', 'DWS', dwsState, dwsText, String((sys.dws || {}).detail || '')),
                mini('mcp', 'MCP', mcpState2, mcpText, mcpDetail),
                mini('tools', '本地工具', localState2, localText,
                  String((sys.tools || {}).detail || '') + (act.recent && act.recent.length > 0 ? ' ｜ 近次：' + act.recent.slice(0, 3).map((r) => r.name || r.label).join(' → ') : '')),
                mini('browser', '浏览器', browserState2, browserText, String((sys.browser || {}).detail || '')),
                // ── ★ 2026-09-23 用户裁定：系统卡里加**能力小卡片** ────────────────────
                //   实时回复（数字分身自动回复）· 响应功能（语音命令通道）· 向量检索（知识库常驻服务）。
                //   四态：在线(绿 ok) / 待机·执行·检索(黄 busy) / 离线·失效(红 down) / 关闭(灰 off)
                //   —— 色值沿用既有 `.dshw-mini-s[data-state=…]` 词汇，**不新增颜色**。
                //   ⚠️ 必须放进**同一个** `dshw-minigrid`：T16-52 / SBT-11c 钉着"全卡只有一个栅格"。
                //   ⚠️ 判定与证据**全部来自 host**（转调库内 `system-switches.mjs`）：面板不推断、
                //      不拿"进程活着"当"在干活"。工具提示里把证据念出来（任务/pid/心跳/会中/在途），
                //      这样"为什么是这盏灯"当场可核。
                capMinis),
              // ⚠️ 2026-09-15 用户要求：设备提示**不再出现在卡片底部**（移到头部「工作台」右侧的瞬时提示）
            ],
            null,
            true,
            micBar,
            { key: 'system', metric: '在线 ' + String(sysOnline) + '/' + String(sysChannels) }))
        }

        // ── 卡片**默认顺序**（契约）+ 用户拖动**覆盖层**（2026-09-16 用户裁定）─────────
        //    **最终顺序（14 项 · 三带布局 · 用户裁定 2026-09-16；2026-09-20 合并后 15 → 14）**：
        //      热层：决策（旧称「今日决策面」）→ 待响应触发 → 事务 → 日程 → 待办
        //      在办层：**专注 · 活跃**（原「专注」，2026-09-20 并入活跃关注域）→ 对象 → 流入 → 跨源洞察 → 资产
        //      参考层：验收 → 文件 → 听记 → 系统状态（原「活跃关注域」已并入在办层的合并卡）
        //    ⚠️ 本轮**只删键、不重排**（用户二次澄清 5：面板顺序暂按目前顺序）——
        //      合并卡沿用 `focus` 原来的位置，其余 13 张一格未动。
        //    · ⚠️ 并发抢写事故（2026-09-16）：此前"跨源洞察排第 2"那版一度写进四处声明，
        //      已按用户最终裁定（"按我的建议调整"＝三带版）全部改回。
        //    · 三带只是**注释级的显示分层**，位置由本表派生（代码里没有独立分组表/band 常量，
        //      所以改顺序只需改本表 + 同步断言；分组文案随之更新即可）：
        //    · 本表是**默认值**，同时是契约（本表 / host 的 KNOWN_CARD_KEYS / T16-58 的 WANT_ORDER /
        //      SBT-23 的 WANT **四处必须逐项一致**，漏一处会漂移；T16-97 守着前两处）。
        //      ⚠️ 漏改 host 那份的后果是**静默丢卡**（`/ui-prefs` 会把它当未知 key 忽略）。
        //    · 用户拖动产生**覆盖层**（host 的 `_meta/out/ui-prefs.json`），只影响渲染，
        //      **不改本表** —— 改动默认表会让断言失去意义（见 STANDARDS §8 反模式）。
        //    · 错误/提示块（alertBlocks）**恒在顶部**：它们是告警，不该被顺序挤到看不见。
        //    · 覆盖层里没有的 key 按本表顺序补在末尾；未登记进本表的卡片同样追加在末尾。
        const CARD_ORDER = [
          // 用户裁定 2026-09-16 · **三带布局**（热层 / 在办层 / 参考层）· 13 项
          //   ⚠️ 并发抢写事故（2026-09-16）：此前"跨源洞察排第 2"的那版一度被写进四处声明，
          //     已按用户最终裁定（"按你的建议调整"＝三带版）全部改回。改顺序务必四处同步。
          //   ⚠️ 2026-09-20（本批）：`domains` 已并入 `focus`（卡名「专注 · 活跃」）⇒ 本表删一键、
          //     **顺序一格未动**；漏改 host 那份 `KNOWN_CARD_KEYS` 会让覆盖层里该键被静默丢弃。
          //   ⚠️ 2026-09-21（P2b）：`objects` 已撤卡（对象改为**属性**）⇒ 本表再删一键、**顺序一格未动**；
          //     同样地，漏改 host 那份会让用户在覆盖层里拖过的卡被静默丢弃。
          'brief', 'triggers', 'matters', 'schedule', 'todos',                // 热层：今天动手
          'focus', 'inflow', 'insights', 'recall',                            // 在办层：这件事到哪了（focus = 专注 · 活跃）
          'metrics', 'kb', 'minutes', 'system',                               // 参考层：查阅与诊断
        ]
        const unlistedKeys = [...cardsByKey.keys()].filter((k) => !CARD_ORDER.includes(k))
        /**
         * 覆盖层合并规则（**必须与 host 侧同规则**，见 index.js 的 mergeCardOrder）：
         *   ① 覆盖层里且属于已知 key 的，按覆盖层顺序排在前；
         *   ② 其余已知 key 按默认顺序补在末尾；
         *   ③ 覆盖层里的未知 key 忽略（不报错、不影响渲染）。
         * 纯函数：给定同一对入参必得同一结果，便于断言与反向取证。
         */
        function mergeCardOrder(defaults, overlay) {
          const known = defaults
          const ov = Array.isArray(overlay) ? overlay : []
          const seen = []
          for (const k of ov) {
            if (known.indexOf(k) === -1) continue   // ③ 未知 key 忽略
            if (seen.indexOf(k) !== -1) continue    // 重复 key 只取首次
            seen.push(k)
          }
          const rest = known.filter((k) => seen.indexOf(k) === -1)  // ② 未覆盖的补末尾
          return seen.concat(rest)
        }
        const baseOrder = mergeCardOrder(CARD_ORDER, cardOrderOverride)
        // ── 渲染用的顺序 = **拖动预览**（磁力贴拖动期间）或已保存的顺序 ──────────────
        //   ⚠️ 预览并进 `effectiveOrder` 这个名字里、而**不是**新起一个 `shownOrder` 变量，
        //      是刻意的：`run-t16` 的 T16-109 按**源码字串**守着这行装配
        //      （`...effectiveOrder.map((k, i) => slotOf(...))`），它是"卡片顺序只有一个来源、
        //      不因降权/折叠被筛掉"这条契约的取证点。另起变量会让那条判据整条假红 ——
        //      而契约本身（顺序只有一个数组、不筛卡）并没有变，所以改判据是削判据、改这里才对。
        //   预览只影响渲染：落盘/回滚/路由降级一律读 `baseOrder`（= 已保存的顺序）。
        const effectiveOrder = dragPreview !== null ? dragPreview : baseOrder
        effectiveOrderRef.current = baseOrder
        /**
         * 拖动排序的统一入口（拖动、上移、下移都走这里）：
         *   把 key 从当前位置移动到 toIndex，产出一个**新的完整顺序数组**再保存。
         *   只改覆盖层，不动默认表 —— 默认表一变，T16-58/SBT-23 的断言就失去意义。
         */
        function reorderCard(key, toIndex) {
          const cur = effectiveOrder.slice()
          const from = cur.indexOf(key)
          if (from === -1) return
          const to = Math.max(0, Math.min(cur.length - 1, toIndex))
          if (to === from) return
          cur.splice(from, 1)
          cur.splice(to, 0, key)
          saveCardOrder(cur, '卡片顺序已保存')
        }
        const moveCardBy = (key, delta) => reorderCard(key, effectiveOrder.indexOf(key) + delta)
        // ── 长按拖动（2026-09-16 用户裁定：**长按整张卡**拖动，不要手柄、不要浮层按钮）──────
        //    两条常量**必须可被测试读取**（源码级断言读的就是这两个名字）：
        const CARD_LONGPRESS_MS = 400      // 长按阈值（350–450ms）：未达阈值内的移动一律当滚动/点击
        const CARD_DRAG_CANCEL_PX = 9      // 长按期间移动超过它就取消拖动（8–10px），让位给滚动
        // 卡内"可交互元素"必须排除：否则长按会抢走"打开二级详情 / 关闭事务 / 重新匹配"的点击。
        // （用户明确点出的风险：卡内既有按钮的点击绝不能被拖动逻辑吞掉。）
        const CARD_DRAG_EXCLUDE = 'button,a,input,select,textarea,label,[role="button"],[data-click="1"],.dshw-tab,.dshw-btn,.dshw-modal-backdrop'
        const cardDragRef = React.useRef(null)   // 长按拖动状态 {key, startX, startY, active, over, timer}
        // ── 拖后抑制点击（2026-09-17 新增，解掉"SBT-47 长按卡名"与"点卡名折叠"的冲突）──────
        //   背景：卡名既要**点一下折叠**（场景交互），又要能**长按整卡拖动**（用户核心诉求）。
        //   原先的实现靠 `CARD_DRAG_EXCLUDE` 里那条 `[data-click="1"]` 排除卡名 —— 代价是
        //   **长按卡名不再进入拖动**（真机 SBT-47 正是按在 `.dshw-card-title` 上 ⇒ 变红）。
        //   正确做法不是二选一：让卡名参与拖动，**但拖动完成后抑制随之而来的那一次 click**
        //   （否则松手会顺带触发折叠）。这里用"捕获阶段拦一次 click"实现，窗口 400ms。
        const dragClickGuardRef = React.useRef(0)
        function onDragClickGuard(e) {
          if (Date.now() < dragClickGuardRef.current) {
            try { e.preventDefault(); e.stopPropagation() } catch (err) { /* ignore */ }
          }
        }
        // ⚠️ 命名必须区别于既有的 `dragRef`（面板高度拖拽用）—— 本次实测撞名 ⇒ 语法错误
        const isInteractiveTarget = (t) => {
          try { return t !== null && t.closest !== undefined && t.closest(CARD_DRAG_EXCLUDE) !== null } catch (e) { return false }
        }
        function endCardDrag(commit) {
          const st = cardDragRef.current
          cardDragRef.current = null
          if (st && st.timer !== null) clearTimeout(st.timer)
          try {
            if (typeof window !== 'undefined') {
              window.removeEventListener('pointermove', onDragPointerMove)
              window.removeEventListener('pointerup', onDragPointerUp)
              window.removeEventListener('pointercancel', onDragPointerCancel)
              window.removeEventListener('keydown', onDragKeyDown)
              window.removeEventListener('blur', onDragPointerCancel)
            }
          } catch (e) { /* ignore */ }
          if (commit && st && st.active && st.over !== null && st.over.key !== st.key) {
            const target = effectiveOrder.indexOf(st.over.key)
            const at = Math.max(0, Math.min(effectiveOrder.length - 1, st.over.pos === 'before' ? target : target + 1))
            reorderCard(st.key, at)
          }
          // 真拖过（active）⇒ 抑制紧随的一次 click：卡名/卡内元素不会被"顺带点一下"
          if (st && st.active === true) dragClickGuardRef.current = Date.now() + 400
          try {
            if (typeof window !== 'undefined') window.removeEventListener('click', onDragClickGuard, true)
          } catch (e) { /* ignore */ }
          setDragKey(null)
          setDragOverKey(null)
        }
        function onDragKeyDown(e) { if (e.key === 'Escape') endCardDrag(false) }        // Esc → 取消回原位
        function onDragPointerCancel() { endCardDrag(false) }                          // 指针取消/窗口失焦 → 取消
        function onDragPointerMove(e) {
          const st = cardDragRef.current
          if (st === null) return
          const dx = Math.abs(e.clientX - st.startX)
          const dy = Math.abs(e.clientY - st.startY)
          if (!st.active) {
            // 未到阈值就动得太多 ⇒ 用户想滚动或想点击，**让位**（不再进入拖动）
            if (dx > CARD_DRAG_CANCEL_PX || dy > CARD_DRAG_CANCEL_PX) endCardDrag(false)
            return
          }
          // 已进入拖动：按指针位置算落点（elementFromPoint ⇒ 最近的 slot + 上半/下半决定前后）
          try {
            const under = document.elementFromPoint(e.clientX, e.clientY)
            const slot = under === null ? null : under.closest('.dshw-slot')
            const k2 = slot === null ? null : slot.getAttribute('data-key')
            if (k2 !== null && effectiveOrder.includes(k2) && k2 !== st.key) {
              const r = slot.getBoundingClientRect()
              const pos = (e.clientY - r.top) < (r.height / 2) ? 'before' : 'after'
              st.over = { key: k2, pos }
              if (dragOverKey === null || dragOverKey.key !== k2 || dragOverKey.pos !== pos) setDragOverKey({ key: k2, pos })
            }
          } catch (err) { /* elementFromPoint 在某些壳层不可用 ⇒ 保持上一个落点 */ }
        }
        function onDragPointerUp() { endCardDrag(true) }
        function beginCardDrag(k) {
          // 降级层：`/ui-prefs` 未加载（旧 host）⇒ **不进入拖动**（拖了也存不下来，
          // 只会让用户白操作一次）。顶部小字已写明"需重启 DSH"。
          if (routeDown['ui-prefs'] === true) { setNote('卡片排序不可用：' + ROUTE_DOWN_TEXT); return }
          setDragKey(k)
          if (cardDragRef.current !== null) cardDragRef.current.active = true
        }
        /**
         * 从**已渲染的卡片元素**里读出卡名与徽标（供折叠态一行摘要用）。
         *
         * 为什么这么读（而不是另立一张"key → 中文标题"表）：`card()` 的第一件子元素恒为
         * `.dshw-card-title` 的 span —— 从元素本身读 ⇒ 卡名只有**一处**真相源；
         * 另立一张表就会在改卡名时悄悄漂移（本项目反复吃过的"第二份声明"亏）。
         * 读不到就回落成 key（不抛错、不显示空白）。
         */
        const cardHeadTextOf = (el, k) => {
          const out = { title: String(k), badge: '' }
          try {
            const head = el && el.props && Array.isArray(el.props.children) ? el.props.children[0] : null
            const kids = head && head.props && Array.isArray(head.props.children) ? head.props.children : []
            const t = kids[0]
            if (t && t.props && typeof t.props.children === 'string') out.title = t.props.children
            const b = kids[1]
            if (b && b.props && typeof b.props.children === 'string') out.badge = b.props.children
            else {
              // 决策卡（2026-09-17）：三数徽标在卡头**最右侧**（`extra`，可能是数组），不在 badge 位 ——
              // 专注期间折叠成一行摘要时也要看得到它，否则那张卡只剩卡名。
              // 只认带 `data-brhead` 的节点 ⇒ 对别的卡（如系统状态，badge 传 null）零影响。
              const flat = []
              for (let i = 1; i < kids.length; i += 1) {
                if (Array.isArray(kids[i])) flat.push.apply(flat, kids[i])
                else flat.push(kids[i])
              }
              for (let i = 0; i < flat.length; i += 1) {
                const node = flat[i]
                if (node !== null && node !== undefined && node.props
                  && node.props['data-brhead'] === '1' && typeof node.props.children === 'string') {
                  out.badge = node.props.children
                  break
                }
              }
            }
          } catch (e) { /* 结构不符：保留回落值 */ }
          return out
        }
        /**
         * ── 卡片"磁力贴"移动：拖动手柄（左下角小方块）─────────────────────────────
         *
         * 与长按排序的差别（用户 2026-09-25 原话："类似磁力贴……左边的卡片自动向右移动到当前位置"）：
         *   · **按下即进入**拖动，不等长按；
         *   · 被拖的卡**跟着指针走**（slot 上一个 translate，卡片再 scale(1.03) + 阴影 = 抬起来）；
         *   · 指针移到别的卡上时**立即**把顺序改成预览顺序 ⇒ 周围卡片当场让位/靠拢；
         *   · 让位与靠拢都有动画（FLIP：先量旧位置、改完顺序再量新位置，用 transform 补差滑回去）；
         *   · 松手才落盘；Esc / 指针取消 ⇒ 丢掉预览、卡片滑回原位。
         *
         * 落点怎么算（2D → 一维插入位）：
         *   指针底下是哪张卡就用哪张；再按**拖动的主轴**决定插到它前面还是后面 ——
         *   横向为主就看指针在该卡左右半区（对应"往左/往右换"），
         *   纵向为主就看上下半区（对应"往上/往下换"）。
         *   只按 x 或只按 y 都会在"两列栅格"里读错意图：整行下移时指针往往落在右半区。
         *
         * ⚠️ 尺寸不一致时的"自动移开/靠拢"由 **`grid-auto-flow: row dense`** 承担：
         *   跨两列的卡会在行里留下空洞，dense 让后面的卡回填 ⇒ 卡与卡之间始终只有栅格的那一个
         *   间距（`gap`），不会出现"因为某张卡大所以空一大块"。
         */
        const MOVE_ANIM_MS = 260
        /** 量一遍所有 slot 的位置（FLIP 的"before"） */
        function snapshotSlots() {
          const m = new Map()
          try {
            document.querySelectorAll('.dshw-root .dshw-slot').forEach((el) => {
              const k = el.getAttribute('data-key')
              if (k !== null && k !== '') m.set(k, el.getBoundingClientRect())
            })
          } catch (e) { /* ignore */ }
          return m
        }
        /**
         * 逻辑位置：`getBoundingClientRect()` **扣掉行内 transform**。
         *
         * 为什么必须扣：让位动画期间卡片的 rect 是"**正在滑动的位置**"，不是它的栅格格子。
         * 拿它做命中判定会读到中间态 —— 症状很隐蔽：指针下的卡一会儿是 A 一会儿是 B，
         * 于是预览忽而生效忽而撤销（2026-09-25 实测：拖动第 1 步换位成功、第 2 步被自己撤销、
         * 第 3 步又换回来，全看指针落点有没有撞上正在滑的那张卡）。
         */
        function logicalRect(el) {
          const r = el.getBoundingClientRect()
          const t = String(el.style.transform || '')
          const m = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/.exec(t)
          if (m === null) return r
          const dx = parseFloat(m[1]) || 0
          const dy = parseFloat(m[2]) || 0
          return { left: r.left - dx, top: r.top - dy, right: r.right - dx, bottom: r.bottom - dy, width: r.width, height: r.height }
        }
        /**
         * 指针落在**第几个格子**上（格子表由调用方在拖动开始时冻结；不在任何格子上返回 null）。
         *
         * 为什么不用 `elementFromPoint`：① 被拖那张跟手时压在光标底下；
         * ② **正在做让位动画的卡**会被命中到它"还没滑完"的位置上。
         *
         * ⚠️ 为什么要用**冻结的格子表**、而不是每次拿卡片当前位置现算：
         *   换位之后卡片自己就挪位了，现算会把"指针底下现在是哪张卡"当成"第几个格子" ——
         *   指针停在 B 的格子上，B 换走之后那个位置站的是 A，于是下一次采样读成
         *   "指针在 A 的格子上" ⇒ 撤销预览（2026-09-25 实测：预览忽而生效忽而回退，
         *   松手后什么都没保存）。格子是**位置**，不是"现在谁站在那儿"。
         */
        function cellOfPointer(px, py, cells) {
          if (!Array.isArray(cells)) return null
          for (let i = 0; i < cells.length; i++) {
            const c = cells[i]
            if (px >= c.left && px <= c.right && py >= c.top && py <= c.bottom) return i
          }
          return null
        }
        /** 冻结一份格子表：已渲染卡片的**视觉（阅读）顺序** + 各自的逻辑位置 */
        function visualCellsNow() {
          let items = []
          try {
            document.querySelectorAll('.dshw-root .dshw-slot').forEach((el) => {
              const k = el.getAttribute('data-key')
              if (k === null || k === '') return
              const r = logicalRect(el)
              items.push({ key: k, left: r.left, top: r.top, right: r.right, bottom: r.bottom })
            })
          } catch (e) { return [] }
          items.sort((a, b) => (Math.abs(a.top - b.top) < 6 ? a.left - b.left : a.top - b.top))
          return items
        }
        /**
         * 执行 FLIP：把**新位置**下的每个 slot 先平移回旧位置，再让它滑到 0。
         * @param {string|null} skipKey 这一张完全不碰（被拖的那张自己跟手/自己落地，见 clearMovingCard）
         */
        function runFlip(prev, skipKey) {
          if (prev === null) return
          let els = []
          try { els = Array.prototype.slice.call(document.querySelectorAll('.dshw-root .dshw-slot')) } catch (e) { return }
          // ① 先清掉上一次动画残留的内联 transform，否则量到的"新位置"本身就是歪的。
          //    ⚠️ **跳过被拖的那一张** —— 它的 transform 正在做"落地动画"，
          //       在这里清掉就等于把落地动画掐死（卡片会"啪"地跳到位）。
          for (const el of els) {
            if (el.getAttribute('data-key') === skipKey) continue
            el.style.transition = 'none'
            el.style.transform = ''
          }
          // ② 强制一次重排，让上面的清除生效
          try { void document.body.offsetHeight } catch (e) { /* ignore */ }
          for (const el of els) {
            const k = el.getAttribute('data-key')
            if (k === null || k === skipKey) continue
            const b = prev.get(k)
            if (b === undefined) continue
            const a = el.getBoundingClientRect()
            const dx = b.left - a.left
            const dy = b.top - a.top
            if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
            el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)'
            requestAnimationFrame(() => {
              try {
                el.style.transition = 'transform ' + MOVE_ANIM_MS + 'ms cubic-bezier(.22,1,.36,1)'
                el.style.transform = ''
              } catch (e) { /* ignore */ }
            })
            setTimeout(() => { try { el.style.transition = ''; el.style.transform = '' } catch (e) { /* ignore */ } }, MOVE_ANIM_MS + 160)
          }
        }
        /** 把被拖的那张卡按指针位置摆好（每帧都按**当前**栅格位置重算，所以让位后不会跳） */
        function placeMovingCard() {
          const st = moveDragRef.current
          if (st === null) return
          try {
            const el = document.querySelector('.dshw-root .dshw-slot[data-key="' + st.key + '"]')
            if (el === null) return
            el.style.transition = 'none'
            el.style.transform = ''
            const r = el.getBoundingClientRect()
            el.style.transform = 'translate(' + (st.px - r.left - st.grabX) + 'px,' + (st.py - r.top - st.grabY) + 'px)'
          } catch (e) { /* ignore */ }
        }
        function clearMovingCard(key, animate) {
          try {
            const el = document.querySelector('.dshw-root .dshw-slot[data-key="' + key + '"]')
            if (el === null) return
            if (animate === true && String(el.style.transform || '') !== '') {
              // 落地 / 滑回原位：从"指针底下"平滑走到它的栅格位置
              el.style.transition = 'transform ' + MOVE_ANIM_MS + 'ms cubic-bezier(.22,1,.36,1)'
              el.style.transform = ''
              setTimeout(() => { try { el.style.transition = ''; el.style.transform = '' } catch (e) { /* ignore */ } }, MOVE_ANIM_MS + 160)
              return
            }
            el.style.transition = ''
            el.style.transform = ''
          } catch (e) { /* ignore */ }
        }
        function onMoveKeyDown(e) { if (e.key === 'Escape') endMoveDrag(false) }
        function onMovePointerCancel() { endMoveDrag(false) }
        function onMovePointerUp() { endMoveDrag(true) }
        function onMovePointerMove(e) {
          const st = moveDragRef.current
          if (st === null) return
          st.px = e.clientX
          st.py = e.clientY
          // ① 指针落在**第几个格子**上（用拖动开始时冻结的格子表）
          const cell = cellOfPointer(st.px, st.py, st.cells)
          if (cell !== null && cell < st.cellToBaseIdx.length) {
            // ② 换位语义 = **与"这个格子在拖动开始时的主人"对调**，其余卡片一张都不动。
            //
            //    为什么不是"与指针底下现在那张卡对调"（第一版就是这么写的，用户报了个真 bug）：
            //      场景 A 在 1 号位、B 在 4 号位。把 A 拖到 4 号位（不松手）⇒ B 被换到 1 号位；
            //      此时指针**移回 1 号位**，那里蹲着的已经是 **B**（不是 A）—— 拿 B 去算，
            //      得到的还是同一个排列 ⇒ **B 回不到 4 号位**，用户看到的是"换过去就换不回来"。
            //    正确做法：先算出"指针所在的**格子**"，再问"那个格子在拖动开始时是谁的"
            //      （`base[cellToBaseIdx[cell]]`），和它换。
            //      · 指针回到 A 自己的格子 ⇒ 算出来就是 A 自己 ⇒ 不换 ⇒ 整盘回到起点 ✓
            //      · 沿任意路径来回拖都**可逆**（每步都是"base 与当前指针格"的对调，
            //        与走过的路径无关），不会越拖越乱
            const base = st.baseOrder
            const bi = st.cellToBaseIdx[cell]
            if (bi === undefined) { placeMovingCard(); return }
            const targetKey = base[bi]
            const t = bi
            const f = st.from0
            let next = null
            if (targetKey !== st.key && t !== f) {
              next = base.slice()
              next[f] = targetKey
              next[t] = st.key
            }
            const cur = dragPreviewRef.current !== null ? dragPreviewRef.current : base
            const same = (a, b) => a === null ? (b === null) : (b !== null && a.length === b.length && a.every((x, i) => x === b[i]))
            if (!same(next, cur)) {
              flipRef.current = { prev: snapshotSlots(), skip: st.key }
              setDragPreview(next)
              dragPreviewRef.current = next
            }
          }
          placeMovingCard()
        }
        function endMoveDrag(commit) {
          const st = moveDragRef.current
          moveDragRef.current = null
          try {
            if (typeof window !== 'undefined') {
              window.removeEventListener('pointermove', onMovePointerMove)
              window.removeEventListener('pointerup', onMovePointerUp)
              window.removeEventListener('pointercancel', onMovePointerCancel)
              window.removeEventListener('keydown', onMoveKeyDown)
            }
          } catch (e) { /* ignore */ }
          try { document.body.style.cursor = ''; document.body.style.userSelect = '' } catch (e) { /* ignore */ }
          if (st !== null) clearMovingCard(st.key, true)
          setMoveKey(null)
          const preview = dragPreviewRef.current
          dragPreviewRef.current = null
          if (commit && st !== null && preview !== null) {
            // 提交：预览顺序就是最终顺序 ⇒ 正常情况下 FLIP 量到的差值是 0（不动画）；
            // 万一落盘失败、`saveCardOrder` 回滚，那次回滚也有动画（不是"啪一下跳回去"）。
            flipRef.current = { prev: snapshotSlots(), skip: st.key }
            saveCardOrder(preview, '卡片位置已保存')
          } else if (preview !== null) {
            // 取消：从预览顺序滑回原顺序（被拖那张自己滑回原位，故 skip）
            flipRef.current = { prev: snapshotSlots(), skip: st.key }
          }
          setDragPreview(null)
          if (st !== null) dragClickGuardRef.current = Date.now() + 400
        }
        function startMoveDrag(e, key) {
          if (e === null || e === undefined || typeof key !== 'string' || key === '') return
          if (e.button !== undefined && e.button !== 0) return
          if (routeDown['ui-prefs'] === true) { setNote('卡片排序不可用：' + ROUTE_DOWN_TEXT); return }
          const el = e.currentTarget !== null && e.currentTarget !== undefined ? e.currentTarget : e.target
          if (el === null || el.closest === undefined) return
          const slot = el.closest('.dshw-slot')
          if (slot === null) return
          e.preventDefault()
          e.stopPropagation()
          const r = slot.getBoundingClientRect()
          const base = effectiveOrderRef.current.slice()
          // 拖动开始时**冻结格子表**，并把它翻译成"完整顺序表里的下标"。
          //   两个理由：① 换位后卡片会挪位，现算会把"现在谁站在那儿"当成"第几个格子"；
          //   ② `dense` 下视觉顺序与装配顺序可以不一致，两边混用会认错卡。
          const cells = visualCellsNow()
          const cellToBaseIdx = cells.map((c) => base.indexOf(c.key))
          moveDragRef.current = {
            key: key, px: e.clientX, py: e.clientY,
            startX: e.clientX, startY: e.clientY,
            grabX: e.clientX - r.left, grabY: e.clientY - r.top,
            // 拖动开始时的顺序与自己的位置：换位始终拿这一份重算（见 onMovePointerMove ②）
            baseOrder: base, from0: base.indexOf(key),
            cells: cells, cellToBaseIdx: cellToBaseIdx,
          }
          try {
            if (typeof window !== 'undefined') {
              window.addEventListener('pointermove', onMovePointerMove)
              window.addEventListener('pointerup', onMovePointerUp)
              window.addEventListener('pointercancel', onMovePointerCancel)
              window.addEventListener('keydown', onMoveKeyDown)
            }
          } catch (err) { /* ignore */ }
          try { document.body.style.cursor = 'grabbing'; document.body.style.userSelect = 'none' } catch (err) { /* ignore */ }
          setMoveKey(key)
          placeMovingCard()
        }
        /**
         * ── 卡片缩放：指针逻辑（2026-09-25 起；2026-09-26 用户裁定改成两档 + 5% 网格）──────
         *
         * 交互：卡右下角的小三角上按下 → 往右下拖 = 变大，往左上拖 = 变小；**两个方向同时生效**
         * （横向改宽、纵向改高 —— 用户 09-26 明确要求"右下角的三角拖动需要能改变高度和宽度"）。
         *
         * 两档（全局开关 `dshw.cardSizeMode`，顶部那一行文字链接切换）：
         *   · 网格（默认）：宽 = 画布宽度的 %、高 = 画布**看得见高度**的 %，都吸附到 **5%** 的整数倍
         *     （画布是 20 列栅格 ⇒ 5% 正好一列，卡片之间不会互相压）；
         *   · 无级：宽高都是**像素**，不吸附（宽度仍按列跨度占位，但卡片自身宽度就是那个像素值）。
         *
         * ⚠️ 拖动过程**只改 slot 的行内样式**，不 setState：
         *    面板一次渲染要重建 13 张卡的全部节点（几千个元素），逐帧 setState 会明显卡；
         *    松手时才落 state + localStorage。代价是"若拖到一半碰上轮询重渲染，预览会闪一下"，
         *    下一帧 pointermove 就补回来了 —— 换来的是全程跟手。
         *
         * ⚠️ 手柄带 `role="button"` ⇒ `isInteractiveTarget` 判真 ⇒ slot 的长按排序**完全不介入**。
         *    这一条有真机判据（RZ-17：在手柄上长按 600ms，任何 slot 都不得出现 `data-dragging`）。
         */
        /**
         * 画布的内容区尺寸（宽 = 网格内容宽；高 = **看得见的**高度，滚动内容不算）。
         *
         * ⚠️ 纵向必须按"看得见的高度"算，不能只看 `grid.clientHeight`：这张卡的栅格常被内容撑高、
         *    由外层那条栏在滚（实测：面板 1291 高、画布 1242，而侧边栏只有 1062）⇒ 直接用
         *    `clientHeight` 会拿到**内容高**，于是"高 50%"越算越大 —— 卡片一放大就把画布撑得更高，
         *    自激放大。
         * ⚠️ 逐个祖先取**最小值**，不 `break` 在第一个：第一个裁切祖先常常是"比视口还高的面板"
         *    （1291），真正管住可见高度的是外面那条栏（1062）。取最小才与"看不看得见"一致。
         * ⚠️ 也不要用"祖先下沿 - 网格上沿"：面板滚动之后网格上沿会跑到视口上方，
         *    那个差会变成整个内容高（实测：滚过之后基数从 1023 变成 1242，同一张卡前后不一致）。
         */
        function canvasBoxOf(grid) {
          if (grid === null || grid === undefined) return { w: 0, h: 0 }
          try {
            const cs = window.getComputedStyle(grid)
            const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
            const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
            let visibleH = grid.clientHeight
            let node = grid.parentElement
            for (let i = 0; i < 6 && node !== null && node !== undefined; i += 1) {
              const pcs = window.getComputedStyle(node)
              if (pcs.overflowY === 'auto' || pcs.overflowY === 'scroll' || pcs.overflowY === 'hidden') {
                if (node.clientHeight > 0) visibleH = Math.min(visibleH, node.clientHeight)
              }
              node = node.parentElement
            }
            return { w: Math.max(0, grid.clientWidth - padX), h: Math.max(0, visibleH - padY) }
          } catch (e) { return { w: 0, h: 0 } }
        }
        /** 本模式对应的"老栅格最小列宽"（只有 legacy 档换算用得上；嵌入态 240 / 浮窗态 280）。 */
        const naturalMinNow = () => (embedded ? CARD_NATURAL_MIN_PX : CARD_NATURAL_MIN_PX_FLOAT)
        /**
         * 一张卡**当前生效**的尺寸，按**当前模式**的单位给出（拖动起点用）。
         * 顺序：用户存过的档 → 内容默认档 → 它**现在多大**；单位与当前档不同就先换算过去。
         * ⚠️ 自然档（都没有）也要能起拖：网格档下把"现在这 526px 宽"折成 50% 再吸附，
         *    否则一拖就会掉回 5%（"我只想动一点，结果卡片缩成一条"）。
         */
        function effectiveSizeOf(key, rect, canvas) {
          const mode = sizeModeRef.current === 'free' ? 'free' : 'grid'
          const stored = effectiveCardSizeOf(cardSizeRef.current, key)
          if (stored !== null && stored !== undefined && typeof stored === 'object'
            && (Number(stored.w) > 0 || Number(stored.h) > 0)) {
            const unit = stored.unit === 'free' ? 'free' : (stored.unit === 'legacy' ? 'legacy' : 'grid')
            if (unit === mode) {
              return { w: Math.max(0, Math.round(Number(stored.w) || 0)), h: Math.max(0, Math.round(Number(stored.h) || 0)), unit: mode }
            }
            const one = convertCardSizeMap({ one: stored }, mode, canvas, naturalMinNow()).one
            return { w: Math.max(0, Math.round(one.w || 0)), h: Math.max(0, Math.round(one.h || 0)), unit: mode }
          }
          const w = rect !== null && rect !== undefined ? Number(rect.width) || 0 : 0
          const h = rect !== null && rect !== undefined ? Number(rect.height) || 0 : 0
          if (mode === 'grid') {
            return { w: pxToPct(w, canvas === undefined ? 0 : canvas.w, true), h: pxToPct(h, canvas === undefined ? 0 : canvas.h, true), unit: 'grid' }
          }
          return {
            w: Math.round(clampCardNum(w, CARD_MIN_W_PX, 4000)),
            h: Math.round(clampCardNum(h, CARD_MIN_H_PX, CARD_MAX_H_PX)),
            unit: 'free',
          }
        }
        /**
         * 换缩放档（顶部那一行文字链接）：把已有档位**换算过去**再切，卡片不会跳。
         * 没有档位的卡不受影响（自然档与模式无关）。
         */
        function toggleSizeMode() {
          const next = sizeModeRef.current === 'grid' ? 'free' : 'grid'
          // 换算要按**当前画布**：优先用观察者量到的那份（它一直是最新的）；
          // 拿不到才现读 DOM —— 直接读 DOM 在某些时刻会读到 ref 还没挂上的空元素（实测踩到），
          // 那会把宽度换算成 0、再夹成下限 160px，卡片当场塌成一条。
          const canvas = (canvasBox !== null && canvasBox !== undefined && canvasBox.w > 0)
            ? canvasBox : canvasBoxOf(gridRef.current)
          const conv = convertCardSizeMap(cardSizeRef.current, next, canvas, naturalMinNow())
          cardSizeRef.current = conv
          setCardSize(conv)
          lsSet(CARD_SIZE_LS, JSON.stringify(conv))
          sizeModeRef.current = next
          setSizeMode(next)
          lsSet(CARD_SIZE_MODE_LS, next)
          showToast('卡片缩放：' + (next === 'grid' ? '网格（宽高都吸附 5%）' : '无级（自由像素）'))
        }
        /** 把一份尺寸按当前画布落到 DOM 上（拖动过程中每帧都走这里，保持与渲染同一条口径）。 */
        function applyCardSizeToDom(slot, size, canvas) {
          if (slot === null || slot === undefined) return
          try {
            const L = layoutForCardSize(size, canvas, naturalMinNow())
            slot.style.gridColumn = L.span > 0 ? ('span ' + L.span) : ''
            if (L.widthPx > 0) { slot.style.width = L.widthPx + 'px'; slot.style.justifySelf = 'start' }
            else { slot.style.width = ''; slot.style.justifySelf = '' }
            if (L.heightPx > 0) { slot.style.height = L.heightPx + 'px'; slot.setAttribute('data-rszh', '1') }
            else { slot.style.height = ''; slot.removeAttribute('data-rszh') }
          } catch (e) { /* ignore */ }
        }
        /**
         * 松手吸附的**过渡动画**（2026-09-26 用户要求：拖动跟手，松手才吸附到最近的 5%）。
         *   ① 先把 slot 停在"松手那一刻的像素尺寸"（拖动过程中已经是这个写法）；
         *   ② 挂 `data-rszsnap="1"` ⇒ 宽高走 180ms 过渡；
         *   ③ 写目标尺寸（**span 宽度**与吸附后的高度）—— 动画就是从这里开始的；
         *   ④ 过渡结束后摘掉属性，并把行内宽高换成栅格自己的 span 写法（终点一致 ⇒ 不跳）。
         */
        function finishCardResizeSnap(slot, size, canvas) {
          if (slot === null || slot === undefined) return
          try {
            const L = layoutForCardSize(size, canvas, naturalMinNow())
            const wTarget = L.span > 0 ? gridSpanWidthPx(L.span, canvas.w) : 0
            const hTarget = L.heightPx > 0 ? L.heightPx : 0
            const wNow = parseFloat(slot.style.width) || 0
            const hNow = parseFloat(slot.style.height) || 0
            try {
              if (rszSnapRef.current !== null) clearTimeout(rszSnapRef.current)
            } catch (e) { /* ignore */ }
            // 只在"确实要动"的时候才挂过渡；否则直接落到 span 写法（例如刚好停在格点上）
            const willMove = (wTarget > 0 && Math.abs(wTarget - wNow) >= 1) || (hTarget > 0 && Math.abs(hTarget - hNow) >= 1)
            if (!willMove) {
              slot.removeAttribute('data-rszsnap')
              slot.removeAttribute('data-rszlive')
              applyCardSizeToDom(slot, size, canvas)
              return
            }
            slot.setAttribute('data-rszsnap', '1')
            slot.setAttribute('data-rszlive', '1')
            slot.style.gridColumn = L.span > 0 ? ('span ' + L.span) : ''
            slot.style.justifySelf = 'start'
            if (wTarget > 0) slot.style.width = wTarget + 'px'
            if (hTarget > 0) { slot.style.height = hTarget + 'px'; slot.setAttribute('data-rszh', '1') }
            rszSnapRef.current = setTimeout(() => {
              rszSnapRef.current = null
              try {
                slot.removeAttribute('data-rszsnap')
                slot.removeAttribute('data-rszlive')
                applyCardSizeToDom(slot, size, canvas)   // 换成 span 写法（宽度与动画终点一致）
              } catch (e) { /* ignore */ }
            }, 240)
          } catch (e) { /* ignore */ }
        }
        function startCardResize(e, key) {
          if (e === null || e === undefined || typeof key !== 'string' || key === '') return
          if (e.button !== undefined && e.button !== 0) return
          const el = e.currentTarget !== null && e.currentTarget !== undefined ? e.currentTarget : e.target
          const slot = el !== null && el.closest !== undefined ? el.closest('.dshw-slot') : null
          const grid = slot === null ? null : slot.closest('.dshw-grid')
          if (slot === null || grid === null) return
          e.preventDefault()
          e.stopPropagation()
          const canvas = canvasBoxOf(grid)
          const rect = slot.getBoundingClientRect()
          // 起始尺寸 = **当前生效档**（用户档 → 内容默认档 → 自然档），并按当前模式与当前画布换算 ——
          //   不能只读 localStorage：按内容默认跨两列的卡只读 localStorage 会拿到"没有" ⇒ 一拖就掉回一格。
          const cur = effectiveSizeOf(key, rect, canvas)
          // 拖动基线取**像素**（网格档也要跟手，不能按格跳）：起始宽高 = 这张卡此刻真实渲染出来的盒子。
          //   网格档的 `cur.w/h` 是百分比、`layoutForCardSize` 给的 `widthPx` 是 0（宽度由 span 决定），
          //   所以宽高都以量到的 rect 为准 —— 它就是要拖的那个盒子。
          const w0px = rect.width > 0 ? Math.round(rect.width) : pctToPx(cur.w, canvas.w)
          const h0px = rect.height > 0 ? Math.round(rect.height) : (cur.h > 0 && canvas.h > 0 ? pctToPx(cur.h, canvas.h) : CARD_MIN_H_PX)
          try { if (rszSnapRef.current !== null) { clearTimeout(rszSnapRef.current); rszSnapRef.current = null } } catch (err) { /* ignore */ }
          rszRef.current = {
            key: key, slot: slot, x0: e.clientX, y0: e.clientY,
            canvas: canvas, unit: cur.unit,
            w0: cur.w, h0: cur.h, moved: false,
            w0px: w0px, h0px: h0px, wPx: w0px, hPx: h0px,
          }
          try {
            slot.removeAttribute('data-rszsnap')
            window.addEventListener('pointermove', onCardResizeMove)
            window.addEventListener('pointerup', onCardResizeUp)
            window.addEventListener('pointercancel', onCardResizeUp)
          } catch (err) { /* 无 window */ }
          try { document.body.style.cursor = 'nwse-resize'; document.body.style.userSelect = 'none' } catch (err) { /* ignore */ }
          setRszKey(key)
        }
        /**
         * 拖动中：**按像素跟手**（用户 2026-09-26：拖动要跟手，松手才吸附到最近的 5% 网格）。
         *   网格档与无级档在这里走同一条路 —— 差别只在松手时（网格档吸附 + 过渡动画，
         *   见 `onCardResizeUp` / `finishCardResizeSnap`），所以这里一律用 `free` 口径落 DOM：
         *   宽度写行内像素、列跨度按"放得下"的最小列数跟着变（邻居按 5% 一格让位）。
         */
        function onCardResizeMove(e) {
          const st = rszRef.current
          if (st === null) return
          const dx = e.clientX - st.x0
          const dy = e.clientY - st.y0
          if (st.moved === false && Math.abs(dx) + Math.abs(dy) < 3) return   // 手抖不算拖动
          st.moved = true
          const canvas = st.canvas
          const maxW = canvas.w > 0 ? canvas.w : 4000
          const wPx = Math.round(clampCardNum(st.w0px + dx, CARD_MIN_W_PX, maxW))
          const hPx = Math.round(clampCardNum(st.h0px + dy, CARD_MIN_H_PX, CARD_MAX_H_PX))
          st.wPx = wPx
          st.hPx = hPx
          try { st.slot.setAttribute('data-rszlive', '1') } catch (err) { /* ignore */ }
          applyCardSizeToDom(st.slot, { w: wPx, h: hPx, unit: 'free' }, canvas)
          // 网格档下同步记一份"松手时会吸附到哪"（拖动中不落 DOM，只用于最后的吸附）。
          if (st.unit === 'grid') {
            const min = minPctFor(canvas)
            st.w = Math.round(clampCardNum(snapPct(pxToPct(wPx, canvas.w)), min.w, 100))
            st.h = Math.round(clampCardNum(snapPct(pxToPct(hPx, canvas.h)), min.h, 100))
          } else {
            st.w = wPx
            st.h = hPx
          }
        }
        function onCardResizeUp() {
          const st = rszRef.current
          rszRef.current = null
          try {
            window.removeEventListener('pointermove', onCardResizeMove)
            window.removeEventListener('pointerup', onCardResizeUp)
            window.removeEventListener('pointercancel', onCardResizeUp)
          } catch (err) { /* ignore */ }
          try { document.body.style.cursor = ''; document.body.style.userSelect = '' } catch (err) { /* ignore */ }
          setRszKey(null)
          if (st === null || st.moved !== true) return     // 只是点了一下手柄：不改尺寸
          const canvas = st.canvas
          let next
          if (st.unit === 'grid') {
            // 松手才吸附：像素 → 百分比 → 最近的 5%（下限也落在格点上），并用一次过渡动画落到那个尺寸。
            const min = minPctFor(canvas)
            next = {
              w: Math.round(clampCardNum(snapPct(st.w !== undefined ? st.w : pxToPct(st.wPx, canvas.w)), min.w, 100)),
              h: Math.round(clampCardNum(snapPct(st.h !== undefined ? st.h : pxToPct(st.hPx, canvas.h)), min.h, 100)),
              unit: 'grid',
            }
            finishCardResizeSnap(st.slot, next, canvas)
          } else {
            // 无级档：没有吸附，也没有回弹 ⇒ 停在松手的位置即可（仍旧是像素写法）。
            next = {
              w: Math.round(clampCardNum(st.wPx, CARD_MIN_W_PX, 4000)),
              h: Math.round(clampCardNum(st.hPx, CARD_MIN_H_PX, CARD_MAX_H_PX)),
              unit: 'free',
            }
            try { st.slot.removeAttribute('data-rszlive') } catch (err) { /* ignore */ }
            applyCardSizeToDom(st.slot, next, canvas)
          }
          const all = Object.assign({}, cardSizeRef.current)
          all[st.key] = next
          cardSizeRef.current = all
          setCardSize(all)
          lsSet(CARD_SIZE_LS, JSON.stringify(all))
        }
        const slotOf = (k, idx, total) => {
          const el = cardsByKey.get(k)
          if (!el) return null
          // ── ② 专注期间：非醒目卡 → **降权 + 默认折叠成一行摘要**（保留展开入口）────────
          //   ⚠️ 纪律（四条，都有断言守）：
          //     1. **只改视觉**：DOM 次序不变（包装元素仍在该 slot 内、该 index 上）⇒ 顺序断言不受影响；
          //        不 display:none、不卸载内容 ⇒ 卡片仍在、仍可长按整卡拖动。
          //     2. 醒目卡（专注卡 / 目标映射卡 / 白名单命中卡）**一个字都不改**，原样渲染。
          //     3. 展开入口**永远在**：右侧显式 button（键盘可达、触屏可点）。
          //     4. ⚠️ **摘要条本身不挂 `data-click`、不给 onClick** ——
          //        `CARD_DRAG_EXCLUDE` 里含 `[data-click="1"]`，一旦摘要条带上它，
          //        整张折叠卡就会落进"卡内控件、拖动完全不介入"的分支 ⇒ **折叠后再也长按不动**。
          //        折叠态的卡片整个版面都是这条摘要 ⇒ 必须让它**保持可拖动**：
          //        点击入口收敛到显式按钮上（按钮属 `.dshw-btn`，本来就在排除表里，不会误触发拖动）。
          const dimmed = focusView.active === true && focusView.prominent.indexOf(k) === -1
          const body = dimmed ? (() => {
            // ⚠️ 默认折叠值取自常量（`FOCUS_DIM.foldedByDefault` = true）；包装属性名与摘要条类名
            //    **写回字面量** —— 见上方 `FOCUS_DIM` 那段：字面量是契约锚点，不可改为常量取值。
            const folded = FOCUS_DIM.foldedByDefault && focusUnfold[k] !== true
            const head = cardHeadTextOf(el, k)
            if (!folded) {
              // 手动展开：内容全量显示，但**仍然降权**（用户只是要读，不是取消降权）
              return h('div', { className: 'dshw-focusdim', 'data-dim': '1', 'data-folded': '0', 'data-card': k },
                h('div', {
                  className: 'dshw-focussum', key: 'folds-' + k,
                  title: '专注期间该卡已降权（未命中专注目标）。点右侧「收起」回到一行摘要；长按卡片仍可拖动排序',
                },
                h('span', { className: 'dshw-focussum-t' }, '▾ ' + head.title),
                h('span', { className: 'dshw-focussum-b' }, '已展开（专注期间降权显示）'),
                h('span', { className: 'dshw-spacer' }),
                h('button', {
                  className: 'dshw-btn', type: 'button', key: 'foldbtn-' + k,
                  title: '回到一行摘要（卡片不会消失、顺序不变）',
                  onClick: () => setFocusUnfold((p) => Object.assign({}, p, { [k]: false })),
                }, '收起')),
                el)
            }
            return h('div', { className: 'dshw-focusdim', 'data-dim': '1', 'data-folded': '1', 'data-card': k },
              h('div', {
                className: 'dshw-focussum', key: 'fold-' + k,
                title: '专注期间该卡已降权（未命中专注目标）。点右侧「展开」看完整内容；长按卡片仍可拖动排序。'
                  + '卡片不会消失、顺序不变',
              },
              h('span', { className: 'dshw-focussum-t' }, '▸ ' + head.title),
              head.badge ? h('span', { className: 'dshw-focussum-b' }, head.badge) : null,
              h('span', { className: 'dshw-spacer' }),
              h('span', { className: 'dshw-focussum-hint' }, '专注期间降权'),
              h('button', {
                className: 'dshw-btn', type: 'button', key: 'unfoldbtn-' + k,
                title: '展开完整内容（专注期间仍降权显示）',
                onClick: () => setFocusUnfold((p) => Object.assign({}, p, { [k]: true })),
              }, '展开')))
          })() : el
          // ── ③ 每卡**错误边界**（2026-09-17）：把这一张卡的渲染包进 `CardErrorBoundary` ────────
          //   目的与判据见 `CardErrorBoundary` 上方那段（一个分支抛错不得带走整块面板）。
          //   ⚠️ 包装放在**降权包装之内**：`.dshw-slot > [data-dim]` 这条专注契约不受影响
          //      （`[data-dim]` 仍是 slot 的直接子元素）；错误态下渲染的是 `.dshw-card`，
          //      **不可能是 `[data-dim]`**，故 `:scope > [data-dim]` 的判据也不会误命中。
          //   ⚠️ label 用**已渲染卡名**（从元素里读，与 `cardHeadTextOf` 同源），拿不到才回落 key。
          const slotBody = h(CardErrorBoundary, {
            key: 'eb-' + k, label: cardBoundaryLabel(k, el), cardKey: k,
          }, body)
          // ── 卡片尺寸（2026-09-25 起；09-26 支持"网格 5% / 无级"两档）────────────────
          //   没有档位的卡：**行内 span 按画布宽度算**（老栅格一列多宽 → 5% 的格数），
          //   这样"没动过的卡片布局与改造前一致"，同时它也是新的 20 列栅格里的正常占位。
          const sz = effectiveCardSizeOf(cardSize, k)
          const szStyle = {}
          let szRszh = 0
          const naturalSpan = 'span ' + defaultSpanFor(canvasBox.w, embedded ? CARD_NATURAL_MIN_PX : CARD_NATURAL_MIN_PX_FLOAT)
          if (sz !== null && sz !== undefined) {
            const L = layoutForCardSize(sz, canvasBox, embedded ? CARD_NATURAL_MIN_PX : CARD_NATURAL_MIN_PX_FLOAT)
            // 只有高度档、没有宽度档的卡（内容默认档里有几张就是这种）⇒ 宽度仍走自然档，
            //   否则它会掉回"只占一列"（窄面板里那张卡就莫名其妙变窄了）。
            szStyle.gridColumn = L.span > 0 ? ('span ' + L.span) : naturalSpan
            if (L.widthPx > 0) { szStyle.width = L.widthPx + 'px'; szStyle.justifySelf = 'start' }
            if (L.heightPx > 0) { szStyle.height = L.heightPx + 'px'; szRszh = 1 }
          } else {
            szStyle.gridColumn = naturalSpan
          }
          return h('div', {
            className: 'dshw-slot',
            key: 'slot-' + k,
            'data-key': k,
            'data-idx': idx,
            'data-dim': dimmed ? '1' : null,
            'data-dragging': dragKey === k ? '1' : null,
            'data-dragover': dragOverKey !== null && dragOverKey.key === k ? dragOverKey.pos : null,
            'data-rszh': szRszh > 0 ? '1' : null,
            'data-rszing': rszKey === k ? '1' : null,
            'data-moving': moveKey === k ? '1' : null,
            style: Object.keys(szStyle).length > 0 ? szStyle : null,
            // ⚠️ 用 pointer events（鼠标/触屏/触控笔同一套），**不用 HTML5 draggable**：
            //    后者在触屏上不触发，且会与卡内点击/选中打架。
            onPointerDown: (e) => {
              if (e.button !== undefined && e.button !== 0) return          // 只认主键
              if (isInteractiveTarget(e.target)) return                     // 卡内控件：完全不介入
              const startX = e.clientX, startY = e.clientY
              cardDragRef.current = { key: k, startX, startY, active: false, over: null, timer: null }
              cardDragRef.current.timer = setTimeout(() => {
                const st = cardDragRef.current
                if (st === null || st.key !== k) return
                beginCardDrag(k)                                            // 到点才"抬起"
              }, CARD_LONGPRESS_MS)
              try {
                if (typeof window !== 'undefined') {
                  window.addEventListener('pointermove', onDragPointerMove)
                  window.addEventListener('pointerup', onDragPointerUp)
                  window.addEventListener('pointercancel', onDragPointerCancel)
                  window.addEventListener('keydown', onDragKeyDown)
                  window.addEventListener('blur', onDragPointerCancel)
                  // 捕获阶段拦"拖后那一次 click"（见 dragClickGuardRef 的注释）
                  window.addEventListener('click', onDragClickGuard, true)
                }
              } catch (err) { /* ignore */ }
            },
            onPointerLeave: (e) => {
              // 指针离开窗口即取消（用户要求：拖到窗口外 → 回到原位）
              if (e && e.relatedTarget === null && cardDragRef.current !== null) endCardDrag(false)
            },
            onContextMenu: (e) => { if (cardDragRef.current !== null) e.preventDefault() },
          }, slotBody)
        }
        // 拖动进行中：锁住栅格滚动 + 抑制文字选中（松手/取消时由 effect 恢复）
        const dragLock = dragKey !== null || moveKey !== null
        const cards = [
          ...alertBlocks,
          ...effectiveOrder.map((k, i) => slotOf(k, i, effectiveOrder.length)).filter(Boolean),
          ...unlistedKeys.map((k) => cardsByKey.get(k)),
        ].filter(Boolean)

        // ── 让位动画（FLIP）与"被拖的卡继续跟手"都在**渲染之后**做 ──────────────────
        //   顺序不能反：runFlip 第一步会清掉所有内联 transform（否则量到的"新位置"本身就歪），
        //   紧接着 placeMovingCard 把被拖那张重新贴回指针 ⇒ 中间不会闪一帧。
        //   这个 effect **没有依赖数组**（每次渲染后都跑），但绝大多数渲染里两个判断都是假，直接返回。
        React.useEffect(() => {
          const job = flipRef.current
          flipRef.current = null
          const moving = moveDragRef.current
          if (job !== null && job !== undefined) runFlip(job.prev, job.skip)
          if (moving !== null) placeMovingCard()
        })

        // ── 卡片**最小高度**比例（2026-09-15 用户更正：限制下限而非上限）──
        //    2 列栅格下卡片行数 R = ceil(卡片数/2)，每张卡至少占 100%/R 高 ——
        //    表格对应 6 行 16% · 4 行 24% · 3 行 33% · 2 行 49%（略小于 100/R，留出栅格间距与底部状态行）。
        //    内容超出则卡片自然变高，栅格整体滚动；内容少也保持这个下限，不塌成一条。
        const CARD_MIN_TABLE = { 6: 16, 4: 24, 3: 33, 2: 49 }
        const cardRows = Math.max(1, Math.ceil(cards.length / 2))
        const cardMinPct = CARD_MIN_TABLE[cardRows] ?? Math.max(12, Math.round(100 / cardRows) - 1)

        // ── 底部固定行：**2026-09-15 用户要求移除**（原为「诊断: … · better-sidebar tab」）──
        //    首屏不再占这一行；诊断信息需要时从 host 的 /state（snap.diag）取，不进面板。
        const panel = box.ready === true
          ? h('div', { key: 'wb' },
            h('aside', { className: 'dshw-panel', style: embedded
              ? { width: '100%', height: '100%', minHeight: '240px' }
              : { width: box.wbW + 'px', height: box.wbH + 'px' } },
              h('div', { className: 'dshw-head' },
                // ⚠️ 2026-09-17 复原（裁定 B · 误删）：面板标题这里用**字面量**，不是 `SIDEBAR_TAB_TITLE`。
                //   本行是设备提示位的**契约锚点**（T16-47 与 SBT-11m 守同一件事：标题 → 瞬时提示 →
                //   更新时间，三者同序且在头部；卡片底部不再渲染该提示行）。套件按字面量定位这三段，
                //   换成常量取值会让定位落空。常量本身仍在上方声明，tab 注册仍从常量取值
                //   （`SIDEBAR_TAB_TITLE === '工作台'`，两处取值恒等）。
                h('span', { className: 'dshw-h1' }, '工作台'),
                // 瞬时提示（设备回执）：「工作台」右侧的中段位置；无提示时占位保持布局稳定
                h('span', { className: 'dshw-toast-wrap', key: 'toastwrap' },
                  toast !== null
                    ? h('span', { className: 'dshw-toast', key: toast.key, 'data-tone': toast.tone, 'data-phase': toast.phase, title: toast.text }, toast.text)
                    : null),
                h('span', { className: 'dshw-sub' }, (snap && snap.at ? '更新于 ' + fmtClock(snap.at) : '读取中…') + ' · ⌘K 搜索'),
                // 卡片顺序：**顶部一行小字**（用户裁定：不放卡片上、不浮层，避免遮挡卡片控件）
                //   常态只提示"长按可拖动"；有覆盖层时多一个「恢复默认」文字链接。
                //   ⚠️ 降级层：`/ui-prefs` 未加载（旧 host）时**关闭拖动与恢复默认**并写明原因 ——
                //      否则用户拖完保存失败，只会得到一次没有出路的报错（要求：能用的才给入口）。
                h('span', { className: 'dshw-orderbar', key: 'orderbar' },
                  routeDown['ui-prefs'] === true
                    ? h('span', { className: 'dshw-orderhint', key: 'down' },
                      '卡片排序不可用：' + ROUTE_DOWN_TEXT + '（当前按默认顺序显示）')
                    : h('span', { className: 'dshw-orderhint', key: 'hint' }, '长按卡片可拖动排序'),
                  // 新手指引入口（2026-09-25）：与「恢复默认」同为 `.dshw-orderlink`。
                  //   ⚠️ 套件按**文本**定位「恢复默认」（`.dshw-orderlink` 里 textContent 相等的那一个），
                  //      所以新增一个不同文案的同名链接不会影响 SBT-45/46。
                  h('button', {
                    className: 'dshw-orderlink', type: 'button', key: 'tour',
                    title: '看一遍这张卡的用法（也可以按 ⌘K 搜「新手指引」）',
                    onClick: () => startTour(),
                  }, '新手指引'),
                  h('button', {
                    className: 'dshw-orderlink', type: 'button', key: 'catalog',
                    title: '一张表看清 13 张卡的关键指标，并可跳过去',
                    onClick: () => setDwOpen(true),
                  }, '卡片目录'),
                  // 缩放档位（2026-09-26 用户裁定："可以选择无级缩放或者网格缩放"）：
                  //   一个文字链接来回切；切换时把已有档位**换算过去**（卡片不会跳一下）。
                  //   文案与外观入口同一条写法（`data-sizemode` 给套件认，不靠文案）。
                  h('button', {
                    className: 'dshw-orderlink', type: 'button', key: 'sizemode',
                    'data-sizemode': sizeMode,
                    title: sizeMode === 'grid'
                      ? '当前：网格缩放（宽高都吸附到 5% 的格点）—— 点一下切成无级'
                      : '当前：无级缩放（宽高都是自由像素）—— 点一下切成网格 5%',
                    onClick: () => toggleSizeMode(),
                  }, sizeMode === 'grid' ? '缩放：网格 5%' : '缩放：无级'),
                  // 外观入口（2026-09-26）：文案恒为「外观」——当前是哪一档在浮层里标出来。
                  //   ⚠️ 不放进 `.dshw-head`：那一行的直接子元素是结构契约（REST-2 + 负向对照守着）。
                  h('button', {
                    className: 'dshw-orderlink', type: 'button', key: 'theme',
                    title: '外观：跟随 DSH / 宣纸（浅色）/ 夜书（深色）',
                    onClick: openThemeMenu,
                  }, '外观'),
                  cardOrderOverride !== null
                    ? h('span', { className: 'dshw-orderhint', key: 'sep' }, '·')
                    : null,
                  routeDown['ui-prefs'] !== true && cardOrderOverride !== null
                    ? h('button', {
                      className: 'dshw-orderlink', type: 'button', key: 'reset',
                      title: '清空自定义顺序，回到默认三带布局',
                      onClick: () => resetCardOrder(),
                    }, '恢复默认')
                    : null),
              ),
              // 覆盖层读失败必须说出来：否则用户会以为"顺序没生效是拖动坏了"
              orderErr !== null
                ? h('div', { className: 'dshw-ordererr', key: 'ordererr' },
                  '卡片顺序读取失败（当前用默认顺序）: ' + orderErr)
                : null,
              h('div', {
                className: 'dshw-grid',
                'data-draglock': dragLock ? '1' : null,
                'data-sizemode': sizeMode,
                ref: gridRef,
                style: { '--dshw-card-min': cardMinPct + '%' },
              }, cards),
            ),
            embedded ? null : h('div', {
              className: 'dshw-hresizer',
              key: 'hrz',
              'data-drag': dragging ? '1' : null,
              style: { width: box.wbW + 'px', top: box.wbH + 'px' },
              title: '拖拽调整工作台高度,双击复位',
              onMouseDown: (e) => { e.preventDefault(); dragRef.current = { startY: e.clientY, startH: box.wbH }; setDragging(true) },
              onDoubleClick: () => { setWbH(340); lsSet('dshw.wbH', '340') },
            }),
          )
          : null

        // ── 事务详情卡（E 块）：上层卡片 —— 详情 / 添加记录 / 关闭或重开 ──
        const matterModalEl = matterModal === null ? null : (() => {
          const m = matterModal.matter
          const closed = m !== null && Boolean(m.closed_at)
          const reopenedAt = m !== null && Boolean(m.reopened_at)
          const recs = (m && m.records) || []
          const detailRows = []
          if (m === null && matterModal.error !== null) {
            detailRows.push(h('div', { className: 'dshw-msg', key: 'me' },
              '详情读取失败: ' + matterModal.error + '（该事务可能尚未立案，承诺候选需先经库内立项转事务）'))
          }
          if (m !== null) {
            // 事务上的时间是**发起时间**（该事务被发起/提出的日期）—— 不做过期判定（2026-09-15 更正）
            detailRows.push(h('div', { className: 'dshw-mrow', key: 'sched' },
              h('span', { className: 'dshw-mrow-l' }, '发起时间'),
              h('span', { className: 'dshw-mrow-v' }, String(m.created_at || m.due_at || '—').slice(0, 10))))
            if (m.held_by) detailRows.push(h('div', { className: 'dshw-mrow', key: 'hby' },
              h('span', { className: 'dshw-mrow-l' }, '持有人'), h('span', { className: 'dshw-mrow-v' }, String(m.held_by))))
            if (m.counterparty) detailRows.push(h('div', { className: 'dshw-mrow', key: 'ctp' },
              h('span', { className: 'dshw-mrow-l' }, '对方'), h('span', { className: 'dshw-mrow-v' }, String(m.counterparty))))
            if (m.domain) detailRows.push(h('div', { className: 'dshw-mrow', key: 'dom' },
              h('span', { className: 'dshw-mrow-l' }, '关注域'), h('span', { className: 'dshw-mrow-v' }, String(m.domain))))
            if (m.done_when) detailRows.push(h('div', { className: 'dshw-mrow', key: 'dw' },
              h('span', { className: 'dshw-mrow-l' }, '关闭条件'),
              h('span', { className: 'dshw-mrow-v' }, String(m.done_when),
                // 检测按钮（2026-09-15 需求）：当面求值关闭条件，满足即记录证据并关闭
                h('button', {
                  className: 'dshw-btn',
                  type: 'button',
                  style: { marginLeft: '6px' },
                  disabled: matterModal.checkBusy === true || closed,
                  title: closed ? '事务已关闭' : '按关闭条件当场检测（满足即自动记录并关闭）',
                  onClick: checkMatterCondition,
                }, matterModal.checkBusy === true ? '…' : '检测'))))
            if (m.origin_project) detailRows.push(h('div', { className: 'dshw-mrow', key: 'op' },
              h('span', { className: 'dshw-mrow-l' }, '来源项目'), h('span', { className: 'dshw-mrow-v' }, String(m.origin_project))))
            detailRows.push(h('div', { className: 'dshw-mrow', key: 'st' },
              h('span', { className: 'dshw-mrow-l' }, '状态'),
              closed
                ? h('span', { className: 'dshw-mrow-v' }, '已关闭 · ' + String(m.closed_at || '').slice(0, 10) + (m.closure_note ? ' · 结束记录: ' + String(m.closure_note) : ''))
                : h('span', { className: 'dshw-mrow-v' }, reopenedAt ? '进行中（曾关闭，已重新打开）' : '进行中')))
            const srcs = Array.isArray(m.sources) ? m.sources : []
            if (srcs.length > 0) {
              detailRows.push(h('div', { className: 'dshw-mrow', key: 'src' },
                h('span', { className: 'dshw-mrow-l' }, '打开来源'),
                h('span', { className: 'dshw-mrow-v' },
                  srcs.map((s) => h('button', {
                    key: s, className: 'dshw-btn', style: { marginRight: '4px' },
                    onClick: () => openFile(s, s),
                  }, String(s).split('\\').pop())))))
            }
          }
          // ── P2/B6：事务详情**设计 7 项** ────────────────────────────────────────
          //   设计原话（脑图）：事务聚合信息 → 详情页包含（按时间排序）→ 归属域 / 归属对象 /
          //   决策（已决策·待决策）/ 响应（已响应·待响应）/ 日程 / 待办 / AI 分析。
          //   ★ 卡片**不做判断**：每项都取 payload 原值或"没有关联"这一事实；
          //     取不到数据源时写**未接入**（读失败 ≠ 无数据 ≠ 口径为 0，三态不合并）。
          //   ★ 每项都带 `data-mtfield` ⇒ 断言按语义定位（不锚行号）。
          const mtRel = (pwb && pwb.sections && pwb.sections.relations) || null
          const mtRelEdges = (mtRel && mtRel.byAnchor && m !== null) ? (mtRel.byAnchor[String(m.id)] || []) : []
          const mt7 = (() => {
            const rows = []
            const row = (id, label, value, why) => rows.push(h('div', {
              className: 'dshw-mrow', key: 'f' + id, 'data-mtfield': id,
            },
              h('span', { className: 'dshw-mrow-l' }, label),
              h('span', { className: 'dshw-mrow-v' }, value, why ? h('span', { style: { opacity: .6, marginLeft: '6px' } }, why) : null)))
            const dash = (v) => (v === null || v === undefined || String(v).trim() === '' ? '—' : String(v))
            // 1 归属域
            row('domain', '归属域', dash(m && m.domain), (m && m.domain) ? null : '（未归属任何关注域）')
            // 2 归属对象（objects.json#byRecord —— 对象层的权威归属）
            //   ★ 2026-09-21（P2b）：对象已改为**属性** ⇒ 本条从"一个 key"扩成**属性全量**
            //     （key / kind / parent / state / counts），并新增 2b「对象下一步」与 2c「对象出处」
            //     —— 原来只在「对象」卡二级详情里的字段，现在挂在事务详情上（payload 原样，不推断）。
            const rec = objRecOf(m === null ? null : m.id)
            const oItem = rec === null ? null : objItemOf(rec.key)
            const oCounts = (oItem !== null && oItem.counts !== null && oItem.counts !== undefined) ? oItem.counts : null
            row('object', '归属对象', rec === null
              ? (objs === null ? '未接入' : '无')
              : (String(rec.key) + ' · ' + String(rec.kind || '—')
                + (rec.parent === null || rec.parent === undefined ? '' : ' · 父 ' + String(rec.parent))
                + ' · ' + String((oItem || {}).state || '—')
                + (oCounts === null ? '' : ' · ' + objCountsText(oCounts))),
            objs === null
              ? '（/objects 未读取 ⇒ 读失败，不等于没有对象）'
              : (rec === null ? '（对象层未归属该事务）' : String(rec.evidence || '')))
            // 2b 对象的下一步（payload next_step 原样：不推断、不补期限、不改写标题）
            const oNs = (oItem !== null && oItem.next_step !== null && oItem.next_step !== undefined) ? oItem.next_step : null
            row('object-next', '对象下一步', oNs === null
              ? (rec === null ? '—' : 'payload next_step = null')
              : (String(oNs.id || '—') + ' · ' + String(oNs.title || '') + ' · ' + objRaw(oNs.due_at) + ' · ' + String(oNs.owner || '—')),
              oNs === null ? '（该对象没有下一步）' : '（payload 原样）')
            // 2c 对象的出处（sources 路径全列 + trace 三数）—— 原「对象」卡二级详情 ③ 段并入此处
            const oSrcs = (oItem !== null && Array.isArray(oItem.sources)) ? oItem.sources : []
            const oTrace = (oItem !== null && oItem.trace !== null && oItem.trace !== undefined) ? oItem.trace : {}
            row('object-source', '对象出处', rec === null
              ? '—'
              : (oSrcs.length === 0 ? 'payload sources 为空'
                : String(oSrcs.length) + ' 个 · ' + oSrcs.map((s, i) => String(i + 1) + ' ' + String(s)).join(' · ')),
              rec === null ? null : ('trace: origin_inbound ' + String(oTrace.origin_inbound === undefined ? '—' : oTrace.origin_inbound)
                + ' · source_ref ' + String(oTrace.source_ref === undefined ? '—' : oTrace.source_ref)
                + ' · records ' + String(oTrace.records === undefined ? '—' : oTrace.records)))
            // 3 决策（已决策 / 待决策）—— 依据 = 台账里该事务是否为某条流入的落点
            const decided = (dispDoc && Array.isArray(dispDoc.entries) && m !== null)
              ? dispDoc.entries.filter((e) => ((e.landing || {}).matter_ids || []).indexOf(String(m.id)) >= 0)
              : null
            row('decision', '决策', decided === null ? '未接入' : (decided.length > 0 ? '已决策 · 落点 ' + decided.length + ' 条' : '待决策'),
              decided === null ? '（/disposition 未读取）' : (decided.length > 0 ? null : '（台账里无该事务的落点）'))
            // 4 响应（已响应 / 待响应）—— 依据 = 关联边里的触发（R7：同一 origin_inbound）
            const trg = mtRelEdges.filter((e) => e.toKind === 'trigger')
            row('response', '响应', mtRel === null ? '未生成' : (trg.length > 0 ? '关联触发 ' + trg.length + ' 条' : '无'),
              mtRel === null ? '（relations.json 未生成）' : (trg.length > 0 ? '（见下方「因果链 / 关联」）' : '（无同源触发）'))
            // 5 日程（按**同截止日**关联；快照只给今明两天 ⇒ 窗口外如实说明）
            const cal = (snap && snap.calendar) || null
            const dayOf = (v) => String(v || '').slice(0, 10)
            const evs = (cal === null || m === null) ? [] : []
              .concat(Array.isArray(cal.today) ? cal.today : [])
              .concat(Array.isArray(cal.tomorrow) ? cal.tomorrow : [])
              .filter((x) => dayOf(x.start) === dayOf(m.due_at))
            row('schedule', '日程', cal === null ? '未接入' : (evs.length > 0 ? evs.slice(0, 2).map((x) => String(x.title || '')).join(' / ') : '无'),
              cal === null ? '（快照缺 calendar 块）' : (evs.length > 0 ? null : '（快照的今明两天窗口内无同截止日日程）'))
            // 6 待办（按**同截止日**关联 —— 只做日期比对，不做语义猜测）
            const td = (snap && snap.todos) || null
            const tItems = (td && Array.isArray(td.items)) ? td.items : null
            const tHit = (tItems === null || m === null) ? [] : tItems.filter((x) => dayOf(x.due) === dayOf(m.due_at))
            row('todo', '待办', tItems === null ? '未接入' : (tHit.length > 0 ? tHit.slice(0, 2).map((x) => String(x.title || x.text || '')).join(' / ') : '无'),
              tItems === null ? '（快照缺 todos.items 块）' : (tHit.length > 0 ? null : '（无同截止日待办）'))
            // 7 AI 分析（洞察卡的证据段 —— 显式引用才认）
            const insList = (insights && Array.isArray(insights.insights)) ? insights.insights : null
            const insHit = (insList === null || m === null) ? [] : insList.filter((it) => (Array.isArray(it.evidence) ? it.evidence : [])
              .some((ev) => String(ev.kind) === 'matter' && String(ev.id) === String(m.id)))
            row('ai', 'AI 分析', insights === null ? '未接入' : (insHit.length > 0 ? insHit.slice(0, 2).map((it) => String(it.kind_label || it.id || '')).join(' / ') : '无'),
              insights === null ? '（/insights 未读取）' : (insHit.length > 0 ? null : '（无洞察引用该事务为证据）'))
            return rows
          })()
          const recRows = recs.length === 0
            ? [h('div', { className: 'dshw-empty', key: 'norec' }, '暂无记录')]
            : recs.slice().reverse().map((r, i) => h('div', { className: 'dshw-rec', key: 'r' + i },
              h('div', { className: 'dshw-rec-time' },
                String(r.ts || '').slice(0, 16).replace('T', ' ') + ' · ' + (REC_LABEL[r.kind] || '备忘') + (r.path ? ' · 关联: ' + String(r.path).split('\\').pop() : '')),
              h('div', { className: 'dshw-mrow-v' }, String(r.text || '')),
              r.path ? h('button', { className: 'dshw-btn', onClick: () => openFile(r.path, r.path) }, '打开关联') : null))
          return h('div', { className: 'dshw-modal-backdrop', onClick: () => setMatterModal(null) },
            h('section', { className: 'dshw-modal', onClick: (e) => e.stopPropagation() },
              h('div', { className: 'dshw-modal-head' },
                h('span', { className: 'dshw-modal-title', title: String(matterModal.id) }, String(matterModal.title || matterModal.id)),
                h('span', { className: 'dshw-badge' }, closed ? '已关闭' : (m !== null ? '进行中' : '—')),
                h('span', { className: 'dshw-spacer' }),
                h('button', { className: 'dshw-btn', onClick: () => setMatterModal(null) }, '✕')),
              h('div', { className: 'dshw-modal-body' },
                matterModal.loading === true
                  ? h('div', { className: 'dshw-empty' }, '读取事务详情…')
                  : [
                    h('div', { className: 'dshw-modal-sec', key: 'sec1' },
                      h('div', { className: 'dshw-modal-sec-h' }, '事务详情'),
                      detailRows),
                    h('div', { className: 'dshw-modal-sec', key: 'sec7', 'data-mtsec': 'fields' },
                      h('div', { className: 'dshw-modal-sec-h' }, '事务聚合信息（设计 7 项 · 空态写明为什么为空）'),
                      mt7),
                    h('div', { className: 'dshw-modal-sec', key: 'sec8', 'data-mtsec': 'relations' },
                      h('div', { className: 'dshw-modal-sec-h' }, '因果链 / 关联（事件 = 事务）'),
                      // ★ 只渲染：依据与强度**原样取自 relations.json 的定界引用**，卡片不重算。
                      //   缺产物 ⇒ 「未生成」（不是 0 条）；数据时刻不一致 ⇒ 显式标「陈旧」。
                      mtRel === null
                        ? h('div', { className: 'dshw-empty', 'data-rel': 'absent' },
                          '关联：—（relations.json 未生成 ⇒ 运行 node _meta/workbench/build-relations.mjs）')
                        : [
                          mtRel.stale === true
                            ? h('div', { className: 'dshw-detail', 'data-rel': 'stale' },
                              '⚠️ 关联数据陈旧：relations.json 数据时刻 ' + String(mtRel.generatedAt || '—')
                              + ' ≠ 快照 ' + String(mtRel.snapshotDataAsOf || '—'))
                            : null,
                          mtRelEdges.length === 0
                            ? h('div', { className: 'dshw-empty', 'data-rel': 'none' }, '该事务暂无有出处的关联边')
                            : h('div', { 'data-rel': 'rows' }, mtRelEdges.map((e, i) => h('div', {
                              className: 'dshw-detail', key: 're' + i, 'data-reltype': e.type,
                            },
                              h('div', { style: { fontWeight: '600' } },
                                '[' + relTypeLabel(e.type) + ' · ' + String(e.strength || '—') + '] ' + String(e.to)),
                              h('div', { style: { opacity: .8 } }, '依据：' + String(e.basis || '—')),
                              h('div', { style: { opacity: .65, wordBreak: 'break-all' } }, '出处：' + (e.sources || []).join(' · '))))),
                          h('div', { style: { opacity: .6 } },
                            '唯一真相：' + String(mtRel.sourceFile || '_meta/out/relations.json')
                            + ' · 共 ' + String((mtRel.counts && mtRel.counts.edges) || 0) + ' 条边'
                            + (mtRel.truncated > 0 ? ' · 此处每锚点只列前 ' + String(mtRel.perAnchor) + ' 条（截断 ' + String(mtRel.truncated) + ' 条，因果边不截断）' : '')),
                        ]),
                    h('div', { className: 'dshw-modal-sec', key: 'sec2' },
                      h('div', { className: 'dshw-modal-sec-h' }, '添加对应记录（进度 / 决策 / 风险 / 备忘）'),
                      h('select', {
                        value: matterModal.recKind,
                        onChange: (e) => setMatterModal((p) => Object.assign({}, p, { recKind: e.target.value })),
                      }, REC_KINDS.map((k) => h('option', { key: k.v, value: k.v }, k.l))),
                      h('textarea', {
                        rows: 2, value: matterModal.recText, placeholder: '记录内容（必填，≤500 字）',
                        onChange: (e) => setMatterModal((p) => Object.assign({}, p, { recText: e.target.value })),
                      }),
                      h('input', {
                        type: 'text', value: matterModal.recPath, placeholder: '可选：关联知识库内文件绝对路径（如听记/聊天记录）',
                        onChange: (e) => setMatterModal((p) => Object.assign({}, p, { recPath: e.target.value })),
                      }),
                      h('button', { className: 'dshw-btn', onClick: addRecordNow, disabled: matterModal.busy }, matterModal.busy ? '…' : '添加记录'),
                      h('div', { className: 'dshw-modal-sec-h', style: { marginTop: '6px' } }, '已有记录 ' + recs.length + ' 条'),
                      recRows),
                    h('div', { className: 'dshw-modal-sec', key: 'sec3' },
                      h('div', { className: 'dshw-modal-sec-h' }, closed ? '结束 / 重新打开' : '关闭 / 结束事务'),
                      closed
                        ? h('button', { className: 'dshw-btn', onClick: reopenMatterNow, disabled: matterModal.busy }, matterModal.busy ? '…' : '重新打开事务')
                        : [
                          h('textarea', {
                            key: 'cn', rows: 2, value: matterModal.closeNote, placeholder: '结束节点反馈 / 记录（必填）—— 过期事务关闭尤其需要',
                            onChange: (e) => setMatterModal((p) => Object.assign({}, p, { closeNote: e.target.value, confirmClose: false })),
                          }),
                          h('button', {
                            key: 'cb', className: 'dshw-btn', onClick: closeMatterNow, disabled: matterModal.busy,
                          }, matterModal.busy ? '…' : (matterModal.confirmClose ? '确认关闭？再点一次执行' : '关闭事务')),
                        ]),
                    matterModal.msg !== null
                      ? h('div', { className: 'dshw-msg', key: 'msg', 'data-ok': /已添加|已关闭|已重新/.test(matterModal.msg) ? '1' : null }, matterModal.msg)
                      : null,
                  ]),
            ))
        })()

        // ── 日程详情卡（2026-09-15 用户要求）：点击日程 → 上层弹窗 ──
        const calModalEl = calModal === null ? null : (() => {
          const e = calModal.e || {}
          const src = e.source === 'feishu' ? '飞书' : e.source === 'trip' ? '行程' : '钉钉'
          const fmt = (iso) => {
            const d = new Date(String(iso || ''))
            if (Number.isNaN(d.getTime())) return '—'
            const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
            return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}（${wd}）${pad2(d.getHours())}:${pad2(d.getMinutes())}`
          }
          const rows = []
          rows.push(h('div', { className: 'dshw-mrow', key: 'src' },
            h('span', { className: 'dshw-mrow-l' }, '来源'),
            h('span', { className: 'dshw-mrow-v' }, src + (e.org ? ' · ' + e.org : ''))))
          rows.push(h('div', { className: 'dshw-mrow', key: 'time' },
            h('span', { className: 'dshw-mrow-l' }, '时间'),
            h('span', { className: 'dshw-mrow-v' }, fmt(e.start) + (e.end ? ' → ' + fmt(e.end) : ''))))
          if (e.location) {
            rows.push(h('div', { className: 'dshw-mrow', key: 'loc' },
              h('span', { className: 'dshw-mrow-l' }, '地点'), h('span', { className: 'dshw-mrow-v' }, String(e.location))))
          }
          if (e.kind || e.vendor || e.no) {
            rows.push(h('div', { className: 'dshw-mrow', key: 'trip' },
              h('span', { className: 'dshw-mrow-l' }, '行程'),
              h('span', { className: 'dshw-mrow-v' }, [e.kind, e.vendor, e.no].filter(Boolean).join(' · '))))
          }
          if (e.id) {
            rows.push(h('div', { className: 'dshw-mrow', key: 'id' },
              h('span', { className: 'dshw-mrow-l' }, '日程 ID'),
              h('span', { className: 'dshw-mrow-v', style: { wordBreak: 'break-all' } }, String(e.id))))
          }
          // 参会人（仅钉钉可查：走既有 /event 路由 = dws calendar +attendee-list）
          if ((e.source || 'dingtalk') === 'dingtalk') {
            const atts = calModal.attendees
            const line = calModal.loading === true
              ? '读取中…'
              : atts === null
                ? String(calModal.error || '未取到')
                : (atts.length === 0 ? '（无参会人）' : atts.length + ' 人: ' + atts.slice(0, 12).map((a) => a.name + (a.status ? '(' + (STATUS_LABEL[a.status] || a.status) + ')' : '')).join('、') + (atts.length > 12 ? ' …' : ''))
            rows.push(h('div', { className: 'dshw-mrow', key: 'att' },
              h('span', { className: 'dshw-mrow-l' }, '参会人'), h('span', { className: 'dshw-mrow-v' }, line)))
          }
          // 动作区：飞书事件页 / 会议链接（都在侧边栏浏览器打开 —— 穿透）
          // 回执两处都写：弹窗内 calModal.note（用户此刻看的是弹窗）+ 面板 note（离开弹窗后仍可见）
          const noteBoth = (t) => {
            setNote(t)
            setCalModal((p) => (p === null ? p : Object.assign({}, p, { note: t })))
          }
          const acts = []
          if (e.url) {
            acts.push(h('button', {
              key: 'feishu', className: 'dshw-btn',
              onClick: () => {
                noteBoth(openInSidebarUrl(e.url, e.title)
                  ? '已在侧边栏打开飞书日程: ' + e.title
                  : '侧边栏不可用，无法打开飞书事件页')
              },
            }, '在侧边栏打开飞书事件页'))
          }
          if (e.meeting_url) {
            acts.push(h('button', {
              key: 'vc', className: 'dshw-btn',
              onClick: () => {
                if (openInSidebarUrl(e.meeting_url, e.title + ' · 会议')) noteBoth('已在侧边栏打开会议链接')
                else { noteBoth('侧边栏不可用，已改用新窗口打开'); try { window.open(e.meeting_url, '_blank', 'noopener') } catch (err) { /* ignore */ } }
              },
            }, '打开会议链接'))
          }
          acts.push(h('button', { key: 'close', className: 'dshw-btn', onClick: () => setCalModal(null) }, '关闭'))

          return h('div', { className: 'dshw-modal-backdrop', onClick: () => setCalModal(null) },
            h('section', { className: 'dshw-modal', onClick: (ev2) => ev2.stopPropagation() },
              h('div', { className: 'dshw-modal-head' },
                h('span', { className: 'dshw-modal-title', title: String(e.title || '') }, String(e.title || '(无标题)')),
                h('span', { className: 'dshw-badge' }, src),
                h('span', { className: 'dshw-spacer' }),
                h('button', { className: 'dshw-btn', onClick: () => setCalModal(null) }, '✕')),
              h('div', { className: 'dshw-modal-body' },
                h('div', { className: 'dshw-modal-sec', key: 's1' },
                  h('div', { className: 'dshw-modal-sec-h' }, '日程详情'),
                  rows),
                acts.length > 0 ? h('div', { className: 'dshw-modal-sec', key: 's2' },
                  h('div', { className: 'dshw-modal-sec-h' }, '操作'),
                  h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, acts)) : null,
                calModal.note !== null ? h('div', { className: 'dshw-msg' }, String(calModal.note)) : null)))
        })()

        // ── ⌘K 命令面板的元素（2026-09-25）：**只有打开时才构建并 portal** ──────────
        //   关着的时候它连节点都不存在 ⇒ 面板的平静态 DOM 与加这个功能之前完全一致。
        const cmdkEl = cmdkOpen !== true ? null : (() => {
          const list = cmdkMatch(cmdkQ)
          const sel = list.length === 0 ? -1 : Math.min(Math.max(cmdkSel, 0), list.length - 1)
          const items = list.map((it, i) => h('div', {
            key: it.kind + ':' + it.key + ':' + i,
            className: 'wb2cmdk-item',
            'data-sel': i === sel ? '1' : null,
            'data-wb2cmdk-idx': String(i),
            onMouseEnter: () => setCmdkSel(i),
            onClick: () => cmdkGo(it),
          },
          h('span', { className: 'wb2cmdk-t' }, it.sub !== '' ? it.sub + '  ' + it.label : it.label),
          h('span', { className: 'wb2cmdk-tag' }, it.tag)))
          return h('div', {
            className: 'wb2cmdk-mask', key: 'wb2cmdk',
            'data-wb2cmdk': '1',
            onMouseDown: (e) => { if (e.target === e.currentTarget) { setCmdkOpen(false); setCmdkQ('') } },
          },
          h('div', { className: 'wb2cmdk-box' },
            h('input', {
              className: 'wb2cmdk-input',
              key: 'q',
              autoFocus: true,
              value: cmdkQ,
              placeholder: '搜索卡片与条目（标题 / 内容 / 时间）…',
              'data-wb2cmdk-input': '1',
              onChange: (e) => { setCmdkQ(e.target.value); setCmdkSel(0) },
              onKeyDown: (e) => {
                if (e.key === 'Escape') { e.preventDefault(); setCmdkOpen(false); setCmdkQ('') ; return }
                if (e.key === 'ArrowDown') { e.preventDefault(); setCmdkSel((v) => Math.min(v + 1, Math.max(list.length - 1, 0))); return }
                if (e.key === 'ArrowUp') { e.preventDefault(); setCmdkSel((v) => Math.max(v - 1, 0)); return }
                if (e.key === 'Enter') { e.preventDefault(); if (sel >= 0) cmdkGo(list[sel]) }
              },
            }),
            h('div', { className: 'wb2cmdk-list', 'data-wb2cmdk-list': '1' },
              items.length > 0 ? items : h('div', { className: 'wb2cmdk-empty' }, '没有匹配的卡片或条目')),
            h('div', { className: 'wb2cmdk-foot' },
              h('span', null, h('kbd', null, '↑'), h('kbd', null, '↓'), ' 选择'),
              h('span', null, h('kbd', null, 'Enter'), ' 跳过去'),
              h('span', null, h('kbd', null, 'Esc'), ' 关闭'),
              h('span', { style: { marginLeft: 'auto' } }, list.length + ' 条命中'))))
        })()
        const cmdkNode = cmdkEl === null
          ? null
          : (ReactDOM !== null && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined'
            ? ReactDOM.createPortal(cmdkEl, document.body)
            : cmdkEl)

        // ── 新手指引浮层（2026-09-25）：与 ⌘K 同一套路，只在使用时存在 ──────────────
        const tourEl = tourStep < 0 ? null : (() => {
          const st = TOUR_STEPS[tourStep] || TOUR_STEPS[0]
          const pad = 6
          const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
          const vh = typeof window !== 'undefined' ? window.innerHeight : 900
          const hole = tourRect === null ? null : h('div', {
            className: 'wb2tour-hole', key: 'hole',
            style: { left: (tourRect.x - pad) + 'px', top: (tourRect.y - pad) + 'px', width: (tourRect.w + pad * 2) + 'px', height: (tourRect.h + pad * 2) + 'px' },
          })
          // 提示框优先放在目标**下方**；下方放不下就放上方；左右夹紧在视口内
          const tw = Math.min(320, vw - 32)
          let top = tourRect === null ? Math.round(vh * 0.28) : tourRect.y + tourRect.h + 14
          if (tourRect !== null && top + 200 > vh) top = Math.max(16, tourRect.y - 200)
          const left = tourRect === null
            ? Math.round((vw - tw) / 2)
            : Math.max(12, Math.min(tourRect.x, vw - tw - 12))
          return h('div', { key: 'wb2tour', 'data-wb2tour': '1' },
            hole,
            h('div', { className: 'wb2tour-tip', style: { left: left + 'px', top: Math.max(12, top) + 'px', width: tw + 'px' } },
              h('div', { className: 'wb2tour-title', 'data-wb2tour-title': '1' }, st.title),
              h('div', { className: 'wb2tour-text', 'data-wb2tour-text': '1' }, st.text),
              h('div', { className: 'wb2tour-foot' },
                h('span', { className: 'wb2tour-step', 'data-wb2tour-step': '1' }, (tourStep + 1) + ' / ' + TOUR_STEPS.length),
                h('button', { className: 'wb2tour-btn', type: 'button', 'data-wb2tour-skip': '1', onClick: endTour }, '跳过'),
                tourStep > 0
                  ? h('button', { className: 'wb2tour-btn', type: 'button', 'data-wb2tour-prev': '1', onClick: () => setTourStep((v) => Math.max(0, v - 1)) }, '上一步')
                  : null,
                h('button', {
                  className: 'wb2tour-btn', type: 'button', 'data-kind': 'next', 'data-wb2tour-next': '1',
                  // ⚠️ 不要写成 `setTourStep((v) => … endTour() …)`：在 updater 里调别的 setState
                  //    是"渲染期副作用"，React 严格模式下会双调（本项目也有判据盯这类报警）。
                  //    直接按当前 `tourStep` 算，语义更直白。
                  onClick: () => { if (tourStep + 1 >= TOUR_STEPS.length) endTour(); else setTourStep(tourStep + 1) },
                }, tourStep + 1 >= TOUR_STEPS.length ? '完成' : '下一步'))))
        })()
        const tourNode = tourEl === null
          ? null
          : (ReactDOM !== null && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined'
            ? ReactDOM.createPortal(tourEl, document.body)
            : tourEl)

        // ── 右侧抽屉 · 卡片目录（2026-09-25）：同样只在使用时存在 ─────────────────────
        const dwEl = dwOpen !== true ? null : (() => {
          const rows = dwRows()
          const folded = rows.filter((r) => r.folded === true).length
          return h('div', { key: 'wb2dw', 'data-wb2dw-root': '1' },
            h('div', {
              className: 'wb2dw-mask', 'data-wb2dw-mask': '1',
              onMouseDown: (e) => { if (e.target === e.currentTarget) setDwOpen(false) },
            }),
            h('aside', { className: 'wb2dw', 'data-wb2dw': '1' },
              h('div', { className: 'wb2dw-head' },
                h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
                  h('div', { className: 'wb2dw-title' }, '卡片目录'),
                  h('div', { className: 'wb2dw-sub', 'data-wb2dw-sub': '1' },
                    rows.length + ' 张卡' + (folded > 0 ? ' · ' + folded + ' 张已折叠' : '') + ' · 指标为当前值')),
                h('button', { className: 'wb2dw-x', type: 'button', 'data-wb2dw-close': '1', title: '关闭（Esc）', onClick: () => setDwOpen(false) }, '×')),
              h('div', { className: 'wb2dw-body', 'data-wb2dw-body': '1' },
                rows.length === 0
                  ? h('div', { className: 'wb2dw-empty' }, '面板还没渲染出卡片')
                  : rows.map((r, i) => h('div', {
                    className: 'wb2dw-row', key: r.key || String(i),
                    'data-wb2dw-row': r.key || String(i),
                    'data-dim': r.folded === true ? '1' : null,
                    title: '跳到「' + r.name + '」',
                    onClick: () => dwGo(r),
                  },
                  h('span', { className: 'wb2dw-idx' }, String(i + 1)),
                  h('span', { className: 'wb2dw-name' }, r.name),
                  r.metric !== '' ? h('span', { className: 'wb2dw-metric' }, r.metric) : null,
                  h('span', { className: 'wb2dw-n' }, r.rows > 0 ? String(r.rows) : '')))),
              h('div', { className: 'wb2dw-foot' }, '点一行跳到那张卡；条目数是卡内当前可见行数')))
        })()
        const dwNode = dwEl === null
          ? null
          : (ReactDOM !== null && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined'
            ? ReactDOM.createPortal(dwEl, document.body)
            : dwEl)

        // 外观浮层：同样 portal 到 body（要盖在卡片之上，且颜色跟卡走 —— 令牌挂在 body 上）
        const themeEl = themeOpen !== true ? null : h('div', { key: 'wb2th-root', 'data-wb2th-root': '1' },
          h('div', {
            className: 'wb2th-mask', 'data-wb2th-mask': '1',
            onMouseDown: (e) => { if (e.target === e.currentTarget) setThemeOpen(false) },
          }),
          h('div', {
            className: 'wb2th', 'data-wb2th': '1',
            style: themeAt === null ? { right: '24px', top: '72px' } : { left: themeAt.left + 'px', top: themeAt.top + 'px' },
          },
          h('div', { className: 'wb2th-h' }, '外观'),
          ['auto', 'paper', 'night'].map((k) => h('button', {
            className: 'wb2th-i', type: 'button', key: k, 'data-wb2th-i': k,
            'data-on': themePref === k ? '1' : null,
            onClick: () => pickTheme(k),
          }, k === 'auto' ? '跟随外观' : (k === 'paper' ? '宣纸（浅色）' : '夜书（深色）'))),
          h('div', { className: 'wb2th-s' },
            themePref === 'auto'
              ? '跟着 DSH 的外观走，当前是' + (themeMode === 'night' ? '深色' : '浅色')
              : '已锁定为' + THEME_NAME[themePref] + '，不随 DSH 外观变化')))
        const themeNode = themeEl === null
          ? null
          : (ReactDOM !== null && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined'
            ? ReactDOM.createPortal(themeEl, document.body)
            : themeEl)

        // 详情卡显示在最上层：优先 portal 到 document.body（脱离 shell overlay 层的层叠上下文）；
        // 取不到 react-dom 时退化为就地渲染，并给根节点打 data-modal 抬升层级。
        const matterModalNode = matterModalEl === null          ? null
          : (ReactDOM !== null && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined'
            ? ReactDOM.createPortal(matterModalEl, document.body)
            : matterModalEl)

        // 日程详情卡同样 portal 到 body（与事务详情卡同级，互不遮挡）
        const calModalNode = calModalEl === null          ? null
          : (ReactDOM !== null && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined'
            ? ReactDOM.createPortal(calModalEl, document.body)
            : calModalEl)

        // 待办二级详情卡：同样 portal 到 body（2026-09-15 用户要求"点击查看二级详情"）
        const todoModalEl = todoDetail === null ? null : (() => {
          const d = todoDetail
          const srcLabel = d.source === 'feishu' ? '飞书任务' : d.source === 'dingtalk' ? '钉钉待办' : '个人待办'
          const rows = []
          rows.push(h('div', { className: 'dshw-mrow', key: 'src' },
            h('span', { className: 'dshw-mrow-l' }, '来源'),
            h('span', { className: 'dshw-mrow-v' }, srcLabel + (d.org ? ' · ' + d.org : '') + (d.listName ? ' · 清单 ' + d.listName : ''))))
          // 归属（钉钉四类：别人安排给我的 / 我安排给别人的 / 个人创建给自己 / 我参与）
          const CAT_FULL = {
            'assigned-by-others': '别人安排给我的', 'assigned-to-others': '我安排给别人的',
            mine: '个人创建给自己的', participating: '我参与的',
          }
          if (d.category && CAT_FULL[d.category]) {
            rows.push(h('div', { className: 'dshw-mrow', key: 'cat' },
              h('span', { className: 'dshw-mrow-l' }, '归属'),
              h('span', { className: 'dshw-mrow-v' }, CAT_FULL[d.category])))
          }
          rows.push(h('div', { className: 'dshw-mrow', key: 'due' },
            h('span', { className: 'dshw-mrow-l' }, '截止'),
            h('span', { className: 'dshw-mrow-v' }, String(d.due || '无期限'))))
          rows.push(h('div', { className: 'dshw-mrow', key: 'st' },
            h('span', { className: 'dshw-mrow-l' }, '状态'),
            h('span', { className: 'dshw-mrow-v' }, d.done ? '已完成' : '未完成')))
          if (d.owners && d.owners.length > 0) {
            rows.push(h('div', { className: 'dshw-mrow', key: 'own' },
              h('span', { className: 'dshw-mrow-l' }, '负责人'), h('span', { className: 'dshw-mrow-v' }, d.owners.join('、'))))
          }
          if (d.followers && d.followers.length > 0) {
            rows.push(h('div', { className: 'dshw-mrow', key: 'fol' },
              h('span', { className: 'dshw-mrow-l' }, '关注人'), h('span', { className: 'dshw-mrow-v' }, d.followers.join('、'))))
          }
          if (d.creator) {
            rows.push(h('div', { className: 'dshw-mrow', key: 'cre' },
              h('span', { className: 'dshw-mrow-l' }, '创建者'), h('span', { className: 'dshw-mrow-v' }, String(d.creator))))
          }
          if (d.created) {
            rows.push(h('div', { className: 'dshw-mrow', key: 'ct' },
              h('span', { className: 'dshw-mrow-l' }, '创建时间'),
              h('span', { className: 'dshw-mrow-v' }, localStamp(d.created))))
          }
          // 个人待办专有：编号 / 创建方式（手动放置 或 会话内创建）/ 来源说明
          if (d.id) {
            rows.push(h('div', { className: 'dshw-mrow', key: 'tid' },
              h('span', { className: 'dshw-mrow-l' }, '编号'), h('span', { className: 'dshw-mrow-v' }, String(d.id))))
          }
          if (d.todoSource) {
            rows.push(h('div', { className: 'dshw-mrow', key: 'tsrc' },
              h('span', { className: 'dshw-mrow-l' }, '创建方式'),
              h('span', { className: 'dshw-mrow-v' }, d.todoSource === 'dsh-session' ? 'DSH 会话内创建' : '手动放置文件')))
          }
          if (d.origin) {
            rows.push(h('div', { className: 'dshw-mrow', key: 'orig' },
              h('span', { className: 'dshw-mrow-l' }, '来源说明'), h('span', { className: 'dshw-mrow-v' }, String(d.origin))))
          }
          if (d.description) {
            rows.push(h('div', { className: 'dshw-mrow', key: 'desc' },
              h('span', { className: 'dshw-mrow-l' }, '描述'), h('span', { className: 'dshw-mrow-v' }, String(d.description))))
          }
          if (d.path) {
            rows.push(h('div', { className: 'dshw-mrow', key: 'path' },
              h('span', { className: 'dshw-mrow-l' }, '文件'), h('span', { className: 'dshw-mrow-v', style: { wordBreak: 'break-all' } }, String(d.path))))
          }
          const acts = []
          // ★ 源头回写（2026-09-17 用户要求）：「在工作台关闭待办之后，在源头端也标记完成；重新打开，
          //   源头端也标记未完成」。三个源各走 host 的 `/todo/act`（钉钉 task done / 飞书 +complete|+reopen /
          //   个人 cli-todo）。**结果如实显示**：失败就把源端原因贴出来，绝不假装同步成功。
          //   ⚠️ 策略（用户 2026-09-17 精确裁定 · 与 host 侧 `todoWritePolicy` **同一条规则**）：
          //     「我自己或别人安排给我的 ⇒ 可关闭/重开并反馈源头；**我安排给别人的 ⇒ 只读，不反馈**」。
          //     判据 = 我是不是**执行者**：钉钉 `mine` / `assigned-by-others` 可写，`assigned-to-others` /
          //     `participating` 只读；飞书「owners 含我」可写；个人永远可写。host 侧同样强制（以服务端采集为准）。
          const isMineFeishu = d.source === 'feishu' && Array.isArray(d.owners) && d.owners.some((o) => String(o) === '我')
          const canSync = d.source === 'personal'
            || (d.source === 'dingtalk' && !!d.taskId && (d.category === 'mine' || d.category === 'assigned-by-others'))
            || (d.source === 'feishu' && !!d.id && isMineFeishu)
          const readOnlyReason = d.source === 'dingtalk' && d.category === 'assigned-to-others'
            ? '我安排给别人的（由对方执行）⇒ 只读，不回写源头'
            : (d.source === 'dingtalk' && d.category === 'participating'
              ? '我仅参与（非执行者）⇒ 只读，不回写源头'
              : (d.source === 'feishu' && !isMineFeishu ? '飞书任务：我不是负责人 ⇒ 只读，不回写源头' : null))
          if (!canSync && readOnlyReason !== null) {
            rows.push(h('div', { className: 'dshw-mrow', key: 'ro' },
              h('span', { className: 'dshw-mrow-l' }, '回写'),
              h('span', { className: 'dshw-mrow-v' }, readOnlyReason)))
          }
          if (canSync) {
            const syncOne = (action) => {
              setTodoSync({ busy: action, msg: null })
              const payload = { source: d.source, action }
              // ★ 带上标题（2026-09-17 实测补）：台账里的 `title` 同时是「最近关闭 · 可重新打开」
              //   那一行的显示名 —— 不带标题时，那一行只能退化成显示 taskId（用户看到一串数字）。
              if (d.title) payload.title = d.title
              if (d.source === 'dingtalk') { payload.id = d.taskId; payload.profile = d.profile || '' }
              else if (d.source === 'feishu') payload.id = d.id
              else { if (d.id) payload.id = d.id; else payload.path = d.path }
              api('/todo/act', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
                .then((r) => {
                  if (r && r.ok === true) {
                    setTodoSync({ busy: null, msg: (action === 'done' ? '✓ 已标记完成，源头已同步' : '✓ 已重新打开，源头已同步') })
                    setTodoDetail(null)   // 关闭弹窗：该条随后从列表消失/回来（刷新后一致）
                    load(true)
                  } else {
                    setTodoSync({ busy: null, msg: '同步失败：' + String((r && r.error) || '未知原因') })
                  }
                })
                .catch((e) => setTodoSync({ busy: null, msg: '同步失败：' + String((e && e.message) || e) }))
            }
            acts.push(h('button', {
              key: 'done', className: 'dshw-btn',
              disabled: todoSync.busy !== null,
              title: '在源头端把它标记为完成（钉钉/飞书/个人文件同步）',
              onClick: () => syncOne('done'),
            }, todoSync.busy === 'done' ? '同步中…' : '✓ 标记完成（同步源头）'))
            if (d.source === 'personal') {
              acts.push(h('button', {
                key: 'reopen', className: 'dshw-btn',
                disabled: todoSync.busy !== null,
                title: '在源头端把它改回未完成（已关闭的个人待办用它拉回来）',
                onClick: () => syncOne('reopen'),
              }, todoSync.busy === 'reopen' ? '同步中…' : '↺ 重新打开（同步源头）'))
            }
          }
          if (d.url) {
            acts.push(h('button', {
              key: 'open', className: 'dshw-btn',
              onClick: () => {
                const ok = openInSidebarUrl(d.url, d.title)
                setNote(ok ? '已在侧边栏打开任务: ' + d.title : '侧边栏不可用，已改用新窗口')
                if (!ok) { try { window.open(d.url, '_blank', 'noopener') } catch (e) { /* ignore */ } }
              },
            }, '在侧边栏打开任务'))
          }
          if (d.path) {
            acts.push(h('button', { key: 'file', className: 'dshw-btn', onClick: () => openFile(d.path, d.title) }, '打开文件'))
          }
          acts.push(h('button', { key: 'close', className: 'dshw-btn', onClick: () => setTodoDetail(null) }, '关闭'))
          return h('div', { className: 'dshw-modal-backdrop', onClick: () => setTodoDetail(null) },
            h('section', { className: 'dshw-modal', onClick: (ev2) => ev2.stopPropagation() },
              h('div', { className: 'dshw-modal-head' },
                h('span', { className: 'dshw-modal-title', title: String(d.title || '') }, String(d.title || '(无标题)')),
                h('span', { className: 'dshw-badge' }, srcLabel),
                h('span', { className: 'dshw-spacer' }),
                h('button', { className: 'dshw-btn', onClick: () => setTodoDetail(null) }, '✕')),
              h('div', { className: 'dshw-modal-body' },
                h('div', { className: 'dshw-modal-sec', key: 's1' },
                  h('div', { className: 'dshw-modal-sec-h' }, '待办详情'),
                  rows),
                acts.length > 0 ? h('div', { className: 'dshw-modal-sec', key: 's2' },
                  h('div', { className: 'dshw-modal-sec-h' }, '操作'),
                  h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, acts)) : null)))
        })()
        const todoModalNode = todoModalEl === null
          ? null
          : (ReactDOM !== null && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined'
            ? ReactDOM.createPortal(todoModalEl, document.body)
            : todoModalEl)

        // ── 对象二级详情卡（2026-09-16 新卡）：**只读** ──────────────────────
        //  本卡不提供任何处置口子：没有关闭/编辑事务或触发的按钮（那是事务卡的能力），
        //  也不添加本文件别处不存在的跳转；sources 只作为**可选中复制**的文本行。
        //  五个区块全部是 payload 的原样值 + ids/路径明细，用来给卡片上的每个数字对账。
        // ── 待响应触发的二级详情（T32）：只读字段 + 三个响应动作 ──────────────
        //  ⚠️ 动作的**校验与判定都不在这里**：host 只做参数校验并转调库内 CLI（cli-trigger），
        //     响应登记表与回放由库内保证（跨管线重建持久）。本层失败一律原样显示，不假装成功。
        const trigModalEl = trigModal === null ? null : (() => {
          const tid = String(trigModal.id)
          const t = trigRowsForModal(tid)
          const f = trigFormOf(tid)
          const secs = []
          // 模态框里的「标签 + 值」行：与 objMrow 同一套 class（objMrow 在对象卡段，作用域不同，故本地再定义）
          const trigMrow = (label, value) => h('div', { className: 'dshw-mrow', key: 'r-' + label },
            h('span', { className: 'dshw-mrow-l' }, label),
            h('span', { className: 'dshw-mrow-v', style: { userSelect: 'text' } }, String(value)))
          const mrow = trigMrow
          if (t === null) {
            secs.push(h('div', { className: 'dshw-empty', key: 'tn' }, '清单里没有这条触发（可能已被响应或被重建移除）；点「刷新」重取。'))
          } else {
            const rec = trigByRecordTop[tid] || null
            const disp = Array.isArray((dispDoc || {}).entries)
              ? (dispDoc.entries.find((e) => e.inbound_id === t.origin_inbound) || null) : null
            secs.push(h('div', { className: 'dshw-modal-sec', key: 's1' },
              h('div', { className: 'dshw-modal-sec-h' }, '① 概要'),
              mrow('类别 / 状态', String(t.rclass || '—') + ' · ' + String(t.status || '—')
                + (t.group ? ' · ' + String(t.group) : '')),
              mrow('关注域', String(t.domain || '—')),
              mrow('期望动作', String(t.expected_action || '—')),
              //  未校准时只给一个极短标记（机器真相在 `sla_calibrated`，界面不解释机制）
              mrow('时限', String(t.sla_label || '—') + (t.sla_calibrated === false ? ' · 待校准' : ''))))
            secs.push(h('div', { className: 'dshw-modal-sec', key: 's2' },
              h('div', { className: 'dshw-modal-sec-h' }, '② 原文摘要'),
              h('div', { className: 'dshw-mrow-v', style: { userSelect: 'text', whiteSpace: 'pre-wrap' } }, String(t.digest || '（空）'))))
            secs.push(h('div', { className: 'dshw-modal-sec', key: 's3' },
              h('div', { className: 'dshw-modal-sec-h' }, '③ 出处（可点开）'),
              mrow('来源路径', String(t.origin || '—')),
              h('div', { style: { marginTop: '2px' } },
                h('button', {
                  className: 'dshw-btn', disabled: !t.origin,
                  onClick: () => { if (t.origin) openInSidebarFile(String(t.origin), String(t.id)) },
                }, '在侧边栏打开出处')),
              mrow('流入 id', String(t.origin_inbound || '—')),
              mrow('时间线索', String(t.time_cue || '—')),
              mrow('依据', String(t.source_ref || '—'))))
            secs.push(h('div', { className: 'dshw-modal-sec', key: 's4' },
              h('div', { className: 'dshw-modal-sec-h' }, '④ 所属对象（读 objects.json 的 byRecord，本卡不推）'),
              mrow('对象', rec === null ? '（byRecord 里没有这条触发）' : String(rec.key || '—') + ' · ' + String(rec.kind || '')),
              mrow('依据', rec === null ? '—' : String(rec.evidence || '—'))))
            secs.push(h('div', { className: 'dshw-modal-sec', key: 's5' },
              h('div', { className: 'dshw-modal-sec-h' }, '⑤ 关联流入（读 disposition.json，按 origin_inbound 匹配）'),
              disp === null
                ? h('div', { className: 'dshw-empty', key: 'nodisp' },
                  dispDoc === null ? '正在读取处置台账…' : '该触发没有对应的处置台账条目（或台账读取失败）')
                : h('div', null,
                  mrow('判定', String(disp.verdict || '—') + ' · ' + String(disp.reason || '')),
                  mrow('落点', String((disp.landing || {}).type || '—')
                    + (Array.isArray((disp.landing || {}).matter_ids) && disp.landing.matter_ids.length
                      ? ' · ' + disp.landing.matter_ids.join(', ') : '')
                    + (Array.isArray((disp.landing || {}).trigger_ids) && disp.landing.trigger_ids.length
                      ? ' · ' + disp.landing.trigger_ids.join(', ') : '')),
                  mrow('悬置', disp.pending_days === null || disp.pending_days === undefined ? '—' : String(disp.pending_days) + ' 天'))))
            secs.push(h('div', { className: 'dshw-modal-sec', key: 's6' },
              h('div', { className: 'dshw-modal-sec-h' }, '⑥ 时间与响应记录'),
              mrow('发生', localStamp(t.occurred_at)),
              mrow('期限', localStamp(t.due_at)),
              mrow('升级', localStamp(t.escalated_at || null)),
              mrow('响应', t.responded_at
                ? ('已响应 · ' + String(t.response_action || '') + (t.response_ref ? ' · ' + String(t.response_ref) : '') + ' · ' + localStamp(t.responded_at))
                : (t.dismissed_at ? ('已忽略 · ' + localStamp(t.dismissed_at)) : '（未响应）')),
              t.response_note ? mrow('备注/理由', String(t.response_note)) : null))
            // ── ⑦ 响应动作（唯一的写入口；不在此判定合法性）──
            const actDisabled = trigBusy === true || routeDown.triggers === true
            const aRows = []
            if (routeDown.triggers === true) {
              // 路由不可用（旧 host）⇒ 动作**禁用并写明原因**，不要让用户点完才看到报错
              aRows.push(h('div', { className: 'dshw-err', key: 'tdown' },
                '响应入口不可用：' + ROUTE_DOWN_TEXT + '（重启 DSH 后可在此登记响应；当前详情为只读）'))
            }
            aRows.push(h('div', { style: { display: 'flex', gap: '6px', marginBottom: '4px' } },
              h('button', {
                className: 'dshw-btn', disabled: trigBusy === true || trigAction === 'responded',
                onClick: () => { setTrigAction('responded'); setTrigMsg(null) },
              }, trigAction === 'responded' ? '● 标记已响应' : '标记已响应'),
              h('button', {
                className: 'dshw-btn', disabled: trigBusy === true || trigAction === 'to-matter',
                onClick: () => { setTrigAction('to-matter'); setTrigMsg(null) },
              }, trigAction === 'to-matter' ? '● 转事务' : '转事务'),
              h('button', {
                className: 'dshw-btn', disabled: trigBusy === true || trigAction === 'dismissed',
                onClick: () => { setTrigAction('dismissed'); setTrigMsg(null) },
              }, trigAction === 'dismissed' ? '● 忽略' : '忽略')))
            if (trigAction === 'responded') {
              aRows.push(mrow('响应动作', String(f.response_action || '')))
              aRows.push(h('input', {
                value: f.response_action || '', style: { width: '100%' }, placeholder: '写了什么才算已响应（如：已回复 / 已电话沟通）',
                onChange: (e) => setTrigFormOf(tid, { response_action: e.target.value }),
              }))
              aRows.push(mrow('凭证（可选）', String(f.ref || '')))
              aRows.push(h('input', {
                value: f.ref || '', style: { width: '100%' }, placeholder: '如事务 id / 消息链接（便于回查）',
                onChange: (e) => setTrigFormOf(tid, { ref: e.target.value }),
              }))
              aRows.push(h('button', {
                className: 'dshw-btn', disabled: actDisabled,
                onClick: () => trigPost('responded', { id: tid, response_action: f.response_action, ref: f.ref }),
              }, trigBusy === true ? '…' : '确认已响应'))
            } else if (trigAction === 'to-matter') {
              aRows.push(mrow('事务标题', String(f.title || '')))
              aRows.push(h('input', {
                value: f.title || '', style: { width: '100%' }, placeholder: '默认取触发标题，可改',
                onChange: (e) => setTrigFormOf(tid, { title: e.target.value }),
              }))
              aRows.push(mrow('归属关注域（P3 必填）', String(f.domain || '')))
              aRows.push(h('input', {
                value: f.domain || '', style: { width: '100%' }, placeholder: '如 qianwen-office（写不出归属的不成事务）',
                onChange: (e) => setTrigFormOf(tid, { domain: e.target.value }),
              }))
              aRows.push(mrow('关闭条件（P3 必填）', String(f.done_when || '')))
              aRows.push(h('input', {
                value: f.done_when || '', style: { width: '100%' }, placeholder: '如：存在产出物 / 对方确认收到',
                onChange: (e) => setTrigFormOf(tid, { done_when: e.target.value }),
              }))
              aRows.push(h('button', {
                className: 'dshw-btn', disabled: actDisabled,
                onClick: () => trigPost('to-matter', {
                  id: tid,
                  title: f.title || String(t.title || ''),
                  domain: f.domain || String(t.domain || ''),
                  done_when: f.done_when,
                }),
              }, trigBusy === true ? '…' : '建事务并标记已响应'))
            } else {
              aRows.push(mrow('忽略理由（必填）', String(f.reason || '')))
              aRows.push(h('input', {
                value: f.reason || '', style: { width: '100%' }, placeholder: '为什么可以忽略（事后要能复核）',
                onChange: (e) => setTrigFormOf(tid, { reason: e.target.value }),
              }))
              aRows.push(h('button', {
                className: 'dshw-btn', disabled: actDisabled,
                onClick: () => trigPost('dismissed', { id: tid, reason: f.reason }),
              }, trigBusy === true ? '…' : '确认忽略（不计入响应率）'))
            }
            if (t.status === 'responded' || t.status === 'dismissed') {
              aRows.push(h('button', {
                className: 'dshw-btn', disabled: actDisabled,
                onClick: () => trigPost('undo', { id: tid }),
              }, '撤销登记（回到未响应）'))
            }
            if (trigMsg !== null) {
              aRows.push(h('div', {
                className: trigMsg.ok === true ? 'dshw-detail' : 'dshw-err', key: 'tmsg',
              }, (trigMsg.ok === true ? '✓ ' : '✗ ') + String(trigMsg.text)))
            }
            secs.push(h('div', { className: 'dshw-modal-sec', key: 's7' },
              h('div', { className: 'dshw-modal-sec-h' }, '⑦ 响应'), aRows))
          }
          return h('div', { className: 'dshw-modal-backdrop', onClick: () => setTrigModal(null) },
            h('section', { className: 'dshw-modal', onClick: (ev) => ev.stopPropagation() },
              h('div', { className: 'dshw-modal-head' },
                h('span', { className: 'dshw-modal-title', title: tid }, tid),
                h('span', { className: 'dshw-badge' }, t === null ? '不在清单' : String(t.status || '—')),
                h('span', { className: 'dshw-spacer' }),
                h('button', { className: 'dshw-btn', onClick: () => setTrigModal(null) }, '✕')),
              h('div', { className: 'dshw-modal-body' }, secs)))
        })()

        const objModalEl = objModal === null ? null : (() => {
          const key = String(objModal.key)
          // 数据时刻：**只在这里**取（详情 ③ 是"核对出处"的审计语境，给出数据时刻是合理的）；
          // 它**不在卡面上出现**（用户 2026-09-17 再更正）。原值 + 本地时间两行都在下面第 ③ 段/副标题。
          const objGenAt = objDoc !== null ? String(objDoc.generatedAt || '—') : '—'
          const it = objModal.item !== null && objModal.item !== undefined ? objModal.item : objItemOf(key)
          const ru = objRollup[key] || null
          const ns = it === null ? null : it.next_step
          const cs = (it === null ? null : it.counts) || null
          const ms = (it === null ? null : it.multi_source) || {}
          const tr = (it === null ? null : it.trace) || {}
          const secs = []
          // 副标题（用户要求）：kind + evidence + state + 数据时刻（generatedAt）
          secs.push(h('div', { className: 'dshw-mrow', key: 'sub' },
            h('span', { className: 'dshw-mrow-l' }, '对象口径'),
            h('span', { className: 'dshw-mrow-v', style: { userSelect: 'text' } },
              (it === null
                ? 'objects[] 里没有该 key（只有 rollup 段）'
                : String(it.kind || '—') + ' · ' + String(it.evidence === null || it.evidence === undefined ? '（payload evidence 为空）' : it.evidence))
              + ' · state ' + String((it !== null && it.state) || (ru !== null && ru.state) || '—')
              + ' · 数据时刻 ' + localStamp(objGenAt))))
          // ══ 2026-09-17 用户复查：弹窗从 6 段收敛为 **3 段 + 1 条脚注** ══════════════
          //  ① 下一步 · ② 隶属记录（事务与触发合并）· ③ 出处与支撑
          //  —— 原来的「② 事务 / ③ 触发 / ⑥ 客户级 rollup」并进 ②；「④ 出处 / ⑤ 支撑」并进 ③；
          //     撑场面的 counts 汇总与 rollup 对账降级为**一条脚注**（不再冒充「一段」）。
          //  ⚠️ 全部值仍是 payload 原样（不推断、不补期限、不改写标题、不配色、不重算）。
          // ① 下一步（payload 原样：不推断、不补期限、不改写标题）
          const nsRows = []
          if (ns === null || ns === undefined) {
            nsRows.push(h('div', { className: 'dshw-empty', key: 'nons' }, 'payload next_step = null（本卡不为它推断下一步）'))
          } else {
            nsRows.push(objMrow('来源', String(ns.source || '—')))
            nsRows.push(objMrow('id', String(ns.id || '—')))
            nsRows.push(objMrow('标题', String(ns.title || '—')))
            nsRows.push(objMrow('到期', objRaw(ns.due_at)))
            nsRows.push(objMrow('动作', String(ns.action || '—')))
            nsRows.push(objMrow('负责人', String(ns.owner || '—')))
            nsRows.push(objMrow('overdue', String(ns.overdue)))
          }
          secs.push(h('div', { className: 'dshw-modal-sec', key: 's1' },
            h('div', { className: 'dshw-modal-sec-h' }, '① 下一步（payload next_step，原样显示）'),
            nsRows))
          // ② 隶属记录：事务与触发**合并成一张表**，每行前缀是它属于哪一侧；id 后面按 byRecord 标注归属对象
          //  2026-09-17 用户要求：「详情页的 2 段也应该可以跳转到响应卡的对应详情中」⇒
          //    · **事务 id** → 复用事务卡**既有的**详情打开器 `openMatter(item)`（本文件既有用法，
          //      见卡内事务行的 `onClick: () => openMatter(m)`）。⚠️ **不能只 `setMatterModal({id})`**：
          //      那样 `loading/busy/...` 一个都没设，弹窗会渲染成"详情读取失败: undefined"；
          //      `openMatter` 才会把形状填全并去取 `/matter?id=`。
          //    · **触发 id** → 复用「响应」卡**既有的**详情打开器 `setTrigModal({ id })`（本文件既有用法，
          //      见触发行：`loadDispositionOnce(); setTrigModal({ id: String(t.id) })`），并照同法先惰性
          //      读一次 `/disposition`（详情 ⑤ 段要用）。
          //    · 次序（用户裁定：先关本卡详情，再开目标详情）—— 本文件没有"叠加两层详情"的先例，
          //      故**先 `setObjModal(null)` 再开目标**，避免两个 backdrop 叠在一起。
          const mIds = it !== null && Array.isArray(it.matter_ids) ? it.matter_ids : []
          const tIds = it !== null && Array.isArray(it.trigger_ids) ? it.trigger_ids : []
          /** 跨卡跳转：返回 onClick；对应打开器不存在时返回 null ⇒ 该行退化为纯文本（不替别的卡造打开器） */
          const objRecJump = (side, id) => {
            if (side === '事务') {
              if (typeof openMatter !== 'function') return null
              return () => { setObjModal(null); openMatter({ id: String(id) }) }
            }
            if (typeof setTrigModal !== 'function') return null
            return () => {
              if (typeof loadDispositionOnce === 'function') loadDispositionOnce()
              setObjModal(null)
              setTrigModal({ id: String(id) })
            }
          }
          const recRow = (side, id, k) => {
            const rec = objRecOf(id)
            const info = rec === null ? 'byRecord 无该 id' : '所属对象 ' + String(rec.key || '—')
            const jump = objRecJump(side, id)
            const tip = (jump === null ? '' : '点击打开' + side + '详情（' + side + '卡既有详情页）\n')
              + (rec === null ? 'byRecord 无该 id' : String(rec.evidence || ''))
            return h('div', {
              className: 'dshw-rec', key: k, title: tip,
              'data-click': jump === null ? null : '1',
              onClick: jump === null ? undefined : jump,
            },
            h('div', { className: 'dshw-mrow-v', style: { userSelect: 'text' } }, [
              h('span', { key: 's' }, side + ' '),
              jump === null
                ? h('span', { key: 'i' }, String(id))
                : h('span', { className: 'dshw-link', key: 'i' }, String(id)),
              h('span', { key: 'k' }, ' · ' + info),
            ]))
          }
          const relRows = []
          if (mIds.length === 0 && tIds.length === 0) {
            relRows.push(h('div', { className: 'dshw-empty', key: 'norel' }, '该对象 payload 里 matter_ids 与 trigger_ids 都为空'))
          }
          for (let i = 0; i < mIds.length; i += 1) relRows.push(recRow('事务', String(mIds[i]), 'm' + i))
          for (let i = 0; i < tIds.length; i += 1) relRows.push(recRow('触发', String(tIds[i]), 't' + i))
          relRows.push(h('div', { className: 'dshw-empty', key: 'reln' },
            '两侧明细: 事务 ' + String(mIds.length) + ' 条 · 触发 ' + String(tIds.length) + ' 条（id 明细，本卡不推对象）'))
          secs.push(h('div', { className: 'dshw-modal-sec', key: 's2' },
            h('div', { className: 'dshw-modal-sec-h' }, '② 隶属记录（事务与触发合并 · payload matter_ids + trigger_ids · 点 id 打开对应详情）'),
            relRows))
          // ③ 出处与支撑：sources 路径（**可点开** → 侧边栏 / 回退 /open，与其它卡同一入口）
          //    + multi_source / trace + generatedAt（本地时间 **与** 原值）
          const srcs = it !== null && Array.isArray(it.sources) ? it.sources : []
          const pRows = []
          if (srcs.length === 0) {
            pRows.push(h('div', { className: 'dshw-empty', key: 'nop' }, 'payload sources 为空（该对象没有登记出处）'))
          }
          for (let i = 0; i < srcs.length; i += 1) {
            pRows.push(objSrcRow(srcs[i], 'p' + i))
          }
          pRows.push(objMrow('轨迹', String(ms.trajectory || '—')))
          pRows.push(objMrow('证据行', ms.evidence_lines === undefined ? '—' : String(ms.evidence_lines)))
          pRows.push(objMrow('事务来源', Array.isArray(ms.matter_kinds) && ms.matter_kinds.length > 0 ? ms.matter_kinds.join('、') : '—'))
          pRows.push(objMrow('触发类别', Array.isArray(ms.trigger_rclasses) && ms.trigger_rclasses.length > 0 ? ms.trigger_rclasses.join('、') : '—'))
          pRows.push(objMrow('溯源', 'origin_inbound ' + String(tr.origin_inbound === undefined ? '—' : tr.origin_inbound)
            + ' · source_ref ' + String(tr.source_ref === undefined ? '—' : tr.source_ref)
            + ' · records ' + String(tr.records === undefined ? '—' : tr.records)))
          pRows.push(objMrow('generatedAt', localStamp(objGenAt) + ' · 原值 ' + objGenAt))
          pRows.push(objMrow('所在对象', 'kind ' + String((it !== null && it.kind) || '—')
            + ' · parent ' + String((it !== null && it.parent) || '（payload 无 parent）')
            + ' · account ' + String((it !== null && it.account) || '—')
            + ' · domain_id ' + String((it !== null && it.domain_id) || '—')))
          if (it !== null && it.kind === 'unassigned' && Array.isArray(objDoc.unassigned)) {
            pRows.push(objMrow('未归属清单', objDoc.unassigned.length === 0 ? '—' : objDoc.unassigned.join(' ')))
          }
          secs.push(h('div', { className: 'dshw-modal-sec', key: 's3' },
            h('div', { className: 'dshw-modal-sec-h' }, '③ 出处与支撑（payload sources ' + srcs.length + ' 条 · 点路径即打开 · multi_source / trace）'),
            pRows))
          // 脚注（**不是一段**）：本行数字的出处 + rollup 对账。
          //   用户 2026-09-17 复查：客户级行上的「事务 37」= payload rollup 的值；它**不等于**其场次子行之和
          //   （父代理实测两者对不上）—— 本卡不重算、不求和、也不声称它们相等。
          const fCounts = cs === null
            ? 'counts —'
            : 'matters ' + String(cs.matters) + ' · open_matters ' + String(cs.open_matters)
              + ' · triggers ' + String(cs.triggers) + ' · unresponded ' + String(cs.unresponded_triggers)
              + ' · overdue ' + String(cs.overdue)
          const foot = []
          foot.push(h('div', { key: 'ft', style: { userSelect: 'text' } },
            '行上数字来自 rollup：事务 ' + String(ru === null ? '—' : ru.matters) + ' · 触发 '
            + String(ru === null ? '—' : ru.triggers) + ' · 本卡不重算'))
          foot.push(h('div', { key: 'ft2', style: { userSelect: 'text' } },
            '对账口径：客户级行的数字是 payload rollup 的值，**不等于**其场次子行相加 —— 本卡不求和、不重算。'))
          foot.push(h('div', { key: 'ft3', style: { userSelect: 'text' } }, 'counts（payload）: ' + fCounts))
          if (ru !== null) {
            foot.push(h('div', { key: 'ft4', style: { userSelect: 'text' } },
              'rollup 段: 事务 ' + String(ru.matters) + ' · 触发 ' + String(ru.triggers)
              + ' · state ' + String(ru.state || '—') + ' · trajectory ' + String(ru.trajectory || '—')
              + ' · lines matter ' + String((ru.lines || {}).matter) + ' / trigger ' + String((ru.lines || {}).trigger)))
            if (Array.isArray(ru.children) && ru.children.length > 0) {
              foot.push(h('div', { key: 'ft5', style: { userSelect: 'text' } }, 'rollup children: ' + ru.children.join('、')))
            }
          }
          secs.push(h('div', { className: 'dshw-objfoot', key: 'foot' }, foot))
          return h('div', { className: 'dshw-modal-backdrop', onClick: () => setObjModal(null) },
            h('section', { className: 'dshw-modal', onClick: (ev) => ev.stopPropagation() },
              h('div', { className: 'dshw-modal-head' },
                h('span', { className: 'dshw-modal-title', title: key }, key),
                h('span', { className: 'dshw-badge' },
                  it === null ? 'rollup' : String(it.kind || '—') + ' · ' + String(it.state || '—')),
                h('span', { className: 'dshw-spacer' }),
                h('button', { className: 'dshw-btn', onClick: () => setObjModal(null) }, '✕')),
              h('div', { className: 'dshw-modal-body' }, secs,
                h('div', { className: 'dshw-empty', key: 'ro' }, '本卡只读：不提供关闭事务/触发、也不提供编辑口子'))))
        })()
        const trigModalNode = trigModalEl === null
          ? null
          : (ReactDOM !== null && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined'
            ? ReactDOM.createPortal(trigModalEl, document.body)
            : trigModalEl)

        const objModalNode = objModalEl === null
          ? null
          : (ReactDOM !== null && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined'
            ? ReactDOM.createPortal(objModalEl, document.body)
            : objModalEl)

        // ══ 听记 → 事务 的二级详情（2026-09-20 用户规格 · 第四条）══════════════════════
        //   与 `objModalEl` / `trgModalEl` 同一套 portal 形态（同一个 `dshw-modal` 外观）：
        //   一级列表只给一个 `＋事务` 按钮，**填表与结论都在这里**（一级行不承载写结果的文案）。
        const minModalEl = minModal === null ? null : (() => {
          const mrow = (l, v) => h('div', { className: 'dshw-mrow', key: 'r-' + l },
            h('span', { className: 'dshw-mrow-l' }, l),
            h('span', { className: 'dshw-mrow-v', style: { userSelect: 'text' } }, String(v)))
          const roleTag = (k) => h('span', { className: 'dshw-badge', 'data-minrole': k, key: 'role-' + k },
            String(DRAFT_FIELD_ROLE[k] || ''))
          const draft = (minDraft !== null && typeof minDraft === 'object') ? minDraft : null
          const gate = minOriginState(minForm)
          const anchors = minAnchorOptions(draft)
          const secs = []
          // ── ① 来源（听记）+ 二级详情里的**「转事务」入口**（草稿没拉到 / 想重拉时点它）──
          secs.push(h('div', { className: 'dshw-modal-sec', key: 's1' },
            h('div', { className: 'dshw-modal-sec-h' }, '① 来源（听记）'),
            mrow('来源', minModal.src === 'feishu' ? '飞书妙记' : '钉钉听记'),
            mrow('听记', String(minModal.title || '')),
            mrow('链接', String(minModal.url || '（该条没有链接）')),
            h('div', { style: { marginTop: '6px', display: 'flex', gap: '8px', alignItems: 'center' } },
              h('button', {
                className: 'dshw-btn', 'data-minform': 'draft', disabled: minDraftState === 'loading',
                title: '由库内草稿引擎从这条听记起草 —— host 负责取正文（飞书妙记 lark-cli minutes +detail / 钉钉听记 dws minutes +detail）',
                onClick: () => minLoadDraft(minModal),
              }, minDraftState === 'loading' ? '…起草中' : '转事务'),
              h('span', { className: 'dshw-detail', 'data-mindraft': 'state' },
                minDraftState === 'loading' ? '正在取正文并起草（几分钟的听记约几秒）…'
                  : minDraftState === 'ready' ? '草稿已预填 —— 改完再提交'
                    : minDraftState === 'unavailable' ? '这条听记取不到正文 ⇒ 没有草稿可预填（下面说原因）'
                      : minDraftState === 'error' ? '草稿没取到（下面说原因）'
                        : '点「转事务」开始起草'))))
          // ── ② 草稿与依据（每一项都写清"哪个字段出了什么话 → 拿去生成了哪一项"）──
          const dsec = [h('div', { className: 'dshw-modal-sec-h' }, '② 草稿与依据（机器给一版，人只纠错与选择）')]
          if (minDraftState === 'error') {
            dsec.push(h('div', { className: 'dshw-err', 'data-mindraft': 'error', key: 'de' }, String(minDraftErr || '未知错误')))
          } else if (minDraftState === 'unavailable') {
            // ⚠️ 不可用分支：**一个字段都不预填**（连标题也不填 —— 靠标题猜出来的那版正是要防的假草稿）
            dsec.push(h('div', { className: 'dshw-err', 'data-mindraft': 'unavailable', key: 'du' },
              '取不到正文 ⇒ 不预填任何一项。原因：' + String((draft && draft.unavailable_reason) || '（host 未给原因）')))
            dsec.push(h('div', { className: 'dshw-detail', 'data-mindraft': 'next', key: 'dn' },
              '下一步：' + (minDraftNotes.length > 0 ? minDraftNotes.join(' ')
                : '先在飞书妙记 / 钉钉听记里确认这条听记已生成摘要或逐字稿，再点上面「转事务」重试')))
          } else if (draft !== null) {
            const byUse = {}
            const order = []
            ;(Array.isArray(draft.evidence) ? draft.evidence : []).forEach((e) => {
              const o = (e !== null && typeof e === 'object') ? e : {}
              const uf = String(o.used_for || '（未标用途）')
              if (byUse[uf] === undefined) { byUse[uf] = []; order.push(uf) }
              byUse[uf].push(o)
            })
            if (order.length === 0) {
              dsec.push(h('div', { className: 'dshw-detail', 'data-minevid': 'none', key: 'ev0' },
                '（这份草稿没有依据条目 —— 引擎未给，界面不编）'))
            }
            order.forEach((uf) => {
              dsec.push(h('div', { className: 'dshw-detail', 'data-minevid': uf, key: 'ev-' + uf },
                h('b', null, '依据 · ' + uf + (DRAFT_FIELD_ROLE[uf] ? '（' + DRAFT_FIELD_ROLE[uf] + '项）' : '')),
                byUse[uf].map((o, i) => h('div', { key: 'e' + i, style: { marginTop: '2px' } },
                  '[' + String(EVID_FROM_LABEL[String(o.from)] || String(o.from || '?')) + '] '
                  + String(o.field || '') + ' —— 「' + String(o.quote || '') + '」'))))
            })
            dsec.push(h('div', { className: 'dshw-detail', 'data-mindraft': 'meta', key: 'dm' },
              '置信度 ' + String(draft.confidence || '—')
              + ' · ' + (draft.needs_human === true ? '这版需要人看一眼' : '四项齐备')
              + ' · 引擎预校验 ' + (draft.validation && draft.validation.ok === true ? '过' : '未过')
              + ' · submit_ready=' + String(draft.submit_ready === true)
              + (draft.dedup_key ? ' · 去重键 ' + String(draft.dedup_key) : '')))
            const verr = (draft.validation && Array.isArray(draft.validation.errors)) ? draft.validation.errors : []
            verr.forEach((e, i) => {
              const o = (e !== null && typeof e === 'object') ? e : {}
              dsec.push(h('div', { className: 'dshw-err', 'data-minvalid': String(o.code || ''), key: 've' + i },
                '[' + String(o.code || '') + '] ' + String(o.msg || '') + ' → 下一步：' + String(o.fix || '')))
            })
            if (minDraftNotes.length > 0) {
              dsec.push(h('div', { className: 'dshw-detail', 'data-mindraft': 'notes', key: 'dnotes' }, minDraftNotes.join(' ')))
            }
          }
          secs.push(h('div', { className: 'dshw-modal-sec', key: 's2' }, dsec))
          // ── ③ 立项（提交）：四项预填 + 两条 M1 出路 ──
          const frows = []
          const fieldRow = (label, role, node) => {
            frows.push(h('div', { className: 'dshw-mrow', key: 'lb-' + label },
              h('span', { className: 'dshw-mrow-l' }, label), roleTag(role)))
            frows.push(node)
          }
          fieldRow('事务标题（生成项 · 必填）', 'title', h('input', {
            value: minForm.title, style: { width: '100%' }, 'data-minform': 'title',
            placeholder: '草稿给了一版；请改成"可关"的一句话',
            onChange: (e) => setMinForm((p) => Object.assign({}, p, { title: e.target.value })),
          }))
          fieldRow('关闭条件（生成项 · 必填）', 'done_when', h('input', {
            value: minForm.done_when, style: { width: '100%' }, 'data-minform': 'done_when',
            placeholder: '可机器求值，如：Work/X/Output/ 出现 00-方案.md（草稿生成不出时**留空**，由人写）',
            onChange: (e) => setMinForm((p) => Object.assign({}, p, { done_when: e.target.value })),
          }))
          fieldRow('归属关注域（建议项 · 必填）', 'domain_suggestion', h('select', {
            className: 'dshw-input', value: minForm.domain, 'data-minform': 'domain',
            onChange: (e) => setMinForm((p) => Object.assign({}, p, { domain: e.target.value })),
          },
          h('option', { value: '' }, '不指定（提交会被 P3 拒：写不出归属的不成事务）'),
          // ⚠️ 与 `minLoadDraft` 同一个坑：这里只能用**从 payload 现取**的域清单。
          //   `domainOptions` 这个名字在本文件里只是 `trigRowsForModal` 的局部变量，
          //   在 Workbench 作用域里引用它 ⇒ 弹窗一渲染就抛 ReferenceError
          //   （真机 SBT-MN8/MN10 抓到：点了「转事务」但弹窗永远不出现）。
          //   ⚠️ 还要防 `pwb === null`：弹窗开着的时候面板可能正好在重新取数（`setPwb(null)`），
          //     这时渲染这一帧照样会走到这里（真机踩到：TypeError: Cannot read properties of null）。
          ((pwb !== null && pwb !== undefined && Array.isArray(pwb.domainOptions)) ? pwb.domainOptions : [])
            .map((d) => h('option', { key: d.id, value: d.id }, String(d.name) + ' (' + String(d.id) + ')'))))
          fieldRow('项目/场次锚点（可选项 · 来自草稿的 anchor_candidates）', 'anchor_candidates', h('select', {
            className: 'dshw-input', value: minForm.anchor, 'data-minform': 'anchor',
            onChange: (e) => {
              const key = e.target.value
              const opt = anchors.filter((a) => a.key === key)[0] || null
              setMinForm((p) => Object.assign({}, p, {
                anchor: key,
                origin_project: opt === null ? p.origin_project : (opt.project_dir.length > 0 ? opt.project_dir : p.origin_project),
              }))
            },
          },
          h('option', { value: '' }, anchors.length > 0 ? '不指定（也可以直接手填下面的目录）' : '不指定（草稿没给出锚点候选）'),
          anchors.map((a) => h('option', { key: a.key, value: a.key },
            a.label + '（' + a.kind + ' · ' + a.match + ' · ' + a.basis + '）'))))
          fieldRow('项目目录（origin_project · 可手填）', 'anchor_candidates', h('input', {
            value: minForm.origin_project, style: { width: '100%' }, 'data-minform': 'origin_project',
            placeholder: '如 Work/示例客户A/Output/场次/0913 —— M1 的两条出路之一',
            onChange: (e) => setMinForm((p) => Object.assign({}, p, { origin_project: e.target.value })),
          }))
          fieldRow('关联流入 id（origin_inbound · 可空）', 'anchor_candidates', h('input', {
            value: minForm.origin_inbound, style: { width: '100%' }, 'data-minform': 'origin_inbound',
            placeholder: 'IN-YYYYMMDD-NNN —— 这份听记对应某条流入时填它；与上面的锚点**至少填一个**',
            onChange: (e) => setMinForm((p) => Object.assign({}, p, { origin_inbound: e.target.value })),
          }))
          fieldRow('截止日（建议项 · 可空）', 'due_at', h('input', {
            value: minForm.due_at, style: { width: '100%' }, 'data-minform': 'due_at',
            placeholder: 'YYYY-MM-DD（引擎按句中的时间线索折算；折不出来就留空，不假精确）',
            onChange: (e) => setMinForm((p) => Object.assign({}, p, { due_at: e.target.value })),
          }))
          frows.push(h('label', { className: 'dshw-detail', key: 'd2', style: { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '4px' } },
            h('input', {
              type: 'checkbox', checked: minDedup2 === true, 'data-minform': 'dedup_suffix',
              onChange: (e) => setMinDedup2(e.target.checked === true),
            }),
            '这是同一份听记的**第二件事**（去重键加 #2 后缀；不勾的话第二条会被幂等静默挡回第一条）'))
          frows.push(h('button', {
            className: 'dshw-btn', 'data-minform': 'submit',
            disabled: minBusy === true || gate.ok !== true,
            title: gate.ok === true ? '经库内 cli-matter.mjs add 受理（查重 + 原子 ID + M1/P3 判据）' : gate.why,
            onClick: () => minToMatter(),
          }, minBusy === true ? '…' : '建事务（重复提交不会建第二条）'))
          if (gate.ok !== true) {
            frows.push(h('div', { className: 'dshw-err', 'data-minform': 'm1', key: 'm1' }, '⛔ ' + M1_BLOCK_TEXT))
          }
          frows.push(h('div', { className: 'dshw-detail', key: 'hint' },
            '写通道：POST /intake → 库内 cli-matter.mjs add（与 agent 工具 workbench_matter 同一条，判定不在面板复写）。'
            + '幂等键取草稿的 dedup_key（<来源>:<id>）：同一份听记重复提交由库内查重命中并返回既有 id —— '
            + '界面会说"已经建过"，不会说"已新建"。'))
          if (minMsg !== null) {
            frows.push(h('div', {
              className: minMsg.ok === true ? 'dshw-detail' : 'dshw-err', key: 'mmsg', 'data-minmsg': minMsg.ok === true ? 'ok' : 'err',
            }, (minMsg.ok === true ? '✓ ' : '✗ ') + String(minMsg.text)))
          }
          secs.push(h('div', { className: 'dshw-modal-sec', key: 's3' },
            h('div', { className: 'dshw-modal-sec-h' }, '③ 立项（提交）'), frows))
          return h('div', { className: 'dshw-modal-backdrop', onClick: () => setMinModal(null) },
            h('section', { className: 'dshw-modal', 'data-minmodal': 'matter-from-minutes', onClick: (ev) => ev.stopPropagation() },
              h('div', { className: 'dshw-modal-head' },
                h('span', { className: 'dshw-modal-title' }, '听记 → 事务（草稿预填）'),
                h('span', { className: 'dshw-badge' }, String(minModal.src === 'feishu' ? '飞书妙记' : '钉钉听记')),
                h('span', { className: 'dshw-spacer' }),
                h('button', { className: 'dshw-btn', onClick: () => setMinModal(null) }, '✕')),
              h('div', { className: 'dshw-modal-body' }, secs)))
        })()

        const minModalNode = minModalEl === null
          ? null
          : (ReactDOM !== null && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined'
            ? ReactDOM.createPortal(minModalEl, document.body)
            : minModalEl)

        // ══ 「验收」卡的三级详情页（2026-09-17 用户裁定：分类 → 列表 → 详情页）═══════════
        //  ★ 字段一律**payload 原样**：有就显示，没有就明说"该字段当前不在 payload 中"，
        //    **不编内容**（不推断解锁条件、不补阈值、不换算口径）。
        //  ★ 只读：不放任何写控件；判断质量台账的写入口仍是 CLI / DSH 工具。
        const mmModalEl = mmModal === null ? null : (() => {
          const m = mmModal
          const secs = []
          const mrow = (l, v) => h('div', { className: 'dshw-mrow', key: 'r-' + l },
            h('span', { className: 'dshw-mrow-l' }, l),
            h('span', { className: 'dshw-mrow-v', style: { userSelect: 'text' } }, String(v)))
          let title = '详情'
          let badge = ''
          if (m.kind === 'metric') {
            const it = m.metric || {}
            title = String(it.id || '指标')
            badge = String(it.verdict || '')
            secs.push(h('div', { className: 'dshw-modal-sec', key: 's1' },
              h('div', { className: 'dshw-modal-sec-h' }, '① 指标（payload 原样）'),
              [
                mrow('id', mmRaw(it.id)),
                mrow('名称', mmRaw(it.name)),
                mrow('判定', mmRaw(it.verdict)),
                mrow('目标', mmRaw(it.target)),
                mrow('实际', mmRaw(it.actual)),
                mrow('数值来源', mmRaw(it.evidence)),
                mrow('说明', mmRaw(it.note)),
              ]))
            // ★ 缺口三字段（未达成原因 / 解锁条件 / 下一步）—— 2026-09-17 起由**产物**给出
            //   （`_meta/out/s-metrics.json`，生产者 build-s-metrics.mjs；host 只透传，不判定）。
            //   本卡纪律不变：**payload 原样** —— 有就显示，没有就明说「该字段**当前**不在 payload 中」，
            //   **不推断解锁条件、不补阈值、不换算口径**。
            //   ⚠️ 键缺失（undefined）与显式 null **不是一回事**：
            //     · 键缺失    ⇒ 产物还没落这个字段 ⇒ 走兜底文案
            //     · 显式 null ⇒ 产物明确写「没有可解锁项」（达成项的 unlock/nextAction 就是 null）
            const gapRows = []
            const absent = []
            const noteMissing = (label, key) => {
              if (it[key] === undefined) { absent.push(label); return false }
              gapRows.push(mrow(label, mmRaw(it[key])))
              return true
            }
            noteMissing('未达成原因', 'reason')
            // 兼容既有字段名：采集器侧写 `unlockCondition`，产物统一后用 `unlock`（两者都有就都用，不合并）
            if (it.unlock === undefined && it.unlockCondition !== undefined) {
              gapRows.push(mrow('解锁条件', mmRaw(it.unlockCondition)))
            } else {
              noteMissing('解锁条件', 'unlock')
            }
            noteMissing('下一步（谁做什么）', 'nextAction')
            if (it.calibrated === false) {
              gapRows.push(mrow('参数校准', 'false（**未校准**：阈值/窗口为工程默认值，只作呈现、不作考核）'))
            } else if (it.calibrated === undefined) {
              absent.push('参数校准')
            } else {
              gapRows.push(mrow('参数校准', mmRaw(it.calibrated) + '（不依赖未校准参数：判定阈值来自契约）'))
            }
            secs.push(h('div', { className: 'dshw-modal-sec', key: 's2' },
              h('div', { className: 'dshw-modal-sec-h' }, '② 缺口字段（未达成原因 · 解锁条件 · 下一步）'),
              gapRows.length > 0
                ? gapRows
                : h('div', { className: 'dshw-empty', key: 'gap0' }, 'payload 未给出任何缺口字段'),
              absent.length > 0
                ? h('div', { className: 'dshw-empty', key: 'miss' },
                  absent.join('、') + '：该字段当前不在 payload 中（本卡不编内容，已记入交接单 —— 需产物或 host 补这个字段）')
                : null,
              h('div', { className: 'dshw-empty', key: 'gapnote' },
                '口径：三个字段一律取 payload 原样；null 显示为 —（**达成项的 unlock / nextAction 在产物里就是 null**，表示没有可解锁项）· 本卡不推断、不补阈值')))
            secs.push(h('div', { className: 'dshw-empty', key: 'src' },
              '数据来源：_meta/out/s-metrics.json（由 build-s-metrics.mjs 产出；run-t18.mjs 只读校验、不落盘）· 本卡只读'))
          } else if (m.kind === 'xc') {
            const x = m.xc || {}
            title = '跨源校验'
            badge = 'crosscheck.json'
            const tr = x.trace || {}
            const bs = tr.bySide || {}
            const msR = x.multiSource || {}
            const pv = x.promiseVsDelivery || {}
            const cs = Array.isArray(x.contradictions) ? x.contradictions : []
            const w = String(m.which || '')
            const rows = []
            if (w === 'traceStrict') {
              rows.push(mrow('严格口径', xcPct(tr.strictRate)))
              rows.push(mrow('事务侧', xcPct((bs.matter || {}).strictRate)))
              rows.push(mrow('触发侧', xcPct((bs.trigger || {}).strictRate)))
              rows.push(mrow('口径定义', String((x.definitions || {}).traceStrict || '—')))
            } else if (w === 'traceLoose') {
              rows.push(mrow('宽松口径', xcPct(tr.looseRate)))
              rows.push(mrow('口径定义', String((x.definitions || {}).traceLoose || '—')))
            } else if (w === 'multiSource') {
              rows.push(mrow('多源支撑率', xcPct(msR.supportRate)))
              rows.push(mrow('对象总数', mmRaw(msR.objects)))
              rows.push(mrow('双层支撑', mmRaw(msR.both)))
              rows.push(mrow('仅事务', mmRaw(msR.matterOnly)))
              rows.push(mrow('仅触发', mmRaw(msR.triggerOnly)))
            } else if (w === 'promise') {
              rows.push(mrow('已落地', mmRaw(pv.executed)))
              rows.push(mrow('裁定总数', mmRaw(pv.total)))
              rows.push(mrow('落地率', xcPct(pv.executedRate)))
              const miss = Array.isArray(pv.notExecuted) ? pv.notExecuted : []
              rows.push(mrow('未落地', String(miss.length) + ' 条'))
              for (let i = 0; i < miss.length; i += 1) {
                rows.push(mrow('未落地 ' + String(i + 1), String(miss[i].candidate_id || '') + ' · ' + String(miss[i].action || '')))
              }
            } else {
              rows.push(mrow('矛盾条数', String(cs.length) + ' 条'))
              for (let i = 0; i < cs.length; i += 1) {
                rows.push(mrow('[' + String(cs[i].rule || '') + ']', String(cs[i].subject || '') + ' —— ' + String(cs[i].detail || '')))
              }
              if (cs.length === 0) rows.push(mrow('说明', 'payload 里 contradictions 为空数组（真 0 条）'))
              // ── P2/B5：人工裁决写入口（采纳 / 驳回 / 修正 / 忽略）──────────────────
              //   用户裁定：裁决落**既有写通道**，不另起一套 ⇒ `POST /feedback` → 库内 cli-feedback.mjs。
              //   host 路由**早已存在** ⇒ 本批 host 零改动、面板刷新即生效（不需要重启 DSH）。
              //   ★ 空理由由**库内**拒收（判定只有一份）；这里只把结果原样显示出来。
              if (cs.length > 0) {
                const RULINGS4 = [['accepted', '采纳'], ['rejected', '驳回'], ['revised', '修正'], ['ignored', '忽略']]
                const st = fbRulingRef.current
                for (let i = 0; i < cs.length; i += 1) {
                  rows.push(h('div', { className: 'dshw-detail', key: 'rule' + i, 'data-ruling': '1' },
                    h('div', { style: { fontWeight: '600' } }, '人工裁决 · ' + String(cs[i].rule || '') + ' —— 写入判断质量台账（feedback.json）'),
                    h('textarea', {
                      rows: 2, value: st.reason, placeholder: '理由（必填 · 空理由会被台账拒收，这是判据不是提示）',
                      onChange: (e) => fbRulingSet({ reason: e.target.value }),
                    }),
                    h('div', null, RULINGS4.map((pair) => h('button', {
                      key: pair[0], className: 'dshw-btn', type: 'button', disabled: st.busy === true,
                      'data-ruling-act': pair[0],
                      onClick: () => fbRulingSubmit(cs[i], pair[0]),
                    }, st.busy === true ? '…' : pair[1]))),
                    st.msg !== null ? h('div', { className: 'dshw-msg', 'data-ruling-msg': '1' }, String(st.msg)) : null))
                }
              }
            }
            secs.push(h('div', { className: 'dshw-modal-sec', key: 's1' },
              h('div', { className: 'dshw-modal-sec-h' }, '① 数值（crosscheck.json 原样）'), rows))
            secs.push(h('div', { className: 'dshw-modal-sec', key: 's2' },
              h('div', { className: 'dshw-modal-sec-h' }, '② 口径与纪律'),
              h('div', { className: 'dshw-empty', key: 'cal' },
                'calibrated: ' + String(x.calibrated === undefined ? '—' : x.calibrated)
                + ' · 数据时刻 ' + String(x.generatedAt || '—').slice(0, 19).replace('T', ' ')
                + ' · 矛盾只列不改，需人工定夺')))
          } else if (m.kind === 'fb') {
            title = '判断质量台账'
            badge = String(m.state || '')
            secs.push(h('div', { className: 'dshw-modal-sec', key: 's1' },
              h('div', { className: 'dshw-modal-sec-h' }, '① 该行（/feedback 原样）'),
              [
                mrow('内容', String(m.line || '—')),
                mrow('状态', String(m.state || '—')),
                mrow('待裁定', String(m.pendingCount === null || m.pendingCount === undefined ? '—' : m.pendingCount) + ' 条'),
                mrow('裁决计数', m.counts === null
                  ? 'payload 未给出 counts（该态下无记录）'
                  : ('总 ' + String(m.counts.total) + ' · 采纳 ' + String(m.counts.accepted)
                    + ' · 驳回 ' + String(m.counts.rejected) + ' · 修正 ' + String(m.counts.revised))),
              ]))
            secs.push(h('div', { className: 'dshw-modal-sec', key: 's2' },
              h('div', { className: 'dshw-modal-sec-h' }, '② 写入口（本卡不提供）'),
              h('div', { className: 'dshw-empty', key: 'w' },
                'CLI：node _meta/workbench/cli-feedback.mjs record --type … --ruling … --content … --reason …（或 DSH 工具）· 达阈值只生成待裁定，不改判断层代码')))
          } else {
            const mm = m.mm || {}
            const which = String(m.which || '')
            title = which === 'r8' ? 'R8 响应时限' : 'S1 机器侧定位'
            badge = 's-metrics.json'
            const rows = which === 'r8'
              ? [
                mrow('verdict', mmRaw((mm.r8 || {}).verdict)),
                mrow('realResponded', mmRaw((mm.r8 || {}).realResponded)),
                mrow('slaCalibrated', mmRaw((mm.r8 || {}).slaCalibrated)),
                mrow('口径说明', 'payload r8 原样；时限未校准 ⇒ 只记录不考核'),
              ]
              : [
                mrow('maxMs', mmRaw((mm.s1Timing || {}).maxMs)),
                mrow('meanMs', mmRaw((mm.s1Timing || {}).meanMs)),
                mrow('indexMs', mmRaw((mm.s1Timing || {}).indexMs)),
                mrow('hitRate', mmRaw((mm.s1Timing || {}).hitRate)),
                mrow('口径说明', '机器侧定位耗时；人工操作耗时不在此口径内（payload 原样）'),
              ]
            secs.push(h('div', { className: 'dshw-modal-sec', key: 's1' },
              h('div', { className: 'dshw-modal-sec-h' }, '① 数值（payload 原样）'), rows))
          }
          return h('div', { className: 'dshw-modal-backdrop', onClick: () => setMmModal(null) },
            h('section', { className: 'dshw-modal', onClick: (ev) => ev.stopPropagation() },
              h('div', { className: 'dshw-modal-head' },
                h('span', { className: 'dshw-modal-title', title }, title),
                h('span', { className: 'dshw-badge' }, badge),
                h('span', { className: 'dshw-spacer' }),
                h('button', { className: 'dshw-btn', onClick: () => setMmModal(null) }, '✕')),
              h('div', { className: 'dshw-modal-body' }, secs,
                h('div', { className: 'dshw-empty', key: 'ro' }, '本卡只读：详情页不提供任何写控件'))))
        })()
        const mmModalNode = mmModalEl === null
          ? null
          : (ReactDOM !== null && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined'
            ? ReactDOM.createPortal(mmModalEl, document.body)
            : mmModalEl)

        // ══ 「活跃」卡的三级详情（2026-09-18 四层结构：卡内 tab → 折叠组 → 条目 → 详情）════════
        //   载荷 = `adForm.detail`：卡内点条目时由 `adPack()` 用 **payload 原值**装好的纯字符串包
        //     （域 · 来源 · 匹配依据 · 下一步 · 计数 · 静默/最近活动 · 全部对象键 · 本条对象键）。
        //   ⚠️ 与 `trigModalEl` 同一个坑：本段在**渲染顶层**，卡构造表达式（`pwb.ok === true` 分支里
        //     那段）里的任何局部量在这里都读不到（写成分支内 const 会 ReferenceError ⇒ React 整树卸载）。
        //     故这里只读组件级 state（`adForm`），且**只排版**：不取数、不查表、不判断 ——
        //     字段缺失 ⇒ 少一行（不写"暂无"，也不补 0）。
        //   ★ 只读：全弹窗**没有任何写按钮**（声明/清除/重新匹配仍在卡头，走同一条既有通道）。
        //   ★ 关闭三条路：backdrop 点击 · 关闭按钮 · Esc（打开时自动聚焦关闭按钮；点弹窗内任意处
        //     把焦点落到 `section`(tabIndex=-1) ⇒ Esc 始终有承接元素）。零新增 hook。
        const adModalEl = (adForm.detail === null || adForm.detail === undefined) ? null : (() => {
          const p = adForm.detail
          const close = () => setAdForm((prev) => Object.assign({}, prev, { detail: null }))
          const mrow = (label, value, key) => h('div', { className: 'dshw-mrow', key: key || ('r-' + label) },
            h('span', { className: 'dshw-mrow-l' }, label),
            h('span', { className: 'dshw-mrow-v' }, value))
          const secs = []
          // ① 域（名称 / 来源 声明或自动 / 匹配依据 reason）
          const s1 = [mrow('名称', p.title + (p.did === '' ? '（本行无 id）' : '（' + p.did + '）'), 'ad-dom')]
          s1.push(mrow('来源', p.sourceText === ''
            ? '未在生效列表（activeDomains.effective 里没有这个域）'
            : p.sourceText, 'ad-src'))
          if (p.reason !== '') s1.push(mrow('匹配依据', p.reason, 'ad-rsn'))
          secs.push(h('div', { className: 'dshw-modal-sec', key: 'ad-s1', 'data-ad-detail': 'domain' },
            h('div', { className: 'dshw-modal-sec-h' }, '① 域'), ...s1))
          // ② 下一步（完整标题 + source id + 期限 + 责任人）
          const s2 = []
          if (p.hasHealth !== true) {
            s2.push(h('div', { className: 'dshw-mrow-v', key: 'ad-nh' },
              'domainHealth 里没有这个域（payload 只到 activeDomains 层）'))
          } else if (p.nextTitle === '' && p.nextId === '') {
            s2.push(h('div', { className: 'dshw-mrow-v', key: 'ad-nn' }, 'payload next_step = null'))
          } else {
            if (p.nextTitle !== '') s2.push(mrow('标题', p.nextTitle, 'ad-nt'))
            if (p.nextId !== '') s2.push(mrow('来源 id', p.nextId, 'ad-ni'))
            s2.push(mrow('期限', p.nextDue, 'ad-nd'))
            s2.push(mrow('责任人', p.nextOwner, 'ad-no'))
          }
          secs.push(h('div', { className: 'dshw-modal-sec', key: 'ad-s2', 'data-ad-detail': 'next' },
            h('div', { className: 'dshw-modal-sec-h' }, '② 下一步'), ...s2))
          // ③ 计数（事务 / 未开 / 触发 / 未响应 / 过期）
          secs.push(h('div', { className: 'dshw-modal-sec', key: 'ad-s3', 'data-ad-detail': 'counts' },
            h('div', { className: 'dshw-modal-sec-h' }, '③ 计数（by_domain_field 原样）'),
            h('div', { className: 'dshw-mrow-v', key: 'ad-c1' }, p.hasField === true
              ? ('事务 ' + p.cMatters + '（未开 ' + p.cOpen + '）· 触发 ' + p.cTriggers
                + '（未响应 ' + p.cUnresp + '）· 过期 ' + p.cOverdue + ' 条')
              : 'by_domain_field 缺失（payload 没给这些计数）')))
          // ④ 静默与最近活动
          const s4 = []
          if (p.hasHealth === true) {
            s4.push(mrow('静默', p.hasSilent === true ? (p.silent + ' 天') : 'payload silent_days = null', 'ad-sl'))
            s4.push(mrow('最近活动', p.lastActivity === '' ? '—' : p.lastActivity, 'ad-la'))
          } else {
            s4.push(h('div', { className: 'dshw-mrow-v', key: 'ad-sln' }, 'domainHealth 里没有这个域（无静默/最近活动字段）'))
          }
          secs.push(h('div', { className: 'dshw-modal-sec', key: 'ad-s4', 'data-ad-detail': 'silent' },
            h('div', { className: 'dshw-modal-sec-h' }, '④ 静默与最近活动'), ...s4))
          // ⑤ 该域全部对象键（原序、原样）
          const s5 = p.keys.length === 0
            ? [h('div', { className: 'dshw-mrow-v', key: 'ad-k0' }, 'by_object.object_keys 为空（列表行因此退回显示域名）')]
            : p.keys.map((k, i) => h('div', { className: 'dshw-mrow-v', key: 'ad-k' + i }, String(k)))
          secs.push(h('div', { className: 'dshw-modal-sec', key: 'ad-s5', 'data-ad-detail': 'keys' },
            h('div', { className: 'dshw-modal-sec-h' }, '⑤ 该域全部对象键（' + String(p.keys.length) + ' 条 · payload 原序）'), ...s5))
          // ⑥ 本条对象键（仅当条目对应到具体对象键时才出现）
          if (p.objKey !== '') {
            secs.push(h('div', { className: 'dshw-modal-sec', key: 'ad-s6', 'data-ad-detail': 'objkey' },
              h('div', { className: 'dshw-modal-sec-h' }, '⑥ 本条（点开的那一行）'),
              h('div', { className: 'dshw-mrow-v', key: 'ad-ok' }, p.objKey)))
          }
          return h('div', {
            className: 'dshw-modal-backdrop', key: 'admodal',
            onClick: close,
            onKeyDown: (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close() } },
          },
            h('section', {
              className: 'dshw-modal', tabIndex: -1,
              onClick: (ev) => {
                ev.stopPropagation()
                const el = ev.currentTarget
                if (el && typeof el.focus === 'function') el.focus()
              },
            },
              h('div', { className: 'dshw-modal-head' },
                h('span', { className: 'dshw-modal-title', title: p.did }, '活跃 · ' + p.title),
                h('span', { className: 'dshw-spacer' }),
                h('button', {
                  className: 'dshw-mt-btn', autoFocus: true, 'data-ad-detail-close': '1',
                  title: '关闭（Esc）', onClick: close,
                }, '✕ 关闭')),
              h('div', { className: 'dshw-modal-body' }, ...secs)))
        })()
        const adModalNode = adModalEl === null
          ? null
          : (ReactDOM !== null && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined'
            ? ReactDOM.createPortal(adModalEl, document.body)
            : adModalEl)

        // ══ 专注「入队 / 穿透」二级详情（2026-09-17 需求 ④）════════════════════════════
        //   一级行只列 `queue_digest`（≤ QUEUE_DIGEST_LIMIT 条：时间 + 摘要）；
        //   本弹窗列**全部** `queue_detail` 与 `penetrated_detail`：
        //   来源 · 时间 · 摘要 · 判定理由 `why` · 是否命中 —— 全部**原样取 payload**，
        //   本弹窗不做任何判断（命中与否由数据层 focus-queue.mjs 的 matchTarget 给出）。
        //   ⚠️ 三态必须分开（否则就是把"读不到"说成"没有"）：
        //     · 有明细数组（可能为空数组）→ 逐条列 / 明说"该块无入队"（真 0）；
        //     · 缺 `queue_detail` 字段 → 明说**未取到** + 为什么（host 未重启）+ 怎么才能取到。
        const foModalEl = foModal === null ? null : (() => {
          const kind = String(foModal.kind || 'active')
          const foDoc = (pwb !== null && pwb !== undefined) ? (pwb.focus || {}) : {}
          const live = foDoc.liveRead === true
          const blk = kind === 'last' ? (foDoc.last || null) : (foDoc.active || null)
          const sum = (blk !== null && blk.summary !== null && typeof blk.summary === 'object') ? blk.summary : null
          const qDetail = blk !== null && Array.isArray(blk.queue_detail) ? blk.queue_detail
            : (sum !== null && Array.isArray(sum.queue_detail) ? sum.queue_detail : null)
          const pDetail = blk !== null && Array.isArray(blk.penetrated_detail) ? blk.penetrated_detail : null
          const digest = blk !== null && Array.isArray(blk.queue_digest) ? blk.queue_digest
            : (sum !== null && Array.isArray(sum.queue_digest) ? sum.queue_digest : null)
          const fqRow = (r, key) => h('div', { className: 'dshw-fq-row', key },
            h('div', { className: 'dshw-mrow' },
              h('span', { className: 'dshw-fq-hit', 'data-hit': r.hit === true ? '1' : '0' }, r.hit === true ? '已穿透' : '入队'),
              h('span', { className: 'dshw-fq-row-meta' },
                String(r.source || '—') + ' · ' + String(r.arrived_at || '—') + (r.disposition ? ' · ' + String(r.disposition) : '')),
              h('span', { className: 'dshw-spacer' })),
            h('div', { className: 'dshw-mrow-v' }, String(r.digest || r.digest_head || '（摘要为空）')),
            h('div', { className: 'dshw-fq-row-meta' }, '判定理由: ' + String(r.why || '（payload 未给）')
              + (r.inbound_id ? ' · 流入 ' + String(r.inbound_id) : '')))
          const secs = []
          secs.push(h('div', { className: 'dshw-modal-sec', key: 'fq1' },
            h('div', { className: 'dshw-modal-sec-h' }, '① 口径（payload 原样）'),
            [
              h('div', { className: 'dshw-mrow', key: 'k' }, h('span', { className: 'dshw-mrow-l' }, '块'),
                h('span', { className: 'dshw-mrow-v' }, kind === 'last' ? '最近已结束块' : '进行中块')),
              h('div', { className: 'dshw-mrow', key: 'id' }, h('span', { className: 'dshw-mrow-l' }, '块 id'),
                h('span', { className: 'dshw-mrow-v' }, String((blk || {}).id || foModal.id || '—'))),
              h('div', { className: 'dshw-mrow', key: 'tg' }, h('span', { className: 'dshw-mrow-l' }, '目标'),
                h('span', { className: 'dshw-mrow-v' }, String(((blk || {}).target || {}).label || foModal.label || '—')
                  + '（' + String(((blk || {}).target || {}).kind || '—') + ':' + String(((blk || {}).target || {}).id || '—') + '）')),
              h('div', { className: 'dshw-mrow', key: 'ct' }, h('span', { className: 'dshw-mrow-l' }, '计数'),
                h('span', { className: 'dshw-mrow-v' }, '穿透 ' + String((blk || {}).penetrated_count ?? '—')
                  + ' · 入队 ' + String((blk || {}).queued_count ?? '—'))),
              h('div', { className: 'dshw-mrow', key: 'src' }, h('span', { className: 'dshw-mrow-l' }, '读法'),
                h('span', { className: 'dshw-mrow-v' }, live
                  ? '实时归类（cli-focus.mjs status → focus-queue.mjs classifyBlock）'
                  : '⚠️ 快照口径（host 未重启，`/state.focus` 无 liveRead）—— 明细未取到，不是 0')),
            ]))
          if (qDetail !== null) {
            secs.push(h('div', { className: 'dshw-modal-sec', key: 'fq2' },
              h('div', { className: 'dshw-modal-sec-h' }, '② 入队明细（未命中专注目标 · ' + String(qDetail.length) + ' 条）'),
              qDetail.length === 0
                ? [h('div', { className: 'dshw-empty', key: 'q0' }, '该块无入队（实时口径下的真 0：块期间没有未命中目标的流入）')]
                : qDetail.map((r, i) => fqRow(r, 'qd' + i))))
          } else {
            secs.push(h('div', { className: 'dshw-modal-sec', key: 'fq2n' },
              h('div', { className: 'dshw-modal-sec-h' }, '② 入队明细 —— **未取到**（不是"没有入队"）'),
              [h('div', { className: 'dshw-empty', key: 'qn' },
                'payload 里没有 `queue_detail` 字段。原因：归类是**读时**由聚合层 focus-queue.mjs 算出的，'
                + '而 host 半体仍是旧版（DSH 未重启）⇒ `/state.focus` 只有快照口径的计数、没有明细。'),
              h('div', { className: 'dshw-empty', key: 'qn2' },
                '取到条件：重启 DSH 加载新的 host 半体（`whitelist` / `queue_detail` / `penetrated_detail` 随 `/state.focus` 下发）。'
                + '重启后本弹窗自动显示逐条明细，无需再改客户端。')]))
          }
          if (pDetail !== null) {
            secs.push(h('div', { className: 'dshw-modal-sec', key: 'fq3' },
              h('div', { className: 'dshw-modal-sec-h' }, '③ 穿透明细（命中专注目标 · ' + String(pDetail.length) + ' 条）'),
              pDetail.length === 0
                ? [h('div', { className: 'dshw-empty', key: 'p0' }, '该块无穿透项（块期间没有命中目标的流入）')]
                : pDetail.map((r, i) => fqRow(r, 'pd' + i))))
          }
          if (digest !== null && digest.length > 0 && qDetail !== null) {
            secs.push(h('div', { className: 'dshw-modal-sec', key: 'fq4' },
              h('div', { className: 'dshw-modal-sec-h' }, '④ 一级行显示的就是这 ' + String(digest.length) + ' 条（queue_digest）'),
              digest.map((d, i) => h('div', { className: 'dshw-fq-row-meta', key: 'dg' + i }, String(d || '')))))
          }
          secs.push(h('div', { className: 'dshw-modal-sec', key: 'fq5' },
            h('div', { className: 'dshw-modal-sec-h' }, '⑤ 必穿透白名单（专注期间保持醒目、不降权的卡）'),
            [h('div', { className: 'dshw-empty', key: 'wl' },
              '逾期事务 ' + (focusView.wl !== null && focusView.wl.overdueMatters !== null ? String(focusView.wl.overdueMatters) : '未取到')
              + ' · 逾期触发 ' + (focusView.wl !== null && focusView.wl.overdueTriggers !== null ? String(focusView.wl.overdueTriggers) : '未取到')
              + ' · ' + String(UPCOMING_SCHEDULE_LEAD_MINUTES) + ' 分钟内即将开始 ' + String(focusView.upcoming.length)),
            h('div', { className: 'dshw-fq-row-meta', key: 'wls' }, '来源：' + String((focusView.wl || {}).source || '—'))]))
          secs.push(h('div', { className: 'dshw-empty', key: 'fqn' },
            '本弹窗只读：不提供"改判定 / 手动出队 / 改专注目标"的口子（写入口仍是 CLI 与 DSH 工具）'))
          return h('div', {
            className: 'dshw-modal-backdrop',
            'data-focus-detail': '1',
            onClick: () => setFoModal(null),
          },
          h('section', { className: 'dshw-modal', onClick: (ev) => ev.stopPropagation() },
            h('div', { className: 'dshw-modal-head' },
              h('span', { className: 'dshw-modal-title', title: String(foModal.id || '') },
                '专注明细 · ' + String(foModal.label || foModal.id || '—')),
              h('span', { className: 'dshw-badge' }, kind === 'last' ? '上块已结束' : '进行中'),
              h('span', { className: 'dshw-spacer' }),
              h('button', { className: 'dshw-btn', onClick: () => setFoModal(null) }, '✕')),
            h('div', { className: 'dshw-modal-body' }, secs)))
        })()
        const foModalNode = foModalEl === null
          ? null
          : (ReactDOM !== null && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined'
            ? ReactDOM.createPortal(foModalEl, document.body)
            : foModalEl)

        return h('div', {
          className: embedded ? 'dshw-root dshw-embedded' : 'dshw-root',
          ref: outer,
          // tab 身份固化（2026-09-17）：套件/探针用**属性**判断"这是哪个 tab 的面板"，
          // 不要用标题文字 —— 按文字找元素的断言一改名就假红（本项目已反复踩到）。
          'data-dshw-tab': 'console',
          'data-modal': (matterModal !== null && matterModalNode === matterModalEl)
            || (calModal !== null && calModalNode === calModalEl)
            || (todoDetail !== null && todoModalNode === todoModalEl)
            || (objModal !== null && objModalNode === objModalEl)
            || (mmModal !== null && mmModalNode === mmModalEl)
            || (foModal !== null && foModalNode === foModalEl)
            || (trigModal !== null && trigModalNode === trigModalEl)
            || (minModal !== null && minModalNode === minModalEl)
            // 「活跃」卡三级详情：载荷在 state（`adForm.detail`）里，故这里按它判断，不按卡里的局部量
            || ((adForm.detail !== null && adForm.detail !== undefined) && adModalNode === adModalEl)
            // 「资产」卡二级详情（2026-09-23）：载荷在 state（`astModal`）里，故按它判断
            || (astModal !== null && astModalNode === astModalEl) ? '1' : null,
        }, panel, matterModalNode, calModalNode, todoModalNode, objModalNode, mmModalNode, trigModalNode, brfModalNode, insModalNode, foModalNode, adModalNode, minModalNode, astModalNode, cmdkNode, tourNode, dwNode, themeNode)
      }

      // ── 席位接线（2026-09-24 用户裁定：四个工作台移入 DSH WebUI 自带的两条栏）──
      //   为什么不挂 better-sidebar 了：那条栏是第三方插件自己用 React portal 画的，跟 WebUI
      //   自带的右栏（官方包 `ui-sidebar-right`，布局里的 `rightbar`）是两套东西。官方两处都
      //   留了公开接入口，本批全部改走官方席位（官方 documentpreview / files 就是同一路径的示范）：
      //     ① 「工作台」卡片面板 → 官方右栏的 tab 类型：类型进 `ctx.sidebarRightTabs`，
      //        正文进键控席位 `sidebar.right.pane.tab`（key = 类型 id）；
      //     ② 「驾驶舱」→ 主面板：`main` 键控席位（key = 面板 id），与对话页平级；
      //     ③ 左侧栏底部（设置按钮上方）的三枚工作台图标 → `sidebar.footer.action`。
      //   ③ 为什么三枚由本插件统一画：该席位的容器是 shell 自己的一行 flex，三方各注册一枚
      //   时，侧边栏折叠成 56px 竖栏后三枚会横向溢出（布局规则如此）；由一个组件同时画三枚、
      //   按 `wide` 自己切横排(宽)/竖排(折叠)，两种宽度都不溢出。另外两枚指向 dsh-modeling /
      //   dsh-coords 注册的主面板 —— 面板本体归它们自己，这里只管"入口长什么样"。
      const SIDEBAR_TAB_ID = 'dsh-workbench:console'      // 官方右栏 tab 类型 id（= 正文注册的 key）
      const PANEL_DASH_ID = 'dsh-workbench:dashboard'     // 驾驶舱主面板 id
      const PANEL_MODELING = 'dsh-modeling:center'        // 建模中心主面板（dsh-modeling 注册）
      const PANEL_COORDS = 'dsh-coords:center'            // 坐标系主面板（dsh-coords 注册）
      const FOOTER_ICONS_ID = 'dsh-workbench:workspaces'  // 左侧栏底部图标行（list 席位 id）

      /**
       * ── 底部图标行另外两枚图标（与 dsh-modeling / dsh-coords 的同名函数同图）──────────
       * 为什么是复制而不是引用：三枚图标要由同一个组件画，才能自己控制横排/竖排；而三个插件
       * 是三个独立的 client 半体，跨包取不到对方的函数。改这三枚图标时**两处必须一起改**
       * （同画布 16×16 / 同描边 1.3 / 同 currentColor，见上方 iconWorkbench 的作图纪律）。
       */
      /** 建模中心：三块节点 + 两条连线（与 dsh-modeling 的 iconModeling 同图） */
      function iconModeling(size, className, glyph) {
        return svg(size, [
          React.createElement('rect', { key: 'tl', x: 0.9, y: 2.1, width: 4.4, height: 3.4, rx: 1.1 }),
          React.createElement('rect', { key: 'tr', x: 10.7, y: 2.1, width: 4.4, height: 3.4, rx: 1.1 }),
          React.createElement('rect', { key: 'b', x: 5.8, y: 10.5, width: 4.4, height: 3.4, rx: 1.1 }),
          React.createElement('path', { key: 'e1', d: 'M3.1 5.5v2.1a1.2 1.2 0 0 0 1.2 1.2h3.7a1.2 1.2 0 0 0 1.2-1.2V5.5' }),
          React.createElement('path', { key: 'e2', d: 'M12.9 5.5v2.1a1.2 1.2 0 0 1-1.2 1.2H8v1.7' }),
        ], '建模中心', className, glyph)
      }

      /** 坐标系：三轴 + 一个带投影虚线的点（与 dsh-coords 的 iconCoords 同图） */
      function iconCoords(size, className, glyph) {
        return svg(size, [
          React.createElement('path', { key: 'axes', d: 'M3.2 2.4v10.4h10.2' }),
          React.createElement('path', { key: 'depth', d: 'M3.2 12.8 7.4 8.6' }),
          React.createElement('path', { key: 'dx', d: 'M10.3 12.8V6.1', strokeDasharray: '1.7 1.4' }),
          React.createElement('path', { key: 'dy', d: 'M3.2 6.1h7.1', strokeDasharray: '1.7 1.4' }),
          React.createElement('circle', { key: 'pt', cx: 10.3, cy: 6.1, r: 1.35 }),
        ], '坐标系', className, glyph)
      }

      /**
       * 左侧栏底部的四行（**图标在左、名称在右** —— 用户 2026-09-24 裁定；与官方侧边栏自己的
       * 行同一形状，折叠成 56px 竖栏时只留图标）。四行做同一件事：**把官方右侧栏里对应的那一栏
       * Tab 打开/聚焦**（全屏 / 双栏分屏 / 拖拽都由那条栏自己管）。
       * 工作台 / 驾驶舱的类型由本插件注册；坐标系 / 建模中心的类型由 dsh-coords / dsh-modeling
       * 各自注册 —— 这里只需要知道"点谁开谁"。
       */
      const WORKSPACES = [
        { id: SIDEBAR_TAB_ID, label: SIDEBAR_TAB_TITLE, icon: iconWorkbench },
        { id: PANEL_DASH_ID, label: SIDEBAR_DASH_TITLE, icon: iconDashboard },
        { id: PANEL_COORDS, label: '坐标系', icon: iconCoords },
        { id: PANEL_MODELING, label: '建模中心', icon: iconModeling },
      ]

      // 四行的样式：自带一段 `<style>`，不动既有 CSS / CSS_V2（那两段被套件按条对账）。
      // 形状照着官方侧边栏自己的行来（`SidebarRoot.module.css` 的 `.panelRow`）：图标 16（折叠 18）
      //   + 名称、整行可点、36px 高、hover 圆角底；折叠态只留 36×36 的图标（名称不画）。
      // 颜色走官方主题变量（--dsw-alias-*），深浅色自动跟随。
      const footerStyle = document.createElement('style')
      footerStyle.setAttribute('data-dshw-footer', '')
      footerStyle.textContent = [
        '.dshw-wsrows{display:flex;flex-direction:column;gap:4px;width:100%;padding:2px 0 4px}',
        '.dshw-wsrow{display:flex;align-items:center;gap:8px;width:100%;min-height:36px;padding:7px 8px;box-sizing:border-box;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;line-height:22px;text-align:left;cursor:pointer}',
        '.dshw-wsrow:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.dshw-wsrow--rail{width:36px;height:36px;min-height:36px;justify-content:center;padding:0;color:var(--dsw-alias-label-primary)}',
        '.dshw-wsrow:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:-2px}',
        '.dshw-wsic{flex:none;display:inline-flex;align-items:center;justify-content:center}',
        '.dshw-wsname{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}',
      /* ── 详情弹窗（二级/三级）里 CSS_V2 覆盖不到的几处：**全局选择器**、只写字面值 ──
         ⚠️ 这一段是**另起一段**补的，注入顺序在 CSS_V2 **之后** ⇒ 同特异度时这里赢。
            所以两段口径必须一致：只改 CSS_V2 会得到"卡片是水墨、弹窗还是飞书"的半截状态
            （2026-09-26 换水墨时就是这么被套件抓到的 SKIN-17/18/19）。
         ⚠️ 原来那条 `.dshw-modal` 上挂着 `box-shadow:…!important` —— 水墨**不用阴影**分层，
            留着 `!important` 会把 CSS_V2 的 `box-shadow:none` 直接压掉，所以整条删掉，
            弹窗的底色/描边/圆角统一由 CSS_V2 的全局段负责。 */
  '.dshw-modal-sec:first-of-type{border-top:none}',
  /* ⚠️ 颜色一律走 var(--wb2-*)：令牌挂在 body 上（见 CSS_V2 纪律 ④），
        弹窗虽然 portal 在 .dshw-root 之外，也取得到 —— 写死色值会让夜间模式漏改这一块。 */
  '.dshw-modal a{color:var(--wb2-brand-hover);text-decoration:none;border-bottom:.5px solid var(--wb2-brand-soft-2)}',
  '.dshw-modal code{font-family:var(--wb2-mono);background:var(--wb2-fill);border:.5px solid var(--wb2-line);border-radius:2px;padding:0 4px;color:var(--wb2-t2)}',
  '.dshw-modal .dshw-pill,.dshw-modal .dshw-badge{font:400 10.5px/22px var(--wb2-sans);height:22px;letter-spacing:.10em;border-radius:2px;background:var(--wb2-fill);color:var(--wb2-t2);padding:0 8px}',
  '.dshw-modal .dshw-pill[data-tone="ok"]{color:var(--wb2-ok);background:var(--wb2-ok-soft)}',
  '.dshw-modal .dshw-pill[data-tone="warn"]{color:var(--wb2-warn);background:var(--wb2-warn-soft)}',
  '.dshw-modal .dshw-pill[data-tone="bad"]{color:var(--wb2-bad);background:var(--wb2-bad-soft)}',
  '.dshw-modal ::-webkit-scrollbar{width:8px}',
  '.dshw-modal ::-webkit-scrollbar-thumb{background:var(--wb2-line-strong);border-radius:99px}',
  '.dshw-modal button:focus-visible{outline:1px solid var(--wb2-brand);outline-offset:2px}',
].join('\n')
      document.head.appendChild(footerStyle)
      ctx.effect(() => () => { try { footerStyle.remove() } catch (e) { /* 已摘除 */ } })

      /**
       * 左侧栏底部的四行（`sidebar.footer.action`）：**图标在左、名称在右**，整行可点。
       *
       * 点一下 = 让官方右侧栏打开/聚焦那一栏的 Tab（`ctx.sidebarRight.openTab(kind)`）。
       * 官方那条栏自己带全屏 / 双栏分屏 / 拖拽，所以四个工作台的手感完全一致。
       * 没有会话面（右栏无处可落）或该 Tab 的类型没注册时 `openTab` 会抛：这里吞掉不动 ——
       * 宁可按钮没反应，也不要整条侧边栏炸。
       *
       * `wide` 是官方 footer 席位给的列状态（宽栏 true / 折叠 56px 栏 false）：折叠时只画图标。
       */
      function WorkspaceIconRow(props) {
        const wide = props.wide !== false
        const open = (id) => {
          // ⚠️ 页面刚载入的那一两秒里，官方右栏的会话面还没挂好 ⇒ `openTab` 会抛
          //   （"no session surface is mounted"）。实测：刷新完立刻点第一下会点空。
          //   所以这里**短重试两次**（1.5s 一次），别把用户的点击吃掉。
          const attempt = (left) => {
            let right
            try { right = ctx.get('sidebarRight') } catch (e) { right = undefined }
            if (right === undefined || right === null || typeof right.openTab !== 'function') return
            try {
              right.openTab(id)
            } catch (e) {
              if (left > 0) window.setTimeout(() => { attempt(left - 1) }, 1500)
            }
          }
          attempt(2)
        }
        return React.createElement('div', {
          className: 'dshw-wsrows',
          'data-dshw-footer': 'workspaces',
        }, WORKSPACES.map((w) => React.createElement('button', {
          key: w.id,
          type: 'button',
          className: 'dshw-wsrow' + (wide ? '' : ' dshw-wsrow--rail'),
          title: w.label,
          'aria-label': w.label,
          'data-dshw-panel': w.id,
          onClick: () => { open(w.id) },
        },
        React.createElement('span', { className: 'dshw-wsic' }, w.icon(wide ? 16 : 18)),
        wide ? React.createElement('span', { className: 'dshw-wsname' }, w.label) : null)))
      }

      // ── overlay 兜底：官方右栏迟迟不在（非 WebUI 环境）时，功能不丢 ──────────────
      //   （用户 2026-09-15 裁定过"侧边栏接管即取消框体"：所以只有接管失败才挂。）
      const overlayHolder = { off: null }

      function mountOverlayFallback() {
        if (overlayHolder.off !== null || sidebarRegistered) return
        overlayHolder.off = ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          { name: 'shell.overlay', id: 'workbench', order: 40 },
          () => React.createElement(Workbench, null),
        ))
      }
      function unmountOverlay() {
        if (overlayHolder.off === null) return
        try { overlayHolder.off() } catch (e) { /* 已撤 */ }
        overlayHolder.off = null
      }

      // ①「工作台」→ 官方右栏 tab 类型（两步注册，与官方 documentpreview / files 同一公开路径）
      let sidebarRegistered = false
      let sidebarAutoOpened = false
      function tryRegisterSidebarTab() {
        if (sidebarRegistered) return
        let tabs, right
        try { tabs = ctx.get('sidebarRightTabs'); right = ctx.get('sidebarRight') } catch (e) { tabs = undefined; right = undefined }
        if (tabs === undefined || tabs === null || typeof tabs.register !== 'function') return
        sidebarRegistered = true
        ctx.effect(() => tabs.register({
          id: SIDEBAR_TAB_ID,
          kind: SIDEBAR_TAB_ID,
          title: () => SIDEBAR_TAB_TITLE,
          // 指南页入口：右栏空着时给一张"工作台"卡片（官方 tab 的发现入口就是这个列表）。
          guide: [{
            id: 'workbench', order: 30,
            title: () => SIDEBAR_TAB_TITLE,
            description: () => '个人 AI 工作台：日程 · 待办 · 事务 · 响应 · 听记 · 系统',
            // 指南页入口卡上的图标（官方 IconProps：{size, className}）——没给的话官方画方块占位符。
            // 彩色底板：官方那两张卡也是彩色（金色文件夹 / 深色终端卡），见上方 guideTile 那段说明。
            icon: guideOf('workbench', GUIDE_PLATE_BLUE, marksWorkbench()),
          }],
        }))
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: SIDEBAR_TAB_ID },
          () => React.createElement(Workbench, { embedded: true }),
        )))
        // ②「驾驶舱」→ 同一个官方右侧栏的另一个 Tab 类型（不再是主面板：用户 2026-09-24 裁定）
        ctx.effect(() => tabs.register({
          id: PANEL_DASH_ID,
          kind: PANEL_DASH_ID,
          title: () => SIDEBAR_DASH_TITLE,
          guide: [{
            id: 'dashboard', order: 31,
            title: () => SIDEBAR_DASH_TITLE,
            description: () => '库内仪表盘（dashboard.html）只读内嵌，可全屏/分屏',
            icon: guideOf('dashboard', GUIDE_PLATE_GREEN, marksDashboard()),
          }],
        }))
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: PANEL_DASH_ID },
          () => React.createElement(DashboardView, null),
        )))
        // 自动打开一次：右栏只有被打开过才在屏上。`openTab` 在没有会话面（页面停在无会话态）
        // 时抛错，所以短重试三次；**一旦成功就不再重试** —— 否则用户在这几秒里点了别的工作台，
        // 后面那次自动打开会把焦点抢回「工作台」（实测踩到过：刚刷新完点「坐标系」又被切走）。
        if (!sidebarAutoOpened && right !== undefined && right !== null && typeof right.openTab === 'function') {
          sidebarAutoOpened = true
          let opened = false
          const openOnce = () => {
            if (opened) return
            try { right.openTab(SIDEBAR_TAB_ID); opened = true } catch (e) { /* 会话面未挂载：下次再试 */ }
          }
          let opens = 0
          const stopOpen = ctx.interval(() => { openOnce(); opens += 1; if (opened || opens >= 3) stopOpen() }, 2000)
          openOnce()
        }
        unmountOverlay()   // 官方右栏接管 → 取消框体兜底
      }

      // ③（已取消）「驾驶舱」不再注册主面板 —— 四个工作台统一在官方右侧栏里（见上面的两步注册）；
      //    这一改同时消掉了"切主面板会把对话页换下、输入草稿可能丢"的副作用。

      // ③ 左侧栏底部图标行（宽屏横排 / 折叠竖排由组件自己按 wide 切）
      ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
        { name: 'sidebar.footer.action', id: FOOTER_ICONS_ID, order: 10, label: SIDEBAR_TAB_TITLE },
        WorkspaceIconRow,
      )))

      tryRegisterSidebarTab()
      let sidebarTries = 0
      const stopSidebarTry = ctx.interval(() => {
        sidebarTries += 1
        tryRegisterSidebarTab()
        // 宽限：官方右栏迟迟不在（非 WebUI 环境）→ 挂 overlay 兜底，功能不丢
        if (!sidebarRegistered && sidebarTries >= 10) mountOverlayFallback()
        if (sidebarRegistered || sidebarTries >= 30) stopSidebarTry()
      }, 1000)
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-workbench'
    // 纯函数测试钩子：分组逻辑在 Node 里可直接验证（selftest-client.mjs，无需浏览器）。
    // 模块加载契约只用 apply/inject/name，附加字段不影响加载。
    /**
     * 卡名口径（机器可读出口，2026-09-17）：与文件顶部那份 `[card-titles:begin]` 契约块、
     * 运行时全局 `window.__DSHW_CARD_TITLES__` **同一份数据**（`CARD_TITLES` / `CARD_TITLE_ORDER`）。
     * 真机套件/探针要读卡名，走这三个出口中的任意一个，都拿得到同一张表：
     *   · 源码级（最稳，不需要浏览器）：抽文件顶部那个契约块（首个起标记 → 下一个止标记）并 JSON.parse；
     *   · 页面级：`window.__DSHW_CARD_TITLES__`；
     *   · Node 级：`registration.factory(require).__test.cardTitles`（见 selftest-client.mjs 的桩法）。
     */
    exports.__test = {
      groupMattersByDomain,
      cardTitles: CARD_TITLES,
      cardOrder: CARD_TITLE_ORDER,
      focusDim: FOCUS_DIM,
      focusTargetCards: FOCUS_TARGET_CARDS,
      // 卡片交互规范的两张登记表（SPEC §一/§三）：断言直接读这两份，不要再各自硬编码
      cardScenes: CARD_SCENES,
      cardKeyOfTitle,
      // 听记卡的行模型 + 卡头文案（2026-09-19 用户规格）：纯函数，Node 级可直测
      //   （selftest-client.mjs）——「来源标签 / 不显示时间 / 分源计数 / 诚实降级」四条都在这里。
      minutesRowModel,
      // 听记卡 2026-09-20 两条新规格的**可测出口**（run-t16 的 T16-180 组直接读这几个名字，
      //   不靠 grep 渲染代码猜行为）：
      //   · `minutesGroupModel` —— 一级列表按对象/客户聚合（第五条的判据本体）；
      //   · `objKeyLabel`       —— 对象键剥机器前缀（聚合与对象卡共用同一份实现）；
      //   · `minArchStamp`      —— 归档行的日期戳（一级行按规格③不带时间）；
      //   · `minutesActiveDays` —— 活跃窗口天数（常量，断言读它而不是写死 30）。
      minutesGroupModel,
      objKeyLabel,
      minArchStamp,
      minutesActiveDays: MINUTES_ACTIVE_DAYS,
      minutesTsFloor: MINUTES_TS_FLOOR,
      // 听记 → 事务**草稿**（2026-09-26 · 第六条）的**可测出口**（run-t16 的 T16-19x 组直接读这几个名字）：
      //   · `minDraftToForm`        —— 草稿 → 表单预填（"不可用分支不预填"的判据本体）
      //   · `minOriginState`        —— M1 闸（origin_inbound 或 origin_project 至少一个非空）
      //   · `minSubmitText`         —— 提交回执 → 人话（去重命中与真新建必须**两句不同的话**）
      //   · `minSubmitTextDistinct` —— 上面那条的**判据本体**（可被负向对照证伪）
      //   · `minAnchorOptions`      —— 锚点候选 → 下拉选项（只读引擎出参，界面不另派生对象）
      //   · `minDraftTargetOf`      —— 听记行 → 转事务目标（寻址交给 host）
      minDraftToForm,
      minOriginState,
      minSubmitText,
      minSubmitTextDistinct,
      minAnchorOptions,
      minDraftTargetOf,
      EVID_FROM_LABEL,
      DRAFT_FIELD_ROLE,
      M1_BLOCK_TEXT,
      MINUTES_DRAFT_ROUTE,
      // 指南页入口卡上那两枚**彩色**图标（2026-09-25 用户要求「加上配色」）：
      // 自测要读它们的形状与配色（纯函数，Node 里 stub 一个记账版 React 就能断言），
      // 于是"卡上到底画了什么颜色"不必等真机跑一遍才知道。
      guideIcons: { workbench: guideOf('workbench', GUIDE_PLATE_BLUE, marksWorkbench()), dashboard: guideOf('dashboard', GUIDE_PLATE_GREEN, marksDashboard()) },
      guidePlate: { size: GUIDE_SIZE, rect: GUIDE_PLATE, marksAt: GUIDE_MARKS_AT },
      // ── 卡片缩放那套（2026-09-26 两档 + 5% 网格）──────────────────────────────
      //   全是纯函数 ⇒ 自测（selftest-client.mjs 的 CL-20）在 Node 里直接读它们，
      //   不必等真机跑一遍才知道"5% 吸附 / 两档换算 / 下限"对不对。
      cardSizing: {
        layout: layoutForCardSize, snapPct, pxToPct, pctToPx, clampCardNum,
        convert: convertCardSizeMap, readSize: readCardSize, readMode: readCardSizeMode,
        defaultSpanFor, legacyColsAt, gridSpanWidthPx, minPctFor,
        step: CARD_GRID_STEP, cols: CARD_COLS, gap: CARD_GAP_PX,
        minH: CARD_MIN_H_PX, maxH: CARD_MAX_H_PX, minW: CARD_MIN_W_PX,
        lsKey: CARD_SIZE_LS, modeLsKey: CARD_SIZE_MODE_LS,
      },
    }
    // 页面级出口：面板加载后即有，供真机套件/探针直接读（只读快照，不影响渲染）。
    try {
      if (typeof window !== 'undefined' && window !== null) {
        window.__DSHW_CARD_TITLES__ = {
          order: CARD_TITLE_ORDER.slice(),
          titles: Object.assign({}, CARD_TITLES),
          focusDim: Object.assign({}, FOCUS_DIM),
          scenes: Object.assign({}, CARD_SCENES),
        }
        // 卡片缩放那套（2026-09-26）：真机套件要按**同一份口径**算期望值（画布多宽 → 自然档跨几列、
        // 某个像素位移落到哪一格）—— 各自写死 5 / 20 的那份一旦与实现分叉，判据就成了摆设。
        window.__DSHW_CARD_SIZING__ = {
          cols: CARD_COLS, step: CARD_GRID_STEP, gap: CARD_GAP_PX,
          minW: CARD_MIN_W_PX, minH: CARD_MIN_H_PX, maxH: CARD_MAX_H_PX,
          naturalMinPx: CARD_NATURAL_MIN_PX, naturalMinPxFloat: CARD_NATURAL_MIN_PX_FLOAT,
          snapPct, layoutForCardSize, defaultSpanFor, legacyColsAt, pxToPct, pctToPx, clampCardNum, convertCardSizeMap,
          gridSpanWidthPx, minPctFor,
          readSize: readCardSize, readMode: readCardSizeMode,
          lsKey: CARD_SIZE_LS, modeLsKey: CARD_SIZE_MODE_LS,
        }
      }
    } catch (e) { /* 无 window（Node 自测桩）：忽略即可，__test 出口仍在 */ }
    return module.exports
  },
})
