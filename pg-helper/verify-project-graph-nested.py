# -*- coding: utf-8 -*-
"""嵌套组合：A ⊂ B ⊂ C —— 量「谁还能折叠」和「成员有没有和组合分家」。

用户 2026-10-10 报：
  ① 只有最外层的 C 能折叠，A 和 B 折不了；
  ② A、B 的成员与组合本身分离了。

做法：按用户描述的顺序建 A → B（把 A 装进去）→ C（把 B 装进去），
每一步都 dump **文档里的归谁** + **画布上看得见哪些**，然后逐个点它们的折叠把手。
"""
import json
import os
import sys
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

from _suite_util import purge_project_backups

BASE = "http://127.0.0.1:3080"
PROJECT = "嵌套组合自测临时工程"
HERE = os.path.dirname(os.path.abspath(__file__))
NODE = os.path.join(os.path.expanduser("~"), "AppData", "Local", "nvm", "v24.20.0", "node.exe")
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
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=data, method="GET" if body is None else "POST")
    if body is not None:
        req.add_header("content-type", "application/json")
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode())


def read_token():
    log = os.path.join(os.path.expanduser("~"), ".dsh", "daemon", "dsh.log")
    with open(log, encoding="utf-8", errors="ignore") as fh:
        hits = [ln for ln in fh if "dsh web: http" in ln]
    return hits[-1].split("token=")[1].strip() if hits else ""


import subprocess  # noqa: E402


def probe():
    out = subprocess.run([NODE, os.path.join(HERE, "pg-probe.mjs"), PROJECT],
                         capture_output=True, text=True, encoding="utf-8", timeout=120)
    line = (out.stdout or "").strip().splitlines()
    return json.loads(line[-1]) if line else {"ok": False}


def tree(st):
    """把归属关系打成人看得懂的一行。"""
    if not st.get("ok"):
        return st.get("error", "?")
    secs = {k: v for k, v in st["objects"].items() if v["type"] == "Section"}
    name_of = {v["uuid"]: k for k, v in st["objects"].items()}
    out = []
    for k, v in sorted(secs.items()):
        kids = [n for n, x in st["objects"].items() if x["parent"] == v["uuid"]]
        out.append(f"{k}(collapsed={v['collapsed']}) ← {kids}")
    return " | ".join(out)


api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
api("/workdesktop/api/pg/project", {"action": "create", "name": PROJECT})

