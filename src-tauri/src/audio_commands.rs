/*!
音频试听页的后端：列目录、放行资源协议、导出片段、把拖进来的文件拷进去。

# 只认音频

目录树里只列文件夹，右边只列音频 —— 其他文件一概不读。判断靠扩展名，
不去读文件头：一个音效库动辄几千个文件，挨个打开看文件头要慢一个量级，
而这类库里扩展名写错的音频几乎不存在。

# 导出一律走 ffmpeg

裁剪、转格式都交给安装包里自带的那份 ffmpeg，不在前端自己拼 WAV：
前端 WebAudio 解码出来的采样率跟着解码器走，自己编码会悄悄改掉原采样率和位深；
ffmpeg 保留原样，而且 OGG / MP3 本来也只能靠它。

**不裁剪、格式又没变时直接拷文件**，一个字节都不碰 —— 24 位的 WAV 重新编码一遍
就成 16 位了，那是在往用户的素材库里掺次品。
*/
use serde::Serialize;
use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Manager};

/// 认哪些扩展名是音频。aif/wma 浏览器放不了，但照样列出来、照样能拖走
const AUDIO_EXTS: &[&str] = &[
    "wav", "mp3", "ogg", "oga", "flac", "m4a", "aac", "opus", "aif", "aiff", "wma",
];

fn ext_of(p: &Path) -> String {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default()
}

fn is_audio(p: &Path) -> bool {
    AUDIO_EXTS.contains(&ext_of(p).as_str())
}

/// 点开头的、系统隐藏的一律不进树。加整个盘符当工作区时，
/// 「System Volume Information」「$RECYCLE.BIN」这些点进去只会报错
fn is_hidden(name: &str, meta: Option<&std::fs::Metadata>) -> bool {
    if name.starts_with('.') || name.starts_with('$') {
        return true;
    }
    #[cfg(windows)]
    if let Some(m) = meta {
        use std::os::windows::fs::MetadataExt;
        const HIDDEN: u32 = 0x2;
        const SYSTEM: u32 = 0x4;
        if m.file_attributes() & (HIDDEN | SYSTEM) != 0 {
            return true;
        }
    }
    #[cfg(not(windows))]
    let _ = meta;
    false
}

/// 名字里的数字段按数值比：`hit_2` 排在 `hit_10` 前面。
/// 音效库里这种编号到处都是，按字面排会变成 1、10、11、2，找起来要命
fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (a, b) = (a.to_lowercase(), b.to_lowercase());
    let (mut x, mut y) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(c), Some(d)) if c.is_ascii_digit() && d.is_ascii_digit() => {
                let mut na = String::new();
                while let Some(&c) = x.peek().filter(|c| c.is_ascii_digit()) {
                    na.push(c);
                    x.next();
                }
                let mut nb = String::new();
                while let Some(&d) = y.peek().filter(|d| d.is_ascii_digit()) {
                    nb.push(d);
                    y.next();
                }
                let (ta, tb) = (na.trim_start_matches('0'), nb.trim_start_matches('0'));
                let o = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb));
                if o != Ordering::Equal {
                    return o;
                }
            }
            (Some(c), Some(d)) => {
                if c != d {
                    return c.cmp(&d);
                }
                x.next();
                y.next();
            }
        }
    }
}

/// `名字 (1).wav` 这种避重名
fn unique_path(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }
    let dir = path.parent().unwrap_or(Path::new(".")).to_path_buf();
    let stem = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    for i in 1..10000 {
        let c = dir.join(format!("{stem} ({i}){ext}"));
        if !c.exists() {
            return c;
        }
    }
    path
}

// ─── 列目录 ─────────────────────────────────────

#[derive(Serialize)]
pub struct AudioFile {
    name: String,
    path: String,
    size: u64,
    /// 修改时间（毫秒）。前端拿它当波形缓存的版本号：文件改过就重画
    modified: i64,
    /// 相对所选文件夹的子路径。只有「连子文件夹一起列」时才有
    #[serde(skip_serializing_if = "Option::is_none")]
    dir: Option<String>,
}

/// 文件大小 + 修改时间（毫秒）
fn stamp(meta: Option<&std::fs::Metadata>) -> (u64, i64) {
    let size = meta.map(|m| m.len()).unwrap_or(0);
    let modified = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    (size, modified)
}

