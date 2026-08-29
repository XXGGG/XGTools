//! 系统托盘。
//!
//! **菜单不用系统原生的那套。** 原生菜单的位置、字号、圆角、配色全归系统管:
//! 字号圆角跟应用里对不上是次要的,真正的问题是**位置** —— Windows 上它会被
//! 任务栏挡住,而我们改不了。
//!
//! 所以改成点托盘时把一个无边框小窗口挪到鼠标旁边显示,内容是我们自己的
//! Vue 组件(前端的 `tray-menu` 窗口),失焦就收起来。做法参考 XGRime。
//!
//! 定位**跟着鼠标走,不用系统给的托盘矩形**:多显示器、任务栏靠左右两侧、
//! 各屏 DPI 不一样的时候,那个矩形经常不是你以为的位置。鼠标刚点完托盘,
//! 跟着它最稳。

use std::sync::Mutex;

use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

/// 上次点托盘时鼠标在哪。
///
/// 菜单要贴着这个点摆。存下来是因为窗口高度是前端量完内容之后才改的 ——
/// 改完得按新高度重新贴一次,那时候鼠标可能已经挪开了。
static ANCHOR: Mutex<Option<(f64, f64)>> = Mutex::new(None);

const MENU: &str = "tray-menu";
/// 菜单窗口四周留给阴影的透明边,逻辑像素。
/// 跟前端那层 `p-3` 是同一个数,改一边就得改另一边。
const MENU_PADDING: f64 = 12.0;

pub fn setup(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(menu) = app.get_webview_window(MENU) {
        let handle = app.clone();
        // 点到别处就收起来。不这么做的话它会一直浮在最上面盖住别的窗口。
        menu.on_window_event(move |e| {
            if let tauri::WindowEvent::Focused(false) = e {
                if let Some(w) = handle.get_webview_window(MENU) {
                    let _ = w.hide();
                }
            }
        });
    }

    TrayIconBuilder::new()
        .icon(app.default_window_icon().cloned().ok_or_else(|| {
            tauri::Error::AssetNotFound("默认窗口图标不在".into())
        })?)
        .tooltip("XGTools")
        .on_tray_icon_event(|tray, event| {
            let app = tray.app_handle();
            match event {
                // 左右键弹同一个菜单。没接原生菜单了,右键不能落空。
                TrayIconEvent::Click {
                    button: MouseButton::Left | MouseButton::Right,
                    button_state: MouseButtonState::Up,
                    ..
                } => show_menu(app),
                TrayIconEvent::DoubleClick { .. } => show_main(app),
                _ => {}
            }
        })
        .build(app)?;
    Ok(())
}

fn show_menu(app: &tauri::AppHandle) {
    let Some(win) = app.get_webview_window(MENU) else {
        return;
    };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        return;
    }
    if let Ok(cursor) = app.cursor_position() {
        *ANCHOR.lock().unwrap() = Some((cursor.x, cursor.y));
    }
    place(app);
    let _ = win.show();
    let _ = win.set_focus();
}

/// 把菜单窗口的右下角贴到锚点的左上方。
fn place(app: &tauri::AppHandle) {
    let (Some(win), Some((ax, ay))) = (app.get_webview_window(MENU), *ANCHOR.lock().unwrap()) else {
        return;
    };
    let Ok(size) = win.outer_size() else { return };
    let scale = win.scale_factor().unwrap_or(1.0);
    // 窗口比看得见的卡片大一圈:那圈透明留白是给阴影的(前端的 p-3)。
    // 按窗口边缘定位的话,卡片实际离鼠标要再远这么多,看着就是「飘着」。
    // 所以先把留白加回去,再减掉真正想留的那点距离。
    let pad = (MENU_PADDING * scale) as i32;
    let gap = (4.0 * scale) as i32;
    // 往左上角摆:托盘在右下角,直接放鼠标右下会跑出屏幕。
    // .max(0) 是兜底 —— 任务栏在顶部或左侧时算出来会是负数。
    let x = (ax as i32 - size.width as i32 + pad - gap).max(0);
    let y = (ay as i32 - size.height as i32 + pad - gap).max(0);
    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
}

/// 前端按内容改完高度之后叫一次,按新高度重新贴。
///
/// 不重贴的话,窗口是左上角定位的:高度一变下边缘就跟着跑,
/// 卡片要么离鼠标老远、要么压到鼠标上。
#[tauri::command]
pub fn anchor_tray_menu(app: tauri::AppHandle) {
    place(&app);
}

