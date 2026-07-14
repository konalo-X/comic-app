'use strict'
const crypto = require('crypto')
function uuidv4() { return crypto.randomUUID() }

/**
 * @typedef {Object} Job
 * @property {string} id - 作业ID
 * @property {string} type - 作业类型
 * @property {number} priority - 优先级（0-3，越小越优先）
 * @property {string} status - 状态（waiting/active/completed/failed/cancelled/paused/delayed）
 * @property {*} payload - 作业参数
 * @property {*} [result] - 执行结果
 * @property {string} [error] - 错误信息
 * @property {*} [progress] - 进度信息
 * @property {number} progress_current - 当前进度
 * @property {number} progress_total - 总进度
 * @property {number} retry_count - 重试次数
 * @property {number} max_retries - 最大重试次数
 * @property {number} created_at - 创建时间戳
 * @property {number} updated_at - 更新时间戳
 * @property {number} [started_at] - 开始时间戳
 * @property {number} [completed_at] - 完成时间戳
 */

/**
 * @typedef {Object} JobStats
 * @property {number} waiting - 等待中
 * @property {number} active - 执行中
 * @property {number} completed - 已完成
 * @property {number} failed - 已失败
 * @property {number} cancelled - 已取消
 * @property {number} total - 总数
 */

/**
 * @typedef {Object} JobOptions
 * @property {number} [priority=2] - 优先级（0-3）
 * @property {number} [maxRetries=3] - 最大重试次数
 * @property {string} [id] - 指定作业ID
 * @property {boolean} [checkRateLimit=true] - 是否检查速率限制
 * @property {number} [timeout] - 超时时间（毫秒），超时后任务被标记为失败
 * @property {number} [delay] - 延迟执行时间（毫秒），任务在 delay 毫秒后才开始执行
 * @property {number} [repeat] - 重复间隔（毫秒），任务完成后自动按间隔重新入队
 */

/**
 * @typedef {Object} RateLimitConfig
 * @property {number} maxCount - 窗口内最大数量
 * @property {number} windowMs - 窗口大小（毫秒，0表示仅限制批量大小）
 */

// ============ 公共常量 ============

const JOB_COLUMNS = `id, type, priority, status, payload, error, progress, retry_count,
  progress_current, progress_total, max_retries, timeout, delay, repeat_interval,
  created_at, updated_at, started_at, completed_at`

const STATUS_ACTIVE = ['waiting', 'running', 'active', 'paused', 'delayed']

const ERROR_CLASSIFICATION = [
  { pattern: /timeout|econnreset|522/i, type: 'temporary_network' },
  { pattern: /503|502|504/i, type: 'temporary_server' },
  { pattern: /429|too many requests/i, type: 'rate_limit' },
  { pattern: /404|410/i, type: 'permanent_not_found' },
  { pattern: /403|401/i, type: 'permanent_forbidden' },
  { pattern: /parse|undefined/i, type: 'parse_error' }
]

const ALERT_THRESHOLDS = {
  rate_limit: 10,
  permanent_forbidden: 5,
  temporary_network: 20,
  temporary_server: 15,
  parse_error: 10
}

const DEFAULT_TIMEOUT = 5 * 60 * 1000 // 5 分钟
const DEFAULT_RETENTION_MS = 7 * 24 * 3600 * 1000 // 7 天
const MAINTENANCE_INTERVAL = 60 * 1000 // 1 分钟
const STALL_TIMEOUT = 10 * 60 * 1000 // 10 分钟无进度视为 stall

/**
 * 持久化作业队列 — 支持优先级、超时、延迟、重复、TTL 清理
 *
 * 优先级（数值越小越优先）：
 *   0 = 紧急（用户交互下载）
 *   1 = 高（用户触发补全/更新）
 *   2 = 中（自动补全标签）
 *   3 = 低（自动检查更新）
 *
 * 依赖 better-sqlite3（WAL 模式自动持久化，无需手动 save）
 */
class JobQueue {
  constructor(db, options = {}) {
    this.db = db
    this.concurrency = options.concurrency || 5
    this.typeConcurrency = options.typeConcurrency || {}
    this.handlers = new Map()
    this.listeners = new Map()
    this._mutexGroups = new Map()

    this._active = new Map()
    this._paused = false
    this._tickScheduled = false

    this._singletonTypes = new Set(options.singletonTypes || [])

    this.rateLimits = options.rateLimits || {}
    this._rateLimitTimestamps = new Map()

    this._jobRetentionMs = options.jobRetentionMs ?? DEFAULT_RETENTION_MS
    this._defaultTimeout = options.defaultTimeout ?? DEFAULT_TIMEOUT
    this.autoRetryConfig = options.autoRetryConfig || {}

    this._initTable()
    this._migrateSchema()
    this._recover()
    this._startMaintenance()
  }

