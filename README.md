# dsh-workdesktop

> A local-first **workbench panel** for [DeepSeek Harness](https://github.com/) (DSH) — a Cordis plugin that renders one sidebar tab with 15 live cards: a decision surface, commitments awaiting response, matters, calendar & todos pulled from your local CLIs, recent recordings, your local knowledge base, and an **object-centric layer** (disposition ledger + cross-source checks).

本仓库只包含**插件本体**（host 半体 + 浏览器半体）。它**不含任何数据**：所有内容都来自你本机的知识库目录，路径由环境变量指定。

---

## 1. 它是什么

一个 Cordis 插件包，两个半体：

| 半体 | 文件 | 运行位置 | 职责 |
|------|------|---------|------|
| host | `lib/index.js` | DSH 的 Node 进程 | 挂载 `/workbench/api/*` 只读路由、注册 4 个 agent 工具、跑本机 CLI 采集 |
| client | `lib/client.js` | 浏览器页面 | 在侧边栏注册「工作台」tab，渲染 15 张卡片，按需轮询 host |

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
  该插件 0.19.1 引入了新的 peer 依赖要求（`^0.1.5-rc.1`）；在 `0.1.x-alpha.*` 的宿主上，实测会**整条侧边栏渲染崩溃**（`React error #130`，tab 条直接消失，不只是本面板）。
  处理办法：把依赖**精确钉住**到可用版本，别用 `@latest`：

  ```jsonc
  // <profile>/package.json
  "dsh-better-sidebar": "0.18.1"   // 不要写 ^0.19.1，也不要写 latest
  ```
  （关于崩溃机制：peer 不满足是市场日志给出的兼容性告警；0.18.1 同样不满足该 peer 却可用，所以"peer 不满足 ⇒ 必崩"只是推断，尚未证实——如实标注。）

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
| `DSH_WORKBENCH_KNOWLEDGE` | **是** | 无 | 你的知识库根目录（需含 `_meta/out/` 等产物）。**未设置时 host 直接抛错**，不做任何静默回落 |
| `DSH_WORKBENCH_HERMES_URL` | 否 | `http://127.0.0.1:8787` | 本机 hermes 类服务的地址 |
| `DSH_WORKBENCH_CACHE_MS` | 否 | `120000` | 快照缓存时长（毫秒） |
| `DSH_WORKBENCH_POWERSHELL` | 否 | 系统 PowerShell 5.1 | 采集脚本用的解释器路径 |

```powershell
# Windows
$env:DSH_WORKBENCH_KNOWLEDGE = "D:\my-vault"
```
```bash
# macOS / Linux
export DSH_WORKBENCH_KNOWLEDGE="$HOME/my-vault"
```

---

## 5. 15 张卡 / 主要路由

卡片（顺序即面板渲染顺序，三带布局）：
**决策** · **响应** · **事务** · 日程 · 待办 · 专注 · **对象** · **流入** · **跨源洞察** · **资产** · **活跃** · **验收** · 知识库 · 近期听记 · 系统。

> 顺序由代码里的默认表驱动；用户可**长按任意卡片拖动排序**（长按约 400ms 进入拖动，无手柄、无浮层按钮）。同一张卡上，**短按卡片名 = 场景交互**（当前 15 张卡统一为"折叠/展开本卡内容"，再点一次恢复），**长按整卡 = 拖动排序**，两者不会互相吞掉。拖动的结果落在知识库的 `ui-prefs.json`（覆盖层：只影响渲染、不改默认表；未知卡片名被忽略）；面板顶部有一行「恢复默认顺序」文本链接。未登记的卡片始终追加在末尾，不会消失。

其中三张是"按**事**而不是按来源"的：今日决策面（热层：昨夜动向 / 今日必办 / 待定等对方）· 在场对象（一个对象上事务线与触发线并置）· 跨源洞察（每条带证据链、支撑强度与**可反驳入口**，无证据不入面板）。

host 路由（均在 `/workbench/api` 下）：

| 路由 | 方法 | 读/写 | 说明 |
|------|------|-------|------|
| `/snapshot` | GET | 只读 | 日程 / 待办 / 知识库 / 听记（跑本机 CLI） |
| `/state` | GET | 只读 | 面板主数据（多产物聚合） |
| `/objects` | GET | 只读 | 业务对象索引（按"事"聚合） |
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
| `/triggers` | GET | 只读 | 响应清单（触发详情） |
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

它自带一份**中性 fixture**（`selftest/fixtures/_meta/out/*.json`：`objects` / `disposition` / `crosscheck` / `domain-health` / `brief` / `insights`，全部是 `示例客户` / `组织甲` / `MT-20250101-001` 这类虚构示例），并在四个层面给出证据：

| 组 | 证明什么 |
|----|---------|
| **1 路由真跑** | 用桩 `ctx`（捕获 `webServer.register`）挂载 host 半体，用假 `req`/`res` 调 `/objects`、`/disposition`、`/crosscheck`、`/domain-health`、`/brief`、`/insights` → 断言 **200 + 面板实际消费的字段**（`objects[].key/state/next_step`、`disposition.summary.{landed,noLanding,landingRate}`、`crosscheck.trace/multiSource/contradictions`、`brief.todayMustDo/waiting/overnight`、`insights[].evidence/support/rebuttal` 等）；另有三条**"不许静默"**断言：台账未生成必须 **503 + 明确文案**、`/focus` GET 必须是 **410 墓碑**、`/disposition/act` 的三类非法入参必须在**调用库内 CLI 之前**被拒（这也是它能在克隆体里被断言的原因） |
| **2 配置缺失必须响** | 不设 `DSH_WORKBENCH_KNOWLEDGE` 时 import **直接抛错**并点名该变量；断言错误信息里**没有**任何硬编码的个人路径（不允许静默回落到某人的桌面） |
| **3 源码契约** | 两半体语法通过 · `CARD_ORDER` 存在且 **15 张卡顺序可断言**（顺序是产品承诺，不能是执行顺序的副产品）· `package.json` 元数据正确 |
| **4 脱敏守卫** | 仓库**扫描自己**：个人绝对路径 / 邮箱 / 手机号 / 凭据形态 / URL 里的令牌 ⇒ **0 命中**；**带负向对照**（人造敏感串必须被抓到，否则"全绿"毫无意义）· 并断言 fixture 里每个 `Work/<目录>/` 都来自中性示例 |

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
- 卡片新增/改序必须同时改三处声明：`CARD_ORDER`（客户端）、源码级顺序断言、真机级顺序断言；否则顺序会静默漂移。

---

## 10. 更新概览 · v0.3.0

本轮是**交互层的一次统一**：把 15 张卡的呈现与操作收敛成同一套契约，并给"顺序"和"详情"补上可断言的落点。

- **卡片统一为两行结构**：第一行左=卡片名（**可点击**，触发场景交互）/ 中=关键指标（原样取自产物）/ 右=动作按钮；第二行起=同域折叠 + 列表。初版曾按"三行结构"实现（多一行分类说明），已按反馈移除该行，断言同步翻转为"该行不得存在"。
- **两类交互职责分开**：点卡片名只改变"这张卡此刻怎么呈现"（如专注态折叠/展开），**不写数据、不跳转**；右上按钮才做与数据/状态有关的操作。两者必须共存——长按卡名 ≥400ms 进拖动、短按 <400ms 折叠，靠"真拖过之后在捕获阶段抑制那一次 click"实现，并各有负向对照守着。
- **长按整卡拖动排序**：顺序落盘为 `ui-prefs.json` **覆盖层**（`GET/POST/DELETE /ui-prefs`）。默认顺序在 client 的 `CARD_ORDER`（契约、被断言），覆盖层只影响渲染：未知 key 忽略、未覆盖的按默认补末尾、「恢复默认」一键清空。
- **通用详情页 + 穿透规则**：标题 / 关键洞察 / 详细情况 / 关联域 / 业务关系（信息·日程·待办·对象·知识库·听记）/ 前序环节 / 后续环节 / 操作按钮；**不适用就整块不出现**（不留空区块）；只有路径与 URL 可点，打不开必须给原因。
- **新增路由**：`GET /triggers`、`POST /trigger/respond`、`POST /trigger/act`、`POST /trigger/to-matter`、`POST /todo/act`、`POST /matter/reschedule`、`POST /active-domains`、`GET|POST|DELETE /ui-prefs`。写入口仍显式列出，其余只读透传。
- **selftest 加厚**：补 `/ui-prefs` 五条断言，并断言 **host 键表 ↔ client `CARD_ORDER` 逐项一致**（防"拖到新位置的卡被静默丢弃"这类问题）。

完整说明见 [Release v0.3.0](https://github.com/jorinyang/dsh-workdesktop/releases/tag/v0.3.0)。

---

## 11. 版本与同步来源

本仓库是**从作者私有的知识库工作台里抽取出的插件本体**，经过脱敏后发布。发布不是手改，而是"复制 → 逐条替换（每条断言命中次数）→ 反扫（命中必须为 0）→ 克隆复验"的固定流程；权威脱敏词表留在仓库外，因此仓库内的守卫只做结构性规则（见 §8）。同步时记录的源文件指纹：

| 源（库内插件） | SHA256 前 16 位 |
|---------------|----------------|
| `lib/index.js` | `22718127106b5d51` |
| `lib/client.js` | `aaeed38af4994303` |

（上表是**同步时的源指纹**；对应的脱敏产物指纹为 `index.js 948519755775ad36` · `client.js e83c7d4cc1e6ae89`，写入 `dsh-sync-shas.json` 与脱敏报告，便于判断本发布仓落后库内多少。）

对应本仓库版本 **0.3.0**（15 张卡 · 三带布局 · 长按拖动排序 + `ui-prefs` 覆盖层 · 卡片名=场景交互 · 通用二级/三级详情页 · 六个库内产物只读透传 + 三条"不许静默"出口）。**发布仓与源项目此后会各自演进**：再次同步请重跑上面的固定流程（同步脚本会打印新旧指纹），不要手工编辑本仓库的 `lib/`。

---

## 12. 许可

MIT —— 见 `LICENSE`。
