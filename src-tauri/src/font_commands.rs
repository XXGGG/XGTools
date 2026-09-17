//! 字体库：接管本机字体、协议体检、推荐安装、查缺字。
//!
//! # 接管 = 直接管注册表里那张「字体」表
//!
//! Windows 装字体就两件事：文件放好，再在注册表「字体」那张表里记一笔（项名 → 文件路径）。
//! 装给全机的记在 HKLM（要管理员），装给自己的记在 HKCU。所以「接管」不用像 XGCut 那样
//! 把字体搬进自己的目录，直接管 HKCU 那一层就行：
//!
//! - **停用**：注册表那一笔先记进我们自己的清单，再从注册表撤掉。文件原地不动，
//!   PS、剪映下次打开就看不到它；启用就原样写回去
//! - **卸载**：撤注册，再把文件挪进我们的回收区。反悔了一键恢复，文件和注册表一起回去
//! - HKLM 那一层（Windows 自带的、装给全机的）只看不动 —— 动它要管理员权限
//!
//! # 回收区为什么不直接用系统回收站
//!
//! 从系统回收站还原只能还原文件，注册表那一笔回不来，字体等于没装。
//! 我们自己的回收区记着每个文件原来的注册项，恢复时一起写回去。
//! 「清空回收区」才把文件交给系统回收站，那一步还有 Windows 兜底。

use crate::font_catalog::{self, Pack};
use crate::font_license::{self, Verdict};
use crate::font_sfnt::{self, FaceInfo};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

// ─── 位置 ───────────────────────────────────────

