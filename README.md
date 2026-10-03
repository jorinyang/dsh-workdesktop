# dsh-workdesktop

> A local-first **workbench panel** for [DeepSeek Harness](https://github.com/) (DSH) — a Cordis plugin that renders one sidebar tab with 13 live cards: a decision surface, commitments awaiting response, matters, calendar & todos pulled from your local CLIs, recent recordings, your local knowledge base, and a **cross-source insight layer** (disposition ledger + cross-source checks).

本仓库只包含**插件本体**（host 半体 + 浏览器半体）。它**不含任何数据**：所有内容都来自你本机的知识库目录，路径由环境变量指定。

---

## 1. 它是什么

一个 Cordis 插件包，两个半体：

| 半体 | 文件 | 运行位置 | 职责 |
|------|------|---------|------|
| host | `lib/index.js` | DSH 的 Node 进程 | 挂载 `/workdesktop/api/*` 只读路由、注册 5 个 agent 工具、跑本机 CLI 采集 |
| client | `lib/client.js` | 浏览器页面 | 在 DSH **自带**右侧栏注册「工作台」tab（键控席位），渲染 13 张卡片，按需轮询 host |

设计原则（决定了它的行为）：

1. **一个真相源**：面板不自己派生数据，只展示库内管线产出的产物；写入一律交给库内 CLI（面板不直接改文件）。
2. **只读优先**：绝大多数路由是只读透传；只有「事务关闭/重开 / 专注声明 / 待办 / 待议处置」是显式写通道。
3. **诚实空态**：「读取失败 / 无数据 / 口径为 0」三态分开显示；探测不到的能力就写"未探测到"，不伪装成在线。

---

## 2. 前置条件

- **DSH**（DeepSeek Harness），且其 Cordis 运行时能加载 bundle（本包带 `cordis.patch.yml`）。
- **Node** `^22.19.0 || >=24.0.0`。
- **可选的本机 CLI**（缺哪个，对应卡片就显示不可用，不会崩）：
  - `dws` —— 钉钉侧日程/待办/听记采集
  - `lark-cli` —— 飞书侧日程/任务采集（需已授权）
- **Windows**：host 半体用 PowerShell 5.1 跑采集脚本（macOS/Linux 可运行，但采集类卡片需自行替换实现）。
- ⚠️ **本版不再依赖第三方侧边栏插件**（0.6.0 起的席位变更）：五个工作台与入口**全部**挂在 **DSH 自带**的两条栏上 ——
  ① 「工作台 / 驾驶舱 / **工程图**」的正文 = 自带**右侧栏的 tab 类型**（`ctx.sidebarRightTabs`）+ 键控席位 `sidebar.right.pane.tab`（key = tab id）；
  ② 「坐标系 / 建模中心」同一席位，类型由 `dsh-coords` / `dsh-modeling` 各自注册
     （**`dsh-coords` 现在就并在本仓的 `coords/` 里** —— 它是第二个包，怎么挂见 §5.2；`dsh-modeling` 仍是本仓之外的插件）；
  ③ 左侧栏底部（设置按钮上方）的**五行**工作台图标 = `sidebar.footer.action`（由本插件统一画五行：
     工作台 · 驾驶舱 · 坐标系 · **工程图** · 建模中心；侧边栏折叠成 56px 竖栏时自动切竖排，不溢出）。
  0.5.0 及以前需要 `dsh-better-sidebar` 0.18.x 的那条前提**随之作废**（旧版是挂在那条第三方栏的 tab 上）；
  那条"0.19.1 会 React #130"的教训保留在更早的版本说明里，仅作历史。

---

## 3. 安装

```bash
# 在 DSH 里把本包挂到某个 profile（示例为 web profile）
dsh plugin --profile web add <path-to-this-repo>
```

挂载后重启 DSH 进程（host 半体随进程加载），刷新页面即可看到侧边栏的「工作台」tab。

> **本包就叫 `dsh-workdesktop`，没有第二个名字**（0.9.6 起统一，0.9.7 补齐）：`package.json` 的 `name`、
> `cordis.patch.yml` 的 `insert[].name`、浏览器半段注册用的 `id`、侧边栏那几个 tab 类型的**前缀**、
> **环境变量前缀**（`DSH_WORKDESKTOP_*`，见 §4）、**API 路由前缀**（`/workdesktop/api`，见 §5）
> 与 **DOM 钩子**（`data-dsh-workdesktop*`）—— 全都是它，**没有例外**。
> 「工作台」（英文 workbench）是它**里面的一个功能模块名**，不是一个包名 —— 别把两者当成两个包。
>
> ⚠️ 统一改的是上面这些**前缀**，所以有两件事要你做一次：
> ① 侧边栏**席位偏好会失配**（重新选一遍即可，四类 tab：`console` / `dashboard` / `project-graph` / `workspaces`）；
> ② 环境变量与脚本里若还写着旧前缀，**要改成新前缀**（§4 那张表就是新名字）。
> 旧名与新名的完整对照写在 [v0.9.7 的 Release 说明](https://github.com/jorinyang/dsh-workdesktop/releases/tag/v0.9.7) 里，仓库里只留新名。

---

## 4. 配置（环境变量）

| 变量 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `DSH_WORKDESKTOP_KNOWLEDGE` | 否 | `%USERPROFILE%\Desktop\Knowledge`（macOS/Linux 用 `$HOME`） | 你的知识库根目录（需含 `_meta/out/` 等产物）。**设了就用它**；没设则用推导出的默认值，**但该目录必须真实存在**，否则 host 直接抛错并点名这个变量（不静默指到一个不存在的目录） |
| `DSH_WORKDESKTOP_HERMES_URL` | 否 | `http://127.0.0.1:8787` | 本机 hermes 类服务的地址 |
| `DSH_WORKDESKTOP_CACHE_MS` | 否 | `120000` | 快照缓存时长（毫秒） |
| `DSH_WORKDESKTOP_POWERSHELL` | 否 | 系统 PowerShell 5.1 | 采集脚本用的解释器路径 |
| `DSH_WORKDESKTOP_NODE` | 否 | `process.execPath` | host 调库内 CLI 用的 node |
| `DSH_WORKDESKTOP_PLUGIN_DIR` | 否 | 本包目录 | 自测套件定位用 |

> **0.5.0 的契约变更**：0.4.0 里 `DSH_WORKDESKTOP_KNOWLEDGE` 是**必填**（缺就抛错）；现在改成"环境变量优先 + 默认值可用即用 + 默认值不可用即报错"。这样本机开箱即用，换机器/换用户时仍然当场说清该设哪个变量（自测 `L2-1..L2-4` 守这一条）。

```powershell
# Windows
$env:DSH_WORKDESKTOP_KNOWLEDGE = "D:\my-vault"
```
```bash
# macOS / Linux
export DSH_WORKDESKTOP_KNOWLEDGE="$HOME/my-vault"
```

---

## 5. 13 张卡 / 主要路由

卡片（顺序即面板渲染顺序，三带布局 · 唯一真相源是 `lib/client.js` 的 `CARD_ORDER`）：

| 带 | 卡片（key） |
|----|------------|
| 热层（今天动手） | **决策**(`brief`) · **响应**(`triggers`) · **事务**(`matters`) · 日程(`schedule`) · 待办(`todos`) |
| 在办层（这件事到哪了） | 专注 · 活跃(`focus`) · **流入**(`inflow`) · **跨源洞察**(`insights`) · **资产**(`recall`) |
| 参考层（查阅与诊断） | **验收**(`metrics`) · 文件(`kb`) · 听记(`minutes`) · 系统(`system`) |

> **13 张卡不含独立的「对象」卡**（`objects`，2026-09-21 撤除）。对象**没有消失**：它是**属性**，被并入其它卡片——`objects.json` 照旧由库内管线生成，只是不再单独占一张卡。落点是：
> ① 事务卡**行内**的归属对象标签（带 `data-object-key`）· ② 事务详情的「**归属对象 · 对象下一步 · 对象出处**」段 · ③ 流入卡的「**未归属 N 条**」提示 · ④ 跨源洞察证据段的「**支撑强度 · 证据线**」 · ⑤ 「专注 · 活跃」卡的**域 → 对象 → 事务**三级下钻。
> 兼容性：旧 `ui-prefs.json` 覆盖层里残留的 `objects` 现在是**未知键**——被 `mergeCardOrder()` / `mergeUiPrefs()` 静默忽略（不报错、其余键照旧生效、顺序**不会整体回默认**），`selftest.mjs` 的 `L1-13` 就守着这条。

> 顺序由代码里的默认表驱动；用户可**长按任意卡片拖动排序**（长按约 400ms 进入拖动，无手柄、无浮层按钮）。同一张卡上，**短按卡片名 = 场景交互**（当前 13 张卡统一为"折叠/展开本卡内容"，再点一次恢复），**长按整卡 = 拖动排序**，两者不会互相吞掉。拖动的结果落在知识库的 `ui-prefs.json`（覆盖层：只影响渲染、不改默认表；未知卡片名被忽略）；面板顶部有一行「恢复默认顺序」文本链接。未登记的卡片始终追加在末尾，不会消失。

**0.5.0 起，「系统」卡内还有三张能力小卡片**（2026-09-23 用户裁定）：**实时回复**（数字分身自动回复）· **响应功能**（自我窗口的语音命令通道）· **向量检索**（知识库常驻检索服务）。每张一盏四态灯（在线 / 待机·执行·检索 / 离线·失效 / 关闭），**点一下就是开关**：

- 灯色**只由 host 判定**（`GET /system-state`）：开关位 + 计划任务状态 + 单实例锁内 pid + 消费者心跳 + 检索服务心跳，**抽掉任何一份证据都不许显示在线**（"不知道它在不在干活" ≠ "它在干活"）。
- 开关是**分支闸**，不是启停进程：前两个能力跑在同一个常驻消费者进程里，关一个不影响另一个；打开时若消费者任务不在跑，才会拉起来（幂等，**从不 `/end`**）。
- 写入口唯一：`POST /system-switch` → 库内 `system-switches.mjs#writeSwitch`（原子写），host 自己不碰那个文件。

**「响应」卡另有一段「按会话聚合」**（0.5.0 新增）：数据来自常驻消费者写的 `auto-reply-ledger.json#threads`（聚合单位 = **会话 × 会议实例**），一行一个会话，写清对象 / 渠道（单聊 · 群内@我）/ 条数 / 是否需要人工 / 关联事务；点开看该会话最近几条往来与判定（无需回复 · 可直接代答 · 需人工已转事务）。取不到台账时**如实写"取不到 + 原因"**，不冒充"没有会话"。

**卡片尺寸与缩放**（0.6.0 新增）：每张卡右下角有一个小三角，**按住往右下拖 = 放大、往左上拖 = 缩小**（横竖同时生效）。两档，由顶部那一行文字链接切换（「缩放：网格 5%」⇄「缩放：无级」）：

- **网格 5%（默认）**：宽 = 画布宽度的百分比、高 = 画布**看得见高度**的百分比。拖动过程**按像素跟手**（不逐帧吸附，列跨度跟着"放得下"走），**松手才吸附**到最近的 5%，并用一次 180ms 过渡落到格点上（系统设了"减少动效"就不做动画，吸附照做）。
- **无级**：像素自由，不吸附、不回弹。两档都有"宽 ≤ 画布宽"的夹取。

画布 = 卡片区的内容区（**固定 20 列**，每列 5%），底色/底纹铺满侧边栏、卡片区四周留 10px；没调过尺寸的卡按"老栅格一列宽"折算成整数格，所以**默认外观不变**。尺寸只落在本机 `localStorage`（`dshw.cardSize` / `dshw.cardSizeMode`，松手才写），不进知识库产物、也不进 `ui-prefs`。

**卡内内容跟着卡宽自适应**：卡内边距与卡体可视高度上限有三档（≤300px / ≥520px / ≥760px）；「系统」卡里的小卡片按卡宽**每行 1 / 2 / 3 / 4 个**（<220px 一列 · ≥220px 两列 · ≥380px 三列 · ≥620px 四列）—— 拉宽之后一排放得下更多，缩窄就一层层收回来。

其中三张是"按**事**而不是按来源"的：今日决策面（热层：昨夜动向 / 今日必办 / 待定等对方）· 跨源洞察（每条带证据链、支撑强度与**可反驳入口**，无证据不入面板）· 事务（行内直接带归属对象，详情页把对象下一步与出处并置）。

host 路由（均在 `/workdesktop/api` 下）：

| 路由 | 方法 | 读/写 | 说明 |
|------|------|-------|------|
| `/snapshot` | GET | 只读 | 日程 / 待办 / 知识库 / 听记（跑本机 CLI） |
| `/state` | GET | 只读 | 面板主数据（多产物聚合） |
| `/objects` | GET | 只读 | 业务对象索引（按"事"聚合）。**独立「对象」卡已撤除，但这条路由此仍是对象属性的来源**：事务卡行内标签 / 事务详情「归属对象·对象下一步·对象出处」/ 流入卡「未归属 N 条」/ 专注·活跃卡三级下钻都消费它 |
| `/disposition` | GET | 只读 | 处置台账（判定 → 落点 → 悬置时长） |
| `/crosscheck` | GET | 只读 | 多源校验（溯源 / 支撑强度 / 计划↔实际 / 矛盾） |
| `/domain-health` | GET | 只读 | 关注域健康度 |
| `/brief` | GET | 只读 | 今日决策面（热层） |
| `/insights` | GET | 只读 | 跨源洞察（含证据链与可反驳入口） |
| `/feedback` | GET/POST | 读+写 | 判断质量台账（驳回/修正必须带理由；达阈值只出「待裁定」，**绝不自动改判断层**） |
| `/dashboard` | GET | 只读 | 库内自包含 HTML 快照 |
| `/sysstatus` `/activity` | GET | 只读 | 系统在线状态 / 实时活动 |
| `/event` `/open` | GET/POST | 只读/打开 | 事件详情、打开文件 |
| `/matter` `/matter/record` `/matter/check` `/matter/close` `/matter/reopen` | GET/POST | 读+写 | 事务详情与写通道（写入交给库内 CLI） |
| `/focus` | POST | 写 | 专注块声明/结束（**GET 已删除 → 410 墓碑**，专注态以 `/state.focus` 为单一真相源） |
| `/active-domains` | GET/POST | 读+写 | 活跃关注域（`?match=1` 触发一次匹配；POST 为声明/清除，与 agent 工具共用同一条 CLI） |
| `/ui-prefs` | GET/POST/DELETE | 读+写 | 卡片顺序覆盖层（未知卡片名忽略并回报；DELETE = 恢复默认）。**注意**：同一文件里的 `briefSeenAt`/`briefRead` 被库内 `build-brief.mjs` 当游标消费，所以它不只是渲染偏好 |
| `/matter/reschedule` | POST | 写 | 事务改期（走库内 CLI） |
| `/todo/act` | POST | 写 | 待办动作（host 只校验与透传，判定在库内 CLI） |
| `/triggers` | GET | 只读 | 响应清单（触发详情）+ **`threads`（自动回复台账的按会话聚合段，0.5.0 起）** |
| `/system-state` | GET | 只读 | 「系统」卡三张能力小卡片的四态与**全部证据**（开关文件 · 计划任务 · 锁内 pid · 消费者心跳 · 检索服务心跳） |
| `/system-switch` | POST | 写 | 手动开关（能力名原样交给库内 CLI 判；**打开时幂等拉起消费者，从不 `/end`**） |
| `/trigger/respond` `/trigger/act` `/trigger/to-matter` | POST | 写 | 触发的响应 / 处置 / 转事务（判定在库内 CLI，host 只校验与透传） |
| `/matter/draft-from-minutes` | POST | 读（透传） | **听记 → 事务草稿（0.6.0 新增）**：取正文（飞书 `lark-cli minutes +detail` / 钉钉 `dws minutes +detail`）交给库内草稿引擎，出参**原样透传**（标题 / 关闭条件 / 域建议 / 锚点候选都由引擎产，host **不重写任何判定**）；取不到正文时如实给 `unavailable_reason`，不拿标题编一份假草稿 |
| `/rebuild` | POST | 写 | 幂等重建库内快照 |
| `/disposition/act` | POST | 写 | 待议流入处置（面板「流入处置」卡有控件：拒绝/转出 + **理由必填**；host 只做校验与透传，判定在库内 CLI） |

agent 工具：`workbench_todo` · `workbench_focus` · `workbench_active_domains` · `workbench_matter` · **`project_graph`**。

### 5.1 工程图（Project Graph）· 2026-10-03 新增

第五个工作台：把本机的 [Project Graph](https://github.com/graphif/project-graph) 接进 DSH。
面板是一栏（官方右侧栏的 tab 类型 `dsh-workdesktop:project-graph`，入口排在左侧栏
「坐标系」下方、「建模中心」上方），**内容是上游自己的 CLI 跑出来的** ——
本插件不复制它的图模型、不重写它任何一条判定，只做三件事：拉起 CLI、把结果透传给浏览器半段、
把同一批动作开成 agent 工具 `project_graph`。

三层各自是什么：

| 层 | 位置（环境变量可覆盖） | 说明 |
| --- | --- | --- |
| ① 上游检出 | `DSH_WORKDESKTOP_PROJECT_GRAPH_REPO`，默认 `%USERPROFILE%\Desktop\DSH\project-graph` | clone 下来的 project-graph，**必须 `pnpm install` 过**；CLI 入口 `packages/project-graph-cli/src/cli.mjs` |
| ② 工程图工作区 | `DSH_WORKDESKTOP_PROJECT_GRAPH_DIR`，默认 `$DSH_HOME/.dsh-project-graph` | 本插件的数据根：`projects/` 放 `.prg` 工程 · `bin/` 放编译出来的所有权 helper 与空工程模板。**与知识库解耦**（不往 `_meta/out/` 写任何东西） |
| ③ 本插件 | `lib/index.js` + `lib/client.js` | 路由 `/workdesktop/api/pg/*` · 面板 · agent 工具 `project_graph` |

**为什么要自己编一个「所有权 helper」**：上游 CLI 在动手前必须先**独占**目标 `.prg` ——
它 spawn 一个**原生产物**（`app/src-tauri/src/bin/project-graph-ownership-helper.rs`）并核对一行
JSON 协议；它还要读写「项目级引用」存储（`n1` / `e1` 这套稳定句柄，落在
`%APPDATA%\liren.project-graph\ai-project-references.json`）。本机没有那个目标原生产物
（要整条 Tauri / CEF 工具链），所以本仓库带一份**同协议的 C# 等价实现**：

    pg-helper/ProjectGraphOwnershipHelper.cs          ← 唯一真相（源码入库）
    <工程图工作区>/bin/project-graph-ownership-helper.exe ← 运行前用系统自带 csc.exe 现编（**仓库不放二进制**）

协议（五条命令：`try-hold-project` · `hold-project` · `load/save-project-references`）
与**与上游 Rust 版的已知差异**都逐条写在那个 `.cs` 的头部注释里。

**上游的 29 个内置工具 = 工程图的全部动作。** agent 工具 `project_graph` 把它们原样开给会话：

| 动作 | 干什么 |
| --- | --- |
| `status` | 可用性自检（上游检出 / CLI / 依赖 / helper 四样逐条报状态，不说"不可用"了事） |
| `projects` · `create` · `rename` · `delete` | 工程清单与工程文件的增删改名 |
| `tools` · `describe` | 上游工具目录（29 条）与某条的完整入参 schema |
| `invoke` | **执行任意一条上游工具**（`tool` / `input` 原样透传，不改写） |
| `graph` · `open` | 取一张图的全部对象 / 把「工程图」那一栏弹到眼前 |

⚠️ **关闭态 19 条 / 打开态 10 条（上游的边界，本插件原样透传）**：上游按
`BuiltInToolRuntimeProfiles.ts` 把 29 条分两档。**关闭态可跑 19 条**（读 / 改 / 删 / 连线 /
树扩展 / 布局 / 上色，不需要桌面端）；**需要打开态 10 条**声明了 `viewport` 或 `selection`
（`create_text_node` `generate_node_tree_by_text` `search_and_add_image_node` `select_objects`
`get_selected_nodes` `get_selected_refs` `get_nodes_in_viewport` `delete_selected_nodes`
`sort_selected_nodes_by_x/by_y`），只有桌面端开着才有，关闭态调用回 `PROJECT_MUST_BE_OPEN` ——
本插件**原样透传这个错误码**，不假装成功、也不把这个能力说成"我们也支持"。
⇒ 所以关闭态下"新建节点"的正路是**树扩展**：空工程模板里预置了**一个根节点**，
`expand_node_tree_from_node` / `breadth_expand_node` / `depth_expand_node` 都能长出整棵树，
而这三条都不需要 viewport。

新增路由（`/workdesktop/api` 下）：`/pg/status` · `/pg/projects` · `/pg/project`（POST：
create/rename/delete，**本插件唯一自己写盘的地方**，只碰 `.prg` 文件本身）· `/pg/tools` ·
`/pg/tool` · `/pg/invoke`（POST）· `/pg/graph` · `/pg/events` · `/pg/open`。

#### 5.1.1 对外 MCP server（2026-10-03 新增 · v0.8.1 起）

工程图**对外也提供一个 MCP server**，DSH 的 MCP 客户端可以直接连上，用标准 MCP 工具调用
建 / 改 / 删工程图内容 —— 不必经过本插件。**共 42 条工具，分三层**：

| 层 | 条数 | 是什么 |
| --- | --- | --- |
| ① **上游 29 条内置工具** | 29 | `create_text_node` · `edit_text_node` · `delete_node` · `create_edges` · `auto_layout_dag` · `expand_node_tree_from_node` … —— **名字、说明、`inputSchema` 全部取自上游 `tool list`，一个字都不改写**，只加一个必需的 `project` 与可选的 `allowUpgrade`。所以"上游能做的"与"客户端能做的"是同一集合 |
| ② **文档容器层** | 4 | `pg_document`（读整份 `.prg`：元数据 / 全部条目 / 附件 / **全部舞台对象**，不只节点与连线）· `pg_locate`（引用 `n1` ↔ 文档 `uuid` 的**精确**对照）· `pg_move_node`（**移动 / 缩放**实体 —— 上游 29 条里没有"移动"，但规范里实体必有位置且必须可手动移动）· `pg_set_details`（写**详细信息** —— 规范说"任何实体上都可以写"，上游同样没有这条） |
| ③ **元工具** | 9 | `pg_status` · `pg_projects` · `pg_create` · `pg_rename` · `pg_delete` · `pg_tools` · `pg_describe` · `pg_graph` · `pg_invoke`（任意上游工具的兜底通道） |

- **server 本体**：`pg-helper/project-graph-mcp.mjs`（**零依赖**手写 JSON-RPC 子集，只用 `node:` 内置）+
  `pg-helper/project-graph-prg.mjs`（`.prg` 容器编解码：ZIP + MessagePack，同样零依赖）。
  为什么手写：它要被 DSH 以 `command: <node.exe> args: [<这个文件>]` 直接 spawn，
  而官方 MCP SDK 装在 DSH 自己的检出里，从这个文件的位置**解析不到**；
  本项目的插件纪律也是"只用 `node:` 内置"。
- **合规怎么保证**：`pg-helper/verify-project-graph-mcp.mjs` 让**官方 SDK 的客户端**
  （`@modelcontextprotocol/client` v2.0.0，DSH 自己用的就是它）连上来跑完整流程 ——
  握手 / 版本协商 / `tools/list` / `tools/call` 全走它的实现。
  **自己写个客户端只能证明"我按自己的理解说、按自己的理解听"，两边一起错的时候照样全绿。**
- **两层用两套标识，别混**：上游那层用**项目级引用**（`n1` / `e1`），文档层用**舞台对象的 `uuid`**。
  `pg_locate` 给出的对照是**精确双射**（实体按 类型+文本+坐标、连线按 两端uuid+文本，两边都唯一才配对），
  **不是模糊匹配**；配不成双射就回 `ok=false`，`pg_move_node` / `pg_set_details` 会**拒绝改动**而不是猜。
- **协议**：stdio，一行一个 JSON-RPC 消息；版本 `2025-11-25`（支持集
  `2025-11-25 / 2025-06-18 / 2025-03-26 / 2024-11-05 / 2024-10-07`）。
  ⚠️ stdout **只允许出现 JSON-RPC 消息**，日志一律走 stderr —— 往 stdout 写一行人类可读的字，
  客户端当场解析失败。
- **上游目录落盘缓存**：`tool list` 是 tsx 冷启动 + Vite SSR，单次 10~20 秒，而 `tools/list`
  是客户端每次连接都会发的请求 ⇒ 目录缓存到 `<工作区>/cache/tool-catalog.json`，
  有缓存立刻用、过期了在后台刷新（不阻塞本次回执）。
- **怎么挂**：在 profile 的 `cordis.patch.yml` 里加一条 `@deepseek-ai/dsh-mcp-client`
  （本机的实例见 `$DSH_HOME/profiles/web/cordis.patch.yml` 的 `mcp-project-graph` 段）。
  ⚠️ 沿用了本机既有的 Windows spawn 规避：用 `process.execPath` 直指当前 node
  （不依赖 PATH 上的 `.cmd` / `.ps1` shim），并把 server 脚本当**绝对路径参数**传进去。
  ⚠️ MCP 客户端给子进程的环境是**清洗过再合并**的，所以工作区与上游检出路径要在 `env` 里**写全**，
  不要指望 `USERPROFILE` / `DSH_HOME` 还在。
- **它没有做的**（诚实清单）：只实现 `tools/*`；`resources/*`、`prompts/*`、`logging` 没实现
  （`list_mcp_resources` 回空数组是**上游 SDK 的宽容**，不是我们实现了资源）；只有 stdio 传输；
  工具集是静态的（`listChanged:false` 如实声明）。
  文档层**不做**序列化器的类还原（解出来是纯对象树），所以只改字段、不改形状的操作是安全的；
  "从零造一个新类型对象"没做（那要拼出与序列化器完全一致的形状）。
  `.prg` 规范里还是"未来考虑"的那几节（`sub/` 子舞台、`versions/`、`settings.msgpack`）也没做。

第一次用：

    node pg-helper/setup-workspace.mjs     # 建工作区 + 编 helper + 造一个起始工程

六套离线自测（都不需要 DSH 起来）：

    node selftest-project-graph-client.mjs                                        # 20 条：席位/顺序契约（源码级，**进 CI**）
    node pg-helper/verify-project-graph-doc.mjs                                   # 22 条 + 3 SKIP：`.prg` 文档容器编解码（零依赖，**进 CI**）
    node selftest-project-graph.mjs <上游检出>                                     # 30 条：路由真跑（真 spawn CLI）+ agent 工具真建/读/删
    node pg-helper/verify-ownership-helper.mjs <helper.exe>                        # 15 条：helper 的行协议
    node pg-helper/verify-project-graph-cli.mjs <上游检出> <helper.exe> <模板> <工作目录>  # 31 条：上游 CLI 的读/建/改/连/删
    node pg-helper/verify-project-graph-mcp.mjs                                    # 32 条：MCP 合规（拿**官方 SDK 客户端**当对手）

**前两套进 CI**（零依赖、离线就能跑，见 §8）。**后四套故意不进**：它们要 clone 上游、`pnpm install`、
Windows + `csc.exe`、或 DSH 检出里的官方 MCP SDK —— 放进 CI 会让"裸 clone 就能自证"这条承诺失效。
其中 `selftest-project-graph.mjs` 尤其进不了：它 import host 半段，而 host 半段在模块加载期就要求
**一份真实存在的知识库根目录**（`DSH_WORKDESKTOP_KNOWLEDGE`，见 §4 的报错契约），且每条断言都真的
spawn 上游 CLI —— CI 上只会整片红，红了也证明不了任何事。

（另有一套零依赖的离线套件没进 CI：`node pg-helper/verify-project-graph-image.mjs`，6 条 + 2 SKIP，
附件节点的读法。）

### 5.2 坐标系（Coords）· 2026-10-03 并入本仓

本仓库现在是**一个仓、两个包**：

| 包 | 目录 | 包里是什么 | profile 里那条 bundles 条目 |
|---|---|---|---|
| `dsh-workdesktop` | 仓库根 | 工作台（13 张卡）+ 工程图席位 + `pg-helper/` | `dsh-workdesktop`（根 `cordis.patch.yml`） |
| `dsh-coords` | `coords/` | 坐标系插件（host 路由 + 官方右栏 tab） | `dsh-coords`（`coords/cordis.patch.yml`） |

> ⚠️ 两半的 `lib/` **来历不同**，别按同一套办法改：根目录的 `lib/index.js` · `lib/client.js` 是
> "从插件源**复制 + 脱敏**"的产物（见 §11），改它要走发布流水线；`coords/lib/` 是 `coords/src/` 的
> **构建产物**（`node coords/scripts/build.mjs`，`--check` 守"产物与 src/ 一致"）。

**「两个插件同仓」在安装/加载层面怎么落地。** DSH 的 `dsh.profile.bundles` 是**包名列表**，
profile 启动时按顺序把每个包的 `dsh.bundle.patch`（`cordis.patch.yml`）叠成插件树
（`packages/boot/app-boot/src/profile.ts`：`packageName` → `packageDir` → `patchPaths` → `patches`）。
也就是说 **一个包 = 一条 bundles 条目 = 一层 patch**，两个包就得**各挂一次**：

```bash
dsh plugin --profile web add <本仓库>            # 装根目录那个包（dsh-workdesktop）
dsh plugin --profile web add <本仓库>/coords     # 装 coords/ 那个包（dsh-coords）
```

手工挂也行（作者本机就是这个形状，见 `coords/README.md`）：profile 的 `dependencies` 各写一条
`link:`，`node_modules` 各建一个 junction，`dsh.profile.bundles` 追加两个名字 ——
本机 `~/.dsh/profiles/web/package.json` 里 `dependencies` 的**键名**、`node_modules` 里的
**目录名**、`bundles` 里的**条目**三者必须是同一个名字。

**根目录那份 `cordis.patch.yml` 只插 `dsh-workdesktop` 一行，故意不插 `dsh-coords`。**
理由：patch 里的 `insert[].name` 是**裸说明符**，由 profile 的 `node_modules` 解析
（`packages/boot/app-boot/tests/profile.spec.ts` 的 "anchoring inserted paths beside each file"：
只有 `./local.js` 这类**相对名**才会被锚定到 patch 文件旁并转成 `file://`，`pkg-a` 这类裸名原样交给加载器）。
没装第二个包时把 `dsh-coords` 写进去，boot 会去解析一个不存在的包。

坐标系这一半：

| 面 | 内容 |
|---|---|
| 席位 | 官方右侧栏的 tab 类型 `dsh-coords:center`；左侧栏底部那五行入口由**工作台**统一渲染 |
| host 路由 | `/coords/api/*`：`meta` · `sets` · `set` · `parse` · `intake` · `templates` / `template` · `events` · `open` · `sample` |
| agent 工具 | `coords_open` · `coords_save` · `coords_list` · `coords_get` · `coords_read` · `coords_template` |
| 落盘 | `$DSH_HOME/.dsh-coords/`（`DSH_COORDS_DIR` 可覆盖） |
| 运行期变量 | `DSH_COORDS_MAX_POINTS`（点上限，默认 2000）· `DSH_COORDS_MAX_BYTES`（导入体积上限，默认 8MB） |
| 自带自证 | `cd coords && npm test`（= `build.mjs --check` + host **26 条** + 浏览器 **30 条**），三条都只依赖仓内文件 |

> ⚠️ **`coords/scripts/` 只随仓发布 `build.mjs` 一个脚本。** 作者本机那几条真机验收
> （`trial-boot` / `verify-gui` / `verify-structure` / `verify-layout` / `verify-no-popup` /
> `live-verify` / `live-register`）**没进本仓** —— 它们要一份能跑的 DSH 检出（`DSH_HARNESS_ROOT`）、
> 一个带 token 的**在用**实例、以及从别处借来的 Playwright（本插件不装浏览器依赖），换台机器定位就得重写。
> `coords/package.json` 的 `scripts` 里**没有**指向这些文件的条目（免得 `npm run` 指向空气）；
> `coords/README.md` 保留了这些套件的设计意图与当时的读数（含"未复跑"这类如实标注）。

## 6. 数据从哪来（重要）

面板**不生产数据**。它读的是知识库目录里的产物（`_meta/out/*.json`：`snapshot.json`、`matters.json`、`triggers.json`、`objects.json`、`disposition.json`、`crosscheck.json`、`s-metrics.json` 等），这些产物由**你自己的库内管线**生成。

所以：**没有配套的库内管线，卡片会显示为空或"不可用"** —— 这是设计使然，不是 bug。

---

## 7. 已知限制（诚实清单）

- **依赖库内产物与目录约定**（`Work/<客户>/…`、`_meta/out/*.json`）。这些约定不随本仓库发布。
- **Windows 偏向**：采集脚本是 PowerShell 5.1；`dws` / `lark-cli` 缺失时相关卡片显示不可用。
- **测试只覆盖"结构性契约"**：本仓库自带 `selftest.mjs`（见 §8），但它是**离线、无 vault** 的：不覆盖真实 DSH 运行时、槽位渲染与真实数据链路。
- **依赖外部授权的能力**：飞书任务/日历/邮箱需在**你自己的** CLI 侧完成授权（缺 scope 时面板会写明缺哪个，而不是假装为空）；短信链路只在 macOS 上可用（本机无 `chat.db` 时不参与采集）。
- **指标口径**：所有阈值/时限默认标注"未校准"（`calibrated: false`），面板只展示、不做考核。
- 本插件为**个人工作台**性质，未做多用户/权限模型；请只在**本机**使用（host 绑定 127.0.0.1）。

---

## 8. Self-test（clone 下来就能自证）

```bash
node selftest.mjs      # 零依赖、离线；输出 PASS = n / FAIL = m
```

它自带一份**中性 fixture**（`selftest/fixtures/_meta/out/*.json`：`objects` / `disposition` / `crosscheck` / `domain-health` / `brief` / `insights`，全部是 `示例客户` / `组织甲` / `MT-20250101-001` 这类虚构示例；`ui-prefs.json` **不预置**——"覆盖层不存在"本身就是一条被测契约），并在四个层面给出证据：

| 组 | 证明什么 |
|----|---------|
| **1 路由真跑** | 用桩 `ctx`（捕获 `webServer.register`）挂载 host 半体，用假 `req`/`res` 调 `/objects`、`/disposition`、`/crosscheck`、`/domain-health`、`/brief`、`/insights` → 断言 **200 + 面板实际消费的字段**（`objects[].key/state/next_step`、`disposition.summary.{landed,noLanding,landingRate}`、`crosscheck.trace/multiSource/contradictions`、`brief.todayMustDo/waiting/overnight`、`insights[].evidence/support/rebuttal` 等）；另有三条**"不许静默"**断言：台账未生成必须 **503 + 明确文案**、`/focus` GET 必须是 **410 墓碑**、`/disposition/act` 的三类非法入参必须在**调用库内 CLI 之前**被拒（这也是它能在克隆体里被断言的原因） |
| **2 配置缺失必须响** | 不设 `DSH_WORKDESKTOP_KNOWLEDGE` 时 import **直接抛错**并点名该变量；断言错误信息里**没有**任何硬编码的个人路径（不允许静默回落到某人的桌面） |
| **3 源码契约** | 两半体语法通过 · `CARD_ORDER` 存在且 **13 张卡顺序可断言**（顺序是产品承诺，不能是执行顺序的副产品）· host 的 `KNOWN_CARD_KEYS` 与之**逐项一致**（漂移的失败形态是**静默丢卡**）· `package.json` 元数据正确 |
| **4 脱敏守卫** | 仓库**扫描自己**：个人绝对路径 / 邮箱 / 手机号 / 凭据形态 / URL 里的令牌 ⇒ **0 命中**；**带负向对照**（人造敏感串必须被抓到，否则"全绿"毫无意义）· 并断言 fixture 里每个 `Work/<目录>/` 都来自中性示例 |

其中 `/ui-prefs` 一组（`L1-8` ~ `L1-13`）覆盖覆盖层契约：GET 报 **13 个已知键**且无覆盖层时 `exists=false`（不当成空数据）· POST 忽略并回报未知卡片键/未知字段、重复只取首次 · 落盘可读回 · 空写被拒且不写坏既有覆盖层 · **已撤卡键（`objects`）被忽略但其余键照旧生效、顺序不整体回默认** · DELETE 真删文件并回到 `exists=false`。

**它不能证明什么**（别过度解读一次全绿）：不覆盖真实 DSH 运行时与槽位渲染 · 不覆盖浏览器半体交互 · 不覆盖依赖真实 vault 的链路（日程/待办/DSH 工具）· 真实业务词表的**权威脱敏扫描在仓库外**留存，这里只做结构性规则与 fixture 中性性。

> 为什么仓库里保留 `cordis.patch.yml`：它是本包的**安装面**（`package.json` 的 `dsh.bundle.patch` 指向它）。只发 `lib/` 的话别人 clone 下来**装不起来**，自证也就无从谈起。

CI：`.github/workflows/selftest.yml` 在 **Linux + Windows × Node 22/24** 上跑**六条命令**，每条一个 step
（哪一条红了当场看得见，不用从一整坨输出里猜）：

| # | 命令 | 读什么 |
|---|------|--------|
| ① | `node selftest.mjs` | 上面那四组：路由真跑 / 配置缺失必须响 / 源码契约 / 脱敏守卫（**39 条**） |
| ② | `node selftest-project-graph-client.mjs` | 工程图的席位与顺序契约，源码级（**20 条**） |
| ③ | `node pg-helper/verify-project-graph-doc.mjs` | `.prg` 文档容器编解码（**22 条**，要上游 CLI 的 3 条自己 SKIP） |
| ④ | `node coords/scripts/build.mjs --check` | `coords/lib/` 与 `coords/src/` 一致 |
| ⑤ | `node coords/selftest.mjs` | 坐标系 host 半段（**26 条**） |
| ⑥ | `node coords/selftest-client.mjs` | 坐标系浏览器半段（**30 条**） |

六条都是**零依赖、离线**的：不装包、不联网、不需要 vault、不需要 DSH 起来。
④ 尤其要留着 —— 本仓两个包的 `lib/` **来历不同**（根目录是"复制 + 脱敏"，`coords/` 是构建产物），
改名或改注释时很容易只改一边，这条会当场抓住。

---

## 9. 开发

```bash
node --check lib/index.js   # host 半体语法
node --check lib/client.js  # 浏览器半体语法
node selftest.mjs           # 自证（见 §8）
```

约定：

- **编码必须是 UTF-8（无 BOM）**。本仓库发生过一次真实事故：源码被"UTF-8 字节按 GBK 解读后再存成 UTF-8"，导致 840 处字符丢失、84 处换行被吞、语法错误 —— 表面却仍像正常文件。见 `.editorconfig`。
- 改 host 半体需**重启 DSH** 才生效；改 client 半体**刷新页面**即可。
- 卡片新增/改序必须同时改**四处**声明：`CARD_ORDER`（客户端装配段）、`CARD_TITLES` / `CARD_TITLE_ORDER`（显示名契约）、host 的 `KNOWN_CARD_KEYS`（覆盖层过滤表）与顺序断言；漏改 host 那份的失败形态是**静默丢卡**（用户拖过的卡被当成未知键丢弃），所以 `selftest.mjs` 直接断言两份逐项一致。

---

## 10. 更新概览 · v0.9.7（当前）

一句话：**把"统一"补完，并把整条历史重写了一次**。没有新功能。

上一版（0.9.6）统一了包名、bundle 名、客户端注册 id 与侧边栏 tab 前缀，但**留了三处例外**
（环境变量前缀、API 路由前缀、DOM 钩子）—— 理由是"运行期契约，改了要重配"。这一版按"**为何会有不一致？
需要一致统一**"把它们一并改掉，全历史一起重写：

**修正**

- **三处补齐**（只在**发布产物与它的历史**里改；作者本机的私有插件与库内真机套件驱动的是私有插件，**没动**）：

  | 改的是什么 | 新写法 | 处数 |
  |---|---|---|
  | 环境变量前缀（26 个变量） | `DSH_WORKDESKTOP_*` | 98 |
  | host 路由前缀 | `/workdesktop/api` | 115 |
  | DOM 钩子（挂在两个 `<style>` 上的标记） | `data-dsh-workdesktop` / `data-dsh-workdesktop-v2` | 2 |

  合计 **215 处 / 17 个文件**。**仍然不动**：`dshw-*`（CSS 类前缀，改了会连带打断大量守卫）·
  `dsh-coords` / `dsh-modeling`（是别的包）。
  （一栏一个字的**旧名 → 新名对照表**放在 [v0.9.7 的 Release 说明](https://github.com/jorinyang/dsh-workdesktop/releases/tag/v0.9.7) 里 ——
  本 README 里只写新名，因为仓库自己会被同一套改名规则扫一遍，写旧名只会被改掉、读起来自相矛盾。）
- **历史第二次改写**：连同上一轮那 41 条脱敏规则一起，在**全部 25 个提交 + 15 个 tag** 上重跑一遍
  （`git filter-repo`），所以**又一次全体换哈希**。
- **公开 README 里的"历史披露"保持中性**（上一版已撤，这一版不变）。

**契约变更（比上一版更彻底）**

- 环境变量前缀、API 路由前缀、DOM 钩子三处**都已改名**。⇒ 环境变量或脚本里写着旧前缀的**要改**；
  已存的侧边栏席位偏好**会失配**（重新选一遍）。
- **tag 规则变更**：**已发布的 tag 不再移动**，任何后续改动**向前发新版本**（见 §11 发布清单第 4 条）。

**升级**

1. 历史被再次重写 ⇒ **重新 clone**，别在旧 clone 上硬拉。
2. 把环境变量与脚本里的旧前缀改成新前缀（§4 的表就是新名字）。
3. 重启 DSH，侧边栏席位偏好重新选一遍。

**验证**

- 仓内六套自测全绿：`selftest.mjs` **39/0** · 工程图席位契约 **20/0** · `.prg` 编解码 **22/0**（+3 SKIP）·
  coords 产物一致性 通过 · coords host **26/0** · coords 浏览器 **30/0**；另跑了不进 CI 的
  工程图 host 套件 **30/0**。
- 全历史零残留（87 条词表 × `--branches --tags`）· 改写保真（旧内容跑同样规则与新内容逐字节比，
  不一致 **0**）· 逐版本自洽（15 个版本，**这一轮连环境变量前缀与路由前缀也一并抽**）。

---

### 10.1 v0.9.6 · 脱敏补做 · coords 收尾 · 身份统一（第一轮）

本轮三件事：**补做脱敏那一步** · **把 `coords/` 并入补齐** · **命名统一成 `dsh-workdesktop`**。
没有新功能，都是"账要平"的收口。

**修正**

- **脱敏那一步在 v0.9.x 的同步里漏跑了**：本仓 `lib/index.js` · `lib/client.js` 与作者私有的插件源
  **逐字节相同**，也就是说"复制 → 逐条替换"里的**替换**没执行 —— 库内流水线目录这类**相对路径**、
  一处示例关注域 id、一处私有规范文档路径、一处示例客户名都还在仓里（v0.8.0 ~ v0.9.5 都带着）。
  本仓自测的脱敏守卫只做**结构性**规则（个人绝对路径 / 邮箱 / 手机号 / 凭据形态 / URL 令牌），
  抓不到这些相对路径与业务词 ⇒ 它一直全绿，**真正抓到它们的是仓库外那份权威反扫**。
  本轮已补做：逐条替换（每条断言命中次数）+ 替换后自证 + 反扫，**零命中**。
- **全历史一并收拾，不只是 HEAD**：v0.8.0 ~ v0.9.5 那些提交里带着的同一批词，
  用 `git filter-repo` 在**整条历史**上替换掉了（分支与全部 tag 都已重写，见 §11）。
  改写后逐版本抽查：每个 tag 检出来扫一遍，零命中。
- **两处词表外的漏网**（本轮全历史普查才抓到，已修 + 已写进仓外词表）：
  ① `coords/README.md` 里两个指向作者公司域名的原型页面链接（路径里含**真实客户名的拼音**）；
  ② `lib/client.js` 里一处随机子域的私有产物站（当初是当界面设计参考抄下来的）。
- **订正数字**：§5.1 里工程图客户端套件写成 17 条，实测 **20** 条；README 的"当前版本"一直停在 v0.8.1，
  已补上 v0.8.2 ~ v0.9.5 的概览（见 §10.2）。

**契约变更（会咬到老用户的两条，写清楚）**

- **包身份统一成 `dsh-workdesktop`**：`cordis.patch.yml` 的 `insert[].name`、浏览器半段注册的 `id`、
  以及侧边栏 tab 类型前缀（`console` / `dashboard` / `project-graph` / `workspaces` 四类）全部跟包名对齐。
  ⇒ **已存的席位偏好会失配一次**；profile 的 `dsh.profile.bundles` 里若写的还是旧名，按
  [v0.9.6 的 Release 说明](https://github.com/jorinyang/dsh-workdesktop/releases/tag/v0.9.6) 里的对照改。
- **当时（0.9.6）没改、0.9.7 已补齐的三处**：环境变量前缀、host 路由前缀、DOM 钩子。
  0.9.6 当时的理由是"运行期契约，改了要重配"；**这个理由随后被推翻**（用户 2026-10-03 裁定
  "为何会有不一致？需要一致统一"）⇒ 见 [v0.9.7 的 Release 说明](https://github.com/jorinyang/dsh-workdesktop/releases/tag/v0.9.7)。
  **本 tag 的文件在随后的全历史二次改写中已一并换成新前缀**，所以读这一版时以 §4 / §5 里的新名字为准。

**升级**

1. 历史被重写过 ⇒ **老的 clone 请重新 clone**，别在旧 clone 上硬拉。
2. profile 里若把本包挂在旧名下，按新名重挂一次（`dsh plugin --profile <name> remove …` + `add …`），
   并把 `dsh.profile.bundles` 里的旧条目改成 `dsh-workdesktop`。
3. 重启 DSH（host 半段改动要重启；client 半段刷新页面即可）。侧边栏的席位偏好重新选一遍。

**验证**

- 本仓自测 `node selftest.mjs` **39/0**（含脱敏守卫与它的负向对照）。
- 工程图：席位/顺序契约 **20/0** · `.prg` 文档容器编解码 **22/0**（+3 SKIP，要上游 CLI）—— 两条都进了 CI。
- coords：产物一致性 + host **26/0** + 浏览器 **30/0** —— 三条都进了 CI（见 §8 的表）。
- 仓库外权威反扫：对**仓内全部文本文件**零命中；改写后对**每一个 tag** 的检出再扫一遍，同样零命中。

---

### 10.2 v0.8.2 ~ v0.9.5 · 间隔版本（一句话一版）

这几版的 README 没跟上（概览一直停在 v0.8.1），补一张索引表 —— 细节在各自 Release 里：

| 版本 | 一句话 | Release |
|---|---|---|
| v0.9.5 | 修框选偏移（marquee 按画布原点算，不再偏一个原点） | <https://github.com/jorinyang/dsh-workdesktop/releases/tag/v0.9.5> |
| v0.9.4 | 扩展实体点击 | <https://github.com/jorinyang/dsh-workdesktop/releases/tag/v0.9.4> |
| v0.9.3 | 涂鸦笔迹 + 右键拖动剪断 | <https://github.com/jorinyang/dsh-workdesktop/releases/tag/v0.9.3> |
| v0.9.2 | 图片节点：附件被服务、渲染、等比缩放 | <https://github.com/jorinyang/dsh-workdesktop/releases/tag/v0.9.2> |
| v0.9.1 | 剪刀：划一条线剪断连线 | <https://github.com/jorinyang/dsh-workdesktop/releases/tag/v0.9.1> |
| v0.9.0 | 工程图面板变成真画布（选中 / 移动 / 框选 / 右键菜单 / 连线 / 分区 / 缩放 / 撤销 / 层序） | <https://github.com/jorinyang/dsh-workdesktop/releases/tag/v0.9.0> |
| v0.8.2 | 工程图 MCP：覆盖文档内容的全部操作（29 条上游工具全开 + 文档容器层 4 条 + 元工具 9 条 = 42 条） | <https://github.com/jorinyang/dsh-workdesktop/releases/tag/v0.8.2> |

---

### 10.3 v0.8.1 · 对外 MCP server

补上 v0.8.0 里缺的那半边：**工程图现在也对外提供一个 MCP server**，DSH 的 MCP 客户端
可以直接连上，用标准 MCP 工具调用建 / 改 / 删工程图内容。

**新增**

- `pg-helper/project-graph-mcp.mjs` —— **零依赖**手写的 stdio MCP server，9 条工具：
  `pg_status` · `pg_projects` · `pg_create` · `pg_rename` · `pg_delete` ·
  `pg_tools` · `pg_describe` · `pg_graph` · `pg_invoke`。前缀 `mcp__project_graph__`。
  底下走**同一条上游 CLI** —— MCP 面、agent 工具 `project_graph`、面板按钮三者是同一批动作。
- `pg-helper/verify-project-graph-mcp.mjs` —— **拿官方 SDK 客户端当对手**的一致性套件（19 条）：
  握手 / 版本协商 / `tools/list` / `tools/call` 全走 `@modelcontextprotocol/client` v2.0.0
  （DSH 自己用的就是它）。自己写客户端只能证明自说自话，这条不算数。

**为什么手写而不是用官方 SDK**：它要被 DSH 以 `command: <node.exe> args: [<绝对路径>]` 直接 spawn，
而官方 SDK 装在 DSH 自己的检出里，从这个文件的位置**解析不到**；本项目的插件纪律也是"只用 `node:` 内置"。

**怎么挂**（profile 层，进程级挂载一次 ⇒ 所有会话都能用）：

```yaml
- insert:
    - id: mcp-project-graph
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: project_graph
        transport: stdio
        command: !!js process.execPath
        args: ['<绝对路径>/pg-helper/project-graph-mcp.mjs']
        env:
          DSH_WORKDESKTOP_PROJECT_GRAPH_REPO: '<上游检出>'
          DSH_WORKDESKTOP_PROJECT_GRAPH_DIR: '<工作区>'
        toolCallTimeoutMs: 180000
```

（`command` 用 `process.execPath` 是沿用本机 firecrawl / kb 两条已经踩过的坑：
`npx` → ENOENT、`npx.cmd` → EINVAL，只有"node + 脚本绝对路径"这条路通。
`env` 要给全，因为 MCP 客户端传给子进程的环境是**清洗过再合并**的。）

**验证**：MCP 一致性 **19/0**（官方 SDK 客户端）；仓库自测 `node selftest.mjs` **39/0**
（脱敏扫描现在是 18 个文件，两个新文件都在扫的范围内）。

---

### 10.4 v0.8.0 · 第五个工作台「工程图」

本轮一件事：**加入第五个工作台「工程图」**（Project Graph）。

**新增**

- **「工程图」席位**：官方右侧栏的 tab 类型 `dsh-workdesktop:project-graph`；左侧栏底部那行图标
  从四行变**五行**，工程图排在「坐标系」下方、「建模中心」上方（用户 2026-10-03 裁定的**顺序契约**，
  由 `selftest-project-graph-client.mjs` 的 `PGC-1/PGC-2/PGC-2b` 守着）。图标是"左二右一"的汇
  （两个圆点汇入一个方框），与「建模中心」的树形分得开；指南页入口卡的底板取青色 `rgb(32,148,143)`。
- **面板**：选工程 / 新建 / 删除 / 刷新；SVG 画布（拖拽平移、滚轮缩放，自动适配外接框）把
  `get_all_nodes` 的对象画成节点与连线（`LineEdge` 按 `sourceRef`→`targetRef` 连）；点对象进检视器，
  可改文字 / 删除 / 在它下面长一棵子树；所有动作都经 `/workdesktop/api/pg/invoke` 调**上游 CLI**。
- **agent 工具 `project_graph`**：把上游那 29 条内置工具原样开给会话（`tools` 看清单 →
  `describe` 看 schema → `invoke` 执行），外加 `projects` / `create` / `rename` / `delete` / `graph` / `open` / `status`。
- **`pg-helper/`**：上游 CLI 需要一份原生「所有权 helper」（独占 `.prg` + 读写 `n1`/`e1` 引用存储），
  本仓库带**同协议的 C# 等价实现**（源码入库、运行前用系统自带 `csc.exe` 现编，**不放二进制**），
  外加空工程模板与四个离线自测脚本。

**边界（写清楚，不假装）**：上游把 29 条工具分成"关闭态 19 条 / 打开态 10 条"。
`create_text_node` 等 10 条声明了 `viewport` 或 `selection`，只有桌面端开着才有，关闭态回
`PROJECT_MUST_BE_OPEN` —— 本插件**原样透传**这个错误码。关闭态下"新建节点"的正路是**树扩展**
（空工程模板预置了一个根节点，`expand_node_tree_from_node` / `breadth_expand_node` /
`depth_expand_node` 都不需要 viewport）。详见 §5.1。

**验证**：发布仓自测 `node selftest.mjs` **39/0**（在 v0.7.0 那四组之外新增 `L5-1`：
工程图席位契约 17 条断言；脱敏扫描的扩展名集合加入 `.cs` ⇒ 扫 16 个文件、零命中）。
另有四套**不进 CI** 的离线套件（要上游检出 / Windows / csc）：路由真跑 28/0 ·
上游 CLI 的读建改连删 31/0 · helper 行协议 15/0 · 席位契约 17/0 —— 命令见 §5.1。
（席位契约那一套现在是 **20** 条，见 §5.1 与 §10 的"订正数字"。）

**升级注意**：① 要先把上游 project-graph clone 下来并 `pnpm install`（`DSH_WORKDESKTOP_PROJECT_GRAPH_REPO` 指过去）；
② 首次用跑一次 `node pg-helper/setup-workspace.mjs`；③ host 半体改动**要重启 DSH**，client 半体刷新页面即可；
④ 没装上游时其余卡片与面板**不受影响** —— 工程图那一栏会逐条写出缺的是哪一样。

### 10.5 v0.7.0（更早一版）

本轮三件事：**开工前先看进度**（首屏载入画面）· **给面板起了名字「弈枢」并配了一张名称图** · **详情页按"人话在前、机器字段收进折叠"重排**；另外修掉四个真机抓到的缺陷，其中一个是**一打开详情页就把整块面板带走**的崩溃。

**新增**

- **首屏载入画面**：面板在"读完外部数据"之前只显示一条进度条 —— 宽 = 侧边栏那一列的 **60%**、高 = 屏幕高 **1%**，条上一段从左到右的扫光（**只扫已经加载出来的那一段**，未加载部分不动）；上方居中「工作台正在启动，请稍后……」，下方左「正在加载：XXX」右「已读 / 总数」，最下面一个「先查看已有信息」按钮。规则：只盖**首次**那批取数（后端 30s/60s 轮询不会重新盖）；一项读**失败**也算有了交代、不挡人；**20 秒**还没齐就放行并如实写"还有 N 项没回来"；本页第一次开门时**至少露面 0.9 秒**（数据秒回也不至于闪一下）；宿主重挂面板（切页签回来）**不再走这一屏**，直接出界面。
- **名称「弈枢」**：启动页进度条上方与卡头「工作台」左侧各一处。图是**透明底的水墨字**，在 CSS 里当遮罩用（`mask-image` + 主题令牌给颜色）⇒ 换纸色/深色纸都不用换图；两处按原图比例显示为 132×66 与 46×23。生成方式、提示词与抠底脚本都在 `assets/` 里，可复跑。
- **详情页"人话在前"**：各详情页里**机器字段（id / 计数 / 口径 / payload 原样）收进「技术细节」折叠**、默认收起；人话与可点出处留在明面。字段仍在 DOM 里（可检索、可核对），套件按 `data-*` 与固定标题定位的锚点一个没动。

**修正**

- **详情页一打开就把面板整块带走**（开发期真机抓到）：折叠容器 `techFold` 定义在 apply 作用域，里面却用了**只存在于组件里**的 `h` 别名 ⇒ 任何用到折叠的详情页一打开就 `ReferenceError`，整个右栏 slot entry 崩掉（真机一轮里表现为"点一行什么都没发生"+ 一片连带红）。已改为 `React.createElement`，并补了源码级守卫（自测 `CL-25`：apply 作用域里不许裸用 `h`，带负向对照）。
- **首帧卡片挤成一行四张**：载入画面开门那一帧去量画布，量到的是 **0 宽**，而卡片宽度是按"画布百分之多少"算的 ⇒ 退回 25% 的兜底值。改成**绘制之前量**（layout effect）+ **量到 0 就补量**。
- **进度条在宿主重挂时永远走不完**：20 秒上限原来按"每个组件实例"计时，重挂就重新计时；改成从**本页第一个实例**算起。
- **简报卡 tab 的死 CSS**：tab 上的计数徽标撤掉后，皮肤里那条按 `.dshw-btab i` 写的规则没删干净（真机 T16-169 守着，现已拆开、只留仍在用的 `.dshw-mtab i`）。
- **关系表 / 记分卡产物过期**：按当前输入重新派生（`build-relations.mjs` / `build-s-metrics.mjs`），两个套件（P2 / T18）随之转绿。

**验证**（发布仓自测 `node selftest.mjs` **38/0**：在 v0.6.0 那四组契约之外新增 `L3-splash` / `L3-nameplate` / `L3-detail-human-first` / `L3-canvas-measure`；脱敏扫描零命中，含人造敏感串的负向对照）。真机面板套件 SBT 的当轮读数与余下红的逐条定性见 §11 的发布记录。

**已知限制**：① 新路由与 host 半体的其它改动都要**重启 DSH** 才生效（client 半体刷新页面即可）；② 草稿引擎本身在你自己的知识库里，本仓库不含它 —— 没有它时那条路由会**如实报错**，不会假装起草成功；③ 采集类卡片依赖本机 `dws` / `lark-cli`；④ 名称图是位图（换主题色不用换图，换字形要重新生成，见 `assets/`）。

上一版（v0.6.0）：席位迁进 DSH 自带两条栏 · 卡片尺寸两档（网格 5% / 无级）+ 拖动跟手与松手吸附 · 卡内小卡片按宽度 1/2/3/4 自适应 · 听记 → 事务草稿接线 —— [`Release v0.6.0`](https://github.com/jorinyang/dsh-workdesktop/releases/tag/v0.6.0)；更早的 [`Release v0.5.0`](https://github.com/jorinyang/dsh-workdesktop/releases/tag/v0.5.0) · [`Release v0.4.0`](https://github.com/jorinyang/dsh-workdesktop/releases/tag/v0.4.0) · [`Release v0.3.0`](https://github.com/jorinyang/dsh-workdesktop/releases/tag/v0.3.0)。

---

## 11. 版本与同步来源

本仓库是**从作者私有的知识库工作台里抽取出的插件本体**，经过脱敏后发布。发布不是手改，而是
"复制 → 逐条替换（每条断言命中次数）→ 反扫（命中必须为 0）→ 克隆复验"的固定流程；
**权威脱敏词表与全套流水线脚本都留在仓库外**，因此仓库内的守卫只做结构性规则（见 §8）。

| 环节 | 做什么 | 在哪 |
|---|---|---|
| ① 复制 | 从私有源把要发布的文件抄进本仓 | 仓外 |
| ② 逐条替换 | **每条替换断言命中次数**，对不上就退出；替换完再自证"必须消失的词一个不剩" | 仓外脚本 + 仓外词表 |
| ③ 反扫 | 用仓外权威词表扫**仓内全部文本文件**，命中必须为 **0** | 仓外 |
| ④ 身份串统一 | 包 / bundle / 客户端注册 id / tab 前缀一律对齐 `package.json` 的 `name` | 仓外 |
| ⑤ 全历史改写 | `git filter-repo`：分支与**全部 tag** 一起重写（不只 HEAD） | 一次性 |

#### 本轮同步记录（2026-10-03 · 第二轮：三处补齐 + 历史二次改写）

| 源（库内插件） | 源指纹 | 本仓产物 | 产物指纹（二次改写后） |
|---------------|--------|---------|----------------------|
| `lib/index.js` | `3401DF9CCEADA330` | `lib/index.js` | `55ACDB42520DD476` |
| `lib/client.js` | `3FA2500CB0EE1E77` | `lib/client.js` | `E9F1C459A2E927B8` |
| `coords/src/*` | 与 `coords/lib/*` 同源 | `coords/lib/{index,client}.js` | 构建产物，`build.mjs --check` 守一致性（§5.2） |

**源指纹三次采样都没变**（`3401DF9CCEADA330` / `3FA2500CB0EE1E77`）：私有源一次没动过，动的一直是本仓这一侧 ——
第一轮补做脱敏 + 统一包名，第二轮把环境变量前缀、API 路由前缀、DOM 钩子也统一掉，并**再改写一次全历史**。
所以产物指纹每一轮都不一样，而且**永远不该**等于源指纹（"逐字节相同"正是 0.9.6 之前那个缺陷本身）。

> **脱敏口径（2026-10-03 起）**：替换步骤是**逐条断言命中次数 + 替换后自证**；反扫用**仓外权威词表**扫仓内
> 全部文本文件（含 3 个二进制文件的旁路扫描）；**替换用的词表与反扫用的词表是同一份**（此前两份，
> 全历史普查正是在那个缝里抓到两处漏网）。**改名的规则也在同一份词表里**，所以每次同步都会自动改名，
> 不会出现"改了包名、忘了环境变量"这种半截状态。
> 历史（哪几版带着什么、怎么改的）不在这份公开 README 里展开，记在内部交接说明。

对应本仓库版本 **0.9.7**（**五个工作台** · 对外 MCP server（42 条工具）· 13 张卡 · 三带布局 · 面板在 DSH **自带右侧栏**的席位 + 左侧栏入口 · **首屏载入画面** · 名称「弈枢」+ 水墨名称图（CSS 遮罩，随主题令牌变色）· **详情页"人话在前"**（机器字段收进「技术细节」折叠）· 卡片尺寸两档 + 拖动跟手/松手吸附动画 + 卡内小卡片按宽度 1/2/3/4 自适应 · 听记 → 事务草稿 · 纸墨外观 · 长按拖动排序 + `ui-prefs` 覆盖层 · 卡内只读透传 + 三条"不许静默"出口 · 工程图画布（选中/移动/框选/连线/分区/撤销/层序）· 工程图文档容器层（`pg_document` / `pg_locate` / `pg_move_node` / `pg_set_details`）· 同仓第二个包 `dsh-coords`）。**README 里的卡片数与顺序对应当前同步进来的这份源码**（`CARD_ORDER` 13 键）；**发布仓与源项目此后会各自演进**：再次同步请重跑上面的固定流程，不要手工编辑本仓库的 `lib/`。

### 发布清单（照这个顺序做，**只打 tag 不算发布**）

1. 复制 `lib/index.js` · `lib/client.js`（本版起还有 `assets/`）进本仓库，按上面的固定流程脱敏：**逐条替换（脚本对每条替换断言命中次数，对不上直接退出）→ 反扫（命中必须为 0）**。反扫的覆盖范围是仓库里**全部文本文件**（本轮实测 **53 个**：`.js` / `.mjs` / `.cjs` / `.json` / `.md` / `.yml` / `.py` / `.cs` / `.txt` / `.editorconfig` / `.gitignore`）**加 3 个二进制文件的旁路扫描**（两张 PNG + `empty-project.prg`，做法是逐字节找词表，不按"有 NUL 就当二进制跳过"）；`lib/` 两半体、`coords/` 整包、`pg-helper/`、`assets/`、`selftest/fixtures/`、README 与两份 `package.json`、`cordis.patch.yml` 都在内。**再确认一遍身份串**：`package.json` 的 `name`、`cordis.patch.yml` 的 `insert[].name`、`lib/client.js` 注册的 `id` 与 tab 前缀四处必须一致。
2. `node selftest.mjs` ⇒ 必须全绿（CI 也会跑一遍）。
3. 改 `package.json` 版本号 + 更新本节的两处指纹 + §10 的更新概览。
4. 提交 → **打 tag** → push（分支与 tag 都要推）。
   ⚠️ **tag 一经发布就不再移动**（2026-10-03 用户裁定）。发现要改的，**向前发新版本**，
   绝不用 `git tag -f` 把已发布的 tag 指到别的提交 —— 别人可能已经按那个 tag 拉过代码。
   （`git push --force origin --tags` 只允许出现在"**全历史改写**"这种把每个 tag 都整体平移的场合，
   见第 7 条，而且必须一次把所有 tag 一起推平。）
5. **建 GitHub Release**（`gh release create <tag> --notes-file <说明>`），正文写清新增 / 修正 / 契约变更 / 升级 / 验证 / 已知限制。
6. 核对 `gh release list`：每一版都该有 Release，最新一版标 `Latest`；README 里引用的链接必须真的能打开。
7. **改过已发布的历史时**（比如 2026-10-03 那两轮）：先 `git clone --mirror` 到仓外整仓备份 → 本地全绿 → `git filter-repo` 改写 →
   **逐 tag 检出再反扫一遍** → 强推分支与全部 tag → 核对 `git ls-remote` 与 `gh release list`。
   注意：全历史改写会让**每个 tag 的提交哈希都变**（这是它应有的效果，不是"移动 tag"）；
   改完要逐条确认每个 Release 的同名 tag 仍解析得到，别留下错位的 Release。
8. **旧对象不会因为强推就消失**：GitHub 上按**精确 SHA** 仍可能取到改写前的提交。
   要彻底清，得向 GitHub Support 提工单请求清理不可达对象（文本与路径见内部交接说明 §21）。

> 脱敏口径补记（2026-09-27，2026-10-03 收紧）：清单第 1 步的"命中必须为 0"，**早期几版用的口径更松** ——
> 有一批**相对路径**当时按"不算敏感"放行，而 README 里同时写着"0 命中"，属自相矛盾。
> 现在的口径是**逐条断言命中次数 + 替换后自证 + 仓外权威反扫**三件套，以反扫的读数为准，
> 不再用"这类看着不算敏感"的判断去替代它。

> 教训（2026-09-24）：**v0.4.0 当时只打了 tag、没建 Release** —— README 里写着这一版的更新概览，GitHub 上却没有对应 Release，是发布流程第 5 步漏了。已补建，并把这一步写进清单。

### 发布记录

| 版本 | Release |
|---|---|
| v0.9.7 | <https://github.com/jorinyang/dsh-workdesktop/releases/tag/v0.9.7> |
| v0.9.6 | <https://github.com/jorinyang/dsh-workdesktop/releases/tag/v0.9.6> |
| v0.9.5 | <https://github.com/jorinyang/dsh-workdesktop/releases/tag/v0.9.5> |
| v0.9.4 | <https://github.com/jorinyang/dsh-workdesktop/releases/tag/v0.9.4> |
| v0.9.3 | <https://github.com/jorinyang/dsh-workdesktop/releases/tag/v0.9.3> |
| v0.9.2 | <https://github.com/jorinyang/dsh-workdesktop/releases/tag/v0.9.2> |
| v0.9.1 | <https://github.com/jorinyang/dsh-workdesktop/releases/tag/v0.9.1> |
| v0.9.0 | <https://github.com/jorinyang/dsh-workdesktop/releases/tag/v0.9.0> |
| v0.8.2 | <https://github.com/jorinyang/dsh-workdesktop/releases/tag/v0.8.2> |
| v0.8.1 | <https://github.com/jorinyang/dsh-workdesktop/releases/tag/v0.8.1> |
| v0.8.0 | <https://github.com/jorinyang/dsh-workdesktop/releases/tag/v0.8.0> |
| v0.7.0 | <https://github.com/jorinyang/dsh-workdesktop/releases/tag/v0.7.0> |
| v0.6.0 | <https://github.com/jorinyang/dsh-workdesktop/releases/tag/v0.6.0> |
| v0.5.0 | <https://github.com/jorinyang/dsh-workdesktop/releases/tag/v0.5.0> |
| v0.4.0 | <https://github.com/jorinyang/dsh-workdesktop/releases/tag/v0.4.0>（补建） |
| v0.3.0 | <https://github.com/jorinyang/dsh-workdesktop/releases/tag/v0.3.0> |

> ⚠️ **v0.9.6 那一版的历史被重写过**：v0.3.0 ~ v0.9.5 的 tag 与提交哈希**全部变了**（内容一致、脱敏更干净）。
> 老 clone 请重新 clone；引用旧哈希的笔记/链接要按新哈希更新。

**v0.7.0 当轮真机读数**（作者库内 `verify-sidebar-tab.mjs`，本轮**有效**：跑期被测源码零写入、无并发工具在途）：
**155 / 0**，另有 **5 条 SKIP**（每条都写明原因，SKIP 既不算通过也不算产品失败）——
① 本部署**没有 editor 席位**（v0.6.0 起本面板不再依赖第三方侧边栏插件），点文件行会回落成 `POST /open` = `Invoke-Item`，
会在桌面上开一个窗口，故这项默认**不点**、如实记 SKIP；② 两项是面板 JS 与探针不同世界导致的环境前置不成立（已由 Node 级对照覆盖）；
③ 一项是「决策」卡三档 tab 当日均 0 条、没有可点的一行。
另有两条红**属别的线或环境，未代签**：一条是右侧栏面板被另一个插件（坐标系）顶掉（切走再切回即消失），
一条是四个不属于本线的套件尚未确认。**本仓库自测 38/0 与上面的真机读数是两件事**：前者在克隆体里离线跑，后者需要真实 DSH 运行时。

---

## 12. 许可

MIT —— 见 `LICENSE`。
