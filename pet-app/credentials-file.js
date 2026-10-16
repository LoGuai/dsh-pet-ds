/**
 * 从 DSH 的凭据文件里读 API Key —— **桌宠侧**（CommonJS）。
 *
 * ⚠️ 这个文件在 `pet-app/` 下，而 `pet-app/package.json` 是 `"type": "commonjs"`，
 * 所以它**必须是 CJS**（`module.exports`），不能用 `export`。
 * 我第一版写成了 ESM，`require` 直接报 `Unexpected token 'export'`。
 * 共享核心（`src/shared-core/`）是 ESM，那边靠 `require(esm)` 加载 ——
 * 两者规则不同，别混。
 *
 * ## 为什么要读这个文件
 *
 * 按用户要求，余额取数**搬到桌宠侧**（桌宠自己取，改完只需重启桌宠、
 * 不必重启 DSH）。桌宠没有 DSH 的凭据服务可用，所以得自己找密钥。
 *
 * DSH 把它存在 `$DSH_HOME/.credentials.yaml`（默认 `~/.dsh/`）。
 *
 * ## ⚠️ 关于"密钥明文"
 *
 * 该文件里 API Key 是**明文**的。也就是说"把密钥留在宿主、绝不进桌宠"
 * 从一开始就不是一条真实的安全边界 —— 本机任何进程都能读它。
 *
 * 所以这里**不再假装那条边界存在**，但仍守住一条真实有用的边界：
 *
 * **密钥只进桌宠的「主进程」，绝不进「渲染进程」。**
 * 渲染进程跑的是页面代码（每个动画帧都在跑，还加载 CSS/图片），
 * 把密钥放进它的作用域才是真风险。主进程有 `contextIsolation: true`，
 * 渲染进程拿不到 `require`，也就碰不到这里的任何东西。
 *
 * ## 为什么手写一个极小的 YAML 读取器
 *
 * 不引入依赖：`pet-app` 刻意**没有任何 dependencies**（见它的 package.json），
 * 这样它不装 node_modules 也能启动。而完整 YAML 解析器有几百 KB，为一个
 * 只读四层的文件不值当。
 *
 * 只支持这个文件实际用到的形状（顶格键 + 缩进 + `key: value`）：
 *
 * ```yaml
 * version: 1
 * records:
 *   client-connection/browser-session:
 *     kind: grant
 *     payload:
 *       version: 1
 *       secret: xxxxx
 * refs:
 *   DEEPSEEK_API_KEY: sk-xxxx
 * ```
 *
 * ⚠️ **不是通用 YAML 解析器**：不支持列表、多行字符串、锚点等。
 * 读到不认识的形状就当作"没有这个键"，**绝不猜** —— 宁可报"凭据未配置"
 * 让用户看到明确原因，也不要因为解析错而拿一个坏密钥去反复打接口。
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

/** 默认凭据文件路径（相对 DSH_HOME）。 */
const CREDENTIALS_FILE_NAME = '.credentials.yaml'

/** 默认凭据键名。 */
const DEFAULT_CREDENTIAL = 'DEEPSEEK_API_KEY'

/**
 * 解析 `.credentials.yaml`，取出 `refs` 段里的键值。
 *
 * @param {string} text 文件内容
 * @returns {Record<string, string>} 形如 `{ DEEPSEEK_API_KEY: 'sk-...' }`
 */
function parseCredentialRefs(text) {
  const out = {}
  if (typeof text !== 'string' || text.length === 0) return out

  const lines = text.split(/\r?\n/)
  let inRefs = false
  /** `refs` 段里的键缩进宽度（取第一行的缩进量）。 */
  let refsIndent = -1

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '')
    if (!line.trim()) continue
    if (line.trim().startsWith('#')) continue

    const indent = line.length - line.trimStart().length
    const body = line.trim()

    if (!inRefs) {
      // 找顶格的 `refs:`
      if (indent === 0 && /^refs\s*:/.test(body)) {
        inRefs = true
        refsIndent = -1
      }
      continue
    }

    // 已进入 refs：遇到顶格的新键说明 refs 段结束。
    if (indent === 0) break
    if (refsIndent < 0) refsIndent = indent
    // 缩进比 refs 的键浅 → 段结束。
    if (indent < refsIndent) break

    const m = /^([A-Za-z0-9_./:-]+)\s*:\s*(.*)$/.exec(body)
    if (!m) continue
    const key = m[1]
    let value = m[2].trim()

    // 去掉配对的引号（YAML 允许引号包裹，这里做最基本的处理）。
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    // 空值（例如 `KEY:` 后面没东西）不记录。
    if (!value) continue
    out[key] = value
  }

  return out
}

/**
 * 把凭据值里的环境变量占位符展开。
 *
 * 支持 `${VAR}` / `%VAR%` / `$VAR` 三种写法 —— DSH 的凭据有时会存成
 * "指向环境变量"而不是字面密钥。
 *
 * @param {string} value
 * @param {Record<string, string|undefined>} [env]
 */
function expandEnvPlaceholders(value, env = process.env) {
  if (typeof value !== 'string' || !value) return value
  let out = value
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name) =>
    typeof env[name] === 'string' ? env[name] : whole,
  )
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name) =>
    typeof env[name] === 'string' ? env[name] : whole,
  )
  out = out.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name) =>
    typeof env[name] === 'string' ? env[name] : whole,
  )
  return out
}

/**
 * 解析 DSH 的凭据文件路径。
 *
 * @param {string} [dshHome] 默认取 `process.env.DSH_HOME`，再回落 `~/.dsh`
 * @returns {string}
 */
function resolveCredentialsPath(dshHome) {
  const home = String(dshHome ?? process.env.DSH_HOME ?? '').trim()
  const base = home || path.join(os.homedir(), '.dsh')
  return path.join(base, CREDENTIALS_FILE_NAME)
}

/**
 * 从凭据文件里读某个键。
 *
 * @param {object} [options]
 * @param {string} [options.dshHome]
 * @param {string} [options.credential]
 * @param {Record<string,string|undefined>} [options.env]
 * @param {(p: string) => boolean} [options.existsSync] 注入便于测试
 * @param {(p: string) => string} [options.readFileSync] 注入便于测试
 * @returns {{ ok: boolean, value?: string, path: string, error?: string }}
 */
function readCredentialFromFile(options = {}) {
  const existsSync = typeof options.existsSync === 'function' ? options.existsSync : fs.existsSync
  const readFileSync =
    typeof options.readFileSync === 'function'
      ? options.readFileSync
      : (p) => fs.readFileSync(p, 'utf8')

  const filePath = resolveCredentialsPath(options.dshHome)

  try {
    if (!existsSync(filePath)) {
      return { ok: false, path: filePath, error: `凭据文件不存在：${filePath}` }
    }
    const refs = parseCredentialRefs(readFileSync(filePath))
    const wanted = String(options.credential ?? DEFAULT_CREDENTIAL)
    const raw = refs[wanted]
    if (!raw) {
      return { ok: false, path: filePath, error: `凭据文件里没有 ${wanted}` }
    }
    const value = expandEnvPlaceholders(raw, options.env ?? process.env)
    if (!value) {
      return { ok: false, path: filePath, error: `${wanted} 展开后为空` }
    }
    return { ok: true, value, path: filePath }
  } catch (err) {
    return {
      ok: false,
      path: filePath,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

module.exports = {
  CREDENTIALS_FILE_NAME,
  DEFAULT_CREDENTIAL,
  parseCredentialRefs,
  expandEnvPlaceholders,
  resolveCredentialsPath,
  readCredentialFromFile,
}
