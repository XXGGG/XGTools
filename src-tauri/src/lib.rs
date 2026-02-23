mod dock_commands;
mod screenshot_commands;
mod ocr_commands;
mod window_detect;
mod translate_commands;
mod convert_commands;

#[cfg(windows)]
mod icon_extractor;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

use std::thread;
use rdev::{listen, EventType};
use tauri::Emitter;

use std::sync::{Arc, Mutex};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[derive(serde::Serialize, Clone)]
struct InputPayload {
    event_type: String,
    key: String,
}

fn init_input_listener(app: tauri::AppHandle) {
    thread::spawn(move || {
        if let Err(error) = listen(move |event| {
            let payload = match event.event_type {
                EventType::KeyPress(key) => Some(InputPayload {
                    event_type: "KeyPress".to_string(),
                    key: format!("{:?}", key),
                }),
                EventType::KeyRelease(key) => Some(InputPayload {
                    event_type: "KeyRelease".to_string(),
                    key: format!("{:?}", key),
                }),
                EventType::ButtonPress(btn) => Some(InputPayload {
                    event_type: "ButtonPress".to_string(),
                    key: format!("{:?}", btn),
                }),
                EventType::ButtonRelease(btn) => Some(InputPayload {
                    event_type: "ButtonRelease".to_string(),
                    key: format!("{:?}", btn),
                }),
                _ => None,
            };

            if let Some(p) = payload {
                let _ = app.emit("input-event", p);
            }
        }) {
            println!("Error: {:?}", error);
        }
    });
}

