/**
 * dsh-dl-progress — host 半区。
 *
 * 提供两条进度来源：
 *
 * 1. **自带下载工具 `download_file`**（主要方式）
 *    插件自己拉取并落盘，字节数在自己的循环里累加——进度是精确的，
 *    不依赖命令解析，也不需要约定"用 curl -o 绝对路径"。
 *
 * 2. **jobs 事件识别 shell 下载**（补充方式）
 *    每条 shell 命令都是一个 job，job.label 就是完整命令；命中下载特征
 *    （curl -o / Invoke-WebRequest -OutFile / pip install / git clone …）时建卡。
 *    命令里带字面 Windows 路径才能统计字节，否则只有总大小或跑马灯。
 *
 * 另外仍支持约定式进度文件 ~/.dsh/download-progress/<id>.json。
 */
import { promises as fs } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, isAbsolute, basename, dirname } from 'node:path'

/** 稳定插件名；与 cordis.patch.yml 的 name 一致。 */
export const name = 'dsh-dl-progress'

/** 依赖的服务：web 路由、jobs 事件、工具注册。 */
export const inject = ['webServer', 'jobs', 'tools']

/** 状态接口前缀。 */
const ROUTE = '/dsh-dl-progress'

/** 约定式进度文件目录。 */
const PROGRESS_DIR = join(homedir(), '.dsh', 'download-progress')

/** 完成态任务在内存里保留多久。 */
const KEEP_FINISHED_MS = 30_000

/** 文件大小轮询间隔。 */
const POLL_MS = 400

/** 进度刷新节流（写盘时每 N 毫秒更新一次任务）。 */
const FLUSH_MS = 150

/** 单个任务最长跟踪时间。 */
const MAX_TRACK_MS = 30 * 60_000

/**
 * shell 下载命令特征。必须带落盘参数才算：
 * curl -o/-O，Invoke-WebRequest -OutFile，Start-BitsTransfer -Destination，
 * 以及包管理器 / git clone 这类本身就是下载语义的命令。
 */
const DOWNLOAD_CMD = /(\bwget\b|\bcurl\b[^|;&]*?(?:\s-o\s|\s-O\b|--output(?:-document)?\b)|\baria2c\b[^|;&]*?(?:\s-o\s|--dir\b)|\bgit\s+clone\b|\bpip3?\s+install\b|\bnpm\s+(?:i|install|ci)\b|\bpnpm\s+(?:i|install|add)\b|\byarn\s+(?:add|install)\b|\bhuggingface-cli\s+download\b|\bhf\s+download\b|\bollama\s+pull\b|\binvoke-webrequest\b[^|;&]*?-outfile\b|\bstart-bitstransfer\b[^|;&]*?-destination\b)/i

/** Windows 绝对路径（盘符或 UNC）。 */
const WIN_ABS = /^(?:[a-zA-Z]:[\\/]|\\\\)/

/** 单次下载允许的最大体积（防止误操作写爆磁盘）。 */
const MAX_BYTES = 8 * 1024 * 1024 * 1024

/**
 * 从命令行解析 URL 与输出路径。
 * @param {string} cmd - 命令行。
 * @returns {{url: string, out: string}} 解析结果。
 */
