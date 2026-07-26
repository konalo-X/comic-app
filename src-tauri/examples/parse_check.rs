// 用本地 fixture 服务器验证解析逻辑（不依赖 smtt6 联网）
#[path = "../src/source.rs"]
mod source;

fn main() {
    let base = "http://127.0.0.1:8899";

    println!("== getDetail ==");
    let d = source::get_detail(&format!("{}/detail", base)).unwrap();
    println!("  title={} cover={} chapters={}", d.title, d.cover, d.chapters.len());
    for c in &d.chapters {
        println!("   - {} -> {}", c.name, c.url);
    }
    assert!(d.title.contains("测试漫画"), "title 解析失败");
    assert_eq!(d.chapters.len(), 2, "章节数错误");

    println!("\n== getPageList ==");
    let p = source::get_page_list(&format!("{}/chapter/1", base), base).unwrap();
    println!("  chapterName={} images={}", p.chapter_name, p.images.len());
    for i in &p.images {
        println!("   img {}", i);
    }
    // <img> 命中 >=3 时不触发 script 兜底（与原 JS getPageList 一致）
    assert!(p.images.len() >= 3, "图片数不足: {}", p.images.len());
    assert!(p.chapter_name.contains("第01话"), "章节名解析失败");

    println!("\n== getPageList (script 兜底路径) ==");
    let p2 = source::get_page_list(&format!("{}/scriptonly", base), base).unwrap();
    println!("  script 路径 images={}", p2.images.len());
    for i in &p2.images {
        println!("   img {}", i);
    }

    println!("\n== search ==");
    let s = source::search("test", 1).unwrap_or_default();
    // 注意：search URL 是 smtt6 硬编码，本地 fixture 命中 / 路由，这里只验证不 panic
    println!("  返回 {} 条（本地 fixture 因 URL 硬编码可能为 0，属正常）", s.len());

    println!("\n✅ 解析逻辑验证通过（getDetail + getPageList 断言全过）");
}
