/**
 * 标注管理器：绘制/管理所有标注元素
 * 支持：矩形、椭圆、箭头、直线、画笔、文字、菱形、序号、模糊、自由模糊、高亮、水印、橡皮擦
 */
import { DrawTool, STROKE_COLORS, STROKE_WIDTH_PRESETS } from './types'
import type { Annotation, SelectRect, BorderStyle, LineStyle, ArrowType, EndpointStyle, PenStyle, CornerStyle } from './types'

let nextId = 1
function genId() { return `ann_${nextId++}` }

export class AnnotationManager {
  /** 所有已完成的标注 */
  annotations: Annotation[] = []
  /** 撤销栈 */
  private undoStack: Annotation[][] = []
  /** 重做栈 */
  private redoStack: Annotation[][] = []

  /** 当前工具 */
  currentTool = DrawTool.None
  /** 当前描边色 */
  strokeColor = STROKE_COLORS[1] // 红色
  /** 当前线宽 */
  strokeWidth = STROKE_WIDTH_PRESETS[1] // 2px
  /** 当前填充色 */
  fillColor = 'transparent'
  /** 当前字号 */
  fontSize = 20
  /** 文本背景色 */
  textBgColor = 'transparent'
  /** 文本描边色 */
  textStrokeColor = 'transparent'
  /** 文本描边宽度 */
  textStrokeWidth = 0
  /** 字体 */
  fontFamily = 'sans-serif'
  /** 文本对齐 */
  textAlign: 'left' | 'center' | 'right' = 'left'
  /** 文本透明度 */
  textOpacity = 1
  /** 通用透明度 */
  opacity = 1
  /** 边框样式 */
  borderStyle: BorderStyle = 'solid'
  /** 线条风格 */
  lineStyle: LineStyle = 'sharp'
  /** 边角样式 */
  cornerStyle: CornerStyle = 'sharp'
  /** 圆角半径 */
  borderRadius = 8
  /** 箭头类型 */
  arrowType: ArrowType = 'normal'
  /** 起点端点 */
  startEndpoint: EndpointStyle = 'none'
  /** 终点端点 */
  endEndpoint: EndpointStyle = 'arrow'
  /** 画笔样式 */
  penStyle: PenStyle = 'round'
  /** 马赛克强度 */
  blurRadius = 10
  /** 涂抹线宽 */
  blurLineWidth = 20
  /** 水印文本 */
  watermarkText = 'WATERMARK'
  /** 水印字号 */
  watermarkFontSize = 24
  /** 水印透明度 */
  watermarkOpacity = 0.15
  /** 水印字体 */
  watermarkFontFamily = 'sans-serif'
  /** 序号计数器 */
  serialCounter = 1

  /** 正在绘制中的临时标注 */
  private tempAnnotation: Annotation | null = null
  /** 画笔临时点集 */
  private tempPoints: [number, number][] = []
  /** 拖拽起点 */
  private dragStartX = 0
  private dragStartY = 0
  /** 是否正在绘制 */
  isDrawing = false

  /** 当前选中的标注 ID */
  selectedId: string | null = null
  /** 是否正在移动选中标注 */
  isMovingSelected = false
  /** 移动起点 */
  private moveStartX = 0
  private moveStartY = 0

  /** 内联文字编辑回调（由前端设置） */
  onRequestTextInput: ((x: number, y: number) => void) | null = null

  /** 文字编辑实时预览（编辑中的临时文本，drawAll 时一并绘制） */
  textPreview: Annotation | null = null

  /** 选区偏移（标注坐标相对于选区） */
  private selectRect: SelectRect = { x: 0, y: 0, w: 0, h: 0 }

  /** 背景 canvas 引用（用于模糊取像素） */
  bgCanvas: HTMLCanvasElement | null = null

  setSelectRect(r: SelectRect) {
    this.selectRect = r
  }

  /** 鼠标坐标（仿 Snow-Shot: 使用绝对坐标，不再相对选区偏移） */
  private toLocal(mx: number, my: number): [number, number] {
    return [mx, my]
  }

  // ============ 鼠标事件 ============

  handleMouseDown(e: MouseEvent): boolean {
    if (e.button !== 0) return false

    const [lx, ly] = this.toLocal(e.clientX, e.clientY)

    // 无工具模式：选择 / 移动标注
    if (this.currentTool === DrawTool.None) {
      // 如果已选中某个标注，检查是否点在它上面 → 开始移动
      if (this.selectedId) {
        const sel = this.annotations.find(a => a.id === this.selectedId)
        if (sel && this.hitTest(sel, lx, ly, 6)) {
          this.saveState()
          this.isMovingSelected = true
          this.moveStartX = lx
          this.moveStartY = ly
          return true
        }
      }
      // 尝试选中一个标注（从上到下遍历，优先选中顶层的）
      let found: Annotation | null = null
      for (let i = this.annotations.length - 1; i >= 0; i--) {
        if (this.hitTest(this.annotations[i], lx, ly, 6)) {
          found = this.annotations[i]
          break
        }
      }
      if (found) {
        this.selectedId = found.id
        // 立即开始移动
        this.saveState()
        this.isMovingSelected = true
        this.moveStartX = lx
        this.moveStartY = ly
        return true
      }
      // 点空白处取消选中
      this.selectedId = null
      return false
    }

    // 有工具模式：正常绘制
    this.selectedId = null // 绘制时取消选中
    this.isDrawing = true
    this.dragStartX = lx
    this.dragStartY = ly

    if (this.currentTool === DrawTool.Pen || this.currentTool === DrawTool.Highlight ||
        this.currentTool === DrawTool.BlurFreeDraw) {
      this.tempPoints = [[lx, ly]]
    }

    if (this.currentTool === DrawTool.Text) {
      this.isDrawing = false
      return this.addTextAnnotation(lx, ly)
    }

    if (this.currentTool === DrawTool.SerialNumber) {
      this.isDrawing = false
      return this.addSerialNumber(lx, ly)
    }

    if (this.currentTool === DrawTool.Watermark) {
      this.isDrawing = false
      return this.addWatermark()
    }

    return true
  }

