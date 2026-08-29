/*
  像素级抓框。

  窗口级吸附靠系统告诉我们每个窗口在哪;窗口里面的东西 —— 任务栏这一行、一个输入框、
  VS Code 被分隔线切开的目录栏和编辑区 —— 系统层面要么拿不到,要么(UI Automation)在透明覆盖窗口
  底下会穿透到被遮挡的窗口。这里不问系统,直接看像素:

  1. 截屏后算一遍边缘图:相邻两个像素任一颜色通道差 ≥ EDGE_T 就算中间有一条边。
     水平边(分隔上下)和竖直边(分隔左右)各一张位图,一屏 2M 像素二十毫秒,截一次算一次。
  2. 鼠标落在 (x, y):沿这一列往上、往下,沿这一行往左、往右,各找**最近的一条像样的边线**
     (连续,允许几个像素的小断口 —— 抗锯齿、文字底线穿过都会打断一下)。四条线围成的就是这个元素。
     文字笔画也是边,但短、碎,凑不出足够长的连续线,自然被跳过。
  3. 一条边线属不属于"包住鼠标的框",看它两端往哪边拐:输入框右边那条竖线,两端的横边往左(框内)拐;
     而任务栏上一个图标的左边那条竖线,两端往右(图标那边)拐 —— 那是别人的框,跳过它继续往外找。
     不做这一步,鼠标停在任务栏空白处会被邻近图标截成半条。
  4. 四条边找齐后互相复核:每条边线得覆盖矩形对应边长的大部分,不够的那一侧再往外找,最多来回三轮。
     屏幕 / 窗口边界当作天然的边。
  5. 从找到的框再往外找一圈得到容器,最多三层,滚轮切换;只差一两个像素的(边框内外)算同一层。

  没有 DOM 依赖,纯数组运算 —— 方便在 Node 里拿一张截图直接跑着调参。
*/

/** 像素坐标,左闭右开:[x0, x1) × [y0, y1) */
export type PxRect = { x0: number; y0: number; x1: number; y1: number }

/** 相邻像素任一通道差 ≥ 这个就算一条边。VS Code 那种 #333 / #252526 的分隔线差 14 左右,阈值要压得低 */
const EDGE_T = 12
/** 一条边线上允许的小断口(像素) */
const GAP = 3
/** 第一轮找上下边时,边线至少这么长才算"边线"(短于这个多半是文字笔画) */
const MIN_LEN = 32
/** 框的最小尺寸,再小就是图标里的花纹了 */
const MIN_W = 12
const MIN_H = 8
/** 一条边线要覆盖矩形对应边长的这个比例,这一侧才算成立 */
const COVER = 0.6
/** 至少几侧成立才认这个框 */
const MIN_SIDES = 3
/** 拐角判断时沿另一方向看多远 */
const CORNER_L = 4
/** 复核最多来回几轮 */
const MAX_ROUNDS = 3
/** 这么长的线一定是结构分隔线,不做拐角判断 */
const LONG_LINE = 6 * MIN_LEN
/** 第一轮每个方向收集几条候选边线 */
const CANDS = 4

type Run = [number, number]

export class PixelSnap {
  w = 0
  h = 0
  /** [y*w+x] = 1:(x,y) 和 (x,y+1) 之间有一条水平边 */
  private hEdge = new Uint8Array(0)
  /** [y*w+x] = 1:(x,y) 和 (x+1,y) 之间有一条竖直边 */
  private vEdge = new Uint8Array(0)

  get ready(): boolean {
    return this.w > 0
  }

