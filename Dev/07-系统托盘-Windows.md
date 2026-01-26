# 系统托盘-Windows

在 Windows 上，系统托盘就是任务栏右下角那个显示小图标的区域。Tauri 2.0 提供了强大的 API 来实现这一功能。

为了实现最佳实践，我们需要按照以下步骤进行配置。

### 1. 启用 Cargo 特性 (`src-tauri/Cargo.toml`)

Tauri v2 默认为了减小体积，不包含托盘图标功能。你需要手动在 `Cargo.toml` 中开启它。

找到 `[dependencies]` 下的 `tauri` 依赖，修改如下：

```toml
[dependencies]
tauri = { version = "2", features = ["tray-icon"] } # 必须添加 "tray-icon" 特性
```

### 2. 修改后端代码 (`src-tauri/src/lib.rs`)

我们需要在 Rust 后端配置托盘图标、菜单以及相应的事件处理。

**第一步：引入必要的库**

在文件顶部添加以下引用，确保使用 `MenuBuilder` 和 `MenuItemBuilder` 来构建菜单，这是 v2 的推荐写法：

```rust
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;
```

**第二步：配置 `setup` 钩子**

在 `run()` 函数的 `.setup()` 钩子中初始化托盘：

```rust
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
            } = event {
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
```

### 3. 优化窗口关闭行为

默认情况下，用户点击窗口右上角的 "X" 会直接结束进程。对于有系统托盘的应用，通常期望的行为是“最小化到托盘”。

我们需要拦截窗口关闭事件：

```rust
// 在 lib.rs 的 Builder 链中添加：
.on_window_event(|window, event| {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        // 1. 阻止默认的关闭行为
        api.prevent_close();
        // 2. 隐藏窗口 (视觉效果等同于最小化到托盘)
        window.hide().unwrap();
    }
})
```

### 完整示例结构

你的 `src-tauri/src/lib.rs` 最终结构应该类似这样：
期望位置：所有的配置方法（如 .plugin()、.invoke_handler()、.setup()、.on_window_event()）都必须在调用 .run() 之前完成。
```rust
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // ... (上面 setup 中的代码) ...
            let quit_i = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let show_i = MenuItemBuilder::with_id("show", "显示主界面").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&show_i, &quit_i]).build()?;
            
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "quit" => app.exit(0),
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                window.hide().unwrap();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```
