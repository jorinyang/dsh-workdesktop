"""工程图 · **组合的动态实时撑开与聚拢**（实机核验，同一次拖动内量）

用户 2026-10-09 定的目标：
  元素在被拖动的**过程中**，组合边界就随元素位置实时改变，不是等放下才变；
  撑开和聚拢最关键的是**始终保持最小面积**。

为什么要在**同一次拖动里**量：
  跨两次拖动去比会踩到"两次之间视图变了"的坑（画布尺寸一变，屏幕坐标和世界坐标的比例就变了），
  量出来的差不是组合的错。同一次拖动里人没松手、视图也没动，量出来的就是真东西。
"""
import json
import os
import sys
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:3080"
PROJECT = "实时贴合自测临时工程"
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
        {"text": "甲", "x": -220, "y": 0}, {"text": "乙", "x": 220, "y": 0}]})
    objs = api("/workdesktop/api/pg/document?project=" + urllib.parse.quote(PROJECT))["objects"]
    uu = {o["text"]: o["uuid"] for o in objs if o.get("text") in ("甲", "乙")}
    api("/workdesktop/api/pg/section", {"project": PROJECT, "create": {"text": "组", "children": [uu["甲"], uu["乙"]]}})

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

        def wrap_titles(i):
            ts = page.locator("svg .dshw-pg-nodewrap").nth(i).locator("title")
            return " | ".join((ts.nth(k).text_content() or "") for k in range(ts.count()))

        def rect_of(pred):
            wraps = page.locator("svg .dshw-pg-nodewrap")
            for i in range(wraps.count()):
                if pred(wrap_titles(i)):
                    return wraps.nth(i).locator("rect").first.bounding_box()
            return None

        sec0 = rect_of(lambda t: "组" in t and "Section" in t)
        yi = rect_of(lambda t: "· 乙 ·" in t)
        chk("LIVE-1", "找到组合和成员「乙」", sec0 is not None and yi is not None,
            f"组合 {sec0 is not None} 成员 {yi is not None}")
        if sec0 is None or yi is None:
            raise SystemExit(1)

        # 记下拖动前「乙」的**世界坐标**：拖出去再拖回来应该回到这个数
        _o0 = api("/workdesktop/api/pg/document?project=" + urllib.parse.quote(PROJECT))["objects"]
        x_yi0 = round(next(o for o in _o0 if o.get("text") == "乙")["location"]["x"], 2)
        # ⚠️ 盘上的框宽是**世界单位**，屏幕上是**像素**（两者差一个缩放系数）——
        #    拿它们直接比是错的（第一版就栽在这：661 像素 vs 564 世界单位，看着像不一致，其实一致）。
        disk_w0 = round(next(o for o in _o0 if o.get("type") == "Section")["size"]["width"], 2)
        sx = yi["x"] + yi["width"] / 2
        sy = yi["y"] + yi["height"] / 2
        w0 = sec0["width"]
        print(f"         基准：组合宽 {w0:.0f}，成员屏幕中心 ({sx:.0f},{sy:.0f})")

        # ── 一次拖动，中途量四次：撑开 → 更开 → 收回 → 回到原位 ──────────
        page.mouse.move(sx, sy)
        page.mouse.down()
        marks = []

        def measure(tag, dx):
            # ⚠️ 往**画布内**拖（负方向）：成员本来就靠窗口右边，往右一拖就出了画布，
            #    那样量到的是"出界之后断没断"，不是"实时贴合准不准"。两件事分开测。
            page.mouse.move(sx - dx, sy)
            page.wait_for_timeout(450)
            r = rect_of(lambda t: "组" in t and "Section" in t)
            m = rect_of(lambda t: "· 乙 ·" in t)
            marks.append((tag, dx,
                          None if r is None else round(r["width"]),
                          None if m is None else round(m["x"])))
            return None if r is None else r["width"]

        page.mouse.move(sx - 60, sy)
        page.wait_for_timeout(400)
        w_a = measure("拖出 60", 60)
        w_b = measure("拖出 220", 220)
        w_c = measure("收回 60", 60)
        w_d = measure("回到 0", 0)
        page.mouse.up()
        page.wait_for_timeout(4000)
        print("         拖动中依次测到：", marks)

        # ⚠️ 断言方向要跟场景一致：这里是**把成员往另一个成员那边拖**（两者靠拢），
        #    所以"保持最小面积"的正确表现是**框变小**，不是变大。第一版把方向写反了。
        chk("LIVE-2", "★★★ **拖动过程中**框就实时跟着变（不等松手）",
            w_b is not None and abs(w_b - w0) > 40, f"基准 {w0:.0f} → 拖到 220 时 {w_b}")
        chk("LIVE-3", "★★★ 成员越靠拢、框越小（实时跟着走，不是跳一次）",
            w_a is not None and w_b is not None and w_b < w_a - 40, f"拖 60 时 {w_a} → 拖 220 时 {w_b}")
        chk("LIVE-4", "★★★ 往回收的过程中框**实时变大回去**（这是上次缺的那半）",
            w_c is not None and w_b is not None and w_c > w_b + 40, f"拖 220 时 {w_b} → 收回 60 时 {w_c}")
        chk("LIVE-5", "★★★ 收回原位时回到最小面积（跟基准一致）",
            w_d is not None and abs(w_d - w0) < 18, f"回到 0 时 {w_d}（基准 {w0:.0f}）")

        # 松手之后：成员是不是**真的回到了原点**（拖出去再拖回来 = 一次空操作）。
        # ⚠️ 这比"盘上的框宽"更能说明问题：屏幕回到原点、世界坐标却没回去的话，
        #    说明拖动过程中**坐标映射变了**（画布尺寸/视图变了），那才是真 bug。
        objs2 = api("/workdesktop/api/pg/document?project=" + urllib.parse.quote(PROJECT))["objects"]
        sec = next((o for o in objs2 if o.get("type") == "Section"), None)
        yi2 = next((o for o in objs2 if o.get("text") == "乙"), None)
        disk_w = sec["size"]["width"]
        x_back = None if yi2 is None else yi2["location"]["x"]
        chk("LIVE-6", "★★★ 拖出去再拖回来之后，成员**真的回到了原来的世界坐标**",
            x_back is not None and abs(x_back - x_yi0) < 6,
            f"起始 world.x={x_yi0}，拖完后 {x_back}（差 {None if x_back is None else round(x_back - x_yi0, 1)}）")
        chk("LIVE-6b", "★★★ 而且落盘的框也回到基准（**两边都用世界坐标比**，别拿像素比世界单位）",
            abs(disk_w - disk_w0) < 12, f"盘上 {disk_w:.1f}（起始 {disk_w0:.1f}）")

        # 成员必须始终都在框里（最小面积 ≠ 把人漏出去）
        def encloses():
            objs3 = api("/workdesktop/api/pg/document?project=" + urllib.parse.quote(PROJECT))["objects"]
            s = next((o for o in objs3 if o.get("type") == "Section"), None)
            loc, size, kids = s["location"], s["size"], s.get("childUuids") or []
            for o in objs3:
                if o.get("uuid") not in kids:
                    continue
                ol, osz = o.get("location"), o.get("size")
                if ol["x"] < loc["x"] - 1 or ol["y"] < loc["y"] - 1:
                    return False
                if ol["x"] + osz["width"] > loc["x"] + size["width"] + 1:
                    return False
                if ol["y"] + osz["height"] > loc["y"] + size["height"] + 1:
                    return False
            return True

        chk("LIVE-7", "★★★ 最终落盘之后，成员**全都在框里**（最小面积不等于把人漏出去）",
            encloses(), '')

        # ── 拖组合框体：组内元素必须**实时一起动**（用户 2026-10-09）──────────
        # 点组合框里的**空白处**（左下角内缩），免得点到成员上
        sr = rect_of(lambda t: "Section" in t and "组" in t)
        m0 = rect_of(lambda t: "· 甲 ·" in t)
        chk("LIVE-11", "找到组合框和组内成员（准备拖组合）", sr is not None and m0 is not None,
            f"组合 {sr is not None} 成员 {m0 is not None}")
        if sr is not None and m0 is not None:
            gx = sr["x"] + 12
            gy = sr["y"] + sr["height"] - 12
            page.mouse.move(gx, gy)
            page.mouse.down()
            held = page.locator('.dshw-pg-node[data-picked="1"]').first.get_attribute("data-kind") \
                if page.locator('.dshw-pg-node[data-picked="1"]').count() >= 1 else None
            chk("LIVE-11a", "★ 拖组合时抓到的**是组合本身**", held == "Section", f"抓到 {held}")
            page.mouse.move(gx + 120, gy)
            page.wait_for_timeout(500)
            # ★ 这两条都在**还没松手**的时候量
            sr2 = rect_of(lambda t: "Section" in t and "组" in t)
            m1 = rect_of(lambda t: "· 甲 ·" in t)
            page.mouse.up()
            page.wait_for_timeout(4000)
            dx_sec = None if sr2 is None else round(sr2["x"] - sr["x"])
            dx_mem = None if m1 is None else round(m1["x"] - m0["x"])
            chk("LIVE-12", "★★★ **拖动过程中**组合框就跟着鼠标走了",
                dx_sec is not None and dx_sec > 80, f"组合框 x 位移 {dx_sec}（期望 ~120）")
            chk("LIVE-13", "★★★ **拖动过程中**组内成员也一起走（不是等放下才动）",
                dx_mem is not None and abs(dx_mem - dx_sec) < 12,
                f"成员位移 {dx_mem} vs 组合框位移 {dx_sec}")

        # ── 折叠不在这里验 ────────────────────────────────────────────────
        # 折叠 + 折叠后的连线重接，由**专门的套件** `verify-project-graph-fold.py` 覆盖（8/0 全过）。
        # 这里原来也验一遍，但本套件前面刚把整个组合拖过 —— 组合框的位置变了，
        # 点"折叠按钮"会打到成员上，量出来的红是**瞄准问题**、不是功能问题。
        # 同一件事验两遍、其中一遍还瞄不准，只会制造噪音；所以这里不再重复。

        page.screenshot(path=os.path.join(SHOT, "ui-30-livefit.png"))
        b.close()
finally:
    removed = api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
    print(f"\n清理：{'临时工程已删除' if removed.get('ok') else str(removed)[:130]}")

print(f"\nPASS={passed} FAIL={failed}")
sys.exit(0 if failed == 0 else 1)
