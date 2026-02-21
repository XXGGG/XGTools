use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppEntry {
    pub id: String,
    pub name: String,
    pub path: String,
    pub icon: Option<String>, // base64 encoded PNG or relative path
    pub group: Option<String>,
    pub sort_order: Option<i32>,
}

/// Read apps from apps.json
#[tauri::command]
pub fn get_apps(app: tauri::AppHandle) -> Result<Vec<AppEntry>, String> {
    let apps_file = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("apps.json");

    if !apps_file.exists() {
        return Ok(vec![]);
    }

    let content = std::fs::read_to_string(&apps_file).map_err(|e| e.to_string())?;
    let apps: Vec<AppEntry> = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(apps)
}

/// Save apps to apps.json
#[tauri::command]
pub fn save_apps(app: tauri::AppHandle, apps: Vec<AppEntry>) -> Result<(), String> {
    let apps_file = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("apps.json");

    let content = serde_json::to_string_pretty(&apps).map_err(|e| e.to_string())?;
    std::fs::write(&apps_file, content).map_err(|e| e.to_string())?;
    Ok(())
}

/// Launch an application by path
#[tauri::command]
pub fn launch_app(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::process::Command;
        let p = PathBuf::from(&path);
        let dir = p.parent().unwrap_or(&p);
        Command::new(&path)
            .current_dir(dir)
            .spawn()
            .map_err(|e| format!("Failed to launch {}: {}", path, e))?;
    }
    Ok(())
}

/// Extract icon from .exe file and return as base64 PNG
#[tauri::command]
pub fn extract_icon(app: tauri::AppHandle, exe_path: String) -> Result<String, String> {
    #[cfg(windows)]
    {
        let icons_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("icons");

        return crate::icon_extractor::extract_exe_icon(&exe_path, &icons_dir);
    }

    #[cfg(not(windows))]
    {
        let _ = app;
        let _ = exe_path;
        Err("Icon extraction is only supported on Windows".to_string())
    }
}

/// Resolve .lnk shortcut to get target path and name
#[tauri::command]
pub fn resolve_lnk(lnk_path: String) -> Result<(String, String), String> {
    #[cfg(windows)]
    {
        return crate::icon_extractor::resolve_shortcut(&lnk_path);
    }

    #[cfg(not(windows))]
    {
        let _ = lnk_path;
        Err("LNK resolution is only supported on Windows".to_string())
    }
}

/// Re-extract all app icons in high resolution and save back to apps.json
#[tauri::command]
pub fn refresh_all_icons(app: tauri::AppHandle) -> Result<Vec<AppEntry>, String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let apps_file = app_dir.join("apps.json");
    let icons_dir = app_dir.join("icons");

    if !apps_file.exists() {
        return Ok(vec![]);
    }

    let content = std::fs::read_to_string(&apps_file).map_err(|e| e.to_string())?;
    let mut apps: Vec<AppEntry> = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    #[cfg(windows)]
    {
        for entry in apps.iter_mut() {
            match crate::icon_extractor::extract_exe_icon(&entry.path, &icons_dir) {
                Ok(icon) => entry.icon = Some(icon),
                Err(_) => {} // keep old icon if extraction fails
            }
        }
    }

    let new_content = serde_json::to_string_pretty(&apps).map_err(|e| e.to_string())?;
    std::fs::write(&apps_file, new_content).map_err(|e| e.to_string())?;

    Ok(apps)
}

/// Get the app data directory path
#[tauri::command]
pub fn get_apps_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

