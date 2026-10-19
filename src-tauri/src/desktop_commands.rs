//! 桌面整理：隐藏 / 显示桌面图标，格子里的文件双击打开。
//!
//! 桌面图标是 Progman（或者 WorkerW）底下 SHELLDLL_DefView 里的那个 SysListView32 列表，
//! 把它藏起来就是「隐藏桌面图标」，和右键桌面 → 查看 → 显示桌面图标 是一个效果，文件都还在。

#[cfg(windows)]
unsafe fn desktop_list_view() -> winapi::shared::windef::HWND {
    use std::ptr::null_mut;
    use winapi::um::winuser::{FindWindowExW, FindWindowW};
    let w = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let progman = FindWindowW(w("Progman").as_ptr(), null_mut());
    let mut defview = FindWindowExW(progman, null_mut(), w("SHELLDLL_DefView").as_ptr(), null_mut());
    // 换过壁纸 / 开过「显示桌面」之后，DefView 会被挪到某个 WorkerW 底下，挨个找
    let mut worker = null_mut();
    while defview.is_null() {
        worker = FindWindowExW(null_mut(), worker, w("WorkerW").as_ptr(), null_mut());
        if worker.is_null() {
            break;
        }
        defview = FindWindowExW(worker, null_mut(), w("SHELLDLL_DefView").as_ptr(), null_mut());
    }
    if defview.is_null() {
        return null_mut();
    }
    FindWindowExW(defview, null_mut(), w("SysListView32").as_ptr(), null_mut())
}

#[tauri::command]
pub fn desktop_icons_visible() -> bool {
    #[cfg(windows)]
    unsafe {
        let lv = desktop_list_view();
        return !lv.is_null() && winapi::um::winuser::IsWindowVisible(lv) != 0;
    }
    #[cfg(not(windows))]
    true
}

#[tauri::command]
pub fn desktop_icons_set(visible: bool) -> Result<(), String> {
    #[cfg(windows)]
    unsafe {
        use winapi::um::winuser::{ShowWindow, SW_HIDE, SW_SHOW};
        let lv = desktop_list_view();
        if lv.is_null() {
            return Err("找不到桌面图标窗口".into());
        }
        ShowWindow(lv, if visible { SW_SHOW } else { SW_HIDE });
    }
    Ok(())
}

/// 用系统默认方式打开（文件、文件夹、快捷方式都行）
#[tauri::command]
pub fn shell_open_path(path: String) -> Result<(), String> {
    let mut cmd = std::process::Command::new("explorer.exe");
    cmd.arg(&path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// 任意文件 / 文件夹 / 快捷方式的系统图标（base64 PNG）。
/// 复用启动台那套取图标的代码，但缓存放到单独的目录 —— 那套会按文件名存一份 PNG，
/// 混进启动台的 icons 目录会把同名应用的图标盖掉。
#[tauri::command]
pub fn file_icon(app: tauri::AppHandle, path: String) -> Result<String, String> {
    #[cfg(windows)]
    {
        use tauri::Manager;
        let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("fence-icons");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        return crate::icon_extractor::extract_exe_icon(&path, &dir);
    }
    #[cfg(not(windows))]
    {
        let _ = (app, path);
        Err("只支持 Windows".into())
    }
}
