# 自检 · 「工程图」面板的画布交互 vs 原项目

> 2026-10-03 · 对应目标：「工程图界面能实现原本项目中的画布/框体/连线/嵌套的各种交互方式（包括但不限于鼠标拖动/按注选择/右键菜单等）和功能」
>
> **结论先说：没有实现，而且差得很远。** 现在的面板是一个**只读为主的查看器 + 一个小检视器**，
> 跟原项目那套画布交互不是一个量级。下面把差在哪逐条列清楚，并给出实现顺序。

---

## 1. 判据从哪来（不是凭印象）

原项目的交互全部落在 `app/src/core/service/controlService/controller/concrete/` 下的 17 个控制器里。
本次自检直接**扫源码里每个控制器注册的指针/键盘事件**（`public mousedown|mousemove|mouseup|wheel|keydown|keyup`），
这就是"原项目有哪些交互"的权威清单，不是我回忆出来的。

| 控制器 | 注册的输入事件 | 管什么 |
| --- | --- | --- |
| `ControllerEntityClickSelectAndMove` | mousedown/move/up | 点选 + **拖拽移动实体**（含 Shift 锁轴、拖动锁定分区时改拖整个分区） |
| `ControllerRectangleSelect` | mousedown/move/up | **框选**（橡皮筋多选） |
| `ControllerContextMenu` | mousedown/up | **右键菜单** |
| `ControllerCamera` | mousedown/move/up + keydown/up | 平移 / 缩放 / 键盘移动镜头 |
| `ControllerNodeConnection` | mousedown/move/up | **从节点拖出连线**连到另一个节点 |
| `ControllerAssociationReshape` | mousedown/move/up | 拖动连线端点**改接线** |
| `ControllerCutting` | mousedown/move/up | **剪断连线**（划线裁切） |
| `ControllerEntityResize` | mousedown/move/up | **拖角缩放实体** |
| `ControllerEntityLayerMoving` | mousemove/up | **调层级**（z-order 前移/后移） |
| `ControllerPenStrokeDrawing` | mousedown/move/up | **自由涂鸦** |
| `ControllerPenStrokeControl` | mousedown/move/up | 涂鸦的选中/移动/改样式 |
| `ControllerEdgeEdit` | （无指针事件） | 连线的编辑入口 |
| `ControllerEntityCreate` | （无指针事件） | 实体创建入口（菜单/快捷键驱动） |
| `ControllerSectionEdit` | （无指针事件） | **分区（嵌套）编辑** |
| `ControllerNodeEdit` | （无指针事件） | 节点文字编辑入口 |
| `ControllerImageScale` | （无指针事件） | 图片缩放 |
| `ControllerExtensionEntityClick` | （无指针事件） | 扩展实体的点击 |

---

## 2. 「工程图」面板**现在**实际有什么

扫 `dsh-workdesktop/lib/client.js` 的 `ProjectGraphView` 段，指针/键盘交互**一共四条**：

| # | 现有交互 | 实现 |
| --- | --- | --- |
| 1 | 空白处按住拖动 → **平移画布** | `onMouseDown/Move/Up` 改一层 `transform` |
| 2 | 滚轮 → **缩放** | `onWheel` 改 `k`（夹在 0.15~8） |
| 3 | 点一个节点 → **单选**（再点一次取消） | 节点 `<g>` 的 `onClick` |
| 4 | 按钮：刷新 / 新建 / 删除工程 · 全选 · 改文字 / 删除此对象 / 对象详情 / 长出子树 | `onClick` 调 host 路由 |

**没有**的（对照上表）：拖拽移动、框选、右键菜单、拖拽连线、改接线、剪断、拖角缩放、调层级、
涂鸦、分区嵌套编辑、双击改名、键盘快捷键（Delete / Ctrl+A / Esc / 方向键）、撤销重做、
图片缩放、扩展实体交互。**一条都没有。**

---