/// User settings
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default = "default_true")]
    pub dark_mode: bool,
    #[serde(default)]
    pub show_names: bool,
    #[serde(default)]
    pub auto_start: bool,
    #[serde(default = "default_icon_size")]
    pub icon_size: u32,
    #[serde(default = "default_hover_scale")]
    pub hover_scale: f64,
    #[serde(default = "default_blur_amount")]
    pub blur_amount: u32,
    #[serde(default = "default_backdrop_opacity")]
    pub backdrop_opacity: f64,
    #[serde(default = "default_shortcut")]
    pub shortcut: String,
    #[serde(default = "default_grid_gap")]
    pub grid_gap: u32,
    #[serde(default = "default_padding_top")]
    pub padding_top: u32,
    #[serde(default = "default_padding_horizontal")]
    pub padding_horizontal: u32,
    #[serde(default)]
    pub icon_glow: u32,
    #[serde(default = "default_acrylic_r")]
    pub acrylic_r: u8,
    #[serde(default = "default_acrylic_g")]
    pub acrylic_g: u8,
    #[serde(default = "default_acrylic_b")]
    pub acrylic_b: u8,
    #[serde(default = "default_acrylic_a")]
    pub acrylic_a: u8,
}

fn default_true() -> bool { true }
fn default_icon_size() -> u32 { 88 }
fn default_hover_scale() -> f64 { 1.1 }
fn default_blur_amount() -> u32 { 30 }
fn default_backdrop_opacity() -> f64 { 0.65 }
fn default_shortcut() -> String { "Ctrl+Alt+D".to_string() }
fn default_grid_gap() -> u32 { 64 }
fn default_padding_top() -> u32 { 92 }
fn default_padding_horizontal() -> u32 { 56 }
fn default_acrylic_r() -> u8 { 0 }
fn default_acrylic_g() -> u8 { 0 }
fn default_acrylic_b() -> u8 { 0 }
fn default_acrylic_a() -> u8 { 180 }

impl Default for Settings {
    fn default() -> Self {
        Self {
            dark_mode: true,
            show_names: false,
            auto_start: false,
            icon_size: default_icon_size(),
            hover_scale: default_hover_scale(),
            blur_amount: default_blur_amount(),
            backdrop_opacity: default_backdrop_opacity(),
            shortcut: default_shortcut(),
            grid_gap: default_grid_gap(),
            padding_top: default_padding_top(),
            padding_horizontal: default_padding_horizontal(),
            icon_glow: 0,
            acrylic_r: default_acrylic_r(),
            acrylic_g: default_acrylic_g(),
            acrylic_b: default_acrylic_b(),
            acrylic_a: default_acrylic_a(),
        }
    }
}

#[tauri::command]
pub fn get_settings(app: tauri::AppHandle) -> Result<Settings, String> {
    let file = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("settings.json");
    if !file.exists() {
        return Ok(Settings::default());
    }
    let content = std::fs::read_to_string(&file).map_err(|e| e.to_string())?;
    let settings: Settings = serde_json::from_str(&content).unwrap_or_default();
    Ok(settings)
}

#[tauri::command]
pub fn save_settings(app: tauri::AppHandle, settings: Settings) -> Result<(), String> {
    let file = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("settings.json");
    let content = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&file, content).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartMenuEntry {
    pub name: String,
    pub path: String,       // .lnk 文件路径
    pub target: String,     // 目标 exe 路径
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>, // base64 icon, extracted lazily
}

/// Load cached start menu scan results
#[tauri::command]
pub fn get_start_menu_cache(app: tauri::AppHandle) -> Result<Vec<StartMenuEntry>, String> {
    let file = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("start_menu_cache.json");
    if !file.exists() {
        return Ok(vec![]);
    }
    let content = std::fs::read_to_string(&file).map_err(|e| e.to_string())?;
    let entries: Vec<StartMenuEntry> = serde_json::from_str(&content).unwrap_or_default();
    Ok(entries)
}

/// Save start menu scan results to cache (internal)
fn save_start_menu_cache_internal(app: &tauri::AppHandle, entries: &[StartMenuEntry]) -> Result<(), String> {
    let file = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("start_menu_cache.json");
    let content = serde_json::to_string_pretty(entries).map_err(|e| e.to_string())?;
    std::fs::write(&file, content).map_err(|e| e.to_string())?;
    Ok(())
}

/// Save start menu cache from frontend (with icons)
#[tauri::command]
pub fn save_start_menu_cache(app: tauri::AppHandle, entries: Vec<StartMenuEntry>) -> Result<(), String> {
    save_start_menu_cache_internal(&app, &entries)
}

