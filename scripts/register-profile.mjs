/**
 * 把 `dsh-pet-ds` 登记进 DSH 的 profile 配置。
 *
 * 用法：node register-profile.mjs <profileDir> <包体.tgz 或插件目录>
 *
 * 改 profile 的 `package.json` **两处**：
 *   · `dsh.profile.bundles` 加入包名（这是 DSH 认插件的**唯一依据**）
 *   · `dependencies[包名]` 指向包体（`file:` + 路径）
 *
 * 改之前会备份成 `package.json.bak-before-<包名>`。
 *
 * ## 为什么单独一个文件
 *
 * 这段逻辑原先内联在 `install-pet.cmd` 的 `node -e "..."` 里，
 * 结果 cmd.exe 的引号/百分号转义把脚本**截断**了（实测 `Expected ')',`）。
 * 内联 JS 在 .cmd 里就是自找麻烦 —— 抽成文件后，三处调用者
 * （.cmd / .ps1 / installer）可以共用同一份实现，也不会再被转义搞坏。
 *
 * ## 为什么与 installer/Setup.cs 是两份实现
 *
 * 语言不同（C# 与 JS），没法共用代码。但两者改的是**同样的两个字段**，
 * 且都用**保守的文本/结构改写**并**先备份**。改这里时记得同步那边。
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const log = (m) => console.log(m)

const [profileDirArg, targetArg, nameArg] = process.argv.slice(2)
const PLUGIN_NAME = nameArg ?? 'dsh-pet-ds'

if (!profileDirArg || !targetArg) {
  log('用法：node register-profile.mjs <profileDir> <包体.tgz 或插件目录> [包名]')
  process.exit(2)
}

const profileDir = resolve(profileDirArg)
const target = resolve(targetArg)
const profileJson = join(profileDir, 'package.json')

if (!existsSync(profileJson)) {
  log(`✗ profile 里没有 package.json：${profileJson}`)
  process.exit(1)
}
if (!existsSync(target)) {
  log(`✗ 找不到包体/插件目录：${target}`)
  process.exit(1)
}

const original = readFileSync(profileJson, 'utf8')

let config
try {
  config = JSON.parse(original)
} catch (err) {
  /*
   * 解析失败就**直接退出，一个字节都不写** ——
   * 拿着坏 JSON 去"修补"只会把用户的配置弄更坏。
   */
  log(`✗ profile 的 package.json 不是合法 JSON，未做任何修改：${err.message}`)
  process.exit(1)
}

/* 备份（已存在就不覆盖，避免把最早那份好配置冲掉） */
const backup = profileJson + `.bak-before-${PLUGIN_NAME}`
if (!existsSync(backup)) {
  copyFileSync(profileJson, backup)
  log(`  已备份原配置：${backup.split(/[\\/]/).pop()}`)
} else {
  log(`  备份已存在，未覆盖：${backup.split(/[\\/]/).pop()}`)
}

/* ---- 1) bundles ---- */
config.dsh ??= {}
config.dsh.profile ??= {}
config.dsh.profile.bundles ??= []
const bundles = config.dsh.profile.bundles
const hadBundle = bundles.includes(PLUGIN_NAME)
if (!hadBundle) bundles.push(PLUGIN_NAME)

/* ---- 2) dependencies ---- */
config.dependencies ??= {}
/*
 * 用 `file:` + 绝对路径（正斜杠，pnpm 在 Windows 上认这个）。
 * 与 installer/Setup.cs 的写法保持一致。
 */
const depValue = 'file:' + target.replace(/\\/g, '/')
const prevDep = config.dependencies[PLUGIN_NAME]
config.dependencies[PLUGIN_NAME] = depValue

/* 写回（2 空格缩进，与 profile 的既有风格一致；无 BOM） */
writeFileSync(profileJson, JSON.stringify(config, null, 2) + '\n', 'utf8')

log(`  bundles      ：${hadBundle ? '已存在' : '已加入'} ${PLUGIN_NAME}`)
log(`  dependencies ：${prevDep ? prevDep + ' → ' : ''}${depValue}`)
log('  ✓ 登记完成（重启 DSH 后生效）')