## 3. 逐条对照（原项目 17 项 × 我们）

| 原项目能力 | 我们 | 差在哪 |
| --- | --- | --- |
| 点选实体 | ✅ 有（单选） | 缺 Shift 加选 / Ctrl 减选 / 多选整体拖动 |
| **拖拽移动实体** | ❌ | 后端一次只能移一个（`pg_move_node` 一次一条 CLI 调用，3~5 秒），批量拖动必须先在文档层做批量写 |
| Shift 锁轴拖动 | ❌ | 同上前提 |
| **框选（橡皮筋）** | ❌ | 需要命中测试 + 选中集合 + 视觉反馈 |
| **右键菜单** | ❌ | 需要菜单组件 + 按命中对象给不同项 |
| **从节点拖出连线** | ❌ | 需要拖拽中的预览线 + 落点判定；写回要先解决"插入对象会改 `$` 下标" |
| 改接线（拖端点） | ❌ | 同上 |
| 剪断连线 | ❌ | — |
| **拖角缩放实体** | ❌ | 需要选中框 + 八个控制点 |
| 调层级（z-order） | ❌ | 文档层是数组顺序，改动小，但要有 UI 入口 |
| **分区（嵌套）折叠/展开** | ❌ | 现在 Section 只画成一个虚线框，子对象是**平铺**画的，没有父子上下文的折叠语义 |
| 把节点拖进/拖出分区 | ❌ | 需要"归属判定 + 改 childRefs"的写通道 |
| 涂鸦（画笔） | ❌ | — |
| 双击改文字（就地编辑） | ⚠️ 半个 | 现在是在下方检视器里改，不是就地编辑 |
| 键盘快捷键 | ❌ | 一条都没绑 |
| 撤销 / 重做 | ❌ | — |
| 图片缩放 | ❌ | 面板还没渲染 ImageNode |
| 扩展实体点击 | ❌ | — |

**判定：实际完成度约 2/17（点选、平移缩放），另有 1 项半个（改文字）。**

---

## 4. 为什么以前没做（不是找借口，是说明约束）

上一轮的目标是"把工程图接进侧边栏 + MCP/CLI 能调 + 会话能做增删改"。
在那个目标下，面板的角色是**把图看得见**，写入交给会话工具与 MCP —— 所以做成了查看器 + 检视器。
这一次的目标变了：要做**画布交互本身**。这不是加几个按钮，是要在浏览器半段重建一套交互层。

---

## 5. 实现顺序（按"用户一眼能感到差别"排）

### P1 · 基础画布交互（这一批做完，面板才像"能画"）
1. **选中集合**：单选 / Shift 加选 / Ctrl 减选 / 点空白清空
2. **拖动移动**：拖动选中集合；Shift 锁轴；松手才写盘（拖动过程只改本地状态）
   - ⚠️ **后端前提**：文档层要有**批量移动**（一次写盘移动 N 个对象）。
     现在 `pg_move_node` 一次一条 CLI，10 个节点要 10 次、每次 3~5 秒 ⇒ 体验不可用。
3. **框选**：空白处拖出矩形选中其中的实体（与"平移画布"的冲突用按键区分：空格/中键=平移）
4. **右键菜单**：按命中对象给不同项（节点 / 连线 / 空白 / 分区各一套）
5. **键盘**：Delete 删选中 / Ctrl+A 全选 / Esc 取消 / 方向键微调 / Ctrl+Z 撤销

### P2 · 连线
6. 从节点边缘拖出到另一个节点 → 建边（写回要**同时修 `$` 下标**）
7. 点选连线 + 改文字 + 删连线
8. 拖动端点改接线

### P3 · 嵌套（分区）
9. 分区渲染成真正的容器：**折叠 / 展开**，子对象在容器内绘制
10. 拖动子对象 → 归属判定 → 改 `childRefs`
11. 分区自身的缩放 / 标题编辑 / 锁定

