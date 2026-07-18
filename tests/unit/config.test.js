import { describe, it, expect } from 'vitest'

const config = require('../../electron/config')

describe('config', () => {
  it('JOB_QUEUE 配置存在', () => {
    expect(config.JOB_QUEUE).toBeDefined()
    expect(config.JOB_QUEUE.DEFAULT_TIMEOUT).toBeGreaterThan(0)
    expect(config.JOB_QUEUE.DEFAULT_CONCURRENCY).toBeGreaterThan(0)
    expect(config.JOB_QUEUE.DEFAULT_RETENTION_MS).toBeGreaterThan(0)
  })

  it('TYPE_CONCURRENCY 配置存在', () => {
    expect(config.TYPE_CONCURRENCY).toBeDefined()
    expect(config.TYPE_CONCURRENCY.downloadChapter).toBeGreaterThan(0)
    expect(config.TYPE_CONCURRENCY.crawlAll).toBe(1)
  })

  it('AUTO_RETRY 配置存在', () => {
    expect(config.AUTO_RETRY).toBeDefined()
    expect(config.AUTO_RETRY.downloadChapter.maxAutoRetries).toBeGreaterThanOrEqual(3)
    expect(config.AUTO_RETRY.crawlAll.maxAutoRetries).toBeGreaterThanOrEqual(2)
  })

  it('CRAWL 配置存在', () => {
    expect(config.CRAWL).toBeDefined()
    expect(config.CRAWL.MAX_EMPTY_PAGES).toBeGreaterThan(0)
    expect(config.CRAWL.MAX_RETRY_PER_PAGE).toBeGreaterThan(0)
  })

  it('MUTEX_GROUPS 配置存在', () => {
    expect(config.MUTEX_GROUPS).toBeDefined()
    expect(Array.isArray(config.MUTEX_GROUPS.crawl)).toBe(true)
    expect(Array.isArray(config.MUTEX_GROUPS.enrich)).toBe(true)
  })

  it('SINGLETON_TYPES 配置存在', () => {
    expect(Array.isArray(config.SINGLETON_TYPES)).toBe(true)
    expect(config.SINGLETON_TYPES.length).toBeGreaterThan(0)
  })
})