  // ============ 数据库初始化 ============

  _initTable() {
    const db = this.db
    db.exec(`CREATE TABLE IF NOT EXISTS job_queue (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      priority INTEGER DEFAULT 2,
      status TEXT DEFAULT 'waiting',
      payload TEXT,
      result TEXT,
      error TEXT,
      progress TEXT,
      progress_total INTEGER DEFAULT 0,
      progress_current INTEGER DEFAULT 0,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 3,
      timeout INTEGER,
      delay INTEGER,
      repeat_interval INTEGER,
      last_progress_at INTEGER,
      created_at INTEGER,
      updated_at INTEGER,
      started_at INTEGER,
      completed_at INTEGER
    )`)
    db.exec('CREATE INDEX IF NOT EXISTS idx_job_status ON job_queue(status)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_job_type ON job_queue(type)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_job_priority ON job_queue(priority, created_at)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_job_completed ON job_queue(completed_at)')

    db.exec(`CREATE TABLE IF NOT EXISTS job_failure_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reason TEXT UNIQUE,
      count INTEGER DEFAULT 0,
      last_update INTEGER
    )`)
  }

  _migrateSchema() {
    try {
      const cols = this.db.prepare("PRAGMA table_info('job_queue')").all().map(c => c.name)
      const migrations = [
        { name: 'timeout', sql: "ALTER TABLE job_queue ADD COLUMN timeout INTEGER" },
        { name: 'delay', sql: "ALTER TABLE job_queue ADD COLUMN delay INTEGER" },
        { name: 'repeat_interval', sql: "ALTER TABLE job_queue ADD COLUMN repeat_interval INTEGER" },
        { name: 'last_progress_at', sql: "ALTER TABLE job_queue ADD COLUMN last_progress_at INTEGER" },
        { name: 'auto_retry_count', sql: "ALTER TABLE job_queue ADD COLUMN auto_retry_count INTEGER DEFAULT 0" }
      ]
      for (const m of migrations) {
        if (!cols.includes(m.name)) {
          this.db.exec(m.sql)
          console.log(`[JobQueue] 迁移: 添加列 ${m.name}`)
        }
      }
    } catch (e) {
      console.warn('[JobQueue] 迁移失败:', e.message)
    }
  }

  // ============ 公共辅助方法 ============

  _rowToJob(row) {
    if (!row) return null
    return {
      id: row.id, type: row.type, priority: row.priority, status: row.status,
      payload: row.payload ? JSON.parse(row.payload) : null,
      error: row.error,
      progress: row.progress ? JSON.parse(row.progress) : null,
      retryCount: row.retry_count, maxRetries: row.max_retries,
      progressCurrent: row.progress_current, progressTotal: row.progress_total,
      timeout: row.timeout, delay: row.delay, repeatInterval: row.repeat_interval,
      createdAt: row.created_at, updatedAt: row.updated_at,
      startedAt: row.started_at, completedAt: row.completed_at
    }
  }

  _updateStatus(id, status, extra = {}, extraWhere = '') {
    const sets = ['updated_at = ?']
    const vals = [Date.now()]
    if (status !== null && status !== undefined) {
      sets.unshift('status = ?')
      vals.unshift(status)
    }
    for (const [k, v] of Object.entries(extra)) {
      sets.push(`${k} = ?`)
      vals.push(v)
    }
    vals.push(id)
    return this.db.prepare(`UPDATE job_queue SET ${sets.join(', ')} WHERE id = ?${extraWhere}`).run(...vals)
  }

  _queryJobs(where, params = [], order = 'priority ASC, created_at ASC', limit = null) {
    let sql = `SELECT ${JOB_COLUMNS} FROM job_queue`
    if (where) sql += ` WHERE ${where}`
    sql += ` ORDER BY ${order}`
    if (limit) sql += ` LIMIT ${limit}`
    return this.db.prepare(sql).all(...params).map(r => this._rowToJob(r))
  }

  // ============ 速率限制 ============

  checkRateLimit(type) {
    const limit = this.rateLimits[type]
    if (!limit || limit.maxCount <= 0) return true
    const now = Date.now()
    const history = this._rateLimitTimestamps.get(type) || []
    const windowStart = limit.windowMs > 0 ? now - limit.windowMs : 0
    const recent = windowStart > 0 ? history.filter(t => t >= windowStart) : history
    this._rateLimitTimestamps.set(type, recent)
    if (recent.length >= limit.maxCount) return false
    recent.push(now)
    return true
  }

  // ============ 崩溃恢复 ============

