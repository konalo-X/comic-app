// 端到端验证 Phase 2 数据路径：直接复用后端模块（db/paths/imgserver/settings）。
#[path = "../src/db.rs"]
mod db;
#[path = "../src/paths.rs"]
mod paths;
#[path = "../src/imgserver.rs"]
mod imgserver;
#[path = "../src/settings.rs"]
mod settings;

use rusqlite::Connection;

fn db_path() -> String {
    if let Some(base) = dirs::data_dir() {
        let live = base.join("comic-app").join("comics.sqlite");
        if live.exists() {
            return live.to_string_lossy().to_string();
        }
    }
    "/Users/konalo/Projects/comic-app/comics.sqlite".to_string()
}

fn main() {
    let path = db_path();
    println!("DB = {}", path);
    let conn = Connection::open(&path).expect("open db");

    // 1) 书架分页 + 章节补齐
    let page = db::get_comics(
        &conn, 1, 5, None, None, None, None, Some("time".into()), false, false,
    )
    .unwrap();
    println!("\n[getComics] total={} 返回 {} 本", page.total, page.docs.len());
    for c in page.docs.iter().take(5) {
        println!(
            "  _id={}.. title={} fav={} 章节数={} chapters载入={}",
            &c.id[..6],
            c.title.clone().unwrap_or_default(),
            c.favorited,
            c.chapter_count,
            c.chapters.as_ref().map(|v| v.len()).unwrap_or(0)
        );
    }

    // 2) 分类统计
    let stats = db::category_stats(&conn).unwrap();
    println!(
        "\n[categoryStats] total={} untagged={} 分类数={}",
        stats.total,
        stats.untagged,
        stats.stats.len()
    );

    // 3) 阅读历史
    let hist = db::get_all_reading_history(&conn, 5).unwrap();
    println!("\n[readingHistory] {} 条", hist.len());
    for h in hist.iter().take(3) {
        println!(
            "  comicId={} ch={} pct={:.0}% comic={:?}",
            h.progress.comic_id,
            h.progress.chapter_index,
            h.progress.pct * 100.0,
            h.comic.as_ref().and_then(|c| c.title.clone())
        );
    }

    // 4) 离线取图：找一本有 download_records 的漫画，解析本地图片
    let external = settings::external_download_root();
    println!("\n[settings] external_root = {:?}", external);
    let row: Option<(String, String, i64, String)> = conn
        .query_row(
            "SELECT comic_id, comic_title, chapter_index, path FROM download_records \
             WHERE path IS NOT NULL AND path != '' LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .ok();
    if let Some((cid, title, idx, rec_path)) = row {
        println!(
            "\n[offlineImages] comic={} chapterIndex={} recPath={}",
            title, idx, rec_path
        );
        // 快路径：直接用 download_records.path
        let dir = std::path::Path::new(&rec_path);
        let files = paths::list_chapter_images(dir);
        println!("  快路径命中图片: {} 张", files.len());
        if let Some(f) = files.first() {
            println!("  样例代理URL: {}", imgserver::local_proxy_url(&f.to_string_lossy()));
        }
        // 慢路径：按标题 + 序号解析目录
        let local_path = db::get_comic_by_id(&conn, &cid)
            .ok()
            .flatten()
            .and_then(|c| c.local_path);
        if let Some(cdir) = paths::find_comic_dir(&title, local_path.as_deref(), external.as_deref()) {
            println!("  findComicDir -> {}", cdir.display());
            if let Some(chdir) = paths::find_chapter_dir(&cdir, idx, "") {
                let f2 = paths::list_chapter_images(&chdir);
                println!("  findChapterDir -> {} ({} 张)", chdir.display(), f2.len());
            } else {
                println!("  findChapterDir 未命中");
            }
        } else {
            println!("  findComicDir 未命中");
        }
    } else {
        println!("\n[offlineImages] 无 download_records 样本");
    }

    println!("\n✅ Phase 2 数据路径验证完成");
}
