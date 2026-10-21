# dsh-mi-remote · 遥控器

把小米蓝牙遥控器（RC003）变成 DSH 的输入设备：**按键映射到 DSH 动作**、**语音出字**、**链路体检**。

一个自包含的 DSH 插件 —— 宿主半段、客户端半段、按键引擎、采集器、工具、文档、第三方安装包全在
这一个目录里。装它就是装这一个包。

---

## 一、它现在能做什么

**按键映射**：13 个按键 × 三个档位（单击 / 双击 / 长按），每个都能配成
「DSH 动作 / 组合键 / 打开应用 / 按住某个键」。图形化面板，中间一台遥控器实物图，
点图上的键 ⇒ 对应卡片高亮。

**七个自带的可绑命令**（2026-10-11 加，装上就能用，不用先去 DSH 里绑）：

| 命令 | 默认键位 | 作用 |
| --- | --- | --- |
| 打开工作台 | `Ctrl+Alt+1` | `sidebarRight.openTab('dsh-workdesktop:console')` |
| 打开驾驶舱 | `Ctrl+Alt+2` | `…dsh-workdesktop:dashboard` |
| 打开工程图 | `Ctrl+Alt+3` | `…dsh-workdesktop:project-graph` |
| 打开坐标系 | `Ctrl+Alt+4` | `…dsh-coords:center` |
| 打开建模中心 | `Ctrl+Alt+5` | `…dsh-modeling:center` |
| 聚焦聊天输入框 | `Ctrl+Alt+F` | 焦点与光标回到聊天框 |
| 打开第一条会话 | `Ctrl+Alt+Q` | 配合搜索框：「语音说关键字 → 第一条自动高亮 → ↑/↓ 选 → Enter 进」 |

**搜索结果的键盘导航**：DSH 把搜索结果渲染成一棵 `role="tree"`，但**没实现任何键盘导航**。
本插件补上了：搜索框有内容时，第一条自动高亮，↑/↓ 移动，Enter 进入。
（只在搜索框有内容、且焦点不在别的输入框时才接管，带修饰键的一概不拦。）

**语音输入**：遥控器语音键 → 无线麦 SayAll → VB-CABLE → 输入法出字。面板上能一键切默认录音设备。

**链路体检**：遥控器配对 / SayAll / VB-CABLE / 输入法，四段逐一报状态。

---

## 二、目录结构

```
dsh-mi-remote/
├── package.json            包声明（files 白名单 / scripts / dsh 元数据 / 运行期约定）
├── cordis.patch.yml        DSH 注册（bundle patch）
├── icon.svg
├── lib/
│   ├── index.js            宿主半段（HTTP 路由 /mi-remote/api、预设表、进程管理）
│   └── client.js           客户端半段（面板、右栏席位、七条快捷键命令、搜索导航）
├── engine/                 运行时引擎
│   ├── rc003-tap.py        Frida 采集器：挂在蓝牙驱动宿主上读 HID 报告
│   ├── read-engine.py      引擎（Python 版）：轮询 → 判定 → SendInput
│   ├── KeyBridge.cs/.exe   引擎（C# 版）：Raw Input → 判定 → SendInput
│   ├── inject.py           独立的按键注入器（诊断用）
│   ├── build.ps1           重新构建 C# 引擎（VS 自带 Roslyn csc，不需要 dotnet SDK）
│   └── diag/               一次性诊断工具（fgcheck / hooktest / integrity / keytap / sidcheck…）
├── tools/                  日常工具
│   ├── check.ps1           六段链路体检
│   ├── kill-strays.ps1     清掉所有残留的采集器与引擎
│   ├── test-buttons.py     逐键逐档测试（从 mapping.json 自动生成用例）
│   ├── keyprobe.html       浏览器按键诊断页（看 event.code/key/修饰键/isTrusted）
│   └── diag/               排查用的脚本（延迟测量 / 抖动分析 / 注入去重 / 高亮验证…）
├── scripts/                构建期与自检
│   ├── selftest.mjs        宿主 + 纯函数 + 探针
│   ├── verify-render.mjs   界面真渲染（自造 React 桩）
│   ├── verify-live.mjs     实机：启动图 / bundle 字节 / 宿主路由
│   └── fix-bom.mjs         把两个 .ps1 修成 UTF-8 带 BOM（PS 5.1 硬要求）
├── docs/
│   ├── REVIEW_遥控器按键链路_20261011.md    按键链路全面 review
│   └── ARCHITECTURE.md                       机制说明与排障手册
├── audio/                  两个 .ps1 执行器（链路探针 / 录音设备切换）
├── locale/                 zh.json / en.json
├── assets/vendor/          第三方安装包（VB-CABLE / SayAll / 无线麦）+ SHA256SUMS
├── state/                  运行时数据（mapping.json / keys.jsonl / 日志）—— 不进包
└── tmp/                    运行时暂存（check.ps1 用）—— 不进包，可随时清空
```