  _recover() {
    const now = Date.now()
    try {
      const activeJobs = this.db.prepare(
        `SELECT id, type, retry_count, max_retries FROM job_queue WHERE status='active'`
      ).all()
      let recovered = 0, exhausted = 0
      for (const job of activeJobs) {
        if (job.retry_count + 1 >= job.max_retries) {
          this._updateStatus(job.id, 'failed', { error: '崩溃恢复重试次数耗尽', retry_count: job.retry_count + 1 })
          exhausted++
        } else {
          this._updateStatus(job.id, 'waiting', { retry_count: job.retry_count + 1 })
          recovered++
        }
      }
      if (recovered > 0) console.log(`[JobQueue] 恢复 ${recovered} 个中断任务（active -> waiting）`)
      if (exhausted > 0) console.log(`[JobQueue] ${exhausted} 个任务重试次数耗尽，标记为 failed`)
    } catch (e) {
      console.warn('[JobQueue] _recover 失败（数据库可能只读）:', e.message)
    }
    this._scheduleTick()
  }

  // ============ 互斥组 ============

  registerMutexGroup(group, types) {
    this._mutexGroups.set(group, new Set(types))
  }

  _canStart(type) {
    for (const [, types] of this._mutexGroups) {
      if (!types.has(type)) continue
      for (const [, entry] of this._active) {
        if (types.has(entry.job.type)) return false
      }
    }
    return true
  }

  _getMutexConflictingTask(type) {
    for (const [, types] of this._mutexGroups) {
      if (!types.has(type)) continue
      for (const [id, entry] of this._active) {
        if (types.has(entry.job.type)) return { id, entry }
      }
    }
    return null
  }

  // ============ 错误分类和统计 ============

  _classifyError(errorMsg) {
    if (!errorMsg) return 'unknown'
    const msg = errorMsg.toLowerCase()
    for (const { pattern, type } of ERROR_CLASSIFICATION) {
      if (pattern.test(msg)) return type
    }
    return 'unknown'
  }

  _recordFailureStats(errorType) {
    try {
      const row = this.db.prepare('SELECT count FROM job_failure_stats WHERE reason = ?').get(errorType)
      const count = (row ? row.count : 0) + 1
      this.db.prepare('INSERT OR REPLACE INTO job_failure_stats (reason, count, last_update) VALUES (?, ?, ?)')
        .run(errorType, count, Date.now())
      this._checkFailureAlerts(errorType)
    } catch (e) {
      console.error('[JobQueue] 记录失败统计失败:', e.message)
    }
  }

  getFailureStats() {
    return this.db.prepare('SELECT reason, count, last_update FROM job_failure_stats ORDER BY count DESC').all()
      .map(r => ({ reason: r.reason, count: r.count, lastUpdate: r.last_update }))
  }

  _checkFailureAlerts() {
    const stats = this.getFailureStats()
    for (const stat of stats) {
      const threshold = ALERT_THRESHOLDS[stat.reason] || 100
      if (stat.count >= threshold) {
        console.warn(`[JobQueue] [告警] ${stat.reason} 失败次数达到 ${stat.count} 次，超过阈值 ${threshold}`)
        this._emit('alert', { type: 'failure_threshold', reason: stat.reason, count: stat.count, threshold })
      }
    }
  }

  // ============ 注册处理器 ============

  register(type, handler) {
    if (this.handlers.has(type)) throw new Error(`处理器已注册: ${type}`)
    this.handlers.set(type, handler)
  }

  // ============ 运行时配置 ============

  updateTypeConcurrency(concurrencyMap) {
    if (!concurrencyMap || typeof concurrencyMap !== 'object') return
    this.typeConcurrency = { ...this.typeConcurrency, ...concurrencyMap }
    console.log(`[JobQueue] typeConcurrency 已更新:`, this.typeConcurrency)
  }

  // ============ 事件系统 ============