#[derive(Serialize)]
pub struct SubDir {
    name: String,
    path: String,
}

#[derive(Serialize)]
pub struct Listing {
    dirs: Vec<SubDir>,
    files: Vec<AudioFile>,
}

/// 列出一个文件夹的直接下级：子文件夹 + 音频文件。别的文件不出现
#[tauri::command]
pub async fn audio_list_dir(path: String) -> Result<Listing, String> {
    tokio::task::spawn_blocking(move || {
        let rd = std::fs::read_dir(&path).map_err(|e| format!("读不了这个文件夹: {e}"))?;
        let mut dirs = Vec::new();
        let mut files = Vec::new();
        for ent in rd.flatten() {
            let name = ent.file_name().to_string_lossy().to_string();
            let meta = ent.metadata().ok();
            if is_hidden(&name, meta.as_ref()) {
                continue;
            }
            let p = ent.path();
            let Ok(ft) = ent.file_type() else { continue };
            // 快捷方式式的目录联接（junction / symlink）也当文件夹看
            if ft.is_dir() || (ft.is_symlink() && p.is_dir()) {
                dirs.push(SubDir { name, path: p.to_string_lossy().to_string() });
            } else if is_audio(&p) {
                let (size, modified) = stamp(meta.as_ref());
                files.push(AudioFile { name, path: p.to_string_lossy().to_string(), size, modified, dir: None });
            }
        }
        dirs.sort_by(|a, b| natural_cmp(&a.name, &b.name));
        files.sort_by(|a, b| natural_cmp(&a.name, &b.name));
        Ok(Listing { dirs, files })
    })
    .await
    .map_err(|e| format!("任务出错: {e}"))?
}

/// 递归时最多列这么多个。整个盘挂上来点「含子文件夹」，几十万个文件一次铺开界面就卡死了
const DEEP_LIMIT: usize = 5000;

#[derive(Serialize)]
pub struct DeepListing {
    files: Vec<AudioFile>,
    /// 超过上限，后面的没列出来
    truncated: bool,
}

/// 一个文件夹底下**所有层级**里的音频。每个文件带上它相对这个文件夹的子路径（`dir`）——
/// 列表里要显示「这个在哪一层」，不然一堆同名的 click_001 分不清谁是谁
#[tauri::command]
pub async fn audio_list_deep(path: String) -> Result<DeepListing, String> {
    tokio::task::spawn_blocking(move || {
        let root = PathBuf::from(&path);
        if !root.is_dir() {
            return Err("读不了这个文件夹".to_string());
        }
        let mut files = Vec::new();
        let mut truncated = false;
        let mut stack = vec![root.clone()];
        'walk: while let Some(dir) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            let rel = dir
                .strip_prefix(&root)
                .map(|r| r.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            for ent in rd.flatten() {
                let name = ent.file_name().to_string_lossy().to_string();
                let meta = ent.metadata().ok();
                if is_hidden(&name, meta.as_ref()) {
                    continue;
                }
                let Ok(ft) = ent.file_type() else { continue };
                let p = ent.path();
                // 递归时**不跟**目录联接：两个联接互相指着对方就是个死循环
                if ft.is_dir() {
                    stack.push(p);
                    continue;
                }
                if !ft.is_file() || !is_audio(&p) {
                    continue;
                }
                if files.len() >= DEEP_LIMIT {
                    truncated = true;
                    break 'walk;
                }
                let (size, modified) = stamp(meta.as_ref());
                files.push(AudioFile {
                    name,
                    path: p.to_string_lossy().to_string(),
                    size,
                    modified,
                    dir: Some(rel.clone()),
                });
            }
        }
        files.sort_by(|a, b| {
            natural_cmp(a.dir.as_deref().unwrap_or(""), b.dir.as_deref().unwrap_or(""))
                .then_with(|| natural_cmp(&a.name, &b.name))
        });
        Ok(DeepListing { files, truncated })
    })
    .await
    .map_err(|e| format!("任务出错: {e}"))?
}

