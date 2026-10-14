# -*- coding: utf-8 -*-
"""组合与组合交叉时的三个问题（实机复现 + 核验）
== 用户 2026-10-10 报的三条 ==
  ① 两个组合边界交叉时，移动其中一个，**另一个的边界会跟着变**；
  ② 交叉之后把其中一个移开，**移动的那个组合和它的成员会分离**；
  ③ 组合边框太细，**能抓住来拖的区域太小**。

== 用户补的一条不变量（同日晚）==
  「工程图组合的框体大小只和组内成员所在位置相关，和其他无关。」
  ⇒ 所以本套件所有涉及框的断言都不比"框"本身，而是比**框 == 成员的包围盒 + 固定边距**；
    框变了而成员没变 = 直接判红。这一条同时守住 ①②③ 三条的根。

== 怎么读「归谁」==
  走 `pg-probe.mjs` 直接读 `.prg`（文档层的 `parentUuidOf`），不走 `/pg/document` ——
  那个字段在宿主半体里，改完不重启宿主是看不到的，而断言不该被"要不要重启"绑架。
"""
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

from _suite_util import purge_project_backups

BASE = "http://127.0.0.1:3080"
PROJECT = "组合交叉自测临时工程"
HERE = os.path.dirname(os.path.abspath(__file__))
NODE = os.path.join(os.path.expanduser("~"), "AppData", "Local", "nvm", "v24.20.0", "node.exe")
PAD = 24          # 与客户端 liveFit / 宿主 fitSection 同一套边距
TITLE_BAR = 44    # 分组有名字时标题条占的高度（同上）
TOL = 3.0
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
    with urllib.request.urlopen(req, timeout=180) as resp:
        return json.loads(resp.read().decode("utf-8"))


def read_token():
    log = os.path.join(os.path.expanduser("~"), ".dsh", "daemon", "dsh.log")
    with open(log, encoding="utf-8", errors="ignore") as fh:
        hits = [ln for ln in fh if "dsh web: http" in ln]
    return hits[-1].split("token=")[1].strip() if hits else ""


def probe():
    """直接读 .prg：每个对象的坐标与归属。"""
    out = subprocess.run([NODE, os.path.join(HERE, "pg-probe.mjs"), PROJECT],
                         capture_output=True, text=True, encoding="utf-8", timeout=120)
    line = (out.stdout or "").strip().splitlines()
    if not line:
        return {"ok": False, "error": (out.stderr or "no output")[:200]}
    return json.loads(line[-1])


def members_of(state, sec_text):
    """某个组合名下的成员（按归属反查）。"""
    sec_uuid = state["objects"][sec_text]["uuid"]
    return sorted(k for k, v in state["objects"].items() if v["parent"] == sec_uuid)


def expected_box(state, sec_text):
    """用户那条不变量的算法：框 == 成员包围盒 + 固定边距。"""
    kids = members_of(state, sec_text)
    if not kids:
        return None
    xs = [state["objects"][k]["x"] for k in kids]
    ys = [state["objects"][k]["y"] for k in kids]
    x1 = [state["objects"][k]["x"] + state["objects"][k]["w"] for k in kids]
    y1 = [state["objects"][k]["y"] + state["objects"][k]["h"] for k in kids]
    return {"x": min(xs) - PAD, "y": min(ys) - PAD - TITLE_BAR,
            "w": max(x1) - min(xs) + PAD * 2, "h": max(y1) - min(ys) + PAD * 2 + TITLE_BAR}


def box_matches(state, sec_text):
    got = state["objects"][sec_text]
    want = expected_box(state, sec_text)
    if want is None:
        return False, "这个组合没有成员"
    d = {k: round(got[k] - want[k], 2) for k in ("x", "y", "w", "h")}
    return all(abs(v) <= TOL for v in d.values()), f"框与「成员包围盒+边距」的差 {d}"


api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
api("/workdesktop/api/pg/project", {"action": "create", "name": PROJECT})