  on(event, callback) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event).add(callback)
    return () => this.listeners.get(event)?.delete(callback)
  }

  _emit(event, data) {
    const cbs = this.listeners.get(event)
    if (cbs) for (const cb of cbs) cb(data)
  }

  // ============ 作业提交 ============

  _insertJob(type, payload, opts = {}) {
    const id = opts.id || uuidv4()
    const now = Date.now()
    const priority = opts.priority ?? 2
    const delay = opts.delay || 0
    const status = delay > 0 ? 'delayed' : 'waiting'
    this.db.prepare(`INSERT OR IGNORE INTO job_queue
      (id, type, priority, status, payload, max_retries, timeout, delay, repeat_interval, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, type, priority, status, JSON.stringify(payload),
        opts.maxRetries ?? 3, opts.timeout ?? null, delay || null,
        opts.repeat ?? null, now, now)
    return { id, priority }
  }

  add(type, payload, opts = {}) {
    if (this._singletonTypes.has(type)) {
      const existing = this.db.prepare(
        `SELECT id, priority, status FROM job_queue WHERE type = ? AND status IN ('waiting', 'active', 'delayed') LIMIT 1`
      ).get(type)
      if (existing) {
        const newPriority = opts.priority ?? 2
        if (newPriority >= existing.priority) {
          console.log(`[JobQueue] 单例类型 ${type} 已有 priority=${existing.priority} 任务 ${existing.id.substring(0, 8)}，跳过重复入队（新 priority=${newPriority}）`)
          return existing.id
        }
        console.log(`[JobQueue] 单例抢占: ${type} priority=${newPriority} 替换现有 priority=${existing.priority} 任务 ${existing.id.substring(0, 8)}`)
        this.cancel(existing.id)
      }
    }

    if (opts.checkRateLimit !== false && !this.checkRateLimit(type)) {
      console.log(`[JobQueue] 任务 ${type} 被速率限制，跳过入队`)
      return null
    }

    const { id, priority } = this._insertJob(type, payload, opts)

    if (priority <= 1 && this._active.size >= this.concurrency) {
      this._preemptFor(priority, type)
    }
    this._scheduleTick()
    this._emit('enqueued', { jobId: id, type })
    return id
  }

  addBatch(type, payloads, opts = {}) {
    const ids = []
    const now = Date.now()
    const stmt = this.db.prepare(`INSERT OR IGNORE INTO job_queue
      (id, type, priority, status, payload, max_retries, timeout, delay, repeat_interval, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    const limit = this.rateLimits[type]
    let maxBatch = payloads.length
    if (limit && limit.maxCount > 0 && limit.windowMs === 0) {
      maxBatch = Math.min(maxBatch, limit.maxCount)
    }
    for (let i = 0; i < maxBatch; i++) {
      const id = uuidv4()
      stmt.run(id, type, opts.priority ?? 2, 'waiting', JSON.stringify(payloads[i]),
        opts.maxRetries ?? 3, opts.timeout ?? null, null, null, now, now)
      ids.push(id)
    }
    if (payloads.length > maxBatch) {
      console.log(`[JobQueue] ${type} 批量入队超过限制 ${maxBatch}，已截断（原 ${payloads.length}）`)
    }
    this._scheduleTick()
    if (ids.length > 0) this._emit('enqueued', { jobIds: ids, type, count: ids.length })
    return ids
  }

  findByType(type) {
    const row = this.db.prepare(
      `SELECT ${JOB_COLUMNS} FROM job_queue
       WHERE type = ? AND status IN ('waiting', 'running', 'active', 'delayed')
       ORDER BY priority ASC, created_at ASC LIMIT 1`
    ).get(type)
    return this._rowToJob(row)
  }

  // ============ 状态控制 ============

  pause() { this._paused = true }
  resume() { this._paused = false; this._scheduleTick() }

  pauseJob(jobId) {
    const active = this._active.get(jobId)
    if (active) {
      this._updateStatus(jobId, 'paused')
      active.controller.cancelled = true
      active.controller._paused = true
      this._active.delete(jobId)
      this._emit('paused', { jobId })
      console.log(`[JobQueue] 暂停活跃任务 ${jobId.substring(0, 8)}`)
    } else {
      const result = this._updateStatus(jobId, 'paused', {}, 'AND status = \'waiting\'')
      if (result.changes > 0) this._emit('paused', { jobId })
    }
  }

  resumeJob(jobId) {
    const row = this.db.prepare(`SELECT type FROM job_queue WHERE id = ? AND status = 'paused'`).get(jobId)
    if (!row) {
      console.warn(`[JobQueue] resumeJob 失败: ${jobId} 不存在或非 paused 状态`)
      return
    }
    if (this._singletonTypes.has(row.type)) {
      const existing = this.db.prepare(
        `SELECT id FROM job_queue WHERE type = ? AND status IN ('waiting', 'active', 'delayed') LIMIT 1`
      ).get(row.type)
      if (existing) {
        console.warn(`[JobQueue] resumeJob 拒绝: 单例类型 ${row.type} 已有活跃任务 ${existing.id.substring(0, 8)}`)
        return
      }
    }
    this._updateStatus(jobId, 'waiting', {}, 'AND status = \'paused\'')
    this._scheduleTick()
    this._emit('resumed', { jobId })
  }

  cancel(jobId) {
    this._updateStatus(jobId, 'cancelled')
    const active = this._active.get(jobId)
    if (active) {
      active.controller.cancelled = true
      active.controller._cancelled = true
      this._active.delete(jobId)
      console.log(`[JobQueue] 取消活跃任务 ${jobId.substring(0, 8)}`)
    }
    this._emit('cancelled', { jobId })
  }

  retry(jobId) {
    this.db.prepare(`UPDATE job_queue SET status = 'waiting', retry_count = 0, error = NULL, updated_at = ?
      WHERE id = ? AND (status = 'failed' OR status = 'cancelled')`).run(Date.now(), jobId)
    this._scheduleTick()
    this._emit('retried', { jobId })
  }

  retryAll() {
    this.db.prepare(`UPDATE job_queue SET status = 'waiting', retry_count = 0, error = NULL, updated_at = ?
      WHERE (status = 'failed' OR status = 'cancelled')`).run(Date.now())
    this._scheduleTick()
    this._emit('retriedAll', {})
  }

  clear() {
    this.db.prepare(`DELETE FROM job_queue WHERE status IN ('completed', 'cancelled')`).run()
    this._emit('cleared', {})
  }

  // ============ 查询 ============

  getStats() {
    const rows = this.db.prepare(`SELECT status, COUNT(*) as c FROM job_queue GROUP BY status`).all()
    const stats = { waiting: 0, active: 0, delayed: 0, completed: 0, failed: 0, cancelled: 0, total: 0 }
    for (const row of rows) {
      if (stats[row.status] !== undefined) stats[row.status] = row.c
      stats.total += row.c
    }
    return stats
  }

  listJobs(status = 'all', limit = 50) {
    const STATUS_ACTIVE_QUERY = ['waiting', 'running', 'active', 'paused']
    if (status === 'all') {
      return this._queryJobs(null, [], 'priority ASC, created_at DESC', limit)
    } else if (status === 'active') {
      return this._queryJobs(
        `status IN (${STATUS_ACTIVE_QUERY.map(() => '?').join(',')})`,
        STATUS_ACTIVE_QUERY, 'priority ASC, created_at DESC', limit
      )
    } else {
      return this._queryJobs('status = ?', [status], 'priority ASC, created_at DESC', limit)
    }
  }

  getJob(jobId) {
    return this._rowToJob(
      this.db.prepare(`SELECT ${JOB_COLUMNS} FROM job_queue WHERE id = ?`).get(jobId)
    )
  }

  // ============ 内部调度 ============

  // 同步复位被抢占任务: 立即把 DB 状态 active -> waiting, 避免依赖 _finalizeJob 的异步回写产生竞态死锁
  _preemptReset(id) {
    try {
      this._updateStatus(id, 'waiting', { error: '被高优先级任务抢占, 复位等待重跑' })
    } catch (e) {
      console.warn('[JobQueue] 抢占复位失败:', e.message)
    }
  }

  _preemptFor(newPriority, type) {
    // 优先处理互斥组冲突：如果新任务属于互斥组，直接抢占组内冲突任务
    if (type) {
      const conflict = this._getMutexConflictingTask(type)
      if (conflict && conflict.entry.job.priority > newPriority) {
        console.log(`[JobQueue] 抢占(互斥): 暂停 ${conflict.entry.job.type}(p=${conflict.entry.job.priority}) 为 ${type}(p=${newPriority}) 腾出位置`)
        conflict.entry.controller.cancelled = true
        conflict.entry.controller._preempted = true
        this._active.delete(conflict.id)
        this._preemptReset(conflict.id)
        return
      }
    }
    // 否则抢占最低优先级的自动任务（priority >= 2）
    let lowestEntry = null
    let lowestPriority = -1
    for (const [id, entry] of this._active) {
      if (entry.job.priority > lowestPriority && entry.job.priority >= 2) {
        lowestPriority = entry.job.priority
        lowestEntry = entry
      }
    }
    if (lowestEntry) {
      console.log(`[JobQueue] 抢占: 暂停 priority=${lowestPriority} 任务 ${lowestEntry.job.id.substring(0, 8)}，为 priority=${newPriority} 腾出位置`)
      lowestEntry.controller.cancelled = true
      lowestEntry.controller._preempted = true
      this._active.delete(lowestEntry.job.id)
      this._preemptReset(lowestEntry.job.id)
    }
  }

  _scheduleTick() {
    if (this._tickScheduled) return
    this._tickScheduled = true
    setImmediate(() => { this._tickScheduled = false; this._tick() })
  }

  async _tick() {
    // ============ 自愈: 复位卡死的 active 僵尸任务(无条件, 不受并发/暂停影响) ============
    // 抢占/竞态可能让任务从内存 _active 删除但 DB 仍标 active, 且永不被重新调度 -> 死锁。
    // 每轮检测: DB 标 active 但不在内存 _active, 且超过 15 分钟无进度更新 -> 复位为 waiting。
    try {
      const STALL_MS = 8 * 60 * 1000
      const zombies = this.db.prepare(
        `SELECT id FROM job_queue WHERE status = 'active'
         AND (last_progress_at IS NULL OR last_progress_at < ?)`
      ).all(Date.now() - STALL_MS)
      for (const z of zombies) {
        if (this._active.has(z.id)) continue // 真在跑, 不动
        this._updateStatus(z.id, 'waiting', { error: '自愈: 复位卡死的 active 僵尸任务' })
        console.log(`[JobQueue] 自愈: 复位卡死任务 ${z.id.substring(0, 8)} (active -> waiting)`)
      }
    } catch (e) {
      console.warn('[JobQueue] 自愈扫描失败:', e.message)
    }

    if (this._paused) return
    if (this._active.size >= this.concurrency) return

    const waiting = this.db.prepare(
      `SELECT id, type, priority, payload, max_retries, retry_count, timeout
       FROM job_queue WHERE status = 'waiting'
       ORDER BY priority ASC, created_at ASC LIMIT 500`
    ).all()

    // 先检查最高优先级任务是否因互斥组被阻塞，是则抢占并等待下一轮
    if (this._tryMutexPreempt(waiting)) return

    // 循环填满并发槽: 之前只 `await _executeJob(row)` 会一直等到整个任务跑完,
    // 导致无论 concurrency 多大都只串行跑 1 个。现在不 await(启动时同步把任务加进 _active),
    // 循环直到 active 填满或无可启动任务。
    while (this._active.size < this.concurrency) {
      const activeTypeCounts = {}
      for (const entry of this._active.values()) {
        const t = entry.job.type
        activeTypeCounts[t] = (activeTypeCounts[t] || 0) + 1
      }
      const row = waiting.find(r => {
        if (this._active.has(r.id)) return false
        if (!this._canStart(r.type)) return false
        const typeMax = this.typeConcurrency[r.type]
        if (typeMax !== undefined && typeMax > 0) {
          if ((activeTypeCounts[r.type] || 0) >= typeMax) return false
        } else {
          if (activeTypeCounts[r.type] && r.priority > 1) return false
        }
        return true
      })
      if (!row) break
      // 不 await: _executeJob 同步先 _updateStatus(active)+_active.set, 再异步跑 handler
      this._executeJob(row)
    }
  }

  _tryMutexPreempt(waiting) {
    if (waiting.length === 0) return
    const top = waiting[0]
    if (this._canStart(top.type)) return

    const conflict = this._getMutexConflictingTask(top.type)
    if (conflict && conflict.entry.job.priority > top.priority) {
      console.log(`[JobQueue] 互斥抢占: 暂停 ${conflict.entry.job.type}(p=${conflict.entry.job.priority}) 为 ${top.type}(p=${top.priority}) 腾出位置`)
      conflict.entry.controller.cancelled = true
      conflict.entry.controller._preempted = true
      this._active.delete(conflict.id)
      this._preemptReset(conflict.id)
      this._scheduleTick()
    }
  }

  async _executeJob(row) {
    const { id, type, priority, payload: payloadStr, max_retries: maxRetries, retry_count: retryCount, timeout } = row
    const payload = JSON.parse(payloadStr)
    const handler = this.handlers.get(type)
    if (!handler) {
      this._updateStatus(id, 'failed', { error: `未知作业类型: ${type}` })
      this._scheduleTick()
      return
    }

    this._updateStatus(id, 'active', { started_at: Date.now(), last_progress_at: Date.now() })

    const controller = { cancelled: false }
    this._active.set(id, { job: { id, type, priority, payload }, controller })

    try {
      let lastProgressTime = 0
      let pendingProgress = null
      const onProgress = (data) => {
        const now = Date.now()
        pendingProgress = data
        if (now - lastProgressTime >= 1000) {
          lastProgressTime = now
          const d = pendingProgress
          pendingProgress = null
          this._updateStatus(id, null, {
            progress: JSON.stringify(d),
            progress_current: d.current ?? 0,
            progress_total: d.total ?? 0,
            last_progress_at: now
          })
        }
        this._emit('progress', { jobId: id, type, ...data })
      }

      const jobTimeout = timeout || this._defaultTimeout
      const result = await this._runWithTimeout(
        handler({ id, type, priority, payload, cancelled: () => controller.cancelled }, onProgress),
        jobTimeout,
        id, type
      )

      const now = Date.now()
      if (pendingProgress) {
        const d = pendingProgress
        pendingProgress = null
        this._updateStatus(id, null, {
          progress: JSON.stringify(d),
          progress_current: d.current ?? 0,
          progress_total: d.total ?? 0,
          last_progress_at: now
        })
      }

      this._finalizeJob(id, type, controller, result, retryCount, maxRetries, now)
    } catch (e) {
      this._handleJobError(id, type, controller, e, retryCount, maxRetries)
    } finally {
      this._active.delete(id)
      setImmediate(() => this._scheduleTick())
    }
  }

  async _runWithTimeout(promise, timeoutMs, jobId, type) {
    if (!timeoutMs || timeoutMs <= 0) return promise
    const timer = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`任务超时 (${timeoutMs / 1000}s)`)), timeoutMs)
    )
    try {
      return await Promise.race([promise, timer])
    } catch (e) {
      if (e.message && e.message.includes('任务超时')) {
        console.warn(`[JobQueue] 任务 ${jobId.substring(0, 8)} (${type}) 超时 (${timeoutMs / 1000}s)`)
      }
      throw e
    }
  }

  _finalizeJob(id, type, controller, result, retryCount, maxRetries, now) {
    if (controller._paused) {
      console.log(`[JobQueue] 任务 ${id} (${type}) 已被外部暂停，状态保持 paused`)
    } else if (controller._cancelled) {
      console.log(`[JobQueue] 任务 ${id} (${type}) 已被外部取消，状态保持 cancelled`)
    } else if (controller._preempted) {
      this._updateStatus(id, 'waiting')
      this._emit('paused', { jobId: id, type, reason: 'preempted' })
      console.log(`[JobQueue] 任务 ${id} (${type}) 被抢占，已回到等待队列`)
    } else {
      this._updateStatus(id, 'completed', {
        result: typeof result === 'string' ? result : JSON.stringify(result),
        completed_at: now
      })
      this._emit('completed', { jobId: id, type, result })
      this._handleRepeat(id, type)
    }
  }

  _handleJobError(id, type, controller, e, retryCount, maxRetries) {
    const error = e.message || String(e)
    const now = Date.now()
    const errorType = this._classifyError(error)
    this._recordFailureStats(errorType)

    const newRetryCount = retryCount + 1
    if (newRetryCount < maxRetries) {
      this._updateStatus(id, 'waiting', { retry_count: newRetryCount, error })
      this._emit('retrying', { jobId: id, type, error, retry: newRetryCount, maxRetries })
    } else {
      this._updateStatus(id, 'failed', { error, retry_count: newRetryCount })
      this._emit('failed', { jobId: id, type, error, errorType })
      this._scheduleAutoRetry(id, type)
    }
  }

  _handleRepeat(id, type) {
    const job = this._rowToJob(
      this.db.prepare(`SELECT repeat_interval, payload FROM job_queue WHERE id = ?`).get(id)
    )
    if (!job || !job.repeatInterval) return

    const existing = this.db.prepare(
      `SELECT id FROM job_queue WHERE type = ? AND status IN ('waiting', 'active', 'delayed') LIMIT 1`
    ).get(type)
    if (existing) {
      console.log(`[JobQueue] 重复任务 ${type} 已有活跃实例，跳过`)
      return
    }

    this._insertJob(type, job.payload, {
      priority: this._singletonTypes.has(type) ? 3 : 2,
      delay: job.repeatInterval,
      repeat: job.repeatInterval,
      maxRetries: 3
    })
    console.log(`[JobQueue] 重复任务 ${type} 已安排，${job.repeatInterval / 1000}s 后执行`)
  }

  _scheduleAutoRetry(id, type) {
    const config = this.autoRetryConfig[type]
    if (!config) return

    const job = this.db.prepare(
      `SELECT auto_retry_count, updated_at FROM job_queue WHERE id = ?`
    ).get(id)
    if (!job) return

    const autoRetryCount = job.auto_retry_count || 0
    const maxAutoRetries = config.maxAutoRetries || 3

    if (autoRetryCount >= maxAutoRetries) {
      console.log(`[JobQueue] ${type} 自动重试已达上限 (${autoRetryCount}/${maxAutoRetries})，放弃`)
      return
    }

    const newAutoRetryCount = autoRetryCount + 1
    const backoff = config.backoff || 2
    const baseDelay = config.delay || 30 * 60 * 1000
    const delay = Math.round(baseDelay * Math.pow(backoff, autoRetryCount))

    this.db.prepare(
      `UPDATE job_queue SET auto_retry_count = ?, retry_count = 0, error = NULL, updated_at = ? WHERE id = ?`
    ).run(newAutoRetryCount, Date.now(), id)

    console.log(`[JobQueue] ${type} 自动重试 #${newAutoRetryCount}/${maxAutoRetries}，${Math.round(delay / 60000)} 分钟后执行`)
    this._emit('autoRetryScheduled', { jobId: id, type, attempt: newAutoRetryCount, maxAutoRetries, delayMs: delay })
  }

  _retryFailedJobs() {
    const now = Date.now()
    const rows = this.db.prepare(
      `SELECT id, type, auto_retry_count, updated_at FROM job_queue
       WHERE status = 'failed'
       ORDER BY updated_at ASC LIMIT 100`
    ).all()

    let retried = 0
    for (const r of rows) {
      const config = this.autoRetryConfig[r.type]
      if (!config) continue

      const maxAutoRetries = config.maxAutoRetries || 3
      const autoRetryCount = r.auto_retry_count || 0

      if (autoRetryCount >= maxAutoRetries) continue

      const backoff = config.backoff || 2
      const baseDelay = config.delay || 30 * 60 * 1000
      const delay = autoRetryCount === 0
        ? baseDelay
        : Math.round(baseDelay * Math.pow(backoff, autoRetryCount - 1))

      if (r.updated_at && (r.updated_at + delay) > now) continue

      const newAutoRetryCount = autoRetryCount + 1
      console.log(`[JobQueue] 自动重试失败任务 ${r.id.substring(0, 8)} (${r.type}) #${newAutoRetryCount}/${maxAutoRetries}`)
      this.db.prepare(
        `UPDATE job_queue SET status = 'waiting', retry_count = 0, error = NULL, auto_retry_count = ?, updated_at = ? WHERE id = ?`
      ).run(newAutoRetryCount, now, r.id)
      this._emit('autoRetried', { jobId: r.id, type: r.type })
      retried++
    }

    if (retried > 0) {
      console.log(`[JobQueue] 自动重试了 ${retried} 个失败任务`)
      this._scheduleTick()
    }
  }

  // ============ 定期维护 ============

  _startMaintenance() {
    this._maintenanceTimer = setInterval(() => {
      this._activateDelayedJobs()
      this._cleanupExpiredJobs()
      this._detectStalledJobs()
      this._retryFailedJobs()
    }, MAINTENANCE_INTERVAL)
    this._maintenanceTimer.unref()
  }

  _activateDelayedJobs() {
    const now = Date.now()
    try {
      const rows = this.db.prepare(
        `SELECT id FROM job_queue WHERE status = 'delayed' AND delay IS NOT NULL AND (created_at + delay) <= ? LIMIT 100`
      ).all(now)
      if (rows.length > 0) {
        for (const r of rows) {
          this._updateStatus(r.id, 'waiting')
        }
        console.log(`[JobQueue] 激活 ${rows.length} 个延迟任务`)
        this._scheduleTick()
      }
    } catch (e) {
      console.warn('[JobQueue] 激活延迟任务失败:', e.message)
    }
  }

  _cleanupExpiredJobs() {
    if (this._jobRetentionMs <= 0) return
    const cutoff = Date.now() - this._jobRetentionMs
    try {
      const result = this.db.prepare(
        `DELETE FROM job_queue WHERE status IN ('completed', 'failed', 'cancelled') AND completed_at IS NOT NULL AND completed_at < ?`
      ).run(cutoff)
      if (result.changes > 0) {
        console.log(`[JobQueue] 清理 ${result.changes} 个过期记录（> ${Math.round(this._jobRetentionMs / 86400000)} 天）`)
      }
    } catch (e) {
      console.warn('[JobQueue] 清理过期记录失败:', e.message)
    }
  }

  _detectStalledJobs() {
    const cutoff = Date.now() - STALL_TIMEOUT
    try {
      const stalled = this.db.prepare(
        `SELECT id, type FROM job_queue
         WHERE status = 'active' AND (last_progress_at IS NULL OR last_progress_at < ?)`
      ).all(cutoff)
      for (const job of stalled) {
        const active = this._active.get(job.id)
        if (active) {
          console.warn(`[JobQueue] 检测到停滞任务 ${job.id.substring(0, 8)} (${job.type})，强制取消`)
          active.controller.cancelled = true
          this._active.delete(job.id)
        }
        this._updateStatus(job.id, 'failed', { error: '任务停滞：超过 10 分钟无进度' })
        this._emit('failed', { jobId: job.id, type: job.type, error: '任务停滞', errorType: 'stalled' })
      }
      if (stalled.length > 0) {
        this._scheduleTick()
      }
    } catch (e) {
      console.warn('[JobQueue] 停滞检测失败:', e.message)
    }
  }

  // ============ 运行时查询 ============

  getActiveJobCount() {
    return this._active.size
  }

  getActiveJobIds() {
    return Array.from(this._active.keys())
  }

  destroy() {
    if (this._maintenanceTimer) {
      clearInterval(this._maintenanceTimer)
      this._maintenanceTimer = null
    }
    this._active.clear()
    this.listeners.clear()
  }
}

module.exports = JobQueue