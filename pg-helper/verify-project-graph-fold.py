"""工程图 · **折叠组合的连线重接**（实机核验）

用户 2026-10-09 定的规则：
  · 两端都在同一个折叠组里 ⇒ 整条在组内，**不画**
  · 一端在组内、一端在组外 ⇒ 画成「**组合 → 组外元素**」
  · 展开之后 ⇒ 回到原来的「成员 ↔ 组外元素」对应关系（文档里本来就没改过，所以是自动的）

所以这里盯三件事：折叠后**画了几条**、跨组那条**起点是不是贴到组合框上了**、展开后**是不是原样回来了**。
"""
import json
import os
import sys
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

from _suite_util import purge_project_backups

BASE = "http://127.0.0.1:3080"
PROJECT = "折叠连线自测临时工程"
SHOT = os.path.join(os.path.expanduser("~"), "Desktop", "DSH")
CENTER_TOL = 2.0   # 像素容差（画布是缩放过的，亚像素取整会有零点几的差）
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
    api("/workdesktop/api/pg/insert", {"project": PROJECT, "nodes": [
        {"text": "甲", "x": -200, "y": 0}, {"text": "乙", "x": 0, "y": 0}, {"text": "丙", "x": 500, "y": 0}]})
    objs = api("/workdesktop/api/pg/document?project=" + urllib.parse.quote(PROJECT))["objects"]
    uu = {o["text"]: o["uuid"] for o in objs if o.get("text") in ("甲", "乙", "丙")}
    # 组内一条（甲→乙）、跨组一条（甲→丙）
    api("/workdesktop/api/pg/connect", {"project": PROJECT, "source": uu["甲"], "target": uu["乙"]})
    api("/workdesktop/api/pg/connect", {"project": PROJECT, "source": uu["甲"], "target": uu["丙"]})
    grp = api("/workdesktop/api/pg/section", {"project": PROJECT, "create": {"text": "组", "children": [uu["甲"], uu["乙"]]}})
    chk("FOLD-1", "底图：组（甲+乙）+ 组外丙，两条线（组内一条、跨组一条）",
        grp.get("ok") is True, json.dumps(grp, ensure_ascii=False)[:120])

    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True)
        page = b.new_page(viewport={"width": 1600, "height": 1000})
        page.on("dialog", lambda d: d.dismiss())
        page.goto(f"{BASE}/?token={read_token()}", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(9000)
        for label in ["继续", "知道了", "关闭"]:
            try:
                btn = page.get_by_role("button", name=label)
                if btn.count() > 0:
                    btn.first.click(timeout=3000)
                    page.wait_for_timeout(1000)
                    break
            except Exception:
                pass
        for i in range(page.get_by_text("工程图", exact=True).count()):
            bb = page.get_by_text("工程图", exact=True).nth(i).bounding_box()
            if bb and bb["x"] < 260 and bb["y"] > 600:
                page.get_by_text("工程图", exact=True).nth(i).click()
                break
        page.wait_for_timeout(3500)
        page.select_option(".dshw-pg-bar select", PROJECT)
        page.wait_for_timeout(5000)

        def drawn_edges():
            lines = page.locator("svg line.dshw-pg-edge")
            out = []
            for i in range(lines.count()):
                bb = lines.nth(i).bounding_box()
                if bb:
                    out.append((round(bb["x"]), round(bb["y"]), round(bb["width"])))
            return out

        def sec_rect():
            wraps = page.locator("svg .dshw-pg-nodewrap")
            for i in range(wraps.count()):
                ts = wraps.nth(i).locator("title")
                txt = " | ".join((ts.nth(k).text_content() or "") for k in range(ts.count()))
                if "Section" in txt and "组" in txt:
                    return wraps.nth(i).locator("rect").first.bounding_box()
            return None

        e_open = drawn_edges()
        s_open = sec_rect()
        chk("FOLD-2", "展开状态：**两条线都画着**", len(e_open) == 2, f"画了 {len(e_open)} 条：{e_open}")

        # ── 折叠：**用鼠标点那个折叠按钮**（复现用户的操作，不走接口）────────
        #    按钮画在分区右上角：x + w - 13, y + 13（见 client.js 里的折叠把手）
        s_now = sec_rect()
        chk("FOLD-2b", "找到分区右上角的折叠按钮位置", s_now is not None,
            None if s_now is None else f"按钮 ≈ ({round(s_now['x']+s_now['width']-13)}, {round(s_now['y']+13)})")
        if s_now is not None:
            page.mouse.click(s_now["x"] + s_now["width"] - 13, s_now["y"] + 13)
            page.wait_for_timeout(6000)
        e_fold = drawn_edges()
        s_fold = sec_rect()
        chk("FOLD-3", "折叠之后**组内那条不画了**（两端都在组里）",
            len(e_fold) == 1, f"画了 {len(e_fold)} 条：{e_fold}")
        chk("FOLD-4", "★ 折叠之后组合框缩成标题条", s_fold is not None and s_open is not None and s_fold["height"] < s_open["height"] - 30,
            f"高 {None if s_open is None else round(s_open['height'])} -> {None if s_fold is None else round(s_fold['height'])}")
        if len(e_fold) == 1 and s_fold is not None:
            # 跨组那条的起点应当贴着**组合框**，而不是原来甲的位置
            ex, ey, ew = e_fold[0]
            near_left = abs(ex - s_fold["x"]) < 60 or abs(ex - (s_fold["x"] + s_fold["width"])) < 60
            chk("FOLD-5", "★★★ 跨组那条线**改从组合框出发**（不再从组内成员的旧位置出发）",
                near_left, f"线起点 x={ex}，组合框 [{round(s_fold['x'])}, {round(s_fold['x']+s_fold['width'])}]")

        # ── 展开：**再点一次那个按钮**（跟用户一样走面板自己的路）──────────
        #    ⚠️ 别走接口：面板不会为"外部改的"自动刷新（这是另一件事），
        #       走接口量到的会是"没刷新"，而不是"展开对不对"。
        s_fold2 = sec_rect()
        if s_fold2 is not None:
            page.mouse.click(s_fold2["x"] + s_fold2["width"] - 13, s_fold2["y"] + 13)
            page.wait_for_timeout(6000)
        e_back = drawn_edges()
        chk("FOLD-6", "★★★ 展开之后**两条线原样回来**（对应关系没被破坏）",
            len(e_back) == 2, f"画了 {len(e_back)} 条：{e_back}")
        objs2 = api("/workdesktop/api/pg/document?project=" + urllib.parse.quote(PROJECT))["objects"]
        edges2 = [o for o in objs2 if o.get("type") == "LineEdge"]
        chk("FOLD-7", "★★★ 而且**文档里的端点一个都没被改过**（重接只是画法）",
            len(edges2) == 2, f"文档里 {len(edges2)} 条线")

        # ══ FOLD-20 起：折叠框**以组合中心为中心**（用户 2026-10-10 裁定）══════════
        #   用户原话："工程图的组合-折叠应该是以组合中心为中心，而不是左上角为中心"。
        #   上游依据：`Section.tsx` 第 54-63 行 `collapsedCollisionBox()` ——
        #   `centerLocation = _collisionBoxNormal.getRectangle().center`，小矩形放到 center - size/2。
        #   ⚠️ 比的是**中心**，不是左上角：框变小了，左上角本来就该动；中心不该动。
        #   配一条负向对照（FOLD-22）：旧的"钉左上角"写法会让左上角**一动不动** —— 那种情形要判红。
        def _ctr(r):
            return (r["x"] + r["width"] / 2, r["y"] + r["height"] / 2)

        # 量中心的基准：刚才那一轮**展开之后**的框（`s_open` 是折叠前量的，用最新的更稳）
        s_back = sec_rect()
        chk("FOLD-20", "回到展开态（作为量中心的基准）", s_back is not None,
            None if s_back is None else f"展开框 {round(s_back['width'])}×{round(s_back['height'])}")
        if s_back is not None:
            # 再折一次，这次量中心
            tog = page.locator("svg .dshw-pg-collapse")
            if tog.count() > 0:
                # ⚠️ 直接点**元素**，不按 "x + w - 13" 猜坐标：框一折叠高度就变，
                #    猜出来的那个点会落到框外（本轮实测踩到，表现为"点了没反应"）。
                tog.first.hover()
                page.wait_for_timeout(300)
                tog.first.dispatch_event("mousedown", {"button": 0, "bubbles": True})
                page.wait_for_timeout(6000)
            s_c = sec_rect()
            chk("FOLD-21", "★ 折叠框中心 == 展开框中心（用户要的就是这条）",
                s_c is not None and abs(_ctr(s_c)[0] - _ctr(s_back)[0]) <= CENTER_TOL
                and abs(_ctr(s_c)[1] - _ctr(s_back)[1]) <= CENTER_TOL,
                None if s_c is None else
                f"原中心 ({_ctr(s_back)[0]:.0f}, {_ctr(s_back)[1]:.0f}) → "
                f"折叠中心 ({_ctr(s_c)[0]:.0f}, {_ctr(s_c)[1]:.0f})")
            chk("FOLD-22", "★ 负向对照：旧写法（钉左上角）会让左上角一动不动 —— 本次必须**不是**那样",
                s_c is not None and not (abs(s_c["x"] - s_back["x"]) <= CENTER_TOL
                                         and abs(s_c["y"] - s_back["y"]) <= CENTER_TOL),
                None if s_c is None else
                f"折叠框左上角 ({s_c['x']:.0f}, {s_c['y']:.0f}) vs 原框 ({s_back['x']:.0f}, {s_back['y']:.0f})")

        page.screenshot(path=os.path.join(SHOT, "ui-31-fold.png"))
        b.close()
finally:
    removed = api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
    # 备份目录一起收干净：delete 只删 .prg，snapshots/versions 里的备份要另外收（见 _suite_util.py）
    purged = purge_project_backups(PROJECT)
    print(f"\n清理：{'临时工程已删除' if removed.get('ok') else str(removed)[:130]}")

print(f"\nPASS={passed} FAIL={failed}")
sys.exit(0 if failed == 0 else 1)
