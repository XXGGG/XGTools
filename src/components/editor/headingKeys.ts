/**
 * 标题正文开头的回车和退格。
 *
 * 行首那截 `## ` 平时是藏起来的（精简模式），而且被标成一个整体，光标不许停在它中间
 * （见 hideMarks.ts 的 markerAtomicRanges）。于是光标放到标题开头 —— 看起来在最左边，
 * 文档里其实在**藏起来的 `## ` 后面**。默认的回车、退格都不知道这件事，于是：
 *
 *  - 回车：从 `##` 和字中间切一刀，上面剩个光秃秃的 `##`，字掉到下一行成了普通正文
 *  - 退格：删掉的是 `##` 和字中间那个空格，变成 `##【游戏开发】`，标题当场失效
 *
 * 用的人只是想「在上面空一行」「把上面那行空行删掉」，看不见的记号咬了他一口。
 *
 * # 两个键是对称的
 *
 * - **回车**：在这一行上面加一行空行，标题原样往下挪，光标跟着标题
 * - **退格**：上面是空行 —— 删掉那行空行，标题原样往上挪；
 *   上面有字、或者已经是第一行 —— 去掉标题格式，变回普通正文（Notion、Typora 都是这样）。
 *   再按一次退格才会和上一行接起来
 *
 * # 只管「光标正好在标题正文开头」
 *
 * 光标在标题中间、只有 `## ` 没有字的空标题、代码块里长得像标题的行，都不接管，
 * 走默认的回车 / 退格。
 */
import { syntaxTree } from '@codemirror/language'
import type { EditorState, TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

const HEAD = /^#{1,6}[ \t]+/

function isHeadingLine(state: EditorState, lineFrom: number): boolean {
  // 从行首第一个井号往上找：是 ATXHeading 才算，代码块里的 `## ` 不是
  for (let n: { name: string; parent: unknown } | null = syntaxTree(state).resolveInner(lineFrom + 1, -1);
    n; n = n.parent as typeof n) {
    if (/^ATXHeading[1-6]$/.test(n.name)) return true
  }
  return false
}

/** 光标是不是正好停在一个非空标题的正文开头。是就返回这一行和前缀长度 */
function atHeadingStart(state: EditorState) {
  if (state.selection.ranges.length !== 1) return null
  const r = state.selection.main
  if (!r.empty) return null
  const line = state.doc.lineAt(r.head)
  const m = HEAD.exec(line.text)
  if (!m) return null
  if (r.head !== line.from + m[0].length) return null
  if (line.text.length === m[0].length) return null
  if (!isHeadingLine(state, line.from)) return null
  return { line, pre: m[0].length, head: r.head }
}

export function headingEnterSpec(state: EditorState): TransactionSpec | null {
  const at = atHeadingStart(state)
  if (!at) return null
  const br = state.lineBreak
  return {
    changes: { from: at.line.from, insert: br },
    selection: { anchor: at.head + br.length },
    scrollIntoView: true,
    userEvent: 'input',
  }
}

export function headingBackspaceSpec(state: EditorState): TransactionSpec | null {
  const at = atHeadingStart(state)
  if (!at) return null
  const { line } = at
  if (line.number > 1) {
    const prev = state.doc.line(line.number - 1)
    if (!/\S/.test(prev.text)) {
      // 上面是空行：删掉它，标题整行往上挪，光标还在标题正文开头
      const gone = line.from - prev.from
      return {
        changes: { from: prev.from, to: line.from },
        selection: { anchor: at.head - gone },
        scrollIntoView: true,
        userEvent: 'delete.backward',
      }
    }
  }
  // 上面有字、或者就是第一行：去掉 `## `，变回普通正文
  return {
    changes: { from: line.from, to: line.from + at.pre },
    selection: { anchor: line.from },
    scrollIntoView: true,
    userEvent: 'delete.backward',
  }
}

const run = (spec: (s: EditorState) => TransactionSpec | null) => (view: EditorView): boolean => {
  const tr = spec(view.state)
  if (!tr) return false
  view.dispatch(tr)
  return true
}

export const headingEnter = run(headingEnterSpec)
export const headingBackspace = run(headingBackspaceSpec)
