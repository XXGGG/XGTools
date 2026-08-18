// XGTools 动态壁纸渲染器(独立轻量进程,tao + wry / WebView2)。
// 挂到桌面 WorkerW(图标背后)载入我们自己的 orb。仿 Wallpaper Engine:
// 当有全屏应用(游戏/视频)在前台时,通知 orb 暂停渲染 → 近乎 0 GPU 占用。
// 由 XGTools 主程序以 `--params "<orb 查询串>"` 启动;参数跟随 Studio 当前设置。
#![windows_subsystem = "windows"]
#![allow(non_snake_case)]

use std::borrow::Cow;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::time::{Duration, Instant};
use tao::{
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoop},
    platform::windows::WindowExtWindows,
    window::WindowBuilder,
};
use wry::WebViewBuilder;

// 编译期内联 orb(索引 + three + GPUComputationRenderer)。orb 改动后需重新构建本渲染器。
const ORB_INDEX: &str = include_str!("../../public/orb/index.html");
const ORB_THREE: &str = include_str!("../../public/orb/vendor/three.module.js");
const ORB_GPU: &str = include_str!("../../public/orb/vendor/GPUComputationRenderer.js");

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let params = args
        .iter()
        .position(|a| a == "--params")
        .and_then(|i| args.get(i + 1))
        .cloned()
        .unwrap_or_default();
    run_wallpaper(params);
}

fn run_wallpaper(params: String) {
    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("XGTools Wallpaper")
        .with_decorations(false)
        .with_visible(false) // 先隐藏,挂到 WorkerW 后再显示 → 不闪黑框
        .build(&event_loop)
        .expect("create window");

    let url = if params.is_empty() {
        "xgorb://orb/index.html?fs=1".to_string()
    } else {
        format!("xgorb://orb/index.html?{}&fs=1", params)
    };

    // 自定义协议 = 真 origin,ES 模块 / importmap 能跑
    let webview = WebViewBuilder::new(&window)
        .with_custom_protocol("xgorb".to_string(), |request| {
            let p = request.uri().path();
            let (body, mime): (&'static [u8], &str) = if p.ends_with("three.module.js") {
                (ORB_THREE.as_bytes(), "text/javascript")
            } else if p.ends_with("GPUComputationRenderer.js") {
                (ORB_GPU.as_bytes(), "text/javascript")
            } else {
                (ORB_INDEX.as_bytes(), "text/html")
            };
            wry::http::Response::builder()
                .header("Content-Type", mime)
                .header("Access-Control-Allow-Origin", "*")
                .body(Cow::Borrowed(body))
                .unwrap()
        })
        .with_url(&url)
        .build()
        .expect("create webview");

    attach_to_workerw(window.hwnd() as isize);

    let mut last_check = Instant::now();
    let mut paused = false;
    event_loop.run(move |event, _, control_flow| {
        // 每 ~800ms 醒来检查一次遮挡(平时不空转)
        *control_flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(800));
        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => *control_flow = ControlFlow::Exit,
            Event::NewEvents(_) => {
                if last_check.elapsed() >= Duration::from_millis(800) {
                    last_check = Instant::now();
                    let occ = is_fullscreen_occluded();
                    if occ != paused {
                        paused = occ;
                        // 通知 orb 暂停/恢复渲染(暂停时停 rAF → 近乎 0 GPU)
                        let js = format!("window.postMessage({{__storm:{{pause:{}}}}},'*')", if paused { 1 } else { 0 });
                        let _ = webview.evaluate_script(&js);
                    }
                }
            }
            _ => {}
        }
    });
}

