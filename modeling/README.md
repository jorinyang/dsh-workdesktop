# dsh-modeling（建模中心）

把**数据/服务架构建模**与**方法论建模**抽象成同一套代数，作为 DSH 自带**右侧栏的一个 tab**
（类型 `dsh-modeling:center`）挂进 WebUI：入口是左侧栏底部的四行之一（由 `dsh-workbench` 统一渲染），
点一下把那一栏打开。全屏 / 双栏分屏 / 拖拽都由官方那条栏自带。
官方指南页上这张入口卡的图标是**彩色**的（橙色底板 `--dsw-static-amber-500` + 白色节点图形，
与官方那两张卡同一形状语法）；tab 标题条与左侧栏那几处仍是单色 `currentColor` 那枚。

```
┌─ 建模中心 ────────────────────────────────────────────────────────────┐
│ [档案] 研究方法论 / 系统架构 / 业务过程                               │
│ ┌──────────┬────────────────────────────────────────┬──────────────┐ │
│ │ 模型库   │ L0 议题 │ L1 原理 │ L2 结构 │ L3 规程  │ 检验器       │ │
│ │ ＋ 新建  │  ┌─────┐   ┌─────┐            ┌─────┐  │ 名称/层/类型 │ │
│ │ 按层加节点│  │议题 │──▶│原理 │───────────▶│活动 │  │ 属性 facet   │ │
│ │ L0…L4    │  └─────┘   └─────┘            └─────┘  │ 体检 / 导出  │ │
│ └──────────┴────────────────────────────────────────┴──────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

## 一、为什么能"向上抽象一层"

参考实现（`dsh-platform` 建模中心）把建模分成**数据建模**（概念/逻辑/物理）与
**业务建模**（业务流程/接口拓扑）两套并列画布。看穿之后它们其实是**同一个代数**：

| 维度 | 内容 |
| --- | --- |
| 模型 | 节点集 × 连边集 |
| 节点 | `(抽象层 level, 类型 type, 名称 name, 属性 attrs)` |
| 连边 | `(类型 type, 起点 from, 终点 to, 标签 label)` |
| 布局 | `f(level)` —— **抽象层即列** |

两个建模领域之间只有两处差别，而**都不是结构差别**：

1. **词汇** —— 这个领域里 L0…L4 分别叫什么、有哪些节点类型；
2. **朝向** —— 节点回答的是"是什么"（声明式）还是"怎么走"（过程式）。

所以本插件只保留**一个引擎**，把差别全部下沉为数据：

### 1) 抽象层轴：定位 → 语义 → 结构 → 实现 → 产出

`AXIS`（`src/modeling.mjs`）是所有档案共用的一条五层轴，且**只进不退**：
L0 划边界 → L1 定原则 → L2 组织起来 → L3 落地 → L4 验收。

参考实现的"概念 / 逻辑 / 物理"是这条轴上 **L1/L2/L3** 的一次取用；补上 L0 与
L4 之后，"边界"和"验收"不再无处安放——这正是方法论建模最容易缺、也最该有的两头。

| 轴（通用语义） | 回答的问题 | 研究方法论 | 系统架构 | 业务过程 |
| --- | --- | --- | --- | --- |
| L0 定位 | 在什么上下文里，边界在哪 | 议题 | 场景 | 触发 |
| L1 语义 | 什么是不变的原则 | 原理 | 概念 | 规则 |
| L2 结构 | 怎么被组织起来 | 结构 | 结构 | 阶段 |
| L3 实现 | 具体怎么做 / 怎么落 | 规程 | 实现 | 活动 |
| L4 产出 | 怎么算做出来了 | 产物 | 运行 | 结果 |

### 2) 朝向：让"流程"和"结构"不必分成两张画布

每个节点类型声明自己的朝向：`declarative`（是什么）或 `procedural`（怎么走）。
**同一张图上两种朝向共存** —— 所以不需要"数据建模画布 + 业务建模画布"两套：
原则是声明式的、活动是过程式的，它们本来就该画在一起，用不同边型连起来。

### 3) 属性 facet：一份词汇表，两个领域共用

`principle`（原则）、`boundary`（边界）、`criterion`（判据）、`steps`（步骤）、
`inputs`/`outputs`（输入输出）、`role`（角色）、`deliverable`（交付物）、
`template`（模板）、`checkpoint`（检查点）、`metrics`（度量）、`artifacts`（落点）……

方法论的"判据"与架构的"业务规则"是同一个 facet；方法论的"交付物"与架构的"表/接口"
也只是落点不同。所以属性表**不按领域分叉**，只按 `text` / `list` 两种形状渲染。

### 4) 连边：一份词汇覆盖两种朝向

`contains`（包含）· `depends`（依赖）· `realizes`（实现）· `refines`（细化）·
`flows`（流转）· `guards`（判据）· `delegates`（分派）· `produces`（产生）·
`conflicts`（冲突）· `relates`（关联）。

**新增一个建模领域 = 在 `PROFILES` 里加一条数据**：画布、检验器、体检、导出、
AI 生成提示全部自动支持，无需改引擎。

## 二、功能

- **画布**：纯 SVG（不引第三方图库）。抽象层即列，拖节点改位置（存进模型），
  依次点两个节点连线，点节点/连线在右侧编辑，`整理布局` 按层重排。
- **检验器**：名称 / 抽象层 / 类型 / 说明 + 该类型声明的属性 facet；
  未声明但已填的属性也会列出（**用户的输入永不静默消失**），并可随时追加 facet。
- **体检**：空层、孤点、产出节点缺判据、活动没写步骤 —— 如实列出，不粉饰。
  这条直接对应"方法论的验收看 L4"：L4 节点没有 `criterion` 就是不可验收。
- **AI 生成**：写一段要建模的内容 → 走宿主当前的模型（`ctx.llm` + `agentDefaultModel`）
  → **先预览后应用**，绝不直接覆盖已有画布；被规范化丢掉的节点/边如实回报。
- **导出**：Markdown（按层分节、属性成条、关系清单）· Mermaid（层即 subgraph）· JSON
  （可再导入）。三者都同时落剪贴板与下载。
- **持久化**：一个模型一个文件 `$DSH_HOME/.dsh-modeling/<档案>/<名字>.json`；
  浏览器侧同时写一份 localStorage 兜底 —— host 不可达时仍可编辑，恢复后自动补写。
- **版式可拖**（2026-09-25 用户裁定，与坐标系同一套手感）：
  - **三段高度**：上带（栏 + 工具栏 + 档案/模型/加节点条）与下带（四张卡）各记一个百分比，
    画布吃掉剩下的高度；两条横分隔条 `cursor:row-resize`，拖动即改比例、**双击复位**。
    默认 9.3% / 15.8% —— 就是改造前实测的样子（右侧栏 1080×1062 下上带 99px、下带 168px）。
  - **四张卡宽度**：检验器 / 体检 / 导出 / 环境 之间三条竖分隔条 `cursor:col-resize`，
    拖动把 fr 权重从左边那张挪给右边那张（两张之和不变、另两张不动），**双击恢复等宽**。
    卡宽下限 140px（拖到底也不会出现读不出内容的窄条）。
  - 比例落 `localStorage`（`dshmo.bands` / `dshmo.cardFr`），**松手才写**；刷新 / 换会话保持。
    紧凑态（面板 < 620px，卡片排两列）下不挂竖分隔条 —— 两列时"卡与卡之间"不是一条线。

## 三、路由（host 半段）

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/modeling/api/profiles` | GET | 词汇表（轴 / 档案 / 层 / 节点类型 / 属性 / 边型）。host 与 client 同一份真相源 |
| `/modeling/api/meta` | GET | 数据目录 + AI 现状（是否可用、用哪个 provider/model） |
| `/modeling/api/draft` | GET | 生成框的空白模板（按当前档案的层词汇拼） |
| `/modeling/api/models?profile=` | GET | 该档案的模型库（按更新时间倒序；坏文件标 `broken` 但仍列出） |
| `/modeling/api/model?profile=&name=` | GET | 读一个模型 |
| `/modeling/api/model` | POST | 落盘（先规范化再写；模型名里的分隔符被转义，挡目录穿越） |
| `/modeling/api/model?profile=&name=` | DELETE | 删除 |
| `/modeling/api/generate` | POST | AI 生成：`{profile, brief, name?, level?}` → 规范化 + 分层落位后的草稿 |

