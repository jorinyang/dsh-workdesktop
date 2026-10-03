/**
 * dsh-coords host 半段入口模板。
 *
 * 生成物 `lib/index.js` 是**真正的 Node ESM**：Cordis 要能读到具名的
 * `name` / `apply` / `inject`，所以被内联的 `src/index.js` 保留 export，
 * 只剥掉它自带的 import —— 那些符号由这里的 import 提供。
 * 少一条 import 的症状是运行时报 "xxx is not defined"，与"构建吞了源码"同形。
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'

/* __INLINE_coords.mjs__ */

/* __INLINE_index.js__ */