try:
    # A 装两个成员；另外留两个"别的成员"给 B、C 用
    api("/workdesktop/api/pg/insert", {"project": PROJECT, "nodes": [
        {"text": "a1", "x": -700, "y": 0}, {"text": "a2", "x": -500, "y": 0},
        {"text": "b1", "x": -200, "y": 0},
        {"text": "c1", "x": 300, "y": 0}]})
    objs = probe()["objects"]
    U = {k: v["uuid"] for k, v in objs.items() if k in ("a1", "a2", "b1", "c1")}

    rA = api("/workdesktop/api/pg/section", {"project": PROJECT, "create": {"text": "A", "children": [U["a1"], U["a2"]]}})
    chk("NST-1", "建 A（装 a1、a2）", rA.get("ok") is True, json.dumps(rA, ensure_ascii=False)[:150])
    stA = probe()
    chk("NST-1b", "A 的成员归 A", stA["objects"]["a1"]["parent"] == stA["objects"]["A"]["uuid"],
        tree(stA))

    rB = api("/workdesktop/api/pg/section", {"project": PROJECT, "create": {"text": "B", "children": [stA["objects"]["A"]["uuid"], U["b1"]]}})
    chk("NST-2", "建 B（把 **A** 和 b1 装进去）", rB.get("ok") is True, json.dumps(rB, ensure_ascii=False)[:200])
    stB = probe()
    chk("NST-2b", "★★ A 仍然是 A（两个成员没被摘走）",
        stB["objects"]["a1"]["parent"] == stB["objects"]["A"]["uuid"]
        and stB["objects"]["a2"]["parent"] == stB["objects"]["A"]["uuid"],
        f"a1→{str(stB['objects']['a1']['parent'])[:8]} a2→{str(stB['objects']['a2']['parent'])[:8]} A={str(stB['objects']['A']['uuid'])[:8]}")
    chk("NST-2c", "★ A 归 B（嵌套成立）", stB["objects"]["A"]["parent"] == stB["objects"]["B"]["uuid"],
        tree(stB))

    rC = api("/workdesktop/api/pg/section", {"project": PROJECT, "create": {"text": "C", "children": [stB["objects"]["B"]["uuid"], U["c1"]]}})
    chk("NST-3", "建 C（把 **B** 和 c1 装进去）", rC.get("ok") is True, json.dumps(rC, ensure_ascii=False)[:200])
    stC = probe()
    chk("NST-3b", "★★ B 归 C（三层嵌套成立）", stC["objects"]["B"]["parent"] == stC["objects"]["C"]["uuid"],
        tree(stC))
    chk("NST-3c", "★★ A 仍然归 B、a1/a2 仍然归 A（一层都没散）",
        stC["objects"]["A"]["parent"] == stC["objects"]["B"]["uuid"]
        and stC["objects"]["a1"]["parent"] == stC["objects"]["A"]["uuid"],
        tree(stC))

    # ── 画布上：三个把手在不在？逐个点 ────────────────────────────────
    with sync_playwright() as p:
        pw = p.chromium.launch(channel="chrome", headless=True)
        page = pw.new_page(viewport={"width": 1600, "height": 1000})
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)[:250]))
        page.goto(f"{BASE}/?token={read_token()}", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(9000)
        page.click('button[data-dshw-panel="dsh-workdesktop:project-graph"]')
        page.wait_for_timeout(4000)
        page.select_option(".dshw-pg-bar select", PROJECT)
        page.wait_for_timeout(5000)

        def secs_on_canvas():
            out = []
            wraps = page.locator("svg .dshw-pg-nodewrap")
            for i in range(wraps.count()):
                ts = wraps.nth(i).locator("title")
                txt = " | ".join((ts.nth(k).text_content() or "") for k in range(ts.count()))
                if "Section" in txt:
                    bb = wraps.nth(i).locator("rect").first.bounding_box()
                    name = next((n for n in ("A", "B", "C") if f"· {n} ·" in txt), "?")
                    out.append((name, bb))
            return out

        def toggle_of(name):
            """按**组合名**找它的折叠把手 —— 每次都重新找。

            ⚠️ 2026-10-10：第一版把 nodewrap 的**下标**存下来给第二次点用，那是错的 ——
            每折叠/展开一次画布就重排，下标会失效，于是"点 C 的把手"点了个空
            （实测：C.collapsed 一直是 False，看着像功能坏，其实是测试拿了过期下标）。
            """
            wraps = page.locator("svg .dshw-pg-nodewrap")
            for i in range(wraps.count()):
                ts = wraps.nth(i).locator("title")
                txt = " | ".join((ts.nth(k).text_content() or "") for k in range(ts.count()))
                if "Section" in txt and f"· {name} ·" in txt:
                    return wraps.nth(i).locator(".dshw-pg-collapse")
            return None

        chk("NST-4", "画布上三个组合都在（展开态）", len(secs_on_canvas()) == 3,
            json.dumps([(n, None if b is None else (round(b['x']), round(b['y']), round(b['width']), round(b['height'])))
                        for n, b in secs_on_canvas()], ensure_ascii=False))
        # 逐个点把手：折叠 → 看文档里的 collapsed 变了没
        for name in ("A", "B", "C"):
            tog = toggle_of(name)
            has = tog is not None and tog.count() > 0
            chk(f"NST-fold-{name}", f"**{name}** 的折叠把手存在（能点）", has,
                "画布上找不到它的把手" if not has else f"把手数={tog.count()}")
            if not has:
                continue
            tog.first.hover()
            page.wait_for_timeout(200)
            tog.first.dispatch_event("mousedown", {"button": 0, "bubbles": True})
            page.wait_for_timeout(3500)
            st = probe()
            chk(f"NST-folded-{name}", f"★ 点完之后文档里 **{name}.collapsed == True**",
                st["objects"][name]["collapsed"] is True,
                f"{name}.collapsed={st['objects'][name]['collapsed']}；{tree(st)}")
            # 展开回去，免得影响下一个（同样**重新找**把手）
            tog2 = toggle_of(name)
            if tog2 is not None and tog2.count() > 0:
                tog2.first.hover()
                page.wait_for_timeout(200)
                tog2.first.dispatch_event("mousedown", {"button": 0, "bubbles": True})
                page.wait_for_timeout(3000)
                st2 = probe()
                chk(f"NST-unfolded-{name}", f"★ {name} 能再展开回来（来回都行）",
                    st2["objects"][name]["collapsed"] is False,
                    f"{name}.collapsed={st2['objects'][name]['collapsed']}")

        # ── 折外层之后，里面还看得见吗（嵌套的正确表现：一起收起来）──────
        togC = toggle_of("C")
        if togC is not None and togC.count() > 0:
            togC.first.hover()
            page.wait_for_timeout(200)
            togC.first.dispatch_event("mousedown", {"button": 0, "bubbles": True})
            page.wait_for_timeout(3500)
            stC2 = probe()
            chk("NST-5", "★ 折 C 之后文档里 C.collapsed=True", stC2["objects"]["C"]["collapsed"] is True,
                f"C.collapsed={stC2['objects']['C']['collapsed']}")
            on_canvas = [n for n, _ in secs_on_canvas()]
            chk("NST-5b", "★★ 折 C 时，**A 和 B 也跟着收起来**（嵌套该有的样子）",
                "A" not in on_canvas and "B" not in on_canvas,
                f"画布上还剩的组合：{on_canvas}")
            # 展开回来
            togC2 = toggle_of("C")
            if togC2 is not None and togC2.count() > 0:
                togC2.first.hover()
                page.wait_for_timeout(200)
                togC2.first.dispatch_event("mousedown", {"button": 0, "bubbles": True})
                page.wait_for_timeout(3500)
                back = [n for n, _ in secs_on_canvas()]
                chk("NST-5c", "★★ 再展开，**A 和 B 原样回来**", "A" in back and "B" in back,
                    f"画布上的组合：{back}")

        chk("NST-9", "整个过程没有页面报错", len(errs) == 0, " | ".join(errs)[:300])
        pw.close()
finally:
    removed = api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
    purged = purge_project_backups(PROJECT)
    print(f"\n清理：{'临时工程已删除' if removed.get('ok') else str(removed)[:130]}（另收 {purged} 个备份目录）")

print(f"\nPASS={passed} FAIL={failed}")
sys.exit(0 if failed == 0 else 1)
