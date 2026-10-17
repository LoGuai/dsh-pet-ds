/**
 * 信息窗口的渲染脚本（语音库 / 关于共用）。
 *
 * 只做一件事：把主进程给的 payload 画出来。
 * **不持有业务数据** —— 数据每次打开都由主进程现算（好感度、心情随时在变）。
 *
 * ## 为什么不用框架
 *
 * 两个简单的只读页面，用原生 DOM 最省事：没有构建步骤，
 * 也不会给"打包进 asar 后还要能跑"增加风险（这个项目已经因为构建链踩过坑）。
 */

const titleEl = document.getElementById('title')
const subtitleEl = document.getElementById('subtitle')
const contentEl = document.getElementById('content')
const closeBtn = document.getElementById('close-btn')
const sayBtn = document.getElementById('say-btn')

/** 小工具：创建元素并设置属性/文本。 */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') node.textContent = String(value)
    else if (key === 'class') node.className = String(value)
    else node.setAttribute(key, String(value))
  }
  for (const child of children) node.append(child)
  return node
}

closeBtn.addEventListener('click', () => {
  window.infoApi.close()
})

sayBtn.addEventListener('click', () => {
  /*
   * "随机说一句"按钮：把原来右键菜单的「对话」搬到语音库窗口里。
   * 用户重做菜单时列的 8 项里没有「对话」，但那个功能不该消失 ——
   * 放在这里正好和"看语音"是同一件事的两个方向。
   */
  window.infoApi.sayRandom()
})

/** 渲染「语音库」。 */
function renderVoice(data) {
  titleEl.textContent = '语音库'
  const hearts = Number.isFinite(data.hearts) ? data.hearts : 0
  const moodText = typeof data.moodText === 'string' ? data.moodText : ''
  subtitleEl.textContent = `${hearts} 颗心 · 心情${moodText}`
  sayBtn.hidden = false

  contentEl.replaceChildren()
  contentEl.append(
    el('div', {
      class: 'card-note',
      text: '下方只展开**当前可用**的语音组；未解锁的组会标上锁定状态。好感度或心情变化后，可用组会跟着变。',
    }),
  )

  const groups = Array.isArray(data.groups) ? data.groups : []
  if (groups.length === 0) {
    contentEl.append(el('div', { class: 'empty', text: '语音库是空的。' }))
    return
  }

  for (const group of groups) {
    const available = group.available === true
    const card = el('div', { class: `card${available ? '' : ' locked'}` })
    card.append(
      el('div', { class: 'card-head' }, [
        el('span', { class: 'card-title', text: String(group.label ?? group.id ?? '未命名组') }),
        el('span', {
          class: `tag ${available ? 'on' : 'off'}`,
          text: available ? '可用' : '未解锁',
        }),
        el('span', { class: 'tag', text: `${String((group.lines ?? []).length)} 句` }),
      ]),
    )
    if (typeof group.condition === 'string' && group.condition) {
      card.append(el('div', { class: 'card-note', text: group.condition }))
    }

    if (available) {
      const list = el('ol', { class: 'lines' })
      for (const line of group.lines ?? []) list.append(el('li', { text: String(line) }))
      card.append(list)
    } else {
      card.append(el('div', { class: 'empty', text: '满足条件后解锁。' }))
    }
    contentEl.append(card)
  }

  if (Array.isArray(data.trustLines) && data.trustLines.length > 0) {
    const card = el('div', { class: 'card' })
    card.append(
      el('div', { class: 'card-head' }, [
        el('span', { class: 'card-title', text: '信赖语音（低心情时被关心）' }),
        el('span', { class: 'tag', text: `${String(data.trustLines.length)} 句` }),
      ]),
    )
    card.append(el('div', { class: 'card-note', text: '心情低于 50 时点击桌宠触发（当前是占位台词）。' }))
    const list = el('ol', { class: 'lines' })
    for (const line of data.trustLines) list.append(el('li', { text: String(line) }))
    card.append(list)
    contentEl.append(card)
  }
}

/** 渲染「关于桌宠」。 */
function renderAbout(data) {
  titleEl.textContent = '关于桌宠'
  subtitleEl.textContent = data.version ? `v${String(data.version)}` : ''
  sayBtn.hidden = true
  contentEl.replaceChildren()

  const card = el('div', { class: 'card' })
  const dl = el('dl', { class: 'kv' })
  const rows = [
    ['版本', data.version ? `v${String(data.version)}` : '未知'],
    ['插件包', String(data.packageName ?? 'dsh-pet-ds')],
    ['Electron', String(data.electronVersion ?? '未知')],
    ['好感度', String(data.affectionText ?? '')],
    ['心情值', String(data.moodText ?? '')],
    ['运行时长', String(data.uptimeText ?? '')],
  ]
  for (const [key, value] of rows) {
    dl.append(el('dt', { text: key }))
    dl.append(el('dd', { text: value }))
  }
  card.append(dl)
  contentEl.append(card)

  contentEl.append(el('h2', { class: 'section', text: '最新更新日志' }))
  const pre = el('pre', { class: 'changelog', text: String(data.changelog ?? '（读不到更新日志）') })
  contentEl.append(pre)
}

window.infoApi.onData((payload) => {
  if (payload.mode === 'voice') renderVoice(payload)
  else renderAbout(payload)
})
