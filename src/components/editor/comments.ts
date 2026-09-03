/**
 * Obsidian 那种注释：`%%写给自己看的话%%`。
 *
 * # 为什么要有
 *
 * 编辑器的右键菜单里本来就有「注释」这一项（atomic-editor 自带的），点了会往
 * 正文里塞一对 `%%`。但**没人认识这对百分号** —— 屏幕上就是原样两个 `%%` 夹着
 * 一句话，看着像打错字。功能在、表现没有，比没有还糟。
 *
 * # 怎么表现
 *
 * 不像 Obsidian 那样在预览里整段藏掉 —— 这是个所见即所得的编辑器，
 * **藏掉就找不回来了**：你自己写的批注，翻半天不知道在哪一行。
 * 所以是压暗 + 斜体，一眼能认出「这段不是正文」，又始终看得见。
 * 那对 `%%` 本身在光标不在它身上时收起来，和加粗的 `**` 一个待遇。
 *
 * # 为什么用正则扫，不接解析器
 *
 * `%%` 不在 CommonMark 里，也不在我们用的那套扩展里 —— 要让解析器认得它，
 * 得写一个 lezer 的 inline parser。而它的语法简单到没有歧义（同一行、成对、
 * 中间非空），正则足够；代价只是要自己躲开代码块，那一步查一次语法树就够了。
 */
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'

/** 同一行之内、成对、中间不为空。跨行的不认 —— 那多半是两个不相干的百分号 */
const COMMENT = /%%(?!\s*%%)([^\n]+?)%%/g

const dim = Decoration.mark({ class: 'xg-comment' })
const hide = Decoration.replace({})

/** 代码块 / 行内代码里的 `%%` 不是注释，是代码 */
function inCode(view: EditorView, pos: number): boolean {
  let n = syntaxTree(view.state).resolveInner(pos, 1)
  while (n.parent) {
    if (/Code|Comment|FencedCode|InlineCode/.test(n.name)) return true
    n = n.parent
  }
  return false
}

function build(view: EditorView, clean: boolean): DecorationSet {
  const b = new RangeSetBuilder<Decoration>()
  const sel = view.state.selection.main
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.sliceDoc(from, to)
    COMMENT.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = COMMENT.exec(text))) {
      const a = from + m.index
      const z = a + m[0].length
      if (inCode(view, a + 2)) continue
      // 光标压在这段上就把标记露出来,方便改;否则收起来。clean 那一档点上也不露
      const touching = !clean && sel.from <= z && sel.to >= a
      if (!touching) b.add(a, a + 2, hide)
      b.add(a + 2, z - 2, dim)
      if (!touching) b.add(z - 2, z, hide)
    }
  }
  return b.finish()
}

export const markdownComments = (clean = false) => ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = build(view, clean) }
  update(u: ViewUpdate) {
    if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = build(u.view, clean)
  }
}, { decorations: (v) => v.decorations })

export const markdownCommentsTheme = EditorView.theme({
  '.xg-comment': {
    color: 'var(--muted-foreground)',
    fontStyle: 'italic',
    opacity: '0.75',
  },
})
