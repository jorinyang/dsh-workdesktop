/**
 * recall-worker.mjs —— 在**独立线程**里执行同步的 RAG 桥。
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 为什么需要它（2026-10-14 定位）
 *
 * `rag-bridge.mjs#queryRagBatch` 内部用 **`spawnSync`** 起子进程（service-client 或一次性
 * 工人），而一次查询实测 **17–26s**（其中 ~15s 是把 bge-m3 装进内存 —— 见 rag-bridge.mjs
 * 顶部 2026-09-21 的实测记录）。
 *
 * `spawnSync` 会**按住整个 Node 事件循环**。面板是单线程的：只要在 HTTP 请求路径上直接
 * 调它，面板在这 15–26 秒里**不响应任何请求**。看门狗 guard 每 12s 用 HTTP 探针（4s 超时）
 * 探一次 127.0.0.1:3080，连续 4 次无响应就判定「假死（事件循环阻塞）」并强制重启面板。
 *
 * 实测代价（会话 session-17d2242f，2026-10-12 ~ 10-14）：**5 次**这样的强制重启 ——
 * 10-12 20:17、10-14 16:50 / 17:06 / 17:25 / 19:00，每次都在「流入时取上下文」被触发之后，
 * 每次都在面板自己的会话里留下一条 TOOL_OUTCOME_UNKNOWN（"这条命令做没做，不知道"）。
 *
 * ⇒ 桥「同步」这件事**不改**（离线构建脚本按同步语义写，改面太大）；
 *   把**调用点**挪进 worker：主线程 await，事件循环照常转，HTTP 照常响应。
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { parentPort, workerData } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
import { ragBridgePath } from '../paths.mjs'

async function main() {
  const mod = await import(pathToFileURL(ragBridgePath()).href)
  const raw = mod.queryRagBatch(
    [{ query: workerData.query, k: workerData.k }],
    { runtime: workerData.runtime, purpose: workerData.purpose },
  )
  return { ok: true, raw }
}

main().then(
  (value) => parentPort.postMessage(value),
  (error) => parentPort.postMessage({ ok: false, why: error?.message ?? String(error) }),
)