## 四、安装与重启

`dsh --profile web --dump-config` 里应出现：

```yaml
# == dsh-modeling
- id: modeling
  name: dsh-modeling
```

**改完本插件要重启 DSH**：profile 的 `patchReload: live` 只重载**组合**，
不重载已被 Node 缓存的 ESM 模块；新加的路由在运行中的实例上会一直 404。
重启后：

```powershell
Invoke-WebRequest http://127.0.0.1:3080/modeling/api/profiles   # 应 200
```

浏览器半段（`lib/client.js`）随页面刷新加载，不需要额外动作。

## 五、环境变量（可选）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_MODELING_DIR` | `$DSH_HOME/.dsh-modeling` | 模型落盘根目录 |
| `DSH_MODELING_PROVIDER` | 取 `agent-default-model`，回落 `deepseek-official` | AI 生成的提供方 |
| `DSH_MODELING_MODEL` | 同上，回落 `deepseek-v4-flash` | AI 生成的模型 id |
| `DSH_MODELING_AI_TIMEOUT_MS` | `120000` | 生成超时 |
| `DSH_MODELING_AI_MAX_TOKENS` | `8000` | 生成输出上限 |

## 六、源码布局与构建

`src/` 是唯一真相源，`lib/` 是**生成物**（两个运行时入口）：