function parseDownload(cmd) {
  const urlMatch = cmd.match(/https?:\/\/[^\s'"`]+/i)
  const url = urlMatch ? urlMatch[0].replace(/[),;]+$/, '') : ''

  let out = ''
  const patterns = [
    /-OutFile\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i,
    /-Destination\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i,
    /(?:^|\s)(?:-o|--output|--output-document|--dir)(?:\s+|=)(?:"([^"]+)"|'([^']+)'|(\S+))/i,
  ]
  for (const re of patterns) {
    const m = cmd.match(re)
    if (m) {
      out = m[1] || m[2] || m[3] || ''
      if (out) break
    }
  }
  if (!out && /(?:^|\s)-O(?:\s|$)/.test(cmd) && url) {
    out = url.split(/[?#]/)[0].split('/').filter(Boolean).pop() || ''
  }
  if (!out && /\bwget\b/i.test(cmd) && url) {
    out = url.split(/[?#]/)[0].split('/').filter(Boolean).pop() || ''
  }
  return { url, out }
}

/**
 * 任务名：优先输出文件名，其次 URL 尾段，最后截断命令。
 * @param {string} cmd - 命令行或 URL。
 * @param {string} out - 输出路径。
 * @param {string} url - 下载地址。
 * @returns {string} 任务名。
 */
function taskNameFrom(cmd, out, url) {
  if (out && WIN_ABS.test(out)) {
    const base = out.split(/[\\/]/).filter(Boolean).pop()
    if (base) return base.slice(0, 60)
  }
  if (url) {
    const tail = url.split(/[?#]/)[0].split('/').filter(Boolean).pop()
    if (tail) return decodeURIComponent(tail).slice(0, 60)
  }
  return cmd.replace(/\s+/g, ' ').trim().slice(0, 60) || '下载任务'
}

/**
 * 字节数格式化。
 * @param {number} n - 字节。
 * @returns {string} 可读大小。
 */
function fmtBytes(n) {
  const v = Number(n) || 0
  if (v < 1024) return v + ' B'
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB'
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB'
  return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

/**
 * 探测远端总大小：先 HEAD 取 content-length，再退到 `Range: bytes=0-0`
 * 从 `Content-Range: bytes 0-0/<total>` 取（很多源 HEAD 不回长度）。
 * @param {string} url - 下载地址。
 * @returns {Promise<number>} 字节数；不可知为 0。
 */
async function probeTotal(url) {
  /**
   * 发一次请求并读长度头。
   * @param {object} init - fetch 初始化。
   * @param {boolean} preferRange - true 时优先 content-range。
   * @returns {Promise<number>} 字节数或 0。
   */
  async function attempt(init, preferRange) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    try {
      const res = await fetch(url, { redirect: 'follow', signal: controller.signal, ...init })
      const range = res.headers.get('content-range')
      const m = range && range.match(/\/(\d+)\s*$/)
      const fromRange = m ? (Number(m[1]) || 0) : 0
      const len = Number(res.headers.get('content-length') || 0)
      const fromLength = Number.isFinite(len) && len > 0 ? len : 0
      const total = preferRange ? (fromRange || fromLength) : (fromLength || fromRange)
      try { await res.body?.cancel() } catch { /* 只读头，丢弃正文 */ }
      return total
    } finally {
      clearTimeout(timer)
    }
  }

  try {
    const head = await attempt({ method: 'HEAD' }, false)
    if (head > 0) return head
  } catch {
    /* 退到 Range 探测 */
  }
  try {
    return await attempt({ method: 'GET', headers: { Range: 'bytes=0-0' } }, true)
  } catch {
    return 0
  }
}

/**
 * 安装插件。
 * @param {object} ctx - 插件上下文。
 */
export function apply(ctx) {
  /** @type {Map<string, object>} 任务表。 */
  const tasks = new Map()
  /** @type {Map<string, ReturnType<typeof setInterval>>} 任务 id → 轮询定时器。 */
  const timers = new Map()
  let seq = 0

  /** 停掉某任务的轮询。 */
  function stopTimer(id) {
    const t = timers.get(id)
    if (t !== undefined) {
      clearInterval(t)
      timers.delete(id)
    }
  }

  /** 停掉全部轮询。 */
  function stopAllTimers() {
    for (const t of timers.values()) clearInterval(t)
    timers.clear()
  }

  /**
   * 列出任务并清理过期完成态。
   * @returns {object[]} 任务数组。
   */
  function list() {
    const now = Date.now()
    const out = []
    for (const [id, t] of tasks) {
      const finished = t.status !== 'running'
      if (finished && now - (t.updatedAt || 0) > KEEP_FINISHED_MS) {
        tasks.delete(id)
        continue
      }
      out.push(t)
    }
    out.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))
    return out
  }

  /** 合并约定式进度文件（优先级最高）。 */
  async function mergeProgressFiles() {
    let names
    try {
      names = await fs.readdir(PROGRESS_DIR)
    } catch {
      return
    }
    for (const n of names) {
      if (!n.endsWith('.json')) continue
      try {
        const text = await fs.readFile(join(PROGRESS_DIR, n), 'utf8')
        const obj = JSON.parse(text)
        if (!obj || typeof obj !== 'object' || !obj.id) continue
        let key = obj.id
        if (!tasks.has(key)) {
          for (const [tid, t] of tasks) {
            if (t.status === 'running' && t.name === obj.name) { key = tid; break }
          }
        }
        const prev = tasks.get(key) || {}
        tasks.set(key, {
          startedAt: prev.startedAt || Date.now(),
          ...prev,
          ...obj,
          id: key,
          updatedAt: obj.updatedAt || Date.now(),
        })
      } catch {
        /* 单个坏文件跳过 */
      }
    }
  }

  /**
   * 跟踪 shell 下载的输出文件大小。
   * @param {string} id - 任务 id。
   * @param {string} file - 绝对路径。
   * @param {string} url - 下载地址。
   */
  function trackFileSize(id, file, url) {
    const startedAt = Date.now()
    let totalTried = false
    let lastSize = -1
    let lastAt = startedAt
    const timer = setInterval(async () => {
      const task = tasks.get(id)
      const now = Date.now()
      if (!task || task.status !== 'running' || now - startedAt > MAX_TRACK_MS) {
        stopTimer(id)
        return
      }
      if (file) {
        try {
          const st = await fs.stat(file)
          const delta = lastSize < 0 ? 0 : st.size - lastSize
          const dt = now - lastAt
          if (delta > 0 && dt > 0) {
            const inst = delta / (dt / 1000)
            task.speed = task.speed > 0 ? task.speed * 0.7 + inst * 0.3 : inst
            task.etaMs = task.total > 0 && task.speed > 1
              ? Math.max(0, Math.round(((task.total - st.size) / task.speed) * 1000))
              : null
          }
          lastSize = st.size
          lastAt = now
          task.received = st.size
          task.updatedAt = now
        } catch {
          /* 文件还没创建 */
        }
      }
      if (!totalTried && task.total === 0 && url) {
        totalTried = true
        const len = await probeTotal(url)
        if (len > 0) {
          task.total = len
          task.updatedAt = Date.now()
        }
      }
    }, POLL_MS)
    timers.set(id, timer)
  }

  /**
   * 把 shell job 变成任务。
   * @param {object} job - job 视图。
   * @param {string} id - 任务 id。
   */
  function ingestJob(job, id) {
    const label = String(job.label || '')
    if (!DOWNLOAD_CMD.test(label)) return
    const { url, out } = parseDownload(label)
    const literal = out && WIN_ABS.test(out)
    tasks.set(id, {
      id,
      name: taskNameFrom(label, out, url),
      url,
      file: literal ? out : '',
      status: 'running',
      received: 0,
      total: 0,
      speed: 0,
      etaMs: null,
      startedAt: typeof job.startedAt === 'number' ? job.startedAt : Date.now(),
      updatedAt: Date.now(),
      source: 'job',
    })
    trackFileSize(id, literal ? out : '', url)
  }

  /**
   * 插件自带的下载实现：自己流式落盘，字节数在循环里累加，进度精确。
   * @param {{url: string, path?: string}} args - 工具参数。
   * @param {object} exec - 工具执行上下文（含 signal）。
   * @returns {Promise<object>} 工具结果。
   */
  async function runDownload(args, exec) {
    const url = String(args?.url || '').trim()
    if (!/^https?:\/\//i.test(url)) return { ok: false, message: '需要 http(s) 下载地址' }

    let dest = typeof args?.path === 'string' ? args.path.trim() : ''
    if (!dest) {
      const tail = url.split(/[?#]/)[0].split('/').filter(Boolean).pop() || 'download.bin'
      let safe = tail
      try { safe = decodeURIComponent(tail) } catch { /* 保留原样 */ }
      safe = safe.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
      dest = join(tmpdir(), safe || 'download.bin')
    }
    if (!isAbsolute(dest)) return { ok: false, message: `保存路径必须是绝对路径: ${dest}` }

    const id = `tool-${Date.now().toString(36)}-${++seq}`
    const task = {
      id,
      name: basename(dest),
      url,
      file: dest,
      status: 'running',
      received: 0,
      total: 0,
      speed: 0,
      etaMs: null,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      source: 'download_file',
    }
    tasks.set(id, task)

    const controller = new AbortController()
    const onAbort = () => controller.abort()
    try { exec?.signal?.addEventListener?.('abort', onAbort, { once: true }) } catch { /* 无 signal */ }

    let handle
    try {
      const res = await fetch(url, { redirect: 'follow', signal: controller.signal })
      if (!res.ok) {
        task.status = 'failed'
        task.updatedAt = Date.now()
        return { ok: false, message: `下载失败：HTTP ${res.status}` }
      }
      const len = Number(res.headers.get('content-length') || 0)
      task.total = Number.isFinite(len) && len > 0 ? len : 0
      if (task.total > MAX_BYTES) {
        task.status = 'failed'
        return { ok: false, message: `文件过大（${fmtBytes(task.total)}），超过单次上限` }
      }

      await fs.mkdir(dirname(dest), { recursive: true })
      handle = await fs.open(dest, 'w')

      let received = 0
      let last = Date.now()
      let lastBytes = 0
      for await (const chunk of res.body) {
        await handle.write(chunk)
        received += chunk.length
        if (received > MAX_BYTES) {
          task.status = 'failed'
          task.detail = '超过单次上限'
          return { ok: false, message: `已中止：超过 ${fmtBytes(MAX_BYTES)} 上限` }
        }
        const now = Date.now()
        if (now - last >= FLUSH_MS) {
          const dt = (now - last) / 1000
          if (dt > 0) {
            const inst = (received - lastBytes) / dt
            task.speed = task.speed > 0 ? task.speed * 0.7 + inst * 0.3 : inst
            task.etaMs = task.total > 0 && task.speed > 1
              ? Math.max(0, Math.round(((task.total - received) / task.speed) * 1000))
              : null
          }
          task.received = received
          task.updatedAt = now
          last = now
          lastBytes = received
        }
      }
      task.received = received
      task.total = task.total || received
      task.status = 'done'
      task.speed = 0
      task.etaMs = null
      task.updatedAt = Date.now()
      return { ok: true, message: `已下载 ${fmtBytes(received)} → ${dest}`, bytes: received, path: dest }
    } catch (error) {
      task.status = 'failed'
      task.detail = String(error?.message ?? error)
      task.updatedAt = Date.now()
      return { ok: false, message: `下载失败：${task.detail}` }
    } finally {
      try { await handle?.close() } catch { /* 忽略 */ }
      try { exec?.signal?.removeEventListener?.('abort', onAbort) } catch { /* 忽略 */ }
    }
  }

  /** 挂状态路由。 */
  function mountRoute(service) {
    ctx.effect(() => service.register({
      kind: 'prefix',
      path: ROUTE,
      async handler(req, res) {
        const url = String(req.url || '').split('?')[0]
        if (url !== `${ROUTE}/state`) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('not found')
          return
        }
        try { await mergeProgressFiles() } catch { /* 忽略 */ }
        const body = JSON.stringify({ tasks: list(), now: Date.now() })
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(body)
      },
    }), 'download-progress: state route')
  }

  if (ctx.webServer) mountRoute(ctx.webServer)

  // 自带下载工具：进度由插件自己算，不依赖任何命令约定。
  ctx.effect(() => ctx.tools.register({
    name: 'download_file',
    description: '下载文件到本地，进度实时显示在界面右下角的下载面板（任务名 + 真实百分比）。'
      + '下载长文件优先用它，而不是 curl / Invoke-WebRequest：它自己流式写盘并统计字节数，'
      + '不受 shell 路径与引号影响。path 必须是绝对路径；省略则存到临时目录并以 URL 文件名命名。',
    parameters: {
      url: { type: 'string', description: 'http(s) 下载地址' },
      path: { type: 'string', description: '保存的绝对路径（可选）' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
    },
    execute: runDownload,
  }), 'download-progress: download_file tool')

  ctx.effect(() => () => stopAllTimers(), 'download-progress: timers')

  // shell 下载的补充识别：每个命令都是一个 job，label 即完整命令。
  ctx.effect(() => ctx.jobs.events.subscribe({}, (event) => {
    try {
      const job = event && event.job
      if (!job || !job.id) return
      const id = `job:${job.id}`
      if (event.type === 'registered') {
        if (tasks.has(id)) return
        ingestJob(job, id)
      } else if (event.type === 'stopping' || event.type === 'settled') {
        const t = tasks.get(id)
        if (!t) return
        t.status = job.status === 'failed' ? 'failed' : 'done'
        t.updatedAt = Date.now()
        stopTimer(id)
      }
    } catch {
      /* 事件处理失败不影响宿主 */
    }
  }), 'download-progress: jobs events')
}
