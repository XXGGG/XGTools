//! 往笔记里塞图片：存进附件目录，返回一条相对路径给编辑器插进正文。
//!
//! # 两条入口
//!
//! 粘贴走 base64（剪贴板里只有像素，没有文件），从资源管理器拖进来走文件路径
//! （那边本来就有现成的文件，再编码一遍纯属浪费）。
//!
//! # 为什么不让前端自己拼文件名
//!
//! 撞名要加序号，而「查一下在不在 → 不在就写」这两步之间隔着一次 IPC 往返，
//! 连着粘两张图就可能挑中同一个名字，后写的把先写的盖掉。放在这边一次做完，
//! 中间没有缝。

use std::path::{Path, PathBuf};

use base64::Engine;

/// 允许的图片后缀。不在表里的一律当 `.png` ——
/// 后缀是给系统看的，写个乱七八糟的进去只会让图打不开。
const KNOWN: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"];

fn ext_of(name: &str) -> String {
    name.rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .filter(|e| KNOWN.contains(&e.as_str()))
        .unwrap_or_else(|| "png".to_string())
}

/// 在 `dir` 下挑一个没被占用的名字。
///
/// 名字本身由调用方给（前端按时间戳生成，人看得懂也不容易撞），
/// 这里只负责在真撞上的时候加序号。
fn pick_name(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let mut p = dir.join(format!("{stem}.{ext}"));
    let mut i = 1;
    while p.exists() {
        i += 1;
        p = dir.join(format!("{stem}-{i}.{ext}"));
    }
    p
}

/// 把附件目录准备好，返回它的绝对路径。
///
/// `dir_rel` 是相对库根的，空串就是库根本身。**必须挡在库里面**：
/// 它来自设置项，用户可以随便填，填个 `../../` 就把文件写到库外面去了。
fn ensure_dir(root: &str, dir_rel: &str) -> Result<(PathBuf, PathBuf), String> {
    let root_real = PathBuf::from(root)
        .canonicalize()
        .map_err(|e| format!("工作区不可用: {e}"))?;
    let mut dir = root_real.clone();
    for seg in dir_rel.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return Err("附件目录不能跑到库外面".into());
        }
        dir.push(seg);
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("建附件目录失败: {e}"))?;
    Ok((root_real, dir))
}

fn rel_of(root_real: &Path, p: &Path) -> String {
    p.strip_prefix(root_real)
        .map(|r| r.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| p.to_string_lossy().to_string())
}

/// 粘贴进来的图：base64 → 文件。返回相对库根的路径。
/// 把图转成 WebP。转不动就返回 None，调用方拿到 None 就存原图。
///
/// # 为什么值得转
///
/// 手机截图动辄 3~5MB PNG，转成 WebP 常常小十倍，而肉眼看不出差别。
/// 一个库里攒几百张图，这个差距就是好几个 G。
///
/// # 为什么不无脑转
///
/// - **GIF 不碰**：动图转过去只会剩第一帧。
/// - **SVG 不碰**：它是矢量的，转成位图纯属倒退。
/// - **转完反而更大就不要**：本来就压得很好的小图（纯色图标之类）会这样，
///   那就老老实实存原图。
fn to_webp(bytes: &[u8], ext: &str) -> Option<Vec<u8>> {
    if matches!(ext, "gif" | "svg" | "webp") {
        return None;
    }
    let img = image::load_from_memory(bytes).ok()?;
    let mut out = Vec::new();
    // image 0.25 自带的 webp 编码器只有无损。有损要另外背一个 libwebp 的 C 依赖，
    // 而无损 webp 对截图这类大色块的图已经小很多了，不值得为此加依赖。
    let enc = image::codecs::webp::WebPEncoder::new_lossless(&mut out);
    img.write_with_encoder(enc).ok()?;
    if out.len() >= bytes.len() {
        return None;
    }
    Some(out)
}

#[tauri::command]
pub fn vault_attach_bytes(
    root: String,
    dir_rel: String,
    stem: String,
    ext: String,
    data_b64: String,
    to_webp_on: bool,
) -> Result<String, String> {
    let (root_real, dir) = ensure_dir(&root, &dir_rel)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| format!("图片数据解不开: {e}"))?;
    let mut ext = ext_of(&format!("x.{ext}"));
    let mut data = bytes;
    if to_webp_on {
        if let Some(w) = to_webp(&data, &ext) {
            data = w;
            ext = "webp".to_string();
        }
    }
    let target = pick_name(&dir, &stem, &ext);
    std::fs::write(&target, &data).map_err(|e| format!("写附件失败: {e}"))?;
    Ok(rel_of(&root_real, &target))
}

