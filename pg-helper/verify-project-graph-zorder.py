"""工程图 · 调层级（z-order）的实机核验（HTTP 级，独立小脚本）

为什么要单独一个脚本：z-order 的实现在文档层里走的是"**位移 + 置换改写引用下标**"，
和插入/删除共用同一套重编号逻辑但又**不产生孤儿**。它是这批改动里唯一
"改数组顺序"的操作，所以单独盯一下：**挪完之后每条连线的两端必须还是原来那两个对象**。
"""
import json
import sys
import urllib.parse
import urllib.request

BASE = "http://127.0.0.1:3080"
PROJECT = "层级自测临时工程"
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


def api(path, body=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=data, method="GET" if body is None else "POST")
    if body is not None:
        req.add_header("content-type", "application/json")
    with urllib.request.urlopen(req, timeout=180) as resp:
        return json.loads(resp.read().decode("utf-8"))


def doc():
    return api("/workdesktop/api/pg/document?project=" + urllib.parse.quote(PROJECT))


def graph():
    g = api("/workdesktop/api/pg/graph?project=" + urllib.parse.quote(PROJECT))
    objs = g.get("objects", [])
    by_ref = {o["ref"]: o.get("text") for o in objs}
    return [f"{by_ref.get(o.get('sourceRef'))}->{by_ref.get(o.get('targetRef'))}"
            for o in objs if o.get("type") == "LineEdge"]


api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
api("/workdesktop/api/pg/project", {"action": "create", "name": PROJECT})
try:
    ins = api("/workdesktop/api/pg/insert", {"project": PROJECT, "nodes": [
        {"text": "甲", "x": 0, "y": 0}, {"text": "乙", "x": 300, "y": 0}]})
    chk("ZO-1", "建工程 + 两个节点", ins.get("ok") is True, str(ins)[:120])
    objs = doc()["objects"]
    pick = lambda t: next(o["uuid"] for o in objs if o.get("text") == t)  # noqa: E731
    a, b = pick("甲"), pick("乙")
    conn = api("/workdesktop/api/pg/connect", {"project": PROJECT, "source": a, "target": b})
    chk("ZO-2", "连一条线（甲→乙），供层级调整时盯住", conn.get("ok") is True, str(conn)[:140])
    before_edges = graph()
    before_order = [o.get("text") for o in doc()["objects"]]
    chk("ZO-3", "记录调整前的顺序与连线", len(before_edges) == 1,
        f"顺序={json.dumps(before_order, ensure_ascii=False)} 连线={before_edges}")

    r = api("/workdesktop/api/pg/reorder", {"project": PROJECT, "uuid": a, "where": "front"})
    chk("ZO-4", "★ /pg/reorder 置顶", r.get("ok") is True and r.get("moved") is True, str(r)[:140])
    after_order = [o.get("text") for o in doc()["objects"]]
    chk("ZO-4b", "★★ 甲 真的跑到数组末尾了（顺序就是绘制顺序）",
        after_order[-1] == "甲" and after_order != before_order,
        json.dumps(after_order, ensure_ascii=False))
    chk("ZO-4c", "★★ 置顶之后**连线的两端还是原来那两个对象**（位移的引用置换是对的）",
        graph() == before_edges, f"{before_edges} -> {graph()}")

    r2 = api("/workdesktop/api/pg/reorder", {"project": PROJECT, "uuid": a, "where": "back"})
    chk("ZO-5", "★ 置底", r2.get("ok") is True and r2.get("moved") is True, str(r2)[:140])
    after_back = [o.get("text") for o in doc()["objects"]]
    # 注意：「置底」是**挪到下标 0**，不是"回到上一次的位置" —— 甲 原来在下标 1，
    # 所以置底之后它会在下标 0、把根节点挤到后面。这是对的（实测一开始把这两件事搞混了）。
    chk("ZO-5b", "★★ 置底之后 甲 在下标 0，且**连线始终没变**",
        after_back[0] == "甲" and graph() == before_edges,
        f"{json.dumps(after_back, ensure_ascii=False)} 连线={graph()}")

    r3 = api("/workdesktop/api/pg/reorder", {"project": PROJECT, "uuid": a, "where": "不下不下的动作"})
    chk("ZO-6", "不认识的动作如实报错（不静默成功）",
        r3.get("ok") is False and "不认识的层级动作" in str(r3.get("error")), str(r3)[:150])

    u = api("/workdesktop/api/pg/undo", {"project": PROJECT})
    chk("ZO-7", "★ 调层级也能撤销（走的是同一套快照）", u.get("ok") is True, str(u)[:140])
finally:
    removed = api("/workdesktop/api/pg/project", {"action": "delete", "name": PROJECT})
    print(f"\n清理：{'临时工程已删除' if removed.get('ok') else str(removed)[:140]}")

print(f"\nPASS={passed} FAIL={failed}")
sys.exit(0 if failed == 0 else 1)
