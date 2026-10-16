/**
 * 客户端设置栏的**运行期**冒烟测试。
 *
 * ## 为什么需要（语法检查不够）
 *
 * 客户端是 `window.__ModuleLoader__.load({...})` 外壳，语法检查只能证明
 * "括号配对"。真正会坏的地方在**运行期**：
 *  · `inject` 列表里少写一个服务名 → 插件永远不激活；
 *  · `slots.register` 的选项名写错 → 槽位注册不上，页面静默不出现；
 *  · 表单的保存逻辑组错 ops → DSH 拒绝写入（`Config field "x" is not volatile`）；
 *  · `unset` 用错 → 用户点"恢复默认"反而在 profile 里留下一行冗余覆盖。
 *
 * 这些都不会报语法错，而在浏览器里排查要开 DevTools。所以这里用
 * **Node VM + 最小 DOM/React 桩**把外壳、`apply()` 与表单逻辑真跑一遍。
 *
 * ⚠️ 这不是浏览器渲染测试 —— 它不验证"画出来好不好看"。
 * 它验证的是"接线对不对、保存时发出去的请求对不对"。
 *
 * 运行：node scripts/dev/test-client-smoke.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const CLIENT_FILE = join(ROOT, 'client', 'client.js')

let passed = 0
let failed = 0

/**
 * 收集所有测试，最后**串行 await**。
 *
 * ⚠️ 为什么要收集而不是直接跑：`it()` 对 async 函数返回 Promise，
 * 而顶层若不 await，异步测试会在"结果：x/y 通过"打印**之后**才跑完 ——
 * 于是失败被吞掉、退出码还是 0（实测踩过这个假绿）。
 */
const queued = []
function it(name, fn) {
  queued.push({ name, fn })
}

/**
 * 跨 realm 的结构比较。
 *
 * 客户端代码跑在 `vm` 创建的另一个 realm 里，它造出来的数组/对象原型不同 ——
 * `assert.deepEqual` 会抛 "Values have same structure but are not reference-equal"。
 * 用 JSON 字符串比较绕开这一点。
 */
function sameJson(actual, expected, message) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  assert.equal(a, b, message ?? `期望 ${b}，实际 ${a}`)
}

// ------------------------------------------------------------------ DOM / React 桩

/** 极简 DOM 桩：只够 `ensureStyle()` 跑通。 */
function makeDocument() {
  const created = []
  return {
    _created: created,
    head: {
      appendChild: (node) => created.push(node),
    },
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
  }
}

/**
 * 极简 React 桩。
 *
 * `createElement` 只记录调用，不真渲染 —— 我们要测的是表单模型与接线，
 * 不是渲染结果。
 *
 * `useSyncExternalStore` 立刻调用 `getSnapshot`（像真 React 那样），
 * 这样能顺带验证快照读取器不会抛错。
 */
function makeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useSyncExternalStore: (subscribe, getSnapshot) => {
      // 订阅再退订一次：验证 subscribe 的返回真的是可调用的退订函数。
      const off = subscribe(() => {})
      getSnapshot()
      if (typeof off === 'function') off()
      return getSnapshot()
    },
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
  }
}

// ------------------------------------------------------------------ 加载客户端

/** 抓一次模块表的注册。 */
function loadClient(extraRequire = {}) {
  const document = makeDocument()
  const react = makeReact()
  let registration = null

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (spec) => {
          registration = spec
        },
      },
    },
    document,
    console,
    setTimeout,
    clearTimeout,
    Symbol,
    Object,
    Array,
    JSON,
    Number,
    String,
    Boolean,
    Math,
    Error,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)

  const code = readFileSync(CLIENT_FILE, 'utf8')
  vm.runInContext(code, sandbox, { filename: 'client/client.js' })

  assert.ok(registration, '客户端没有调用 window.__ModuleLoader__.load()')

  const moduleExports = registration.factory((name) => {
    if (name === 'react') return react
    if (name in extraRequire) return extraRequire[name]
    throw new Error(`测试桩未提供模块：${name}`)
  })

  return { moduleExports, document, react, id: registration.id, sandbox }
}

// ------------------------------------------------------------------ 契约

it('外壳 id 与 factory 形状正确', () => {
  const { id, moduleExports } = loadClient()
  assert.equal(id, 'dsh-pet-ds')
  // ⚠️ 客户端数组来自 VM realm，`deepEqual` 会因原型不同而失败 —— 用 join 比。
  assert.equal(moduleExports.inject.join(','), 'slots,locale,configForms')
  assert.equal(typeof moduleExports.apply, 'function')
})