  /** 喂一帧 RGBA(或 BGRA —— 只看通道差,顺序无所谓),算两张边缘位图 */
  setFrame(px: Uint8ClampedArray | Uint8Array, w: number, h: number): void {
    this.w = w
    this.h = h
    const n = w * h
    const hE = new Uint8Array(n)
    const vE = new Uint8Array(n)
    const T = EDGE_T
    const rowBytes = w << 2
    for (let y = 0; y < h; y++) {
      const row = y * w
      const hasBelow = y + 1 < h
      for (let x = 0; x < w; x++) {
        const i = (row + x) << 2
        const r = px[i], g = px[i + 1], b = px[i + 2]
        if (x + 1 < w) {
          const j = i + 4
          let d = r - px[j]; if (d < 0) d = -d
          let e = g - px[j + 1]; if (e < 0) e = -e
          let f = b - px[j + 2]; if (f < 0) f = -f
          if (d >= T || e >= T || f >= T) vE[row + x] = 1
        }
        if (hasBelow) {
          const j = i + rowBytes
          let d = r - px[j]; if (d < 0) d = -d
          let e = g - px[j + 1]; if (e < 0) e = -e
          let f = b - px[j + 2]; if (f < 0) f = -f
          if (d >= T || e >= T || f >= T) hE[row + x] = 1
        }
      }
    }
    this.hEdge = hE
    this.vEdge = vE
  }

  clear(): void {
    this.w = 0
    this.h = 0
    this.hEdge = new Uint8Array(0)
    this.vEdge = new Uint8Array(0)
  }

  // ─── 边线 ────────────────────────────────────────────

  /** 第 r 行的水平边线,从 x 往两边延伸(容忍 GAP 断口),返回覆盖范围 [l, rgt) */
  private hRun(r: number, x: number, xa: number, xb: number): Run {
    const e = this.hEdge
    const base = r * this.w
    let l = x, gap = 0
    for (let i = x - 1; i >= xa; i--) {
      if (e[base + i]) { l = i; gap = 0 } else if (++gap > GAP) break
    }
    let rgt = x + 1
    gap = 0
    for (let i = x + 1; i < xb; i++) {
      if (e[base + i]) { rgt = i + 1; gap = 0 } else if (++gap > GAP) break
    }
    return [l, rgt]
  }

  /** 第 c 列的竖直边线,从 y 往两头延伸,返回覆盖范围 [t, btm) */
  private vRun(c: number, y: number, ya: number, yb: number): Run {
    const e = this.vEdge
    const w = this.w
    let t = y, gap = 0
    for (let i = y - 1; i >= ya; i--) {
      if (e[i * w + c]) { t = i; gap = 0 } else if (++gap > GAP) break
    }
    let btm = y + 1
    gap = 0
    for (let i = y + 1; i < yb; i++) {
      if (e[i * w + c]) { btm = i + 1; gap = 0 } else if (++gap > GAP) break
    }
    return [t, btm]
  }

  /** 行 r 上,从列 c 往 dir 方向数 L 个像素里有几个水平边像素 */
  private hCount(r: number, c: number, dir: number, L: number): number {
    if (r < 0 || r >= this.h) return 0
    const base = r * this.w
    let n = 0
    for (let k = 1; k <= L; k++) {
      const x = c + dir * k
      if (x < 0 || x >= this.w) break
      if (this.hEdge[base + x]) n++
    }
    return n
  }

  /** 列 c 上,从行 r 往 dir 方向数 L 个像素里有几个竖直边像素 */
  private vCount(c: number, r: number, dir: number, L: number): number {
    if (c < 0 || c >= this.w) return 0
    let n = 0
    for (let k = 1; k <= L; k++) {
      const y = r + dir * k
      if (y < 0 || y >= this.h) break
      if (this.vEdge[y * this.w + c]) n++
    }
    return n
  }

  /**
   * 竖直边线 c(范围 [t,b))两端的横边往框内拐还是往框外拐。
   * inDir = +1 表示框内在右边(这是左侧边),-1 表示框内在左边(右侧边)。
   * 往外拐得明显 → 这条边属于外面另一个盒子,不是包住鼠标的框。
   */
  private vBendsOut(c: number, t: number, b: number, inDir: number, ya: number, yb: number): boolean {
    if (b - t >= LONG_LINE) return false   // 几百像素的分隔线,不管两头连着什么都是结构线
    const L = CORNER_L
    const inn = this.hCount(t - 1, c, inDir, L) + this.hCount(t, c, inDir, L)
      + this.hCount(b - 1, c, inDir, L) + this.hCount(b, c, inDir, L)
    const out = this.hCount(t - 1, c, -inDir, L) + this.hCount(t, c, -inDir, L)
      + this.hCount(b - 1, c, -inDir, L) + this.hCount(b, c, -inDir, L)
    if (out >= 2 && out > inn + 1) return true
    // 没有任何横边相连、又不是贯穿整个范围的分隔线:是孤零零一段竖线(图标笔画、活动指示条之类),不是框的边
    const spans = t <= ya + 4 && b >= yb - 4
    return !spans && inn + out === 0
  }

