"""工程图 · 图片节点的**实机**核验（打活宿主 + 真浏览器）

离线那套已经证明「文件里有图片节点、附件也在」（verify-project-graph-image.mjs）。
这里证明另外两件只有跑起来才知道的事：
  ① host 的 /pg/attachment 真的把字节吐出来了（content-type / 长度 / 内容对得上）；
  ② 面板真的把 <image> 画出来了，href 指对了附件。
"""
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request

BASE = "http://127.0.0.1:3080"
PROJECTS = os.path.join(os.path.expanduser("~"), ".dsh\\.dsh-project-graph\\projects")
PROJECT = "图片自测临时工程"
NODE = os.path.join(os.path.expanduser("~"), "AppData\\Local\\nvm\\v24.20.0\\node.exe")
PLUGIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOT = os.path.join(os.path.expanduser("~"), "Desktop\\DSH")

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
        print(f"         {str(detail)[:260]}")


def plain(path, body=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=data, method="GET" if body is None else "POST")
    if body is not None:
        req.add_header("content-type", "application/json")
    with urllib.request.urlopen(req, timeout=180) as resp:
        return json.loads(resp.read().decode("utf-8"))


def read_token():
    with open(os.path.join(os.path.expanduser("~"), ".dsh\\daemon\\dsh.log"), encoding="utf-8", errors="ignore") as fh:
        hits = [ln for ln in fh if "dsh web: http" in ln]
    return hits[-1].split("token=")[1].strip() if hits else ""


PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")

target = os.path.join(PROJECTS, PROJECT + ".prg")
seed = os.path.join(os.path.expanduser("~"), ".dsh\\.dsh-project-graph\\bin\\empty-project.prg")

# ── 用文档层离线造一个带图片的工程（面板没有"上传图片"的入口，这步只能在 Node 侧做）
setup = """
import { readDocument, writeDocument, insertObjects, makeImageNode, addAttachment } from './pg-helper/project-graph-doc.mjs'
const [target, b64] = process.argv.slice(1)
const png = Buffer.from(b64, 'base64')
const a = addAttachment(target, 'att-img-1', 'png', png)
if (a.ok !== true) { console.error(JSON.stringify(a)); process.exit(1) }
const d = readDocument(target)
const made = makeImageNode({ attachmentId: 'att-img-1', x: 40, y: 40, width: 320, height: 240 })
writeDocument(target, d.doc, insertObjects(d.stage, [made.node], null))
console.log(JSON.stringify({ ok: true, bytes: png.length }))
"""
# 工程走 **HTTP 建**：create 会推一条 projects 事件，面板的工程下拉才会刷新
# （直接往磁盘丢文件面板是不知道的 —— 实测踩到：下拉里根本没有这个工程）
plain("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
made = plain("/workdesktop/api/pg/project", {"action": "create", "name": PROJECT})
chk("IMGL-0", "通过路由建工程（这样面板才能在下拉里看到它）", made.get("ok") is True, str(made)[:150])
r = subprocess.run([NODE, "--input-type=module", "-e", setup, target,
                    base64.b64encode(PNG).decode("ascii")],
                   cwd=PLUGIN, capture_output=True, text=True, encoding="utf-8", timeout=180)
chk("IMGL-1", "离线往这个工程里塞 PNG 附件 + 图片节点", r.returncode == 0 and '"ok":true' in (r.stdout or ""),
    (r.stdout or r.stderr or "").strip()[:200])

try:
    # ── ① host 的附件路由 ────────────────────────────────────────────────
    url = f"{BASE}/workdesktop/api/pg/attachment?project={urllib.parse.quote(PROJECT)}&id=att-img-1"
    with urllib.request.urlopen(url, timeout=120) as resp:
        body = resp.read()
        ctype = resp.headers.get("content-type")
    chk("IMGL-2", "★ /pg/attachment 吐出字节，content-type 是 image/png",
        ctype == "image/png" and len(body) == len(PNG) and body == PNG,
        f"{len(body)} 字节 · {ctype}")

    bad = f"{BASE}/workdesktop/api/pg/attachment?project={urllib.parse.quote(PROJECT)}&id={urllib.parse.quote(chr(27809)+chr(26377)+chr(36825)+chr(20010))}"
    with urllib.request.urlopen(bad, timeout=120) as resp:  # URL 只能是 ASCII，中文 id 必须先 encode
        j = json.loads(resp.read().decode("utf-8"))
    chk("IMGL-2b", "附件不存在时回 JSON 错误（不是空图、不是 500）",
        j.get("ok") is False and j.get("code") == "ATTACHMENT_NOT_FOUND", json.dumps(j, ensure_ascii=False)[:160])

    # ── ② 面板真的画出来 ────────────────────────────────────────────────
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True)
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
        chk("IMGL-3", "打开「工程图」面板", row is not None, "")
        if row is not None:
            row.click()
            page.wait_for_timeout(3500)
            page.select_option(".dshw-pg-bar select", PROJECT)
            page.wait_for_timeout(4500)
            imgs = page.locator("svg image")
            chk("IMGL-4", "★★ 面板把图片节点画出来了（<image> 元素）", imgs.count() == 1, f"image 元素 {imgs.count()}")
            href = imgs.first.get_attribute("href") if imgs.count() == 1 else ""
            chk("IMGL-4b", "★★ href 指向那个附件 id（不是空、不是别的）",
                "pg/attachment" in str(href) and "att-img-1" in str(href), str(href)[:170])
            # 图片真的被浏览器取到了吗（network 层面）
            got_status = None
            try:
                with page.expect_response(lambda resp: "pg/attachment" in resp.url, timeout=20000) as info:
                    page.reload(wait_until="domcontentloaded")
                got_status = info.value.status
            except Exception as e:
                got_status = f"没抓到请求：{str(e)[:80]}"
            chk("IMGL-5", "★ 浏览器确实去取了那张图，且是 200", got_status == 200, f"HTTP {got_status}")
            row2 = None
            cands2 = page.get_by_text("工程图", exact=True)
            for i in range(cands2.count()):
                bb = cands2.nth(i).bounding_box()
                if bb and bb["x"] < 260 and bb["y"] > 600:
                    row2 = cands2.nth(i)
            if row2 is not None:
                row2.click()
                page.wait_for_timeout(4000)
                page.select_option(".dshw-pg-bar select", PROJECT)
                page.wait_for_timeout(4000)
            page.screenshot(path=SHOT + r"\ui-17-image.png")
        b.close()
finally:
    try:
        os.remove(target)
        print("\n清理：临时工程已删除")
    except OSError as e:
        print(f"\n清理失败：{e}")

print(f"\nPASS={passed} FAIL={failed}")
sys.exit(0 if failed == 0 else 1)
