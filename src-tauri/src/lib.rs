mod dock_commands;

#[cfg(windows)]
mod icon_extractor;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

use std::thread;
use rdev::{listen, EventType};
use tauri::Emitter;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            dock_commands::refresh_all_icons,
            dock_commands::update_acrylic,
            dock_commands::save_custom_icon,
            dock_commands::get_custom_icons,
            dock_commands::delete_custom_icon,
            dock_commands::rename_custom_icon,
        ])
        .setup(|app| {
            // --- Input listener (for key visualizer) ---
            init_input_listener(app.handle().clone());

            // --- System Tray ---
            // 原生菜单作为右键菜单项，前端监听菜单事件
            let show_main = MenuItem::with_id(app, "show", "打开主界面", true, None::<&str>)?;
            let show_dock = MenuItem::with_id(app, "show_dock", "显示启动台", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_main, &show_dock, &quit])?;

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
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    // 左键：打开主窗口
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

            // --- Global Shortcut for Dock ---
            let shortcut_str = settings_ref
                .map(|s| s.shortcut.clone())
                .unwrap_or_else(|| "Ctrl+Alt+D".to_string());

            let shortcut = dock_commands::parse_shortcut_str(&shortcut_str)
                .unwrap_or_else(|_| {
                    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};
                    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyD)
                });

            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(move |app, _shortcut, event| {
                        if event.state() == ShortcutState::Pressed {
                            #[cfg(windows)]
                            {
                                use winapi::um::winuser::{keybd_event, KEYEVENTF_KEYUP, VK_MENU, VK_CONTROL};
                                unsafe {
                                    keybd_event(VK_MENU as u8, 0, KEYEVENTF_KEYUP, 0);
                                    keybd_event(VK_CONTROL as u8, 0, KEYEVENTF_KEYUP, 0);
                                }
                            }
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
            app.global_shortcut().register(shortcut)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    window.hide().unwrap();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
