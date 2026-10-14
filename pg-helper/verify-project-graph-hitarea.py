# -*- coding: utf-8 -*-
"""工程图 · **触发区域**（实机核验）—— 用户 2026-10-10 的两条：

  ① 「组合的边框太细，需要移动组合的时候触发移动的区域过小，需要适当调整增大。」
  ② 「连接线的线条需要添加说明的时候的触发区域也过小，触发区域需要适当调整增大。」

判据不是"看着大了"，而是**在原来抓不到的地方按下/双击，现在真的生效**：
  · 组合：在**框外**贴着边（框内全是成员、按不到框的那一段）按下去，必须抓到组合；
  · 连线：在离线一段距离处双击，必须弹出那条线的文字输入框；再远就必须**不**弹（不能糊一片）。

⚠️ 两条都必须配负向对照 —— 只有"能触发"的断言，把容差写成无穷大也会绿。
"""
import json
import os
import sys
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

from _suite_util import purge_project_backups

BASE = "http://127.0.0.1:3080"
PROJECT = "触发区域自测临时工程"
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
        print(f"         {str(detail)[:260]}")


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
    # 一条水平连线：甲(x=0) → 乙(x=600)，中间空着好量距离。
    # 一个组合：成员摆得**很满**（左右只留 24 的边距），这样"框内能被成员挡住的区域"最大，
    #          想抓框就只能抓边框那一条 —— 正是用户抱怨的场景。
    api("/workdesktop/api/pg/insert", {"project": PROJECT, "nodes": [
        {"text": "甲", "x": 0, "y": 0}, {"text": "乙", "x": 600, "y": 0},
        {"text": "丙", "x": 0, "y": 500}, {"text": "丁", "x": 300, "y": 500}]})
    objs = api("/workdesktop/api/pg/document?project=" + urllib.parse.quote(PROJECT))["objects"]
    uu = {o["text"]: o["uuid"] for o in objs if o.get("text") in ("甲", "乙", "丙", "丁")}
    api("/workdesktop/api/pg/connect", {"project": PROJECT, "source": uu["甲"], "target": uu["乙"]})
    # 组合用**空标题**：标题条高 0，成员几乎顶满整个框 ⇒ 框内完全没有"空地"可抓
    grp = api("/workdesktop/api/pg/section", {"project": PROJECT, "create": {"text": "G", "children": [uu["丙"], uu["丁"]]}})
    chk("HIT-1", "底图：甲→乙 一条连线 + 一个成员摆满的组合", grp.get("ok") is True, f"组合框 {grp.get('box')}")

    with sync_playwright() as p:
        pw = p.chromium.launch(channel="chrome", headless=True)
        page = pw.new_page(viewport={"width": 1600, "height": 1000})
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)[:300]))
        page.goto(f"{BASE}/?token={read_token()}", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(9000)
        page.click('button[data-dshw-panel="dsh-workdesktop:project-graph"]')
        page.wait_for_timeout(4000)
        page.select_option(".dshw-pg-bar select", PROJECT)
        page.wait_for_timeout(5000)

        def rect_of(pred):
            wraps = page.locator("svg .dshw-pg-nodewrap")
            for i in range(wraps.count()):
                ts = wraps.nth(i).locator("title")
                txt = " | ".join((ts.nth(k).text_content() or "") for k in range(ts.count()))
                if pred(txt):
                    return wraps.nth(i).locator("rect").first.bounding_box()
            return None

        def line_box():
            lb = page.locator("svg line.dshw-pg-edge").first.bounding_box()
            return lb

        def editor_open():
            """连线/节点的就地输入框在不在（foreignObject 里的 input）。"""
            return page.locator("svg foreignObject input.dshw-pg-edit").count() > 0

        def close_editor():
            """收掉就地输入框，并**确认真的收掉了**。

            ⚠️ 不能只按一下 Escape 就走（2026-10-10 实测踩到）：上一步的框没收干净，
            下一步"离线 90px 不该弹"就会读到**上一个还没关的框** ⇒ 假红。
            这里返回"关干净了没有"，调用方据此判断前置条件。
            """
            for _ in range(3):
                if not editor_open():
                    return True
                page.keyboard.press("Escape")
                page.wait_for_timeout(500)
            if editor_open():
                # 再试一次：点画布的角落（顶栏外面、控件之间，尽量挑个空地方）
                page.mouse.click(40, 760)
                page.wait_for_timeout(600)
            return not editor_open()

        # ══ ① 组合：框外贴着边按下，必须抓到组合 ══
        print("\n── ① 组合边框的可抓区域 ──")
        g = rect_of(lambda t: "Section" in t and "· G ·" in t)
        chk("HIT-2", "找到组合框", g is not None, json.dumps(None if g is None else {k: round(v) for k, v in g.items()}))
        if g is None:
            pw.close(); sys.exit(1)
        # 组合的左边中点：往**左**偏 5px（框外，原来一定点不到框；框内那侧被成员挡着）
        px = g["x"] - 5
        py = g["y"] + g["height"] / 2
        page.mouse.move(px, py)
        page.mouse.down()
        page.mouse.move(px - 70, py)       # 往左拖 70
        page.wait_for_timeout(250)
        page.mouse.up()
        page.wait_for_timeout(4000)
        g2 = rect_of(lambda t: "Section" in t and "· G ·" in t)
        moved = g2 is not None and abs(g2["x"] - g["x"]) > 30
        chk("HIT-3", "★★ 在**框外 5px**处按下拖动 ⇒ 抓到的是组合（框跟着走）", moved,
            f"组合 x {round(g['x'])} → {None if g2 is None else round(g2['x'])}")
        if moved:
            page.mouse.move(g2["x"] - 5, g2["y"] + g2["height"] / 2)
            page.mouse.down(); page.mouse.move(g2["x"] + 65, g2["y"] + g2["height"] / 2)
            page.wait_for_timeout(250); page.mouse.up(); page.wait_for_timeout(3500)

        # ══ ② 连线：离线一段距离双击，必须弹出文字输入框 ══
        print("\n── ② 连线加说明的触发区域 ──")
        lb = line_box()
        chk("HIT-4", "找到那条连线", lb is not None,
            json.dumps(None if lb is None else {k: round(v) for k, v in lb.items()}))
        if lb is None:
            pw.close(); sys.exit(1)
        # 线是水平的：中点的正上方 N 像素处双击。取 10px —— 原来那 8px 判定够不到。
        cx = lb["x"] + lb["width"] / 2
        cy = lb["y"] + lb["height"] / 2

        page.mouse.dblclick(cx, cy - 10)
        page.wait_for_timeout(1500)
        near_ok = editor_open()
        chk("HIT-5", "★★ 在**离线 10px**处双击 ⇒ 弹出这条线的文字输入框（用户报的触发区域过小）",
            near_ok, f"双击点 ({round(cx)}, {round(cy - 10)})，输入框出现={near_ok}")
        if near_ok:
            page.keyboard.type("说明")
            page.keyboard.press("Enter")
            page.wait_for_timeout(2500)
        chk("HIT-5b", "上一步的输入框能收干净（负向对照的前置条件）", close_editor())

        # 负向对照：离得足够远就不该弹**连线**的框（容差不能糊一片）
        page.mouse.dblclick(cx, cy - 90)
        page.wait_for_timeout(1500)
        far_note = page.locator("svg foreignObject input.dshw-pg-edit[data-note='1']").count() > 0
        far_edge = editor_open() and not far_note
        chk("HIT-6", "★ 负向对照：在**离线 90px**处双击，弹的是**空白说明**、不是连线的文字框",
            far_note and not far_edge,
            f"离线 90px：说明框={far_note} 连线框={far_edge}（容差没被放成一片）")
        close_editor()

        # ══ ③ 反向：不能因为放宽而抢走"双击节点改文字" ══
        print("\n── ③ 实体优先（放宽不能反过来抢节点的双击）──")
        jia = rect_of(lambda t: "· 甲 ·" in t)
        page.mouse.dblclick(jia["x"] + jia["width"] / 2, jia["y"] + jia["height"] / 2)
        page.wait_for_timeout(1200)
        got = page.locator("svg foreignObject input.dshw-pg-edit").count() > 0
        note = page.locator("svg foreignObject input.dshw-pg-edit[data-note='1']").count() > 0
        chk("HIT-8", "★ 双击节点仍然是改**节点**的文字（没被连线抢走）", got and not note,
            f"输入框={got} 说明框={note}")
        page.keyboard.press("Escape")
        page.wait_for_timeout(500)

        chk("HIT-9", "整个过程没有页面报错", len(errs) == 0, " | ".join(errs)[:300])
        page.screenshot(path=os.path.join(SHOT, "ui-34-hitarea.png"))
        pw.close()
finally:
    removed = api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
    purged = purge_project_backups(PROJECT)
    print(f"\n清理：{'临时工程已删除' if removed.get('ok') else str(removed)[:130]}（另收 {purged} 个备份目录）")

print(f"\nPASS={passed} FAIL={failed}")
sys.exit(0 if failed == 0 else 1)
