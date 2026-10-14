# -*- coding: utf-8 -*-
"""顶栏 / 底栏改版 + 导出下载（用户 2026-10-10 五条）。

一、导出必须**真的下载**到 .prg（原来点了一点反应没有）
二、底部统计与提示**并排一行**
三、顶栏「删除」右边有「帮助」，点开详情页；原操作指引搬过去
四、删除选中 / 重读 / 撤销 / 重做 搬到**工程图名称左侧**
五、底部「上游 …」那行没了，改成工程图文字右侧显示当前文件路径
"""
import io
import json
import os
import sys
import urllib.parse
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

from playwright.sync_api import sync_playwright

from _suite_util import purge_project_backups

BASE = "http://127.0.0.1:3080"
PROJECT = "界面改版自测临时工程"
passed = 0
failed = 0


def chk(cid, desc, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"  [PASS] {cid:<10} {desc}")
    else:
        failed += 1
        print(f"  [FAIL] {cid:<10} {desc}")
    if detail:
        print(f"         {str(detail)[:300]}")


def api(path, body=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=data, method="GET" if body is None else "POST")
    if body is not None:
        req.add_header("content-type", "application/json")
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode("utf-8"))


def read_token():
    log = os.path.join(os.path.expanduser("~"), ".dsh", "daemon", "dsh.log")
    with open(log, encoding="utf-8", errors="ignore") as fh:
        hits = [ln for ln in fh if "dsh web: http" in ln]
    return hits[-1].split("token=")[1].strip() if hits else ""


api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
api("/workdesktop/api/pg/project", {"action": "create", "name": PROJECT})

