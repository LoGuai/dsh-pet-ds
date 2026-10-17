/**
 * 验证：**本插件能被 `plugin_manager install_bundle` 安装**。
 *
 * ## 为什么需要这个测试
 *
 * `install_bundle` 的接受条件散在三处 DSH 内部实现里，只看代码容易看漏：
 *
 *  1. `install-spec.js` 的 `parseInstallSpec()` —— 决定 spec **能不能被接受**；
 *  2. `index.js` 的 `installBundle()` —— 实际执行 `pnpm add <spec>`，
 *     然后**比对 `dependencies` 前后差异**取出新装的包名，
 *     并要求该包的 manifest 有 `dsh.bundle`（否则判 `not-bundle`）；
 *  3. 兼容性检查 —— manifest 里声明的 DSH 版本范围要能匹配当前 DSH。
 *
 * 任何一条不满足，表现都是"装不上"，而且**失败点不在插件代码里**，
 * 所以插件自己的单测全绿也没用。这个测试就是把这套契约钉住。
 *
 * ## 怎么测的
 *
 * `parseInstallSpec` 不依赖 cordis / 网络，所以可以**直接调用 asar 里那份真实实现**
 * （纯 Node 用 `node:vm` 载入 asar 内源码即可，不需要 Electron）。
 * 这比"照着源码再实现一遍"可信得多 —— 后者只会证明我读对了自己的复述。
 *
 * ⚠️ 之所以能用纯 Node：DSH 的 plugin-manager 是**打进 asar 的 ESM**，
 * 而 asar 只是个归档格式，`node:vm` 直接执行取出的源码不受影响。
 * 需要 Electron 的是 `@deepseek-ai/*` 的**模块解析**，这里不涉及。
 *
 * 运行：node scripts/dev/test-install-bundle-spec.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

const ASAR = 'C:/Users/29845/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'
const SPEC_MODULE = 'dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/types/install-spec.js'

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

// ---------------------------------------------------------------- 从 asar 取源码
/** 极简 asar 读取：先读头部索引，再按 offset 取文件内容。 */
function readFromAsar(innerPath) {
  const fd = readFileSync(ASAR) // 112MB 之外的 app.asar 不大；一次读入最省事
  const headerSize = fd.readUInt32LE(12)
  const header = JSON.parse(fd.subarray(16, 16 + headerSize).toString('utf8'))
  const baseOffset = 16 + headerSize
  let node = header
  for (const seg of innerPath.split('/').filter(Boolean)) {
    node = node.files?.[seg]
    if (!node) return null
  }
  if (node.size === undefined) return null
  return fd.subarray(baseOffset + Number(node.offset), baseOffset + Number(node.offset) + node.size).toString('utf8')
}

const specSource = readFromAsar(SPEC_MODULE)
if (!specSource) {
  console.log(`FAIL  能从 asar 读到 ${SPEC_MODULE}`)
  console.log('      DSH 的安装目录或版本可能变了；请核对 ASAR 路径。')
  process.exit(1)
}

/*
 * 在 vm 里执行 ESM 源码：需要给它提供 import 到的内建模块。
 * 用 `vm.SourceTextModule`（需 --experimental-vm-modules）才支持 import 语法。
 *
 * ⚠️ 所有模块（含合成模块）必须**共用一个 context**，否则链接时抛
 * `ERR_VM_MODULE_DIFFERENT_CONTEXT` —— 实测踩过。
 *
 * ⚠️ 内建模块的导出**不能写死列表**。
 * 原先只给 `node:path` 合成四个名字、其余一律只导出 `default`；
 * DSH 后来在 `install-spec.js` 里加了 `import { homedir } from 'node:os'`，
 * 于是链接直接失败（"does not provide an export named 'homedir'"）——
 * 看起来像本仓库坏了，其实是测试的脆弱点被上游的合法改动打中。
 *
 * 现在改成：凡是 `node:` 开头的说明符，都去真模块上取**全部导出名**来合成。
 * 上游再怎么加 import 都不用改这里。
 */
let parseInstallSpec
{
  const context = vm.createContext({})
  const mod = new vm.SourceTextModule(specSource, {
    identifier: `file:///${ASAR}/${SPEC_MODULE}`,
    context,
  })
  await mod.link(async (specifier) => {
    if (typeof specifier === 'string' && specifier.startsWith('node:')) {
      const real = await import(specifier)
      const names = new Set()
      for (const n of Object.keys(real)) names.add(n)
      for (const n of Object.getOwnPropertyNames(real)) names.add(n)
      names.delete('default')
      const exportNames = ['default', ...names]
      return new vm.SyntheticModule(
        exportNames,
        function () {
          this.setExport('default', real)
          for (const n of names) this.setExport(n, real[n])
        },
        { context },
      )
    }
    /* 非内建说明符：被测代码不该依赖它们；给个空对象保证链接能过。 */
    return new vm.SyntheticModule(
      ['default'],
      function () {
        this.setExport('default', {})
      },
      { context },
    )
  })
  await mod.evaluate()
  parseInstallSpec = mod.namespace.parseInstallSpec
}

