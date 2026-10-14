/**
 * model-worker.mjs —— 在**独立线程**里调模型。
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 为什么需要它（2026-10-14，与 recall-worker.mjs 同一次定位）
 *
 * `analyze.mjs#runModelViaFile` / `runModelWithRetry` 用 **`spawnSync(powershell.exe …)`**
 * 调 `bl text chat`，超时给到 180–240 秒。`spawnSync` 会按住整个 Node 事件循环：
 * 面板是单线程的，只要在 HTTP 请求路径上调它，**模型没回来的这段时间面板不响应任何请求**
 * —— 看门狗 guard 的 HTTP 探针（4s 超时 × 连续 4 次）随即判定「假死」并强制重启面板。
 * 这个包自己的注释里就记过一次实测：一段 3625 字的提示词 **300 秒拿不回来**
 * （`spawnSync powershell.exe ETIMEDOUT`，见 api/cockpit.mjs）。
 *
 * ⇒ 同步调用点（离线脚本、CLI）保持不动；把**请求路径上的调用**挪进 worker：
 *   主线程 await，事件循环照常转。
 *
 * 复用 `runModelWithRetry`（含重试与 viaFile 分流），不另写一份调用逻辑 ——
 * 少一个分叉就少一处漂移。
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { parentPort, workerData } from 'node:worker_threads'
import { runModelWithRetry } from './analyze.mjs'

try {
  const result = runModelWithRetry(workerData.prompt, workerData.opts ?? {})
  parentPort.postMessage({ ok: true, result })
} catch (e) {
  parentPort.postMessage({ ok: false, why: e?.message ?? String(e) })
}
