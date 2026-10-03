"""工程图 · 涂鸦（PenStroke）实机核验：建 / 读 / 平移，且**上游照样能打开**。

PenStroke 的字段是 uuid / segments / color，它的 collisionBox **不落盘**（从点现算），
所以"移动它"必须逐个点平移 —— 这个脚本就是盯这件事的。
"""
import json
import sys
import urllib.parse
import urllib.request

BASE = "http://127.0.0.1:3080"
PROJECT = "涂鸦自测临时工程"
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
        print(f"         {str(detail)[:240]}")


def api(path, body=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=data, method="GET" if body is None else "POST")
    if body is not None:
        req.add_header("content-type", "application/json")
    with urllib.request.urlopen(req, timeout=180) as resp:
        return json.loads(resp.read().decode("utf-8"))


def doc():
    return api("/workdesktop/api/pg/document?project=" + urllib.parse.quote(PROJECT))


api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
made = api("/workdesktop/api/pg/project", {"action": "create", "name": PROJECT})
chk("PEN-1", "建临时工程", made.get("ok") is True, str(made)[:130])

try:
    pts = [{"x": 0, "y": 0}, {"x": 60, "y": 40}, {"x": 120, "y": 10}, {"x": 180, "y": 70}]
    r = api("/workdesktop/api/pg/stroke", {"project": PROJECT, "points": pts})
    chk("PEN-2", "★ /pg/stroke 落一条涂鸦", r.get("ok") is True and r.get("points") == 4,
        str(r)[:170])

    objs = doc()["objects"]
    stroke = next((o for o in objs if o.get("type") == "PenStroke"), None)
    chk("PEN-2b", "★ 文档层读到这条涂鸦，且带着点列",
        stroke is not None and len(stroke.get("points", [])) == 4,
        json.dumps(stroke, ensure_ascii=False)[:200] if stroke else "没找到")
    chk("PEN-2c", "涂鸦的摘要里**没有**一般的 location/size（几何是现算的）",
        stroke is not None and stroke.get("location") is None and stroke.get("size") is None,
        f"location={stroke.get('location') if stroke else '-'} size={stroke.get('size') if stroke else '-'}")

    g = api("/workdesktop/api/pg/graph?project=" + urllib.parse.quote(PROJECT))
    types = sorted({o.get("type") for o in g.get("objects", [])})
    chk("PEN-3", "★★ 上游 CLI 照样能打开（涂鸦这种类型它也认）", g.get("ok") is True and "PenStroke" in types,
        json.dumps(types, ensure_ascii=False))

    before = [dict(p) for p in stroke["points"]]
    mv = api("/workdesktop/api/pg/stroke-move", {"project": PROJECT, "uuid": stroke["uuid"], "dx": 100, "dy": -25})
    chk("PEN-4", "★ /pg/stroke-move 平移涂鸦", mv.get("ok") is True and mv.get("points") == 4, str(mv)[:150])
    after = next(o for o in doc()["objects"] if o.get("type") == "PenStroke")["points"]
    same_shape = len(after) == len(before) and all(
        abs(after[i]["x"] - before[i]["x"] - 100) < 0.01 and abs(after[i]["y"] - before[i]["y"] + 25) < 0.01
        for i in range(len(before)))
    chk("PEN-4b", "★★ 平移是**逐个点**都动了（不是只改一个外框）", same_shape,
        f"{json.dumps(before[:2])} -> {json.dumps(after[:2])}")
    g2 = api("/workdesktop/api/pg/graph?project=" + urllib.parse.quote(PROJECT))
    chk("PEN-4c", "★★ 平移之后上游仍能打开", g2.get("ok") is True, "")

    u = api("/workdesktop/api/pg/undo", {"project": PROJECT})
    back = next(o for o in doc()["objects"] if o.get("type") == "PenStroke")["points"]
    chk("PEN-5", "★★ 涂鸦也能撤销（点回到原处）",
        u.get("ok") is True and abs(back[0]["x"] - before[0]["x"]) < 0.01,
        f"{json.dumps(after[0])} -> {json.dumps(back[0])}")

    bad = api("/workdesktop/api/pg/stroke", {"project": PROJECT, "points": [{"x": 0, "y": 0}]})
    chk("PEN-6", "只有一个点时如实报错（不落一条画不出来的涂鸦）",
        bad.get("ok") is False and "两个点" in str(bad.get("error")), str(bad)[:140])
finally:
    removed = api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
    print(f"\n清理：{'临时工程已删除' if removed.get('ok') else str(removed)[:130]}")

print(f"\nPASS={passed} FAIL={failed}")
sys.exit(0 if failed == 0 else 1)