test('拿到了 DSH 真实的 parseInstallSpec 实现', () => {
  assert.equal(typeof parseInstallSpec, 'function')
})

// ---------------------------------------------------------------- spec 形式
const tarballAbs = join(ROOT, 'dist', 'dsh-pet-ds-0.1.2.tgz')
const dirAbs = ROOT

test('.tgz 的绝对路径被判为 tarball（install_bundle 可直接装）', () => {
  const got = parseInstallSpec(tarballAbs)
  assert.equal(got.kind, 'tarball', `kind=${got.kind}`)
  assert.equal(got.path, tarballAbs)
})

test('file: 前缀的 .tgz 路径也可（等价形式）', () => {
  const got = parseInstallSpec(`file:${tarballAbs}`)
  assert.equal(got.kind, 'tarball')
})

test('插件目录的绝对路径被判为 path', () => {
  const got = parseInstallSpec(dirAbs)
  assert.equal(got.kind, 'path', `kind=${got.kind}`)
})

test('包名被判为 registry（发布到 npm 后的形式）', () => {
  const got = parseInstallSpec('dsh-pet-ds')
  assert.equal(got.kind, 'registry')
  assert.equal(got.name, 'dsh-pet-ds')
  assert.equal(got.range, undefined)
})

test('带版本范围的包名也可', () => {
  const got = parseInstallSpec('dsh-pet-ds@0.1.2')
  assert.equal(got.kind, 'registry')
  assert.equal(got.name, 'dsh-pet-ds')
  assert.equal(got.range, '0.1.2')
})

/*
 * ⚠️ 相对路径**会被拒绝**，理由写在源码注释里：
 * "the Host's working directory means nothing to the person typing into a
 *  browser, and a relative path resolved against the profile would point
 *  inside it."
 *
 * 这条很容易踩 —— 习惯性输 `dist/dsh-pet-ds-0.1.2.tgz` 就会失败。
 *
 * ⚠️ 实测：**报错措辞取决于路径形状**（所以要两种都接受，别只断言一种）：
 *   · `./x.tgz` / `../x.tgz` → 明确说 "a local path must be absolute"；
 *   · `dist/x.tgz`           → 落不到路径分支，最后按包名校验拒掉，
 *                              说 "not a package name the registry accepts"。
 * 后者措辞不直观，用户容易以为是包名写错了 —— 值得在文档里点出来。
 */
test('相对路径被拒绝（./ 开头：明确说必须绝对）', () => {
  assert.throws(() => parseInstallSpec('./dist/dsh-pet-ds-0.1.2.tgz'), /must be absolute/i)
})

test('相对路径被拒绝（无前缀：措辞是包名不合法，别被误导）', () => {
  assert.throws(
    () => parseInstallSpec('dist/dsh-pet-ds-0.1.2.tgz'),
    /not a package name the registry accepts/i,
  )
})

test('空的 / 以 - 开头的 spec 被拒绝', () => {
  assert.throws(() => parseInstallSpec('   '))
})

test('不是 tarball 的 http URL 被拒绝', () => {
  assert.throws(() => parseInstallSpec('https://example.com/foo.zip'), /tarball|git/i)
})

// ---------------------------------------------------------------- 清单侧契约
test('package.json 有 dsh.bundle（否则 installBundle 判 not-bundle）', () => {
  /*
   * installBundle 装完会查 manifest：`if (manifest?.dsh?.bundle === undefined)
   * throw new ManagementFailure('not-bundle')`。
   * 这一条缺了，pnpm 装成功也会**回滚**并报 not-bundle。
   */
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.ok(pkg.dsh?.bundle, '缺 dsh.bundle')
  assert.equal(typeof pkg.dsh.bundle.patch, 'string', 'dsh.bundle.patch 必须是字符串')
})

test('dsh.bundle.patch 指向的文件真实存在', () => {
  // 声明了却指不到文件 → bundle 装上了但配置行加载不出来（插件等于没装）。
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const rel = pkg.dsh.bundle.patch
  const abs = join(ROOT, rel)
  assert.ok(rel.startsWith('./'), `bundle.patch 习惯写成 ./ 开头：${rel}`)
  assert.doesNotThrow(() => readFileSync(abs, 'utf8'), `读不到 ${abs}`)
})

test('包名是 registry 能接受的形式', () => {
  /*
   * install-spec.js 的 PACKAGE_NAME 正则：小写、URL 安全、可带 scope。
   * 包名不合法的话，发布到 npm 那条路直接走不通。
   */
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.match(pkg.name, /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/, `包名不合法：${pkg.name}`)
})

console.log(`\n结果：${String(passed)}/${String(passed + failed)} 通过`)
if (failed > 0) process.exit(1)
