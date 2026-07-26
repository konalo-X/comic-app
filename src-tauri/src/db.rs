// DB 查询层：移植 comic-app/electron/db/*.js 的只读 + 收藏/进度写入
use rusqlite::{Connection, Row};
use serde::Serialize;

// 前端 rowToComic 契约：_id / desc / tags[] / favorited(bool) / updateDelta / chapters[]
#[derive(Serialize, Clone)]
pub struct Chapter {
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub sort_order: i64,
}

#[derive(Serialize, Clone)]
pub struct Comic {
    #[serde(rename = "_id")]
    pub id: String,
    #[serde(rename = "sourceUrl")]
    pub source_url: Option<String>,
    pub title: Option<String>,
    pub cover: Option<String>,
    pub local_cover: Option<String>,
    pub local_path: Option<String>,
    pub author: Option<String>,
    pub status: Option<String>,
    pub desc: Option<String>,
    pub tags: Vec<String>,
    pub category: Option<String>,
    #[serde(rename = "updateTime")]
    pub update_time: String,
    pub chapter_count: i64,
    #[serde(rename = "updateDelta")]
    pub update_delta: i64,
    pub favorited: bool,
    #[serde(rename = "createdAt")]
    pub created_at: Option<i64>,
    #[serde(rename = "updatedAt")]
    pub updated_at: Option<i64>,
    #[serde(rename = "epubExists")]
    pub epub_exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chapters: Option<Vec<Chapter>>,
}

#[derive(Serialize)]
pub struct ComicsPage {
    pub docs: Vec<Comic>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
}

#[derive(Serialize)]
pub struct CategoryStats {
    pub stats: std::collections::BTreeMap<String, i64>,
    pub untagged: i64,
    pub total: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingProgress {
    pub comic_id: String,
    pub chapter_index: i64,
    pub chapter_url: String,
    pub page_index: i64,
    pub total_pages: i64,
    pub progress: f64,
    pub updated_at: i64,
}

// 阅读历史项：{ progress: {...}, comic: {...} }（对齐 getAllReadingHistory）
#[derive(Serialize)]
pub struct HistoryProgress {
    #[serde(rename = "comicId")]
    pub comic_id: String,
    #[serde(rename = "chapterIndex")]
    pub chapter_index: i64,
    #[serde(rename = "chapterUrl")]
    pub chapter_url: String,
    #[serde(rename = "pageIndex")]
    pub page_index: i64,
    #[serde(rename = "totalPages")]
    pub total_pages: i64,
    pub pct: f64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

#[derive(Serialize)]
pub struct HistoryComic {
    pub id: String,
    #[serde(rename = "sourceUrl")]
    pub source_url: Option<String>,
    pub title: Option<String>,
    pub cover: Option<String>,
    pub author: Option<String>,
    pub status: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Serialize)]
pub struct HistoryItem {
    pub progress: HistoryProgress,
    pub comic: Option<HistoryComic>,
}

const SELECT_FIELDS: &str = "id, sourceUrl, title, cover, local_cover, author, status, desc_text, tags, category, updateTime, chapter_count, update_delta, favorited, createdAt, updatedAt, local_path";

fn row_to_comic(r: &Row) -> rusqlite::Result<Comic> {
    let tags_raw: Option<String> = r.get("tags")?;
    let tags = tags_raw
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();
    let update_time: Option<i64> = r.get("updateTime").ok();
    let favorited: i64 = r.get("favorited").unwrap_or(0);
    Ok(Comic {
        id: r.get("id")?,
        source_url: r.get("sourceUrl")?,
        title: r.get("title")?,
        cover: r.get("cover")?,
        local_cover: r.get("local_cover")?,
        local_path: r.get("local_path")?,
        author: r.get("author")?,
        status: r.get("status")?,
        desc: r.get("desc_text")?,
        tags,
        category: r.get("category")?,
        update_time: update_time.map(|v| v.to_string()).unwrap_or_default(),
        chapter_count: r.get("chapter_count").unwrap_or(0),
        update_delta: r.get("update_delta").unwrap_or(0),
        favorited: favorited != 0,
        created_at: r.get("createdAt").ok(),
        updated_at: r.get("updatedAt").ok(),
        epub_exists: false,
        chapters: None,
    })
}

/// 构建 WHERE 子句（对齐 helpers.js buildWhereClause）
fn build_where(
    category: &Option<String>,
    status: &Option<String>,
    tag: &Option<String>,
    search: &Option<String>,
    local_only: bool,
    online_only: bool,
) -> (String, Vec<String>) {
    let mut conds: Vec<String> = Vec::new();
    let mut params: Vec<String> = Vec::new();

    if let Some(cat) = category {
        if !cat.is_empty() && cat != "all" {
            if cat == "__untagged__" {
                conds.push("(category IS NULL OR category = '')".into());
            } else {
                conds.push("category = ?".into());
                params.push(cat.clone());
            }
        }
    }
    if let Some(st) = status {
        if !st.is_empty() && st != "all" {
            if st == "completed" {
                conds.push("(status LIKE '%完结%' OR status LIKE '%已完结%')".into());
            } else if st == "serialized" {
                conds.push("(status LIKE '%连载%' OR status = '' OR status IS NULL)".into());
            }
        }
    }
    if let Some(t) = tag {
        if !t.is_empty() && t != "all" {
            conds.push("tags LIKE ?".into());
            params.push(format!("%{}%", t));
        }
    }
    if let Some(s) = search {
        if !s.is_empty() {
            conds.push("(title LIKE ? OR author LIKE ? OR tags LIKE ?)".into());
            let like = format!("%{}%", s);
            params.push(like.clone());
            params.push(like.clone());
            params.push(like);
        }
    }
    if local_only {
        conds.push("(local_path IS NOT NULL AND local_path != '')".into());
    }
    if online_only {
        conds.push("(local_path IS NULL OR local_path = '')".into());
    }

    let where_clause = if conds.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conds.join(" AND "))
    };
    (where_clause, params)
}

