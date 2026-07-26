// 本地目录扫描 + 注册已下载漫画（移植 scanLocalComics + registerExistingDownload）
// 用于把外部盘/文件夹里已有的下载目录导入 DB，标记 favorited=1，写 download_records
use crate::db;
use crate::paths;
use rusqlite::Connection;
use std::path::{Path, PathBuf};

const IMG_EXTS: [&str; 7] = ["webp", "jpg", "jpeg", "png", "gif", "avif", "bmp"];

fn is_image(name: &str) -> bool {
    if let Some(ext) = Path::new(name).extension().and_then(|e| e.to_str()) {
        let e = ext.to_lowercase();
        IMG_EXTS.contains(&e.as_str())
    } else {
        false
    }
}

fn num_key(name: &str) -> i64 {
    let digits: String = name.chars().skip_while(|c| !c.is_ascii_digit())
        .take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().unwrap_or(99999)
}

fn chapter_dir_like(name: &str) -> bool {
    // ^\d+-  或 ^第\d+  或 ^(ch(apter)?[_-]?)?\d+
    let n = name.trim();
    if n.starts_with('第') {
        return n.chars().nth(1).map(|c| c.is_ascii_digit()).unwrap_or(false);
    }
    let lower = n.to_lowercase();
    let stripped = lower
        .strip_prefix("chapter").or_else(|| lower.strip_prefix("ch"))
        .unwrap_or(&lower);
    let stripped = stripped.trim_start_matches(['_', '-']);
    stripped.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false)
}

pub struct ScannedChapter {
    pub name: String,
    pub index: i64,
    pub image_count: i64,
}

pub struct ScannedComic {
    pub title: String,
    pub local_path: String,
    pub chapters: Vec<ScannedChapter>,
}

/// 扫描一个根目录，返回其中的漫画（每本 = 一个含章节子目录的文件夹）
pub fn scan_local_comics(root: &Path) -> Vec<ScannedComic> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for e in entries.flatten() {
        if !e.path().is_dir() {
            continue;
        }
        let comic_name = e.file_name().to_string_lossy().to_string();
        if comic_name.starts_with('_') {
            continue;
        }
        let comic_dir = e.path();
        let subs = match std::fs::read_dir(&comic_dir) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let mut chapter_dirs: Vec<(String, PathBuf)> = Vec::new();
        let mut fallback: Vec<(String, PathBuf)> = Vec::new();
        for s in subs.flatten() {
            if !s.path().is_dir() {
                continue;
            }
            let nm = s.file_name().to_string_lossy().to_string();
            if chapter_dir_like(&nm) {
                chapter_dirs.push((nm, s.path()));
            } else {
                // 兜底：目录内有图片也算章节
                if let Ok(files) = std::fs::read_dir(s.path()) {
                    if files.flatten().any(|f| is_image(&f.file_name().to_string_lossy())) {
                        fallback.push((nm, s.path()));
                    }
                }
            }
        }
        if chapter_dirs.is_empty() {
            chapter_dirs = fallback;
        }
        if chapter_dirs.is_empty() {
            continue;
        }
        chapter_dirs.sort_by_key(|(n, _)| (num_key(n), n.clone()));

        let mut chapters = Vec::new();
        for (idx, (nm, dir)) in chapter_dirs.iter().enumerate() {
            let img_count = std::fs::read_dir(dir)
                .map(|it| it.flatten().filter(|f| is_image(&f.file_name().to_string_lossy())).count())
                .unwrap_or(0);
            let clean = clean_chapter_name(nm);
            chapters.push(ScannedChapter {
                name: clean,
                index: idx as i64,
                image_count: img_count as i64,
            });
        }
        out.push(ScannedComic {
            title: comic_name,
            local_path: comic_dir.to_string_lossy().to_string(),
            chapters,
        });
    }
    out
}

fn clean_chapter_name(name: &str) -> String {
    let mut s = name.to_string();
    // 去 ^\d+-
    if let Some(pos) = s.find('-') {
        if s[..pos].chars().all(|c| c.is_ascii_digit()) && pos > 0 {
            s = s[pos + 1..].to_string();
        }
    }
    s
}