  /** 水平边线 r(范围 [l,rgt))两端的竖边往框内拐(inDir=+1 框内在下,-1 框内在上)还是往外拐 */
  private hBendsOut(r: number, l: number, rgt: number, inDir: number, xa: number, xb: number): boolean {
    if (rgt - l >= LONG_LINE) return false
    const L = CORNER_L
    const inn = this.vCount(l - 1, r, inDir, L) + this.vCount(l, r, inDir, L)
      + this.vCount(rgt - 1, r, inDir, L) + this.vCount(rgt, r, inDir, L)
    const out = this.vCount(l - 1, r, -inDir, L) + this.vCount(l, r, -inDir, L)
      + this.vCount(rgt - 1, r, -inDir, L) + this.vCount(rgt, r, -inDir, L)
    if (out >= 2 && out > inn + 1) return true
    const spans = l <= xa + 4 && rgt >= xb - 4
    return !spans && inn + out === 0
  }

  // ─── 四个方向找边 ─────────────────────────────────────

  /**
   * 从 start 往上找上边。span 给了(已知左右范围)就按覆盖率要求,否则按 MIN_LEN。
   * 返回 [top(框的第一行), run];找到边界返回 [ya, [xa, xb]]
   */
  private seekTop(x: number, start: number, xa: number, xb: number, ya: number, span: Run | null): [number, Run] {
    const w = this.w
    for (let r = start; r >= ya; r--) {
      if (!this.hEdge[r * w + x]) continue
      const run = this.hRun(r, x, xa, xb)
      if (!this.hRunOk(run, span)) continue
      if (this.hBendsOut(r, run[0], run[1], +1, xa, xb)) continue   // 框内在下方
      return [r + 1, run]
    }
    return [ya, [xa, xb]]
  }

  private seekBottom(x: number, start: number, xa: number, xb: number, yb: number, span: Run | null): [number, Run] {
    const w = this.w
    for (let r = start; r < yb - 1; r++) {
      if (!this.hEdge[r * w + x]) continue
      const run = this.hRun(r, x, xa, xb)
      if (!this.hRunOk(run, span)) continue
      if (this.hBendsOut(r, run[0], run[1], -1, xa, xb)) continue   // 框内在上方
      return [r + 1, run]
    }
    return [yb, [xa, xb]]
  }

  private seekLeft(y: number, start: number, ya: number, yb: number, xa: number, span: Run | null): [number, Run] {
    const w = this.w
    for (let c = start; c >= xa; c--) {
      if (!this.vEdge[y * w + c]) continue
      const run = this.vRun(c, y, ya, yb)
      if (!this.vRunOk(run, span)) continue
      if (this.vBendsOut(c, run[0], run[1], +1, ya, yb)) continue   // 框内在右边
      return [c + 1, run]
    }
    return [xa, [ya, yb]]
  }

  private seekRight(y: number, start: number, ya: number, yb: number, xb: number, span: Run | null): [number, Run] {
    const w = this.w
    for (let c = start; c < xb - 1; c++) {
      if (!this.vEdge[y * w + c]) continue
      const run = this.vRun(c, y, ya, yb)
      if (!this.vRunOk(run, span)) continue
      if (this.vBendsOut(c, run[0], run[1], -1, ya, yb)) continue   // 框内在左边
      return [c + 1, run]
    }
    return [xb, [ya, yb]]
  }