fn order_clause(sort: &Option<String>) -> (String, String) {
    let s = sort.as_deref().unwrap_or("");
    match s {
        "time" => (String::new(), "updatedAt DESC, updateTime DESC, createdAt DESC".into()),
        "update" => (String::new(), "update_delta DESC, updatedAt DESC, createdAt DESC".into()),
        "hits" => (
            "LEFT JOIN (SELECT comic_id, MAX(updated_at) as last_read FROM reading_progress GROUP BY comic_id) rp ON rp.comic_id = comics.id".into(),
            "CASE WHEN rp.last_read IS NOT NULL THEN 0 ELSE 1 END, rp.last_read DESC, updatedAt DESC, createdAt DESC".into(),
        ),
        _ => (
            String::new(),
            "CASE WHEN update_delta > 0 THEN 0 ELSE 1 END, updatedAt DESC, updateTime DESC, createdAt DESC".into(),
        ),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn get_comics(
    db: &Connection,
    page: i64,
    page_size: i64,
    category: Option<String>,
    status: Option<String>,
    tag: Option<String>,
    search: Option<String>,
    sort: Option<String>,
    local_only: bool,
    online_only: bool,
) -> rusqlite::Result<ComicsPage> {
    let (where_clause, params) =
        build_where(&category, &status, &tag, &search, local_only, online_only);
    let total: i64 = {
        let sql = format!("SELECT COUNT(*) FROM comics {}", where_clause);
        let mut stmt = db.prepare(&sql)?;
        stmt.query_row(rusqlite::params_from_iter(params.iter()), |r| r.get(0))?
    };

    let (join, order) = order_clause(&sort);
    let select = if join.is_empty() {
        SELECT_FIELDS.to_string()
    } else {
        SELECT_FIELDS
            .split(", ")
            .map(|f| format!("comics.{}", f))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let offset = (page.max(1) - 1) * page_size;
    let sql = format!(
        "SELECT {} FROM comics {} {} ORDER BY {} LIMIT ? OFFSET ?",
        select, join, where_clause, order
    );

    let mut all_params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    for p in &params {
        all_params.push(Box::new(p.clone()));
    }
    all_params.push(Box::new(page_size));
    all_params.push(Box::new(offset));
    let refs: Vec<&dyn rusqlite::ToSql> = all_params.iter().map(|b| b.as_ref()).collect();

    let mut stmt = db.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(refs), row_to_comic)?;
    let mut docs: Vec<Comic> = Vec::new();
    for r in rows {
        docs.push(r?);
    }

    // 批量补章节（loadComicsWithChapters）
    if !docs.is_empty() {
        let ids: Vec<String> = docs.iter().map(|c| c.id.clone()).collect();
        let ph = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let csql = format!(
            "SELECT comic_id, name, url FROM chapters WHERE comic_id IN ({}) ORDER BY sort_order",
            ph
        );
        let mut cstmt = db.prepare(&csql)?;
        let idrefs: Vec<&dyn rusqlite::ToSql> =
            ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
        let crows = cstmt.query_map(rusqlite::params_from_iter(idrefs), |r| {
            Ok((
                r.get::<_, String>(0)?,
                Chapter {
                    name: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    url: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    sort_order: 0,
                },
            ))
        })?;
        let mut map: std::collections::HashMap<String, Vec<Chapter>> = std::collections::HashMap::new();
        for cr in crows {
            let (cid, ch) = cr?;
            map.entry(cid).or_default().push(ch);
        }
        for d in &mut docs {
            d.chapters = Some(map.remove(&d.id).unwrap_or_default());
        }
    }

    Ok(ComicsPage {
        docs,
        total,
        page,
        page_size,
    })
}

pub fn get_comic_by_id(db: &Connection, id: &str) -> rusqlite::Result<Option<Comic>> {
    let sql = format!("SELECT {} FROM comics WHERE id = ?", SELECT_FIELDS);
    let mut stmt = db.prepare(&sql)?;
    let mut rows = stmt.query_map([id], row_to_comic)?;
    if let Some(r) = rows.next() {
        let mut comic = r?;
        comic.chapters = Some(load_chapters(db, &comic.id)?);
        Ok(Some(comic))
    } else {
        Ok(None)
    }
}

pub fn load_chapters(db: &Connection, comic_id: &str) -> rusqlite::Result<Vec<Chapter>> {
    let mut stmt = db.prepare(
        "SELECT name, url, sort_order FROM chapters WHERE comic_id = ? ORDER BY sort_order",
    )?;
    let rows = stmt.query_map([comic_id], |r| {
        Ok(Chapter {
            name: r.get::<_, Option<String>>(0)?.unwrap_or_default(),
            url: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            sort_order: r.get(2).unwrap_or(0),
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn comics_count(db: &Connection) -> rusqlite::Result<i64> {
    db.query_row("SELECT COUNT(*) FROM comics", [], |r| r.get(0))
}

pub fn category_stats(db: &Connection) -> rusqlite::Result<CategoryStats> {
    let mut stmt = db.prepare(
        "SELECT category, COUNT(*) as cnt FROM comics WHERE category IS NOT NULL AND category != '' GROUP BY category ORDER BY cnt DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
    })?;
    let mut stats = std::collections::BTreeMap::new();
    for r in rows {
        let (k, v) = r?;
        stats.insert(k, v);
    }
    let untagged: i64 = db.query_row(
        "SELECT COUNT(*) FROM comics WHERE category IS NULL OR category = ''",
        [],
        |r| r.get(0),
    )?;
    let total: i64 = db.query_row("SELECT COUNT(*) FROM comics", [], |r| r.get(0))?;
    Ok(CategoryStats {
        stats,
        untagged,
        total,
    })
}

pub fn set_favorite(db: &Connection, comic_id: &str, favorited: bool) -> rusqlite::Result<()> {
    db.execute(
        "UPDATE comics SET favorited = ? WHERE id = ? OR sourceUrl = ?",
        rusqlite::params![if favorited { 1 } else { 0 }, comic_id, comic_id],
    )?;
    Ok(())
}

pub fn clear_update_delta(db: &Connection, comic_id: &str) -> rusqlite::Result<()> {
    db.execute(
        "UPDATE comics SET update_delta = 0 WHERE id = ?",
        [comic_id],
    )?;
    Ok(())
}

pub fn get_reading_progress(
    db: &Connection,
    comic_id: &str,
) -> rusqlite::Result<Option<ReadingProgress>> {
    let mut stmt =
        db.prepare("SELECT comic_id, chapter_index, chapter_url, page_index, total_pages, progress, updated_at FROM reading_progress WHERE comic_id = ? LIMIT 1")?;
    let mut rows = stmt.query_map([comic_id], |r| {
        Ok(ReadingProgress {
            comic_id: r.get(0)?,
            chapter_index: r.get(1)?,
            chapter_url: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            page_index: r.get(3)?,
            total_pages: r.get(4)?,
            progress: r.get(5)?,
            updated_at: r.get(6)?,
        })
    })?;
    if let Some(r) = rows.next() {
        Ok(Some(r?))
    } else {
        Ok(None)
    }
}

pub fn save_reading_progress(
    db: &Connection,
    comic_id: &str,
    chapter_index: i64,
    chapter_url: &str,
    page_index: i64,
    total_pages: i64,
) -> rusqlite::Result<()> {
    let progress = if total_pages > 0 {
        (page_index + 1) as f64 / total_pages as f64
    } else {
        0.0
    };
    let now = now_ms();
    db.execute(
        "INSERT OR REPLACE INTO reading_progress (id, comic_id, chapter_index, chapter_url, page_index, total_pages, progress, updated_at) VALUES (?,?,?,?,?,?,?,?)",
        rusqlite::params![comic_id, comic_id, chapter_index, chapter_url, page_index, total_pages, progress, now],
    )?;
    Ok(())
}

/// download_records 里某漫画某章节的下载路径（用于本地取图快路径）
pub fn download_record_path(
    db: &Connection,
    comic_id: Option<&str>,
    comic_title: Option<&str>,
    chapter_index: i64,
) -> rusqlite::Result<Option<String>> {
    if let Some(cid) = comic_id {
        let r: rusqlite::Result<String> = db.query_row(
            "SELECT path FROM download_records WHERE comic_id = ? AND chapter_index = ? AND path IS NOT NULL AND path != '' LIMIT 1",
            rusqlite::params![cid, chapter_index],
            |r| r.get(0),
        );
        if let Ok(p) = r {
            return Ok(Some(p));
        }
    }
    if let Some(t) = comic_title {
        let r: rusqlite::Result<String> = db.query_row(
            "SELECT path FROM download_records WHERE comic_title = ? AND chapter_index = ? AND path IS NOT NULL AND path != '' LIMIT 1",
            rusqlite::params![t, chapter_index],
            |r| r.get(0),
        );
        if let Ok(p) = r {
            return Ok(Some(p));
        }
    }
    Ok(None)
}

pub fn get_all_reading_history(db: &Connection, limit: i64) -> rusqlite::Result<Vec<HistoryItem>> {
    let mut stmt = db.prepare(
        "SELECT rp.comic_id, rp.chapter_index, rp.chapter_url, rp.page_index, rp.total_pages, rp.progress, rp.updated_at, \
         c.id as cid, c.sourceUrl, c.title, c.cover, c.author, c.status, c.tags \
         FROM reading_progress rp \
         LEFT JOIN comics c ON c.id = rp.comic_id OR c.sourceUrl = rp.comic_id \
         ORDER BY rp.updated_at DESC LIMIT ?",
    )?;
    let rows = stmt.query_map([limit], |r| {
        let cid: Option<String> = r.get("cid")?;
        let comic = if let Some(id) = cid {
            let tags_raw: Option<String> = r.get("tags")?;
            let tags = tags_raw
                .unwrap_or_default()
                .split(',')
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect();
            Some(HistoryComic {
                id,
                source_url: r.get("sourceUrl")?,
                title: r.get("title")?,
                cover: r.get("cover")?,
                author: r.get("author")?,
                status: r.get("status")?,
                tags,
            })
        } else {
            None
        };
        Ok(HistoryItem {
            progress: HistoryProgress {
                comic_id: r.get("comic_id")?,
                chapter_index: r.get("chapter_index")?,
                chapter_url: r.get::<_, Option<String>>("chapter_url")?.unwrap_or_default(),
                page_index: r.get("page_index")?,
                total_pages: r.get("total_pages")?,
                pct: r.get("progress")?,
                updated_at: r.get("updated_at")?,
            },
            comic,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn delete_reading_progress(db: &Connection, comic_id: &str) -> rusqlite::Result<()> {
    db.execute("DELETE FROM reading_progress WHERE comic_id = ?", [comic_id])?;
    Ok(())
}

pub fn get_comic_by_title(db: &Connection, title: &str) -> rusqlite::Result<Option<Comic>> {
    let sql = format!("SELECT {} FROM comics WHERE title = ?", SELECT_FIELDS);
    let mut stmt = db.prepare(&sql)?;
    let mut rows = stmt.query_map([title], row_to_comic)?;
    if let Some(r) = rows.next() {
        let mut comic = r?;
        comic.chapters = Some(load_chapters(db, &comic.id)?);
        Ok(Some(comic))
    } else {
        Ok(None)
    }
}

pub fn get_comic_by_url(db: &Connection, url: &str) -> rusqlite::Result<Option<Comic>> {
    let sql = format!("SELECT {} FROM comics WHERE sourceUrl = ?", SELECT_FIELDS);
    let mut stmt = db.prepare(&sql)?;
    let mut rows = stmt.query_map([url], row_to_comic)?;
    if let Some(r) = rows.next() {
        let mut comic = r?;
        comic.chapters = Some(load_chapters(db, &comic.id)?);
        Ok(Some(comic))
    } else {
        Ok(None)
    }
}

pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn chapters_count(db: &Connection) -> i64 {
    db.query_row("SELECT COUNT(*) FROM chapters", [], |r| r.get(0)).unwrap_or(0)
}

pub fn images_count(db: &Connection) -> i64 {
    db.query_row("SELECT COALESCE(SUM(image_count),0) FROM chapters", [], |r| r.get(0)).unwrap_or(0)
}

/// 下载记录中所有 distinct path 的磁盘占用��（字节）
pub fn download_size(db: &Connection) -> u64 {
    let mut total = 0u64;
    if let Ok(mut stmt) =
        db.prepare("SELECT DISTINCT path FROM download_records WHERE path IS NOT NULL AND path != ''")
    {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
            for p in rows.flatten() {
                total += dir_size(std::path::Path::new(&p));
            }
        }
    }
    total
}

fn dir_size(p: &std::path::Path) -> u64 {
    let meta = match std::fs::symlink_metadata(p) {
        Ok(m) => m,
        Err(_) => return 0,
    };
    if meta.is_file() {
        return meta.len();
    }
    if meta.is_dir() {
        let mut total = 0u64;
        if let Ok(entries) = std::fs::read_dir(p) {
            for e in entries.flatten() {
                total += dir_size(&e.path());
            }
        }
        return total;
    }
    0
}

/// 下载记录列表（listLocal）
pub fn download_records(db: &Connection) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    if let Ok(mut stmt) = db.prepare(
        "SELECT comic_id, comic_title, chapter_index, chapter_name, images_count, path, url, status, downloaded_at \
         FROM download_records ORDER BY downloaded_at DESC",
    ) {
        if let Ok(rows) = stmt.query_map([], |r| {
            Ok(serde_json::json!({
                "comic_id": r.get::<_, Option<String>>(0)?,
                "comicTitle": r.get::<_, Option<String>>(1)?,
                "chapterIndex": r.get::<_, Option<i64>>(2)?,
                "chapterName": r.get::<_, Option<String>>(3)?,
                "imagesCount": r.get::<_, Option<i64>>(4)?,
                "path": r.get::<_, Option<String>>(5)?,
                "url": r.get::<_, Option<String>>(6)?,
                "status": r.get::<_, Option<String>>(7)?,
                "downloadedAt": r.get::<_, Option<i64>>(8)?,
            }))
        }) {
            for v in rows.flatten() {
                out.push(v);
            }
        }
    }
    out
}

/// 标记同步时间
pub fn mark_synced(db: &Connection, ids: &[String]) -> rusqlite::Result<()> {
    let now = now_ms();
    for id in ids {
        db.execute("UPDATE comics SET last_sync_at=? WHERE id=?", rusqlite::params![now, id])?;
    }
    Ok(())
}

/// 字段缺失的漫画（autoEnrich 候选）——需有 sourceUrl
pub fn comics_with_missing_fields(db: &Connection, limit: i64) -> Vec<Comic> {
    let sql = format!(
        "SELECT {} FROM comics WHERE (desc_text IS NULL OR desc_text='' \
         OR category IS NULL OR category='' OR author IS NULL OR author='' \
         OR status IS NULL OR status='' OR chapter_count=0 OR chapter_count IS NULL) \
         AND sourceUrl IS NOT NULL AND sourceUrl!='' ORDER BY updatedAt DESC LIMIT ?",
        SELECT_FIELDS
    );
    let mut out = Vec::new();
    if let Ok(mut stmt) = db.prepare(&sql) {
        if let Ok(rows) = stmt.query_map([limit], row_to_comic) {
            for c in rows.flatten() {
                out.push(c);
            }
        }
    }
    out
}

pub fn count_missing_fields(db: &Connection) -> i64 {
    db.query_row(
        "SELECT COUNT(*) FROM comics WHERE (desc_text IS NULL OR desc_text='' \
         OR category IS NULL OR category='' OR author IS NULL OR author='' \
         OR status IS NULL OR status='' OR chapter_count=0 OR chapter_count IS NULL) \
         AND sourceUrl IS NOT NULL AND sourceUrl!=''",
        [],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

/// 将拉取到的详情回写到 comics（只补空缺字段，不覆盖已有）
#[allow(clippy::too_many_arguments)]
pub fn enrich_comic_metadata(
    db: &Connection,
    comic_id: &str,
    cover: &str,
    author: &str,
    status: &str,
    desc: &str,
    tags: &str,
    category: &str,
    chapter_count: i64,
) -> rusqlite::Result<()> {
    let now = now_ms();
    db.execute(
        "UPDATE comics SET \
         cover=COALESCE(NULLIF(cover,''),?), \
         author=COALESCE(NULLIF(author,''),?), \
         status=COALESCE(NULLIF(status,''),?), \
         desc_text=COALESCE(NULLIF(desc_text,''),?), \
         tags=COALESCE(NULLIF(tags,''),?), \
         category=COALESCE(NULLIF(category,''),?), \
         chapter_count=CASE WHEN chapter_count IS NULL OR chapter_count=0 THEN ? ELSE chapter_count END, \
         updatedAt=? WHERE id=?",
        rusqlite::params![
            cover, author, status, desc, tags, category,
            chapter_count, now, comic_id
        ],
    )?;
    Ok(())
}

/// 清空所有漫画（clearComics）
pub fn clear_comics(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch("DELETE FROM chapters; DELETE FROM comics; DELETE FROM download_records;")?;
    Ok(())
}

/// 收集待同步漫画（仅 favorited，按 last_sync_at ASC 断点续追）
pub fn gather_sync_comics(db: &Connection, limit: i64) -> Vec<Comic> {
    let sql = format!(
        "SELECT {} FROM comics WHERE favorited=1 ORDER BY COALESCE(last_sync_at,0) ASC LIMIT ?",
        SELECT_FIELDS
    );
    let mut out = Vec::new();
    if let Ok(mut stmt) = db.prepare(&sql) {
        if let Ok(rows) = stmt.query_map([limit], row_to_comic) {
            for c in rows.flatten() {
                out.push(c);
            }
        }
    }
    out
}