---

## 三、一次按键是怎么变成动作的

五段，每段都能单独验：

| 段 | 做什么 | 在哪 |
| --- | --- | --- |
| 1 | 遥控器发 BLE HID 报告 | 系统蓝牙栈 |
| 2 | 采集器在 `WUDFHost.exe` 里 hook `NtDeviceIoControlFile`，把 HID 报告的 usage 列表写进 `state/keys.jsonl` | `engine/rc003-tap.py` |
| 3 | 引擎每 6ms 轮询该文件，按 单击 / 双击 / 长按 三档判定 | `engine/read-engine.py` |
| 4 | 判定结果用 `SendInput` 注入按键（**同时给 `wVk` 和 `wScan`**） | 同上 |
| 5 | DSH 按 `event.code` 匹配快捷键，执行命令 | `packages/client/shortcuts` |

### 两条硬约束（踩过才知道）

**一、必须同时给扫描码。** DSH 的快捷键按 `event.code`（物理键位）匹配
（`packages/client/shortcuts/src/binding.ts`）。只给 `wVk` 时 Chromium 推不出 `event.code`、
显示为空，DSH 永远匹配不上 —— 而 `SendInput` 仍返回成功，**静默失败**。

**二、注入进程的完整性级别不能低于目标窗口。** UIPI 规定低完整性进程无法向高完整性窗口注入，
`SendInput` 照样返回成功。360 的 `360Box64` / `360AntiHijack` 驱动会把未签名程序压到 Low（4096），
而 `python.exe` 保持 High（12288）。插件因此会**自动探测并优先选 python 版引擎**
（`probeEngineIntegrity` / `pickEngine`）。重启后 360 驱动消失，C# 引擎会接手。

### 判定参数

- **单击**：松手即执行；**只有该键配了双击动作时才等** `DOUBLE_MS`（320ms）
- **双击**：`DOUBLE_MS` 内两次松手
- **长按**：按住超过 `HOLD_MS`（650ms）
- 鼠标移动类动作按住期间循环注入，**松手由 `move-stop` 立刻停止**

---

## 四、配置与状态文件

都在 `state/`（可用 `DSH_MIREMOTE_STATE_DIR` 改）：

| 文件 | 是什么 | 能删吗 |
| --- | --- | --- |
| `mapping.json` | **按键方案的单一真相源** | **不能** —— 删了会退回默认方案 |
| `mapping.bak.json` | 每次写入前的自动备份 | 能 |
| `keys.jsonl` | 采集器写的按键报告 | 能（会重建） |
| `bridge-run.jsonl` | 引擎日志（每条带 `ts` 墙钟毫秒） | 能（会重建） |
| `engine.log` / `collector.log` | 两个进程的 stdout/stderr | 能 |
| `bridge.json` | 当前链路的快照 | 能 |

**⚠️ 不要直接改 `mapping.json`。** 面板保存时会用它加载时的状态整份覆盖 ——
你手改的内容会被冲掉（2026-10-11 踩过）。**要改就在面板里改。**

---

## 五、跨插件耦合（唯一的）

**左侧栏那一行「遥控器」**注册在 `plugins/dsh-workdesktop/lib/client.js` 的
`MI_REMOTE_KIND` + `WORKSPACES` 数组里。

