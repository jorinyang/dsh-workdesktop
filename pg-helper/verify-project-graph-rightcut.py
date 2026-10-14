"""工程图 · **鼠标右键拖动剪掉经过的元素**（实机核验，Playwright 驱动真 Chrome）

用户点名的这条：右键按住拖动，从起点到终点那条**直线**经过的元素全被删掉。
原项目依据 ControllerCutting.tsx：第 111 行 button===2 起手，mouseUpFunction（199-229 行）
删 warningAssociations（连线）+ warningEntity（实体）。

另外守一条容易坏的：**没拖动的右键仍然要弹菜单**（不能让剪断把右键菜单顶掉）。
"""
import base64
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request

from _suite_util import purge_project_backups

BASE = "http://127.0.0.1:3080"
PROJECT = "右键剪断自测临时工程"
PROJECTS = os.path.join(os.path.expanduser("~"), ".dsh\\.dsh-project-graph\\projects")
NODE = os.path.join(os.path.expanduser("~"), "AppData\\Local\\nvm\\v24.20.0\\node.exe")
PLUGIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOT = os.path.join(os.path.expanduser("~"), "Desktop\\DSH")
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
        print(f"         {str(detail)[:240]}")


def api(path, body=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=data, method="GET" if body is None else "POST")
    if body is not None:
        req.add_header("content-type", "application/json")
    with urllib.request.urlopen(req, timeout=180) as resp:
        return json.loads(resp.read().decode("utf-8"))


def read_token():
    with open(os.path.join(os.path.expanduser("~"), ".dsh\\daemon\\dsh.log"), encoding="utf-8", errors="ignore") as fh:
        hits = [ln for ln in fh if "dsh web: http" in ln]
    return hits[-1].split("token=")[1].strip() if hits else ""


def doc():
    return api("/workdesktop/api/pg/document?project=" + urllib.parse.quote(PROJECT))["objects"]


api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
made = api("/workdesktop/api/pg/project", {"action": "create", "name": PROJECT})
chk("RC-1", "建临时工程", made.get("ok") is True, str(made)[:120])

