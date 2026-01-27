// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

use std::thread; // 引入线程库，用于在后台运行输入监听
use rdev::{listen, EventType}; // 引入 rdev 库
use tauri::Emitter; // 记得引入这个，用于发送事件到前端
// Emitter 用于发送事件到前端，如按键事件、鼠标事件等

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

// 定义发送给前端的数据结构
#[derive(serde::Serialize, Clone)]
struct InputPayload {
    event_type: String,
    key: String,
}

// 初始化监听器函数
fn init_input_listener(app: tauri::AppHandle) {
    thread::spawn(move || {
        // listen 会阻塞当前线程，所以必须放在 thread::spawn 里
        if let Err(error) = listen(move |event| {
            let payload = match event.event_type {
                // KeyPress 是按键按下事件，我们监听它
                EventType::KeyPress(key) => Some(InputPayload {
                    event_type: "KeyPress".to_string(),
                    key: format!("{:?}", key), // 格式化为 KeyA, Num1 等
                }),
                // KeyRelease 是按键释放事件，我们也监听它
                EventType::KeyRelease(key) => Some(InputPayload {
                    event_type: "KeyRelease".to_string(),
                    key: format!("{:?}", key),
                }),
                // 我们也可以监听鼠标，但为了性能，这里只演示按键
                EventType::ButtonPress(btn) => Some(InputPayload {
                    event_type: "ButtonPress".to_string(),
                    key: format!("{:?}", btn),
                }),
                // ButtonRelease 是鼠标按钮释放事件，我们也监听它
                EventType::ButtonRelease(btn) => Some(InputPayload {
                    event_type: "ButtonRelease".to_string(),
                    key: format!("{:?}", btn),
                }),
                _ => None,
            };
            
            if let Some(p) = payload {
                // 发送事件给所有窗口
                let _ = app.emit("input-event", p);
            }
        }) {
            println!("Error: {:?}", error);
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet])
        .setup(|app| {
            // 初始化输入监听器
            init_input_listener(app.handle().clone());

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
