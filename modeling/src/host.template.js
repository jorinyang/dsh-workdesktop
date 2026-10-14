/**
 * dsh-modeling host 半段入口 —— 由 scripts/build.mjs 从 src/index.js 与
 * src/modeling.mjs 生成，**请勿手改**。
 *
 * 结构：模板自带 import（生成物是真正的 Node ESM，`main` 直接可加载），
 * 之后依次内联「共用建模代数」与「host 主体（已剥掉自身 import/export 前缀）」。
 * 被内联的两段共用同一模块作用域，因此 `src/index.js` 里的 import 由本模板
 * 负责、内联时剥掉；漏掉任何一条都会在运行时报 "xxx is not defined"，
 * `selftest-build.mjs` 的 B-2 就是为这个坑准备的守卫。
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/* __INLINE_modeling.mjs__ */

/* __INLINE_index.js__ */
