/**
 * 一次性布置：「工程图」工作区 + 一个开箱可看的起始工程。
 *
 * 用法：node setup-workspace.mjs
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(HERE, '..')
const REPO = process.env.DSH_WORKDESKTOP_PROJECT_GRAPH_REPO || join(homedir(), 'Desktop', 'DSH', 'project-graph')
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PG_HOME = join(DSH_HOME, '.dsh-project-graph')
const PROJECTS = join(PG_HOME, 'projects')
const BIN = join(PG_HOME, 'bin')
const HELPER = join(BIN, 'project-graph-ownership-helper.exe')
const CLI = join(REPO, 'packages', 'project-graph-cli', 'src', 'cli.mjs')
const SEED = join(PLUGIN_ROOT, 'pg-helper', 'empty-project.prg')

mkdirSync(PROJECTS, { recursive: true })
mkdirSync(BIN, { recursive: true })
if (!existsSync(join(BIN, 'empty-project.prg'))) copyFileSync(SEED, join(BIN, 'empty-project.prg'))

// 所有权 helper：与 host 半段 `pgEnsureHelper()` 同一条命令（源码是唯一真相，
// exe 只是这台机器的运行产物）。已经编过且不比源码旧就跳过。
const CSC = process.env.DSH_WORKDESKTOP_CSC || 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'
const HELPER_SRC = join(PLUGIN_ROOT, 'pg-helper', 'ProjectGraphOwnershipHelper.cs')
await new Promise((resolve, reject) => {
  const child = spawn(CSC, [
    '/nologo', '/target:exe', '/optimize+', '/r:System.Web.Extensions.dll',
    `/out:${HELPER}`, HELPER_SRC,
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let err = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (c) => { err += c })
  child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`编译 helper 失败：${err.slice(0, 400)}`))))
})

console.log(`工作区 : ${PG_HOME}`)
console.log(`工程目录: ${PROJECTS}`)
console.log(`helper : ${HELPER}`)

const starter = join(PROJECTS, '工作台工程图.prg')

function cli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--', ...args], {
      cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, PROJECT_GRAPH_OWNERSHIP_HELPER_PATH: HELPER },
    })
    let stdout = ''; let stderr = ''
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}
async function invoke(tool, input) {
  const r = await cli(['tool', 'invoke', tool, '--project', starter, '--input', JSON.stringify(input)])
  if (r.code !== 0) throw new Error(`${tool} exit=${r.code} ${r.stderr.slice(0, 300)}`)
  return r.stdout.trim() === '' ? null : JSON.parse(r.stdout)
}

if (existsSync(starter)) {
  console.log('起始工程已存在，跳过创建')
} else {
  copyFileSync(SEED, starter)
  await invoke('get_all_nodes', {})                       // 先分配引用，n1 才是真的
  await invoke('edit_text_node', { ref: 'n1', data: { text: '工作台' } })
  await invoke('expand_node_tree_from_node', {
    ref: 'n1',
    text: '驾驶舱\n  系统状态\n  今日决策\n坐标系\n  2D 四象限\n  3D 点云\n建模中心\n  节点\n  连线\n工程图\n  节点与连线\n  增删改（走 CLI）',
  })
  console.log('起始工程已建好')
}

const after = await invoke('get_all_nodes', {})
const objs = Array.isArray(after.objects) ? after.objects : []
console.log(`对象数 : ${objs.length}（节点 ${objs.filter((o) => /^n/.test(o.ref)).length} · 连线 ${objs.filter((o) => /^e/.test(o.ref)).length}）`)
console.log(objs.map((o) => `  ${o.ref.padEnd(4)} ${o.type.padEnd(9)} ${o.text || ''}`).join('\n'))