fn local_appdata() -> PathBuf {
    std::env::var("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir())
}

/// 字体库装的字体：每款一个子目录，目录名就是推荐目录里的 id
fn our_root() -> PathBuf {
    local_appdata().join("XGTools").join("fonts")
}

fn xgcut_root() -> PathBuf {
    local_appdata().join("XGCut").join("fonts")
}

fn trash_root() -> PathBuf {
    local_appdata().join("XGTools").join("font-trash")
}

fn disabled_path() -> PathBuf {
    local_appdata().join("XGTools").join("font-disabled.json")
}

/// Windows 自己「为当前用户安装」时放字体的地方
fn user_fonts_dir() -> PathBuf {
    local_appdata().join("Microsoft").join("Windows").join("Fonts")
}

fn windows_fonts_dir() -> PathBuf {
    std::env::var("WINDIR")
        .or_else(|_| std::env::var("SystemRoot"))
        .map(|w| PathBuf::from(w).join("Fonts"))
        .unwrap_or_else(|_| PathBuf::from(r"C:\Windows\Fonts"))
}

/// 路径比较用：统一斜杠、统一小写
fn norm(p: &Path) -> String {
    p.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

fn under(p: &Path, root: &Path) -> bool {
    norm(p).starts_with(&format!("{}\\", norm(root)))
}

/// 注册表里偶尔有 REG_EXPAND_SZ 写成 %LOCALAPPDATA%\... 的，展开成真路径
fn expand(s: &str) -> String {
    let mut out = s.to_string();
    for var in ["LOCALAPPDATA", "APPDATA", "USERPROFILE", "WINDIR", "SystemRoot", "ProgramFiles"] {
        let Ok(val) = std::env::var(var) else { continue };
        let pat = format!("%{}%", var.to_lowercase());
        while let Some(i) = out.to_lowercase().find(&pat) {
            out.replace_range(i..i + pat.len(), &val);
        }
    }
    out
}

/// 界面上显示的路径：用户名那段换成 %LOCALAPPDATA%，截图发出去不漏隐私
fn display_path(p: &Path) -> String {
    let full = p.to_string_lossy().to_string();
    match std::env::var("LOCALAPPDATA") {
        Ok(base) if norm(p).starts_with(&base.to_lowercase()) => {
            format!("%LOCALAPPDATA%{}", &full[base.len()..])
        }
        _ => full,
    }
}

// ─── 注册表 ─────────────────────────────────────

/// 注册表「字体」表里的一笔：项名 → 文件路径（HKLM 里常常只写文件名）
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RegItem {
    pub name: String,
    pub data: String,
}

#[cfg(windows)]
mod reg {
    use super::RegItem;
    use std::ptr::null_mut;
    use winapi::shared::minwindef::{DWORD, HKEY};
    use winapi::um::winnt::{KEY_READ, KEY_SET_VALUE, REG_EXPAND_SZ, REG_SZ};
    use winapi::um::winreg::{
        RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegEnumValueW, RegOpenKeyExW, RegSetValueExW,
        HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE,
    };

    const KEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts";
    const ERROR_NO_MORE_ITEMS: i32 = 259;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    pub fn values(machine: bool) -> Vec<RegItem> {
        let hive = if machine { HKEY_LOCAL_MACHINE } else { HKEY_CURRENT_USER };
        let sub = wide(KEY);
        let mut key: HKEY = null_mut();
        let mut out = vec![];
        unsafe {
            if RegOpenKeyExW(hive, sub.as_ptr(), 0, KEY_READ, &mut key) != 0 {
                return out;
            }
            let mut i: DWORD = 0;
            loop {
                let mut name = vec![0u16; 1024];
                let mut nlen = name.len() as DWORD;
                let mut data = vec![0u16; 2048];
                let mut dlen = (data.len() * 2) as DWORD;
                let mut kind: DWORD = 0;
                let r = RegEnumValueW(
                    key, i, name.as_mut_ptr(), &mut nlen, null_mut(), &mut kind,
                    data.as_mut_ptr() as *mut u8, &mut dlen,
                );
                if r == ERROR_NO_MORE_ITEMS {
                    break;
                }
                i += 1;
                if r != 0 || (kind != REG_SZ && kind != REG_EXPAND_SZ) {
                    continue;
                }
                let n = String::from_utf16_lossy(&name[..nlen as usize]);
                let d = String::from_utf16_lossy(&data[..(dlen as usize / 2).min(data.len())])
                    .trim_end_matches('\0')
                    .to_string();
                out.push(RegItem { name: n, data: d });
            }
            RegCloseKey(key);
        }
        out
    }

    pub fn set(item: &RegItem) -> Result<(), String> {
        let sub = wide(KEY);
        let mut key: HKEY = null_mut();
        unsafe {
            let r = RegCreateKeyExW(
                HKEY_CURRENT_USER, sub.as_ptr(), 0, null_mut(), 0, KEY_SET_VALUE, null_mut(), &mut key,
                null_mut(),
            );
            if r != 0 {
                return Err(format!("打不开注册表（错误 {r}）"));
            }
            let n = wide(&item.name);
            let d = wide(&item.data);
            let r = RegSetValueExW(key, n.as_ptr(), 0, REG_SZ, d.as_ptr() as *const u8, (d.len() * 2) as DWORD);
            RegCloseKey(key);
            if r != 0 {
                return Err(format!("写注册表失败（错误 {r}）"));
            }
        }
        Ok(())
    }

    pub fn delete(name: &str) {
        let sub = wide(KEY);
        let mut key: HKEY = null_mut();
        unsafe {
            if RegOpenKeyExW(HKEY_CURRENT_USER, sub.as_ptr(), 0, KEY_SET_VALUE, &mut key) == 0 {
                let n = wide(name);
                RegDeleteValueW(key, n.as_ptr());
                RegCloseKey(key);
            }
        }
    }
}

#[cfg(not(windows))]
mod reg {
    use super::RegItem;
    pub fn values(_machine: bool) -> Vec<RegItem> {
        vec![]
    }
    pub fn set(_item: &RegItem) -> Result<(), String> {
        Err("只支持 Windows".into())
    }
    pub fn delete(_name: &str) {}
}

/// 让这次开机里已经开着的程序马上认得 / 不再认得这个字体文件
#[cfg(windows)]
fn gdi(path: &Path, add: bool) {
    use std::os::windows::ffi::OsStrExt;
    let w: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        if add {
            winapi::um::wingdi::AddFontResourceW(w.as_ptr());
        } else {
            winapi::um::wingdi::RemoveFontResourceW(w.as_ptr());
        }
    }
}

/// 广播「字体变了」。PS、剪映这类软件大多只在启动时读字体列表，这一下只对少数软件有用，
/// 所以界面上还是会提醒「重开软件」
#[cfg(windows)]
fn broadcast() {
    use winapi::um::winuser::{PostMessageW, HWND_BROADCAST, WM_FONTCHANGE};
    unsafe {
        PostMessageW(HWND_BROADCAST, WM_FONTCHANGE, 0, 0);
    }
}

#[cfg(not(windows))]
fn gdi(_path: &Path, _add: bool) {}
#[cfg(not(windows))]
fn broadcast() {}

fn reg_path(item: &RegItem) -> PathBuf {
    let d = expand(&item.data);
    let p = PathBuf::from(&d);
    if p.is_absolute() { p } else { windows_fonts_dir().join(d) }
}

// ─── 我们自己的两份清单：停用的、回收区 ───────────

fn write_json<T: Serialize>(p: &Path, v: &T) -> Result<(), String> {
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("建目录失败: {e}"))?;
    }
    // 先写临时文件再换过去：写到一半断电，原来那份还在
    let tmp = p.with_extension("tmp");
    let bytes = serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, bytes).map_err(|e| format!("写文件失败: {e}"))?;
    std::fs::rename(&tmp, p).map_err(|e| format!("写文件失败: {e}"))
}

fn load_disabled() -> Vec<RegItem> {
    std::fs::read(disabled_path())
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

// ─── 扫描本机字体 ───────────────────────────────

#[derive(Clone, Copy, Serialize, PartialEq, Eq, Debug, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Windows,
    Machine,
    User,
    Xgcut,
    Xgtools,
}

struct FileEntry {
    path: PathBuf,
    machine: bool,
    disabled: bool,
}

/// 注册表里登记着的字体文件，加上被我们停用的。同一个文件只算一次
fn font_files() -> Vec<FileEntry> {
    let mut seen = HashSet::new();
    let mut out = vec![];
    for machine in [false, true] {
        for item in reg::values(machine) {
            let p = reg_path(&item);
            if font_sfnt::is_font_file(&p) && seen.insert(norm(&p)) {
                out.push(FileEntry { path: p, machine, disabled: false });
            }
        }
    }
    for item in load_disabled() {
        let p = reg_path(&item);
        if p.exists() && seen.insert(norm(&p)) {
            out.push(FileEntry { path: p, machine: false, disabled: true });
        }
    }
    out
}

