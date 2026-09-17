/**
 * 表格列宽：拖两列之间的竖线调宽度，双击那根线恢复自动。
 *
 * # 平时（没拖过）
 *
 * 表格最宽不超过正文，长内容在格子里折行（样式在 MarkdownEditor.vue）。
 * 以前表格是「内容多宽就多宽」，一句长说明就把整张表撑出屏幕，只能横着拖着看。
 *
 * # 拖过之后
 *
 * 改成固定布局：每一列就是拖出来的宽度，字在格子里折行。
 *
 * 拖法照 Word：**中间的竖线**是在左右两列之间挪宽度，整张表总宽不变 ——
 * 想让「名字」那列宽一点，旁边那列长说明就多折一行，表格还在正文里；
 * **最右边那根线**才改整张表的宽度，拖得比正文还宽就横向滚动（滚动条见 tableScrollbar.ts）。
 *
 * # 列宽存在哪
 *
 * **不写进笔记。** markdown 表格本来就没有「列宽」这回事；atomic-editor 每改一个格子
 * 都会把整张表重写一遍（分隔行一律写成 `---`），想借横杠长度记宽度也会被冲掉。
 * 所以存在应用自己的设置里（由调用方给一个 store），每张表的名字是
 * 「列数 + 表头 + 这是第几张同样表头的表」—— 一篇里几张表表头一模一样很常见
 * （每章一张「成就 | 怎么拿」），光认表头的话它们会共用一套宽度，调一张全跟着变。
 *
 * 表头文字一改、或者加了一列，名字就对不上了。这里记着每张表上一次在文档里的
 * 位置（随编辑一起平移），同一个位置上的表换了名字，就把宽度搬到新名字下 ——
 * 改个表头、加一列，拖好的宽度不会丢。
 */
import { EditorView, ViewPlugin } from '@codemirror/view'
import type { ViewUpdate } from '@codemirror/view'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'

export type TableWidthStore = {
  get(sig: string): number[] | undefined
  set(sig: string, widths: number[] | null): void
}

/** 离竖线多近算「在线上」 */
const EDGE = 4
/** 一列最窄（像素） */
const MIN_COL = 48
/** 新加出来的列给多宽 */
const NEW_COL = 120

function headerCells(table: HTMLTableElement): HTMLElement[] {
  return Array.from(table.querySelectorAll<HTMLElement>(':scope > thead > tr > th'))
}

/** 拼表头用的分隔符：表头里不会出现的字符（用 fromCharCode 写，免得源码里夹一个看不见的控制字符） */
const SEP = String.fromCharCode(1)

/** 表头那一行 → 各格原文（去掉首尾竖线，按没被转义的竖线切开） */
function headerOf(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/).map((c) => c.trim())
}

/**
 * 文档里每张表（按起点）的名字：列数 + 表头 + 这是第几张同样表头的表（从 0 数）。
 * 从原文算，不从画出来的 DOM 算 —— 屏幕外的表没有 DOM，数不到「第几张」。
 */
export function tableNames(state: EditorState, upto: number): Map<number, string> {
  const tree = ensureSyntaxTree(state, upto, 50) ?? syntaxTree(state)
  const seen = new Map<string, number>()
  const out = new Map<number, string>()
  tree.iterate({
    to: upto,
    enter: (n) => {
      if (n.name !== 'Table') return
      const cells = headerOf(state.doc.lineAt(n.from).text)
      const base = cells.length + ':' + cells.join(SEP)
      const k = seen.get(base) ?? 0
      seen.set(base, k + 1)
      out.set(n.from, `${base}#${k}`)
      return false
    },
  })
  return out
}

/** 这个表格部件对应的表在文档里从哪开始；找不到返回 -1 */
function tableStart(view: EditorView, wrap: HTMLElement): number {
  let pos: number
  try {
    pos = view.posAtDOM(wrap)
  } catch {
    return -1
  }
  let node = syntaxTree(view.state).resolveInner(pos, 1)
  while (node.parent && node.name !== 'Table') node = node.parent
  return node.name === 'Table' ? node.from : -1
}

/** 列数变了：多出来的列给默认宽度，少了就截掉 */
function fit(widths: number[], n: number): number[] {
  const out = widths.slice(0, n)
  while (out.length < n) out.push(NEW_COL)
  return out
}

