# dsh-coords（坐标系）

把一份内容（文件 / 粘贴 / 会话里的 agent 识别）落成 **2D 四象限散点**或 **3D 坐标系**，
作为 DSH 自带**右侧栏的一个 tab**（类型 `dsh-coords:center`）挂进 WebUI：入口是左侧栏底部的四行之一
（由 `dsh-workdesktop` 统一渲染），点一下把那一栏打开。全屏 / 双栏分屏 / 拖拽都由官方那条栏自带。
官方指南页上这张入口卡的图标是**彩色**的（紫色底板 `rgb(139,118,246)` + 白色坐标轴图形，
与官方那两张卡同一形状语法）；tab 标题条与左侧栏那几处仍是单色 `currentColor` 那枚。

参考实现：
「项目价值坐标」（2D 原型页面，未随本仓发布） ·
「场景坐标系」（3D 原型页面，未随本仓发布）
—— 三轴 0–5、点云、点击看点、选中画**坐标盒**（三条阶梯 + 三条闭合棱，全红虚线）这套
视觉语言直接沿用；3D 由自绘投影实现（不引 three.js，卡片里不带 1.3MB 依赖）。

## 卡片版式（用户 2026-09-25 裁定：上 5% / 中 75% / 下 20%）

| 带 | 高度 | 内容 |
|---|---|---|
| 上 | **5%** | 2D/3D 选择 · 已存坐标系选择 · 名字 · 维度设置（每根轴的名称与取值范围）· 导入（文件/粘贴）· 模板 · 新建/示例/删除/保存 |
| 中 | **75%** | 坐标系图：2D 四象限散点（点选、悬停看值）／3D 可旋转坐标系（拖拽旋转 · 滚轮缩放 · 右键/Shift 平移 · 点圆点看坐标 · 重置视角） |
| 下 | **20%** | 两栏：**左 30%** 点列表（搜索 + 分组筛选）· **右 70%** 选中点的信息（各轴数值 / 分组 / 象限 / 说明） |

三段比例是常量（`BAND_TOP/BAND_MID/BAND_BOT`）并且 CSS 与常量同值，自测 `C-02` 守这条。

**三条分隔条都能拖**（用户 2026-09-25 裁定：三段高度可拖、下带左右两列宽度可拖）：
上/中之间与中/下之间各一条横向分隔条（`cursor:row-resize`）、下带中间一条竖向分隔条（`cursor:col-resize`）；
**拖到哪儿就停在哪儿**（写 `localStorage`：`dshco.bands` / `dshco.splitL`，刷新与换会话都保持），
**双击任一条复位**到 5/75/20 与 30/70。拖动的夹紧：上带 ≥60px · 中带 ≥120px · 下带 ≥96px ·
左列 ≥140px · 右列 ≥160px。分隔条走**绝对定位覆盖**在交界线上（不占布局，三段百分比因此仍然精确），
自测 `C-31` 守"三条分隔条都在 + 光标语义 + 夹紧函数"。
⚠️ **根容器必须 `height:100%`**：三段比例是百分比，只有父容器高度确定时才成立。只写 `flex:1 1 auto`
而父容器（官方右栏的 pane）不是 flex 时，根高会变成**内容高**（真机实测 1775px）⇒ 三段全崩
（上带 60px、中带只剩 min-height 120px、下带被列表撑到 1595px）。`C-02` 也守这一条。

### ⚠️ 三段布局的硬约束（2026-09-25 修「打开之后页面混乱」时定的）

三条，缺一条就会重新乱：

1. **上带的 flex-basis 是 `max(5%, 60px)`，不是裸 5%**。上带是**两行**控件
   （第一行 模式/集合/名字/动作，第二行 三根轴的名称与范围，合计 24+3+22+10 = 59px）；
   面板 1042px 高时 5% 只有 52px ⇒ 第二行被裁 7px、上带内部冒出一条纵向滚动条 ——
   用户报的"页面混乱"就是这个。比例照旧（拖得动），但永不低于 60px。
   分隔条的 `top` 用**同一个表达式**，否则它会浮在真正接缝上方 8px。
