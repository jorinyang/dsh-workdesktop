"""工程图面板 · 画布交互实机验收（Playwright 驱动真浏览器）

考的不是"代码里有这段"，而是"真点、真拖、真右键，界面真有反应、盘上真改了"。

流程：
  ① HTTP 建一个临时工程 + 三个节点（画布要有东西可点）
  ② 打开 GUI → 点左侧栏「工程图」→ 下拉选到那个工程
  ③ 依次验：点选 / 拖动移动（并回查坐标）/ 框选 / 右键菜单 / 双击改名
  ④ HTTP 删掉临时工程
"""
import json
import os
import re
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:3080"


def read_token():
    """每次跑都现读 —— 宿主每重启一次就换一个 token，写死会得到 401
    （实测踩到：界面上只显示 'dsh web authentication required'）。"""
    with open(os.path.join(os.path.expanduser("~"), ".dsh\\daemon\\dsh.log"), encoding="utf-8", errors="ignore") as fh:
        hits = [ln for ln in fh if "dsh web: http" in ln]
    if not hits:
        raise SystemExit("dsh.log 里找不到 dsh web 的启动 URL（宿主起来了吗？）")
    return hits[-1].split("token=")[1].strip()


TOKEN = read_token()
PROJECT = "交互自测临时工程"
SHOT = os.path.join(os.path.expanduser("~"), "Desktop\\DSH")

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
    url = BASE + path
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="GET" if body is None else "POST")
    if body is not None:
        req.add_header("content-type", "application/json")
    with urllib.request.urlopen(req, timeout=180) as resp:
        return json.loads(resp.read().decode("utf-8"))


def doc_objects():
    return api(f"/workdesktop/api/pg/document?project={urllib.parse.quote(PROJECT)}").get("objects", [])


import urllib.parse  # noqa: E402

print(f"base    : {BASE}")
print(f"project : {PROJECT}\n")

