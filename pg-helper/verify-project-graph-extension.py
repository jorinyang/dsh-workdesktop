"""工程图 · **扩展实体点击**（实机核验）

原项目 ControllerExtensionEntityClick：左键按下命中 ExtensionEntity 时，
按 (extensionId, typeName) 找扩展注册的处理器，交给它一份载荷：
  { relativeWorldX, relativeWorldY, worldX, worldY, customData, uuid }

面板跑不了应用里那段扩展代码，所以等价做法是把**同一份载荷**交给宿主并推一条事件。
这个脚本盯三件事：
  ① 文档层认得出扩展实体（extensionId / typeName / customData 都读得到）；
  ② /pg/extension-click 回的载荷字段与上游那六个**对得上**（相对坐标要按实体原点算）；
  ③ 真浏览器里点一下，宿主确实收到了（走 /pg/events）。
"""
import base64
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request

BASE = "http://127.0.0.1:3080"
PROJECT = "扩展实体自测临时工程"
NODE = r"<本机检出>\AppData\Local\nvm\v24.20.0\node.exe"
PLUGIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOT = r"<本机检出>\Desktop\DSH"
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
        print(f"         {str(detail)[:250]}")


def api(path, body=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=data, method="GET" if body is None else "POST")
    if body is not None:
        req.add_header("content-type", "application/json")
    with urllib.request.urlopen(req, timeout=180) as resp:
        return json.loads(resp.read().decode("utf-8"))


def read_token():
    with open(r"<本机检出>\.dsh\daemon\dsh.log", encoding="utf-8", errors="ignore") as fh:
        hits = [ln for ln in fh if "dsh web: http" in ln]
    return hits[-1].split("token=")[1].strip() if hits else ""


def doc():
    return api("/workdesktop/api/pg/document?project=" + urllib.parse.quote(PROJECT))["objects"]


# 用文档层造一个扩展实体（面板没有"造扩展实体"的入口，这步只能在 Node 侧做）
setup = """
import { readDocument, writeDocument, insertObjects } from './pg-helper/project-graph-doc.mjs'
const [target] = process.argv.slice(1)
const d = readDocument(target)
const node = {
  _: 'ExtensionEntity',
  uuid: 'ext-0001-abcd-0000-000000000001',
  extensionId: 'demo-extension',
  typeName: 'DemoWidget',
  customData: { count: 7, label: '示例' },
  collisionBox: {
    _: 'CollisionBox',
    shapes: [{ _: 'Rectangle', location: { _: 'Vector', x: 120, y: 80 }, size: { _: 'Vector', x: 260, y: 160 } }],
  },
}
writeDocument(target, d.doc, insertObjects(d.stage, [node], null))
console.log(JSON.stringify({ ok: true }))
"""

api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
made = api("/workdesktop/api/pg/project", {"action": "create", "name": PROJECT})
chk("EXT-1", "建临时工程", made.get("ok") is True, str(made)[:120])

