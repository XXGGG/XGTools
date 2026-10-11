//! 给文件夹换图标。
//!
//! # Windows 是怎么认文件夹图标的
//!
//! 文件夹里放一个隐藏的 `desktop.ini`,里面写 `IconResource=xxx.ico,0`,
//! 再把**文件夹本身**标成「只读」,资源管理器才会去读这份 ini ——
//! 少了最后一步,图标不会换(这是 Windows 的老规矩)。
//!
//! 所以「应用」= 写 ico + 写(或改)desktop.ini + 三处属性;
//! 「恢复」= 把这些反着做一遍,并且**只删我们自己写的那几行**,
//! 文件夹原来的 desktop.ini 里有别的内容(比如本地化名称)要留着。
//!
//! 设属性用系统自带的 `attrib`,不为这点事再给 windows crate 开新的 feature。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// ico 放在文件夹里的文件名前缀。
///
/// # 为什么每次都换一个名字
///
/// Explorer 的图标缓存是按「路径 + 序号」记的:文件名不变,它就当图标没变,
/// 重新套了别的设计、甚至按 F5 / 通知系统都可能不更新。
/// 每次应用和刷新都换成一个带时间戳的新名字,对它来说就是从没见过的图标,当场重新读。
const ICON_PREFIX: &str = "folder_icon";

fn new_icon_name() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{ICON_PREFIX}_{ms}.ico")
}

/// 是不是我们写的 ico:老版本的 folder_icon.ico,或者 folder_icon_<数字>.ico
fn is_our_icon(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    if n == "folder_icon.ico" {
        return true;
    }
    n.strip_prefix("folder_icon_")
        .and_then(|r| r.strip_suffix(".ico"))
        .is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
}

/// 删掉文件夹里所有我们写的 ico(新旧命名都认)
fn remove_our_icons(dir: &Path) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if is_our_icon(&name) {
            let p = e.path();
            unlock(&p);
            let _ = fs::remove_file(p);
        }
    }
}

/// 在 desktop.ini 文本里换上(或加上)IconResource,别的内容原样留着
fn ini_with_icon(old: &str, name: &str) -> String {
    let mut lines: Vec<String> = old.lines().filter(|l| !is_icon_key(l)).map(|s| s.to_string()).collect();
    let icon_line = format!("IconResource={name},0");
    match lines.iter().position(|l| l.trim().eq_ignore_ascii_case("[.ShellClassInfo]")) {
        Some(i) => lines.insert(i + 1, icon_line),
        None => {
            lines.insert(0, "[.ShellClassInfo]".to_string());
            lines.insert(1, icon_line);
        }
    }
    lines.join("\r\n") + "\r\n"
}

/// desktop.ini 里的 IconResource 如果指向我们自己的 ico(相对路径),返回文件名
fn our_icon_in_ini(text: &str) -> Option<String> {
    for line in text.lines() {
        let t = line.trim();
        if t.to_ascii_lowercase().starts_with("iconresource=") {
            let v = t["iconresource=".len()..].split(',').next().unwrap_or("").trim();
            if !v.contains('\\') && !v.contains('/') && is_our_icon(v) {
                return Some(v.to_string());
            }
        }
    }
    None
}

fn run_quiet(program: &str, args: &[&std::ffi::OsStr]) {
    let mut cmd = Command::new(program);
    cmd.args(args);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let _ = cmd.status();
}

fn attrib(flags: &[&str], path: &Path) {
    let mut args: Vec<&std::ffi::OsStr> = flags.iter().map(|f| std::ffi::OsStr::new(*f)).collect();
    args.push(path.as_os_str());
    run_quiet("attrib", &args);
}

// 通知资源管理器「这个文件夹变了」。F5 有时刷不动,是因为 Explorer 手里的图标缓存
// 还当它没变;直接发 SHChangeNotify 是 Windows 给的正门,比重启资源管理器温和得多。
#[cfg(windows)]
mod shell {
    use std::ffi::c_void;
    #[link(name = "shell32")]
    extern "system" {
        pub fn SHChangeNotify(event: i32, flags: u32, item1: *const c_void, item2: *const c_void);
    }
}

