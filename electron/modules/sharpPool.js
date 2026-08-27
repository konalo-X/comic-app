'use strict'
// sharp worker 线程池 — 管理 N 个 worker，分配图片处理任务，避免阻塞主线程
const { Worker } = require('worker_threads')
const path = require('path')
const crypto = require('crypto')

const WORKER_PATH = path.join(__dirname, 'sharpWorker.js')

/**
 * sharp worker 线程池
 * 通过 worker_threads 隔离图片处理，防止 libuv 线程池被占满导致 UI 卡顿
 */
class SharpPool {
  /**
   * @param {number} [size=2] - worker 数量
   */
  constructor(size = 2) {
    this.size = size
    /** @type {Array<{worker: Worker, busy: boolean}>} */
    this.workers = []
    /** @type {Array<{resolve: Function, reject: Function}>} */
    this._pending = []
    this._initialized = false
    this._terminated = false
  }

  /**
   * 初始化 worker 池（延迟初始化，等 sharp 模块就绪）
   */
  _init() {
    if (this._initialized) return
    this._initialized = true
    for (let i = 0; i < this.size; i++) {
      const worker = new Worker(WORKER_PATH)
      const entry = { worker, busy: false }
      worker.on('message', (msg) => this._onMessage(entry, msg))
      worker.on('error', (err) => this._onError(entry, err))
      this.workers.push(entry)
    }
    console.log(`[SharpPool] 已启动 ${this.size} 个 worker 线程`)
  }

