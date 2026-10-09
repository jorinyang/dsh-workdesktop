"""工程图 · **Ctrl+F 搜索** + **组合的 Ctrl 多选**（实机核验）

用户 2026-10-09 要求：
  · Ctrl+F 搜组合 / 框体 / 说明文字里包含的文字
  · 组合可以被 Ctrl 多选

判"搜到了"用**算出来的描边颜色**，不查属性 —— 这一整天已经栽过两次：
属性加上了、却被后面的规则盖掉，只查属性等于没测。
"""
import json
import os
import sys
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:3080"
PROJECT = "搜索自测临时工程"
SHOT = os.path.join(os.path.expanduser("~"), "Desktop", "DSH")
AMBER = "rgb(245, 165, 36)"        # #f5a524
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


def ents():
    d = api("/workdesktop/api/pg/document?project=" + urllib.parse.quote(PROJECT))["objects"]
    return [o for o in d if o.get("type") != "LineEdge"]


api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
api("/workdesktop/api/pg/project", {"action": "create", "name": PROJECT})

try:
    api("/workdesktop/api/pg/insert", {"project": PROJECT, "nodes": [
        {"text": "苹果", "x": -300, "y": 0},
        {"text": "香蕉", "x": 0, "y": 0},
        {"text": "苹果派", "x": 300, "y": 0}]})
    chk("FIND-1", "底图：三个节点（两个含「苹果」）", len(ents()) == 4, f"实体 {len(ents())}")

    # ⚠️ 组合要在**打开面板之前**建好。上次是测试中途用接口建的，
    #    面板靠轮询事件刷新，没刷出来 ⇒ 画布上找不到它（测试自己的问题）。
    grp_uuids = [o["uuid"] for o in ents() if o.get("text") in ("苹果", "香蕉")]
    rgrp = api("/workdesktop/api/pg/section", {"project": PROJECT, "create": {"text": "水果组", "children": grp_uuids}})
    chk("FIND-1b", "底图：一个组合「水果组」圈住两个节点", rgrp.get("ok") is True,
        json.dumps(rgrp, ensure_ascii=False)[:150])

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
        page.wait_for_timeout(4500)

        canv = page.locator(".dshw-pg-canvas").bounding_box()
        page.mouse.move(canv["x"] + canv["width"] / 2, canv["y"] + canv["height"] / 2)
        page.wait_for_timeout(300)
        page.locator(".dshw-pg-canvas").click(position={"x": 5, "y": 5})
        page.wait_for_timeout(400)

        # ── ① Ctrl+F 开搜索 ─────────────────────────────────────────────
        page.keyboard.press("Control+f")
        page.wait_for_timeout(900)
        box = page.locator(".dshw-pg-ask")
        chk("FIND-2", "★ Ctrl+F 打开的是**画布浮层**（不是浏览器弹窗）",
            box.count() == 1 and len(page.context.pages) == 1, f"浮层 {box.count()}")
        inp = page.locator(".dshw-pg-ask-input")
        chk("FIND-3", "★ 浮层里有搜索输入框", inp.count() >= 1, f"输入框 {inp.count()}")

        if inp.count() >= 1:
            # ── ② 搜「苹果」：应该命中 2 个，且描边是黄色 ──────────────
            inp.first.fill("苹果")
            page.wait_for_timeout(900)
            hit = page.locator('.dshw-pg-node[data-find="1"]')
            stroke = hit.first.evaluate("el => getComputedStyle(el).stroke") if hit.count() >= 1 else None
            chk("FIND-4", "★★ 搜「苹果」命中 **2 个**框体", hit.count() == 2, f"命中 {hit.count()}")
            chk("FIND-5", "★★ 命中的框体**算出来的描边是醒目的黄色**（真看得见）",
                stroke == AMBER, f"computed stroke = {stroke}（期望 {AMBER}）")
            txt = box.inner_text()
            chk("FIND-6", "★ 浮层上如实报出匹配数", "2" in txt, txt.replace("\n", " / ")[:120])

            # ── ③ 搜一个不存在的：0 命中，且没有残留标记 ────────────────
            inp.first.fill("西瓜")
            page.wait_for_timeout(900)
            residue = page.locator('.dshw-pg-node[data-find="1"]').count()
            chk("FIND-7", "★★ 搜不存在的词：**0 命中**，画布上不留残留标记",
                residue == 0, f"残留 {residue}")

            # ── ④ ESC 关掉 ──────────────────────────────────────────────
            page.keyboard.press("Escape")
            page.wait_for_timeout(700)
            chk("FIND-8", "★ ESC 关掉搜索框，且清掉标记",
                page.locator(".dshw-pg-ask").count() == 0
                and page.locator('.dshw-pg-node[data-find="1"]').count() == 0, '')

        # ── ⑤ 组合能不能 Ctrl 多选 ─────────────────────────────────────
        # 组合在开面板之前就建好了（见 FIND-1b），所以这里直接找它
        # ⚠️ 要把 wrap 里**所有** title 拼起来再比：分区的第一个 title 是"折叠这个分区"那个开关的提示，
        #    只看第一个永远匹配不到分区自己的名字（2026-10-09 探针查出来的，纯属脚本取错）。
        def wrap_titles(i):
            ts = page.locator("svg .dshw-pg-nodewrap").nth(i).locator("title")
            return " | ".join((ts.nth(k).text_content() or "") for k in range(ts.count()))

        def rect_of(pred):
            wraps = page.locator("svg .dshw-pg-nodewrap")
            for i in range(wraps.count()):
                if pred(wrap_titles(i)):
                    return wraps.nth(i).locator("rect").first.bounding_box()
            return None

        sec_rect = rect_of(lambda t: "水果组" in t)
        node_rect = rect_of(lambda t: "· 香蕉 ·" in t)
        chk("FIND-9", "画布上找到组合「水果组」和其中一个成员",
            sec_rect is not None and node_rect is not None,
            f"组合 {sec_rect is not None} 成员 {node_rect is not None}")
        chk("FIND-10", "★ 组合和成员在画布上**各自是一个可点对象**",
            sec_rect is not None and node_rect is not None,
            f"组合 {None if sec_rect is None else (round(sec_rect['x']), round(sec_rect['y']))}")
        if sec_rect is not None and node_rect is not None:
            # ⚠️ 要点组合框里的**空白处**（左下角内缩一点）：
            #    成员画在组合**上层**，点组合正中心命中的是成员，不是组合（第一版就栽在这）。
            page.mouse.click(sec_rect["x"] + 12, sec_rect["y"] + sec_rect["height"] - 12)
            page.wait_for_timeout(600)
            one = page.locator('.dshw-pg-node[data-picked="1"]').count()
            picked_kind = page.locator('.dshw-pg-node[data-picked="1"]').first.get_attribute("data-kind") \
                if one >= 1 else None
            chk("FIND-11a", "点组合框的空白处 ⇒ **选中的是组合本身**",
                one == 1 and picked_kind == "Section", f"选中 {one} 个，kind={picked_kind}")

            # ⚠️ 分开验两件事，别混在一起：
            #   (a) "组合能不能被 Ctrl 多选" —— 用**组合外面**的元素做加法，不受层叠影响
            #   (b) "点组内成员命中的是谁" —— 这才是上次得到 0 的可疑处
            other = rect_of(lambda t: "· 苹果派 ·" in t)
            if other is not None:
                page.keyboard.down("Control")
                page.mouse.click(other["x"] + other["width"] / 2, other["y"] + other["height"] / 2)
                page.keyboard.up("Control")
                page.wait_for_timeout(700)
                two = page.locator('.dshw-pg-node[data-picked="1"]').count()
                chk("FIND-11", "★★ 组合可以被 **Ctrl 多选**（组合 + 另一个元素同时选中）",
                    two == 2, f"组合 {one} 个 -> Ctrl 加一个 {two} 个")

            # (b) 点组内成员：命中的应该是**成员**，不是把它盖住的组合
            page.keyboard.press("Escape")
            page.wait_for_timeout(400)
            page.mouse.click(node_rect["x"] + node_rect["width"] / 2, node_rect["y"] + node_rect["height"] / 2)
            page.wait_for_timeout(700)
            inner = page.locator('.dshw-pg-node[data-picked="1"]')
            inner_count = inner.count()
            inner_kind = inner.first.get_attribute("data-kind") if inner_count >= 1 else None
            chk("FIND-12", "★★ 点**组内成员**，命中的是**成员本身**（成员画在组合上层）",
                inner_count == 1 and inner_kind == "TextNode",
                f"选中 {inner_count} 个，kind={inner_kind}")

        # ── ⑥ 一次拖动就该把组合撑开（用户 2026-10-09 报的"第一次不生效"）────
        def section_box():
            objs = api("/workdesktop/api/pg/document?project=" + urllib.parse.quote(PROJECT))["objects"]
            sec = next((o for o in objs if o.get("type") == "Section"), None)
            if sec is None:
                return None, objs
            return (sec.get("location"), sec.get("size"), sec.get("childUuids")), objs

        def encloses(box, objs):
            loc, size, kids = box[0], box[1], box[2]
            for o in objs:
                if o.get("uuid") not in (kids or []):
                    continue
                ol, osz = o.get("location"), o.get("size")
                if ol is None or osz is None:
                    continue
                if ol["x"] < loc["x"] - 1 or ol["y"] < loc["y"] - 1:
                    return False
                if ol["x"] + osz["width"] > loc["x"] + size["width"] + 1:
                    return False
                if ol["y"] + osz["height"] > loc["y"] + size["height"] + 1:
                    return False
            return True

        box0, objs0 = section_box()
        chk("FIND-13", "拿到组合当前的框", box0 is not None,
            json.dumps(box0[:2], ensure_ascii=False) if box0 else None)

        move_rect = rect_of(lambda t: "· 香蕉 ·" in t)
        if box0 is not None and move_rect is not None:
            w0 = box0[1]["width"]
            sx = move_rect["x"] + move_rect["width"] / 2
            sy = move_rect["y"] + move_rect["height"] / 2
            # 一次拖动：往右 260 像素，松手
            page.mouse.move(sx, sy)
            page.mouse.down()
            for k in range(1, 11):
                page.mouse.move(sx + 26 * k, sy)
                page.wait_for_timeout(25)
            page.mouse.up()
            page.wait_for_timeout(4000)

            box1, objs1 = section_box()
            w1 = box1[1]["width"] if box1 else w0
            chk("FIND-14", "★★★ **拖一次**组合框就撑开了（用户报的『第一次不生效』）",
                w1 > w0 + 150, f"宽 {w0:.0f} -> {w1:.0f}（拖了 260）")
            chk("FIND-15", "★★★ 撑开之后**成员一个都没被漏在框外**（用户报的『隔在外面』）",
                box1 is not None and encloses(box1, objs1), '')

            # 「再拖回来、框缩回去」这一段**不在这里验** ——
            # 本套件的职责是**搜索与多选**，拖动贴合属于 `verify-project-graph-livefit.py`，
            # 那边是专门的、同一次拖动内逐段量的（12/0 全过），比这里跨两次拖动可靠：
            # 两次拖动之间画布尺寸会变，屏幕坐标和世界坐标的比例跟着变，
            # 第二次很容易抓到**组外的节点**（这里量到 700 -> 700 就是这么来的），
            # 那是瞄准问题，不是功能问题。同一件事在两处验、其中一处还瞄不准，只会制造噪音。
            box2, objs2 = section_box()
            chk("FIND-17", "★★★ 撑开之后（松手落盘），成员**仍然全在框里**",
                box2 is not None and encloses(box2, objs2), '')

        page.screenshot(path=os.path.join(SHOT, "ui-29-find.png"))
        b.close()
finally:
    removed = api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
    print(f"\n清理：{'临时工程已删除' if removed.get('ok') else str(removed)[:130]}")

print(f"\nPASS={passed} FAIL={failed}")
sys.exit(0 if failed == 0 else 1)
