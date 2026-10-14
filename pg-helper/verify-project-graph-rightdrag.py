# -*- coding: utf-8 -*-
"""右键拖动：**起点在组合内部空当**时，先剪断、拖出边界才变连线（用户 2026-10-10 裁定）。

用户原话：
  > 「只有在从一个组合/元素内部向外部拖动（从内部离开组合/元素本身边界之外）才显示拖动连线；
  >   如果是在组合内部的空白位置拖动时，默认优先右键拖动删除功能。」
补答：
  > 「边界内=剪断，边界外=连线；如果是从边界外的空白处向边界内按右键拖动则为剪断组合。」

所以本套件盯四种起手/落点组合：
  RD-1 组合内空当 → 停在组合内            ⇒ 剪断（画的是红直线，不画连线）
  RD-2 组合内空当 → 拖到组外某个节点      ⇒ 连线（画的是连线，松手后新增一条边）
  RD-3 组合外空当 → 拖进组合里            ⇒ 剪断（不新增边）
  RD-4 元素（节点）上起手 → 拖到另一个节点 ⇒ 连线（这条是原有行为，防回归）
"""
import io
import json
import os
import sys
import urllib.parse
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

from playwright.sync_api import sync_playwright

from _suite_util import purge_project_backups

BASE = "http://127.0.0.1:3080"
PROJECT = "右键拖动手势自测临时工程"
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
        print(f"         {str(detail)[:280]}")


def api(path, body=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=data, method="GET" if body is None else "POST")
    if body is not None:
        req.add_header("content-type", "application/json")
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode("utf-8"))


def read_token():
    log = os.path.join(os.path.expanduser("~"), ".dsh", "daemon", "dsh.log")
    with open(log, encoding="utf-8", errors="ignore") as fh:
        hits = [ln for ln in fh if "dsh web: http" in ln]
    return hits[-1].split("token=")[1].strip() if hits else ""


def doc():
    return api("/workdesktop/api/pg/document?project=" + urllib.parse.quote(PROJECT))["objects"]


def n_edges():
    return len([o for o in doc() if o.get("type") == "LineEdge"])


api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
api("/workdesktop/api/pg/project", {"action": "create", "name": PROJECT})

