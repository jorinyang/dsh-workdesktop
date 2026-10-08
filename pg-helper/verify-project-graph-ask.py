"""工程图 · **说明文字标红** + **删除确认跟着鼠标弹**（实机核验）

用户 2026-10-09 提的两条。

这一版把说明文字**用接口建在画布正中央**（不是建在鼠标位置）。
它原来是建在右键那一点的，常常落在画布边缘外 —— 于是"划线划不到它、点它也点不着"，
测试红得莫名其妙（功能其实是好的）。位置确定化之后，这两条才真的在测功能。

标红那条必须查**算出来的描边颜色**，不能只查 data-cut 在不在：
之前的 bug 是属性加上了、但被 [data-border="none"]{stroke:none} 盖掉，
只查属性的话当时也是"通过"的，等于没测。
"""
import json
import os
import sys
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:3080"
PROJECT = "删除与标红自测临时工程"
SHOT = os.path.join(os.path.expanduser("~"), "Desktop", "DSH")
RED = "rgb(229, 72, 77)"          # #e5484d
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
        print(f"         {str(detail)[:250]}")


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


def ents():
    return [o for o in doc() if o.get("type") != "LineEdge"]


api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
api("/workdesktop/api/pg/project", {"action": "create", "name": PROJECT})
dialogs = []

