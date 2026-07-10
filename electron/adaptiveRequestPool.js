'use strict'

/**
 * 自适应请求池 - 根据成功率和响应时间动态调整并发数
 * 
 * 特性：
 *   - 根据最近的成功率调整并发数
 *   - 根据平均响应时间调整并发数
 *   - 自动降级和恢
 *   - 支持最小和最大并发数限制
 */
class AdaptiveRequestPool {
  constructor(options = {}) {
    this.minConcurrency = options.minConcurrency || 3
    this.maxConcurrency = options.maxConcurrency || 20
    this.currentConcurrency = options.initialConcurrency || this.minConcurrency
    
    this.running = 0
    this.queue = []
    
    // 统计信息
    this.successCount = 0
    this.failCount = 0
    this.responseTimes = []
    
    // 调整策略
    this.adjustInterval = options.adjustInterval || 10000  // 每10秒调整一次
    this.successRateThresholdHigh = options.successRateThresholdHigh || 0.9  // 成功率高于90%增加并发
    this.successRateThresholdLow = options.successRateThresholdLow || 0.7   // 成功率低于70%降低并发
    this.responseTimeThresholdFast = options.responseTimeThresholdFast || 2000  // 响应时间低于2秒增加并发
    this.responseTimeThresholdSlow = options.responseTimeThresholdSlow || 5000  // 响应时间高于5秒降低并发
    
    // 启动定期调整
    this._startPeriodicAdjustment()
  }
  
  /**
   * 添加请求任务
   */
  async add(fn, label = '') {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject, label })
      this._drain()
    })
  }
  
  /**
   * 处理队列
   */
  async _drain() {
    if (this.running >= this.currentConcurrency) return
    if (this.queue.length === 0) return
    
    this.running++
    const item = this.queue.shift()
    const startTime = Date.now()
    
    try {
      const result = await item.fn()
      const responseTime = Date.now() - startTime
      
      // 记录成功和响应时间
      this.successCount++
      this.responseTimes.push(responseTime)
      if (this.responseTimes.length > 100) {
        this.responseTimes.shift()  // 只保留最近100个响应时间
      }
      
      item.resolve(result)
    } catch (e) {
      // 记录失败
      this.failCount++
      item.reject(e)
    } finally {
      this.running--
      this._drain()
    }
  }
  
  /**
   * 启动定期调整并发数
   */
  _startPeriodicAdjustment() {
    setInterval(() => {
      this._adjustConcurrency()
    }, this.adjustInterval)
  }
  
  /**
   * 调整并发数
   */
  _adjustConcurrency() {
    const total = this.successCount + this.failCount
    if (total < 10) return  // 样本太少，不调整
    
    const successRate = this.successCount / total
    const avgResponseTime = this.responseTimes.reduce((a, b) => a + b, 0) / this.responseTimes.length
    
    let action = 'keep'
    let oldConcurrency = this.currentConcurrency
    
    // 根据成功率调整
    if (successRate > this.successRateThresholdHigh && avgResponseTime < this.responseTimeThresholdFast) {
      // 成功率高且响应快，增加并发
      this.currentConcurrency = Math.min(this.currentConcurrency + 1, this.maxConcurrency)
      action = 'increase'
    } else if (successRate < this.successRateThresholdLow || avgResponseTime > this.responseTimeThresholdSlow) {
      // 成功率低或响应慢，降低并发
      this.currentConcurrency = Math.max(this.currentConcurrency - 1, this.minConcurrency)
      action = 'decrease'
    }
    
    // 重置统计
    if (total > 100) {
      this.successCount = 0
      this.failCount = 0
      this.responseTimes = []
    }
    
    if (action !== 'keep') {
      console.log(`[AdaptivePool] 并发数调整：${oldConcurrency} → ${this.currentConcurrency} (成功率=${(successRate*100).toFixed(1)}%, 响应时间=${Math.round(avgResponseTime)}ms)`)
    }
  }
  
  /**
   * 等待所有任务完成
   */
  async waitIdle() {
    while (this.running > 0 || this.queue.length > 0) {
      await new Promise(r => setTimeout(r, 100))
    }
  }
  
  /**
   * 获取当前状态
   */
  getStatus() {
    const total = this.successCount + this.failCount
    const successRate = total > 0 ? (this.successCount / total * 100).toFixed(2) : 0
    const avgResponseTime = this.responseTimes.length > 0 
      ? Math.round(this.responseTimes.reduce((a, b) => a + b, 0) / this.responseTimes.length)
      : 0
    
    return {
      currentConcurrency: this.currentConcurrency,
      minConcurrency: this.minConcurrency,
      maxConcurrency: this.maxConcurrency,
      running: this.running,
      queueLength: this.queue.length,
      successRate: `${successRate}%`,
      avgResponseTime: `${avgResponseTime}ms`,
      totalRequests: total
    }
  }
}

module.exports = AdaptiveRequestPool