/// Scan Windows Start Menu for shortcut (.lnk) files and cache results
#[tauri::command]
pub fn scan_start_menu(app: tauri::AppHandle) -> Result<Vec<StartMenuEntry>, String> {
    #[cfg(windows)]
    {
        // Wrap in catch_unwind to prevent panic from crashing the entire app
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut entries = Vec::new();
            let mut seen_targets = std::collections::HashSet::new();

            let dirs: Vec<PathBuf> = vec![
                dirs_user().unwrap_or_default(),
                dirs_system().unwrap_or_default(),
            ];

            for dir in dirs {
                if dir.as_os_str().is_empty() || !dir.exists() {
                    continue;
                }
                scan_dir_recursive(&dir, &mut entries, &mut seen_targets, 0);
            }

            entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
            entries
        }));

        match result {
            Ok(entries) => {
                let _ = save_start_menu_cache_internal(&app, &entries);
                return Ok(entries);
            }
            Err(_) => {
                return Err("Start menu scan panicked — some shortcuts may be corrupted".to_string());
            }
        }
    }

    #[cfg(not(windows))]
    {
        let _ = app;
        Err("Start menu scanning is only supported on Windows".to_string())
    }
}

/// Extract icon for a single start menu entry and update cache
#[tauri::command]
pub fn extract_start_menu_icon(
    app: tauri::AppHandle,
    target: String,
) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let icons_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("icons");

        match crate::icon_extractor::extract_exe_icon(&target, &icons_dir) {
            Ok(icon) => Ok(Some(icon)),
            Err(_) => Ok(None),
        }
    }

    #[cfg(not(windows))]
    {
        let _ = app;
        let _ = target;
        Ok(None)
    }
}

#[cfg(windows)]
fn dirs_user() -> Option<PathBuf> {
    std::env::var("APPDATA")
        .ok()
        .map(|p| PathBuf::from(p).join("Microsoft\\Windows\\Start Menu\\Programs"))
}

#[cfg(windows)]
fn dirs_system() -> Option<PathBuf> {
    std::env::var("ProgramData")
        .ok()
        .map(|p| PathBuf::from(p).join("Microsoft\\Windows\\Start Menu\\Programs"))
}

/// Update the global shortcut at runtime
#[tauri::command]
pub fn update_shortcut(app: tauri::AppHandle, shortcut_str: String) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    // Unregister all existing shortcuts
    app.global_shortcut()
        .unregister_all()
        .map_err(|e| format!("Failed to unregister shortcuts: {}", e))?;

    // Parse the shortcut string like "Ctrl+Alt+D"
    let shortcut = parse_shortcut_str(&shortcut_str)?;

    // Register with toggle handler — let frontend manage show/hide state
    let app_handle = app.clone();
    app.global_shortcut()
        .on_shortcut(shortcut, move |_app, _shortcut, event| {
            if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                if let Some(win) = app_handle.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                    let _ = win.eval("window.__toggleDock && window.__toggleDock()");
                }
            }
        })
        .map_err(|e| format!("Failed to register shortcut: {}", e))?;

    Ok(())
}