/// 同一个文件没改过就不重读。一台装了 Office 的电脑三四百个字体文件，
/// 每次进页面都从头读一遍要一两秒
fn faces_cached(p: &Path) -> (Vec<FaceInfo>, u64) {
    static CACHE: OnceLock<Mutex<HashMap<String, (u64, u64, Vec<FaceInfo>)>>> = OnceLock::new();
    let Ok(meta) = std::fs::metadata(p) else { return (vec![], 0) };
    let size = meta.len();
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let key = norm(p);
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((s, m, faces)) = cache.lock().unwrap().get(&key) {
        if *s == size && *m == mtime {
            return (faces.clone(), size);
        }
    }
    let faces = font_sfnt::read_faces(p);
    cache.lock().unwrap().insert(key, (size, mtime, faces.clone()));
    (faces, size)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceOut {
    path: String,
    display_path: String,
    index: u32,
    style: String,
    weight: u16,
    italic: bool,
    full_name: String,
    full_name_zh: String,
    postscript: String,
    legacy_family: String,
    source: Source,
    disabled: bool,
    bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FamilyOut {
    /// 归并用的键：英文族名小写
    key: String,
    /// 显示名：有中文名用中文名
    name: String,
    name_en: String,
    /// 整族算谁装的：有一份是自己装的，整族就算自己装的
    source: Source,
    /// 有没有能停用 / 卸载的（当前用户这一层装的）
    manageable: bool,
    /// 整族都停用了
    disabled: bool,
    faces: Vec<FaceOut>,
    verdict: Verdict,
    license_text: String,
    license_url: String,
    copyright: String,
    manufacturer: String,
    designer: String,
    vendor_url: String,
    sc: bool,
    tc: bool,
    kana: bool,
    hangul: bool,
    latin: bool,
    symbol: bool,
    variable: bool,
    bytes: u64,
    /// 推荐目录里的哪一款（装的是推荐里的字体时）
    catalog: Option<String>,
}

fn source_of(e: &FileEntry, f: &FaceInfo) -> Source {
    if under(&e.path, &our_root()) {
        Source::Xgtools
    } else if under(&e.path, &xgcut_root()) {
        Source::Xgcut
    } else if !e.machine {
        Source::User
    } else if under(&e.path, &windows_fonts_dir()) && font_license::is_windows_family(&f.family_en) {
        Source::Windows
    } else {
        Source::Machine
    }
}

fn catalog_id_for(family_en: &str) -> Option<String> {
    let k = family_en.trim().to_lowercase();
    font_catalog::CATALOG
        .iter()
        .find(|p| p.families.iter().any(|f| f.to_lowercase() == k))
        .map(|p| p.id.to_string())
}

fn scan() -> Vec<FamilyOut> {
    let files = font_files();
    let parsed: Vec<(usize, Vec<FaceInfo>, u64)> = files
        .par_iter()
        .enumerate()
        .map(|(i, e)| {
            let (faces, size) = faces_cached(&e.path);
            (i, faces, size)
        })
        .collect();

    let win_dir = windows_fonts_dir();
    // 键 → (出现顺序, 这一族的所有份)
    let mut groups: HashMap<String, Vec<(&FileEntry, FaceInfo, u64)>> = HashMap::new();
    for (i, faces, size) in parsed {
        let n = faces.len().max(1) as u64;
        for f in faces {
            let key = f.family_en.trim().to_lowercase();
            if key.is_empty() {
                continue;
            }
            // .ttc 里好几份字体共用一个文件，大小平摊，免得一族的体积算成好几倍
            groups.entry(key).or_default().push((&files[i], f, size / n));
        }
    }

    let mut out: Vec<FamilyOut> = groups
        .into_iter()
        .map(|(key, mut members)| {
            members.sort_by_key(|(_, f, _)| (f.italic, (f.weight as i32 - 400).abs(), f.weight));
            // 代表：没停用的、最接近常规字重的那份
            let rep_i = members.iter().position(|(e, _, _)| !e.disabled).unwrap_or(0);
            let rep = &members[rep_i].1;
            let verdict = font_license::assess_family(
                members.iter().map(|(e, f, _)| (f, under(&e.path, &win_dir))),
            )
            .unwrap_or_else(|| font_license::assess(rep, false));
            let faces: Vec<FaceOut> = members
                .iter()
                .map(|(e, f, bytes)| FaceOut {
                    path: e.path.to_string_lossy().to_string(),
                    display_path: display_path(&e.path),
                    index: f.index,
                    style: f.style.clone(),
                    weight: f.weight,
                    italic: f.italic,
                    full_name: f.full_name.clone(),
                    full_name_zh: f.full_name_zh.clone(),
                    postscript: f.postscript.clone(),
                    legacy_family: f.legacy_family.clone(),
                    source: source_of(e, f),
                    disabled: e.disabled,
                    bytes: *bytes,
                })
                .collect();
            let source = faces.iter().map(|f| f.source).max().unwrap_or(Source::Machine);
            let any = |pred: fn(&FaceInfo) -> bool| members.iter().any(|(_, f, _)| pred(f));
            FamilyOut {
                name: rep.family.clone(),
                name_en: rep.family_en.clone(),
                source,
                manageable: faces.iter().any(|f| !matches!(f.source, Source::Windows | Source::Machine)),
                disabled: faces.iter().all(|f| f.disabled),
                license_text: rep.license.chars().take(800).collect(),
                license_url: rep.license_url.clone(),
                copyright: rep.copyright.clone(),
                manufacturer: rep.manufacturer.clone(),
                designer: rep.designer.clone(),
                vendor_url: rep.vendor_url.clone(),
                sc: any(|f| f.sc),
                tc: any(|f| f.tc),
                kana: any(|f| f.kana),
                hangul: any(|f| f.hangul),
                latin: any(|f| f.latin),
                symbol: members.iter().all(|(_, f, _)| f.symbol),
                variable: any(|f| f.variable),
                bytes: faces.iter().map(|f| f.bytes).sum(),
                catalog: catalog_id_for(&rep.family_en),
                verdict,
                faces,
                key,
            }
        })
        .collect();
    out.sort_by(|a, b| a.name_en.to_lowercase().cmp(&b.name_en.to_lowercase()));
    out
}

#[tauri::command]
pub async fn font_scan() -> Result<Vec<FamilyOut>, String> {
    tauri::async_runtime::spawn_blocking(scan).await.map_err(|e| e.to_string())
}

// ─── 停用 / 启用 ────────────────────────────────

/// 这些文件在 HKCU 里对应的注册项
fn hkcu_items_for(paths: &[PathBuf]) -> Vec<RegItem> {
    let want: HashSet<String> = paths.iter().map(|p| norm(p)).collect();
    reg::values(false).into_iter().filter(|it| want.contains(&norm(&reg_path(it)))).collect()
}

fn refuse_machine(p: &Path) -> Result<(), String> {
    if under(p, &windows_fonts_dir()) && !under(p, &user_fonts_dir()) {
        let name = p.file_name().unwrap_or_default().to_string_lossy();
        return Err(format!("「{name}」是装给整台电脑的，动它要管理员权限，这里只看不动"));
    }
    Ok(())
}

#[tauri::command]
pub fn font_set_enabled(paths: Vec<String>, enabled: bool) -> Result<usize, String> {
    let paths: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    for p in &paths {
        refuse_machine(p)?;
    }
    let mut disabled = load_disabled();
    let mut n = 0;
    if enabled {
        let want: HashSet<String> = paths.iter().map(|p| norm(p)).collect();
        let mut keep = vec![];
        let mut first_err = None;
        for it in disabled {
            if !want.contains(&norm(&reg_path(&it))) {
                keep.push(it);
                continue;
            }
            match reg::set(&it) {
                Ok(()) => {
                    gdi(&reg_path(&it), true);
                    n += 1;
                }
                Err(e) => {
                    first_err.get_or_insert(e);
                    keep.push(it);
                }
            }
        }
        disabled = keep;
        write_json(&disabled_path(), &disabled)?;
        broadcast();
        if let Some(e) = first_err {
            return Err(e);
        }
    } else {
        let items = hkcu_items_for(&paths);
        if items.is_empty() {
            return Err("这几个文件不在「装给自己」那一层，停用不了".into());
        }
        // 先记下来再撤：撤到一半出事，至少清单里有，还能写回去
        for it in &items {
            if !disabled.contains(it) {
                disabled.push(it.clone());
            }
        }
        write_json(&disabled_path(), &disabled)?;
        for it in &items {
            reg::delete(&it.name);
            gdi(&reg_path(it), false);
            n += 1;
        }
        broadcast();
    }
    Ok(n)
}

// ─── 卸载进回收区 / 恢复 ────────────────────────

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrashItem {
    /// dir = 整个字体包目录（字体库、XGCut 装的）；file = 单个文件；reg = 只撤了注册，文件没动
    kind: String,
    /// 原来在哪
    orig: String,
    /// 回收区里叫什么（相对这一条的目录）
    stored: String,
    /// 原来的注册项，恢复时原样写回去
    reg: Vec<RegItem>,
    /// 撤之前就是停用状态的，恢复后还是停用
    #[serde(default)]
    was_disabled: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    id: String,
    /// 界面上显示的名字（字体族名）
    label: String,
    /// 卸载时间（毫秒）
    time: u64,
    items: Vec<TrashItem>,
    #[serde(default)]
    bytes: u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn dir_size(p: &Path) -> u64 {
    if p.is_file() {
        return std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
    }
    std::fs::read_dir(p)
        .map(|rd| rd.flatten().map(|e| dir_size(&e.path())).sum())
        .unwrap_or(0)
}

/// 同一个盘上直接改名；跨盘（极少见）就复制再删
fn move_path(from: &Path, to: &Path) -> std::io::Result<()> {
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    if from.is_dir() {
        copy_dir(from, to)?;
        std::fs::remove_dir_all(from)
    } else {
        std::fs::copy(from, to)?;
        std::fs::remove_file(from)
    }
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)?.flatten() {
        let p = e.path();
        let t = to.join(e.file_name());
        if p.is_dir() {
            copy_dir(&p, &t)?;
        } else {
            std::fs::copy(&p, &t)?;
        }
    }
    Ok(())
}

/// 字体包目录（字体库、XGCut 装的都是「根目录/某款/文件」）
fn pack_dir_of(p: &Path) -> Option<PathBuf> {
    for root in [our_root(), xgcut_root()] {
        if under(p, &root) {
            // 按长度切，不用 strip_prefix：注册表里的路径大小写常常和我们拼的对不上
            let s = p.to_string_lossy().replace('/', "\\");
            let r = root.to_string_lossy().replace('/', "\\").trim_end_matches('\\').len();
            let first = s.get(r + 1..)?.split('\\').find(|x| !x.is_empty())?.to_string();
            return Some(root.join(first));
        }
    }
    None
}

fn font_files_in(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| font_sfnt::is_font_file(p)).collect())
        .unwrap_or_default()
}

