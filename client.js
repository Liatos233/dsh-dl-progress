/**
 * dsh-dl-progress — 浏览器半区。
 *
 * 加载器契约（DSH 0.2.2 起）：
 *   window.__ModuleLoader__.load({ id, factory })
 * 旧写法 `load(factory)` 已废弃——那样注册出来的 registration.id 是 undefined，
 * 加载器会在 stripClientSuffix 里对 undefined 调用 endsWith 而报错，表现为
 * "entry did not activate / import failed"。
 *
 * 另一个约束：模块体的一切副作用必须留在 factory 闭包里（加载器只执行 factory
 * 完成注册，真正 materialize 才跑函数体），所以 DOM 操作全部放在 apply 内。
 *
 * 纯 DOM 实现，不依赖 React，不占用任何 slot：在 body 上挂右下角悬浮面板，
 * 每 700ms 轮询 host 的 /dsh-dl-progress/state，渲染任务名 + 进度条，
 * 没有任务时整块隐藏。
 */
window.__ModuleLoader__.load({
  id: 'dsh-dl-progress',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const ID = 'dsh-dl-progress'
    const ABS = '/dsh-dl-progress/state'
    const REL = 'dsh-dl-progress/state'
    const POLL_MS = 700

    /** 相对当前页面推导备用地址，兼容反代子路径部署。 */
    function relativeRoute() {
      const path = window.location.pathname
      const base = path.endsWith('/') ? path : path.replace(/[^/]*$/, '')
      return base.replace(/\/+$/, '') + '/' + REL
    }

    /**
     * 创建一个元素。
     * @param {string} tag - 标签名。
     * @param {string} css - inline style。
     * @param {string} [text] - 文本。
     * @returns {HTMLElement} 元素。
     */
    function el(tag, css, text) {
      const node = document.createElement(tag)
      node.style.cssText = css
      if (text !== undefined) node.textContent = text
      return node
    }

    /**
     * 字节数格式化。
     * @param {number} n - 字节。
     * @returns {string} 人类可读大小。
     */
    function fmtBytes(n) {
      const v = Number(n) || 0
      if (v < 1024) return v + ' B'
      if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB'
      if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB'
      return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB'
    }

    /**
     * 速率格式化。
     * @param {number} bps - 字节每秒。
     * @returns {string} 可读速率。
     */
    function fmtSpeed(bps) {
      const v = Number(bps) || 0
      if (v < 1024) return Math.round(v) + ' B/s'
      if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB/s'
      return (v / 1024 / 1024).toFixed(1) + ' MB/s'
    }

    /**
     * 剩余时间格式化。
     * @param {number} ms - 毫秒。
     * @returns {string} 可读时长。
     */
    function fmtEta(ms) {
      const s = Math.max(0, Math.round((Number(ms) || 0) / 1000))
      if (s < 60) return s + ' 秒'
      const m = Math.floor(s / 60)
      const r = s % 60
      return r ? m + ' 分 ' + r + ' 秒' : m + ' 分'
    }

    /** 挂载面板容器与动画样式；已存在则返回 null（避免重复挂载）。 */
    function mount() {
      if (document.getElementById(ID)) return null
      const box = el('div',
        'position:fixed;right:16px;bottom:16px;z-index:2147483000;display:none;'
        + 'flex-direction:column;gap:8px;max-width:340px;pointer-events:none;'
        + 'font:12px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;')
      box.id = ID
      document.body.appendChild(box)

      const style = document.createElement('style')
      style.id = ID + '-style'
      style.textContent = `@keyframes ${ID}-march{from{background-position:0 0}to{background-position:40px 0}}`
      document.head.appendChild(style)
      return { box, style }
    }

    /**
     * 渲染一张任务卡。
     * @param {object} task - host 返回的任务。
     * @returns {HTMLElement} 卡片元素。
     */
    function card(task) {
      const wrap = el('div',
        'pointer-events:auto;background:#1f2430;color:#e8eaf0;border:1px solid #3a4152;'
        + 'border-radius:10px;padding:8px 10px;box-shadow:0 6px 18px rgba(0,0,0,.35);')

      const top = el('div', 'display:flex;justify-content:space-between;gap:8px;margin-bottom:6px;')
      const name = el('span',
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px;',
        String(task.name || task.id || '下载任务'))

      const total = Number(task.total) || 0
      const received = Number(task.received) || 0
      const pct = total > 0 && received > 0
        ? Math.max(0, Math.min(100, Math.round((received / total) * 100)))
        : null

      let label
      if (pct !== null) label = fmtBytes(received) + ' / ' + fmtBytes(total) + ' · ' + pct + '%'
      else if (total > 0) label = '共 ' + fmtBytes(total)
      else if (task.status === 'done') label = '完成'
      else if (task.status === 'failed') label = '失败'
      else label = '进行中'

      const meta = el('span', 'flex:none;color:#9aa4b8;', label)

      const track = el('div', 'height:6px;border-radius:3px;background:#2c3242;overflow:hidden;')
      let fillCss
      if (pct === null) {
        fillCss = 'height:100%;width:100%;background:repeating-linear-gradient(90deg,#4c8dff 0 20px,#6ba1ff 20px 40px);'
          + `animation:${ID}-march .9s linear infinite;`
      } else {
        const color = task.status === 'failed' ? '#e5484d' : (task.status === 'done' ? '#30a46c' : '#4c8dff')
        fillCss = `height:100%;width:${pct}%;background:${color};transition:width .25s ease;`
      }
      track.appendChild(el('div', fillCss))

      top.append(name, meta)
      wrap.append(top)
      if (task.status === 'running' && Number(task.speed) > 0) {
        const extra = fmtSpeed(task.speed) + (task.etaMs != null ? ' · 剩 ' + fmtEta(task.etaMs) : '')
        wrap.append(el('div', 'color:#7f8aa3;margin:0 0 6px;', extra))
      }
      wrap.append(track)
      return wrap
    }

    /**
     * 安装面板。
     * @param {object} ctx - client 插件上下文。
     */
    function apply(ctx) {
      const mounted = mount()
      if (!mounted) return

      let timer = 0
      let alive = true
      let route = ABS
      let triedFallback = false

      async function tick() {
        if (!alive) return
        try {
          const res = await fetch(route, { cache: 'no-store' })
          if (res.ok) {
            const data = await res.json()
            const tasks = Array.isArray(data && data.tasks) ? data.tasks : []
            mounted.box.replaceChildren(...tasks.map(card))
            mounted.box.style.display = tasks.length ? 'flex' : 'none'
          } else if (!triedFallback && route === ABS) {
            triedFallback = true
            route = relativeRoute()
          }
        } catch {
          if (!triedFallback && route === ABS) {
            triedFallback = true
            route = relativeRoute()
          }
        }
        if (alive) timer = setTimeout(tick, POLL_MS)
      }

      tick()

      const dispose = () => {
        alive = false
        clearTimeout(timer)
        mounted.box.remove()
        mounted.style.remove()
      }
      if (ctx && typeof ctx.effect === 'function') ctx.effect(() => dispose)
      else window.addEventListener('beforeunload', dispose)
    }

    exports.apply = apply
    exports.inject = []
    return module.exports
  },
})