/// Parse shortcut string like "Ctrl+Alt+D" into a Shortcut
pub fn parse_shortcut_str(s: &str) -> Result<tauri_plugin_global_shortcut::Shortcut, String> {
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

    let parts: Vec<&str> = s.split('+').collect();
    let mut mods = Modifiers::empty();
    let mut key_str = "";

    for part in &parts {
        match part.to_lowercase().as_str() {
            "ctrl" | "control" => mods |= Modifiers::CONTROL,
            "alt" => mods |= Modifiers::ALT,
            "shift" => mods |= Modifiers::SHIFT,
            "super" | "meta" | "win" => mods |= Modifiers::SUPER,
            _ => key_str = part,
        }
    }

    let code = match key_str.to_uppercase().as_str() {
        "A" => Code::KeyA, "B" => Code::KeyB, "C" => Code::KeyC, "D" => Code::KeyD,
        "E" => Code::KeyE, "F" => Code::KeyF, "G" => Code::KeyG, "H" => Code::KeyH,
        "I" => Code::KeyI, "J" => Code::KeyJ, "K" => Code::KeyK, "L" => Code::KeyL,
        "M" => Code::KeyM, "N" => Code::KeyN, "O" => Code::KeyO, "P" => Code::KeyP,
        "Q" => Code::KeyQ, "R" => Code::KeyR, "S" => Code::KeyS, "T" => Code::KeyT,
        "U" => Code::KeyU, "V" => Code::KeyV, "W" => Code::KeyW, "X" => Code::KeyX,
        "Y" => Code::KeyY, "Z" => Code::KeyZ,
        "0" => Code::Digit0, "1" => Code::Digit1, "2" => Code::Digit2, "3" => Code::Digit3,
        "4" => Code::Digit4, "5" => Code::Digit5, "6" => Code::Digit6, "7" => Code::Digit7,
        "8" => Code::Digit8, "9" => Code::Digit9,
        "F1" => Code::F1, "F2" => Code::F2, "F3" => Code::F3, "F4" => Code::F4,
        "F5" => Code::F5, "F6" => Code::F6, "F7" => Code::F7, "F8" => Code::F8,
        "F9" => Code::F9, "F10" => Code::F10, "F11" => Code::F11, "F12" => Code::F12,
        "SPACE" => Code::Space, "ENTER" => Code::Enter, "TAB" => Code::Tab,
        "BACKSPACE" => Code::Backspace, "DELETE" => Code::Delete,
        "UP" => Code::ArrowUp, "DOWN" => Code::ArrowDown,
        "LEFT" => Code::ArrowLeft, "RIGHT" => Code::ArrowRight,
        "`" => Code::Backquote, "-" => Code::Minus, "=" => Code::Equal,
        "[" => Code::BracketLeft, "]" => Code::BracketRight,
        "\\" => Code::Backslash, ";" => Code::Semicolon, "'" => Code::Quote,
        "," => Code::Comma, "." => Code::Period, "/" => Code::Slash,
        _ => return Err(format!("Unknown key: {}", key_str)),
    };

    let mods_opt = if mods.is_empty() { None } else { Some(mods) };
    Ok(Shortcut::new(mods_opt, code))
}

/// Custom icon entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomIcon {
    pub id: String,
    pub name: String,
    /// data:image/png;base64,... URI
    pub data_uri: String,
}

