/**
 * 代码块右上角的「复制」按钮。
 *
 * 写了语言的(```vue)按钮上就写语言名 ——「Vue」既是标签也是按钮,点它就复制;
 * 没写语言的写「复制」。两者是同一个东西,不另做一个标签块占地方。
 *
 * # 按钮必须待在正文 DOM 的**外面**
 *
 * 这一点是踩过坑才写下的:一开始是把按钮直接 appendChild 进
 * `.cm-atomic-fenced-code` 里的,看着没问题,实际是在往文档里灌垃圾 ——
 * CM 认的「文档内容」就是 contentDOM 里的文字,它读 DOM 时会递归进每一个
 * 它不认识的元素,把里面的文本当成正文读回去。于是按钮上那两个字被当成用户
 * 打进去的内容写进了笔记,每刷新一次多一遍,几分钟就把一篇笔记撑到几十万字符。
 * (表格那两个把手没事,是因为它们挂在**部件**里,部件对 CM 是一个整体,
 * 它不会往里看。)
 *
 * 所以这里改成一层浮标:按钮挂在 scrollDOM 上、绝对定位盖在代码块右上角,
 * 和正文 DOM 井水不犯河水。位置跟着代码块的实际位置算,滚动时不用重算 ——
 * 它和内容一起滚。
 *
 * # 复制的是源码,不是渲染结果
 *
 * 按钮读的是文档里这一段 fenced code 的正文(去掉首尾那两行 ```),
 * 而不是 DOM 里的 textContent —— 后者会把语法高亮拆出来的那些 span 之间的
 * 空白也算进去,粘出来的代码缩进是错的。
 */
import { EditorView, ViewPlugin } from '@codemirror/view'
import type { ViewUpdate } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'

const LAYER = 'xg-code-layer'
const BTN = 'xg-code-copy'

/**
 * 取围栏里的正文和语言名。
 *
 * 源码长这样:
 *     ```vue
 *     <template>…
 *     ```
 * 首行是 ``` 加可选的语言,末行是 ```(最后一块没写收尾时可能没有)。
 */
function fenceParts(text: string): { lang: string; body: string } {
  const lines = text.split('\n')
  const first = lines[0] ?? ''
  const lang = first.replace(/^\s*[`~]{3,}\s*/, '').trim().split(/\s+/)[0] ?? ''
  let end = lines.length
  if (end > 1 && /^\s*[`~]{3,}\s*$/.test(lines[end - 1])) end -= 1
  return { lang, body: lines.slice(1, end).join('\n') }
}

/**
 * 语言名写成人看着顺眼的样子。
 *
 * 缩写全大写(JS / CSS / SQL),正经名字首字母大写(Vue / Python)。这事没法
 * 靠长度猜 —— vue 和 css 都是三个字母,一个该写 Vue 一个该写 CSS,所以缩写
 * 单列一张表,表外的一律首字母大写。
 */
const ACRONYMS = new Set([
  'js', 'ts', 'jsx', 'tsx', 'css', 'scss', 'html', 'xml', 'json', 'yaml', 'yml',
  'sql', 'php', 'css3', 'api', 'csv', 'ini', 'toml', 'md', 'c', 'cpp', 'ps1',
])

function prettyLang(lang: string): string {
  if (!lang) return ''
  const low = lang.toLowerCase()
  return ACRONYMS.has(low) ? low.toUpperCase() : low[0].toUpperCase() + low.slice(1)
}

/** 视口里所有的 fenced code 段。按文档范围来,一段就是一段,不管它画成了几块 DOM */
function visibleFences(view: EditorView): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  const tree = syntaxTree(view.state)
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== 'FencedCode') return
        if (!out.some((f) => f.from === node.from)) out.push({ from: node.from, to: node.to })
      },
    })
  }
  return out
}