**为什么不能收进本插件**：用户 2026-10-08 裁定它要排在「驾驶舱下方、坐标系上方」。
那五行是 workdesktop **一个组件内部**渲染的，跨插件的 slot 只能整体排在本插件块的上/下，
插不进它们中间。（`dsh-coords` / `dsh-modeling` 也是同一个模式：别人注册 kind，它只放一行。）

**插件缺席时会怎样**：不会崩 —— workdesktop 的 `open()` 自带吞错与短重试。
但那一行仍会显示，点了没反应。

---

## 六、工具与自检

```powershell
cd <本插件目录>

# 逐键逐档（从 mapping.json 自动生成 25 个用例）
& "D:\.hermes\venv\Scripts\python.exe" tools\test-buttons.py

# 自检：宿主 + 纯函数 + 探针
node scripts\selftest.mjs
node scripts\selftest.mjs --probe          # 真连设备

# 界面真渲染
node scripts\verify-render.mjs

# 六段链路体检
powershell -NoProfile -ExecutionPolicy Bypass -File tools\check.ps1

# 清残留（引擎/采集器攒多了会一个动作执行多遍）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\kill-strays.ps1
```

自测会**真往系统里注入一个 F24**。开会或演示时不想被打扰，设 `DSH_MIREMOTE_SKIP_TAP=1` 跳过。

---

## 七、改了插件却不生效？

DSH 的守护进程 `~/.dsh/daemon/dsh-guard.mjs` 做两件事：**保活**（3080 掉了自动拉起）与
**插件热更**（watch `~/Desktop/DSH/plugins`，防抖 20 秒后重启 dsh）。

但只要 `~/.dsh/daemon/guard.norestart` **存在**，它就**只停热更、保活继续**。
这个文件是 2026-10-03 建的，理由正当：**热更重启会打断正在跑的会话**。

**后果**：改完插件不会有任何反应 —— dsh 一直跑着启动时那份代码。诊断特征：

```
~/.dsh/daemon/guard.log 里反复出现：
忽略 热更已禁用(guard.norestart) × N 事件（最近示例：…\dsh-mi-remote\lib）
```

**所以改完东西之后**：

- 改**界面**（`lib/client.js`）→ **不用重启，HMR 会自动重建**（`/plugins/events` 上能看到
  `{"type":"rebuilt","id":"dsh-mi-remote","rev":"…"}`），刷新页面最稳
- 改**宿主**（`lib/index.js`）→ **必须重启 dsh**，否则新路由永远是 404
- 改**引擎**（`engine/*.py`）→ 重启链路即可（面板上停再启，或 `POST /mi-remote/api/bridge/auto`）
- 改**映射**（面板里保存）→ 引擎 1 秒内自动重读，不用重启

**判断宿主到底重启过没有**：`/mi-remote/api/bridge` 是否还 404、dsh 进程的 CreationDate。

---

## 八、已知限制与需要你知道的两件事

**① 自测曾经污染过你的映射（已修，但你要决定怎么处理）。**

`selftest.mjs` 里有一段会通过路由真的写 `mapping.json` 的 `vkeys` 表，注释写着"先备份、测完恢复"。
但它备份和恢复读的是**迁移前的老落点** `%LOCALAPPDATA%\dsh-mi-remote\mapping.json`，
而写入走的是新落点 `state/mapping.json` —— **两个不是同一个文件，恢复等于没做。**

后果：你 `state/mapping.json` 里的 `vkeys` 变成了自测写的那两个值 `{"ok":13,"up":38}`，
而**你原本那张完整的学习表**（`down:40 left:37 right:39 home:36 menu:93 tv:192 power:255`）
只留在旧落点那份里（`%LOCALAPPDATA%\dsh-mi-remote\mapping.json`，2026-10-10 那份）。

**影响**：`vkeys` 是旧 Raw Input 通路用的表，**当前链路（Frida 采集器 + read-engine）完全不读它**
—— python 引擎里没有一处引用。所以功能不受影响。

**已修**：备份与恢复现在读写同一个文件（跟插件同一落点），实测自测前后 `mapping.json` 哈希一致。
**你可以不管它**；如果你希望那张完整表回到当前映射里，从旧落点那份拷 `vkeys` 过来即可
（**别手改文件** —— 面板保存会整份覆盖，见第四节）。