  handleMouseMove(e: MouseEvent): boolean {
    // 移动选中标注
    if (this.isMovingSelected && this.selectedId) {
      const [lx, ly] = this.toLocal(e.clientX, e.clientY)
      const dx = lx - this.moveStartX
      const dy = ly - this.moveStartY
      this.moveStartX = lx
      this.moveStartY = ly
      const ann = this.annotations.find(a => a.id === this.selectedId)
      if (ann) this.moveAnnotation(ann, dx, dy)
      return true
    }

    if (!this.isDrawing) return false
    const [lx, ly] = this.toLocal(e.clientX, e.clientY)

    if (this.currentTool === DrawTool.Pen || this.currentTool === DrawTool.Highlight ||
        this.currentTool === DrawTool.BlurFreeDraw) {
      this.tempPoints.push([lx, ly])
    }

    this.tempAnnotation = this.buildAnnotation(lx, ly)
    return true
  }

  handleMouseUp(e: MouseEvent): boolean {
    // 结束移动选中标注
    if (this.isMovingSelected) {
      this.isMovingSelected = false
      return true
    }

    if (!this.isDrawing) return false
    this.isDrawing = false

    const [lx, ly] = this.toLocal(e.clientX, e.clientY)
    const ann = this.buildAnnotation(lx, ly)

    if (ann && this.isValidAnnotation(ann)) {
      this.saveState()
      this.annotations.push(ann)
    }

    this.tempAnnotation = null
    this.tempPoints = []
    return true
  }

  // ============ 构建标注 ============

  private buildAnnotation(endX: number, endY: number): Annotation | null {
    const sx = this.dragStartX
    const sy = this.dragStartY
    const base = {
      id: genId(),
      strokeColor: this.strokeColor,
      strokeWidth: this.strokeWidth,
      fillColor: this.fillColor,
      opacity: this.opacity,
      borderStyle: this.borderStyle,
      lineStyle: this.lineStyle,
    }

    switch (this.currentTool) {
      case DrawTool.Rect:
        return { ...base, tool: DrawTool.Rect, x: Math.min(sx, endX), y: Math.min(sy, endY), w: Math.abs(endX - sx), h: Math.abs(endY - sy), cornerStyle: this.cornerStyle, borderRadius: this.borderRadius }
      case DrawTool.Diamond:
        return { ...base, tool: DrawTool.Diamond, x: Math.min(sx, endX), y: Math.min(sy, endY), w: Math.abs(endX - sx), h: Math.abs(endY - sy) }
      case DrawTool.Ellipse:
        return { ...base, tool: DrawTool.Ellipse, cx: (sx + endX) / 2, cy: (sy + endY) / 2, rx: Math.abs(endX - sx) / 2, ry: Math.abs(endY - sy) / 2 }
      case DrawTool.Arrow:
        return { ...base, tool: DrawTool.Arrow, x1: sx, y1: sy, x2: endX, y2: endY, arrowType: this.arrowType, startEndpoint: this.startEndpoint, endEndpoint: this.endEndpoint }
      case DrawTool.Line:
        return { ...base, tool: DrawTool.Line, x1: sx, y1: sy, x2: endX, y2: endY, startEndpoint: this.startEndpoint, endEndpoint: this.endEndpoint }
      case DrawTool.Pen:
        return { ...base, tool: DrawTool.Pen, points: [...this.tempPoints], penStyle: this.penStyle }
      case DrawTool.Highlight:
        return { ...base, tool: DrawTool.Highlight, points: [...this.tempPoints], lineWidth: this.strokeWidth * 6 }
      case DrawTool.BlurFreeDraw:
        return { ...base, tool: DrawTool.BlurFreeDraw, points: [...this.tempPoints], blurRadius: this.blurRadius, lineWidth: this.blurLineWidth }
      case DrawTool.Blur:
        return { ...base, tool: DrawTool.Blur, x: Math.min(sx, endX), y: Math.min(sy, endY), w: Math.abs(endX - sx), h: Math.abs(endY - sy), blurRadius: this.blurRadius }
      case DrawTool.Watermark:
        return {
          ...base, tool: DrawTool.Watermark,
          x: this.selectRect.x, y: this.selectRect.y, w: this.selectRect.w, h: this.selectRect.h,
          text: this.watermarkText, fontSize: this.watermarkFontSize,
          opacity: this.watermarkOpacity, fontFamily: this.watermarkFontFamily,
        }
      default:
        return null
    }
  }

