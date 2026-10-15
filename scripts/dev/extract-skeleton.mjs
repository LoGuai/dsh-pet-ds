/**
 * 从（损坏的）main.js 里提取结构骨架，作为重写后的核对清单。
 * 提取的是**结构**而非文案：函数名、IPC 频道、常量名、关键调用。
 * 用法: node extract-skeleton.mjs <file>
 */
import fs from 'node:fs'

const file = process.argv[2]
if (!file) {
  console.error('用法: node extract-skeleton.mjs <file>')
  process.exit(2)
}
const src = fs.readFileSync(file, 'utf8')
const lines = src.split('\n')

const out = {
  file,
  totalLines: lines.length,
  functions: [],
  ipcHandle: [],
  ipcOn: [],
  consts: [],
  lets: [],
  requires: [],
  moduleExports: [],
  apiCalls: {},
}

for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  const ln = i + 1

  let m
  if ((m = /^\s*(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(line))) {
    out.functions.push(`${m[1]}@${ln}`)
  }
  if ((m = /ipcMain\.handle\(\s*'([^']+)'/.exec(line))) out.ipcHandle.push(m[1])
  if ((m = /ipcMain\.on\(\s*'([^']+)'/.exec(line))) out.ipcOn.push(m[1])
  if ((m = /^const\s+([A-Za-z0-9_$]+)\s*=/.exec(line))) out.consts.push(`${m[1]}@${ln}`)
  if ((m = /^let\s+([A-Za-z0-9_$]+)\s*=/.exec(line))) out.lets.push(`${m[1]}@${ln}`)
  if ((m = /require\('([^']+)'\)/.exec(line))) out.requires.push(m[1])
  if ((m = /module\.exports\s*=\s*(.+)/.exec(line))) out.moduleExports.push(m[1].trim())

  // 关键 API 调用计数，用于确认没漏掉整块逻辑
  for (const api of [
    'win.setPosition',
    'win.setBounds',
    'win.setMinimumSize',
    'win.setMaximumSize',
    'win.setResizable',
    'win.getPosition',
    'win.getSize',
    'win.getBounds',
    'win.setIgnoreMouseEvents',
    'win.webContents.send',
    'win.setAlwaysOnTop',
    'screen.getCursorScreenPoint',
    'screen.getPrimaryDisplay',
    'screen.getDisplayNearestPoint',
    'app.requestSingleInstanceLock',
    'app.whenReady',
    'Menu.buildFromTemplate',
    'settings.load',
    'settings.update',
    'settings.settingsPath',
    'setInterval',
    'setTimeout',
    'clearInterval',
    'clearTimeout',
    'execFile',
    'executeJavaScript',
    'capturePage',
    'writeFileSync',
    'mkdirSync',
  ]) {
    if (line.includes(api)) out.apiCalls[api] = (out.apiCalls[api] || 0) + 1
  }
}

// 字符串字面量里的中文（用于核对文案条数，不要求内容一致）
const cjkStrings = (src.match(/'[^'\n]*[\u4e00-\u9fff][^'\n]*'/g) || []).length
out.cjkStringLiterals = cjkStrings

console.log(JSON.stringify(out, null, 2))