```
src/modeling.mjs      共用代数（host 与 client 同一份）
src/index.js          host 半段：路由 / 落盘 / AI 生成
src/host.template.js  host 入口模板（自带 import，因为生成物是真 ESM）
src/client.dom.js     画布与面板（React，无 import）
src/client.js         浏览器入口模板（模块加载器工厂）
lib/index.js          ← scripts/build.mjs 生成（host）
lib/client.js         ← scripts/build.mjs 生成（浏览器）
```

为什么要构建：同一份代数要同时服务两个**语法约束互相冲突**的环境 ——
host 需要 ESM 的 `export`，而 DSH 浏览器模块加载器只接受
`window.__ModuleLoader__.load({ id, factory })`，工厂体里不能有 import/export。
`scripts/build.mjs` 把源文件剥掉 ESM 语法后内联，两个入口因此不可能漂移。

```powershell
node scripts/build.mjs          # 重新生成 lib/
node scripts/build.mjs --check  # 只校验 lib/ 与 src/ 一致（CI / 提交前）
```

## 七、自测（不需要 DSH 在跑，也不碰真实数据目录）

```powershell
node scripts/build.mjs --check   # 构建产物守卫：符号没被吞、产物形状对
node selftest-build.mjs          # 构建产物体检（B-1…B-5）
node selftest.mjs                # host 半段（H-1…H-18，含 /modeling/api 路由注册契约）
node selftest-client.mjs         # 浏览器半段（C-1…C-19，含真实渲染 + 交互）
```

三套自测覆盖的关键回归（都是实际踩过的坑，写在用例注释里）：

- **构建吞源码**：剥 ESM 时正则越界会吃掉整段源码，产物依然"语法合法"，
  运行时才炸 `join is not defined` → `selftest-build.mjs` 的 B-2 专门守它。
- **`layoutModel` 抹掉手工坐标**：它是画布热路径，一旦把拖拽结果算掉，
  用户拖完下一帧就弹回格点 → H-2b 断言"手工坐标永远优先"。
- **自动保存读到过期快照**：`[rev]` 依赖的 effect 闭包可能落后一版，
  表现为"点了加节点、落盘却少一个" → 写入一律经 ref 取最新模型（C-19 守）。
- **host 不可达**：不留白屏，用最近一次词汇表缓存渲染并给出可行动提示（C-18）。