target = os.path.join(r"<本机检出>\.dsh\.dsh-project-graph\projects", PROJECT + ".prg")
try:
    r = subprocess.run([NODE, "--input-type=module", "-e", setup, target],
                       cwd=PLUGIN, capture_output=True, text=True, encoding="utf-8", timeout=180)
    chk("EXT-2", "往工程里写一个 ExtensionEntity", r.returncode == 0 and '"ok":true' in (r.stdout or ""),
        (r.stdout or r.stderr or "").strip()[:200])

    objs = doc()
    ext = next((o for o in objs if o.get("type") == "ExtensionEntity"), None)
    chk("EXT-3", "★ 文档层读得出扩展实体，三个字段都在",
        ext is not None and ext.get("extensionId") == "demo-extension"
        and ext.get("typeName") == "DemoWidget"
        and isinstance(ext.get("customData"), dict) and ext["customData"].get("count") == 7,
        json.dumps(ext, ensure_ascii=False)[:230] if ext else "没找到")

    # ⚠️ 这里**故意断言"上游读不了"**，而不是假装它能读。
    #    实测：手工造一个 ExtensionEntity（本机没装那个扩展）会让上游直接
    #    TOOL_EXECUTION_FAILED —— 这个类型要靠扩展注册，没注册就反序列化不了。
    #    所以扩展实体是"装了什么扩展才有什么"，不能凭空造。
    #    这条断言把边界钉住：哪天它能读了，说明上游变了，我们得知道。
    g = api("/workdesktop/api/pg/graph?project=" + urllib.parse.quote(PROJECT))
    chk("EXT-4", "★ 边界：手工造的扩展实体，上游**读不了**（类型要靠扩展注册，不能凭空造）",
        g.get("ok") is not True,
        f"上游回执 ok={g.get('ok')} code={g.get('code')} —— 期望它失败")
    chk("EXT-4b", "★ 但文档层读得出来（面板不依赖上游也认得出这类对象）",
        any(o.get("type") == "ExtensionEntity" for o in objs), "")

    # 点在实体内部、偏左上一点：相对坐标应当等于 (世界点 - 实体原点)
    click = api("/workdesktop/api/pg/extension-click", {
        "project": PROJECT, "uuid": ext["uuid"], "worldX": 200, "worldY": 130})
    p = click.get("payload") or {}
    chk("EXT-5", "★ /pg/extension-click 回的载荷字段与上游那六个对得上",
        click.get("ok") is True and p.get("uuid") == ext["uuid"]
        and p.get("extensionId") == "demo-extension" and p.get("typeName") == "DemoWidget"
        and p.get("worldX") == 200 and p.get("worldY") == 130
        and abs(p.get("relativeWorldX") - 80) < 0.01 and abs(p.get("relativeWorldY") - 50) < 0.01,
        json.dumps(p, ensure_ascii=False)[:250])
    chk("EXT-5b", "customData 原样带过去（不吞、不改）",
        isinstance(p.get("customData"), dict) and p["customData"].get("label") == "示例",
        json.dumps(p.get("customData"), ensure_ascii=False))

    bad = api("/workdesktop/api/pg/extension-click", {"project": PROJECT, "uuid": "no-such"})
    chk("EXT-6", "uuid 不存在时如实报错（不静默成功）", bad.get("ok") is False, str(bad)[:140])

    # ── 真浏览器点一下 ──────────────────────────────────────────────────
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        b = pw.chromium.launch(channel="chrome", headless=True)
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
        chk("EXT-7", "打开「工程图」面板", row is not None, "")
        if row is not None:
            row.click()
            page.wait_for_timeout(3500)
            page.select_option(".dshw-pg-bar select", PROJECT)
            page.wait_for_timeout(4500)
            node = page.locator('.dshw-pg-node[data-kind="ExtensionEntity"]')
            chk("EXT-8", "★ 扩展实体在画布上认得出来（有自己的 data-kind）", node.count() == 1, f"节点 {node.count()}")
            bb = node.first.bounding_box()
            if bb:
                page.mouse.click(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2)
                page.wait_for_timeout(2500)
                msg = page.locator(".dshw-pg-msg")
                text = msg.first.inner_text() if msg.count() else "(没有消息)"
                chk("EXT-9", "★★ 点一下之后面板如实说明「把这次点击交给了宿主」",
                    "交给了宿主" in text and "demo-extension" in text, text[:170])
                ev = api("/workdesktop/api/pg/events?since=0")
                hits = [e for e in ev.get("events", []) if e.get("kind") == "extension-click"]
                # ⚠️ pgPushEvent 是把载荷**摊平**进事件对象的（{rev, kind, at, ...payload}），
                #    不是 {kind, payload} —— 第一版按后者读，KeyError。
                chk("EXT-10", "★★ 宿主真的收到了这条点击事件（带扩展身份与载荷）",
                    len(hits) >= 1 and hits[-1].get("extensionId") == "demo-extension"
                    and hits[-1].get("typeName") == "DemoWidget",
                    json.dumps(hits[-1], ensure_ascii=False)[:220] if hits else "事件里没有 extension-click")
                page.screenshot(path=SHOT + r"\ui-19-extension.png")
        b.close()
finally:
    removed = api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
    print(f"\n清理：{'临时工程已删除' if removed.get('ok') else str(removed)[:130]}")

print(f"\nPASS={passed} FAIL={failed}")
sys.exit(0 if failed == 0 else 1)
