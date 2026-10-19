//! 游戏模式用：前台是不是全屏程序、前台是哪个 exe。
//!
//! 全屏判断两条腿走：
//! 1. 系统自己的「免打扰」状态（SHQueryUserNotificationState）：D3D 独占全屏、全屏演示、全屏应用都会报。
//! 2. 前台窗口正好盖满它所在的那块屏幕（无边框窗口化的游戏系统不一定报 1，靠这条）。
//! 桌面和任务栏本身也是「盖满屏幕」的窗口，要排除。

use serde::Serialize;

#[derive(Serialize)]
pub struct Foreground {
    /// 前台程序的 exe 文件名（小写），拿不到是空串
    pub exe: String,
    /// 前台是不是全屏程序
    pub fullscreen: bool,
}

#[tauri::command]
pub fn foreground_info() -> Foreground {
    #[cfg(windows)]
    unsafe {
        use winapi::shared::windef::RECT;
        use winapi::um::handleapi::CloseHandle;
        use winapi::um::processthreadsapi::OpenProcess;
        use winapi::um::shellapi::SHQueryUserNotificationState;
        use winapi::um::winbase::QueryFullProcessImageNameW;
        use winapi::um::winnt::PROCESS_QUERY_LIMITED_INFORMATION;
        use winapi::um::winuser::*;

        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return Foreground { exe: String::new(), fullscreen: false };
        }

        // 前台 exe
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        let mut exe = String::new();
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if !h.is_null() {
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            if QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len) != 0 {
                let path = String::from_utf16_lossy(&buf[..len as usize]);
                exe = path.rsplit(['\\', '/']).next().unwrap_or("").to_lowercase();
            }
            CloseHandle(h);
        }

        // 桌面 / 任务栏不算
        let mut cls = [0u16; 64];
        let n = GetClassNameW(hwnd, cls.as_mut_ptr(), cls.len() as i32);
        let class = String::from_utf16_lossy(&cls[..n.max(0) as usize]);
        if hwnd == GetShellWindow() || hwnd == GetDesktopWindow() || class == "WorkerW" || class == "Progman" || class == "Shell_TrayWnd" {
            return Foreground { exe, fullscreen: false };
        }

        // 1. 系统免打扰状态：2 = 全屏应用（BUSY），3 = D3D 独占全屏，4 = 演示模式
        let mut state = 0i32;
        if SHQueryUserNotificationState(&mut state as *mut i32 as *mut _) == 0 && (2..=4).contains(&state) {
            return Foreground { exe, fullscreen: true };
        }

        // 2. 窗口盖满所在屏幕
        let mut wr: RECT = std::mem::zeroed();
        GetWindowRect(hwnd, &mut wr);
        let mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut mi: MONITORINFO = std::mem::zeroed();
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        let full = if !mon.is_null() && GetMonitorInfoW(mon, &mut mi) != 0 {
            let m = mi.rcMonitor;
            wr.left <= m.left && wr.top <= m.top && wr.right >= m.right && wr.bottom >= m.bottom
        } else {
            false
        };
        Foreground { exe, fullscreen: full }
    }
    #[cfg(not(windows))]
    Foreground { exe: String::new(), fullscreen: false }
}
