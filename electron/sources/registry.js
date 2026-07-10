'use strict'
const Smtt6Source = require('./smtt6')

/** 源站注册中心 */
class SourceRegistry {
  constructor() {
    this._sources = new Map()
    this._register(new Smtt6Source())
    // 后续新源在这里加：
    // this._register(new ManhuaguiSource())
    // this._register(new MangaDexSource())
  }

  _register(source) {
    if (this._sources.has(source.id)) {
      console.warn(`[SourceRegistry] 源 ${source.id} 已存在，跳过`)
      return
    }
    this._sources.set(source.id, source)
    console.log(`[SourceRegistry] 注册源: ${source.name} (${source.id})`)
  }

  /** 获取所有源 */
  getAll() {
    return Array.from(this._sources.values())
  }

  /** 获取指定源 */
  get(id) {
    const s = this._sources.get(id)
    if (!s) throw new Error(`未知源: ${id}`)
    return s
  }

  /** 默认源 */
  get default() {
    return this._sources.get('smtt6')
  }

  /**
   * 跨源搜索：所有源同时搜，返回合并结果
   * @param {string} query
   * @param {number} page
   * @returns {Promise<Array>}
   */
  async multiSearch(query, page = 1) {
    const promises = []
    for (const source of this._sources.values()) {
      promises.push(
        source.search(query, page).then(items =>
          items.map(item => ({ ...item, _source: source.id }))
        ).catch(e => {
          console.warn(`[SourceRegistry] ${source.name} 搜索失败:`, e.message)
          return []
        })
      )
    }
    const results = await Promise.allSettled(promises)
    const merged = []
    for (const r of results) {
      if (r.status === 'fulfilled') merged.push(...r.value)
    }
    return merged
  }
}

module.exports = new SourceRegistry()
