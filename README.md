# dsh-workdesktop

> A local-first **workbench panel** for [DeepSeek Harness](https://github.com/) (DSH) — a Cordis plugin that renders one sidebar tab with 13 live cards: system/device status, calendar & todos pulled from your local CLIs, recent recordings, your local knowledge base, and an **object-centric layer** (disposition ledger + cross-source checks).

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

## 5. 13 张卡 / 主要路由

卡片（顺序即面板渲染顺序）：事务 · 待响应触发 · 日程 · 待办 · 专注 · 活跃关注域 · 流入处置 · 唤起·沉淀复利 · **在场对象** · 验收指标 · 知识库 · 近期听记 · 系统状态。

host 路由（均在 `/workbench/api` 下）：

| 路由 | 方法 | 读/写 | 说明 |
|------|------|-------|------|
| `/snapshot` | GET | 只读 | 日程 / 待办 / 知识库 / 听记（跑本机 CLI） |
| `/state` | GET | 只读 | 面板主数据（多产物聚合） |
| `/objects` | GET | 只读 | 业务对象索引（按"事"聚合） |
| `/disposition` | GET | 只读 | 处置台账（判定 → 落点 → 悬置时长） |
| `/crosscheck` | GET | 只读 | 多源校验（溯源 / 支撑强度 / 计划↔实际 / 矛盾） |
| `/domain-health` | GET | 只读 | 关注域健康度 |
| `/dashboard` | GET | 只读 | 库内自包含 HTML 快照 |
| `/sysstatus` `/activity` | GET | 只读 | 系统在线状态 / 实时活动 |
| `/event` `/open` | GET/POST | 只读/打开 | 事件详情、打开文件 |
| `/matter` `/matter/record` `/matter/check` `/matter/close` `/matter/reopen` | GET/POST | 读+写 | 事务详情与写通道（写入交给库内 CLI） |
| `/focus` | GET/POST | 读+写 | 专注块 |
| `/active-domains` | GET | 读+写 | 活跃关注域（`?match=1` 触发一次匹配） |
| `/rebuild` | POST | 写 | 幂等重建库内快照 |
| `/disposition/act` | POST | 写 | 待议流入处置（**目前 API-only，无 UI 控件**） |

agent 工具：`workbench_todo` · `workbench_focus` · `workbench_active_domains` · `workbench_matter`。

---

## 6. 数据从哪来（重要）

面板**不生产数据**。它读的是知识库目录里的产物（`_meta/out/*.json`：`snapshot.json`、`matters.json`、`triggers.json`、`objects.json`、`disposition.json`、`crosscheck.json`、`s-metrics.json` 等），这些产物由**你自己的库内管线**生成。

所以：**没有配套的库内管线，卡片会显示为空或"不可用"** —— 这是设计使然，不是 bug。

---

## 7. 已知限制（诚实清单）

- **依赖库内产物与目录约定**（`Work/<客户>/…`、`_meta/out/*.json`）。这些约定不随本仓库发布。
- **Windows 偏向**：采集脚本是 PowerShell 5.1；`dws` / `lark-cli` 缺失时相关卡片显示不可用。
- **无测试**：本仓库不含测试套件（原项目的验收套件与真实数据夹具未发布）。
- **部分路由无 UI 消费方**：`/domain-health`、`/disposition/act`（以及 `/focus` GET）目前只提供 API。
- **指标口径**：所有阈值/时限默认标注"未校准"（`calibrated: false`），面板只展示、不做考核。
- **未发布的开关**：原实现里有若干环境变量（如自测隔离开关）只在特定部署下使用。
- 本插件为**个人工作台**性质，未做多用户/权限模型；请只在**本机**使用（host 绑定 127.0.0.1）。

---

## 8. 开发

```bash
node --check lib/index.js   # host 半体语法
node --check lib/client.js  # 浏览器半体语法
```

约定：

- **编码必须是 UTF-8（无 BOM）**。本仓库发生过一次真实事故：源码被"UTF-8 字节按 GBK 解读后再存成 UTF-8"，导致 840 处字符丢失、84 处换行被吞、语法错误 —— 表面却仍像正常文件。见 `.editorconfig`。
- 改 host 半体需**重启 DSH** 才生效；改 client 半体**刷新页面**即可。
- 卡片新增/改序必须同时改三处声明：`CARD_ORDER`（客户端）、源码级顺序断言、真机级顺序断言；否则顺序会静默漂移。

---

## 9. 许可

MIT —— 见 `LICENSE`。