/*
    把工作区放进资源协议的白名单。

    试听和画波形都是 webview 直接去读文件（asset:// 协议），而那个协议默认什么都不许读。
    配置里写死不了 —— 工作区在哪要用户加进来才知道，所以按实际加进来的授权。
    和笔记库那边（vault_watch）同一个办法。
*/
#[tauri::command]
pub fn audio_allow_dir(app: AppHandle, path: String) -> Result<(), String> {
    let scope = app.asset_protocol_scope();
    scope.allow_directory(&path, true).map_err(|e| format!("放行失败: {e}"))?;
    // 目录联接的真实路径也放一份：webview 请求时用的可能是解析过的那个
    if let Ok(real) = std::fs::canonicalize(&path) {
        let _ = scope.allow_directory(&real, true);
    }
    Ok(())
}

// ─── 导出片段 ───────────────────────────────────

/// 输出扩展名 → ffmpeg 的编码参数。拿不准的交给 ffmpeg 按扩展名自己挑
fn codec_args(ext: &str) -> Vec<&'static str> {
    match ext {
        "wav" => vec!["-c:a", "pcm_s16le"],
        "ogg" | "oga" => vec!["-c:a", "libvorbis", "-q:a", "5"],
        "mp3" => vec!["-c:a", "libmp3lame", "-q:a", "2"],
        "flac" => vec!["-c:a", "flac"],
        "m4a" | "aac" => vec!["-c:a", "aac", "-b:a", "192k"],
        "opus" => vec!["-c:a", "libopus", "-b:a", "128k"],
        _ => vec![],
    }
}

/// 拖到别的软件里去的那份放哪。**每一份单独一个子文件夹**：
/// 文件名要干净（拖进 Godot 之后就叫这个名字），可同名的片段又不能互相覆盖
fn drag_cache_dir(key: &str) -> PathBuf {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    key.hash(&mut h);
    std::env::temp_dir()
        .join("xgtools-audio")
        .join(format!("{:016x}", h.finish()))
}

/**
 * 导出一段音频，返回生成的文件路径。
 *
 * - `start` / `end`（秒）都给了才裁；不给就是整段
 * - `format`：wav / ogg / mp3 / flac / original（保持原格式）
 * - `dest_dir` 给了就生成到那里（重名自动加编号）；不给就生成到临时目录，给拖出去用
 * - `name`：不带扩展名的文件名，不给就沿用原文件名
 */
#[tauri::command]
pub async fn audio_export(
    app: AppHandle,
    src: String,
    start: Option<f64>,
    end: Option<f64>,
    format: String,
    dest_dir: Option<String>,
    name: Option<String>,
) -> Result<String, String> {
    let src_path = PathBuf::from(&src);
    if !src_path.is_file() {
        return Err("源文件不见了".into());
    }
    let src_ext = ext_of(&src_path);
    let ext = match format.as_str() {
        "original" => src_ext.clone(),
        "wav" | "ogg" | "mp3" | "flac" => format.clone(),
        other => return Err(format!("不认识的格式: {other}")),
    };
    let trim = match (start, end) {
        (Some(s), Some(e)) if e - s > 0.01 => Some((s.max(0.0), e)),
        _ => None,
    };

    let stem = name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| src_path.file_stem().unwrap_or_default().to_string_lossy().to_string());

    let out = match &dest_dir {
        Some(d) => unique_path(PathBuf::from(d).join(format!("{stem}.{ext}"))),
        None => {
            let key = format!("{src}|{trim:?}|{ext}");
            let dir = drag_cache_dir(&key);
            std::fs::create_dir_all(&dir).map_err(|e| format!("建临时目录失败: {e}"))?;
            dir.join(format!("{stem}.{ext}"))
        }
    };

    // 没裁、格式也没变：原样拷过去，不重新编码
    if trim.is_none() && ext == src_ext {
        std::fs::copy(&src_path, &out).map_err(|e| format!("拷贝失败: {e}"))?;
        return Ok(out.to_string_lossy().to_string());
    }

    let ff = crate::record_commands::ffmpeg_path(&app)?;
    let out_str = out.to_string_lossy().to_string();
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-loglevel".into(), "error".into(), "-y".into()];
    if let Some((s, _)) = trim {
        // -ss 放在 -i 前面：直接跳到起点再解码，长文件也快；重新编码时起点是精确的
        args.extend(["-ss".into(), format!("{s:.4}")]);
    }
    args.extend(["-i".into(), src.clone()]);
    if let Some((s, e)) = trim {
        args.extend(["-t".into(), format!("{:.4}", e - s)]);
    }
    // -vn：mp3 里常带一张封面图，那是一路「视频」，转成 wav 会因为装不下它而失败
    args.push("-vn".into());
    args.extend(codec_args(&ext).into_iter().map(String::from));
    args.push(out_str.clone());

    let mut cmd = tokio::process::Command::new(&ff);
    cmd.args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let o = cmd.output().await.map_err(|e| format!("起 ffmpeg 失败: {e}"))?;
    if !o.status.success() {
        let _ = std::fs::remove_file(&out);
        let msg = String::from_utf8_lossy(&o.stderr);
        return Err(format!("生成失败: {}", msg.lines().last().unwrap_or("").trim()));
    }
    Ok(out_str)
}

