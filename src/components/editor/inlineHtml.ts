/**
 * 行内 HTML 的样式:让 `<span style="color:blue">蓝字</span>` 真的显示成蓝字。
 *
 * markdown 本来就允许夹行内 HTML,Obsidian、GitHub 都照着渲染 —— 上色、标记
 * 这类需求光靠 markdown 语法表达不了,大家都是写一段 span。我们这边解析器认得它
 * (lezer 给出 HTMLTag 节点),但没人把那段 style 用上,所以看到的还是尖括号原文。
 *
 * # 做法
 *
 * 扫 HTMLTag 节点:遇到开标签就把它的 style / color 记进栈,遇到对应的闭标签就出栈;
 * 中间那段正文按栈顶的样式画。标签本身(尖括号那几个字符)在光标不在这一行时收起来 ——
 * 和加粗的 `**` 一个待遇:平时看的是效果,把光标移过去才露出原文,方便改。
 *
 * # 只认安全的那几样
 *
 * style 里只取 color / background-color / font-weight / font-style /
 * text-decoration 这几条,别的一律忽略。笔记是自己写的没错,但同步过来的文件、
 * 从网上抄的片段都可能带着 position:fixed 或者一整屏的 background —— 那不该有能力
 * 把编辑器的版式掀翻。白名单之外的东西不解析,也就没有这种可能。
 */
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'

/** 允许从 style 里取的属性。见文件头「只认安全的那几样」 */
const ALLOWED = new Set([
  'color',
  'background-color',
  'background',
  'font-weight',
  'font-style',
  'text-decoration',
])

/*
  颜色名换成随主题走的那一套。

  `color:blue` 是给白纸定的,扔进暗色模式又暗又闷 —— 正文底色本来就深,深蓝写
  在上面基本看不清。所以颜色名不照抄,统一走 --xg-ink-* (定义在 style.css,
  亮暗各一套)。写十六进制、rgb() 的不动:那是作者自己挑的颜色,他知道自己要什么。
*/
const INK: Record<string, string> = {
  red: 'red', orange: 'orange', yellow: 'yellow', gold: 'yellow',
  green: 'green', lime: 'green', teal: 'cyan', cyan: 'cyan', aqua: 'cyan',
  blue: 'blue', navy: 'blue', royalblue: 'blue', dodgerblue: 'blue',
  purple: 'purple', violet: 'purple', magenta: 'pink', pink: 'pink',
  brown: 'brown', gray: 'gray', grey: 'gray',
}

function themedColor(value: string): string {
  const key = INK[value.trim().toLowerCase()]
  return key ? `var(--xg-ink-${key}, ${value})` : value
}

/** `style="color:blue; font-weight:bold"` → 只留白名单里的那几条 */
function safeStyle(style: string): string {
  const out: string[] = []
  for (const part of style.split(';')) {
    const i = part.indexOf(':')
    if (i < 0) continue
    const key = part.slice(0, i).trim().toLowerCase()
    const val = part.slice(i + 1).trim()
    if (!ALLOWED.has(key) || !val) continue
    // url()/expression() 之类一律不要 —— 白名单属性也能塞进这种东西
    if (/url\(|expression\(|javascript:/i.test(val)) continue
    // 只换文字颜色。底色用这套墨水色会太深 —— 那是给字用的,不是给底用的
    out.push(`${key}:${key === 'color' ? themedColor(val) : val}`)
  }
  return out.join(';')
}

/** 从一段开标签原文里抠出样式。认 style="…",也认老写法 color="red" */
function styleOfTag(tag: string): string | null {
  const style = /\sstyle\s*=\s*"([^"]*)"|\sstyle\s*=\s*'([^']*)'/i.exec(tag)
  const parts: string[] = []
  if (style) {
    const safe = safeStyle(style[1] ?? style[2] ?? '')
    if (safe) parts.push(safe)
  }
  const color = /\scolor\s*=\s*"([^"]*)"|\scolor\s*=\s*'([^']*)'/i.exec(tag)
  if (color) {
    const v = (color[1] ?? color[2] ?? '').trim()
    if (v && !/url\(|expression\(|javascript:/i.test(v)) parts.push(`color:${themedColor(v)}`)
  }
  return parts.length ? parts.join(';') : null
}

const tagName = (tag: string) => /^<\/?\s*([a-zA-Z][\w-]*)/.exec(tag)?.[1]?.toLowerCase() ?? ''
const isClosing = (tag: string) => /^<\s*\//.test(tag)
/** 自闭合(`<br/>`)不进栈 —— 它没有「里面的内容」 */
const isSelfClosing = (tag: string) => /\/\s*>$/.test(tag)

/** 光标(或选区)碰着这一段吗。碰着就把原文露出来给人改 */
function touched(view: EditorView, from: number, to: number): boolean {
  return view.state.selection.ranges.some((r) => r.from <= to && r.to >= from)
}

export const inlineHtmlStyles = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = this.build(view)
    }

    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = this.build(u.view)
    }

    build(view: EditorView): DecorationSet {
      // 先收集,最后统一按位置排序再交给 builder —— 它要求升序,
      // 而「标签隐藏」和「正文上色」是两轮扫出来的,天然不有序
      const marks: { from: number; to: number; deco: Decoration }[] = []
      const tree = syntaxTree(view.state)

      for (const { from, to } of view.visibleRanges) {
        // 栈里放「还没闭合的开标签」:名字、样式、正文从哪儿开始
        const stack: { name: string; style: string; contentFrom: number; tagFrom: number; tagTo: number }[] = []

        tree.iterate({
          from,
          to,
          enter: (node) => {
            if (node.name !== 'HTMLTag') return
            const raw = view.state.doc.sliceString(node.from, node.to)
            const name = tagName(raw)
            if (!name) return

            if (isClosing(raw)) {
              // 找到栈里最近的同名开标签,中间那段就是它管的正文
              for (let i = stack.length - 1; i >= 0; i--) {
                if (stack[i].name !== name) continue
                const open = stack[i]
                stack.length = i
                if (open.contentFrom < node.from) {
                  marks.push({
                    from: open.contentFrom,
                    to: node.from,
                    deco: Decoration.mark({ attributes: { style: open.style } }),
                  })
                }
                // 一对标签都不在光标底下时,把尖括号收起来,只留效果
                if (!touched(view, open.tagFrom, node.to)) {
                  marks.push({ from: open.tagFrom, to: open.tagTo, deco: Decoration.replace({}) })
                  marks.push({ from: node.from, to: node.to, deco: Decoration.replace({}) })
                }
                break
              }
              return
            }

            if (isSelfClosing(raw)) return
            const style = styleOfTag(raw)
            if (!style) return      // 没有能用的样式就当普通文本,别去动它
            stack.push({ name, style, contentFrom: node.to, tagFrom: node.from, tagTo: node.to })
          },
        })
      }

      // builder 认的是 (from, startSide) 这个顺序,光按位置排不够:
      // 嵌套的 span 会出现「外层正文」和「内层开标签」同一个起点
      marks.sort((a, b) => a.from - b.from || a.deco.startSide - b.deco.startSide || a.to - b.to)
      const b = new RangeSetBuilder<Decoration>()
      for (const m of marks) b.add(m.from, m.to, m.deco)
      return b.finish()
    }
  },
  { decorations: (v) => v.decorations },
)
