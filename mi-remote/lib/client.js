/**
 * dsh-mi-remote · 浏览器半段
 *
 * 「小米遥控器」面板。四块东西：
 *   ① 左侧栏底部一行「小米遥控器」，order 5 < 工作台的 10 ⇒ 排在它上方；
 *   ② 官方右侧栏 Tab（guide order 25 < 工作台的 30 ⇒ 指南页入口卡也在它上方）；
 *   ③ 兜底 overlay（官方右栏不在时功能不丢）；
 *   ④ 面板：链路体检（遥控器/SayAll/VB-CABLE/输入法四段）· 按键映射编辑器 · 语音输入路径。
 *
 * 取数与执行全部走宿主半段的 /mi-remote/api；判定逻辑只有宿主一份，这里不复制。
 */

window.__ModuleLoader__.load({
  id: 'dsh-mi-remote',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/mi-remote/api'
    const SIDEBAR_TAB_ID = 'dsh-mi-remote:panel'
    const FOOTER_ID = 'dsh-mi-remote:entry'
    const PANEL_TITLE = '遥控器'
    const LS_PREFIX = 'dsmr.'

    /* ── 小工具 ─────────────────────────────────────────────────────────── */

    const isChinese = () => {
      try {
        const lang = String((navigator && (navigator.language || (navigator.languages && navigator.languages[0]))) || '')
        if (/^zh/i.test(lang)) return true
        return /^zh/i.test(String((document.documentElement && document.documentElement.lang) || ''))
      } catch (e) { return true }
    }
    const zh = isChinese()

    const S = {
      title: { zh: '遥控器', en: 'Mi Remote' },
      subtitle: { zh: '把小米蓝牙遥控器变成 DSH 的手上工具：语音出字、按键映射到 DSH 动作。按键注入由无线麦 SayAll 执行，这里负责配置与体检。', en: 'Configure the Xiaomi remote for DSH.' },
      link: { zh: '链路体检', en: 'Link check' },
      mapping: { zh: '按键映射', en: 'Button mapping' },
      voice: { zh: '语音输入路径', en: 'Voice input path' },
      ready: { zh: '就绪', en: 'ready' },
      missing: { zh: '缺', en: 'missing' },
      installedNotRunning: { zh: '已装未运行', en: 'installed, not running' },
      remoteName: { zh: '遥控器配对', en: 'Remote paired' },
      sayallName: { zh: '无线麦 SayAll', en: 'SayAll' },
      cableName: { zh: 'VB-CABLE', en: 'VB-CABLE' },
      wetypeName: { zh: '微信输入法', en: 'WeType IME' },
      howto: { zh: '怎么补', en: 'How to fix' },
      voiceKey: { zh: '语音键不参与映射：在 SayAll「语音输入设置」里选输入工具（微信输入法 = 左Ctrl+左Win），按住说话松开出字。', en: 'The voice key is owned by SayAll.' },
      slotClick: { zh: '单击', en: 'Click' },
      slotDouble: { zh: '双击', en: 'Double' },
      slotHold: { zh: '长按', en: 'Hold' },
      none: { zh: '未设置', en: 'None' },
      custom: { zh: '自定义组合键…', en: 'Custom combo…' },
      customApp: { zh: '打开应用…', en: 'Open app…' },
      customPlaceholder: { zh: '组合键，如 Ctrl+Alt+N', en: 'Combo, e.g. Ctrl+Alt+N' },
      customAppPlaceholder: { zh: '应用名，如 Codex', en: 'App name, e.g. Codex' },
      save: { zh: '保存方案', en: 'Save' },
      saved: { zh: '已保存', en: 'Saved' },
      reset: { zh: '恢复默认方案', en: 'Reset to default' },
      resetDone: { zh: '已恢复默认方案', en: 'Reset' },
      saving: { zh: '保存中…', en: 'Saving…' },
      current: { zh: '当前默认录音设备', en: 'Current default recording device' },
      none2: { zh: '读不到当前默认设备', en: 'Default device unavailable' },
      setDefault: { zh: '设为默认录音设备', en: 'Set as default' },
      restore: { zh: '还原到上一个设备', en: 'Restore previous' },
      refresh: { zh: '刷新', en: 'Refresh' },
      applied: { zh: '已切到', en: 'Switched to' },
      restored: { zh: '已还原到', en: 'Restored to' },
      online: { zh: '在线', en: 'active' },
      offline: { zh: '未连接', en: 'offline' },
      default: { zh: '当前默认', en: 'default' },
      hint: { zh: '微信输入法等按系统默认录音设备收音：用哪条语音路径，就在这里切过去；不用了按「还原」。', en: 'Pick which path the IME listens to.' },
      err: { zh: '出错了', en: 'Error' },
      hostMissing: { zh: '宿主半段没加载（路由 404）—— 重启 DSH 后重试。', en: 'Host half missing (404).' },
      stateActive: { zh: '在线', en: 'active' },
      stateDisabled: { zh: '已禁用', en: 'disabled' },
      stateUnplugged: { zh: '未插入', en: 'unplugged' },
      stateNotPresent: { zh: '不存在', en: 'not present' },
      stateUnknown: { zh: '状态未知', en: 'unknown' },
    }
    const t = (key) => {
      const row = S[key]
      return row === undefined ? key : (zh ? row.zh : row.en)
    }
    const stateText = (state) => state === 'active' ? t('stateActive')
      : state === 'disabled' ? t('stateDisabled')
      : state === 'unplugged' ? t('stateUnplugged')
      : state === 'notpresent' ? t('stateNotPresent')
      : t('stateUnknown')

    const lsGet = (key) => { try { return window.localStorage.getItem(key) } catch (e) { return null } }
    const lsSet = (key, value) => { try { window.localStorage.setItem(key, String(value)) } catch (e) { /* 无痕模式 */ } }

    async function api(path, init) {
      let res
      try {
        res = await fetch(API + path, init)
      } catch (error) {
        return { ok: false, error: 'network', message: String((error && error.message) || error) }
      }
      const text = await res.text()
      if (text === '' || text.charAt(0) !== '{') {
        return { ok: false, error: res.status === 404 ? 'host-missing' : 'bad-response', status: res.status }
      }
      try { return JSON.parse(text) } catch (error) { return { ok: false, error: 'bad-json' } }
    }

    /**
     * 把接口返回的失败信息拼成一句能定位的话。
     *
     * 为什么不能只显示 result.error：2026-10-11 用户看到面板底部只有一句
     * "出错：unknown-action-type"，**不知道是哪个键、哪一档出的问题**，只能靠翻代码找。
     * 服务端在报错里其实带了 button / slot / type / id，这里一并拼出来。
     */
    function describeError(result) {
      const code = String((result && result.error) || '?')
      const bits = []
      if (result && result.button !== undefined) bits.push('按键=' + String(result.button))
      if (result && result.slot !== undefined) bits.push('档位=' + String(result.slot))
      if (result && result.type !== undefined) bits.push('类型=' + String(result.type))
      if (result && result.id !== undefined) bits.push('id=' + String(result.id))
      if (result && result.message !== undefined && result.message !== '') bits.push(String(result.message))
      return t('err') + '：' + code + (bits.length === 0 ? '' : '（' + bits.join('，') + '）')
    }
    const post = (path, body) => api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    })

    /* ── 图标与样式 ─────────────────────────────────────────────────────── */

    function RemoteIcon(props) {
      const size = (props && props.size) || 16
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, style: { display: 'block' },
      },
      h('rect', { x: 7.5, y: 2.5, width: 9, height: 19, rx: 3.2 }),
      h('circle', { cx: 12, cy: 7, r: 1.6 }),
      h('circle', { cx: 9.4, cy: 10.6, r: 1.1 }),
      h('circle', { cx: 14.6, cy: 10.6, r: 1.1 }),
      h('circle', { cx: 9.4, cy: 14.2, r: 1.1 }),
      h('circle', { cx: 14.6, cy: 14.2, r: 1.1 }),
      h('circle', { cx: 9.4, cy: 17.8, r: 1.1 }),
      h('circle', { cx: 14.6, cy: 17.8, r: 1.1 }))
    }

    /**
     * 指南页入口卡上的图标。官方 `IconProps` 只有 `{size, className}`，类型是**组件**
     * （`ComponentType<IconProps>`）；不提供时官方在卡上画方块占位符 —— 用户 2026-10-08
     * 说的「图标还没换」就是指那个占位符。
     *
     * 几何照抄 workdesktop 的 guideTile：28×28 画布、底板 25.6 圆角 7、白色图形走
     * `translate(4.8 4.8) scale(1.15)`（16×16 图形居中放大到约 55% 边长，与官方终端卡同一留白比例）。
     *
     * ⚠️ **底板必须写字面色值，不能用 CSS 令牌。**
     *    2026-10-08 实测：写成 `var(--dsw-alias-brand-primary)` 时，SVG 的 `fill` 上没解析出来，
     *    computed fill 退回 `rgb(15,17,21)` 近黑 —— 真机验收正是靠这条抓到的。
     *    后来这里又被换成了 `var(--wb2-bad)`（一个根本不存在的变量），等于把同一个 bug 放回去，
     *    `scripts/verify-render.mjs` 的两条断言因此一直红着。
     *    现在取**插件自己 icon.svg 的底板色 `#3f7bd8`** —— 指南卡与侧边栏那一行的图标同色。
     */
    const GUIDE_SIZE = 26   // 官方指南卡给 26（带描述）/ 22（只有标题）
    const GUIDE_PLATE = '#3f7bd8'   // 与 icon.svg 的渐变起色一致；字面值，不依赖令牌
    function GuideIcon(props) {
      const given = props === null || props === undefined ? {} : props
      const size = Number.isFinite(given.size) ? given.size : GUIDE_SIZE
      return h('svg', {
        width: size, height: size, viewBox: '0 0 28 28', fill: 'none', 'aria-hidden': true,
        className: given.className || undefined, 'data-dsmr-guide': 'remote',
      },
      h('rect', { key: 'plate', x: 1.2, y: 1.2, width: 25.6, height: 25.6, rx: 7, fill: GUIDE_PLATE }),
      h('g', {
        key: 'marks', transform: 'translate(4.8 4.8) scale(1.15)',
        stroke: '#fff', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
      h('rect', { key: 'body', x: 5, y: 1, width: 6, height: 14, rx: 2.4 }),
      h('circle', { key: 'd1', cx: 8, cy: 4.6, r: 1.1 }),
      h('circle', { key: 'd2', cx: 6.5, cy: 8.1, r: 0.8 }),
      h('circle', { key: 'd3', cx: 9.5, cy: 8.1, r: 0.8 }),
      h('circle', { key: 'd4', cx: 6.5, cy: 11.2, r: 0.8 }),
      h('circle', { key: 'd5', cx: 9.5, cy: 11.2, r: 0.8 })))
    }

    const STYLE_ID = 'dsh-mi-remote-style'
    const CSS = [
  /* ── 规范令牌（由 _meta/workbench/design-tokens.mjs 生成；令牌源改了要重跑 patch-remote-tokens.mjs）── */
  '--wb2-display:"WF Visual Sans Variable",Inter,system-ui,-apple-system,"Segoe UI",sans-serif;',
  '--wb2-serif:"WF Visual Sans Variable",Inter,system-ui,-apple-system,"Segoe UI",sans-serif;',
  '--wb2-sans:"WF Visual Sans Variable",Inter,system-ui,-apple-system,"Segoe UI",sans-serif;',
  '--wb2-mono:"WFVisualSans-Mono",Inconsolata,ui-monospace,SFMono-Regular,Consolas,monospace;',
  '--wb2-ease:cubic-bezier(.22,1,.36,1);',
  '--wb2-dur:520ms;',
  '--wb2-dur-fast:240ms;',
  '--wb2-sh1:none;',
  '--wb2-sh2:0 84px 24px rgba(0,0,0,0), 0 54px 22px rgba(0,0,0,0.01), 0 30px 18px rgba(0,0,0,0.04), 0 13px 13px rgba(0,0,0,0.08), 0 3px 7px rgba(0,0,0,0.09);',
  '--wb2-sh3:0 84px 24px rgba(0,0,0,0), 0 54px 22px rgba(0,0,0,0.01), 0 30px 18px rgba(0,0,0,0.05), 0 13px 13px rgba(0,0,0,0.10), 0 3px 7px rgba(0,0,0,0.12);',
  '--wb2-sh4:0 24px 24px rgba(0,0,0,0.26), 0 6px 13px rgba(0,0,0,0.29);',
  '--wb2-fs-display-xxl:80px;',
  '--wb2-fw-display-xxl:600;',
  '--wb2-lh-display-xxl:83.2px;',
  '--wb2-ls-display-xxl:-0.8px;',
  '--wb2-fs-display-xl:56px;',
  '--wb2-fw-display-xl:600;',
  '--wb2-lh-display-xl:58.24px;',
  '--wb2-ls-display-xl:0;',
  '--wb2-fs-display-lg:44.8px;',
  '--wb2-fw-display-lg:600;',
  '--wb2-lh-display-lg:46.6px;',
  '--wb2-ls-display-lg:0;',
  '--wb2-fs-display-md:32px;',
  '--wb2-fw-display-md:500;',
  '--wb2-lh-display-md:41.6px;',
  '--wb2-ls-display-md:0;',
  '--wb2-fs-display-sm:24px;',
  '--wb2-fw-display-sm:500;',
  '--wb2-lh-display-sm:31.2px;',
  '--wb2-ls-display-sm:0;',
  '--wb2-fs-display-xs:20px;',
  '--wb2-fw-display-xs:500;',
  '--wb2-lh-display-xs:28px;',
  '--wb2-ls-display-xs:0;',
  '--wb2-fs-eyebrow-uppercase:15px;',
  '--wb2-fw-eyebrow-uppercase:500;',
  '--wb2-lh-eyebrow-uppercase:19.5px;',
  '--wb2-ls-eyebrow-uppercase:1.5px;',
  '--wb2-fs-eyebrow-uppercase-sm:12px;',
  '--wb2-fw-eyebrow-uppercase-sm:500;',
  '--wb2-lh-eyebrow-uppercase-sm:12px;',
  '--wb2-ls-eyebrow-uppercase-sm:0.6px;',
  '--wb2-fs-body-lg:28.8px;',
  '--wb2-fw-body-lg:400;',
  '--wb2-lh-body-lg:46.08px;',
  '--wb2-ls-body-lg:-0.288px;',
  '--wb2-fs-body-md:16px;',
  '--wb2-fw-body-md:400;',
  '--wb2-lh-body-md:25.6px;',
  '--wb2-ls-body-md:-0.16px;',
  '--wb2-fs-body-md-strong:16px;',
  '--wb2-fw-body-md-strong:500;',
  '--wb2-lh-body-md-strong:25.6px;',
  '--wb2-ls-body-md-strong:-0.16px;',
  '--wb2-fs-body-sm:14px;',
  '--wb2-fw-body-sm:400;',
  '--wb2-lh-body-sm:22.4px;',
  '--wb2-ls-body-sm:0;',
  '--wb2-fs-body-sm-strong:14px;',
  '--wb2-fw-body-sm-strong:500;',
  '--wb2-lh-body-sm-strong:22.4px;',
  '--wb2-ls-body-sm-strong:0;',
  '--wb2-fs-caption:12.8px;',
  '--wb2-fw-caption:550;',
  '--wb2-lh-caption:15.36px;',
  '--wb2-ls-caption:0;',
  '--wb2-fs-caption-mono:12px;',
  '--wb2-fw-caption-mono:400;',
  '--wb2-lh-caption-mono:18px;',
  '--wb2-ls-caption-mono:0;',
  '--wb2-fs-button-md:16px;',
  '--wb2-fw-button-md:500;',
  '--wb2-lh-button-md:25.6px;',
  '--wb2-ls-button-md:-0.16px;',
  '--wb2-s-xxs:2px;',
  '--wb2-s-xs:4px;',
  '--wb2-s-sm:8px;',
  '--wb2-s-md:12px;',
  '--wb2-s-lg:16px;',
  '--wb2-s-xl:20px;',
  '--wb2-s-2xl:24px;',
  '--wb2-s-3xl:32px;',
  '--wb2-r-none:0px;',
  '--wb2-r-xs:2px;',
  '--wb2-r-sm:4px;',
  '--wb2-r-md:8px;',
  '--wb2-r-full:9999px;',
  '--wb2-r-lg:8px;',
  '--wb2-bg-body:#ffffff;',
  '--wb2-bg-page:#ffffff;',
  '--wb2-bg-subtle:rgba(8,8,8,0.03);',
  '--wb2-bg-raise:#ffffff;',
  '--wb2-fill:rgba(8,8,8,0.05);',
  '--wb2-fill-2:rgba(8,8,8,0.04);',
  '--wb2-line:#d8d8d8;',
  '--wb2-line-hair:rgba(8,8,8,0.08);',
  '--wb2-line-strong:rgba(8,8,8,0.2);',
  '--wb2-line-hover:rgba(8,8,8,0.34);',
  '--wb2-t1:#080808;',
  '--wb2-t2:#363636;',
  '--wb2-t3:#5a5a5a;',
  '--wb2-t4:#898989;',
  '--wb2-t5:#ababab;',
  '--wb2-press:rgba(8,8,8,0.09);',
  '--wb2-brand:#080808;',
  '--wb2-brand-hover:#222222;',
  '--wb2-brand-press:#080808;',
  '--wb2-brand-soft:rgba(8,8,8,0.06);',
  '--wb2-brand-soft-2:rgba(8,8,8,0.12);',
  '--wb2-brand-haze:rgba(8,8,8,0.04);',
  '--wb2-on-brand:#ffffff;',
  '--wb2-ok:#00d722;',
  '--wb2-ok-soft:rgba(0,215,34,0.12);',
  '--wb2-ok-line:rgba(0,215,34,0.24);',
  '--wb2-warn:#ffae13;',
  '--wb2-warn-soft:rgba(255,174,19,0.14);',
  '--wb2-bad:#ee1d36;',
  '--wb2-bad-soft:rgba(238,29,54,0.1);',
  '--wb2-bad-line:rgba(238,29,54,0.2);',
  '--wb2-bad-line-2:rgba(238,29,54,0.34);',
  '--wb2-info:#146ef5;',
  '--wb2-info-soft:rgba(20,110,245,0.1);',
  '--wb2-link:#006acc;',
  '--wb2-cat-purple:#7a3dff;',
  '--wb2-cat-pink:#ed52cb;',
  '--wb2-cat-blue:#3b89ff;',
  '--wb2-cat-orange:#ff6b00;',
  '--wb2-cat-green:#00d722;',
  '--wb2-cat-green-ink:#080808;',
  '--wb2-hit:rgba(8,8,8,0.34);',
  '--wb2-hit-0:rgba(8,8,8,0);',
  '--wb2-sel-fg:#ffffff;',
  '--wb2-mask:rgba(8,8,8,0.4);',
  '--wb2-mask-2:rgba(8,8,8,0.32);',
  '--wb2-mask-3:rgba(8,8,8,0.5);',
  '--wb2-tex:none;',
  '--wb2-accent:#080808;',
  '--wb2-accent-hover:#222222;',
  /* ── 以下别名把宿主那 9 个 --dsw-alias-* 指到规范令牌：**作用域仅 .dsmr-root**，不动宿主全局 ── */
      /*
       * 右边被裁的问题（2026-10-11 用户截图反馈）：
       * 内容是"遥控器图 + 两列卡片 + 状态列"，比视口高，于是 .dsmr-root 出现竖直滚动条；
       * 滚动条一出现就吃掉十几像素宽度，而里面的栅格是按 100% 算好的 —— 结果最右边的
       * 状态卡片被压出容器外、贴着边裁掉。三处一起改：
       *   ① scrollbar-gutter: stable —— 一开始就把滚动条的位置留出来，宽度不再跳
       *   ② 状态列允许收缩（minmax(0,250px)）而不是硬占 250px
       *   ③ 右侧内边距加大，卡片和边界之间留出可见间隔
       */
      '.dsmr-root{display:flex;flex-direction:column;gap:10px;padding:12px 34px 20px 16px;min-height:0;overflow-y:auto;overflow-x:hidden;scrollbar-gutter:stable;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55;--dsw-alias-bg-base:var(--wb2-bg-body);--dsw-alias-bg-layer-1:var(--wb2-bg-raise);--dsw-alias-bg-layer-2:var(--wb2-bg-subtle);--dsw-alias-bg-overlay:var(--wb2-bg-raise);--dsw-alias-border-l1:var(--wb2-line);--dsw-alias-border-l2:var(--wb2-line-strong);--dsw-alias-brand-primary:var(--wb2-brand);--dsw-alias-label-primary:var(--wb2-t1);--dsw-alias-label-secondary:var(--wb2-t2);color:var(--wb2-t1);font-family:var(--wb2-sans)}',
      '.dsmr-sub{padding:9px 11px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dsmr-sec-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:2px}',
      /* 状态列：**一列排下来**（用户 2026-10-11 明确要求，之前是 1fr 1fr 两列） */
      '.dsmr-links{display:grid;grid-template-columns:1fr;gap:6px}',
      '.dsmr-link{display:flex;gap:8px;align-items:flex-start;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1);min-width:0;box-sizing:border-box;overflow:hidden}',
      '.dsmr-link[data-ok="1"]{border-color:var(--dsw-alias-brand-primary)}',
      '.dsmr-link-name{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600}',
      '.dsmr-link-state{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.dsmr-link-state[data-ok="1"]{color:var(--dsw-alias-brand-primary)}',
      '.dsmr-link-how{color:var(--dsw-alias-label-secondary);font-size:11px;margin-top:3px}',
      '.dsmr-dot{flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-border-l2);margin-top:5px}',
      '.dsmr-dot[data-ok="1"]{background:var(--dsw-alias-brand-primary)}',
      // ── 图形化映射编辑器的样式（2026-10-08）：设备行 / 遥控器图形 / 按键卡片 / 内联输入 ──
      // ── 按键桥区（设备列表 / 学习结果）──
      '.dsmr-devlist{margin-top:6px;display:flex;flex-direction:column;gap:3px}',
      '.dsmr-devitem{display:flex;align-items:center;gap:6px;padding:4px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-1);font-size:11px}',
      '.dsmr-devitem[data-xiaomi="1"]{border-color:var(--dsw-alias-brand-primary)}',
      '.dsmr-devtag{flex:none;padding:0 4px;border-radius:5px;background:var(--dsw-alias-brand-primary);color:#fff;font-size:10px}',
      '.dsmr-learnbox{margin-top:6px;display:flex;flex-direction:column;gap:3px}',
      '.dsmr-learnrow{display:flex;align-items:center;gap:8px;font-size:11px;padding:3px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-1)}',
      '.dsmr-learnhex{flex:none;min-width:74px;color:var(--dsw-alias-label-primary)}',
      '.dsmr-keypick{flex:none;max-width:104px;padding:2px 4px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px}',
      '.dsmr-switchrow{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.dsmr-switchrow input{width:14px;height:14px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}',
      '.dsmr-guidebox{margin-top:6px;padding:8px;border:1px solid var(--dsw-alias-brand-primary);border-radius:10px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:5px}',
      '.dsmr-guide-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);text-align:center}',
      '.dsmr-devrow{display:flex;align-items:center;gap:7px;padding:7px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1);font-size:12px}',
      '.dsmr-devname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}',
      '.dsmr-devstate{color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}',
      '.dsmr-devstate[data-on="1"]{color:var(--dsw-alias-brand-primary)}',
      '.dsmr-figurewrap{padding:10px 0 4px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
      '.dsmr-fighint{color:var(--dsw-alias-label-secondary);font-size:11px;text-align:center;margin-top:2px}',
      '.dsmr-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(228px,1fr));gap:8px}',
      /*
       * 按键映射的三块：**左卡片 / 遥控器图 / 右卡片**（用户 2026-10-08：排布到图示左右两边）。
       *
       * 两栏内部用 **grid auto-fit** 而不是单列 —— 用户 2026-10-08 反馈竖着一列太长，
       * 要"自适应排布、保证最小宽度，2~3 排最好看"。每张卡最小 150px：
       * 面板每栏 ~470px 时正好落 3 列，~340px 落 2 列，再窄退回 1 列，永远不出横向滚动条。
       * 外面那层仍用 flex + wrap 按**面板实际可用宽度**决定两栏是否落到图下面
       *（媒体查询量的是视口不是面板，在这里不适用）。
       */
      /* 面板主版式：最左遥控器图 → 中间两列卡片 → 最右状态列（用户 2026-10-11 指定）。
         状态列要**撑满、和遥控器图等高**，所以这里用 stretch，由 .dsmr-statussec 自己长满。
         窄栏时状态列落到下面，避免把卡片和遥控器挤没。 */
      '.dsmr-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,250px);gap:14px;align-items:stretch;min-width:0}',
      '.dsmr-layout>*{min-width:0;max-width:100%}',
      '@media (max-width: 860px){.dsmr-layout{grid-template-columns:minmax(0,1fr)}}',
      /* 状态列：纵向撑满，和左边遥控器图等高。
         高度分配照用户 2026-10-11 的要求：**前三张按内容自适应，最后一张（语音输入路径）吃掉剩余**。
         原来是一律 grid-auto-rows:1fr 平分，结果前几张空一大截、路径那张又不够放设备列表。 */
      '.dsmr-statussec{display:flex;flex-direction:column;height:100%;min-width:0;padding-right:6px}',
      '.dsmr-statussec .dsmr-links{flex:1 1 auto;display:flex;flex-direction:column;gap:6px;min-width:0;min-height:0}',
      '.dsmr-statussec .dsmr-link{flex:0 0 auto}',
      '.dsmr-statussec .dsmr-link-flex{flex:1 1 auto;min-height:0;overflow:auto}',
      /* 语音路径卡里的设备列表：竖排紧凑行 */
      '.dsmr-lanebody{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.dsmr-lanelist{display:flex;flex-direction:column;gap:3px;min-width:0}',
      '.dsmr-lanerow{display:flex;flex-direction:column;gap:1px;text-align:left;font:inherit;color:inherit;cursor:pointer;padding:5px 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-1);min-width:0}',
      '.dsmr-lanerow:hover{border-color:var(--dsw-alias-border-l2)}',
      '.dsmr-lanerow[data-on="1"]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}',
      '.dsmr-lanerow[data-off="1"]{opacity:.55}',
      '.dsmr-lanerow-name{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}',
      '.dsmr-lanerow-desc{font-size:10.5px;line-height:1.4;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
      '.dsmr-actions-tight{gap:5px;margin-top:2px}',
      '.dsmr-actions-tight .dsmr-btn{padding:4px 8px;font-size:11px}',
      '.dsmr-tiny{font-size:10.5px;line-height:1.45}',
      /* 状态卡里的参数行（label 固定宽、value 占满）。
         类名用 dsmr-kvrow 而不是 dsmr-kv —— 后者是别处已有的类，会互相覆盖。 */
      '.dsmr-link-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px}',
      '.dsmr-kvlist{display:flex;flex-direction:column;gap:3px;margin-top:2px;min-width:0}',
      '.dsmr-kvrow{display:grid;grid-template-columns:34px minmax(0,1fr);gap:6px;align-items:start;font-size:11px;line-height:1.45;min-width:0}',
      '.dsmr-kvrow .dsmr-kv-k{color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.dsmr-kvrow .dsmr-kv-v{color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;min-width:0}',
      '.dsmr-maplayout{display:grid;grid-template-columns:auto minmax(0,1fr);gap:14px;align-items:start}',
      '.dsmr-cardcols{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;align-content:start}',
      '.dsmr-cardcol{display:grid;grid-template-columns:1fr;gap:8px;align-content:start;min-width:0}',
      '.dsmr-cardcol .dsmr-card{padding:10px 12px;gap:6px}',
      /* 卡片高度 +18%（用户 2026-10-11 要求）。按原来约 112px 算，118% ≈ 132px。
         用 min-height 而不是加 padding，是为了让 12 张卡一样高、跟遥控器图对齐。 */
      '.dsmr-cardcol .dsmr-card{min-height:132px;justify-content:space-between}',
      '.dsmr-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:8px 9px;display:flex;flex-direction:column;gap:5px}',
      '.dsmr-card[data-on="1"]{border-color:var(--dsw-alias-brand-primary)}',
      '.dsmr-card-head{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dsmr-card-glyph{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:20px;padding:0 4px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dsmr-card-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsmr-card-row{display:grid;grid-template-columns:34px 1fr;align-items:center;gap:6px}',
      '.dsmr-card-slot{color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.dsmr-card-action{width:100%;text-align:left;padding:4px 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsmr-card-action[data-set="0"]{color:var(--dsw-alias-label-secondary)}',
      '.dsmr-card-action:hover{border-color:var(--dsw-alias-border-l2)}',
      '.dsmr-inline{display:flex;align-items:center;gap:6px}',
      '.dsmr-inline-label{color:var(--dsw-alias-label-secondary);font-size:11.5px;white-space:nowrap}',
      '.dsmr-table{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}',
      '.dsmr-tr{display:grid;grid-template-columns:88px 1fr 1fr 1fr}',
      '.dsmr-tr+ .dsmr-tr{border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dsmr-th,.dsmr-td{padding:5px 8px;font-size:12px;display:flex;align-items:center;min-width:0}',
      '.dsmr-th{color:var(--dsw-alias-label-secondary);font-weight:500;background:var(--dsw-alias-bg-layer-2)}',
      '.dsmr-td+.dsmr-td,.dsmr-th+.dsmr-th{border-left:1px solid var(--dsw-alias-border-l1)}',
      '.dsmr-btn-cell{width:100%;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;padding:4px 5px;cursor:pointer;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsmr-btn-cell:hover{border-color:var(--dsw-alias-border-l2)}',
      '.dsmr-btn-cell[data-set="1"]{color:var(--dsw-alias-label-primary)}',
      '.dsmr-btn-cell[data-set="0"]{color:var(--dsw-alias-label-secondary)}',
      '.dsmr-combo-input{width:100%;border:1px solid var(--dsw-alias-brand-primary);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit;font-size:11.5px;padding:4px 6px;outline:none}',
      '.dsmr-actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center}',
      /* 整行可点的那种行（点开上层页面）：给出可点的手感，键盘也能进 */
      '.dsmr-clickrow{cursor:pointer;border-radius:8px;padding:4px 6px;margin:0 -6px}',
      '.dsmr-clickrow:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsmr-clickrow:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      /* 蓝牙设备列表（点"遥控器"那张未就绪的卡之后出现）：一行一个可点按钮 */
      '.dsmr-btlist{display:flex;flex-direction:column;gap:4px;margin-top:6px}',
      '.dsmr-btitem{text-align:left;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      /* "点这张卡即可处理"那句提示：弱一点，别抢状态本身的注意力 */
      '.dsmr-link-how .dsmr-tiny{display:block;margin-bottom:2px}',
      '.dsmr-enterrow{display:flex;align-items:center;gap:9px;flex-wrap:wrap}',
      /*
       * 按钮：照 dsh-workdesktop 的规范（2026-09-25 第七轮 · 用户原话「列表页的按钮需要改为橙色背景」）
       * —— 主导按钮 = 实心橙 var(--wb2-brand) + 白字；次要按钮 = 中性白面；不抢戏的用 ghost。
       * 圆角 9px 与它同规格（它那套是 9–10px）。
       */
      '.dsmr-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;padding:6px 12px;border-radius:9px;border:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap}',
      '.dsmr-btn:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsmr-btn:disabled{opacity:.5;cursor:default}',
      '.dsmr-btn[data-variant="primary"]{border-color:transparent;background:var(--wb2-brand);color:#fff;font-weight:500}',
      '.dsmr-btn[data-variant="primary"]:hover{background:var(--wb2-brand-hover)}',
      '.dsmr-btn[data-variant="ghost"]{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}',
      '.dsmr-btn[data-variant="ghost"]:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dsmr-note{padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dsmr-list{display:flex;flex-direction:column;gap:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}',
      '.dsmr-row{display:flex;align-items:center;gap:8px;padding:8px 10px;border:0;background:transparent;text-align:left;cursor:pointer;color:inherit;font:inherit;width:100%}',
      '.dsmr-row:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsmr-row[data-on="1"]{background:var(--dsw-alias-bg-layer-2)}',
      '.dsmr-row[data-off="1"]{opacity:.55}',
      '.dsmr-radio{flex:0 0 auto;width:14px;height:14px;border-radius:50%;border:1.5px solid var(--dsw-alias-border-l2);position:relative}',
      '.dsmr-row[data-on="1"] .dsmr-radio{border-color:var(--dsw-alias-brand-primary)}',
      '.dsmr-row[data-on="1"] .dsmr-radio::after{content:"";position:absolute;inset:2.5px;border-radius:50%;background:var(--dsw-alias-brand-primary)}',
      '.dsmr-row-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.dsmr-row-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsmr-row-meta{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.dsmr-badge{display:inline-flex;align-items:center;padding:1px 7px;border-radius:99px;font-size:11px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.dsmr-badge[data-tone="brand"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.dsmr-status{display:flex;align-items:center;gap:7px;color:var(--dsw-alias-label-secondary);font-size:11px}',
      // 左侧栏底部那一行：**结构与样式与 workdesktop 那 5 行完全同构**（照抄它的 .dshw-wsrow 系列，
      // 只改前缀），因为用户 2026-10-08 裁定「遥控器/工作台/驾驶舱/坐标系/工程图/建模中心 要在同一列、
      // 垂直排列」。任何视觉差异（多一个状态点、不同的 padding/字号/令牌名）都会让它看起来不像同一列。
      '.dsmr-wsrows{display:flex;flex-direction:column;gap:4px;width:100%;padding:2px 0 4px}',
      '.dsmr-wsrow{display:flex;align-items:center;gap:8px;width:100%;min-height:36px;padding:7px 8px;box-sizing:border-box;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;line-height:22px;text-align:left;cursor:pointer}',
      '.dsmr-wsrow:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsmr-wsrow--rail{width:36px;height:36px;min-height:36px;justify-content:center;padding:0;color:var(--dsw-alias-label-primary)}',
      '.dsmr-wsrow:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:-2px}',
      '.dsmr-wsic{flex:none;display:inline-flex;align-items:center;justify-content:center}',
      '.dsmr-wsname{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}',
      '.dsmr-overlay{position:fixed;inset:0;z-index:60;display:flex;justify-content:flex-end;background:color-mix(in srgb, var(--dsw-alias-bg-layer-2) 55%, transparent)}',
      '.dsmr-overlay-card{width:min(460px,94vw);height:100%;overflow:auto;border-left:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}',
      '.dsmr-overlay-head{position:sticky;top:0;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}',
      '.dsmr-title{font-size:14px;font-weight:600}',
      /*
       * ── 上层页面（弹窗）────────────────────────────────────────────────
       * 结构照 dsh-workdesktop 的 .dshw-modal* 那一套（用户 2026-10-08 要求"按工作台风格"）：
       * 全屏遮罩 + 居中卡片 + 头部/正文/分区。z-index 要压过右栏、指南页与对话框。
       */
      '.dsmr-backdrop{position:fixed;inset:0;z-index:2000000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(8,10,14,.55)}',
      '.dsmr-modal{box-sizing:border-box;width:min(560px,94vw);max-height:84vh;display:flex;flex-direction:column;border:0.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-overlay);box-shadow:0 18px 48px rgba(0,0,0,.42);overflow:hidden}',
      '.dsmr-modal[data-wide="1"]{width:min(680px,96vw)}',
      '.dsmr-modal-head{display:flex;align-items:baseline;gap:8px;padding:11px 13px 9px;border-bottom:0.5px solid var(--dsw-alias-border-l1)}',
      '.dsmr-modal-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dsmr-modal-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.dsmr-modal-x{margin-left:auto;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:15px;line-height:1;padding:3px 7px;border-radius:7px;cursor:pointer}',
      '.dsmr-modal-x:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dsmr-modal-body{overflow:auto;padding:11px 13px 13px;display:flex;flex-direction:column;gap:10px}',
      '.dsmr-modal-foot{display:flex;align-items:center;gap:8px;padding:9px 13px 11px;border-top:0.5px solid var(--dsw-alias-border-l1)}',
      '.dsmr-sec-box{border:0.5px solid var(--dsw-alias-border-l1);border-radius:9px;padding:9px 11px;background:var(--dsw-alias-bg-layer-1)}',
      '.dsmr-sec-h{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.04em;margin-bottom:6px}',
      /* 交互文字（能点的）与说明文字（只能读的）分开：前者主文字色，后者次级色 + 更小字号 + 行高放松。 */
      '.dsmr-hint{margin:0;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
      '.dsmr-hint strong{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.dsmr-act{font-size:12.5px;color:var(--dsw-alias-label-primary)}',
      '.dsmr-kv{display:flex;align-items:baseline;gap:8px;font-size:12px}',
      '.dsmr-kv-k{flex:0 0 auto;color:var(--dsw-alias-label-secondary)}',
      '.dsmr-kv-v{min-width:0;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      /* ── 按键录制：点一下开始听，按下键就识别 ── */
      '.dsmr-recorder{display:flex;flex-direction:column;align-items:center;gap:7px;padding:15px 12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;text-align:center;outline:none}',
      '.dsmr-recorder:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-brand-primary)}',
      '.dsmr-recorder[data-live="1"]{border-style:solid;border-color:var(--wb2-brand)}',
      '.dsmr-recorder-key{font-size:19px;font-weight:600;color:var(--dsw-alias-label-primary);letter-spacing:.02em;min-height:25px;word-break:break-all}',
      '.dsmr-recorder-tip{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      /* ── 预设选择：一行一个，选中的描边高亮 ── */
      '.dsmr-picks{display:flex;flex-direction:column;gap:4px;max-height:224px;overflow:auto}',
      '.dsmr-pick{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:6px 9px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer}',
      '.dsmr-pick:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsmr-pick[data-on="1"]{border-color:var(--dsw-alias-brand-primary)}',
      '.dsmr-pick-combo{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}',
      /* ── 语音输入路径：横向卡片、点击切换 ── */
      '.dsmr-lane{display:flex;gap:8px;flex-wrap:wrap}',
      '.dsmr-lane-card{flex:1 1 0;min-width:134px;display:flex;flex-direction:column;gap:5px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.dsmr-lane-card:hover{border-color:var(--dsw-alias-border-l2)}',
      '.dsmr-lane-card[data-on="1"]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}',
      '.dsmr-lane-name{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dsmr-lane-desc{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
    ].join('\n')

    function ensureStyle() {
      let el = document.getElementById(STYLE_ID)
      if (el === null) {
        el = document.createElement('style')
        el.id = STYLE_ID
        document.head.appendChild(el)
      }
      /*
       * ⚠️ 必须**无条件把内容对齐到当前 CSS**，不能"已存在就 return"。
       *
       * 原来那句 `if (getElementById(STYLE_ID) !== null) return` 让所有样式改动都失效：
       * DSH 的 HMR 会重新加载本模块，但**已经插进 <head> 的那个 <style> 还是旧的**，
       * ensureStyle 一看元素在就直接返回，新的 CSS 根本没机会写进去。
       * 结果就是"改了样式、页面刷新了、看起来纹丝不动" —— 2026-10-11 花了好几轮才定位到。
       */
      if (el.textContent !== CSS) el.textContent = CSS
    }

    /* ── 数据钩子 ───────────────────────────────────────────────────────── */

    function usePoll(path, intervalMs) {
      const [state, setState] = React.useState({ phase: 'loading', data: null })
      const load = React.useCallback((force) => {
        setState((prev) => ({ phase: prev.data === null ? 'loading' : 'refreshing', data: prev.data }))
        api(path + (force === true ? (path.includes('?') ? '&' : '?') + 'force=1' : '')).then((result) => {
          if (result && result.ok === true) setState({ phase: 'ready', data: result })
          else setState({ phase: 'error', data: null })
        })
      }, [path])
      React.useEffect(() => {
        load(false)
        const tick = window.setInterval(() => { if (!document.hidden) load(false) }, intervalMs || 8000)
        return () => { window.clearInterval(tick) }
      }, [load, intervalMs])
      /*
       * 读的时候容一手 undefined：离线渲染桩是按"渲染顺序"用全局数组分配 hook 的，
       * 树结构一剧烈变化（比如弹窗开了又关）后面的组件会错位、这里就拿到 undefined。
       * 真 React 不会这样，但防御一下没有任何代价。
       */
      return [state === undefined || state === null ? { phase: 'loading', data: null } : state, load]
    }

    /* ── 一、链路体检 ────────────────────────────────────────────────────── */

    function LinkSection() {
      const [state, load] = usePoll('/link', 10000)
      const [voiceState] = usePoll('/voice/status', 8000)
      const data = state.data
      /*
       * 状态列的内容与顺序照用户 2026-10-11 指定：
       *   遥控器状态（含电量）/ VB-CABLE / 输入法 / 语音输入路径。
       * 「无线麦 SayAll」那一项按要求移除（改用哪边由语音浮层里的「语音独占」决定）。
       */
      const rows = data === null ? [] : [
        { key: 'remote', name: t('remoteName') },
        { key: 'cable', name: t('cableName') },
        { key: 'wetype', name: t('wetypeName') },
      ]
      const readyCount = rows.filter((row) => data && data.link && data.link[row.key] && data.link[row.key].ok).length
      const vdata = voiceState.data
      const vcurrent = vdata !== null && vdata !== undefined && vdata.current ? vdata.current : null
      // 当前默认录音设备在设备列表里的那一条（拿它的在线状态、是否默认、来源）
      const vlist = vdata !== null && vdata !== undefined && Array.isArray(vdata.devices) ? vdata.devices : []
      const rseg = data !== null && data !== undefined && data.link ? data.link.remote : null
      // 注意这里一律把 undefined 收成 null：桩数据/旧版 host 都可能没有这些字段，
      // 只判 null 的话 undefined 会漏过去，渲染时直接 TypeError（verify-render 抓到过）。
      const battery = rseg === null || rseg === undefined || rseg.battery === undefined ? null : rseg.battery
      const bridge = rseg === null || rseg === undefined || rseg.bridge === undefined ? null : rseg.bridge
      const rdevice = rseg !== null && rseg !== undefined && Array.isArray(rseg.devices) && rseg.devices.length > 0
        ? rseg.devices[0] : null

      /*
       * ── 「状态卡点了就能修」（2026-10-11 用户要求）────────────────────────────
       *
       * 用户原话：「设备如果是未连接状态，则默认显示可连接设备，点击链接；
       *            采集器/引擎如果是未运行状态，点击之后开始运行；
       *            VB-CABLE 卡片中同样，如果状态是离线，则点击之后加载激活」
       *
       * 三件事的难度差得很远，如实记着：
       *   · 采集器/引擎 → 复用 `POST /bridge/auto`，最省事也最可靠；
       *   · VB-CABLE    → `POST /cable/activate`，能修"设备被禁用"那一类；
       *                   **装驱动那一步做不了**（要管理员 + 安装包），
       *                   后端会回 `action:'install'`，界面照着如实说，不假装成功；
       *   · 遥控器连接  → `POST /bt/scan` + `/bt/pair`。**搜索要十几秒**（蓝牙主动搜索），
       *                   所以必须有"搜索中…"的状态，否则用户以为卡死了。
       */
      const [fixKind, setFixKind] = React.useState(null)   // 'bridge' | 'cable' | 'bt' | null
      const [fixMsg, setFixMsg] = React.useState(null)
      const [btDevices, setBtDevices] = React.useState(null)
      const [btNote, setBtNote] = React.useState(null)

      /** 把按键链路拉起来（采集器 + 引擎）。 */
      const fixBridge = async () => {
        setFixKind('bridge'); setFixMsg(null)
        const result = await post('/bridge/auto', {})
        if (result === null || result === undefined || result.ok !== true) {
          setFixMsg('没起来：' + String((result && (result.hint || result.error)) || '未知原因'))
        } else {
          setFixMsg(result.reused === true ? '引擎已在运行' : '已启动')
        }
        setFixKind(null)
        load()
      }

      /** 让 VB-CABLE 回到可用状态。 */
      const fixCable = async () => {
        setFixKind('cable'); setFixMsg(null)
        const result = await post('/cable/activate', {})
        if (result === null || result === undefined) { setFixMsg('没拿到结果'); setFixKind(null); return }
        if (result.ok === true) {
          setFixMsg(result.fixed && result.fixed.length > 0 ? ('已启用：' + result.fixed.join('、')) : 'CABLE 可用')
        } else {
          // 如实转达后端的话 —— 尤其是"装驱动那一步我做不了"这种情况
          setFixMsg(String(result.message || result.howto || '没修好'))
        }
        setFixKind(null)
        load()
      }

      /** 搜可连接的蓝牙设备。**会很慢**（十几秒），所以有专门的等待状态。 */
      const scanBt = async () => {
        setFixKind('bt'); setBtNote('正在搜索附近的设备…（蓝牙主动搜索，要十几秒）'); setBtDevices(null)
        const result = await post('/bt/scan', {})
        if (result === null || result === undefined || result.ok !== true) {
          setBtNote('搜索失败：' + String((result && result.error) || '未知原因'))
          setFixKind(null)
          return
        }
        setBtDevices(result)
        if (result.unpairedTimedOut === true) {
          setBtNote('没搜到新设备（搜索超时）。确认遥控器已进配对模式：长按「菜单 + 主页」')
        } else if ((result.unpaired || []).length === 0 && (result.pairedOffline || []).length === 0) {
          setBtNote('没搜到设备。遥控器要先长按「菜单 + 主页」进配对模式')
        } else {
          setBtNote(null)
        }
        setFixKind(null)
      }

      /** 配对或连接一个设备。 */
      const pairBt = async (device) => {
        setFixKind('bt'); setBtNote('正在连接 ' + device.name + ' …')
        const result = await post('/bt/pair', { id: device.id, alreadyPaired: device.paired === true })
        if (result !== null && result !== undefined && result.ok === true) {
          setBtNote('已连上 ' + String(result.name || device.name))
          setBtDevices(null)
          load()
        } else {
          setBtNote('没连上：' + String((result && (result.hint || result.status || result.error)) || '未知原因'))
        }
        setFixKind(null)
      }

      /**
       * 状态卡里的一行"参数"。状态卡不能只有一句"就绪" —— 用户 2026-10-11 要求把
       * 具体参数也摆出来。label 固定宽度，value 占满剩余。
       *
       * `action` 给了就变成可点行（用于「采集器 / 引擎」那两行：未运行时点一下即启动）。
       */
      const kv = (label, value, key, action) => h('div', {
        className: 'dsmr-kvrow' + (action !== undefined && action !== null ? ' dsmr-clickrow' : ''),
        key: key === undefined ? label : key,
        ...(action !== undefined && action !== null
          ? {
            role: 'button', tabIndex: 0, onClick: action,
            onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); action() } },
          }
          : {}),
      },
      h('span', { className: 'dsmr-kv-k' }, label),
      h('span', { className: 'dsmr-kv-v' }, value === null || value === undefined || value === '' ? '—' : String(value)))

      return h('div', { className: 'dsmr-sec dsmr-statussec', 'data-dsmr-sec': 'link' },
        h('div', { className: 'dsmr-sec-head' },
          h('span', null, '状态'),
          h('span', null, data === null ? '' : readyCount + ' / ' + String(rows.length))),
        state.phase === 'error'
          ? h('div', { className: 'dsmr-note', 'data-dsmr-error': '1' }, state.data === null && t('hostMissing'))
          : null,
        data === null ? h('div', { className: 'dsmr-note' }, '…') : h('div', { className: 'dsmr-links' },
          rows.map((row) => {
            const seg = (data.link && data.link[row.key]) || { ok: false, state: 'missing', howto: '' }
            const dev = Array.isArray(seg.devices) && seg.devices.length > 0 ? seg.devices[0] : null
            const bad = seg.ok !== true
            /*
             * 未就绪时这张卡可点（用户 2026-10-11 要求）。点哪个键做什么：
             *   remote → 搜附近的蓝牙设备并列出（选一个就能连）
             *   cable  → 让 VB-CABLE 回到可用
             *   wetype → 没得修（输入法得用户自己装/开），所以**不给点击形态**，
             *            免得点了一下什么都不发生，反而像坏了
             */
            const canFix = bad && (row.key === 'remote' || row.key === 'cable')
            const busy = fixKind !== null && ((row.key === 'remote' && fixKind === 'bt') || (row.key === 'cable' && fixKind === 'cable'))
            const onFix = row.key === 'remote' ? scanBt : row.key === 'cable' ? fixCable : null
            return h('div', {
              className: 'dsmr-link' + (canFix ? ' dsmr-clickrow' : ''),
              key: row.key,
              'data-ok': seg.ok === true ? '1' : '0',
              'data-dsmr-link': row.key,
              'data-dsmr-fixable': canFix ? '1' : '0',
              ...(canFix ? {
                role: 'button', tabIndex: 0, onClick: onFix,
                onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onFix() } },
              } : {}),
            },
              h('span', { className: 'dsmr-dot', 'data-ok': seg.ok === true ? '1' : '0' }),
              h('div', { className: 'dsmr-link-body' },
                h('div', { className: 'dsmr-link-name' }, row.name,
                  h('span', { className: 'dsmr-link-state', 'data-ok': seg.ok === true ? '1' : '0' },
                    busy ? '处理中…'
                      : seg.ok === true ? t('ready')
                        : seg.state === 'installed-not-running' ? t('installedNotRunning') : t('missing'))),
                /* 遥控器：设备名 / 电量 / 按键链路两段（后两行未运行时点了就启动） */
                row.key === 'remote' ? h('div', { className: 'dsmr-kvlist' },
                  kv('设备', rdevice === null ? null : rdevice.name),
                  kv('电量', battery === null || battery === undefined ? '未读取' : String(battery) + '%'),
                  kv('采集器', bridge === null ? '—' : (bridge.collector === true ? '运行中' : '未运行'),
                    'collector', bridge !== null && bridge.collector !== true ? fixBridge : null),
                  kv('引擎', bridge === null ? '—' : (bridge.engine === true ? '运行中' : '未运行'),
                    'engine', bridge !== null && bridge.engine !== true ? fixBridge : null)) : null,
                /* VB-CABLE：设备名 / 方向 / 状态 / 序号 */
                row.key === 'cable' ? h('div', { className: 'dsmr-kvlist' },
                  kv('设备', dev === null ? null : dev.name),
                  kv('方向', dev === null ? null : (dev.flow === 'capture' ? '录音端' : String(dev.flow))),
                  kv('状态', dev === null ? null : (dev.state === 'active' ? '在线' : String(dev.state))),
                  kv('序号', dev === null ? null : dev.index)) : null,
                /* 输入法：进程列表 */
                row.key === 'wetype' ? h('div', { className: 'dsmr-kvlist' },
                  kv('进程', Array.isArray(seg.process) && seg.process.length > 0 ? seg.process.length + ' 个' : null),
                  kv('明细', Array.isArray(seg.process) && seg.process.length > 0 ? seg.process.join(' · ') : null)) : null,
                bad ? h('div', { className: 'dsmr-link-how' },
                  canFix ? h('span', { className: 'dsmr-tiny' }, '点这张卡即可处理。') : null,
                  h('span', null, seg.howto)) : null))
          }),
          /*
           * 处理失败/成功的反馈。**后端说什么就转达什么** ——
           * 尤其 VB-CABLE"装驱动那一步做不了"，不能显示成"已修复"。
           */
          fixMsg === null ? null : h('div', { className: 'dsmr-note dsmr-tiny', 'data-dsmr-fixmsg': '1' }, fixMsg),
          /* 蓝牙设备列表（点遥控器卡之后出现） */
          btNote === null ? null : h('div', { className: 'dsmr-note dsmr-tiny', 'data-dsmr-btnote': '1' }, btNote),
          btDevices === null ? null : (() => {
            const list = [].concat(
              (btDevices.unpaired || []).map((d) => ({ ...d, paired: false })),
              (btDevices.pairedOffline || []).map((d) => ({ ...d, paired: true })))
            if (list.length === 0) return null
            // 像遥控器的排前面（名字里有 MI RC / Xiaomi / 小米 / 遥控 / Remote）
            list.sort((a, b) => (b.likely === true ? 1 : 0) - (a.likely === true ? 1 : 0))
            return h('div', { className: 'dsmr-btlist', 'data-dsmr-btlist': '1' },
              list.map((d) => h('button', {
                type: 'button', className: 'dsmr-btn dsmr-btitem', key: d.id,
                'data-dsmr-btdev': d.id,
                onClick: () => { void pairBt(d) },
              }, (d.likely === true ? '★ ' : '') + d.name + (d.paired === true ? '（已配对，点一下连上）' : '（未配对，点一下配对）'))))
          })(),
          /*
           * 语音输入路径卡：设备列表直接放在卡里（用户 2026-10-11 要求从浮层搬出来），
           * 所以这不再是个"点开才有的东西"，也不需要浮层。它是状态列里最高的一张，撑满剩余高度。
           */
          h('div', { className: 'dsmr-link dsmr-link-flex', 'data-dsmr-link': 'voicelane',
            'data-ok': vcurrent === null ? '0' : '1' },
          h('span', { className: 'dsmr-dot', 'data-ok': vcurrent === null ? '0' : '1' }),
          h('div', { className: 'dsmr-link-body' },
            h('div', { className: 'dsmr-link-name' }, '语音输入路径',
              h('span', { className: 'dsmr-link-state', 'data-ok': vcurrent === null ? '0' : '1' },
                vcurrent === null ? '未选' : '已选')),
            h(VoiceLanePanel, null)))))
    }

    /* ── 二、按键映射编辑器 ─────────────────────────────────────────────── */

    const BUTTON_LABELS = {
      ok: 'OK / 确定', up: '上', down: '下', left: '左', right: '右',
      back: '返回', home: '主页', menu: '菜单', tv: 'TV', power: '电源',
      volup: '音量 +', voldown: '音量 −',
      voice: '语音键',
    }
    const SLOT_KEYS = ['click', 'double', 'hold']
    const SLOT_LABELS = { click: '单击', double: '双击', hold: '长按' }

    /**
     * 图形化按键映射（2026-10-08 重做 · 用户要求「类似参考图片的图形化界面」）。
     *
     * 参照物是无线麦 SayAll 的「按键映射」页：中间一台遥控器实物图、每个按键一张卡片、
     * 每键三档（单击 / 双击 / 长按）。右栏面板只有 300~500px 宽，做不了那页的「卡片环绕 + 连线」
     * （线会互相压住），所以取它的三要素并按窄栏适配：
     *   ① **遥控器实物图形**（可点：点哪个键就定位到哪张卡）；
     *   ② 每个按键**一张卡片**，三档并排，与图片同构；
     *   ③ 图形与卡片**双向联动** —— 点图形上的键 ⇒ 卡片高亮并滚进视野；悬停卡片 ⇒ 图形上那个键点亮。
     * 面板拖宽/全屏时卡片用 grid auto-fill 自动排成多列，观感与图片同源。
     */

    /**
     * 遥控器各键在 120×590 画布上的位置 —— **照实物排布**（用户 2026-10-08 给的实物照片）：
     * 顶部左边电源、右边语音键；中间方向环 + OK；再往下**左列**是 返回 / 主页 / 菜单，
     * **右列**是 音量 + / 音量 − / TV。
     *
     * 坐标来源：2026-10-11 用户又发了一张实物照片，量出本体约 230×870 px（1:3.78），
     * 据此换算到 120×454；随后按他的要求**高度再放大 1.3 倍**（454 → 590），
     * 所以下面所有 cy 与半径都是"原值 × 1.3"。下半段留白是故意的 —— 实物那儿是 NFC 和 xiaomi 字样。
     */
    const KEY_LAYOUT = [
      // 半径按实物比例：本体宽 230px 的实物照片里，电源/语音直径约 34（15%）、
      // 返回/主页/菜单/TV 约 48（21%）、方向环约 150（65%）、中心 OK 约 70（30%）。
      // 换算到 120 宽再 ×1.3 的高度放大，得到下面这些值。
      { id: 'power', label: '电源', short: '⏻', cx: 38, cy: 44, r: 11 },
      // 语音键：映射固定（点按 = 右 Win + 右 Shift，长按 = 按住 Alt），所以图上只展示、不可点，
      // 也不给卡片 —— 用户 2026-10-11 明确要求。
      { id: 'voice', label: '语音键', short: 'mic', cx: 82, cy: 44, r: 11, fixed: true },
      { id: 'up', label: '上', short: '', cx: 60, cy: 109, r: 12 },
      { id: 'left', label: '左', short: '', cx: 32, cy: 138, r: 12 },
      { id: 'ok', label: 'OK / 确定', short: 'OK', cx: 60, cy: 138, r: 19 },
      { id: 'right', label: '右', short: '', cx: 88, cy: 138, r: 12 },
      { id: 'down', label: '下', short: '', cx: 60, cy: 166, r: 12 },
      // 左列（实物：返回 / 主页 / 菜单）
      { id: 'back', label: '返回', short: '↩', cx: 38, cy: 211, r: 14 },
      { id: 'home', label: '主页', short: '⌂', cx: 38, cy: 265, r: 14 },
      { id: 'menu', label: '菜单', short: '☰', cx: 38, cy: 320, r: 14 },
      // 右列：音量 + / − 在实物上是一条胶囊的两半（图形在 RemoteFigure 里整体画），
      // 这里只留热区与符号；TV 是独立圆。音量键原来 fixed 只展示，用户 2026-10-08 要求也能映射。
      { id: 'volup', label: '音量 +', short: '+', cx: 82, cy: 216, r: 13, inPill: true },
      { id: 'voldown', label: '音量 −', short: '−', cx: 82, cy: 261, r: 13, inPill: true },
      { id: 'tv', label: 'TV', short: 'TV', cx: 82, cy: 320, r: 14 },
    ]

    /**
     * 卡片分两列 —— 照用户 2026-10-11 的版式要求：
     *   第一列：电源 / 上 / 左 / 返回 / 主页 / 菜单
     *   第二列：OK / 下 / 右 / 音量 + / 音量 − / TV
     * 整块放在遥控器图右边（页面中间）；最左边是遥控器图，最右边是状态列。
     */
    const CARD_COLUMNS = [
      { key: 'col1', ids: ['power', 'up', 'left', 'back', 'home', 'menu'] },
      // 语音键**不给卡片**（用户 2026-10-11 裁定）：它的映射是固定好的，不在界面上改。
      // 映射本身仍在 host 的 defaultMapping 里（点按 RWin+RShift、长按按住 Alt），引擎照常执行。
      { key: 'col2', ids: ['ok', 'down', 'right', 'volup', 'voldown', 'tv'] },
    ]

    /** 遥控器实物图形：每个键是一个可点热点，选中/悬停时点亮；fixed 的键只展示不可点。 */
    function RemoteFigure(props) {
      const given = props === null || props === undefined ? {} : props
      const selected = given.selected
      const hover = given.hover
      const onPick = typeof given.onPick === 'function' ? given.onPick : function () {}
      /*
       * 遥控器实物图。样式严格照用户 2026-10-11 发来的第二张实物照片：
       *   · 机身是浅灰银，圆角很圆
       *   · **电源 / 语音**是两颗"和机身同色的浅圆"，只有一圈细描边 —— 不是实心深色
       *   · **方向环是一整块深灰圆盘**（不是虚线圈），中心 OK 再叠一层深灰、略微高亮
       *   · **返回 / 主页 / 菜单 / TV** 是深灰圆底 + 浅色图标
       *   · **音量 + / − 是一条深灰胶囊**（一个整体，中间一条细分割线），不是两个独立圆
       * 深灰没有对应的主题令牌（浅色主题里没有"深灰填充"这一档），所以这里用固定的石墨色。
       */
      const DARK = '#3a3a3e'          // 深灰按键底（实物那个石墨灰）
      const DARK_HI = '#4a4a50'       // 按下/悬停时的提亮
      const ICE = '#e8e8ec'           // 深灰底上的浅色图标
      const active = (id) => selected === id || hover === id
      const fillOf = (id) => (active(id) ? 'var(--dsw-alias-brand-primary)' : DARK)
      return h('svg', {
        // 120×590 —— 实物照片量出本体比例 1:3.78，再按用户要求把高度放大 1.3 倍（454→590）。
        viewBox: '0 0 120 590', width: '100%', role: 'img', 'aria-label': '遥控器按键图',
        'data-dsmr-figure': '1',
        style: { display: 'block', maxWidth: 190, margin: '0 auto' },
      },
      // 机身：浅灰银、大圆角
      h('rect', {
        key: 'body', x: 6, y: 2, width: 108, height: 586, rx: 30,
        fill: 'var(--dsw-alias-bg-layer-2)', stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 1.5,
      }),
      // 方向环：一整块深灰圆盘（实物如此），不是虚线
      h('circle', {
        key: 'ring', cx: 60, cy: 138, r: 44,
        fill: DARK, stroke: 'rgba(0,0,0,0.25)', strokeWidth: 1,
      }),
      // 环内的四个方向箭头（浅色，贴在环内侧）
      h('text', { key: 'au', x: 60, y: 106, textAnchor: 'middle', fontSize: 13, fill: ICE, opacity: 0.85, style: { pointerEvents: 'none' } }, '▲'),
      h('text', { key: 'ad', x: 60, y: 178, textAnchor: 'middle', fontSize: 13, fill: ICE, opacity: 0.85, style: { pointerEvents: 'none' } }, '▼'),
      h('text', { key: 'al', x: 26, y: 143, textAnchor: 'middle', fontSize: 13, fill: ICE, opacity: 0.85, style: { pointerEvents: 'none' } }, '◀'),
      h('text', { key: 'ar', x: 94, y: 143, textAnchor: 'middle', fontSize: 13, fill: ICE, opacity: 0.85, style: { pointerEvents: 'none' } }, '▶'),
      // 音量胶囊：实物是一条整体，上下两半各一个符号，中间一道细线
      h('rect', {
        key: 'volpill', x: 68, y: 194, width: 28, height: 88, rx: 14,
        fill: DARK, stroke: 'rgba(0,0,0,0.25)', strokeWidth: 1,
      }),
      h('line', { key: 'volsplit', x1: 70, y1: 238, x2: 94, y2: 238, stroke: ICE, strokeWidth: 0.8, opacity: 0.35 }),
      // 下半段：NFC 标与品牌字样（实物就在这个位置）
      h('text', {
        key: 'nfc', x: 60, y: 430, textAnchor: 'middle', fontSize: 10,
        fill: 'var(--dsw-alias-label-secondary)', opacity: 0.65,
      }, 'NFC'),
      h('text', {
        key: 'brand', x: 60, y: 528, textAnchor: 'middle', fontSize: 12, letterSpacing: 1,
        fill: 'var(--dsw-alias-label-secondary)', opacity: 0.5,
      }, 'xiaomi'),
      KEY_LAYOUT.map((key) => {
        const on = active(key.id)
        const locked = key.fixed === true
        // 电源 / 语音：浅色圆 + 描边（实物和机身同色，不填深灰）；其余是深灰实心。
        const light = key.id === 'power' || key.id === 'voice'
        const inPill = key.inPill === true   // 音量键：图形由上面那条胶囊负责，这里只放符号和热区
        return h('g', {
          key: key.id, 'data-dsmr-key': key.id,
          style: { cursor: locked ? 'default' : 'pointer' },
          onClick: locked ? undefined : () => onPick(key.id),
        },
        // 点击热区：实物按键很小（r≈11~14），直接照画会很难点，所以盖一个透明的大圆
        h('circle', { cx: key.cx, cy: key.cy, r: Math.max(key.r, 16), fill: 'transparent' }),
        inPill ? null : h('circle', {
          cx: key.cx, cy: key.cy, r: key.r,
          fill: light ? (on ? DARK_HI : 'transparent') : fillOf(key.id),
          stroke: light ? 'rgba(0,0,0,0.28)'
            : (on ? 'var(--dsw-alias-brand-primary)' : 'rgba(0,0,0,0.25)'),
          strokeWidth: light ? 1.2 : 1,
        }),
        // 选中音量键时给胶囊那半边加一层高亮（胶囊是整块画的，没法只染半边，用叠加圆表示）
        inPill && on ? h('circle', { cx: key.cx, cy: key.cy, r: 13, fill: 'var(--dsw-alias-brand-primary)', opacity: 0.85 }) : null,
        h('text', {
          x: key.cx, y: key.cy + (key.r > 16 ? 4 : 3), textAnchor: 'middle',
          fontSize: key.r > 16 ? 10 : (key.short.length > 1 ? 8 : 9),
          fill: light ? 'var(--dsw-alias-label-secondary)' : ICE,
          style: { pointerEvents: 'none', userSelect: 'none' },
        }, key.short))
      }))
    }

    /**
     * 上层页面（弹窗）。结构照 dsh-workdesktop 的 .dshw-modal*（用户 2026-10-08 要求按工作台风格）：
     * 全屏遮罩 + 居中卡片 + 头部/正文/底部。点遮罩、点 ✕、按 Esc 都能关。
     */
    function Modal(props) {
      const given = props === null || props === undefined ? {} : props
      const close = given.onClose
      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          if (typeof close === 'function') close()
        }
        document.addEventListener('keydown', onKey, true)
        return () => { try { document.removeEventListener('keydown', onKey, true) } catch (error) { /* 已移除 */ } }
      }, [close])
      return h('div', {
        className: 'dsmr-backdrop', 'data-dsmr-modal': given.id === undefined ? '1' : String(given.id),
        onClick: (event) => {
          if (event.target === event.currentTarget && typeof close === 'function') close()
        },
      },
      h('div', { className: 'dsmr-modal', 'data-wide': given.wide === true ? '1' : '0' },
        h('div', { className: 'dsmr-modal-head' },
          h('span', { className: 'dsmr-modal-title' }, given.title),
          given.subtitle === undefined || given.subtitle === null
            ? null : h('span', { className: 'dsmr-modal-sub' }, given.subtitle),
          h('button', {
            type: 'button', className: 'dsmr-modal-x', 'data-dsmr-action': 'modal-close',
            onClick: () => { if (typeof close === 'function') close() },
          }, '✕')),
        h('div', { className: 'dsmr-modal-body' }, given.children),
        given.footer === undefined || given.footer === null
          ? null : h('div', { className: 'dsmr-modal-foot' }, given.footer)))
    }

    /**
     * 把一次按键/鼠标事件翻成引擎认得的组合键写法。
     * 键盘：Ctrl/Alt/Shift/Win + 主键（方向键、Esc、F1–F24、字母数字都归一）；
     * 鼠标：MouseLeft / MouseMiddle / MouseRight（可带修饰键）。
     * 只按修饰键本身返回 null —— 那不是一次完整的绑定。
     */
    function comboFromEvent(event, fromMouse) {
      const mods = []
      if (event.ctrlKey === true) mods.push('Ctrl')
      if (event.altKey === true) mods.push('Alt')
      if (event.shiftKey === true) mods.push('Shift')
      if (event.metaKey === true) mods.push('Win')
      if (fromMouse === true) {
        const names = { 0: 'MouseLeft', 1: 'MouseMiddle', 2: 'MouseRight' }
        const base = names[event.button]
        if (base === undefined) return null
        return mods.length === 0 ? base : mods.join('+') + '+' + base
      }
      const key = String(event.key === undefined || event.key === null ? '' : event.key)
      if (key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'Meta' || key === '') return null
      const named = {
        ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
        Escape: 'Esc', Enter: 'Enter', Backspace: 'Backspace', Delete: 'Delete', Tab: 'Tab',
        Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert',
      }
      let base = named[key]
      if (base === undefined) {
        if (/^F[0-9]{1,2}$/u.test(key) === true) base = key
        else if (key.length === 1 && /[a-z]/u.test(key) === true) base = key.toUpperCase()
        else base = key
      }
      return mods.length === 0 ? base : mods.join('+') + '+' + base
    }

    /**
     * 动作编辑弹窗：点卡片上某一格（某键的单击/双击/长按）打开它。
     * 三件事在一个页面里做完 —— 从预设里挑、**按下键来识别**、或者写一个要启动的程序名。
     */
    function ActionModal(props) {
      const given = props === null || props === undefined ? {} : props
      const presets = Array.isArray(given.presets) ? given.presets : []
      const current = given.action === null || given.action === undefined ? null : given.action
      const [live, setLive] = React.useState(false)
      const [heard, setHeard] = React.useState(null)
      const [appName, setAppName] = React.useState(
        current !== null && current.type === 'app' ? String(current.combo || '') : '')
      const [checked, setChecked] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState(null)

      /* 录制：听 document 上的按键与鼠标按下 —— 按什么就识别成什么，识别完自动停。 */
      React.useEffect(() => {
        if (live !== true) return undefined
        const onKey = (event) => {
          event.preventDefault(); event.stopPropagation()
          const combo = comboFromEvent(event, false)
          if (combo === null) return
          setHeard(combo); setLive(false)
        }
        const onMouse = (event) => {
          event.preventDefault(); event.stopPropagation()
          const combo = comboFromEvent(event, true)
          if (combo === null) return
          setHeard(combo); setLive(false)
        }
        document.addEventListener('keydown', onKey, true)
        document.addEventListener('mousedown', onMouse, true)
        return () => {
          try { document.removeEventListener('keydown', onKey, true) } catch (error) { /* 已移除 */ }
          try { document.removeEventListener('mousedown', onMouse, true) } catch (error) { /* 已移除 */ }
        }
      }, [live])

      const label = (BUTTON_LABELS[given.button] || given.button) + ' · ' + (SLOT_LABELS[given.slot] || given.slot)
      const pickPreset = (preset) => {
        if (typeof given.onSave !== 'function') return
        /*
         * ⚠️ 这里必须存 'dsh'，不能存 'preset'。
         *
         * 2026-10-11 用户报"我之前做的设置消失了" —— 根因就是这一行：
         * 原来存的是 `type: 'preset'`，而服务端 writeMapping 只认 dsh / key / app / holdkey，
         * 于是**每次用预设配置都被拒（unknown-action-type），配置根本没写进磁盘**，
         * 面板刷新一遍就回到旧值，看起来就是"设置没了"。
         * 同文件另外两处（1113 / 1331 行）写的都是 'dsh'，只有这一处漏了。
         */
        given.onSave({ type: 'dsh', id: preset.id, label: preset.label, combo: preset.combo })
      }
      const saveHeard = () => {
        if (heard === null || typeof given.onSave !== 'function') return
        given.onSave({ type: 'key', id: 'key:' + heard, label: heard, combo: heard })
      }
      const saveApp = () => {
        const name = String(appName || '').trim()
        if (name === '') { setNote('先写上要启动的程序名'); return }
        setBusy(true); setNote(null)
        // 「打开应用」这个名字得能在 PATH / App Paths 里找到，引擎才启动得起来 —— 存之前先查一次。
        post('/bridge/check-app', { name: name }).then((result) => {
          setBusy(false)
          if (result !== null && result !== undefined && result.found === true) {
            setChecked(result.path === undefined ? name : result.path)
            if (typeof given.onSave === 'function') {
              given.onSave({ type: 'app', id: 'app:' + name, label: '打开 ' + name, combo: name })
            }
          } else {
            setChecked(false)
            setNote('找不到这个程序（要能在 PATH 里直接运行的名字，或者带完整路径）')
          }
        })
      }

      const picks = presets.map((preset) => h('button', {
        key: preset.id, type: 'button', className: 'dsmr-pick',
        // 存的是 'dsh'（服务端只认这个），所以高亮也要按 'dsh' 判 —— 原来写 'preset'，
        // 导致"已选中"的高亮从来没亮过（同一个漏改）。
        'data-on': current !== null && current.type === 'dsh' && current.id === preset.id ? '1' : '0',
        'data-dsmr-pick': preset.id,
        onClick: () => pickPreset(preset),
      },
      h('span', null, preset.label),
      h('span', { className: 'dsmr-pick-combo' }, preset.combo)))

      return h(Modal, { id: 'action', title: label, subtitle: '选一个动作，或按下你要用的键', onClose: given.onClose },
        h('div', { className: 'dsmr-sec-box' },
          h('div', { className: 'dsmr-sec-h' }, '按下键来识别'),
          h('div', {
            className: 'dsmr-recorder', 'data-live': live === true ? '1' : '0',
            'data-dsmr-recorder': '1', tabIndex: 0, role: 'button',
            onClick: () => { setLive(live !== true); setHeard(null) },
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setLive(live !== true); setHeard(null) }
            },
          },
          h('div', { className: 'dsmr-recorder-key' },
            live === true ? '正在听…' : (heard === null ? '点这里开始' : heard)),
          h('div', { className: 'dsmr-recorder-tip' },
            live === true
              ? '现在按一下你要绑的键（可以带 Ctrl / Alt / Shift；鼠标左中右键也认）'
              : '键盘组合键或鼠标键都能识别，识别完点下面的「用这个」')),
        heard === null || live === true ? null : h('div', { className: 'dsmr-actions' },
          h('button', {
            type: 'button', className: 'dsmr-btn', 'data-variant': 'primary',
            'data-dsmr-action': 'use-heard', onClick: saveHeard,
          }, '用这个'),
          h('button', {
            type: 'button', className: 'dsmr-btn', 'data-variant': 'ghost',
            onClick: () => setHeard(null),
          }, '重按'))),

        h('div', { className: 'dsmr-sec-box' },
          h('div', { className: 'dsmr-sec-h' }, '常用动作'),
          h('div', { className: 'dsmr-picks' }, picks)),

        h('div', { className: 'dsmr-sec-box' },
          h('div', { className: 'dsmr-sec-h' }, '打开一个程序'),
          h('div', { className: 'dsmr-inline' },
            h('input', {
              className: 'dsmr-combo-input', value: appName, 'data-dsmr-appname': '1',
              placeholder: t('customAppPlaceholder'),
              onChange: (event) => { setAppName(event.target.value); setChecked(null); setNote(null) },
              onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); saveApp() } },
            }),
            h('button', {
              type: 'button', className: 'dsmr-btn', disabled: busy,
              'data-dsmr-action': 'save-app', onClick: saveApp,
            }, busy ? '检查中…' : '用这个')),
          checked === true || typeof checked === 'string'
            ? h('p', { className: 'dsmr-hint' }, '找到了：' + String(checked))
            : (checked === false ? h('p', { className: 'dsmr-hint' }, note === null ? '找不到这个程序' : note) : null),
          note !== null && checked !== false ? h('p', { className: 'dsmr-hint' }, note) : null),

        current === null ? null : h('div', { className: 'dsmr-actions' },
          h('button', {
            type: 'button', className: 'dsmr-btn', 'data-variant': 'ghost', 'data-dsmr-action': 'clear-action',
            onClick: () => { if (typeof given.onClear === 'function') given.onClear() },
          }, '清除这一格')))
    }

    /** 一个按键的卡片：键名 + 三档动作，与参考图片里的卡片同构。 */
    function KeyCard(props) {
      const given = props === null || props === undefined ? {} : props
      /*
       * ⚠️ 数据 prop 叫 `button` **不能**叫 `key`：`key` 是 React 的保留字段，
       * 不会传进组件 —— 真机上 `given.key` 永远是 undefined，一读 `.id` 就抛
       * `Cannot read properties of undefined`，slot 的错误边界随即把整个面板条目
       * "退位"，表现就是右栏纯白（2026-10-08 白屏的真凶）。
       * 离线桩当时不剥离 `key`，所以一直测不出来 —— 桩已同步改成剥离（见 verify-render）。
       */
      const button = given.button
      const actionOf = given.actionOf
      const active = given.active === true
      return h('div', {
        className: 'dsmr-card', 'data-dsmr-card': button.id, 'data-on': active ? '1' : '0',
        onMouseEnter: () => { if (typeof given.onHover === 'function') given.onHover(button.id) },
        onMouseLeave: () => { if (typeof given.onHover === 'function') given.onHover(null) },
        onClick: () => { if (typeof given.onPick === 'function') given.onPick(button.id) },
      },
      h('div', { className: 'dsmr-card-head' },
        h('span', { className: 'dsmr-card-glyph' }, button.short),
        h('span', { className: 'dsmr-card-name' }, button.label)),
      SLOT_KEYS.map((slot) => {
        const action = actionOf(button.id, slot)
        return h('div', { className: 'dsmr-card-row', key: slot },
          h('span', { className: 'dsmr-card-slot' }, SLOT_LABELS[slot]),
          h('button', {
            type: 'button', className: 'dsmr-card-action',
            'data-set': action === null || action === undefined ? '0' : '1',
            'data-dsmr-cell': button.id + ':' + slot,
            title: action === null || action === undefined ? t('none') : (action.label + ' · ' + action.combo),
            onClick: (event) => {
              event.stopPropagation()
              // 「锁定当前按键」已按用户要求移除：格子永远可点，点了就打开上层编辑页。
              if (typeof given.onEdit === 'function') given.onEdit(button.id, slot, action)
            },
          }, action === null || action === undefined ? t('none') : action.label))
      }))
    }

    function MappingSection() {
      const [model, setModel] = React.useState(null)   // { mapping, presets }
      const [editing, setEditing] = React.useState(null) // `${button}:${slot}` → { mode, value }
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState(null)
      const [selected, setSelected] = React.useState('ok')
      const [hover, setHover] = React.useState(null)
      /*
       * 正在编辑的那一格（点卡片上某键的单击/双击/长按打开上层页面）。
       * `{ button, slot, action }` —— action 是这一格当前的动作，弹窗里要拿它显示"已选"。
       */
      const [cellEditor, setCellEditor] = React.useState(null)
      const [link, setLink] = React.useState(null)
      /*
       * 锁定当前按键（参考图底部那个开关）：锁上之后卡片上的动作不可改，
       * 遥控器图上点键只做定位、不打开选择器 —— 防的是"看着面板顺手点了一下就改了映射"。
       * 存在 localStorage：这是界面偏好，不是方案内容，不该混进 mapping.json。
       */
      const [locked, setLocked] = React.useState(() => {
        try {
          return typeof window !== 'undefined' && window.localStorage !== undefined
            && window.localStorage.getItem('dsh-mi-remote:locked') === '1'
        } catch (error) { return false }
      })
      const setLockedOn = (next) => {
        setLocked(next)
        try { window.localStorage.setItem('dsh-mi-remote:locked', next ? '1' : '0') } catch (error) { /* 写不进去就算了 */ }
      }

      React.useEffect(() => {
        api('/mapping').then((result) => {
          if (result && result.ok === true) setModel({ mapping: result.mapping, presets: result.presets || [] })
          else setMessage(describeError(result))
        })
        api('/link').then((result) => { if (result && result.ok === true) setLink(result.link) })
      }, [])

      /** 点图形上的键（或卡片）⇒ 选中它，并把卡片滚进视野 —— 窄栏里这就是参考图片那根连线的作用。 */
      const pick = (id) => {
        setSelected(id)
        try {
          const node = document.querySelector('[data-dsmr-card="' + id + '"]')
          if (node !== null && node !== undefined && typeof node.scrollIntoView === 'function') {
            node.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
          }
        } catch (error) { /* 自测桩里没有真实 DOM */ }
      }

      if (model === null) {
        return h('div', { className: 'dsmr-sec', 'data-dsmr-sec': 'mapping' },
          h('div', { className: 'dsmr-sec-head' }, h('span', null, t('mapping'))),
          h('div', { className: 'dsmr-note' }, '…'))
      }

      const mapping = model.mapping
      const presets = model.presets
      const actionOf = (button, slot) => (mapping.buttons[button] === undefined ? null : mapping.buttons[button][slot])
      const valueOf = (action) => {
        if (action === null || action === undefined) return '__none__'
        if (action.type === 'dsh') return 'dsh:' + action.id
        if (action.type === 'key') return '__key__'
        if (action.type === 'app') return '__app__'
        return '__none__'
      }

      const setCell = (button, slot, value) => {
        if (value === '__key__') { setEditing({ button: button, slot: slot, mode: 'key', value: '' }); return }
        if (value === '__app__') { setEditing({ button: button, slot: slot, mode: 'app', value: '' }); return }
        setModel((prev) => {
          const next = { mapping: JSON.parse(JSON.stringify(prev.mapping)), presets: prev.presets }
          const row = next.mapping.buttons[button]
          if (value === '__none__') { row[slot] = null; return next }
          const preset = presets.find((candidate) => 'dsh:' + candidate.id === value)
          if (preset !== undefined) row[slot] = { type: 'dsh', id: preset.id, label: preset.label, combo: preset.combo }
          return next
        })
      }

      /**
       * 选动作 ⇒ **打开上层页面**（用户 2026-10-08 原话：点按键位置弹出上层页面，
       * 能够识别并绑定对应的键盘/鼠标动作）。原来是借一个隐藏的 `<select>` 弹系统下拉，
       * 那个既不像工作台，也没法"按下键就识别"。
       */
      const openPicker = (button, slot, action) => {
        setCellEditor({ button: button, slot: slot, action: action === undefined ? null : action })
      }

      /**
       * 弹窗里选定/清除一个动作 ⇒ 立刻写进映射并存盘。
       * 这里自己构造下一份 mapping 再 POST，**不能复用 `save()`** —— 那个读的是闭包里的旧
       * `mapping`，setModel 之后它还没更新，正好会把刚选的丢掉。
       */
      const applyAction = (button, slot, action) => {
        setCellEditor(null)
        const next = JSON.parse(JSON.stringify(mapping))
        if (next.buttons[button] === undefined || next.buttons[button] === null) next.buttons[button] = {}
        next.buttons[button][slot] = action
        setModel({ mapping: next, presets: presets })
        void post('/mapping', { mapping: next }).then((result) => {
          if (result && result.ok === true) {
            setMessage(t('saved') + '（' + result.actions + ' 个动作）')
            if (result.mapping !== undefined) setModel((prev) => ({ mapping: result.mapping, presets: prev.presets }))
          } else {
            setMessage(describeError(result))
          }
        })
      }

      const save = async () => {
        setBusy(true); setMessage(null)
        const result = await post('/mapping', { mapping: mapping })
        setBusy(false)
        if (result && result.ok === true) {
          setMessage(t('saved') + '（' + result.actions + ' 个动作）')
          if (result.mapping !== undefined) setModel((prev) => ({ mapping: result.mapping, presets: prev.presets }))
        } else {
          setMessage(describeError(result))
        }
      }
      const reset = async () => {
        setBusy(true); setMessage(null)
        const result = await post('/mapping/reset', {})
        setBusy(false)
        if (result && result.ok === true) {
          setMessage(t('resetDone'))
          if (result.mapping !== undefined) setModel((prev) => ({ mapping: result.mapping, presets: prev.presets }))
        } else {
          setMessage(describeError(result))
        }
      }

      const remoteReady = link !== null && link !== undefined && link.remote !== undefined && link.remote.ok === true
      /** 按 id 取一张卡片 —— 分组与顺序由 CARD_COLUMNS 显式给定（照用户 2026-10-11 的版式）。 */
      const cardOf = (id) => {
        const key = KEY_LAYOUT.find((candidate) => candidate.id === id)
        if (key === undefined) return null
        return h(KeyCard, {
          key: key.id,          // React 的列表 key
          button: key,          // 真正的数据 —— 名字不能叫 key（React 会吃掉它）
          active: selected === key.id || hover === key.id,
          actionOf: actionOf,
          onPick: pick,
          onHover: setHover,
          onEdit: (button, slot, action) => { openPicker(button, slot, action) },
        })
      }
      const editingKey = editing === null ? null : editing.button + ':' + editing.slot

      return h('div', { className: 'dsmr-sec', 'data-dsmr-sec': 'mapping' },
        h('div', { className: 'dsmr-sec-head' }, h('span', null, t('mapping')),
          h('span', null, mapping.updatedAt === null || mapping.updatedAt === undefined ? '默认方案' : '已存方案')),

        // ① 设备行（呼应参考图片右上角那张"已连接"卡）
        h('div', { className: 'dsmr-devrow', 'data-dsmr-devrow': '1' },
          h(RemoteIcon, { size: 15 }),
          h('span', { className: 'dsmr-devname' }, '小米蓝牙遥控器 2 Pro'),
          h('span', {
            className: 'dsmr-devstate', 'data-on': remoteReady ? '1' : '0',
            'data-dsmr-paired': remoteReady ? '1' : '0',
          }, remoteReady ? '已配对' : '未配对')),

        /*
         * ②③ 遥控器图放**中间**，卡片分到**左右两栏**（用户 2026-10-08 裁定）：
         * 左边 = 电源 / 上 / 下 / 左 / 右 / OK，右边 = 返回 / 主页 / 菜单 / 音量 + / 音量 − / TV。
         * 面板本身窄（右栏 300~500px），所以 CSS 里做了降级：不够宽时两栏落到图的下面。
         */
        /*
         * 版式照用户 2026-10-11 的要求：
         *   **最左**是遥控器图，**中间**是两列卡片（第一列 电源/上/左/返回/主页/菜单，
         *   第二列 OK/下/右/音量+/音量−/TV），**最右**是状态列（由 LinkSection 渲染）。
         */
        h('div', { className: 'dsmr-maplayout' },
          h('div', { className: 'dsmr-figurewrap' },
            h(RemoteFigure, { selected: selected, hover: hover, onPick: pick }),
            h('div', { className: 'dsmr-fighint' }, '点遥控器上的键 → 对应卡片会高亮')),
          h('div', { className: 'dsmr-cardcols' },
            CARD_COLUMNS.map((col) => h('div', {
              className: 'dsmr-cardcol', key: col.key, 'data-dsmr-col': col.key,
            }, col.ids.map(cardOf))))),

        // 动作编辑弹窗（点卡片上某一格打开）：预设 / 按下键识别 / 打开程序，都收在这一个上层页面里。
        cellEditor === null ? null : h(ActionModal, {
          button: cellEditor.button, slot: cellEditor.slot, action: cellEditor.action,
          presets: presets,
          onSave: (action) => applyAction(cellEditor.button, cellEditor.slot, action),
          onClear: () => applyAction(cellEditor.button, cellEditor.slot, null),
          onClose: () => setCellEditor(null),
        }),

        // 内联输入（选"自定义组合键/打开应用"时出现）
        editing === null ? null : h('div', { className: 'dsmr-inline' },
          h('span', { className: 'dsmr-inline-label' },
            (BUTTON_LABELS[editing.button] || editing.button) + ' · ' + SLOT_LABELS[editing.slot] + ' → '),
          h('input', {
            className: 'dsmr-combo-input', autoFocus: true,
            placeholder: editing.mode === 'app' ? t('customAppPlaceholder') : t('customPlaceholder'),
            value: editing.value,
            'data-dsmr-combo': editingKey,
            onChange: (event) => setEditing((prev) => ({ button: prev.button, slot: prev.slot, mode: prev.mode, value: event.target.value })),
            onBlur: () => setEditing(null),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                const value = String(editing.value || '').trim()
                if (value === '') { setEditing(null); return }
                /*
                 * 「打开应用」这个名字得能在 PATH / App Paths 里找到，引擎才启动得起来。
                 * 所以回车时先查一次再存 —— 否则用户按了键只看到没反应，也说不清是名字不对还是路径不对。
                 * 查不到就**不关编辑器**，让人当场改。
                 */
                if (editing.mode === 'app') {
                  post('/bridge/check-app', { name: value }).then((result) => {
                    if (result && result.found === true) {
                      setModel((prev) => {
                        const next = { mapping: JSON.parse(JSON.stringify(prev.mapping)), presets: prev.presets }
                        next.mapping.buttons[editing.button][editing.slot] =
                          { type: 'app', id: 'app:' + value, label: '打开 ' + value, combo: value }
                        return next
                      })
                      setMessage('已设为打开「' + value + '」→ ' + String(result.path || ''))
                      setEditing(null)
                    } else {
                      setMessage('找不到「' + value + '」：请填完整路径，或先确认它已装好')
                    }
                  })
                  return
                }
                setModel((prev) => {
                  const next = { mapping: JSON.parse(JSON.stringify(prev.mapping)), presets: prev.presets }
                  next.mapping.buttons[editing.button][editing.slot] =
                    { type: 'key', id: 'key:' + value, label: value, combo: value }
                  return next
                })
                setEditing(null)
              } else if (event.key === 'Escape') {
                setEditing(null)
              }
            },
          })),

        message === null ? null : h('div', { className: 'dsmr-note', 'data-dsmr-feedback': '1' }, message))
    }

    /** 旧的表格版映射编辑器：保留作回退（当前未被引用）。 */
    function MappingSectionLegacy() {
      const [model, setModel] = React.useState(null)   // { mapping, presets }
      const [editing, setEditing] = React.useState(null) // `${button}:${slot}` → {mode:'key'|'app', value:''}
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState(null)

      React.useEffect(() => {
        api('/mapping').then((result) => {
          if (result && result.ok === true) setModel({ mapping: result.mapping, presets: result.presets || [] })
          else setMessage(describeError(result))
        })
      }, [])

      if (model === null) {
        return h('div', { className: 'dsmr-sec', 'data-dsmr-sec': 'mapping' },
          h('div', { className: 'dsmr-sec-head' }, h('span', null, t('mapping'))),
          h('div', { className: 'dsmr-note' }, '…'))
      }

      const { mapping, presets } = model
      const options = (current) => {
        const list = []
        for (const preset of presets) {
          list.push(h('option', { value: 'dsh:' + preset.id, key: preset.id }, preset.label))
        }
        list.push(h('option', { value: '__none__', key: '__none__' }, t('none')))
        list.push(h('option', { value: '__key__', key: '__key__' }, t('custom')))
        list.push(h('option', { value: '__app__', key: '__app__' }, t('customApp')))
        void current
        return list
      }
      const valueOf = (action) => {
        if (action === null || action === undefined) return '__none__'
        if (action.type === 'dsh') return 'dsh:' + action.id
        if (action.type === 'key') return '__key__'
        if (action.type === 'app') return '__app__'
        return '__none__'
      }

      const setCell = (button, slot, value) => {
        setModel((prev) => {
          const next = { ...prev, mapping: JSON.parse(JSON.stringify(prev.mapping)) }
          const row = next.mapping.buttons[button]
          if (value === '__none__') { row[slot] = null; return next }
          if (value === '__key__') { setEditing({ button, slot, mode: 'key', value: '' }); return prev }
          if (value === '__app__') { setEditing({ button, slot, mode: 'app', value: '' }); return prev }
          const preset = presets.find((candidate) => 'dsh:' + candidate.id === value)
          if (preset !== undefined) {
            row[slot] = { type: 'dsh', id: preset.id, label: preset.label, combo: preset.combo }
          }
          return next
        })
      }

      const save = async () => {
        setBusy(true); setMessage(null)
        const result = await post('/mapping', { mapping })
        setBusy(false)
        if (result && result.ok === true) {
          setMessage(t('saved') + '（' + result.actions + ' 个动作）')
          if (result.mapping !== undefined) setModel((prev) => ({ ...prev, mapping: result.mapping }))
        } else {
          setMessage(describeError(result))
        }
      }
      const reset = async () => {
        setBusy(true); setMessage(null)
        const result = await post('/mapping/reset', {})
        setBusy(false)
        if (result && result.ok === true) {
          setMessage(t('resetDone'))
          if (result.mapping !== undefined) setModel((prev) => ({ ...prev, mapping: result.mapping }))
        } else {
          setMessage(describeError(result))
        }
      }

      return h('div', { className: 'dsmr-sec', 'data-dsmr-sec': 'mapping' },
        h('div', { className: 'dsmr-sec-head' }, h('span', null, t('mapping')),
          h('span', null, mapping.updatedAt === null ? '默认方案' : '')),
        h('div', { className: 'dsmr-table', 'data-dsmr-table': '1' },
          h('div', { className: 'dsmr-tr', key: 'head' },
            h('div', { className: 'dsmr-th' }, '按键'),
            SLOT_KEYS.map((slot) => h('div', { className: 'dsmr-th', key: slot }, SLOT_LABELS[slot]))),
          Object.keys(BUTTON_LABELS).map((button) => h('div', { className: 'dsmr-tr', key: button },
            h('div', { className: 'dsmr-th', 'data-dsmr-button': button }, BUTTON_LABELS[button]),
            SLOT_KEYS.map((slot) => {
              const action = mapping.buttons[button][slot]
              const editKey = button + ':' + slot
              const isEditing = editing !== null && editing.button === button && editing.slot === slot
              return h('div', { className: 'dsmr-td', key: slot },
                isEditing
                  ? h('input', {
                      className: 'dsmr-combo-input', autoFocus: true,
                      placeholder: editing.mode === 'app' ? t('customAppPlaceholder') : t('customPlaceholder'),
                      value: editing.value,
                      'data-dsmr-combo': editKey,
                      onChange: (event) => setEditing((prev) => ({ ...prev, value: event.target.value })),
                      onBlur: () => setEditing(null),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter') {
                          const value = editing.value.trim()
                          if (value !== '') {
                            setModel((prev) => {
                              const next = { ...prev, mapping: JSON.parse(JSON.stringify(prev.mapping)) }
                              next.mapping.buttons[button][slot] = editing.mode === 'app'
                                ? { type: 'app', id: 'app:' + value, label: '打开 ' + value, combo: value }
                                : { type: 'key', id: 'key:' + value, label: value, combo: value }
                              return next
                            })
                          }
                          setEditing(null)
                        } else if (event.key === 'Escape') {
                          setEditing(null)
                        }
                      },
                    })
                  : h('button', {
                      type: 'button', className: 'dsmr-btn-cell',
                      'data-set': action === null ? '0' : '1',
                      'data-dsmr-cell': editKey,
                      title: action === null ? t('none') : (action.label + ' · ' + action.combo),
                      onClick: () => {
                        // 简单可靠的选择路径：用原生 select 一次性列出，选完即收
                        const probe = document.createElement('select')
                        probe.style.position = 'fixed'
                        probe.style.left = '-9999px'
                        for (const preset of presets) {
                          const option = document.createElement('option')
                          option.value = 'dsh:' + preset.id
                          option.textContent = preset.label
                          probe.appendChild(option)
                        }
                        const none = document.createElement('option')
                        none.value = '__none__'; none.textContent = t('none')
                        probe.appendChild(none)
                        const key = document.createElement('option')
                        key.value = '__key__'; key.textContent = t('custom')
                        probe.appendChild(key)
                        const app = document.createElement('option')
                        app.value = '__app__'; app.textContent = t('customApp')
                        probe.appendChild(app)
                        probe.value = valueOf(action)
                        document.body.appendChild(probe)
                        probe.addEventListener('change', () => {
                          setCell(button, slot, probe.value)
                          probe.remove()
                        })
                        probe.addEventListener('blur', () => { probe.remove() })
                        probe.focus()
                        try { probe.showPicker() } catch (e) { /* 某些内核没有 showPicker：blur 兜底 */ }
                      },
                    }, action === null ? t('none') : action.label))
            })))),
        h('div', { className: 'dsmr-actions' },
          h('button', { type: 'button', className: 'dsmr-btn', 'data-variant': 'primary', 'data-dsmr-action': 'save', disabled: busy, onClick: () => { void save() } }, busy ? t('saving') : t('save')),
          h('button', { type: 'button', className: 'dsmr-btn', 'data-dsmr-action': 'reset', disabled: busy, onClick: () => { void reset() } }, t('reset'))),
        message === null ? null : h('div', { className: 'dsmr-note', 'data-dsmr-feedback': '1' }, message),
        h('div', { className: 'dsmr-note' }, t('voiceKey')))
    }

    /* ── 三、语音输入路径 ───────────────────────────────────────────────── */

    /**
     * 按键桥：让上面那份映射**真正生效**的执行段（engine/KeyBridge.exe）。
     *
     * 面板只管配置；引擎负责 Raw Input 监听遥控器 → 单击/双击/长按判定 → SendInput 注入。
     * 之所以在 DSH 侧自己做一份：SayAll 的按键映射由它自己的界面独占，它的官方 AI 协议
     * 也明确禁止外部脚本改它的私有配置。
     *
     * 学习这一步是**必需**的：遥控器各键在 Windows 里报什么码，事先无从得知 ——
     * 按一下、记下来，才知道该把哪个码对到「OK / 返回 / 主页」这些名字上。
     */
    function BridgeSection() {
      const [state, setState] = React.useState(null)
      const [devices, setDevices] = React.useState(null)
      const [learned, setLearned] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState(null)

      const refresh = React.useCallback(() => {
        api('/bridge').then((result) => { if (result && result.ok === true) setState(result) })
      }, [])
      React.useEffect(() => { refresh() }, [refresh])

      // 学习期间每 2 秒收一次结果（学习窗口 45 秒，到点自己退出）
      React.useEffect(() => {
        if (state === null || state.learn === null || state.learn === undefined) return undefined
        if (typeof window === 'undefined' || typeof window.setInterval !== 'function') return undefined
        const timer = window.setInterval(() => {
          post('/bridge/learn/result', {}).then((result) => { if (result && result.ok === true) setLearned(result) })
        }, 2000)
        return () => { window.clearInterval(timer) }
      }, [state])

      const listDevices = () => {
        setBusy(true)
        post('/bridge/devices', {}).then((result) => {
          setBusy(false)
          if (result && result.ok === true) setDevices(result.devices || [])
          else setMessage('列设备失败：' + String((result && (result.error || result.stderr)) || '?'))
        })
      }
      const startLearn = () => {
        setBusy(true); setLearned(null)
        post('/bridge/learn/start', {}).then((result) => {
          setBusy(false); refresh()
          if (result && result.ok === true) setMessage('开始学习：现在按遥控器上的键（' + String(result.seconds) + ' 秒窗口）')
          else setMessage('启动学习失败：' + String((result && result.error) || '?'))
        })
      }
      const startBridge = (filter) => {
        setBusy(true)
        post('/bridge/run', { filter: filter }).then((result) => {
          setBusy(false); refresh()
          if (result && result.ok === true) setMessage('按键桥已启动，过滤：' + String(result.filter))
          else setMessage('启动失败：' + String((result && result.error) || '?'))
        })
      }
      const stopBridge = () => {
        post('/bridge/stop', {}).then(() => { refresh(); setMessage('已停止') })
      }
      /**
       * 用你自己的键盘把整条链走一遍：监听 → 单击判定 → 注入一个回车。
       * 遥控器还没配对时，这是唯一能确认「引擎真能听见、真能注入」的办法。
       * 引擎吃的是临时配置（F9 → Enter），不动你正在用的映射。
       */
      const selftestRun = () => {
        if (devices === null) { setMessage('先点一下「列出设备」'); return }
        /*
         * 挑一个**真实**键盘：设备列表里混着虚拟设备（ROOT#KEYBOARD / VHF / ConvertedDevice），
         * 它们根本不产生按键 —— 选中它们自测会白跑，用户按了 F9 没反应就会误判成"路不通"。
         * 真实设备的名字里一定有 VID_xxxx&PID_xxxx。
         */
        const looksReal = (device) => /VID_[0-9A-Fa-f]{4}&PID_[0-9A-Fa-f]{4}/u.test(String(device.name))
        const real = devices.filter(looksReal)
        const pool = real.filter((device) => device.xiaomi !== true)
        const target = pool[0] || real[0] || devices[0]
        if (target === undefined) { setMessage('没扫到可用的键盘设备'); return }
        const match = /VID_[0-9A-Fa-f]{4}&PID_[0-9A-Fa-f]{4}(?:&MI_[0-9A-Fa-f]{2}&Col[0-9A-Fa-f]{2})?/u.exec(String(target.name))
        const filter = match === null ? String(target.name) : match[0]
        setBusy(true)
        post('/bridge/selftest-run', {
          filter: filter,
          vkey: 120,        // F9：多数应用没绑它，误触代价最小
          combo: 'Enter',
        }).then((result) => {
          setBusy(false); refresh()
          if (result && result.ok === true) {
            setMessage('自测已启动，监听的是「' + filter + '」。现在按一下 F9 —— DSH 的输入框里应该会多出一个回车；'
              + '没反应的话，换个设备再试一次（点设备那一行的「用它启动」旁边的按钮）。120 秒后自动停。')
          } else {
            setMessage('自测启动失败：' + String((result && result.error) || '?'))
          }
        })
      }

      // 学到的键码得指定给某个按键名，引擎才认得出「这是 OK 键」——这是映射真正对上的最后一步。
      const [vkeys, setVkeys] = React.useState({})
      React.useEffect(() => {
        api('/mapping').then((result) => {
          if (result && result.ok === true && result.mapping !== undefined && result.mapping.vkeys !== undefined) {
            setVkeys(result.mapping.vkeys)
          }
        })
      }, [])
      const assignedButton = (vkey) => {
        for (const name of Object.keys(vkeys)) {
          if (Number(vkeys[name]) === Number(vkey)) return name
        }
        return ''
      }
      const assignKey = (vkey, button) => {
        const next = {}
        for (const name of Object.keys(vkeys)) {
          if (name === button) continue
          if (Number(vkeys[name]) === Number(vkey)) continue
          next[name] = Number(vkeys[name])
        }
        if (button !== '') next[button] = Number(vkey)
        post('/bridge/vkeys', { vkeys: next }).then((result) => {
          if (result && result.ok === true) {
            setVkeys(next)
            setMessage(button === '' ? '已取消指定' : '已把键码 ' + String(vkey) + ' 指定为「' + (BUTTON_LABELS[button] || button) + '」')
          } else {
            setMessage('保存失败：' + String((result && result.error) || '?'))
          }
        })
      }

      /*
       * 引导式学习：一步一步来，按固定顺序提示「请按 OK / 上 / 下 …」，遥控器图上那个键高亮，
       * 用户按下去 ⇒ 自动把**新出现**的那个键码指定给当前这个键，然后进入下一个。
       *
       * 为什么值得做：原来要用户自己记住按过哪些键，再对着 10 行裸键码逐个下拉指定 ——
       * 10 次选择、还得回想"刚才按的是哪个"。改成带顺序的引导，一次按键完成一件事。
       */
      // 引导顺序照实物走：先方向环与 OK，再左列（返回/主页/菜单），最后右列（音量 ± / TV）。
      const GUIDE_ORDER = ['ok', 'up', 'down', 'left', 'right', 'back', 'home', 'menu', 'volup', 'voldown', 'tv', 'power']
      const [guideStep, setGuideStep] = React.useState(-1)
      const guideTarget = guideStep >= 0 && guideStep < GUIDE_ORDER.length ? GUIDE_ORDER[guideStep] : null
      const guideSeen = React.useRef({ set: null })
      const startGuide = () => {
        // 记下"进入引导前已经见过的键码"，之后只认新的 —— 否则旧键码会被当成刚按的。
        guideSeen.current.set = new Set((learned !== null && Array.isArray(learned.keys) ? learned.keys : []).map((key) => Number(key.vkey)))
        setGuideStep(0)
        startLearn()
      }
      React.useEffect(() => {
        if (guideTarget === null) return
        if (learned === null || Array.isArray(learned.keys) !== true) return
        if (guideSeen.current.set === null) return
        const fresh = learned.keys.find((key) => key.down === true && guideSeen.current.set.has(Number(key.vkey)) !== true)
        if (fresh === undefined) return
        guideSeen.current.set.add(Number(fresh.vkey))
        assignKey(Number(fresh.vkey), guideTarget)
        setGuideStep((prev) => prev + 1)
      }, [learned, guideTarget])

      const running = state !== null && state.run !== null && state.run !== undefined
      const learning = state !== null && state.learn !== null && state.learn !== undefined
      const engineReady = state !== null && state.engine === true
      // 总闸（参考图里那个「启用自定义按键功能」）：关掉后按键桥不许启动，正在跑的也停。
      const enabled = state === null || state.enabled !== false
      /*
       * 详情页开合（用户 2026-10-08 要求：点「自定义按键功能」后弹出上层详情页面）。
       * 面板上只留入口，设备列表 / 学习 / 自测 / 引导 / 日志都收进弹窗里。
       */
      const [detailOpen, setDetailOpen] = React.useState(false)

      const setEnabledOn = (next) => {
        post('/bridge/enabled', { enabled: next }).then(() => {
          refresh()
          setMessage(next ? '已启用' : '已关闭 —— 正在跑的学习/执行进程也停了')
        })
      }

      // 引擎在跑的时候，把它最近的动作拉出来看 —— 「按了键却没反应」这类问题，
      // 只有这里能说清是哪一个环节断的（设备没匹配上 / 键码没指定 / 注入失败）。
      const [runLog, setRunLog] = React.useState([])
      React.useEffect(() => {
        if (!running) return undefined
        if (typeof window === 'undefined' || typeof window.setInterval !== 'function') return undefined
        const pull = () => {
          api('/bridge/run/log').then((result) => { if (result && result.ok === true) setRunLog(result.events || []) })
        }
        pull()
        const timer = window.setInterval(pull, 2500)
        return () => { window.clearInterval(timer) }
      }, [running])

      return h('div', { className: 'dsmr-sec', 'data-dsmr-sec': 'bridge' },
        /*
         * 这里原来有三块，用户 2026-10-11 明确要求全部移除（截图里的红框）：
         *   · 「按键桥（让映射生效）」+ 运行状态
         *   · 「引擎就绪」提示
         *   · 「启用自定义按键功能」总闸（含"点这一行打开设置"和「打开设置」按钮）
         * 理由：引擎现在随面板自动跑（host 侧自己拉起 Frida 采集器 + read 模式的引擎），
         * 不需要用户再开一个总闸；面板上只留"改绑定"这一件事。
         * 详情页（设备列表/学习/自测/引导/日志）没删，改成点这一行标题进入。
         */
        h('div', {
          className: 'dsmr-sec-head dsmr-clickrow', role: 'button', tabIndex: 0,
          'data-dsmr-action': 'bridge-open-row',
          title: '点这一行看设备 / 学习 / 自测 / 日志',
          onClick: () => setDetailOpen(true),
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setDetailOpen(true) }
          },
        },
        h('span', null, '按键桥'),
        h('span', {
          'data-dsmr-bridge-state': running ? 'running' : learning ? 'learning' : 'idle',
        }, running ? '运行中' : learning ? '学习中' : '未运行')),

        /*
         * 上层详情页：点「打开设置」进来，里头是设备列表 / 学习 / 自测 / 引导 / 日志。
         * （用户 2026-10-08：这些的交互方式改成"点击自定义按键功能后弹出上层详情页面"。）
         */
        detailOpen === true ? h(Modal, {
          id: 'bridge', title: '自定义按键功能', wide: true,
          subtitle: engineReady !== true ? '引擎未编译'
            : (running ? '运行中' : learning ? '学习中' : '未运行'),
          onClose: () => setDetailOpen(false),
        },

        h('div', { className: 'dsmr-actions' },
          h('button', {
            type: 'button', className: 'dsmr-btn', disabled: busy || !engineReady,
            'data-dsmr-action': 'bridge-devices', onClick: listDevices,
          }, busy ? '…' : '列出设备'),
          h('button', {
            type: 'button', className: 'dsmr-btn', disabled: busy || !engineReady || !enabled,
            'data-dsmr-action': 'bridge-learn', onClick: startLearn,
          }, '学习遥控器按键'),
          h('button', {
            type: 'button', className: 'dsmr-btn', disabled: busy || !engineReady || !enabled,
            'data-dsmr-action': 'bridge-selftest', onClick: selftestRun,
          }, '用键盘自测通路'),
          h('button', {
            type: 'button', className: 'dsmr-btn', disabled: busy || !engineReady || !enabled,
            'data-dsmr-action': 'bridge-guide', onClick: startGuide,
          }, '引导学习按键'),
          running
            ? h('button', {
              type: 'button', className: 'dsmr-btn', 'data-dsmr-action': 'bridge-stop', onClick: stopBridge,
            }, '停止按键桥')
            : null),

        h('div', { className: 'dsmr-note' },
          '映射要生效，得由引擎跑起来。它在后台监听遥控器、判定单击/双击/长按，再注入对应的组合键。'),
        h('div', { className: 'dsmr-note', 'data-dsmr-conflict': '1' },
          '注意：SayAll 自己也能配按键映射。两边都开着的话，按一下会触发两次 —— 留一边就行（这里能配就别在 SayAll 里再配一遍）。'),

        devices === null ? null : h('div', { className: 'dsmr-devlist', 'data-dsmr-devlist': '1' },
          h('div', { className: 'dsmr-note' },
            '要选「遥控器」那一条，别选键盘 —— 本机小米键鼠也挂在同一个厂商号下面，选错了你打字就会触发映射。'),
          devices.length === 0
            ? h('div', { className: 'dsmr-note' }, '没有扫到键盘类设备')
            : devices.map((device) => h('div', {
              className: 'dsmr-devitem', key: device.name, 'data-xiaomi': device.xiaomi === true ? '1' : '0',
            },
            h('span', { className: 'dsmr-devname' }, String(device.name).replace(/^\\\\\?\\/u, '')),
            device.xiaomi === true ? h('span', { className: 'dsmr-devtag' }, '小米') : null,
            h('button', {
              type: 'button', className: 'dsmr-btn', 'data-dsmr-action': 'bridge-use-device',
              onClick: () => {
                // 取到接口级（VID&PID&MI&Col）更保险：本机 VID_2717&PID_87C1 底下同时挂着
                // 小米键鼠的两块 HID 键盘，只到 VID&PID 会把它们一起收进来 —— 那样按键盘就触发映射。
                const match = /VID_[0-9A-Fa-f]{4}&PID_[0-9A-Fa-f]{4}(?:&MI_[0-9A-Fa-f]{2}&Col[0-9A-Fa-f]{2})?/u.exec(String(device.name))
                startBridge(match === null ? String(device.name) : match[0])
              },
            }, '用它启动')))),

        learned === null ? null : h('div', { className: 'dsmr-learnbox', 'data-dsmr-learn': '1' },
          h('div', { className: 'dsmr-note' },
            '按到的键（去重后 ' + String((learned.keys || []).length) + ' 个）' +
            (learned.learning === true ? ' · 还在学' : ' · 学习已结束')),
          (learned.keys || []).length === 0
            ? h('div', { className: 'dsmr-note' }, '还没收到按键。若按了却没反应，说明这条路走不通，告诉我，我换监听方式。')
            : (learned.keys || []).slice(0, 20).map((key) => h('div', {
              className: 'dsmr-learnrow', key: key.device + ':' + String(key.vkey),
            },
            h('span', { className: 'dsmr-learnhex' }, String(key.hex) + (key.injected === true ? ' · 注入' : ' · 物理')),
            h('span', { className: 'dsmr-devname' }, String(key.device).replace(/^.*?#/u, '').slice(0, 40)),
            h('select', {
              className: 'dsmr-keypick', 'data-dsmr-assign': String(key.vkey),
              value: assignedButton(key.vkey),
              title: '把这个键码指定为某个按键',
              onChange: (event) => assignKey(key.vkey, event.target.value),
            }, [h('option', { key: '__none', value: '' }, '指定为…')].concat(
              ['ok', 'up', 'down', 'left', 'right', 'back', 'home', 'menu', 'volup', 'voldown', 'tv', 'power'].map((name) =>
                h('option', { key: name, value: name }, BUTTON_LABELS[name] || name))))))),

        message === null ? null : h('div', { className: 'dsmr-note', 'data-dsmr-bridge-msg': '1' }, message),

        // 引导式学习：一步一步按，遥控器图上当前要按的那个键高亮
        guideTarget === null ? null : h('div', { className: 'dsmr-guidebox', 'data-dsmr-guide': guideTarget },
          h('div', { className: 'dsmr-guide-title' },
            '请按遥控器上的「' + (BUTTON_LABELS[guideTarget] || guideTarget) + '」'),
          h('div', { className: 'dsmr-note' },
            '进度 ' + String(Math.min(guideStep + 1, GUIDE_ORDER.length)) + ' / ' + String(GUIDE_ORDER.length) +
            ' · 按下去自动记下，不用手选'),
          h(RemoteFigure, { selected: guideTarget, hover: null, onPick: function () {} }),
          h('div', { className: 'dsmr-actions' },
            h('button', {
              type: 'button', className: 'dsmr-btn', 'data-dsmr-action': 'guide-skip',
              onClick: () => setGuideStep((prev) => prev + 1),
            }, '跳过这个'),
            h('button', {
              type: 'button', className: 'dsmr-btn', 'data-dsmr-action': 'guide-stop',
              onClick: () => setGuideStep(-1),
            }, '结束引导'))),

        runLog.length === 0 ? null : h('div', { className: 'dsmr-learnbox', 'data-dsmr-runlog': '1' },
          h('div', { className: 'dsmr-note' }, '引擎最近的动作（新的在上）：'),
          runLog.slice(-8).reverse().map((event, index) => h('div', {
            className: 'dsmr-learnrow', key: 'log-' + String(index),
          },
          h('span', { className: 'dsmr-learnhex' }, String(event.type)),
          h('span', { className: 'dsmr-devname' },
            event.type === 'fire'
              ? (String(event.button) + ' · ' + String(event.slot) + ' → ' + String(event.action) +
                (event.ok === true ? '' : '（失败：' + String(event.error || '?') + '）'))
              : event.type === 'unmapped'
                ? ('收到键码 ' + String(event.vkey) + '，但没指定它是哪个按键')
                : JSON.stringify(event).slice(0, 70))))))
          // 详情页关着时，面板上就留这一个入口（用户要的"点击自定义按键功能后弹出上层页面"）。
          : h('div', { className: 'dsmr-enterrow', 'data-dsmr-bridge-enter': '1' },
            h('button', {
              type: 'button', className: 'dsmr-btn', 'data-variant': 'primary',
              'data-dsmr-action': 'bridge-open', onClick: () => setDetailOpen(true),
            }, '打开设置'),
            h('span', { className: 'dsmr-hint' },
              enabled !== true ? '当前已关闭 —— 按键桥不会启动'
                : (running ? '正在后台监听遥控器' : '已启用，还没启动'))))
    }

    /**
     * 语音输入路径 —— 设备列表与切换按钮，**直接内嵌在状态列那张卡里**（用户 2026-10-11 要求）。
     * 原来是个弹窗（点卡片打开），现在整段搬到卡片内，点了不用再开层。
     */
    function VoiceLanePanel(props) {
      const given = props === null || props === undefined ? {} : props
      /*
       * 语音独占（用户 2026-10-11 要求把开关移进这个浮层）：
       * sayall = 让无线麦 SayAll 接管语音；dsh = 我自己从遥控器的 ATVV 通道取语音送进 VB-CABLE。
       * 两者互斥 —— 实测 SayAll 开着时 ATVV 服务返回 AccessDenied，只有它退了才拿得到。
       * 目前只记录"选哪边"（dsh 侧的语音采集还没做），等语音链路接上就按这个开关走。
       */
      const [voiceOwner, setVoiceOwner] = React.useState(() => lsGet(LS_PREFIX + 'voiceOwner') || 'sayall')
      const [ownerBusy, setOwnerBusy] = React.useState(false)
      const [ownerNote, setOwnerNote] = React.useState(null)
      /*
       * 切换语音独占。**这个开关是真的**（2026-10-11 之前只记状态，是个摆设）：
       *   sayall —— 拉起无线麦 SayAll，并让采集器只观察不改写（语音整条路让给它）
       *   dsh    —— 停掉 SayAll，采集器接管改写（把语音键改写成左Alt 并锁存）
       * 两边必须互斥：它们的 gadget 挂在同一个蓝牙驱动宿主上、盯同一个 IOCTL，同时改会打架。
       */
      const toggleOwner = async () => {
        const next = voiceOwner === 'sayall' ? 'dsh' : 'sayall'
        setOwnerBusy(true); setOwnerNote(null)
        setVoiceOwner(next)
        lsSet(LS_PREFIX + 'voiceOwner', next)
        const result = await post('/voice/owner', { owner: next })
        setOwnerBusy(false)
        if (result === null || result === undefined || result.ok !== true) {
          setOwnerNote('切换失败：' + String((result && (result.error || result.message)) || '宿主无响应'))
          return
        }
        setOwnerNote(next === 'sayall'
          ? 'SayAll 接管语音' + (result.sayall && result.sayall.already === true ? '（本来就在跑）' : '（已拉起）')
          : 'DSH 接管语音' + (result.collectorPid === null || result.collectorPid === undefined ? '（采集器没起来）' : ''))
      }
      const [state, load] = usePoll('/voice/status', 8000)
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState(null)
      const [selectedId, setSelectedId] = React.useState(() => lsGet(LS_PREFIX + 'selectedId') || '')
      const data = state.data
      const devices = (data && Array.isArray(data.devices)) ? data.devices : []
      const suggest = (data && data.suggest) || null
      const current = (data && data.current) || null
      const effectiveId = (() => {
        if (selectedId !== '' && devices.some((d) => d.id === selectedId)) return selectedId
        if (suggest !== null) return suggest.id
        if (current !== null) return current.id
        return ''
      })()

      const applyTo = async (device) => {
        if (device === null || device === undefined) return
        lsSet(LS_PREFIX + 'selectedId', device.id)
        setSelectedId(device.id)
        setBusy(true); setMessage(null)
        const result = await post('/voice/apply', { query: device.id })
        setBusy(false)
        setMessage(result && result.ok === true
          ? t('applied') + ' ' + ((result.after && result.after.name) || device.name)
          : t('err') + '：' + String((result && (result.error || result.message)) || '?'))
        load(true)
      }
      const restore = async () => {
        setBusy(true); setMessage(null)
        const result = await post('/voice/restore', {})
        setBusy(false)
        setMessage(result && result.ok === true
          ? t('restored') + ' ' + ((result.after && result.after.name) || '')
          : (result && result.error === 'nothing-to-restore') ? zh ? '没有可还原的上一台设备' : 'Nothing to restore'
            : t('err') + '：' + String((result && (result.error || result.message)) || '?'))
        load(true)
      }

      return h('div', { className: 'dsmr-lanebody' },
        h('div', { className: 'dsmr-note dsmr-tiny' }, t('hint')),
        /*
         * 语音独占开关。
         * sayall = 让无线麦 SayAll 接管语音；dsh = 我自己从遥控器的 ATVV 通道取语音送进 VB-CABLE。
         * 两者互斥 —— 实测 SayAll 开着时 ATVV 服务返回 AccessDenied，只有它退了才拿得到。
         *
         * ⚠️ 这里**不能**挂 `data-dsmr-link`。用户 2026-10-11 明确：
         *    「语音独占不是独立卡片，是包含在语音输入路径卡片中的。」
         *    它原先挂着 `data-dsmr-link: 'voiceowner'`，于是被当成第 5 张状态卡，
         *    `verify-render` 数出 5 张、与"4 张卡"的期望对不上，一直红着。
         *    它只是**语音输入路径那张卡里的一行开关** —— 用 `data-dsmr-owner` 标它自己的身份。
         */
        h('div', {
          className: 'dsmr-switchrow dsmr-clickrow', 'data-dsmr-owner': 'voiceowner',
          'data-dsmr-action': 'voice-owner-toggle', role: 'button', tabIndex: 0,
          title: '点一下切换：谁独占遥控器的语音通道',
          onClick: toggleOwner,
          onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleOwner() } },
        },
        h('span', { className: 'dsmr-dot', 'data-ok': voiceOwner === 'dsh' ? '1' : '0' }),
        h('span', null, '语音独占'),
        h('span', { className: 'dsmr-devstate' },
          ownerBusy ? '切换中…' : (voiceOwner === 'dsh' ? 'DSH 取' : 'SayAll 取'))),
        ownerNote === null ? null : h('div', { className: 'dsmr-note dsmr-tiny', 'data-dsmr-owner-note': '1' }, ownerNote),
        /*
         * 语音输入路径的设备列表。
         *
         * 这一段原来放在一个弹窗里（点状态卡打开），用户 2026-10-11 要求**直接搬到状态卡里**，
         * 不用再点开。所以改成竖排紧凑列表，点一下选中、双击切过去（切默认录音设备会改系统设置，
         * 留一步确认，不用单击直接切）。
         */
        h('div', { className: 'dsmr-lanelist' },
          devices.length === 0 ? h('div', { className: 'dsmr-note dsmr-tiny' }, t('none2')) : devices.map((device) => {
            const on = device.id === effectiveId
            return h('button', {
              key: device.id, type: 'button', className: 'dsmr-lanerow',
              'data-on': on ? '1' : '0', 'data-off': device.active ? '0' : '1',
              'data-dsmr-device': device.name, title: device.name + '（点一下选中，双击切过去）',
              onClick: () => { setSelectedId(device.id); lsSet(LS_PREFIX + 'selectedId', device.id) },
              onDoubleClick: () => { if (device.active) void applyTo(device) },
            },
            h('span', { className: 'dsmr-lanerow-name' }, device.name),
            h('span', { className: 'dsmr-lanerow-desc' },
              stateText(device.state)
              + (device.isRemoteMic ? ' · ' + String(device.sourceLabel) : '')
              + (device.isDefault ? ' · ' + t('default') : '')))
          })),
        h('div', { className: 'dsmr-actions dsmr-actions-tight' },
          h('button', {
            type: 'button', className: 'dsmr-btn', 'data-variant': 'primary', 'data-dsmr-action': 'voice-apply',
            disabled: busy || effectiveId === '' || !devices.some((d) => d.id === effectiveId && d.active),
            onClick: () => { void applyTo(devices.find((d) => d.id === effectiveId)) },
          }, t('setDefault')),
          h('button', {
            type: 'button', className: 'dsmr-btn', 'data-dsmr-action': 'voice-restore',
            disabled: busy || data === null || data.savedPrevious === null, onClick: () => { void restore() },
          }, t('restore')),
          h('button', {
            type: 'button', className: 'dsmr-btn', 'data-dsmr-action': 'voice-refresh',
            disabled: state.phase === 'loading' || state.phase === 'refreshing', onClick: () => load(true),
          }, t('refresh'))),
        message === null ? null : h('div', { className: 'dsmr-note dsmr-tiny', 'data-dsmr-voice-feedback': '1' }, message),
        current === null ? null : h('div', { className: 'dsmr-note dsmr-tiny' }, '当前：' + String(current.name)))
    }

    /* ── 面板与兜底 ─────────────────────────────────────────────────────── */

    /**
     * 面板级错误边界（React 只允许 class 组件当边界）。
     *
     * 为什么必须有：DSH 的 slot 层**也有**一个边界，但它捕获之后只把这个条目"退位"
     * （abdicated，整块变白），错误既不进 window.onerror，`ctx.slots` 上也没有
     * onEntryError（那个方法在底层的 SlotCore 上，服务层只暴露 register/registerFactory/inject）。
     * 结果就是面板白得毫无线索。自己包一层，至少能把错误显示出来并送回宿主。
     */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) { return { error: error } }
      componentDidCatch(error, info) {
        try {
          void post('/diag', {
            kind: 'panel-boundary',
            message: String((error && error.message) || error || ''),
            stack: String((error && error.stack) || '').slice(0, 1800),
            componentStack: String((info && info.componentStack) || '').slice(0, 1200),
          })
        } catch (inner) { /* 上报失败不能连累面板 */ }
      }
      render() {
        if (this.state.error !== null && this.state.error !== undefined) {
          const message = String((this.state.error && this.state.error.message) || this.state.error)
          const stack = String((this.state.error && this.state.error.stack) || '').split('\n').slice(0, 8).join('\n')
          return React.createElement('div', { className: 'dsmr-root', 'data-dsmr-error': '1' },
            React.createElement('div', { className: 'dsmr-sec-head' }, '遥控器面板渲染出错'),
            React.createElement('div', { className: 'dsmr-note' }, message),
            React.createElement('pre', {
              className: 'dsmr-note', style: { whiteSpace: 'pre-wrap', fontSize: 11, margin: 0 },
            }, stack))
        }
        return this.props.children
      }
    }

    function Panel(props) {
      /** 上次自动启动链路的结果（只给诊断用，界面上不显示）。 */
      const lastAutoRef = React.useRef(null)
      /*
       * 挂载探测：面板白屏时，先要分清是"组件根本没被渲染"还是"渲染了但炸在半路"。
       * 探针读的是挂载后的真实 DOM 计数 —— 两者都上报不了时，问题就在更外层（slot 没接上）。
       */
      React.useEffect(() => {
        try {
          const doc = window.document
          void post('/diag', {
            kind: 'panel-mounted',
            embedded: props !== undefined && props.embedded === true,
            sections: doc.querySelectorAll('[data-dsmr-sec]').length,
            figure: doc.querySelectorAll('[data-dsmr-figure]').length,
            cards: doc.querySelectorAll('[data-dsmr-card]').length,
          })
        } catch (error) { /* 探测失败不影响渲染 */ }
        /*
         * 面板一打开就自动把整条链路拉起来（用户 2026-10-11 要求：不要"启用自定义按键功能"那种总闸）。
         * host 那边做三件事：找到蓝牙驱动宿主 → 起 Frida 采集器 → 起 read 模式的引擎。
         * 起完只把结果放消息里，界面不弹任何东西。
         */
        void post('/bridge/auto', {}).then((result) => {
          try {
            if (result === null || result === undefined || result.ok !== true) {
              lastAutoRef.current = result === null || result === undefined ? 'no-result' : String(result.error || 'failed')
            } else {
              lastAutoRef.current = 'ok:' + String(result.mode || '')
            }
          } catch (error) { /* 忽略 */ }
        })
      }, [])
      return h(PanelBoundary, null,
        h('div', { className: 'dsmr-root', 'data-dsmr-panel': props && props.embedded ? 'embedded' : 'overlay' },
          h('div', { className: 'dsmr-sub' }, t('subtitle')),
          /*
           * 主版式（用户 2026-10-11 指定）：
           *   左 = 遥控器图 + 中间两列按键卡片（MappingSection 内部再分）
           *   右 = 状态列（LinkSection：遥控器状态含电量 / VB-CABLE / 输入法 / 语音输入路径）
           * 「无线麦 SayAll」那一项已按要求移除；「语音独占」移进语音输入路径的浮层里。
           */
          h('div', { className: 'dsmr-layout' },
            h(MappingSection, null),
            h(LinkSection, null))))
    }

    function Overlay(props) {
      if (!props.open) return null
      return h('div', {
        className: 'dsmr-overlay', role: 'dialog', 'aria-label': PANEL_TITLE,
        onMouseDown: (event) => { if (event.target === event.currentTarget) props.onClose() },
      }, h('div', { className: 'dsmr-overlay-card' },
        h('div', { className: 'dsmr-overlay-head' },
          h('span', { className: 'dsmr-title' }, PANEL_TITLE),
          h('button', { type: 'button', className: 'dsmr-btn', onClick: props.onClose }, zh ? '关闭' : 'Close')),
        h(Panel, { embedded: false })))
    }

    /* ── 左侧栏入口行 ──────────────────────────────────────────────────── */

    function FooterEntry(props) {
      // wide = 官方 footer 席位给的列状态（宽栏 true / 折叠 56px 栏 false）；折叠时只画图标。
      // 这一行的 DOM 与 class 与 workdesktop 的 WorkspaceIconRow 逐一对应，用户看到的才是「同一列」。
      const wide = props === undefined || props === null || props.wide !== false
      const [state] = usePoll('/link', 12000)
      const link = state.data && state.data.link
      const ready = link ? ['remote', 'sayall', 'cable', 'wetype'].filter((key) => link[key] && link[key].ok).length : 0
      // 状态不画在行上（那会破坏与其余各行的一致性），只进 title 提示。
      const hint = PANEL_TITLE + (link ? '（链路 ' + ready + '/4）' : '')
      return h('div', { className: 'dsmr-wsrows', 'data-dsmr-footer': 'mi-remote' },
        h('button', {
          type: 'button',
          className: 'dsmr-wsrow' + (wide ? '' : ' dsmr-wsrow--rail'),
          title: hint,
          'aria-label': PANEL_TITLE,
          onClick: () => { openPanel() },
          // 右键 = 重新体检（不想开面板时）
          onContextMenu: (event) => { event.preventDefault(); openPanel() },
        },
        h('span', { className: 'dsmr-wsic' }, h(RemoteIcon, { size: wide ? 16 : 18 })),
        wide ? h('span', { className: 'dsmr-wsname' }, PANEL_TITLE) : null))
    }

    /* ── 打开面板：优先官方右侧栏，退回遮罩 ─────────────────────────────── */

    let overlayOpen = null
    let ctxRef = null

    function openPanel() {
      let right
      try { right = ctxRef === null ? undefined : ctxRef.get('sidebarRight') } catch (e) { right = undefined }
      const fallback = () => { if (overlayOpen !== null) overlayOpen(true) }
      if (right !== undefined && right !== null && typeof right.openTab === 'function') {
        const attempt = (left) => {
          try { right.openTab(SIDEBAR_TAB_ID); return } catch (e) {
            if (left > 0) window.setTimeout(() => attempt(left - 1), 1200)
            else fallback()
          }
        }
        attempt(2)
        return
      }
      fallback()
    }

    /* ── apply ─────────────────────────────────────────────────────────── */

    function apply(ctx) {
      ctxRef = ctx
      ensureStyle()

      // ① 左侧栏那一行「遥控器」= **不再由本插件注册**。
      //
      // 用户 2026-10-08 的最终裁定：遥控器要排在工作台/驾驶舱/坐标系/工程图/建模中心这一列的
      // **驾驶舱下方、坐标系上方**。而那 5 行**不是 5 个独立注册** —— 它们是 dsh-workdesktop
      // 在一次注册里渲染出来的 5 行（数据源是它的 `WORKSPACES` 数组）。slot 只能给
      // 「整个 workdesktop 块」和「本插件的块」排序，**插不进一个组件内部**。
      // 所以正确做法是把「遥控器」写进那份 `WORKSPACES` 数组（与 `dsh-coords:center`
      // / `dsh-modeling:center` 完全同一种模式：别的插件注册 kind，它只放一行）。
      // 已落盘位置：dsh-workdesktop/lib/client.js 的 `MI_REMOTE_KIND` + WORKSPACES 第二项。
      //
      // ⚠️ 因此本插件**不再**往 sidebar.footer.action 注册 —— 否则那一列会出现两行「遥控器」。
      //    FooterEntry 组件与它的 .dsmr-wsrow 样式**保留**（下面没删），回退时把这三行恢复即可：
      //      ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
      //        { name: 'sidebar.footer.action', id: FOOTER_ID, order: 20, label: PANEL_TITLE },
      //        FooterEntry)))
      void FooterEntry
      void FOOTER_ID

      // ② 官方右侧栏 Tab：guide order 25 < 工作台的 30 ⇒ 指南页入口卡也排在它上方
      let sidebarRegistered = false
      function tryRegisterSidebarTab() {
        if (sidebarRegistered) return
        let tabs
        try { tabs = ctx.get('sidebarRightTabs') } catch (e) { tabs = undefined }
        if (tabs === undefined || tabs === null || typeof tabs.register !== 'function') return
        sidebarRegistered = true
        ctx.effect(() => tabs.register({
          id: SIDEBAR_TAB_ID,
          kind: SIDEBAR_TAB_ID,
          title: () => PANEL_TITLE,
          guide: [{
            id: 'mi-remote',
            // 位置：**驾驶舱（31）之后、坐标系（32）之前** —— 用户 2026-10-08 裁定。
            // 官方按 order 升序排（tab-registry 的 guideEntries.sort），order 允许小数，
            // 所以 31.5 正好插进这两个相邻整数之间。
            // ⚠️ 这条只对**右侧栏指南页**成立：那里的每张卡是各自独立的注册。
            //    左侧栏底部那 5 行（工作台/驾驶舱/坐标系/工程图/建模中心）是 workdesktop
            //    **一个组件内部**渲染的，跨插件无法插进它们中间 —— 左侧栏只能整体在它上/下。
            order: 31.5,
            title: () => PANEL_TITLE,
            description: () => (zh
              ? '遥控器控制台：链路体检 · 按键映射到 DSH 动作 · 语音输入路径切换'
              : 'Xiaomi remote console for DSH'),
            icon: GuideIcon,
          }],
        }))
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: SIDEBAR_TAB_ID },
          () => h(Panel, { embedded: true }))))
      }

      tryRegisterSidebarTab()
      let tries = 0
      const stop = ctx.interval(() => {
        tries += 1
        tryRegisterSidebarTab()
        if (sidebarRegistered || tries >= 30) stop()
      }, 1000)

      /* ── ④ 快捷动作：注册成 DSH 的「可绑快捷键命令」（用户 2026-10-11 要求）─────────
       *
       * 用户要的六个功能，本质都是"给 DSH 加一个能绑键的动作"：
       *   在侧边栏打开 工作台 / 驾驶舱 / 工程图 / 坐标系 / 建模中心
       *   鼠标聚焦到聊天框
       *
       * 做法：这里是 DSH 的客户端插件，可以直接 `ctx.shortcuts.register(...)` 注册命令；
       * 注册完在 DSH「设置 → 快捷键」里就能绑键，遥控器再把那组键注入进去 —— 遥控器侧不用改。
       *
       * ⚠️ 面板 id 全部**量自各插件的源码**，别凭印象改：
       *     dsh-workdesktop/lib/client.js:11477  SIDEBAR_TAB_ID      = 'dsh-workdesktop:console'
       *     dsh-workdesktop/lib/client.js:11478  PANEL_DASH_ID       = 'dsh-workdesktop:dashboard'
       *     dsh-workdesktop/lib/client.js:11483  PANEL_PROJECT_GRAPH = 'dsh-workdesktop:project-graph'
       *     dsh-coords/lib/client.js:891         PANEL_ID            = 'dsh-coords:center'
       *     dsh-modeling/lib/client.js:2183      PANEL_ID            = 'dsh-modeling:center'
       *
       * 打开方式用官方右栏的公开入口（dsh-coords/client.js:2439 也是这么做的）：
       *     ctx.get('sidebarRight').openTab(kind)
       * 它需要时会自己把右栏展开 —— "内容看不见就不算打开"是官方自己保证的。
       */
      const PANEL_ACTIONS = [
        { id: 'remote.panel.workbench',    label: '打开工作台',   kind: 'dsh-workdesktop:console',       code: 'Digit1' },
        { id: 'remote.panel.dashboard',    label: '打开驾驶舱',   kind: 'dsh-workdesktop:dashboard',     code: 'Digit2' },
        { id: 'remote.panel.projectGraph', label: '打开工程图',   kind: 'dsh-workdesktop:project-graph', code: 'Digit3' },
        { id: 'remote.panel.coords',       label: '打开坐标系',   kind: 'dsh-coords:center',             code: 'Digit4' },
        { id: 'remote.panel.modeling',     label: '打开建模中心', kind: 'dsh-modeling:center',           code: 'Digit5' },
      ]

      /** 打开官方右栏的某一栏。服务没到位时返回 false（不抛）。 */
      function openRightPanel(kind) {
        try {
          const right = ctx.get('sidebarRight')
          if (right !== undefined && right !== null && typeof right.openTab === 'function') {
            right.openTab(kind)
            return true
          }
        } catch (e) { /* 还没有会话面/右栏服务，等下一次 */ }
        return false
      }

      /** 把焦点放回聊天输入框。找不到就返回 false。 */
      function focusComposer() {
        try {
          const scope = document.querySelector('[data-conversation-session]') || document
          const candidates = scope.querySelectorAll(
            'textarea, [contenteditable="true"], [contenteditable=""]')
          for (const el of candidates) {
            if (el.hasAttribute('disabled') || el.getAttribute('aria-hidden') === 'true') continue
            const rect = el.getBoundingClientRect()
            if (rect.width < 8 || rect.height < 8) continue      // 不可见的跳过
            el.focus()
            // 光标落到末尾，符合"接着打字"的直觉
            try {
              const range = document.createRange()
              range.selectNodeContents(el)
              range.collapse(false)
              const sel = window.getSelection()
              sel.removeAllRanges()
              sel.addRange(range)
            } catch (e) { /* contenteditable 之外的元素不用设光标 */ }
            return true
          }
        } catch (e) { /* 选择器在非标准 DOM 里可能失败 */ }
        return false
      }

      /**
       * 打开左侧栏会话列表里**第一条可见的**会话。
       *
       * 用户的用法（2026-10-11 定稿）：先用语音把关键字打进「筛选对话…」框，
       * 列表随之只剩匹配项，再按这个键打开第一条 —— 遥控器上不需要打字。
       *
       * 为什么直接点 DOM 而不调接口：
       *   ① 会话行自己就带点击处理 —— `Rows.tsx:598  onClick={() => { onOpen(node.id) }}`，
       *      统一的标记是 `data-row-key={`session:${id}`}`（Rows.tsx:589）；
       *      点它走的就是 DSH 自己的打开路径，不会因为服务名/参数形状猜错而失效。
       *   ② `sessions.search()` 那条路虽然存在（ui-workspace/index.ts:126），
       *      但还要自己取当前筛选词、还要凑对 SessionTarget 的形状，反而脆。
       * 筛选生效时被滤掉的行不会渲染，所以"DOM 里第一条可见的"就是"搜索结果第一条"。
       */
      /**
       * 打开左侧栏会话列表里**第一条可见的**会话（DOM 兜底路径）。
       *
       * 只在接口那条路走不通时才用。会话行自己带点击处理 ——
       * `Rows.tsx:598  onClick={() => { onOpen(node.id) }}`，标记是
       * `data-row-key={`session:${id}`}`（Rows.tsx:589），点它走的就是 DSH 自己的打开路径。
       */
      function openFirstSessionRowByDom() {
        try {
          const rows = document.querySelectorAll('[data-row-key^="session:"]')
          for (const row of rows) {
            if (row.getAttribute('aria-disabled') === 'true') continue
            const rect = row.getBoundingClientRect()
            if (rect.width < 8 || rect.height < 8) continue      // 收起/被滤掉的不算
            row.click()
            return true
          }
        } catch (e) { /* 非标准 DOM 下静默失败 */ }
        return false
      }

      /**
       * 读左侧栏那个搜索框里的当前值 —— 用户是用语音把关键字打进去的。
       *
       * ⚠️ placeholder 的**实际值**是「搜索会话名称」（ui-workspace/locales.ts:40
       *    `'search.placeholder': '搜索会话名称'`），**不是**「筛选对话…」。
       *    我第一版只匹配「筛选」和拉丁 filter/search，于是永远返回空字符串 ——
       *    表现就是"按了没反应，永远打开的不是搜出来的那条"（用户 2026-10-11 报的）。
       *
       * 另外**不做"随便找个非空输入框"的兜底**：那会把聊天框里正在写的正文当成搜索词，
       * 搜出一堆无关会话。宁可返回空，由上层走"列表第一条"。
       */
      function readSidebarFilter() {
        try {
          const inputs = document.querySelectorAll('input[type="text"], input:not([type])')
          // 先按完整 placeholder 精确认（中英都列上）
          const exact = ['搜索会话名称', 'Search sessions', 'Search session names']
          for (const el of inputs) {
            const ph = String(el.placeholder || '')
            if (exact.some((s) => ph.indexOf(s) >= 0)) return String(el.value || '').trim()
          }
          // 再按宽松词认（同一个框改文案时不至于立刻失效）
          const loose = ['搜索会话', '筛选对话', '筛选']
          for (const el of inputs) {
            const ph = String(el.placeholder || '')
            if (loose.some((s) => ph.indexOf(s) >= 0) || /session|filter/i.test(ph)) {
              return String(el.value || '').trim()
            }
          }
        } catch (e) { /* ignore */ }
        return ''
      }

      /**
       * 打开第一条会话 —— 用户的用法：**先用语音把关键字打进筛选框，再按一下这个键**。
       *
       * ⚠️ 2026-10-11 用户报"Ctrl+Alt+Q 未生效"之后重写的：原来只点 DOM，
       *    而**侧边栏一收起就没有可见的会话行** → 函数返回 false、静默什么都不做。
       *    现在主路径走接口，DOM 只作最后兜底。
       *
       * 接口形状全部量自类型定义（不猜）：
       *   sessions.search(q, signal) → { ok, value: { items: [{ sessionId, snippet }] } }
       *       dsh-api-session-controller/lib/types/client/sessions/manager.d.ts:150
       *   sessions.list.getSnapshot().items → SessionListEntry[]，字段名是 **sessionId**
       *       …/sessions/lineage.d.ts:11
       *   uiWorkspace.openSession(target)，target = SessionId | SubagentAddress，**就是字符串**
       *       …/contract/sessions.d.ts:20；服务名见 dsh-client-ui-workspace/lib/client.js:772 的 super(ctx, "uiWorkspace")
       *
       * 三条路依次退：① 有筛选词 → 搜内容取第一条命中；② 退回列表里第一条非空会话；
       * ③ 再不行才点 DOM。
       */
      /** 当前正开着的会话 id（从左侧栏选中行读，读不到就给空串）。 */
      function currentSessionId() {
        try {
          const row = document.querySelector('[data-row-key^="session:"][aria-selected="true"]')
          if (row === null) return ''
          return String(row.getAttribute('data-row-key') || '').replace(/^session:/, '')
        } catch (e) { return '' }
      }

      async function openFirstSession() {
        /*
         * ⓪ 先看有没有被高亮的行（搜索框有内容时，输入一变我就把第一条高亮了；
         *    用户也可以用 ↑/↓ 挪）。**有就打开它** —— 这才是"打开搜索结果第一条"的正解，
         *    比拿搜索词再搜一遍可靠（不用猜 sessions.search 的匹配口径）。
         */
        if (openHighlightedRow()) return true

        let sessions
        let uiWorkspace
        try {
          sessions = ctx.get('sessions')
          uiWorkspace = ctx.get('uiWorkspace')
        } catch (e) { sessions = undefined; uiWorkspace = undefined }

        const canOpen = uiWorkspace !== undefined && uiWorkspace !== null
          && typeof uiWorkspace.openSession === 'function'

        // ① 有筛选词（语音打进来的）→ 搜内容，取第一条命中
        const query = readSidebarFilter()
        if (canOpen && query !== '' && sessions && typeof sessions.search === 'function') {
          try {
            const result = await sessions.search(query, new AbortController().signal)
            const first = (result && result.ok === true && result.value
              && Array.isArray(result.value.items)) ? result.value.items[0] : null
            if (first !== null && first !== undefined && first.sessionId) {
              // 已经是它了就别再切一次 —— 否则连按会看起来像"反复切到同一条"
              if (String(first.sessionId) === currentSessionId()) return true
              uiWorkspace.openSession(first.sessionId)
              return true
            }
          } catch (e) { /* 搜索失败就往下退 */ }
        }

        // ② 退回：列表里第一条（跳过空白会话 —— 列表本来也不显示它们）
        if (canOpen && sessions && sessions.list && typeof sessions.list.getSnapshot === 'function') {
          try {
            const snap = sessions.list.getSnapshot()
            const items = (snap && Array.isArray(snap.items)) ? snap.items : []
            const here = currentSessionId()
            for (const it of items) {
              if (it !== null && it !== undefined && it.sessionId && it.blank !== true) {
                if (String(it.sessionId) === here) return true   // 已经在这条上，不重复切
                uiWorkspace.openSession(it.sessionId)
                return true
              }
            }
          } catch (e) { /* 读不到列表就往下退 */ }
        }

        // ③ 最后兜底：点 DOM 里第一条可见的会话行
        return openFirstSessionRowByDom()
      }

      /* ── ⑤ 搜索结果的键盘导航（用户 2026-10-11 的思路，DSH 本身没做）─────────────
       *
       * 用户原话：「能否让 dsh 在搜索之后默认选中第一个会话，然后可以按方向键的上下切换
       * 选择的对话，按回车键进入会话。」
       *
       * 为什么得由插件补：DSH 把搜索结果渲染成了一棵 `role="tree"` 的树
       * （WorkspaceBrowser.tsx:790，`aria-label` = 「搜索结果」），行上是 `role="treeitem"`，
       * **但没有任何 ↑/↓/Enter 的处理** —— 键盘导航是设计缺失，不是坏了。
       *
       * 抓手用 aria-label 而不是 CSS 类名：`css.searchTree` 是 CSS Module，类名被哈希过，
       * 选中不了；而 `aria-label` 是稳定契约（locales.ts 的 'search.results.aria'）。
       *
       * 实现方式：capture 阶段拦 keydown，**只在搜索框真有内容时**接管 ——
       * 平时完全不碰键盘，不会干扰 DSH 自己的快捷键。
       */
      const HL_ATTR = 'data-dsmr-hl'
      let hlIndex = -1

      /** 搜索框里有内容吗（有才接管方向键）。 */
      function searchActive() {
        return readSidebarFilter() !== ''
      }

      /** 搜索结果那棵树里的行（按 DOM 顺序）。 */
      function searchRows() {
        try {
          const tree = document.querySelector('[role="tree"][aria-label="搜索结果"], [role="tree"][aria-label="Search results"]')
          if (tree === null) return []
          return Array.from(tree.querySelectorAll('[role="treeitem"], [data-row-key^="session:"]'))
            .filter((row) => {
              const rect = row.getBoundingClientRect()
              return rect.width >= 8 && rect.height >= 8
            })
        } catch (e) { return [] }
      }

      /** 把高亮挪到第 i 行（越界就夹住）。默认选中第一条。 */
      function highlightRow(i) {
        const rows = searchRows()
        for (const r of rows) r.removeAttribute(HL_ATTR)
        if (rows.length === 0) { hlIndex = -1; return false }
        hlIndex = Math.max(0, Math.min(rows.length - 1, i))
        const row = rows[hlIndex]
        row.setAttribute(HL_ATTR, '1')
        try { row.scrollIntoView({ block: 'nearest' }) } catch (e) { /* 老浏览器没有这个签名 */ }
        return true
      }

      /**
       * 打开当前高亮的行；没有高亮就选第一条再打开。
       * 复用 DSH 自己的点击路径（Rows.tsx:598 的 onOpen），不猜服务形状。
       *
       * ⚠️ 已经是当前会话就**什么都不做**。原来不管三七二十一都点一下，
       *    于是"每按一次就把同一个会话重开一次" —— 用户看到的就是"反复切换到第一个会话"。
       *    判据用 DSH 自己挂在选中行上的 `aria-selected`（Rows.tsx:596 `aria-selected={selected}`）。
       */
      function openHighlightedRow() {
        const rows = searchRows()
        if (rows.length === 0) return false
        if (hlIndex < 0 || hlIndex >= rows.length) hlIndex = 0
        const row = rows[hlIndex]
        if (row.getAttribute('aria-selected') === 'true') return true   // 已经在这条上，不重复切
        row.click()
        return true
      }

      /*
       * 高亮样式：只加一条 outline，不改 DSH 自己的任何样式。
       *
       * ⚠️ **整段包 try/catch，而且不能让它把异常抛回 apply。**
       *    这是纯装饰 —— 样式没加上，最坏结果是"高亮看不见"，功能照旧；
       *    但如果它抛出来，apply 会中断，**后面的注册（右栏兜底、快捷键命令）全都不会执行**，
       *    整个客户端条目还会进 failed。2026-10-11 的 verify-render 就抓到过这一次：
       *    测试的 document 桩没有 style.setAttribute，apply 当场抛、连带两条断言红掉。
       *    装饰性代码不该有能力搞垮插件加载。
       */
      ctx.effect(() => {
        let style = null
        try {
          if (typeof document === 'undefined' || typeof document.createElement !== 'function') return
          style = document.createElement('style')
          if (typeof style.setAttribute === 'function') style.setAttribute('data-dsmr-hl-style', '1')
          style.textContent = '[' + HL_ATTR + '="1"]{outline:2px solid var(--dsw-alias-border-brand, #4d6bfe);'
            + 'outline-offset:-2px;border-radius:6px}'
          document.head.appendChild(style)
        } catch (e) {
          console.warn('[dsh-mi-remote] 高亮样式没加上（不影响功能）:', e)
          return
        }
        return () => { try { if (style !== null) style.remove() } catch (e) { /* 已移除 */ } }
      })

      ctx.effect(() => {
        const onKey = (event) => {
          if (event.ctrlKey || event.altKey || event.metaKey) return   // 带修饰键的一概不拦
          const key = event.key
          if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Enter') return
          /*
           * 只在"搜索框有内容"且**焦点不在别的输入框里**时才接管。
           * 后者很关键：用户在聊天框里按 ↑/↓/Enter 是正常打字行为，不能被我们抢走。
           */
          if (!searchActive()) return
          const active = document.activeElement
          const inOtherInput = active !== null && active !== undefined
            && active !== document.body
            && (active.tagName === 'TEXTAREA'
              || (active.tagName === 'INPUT' && String(active.placeholder || '').indexOf('搜索') < 0)
              || (active.getAttribute !== undefined && active.getAttribute('contenteditable') === 'true'))
          if (inOtherInput) return

          if (key === 'ArrowDown' || key === 'ArrowUp') {
            event.preventDefault()
            event.stopPropagation()
            // 还没选过就从第一条开始（满足"搜索之后默认选中第一个"）
            if (hlIndex < 0) highlightRow(0)
            else highlightRow(hlIndex + (key === 'ArrowDown' ? 1 : -1))
            return
          }
          // Enter：打开高亮的；没有高亮就打开第一条
          if (hlIndex < 0 && searchRows().length > 0) highlightRow(0)
          if (hlIndex >= 0) {
            event.preventDefault()
            event.stopPropagation()
            openHighlightedRow()
          }
        }
        document.addEventListener('keydown', onKey, true)
        return () => { try { document.removeEventListener('keydown', onKey, true) } catch (e) { /* 已移除 */ } }
      })

      /**
       * 搜索框内容一变，就把高亮重置到第一条 —— 这就是用户要的"搜索之后默认选中第一个"。
       * 用 input 事件（捕获阶段）监听，搜完立刻就有高亮，不用先按一下方向键。
       */
      ctx.effect(() => {
        const onInput = (event) => {
          const t = event.target
          if (t === null || t === undefined || String(t.placeholder || '').indexOf('搜索') < 0) return
          hlIndex = -1
          // 远程搜索是异步的，结果稍后才渲染出来 —— 分几次尝试，命中就停
          let tries = 0
          const timer = setInterval(() => {
            tries += 1
            if (highlightRow(0) || tries >= 12) clearInterval(timer)
          }, 250)
        }
        document.addEventListener('input', onInput, true)
        return () => {
          try { document.removeEventListener('input', onInput, true) } catch (e) { /* 已移除 */ }
        }
      })

      /*
       * ── 批准 / 拒绝：本插件自己注册的**可绑定**命令（2026-10-11 用户选定 B 方案）──────
       *
       * 背景：DSH 自己的 `approval.allow` / `approval.reject` 是用
       * `shortcuts.registerFixed`（ui-approval/src/client/index.ts:81/84）注册的 ——
       * 那一类的定义是"只读输入动作，键位**不可**被分配给可编辑命令"，
       * 在 `definitions()` 里报 `defaults: {}`。**用户在设置里配不了它们。**
       *
       * 而 DSH 的批准请求是可编程应答的：待批准挂在 `uiSession.sessionStatus` 上，
       * 是个带 `answer(outcome)` / `answerable` 的对象
       * （ui-approval/src/client/contract/slots.ts:130/138）。所以这里绕开固定键位，
       * 注册**两条普通命令**，它们有默认键位、用户可改，而且：
       *
       *   · **没有副作用** —— 只在真有批准请求时才做事。DSH 自带的裸 Enter 在没弹窗时
       *     等于"发送消息"，拿它当批准键会把聊天框里的字发出去；
       *   · 用户遥控器上已经绑好的 `Ctrl+Alt+Y` / `Ctrl+Alt+X` 不用改就能用
       *     （那正是原来预设表里写的组合）。
       *
       * ⚠️ 依赖的是**内部 API**（`uiSession.sessionStatus` 与 `PendingApproval.answer`），
       * 不是公开契约。DSH 升级若改了它们，这里会失效 —— 但失效的表现是"按了没反应"，
       * 不会波及其它功能。所以每一层都 try/catch，拿不到就干净地返回 false。
       */

      /**
       * 找当前挂着的批准请求。找不到返回 null（调用方据此什么都不做）。
       */
      function findPendingApproval() {
        try {
          const uiSession = ctx.get('uiSession')
          if (uiSession === null || uiSession === undefined) return null
          const status = uiSession.sessionStatus
          if (status === null || status === undefined || typeof status.getSnapshot !== 'function') return null
          const snapshot = status.getSnapshot()
          if (snapshot === null || snapshot === undefined || typeof snapshot.get !== 'function') return null
          /*
           * 要按会话找回那个请求。会话 id 从 DOM 拿 —— 和 DSH 自己的
           * `stop-shortcut.ts` 同一个做法（它读 `[data-conversation-session]`）。
           * 当前会话的那一条就够：批准弹窗永远是当前会话的。
           */
          const scope = document.querySelector('[data-conversation-session]')
          if (scope === null) return null
          const sessionId = scope.dataset === undefined ? undefined : scope.dataset.conversationSession
          if (sessionId === undefined || sessionId === '') return null
          const entry = snapshot.get(sessionId)
          if (entry === null || entry === undefined) return null
          const pending = entry.pendingInteraction
          if (pending === null || pending === undefined) return null
          // 确认它真的是"可应答的批准"：有 answer 方法、且还没被答过
          if (typeof pending.answer !== 'function') return null
          if (pending.answerable !== true) return null
          return pending
        } catch (error) {
          return null
        }
      }

      /**
       * 应答当前批准请求。`outcome` 取值见 `ApprovalDecision`：
       * `'allowed-once'`（允许一次）或 `'rejected'`（拒绝）。
       *
       * 返回是否真的提交了 —— 没有待批准请求时返回 false，快捷键系统据此显示"不可用"。
       */
      function answerPendingApproval(outcome) {
        const pending = findPendingApproval()
        if (pending === null) return false
        try {
          const maybe = pending.answer(outcome)
          if (maybe !== null && maybe !== undefined && typeof maybe.catch === 'function') {
            maybe.catch((error) => {
              console.warn('[dsh-mi-remote] 应答批准失败:', error)
            })
          }
          return true
        } catch (error) {
          console.warn('[dsh-mi-remote] 应答批准抛错:', error)
          return false
        }
      }

      const SHORTCUT_ACTIONS = PANEL_ACTIONS.concat([
        { id: 'remote.focus.composer', label: '聚焦聊天输入框', run: focusComposer, code: 'KeyF' },
        { id: 'remote.session.first', label: '打开第一条会话（配合语音筛选）', run: openFirstSession, code: 'KeyQ' },
        /*
         * 批准 / 拒绝。键位沿用原来预设表里那两个组合（用户遥控器的电源键已经绑在它们上面）。
         * `onlyWhenApproval: true` 是给 resolve 用的标记：没有待批准请求时回报 `blocked`，
         * 让 DSH 知道"这条现在没事可做"，而不是默默什么都不发生。
         */
        {
          id: 'remote.approval.allow', label: '批准（允许一次）', code: 'KeyY',
          onlyWhenApproval: true, run: () => answerPendingApproval('allowed-once'),
        },
        {
          id: 'remote.approval.reject', label: '拒绝', code: 'KeyX',
          onlyWhenApproval: true, run: () => answerPendingApproval('rejected'),
        },
      ])

      /*
       * 默认键位：**必须给**，否则命令注册了也按不了。
       *
       * 判据（shortcuts/src/client/registry.ts:119-123）：没有绑定的命令 `row.binding === null`，
       * 不会进 bindings 表，快捷键系统根本不认它 —— 用户看到的"快捷键未生效"就是这个。
       *
       * 只在 web:windows / web:macos 上给：`isWebBindingAllowed`（binding.ts:96）对 web 平台
       * 只放行"两修饰键且含 primary + alt/shift"以及三修饰键；**web:linux 不在放行名单里**，
       * 给了会直接 `Unsupported Web shortcut` 抛错。所以 linux 那条故意不写（省略 = 跳过检查）。
       */
      function defaultsFor(code) {
        return {
          'web:windows': { code: code, modifiers: ['primary', 'alt'] },   // Windows 上 primary = Ctrl
          'web:macos': { code: code, modifiers: ['primary', 'alt'] },     // macOS 上 primary = Cmd
        }
      }

      for (const action of SHORTCUT_ACTIONS) {
        /*
         * 每条单独 try/catch：某一条撞了别的命令的默认键位时，registry 会抛
         * `Conflicting shortcut defaults` —— 那时**其余几条照样要注册上**，
         * 而且绝不能让异常冒到 apply 外面（那会让整个客户端条目进 failed、面板都没了）。
         */
        try {
          ctx.effect(() => ctx.shortcuts.register({
            id: action.id,
            label: () => action.label,
            aliases: ['remote', '遥控器'],
            defaults: defaultsFor(action.code),
            regions: ['page', 'editable'],
            modals: [],
            /*
             * `onlyWhenApproval` 那两条：**没有待批准请求时回报 blocked**。
             *
             * 为什么不能一律 handled：那样遥控器按下去"没反应但也没提示"，
             * 你会分不清是键没生效还是本来就没东西可批。回报 blocked 之后
             * DSH 会显式告诉你这条命令当前不可用。
             *
             * 计时提示：判断放在 resolve 里（每次按键都会走），而不是注册时算一次 ——
             * 批准弹窗是随时出现的，注册那一刻没有不代表之后没有。
             */
            resolve: () => {
              if (action.onlyWhenApproval === true && findPendingApproval() === null) {
                return { status: 'blocked', reason: '当前没有待批准的请求' }
              }
              return {
                status: 'handled',
                run: () => {
                  if (action.kind !== undefined) { openRightPanel(action.kind); return }
                  /*
                   * `openFirstSession` 是 async 的（要 await sessions.search），
                   * 而 run 是同步调用点 —— 不能把 Promise 丢出去不管（未捕获的 rejection
                   * 会冒到全局）。这里显式接住。
                   */
                  try {
                    const maybe = action.run()
                    if (maybe !== null && maybe !== undefined && typeof maybe.catch === 'function') {
                      maybe.catch((error) => {
                        console.warn('[dsh-mi-remote] 快捷动作执行失败:', action.id, error)
                      })
                    }
                  } catch (error) {
                    console.warn('[dsh-mi-remote] 快捷动作执行失败:', action.id, error)
                  }
                },
              }
            },
          }))
        } catch (error) {
          console.warn('[dsh-mi-remote] 快捷键命令注册失败:', action.id, error)
        }
      }

      // ③ 遮罩兜底
      ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register(
        { name: 'shell.overlay', id: 'dsh-mi-remote', order: 45 },
        function OverlayHost() {
          const [open, setOpen] = React.useState(false)
          React.useEffect(() => {
            overlayOpen = setOpen
            return () => { if (overlayOpen === setOpen) overlayOpen = null }
          }, [])
          return h(Overlay, { open: open, onClose: () => setOpen(false) })
        })))

      // ④ 布局诊断上报（2026-10-08）：把左侧栏底部那两块的真实几何 + 父容器的 flex 方向
      //    上报给宿主 /diag。起因是用户连着两轮说「位置不对」，而截图只能证明现象：
      //    「父容器是不是同一个、flex-direction 是什么、谁在上面」只有页面自己知道。
      //    读的全是 DOM 实测值，不做推断；延迟 2.5s 是为了等 footer 渲染完。
      ctx.effect(() => {
        const win = typeof window === 'undefined' ? null : window
        if (win === null || typeof win.setTimeout !== 'function') return undefined
        const timer = win.setTimeout(() => {
          try {
            const doc = win.document
            const box = (el) => {
              const r = el.getBoundingClientRect()
              return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }
            }
            const describe = (el) => {
              if (el === null || el === undefined) return null
              const parent = el.parentElement
              const cs = parent === null ? null : win.getComputedStyle(parent)
              const siblings = parent === null ? [] : Array.prototype.slice.call(parent.children, 0, 12).map((child) => ({
                tag: String(child.tagName || ''),
                mark: child.getAttribute('data-dsmr-footer') !== null ? 'dsmr'
                  : child.getAttribute('data-dshw-footer') !== null ? 'dshw' : '',
                cls: String(child.className || '').slice(0, 60),
                top: box(child).top,
                h: box(child).h,
              }))
              return {
                top: box(el).top,
                h: box(el).h,
                w: box(el).w,
                parentClass: parent === null ? '' : String(parent.className || ''),
                parentDisplay: cs === null ? '' : String(cs.display || ''),
                parentDirection: cs === null ? '' : String(cs.flexDirection || ''),
                parentRect: parent === null ? null : box(parent),
                siblings,
              }
            }
            const mine = doc.querySelector('[data-dsmr-footer]')
            const theirs = doc.querySelector('[data-dshw-footer]')
            void fetch(API + '/diag', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                at: Date.now(),
                viewport: { w: win.innerWidth, h: win.innerHeight },
                /*
                 * 面板挂载计数：白屏时靠它区分「组件从没被渲染」和「渲染过但内容空」。
                 * 这是唯一一条**每次加载都会跑、而且不会被别的上报覆盖**的通道
                 * （host 那边只留最后一份，而这条是最后一次发的）。
                 */
                panelSeen: doc.querySelectorAll('[data-dsmr-panel]').length,
                sectionsSeen: doc.querySelectorAll('[data-dsmr-sec]').length,
                boundaryError: doc.querySelectorAll('[data-dsmr-error]').length,
                mine: describe(mine),
                theirs: describe(theirs),
                sameParent: mine !== null && theirs !== null && mine.parentElement === theirs.parentElement,
              }),
            })
          } catch (error) { /* 诊断失败不能影响插件本身 */ }
        }, 2500)
        return () => { win.clearTimeout(timer) }
      })

      /*
       * ⑤ 错误上报：面板白屏时我读不到浏览器控制台，这是唯一能把原因送回来的通道。
       * 用 window 的 error / unhandledrejection —— React 渲染期抛出的错误也会冒到这里。
       */
      ctx.effect(() => {
        const win = typeof window === 'undefined' ? null : window
        if (win === null || typeof win.addEventListener !== 'function') return undefined
        const report = (payload) => { try { void post('/diag', payload) } catch (error) { /* 上报失败不能连累插件 */ } }
        const onError = (event) => {
          const err = event === null || event === undefined ? null : event.error
          report({
            kind: 'window-error',
            message: String((event && event.message) || ''),
            source: String((event && event.filename) || ''),
            line: Number((event && event.lineno) || 0),
            stack: String((err && err.stack) || '').slice(0, 1500),
          })
        }
        const onRejection = (event) => {
          const reason = event === null || event === undefined ? null : event.reason
          report({
            kind: 'unhandled-rejection',
            message: String((reason && reason.message) || reason || ''),
            stack: String((reason && reason.stack) || '').slice(0, 1500),
          })
        }
        win.addEventListener('error', onError)
        win.addEventListener('unhandledrejection', onRejection)
        return () => {
          win.removeEventListener('error', onError)
          win.removeEventListener('unhandledrejection', onRejection)
        }
      })

      /*
       * ⑥ 席位崩溃监听（2026-10-08 · 面板纯白的真正原因就在这里）。
       *
       * slot 系统用 React 的 ErrorBoundary 包住每个席位，**渲染一崩就把这个条目"退位"**
       * （abdicated）—— 表现就是整块变白。而它**只通过 onEntryError 通知内部监听者，
       * 不会冒到 window.onerror**，所以上面的错误上报什么都收不到。
       * 这条是唯一能把原因捞出来的通道；捞到的错误直接上报宿主。
       */
      ctx.effect(() => {
        const slots = ctx.slots
        if (slots === undefined || slots === null || typeof slots.onEntryError !== 'function') return undefined
        const off = slots.onEntryError((key, entry, error, info) => {
          try {
            void post('/diag', {
              kind: 'entry-error',
              slotKey: String(key),
              abdicated: info === null || info === undefined ? null : info.abdicated === true,
              message: String((error && error.message) || error || ''),
              stack: String((error && error.stack) || '').slice(0, 1800),
            })
          } catch (inner) { /* 上报失败不能连累插件 */ }
        })
        return () => { try { if (typeof off === 'function') off() } catch (inner) { /* 已释放 */ } }
      })
    }

    return {
      // ⚠️ `timer` **必须**声明：apply 里第 ② 步那次 `ctx.interval(...)`（右栏 Tab 注册重试）
      //   读的不是 Context 自己的方法，而是 TimerService 通过 `ctx.mixin('timer', [...])`
      //   混进来的 accessor（同批还有 timeout / throttle / debounce / setTimeout / setInterval）。
      //   cordis 的 ctx 代理只允许读 inject 里列过的服务 —— 少了这一项，apply 当场抛
      //   `cannot get property "interval" without inject`，客户端条目进 failed，
      //   启动页显示「Failed to load plugins / dsh-mi-remote」。
      //   本插件从 dsh-remote-mic 派生时漏带了这个修复（2026-10-08 同一坑踩了第二次）。
      //
      // ⚠️ `shortcuts` 同理（2026-10-11 加"在侧边栏打开工作台/坐标系/工程图/建模中心 + 聚焦聊天框"
      //   这几个命令时补的）：第 ④ 步要调 `ctx.shortcuts.register(...)`，那是**经过 ctx 代理**的
      //   服务读取，不在 inject 里就抛 `cannot get property "shortcuts" without inject`。
      //   注意 `ctx.get('sidebarRight')` 不受影响 —— 那是 Context 自己的方法，不走代理。
      inject: ['slots', 'timer', 'shortcuts'],
      apply: apply,
      name: 'dsh-mi-remote',
      // 纯函数/组件出口：自测直接读，不必等浏览器。
      // FooterEntry / GuideIcon 放进来是为了让「那一行的渲染」与「指南卡图标」两件事
      // 即使不再/无法通过席位注册，也仍能被离线冒烟测到。
      __test: { S, t, isChinese, BUTTON_LABELS, SLOT_KEYS, FooterEntry, GuideIcon },
    }
  },
})
