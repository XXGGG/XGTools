/**
 * 表格的「加一列 / 加一行」把手。
 *
 * # 为什么不复用库自带的右键菜单
 *
 * atomic-editor 的表格右键菜单里已经有插行插列了，但它靠的是两个没导出的
 * 内部函数（`readModelFromDom` / `dispatchModel`），外面调不到。
 * 与其去 hack 它的内部，不如直接改 markdown 源码 —— 表格在源码里就是几行
 * 竖线分隔的文本，加一列就是每行末尾多一段，加一行就是末尾多一行。
 * 这样也不怕它哪天重构内部实现。
 *
 * # 为什么用 grid 布局把手
 *
 * 需求是「和表格等高的竖条、和表格等宽的横条」。用绝对定位就得去量表格的
 * 实际宽高，而表格的宽度随时在变（打字就会撑开）。交给 grid：把手是网格里
 * 的另一格，默认拉伸，天然就和表格一样高/一样宽，一行 JS 都不用写。
 */
import { EditorView, ViewPlugin } from '@codemirror/view'
import type { ViewUpdate } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'

/** 找到这张表在 markdown 源码里的范围 */
function tableRange(view: EditorView, wrap: HTMLElement) {
  let pos: number
  try {
    pos = view.posAtDOM(wrap)
  } catch {
    return null
  }
  let node = syntaxTree(view.state).resolveInner(pos, 1)
  while (node.parent && node.name !== 'Table') node = node.parent
  if (node.name !== 'Table') return null
  return { from: node.from, to: node.to }
}

/**
 * 每行末尾接一段，就是多一列。
 *
 * 第 1 行是分隔行（`| --- | --- |`），它要补的是 `---` 而不是空格 ——
 * 补错了整张表会退化成普通段落。
 */
function withExtraColumn(src: string) {
  return src.split('\n').map((raw, i) => {
    const line = raw.trimEnd()
    // 有些人写表格不带行尾的竖线，先补齐再接，否则新列会和最后一格粘在一起
    const base = line.endsWith('|') ? line : `${line} |`
    return base + (i === 1 ? ' --- |' : '   |')
  }).join('\n')
}

/** 末尾接一行空格子。列数按分隔行数，那一行的格子数才是这张表的真实列数 */
function withExtraRow(src: string) {
  const lines = src.split('\n')
  const cols = Math.max(1, (lines[1] ?? '').split('|').filter((s) => s.trim()).length)
  return `${src.trimEnd()}\n|${'   |'.repeat(cols)}`
}

function makeHandle(kind: 'col' | 'row', onClick: () => void) {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = `xg-tbl-add xg-tbl-add-${kind}`
  el.setAttribute('contenteditable', 'false')
  el.title = kind === 'col' ? '加一列' : '加一行'
  el.textContent = '+'
  // mousedown 就拦掉:让焦点留在原地,不然点一下光标会先跳进表格里
  el.addEventListener('mousedown', (e) => e.preventDefault())
  el.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    onClick()
  })
  return el
}

export function tableAffordances() {
  return ViewPlugin.fromClass(class {
    view: EditorView

    frame = 0

    constructor(view: EditorView) {
      this.view = view
      /*
        必须等下一帧。

        插件的构造函数跑在 CM6 建 DOM **之前**,这时候 `.cm-atomic-table`
        一个都还不存在,当场去找只会一无所获 —— 表现就是刚打开一篇笔记时
        把手全不见,得先打个字才冒出来。
      */
      this.schedule()
    }

    update(u: ViewUpdate) {
      // 表格是块级 widget,文档一变它就可能整个重建 —— 每次都补一遍,
      // 有就跳过。比监听 DOM 变化省事,也不会漏。
      if (u.docChanged || u.viewportChanged) this.schedule()
    }

    destroy() {
      cancelAnimationFrame(this.frame)
    }

    schedule() {
      cancelAnimationFrame(this.frame)
      this.frame = requestAnimationFrame(() => this.sync())
    }

    sync() {
      for (const wrap of this.view.dom.querySelectorAll<HTMLElement>('.cm-atomic-table')) {
        if (wrap.querySelector('.xg-tbl-add')) continue
        wrap.appendChild(makeHandle('col', () => this.edit(wrap, withExtraColumn)))
        wrap.appendChild(makeHandle('row', () => this.edit(wrap, withExtraRow)))
      }
    }

    edit(wrap: HTMLElement, transform: (src: string) => string) {
      const range = tableRange(this.view, wrap)
      if (!range) return
      const src = this.view.state.doc.sliceString(range.from, range.to)
      const next = transform(src)
      if (next === src) return
      this.view.dispatch({ changes: { ...range, insert: next } })
    }
  })
}
