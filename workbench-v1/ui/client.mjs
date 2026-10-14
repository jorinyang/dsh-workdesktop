/**
 * v1/ui/client.mjs —— **工作台页面的客户端脚本**（P4 交互层；需求 3.3.3–3.3.6 的"新增"与"点击弹详情"）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 为什么单独一个文件：服务端渲染（`shell.mjs`）负责"看得见"，这一层负责"点得动"。
 *   写接口早就通了（`api/server.mjs`，强制走 `write-routes.json` 登记表），缺的就是这一层。
 *
 * ★ 两条工程纪律
 *   ① 脚本以**字符串行数组**拼出来（不用模板字符串）—— 与 shell.mjs 同一原因：嵌套模板的
 *      语法错会指向无关行，定位成本极高。
 *   ② **自检用 `new Function()` 真编译一遍**：脚本语法错在服务端渲染时**看不出来**，
 *      只有浏览器里才炸，而这里没有浏览器可测 ⇒ 至少把"语法有效"这条守住。
 *
 * 交互口径
 *   · 点列表某行 ⇒ 按行序取该页列表里的对应项 id（服务端渲染顺序与接口返回顺序一致：同一份数据同一套排序），
 *     再取详情浮层（结构化内容 / 原始消息 / 相关上下文 / 可执行操作）
 *   · 「新增」⇒ 按页面类型弹出最小表单，POST 到登记表里的写路径；新增只落运行态，由筛选引擎双写知识库
 * ═══════════════════════════════════════════════════════════════════════════════
 */

