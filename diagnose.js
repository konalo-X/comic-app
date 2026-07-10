const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// 与 db.js 中的 normalizeName 保持一致
function normalizeName(s) {
  if (!s) return '';
  return String(s)
    .trim()
    .replace(/[^\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u30FF\uAC00-\uD7AFa-zA-Z0-9]+/g, '')
    .toLowerCase();
}

(async () => {
  const SQL = await initSqlJs();
  const appDataPath = process.env.APPDATA || (process.platform === 'darwin' ? path.join(process.env.HOME, 'Library', 'Application Support') : path.join(process.env.HOME, '.local', 'share'));
  const dbPath = path.join(appDataPath, 'comic-app', 'comics.sqlite');

  console.log('=== 诊断: 注册本地漫画 ===\n');
  console.log('数据库路径:', dbPath);

  if (!fs.existsSync(dbPath)) {
    console.log('数据库文件不存在，跳过诊断。');
    return;
  }

  // 1. 模拟 scanLocalComics 的输出（用假数据测试注册逻辑）
  const testComics = [
    { title: '测试漫画-A', chapters: [{ name: '第1话', imageCount: 5, path: '/test/a/ch1' }, { name: '第2话', imageCount: 5, path: '/test/a/ch2' }], coverPath: '/test/a/cover.webp' },
    { title: '测试漫画-B', chapters: [{ name: '第1话', imageCount: 3, path: '/test/b/ch1' }], coverPath: '/test/b/cover.webp' },
    { title: '测试漫画-C', chapters: [{ name: '第1话', imageCount: 8, path: '/test/c/ch1' }, { name: '第2话', imageCount: 8, path: '/test/c/ch2' }, { name: '第3话', imageCount: 5, path: '/test/c/ch3' }], coverPath: null }
  ];

  console.log('\n--- 第1步: 查看当前数据库状态 ---');
  const buf = fs.readFileSync(dbPath);
  const db = new SQL.Database(buf);

  const allRows = db.exec('SELECT id, title, sourceUrl, favorited, updatedAt, chapter_count FROM comics ORDER BY updatedAt DESC');
  if (allRows.length > 0 && allRows[0].values.length > 0) {
    console.log(`\n数据库中共 ${allRows[0].values.length} 本漫画:`);
    allRows[0].values.forEach((row, i) => {
      console.log(`  ${i + 1}. [fav=${row[3]}] ${row[1]} (id=${row[0].substring(0, 30)}...)`);
    });
  } else {
    console.log('数据库中还没有漫画。');
  }

  console.log('\n--- 第2步: 模拟注册过程（直接测试 registerExistingDownload 逻辑）---');

  // 复制 registerExistingDownload 的核心逻辑到这里
  function testRegister(comic) {
    const now = Date.now();

    // 1. 获取现有下载记录
    const dlRows = db.exec('SELECT comic_title, chapter_index FROM download_records');
    const existingKeys = new Set();
    if (dlRows.length > 0) dlRows[0].values.forEach(r => existingKeys.add(`${r[0]}-${r[1]}`));

    // 2. 智能匹配
    let finalComicId = null;
    let matchedBy = null;

    const normTitle = normalizeName(comic.title);
    const allComicsRows = db.exec('SELECT id, title, sourceUrl FROM comics');
    if (allComicsRows.length > 0) {
      for (const row of allComicsRows[0].values) {
        const [id, dbTitle] = row;
        if (dbTitle === comic.title) {
          finalComicId = id;
          matchedBy = 'title-exact';
          break;
        }
        if (normalizeName(dbTitle) === normTitle) {
          finalComicId = id;
          matchedBy = 'title-fuzzy';
          break;
        }
      }
    }

    if (!finalComicId) {
      finalComicId = 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
      matchedBy = 'new';
    }

    console.log(`\n  注册《${comic.title}》:`);
    console.log(`    finalComicId: ${finalComicId}`);
    console.log(`    matchedBy: ${matchedBy}`);
    console.log(`    coverPath: ${comic.coverPath}`);

    // 3. 写入/更新
    if (matchedBy === 'new') {
      const stmt = db.prepare('INSERT INTO comics (id, sourceUrl, title, cover, status, chapter_count, favorited, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?)');
      try {
        stmt.run([finalComicId, null, comic.title, comic.coverPath || null, '连载中', comic.chapters.length, 1, now, now]);
        stmt.free();
        console.log(`    ✅ INSERT 成功`);
      } catch (e) {
        console.log(`    ❌ INSERT 失败: ${e.message}`);
        stmt.free();
        return false;
      }
    } else {
      const stmt = db.prepare('UPDATE comics SET chapter_count = ?, cover = COALESCE(NULLIF(cover, \'\'), ?), favorited = 1, updatedAt = ? WHERE id = ?');
      stmt.run([comic.chapters.length, comic.coverPath || null, now, finalComicId]);
      stmt.free();
      console.log(`    ✅ UPDATE 成功（已匹配到 id=${finalComicId.substring(0,20)}...）`);
    }

    // 4. 章节
    for (let i = 0; i < comic.chapters.length; i++) {
      const ch = comic.chapters[i];
      const key = `${comic.title}-${i}`;
      if (!existingKeys.has(key)) {
        db.run('INSERT INTO chapters (comic_id, name, url, sort_order) VALUES (?,?,?,?)', [finalComicId, ch.name, '', i]);
        db.run('INSERT INTO download_records (comic_id, comic_title, chapter_index, chapter_name, images_count, path, downloaded_at) VALUES (?,?,?,?,?,?,?)', [finalComicId, comic.title, i, ch.name, ch.imageCount || 0, ch.path, now]);
      }
    }

    return true;
  }

  console.log('\n--- 第3步: 执行测试注册 ---');
  for (const tc of testComics) {
    const ok = testRegister(tc);
    if (!ok) console.log('  ⚠️ 注册失败');
  }

  console.log('\n--- 第4步: 验证数据库结果 ---');
  const finalRows = db.exec('SELECT id, title, sourceUrl, favorited, chapter_count, updatedAt FROM comics ORDER BY updatedAt DESC');
  if (finalRows.length > 0 && finalRows[0].values.length > 0) {
    console.log(`\n现在数据库中共 ${finalRows[0].values.length} 本漫画:`);
    finalRows[0].values.forEach((row, i) => {
      const favIcon = row[3] === 1 ? '★' : '☆';
      console.log(`  ${i + 1}. ${favIcon} [favorited=${row[3]}] ${row[1]} (chapters=${row[4]})`);
    });
  }

  console.log('\n--- 第5步: 书架查询测试 (getFavoritedComics) ---');
  const favRows = db.exec('SELECT id, sourceUrl, title, cover, author, status, chapter_count, favorited, createdAt, updatedAt FROM comics WHERE favorited = 1 ORDER BY updatedAt DESC');
  if (favRows.length > 0 && favRows[0].values.length > 0) {
    console.log(`\n书架会显示 ${favRows[0].values.length} 本收藏:`);
    favRows[0].values.forEach((row, i) => {
      console.log(`  ${i + 1}. ${row[2]} (cover=${row[3] ? row[3].substring(0, 30) + '...' : '无'})`);
    });
  } else {
    console.log('书架显示 0 本！');
  }

  console.log('\n=== 诊断结束 ===');
})();