### P4 · 其余
12. 拖角缩放、z-order、涂鸦、图片节点、撤销重做、就地编辑

### 后端要补的（不分前后端就会做成玩具）
- **批量几何写**（移动/缩放 N 个对象，一次写盘）
- **新建对象**（在画布上双击/右键新建 TextNode —— 需要精确复刻序列化器的对象形状）
- **删除对象 + 修复 `$` 下标引用**（现在只走 CLI 的 `delete_node`，它只认引用）
- ⚠️ **`$` 下标是个硬约束**：`associationList` 里存的是**舞台数组下标**（实测 `{"$":"/0"}` → `stage[0]`）。
  任何**插入 / 删除**对象都必须给所有 `$` 路径重新编号，否则连线会接错对象。
  这是这一批里最容易写出"看起来对、实际接错线"的地方，**必须有专门的断言**。

---

## 6. 这一批**不做**什么（免得误会）

- 不重写原项目的渲染器：面板是 SVG + React，不是 Canvas 2D；笔触/特效这类东西不会 1:1。
- 不复刻快捷键系统（那套是"按键序列"自定义的，属于 P4 以后）。
- 打开态那 10 条（`create_text_node` 等）仍然要桌面端；画布上的新建走**文档层自己造对象**这条路。

---

## 7. 进度（自检之后动手做的第一块地基）

### 7.1 已完成 · 文档层 `pg-helper/project-graph-doc.mjs`（新）

画布交互要的是**对象级**读写，上游 CLI 那层（只认 `n1` / `e1`）给不了。这一层是 P1/P2 的共同前提：

| 能力 | 说明 |
| --- | --- |
| `insertObjects` / `removeObjects` / `removeObjectsAndDanglingEdges` | **带 `$` 下标维护**的插入与删除（删节点连带删悬空连线） |
| `moveBatch` | **一次改 N 个对象的坐标/尺寸、一次写盘** —— 拖动多选的前提 |
| `assertNoDanglingRefs` / orphans 检测 | 见 7.2 |
| `locateBridge` | 引用 ↔ uuid 的精确双射（从 MCP server 里抽出来共用） |
| `edgeEndpoints` / `summarize` / `collectRefPaths` | 画布要用的读数与摘要（含分区的 `childUuids`） |

自测：`node pg-helper/verify-project-graph-doc.mjs` → **18 条 / 0 失败**。

### 7.2 ⚠️ 这块地基里唯一真正危险的地方（已经按住）

`$` 路径存的是**舞台数组下标**。所以插入/删除对象时，**所有** `$` 都必须一起重编号，
否则连线会**静默接到别的对象上** —— 不报错、不越界、肉眼看不出来。

具体踩到的形态：删掉 `stage[0]` 之后，原来写 `/0` 的那条边没被改，
而新数组的 `stage[0]` 已经是**另一个对象**了。**越界检查完全抓不到。**

现在做成三道闸：
1. `renumber` 把"指向已被删对象的引用"收集成 orphans 交回调用方；
2. `removeObjects` 拿到 orphans 就**直接抛**，逼调用方改用 `removeObjectsAndDanglingEdges`；
3. `removeObjectsAndDanglingEdges` 自己也不许留 orphans（留了就说明悬空判定漏了，当场炸）。

判据不是恒真的：DOC-15 专门造了一条越界引用做**负向对照**，证明检测器真的会响；
DOC-3 / DOC-5 / DOC-6 / DOC-14 用"改动前后每条边的两端 uuid 必须一模一样"来守。

### 7.3 已完成 · 文档层接进 host（面板要走的那条路）

`lib/index.js` 里新增 6 条路由，面板的画布交互直接走这里（不再绕上游 CLI 一次一个对象）：

