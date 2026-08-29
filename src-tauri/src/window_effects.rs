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

/// 让 DWM 把窗口本身裁成圆角(Win11)。
///
/// **上了云母/亚克力的窗口必须做这一步。** 材质是 DWM 画在**整个窗口矩形**上的,
/// 它不认 CSS 的 border-radius —— 不裁的话,圆角卡片外面会原样露出四个尖角的材质,
/// 看起来就是「面板四个角是尖的」。
///
/// 另外提醒:CSS 的 backdrop-filter **代替不了**系统材质。它只能模糊窗口内部的内容,
/// 而透明窗口背后是桌面,它够不着。真要磨砂桌面只有系统材质这一条路。
#[tauri::command]
pub fn set_window_corners(app: tauri::AppHandle, label: String, round: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::Graphics::Dwm::{
            DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE,
            DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND, DWMWCP_ROUND,
        };
        let win = app
            .get_webview_window(&label)
            .ok_or_else(|| format!("找不到窗口: {label}"))?;
        let hwnd = win.hwnd().map_err(|e| e.to_string())?;
        let pref = if round { DWMWCP_ROUND } else { DWMWCP_DONOTROUND };
        unsafe {
            DwmSetWindowAttribute(
                HWND(hwnd.0 as _),
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &pref as *const _ as *const _,
                std::mem::size_of_val(&pref) as u32,
            )
            .map_err(|e| format!("设置窗口圆角失败: {e}"))?;

            // 裁圆角的同时 DWM 会给窗口画一道边框,在透明窗口上会显成
            // 「卡片外面还有一个框」。明确设成「无颜色」把它关掉。
            let none = DWMWA_COLOR_NONE;
            let _ = DwmSetWindowAttribute(
                HWND(hwnd.0 as _),
                DWMWA_BORDER_COLOR,
                &none as *const _ as *const _,
                std::mem::size_of_val(&none) as u32,
            );
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, label, round);
        Ok(())
    }
}

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
    // 目标窗口标签。不传就是主窗口 —— 命令面板要用同一套材质,
    // 所以这里不能再写死 "main"。(函数参数上不能用 /// 文档注释,会编译报错)
    label: Option<String>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        use window_vibrancy::{apply_acrylic, apply_mica, clear_acrylic, clear_blur, clear_mica};

        let target = label.as_deref().unwrap_or("main");
        let win = app
            .get_webview_window(target)
            .ok_or_else(|| format!("找不到窗口: {target}"))?;

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
        let _ = (app, kind, r, g, b, a, dark, label);
        return Err("当前系统不支持窗口背景特效".into());
    }
    Ok(())
}
