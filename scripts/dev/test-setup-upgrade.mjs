/**
 * 验证 setup.exe 的**升级路径**：装新版本前先清掉旧版本文件。
 *
 * 用户要求：「安装新版本时先移除旧版本文件，不用手动提前卸载旧版本」。
 *
 * 覆盖两件事：
 *  1. **正常升级**：旧安装目录里"只在旧版存在"的文件必须消失，
 *     新版本要就位，而**用户配置**（在 DSH_HOME 下，不在安装目录里）必须保留；
 *  2. **安全边界**：目标目录非空、但**不是**以前的桌宠目录时，
 *     安装器必须**拒绝**而不是无脑清空（否则用户选错目录就是灾难）。
 *
 * 载荷是"叠加解压"的，所以第 1 条不清就会留下旧文件 ——
 * 那种残留最难查：装的是新版、跑的还是旧代码。
 *
 * 用法：node scripts/dev/test-setup-upgrade.mjs
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

import { runSetup } from './setup-runner.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

const SETUP = join(ROOT, 'dist', 'setup-noelevate.exe')

let failed = 0
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

if (!existsSync(SETUP)) {
  console.log(`✗ 找不到测试用的安装程序：${SETUP}`)
  console.log('  先运行：node scripts/dev/build-installer.mjs')
  process.exit(1)
}

const sandbox = join(ROOT, '.cache', 'setup-upgrade-test')
const home = join(sandbox, 'home')
const profileDir = join(home, 'profiles', 'desktop')
const targetDir = join(sandbox, 'install')
const foreignDir = join(sandbox, 'not-a-pet-dir')
rmSync(sandbox, { recursive: true, force: true })
mkdirSync(profileDir, { recursive: true })

/* ---- 1) 造一个"旧版本安装目录" ----
 *
 * ⚠️ 注意路径：安装器把插件装在 `<目标目录>\dsh-pet-ds\`（`baseDir + SubDirName`），
 * 而**不是**目标目录本身（目标目录是用户选的"安装到哪"，里面会放一个以包名命名的子目录）。
 * 第一版把旧文件造在了目标目录根部，于是断言全红 —— 其实是测试造错了位置。
 */
const realPluginDir = join(targetDir, 'dsh-pet-ds')
mkdirSync(realPluginDir, { recursive: true })
writeFileSync(
  join(realPluginDir, 'package.json'),
  JSON.stringify({ name: 'dsh-pet-ds', version: '0.0.9' }, null, 2),
  'utf8',
)
const staleFile = join(realPluginDir, 'STALE-ONLY-IN-0.0.9.txt')
writeFileSync(staleFile, 'stale', 'utf8')
const staleDir = join(realPluginDir, 'assets', 'animations', 'removed-in-020')
mkdirSync(staleDir, { recursive: true })
writeFileSync(join(staleDir, 'frame_01.png'), 'stale', 'utf8')

/* ---- 2) 造"用户配置"（在 DSH_HOME 下，升级必须保留）---- */
const userDataDir = join(home, 'dsh-pet-ds')
mkdirSync(userDataDir, { recursive: true })
const userConfig = join(userDataDir, 'pet-config.json')
writeFileSync(userConfig, JSON.stringify({ petWidth: 240, marker: 'keep-me' }), 'utf8')

/*
 * ---- 3) 造一个"不是我们的"安装子目录（应当被拒绝）----
 *
 * ⚠️ 注意位置：安装器只在 `<目标目录>\dsh-pet-ds\` 里干活，**从不碰目标目录本身**。
 * 所以"误删风险"只存在于那个**子目录**里 —— 如果它里面已经有别人的文件
 * （例如上一个用户把别的东西放进了这个同名目录），必须拒绝而不是清空。
 * 第一版把文件放在目标目录根部，于是安装器根本不会碰它，断言自然不成立。
 */
const foreignPluginDir = join(foreignDir, 'dsh-pet-ds')
mkdirSync(foreignPluginDir, { recursive: true })
const foreignFile = join(foreignPluginDir, '我的重要文件.txt')
writeFileSync(foreignFile, 'do not delete me', 'utf8')

/* ---- 4) 让安装器能找到 pnpm，并跳过 Electron（预置"已安装"）---- */
writeFileSync(
  join(profileDir, 'package.json'),
  JSON.stringify(
    {
      name: 'dsh-profile-desktop',
      private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
      dependencies: {},
    },
    null,
    2,
  ),
  'utf8',
)
const realRuntimes = join(process.env.USERPROFILE ?? '', '.dsh', 'dsh-runtimes')
if (existsSync(realRuntimes)) {
  execFileSync('cmd', ['/c', 'mklink', '/J', join(home, 'dsh-runtimes'), realRuntimes], { stdio: 'ignore' })
}
const seededElectron = join(home, 'electron', 'electron-v38.2.0-win32-x64')
mkdirSync(seededElectron, { recursive: true })
writeFileSync(join(seededElectron, 'electron.exe'), 'stub', 'utf8')

