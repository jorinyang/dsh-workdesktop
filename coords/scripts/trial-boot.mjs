/**
 * 隔离试运行：在**另一个端口**上把 web profile 连同 dsh-coords 一起启动，
 * 验证它能干净启动、路由可用，然后收工 —— 全程不碰正在跑的 3080 实例。
 *
 * 为什么需要它：host 半段让整棵插件树在 boot 阶段崩掉的代价很大（profile 的
 * bundle 行会被自动摘掉、用户看到白屏）。改任何 host 半段或新装插件，都应该
 * 先在隔离端口试一次。
 *
 * 用法：
 *   node scripts/trial-boot.mjs                 # 试运行并报告（默认 3181）
 *   node scripts/trial-boot.mjs --port 3182
 *
 * 安全性：临时改写 profile 的 package.json 前先备份，结束时**无条件还原**
 * （包括异常与超时路径）；子进程 windowsHide，不留可见控制台窗口。
 */
import { spawn } from 'node:child_process'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const profileJson = join(process.env.DSH_HOME || join(process.env.USERPROFILE ?? '', '.dsh'), 'profiles', 'web', 'package.json')
const backup = `${profileJson}.trial-boot-backup`
const pluginName = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).name

const portArgIndex = process.argv.indexOf('--port')
const port = portArgIndex === -1 ? 3181 : Number(process.argv[portArgIndex + 1])
const HARNESS = process.env.DSH_HARNESS_ROOT ?? 'D:/deepseek-harness'

/** 把 bundle 行临时加进 profile（依赖项应已存在）。 */
async function stageBundle() {
  const text = await readFile(profileJson, 'utf8')
  await writeFile(backup, text, 'utf8')
  const json = JSON.parse(text)
  const bundles = json.dsh?.profile?.bundles ?? []
  if (!bundles.includes(pluginName)) bundles.push(pluginName)
  if (json.dependencies?.[pluginName] === undefined) {
    throw new Error(`profile 依赖里没有 ${pluginName}；先把 link: 依赖与 junction 装好`)
  }
  json.dsh.profile.bundles = bundles
  await writeFile(profileJson, `${JSON.stringify(json, null, 2)}\n`, 'utf8')
}

async function restoreBundle() {
  try {
    await copyFile(backup, profileJson)
  } catch { /* 没有备份说明没改过 */ }
}

/** 探一个路径，返回状态码（401/200 都说明路由在；404 = 没注册）。 */
async function probe(path) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`)
    return { path, status: response.status, body: (await response.text()).slice(0, 160) }
  } catch (error) {
    return { path, status: 0, body: String(error.message) }
  }
}

/** 轮询直到端口有响应或超时。 */
async function waitForPort(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await probe('/coords/api/meta')
    if (result.status !== 0) return result
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return null
}

process.stdout.write(`隔离试运行：dsh web --port ${port} + ${pluginName}\n`)

let child
let exit = null
try {
  await stageBundle()
  process.stdout.write(`✓ 已把 ${pluginName} 临时挂进 profile bundles\n`)

  child = spawn(process.execPath, [
    join(HARNESS, 'apps/cli/lib/bin.js'),
    'web', '--no-open', '--port', String(port),
  ], { cwd: HARNESS, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  child.on('exit', (code) => { exit = code ?? 0 })

  // 实测：这套组合（web app + better-sidebar + 工作台 + 建模中心 + 本插件）
  // 起来要 60–100s，45s 会误判成"没起来"（踩过两次）。给 150s。
  const first = await waitForPort(150000)
  if (first === null) {
    process.stdout.write('✗ 150s 内没起来\n')
    process.stdout.write(`--- stdout ---\n${stdout.slice(-2000)}\n--- stderr ---\n${stderr.slice(-4000)}\n`)
    process.exitCode = 1
  } else if (exit !== null) {
    process.stdout.write(`✗ 进程已退出（code ${exit}）—— boot 失败\n`)
    process.stdout.write(`--- stdout ---\n${stdout.slice(-2000)}\n--- stderr ---\n${stderr.slice(-4000)}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(`✓ 启动成功，端口 ${port} 在监听\n`)
    let failed = 0
    for (const path of [
      '/coords/api/meta',
      '/coords/api/sets',
      '/coords/api/templates',
      '/coords/api/events',
      '/coords/api/sample?mode=3d',
      '/coords/api/set?name=不存在',
    ]) {
      const result = await probe(path)
      const ok = result.status === 200 || (path.includes('不存在') && result.status === 404)
      if (!ok) failed += 1
      process.stdout.write(`  ${ok ? '✓' : '✗'} ${result.status} ${result.path}\n`)
      if (result.status === 200) process.stdout.write(`      ${result.body.replace(/\s+/g, ' ')}\n`)
    }
    // 方法不对应回 405，而不是 404
    const wrongMethod = await fetch(`http://127.0.0.1:${port}/coords/api/sets`, { method: 'POST' })
    if (wrongMethod.status !== 405) failed += 1
    process.stdout.write(`  ${wrongMethod.status === 405 ? '✓' : '✗'} ${wrongMethod.status} POST /sets（应 405）\n`)
    // 客户端产物也要能被取到（否则卡片根本没得加载）
    const clientBundle = await probe('/dsh-plugin/dsh-coords/client.js')
    process.stdout.write(`  · ${clientBundle.status} /dsh-plugin/dsh-coords/client.js（客户端产物，404 不影响 host 判定）\n`)
    process.stdout.write(failed === 0
      ? '\n结论：boot 干净、路由可用。可以把它挂回正在用的实例了。\n'
      : `\n结论：有 ${failed} 项不通过，先修再挂回。\n`)
    if (failed > 0) process.exitCode = 1
  }
} finally {
  if (child !== undefined && exit === null) {
    child.kill()
    await new Promise(resolve => setTimeout(resolve, 1500))
  }
  await restoreBundle()
  process.stdout.write('✓ 已还原 profile/package.json\n')
}
