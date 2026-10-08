"""工程图 · **长出子树**（实机核验）

用户 2026-10-09 报："点完之后要等几秒才出来"。

根因：原来它走的是**上游命令行**（每次调用起一个进程），现在改成文档层本地直接写盘。
所以这条测试盯三件事：
  ① 长出来了（节点数、连线数对得上）
  ② **快**（本地这条路不该要好几秒）—— 直接量接口耗时
  ③ 上游照样能打开（本地写出来的文件必须仍然合法）
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:3080"
PROJECT = "长出子树自测临时工程"
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


def doc():
    return api("/workdesktop/api/pg/document?project=" + urllib.parse.quote(PROJECT))["objects"]


def ents():
    return [o for o in doc() if o.get("type") != "LineEdge"]


def edges():
    return [o for o in doc() if o.get("type") == "LineEdge"]


api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
api("/workdesktop/api/pg/project", {"action": "create", "name": PROJECT})

try:
    api("/workdesktop/api/pg/insert", {"project": PROJECT, "nodes": [{"text": "父", "x": 0, "y": 0}]})
    root_uuid = next((o["uuid"] for o in ents() if o.get("text") == "父"), None)
    chk("GR-1", "底图：一个节点当父", root_uuid is not None, f"uuid={root_uuid}")

    # ── ① 本地那条：又快又对（2026-10-09 修掉了"写坏文件"的 bug 之后重新打开）──
    n0, e0 = len(ents()), len(edges())
    t0 = time.time()
    r = api("/workdesktop/api/pg/grow", {"project": PROJECT, "uuid": root_uuid,
                                         "text": "子一\n  孙一\n  孙二\n子二"})
    cost = time.time() - t0
    chk("GR-2", "★★ 长出子树：4 行 → 4 个节点 + 4 条连线",
        r.get("ok") is True and r.get("nodes") == 4 and r.get("edges") == 4,
        json.dumps(r, ensure_ascii=False)[:200])
    chk("GR-3", "★★ **快**：本地这条路 1 秒内完成（原来走上游命令行要等好几秒）",
        cost < 1.0, f"耗时 {cost:.2f} 秒（阈值 1.0）")
    chk("GR-4", "★ 盘上真的多了 4 个节点、4 条连线",
        len(ents()) == n0 + 4 and len(edges()) == e0 + 4,
        f"实体 {n0}->{len(ents())}，连线 {e0}->{len(edges())}")

    texts = sorted(o.get("text") for o in ents() if o.get("type") == "TextNode")
    # ⚠️ 模板自带一个「根节点」，别漏了它
    chk("GR-5", "★ 节点文字都对（含模板自带的根节点）",
        texts == sorted(["根节点", "父", "子一", "孙一", "孙二", "子二"]),
        json.dumps(texts, ensure_ascii=False))

    g = api("/workdesktop/api/pg/graph?project=" + urllib.parse.quote(PROJECT))
    chk("GR-6", "★★★ **文件是对的**：本地写出来的东西，上游照样能打开",
        g.get("ok") is True, json.dumps(g, ensure_ascii=False)[:200])

    u = api("/workdesktop/api/pg/undo", {"project": PROJECT})
    chk("GR-7", "★ 长出子树也能撤销", u.get("ok") is True and len(ents()) == n0,
        f"撤销后实体 {len(ents())}（期望 {n0}）")

    # ── ② 界面上走一遍：菜单项还在、浮层贴在鼠标 ────────────────────────
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

        def rect_of(text):
            wraps = page.locator("svg .dshw-pg-nodewrap")
            for i in range(wraps.count()):
                t = wraps.nth(i).locator("title").first.text_content() or ""
                if ("· " + text + " ·") in t:
                    return wraps.nth(i).locator("rect").first.bounding_box()
            return None

        rb = rect_of("父")
        chk("GR-8", "在画布上找到父节点", rb is not None, f"{rb}")
        if rb is not None:
            mx = rb["x"] + rb["width"] / 2
            my = rb["y"] + rb["height"] / 2
            page.mouse.click(mx, my, button="right")
            page.wait_for_timeout(700)
            item = page.get_by_role("button", name="长出子树…")
            chk("GR-9", "★ 单选时菜单里有「长出子树」", item.count() >= 1, f"找到 {item.count()} 个")
            if item.count() >= 1:
                item.first.click()
                page.wait_for_timeout(900)
                layer = page.locator(".dshw-pg-ask")
                ab = layer.first.bounding_box() if layer.count() else None
                chk("GR-10", "★★ 弹的是**画布浮层**（不是浏览器弹窗），而且贴在鼠标附近",
                    layer.count() == 1 and ab is not None
                    and abs(ab["x"] - mx) < 300 and abs(ab["y"] - my) < 260,
                    f"浮层 {layer.count()} 左上 {ab}")
                chk("GR-11", "★ 浮层里**没有再问『上游引用』**",
                    "上游引用" not in (layer.inner_text() or ""),
                    (layer.inner_text() or "").replace("\n", " / ")[:140])
                ta = page.locator(".dshw-pg-ask-input")
                if ta.count() >= 1:
                    n1 = len(ents())
                    ta.first.fill("甲\n  乙")
                    page.get_by_role("button", name="确定（Ctrl+回车）").first.click()
                    page.wait_for_timeout(3000)
                    chk("GR-12", "★★ 从界面点完，**立刻**就长出来了（2 个节点 + 2 条连线）",
                        len(ents()) == n1 + 2 and len(edges()) >= 2,
                        f"实体 {n1}->{len(ents())}，连线 {len(edges())}")

        page.screenshot(path=os.path.join(SHOT, "ui-28-grow.png"))
        b.close()
finally:
    removed = api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
    print(f"\n清理：{'临时工程已删除' if removed.get('ok') else str(removed)[:130]}")

print(f"\nPASS={passed} FAIL={failed}")
sys.exit(0 if failed == 0 else 1)
