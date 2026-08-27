/**
 * LaTeX 公式和 mermaid 图的实时渲染。
 *
 * # 和其它装饰一样的老规矩
 *
 * 光标在那一块里就显示源码，移开才渲染 —— 不这样的话公式一写好就变成图，
 * 想改还得先想办法把光标挪回去。这是整个编辑器的一致行为，不单是这里。
 *
 * # 为什么 mermaid 要异步
 *
 * KaTeX 是同步的，一次调用就出 HTML；mermaid 的 `render` 返回 Promise，
 * 而 CM6 的装饰必须同步给出。所以 mermaid 先画一个占位块，渲染完再塞进去 ——
 * 结果缓存在 `svgCache` 里，同一段代码不会反复渲染（滚动来回时尤其明显）。
 *
 * # 出错不能吞
 *
 * 公式写错、图的语法错了，都要把错误显示在原地。渲染失败时静默留白的话，
 * 用户只会看到一片空白，完全不知道是哪儿写错了。
 */
import { EditorView, Decoration, WidgetType } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { RangeSetBuilder, StateField } from '@codemirror/state'
import type { EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import katex from 'katex'
import 'katex/dist/katex.min.css'

/** mermaid 的渲染结果。键是图的源码本身 —— 内容没变就不用重画 */
const svgCache = new Map<string, string>()
let mermaidReady: Promise<typeof import('mermaid').default> | null = null

/**
 * mermaid 有 500KB 上下，按需加载。
 *
 * 绝大多数笔记里一个流程图都没有，为它们在启动时多等半秒不值得。
 */
function loadMermaid(dark: boolean) {
  if (!mermaidReady) {
    mermaidReady = import('mermaid').then((m) => {
      m.default.initialize({
        startOnLoad: false,
        theme: dark ? 'dark' : 'default',
        securityLevel: 'strict',
      })
      return m.default
    })
  }
  return mermaidReady
}

/** 主题变了要让 mermaid 重新初始化，否则深色下还是白底图 */
export function resetMermaidTheme() {
  mermaidReady = null
  svgCache.clear()
}

class MathWidget extends WidgetType {
  constructor(readonly src: string, readonly display: boolean) {
    super()
  }

  eq(o: MathWidget) {
    return o.src === this.src && o.display === this.display
  }

  toDOM() {
    const el = document.createElement(this.display ? 'div' : 'span')
    el.className = this.display ? 'xg-math xg-math-block' : 'xg-math'
    try {
      katex.render(this.src, el, { displayMode: this.display, throwOnError: false })
    } catch (e) {
      // 出错就把错误摆在原地,别留一片空白让人猜
      el.className += ' xg-math-error'
      el.textContent = String(e)
    }
    return el
  }

  ignoreEvent() {
    return false
  }
}

class MermaidWidget extends WidgetType {
  constructor(readonly src: string, readonly dark: boolean) {
    super()
  }

  eq(o: MermaidWidget) {
    return o.src === this.src && o.dark === this.dark
  }

  toDOM() {
    const el = document.createElement('div')
    el.className = 'xg-mermaid'
    const cached = svgCache.get(this.src)
    if (cached) {
      el.innerHTML = cached
      return el
    }
    // 先占位,渲染完再填 —— CM6 的装饰必须同步返回,等不了 Promise
    el.textContent = '…'
    void loadMermaid(this.dark)
      .then((m) => m.render('xgm' + Math.abs(hash(this.src)), this.src))
      .then(({ svg }) => {
        svgCache.set(this.src, svg)
        el.innerHTML = svg
      })
      .catch((e) => {
        el.className += ' xg-mermaid-error'
        el.textContent = String(e?.message ?? e)
      })
    return el
  }

  ignoreEvent() {
    return false
  }
}

/** 给 mermaid 的 DOM id 用。它要求 id 唯一且是合法的 CSS 标识 */
function hash(s: string) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

/** 光标或选区落在这一段里 —— 那就显示源码，别渲染 */
function touching(state: EditorState, from: number, to: number) {
  return state.selection.ranges.some((r) => r.to >= from && r.from <= to)
}

/**
 * 扫一遍全文，把该渲染的地方收集起来。
 *
 * # 为什么是 StateField 而不是 ViewPlugin
 *
 * 公式块和流程图都是**块级**替换（整行换成一个图），而 CM6 明确规定
 * 块级装饰不能由 ViewPlugin 提供 —— 插件是在测量之后才跑的，那时候
 * 行高已经算完了，再插一个几百像素高的块进去布局就对不上。
 * 硬塞的结果不是报错那么客气：整份装饰集会被拒掉，编辑器直接一片空白。
 *
 * 换成 StateField 的代价是**扫全文而不是只扫可视区** —— 状态里拿不到
 * 视口。笔记这个量级（几十上百 KB）无所谓，真到几 MB 的文档再说。
 */
function build(state: EditorState, dark: boolean) {
  const found: Array<{ from: number, to: number, deco: Decoration }> = []
  const doc = state.doc

  // ```mermaid 代码块
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'FencedCode') return
      const text = doc.sliceString(node.from, node.to)
      const m = /^```\s*mermaid\s*\n([\s\S]*?)\n?```$/.exec(text)
      if (!m || !m[1].trim()) return
      if (touching(state, node.from, node.to)) return
      found.push({
        from: node.from,
        to: node.to,
        deco: Decoration.replace({ widget: new MermaidWidget(m[1], dark), block: true }),
      })
    },
  })

  /*
    公式用正则扫，不走语法树：`$...$` 在 CommonMark 里根本不是一种语法，
    lezer 不会给它节点。
  */
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i)
    // 整行就是一个 $$...$$：当成块级公式
    const block = /^\s*\$\$(.+)\$\$\s*$/.exec(line.text)
    if (block) {
      if (!touching(state, line.from, line.to)) {
        found.push({
          from: line.from,
          to: line.to,
          deco: Decoration.replace({ widget: new MathWidget(block[1], true), block: true }),
        })
      }
      continue
    }
    // 行内 $...$。要求两侧紧贴非空白，免得把「$5 和 $6」这种价格也当公式
    const re = /\$(?!\s)((?:[^$\n\\]|\\.)+?)(?<!\s)\$/g
    let mm: RegExpExecArray | null
    while ((mm = re.exec(line.text))) {
      const s = line.from + mm.index
      const e = s + mm[0].length
      if (touching(state, s, e)) continue
      found.push({
        from: s,
        to: e,
        deco: Decoration.replace({ widget: new MathWidget(mm[1], false) }),
      })
    }
  }

  /*
    收集完再排序统一 add:RangeSetBuilder 要求严格升序,而上面扫了两轮
    (先代码块、再逐行),第二轮的位置必然回到前面去。直接边扫边 add 会抛
    「Ranges must be added sorted」,CM6 捕获后把装饰整个丢掉 ——
    表现就是公式和图一个都不渲染,界面上还看不出任何异常。
  */
  found.sort((x, y) => x.from - y.from || x.to - y.to)
  const b = new RangeSetBuilder<Decoration>()
  let last = -1
  for (const f of found) {
    // 重叠的丢掉:一个位置只能被替换一次
    if (f.from < last) continue
    b.add(f.from, f.to, f.deco)
    last = f.to
  }
  return b.finish()
}

export function mathAndDiagrams(isDark: () => boolean) {
  const field = StateField.define<DecorationSet>({
    create: (state) => build(state, isDark()),
    update(value, tr) {
      // 光标挪进挪出也要重算 —— 「光标在里面就显示源码」全靠这个
      if (!tr.docChanged && !tr.selection) return value
      return build(tr.state, isDark())
    },
    provide: (f) => EditorView.decorations.from(f),
  })
  return [field]
}
