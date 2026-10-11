# 机制说明与排障手册

配套文档：`README.md`（用法与结构）· `REVIEW_遥控器按键链路_20261011.md`（验证清单与问题分级）

---

## 一、采集器为什么是这个形态

### 为什么不能直接读 HID

遥控器的 BLE HID 报告由 Windows 蓝牙栈经 `WUDFHost.exe` 处理，**没有公开的、能在用户态同步拿到
"这一次报告里有哪些 usage"的接口**。Raw Input 能拿到按键，但拿到的是**已经翻译过的虚拟键码**，
而且**注入的键也会进来** —— 分不清"人按的"和"我们自己注入的"。

### 为什么用 Frida hook `NtDeviceIoControlFile`

`sayall-helper.exe` 里内嵌了一份 `rc003_agent.js`（5220 行），做法是**直接改写 HID 报告**。
本项目照搬了它的定位方式，但只读、不改写（除非语音键需要锁存）。

挂点与过滤条件（`engine/rc003-tap.py` 的 hook JS）：

| 条件 | 值 | 为什么 |
| --- | --- | --- |
| 函数 | `ntdll!NtDeviceIoControlFile` | 蓝牙栈把 HID 报告交给驱动层的必经之路 |
| `IoControlCode` | `0x80018483` | HID 的 `IOCTL_HID_READ_REPORT` |
| `inLen` | `== 8` | 请求头长度；别的调用不带这个形状 |
| `outLen` | `>= 9` | 至少一个 report ID + 一个 usage |
| `inBytes[4..5]` | `0x02 0x01` | report type = input |
| `outPtr[0]` | `0x01` | report ID = 1（键盘集合） |

命中后从 `outPtr` 按 **usage page / usage** 解析出这次报告里的键位列表。

### usage → 按键

```
0x00F1 back      0x0028 ok        0x0035 tv        0x004A home
0x004F right     0x0050 left      0x0051 down      0x0052 up
0x0065 menu      0x0066 power     0x007F volmute   0x0080 volup
0x0081 voldown   0x003E voice
```

（`0x00F1` 是 Consumer page 的"返回"；其余是 Keyboard page。）

### 采集器写出去的每一行

```json
{"usages": [53], "names": ["tv"], "latch": false, "toggled": false, "ht": 1791702803396, "t": 1791702803399}
```

- `usages`：这次报告里的 usage 列表（**空数组 = 全松开**）
- `latch`：是否正让 Windows 认为"左 Alt 按着"（语音键说话中）
- `ht`：hook 那一侧的时间戳（真实报告时刻）；`t`：落盘时刻。**两者差得多说明有积压**

**只在集合真的变了才写一行** —— 驱动会重复上报同一份内容，不去重会把日志和引擎都淹掉。

---

## 二、引擎的判定

两个实现，**行为必须一致**：

| | Python（`read-engine.py`） | C#（`KeyBridge.cs`） |
| --- | --- | --- |
| 取报告 | 轮询 `state/keys.jsonl`（6ms） | 读同一份文件（6ms） |
| 选谁 | 注入进程完整性 < Medium 时 | 否则 |
| 为什么两套 | 360 驱动在内存里时会把未签名 exe 压到 Low，注入无效 | 原生 exe 无 Python 依赖、启动快 |

自动选择在宿主侧：`probeEngineIntegrity()` 起一次 `KeyBridge.exe read` 跑 2.6 秒，
读它自报的 `integrity`；`< 0x2000`（Medium）且找得到 python ⇒ 用 Python 版。

### 三档判定

```
按下 ──┬─ 松手（该键没配双击）─────────────→ click
       ├─ 松手（配了双击）→ 320ms 内无第二次 → click
       ├─ 320ms 内再次松手 ────────────────→ double
       └─ 按住 ≥ 650ms ───────────────────→ hold
```

**为什么"没配双击就立刻执行"**：原来无条件等 320ms 双击窗口，每次单击都慢半拍。
现在只有该键真的配了双击动作时才等 —— 实测松手到执行从 ~370ms 降到 **24~37ms**。

### 注入

`SendInput`，**同时给 `wVk` 和 `wScan`**（扫描码由 `MapVirtualKeyW(vk, MAPVK_VK_TO_VSC)` 取）。
扫描码是硬要求，见 README 第三节约束一。

鼠标移动类动作走 `Injector.Move`（`MOUSEEVENTF_MOVE`），按住期间每 60ms 挪一次，
**松手由 `move-stop` 立刻停**（`StopMoveRepeat()`）。

