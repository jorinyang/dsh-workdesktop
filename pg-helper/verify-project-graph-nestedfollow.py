# -*- coding: utf-8 -*-
"""嵌套组合的**逐层实时跟随**（实机核验）—— 用户 2026-10-10 裁定：

> 「A 嵌入 B 作为 B 的成员，B 嵌入 C 作为 C 的成员，那么 A 就要被视为与 B 一体，
>   也是 C 的成员；移动 A 时 B 的边界应当根据 A 的位置扩展/缩进；
>   扩展/缩进如果影响到 C 的边界，C 的边界也应当扩展/缩进。」

所以本套件盯的是**同一次按住不放的拖动里**：
  ① 拖 A ⇒ **B 与 C 的框都实时变**（不是只有直接父级 B 变、C 等松手才跳）；
  ② 收回去 ⇒ B、C 都**实时收回来**（两个方向都要跟）；
  ③ 落盘之后再量一次：盘上的 B、C 与"A 在哪儿"仍然对得上（不是只有画面动）。

参照物：用户工程里的 存储器(C) / 资产(B) / 工具组合(A) 就是这个形状。
"""
import json
import os
import sys
import subprocess
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

from _suite_util import purge_project_backups

BASE = "http://127.0.0.1:3080"
PROJECT = "嵌套跟随自测临时工程"
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
        return json.loads(r.read().decode("utf-8"))


def read_token():
    log = os.path.join(os.path.expanduser("~"), ".dsh", "daemon", "dsh.log")
    with open(log, encoding="utf-8", errors="ignore") as fh:
        hits = [ln for ln in fh if "dsh web: http" in ln]
    return hits[-1].split("token=")[1].strip() if hits else ""


def probe():
    out = subprocess.run([NODE, os.path.join(HERE, "pg-probe.mjs"), PROJECT],
                         capture_output=True, text=True, encoding="utf-8", timeout=120)
    line = (out.stdout or "").strip().splitlines()
    return json.loads(line[-1]) if line else {"ok": False}


api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
api("/workdesktop/api/pg/project", {"action": "create", "name": PROJECT})

