/**
 * 选区状态管理 + 绘制逻辑
 * 处理：创建选区、移动选区、缩放选区、控制点、光标、辅助线、尺寸标签
 */
import { SelectState, ResizeEdge, SELECTION_STYLE as S, ColorFormat, COLOR_PICKER_STYLE as CP } from './types'
import type { SelectRect } from './types'
import type { WindowSnapManager } from './windowSnap'

export class SelectionManager {
  // 状态
  state = SelectState.Idle
  /** 选区矩形（CSS 像素） */
  rect: SelectRect = { x: 0, y: 0, w: 0, h: 0 }

  // 内部拖拽状态
  private dragStartX = 0
  private dragStartY = 0
  private dragStartRect: SelectRect = { x: 0, y: 0, w: 0, h: 0 }
  private resizeEdge = ResizeEdge.None

  /** 待定状态：mouseDown 后尚未确定是吸附点击还是手动拖拽 */
  private pending = false
  /** 拖拽距离阈值（CSS 像素） */
  private readonly DRAG_THRESHOLD = 6

  // 鼠标位置（CSS 像素）
  mouseX = 0
  mouseY = 0
  /** 是否已收到过真实鼠标事件 */
  hasMousePosition = false

  // 画布尺寸
  private scaleFactor = 1

  // 取色器
  /** 截图原始画布（用于读取像素） */
  bgCanvas: HTMLCanvasElement | null = null
  /** 颜色格式 */
  colorFormat = ColorFormat.HEX
  /** 当前鼠标位置的颜色 [r, g, b] */
  private curColor: [number, number, number] = [0, 0, 0]

  /** 窗口吸附管理器 */
  windowSnap: WindowSnapManager | null = null
  /** 吸附截取时的窗口圆角半径（CSS px），手动拖选为 0 */
  snapCornerRadius = 0

  /** 状态改变回调 */
  onStateChange?: (state: SelectState) => void
  /** 需要重绘回调 */
  onRedraw?: () => void

  constructor(private overlayCanvas: HTMLCanvasElement) {}

  /** 初始化画布参数 */
  init(_canvasW: number, _canvasH: number, scaleFactor: number) {
    this.scaleFactor = scaleFactor
    this.state = SelectState.Idle
    this.rect = { x: 0, y: 0, w: 0, h: 0 }
  }

  /** 重置选区 */
  reset() {
    this.state = SelectState.Idle
    this.rect = { x: 0, y: 0, w: 0, h: 0 }
    this.resizeEdge = ResizeEdge.None
    this.pending = false
    this.hasMousePosition = false
    this.snapCornerRadius = 0
  }

  // ============ 鼠标事件处理 ============

  handleMouseDown(e: MouseEvent): boolean {
    const x = e.clientX
    const y = e.clientY

    if (e.button === 2) {
      // 右键
      if (this.state === SelectState.Selected) {
        // 已选区 → 回到空闲（清除选区）
        this.reset()
        this.onStateChange?.(this.state)
        return true // 需要重绘
      }
      return false // 空闲状态右键 → 退出截图（由调用方处理）
    }

    if (e.button !== 0) return false

    if (this.state === SelectState.Selected) {
      // 检测是否在控制点/边缘/内部
      const edge = this.detectEdge(x, y)
      if (edge !== ResizeEdge.None) {
        // 缩放
        this.state = SelectState.Resizing
        this.resizeEdge = edge
        this.dragStartX = x
        this.dragStartY = y
        this.dragStartRect = { ...this.rect }
        this.onStateChange?.(this.state)
        return true
      }
      if (this.isInsideRect(x, y)) {
        // 移动
        this.state = SelectState.Moving
        this.dragStartX = x
        this.dragStartY = y
        this.dragStartRect = { ...this.rect }
        this.onStateChange?.(this.state)
        return true
      }
      // 点击外部 → 重新创建选区
      this.rect = { x: 0, y: 0, w: 0, h: 0 }
    }

    // Idle 状态：记录起始位置，进入待定状态
    // 不立即决定是"选中吸附"还是"手动拖拽"——等 mouseMove 或 mouseUp 来决定
    this.pending = true
    this.dragStartX = x
    this.dragStartY = y
    return true
  }