it('apply() 能跑通，并注册到 settings.section', () => {
  const { moduleExports, document } = loadClient()

  const registered = []
  const effects = []
  const localeRegistrations = []

  /** 极简 scope：只记 mutate 调用。 */
  const scope = {
    _snapshot: { status: 'ready', value: { autoStart: true, startDelayMs: 3000 }, base: {}, user: {}, revision: 7, writable: true, mode: 'host' },
    getSnapshot() {
      return this._snapshot
    },
    subscribe() {
      return () => {}
    },
    async mutate() {
      return true
    },
  }

  const ctx = {
    locale: {
      bind: () => (key) => `t:${key}`,
      register: (ns, dicts) => {
        localeRegistrations.push({ ns, dicts })
        return () => {}
      },
    },
    slots: {
      inject: (slot, cb) => cb(),
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
    configForms: {
      get: () => scope,
      whileServed: (namespaces, cb) => {
        // 模拟"宿主正在服务这个命名空间"。
        cb(new Set(namespaces))
        return () => {}
      },
    },
    effect: (fn) => {
      // effect 回调返回清理函数；这里只验证它不抛。
      const cleanup = fn()
      effects.push(cleanup)
      return cleanup
    },
  }

  moduleExports.apply(ctx)

  assert.equal(registered.length, 1, '应恰好注册一个 settings.section')
  const { options, component } = registered[0]
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'dsh-pet-ds')
  assert.equal(typeof options.label, 'function')
  assert.equal(typeof options.inject, 'function')
  assert.equal(typeof component, 'function', '组件必须是函数')
  assert.ok(localeRegistrations.length === 1, '应注册一份本地化字典')
  assert.ok(document._created.length >= 1, '应注入一次样式 <style>')
  assert.ok(effects.length >= 1, 'apply 必须用 ctx.effect 注册可回收资源')
})

it('options.inject() 提供 form 面', () => {
  const { moduleExports } = loadClient()
  let injected = null
  const scope = {
    getSnapshot: () => ({ status: 'ready', value: {}, base: {}, user: {}, revision: 1, writable: true, mode: 'host' }),
    subscribe: () => () => {},
    mutate: async () => true,
  }
  moduleExports.apply({
    locale: { bind: () => (k) => k, register: () => () => {} },
    slots: { inject: (_s, cb) => cb(), register: (options) => { injected = options.inject(); return () => {} } },
    configForms: { get: () => scope, whileServed: (_ns, cb) => { cb(new Set(_ns)); return () => {} } },
    effect: (fn) => fn(),
  })
  assert.ok(injected && injected.form, 'inject() 应返回 { form }')
})

it('组件在 loading / unavailable 状态下也能渲染（不抛）', () => {
  const { moduleExports } = loadClient()
  const h = makeReact().createElement
  let component = null
  const makeScope = (status) => ({
    getSnapshot: () => ({ status, value: {}, base: {}, user: {}, revision: 1, writable: true, mode: 'host' }),
    subscribe: () => () => {},
    mutate: async () => true,
  })
  const run = (status) => {
    moduleExports.apply({
      locale: { bind: () => (k) => k, register: () => () => {} },
      slots: { inject: (_s, cb) => cb(), register: (_o, c) => { component = c; return () => {} } },
      configForms: { get: () => makeScope(status), whileServed: (_ns, cb) => { cb(new Set(_ns)); return () => {} } },
      effect: (fn) => fn(),
    })
    const form = { status, writable: true, saving: false, failed: false, justSaved: false, draft: {}, saved: {}, subscribe: () => () => {}, getVersion: () => 0, isOverridden: () => false, invalidOf: () => false, hasInvalid: () => false, isDirty: () => false }
    component({ t: (k) => k, form, close: () => {} })
  }
  // 这两个状态必须能安全渲染 —— 否则用户在配置就绪前点进去会看到整个槽位空白。
  run('loading')
  run('unavailable')
  assert.ok(true)
})

// ------------------------------------------------------------------ 表单逻辑（核心）

/**
 * 从客户端里把 PetForm 类抠出来单测。
 *
 * 它没有导出（客户端不是 ES 模块），所以这里通过一次 `apply()` +
 * `inject()` 拿一个实例，再驱动它。
 */
function makeForm(scopeSnapshot, mutateImpl) {
  const { moduleExports } = loadClient()
  let capturedForm = null
  const scope = {
    _snapshot: scopeSnapshot,
    getSnapshot() {
      return this._snapshot
    },
    subscribe() {
      return () => {}
    },
    async mutate(ops, revision) {
      return mutateImpl ? mutateImpl(ops, revision) : true
    },
  }
  moduleExports.apply({
    locale: { bind: () => (k) => k, register: () => () => {} },
    slots: {
      inject: (_s, cb) => cb(),
      register: (options) => {
        capturedForm = options.inject().form
        return () => {}
      },
    },
    configForms: {
      get: () => scope,
      whileServed: (_ns, cb) => {
        cb(new Set(_ns))
        return () => {}
      },
    },
    effect: (fn) => fn(),
  })
  assert.ok(capturedForm, '拿不到 form 实例')
  return capturedForm
}

const READY = {
  status: 'ready',
  value: { autoStart: true, startDelayMs: 3000, stopOnUnload: true, size: 260, alwaysOnTop: true, lowBalanceThreshold: 10, refreshSeconds: 300 },
  base: {},
  user: {},
  revision: 42,
  writable: true,
  mode: 'host',
}

it('初始状态：从 scope 读到值、不脏', () => {
  const form = makeForm(READY)
  assert.equal(form.status, 'ready')
  assert.equal(form.writable, true)
  assert.equal(form.isDirty(), false)
  assert.equal(form.draft.refreshSeconds, 300)
})

