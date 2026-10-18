/**
 * 好感度存档：读写 `<userData>/affection.json`。
 *
 * ## 为什么要落盘（用户要求）
 *
 * 「建议好感值等数值保存在专门的用户数据文档中，注意更新时删除旧文件，保留用户数据」
 *
 * 好感是**长期养成**的数值。之前它只活在内存里，桌宠一重启就归零 ——
 * 那意味着"养了三天的心"每次重启都白费。心情则相反（用户明确要求每次启动重置）。
 *
 * ## 存在哪、为什么
 *
 * 存到 `<userData>`（Windows 上是 `%APPDATA%\DSH Pet\`），与 `pet-config.json` 同目录。
 *
 * 选这里的关键理由：**它与安装目录完全分离**。
 * 安装器在升级时清的是插件目录（`node_modules\dsh-pet-ds` 或
 * `<你选的目录>\dsh-pet-ds`），永远不会碰 `%APPDATA%\DSH Pet\` ——
 * 所以"删旧文件、保留用户数据"这件事是**结构性成立**的，
 * 不依赖安装器记得跳过某个文件。
 *
 * ## 写入策略
 *
 * 原子写（先写 `.tmp` 再 rename），与 `settings.js` 一致：
 * 断电/崩溃时最多丢掉最后一次变更，不会留下半个 JSON。
 * 解析失败一律回落默认值 —— 一个坏存档不该让桌宠起不来。
 */

const fs = require('node:fs')
const path = require('node:path')

const { initialAffection, normalizeAffection } = require('../src/shared-core/affection.js')

/** 存档文件名（与 pet-config.json 并列）。 */
const FILE_NAME = 'affection.json'

/** 存档格式版本。将来改结构时靠它做迁移。 */
const STORE_VERSION = 1

/**
 * 取默认存档目录：Electron 的 userData。
 *
 * ⚠️ 只在**调用时**取 `app.getPath(...)`，不在模块加载时取：
 *  · 模块可能被测试在 Node 里 require（那里没有 electron 的 app）；
 *  · `app` 未 ready 时 `getPath` 不可靠。
 */
function defaultDir() {
  try {
    // require 放在函数里：纯 Node 环境下 electron 模块只是一个路径字符串。
    const { app } = require('electron')
    return app.getPath('userData')
  } catch {
    return process.cwd()
  }
}

/**
 * 造一个存档读写器。
 *
 * 做成工厂是为了**可测**：测试传一个临时目录即可，不需要真的启 Electron。
 *
 * @param {{ dir?: () => string }} [options]
 * @returns {{ path: () => string, load: (now?: number) => object, save: (state: object, meta?: object, now?: number) => boolean, clear: () => boolean }}
 */
function createAffectionStore(options = {}) {
  const resolveDir = typeof options.dir === 'function' ? options.dir : defaultDir

  function storePath() {
    return path.join(resolveDir(), FILE_NAME)
  }

  /**
   * 读存档。
   *
   * @param {number} [now]
   * @returns {{ state: object, lastClickAt: number | null, lifetimeGained: number, loaded: boolean }}
   *          `loaded=false` 表示"没有存档或读不出来"，调用方据此走首次启动的日志。
   */
  function load(now = Date.now()) {
    const fallback = {
      state: initialAffection(now),
      lastClickAt: null,
      lifetimeGained: 0,
      loaded: false,
    }
    try {
      const file = storePath()
      if (!fs.existsSync(file)) return fallback
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!raw || typeof raw !== 'object') return fallback

      /*
       * 用共享核心的 `normalizeAffection` 规整：它会把爱心数夹进 0~5、
       * 阶段值夹进当前阈值。**不要在这里自己判**，否则两边规则迟早不一致。
       */
      const state = normalizeAffection({ hearts: raw.hearts, value: raw.value, updatedAt: now }, now)
      const lastClickAt = Number.isFinite(raw.lastClickAt) && raw.lastClickAt > 0 ? raw.lastClickAt : null
      const lifetimeGained = Number.isFinite(raw.lifetimeGained)
        ? Math.max(0, Math.floor(raw.lifetimeGained))
        : 0
      return { state, lastClickAt, lifetimeGained, loaded: true }
    } catch {
      // 存档损坏：当没有存档处理（好感从 0 开始），但**不删原文件** ——
      // 万一用户想手工找回，留着比删掉好。
      return fallback
    }
  }

  /**
   * 写存档（原子替换）。
   *
   * @param {{ hearts: number, value: number, updatedAt?: number }} state
   * @param {{ lastClickAt?: number | null, lifetimeGained?: number }} [meta]
   * @param {number} [now]
   * @returns {boolean} 是否写成功（失败只记日志，不抛 —— 存档失败不该让桌宠崩）
   */
  function save(state, meta = {}, now = Date.now()) {
    try {
      const dir = resolveDir()
      fs.mkdirSync(dir, { recursive: true })
      const payload = {
        version: STORE_VERSION,
        hearts: state.hearts,
        value: state.value,
        updatedAt: state.updatedAt ?? now,
        /** 点击好感的 5 分钟冷却锚点：存下来，避免"重启即刷新冷却"被刷好感。 */
        lastClickAt: Number.isFinite(meta.lastClickAt) ? meta.lastClickAt : null,
        /** 累计获得过多少好感（只增不减，给「关于」窗口展示）。 */
        lifetimeGained: Number.isFinite(meta.lifetimeGained) ? Math.floor(meta.lifetimeGained) : 0,
        savedAt: now,
      }
      const file = storePath()
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      fs.renameSync(tmp, file)
      return true
    } catch {
      return false
    }
  }

  /** 删掉存档（预留给"重置好感"之类的操作；当前没有入口调用）。 */
  function clear() {
    try {
      const file = storePath()
      if (fs.existsSync(file)) fs.unlinkSync(file)
      return true
    } catch {
      return false
    }
  }

  return { path: storePath, load, save, clear }
}

module.exports = { createAffectionStore, FILE_NAME, STORE_VERSION }
