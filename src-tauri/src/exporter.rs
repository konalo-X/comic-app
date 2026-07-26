// EPUB / CBZ 导出器（移植 comic-app/electron/exporter.js）
// CBZ：zip 打包图片，命名 ch{章:03}_{页:04}.webp 保证全局顺序
// EPUB：mimetype + META-INF/container.xml + EPUB/{css,images,chapters,nav,toc,content.opf}
use crate::paths;
use std::io::Write;
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;

pub struct ExportChapter {
    pub name: String,
    pub dir: PathBuf,
}

fn list_images_sorted(dir: &Path) -> Vec<PathBuf> {
    paths::list_chapter_images(dir)
}

/// 导出 CBZ
pub fn to_cbz(
    source_dir: &Path,
    output_path: &Path,
    chapters: &[ExportChapter],
) -> Result<usize, String> {
    let file = std::fs::File::create(output_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut count = 0usize;

    let cover = source_dir.join("cover.webp");
    if cover.exists() {
        if let Ok(data) = std::fs::read(&cover) {
            zip.start_file("cover.webp", opts).map_err(|e| e.to_string())?;
            zip.write_all(&data).map_err(|e| e.to_string())?;
            count += 1;
        }
    }

    for (i, ch) in chapters.iter().enumerate() {
        if !ch.dir.exists() {
            continue;
        }
        let files = list_images_sorted(&ch.dir);
        for (j, f) in files.iter().enumerate() {
            if let Ok(data) = std::fs::read(f) {
                let name = format!("ch{:03}_{:04}.webp", i + 1, j + 1);
                zip.start_file(name, opts).map_err(|e| e.to_string())?;
                zip.write_all(&data).map_err(|e| e.to_string())?;
                count += 1;
            }
        }
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(count)
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn container_xml() -> &'static str {
    r#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="EPUB/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#
}

fn css_content() -> &'static str {
    "html,body{margin:0;padding:0;background:#111;}\nimg{display:block;width:100%;height:auto;margin:0 auto;}\n"
}

/// 导出 EPUB（单卷，所有章节合并到 all-pages.xhtml，锚点分隔）
pub fn to_epub(
    source_dir: &Path,
    output_path: &Path,
    title: &str,
    author: &str,
    chapters: &[ExportChapter],
) -> Result<usize, String> {
    let file = std::fs::File::create(output_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let stored = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    // mimetype 必须第一个且 stored（不压缩）
    zip.start_file("mimetype", stored).map_err(|e| e.to_string())?;
    zip.write_all(b"application/epub+zip").map_err(|e| e.to_string())?;

    zip.start_file("META-INF/container.xml", deflated).map_err(|e| e.to_string())?;
    zip.write_all(container_xml().as_bytes()).map_err(|e| e.to_string())?;

    zip.start_file("EPUB/css/style.css", deflated).map_err(|e| e.to_string())?;
    zip.write_all(css_content().as_bytes()).map_err(|e| e.to_string())?;

    let mut manifest: Vec<String> = Vec::new();
    let mut spine: Vec<String> = Vec::new();
    let mut nav_points: Vec<(String, String)> = Vec::new();
    let mut img_count = 0usize;

    manifest.push(r#"<item id="css" href="css/style.css" media-type="text/css"/>"#.to_string());

    // 封面
    let mut cover_added = false;
    let cover = source_dir.join("cover.webp");
    if cover.exists() {
        if let Ok(data) = std::fs::read(&cover) {
            zip.start_file("EPUB/images/cover.webp", deflated).map_err(|e| e.to_string())?;
            zip.write_all(&data).map_err(|e| e.to_string())?;
            manifest.push(
                r#"<item id="cover" href="images/cover.webp" media-type="image/webp"/>"#.to_string(),
            );
            cover_added = true;
        }
    }

    // 章节图片 + 合并 xhtml body
    let mut body = String::new();
    for (i, ch) in chapters.iter().enumerate() {
        if !ch.dir.exists() {
            continue;
        }
        let files = list_images_sorted(&ch.dir);
        if files.is_empty() {
            continue;
        }
        let folder = ch
            .dir
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("{}", i + 1));
        body.push_str(&format!("<div id=\"ch_{}\"></div>\n", i));
        nav_points.push((format!("ch_{}", i), xml_escape(&ch.name)));
        for (j, f) in files.iter().enumerate() {
            if let Ok(data) = std::fs::read(f) {
                let img_name = format!("{}_{:03}.webp", paths::sanitize_filename(&folder), j + 1);
                zip.start_file(format!("EPUB/images/{}", img_name), deflated)
                    .map_err(|e| e.to_string())?;
                zip.write_all(&data).map_err(|e| e.to_string())?;
                manifest.push(format!(
                    r#"<item id="img-{}-{}" href="images/{}" media-type="image/webp"/>"#,
                    i, j, img_name
                ));
                body.push_str(&format!("<img src=\"../images/{}\"/>\n", img_name));
                img_count += 1;
            }
        }
    }

    // all-pages.xhtml
    let xhtml = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/>
<title>{}</title><link rel="stylesheet" type="text/css" href="../css/style.css"/></head>
<body>
{}
</body></html>"#,
        xml_escape(title),
        body
    );
    zip.start_file("EPUB/chapters/all-pages.xhtml", deflated).map_err(|e| e.to_string())?;
    zip.write_all(xhtml.as_bytes()).map_err(|e| e.to_string())?;
    manifest.push(
        r#"<item id="all-pages" href="chapters/all-pages.xhtml" media-type="application/xhtml+xml"/>"#
            .to_string(),
    );
    spine.push(r#"<itemref idref="all-pages"/>"#.to_string());

    // nav.xhtml
    let nav_lis: String = nav_points
        .iter()
        .map(|(id, label)| {
            format!(
                "<li><a href=\"chapters/all-pages.xhtml#{}\">{}</a></li>",
                id, label
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let nav = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><meta charset="utf-8"/><title>{}</title></head>
<body><nav epub:type="toc"><h1>目录</h1><ol>{}</ol></nav></body></html>"#,
        xml_escape(title),
        nav_lis
    );
    zip.start_file("EPUB/nav.xhtml", deflated).map_err(|e| e.to_string())?;
    zip.write_all(nav.as_bytes()).map_err(|e| e.to_string())?;
    manifest.push(r#"<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>"#.to_string());

    // toc.ncx
    let isbn = format!("comic_{}", paths::sanitize_filename(title));
    let nav_pts: String = nav_points
        .iter()
        .enumerate()
        .map(|(n, (id, label))| {
            format!(
                r#"<navPoint id="np_{}" playOrder="{}"><navLabel><text>{}</text></navLabel><content src="chapters/all-pages.xhtml#{}"/></navPoint>"#,
                n, n + 1, label, id
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let ncx = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="{}"/></head>
<docTitle><text>{}</text></docTitle>
<navMap>{}</navMap></ncx>"#,
        isbn,
        xml_escape(title),
        nav_pts
    );
    zip.start_file("EPUB/toc.ncx", deflated).map_err(|e| e.to_string())?;
    zip.write_all(ncx.as_bytes()).map_err(|e| e.to_string())?;
    manifest.push(r#"<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>"#.to_string());

    // content.opf
    let cover_meta = if cover_added {
        r#"<meta name="cover" content="cover"/>"#
    } else {
        ""
    };
    let opf = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">{}</dc:identifier>
<dc:title>{}</dc:title>
<dc:creator>{}</dc:creator>
<dc:language>zh-CN</dc:language>
{}
</metadata>
<manifest>
{}
</manifest>
<spine toc="ncx">
{}
</spine>
</package>"#,
        isbn,
        xml_escape(title),
        xml_escape(author),
        cover_meta,
        manifest.join("\n"),
        spine.join("\n")
    );
    zip.start_file("EPUB/content.opf", deflated).map_err(|e| e.to_string())?;
    zip.write_all(opf.as_bytes()).map_err(|e| e.to_string())?;

    zip.finish().map_err(|e| e.to_string())?;
    Ok(img_count)
}