#[tauri::command]
pub fn hide_tray_menu(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window(MENU) {
        let _ = w.hide();
    }
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        crate::window_effects::kick_backdrop(&w);
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[tauri::command]
pub fn tray_show_main(app: tauri::AppHandle) {
    hide_tray_menu(app.clone());
    show_main(&app);
}

/// 主窗口的首次亮相。
///
/// 主窗口配置里是 `visible: false`,前端把设置读完、材质贴好之后才调这个。
/// 和 `show_main` 的差别在**抢前台**:窗口是启动几秒之后才 show 的,这时候
/// Windows 未必还认我们是「刚被用户启动的进程」,`SetForegroundWindow` 会被
/// 拒绝,窗口显示出来却压在别的窗口底下。先模拟一次 Alt 按键再要焦点是
/// 公认的解法(快捷键那边也在用同一招),系统就肯把前台给我们了。
#[tauri::command]
pub fn reveal_main(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        #[cfg(windows)]
        {
            use winapi::um::winuser::{keybd_event, KEYEVENTF_KEYUP, VK_MENU};
            unsafe {
                keybd_event(VK_MENU as u8, 0, 0, 0);
                keybd_event(VK_MENU as u8, 0, KEYEVENTF_KEYUP, 0);
            }
        }
        let _ = w.set_focus();
    }
}

/// 开/关启动台。
///
/// **只摆位 + 喊一声,不在这里 show** —— 显示与否归前端那个 __toggleDock。
/// 两处都管显示的话状态会对不上,启动台就再也关不掉了(踩过)。
#[tauri::command]
pub fn tray_toggle_dock(app: tauri::AppHandle) {
    hide_tray_menu(app.clone());
    if let Some(win) = app.get_webview_window("dock") {
        crate::fullscreen_borderless(&win);
    }
    let _ = app.emit("toggle-dock", true);
}

#[tauri::command]
pub fn tray_open_palette(app: tauri::AppHandle) {
    hide_tray_menu(app.clone());
    if let Some(win) = app.get_webview_window("palette") {
        let _ = win.eval("window.__togglePalette && window.__togglePalette()");
    }
}

#[tauri::command]
pub fn tray_screenshot(app: tauri::AppHandle) {
    hide_tray_menu(app.clone());
    let _ = app.emit("execute-screenshot", ());
}

/// 卡住时的总闸:把所有浮层一次收干净。
///
/// 合并了原来的「强制结束截图」和「关闭启动台」—— 它们本来就是同一个用途,
/// 而且以后每加一个浮层就得多一行菜单,不如做成一项。
#[tauri::command]
pub fn tray_force_close_overlays(app: tauri::AppHandle) {
    hide_tray_menu(app.clone());

    // 截图窗口:先解掉置顶再挪到屏幕外,最后才 hide。
    // 只 hide 的话,它在某些状态下会留着一层吃鼠标事件的透明层。
    if let Some(win) = app.get_webview_window("screenshot") {
        let _ = win.set_always_on_top(false);
        let _ = win.set_position(tauri::PhysicalPosition::new(-10000i32, -10000i32));
        let _ = win.hide();
    }
    let _ = app.emit("force-cancel-screenshot", ());

    // 启动台:这里可以直接 hide —— 这是「总闸」,不是切换,
    // 不需要和前端商量。同时喊一声让前端把 isVisible 归位,否则下次
    // 按快捷键它会以为还开着。
    if let Some(win) = app.get_webview_window("dock") {
        let _ = win.hide();
    }
    let _ = app.emit("force-close-dock", ());

    if let Some(win) = app.get_webview_window("palette") {
        let _ = win.hide();
    }
}

#[tauri::command]
pub fn tray_quit(app: tauri::AppHandle) {
    app.exit(0);
}

/// 截图窗口的「重启」:整个 webview 原地重载,监听器、状态全部从头来。
///
/// 现象:截图快捷键偶尔按了没反应 —— Rust 这边键明明注册着、事件也发出去了,
/// 是截图窗口那头的监听器没了(热重载、长时间挂着之后都见过)。重载这一个窗口
/// 比重启整个程序便宜得多。先解掉置顶挪到屏幕外再重载,免得重载途中露出一层
/// 透明的截图窗口吃鼠标。
#[tauri::command]
pub fn reload_screenshot_window(app: tauri::AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window("screenshot")
        .ok_or_else(|| "截图窗口不存在".to_string())?;
    let _ = win.set_always_on_top(false);
    let _ = win.set_position(tauri::PhysicalPosition::new(-10000i32, -10000i32));
    let _ = win.hide();
    win.eval("location.reload()").map_err(|e| e.to_string())
}
