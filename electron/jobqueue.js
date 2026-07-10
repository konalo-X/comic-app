'use strict'
const crypto = require('crypto')
function uuidv4() { return crypto.randomUUID() }

/**
 * 持久化作业队列 — 支持优先级、暂停恢复、重试、进度事件
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
    // 每种任务类型的最大并发数（undefined 表示不单独限制）
    this.typeConcurrency = options.typeConcurrency || {}
    this.handlers = new Map()     // type -> handler function
    this.listeners = new Map()    // event type -> Set<callback>
    this._mutexGroups = new Map() // mutexGroup -> Set<jobType>

    // 运行时状态（不持久化）
    this._active = new Map()      // jobId -> { job, controller }
    this._paused = false
    this._tickScheduled = false

    // 速率限制配置 { jobType: { maxCount, windowMs } }
    this.rateLimits = options.rateLimits || {}
    // 最近一次入队时间，用于滑动窗口限速
    this._rateLimitTimestamps = new Map() // type -> [timestamp, ...]

    // 初始化表
    this._initTable()

    // 恢复未完成的作业
    this._recover()
  }

  /**
   * 检查是否超过速率限制
   * @returns {boolean} true 表示可以入队，false 表示被限速
   */
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

  /**
   * 恢复应用重启前未完成的任务
   * 将 active 状态的任务重置为 waiting（可能是崩溃导致）
   */
  _recover() {
    const now = Date.now()
    const activeJobs = this.db.prepare(
      `SELECT id, type, retry_count FROM job_queue WHERE status='active'`
    ).all()
    if (activeJobs.length > 0) {
      this.db.prepare(
        `UPDATE job_queue SET status='waiting', retry_count=retry_count+1, updated_at=? WHERE status='active'`
      ).run(now)
      console.log(`[JobQueue] 恢复 ${activeJobs.length} 个中断任务`)
    }
    const pausedJobs = this.db.prepare(
      `SELECT id, type FROM job_queue WHERE status='paused'`
    ).all()
    if (pausedJobs.length > 0) {
      this.db.prepare(
        `UPDATE job_queue SET status='waiting', updated_at=? WHERE status='paused'`
      ).run(now)
      console.log(`[JobQueue] 恢复 ${pausedJobs.length} 个暂停任务`)
    }
  }

  /**
   * 注册互斥组：同组内的任务同一时间只允许运行一个
   * @param {string} group 互斥组名
   * @param {string[]} types 属于该组的任务类型列表
   */
  registerMutexGroup(group, types) {
    this._mutexGroups.set(group, new Set(types))
  }

  /**
   * 检查某个任务类型是否可以启动（互斥组内没有正在运行的同类任务）
   */
  _canStart(type) {
    for (const [group, types] of this._mutexGroups) {
      if (!types.has(type)) continue
      for (const [id, entry] of this._active) {
        if (types.has(entry.job.type)) return false
      }
    }
    return true
  }

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
      created_at INTEGER,
      updated_at INTEGER,
      started_at INTEGER,
      completed_at INTEGER
    )`)
    db.exec('CREATE INDEX IF NOT EXISTS idx_job_status ON job_queue(status)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_job_type ON job_queue(type)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_job_priority ON job_queue(priority, created_at)')
    
    // 失败统计表
    db.exec(`CREATE TABLE IF NOT EXISTS job_failure_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reason TEXT UNIQUE,
      count INTEGER DEFAULT 0,
      last_update INTEGER
    )`)
  }

  // ============ 错误分类和统计 ============

  /**
   * 错误分类
   */
  _classifyError(errorMsg) {
    if (!errorMsg) return 'unknown'
    
    const msg = errorMsg.toLowerCase()
    
    if (msg.includes('timeout') || msg.includes('econnreset') || msg.includes('522')) {
      return 'temporary_network'
    }
    if (msg.includes('503') || msg.includes('502') || msg.includes('504')) {
      return 'temporary_server'
    }
    if (msg.includes('429') || msg.includes('too many requests')) {
      return 'rate_limit'
    }
    if (msg.includes('404') || msg.includes('410')) {
      return 'permanent_not_found'
    }
    if (msg.includes('403') || msg.includes('401')) {
      return 'permanent_forbidden'
    }
    if (msg.includes('parse') || msg.includes('undefined')) {
      return 'parse_error'
    }
    
    return 'unknown'
  }
  
  /**
   * 记录失败统计
   */
  _recordFailureStats(errorType) {
    try {
      const row = this.db.prepare('SELECT count FROM job_failure_stats WHERE reason = ?').get(errorType)
      const count = row ? row.count : 0
      this.db.prepare('INSERT OR REPLACE INTO job_failure_stats (reason, count, last_update) VALUES (?, ?, ?)')
        .run(errorType, count + 1, Date.now())
      this._checkFailureAlerts(errorType)
    } catch (e) {
      console.error('[JobQueue] 记录失败统计失败:', e.message)
    }
  }
  
  /**
   * 获取失败统计报告
   */
  getFailureStats() {
    const rows = this.db.prepare('SELECT reason, count, last_update FROM job_failure_stats ORDER BY count DESC').all()
    return rows.map(row => ({
      reason: row.reason,
      count: row.count,
      lastUpdate: row.last_update
    }))
  }

  /**
   * 检查失败统计并发出告警
   */
  _checkFailureAlerts(errorType) {
    const stats = this.getFailureStats()
    const alertThresholds = {
      rate_limit: 10,
      permanent_forbidden: 5,
      temporary_network: 20,
      temporary_server: 15,
      parse_error: 10
    }
    
    for (const stat of stats) {
      const threshold = alertThresholds[stat.reason] || 100
      if (stat.count >= threshold) {
        console.warn(`[JobQueue] [告警] ${stat.reason} 失败次数达到 ${stat.count} 次，超过阈值 ${threshold}`)
        this._emit('alert', { type: 'failure_threshold', reason: stat.reason, count: stat.count, threshold })
      }
    }
  }

  // ============ 注册处理器 ============

  /** @param {string} type @param {function(job, onProgress): Promise<any>} handler */
  register(type, handler) {
    if (this.handlers.has(type)) throw new Error(`处理器已注册: ${type}`)
    this.handlers.set(type, handler)
  }

  // ============ 运行时配置更新 ============

  /**
   * 动态更新 typeConcurrency 配置（无需重启队列）
   * @param {object} concurrencyMap { taskType: maxConcurrency }
   */
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

  /**
   * 添加作业
   * @param {string} type 作业类型
   * @param {object} payload 参数
   * @param {object} opts { priority, maxRetries, id }
   * @returns {string} jobId
   */
  add(type, payload, opts = {}) {
    // 应用速率限制（可选）
    if (opts.checkRateLimit !== false && !this.checkRateLimit(type)) {
      console.log(`[JobQueue] 任务 ${type} 被速率限制，跳过入队`)
      return null
    }
    const id = opts.id || uuidv4()
    const now = Date.now()
    const priority = opts.priority ?? 2
    this.db.prepare(`INSERT OR IGNORE INTO job_queue
      (id, type, priority, status, payload, max_retries, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, type, priority, 'waiting',
       JSON.stringify(payload), opts.maxRetries ?? 3, now, now)

    // 高优先级任务（用户手动操作）触发抢占
    if (priority <= 1 && this._active.size >= this.concurrency) {
      this._preemptFor(priority)
    }
    this._scheduleTick()
    return id
  }

  /**
   * 添加一批相同类型的作业
   * @param {string} type
   * @param {Array<object>} payloads
   * @param {object} opts
   * @returns {string[]} jobIds
   */
  addBatch(type, payloads, opts = {}) {
    const ids = []
    const now = Date.now()
    const stmt = this.db.prepare(`INSERT OR IGNORE INTO job_queue
      (id, type, priority, status, payload, max_retries, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?)`)
    // 应用批量大小限制
    const limit = this.rateLimits[type]
    let maxBatch = payloads.length
    if (limit && limit.maxCount > 0 && limit.windowMs === 0) {
      maxBatch = Math.min(maxBatch, limit.maxCount)
    }
    for (let i = 0; i < maxBatch; i++) {
      const payload = payloads[i]
      const id = uuidv4()
      stmt.run(id, type, opts.priority ?? 2, 'waiting',
        JSON.stringify(payload), opts.maxRetries ?? 3, now, now)
      ids.push(id)
    }
    if (payloads.length > maxBatch) {
      console.log(`[JobQueue] ${type} 批量入队超过限制 ${maxBatch}，已截断（原 ${payloads.length}）`)
    }
    this._scheduleTick()
    return ids
  }

  /**
   * 查找指定类型的作业（运行中或等待中），用于互斥判断
   * @param {string} type
   * @returns {object|null} 第一个匹配的作业，或 null
   */
  findByType(type) {
    const row = this.db.prepare(
      `SELECT id, type, status, priority, payload, progress, created_at, updated_at
       FROM job_queue WHERE type=? AND status IN ('waiting','running')
       ORDER BY priority ASC, created_at ASC LIMIT 1`
    ).get(type)
    if (!row) return null
    return {
      id: row.id, type: row.type, status: row.status, priority: row.priority,
      payload: JSON.parse(row.payload),
      progress: row.progress ? JSON.parse(row.progress) : null,
      createdAt: row.created_at, updatedAt: row.updated_at
    }
  }

  // ============ 状态控制 ============

  pause() { this._paused = true }
  resume() { this._paused = false; this._scheduleTick() }

  pauseJob(jobId) {
    const active = this._active.get(jobId)
    if (active) {
      this.db.prepare(`UPDATE job_queue SET status='paused', updated_at=? WHERE id=?`).run(Date.now(), jobId)
      active.controller.cancelled = true
      this._active.delete(jobId)
      this._emit('paused', { jobId })
    } else {
      this.db.prepare(`UPDATE job_queue SET status='paused', updated_at=? WHERE id=? AND status='waiting'`).run(Date.now(), jobId)
    }
  }

  resumeJob(jobId) {
    this.db.prepare(`UPDATE job_queue SET status='waiting', updated_at=? WHERE id=? AND status='paused'`).run(Date.now(), jobId)
    this._scheduleTick()
    this._emit('resumed', { jobId })
  }

  cancel(jobId) {
    this.db.prepare(`UPDATE job_queue SET status='cancelled', updated_at=? WHERE id=?`).run(Date.now(), jobId)
    // 如果正在运行，标记取消
    const active = this._active.get(jobId)
    if (active) active.cancelled = true
  }

  retry(jobId) {
    this.db.prepare(`UPDATE job_queue SET status='waiting', retry_count=0, error=NULL, updated_at=?
      WHERE id=? AND (status='failed' OR status='cancelled')`).run(Date.now(), jobId)
    this._scheduleTick()
  }

  retryAll() {
    this.db.prepare(`UPDATE job_queue SET status='waiting', retry_count=0, error=NULL, updated_at=?
      WHERE (status='failed' OR status='cancelled')`).run(Date.now())
    this._scheduleTick()
  }

  clear() {
    this.db.prepare(`DELETE FROM job_queue WHERE status IN ('completed','failed','cancelled')`).run()
  }

  // ============ 查询 ============

  getStats() {
    const rows = this.db.prepare(`SELECT status, COUNT(*) as c FROM job_queue GROUP BY status`).all()
    const stats = { waiting: 0, active: 0, completed: 0, failed: 0, cancelled: 0, total: 0 }
    for (const row of rows) {
      if (stats[row.status] !== undefined) stats[row.status] = row.c
      stats.total += row.c
    }
    return stats
  }

  listJobs(status = 'all', limit = 50) {
    if (status === 'all') {
      const rows = this.db.prepare(
        `SELECT id, type, priority, status, payload, error, progress, retry_count,
          progress_current, progress_total, created_at, updated_at, started_at
         FROM job_queue ORDER BY priority ASC, created_at DESC LIMIT ?`
      ).all(limit)
      return rows.map(row => ({
        id: row.id, type: row.type, priority: row.priority, status: row.status,
        payload: row.payload ? JSON.parse(row.payload) : null,
        error: row.error, progress: row.progress ? JSON.parse(row.progress) : null,
        retryCount: row.retry_count, progressCurrent: row.progress_current, progressTotal: row.progress_total,
        createdAt: row.created_at, updatedAt: row.updated_at, startedAt: row.started_at
      }))
    } else {
      const rows = this.db.prepare(
        `SELECT id, type, priority, status, payload, error, progress, retry_count,
          progress_current, progress_total, created_at, updated_at, started_at
         FROM job_queue WHERE status=? ORDER BY priority ASC, created_at DESC LIMIT ?`
      ).all(status, limit)
      return rows.map(row => ({
        id: row.id, type: row.type, priority: row.priority, status: row.status,
        payload: row.payload ? JSON.parse(row.payload) : null,
        error: row.error, progress: row.progress ? JSON.parse(row.progress) : null,
        retryCount: row.retry_count, progressCurrent: row.progress_current, progressTotal: row.progress_total,
        createdAt: row.created_at, updatedAt: row.updated_at, startedAt: row.started_at
      }))
    }
  }

  getJob(jobId) {
    const row = this.db.prepare(
      `SELECT id, type, priority, status, payload, error, progress, retry_count,
        progress_current, progress_total, created_at, updated_at, started_at
       FROM job_queue WHERE id=?`
    ).get(jobId)
    if (!row) return null
    return {
      id: row.id, type: row.type, priority: row.priority, status: row.status,
      payload: row.payload ? JSON.parse(row.payload) : null,
      error: row.error, progress: row.progress ? JSON.parse(row.progress) : null,
      retryCount: row.retry_count, progressCurrent: row.progress_current, progressTotal: row.progress_total,
      createdAt: row.created_at, updatedAt: row.updated_at, startedAt: row.started_at
    }
  }

  // ============ 内部调度 ============

  /**
   * 抢占：为高优先级任务腾出并发槽位
   * 找到正在运行的最低优先级（priority >= 2）任务，取消它，让它回到 waiting
   */
  _preemptFor(newPriority) {
    let lowestEntry = null
    let lowestPriority = -1
    for (const [id, entry] of this._active) {
      if (entry.job.priority > lowestPriority && entry.job.priority >= 2) {
        lowestPriority = entry.job.priority
        lowestEntry = entry
      }
    }
    if (lowestEntry) {
      console.log(`[JobQueue] 抢占: 暂停 priority=${lowestPriority} 任务 ${lowestEntry.job.id}，为 priority=${newPriority} 腾出位置`)
      lowestEntry.controller.cancelled = true
      lowestEntry.controller._preempted = true
    }
  }

  _scheduleTick() {
    if (this._tickScheduled) return
    this._tickScheduled = true
    // 异步触发，避免递归
    setImmediate(() => { this._tickScheduled = false; this._tick() })
  }

  async _tick() {
    if (this._paused) return
    if (this._active.size >= this.concurrency) return

    // 取出下一个等待中的作业（跳过互斥组冲突的）
    // paused 状态的任务需要调用 resumeJob 恢复后才能执行
    const waiting = this.db.prepare(
      `SELECT id, type, priority, payload, max_retries, retry_count
       FROM job_queue WHERE status = 'waiting'
       ORDER BY priority ASC, created_at ASC LIMIT 100`
    ).all()

    // 统计各类型的当前并发数
    const activeTypeCounts = {}
    for (const entry of this._active.values()) {
      const t = entry.job.type
      activeTypeCounts[t] = (activeTypeCounts[t] || 0) + 1
    }
    const row = waiting.find(r => {
      if (!this._canStart(r.type)) return false
      // 检查该类型的独立并发上限
      const typeMax = this.typeConcurrency[r.type]
      if (typeMax !== undefined && typeMax > 0) {
        const currentCount = activeTypeCounts[r.type] || 0
        if (currentCount >= typeMax) return false
      } else {
        // 未配置上限：保持旧逻辑，低优先级(priority>1)同类型最多1个
        if (activeTypeCounts[r.type] && r.priority > 1) return false
      }
      return true
    })
    if (!row) return

    const { id, type, priority, payload: payloadStr, max_retries: maxRetries, retry_count: retryCount } = row
    const payload = JSON.parse(payloadStr)
    const handler = this.handlers.get(type)
    if (!handler) {
      this.db.prepare(`UPDATE job_queue SET status='failed', error=?, updated_at=? WHERE id=?`)
        .run(`未知作业类型: ${type}`, Date.now(), id)
      this._scheduleTick()
      return
    }

    // 标记为 active
    this.db.prepare(`UPDATE job_queue SET status='active', started_at=?, updated_at=? WHERE id=?`)
      .run(Date.now(), Date.now(), id)

    let cancelled = false
    const controller = { cancelled: false }
    this._active.set(id, { job: { id, type, priority, payload }, controller })

    try {
      let lastProgressTime = 0
      let pendingProgress = null
      const onProgress = (data) => {
        const now = Date.now()
        pendingProgress = data
        // 节流：每秒最多写1次数据库
        if (now - lastProgressTime >= 1000) {
          lastProgressTime = now
          const d = pendingProgress
          pendingProgress = null
          this.db.prepare(`UPDATE job_queue SET progress=?, progress_current=?, progress_total=?, updated_at=?
            WHERE id=?`)
            .run(JSON.stringify(d), d.current ?? 0, d.total ?? 0, now, id)
        }
        this._emit('progress', { jobId: id, type, ...data })
      }

      const result = await handler({ id, type, priority, payload, cancelled: () => controller.cancelled }, onProgress)

      const now = Date.now()
      if (pendingProgress) {
        const d = pendingProgress
        pendingProgress = null
        this.db.prepare(`UPDATE job_queue SET progress=?, progress_current=?, progress_total=?, updated_at=?
          WHERE id=?`)
          .run(JSON.stringify(d), d.current ?? 0, d.total ?? 0, now, id)
      }

      // 被抢占：回到 waiting 状态，等待后续重新调度
      if (controller._preempted && result && result.cancelled) {
        this.db.prepare(`UPDATE job_queue SET status='waiting', updated_at=? WHERE id=?`)
          .run(now, id)
        this._emit('paused', { jobId: id, type, reason: 'preempted' })
        console.log(`[JobQueue] 任务 ${id} (${type}) 被抢占，已回到等待队列`)
      } else {
        this.db.prepare(`UPDATE job_queue SET status='completed', result=?, completed_at=?, updated_at=?
          WHERE id=?`)
          .run(typeof result === 'string' ? result : JSON.stringify(result), now, now, id)
        this._emit('completed', { jobId: id, type, result })
      }
    } catch (e) {
      const error = e.message || String(e)
      const now = Date.now()
      if (pendingProgress) {
        const d = pendingProgress
        pendingProgress = null
        this.db.prepare(`UPDATE job_queue SET progress=?, progress_current=?, progress_total=?, updated_at=?
          WHERE id=?`)
          .run(JSON.stringify(d), d.current ?? 0, d.total ?? 0, now, id)
      }
      const newRetryCount = retryCount + 1
      
      // 分类错误并记录统计
      const errorType = this._classifyError(error)
      this._recordFailureStats(errorType)
      
      if (newRetryCount < maxRetries) {
        // 重试
        this.db.prepare(`UPDATE job_queue SET status='waiting', retry_count=?, error=?, updated_at=? WHERE id=?`)
          .run(newRetryCount, error, now, id)
        this._emit('retrying', { jobId: id, type, error, retry: newRetryCount, maxRetries })
      } else {
        this.db.prepare(`UPDATE job_queue SET status='failed', error=?, retry_count=?, updated_at=? WHERE id=?`)
          .run(error, newRetryCount, now, id)
        this._emit('failed', { jobId: id, type, error, errorType })
      }
    } finally {
      this._active.delete(id)
      // 调度下一个，添加短暂间隔避免任务连续爆发
      const nextDelay = this._active.size > 0 ? 300 : 0
      setTimeout(() => this._scheduleTick(), nextDelay)
    }
  }
}

module.exports = JobQueue