/// 在 comics 表中匹配标题（exact → normalized → contains）
pub fn match_comic_id(conn: &Connection, title: &str) -> Option<(String, bool)> {
    // exact
    if let Ok(row) = conn.query_row(
        "SELECT id, favorited FROM comics WHERE title = ?",
        [title],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? != 0)),
    ) {
        return Some(row);
    }
    // normalized / contains
    let norm = paths::normalize_name(title);
    if norm.is_empty() {
        return None;
    }
    let mut stmt = conn.prepare("SELECT id, title, favorited FROM comics").ok()?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)? != 0))
    }).ok()?;
    for row in rows.flatten() {
        let (id, t, fav) = row;
        let rn = paths::normalize_name(&t);
        if rn == norm {
            return Some((id, fav));
        }
        if rn.len() > 2 && norm.len() > 2 && (rn.contains(&norm) || norm.contains(&rn)) {
            return Some((id, fav));
        }
    }
    None
}

#[derive(serde::Serialize, Default)]
pub struct ScanReport {
    pub total: usize,
    pub matched: usize,
    pub imported: usize,
    pub skipped: usize,
    pub chapters_registered: usize,
}

/// 注册单本已下载漫画到 DB
pub fn register_existing(conn: &Connection, comic: &ScannedComic) -> (bool, usize) {
    let now = db::now_ms();
    let (comic_id, newly) = match match_comic_id(conn, &comic.title) {
        Some((id, _fav)) => {
            let _ = conn.execute(
                "UPDATE comics SET chapter_count=?, favorited=1, local_path=COALESCE(local_path,?), updatedAt=? WHERE id=?",
                rusqlite::params![comic.chapters.len() as i64, comic.local_path, now, id],
            );
            (id, false)
        }
        None => {
            let id = format!("local-{}-{}", now, rand_suffix());
            let _ = conn.execute(
                "INSERT INTO comics (id, sourceUrl, title, cover, local_cover, author, status, desc_text, tags, category, updateTime, chapter_count, update_delta, favorited, local_path, createdAt, updatedAt) \
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                rusqlite::params![
                    id, Option::<String>::None, comic.title, Option::<String>::None, Option::<String>::None,
                    "", "连载中", "", "", "", Option::<String>::None, comic.chapters.len() as i64, 0i64, 1i64,
                    comic.local_path, now, now
                ],
            );
            (id, true)
        }
    };

    // 已有章节 sort_order
    let mut existing: std::collections::HashSet<i64> = std::collections::HashSet::new();
    if let Ok(mut stmt) = conn.prepare("SELECT sort_order FROM chapters WHERE comic_id=?") {
        if let Ok(rows) = stmt.query_map([&comic_id], |r| r.get::<_, i64>(0)) {
            for v in rows.flatten() {
                existing.insert(v);
            }
        }
    }

    let mut registered = 0usize;
    for ch in &comic.chapters {
        if !existing.contains(&ch.index) {
            let _ = conn.execute(
                "INSERT INTO chapters (comic_id, name, url, sort_order, image_count) VALUES (?,?,?,?,?)",
                rusqlite::params![comic_id, ch.name, "", ch.index, ch.image_count],
            );
        }
        // download_records (INSERT OR REPLACE)
        let ch_path = format!("{}/{}-{}", comic.local_path, ch.index + 1, ch.name);
        let _ = conn.execute(
            "INSERT OR REPLACE INTO download_records \
             (comic_id, comic_title, chapter_index, chapter_name, images_count, path, downloaded_at, status, completed, error) \
             VALUES (?,?,?,?,?,?,?,?,?,?)",
            rusqlite::params![
                comic_id, comic.title, ch.index, ch.name, ch.image_count, ch_path, now, "success", 1i64,
                Option::<String>::None
            ],
        );
        registered += 1;
    }
    (newly, registered)
}

fn rand_suffix() -> String {
    let n = db::now_ms() as u64;
    format!("{:x}", n.wrapping_mul(2654435761) & 0xffffff)
}

#[allow(dead_code)]
pub fn auto_scan(conn: &Connection, root: &Path) -> ScanReport {
    let mut report = ScanReport::default();
    let comics = scan_local_comics(root);
    report.total = comics.len();
    for c in &comics {
        let existed = match_comic_id(conn, &c.title).is_some();
        let (_newly, reg) = register_existing(conn, c);
        if existed {
            report.matched += 1;
        }
        if reg > 0 {
            report.imported += 1;
            report.chapters_registered += reg;
        } else {
            report.skipped += 1;
        }
    }
    report
}