# pg-helper · 工程图的宿主侧实现

这个目录是**「工程图」面板能跑起来的原因**。它不是插件界面代码，而是界面底下的那几层：
读写 `.prg` 文档、把工作区按 MCP 暴露出去、向上游 CLI 争独占所有权。

> 为什么单独放在一个目录、而不是塞进 `lib/`：
> 它**零依赖**（只用 `node:` 内置模块），能被三种不同的调用者共用 ——
> 插件 host 半段、MCP server、以及命令行排障。
> 塞进 `lib/` 就会被插件的加载流程绑住，命令行就用不了了。

---

## 一、三层结构（按"从下到上"读）

| 文件 | 管什么 | 为什么需要它 |
|---|---|---|
| `project-graph-prg.mjs` | **容器层**：`.prg` 的编解码（`metadata.msgpack` / `attachments/` / 全部舞台对象类型） | 上游 CLI 的 29 条工具只认"节点/连线"那一层，**容器层它没有工具** —— 这一层是按 [graphif.dev 的规范](https://graphif.dev/docs/spec/prg) 自己实现的。零依赖，只用 `node:zlib` |
| `project-graph-doc.mjs` | **文档层**：`.prg` 里对象级的读写 | 上游只认**项目级引用**（`n1` / `e1`），管不到容器与"没有引用"的对象。而画布交互（拖动、框选、连线、嵌套）要的是**对象级**读写 |
| `project-graph-mcp.mjs` | **MCP server**（stdio） | 把一个工程图工作区按 MCP 暴露出去，让 DSH 或任何 MCP 客户端用标准工具建/改/删图里的内容 |

**三层共用同一份文档层** —— 界面看到的和 MCP 改到的是同一份数据，不各写一套。

---

## 二、开箱三步

```bash
# ① 布置工作区 + 一个开箱可看的起始工程
node setup-workspace.mjs

# ② 生成空工程模板（`empty-project.prg` 已在仓里，需要重造时用）
node build-empty-project.mjs

# ③ 探一下本机的工程图环境（工作区在哪、CLI 在不在、所有权争不争得到）
node pg-probe.mjs
```

> ⚠️ **本目录故意没有 `package.json`**。加一个会让它被当成"可以 `npm install` 的包"，
> 而它的定位是**随插件分发的内置工具集**：被 import、被 spawn，不单独发布。
> 实测（2026-10-15）本仓里引用它的地方一共 9 处：
> `lib/index.js`（插件 host 半段）· `selftest.mjs`（仓库自检）·
> `.github/workflows/selftest.yml`（CI）· `workbench-v1/processor/visual.mjs`（引擎侧的可视化落盘）·
> `package.json`（`files` 里声明了它）· 以及 `pg-helper/` 自己的
> `pg-probe.mjs` / `pg-sections.mjs` / `setup-workspace.mjs` / `verify-client-tdz.mjs`。
> **没有一处是 `npm install` 进来的** —— 所以不加 `package.json`。

---

## 三、`empty-project.prg` 为什么留一个根节点

上游把 29 条工具分成两档：**19 条关闭态能跑**（CLI 直接读盘、不需要桌面端），
**10 条要打开态**（要 viewport / selection，只有桌面端开着才有）。

模板里留一个根节点，是为了让"新建的工程"**立刻能长出树**（`expand_node_tree_from_node` 拿根节点当起点），
而不是让使用者先想办法造出第一个节点。

---

## 四、所有权助手（`ProjectGraphOwnershipHelper.cs`）

上游 CLI（`tool invoke`）动手前要先拿到目标 `.prg` 的**独占所有权** ——
它 spawn 一个原生 helper（上游 `app/src-tauri/src/bin/project-graph-ownership-helper.rs`）。

这个 `.cs` 是那件事在 **Windows / Node 侧的等价实现**（按需编译）。
存在的原因：本机不一定有 Rust 工具链，而没有所有权就拿不到写权限。

配套的验证：`verify-ownership-helper.mjs`。

---

## 五、验证脚本

这个目录里**脚本比模块多得多**（33 个 `verify-*`，模块只有 5 个），**是有意的** ——
工程图的交互面很宽，每一样都得有一条能独立重跑的验证，否则"改好了没有"就只能靠眼睛看。

按**要不要开着桌面端**分两类（这个分法不是随便分的：要开桌面端的那些**不能进 CI**，
进了就会"在别人机器上必红"）：

**第一类 · 静态或命令行即可（`.mjs`）**

| 脚本 | 验什么 |
|---|---|
| `verify-project-graph-cli.mjs` | 上游 CLI 的 29 条工具在本机可不可用 |
| `verify-project-graph-doc.mjs` | 文档层（对象级读写） |
| `verify-project-graph-mcp.mjs` | MCP server 那条路 |
| `verify-project-graph-routes.mjs` | 路由与分派 |
| `verify-project-graph-group.mjs` | 分组 |
| `verify-project-graph-clipboard.mjs` | 剪贴板（不依赖 GUI 的那一半） |
| `verify-project-graph-image.mjs` | 图片节点 |
| `verify-ownership-helper.mjs` | 所有权助手 |
| `verify-client-tdz.mjs` | 客户端半段的暂时性死区类问题（`let` 先用后声明） |

**第二类 · 真机 GUI（`.py`，要桌面端开着）**

`verify-project-graph-ui.py` · `-livefit.py` · `-select.py` · `-menu.py` ·
`-rightbutton.py` · `-rightdrag.py` · `-rightcut.py` · `-pen.py` · `-fold.py` ·
`-fold-drag.py` · `-nested.py` · `-nestedfollow.py` · `-grow.py` · `-hitarea.py` ·
`-zorder.py` · `-uibars.py` · `-extension.py` · `-find.py` · `-image-live.py` ·
`-cross.py` · `-create.py` · `-ask.py` · `-edgetext.py` · `-clipboard-ui.py`

> 完整的清单以目录里实际存在的文件为准 —— `ls pg-helper/verify-*`。
> 上面这两张表**分工是按扩展名粗分的**：`.py` 基本都要桌面端，`.mjs` 基本不要，
> 但也有例外（`verify-project-graph-image-live.py` 这种名字里带 `live` 的，含义就是"要在活的界面上验"）。

---

## 六、改这个目录时的纪律

- **零依赖不许破**：三层都只用 `node:` 内置模块。加了第三方依赖，命令行那条路就走不通了。
- **文档层是唯一一份**：插件与 MCP 必须共用 `project-graph-doc.mjs`，不许各写一份
  （两份必然漂，而"界面看到的"和"MCP 改到的"不一致是最难查的一类问题）。
- **改完跑 `verify-project-graph-cross.py`**：跨层一致性（容器 ↔ 文档 ↔ CLI 三层说的是不是同一件事）
  是这里最容易出问题的地方。
  ⚠️ 它是 `.py`（要在**开着桌面端**的机器上跑），不是 `.mjs` —— 我第一版写成了 `.mjs`，
  而这个名字的文件并不存在。**清单里的扩展名要照实写**，否则照它去跑会找不到文件。