try:
    # A{a1,a2} ⊂ B{A,b1} ⊂ C{B,c1}
    api("/workdesktop/api/pg/insert", {"project": PROJECT, "nodes": [
        {"text": "a1", "x": -700, "y": 0}, {"text": "a2", "x": -520, "y": 0},
        {"text": "b1", "x": -260, "y": 0}, {"text": "c1", "x": 120, "y": 0}]})
    st = probe()
    U = {k: v["uuid"] for k, v in st["objects"].items() if k in ("a1", "a2", "b1", "c1")}
    rA = api("/workdesktop/api/pg/section", {"project": PROJECT, "create": {"text": "A", "children": [U["a1"], U["a2"]]}})
    st = probe()
    A = st["objects"]["A"]["uuid"]
    rB = api("/workdesktop/api/pg/section", {"project": PROJECT, "create": {"text": "B", "children": [A, U["b1"]]}})
    st = probe()
    B = st["objects"]["B"]["uuid"]
    rC = api("/workdesktop/api/pg/section", {"project": PROJECT, "create": {"text": "C", "children": [B, U["c1"]]}})
    chk("NF-1", "三层底图：A{a1,a2} ⊂ B{A,b1} ⊂ C{B,c1}",
        rA.get("ok") and rB.get("ok") and rC.get("ok"),
        json.dumps({"A": rA.get("ok"), "B": rB.get("ok"), "C": rC.get("ok")}))

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

        def boxes():
            # ⚠️ 不用正则：分区那个 nodewrap 里有**两个 title**（第一个是折叠开关的提示），
            #    对整个 textContent 做匹配容易踩坑。改成"把每个 title 拆开、逐个精确比名字"。
            return page.evaluate("""() => {
              const out = {}
              document.querySelectorAll('svg .dshw-pg-nodewrap').forEach(w => {
                const rect = w.querySelector('rect')
                if (!rect || rect.getAttribute('data-kind') !== 'Section') return
                const parts = []
                w.querySelectorAll('title').forEach(t => {
                  String(t.textContent || '').split('·').forEach(s => parts.push(s.trim()))
                })
                for (const name of ['A', 'B', 'C']) {
                  if (parts.indexOf(name) >= 0) {
                    const r = rect.getBoundingClientRect()
                    out[name] = {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}
                  }
                }
              })
              return out
            }""")

        def a1_box():
            return page.evaluate("""() => {
              const wraps = Array.from(document.querySelectorAll('svg .dshw-pg-nodewrap'))
              for (const w of wraps) {
                const rect = w.querySelector('rect')
                if (!rect || rect.getAttribute('data-kind') !== 'TextNode') continue
                const parts = []
                w.querySelectorAll('title').forEach(t => {
                  String(t.textContent || '').split('·').forEach(s => parts.push(s.trim()))
                })
                if (parts.indexOf('a1') < 0) continue
                const r = rect.getBoundingClientRect()
                return {x: r.x + r.width / 2, y: r.y + r.height / 2}
              }
              return null
            }""")

        b0 = boxes()
        chk("NF-2", "画布上 A / B / C 三层都在", all(k in b0 for k in "ABC"),
            json.dumps(b0, ensure_ascii=False))
        c0 = a1_box()
        chk("NF-2b", "找得到 a1（要拖它）", c0 is not None, json.dumps(c0))

        # ── 同一次按住不放：把 a1 往左拖 260，中途量三层 ──────────────
        page.mouse.move(c0["x"], c0["y"])
        page.mouse.down()
        marks = []

        def measure(tag, dx):
            page.mouse.move(c0["x"] - dx, c0["y"])
            page.wait_for_timeout(500)
            bb = boxes()
            marks.append((tag, bb))
            return bb

        m1 = measure("拖 120", 120)
        m2 = measure("拖 260", 260)
        m3 = measure("收回 120", 120)
        m4 = measure("回到 0", 0)
        page.mouse.up()
        page.wait_for_timeout(4500)

        def d(bb, k):
            if k not in bb or k not in b0:
                return None
            return (bb[k]["x"] - b0[k]["x"], bb[k]["w"] - b0[k]["w"])

        print("         同一次拖动里量到的位移（x / 宽变化）：")
        for tag, bb in marks:
            print(f"           {tag:<8} A {d(bb, 'A')}  B {d(bb, 'B')}  C {d(bb, 'C')}")

        # ① 拖动中 B 与 C **都**要实时变（这就是用户要的"逐层跟随"）
        bA, bB, bC = d(m2, "A"), d(m2, "B"), d(m2, "C")
        chk("NF-3", "★★ 拖 A 时 **B 的框实时变宽**（直接父级跟随）",
            bB is not None and abs(bB[1]) > 60, f"B 宽变化 {None if bB is None else bB[1]}")
        chk("NF-4", "★★★ 拖 A 时 **C 的框也实时变宽**（祖父级也要跟，用户 2026-10-10 报的就是这条）",
            bC is not None and abs(bC[1]) > 60, f"C 宽变化 {None if bC is None else bC[1]}")
        chk("NF-4b", "★ 而且 C 的位移与 B 方向一致、量级相当（不是乱跳）",
            bB is not None and bC is not None and bB[1] * bC[1] > 0 and abs(abs(bC[1]) - abs(bB[1])) < 40,
            f"B {bB} vs C {bC}")

        # ② 收回去的时候也要实时收（两个方向都跟）
        c_back = d(m3, "C")
        chk("NF-5", "★★ 往回收时 **C 也实时缩回去**（不是只跟「撑开」那一下）",
            bC is not None and c_back is not None and abs(c_back[1]) < abs(bC[1]) - 40,
            f"拖 260 时 C 宽变化 {bC[1]} → 收回 120 时 {c_back[1]}")

        # ③ 落盘之后盘上的框也要对得上（不是只有画面动）
        st2 = probe()
        def want_box(sec_text):
            kids = [n for n, v in st2["objects"].items() if v["parent"] == st2["objects"][sec_text]["uuid"]]
            if not kids:
                return None
            xs = [st2["objects"][k]["x"] for k in kids]
            ys = [st2["objects"][k]["y"] for k in kids]
            x1 = [st2["objects"][k]["x"] + st2["objects"][k]["w"] for k in kids]
            y1 = [st2["objects"][k]["y"] + st2["objects"][k]["h"] for k in kids]
            return {"w": max(x1) - min(xs) + 48, "h": max(y1) - min(ys) + 48 + 44}

        okB = okC = True
        detail = []
        for name in ("B", "C"):
            wb = want_box(name)
            got = st2["objects"][name]
            if wb is None:
                okB = okC = False
                detail.append(name + " 没有成员")
                continue
            dw = abs(got["w"] - wb["w"]); dh = abs(got["h"] - wb["h"])
            detail.append(f"{name}: 盘上 {round(got['w'])}x{round(got['h'])} vs 期望 {round(wb['w'])}x{round(wb['h'])}")
            if dw > 12 or dh > 12:
                okB = okC = False
        chk("NF-6", "★★ 落盘之后，B 与 C 的框都 == 「成员包围盒 + 边距」（画面收了、盘上也收了）",
            okB and okC, "；".join(detail))

        chk("NF-7", "整个过程没有页面报错", len(errs) == 0, " | ".join(errs)[:250])
        page.screenshot(path=os.path.join(os.path.expanduser("~"), "Desktop", "DSH", "ui-38-nested-follow.png"))
        pw.close()
finally:
    removed = api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
    purged = purge_project_backups(PROJECT)
    print(f"\n清理：{'临时工程已删除' if removed.get('ok') else str(removed)[:130]}（另收 {purged} 个备份目录）")

print(f"\nPASS={passed} FAIL={failed}")
sys.exit(0 if failed == 0 else 1)
