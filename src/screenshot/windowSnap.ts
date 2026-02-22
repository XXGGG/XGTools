import { invoke } from '@tauri-apps/api/core'

export interface WindowRect {
  x: number // 物理像素（屏幕坐标）
  y: number
  w: number
  h: number
}

/** 后端返回的元素矩形（物理像素） */
export interface ElementRect {
  x: number
  y: number
  w: number
  h: number
}

export interface SnapRect {
  x: number // CSS 像素（相对截图窗口）
  y: number
  w: number
  h: number
}

function rectsEqual(a: SnapRect | null, b: SnapRect | null): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}

/**
 * 窗口吸附管理器
 *
 * 架构：
 * - 截图前调用 scan_ui_elements() 预扫描所有窗口的 UI 元素树到 Rust 缓存
 * - 截图期间 get_element_at_point() 从缓存查询（纯内存，几乎零延迟）
 * - 不再有截图窗口遮挡 element_from_point 的问题
 */
export class WindowSnapManager {
  /** 所有可见窗口列表（物理像素坐标，z-order 排序） */
  private windows: WindowRect[] = []
  /** 缩放因子 */
  private scaleFactor = 1
  /** 显示器偏移（物理像素） */
  private monitorX = 0
  private monitorY = 0
  /** 显示器尺寸（CSS 像素） */
  private monitorW = 0
  private monitorH = 0

  /** 当前吸附的目标矩形（CSS 像素），null 表示无吸附 */
  snapRect: SnapRect | null = null

  /** 动画相关 */
  private animRect: SnapRect | null = null
  private animStart: SnapRect | null = null
  private animTarget: SnapRect | null = null
  private animStartTime = 0
  private readonly ANIM_DURATION = 100 // ms

  /** 元素层级列表（CSS 像素）：[0]=最深子元素, [last]=根窗口 */
  private elementLevels: SnapRect[] = []
  /** 当前选中的层级索引（滚轮切换，跨查询保持） */
  private currentLevel = 0

  /** 异步查询状态 */
  private queryRunning = false
  private pendingQuery: { cssX: number; cssY: number } | null = null

  /** 异步结果回调 */
  onAsyncUpdate?: () => void

  /** 预扫描 UI 元素树（必须在截图窗口显示之前调用！） */
  async scanElements() {
    try {
      const count = await invoke<number>('scan_ui_elements')
      console.log(`[WindowSnap] Scanned ${count} UI elements`)
    } catch (e) {
      console.error('[WindowSnap] scan_ui_elements failed:', e)
    }
  }

  /** 从 Rust 后端获取可见窗口列表 */
  async fetchWindows(
    scaleFactor: number,
    monitorX: number,
    monitorY: number,
    monitorW: number,
    monitorH: number,
  ) {
    this.scaleFactor = scaleFactor
    this.monitorX = monitorX
    this.monitorY = monitorY
    this.monitorW = monitorW
    this.monitorH = monitorH
    try {
      this.windows = await invoke<WindowRect[]>('get_visible_windows')
    } catch (e) {
      console.error('[WindowSnap] Failed to fetch windows:', e)
      this.windows = []
    }
  }

  /** 命中检测：找到包含鼠标点(物理像素)的最上层窗口，返回物理像素坐标 */
  private hitTestWindow(physX: number, physY: number): WindowRect | null {
    for (const w of this.windows) {
      if (
        physX >= w.x &&
        physX < w.x + w.w &&
        physY >= w.y &&
        physY < w.y + w.h
      ) {
        return w
      }
    }
    return null
  }

  /** 物理像素 → CSS 像素，裁剪到显示器可视区域 */
  private physToCSS(px: number, py: number, pw: number, ph: number): SnapRect | null {
    let rx = (px - this.monitorX) / this.scaleFactor
    let ry = (py - this.monitorY) / this.scaleFactor
    let rw = pw / this.scaleFactor
    let rh = ph / this.scaleFactor

    const right = Math.min(rx + rw, this.monitorW)
    const bottom = Math.min(ry + rh, this.monitorH)
    rx = Math.max(0, rx)
    ry = Math.max(0, ry)
    rw = right - rx
    rh = bottom - ry

    if (rw <= 0 || rh <= 0) return null
    return { x: rx, y: ry, w: rw, h: rh }
  }

  /** 鼠标移动时更新吸附目标 */
  update(cssX: number, cssY: number) {
    this.pendingQuery = { cssX, cssY }

    if (!this.queryRunning) {
      this.runQueryLoop()
    }
  }

