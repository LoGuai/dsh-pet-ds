/**
 * 安装器的单元测试。
 *
 * 测的是**决定"DSH 认不认这个插件"的那部分逻辑**（对 profile package.json
 * 的变换）。为什么值得单测：写错的表现是"DSH 里看不到插件" ——
 * 而装完是"成功"的，没有报错、没有日志，非常难往回查。
 *
 * 运行：node scripts/dev/test-install.mjs
 */

import assert from 'node:assert/strict'

import { applyInstallToPackageJson } from '../install.mjs'

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`PASS  ${name}`)
  } catch (err) {
    failed += 1
    console.log(`FAIL  ${name}`)
    console.log(`      ${err instanceof Error ? err.message : String(err)}`)
  }
}

const NAME = 'dsh-pet-ds'
const ROOT = 'D:\\dsh\\pet'

// ---------------------------------------------------------------- 安装

test('空 profile（只有 name）能被补全结构', () => {
  const pkg = { name: 'dsh-profile-test', private: true }
  applyInstallToPackageJson(pkg, { pluginName: NAME, pluginRoot: ROOT })
  assert.deepEqual(pkg.dsh.profile.bundles, [NAME])
  assert.equal(pkg.dependencies[NAME], 'file:D:/dsh/pet')
})

test('依赖路径是绝对 file: 且用正斜杠', () => {
  /*
   * 两条都是踩过的坑：
   *  · 相对路径跨盘解析会失败（profile 与仓库常不在同一个盘）；
   *  · 反斜杠在 npm 依赖说明符里是转义字符。
   */
  const pkg = {}
  applyInstallToPackageJson(pkg, { pluginName: NAME, pluginRoot: ROOT })
  const dep = pkg.dependencies[NAME]
  assert.ok(dep.startsWith('file:'), `应以 file: 开头：${dep}`)
  assert.ok(!dep.includes('\\'), `不该含反斜杠：${dep}`)
  assert.ok(/^file:[A-Za-z]:\//.test(dep), `应是绝对盘符路径：${dep}`)
})

test('重复安装是幂等的（bundles 不会出现两次）', () => {
  /*
   * ⚠️ 这条很要紧：bundles 里重复会让 DSH 把同一层 patch 叠两次。
   * 而用户重跑安装器是常事（改了路径、重装依赖）。
   */
  const pkg = {}
  applyInstallToPackageJson(pkg, { pluginName: NAME, pluginRoot: ROOT })
  applyInstallToPackageJson(pkg, { pluginName: NAME, pluginRoot: ROOT })
  applyInstallToPackageJson(pkg, { pluginName: NAME, pluginRoot: ROOT })
  assert.equal(pkg.dsh.profile.bundles.filter((b) => b === NAME).length, 1)
})

test('不破坏已有的其它 bundle 与依赖', () => {
  const pkg = {
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    dependencies: { '@deepseek-ai/dsh-base': '1.0.0' },
  }
  applyInstallToPackageJson(pkg, { pluginName: NAME, pluginRoot: ROOT })
  assert.deepEqual(pkg.dsh.profile.bundles.slice(0, 2), ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  assert.equal(pkg.dsh.profile.bundles[2], NAME)
  assert.equal(pkg.dependencies['@deepseek-ai/dsh-base'], '1.0.0')
})

test('bundles 是空数组时能正常追加', () => {
  const pkg = { dsh: { profile: { bundles: [] } }, dependencies: {} }
  applyInstallToPackageJson(pkg, { pluginName: NAME, pluginRoot: ROOT })
  assert.deepEqual(pkg.dsh.profile.bundles, [NAME])
})

test('dsh.profile 存在但缺 bundles 字段时能补上', () => {
  const pkg = { dsh: { profile: {} } }
  applyInstallToPackageJson(pkg, { pluginName: NAME, pluginRoot: ROOT })
  assert.deepEqual(pkg.dsh.profile.bundles, [NAME])
})

// ---------------------------------------------------------------- 卸载

test('卸载会同时移除 bundle 与依赖', () => {
  const pkg = {}
  applyInstallToPackageJson(pkg, { pluginName: NAME, pluginRoot: ROOT })
  applyInstallToPackageJson(pkg, { pluginName: NAME, pluginRoot: ROOT, uninstall: true })
  assert.deepEqual(pkg.dsh.profile.bundles, [])
  assert.equal(pkg.dependencies[NAME], undefined)
  assert.ok(!(NAME in pkg.dependencies), '依赖键应被彻底删掉，而不是留个 undefined')
})

test('卸载不会误删别的 bundle', () => {
  const pkg = {
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', NAME, 'dshmarket'] } },
    dependencies: { [NAME]: 'file:x', dshmarket: '^1.0.0' },
  }
  applyInstallToPackageJson(pkg, { pluginName: NAME, pluginRoot: ROOT, uninstall: true })
  assert.deepEqual(pkg.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dshmarket'])
  assert.equal(pkg.dependencies.dshmarket, '^1.0.0')
})

test('对没装过的 profile 执行卸载是安全的', () => {
  const pkg = { dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }
  applyInstallToPackageJson(pkg, { pluginName: NAME, pluginRoot: ROOT, uninstall: true })
  assert.deepEqual(pkg.dsh.profile.bundles, ['@deepseek-ai/dsh-base'])
})

test('装 → 卸 → 装 能回到可用状态', () => {
  const pkg = {}
  applyInstallToPackageJson(pkg, { pluginName: NAME, pluginRoot: ROOT })
  applyInstallToPackageJson(pkg, { pluginName: NAME, pluginRoot: ROOT, uninstall: true })
  applyInstallToPackageJson(pkg, { pluginName: NAME, pluginRoot: ROOT })
  assert.deepEqual(pkg.dsh.profile.bundles, [NAME])
  assert.equal(pkg.dependencies[NAME], 'file:D:/dsh/pet')
})

// ---------------------------------------------------------------- 序列化

test('变换后的对象能被 JSON 序列化并原样解析回来', () => {
  // 缓存/落盘都靠 JSON，确保没有 undefined / 函数之类不可序列化的东西混进去。
  const pkg = { name: 'x' }
  applyInstallToPackageJson(pkg, { pluginName: NAME, pluginRoot: ROOT })
  const round = JSON.parse(JSON.stringify(pkg))
  assert.deepEqual(round, pkg)
})

test('路径含空格时也应保持可序列化（不破坏 JSON）', () => {
  const pkg = {}
  applyInstallToPackageJson(pkg, { pluginName: NAME, pluginRoot: 'C:\\Program Files\\dsh pet' })
  assert.equal(pkg.dependencies[NAME], 'file:C:/Program Files/dsh pet')
  const round = JSON.parse(JSON.stringify(pkg))
  assert.equal(round.dependencies[NAME], 'file:C:/Program Files/dsh pet')
})

console.log(`\n结果：${String(passed)}/${String(passed + failed)} 通过`)
if (failed > 0) process.exit(1)
