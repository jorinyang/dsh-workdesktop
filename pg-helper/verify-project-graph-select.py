"""工程图 · **选中要看得见** + **Ctrl 逐个点选（点一下选中、再点一下取消）**

用户 2026-10-09 报的两条。

判"看得见"用**差分**：同一个框，选中时的描边 vs 没选中时的描边，必须不一样。
不写死颜色 —— 写死的话，主题一变或变量名一改，断言就变成在测字符串了。
"""
import json
import os
import sys
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:3080"
PROJECT = "选中标识自测临时工程"
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


api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
api("/workdesktop/api/pg/project", {"action": "create", "name": PROJECT})

try:
    api("/workdesktop/api/pg/insert", {"project": PROJECT, "nodes": [
        {"text": "甲", "x": -300, "y": -120}, {"text": "乙", "x": 0, "y": -120}, {"text": "丙", "x": 300, "y": -120}]})
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True)
        page = b.new_page(viewport={"width": 1600, "height": 1000})
        page.goto(f"{BASE}/?token={read_token()}", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(9000)
        for label in ["继续", "知道了", "关闭"]:
            try:
                btn = page.get_by_role("button", name=label)
                if btn.count() > 0:
                    btn.first.click(timeout=3000); page.wait_for_timeout(1000); break
            except Exception:
                pass
        for i in range(page.get_by_text("工程图", exact=True).count()):
            bb = page.get_by_text("工程图", exact=True).nth(i).bounding_box()
            if bb and bb["x"] < 260 and bb["y"] > 600:
                page.get_by_text("工程图", exact=True).nth(i).click(); break
        page.wait_for_timeout(3500)
        page.select_option(".dshw-pg-bar select", PROJECT)
        page.wait_for_timeout(4500)

        canv = page.locator(".dshw-pg-canvas").bounding_box()
        # 适应窗口，保证三个节点都在视野里
        page.mouse.click(canv["x"] + canv["width"] - 90, canv["y"] + canv["height"] - 90, button="right")
        page.wait_for_timeout(700)
        fit = page.get_by_role("button", name="适应窗口")
        if fit.count() > 0:
            fit.first.click(); page.wait_for_timeout(2500)
        canv = page.locator(".dshw-pg-canvas").bounding_box()

        def rects():
            out = []
            wraps = page.locator("svg .dshw-pg-nodewrap")
            for i in range(wraps.count()):
                rb = wraps.nth(i).locator("rect").first.bounding_box()
                ti = wraps.nth(i).locator("title").first.text_content() or ""
                if rb:
                    out.append((ti, rb))
            return out

        boxes = rects()
        chk("SEL-1", "三个节点都在画布视野里", len(boxes) >= 3, f"框 {len(boxes)} 个")

        # 先把"没选中时的描边"记下来（差分用）
        idle_stroke = page.locator("svg .dshw-pg-node").first.evaluate("el => getComputedStyle(el).stroke")
        print(f"         [基准] 没选中时的描边 = {idle_stroke}")

        # ① 单选：看得见吗
        ti0, rb0 = boxes[0]
        page.mouse.click(rb0["x"] + rb0["width"] / 2, rb0["y"] + rb0["height"] / 2)
        page.wait_for_timeout(700)
        picked = page.locator('.dshw-pg-node[data-picked="1"]').count()
        hot = page.locator('.dshw-pg-node[data-picked="1"]').first
        hot_stroke = hot.evaluate("el => getComputedStyle(el).stroke") if picked >= 1 else None
        chk("SEL-2", "★ 点一下选中一个", picked == 1, f"选中 {picked}")
        chk("SEL-3", "★★ 被选中的框体**描边跟没选中时不一样**（看得见，不是被边框规则盖掉）",
            hot_stroke is not None and hot_stroke != idle_stroke,
            f"选中 {hot_stroke} vs 未选中 {idle_stroke}")

        # ② Ctrl 逐个点选
        ti1, rb1 = boxes[1]
        page.keyboard.down("Control")
        page.mouse.click(rb1["x"] + rb1["width"] / 2, rb1["y"] + rb1["height"] / 2)
        page.keyboard.up("Control")
        page.wait_for_timeout(700)
        two = page.locator('.dshw-pg-node[data-picked="1"]').count()
        chk("SEL-4", "★★ 按住 Ctrl 点第二个 —— **多选**（1 -> 2）", two == 2, f"选中 {two}")

        # ③ 再 Ctrl 点第一个 —— 取消它
        page.keyboard.down("Control")
        page.mouse.click(rb0["x"] + rb0["width"] / 2, rb0["y"] + rb0["height"] / 2)
        page.keyboard.up("Control")
        page.wait_for_timeout(700)
        one = page.locator('.dshw-pg-node[data-picked="1"]').count()
        chk("SEL-5", "★★ 再 Ctrl 点一次同一个 —— **取消选中**（2 -> 1）", one == 1, f"选中 {one}")

        # ④ 框选：拖动过程中就要亮
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)
        page.mouse.move(canv["x"] + 8, canv["y"] + 8)
        page.mouse.down()
        page.mouse.move(canv["x"] + canv["width"] - 8, canv["y"] + canv["height"] - 8, steps=16)
        page.wait_for_timeout(400)
        live = page.locator('.dshw-pg-node[data-picked="1"]').count()
        live_stroke = None
        if live >= 1:
            live_stroke = page.locator('.dshw-pg-node[data-picked="1"]').first.evaluate("el => getComputedStyle(el).stroke")
        chk("SEL-6", "★★ 框选**拖动过程中**框里的就已经亮起来了", live >= 1, f"拖动中已亮 {live} 个")
        chk("SEL-7", "★★ 拖动中亮起来的那些**描边也确实是选中色**（看得见）",
            live_stroke is not None and live_stroke != idle_stroke,
            f"拖动中 {live_stroke} vs 未选中 {idle_stroke}")
        page.mouse.up()
        page.wait_for_timeout(800)
        after = page.locator('.dshw-pg-node[data-picked="1"]').count()
        chk("SEL-8", "★★ 松手之后**选中数与拖动中看到的一致**（看到的＝选到的）",
            after == live and after >= 1, f"拖动中 {live} -> 松手后 {after}")

        page.screenshot(path=os.path.join(SHOT, "ui-26-select.png"))
        b.close()
finally:
    removed = api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
    print(f"\n清理：{'临时工程已删除' if removed.get('ok') else str(removed)[:130]}")

print(f"\nPASS={passed} FAIL={failed}")
sys.exit(0 if failed == 0 else 1)