it('edit() 改草稿并置脏', () => {
  const form = makeForm(READY)
  form.edit('refreshSeconds', '60')
  assert.equal(form.draft.refreshSeconds, 60, '数字字段应转成 number')
  assert.equal(form.isDirty(), true)
  form.edit('autoStart', false)
  assert.equal(form.draft.autoStart, false)
})

it('edit() 空输入记为 null（非法），而不是 0', () => {
  const form = makeForm(READY)
  form.edit('refreshSeconds', '')
  assert.equal(form.draft.refreshSeconds, null)
  assert.equal(form.invalidOf({ key: 'refreshSeconds', kind: 'number' }), true)
  assert.equal(form.hasInvalid(), true)
})

it('非法时不保存（避免把空值写进配置）', async () => {
  let called = 0
  const form = makeForm(READY, () => {
    called += 1
    return true
  })
  form.edit('refreshSeconds', '')
  await form.save()
  assert.equal(called, 0, '有非法字段时不该发出写请求')
})

it('保存只提交变化过的字段', async () => {
  let seen = null
  const form = makeForm(READY, (ops) => {
    seen = ops
    return true
  })
  form.edit('refreshSeconds', 120)
  await form.save()
  sameJson(seen, [{ op: 'set', path: ['refreshSeconds'], value: 120 }])
})

it('改成默认值 → 用 unset（让 cordis.patch.yml 保持干净）', async () => {
  /*
   * ⚠️ 这条是"恢复默认"的正确语义：应该**删掉** profile 里的覆盖，
   * 而不是写一行与默认相同的值。后者会让配置文件越攒越乱。
   */
  const snapshot = { ...READY, value: { ...READY.value, refreshSeconds: 60 }, user: { refreshSeconds: 60 } }
  let seen = null
  const form = makeForm(snapshot, (ops) => {
    seen = ops
    return true
  })
  form.resetField('refreshSeconds')
  await form.save()
  sameJson(seen, [{ op: 'unset', path: ['refreshSeconds'] }])
})

it('多个字段一起改 → 一次 mutate 提交多条 ops', async () => {
  let seen = null
  let revisionArg = null
  const form = makeForm(READY, (ops, rev) => {
    seen = ops
    revisionArg = rev
    return true
  })
  form.edit('refreshSeconds', 120)
  form.edit('autoStart', false)
  await form.save()
  assert.equal(seen.length, 2)
  assert.equal(revisionArg, 42, '应带上读到的 revision 作乐观并发栅栏')
})

it('没有改动时不发请求', async () => {
  let called = 0
  const form = makeForm(READY, () => {
    called += 1
    return true
  })
  await form.save()
  assert.equal(called, 0)
})

it('保存失败时清掉草稿（界面回到宿主真值）', async () => {
  const form = makeForm(READY, () => false)
  form.edit('refreshSeconds', 120)
  await form.save()
  assert.equal(form.failed, true)
  assert.equal(form.isDirty(), false, '失败后草稿应回到已保存值')
})

it('writable=false 时不保存', async () => {
  let called = 0
  const form = makeForm({ ...READY, writable: false }, () => {
    called += 1
    return true
  })
  form.edit('refreshSeconds', 120)
  await form.save()
  assert.equal(called, 0)
})

it('discard() 放弃改动', () => {
  const form = makeForm(READY)
  form.edit('refreshSeconds', 120)
  assert.equal(form.isDirty(), true)
  form.discard()
  assert.equal(form.isDirty(), false)
  assert.equal(form.draft.refreshSeconds, 300)
})

it('isOverridden 用 presence 判定（不是与默认值比较）', () => {
  // 用户可能显式把值设成与默认相同 —— 那**仍然**是"已覆盖"。
  const form = makeForm({ ...READY, user: { refreshSeconds: 300 } })
  assert.equal(form.isOverridden('refreshSeconds'), true)
  assert.equal(form.isOverridden('size'), false)
})

it('版本号随变更递增（useSyncExternalStore 的快照）', () => {
  const form = makeForm(READY)
  const v0 = form.getVersion()
  form.edit('refreshSeconds', 120)
  assert.ok(form.getVersion() > v0, '版本号必须递增，否则 UI 不会重渲染')
})

it('subscribe 返回可用的退订函数', () => {
  const form = makeForm(READY)
  let calls = 0
  const off = form.subscribe(() => {
    calls += 1
  })
  form.edit('refreshSeconds', 120)
  assert.ok(calls > 0, '订阅者应被通知')
  assert.equal(typeof off, 'function')
  off()
})

// ------------------------------------------------------------------ 串行执行
for (const { name, fn } of queued) {
  try {
    // 支持 async：表单的 save() 是异步的。串行 await 保证计数在最后打印前完成。
    await fn()
    passed += 1
    console.log(`PASS  ${name}`)
  } catch (err) {
    failed += 1
    console.log(`FAIL  ${name}`)
    console.log(`      ${err instanceof Error ? err.message : String(err)}`)
  }
}

console.log(`\n结果：${String(passed)}/${String(passed + failed)} 通过`)
if (failed > 0) process.exit(1)