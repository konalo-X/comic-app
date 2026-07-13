const test = require('node:test')
const assert = require('node:assert/strict')

const dbApi = require('../electron/db')
const { findExistingComicMatch, buildChapterInsertPayload, buildDownloadRecordPayloads, buildComicQuery } = require('../electron/db/helpers')

test('public DB API exposes core helpers and module entrypoints', () => {
  assert.equal(typeof dbApi.initDB, 'function')
  assert.equal(typeof dbApi.getDB, 'function')
  assert.equal(typeof dbApi.getRawDB, 'function')
  assert.equal(typeof dbApi.getComics, 'function')
  assert.equal(typeof dbApi.upsertComic, 'function')
})

test('shared title matching resolves exact and fuzzy matches', () => {
  const rows = [
    { id: '1', title: 'One Piece', sourceUrl: 'a', favorited: 0 },
    { id: '2', title: 'Bleach', sourceUrl: 'b', favorited: 1 }
  ]

  const exact = findExistingComicMatch(rows, 'One Piece')
  assert.ok(exact)
  assert.equal(exact.matchType, 'title-exact')
  assert.equal(exact.row.id, '1')

  const fuzzy = findExistingComicMatch(rows, 'one-piece')
  assert.ok(fuzzy)
  assert.equal(fuzzy.matchType, 'title-fuzzy')
  assert.equal(fuzzy.row.id, '1')
})

test('shared payload helpers build chapter and download records consistently', () => {
  const chapterPayload = buildChapterInsertPayload('comic-1', { name: '第1话', url: 'u1', imageCount: 4 }, 0, { includeImageCount: true })
  assert.equal(chapterPayload.name, '第1话')
  assert.equal(chapterPayload.sortOrder, 0)
  assert.equal(chapterPayload.imageCount, 4)

  const records = buildDownloadRecordPayloads('comic-1', 'Test Comic', [{ name: '第1话', index: 0, imageCount: 4, path: '/tmp/1' }], 123)
  assert.equal(records[0].chapterIndex, 0)
  assert.equal(records[0].imagesCount, 4)
  assert.equal(records[0].downloadedAt, 123)
})

test('shared comic query helper supports custom from clauses', () => {
  const db = {
    prepare(sql) {
      return {
        all(...args) {
          assert.match(sql, /comics_fts/)
          assert.equal(args[0], '"One Piece"')
          return [{ id: '1' }]
        }
      }
    }
  }

  const rows = buildComicQuery({
    db,
    selectFields: 'c.id',
    fromClause: 'comics_fts f JOIN comics c ON c.rowid = f.rowid',
    whereClause: 'WHERE comics_fts MATCH ?',
    params: ['"One Piece"'],
    mapper: row => row.id
  })

  assert.deepEqual(rows, ['1'])
})
