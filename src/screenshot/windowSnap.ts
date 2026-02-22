import { invoke } from '@tauri-apps/api/core'
import Flatbush from 'flatbush'

// ─── 类型定义（与 Rust 端一致，min/max 格式） ──────────

/** 后端返回的元素矩形（物理像素，屏幕坐标） */
export interface ElementRect {
  min_x: number
  min_y: number
  max_x: number
  max_y: number
}

/** 后端返回的窗口元素 */
export interface WindowElement {
  element_rect: ElementRect
  window_id: number
}

/** 显示用矩形（CSS 像素，相对截图窗口） */
export interface SnapRect {
  x: number
  y: number
  w: number
  h: number
}

function rectsEqual(a: SnapRect | null, b: SnapRect | null): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}

// ─── WindowSnapManager ────────────────────────────────

export class WindowSnapManager {
  /** Flatbush RTree（窗口级空间索引） */
  private rTree: Flatbush | undefined
  /** 窗口元素列表（与 RTree 索引对应） */
  private windowElements: ElementRect[] = []

  /** 缩放因子 */
  private scaleFactor = 1
  /** 显示器偏移（物理像素） */
  private monitorX = 0
  private monitorY = 0
  /** 显示器尺寸（CSS 像素） */
  private monitorW = 0
  private monitorH = 0

  /** Flatbush 就绪（允许窗口级查询） */
  private initReady = false

  /** 当前吸附的目标矩形（CSS 像素），null 表示无吸附 */
  snapRect: SnapRect | null = null

  /** 动画相关 */
  private animRect: SnapRect | null = null
  private animStart: SnapRect | null = null
  private animTarget: SnapRect | null = null
  private animStartTime = 0
  private readonly ANIM_DURATION = 100

  /** 元素层级列表（CSS 像素）：[0]=最深子元素, [last]=根窗口 */
  private elementLevels: SnapRect[] = []
  /** 当前选中的层级索引 */
  private currentLevel = 0

  /** 异步查询状态 */
  private queryRunning = false
  private pendingQuery: { cssX: number; cssY: number } | null = null
  /** 上次查询的鼠标位置（用于检测鼠标是否移动了，重置 level） */
  private lastQueryPos: { cssX: number; cssY: number } | null = null

  /** 异步结果回调 */
  onAsyncUpdate?: () => void

  /**
   * 初始化：获取窗口列表构建 Flatbush + 后台初始化 UIElements
   */
  async init(
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

    console.warn(`[WindowSnap] init: sf=${scaleFactor}, mon=(${monitorX},${monitorY}), size=(${monitorW}x${monitorH})`)

    // 1. 获取窗口列表（独立于 UIElements，不走 COM thread）
    let windowElements: WindowElement[]
    try {
      windowElements = await invoke<WindowElement[]>('get_visible_windows')
      console.warn(`[WindowSnap] got ${windowElements.length} windows`)
    } catch (e) {
      console.error('[WindowSnap] get_visible_windows FAILED:', e)
      return
    }

    // 2. 构建 Flatbush RTree
    this.windowElements = []
    windowElements.forEach((we) => {
      this.windowElements.push(we.element_rect)
    })
    if (this.windowElements.length > 0) {
      this.rTree = new Flatbush(this.windowElements.length)
      this.windowElements.forEach((r) => {
        this.rTree!.add(r.min_x, r.min_y, r.max_x, r.max_y)
      })
      this.rTree.finish()
    }

    // 3. Flatbush 就绪 → 立即允许窗口级查询
    this.initReady = true
    console.warn(`[WindowSnap] READY: ${this.windowElements.length} windows in Flatbush`)

    // 深度检测已禁用（透明窗口下 UIAutomation 会穿透到被遮挡窗口）
    // 只使用 Flatbush 窗口级吸附
  }

  /**
   * Flatbush 窗口级命中检测
   * 返回命中的窗口索引列表（索引小 = z-order 高）
   */
  private hitTestWindow(physX: number, physY: number): number[] {
    if (!this.rTree) return []
    const indices = this.rTree.search(physX, physY, physX, physY)
    indices.sort((a, b) => a - b)
    return indices
  }

  /** 物理像素 ElementRect → CSS 像素 SnapRect，裁剪到可视区域 */
  private physToCSS(r: ElementRect): SnapRect | null {
    let rx = (r.min_x - this.monitorX) / this.scaleFactor
    let ry = (r.min_y - this.monitorY) / this.scaleFactor
    let rw = (r.max_x - r.min_x) / this.scaleFactor
    let rh = (r.max_y - r.min_y) / this.scaleFactor

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
    if (!this.initReady) return
    // 鼠标移动到新位置 → 重置层级到 0（z-order 最高的顶层窗口）
    // 用户可以滚轮切换到更底层的窗口
    if (!this.lastQueryPos || Math.abs(cssX - this.lastQueryPos.cssX) > 2 || Math.abs(cssY - this.lastQueryPos.cssY) > 2) {
      this.currentLevel = 0
    }
    this.lastQueryPos = { cssX, cssY }
    this.pendingQuery = { cssX, cssY }
    if (!this.queryRunning) {
      this.runQueryLoop()
    }
  }

  /**
   * 异步查询循环
   * 两层策略：Flatbush 窗口级 + UIAutomation 深度检测
   */
  private async runQueryLoop() {
    this.queryRunning = true

    while (this.pendingQuery) {
      const { cssX, cssY } = this.pendingQuery
      this.pendingQuery = null

      const physX = Math.round(cssX * this.scaleFactor + this.monitorX)
      const physY = Math.round(cssY * this.scaleFactor + this.monitorY)

      // 1. Flatbush 窗口级命中
      const windowIndices = this.hitTestWindow(physX, physY)
      const windowLevels: SnapRect[] = windowIndices
        .map((idx) => this.physToCSS(this.windowElements[idx]))
        .filter((r): r is SnapRect => r !== null)

      // 只使用窗口级命中（Flatbush 预缓存数据，不实时调 UIAutomation）
      this.elementLevels = windowLevels

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

  /** 滚轮切换层级（向下滚=更底层窗口，向上滚=更顶层窗口） */
  cycleLevel(delta: number): boolean {
    if (this.elementLevels.length <= 1) return false

    const prev = this.currentLevel
    if (delta > 0) {
      // 向下滚 → 更底层窗口（index 增大）
      this.currentLevel = Math.min(this.currentLevel + 1, this.elementLevels.length - 1)
    } else {
      // 向上滚 → 更顶层窗口（index 减小）
      this.currentLevel = Math.max(this.currentLevel - 1, 0)
    }

    if (this.currentLevel !== prev) {
      this.setSnapTarget(this.elementLevels[this.currentLevel])
      return true
    }
    return false
  }

  /** 获取层级信息 */
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
    this.rTree = undefined
    this.windowElements = []
    this.snapRect = null
    this.animRect = null
    this.animStart = null
    this.animTarget = null
    this.elementLevels = []
    this.currentLevel = 0
    this.queryRunning = false
    this.pendingQuery = null
    this.lastQueryPos = null
    this.initReady = false
  }
}