// ─── 拖进来 / 整理 ──────────────────────────────

#[derive(Serialize)]
pub struct PathKind {
    path: String,
    is_dir: bool,
    is_audio: bool,
}

/// 从资源管理器拖进来的一堆路径：哪些是文件夹、哪些是音频
#[tauri::command]
pub fn audio_classify(paths: Vec<String>) -> Vec<PathKind> {
    paths
        .into_iter()
        .map(|p| {
            let pb = PathBuf::from(&p);
            let is_dir = pb.is_dir();
            let is_audio = !is_dir && is_audio(&pb);
            PathKind { path: p, is_dir, is_audio }
        })
        .collect()
}

/// 把音频文件拷进某个文件夹（重名加编号），返回拷出来的新路径。不是音频的跳过
#[tauri::command]
pub async fn audio_copy_into(paths: Vec<String>, dest_dir: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let dest = PathBuf::from(&dest_dir);
        if !dest.is_dir() {
            return Err("目标文件夹不在了".to_string());
        }
        let mut made = Vec::new();
        for p in paths {
            let src = PathBuf::from(&p);
            if !src.is_file() || !is_audio(&src) {
                continue;
            }
            let Some(fname) = src.file_name() else { continue };
            let out = unique_path(dest.join(fname));
            std::fs::copy(&src, &out).map_err(|e| format!("拷贝失败: {e}"))?;
            made.push(out.to_string_lossy().to_string());
        }
        Ok(made)
    })
    .await
    .map_err(|e| format!("任务出错: {e}"))?
}