---

## 三、排障决策树

### 按遥控器完全没反应

```
一、链路在跑吗
    powershell -File tools\kill-strays.ps1 之后
    POST /mi-remote/api/bridge/auto
    看返回的 engineImpl / enginePid / collectorPid

二、采集器收到报告了吗
    按一下遥控器，看 state\keys.jsonl 有没有新行
      有  → 采集器正常，问题在引擎
      没有 → 遥控器没连 / 采集器没挂上

三、引擎在跑吗
    state\bridge-run.jsonl 里有没有 {"type":"ready", ...}
    "error" 行写了什么

四、引擎执行了吗
    看有没有 {"type":"fire", ..., "ok":true}
      有 fire 但界面没动 → 注入被 UIPI 挡了（见下）
      没 fire            → 映射没配到这个键/档位
```

### `fire` 是 `ok:true` 但界面没反应

**几乎一定是完整性级别（UIPI）。** 低完整性进程不能向高完整性窗口注入，而 `SendInput` 照样返回成功。

```powershell
# 看引擎自报的级别
Select-String -Path state\bridge-run.jsonl -Pattern '"integrity"' | Select-Object -Last 1
# 12288=High 8192=Medium 4096=Low —— Low 就一定注不进高完整性窗口
```

**修**：让插件用 Python 引擎（它继承 `python.exe` 的 High）。插件会自动选，
但如果你手动指定过 `DSH_MIREMOTE_ENGINE`，把它清掉。

**根治**：重启机器让 360 的 `360Box64` / `360AntiHijack` 驱动彻底卸载
（它们 `StartMode=System`，卸载 360 后仍留在内存里）。

### 刷新页面后所有快捷键被触发一次

**症状**：每次刷新 DSH 页面，遥控器上配好的动作全部各执行一次。

**成因**（2026-10-11 查实，两个引擎都有）：

面板一挂载就调 `POST /bridge/auto`（`lib/client.js:2015`，用户要求不要总闸、自动拉起）。
宿主那条路由有个**复用分支**（`lib/index.js:1418`）：采集器还在跑时，只补起一个引擎、
**不动 `keys.jsonl`**。而引擎的读文件偏移量原来初始化成 **0**：

```python
offset = 0      # read-engine.py（C# 版同样：long offset = 0）
```

于是新引擎从**文件开头**读，把里面全部历史事件重放一遍 —— 每个动作各触发一次。

**修**：起点改成"首次看到文件时定在**当时的末尾**"，只处理新写进来的行。

```
Python：offset = None  →  首次看到文件时 offset = size，并报 {"type":"tail-from-end","bytes":N}
C#    ：offset = -1    →  同上
```

**⚠️ 但 `size < offset` 时仍要归零** —— 那是**文件被截断**（链路重拉会重建它），
截断后的内容全是新的，从头读才对。**"启动时跳过历史" 与 "截断后重读" 是两件事，必须分开。**

**复现与验证**：`tools/diag/_replay-test.py`（要先把脚本里的 POST 换成 node 调，
urllib 打那条路由会拿到 405）。手工复现步骤：

```
一、只杀引擎、保留采集器（这就是"刷新时"的状态）
二、往 keys.jsonl 追加几组会触发动作的「按下→松开」
三、POST /bridge/auto —— 应返回 reused=true
四、数 bridge-run.jsonl 里的 fire：期望 0
```

实测结果：`tail-from-end bytes=3054`，`fire` = **0** ✓

**顺带修掉的两个 BOM 问题**（同一个根因）：

`engine/build.ps1` 丢了 UTF-8 BOM，PowerShell 5.1 按 GBK 解中文，把字符串的收尾单引号吃掉：
`The string is missing the terminator` —— **编译直接挂**。`audio/read-battery.ps1` 同样是坏的。
`scripts/fix-bom.mjs` 原来只覆盖 `audio/` 下两个文件，已扩成**扫全插件所有 .ps1**（现在 8 个）。

### 一个动作执行好几遍 / 音量键触发两次

**多个引擎实例在跑。** Windows 不会在父进程死亡时连带杀死子进程，
而每个引擎都会独立注入一次。

```powershell
powershell -File tools\kill-strays.ps1     # 清干净
# 然后 POST /mi-remote/api/bridge/auto 重拉
```

**判定方法**：数进程（**注意排除你自己的查询命令**，命令行里带 `read-engine.py` 的
`Get-CimInstance` 会被自己的过滤条件匹配进来 —— 这个坑踩过两次）：