#[tauri::command]
pub fn font_uninstall(paths: Vec<String>, label: String) -> Result<String, String> {
    let paths: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    for p in &paths {
        refuse_machine(p)?;
    }
    let disabled = load_disabled();
    let disabled_set: HashSet<String> = disabled.iter().map(|it| norm(&reg_path(it))).collect();

    // 要处理的单位：字体包目录整个搬；零散的文件一个一个搬
    let mut dirs: Vec<PathBuf> = vec![];
    let mut files: Vec<PathBuf> = vec![];
    for p in &paths {
        match pack_dir_of(p) {
            Some(d) => {
                if !dirs.iter().any(|x| norm(x) == norm(&d)) {
                    dirs.push(d);
                }
            }
            None => {
                if !files.iter().any(|x| norm(x) == norm(p)) {
                    files.push(p.clone());
                }
            }
        }
    }

    let id = format!("{}-{:04x}", now_ms(), (now_ms() as u32).wrapping_mul(2654435761) >> 16);
    let entry_dir = trash_root().join(&id);
    std::fs::create_dir_all(&entry_dir).map_err(|e| format!("建回收区失败: {e}"))?;

    let reg_for = |fs: &[PathBuf]| -> (Vec<RegItem>, bool) {
        let mut items = hkcu_items_for(fs);
        let mut was_disabled = false;
        let want: HashSet<String> = fs.iter().map(|p| norm(p)).collect();
        for it in &disabled {
            if want.contains(&norm(&reg_path(it))) {
                items.push(it.clone());
                was_disabled = true;
            }
        }
        (items, was_disabled)
    };

    let mut plan: Vec<(TrashItem, PathBuf, Vec<PathBuf>)> = vec![];
    for d in &dirs {
        let fs = font_files_in(d);
        let (reg, was_disabled) = reg_for(&fs);
        let stored = d.file_name().unwrap_or_default().to_string_lossy().to_string();
        plan.push((
            TrashItem { kind: "dir".into(), orig: d.to_string_lossy().into(), stored, reg, was_disabled },
            d.clone(),
            fs,
        ));
    }
    let user_dir = user_fonts_dir();
    for (i, f) in files.iter().enumerate() {
        let (reg, was_disabled) = reg_for(std::slice::from_ref(f));
        if reg.is_empty() && !disabled_set.contains(&norm(f)) {
            let _ = std::fs::remove_dir_all(&entry_dir);
            let name = f.file_name().unwrap_or_default().to_string_lossy();
            return Err(format!("「{name}」不在「装给自己」那一层，卸载不了"));
        }
        // 只有 Windows 替你放的那个字体目录里的文件才挪走；别的软件自己带的字体只撤注册，文件是人家的
        let kind = if under(f, &user_dir) { "file" } else { "reg" };
        let stored = format!("{i:02}-{}", f.file_name().unwrap_or_default().to_string_lossy());
        plan.push((
            TrashItem { kind: kind.into(), orig: f.to_string_lossy().into(), stored, reg, was_disabled },
            f.clone(),
            vec![f.clone()],
        ));
    }

    // 先撤注册、松开文件，再搬
    for (item, _, fs) in &plan {
        for it in &item.reg {
            reg::delete(&it.name);
        }
        for f in fs {
            gdi(f, false);
        }
    }
    broadcast();

    let mut moved: Vec<usize> = vec![];
    for (i, (item, src, _)) in plan.iter().enumerate() {
        if item.kind == "reg" {
            continue;
        }
        if let Err(e) = move_path(src, &entry_dir.join(&item.stored)) {
            // 搬不动（多半是被 PS 之类的软件占着）：已经搬走的搬回来，注册全部写回去
            for &j in &moved {
                let (it, s, _) = &plan[j];
                let _ = move_path(&entry_dir.join(&it.stored), s);
            }
            for (it, _, fs) in &plan {
                if !it.was_disabled {
                    for r in &it.reg {
                        let _ = reg::set(r);
                    }
                    for f in fs {
                        gdi(f, true);
                    }
                }
            }
            broadcast();
            let _ = std::fs::remove_dir_all(&entry_dir);
            let name = src.file_name().unwrap_or_default().to_string_lossy();
            return Err(format!("「{name}」正被别的软件占着（比如 PS、剪映），关掉再卸载：{e}"));
        }
        moved.push(i);
    }

    // 停用清单里的对应条目也清掉：它们现在归回收区管
    let gone: HashSet<String> = plan.iter().flat_map(|(_, _, fs)| fs.iter().map(|f| norm(f))).collect();
    let keep: Vec<RegItem> = disabled.into_iter().filter(|it| !gone.contains(&norm(&reg_path(it)))).collect();
    write_json(&disabled_path(), &keep)?;

    let items: Vec<TrashItem> = plan.into_iter().map(|(it, _, _)| it).collect();
    let entry = TrashEntry { id: id.clone(), label, time: now_ms(), bytes: dir_size(&entry_dir), items };
    write_json(&entry_dir.join("entry.json"), &entry)?;
    Ok(id)
}

