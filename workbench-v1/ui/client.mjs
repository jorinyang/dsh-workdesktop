/**
 * v1/ui/client.mjs —— **弈枢页面的客户端脚本**（P4 交互层；需求 3.3.3–3.3.6 的"新增"与"点击弹详情"）
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
  L.push('  var list = main.querySelector(".list");');
  L.push('');
  L.push('  function el(tag, cls, text) { var d = document.createElement(tag); if (cls) d.className = cls; if (text !== undefined) d.textContent = text; return d; }');
  L.push('');
  L.push('  function overlay(title, rows, ops, onOp, det) {');
  L.push('    var back = el("div", "overlay-back");');
  L.push('    var box = el("div", "overlay");');
  L.push('    box.appendChild(el("h2", null, title || "详情"));');
  L.push('    rows.forEach(function (r) {');
  L.push('      var line = el("div", "ov-row");');
  L.push('      line.appendChild(el("span", "ov-k", r[0]));');
  L.push('      line.appendChild(el("span", "ov-v", r[1] === null || r[1] === undefined || r[1] === "" ? "—" : String(r[1])));');
  L.push('      box.appendChild(line);');
  L.push('    });');
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
  L.push('  function doOp(type, id, name) {');
  L.push('    var path = "/" + type + "/" + id + "/act";');
  L.push('    fetch(API + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payload: { op: name } }) })');
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
  L.push('  function openDetail(type, id) {');
  L.push('    fetch(API + "/detail/" + type + "/" + id).then(function (r) { return r.json(); }).then(function (det) {');
  L.push('      if (det && det.error) { alert("取详情失败：" + det.error); return; }');
  L.push('      var seen = det.structured || {}; var orig = det.original || {};');
  L.push('      var rec = (det.context && det.context.recalled) || [];');
  L.push('      var recallError = det.context && det.context.recallError;');
  // ★ 相关上下文要**列出材料本身**（路径 + 相似度），并区分两种"空"：
  //   真的没召回到 vs 召回不可用 —— 后者必须写明原因，不能显示成"暂无相关材料"
  L.push('      var ctxText = rec.length');
  L.push('        ? rec.slice(0, 3).map(function (h) { return h.path + "（" + (h.similarity === null || h.similarity === undefined ? "-" : h.similarity) + "）"; }).join("\\n")');
  L.push('        : (recallError ? ("召回不可用：" + recallError) : "暂无相关材料");');
  L.push('      var rows = [["结构化内容", seen.topic || seen.raw || seen.summary || ""], ["原始消息", (orig.sender || "") + " · " + (orig.raw || "")], ["相关上下文", ctxText]];');
  L.push('      if (det.analysis && det.analysis.text) rows.push(["分析与建议", det.analysis.text]);');
  L.push('      var v = det.analysis && det.analysis.visual;');
  L.push('      if (v) rows.push(["可视化", v.built === true');
  L.push('        ? ("已建：" + (v.tool || "") + " · " + (v.name || v.ref || ""))');
  L.push('        : (v.suggested ? ("建议 " + v.suggested + " —— " + (v.why || "") + (v.error ? "（上次构建失败：" + v.error + "）" : "")) : "")]);');
  L.push('      if (det.analysis && det.analysis.error) rows.push(["分析未完成", det.analysis.error]);');
  L.push('      if (det.deliverables && det.deliverables.length) rows.push(["结果 / 交付物", det.deliverables.map(function (d) { return d.text || d.ref || ""; }).join("\\n")]);');
  // ★ 用户 Q2 裁定的前端那一半：判据不足的候选项标「待处置」，并给**一键创建**。
  //   高置信的已经被自动建过了（这里只显示"已建"的结果），所以这里出现的都是"要你点一下"的。
  L.push('      if (det.detect && det.detect.pending && det.detect.pending.length) {');
  L.push('        rows.push(["待处置候选", det.detect.pending.map(function (c) { return KIND[c.kind] + "（" + c.confidence + "）：" + c.why; }).join("\\n")]);');
  L.push('      }');
  L.push('      if (det.detect && det.detect.created && det.detect.created.length) {');
  L.push('        rows.push(["已自动创建", det.detect.created.map(function (c) { return KIND[c.kind] + "（" + c.action + "）"; }).join("\\n")]);');
  L.push('      }');
  L.push('      overlay(seen.topic || seen.raw || seen.summary || "详情", rows, det.availableOps || [], function (name) { doOp(type, id, name); }, det.detect);');
  L.push('    }).catch(function (e) { alert("取详情失败：" + e.message); });');
  L.push('  }');
  L.push('');
  L.push('  if (list && TYPE) {');
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
  //   同一页面内点 ⇒ 直接开浮层；跨页面 ⇒ 走 `#页?open=类型:id`，由目标页的脚本接手。
  L.push('  if (page === "overview" && list) {');
  L.push('    list.addEventListener("click", function (ev) {');
  L.push('      var li = ev.target.closest ? ev.target.closest("li") : null;');
  L.push('      if (!li) return;');
  L.push('      var id = li.getAttribute("data-id"); var kind = li.getAttribute("data-go");');
  L.push('      if (!id || !kind) return;');
  L.push('      var dest = PAGE_OF[kind];');
  L.push('      if (!dest) { openDetail(kind, id); return; }');
  L.push('      location.hash = "#" + dest + "?open=" + kind + ":" + id;');
  L.push('      location.reload();');
  L.push('    });');
  L.push('  }');
  L.push('');
  // 目标页接手：地址里带 `?open=类型:id` ⇒ 落页后自动开那一条的详情
  L.push('  var hm = /[?&]open=([a-z]+):([A-Za-z0-9_]+)/.exec(location.hash || "");');
  L.push('  if (hm && TYPE && PAGE_OF[hm[1]] === page) { setTimeout(function () { openDetail(hm[1], hm[2]); }, 0); }');
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
  L.push('      var payload = {};');
  L.push('      for (var i = 0; i < forms.length; i++) {');
  L.push('        var v = window.prompt(forms[i][1], "");');
  L.push('        if (v === null) return;');
  L.push('        if (v === "") continue;');
  L.push('        payload[forms[i][0]] = forms[i][0] === "tags" ? v.split(/[,，]/).map(function (x) { return x.trim(); }).filter(Boolean) : v;');
  L.push('      }');
  L.push('      if (TYPE === "messages") { payload.channel = "manual"; payload.source = "manual"; payload.modality = "text"; payload.summary = String(payload.raw || "").slice(0, 60); }');
  L.push('      if (TYPE === "notes") { payload.date = new Date().toISOString().slice(0, 10); }');
  L.push('      fetch(API + "/" + TYPE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payload: payload }) })');
  L.push('        .then(function (r) { return r.json().then(function (b) { return { code: r.status, body: b }; }); })');
  L.push('        .then(function (x) {');
  L.push('          if (x.code >= 400) { alert("新增失败：" + JSON.stringify(x.body.errors || x.body.error || x.body)); return; }');
  L.push('          location.reload();');
  L.push('        })');
  L.push('        .catch(function (e) { alert("新增请求失败：" + e.message); });');
  L.push('    });');
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
  chk('CLI-16', '★ 跨页跳转：总览三类提醒可跳对应页面（需求 3.3.2）', js.includes('data-go') && js.includes('PAGE_OF') && js.includes('?open='));
  chk('CLI-17', '★ 目标页接手：地址带 ?open=类型:id ⇒ 自动开那一条的详情', js.includes('openDetail(hm[1], hm[2])') && js.includes('hm[1]'));
  // ★ P2：待处置候选与一键创建（用户 Q2 的前端那一半）
  chk('CLI-18', '★ 浮层显示"待处置候选"与"已自动创建"两种结果（Q2：标注待处置）', js.includes('待处置候选') && js.includes('已自动创建'));
  chk('CLI-19', '★ 候选项能一键创建（按 kind 建为日程/待办/笔记）', js.includes('createFromCandidate') && js.includes('"建为" + KIND[c.kind]'));
  chk('CLI-20', '★ 转日程解析不出时间 ⇒ 单独话术（不与普通失败混同）', js.includes('x.code === 409') && js.includes('解析不出具体时间'));
  chk('CLI-21', '创建中按钮禁用（防连点重复建）', js.includes('btn.disabled = true') && js.includes('btn.disabled = false'));
  // 注：日程热力图那条断言在 `shell.mjs`（SH-30）—— 热力图是服务端渲染的，不属客户端脚本。
  chk('CLI-5', '浮层有可执行操作按钮', js.includes('availableOps') && js.includes('ov-ops'));
  chk('CLI-6', '★ 操作失败如实提示（含"未登记"这种明确原因）', js.includes('未登记') && js.includes('操作失败'));
  chk('CLI-7', '新增入口与四类表单都在', js.includes('btn-add') && js.includes('messages:') && js.includes('todos:') && js.includes('schedules:') && js.includes('notes:'));
  chk('CLI-8', '★ 新增走登记表里的路径（/messages /todos /schedules /notes）', js.includes('API + "/" + TYPE'));
  chk('CLI-9', '★ 负向对照：脚本里没有写死颜色值（样式走 token）', !/#[0-9a-fA-F]{6}/.test(css), (css.match(/#[0-9a-fA-F]{6}/) || ['无'])[0]);
  chk('CLI-10', '浮层样式含 token 变量（--c-/--shadow-）', css.includes('var(--c-canvas)') && css.includes('var(--shadow-lifted)'));
  chk('CLI-11', '★ 负向对照：按钮样式不是胶囊（圆角 8px 卡片 / 默认按钮 4px）', !/border-radius:\s*9999px/.test(css));

  // 相关上下文的两种"空"必须分开显示（真没召回 vs 召回不可用）
  chk('CLI-12', '★ 浮层列出召回材料（路径 + 相似度），不是只给条数', js.includes('h.path') && js.includes('h.similarity'));
  chk('CLI-13', '★ 召回不可用另写一行（不与"暂无相关材料"混同）', js.includes('召回不可用：') && js.includes('暂无相关材料'));
  chk('CLI-14', '笔记的分析与建议 / 可视化（建议态与已建态）/ 分析未完成 都渲染', js.includes('分析与建议') && js.includes('可视化') && js.includes('v.built === true') && js.includes('分析未完成'));

  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
