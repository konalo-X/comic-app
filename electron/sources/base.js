'use strict'

/**
 * 漫画源基类 — 所有源站插件必须实现这些接口
 */
class ComicSource {
  constructor() {
    if (new.target === ComicSource) {
      throw new Error('ComicSource 是抽象类，不能直接实例化')
    }
  }

  /** 唯一 ID（英文） */
  get id() { throw new Error('未实现: id') }
  /** 显示名称 */
  get name() { throw new Error('未实现: name') }
  /** 语言代码 */
  get lang() { return 'zh' }

  /**
   * 搜索漫画
   * @param {string} query 关键词
   * @param {number} page 页码（1-based）
   * @returns {Promise<Array<{title, cover, sourceUrl, author?, status?, category?, updateTime?}>>}
   */
  async search(query, page) { throw new Error('未实现: search') }

  /**
   * 热门 / 全部列表
   * @param {number} page
   * @returns {Promise<Array>} 同上
   */
  async getPopular(page) { throw new Error('未实现: getPopular') }

  /**
   * 最新更新
   * @param {number} page
   * @returns {Promise<Array>} 同上
   */
  async getLatest(page) { throw new Error('未实现: getLatest') }

  /**
   * 漫画详情
   * @param {string} url
   * @returns {Promise<{title, cover, author, status, desc, tags: string[], category?, chapters: Array<{name, url}>}>}
   */
  async getDetail(url) { throw new Error('未实现: getDetail') }

  /**
   * 章节图片列表
   * @param {string} chapterUrl
   * @param {string} referer
   * @returns {Promise<string[]|{images: string[], chapterName: string}>} 图片 URL 数组，或包含章节名的对象
   */
  async getPageList(chapterUrl, referer) { throw new Error('未实现: getPageList') }

  /**
   * 下载单张图片
   * @param {string} imageUrl
   * @param {string} referer
   * @returns {Promise<Buffer>} 图片二进制
   */
  async fetchImage(imageUrl, referer) { throw new Error('未实现: fetchImage') }

  /**
   * 获取"下一页"的 URL（分页爬取用）
   * @param {string} currentPageUrl
   * @param {string} currentPageHtml
   * @returns {string|null}
   */
  getNextPageUrl(currentPageUrl, currentPageHtml) { return null }
}

module.exports = ComicSource