#[tauri::command]
pub fn font_trash_list() -> Vec<TrashEntry> {
    let mut out: Vec<TrashEntry> = std::fs::read_dir(trash_root())
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| std::fs::read(e.path().join("entry.json")).ok())
                .filter_map(|b| serde_json::from_slice(&b).ok())
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| b.time.cmp(&a.time));
    out
}

fn entry_dir_checked(id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.contains(['/', '\\', '.']) {
        return Err("回收区条目不对".into());
    }
    let d = trash_root().join(id);
    if !d.join("entry.json").exists() {
        return Err("回收区里没有这一条了".into());
    }
    Ok(d)
}

#[tauri::command]
pub fn font_trash_restore(id: String) -> Result<(), String> {
    let dir = entry_dir_checked(&id)?;
    let entry: TrashEntry = serde_json::from_slice(
        &std::fs::read(dir.join("entry.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    for it in &entry.items {
        if it.kind == "reg" {
            continue;
        }
        let orig = PathBuf::from(&it.orig);
        if orig.exists() {
            return Err(format!("原来的位置已经有「{}」了，先把那份处理掉再恢复", display_path(&orig)));
        }
    }
    let mut disabled = load_disabled();
    for it in &entry.items {
        let orig = PathBuf::from(&it.orig);
        if it.kind != "reg" {
            if let Some(parent) = orig.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("建目录失败: {e}"))?;
            }
            move_path(&dir.join(&it.stored), &orig).map_err(|e| format!("搬回去失败: {e}"))?;
        }
        if it.was_disabled {
            // 卸载前就是停用的：回到停用清单，不写注册表
            for r in &it.reg {
                if !disabled.contains(r) {
                    disabled.push(r.clone());
                }
            }
            continue;
        }
        for r in &it.reg {
            reg::set(r)?;
            gdi(&reg_path(r), true);
        }
    }
    write_json(&disabled_path(), &disabled)?;
    broadcast();
    let _ = std::fs::remove_dir_all(&dir);
    Ok(())
}