const SHCNE_ASSOCCHANGED: i32 = 0x0800_0000;
const SHCNE_ATTRIBUTES: i32 = 0x0000_0800;
const SHCNE_UPDATEDIR: i32 = 0x0000_1000;
const SHCNE_UPDATEITEM: i32 = 0x0000_2000;
const SHCNF_IDLIST: u32 = 0x0000;
const SHCNF_PATHW: u32 = 0x0005;
const SHCNF_FLUSH: u32 = 0x1000;

#[cfg(windows)]
fn notify_path(event: i32, path: &Path) {
    use std::os::windows::ffi::OsStrExt;
    let w: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    // SAFETY: w 以 0 结尾且在调用期间一直活着;SHCNF_PATHW 要的正是这种宽字符路径
    unsafe { shell::SHChangeNotify(event, SHCNF_PATHW | SHCNF_FLUSH, w.as_ptr().cast(), std::ptr::null()) };
}

#[cfg(not(windows))]
fn notify_path(_event: i32, _path: &Path) {}

/// 让整个系统重读图标缓存(等于「文件关联变了」)
#[cfg(windows)]
fn notify_all() {
    // SAFETY: 两个指针都是 null,这个事件不带路径
    unsafe { shell::SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST | SHCNF_FLUSH, std::ptr::null(), std::ptr::null()) };
}

#[cfg(not(windows))]
fn notify_all() {}

/// 单个文件夹:把它自己和它所在的目录都通知一遍
fn notify_folder(dir: &Path) {
    notify_path(SHCNE_ATTRIBUTES, dir);
    notify_path(SHCNE_UPDATEITEM, dir);
    notify_path(SHCNE_UPDATEDIR, dir);
    if let Some(parent) = dir.parent() {
        notify_path(SHCNE_UPDATEDIR, parent);
    }
}

/// 让资源管理器重读图标缓存。尽力而为,失败了用户按 F5 也行
fn refresh_shell(dir: &Path) {
    notify_folder(dir);
    notify_all();
    run_quiet("ie4uinit.exe", &[std::ffi::OsStr::new("-show")]);
}

/// desktop.ini 可能是 UTF-16(带 BOM)、UTF-8,老的还有 GBK
fn read_ini(path: &Path) -> String {
    let Ok(bytes) = fs::read(path) else { return String::new() };
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let u: Vec<u16> = bytes[2..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        return String::from_utf16_lossy(&u);
    }
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
    match std::str::from_utf8(body) {
        Ok(s) => s.to_string(),
        Err(_) => encoding_rs::GBK.decode(body).0.into_owned(),
    }
}

/// 一律写成 UTF-16 LE + BOM,资源管理器对它最稳,中文名称也不会丢
fn write_ini(path: &Path, text: &str) -> std::io::Result<()> {
    let mut out: Vec<u8> = vec![0xFF, 0xFE];
    for u in text.encode_utf16() {
        out.extend_from_slice(&u.to_le_bytes());
    }
    fs::write(path, out)
}

fn is_icon_key(line: &str) -> bool {
    let k = line.trim().to_ascii_lowercase();
    k.starts_with("iconresource=") || k.starts_with("iconfile=") || k.starts_with("iconindex=")
}

fn unlock(path: &Path) {
    if path.exists() {
        attrib(&["-h", "-s", "-r"], path);
    }
}

fn folder_of(folder: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(folder);
    if !p.is_dir() {
        return Err(format!("不是文件夹:{folder}"));
    }
    Ok(p)
}

