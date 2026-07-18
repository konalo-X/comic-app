import { describe, it, expect } from 'vitest'

const { sanitizeFilename, normalizeName, normalizeTitle, escapeLike } = require('../../electron/utils')

describe('sanitizeFilename', () => {
  it('移除非法字符', () => {
    expect(sanitizeFilename('hello<world>')).toBe('hello_world_')
    expect(sanitizeFilename('file"name.txt')).toBe('file_name.txt')
    expect(sanitizeFilename('test/path')).toBe('test_path')
  })

  it('替换冒号为全角', () => {
    expect(sanitizeFilename('a:b')).toBe('a：b')
  })

  it('修剪首尾空格', () => {
    expect(sanitizeFilename('  hello  ')).toBe('hello')
  })

  it('空字符串抛出异常', () => {
    expect(() => sanitizeFilename('')).toThrow('必须是非空字符串')
    expect(() => sanitizeFilename(null)).toThrow('必须是非空字符串')
  })

  it('清理后不为空则正常返回', () => {
    expect(sanitizeFilename('<>')).toBe('__')
  })
})

describe('normalizeName', () => {
  it('转小写', () => {
    expect(normalizeName('Hello')).toBe('hello')
  })

  it('移除特殊字符', () => {
    expect(normalizeName('Hello World!')).toBe('helloworld')
  })

  it('保留中文', () => {
    expect(normalizeName('你好世界')).toBe('你好世界')
  })

  it('空字符串', () => {
    expect(normalizeName('')).toBe('')
    expect(normalizeName(null)).toBe('')
  })
})

describe('normalizeTitle', () => {
  it('移除序号前缀', () => {
    expect(normalizeTitle('001. 序章')).toBe(normalizeName('序章'))
    expect(normalizeTitle('[1] 第一话')).toBe(normalizeName('第一话'))
  })

  it('空字符串', () => {
    expect(normalizeTitle('')).toBe('')
    expect(normalizeTitle(null)).toBe('')
  })
})

describe('escapeLike', () => {
  it('转义 LIKE 通配符', () => {
    expect(escapeLike('test%name')).toBe('test\\%name')
    expect(escapeLike('test_name')).toBe('test\\_name')
  })
})