/// 清空回收区（或其中一条）。交给系统回收站，不是直接删 —— 还有 Windows 兜底
#[tauri::command]
pub fn font_trash_purge(id: Option<String>) -> Result<usize, String> {
    let dirs: Vec<PathBuf> = match id {
        Some(id) => vec![entry_dir_checked(&id)?],
        None => std::fs::read_dir(trash_root())
            .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect())
            .unwrap_or_default(),
    };
    let n = dirs.len();
    for d in dirs {
        trash::delete(&d).map_err(|e| format!("放进系统回收站失败: {e}"))?;
    }
    Ok(n)
}

// ─── 推荐目录 ───────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackOut {
    #[serde(flatten)]
    pack: Pack,
    /// xgtools = 字体库装的；xgcut = XGCut 装的；空 = 我们俩都没装（系统里可能有，前端对族名）
    installed_by: Option<&'static str>,
    files: Vec<String>,
}

/// 字体库装的每款字体旁边放一份清单：装了哪几个文件、系统里叫什么
const MANIFEST: &str = "_xgtools.json";

#[derive(Serialize, Deserialize)]
struct Manifest {
    id: String,
    families: Vec<String>,
}

#[tauri::command]
pub fn font_catalog() -> Vec<PackOut> {
    font_catalog::CATALOG
        .iter()
        .map(|p| {
            let ours = our_root().join(p.id);
            let theirs = xgcut_root().join(p.id);
            let (installed_by, dir) = if ours.join(MANIFEST).exists() {
                (Some("xgtools"), Some(ours))
            } else if theirs.join("_xgcut.txt").exists() {
                (Some("xgcut"), Some(theirs))
            } else {
                (None, None)
            };
            let mut files: Vec<String> = dir
                .map(|d| font_files_in(&d).iter().map(|f| f.to_string_lossy().to_string()).collect())
                .unwrap_or_default();
            files.sort();
            PackOut { pack: p.clone(), installed_by, files }
        })
        .collect()
}

/// 压缩包里挑哪些字体文件装。
///
/// - macOS 打包带进来的 `__MACOSX/`、`._xxx` 不是字体，是资源分叉，装进去会出一堆坏字体
/// - 一套字给了好几种语言版本（方舟像素七种）时只装 `pick` 那份，不然字体菜单里刷屏
/// - 同一款给了 .otf 和 .ttf 两份时只留 .ttf：两份都装，菜单里就是两个一模一样的名字
fn pick_zip_fonts(names: &[String], pick: &str) -> Vec<String> {
    let base = |n: &str| n.rsplit(['/', '\\']).next().unwrap_or(n).to_string();
    let mut fonts: Vec<&String> = names
        .iter()
        .filter(|n| !n.contains("__MACOSX") && !base(n).starts_with("._"))
        .filter(|n| font_sfnt::is_font_file(Path::new(&base(n))))
        .collect();
    if !pick.is_empty() {
        let picked: Vec<&String> =
            fonts.iter().copied().filter(|n| base(n).to_lowercase().contains(pick)).collect();
        if !picked.is_empty() {
            fonts = picked;
        }
    }
    let stem = |n: &str| {
        let b = base(n).to_lowercase();
        b.rsplit_once('.').map(|(s, _)| s.to_string()).unwrap_or(b)
    };
    let mut seen: HashMap<String, &String> = HashMap::new();
    for n in fonts {
        let s = stem(n);
        match seen.get(&s) {
            Some(prev) if prev.to_lowercase().ends_with(".ttf") => {}
            _ => {
                seen.insert(s, n);
            }
        }
    }
    let mut out: Vec<String> = seen.into_values().cloned().collect();
    out.sort();
    out
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallProgress {
    id: String,
    got: u64,
    total: u64,
    /// download / unpack / done
    stage: &'static str,
}

/// 注册表项名：系统自己装字体时就是「全名 (TrueType)」这种写法
fn reg_name_for(path: &Path, faces: &[FaceInfo]) -> String {
    let names: Vec<String> = faces.iter().map(|f| f.full_name.clone()).filter(|n| !n.is_empty()).collect();
    let label = if names.is_empty() {
        path.file_stem().unwrap_or_default().to_string_lossy().to_string()
    } else {
        names.join(" & ")
    };
    let cff = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("otf") || e.eq_ignore_ascii_case("otc"));
    format!("{label} ({})", if cff { "OpenType" } else { "TrueType" })
}