/** 把一组列宽套到表上；传 null 就回到自动布局 */
function apply(table: HTMLTableElement, widths: number[] | null) {
  let cg = table.querySelector<HTMLTableColElement>(':scope > colgroup.xg-cols')
  if (!widths) {
    cg?.remove()
    table.classList.remove('xg-tbl-fixed')
    table.style.width = ''
    return
  }
  if (!cg) {
    cg = document.createElement('colgroup')
    cg.className = 'xg-cols'
    table.insertBefore(cg, table.firstChild)
  }
  while (cg.children.length > widths.length) cg.lastElementChild!.remove()
  while (cg.children.length < widths.length) cg.appendChild(document.createElement('col'))
  widths.forEach((w, i) => { (cg!.children[i] as HTMLElement).style.width = `${w}px` })
  table.classList.add('xg-tbl-fixed')
  table.style.width = `${widths.reduce((a, b) => a + b, 0)}px`
}

type Opts = {
  /** 每次都现取：换了一篇笔记，store 也跟着换 */
  store: () => TableWidthStore | undefined
  /** 鼠标停在竖线上时的提示 */
  hint: string
}

type Drag = {
  wrap: HTMLElement
  table: HTMLTableElement
  col: number
  startX: number
  /** 按下那一刻每列的宽度 */
  start: number[]
  widths: number[]
  sig: string
}

/** 拖动时的新列宽：中间的线两列互相让，最右边的线只动最后一列 */
function dragged(start: number[], col: number, dx: number): number[] {
  const w = start.slice()
  if (col < w.length - 1) {
    // 两边都不许窄过下限；本来就比下限窄的，不往更窄里推，也不突然跳宽
    const lo = Math.min(0, MIN_COL - w[col])
    const hi = Math.max(0, w[col + 1] - MIN_COL)
    const k = Math.round(Math.min(hi, Math.max(lo, dx)))
    w[col] += k
    w[col + 1] -= k
  } else {
    w[col] = Math.max(MIN_COL, Math.round(w[col] + dx))
  }
  return w
}

