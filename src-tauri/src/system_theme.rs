//! 系统深色 / 浅色：读、改 Windows 的「应用模式」和「系统模式」（任务栏、开始菜单那套）。
//!
//! 就是 设置 → 个性化 → 颜色 里那两个开关，存在
//! HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize 的
//! AppsUseLightTheme / SystemUsesLightTheme。改完要广播一次 WM_SETTINGCHANGE("ImmersiveColorSet")，
//! 开着的程序和任务栏才会马上跟着变。

const KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 现在是不是深色（看「应用模式」）
#[tauri::command]
pub fn system_theme_is_dark() -> bool {
    #[cfg(windows)]
    unsafe {
        use winapi::um::winreg::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
        let mut v: u32 = 1;
        let mut size = std::mem::size_of::<u32>() as u32;
        let ok = RegGetValueW(
            HKEY_CURRENT_USER, wide(KEY).as_ptr(), wide("AppsUseLightTheme").as_ptr(),
            RRF_RT_REG_DWORD, std::ptr::null_mut(), &mut v as *mut u32 as *mut _, &mut size,
        );
        return ok == 0 && v == 0;
    }
    #[cfg(not(windows))]
    false
}

/// 切到深色（true）或浅色（false）；应用和系统一起切
#[tauri::command]
pub fn system_theme_set(dark: bool) -> Result<(), String> {
    #[cfg(windows)]
    unsafe {
        use winapi::shared::minwindef::LPARAM;
        use winapi::um::winnt::REG_DWORD;
        use winapi::um::winreg::{RegSetKeyValueW, HKEY_CURRENT_USER};
        use winapi::um::winuser::{SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE};
        let v: u32 = if dark { 0 } else { 1 };
        for name in ["AppsUseLightTheme", "SystemUsesLightTheme"] {
            let r = RegSetKeyValueW(
                HKEY_CURRENT_USER, wide(KEY).as_ptr(), wide(name).as_ptr(), REG_DWORD,
                &v as *const u32 as *const _, std::mem::size_of::<u32>() as u32,
            );
            if r != 0 {
                return Err(format!("改注册表失败（{r}）"));
            }
        }
        let topic = wide("ImmersiveColorSet");
        let mut res = 0usize;
        SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0, topic.as_ptr() as LPARAM, SMTO_ABORTIFHUNG, 1000, &mut res);
    }
    Ok(())
}