/// 把一批字体文件注册给当前用户，返回它们在系统里的族名
fn register(files: &[PathBuf]) -> Result<Vec<String>, String> {
    let taken: HashMap<String, String> = reg::values(false).into_iter().map(|it| (it.name, it.data)).collect();
    let mut families: Vec<String> = vec![];
    for f in files {
        let faces = font_sfnt::read_faces(f);
        let mut name = reg_name_for(f, &faces);
        // 同名的项已经指向别的文件了（比如自己早就装过一份）：别把人家那一笔盖掉
        if taken.get(&name).is_some_and(|d| norm(&reg_path(&RegItem { name: name.clone(), data: d.clone() })) != norm(f)) {
            name = name.replace(" (", " [XGTools] (");
        }
        reg::set(&RegItem { name, data: f.to_string_lossy().to_string() })?;
        gdi(f, true);
        for face in faces {
            if !families.contains(&face.family) {
                families.push(face.family);
            }
        }
    }
    broadcast();
    Ok(families)
}

#[tauri::command]
pub async fn font_install(app: AppHandle, id: String) -> Result<Vec<String>, String> {
    let pack = font_catalog::find(&id).ok_or_else(|| format!("推荐里没有这款字体：{id}"))?;
    let dir = our_root().join(pack.id);
    if dir.join(MANIFEST).exists() {
        return Err("已经装过了".into());
    }
    let emit = |got: u64, total: u64, stage: &'static str| {
        let _ = app.emit("font-install", InstallProgress { id: id.clone(), got, total, stage });
    };

    let client = reqwest::Client::builder()
        .user_agent("XGTools")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(pack.url).send().await.map_err(|e| format!("连不上下载地址：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载失败：服务器返回 {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(pack.size_mb as u64 * 1_048_576);
    let mut buf: Vec<u8> = Vec::with_capacity(total as usize);
    {
        use futures_util::StreamExt;
        let mut stream = resp.bytes_stream();
        let mut last = 0u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("下载中断：{e}"))?;
            buf.extend_from_slice(&chunk);
            let got = buf.len() as u64;
            // 每 256KB 报一次，别把事件刷爆
            if got - last > 256 * 1024 {
                last = got;
                emit(got, total, "download");
            }
        }
    }
    emit(buf.len() as u64, total, "unpack");

    let pick = pack.pick.to_string();
    let url = pack.url.to_string();
    let dir2 = dir.clone();
    let written = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<PathBuf>, String> {
        std::fs::create_dir_all(&dir2).map_err(|e| format!("建目录失败：{e}"))?;
        let mut written = vec![];
        if buf.len() > 4 && &buf[0..2] == b"PK" {
            let mut zip = zip::ZipArchive::new(std::io::Cursor::new(buf)).map_err(|e| format!("压缩包读不了：{e}"))?;
            let names: Vec<String> = (0..zip.len())
                .filter_map(|i| zip.by_index(i).ok().map(|f| f.name().to_string()))
                .collect();
            let chosen = pick_zip_fonts(&names, &pick);
            for name in &chosen {
                let mut f = zip.by_name(name).map_err(|e| e.to_string())?;
                let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
                let out = dir2.join(base);
                let mut o = std::fs::File::create(&out).map_err(|e| format!("写文件失败：{e}"))?;
                std::io::copy(&mut f, &mut o).map_err(|e| format!("解压失败：{e}"))?;
                written.push(out);
            }
        } else {
            let raw = url.rsplit('/').next().unwrap_or("font.ttf");
            let base = urlencoding::decode(raw).map(|s| s.into_owned()).unwrap_or_else(|_| raw.to_string());
            let out = dir2.join(base);
            std::fs::write(&out, &buf).map_err(|e| format!("写文件失败：{e}"))?;
            written.push(out);
        }
        if written.is_empty() {
            return Err("下载包里没找到字体文件".into());
        }
        Ok(written)
    })
    .await
    .map_err(|e| e.to_string())??;

    let families = match register(&written) {
        Ok(f) => f,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(e);
        }
    };
    write_json(&dir.join(MANIFEST), &Manifest { id: id.clone(), families: families.clone() })?;
    emit(1, 1, "done");
    Ok(families)
}

// ─── 查字 ───────────────────────────────────────

/// 《通用规范汉字表》（2013）全部 8105 字，前 3500 个是一级字表（常用字）。
/// 数据取自 jaywcjlove/table-of-general-standard-chinese-characters（MIT，Copyright (c) 2026 小弟调调）
const TONGYONG: &str = include_str!("font_data/tongyong-8105.txt");

fn tongyong() -> &'static [char] {
    static CHARS: OnceLock<Vec<char>> = OnceLock::new();
    CHARS.get_or_init(|| TONGYONG.chars().filter(|c| !c.is_whitespace()).collect())
}