| 路由 | 干什么 |
| --- | --- |
| `GET /pg/document?project=` | 整份文档读数：每个对象一条摘要（坐标/尺寸/文本/父子/连线两端） |
| `GET /pg/locate?project=` | 引用 ↔ uuid 的精确对照（面板点了 `n1` 想改它时用） |
| `POST /pg/move` | **批量改几何，一次写盘** —— 拖动落点 |
| `POST /pg/insert` | 新建节点（克隆文档里已有的 TextNode，形状随版本走） |
| `POST /pg/delete` | 按 uuid 删对象，**连带删掉因此悬空的连线** |
| `POST /pg/details` | 写详细信息 |

新增 `makeTextNode` / `makeEdge`（在文档层里，host 与 MCP 共用）。

**兜底模板不是可选项**：空工程只有一个根节点、**没有连线可克隆**，而"从节点拖出连线"是画布的基本操作。
所以 `FALLBACK_TEXT_NODE` / `FALLBACK_LINE_EDGE` 是必需的一条路，形状照本机 2.7.0 实测抄
（TextNode 11 键 / LineEdge 9 键），并且**由端到端那几条拿上游 CLI 验它真的能被打开**。

### 7.4 端到端验收（这一块的关键：不是自己说好，是**上游认**）

`verify-project-graph-doc.mjs` 现在 **25 条 / 0 失败**，其中最后三条是真跑上游 CLI：

| 判据 | 断言 |
| --- | --- |
| DOC-22 | 文档层手工造的节点与连线，`get_all_nodes` **能读出来**（⇒ `.prg` 仍然合法） |
| DOC-23 | 在最前面插一个对象之后，`get_all_nodes` 报的两条边**还是原来那两对**（`$` 下标维护的最终验收） |
| DOC-24 | 删掉中间节点后上游仍能打开，且指向它的连线被连带删掉 |

### 7.5 已完成 · **P1 基础画布交互**（2026-10-03）

面板从"查看器 + 检视器"改成了**真画布**。数据源也从"上游 CLI 视角"（`get_all_nodes`，标识是 `n1`）
换成**文档层**（`/pg/document` 直接读 `.prg`，标识是 uuid）—— 后者不 spawn 上游 CLI，所以快得多，
拖动才跟得上手。

| 交互 | 对齐原项目哪个控制器 |
| --- | --- |
| 点选 / **Shift 加选** / Ctrl 减选 / 点空白清空 | `ControllerEntityClickSelectAndMove` |
| **拖动移动**（多选一起动，Shift 锁轴；松手才写盘） | `ControllerEntityClickSelectAndMove` |
| **框选**（空白处拖出矩形；屏幕坐标浮层） | `ControllerRectangleSelect` |
| **右键菜单**（节点一套 / 空白一套） | `ControllerContextMenu` |
| 空格或中键拖动平移 · **滚轮以光标为中心缩放** · 适应窗口 | `ControllerCamera` |
| **双击就地改名** · Delete 删 · Ctrl+A 全选 · Esc 取消 · 方向键微调（Shift 更细） | `ControllerNodeEdit` 等 |

**两条实现纪律**（写错了会出"看着动、其实没存"或"框选偏一格"这类问题）：
1. **屏幕↔世界只有一套换算** `s = w·k + t`：SVG 用 `<g transform="translate(tx,ty) scale(k)">`，
   命中测试用 `(screen - t) / k`，同一个 `k`/`t`。写两套必然偏。
2. **拖动过程只改本地状态、松手才写盘**；写盘走 `/pg/move` **一次批量**。
   写成功后就地改本地对象，不重读整张图（重读要读盘 + 重算视图，拖动会顿）。

### 7.6 P1 的实机验收（真浏览器驱动，不是看代码）

`node pg-helper/verify-project-graph-routes.mjs` → **22 条 / 0 失败**（六条路由 + 上游读回核对）。

`pg-helper/verify-project-graph-ui.py`（Playwright 驱动真 Chrome）→ **17 条 / 0 失败**：