/* ---- 5) 跑安装（升级到当前版本）---- */
console.log('')
console.log('  运行 setup.exe --silent（模拟升级安装）…')
const { output } = await runSetup({
  setup: SETUP,
  /*
   * `--elevated` 必须在**最后**：非管理员进程里安装器会走 TryElevate
   * （runas 重启自己然后父进程退出），这个参数是那条路径的"已重试"标记。
   * 手工加上就能让非提权版在本进程里跑完，安装逻辑完全相同。
   */
  args: ['--silent', targetDir, '--elevated'],
  env: { DSH_HOME: home, DSH_PROFILE: 'desktop' },
  workDir: sandbox,
  timeoutMs: 900000,
})

console.log('')
/*
 * 把安装器输出打出来（截尾 40 行）。
 *
 * 为什么常开而不是只在失败时打：`setup.exe` 是 GUI 子系统，
 * "什么都没输出"本身就是最常见的一种故障现象（例如它被提权重启后父进程直接退出）。
 * 断言前先看到原始输出，排查快得多 —— 我第一次就是对着空的断言发呆。
 */
{
  const lines = String(output).split(/\r?\n/).filter((l) => l.trim())
  console.log(`  ---- 安装器输出（共 ${String(lines.length)} 行，显示末尾 40 行）----`)
  for (const l of lines.slice(-40)) console.log(`  | ${l}`)
  console.log('  ---- 输出结束 ----')
}
console.log('')
console.log('  === 断言：正常升级 ===')
/*
 * ⚠️ 断言用 **ASCII 标签**（`[upgrade]` / `[refuse]`），不要匹配中文。
 *
 * 原因：安装器的输出要经过「C# 控制台代码页 → PowerShell 解码 → 重定向文件 → Node 读取」
 * 好几层，中文在任一层的编码不一致都会变成乱码，而 utf8 解码 GBK 字节会**丢信息**
 * （变成 `�`，事后无法还原）。实测为此折腾了两轮。
 * ASCII 标签与区域设置无关，也让用户 grep 日志更稳。中文提示仍然照常输出。
 */
check('安装器识别到了旧版本', /\[upgrade\]/.test(output), '输出里没有 [upgrade] 标签')
check('旧版本独有的文件已被清除', !existsSync(staleFile), staleFile)
check('旧版本独有的目录已被清除', !existsSync(staleDir), staleDir)
check('新版本已就位（package.json 存在）', existsSync(join(realPluginDir, 'package.json')), realPluginDir)

let version = null
if (existsSync(join(realPluginDir, 'package.json'))) {
  try {
    version = JSON.parse(readFileSync(join(realPluginDir, 'package.json'), 'utf8')).version
  } catch {
    version = null
  }
}
check('装好的版本不再是旧的 0.0.9', Boolean(version) && version !== '0.0.9', `实际 ${String(version)}`)
check('用户配置在升级后仍在', existsSync(userConfig), userConfig)
let configKept = false
if (existsSync(userConfig)) {
  try {
    configKept = readFileSync(userConfig, 'utf8').includes('keep-me')
  } catch {
    configKept = false
  }
}
check('用户配置内容未被改动', configKept, '配置内容变了（升级不该动用户数据）')

/* ---- 6) 安全边界：非桌宠的非空目录必须被拒绝 ---- */
console.log('')
console.log('  运行 setup.exe --silent（目标是一个非桌宠的非空目录）…')
const foreign = await runSetup({
  setup: SETUP,
  args: ['--silent', foreignDir, '--elevated'],
  env: { DSH_HOME: home, DSH_PROFILE: 'desktop' },
  workDir: sandbox,
  timeoutMs: 300000,
})

console.log('')
console.log('  === 断言：安全边界 ===')
check(
  '非桌宠的非空目录被拒绝（给出了可读原因）',
  /\[refuse\]/.test(foreign.output),
  '输出里没有 [refuse] 标签',
)
check('那个目录里的用户文件没被删', existsSync(foreignFile), foreignFile)
check(
  '也没有往那个目录里解压（不应出现 package.json）',
  !existsSync(join(foreignDir, 'package.json')),
  join(foreignDir, 'package.json'),
)

rmSync(sandbox, { recursive: true, force: true })

console.log('')
console.log(failed === 0 ? '结果：升级路径与安全边界全部通过' : `结果：${String(failed)} 项未通过`)
process.exit(failed === 0 ? 0 : 1)