  handleMouseMove(e: MouseEvent): boolean {
    const x = e.clientX
    const y = e.clientY
    this.mouseX = x
    this.mouseY = y
    this.hasMousePosition = true

    // 待定状态：检测拖拽距离
    if (this.pending) {
      const dx = Math.abs(x - this.dragStartX)
      const dy = Math.abs(y - this.dragStartY)
      if (Math.max(dx, dy) > this.DRAG_THRESHOLD) {
        // 超过阈值 → 手动拖拽创建选区
        this.pending = false
        this.state = SelectState.Creating
        this.snapCornerRadius = 0
        this.rect = { x: this.dragStartX, y: this.dragStartY, w: 0, h: 0 }
        this.onStateChange?.(this.state)
      }
      // 未超过阈值 → 继续待定（保持吸附高亮）
      return true
    }

    if (this.state === SelectState.Creating) {
      this.rect = normalizeRect(this.dragStartX, this.dragStartY, x, y)
      return true
    }

    if (this.state === SelectState.Moving) {
      const dx = x - this.dragStartX
      const dy = y - this.dragStartY
      this.rect = {
        x: this.dragStartRect.x + dx,
        y: this.dragStartRect.y + dy,
        w: this.dragStartRect.w,
        h: this.dragStartRect.h,
      }
      return true
    }

    if (this.state === SelectState.Resizing) {
      this.applyResize(x, y)
      return true
    }

    // 空闲/已选中：更新光标 + 十字线
    return true
  }

  handleMouseUp(e: MouseEvent): boolean {
    if (e.button !== 0) return false

    // 待定状态 mouseUp（距离 <6px）：如果有吸附矩形则选中，否则忽略
    if (this.pending) {
      this.pending = false
      if (this.windowSnap?.snapRect) {
        const sr = this.windowSnap.snapRect
        this.rect = { x: sr.x, y: sr.y, w: sr.w, h: sr.h }
        this.snapCornerRadius = this.windowSnap.getCornerRadius()
        this.state = SelectState.Selected
        this.onStateChange?.(this.state)
        return true
      }
      // 没有吸附目标，忽略这次点击
      return true
    }

    if (this.state === SelectState.Creating) {
      if (this.rect.w < 2 || this.rect.h < 2) {
        this.reset()
        this.onStateChange?.(this.state)
        return true
      }
      this.state = SelectState.Selected
      this.onStateChange?.(this.state)
      return true
    }

    if (this.state === SelectState.Moving || this.state === SelectState.Resizing) {
      this.state = SelectState.Selected
      this.resizeEdge = ResizeEdge.None
      this.onStateChange?.(this.state)
      return true
    }

    return false
  }

  // ============ 缩放逻辑 ============

  private applyResize(mouseX: number, mouseY: number) {
    const { x, y, w, h } = this.dragStartRect
    const dx = mouseX - this.dragStartX
    const dy = mouseY - this.dragStartY
    const edge = this.resizeEdge

    let nx = x, ny = y, nw = w, nh = h

    if (edge & ResizeEdge.Left) {
      nx = x + dx
      nw = w - dx
    }
    if (edge & ResizeEdge.Right) {
      nw = w + dx
    }
    if (edge & ResizeEdge.Top) {
      ny = y + dy
      nh = h - dy
    }
    if (edge & ResizeEdge.Bottom) {
      nh = h + dy
    }

    // 翻转处理（拖过头）
    if (nw < 0) { nx += nw; nw = -nw }
    if (nh < 0) { ny += nh; nh = -nh }

    this.rect = { x: nx, y: ny, w: nw, h: nh }
  }

  // ============ 边缘/控制点检测 ============

  detectEdge(x: number, y: number): ResizeEdge {
    const r = this.rect
    if (r.w < 2 || r.h < 2) return ResizeEdge.None

    const tol = S.edgeDetectTolerance
    let edge = ResizeEdge.None

    const nearTop = Math.abs(y - r.y) <= tol
    const nearBottom = Math.abs(y - (r.y + r.h)) <= tol
    const nearLeft = Math.abs(x - r.x) <= tol
    const nearRight = Math.abs(x - (r.x + r.w)) <= tol

    const inXRange = x >= r.x - tol && x <= r.x + r.w + tol
    const inYRange = y >= r.y - tol && y <= r.y + r.h + tol

    if (nearTop && inXRange) edge |= ResizeEdge.Top
    if (nearBottom && inXRange) edge |= ResizeEdge.Bottom
    if (nearLeft && inYRange) edge |= ResizeEdge.Left
    if (nearRight && inYRange) edge |= ResizeEdge.Right

    return edge
  }

