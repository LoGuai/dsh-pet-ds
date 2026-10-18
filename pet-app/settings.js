/**
 * 桌宠本地设置：读写 `<userData>/pet-config.json`。
 *
 * ⚠️ 路径说明（这里曾经写错，别再写错）：
 *   `<userData>` 是 Electron 的 `app.getPath('userData')`，
 *   在 Windows 上实际是 `%APPDATA%\DSH Pet\`，**不是** `$DSH_HOME\dsh-pet-ds\`。
 *   这一点很重要：它意味着**用户数据与安装目录完全分离** ——
 *   升级/重装插件时清的是安装目录，绝不会碰到这里的配置与好感存档。
 *
 * 为什么设置放在桌宠侧而不是宿主侧：
 *  - 「尺寸」是通过右键菜单在桌宠窗口上改的，改完要立即生效、下次启动还要记得；
 *  - 宿主侧的 config（cordis.patch.yml）改一次要重载插件，不适合承载这种即时交互项；
 *  - 桌宠本来就有自己的运行目录需要放日志，settings 放在一起最省事。
 *
 * 宿主仍然保留 size 配置项，它的作用是**首次启动**（还没有本地设置文件时）的初始值。
 *
 * 写入策略：原子写（先写 .tmp 再 rename），避免断电/崩溃留下半个文件。
 * 读取策略：解析失败就回落到默认值，绝不让一个坏文件把桌宠搞得起不来。
 */

const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

/** 默认设置。新增字段时只需在这里补默认值。 */
const DEFAULTS = Object.freeze({
  /** 角色区域宽度（CSS 像素）。窗口宽度就等于它。 */
  petWidth: 240,
  /**
   * 是否**始终显示在最上层**（右键菜单里的开关，用户可随时切换）。
   *
   * 默认 true：桌宠的主要用途是"一直看得见"，所以默认压在其他窗口之上。
   * 关掉后它就是普通窗口，会被其它窗口盖住 —— 适合需要它"让位"的时候。
   * 这个选择要**持久化**，否则每次启动都得重新关一遍。
   */
  topmost: true,
  /*
   * 刻意**没有 mood 字段**：心情每次启动都重置为满值（用户要求），
   * 不落盘。因此它没有需要持久化的状态 —— 见 pet-app/main.js 的心情小节。
   * 老配置文件里可能残留 mood 键，load() 只认识 DEFAULTS 里的字段，会被自动忽略。
   */
})

/** 内存中的当前设置。 */
let current = { ...DEFAULTS }

/**
 * 深拷贝一层就够：DEFAULTS 里目前只有 mood 一个嵌套对象，
 * 但拷贝必须做，否则 patch 会直接改到 DEFAULTS 的字面量上（那是 Object.freeze 的，
 * 冻结只保护顶层，嵌套对象仍可被改写）。
 */
function cloneValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value }
  return value
}

/** 取默认值的深拷贝。 */
function defaults() {
  const out = {}
  for (const [key, value] of Object.entries(DEFAULTS)) out[key] = cloneValue(value)
  return out
}

/** 设置文件路径。必须在 app ready 之后取，否则 getPath('userData') 不可靠。 */
function settingsPath() {
  try {
    return path.join(app.getPath('userData'), 'pet-config.json')
  } catch {
    // 极端情况下 app 还没 ready：退回到 cwd，保证不会抛。
    return path.join(process.cwd(), 'pet-config.json')
  }
}

/** 载入设置并与默认值合并。 */
function load() {
  try {
    const file = settingsPath()
    if (!fs.existsSync(file)) {
      current = defaults()
      return current
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const merged = defaults()
    for (const key of Object.keys(DEFAULTS)) {
      const value = raw ? raw[key] : undefined
      const defaultValue = DEFAULTS[key]
      if (typeof defaultValue === 'number') {
        if (Number.isFinite(value)) merged[key] = Number(value)
      } else if (defaultValue && typeof defaultValue === 'object' && !Array.isArray(defaultValue)) {
        // 嵌套对象逐字段合并：只认识的字段才收，缺的用默认值。
        if (value && typeof value === 'object') {
          const target = merged[key]
          for (const sub of Object.keys(defaultValue)) {
            const subValue = value[sub]
            if (typeof defaultValue[sub] === 'number') {
              if (Number.isFinite(subValue)) target[sub] = Number(subValue)
            } else if (typeof subValue === typeof defaultValue[sub]) {
              target[sub] = subValue
            }
          }
        }
      } else if (typeof value === typeof defaultValue) {
        merged[key] = value
      }
    }
    current = merged
  } catch {
    // 文件损坏：用默认值继续跑，不阻断启动。
    current = defaults()
  }
  return current
}

/** 取当前设置的副本（嵌套对象也复制，避免调用方改到内部状态）。 */
function get() {
  const out = {}
  for (const [key, value] of Object.entries(current)) out[key] = cloneValue(value)
  return out
}

/**
 * 更新设置并落盘。
 * @param {Record<string, unknown>} patch
 * @returns {{ ok: boolean, settings: Record<string, unknown>, error?: string }}
 */
function update(patch) {
  const next = get()
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!(key in DEFAULTS)) continue
    const defaultValue = DEFAULTS[key]
    if (typeof defaultValue === 'number') {
      if (Number.isFinite(value)) next[key] = Number(value)
    } else if (defaultValue && typeof defaultValue === 'object' && !Array.isArray(defaultValue)) {
      // 嵌套对象做**浅合并**：调用方可以只送 mood.value，不必把 updatedAt 一起带上。
      if (value && typeof value === 'object') next[key] = { ...next[key], ...value }
    } else if (typeof value === typeof defaultValue) {
      next[key] = value
    }
  }
  current = next

  try {
    const file = settingsPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(current, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, file)
    return { ok: true, settings: get() }
  } catch (err) {
    // 写失败不影响本次运行（内存里已生效），只报告。
    return { ok: false, settings: get(), error: err instanceof Error ? err.message : String(err) }
  }
}

module.exports = { DEFAULTS, load, get, update, settingsPath }
