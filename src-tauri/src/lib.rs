// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet])
        .setup(|app| {
            // 1. 创建菜单项 (使用 Builder 模式)
            // "quit": ID 为 quit，显示文本 "退出"
            let quit_i = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            // "show": ID 为 show，显示文本 "显示主界面"
            let show_i = MenuItemBuilder::with_id("show", "显示主界面").build(app)?;

            // 2. 构建菜单
            let menu = MenuBuilder::new(app)
                .items(&[&show_i, &quit_i]) // 注意顺序：显示在上面，退出在下面
                .build()?;

            // 3. 构建托盘图标
            let _tray = TrayIconBuilder::new()
                // 设置图标 (这里复用应用的主图标)
                .icon(app.default_window_icon().unwrap().clone())
                // 绑定菜单
                .menu(&menu)
                // 允许左键点击显示菜单 (Windows 上习惯左键单击显示应用，右键显示菜单，这里可以根据需求调整)
                .show_menu_on_left_click(false)
                // 4. 处理菜单点击事件 (右键菜单项被点击)
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "quit" => {
                            app.exit(0); // 彻底退出程序
                        }
                        "show" => {
                            // 找到主窗口并显示、置顶
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        _ => {}
                    }
                })
                // 5. 处理托盘图标本身的点击事件
                .on_tray_icon_event(|tray, event| {
                    // 监听左键单击 (Left Click) 且是鼠标抬起 (Up) 的时刻
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        // 左键单击托盘图标：显示主窗口
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?; // 完成构建

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // 1. 阻止默认的关闭行为
                api.prevent_close();
                // 2. 隐藏窗口 (视觉效果等同于最小化到托盘)
                window.hide().unwrap();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
