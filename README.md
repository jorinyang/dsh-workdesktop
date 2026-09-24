# dsh-workdesktop

> A local-first **workbench panel** for [DeepSeek Harness](https://github.com/) (DSH) — a Cordis plugin that renders one sidebar tab with 13 live cards: a decision surface, commitments awaiting response, matters, calendar & todos pulled from your local CLIs, recent recordings, your local knowledge base, and a **cross-source insight layer** (disposition ledger + cross-source checks).

本仓库只包含**插件本体**（host 半体 + 浏览器半体）。它**不含任何数据**：所有内容都来自你本机的知识库目录，路径由环境变量指定。

---

## 1. 它是什么

一个 Cordis 插件包，两个半体：

| 半体 | 文件 | 运行位置 | 职责 |
|------|------|---------|------|
| host | `lib/index.js` | DSH 的 Node 进程 | 挂载 `/workbench/api/*` 只读路由、注册 4 个 agent 工具、跑本机 CLI 采集 |
| client | `lib/client.js` | 浏览器页面 | 在侧边栏注册「工作台」tab，渲染 13 张卡片，按需轮询 host |

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
- ⚠️ **侧边栏插件版本前提（重要）**：本面板注册在 `dsh-better-sidebar` 的 tab 上，**必须用 0.18.x**。
  该插件 0.19.1 引入了新的 peer 依赖要求 `^0.1.5-rc.1`，而**任何 `0.1.x-alpha.*` 宿主都不满足它**（`0.1.x-alpha.N` 低于 `0.1.5-rc.1`）——这是可以按 semver 直接判定的**事实**。
  在一次把 0.18.1 自动升到 0.19.1 之后，页面出现过**整条侧边栏渲染崩溃**（`React error #130`，tab 条直接消失，不只是本面板）；市场自己的 `update-compat` 日志也给出了同一处 peer 告警。
  ⚠️ 但 **"peer 不满足 ⇒ 必然 React #130" 只是推断，不是已证实的因果**：回退到的 0.18.1 **同样不满足**该 peer 却可用。这里只把它当作"别升上去"的充分理由，不当作根因定论。
  处理办法：把依赖**精确钉住**到可用版本，别用 `@latest`：

  ```jsonc
  // <profile>/package.json
  "dsh-better-sidebar": "0.18.1"   // 不要写 ^0.19.1，也不要写 latest
  ```

---

## 3. 安装

```bash
# 在 DSH 里把本包挂到某个 profile（示例为 web profile）
dsh plugin --profile web add <path-to-this-repo>
```

挂载后重启 DSH 进程（host 半体随进程加载），刷新页面即可看到侧边栏的「工作台」tab。

> 本插件内部的 id 仍是 `dsh-workbench`（出现在 `cordis.patch.yml` 与侧边栏 tab id 中），仓库名 `dsh-workdesktop` 只是发布名。

---

## 4. 配置（环境变量）

| 变量 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `DSH_WORKBENCH_KNOWLEDGE` | 否 | `%USERPROFILE%\Desktop\Knowledge`（macOS/Linux 用 `$HOME`） | 你的知识库根目录（需含 `_meta/out/` 等产物）。**设了就用它**；没设则用推导出的默认值，**但该目录必须真实存在**，否则 host 直接抛错并点名这个变量（不静默指到一个不存在的目录） |
| `DSH_WORKBENCH_HERMES_URL` | 否 | `http://127.0.0.1:8787` | 本机 hermes 类服务的地址 |
| `DSH_WORKBENCH_CACHE_MS` | 否 | `120000` | 快照缓存时长（毫秒） |
| `DSH_WORKBENCH_POWERSHELL` | 否 | 系统 PowerShell 5.1 | 采集脚本用的解释器路径 |
| `DSH_WORKBENCH_NODE` | 否 | `process.execPath` | host 调库内 CLI 用的 node |
| `DSH_WORKBENCH_PLUGIN_DIR` | 否 | 本包目录 | 自测套件定位用 |

> **0.5.0 的契约变更**：0.4.0 里 `DSH_WORKBENCH_KNOWLEDGE` 是**必填**（缺就抛错）；现在改成"环境变量优先 + 默认值可用即用 + 默认值不可用即报错"。这样本机开箱即用，换机器/换用户时仍然当场说清该设哪个变量（自测 `L2-1..L2-4` 守这一条）。

```powershell
# Windows
$env:DSH_WORKBENCH_KNOWLEDGE = "D:\my-vault"
```
```bash
# macOS / Linux
export DSH_WORKBENCH_KNOWLEDGE="$HOME/my-vault"
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

其中三张是"按**事**而不是按来源"的：今日决策面（热层：昨夜动向 / 今日必办 / 待定等对方）· 跨源洞察（每条带证据链、支撑强度与**可反驳入口**，无证据不入面板）· 事务（行内直接带归属对象，详情页把对象下一步与出处并置）。

host 路由（均在 `/workbench/api` 下）：

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
| `/rebuild` | POST | 写 | 幂等重建库内快照 |
| `/disposition/act` | POST | 写 | 待议流入处置（面板「流入处置」卡有控件：拒绝/转出 + **理由必填**；host 只做校验与透传，判定在库内 CLI） |

agent 工具：`workbench_todo` · `workbench_focus` · `workbench_active_domains` · `workbench_matter`。

---

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
| **2 配置缺失必须响** | 不设 `DSH_WORKBENCH_KNOWLEDGE` 时 import **直接抛错**并点名该变量；断言错误信息里**没有**任何硬编码的个人路径（不允许静默回落到某人的桌面） |
| **3 源码契约** | 两半体语法通过 · `CARD_ORDER` 存在且 **13 张卡顺序可断言**（顺序是产品承诺，不能是执行顺序的副产品）· host 的 `KNOWN_CARD_KEYS` 与之**逐项一致**（漂移的失败形态是**静默丢卡**）· `package.json` 元数据正确 |
| **4 脱敏守卫** | 仓库**扫描自己**：个人绝对路径 / 邮箱 / 手机号 / 凭据形态 / URL 里的令牌 ⇒ **0 命中**；**带负向对照**（人造敏感串必须被抓到，否则"全绿"毫无意义）· 并断言 fixture 里每个 `Work/<目录>/` 都来自中性示例 |

其中 `/ui-prefs` 一组（`L1-8` ~ `L1-13`）覆盖覆盖层契约：GET 报 **13 个已知键**且无覆盖层时 `exists=false`（不当成空数据）· POST 忽略并回报未知卡片键/未知字段、重复只取首次 · 落盘可读回 · 空写被拒且不写坏既有覆盖层 · **已撤卡键（`objects`）被忽略但其余键照旧生效、顺序不整体回默认** · DELETE 真删文件并回到 `exists=false`。

**它不能证明什么**（别过度解读一次全绿）：不覆盖真实 DSH 运行时与槽位渲染 · 不覆盖浏览器半体交互 · 不覆盖依赖真实 vault 的链路（日程/待办/DSH 工具）· 真实业务词表的**权威脱敏扫描在仓库外**留存，这里只做结构性规则与 fixture 中性性。

> 为什么仓库里保留 `cordis.patch.yml`：它是本包的**安装面**（`package.json` 的 `dsh.bundle.patch` 指向它）。只发 `lib/` 的话别人 clone 下来**装不起来**，自证也就无从谈起。

CI：`.github/workflows/selftest.yml` 在 Linux + Windows × Node 22/24 上跑同一条命令。

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

## 10. 更新概览 · v0.5.0

本轮是**"从能看变成能管"**的一版：给「系统」卡加了三张可点的能力小卡片（四态灯 + 手动开关），把知识库检索接成常驻服务，「响应」卡接上按会话聚合，并把一整轮"守卫自己在说谎"的问题清掉。

**新增**

- **「系统」卡内三张能力小卡片**（实时回复 / 响应功能 / 向量检索）：每张一盏四态灯 + 点一下就切换开关。灯色**只由 host 判定**（开关位 + 计划任务 + 锁内 pid + 消费者心跳 + 检索服务心跳），**抽掉任意一份证据都不许显示在线**；开关是**分支闸**（前两个能力共用一个常驻消费者进程，关一个不影响另一个），打开时幂等拉起、**从不 `/end`**；写入口唯一（`POST /system-switch` → 库内单一写者，host 不碰那个文件）。
- **「响应」卡的「按会话聚合」段**：常驻消费者写的 `auto-reply-ledger.json#threads` 第一次有了面板出口 —— 一行一个**会话**（聚合单位是会话 × 会议实例），带对象 / 渠道 / 条数 / 是否需要人工 / 关联事务，点开看最近往来与判定（无需回复 · 可直接代答 · 需人工已转事务）。取不到台账时如实写"取不到 + 原因"，不冒充"没有会话"。
- **三张能力小卡片的真机断言**：`SBT-11p/11q`（三张卡齐备、可点、状态来自 host）· `SBT-99`（按会话聚合段：段头数字对载荷、行数 == 会话数、点开出现**可见**明细）· `T16-195/196/197/198`（源码面只透传不自算 · 取消台账窗口判定**幂等** · 写口两份缓存都失效）。

**修正（都是"守卫绿着、功能是坏的"这一类）**

- **第三张能力卡的开关点不动**：host 与库内 CLI 各抄了一份能力词表，加第三个能力时都没跟上 ⇒ 现在**词表只有库内一份**，host 把能力名原样转交（`SYS-56/57` 守着）。
- **日程"取消得掉、恢复不回来"**：取消台账在 `/snapshot` 路径上被应用两次，第二次跑到时那条日程已被过滤 ⇒「恢复」入口空。现在窗口判定**以记录自己的 start/end 为准**（幂等；跨天住宿也能恢复），写口同时失效 `/state` 与 `/snapshot` 两份缓存（`T16-197/198` 守着）。
- **常驻服务把"本来就有实例"记成失败**：启动器现在先读服务心跳，已有可用实例就记一行并成功退出（幂等）；**不探 HTTP**（读完即断会让服务端记一堆 `ConnectionResetError`）。
- **登记表守卫空转**：产物登记表生成器自带的 `--check` 一直没被任何套件调用，接上后发现并修掉两处口径错（行号漂移 / 把只在跑期存在的锁算进产物平面）。
- **计划任务不再留黑窗口**：所有控制台类任务改成隐藏启动（`wscript` + `run-hidden.vbs`，窗口样式 0 且**等待**，所以"任务在运行"仍如实反映服务在不在）。

**契约变更（只在 `DSH_WORKBENCH_KNOWLEDGE` 这一项）**

- 0.4.0：缺这个变量就抛错。0.5.0：**环境变量优先**；没设就用推导出的默认值 `%USERPROFILE%\Desktop\Knowledge`，**但该目录必须真实存在**，否则抛错并点名这个变量。⇒ 本机开箱即用，换机器仍然当场说清该设什么（自测 `L2-1..L2-4`）。

上一版（v0.4.0）：撤掉独立的「对象」卡，对象降级为属性并入五处；旧覆盖层里的 `objects` 键被静默忽略且不整体回默认。

---

## 11. 版本与同步来源

本仓库是**从作者私有的知识库工作台里抽取出的插件本体**，经过脱敏后发布。发布不是手改，而是"复制 → 逐条替换（每条断言命中次数）→ 反扫（命中必须为 0）→ 克隆复验"的固定流程；权威脱敏词表留在仓库外，因此仓库内的守卫只做结构性规则（见 §8）。同步时记录的源文件指纹：

| 源（库内插件） | SHA256 前 16 位（2026-09-24 采样） |
|---------------|----------------------------------|
| `lib/index.js` | `9AA05F0BBA03D061` |
| `lib/client.js` | `14E1707AD65E4836` |

（对应的脱敏产物指纹：`index.js 7C994EA777C55A9E` · `client.js 57093B18D38CCE38`。两侧都按"隔 60 秒两次 `mtime`+SHA256 一致"采样。）

对应本仓库版本 **0.5.0**（13 张卡 · 三带布局 · 系统卡三张能力小卡片 + 手动开关 · 响应卡按会话聚合 · 长按拖动排序 + `ui-prefs` 覆盖层 · 卡内只读透传 + 三条"不许静默"出口）。**README 里的卡片数与顺序对应当前同步进来的这份源码**（`CARD_ORDER` 13 键，与上表源指纹同一次采样）；**发布仓与源项目此后会各自演进**：再次同步请重跑上面的固定流程（同步脚本会打印新旧指纹），不要手工编辑本仓库的 `lib/`。

---

## 12. 许可

MIT —— 见 `LICENSE`。
