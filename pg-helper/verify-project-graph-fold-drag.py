# -*- coding: utf-8 -*-
"""拖动**折叠的**组合：连线必须与组合一起动（用户 2026-10-10 报的"连线先动、松手组合才动"）。

病灶（改之前）：画组合框那一行写的是 `pgCollapsedBox(o.text, boxOf(o))` ——
直接读**磁盘上存的那个框**，把上面刚按成员实时位置算出来的 `b` 整个丢掉。
拖折叠组合时 `liveFit` 是 true（成员也在移动集合里）⇒ 下面 `d = {0,0}`
⇒ 框**一动不动**；而连线走 `centerOf → offsetOf(o.uuid)`、**跟着鼠标走**。
两者就是这么分叉的。

这个套件在**同一次按住不放的拖动里**连量四次，量的是"框中心"和"连线端点"各自的位移。
"""
import json
import os
import sys
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

from _suite_util import purge_project_backups

BASE = "http://127.0.0.1:3080"
PROJECT = "折叠拖动自测临时工程"
TOL = 8.0        # 像素容差
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
    # 组内甲、乙（同一 y，保证跨组那条线是水平的）；组外丙在右边，用来接那条跨组线
    api("/workdesktop/api/pg/insert", {"project": PROJECT, "nodes": [
        {"text": "甲", "x": -260, "y": 0}, {"text": "乙", "x": -60, "y": 0}, {"text": "丙", "x": 460, "y": 0}]})
    objs = api("/workdesktop/api/pg/document?project=" + urllib.parse.quote(PROJECT))["objects"]
    uu = {o["text"]: o["uuid"] for o in objs if o.get("text") in ("甲", "乙", "丙")}
    api("/workdesktop/api/pg/connect", {"project": PROJECT, "source": uu["甲"], "target": uu["丙"]})
    grp = api("/workdesktop/api/pg/section", {"project": PROJECT, "create": {"text": "组合", "children": [uu["甲"], uu["乙"]]}})
    su = api("/workdesktop/api/pg/document?project=" + urllib.parse.quote(PROJECT))["objects"]
    sec_uuid = next(o["uuid"] for o in su if o.get("type") == "Section")
    api("/workdesktop/api/pg/section", {"project": PROJECT, "uuid": sec_uuid, "collapsed": True})
    chk("FDRAG-1", "底图：组（甲+乙）+ 组外丙 + 跨组一条线，并且**先折叠**",
        grp.get("ok") is True, f"组框 {grp.get('box')}")

    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True)
        page = b.new_page(viewport={"width": 1600, "height": 1000})
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)[:300]))
        page.goto(f"{BASE}/?token={read_token()}", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(9000)
        page.click('button[data-dshw-panel="dsh-workdesktop:project-graph"]')
        page.wait_for_timeout(4000)
        page.select_option(".dshw-pg-bar select", PROJECT)
        page.wait_for_timeout(5000)

        def sec_rect():
            wraps = page.locator("svg .dshw-pg-nodewrap")
            for i in range(wraps.count()):
                ts = wraps.nth(i).locator("title")
                txt = " | ".join((ts.nth(k).text_content() or "") for k in range(ts.count()))
                if "Section · 组合" in txt:
                    return wraps.nth(i).locator("rect").first.bounding_box()
            return None

        def edge_line():
            """跨组那条线的两个端点（屏幕坐标）。画布 svg 的缩放/平移用 CTM 换算。"""
            return page.evaluate("""() => {
              const line = document.querySelector('svg line.dshw-pg-edge')
              if (line === null) return null
              const m = line.getScreenCTM()
              if (m === null) return null
              const pt = line.ownerSVGElement.createSVGPoint()
              const rd = (x, y) => { pt.x = x; pt.y = y; const q = pt.matrixTransform(m); return {x: q.x, y: q.y} }
              return {a: rd(+line.getAttribute('x1'), +line.getAttribute('y1')),
                      b: rd(+line.getAttribute('x2'), +line.getAttribute('y2'))}
            }""")

        def snap():
            r = sec_rect(); e = edge_line()
            return {
                "box": None if r is None else {"cx": r["x"] + r["width"] / 2, "cy": r["y"] + r["height"] / 2,
                                               "x": r["x"], "y": r["y"], "w": r["width"], "h": r["height"]},
                "edge": e,
            }

        s0 = snap()
        chk("FDRAG-2", "找到折叠后的组合框和那条跨组连线",
            s0["box"] is not None and s0["edge"] is not None,
            f"框 {None if s0['box'] is None else (round(s0['box']['w']), round(s0['box']['h']))} 线 {s0['edge'] is not None}")
        if s0["box"] is None or s0["edge"] is None:
            b.close(); sys.exit(1)
        # 折叠态：框应该是薄薄一条，说明确实是折叠状态量的
        chk("FDRAG-2b", "组合确实处于折叠态（框是薄薄一条）", s0["box"]["h"] < 45, f"高 {round(s0['box']['h'])}")

        bx = s0["box"]["x"] + s0["box"]["w"] / 2
        by = s0["box"]["y"] + s0["box"]["h"] / 2
        # 连线的**组这一侧**端点：取离组合中心近的那一端
        da = abs(s0["edge"]["a"]["x"] - bx) + abs(s0["edge"]["a"]["y"] - by)
        db = abs(s0["edge"]["b"]["x"] - bx) + abs(s0["edge"]["b"]["y"] - by)
        side = "a" if da <= db else "b"

        # ── 同一次按住不放的拖动：往**画布内**（左）拖，中途连量四次 ──────────
        page.mouse.move(bx, by)
        page.mouse.down()
        marks = []

        def measure(tag, dx):
            page.mouse.move(bx - dx, by)
            page.wait_for_timeout(450)
            s = snap()
            marks.append((tag, dx, s))
            return s

        m1 = measure("拖 60", 60)
        m2 = measure("拖 180", 180)
        m3 = measure("收回 60", 60)
        m4 = measure("回到 0", 0)
        page.mouse.up()
        page.wait_for_timeout(4000)

        def dbox(s):
            return None if s["box"] is None else (s["box"]["cx"] - s0["box"]["cx"], s["box"]["cy"] - s0["box"]["cy"])

        def dedge(s):
            if s["edge"] is None:
                return None
            return (s["edge"][side]["x"] - s0["edge"][side]["x"], s["edge"][side]["y"] - s0["edge"][side]["y"])

        print("         拖动中各次位移（框中心 / 连线端点）：")
        for tag, dx, s in marks:
            print(f"           {tag:<8} 框 {dbox(s)}  线 {dedge(s)}")

        # ① 框**必须跟着动**（这是病灶本身：改之前框位移恒为 (0,0)）
        mb = dbox(m2)
        chk("FDRAG-3", "★★★ 拖动过程中**组合框就在动**（不是等松手才动）",
            mb is not None and abs(mb[0]) > 80,
            f"拖到 180 时框中心位移 {None if mb is None else (round(mb[0]), round(mb[1]))}")

        # ② 框与连线**位移一致**（用户要的"一起动"）
        me = dedge(m2)
        chk("FDRAG-4", "★★★ 拖动过程中**连线与组合位移一致**（一起动，不分先后）",
            mb is not None and me is not None and abs(mb[0] - me[0]) <= TOL and abs(mb[1] - me[1]) <= TOL,
            f"框 {None if mb is None else (round(mb[0]), round(mb[1]))} vs 线 {None if me is None else (round(me[0]), round(me[1]))}")

        # ③ 中途每次采样都要同步（不是只有某一个时刻凑巧对上）
        worst = 0.0
        for tag, dx, s in marks:
            a, c = dbox(s), dedge(s)
            if a is None or c is None:
                worst = 9999; break
            worst = max(worst, abs(a[0] - c[0]), abs(a[1] - c[1]))
        chk("FDRAG-5", "★ 四次采样**每一次**框与连线都同步（最大值在容差内）",
            worst <= TOL, f"最大不同步 {worst:.1f}px（容差 {TOL}）")

        # ④ 连线端点始终落在组合框的边上（近左或近右）
        s_last = marks[1][2]
        near = False
        if s_last["box"] is not None and s_last["edge"] is not None:
            ex = s_last["edge"][side]["x"]
            L = s_last["box"]["x"]; R = L + s_last["box"]["w"]
            near = abs(ex - L) < 60 or abs(ex - R) < 60
        chk("FDRAG-6", "★★ 连线端点始终贴在组合框边上（重接没被拖动破坏）", near,
            None if s_last["edge"] is None else f"线端点 x={s_last['edge'][side]['x']:.0f}，框 [{s_last['box']['x']:.0f}, {s_last['box']['x']+s_last['box']['w']:.0f}]")

        # ⑤ 松手之后连线仍然贴着框（落盘后不回跳）
        page.wait_for_timeout(1500)
        s_after = snap()
        ok_after = False
        if s_after["box"] is not None and s_after["edge"] is not None:
            ex = s_after["edge"][side]["x"]
            L = s_after["box"]["x"]; R = L + s_after["box"]["w"]
            ok_after = abs(ex - L) < 60 or abs(ex - R) < 60
        chk("FDRAG-7", "★ 松手之后连线依然贴着框（不回跳）", ok_after)

        chk("FDRAG-8", "整个过程没有页面报错", len(errs) == 0, " | ".join(errs)[:300])
        page.screenshot(path=os.path.join(os.path.expanduser("~"), "Desktop", "DSH", "ui-32-folddrag.png"))
        b.close()
finally:
    removed = api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
    # 备份目录一起收干净：delete 只删 .prg，snapshots/versions 里的备份要另外收（见 _suite_util.py）
    purged = purge_project_backups(PROJECT)
    print(f"\n清理：{'临时工程已删除' if removed.get('ok') else str(removed)[:130]}")

print(f"\nPASS={passed} FAIL={failed}")
sys.exit(0 if failed == 0 else 1)