try:
    ins = api("/workdesktop/api/pg/insert", {"project": PROJECT, "nodes": [
        {"text": "甲", "x": 0, "y": 0}, {"text": "乙", "x": 400, "y": 0}, {"text": "丙", "x": 800, "y": 0}]})
    chk("RC-2", "造三个节点", ins.get("ok") is True and len(ins.get("created", [])) == 3, str(ins)[:130])
    objs = doc()
    pick = lambda t: next(o["uuid"] for o in objs if o.get("text") == t)  # noqa: E731
    conn = api("/workdesktop/api/pg/connect", {"project": PROJECT, "source": pick("甲"), "target": pick("乙")})
    chk("RC-3", "连一条线（甲→乙）", conn.get("ok") is True, str(conn)[:130])
    before = doc()
    chk("RC-4", "记下改动前：实体数与连线数",
        len([o for o in before if o["type"] != "LineEdge"]) == 4 and len([o for o in before if o["type"] == "LineEdge"]) == 1,
        f"实体 {len([o for o in before if o['type'] != 'LineEdge'])} · 连线 {len([o for o in before if o['type'] == 'LineEdge'])}")

    from playwright.sync_api import sync_playwright

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
        chk("RC-5", "打开「工程图」面板", row is not None, "")
        if row is not None:
            row.click()
            page.wait_for_timeout(3500)
            page.select_option(".dshw-pg-bar select", PROJECT)
            page.wait_for_timeout(4500)

            canvas = page.locator(".dshw-pg-canvas").bounding_box()
            # 先验"没拖动的右键仍然弹菜单"（别被剪断顶掉）
            page.mouse.click(canvas["x"] + 30, canvas["y"] + canvas["height"] - 30, button="right")
            page.wait_for_timeout(700)
            menu_shown = page.locator(".dshw-pg-menu").count()
            chk("RC-6", "★ 没有拖动的右键**仍然弹出菜单**（剪断没把它顶掉）", menu_shown == 1,
                f"menu={menu_shown}")
            page.keyboard.press("Escape")
            page.wait_for_timeout(400)

            # 再验：右键按住横向拖过去 —— 线经过的节点和连线都该没了
            # ⚠️ 横向那条线必须**沿节点所在的那一行**划。第一版取的是画布竖直中点，
            #    而节点并不在中点高度上，线从它们中间穿过去了、什么都没碰到 ——
            #    面板如实回了「这条线没穿过任何连线」（功能是对的，是测试瞄偏了）。
            def rect_of_uuid(u):
                groups = page.locator("svg .dshw-pg-nodewrap")
                for i in range(groups.count()):
                    t = groups.nth(i).locator("title").first.text_content() or ""
                    if u in t:
                        return groups.nth(i).locator("rect").first.bounding_box()
                return None

            rowbox = None
            for o in doc():
                if o.get("type") != "LineEdge" and o.get("text") == "甲":
                    rowbox = rect_of_uuid(str(o["uuid"])[:8])
            chk("RC-6b", "定位到节点「甲」那一行（按 uuid 对回来，不靠顺序）", rowbox is not None, f"{rowbox}")

            # ⚠️⚠️ 2026-10-10 改：原来划的是**横线**（沿甲、乙那一行）。
            #    但甲→乙 那条连线**本身就是横的、就在同一行上** ⇒ 划线与它**平行且近乎共线**，
            #    判定用的是「两线段相交」（叉积定号），平行就永远不相交 —— 于是连线一条都不标红。
            #    实测：偏 12px 也一样不红（平行）；把算法单独拎出来算也确认「偏 7.5 ⇒ false」。
            #    **这是判定的定义，不是 bug**（确实没穿过）。是测试的划法挑错了方向。
            #    改成**竖着划**：在两条连线之间的空当里，从上到下穿过它们 —— 竖线与横线必然相交。
            def edge_boxes():
                out = []
                lines = page.locator("svg line.dshw-pg-edge")
                for i in range(lines.count()):
                    bb = lines.nth(i).bounding_box()
                    if bb:
                        out.append(bb)
                return out

            ebs = edge_boxes()
            chk("RC-6c", "拿得到连线（竖着划要穿过它们）", len(ebs) >= 1, f"连线 {len(ebs)} 条")

            # ⚠️⚠️ 2026-10-10 重要更正：「框体标红并被删」与「连线标红」**不能靠同一刀同时验**。
            #    原因是几何本身：连线在文档里是「端点 A 的框边 → 端点 B 的框边」，
            #    它那一段**只存在于两个框之间**。竖线要落在某个框**内**才能让框标红，
            #    可落在框内就穿不到那段连线（两段在框边上才相接，框内那侧没有线）。
            #    实测三个位置，各自只满足一半：
            #      · 划在「甲」中心      ⇒ 红的框体 1、实体 4→3（对）；红的连线 0（错）
            #      · 划在两节点正中 1/4  ⇒ 红的连线 1、连线 1→0（对）；红的框体 0、实体 4→4（错）
            #      · 划在甲框右缘附近    ⇒ 仍偏不到连线那一段（红的连线 0）
            #    这不是产品的毛病 —— 两种剪法本来就该各自生效。所以**分两刀验**：
            #      第一刀（下面 A 段）穿「甲」的框：验框体标红 + 元素被删 + 随之而来的连线消失；
            #      第二刀（B 段）穿那条连线的中段：验**连线**在松手前就被标红。
            boxes = {}
            for o in doc():
                if o.get("type") != "LineEdge" and o.get("text") == "甲":
                    bb = rect_of_uuid(str(o["uuid"])[:8])
                    if bb:
                        boxes["甲"] = bb

            def vertical_cut(x):
                """在 x 处从上到下右键划一刀，返回拖动中的 (cutline, hot_edges, hot_nodes)。"""
                page.mouse.move(x, canvas["y"] + 8)
                page.mouse.down(button="right")
                y0 = canvas["y"] + 8
                y1 = canvas["y"] + canvas["height"] - 8
                for k in range(1, 13):
                    page.mouse.move(x, y0 + (y1 - y0) * k / 12)
                    page.wait_for_timeout(35)
                got = (page.locator(".dshw-pg-cutline").count(),
                       page.locator('.dshw-pg-edge[data-cut="1"]').count(),
                       page.locator('.dshw-pg-node[data-cut="1"]').count())
                page.mouse.up(button="right")
                page.wait_for_timeout(4500)
                return got

            # ── 第一刀：穿「甲」的框 ──────────────────────────────────────
            x_node = (boxes["甲"]["x"] + boxes["甲"]["width"] / 2) if "甲" in boxes else (canvas["x"] + canvas["width"] / 2)
            drawing, hot_edges, hot_nodes = vertical_cut(x_node)
            chk("RC-7c", "★★ 拖动中：**将被剪掉的框体也被描红**",
                hot_nodes >= 1, f"红的框体 {hot_nodes} 个（竖线 x={round(x_node)}）")
            chk("RC-7", "★ 右键拖动时那条**直线画出来了**", drawing == 1, f"cutline={drawing}")
            after = doc()
            ents_after = [o for o in after if o["type"] != "LineEdge"]
            edges_after = [o for o in after if o["type"] == "LineEdge"]
            chk("RC-8", "★★ 直线经过的**元素真的被删了**（节点数变少）",
                len(ents_after) < 4,
                f"实体 4 -> {len(ents_after)}：{json.dumps([o.get('text') for o in ents_after], ensure_ascii=False)}")
            chk("RC-9", "★★ 端点被删之后，**那条连线也没了**（不留悬空引用）",
                len(edges_after) < 1, f"连线 1 -> {len(edges_after)}")

            # ── 第二刀：穿那条**连线自己**的中段（先把线接回来）────────────
            objs_now = doc()
            have = {o.get("text") for o in objs_now if o.get("type") != "LineEdge"}
            if "甲" not in have or "乙" not in have:
                api("/workdesktop/api/pg/insert", {"project": PROJECT, "nodes": [
                    {"text": "甲", "x": 0, "y": 0}, {"text": "乙", "x": 400, "y": 0}]})
            _o = doc()
            pick2 = lambda t: next(o["uuid"] for o in _o if o.get("text") == t)
            api("/workdesktop/api/pg/connect", {"project": PROJECT, "source": pick2("甲"), "target": pick2("乙")})
            page.wait_for_timeout(8000)
            # ⚠️ 记下**这一刀之前**的实体数：RC-10 的撤销只能拿它当基准。
            #    第一刀已经删过一个节点、第二刀前面又补过节点，拿最初的 4 去比必然对不上
            #    （实测 3 -> 5 假红）。撤销验的是"**这一刀**能不能撤回"，就该跟这一刀前比。
            n_before_edge_cut = len([o for o in doc() if o["type"] != "LineEdge"])
            ebs2 = edge_boxes()
            chk("RC-9b", "第二刀之前，连线接回来了", len(ebs2) >= 1, f"连线 {len(ebs2)} 条")
            if ebs2:
                mid = ebs2[0]
                x_edge = mid["x"] + mid["width"] / 2      # 连线**自己那一段**的中点
                _d, hot_edges2, _n = vertical_cut(x_edge)
                chk("RC-7b", "★★ 拖动中：**将被剪掉的连线被描红**（松手前就看得见）",
                    hot_edges2 >= 1, f"红的连线 {hot_edges2} 条（竖线 x={round(x_edge)}，穿连线中段）")

            page.screenshot(path=SHOT + r"\ui-18-right-cut.png")

            u = api("/workdesktop/api/pg/undo", {"project": PROJECT})
            back = doc()
            n_back = len([o for o in back if o["type"] != "LineEdge"])
            chk("RC-10", "★★ 剪断也能撤销（元素回来了）",
                u.get("ok") is True and n_back == n_before_edge_cut,
                f"这一刀前 {n_before_edge_cut} -> 撤销后 {n_back}")
        b.close()
finally:
    removed = api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
    # 备份目录一起收干净：delete 只删 .prg，snapshots/versions 里的备份要另外收（见 _suite_util.py）
    purged = purge_project_backups(PROJECT)
    print(f"\n清理：{'临时工程已删除' if removed.get('ok') else str(removed)[:130]}")

print(f"\nPASS={passed} FAIL={failed}")
sys.exit(0 if failed == 0 else 1)