  /** 四个方向各收集前 CANDS 条候选(按绝对长度和拐角规则),返回 [边的位置, run] 列表,近的在前 */
  private listTop(x: number, start: number, xa: number, xb: number, ya: number): [number, Run][] {
    const w = this.w, out: [number, Run][] = []
    for (let r = start; r >= ya && out.length < CANDS; r--) {
      if (!this.hEdge[r * w + x]) continue
      const run = this.hRun(r, x, xa, xb)
      if (run[1] - run[0] < MIN_LEN || this.hBendsOut(r, run[0], run[1], +1, xa, xb)) continue
      out.push([r + 1, run])
    }
    return out
  }
  private listBottom(x: number, start: number, xa: number, xb: number, yb: number): [number, Run][] {
    const w = this.w, out: [number, Run][] = []
    for (let r = start; r < yb - 1 && out.length < CANDS; r++) {
      if (!this.hEdge[r * w + x]) continue
      const run = this.hRun(r, x, xa, xb)
      if (run[1] - run[0] < MIN_LEN || this.hBendsOut(r, run[0], run[1], -1, xa, xb)) continue
      out.push([r + 1, run])
    }
    return out
  }
  private listLeft(y: number, start: number, ya: number, yb: number, xa: number): [number, Run][] {
    const w = this.w, out: [number, Run][] = []
    for (let c = start; c >= xa && out.length < CANDS; c--) {
      if (!this.vEdge[y * w + c]) continue
      const run = this.vRun(c, y, ya, yb)
      if (run[1] - run[0] < MIN_LEN || this.vBendsOut(c, run[0], run[1], +1, ya, yb)) continue
      out.push([c + 1, run])
    }
    return out
  }
  private listRight(y: number, start: number, ya: number, yb: number, xb: number): [number, Run][] {
    const w = this.w, out: [number, Run][] = []
    for (let c = start; c < xb - 1 && out.length < CANDS; c++) {
      if (!this.vEdge[y * w + c]) continue
      const run = this.vRun(c, y, ya, yb)
      if (run[1] - run[0] < MIN_LEN || this.vBendsOut(c, run[0], run[1], -1, ya, yb)) continue
      out.push([c + 1, run])
    }
    return out
  }

  /**
   * 从两头的候选里挑一对:端点相互吻合(框的顶和底天然对齐;文字线和框线不会)且跨度最小的。
   * 挑不出就各取最近的一条,没有候选就用边界。
   */
  private pickPair(near: [number, Run][], far: [number, Run][], boundNear: number, boundFar: number, fullRun: Run): [[number, Run], [number, Run]] {
    let best: [[number, Run], [number, Run]] | null = null
    let bestSpan = Infinity
    for (const a of near) for (const b of far) {
      if (Math.abs(a[1][0] - b[1][0]) > 8 || Math.abs(a[1][1] - b[1][1]) > 8) continue
      const span = b[0] - a[0]
      if (span < bestSpan) { bestSpan = span; best = [a, b] }
    }
    if (best) return best
    return [near[0] ?? [boundNear, fullRun], far[0] ?? [boundFar, fullRun]]
  }

  /** 边线够不够格:知道对边范围就看覆盖率,否则看绝对长度 */
  private hRunOk(run: Run, span: Run | null): boolean {
    return span ? coverage(run, span[0], span[1]) >= needCover(span[1] - span[0]) : run[1] - run[0] >= MIN_LEN
  }
  private vRunOk(run: Run, span: Run | null): boolean {
    return span ? coverage(run, span[0], span[1]) >= needCover(span[1] - span[0]) : run[1] - run[0] >= MIN_LEN
  }

  /**
   * 在 bounds 里找包住 (x, y) 的最小框。inner 给了就找 inner 外面的下一层容器。
   * 找不到(或凑不出三条像样的边)返回 null。
   */
  findRect(x: number, y: number, bounds: PxRect, inner: PxRect | null = null): PxRect | null {
    if (!this.ready) return null
    const xa = Math.max(0, bounds.x0), ya = Math.max(0, bounds.y0)
    const xb = Math.min(this.w, bounds.x1), yb = Math.min(this.h, bounds.y1)
    if (x < xa || x >= xb || y < ya || y >= yb) return null
    // 围出来的框太小或边凑不齐(多半是鼠标正压在文字上,字形边缘围了个字大小的假框),
    // 不放弃:从这个假框外面接着往外找 —— 一行标题有七八个字,得走出去好几步
    let from = inner
    for (let attempt = 0; attempt < 12; attempt++) {
      const r = this.findRectOnce(x, y, xa, ya, xb, yb, from)
      if (r.ok) return r.rect
      if (r.rect.x0 <= xa && r.rect.y0 <= ya && r.rect.x1 >= xb && r.rect.y1 >= yb) return null
      from = r.rect
    }
    return null
  }

