"""右键菜单的项**真的会做事**吗？+「新建说明文字」（无边框纯文字）。

背景：菜单是画布的子元素，mousedown 会冒泡到画布，而画布第一件事就是关掉菜单 ——
于是**所有菜单项的 onClick 都不触发**（"右键-新建节点失灵"就是这个）。
所以这里不只验新建节点，还要验**别的项也真的动了**，否则只修好一条等于没修。
"""
import json
import os
import sys
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

from _suite_util import purge_project_backups

BASE = "http://127.0.0.1:3080"
PROJECT = "右键菜单自测临时工程"
SHOT = os.path.join(os.path.expanduser("~"), "Desktop", "DSH")
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
        print(f"         {str(detail)[:240]}")


def api(path, body=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=data, method="GET" if body is None else "POST")
    if body is not None:
        req.add_header("content-type", "application/json")
    with urllib.request.urlopen(req, timeout=180) as resp:
        return json.loads(resp.read().decode("utf-8"))


def read_token():
    log = os.path.join(os.path.expanduser("~"), ".dsh", "daemon", "dsh.log")
    with open(log, encoding="utf-8", errors="ignore") as fh:
        hits = [ln for ln in fh if "dsh web: http" in ln]
    return hits[-1].split("token=")[1].strip() if hits else ""


def doc():
    return api("/workdesktop/api/pg/document?project=" + urllib.parse.quote(PROJECT))["objects"]


api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
api("/workdesktop/api/pg/project", {"action": "create", "name": PROJECT})