/// 路径统一成一个可比较的写法：Windows 不分大小写，正反斜杠混用
fn norm_path(p: &Path) -> String {
    p.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

fn same_path(a: &Path, b: &Path) -> bool {
    norm_path(a) == norm_path(b)
}

/// `p` 是不是在 `dir` 里面（或者就是它）
fn same_or_under(p: &Path, dir: &Path) -> bool {
    let (a, b) = (norm_path(p), norm_path(dir));
    a == b || a.starts_with(&format!("{b}\\"))
}

fn copy_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    if src.is_dir() {
        std::fs::create_dir_all(dst)?;
        for ent in std::fs::read_dir(src)? {
            let ent = ent?;
            copy_all(&ent.path(), &dst.join(ent.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(src, dst).map(|_| ())
    }
}

/**
 * 把一批文件 / 文件夹挪进另一个文件夹，返回每一项挪完之后的路径（和传进来的顺序一一对应）。
 *
 * - 本来就在那个文件夹里的：原样返回，什么都不动
 * - 重名的：自动加编号，**绝不覆盖**用户已有的东西
 * - 同一个盘上是改名，瞬间完成；跨盘改名会失败，那就先拷过去再删原件
 */
#[tauri::command]
pub async fn audio_move(paths: Vec<String>, dest_dir: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let dest = PathBuf::from(&dest_dir);
        if !dest.is_dir() {
            return Err("目标文件夹不在了".to_string());
        }
        let mut out = Vec::with_capacity(paths.len());
        for p in paths {
            let src = PathBuf::from(&p);
            let Some(fname) = src.file_name().map(|f| f.to_os_string()) else {
                out.push(p);
                continue;
            };
            if src.parent().map(|par| same_path(par, &dest)).unwrap_or(false) {
                out.push(p);
                continue;
            }
            if src.is_dir() && same_or_under(&dest, &src) {
                return Err("不能把文件夹挪进它自己里面".to_string());
            }
            let target = unique_path(dest.join(fname));
            match std::fs::rename(&src, &target) {
                Ok(()) => {}
                // 17 = ERROR_NOT_SAME_DEVICE：跨盘了，只能拷
                Err(e) if e.raw_os_error() == Some(17) => {
                    copy_all(&src, &target).map_err(|e| format!("拷贝失败: {e}"))?;
                    let rm = if src.is_dir() { std::fs::remove_dir_all(&src) } else { std::fs::remove_file(&src) };
                    rm.map_err(|e| format!("拷过去了，但原来那份删不掉: {e}"))?;
                }
                Err(e) => return Err(format!("移动失败: {e}")),
            }
            out.push(target.to_string_lossy().to_string());
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("任务出错: {e}"))?
}

/// 文件名里不能有的字符。Windows 的规矩
fn bad_name(name: &str) -> bool {
    let n = name.trim();
    n.is_empty() || n == "." || n == ".." || n.chars().any(|c| "\\/:*?\"<>|".contains(c))
}

/// 新建文件夹，重名自动加编号，返回新路径
#[tauri::command]
pub fn audio_make_dir(parent: String, name: String) -> Result<String, String> {
    if bad_name(&name) {
        return Err("名字里有不能用的字符".into());
    }
    let p = unique_path(PathBuf::from(&parent).join(name.trim()));
    std::fs::create_dir(&p).map_err(|e| format!("新建失败: {e}"))?;
    Ok(p.to_string_lossy().to_string())
}

/// 改名（文件夹或文件都行），返回新路径。**重名直接拒绝**，不悄悄盖掉用户已有的东西
#[tauri::command]
pub fn audio_rename(path: String, new_name: String) -> Result<String, String> {
    if bad_name(&new_name) {
        return Err("名字里有不能用的字符".into());
    }
    let src = PathBuf::from(&path);
    let dst = src.with_file_name(new_name.trim());
    if dst == src {
        return Ok(path);
    }
    // Windows 不分大小写：只改大小写时目标「已存在」其实就是它自己
    let only_case = dst.to_string_lossy().to_lowercase() == src.to_string_lossy().to_lowercase();
    if dst.exists() && !only_case {
        return Err("已经有同名的了".into());
    }
    std::fs::rename(&src, &dst).map_err(|e| format!("改名失败: {e}"))?;
    Ok(dst.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 编号按数值排() {
        let mut v = vec!["hit_10", "hit_2", "Hit_1", "hit_02b", "ambience"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, vec!["ambience", "Hit_1", "hit_2", "hit_02b", "hit_10"]);
    }

    #[test]
    fn 只认音频扩展名() {
        assert!(is_audio(Path::new("a/b/Boom.WAV")));
        assert!(is_audio(Path::new("x.ogg")));
        assert!(!is_audio(Path::new("readme.txt")));
        assert!(!is_audio(Path::new("noext")));
    }

    #[test]
    fn 路径比较不分大小写和斜杠() {
        assert!(same_path(Path::new(r"C:\A\b"), Path::new("c:/a/B/")));
        assert!(same_or_under(Path::new(r"C:\A\b\c"), Path::new(r"c:\a")));
        assert!(!same_or_under(Path::new(r"C:\Ab"), Path::new(r"C:\A")));
    }

    #[test]
    fn 挪动_同层不动_重名加号_不能挪进自己() {
        let base = std::env::temp_dir().join(format!("xg-audio-move-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (a, b) = (base.join("a"), base.join("b"));
        std::fs::create_dir_all(a.join("inner")).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("x.wav"), b"1").unwrap();
        std::fs::write(b.join("x.wav"), b"2").unwrap();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let s = |p: &Path| p.to_string_lossy().to_string();

        // 挪进本来就在的那层：原样返回
        let r = rt.block_on(audio_move(vec![s(&a.join("x.wav"))], s(&a))).unwrap();
        assert_eq!(r, vec![s(&a.join("x.wav"))]);

        // 目标里已有同名：加编号，不覆盖
        let r = rt.block_on(audio_move(vec![s(&a.join("x.wav"))], s(&b))).unwrap();
        assert!(r[0].ends_with("x (1).wav"), "{r:?}");
        assert_eq!(std::fs::read(b.join("x.wav")).unwrap(), b"2");

        // 文件夹不能挪进自己的子文件夹
        assert!(rt.block_on(audio_move(vec![s(&a)], s(&a.join("inner")))).is_err());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn 坏名字拦下来() {
        assert!(bad_name(""));
        assert!(bad_name("a/b"));
        assert!(bad_name("what?"));
        assert!(!bad_name("爆炸音效 01"));
    }
}