  private findRectOnce(x: number, y: number, xa: number, ya: number, xb: number, yb: number, inner: PxRect | null): { ok: boolean; rect: PxRect } {
    // 起点:从鼠标出发,或者从上一层框的外面一圈出发
    const sTop = inner ? inner.y0 - 2 : y - 1
    const sBot = inner ? inner.y1 + 1 : y
    const sLeft = inner ? inner.x0 - 2 : x - 1
    const sRight = inner ? inner.x1 + 1 : x

    // 四个方向各收集几条候选边线,上下、左右各配成端点吻合的一对(配不上就取最近的)
    const [[top0, topRun0], [bottom0, botRun0]] = this.pickPair(
      this.listTop(x, sTop, xa, xb, ya), this.listBottom(x, sBot, xa, xb, yb), ya, yb, [xa, xb])
    const [[left0, leftRun0], [right0, rightRun0]] = this.pickPair(
      this.listLeft(y, sLeft, ya, yb, xa), this.listRight(y, sRight, ya, yb, xb), xa, xb, [ya, yb])
    let top = top0, topRun = topRun0, bottom = bottom0, botRun = botRun0
    let left = left0, leftRun = leftRun0, right = right0, rightRun = rightRun0

    /*
      边线自己的延伸范围就是框的边界:一个搜索框,上下两条横线的左右端点是一致的,框的左右边就在那儿 ——
      它太矮,圆角一削竖边只剩十来个像素,单靠竖线根本找不到;反过来,活动栏那条竖分隔线从标题栏一直
      划到状态栏,它的上下端点就是这一栏的上下边。碰到边界(run 等于整个范围)的那条不提供信息。
    */
    const derivedLR = agree(topRun, botRun, [xa, xb])
    const derivedTB = agree(leftRun, rightRun, [ya, yb])
    let leftDerived = false, rightDerived = false, topDerived = false, bottomDerived = false
    if (derivedLR) {
      const [L, R] = derivedLR
      if (left > xa && (Math.abs(left - L) > 8 || coverage(leftRun, top, bottom) < needCover(bottom - top))) { left = L; leftDerived = true }
      if (left <= xa && L > xa + 8) { left = L; leftDerived = true }
      if (right < xb && (Math.abs(right - R) > 8 || coverage(rightRun, top, bottom) < needCover(bottom - top))) { right = R; rightDerived = true }
      if (right >= xb && R < xb - 8) { right = R; rightDerived = true }
    }
    if (derivedTB) {
      const [T, B] = derivedTB
      if (top > ya && (Math.abs(top - T) > 8 || coverage(topRun, left, right) < needCover(right - left))) { top = T; topDerived = true }
      if (top <= ya && T > ya + 8) { top = T; topDerived = true }
      if (bottom < yb && (Math.abs(bottom - B) > 8 || coverage(botRun, left, right) < needCover(right - left))) { bottom = B; bottomDerived = true }
      if (bottom >= yb && B < yb - 8) { bottom = B; bottomDerived = true }
    }

    // 没法推导的那几侧,不够覆盖就再往外找,最多来回几轮
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let changed = false
      if (!topDerived && top > ya && coverage(topRun, left, right) < needCover(right - left)) {
        ;[top, topRun] = this.seekTop(x, top - 2, xa, xb, ya, [left, right]); changed = true
      }
      if (!bottomDerived && bottom < yb && coverage(botRun, left, right) < needCover(right - left)) {
        ;[bottom, botRun] = this.seekBottom(x, bottom, xa, xb, yb, [left, right]); changed = true
      }
      if (!leftDerived && left > xa && coverage(leftRun, top, bottom) < needCover(bottom - top)) {
        ;[left, leftRun] = this.seekLeft(y, left - 2, ya, yb, xa, [top, bottom]); changed = true
      }
      if (!rightDerived && right < xb && coverage(rightRun, top, bottom) < needCover(bottom - top)) {
        ;[right, rightRun] = this.seekRight(y, right, ya, yb, xb, [top, bottom]); changed = true
      }
      if (!changed) break
    }

