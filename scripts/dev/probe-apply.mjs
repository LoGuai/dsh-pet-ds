/**
 * 真正**跑一遍 `apply()`**，用 DSH 的模块解析 + 桩 ctx。
 *
 * ## 为什么需要它（这是最后一层、也是最关键的一层）
 *
 * 已有的检查各自只覆盖一部分：
 *  · `node --check` —— 只验语法；
 *  · `test-host-link.mjs` —— 链接并**求值**模块图，能抓模块级未定义标识符；
 *  · `test-config-schema.mjs` —— 只测 schema；
 *  · 客户端测试 —— 只测浏览器半侧。
 *
 * **没有一项会调用 `apply()`。** 而 `apply()` 是插件真正干活的地方：
 * 注册工具、开桥接端口、起桌宠。它里面抛异常，表现和"模块加载失败"一模一样
 * —— 工具消失、端口不监听，而且**没有任何日志**（DSH 把异常记进它自己的日志，
 * 本机没有那个文件）。
 *
 * 所以这里用一个**桩 ctx** 真调 `apply()`，把异常抓出来。
 *
 * ⚠️ 两个必须注意的点（都实测踩过）：
 *  1. 必须用 **Electron 以 Node 模式**跑：纯 Node 不认 asar，
 *     `@deepseek-ai/dsh-tools` 一律解析失败，会误判成插件的问题；
 *  2. `apply()` 会真的开监听端口、起桌宠子进程，所以桩 ctx 要能拦住这些，
 *     跑完必须清理（否则会留下占端口的孤儿）。
 *
 * 运行（PowerShell）：
 *   $env:ELECTRON_RUN_AS_NODE=1
 *   & (Get-ChildItem "$env:USERPROFILE\.dsh\electron\electron-*\electron.exe").FullName scripts/dev/probe-apply.mjs
 */

import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/*
 * 注册解析钩子：把 `@deepseek-ai/*` 指向 DSH 的 app.asar。
 *
 * 不注册的话，插件的裸标识符 import 会一律失败
 * （`Cannot find package '@deepseek-ai/dsh-tools'`）—— 那是**探测方式的问题**，
 * 不是插件的问题，而它会掩盖我们真正想知道的"apply() 会不会抛"。
 */
const ASAR = 'C:/Users/29845/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'
process.env.DSH_PET_ASAR = ASAR
const { register } = await import('node:module')
register(pathToFileURL(join(HERE, 'dsh-resolve-hook.mjs')).href, {
  parentURL: pathToFileURL(join(HERE, 'noop.mjs')).href,
})

const ENTRY = 'D:/dsh/pet/src/host/index.js'

console.log('运行时：node ' + process.versions.node + ' / electron ' + String(process.versions.electron))

/** 记录桩 ctx 收到的注册，便于断言"真的注册了工具"。 */
const state = {
  tools: [],
  effects: 0,
  listeners: [],
  logs: [],
  injected: [],
}

/** 极简桩 ctx：只实现插件用到的那些面。 */
function makeCtx() {
  const ctx = {
    logger: {
      info: (m) => state.logs.push(String(m)),
      warn: (m) => state.logs.push('WARN ' + String(m)),
      error: (m) => state.logs.push('ERROR ' + String(m)),
    },
    // 插件用 ctx.tools.define / register 之类注册工具（具体 API 由 defineTool 决定）。
    tools: {
      define: (def) => {
        state.tools.push(def)
        return def
      },
      register: (def) => {
        state.tools.push(def)
        return () => {}
      },
    },
    credentials: {
      resolve: async () => null,
    },
    effect: (fn) => {
      state.effects += 1
      try {
        const cleanup = fn()
        return cleanup
      } catch (err) {
        state.logs.push('EFFECT THREW: ' + (err?.message ?? String(err)))
        throw err
      }
    },
    on: (event, handler) => {
      state.listeners.push({ event, handler })
      return () => {}
    },
    inject: (deps, cb) => {
      state.injected.push(Array.isArray(deps) ? deps.join(',') : String(deps))
      // 关键：**不调用 cb**。这样就不会真的去注册 settings 策略，
      // 也就不会因为缺少 settings 服务而失败 —— 我们只想验证 apply 的主体。
      return () => {}
    },
    get: () => undefined,
  }
  return ctx
}

console.log('\n导入模块…')
let mod
try {
  mod = await import(pathToFileURL(ENTRY).href)
  console.log('  ✓ 导入成功')
  console.log(`    name   = ${String(mod.name)}`)
  console.log(`    inject = ${JSON.stringify(mod.inject)}`)
  console.log(`    Config = ${mod.Config ? '有' : '无'}`)
} catch (err) {
  console.log('  ✗ 导入失败：' + (err?.message ?? String(err)))
  process.exit(1)
}

/*
 * config 用**真实的 cordis.patch.yml 那一行的内容** ——
 * 若某个值越界，schema 会在 Loader 那侧就拒掉，这里也要复现同样的输入。
 */
const rowConfig = {
  port: 47845,
  size: 260,
  autoStart: true,
  startDelayMs: 3000,
  debug: false,
  stopOnUnload: true,
  lowBalanceThreshold: 10,
  refreshSeconds: 300,
  apiBase: 'https://api.deepseek.com',
  credential: 'DEEPSEEK_API_KEY',
}

console.log('\n调用 apply()（桩 ctx + 真实 patch 行的 config）…')
try {
  const result = mod.apply(makeCtx(), rowConfig)
  // apply 可能是 async（本插件不是，但通用起见等一下）。
  if (result && typeof result.then === 'function') await result
  console.log('  ✓ apply() 没有抛异常')
} catch (err) {
  console.log('  ✗ apply() 抛异常了 —— 这就是插件不加载的原因：')
  console.log('    ' + (err?.message ?? String(err)))
  if (err?.stack) console.log(err.stack.split('\n').slice(0, 12).join('\n'))
  process.exitCode = 1
}

console.log('\napply() 期间的观察：')
console.log('  注册的工具数：' + state.tools.length)
for (const t of state.tools) console.log('    · ' + String(t?.name ?? t?.id ?? JSON.stringify(t).slice(0, 60)))
console.log('  ctx.effect 调用数：' + state.effects)
console.log('  事件监听：' + state.listeners.map((l) => l.event).join(', ') || '  （无）')
console.log('  ctx.inject 调用：' + (state.injected.join(' | ') || '（无）'))

console.log('\n插件自己的日志：')
for (const l of state.logs.slice(0, 40)) console.log('  ' + l)

// 收尾：apply 可能已经起了桥接监听或桌宠进程，这里提示一下（不自动杀，交给外层命令）。
console.log('\n注意：本脚本可能已让插件开始监听端口 / 拉起桌宠，跑完请检查进程。')