```powershell
@(Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -match 'read-engine\.py' -and $_.Name -like 'python*' }).Count
# 1 个实例 = 2 个进程（venv 外壳 + 真 python）
```

### 按一下触发好几个功能 / 页面乱跳

**看绑定是不是"会去动界面"的那几类：**

| 绑定 | 实际行为 |
| --- | --- |
| `Backspace` | 浏览器里、焦点不在输入框时 = **后退** |
| `MouseLeft` | **在光标位置真的左键点一下** —— 光标停在按钮上就是点它 |
| `MouseRight` | 同上，还会弹右键菜单 |

**这三个不是"某个功能"，是字面意义的按键/点击。** 换成 `Delete` 或具体动作即可。

### 长按攒不满 / 长按不触发

先排除多引擎（见上）。其次看 `ht` 间隔：一次物理按压在 `keys.jsonl` 里应当是
**一组干净的 `[X]` → `[]`**。如果看到 `[X] [] [X] []` 交替，就是**两个采集器同时往一个文件写**。

### 改了映射不生效

引擎每 1 秒检查一次 `mapping.json` 的 mtime，改了会自动重读（日志里
`{"type":"mapping-reloaded","buttons":N}`）。

**但如果映射是被"面板保存"覆盖掉的**：面板用它加载时的旧状态整份写入。
**不要手改 `mapping.json`** —— 要改就在面板里改。

### 日志里分不清新旧记录

**每条都带 `ts`（墙钟毫秒）**。没有 `ts` 的是旧格式，说明那段时间跑的是加 `ts` 之前的引擎。
C# 引擎**尚未加 `ts`**（已知限制）。

---

## 四、改代码时的硬约束清单

| # | 约束 | 违反的后果 |
| --- | --- | --- |
| 1 | 客户端的 `inject` 必须列全 apply 真正读的服务（`slots` / `timer` / `shortcuts`） | apply 抛错，整个条目进 failed，面板都不显示 |
| 2 | 采集器/引擎不能用 `stdio:'ignore'` | 启动即崩会被藏起来 |
| 3 | 新引擎实现必须加进 `killStrayPipeline` 的名单 | 攒实例 → 一个动作执行多遍 |
| 4 | 读不到 `mapping.json` 时**不能写默认值覆盖** | 用户配置丢失（`readMappingSafe` 守这条） |
| 5 | 注入必须同时设 `wVk` 与 `wScan` | DSH 匹配不上 `event.code`，静默失效 |
| 6 | 装饰性代码（改样式、加 DOM）必须自己吞异常 | 它会把 apply 带崩，连带后面所有注册 |
| 7 | `.ps1` 带中文必须 UTF-8 带 BOM | PS 5.1 按 ANSI 解，中文乱码 |
| 8 | 起控制台程序一律静默（`windowsHide` / `-WindowStyle Hidden`） | 屏幕上多一个抢焦点的窗口 |

---

## 五、面板与 DSH 的接口对照

| 面板动作 | 走什么 |
| --- | --- |
| 开某一栏（工作台/坐标系/…） | `ctx.get('sidebarRight').openTab('<panel id>')` |
| 切到某条会话 | `uiWorkspace.openSession(sessionId)`（`SessionTarget = SessionId \| SubagentAddress`，就是字符串） |
| 搜会话内容 | `sessions.search(query, signal)` → `{ ok, value: { items: [{ sessionId, snippet }] } }` |
| 会话列表 | `sessions.list.getSnapshot().items` → `SessionListEntry[]`，字段是 **`sessionId`** |
| 打开某条会话（DOM 路） | 点 `[data-row-key^="session:"]` —— 行自带 `onClick → onOpen(node.id)` |
| 搜索结果那棵树 | `[role="tree"][aria-label="搜索结果"]`（CSS Module 类名被哈希，选不中，只能用 aria-label） |

**五个面板 id**（量自各插件源码，别凭印象改）：

```
dsh-workdesktop:console        工作台      dsh-workdesktop/lib/client.js:11477
dsh-workdesktop:dashboard      驾驶舱      dsh-workdesktop/lib/client.js:11478
dsh-workdesktop:project-graph  工程图      dsh-workdesktop/lib/client.js:11483
dsh-coords:center              坐标系      dsh-coords/lib/client.js:891
dsh-modeling:center            建模中心    dsh-modeling/lib/client.js:2183
```

`scripts/selftest.mjs` 每次都回查这五个 id 与六处 DSH 契约定点是否仍然有效。
