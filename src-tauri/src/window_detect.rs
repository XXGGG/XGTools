use serde::Serialize;
use std::sync::Mutex;

#[derive(Debug, Serialize, Clone)]
pub struct WindowRect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

/// 元素矩形（物理像素，屏幕坐标）
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct ElementRect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// 缓存的 UI 元素（含层级信息）
#[derive(Debug, Clone)]
struct CachedElement {
    rect: ElementRect,
    depth: u32,       // 深度级别（0=顶级窗口，越大越深）
    window_idx: u32,  // 所属窗口索引（z-order）
}

/// 全局元素缓存
static ELEMENT_CACHE: Mutex<Vec<CachedElement>> = Mutex::new(Vec::new());

/// 枚举所有可见窗口，返回按 z-order 排序的窗口边界列表
#[tauri::command]
pub async fn get_visible_windows() -> Result<Vec<WindowRect>, String> {
    tokio::task::spawn_blocking(|| {
        use xcap::Window;

        let current_pid = std::process::id();

        let windows =
            Window::all().map_err(|e| format!("Failed to enumerate windows: {}", e))?;

        let result: Vec<WindowRect> = windows
            .into_iter()
            .filter(|w| {
                if w.is_minimized() {
                    return false;
                }
                let width = w.width();
                let height = w.height();
                if width == 0 || height == 0 {
                    return false;
                }
                // 排除自身进程的所有窗口
                if w.process_id() == current_pid {
                    return false;
                }
                true
            })
            .map(|w| WindowRect {
                x: w.x(),
                y: w.y(),
                w: w.width(),
                h: w.height(),
            })
            .collect();

        Ok(result)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 预扫描所有可见窗口的 UI 元素树，缓存到内存
/// 必须在截图窗口显示之前调用！
#[cfg(windows)]
#[tauri::command]
pub async fn scan_ui_elements() -> Result<usize, String> {
    tokio::task::spawn_blocking(|| {
        use uiautomation::UIAutomation;
        let start = std::time::Instant::now();

        let current_pid = std::process::id();

        let automation =
            UIAutomation::new().map_err(|e| format!("UIAutomation init failed: {}", e))?;

        let walker = automation
            .create_tree_walker()
            .map_err(|e| format!("create_tree_walker failed: {}", e))?;

        // 获取桌面根元素
        let root = automation
            .get_root_element()
            .map_err(|e| format!("get_root_element failed: {}", e))?;

        let mut cache: Vec<CachedElement> = Vec::with_capacity(512);
        let mut window_idx: u32 = 0;

        // 遍历桌面的所有顶级子窗口
        let first_child = match walker.get_first_child(&root) {
            Ok(c) => c,
            Err(_) => {
                let mut guard = ELEMENT_CACHE.lock().unwrap();
                *guard = cache;
                return Ok(0);
            }
        };

        let mut top_window = Some(first_child);

        while let Some(ref win) = top_window {
            // 过滤：跳过自身进程的窗口
            let win_pid = win.get_process_id().unwrap_or(0);
            let is_offscreen = win.is_offscreen().unwrap_or(true);

            if !is_offscreen && win_pid != current_pid {
                if let Ok(rect) = win.get_bounding_rectangle() {
                    let w = rect.get_right() - rect.get_left();
                    let h = rect.get_bottom() - rect.get_top();

                    if w > 0 && h > 0 {
                        // 添加顶级窗口
                        cache.push(CachedElement {
                            rect: ElementRect {
                                x: rect.get_left(),
                                y: rect.get_top(),
                                w,
                                h,
                            },
                            depth: 0,
                            window_idx,
                        });

                        // 递归扫描子元素（限制深度和数量）
                        scan_children(&walker, win, 1, window_idx, &mut cache, 0);

                        window_idx += 1;
                    }
                }
            }

            top_window = match walker.get_next_sibling(win) {
                Ok(next) => Some(next),
                Err(_) => None,
            };
        }

        let count = cache.len();
        let elapsed = start.elapsed();
        println!("[scan_ui_elements] scanned {} elements in {:?}", count, elapsed);

        let mut guard = ELEMENT_CACHE.lock().unwrap();
        *guard = cache;

        Ok(count)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 递归扫描子元素
#[cfg(windows)]
fn scan_children(
    walker: &uiautomation::UITreeWalker,
    parent: &uiautomation::UIElement,
    depth: u32,
    window_idx: u32,
    cache: &mut Vec<CachedElement>,
    mut iterations: u32,
) -> u32 {
    // 限制：深度不超过 15，单窗口元素不超过 500，全局不超过 5000
    if depth > 15 || iterations > 500 || cache.len() > 5000 {
        return iterations;
    }

    let child = match walker.get_first_child(parent) {
        Ok(c) => c,
        Err(_) => return iterations,
    };

    let mut sibling = Some(child);

    while let Some(ref sib) = sibling {
        iterations += 1;
        if iterations > 500 || cache.len() > 5000 {
            break;
        }

        let is_offscreen = sib.is_offscreen().unwrap_or(true);

        if !is_offscreen {
            if let Ok(rect) = sib.get_bounding_rectangle() {
                let w = rect.get_right() - rect.get_left();
                let h = rect.get_bottom() - rect.get_top();

                if w > 0 && h > 0 {
                    cache.push(CachedElement {
                        rect: ElementRect {
                            x: rect.get_left(),
                            y: rect.get_top(),
                            w,
                            h,
                        },
                        depth,
                        window_idx,
                    });

                    // 递归子元素
                    iterations = scan_children(walker, sib, depth + 1, window_idx, cache, iterations);
                }
            }
        }

        sibling = match walker.get_next_sibling(sib) {
            Ok(next) => Some(next),
            Err(_) => None,
        };
    }

    iterations
}

/// 从缓存中查询指定坐标的元素层级列表
/// top_window: 前端通过 z-order hitTest 确定的最上层窗口矩形（物理像素）
/// 只返回属于该窗口的子元素，避免穿透到被遮挡的窗口
#[cfg(windows)]
#[tauri::command]
pub async fn get_element_at_point(
    x: i32,
    y: i32,
    top_window_x: i32,
    top_window_y: i32,
    top_window_w: u32,
    top_window_h: u32,
) -> Result<Vec<ElementRect>, String> {
    let guard = ELEMENT_CACHE.lock().unwrap();

    if guard.is_empty() {
        return Ok(Vec::new());
    }

    // 先找到与前端传入的顶层窗口匹配的 window_idx
    // 匹配条件：depth==0 的元素与传入窗口矩形重叠度高
    let tw_right = top_window_x + top_window_w as i32;
    let tw_bottom = top_window_y + top_window_h as i32;
    let mut target_window_idx: Option<u32> = None;

    for e in guard.iter() {
        if e.depth != 0 {
            continue;
        }
        let e_right = e.rect.x + e.rect.w;
        let e_bottom = e.rect.y + e.rect.h;
        // 检查窗口矩形是否大致匹配（允许少量偏差）
        if (e.rect.x - top_window_x).abs() <= 2
            && (e.rect.y - top_window_y).abs() <= 2
            && (e_right - tw_right).abs() <= 2
            && (e_bottom - tw_bottom).abs() <= 2
        {
            target_window_idx = Some(e.window_idx);
            break;
        }
    }

    let target_idx = match target_window_idx {
        Some(idx) => idx,
        None => return Ok(Vec::new()), // 窗口在缓存中未找到
    };

    // 只查询目标窗口内包含鼠标点的元素
    let mut hits: Vec<&CachedElement> = guard
        .iter()
        .filter(|e| {
            e.window_idx == target_idx
                && x >= e.rect.x
                && x < e.rect.x + e.rect.w
                && y >= e.rect.y
                && y < e.rect.y + e.rect.h
        })
        .collect();

    if hits.is_empty() {
        return Ok(Vec::new());
    }

    // 按深度排序（大的在前=更深），同深度按面积排序（小的在前=更精确）
    hits.sort_by(|a, b| {
        b.depth.cmp(&a.depth).then({
            let area_a = a.rect.w as i64 * a.rect.h as i64;
            let area_b = b.rect.w as i64 * b.rect.h as i64;
            area_a.cmp(&area_b)
        })
    });

    let mut result: Vec<ElementRect> = Vec::new();
    let mut seen: Vec<(i32, i32, i32, i32)> = Vec::new();

    for hit in &hits {
        let key = (hit.rect.x, hit.rect.y, hit.rect.w, hit.rect.h);
        if !seen.contains(&key) {
            seen.push(key);
            result.push(hit.rect.clone());
        }
    }

    Ok(result)
}
