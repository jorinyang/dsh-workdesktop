"""工程图 · **双击连线直接改文字**（实机核验）

要点：连线没有框，所以双击它之后输入框要摆在**它的中点**（与连线标签同一处），
改完落到文档里的必须是那条连线的 text —— 并且文件仍然合法（上游还能打开）。
"""
import json
import os
import sys
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:3080"
PROJECT = "连线改字自测临时工程"
SHOT = os.path.join(os.path.expanduser("~"), "Desktop", "DSH")
passed = 0
failed = 0
NEW_TEXT = "改过的连线文字"


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


def edge_text():
    e = next((o for o in doc() if o.get("type") == "LineEdge"), None)
    return None if e is None else e.get("text")


api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
api("/workdesktop/api/pg/project", {"action": "create", "name": PROJECT})

try:
    api("/workdesktop/api/pg/insert", {"project": PROJECT, "nodes": [
        {"text": "甲", "x": 0, "y": 0}, {"text": "乙", "x": 380, "y": 0}]})
    objs = doc()
    pick = lambda t: next(o["uuid"] for o in objs if o.get("text") == t)  # noqa: E731
    api("/workdesktop/api/pg/connect", {"project": PROJECT, "source": pick("甲"), "target": pick("乙")})
    chk("ET-1", "底图：一条 甲→乙 的线", edge_text() is not None or edge_text() == "", f"text={edge_text()!r}")

    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True)
        page = b.new_page(viewport={"width": 1600, "height": 1000})
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

        def rect_of_uuid(u):
            groups = page.locator("svg .dshw-pg-nodewrap")
            for i in range(groups.count()):
                t = groups.nth(i).locator("title").first.text_content() or ""
                if u in t:
                    return groups.nth(i).locator("rect").first.bounding_box()
            return None

        fresh = doc()
        ra = rect_of_uuid(str(next(o["uuid"] for o in fresh if o.get("text") == "甲"))[:8])
        rb = rect_of_uuid(str(next(o["uuid"] for o in fresh if o.get("text") == "乙"))[:8])
        chk("ET-2", "拿到两个节点的屏幕位置", ra is not None and rb is not None, "")
        mx = (ra["x"] + ra["width"] / 2 + rb["x"] + rb["width"] / 2) / 2
        my = (ra["y"] + ra["height"] / 2 + rb["y"] + rb["height"] / 2) / 2

        # 双击连线中点
        page.mouse.dblclick(mx, my)
        page.wait_for_timeout(1200)
        box = page.locator("foreignObject input")
        chk("ET-3", "★ 双击连线之后**出现输入框**（连线也能改字）", box.count() >= 1, f"输入框 {box.count()} 个")
        if box.count() >= 1:
            bb = box.first.bounding_box()
            chk("ET-4", "★ 输入框摆在**连线中点**附近（不是某个节点上）",
                bb is not None and abs((bb["x"] + bb["width"] / 2) - mx) < 90 and abs((bb["y"] + bb["height"] / 2) - my) < 60,
                f"输入框中心 ({(bb['x']+bb['width']/2):.0f},{(bb['y']+bb['height']/2):.0f}) vs 连线中点 ({mx:.0f},{my:.0f})")
            box.first.fill(NEW_TEXT)
            page.keyboard.press("Enter")
            page.wait_for_timeout(4000)
            got = edge_text()
            chk("ET-5", "★★ 改完之后**文档里那条连线的 text 真的变了**", got == NEW_TEXT, f"text={got!r}")

        g = api("/workdesktop/api/pg/graph?project=" + urllib.parse.quote(PROJECT))
        chk("ET-6", "★★ 改完上游照样能打开", g.get("ok") is True, f"ok={g.get('ok')}")
        u = api("/workdesktop/api/pg/undo", {"project": PROJECT})
        chk("ET-7", "★ 改连线文字也能撤销", u.get("ok") is True, f"撤销后 text={edge_text()!r}")
        page.screenshot(path=os.path.join(SHOT, "ui-23-edgetext.png"))
        b.close()
finally:
    removed = api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
    print(f"\n清理：{'临时工程已删除' if removed.get('ok') else str(removed)[:130]}")

print(f"\nPASS={passed} FAIL={failed}")
sys.exit(0 if failed == 0 else 1)
