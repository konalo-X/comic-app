'use strict'

/**
 * URL去重管理器 - 使用Bloom Filter进行高效去重
 * 支持两种模式：
 *   1. Memory模式：纯内存Bloom Filter（快速，但重启后丢失）
 *   2. Persistent模式：结合数据库，持久化去重记录（慢一些，但不会重复）
 */
const BloomFilter = require('bloomfilter').BloomFilter

class URLDeduplicator {
  constructor(options = {}) {
    this.mode = options.mode || 'memory'  // 'memory' | 'persistent'
    this.size = options.size || 100000  // Bloom Filter大小
    this.hashCount = options.hashCount || 4  // 哈希函数数量
    
    // 初始化Bloom Filter
    this.bloom = new BloomFilter(this.size, this.hashCount)
    
    // 精确去重缓存（可选，用于100%准确性）
    this.exactCache = new Set()
    
    // 统计信息
    this.stats = {
      totalChecked: 0,
      bloomHit: 0,  // Bloom Filter命中（可能误判）
      exactHit: 0,  // 精确命中
      falsePositives: 0  // 误判次数
    }
    
    // 持久化相关
    if (this.mode === 'persistent') {
      this.db = options.db || null
      this._initPersistentTable()
    }
  }
  
  /**
   * 初始化持久化表
   */
  _initPersistentTable() {
    if (!this.db) return
    
    try {
      this.db.run(`CREATE TABLE IF NOT EXISTS url_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT UNIQUE,
        hash TEXT,
        created_at INTEGER
      )`)
      this.db.run('CREATE INDEX IF NOT EXISTS idx_url_cache_url ON url_cache(url)')
      
      // 从数据库加载已有的URL到Bloom Filter
      this._loadFromDatabase()
    } catch (e) {
      console.error('[URLDeduplicator] 初始化持久化表失败:', e.message)
    }
  }
  
  /**
   * 从数据库加载URL到Bloom Filter
   */
  _loadFromDatabase() {
    if (!this.db) return
    
    try {
      const r = this.db.exec('SELECT url FROM url_cache LIMIT 10000')  // 限制加载数量，避免启动过慢
      if (r.length > 0) {
        for (const row of r[0].values) {
          this.bloom.add(row[0])
          this.exactCache.add(row[0])
        }
        console.log(`[URLDeduplicator] 从数据库加载了 ${r[0].values.length} 个URL`)
      }
    } catch (e) {
      console.error('[URLDeduplicator] 加载数据库失败:', e.message)
    }
  }
  
  /**
   * 检查URL是否已经存在
   * @param {string} url - 要检查的URL
   * @returns {boolean} - true表示可能已经存在（Bloom Filter可能误判），false表示一定不存在
   */
  mightContain(url) {
    this.stats.totalChecked++
    
    // 1. 先检查精确缓存（100%准确）
    if (this.exactCache.has(url)) {
      this.stats.exactHit++
      return true
    }
    
    // 2. 再检查Bloom Filter（可能误判）
    if (this.bloom.test(url)) {
      this.stats.bloomHit++
      
      // 如果是Bloom Filter命中，但精确缓存中没有，可能是误判
      // 这里我们保守起见，认为它可能存在
      return true
    }
    
    // 3. Bloom Filter说不存在，那就一定不存在（Bloom Filter不会漏判）
    return false
  }
  
  /**
   * 添加URL到去重管理器
   * @param {string} url - 要添加的URL
   */
  add(url) {
    // 添加到Bloom Filter
    this.bloom.add(url)
    
    // 添加到精确缓存
    this.exactCache.add(url)
    
    // 如果启用了持久化，保存到数据库
    if (this.mode === 'persistent' && this.db) {
      try {
        this.db.run('INSERT OR IGNORE INTO url_cache (url, created_at) VALUES (?, ?)', 
          [url, Date.now()])
      } catch (e) {
        // 忽略重复URL的错误
      }
    }
  }
  
  /**
   * 批量添加URL
   * @param {Array<string>} urls - 要添加的URL数组
   */
  addBatch(urls) {
    for (const url of urls) {
      this.add(url)
    }
  }
  
  /**
   * 清除所有去重记录
   */
  clear() {
    this.bloom = new BloomFilter(this.size, this.hashCount)
    this.exactCache.clear()
    this.stats = {
      totalChecked: 0,
      bloomHit: 0,
      exactHit: 0,
      falsePositives: 0
    }
    
    if (this.mode === 'persistent' && this.db) {
      try {
        this.db.run('DELETE FROM url_cache')
      } catch (e) {
        console.error('[URLDeduplicator] 清除数据库失败:', e.message)
      }
    }
  }
  
  /**
   * 获取统计信息
   * @returns {object} - 统计信息
   */
  getStats() {
    const bloomHitRate = this.stats.totalChecked > 0 
      ? (this.stats.bloomHit / this.stats.totalChecked * 100).toFixed(2) 
      : 0
    
    return {
      mode: this.mode,
      size: this.size,
      hashCount: this.hashCount,
      totalChecked: this.stats.totalChecked,
      bloomHit: this.stats.bloomHit,
      exactHit: this.stats.exactHit,
      bloomHitRate: `${bloomHitRate}%`,
      exactCacheSize: this.exactCache.size,
      estimatedFalsePositiveRate: this._estimateFalsePositiveRate()
    }
  }
  
  /**
   * 估算误判率
   * @returns {string} - 误判率百分比
   */
  _estimateFalsePositiveRate() {
    // Bloom Filter误判率公式： (1 - e^(-hashCount * n / size)) ^ hashCount
    const n = this.exactCache.size
    const k = this.hashCount
    const m = this.size
    
    if (n === 0) return '0%'
    
    const falsePositiveRate = Math.pow(1 - Math.exp(-k * n / m), k)
    return `${(falsePositiveRate * 100).toFixed(2)}%`
  }
}

module.exports = URLDeduplicator
