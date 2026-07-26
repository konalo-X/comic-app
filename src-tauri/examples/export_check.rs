// 验证 exporter：对真实已下载漫画导出 EPUB + CBZ
#[path = "../src/paths.rs"]
mod paths;
#[path = "../src/exporter.rs"]
mod exporter;

use std::path::PathBuf;

fn main() {
    // 用真实已下载目录
    let source_dir = PathBuf::from("/Volumes/可移动磁盘/ComicDownloads/10人10色：初体验");
    if !source_dir.exists() {
        println!("样本目录不存在，跳过（盘未挂载）");
        return;
    }
    // 扫描章节子目录
    let mut chapters: Vec<exporter::ExportChapter> = Vec::new();
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(&source_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    for d in dirs.iter().take(3) {
        // 只取前3章加速
        let name = d.file_name().unwrap().to_string_lossy().to_string();
        chapters.push(exporter::ExportChapter { name, dir: d.clone() });
    }
    println!("章节数(取前3): {}", chapters.len());

    let out_epub = PathBuf::from("/tmp/export_test.epub");
    let out_cbz = PathBuf::from("/tmp/export_test.cbz");
    let _ = std::fs::remove_file(&out_epub);
    let _ = std::fs::remove_file(&out_cbz);

    println!("\n== EPUB ==");
    match exporter::to_epub(&source_dir, &out_epub, "10人10色初体验", "测试作者", &chapters) {
        Ok(n) => {
            let sz = std::fs::metadata(&out_epub).map(|m| m.len()).unwrap_or(0);
            println!("  写入 {} 张图, 文件 {} 字节", n, sz);
        }
        Err(e) => println!("  失败: {}", e),
    }

    println!("\n== CBZ ==");
    match exporter::to_cbz(&source_dir, &out_cbz, &chapters) {
        Ok(n) => {
            let sz = std::fs::metadata(&out_cbz).map(|m| m.len()).unwrap_or(0);
            println!("  写入 {} 张图, 文件 {} 字节", n, sz);
        }
        Err(e) => println!("  失败: {}", e),
    }
    println!("\n完成");
}
