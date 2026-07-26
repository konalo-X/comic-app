// 验证 Phase 3 在线抓取：search + getDetail + getPageList + fetch_image
#[path = "../src/source.rs"]
mod source;

fn main() {
    println!("== 1) 连通性 fetch_html(BASE) ==");
    match source::fetch_html(source::BASE_URL, "") {
        Ok(html) => println!("  OK, HTML {} 字节", html.len()),
        Err(e) => {
            println!("  连接失败: {}（源站可能不稳定/需代理，属已知情况）", e);
        }
    }

    println!("\n== 2) search(\"3D\") ==");
    match source::search("3D", 1) {
        Ok(items) => {
            println!("  返回 {} 条", items.len());
            for it in items.iter().take(3) {
                println!("   - {} | {} | {}", it.title, it.source_url, it.cover);
            }
            // 3) 用第一条做 detail + pagelist
            if let Some(first) = items.first() {
                println!("\n== 3) getDetail({}) ==", first.source_url);
                match source::get_detail(&first.source_url) {
                    Ok(d) => {
                        println!("  title={} 章节数={}", d.title, d.chapters.len());
                        if let Some(ch) = d.chapters.first() {
                            println!("\n== 4) getPageList({}) ==", ch.url);
                            match source::get_page_list(&ch.url, &first.source_url) {
                                Ok(p) => {
                                    println!("  找到 {} 张图, chapterName={}", p.images.len(), p.chapter_name);
                                    if let Some(img) = p.images.first() {
                                        println!("  样例图: {}", img);
                                        println!("\n== 5) fetch_image ==");
                                        match source::fetch_image(img, &ch.url) {
                                            Ok(b) => println!("  下载 {} 字节", b.len()),
                                            Err(e) => println!("  图片下载失败: {}", e),
                                        }
                                    }
                                }
                                Err(e) => println!("  getPageList 失败: {}", e),
                            }
                        }
                    }
                    Err(e) => println!("  getDetail 失败: {}", e),
                }
            }
        }
        Err(e) => println!("  search 失败: {}（源站不稳定属已知）", e),
    }
    println!("\n完成");
}
