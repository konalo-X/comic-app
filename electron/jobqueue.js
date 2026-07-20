'use strict'
const crypto = require('crypto')
const os = require('os')
function uuidv4() { return crypto.randomUUID() }
const { JOB_QUEUE } = require('./config')
const logger = require('./logger')

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

const DEFAULT_TIMEOUT = JOB_QUEUE.DEFAULT_TIMEOUT
const DEFAULT_RETENTION_MS = JOB_QUEUE.DEFAULT_RETENTION_MS
const MAINTENANCE_INTERVAL = JOB_QUEUE.MAINTENANCE_INTERVAL
const STALL_TIMEOUT = JOB_QUEUE.STALL_TIMEOUT
const ZOMBIE_SCAN_COOLDOWN = JOB_QUEUE.ZOMBIE_SCAN_COOLDOWN
const CLEANUP_INTERVAL = JOB_QUEUE.CLEANUP_INTERVAL
const AGING_ENABLED = JOB_QUEUE.AGING_ENABLED !== false
const AGING_INTERVAL = JOB_QUEUE.AGING_INTERVAL || 5 * 60 * 1000
const AGING_MIN_PRIORITY = JOB_QUEUE.AGING_MIN_PRIORITY ?? 3
const DYNAMIC_CONCURRENCY_ENABLED = JOB_QUEUE.DYNAMIC_CONCURRENCY !== false
const DYNAMIC_CONCURRENCY_INTERVAL = JOB_QUEUE.DYNAMIC_CONCURRENCY_INTERVAL || 30 * 1000
// 心跳: 周期性强制重扫 waiting 队列, 防止纯事件驱动的 _tick 在事件链断裂时彻底停摆
// (例: sync 单例链 await waitForSyncJob 卡死后, 再无事件触发 _scheduleTick, waiting 任务永不被 pickup)
const HEARTBEAT_INTERVAL = JOB_QUEUE.HEARTBEAT_INTERVAL || 45 * 1000
const DYNAMIC_CONCURRENCY_MIN = JOB_QUEUE.DYNAMIC_CONCURRENCY_MIN || 3
const DYNAMIC_CONCURRENCY_MAX = JOB_QUEUE.DYNAMIC_CONCURRENCY_MAX || 7
const DYNAMIC_CPU_HIGH = JOB_QUEUE.DYNAMIC_CPU_HIGH || 0.8
const DYNAMIC_CPU_LOW = JOB_QUEUE.DYNAMIC_CPU_LOW || 0.5
const DYNAMIC_MEM_LOW = (JOB_QUEUE.DYNAMIC_MEM_LOW_MB || 500) * 1024 * 1024
const DYNAMIC_MEM_HIGH = (JOB_QUEUE.DYNAMIC_MEM_HIGH_MB || 1024) * 1024 * 1024

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
    this._running = new Set()
    this._paused = false
    this._tickScheduled = false
    this._waitingDirty = true

    this._singletonTypes = new Set(options.singletonTypes || [])

    this.rateLimits = options.rateLimits || {}
    this._rateLimitTimestamps = new Map()

    this._jobRetentionMs = options.jobRetentionMs ?? DEFAULT_RETENTION_MS
    this._defaultTimeout = options.defaultTimeout ?? DEFAULT_TIMEOUT
    this.autoRetryConfig = options.autoRetryConfig || {}

    this._lastZombieScan = 0
    this._lastCleanup = 0
    this._lastAging = 0

    // ============ 动态并发 ============
    this._baseConcurrency = this.concurrency
    this._lastCpuSample = null
    this._dynamicConcurrencyTimer = null

    // ============ 进度批量写入 ============
    // 所有活跃任务共享一个 pending map + flush 定时器，减少 DB 写入次数
    // flush 间隔 1500ms：兼顾实时性和写入频率
    // 注意：Map 中不存储 payload，避免 flush 时污染 DB payload 列（Bug 14）
    this._pendingProgress = new Map() // id -> { progress, progress_current, progress_total, last_progress_at }
    this._progressFlushInterval = options.progressFlushInterval ?? 1500
    this._progressFlushTimer = null

    this._initTable()
    this._migrateSchema()
    this._recover()
    this._startMaintenance()
    this._startDynamicConcurrency()
    this._startHeartbeat()
  }

  // ============ 心跳调度 ============
  // 纯事件驱动的 _tick 在 _waitingDirty 为 false 时直接早退, 若存在 waiting 任务却无任何
  // 事件(新增/完成/抢占)触发, 该任务会永久躺平, 自动同步链(await waitForSyncJob)随之死锁.
  // 心跳每 HEARTBEAT_INTERVAL 强制把 _waitingDirty 置 true 并触发一次 _tick, 让 waiting 任务
  // 被定时重新扫描 pickup. 不创建任何任务, 不绕过单例(typeConcurrency=1)保护, 不会产生重复执行.
  _startHeartbeat() {
    if (this._heartbeatTimer) return
    this._heartbeatTimer = setInterval(() => {
      if (this._paused) return
      this._waitingDirty = true
      this._scheduleTick()
    }, HEARTBEAT_INTERVAL)
    if (this._heartbeatTimer.unref) this._heartbeatTimer.unref()
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer)
      this._heartbeatTimer = null
    }
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
        { name: 'auto_retry_count', sql: "ALTER TABLE job_queue ADD COLUMN auto_retry_count INTEGER DEFAULT 0" },
        { name: 'last_aged_at', sql: "ALTER TABLE job_queue ADD COLUMN last_aged_at INTEGER" }
      ]
      for (const m of migrations) {
        if (!cols.includes(m.name)) {
          this.db.exec(m.sql)
          logger.info(`[JobQueue] 迁移: 添加列 ${m.name}`)
        }
      }
    } catch (e) {
      logger.warn('[JobQueue] 迁移失败:', e.message)
    }
  }

  // ============ 公共辅助方法 ============

  _rowToJob(row) {
    if (!row) return null
    let parsedPayload = null
    let parsedProgress = null
    try { if (row.payload) parsedPayload = JSON.parse(row.payload) } catch (e) {}
    try { if (row.progress) parsedProgress = JSON.parse(row.progress) } catch (e) {}
    return {
      id: row.id, type: row.type, priority: row.priority, status: row.status,
      payload: parsedPayload,
      error: row.error,
      progress: parsedProgress,
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

  // ============ 速率限制（按来源区分） ============

  /**
   * 检查速率限制，按任务来源(manual/auto)分开计数
   * 手动任务和自动任务各有独立的速率窗口，避免手动操作被自动任务挡住
   * @param {string} type 任务类型
   * @param {string} [source='auto'] 任务来源 manual/auto
   * @returns {boolean} 是否允许执行
   */
  checkRateLimit(type, source = 'auto') {
    const limit = this.rateLimits[type]
    if (!limit || limit.maxCount <= 0) return true
    const now = Date.now()
    const key = `${type}:${source}`
    const history = this._rateLimitTimestamps.get(key) || []
    const windowStart = limit.windowMs > 0 ? now - limit.windowMs : 0
    const recent = windowStart > 0 ? history.filter(t => t >= windowStart) : history
    this._rateLimitTimestamps.set(key, recent)
    if (recent.length >= limit.maxCount) return false
    recent.push(now)
    return true
  }

  // ============ 崩溃恢复 ============

  _recover() {
    const now = Date.now()
    try {
      const activeJobs = this.db.prepare(
        `SELECT id, type, retry_count, max_retries FROM job_queue WHERE status IN ('active', 'running')`
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
      if (recovered > 0) logger.info(`[JobQueue] 恢复 ${recovered} 个中断任务（active/running -> waiting）`)
      if (exhausted > 0) logger.info(`[JobQueue] ${exhausted} 个任务重试次数耗尽，标记为 failed`)
    } catch (e) {
      logger.warn('[JobQueue] _recover 失败（数据库可能只读）:', e.message)
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
      logger.error('[JobQueue] 记录失败统计失败:', e.message)
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
        logger.warn(`[JobQueue] [告警] ${stat.reason} 失败次数达到 ${stat.count} 次，超过阈值 ${threshold}`)
        this._emit('alert', { type: 'failure_threshold', reason: stat.reason, count: stat.count, threshold })
      }
    }
  }

  // ============ 进度批量写入 ============

  _ensureProgressFlushTimer() {
    if (this._progressFlushTimer) return
    this._progressFlushTimer = setInterval(() => {
      this._flushPendingProgress()
    }, this._progressFlushInterval)
    if (this._progressFlushTimer.unref) this._progressFlushTimer.unref()
  }

  _stopProgressFlushTimer() {
    if (this._progressFlushTimer) {
      clearInterval(this._progressFlushTimer)
      this._progressFlushTimer = null
    }
  }

  /**
   * 记录进度到 pending map，不立即写库
   * 注意：不再存储 payload 字段，避免 flush 时污染原始 payload 列（Bug 14）
   * latestPayload 参数保留以维持调用方签名不变，但不再写入 DB
   * @param {string} id 任务ID
   * @param {*} progressData 进度数据
   * @param {*} latestPayload 最新 payload（仅内存使用，不落库）
   */
  _enqueueProgress(id, progressData, latestPayload) {
    const now = Date.now()
    this._pendingProgress.set(id, {
      progress: JSON.stringify(progressData),
      progress_current: progressData?.current ?? 0,
      progress_total: progressData?.total ?? 0,
      last_progress_at: now
    })
    this._ensureProgressFlushTimer()
  }

  /**
   * 批量 flush 所有 pending 进度到 DB
   * 仅更新 progress/progress_current/progress_total/last_progress_at/updated_at，
   * 绝不写 payload 列（Bug 14）。
   * 逐条 try-catch，写入失败的条目保留在 _pendingProgress 中下次重试（Bug 15）。
   */
  _flushPendingProgress() {
    if (this._pendingProgress.size === 0) {
      this._stopProgressFlushTimer()
      return
    }
    const entries = Array.from(this._pendingProgress.entries())
    let stmt
    try {
      stmt = this.db.prepare(`UPDATE job_queue SET
        progress = ?, progress_current = ?, progress_total = ?,
        last_progress_at = ?, updated_at = ?
        WHERE id = ?`)
    } catch (e) {
      logger.warn('[JobQueue] 进度 flush 预编译失败，全部保留待重试:', e.message)
      return
    }
    for (const [id, data] of entries) {
      try {
        stmt.run(data.progress, data.progress_current, data.progress_total,
          data.last_progress_at, Date.now(), id)
        // 写入成功，从 pending 中删除
        this._pendingProgress.delete(id)
      } catch (e) {
        // 写入失败，保留以便下次 flush 重试，整体不抛错
        logger.warn(`[JobQueue] 进度 flush 写入失败 ${id.substring(0, 8)}，保留待重试:`, e.message)
      }
    }
  }

  /**
   * 立即 flush 指定任务的进度（任务结束时调用，确保最终状态落库）
   * 仅更新 progress 相关列，不写 payload 列（Bug 14）。
   * 写入失败时保留在 _pendingProgress 中，由下次 _flushPendingProgress 重试（Bug 15）。
   * @param {string} id 任务ID
   */
  _flushProgressNow(id) {
    const data = this._pendingProgress.get(id)
    if (!data) return
    try {
      this.db.prepare(`UPDATE job_queue SET
        progress = ?, progress_current = ?, progress_total = ?,
        last_progress_at = ?, updated_at = ?
        WHERE id = ?`).run(
        data.progress, data.progress_current, data.progress_total,
        data.last_progress_at, Date.now(), id
      )
      // 写入成功，从 pending 中删除
      this._pendingProgress.delete(id)
    } catch (e) {
      // 写入失败保留待重试，避免数据丢失
      logger.warn(`[JobQueue] 进度立即写入失败 ${id.substring(0, 8)}，保留待重试:`, e.message)
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
    logger.info(`[JobQueue] typeConcurrency 已更新:`, this.typeConcurrency)
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

  /**
   * 推断任务来源（manual/auto）
   * 显式 opts.source 优先；否则按 priority 推断（<=2 手动，>2 自动）
   * 推断结果应同时用于 checkRateLimit 和 _insertJob，避免不一致（Bug 16）
   * @param {Object} opts 作业选项
   * @param {number} priority 优先级
   * @returns {string} 'manual' 或 'auto'
   */
  _inferSource(opts, priority) {
    if (opts && opts.source) return opts.source
    return priority <= 2 ? 'manual' : 'auto'
  }

  _insertJob(type, payload, opts = {}) {
    const id = opts.id || uuidv4()
    const now = Date.now()
    const priority = opts.priority ?? 5
    const delay = opts.delay || 0
    const status = delay > 0 ? 'delayed' : 'waiting'
    // 注入 source 标识（manual/auto）到 payload，用于调度决策和日志追踪
    // 统一走 _inferSource，保证 add/checkRateLimit/_insertJob 三处推断一致（Bug 16）
    const source = this._inferSource(opts, priority)
    let finalPayload = payload
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      if (payload._source === undefined) {
        finalPayload = { ...payload, _source: source }
      }
    } else {
      finalPayload = { value: payload, _source: source }
    }
    let payloadStr = '{}'
    try {
      payloadStr = JSON.stringify(finalPayload)
    } catch (e) {
      logger.warn(`[JobQueue] 任务 ${type} payload 序列化失败，降级为空对象:`, e.message)
    }
    this.db.prepare(`INSERT OR IGNORE INTO job_queue
      (id, type, priority, status, payload, max_retries, timeout, delay, repeat_interval, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, type, priority, status, payloadStr,
        opts.maxRetries ?? 3, opts.timeout ?? null, delay || null,
        opts.repeat ?? null, now, now)
    return { id, priority }
  }

  add(type, payload, opts = {}) {
    // 先确定 priority 并统一推断 source，确保 checkRateLimit 与 _insertJob 用同一个值（Bug 16）
    const priority = opts.priority ?? 5
    const source = this._inferSource(opts, priority)

    if (this._singletonTypes.has(type)) {
      const existing = this.db.prepare(
        `SELECT id, priority, status FROM job_queue WHERE type = ? AND status IN ('waiting', 'running', 'active', 'paused', 'delayed') LIMIT 1`
      ).get(type)
      if (existing) {
        // 单例抢占默认 priority 与 _insertJob 对齐为 5（Bug 18）
        const newPriority = opts.priority ?? 5
        if (newPriority >= existing.priority) {
          logger.info(`[JobQueue] 单例类型 ${type} 已有 priority=${existing.priority} 任务 ${existing.id.substring(0, 8)}，跳过重复入队（新 priority=${newPriority}）`)
          return existing.id
        }
        logger.info(`[JobQueue] 单例抢占: ${type} priority=${newPriority} 替换现有 priority=${existing.priority} 任务 ${existing.id.substring(0, 8)}`)
        this.cancel(existing.id)
      }
    }

    if (opts.checkRateLimit !== false && !this.checkRateLimit(type, source)) {
      logger.info(`[JobQueue] 任务 ${type} (${source}) 被速率限制，跳过入队`)
      return null
    }

    // 把推断出的 source 显式传入 opts，确保 _insertJob 不会再做不一致的推断
    const inserted = this._insertJob(type, payload, { ...opts, source })
    const id = inserted.id

    this._waitingDirty = true
    // 手动任务(priority<=2)入队时主动抢占：
    // 1) 总并发已满 → 抢占任意低优任务
    // 2) 同类型 typeConcurrency 已满 → 抢占同类型低优任务
    //    （解决"自动 downloadComic 占满 3 个槽位导致手动 downloadComic 卡死"问题）
    if (priority <= 2) {
      if (this._active.size >= this.concurrency) {
        this._preemptFor(priority, type)
      }
      const typeMax = this.typeConcurrency[type]
      if (typeMax !== undefined && typeMax > 0) {
        let activeCount = 0
        for (const entry of this._active.values()) {
          if (entry.job.type === type) activeCount++
        }
        if (activeCount >= typeMax) {
          this._tryPreemptForTypeSlot(type, priority)
        }
      }
    }
    this._scheduleTick()
    this._emit('enqueued', { jobId: id, type })
    return id
  }

  /**
   * 同类型槽位抢占: 当 typeConcurrency 已满但有更高优任务等待时，
   * 找到 active 中同类型且 priority 严格大于新任务的最低优先级任务并抢占。
   * 只抢占 priority >= 2 的任务（保护已运行的 manual 任务）。
   * @param {string} type 任务类型
   * @param {number} newPriority 新任务优先级
   * @returns {boolean} 是否抢占成功
   */
  _tryPreemptForTypeSlot(type, newPriority) {
    let targetEntry = null
    let targetId = null
    let targetPriority = -1
    for (const [id, entry] of this._active) {
      if (entry.job.type !== type) continue
      if (entry.job.priority <= newPriority) continue
      if (entry.job.priority < 3) continue  // 保护已运行的手动任务(p<3)
      if (entry.job.priority > targetPriority) {
        targetPriority = entry.job.priority
        targetEntry = entry
        targetId = id
      }
    }
    if (!targetEntry) return false
    const src = targetEntry.job.payload?._source || 'auto'
    logger.info(`[JobQueue] 类型槽位抢占: 暂停 ${type}(${src}/p=${targetPriority}) 为新任务(p=${newPriority}) 让位`)
    targetEntry.controller.cancelled = true
    targetEntry.controller._cancelled = true
    targetEntry.controller._preempted = true
    this._active.delete(targetId)
    this._preemptReset(targetId)
    return true
  }

  addBatch(type, payloads, opts = {}) {
    const ids = []
    if (!payloads || payloads.length === 0) return ids

    // 单例类型检查：同类型只入一个（与 add 行为对齐，Bug 17）
    if (this._singletonTypes.has(type)) {
      const existing = this.db.prepare(
        `SELECT id, priority FROM job_queue WHERE type = ? AND status IN ('waiting', 'running', 'active', 'paused', 'delayed') LIMIT 1`
      ).get(type)
      if (existing) {
        const newPriority = opts.priority ?? 5
        if (newPriority >= existing.priority) {
          logger.info(`[JobQueue] 单例类型 ${type} 已有 priority=${existing.priority} 任务 ${existing.id.substring(0, 8)}，addBatch 跳过批量入队（新 priority=${newPriority}）`)
          return [existing.id]
        }
        logger.info(`[JobQueue] 单例抢占(addBatch): ${type} priority=${newPriority} 替换现有 priority=${existing.priority} 任务 ${existing.id.substring(0, 8)}`)
        this.cancel(existing.id)
        // 单例抢占后只入队第一个 payload，避免破坏单例语义
        payloads = [payloads[0]]
      }
    }

    // 统一推断 source，确保 checkRateLimit 与 _insertJob 一致（Bug 16/17）
    const priority = opts.priority ?? 5
    const source = this._inferSource(opts, priority)
    const finalOpts = { ...opts, source }

    // 批量大小限制：仅 windowMs === 0 时按 maxCount 截断
    const limit = this.rateLimits[type]
    let maxBatch = payloads.length
    if (limit && limit.maxCount > 0 && limit.windowMs === 0) {
      maxBatch = Math.min(maxBatch, limit.maxCount)
    }

    for (let i = 0; i < maxBatch; i++) {
      // 逐条检查速率限制（与 add 行为对齐，Bug 17）
      if (opts.checkRateLimit !== false && !this.checkRateLimit(type, source)) {
        logger.info(`[JobQueue] addBatch ${type} (${source}) 第 ${i} 个被速率限制，跳过`)
        continue
      }
      // 复用 _insertJob：自动注入 _source 到 payload，保证 source 推断一致（Bug 17）
      const inserted = this._insertJob(type, payloads[i], finalOpts)
      ids.push(inserted.id)
    }

    if (payloads.length > maxBatch) {
      logger.info(`[JobQueue] ${type} 批量入队超过限制 ${maxBatch}，已截断（原 ${payloads.length}）`)
    }
    // 补上 _waitingDirty 标记，与 add 行为对齐（Bug 17）
    if (ids.length > 0) {
      this._waitingDirty = true
      this._scheduleTick()
      this._emit('enqueued', { jobIds: ids, type, count: ids.length })
    }
    return ids
  }

  findByType(type) {
    const row = this.db.prepare(
      `SELECT ${JOB_COLUMNS} FROM job_queue
       WHERE type = ? AND status IN ('waiting', 'running', 'active', 'paused', 'delayed')
       ORDER BY priority ASC, created_at ASC LIMIT 1`
    ).get(type)
    return this._rowToJob(row)
  }

  findActiveByType(type) {
    let active = null
    this._active.forEach((entry) => {
      if (entry.job.type === type) active = entry.job
    })
    if (active) return active
    const row = this.db.prepare(
      `SELECT ${JOB_COLUMNS} FROM job_queue
       WHERE type = ? AND status IN ('running', 'active')
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
      active.controller._cancelled = true
      active.controller._paused = true
      this._active.delete(jobId)
      this._emit('paused', { jobId })
      logger.info(`[JobQueue] 暂停活跃任务 ${jobId.substring(0, 8)}`)
    } else {
      const result = this._updateStatus(jobId, 'paused', {}, 'AND status = \'waiting\'')
      if (result.changes > 0) this._emit('paused', { jobId })
    }
  }

  resumeJob(jobId) {
    const row = this.db.prepare(`SELECT type FROM job_queue WHERE id = ? AND status = 'paused'`).get(jobId)
    if (!row) {
      logger.warn(`[JobQueue] resumeJob 失败: ${jobId} 不存在或非 paused 状态`)
      return
    }
    if (this._singletonTypes.has(row.type)) {
      const existing = this.db.prepare(
        `SELECT id FROM job_queue WHERE type = ? AND status IN ('waiting', 'running', 'active', 'delayed') LIMIT 1`
      ).get(row.type)
      if (existing) {
        logger.warn(`[JobQueue] resumeJob 拒绝: 单例类型 ${row.type} 已有活跃任务 ${existing.id.substring(0, 8)}`)
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
      logger.info(`[JobQueue] 取消活跃任务 ${jobId.substring(0, 8)}`)
      this._waitingDirty = true
      this._scheduleTick()
    }
    this._emit('cancelled', { jobId })
  }

  retry(jobId) {
    this.db.prepare(`UPDATE job_queue SET status = 'waiting', retry_count = 0, error = NULL, updated_at = ?
      WHERE id = ? AND (status = 'failed' OR status = 'cancelled')`).run(Date.now(), jobId)
    this._waitingDirty = true
    this._scheduleTick()
    this._emit('retried', { jobId })
  }

  retryAll() {
    this.db.prepare(`UPDATE job_queue SET status = 'waiting', retry_count = 0, error = NULL, updated_at = ?
      WHERE (status = 'failed' OR status = 'cancelled')`).run(Date.now())
    this._waitingDirty = true
    this._scheduleTick()
    this._emit('retriedAll', {})
  }

  clear() {
    this.db.prepare(`DELETE FROM job_queue WHERE status IN ('completed', 'cancelled')`).run()
    this._emit('cleared', {})
  }

  deleteJob(jobId) {
    const active = this._active.get(jobId)
    if (active) {
      active.controller.cancelled = true
      active.controller._cancelled = true
      this._active.delete(jobId)
    }
    try {
      this.db.prepare(`DELETE FROM job_queue WHERE id = ?`).run(jobId)
    } catch (e) {
      logger.warn(`[JobQueue] 删除任务 ${jobId} 失败: ${e.message}`)
    }
    this._waitingDirty = true
    this._emit('removed', { jobId })
    this._scheduleTick()
  }

  deleteJobsByType(types) {
    const typeList = Array.isArray(types) ? types : [types]
    let removedCount = 0
    for (const type of typeList) {
      for (const [id, entry] of this._active) {
        if (entry.job.type === type) {
          entry.controller.cancelled = true
          entry.controller._cancelled = true
          this._active.delete(id)
        }
      }
      const info = this.db.prepare(`SELECT COUNT(*) as c FROM job_queue WHERE type = ?`).get(type)
      removedCount += info?.c || 0
    }
    const placeholders = typeList.map(() => '?').join(',')
    this.db.prepare(`DELETE FROM job_queue WHERE type IN (${placeholders})`).run(...typeList)
    this._waitingDirty = true
    this._emit('cleared', { types: typeList, removedCount })
    this._scheduleTick()
    return removedCount
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
      // 排序: 先把真正在跑的(active/running)和 paused 排在最前,
      // 避免它们因 created_at 早而排到末尾被 LIMIT 截掉(导致前端“进行中 0”)。
      return this._queryJobs(
        `status IN (${STATUS_ACTIVE_QUERY.map(() => '?').join(',')})`,
        STATUS_ACTIVE_QUERY,
        `CASE status WHEN 'running' THEN 0 WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END ASC, priority ASC, created_at ASC`,
        limit
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
      this._waitingDirty = true
    } catch (e) {
      logger.warn('[JobQueue] 抢占复位失败:', e.message)
    }
  }

  _preemptFor(newPriority, type) {
    // 优先处理互斥组冲突：如果新任务属于互斥组，直接抢占组内冲突任务
    if (type) {
      const conflict = this._getMutexConflictingTask(type)
      if (conflict && conflict.entry.job.priority > newPriority) {
        const victimSrc = conflict.entry.job.payload?._source || 'auto'
        logger.info(`[JobQueue] 抢占(互斥): 暂停 ${conflict.entry.job.type}(${victimSrc}/p=${conflict.entry.job.priority}) 为 ${type}(p=${newPriority}) 腾出位置`)
        conflict.entry.controller.cancelled = true
        conflict.entry.controller._cancelled = true
        conflict.entry.controller._preempted = true
        this._active.delete(conflict.id)
        this._preemptReset(conflict.id)
        return
      }
    }
    // 否则抢占最低优先级的自动任务（priority >= 3）
    let lowestEntry = null
    let lowestPriority = -1
    for (const [id, entry] of this._active) {
      if (entry.job.priority > lowestPriority && entry.job.priority >= 3) {
        lowestPriority = entry.job.priority
        lowestEntry = entry
      }
    }
    if (lowestEntry) {
      const victimSrc = lowestEntry.job.payload?._source || 'auto'
      logger.info(`[JobQueue] 抢占: 暂停 ${lowestEntry.job.type}(${victimSrc}/p=${lowestPriority}) 任务 ${lowestEntry.job.id.substring(0, 8)}，为 priority=${newPriority} 腾出位置`)
      lowestEntry.controller.cancelled = true
      lowestEntry.controller._cancelled = true
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
    // 1. 自愈: 复位卡死的 active 僵尸任务 (无条件, 不受并发/暂停影响)
    this._scanZombies()

    if (this._paused) return

    // 2. 优先级抢占: active 已满但有手动任务等待时，抢占自动任务腾槽
    if (this._active.size >= this.concurrency) {
      if (!this._tryPriorityPreempt()) return
    }

    // 3. 加载等待队列 (分层查询)
    if (!this._waitingDirty) return
    this._waitingDirty = false

    const waiting = this._fetchWaitingJobs()
    if (waiting.length === 0) return

    // 4. 先检查最高优先级任务是否因互斥组被阻塞
    if (this._tryMutexPreempt(waiting)) return

    // 5. 循环填满并发槽
    this._fillActiveSlots(waiting)
  }

  /**
   * 僵尸任务扫描: 复位长时间无进度的 active/running 任务
   */
  _scanZombies() {
    const now = Date.now()
    if (now - this._lastZombieScan < ZOMBIE_SCAN_COOLDOWN) return
    this._lastZombieScan = now
    try {
      const STALL_MS = 8 * 60 * 1000
      const zombies = this.db.prepare(
        `SELECT id FROM job_queue WHERE status IN ('active', 'running')
         AND (last_progress_at IS NULL OR last_progress_at < ?)`
      ).all(now - STALL_MS)
      for (const z of zombies) {
        if (this._active.has(z.id)) continue
        if (this._running.has(z.id)) continue
        this._updateStatus(z.id, 'waiting', { error: '自愈: 复位卡死的 active 僵尸任务' })
        logger.info(`[JobQueue] 自愈: 复位卡死任务 ${z.id.substring(0, 8)} (active -> waiting)`)
      }
    } catch (e) {
      logger.warn('[JobQueue] 自愈扫描失败:', e.message)
    }
  }

  /**
   * 尝试优先级抢占: 有手动任务等待时，暂停最低优的自动任务腾槽
   * @returns {boolean} 是否成功抢占
   */
  _tryPriorityPreempt() {
    const waiting = this.db.prepare(
      `SELECT id, type, priority FROM job_queue WHERE status = 'waiting'
      ORDER BY priority ASC, created_at ASC LIMIT 10`
    ).all()
    const manualWaiting = waiting.filter(j => j.priority <= 2)
    if (manualWaiting.length === 0) return false

    // 找可抢占的最低优自动任务 (priority >= 3)
    let lowestEntry = null
    let lowestPriority = -1
    let lowestId = null
    for (const [id, entry] of this._active) {
      if (entry.job.priority > lowestPriority && entry.job.priority >= 3) {
        lowestPriority = entry.job.priority
        lowestEntry = entry
        lowestId = id
      }
    }
    if (!lowestEntry) return false

    const victimSrc = lowestEntry.job.payload?._source || 'auto'
    logger.info(`[JobQueue] 优先级抢占: 暂停 ${lowestEntry.job.type}(${victimSrc}/p=${lowestPriority}) 为手动任务腾槽`)
    lowestEntry.controller.cancelled = true
    lowestEntry.controller._cancelled = true
    lowestEntry.controller._preempted = true
    this._active.delete(lowestId)
    this._preemptReset(lowestId)
    this._scheduleTick()
    return true
  }

  /**
   * 分层加载等待队列: 先查手动任务，不够再查自动任务
   * @returns {Array} 等待任务列表
   */
  _fetchWaitingJobs() {
    const manualLimit = this.concurrency * 3
    const manual = this.db.prepare(
      `SELECT id, type, priority, payload, max_retries, retry_count, timeout, created_at
       FROM job_queue WHERE status = 'waiting' AND priority <= 2
       ORDER BY priority ASC, created_at ASC LIMIT ?`
    ).all(manualLimit)

    if (manual.length >= this.concurrency) return manual

    const autoLimit = Math.max(this.concurrency * 2, 30)
    const auto = this.db.prepare(
      `SELECT id, type, priority, payload, max_retries, retry_count, timeout, created_at
       FROM job_queue WHERE status = 'waiting' AND priority > 2
       ORDER BY priority ASC, created_at ASC LIMIT ?`
    ).all(autoLimit)
    return manual.concat(auto)
  }

  /**
   * 填满并发槽: 从 waiting 中依次启动任务直到填满 concurrency
   * @param {Array} waiting 等待任务列表
   */
  _fillActiveSlots(waiting) {
    const activeTypeCounts = {}
    for (const entry of this._active.values()) {
      const t = entry.job.type
      activeTypeCounts[t] = (activeTypeCounts[t] || 0) + 1
    }
    let cursor = 0
    while (this._active.size < this.concurrency) {
      let found = false
      for (let i = cursor; i < waiting.length; i++) {
        const r = waiting[i]
        if (this._active.has(r.id)) continue
        if (this._running.has(r.id)) continue
        if (!this._canStart(r.type)) continue
        const typeMax = this.typeConcurrency[r.type]
        if (typeMax !== undefined && typeMax > 0) {
          if ((activeTypeCounts[r.type] || 0) >= typeMax) {
            // typeConcurrency 已满: 手动任务尝试抢占同类型自动任务
            if (r.priority <= 2 && this._tryPreemptForTypeSlot(r.type, r.priority)) {
              activeTypeCounts[r.type] = Math.max(0, (activeTypeCounts[r.type] || 0) - 1)
            } else {
              continue
            }
          }
        } else {
          if (activeTypeCounts[r.type] && r.priority > 1) continue
        }
        activeTypeCounts[r.type] = (activeTypeCounts[r.type] || 0) + 1
        this._executeJob(r)
        cursor = i + 1
        found = true
        break
      }
      if (!found) break
    }
  }

  /**
   * 尝试互斥组抢占: 最高优先级任务因互斥组被阻塞时，抢占组内低优任务
   * 返回值必须明确：抢占成功返回 truthy（{ id, entry }），无抢占返回 null（Bug 20）
   * 否则 _tick 中的 `if (this._tryMutexPreempt(waiting)) return` 会变成死代码
   * @param {Array} waiting 等待任务列表
   * @returns {{id: string, entry: Object} | null}
   */
  _tryMutexPreempt(waiting) {
    if (waiting.length === 0) return null
    const top = waiting[0]
    // 没有互斥冲突，不需要抢占，返回 null 让 _tick 继续 _fillActiveSlots
    if (this._canStart(top.type)) return null

    const conflict = this._getMutexConflictingTask(top.type)
    if (conflict && conflict.entry.job.priority > top.priority) {
      const victimSrc = conflict.entry.job.payload?._source || 'auto'
      // waiting 行的 payload 是字符串，需要 parse 才能取 _source
      let topSrc = top.priority <= 2 ? 'manual' : 'auto'
      try {
        if (top.payload) {
          const p = JSON.parse(top.payload)
          if (p && p._source) topSrc = p._source
        }
      } catch (_) {}
      logger.info(`[JobQueue] 互斥抢占: 暂停 ${conflict.entry.job.type}(${victimSrc}/p=${conflict.entry.job.priority}) 为 ${top.type}(${topSrc}/p=${top.priority}) 腾出位置`)
      conflict.entry.controller.cancelled = true
      conflict.entry.controller._cancelled = true
      conflict.entry.controller._preempted = true
      this._active.delete(conflict.id)
      this._preemptReset(conflict.id)
      this._scheduleTick()
      // 抢占成功，返回 truthy 值，让 _tick 跳过本次 _fillActiveSlots（避免竞态）
      return { id: conflict.id, entry: conflict.entry }
    }
    // 存在互斥冲突但不满足抢占条件（冲突任务优先级更高），返回 null
    return null
  }

  async _executeJob(row) {
    const { id, type, priority, payload: payloadStr, max_retries: maxRetries, retry_count: retryCount, timeout } = row
    let payload
    try {
      payload = JSON.parse(payloadStr)
    } catch (e) {
      logger.warn(`[JobQueue] 任务 ${id.substring(0, 8)} (${type}) payload 解析失败，标记为 failed`)
      this._updateStatus(id, 'failed', { error: `payload 损坏: ${e.message}` })
      this._scheduleTick()
      return
    }
    const handler = this.handlers.get(type)
    if (!handler) {
      this._updateStatus(id, 'failed', { error: `未知作业类型: ${type}` })
      this._scheduleTick()
      return
    }

    if (this._running.has(id)) {
      logger.info(`[JobQueue] 任务 ${id.substring(0, 8)} (${type}) 的旧 handler 仍在运行，跳过重新执行`)
      this._scheduleTick()
      return
    }

    if (this._singletonTypes.has(type)) {
      let hasActiveSibling = false
      this._active.forEach((entry, entryId) => {
        if (entryId !== id && entry.job.type === type) hasActiveSibling = true
      })
      if (hasActiveSibling) {
        logger.info(`[JobQueue] 单例类型 ${type} 已有其他任务运行中，跳过执行 ${id.substring(0, 8)}`)
        this._updateStatus(id, 'waiting')
        this._scheduleTick()
        return
      }
    }

    this._running.add(id)
    const now = Date.now()
    this._updateStatus(id, 'active', { started_at: now, last_progress_at: now })

    const controller = { cancelled: false }
    this._active.set(id, { job: { id, type, priority, payload }, controller })

    // 调度延迟埋点：waiting → active 的等待时间
    const waitMs = now - (row.created_at || now)
    if (waitMs > 1000) {
      const source = payload._source || (priority <= 2 ? 'manual' : 'auto')
      logger.info(`[JobQueue] 任务 ${id.substring(0, 8)} (${type}/${source}) 调度延迟 ${(waitMs / 1000).toFixed(1)}s, priority=${priority}`)
    }

    let latestPayload = payload
    const onProgress = (data) => {
      if (data && typeof data === 'object') {
        latestPayload = { ...latestPayload, ...(data.payload || {}) }
        if (data.page !== undefined) latestPayload.page = data.page
      }
      // 写入 pending map，由共享定时器批量 flush 到 DB
      this._enqueueProgress(id, data, latestPayload)
      this._emit('progress', { jobId: id, type, ...data })
    }

    const typeOverrides = {
      crawlAll: 30 * 60 * 1000
    }
    const jobTimeout = typeOverrides[type] || timeout || this._defaultTimeout

    const handlerPromise = handler({ id, type, priority, payload, cancelled: () => controller.cancelled }, onProgress)
    handlerPromise.finally(() => {
      this._running.delete(id)
    })

    try {
      const result = await this._runWithTimeout(
        handlerPromise,
        jobTimeout,
        controller,
        id, type
      )

      // 任务结束前立即 flush 进度，确保最终状态落库
      this._flushProgressNow(id)

      this._finalizeJob(id, type, controller, result, retryCount, maxRetries, Date.now())
    } catch (e) {
      this._flushProgressNow(id)
      this._handleJobError(id, type, controller, e, retryCount, maxRetries)
    } finally {
      this._active.delete(id)
      this._waitingDirty = true
      setImmediate(() => this._scheduleTick())
    }
  }

  async _runWithTimeout(promise, timeoutMs, controller, jobId, type) {
    if (!timeoutMs || timeoutMs <= 0) return promise
    let timedOut = false
    let timer = null
    const timerPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        if (controller) {
          controller.cancelled = true
          controller._cancelled = true
        }
        reject(new Error(`任务超时 (${timeoutMs / 1000}s)`))
      }, timeoutMs)
    })
    try {
      return await Promise.race([promise, timerPromise])
    } catch (e) {
      if (timedOut && controller) {
        controller.cancelled = true
        controller._cancelled = true
      }
      if (e.message && e.message.includes('任务超时')) {
        logger.warn(`[JobQueue] 任务 ${jobId.substring(0, 8)} (${type}) 超时 (${timeoutMs / 1000}s)`)
      }
      throw e
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  _finalizeJob(id, type, controller, result, retryCount, maxRetries, now) {
    const cancelled = controller._cancelled || controller.cancelled
    const paused = controller._paused
    const preempted = controller._preempted

    if (paused) {
      logger.info(`[JobQueue] 任务 ${id} (${type}) 已被外部暂停，状态保持 paused`)
    } else if (preempted) {
      this._updateStatus(id, 'waiting')
      this._emit('paused', { jobId: id, type, reason: 'preempted' })
      logger.info(`[JobQueue] 任务 ${id} (${type}) 被抢占，已回到等待队列`)
    } else if (cancelled) {
      logger.info(`[JobQueue] 任务 ${id} (${type}) 已被取消或超时，状态保持 cancelled`)
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
    controller.cancelled = true
    controller._cancelled = true
    let error = ''
    try {
      if (e instanceof Error) {
        error = e.message || e.name || String(e)
      } else if (typeof e === 'string') {
        error = e
      } else if (e && typeof e === 'object') {
        // 常见 Node.js 系统错误对象 (如 ECONNRESET, ENOENT) 有 code 字段
        const parts = []
        if (e.code) parts.push(String(e.code))
        if (e.message) parts.push(String(e.message))
        if (e.errno) parts.push('errno=' + e.errno)
        if (e.syscall) parts.push('syscall=' + e.syscall)
        if (parts.length === 0) {
          try { parts.push(JSON.stringify(e).substring(0, 200)) } catch (_) { parts.push(String(e)) }
        }
        error = parts.join(' ')
      } else {
        error = String(e) || '未知异常'
      }
    } catch (_) {
      error = '未知异常 (序列化失败)'
    }
    if (!error || error.trim().length === 0) {
      error = '未知错误 (空错误信息)'
    }
    const now = Date.now()
    const errorType = this._classifyError(error)
    this._recordFailureStats(errorType)

    const newRetryCount = retryCount + 1
    if (newRetryCount < maxRetries) {
      this._updateStatus(id, 'waiting', { retry_count: newRetryCount, error })
      this._waitingDirty = true
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
      `SELECT id FROM job_queue WHERE type = ? AND status IN ('waiting', 'running', 'active', 'paused', 'delayed') LIMIT 1`
    ).get(type)
    if (existing) {
      logger.info(`[JobQueue] 重复任务 ${type} 已有活跃实例，跳过`)
      return
    }

    this._insertJob(type, job.payload, {
      priority: this._singletonTypes.has(type) ? 6 : 5,
      delay: job.repeatInterval,
      repeat: job.repeatInterval,
      maxRetries: 3
    })
    logger.info(`[JobQueue] 重复任务 ${type} 已安排，${job.repeatInterval / 1000}s 后执行`)
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
      logger.info(`[JobQueue] ${type} 自动重试已达上限 (${autoRetryCount}/${maxAutoRetries})，放弃`)
      return
    }

    const newAutoRetryCount = autoRetryCount + 1
    const backoff = config.backoff || 2
    const baseDelay = config.delay || 30 * 60 * 1000
    const delay = Math.round(baseDelay * Math.pow(backoff, autoRetryCount))

    this.db.prepare(
      `UPDATE job_queue SET auto_retry_count = ?, retry_count = 0, error = NULL, updated_at = ? WHERE id = ?`
    ).run(newAutoRetryCount, Date.now(), id)

    logger.info(`[JobQueue] ${type} 自动重试 #${newAutoRetryCount}/${maxAutoRetries}，${Math.round(delay / 60000)} 分钟后执行`)
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
      logger.info(`[JobQueue] 自动重试失败任务 ${r.id.substring(0, 8)} (${r.type}) #${newAutoRetryCount}/${maxAutoRetries}`)
      this.db.prepare(
        `UPDATE job_queue SET status = 'waiting', retry_count = 0, error = NULL, auto_retry_count = ?, updated_at = ? WHERE id = ?`
      ).run(newAutoRetryCount, now, r.id)
      this._emit('autoRetried', { jobId: r.id, type: r.type })
      retried++
    }

    if (retried > 0) {
      logger.info(`[JobQueue] 自动重试了 ${retried} 个失败任务`)
      this._scheduleTick()
    }
  }

  /**
   * waiting 任务老化：等待时间越长，优先级越高（priority 数值越小）
   * 防止低优先级任务被无限期抢占导致饥饿
   * 每等待 AGING_INTERVAL 时间，priority 减 1（优先级提升 1 级）
   * 最高提升到 AGING_MIN_PRIORITY（不超过手动任务的优先级边界）
   */
  _ageWaitingJobs() {
    if (!AGING_ENABLED) return
    const now = Date.now()
    if (now - this._lastAging < AGING_INTERVAL) return
    this._lastAging = now

    try {
      // 找出等待超过 AGING_INTERVAL 且还有提升空间的任务
      // 第一次老化用 created_at 作为基准，之后用 last_aged_at
      const result = this.db.prepare(`
        UPDATE job_queue
        SET priority = priority - 1,
            last_aged_at = ?,
            updated_at = ?
        WHERE status = 'waiting'
          AND priority > ?
          AND COALESCE(last_aged_at, created_at) <= ?
      `).run(now, now, AGING_MIN_PRIORITY, now - AGING_INTERVAL)

      if (result.changes > 0) {
        logger.info(`[JobQueue] 老化提升: ${result.changes} 个等待任务优先级 +1 级 (最高升至 p=${AGING_MIN_PRIORITY})`)
        this._waitingDirty = true
        this._scheduleTick()
      }
    } catch (e) {
      logger.warn('[JobQueue] 任务老化失败:', e.message)
    }
  }

  // ============ 定期维护 ============

  _startMaintenance() {
    this._maintenanceTimer = setInterval(() => {
      this._activateDelayedJobs()
      this._cleanupExpiredJobs()
      this._detectStalledJobs()
      this._retryFailedJobs()
      this._ageWaitingJobs()
    }, MAINTENANCE_INTERVAL)
    this._maintenanceTimer.unref()
  }

  // ============ 动态并发 ============

  _startDynamicConcurrency() {
    if (!DYNAMIC_CONCURRENCY_ENABLED) return
    this._lastCpuSample = this._getCpuUsage()
    this._dynamicConcurrencyTimer = setInterval(() => {
      this._adjustConcurrency()
    }, DYNAMIC_CONCURRENCY_INTERVAL)
    if (this._dynamicConcurrencyTimer.unref) this._dynamicConcurrencyTimer.unref()
  }

  _stopDynamicConcurrency() {
    if (this._dynamicConcurrencyTimer) {
      clearInterval(this._dynamicConcurrencyTimer)
      this._dynamicConcurrencyTimer = null
    }
  }

  destroy() {
    this._stopHeartbeat()
    this._stopDynamicConcurrency()
    if (this._maintenanceTimer) { clearInterval(this._maintenanceTimer); this._maintenanceTimer = null }
    if (this._progressFlushTimer) { clearInterval(this._progressFlushTimer); this._progressFlushTimer = null }
  }

  /**
   * 获取当前 CPU 使用率（通过两次采样计算）
   * @returns {{idle: number, total: number}}
   */
  _getCpuUsage() {
    const cpus = os.cpus()
    let idle = 0
    let total = 0
    for (const cpu of cpus) {
      for (const type of Object.keys(cpu.times)) {
        total += cpu.times[type]
      }
      idle += cpu.times.idle
    }
    return { idle, total }
  }

  /**
   * 根据 CPU 和内存负载调整并发数
   */
  _adjustConcurrency() {
    try {
      const currentSample = this._getCpuUsage()
      const prevSample = this._lastCpuSample
      this._lastCpuSample = currentSample

      if (!prevSample) return

      const idleDiff = currentSample.idle - prevSample.idle
      const totalDiff = currentSample.total - prevSample.total
      const cpuUsage = totalDiff > 0 ? 1 - (idleDiff / totalDiff) : 0

      const freeMem = os.freemem()
      const oldConcurrency = this.concurrency

      if (cpuUsage >= DYNAMIC_CPU_HIGH || freeMem < DYNAMIC_MEM_LOW) {
        // 高负载: 降低并发
        const newConcurrency = Math.max(DYNAMIC_CONCURRENCY_MIN, oldConcurrency - 1)
        if (newConcurrency !== oldConcurrency) {
          this.concurrency = newConcurrency
          // 方案A（低风险）：降低并发仅影响新调度，运行中任务自然完成，不主动 pauseJob（Bug 19）
          // 这与 BullMQ/Celery 等主流任务队列的行为一致，避免打断正在进行的下载
          logger.info(`[JobQueue] 动态并发: 高负载降低 ${oldConcurrency} → ${newConcurrency} (CPU=${(cpuUsage * 100).toFixed(0)}%, 内存=${(freeMem / 1024 / 1024).toFixed(0)}MB) — 仅限制新调度，运行中任务自然完成`)
        }
      } else if (cpuUsage < DYNAMIC_CPU_LOW && freeMem >= DYNAMIC_MEM_HIGH) {
        // 低负载: 提升并发
        const newConcurrency = Math.min(DYNAMIC_CONCURRENCY_MAX, oldConcurrency + 1)
        if (newConcurrency !== oldConcurrency) {
          this.concurrency = newConcurrency
          logger.info(`[JobQueue] 动态并发: 低负载提升 ${oldConcurrency} → ${newConcurrency} (CPU=${(cpuUsage * 100).toFixed(0)}%, 内存=${(freeMem / 1024 / 1024).toFixed(0)}MB)`)
          this._waitingDirty = true
          this._scheduleTick()
        }
      }
    } catch (e) {
      logger.warn('[JobQueue] 动态并发调整失败:', e.message)
    }
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
        logger.info(`[JobQueue] 激活 ${rows.length} 个延迟任务`)
        this._scheduleTick()
      }
    } catch (e) {
      logger.warn('[JobQueue] 激活延迟任务失败:', e.message)
    }
  }

  _cleanupExpiredJobs() {
    if (this._jobRetentionMs <= 0) return
    const now = Date.now()
    if (now - this._lastCleanup < CLEANUP_INTERVAL) return
    this._lastCleanup = now
    const cutoff = now - this._jobRetentionMs
    try {
      const result = this.db.prepare(
        `DELETE FROM job_queue WHERE status IN ('completed', 'failed', 'cancelled') AND completed_at IS NOT NULL AND completed_at < ?`
      ).run(cutoff)
      if (result.changes > 0) {
        logger.info(`[JobQueue] 清理 ${result.changes} 个过期记录（> ${Math.round(this._jobRetentionMs / 86400000)} 天）`)
      }
    } catch (e) {
      logger.warn('[JobQueue] 清理过期记录失败:', e.message)
    }
  }

  _detectStalledJobs() {
    const cutoff = Date.now() - STALL_TIMEOUT
    try {
      const stalled = this.db.prepare(
        `SELECT id, type FROM job_queue
         WHERE status IN ('active', 'running') AND (last_progress_at IS NULL OR last_progress_at < ?)`
      ).all(cutoff)
      for (const job of stalled) {
        const active = this._active.get(job.id)
        if (active) {
          logger.warn(`[JobQueue] 检测到停滞任务 ${job.id.substring(0, 8)} (${job.type})，强制取消`)
          active.controller.cancelled = true
          active.controller._cancelled = true
          this._active.delete(job.id)
        }
        this._updateStatus(job.id, 'failed', { error: '任务停滞：超过 10 分钟无进度' })
        this._emit('failed', { jobId: job.id, type: job.type, error: '任务停滞', errorType: 'stalled' })
      }
      if (stalled.length > 0) {
        this._scheduleTick()
      }
    } catch (e) {
      logger.warn('[JobQueue] 停滞检测失败:', e.message)
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
    this._stopDynamicConcurrency()
    this._stopProgressFlushTimer()
    this._pendingProgress.clear()
    this._active.clear()
    this._running.clear()
    this.listeners.clear()
  }
}

module.exports = JobQueue