  isInsideRect(x: number, y: number): boolean {
    const r = this.rect
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h
  }

  /** 根据当前鼠标位置获取光标样式 */
  getCursor(x: number, y: number): string {
    if (this.state === SelectState.Creating) return 'crosshair'
    if (this.state === SelectState.Moving) return 'move'
    if (this.state === SelectState.Resizing) return edgeToCursor(this.resizeEdge)

    if (this.state === SelectState.Selected) {
      const edge = this.detectEdge(x, y)
      if (edge !== ResizeEdge.None) return edgeToCursor(edge)
      if (this.isInsideRect(x, y)) return 'move'
    }

    return 'crosshair'
  }

  // ============ 绘制 ============

  draw() {
    const canvas = this.overlayCanvas
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const w = canvas.width
    const h = canvas.height
    const sf = this.scaleFactor

    // 清除
    ctx.clearRect(0, 0, w, h)

    // 全屏暗色遮罩
    ctx.fillStyle = `rgba(0, 0, 0, ${S.maskAlpha})`
    ctx.fillRect(0, 0, w, h)

    const r = this.rect
    if (r.w > 0 && r.h > 0) {
      // 物理像素坐标
      const px = r.x * sf
      const py = r.y * sf
      const pw = r.w * sf
      const ph = r.h * sf

      // 清除选区遮罩（显示原图）
      ctx.clearRect(px, py, pw, ph)

      // 选区边框
      ctx.strokeStyle = S.borderColor
      ctx.lineWidth = S.borderWidth * sf
      ctx.strokeRect(px, py, pw, ph)

      // 控制点
      this.drawControlPoints(ctx, px, py, pw, ph, sf)

      // 尺寸标签
      this.drawSizeLabel(ctx, px, py, pw, ph, sf)
    }

    // 十字辅助线 + 放大镜取色器（仅在 Idle 和 Creating 时显示，且需要有真实鼠标位置）
    if ((this.state === SelectState.Idle || this.state === SelectState.Creating) && this.hasMousePosition) {
      // 窗口吸附高亮（仅 Idle 状态）
      if (this.state === SelectState.Idle) {
        this.drawSnapHighlight(ctx, sf)
      }
      this.drawCrosshair(ctx, w, h, sf)
      this.drawMagnifier(ctx, w, h, sf)
    }
  }

  private drawControlPoints(
    ctx: CanvasRenderingContext2D,
    px: number, py: number, pw: number, ph: number,
    sf: number
  ) {
    if (this.state !== SelectState.Selected && this.state !== SelectState.Moving && this.state !== SelectState.Resizing) return

    const r = this.rect
    const radius = S.controlPointRadius * sf
    const stroke = S.controlPointStrokeWidth * sf

    const points: [number, number][] = []

    // 四个角点（选区 > 32px 时显示）
    if (r.w > S.cornerShowThreshold && r.h > S.cornerShowThreshold) {
      points.push(
        [px, py],                     // 左上
        [px + pw, py],                // 右上
        [px, py + ph],                // 左下
        [px + pw, py + ph],           // 右下
      )
    }

    // 四个边中点（选区 > 64px 时显示）
    if (r.w > S.midPointShowThreshold) {
      points.push(
        [px + pw / 2, py],            // 上中
        [px + pw / 2, py + ph],       // 下中
      )
    }
    if (r.h > S.midPointShowThreshold) {
      points.push(
        [px, py + ph / 2],            // 左中
        [px + pw, py + ph / 2],       // 右中
      )
    }

    for (const [cx, cy] of points) {
      ctx.beginPath()
      ctx.arc(cx, cy, radius, 0, Math.PI * 2)
      ctx.fillStyle = S.controlPointFill
      ctx.fill()
      ctx.strokeStyle = S.controlPointStroke
      ctx.lineWidth = stroke
      ctx.stroke()
    }
  }

