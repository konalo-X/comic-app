// 验证下载引擎：getPageList → 并发下载 → 转 webp 落盘（用本地 fixture）
#[path = "../src/source.rs"]
mod source;
#[path = "../src/paths.rs"]
mod paths;
#[path = "../src/download.rs"]
mod download;
// download.rs 依赖 crate::db::now_ms 与 crate::{source,paths}；这里给个最小 db shim
mod db {
    pub fn now_ms() -> i64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
    }
}

use std::path::PathBuf;

fn main() {
    let comic_dir = PathBuf::from("/tmp/comiv_dl_out/测试漫画");
    let _ = std::fs::remove_dir_all("/tmp/comiv_dl_out");
    std::fs::create_dir_all(&comic_dir).unwrap();

    let job = download::ChapterJob {
        comic_title: "测试漫画".into(),
        chapter_index: 0,
        chapter_name: "第01话 下载测试".into(),
        chapter_url: "http://127.0.0.1:8890/chapter/1".into(),
        referer: "http://127.0.0.1:8890/".into(),
        source_url: "http://127.0.0.1:8890/comic/test".into(),
    };

    println!("== download_chapter ==");
    match download::download_chapter(&job, &comic_dir, &|c, t| {
        if c == t {
            println!("  进度: {}/{}", c, t);
        }
    }) {
        Ok(r) => {
            println!(
                "  success={} skipped={} downloaded={} total={} failed={} dir={}",
                r.success, r.skipped, r.downloaded, r.total, r.failed, r.chapter_dir
            );
            // 校验落盘的 webp
            let files = paths::list_chapter_images(std::path::Path::new(&r.chapter_dir));
            println!("  落盘图片 {} 张:", files.len());
            for f in &files {
                let b = std::fs::read(f).unwrap();
                let is_webp = b.len() > 12 && &b[8..12] == b"WEBP";
                println!(
                    "   {} {} 字节 webp={}",
                    f.file_name().unwrap().to_string_lossy(),
                    b.len(),
                    is_webp
                );
                assert!(is_webp, "非 webp 落盘: {:?}", f);
            }
            assert_eq!(files.len(), 3, "应落盘 3 张");
            println!("\n== 二次下载（应全部 skip）==");
            let r2 = download::download_chapter(&job, &comic_dir, &|_, _| {}).unwrap();
            println!("  skipped={} downloaded={}", r2.skipped, r2.downloaded);
            assert!(r2.skipped, "二次应 skip");
            println!("\n✅ 下载引擎验证通过（png/jpg/webp 混合源→全部转 webp 落盘 + 幂等 skip）");
        }
        Err(e) => println!("  失败: {}", e),
    }
}