// ===================== 遮挡检测(仿 Wallpaper Engine:全屏应用在前台就暂停)=====================
#[repr(C)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[link(name = "user32")]
extern "system" {
    fn FindWindowW(class: *const u16, window: *const u16) -> isize;
    fn FindWindowExW(parent: isize, after: isize, class: *const u16, window: *const u16) -> isize;
    fn SendMessageTimeoutW(h: isize, msg: u32, wp: usize, lp: isize, flags: u32, timeout: u32, res: *mut usize) -> isize;
    fn EnumWindows(cb: extern "system" fn(isize, isize) -> i32, l: isize) -> i32;
    fn SetParent(child: isize, parent: isize) -> isize;
    fn GetSystemMetrics(i: i32) -> i32;
    fn SetWindowPos(h: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
    fn GetClientRect(h: isize, r: *mut Rect) -> i32;
    fn GetForegroundWindow() -> isize;
    fn GetWindowRect(h: isize, r: *mut Rect) -> i32;
    fn GetClassNameW(h: isize, buf: *mut u16, max: i32) -> i32;
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 前台窗口是否全屏遮挡桌面(游戏/视频/全屏应用)→ 暂停壁纸。
fn is_fullscreen_occluded() -> bool {
    unsafe {
        let fg = GetForegroundWindow();
        if fg == 0 {
            return false;
        }
        // 桌面/任务栏/shell 不算遮挡
        let mut cls = [0u16; 128];
        let n = GetClassNameW(fg, cls.as_mut_ptr(), 128);
        if n > 0 {
            let name = String::from_utf16_lossy(&cls[..n as usize]);
            if name == "Progman" || name == "WorkerW" || name == "Shell_TrayWnd" || name == "Shell_SecondaryTrayWnd" {
                return false;
            }
        }
        let mut r = Rect { left: 0, top: 0, right: 0, bottom: 0 };
        if GetWindowRect(fg, &mut r) == 0 {
            return false;
        }
        let sw = GetSystemMetrics(0); // SM_CXSCREEN
        let sh = GetSystemMetrics(1); // SM_CYSCREEN
        // 覆盖整屏(含任务栏区域)→ 判定全屏应用
        (r.right - r.left) >= sw && (r.bottom - r.top) >= sh
    }
}

// ===================== 挂到桌面 WorkerW(图标背后)=====================
static WORKERW: AtomicIsize = AtomicIsize::new(0);

extern "system" fn enum_proc(hwnd: isize, _l: isize) -> i32 {
    unsafe {
        let defview = FindWindowExW(hwnd, 0, wide("SHELLDLL_DefView").as_ptr(), std::ptr::null());
        if defview != 0 {
            let worker = FindWindowExW(0, hwnd, wide("WorkerW").as_ptr(), std::ptr::null());
            if worker != 0 {
                WORKERW.store(worker, Ordering::SeqCst);
            }
        }
    }
    1
}

fn attach_to_workerw(hwnd: isize) {
    unsafe {
        let progman = FindWindowW(wide("Progman").as_ptr(), std::ptr::null());
        let mut res: usize = 0;
        SendMessageTimeoutW(progman, 0x052C, 0, 0, 0, 1000, &mut res);
        WORKERW.store(0, Ordering::SeqCst);
        EnumWindows(enum_proc, 0);
        let mut worker = WORKERW.load(Ordering::SeqCst);
        let mut insert_after: isize = 0; // HWND_TOP
        if worker == 0 {
            let mut ww = FindWindowExW(progman, 0, wide("WorkerW").as_ptr(), std::ptr::null());
            while ww != 0 {
                if FindWindowExW(ww, 0, wide("SHELLDLL_DefView").as_ptr(), std::ptr::null()) == 0 {
                    worker = ww;
                    break;
                }
                ww = FindWindowExW(progman, ww, wide("WorkerW").as_ptr(), std::ptr::null());
            }
            insert_after = 0;
        }
        if worker == 0 {
            worker = progman;
            insert_after = 1;
        }
        SetParent(hwnd, worker);
        let mut r = Rect { left: 0, top: 0, right: 0, bottom: 0 };
        GetClientRect(worker, &mut r);
        let cx = (r.right - r.left).max(GetSystemMetrics(78)).max(1);
        let cy = (r.bottom - r.top).max(GetSystemMetrics(79)).max(1);
        const BLEED: i32 = 4;
        SetWindowPos(hwnd, insert_after, -BLEED, -BLEED, cx + BLEED * 2, cy + BLEED * 2, 0x10 | 0x40);
    }
}