  /** 仿 Snow-Shot: 尺寸标签优先选区上方 → 超出时选区内部左上角 */
  private drawSizeLabel(
    ctx: CanvasRenderingContext2D,
    px: number, py: number, _pw: number, _ph: number,
    sf: number
  ) {
    if (this.rect.w < 1 || this.rect.h < 1) return

    const fontSize = S.sizeLabelFontSize * sf
    // 显示物理像素尺寸
    const physW = Math.round(this.rect.w * sf)
    const physH = Math.round(this.rect.h * sf)
    const text = `${physW} × ${physH}`

    ctx.font = `${fontSize}px sans-serif`
    const metrics = ctx.measureText(text)
    const textW = metrics.width
    const textH = fontSize

    const padding = 6 * sf
    const labelW = textW + padding * 2
    const labelH = textH + padding * 1.5
    const gap = 4 * sf

    // 优先选区上方左对齐
    let lx = px
    let ly = py - labelH - gap

    // 超出上边界 → 选区内部左上角（仿 Snow-Shot）
    if (ly < 0) {
      lx = px + gap
      ly = py + gap
    }

    // clamp 到画布内
    const canvasW = this.overlayCanvas.width
    if (lx + labelW > canvasW) {
      lx = canvasW - labelW - gap
    }
    if (lx < 0) lx = gap

    // 背景
    ctx.fillStyle = S.sizeLabelBg
    ctx.beginPath()
    ctx.roundRect(lx, ly, labelW, labelH, 4 * sf)
    ctx.fill()

    // 文字
    ctx.fillStyle = S.sizeLabelColor
    ctx.textBaseline = 'middle'
    ctx.fillText(text, lx + padding, ly + labelH / 2)
  }

  /** 绘制窗口吸附高亮 */
  private drawSnapHighlight(ctx: CanvasRenderingContext2D, sf: number) {
    if (!this.windowSnap) return
    const rect = this.windowSnap.getDisplayRect()
    if (!rect) return

    const px = rect.x * sf
    const py = rect.y * sf
    const pw = rect.w * sf
    const ph = rect.h * sf
    const cr = (this.windowSnap.getCornerRadius() ?? 0) * sf

    // 清除遮罩露出截图（圆角路径）
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(px, py, pw, ph, cr)
    ctx.clip()
    ctx.clearRect(px, py, pw, ph)
    ctx.restore()

    // 蓝色圆角边框
    ctx.strokeStyle = S.borderColor
    ctx.lineWidth = 2 * sf
    ctx.beginPath()
    ctx.roundRect(px, py, pw, ph, cr)
    ctx.stroke()

    // 层级指示器
    {
      const info = this.windowSnap.levelInfo
      if (info.total > 1) {
        const fontSize = 11 * sf
        const text = `${info.current + 1}/${info.total}`
        ctx.font = `bold ${fontSize}px sans-serif`
        const tm = ctx.measureText(text)
        const pad = 4 * sf
        const lw = tm.width + pad * 2
        const lh = fontSize + pad * 1.5
        const lx = px + pw - lw - 2 * sf
        const ly = py + 2 * sf

        ctx.fillStyle = 'rgba(64, 150, 255, 0.85)'
        ctx.beginPath()
        ctx.roundRect(lx, ly, lw, lh, 3 * sf)
        ctx.fill()

        ctx.fillStyle = '#fff'
        ctx.textBaseline = 'middle'
        ctx.fillText(text, lx + pad, ly + lh / 2)
      }
    }
  }

  private drawCrosshair(
    ctx: CanvasRenderingContext2D,
    w: number, h: number,
    sf: number
  ) {
    const mx = this.mouseX * sf
    const my = this.mouseY * sf

    ctx.save()
    ctx.strokeStyle = S.crosshairColor
    ctx.lineWidth = S.crosshairWidth * sf
    ctx.setLineDash(S.crosshairDash.map(v => v * sf))

    // 水平线
    ctx.beginPath()
    ctx.moveTo(0, my)
    ctx.lineTo(w, my)
    ctx.stroke()

    // 垂直线
    ctx.beginPath()
    ctx.moveTo(mx, 0)
    ctx.lineTo(mx, h)
    ctx.stroke()

    ctx.restore()
  }