try:
    api("/workdesktop/api/pg/insert", {"project": PROJECT, "nodes": [
        {"text": "甲", "x": -300, "y": 0}, {"text": "乙", "x": 0, "y": 0}]})

    with sync_playwright() as p:
        pw = p.chromium.launch(channel="chrome", headless=True)
        # ★ 下载要能被接住：Playwright 默认会把下载取消掉，必须先 accept_downloads
        ctx = pw.new_context(viewport={"width": 1600, "height": 1000}, accept_downloads=True)
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)[:200]))
        page.goto(f"{BASE}/?token={read_token()}", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(9000)
        page.click('button[data-dshw-panel="dsh-workdesktop:project-graph"]')
        page.wait_for_timeout(4000)
        page.select_option(".dshw-pg-bar select", PROJECT)
        page.wait_for_timeout(5000)

        def nth_child_texts(sel):
            return page.evaluate("""(s) => Array.from(document.querySelectorAll(s + ' > *')).map(e => (e.textContent||'').trim())""", sel)

        bar = nth_child_texts(".dshw-pg-bar")
        print(f"         顶栏顺序：{json.dumps(bar, ensure_ascii=False)[:300]}")

        # ── 四、删除选中/重读/撤销/重做 在工程名左侧 ──────────────
        def idx_of(sub):
            for i, t in enumerate(bar):
                if sub in t:
                    return i
            return -1
        i_del = idx_of('删除选中'); i_re = idx_of('重读'); i_un = idx_of('撤销'); i_rd = idx_of('重做')
        i_sel = next((i for i, t in enumerate(bar) if t == '' or '甲' in t or '.prg' in t), -1)
        # 工程下拉是 <select>，textContent 为空；用它做分界
        select_idx = page.evaluate("""() => { const kids = Array.from(document.querySelector('.dshw-pg-bar').children)
          return kids.findIndex(k => k.tagName === 'SELECT') }""")
        chk("UI-4", "★ 删除选中 / 重读 / 撤销 / 重做 都搬到了**工程名（下拉）左侧**",
            all(x >= 0 for x in (i_del, i_re, i_un, i_rd)) and max(i_del, i_re, i_un, i_rd) < select_idx,
            f"位置 删除选中={i_del} 重读={i_re} 撤销={i_un} 重做={i_rd}；工程下拉={select_idx}")
        chk("UI-4b", "★ 而且顺序就是「删除选中 / 重读 / 撤销 / 重做」",
            i_del < i_re < i_un < i_rd, f"{i_del} < {i_re} < {i_un} < {i_rd}")

        # ── 五、当前文件路径在工程图文字右侧，底部"上游 …"消失 ──────
        path_txt = (page.locator(".dshw-pg-path").inner_text() or "").strip()
        chk("UI-5", "★ 工程图文字右侧显示**当前文件路径**（含工程名与 .prg）",
            PROJECT.replace('.prg', '') in path_txt and path_txt.endswith('.prg'),
            f"路径 = {path_txt}")
        body_txt = page.locator(".dshw-pg").inner_text() or ""
        chk("UI-5b", "★ 底部原来的「上游 C:\\…」那行**已经没了**",
            "上游 C:" not in body_txt and "上游 /" not in body_txt,
            "整页文本里搜 '上游 C:' → " + str("上游 C:" in body_txt))

        # ── 二、底部统计与提示并排一行 ────────────────────────────
        # ⚠️ 判"同一行"要比较**垂直中心**，不能比较 top：
        #    没有提示时那个 span 是**空**的（height=0），它的 top 恰好落在行的中心线上，
        #    于是 top 差 8px —— 看着像错行，其实同一行。第一版就是这么误判的。
        def row_geom():
            return page.evaluate("""() => {
              const el = document.querySelector('.dshw-pg-bar2')
              if (!el) return null
              const r = el.getBoundingClientRect()
              const cs = getComputedStyle(el)
              const kids = Array.from(el.children).map(k => {
                const b = k.getBoundingClientRect()
                return {txt: (k.textContent||'').trim().slice(0,50), cy: (b.top + b.bottom) / 2, h: Math.round(b.height)}
              })
              return {h: Math.round(r.height), wrap: cs.flexWrap, kids,
                      bottom: Math.round(r.bottom),
                      panelBottom: Math.round(document.querySelector('.dshw-pg').getBoundingClientRect().bottom)}
            }""")

        rows = row_geom()
        # 空提示那个 span 的 height 是 0，但它照样被 `align-items:center` 摆在这一行的中心线上，
        # 所以"同一行"就是**所有孩子的垂直中心一致**（不用管高度是不是 0）。
        same_row = rows is not None and len(rows["kids"]) >= 2 and \
            (max(k["cy"] for k in rows["kids"]) - min(k["cy"] for k in rows["kids"])) <= 3
        chk("UI-2", "★ 统计信息与提示信息**并排在同一行**（比垂直中心）",
            rows is not None and rows["wrap"] == "nowrap" and same_row,
            json.dumps(rows, ensure_ascii=False)[:300])
        chk("UI-2b", "★ 而且这一行就在**最下方**（贴着面板底边）",
            rows is not None and abs(rows["bottom"] - rows["panelBottom"]) <= 4,
            f"行底 {rows['bottom'] if rows else '?'} vs 面板底 {rows['panelBottom'] if rows else '?'}")

        # 触发一条**长**提示（导出那句话最长），确认它不会把行折成两行
        page.locator(".dshw-pg-bar").get_by_role("button", name="导出").first.click()
        page.wait_for_timeout(3000)
        rows2 = row_geom()
        long_txt = [k for k in rows2["kids"] if len(k["txt"]) > 20] if rows2 else []
        chk("UI-2c", "★★ 出现**长提示**时两者仍在同一行、且没有折行",
            rows2 is not None and rows2["wrap"] == "nowrap"
            and (max(k["cy"] for k in rows2["kids"]) - min(k["cy"] for k in rows2["kids"])) <= 3
            and len(long_txt) >= 1,
            json.dumps(rows2, ensure_ascii=False)[:300])

        # ── 三、帮助按钮在删除右边，详情页有操作指引 ────────────────
        buttons = page.evaluate("""() => Array.from(document.querySelectorAll('.dshw-pg-bar button')).map(b => (b.textContent||'').trim())""")
        chk("UI-3", "★ 顶栏「删除」右边有「帮助」按钮",
            "帮助" in buttons and buttons.index("帮助") == buttons.index("删除") + 1,
            json.dumps(buttons, ensure_ascii=False)[:200])
        chk("UI-3b", "点之前帮助详情页是关着的", page.locator(".dshw-pg-help").count() == 0, "")
        page.get_by_role("button", name="帮助").first.click()
        page.wait_for_timeout(700)
        help_txt = (page.locator(".dshw-pg-help").inner_text() or "") if page.locator(".dshw-pg-help").count() > 0 else ""
        chk("UI-3c", "★ 点开之后出现帮助详情页，且里面是**操作指引**",
            "操作指引" in help_txt and ("拖动移动" in help_txt or "框选" in help_txt),
            f"帮助页字数 {len(help_txt)}；开头 {help_txt[:80]}")
        chk("UI-3d", "★ 原来画布下方那行操作指引**已经不在主界面**了",
            "右键在**框体上**拖动" not in (page.locator(".dshw-pg").inner_text() or ""),
            "主界面里搜原指引 → " + str("拖动移动 · 空白拖出框选" in (page.locator('.dshw-pg').inner_text() or '')))
        page.locator(".dshw-pg-help button[data-close]").first.click()
        page.wait_for_timeout(700)
        chk("UI-3e", "点「收起」能关掉帮助页", page.locator(".dshw-pg-help").count() == 0,
            f"帮助页还剩 {page.locator('.dshw-pg-help').count()} 个")

        # ── 一、导出真的下载一个 .prg ──────────────────────────────
        try:
            with page.expect_download(timeout=30000) as dl:
                page.locator(".dshw-pg-bar").get_by_role("button", name="导出").first.click()
            d = dl.value
            path = d.path()
            size = os.path.getsize(path) if path else 0
            with open(path, "rb") as fh:
                magic = fh.read(2)
            chk("UI-1", "★★ 点「导出」**真的触发了下载**，建议文件名是 .prg",
                str(d.suggested_filename).endswith('.prg'), f"文件名 = {d.suggested_filename}")
            chk("UI-1b", "★★ 下载到的文件**不是空的**，而且是上游格式（zip 头 PK）",
                size > 0 and magic == b'PK', f"大小 {size} 字节；头两字节 {magic!r}")
            print(f"         下载落地：{path}")
        except Exception as e:
            chk("UI-1", "★★ 点「导出」真的触发了下载", False, f"没等到下载事件：{str(e)[:200]}")
            chk("UI-1b", "★★ 下载内容非空且是 zip（PK 头）", False, "（上一条没成，跳过）")

        chk("UI-6", "整个过程没有页面报错", len(errs) == 0, " | ".join(errs)[:200])
        page.screenshot(path=os.path.join(os.path.expanduser("~"), "Desktop", "DSH", "ui-40-bars.png"), full_page=False)
        ctx.close()
        pw.close()
finally:
    removed = api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
    purged = purge_project_backups(PROJECT)
    print(f"\n清理：{'临时工程已删除' if removed.get('ok') else str(removed)[:130]}（另收 {purged} 个备份目录）")

print(f"\nPASS={passed} FAIL={failed}")
sys.exit(0 if failed == 0 else 1)