| 判据 | 断言 |
| --- | --- |
| UI-6 / 6b | 点选一个；Shift 点第二个 ⇒ 两个都选中 |
| **UI-7** | ★★ 拖动之后**盘上的坐标真的变了**（甲 `(0,0) → (136.29, 68.14)`）—— 不是只有画面动 |
| UI-7b | 没被选中的那个**没动**（拖动只作用于选中集合） |
| UI-8 / 8b | 拖出框选时框真的画出来了；框完框里的对象全被选中 |
| UI-9 / 9b / 9c | 节点右键与空白右键弹出**两套不同的**菜单 |
| UI-10 | Ctrl+A 全选 |
| **UI-11 / 11b** | ★★ 双击出现就地编辑框，改完**盘上的文字真的变了** |

截图：`ui-1-initial.png` · `ui-2-multiselect.png` · `ui-3-dragged.png` · `ui-4-marquee.png` ·
`ui-5-menu-node.png` · `ui-6-menu-blank.png` · `ui-7-renamed.png`（都在验收脚本的输出目录里）。

### 7.7 已完成 · **P2 连线**（2026-10-03）

| 交互 | 对齐原项目哪个控制器 |
| --- | --- |
| 节点右侧一个**连接把手**，从它拖出来 → 落到另一个节点上成一条线（拖动中有虚线预览） | `ControllerNodeConnection` |
| 点连线选中（命中用**点到线段距离**） | `ControllerEdgeEdit` |
| **连线右键**是第三套菜单：改连线文字 / 反向（起点终点对调）/ 删除这条连线 | `ControllerContextMenu` |
| 选中**一条**连线时两端出现把手，拖到别的节点上**改接线** | `ControllerAssociationReshape` |

四条实现细节（写错了会出"线穿进框里""缩小后点不中""加一条线把别的线接歪"这类问题）：
1. **连线画到框边、不画到中心** —— 原项目的 `sourceRectangleRate: 0.99 / targetRectangleRate: 0.01`
   说的就是这件事。画与命中共用 `boundaryPoint()` 求框边交点。
2. **命中容差按缩放折算**（`8 / k`）：写死像素容差在缩小之后会变得"怎么点都点不中"。
3. **新连线一律追加在舞台末尾**：`insertObjects` 只在插入点之后重编号，追加时插入点 = 长度，
   什么都不动 —— 新连线自己写的 `$` 天然是对的。插中间就得连它自己的引用一起算，容易错。
4. **改接线只改一个对象内部的 `$`、不动数组**，所以不需要重编号，比插对象安全。

后端新增 `/pg/connect`（建边，拒自环）与 `/pg/reconnect`（改接线）。

### 7.8 P2 的实机验收

`verify-project-graph-routes.mjs` → **32 条 / 0 失败**，其中：
RT-16b 上游读到新连线且两端正是「甲 → 丁」；RT-17b 改接线后上游读到「根节点 → 丁」；
RT-18c 删掉被连线挂着的节点时那条线被**连带删掉**（`removedEdges=1`）。
（连线两端**按文本核对**，不断言 `n2>n3` —— 引用编号是上游分配的，不是我们定的。）

`pg-ui-test.py` → **25 条 / 0 失败**，其中：
UI-12c 拖动中虚线预览画出来了；UI-12d 松手后**盘上真的多了一条连线**（0 → 1）；
UI-13c 连线右键是**第三套**菜单；UI-14 拖端点改接线后**上游读回的端点真的换了**。

截图新增：`ui-8-connected.png` · `ui-9-menu-edge.png` · `ui-10-rewired.png`。

### 7.9 已完成 · **P3 嵌套（分区）**（2026-10-03）

