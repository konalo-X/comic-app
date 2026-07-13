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
      this._pending.push(task)

      // 查找空闲 worker
      const idle = this.workers.find(w => !w.busy)
      if (idle) {
        this._assign(idle, id, type, payload)
      }
      // 无空闲 worker 时，任务排队等待 worker 空闲后分配
    })
  }

  /**
   * 分配任务给指定 worker
   */
  _assign(entry, id, type, payload) {
    entry.busy = true
    entry._currentId = id

    // buffer 类型的 payload 使用可转移对象零拷贝传递
    const transferList = []
    const msg = { id, type, ...payload }
    if (msg.buffer instanceof ArrayBuffer) {
      transferList.push(msg.buffer)
    }
    entry.worker.postMessage(msg, transferList)
  }

  /**
   * worker 返回消息处理
   */
  _onMessage(entry, msg) {
    entry.busy = false
    entry._currentId = null

    const idx = this._pending.findIndex(p => p.id === msg.id)
    if (idx === -1) return
    const task = this._pending.splice(idx, 1)[0]

    if (msg.success) {
      task.resolve(msg)
    } else {
      task.reject(new Error(msg.error || 'sharp 处理失败'))
    }

    // 分配下一个排队任务
    if (this._pending.length > 0) {
      const next = this._pending[0]
      this._assign(entry, next.id, next.type, next.payload)
    }
  }

  /**
   * worker 错误处理（崩溃时重启）
   */
  _onError(entry, err) {
    console.error(`[SharpPool] worker 错误:`, err.message)
    entry.busy = false

    // 失败当前任务
    if (entry._currentId) {
      const idx = this._pending.findIndex(p => p.id === entry._currentId)
      if (idx !== -1) {
        const task = this._pending.splice(idx, 1)[0]
        task.reject(err)
      }
      entry._currentId = null
    }

    // 重启 worker
    try { entry.worker.terminate() } catch (_) {}
    if (!this._terminated) {
      entry.worker = new Worker(WORKER_PATH)
      entry.worker.on('message', (msg) => this._onMessage(entry, msg))
      entry.worker.on('error', (e) => this._onError(entry, e))
      console.log('[SharpPool] worker 已重启')
    }
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
   */
  async terminate() {
    this._terminated = true
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
