/**
 * 桌宠设置栏 —— DSH 设置页的**浏览器半侧**。
 *
 * ## 这个文件是什么
 *
 * 它不是 ES 模块，而是 DSH 浏览器模块表要的 `window.__ModuleLoader__.load({...})`
 * 外壳（见 DSH 官方模板 `templates/decoration/client.js`）。宿主 Loader 从
 * `package.json` 的 `dsh.client` 声明发现它，通过 `exports["./client"]` 取到本文件。
 *
 * ## 为什么不写成 React 组件树
 *
 * DSH 官方 UI 规范明令禁止第三方插件依赖 `@deepseek-ai/dsh-client-ui-primitives`
 * 之类的 Harness Client 包，理由是：
 *  · 那些包会变，而普通 JS **没有类型检查**；
 *  · 一个抛错的组件会让**整个槽位空白**（控制台只留 `slot entry crashed`）。
 *
 * 所以这里用 `require('react')` 的 `createElement`（React 本身在浏览器模块表里，
 * 是稳定的）自己搭控件，样式只用 `--dsw-alias-*` 主题令牌 —— 令牌名变了只会
 * 掉点颜色，不会把页面搞崩。
 *
 * ## 配置读写走哪条路
 *
 * `ctx.configForms.get('dsh-pet-ds')` 拿到一个 **scope**（`ConfigFormController`）：
 *
 *   getSnapshot() → { status, value, base, user, revision, writable, mode }
 *   subscribe(fn) → 退订函数
 *   set(field, value) / unset(field) / mutate(ops, expectedRevision) → Promise<boolean>
 *
 * 写下去之后由 DSH 自己落到 profile 的 `cordis.patch.yml` 并热应用 ——
 * **本插件不碰任何文件**。
 *
 * ⚠️ 两个来源都必须对：
 *  · `value` 是当前生效值（用户覆盖 composited 在默认值之上）；
 *  · `user` 里**有没有这个键**才表示"被 profile 覆盖过"（presence 判定，
 *    不能拿值和默认值比 —— 用户完全可能显式设成与默认相同的值）。
 *
 * ## ⚠️ 与宿主 schema 的一致性
 *
 * 哪些字段可编辑、默认值是多少，**宿主 schema 才是权威**
 * （`src/host/config-schema.js`）。但浏览器里拿不到那个模块（不能 import Host 包），
 * 所以下面 `FIELDS` 里的字段清单与默认值是**手抄的一份**。
 *
 * 为了防止静默漂移，本文件顶部留了两个**机器可读**的契约注释，
 * `scripts/dev/test-client-settings.mjs` 会拿它们与宿主 schema 逐项比对：
 *
 *   「@dsh-pet-」+「fields: 字段清单」
 *   「@dsh-pet-」+「defaults: 默认值 JSON」
 *
 * （上面刻意把字样拆开写：否则这段说明本身会被那条正则匹配到，
 * 变成"契约"里的字段 —— 第一版就这么踩了，测试报的字段名是「...」。）
 *
 * **改字段或默认值时，那两个契约注释必须一起改**，否则单测会红。
 */

// @dsh-pet-fields: autoStart, startDelayMs, stopOnUnload, size, alwaysOnTop, lowBalanceThreshold, balancePollSeconds, refreshSeconds
// @dsh-pet-defaults: {"autoStart":true,"startDelayMs":3000,"stopOnUnload":true,"size":260,"alwaysOnTop":true,"lowBalanceThreshold":10,"balancePollSeconds":30,"refreshSeconds":300}

