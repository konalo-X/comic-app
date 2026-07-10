function sanitize(n) {
  return n
    .replace(/[<>"/\\|*\x00-\x1F]/g, '_')
    .replace(/:/g, '：')
    .replace(/!/g, '！')
    .replace(/\?/g, '？')
    .trim()
}

console.log('=== sanitize 测试 ===')
console.log('测试1: "ACE:禁断的诈欺之夜" ->', sanitize('ACE:禁断的诈欺之夜'))
console.log('测试2: "27岁穿製服爱爱!" ->', sanitize('27岁穿製服爱爱!'))
console.log('测试3: "G斗吧!真人肉搏王" ->', sanitize('G斗吧!真人肉搏王'))
console.log('测试4: "魔法少女露美娜" ->', sanitize('魔法少女露美娜'))
console.log('测试5: "第1话-测试/章节" ->', sanitize('第1话-测试/章节'))
console.log('测试6: "带有?问号的标题" ->', sanitize('带有?问号的标题'))
console.log('测试7: "含*星号*的章节" ->', sanitize('含*星号*的章节'))
console.log('测试8: "第1话-强制裸露的乐趣" ->', sanitize('1-第1话-强制裸露的乐趣'))

// 与老版本磁盘名对比
console.log('\n=== 与老版本磁盘名对比 ===')
console.log('磁盘: "ACE：禁断的诈欺之夜"')
console.log('新生成:', sanitize('ACE:禁断的诈欺之夜'))
console.log('是否匹配:', sanitize('ACE:禁断的诈欺之夜') === 'ACE：禁断的诈欺之夜')

console.log('\n磁盘: "27岁穿製服爱爱！"')
console.log('新生成:', sanitize('27岁穿製服爱爱!'))
console.log('是否匹配:', sanitize('27岁穿製服爱爱!') === '27岁穿製服爱爱！')

console.log('\n磁盘: "G斗吧！真人肉搏王"')
console.log('新生成:', sanitize('G斗吧!真人肉搏王'))
console.log('是否匹配:', sanitize('G斗吧!真人肉搏王') === 'G斗吧！真人肉搏王')