  private isValidAnnotation(ann: Annotation): boolean {
    switch (ann.tool) {
      case DrawTool.Rect:
      case DrawTool.Diamond:
      case DrawTool.Blur:
        return ann.w > 2 && ann.h > 2
      case DrawTool.Ellipse:
        return ann.rx > 1 && ann.ry > 1
      case DrawTool.Arrow:
      case DrawTool.Line:
        return Math.hypot(ann.x2 - ann.x1, ann.y2 - ann.y1) > 3
      case DrawTool.Pen:
      case DrawTool.Highlight:
      case DrawTool.BlurFreeDraw:
        return ann.points.length > 2
      default:
        return true
    }
  }

  private addTextAnnotation(x: number, y: number): boolean {
    // 通知前端显示内联文字编辑器
    if (this.onRequestTextInput) {
      this.onRequestTextInput(x, y)
    }
    return false // 不立刻添加标注，等前端提交
  }

  /** 前端提交文字标注（由内联编辑器调用） */
  commitText(x: number, y: number, text: string): boolean {
    if (!text.trim()) return false
    this.saveState()
    this.annotations.push({
      id: genId(),
      tool: DrawTool.Text,
      strokeColor: this.strokeColor,
      strokeWidth: this.strokeWidth,
      fillColor: this.fillColor,
      x, y,
      text,
      fontSize: this.fontSize,
      bgColor: this.textBgColor,
      textStrokeColor: this.textStrokeColor,
      textStrokeWidth: this.textStrokeWidth,
      fontFamily: this.fontFamily,
      textAlign: this.textAlign,
      opacity: this.textOpacity,
    })
    return true
  }

  private addSerialNumber(x: number, y: number): boolean {
    this.saveState()
    this.annotations.push({
      id: genId(),
      tool: DrawTool.SerialNumber,
      strokeColor: this.strokeColor,
      strokeWidth: this.strokeWidth,
      fillColor: this.fillColor,
      cx: x, cy: y,
      number: this.serialCounter++,
      fontSize: 14,
    })
    return true
  }

  private addWatermark(): boolean {
    if (!this.watermarkText.trim()) return false
    this.saveState()
    this.annotations.push({
      id: genId(),
      tool: DrawTool.Watermark,
      strokeColor: this.strokeColor,
      strokeWidth: this.strokeWidth,
      fillColor: this.fillColor,
      x: this.selectRect.x, y: this.selectRect.y,
      w: this.selectRect.w, h: this.selectRect.h,
      text: this.watermarkText,
      fontSize: this.watermarkFontSize,
      opacity: this.watermarkOpacity,
      fontFamily: this.watermarkFontFamily,
    })
    return true
  }

  // ============ 橡皮擦 ============

  eraseAt(mx: number, my: number, radius = 10): boolean {
    const [lx, ly] = this.toLocal(mx, my)
    const before = this.annotations.length
    this.annotations = this.annotations.filter(ann => !this.hitTest(ann, lx, ly, radius))
    if (this.annotations.length < before) {
      return true
    }
    return false
  }

  private hitTest(ann: Annotation, x: number, y: number, radius: number): boolean {
    switch (ann.tool) {
      case DrawTool.Rect:
      case DrawTool.Diamond:
      case DrawTool.Blur:
        return x >= ann.x - radius && x <= ann.x + ann.w + radius &&
               y >= ann.y - radius && y <= ann.y + ann.h + radius
      case DrawTool.Ellipse:
        return Math.hypot(x - ann.cx, y - ann.cy) <= Math.max(ann.rx, ann.ry) + radius
      case DrawTool.Arrow:
      case DrawTool.Line:
        return distToSegment(x, y, ann.x1, ann.y1, ann.x2, ann.y2) <= radius
      case DrawTool.Pen:
      case DrawTool.Highlight:
      case DrawTool.BlurFreeDraw:
        return ann.points.some(([px, py]) => Math.hypot(x - px, y - py) <= radius)
      case DrawTool.Text:
        return x >= ann.x - radius && x <= ann.x + 100 + radius &&
               y >= ann.y - ann.fontSize - radius && y <= ann.y + radius
      case DrawTool.SerialNumber:
        return Math.hypot(x - ann.cx, y - ann.cy) <= 16 + radius
      default:
        return false
    }
  }

  // ============ 标注移动 ============

  /** 移动标注：偏移 dx/dy（本地坐标） */
  private moveAnnotation(ann: Annotation, dx: number, dy: number) {
    switch (ann.tool) {
      case DrawTool.Rect:
      case DrawTool.Diamond:
      case DrawTool.Blur:
        ann.x += dx; ann.y += dy
        break
      case DrawTool.Ellipse:
        ann.cx += dx; ann.cy += dy
        break
      case DrawTool.Arrow:
      case DrawTool.Line:
        ann.x1 += dx; ann.y1 += dy
        ann.x2 += dx; ann.y2 += dy
        break
      case DrawTool.Pen:
      case DrawTool.Highlight:
      case DrawTool.BlurFreeDraw:
        for (const p of ann.points) { p[0] += dx; p[1] += dy }
        break
      case DrawTool.Text:
      case DrawTool.Watermark:
        ann.x += dx; ann.y += dy
        break
      case DrawTool.SerialNumber:
        ann.cx += dx; ann.cy += dy
        break
    }
  }