export function tableColumns(opts: Opts) {
  return ViewPlugin.fromClass(class {
    view: EditorView
    frame = 0
    drag: Drag | null = null
    /** 文档位置 → 那张表上一次的名字和宽度，用来在表头变了时把宽度搬过去 */
    last = new Map<number, { sig: string; widths: number[] | null }>()

    constructor(view: EditorView) {
      this.view = view
      // 和加列把手一样：构造时表格 DOM 还没建出来，等下一帧再找
      this.schedule()
    }

    update(u: ViewUpdate) {
      if (u.docChanged) {
        const moved = new Map<number, { sig: string; widths: number[] | null }>()
        for (const [pos, v] of this.last) moved.set(u.changes.mapPos(pos, 1), v)
        this.last = moved
      }
      if (u.docChanged || u.viewportChanged || u.geometryChanged) this.schedule()
    }

    destroy() {
      cancelAnimationFrame(this.frame)
    }

    schedule() {
      cancelAnimationFrame(this.frame)
      this.frame = requestAnimationFrame(() => this.sync())
    }

    /** 某个表格部件的名字（见 tableNames） */
    nameOf(wrap: HTMLElement): string | null {
      const start = tableStart(this.view, wrap)
      return start < 0 ? null : tableNames(this.view.state, start + 1).get(start) ?? null
    }

    sync() {
      const store = opts.store()
      const wraps = Array.from(this.view.dom.querySelectorAll<HTMLElement>('.cm-atomic-table'))
      if (!wraps.length) return
      const starts = wraps.map((w) => tableStart(this.view, w))
      const names = tableNames(this.view.state, Math.max(...starts) + 1)
      let changed = false
      for (let i = 0; i < wraps.length; i++) {
        const wrap = wraps[i]
        const pos = starts[i]
        const sig = names.get(pos)
        const table = wrap.querySelector<HTMLTableElement>(':scope > table')
        if (!table || !sig) continue
        this.bind(wrap)
        if (this.drag?.table === table) continue
        const cols = headerCells(table).length

        let widths = store?.get(sig) ?? null
        if (!widths && store && sig.endsWith('#0')) {
          // 老版本只按表头存（没有「第几张」）：那份宽度归给第一张
          const legacy = sig.slice(0, -2)
          const old = store.get(legacy)
          if (old) {
            widths = old
            store.set(sig, old)
            store.set(legacy, null)
          }
        }
        const prev = this.last.get(pos)
        if (!widths && prev?.widths && prev.sig !== sig && store) {
          // 同一个位置上的表换了表头 / 列数：宽度跟着搬过来
          widths = fit(prev.widths, cols)
          store.set(sig, widths)
          store.set(prev.sig, null)
        } else if (widths && widths.length !== cols && store) {
          widths = fit(widths, cols)
          store.set(sig, widths)
        }
        const had = table.classList.contains('xg-tbl-fixed')
        apply(table, widths)
        if (had !== !!widths) changed = true
        this.last.set(pos, { sig, widths })
      }
      // 表格高度跟着折行变了，让编辑器重新量一次，不然光标和滚动会对不上
      if (changed) this.view.requestMeasure()
    }

    /** 光标下是哪一根竖线（第几列的右边线），不在线上返回 -1 */
    edgeAt(table: HTMLTableElement, x: number, y: number): number {
      const box = table.getBoundingClientRect()
      if (y < box.top || y > box.bottom) return -1
      const cells = headerCells(table)
      for (let i = 0; i < cells.length; i++) {
        if (Math.abs(cells[i].getBoundingClientRect().right - x) <= EDGE) return i
      }
      return -1
    }

    guide(wrap: HTMLElement, table: HTMLTableElement, col: number | null) {
      let g = wrap.querySelector<HTMLElement>(':scope > .xg-col-guide')
      if (col == null) {
        g?.remove()
        return
      }
      if (!g) {
        g = document.createElement('div')
        g.className = 'xg-col-guide'
        wrap.appendChild(g)
      }
      const wb = wrap.getBoundingClientRect()
      const tb = table.getBoundingClientRect()
      const right = headerCells(table)[col].getBoundingClientRect().right
      g.style.left = `${right - wb.left + wrap.scrollLeft}px`
      g.style.top = `${tb.top - wb.top + wrap.scrollTop}px`
      g.style.height = `${tb.height}px`
    }

    bind(wrap: HTMLElement) {
      if (wrap.dataset.xgCols) return
      wrap.dataset.xgCols = '1'
      const tableOf = () => wrap.querySelector<HTMLTableElement>(':scope > table')

      const hover = (on: boolean) => {
        wrap.classList.toggle('xg-col-resize', on)
        if (on) wrap.title = opts.hint
        else if (wrap.title === opts.hint) wrap.removeAttribute('title')
      }

      wrap.addEventListener('pointermove', (e) => {
        const table = tableOf()
        if (!table) return
        const d = this.drag
        if (d && d.wrap === wrap) {
          d.widths = dragged(d.start, d.col, e.clientX - d.startX)
          apply(table, d.widths)
          this.guide(wrap, table, d.col)
          return
        }
        const col = this.edgeAt(table, e.clientX, e.clientY)
        hover(col >= 0)
        this.guide(wrap, table, col >= 0 ? col : null)
      })

      wrap.addEventListener('pointerleave', () => {
        if (this.drag?.wrap === wrap) return
        hover(false)
        const table = tableOf()
        if (table) this.guide(wrap, table, null)
      })

      // 捕获阶段先截住：落在竖线上就是拖列宽，不能让单元格拿到焦点、放下光标
      wrap.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return
        const table = tableOf()
        if (!table) return
        const col = this.edgeAt(table, e.clientX, e.clientY)
        if (col < 0) return
        const sig = this.nameOf(wrap)
        if (!sig) return
        e.preventDefault()
        e.stopPropagation()
        // 从眼下画出来的宽度起步：没拖过的表先按现状把每一列定住
        const widths = headerCells(table).map((c) => Math.round(c.getBoundingClientRect().width))
        apply(table, widths)
        this.drag = { wrap, table, col, startX: e.clientX, start: widths, widths: widths.slice(), sig }
        wrap.setPointerCapture(e.pointerId)
        hover(true)
      }, true)

      const end = (e: PointerEvent) => {
        const d = this.drag
        if (!d || d.wrap !== wrap) return
        this.drag = null
        if (wrap.hasPointerCapture(e.pointerId)) wrap.releasePointerCapture(e.pointerId)
        opts.store()?.set(d.sig, d.widths)
        hover(false)
        this.guide(wrap, d.table, null)
        this.view.requestMeasure()
        this.schedule()
      }
      wrap.addEventListener('pointerup', end)
      wrap.addEventListener('pointercancel', end)

      // 双击竖线：这张表回到自动宽度
      wrap.addEventListener('dblclick', (e) => {
        const table = tableOf()
        if (!table || this.edgeAt(table, e.clientX, e.clientY) < 0) return
        e.preventDefault()
        e.stopPropagation()
        const sig = this.nameOf(wrap)
        if (sig) opts.store()?.set(sig, null)
        apply(table, null)
        this.guide(wrap, table, null)
        this.view.requestMeasure()
      }, true)
    }
  })
}