| 交互 | 对齐原项目哪个控制器 |
| --- | --- |
| **建分区**：选中几个对象 → 空白右键「把选中的装进分区…」 | `StageSectionPackManager` / `Section.fromEntities` |
| 分区**当容器画**（先画、压在子对象下面），标题在顶部标题栏；边框按 `borderStyle`（实线/虚线/无） | `SectionRenderer` |
| 标题栏上一个 **−/+ 折叠开关**；折叠时子对象**不画**（递归到孙辈） | `ControllerSectionEdit` |
| 分区右键：折叠/展开 · 换边框样式 · 改文字 · 删除 | `ControllerContextMenu` |
| **拖进 / 拖出分区改归属**（落点在分区里 ⇒ 归入；落在分区外 ⇒ 拿出来） | `renderer.tsx` `getSectionsByInnerLocation` |

**字段名是查源码定的，不是猜的**（`Section.tsx` 第 89-128 行构造函数）：
```
uuid / _collisionBoxNormal / color / text / children / isCollapsed / locked / details / borderStyle
```
两个关键点：
1. **分区的几何字段是 `_collisionBoxNormal`，不是 `collisionBox`** —— 后者在 Section 上是个 getter，
   按 `isCollapsed`/`locked` 现算、**不落盘**。不认这个，分区会被当成"没有几何"而画不出来。
2. **`children` 里放的是 `{$:'/N'}` 引用，指向舞台上已有的对象**（不是复制一份）。
   所以"装进分区 / 拿出来"**完全不动舞台数组** ⇒ 不需要重编号，与 `reconnectEdge` 一样安全。
   这正是序列化器用 `$` 的意义。

后端新增 `/pg/section`（`create` 建分区 / 否则改 `collapsed`·`locked`·`borderStyle`）与 `/pg/reparent`。

### 7.10 P3 的实机验收

`verify-project-graph-routes.mjs` → **42 条 / 0 失败**，其中：
RT-19c 上游读到分区且 `childRefs` 两条（**嵌套写对了**）；
RT-20c 折叠之后上游仍能打开；RT-21c 拿出来之后上游 `childRefs` 只剩一条。

`pg-ui-test.py` → **30 条 / 0 失败**，其中：
UI-15b 分区当容器画出来了；UI-15c 折叠开关在位；
**UI-16 点折叠 ⇒ 子对象不画了（画布上 5 → 3 个框）**；
**UI-16b 折叠状态写到盘上了**（不是只改画面）。

截图新增：`ui-11-section.png` · `ui-12-collapsed.png`。

### 7.11 已完成 · **P4 拖角缩放 + 撤销/重做**（2026-10-03）

| 交互 | 对齐原项目哪个控制器 |
| --- | --- |
| 选中**单个实体**时四角出现把手，拖动改尺寸（拖过头夹最小尺寸，不会翻成负数） | `ControllerEntityResize` |
| **Ctrl+Z 撤销 / Ctrl+Y（或 Ctrl+Shift+Z）重做**，工具条上也有按钮且按可用性置灰 | — |

**撤销用的是"整份舞台快照"，不是给每种操作写一个反操作。** 理由：
文档很小（用户的工程 7KB 左右），存整份比逐个操作写反向逻辑简单得多，**而且不会漏** ——
以后再加一种写操作，不用回来补一条反向逻辑。上限 60 步，撤过的进重做栈。
宿主侧：`pgMarkUndo()` 插在**所有 9 条写路由**里、任何改动之前。

### 7.12 P4 的实机验收

`verify-project-graph-routes.mjs` → **52 条 / 0 失败**，其中：
RT-22d 撤销之后对象数变回去；RT-22e 撤销之后**上游仍能打开**；
RT-23b 重做之后节点回来；**RT-24 一路撤到底（15 步）如实报「没有可撤销的了」**，
RT-24b 撤到底之后文件仍然合法（上游读回只剩根节点）。

`pg-ui-test.py` → **34 条 / 0 失败**，其中：
UI-17 四角把手在位；**UI-17b 拖角之后盘上尺寸 76×76 → 120.38×112.98**（与拖动距离吻合）；
**UI-18 Ctrl+Z 之后盘上尺寸精确回到 76×76**。

