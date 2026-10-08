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
        page.on("dialog", lambda d: d.accept("说明文字甲" if "说明" in d.message else "新节点甲"))
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

        def right_click_blank(where="br"):
            if where == "tl":
                x, y = canv["x"] + 70, canv["y"] + 70
            else:
                x, y = canv["x"] + canv["width"] - 70, canv["y"] + canv["height"] - 70
            page.mouse.click(x, y, button="right")
            page.wait_for_timeout(700)

        # ── ① 在这里新建节点 ────────────────────────────────────────────
        n0 = len(doc())
        right_click_blank()
        menu = page.locator(".dshw-pg-menu")
        chk("MENU-1", "空白右键弹出菜单", menu.count() == 1, (menu.inner_text() or "").replace("\n", " / ")[:160])
        page.get_by_role("button", name="在这里新建节点").first.click()
        page.wait_for_timeout(3500)
        n1 = len(doc())
        texts = [o.get("text") for o in doc()]
        chk("MENU-2", "★★ 「在这里新建节点」**真的建出来了**（这就是你报失灵那一条）",
            n1 == n0 + 1 and "新节点甲" in texts, f"{n0} -> {n1} {json.dumps(texts, ensure_ascii=False)}")

        # ── ② 新建说明文字 ──────────────────────────────────────────────
        # ⚠️ 这一次要换一块**别的空白处**：上一次在那个位置新建了节点，
        #    同一个点再右键就点在**新节点**上了，弹出来的是节点菜单 —— 那是测试瞄偏，不是功能坏。
        right_click_blank("tl")
        items = (page.locator(".dshw-pg-menu").inner_text() or "")
        chk("MENU-3", "★ 菜单里有「新建说明文字（无边框）」", "说明文字" in items, items.replace("\n", " / ")[:160])
        page.get_by_role("button", name="在这里新建说明文字（无边框）").first.click()
        page.wait_for_timeout(3500)
        after = doc()
        note = next((o for o in after if o.get("text") == "说明文字甲"), None)
        chk("MENU-4", "★★ 说明文字建出来了，且 **borderStyle = none**（无边框纯文字）",
            note is not None and note.get("borderStyle") == "none",
            json.dumps(note, ensure_ascii=False)[:200] if note else "没找到")
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
        right_click_blank()
        page.get_by_role("button", name="全选").first.click()
        page.wait_for_timeout(900)
        picked = page.locator('.dshw-pg-node[data-picked="1"]').count()
        chk("MENU-6", "★★ 另一个菜单项「全选」也真的生效了（证明修的是这一类，不是一条）",
            picked >= 2, f"选中 {picked}")

        page.screenshot(path=os.path.join(SHOT, "ui-22-note.png"))
        b.close()
finally:
    removed = api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
    print(f"\n清理：{'临时工程已删除' if removed.get('ok') else str(removed)[:130]}")

print(f"\nPASS={passed} FAIL={failed}")
sys.exit(0 if failed == 0 else 1)