  // ============ 取色器放大镜 ============

  private drawMagnifier(
    ctx: CanvasRenderingContext2D,
    canvasW: number, canvasH: number,
    sf: number
  ) {
    if (!this.bgCanvas) return
    const bgCtx = this.bgCanvas.getContext('2d')
    if (!bgCtx) return

    const grid = CP.gridSize    // 11
    const zoom = CP.zoom        // 12
    const half = Math.floor(grid / 2) // 5
    const displaySize = CP.canvasSize * sf  // 132 * sf
    const cellSize = zoom * sf              // 12 * sf
    const radius = CP.borderRadius * sf

    // 鼠标物理像素位置
    const pmx = Math.round(this.mouseX * sf)
    const pmy = Math.round(this.mouseY * sf)

    // 从背景 canvas 读取 11×11 像素块
    const srcX = pmx - half
    const srcY = pmy - half
    // getImageData 会自动裁剪超出范围的部分，用 0 填充
    const imgData = bgCtx.getImageData(srcX, srcY, grid, grid)

    // 记录中心像素颜色
    const ci = (half * grid + half) * 4
    this.curColor = [imgData.data[ci], imgData.data[ci + 1], imgData.data[ci + 2]]

    // 放大镜总高度 = 像素网格 + 颜色标签 + 坐标标签
    const labelH = CP.labelHeight * sf
    const posH = CP.posLabelHeight * sf
    const totalH = displaySize + labelH + posH
    const totalW = displaySize

    // 放大镜位置：默认鼠标右下方
    const offsetX = CP.offsetX * sf
    const offsetY = CP.offsetY * sf
    let lx = pmx + offsetX
    let ly = pmy + offsetY

    // 边界检测
    if (lx + totalW > canvasW) lx = pmx - offsetX - totalW
    if (ly + totalH > canvasH) ly = pmy - offsetY - totalH
    if (lx < 0) lx = 0
    if (ly < 0) ly = 0

    ctx.save()

    // 背景圆角矩形
    ctx.fillStyle = CP.bgColor
    ctx.beginPath()
    ctx.roundRect(lx, ly, totalW, totalH, radius)
    ctx.fill()

    // 裁剪像素网格区域（圆角顶部）
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(lx, ly, totalW, displaySize, [radius, radius, 0, 0])
    ctx.clip()

    // 绘制放大像素网格
    for (let row = 0; row < grid; row++) {
      for (let col = 0; col < grid; col++) {
        const idx = (row * grid + col) * 4
        const r = imgData.data[idx]
        const g = imgData.data[idx + 1]
        const b = imgData.data[idx + 2]
        ctx.fillStyle = `rgb(${r},${g},${b})`
        ctx.fillRect(lx + col * cellSize, ly + row * cellSize, cellSize, cellSize)
      }
    }

    ctx.restore()

    // 十字辅助线（穿过中心像素，不覆盖中心像素本身）
    const centerX = lx + half * cellSize + cellSize / 2
    const centerY = ly + half * cellSize + cellSize / 2
    ctx.strokeStyle = CP.crosshairColor
    ctx.lineWidth = 1 * sf

    // 垂直线（上半段）
    ctx.beginPath()
    ctx.moveTo(centerX, ly)
    ctx.lineTo(centerX, ly + half * cellSize)
    ctx.stroke()
    // 垂直线（下半段）
    ctx.beginPath()
    ctx.moveTo(centerX, ly + (half + 1) * cellSize)
    ctx.lineTo(centerX, ly + displaySize)
    ctx.stroke()
    // 水平线（左半段）
    ctx.beginPath()
    ctx.moveTo(lx, centerY)
    ctx.lineTo(lx + half * cellSize, centerY)
    ctx.stroke()
    // 水平线（右半段）
    ctx.beginPath()
    ctx.moveTo(lx + (half + 1) * cellSize, centerY)
    ctx.lineTo(lx + displaySize, centerY)
    ctx.stroke()

    // 中心像素高亮边框
    const [cr, cg, cb] = this.curColor
    // 用反色使边框可见
    const luma = cr * 0.299 + cg * 0.587 + cb * 0.114
    ctx.strokeStyle = luma > 128 ? '#000000' : '#ffffff'
    ctx.lineWidth = CP.centerBorderWidth * sf * 2
    ctx.strokeRect(
      lx + half * cellSize, ly + half * cellSize,
      cellSize, cellSize
    )

    // ---- 下方文本区域 ----
    const textY = ly + displaySize

    // 第一行：颜色预览色块 + 格式标签 + 颜色值
    const fontSize = CP.labelFontSize * sf
    const pad = 6 * sf
    const swatchSize = fontSize
    const colorText = this.formatColor(cr, cg, cb)
    const formatLabel = this.colorFormat.toUpperCase()

    // 小色块
    ctx.fillStyle = `rgb(${cr},${cg},${cb})`
    const swatchY = textY + (labelH - swatchSize) / 2
    ctx.fillRect(lx + pad, swatchY, swatchSize, swatchSize)
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'
    ctx.lineWidth = 1 * sf
    ctx.strokeRect(lx + pad, swatchY, swatchSize, swatchSize)

    // 格式标签（灰色）+ 颜色值（白色）
    ctx.textBaseline = 'middle'
    const textMidY = textY + labelH / 2
    const afterSwatch = lx + pad + swatchSize + 4 * sf

    ctx.font = `bold ${(fontSize * 0.8) | 0}px sans-serif`
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.fillText(formatLabel, afterSwatch, textMidY)
    const labelW = ctx.measureText(formatLabel).width

    ctx.font = `${fontSize}px sans-serif`
    ctx.fillStyle = '#ffffff'
    const valueX = afterSwatch + labelW + 3 * sf
    const maxTextW = totalW - (valueX - lx) - pad
    // 如果文本超宽则缩小字号
    let textMetrics = ctx.measureText(colorText)
    if (textMetrics.width > maxTextW && maxTextW > 0) {
      const scale = maxTextW / textMetrics.width
      ctx.font = `${(fontSize * scale) | 0}px sans-serif`
    }
    ctx.fillText(colorText, valueX, textMidY)

    // 第二行：坐标
    const posY = textY + labelH
    const posText = `(${Math.round(this.mouseX * sf)}, ${Math.round(this.mouseY * sf)})`
    ctx.font = `${(CP.labelFontSize - 1) * sf}px sans-serif`
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.fillText(posText, lx + pad, posY + posH / 2)

    ctx.restore()
  }

