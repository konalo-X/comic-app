'use strict'

// ============================================================
// 全局配置常量
// 所有硬编码的超时、延迟、重试参数统一管理
// 可通过环境变量 COMIC_ 前缀覆盖
// ============================================================

const env = (key, fallback) => {
  const val = process.env[`COMIC_${key}`]
  if (val !== undefined && val !== '') {
    const n = Number(val)
    return Number.isNaN(n) ? val : n
  }
  return fallback
}

// ========== JobQueue 默认值 ==========
module.exports = {
  JOB_QUEUE: {
    DEFAULT_TIMEOUT: env('JOB_TIMEOUT', 5 * 60 * 1000), // 5 分钟
    DEFAULT_RETENTION_MS: env('JOB_RETENTION', 7 * 24 * 3600 * 1000), // 7 天
    MAINTENANCE_INTERVAL: env('JOB_MAINTENANCE', 60 * 1000), // 1 分钟
    STALL_TIMEOUT: env('JOB_STALL', 10 * 60 * 1000), // 10 分钟无进度视为 stall
    ZOMBIE_SCAN_COOLDOWN: env('JOB_ZOMBIE_SCAN', 30 * 1000), // 僵尸扫描冷却 30s
    CLEANUP_INTERVAL: env('JOB_CLEANUP', 5 * 60 * 1000), // 清理过期记录间隔 5 分钟
    DEFAULT_CONCURRENCY: env('JOB_CONCURRENCY', 5)
  },

  // ========== 类型并发限制 ==========
  TYPE_CONCURRENCY: {
    downloadChapter: env('TYPE_DL_CHAPTER', 3),
    downloadComic: 3,
    sync: 1,
    crawlAll: 1,
    autoEnrich: 1,
    enrichChapters: 1,
    repairComic: 1
  },

  // ========== 自动重试配置 ==========
  AUTO_RETRY: {
    downloadChapter: { delay: env('RETRY_DL_DELAY', 5 * 60 * 1000), maxAutoRetries: env('RETRY_DL_MAX', 5), backoff: 1.5 },
    downloadComic: { delay: env('RETRY_DC_DELAY', 10 * 60 * 1000), maxAutoRetries: env('RETRY_DC_MAX', 3), backoff: 2 },
    sync: { delay: env('RETRY_SYNC_DELAY', 30 * 60 * 1000), maxAutoRetries: env('RETRY_SYNC_MAX', 3), backoff: 2 },
    crawlAll: { delay: env('RETRY_CRAWL_DELAY', 5 * 60 * 1000), maxAutoRetries: env('RETRY_CRAWL_MAX', 3), backoff: 2 },
    autoEnrich: { delay: env('RETRY_ENRICH_DELAY', 30 * 60 * 1000), maxAutoRetries: env('RETRY_ENRICH_MAX', 3), backoff: 2 },
    repairComic: { delay: env('RETRY_REPAIR_DELAY', 60 * 60 * 1000), maxAutoRetries: env('RETRY_REPAIR_MAX', 2), backoff: 2 },
    enrichChapters: { delay: env('RETRY_EC_DELAY', 30 * 60 * 1000), maxAutoRetries: env('RETRY_EC_MAX', 3), backoff: 2 }
  },

  // ========== 速率限制 ==========
  RATE_LIMITS: {
    crawlAll: { maxCount: 1, windowMs: env('RATE_CRAWL', 15 * 60 * 1000) },
    sync: { maxCount: 1, windowMs: env('RATE_SYNC', 10 * 60 * 1000) }
  },

  // ========== 爬取配置 ==========
  CRAWL: {
    MAX_EMPTY_PAGES: env('CRAWL_MAX_EMPTY', 3),
    MAX_RETRY_PER_PAGE: env('CRAWL_RETRY_PAGE', 5),
    MAX_TOTAL_PAGES: env('CRAWL_MAX_PAGES', 200),
    PAGE_DELAY_MIN: env('CRAWL_DELAY_MIN', 3000),
    PAGE_DELAY_MAX: env('CRAWL_DELAY_MAX', 6000),
    PAGE_TIMEOUT: env('CRAWL_PAGE_TIMEOUT', 150 * 1000),
    CRAWL_TIMEOUT: env('CRAWL_TIMEOUT', 30 * 60 * 1000),
    MAX_FAILED_PAGES: env('CRAWL_MAX_FAIL', 10),
    QUICK_SCAN_LIMIT: env('CRAWL_QUICK_LIMIT', 20),
    MAX_CONSECUTIVE_NO_NEW: env('CRAWL_NO_NEW', 5)
  },

  // ========== 同步配置 ==========
  SYNC: {
    BATCH_SIZE: env('SYNC_BATCH', 50),
    DELAY_BETWEEN_COMICS: env('SYNC_DELAY', 2000),
    DETAIL_TIMEOUT: env('SYNC_DETAIL_TIMEOUT', 150 * 1000),
    SYNC_TIMEOUT: env('SYNC_TIMEOUT', 30 * 60 * 1000)
  },

  // ========== 下载配置 ==========
  DOWNLOAD: {
    DEFAULT_CONCURRENCY: env('DL_CONCURRENCY', 3),
    IMAGE_TIMEOUT: env('DL_IMAGE_TIMEOUT', 60 * 1000),
    RETRY_PER_IMAGE: env('DL_RETRY_IMAGE', 3),
    DELAY_BETWEEN_IMAGES: env('DL_DELAY', 500)
  },

  // ========== 互斥组 ==========
  MUTEX_GROUPS: {
    crawl: ['sync', 'crawlAll', 'repairComic'],
    enrich: ['autoEnrich', 'enrichChapters']
  },

  // ========== 单例类型 ==========
  SINGLETON_TYPES: ['sync', 'crawlAll', 'autoEnrich', 'enrichChapters', 'repairComic']
}