  /** 异步查询循环（从 Rust 缓存查询，几乎零延迟） */
  private async runQueryLoop() {
    this.queryRunning = true

    while (this.pendingQuery) {
      const { cssX, cssY } = this.pendingQuery
      this.pendingQuery = null

      const physX = Math.round(cssX * this.scaleFactor + this.monitorX)
      const physY = Math.round(cssY * this.scaleFactor + this.monitorY)

      // 先用窗口列表的 z-order 确定鼠标在哪个窗口上
      const topWindow = this.hitTestWindow(physX, physY)

      let elements: ElementRect[] | null = null
      if (topWindow) {
        try {
          // 传入顶层窗口信息，Rust 只查询该窗口的子元素
          elements = await invoke<ElementRect[]>('get_element_at_point', {
            x: physX,
            y: physY,
            topWindowX: topWindow.x,
            topWindowY: topWindow.y,
            topWindowW: topWindow.w,
            topWindowH: topWindow.h,
          })
        } catch {
          // 查询失败
        }
      }

      // 处理结果
      if (elements && elements.length > 0) {
        this.elementLevels = elements
          .map(e => this.physToCSS(e.x, e.y, e.w, e.h))
          .filter((r): r is SnapRect => r !== null)
      } else if (topWindow) {
        // 缓存无子元素结果，使用窗口本身作为吸附目标
        this.elementLevels = []
        const windowRect = this.physToCSS(topWindow.x, topWindow.y, topWindow.w, topWindow.h)
        if (windowRect) {
          this.elementLevels = [windowRect]
        }
      } else {
        this.elementLevels = []
      }

      // 保持层级索引有效
      if (this.currentLevel >= this.elementLevels.length) {
        this.currentLevel = Math.max(0, this.elementLevels.length - 1)
      }

      // 更新吸附矩形
      if (this.elementLevels.length > 0) {
        this.setSnapTarget(this.elementLevels[this.currentLevel])
      } else {
        this.setSnapTarget(null)
      }

      this.onAsyncUpdate?.()
    }

    this.queryRunning = false
  }

  /** 设置吸附目标并触发动画 */
  private setSnapTarget(newRect: SnapRect | null) {
    if (!rectsEqual(this.snapRect, newRect)) {
      this.animStart = this.animRect ? { ...this.animRect } : null
      this.animTarget = newRect
      this.animStartTime = performance.now()
      this.snapRect = newRect
    }
  }

  /** 滚轮切换层级 */
  cycleLevel(delta: number): boolean {
    if (this.elementLevels.length <= 1) return false

    const prev = this.currentLevel
    if (delta > 0) {
      this.currentLevel = Math.min(this.currentLevel + 1, this.elementLevels.length - 1)
    } else {
      this.currentLevel = Math.max(this.currentLevel - 1, 0)
    }

    if (this.currentLevel !== prev) {
      this.setSnapTarget(this.elementLevels[this.currentLevel])
      return true
    }
    return false
  }

  /** 获取层级信息（用于 UI 显示） */
  get levelInfo(): { current: number; total: number } {
    return {
      current: this.currentLevel,
      total: this.elementLevels.length,
    }
  }

  /** 获取当前显示矩形（含动画插值） */
  getDisplayRect(): SnapRect | null {
    if (!this.animTarget) return null

    const elapsed = performance.now() - this.animStartTime
    const t = Math.min(1, elapsed / this.ANIM_DURATION)
    const ease = 1 - Math.pow(1 - t, 3)

    if (t >= 1) {
      this.animRect = { ...this.animTarget }
      return this.animRect
    }

    if (!this.animStart) {
      this.animRect = { ...this.animTarget }
      return this.animRect
    }

    this.animRect = {
      x: this.animStart.x + (this.animTarget.x - this.animStart.x) * ease,
      y: this.animStart.y + (this.animTarget.y - this.animStart.y) * ease,
      w: this.animStart.w + (this.animTarget.w - this.animStart.w) * ease,
      h: this.animStart.h + (this.animTarget.h - this.animStart.h) * ease,
    }
    return this.animRect
  }

  /** 动画是否进行中 */
  isAnimating(): boolean {
    return performance.now() - this.animStartTime < this.ANIM_DURATION
  }

  /** 重置所有状态 */
  reset() {
    this.windows = []
    this.snapRect = null
    this.animRect = null
    this.animStart = null
    this.animTarget = null
    this.elementLevels = []
    this.currentLevel = 0
    this.queryRunning = false
    this.pendingQuery = null
  }
}
