"""工程图 · **右键按在哪决定干什么** + **Ctrl+D 右侧隔一个框体复制**

用户 2026-10-09 裁定的两条：
  ① 右键按在**空白**处拖 → 一条直线剪掉经过的元素（原来就是这个，这里守回归）
  ② 右键按在**框体**上拖 → 连线；松在另一个框体上＝连起来，松在空白处＝**在那儿新建一个框体**
  ③ Ctrl+D → 选中的框体在**右侧隔一个框体**的位置复制一份一样的内容

位置都用文档里的坐标算，不靠"看着差不多"。
"""
import json
import os
import sys
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:3080"
PROJECT = "右键与复制自测临时工程"
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


def edges():
    return [o for o in doc() if o.get("type") == "LineEdge"]


api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
api("/workdesktop/api/pg/project", {"action": "create", "name": PROJECT})

try:
    api("/workdesktop/api/pg/insert", {"project": PROJECT, "nodes": [
        {"text": "甲", "x": -300, "y": 0}, {"text": "乙", "x": 0, "y": 0}]})
    chk("RB-0", "底图：两个节点", len(ents()) == 3, f"实体 {len(ents())}")

    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True)
        page = b.new_page(viewport={"width": 1600, "height": 1000})
        page.on("dialog", lambda d: d.dismiss())
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

        canv = page.locator(".dshw-pg-canvas").bounding_box()
        page.mouse.click(canv["x"] + canv["width"] - 90, canv["y"] + canv["height"] - 90, button="right")
        page.wait_for_timeout(700)
        fit = page.get_by_role("button", name="适应窗口")
        if fit.count() > 0:
            fit.first.click()
            page.wait_for_timeout(2500)
        canv = page.locator(".dshw-pg-canvas").bounding_box()

        def rect_of(text):
            wraps = page.locator("svg .dshw-pg-nodewrap")
            for i in range(wraps.count()):
                t = wraps.nth(i).locator("title").first.text_content() or ""
                if "· " + text + " ·" in t or t.endswith(text):
                    return wraps.nth(i).locator("rect").first.bounding_box()
            return None

        ra = rect_of("甲")
        rb = rect_of("乙")
        chk("RB-1", "两个节点都在画布上", ra is not None and rb is not None, f"甲={ra is not None} 乙={rb is not None}")

        def center(r):
            return r["x"] + r["width"] / 2, r["y"] + r["height"] / 2

        # ── ① 右键从框体拖到另一个框体 → 连线 ───────────────────────────
        n_edges0 = len(edges())
        ax, ay = center(ra)
        bx, by = center(rb)
        page.mouse.move(ax, ay)
        page.mouse.down(button="right")
        for k in range(1, 13):
            page.mouse.move(ax + (bx - ax) * k / 12, ay + (by - ay) * k / 12)
            page.wait_for_timeout(35)
        page.mouse.up(button="right")
        page.wait_for_timeout(4500)
        n_edges1 = len(edges())
        chk("RB-2", "★★ 右键**从框体拖到另一个框体** → 连起来了（连线 0 → 1）",
            n_edges1 == n_edges0 + 1, f"连线 {n_edges0} -> {n_edges1}")

        # ── ② 右键从框体拖到空白 → 在那儿新建一个框体 ──────────────────
        n_ents0 = len(ents())
        n_ed0 = len(edges())
        blank_x = canv["x"] + canv["width"] / 2
        blank_y = canv["y"] + canv["height"] - 60
        bx2, by2 = center(rb)
        page.mouse.move(bx2, by2)
        page.mouse.down(button="right")
        steps = 14
        for k in range(1, steps + 1):
            page.mouse.move(bx2 + (blank_x - bx2) * k / steps, by2 + (blank_y - by2) * k / steps)
            page.wait_for_timeout(35)
        page.mouse.up(button="right")
        page.wait_for_timeout(4500)
        n_ents1 = len(ents())
        n_ed1 = len(edges())
        chk("RB-3", "★★ 右键**从框体拖到空白** → 在那里**新建了一个框体**",
            n_ents1 == n_ents0 + 1, f"实体 {n_ents0} -> {n_ents1}")
        chk("RB-3b", "★★ 而且**起点连到了那个新框体上**（用户 2026-10-09 修正）",
            n_ed1 == n_ed0 + 1, f"连线 {n_ed0} -> {n_ed1}")

        # ── ③ 右键按在空白拖 → 还是剪断（回归）──────────────────────────
        # ⚠️ 两个坑，第一版都踩了：
        #   · 按在**说明文字自己身上**再拖，按新规则那是"连线模式"（框体是起点），根本不是剪断；
        #   · 从它左边往左划，划两下就出画布了。
        #   所以：先用接口把目标建在**远离其它对象**的地方，再从它**上方空白处**往下划穿过它。
        api("/workdesktop/api/pg/insert", {"project": PROJECT, "nodes": [{"text": "会被剪掉", "x": 900, "y": 0}]})
        # 面板靠轮询事件来刷新，等久一点；再切一次工程强制拉一次，双保险
        page.wait_for_timeout(8000)
        page.select_option(".dshw-pg-bar select", PROJECT)
        page.wait_for_timeout(3000)
        page.mouse.click(canv["x"] + canv["width"] - 90, canv["y"] + canv["height"] - 90, button="right")
        page.wait_for_timeout(700)
        fit2 = page.get_by_role("button", name="适应窗口")
        if fit2.count() > 0:
            fit2.first.click()
            page.wait_for_timeout(2500)
        canv = page.locator(".dshw-pg-canvas").bounding_box()

        n_ents3 = len(ents())
        note = next((o for o in ents() if o.get("text") == "会被剪掉"), None)
        nr = None
        if note is not None:
            wraps = page.locator("svg .dshw-pg-nodewrap")
            for i in range(wraps.count()):
                t = wraps.nth(i).locator("title").first.text_content() or ""
                if str(note["uuid"])[:8] in t:
                    nr = wraps.nth(i).locator("rect").first.bounding_box()
                    break
        chk("RB-4", "目标说明文字在画布上、上下都留得出空白", note is not None and nr is not None, f"{nr}")
        if nr is not None:
            nx = nr["x"] + nr["width"] / 2
            y_from = nr["y"] - nr["height"] * 0.6      # 它上方：空白
            y_to = nr["y"] + nr["height"] * 1.6        # 它下方：穿过去了
            page.mouse.move(nx, y_from)
            page.mouse.down(button="right")
            steps2 = 14
            for k in range(1, steps2 + 1):
                page.mouse.move(nx, y_from + (y_to - y_from) * k / steps2)
                page.wait_for_timeout(35)
            page.mouse.up(button="right")
            page.wait_for_timeout(4500)
            chk("RB-5", "★★ 右键按在**空白处**划过去 → 目标被剪掉（回归）",
                len(ents()) == n_ents3 - 1, f"实体 {n_ents3} -> {len(ents())}")

        # ── ④ Ctrl+D：右侧隔一个框体复制一份 ────────────────────────────
        fresh = doc()
        jia = next((o for o in fresh if o.get("text") == "甲"), None)
        if jia is not None:
            wraps = page.locator("svg .dshw-pg-nodewrap")
            jr = None
            for i in range(wraps.count()):
                t = wraps.nth(i).locator("title").first.text_content() or ""
                if str(jia["uuid"])[:8] in t:
                    jr = wraps.nth(i).locator("rect").first.bounding_box()
                    break
            if jr is not None:
                page.mouse.click(jr["x"] + jr["width"] / 2, jr["y"] + jr["height"] / 2)
                page.wait_for_timeout(700)
                before_jia = len([o for o in ents() if o.get("text") == "甲"])
                page.keyboard.press("Control+d")
                page.wait_for_timeout(4500)
                after = doc()
                copies = [o for o in after if o.get("text") == "甲"]
                chk("RB-6", "★★ Ctrl+D → **多出来一份一样的**（甲 1 → 2）",
                    len(copies) == before_jia + 1, f"甲 {before_jia} -> {len(copies)}")
                if len(copies) >= 2:
                    srt = sorted(copies, key=lambda o: o["location"]["x"])
                    orig, dup = srt[0], srt[-1]
                    # ⚠️ 尺寸的键名可能是 x/y 也可能是 w/h —— 别写死（第一版就栽在这，KeyError）
                    sz = orig.get("size") or {}
                    # 实测键名是 width/height（不是 x/w）—— 三种都认，别写死
                    w = sz.get("width", sz.get("x", sz.get("w")))
                    chk("RB-7", "★ 拿得到原件的宽度（否则下面没法算间距）",
                        isinstance(w, (int, float)) and w > 0, f"size={sz}")
                    if isinstance(w, (int, float)) and w > 0:
                        want = orig["location"]["x"] + w * 2
                        got = dup["location"]["x"]
                        chk("RB-7b", "★★ 复制出来的那份在**右侧、隔一个框体宽**",
                            abs(got - want) <= 2,
                            f"原件 x={orig['location']['x']:.0f} 宽={w:.0f} 期望 x={want:.0f} 实际 x={got:.0f}")
                        dsz = dup.get("size") or {}
                        dw = dsz.get("width", dsz.get("x", dsz.get("w")))
                        chk("RB-8", "★ 内容一模一样（尺寸也一样）",
                            isinstance(dw, (int, float)) and abs(dw - w) <= 1 and dup.get("text") == orig.get("text"),
                            f"尺寸 {dw} vs {w}")

        g = api("/workdesktop/api/pg/graph?project=" + urllib.parse.quote(PROJECT))
        chk("RB-9", "★★ 做完这些上游照样能打开", g.get("ok") is True, f"ok={g.get('ok')}")
        page.screenshot(path=os.path.join(SHOT, "ui-27-rightbutton.png"))
        b.close()
finally:
    removed = api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
    print(f"\n清理：{'临时工程已删除' if removed.get('ok') else str(removed)[:130]}")

print(f"\nPASS={passed} FAIL={failed}")
sys.exit(0 if failed == 0 else 1)