fn kana() -> String {
    // 平假名 ぁ-ゖ、片假名 ァ-ヺ，再加长音符 ー
    (0x3041u32..=0x3096).chain(0x30A1..=0x30FA).chain([0x30FC]).filter_map(char::from_u32).collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageOut {
    level1: usize,
    level1_total: usize,
    all: usize,
    all_total: usize,
    kana: usize,
    kana_total: usize,
    /// 一级字表里缺的字（最多列 200 个）
    level1_missing: String,
}

#[tauri::command]
pub async fn font_coverage(path: String, index: u32) -> Result<CoverageOut, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cov = font_sfnt::coverage(Path::new(&path), index).ok_or("读不了这个字体文件")?;
        let chars = tongyong();
        let l1 = &chars[..3500];
        let kana = kana();
        let level1_missing: String = l1.iter().filter(|&&c| !cov.has(c as u32)).take(200).collect();
        Ok(CoverageOut {
            level1: l1.iter().filter(|&&c| cov.has(c as u32)).count(),
            level1_total: l1.len(),
            all: chars.iter().filter(|&&c| cov.has(c as u32)).count(),
            all_total: chars.len(),
            kana: cov.count_in(&kana),
            kana_total: kana.chars().count(),
            level1_missing,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingOut {
    /// 缺的字，去重、按出现顺序
    missing: String,
    /// 一共查了多少个不同的字
    checked: usize,
}

/// 贴一段游戏台词进来，看这款字体缺哪些字
#[tauri::command]
pub async fn font_missing(path: String, index: u32, text: String) -> Result<MissingOut, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cov = font_sfnt::coverage(Path::new(&path), index).ok_or("读不了这个字体文件")?;
        let unique: HashSet<char> = text.chars().filter(|c| !c.is_whitespace() && !c.is_control()).collect();
        Ok(MissingOut { missing: cov.missing(&text).into_iter().collect(), checked: unique.len() })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 给页面放行几个字体文件：用系统名字对不上的那几款，退回直接读文件画样张
#[tauri::command]
pub fn font_allow_files(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    let scope = app.asset_protocol_scope();
    for p in paths {
        let pb = PathBuf::from(&p);
        if font_sfnt::is_font_file(&pb) {
            scope.allow_file(&pb).map_err(|e| format!("放行失败: {e}"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zip_picking() {
        let names: Vec<String> = [
            "ChillBitmap_16px.ttf", "__MACOSX/._ChillBitmap_16px.ttf", "._ChillBitmap_7px.ttf",
            "ChillBitmap_7px.ttf", "fonts/ChillRoundM.otf", "fonts/ChillRoundM.ttf", "readme.txt",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(
            pick_zip_fonts(&names, ""),
            vec!["ChillBitmap_16px.ttf", "ChillBitmap_7px.ttf", "fonts/ChillRoundM.ttf"]
        );
        let ark: Vec<String> = ["a/ark-12px-latin.otf", "a/ark-12px-zh_cn.otf", "a/ark-12px-ja.otf"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(pick_zip_fonts(&ark, "zh_cn"), vec!["a/ark-12px-zh_cn.otf"]);
        // pick 一个都对不上时别装空
        assert_eq!(pick_zip_fonts(&ark, "zh_hans").len(), 3);
    }

    #[test]
    fn tongyong_table_shape() {
        let t = tongyong();
        assert_eq!(t.len(), 8105);
        assert_eq!(t[0], '一');
        assert_eq!(t.iter().collect::<HashSet<_>>().len(), 8105);
        assert_eq!(kana().chars().count(), 86 + 90 + 1);
    }

    #[test]
    fn paths_and_expand() {
        assert!(under(Path::new(r"C:\A\b\c.ttf"), Path::new(r"c:\a")));
        assert!(!under(Path::new(r"C:\Ab\c.ttf"), Path::new(r"c:\a")));
        // 别在测试里改环境变量：测试是并行跑的，别的测试同时在拼 %LOCALAPPDATA% 下的路径
        let base = std::env::var("LOCALAPPDATA").unwrap();
        assert_eq!(expand(r"%LocalAppData%\f.ttf"), format!(r"{base}\f.ttf"));
        let item = RegItem { name: "Arial (TrueType)".into(), data: "arial.ttf".into() };
        assert!(norm(&reg_path(&item)).ends_with(r"\fonts\arial.ttf"));
    }

    #[test]
    fn pack_dir_detection() {
        let p = our_root().join("cubic-11").join("Cubic_11.ttf");
        assert_eq!(pack_dir_of(&p).map(|d| norm(&d)), Some(norm(&our_root().join("cubic-11"))));
        assert!(pack_dir_of(&user_fonts_dir().join("x.ttf")).is_none());
    }

    #[test]
    fn machine_fonts_refused() {
        assert!(refuse_machine(&windows_fonts_dir().join("arial.ttf")).is_err());
        assert!(refuse_machine(&user_fonts_dir().join("x.ttf")).is_ok());
    }

    /// 真扫一遍本机：至少得认出 Arial 是 Windows 自带
    #[test]
    fn scan_this_machine() {
        let fams = scan();
        if let Some(arial) = fams.iter().find(|f| f.key == "arial") {
            assert_eq!(arial.source, Source::Windows);
            assert!(!arial.manageable);
            assert_eq!(arial.verdict.tier, font_license::Tier::System);
        }
    }
}