  /** 获取标注的包围盒（本地坐标） */
  private getBounds(ann: Annotation): { x: number; y: number; w: number; h: number } {
    switch (ann.tool) {
      case DrawTool.Rect:
      case DrawTool.Diamond:
      case DrawTool.Blur:
        return { x: ann.x, y: ann.y, w: ann.w, h: ann.h }
      case DrawTool.Ellipse:
        return { x: ann.cx - ann.rx, y: ann.cy - ann.ry, w: ann.rx * 2, h: ann.ry * 2 }
      case DrawTool.Arrow:
      case DrawTool.Line: {
        const x = Math.min(ann.x1, ann.x2), y = Math.min(ann.y1, ann.y2)
        return { x, y, w: Math.abs(ann.x2 - ann.x1), h: Math.abs(ann.y2 - ann.y1) }
      }
      case DrawTool.Pen:
      case DrawTool.Highlight:
      case DrawTool.BlurFreeDraw: {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const [px, py] of ann.points) {
          if (px < minX) minX = px
          if (py < minY) minY = py
          if (px > maxX) maxX = px
          if (py > maxY) maxY = py
        }
        return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
      }
      case DrawTool.Text:
        return { x: ann.x, y: ann.y, w: 100, h: ann.fontSize * 1.3 }
      case DrawTool.SerialNumber:
        return { x: ann.cx - 12, y: ann.cy - 12, w: 24, h: 24 }
      case DrawTool.Watermark:
        return { x: ann.x, y: ann.y, w: ann.w, h: ann.h }
      default:
        return { x: 0, y: 0, w: 0, h: 0 }
    }
  }

  /** 删除当前选中的标注 */
  deleteSelected(): boolean {
    if (!this.selectedId) return false
    const idx = this.annotations.findIndex(a => a.id === this.selectedId)
    if (idx === -1) return false
    this.saveState()
    this.annotations.splice(idx, 1)
    this.selectedId = null
    return true
  }

  /** 取消选中 */
  deselect() {
    this.selectedId = null
    this.isMovingSelected = false
  }

  /** 检查鼠标位置是否有标注（用于光标判断） */
  hasAnnotationAt(mx: number, my: number): boolean {
    const [lx, ly] = this.toLocal(mx, my)
    for (let i = this.annotations.length - 1; i >= 0; i--) {
      if (this.hitTest(this.annotations[i], lx, ly, 6)) return true
    }
    return false
  }

  /** 绘制选中标注的选框和控制点 */
  private drawSelectionHandles(ctx: CanvasRenderingContext2D, ann: Annotation, sf: number) {
    const b = this.getBounds(ann)
    const pad = 4
    const x = (b.x - pad) * sf
    const y = (b.y - pad) * sf
    const w = (b.w + pad * 2) * sf
    const h = (b.h + pad * 2) * sf

    ctx.save()
    ctx.strokeStyle = '#4096ff'
    ctx.lineWidth = 1.5 * sf
    ctx.setLineDash([4 * sf, 3 * sf])
    ctx.strokeRect(x, y, w, h)
    ctx.setLineDash([])

    // 控制点
    const r = 3.5 * sf
    const drawHandle = (hx: number, hy: number) => {
      ctx.beginPath()
      ctx.arc(hx, hy, r, 0, Math.PI * 2)
      ctx.fillStyle = '#ffffff'
      ctx.fill()
      ctx.strokeStyle = '#4096ff'
      ctx.lineWidth = 1.5 * sf
      ctx.stroke()
    }
    // 四角
    drawHandle(x, y)
    drawHandle(x + w, y)
    drawHandle(x, y + h)
    drawHandle(x + w, y + h)
    // 四边中点（大于 48px 时才显示）
    if (w > 48 * sf) {
      drawHandle(x + w / 2, y)
      drawHandle(x + w / 2, y + h)
    }
    if (h > 48 * sf) {
      drawHandle(x, y + h / 2)
      drawHandle(x + w, y + h / 2)
    }

    ctx.restore()
  }

  // ============ Undo/Redo ============

  private saveState() {
    this.undoStack.push(this.cloneAnnotations())
    this.redoStack = []
  }

  private cloneAnnotations() {
    return this.annotations.map(a => {
      const copy = { ...a } as any
      if ('points' in copy && Array.isArray(copy.points)) {
        copy.points = copy.points.map((p: [number, number]) => [p[0], p[1]] as [number, number])
      }
      return copy
    })
  }

  undo(): boolean {
    if (this.undoStack.length === 0) return false
    this.redoStack.push(this.cloneAnnotations())
    this.annotations = this.undoStack.pop()!
    return true
  }

  redo(): boolean {
    if (this.redoStack.length === 0) return false
    this.undoStack.push(this.cloneAnnotations())
    this.annotations = this.redoStack.pop()!
    return true
  }

  get canUndo() { return this.undoStack.length > 0 }
  get canRedo() { return this.redoStack.length > 0 }

  // ============ 绘制 ============

  drawAll(ctx: CanvasRenderingContext2D, sf: number) {
    for (const ann of this.annotations) {
      this.drawAnnotation(ctx, ann, sf)
    }
    if (this.tempAnnotation) {
      this.drawAnnotation(ctx, this.tempAnnotation, sf)
    }
    if (this.textPreview) {
      this.drawAnnotation(ctx, this.textPreview, sf)
    }
    // 绘制选中标注的选框
    if (this.selectedId) {
      const sel = this.annotations.find(a => a.id === this.selectedId)
      if (sel) this.drawSelectionHandles(ctx, sel, sf)
    }
  }

  drawAnnotation(ctx: CanvasRenderingContext2D, ann: Annotation, sf: number) {
    ctx.save()
    ctx.globalAlpha = ann.opacity ?? 1
    ctx.strokeStyle = ann.strokeColor
    ctx.lineWidth = ann.strokeWidth * sf
    ctx.fillStyle = ann.fillColor
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'

    // 边框样式（虚线/点线）
    if (ann.borderStyle === 'dashed') {
      ctx.setLineDash([8 * sf, 4 * sf])
    } else if (ann.borderStyle === 'dotted') {
      ctx.setLineDash([2 * sf, 3 * sf])
    }

    // 线条风格：thick 加粗
    if (ann.lineStyle === 'thick') {
      ctx.lineWidth = ann.strokeWidth * sf * 2.5
    }

    switch (ann.tool) {
      case DrawTool.Rect:
        this.drawRect(ctx, ann, sf)
        break
      case DrawTool.Diamond:
        this.drawDiamond(ctx, ann, sf)
        break
      case DrawTool.Ellipse:
        this.drawEllipse(ctx, ann, sf)
        break
      case DrawTool.Arrow:
        this.drawArrow(ctx, ann, sf)
        break
      case DrawTool.Line:
        this.drawLine(ctx, ann, sf)
        break
      case DrawTool.Pen:
        this.drawPen(ctx, ann, sf)
        break
      case DrawTool.Text:
        this.drawText(ctx, ann, sf)
        break
      case DrawTool.SerialNumber:
        this.drawSerialNumber(ctx, ann, sf)
        break
      case DrawTool.Blur:
        this.drawBlur(ctx, ann, sf)
        break
      case DrawTool.BlurFreeDraw:
        this.drawBlurFreeDraw(ctx, ann, sf)
        break
      case DrawTool.Highlight:
        this.drawHighlight(ctx, ann, sf)
        break
      case DrawTool.Watermark:
        this.drawWatermark(ctx, ann, sf)
        break
    }
    ctx.restore()
  }

  private drawRect(ctx: CanvasRenderingContext2D, a: { x: number; y: number; w: number; h: number; fillColor: string; cornerStyle?: string; borderRadius?: number }, sf: number) {
    const x = a.x * sf, y = a.y * sf, w = a.w * sf, h = a.h * sf
    const r = (a.cornerStyle === 'round' && a.borderRadius) ? a.borderRadius * sf : 0

    if (r > 0) {
      // 圆角矩形
      const rr = Math.min(r, w / 2, h / 2)
      ctx.beginPath()
      ctx.moveTo(x + rr, y)
      ctx.lineTo(x + w - rr, y)
      ctx.arcTo(x + w, y, x + w, y + rr, rr)
      ctx.lineTo(x + w, y + h - rr)
      ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr)
      ctx.lineTo(x + rr, y + h)
      ctx.arcTo(x, y + h, x, y + h - rr, rr)
      ctx.lineTo(x, y + rr)
      ctx.arcTo(x, y, x + rr, y, rr)
      ctx.closePath()
      if (a.fillColor !== 'transparent') {
        ctx.fillStyle = a.fillColor
        ctx.fill()
      }
      ctx.stroke()
    } else {
      if (a.fillColor !== 'transparent') {
        ctx.fillStyle = a.fillColor
        ctx.fillRect(x, y, w, h)
      }
      ctx.strokeRect(x, y, w, h)
    }
  }

  private drawDiamond(ctx: CanvasRenderingContext2D, a: { x: number; y: number; w: number; h: number; fillColor: string; lineStyle?: string }, sf: number) {
    const cx = (a.x + a.w / 2) * sf, cy = (a.y + a.h / 2) * sf
    const hw = a.w / 2 * sf, hh = a.h / 2 * sf
    ctx.beginPath()
    if (a.lineStyle === 'curve') {
      // 曲线菱形（圆滑）
      const k = 0.4
      ctx.moveTo(cx, cy - hh)
      ctx.bezierCurveTo(cx + hw * k, cy - hh, cx + hw, cy - hh * k, cx + hw, cy)
      ctx.bezierCurveTo(cx + hw, cy + hh * k, cx + hw * k, cy + hh, cx, cy + hh)
      ctx.bezierCurveTo(cx - hw * k, cy + hh, cx - hw, cy + hh * k, cx - hw, cy)
      ctx.bezierCurveTo(cx - hw, cy - hh * k, cx - hw * k, cy - hh, cx, cy - hh)
    } else {
      ctx.moveTo(cx, cy - hh)
      ctx.lineTo(cx + hw, cy)
      ctx.lineTo(cx, cy + hh)
      ctx.lineTo(cx - hw, cy)
    }
    ctx.closePath()
    if (a.fillColor !== 'transparent') ctx.fill()
    ctx.stroke()
  }

  private drawEllipse(ctx: CanvasRenderingContext2D, a: { cx: number; cy: number; rx: number; ry: number; fillColor: string }, sf: number) {
    ctx.beginPath()
    ctx.ellipse(a.cx * sf, a.cy * sf, a.rx * sf, a.ry * sf, 0, 0, Math.PI * 2)
    if (a.fillColor !== 'transparent') ctx.fill()
    ctx.stroke()
  }

  private drawArrow(ctx: CanvasRenderingContext2D, a: { x1: number; y1: number; x2: number; y2: number; arrowType?: string; startEndpoint?: string; endEndpoint?: string; lineStyle?: string }, sf: number) {
    const x1 = a.x1 * sf, y1 = a.y1 * sf, x2 = a.x2 * sf, y2 = a.y2 * sf
    const arrowType = a.arrowType || 'normal'
    const startEp = a.startEndpoint || 'none'
    const endEp = a.endEndpoint || 'arrow'

    // 线段（curve 风格用贝塞尔曲线）
    ctx.beginPath()
    if (a.lineStyle === 'curve') {
      const dx = x2 - x1, dy = y2 - y1
      const cx1 = x1 + dx * 0.25 - dy * 0.15
      const cy1 = y1 + dy * 0.25 + dx * 0.15
      const cx2 = x1 + dx * 0.75 - dy * 0.15
      const cy2 = y1 + dy * 0.75 + dx * 0.15
      ctx.moveTo(x1, y1)
      ctx.bezierCurveTo(cx1, cy1, cx2, cy2, x2, y2)
    } else {
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
    }
    ctx.stroke()

    // 绘制端点箭头
    const drawArrowHead = (px: number, py: number, angle: number) => {
      const headLen = arrowType === 'thin' ? 10 * sf : arrowType === 'block' ? 16 * sf : 12 * sf
      const halfAngle = arrowType === 'thin' ? Math.PI / 8 : arrowType === 'block' ? Math.PI / 5 : Math.PI / 6

      if (arrowType === 'block') {
        // 实心三角箭头
        ctx.beginPath()
        ctx.moveTo(px, py)
        ctx.lineTo(px - headLen * Math.cos(angle - halfAngle), py - headLen * Math.sin(angle - halfAngle))
        ctx.lineTo(px - headLen * Math.cos(angle + halfAngle), py - headLen * Math.sin(angle + halfAngle))
        ctx.closePath()
        ctx.fillStyle = ctx.strokeStyle
        ctx.fill()
      } else {
        // 线条箭头
        ctx.beginPath()
        ctx.moveTo(px, py)
        ctx.lineTo(px - headLen * Math.cos(angle - halfAngle), py - headLen * Math.sin(angle - halfAngle))
        ctx.moveTo(px, py)
        ctx.lineTo(px - headLen * Math.cos(angle + halfAngle), py - headLen * Math.sin(angle + halfAngle))
        ctx.stroke()
      }
    }

    // 终点箭头
    if (endEp === 'arrow') {
      const angle = Math.atan2(y2 - y1, x2 - x1)
      drawArrowHead(x2, y2, angle)
    }
    // 起点箭头
    if (startEp === 'arrow') {
      const angle = Math.atan2(y1 - y2, x1 - x2)
      drawArrowHead(x1, y1, angle)
    }
  }

  private drawLine(ctx: CanvasRenderingContext2D, a: { x1: number; y1: number; x2: number; y2: number; lineStyle?: string }, sf: number) {
    const x1 = a.x1 * sf, y1 = a.y1 * sf, x2 = a.x2 * sf, y2 = a.y2 * sf
    ctx.beginPath()
    if (a.lineStyle === 'curve') {
      const dx = x2 - x1, dy = y2 - y1
      const cx = (x1 + x2) / 2 - dy * 0.2
      const cy = (y1 + y2) / 2 + dx * 0.2
      ctx.moveTo(x1, y1)
      ctx.quadraticCurveTo(cx, cy, x2, y2)
    } else {
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
    }
    ctx.stroke()
  }

  private drawPen(ctx: CanvasRenderingContext2D, a: { points: [number, number][]; penStyle?: string }, sf: number) {
    if (a.points.length < 2) return

    if (a.penStyle === 'chisel') {
      // 平头笔刷：用 butt lineCap + 斜角效果
      ctx.lineCap = 'square'
      ctx.lineJoin = 'bevel'
    }

    ctx.beginPath()
    ctx.moveTo(a.points[0][0] * sf, a.points[0][1] * sf)
    for (let i = 1; i < a.points.length; i++) {
      ctx.lineTo(a.points[i][0] * sf, a.points[i][1] * sf)
    }
    ctx.stroke()
  }

  private drawText(ctx: CanvasRenderingContext2D, a: { x: number; y: number; text: string; fontSize: number; strokeColor: string; bgColor?: string; textStrokeColor?: string; textStrokeWidth?: number; fontFamily?: string; textAlign?: string; opacity?: number }, sf: number) {
    ctx.save()
    ctx.globalAlpha = a.opacity ?? 1

    const fontSize = a.fontSize * sf
    const fontFamily = a.fontFamily || 'sans-serif'
    ctx.font = `${fontSize}px ${fontFamily}`
    ctx.textBaseline = 'top'

    const align = a.textAlign || 'left'

    // 多行文字处理
    const lines = a.text.split('\n')
    const lineHeight = fontSize * 1.3
    const padding = 4 * sf

    // 计算文字宽度（取最宽行）
    let maxWidth = 0
    for (const line of lines) {
      const w = ctx.measureText(line).width
      if (w > maxWidth) maxWidth = w
    }
    const totalW = maxWidth + padding * 2
    const totalH = lineHeight * lines.length + padding * 2

    const bx = a.x * sf
    const by = a.y * sf

    // 绘制文本背景
    if (a.bgColor && a.bgColor !== 'transparent') {
      ctx.fillStyle = a.bgColor
      ctx.fillRect(bx, by, totalW, totalH)
    }

    // 判断是否有文本描边
    const hasTextStroke = a.textStrokeColor && a.textStrokeColor !== 'transparent' && (a.textStrokeWidth ?? 0) > 0

    // 绘制每行文字
    for (let i = 0; i < lines.length; i++) {
      const ly = by + padding + i * lineHeight
      let lx = bx + padding

      if (align === 'center') {
        lx = bx + totalW / 2 - ctx.measureText(lines[i]).width / 2
      } else if (align === 'right') {
        lx = bx + totalW - padding - ctx.measureText(lines[i]).width
      }

      // 文本描边（先画描边，再画填充，描边在下面）
      if (hasTextStroke) {
        ctx.save()
        ctx.strokeStyle = a.textStrokeColor!
        ctx.lineWidth = (a.textStrokeWidth! * 2) * sf // 描边宽度 ×2 因为一半被填充覆盖
        ctx.lineJoin = 'round'
        ctx.miterLimit = 2
        ctx.strokeText(lines[i], lx, ly)
        ctx.restore()
      }

      // 文本填充
      ctx.fillStyle = a.strokeColor
      ctx.fillText(lines[i], lx, ly)
    }

    ctx.restore()
  }

  private drawSerialNumber(ctx: CanvasRenderingContext2D, a: { cx: number; cy: number; number: number; fontSize: number; strokeColor: string }, sf: number) {
    const cx = a.cx * sf, cy = a.cy * sf, r = 12 * sf
    // 圆圈
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fillStyle = a.strokeColor
    ctx.fill()
    // 数字
    ctx.fillStyle = '#ffffff'
    ctx.font = `bold ${a.fontSize * sf}px sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(a.number), cx, cy)
    ctx.textAlign = 'start'
  }

  private drawBlur(ctx: CanvasRenderingContext2D, a: { x: number; y: number; w: number; h: number; blurRadius: number }, sf: number) {
    if (!this.bgCanvas) return
    const px = a.x * sf, py = a.y * sf, pw = Math.round(a.w * sf), ph = Math.round(a.h * sf)
    if (pw < 1 || ph < 1) return
    const bgCtx = this.bgCanvas.getContext('2d')
    if (!bgCtx) return
    const blockSize = Math.max(4, Math.round(a.blurRadius * sf / 2))
    try {
      // 绝对坐标系：标注坐标已经是绝对坐标，直接取像素
      const imgData = bgCtx.getImageData(px, py, pw, ph)
      pixelate(imgData, blockSize)
      // 用离屏 canvas + drawImage（drawImage 受 translate 影响，putImageData 不受）
      const tmp = document.createElement('canvas')
      tmp.width = pw
      tmp.height = ph
      tmp.getContext('2d')!.putImageData(imgData, 0, 0)
      ctx.drawImage(tmp, px, py)
    } catch {}
  }

  private drawBlurFreeDraw(ctx: CanvasRenderingContext2D, a: { points: [number, number][]; blurRadius: number; lineWidth: number }, sf: number) {
    if (a.points.length < 2 || !this.bgCanvas) return
    const bgCtx = this.bgCanvas.getContext('2d')
    if (!bgCtx) return

    const lw = a.lineWidth * sf
    const blockSize = Math.max(4, Math.round(a.blurRadius * sf / 2))

    // 计算涂抹路径的包围盒
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [px, py] of a.points) {
      const sx = px * sf, sy = py * sf
      if (sx < minX) minX = sx
      if (sy < minY) minY = sy
      if (sx > maxX) maxX = sx
      if (sy > maxY) maxY = sy
    }
    // 扩展包围盒（线宽半径）
    const half = lw / 2
    minX = Math.max(0, Math.floor(minX - half))
    minY = Math.max(0, Math.floor(minY - half))
    maxX = Math.ceil(maxX + half)
    maxY = Math.ceil(maxY + half)
    const bw = maxX - minX, bh = maxY - minY
    if (bw < 1 || bh < 1) return

    try {
      // 从背景取像素并马赛克化（绝对坐标系：直接取）
      const imgData = bgCtx.getImageData(minX, minY, bw, bh)
      pixelate(imgData, blockSize)

      // 把马赛克像素放到临时 canvas（putImageData 不受 compositing 影响）
      const mosaicCanvas = document.createElement('canvas')
      mosaicCanvas.width = bw
      mosaicCanvas.height = bh
      mosaicCanvas.getContext('2d')!.putImageData(imgData, 0, 0)

      // 用离屏 canvas 做路径裁切
      const offCanvas = document.createElement('canvas')
      offCanvas.width = bw
      offCanvas.height = bh
      const offCtx = offCanvas.getContext('2d')!

      // 画涂抹路径作为 mask
      offCtx.lineWidth = lw
      offCtx.lineCap = 'round'
      offCtx.lineJoin = 'round'
      offCtx.strokeStyle = '#000'
      offCtx.beginPath()
      offCtx.moveTo(a.points[0][0] * sf - minX, a.points[0][1] * sf - minY)
      for (let i = 1; i < a.points.length; i++) {
        offCtx.lineTo(a.points[i][0] * sf - minX, a.points[i][1] * sf - minY)
      }
      offCtx.stroke()

      // 用 source-in 把马赛克限制在笔触路径内
      offCtx.globalCompositeOperation = 'source-in'
      offCtx.drawImage(mosaicCanvas, 0, 0)

      // 画到主 canvas
      ctx.drawImage(offCanvas, minX, minY)
    } catch {}
  }

  private drawHighlight(ctx: CanvasRenderingContext2D, a: { points: [number, number][]; lineWidth: number; strokeColor: string }, sf: number) {
    if (a.points.length < 2) return
    ctx.save()
    ctx.globalAlpha = 0.35
    ctx.strokeStyle = a.strokeColor
    ctx.lineWidth = a.lineWidth * sf
    ctx.beginPath()
    ctx.moveTo(a.points[0][0] * sf, a.points[0][1] * sf)
    for (let i = 1; i < a.points.length; i++) {
      ctx.lineTo(a.points[i][0] * sf, a.points[i][1] * sf)
    }
    ctx.stroke()
    ctx.restore()
  }

  private drawWatermark(ctx: CanvasRenderingContext2D, a: { x: number; y: number; w: number; h: number; text: string; fontSize: number; opacity: number; strokeColor: string; fontFamily: string }, sf: number) {
    if (!a.text.trim()) return
    ctx.save()
    ctx.globalAlpha = a.opacity

    // 裁剪到水印区域
    ctx.beginPath()
    ctx.rect(a.x * sf, a.y * sf, a.w * sf, a.h * sf)
    ctx.clip()

    ctx.fillStyle = a.strokeColor
    const fs = a.fontSize * sf
    ctx.font = `bold ${fs}px ${a.fontFamily}`
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'

    // 计算文本尺寸
    const tm = ctx.measureText(a.text)
    const textW = tm.width
    const textH = fs * 1.2

    // 45° 旋转平铺
    const angle = -Math.PI / 6 // -30°
    const padding = 32 * sf
    const cellW = textW + padding
    const cellH = textH + padding

    // 区域中心
    const cx = (a.x + a.w / 2) * sf
    const cy = (a.y + a.h / 2) * sf
    const diagonal = Math.hypot(a.w * sf, a.h * sf)

    ctx.translate(cx, cy)
    ctx.rotate(angle)

    const cols = Math.ceil(diagonal / cellW) + 2
    const rows = Math.ceil(diagonal / cellH) + 2

    for (let r = -rows; r <= rows; r++) {
      for (let c = -cols; c <= cols; c++) {
        ctx.fillText(a.text, c * cellW, r * cellH)
      }
    }

    ctx.restore()
  }

  // ============ 图层操作 ============

  /** 将最后一个标注下移一层 */
  moveLastDown(): boolean {
    const len = this.annotations.length
    if (len < 2) return false
    this.saveState()
    const last = this.annotations[len - 1]
    this.annotations[len - 1] = this.annotations[len - 2]
    this.annotations[len - 2] = last
    return true
  }

  /** 将最后一个标注移到最底层 */
  moveLastToBottom(): boolean {
    const len = this.annotations.length
    if (len < 2) return false
    this.saveState()
    const last = this.annotations.pop()!
    this.annotations.unshift(last)
    return true
  }

  /** 将第一个标注上移一层 */
  moveFirstUp(): boolean {
    const len = this.annotations.length
    if (len < 2) return false
    this.saveState()
    const first = this.annotations[0]
    this.annotations[0] = this.annotations[1]
    this.annotations[1] = first
    return true
  }

  /** 将第一个标注移到最顶层 */
  moveFirstToTop(): boolean {
    const len = this.annotations.length
    if (len < 2) return false
    this.saveState()
    const first = this.annotations.shift()!
    this.annotations.push(first)
    return true
  }

  /** 重置 */
  reset() {
    this.annotations = []
    this.undoStack = []
    this.redoStack = []
    this.tempAnnotation = null
    this.tempPoints = []
    this.isDrawing = false
    this.isMovingSelected = false
    this.selectedId = null
    this.serialCounter = 1
    this.currentTool = DrawTool.None
    this.onRequestTextInput = null
    this.textPreview = null
  }
}

// ============ 工具函数 ============

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const A = px - x1, B = py - y1, C = x2 - x1, D = y2 - y1
  const dot = A * C + B * D
  const lenSq = C * C + D * D
  let param = lenSq === 0 ? -1 : dot / lenSq
  param = Math.max(0, Math.min(1, param))
  const xx = x1 + param * C
  const yy = y1 + param * D
  return Math.hypot(px - xx, py - yy)
}

function pixelate(imageData: ImageData, blockSize: number) {
  const { data, width, height } = imageData
  for (let y = 0; y < height; y += blockSize) {
    for (let x = 0; x < width; x += blockSize) {
      let r = 0, g = 0, b = 0, count = 0
      for (let dy = 0; dy < blockSize && y + dy < height; dy++) {
        for (let dx = 0; dx < blockSize && x + dx < width; dx++) {
          const i = ((y + dy) * width + (x + dx)) * 4
          r += data[i]; g += data[i + 1]; b += data[i + 2]
          count++
        }
      }
      r = Math.round(r / count); g = Math.round(g / count); b = Math.round(b / count)
      for (let dy = 0; dy < blockSize && y + dy < height; dy++) {
        for (let dx = 0; dx < blockSize && x + dx < width; dx++) {
          const i = ((y + dy) * width + (x + dx)) * 4
          data[i] = r; data[i + 1] = g; data[i + 2] = b
        }
      }
    }
  }
}