2. **中带必须 `flex:1 1 auto`（吸收余量），不能写死 `0 0 75%`**。写死时上带被 min-height
   撑到 60px 的那 8px 没人让，三段之和 1050 > 容器 1042 ⇒ **下带被挤出容器底部 8px**
   （真机实测 `bot.bottom 1088 > root.bottom 1080`，root 是 `overflow:hidden`，于是下带最后
   8px 的内容被裁掉）。中带吸收余量后三段之和恒等于容器高度（实测 60+774+208 = 1042）。
3. **下带左列的头必须单行 + 横向滚动**（`.dshco-bothead{flex-wrap:nowrap;overflow-x:auto}`）。
   换行时三个 chip 会吃掉左列一半高度（实测 54/207），列表只剩 153px，看着就是"挤成一团"；
   单行后头 31px、列表 176px。
4. **存进 localStorage 的比例必须夹回合法区间，而且 mid 只能由 top/bot 推出来**
   （2026-09-25 用户第二次报"结构不对"后加的）。比例是可拖的、还会跨会话留在浏览器里，
   一旦存进来一个歪值（实测 `{top:70,mid:10,bot:20}`、`{top:5,mid:5,bot:90}`），
   结构就塌：中带（图）被压到 120px 的 min-height 地板、画布却在按旧尺寸画 ⇒ 盖住下带；
   或者三段之和超过容器 ⇒ 最后一段被裁。
   规则：`top ∈ [4, 22]`、`bot ∈ [10, 40]`、`mid = 100 - top - bot ∈ [38, 86]`；
   `readBands()` 夹回后**写回去自愈**（否则每次加载都拿坏值重算一遍）。
   拖分隔条的夹取也走同一套区间。守卫 `C-02c` + 真机 `verify-structure.mjs`
   （默认 / 拖坏 70-10-20 / 拖坏 5-5-90 / 极端 1-1-98 四种情形，都是"图 ≥38% · 三段合得上 ·
   不出容器 · 画布不越界"）。

守卫：源码级 `C-02` / `C-02b` / `C-02c` / `C-06b`（行内 flex、CSS 与比例区间的硬约束）
+ 真机 `verify-gui.mjs`（上带无内部纵向滚动、三段之和 == 卡片高度、下带不出容器）
+ `verify-structure.mjs`（歪比例不许压塌结构）+ `verify-layout.mjs`
（默认宽度与把右栏压到 420px 两种情况下都不裁切、画布文字 0 压字）。
下带两栏的 30/70 写在 CSS（`.dshco-col.left` / `.dshco-col.right`），`C-12` / `C-12b`
与真机 `verify-gui.mjs` 两处都守（未选中时右列给引导文案，不留白）。

## 内容怎么变成坐标系

两条路，各自动了什么都会如实说明：

1. **解析成坐标系**（确定性，不调模型）：md / txt / json / csv / tsv / **xlsx** 读成表格后
   - 数值列 → 轴（轴名取列名，范围取实际 min/max 并对齐到「好看」的边界）
   - 去重数 2–12 的文本列 → **分组**
   - 去重数最多的文本列 → **点名**
   - md/txt 这类自由文本**不假装解析成功**，会明确告诉你走第 2 条路
2. **交给会话识别**（复用 DSH 会话，卡片里**不做** AI 对话框）：内容先落进
   `$DSH_HOME/.dsh-coords/_sources/`，再把一段提示词放进当前会话的输入框
   （`ctx.get('conversation').input.for(...).setDraft`，**不自动发送**），由这个会话的
   agent 判定轴/范围/分组/点，最后调 `coords_save` 落盘。

轴名/范围/分组在画之前都能手改；**模板**支持预置（价值×难度 · 范围×成熟度×适用面 ·
影响×可行性）与用户自存（历史记录，存轴/分组/象限，不存点）。

## 安装与重启

```powershell
# 1) profile 依赖（link 到本目录）
#    编辑 $DSH_HOME/profiles/web/package.json：
#      dependencies."dsh-coords" = "link:<本仓库检出>/coords"
#      dsh.profile.bundles 追加 "dsh-coords"
# 2) node_modules 建 junction（与 dsh-modeling 同款）
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-coords" `
  -Target "<本仓库检出>\coords"