  /**
   * 分配任务给空闲 worker
   * @param {string} type - 任务类型
   * @param {Object} payload - 任务数据
   * @returns {Promise<*>}
   */
  _dispatch(type, payload) {
    if (this._terminated) return Promise.reject(new Error('SharpPool 已关闭'))
    this._init()

    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID()
      const task = { id, type, payload, resolve, reject }

      // 查找空闲 worker
      const idle = this.workers.find(w => !w.busy)
      if (idle) {
        // 立即分配：task 不入 _pending 队列，避免被其他 worker 重复拾取
        // （_assign 会将 task 引用存到 entry._currentTask，_onMessage 据此回溯）
        this._assign(idle, task)
      } else {
        // 无空闲 worker 时入队等待，_pending 只包含「真正排队、未分配」的任务
        this._pending.push(task)
      }
    })
  }

  /**
   * 分配任务给指定 worker
   * @param {{worker: Worker, busy: boolean}} entry
   * @param {{id: string, type: string, payload: Object, resolve: Function, reject: Function}} task
   */
  _assign(entry, task) {
    entry.busy = true
    entry._currentId = task.id
    // 保存 task 引用：_onMessage/_onError 据此 resolve/reject，不再依赖 _pending 查找
    entry._currentTask = task

    // buffer 类型的 payload 使用可转移对象零拷贝传递
    const transferList = []
    const msg = { id: task.id, type: task.type, ...task.payload }
    if (msg.buffer instanceof ArrayBuffer) {
      transferList.push(msg.buffer)
    }
    entry.worker.postMessage(msg, transferList)
  }

  /**
   * 分配 _pending 队列中积压的任务给空闲 worker
   * 用于 worker 空闲或重启后触发，保证 pending 任务被及时拾取
   */
  _dispatchPending() {
    while (this._pending.length > 0) {
      const idle = this.workers.find(w => !w.busy)
      if (!idle) break
      // shift 出队列后再 _assign 标记 busy，保证原子性：同一任务不会被多 worker 拾取
      const task = this._pending.shift()
      this._assign(idle, task)
    }
  }

  /**
   * worker 返回消息处理
   */
  _onMessage(entry, msg) {
    entry.busy = false
    entry._currentId = null
    // 通过 entry._currentTask 拿到任务，避免遍历 _pending（_pending 只含排队任务）
    const task = entry._currentTask
    entry._currentTask = null

    if (!task) return

    if (msg.success) {
      task.resolve(msg)
    } else {
      task.reject(new Error(msg.error || 'sharp 处理失败'))
    }

    // 分配下一个排队任务：shift 出队列后再 _assign，避免重复分配
    if (this._pending.length > 0) {
      const next = this._pending.shift()
      this._assign(entry, next)
    }
  }

  /**
   * worker 错误处理（崩溃时重启）
   * 改为 async：worker.terminate() 是异步的，必须 await 确保旧 worker 真正终止后再创建新 worker，
   * 否则后续代码可能在旧 worker 未终止时访问其状态
   */
  async _onError(entry, err) {
    console.error(`[SharpPool] worker 错误:`, err.message)
    entry.busy = false

    // 失败当前正在执行的任务（通过 entry._currentTask，不依赖 _pending 查找）
    if (entry._currentTask) {
      entry._currentTask.reject(err)
      entry._currentTask = null
    }
    entry._currentId = null

    // 重启 worker：先 await terminate 旧 worker，确保资源释放
    try { await entry.worker.terminate() } catch (_) {}
    if (this._terminated) return

    entry.worker = new Worker(WORKER_PATH)
    entry.worker.on('message', (m) => this._onMessage(entry, m))
    entry.worker.on('error', (e) => this._onError(entry, e))
    console.log('[SharpPool] worker 已重启')

    // 新 worker 启动后立即拾取 pending 队列中积压的任务，避免任务永久 pending
    this._dispatchPending()
  }

  // ============ 公共 API ============

  /**
   * 将 buffer 转为 webp 写入文件
   * @param {Buffer} buffer - 图片 buffer
   * @param {string} outPath - 输出文件路径
   * @param {{quality?: number}} [options] - webp 选项
   * @returns {Promise<void>}
   */
  webpConvert(buffer, outPath, options = {}) {
    const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    return this._dispatch('webpConvert', { buffer: ab, outPath, options }).then(() => {})
  }

  /**
   * 将 buffer 转为 webp buffer
   * @param {Buffer} buffer - 图片 buffer
   * @param {{quality?: number}} [options] - webp 选项
   * @returns {Promise<Buffer>}
   */
  webpConvertToBuffer(buffer, options = {}) {
    const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    return this._dispatch('webpConvertToBuffer', { buffer: ab, options }).then(r => Buffer.from(r.buffer))
  }

  /**
   * 读取图片 metadata（用于验证图片是否损坏）
   * @param {string} filePath - 图片文件路径
   * @returns {Promise<{width: number, height: number, format: string}>}
   */
  metadata(filePath) {
    return this._dispatch('metadata', { filePath }).then(r => r.metadata)
  }

  /**
   * resize + webp 转 buffer（用于 exporter）
   * @param {Buffer} buffer - 图片 buffer
   * @param {{maxWidth?: number, quality?: number}} [options] - 选项
   * @returns {Promise<Buffer>}
   */
  resizeWebpToBuffer(buffer, options = {}) {
    const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    return this._dispatch('resizeWebpToBuffer', { buffer: ab, options }).then(r => Buffer.from(r.buffer))
  }

  /**
   * 关闭所有 worker（优雅退出）
   * 关闭前 reject 所有未完成任务（排队 + 正在执行），避免上游 Promise 永远 pending 导致内存泄漏
   */
  async terminate() {
    this._terminated = true

    const err = new Error('SharpPool terminated')

    // reject 所有排队中的任务
    while (this._pending.length > 0) {
      const task = this._pending.shift()
      task.reject(err)
    }

    // reject 所有正在执行的任务（worker.terminate 后不会再回消息，否则 Promise 永远 pending）
    for (const entry of this.workers) {
      if (entry._currentTask) {
        entry._currentTask.reject(err)
        entry._currentTask = null
      }
    }

    await Promise.all(this.workers.map(w => {
      try { return w.worker.terminate() } catch (_) { return Promise.resolve() }
    }))
    this.workers = []
    console.log('[SharpPool] 所有 worker 已关闭')
  }
}

// 单例（2 个 worker 平衡性能与内存）
const pool = new SharpPool(2)

module.exports = pool
