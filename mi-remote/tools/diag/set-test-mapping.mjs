// set-test-mapping.mjs —— 把 4 个独有键配成"安全动作"，用来验证钩子这条路通不通。
//
// 为什么用安全动作：日志里的 button 字段就能告诉我是哪个键触发的，
// 而动作本身不会往外发消息（菜单键原本配的是 Enter，测试期会误发，所以换掉）。
import fs from 'node:fs'
import path from 'node:path'

const file = path.join(process.env.LOCALAPPDATA, 'dsh-mi-remote', 'mapping.json')
const mapping = JSON.parse(fs.readFileSync(file, 'utf8'))
const act = (id, label, combo) => ({ type: 'dsh', id, label, combo })

mapping.vkeys = { home: 36, menu: 93, tv: 192, power: 255, up: 38, down: 40, left: 37, right: 39, ok: 13 }
mapping.buttons.home = { click: act('dsh.searchSessions', '搜索会话', 'Ctrl+Alt+K'), double: null, hold: null }
mapping.buttons.menu = { click: act('dsh.toggleRight', '开关右侧栏', 'Ctrl+Shift+B'), double: null, hold: null }
mapping.buttons.tv = { click: act('dsh.toggleLeft', '开关左侧栏', 'Ctrl+Alt+B'), double: null, hold: null }
mapping.buttons.power = { click: act('dsh.openWorkspace', '打开工作区', 'Ctrl+Alt+O'), double: null, hold: null }
mapping.updatedAt = new Date().toISOString()

fs.writeFileSync(file, JSON.stringify(mapping, null, 2), 'utf8')

console.log('test mapping written:')
for (const id of ['home', 'menu', 'tv', 'power']) {
  const a = mapping.buttons[id].click
  console.log(`  ${id.padEnd(6)} -> ${a.label}  (${a.combo})`)
}
console.log(`  vkeys  -> ${JSON.stringify(mapping.vkeys)}`)
