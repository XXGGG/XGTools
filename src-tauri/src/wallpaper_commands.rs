// 动态壁纸(启动独立渲染器进程挂到 WorkerW,仿 Wallpaper Engine)+ 定时屏保(闲置检测弹全屏球窗)。
// 壁纸走独立进程 `xgtools-wallpaper`(native/,tao+wry)——句柄同步可靠、SetParent 稳、退应用仍保留、
// 且能在全屏应用前台时暂停渲染省 GPU。屏保仍在应用进程内(复用 Tauri 窗)。
#![allow(non_snake_case)]

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

// ===================== 动态壁纸(独立进程)=====================
pub struct WallpaperProc(pub Mutex<Option<std::process::Child>>);
impl Default for WallpaperProc {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

// 定位壁纸渲染器:生产=主程序旁(externalBin 去三元组后缀);开发=native 相对路径。
#[cfg(windows)]
fn locate_wallpaper_exe() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    if let Some(dir) = exe.parent() {
        for name in ["xgtools-wallpaper.exe", "xgtools-wallpaper-x86_64-pc-windows-msvc.exe"] {
            let p = dir.join(name);
            if p.exists() {
                return Some(p);
            }
        }
    }
    for up in 3..9 {
        if let Some(root) = exe.ancestors().nth(up) {
            let p = root.join("native/target/release/xgtools-wallpaper.exe");
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}

// 结束所有壁纸渲染进程(含上次会话残留),不弹控制台。
#[cfg(windows)]
fn kill_all_wallpaper() {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = std::process::Command::new("taskkill")
        .args(["/IM", "xgtools-wallpaper.exe", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

/// 开启动态壁纸:启动独立渲染器,把当前设置(查询串)透传过去。壁纸挂桌面图标背后,退应用仍保留。
#[tauri::command]
pub fn start_wallpaper(state: tauri::State<WallpaperProc>, query: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        if let Some(mut c) = guard.take() {
            let _ = c.kill();
        }
        kill_all_wallpaper(); // 清掉残留,保证屏上只有一份最新的
        let exe = locate_wallpaper_exe()
            .ok_or("找不到壁纸渲染器:请先在 XGTools/native 执行 cargo build --release")?;
        let mut cmd = std::process::Command::new(&exe);
        if !query.is_empty() {
            cmd.arg("--params").arg(&query);
        }
        let child = cmd.spawn().map_err(|e| e.to_string())?;
        *guard = Some(child);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (state, query);
        Err("动态壁纸目前仅 Windows 实现".into())
    }
}

/// 停止动态壁纸(结束渲染器进程,含跨会话残留)。
#[tauri::command]
pub fn stop_wallpaper(state: tauri::State<WallpaperProc>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let _ = guard.take().map(|mut c| c.kill());
    #[cfg(windows)]
    kill_all_wallpaper();
    Ok(())
}

// ===================== 定时屏保(闲置检测,应用进程内)=====================
#[cfg(windows)]
#[repr(C)]
struct LastInputInfo {
    cb_size: u32,
    dw_time: u32,
}
#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn GetLastInputInfo(plii: *mut LastInputInfo) -> i32;
}
#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetTickCount() -> u32;
}

pub struct SaverState {
    enabled: AtomicBool,
    minutes: AtomicU32,
    query: Mutex<String>,
    started: AtomicBool,
}
impl Default for SaverState {
    fn default() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            minutes: AtomicU32::new(5),
            query: Mutex::new(String::new()),
            started: AtomicBool::new(false),
        }
    }
}

#[cfg(windows)]
fn idle_ms() -> u32 {
    unsafe {
        let mut lii = LastInputInfo { cb_size: 8, dw_time: 0 };
        GetLastInputInfo(&mut lii);
        GetTickCount().wrapping_sub(lii.dw_time)
    }
}

/// 开启/更新定时屏保。系统级闲置到 minutes 分钟 → 通知前端弹全屏球;有输入 → 收起。
#[tauri::command]
pub fn start_screensaver(app: AppHandle, minutes: u32, query: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        let state = app.state::<SaverState>();
        state.minutes.store(minutes.max(1), Ordering::SeqCst);
        *state.query.lock().map_err(|e| e.to_string())? = query;
        state.enabled.store(true, Ordering::SeqCst);
        if !state.started.swap(true, Ordering::SeqCst) {
            let app2 = app.clone();
            std::thread::spawn(move || {
                let mut showing = false;
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    let st = app2.state::<SaverState>();
                    if !st.enabled.load(Ordering::SeqCst) {
                        if showing {
                            let _ = app2.emit("saver-hide", ());
                            showing = false;
                        }
                        continue;
                    }
                    let thresh = st.minutes.load(Ordering::SeqCst).saturating_mul(60_000);
                    let idle = idle_ms();
                    if !showing && idle >= thresh {
                        let q = st.query.lock().map(|s| s.clone()).unwrap_or_default();
                        let _ = app2.emit("saver-show", q);
                        showing = true;
                    } else if showing && idle < 900 {
                        let _ = app2.emit("saver-hide", ());
                        showing = false;
                    }
                }
            });
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, minutes, query);
        Err("定时屏保目前仅 Windows 实现".into())
    }
}

/// 关闭定时屏保。
#[tauri::command]
pub fn stop_screensaver(app: AppHandle) -> Result<(), String> {
    let state = app.state::<SaverState>();
    state.enabled.store(false, Ordering::SeqCst);
    let _ = app.emit("saver-hide", ());
    Ok(())
}
