"""工程图 · **Ctrl+C / Ctrl+X / Ctrl+V**（实机核验，Playwright 驱动真 Chrome）

文档层那套（引用重指、剪切不错位）已经由 verify-project-graph-clipboard.mjs 离线验过 16/0；
这里只证明**按键真的通到了那条链路上**，并且盘上真的变了。
"""
import json
import os
import sys
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:3080"
PROJECT = "剪贴板自测临时工程"
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


def counts(objs=None):
    objs = doc() if objs is None else objs
    ents = [o for o in objs if o.get("type") != "LineEdge"]
    return len(ents), len([o for o in objs if o.get("type") == "LineEdge"])


api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
made = api("/workdesktop/api/pg/project", {"action": "create", "name": PROJECT})
chk("CB-1", "建临时工程", made.get("ok") is True, str(made)[:120])

try:
    ins = api("/workdesktop/api/pg/insert", {"project": PROJECT, "nodes": [
        {"text": "甲", "x": 0, "y": 0}, {"text": "乙", "x": 320, "y": 0}]})
    objs = doc()
    pick = lambda t: next(o["uuid"] for o in objs if o.get("text") == t)  # noqa: E731
    api("/workdesktop/api/pg/connect", {"project": PROJECT, "source": pick("甲"), "target": pick("乙")})
    e0, l0 = counts()
    chk("CB-2", "底图：两个节点 + 一条线（外加模板的根节点）", e0 == 3 and l0 == 1, f"实体 {e0} · 线 {l0}")

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
        row = None
        cands = page.get_by_text("工程图", exact=True)
        for i in range(cands.count()):
            bb = cands.nth(i).bounding_box()
            if bb and bb["x"] < 260 and bb["y"] > 600:
                row = cands.nth(i)
        chk("CB-3", "打开「工程图」面板", row is not None, "")
        if row is None:
            raise SystemExit(1)
        row.click()
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

        def click_node(text, modifiers=None):
            fresh = doc()
            u = next((o["uuid"] for o in fresh if o.get("text") == text), None)
            if u is None:
                return False
            rb = rect_of_uuid(str(u)[:8])
            if rb is None:
                return False
            # ⚠️ page.mouse.click **不吃 modifiers 参数**，加选要自己按住 Shift
            if modifiers:
                for key in modifiers:
                    page.keyboard.down(key)
            page.mouse.click(rb["x"] + rb["width"] / 2, rb["y"] + rb["height"] / 2)
            if modifiers:
                for key in reversed(modifiers):
                    page.keyboard.up(key)
            page.wait_for_timeout(500)
            return True

        page.locator(".dshw-pg-canvas").click(position={"x": 4, "y": 4})
        page.wait_for_timeout(300)
        ok_a = click_node("甲")
        ok_b = click_node("乙", modifiers=["Shift"])
        picked = page.locator('.dshw-pg-node[data-picked="1"]').count()
        chk("CB-4", "选中「甲」和「乙」两个节点", ok_a and ok_b and picked == 2, f"选中 {picked}")

        def msg():
            m = page.locator(".dshw-pg-msg")
            return m.first.inner_text() if m.count() else "(没有消息)"

        # ── Ctrl+C ──────────────────────────────────────────────────────
        page.keyboard.press("Control+c")
        page.wait_for_timeout(2500)
        chk("CB-5", "★ Ctrl+C 之后面板如实报「复制了几个」", "复制了" in msg(), msg()[:160])

        # ── Ctrl+V ──────────────────────────────────────────────────────
        page.keyboard.press("Control+v")
        page.wait_for_timeout(4500)
        e1, l1 = counts()
        chk("CB-6", "★★ Ctrl+V 之后**盘上真的多了**：2 个节点 + 1 条线",
            e1 == e0 + 2 and l1 == l0 + 1, f"实体 {e0}->{e1} · 线 {l0}->{l1}")
        after_paste = page.locator('.dshw-pg-node[data-picked="1"]').count()
        chk("CB-6b", "★ 粘出来的那批**自动被选中**（方便接着拖）", after_paste == 2, f"选中 {after_paste}")
        page.screenshot(path=os.path.join(SHOT, "ui-20-pasted.png"))

        # ── Ctrl+X ──────────────────────────────────────────────────────
        page.keyboard.press("Control+x")
        page.wait_for_timeout(4500)
        e2, l2 = counts()
        chk("CB-7", "★★ Ctrl+X 之后**盘上真的少了**（剪掉刚粘的那两个）",
            e2 == e1 - 2, f"实体 {e1}->{e2}")
        chk("CB-7b", "★ 剪切之后选中被清空（剪掉的东西不在手里了）",
            page.locator('.dshw-pg-node[data-picked="1"]').count() == 0, "")

        # ── 再粘回来 ────────────────────────────────────────────────────
        page.keyboard.press("Control+v")
        page.wait_for_timeout(4500)
        e3, _ = counts()
        chk("CB-8", "★★ 再 Ctrl+V：剪掉的东西**回来了**（剪贴板存在宿主，不是一串 uuid）",
            e3 == e2 + 2, f"实体 {e2}->{e3}")

        # ── 撤销也要管用 ────────────────────────────────────────────────
        u = api("/workdesktop/api/pg/undo", {"project": PROJECT})
        e4, _ = counts()
        chk("CB-9", "★ 粘贴也能撤销（走的是同一套快照）", u.get("ok") is True and e4 == e3 - 2,
            f"实体 {e3}->{e4}")
        page.screenshot(path=os.path.join(SHOT, "ui-21-clipboard.png"))
        b.close()
finally:
    removed = api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
    print(f"\n清理：{'临时工程已删除' if removed.get('ok') else str(removed)[:130]}")

print(f"\nPASS={passed} FAIL={failed}")
sys.exit(0 if failed == 0 else 1)
