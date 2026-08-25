// 主窗口的背景特效(云母 / 亚克力)。
//
// 前提:主窗口必须 transparent:true(tauri.conf.json),否则系统合成器没法把桌面透上来 ——
// 这也是启动台窗口一直能用亚克力、主窗口不能的原因。
//
// 强度:亚克力接受一个 RGBA 着色,其中 **alpha 就是不透明度** —— 越小越通透。
// 云母(Mica)是 Win11 的系统级材质,没有强度参数,只能选深/浅,所以滑块对它无效。
//
// 不提供高斯模糊:window_vibrancy 的 apply_blur 走 ACCENT_ENABLE_BLURBEHIND,
// 这条路径在 Win11 上已被微软废弃,实测渲染成一层压死的暗色、文字都看不清,所以不接。
// clear_blur 仍保留:老版本可能给窗口挂过 blur,切换时要能清掉。

use tauri::Manager;

/// 告诉 DWM 这个窗口用深色变体渲染系统材质。
/// window_vibrancy 只在 apply_mica 里做了这件事,亚克力那条路径没做。
#[cfg(windows)]
fn set_immersive_dark(win: &tauri::WebviewWindow, dark: bool) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_USE_IMMERSIVE_DARK_MODE};

    if let Ok(hwnd) = win.hwnd() {
        let v: u32 = dark as u32;
        unsafe {
            let _ = DwmSetWindowAttribute(
                HWND(hwnd.0 as _),
                DWMWA_USE_IMMERSIVE_DARK_MODE,
                &v as *const u32 as *const _,
                std::mem::size_of::<u32>() as u32,
            );
        }
    }
}

#[tauri::command]
pub fn set_window_effect(
    app: tauri::AppHandle,
    kind: String,
    r: u8,
    g: u8,
    b: u8,
    a: u8,
    dark: bool,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        use window_vibrancy::{apply_acrylic, apply_mica, clear_acrylic, clear_blur, clear_mica};

        let win = app
            .get_webview_window("main")
            .ok_or_else(|| "找不到主窗口".to_string())?;

        // 切换前先清掉旧特效:三种材质在同一个窗口上叠加会互相干扰,
        // 表现是切过一轮之后模糊层再也不刷新。忽略清除时的错误(本来就没应用过时会报错)。
        let _ = clear_mica(&win);
        let _ = clear_acrylic(&win);
        let _ = clear_blur(&win);

        match kind.as_str() {
            "mica" => apply_mica(&win, Some(dark)).map_err(|e| format!("云母不可用: {e}"))?,
            "acrylic" => {
                // apply_mica 会顺手设 DWMWA_USE_IMMERSIVE_DARK_MODE,apply_acrylic 不设 ——
                // 结果深色模式下亚克力仍按浅色变体渲染。这里自己补上,否则暗色主题下观感不对。
                set_immersive_dark(&win, dark);
                apply_acrylic(&win, Some((r, g, b, a))).map_err(|e| format!("亚克力不可用: {e}"))?
            }
            _ => {} // "none":上面已经清干净了
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (app, kind, r, g, b, a, dark);
        return Err("当前系统不支持窗口背景特效".into());
    }
    Ok(())
}
