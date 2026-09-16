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
      '.dshw-root.dshw-embedded .dshw-grid{grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}',
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
      '.dshw-tabs{display:flex;flex-wrap:wrap;gap:4px}',
      '.dshw-tab{font:500 11px/1 system-ui,sans-serif;padding:4px 9px;border-radius:999px;cursor:pointer;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1)}',
      '.dshw-tab:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dshw-tab[data-on="1"]{color:var(--dsw-alias-bg-base);background:var(--dsw-alias-brand-primary);border-color:transparent}',
      '.dshw-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px;align-items:stretch;flex:1 1 auto;min-height:0;overflow:auto}',
      // 卡片统一**最小高度**（2026-09-15 用户更正：限制的是下限，不是上限）：
      // 比例由 JS 按「卡片行数」算出并写入 --dshw-card-min（6 行 16% · 4 行 24% · 3 行 33% · 2 行 49%）。
      // 内容多则卡片自然变高（栅格滚动），内容少也不塌成一条。
      '.dshw-grid > .dshw-card{min-height:var(--dshw-card-min,33%);display:flex;flex-direction:column}',
      '.dshw-card{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 10px 9px;min-width:0}',
      // 「系统状态」卡：麦克风条放在**标题右侧**（2026-09-15 用户要求：紧接"系统状态"四个字之后）。
      // 用 --nowrap 卡头 + 可收缩的 pill 组合保证"同一行"（下面两条注释解释了为什么必须这样）。
      '.dshw-card-head{display:flex;align-items:center;gap:6px;margin-bottom:5px;flex-wrap:wrap}',
      // ⚠️ 2026-09-15 用户实测（截图）：卡头**先按"基础宽度"决定换行、之后才谈收缩** ——
      //    因此在窄卡里麦克风条会被挤到第二行，而不是缩着留在标题右侧。
      //    故：带内联块（headInline）的卡头**禁止换行**，改为让各块收缩；这样它才能真的贴着标题右侧。
      '.dshw-card-head--nowrap{flex-wrap:nowrap;min-width:0;overflow:hidden}',
      '.dshw-card-title{font-size:12px;font-weight:600;flex:none}',
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
      // 知识库卡片内的分类 tab（2026-09-15：这组 tab 只影响知识库内容 → 移进卡片；用户要求**左对齐**）：
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
      // 小卡片栅格（2026-09-15 用户要求：**收紧间距**；2026-09-16 用户要求：**整体自动排列 = 3+3**）
      //   `minmax(clamp(70px,32%,100%),1fr)`：列宽基准取"约 1/3 行宽"（下限 70px，可读性兜底）——
      //   于是 **列数稳定为 3**（实测 243/284/400/600/900px 容器都得到 3 列），
      //   6 张卡片自然排成 **3+3**；容器 <210px 时才降为 2 列（=2+2+2，仍是均匀行）或 1 列。
      //   ⚠️ 不要退回固定 minmax(92px)：那会在窄卡里只排 2 列、宽卡里排 4 列（4+2 又不均）。
      '.dshw-minigrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(clamp(70px,32%,100%),1fr));gap:4px;margin-top:4px}',
      '.dshw-mini{border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;padding:4px 6px;background:var(--dsw-alias-bg-layer-2);min-width:0}',
      '.dshw-mini-t{font-size:9.5px;color:var(--dsw-alias-label-secondary);margin-bottom:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshw-mini-s{font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshw-mini-s[data-state="ok"]{color:#2ea043}',
      '.dshw-mini-s[data-state="busy"]{color:#d29922}',
      '.dshw-mini-s[data-state="warn"]{color:#d29922}',
      '.dshw-mini-s[data-state="down"]{color:#da3633}',
      '.dshw-mini-s[data-state="off"]{color:#8b949e}',
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
      '.dshw-item{display:flex;gap:8px;padding:2.5px 4px;align-items:baseline;border-radius:6px}',
      '.dshw-item[data-click="1"]{cursor:pointer}',
      '.dshw-item[data-click="1"]:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dshw-item-time{flex:none;width:66px;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.dshw-item-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      // 在场对象卡（2026-09-16）：客户行的第二行 = 「下一步」。**不能**套 .dshw-item-text ——
      //   那一列是 nowrap + ellipsis，会把"下一步"吃掉半截；这里按 payload 原样换行显示完整。
      //   左内边距 = 行内边距 4px + 时间列 66px + 间距 8px ⇒ 与上一行的文字列对齐。
      '.dshw-objnext{font-size:10.5px;color:var(--dsw-alias-label-secondary);padding:0 4px 2px 78px;cursor:pointer;word-break:break-all}',
      '.dshw-objnext:hover{color:var(--dsw-alias-label-primary)}',
      // 日程来源标签（钉钉 / 飞书 / 行程）—— 同一条列表里区分来源
      '.dshw-src{flex:none;font-size:9.5px;line-height:1.4;padding:0 5px;border-radius:5px;border:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}',
      '.dshw-src[data-src="dingtalk"]{color:#2b6cb0;border-color:#bcd3ea}',
      '.dshw-src[data-src="feishu"]{color:#1f7a6b;border-color:#bfe0d8}',
      '.dshw-src[data-src="trip"]{color:#8a5a00;border-color:#e8d6a8}',
      '.dshw-src[data-src="personal"]{color:#6b46c1;border-color:#d6c9f0}',
      // ── 待办列表（2026-09-16 用户四点要求）──────────────────────────
      //   ① 来源标签复用上面的 .dshw-src 药丸（与日程**同一套标记**，视觉一致）；
      //   ② 时间列**收窄到"无期限"三个字**的宽度（原来固定 66px，与标签之间空一大截）；
      //   ③ 全部行照列、不截断；超出卡体高度由 `.dshw-card-body`（max-height:168px + overflow:auto）滚动；
      //   ④ 卡脚不再有「打开目录」按钮、卡内不再有「显示 X / 共 Y 条」字样。
      '.dshw-todolist .dshw-item-time{width:3.4em}',
      '.dshw-empty{font-size:12px;color:var(--dsw-alias-label-secondary);padding:1px 0}',
      '.dshw-err{font-size:11px;color:var(--dsw-alias-state-error-primary);word-break:break-all}',
      '.dshw-detail{margin:0 0 6px;padding:7px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:11.5px;line-height:1.5}',
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
    const STATUS_LABEL = { accepted: '已接受', needsAction: '待回复', declined: '已拒绝', tentative: '暂定' }
    const REC_KINDS = [
      { v: 'progress', l: '进度' },
      { v: 'decision', l: '决策' },
      { v: 'risk', l: '风险' },
      { v: 'note', l: '备忘' },
    ]
    const REC_LABEL = { progress: '进度', decision: '决策', risk: '风险', note: '备忘' }

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

    // ── better-sidebar tab 图标（2026-09-15 需求）───────────────────────────
    // 折叠态侧边栏只显示图标、不显示文字，所以每个 tab 都必须带 icon；
    // 用内联 SVG + currentColor，跟随主题（深/浅色）自动适配。
    const svg = (size, children) => React.createElement('svg', {
      width: size || 16, height: size || 16, viewBox: '0 0 16 16', fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': 'true',
    }, children)

    /** 工作台：面板布局（顶部条 + 右侧列） */
    function iconWorkbench(size) {
      return svg(size, [
        React.createElement('rect', { key: 'r', x: 1.6, y: 2.2, width: 12.8, height: 11.6, rx: 2 }),
        React.createElement('path', { key: 'a', d: 'M1.6 5.6h12.8' }),
        React.createElement('path', { key: 'b', d: 'M9.6 5.6v8.2' }),
        React.createElement('path', { key: 'c', d: 'M4 8.4h3.2' }),
        React.createElement('path', { key: 'd', d: 'M4 10.6h2.2' }),
      ])
    }

    /** 驾驶舱：仪表（半圆刻度 + 指针） */
    function iconDashboard(size) {
      return svg(size, [
        React.createElement('path', { key: 'g', d: 'M2.6 11.9a5.6 5.6 0 0 1 10.8 0' }),
        React.createElement('path', { key: 'n', d: 'M8 11.9l3-3.4' }),
        React.createElement('circle', { key: 'c', cx: 8, cy: 11.9, r: 0.9, fill: 'currentColor', stroke: 'none' }),
        React.createElement('path', { key: 't1', d: 'M2.2 8.2l1.1.5' }),
        React.createElement('path', { key: 't2', d: 'M13.8 8.2l-1.1.5' }),
      ])
    }

    /**
     * 「驾驶舱」tab（better-sidebar）：iframe 内嵌**库内仪表盘**产物。
     *
     * 数据源 = `_meta/out/dashboard.html`（build-snapshot 生成的自包含页面，零外链），
     * 经本插件只读路由 `/workbench/api/dashboard` 提供 —— 不复制数据、不另建派生（P2）。
     */
    function DashboardView() {
      const [nonce, setNonce] = React.useState(0)
      return React.createElement('div', { className: 'dshw-dash' },
        React.createElement('div', { className: 'dshw-dash-bar' },
          React.createElement('span', { className: 'dshw-dash-title' }, '个人 AI 工作台 · 驾驶舱'),
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
          title: '驾驶舱',
        }))
    }

    function lsGet(key) { try { return window.localStorage.getItem(key) } catch (e) { return null } }
    function lsSet(key, value) { try { window.localStorage.setItem(key, value) } catch (e) {} }
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

      function api(path, init) {
        return fetch('/workbench/api' + path, init).then((r) => r.json())
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
        const [note, setNote] = React.useState(null)
        // dev.spkOn / dev.cam = 音响输出通道、摄像头视频轨的**显式开关状态**（点击小卡片切换）
        // dev.spkFailed / dev.camFailed = 上次连接失败（显示红色「断开」，仍可点击重试）
        const [dev, setDev] = React.useState({ phase: 'idle', note: null, mic: 0, spkOn: false, spkFailed: false, cam: false, camFailed: false, camVirtual: null, camInventory: null, devices: null, micLabel: '', camLabel: '' })
        // 头部瞬时提示（设备操作回执）：{ text, key, tone, phase:'in'|'out' } —— 淡入 → 最多 10s → 淡出
        const [toast, setToast] = React.useState(null)
        const toastStopRef = React.useRef(null)
        // 底部系统在线状态（DWS / MCP / 本地工具 / 浏览器）—— 由 host 的 /sysstatus 探测（带缓存）
        const [sysStatus, setSysStatus] = React.useState(null)
        // 实时活动（正在调用哪个 MCP / 正在操作哪个工具 / DWS 是否在采集）—— host /activity，3s 轮询
        const [activity, setActivity] = React.useState(null)
        // 专注块表单（2026-09-14 裁定：面板按钮 + DSH 工具两个入口，面板侧是这里的表单）
        const [focusForm, setFocusForm] = React.useState({ open: false, kind: 'domain', id: '', minutes: '50', label: '' })
        const [focusBusy, setFocusBusy] = React.useState(false)
        const [focusMsg, setFocusMsg] = React.useState(null)
        // 事务详情卡（E 块 2026-09-15 裁定：卡片按钮 → 上层详情卡：详情 / 添加记录 / 关闭或重开）
        const [matterModal, setMatterModal] = React.useState(null)
        // 日程详情卡（2026-09-15 用户要求：**点击日程 → 上层弹窗**显示详情，与事务详情卡同一形态）
        // { e, loading, attendees, error, note }
        const [calModal, setCalModal] = React.useState(null)
        // 在场对象（2026-09-16 新卡）：数据源 = host 只读透传的 objects.json（路由 `/objects`）。
        //   objs = **原始 payload**（本卡不改写、不派生）；objsErr = 读失败 —— 与「无数据」分开存，不合并。
        const [objs, setObjs] = React.useState(null)
        const [objsErr, setObjsErr] = React.useState(null)
        const [objsBusy, setObjsBusy] = React.useState(false)
        // T31 能力①/⑤（2026-09-16）：今日决策面 `brief.json` / 跨源洞察 `insights.json`
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
         *   · /state 的摘要在「流入处置」卡头给三数（有落点/无落点/悬置）—— 便宜、随数据层刷新；
         *   · 独立路由给**清单与定义**（noLanding[] 逐条、definitions、multiSource…）—— 60s 一次。
         * 三态（读失败 / 无数据 / 口径为 0）与 objs 同一口径：docErr 与 doc=null 分开存，不合并。
         */
        const [dispoDoc, setDispoDoc] = React.useState(null)
        const [dispoDocErr, setDispoDocErr] = React.useState(null)
        const [dispoDocBusy, setDispoDocBusy] = React.useState(false)
        const [dispoShowAll, setDispoShowAll] = React.useState(false)
        const [crossDoc, setCrossDoc] = React.useState(null)
        const [crossDocErr, setCrossDocErr] = React.useState(null)
        const [crossDocBusy, setCrossDocBusy] = React.useState(false)
        // 判断质量台账（`/feedback` 只读出口）：给「验收指标」卡**卡内小节**提供裁决统计与待裁定条目。
        // 三态与其它只读出口同一口径：`fbDocErr`（读失败）与 `fbDoc === null`（尚未取到）**分开存**，
        // 不与「无记录」（503 / entries: []）合并 —— 三者混成一个变量就会把"读不到"写成"没有"。
        const [fbDoc, setFbDoc] = React.useState(null)
        const [fbDocErr, setFbDocErr] = React.useState(null)
        const [fbDocBusy, setFbDocBusy] = React.useState(false)
        // 在场对象二级详情（只读）：{ key, item } —— item 为 objects[] 里的原始条目（缺省按 key 查）
        const [objModal, setObjModal] = React.useState(null)
        // 客户行下的场次子行**默认收起**（键 = 客户 key，如 '#nonrollup'）；展开状态只在本次会话内
        const [objOpen, setObjOpen] = React.useState({})
        // 客户级行多于 MAX_ROWS 时的「更多」展开（与其它卡一致：默认只列 MAX_ROWS 条）
        const [objShowAll, setObjShowAll] = React.useState(false)
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
         * 今日决策面（库内产物 `brief.json`，host 只读透传 `/brief`）。
         * ⚠️ host 缺产物时返回 **503 + {error}**（不静默返回空对象）—— 若把 503 当成"空"，
         *    面板会把"没有产物"读成"今天没事"，这是本卡最需要避免的一种假绿。
         */
        function loadBrief() {
          setBriefBusy(true)
          api('/brief')
            .then((data) => { setBrief(data); setBriefErr(null) })
            .catch((e) => setBriefErr(String((e && e.message) || e)))
            .then(() => setBriefBusy(false))
        }

        /** 跨源洞察（库内产物 `insights.json`，host 只读透传 `/insights`）。同上：503 不当空。 */
        function loadInsights() {
          setInsightsBusy(true)
          api('/insights')
            .then((data) => { setInsights(data); setInsightsErr(null) })
            .catch((e) => setInsightsErr(String((e && e.message) || e)))
            .then(() => setInsightsBusy(false))
        }

        /** 处置台账（disposition.json）：给「流入处置」卡提供无落点清单与悬置时长 */
        function loadDispoDoc() {
          setDispoDocBusy(true)
          api('/disposition')
            .then((data) => { setDispoDoc(data); setDispoDocErr(null) })
            .catch((e) => setDispoDocErr(String((e && e.message) || e)))
            .then(() => setDispoDocBusy(false))
        }

        /** 多源校验（crosscheck.json）：给「验收指标」卡提供溯源/支撑/承诺交付/矛盾四个数 */
        function loadCrossDoc() {
          setCrossDocBusy(true)
          api('/crosscheck')
            .then((data) => { setCrossDoc(data); setCrossDocErr(null) })
            .catch((e) => setCrossDocErr(String((e && e.message) || e)))
            .then(() => setCrossDocBusy(false))
        }

        /** 判断质量台账（feedback.json）：给「验收指标」卡内小节提供裁决统计与**待裁定**条目。
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
            .then((res) => { setFbDoc(res); setFbDocErr(null) })
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
          // 处置台账 / 多源校验：同样是库内产物，60s 一次（与 objects 同节奏）
          loadDispoDoc()
          loadCrossDoc()
        // T31 卡（今日决策面 / 跨源洞察）：与 objects/crosscheck 同批首次加载
        loadBrief()
        loadInsights()
          // 判断质量台账（`/feedback`）：与上两条同节奏（人工裁决，变化更慢；60s 足够）
          loadFbDoc()
          // 底部系统在线状态：host 侧探测（带缓存），面板只读；120s 刷新一次
          const loadSys = () => {
            api('/sysstatus').then((j) => setSysStatus(j && j.ok === true ? j : null)).catch(() => {})
          }
          loadSys()
          const stopSys = ctx.interval(loadSys, 120000)
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
          const stopDispo = ctx.interval(loadDispoDoc, 60000)
          const stopCross = ctx.interval(loadCrossDoc, 60000)
        // 今日决策面 / 跨源洞察：与 objects 同节奏（产物由同一条库内管线生成）
        const stopBrief = ctx.interval(loadBrief, 60000)
        const stopInsights = ctx.interval(loadInsights, 60000)
          const stopFb = ctx.interval(loadFbDoc, 60000)
          return () => {
            stopTick()
            stopPwb()
            stopObjs()
            stopDispo()
            stopCross()
            stopFb()
            stopSys()
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
        function card(title, badge, body, extra, tall, headInline) {
          return h('section', { className: 'dshw-card', key: title },
            h('div', { className: 'dshw-card-head' + (headInline ? ' dshw-card-head--nowrap' : '') },
              h('span', { className: 'dshw-card-title' }, title),
              badge ? h('span', { className: 'dshw-badge' }, badge) : null,
              headInline || null,
              headInline ? null : h('span', { className: 'dshw-spacer' }),
              extra || null,
            ),
            h('div', { className: 'dshw-card-body' + (tall ? ' dshw-card-body--tall' : '') }, body),
          )
        }
        function pill(text, tone) { return h('span', { className: 'dshw-pill', 'data-tone': tone || null }, text) }
        function meter(level, kind) {
          return h('span', { className: 'dshw-meter' }, h('i', { 'data-kind': kind || null, style: { width: Math.round(Math.max(0, Math.min(1, level)) * 100) + '%' } }))
        }
        function empty(text, key) { return h('div', { className: 'dshw-empty', key: key || 'e' }, text) }

        const kn = (snap && snap.knowledge) || { total: 0, counts: {}, recent: [], byCategory: {} }
        const counts = kn.counts || {}
        // 分类 tab 只保留标签（2026-09-15 裁定：不在 tab 上显示计数）——
        // 数量信息在下方「知识库 · 分类」卡片的徽标里给出，避免同一数字出现两处。
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
          const actDisp = (id, action, inputId) => {
            const el = document.getElementById(inputId)
            const reason = el ? String(el.value || '').trim() : ''
            if (reason.length === 0) { setNote('请先填写理由（人工处置要留痕）'); return }
            setNote('处置中…')
            api('/disposition/act', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id: id, action: action, reason: reason }),
            }).then((r) => {
              if (r && r.ok === true) { setNote('已' + (action === 'reject' ? '拒绝' : '转出') + '：' + id); loadPwb(true) }
              else setNote('处置失败: ' + String((r && r.error) || '未知原因'))
            }).catch((e) => setNote('处置失败: ' + String((e && e.message) || e)))
          }
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
          cardsByKey.set('inflow', card('流入处置',
            ddSum !== null
              ? ('有落点 ' + ddSum.landed + ' · **无落点 ' + ddSum.noLanding + '**'
                + (typeof ddSum.staleMaxDays === 'number' ? ' · 悬置最长 ' + ddSum.staleMaxDays + ' 天' : ''))
              : ('共 ' + (c.inflow || 0) + ' · 已处置 ' + (c.disposed || 0)
                + (typeof ds.noLanding === 'number' ? ' · 无落点 ' + ds.noLanding : '')),
            [
              h('div', { className: 'dshw-detail', key: 'pwbcounts' },
                h('div', null, '域内 ' + (c.inScope || 0) + ' · 待议 ' + (c.pending || 0) + ' · 域外拦截 ' + (c.outOfScope || 0)),
                h('div', null, dispLine),
                h('div', null, '数据时刻: ' + String(pwb.dataAsOf || '—').slice(0, 19).replace('T', ' ') + '（' + staleness + '）'),
                (c.pending || 0) > 0
                  ? h('div', { style: { color: '#e0a030' } }, '⚠️ 有 ' + c.pending + ' 条待议未处置')
                  : null,
              ),
              // 无落点清单：判定后没有任何落点的流入 —— 以前它们在面板上**不存在**（只剩一个数字）
              dd === null
                ? h('div', { className: 'dshw-detail', key: 'dshw-noland-wait' },
                  dispoDocErr !== null
                    ? '无落点清单读取失败: ' + dispoDocErr
                    : (dispoDocBusy === true ? '正在读取无落点清单…' : '无落点清单: 等待台账（跑 run-objects-pipeline.mjs）'))
                : (noLandRows.length === 0
                  ? h('div', { className: 'dshw-detail', key: 'dshw-noland-zero' },
                    '无落点: 0 条（口径 = 判定后既无事务也无触发落点）')
                  : h('div', { className: 'dshw-detail', key: 'dshw-noland' },
                    [h('div', { key: 'nt' },
                      '无落点清单（按悬置时长降序 · 共 ' + noLandRows.length + ' 条 · 数据时刻 '
                      + String(dd.generatedAt || '—').slice(0, 19).replace('T', ' ') + '）')].concat(
                      noLandShown.map((it, i) => h('div', { key: 'nl' + i, style: { marginTop: '6px' } },
                        h('div', null, String(it.digest_head || '').slice(0, 60)),
                        h('div', { style: { opacity: 0.7 } },
                          '悬置 ' + String(it.pending_days === null || it.pending_days === undefined ? '—' : it.pending_days) + ' 天 · 源 '
                          + String(it.source || '—') + ' · ' + String(it.origin || '').slice(0, 46)),
                        h('div', { style: { opacity: 0.7 } }, String(it.reason || '')),
                      )),
                      noLandRows.length > MAX_ROWS
                        ? h('button', {
                          key: 'nmore', className: 'dshw-btn',
                          onClick: () => setDispoShowAll((v) => v !== true),
                        }, dispoShowAll === true ? '收起' : '展开全部 ' + noLandRows.length + ' 条')
                        : null,
                    ))),
              pendList.length > 0
                ? h('div', { className: 'dshw-detail', key: 'dshw-pending' },
                  [h('div', { key: 'pt' }, '待议队列（需你定边界 · 每行必须写理由）')].concat(
                    pendList.slice(0, MAX_ROWS).map((it, i) => h('div', { key: 'pd' + i, style: { marginTop: '6px' } },
                      h('div', null, String(it.digest || '').slice(0, 60)),
                      h('div', { style: { opacity: 0.7 } }, String(it.reason || '')),
                      h('input', {
                        key: 'pi' + i,
                        id: 'dshw-disp-reason-' + String(it.id),
                        placeholder: '理由（必填）',
                        className: 'dshw-btn',
                        style: { width: '100%', marginTop: '2px' },
                      }),
                      h('button', {
                        key: 'pr' + i, className: 'dshw-btn',
                        onClick: () => actDisp(String(it.id), 'reject', 'dshw-disp-reason-' + String(it.id)),
                      }, '拒绝'),
                      h('button', {
                        key: 'pf' + i, className: 'dshw-btn',
                        onClick: () => actDisp(String(it.id), 'forward', 'dshw-disp-reason-' + String(it.id)),
                      }, '转出'),
                    ))))
                : null,
            ],
            h('button', { className: 'dshw-btn', onClick: () => rebuildPwb(), disabled: pwbBusy }, pwbBusy ? '…' : '重建')))

          const cands = ((pwb.core || {}).candidates) || []
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
          if (cands.length > 0) {
            mtBody.push(h('div', { className: 'dshw-detail', key: 'cand' }, '承诺候选待确认 ' + cands.length + ' 条（需补 domain 与关闭条件）'))
          }
          cardsByKey.set('matters', card('事务',
            '未关闭 ' + mtCounts.todo + ' · 已关闭 ' + mtCounts.closed,
            mtBody))

          const esc = ((pwb.respond || {}).escalated) || []
          const rst = (pwb.respond || {}).stats || {}
          cardsByKey.set('triggers', card('待响应触发',
            '超时 ' + esc.length + ' · 响应率 ' + (rst.responseRate === undefined || rst.responseRate === null ? '—' : (rst.responseRate * 100).toFixed(1) + '%'),
            esc.length === 0
              ? [empty('没有超时未响应的触发', 'noesc')]
              : esc.slice(0, MAX_ROWS).map((t, i) => row(
                String(t.rclass || ''),
                String(t.title || '') + (t.domain ? ' [' + t.domain + ']' : ''),
                'tg' + i,
                null,
                '时限: ' + String(t.sla_label || '') + ' · 到期 ' + String(t.due_at || '').slice(0, 16) + '\n⚠️ 时限未校准，仅供参考',
              )).concat([
                h('div', { className: 'dshw-detail', key: 'slanote' },
                  '⚠️ 时限全部未校准（' + (rst.slaCalibrated === true ? '已校准' : '待校准') + '）—— 不得据此考核'),
              ])))

          const fo = pwb.focus || {}
          const foLast = fo.last || null
          const domainOptions = Array.isArray(pwb.domainOptions) ? pwb.domainOptions : []
          const focusRows = []
          if (fo.active) {
            focusRows.push(h('div', { className: 'dshw-detail', key: 'foa',
              title: '专注目标: ' + String((fo.active.target || {}).id || '') },
              '目标: ' + String((fo.active.target || {}).label || '')
              + ' · 已穿透 ' + fo.active.penetrated_count + ' · 入队 ' + fo.active.queued_count))
          } else if (foLast) {
            const foSum = foLast.summary || null
            focusRows.push(h('div', { className: 'dshw-detail', key: 'fol',
              title: '专注目标: ' + String((foLast.target || {}).id || '') },
              h('div', null, '目标: ' + String((foLast.target || {}).label || '')),
              h('div', null, foSum === null
                ? '上块无摘要（缺 summary，不是 0）'
                : '穿透 ' + String(foSum.penetrated_count ?? '—') + ' 次 · 入队 ' + String(foSum.queued_count ?? '—') + ' 条（闸未停）')))
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
          const focusExtra = fo.active
            ? h('button', { className: 'dshw-btn', onClick: endFocusNow, disabled: focusBusy }, focusBusy ? '…' : '结束专注')
            : h('button', {
              className: 'dshw-btn', disabled: focusBusy,
              onClick: () => setFocusForm((p) => Object.assign({}, p, { open: !p.open })),
            }, focusForm.open ? '收起' : '开始专注')
          cardsByKey.set('focus', card('专注',
            fo.active ? '进行中' : (foLast ? '上块已结束' : '未声明'),
            focusRows,
            focusExtra))

          // ── 活跃关注域（B 块 2026-09-14 裁定 ②）：自动读会话匹配 + agent 声明覆盖 ──
          const ad = pwb.activeDomains
          const adEff = (ad && ad.effective) || []
          const adRows = adEff.length === 0
            ? [empty('尚无匹配（点「重新匹配」读当前会话）', 'noad')]
            : adEff.slice(0, MAX_ROWS).map((d, i) => row(
              String(d.source === 'declared' ? '声明' : '自动'),
              String(d.name || d.id) + ' · ' + String(d.reason || ''),
              'ad' + i,
              null,
              '来源: ' + String(d.source === 'declared' ? 'agent 主动声明' : '会话自动匹配')))
          if (ad && ad.auto && ad.auto.title) {
            adRows.push(h('div', { className: 'dshw-detail', key: 'adsess' },
              '匹配会话: ' + String(ad.auto.title || '').slice(0, 40)
              + (ad.source === 'declared' ? '（当前生效 = 声明覆盖）' : '')))
          }
          cardsByKey.set('domains', card('活跃关注域',
            adEff.length === 0 ? '未匹配' : adEff.length + ' 个',
            adRows,
            h('button', {
              className: 'dshw-btn',
              onClick: () => {
                api('/active-domains?match=1')
                  .catch((e) => setNote('活跃关注域匹配失败: ' + String((e && e.message) || e)))
              },
            }, '重新匹配')))

          const rc = pwb.recall || {}
          const rstats = (rc.stats || {}).s13 || null
          cardsByKey.set('recall', card('唤起 · 沉淀复利',
            rstats ? rstats.value + ' 次/7天' : '—',
            [h('div', { className: 'dshw-detail', key: 'rc' },
              h('div', null, '语料 ' + String((rc.corpus || {}).total || '—') + ' 篇'),
              h('div', null, '本次命中 ' + ((rc.hits || []).length) + ' 篇 · 复习队列超期 ' + (rc.queue === null || rc.queue === undefined ? '—（无队列数据）' : String(rc.queue.stale_total ?? '—')) + ' 篇'),
              h('div', null, '目标 ' + String(rstats ? rstats.target : '—') + ' · ' + (rstats && rstats.meets_target ? '达成' : '未达成')))]))

        }

        // ── 判断质量台账（T31 建议 5 · 能力③「迭代」）：**「验收指标」卡内的小节**（2026-09-16 新增）──
        //  ★ 位置纪律：**不新开卡片** —— 小节挂在「验收指标」卡体内（行来自 `fbRows`，与 `/crosscheck`
        //    的 `xcRows` 一样**任何态都显示**：两者都是与 metrics 解耦的独立只读出口）。
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
        const fbRows = (() => {
          const v = fbView(fbDoc, fbDocErr, fbDocBusy)
          const body = [h('div', { key: 'fbt' }, '判断质量台账（只读 · 取自 /feedback）')]
            .concat(v.lines.map((t, i) => h('div', { key: 'fbl' + i, style: { opacity: 0.85 } }, t)))
          return [h('div', {
            className: 'dshw-detail', key: 'fb', 'data-pwb': 'feedback-ledger',
            style: { marginTop: '6px' },
          }, body)]
        })()

        // ── 验收指标 S1–S15：三态恒注册（2026-09-16 修正）────────────────────────
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
        //  ── 多源校验四个数（`/crosscheck` 只读出口）：与 metrics **解耦**，任何态下都显示 ──
        //  ★ 2026-09-16：本行尾部 `.concat(fbRows)` 把「判断质量台账」小节（同样是与 metrics 解耦的
        //    独立只读出口）并进**同一处**恒显示的行组 —— 于是 metrics 卡的注册行形状不变
        //    （仍是 `mmState.body.concat(xcRows)`），「任何态都显示」这条纪律对小节也自动成立。
        //  ★ 全部**原样取自 payload**，且一律标 `calibrated:false`（只展示不考核）——
        //    这些口径还没有真实样本支撑，做成红绿灯会让人为指标工作。
        //  ★ 三态：读失败（crossDocErr）/ 未取到（crossDoc=null）/ 口径为 0（数值型 0 照实显示）。
        const xc = crossDoc !== null && typeof crossDoc === 'object' ? crossDoc : null
        const xcRows = (() => {
          if (xc === null) {
            return [h('div', { className: 'dshw-detail', key: 'xcwait' },
              crossDocErr !== null ? '多源校验读取失败: ' + crossDocErr
                : (crossDocBusy === true ? '正在读取多源校验…' : '多源校验: 等待产物（跑 run-objects-pipeline.mjs）'))]
          }
          const tr = xc.trace || {}
          const bs = (tr.bySide || {})
          const msR = (xc.multiSource || {})
          const pv = (xc.promiseVsDelivery || {})
          const pct = (v) => (typeof v === 'number' ? Math.round(v * 100) + '%' : '—')
          return [h('div', { className: 'dshw-detail', key: 'xc' },
            h('div', null, '溯源（严格/宽松）: ' + pct(tr.strictRate) + ' / ' + pct(tr.looseRate)
              + '（事务 ' + pct((bs.matter || {}).strictRate) + ' · 触发 ' + pct((bs.trigger || {}).strictRate) + ' 严格）'),
            h('div', null, '多源支撑率: ' + pct(msR.supportRate)
              + '（双层 ' + String(msR.both ?? '—') + ' / 对象 ' + String(msR.objects ?? '—') + '）'),
            h('div', null, '承诺↔交付: ' + String(pv.executed ?? '—') + ' / ' + String(pv.total ?? '—') + ' 落地'),
            h('div', { style: { color: ((xc.contradictions || []).length > 0 ? '#e0a030' : undefined) } },
              '矛盾: ' + String((xc.contradictions || []).length) + ' 条'
              + ((xc.contradictions || []).length > 0 ? '（待你定夺 · 只列不改）' : '')),
            h('div', { style: { opacity: 0.7 } },
              '口径未经校准（calibrated: false）· 数据时刻 '
              + String(xc.generatedAt || '—').slice(0, 19).replace('T', ' ')))].concat(
            (() => {
              const cs = (xc.contradictions || [])
              if (cs.length === 0) return []
              return [h('div', { key: 'xcc', style: { marginTop: '6px' } }, '矛盾清单（每条都需人工定夺，系统不自动处置）')]
                .concat(cs.slice(0, MAX_ROWS).map((c, i) => h('div', { key: 'xcc' + i, style: { marginTop: '4px' } },
                  h('div', null, '[' + String(c.rule || '') + '] ' + String(c.subject || '')),
                  h('div', { style: { opacity: 0.7 } }, String(c.detail || '')))))
            })())
        })().concat(fbRows)
        const mmState = (() => {
          // 态① 读失败：`/state` 没读回来 —— 事实是"读不到"，绝不等同于"没有指标"
          if (pwbErr !== null) {
            return {
              badge: '读取失败',
              body: [
                h('div', { className: 'dshw-err', key: 'mmerr' }, '指标读取失败: ' + String(pwbErr)),
                h('div', { className: 'dshw-detail', key: 'mmerrhint', style: { opacity: 0.7 } },
                  '指标数字未取到（不代表为 0，也不代表未生成）—— 点「重试」重取；'
                  + '下方多源校验来自另一条只读出口，与 metrics 无关。'),
              ],
              extra: h('button', {
                className: 'dshw-btn', disabled: pwbBusy === true,
                // 只读重取（GET `/state?force=1` + GET `/crosscheck`）：不是写控件
                onClick: () => { loadPwb(true); loadCrossDoc() },
              }, pwbBusy === true ? '…' : '重试'),
            }
          }
          // 尚未取到（首屏/轮询中）：既不是"失败"也不是"未生成"
          if (pwb === null) {
            return {
              badge: pwbBusy === true ? '读取中' : '未读取',
              body: [empty(pwbBusy === true ? '正在读取指标层…' : '等待指标层…', 'mmwait')],
              extra: null,
            }
          }
          if (pwb.ok !== true) {
            return {
              badge: '数据层不可用',
              body: [h('div', { className: 'dshw-err', key: 'mmfail' }, '数据层不可用: ' + String(pwb.error || ''))],
              extra: null,
            }
          }
          const mm = pwb.metrics
          // 态② 无数据：指标未生成（`s-metrics.json` 不存在/不可解析 ⇒ host 下发 null）
          if (mm === null || mm === undefined) {
            return {
              badge: '指标未生成',
              body: [empty('指标未生成（跑 run-t18.mjs 或重建）', 'mmnone')],
              extra: null,
            }
          }
          // 态③ 有产物：值**原样**展示（0 照实写 0）。产物在但缺 summary ⇒ 如实说"缺字段"，
          //   同样不许静默消失（这是"无数据"之外的第三种事实，文案与态②不同）。
          const sum = (mm.summary !== null && typeof mm.summary === 'object') ? mm.summary : null
          const rowsBy = { '达成': [], '部分达成': [], '未达成': [], '无法验证': [] }
          if (Array.isArray(mm.metrics)) {
            for (const it of mm.metrics) {
              const k = Object.prototype.hasOwnProperty.call(rowsBy, it.verdict) ? it.verdict : '无法验证'
              rowsBy[k].push(it.id)
            }
          }
          // 这一档一条都没有 ⇒ 「—」（没列出任何 id）；**不等于** 口径为 0（0 会照实写 0）
          const mmList = (a) => (a.length === 0 ? '—' : a.join(' '))
          return {
            badge: sum === null
              ? '缺 summary 字段'
              : ('达成 ' + mmRaw(sum.achieved) + ' · 未达成 ' + mmRaw(sum.failed)),
            body: [h('div', { className: 'dshw-detail', key: 's' },
              sum === null
                ? h('div', { style: { color: '#e0a030' } }, '指标产物缺 summary 字段（s-metrics.json 未给出 达成/未达成 汇总）')
                : null,
              h('div', null, '达成: ' + mmList(rowsBy['达成'])),
              h('div', null, '部分: ' + mmList(rowsBy['部分达成'])),
              h('div', { style: { color: (rowsBy['未达成'].length > 0 ? '#e07070' : undefined) } },
                '未达成: ' + mmList(rowsBy['未达成'])),
              h('div', { style: { color: '#e0a030' } }, '无法验证: ' + mmList(rowsBy['无法验证'])),
              h('div', null, 'R8 时限: ' + mmRaw((mm.r8 || {}).verdict)),
              h('div', null, 'S1 机器侧定位: 最大 ' + mmRaw((mm.s1Timing || {}).maxMs) + ' ms'))],
            extra: null,
          }
        })()
        // 卡片**恒注册**（三态都在）：体 = 态别正文 + 与 metrics 解耦的多源校验四个数
        cardsByKey.set('metrics', card('验收指标 S1–S15', mmState.badge, mmState.body.concat(xcRows), mmState.extra))

        // ── 在场对象（2026-09-16 新卡）────────────────────────────────────────
        //  数据源 = host 只读透传的库内产物 `_meta/out/objects.json`（`api('/objects')`）。
        //  ★ 本卡**不做判定**（用户纪律）：key / state / next_step / counts / trajectory / evidence
        //    一律原样取自 payload —— 不按标题或任务名推对象、不自己算优先级、不把阈值变成红绿。
        //  ★ 颗粒度（用户裁定）：**默认客户级**（rollup 的键）→ 场次作为客户下的子行，点箭头展开（默认收起）。
        //  ★ 三态分开说：读失败（objsErr / 响应里没有产物）/ 无数据（objects = 0）/ 口径为 0（有对象但 0 在场）。
        const objDoc = objs
        const objHasDoc = objDoc !== null && Array.isArray(objDoc.objects)
        const objAll = objHasDoc === true ? objDoc.objects : []
        const objRollup = objDoc !== null && objDoc.rollup !== null && typeof objDoc.rollup === 'object' ? objDoc.rollup : {}
        const objByRecord = objDoc !== null && objDoc.byRecord !== null && typeof objDoc.byRecord === 'object' ? objDoc.byRecord : {}
        const objGenAt = objDoc !== null ? String(objDoc.generatedAt || '—') : '—'
        const objRollupKeys = Object.keys(objRollup)
        // 「原样显示」的兜底只有一条：payload 给的是 null/undefined/空串时写「无期限」（正是它的语义）
        const objRaw = (v) => (v === null || v === undefined || v === '' ? '无期限' : String(v))
        // 模态框里的「标签 + 值」行（复用 .dshw-mrow/.dshw-mrow-l/.dshw-mrow-v，与其它详情卡同一套）
        const objMrow = (label, value) => h('div', { className: 'dshw-mrow', key: 'r-' + label },
          h('span', { className: 'dshw-mrow-l' }, label),
          h('span', { className: 'dshw-mrow-v' }, String(value)))
        const objByKey = {}
        for (let i = 0; i < objAll.length; i += 1) {
          const o = objAll[i]
          if (o !== null && o !== undefined && typeof o.key === 'string') objByKey[o.key] = o
        }
        /** 某客户下的场次子对象（按 payload 顺序，**不重排**） */
        const objKidsOf = (k) => objAll.filter((o) => o !== null && o !== undefined && o.kind === 'session' && String(o.parent || '') === k)
        // 「在场」口径 = **用户裁定**（state ≠ settled 且 事务+触发 ≥ 2），不是本卡的阈值推断
        const objInPlay = objAll.filter((o) => o !== null && o !== undefined && o.state !== 'settled'
          && (((o.counts || {}).matters || 0) + ((o.counts || {}).triggers || 0)) >= 2)
        /**
         * 客户级行显示哪一条「下一步」（用户裁定）：在该**客户对象 + 它的场次子对象**里挑带 next_step 的，
         * due_at 最早优先、其次按 id —— 全是 payload 的值，本卡只做选择、不改写、不补期限。
         */
        const objNextItemOf = (k) => {
          const cands = [objByKey[k]].concat(objKidsOf(k)).filter((o) => o !== null && o !== undefined)
          let best = null
          for (let i = 0; i < cands.length; i += 1) {
            const ns = cands[i].next_step
            if (ns === null || ns === undefined) continue
            if (best === null) { best = cands[i]; continue }
            const bDue = best.next_step.due_at === null || best.next_step.due_at === undefined ? '' : String(best.next_step.due_at)
            const nDue = ns.due_at === null || ns.due_at === undefined ? '' : String(ns.due_at)
            if (bDue === '' && nDue !== '') { best = cands[i]; continue }  // 无期限排在有期限之后
            if (bDue === '' || nDue === '') continue
            if (nDue < bDue) { best = cands[i]; continue }
            if (nDue === bDue && String(ns.id) < String(best.next_step.id)) best = cands[i]
          }
          return best
        }
        // trajectory 直接照 payload 的取值换措辞（trigger-only / matter-only）；其它取值不贴标签
        const objTrajTag = (t) => (t === 'trigger-only' ? ' · 仅触发' : (t === 'matter-only' ? ' · 仅事务' : ''))
        const objCountsText = (c) => '事务 ' + String((c || {}).matters ?? '—') + ' · 触发 ' + String((c || {}).triggers ?? '—')
        function toggleObjOpen(k) {
          setObjOpen((prev) => {
            const nxt = Object.assign({}, prev)
            if (nxt[k] === 1) delete nxt[k]
            else nxt[k] = 1
            return nxt
          })
        }
        const openObj = (k, item) => setObjModal({ key: String(k), item: item || null })
        /** 一行对象（点击 → 只读二级详情）；child=true 时缩进为子行（复用 .dshw-item[data-child]） */
        const objItemRow = (o, child) => h('div', {
          className: 'dshw-item',
          key: (child ? 'ok-' : 'oo-') + String(o.key),
          'data-click': '1',
          'data-child': child ? '1' : null,
          title: String(o.evidence === null || o.evidence === undefined ? '' : o.evidence) + '\n点击查看二级详情（只读）',
          onClick: () => openObj(o.key, o),
        },
        h('span', { className: 'dshw-item-time' }, String(o.state || '—')),
        h('span', { className: 'dshw-item-text' },
          String(o.key) + ' · ' + objCountsText(o.counts) + objTrajTag(String((o.multi_source || {}).trajectory || ''))))
        const objRows = []
        if (objsErr !== null) {
          objRows.push(h('div', { className: 'dshw-err', key: 'objerr' }, '对象层读取失败: ' + objsErr))
        } else if (objDoc === null) {
          objRows.push(empty(objsBusy === true ? '正在读取对象层…' : '等待对象层…', 'objwait'))
        } else if (objHasDoc !== true) {
          // host 的 /objects 在产物缺失时返回 503 + { error }：这是**读失败**，不是「没有对象」
          objRows.push(h('div', { className: 'dshw-err', key: 'objshape' },
            '对象层不可用: ' + String(objDoc.error || '响应里没有 objects 字段') + '（属于读失败，不等于 0 个对象）'))
        } else if (objAll.length === 0) {
          objRows.push(empty('无数据：对象层产物里 objects = 0 个（管线尚未产出对象）', 'objnone'))
        } else {
          const cov = objDoc.coverage || {}
          const bk = cov.byKind || {}
          objRows.push(h('div', {
            className: 'dshw-detail', key: 'objmeta',
            title: '口径来源: objects.json（host 只读透传，本卡不加工）'
              + '\n派路口径 derivation: 路径 ' + String((cov.derivation || {}).path ?? '—')
              + ' · domain ' + String((cov.derivation || {}).domain ?? '—')
              + ' · counterparty ' + String((cov.derivation || {}).counterparty ?? '—')
              + ' · none ' + String((cov.derivation || {}).none ?? '—')
              + '\n未归属记录（payload unassigned）: ' + (Array.isArray(objDoc.unassigned) ? objDoc.unassigned.join(' ') || '—' : '—')
              + '\n' + String(cov.note || ''),
          },
          h('div', null, '数据时刻: ' + localStamp(objGenAt) + ' · 对象 ' + objAll.length + ' 个 · 在场 ' + objInPlay.length + ' 个'),
          h('div', null, '覆盖: 记录 ' + String(cov.records ?? '—') + ' · 已锚定 ' + String(cov.anchored ?? '—') + ' · 未归属 ' + String(cov.unassigned ?? '—')),
          // 卡头徽标 = 在场数；客户级/场次/域/未归属的分布在这里给出（每个数字都能在 objects/byKind 里对上号）
          h('div', null, '客户级 rollup ' + objRollupKeys.length + ' 个 · 场次 ' + String(bk.session ?? '—')
            + ' · 客户 ' + String(bk.client ?? '—') + ' · 域 ' + String(bk.domain ?? '—') + ' · 未归属 ' + String(bk.unassigned ?? '—'))))
          if (objInPlay.length === 0) {
            // 第三种空态：产物有对象，但按口径**在场为 0** —— 既不是读失败，也不是没有数据
            objRows.push(h('div', { className: 'dshw-detail', key: 'objzero', style: { color: '#e0a030' } },
              '口径为 0：产物里有 ' + objAll.length + ' 个对象，但按口径（state ≠ settled 且 事务+触发 ≥ 2）在场的为 0 个'
              + ' —— 这是口径的结果，不是读失败；下面仍按客户级 rollup 照列'))
          }
          // 顶层行 = 客户级（rollup 的键）；场次只在展开时出现
          const objShownKeys = objShowAll === true ? objRollupKeys : objRollupKeys.slice(0, MAX_ROWS)
          if (objRollupKeys.length === 0) {
            objRows.push(empty('客户级 rollup 为空（payload rollup 段 0 个键）', 'objnorollup'))
          }
          for (let i = 0; i < objShownKeys.length; i += 1) {
            const k = objShownKeys[i]
            const ru = objRollup[k] || {}
            const kids = objKidsOf(k)
            const open = objOpen[k] === 1
            const nxItem = objNextItemOf(k)
            objRows.push(h('div', { key: 'oc-' + k },
              h('div', {
                className: 'dshw-item', 'data-click': '1',
                title: '客户级（rollup）· 子对象 ' + kids.length + ' 个（场次折叠在下一层）\n点击查看二级详情（只读）',
                onClick: () => openObj(k, objByKey[k] || null),
              },
              h('span', { className: 'dshw-item-time' }, String(ru.state || '—')),
              h('span', { className: 'dshw-item-text' },
                String(ru.key || k) + ' · 事务 ' + String(ru.matters ?? '—') + ' · 触发 ' + String(ru.triggers ?? '—')
                + objTrajTag(String(ru.trajectory || ''))),
              kids.length > 0
                ? h('button', {
                  className: 'dshw-mt-btn',
                  title: '展开/收起该客户下的场次子行（' + kids.length + ' 个）',
                  onClick: (e) => { e.stopPropagation(); toggleObjOpen(k) },
                }, open ? '▾' : '▸')
                : null),
              // 下一步 = 该客户对象/其场次里 due_at 最早的那条（payload 原样：id · due_at · owner）
              nxItem === null
                ? h('div', { className: 'dshw-objnext', key: 'nx' },
                  '下一步: payload 未给出（该客户对象与其场次都没有 next_step）')
                : h('div', {
                  className: 'dshw-objnext', key: 'nx',
                  title: '下一步来自对象 ' + String(nxItem.key || '') + '（payload next_step 原样显示）· 点击查看二级详情',
                  onClick: () => openObj(k, objByKey[k] || null),
                }, '下一步 ' + String(nxItem.next_step.id) + ' · ' + objRaw(nxItem.next_step.due_at) + ' · ' + String(nxItem.next_step.owner || '—'))))
            if (open === true) {
              for (let j = 0; j < kids.length; j += 1) objRows.push(objItemRow(kids[j], true))
            }
          }
          if (objRollupKeys.length > MAX_ROWS && objShowAll !== true) {
            objRows.push(row('+' + String(objRollupKeys.length - MAX_ROWS),
              '更多客户级对象（共 ' + objRollupKeys.length + ' 个，点击展开）', 'objmore',
              () => setObjShowAll(true), '点击展开其余客户级对象（顺序与 payload 一致）'))
          }
          // 不在客户级 rollup 内的对象（域级 / 未归属 / 父对象缺失的场次）也必须能被看到并点开 ——
          // 否则「对象 15 个」这个数字里有一批在本卡无处可查（它们不在客户级颗粒度内）。
          const objOrphans = objAll.filter((o) => {
            if (o === null || o === undefined) return false
            const kk = String(o.key || '')
            if (objRollupKeys.indexOf(kk) >= 0) return false
            if (o.kind === 'session' && objRollupKeys.indexOf(String(o.parent || '')) >= 0) return false
            return true
          })
          if (objOrphans.length > 0) {
            const oOpen = objOpen['#nonrollup'] === 1
            objRows.push(h('div', {
              className: 'dshw-dgroup', key: 'objorphhead', 'data-click': '1', 'data-open': oOpen ? '1' : '0',
              title: '点击' + (oOpen ? '收起' : '展开') + '这 ' + objOrphans.length + ' 个对象（域级 / 未归属 / 父对象不在 rollup 内的场次）',
              onClick: () => toggleObjOpen('#nonrollup'),
            },
            h('span', { className: 'dshw-dgroup-arrow' }, oOpen ? '▾' : '▸'),
            h('span', { className: 'dshw-dgroup-name' }, '域级 / 未归属（不在客户级 rollup 内）'),
            h('span', { className: 'dshw-spacer' }),
            h('span', { className: 'dshw-dgroup-count' }, String(objOrphans.length))))
            if (oOpen === true) {
              for (let j = 0; j < objOrphans.length; j += 1) objRows.push(objItemRow(objOrphans[j], true))
            }
          }
        }
        let objBadge = '在场 ' + objInPlay.length
        if (objsErr !== null) objBadge = '读取失败'
        else if (objDoc === null) objBadge = objsBusy === true ? '读取中' : '未读取'
        else if (objHasDoc !== true) objBadge = '读取失败'
        else if (objAll.length === 0) objBadge = '无数据'
        cardsByKey.set('objects', card('在场对象', objBadge, objRows))
        // 读失败还要在**置顶告警块**里说一次（与数据层失败同一处，不吃卡体滚动）
        if (objsErr !== null) {
          alertBlocks.push(h('div', { className: 'dshw-err', key: 'objserr' }, '在场对象读取失败: ' + objsErr))
        }

        // ── 今日决策面（T31 能力① · 2026-09-16 新卡）─────────────────────────
        //  数据源 = host 只读透传的库内产物 `brief.json`（`api('/brief')`）。
        //  ★ 本卡**不做判断**：三段内容 / `why` / 排序 / `composition_note` / `overlap_note`
        //    一律原样取自 payload —— 卡片只排版与折叠，不重排、不筛选、不算优先级。
        //  ★ 四态分开说：① 读失败 ② 出口不可用（503 + error，含下一步命令）③ 未读取 ④ 有数据
        //    （**0 条也是有数据**；把"没有产物"显示成"今天没事"是本卡最需要避免的假绿）。
        const brDoc = brief
        const brErr = briefErr !== null ? String(briefErr)
          : (brDoc !== null && brDoc.error !== undefined ? String(brDoc.error) : null)
        const brOk = brErr === null && brDoc !== null && brDoc.error === undefined && brDoc.todayMustDo !== undefined
        const brBadge = brErr !== null ? '读取失败'
          : (brDoc === null ? (briefBusy === true ? '读取中' : '未读取')
            : (brOk ? ('今日必办 ' + String((brDoc.todayMustDo || {}).total ?? '—')) : '出口不可用'))
        const brLine = (label, value, dim) => h('div', {
          className: 'dshw-detail', key: 'br-' + label,
          style: dim === true ? { opacity: 0.7 } : null,
        }, h('div', null, String(label)), h('div', { style: { opacity: 0.85 } }, String(value)))
        const brRows = (() => {
          if (brErr !== null) return [empty('今日决策面读取失败: ' + brErr + '（可重试）', 'brerr')]
          if (brDoc === null) return [empty(briefBusy === true ? '正在读取今日决策面…' : '今日决策面: 等待读取', 'brwait')]
          if (!brOk) return [empty('今日决策面出口不可用: ' + String(brDoc.error || ''), 'br403')]
          const tm = brDoc.todayMustDo || {}
          const w = brDoc.waiting || {}
          const ov = brDoc.overnight || {}
          const out = []
          out.push(brLine('数据时刻', String(brDoc.generatedAt || '—').slice(0, 19).replace('T', ' ')))
          if (Array.isArray(brDoc.degraded) && brDoc.degraded.length > 0) {
            out.push(brLine('降级（缺产物）', brDoc.degraded.join(' · ')))
          }
          out.push(brLine('① 昨夜动向', (ov.items || []).length + ' 条 · 窗口 ' + String(ov.window_hours ?? '—') + 'h'
            + (ov.fallback === true ? '（回退：' + String(ov.fallback_reason || '') + '）' : '')))
          ;(ov.items || []).slice(0, 4).forEach((it, i) => out.push(h('div', {
            key: 'ov' + i, className: 'dshw-detail', style: { opacity: 0.85 },
          }, '[' + String(it.channel || it.source || '?') + '] ' + String(it.what || '').slice(0, 56)
            + ' · ' + String(it.object_key || '—'))))
          out.push(brLine('② 今日必办', '共 ' + String(tm.total ?? '—') + '（逾期 ' + String(tm.overdue ?? '—')
            + ' · 今日到期 ' + String(tm.due_today ?? '—') + ' · 当日交付 ' + String(tm.delivery_today ?? '—') + '）'))
          if (tm.composition_note) out.push(h('div', { className: 'dshw-detail', key: 'tmnote', style: { opacity: 0.7 } }, String(tm.composition_note)))
          ;(tm.top || []).slice(0, 8).forEach((it, i) => out.push(h('div', { key: 'tm' + i, className: 'dshw-detail' },
            String(it.title || '').slice(0, 48) + ' · ' + String(it.due_day || it.due_at || '无期限').slice(0, 10)
            + ' · ' + String(it.why || ''))))
          if (Number(tm.rest_count) > 0) {
            out.push(h('div', { className: 'dshw-detail', key: 'tmrest', style: { opacity: 0.7 } },
              '另有 ' + String(tm.rest_count) + ' 条同类（完整清单在 brief.json · 不设阈值过滤）'))
          }
          out.push(brLine('③ 待定 / 等对方', '共 ' + String(w.total ?? '—') + '（待我回应 '
            + String((w.by_group || {}).onMeReply ?? '—') + ' · 待回执 ' + String((w.by_group || {}).onMeReceipt ?? '—')
            + ' · 待回访 ' + String((w.by_group || {}).onMeReturnVisit ?? '—') + '）'))
          if (w.overlap_note) out.push(h('div', { className: 'dshw-detail', key: 'wov', style: { opacity: 0.7 } }, String(w.overlap_note)))
          ;(w.items || []).slice(0, 4).forEach((it, i) => out.push(h('div', {
            key: 'wt' + i, className: 'dshw-detail', style: { opacity: 0.85 },
          }, String(it.title || '').slice(0, 46) + ' · ' + String(it.due_at || '无期限').slice(0, 10)
            + ' · ' + String(it.expected_action || ''))))
          if (Array.isArray(brDoc.rules) && brDoc.rules.length > 0) {
            out.push(brLine('排序规则（可读）', brDoc.rules.map((r, i) => (i + 1) + '. ' + String(r)).join('　')))
          }
          return out
        })()
        cardsByKey.set('brief', card('今日决策面', brBadge, brRows,
          h('button', { className: 'dshw-btn', disabled: briefBusy === true, onClick: () => loadBrief() }, briefBusy === true ? '…' : '刷新')))

        // ── 跨源洞察（T31 能力⑤ · 2026-09-16 新卡）──────────────────────────
        //  硬规则（产物已保证）：**无证据不入面板**；单源且高影响标「待核验」；矛盾未决**只列不改**。
        //  ★ 本卡不做判断：`conclusion`/`support`/`confidence`/`needs_review`/`link_basis` 全部原样取自 payload。
        const isDoc = insights
        const isErr = insightsErr !== null ? String(insightsErr)
          : (isDoc !== null && isDoc.error !== undefined ? String(isDoc.error) : null)
        const isOk = isErr === null && isDoc !== null && isDoc.error === undefined && Array.isArray(isDoc.insights)
        const isBadge = isErr !== null ? '读取失败'
          : (isDoc === null ? (insightsBusy === true ? '读取中' : '未读取')
            : (isOk ? (isDoc.insights.length + ' 条') : '出口不可用'))
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
          if (isDoc.insights.length === 0) {
            out.push(h('div', { className: 'dshw-detail', key: 'iszero' },
              '当前 0 条（口径 = 有证据链且通过硬规则；**不等于"没有问题"**）'))
          }
          isDoc.insights.forEach((it, i) => {
            out.push(h('div', { className: 'dshw-detail', key: 'is' + i, style: { marginTop: '6px' } },
              h('div', null, '[' + String(it.kind_label || it.kind || '') + '] ' + String(it.subject || '')
                + (it.needs_review === true ? ' · ⚠️ 待核验' : '')),
              h('div', { style: { opacity: 0.85 } }, String(it.conclusion || '').slice(0, 140)),
              h('div', { style: { opacity: 0.7 } }, '支撑 ' + String(it.support || '—') + ' · 置信 ' + String(it.confidence ?? '—')
                + ' · 证据 ' + String((it.evidence || []).length) + ' 项 · ' + String(it.link_basis || '').slice(0, 56)
                + (it.review_reason ? (' · ' + String(it.review_reason).slice(0, 56)) : '')),
              h('div', { style: { opacity: 0.6 } }, '可反驳入口: ' + String((it.rebuttal || {}).entry || '')
                + '（驳回理由必填 · 阈值 ' + String((it.rebuttal || {}).threshold ?? '—') + '）')))
          })
          return out
        })()
        cardsByKey.set('insights', card('跨源洞察', isBadge, isRows,
          h('button', { className: 'dshw-btn', disabled: insightsBusy === true, onClick: () => loadInsights() }, insightsBusy === true ? '…' : '刷新')))

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
          const srcPill = (src) => h('span', { className: 'dshw-src', 'data-src': String(src || 'dingtalk') },
            SRC_LABEL[src] || '钉钉')
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
          const dayRoleText = (e) => {
            // 角色优先（住宿有明确的边界语义）；没有角色时再看时间是否可靠
            if (e.dayRole === 'checkin') return '入住 12:00 后'
            if (e.dayRole === 'stay') return '住宿中'
            if (e.dayRole === 'checkout') return '退房 14:00 前'
            // ★ 时间不完整（例如车次只知道日期）时如实说"待确认"，**不要**把日期渲染成 08:00 这种假时间
            if (e.needs_review === true) return '时间待确认'
            return hhmm(e.start) || '全天'
          }
          const calRows = allEvents.slice(0, CAL_ROWS).map((x, i) => h('div', {
            className: 'dshw-item',
            key: 'c' + i,
            'data-click': '1',
            'data-dayrole': x.e.dayRole || 'point',
            title: `${SRC_LABEL[x.e.source] || '钉钉'}日程 · 点击查看详情`
              + (x.e.source === 'feishu' ? '（在侧边栏打开飞书事件页）' : x.e.source === 'trip' ? '（行程详情）' : '与参会人'),
            onClick: () => openCalEvent(x.e),
          },
          h('span', { className: 'dshw-item-time' }, x.day + ' ' + dayRoleText(x.e)),
          srcPill(x.e && x.e.source),
          h('span', { className: 'dshw-item-text' },
            x.e.title + (x.e.location ? ' · ' + x.e.location : '')
            + (x.e.source === 'dingtalk' && x.e.org ? ' · ' + x.e.org : '')
            + (x.e.source === 'trip' && x.e.no ? ' · ' + x.e.no : ''))))
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
          // ⚠️ 2026-09-16：原按组织的徽标（`组织甲 4/15 · 组织乙 0/2 · …`）已按用户要求**移除**
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
              due: t.due ? fmtDay(t.due) : '无期限', done: t.done === true, sortKey: dueMsOf(t.due),
              detail: { source: 'dingtalk', title: String(t.title || ''), org: String(t.org || ''), done: t.done === true, due: t.due ? fmtDay(t.due) : '无期限', raw: t },
            })),
            ...feishuItems.map((t, i) => ({
              source: 'feishu', key: 'fs' + i, title: String(t.title || ''),
              due: t.due && dueMsOf(t.due) !== null ? fmtDay(dueMsOf(t.due)) : (t.due ? localStamp(t.due) : '无期限'),
              done: t.done === true, sortKey: dueMsOf(t.due),
              detail: { source: 'feishu', title: String(t.title || ''), due: t.due ? localStamp(t.due) : '无期限', owners: t.owners || [], followers: t.followers || [], creator: t.creator || '', created: t.created || '', listName: t.listName || '', description: t.description || '', url: t.url || '', done: t.done === true, raw: t },
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
          const todoRows = shownTodo.map((t) => h('div', {
            className: 'dshw-item', key: t.key, 'data-click': '1',
            title: '点击查看二级详情',
            onClick: () => setTodoDetail(Object.assign({ key: t.key }, t.detail)),
          },
          h('span', { className: 'dshw-item-time' }, String(t.due)),
          srcPill(t.source),
          h('span', { className: 'dshw-item-text' }, t.title)))
          const todoBody = todoNotes.slice()
          if (todoRows.length === 0) todoBody.push(empty('三源均无待办（钉钉 / 飞书 / 个人）', 'none'))
          else todoBody.push(h('div', { className: 'dshw-todolist', key: 'list' }, todoRows))
          const dingtalkTotal = (todoCounts || {}).dingtalk ?? todoItems.length
          const personalTotal = (todoCounts || {}).personal ?? localTodo.length
          const feishuBadge = feishuTodo === null
            ? '飞书 需重启 host'
            : (feishuTodo.ok === true ? '飞书 ' + feishuItems.length : (feishuTodo.authorized === false ? '飞书 未授权' : '飞书 读取失败'))
          // 卡名 = 「待办」（2026-09-16 用户要求：标题改为「待办」—— 不再写"三源"，源已在卡头计数里）
          // 卡头 = **只显示三源数量**（用户 2026-09-16：「待办右侧显示钉钉/飞书/个人的待办数量即可，
          //   多个组织的可以不用细分」）⇒ 去掉按组织的 `组织甲 4/15 · 组织乙 0/2 · …` 徽标。
          //   组织信息仍在**二级详情**的「来源」行里（点开才看，不占用卡头）。
          // 卡脚 = 无（2026-09-16 用户：「打开目录按钮没有实际意义，可以移除」）。
          // 卡体 = 默认（`.dshw-card-body` max-height:168px + overflow:auto）⇒ **全部行照列**、
          //   超出高度自然出滚动条；**不再有「显示 X / 共 Y 条」的截断提示**（用户要求移除）。
          cardsByKey.set('todos', card('待办',
            '钉钉 ' + String(dingtalkTotal) + ' · ' + feishuBadge + ' · 个人 ' + String(personalTotal),
            todoBody))

          const catKey = tab === 'all' ? null : tab
          const catFiles = catKey !== null ? (kn.byCategory || {})[catKey] || [] : kn.recent || []
          // 2026-09-15：分类 tab（全部/学习/研究/工作/生活）只影响知识库内容 → 移进知识库卡片
          cardsByKey.set('kb', card('知识库 · ' + (catKey === null ? '全部' : CAT_LABEL[catKey]),
            catKey === null ? '共 ' + kn.total + ' 篇' : (counts[catKey] || 0) + ' 篇',
            catFiles.slice(0, MAX_ROWS).map((f, i) => row(
              fmtAgo(f.mtime),
              f.name,
              tab + 'k' + i,
              () => openFile(f.path, f.name),
              '点击打开: ' + String(f.path || ''),
            )),
            h('div', { className: 'dshw-tabs dshw-tabs-inline' }, tabs)))

          const mins = (snap.minutes && snap.minutes.items) || []
          cardsByKey.set('minutes', card('近期听记', '钉钉妙记 · ' + mins.length,
            mins.length === 0
              ? [empty('暂无听记', 'none')]
              : mins.slice(0, MAX_ROWS).map((m, i) => row(fmtDay(m.start), m.title, 'm' + i, () => {
                if (!openInSidebarUrl(m.url, m.title)) {
                  try { window.open(m.url, '_blank', 'noopener') } catch (e) {}
                }
              }, '点击打开妙记: ' + String(m.url || '')))))

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
          //   才能整体自动流动（列数由 CSS 稳定取 3，见 .dshw-minigrid 的 clamp 说明）。
          cardsByKey.set('system', card('系统状态',
            null,
            [
              h('div', { className: 'dshw-minigrid', key: 'minis' },
                devMini('spk', '音响', spkState, LINK_LABEL[spkState], spkBlocked, spkHint, toggleSpeaker),
                devMini('cam', '摄像头', camState, LINK_LABEL[camState], camBlocked, camHint, toggleCamera),
                mini('dws', 'DWS', dwsState, dwsText, String((sys.dws || {}).detail || '')),
                mini('mcp', 'MCP', mcpState2, mcpText, mcpDetail),
                mini('tools', '本地工具', localState2, localText,
                  String((sys.tools || {}).detail || '') + (act.recent && act.recent.length > 0 ? ' ｜ 近次：' + act.recent.slice(0, 3).map((r) => r.name || r.label).join(' → ') : '')),
                mini('browser', '浏览器', browserState2, browserText, String((sys.browser || {}).detail || ''))),
              // ⚠️ 2026-09-15 用户要求：设备提示**不再出现在卡片底部**（移到头部「工作台」右侧的瞬时提示）
            ],
            null,
            true,
            micBar))
        }

        // ── 按**用户指定顺序**装配卡片（2026-09-15 用户要求）──────────────────────
        //    事务 → 待响应触发 → 在场对象 → 日程 → 待办 → 专注 → 活跃关注 → 流入处置 →
        //    唤起沉淀 → 验收标准 → 知识库 → 近期听记 → 系统状态
        //    · 错误/提示块（alertBlocks）置顶：它们是告警，不该被顺序表挤到看不见；
        //    · 未登记进顺序表的卡片（将来新增）**追加在末尾**而不是消失 —— 新增卡片时
        //      必须显式决定它排在哪，忘了就"排最后"而不是"不见了"。
        const CARD_ORDER = [
          // 用户 2026-09-16 重排：在场对象从第 3 位移到「唤起 · 沉淀复利」之后、「验收指标」之前
          // 2026-09-16 追加两张 T31 卡（三层声明同步：本表 / T16-58 的 WANT_ORDER / SBT-23 的 WANT）：
          //   · brief 置**最前**——它是"热层"（今天要做什么），其余卡是"分类视图"；
          //   · insights 紧随 objects——先看"这件事到哪了"，再看"跨源合起来说明什么"。
          'brief', 'matters', 'triggers', 'schedule', 'todos', 'focus', 'domains',
          'inflow', 'recall', 'objects', 'insights', 'metrics', 'kb', 'minutes', 'system',
        ]
        const unlistedKeys = [...cardsByKey.keys()].filter((k) => !CARD_ORDER.includes(k))
        const cards = [
          ...alertBlocks,
          ...CARD_ORDER.map((k) => cardsByKey.get(k)).filter(Boolean),
          ...unlistedKeys.map((k) => cardsByKey.get(k)),
        ]

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
                h('span', { className: 'dshw-h1' }, '工作台'),
                // 瞬时提示（设备回执）：「工作台」右侧的中段位置；无提示时占位保持布局稳定
                h('span', { className: 'dshw-toast-wrap', key: 'toastwrap' },
                  toast !== null
                    ? h('span', { className: 'dshw-toast', key: toast.key, 'data-tone': toast.tone, 'data-phase': toast.phase, title: toast.text }, toast.text)
                    : null),
                h('span', { className: 'dshw-sub' }, snap && snap.at ? '更新于 ' + fmtClock(snap.at) : '读取中…'),
              ),
              h('div', { className: 'dshw-grid', style: { '--dshw-card-min': cardMinPct + '%' } }, cards),
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

        // 详情卡显示在最上层：优先 portal 到 document.body（脱离 shell overlay 层的层叠上下文）；
        // 取不到 react-dom 时退化为就地渲染，并给根节点打 data-modal 抬升层级。
        const matterModalNode = matterModalEl === null
          ? null
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

        // ── 在场对象二级详情卡（2026-09-16 新卡）：**只读** ──────────────────────
        //  本卡不提供任何处置口子：没有关闭/编辑事务或触发的按钮（那是事务卡的能力），
        //  也不添加本文件别处不存在的跳转；sources 只作为**可选中复制**的文本行。
        //  五个区块全部是 payload 的原样值 + ids/路径明细，用来给卡片上的每个数字对账。
        const objModalEl = objModal === null ? null : (() => {
          const key = String(objModal.key)
          const it = objModal.item !== null && objModal.item !== undefined ? objModal.item : (objByKey[key] || null)
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
          // ② 事务：counts 与 matter_ids（卡片行上的「事务 n」在这里能逐条对上号）
          const mIds = it !== null && Array.isArray(it.matter_ids) ? it.matter_ids : []
          const mRows = [objMrow('counts', cs === null
            ? '—'
            : 'matters ' + String(cs.matters) + ' · open_matters ' + String(cs.open_matters) + ' · overdue ' + String(cs.overdue))]
          if (mIds.length === 0) mRows.push(h('div', { className: 'dshw-empty', key: 'nom' }, 'matter_ids 为空'))
          for (let i = 0; i < mIds.length; i += 1) {
            const rec = objByRecord[String(mIds[i])] || null
            mRows.push(h('div', { className: 'dshw-rec', key: 'm' + i, title: rec === null ? 'byRecord 无该 id' : String(rec.evidence || '') },
              h('div', { className: 'dshw-mrow-v', style: { userSelect: 'text' } },
                String(mIds[i]) + (rec !== null && String(rec.key) !== key ? ' → ' + String(rec.key) : ''))))
          }
          secs.push(h('div', { className: 'dshw-modal-sec', key: 's2' },
            h('div', { className: 'dshw-modal-sec-h' }, '② 事务（payload counts + matter_ids 明细）'),
            mRows))
          // ③ 触发
          const tIds = it !== null && Array.isArray(it.trigger_ids) ? it.trigger_ids : []
          const tRows = [objMrow('counts', cs === null
            ? '—'
            : 'triggers ' + String(cs.triggers) + ' · unresponded_triggers ' + String(cs.unresponded_triggers) + ' · overdue ' + String(cs.overdue))]
          if (tIds.length === 0) tRows.push(h('div', { className: 'dshw-empty', key: 'not' }, 'trigger_ids 为空'))
          for (let i = 0; i < tIds.length; i += 1) {
            const rec = objByRecord[String(tIds[i])] || null
            tRows.push(h('div', { className: 'dshw-rec', key: 't' + i, title: rec === null ? 'byRecord 无该 id' : String(rec.evidence || '') },
              h('div', { className: 'dshw-mrow-v', style: { userSelect: 'text' } },
                String(tIds[i]) + (rec !== null && String(rec.key) !== key ? ' → ' + String(rec.key) : ''))))
          }
          secs.push(h('div', { className: 'dshw-modal-sec', key: 's3' },
            h('div', { className: 'dshw-modal-sec-h' }, '③ 触发（payload counts + trigger_ids 明细）'),
            tRows))
          // ④ 出处（evidence 路径）：只做可选中复制，不做跳转
          const srcs = it !== null && Array.isArray(it.sources) ? it.sources : []
          const pRows = []
          if (srcs.length === 0) {
            pRows.push(h('div', { className: 'dshw-empty', key: 'nop' }, 'payload sources 为空（该对象没有登记出处）'))
          }
          for (let i = 0; i < srcs.length; i += 1) {
            pRows.push(h('div', { className: 'dshw-rec', key: 'p' + i, title: '可选中复制（本卡不提供跳转）' },
              h('div', { className: 'dshw-mrow-v', style: { userSelect: 'text' } }, String(srcs[i]))))
          }
          secs.push(h('div', { className: 'dshw-modal-sec', key: 's4' },
            h('div', { className: 'dshw-modal-sec-h' }, '④ 出处（payload sources ' + srcs.length + ' 条 · 可选中复制）'),
            pRows))
          // ⑤ 支撑强度 + 归属（支撑强度用来解释「为什么这个对象在场」）
          const s5 = [
            objMrow('轨迹', String(ms.trajectory || '—')),
            objMrow('证据行', ms.evidence_lines === undefined ? '—' : String(ms.evidence_lines)),
            objMrow('事务来源', Array.isArray(ms.matter_kinds) && ms.matter_kinds.length > 0 ? ms.matter_kinds.join('、') : '—'),
            objMrow('触发类别', Array.isArray(ms.trigger_rclasses) && ms.trigger_rclasses.length > 0 ? ms.trigger_rclasses.join('、') : '—'),
            objMrow('溯源', 'origin_inbound ' + String(tr.origin_inbound === undefined ? '—' : tr.origin_inbound)
              + ' · source_ref ' + String(tr.source_ref === undefined ? '—' : tr.source_ref)
              + ' · records ' + String(tr.records === undefined ? '—' : tr.records)),
            objMrow('generatedAt', objGenAt),
            objMrow('所在对象', 'kind ' + String((it !== null && it.kind) || '—')
              + ' · parent ' + String((it !== null && it.parent) || '（payload 无 parent）')
              + ' · account ' + String((it !== null && it.account) || '—')
              + ' · domain_id ' + String((it !== null && it.domain_id) || '—')),
          ]
          if (it !== null && it.kind === 'unassigned' && Array.isArray(objDoc.unassigned)) {
            s5.push(objMrow('未归属清单', objDoc.unassigned.length === 0 ? '—' : objDoc.unassigned.join(' ')))
          }
          secs.push(h('div', { className: 'dshw-modal-sec', key: 's5' },
            h('div', { className: 'dshw-modal-sec-h' }, '⑤ 支撑强度（multi_source / trace / 归属）'),
            s5))
          // ⑥ 客户级 rollup：只有从客户级行进来的详情才有这一段；数字照 payload 给，本卡**不重算**
          if (ru !== null) {
            const kids = objKidsOf(key)
            const rRows = [
              objMrow('rollup', '事务 ' + String(ru.matters) + ' · 触发 ' + String(ru.triggers)
                + ' · state ' + String(ru.state || '—') + ' · trajectory ' + String(ru.trajectory || '—')),
              objMrow('lines', 'matter ' + String((ru.lines || {}).matter) + ' · trigger ' + String((ru.lines || {}).trigger)),
            ]
            if (kids.length === 0) {
              rRows.push(h('div', { className: 'dshw-empty', key: 'rnokid' }, '该客户下的场次对象：0 个'))
            }
            for (let i = 0; i < kids.length; i += 1) {
              rRows.push(h('div', { className: 'dshw-rec', key: 'rk' + i, title: String(kids[i].evidence || '') },
                h('div', { className: 'dshw-mrow-v' }, String(kids[i].key) + ' · ' + objCountsText(kids[i].counts)
                  + ' · state ' + String(kids[i].state || '—'))))
            }
            if (Array.isArray(ru.children) && ru.children.length > 0) {
              rRows.push(objMrow('children', ru.children.join('、')))
            }
            secs.push(h('div', { className: 'dshw-modal-sec', key: 's6' },
              h('div', { className: 'dshw-modal-sec-h' }, '⑥ 客户级 rollup（payload rollup 段，本卡不重算）'),
              rRows))
          }
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
        const objModalNode = objModalEl === null
          ? null
          : (ReactDOM !== null && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined'
            ? ReactDOM.createPortal(objModalEl, document.body)
            : objModalEl)

        return h('div', {
          className: embedded ? 'dshw-root dshw-embedded' : 'dshw-root',
          ref: outer,
          'data-modal': (matterModal !== null && matterModalNode === matterModalEl)
            || (calModal !== null && calModalNode === calModalEl)
            || (todoDetail !== null && todoModalNode === todoModalEl)
            || (objModal !== null && objModalNode === objModalEl) ? '1' : null,
        }, panel, matterModalNode, calModalNode, todoModalNode, objModalNode)
      }

      // ── 侧边栏 tab 注册（2026-09-15 需求：工作台内容进 better-sidebar，PC/移动端统一 UI）──
      // 用户裁定：**侧边栏接管后，原来的 overlay 框体取消**。
      // 策略（既不丢功能、也不留框体）：
      //   · 找到 betterSidebar 服务 → 注册 tab + 自动打开一次 → **不挂 overlay**；
      //   · 3 秒宽限内没找到（未装 better-sidebar）→ 挂 overlay 兜底；
      //   · 兜底之后服务才出现（晚加载）→ 撤掉 overlay，改由 tab 接管。
      const SIDEBAR_TAB_ID = 'dsh-workbench:console'
      const SIDEBAR_DASH_ID = 'dsh-workbench:dashboard'
      let sidebarRegistered = false
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

      let sidebarAutoOpened = false
      function tryRegisterSidebarTab() {
        if (sidebarRegistered) return
        let svc
        try { svc = ctx.get('betterSidebar') } catch (e) { svc = undefined }
        if (svc === undefined || svc === null || typeof svc.registerTab !== 'function') return
        sidebarRegistered = true
        ctx.effect(() => {
          const offs = []
          try {
            offs.push(svc.registerTab({
              id: SIDEBAR_TAB_ID,
              title: '工作台',
              icon: iconWorkbench,     // 折叠态侧边栏只显示图标（2026-09-15 需求）
              order: 40,
              single: true,
              component: () => React.createElement(Workbench, { embedded: true }),
            }))
            // 库内仪表盘：与「工作台」平级的独立 tab（同一侧边栏、各自一个卡片）
            offs.push(svc.registerTab({
              id: SIDEBAR_DASH_ID,
              title: '驾驶舱',
              icon: iconDashboard,
              order: 41,
              single: true,
              component: () => React.createElement(DashboardView, null),
            }))
          } catch (e) {
            // 重复注册（如 HMR 重挂）不致命：静默并保持已注册标记
            try { console.warn('[dsh-workbench] sidebar tab 注册失败:', String((e && e.message) || e)) } catch (e2) {}
          }
          return () => { for (const off of offs) { try { off() } catch (e) { /* 已撤 */ } } }
        })
        unmountOverlay()   // 侧边栏接管 → 取消框体
        // 自动打开一次（single 去重：重复调用只激活已有实例，不堆叠）
        if (!sidebarAutoOpened) {
          sidebarAutoOpened = true
          let openTries = 0
          const openOnce = () => { try { svc.openTab({ type: SIDEBAR_TAB_ID }) } catch (e) { /* 会话未就绪则下次再试 */ } }
          const stopOpen = ctx.interval(() => { openOnce(); openTries += 1; if (openTries >= 3) stopOpen() }, 2000)
          openOnce()
        }
      }

      tryRegisterSidebarTab()
      let sidebarTries = 0
      const stopSidebarTry = ctx.interval(() => {
        sidebarTries += 1
        tryRegisterSidebarTab()
        // 3 秒宽限：仍未接管 → overlay 兜底（没有 better-sidebar 时功能不丢）
        if (!sidebarRegistered && sidebarTries >= 3) mountOverlayFallback()
        if (sidebarRegistered || sidebarTries >= 30) stopSidebarTry()
      }, 1000)
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-workbench'
    // 纯函数测试钩子：分组逻辑在 Node 里可直接验证（selftest-client.mjs，无需浏览器）。
    // 模块加载契约只用 apply/inject/name，附加字段不影响加载。
    exports.__test = { groupMattersByDomain }
    return module.exports
  },
})