try:
    # A：甲乙；B：丙丁。B 摆开一段距离，留出越界的空间。
    api("/workdesktop/api/pg/insert", {"project": PROJECT, "nodes": [
        {"text": "甲", "x": -700, "y": 0}, {"text": "乙", "x": -500, "y": 0},
        {"text": "丙", "x": 300, "y": 0}, {"text": "丁", "x": 500, "y": 0}]})
    objs = api("/workdesktop/api/pg/document?project=" + urllib.parse.quote(PROJECT))["objects"]
    uu = {o["text"]: o["uuid"] for o in objs if o.get("text") in ("甲", "乙", "丙", "丁")}
    a = api("/workdesktop/api/pg/section", {"project": PROJECT, "create": {"text": "A组", "children": [uu["甲"], uu["乙"]]}})
    b = api("/workdesktop/api/pg/section", {"project": PROJECT, "create": {"text": "B组", "children": [uu["丙"], uu["丁"]]}})
    chk("X-1", "底图：A组（甲+乙）与 B组（丙+丁）建好", a.get("ok") is True and b.get("ok") is True,
        f"A {a.get('box')}  B {b.get('box')}")

    st0 = probe()
    chk("X-2", "读得到归属：甲→A组、丙→B组",
        st0["objects"]["甲"]["parent"] == st0["objects"]["A组"]["uuid"]
        and st0["objects"]["丙"]["parent"] == st0["objects"]["B组"]["uuid"],
        f"甲→{str(st0['objects']['甲']['parent'])[:8]} A组={str(st0['objects']['A组']['uuid'])[:8]}")
    ok, why = box_matches(st0, "A组")
    chk("X-2b", "★ 不变量：A组的框 == 成员包围盒 + 固定边距", ok, why)
    ok, why = box_matches(st0, "B组")
    chk("X-2c", "★ 不变量：B组的框 == 成员包围盒 + 固定边距", ok, why)

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

        def drag(x0, y0, x1, y1, steps=12):
            page.mouse.move(x0, y0)
            page.mouse.down()
            for i in range(1, steps + 1):
                page.mouse.move(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps)
                page.wait_for_timeout(60)
            page.wait_for_timeout(300)
            page.mouse.up()
            page.wait_for_timeout(4500)

        ra = rect_of(lambda t: "A组" in t and "Section" in t)
        rb = rect_of(lambda t: "B组" in t and "Section" in t)
        chk("X-3", "画布上两张组合框都在", ra is not None and rb is not None,
            f"A {None if ra is None else {k: round(v) for k, v in ra.items()}}")
        if ra is None or rb is None:
            pw.close(); sys.exit(1)

        # ══ ① 拖 A 越过 B 的边界：B 的框必须纹丝不动，两边归属都不许变 ══
        print("\n── ① A 拖进 B 的区域，看 B 的框和两边的归属 ──")
        # ⚠️ 抓 A 的**成员**（不是标题条）—— 这才是用户实际的抓法：
        #    抓标题条时鼠标全程在 A 的框内，根本越不出去，测不出交叉。
        jia = rect_of(lambda t: "· 甲 ·" in t)
        drag(jia["x"] + jia["width"] / 2, jia["y"] + jia["height"] / 2,
             rb["x"] + rb["width"] / 2, rb["y"] + rb["height"] / 2)

        st1 = probe()
        b0 = {"x": st0["objects"]["B组"]["x"], "y": st0["objects"]["B组"]["y"],
              "w": st0["objects"]["B组"]["w"], "h": st0["objects"]["B组"]["h"]}
        b1 = {"x": st1["objects"]["B组"]["x"], "y": st1["objects"]["B组"]["y"],
              "w": st1["objects"]["B组"]["w"], "h": st1["objects"]["B组"]["h"]}
        chk("X-4", "★ 移动 A 之后 B 的框**一个数都没变**（用户报的第①条）",
            all(abs(b0[k] - b1[k]) < TOL for k in ("x", "y", "w", "h")), f"B组框 {b0} → {b1}")
        ok, why = box_matches(st1, "B组")
        chk("X-4b", "★ 而且 B 的框仍然 == B 成员的包围盒 + 边距（不变量本体）", ok, why)
        print(f"         归属：甲→{str(st1['objects']['甲']['parent'])[:8]}  乙→{str(st1['objects']['乙']['parent'])[:8]}"
              f"  （A组={str(st1['objects']['A组']['uuid'])[:8]}，B组={str(st1['objects']['B组']['uuid'])[:8]}）")
        chk("X-5", "★★ 交叉之后**成员没有被抢走**（甲、乙仍归 A组；丙、丁仍归 B组）",
            all(st1["objects"][k]["parent"] == st1["objects"][grp]["uuid"]
                for k, grp in (("甲", "A组"), ("乙", "A组"), ("丙", "B组"), ("丁", "B组"))),
            json.dumps({k: str(v["parent"])[:8] for k, v in st1["objects"].items() if k in ("甲", "乙", "丙", "丁")}, ensure_ascii=False))

        # ══ ② 把 A 拖回去：成员必须跟着框一起回来 ══
        print("\n── ② 把 A 拖回去（离开 B）──")
        ra2 = rect_of(lambda t: "A组" in t and "Section" in t)
        jia2 = rect_of(lambda t: "· 甲 ·" in t)
        drag(jia2["x"] + jia2["width"] / 2, jia2["y"] + jia2["height"] / 2,
             ra["x"] + 30, ra["y"] + ra["height"] / 2)

        st2 = probe()
        # ⚠️ 比的是"成员相对框的位置"有没有变，不是绝对坐标 —— 拖回去不必落回原位。
        def rel(state):
            return {k: (round(state["objects"][k]["x"] - state["objects"]["A组"]["x"], 1),
                        round(state["objects"][k]["y"] - state["objects"]["A组"]["y"], 1)) for k in ("甲", "乙")}
        # A 移动之后：成员与 A 框的相对关系必须还是"落在边距内"
        inside = True
        for k in ("甲", "乙"):
            m = st2["objects"][k]; s = st2["objects"]["A组"]
            if not (s["x"] <= m["x"] and m["x"] + m["w"] <= s["x"] + s["w"]
                    and s["y"] <= m["y"] and m["y"] + m["h"] <= s["y"] + s["h"]):
                inside = False
        chk("X-6", "★★ 成员**没有和框分离**（甲、乙都还落在 A 的框里）—— 用户报的第②条",
            inside, f"A框 {round(st2['objects']['A组']['x'])},{round(st2['objects']['A组']['y'])} "
                    f"{round(st2['objects']['A组']['w'])}x{round(st2['objects']['A组']['h'])}；"
                    f"甲 {round(st2['objects']['甲']['x'])},{round(st2['objects']['甲']['y'])}"
                    f" 乙 {round(st2['objects']['乙']['x'])},{round(st2['objects']['乙']['y'])}")
        ok, why = box_matches(st2, "A组")
        chk("X-6b", "★ 而且 A 的框仍然 == A 成员的包围盒 + 边距", ok, why)
        chk("X-7", "★★ 来回一趟之后归属一个都没变",
            all(st2["objects"][k]["parent"] == st2["objects"][grp]["uuid"]
                for k, grp in (("甲", "A组"), ("乙", "A组"), ("丙", "B组"), ("丁", "B组"))),
            json.dumps({k: str(v["parent"])[:8] for k, v in st2["objects"].items() if k in ("甲", "乙", "丙", "丁")}, ensure_ascii=False))

        # ══ ③ 组合边框：加粗 + 可抓区域变大 ══
        print("\n── ③ 组合边框的粗细与可抓区域 ──")
        stroke = page.evaluate("""() => {
          const el = document.querySelector('svg rect.dshw-pg-node[data-kind="Section"][data-border="solid"]')
          if (!el) return null
          const cs = getComputedStyle(el)
          return {stroke: cs.stroke, width: parseFloat(cs.strokeWidth)}
        }""")
        chk("X-8", "★ 组合边框线宽加粗了（原来 1.5）",
            stroke is not None and stroke["width"] >= 2.0,
            f"stroke-width = {None if stroke is None else stroke['width']}（{None if stroke is None else stroke['stroke']}）")

        # 可抓区域：把 B 往上拖 40px。抓点取"离上边框 6px"处 —— 加粗之前这里抓不到框。
        rb2 = rect_of(lambda t: "B组" in t and "Section" in t)
        st_before = probe()
        probe_x = rb2["x"] + rb2["width"] / 2
        probe_y = rb2["y"] + 6
        drag(probe_x, probe_y, probe_x, probe_y - 40)
        st_after = probe()
        dy = st_after["objects"]["B组"]["y"] - st_before["objects"]["B组"]["y"]
        chk("X-9", "★★ 在**离上边框 6px**处按住拖动，抓到的是组合本身（B 被拖动了）",
            abs(dy) > 15, f"B组 y {round(st_before['objects']['B组']['y'])} → {round(st_after['objects']['B组']['y'])}（Δ{round(dy)}）")
        chk("X-10", "★ 这一下没把 B 的成员甩出去（丙、丁仍归 B组）",
            all(st_after["objects"][k]["parent"] == st_after["objects"]["B组"]["uuid"] for k in ("丙", "丁")),
            json.dumps({k: str(v["parent"])[:8] for k, v in st_after["objects"].items() if k in ("丙", "丁")}, ensure_ascii=False))
        ok, why = box_matches(st_after, "B组")
        chk("X-10b", "★ B 被拖之后，框仍然 == 成员包围盒 + 边距", ok, why)

        chk("X-11", "整个过程没有页面报错", len(errs) == 0, " | ".join(errs)[:300])
        page.screenshot(path=os.path.join(os.path.expanduser("~"), "Desktop", "DSH", "ui-33-cross.png"))
        pw.close()
finally:
    removed = api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
    purged = purge_project_backups(PROJECT)
    print(f"\n清理：{'临时工程已删除' if removed.get('ok') else str(removed)[:130]}（另收 {purged} 个备份目录）")

print(f"\nPASS={passed} FAIL={failed}")
sys.exit(0 if failed == 0 else 1)