try:
    # ★ 一次建**两条**说明文字，位置都确定：
    #   一条用来验标红（它会被真的剪掉），另一条用来验删除确认 ——
    #   第一版只建一条，剪完就没了，后面的删除确认找不到对象（测试自己的问题）。
    api("/workdesktop/api/pg/insert", {"project": PROJECT, "nodes": [
        {"text": "被剪的说明", "x": 0, "y": -150, "borderStyle": "none"},
        {"text": "待删说明", "x": 0, "y": 150, "borderStyle": "none"}]})
    notes = [o for o in ents() if o.get("borderStyle") == "none"]
    note_uuid = next((o["uuid"] for o in notes if o.get("text") == "被剪的说明"), None)
    del_uuid = next((o["uuid"] for o in notes if o.get("text") == "待删说明"), None)
    chk("ASK-1", "两条说明文字已建在画布中央（接口建的，位置确定）",
        note_uuid is not None and del_uuid is not None, f"被剪={str(note_uuid)[:8]} 待删={str(del_uuid)[:8]}")

    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True)
        page = b.new_page(viewport={"width": 1600, "height": 1000})
        page.on("dialog", lambda d: (dialogs.append(d.type), d.dismiss()))
        page.goto(f"{BASE}/?token={read_token()}", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(9000)
        for label in ["继续", "知道了", "关闭"]:
            try:
                btn = page.get_by_role("button", name=label)
                if btn.count() > 0:
                    btn.first.click(timeout=3000)
                    page.wait_for_timeout(1000)
                    break
            except Exception:
                pass
        for i in range(page.get_by_text("工程图", exact=True).count()):
            bb = page.get_by_text("工程图", exact=True).nth(i).bounding_box()
            if bb and bb["x"] < 260 and bb["y"] > 600:
                page.get_by_text("工程图", exact=True).nth(i).click()
                break
        page.wait_for_timeout(3500)
        page.select_option(".dshw-pg-bar select", PROJECT)
        page.wait_for_timeout(4500)

        u8 = str(note_uuid)[:8]

        def rect_of(needle):
            wraps = page.locator("svg .dshw-pg-nodewrap")
            for i in range(wraps.count()):
                t = wraps.nth(i).locator("title").first.text_content() or ""
                if needle in t:
                    return wraps.nth(i).locator("rect").first.bounding_box()
            return None

        rb = rect_of(u8)
        chk("ASK-2", "在画布上找到了这条说明文字", rb is not None, f"{rb}")

        # ── ① 右键拖一条线穿过它：说明文字也要变红 ────────────────────
        if rb is not None:
            ny = rb["y"] + rb["height"] / 2
            nx = rb["x"] + rb["width"] / 2
            page.mouse.move(nx, ny)                 # 从它自己身上起手，一定命中
            page.mouse.down(button="right")
            for k in range(1, 13):
                page.mouse.move(nx - 10 * k, ny)
                page.wait_for_timeout(35)
            # ★ 查**这一条**算出来的描边，不是查"有没有谁是红的"
            stroke = None
            cut_flag = None
            wraps = page.locator("svg .dshw-pg-nodewrap")
            for i in range(wraps.count()):
                t = wraps.nth(i).locator("title").first.text_content() or ""
                if u8 in t:
                    rr = wraps.nth(i).locator("rect").first
                    cut_flag = rr.get_attribute("data-cut")
                    stroke = rr.evaluate("el => getComputedStyle(el).stroke")
                    break
            chk("ASK-3", "★★ 拖动中：说明文字被打上『将要被剪』的记号", cut_flag == "1", f"data-cut={cut_flag}")
            chk("ASK-3b", "★★ 而且它**算出来的描边是红的**（不是被 none 盖掉）",
                stroke == RED, f"computed stroke = {stroke}（期望 {RED}）")
            page.mouse.up(button="right")
            page.wait_for_timeout(4500)

        # ── ② 删除：浮层跟着鼠标、回车确定 ─────────────────────────────
        # 用的是**另一条**（待删说明），所以上一步的剪断不会把它带走
        target = next((o for o in ents() if o.get("uuid") == del_uuid), None)
        if target is None:
            target = next((o for o in ents() if o.get("text") == "待删说明"), None)

        before = len(ents())
        rb2 = rect_of(str(target["uuid"])[:8]) if target else None
        chk("ASK-4", "定位到要删的那条说明文字", rb2 is not None, f"{rb2}")
        if rb2 is not None:
            mx = rb2["x"] + rb2["width"] / 2
            my = rb2["y"] + rb2["height"] / 2
            page.mouse.click(mx, my)                  # 点一下：选中 + 拿焦点
            page.wait_for_timeout(700)
            picked = page.locator('.dshw-pg-node[data-picked="1"]').count()
            focus_now = page.evaluate("() => document.activeElement && String(document.activeElement.className)")
            chk("ASK-4b", "点一下选中它、且焦点在画布上", picked >= 1 and "dshw-pg-canvas" in focus_now,
                f"选中 {picked}，焦点 {focus_now}")

            page.keyboard.press("Delete")
            page.wait_for_timeout(1200)
            ask = page.locator(".dshw-pg-ask")
            chk("ASK-5", "★ 按 Delete 之后出现的是**画布里的浮层**，不是浏览器对话框",
                ask.count() == 1 and len(dialogs) == 0, f"浮层 {ask.count()}，对话框 {dialogs}")
            if ask.count() == 1:
                ab = ask.first.bounding_box()
                chk("ASK-6", "★★ 浮层弹在**鼠标附近**（不是屏幕顶部的 0,0）",
                    ab is not None and abs(ab["x"] - mx) < 260 and abs(ab["y"] - my) < 200,
                    f"浮层左上 ({ab['x']:.0f},{ab['y']:.0f}) vs 鼠标 ({mx:.0f},{my:.0f})")
                page.keyboard.press("Escape")
                page.wait_for_timeout(900)
                chk("ASK-7", "★★ **ESC 取消**：浮层关掉、对象还在",
                    page.locator(".dshw-pg-ask").count() == 0 and len(ents()) == before,
                    f"对象 {before}->{len(ents())}")
                page.mouse.click(mx, my)
                page.wait_for_timeout(600)
                page.keyboard.press("Delete")
                page.wait_for_timeout(900)
                page.keyboard.press("Enter")
                page.wait_for_timeout(4500)
                chk("ASK-8", "★★ **回车确定**：对象真的被删了", len(ents()) == before - 1,
                    f"对象 {before}->{len(ents())}")
                chk("ASK-9", "★★ 全程**零浏览器对话框**", len(dialogs) == 0, f"{dialogs}")

        g = api("/workdesktop/api/pg/graph?project=" + urllib.parse.quote(PROJECT))
        chk("ASK-10", "★★ 删完上游照样能打开", g.get("ok") is True, f"ok={g.get('ok')}")
        page.screenshot(path=os.path.join(SHOT, "ui-25-ask.png"))
        b.close()
finally:
    removed = api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
    print(f"\n清理：{'临时工程已删除' if removed.get('ok') else str(removed)[:130]}")

print(f"\nPASS={passed} FAIL={failed}")
sys.exit(0 if failed == 0 else 1)