# ── ① 造一张图 ──────────────────────────────────────────────────────────
api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
made = api("/workdesktop/api/pg/project", {"action": "create", "name": PROJECT})
chk("UI-1", "建临时工程", made.get("ok") is True, str(made)[:160])
ins = api("/workdesktop/api/pg/insert", {"project": PROJECT, "nodes": [
    {"text": "甲", "x": 0, "y": 0},
    {"text": "乙", "x": 320, "y": 0},
    {"text": "丙", "x": 160, "y": 220},
]})
chk("UI-2", "造三个节点", ins.get("ok") is True and len(ins.get("created", [])) == 3, str(ins)[:160])
# ⚠️ 空工程模板**自带一个「根节点」** —— 所以实体数是 4 不是 3（写死 3 会假红，实测踩到）。
#    这里从文档里数出来，别写死。
EXPECT_NODES = len([o for o in doc_objects() if o.get("type") != "LineEdge"])
print(f"（文档里有 {EXPECT_NODES} 个实体：模板的根节点 + 我造的 3 个）\n")

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        page = browser.new_page(viewport={"width": 1600, "height": 1000})
        page.goto(f"{BASE}/?token={TOKEN}", wait_until="domcontentloaded", timeout=60000)
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

        # ── ② 打开工程图面板 ────────────────────────────────────────────
        row = None
        cands = page.get_by_text("工程图", exact=True)
        for i in range(cands.count()):
            box = cands.nth(i).bounding_box()
            if box and box["x"] < 260 and box["y"] > 600:
                row = cands.nth(i)
        chk("UI-3", "左侧栏找到「工程图」那一行（在左栏、靠底部）", row is not None,
            f"候选 {cands.count()} 个")
        if row is None:
            page.screenshot(path=SHOT + r"\ui-fail.png")
            raise SystemExit(1)
        row.click()
        page.wait_for_timeout(3500)

        canvas = page.locator(".dshw-pg-canvas")
        chk("UI-4", "★ 画布出现了（面板真的渲染出来了）", canvas.count() == 1,
            f"canvas={canvas.count()}")
        if canvas.count() != 1:
            page.screenshot(path=SHOT + r"\ui-fail.png")
            raise SystemExit(1)

        # 选到测试工程
        page.select_option(".dshw-pg-bar select", PROJECT)
        page.wait_for_timeout(3500)
        rects = page.locator(".dshw-pg-node")
        chk("UI-5", "★ 实体全部画出来了（模板根节点 + 造的 3 个）", rects.count() == EXPECT_NODES, f"rect 数={rects.count()} 期望={EXPECT_NODES}")
        page.screenshot(path=SHOT + r"\ui-1-initial.png")

        def picked_count():
            return page.locator('.dshw-pg-node[data-picked="1"]').count()

        # ── ③a 点选 ─────────────────────────────────────────────────────
        rects.nth(0).click()
        page.wait_for_timeout(600)
        chk("UI-6", "★ 点一个节点 ⇒ 它被选中（且只有一个）", picked_count() == 1, f"选中 {picked_count()}")

        # Shift 加选
        rects.nth(1).click(modifiers=["Shift"])
        page.wait_for_timeout(600)
        chk("UI-6b", "★ Shift 点第二个 ⇒ 两个都选中（多选）", picked_count() == 2, f"选中 {picked_count()}")
        page.screenshot(path=SHOT + r"\ui-2-multiselect.png")

        # ── ③b 拖动移动 ─────────────────────────────────────────────────
        before = {o["text"]: o["location"] for o in doc_objects() if o.get("text")}
        box0 = rects.nth(0).bounding_box()
        page.mouse.move(box0["x"] + box0["width"] / 2, box0["y"] + box0["height"] / 2)
        page.mouse.down()
        for step in range(12):
            page.mouse.move(box0["x"] + box0["width"] / 2 + (step + 1) * 12,
                            box0["y"] + box0["height"] / 2 + (step + 1) * 6)
            page.wait_for_timeout(25)
        page.mouse.up()
        page.wait_for_timeout(4000)
        after = {o["text"]: o["location"] for o in doc_objects() if o.get("text")}
        moved_a = before.get("甲") and after.get("甲")
        dx = (after["甲"]["x"] - before["甲"]["x"]) if moved_a else 0
        dy = (after["甲"]["y"] - before["甲"]["y"]) if moved_a else 0
        chk("UI-7", "★★ 拖动之后**盘上的坐标真的变了**（不是只有画面动）",
            abs(dx) > 30 and abs(dy) > 10,
            f"甲 {before.get('甲')} -> {after.get('甲')}  Δ=({dx:.1f},{dy:.1f})")
        chk("UI-7b", "★ 没被选中的那个**没动**（拖动只作用于选中集合）",
            after.get("丙") == before.get("丙"),
            f"丙 {before.get('丙')} -> {after.get('丙')}")
        page.screenshot(path=SHOT + r"\ui-3-dragged.png")

        # ── ③c 框选 ─────────────────────────────────────────────────────
        page.mouse.click(30, 30)  # 空白清空（画布左上角）
        page.wait_for_timeout(400)
        cb = canvas.bounding_box()
        page.mouse.move(cb["x"] + 12, cb["y"] + 12)
        page.mouse.down()
        page.mouse.move(cb["x"] + cb["width"] - 12, cb["y"] + cb["height"] - 12, steps=14)
        page.wait_for_timeout(300)
        shot_marquee = page.locator(".dshw-pg-marquee").count()
        # ⚠️ 光"框画出来了"不够：还要**框的位置与鼠标一致**。
        #    这里曾经整体偏一个"画布左上角" —— 因为那个 div 是画布内的绝对定位元素（left/top 相对画布），
        #    而拖动记的是 clientX/clientY（视口坐标），没减画布原点。看着偏、判定却是对的，很难察觉。
        box_drawn = page.locator(".dshw-pg-marquee").first.bounding_box() if shot_marquee == 1 else None
        page.mouse.up()
        page.wait_for_timeout(800)
        chk("UI-8", "★ 拖出框选时**框真的画出来了**", shot_marquee == 1, f"marquee={shot_marquee}")
        want_x = cb["x"] + 12
        want_y = cb["y"] + 12
        want_w = cb["width"] - 24
        chk("UI-8c", "★★ 框的位置**与鼠标一致**（不是整体偏移一个画布原点）",
            box_drawn is not None
            and abs(box_drawn["x"] - want_x) <= 3 and abs(box_drawn["y"] - want_y) <= 3
            and abs(box_drawn["width"] - want_w) <= 5,
            f"画出 left={None if box_drawn is None else round(box_drawn['x'])} "
            f"top={None if box_drawn is None else round(box_drawn['y'])} "
            f"w={None if box_drawn is None else round(box_drawn['width'])}"
            f" ｜ 期望 left={round(want_x)} top={round(want_y)} w={round(want_w)}")
        chk("UI-8b", "★★ 框完之后**所有在框里的对象都被选中**", picked_count() == EXPECT_NODES, f"选中 {picked_count()} 期望={EXPECT_NODES}")
        page.screenshot(path=SHOT + r"\ui-4-marquee.png")

        # ── ③d 右键菜单 ─────────────────────────────────────────────────
        page.mouse.click(30, 30)
        page.wait_for_timeout(400)
        b1 = rects.nth(0).bounding_box()
        page.mouse.click(b1["x"] + b1["width"] / 2, b1["y"] + b1["height"] / 2, button="right")
        page.wait_for_timeout(700)
        menu = page.locator(".dshw-pg-menu")
        chk("UI-9", "★ 在节点上右键 ⇒ 菜单弹出来", menu.count() == 1, f"menu={menu.count()}")
        items = menu.inner_text() if menu.count() == 1 else ""
        chk("UI-9b", "★ 菜单里是**节点那一套**（改文字 / 删除 / 长出子树）",
            "改文字" in items and "删除" in items and "长出子树" in items, items.replace("\n", " / ")[:160])
        page.screenshot(path=SHOT + r"\ui-5-menu-node.png")
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)

        # 空白处右键
        page.mouse.click(cb["x"] + 20, cb["y"] + cb["height"] - 20, button="right")
        page.wait_for_timeout(700)
        items2 = page.locator(".dshw-pg-menu").inner_text() if page.locator(".dshw-pg-menu").count() == 1 else ""
        chk("UI-9c", "★ 空白处右键是**另一套**（新建节点 / 全选 / 适应窗口）",
            "新建节点" in items2 and "全选" in items2, items2.replace("\n", " / ")[:160])
        page.screenshot(path=SHOT + r"\ui-6-menu-blank.png")
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)

        # ── ③e 键盘 ─────────────────────────────────────────────────────
        page.mouse.click(30, 30)
        page.wait_for_timeout(300)
        page.locator(".dshw-pg-canvas").click(position={"x": 5, "y": 5})
        page.keyboard.press("Control+a")
        page.wait_for_timeout(600)
        chk("UI-10", "★ Ctrl+A 全选", picked_count() == EXPECT_NODES, f"选中 {picked_count()} 期望={EXPECT_NODES}")

        # ── ③f 双击改名 ─────────────────────────────────────────────────
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        b2 = rects.nth(1).bounding_box()
        page.mouse.dblclick(b2["x"] + b2["width"] / 2, b2["y"] + b2["height"] / 2)
        page.wait_for_timeout(800)
        editor = page.locator(".dshw-pg-canvas input")
        chk("UI-11", "★ 双击节点 ⇒ 出现就地编辑框", editor.count() >= 1, f"input={editor.count()}")
        if editor.count() >= 1:
            page.keyboard.press("Control+a")
            page.keyboard.type("改过的名字")
            page.keyboard.press("Enter")
            page.wait_for_timeout(3000)
            texts = [o.get("text") for o in doc_objects()]
            chk("UI-11b", "★★ 改完之后**盘上的文字真的变了**", "改过的名字" in texts, json.dumps(texts, ensure_ascii=False))
            page.screenshot(path=SHOT + r"\ui-7-renamed.png")

        # ── P2 连线：从节点把手拖到另一个节点（用「乙」「丙」—— 「甲」已经被 UI-11 改名了）──
        page.keyboard.press("Escape")
        page.wait_for_timeout(600)

        def rect_of(label):
            """按标签文字找到那个节点的 <rect>（连线上的字也是 .dshw-pg-label，但它没有 rect，跳过）"""
            labels = page.locator("svg .dshw-pg-label")
            for i in range(labels.count()):
                if (labels.nth(i).text_content() or "").strip() != label:
                    continue
                g = labels.nth(i).locator("xpath=..")
                if g.locator("rect").count() == 0:
                    continue
                return g.locator("rect").first.bounding_box()
            return None

        def connect_handle_of(box):
            """节点的连接把手在它右边中点；按位置找最近的那个（顺序不可靠，位置可靠）"""
            hs = page.locator('.dshw-pg-handle[data-kind="connect"]')
            best = None
            best_d = 1e9
            want_x = box["x"] + box["width"]
            want_y = box["y"] + box["height"] / 2
            for i in range(hs.count()):
                hb = hs.nth(i).bounding_box()
                if not hb:
                    continue
                cx = hb["x"] + hb["width"] / 2
                cy = hb["y"] + hb["height"] / 2
                d = abs(cx - want_x) + abs(cy - want_y)
                if d < best_d:
                    best_d = d
                    best = (cx, cy)
            return best

        box_src = rect_of("乙")
        box_dst = rect_of("丙")
        chk("UI-12", "找到「乙」和「丙」两个节点的位置（按标签定位，不靠顺序）",
            box_src is not None and box_dst is not None,
            f"乙={box_src} 丙={box_dst}")

        edges_before = len([o for o in doc_objects() if o.get("type") == "LineEdge"])
        handle = connect_handle_of(box_src) if box_src else None
        chk("UI-12b", "★ 节点上有「连接把手」", handle is not None, f"handle={handle}")

        if handle is not None and box_dst is not None:
            page.mouse.move(handle[0], handle[1])
            page.wait_for_timeout(200)
            page.mouse.down()
            tx = box_dst["x"] + box_dst["width"] / 2
            ty = box_dst["y"] + box_dst["height"] / 2
            for s in range(1, 13):
                page.mouse.move(handle[0] + (tx - handle[0]) * s / 12, handle[1] + (ty - handle[1]) * s / 12)
                page.wait_for_timeout(30)
            drafting = page.locator(".dshw-pg-draft").count()
            page.mouse.up()
            page.wait_for_timeout(4000)
            chk("UI-12c", "★ 拖的过程中**虚线预览**画出来了", drafting == 1, f"draft={drafting}")
            edges_after = [o for o in doc_objects() if o.get("type") == "LineEdge"]
            chk("UI-12d", "★★ 松手在另一个节点上 ⇒ **盘上真的多了一条连线**",
                len(edges_after) == edges_before + 1, f"{edges_before} -> {len(edges_after)}")
            page.screenshot(path=SHOT + r"\ui-8-connected.png")

            # ── 连线：选中 + 右键菜单 + 拖端点改接线 ────────────────────
            page.keyboard.press("Escape")
            page.wait_for_timeout(400)
            b1 = rect_of("乙")
            b2 = rect_of("丙")
            if b1 and b2:
                mx = (b1["x"] + b1["width"] / 2 + b2["x"] + b2["width"] / 2) / 2
                my = (b1["y"] + b1["height"] / 2 + b2["y"] + b2["height"] / 2) / 2
                page.mouse.click(mx, my)
                page.wait_for_timeout(700)
                picked_edges = page.locator('.dshw-pg-edge[data-picked="1"]').count()
                chk("UI-13", "★ 点连线中点 ⇒ 这条线被选中", picked_edges >= 1, f"选中连线 {picked_edges}")
                handles_ep = page.locator('.dshw-pg-handle[data-kind="endpoint"]').count()
                chk("UI-13b", "★ 选中一条线之后，两端出现**改接线的把手**", handles_ep == 2, f"端点把手 {handles_ep}")
                page.mouse.click(mx, my, button="right")
                page.wait_for_timeout(700)
                items3 = page.locator(".dshw-pg-menu").inner_text() if page.locator(".dshw-pg-menu").count() == 1 else ""
                chk("UI-13c", "★ 连线右键是**第三套**菜单（改文字 / 反向 / 删除）",
                    "改连线文字" in items3 and "反向" in items3 and "删除这条连线" in items3,
                    items3.replace("\n", " / ")[:180])
                page.screenshot(path=SHOT + r"\ui-9-menu-edge.png")
                page.keyboard.press("Escape")
                page.wait_for_timeout(400)

                page.mouse.click(mx, my)
                page.wait_for_timeout(700)
                eps = page.locator('.dshw-pg-handle[data-kind="endpoint"]')
                box_root = rect_of("根节点")
                if eps.count() == 2 and box_root is not None:
                    e0 = eps.nth(0).bounding_box()
                    e1 = eps.nth(1).bounding_box()

                    def dist(a, b):
                        return abs(a["x"] - b["x"]) + abs(a["y"] - b["y"])

                    near_jia = e0 if dist(e0, b1) < dist(e1, b1) else e1
                    sx = near_jia["x"] + near_jia["width"] / 2
                    sy = near_jia["y"] + near_jia["height"] / 2
                    rx = box_root["x"] + box_root["width"] / 2
                    ry = box_root["y"] + box_root["height"] / 2
                    page.mouse.move(sx, sy)
                    page.mouse.down()
                    for s in range(1, 13):
                        page.mouse.move(sx + (rx - sx) * s / 12, sy + (ry - sy) * s / 12)
                        page.wait_for_timeout(30)
                    page.mouse.up()
                    page.wait_for_timeout(4000)
                    g = json.loads(urllib.request.urlopen(
                        BASE + "/workdesktop/api/pg/graph?project=" + urllib.parse.quote(PROJECT),
                        timeout=120).read().decode("utf-8"))
                    objs = g.get("objects", [])
                    by_ref = {o["ref"]: o.get("text") for o in objs}
                    lines = [f"{by_ref.get(o.get('sourceRef'))}->{by_ref.get(o.get('targetRef'))}"
                             for o in objs if o.get("type") == "LineEdge"]
                    chk("UI-14", "★★ 拖端点改接线：上游读回的端点真的换成了「根节点」",
                        any(str(t).startswith("根节点->") for t in lines), json.dumps(lines, ensure_ascii=False))
                    page.screenshot(path=SHOT + r"\ui-10-rewired.png")

        # ── P3 分区：渲染 / 折叠 ────────────────────────────────────────
        page.keyboard.press("Escape")
        page.wait_for_timeout(500)
        objs_now = doc_objects()
        ents = [o for o in objs_now if o.get("type") != "LineEdge"]
        ids = [o["uuid"] for o in ents[:2]]
        sec = api("/workdesktop/api/pg/section", {"project": PROJECT, "create": {"text": "我的分区", "children": ids}})
        chk("UI-15", "★ 建一个分区，把两个对象装进去", sec.get("ok") is True and sec.get("picked") == 2, str(sec)[:170])
        page.locator(".dshw-pg-bar button", has_text="刷新").first.click()
        page.wait_for_timeout(4500)

        sec_rect = page.locator('.dshw-pg-node[data-kind="Section"]')
        chk("UI-15b", "★ 分区画出来了（当容器）", sec_rect.count() == 1, f"分区 rect={sec_rect.count()}")
        toggle = page.locator(".dshw-pg-collapse")
        chk("UI-15c", "★ 分区标题栏上有折叠开关", toggle.count() == 1, f"开关={toggle.count()}")
        page.screenshot(path=SHOT + r"\ui-11-section.png")

        before_visible = page.locator(".dshw-pg-node").count()
        if toggle.count() == 1:
            toggle.first.click()
            page.wait_for_timeout(4000)
            after_visible = page.locator(".dshw-pg-node").count()
            chk("UI-16", "★★ 点折叠 ⇒ 分区里的对象**不画了**",
                after_visible <= before_visible - 2, f"{before_visible} -> {after_visible}")
            back = api("/workdesktop/api/pg/document?project=" + urllib.parse.quote(PROJECT))
            coll = [o for o in back.get("objects", []) if o.get("type") == "Section"]
            chk("UI-16b", "★★ 折叠状态**写到盘上了**（不是只改了画面）",
                len(coll) == 1 and coll[0].get("collapsed") is True, json.dumps(coll, ensure_ascii=False)[:170])
            page.screenshot(path=SHOT + r"\ui-12-collapsed.png")

        # ── P4 拖角缩放 + 撤销 ──────────────────────────────────────────
        page.keyboard.press("Escape")
        page.wait_for_timeout(500)
        try:
            api("/workdesktop/api/pg/delete", {"project": PROJECT, "uuids": [
                o["uuid"] for o in doc_objects() if o.get("type") == "Section"]})
        except Exception:
            pass
        page.locator(".dshw-pg-bar button", has_text="刷新").first.click()
        page.wait_for_timeout(4000)

        tgt = rect_of("乙")
        chk("UI-17a", "找到一个要缩放的节点（乙）", tgt is not None, f"乙={tgt}")
        if tgt is not None:
            page.mouse.click(tgt["x"] + tgt["width"] / 2, tgt["y"] + tgt["height"] / 2)
            page.wait_for_timeout(700)
            rz = page.locator('.dshw-pg-handle[data-kind="resize"]')
            chk("UI-17", "★ 选中单个对象后，四角出现缩放把手", rz.count() == 4, f"把手 {rz.count()}")
            page.screenshot(path=SHOT + r"\ui-13-resize.png")

            before_size = [o for o in doc_objects() if o.get("text") == "乙"][0]["size"]
            # ⚠️ 拖**左上角**、而且往画面里拖：拖右下角会跑出 1600 宽的浏览器视口，
            #    视口外的 mouse.move 根本不派发 —— 表现成"拖了 120 像素只生效 24 像素"，
            #    看着像产品 bug，其实是测试把自己拖出屏幕了（实测踩到）。
            nw = rz.nth(0).bounding_box()
            sx = nw["x"] + nw["width"] / 2
            sy = nw["y"] + nw["height"] / 2
            page.mouse.move(sx, sy)
            page.mouse.down()
            for s in range(1, 11):
                page.mouse.move(sx - s * 6, sy - s * 5)
                page.wait_for_timeout(30)
            page.mouse.up()
            page.wait_for_timeout(4000)
            after_size = [o for o in doc_objects() if o.get("text") == "乙"][0]["size"]
            chk("UI-17b", "★★ 拖角之后**盘上的尺寸真的变了**",
                abs(after_size["width"] - before_size["width"]) > 30
                and abs(after_size["height"] - before_size["height"]) > 20,
                f"{before_size} -> {after_size}")
            page.screenshot(path=SHOT + r"\ui-14-resized.png")

            page.locator(".dshw-pg-canvas").click(position={"x": 4, "y": 4})
            page.keyboard.press("Control+z")
            page.wait_for_timeout(4000)
            undone = [o for o in doc_objects() if o.get("text") == "乙"][0]["size"]
            chk("UI-18", "★★ Ctrl+Z 撤销 ⇒ **盘上的尺寸回到缩放前**",
                abs(undone["width"] - before_size["width"]) < 1
                and abs(undone["height"] - before_size["height"]) < 1,
                f"{after_size} -> {undone}")
            page.screenshot(path=SHOT + r"\ui-15-undone.png")

        # ── P4 剪断连线（剪刀模式）──────────────────────────────────────
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)
        page.locator(".dshw-pg-bar button", has_text="刷新").first.click()
        page.wait_for_timeout(4000)

        edges_now = [o for o in doc_objects() if o.get("type") == "LineEdge"]
        chk("UI-19a", "画布上有一条连线可供剪断", len(edges_now) >= 1, f"连线 {len(edges_now)} 条")

        shear = page.locator(".dshw-pg-bar button", has_text="剪刀")
        chk("UI-19", "★ 工具条上有剪刀开关", shear.count() >= 1, f"按钮 {shear.count()}")
        if shear.count() >= 1 and len(edges_now) >= 1:
            shear.first.click()
            page.wait_for_timeout(500)
            chk("UI-19b", "★ 打开后画布进入剪刀模式",
                page.locator('.dshw-pg-canvas[data-cut="1"]').count() == 1, "")

            # ⚠️ 必须按**这条连线真正的两端**算中点，不能"取屏幕上最远的一对节点" ——
            #    第一版就是这么写的，垂线画在了另一对节点中间，剪了个空（1 -> 1 不是产品的问题）。
            #    节点的 <title> 里有 uuid 前 8 位，靠它把文档里的 uuid 对回屏幕上的框。
            def rect_of_uuid(u):
                groups = page.locator("svg .dshw-pg-nodewrap")
                for i in range(groups.count()):
                    t = groups.nth(i).locator("title").first.text_content() or ""
                    if u in t:
                        return groups.nth(i).locator("rect").first.bounding_box()
                return None

            fresh = doc_objects()
            by_index = {o["index"]: o["uuid"] for o in fresh}
            edge = next(o for o in fresh if o.get("type") == "LineEdge")
            ends = []
            for link in (edge.get("links") or []):
                m = re.match(r"^/(\d+)", str(link))
                if m:
                    ends.append(by_index.get(int(m.group(1))))
            chk("UI-19c", "从文档里解析出这条连线真正的两端",
                len(ends) == 2 and all(ends), f"ends={[str(e)[:8] for e in ends]}")

            mid = None
            if len(ends) == 2 and all(ends):
                bb1 = rect_of_uuid(str(ends[0])[:8])
                bb2 = rect_of_uuid(str(ends[1])[:8])
                if bb1 and bb2:
                    x1 = bb1["x"] + bb1["width"] / 2
                    y1 = bb1["y"] + bb1["height"] / 2
                    x2 = bb2["x"] + bb2["width"] / 2
                    y2 = bb2["y"] + bb2["height"] / 2
                    mx, my = (x1 + x2) / 2, (y1 + y2) / 2
                    dx, dy = x2 - x1, y2 - y1
                    ln = max(1.0, (dx * dx + dy * dy) ** 0.5)
                    # 垂直方向划过去才会真的穿过它（顺着划是剪不断的）
                    mid = (mx, my, -dy / ln, dx / ln)
            chk("UI-19c2", "算出那条连线的中点与垂直方向", mid is not None, f"mid={mid}")

            if mid is not None:
                mx, my, px, py = mid
                a = (mx - px * 70, my - py * 70)
                b = (mx + px * 70, my + py * 70)
                page.mouse.move(a[0], a[1])
                page.mouse.down()
                for s in range(1, 11):
                    page.mouse.move(a[0] + (b[0] - a[0]) * s / 10, a[1] + (b[1] - a[1]) * s / 10)
                    page.wait_for_timeout(30)
                drawing = page.locator(".dshw-pg-cutline").count()
                page.mouse.up()
                page.wait_for_timeout(4000)
                chk("UI-19d", "★ 划的过程中**剪断线画出来了**", drawing == 1, f"cutline={drawing}")
                left = [o for o in doc_objects() if o.get("type") == "LineEdge"]
                chk("UI-19e", "★★ 划完之后**盘上那条连线真的没了**",
                    len(left) == len(edges_now) - 1, f"{len(edges_now)} -> {len(left)}")
                page.screenshot(path=SHOT + r"\ui-16-cut.png")

                u2 = api("/workdesktop/api/pg/undo", {"project": PROJECT})
                back = [o for o in doc_objects() if o.get("type") == "LineEdge"]
                chk("UI-19f", "★★ 剪断也能撤销（走的是同一套快照）",
                    u2.get("ok") is True and len(back) == len(edges_now),
                    f"{len(left)} -> {len(back)}")

        browser.close()
finally:
    removed = api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
    print(f"\n清理：{'临时工程已删除' if removed.get('ok') else str(removed)[:140]}")

print(f"\nPASS={passed} FAIL={failed}")
sys.exit(0 if failed == 0 else 1)