  /** 切换颜色格式 HEX → RGB → HSL → HEX */
  cycleColorFormat() {
    const formats = [ColorFormat.HEX, ColorFormat.RGB, ColorFormat.HSL]
    const idx = formats.indexOf(this.colorFormat)
    this.colorFormat = formats[(idx + 1) % formats.length]
  }

  /** 获取当前鼠标位置颜色值的格式化字符串 */
  getColorAtCursor(): string {
    return this.formatColor(this.curColor[0], this.curColor[1], this.curColor[2])
  }

  /** 根据当前格式，返回颜色字符串 */
  private formatColor(r: number, g: number, b: number): string {
    switch (this.colorFormat) {
      case ColorFormat.HEX:
        return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()
      case ColorFormat.RGB:
        return `${r}, ${g}, ${b}`
      case ColorFormat.HSL: {
        const [h, s, l] = rgbToHsl(r, g, b)
        return `${Math.round(h)}, ${Math.round(s)}%, ${Math.round(l)}%`
      }
    }
  }
}

// ============ 工具函数 ============

function normalizeRect(x1: number, y1: number, x2: number, y2: number): SelectRect {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
  }
}

function edgeToCursor(edge: ResizeEdge): string {
  switch (edge) {
    case ResizeEdge.Top: return 'n-resize'
    case ResizeEdge.Bottom: return 's-resize'
    case ResizeEdge.Left: return 'w-resize'
    case ResizeEdge.Right: return 'e-resize'
    case ResizeEdge.TopLeft: return 'nw-resize'
    case ResizeEdge.TopRight: return 'ne-resize'
    case ResizeEdge.BottomLeft: return 'sw-resize'
    case ResizeEdge.BottomRight: return 'se-resize'
    default: return 'crosshair'
  }
}

/** RGB → HSL 转换 */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l * 100]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return [h * 360, s * 100, l * 100]
}
