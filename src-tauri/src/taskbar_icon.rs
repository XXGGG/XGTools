//! 任务栏 / 托盘图标跟着 Windows 的深浅色走:深色任务栏用白口袋,浅色任务栏用黑口袋。
//! (和 Claude、Codex 的任务栏图标一个效果,2026-09-20 用户要的)
//!
//! 程序文件里只能固定放一张图标(icons/icon.ico,白口袋 —— 程序没开时,固定在任务栏上的、
//! 桌面快捷方式、开始菜单用的都是它)。程序开着的时候,这里读注册表里**任务栏**的深浅色,
//! 把主窗口图标(任务栏按钮、Alt+Tab)和托盘图标换成对应的那一张;系统一切换就跟着换。
//!
//! 看的是 `SystemUsesLightTheme`(管任务栏和开始菜单),不是 `AppsUseLightTheme`(管应用窗口)——
//! Windows 允许两者分开设,任务栏图标要对的是任务栏那一个。

use tauri::{image::Image, AppHandle, Emitter, Manager};

/// 深色任务栏用的白口袋、浅色任务栏用的黑口袋(64px,半透明磨砂款,由 scripts/icon/ 生成)
/// 开发版(pnpm tauri dev,debug 构建)换成右上角斜贴黄底「DEV」的那两张,
/// 和装好的正式版同时开着时,任务栏 / 托盘一眼分得清(2026-10-11 用户要的,学 Edge 开发版)。
/// 带 DEV 的那两张(icons/taskbar-{white,black}-dev.png)也是 scripts/icon/ 一起生成的
#[cfg(debug_assertions)]
const WHITE: &[u8] = include_bytes!("../icons/taskbar-white-dev.png");
#[cfg(debug_assertions)]
const BLACK: &[u8] = include_bytes!("../icons/taskbar-black-dev.png");
#[cfg(not(debug_assertions))]
const WHITE: &[u8] = include_bytes!("../icons/taskbar-white.png");
#[cfg(not(debug_assertions))]
const BLACK: &[u8] = include_bytes!("../icons/taskbar-black.png");

/// 托盘图标的 id,tray.rs 建托盘时用它,这里换图标时按它找
pub const TRAY_ID: &str = "main";

/// 启动时按当前深浅色换一次,然后在后台一直等系统切换
pub fn start(app: &AppHandle) {
    apply(app, reg::light_taskbar());
    #[cfg(windows)]
    {
        let app = app.clone();
        std::thread::spawn(move || watch(app));
    }
}

fn apply(app: &AppHandle, light: bool) {
    let Ok(img) = Image::from_bytes(if light { BLACK } else { WHITE }) else {
        return;
    };
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_icon(img.clone());
    }
    if let Some(t) = app.tray_by_id(TRAY_ID) {
        let _ = t.set_icon(Some(img));
    }
    let _ = app.emit("taskbar-icon-theme", if light { "light" } else { "dark" });
}

/// 注册表那个键下面一有值被改就醒一次,深浅色真变了才换(切一次主题会连着写好几个值)
#[cfg(windows)]
fn watch(app: AppHandle) {
    let Some(key) = reg::open() else { return };
    let mut last = reg::light(&key);
    while reg::wait(&key) {
        let now = reg::light(&key);
        if now != last {
            last = now;
            apply(&app, now);
        }
    }
}

#[cfg(windows)]
mod reg {
    use std::ptr::null_mut;
    use winapi::shared::minwindef::{DWORD, FALSE, HKEY};
    use winapi::um::winnt::{KEY_NOTIFY, KEY_READ, REG_NOTIFY_CHANGE_LAST_SET};
    use winapi::um::winreg::{
        RegCloseKey, RegNotifyChangeKeyValue, RegOpenKeyExW, RegQueryValueExW, HKEY_CURRENT_USER,
    };

    const SUB: &str = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    pub struct Key(HKEY);
    impl Drop for Key {
        fn drop(&mut self) {
            unsafe { RegCloseKey(self.0) };
        }
    }

    pub fn open() -> Option<Key> {
        let sub = wide(SUB);
        let mut key: HKEY = null_mut();
        let rc = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, sub.as_ptr(), 0, KEY_READ | KEY_NOTIFY, &mut key) };
        (rc == 0).then(|| Key(key))
    }

    /// 任务栏是不是浅色。读不到(老系统没有这个值)就当深色 —— Windows 默认任务栏就是深色的
    pub fn light(key: &Key) -> bool {
        let name = wide("SystemUsesLightTheme");
        let mut data: DWORD = 0;
        let mut len = std::mem::size_of::<DWORD>() as DWORD;
        let rc = unsafe {
            RegQueryValueExW(key.0, name.as_ptr(), null_mut(), null_mut(), &mut data as *mut DWORD as *mut u8, &mut len)
        };
        rc == 0 && data != 0
    }

    pub fn light_taskbar() -> bool {
        open().map(|k| light(&k)).unwrap_or(false)
    }

    /// 阻塞,直到这个键下面有值被改;出错返回 false(调用方就不再等了)
    pub fn wait(key: &Key) -> bool {
        unsafe { RegNotifyChangeKeyValue(key.0, FALSE, REG_NOTIFY_CHANGE_LAST_SET, null_mut(), FALSE) == 0 }
    }
}

#[cfg(not(windows))]
mod reg {
    pub fn light_taskbar() -> bool {
        false
    }
}