/// 照搬 Snow-Shot：在截图窗口创建后禁用 DWM 过渡动画
#[cfg(windows)]
fn disable_dwm_transitions(window: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED};

    if let Ok(hwnd) = window.hwnd() {
        let hwnd = HWND(hwnd.0);
        let disable: i32 = 1;
        unsafe {
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_TRANSITIONS_FORCEDISABLED,
                &disable as *const _ as *const _,
                std::mem::size_of::<i32>() as u32,
            );
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ocr_commands::OcrState {
            ocr: std::sync::Mutex::new(None),
            initializing: std::sync::atomic::AtomicBool::new(false),
        })
        .manage(window_detect::ComThread::spawn())
        .manage(convert_commands::ConvertState {
            cancel_flags: std::sync::Mutex::new(std::collections::HashMap::new()),
        })
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            // Dock commands
            dock_commands::get_apps,
            dock_commands::save_apps,
            dock_commands::launch_app,
            dock_commands::extract_icon,
            dock_commands::resolve_lnk,
            dock_commands::get_apps_dir,
            dock_commands::scan_start_menu,
            dock_commands::get_start_menu_cache,
            dock_commands::extract_start_menu_icon,
            dock_commands::save_start_menu_cache,
            dock_commands::get_settings,
            dock_commands::save_settings,
            dock_commands::update_shortcut,
            dock_commands::update_all_shortcuts,
            dock_commands::refresh_all_icons,
            dock_commands::update_acrylic,
            dock_commands::save_custom_icon,
            dock_commands::get_custom_icons,
            dock_commands::delete_custom_icon,
            dock_commands::rename_custom_icon,
            // Screenshot commands
            screenshot_commands::get_cursor_position,
            screenshot_commands::capture_screen,
            screenshot_commands::get_monitor_info,
            screenshot_commands::copy_screenshot_to_clipboard,
            screenshot_commands::copy_rgba_to_clipboard,
            screenshot_commands::save_screenshot,
            screenshot_commands::save_screenshot_to_path,
            screenshot_commands::save_screenshot_file,
            screenshot_commands::cleanup_temp_screenshot,
            // OCR commands
            ocr_commands::ocr_init,
            ocr_commands::ocr_detect,
            ocr_commands::ocr_release,
            // Window detection
            window_detect::init_ui_elements,
            window_detect::init_ui_elements_cache,
            window_detect::get_element_from_position,
            window_detect::get_visible_windows,
            // Translate
            translate_commands::translate,
            translate_commands::list_models,
            // Convert
            convert_commands::detect_file_type,
            convert_commands::probe_file,
            convert_commands::convert_image,
            convert_commands::convert_media,
            convert_commands::scan_folder,
            convert_commands::get_ffmpeg_path,
            convert_commands::check_ffmpeg,
            convert_commands::download_ffmpeg,
            convert_commands::cancel_convert,
            convert_commands::resolve_output_dir,
        ])
        .setup(|app| {
            // --- Input listener (for key visualizer) ---
            init_input_listener(app.handle().clone());

            // --- System Tray ---
            let show_main = MenuItem::with_id(app, "show", "打开主界面", true, None::<&str>)?;
            let show_dock = MenuItem::with_id(app, "show_dock", "显示启动台", true, None::<&str>)?;
            let force_close_screenshot = MenuItem::with_id(app, "force_close_screenshot", "强制结束截图", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&force_close_screenshot, &show_main, &show_dock, &quit])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("XGTools")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "quit" => {
                            app.exit(0);
                        }
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "show_dock" => {
                            let _ = app.emit("toggle-dock", true);
                            if let Some(win) = app.get_webview_window("dock") {
                                let _ = win.maximize();
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                        "force_close_screenshot" => {
                            // 强制关闭截图窗口
                            if let Some(win) = app.get_webview_window("screenshot") {
                                use tauri::PhysicalPosition;
                                let _ = win.set_always_on_top(false);
                                let _ = win.set_position(PhysicalPosition::new(-10000i32, -10000i32));
                                let _ = win.hide();
                            }
                            // 通知前端重置状态
                            let _ = app.emit("force-cancel-screenshot", ());
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // --- Ensure app data directory exists (for Dock) ---
            let app_dir = app.path().app_data_dir()?;
            if !app_dir.exists() {
                std::fs::create_dir_all(&app_dir)?;
            }
            let icons_dir = app_dir.join("icons");
            if !icons_dir.exists() {
                std::fs::create_dir_all(&icons_dir)?;
            }
            let apps_file = app_dir.join("apps.json");
            if !apps_file.exists() {
                std::fs::write(&apps_file, "[]")?;
            }

            // --- Read dock settings ---
            let dock_settings = {
                let settings_file = app_dir.join("settings.json");
                if settings_file.exists() {
                    std::fs::read_to_string(&settings_file)
                        .ok()
                        .and_then(|content| serde_json::from_str::<dock_commands::Settings>(&content).ok())
                } else {
                    None
                }
            };
            let settings_ref = dock_settings.as_ref();

            // --- Apply window vibrancy effect on dock window ---
            #[cfg(windows)]
            if let Some(win) = app.get_webview_window("dock") {
                use window_vibrancy::apply_acrylic;
                let (r, g, b, a) = settings_ref
                    .map(|s| (s.acrylic_r, s.acrylic_g, s.acrylic_b, s.acrylic_a))
                    .unwrap_or((0, 0, 0, 180));
                let _ = apply_acrylic(&win, Some((r, g, b, a)));
            }

            // --- 截图窗口：禁用 DWM 过渡动画（照搬 Snow-Shot） ---
            #[cfg(windows)]
            if let Some(win) = app.get_webview_window("screenshot") {
                disable_dwm_transitions(&win);
                let _ = win.hide();
            }

            // --- Global Shortcuts ---

            // 1. 读取 Dock 快捷键（从 Dock settings.json）
            let dock_shortcut_str = settings_ref
                .map(|s| s.shortcut.clone())
                .unwrap_or_else(|| "Ctrl+Alt+D".to_string());

            let dock_shortcut = dock_commands::parse_shortcut_str(&dock_shortcut_str)
                .unwrap_or_else(|_| {
                    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};
                    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyD)
                });

            // 2. 读取截图/截图翻译快捷键（从 tauri-plugin-store 的 settings.json）
            let store_file = app_dir.join("settings.json");
            let store_json: Option<serde_json::Value> = if store_file.exists() {
                std::fs::read_to_string(&store_file)
                    .ok()
                    .and_then(|c| serde_json::from_str(&c).ok())
            } else {
                None
            };

            let screenshot_shortcut_str = store_json.as_ref()
                .and_then(|v| v.get("screenshot_shortcut"))
                .and_then(|v| v.as_str())
                .unwrap_or("Ctrl+Alt+A");

            let screenshot_shortcut = dock_commands::parse_shortcut_str(screenshot_shortcut_str)
                .unwrap_or_else(|_| {
                    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};
                    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyA)
                });

            let screenshot_translate_enabled = store_json.as_ref()
                .and_then(|v| v.get("screenshot_translate_enabled"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            let screenshot_translate_shortcut = if screenshot_translate_enabled {
                store_json.as_ref()
                    .and_then(|v| v.get("screenshot_translate_shortcut"))
                    .and_then(|v| v.as_str())
                    .and_then(|s| dock_commands::parse_shortcut_str(s).ok())
            } else {
                None
            };

            // 3. 创建共享快捷键绑定
            let bindings = Arc::new(Mutex::new(dock_commands::ShortcutBindings {
                dock: Some(dock_shortcut),
                screenshot: Some(screenshot_shortcut),
                screenshot_translate: screenshot_translate_shortcut,
            }));
            app.manage(bindings.clone());

            // 4. 注册快捷键 handler（通过 Arc<Mutex<>> 动态派发）
            let bindings_ref = bindings.clone();
            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(move |app, shortcut, event| {
                        // 仿 Snow-Shot: 只在 Released 时触发（防长按重复触发）
                        if event.state() != ShortcutState::Released {
                            return;
                        }

                        #[cfg(windows)]
                        {
                            use winapi::um::winuser::{keybd_event, KEYEVENTF_KEYUP, VK_MENU, VK_CONTROL};
                            unsafe {
                                keybd_event(VK_MENU as u8, 0, KEYEVENTF_KEYUP, 0);
                                keybd_event(VK_CONTROL as u8, 0, KEYEVENTF_KEYUP, 0);
                            }
                        }

                        let b = bindings_ref.lock().unwrap();
                        if b.screenshot.as_ref() == Some(shortcut) {
                            let _ = app.emit("execute-screenshot", ());
                        } else if b.screenshot_translate.as_ref() == Some(shortcut) {
                            let _ = app.emit("execute-screenshot-translate", ());
                        } else if b.dock.as_ref() == Some(shortcut) {
                            if let Some(win) = app.get_webview_window("dock") {
                                let _ = win.maximize();
                                let _ = win.show();
                                let _ = win.set_focus();
                                let _ = win.eval("window.__toggleDock && window.__toggleDock()");
                            }
                        }
                    })
                    .build(),
            )?;

            // 5. 注册所有快捷键
            app.global_shortcut().register(dock_shortcut)?;
            app.global_shortcut().register(screenshot_shortcut)?;
            if let Some(sc) = screenshot_translate_shortcut {
                app.global_shortcut().register(sc)?;
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let label = window.label();
                if label == "main" || label == "screenshot" {
                    // 主窗口和截图窗口不真正关闭，只是隐藏
                    api.prevent_close();
                    window.hide().unwrap();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
