"""工程图实机套件的公共小工具（2026-10-10）。

目前只有一件事：**把某个工程留下的备份目录一起收干净**。

背景：`/pg/project` 的 delete 只删 `projects\\<名>.prg` 本身，**不删**它的两处备份目录 ——
  · `projects\\snapshots\\<名>\\`（关闭时快照，最多 5 版）
  · `projects\\versions\\<名>\\`（写前留底，最多 30 版）
于是一轮套件跑完，工程没了、备份目录还留着，越积越多（2026-10-10 数了一下：
`snapshots` 下 8 个、`versions` 下 9 个都是已经没有对应的工程了）。

⚠️ 只删**明确传进来的那个工程名**的目录，而且**不认识的名字一概不碰**
（`工作台` / `组织张力与资源` 这类真工程的备份一份都不能少）。
"""
import os
import shutil

# 与宿主那边 `PG_PROJECTS` 同一个位置；容器/临时环境可用环境变量盖掉
_WS = os.environ.get("DSH_WORKDESKTOP_PROJECT_GRAPH_DIR") or os.path.join(
    os.path.expanduser("~"), ".dsh", ".dsh-project-graph")
PROJECTS = os.path.join(_WS, "projects")


def purge_project_backups(name):
    """删掉 `<名>` 的 snapshots / versions 备份目录。返回删掉的目录数。

    工程名不认识（目录不存在）就什么都不做 —— 幂等，重复调用无害。
    """
    if not name:
        return 0
    removed = 0
    for kind in ("snapshots", "versions"):
        d = os.path.join(PROJECTS, kind, name)
        if os.path.isdir(d):
            shutil.rmtree(d, ignore_errors=True)
            removed += 1
    # snapshots/ 与 versions/ 底下空了就把空壳也收掉（只收空目录）
    for kind in ("snapshots", "versions"):
        d = os.path.join(PROJECTS, kind)
        try:
            if os.path.isdir(d) and not os.listdir(d):
                os.rmdir(d)
        except OSError:
            pass
    return removed