export function codeAffordances(labels: { copy: string; copied: string }) {
  return ViewPlugin.fromClass(
    class {
      layer: HTMLElement
      frame = 0

      constructor(readonly view: EditorView) {
        this.layer = document.createElement('div')
        this.layer.className = LAYER
        view.scrollDOM.appendChild(this.layer)
        this.schedule()
      }

      update(u: ViewUpdate) {
        // 内容、视口、尺寸任一变了都要重新对位
        if (u.docChanged || u.viewportChanged || u.geometryChanged) this.schedule()
      }

      destroy() {
        cancelAnimationFrame(this.frame)
        this.layer.remove()
      }

      /** 等这一帧的 DOM 落定再量位置 —— 装饰是在同一轮里画的,现在量会量到旧的 */
      schedule() {
        cancelAnimationFrame(this.frame)
        this.frame = requestAnimationFrame(() => this.place())
      }

      place() {
        /*
          一段代码在 DOM 里可能被拆成好几块(每行一块),按 DOM 元素发按钮的话
          一段代码会长出一排按钮,而且每块的 rect 只有那一行那么高 ——
          按钮就吊在半空中间。所以按**文档里的段**来发:先问语法树有几段,
          再把每段对应的那些 DOM 块的矩形并起来,按钮放这个大矩形的右上角。
        */
        const fences = visibleFences(this.view)
        const wraps = Array.from(
          this.view.contentDOM.querySelectorAll<HTMLElement>('.cm-atomic-fenced-code'),
        )

        type Slot = { from: number; to: number; rect: DOMRect | null; wraps: HTMLElement[] }
        const slots: Slot[] = fences.map((f) => ({ ...f, rect: null, wraps: [] }))

        for (const wrap of wraps) {
          let pos = -1
          try {
            pos = this.view.posAtDOM(wrap)
          } catch {
            continue
          }
          const slot = slots.find((f) => pos >= f.from && pos <= f.to)
          if (!slot) continue
          slot.wraps.push(wrap)
          const r = wrap.getBoundingClientRect()
          if (!slot.rect) slot.rect = r
          else {
            const u = slot.rect
            slot.rect = new DOMRect(
              Math.min(u.left, r.left),
              Math.min(u.top, r.top),
              Math.max(u.right, r.right) - Math.min(u.left, r.left),
              Math.max(u.bottom, r.bottom) - Math.min(u.top, r.top),
            )
          }
        }

        const live = slots.filter((f) => f.rect)
        // 按钮按需增减:代码块数量变了不要留下孤儿
        while (this.layer.childElementCount > live.length) this.layer.lastElementChild!.remove()
        while (this.layer.childElementCount < live.length) this.layer.appendChild(this.makeButton())

        const box = this.view.scrollDOM.getBoundingClientRect()
        const { scrollTop, scrollLeft } = this.view.scrollDOM

        live.forEach((slot, i) => {
          const btn = this.layer.children[i] as HTMLElement
          const r = slot.rect!
          btn.style.top = `${r.top - box.top + scrollTop + 6}px`
          btn.style.left = `${r.right - box.left + scrollLeft - 8}px`
          // 定位点在右上角,自己往左退一个身位,免得量按钮宽度
          btn.style.transform = 'translateX(-100%)'

          const lang = prettyLang(fenceParts(this.view.state.doc.sliceString(slot.from, slot.to)).lang)
          btn.textContent = lang || labels.copy
          btn.title = lang ? labels.copy : ''
          // 这颗按钮当前对着哪一段,点的时候才知道要复制谁
          btn.dataset.from = String(slot.from)
          btn.dataset.to = String(slot.to)

          /*
            鼠标进了这段代码才显出来。按钮不在正文里,:hover 选不到隔壁,
            所以这里自己盯着 —— 一段代码的每一块都要盯,不然移到第二行就没了。
          */
          for (const wrap of slot.wraps) {
            wrap.onmouseenter = () => btn.classList.add('is-near')
            wrap.onmouseleave = () => btn.classList.remove('is-near')
          }
        })
      }

      makeButton() {
        const btn = document.createElement('button')
        btn.className = BTN
        btn.type = 'button'
        btn.addEventListener('mouseenter', () => btn.classList.add('is-near'))
        btn.addEventListener('mouseleave', () => btn.classList.remove('is-near'))
        btn.addEventListener('mousedown', (e) => {
          // 别让点击落进编辑器 —— 否则光标会跳进代码块,还会带出一次选区
          e.preventDefault()
          e.stopPropagation()
        })
        btn.addEventListener('click', async (e) => {
          e.preventDefault()
          e.stopPropagation()
          const from = Number(btn.dataset.from)
          const to = Number(btn.dataset.to)
          if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return
          const { body } = fenceParts(this.view.state.doc.sliceString(from, to))
          try {
            await navigator.clipboard.writeText(body)
          } catch {
            return // 剪贴板被拒(没焦点之类),别把按钮改成「已复制」骗人
          }
          const before = btn.textContent
          btn.textContent = labels.copied
          btn.classList.add('is-done')
          setTimeout(() => {
            btn.textContent = before
            btn.classList.remove('is-done')
          }, 1400)
        })
        return btn
      }
    },
  )
}

/** 按钮的样子。放在这儿而不是全局样式表:它只服务这一个部件 */
export const codeAffordanceTheme = EditorView.theme({
  [`.${LAYER}`]: {
    position: 'absolute',
    top: '0',
    left: '0',
    width: '0',
    height: '0',
    // 这一层只是坐标系,别挡住底下的正文
    pointerEvents: 'none',
  },
  [`.${BTN}`]: {
    position: 'absolute',
    zIndex: '2',
    height: '28px',
    padding: '0 12px',
    fontSize: '12px',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    lineHeight: '26px',
    /*
      **不换行**。这颗按钮浮在一个宽度为 0 的定位层里,浏览器算它的宽度时
      「可用宽度」就是 0,于是缩到最小内容宽 —— 中文每个字之间都能断,
      最小内容宽就是一个字,「已复制」三个字直接挤出按钮外面。
    */
    whiteSpace: 'nowrap',
    color: 'var(--muted-foreground)',
    background: 'color-mix(in srgb, var(--background) 70%, transparent)',
    border: '1px solid color-mix(in srgb, var(--border) 70%, transparent)',
    borderRadius: '7px',
    cursor: 'pointer',
    pointerEvents: 'auto',
    // 平时淡下去,鼠标进了这块代码才显出来 —— 它是随手可用的东西,不是装饰
    opacity: '0',
    transition: 'opacity 150ms, background 150ms, color 150ms',
  },
  [`.${BTN}.is-near`]: { opacity: '1' },
  [`.${BTN}:hover`]: {
    color: 'var(--foreground)',
    background: 'var(--background)',
  },
  [`.${BTN}.is-done`]: {
    opacity: '1',
    color: 'var(--atomic-editor-accent, var(--foreground))',
    borderColor: 'color-mix(in srgb, var(--atomic-editor-accent, var(--foreground)) 45%, transparent)',
  },
})