```

**改完本插件要重启 DSH**：profile 的 `patchReload: live` 只重载**组合**，不重载已被
Node 缓存的 ESM 模块；新加的路由在运行中的实例上会一直 404（`/coords/api/meta` 试一下
就知道）。浏览器半段（`lib/client.js`）随页面刷新加载，不需要额外动作。

重启前先跑隔离试运行（另起一个端口，不碰正在用的 3080）：

```powershell
node scripts/trial-boot.mjs            # 默认 3181
```

它会临时把本插件挂进 profile bundles、把 `dsh web --port 3181` 拉起来、逐个探路由
（含「方法不对回 405 而不是 404」），最后**无条件还原** profile。看到
「boot 干净、路由可用」再重启在用实例。

## 落盘

```
$DSH_HOME/.dsh-coords/                 DSH_COORDS_DIR 可覆盖
├─ <坐标系名字>.json                    一套坐标系一个文件（可直接手改、可进 git）
├─ _sources/                           导入的原始内容（识别用的那份）
└─ _templates/<模板 id>.json            用户自存模板
```

环境变量：`DSH_COORDS_MAX_POINTS`（点上限，默认 2000）· `DSH_COORDS_MAX_BYTES`
（导入体积上限，默认 8MB）。

## 路由（host 半段）

| 路由 | 方法 | 说明 |
|---|---|---|
| `/coords/api/meta` | GET | 模式 / 预置模板 / 上限 / 落盘目录 / AI 现状 |
| `/coords/api/sets` | GET | 已有坐标系列表（读不动的标 `broken`，不静默丢） |
| `/coords/api/set` | GET·POST·DELETE | 读 / 落盘（规范化后写）/ 删 |
| `/coords/api/parse` | POST | 内容 → 表格画像 + 初步坐标系（md/txt 回 `table:null`） |
| `/coords/api/intake` | POST | 原始内容落进 `_sources/`，返回路径 |
| `/coords/api/templates` `/template` | GET·POST·DELETE | 模板列表 / 存 / 删 |
| `/coords/api/events` | GET | 增量事件（`since`），卡片据此自刷新与自动弹出 |
| `/coords/api/open` | POST | 推一条 open 事件把卡片唤出来（与 `coords_open` 同一通道；脚本/排障用） |
| `/coords/api/sample` | GET | 示例数据（只在你点「示例」时装载） |

## DSH 工具（给会话里的 agent）

| 工具 | 用途 |
|---|---|
| `coords_open` | 把卡片打开并置前（可选切到某套坐标系） |
| `coords_save` | 落盘一套坐标系（同名覆盖），返回被夹取后的实况与体检结论 |
| `coords_list` / `coords_get` | 列出 / 读一套 |
| `coords_read` | 读本机文件（md/txt/json/csv/tsv/xlsx）→ 表格画像 + 初步轴匹配 |
| `coords_template` | 模板 list / save / delete |

## 源码布局与构建

`src/` 是唯一真相源，`lib/` 是**生成物**：

```
src/coords.mjs       共用代数（host 与 client 同一份）：归一化 · 表格解析 · 轴猜测 ·
                     2D/3D 投影 · 坐标盒几何 · 模板 · 体检 · 导出 · 识别提示词