/// Metadata for custom icons, stored in icons/custom/meta.json
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct IconMeta {
    icons: Vec<IconMetaEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct IconMetaEntry {
    id: String,
    name: String,
}

fn custom_icons_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("icons")
        .join("custom");
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

fn load_icon_meta(dir: &std::path::Path) -> IconMeta {
    let meta_file = dir.join("meta.json");
    if meta_file.exists() {
        std::fs::read_to_string(&meta_file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        IconMeta::default()
    }
}

fn save_icon_meta(dir: &std::path::Path, meta: &IconMeta) -> Result<(), String> {
    let meta_file = dir.join("meta.json");
    let content = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    std::fs::write(&meta_file, content).map_err(|e| e.to_string())?;
    Ok(())
}

/// Save a custom icon (base64 PNG data) to the custom icons directory
#[tauri::command]
pub fn save_custom_icon(
    app: tauri::AppHandle,
    name: String,
    png_base64: String,
) -> Result<CustomIcon, String> {
    let custom_dir = custom_icons_dir(&app)?;

    let id = uuid::Uuid::new_v4().to_string();
    let file_path = custom_dir.join(format!("{}.png", id));

    let bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        &png_base64,
    )
    .map_err(|e| format!("Invalid base64: {}", e))?;

    std::fs::write(&file_path, &bytes).map_err(|e| e.to_string())?;

    // Save metadata
    let mut meta = load_icon_meta(&custom_dir);
    meta.icons.push(IconMetaEntry { id: id.clone(), name: name.clone() });
    save_icon_meta(&custom_dir, &meta)?;

    let data_uri = format!("data:image/png;base64,{}", png_base64);
    Ok(CustomIcon { id, name, data_uri })
}

/// Get all custom icons
#[tauri::command]
pub fn get_custom_icons(app: tauri::AppHandle) -> Result<Vec<CustomIcon>, String> {
    let custom_dir = custom_icons_dir(&app)?;
    let meta = load_icon_meta(&custom_dir);

    let mut icons = Vec::new();
    for entry in std::fs::read_dir(&custom_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().map_or(false, |ext| ext == "png") {
            let id = path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
            let data_uri = format!("data:image/png;base64,{}", b64);
            // Look up name from metadata, fallback to id prefix
            let name = meta.icons.iter()
                .find(|e| e.id == id)
                .map(|e| e.name.clone())
                .unwrap_or_else(|| id[..8.min(id.len())].to_string());
            icons.push(CustomIcon { id, name, data_uri });
        }
    }

    Ok(icons)
}

/// Delete a custom icon by id
#[tauri::command]
pub fn delete_custom_icon(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let custom_dir = custom_icons_dir(&app)?;
    let file = custom_dir.join(format!("{}.png", id));

    if file.exists() {
        std::fs::remove_file(&file).map_err(|e| e.to_string())?;
    }

    // Remove from metadata
    let mut meta = load_icon_meta(&custom_dir);
    meta.icons.retain(|e| e.id != id);
    save_icon_meta(&custom_dir, &meta)?;

    Ok(())
}

/// Rename a custom icon
#[tauri::command]
pub fn rename_custom_icon(app: tauri::AppHandle, id: String, name: String) -> Result<(), String> {
    let custom_dir = custom_icons_dir(&app)?;
    let mut meta = load_icon_meta(&custom_dir);
    if let Some(entry) = meta.icons.iter_mut().find(|e| e.id == id) {
        entry.name = name;
    } else {
        meta.icons.push(IconMetaEntry { id, name });
    }
    save_icon_meta(&custom_dir, &meta)?;
    Ok(())
}

/// Dynamically update acrylic tint color on dock window
#[tauri::command]
pub fn update_acrylic(app: tauri::AppHandle, r: u8, g: u8, b: u8, a: u8) -> Result<(), String> {
    #[cfg(windows)]
    {
        if let Some(win) = app.get_webview_window("dock") {
            use window_vibrancy::apply_acrylic;
            apply_acrylic(&win, Some((r, g, b, a)))
                .map_err(|e| format!("Failed to apply acrylic: {}", e))?;
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (app, r, g, b, a);
    }
    Ok(())
}

#[cfg(windows)]
fn scan_dir_recursive(
    dir: &std::path::Path,
    entries: &mut Vec<StartMenuEntry>,
    seen: &mut std::collections::HashSet<String>,
    depth: u32,
) {
    // Guard against symlink loops or excessively deep directories
    if depth > 10 {
        return;
    }

    let Ok(read_dir) = std::fs::read_dir(dir) else {
        return;
    };

    for entry in read_dir.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan_dir_recursive(&path, entries, seen, depth + 1);
        } else if path.extension().map_or(false, |ext| ext.eq_ignore_ascii_case("lnk")) {
            let name = path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            // 跳过卸载、帮助等无用快捷方式
            let lower = name.to_lowercase();
            if lower.contains("uninstall")
                || lower.contains("卸载")
                || lower.contains("help")
                || lower.contains("readme")
                || lower.contains("license")
                || lower.contains("changelog")
            {
                continue;
            }

            // 解析 .lnk 获取目标路径 (guard against panics from malformed .lnk files)
            let lnk_path_str = path.to_string_lossy().to_string();
            let resolve_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                crate::icon_extractor::resolve_shortcut(&lnk_path_str)
            }));
            if let Ok(Ok((target, _))) = resolve_result {
                // 跳过目标不存在的 或 已经见过的
                let target_lower = target.to_lowercase();
                if !target.is_empty() && seen.insert(target_lower) {
                    entries.push(StartMenuEntry {
                        name,
                        path: lnk_path_str,
                        target,
                        icon: None,
                    });
                }
            }
        }
    }
}