**② 搜索高亮的实机表现没验过。**

代码与 HMR 重建都验了，但驱动界面时 DSH 窗口没抢到前台，**没有在真实页面上看到过那条蓝色高亮**。
刷新页面后按第六节的用法试一次即可确认。

**其余限制**：

- **C# 引擎没有 `ts` 时间戳**：本次只给 python 引擎加了。重启后 C# 引擎接手时，
  那段时间的日志又会没有时间。
- **`verify-render.mjs` 有 13 条过期断言**（49 PASS / 13 FAIL）：它们断言的面板元素
  （按键桥状态标记、总闸、锁定开关、链路体检四张卡…）**在 `lib/client.js` 里都还在**，
  是渲染桩找不到它们 —— 属于**动手封装之前就存在**的问题，不是这次改坏的。
  `scripts/selftest.mjs` 是 **108 PASS / 0 FAIL**，`tools/diag/_package-verify.mjs` 是 **45 / 0**。
- **界面布局没做过浏览器级像素验证**：离线冒烟验的是渲染树与断言。
- **日志只增不减**：`bridge-run.jsonl` 已涨到两万多行，尚未加轮转。

---

## 九、Windows 上踩过的坑（改代码前先看这几条）

**SendInput 的 `INPUT` 结构**：联合体必须放得下 x64 下最大的成员（`MOUSEINPUT` 32 字节）。
只放键盘结构会让 `INPUT` 变成 32 字节而不是 40，SendInput 直接报 87（参数错误）。

**定时器必须存进字段**：局部 `Timer` 会被 GC 回收，回调再也不触发 —— `--seconds` 因此静默失效过。

**改引擎之前先停掉正在跑的实例**：`KeyBridge.exe` 被自己占着时重新编译会失败，
而**编译器是先删旧文件再写新的** —— 失败之后 exe 直接没了（`error CS2012` + 文件消失）。
重新编译一次即可：

```powershell
Get-Process KeyBridge -EA SilentlyContinue | Stop-Process -Force
pwsh -File engine\build.ps1
```

**插件的 `inject` 必须覆盖 apply 真正读的 ctx 成员**。`ctx.interval()` / `ctx.shortcuts` 之类
不是 Context 自己的方法，而是服务混进来的 accessor —— 少了声明，apply 当场抛
`cannot get property "x" without inject`，条目进 failed，启动页显示「Failed to load plugins」。
（这个坑客户端半段踩过两次：`timer` 一次、`shortcuts` 一次。）

**采集器/引擎绝不能用 `stdio: 'ignore'`** —— 它把"启动即崩"藏了很久
（`ValueError: invalid literal for int(): '--sayall-owns-voice'`）。输出统一进 `state/*.log`。

**新引擎实现必须加进 `killStrayPipeline` 的名单**。Windows 不会在父进程死亡时连带杀死子进程。
漏过一次 `read-engine.py`，结果攒了 4 个引擎实例、每个动作执行多遍、音量触发两次。

**`.ps1` 里的中文必须存成 UTF-8 带 BOM**（PS 5.1 无 BOM 按 ANSI 解，中文会烂）。
改完跑 `node scripts/fix-bom.mjs`。

**所有控制台程序静默运行**：`windowsHide` / `-WindowStyle Hidden`，
常驻的用 `engine/diag/run-hidden.vbs` 中转。

---

## 十、验证快捷键命令到底注册上没有

注册成功与否看两个地方：

```javascript
// 1. 浏览器控制台有没有这行（有 = 某条被别的命令的默认键位撞掉了）
[dsh-mi-remote] 快捷键命令注册失败: remote.xxx ...

// 2. 命令注册了不等于能按 —— DSH 的判据是
//    shortcuts/src/client/registry.ts:119-123
//    没有绑定的命令 binding === null，压根不进快捷键表
```

所以七条命令**都自带默认键位**（只给 `web:windows` / `web:macos` ——
`isWebBindingAllowed` 对 `web:linux` 不放行 `Ctrl+Alt+` 这类两修饰键组合，给了会直接抛
`Unsupported Web shortcut`）。默认键位与面板预设表的一致性由 `selftest.mjs` 守着。