/// 把 ico 写进文件夹并设为它的图标。返回 ico 的路径
#[tauri::command]
pub fn apply_folder_icon(folder: String, ico: Vec<u8>) -> Result<String, String> {
    let dir = folder_of(&folder)?;
    let ini_path = dir.join("desktop.ini");

    unlock(&ini_path);
    // 上一次应用留下的 ico 删掉,每个文件夹里始终只有最新的一个
    remove_our_icons(&dir);

    let ico_path = dir.join(new_icon_name());
    fs::write(&ico_path, &ico).map_err(|e| format!("写图标文件失败:{e}"))?;

    // 原来的 desktop.ini 里别的内容留着,只换我们管的那几行
    let name = ico_path.file_name().unwrap().to_string_lossy().into_owned();
    let text = ini_with_icon(&read_ini(&ini_path), &name);
    write_ini(&ini_path, &text).map_err(|e| format!("写 desktop.ini 失败:{e}"))?;

    attrib(&["+h", "+s"], &ini_path);
    attrib(&["+h", "+s"], &ico_path);
    attrib(&["+r"], &dir);
    refresh_shell(&dir);
    Ok(ico_path.to_string_lossy().into_owned())
}

/// 把文件夹的图标还原成系统默认。只动我们写的东西
#[tauri::command]
pub fn reset_folder_icon(folder: String) -> Result<(), String> {
    let dir = folder_of(&folder)?;
    let ini_path = dir.join("desktop.ini");

    if ini_path.exists() {
        unlock(&ini_path);
        let kept: Vec<String> = read_ini(&ini_path).lines().filter(|l| !is_icon_key(l)).map(|s| s.to_string()).collect();
        // 只剩段标题和空行 = 没有别的内容了,整份删掉
        let has_content = kept.iter().any(|l| {
            let t = l.trim();
            !t.is_empty() && !t.eq_ignore_ascii_case("[.ShellClassInfo]")
        });
        if has_content {
            write_ini(&ini_path, &(kept.join("\r\n") + "\r\n")).map_err(|e| format!("改 desktop.ini 失败:{e}"))?;
            attrib(&["+h", "+s"], &ini_path);
        } else {
            let _ = fs::remove_file(&ini_path);
            // 文件夹只读标记是我们为了让图标生效加的;ini 没了,标记也没用了
            attrib(&["-r"], &dir);
        }
    }
    remove_our_icons(&dir);
    refresh_shell(&dir);
    Ok(())
}

/// 强制刷新:图标已经换了,但资源管理器还显示旧的时用。
///
/// 对每个传进来的文件夹:把我们的 ico **改一个新名字**并同步改 desktop.ini
/// (这才是真正让 Explorer 重新读的办法,见 ICON_PREFIX 的说明),再摘掉又戴上
/// 「只读」标记、通知系统;最后做一次全局的图标缓存刷新。
///
/// 返回「ini 里写着我们的 ico,但文件已经不见了」的文件夹,这种只能重新应用。
#[tauri::command]
pub fn refresh_icons(folders: Vec<String>) -> Result<Vec<String>, String> {
    let mut missing = Vec::new();
    for f in &folders {
        let dir = PathBuf::from(f);
        if !dir.is_dir() {
            continue;
        }
        let ini_path = dir.join("desktop.ini");
        if ini_path.exists() {
            let text = read_ini(&ini_path);
            if let Some(old_name) = our_icon_in_ini(&text) {
                let old_path = dir.join(&old_name);
                if old_path.exists() {
                    let new_name = new_icon_name();
                    let new_path = dir.join(&new_name);
                    unlock(&old_path);
                    unlock(&ini_path);
                    let cur = if fs::rename(&old_path, &new_path).is_ok() {
                        let _ = write_ini(&ini_path, &ini_with_icon(&text, &new_name));
                        new_path
                    } else {
                        old_path
                    };
                    attrib(&["+h", "+s"], &cur);
                    attrib(&["+h", "+s"], &ini_path);
                } else {
                    missing.push(f.clone());
                }
            }
            attrib(&["-r"], &dir);
            attrib(&["+r"], &dir);
        }
        notify_folder(&dir);
    }
    notify_all();
    run_quiet("ie4uinit.exe", &[std::ffi::OsStr::new("-show")]);
    Ok(missing)
}