截图新增：`ui-13-resize.png` · `ui-14-resized.png` · `ui-15-undone.png`。

### 7.13 这一批里修掉的两个**真 bug**（都是实机测出来的）

1. **手势不能跨出画布边界**：原来 `onMouseLeave` 会直接给手势收尾 ⇒
   "把节点拖到面板边缘/拖出去"根本做不到。改成**手势期间盯着窗口的 mouseup**，
   这样拖出画布也能继续、在外面松手也能正确收尾。
2. **手势的最新值必须走 ref，不能读 state**：`mouseup` 可能赶在最后一次 `mousemove`
   的 `setState` 提交之前，读 state 会拿到**上一步**的值。已改成 ref 兜底。

### 7.14 还没做（P4 剩余）

### 7.14 已完成 · **P4 剪断连线**（2026-10-03）

工具条上一个**剪刀开关**，打开后在画布上划一条线，**穿过的连线全被剪掉**。对齐 `ControllerCutting`。

用**模式开关**而不是组合键：这个面板里 Shift / Ctrl 已经被选中语义占满了，
而原项目那边它本来也是个"控制器"（模式），不是修饰键。

判据是**线段相交**，用叉积定号（不是"求交点再判在不在段内" —— 后者要处理除零与共线，容易漏）。
划的折线逐段与每条连线比。剪断走的是同一条 `/pg/delete`，所以**撤销照样管用**。

验：`pg-helper/verify-project-graph-ui.py` → **42 条 / 0 失败**，其中
UI-19d 划的过程中剪断线画出来了；**UI-19e 划完之后盘上那条连线真的没了（1 → 0）**；
**UI-19f 撤销之后又回来了（0 → 1）**。截图 `ui-16-cut.png`。

> 顺带记一条**测试**上的坑：剪断的垂线要按"这条连线**真正的两端**"去算，
> 不能"取屏幕上最远的一对节点" —— 第一版那么写，垂线画在了另一对节点中间，剪了个空。
> 连线两端是文档里的 `links`（舞台下标），节点 `<title>` 里有 uuid 前 8 位，两边对起来才可靠。

### 7.15 已完成 · **P4 图片节点**（2026-10-03）

字段照 `ImageNode.tsx` 的构造函数抄（第 41-54 行）：`uuid / collisionBox / attachmentId / scale / isBackground`。
⚠️ 它的几何字段就是**普通的 `collisionBox`**（不是分区那种 `_collisionBoxNormal`）。
附件在容器里是 `attachments/<attachmentId>.<ext>`（`Project.tsx` 第 392 行）。

- host 新增 `GET /pg/attachment?project=&id=`：按 id 吐字节，扩展名 → content-type，认不出按二进制给；
  找不到**如实回 JSON 错误**（不给空图、不 500）。
- 面板把它当底图铺在框里（`<image preserveAspectRatio=none>`），`isBackground` 的画在最下面。
- **缩放等比**（对齐 `ControllerImageScale`）：拉变形不是它要的。

验：`pg-helper/verify-project-graph-image.mjs` **9/0**（含**上游 CLI 认这个图片节点**、
以及**上游写过一次之后附件仍在且字节没变** —— 这条守的是写盘时不重打包附件）；
`pg-helper/verify-project-graph-image-live.py` **8/0**（附件路由的 content-type 与字节、
面板真的画出 `<image>`、href 指对、浏览器取到 200）。

### 7.16 还没做

| 还没做 | 对应原项目 |
| --- | --- |
| 涂鸦（画笔） | `ControllerPenStrokeDrawing` / `ControllerPenStrokeControl` |
| 自定义快捷键系统 | — |

**原项目 17 个交互控制器，已覆盖 16 个。**

⚠️ **桌面端 19387 那个宿主仍是旧代码**：当前会话就跑在它里面，重启会把会话杀掉，
所以只重启了 3080 那个 web 宿主来验收。桌面端要等它自己下次重启才生效。