/** 生成整段客户端脚本（apiBase 形如 http://127.0.0.1:8791/workdesktop/api/v1） */
export function clientScript(apiBase) {
  const L = [];
  L.push('(function () {');
  L.push('  var API = ' + JSON.stringify(String(apiBase || '').replace(/\/+$/, '')) + ';');
  L.push('  var main = document.querySelector("main");');
  L.push('  if (!main) return;');
  L.push('  var page = main.getAttribute("data-page") || "overview";');
  L.push('  var TYPE = { messages: "messages", todos: "todos", schedules: "schedules", notes: "notes" }[page];');
  // ★ 类型归一表（**只有这一张**）：单数 ↔ 复数。
  //   为什么必须有：服务端路由只认**复数**（`/detail/schedules/x` = 200，`/detail/schedule/x` = 404），
  //   而"从总览跳过来"时地址里带的类型是**单数**（`data-go="schedule"`）。
  //   ⇒ 凡是拿类型去拼路径或比对的地方，都先过这张表。
  //   ⚠️ 同一条信息散在多处就会漂（本项目栽过：登记表两份、卡名表两份都出过事）⇒ 只留这一份。
  L.push('  var CANON = { message: "messages", todo: "todos", schedule: "schedules", note: "notes", messages: "messages", todos: "todos", schedules: "schedules", notes: "notes" };');
  // ★★ 2026-10-12 修（**用户报"列表点不动"的最终根因**）：
  //   原来取 `.list` 的**第一个**，而页面上还有别的 `.list`（热力图下面那段「动态分析」）
  //   且它排在前面 ⇒ 监听绑到了分析文字上，用户点真正的行毫无反应。
  //   ⇒ 改取**专用标识** `jl-list`（由 `shell.mjs#listBlock` 只给数据列表加）。
  //     留 `.list` 兜底：万一某页只有旧的 `.list` 且里面有可点行，仍能绑上。
  L.push('  var list = main.querySelector(".jl-list") || main.querySelector(".list");');
  L.push('');
  L.push('  function el(tag, cls, text) { var d = document.createElement(tag); if (cls) d.className = cls; if (text !== undefined) d.textContent = text; return d; }');
  L.push('');
  L.push('  function overlay(title, rows, ops, onOp, det, extraNode) {');
  L.push('    var back = el("div", "overlay-back");');
  L.push('    var box = el("div", "overlay");');
  L.push('    box.appendChild(el("h2", null, title || "详情"));');
  L.push('    rows.forEach(function (r) {');
  // ★ 2026-10-13：`["__NODE__", <DOM 节点>]` 表示"这一行不是文字，是现成的节点"——
  //   给"跳转"那种要放按钮的行用（纯文本行塞不下按钮）。
  L.push('      if (r[0] === "__NODE__" && r[1] && r[1].nodeType) { box.appendChild(r[1]); return }');
  L.push('      var line = el("div", "ov-row");');
  L.push('      line.appendChild(el("span", "ov-k", r[0]));');
  L.push('      line.appendChild(el("span", "ov-v", r[1] === null || r[1] === undefined || r[1] === "" ? "—" : String(r[1])));');
  L.push('      box.appendChild(line);');
  L.push('    });');
  // ★ 2026-10-13 加：允许塞**自定义 DOM 节点**进来（图片那行要用 `<img>`，不是纯文本行）。
  //   挂在"结构化内容 / 原始消息 / 相关上下文"之后 —— 图紧跟原文，便于对照。
  //   ★ 同日改：也接受**数组** —— 待办详情要同时挂"图片行"和"交付物表单"两块，顺序照传。
  L.push('    (function putExtra(nd) { if (!nd) return; if (Array.isArray(nd)) { nd.forEach(putExtra); return } box.appendChild(nd) })(extraNode);');
  L.push('    if (ops && ops.length) {');
  L.push('      var bar = el("div", "ov-ops");');
  L.push('      ops.forEach(function (name) {');
  L.push('        var b = el("button", null, name);');
  L.push('        b.addEventListener("click", function () { onOp(name); });');
  L.push('        bar.appendChild(b);');
  L.push('      });');
  L.push('      box.appendChild(bar);');
  L.push('    }');
  // ★ 待处置候选的**一键创建**（用户 Q2："我在浮层点确认"）。
  //   三种去向都走**已登记**的写路径：待办/笔记 = 直接 POST；日程 = 走消息的 convert
  //   （因为日程契约要求具体起止时间，convert 那边会把它从消息里解出来，解不出会 409 并说明）。
  L.push('    var pend = det && det.detect && det.detect.pending ? det.detect.pending : [];');
  L.push('    if (det && det.type === "message" && pend.length) {');  L.push('      var pbar = el("div", "ov-ops");');
  L.push('      pend.forEach(function (c) {');
  L.push('        var b = el("button", "ov-pend", "建为" + KIND[c.kind]);');
  L.push('        b.addEventListener("click", function () { createFromCandidate(det.id, c.kind, b); });');
  L.push('        pbar.appendChild(b);');
  L.push('      });');
  L.push('      box.appendChild(pbar);');
  L.push('    }');
  L.push('    var close = el("button", "ov-close", "关闭");');
  L.push('    close.addEventListener("click", function () { document.body.removeChild(back); });');
  L.push('    box.appendChild(close);');
  L.push('    back.appendChild(box);');
  L.push('    back.addEventListener("click", function (ev) { if (ev.target === back) document.body.removeChild(back); });');
  L.push('    document.body.appendChild(back);');
  L.push('  }');
  L.push('');
  // ★★ 2026-10-13 修（**用户报"四个按钮点了没反应/提示未登记"** —— 这是那批症状的**共同根因**）。
  //
  // 原来这里只有一句：`var path = "/" + type + "/" + id + "/act";`
  //   —— 把"类型 + 动作"**整体压成一个通用路径**。可写路径登记表里**根本没有这条通用路由**：
  //
  //     消息  → `/messages/:id/replied`（已回复）或 `/messages/:id/convert`（转待办/转日程/转笔记）
  //     待办  → `/todos/:id/act`（done/hold/to-schedule）· `/todos/:id/deliverable`（交付物）
  //     日程  → `/schedules/:id/act`（done/to-todo）
  //     笔记  → `/notes/:id/analyze` · `/notes/:id/visualize`
  //
  //   ⇒ 只有**待办与日程**恰好叫 `act`，消息与笔记**必然 404**（用户看到的正是"未登记"那句提示）。
  //     用户说待办/日程的按钮也"没有响应"，是同一个 bug 的连坐：`op` 被塞在 `payload.op`，
  //     而消息/笔记那两条路要求 `payload.to`（转什么）—— 参数形状不同，压成一条就必然对不上。
  //
  //   ⇒ 改成**一张动作表**：每个动作写明"打到哪条已登记路由、带什么参数"。
  //     表格（而非 if 链）有个好处：**加动作时一眼能看出它落在哪条已登记路由上**，
  //     不会又出现"随手拼一个路径、结果没登记"。
  L.push('  var OP_ROUTE = {');
  L.push('    message: {');
  L.push('      "已回复":   { path: "/messages/{id}/replied" },');
  L.push('      "转待办":   { path: "/messages/{id}/convert", body: { to: "todo" } },');
  L.push('      "转日程":   { path: "/messages/{id}/convert", body: { to: "schedule" } },');
  L.push('      "转笔记":   { path: "/messages/{id}/convert", body: { to: "note" } }');
  L.push('    },');
  L.push('    todo: {');
  L.push('      "已完成":   { path: "/todos/{id}/act", body: { op: "已完成" } },');
  L.push('      "已搁置":   { path: "/todos/{id}/act", body: { op: "已搁置" } },');
  L.push('      "转日程":   { path: "/todos/{id}/act", body: { op: "转日程" } },');
  L.push('      "交付物":   { path: "/todos/{id}/deliverable", body: {} }');
  L.push('    },');
  L.push('    schedule: {');
  L.push('      "已完成":   { path: "/schedules/{id}/act", body: { op: "已完成" } },');
  L.push('      "转待办":   { path: "/schedules/{id}/act", body: { op: "转待办" } }');
  L.push('    },');
  L.push('    note: {');
  L.push('      "分析笔记": { path: "/notes/{id}/analyze" },');
  L.push('      "可视化构建": { path: "/notes/{id}/visualize" }');
  L.push('    }');
  L.push('  };');
  L.push('');
  L.push('  function doOp(type, id, name) {');
  // ★★ 2026-10-14 修（**真机点击抓到的**）：`OP_ROUTE` 的键是**单数**
  //   （`message` / `todo` / `schedule` / `note`），而调用方传进来的 `type` 是**复数**
 //   （`messages` / `todos` / `schedules` / `notes` —— 详情接口只认复数，见 `openDetail`）。
  //   ⇒ `OP_ROUTE[type]` 查不到 ⇒ `spec` 为空 ⇒ **四个页面的每个动作都弹"还没有接线"**。
  //
  //   ⚠️ 为什么上一轮没抓到：那次我验的是**映射表本身**（"表里有这几条、路径对不对"），
  //     而错在**查表用的键**——表是对的，查错了。⇒ 这类错只有"真点一下"才看得见。
  //   ⇒ 查表前先归一：与 `CANON` 反向的那一步（复数 → 单数），查不到再原样试一次。
  L.push('    var SING = { messages: "message", todos: "todo", schedules: "schedule", notes: "note" };');
  L.push('    var bucket = OP_ROUTE[type] || OP_ROUTE[SING[type]] || null;');
  L.push('    var spec = bucket ? bucket[name] : null;');
  L.push('    if (!spec) { alert("这个动作还没有接线：" + type + " / " + name + "（界面给了按钮，但没对应的已登记写路径）"); return; }');
  L.push('    var path = spec.path.replace("{id}", id);');
  L.push('    var payload = { op: name };');
  L.push('    for (var k in (spec.body || {})) payload[k] = spec.body[k];');
  // 转日程要具体起止时间（契约不接受空）：先问一次，用户不给就交给服务端按消息解析（它会 409 并说明）
  L.push('    if (spec.body && spec.body.to === "schedule") {');
  L.push('      var st = window.prompt("转日程需要具体起止时间（YYYY-MM-DDTHH:mm）。留空则由服务端从消息里解析：", "");');
  L.push('      if (st) { payload.start = st; payload.end = st; }');
  L.push('    }');
  L.push('    if (spec.body && spec.body.to === "todo") {');
  L.push('      var tp = window.prompt("待办主题（留空则用消息概括）：", "");');
  L.push('      if (tp) payload.topic = tp;');
  L.push('    }');
  L.push('    fetch(API + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payload: payload }) })');
  L.push('      .then(function (r) { return r.json().then(function (b) { return { code: r.status, body: b }; }); })');
  L.push('      .then(function (x) {');
  L.push('        if (x.code === 404) { alert("这个操作还没有对应的写路径（未登记）：" + path); return; }');
  L.push('        if (x.code >= 400) { alert("操作失败：" + JSON.stringify(x.body.error || x.body.errors || x.body)); return; }');
  L.push('        location.reload();');
  L.push('      })');
  L.push('      .catch(function (e) { alert("操作请求失败：" + e.message); });');
  L.push('  }');
  L.push('');
  L.push('  var KIND = { schedule: "日程", todo: "待办", note: "笔记" };');
  L.push('  var PAGE_OF = { message: "messages", todo: "todos", schedule: "schedules", note: "notes" };');
  L.push('');
  // 待处置候选 ⇒ 确认创建。三种去向都走**同一个已登记入口** `messages/:id/convert`
  // （不新开写路径）：转待办、转笔记直接建；转日程要先从消息里解出具体起止时间，
  // 解不出就 409，由这里把话说清楚（而不是"建失败"）。
  L.push('  function createFromCandidate(msgId, kind, btn) {');
  L.push('    btn.disabled = true;');
  L.push('    fetch(API + "/messages/" + msgId + "/convert", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payload: { to: kind } }) })');
  L.push('      .then(function (r) { return r.json().then(function (b) { return { code: r.status, body: b }; }); })');
  L.push('      .then(function (x) {');
  L.push('        if (x.code === 409) { alert("这条消息里解析不出具体时间，先补上时间再建日程：\\n" + (x.body.error || "") + "\\n" + (x.body.why || "")); btn.disabled = false; return; }');
  L.push('        if (x.code >= 400) { alert("创建失败：" + JSON.stringify(x.body.errors || x.body.error || x.body)); btn.disabled = false; return; }');
  L.push('        location.reload();');
  L.push('      })');
  L.push('      .catch(function (e) { alert("创建请求失败：" + e.message); btn.disabled = false; });');
  L.push('  }');
  L.push('');
  // ══════════════════════════════════════════════════════════════════════════
  // **待办的结果交付物入口**（2026-10-13 加，用户第 9 条）
  //
  // 用户原话：「待办的详情页应该还有一个**结果交付物提交的入口**，
  //   可以**直接粘贴文件 / 填写链接 / 填写文字**。」
  //
  // 走的是**已经登记的**写路径 `POST /todos/:id/deliverable`（实测 HTTP 200，服务端会：
  //   把 `text` 追加进 `deliverables`；`file` 是本机路径时**复制进 `Other/Inflow/文件/`** 并记 `attachment`；
  //   同名同大小**不重复复制**（幂等））。
  //
  // ⚠️ 关于"**直接粘贴文件**"：浏览器里粘贴一个文件，拿到的是**文件内容**，拿不到本机路径
  //   （安全模型如此）。服务端那条路收的是**路径**（它和你在同一台机器上，所以路径是可用的）。
  //   ⇒ 这一步给的是**填本机文件路径**；真要"粘贴即上传"，得再加一条收 multipart 的上传通道
  //     （服务端目前没有收 body 存文件的入口，查过）。**这一条我如实标出来，不假装已经支持。**
  // ══════════════════════════════════════════════════════════════════════════
  L.push('  function deliverForm(todoId) {');
  L.push('    var wrap = el("div", "dv-form");');
  L.push('    wrap.appendChild(el("div", "dv-title", "提交结果 / 交付物"));');
  // ★★ 2026-10-14 改（用户裁定：「直接粘贴文件上传交付物请做掉，**填写本机文件路径即可**」）：
  //   三段输入的**措辞改清楚** —— 原来写「附件（本机文件路径）」，容易被读成"要上传一个文件"。
  //   实测的机制：浏览器里**粘贴一个文件**，拿到的是**文件内容**、拿不到路径（安全模型如此）；
  //   而这条写路径收的正是**路径**（服务端与你在同一台机器上，拿到路径就能把文件复制进知识库的归档目录）。
  //   ⇒ 所以第二段明确写成「附件路径（粘贴本机路径）」，并在标题下**加一行说明**讲清怎么用。
  //     这样界面说的和实际做的对得上 —— 比留一个让人猜的标签强。
  L.push('    wrap.appendChild(el("div", "dv-hint", "三段都可选，至少填一段：文字说明 / 链接 / 附件路径。附件请**粘贴本机完整路径**（浏览器拿不到你复制的文件本身，服务端按路径去取）。"));');
  L.push('    var F = [["text", "文字说明", "写清楚做了什么、结论是什么"], ["link", "链接", "https://…"], ["file", "附件路径（粘贴本机路径）", "例如 C:\\\\Users\\\\…\\\\方案.docx"]];');
  L.push('    var inputs = {};');
  L.push('    F.forEach(function (f) {');
  L.push('      var row = el("div", "dv-row");');
  L.push('      row.appendChild(el("span", "ov-k", f[1]));');
  L.push('      var inp = document.createElement("input");');
  L.push('      inp.type = "text"; inp.className = "ov-input"; inp.placeholder = f[2] || f[1];');
  L.push('      row.appendChild(inp); wrap.appendChild(row); inputs[f[0]] = inp;');
  L.push('    });');
  L.push('    var bar = el("div", "ov-ops");');
  L.push('    var ok = el("button", null, "提交交付物");');
  L.push('    var msg = el("span", "cap", ""); msg.style.cssText = "font-size:12px;color:var(--c-mute);margin-left:8px";');
  L.push('    bar.appendChild(ok); bar.appendChild(msg); wrap.appendChild(bar);');
  L.push('    ok.addEventListener("click", function () {');
  L.push('      var payload = {};');
  L.push('      ["text", "link", "file"].forEach(function (k) { var v = String(inputs[k].value || "").trim(); if (v !== "") payload[k] = v });');
  L.push('      if (!payload.text && !payload.file) { msg.textContent = "至少填一项：文字说明 或 附件路径"; return }');
  L.push('      ok.disabled = true; msg.textContent = "提交中…";');
  L.push('      fetch(API + "/todos/" + todoId + "/deliverable", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payload: payload }) })');
  L.push('        .then(function (r) { return r.json().then(function (b) { return { code: r.status, body: b } }) })');
  L.push('        .then(function (x) {');
  L.push('          if (x.code >= 400) { msg.textContent = "失败：" + JSON.stringify(x.body.error || x.body.errors || x.body).slice(0, 150); ok.disabled = false; return }');
  L.push('          msg.textContent = "已提交（" + (x.body.count || 0) + " 条交付物）"; location.reload();');
  L.push('        })');
  L.push('        .catch(function (e) { msg.textContent = "请求失败：" + e.message; ok.disabled = false });');
  L.push('    });');
  L.push('    return wrap;');
  L.push('  }');
  L.push('');
  // ══════════════════════════════════════════════════════════════════════════
  // **跨层通道：请求面板切换**（2026-10-13 加，用户第 11 条）
  //
  // 用户原话：「『可视化构建』字段…如果该笔记已经被可视化，在此处应该显示的是
  //   **跳转到对应可视化构建的按钮**，点击之后可以直接跳转到工程图/坐标系/建模中心
  //   的笔记对应的可视化构建文档。」
  //
  // 这一页跑在**插件 iframe 里**，够不到插件的 `ctx` ⇒ 只能**请求父窗口去切**。
  //   两端约定（**必须与插件侧那段一致**，改一处要同时改另一处）：
  //     `window.parent.postMessage({ type: 'dsh-workbench:open-panel', panel: '<id>' }, location.origin)`
  //   插件侧校验：来源站 + 发消息的确实是它嵌的 iframe + panel 在白名单里，然后调 `openTab`。
  //
  // ⚠️ 两种打开方式要区别对待：
  //   · 面板内嵌（`/workdesktop/api/yishu/<页>`）：`window.parent !== window` ⇒ 真发消息；
  //   · **本地直开**（双击 `./notes.html`）：没有父窗口可切 ⇒ **如实说"这个按钮要在面板里点才有效"**。
  //     不给一个点了什么都不发生的按钮 —— 这个项目为此返工过好几轮。
  // ══════════════════════════════════════════════════════════════════════════
  L.push('  var VISUAL_PANEL = { coordinates: "dsh-coords:center", project_graph: "dsh-workdesktop:project-graph", modeling: "dsh-modeling:center" };');
  L.push('  function askOpenPanel(tool, btn) {');
  L.push('    var panel = VISUAL_PANEL[tool];');
  L.push('    if (!panel) { alert("这个可视化工具还没有对应的面板：" + tool); return }');
  L.push('    if (window.parent === window) { alert("这个按钮要在工作台面板里点才有效（现在是单独打开这一页）"); return }');
  L.push('    try { window.parent.postMessage({ type: "dsh-workbench:open-panel", panel: panel }, location.origin); }');
  L.push('    catch (e) { alert("请求切换面板失败：" + e.message); return }');
  L.push('    if (btn) { var old = btn.textContent; btn.disabled = true; btn.textContent = "已请求切换…"; window.setTimeout(function () { btn.disabled = false; btn.textContent = old; }, 2500) }');
  L.push('  }');
  L.push('');
  L.push('  function openDetail(type, id) {');  // ★ 2026-10-12 修：**类型一律先归一成复数**再拼路径。
  //   为什么必须：服务端路由是 `^/detail/([a-z]+)/([A-Za-z0-9_]+)$`，而**只有复数能取到**
  //   （`/detail/schedules/x` = 200，`/detail/schedule/x` = 404）。
  //   而"跨页跳转"那一路是从总览的 `data-go` 拿的类型，那是**单数**（`schedule`）
  //   ⇒ 落页后自动开详情时请求单数路径 ⇒ 404 ⇒ 走 `det.error` 分支弹 alert、**浮层永远不出现**。
  //   诊断实测就是这么抓到的（点列表项"没反应"，控制台一条 404）。
  //   ⇒ 统一在这里归一：单数 → 复数，认不出就原样（交给服务端判，它 404 时会列出可用类型）。
  L.push('    type = CANON[type] || type;');
  L.push('    fetch(API + "/detail/" + type + "/" + id).then(function (r) { return r.json(); }).then(function (det) {');
  L.push('      if (det && det.error) { alert("取详情失败：" + det.error); return; }');
  L.push('      var seen = det.structured || {}; var orig = det.original || {};');
  L.push('      var rec = (det.context && det.context.recalled) || [];');
  L.push('      var recallError = det.context && det.context.recallError;');
  // ⚠️ 2026-10-14 **删掉了原来那两行**：它们把召回材料列成「路径（相似度）」——
  //   而用户这一轮在四个页面的详情里**都点名**：「**不得显示相关上下文的文件路径**」。
  //   ⇒ 现在只展示服务端概括好的那段话（见下面 `ctxSummary` 那一段）；
  //     原文片段与路径**一律不展示**，哪怕概括失败也不退回去列路径（那是用户明确禁止的）。
  //   （`rec` / `recallError` 仍取着 —— 概括那一路要用到它们。）
  // ★★ 2026-10-13 改（用户第二次提到图片显示）：
  //   「显示图片在详情页中这个能力，**在红色框中应该直接显示图片消息几个字即可，不需要有这么长的链接**。」
  //   原来「原始消息」这一行把 `[图片消息](mediaId=@lQLPKck4…AA)…` **整串**打出来了 ——
  //   那串 mediaId 又长又没有任何阅读价值，把正文挤到看不见。
  //   ⇒ 显示上换成「［图片消息］」四个字（**只换呈现**；`payload.raw` 一个字都不动，
  //     原始记录必须完整可回查 —— 这与列表那边用的是同一条规矩）。
  L.push('      var rawShown = String(orig.raw || "").replace(/\\[(图片|视频|语音|文件)消息\\]\\(mediaId=[^)\\s]*\\)?/g, "［$1消息］").replace(/mediaId=[^)\\s]*/g, "").replace(/\\s{2,}/g, " ").trim();');
  // ★「结构化内容」那一行同样要去链接：实测它取的是 `seen.raw`（消息的结构化原文），
  //   与「原始消息」是同一段文字的两种取法 ⇒ 只改一处的话，**mediaId 会从另一行漏出来**
  //   （真机验证抓到的：原始消息干净了、结构化内容还挂着两处）。
  L.push('      var seenShown = String(seen.topic || seen.raw || seen.summary || "")');
  L.push('        .replace(/\\[(图片|视频|语音|文件)消息\\]\\(mediaId=[^)\\s]*\\)?/g, "［$1消息］")');
  L.push('        .replace(/mediaId=[^)\\s]*/g, "").replace(/\\s{2,}/g, " ").trim();');
  // ★★ 2026-10-14 改（用户第 4/5/6/7 条**逐条点名**）：详情里的结构化内容要**拆成独立字段**，
  //   不得合并成一个「结构化内容」。
  //     消息 = 来信渠道 / 发信人 / 信息原文
  //     待办 = 待办主题 / 截止时间 / 发布人 / 执行人 / 待办详情
  //     日程 = 主题 / 起止时间 / 地点 / 参与人 / 日程详情
  //     笔记 = 主题 / 时间 / 内容
  //   原来是**所有类型共用**三行（结构化内容 / 原始消息 / 相关上下文）—— 字段名与内容都对不上。
  //   ⇒ 按类型各给一组行；公共的「相关上下文」等后面统一追加。
  L.push('      var rows = [];');
  L.push('      var CH = { dingtalk: "钉钉", feishu: "飞书", weixin: "微信", imessage: "iMessage", manual: "工作台", mail: "邮件", minutes: "听记" };');
  L.push('      var chan = CH[String(orig.channel || seen.channel || "")] || String(orig.channel || seen.channel || "—");');
  L.push('      var JOIN = function (v) { return Array.isArray(v) ? (v.join("、") || "—") : (v || "—"); };');
  L.push('      if (type === "messages") {');
  L.push('        rows.push(["来信渠道", chan]);');
  L.push('        rows.push(["发信人", orig.sender || seen.sender || "—"]);');
  //          ★ 图片消息：正文只显示「［图片消息］+ 文字」，**链接不进来**（用户第 7 条）；图在下面单独嵌。
  L.push('        rows.push(["信息原文", rawShown || "—"]);');
  L.push('      } else if (type === "todos") {');
  L.push('        rows.push(["待办主题", seen.topic || "—"]);');
  L.push('        rows.push(["截止时间", seen.due || "—"]);');
  L.push('        rows.push(["发布人", seen.publisher || "—"]);');
  L.push('        rows.push(["执行人", seen.executor || "—"]);');
  L.push('        rows.push(["待办详情", seen.detail || "—"]);');
  L.push('      } else if (type === "schedules") {');
  L.push('        rows.push(["主题", seen.topic || "—"]);');
  L.push('        rows.push(["起止时间", (seen.start || "—") + " ~ " + (seen.end || "—")]);');
  L.push('        rows.push(["地点", seen.place || "—"]);');
  L.push('        rows.push(["参与人", JOIN(seen.participants)]);');
  L.push('        rows.push(["日程详情", seen.detail || "—"]);');
  L.push('      } else if (type === "notes") {');
  L.push('        rows.push(["主题", seen.topic || "—"]);');
  L.push('        rows.push(["时间", seen.date || "—"]);');
  L.push('        rows.push(["内容", seen.content_md || seenShown || "—"]);');
  L.push('      } else {');
  //         兜底：认不出的类型仍给一行原文，**不要什么都不显示**
  L.push('        rows.push(["结构化内容", seenShown || "—"]);');
  L.push('      }');
  // ★★ 2026-10-14 改（用户第 4/5/6/7 条都点名这条）：
  //   「相关上下文：应检索 RAG 知识库和本身知识库；**将相关内容通过 LLM 概括后展示**；
  //     **不得显示相关上下文的文件路径**。」
  //   ⇒ 原来列的是"路径（相似度）" —— 正是用户点名不许出现的东西。
  //     现在只显示**服务端概括好的那段话**；还在算就显示"正在概括…"；算不出来就如实说原因。
  //   ⚠️ 原文片段与路径**一律不展示**（哪怕概括失败也不退回去列路径 —— 那是用户明确禁止的）。
  L.push('      var ctxSummary = det.contextSummary;');
  L.push('      var ctxText;');
  L.push('      if (ctxSummary) ctxText = ctxSummary;');
  L.push('      else if (det.contextSummaryPending) ctxText = "正在概括（后台算，重新打开这条就能看到）";');
  L.push('      else ctxText = det.contextSummaryError ? ("暂无：" + det.contextSummaryError) : "暂无相关资料";');
  L.push('      rows.push(["相关上下文", ctxText]);');
  // ★★ 2026-10-13 加（用户第 7 条）：「点击消息列表中的对应图片消息进入详情后，**需要能够显示出该图片**。」
  //   实测：图片消息的 `payload.fileRef` 指向 `Other/Inflow/文件/<月>/<mediaId>.<ext>`，文件都在（35/35）。
  //   而浏览器取不到 —— 所以新开了一条只读取图通道 `GET /v1/file?p=<相对路径>`
  //   （**只允许 Other/Inflow 之下、拒路径穿越、限扩展名**，见 server.mjs 里那段安全注释）。
  //   这一行把图**直接嵌进浮层**：用 `<img>`，不用新窗口，处置动作还在同一屏。
  //   取不到时**如实说**（文件被清掉 / 通道 403），不留一个破图占位。
  // ★ 2026-10-14（用户第 4 条）：「点击图片消息进入详情后，**信息内容中显示对应图片，不单开字段**」。
  //   ⇒ 图**不再单占一行**，而是**接在「信息原文」那一格下面**（同一格内换行），字段数不变。
  L.push('      var imgRef = (type === "messages") ? (orig.fileRef || (det.structured && det.structured.fileRef) || null) : null;');
  L.push('      var imgWrap = null;');
  L.push('      if (imgRef) {');
  L.push('        imgWrap = document.createElement("div"); imgWrap.className = "ov-imgwrap";');
  L.push('        var img = document.createElement("img");');
  L.push('        img.alt = "消息图片"; img.className = "ov-img";');
  L.push('        var note = document.createElement("div"); note.className = "ov-imgnote"; note.textContent = "载入中…";');
  L.push('        img.onload = function () { note.textContent = ""; };');
  L.push('        img.onerror = function () { note.textContent = "取不到图片（文件可能已被清理，或取图通道拒绝了这一条）"; };');
  L.push('        img.src = API + "/file?p=" + encodeURIComponent(imgRef);');
  L.push('        imgWrap.appendChild(img); imgWrap.appendChild(note);');
  L.push('      }');
  // ★★ 2026-10-13 加（用户第 7 条）：「点击消息列表中的对应图片消息进入详情后，**需要能够显示出该图片**。」
  //   实测：图片消息的 `payload.fileRef` 指向 `Other/Inflow/文件/<月>/<mediaId>.<ext>`，文件都在（35/35）。
  //   而浏览器取不到 —— 所以新开了一条只读取图通道 `GET /v1/file?p=<相对路径>`
  //   （**只允许 Other/Inflow 之下、拒路径穿越、限扩展名**，见 server.mjs 里那段安全注释）。
  //   这一行把图**直接嵌进浮层**：用 `<img>`，不用新窗口，处置动作还在同一屏。
  //   取不到时**如实说**（文件被清掉 / 通道 403），不留一个破图占位。
  // ★ 2026-10-14 改（用户第 4 条）：「点击图片消息进入详情后，**信息内容中显示对应图片，不单开字段**。」
  //   ⇒ 把图**接进「信息原文」那一格**（同一格内换行），**不再单占一行** —— 字段数不变。
  //     上一版是另起一行叫「图片」，那正是用户说的"单开字段"。
  L.push('      if (imgWrap) {');
  L.push('        for (var ri = 0; ri < rows.length; ri++) {');
  L.push('          if (rows[ri][0] === "信息原文") { rows[ri] = ["__NODE__", (function (rv, iw) {');
  L.push('            var line = document.createElement("div"); line.className = "ov-row";');
  L.push('            line.appendChild(el("span", "ov-k", "信息原文"));');
  L.push('            var cell = document.createElement("span", "ov-v");');
  L.push('            cell.appendChild(document.createTextNode(String(rv || "—")));');
  L.push('            cell.appendChild(iw);');
  L.push('            line.appendChild(cell); return line;');
  L.push('          })(rows[ri][1], imgWrap)]; break }');
  L.push('        }');
  L.push('      }');
  // ══════════════════════════════════════════════════════════════════════════
  // ★★ 2026-10-13 改（用户第 11 条）：笔记详情要有**分析与建议**和**可视化构建**两项，
  //    且可视化那一项**没建时要显示"待构建"**、建过时要能看到结果。
  //
  // 改动前：`分析与建议` 只在有 `analysis.text` 时出现（没有就整行不显示）；
  //   `可视化` 只在有 `visual` 时出现，而且**没建的时候整行消失** ——
  //   用户看到的是"详情页里根本没有这两个字段"，而不是"这两项还没做"。
  //   两件事不一样：**字段缺失**看着像功能没做，**"待构建"**才是如实的状态。
  //   ⇒ 现在两种情况都出一行，文案按状态走。
  //
  // ⚠️ 关于"点击跳转到坐标系/工程图/建模中心"：**这一轮没做，如实说明**。
  //   实测这三种可视化都是**右侧栏面板**（`dsh-coords:center` / `dsh-modeling:center` / 工程图），
  //   而本页跑在 iframe 里、插件的客户端**没有对外暴露任何"按 id 切面板"的通道**
  //   （查过 `postMessage` / `location.hash` / 全局函数，都没有）。
  //   要做得先加一条跨层通道（页面 postMessage → 插件切面板），那是另一件事。
  //   ⇒ 现在**把落点如实显示出来**（工具 + 路径/名字/id），人能自己找过去；
  //     不做一个点了没反应的按钮（这个项目已经因为"点了没反应"返工过好几轮）。
  L.push('      if (det.analysis && det.analysis.text) {');
  L.push('        rows.push(["分析与建议", det.analysis.text + (det.analysis.contextCount !== undefined ? ("\\n（召回 " + det.analysis.contextCount + " 条材料作依据）") : "")]);');
  L.push('      } else if (det.analysis && det.analysis.error) {');
  L.push('        rows.push(["分析与建议", "未完成：" + det.analysis.error]);');
  L.push('      } else if (type === "notes") {');
  L.push('        rows.push(["分析与建议", "待分析（点下方「分析笔记」即可生成；分析引擎只召回不调模型，成本近零）"]);');
  L.push('      }');
  L.push('      var v = det.analysis && det.analysis.visual;');
  L.push('      var TOOL = { coordinates: "坐标系", project_graph: "工程图", modeling: "建模中心" };');
  L.push('      if (type === "notes") {');
  L.push('        if (v && v.built === true) {');
  // 已构建：把**落点**写清楚（工具 + 名字/路径/id）—— 这是人能据此找过去的凭据
  L.push('          var loc = String(v.ref || v.name || "");');
  L.push('          rows.push(["可视化构建", "已构建：" + (TOOL[v.tool] || v.tool || "") + "\\n" + loc]);');
  // ★★ 2026-10-13 加（用户第 11 条）：已可视化时给一个**真的能跳**的按钮。
  //   走上面那条跨层通道（本页 postMessage → 插件切面板）；落点仍旧一并写出来，
  //   因为"跳过去之后看哪一份"也得让人知道（面板里可能有好几份）。
  L.push('          if (VISUAL_PANEL[v.tool]) {');
  L.push('            var vrow = el("div", "ov-row");');
  L.push('            vrow.appendChild(el("span", "ov-k", "跳转"));');
  L.push('            var vbtn = el("button", null, "打开" + (TOOL[v.tool] || "可视化"));');
  L.push('            vbtn.addEventListener("click", function () { askOpenPanel(v.tool, vbtn) });');
  L.push('            var vcell = el("span", "ov-v"); vcell.appendChild(vbtn); vrow.appendChild(vcell);');
  L.push('            rows.push(["__NODE__", vrow]);');
  L.push('          }');
  L.push('        } else if (v && v.suggested) {');
  L.push('          rows.push(["可视化构建", "待构建 —— 建议用「" + (TOOL[v.suggested] || v.suggested) + "」\\n" + (v.why || "") + (v.error ? ("\\n（上次构建失败：" + v.error + "）") : "")]);');
  L.push('        } else if (v && v.error) {');
  L.push('          rows.push(["可视化构建", "待构建（上次尝试失败：" + v.error + "）"]);');
  L.push('        } else {');
  L.push('          rows.push(["可视化构建", "待构建（点下方「可视化构建」让工具判定该用哪个）"]);');
  L.push('        }');
  L.push('      } else if (v) {');
  L.push('        rows.push(["可视化", v.built === true ? ("已建：" + (v.tool || "") + " · " + (v.name || v.ref || "")) : (v.suggested ? ("建议 " + v.suggested + " —— " + (v.why || "")) : "")]);');
  L.push('      }');
  L.push('      if (det.analysis && det.analysis.error && type !== "notes") rows.push(["分析未完成", det.analysis.error]);');
  L.push('      if (det.deliverables && det.deliverables.length) rows.push(["结果 / 交付物", det.deliverables.map(function (d) { return d.text || d.ref || ""; }).join("\\n")]);');
  // ★ 用户 Q2 裁定的前端那一半：判据不足的候选项标「待处置」，并给**一键创建**。
  //   高置信的已经被自动建过了（这里只显示"已建"的结果），所以这里出现的都是"要你点一下"的。
  L.push('      if (det.detect && det.detect.pending && det.detect.pending.length) {');
  L.push('        rows.push(["待处置候选", det.detect.pending.map(function (c) { return KIND[c.kind] + "（" + c.confidence + "）：" + c.why; }).join("\\n")]);');
  L.push('      }');
  L.push('      if (det.detect && det.detect.created && det.detect.created.length) {');
  L.push('        rows.push(["已自动创建", det.detect.created.map(function (c) { return KIND[c.kind] + "（" + c.action + "）"; }).join("\\n")]);');
  L.push('      }');
  // ★ 待办额外挂"结果交付物"表单（用户第 5 条）。
  //   （图片**不再走这里** —— 2026-10-14 起它嵌在「信息原文」那一格里，见上面那段。）
  L.push('      var extras = [];');
  L.push('      if (type === "todos") extras.push(deliverForm(id));');
  // ★ 浮层**标题**也要用剥过的文字：实测标题取的是 `seen.raw`（结构化原文），同一串链接会从
  //   第三处漏出来（真机验证连抓两次：先修「原始消息」、再修「结构化内容」，最后才轮到标题）。
  //   三处都是"同一段文字的三种取法" —— 所以**统一走 `seenShown`**，别再各取各的。
  L.push('      var titleShown = String(seen.topic || seenShown || "").slice(0, 80);');
  L.push('      overlay(titleShown || "详情", rows, det.availableOps || [], function (name) { doOp(type, id, name); }, det.detect, extras);');
  L.push('    }).catch(function (e) { alert("取详情失败：" + e.message); });');
  L.push('  }');
  L.push('');
  L.push('  if (list && TYPE) {');
  // ★ 诊断锚点（2026-10-12 加，**用户报"点列表项没反应"时用来定位**）：
  //   这一行会在页面脚本执行时把"容器找到没有、页面类型、可点行数"写到控制台。
  //   为什么留着：这个毛病（监听没绑上 ⇒ 点了毫无反应、连报错都没有）**从现象上完全看不出来**，
  //   没有这条锚点就只能靠猜。它只输出一行，不影响任何行为。
  L.push('    console.log("[工作台] 列表监听已绑 · page=" + page + " · 容器=" + (list.className || list.tagName) + " · 可点行=" + list.querySelectorAll("li[data-id]").length);');
  L.push('    list.addEventListener("click", function (ev) {');
  L.push('      var li = ev.target.closest ? ev.target.closest("li") : null;');
  L.push('      if (!li) return;');
  // ★ 按 DOM 上的 `data-id` 取（服务端写入）——**不再按行序推断**。
  //   旧做法是"点击行 ⇒ 按行序取接口列表第 idx 条"，而页面给全量、接口按页签过滤
  //   ⇒ 页签一变行序就错位，点第 3 行会开第 5 条（安静的错）。见 shell.mjs#listBlock 的注释。
  L.push('      var id = li.getAttribute("data-id");');
  L.push('      if (!id) { alert("这一行没有带 id（服务端未写入 data-id）"); return; }');
  L.push('      openDetail(TYPE, id);');
  L.push('    });');
  L.push('  }');
  L.push('');
  // ★ 总览的三类提醒：点一条 ⇒ 跳到对应页面并把那一条的详情打开（需求 3.3.2 原话：
  //   "点击可跳转到对应的页面（待办/笔记/日程/信息）并打开详情页"）。
  //   同一页面内点 ⇒ 直接开浮层；跨页面 ⇒ **真的换地址**，由目标页的脚本接手。
  //
  // ★★ 2026-10-12 修（**用户报"点击无反应"之后才发现的真错**）：
  //   原实现是
  //       location.hash = "#" + dest + "?open=" + kind + ":" + id;  location.reload();
  //   —— 它在**当前页**挂一个片段（`#schedules?open=…`），然后 reload **同一个地址**。
  //   那个 `#` 后面不是路径，浏览器只会做"页内锚点"处理 ⇒ **永远跳不过去**，
  //   用户看到的就是"点了没反应"。诊断实测：点「日程」统计后地址停在同一页、只多了个 `#`。
  //   ⇒ 改成**按当前地址推出的相对文件名**跳转，两种场景都对：
  //       面板内嵌：/workdesktop/api/yishu/overview  →  schedules?open=…   （该路由**不认 .html 后缀**，实测带后缀只回 182B 空页）
  //       本地直开：./overview.html                 →  schedules.html?open=…
  //     判定办法：看当前地址**最后一段**是否以 `.html` 结尾 —— 是就带后缀，不是就不带。
  //     同时也对上"目标页优先读 `?open=` 查询串"（见下面目标页接手那段）。
  L.push('  function pageUrl(dest) {');
  L.push('    var here = location.pathname.split("/").pop() || "";');
  L.push('    var tail = /\\.html$/i.test(here) ? dest + ".html" : dest;');
  L.push('    return tail;');
  L.push('  }');
  L.push('  if (page === "overview" && list) {');
  L.push('    list.addEventListener("click", function (ev) {');
  L.push('      var li = ev.target.closest ? ev.target.closest("li") : null;');
  L.push('      if (!li) return;');
  L.push('      var id = li.getAttribute("data-id"); var kind = li.getAttribute("data-go");');
  L.push('      if (!id || !kind) return;');
  L.push('      var dest = PAGE_OF[kind];');
  // ★★ 2026-10-13 改（用户裁定，原话）：
  //   「今日总览当中的重要日程行程下面的清单，点击日程之后，应该是直接打开日程的详情浮窗其中。
  //     可以直接处置这个日程是转代办，还是已完成，**不需要直接跳转到日程页面**。
  //     『逾期/临期任务』下面的任务，以及『长期未回复的消息』当中的消息，和日程一样，
  //     都是点击之后直接打开弹出的浮层详情页。不用跳转到对应的功能页面。」
  //   原来走到这里是 `location.assign(pageUrl(dest) + "?open=…")` —— **真的跳到目标页**再自动开浮层。
  //   现在改成**就地开浮层**：处置动作（转待办 / 已完成 / 已回复 …）浮层里本来就有 ——
  //   详情接口返回 `availableOps`（实测日程那条给的就是「转待办, 已完成」），`overlay()` 会把它渲染成按钮。
  //   ⇒ 好处：少一次整页跳转与重建；处置完**还停在总览页**，能接着看下一条。
  //   ⚠️ 其余页面若出现"指向别页"的行，仍保持跳转 —— 那条路是对的（`pageUrl` 的两种后缀场景），别一起改掉。
  //   ⚠️ 类型仍要先过 `CANON` 归一：路由只认复数（单数会 404），这一条以前栽过。
  L.push('      if (!dest) { openDetail(kind, id); return; }');
  L.push('      openDetail(CANON[kind] || dest, id);   // 总览页：就地开浮层，不跳页');
  L.push('    });');
  L.push('  }');
  L.push('');
  // 目标页接手：**优先读查询串** `?open=类型:id`（跳转带过来的），
  // 兼容旧的片段写法 `#页?open=…`（历史地址，读到也不至于失效）。
  L.push('  var hm = /[?&]open=([a-z]+):([A-Za-z0-9_]+)/.exec(location.search || "")');
  L.push('    || /[?&]open=([a-z]+):([A-Za-z0-9_]+)/.exec(location.hash || "");');
  L.push('  if (hm) { hm[1] = CANON[hm[1]] || hm[1]; }');
  L.push('  if (hm && (!TYPE || TYPE === hm[1])) { setTimeout(function () { openDetail(hm[1], hm[2]); }, 0); }');
  // ★ 2026-10-12 修（**"跨页跳转后详情不自动开"**）：
  //   原来判的是 `TYPE === hm[1]`，而地址里带的类型可能是**单数**（`schedule`）、
  //   而 `TYPE` 是从 `data-page` 算出来的**复数**（`schedules`）⇒ **永远不相等**、浮层永远不开。
  //   ⇒ 两边都过一遍同一张 `CANON` 表再比；同时**跳转那头改成带复数**（见上面 `location.assign`），
  //     两头都规范，就不再靠"猜"。用同一张表，避免出现第三份映射（本项目栽过这种重复映射的跟头）。
  L.push('');
  // ★★ 顶部导航的链接改写（2026-10-12 修，**用户报"点 tab 切不动"**）：
  //   导航是**服务端生成**的（`shell.mjs#topbar`），写死成 `./schedules.html` 这种带 `.html` 的形式。
  //   可两种打开方式对后缀的要求正好相反：
  //     · 面板内嵌：`/workdesktop/api/yishu/overview` —— 该路由**不认 `.html`**
  //       （实测 `/yishu/schedules.html` 只回 **182 字节空页**）⇒ 点导航 = 白屏，看着就是"切不动"；
  //     · 本地文件直开：`./overview.html` —— 又**必须带** `.html` 才找得到文件。
  //   ⇒ 一个写死的后缀，必然有一种场景是坏的。这里在客户端按**当前地址的形态**改写链接，
  //     两种场景都对；服务端模板保持原样（离线直开时它本身仍然可用）。
  L.push('  (function () {');
  L.push('    var here = location.pathname.split("/").pop() || "";');
  L.push('    var served = !/\\.html$/i.test(here);   // 不带后缀 ⇒ 是面板路由在供页');
  L.push('    var links = document.querySelectorAll("a[href]");');
  L.push('    for (var i = 0; i < links.length; i++) {');
  L.push('      var a = links[i]; var href = a.getAttribute("href") || "";');
  L.push('      if (served) { if (/\\.html$/i.test(href)) a.setAttribute("href", href.replace(/\\.html$/i, "")); }');
  L.push('      else { if (/^\\.\\/[a-z][a-z-]*$/i.test(href)) a.setAttribute("href", href + ".html"); }');
  L.push('    }');
  L.push('  })();');
  L.push('');
  // ★★ 消息页五个 Tab 的筛选（2026-10-12 加，**用户报"Tab 点了没反应"**）：
  //   为什么放客户端：面板那条路由（`/yishu/<页>`）是**读静态文件**返回的，**不跑渲染**；
  //   本地直开同样是静态文件 ⇒ **两条路都不会按 `?tab=` 重渲染**。
  //   而页面里本来就带着**全部**消息（每行有 `data-state`）⇒ 端上按状态隐藏即可。
  //   链接带 `?tab=`：既补上地址（可分享、可刷新），又据此筛行。
  //   点的时候 `preventDefault()` —— 静态场景下点链接会重新加载同一个文件、白白闪一下。
  L.push('  (function () {');
  L.push('    var links = document.querySelectorAll("[data-tab]");');
  L.push('    if (!links.length) return;');
  L.push('    function activeTab() { var m = /[?&]tab=([a-z-]+)/.exec(location.search || ""); return m ? m[1] : "all"; }');
  L.push('    function applyTab(t) {');
  L.push('      var lis = document.querySelectorAll(".jl-list li[data-state]");');
  L.push('      for (var i = 0; i < lis.length; i++) {');
  // ★ 2026-10-13：筛选结果写进**自己的属性**（`data-tab-hidden`），不去碰 `style.display` ——
  //   那个属性归分页管。两者共用一个属性就会互相覆盖（真机验证抓出来过）。
  // ★★ 2026-10-14 改：`data-state` 从**单值**变成**多值**（空格分隔的档位标签）。
  //   为什么：待办的「转日程」与「已完成」**可以重叠**（转过日程的也可能已完成），
  //   日程同理。单值模型下渲染层只能挑一个写进去 ⇒ 另一档里那条会**凭空消失**。
  //   ⇒ 判据改成"**包含即显示**"：行的标签里含当前页签就算命中。
  //   ⚠️ 用空格切分后做**整词比较**，不用 `indexOf` —— 否则 `to-schedule` 会被 `schedule` 误命中。
  L.push('        var tags = " " + String(lis[i].getAttribute("data-state") || "") + " ";');
  L.push('        var hide = !(t === "all" || tags.indexOf(" " + t + " ") >= 0);');
  L.push('        lis[i].setAttribute("data-tab-hidden", hide ? "1" : "0");');
  L.push('      }');
  L.push('      for (var j = 0; j < links.length; j++) {');
  L.push('        if (links[j].getAttribute("data-tab") === t) links[j].setAttribute("aria-current", "page");');
  L.push('        else links[j].removeAttribute("aria-current");');
  L.push('      }');
  // ★★ 2026-10-13：分页要以**筛选后的可见行**为准 —— 不重算的话，
  //   筛到 0 行时会翻到整页空白（两个功能各算各的，就会打架）。
  L.push('      if (window.__wbApplyPager) window.__wbApplyPager();');
  L.push('    }');
  L.push('    for (var k = 0; k < links.length; k++) {');
  L.push('      links[k].addEventListener("click", function (ev) {');
  L.push('        ev.preventDefault();');
  L.push('        var t = this.getAttribute("data-tab");');
  L.push('        if (history.replaceState) history.replaceState(null, "", location.pathname + "?tab=" + t);');
  L.push('        applyTab(t);');
  L.push('      });');
  L.push('    }');
  // ★ 2026-10-13 挪走：`applyTab(activeTab())` 原来在这里跑，但**分页函数到第 431 行才定义**
  //   ⇒ 那一刻 `window.__wbApplyPager` 还不存在，筛选结果写不进属性、分页也就没生效
  //   （真机验证 IF-5/IF-7 抓出来的：消息页 200 行全摊开、没分页）。
  //   ⇒ "首次筛选"挪到**分页定义之后**执行（见下面 `首屏对齐` 那段）。
  L.push('    window.__wbApplyTab = applyTab;');
  L.push('  })();');
  L.push('');
  // ══════════════════════════════════════════════════════════════════════════
  // **分页**（2026-10-13 加，用户第 5 条；样式照他给的那张图）
  //
  // 图上要素逐个对上：左侧「总计: N」· ‹ 上一页 · 页码按钮（当前页高亮）· 省略号 · 末页 ·
  //   › 下一页 · 「1/383」· 「到第 __ 页」「前往」· 右侧「每页显示: [10 ▾]」
  //
  // ★ 为什么在端上分页（不请求服务端）：
  //   页面本来就把这一类型的**全部**数据渲染进了 DOM（实测消息 200 行、待办 11 行），
  //   翻页只是显示/隐藏 ⇒ 零请求、瞬时响应。服务端分页要重渲染静态文件，反而更慢，
  //   而且会丢掉当前的页签筛选状态。
  // ★ 与筛选的关系：分页对象是**当前可见的行**（`__wbApplyTab` 跑完会重算），
  //   否则筛到 0 行时会出现"翻到全是空白的页"。
  // ★ 每页条数记在 `localStorage.jl.pageSize`，换页/刷新都记得住。
  // ══════════════════════════════════════════════════════════════════════════
  L.push('  var PAGERS = {};');
  L.push('  function pageSizeOf() {');
  L.push('    var v = 0; try { v = parseInt(localStorage.getItem("jl.pageSize") || "", 10) } catch (e) {}');
  L.push('    return [10, 20, 50, 100].indexOf(v) >= 0 ? v : 10;');
  L.push('  }');
  L.push('  function initPager(box) {');
  L.push('    var key = box.getAttribute("data-pager");');
  L.push('    var section = box.parentNode;');
  L.push('    var ul = section ? section.querySelector("ul.jl-list") : null;');
  L.push('    if (!ul) return;');
  L.push('    var all = Array.prototype.slice.call(ul.querySelectorAll("li"));');
  L.push('    var st = { ul: ul, all: all, size: pageSizeOf(), page: 1 };');
  L.push('    PAGERS[key] = st;');
  L.push('    var sel = box.querySelector("[data-pg-size]");');
  L.push('    if (sel) { sel.value = String(st.size); sel.addEventListener("change", function () { st.size = parseInt(sel.value, 10) || 10; st.page = 1; try { localStorage.setItem("jl.pageSize", String(st.size)) } catch (e) {} render(st, box) }) }');
  L.push('    var prev = box.querySelector("[data-pg-prev]"); if (prev) prev.addEventListener("click", function () { if (st.page > 1) { st.page--; render(st, box) } });');
  L.push('    var next = box.querySelector("[data-pg-next]"); if (next) next.addEventListener("click", function () { if (st.page < st.pages) { st.page++; render(st, box) } });');
  // ★★ 2026-10-14 修：**首页 / 末页两个按钮加了却没绑事件** —— 真机验证抓到的
  //   （"点末页跳到最后一页 —— 1/21 → 1/21"，原地不动）。
  //   我在 `shell.mjs#pager` 里补了 `data-pg-first` / `data-pg-last`，但绑定这一侧漏了 ⇒
  //   表现是"按钮在那儿、点了没反应"。这正是本项目反复出现的那类错：
  //   **加了控件却忘了接上它**（页签、按钮、表单都栽过同一个跟头）。
  L.push('    var first = box.querySelector("[data-pg-first]"); if (first) first.addEventListener("click", function () { if (st.page > 1) { st.page = 1; render(st, box) } });');
  L.push('    var last = box.querySelector("[data-pg-last]"); if (last) last.addEventListener("click", function () { if (st.page < st.pages) { st.page = st.pages; render(st, box) } });');
  L.push('    var jump = box.querySelector("[data-pg-jump]");');
  L.push('    var go = box.querySelector("[data-pg-go]");');
  L.push('    if (go) go.addEventListener("click", function () { var n = parseInt(jump && jump.value, 10); if (n >= 1 && n <= st.pages) { st.page = n; render(st, box) } });');
  L.push('    if (jump) jump.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); if (go) go.click() } });');
  L.push('    render(st, box);');
  L.push('  }');
  // 页码序列：首末 + 当前页附近，中间用省略号（与图上「1 2 3 4 … 383」一致）
  L.push('  function pageList(cur, pages) {');
  L.push('    var out = []; var i;');
  L.push('    if (pages <= 7) { for (i = 1; i <= pages; i++) out.push(i); return out }');
  L.push('    out.push(1);');
  L.push('    var from = Math.max(2, cur - 1), to = Math.min(pages - 1, cur + 1);');
  L.push('    if (from > 2) out.push("…");');
  L.push('    for (i = from; i <= to; i++) out.push(i);');
  L.push('    if (to < pages - 1) out.push("…");');
  L.push('    out.push(pages);');
  L.push('    return out;');
  L.push('  }');
  L.push('  function render(st, box) {');
  // ★★ 2026-10-13 修（**分页与筛选互相打架** —— 真机验证当场抓出来的）：
  //   第一版这里用 `li.style.display !== "none"` 判"可见"，可**筛选也是改 style.display** ⇒
  //   两者互相覆盖：翻页时把筛选藏掉的行又放了出来，于是"200 行 × 10/页"本该 20 页，
  //   点一下下一页变成 1 页（IF-7 的 `1/20 → 1/1` 就是这个毛病）。
  //   ⇒ **两个状态分开记**：筛选结果写在 `data-tab-hidden` 上，分页只管 `data-pg-hidden`，
  //     最终可见 = 两个都允许。判据不重叠，才不会互相踩。
  L.push('    var pool = st.all.filter(function (li) { return li.getAttribute("data-tab-hidden") !== "1" });');
  L.push('    st.pages = Math.max(1, Math.ceil(pool.length / st.size));');
  L.push('    if (st.page > st.pages) st.page = st.pages;');
  L.push('    var a = (st.page - 1) * st.size, b = a + st.size;');
  L.push('    for (var i = 0; i < st.all.length; i++) {');
  L.push('      var li = st.all[i];');
  L.push('      var tabOk = li.getAttribute("data-tab-hidden") !== "1";');
  L.push('      var idx = pool.indexOf(li);');
  L.push('      var pgOk = idx >= a && idx < b;');
  L.push('      li.setAttribute("data-pg-hidden", pgOk ? "0" : "1");');
  L.push('      li.style.display = (tabOk && pgOk) ? "" : "none";');
  L.push('    }');
  L.push('    var t = box.querySelector("[data-pg-total]"); if (t) t.textContent = "总计: " + pool.length;');
  L.push('    var pos = box.querySelector("[data-pg-pos]"); if (pos) pos.textContent = st.page + "/" + st.pages;');
  L.push('    var nums = box.querySelector("[data-pg-nums]");');
  L.push('    if (nums) {');
  L.push('      nums.innerHTML = "";');
  L.push('      pageList(st.page, st.pages).forEach(function (n) {');
  L.push('        if (n === "…") { var g = document.createElement("span"); g.className = "pg-gap"; g.textContent = "…"; nums.appendChild(g); return }');
  L.push('        var bt = document.createElement("button"); bt.type = "button"; bt.textContent = String(n);');
  L.push('        if (n === st.page) bt.setAttribute("aria-current", "page");');
  L.push('        bt.addEventListener("click", function () { st.page = n; render(st, box) });');
  L.push('        nums.appendChild(bt);');
  L.push('      });');
  L.push('    }');
  L.push('    var pv = box.querySelector("[data-pg-prev]"); if (pv) pv.disabled = st.page <= 1;');
  L.push('    var nx = box.querySelector("[data-pg-next]"); if (nx) nx.disabled = st.page >= st.pages;');
  // ★ 首页/末页到两头时也要禁用（与上一页/下一页同一个规矩：到头了就该点不动）
  L.push('    var pf = box.querySelector("[data-pg-first]"); if (pf) pf.disabled = st.page <= 1;');
  L.push('    var pl = box.querySelector("[data-pg-last]"); if (pl) pl.disabled = st.page >= st.pages;');
  L.push('  }');
  L.push('  var pboxes = document.querySelectorAll("[data-pager]");');
  L.push('  for (var pb = 0; pb < pboxes.length; pb++) initPager(pboxes[pb]);');
  L.push('  // 让筛选跑完能重算分页（两个功能必须对齐，否则会出现整页空白）');
  L.push('  window.__wbApplyPager = function () {');
  L.push('    for (var k in PAGERS) if (Object.prototype.hasOwnProperty.call(PAGERS, k)) {');
  L.push('      var bx = document.querySelector(\'[data-pager="\' + k + \'"]\');');
  L.push('      if (bx) { PAGERS[k].page = 1; render(PAGERS[k], bx) }');
  L.push('    }');
  L.push('  };');
  L.push('');
  // ══════════════════════════════════════════════════════════════════════════
  // **首屏对齐顺序**（2026-10-13 加 —— 这一段的顺序是踩出来的，不是随手排的）
  //
  // 必须**先筛选、再分页**：
  //   分页要按"筛选后剩下的行"算页数；若反过来，分页先按全部行算（消息页 200 行 = 20 页），
  //   筛选再来改可见性，两者就会各说各话 —— 真机验证实测到过两种坏结果：
  //     · 200 行全摊开、等于没分页（筛选还没写属性时分页已经算完了）
  //     · 点下一页 `1/20 → 1/1`（分页把筛选藏掉的行又放了出来）
  //   ⇒ 所以这一段放在**分页定义之后**。原来它在分页定义之前，`window.__wbApplyPager`
  //     那一刻还不存在，等于白调。
  // ⚠️ 必须把**当前页签**传进去：`__wbApplyTab()` 不带参数时内部 `t` 是 `undefined`，
  //   而它的判据是 `t === "all" || state === t` ⇒ 两者都不成立 ⇒ **把所有行都藏了**
  //   （真机实测：200 行全部 `data-tab-hidden=1`、可见 0 行、总计 0）。
  //   页签从地址里读（`?tab=`），与筛选链接用的同一套判法。
  L.push('  var bootTab = (function () { var m = /[?&]tab=([a-z-]+)/.exec(location.search || ""); return m ? m[1] : "all" })();');
  L.push('  if (window.__wbApplyTab) window.__wbApplyTab(bootTab);   // 先按地址里的 ?tab= 筛');
  L.push('  if (window.__wbApplyPager) window.__wbApplyPager();   // 再按筛完的行分页');
  L.push('');
  // ══════════════════════════════════════════════════════════════════════════
  // **页内平铺表单的提交**（2026-10-13 加，用户第 4 条）
  //
  // 与旧实现的区别（**这条特别要紧**）：
  //   旧的是"按钮 → 弹层 → `window.prompt()` 逐个问字段"，而 **prompt 在 iframe 里返回 null**
  //   （面板就是这么嵌页面的）⇒ 用户点了什么都不发生、连报错都没有。
  //   现在字段全在页面里（`<input data-if="…">`），提交时读它们的值 —— 不依赖任何原生弹窗。
  //
  // 失败**写在表单里**（`[data-if-msg]`），不弹 alert：iframe 里 alert 同样不可靠，
  //   而且报错要留在眼前，不能一闪而过。
  // ══════════════════════════════════════════════════════════════════════════
  L.push('  (function () {');
  L.push('    var form = document.querySelector(".inline-form[data-if-page]");');
  L.push('    if (!form) return;');
  L.push('    var pageType = form.getAttribute("data-if-page");');
  L.push('    var btn = form.querySelector("[data-if-submit]");');
  L.push('    var msg = form.querySelector("[data-if-msg]");');
  L.push('    if (!btn) return;');
  L.push('    function say(t, bad) { if (!msg) return; msg.textContent = t; msg.className = "cap if-msg" + (bad ? " bad" : "") }');
  L.push('    btn.addEventListener("click", function () {');
  L.push('      var payload = {};');
  L.push('      var inputs = form.querySelectorAll("input[data-if]");');
  L.push('      for (var i = 0; i < inputs.length; i++) {');
  L.push('        var k = inputs[i].getAttribute("data-if");');
  L.push('        var v = String(inputs[i].value || "").trim();');
  L.push('        if (v === "") continue;');
  L.push('        payload[k] = (k === "tags") ? v.split(/[,，]/).map(function (x) { return x.trim() }).filter(Boolean) : v;');
  L.push('      }');
  L.push('      // ★★ 2026-10-14 加（用户第 2 条）：「缺少必填项时，提示应更直观，并**明确指向具体缺失字段**；' + "示例：『XX项内容不能为空』」。");
  //   原来**没有端上校验** —— 缺字段要等提交打到服务端、拿回一串校验错误（还混着别的字段名），
  //   用户看到的是"校验未通过"而不是"哪一项没填"。
  //   ⇒ 端上先自己判一遍：**逐项点名**，并把焦点移到缺的那一项上（照着填就行）。
  //   ⚠️ 端上校验只是**提前告知**，服务端那道**照旧保留**（端上绕过不难，不能只靠它）。
  L.push('      var REQ = { messages: ["raw"], todos: ["topic"], schedules: ["topic", "start", "end"], notes: ["topic", "content_md"] };');
  L.push('      var need = REQ[pageType] || [];');
  L.push('      var missing = [];');
  L.push('      for (var mi = 0; mi < need.length; mi++) {');
  L.push('        var mk = need[mi];');
  L.push('        if (String(payload[mk] === undefined ? "" : payload[mk]).trim() === "") {');
  L.push('          var lab = form.querySelector(\'[data-if="\' + mk + \'"]\');');
  L.push('          var labTxt = lab ? String((lab.closest(".if-cell") || {}).textContent || "").replace(/必填/g, "").trim() : mk;');
  L.push('          missing.push({ k: mk, name: labTxt || mk, el: lab });');
  L.push('        }');
  L.push('      }');
  L.push('      if (missing.length) {');
  L.push('        var names = missing.map(function (x) { return x.name.replace(/（[^）]*）|\([^)]*\)/g, "").trim() || x.k; });');
  L.push('        say("「" + names.join("」「") + "」项内容不能为空 —— 请填写后再提交", true);');
  L.push('        if (missing[0].el) { try { missing[0].el.focus() } catch (e) {} }');
  L.push('        return;');
  L.push('      }');
  L.push('      // 与契约对齐的补字段（schema.mjs#PAYLOAD_SPEC 的必填项）');
  // ★★ 2026-10-13 修（**我上一轮改错了，这一条是真机验证抓出来的**）：
  //   契约 `schema.mjs` 里 `source` 只认这几个值：
  //     im / mail / minutes / self-voice / doc / bitable / task / calendar / kb / **manual**
  //   —— **没有 `workbench`**。我上一轮按用户第 9/10/11 条的"来源标注为工作台"，
  //   顺手把 payload 的 source 写成了 `"workbench"`，结果**提交直接 400（校验未通过）**。
  //   ⇒ 那三个表单当时是全坏的（真机实测：source=workbench → 400；source=manual → 200）。
  //
  //   ★ 关键认识：**"来源显示为工作台"和"payload 里写什么"是两件事**。
  //     显示那边的标签由 `api/source.mjs#sourceOf()` 从 `channel === 'manual'` 推出来
  //     （它认得 manual 就是"工作台"）—— **不需要**、也**不能**往 payload 里塞 `workbench`。
  //     我把"给人看的标签"和"契约字段的取值"混成一件事了，这正是本项目的教训之一。
  L.push('      if (pageType === "messages") { payload.channel = "manual"; payload.source = "manual"; payload.modality = "text"; payload.summary = String(payload.raw || "").slice(0, 60); payload.sender = "杨瑒(月夜)"; payload.senderType = "self"; }');
  L.push('      if (pageType === "notes") { payload.date = new Date().toISOString().slice(0, 10); if (!payload.topic) payload.topic = String(payload.content_md || "").slice(0, 24) || "未命名笔记"; }');
  // 日程：参与人从"顿号分隔的一行字"拆成数组；类型原样传（契约的 optional 里有 type）
  L.push('      if (pageType === "schedules") { if (payload.participants) payload.participants = String(payload.participants).split(/[、,，]/).map(function (x) { return x.trim() }).filter(Boolean); else payload.participants = []; }');
  L.push('      btn.disabled = true; say("提交中…", false);');
  L.push('      fetch(API + "/" + pageType, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payload: payload }) })');
  L.push('        .then(function (r) { return r.json().then(function (b) { return { code: r.status, body: b }; }) })');
  L.push('        .then(function (x) {');
  L.push('          if (x.code >= 400) { say("失败：" + JSON.stringify(x.body.errors || x.body.error || x.body).slice(0, 180), true); btn.disabled = false; return }');
  L.push('          say("已提交，正在刷新…", false); location.reload();');
  L.push('        })');
  L.push('        .catch(function (e) { say("请求失败：" + e.message, true); btn.disabled = false });');
  L.push('    });');
  L.push('  })();');
  L.push('');
  // ══════════════════════════════════════════════════════════════════════════
  // 底部状态栏：三个能力开关（实时回复 / 响应功能 / 向量检索）
  // ★★ 2026-10-13 加（用户裁定）：四态配色 + 可点击切换 + 悬浮文字说明。
  //
  // 为什么颜色不写死在这段脚本里：状态名→颜色有**唯一产地**
  //   （库内 `system-switches.mjs#STATE_COLOR`），页面只是把它渲染出来。
  //   写死一份就会漂 —— 本项目反复栽过"两份名单各改一半"。
  //   ⇒ 每次都从 `/system-switch` 取回 `colors` 与 `capabilities[].state/label/why`，照它上色。
  //
  // 四态对应用户的话：off=灰（关闭）· down=红（背后服务没跑或报错）· ok=绿（空闲中）· busy=黄（运行中）。
  //   另有过渡态 starting=紫 / stopping=蓝（点了之后现实还没跟上）——**不许拿四态冒充过渡**：
  //   那会把"点了关闭但服务还在跑"显示成已关闭，库内注释里专门写了这条。
  //
  // 拉不到状态时**保持灰**并如实写"状态读取失败" —— 不知道就不装作知道。
  // ══════════════════════════════════════════════════════════════════════════
  L.push('  (function () {');
  L.push('    var box = document.querySelector(".statusbar");');
  L.push('    if (!box) return;');
  L.push('    var nodes = box.querySelectorAll(".switch[data-switch]");');
  L.push('    if (!nodes.length) return;');
  L.push('    var BASE = API.replace(/\\/v1$/, "");');
  L.push('    var busy = false;');
  L.push('    function paint(doc) {');
  L.push('      var byName = {};');
  L.push('      (doc.capabilities || []).forEach(function (c) { byName[c.name] = c });');
  L.push('      for (var i = 0; i < nodes.length; i++) {');
  L.push('        var n = nodes[i]; var key = n.getAttribute("data-switch");');
  L.push('        var c = byName[key]; var dot = n.querySelector(".dot");');
  L.push('        var lab = n.querySelector("[data-switch-label]");');
  L.push('        if (!c) { n.setAttribute("title", key + "：状态里没有这个能力（开关词表变了？）"); continue }');
  L.push('        if (dot) dot.style.background = (doc.colors || {})[c.state] || "";');
  L.push('        if (lab) {');
  L.push('          if (!lab.getAttribute("data-base-label")) lab.setAttribute("data-base-label", lab.textContent);');
  L.push('          lab.textContent = lab.getAttribute("data-base-label") + " · " + c.label;');
  L.push('        }');
  L.push('        // 悬浮说明 = 这个能力是什么 + 当前态 + 库内给的理由（理由才是"为什么这盏灯是这个颜色"）');
  L.push('        n.setAttribute("title", c.title + "：" + c.label + "\\n" + (c.note ? c.note + "\\n" : "") + (c.why || ""));');
  L.push('        n.setAttribute("data-state", c.state);');
  L.push('      }');
  L.push('    }');
  L.push('    function load() {');
  L.push('      return fetch(BASE + "/system-switch").then(function (r) { return r.json() }).then(function (d) {');
  L.push('        if (d && d.ok === false) {');
  L.push('          for (var i = 0; i < nodes.length; i++) nodes[i].setAttribute("title", "状态读取失败：" + (d.error || "未知原因"));');
  L.push('          return d;');
  L.push('        }');
  L.push('        paint(d || {}); return d;');
  L.push('      }).catch(function (e) {');
  L.push('        for (var i = 0; i < nodes.length; i++) nodes[i].setAttribute("title", "状态读取失败：" + e.message);');
  L.push('        return null;');
  L.push('      });');
  L.push('    }');
  L.push('    function toggle(n) {');
  L.push('      if (busy) return;');
  L.push('      var key = n.getAttribute("data-switch");');
  L.push('      var cur = n.getAttribute("data-state");');
  L.push('      if (["off", "ok", "busy", "down"].indexOf(cur) < 0) { alert("这个开关正在过渡中（" + cur + "），等它落定再点"); return }');
  L.push('      var want = (cur === "off");');
  L.push('      busy = true; n.setAttribute("aria-busy", "1");');
  L.push('      n.setAttribute("title", "正在" + (want ? "开启" : "关闭") + "…（要拉起或停掉计划任务，请稍候）");');
  L.push('      fetch(BASE + "/system-switch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ capability: key, enabled: want }) })');
  L.push('        .then(function (r) { return r.json() })');
  L.push('        .then(function (d) {');
  L.push('          busy = false; n.removeAttribute("aria-busy");');
  L.push('          if (d && d.ok === false) { n.setAttribute("title", "切换失败：" + (d.error || "未知原因")); alert("切换失败：" + (d.error || "未知原因")); return }');
  L.push('          if (d && d.capabilities) paint(d); else load();');
  L.push('        })');
  L.push('        .catch(function (e) { busy = false; n.removeAttribute("aria-busy"); alert("切换请求失败：" + e.message) });');
  L.push('    }');
  L.push('    for (var k = 0; k < nodes.length; k++) {');
  L.push('      (function (n) {');
  L.push('        n.addEventListener("click", function () { toggle(n) });');
  L.push('        n.addEventListener("keydown", function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(n) } });');
  L.push('      })(nodes[k]);');
  L.push('    }');
  L.push('    load();');
  L.push('    setInterval(load, 30000);   // 半分钟一次：状态会自己变（在不在会中、在途条数都会动）');
  L.push('  })();');
  L.push('');
  L.push('  var addBtn = document.getElementById("btn-add");');
  L.push('  if (addBtn && TYPE) {');
  L.push('    addBtn.addEventListener("click", function () {');
  L.push('      var forms = {');
  L.push('        messages: [["raw", "消息原文"], ["sender", "发信人"]],');
  L.push('        todos: [["topic", "任务主题"], ["detail", "任务详情"], ["due", "截止 YYYY-MM-DD"]],');
  L.push('        schedules: [["topic", "日程主题"], ["start", "开始 YYYY-MM-DDTHH:mm"], ["end", "结束"], ["place", "地点"]],');
  L.push('        notes: [["topic", "笔记主题"], ["content_md", "内容"], ["tags", "标签（逗号分隔）"]]');
  L.push('      }[TYPE] || [];');
  L.push('      openAddForm(forms);');
  L.push('    });');
  L.push('  }');
  L.push('');
  // ★★ 2026-10-12 改（**"新增一条"在面板里点了没反应**）：
  //   原实现是逐个 `window.prompt()` 问字段。实测：
  //     顶层窗口直接打开 → prompt 正常；
  //     放进 **iframe**（面板正是这么嵌页面的）→ prompt **能弹出来，但返回值是 null**。
  //   而代码写的是 `if (v === null) return;` —— 于是连第一个字段都拿不到，**直接返回、什么都不做**，
  //   用户看到的就是"点了没反应"，而且**连报错都没有**（这类静默失败最难查）。
  //   ⇒ 改成**页面内表单**（自己画的浮层），不依赖浏览器原生弹窗：
  //     输入框 → 提交按钮 → POST；失败时把服务端的错误**如实显示在表单里**（不弹 alert，同样因为 iframe）。
  L.push('  function openAddForm(forms) {');
  L.push('    var back = el("div", "overlay-back");');
  L.push('    var box = el("div", "overlay");');
  L.push('    box.appendChild(el("h2", null, "新增一条"));');
  L.push('    var inputs = {};');
  L.push('    forms.forEach(function (f) {');
  L.push('      var line = el("div", "ov-row");');
  L.push('      line.appendChild(el("span", "ov-k", f[1]));');
  L.push('      var inp = document.createElement("input");');
  L.push('      inp.type = "text"; inp.className = "ov-input"; inp.placeholder = f[1];');
  L.push('      line.appendChild(inp);');
  L.push('      box.appendChild(line);');
  L.push('      inputs[f[0]] = inp;');
  L.push('    });');
  L.push('    var bar = el("div", "ov-ops");');
  L.push('    var ok = el("button", "btn", "提交");');
  L.push('    var cancel = el("button", "btn", "取消");');
  L.push('    var msg = el("span", "cap", "");');
  L.push('    msg.style.cssText = "font-size:12px;color:var(--c-mute);margin-left:8px";');
  L.push('    bar.appendChild(ok); bar.appendChild(cancel); bar.appendChild(msg);');
  L.push('    box.appendChild(bar);');
  L.push('    back.appendChild(box);');
  L.push('    document.body.appendChild(back);');
  L.push('    function close() { try { document.body.removeChild(back) } catch (e) {} }');
  L.push('    cancel.addEventListener("click", close);');
  L.push('    back.addEventListener("click", function (ev) { if (ev.target === back) close(); });');
  L.push('    ok.addEventListener("click", function () {');
  L.push('      var payload = {};');
  L.push('      forms.forEach(function (f) {');
  L.push('        var v = String(inputs[f[0]].value || "").trim();');
  L.push('        if (v === "") return;');
  L.push('        payload[f[0]] = f[0] === "tags" ? v.split(/[,，]/).map(function (x) { return x.trim(); }).filter(Boolean) : v;');
  L.push('      });');
  L.push('      if (TYPE === "messages") { payload.channel = "manual"; payload.source = "manual"; payload.modality = "text"; payload.summary = String(payload.raw || "").slice(0, 60); }');
  L.push('      if (TYPE === "notes") { payload.date = new Date().toISOString().slice(0, 10); }');
  L.push('      ok.disabled = true; msg.textContent = "提交中…";');
  L.push('      fetch(API + "/" + TYPE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payload: payload }) })');
  L.push('        .then(function (r) { return r.json().then(function (b) { return { code: r.status, body: b }; }); })');
  L.push('        .then(function (x) {');
  // ★ 失败**写在表单里**（不弹 alert：iframe 里 alert 一样不可靠，而且报错要留在眼前）
  L.push('          if (x.code >= 400) { msg.textContent = "失败：" + JSON.stringify(x.body.errors || x.body.error || x.body).slice(0, 160); ok.disabled = false; return; }');
  L.push('          msg.textContent = "已提交，正在刷新…";');
  L.push('          location.reload();');
  L.push('        })');
  L.push('        .catch(function (e) { msg.textContent = "请求失败：" + e.message; ok.disabled = false; });');
  L.push('    });');
  L.push('    var first = inputs[forms.length ? forms[0][0] : ""];');
  L.push('    if (first && first.focus) first.focus();');
  L.push('  }');
  L.push('})();');
  return L.join('\n');
}