try:
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True)
        page = b.new_page(viewport={"width": 1600, "height": 1000})
        # ⚠️ 2026-10-10 加：把页面报错收起来，红了才知道是不是 JS 抛异常（不是"选中 0"这种表面现象）
        PAGE_ERRORS = []
        page.on('pageerror', lambda e: PAGE_ERRORS.append(str(e)[:300]))
        # ⚠️ 2026-10-10 更正：新建**不再弹浏览器 prompt**（改成就地输入，名字由用户直接敲）。
        #    所以这里那个 `page.on("dialog", …)` 桩是历史遗留 —— 留着它不报错，
        #    但**别再用它给的名字去断言**：现在建出来的就是默认名（"新节点" / 说明文字是空串）。
        page.on("dialog", lambda d: d.dismiss())
        page.goto(f"{BASE}/?token={read_token()}", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(9000)
        for label in ["继续", "知道了", "关闭"]:
            try:
                btn = page.get_by_role("button", name=label)
                if btn.count() > 0:
                    btn.first.click(timeout=3000)
                    page.wait_for_timeout(1200)
                    break
            except Exception:
                pass
        cands = page.get_by_text("工程图", exact=True)
        for i in range(cands.count()):
            bb = cands.nth(i).bounding_box()
            if bb and bb["x"] < 260 and bb["y"] > 600:
                cands.nth(i).click()
                break
        page.wait_for_timeout(3500)
        page.select_option(".dshw-pg-bar select", PROJECT)
        page.wait_for_timeout(4500)

        canv = page.locator(".dshw-pg-canvas").bounding_box()

        # ⚠️ 2026-10-10 修：原来"空白处"是**写死的两个角落**（右下 70,70 / 左上 70,70）。
        #    可每建一个对象、面板就会重新适应窗口，对象会挪到那两个角落去 ——
        #    于是第③步在"右下角"右键，弹出来的其实是**对象菜单**（没有「全选」），
        #    后面 `get_by_role("button", name="全选")` 就等不到 ⇒ 超时假红。
        #    这**不是**功能坏：那一刻那个点确实不是空白了。
        #    改成**先问画布上哪儿真的空着**，再右键；并且右键之后确认菜单真的开了。
        def blank_points():
            """按"离对象最远"的顺序给出几个候选点（屏幕坐标）。"""
            obs = page.evaluate("""() => Array.from(document.querySelectorAll('svg .dshw-pg-nodewrap')).map((w) => {
              const r = w.querySelector('rect').getBoundingClientRect()
              return {x: r.x, y: r.y, w: r.width, h: r.height}
            })""")
            cands = []
            for fx in (0.5, 0.25, 0.75, 0.12, 0.88):
                for fy in (0.5, 0.25, 0.75, 0.12, 0.88):
                    px = canv["x"] + canv["width"] * fx
                    py = canv["y"] + canv["height"] * fy
                    # 离所有对象框的最小间距（点在框内算负的）
                    gap = min(
                        (max(o["x"] - px, px - (o["x"] + o["w"]), 0)
                         + max(o["y"] - py, py - (o["y"] + o["h"]), 0))
                        if not (o["x"] <= px <= o["x"] + o["w"] and o["y"] <= py <= o["y"] + o["h"])
                        else -1
                        for o in obs) if obs else 9999
                    if gap > 40:
                        cands.append((gap, px, py))
            cands.sort(reverse=True)
            return [(px, py) for _, px, py in cands]

        def right_click_blank(hint=""):
            """在真正的空白处右键；返回菜单开了没有。"""
            for px, py in blank_points():
                page.keyboard.press("Escape")
                page.wait_for_timeout(150)
                page.mouse.click(px, py, button="right")
                page.wait_for_timeout(800)
                menu = page.locator(".dshw-pg-menu")
                if menu.count() == 1:
                    txt = (menu.inner_text() or "")
                    # 对象菜单没有「全选」；只有空白菜单才有 —— 认错了就换个点再来
                    if "全选" in txt:
                        return True
                    page.keyboard.press("Escape")
                    page.wait_for_timeout(200)
            print(f"         （{hint}：找不到空白位置右键）")
            return False

        # ── ① 在这里新建节点 ────────────────────────────────────────────
        n0 = len(doc())
        chk("MENU-0", "找得到一块真正的空白处（后续几步都靠它）", right_click_blank("①"))
        menu = page.locator(".dshw-pg-menu")
        chk("MENU-1", "空白右键弹出菜单", menu.count() == 1, (menu.inner_text() or "").replace("\n", " / ")[:160])
        page.get_by_role("button", name="在这里新建节点").first.click()
        page.wait_for_timeout(3500)
        n1 = len(doc())
        texts = [o.get("text") for o in doc()]
        # 名字用**默认名**断言：新建是"先落一个默认名的对象、再就地进入输入态"，
        # 不再是浏览器 prompt（见上面 dialog 那段说明）。
        chk("MENU-2", "★★ 「在这里新建节点」**真的建出来了**（这就是你报失灵那一条）",
            n1 == n0 + 1 and any(t == "新节点" for t in texts), f"{n0} -> {n1} {json.dumps(texts, ensure_ascii=False)}")

        # ── ② 新建说明文字 ──────────────────────────────────────────────
        # ⚠️ 这一次也要换一块**别的空白处**：上一次新建的对象可能就落在刚才那个点上，
        #    同一个点再右键会弹出**对象菜单**。`right_click_blank` 会自己找空地方。
        chk("MENU-2b", "建完第一个对象之后，还找得到别的空白处", right_click_blank("②"))
        items = (page.locator(".dshw-pg-menu").inner_text() or "")
        chk("MENU-3", "★ 菜单里有「新建说明文字」", "说明文字" in items, items.replace("\n", " / ")[:160])
        # ⚠️ 2026-10-10 更正：按钮文案是「在这里新建说明文字」，**没有**「（无边框）」后缀
        #    （产品里本来就没有这个后缀，见 client.js 的菜单定义）。旧断言按带后缀的名字找，
        #    必然等不到 ⇒ 超时假红。这里按**真实文案**找，并且顺带断言后缀确实不在。
        note_btn = page.get_by_role("button", name="在这里新建说明文字", exact=True)
        chk("MENU-3b", "★ 按钮文案就是「在这里新建说明文字」（不带后缀）", note_btn.count() == 1,
            f"匹配到 {note_btn.count()} 个")
        note_btn.first.click()
        page.wait_for_timeout(3500)
        after = doc()
        # 说明文字的默认名是**空串**（它是无边框的标注，不占名字）；判据是 borderStyle
        note = next((o for o in after if o.get("borderStyle") == "none"), None)
        chk("MENU-4", "★★ 说明文字建出来了，且 **borderStyle = none**（无边框纯文字）",
            note is not None,
            json.dumps(note, ensure_ascii=False)[:200] if note else
            "没找到 borderStyle=none 的对象：" + json.dumps([o.get("text") for o in after], ensure_ascii=False)[:160])
        # 画布上它确实不带框
        pg = api("/workdesktop/api/pg/graph?project=" + urllib.parse.quote(PROJECT))
        chk("MENU-4b", "★★ 上游 CLI 也认它（文件仍然合法）", pg.get("ok") is True,
            f"ok={pg.get('ok')}")

        none_rects = page.locator('.dshw-pg-node[data-border="none"]')
        chk("MENU-5", "★ 画布上它挂在 data-border=none 上（不画框）", none_rects.count() >= 1,
            f"none 框 {none_rects.count()}")

        # ── ③ 别的菜单项也要真的动（只修一条等于没修）────────────────────
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        page.locator(".dshw-pg-canvas").click(position={"x": 5, "y": 5})
        page.wait_for_timeout(400)
        chk("MENU-5b", "第③步之前又找到一块空白处（这一刻对象已经比开局长多了）",
            right_click_blank("③"))
        page.get_by_role("button", name="全选").first.click()
        page.wait_for_timeout(900)
        picked = page.locator('.dshw-pg-node[data-picked="1"]').count()
        print("         页面报错:", PAGE_ERRORS[:3])
        chk("MENU-6", "★★ 另一个菜单项「全选」也真的生效了（证明修的是这一类，不是一条）",
            picked >= 2, f"选中 {picked}")

        page.screenshot(path=os.path.join(SHOT, "ui-22-note.png"))
        b.close()
finally:
    removed = api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
    # 备份目录一起收干净：delete 只删 .prg，snapshots/versions 里的备份要另外收（见 _suite_util.py）
    purged = purge_project_backups(PROJECT)
    print(f"\n清理：{'临时工程已删除' if removed.get('ok') else str(removed)[:130]}")

print(f"\nPASS={passed} FAIL={failed}")
sys.exit(0 if failed == 0 else 1)