window.__ModuleLoader__.load({
  id: 'dsh-pet-ds',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** 宿主 loader 行的 `id:` —— 它同时就是设置命名空间。 */
    const NS = 'dsh-pet-ds'

    /** 本插件的本地化命名空间。 */
    const LOCALE_NS = 'settings.dshPet'

    // ---------------------------------------------------------------- 文案
    const zh = {
      nav: '桌宠',
      title: '桌宠',
      intro: '调整桌宠的启动方式、窗口与余额监控。改动会写入当前 profile 的配置并立即生效。',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      discard: '放弃修改',
      reset: '恢复默认',
      overridden: '已覆盖',
      savingFailed: '保存被拒绝（可能配置已被别处改过）。已重新读取当前值，请再试一次。',
      unavailable: '该插件当前未加载，暂时无法配置。',
      readOnly: '本部署的设置为只读。',
      loading: '读取配置中…',
      invalidNumber: '请填数字。',
      groupStartup: '启动',
      groupWindow: '窗口',
      groupBalance: '余额监控',
      autoStart: '自动启动桌宠',
      autoStartHint: '插件启用后自动把桌宠叫起来。关掉后只能用工具或右键手动启动。',
      startDelayMs: '启动延迟（毫秒）',
      startDelayMsHint: '避开 DSH 启动高峰的等待时间。默认 3000。',
      stopOnUnload: '退出 DSH 时关闭桌宠',
      stopOnUnloadHint: '关掉后桌宠会在 DSH 退出后继续留在桌面上。',
      size: '桌宠宽度（像素）',
      sizeHint: '窗口宽度，高度按素材比例自动计算。默认 260。',
      alwaysOnTop: '始终显示在最上层',
      alwaysOnTopHint: '关掉后桌宠就是个普通窗口，会被别的窗口盖住。',
      lowBalanceThreshold: '余额告急阈值（元）',
      lowBalanceThresholdHint: '余额低于此值时，桌宠下方那块面板转为告急配色。',
      refreshSeconds: '余额刷新周期（秒）',
      refreshSecondsHint: '余额刷新与消费播报的间隔。下限 5 秒（接口有限流），默认 300（5 分钟）。',
    }
    const en = {
      nav: 'Desktop pet',
      title: 'Desktop pet',
      intro:
        'Configure how the pet starts, its window, and balance monitoring. Changes are written to this profile and apply immediately.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      discard: 'Discard changes',
      reset: 'Reset to default',
      overridden: 'Overridden',
      savingFailed: 'The save was rejected (the configuration may have changed elsewhere). Current values were re-read; try again.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      readOnly: 'This deployment stores settings read-only.',
      loading: 'Loading configuration…',
      invalidNumber: 'Enter a number.',
      groupStartup: 'Startup',
      groupWindow: 'Window',
      groupBalance: 'Balance monitoring',
      autoStart: 'Start the pet automatically',
      autoStartHint: 'Bring the pet up as soon as the plugin is enabled.',
      startDelayMs: 'Start delay (ms)',
      startDelayMsHint: 'Wait before starting, to avoid the boot peak. Default 3000.',
      stopOnUnload: 'Close the pet when DSH exits',
      stopOnUnloadHint: 'When off, the pet stays on the desktop after DSH quits.',
      size: 'Pet width (px)',
      sizeHint: 'Window width; height follows the artwork ratio. Default 260.',
      alwaysOnTop: 'Always on top',
      alwaysOnTopHint: 'When off, the pet is an ordinary window that other windows can cover.',
      lowBalanceThreshold: 'Low-balance threshold',
      lowBalanceThresholdHint: 'Below this amount the panel under the pet turns to the warning colour.',
      refreshSeconds: 'Balance refresh interval (s)',
      refreshSecondsHint: 'How often the balance is refreshed and spending is announced. Minimum 5 (the API is rate limited); default 300.',
    }

    // ---------------------------------------------------------------- 字段定义
    /*
     * `kind` 决定用哪种控件：
     *   'boolean' → 勾选框（原生 checkbox + role="switch" 的语义）
     *   'number'  → 数字输入框（带 min/max/step）
     *
     * `default` 必须与宿主 schema 一致（顶部契约注释会与它比对）。
     */
    const FIELDS = [
      { key: 'autoStart', kind: 'boolean', group: 'groupStartup', default: true },
      { key: 'startDelayMs', kind: 'number', group: 'groupStartup', default: 3000, min: 0, max: 60000, step: 100 },
      { key: 'stopOnUnload', kind: 'boolean', group: 'groupStartup', default: true },
      { key: 'size', kind: 'number', group: 'groupWindow', default: 260, min: 80, max: 1200, step: 20 },
      { key: 'alwaysOnTop', kind: 'boolean', group: 'groupWindow', default: true },
      { key: 'lowBalanceThreshold', kind: 'number', group: 'groupBalance', default: 10, min: 0, step: 1 },
      { key: 'refreshSeconds', kind: 'number', group: 'groupBalance', default: 300, min: 5, max: 3600, step: 1 },
    ]

    /** 分组显示顺序。 */
    const GROUPS = ['groupStartup', 'groupWindow', 'groupBalance']

    // ---------------------------------------------------------------- 样式
    /*
     * 样式用 `<style data-plugin-css>` 注入一次（官方做法）。
     * 类名带 `dshpet-` 前缀避免与宿主或其他插件撞车。
     * 颜色**只用** `--dsw-alias-*` 令牌 —— 令牌名变了只会掉色，不会崩。
     */
    const CSS = `
.dshpet-section{max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:16px}
.dshpet-heading{margin:0;font-size:18px;font-weight:600}
.dshpet-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px}
.dshpet-group{display:flex;flex-direction:column;gap:2px}
.dshpet-group-title{margin:0 0 6px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dshpet-row{display:flex;align-items:flex-start;gap:16px;padding:10px 0;border-top:.5px solid var(--dsw-alias-border-l2)}
.dshpet-row:first-child{border-top:0}
.dshpet-row-main{flex:1 1 auto;min-width:0}
.dshpet-label{display:flex;align-items:center;gap:8px;font-size:13px;line-height:20px}
.dshpet-badge{font-size:11px;line-height:16px;padding:0 6px;border-radius:9px;color:var(--dsw-alias-label-tertiary);border:.5px solid var(--dsw-alias-border-l2)}
.dshpet-hint{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dshpet-control{flex:0 0 auto;display:flex;align-items:center;gap:8px}
.dshpet-input{width:110px;box-sizing:border-box;padding:5px 8px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px}
.dshpet-input:focus{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dshpet-input:disabled{color:var(--dsw-alias-label-dimmed);cursor:not-allowed}
.dshpet-input[data-invalid=true]{border-color:var(--dsw-alias-state-error-primary)}
.dshpet-check{width:16px;height:16px;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer;margin:0}
.dshpet-check:disabled{cursor:not-allowed}
.dshpet-reset{font:inherit;font-size:12px;cursor:pointer;color:var(--dsw-alias-label-tertiary);background:0 0;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;padding:3px 8px}
.dshpet-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dshpet-reset:disabled{opacity:.5;cursor:not-allowed}
.dshpet-footer{display:flex;align-items:center;gap:10px;padding-top:4px}
.dshpet-btn{font:inherit;font-size:13px;cursor:pointer;border-radius:6px;padding:6px 14px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:0 0}
.dshpet-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshpet-btn[data-primary=true]{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-inverted)}
.dshpet-btn:disabled{opacity:.5;cursor:not-allowed}
.dshpet-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dshpet-note[data-error=true]{color:var(--dsw-alias-state-error-primary)}
.dshpet-note[data-ok=true]{color:var(--dsw-alias-state-success-primary)}
`

    /** 注入样式（只注入一次；按 data-plugin-css 去重，与官方写法一致）。 */
    function ensureStyle() {
      if (typeof document === 'undefined') return
      const tagId = 'dsh-pet-ds/settings.css'
      if (document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-pet-ds'
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ---------------------------------------------------------------- 表单模型
    /**
     * 把 scope 的 observable 折成"可编辑的草稿 + 保存/放弃/重置"。
     *
     * 为什么要自己写这一层：DSH 的 `configForms` **只提供读写原语**
     * （`set`/`unset`/`mutate`），没有"草稿"的概念 —— 官方 UI 里那套
     * `SettingsFormModel` 属于被禁止依赖的 primitives 包，所以这里自己实现。
     */
    class PetForm {
      /** @param scope configForms 给出的命名空间 scope */
      constructor(scope) {
        this.scope = scope
        /** 已保存的值（来自 scope 的 `value`）。 */
        this.saved = {}
        /** 草稿（用户在界面上改出来的值）。 */
        this.draft = {}
        /** 保存时读到的 revision，用作乐观并发栅栏。 */
        this.baselineRevision = undefined
        this.status = 'loading'
        this.writable = false
        this.saving = false
        this.failed = false
        this.justSaved = false
        /**
         * 用户是否**编辑过**草稿。
         *
         * 与 `isDirty()` 是两件事：`touched` 表示"人动过"，
         * `isDirty()` 表示"草稿与已保存值不同"。首次同步时两者都为假，
         * 但草稿需要被填入 —— 所以判据用 `touched`。
         */
        this.touched = false
        this.listeners = new Set()
        /*
         * 递增的版本号 —— 给 `useSyncExternalStore` 的 `getSnapshot` 用。
         *
         * ⚠️ `getSnapshot` **必须返回稳定值**（同一状态下每次调用都相等），
         * 否则 React 会判定"快照一直在变"而抛
         * "The result of getSnapshot should be cached"并无限重渲染。
         * 所以这里返回数字版本号，而不是对象。
         */
        this.version = 0
        this.off = scope.subscribe(() => this.sync())
        this.sync()
      }

      /** 订阅草稿/状态变化。 */
      subscribe = (fn) => {
        this.listeners.add(fn)
        return () => this.listeners.delete(fn)
      }

      /** `useSyncExternalStore` 的快照读取器。 */
      getVersion = () => this.version

      emit() {
        this.version += 1
        for (const fn of this.listeners) {
          try {
            fn()
          } catch {
            // 单个订阅者出错不该拖垮别的。
          }
        }
      }

      /** 从 scope 快照重新读入已保存值。 */
      sync() {
        const snap = this.scope.getSnapshot()
        this.status = snap.status
        this.writable = Boolean(snap.writable)
        const value = snap.value && typeof snap.value === 'object' ? snap.value : {}
        const next = {}
        for (const f of FIELDS) {
          next[f.key] = readNumberish(value[f.key], f)
        }
        this.saved = next
        /*
         * 只有"用户还没编辑过"时才让宿主的新值覆盖草稿。
         *
         * ⚠️ 判据必须是**显式的编辑标记**，不能用 `isDirty()` ——
         * 首次 `sync()` 时草稿还是空对象，用"脏"判断会得到"脏"，
         * 于是初始草稿永远填不上（实测踩过：初始化后 `isDirty()` 恒为真）。
         */
        if (!this.touched) {
          this.draft = { ...next }
          this.baselineRevision = snap.revision
        }
        this.emit()
      }

      /** 某个字段是否已被 profile 覆盖（presence 判定）。 */
      isOverridden(key) {
        const snap = this.scope.getSnapshot()
        const user = snap.user
        return Boolean(user && typeof user === 'object' && Object.hasOwn(user, key))
      }

      /** 是否有未保存的改动。 */
      isDirty() {
        for (const f of FIELDS) {
          if (this.draft[f.key] !== this.saved[f.key]) return true
        }
        return false
      }

      /** 某个字段的草稿值是否非法。 */
      invalidOf(field) {
        if (field.kind !== 'number') return false
        const v = this.draft[field.key]
        return v === null || v === undefined || !Number.isFinite(v)
      }

      /** 是否任一字段非法（非法时不允许保存）。 */
      hasInvalid() {
        return FIELDS.some((f) => this.invalidOf(f))
      }

      /** 改一个字段（布尔用勾选框，数字用输入框）。 */
      edit(key, raw) {
        const field = FIELDS.find((f) => f.key === key)
        if (!field) return
        if (field.kind === 'boolean') {
          this.draft[key] = Boolean(raw)
        } else {
          const text = String(raw ?? '').trim()
          // 空输入记为 null（非法），而不是 0 —— 0 对某些字段是合法值。
          this.draft[key] = text === '' ? null : Number(text)
        }
        this.failed = false
        this.justSaved = false
        this.touched = true
        this.emit()
      }

      /** 把某个字段恢复为默认：草稿改成默认值，保存时用 unset 删掉覆盖。 */
      resetField(key) {
        const field = FIELDS.find((f) => f.key === key)
        if (!field) return
        this.draft[key] = field.default
        this.failed = false
        this.justSaved = false
        this.touched = true
        this.emit()
      }

      /** 放弃所有未保存改动。 */
      discard() {
        this.draft = { ...this.saved }
        this.failed = false
        this.justSaved = false
        this.touched = false
        this.emit()
      }

      /**
       * 保存：把与已保存值不同的字段组成一批 ops 提交。
       *
       * 两种 op：
       *  · 草稿 === 字段默认值 → `unset`（删掉 profile 覆盖，回落继承值）
       *  · 否则              → `set`
       *
       * 用 `unset` 而不是 `set` 成默认值，是为了让 `cordis.patch.yml` 保持干净 ——
       * 否则用户点一次"恢复默认"反而会在配置里留下一行冗余覆盖。
       */
      async save() {
        if (!this.writable || this.saving || this.hasInvalid() || !this.isDirty()) return
        const ops = []
        for (const f of FIELDS) {
          if (this.draft[f.key] === this.saved[f.key]) continue
          if (this.draft[f.key] === f.default) ops.push({ op: 'unset', path: [f.key] })
          else ops.push({ op: 'set', path: [f.key], value: this.draft[f.key] })
        }
        if (ops.length === 0) return

        this.saving = true
        this.failed = false
        this.emit()
        let ok = false
        try {
          ok = await this.scope.mutate(ops, this.baselineRevision)
        } catch {
          ok = false
        }
        this.saving = false
        if (ok) {
          this.justSaved = true
          // 成功时 scope 会把新视图折进镜像，sync() 会把 saved 更新成新值。
          this.sync()
          this.justSaved = true
        } else {
          // 失败：scope 已自动重读；把草稿丢掉，让界面反映宿主真值。
          this.failed = true
          this.draft = { ...this.saved }
        }
        this.emit()
      }
    }

    /** schema 的 number 字段可能是 number，也可能是数字字符串 —— 统一成 number|null。 */
    function readNumberish(value, field) {
      if (field.kind === 'boolean') {
        if (typeof value === 'boolean') return value
        return field.default
      }
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value)
        if (Number.isFinite(n)) return n
      }
      return field.default
    }

    // ---------------------------------------------------------------- 视图

    /** 一行：左边标签+说明，右边控件（+ 已覆盖徽标、恢复默认按钮）。 */
    function FieldRow(props) {
      const { field, form, t } = props
      const overridden = form.isOverridden(field.key)
      const invalid = form.invalidOf(field)
      const disabled = !form.writable || form.saving
      const value = form.draft[field.key]

      const control =
        field.kind === 'boolean'
          ? h('input', {
              type: 'checkbox',
              className: 'dshpet-check',
              role: 'switch',
              'aria-checked': value === true ? 'true' : 'false',
              'aria-label': t(field.key),
              checked: value === true,
              disabled,
              onChange: (e) => form.edit(field.key, e.target.checked),
            })
          : h('input', {
              type: 'number',
              className: 'dshpet-input',
              inputMode: 'numeric',
              'data-invalid': invalid ? 'true' : 'false',
              'aria-label': t(field.key),
              'aria-invalid': invalid ? 'true' : 'false',
              value: value === null || value === undefined ? '' : String(value),
              min: field.min,
              max: field.max,
              step: field.step,
              disabled,
              onChange: (e) => form.edit(field.key, e.target.value),
            })

      return h(
        'div',
        { className: 'dshpet-row', 'data-field': field.key },
        h(
          'div',
          { className: 'dshpet-row-main' },
          h(
            'div',
            { className: 'dshpet-label' },
            h('span', null, t(field.key)),
            overridden ? h('span', { className: 'dshpet-badge' }, t('overridden')) : null,
          ),
          h('p', { className: 'dshpet-hint' }, t(`${field.key}Hint`)),
          invalid ? h('p', { className: 'dshpet-note', 'data-error': 'true' }, t('invalidNumber')) : null,
        ),
        h(
          'div',
          { className: 'dshpet-control' },
          control,
          overridden
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dshpet-reset',
                  disabled,
                  onClick: () => form.resetField(field.key),
                },
                t('reset'),
              )
            : null,
        ),
      )
    }

    /** 设置栏主体。 */
    function PetSettingsSection(props) {
      const { t, form } = props
      /*
       * 用 `useSyncExternalStore` 订阅草稿变化（React 18 的标准做法）：
       * 它保证并发渲染下读到一致快照。快照是**版本号**（稳定值），
       * 不能返回对象 —— 具体原因见 `this.version` 处的注释。
       */
      React.useSyncExternalStore(form.subscribe, form.getVersion)

      if (form.status === 'loading') {
        return h(
          'div',
          { className: 'dshpet-section' },
          h('h2', { className: 'dshpet-heading' }, t('title')),
          h('p', { className: 'dshpet-intro' }, t('loading')),
        )
      }
      if (form.status === 'unavailable') {
        return h(
          'div',
          { className: 'dshpet-section' },
          h('h2', { className: 'dshpet-heading' }, t('title')),
          h('p', { className: 'dshpet-intro' }, t('unavailable')),
        )
      }

      const dirty = form.isDirty()
      const canSave = form.writable && dirty && !form.hasInvalid() && !form.saving

      const groupNodes = GROUPS.map((group) =>
        h(
          'div',
          { className: 'dshpet-group', key: group },
          h('h3', { className: 'dshpet-group-title' }, t(group)),
          ...FIELDS.filter((f) => f.group === group).map((field) =>
            h(FieldRow, { key: field.key, field, form, t }),
          ),
        ),
      )

      const statusNote = form.failed
        ? h('p', { className: 'dshpet-note', 'data-error': 'true' }, t('savingFailed'))
        : form.justSaved
          ? h('p', { className: 'dshpet-note', 'data-ok': 'true' }, t('saved'))
          : !form.writable
            ? h('p', { className: 'dshpet-note' }, t('readOnly'))
            : null

      return h(
        'div',
        { className: 'dshpet-section' },
        h('h2', { className: 'dshpet-heading' }, t('title')),
        h('p', { className: 'dshpet-intro' }, t('intro')),
        ...groupNodes,
        h(
          'div',
          { className: 'dshpet-footer' },
          h(
            'button',
            {
              type: 'button',
              className: 'dshpet-btn',
              'data-primary': 'true',
              disabled: !canSave,
              onClick: () => void form.save(),
            },
            form.saving ? t('saving') : t('save'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshpet-btn',
              disabled: !dirty || form.saving,
              onClick: () => form.discard(),
            },
            t('discard'),
          ),
          statusNote,
        ),
      )
    }

    return {
      /** 需要的客户端服务：槽位、本地化、配置表单。 */
      inject: ['slots', 'locale', 'configForms'],

      apply(ctx) {
        ensureStyle()

        const t = ctx.locale.bind(LOCALE_NS)
        ctx.effect(
          () => ctx.locale.register(LOCALE_NS, { zh, en }),
          'dsh-pet-ds: settings dictionaries',
        )

        /*
         * 取 scope。命名空间就是宿主 loader 行的 `id:`。
         * `whileServed` 保证只在宿主真的在服务这个命名空间时才注册页面 ——
         * 否则宿主插件没加载时会画出一个空壳栏（用户点进去只有报错）。
         */
        const form = new PetForm(ctx.configForms.get(NS))
        ctx.effect(
          () => () => {
            try {
              form.off?.()
            } catch {
              // 忽略退订失败。
            }
          },
          'dsh-pet-ds: settings form subscription',
        )

        ctx.effect(
          () =>
            ctx.configForms.whileServed([NS], () =>
              ctx.slots.inject('settings.section', () =>
                ctx.slots.register(
                  {
                    name: 'settings.section',
                    id: 'dsh-pet-ds',
                    // 排在官方栏目后面，不与它们抢位置。
                    order: 60,
                    label: () => t('nav'),
                    locale: LOCALE_NS,
                    inject: () => ({ form }),
                  },
                  PetSettingsSection,
                ),
              ),
            ),
          'dsh-pet-ds: settings section',
        )
      },
    }
  },
})