try:
    # 组内两个节点 + 组外一个节点；组内留出空当
    api("/workdesktop/api/pg/insert", {"project": PROJECT, "nodes": [
        {"text": "in1", "x": -600, "y": -150}, {"text": "in2", "x": -350, "y": -150},
        {"text": "out", "x": 500, "y": 0}]})
    d = doc()
    U = {o["text"]: o["uuid"] for o in d if o.get("text") in ("in1", "in2", "out")}
    api("/workdesktop/api/pg/section", {"project": PROJECT, "create": {"text": "G", "children": [U["in1"], U["in2"]]}})

    with sync_playwright() as p:
        pw = p.chromium.launch(channel="chrome", headless=True)
        page = pw.new_page(viewport={"width": 1600, "height": 1000})
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)[:200]))
        page.goto(f"{BASE}/?token={read_token()}", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(9000)
        page.click('button[data-dshw-panel="dsh-workdesktop:project-graph"]')
        page.wait_for_timeout(4000)
        page.select_option(".dshw-pg-bar select", PROJECT)
        page.wait_for_timeout(5000)

        def geom(name, kind=None):
            return page.evaluate("""(arg) => {
              for (const w of document.querySelectorAll('svg .dshw-pg-nodewrap')) {
                const r = w.querySelector('rect'); if (!r) continue
                if (arg.kind && r.getAttribute('data-kind') !== arg.kind) continue
                const parts = []
                w.querySelectorAll('title').forEach(t => String(t.textContent||'').split('·').forEach(s=>parts.push(s.trim())))
                if (parts.indexOf(arg.name) < 0) continue
                const bb = r.getBoundingClientRect()
                return {x: bb.x, y: bb.y, w: bb.width, h: bb.height}
              }
              return null
            }""", {"name": name, "kind": kind})

        g = geom("G", "Section")
        in1 = geom("in1", "TextNode")
        out = geom("out", "TextNode")
        chk("RD-0", "底图：组合 G（含 in1/in2）+ 组外节点 out 都在画布上",
            g is not None and in1 is not None and out is not None,
            json.dumps({"G": g is not None, "in1": in1 is not None, "out": out is not None}))

        # ⚠️ 这个面板有缩放，**屏幕像素 ≠ 世界单位**。判定"有没有离开组合边界"用的是世界坐标，
        #    所以测试也不能拿屏幕坐标去猜（第一版就是这么错的：按屏幕中心取"组内空当"，
        #    结果那个点在**世界坐标里离组合边界还很远**，拖动自然出不去、也就一直只画剪断线）。
        #    这里用"已知世界坐标的两个节点 + 它们的屏幕位置"反解缩放 k，再据此挑点。
        d = doc()

        def world_of(text):
            for o in d:
                if o.get("text") == text and o.get("type") != "LineEdge":
                    return (o["location"]["x"], o["location"]["y"])
            return None

        w_in1 = world_of("in1"); w_out = world_of("out")
        k = (out["x"] - in1["x"]) / (w_out[0] - w_in1[0]) if w_out[0] != w_in1[0] else 1.0
        print(f"         缩放 k ≈ {k:.4f}（由 in1 / out 的屏幕位置与世界坐标反解）")

        def world_to_screen(wx, wy):
            return (in1["x"] + (wx - w_in1[0]) * k, in1["y"] + (wy - w_in1[1]) * k)

        # G 在世界里的框（宿主存的值 + 成员包围盒推算都用得上，这里直接用文档里的）
        dg = [o for o in d if o.get("type") == "Section" and o.get("text") == "G"][0]
        gx, gy = dg["location"]["x"], dg["location"]["y"]
        gw, gh = dg["size"]["width"], dg["size"]["height"]
        # 组内空当：取 G 框内**离四边都远**的一个点。
        # ⚠️ 别贴着边取 —— 拖动本身有几十像素，贴边的话终点就跑出去了，
        #    而"跑出去"按规则就该变成连线（第一版取 0.85 高度，30px 的拖动直接出了下边界，
        #    于是 RD-1 判成了"连线"，红的是测点不是产品）。
        blank_in_world = (gx + gw * 0.28, gy + gh * 0.68)
        # 组外：世界坐标里取 G 框右侧外面 200 单位
        outside_wx = gx + gw + 200
        print(f"         G 世界框 = ({gx:.0f},{gy:.0f}) {gw:.0f}x{gh:.0f}；"
              f"组内点世界 x={blank_in_world[0]:.0f}；组外目标世界 x={outside_wx:.0f}（都在界内/界外）")

        canvas = page.locator(".dshw-pg-canvas").bounding_box()
        # ⚠️ 挑点必须**落在画布矩形内**。第一版按"G 左边 150 单位"算出的屏幕点落到了
        #    x=829，而画布是从 x=881 开始的 —— 那一下按在了面板外面的卡片上，
        #    按下事件根本没到画布（实测 gest=null、cutline=0、draft=0）。
        def screen_to_world(sx, sy):
            return (w_in1[0] + (sx - in1["x"]) / k, w_in1[1] + (sy - in1["y"]) / k)

        def clamp_to_canvas(sx, sy):
            return (min(max(sx, canvas["x"] + 12), canvas["x"] + canvas["width"] - 12),
                    min(max(sy, canvas["y"] + 12), canvas["y"] + canvas["height"] - 12))

        blank_in = clamp_to_canvas(*world_to_screen(*blank_in_world))
        tgt_x, tgt_y = clamp_to_canvas(*world_to_screen(outside_wx, gy + gh * 0.5))
        back_wx = screen_to_world(tgt_x, tgt_y)[0]
        blank_out_pt = clamp_to_canvas(*world_to_screen(gx - 150, gy + gh * 0.5))
        back_out_wx = screen_to_world(*blank_out_pt)[0]
        node_out = (out["x"] + out["w"] / 2, out["y"] + out["h"] / 2)
        node_in1 = (in1["x"] + in1["w"] / 2, in1["y"] + in1["h"] / 2)
        chk("RD-0b", "★ 测点本身是对的：组内点在 G 世界框**里面**、两个组外点都在**外面**，且都在画布内",
            gx < screen_to_world(*blank_in)[0] < gx + gw
            and back_wx > gx + gw and back_out_wx < gx,
            f"G 世界框 x ∈ ({gx:.0f},{gx + gw:.0f})；组内点 x={screen_to_world(*blank_in)[0]:.0f}；"
            f"拖出落点 x={back_wx:.0f}；组外起手 x={back_out_wx:.0f}；"
            f"画布 x ∈ ({canvas['x']:.0f},{canvas['x'] + canvas['width']:.0f})")

        def settle():
            """等面板把上一次操作引发的重绘做完。
            ⚠️ 必须等：剪断/连线之后面板会重新载入文档，**这期间按下去会命中空处**
               （实测 RD-1 之后紧接着按 RD-2，起手记到的 hitUuid 是 null、interiorOf 也是 null，
                于是"出界变连线"拿不到起点、整段退化成剪断 —— 红的是时序，不是产品）。
            """
            for _ in range(20):
                n = page.locator("svg .dshw-pg-nodewrap").count()
                page.wait_for_timeout(250)
                if n > 0 and page.locator("svg .dshw-pg-nodewrap").count() == n:
                    return n
            return 0

        def right_drag(frm, to, hold=True, tag=""):
            """右键从 frm 拖到 to；返回拖动中的 (cutline, 连线草稿) 数量。"""
            settle()

            page.mouse.move(*frm)
            page.mouse.down(button="right")
            page.wait_for_timeout(250)
            page.mouse.move((frm[0] + to[0]) / 2, (frm[1] + to[1]) / 2, steps=4)
            page.wait_for_timeout(150)
            page.mouse.move(*to, steps=4)
            page.wait_for_timeout(450)
            got = (page.locator(".dshw-pg-cutline").count(), page.locator(".dshw-pg-draft").count())

            if hold:
                page.mouse.up(button="right")
                page.wait_for_timeout(2500)
            return got

        def live(name, kind=None):
            """每次判定前**重新量一遍**屏幕位置。
            ⚠️ 前面几次判定会真的删掉/新增东西，画布因此会重绘、节点会挪 ——
               沿用一开始量到的坐标，后面就会按到空处或按到别的对象上（实测就是这么连环红的）。
            """
            g2 = geom(name, kind)
            return (g2["x"] + g2["w"] / 2, g2["y"] + g2["h"] / 2) if g2 else None

        def gbox():
            return geom("G", "Section")

        def rebuild():
            """把底图**重建一遍**再用。
            ⚠️ 为什么不是"沿用同一张图、只重算坐标"：剪断会真的删东西、连线会真的加东西，
               面板随后重新载入文档 —— 紧接着按下去时 `hitEntity` 可能返回 null
               （实测 RD-2 单独跑必过、跟在 RD-1 后面就红，起手记到的 hitUuid 是 null）。
               这是测试之间的相互污染，不是产品问题；每个用例从干净底图开始最省心。
            """
            api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
            api("/workdesktop/api/pg/project", {"action": "create", "name": PROJECT})
            api("/workdesktop/api/pg/insert", {"project": PROJECT, "nodes": [
                {"text": "in1", "x": -600, "y": -150}, {"text": "in2", "x": -350, "y": -150},
                {"text": "out", "x": 500, "y": 0}]})
            dd = doc()
            uu = {o["text"]: o["uuid"] for o in dd if o.get("text") in ("in1", "in2", "out")}
            api("/workdesktop/api/pg/section", {"project": PROJECT, "create": {"text": "G", "children": [uu["in1"], uu["in2"]]}})
            page.wait_for_timeout(3200)
            settle()

        # ── RD-2 组内空当 → 拖出边界 ⇒ 连线（先跑这条不删东西的）──────
        rebuild()
        e1 = n_edges()
        in_pt = clamp_to_canvas(*world_to_screen(gx + gw * 0.28, gy + gh * 0.68))
        tgt_pt = clamp_to_canvas(*world_to_screen(outside_wx, gy + gh * 0.5))
        cut2, draft2 = right_drag(in_pt, tgt_pt)
        chk("RD-2", "★★ 组合内空当起手、**拖出边界** ⇒ 切成连线（画的是连线草稿）",
            draft2 >= 1 and cut2 == 0, f"cutline={cut2} 连线草稿={draft2}")
        e2 = n_edges()
        chk("RD-2b", "★★ 松手之后**真的连上了一条边**（起点是那个组合）",
            e2 == e1 + 1, f"连线 {e1} → {e2}")

        # ── RD-1 组内空当 → 停在组内 ⇒ 剪断 ──────────────────────
        # ⚠️ 拖动幅度要小到**终点仍在 G 里**。第一版往下右各拖 40/30 像素，
        #    换算成世界坐标约 73/55 单位，直接从下边界出去了 —— 那按规则就该变连线，
        #    于是把"该剪断"的断言撞在"已经出界"的输入上（红的是测点，不是产品）。
        rebuild()
        e0 = n_edges()
        p_in = clamp_to_canvas(*world_to_screen(gx + gw * 0.28, gy + gh * 0.68))
        p_end = (p_in[0] + 18, p_in[1] - 18)
        cut1, draft1 = right_drag(p_in, p_end)
        interior_end = screen_to_world(*p_end)
        inside_end = gx < interior_end[0] < gx + gw and gy < interior_end[1] < gy + gh
        chk("RD-1", "★ 组合内空当起手、停在组合内 ⇒ 画的是**剪断线**（不是连线）",
            cut1 >= 1 and draft1 == 0 and inside_end,
            f"cutline={cut1} 连线草稿={draft1}；终点世界=({interior_end[0]:.0f},{interior_end[1]:.0f}) "
            f"是否仍在 G({gx:.0f},{gy:.0f},{gx + gw:.0f},{gy + gh:.0f}) 内={inside_end}")
        chk("RD-1b", "★ 而且没有因此新增连线", n_edges() == e0, f"连线 {e0} → {n_edges()}")

        # ── RD-3 组外空当 → 拖进组合里 ⇒ 剪断 ──────────────────────
        rebuild()
        e3 = n_edges()
        out_pt = clamp_to_canvas(*world_to_screen(gx - 150, gy + gh * 0.5))
        end_in = clamp_to_canvas(*world_to_screen(gx + gw * 0.5, gy + gh * 0.5))
        cut3, draft3 = right_drag(out_pt, end_in)
        chk("RD-3", "★ 组合外空当起手、拖进组合里 ⇒ 仍是**剪断**（不连）",
            cut3 >= 1 and draft3 == 0, f"cutline={cut3} 连线草稿={draft3}")
        chk("RD-3b", "★ 也没有新增连线", n_edges() == e3, f"连线 {e3} → {n_edges()}")

        # ── RD-4 节点上起手 ⇒ 连线（原有行为，防回归）─────────────
        rebuild()
        e4 = n_edges()
        p_in1 = live("in1", "TextNode")
        p_out = live("out", "TextNode")
        cut4, draft4 = right_drag(p_in1, p_out)
        chk("RD-4", "★ 从**元素（节点）**上起手右键拖 ⇒ 连线（原有行为不许被这次改动弄坏）",
            draft4 >= 1 and cut4 == 0, f"cutline={cut4} 连线草稿={draft4}（in1@{p_in1} → out@{p_out}）")
        e5 = n_edges()
        chk("RD-4b", "★ 松手后新增一条边", e5 == e4 + 1, f"连线 {e4} → {e5}")

        chk("RD-5", "整个过程没有页面报错", len(errs) == 0, " | ".join(errs)[:200])
        page.screenshot(path=os.path.join(os.path.expanduser("~"), "Desktop", "DSH", "ui-39-rightdrag.png"))
        pw.close()
finally:
    removed = api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
    purged = purge_project_backups(PROJECT)
    print(f"\n清理：{'临时工程已删除' if removed.get('ok') else str(removed)[:130]}（另收 {purged} 个备份目录）")

print(f"\nPASS={passed} FAIL={failed}")
sys.exit(0 if failed == 0 else 1)