/** 浮层与按钮的最小样式（值走 token，追加在 shell 样式之后） */
export function clientStyle() {
  const s = [];
  s.push('.overlay-back { position: fixed; inset: 0; background: rgba(8,8,8,.28); display: flex; align-items: center; justify-content: center; z-index: 50; }');
  s.push('.overlay { background: var(--c-canvas); border-radius: 8px; box-shadow: var(--shadow-lifted); padding: 20px 22px; width: min(640px, 92vw); max-height: 80vh; overflow: auto; }');
  s.push('.overlay h2 { font-size: 16px; margin-bottom: 12px; }');
  s.push('.ov-row { display: flex; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--c-hairline); font-size: 13px; }');
  s.push('.ov-k { color: var(--c-mute); min-width: 84px; }');
  // 消息图片（2026-10-13 加，用户第 7 条）：限制最大边长，别把浮层撑破；
  //   圆角与边框跟卡片一致（4px 直角，不用胶囊）。
  s.push('.ov-img { display: block; max-width: min(560px, 100%); max-height: 60vh; border: 1px solid var(--c-hairline); border-radius: 4px; margin-top: 4px; }');
  // 待办的"结果交付物"表单（2026-10-13 加，用户第 9 条）：与新增表单同一套输入框样式，视觉一致。
  s.push('.dv-form { margin-top: var(--s-md); padding-top: var(--s-sm); border-top: 1px solid var(--c-hairline); }');
  s.push('.dv-form .dv-title { font-size: 13px; color: var(--c-body-mid); font-weight: var(--w-medium); margin-bottom: var(--s-xs); }');
  // 表单说明那一行（2026-10-14 加）：讲清"附件要粘路径、不是粘文件"——
  // 界面说的和实际做的对得上，比留一个让人猜的标签强。
  s.push('.dv-form .dv-hint { font-size: 12px; color: var(--c-mute); line-height: 1.5; margin-bottom: var(--s-xs); }');
  s.push('.dv-form .dv-row { display: flex; align-items: center; gap: var(--s-sm); padding: 3px 0; }');
  s.push('.dv-form .dv-row .ov-k { flex: none; }');
  s.push('.dv-form .dv-row .ov-input { flex: 1; }');
  // 新增表单的输入框（2026-10-12 加：原来用 window.prompt，iframe 里返回 null ⇒ 改成页内表单）
  s.push('.ov-input { flex: 1; font: inherit; padding: 4px 6px; border: 1px solid var(--c-hairline); border-radius: 4px; background: transparent; color: var(--c-ink); }');
  s.push('.ov-v { flex: 1; white-space: pre-wrap; }');
  s.push('.ov-ops { display: flex; gap: 8px; margin-top: 14px; }');
  s.push('.ov-close { background: var(--c-canvas); color: var(--c-ink); border: 1px solid var(--c-hairline); margin-top: 10px; }');
  s.push('.toolbar { display: flex; gap: 8px; margin-bottom: 14px; }');
  return s.join('\n');
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检：**用 new Function 真编译**（脚本语法错在服务端渲染时看不出来，只有浏览器才炸）
// ══════════════════════════════════════════════════════════════════════════════
export function selfTest() {
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });
  const js = clientScript('http://127.0.0.1:8791/workdesktop/api/v1');
  const css = clientStyle();

  let compiled = null;
  try { new Function(js); compiled = true; } catch (e) { compiled = e.message; }
  chk('CLI-1', '★ 客户端脚本语法有效（真编译一遍）', compiled === true, String(compiled));
  chk('CLI-2', 'API 基址被注入且末尾斜杠被去掉', js.includes('"http://127.0.0.1:8791/workdesktop/api/v1"'));
  chk('CLI-3', '读取页面类型与列表', js.includes('data-page') && js.includes('querySelector(".list")'));
  // ★ CLI-4 改了判据（2026-10-12, P1-6）：此前守的是"点击行 ⇒ **先取页面列表**按行序拿 id"，
  //   而页面给全量、接口按页签过滤 ⇒ 页签一变行序就错位（点第 3 行开第 5 条）。
  //   现在改为"按 DOM 上的 data-id 直接取详情"。**不是为了让检查变绿而放宽**：
  //   新增 CLI-16/17 守着"真的用 data-id"与"总览能跨页跳转"，覆盖面反而变宽。
  chk('CLI-4', '★ 点击行按 data-id 直接取详情（不再按行序推断）', js.includes('getAttribute("data-id")') && js.includes('/detail/') && !js.includes('indexOf.call(list.children'), '');
  // ★★ 2026-10-13 改（这条原来是"总览三类提醒**可跳对应页面**"，用户裁定后行为变了）。
  //   用户原话：「点击日程之后，应该是**直接打开**日程的详情浮窗…**不需要直接跳转到日程页面**。
  //     『逾期/临期任务』下面的任务，以及『长期未回复的消息』当中的消息，和日程一样，
  //     都是点击之后直接打开弹出的浮层详情页。不用跳转到对应的功能页面。」
  //   ⇒ 总览不再生成 `?open=` 跳转链接，改成**就地调 `openDetail`**。
  //     这条检查于是红了 —— **它红得对**：它守的是旧行为。
  //   ⇒ 改成守**新行为**（三类提醒都有 data-id + data-go，且点击路径是就地开浮层），
  //     并且**把类型归一带上**（CANON）—— 路由只认复数，这一步以前栽过，不能漏。
  chk('CLI-16', '★ 总览三类提醒：带 data-id/data-go，点击**就地开详情浮层**（不跳页 · 用户 2026-10-13 裁定）',
    js.includes('data-go') && js.includes('PAGE_OF') && js.includes('openDetail(CANON[kind] || dest, id)'));
  // 目标页接手：**保留**（`?open=` 仍可能从书签/外链进来），但已不再是总览的默认路径
  chk('CLI-17', '★ 目标页接手（保留）：地址带 ?open=类型:id ⇒ 自动开那一条的详情', js.includes('openDetail(hm[1], hm[2])') && js.includes('hm[1]'));
  // ★ P2：待处置候选与一键创建（用户 Q2 的前端那一半）
  chk('CLI-18', '★ 浮层显示"待处置候选"与"已自动创建"两种结果（Q2：标注待处置）', js.includes('待处置候选') && js.includes('已自动创建'));
  chk('CLI-19', '★ 候选项能一键创建（按 kind 建为日程/待办/笔记）', js.includes('createFromCandidate') && js.includes('"建为" + KIND[c.kind]'));
  chk('CLI-20', '★ 转日程解析不出时间 ⇒ 单独话术（不与普通失败混同）', js.includes('x.code === 409') && js.includes('解析不出具体时间'));
  chk('CLI-21', '创建中按钮禁用（防连点重复建）', js.includes('btn.disabled = true') && js.includes('btn.disabled = false'));
  // 注：日程热力图那条断言在 `shell.mjs`（SH-30）—— 热力图是服务端渲染的，不属客户端脚本。
  // ══════════════════════════════════════════════════════════════════════════
  // ★★ 2026-10-13 加：**跨层通道的契约检查**（用户第 11 条要的"跳转到可视化面板"）。
  //
  // 为什么值得单开几条：这条通道**两端各写一半** ——
  //   页面侧（本文件）负责"发什么"；插件侧（`lib/client.js`）负责"收什么、校验什么、调什么"。
  //   两端一旦漂了，表现是**点了没反应**，而且不报错 —— 这正是本项目返工最多的那一类。
  //   ⇒ 这里把**约定本身**钉住：消息类型名、三种工具到面板 id 的映射、以及"不在面板里时如实说"。
  //     （插件侧那三条纪律 —— 白名单 / 来源校验 / 短重试 —— 归插件仓自己的检查管。）
  // ══════════════════════════════════════════════════════════════════════════
  chk('CLI-22', '★ 跨层通道：消息类型名与插件侧一致（改一处必须同时改另一处）',
    js.includes('dsh-workbench:open-panel'), '约定为 dsh-workbench:open-panel');
  chk('CLI-23', '★ 跨层通道：三种工具都映射到**真实存在的面板 id**（不是拼出来的名字）',
    js.includes('"dsh-coords:center"') && js.includes('"dsh-workdesktop:project-graph"') && js.includes('"dsh-modeling:center"'));
  chk('CLI-24', '★ 跨层通道：只往父窗口发、且**带 origin**（不群发、不用 * 通配）',
    js.includes('window.parent.postMessage') && js.includes('location.origin') && js.indexOf('postMessage(..., "*")') < 0);
  chk('CLI-25', '★ 本地直开（没有父窗口可切）时**如实说**，不给点了没反应的按钮',
    js.includes('window.parent === window') && js.includes('要在工作台面板里点才有效'));
  chk('CLI-26', '★ 消息详情：原始消息里的图片链接换成「［图片消息］」（只换显示，payload 不动）',
    js.includes('rawShown') && js.includes('［$1消息］'));
  // ★★ 2026-10-13 加：**表单填的字段值必须在契约的白名单里**。
  //   来由：我按"来源标注为工作台"把 payload 的 `source` 写成了 `"workbench"`，
  //   而契约只认 im/mail/minutes/self-voice/doc/bitable/task/calendar/kb/**manual** ——
  //   三个表单于是全部 400（真机实测：workbench → 400、manual → 200）。
  //   ⇒ "给人看的标签"和"契约字段的取值"是两件事：显示标签由 `sourceOf()` 从 channel 推，
  //     payload 里只能写契约认的值。这条检查就是钉住这一点。
  chk('CLI-27', '★ 表单不发契约不认的 source（曾因写 "workbench" 导致提交全部 400）',
    !js.includes('source = "workbench"') && !js.includes("source = 'workbench'"),
    '契约允许：im/mail/minutes/self-voice/doc/bitable/task/calendar/kb/manual');
  chk('CLI-5', '浮层有可执行操作按钮', js.includes('availableOps') && js.includes('ov-ops'));
  chk('CLI-6', '★ 操作失败如实提示（含"未登记"这种明确原因）', js.includes('未登记') && js.includes('操作失败'));
  chk('CLI-7', '新增入口与四类表单都在', js.includes('btn-add') && js.includes('messages:') && js.includes('todos:') && js.includes('schedules:') && js.includes('notes:'));
  chk('CLI-8', '★ 新增走登记表里的路径（/messages /todos /schedules /notes）', js.includes('API + "/" + TYPE'));
  chk('CLI-9', '★ 负向对照：脚本里没有写死颜色值（样式走 token）', !/#[0-9a-fA-F]{6}/.test(css), (css.match(/#[0-9a-fA-F]{6}/) || ['无'])[0]);
  chk('CLI-10', '浮层样式含 token 变量（--c-/--shadow-）', css.includes('var(--c-canvas)') && css.includes('var(--shadow-lifted)'));
  chk('CLI-11', '★ 负向对照：按钮样式不是胶囊（圆角 8px 卡片 / 默认按钮 4px）', !/border-radius:\s*9999px/.test(css));

  // 相关上下文：**展示的是 LLM 概括，不是材料清单**（用户 2026-10-14 四页详情都点名）
  // ★★ 2026-10-14 改：这条原来是「浮层列出召回材料（**路径 + 相似度**）」，
  //   而用户这一轮明确要求「将相关内容通过 LLM 概括后展示；**不得显示相关上下文的文件路径**」。
  //   ⇒ 它当场变红 —— **红得对，它守的是旧行为**（那份行为现在是被明文禁止的）。
  //   ⇒ 改成守新行为：**展示概括**，且**脚本里不许再出现 `h.path`**（出现就是把路径又列回去了）。
  chk('CLI-12', '★★ 相关上下文展示的是**概括**，且**脚本里不再有列出路径的代码**（用户明文禁止显示路径）',
    js.includes('contextSummary') && !js.includes('h.path'),
    js.includes('h.path') ? '★ 仍在列路径' : '已改为概括');
  chk('CLI-13', '★ 概括还没算完 / 算不出来时**如实说**（不退回去列路径、也不假装有内容）',
    js.includes('正在概括') && js.includes('contextSummaryError'));
  chk('CLI-14', '笔记的分析与建议 / 可视化（建议态与已建态）/ 分析未完成 都渲染', js.includes('分析与建议') && js.includes('可视化') && js.includes('v.built === true') && js.includes('分析未完成'));

  // ══════════════════════════════════════════════════════════════════════════
  // ★★ 2026-10-14 加：**动作按钮真的接上了没有**（用户第 4~7 条都点名这件事："需适配对应模块
  //   已登记的写路径，点击后执行实际功能，而非仅提示未接线"）。
  //
  //   真机抓到的缺陷：`OP_ROUTE` 的键是**单数**（message/todo/schedule/note），
  //   而 `doOp` 拿到的 `type` 是**复数**（详情接口只认复数）⇒ 查表查不到
  //   ⇒ **四个页面的每一个动作都弹"这个动作还没有接线"** —— 正是用户抱怨的那句话。
  //
  //   ⚠️ 为什么之前的检查没抓到：它们验的是**映射表本身**（"表里有这几条、路径写没写对"），
  //     而错在**查表用的键** —— 表是对的，查错了。⇒ 检查必须落在**"键能不能对上"**上。
  // ══════════════════════════════════════════════════════════════════════════
  chk('CLI-15', '★★ 动作查表**做了单复数归一**（表用单数键、详情接口给的是复数 —— 不归一就每个动作都弹"还没有接线"）',
    /var SING = \{ messages: "message"/.test(js) && /OP_ROUTE\[type\] \|\| OP_ROUTE\[SING\[type\]\]/.test(js));
  chk('CLI-16', '★ 四类动作的映射都在（消息 4 个 / 待办 3 个 / 日程 2 个 / 笔记 2 个）', (() => {
    const need = [
      ['message', ['已回复', '转待办', '转日程', '转笔记']],
      ['todo', ['已完成', '已搁置', '转日程']],
      ['schedule', ['已完成', '转待办']],
      ['note', ['分析笔记', '可视化构建']],
    ];
    return need.every(([bucket, names]) => names.every((n) => js.includes(`"${n}"`)));
  })());
  chk('CLI-17', '★ 负向对照：**不许**留一条"随手拼路径"的兜底（拼出来的路径多半没登记，撞 404 再拿"未登记"当解释）',
    !/API \+ "\/" \+ type \+ "\/" \+ id \+ "\/act"/.test(js));

  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
