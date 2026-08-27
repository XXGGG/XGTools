mod dock_commands;
mod screenshot_commands;
mod ocr_commands;
mod window_detect;
mod translate_commands;
mod convert_commands;
mod window_effects;
mod dsh_commands;
mod dsh_bridge;
mod vault_commands;
mod vault_attach;
mod vault_history;
mod vault_trash;
mod vault_watch;
mod file_search_commands;
mod tray;

#[cfg(windows)]
mod icon_extractor;

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

/// 无边框全屏：将窗口设为整个主显示器大小（覆盖任务栏）
pub(crate) fn fullscreen_borderless(window: &tauri::WebviewWindow) {
    use tauri::{PhysicalPosition, PhysicalSize};
    if let Ok(Some(monitor)) = window.primary_monitor() {
        let pos = monitor.position();
        let size = monitor.size();
        let _ = window.set_position(PhysicalPosition::new(pos.x, pos.y));
        let _ = window.set_size(PhysicalSize::new(size.width, size.height));
    }
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
        .manage(dsh_commands::DshSidecar::default())
        .manage(dsh_bridge::DshBridge::default())
        .manage(vault_watch::VaultWatch::default())
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
            // 窗口背景特效(云母/亚克力/模糊)
            window_effects::set_window_effect,
            window_effects::set_window_corners,
            // DSH 边车:探测环境、按需安装、随应用起停
            dsh_commands::dsh_preflight,
            dsh_commands::dsh_install,
            dsh_commands::dsh_start,
            dsh_commands::dsh_stop,
            dsh_commands::dsh_status,
            dsh_commands::dsh_footprint,
            dsh_commands::dsh_uninstall,
            dsh_commands::dsh_plugins,
            dsh_commands::dsh_plugin_add,
            // DSH 通信桥:一元 RPC + 两条事件流
            dsh_bridge::dsh_rpc,
            dsh_bridge::dsh_respond,
            dsh_bridge::dsh_connect,
            dsh_bridge::dsh_disconnect,
            // 托盘菜单(自绘窗口,不是系统原生菜单 —— 见 tray.rs 顶部)
            tray::anchor_tray_menu,
            tray::hide_tray_menu,
            tray::tray_show_main,
            tray::tray_toggle_dock,
            tray::tray_open_palette,
            tray::tray_screenshot,
            tray::tray_force_close_overlays,
            tray::tray_quit,
            // 全盘文件搜索(每个平台一个后端,见 file_search_commands.rs)
            file_search_commands::file_search_status,
            file_search_commands::file_search,
            // Markdown 工作区
            vault_watch::watch_vault,
            vault_trash::vault_trash_list,
            vault_trash::vault_trash_restore,
            vault_trash::vault_trash_purge,
            vault_attach::vault_attach_bytes,
            vault_attach::vault_attach_file,
            vault_attach::vault_find_orphan_images,
            vault_history::vault_snapshot,
            vault_history::vault_history_list,
            vault_history::vault_history_read,
            vault_history::vault_history_clear,
            vault_commands::vault_list,
            vault_commands::vault_read,
            vault_commands::vault_write,
            vault_commands::vault_create,
            vault_commands::vault_rename,
            vault_commands::vault_move,
            vault_commands::vault_delete,
            vault_commands::vault_reveal,
            vault_commands::vault_file_info,
            vault_commands::save_export,
            vault_commands::vault_search,
            vault_commands::vault_backlinks,
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
            dock_commands::pause_shortcuts,
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
            // 动态壁纸 / 定时屏保
        ])
        .setup(|app| {
            // --- Input listener (for key visualizer) ---
            init_input_listener(app.handle().clone());

            // --- System Tray ---
            // 菜单是自绘的小窗口,不是系统原生菜单 —— 原生那套在 Windows 上
            // 会被任务栏挡住,而位置归系统管改不了。详见 tray.rs。
            tray::setup(app.handle())?;

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
                .unwrap_or_else(|| "Ctrl+Alt+W".to_string());

            let dock_shortcut = dock_commands::parse_shortcut_str(&dock_shortcut_str)
                .unwrap_or_else(|_| {
                    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};
                    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyW)
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

            // 命令面板:默认 Ctrl+Alt+Space。
            // 这个默认值是试出来的,另外两个"看着更顺手"的都不能用:
            //   Ctrl+Space —— Windows 上中英文输入法切换的默认键。抢过来会让人
            //                 以为输入法坏了,而且根本想不到是被这里占的。
            //   Alt+Space  —— 系统菜单。实测按下去弹的是系统菜单不是面板;
            //                 PowerToys Run 能用它是因为走低层键盘钩子,
            //                 而 Tauri 用的是 RegisterHotKey,抢不过系统。
            // 和启动台一样,关掉时就不注册,不占用这个组合。
            let palette_enabled = store_json.as_ref()
                .and_then(|v| v.get("palette_enabled"))
                .and_then(|v| v.as_bool())
                .unwrap_or(true);

            let palette_shortcut = if palette_enabled {
                store_json.as_ref()
                    .and_then(|v| v.get("palette_shortcut"))
                    .and_then(|v| v.as_str())
                    .or(Some("Ctrl+Alt+Space"))
                    .and_then(|s| dock_commands::parse_shortcut_str(s).ok())
            } else {
                None
            };

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
                palette: palette_shortcut,
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
                        } else if b.palette.as_ref() == Some(shortcut) {
                            if let Some(win) = app.get_webview_window("palette") {
                                // 定位和 show 都交给窗口里的 JS 做 ——
                                // 面板要落在鼠标所在的那块屏幕上,而且高度随结果条数变,
                                // 先 show 再摆位会闪一下。隐藏的 webview 照样能执行 eval。
                                let _ = win.eval("window.__togglePalette && window.__togglePalette()");
                            }
                        } else if b.dock.as_ref() == Some(shortcut) {
                            if let Some(win) = app.get_webview_window("dock") {
                                // 先摆好位置(窗口还藏着,摆位不会闪),然后**只喊一声**。
                                // 不在这里 show —— 显示与否是前端那个 __toggleDock 的事。
                                // 以前这儿有 show() + set_focus(),结果前端决定"不显示"时
                                // 窗口照样被显示出来,状态就此对不上,再也切不回去。
                                fullscreen_borderless(&win);
                                let _ = win.eval("window.__toggleDock && window.__toggleDock()");
                            }
                        }
                    })
                    .build(),
            )?;

            // 5. 注册所有快捷键（失败时先 unregister 再重试一次，仍失败则通知前端）
            let gs = app.global_shortcut();
            let mut failed_shortcuts: Vec<String> = Vec::new();

            let try_register = |shortcut, name: &str, failed: &mut Vec<String>| {
                if let Err(_) = gs.register(shortcut) {
                    // 可能是上次实例没干净退出，先 unregister 再重试
                    let _ = gs.unregister(shortcut);
                    if let Err(e) = gs.register(shortcut) {
                        eprintln!("Failed to register {name} shortcut: {e}");
                        failed.push(name.to_string());
                    }
                }
            };

            try_register(dock_shortcut, "dock", &mut failed_shortcuts);
            try_register(screenshot_shortcut, "screenshot", &mut failed_shortcuts);
            if let Some(sc) = screenshot_translate_shortcut {
                try_register(sc, "screenshot_translate", &mut failed_shortcuts);
            }
            // 命令面板。**加新快捷键要改三个地方**:读配置、放进 bindings、在这里注册。
            // 漏掉这一条的后果很难查:bindings 里有它,所以分发逻辑看着是对的,
            // 但系统层压根没登记过这个键,按下去走的是 Windows 自己的处理
            // (Alt+Space 就会弹出窗口的系统菜单)。
            if let Some(sc) = palette_shortcut {
                try_register(sc, "palette", &mut failed_shortcuts);
            }

            // 通知前端有哪些快捷键注册失败
            if !failed_shortcuts.is_empty() {
                let app_handle = app.handle().clone();
                let failed = failed_shortcuts.clone();
                // 延迟发送，等前端 ready
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    let _ = app_handle.emit("shortcut-register-failed", failed);
                });
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
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // 主窗口关闭只是隐藏(托盘应用),所以边车不能挂在 CloseRequested 上收 ——
            // 那样最小化到托盘就把智能体杀了。只在进程真正退出时收。
            if let tauri::RunEvent::Exit = event {
                dsh_commands::shutdown(app);
            }
        });
}
