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
  L.push('  function overlay(title, rows, ops, onOp) {');
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
  L.push('  if (list && TYPE) {');
  L.push('    list.addEventListener("click", function (ev) {');
  L.push('      var li = ev.target.closest ? ev.target.closest("li") : null;');
  L.push('      if (!li) return;');
  L.push('      var idx = Array.prototype.indexOf.call(list.children, li);');
  L.push('      fetch(API + "/pages/" + TYPE).then(function (r) { return r.json(); }).then(function (d) {');
  L.push('        var item = (d.list || [])[idx];');
  L.push('        if (!item) { alert("找不到这一条（列表可能已刷新）"); return; }');
  L.push('        return fetch(API + "/detail/" + TYPE + "/" + item.id).then(function (r) { return r.json(); }).then(function (det) {');
  L.push('          var seen = det.structured || {}; var orig = det.original || {};');
  L.push('          var rec = (det.context && det.context.recalled) || [];');
  L.push('          var recallError = det.context && det.context.recallError;');
  // ★ 相关上下文要**列出材料本身**（路径 + 相似度），并区分两种"空"：
  //   真的没召回到 vs 召回不可用 —— 后者必须写明原因，不能显示成"暂无相关材料"
  L.push('          var ctxText = rec.length');
  L.push('            ? rec.slice(0, 3).map(function (h) { return h.path + "（" + (h.similarity === null || h.similarity === undefined ? "-" : h.similarity) + "）"; }).join("\\n")');
  L.push('            : (recallError ? ("召回不可用：" + recallError) : "暂无相关材料");');
  L.push('          var rows = [["结构化内容", seen.topic || seen.raw || seen.summary || ""], ["原始消息", (orig.sender || "") + " · " + (orig.raw || "")], ["相关上下文", ctxText]];');
  L.push('          if (det.analysis && det.analysis.text) rows.push(["分析与建议", det.analysis.text]);');
  L.push('          if (det.analysis && det.analysis.visual) rows.push(["可视化建议", det.analysis.visual.suggested + " —— " + det.analysis.visual.why]);');
  L.push('          if (det.analysis && det.analysis.error) rows.push(["分析未完成", det.analysis.error]);');
  L.push('          overlay(s.topic || s.raw || "详情", rows, det.availableOps || [], function (name) { doOp(TYPE, item.id, name); });');
  L.push('        });');
  L.push('      }).catch(function (e) { alert("取详情失败：" + e.message); });');
  L.push('    });');
  L.push('  }');
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
  chk('CLI-4', '点击行取详情（先取页面列表拿到 id）', js.includes('/pages/') && js.includes('/detail/'));
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
  chk('CLI-14', '笔记的分析与建议 / 可视化建议 / 分析未完成三种都渲染', js.includes('分析与建议') && js.includes('可视化建议') && js.includes('分析未完成'));

  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