/// 从外面拖进来的图：复制一份进附件目录。返回相对库根的路径。
///
/// 是复制不是移动 —— 那是用户自己的文件，还在原地放着，
/// 我们没有理由替他从桌面上搬走。
#[tauri::command]
pub fn vault_attach_file(
    root: String,
    dir_rel: String,
    stem: String,
    src: String,
    to_webp_on: bool,
) -> Result<String, String> {
    let (root_real, dir) = ensure_dir(&root, &dir_rel)?;
    let src_path = PathBuf::from(&src);
    let name = src_path
        .file_name()
        .ok_or("源文件没有名字")?
        .to_string_lossy()
        .to_string();
    if to_webp_on {
        if let Ok(bytes) = std::fs::read(&src_path) {
            if let Some(w) = to_webp(&bytes, &ext_of(&name)) {
                let target = pick_name(&dir, &stem, "webp");
                std::fs::write(&target, &w).map_err(|e| format!("写附件失败: {e}"))?;
                return Ok(rel_of(&root_real, &target));
            }
        }
    }
    let target = pick_name(&dir, &stem, &ext_of(&name));
    std::fs::copy(&src_path, &target).map_err(|e| format!("复制附件失败: {e}"))?;
    Ok(rel_of(&root_real, &target))
}

/// 一张没人引用的图。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanImage {
    /// 相对库根的路径
    pub rel: String,
    pub size: u64,
}

/// 这个文件里有没有可能引用图片。只扫这些后缀，别去啃二进制。
fn is_text_note(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.ends_with(".md")
        || n.ends_with(".canvas")
        || n.ends_with(".base")
        || n.ends_with(".excalidraw")
}

fn is_image(name: &str) -> bool {
    name.rsplit_once('.')
        .map(|(_, e)| KNOWN.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        // 隐藏目录一律跳过：`.trash` 里的东西已经算删掉了，
        // 拿它里面的笔记去「证明某张图还有人用」只会让垃圾图永远清不掉
        if name.starts_with('.') {
            continue;
        }
        let p = e.path();
        if p.is_dir() {
            walk(&p, out);
        } else {
            out.push(p);
        }
    }
}

/// 找出没有任何笔记引用的图片。
///
/// # 匹配为什么这么松
///
/// 引用图片的写法太多了：`![](a.png)`、`![[a.png]]`、HTML 的 `<img src="a.png">`、
/// frontmatter 里的 `banner: a.png`、canvas 和 excalidraw 内部的 JSON 字段……
/// 一种一种去解析，漏掉任何一种都意味着**误删一张还在用的图**。
///
/// 所以这里反过来做：把每篇笔记当纯文本，只问「文件名在不在里面」。
/// 这会把「正文里恰好提到了这个文件名但没真的引用」也算成在用 —— 那是故意的。
/// 少清掉一张垃圾图只是浪费几百 KB，误删一张在用的图是数据丢失，
/// 两种错误的代价差着量级。
#[tauri::command]
pub fn vault_find_orphan_images(root: String, dir_rel: String) -> Result<Vec<OrphanImage>, String> {
    let root_real = PathBuf::from(&root)
        .canonicalize()
        .map_err(|e| format!("工作区不可用: {e}"))?;

    let mut files = Vec::new();
    walk(&root_real, &mut files);

    // 先把所有笔记正文拼成一大块，之后每张图只查一次
    let mut haystack = String::new();
    for f in &files {
        let name = f.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        if is_text_note(&name) {
            if let Ok(t) = std::fs::read_to_string(f) {
                haystack.push_str(&t);
                haystack.push('\n');
            }
        }
    }

    // 只在附件目录里找孤儿：用户自己摆在别处的图不归我们管，
    // 那可能是他有意放在那儿的素材
    let sub = dir_rel.trim().trim_matches('/').to_string();
    let mut out = Vec::new();
    for f in &files {
        let name = f.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        if !is_image(&name) {
            continue;
        }
        let rel = rel_of(&root_real, f);
        if !sub.is_empty() && !rel.split('/').any(|seg| seg == sub) {
            continue;
        }
        // 连 URL 编码过的写法一起查（空格会被写成 %20）
        let encoded = name.replace(' ', "%20");
        if haystack.contains(&name) || haystack.contains(&encoded) {
            continue;
        }
        out.push(OrphanImage {
            rel,
            size: std::fs::metadata(f).map(|m| m.len()).unwrap_or(0),
        });
    }
    out.sort_by(|a, b| b.size.cmp(&a.size));
    Ok(out)
}