src/index.js         host 半段：/coords/api/* 路由 · 落盘 · xlsx 读取 · 6 个 agent 工具 · 事件
src/host.template.js host 入口模板（自带 import，因为生成物是真 ESM）
src/client.dom.js    卡片 UI（React，纯 SVG 画布，无画布库）
src/client.js        浏览器入口模板（模块加载器工厂）
lib/index.js / lib/client.js   ← scripts/build.mjs 生成
```

```powershell
node scripts/build.mjs          # 重新生成 lib/
node scripts/build.mjs --check  # 只校验产物与 src/ 一致
node selftest.mjs               # host 半段 24 项
node selftest-client.mjs        # 浏览器半段 21 项（含渲染与几何断言）
```

`selftest.mjs` 会把 `lib/index.js` 当 ESM 载入、造一个假 cordis 上下文跑 `apply()`，
再直接调真实注册的路由与工具；xlsx 用例会**现场造一个最小 xlsx**（stored/deflate zip +
sharedStrings + sheet1），因此读表路径是真跑过的，不是 mock。
`selftest-client.mjs` 造一个最小 `__ModuleLoader__` 把 `lib/client.js` 执行一次，并用带
可用 hooks 的渲染沙盒把组件树渲染出来数元素（点云个数、坐标盒 6 条红线、阶梯每段严格
平行于坐标轴）。

## 真机验收（隔离实例，不碰正在用的 3080）

```powershell
node scripts/trial-boot.mjs --port 3181          # 另起一个实例（自己还原 profile）
# 拿到它打印的 http://127.0.0.1:3181/?token=… 后：
node scripts/verify-gui.mjs "<带 token 的 URL>" http://127.0.0.1:3181
```

`verify-gui.mjs` 用 Playwright（无头 Chromium）走完：关掉「内测声明」弹窗 → 开会话 →
用 `/coords/api/open` 让卡片自己弹出来 → 断言三段高度**实测 5% / 75% / 20%** 与
**下带两栏实测 30% / 70%**（并确认列表在左列、详情在右列）→ 切 2D、点「示例」数出
8 个点与 8 个列表项 → 点一个点看右列是否给出各轴数值与象限 → 切 3D 数出三条轴名 →
选点后数出 **6 条红色虚线**（坐标盒）→ 拖拽后坐标盒顶点确实变化 → 打开导入弹窗确认
三个入口 → 保存后 host 列表真的出现 → 删掉验收数据。

最近一次结果（比例还是 10/60/30 那次）：**18 PASS / 0 FAIL**（三段高度 107 / 639 / 320 px；
下带两栏 30% / 70%）。改成 5/75/20 之后，`verify-gui.mjs` 的期望值已同步更新，但**这条脚本尚未复跑**；
换用现场探针在**正在用的实例**上量过一次（2026-09-24，2400×1100，卡片挂在官方右栏里）：
**上带 53px = 5% · 中带 797px = 75% · 下带 212px = 20%**（栏高 1062px）。
Playwright 从 `<你的插件目录>/dsh-web-ui/node_modules` 借（本插件不装浏览器依赖）。

> ⚠️ 脚本开头的「关掉内测声明弹窗」不是可选项：新浏览器 profile 会弹这个全屏弹窗，
> 它那层 `._mask_` 会把坐标点击全部吃掉 —— 症状是"脚本点不动卡片里任何按钮"，
> 但直接 `element.click()` 又能生效（很容易误判成卡片的 bug）。实测踩过。

## 线上实例验证（不新建会话，零污染）

```powershell
node scripts/live-verify.mjs  "<带 token 的 URL>" http://127.0.0.1:3080
node scripts/live-register.mjs "<带 token 的 URL>"
```

`live-verify.mjs` 查四件事：host 路由 200、客户端注入了 `style[data-dsh-coords]`
（且样式里真有卡片类名与 5% 上带）、事件轮询在跑、控制台无本插件报错。
`live-register.mjs` 打开「设置」里的侧边卡片清单，用**既有卡片当对照组**
（清单里必须同时出现「建模中心」与「坐标系」）—— 这样即使某个选择器失效，
也不会把"清单根本没打开"误判成"卡片不存在"。

线上结果（2026-09-25 09:5x，重启后）：

| 项 | 结果 |
|---|---|
| `GET /coords/api/meta` | 200（模板 3 套 · 数据根 `~/.dsh/.dsh-coords`） |
| 客户端样式注入 + 内容完整 | ✓ |
| 事件轮询 | ✓（`/coords/api/events?since=…` 持续请求） |
| 控制台报错 | 无 |
| 侧边卡片清单 | 工作台 / 建模中心 / **坐标系** |
| agent 工具 | `coords_list` / `coords_read` / `coords_save` / `coords_open` 在会话里真调过 |

## 线上发现并修掉的坑

真机跑过之后，下面这些是**只有真环境才会暴露**的，已修并各有守卫用例：

1. **`coords_open` 的"要打开哪一套"会丢**：卡片是这次 open 才被创建的，下一帧才挂载、
   那时才订阅事件总线 —— 本次事件它收不到，于是卡片开了却停在空白。改成把名字存进
   `pendingOpen.name`，组件挂载时 `takePendingSetName()` 取走（`C-16d` 守）。
2. **`coords_read` 的相对路径按宿主进程目录解析**：agent 传 `Work/xxx.json` 会被解析到
   宿主 cwd 下，报"读不到这个文件"，而文件其实就在会话工作区里。改成优先取
   `exec.agent.session.header.cwd`（拿不到才退回进程目录），报错里也把解析基准写出来
   （`H-17c` 守）。
3. **编号/ID 列被当成轴**：整张表第一列常是「编号」，它也是数值，天真的"取前 N 个数值列"
   会让 x 轴变成编号（实测导入 coord3d 的 `works.json` 时 x = `no`）。改成给数值列打分
   （带小数 2 分 > 整数有重复 1 分 > 整数全不重复 0 分），挑完再按原始列序排
   （`H-17b` 守）。
4. **`5% / 75% / 20%` 比例对了但内容装不下 ⇒ 看起来"一片混乱"**（2026-09-25 用户报障）：
   上带被裁 7px + 内部滚动条、下带被挤出容器底部 8px、下带左列头换行吃掉一半高度、
   画布上有 3–4 处标签互相压字。四条一起修（见上面「三段布局的硬约束」），
   真机复量：上带 60px 且零内部滚动、三段之和 == 卡片高度、左列头单行、画布 0 压字
   （默认宽度与压到 420px 两种情况下都成立）。
5. **这一栏"关了还一直自己弹回来"**（2026-09-25 用户报障）：两个毛病叠在一起 ——
   ① 轮询里 `if (pendingOpen.open) tryOpen(ctx)` 直接调 `tryOpen`，成功后**没把欠着的标记
   清掉** ⇒ 每 3 秒补开一次，用户刚关掉就又被顶出来；
   ② 事件接口把 host 缓存的历史事件一次全给客户端，页面每次加载都会把之前 agent 打开过的
   `open` 事件**重放**一遍 ⇒ 刷新一次弹一次。
   修法：补开成功后清标记；首次拉取只当基线，只认 **15 秒内新发生**的事件；欠着的请求与
   名字都带 **20 秒 TTL**（用户几分钟后才切会话时不会被莫名其妙顶一下）。
   守卫：`C-16e`（历史事件不重放 + 成功后不重复打开）/ `C-16f`（打不开欠着、能开只补一次）；
   真机 `scripts/verify-no-popup.mjs`：关掉后等 4 个轮询周期仍是关的、刷新页面也不回弹。
6. **"页面结构全乱了"**（2026-09-25 用户第二次报障，附截图）：截图里能同时看到三样东西 ——
   分段比例的两行控件下面多出一行孤零零的 `5`（上带被裁）、左侧列表从顶部一路铺到页面底部、
   画布盖在下带上。根因是**存进 localStorage 的段落比例可以被拖成歪值**
   （`{top:70,mid:10,bot:20}` 把中带压到 120px 地板、`{top:5,mid:5,bot:90}` 让下带吃掉 90%），
   而旧的 `readBands()` 只校验"三个数合 100"，歪值照单全收。修法见上面第 4 条硬约束。
   真机 `scripts/verify-structure.mjs`：默认 + 三种歪值，全部"图 ≥38% · 三段合得上 ·
   不出容器 · 画布不越界"，且歪值会被写回合法区间（自愈）。

## 已知边界

- 3D 是自绘正交+轻透视，**没有** three.js 的光照/材质；观感与参考页一致但更轻。
- `coords_save` 的取值会被夹进轴范围（越界不报错、如实回报），这是为了避免点落到画布外看不见。
- 卡片与 host 的半段可以各自缺席：`ctx.slots` 不在（非 WebUI 环境）时不注册主面板（只 warn），
  host 没重启（路由 404）时卡片显示可操作提示而不是白屏。
