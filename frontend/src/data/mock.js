import img1 from '@/assets/covers/cover1.svg'
import img2 from '@/assets/covers/cover2.svg'
import img3 from '@/assets/covers/cover3.svg'
import img4 from '@/assets/covers/cover4.svg'
import img5 from '@/assets/covers/cover5.svg'
import img6 from '@/assets/covers/cover6.svg'
import img7 from '@/assets/covers/cover7.svg'
import img8 from '@/assets/covers/cover8.svg'

const authors = ['尾田荣一郎', '藤本树', '荒川弘', '井上雄彦', '吾峠呼世晴', '芥见下下', '真岛浩', '石田翠']
const genres = ['热血', '冒险', '恋爱', '校园', '悬疑', '奇幻', '科幻', '日常', '恐怖', '美食', '体育']

function rand(n) { return Math.floor(Math.random() * n) }
function pick(arr) { return arr[rand(arr.length)] }

const titles = [
  '星海征途', '黎明之剑', '机械之心', '雾都迷影', '樱落物语',
  '第九区笔记', '赤色地平线', '午夜美术馆', '风见少年', '时间的回响',
  '月下盟约', '青空协奏曲', '无名之城', '深渊回响', '霓虹切片',
  '银河铁道夜', '黄昏奏鸣曲', '北境雪国', '幻夜马戏团', '千之扉'
]

const covers = [img1, img2, img3, img4, img5, img6, img7, img8]
const descriptions = [
  '在遥远的未来世界，人类文明已遍布星河，但一场突如其来的星际风暴，使得一切秩序都被重新洗牌。主角作为流亡舰队的指挥官，将带领幸存者们寻找新的家园。',
  '繁华都市的表象之下，隐藏着不为人知的秘密。一位神秘的侦探与他的搭档，以敏锐的直觉揭开层层迷雾，最终直面人性最深处的恐惧与希望。',
  '这是一个关于青春、友情与梦想的故事。在樱花盛开的校园里，少年少女们在阳光下奔跑，在雨幕中哭泣，然后渐渐明白成长真正的意义。',
  '当魔法与科学交汇，一场跨越维度的战争正在悄然酝酿。被命运选中的少年，手持古老遗物踏上旅途，他必须在有限的时间里找到真相。'
]

export function genComics(n = 16) {
  const items = []
  for (let i = 0; i < n; i++) {
    const title = titles[i % titles.length]
    const chapterCount = 20 + rand(180)
    const lastRead = rand(chapterCount)
    const rating = (7.5 + Math.random() * 2.4).toFixed(1)
    items.push({
      id: i + 1,
      title,
      author: pick(authors),
      genres: Array.from(new Set([pick(genres), pick(genres), pick(genres)])).slice(0, 3),
      cover: covers[i % covers.length],
      rating,
      chapters: chapterCount,
      lastChapter: chapterCount,
      lastRead,
      views: (Math.random() * 9.9 + 0.2).toFixed(1) + 'M',
      year: 2018 + rand(7),
      status: pick(['连载中', '已完结', '月刊', '休刊中']),
      description: pick(descriptions),
      updatedAt: `${pick(['1', '3', '6', '12', '24'])} 小时前更新`
    })
  }
  return items
}

export function genChapters(count) {
  const chapters = []
  const titles = ['序章·黎明', '相遇', '风暴前夕', '跨越边界', '第一个敌人', '觉醒', '同伴', '归乡之路', '深渊', '真相', '终局之战', '新的世界']
  for (let i = 0; i < count; i++) {
    chapters.push({
      no: i + 1,
      title: titles[i % titles.length] + (i >= titles.length ? ` · 第${i + 1}话` : ''),
      pages: 22 + rand(18),
      date: `${2024 - rand(2)}-${String(1 + rand(12)).padStart(2, '0')}-${String(1 + rand(28)).padStart(2, '0')}`,
      free: i < 6 || rand(2) === 0
    })
  }
  return chapters
}

export const comics = genComics(18)