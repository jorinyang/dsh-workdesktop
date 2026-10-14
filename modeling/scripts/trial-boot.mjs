/**
 * 隔离试运行：在**另一个端口**上把 web profile 连同 dsh-modeling 一起启动，
 * 验证它能干净启动、路由可用，然后收工 —— 全程不碰正在跑的 3080 实例。
 *
 * 为什么需要它：上一次 dsh-modeling 让整棵插件树在 boot 阶段崩掉，代价是
 * profile 的 bundle 行被自动摘掉 + 用户看到白屏。之后再改任何 host 半段，
 * 都应该先在隔离端口试一次，而不是直接塞回用户正在用的实例。
 *
 * 用法：
 *   node scripts/trial-boot.mjs                 # 试运行并报告
 *   node scripts/trial-boot.mjs --port 3181
 *
 * 安全性：临时改写 profile 的 package.json 前先备份，结束时**无条件还原**
 * （包括异常与超时路径）。
 */
import { execFile, spawn } from 'node:child_process'
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

/** 把 bundle 行临时加进 profile（依赖项应已存在）。 */
async function stageBundle() {
  const text = await readFile(profileJson, 'utf8')
  await writeFile(backup, text, 'utf8')
  const json = JSON.parse(text)
  const bundles = json.dsh?.profile?.bundles ?? []
  if (!bundles.includes(pluginName)) bundles.push(pluginName)
  if (json.dependencies?.[pluginName] === undefined) {
    throw new Error(`profile 依赖里没有 ${pluginName}；先 dsh plugin --profile web add ${pluginName}`)
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
    return { path, status: response.status, body: (await response.text()).slice(0, 120) }
  } catch (error) {
    return { path, status: 0, body: String(error.message) }
  }
}

/** 轮询端口直到有响应或超时。 */
async function waitForPort(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await probe('/modeling/api/profiles')
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
  process.stdout.write(`✓ 已临时把 ${pluginName} 挂进 profile bundles\n`)

  child = spawn(process.execPath, [
    join(process.env.DSH_HARNESS_ROOT ?? 'D:/deepseek-harness', 'apps/cli/lib/bin.js'),
    'web', '--no-open', '--port', String(port),
  ], { cwd: process.env.DSH_HARNESS_ROOT ?? 'D:/deepseek-harness', stdio: ['ignore', 'pipe', 'pipe'] })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  child.on('exit', (code) => { exit = code ?? 0 })

  const first = await waitForPort(45000)
  if (first === null) {
    process.stdout.write('✗ 45s 内没起来\n')
    process.stdout.write(`--- stdout ---\n${stdout.slice(-2000)}\n--- stderr ---\n${stderr.slice(-4000)}\n`)
    process.exitCode = 1
  } else if (exit !== null) {
    process.stdout.write(`✗ 进程已退出（code ${exit}）—— boot 失败\n`)
    process.stdout.write(`--- stdout ---\n${stdout.slice(-2000)}\n--- stderr ---\n${stderr.slice(-4000)}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(`✓ 启动成功，端口 ${port} 在监听\n`)
    for (const path of [
      '/modeling/api/profiles',
      '/modeling/api/meta',
      '/modeling/api/models?profile=methodology',
      '/modeling/api/model?profile=methodology&name=' + encodeURIComponent('方法论建模中心'),
      '/modeling/api/draft?profile=methodology',
    ]) {
      const result = await probe(path)
      const mark = result.status === 200 ? '✓' : result.status === 401 ? '·(需鉴权=路由在)' : '✗'
      process.stdout.write(`  ${mark} ${result.status} ${result.path}\n`)
      if (result.status === 200) process.stdout.write(`      ${result.body.replace(/\s+/g, ' ')}\n`)
    }
    // 方法不对应回 405，而不是 404
    const wrongMethod = await fetch(`http://127.0.0.1:${port}/modeling/api/profiles`, { method: 'POST' })
    process.stdout.write(`  ${wrongMethod.status === 405 ? '✓' : '✗'} ${wrongMethod.status} POST /profiles（应 405）\n`)
    process.stdout.write('\n结论：boot 干净、路由可用。可以把它挂回正在用的实例了。\n')
  }
} finally {
  if (child !== undefined && exit === null) {
    child.kill()
    await new Promise(resolve => setTimeout(resolve, 1500))
  }
  await restoreBundle()
  process.stdout.write(`✓ 已还原 profile/package.json\n`)
}
