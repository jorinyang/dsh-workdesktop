"""工程图 · **新建节点 / 新建说明文字 / 空白双击写说明**（实机核验）

用户 2026-10-09 裁定的五条：
  ① 菜单去掉「（无边框）」字样；
  ② 说明文字不产生连线，只作标注；
  ③ 新建节点 → 画布上直接出现默认宽高的框体，**进入输入状态**；
  ④ 新建说明文字 → 鼠标位置出现光标，**直接打字**；
  ⑤ 空白处双击 = 新建说明文字。

这一版最关键的改变是**不再弹 window.prompt** —— 光标落在画布上，不是在浏览器弹窗里。
所以这里专门有一条断言盯"整个过程一次对话框都没有弹"。
"""
import json
import os
import sys
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:3080"
PROJECT = "新建流程自测临时工程"
SHOT = os.path.join(os.path.expanduser("~"), "Desktop", "DSH")
passed = 0
failed = 0


def chk(cid, desc, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"  [PASS] {cid:<12} {desc}")
    else:
        failed += 1
        print(f"  [FAIL] {cid:<12} {desc}")
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
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True)
        page = b.new_page(viewport={"width": 1600, "height": 1000})
        # 记下所有对话框：这一版**一次都不该有**
        page.on("dialog", lambda d: (dialogs.append(f"{d.type}:{d.message[:40]}"), d.dismiss()))
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

        def right_blank(where):
            if where == "tl":
                x, y = canv["x"] + 80, canv["y"] + 80
            elif where == "tr":
                x, y = canv["x"] + canv["width"] - 80, canv["y"] + 80
            else:
                x, y = canv["x"] + canv["width"] - 90, canv["y"] + canv["height"] - 90
            page.mouse.click(x, y, button="right")
            page.wait_for_timeout(700)
            return x, y

        def edit_box():
            return page.locator(".dshw-pg-edit")

        # ── ① 菜单文案 ──────────────────────────────────────────────────
        right_blank("bl")
        items = (page.locator(".dshw-pg-menu").inner_text() or "").replace("\n", " / ")
        chk("CR-1", "★ 菜单里不再有「（无边框）」字样", "（无边框）" not in items and "(无边框)" not in items, items[:170])
        chk("CR-2", "★ 菜单里那一项就叫「在这里新建说明文字」", "在这里新建说明文字" in items, items[:170])

        # ── ② 新建节点：出框体 + 直接进输入态 ───────────────────────────
        n0 = len(ents())
        page.get_by_role("button", name="在这里新建节点").first.click()
        page.wait_for_timeout(4000)
        n1 = len(ents())
        box = edit_box()
        chk("CR-3", "★★ 「新建节点」建出了对象，并且**光标已经在画布上**",
            n1 == n0 + 1 and box.count() >= 1, f"对象 {n0}->{n1}，输入框 {box.count()}")
        chk("CR-4", "★★ 全程**没有弹过浏览器对话框**（这就是改成就地输入的意义）",
            len(dialogs) == 0, f"对话框：{dialogs}")
        if box.count() >= 1:
            chk("CR-5", "★ 节点的输入框是**有框**的那种（data-note=0）",
                box.first.get_attribute("data-note") == "0", f"data-note={box.first.get_attribute('data-note')}")
            box.first.fill("甲节点")
            page.keyboard.press("Enter")
            page.wait_for_timeout(4000)
            texts = [o.get("text") for o in ents()]
            chk("CR-6", "★★ 打完字回车，**文档里那个节点真的叫甲节点了**", "甲节点" in texts,
                json.dumps(texts, ensure_ascii=False))

        # ── ③ 新建说明文字：无边框 + 光标 + 不产生连线 ─────────────────
        n2 = len(ents())
        right_blank("tr")
        page.get_by_role("button", name="在这里新建说明文字").first.click()
        page.wait_for_timeout(4000)
        n3 = len(ents())
        note = next((o for o in ents() if o.get("borderStyle") == "none"), None)
        chk("CR-7", "★★ 「新建说明文字」建出来了，且 borderStyle = none",
            n3 == n2 + 1 and note is not None, f"对象 {n2}->{n3} note={json.dumps(note, ensure_ascii=False)[:150] if note else None}")
        nb = edit_box()
        chk("CR-8", "★★ 说明文字的输入框是**没有框**的那种（看上去就是光标，data-note=1）",
            nb.count() >= 1 and nb.first.get_attribute("data-note") == "1",
            f"输入框 {nb.count()}，data-note={nb.first.get_attribute('data-note') if nb.count() else '-'}")
        if nb.count() >= 1:
            nb.first.fill("这是一条说明")
            page.keyboard.press("Enter")
            page.wait_for_timeout(4000)
        note2 = next((o for o in ents() if o.get("borderStyle") == "none"), None)
        chk("CR-9", "★★ 说明文字打进去了", note2 is not None and note2.get("text") == "这是一条说明",
            f"text={note2.get('text') if note2 else None!r}")

        # 说明文字不给连接把手
        if note2 is not None:
            uid8 = str(note2["uuid"])[:8]
            wraps = page.locator("svg .dshw-pg-nodewrap")
            handles = -1
            for i in range(wraps.count()):
                t = wraps.nth(i).locator("title").first.text_content() or ""
                if uid8 in t:
                    handles = wraps.nth(i).locator('.dshw-pg-handle[data-kind="connect"]').count()
                    break
            chk("CR-10", "★★ 说明文字**没有连接把手**（不产生连线，只作标注）", handles == 0,
                f"把手 {handles} 个")

        # ── ④ 空白双击 = 新建说明文字 ───────────────────────────────────
        n4 = len(ents())
        page.mouse.dblclick(canv["x"] + canv["width"] / 2, canv["y"] + canv["height"] - 60)
        page.wait_for_timeout(4000)
        n5 = len(ents())
        chk("CR-11", "★★ 空白处双击**建出了一条新的说明文字**（并且已在输入态）",
            n5 == n4 + 1 and edit_box().count() >= 1,
            f"对象 {n4}->{n5}，输入框 {edit_box().count()}")
        if edit_box().count() >= 1:
            edit_box().first.fill("双击写出来的说明")
            page.keyboard.press("Enter")
            page.wait_for_timeout(4000)
        allnotes = [o.get("text") for o in ents() if o.get("borderStyle") == "none"]
        chk("CR-12", "★★ 双击写出来的那条也在", "双击写出来的说明" in allnotes, json.dumps(allnotes, ensure_ascii=False))

        chk("CR-13", "★★ 整场**零浏览器对话框**", len(dialogs) == 0, f"对话框：{dialogs}")

        # ── ⑤ 框体里的字默认居中（用户 2026-10-09 裁定）─────────────────
        # 逐个框比"字的中心"和"框的中心"：不是看标签上写没写 text-anchor —— 写了也可能被别处盖掉。
        checked = 0
        centered = 0
        wraps3 = page.locator("svg .dshw-pg-nodewrap")
        for i in range(wraps3.count()):
            rr = wraps3.nth(i).locator("rect").first
            ll = wraps3.nth(i).locator("text.dshw-pg-label").first
            if rr.count() == 0 or ll.count() == 0:
                continue
            rb2 = rr.bounding_box()
            lb2 = ll.bounding_box()
            if rb2 is None or lb2 is None:
                continue
            checked += 1
            if abs((lb2["x"] + lb2["width"] / 2) - (rb2["x"] + rb2["width"] / 2)) <= 3:
                centered += 1
        chk("CR-15", "★★ 框体里的文字**水平居中**（逐个框量：字的中心对框的中心）",
            checked > 0 and centered == checked, f"{centered}/{checked} 个居中")

        g = api("/workdesktop/api/pg/graph?project=" + urllib.parse.quote(PROJECT))
        chk("CR-14", "★★ 做完这些，上游照样能打开", g.get("ok") is True, f"ok={g.get('ok')}")
        page.screenshot(path=os.path.join(SHOT, "ui-24-create.png"))
        b.close()
finally:
    removed = api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
    print(f"\n清理：{'临时工程已删除' if removed.get('ok') else str(removed)[:130]}")

print(f"\nPASS={passed} FAIL={failed}")
sys.exit(0 if failed == 0 else 1)
