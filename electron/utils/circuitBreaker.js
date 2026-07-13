'use strict'

/**
 * 熔断器（滑动窗口）
 * 当失败率超过阈值时自动熔断，防止持续请求失败的服务器
 */
class SlidingCircuitBreaker {
  constructor(name, options = {}) {
    this.name = name
    this.windowMs = options.windowMs || 5 * 60 * 1000
    this.failThreshold = options.failThreshold || 0.5
    this.minSamples = options.minSamples || 10
    this.retryMs = options.retryMs || 10 * 60 * 1000
    this.retryMsLong = options.retryMsLong || 60 * 60 * 1000

    this.records = []
    this.tripped = false
    this.trippedAt = 0
    this.longTrip = false
  }

  _prune() {
    const cutoff = Date.now() - this.windowMs
    this.records = this.records.filter(r => r.time > cutoff)
  }

  record(ok) {
    this.records.push({ time: Date.now(), ok })
    this._prune()

    if (ok && this.tripped) {
      this._prune()
      const total = this.records.length
      const fails = this.records.filter(r => !r.ok).length
      if (total >= this.minSamples && fails / total < this.failThreshold) {
        this.tripped = false
        this.longTrip = false
        console.log(`[熔断] ${this.name} 已恢复`)
      }
    }
  }

  isOpen() {
    if (!this.tripped) return false
    const waitMs = this.longTrip ? this.retryMsLong : this.retryMs
    if (Date.now() - this.trippedAt > waitMs) {
      this.tripped = false
      this.longTrip = false
      console.log(`[熔断] ${this.name} 尝试恢复`)
      return false
    }
    return true
  }

  _checkTrip() {
    this._prune()
    const total = this.records.length
    if (total < this.minSamples) return
    const fails = this.records.filter(r => !r.ok).length
    if (fails / total >= this.failThreshold) {
      if (this.tripped) {
        this.longTrip = true
      }
      this.tripped = true
      this.trippedAt = Date.now()
      const waitMs = this.longTrip ? this.retryMsLong : this.retryMs
      console.log(`[熔断] ${this.name} 触发！失败率 ${(fails/total*100).toFixed(0)}%，暂停 ${(waitMs/60000).toFixed(0)} 分钟`)
    }
  }

  success() { this.record(true) }
  failure() { this.record(false); this._checkTrip() }
}

module.exports = SlidingCircuitBreaker