    const rect = { x0: left, y0: top, x1: right, y1: bottom }
    const rw = right - left, rh = bottom - top
    if (rw < MIN_W || rh < MIN_H) return { ok: false, rect }
    // 小框里面全是边(密度高)= 围住了一个字或一小块图形,不是控件;大框不查,文字占比小
    if (rw * rh < 6000 && this.interiorDensity(rect) > 0.18) return { ok: false, rect }

    const needW = needCover(rw), needH = needCover(rh)
    let sides = 0
    if (top <= ya || topDerived || coverage(topRun, left, right) >= needW) sides++
    if (bottom >= yb || bottomDerived || coverage(botRun, left, right) >= needW) sides++
    if (left <= xa || leftDerived || coverage(leftRun, top, bottom) >= needH) sides++
    if (right >= xb || rightDerived || coverage(rightRun, top, bottom) >= needH) sides++
    return { ok: sides >= MIN_SIDES, rect }
  }

  /** 框内部(去掉一圈边框)边缘像素占比 */
  private interiorDensity(r: PxRect): number {
    const x0 = r.x0 + 2, x1 = r.x1 - 2, y0 = r.y0 + 2, y1 = r.y1 - 2
    const area = (x1 - x0) * (y1 - y0)
    if (area <= 0) return 0
    let n = 0
    const w = this.w
    for (let y = y0; y < y1; y++) {
      const base = y * w
      for (let x = x0; x < x1; x++) { const i = base + x; if (this.vEdge[i] || this.hEdge[i]) n++ }
    }
    return n / area
  }

  /** 从里到外最多 max 层:元素 → 容器 → 更大的容器。只差一两个像素的(边框内外)当同一层 */
  findLevels(x: number, y: number, bounds: PxRect, max = 3): PxRect[] {
    const out: PxRect[] = []
    let inner: PxRect | null = null
    for (let guard = 0; guard < max * 3 && out.length < max; guard++) {
      const r = this.findRect(x, y, bounds, inner)
      if (!r) break
      if (inner && r.x0 >= inner.x0 && r.y0 >= inner.y0 && r.x1 <= inner.x1 && r.y1 <= inner.y1) break   // 没往外
      const last = out[out.length - 1]
      const nearly = last && Math.abs(r.x0 - last.x0) <= 3 && Math.abs(r.y0 - last.y0) <= 3
        && Math.abs(r.x1 - last.x1) <= 3 && Math.abs(r.y1 - last.y1) <= 3
      if (nearly) out[out.length - 1] = r   // 边框外沿代替内沿,继续往外
      else out.push(r)
      inner = r
      if (r.x0 <= bounds.x0 && r.y0 <= bounds.y0 && r.x1 >= bounds.x1 && r.y1 >= bounds.y1) break
    }
    return out
  }
}

/**
 * 这条边要盖住对边多少才算数。长边照 COVER;矮盒子(比如 30px 高的搜索框)圆角一削,
 * 竖直的直线段只剩一半,按 1 - 两个圆角/边长 放宽,但不低于 0.4。
 */
function needCover(len: number): number {
  return Math.min(COVER, Math.max(0.4, 1 - 16 / len))
}

/**
 * 两条平行边线的延伸范围是否一致(端点相差 ≤ 8px)。碰到边界的那条(等于 full)不提供信息:
 * 另一条说了算;两条都是边界就没结论。一致就返回公共范围。
 */
function agree(a: Run, b: Run, full: Run): Run | null {
  const aFull = a[0] <= full[0] && a[1] >= full[1]
  const bFull = b[0] <= full[0] && b[1] >= full[1]
  if (aFull && bFull) return null
  if (aFull) return b[1] - b[0] >= 2 * MIN_LEN ? b : null
  if (bFull) return a[1] - a[0] >= 2 * MIN_LEN ? a : null
  if (Math.abs(a[0] - b[0]) <= 8 && Math.abs(a[1] - b[1]) <= 8) {
    const r: Run = [Math.max(a[0], b[0]), Math.min(a[1], b[1])]
    return r[1] - r[0] >= MIN_LEN ? r : null
  }
  return null
}

/** 边线 run 和区间 [a,b) 的重叠 / 区间长度 */
function coverage(run: Run, a: number, b: number): number {
  const len = b - a
  if (len <= 0) return 0
  return Math.max(0, Math.min(run[1], b) - Math.max(run[0], a)) / len
}
