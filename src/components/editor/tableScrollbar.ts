/**
 * 宽表格的横向滚动条：悬浮、跟着表格走、到底就贴底。
 *
 * # 为什么原生的不行
 *
 * 全局把滚动条藏了（style.css），宽表格自己那条横向滚动条也一起没了 ——
 * 于是表格一宽就只能靠触控板横着划。就算放出来，它也长在表格**最底下**：
 * 一张几百行的表，想看顶上的数据往右几列，得先滚到表格底部拖一下、再滚回顶上，
 * 来回一趟。
 *
 * # 规矩就一条
 *
 * 滚动条永远贴在「表格底边」和「正文可视区底边」两者里**更靠上**的那一条上：
 *
 *  · 表格整个在屏幕里 —— 贴在表格底下，和普通滚动条一样
 *  · 表格下半截还在屏幕外 —— 贴在可视区底边，半透明磨砂，你在看第 3 行也能拖
 *  · 往下滚到表格快到底 —— 两条边重合，滚动条跟着表格底边一起离开，不会出现两根叠着
 *
 * 一条规则把三种情形都覆盖了，不用分支。
 *
 * # 做法
 *
 * 不碰表格自己的滚动（那是 atomic-editor 的 `.cm-atomic-table`，overflow-x:auto），
 * 只在旁边画一根**代理**：滑块位置照它的 scrollLeft 算，拖滑块 / 在滑块上滚轮就回写
 * 它的 scrollLeft。表格没超宽时代理不出现。
 */
import { EditorView, ViewPlugin } from '@codemirror/view'
import type { ViewUpdate } from '@codemirror/view'

const TRACK_H = 20
const MIN_THUMB = 36

type Proxy = {
  host: HTMLElement
  track: HTMLDivElement
  thumb: HTMLDivElement
  onScroll: () => void
  onWheel: (e: WheelEvent) => void
  onDown: (e: PointerEvent) => void
}

export const tableScrollbars = ViewPlugin.fromClass(
  class {
    private proxies = new Map<HTMLElement, Proxy>()
    private raf = 0
    private ro: ResizeObserver
    private onScrollerScroll = () => this.schedule()

    constructor(private view: EditorView) {
      this.ro = new ResizeObserver(() => this.schedule())
      this.ro.observe(view.scrollDOM)
      view.scrollDOM.addEventListener('scroll', this.onScrollerScroll, { passive: true })
      this.schedule()
    }

    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.geometryChanged) this.schedule()
    }

    destroy() {
      cancelAnimationFrame(this.raf)
      this.ro.disconnect()
      this.view.scrollDOM.removeEventListener('scroll', this.onScrollerScroll)
      for (const p of this.proxies.values()) this.drop(p)
      this.proxies.clear()
    }

    private schedule() {
      cancelAnimationFrame(this.raf)
      this.raf = requestAnimationFrame(() => this.layout())
    }

    /** 每张表一根代理；表格从视口里消失就把代理拆了 */
    private layout() {
      const scroller = this.view.scrollDOM
      const seen = new Set<HTMLElement>()
      const tables = scroller.querySelectorAll<HTMLElement>('.cm-atomic-table')
      for (const host of tables) {
        seen.add(host)
        const wide = host.scrollWidth > host.clientWidth + 1
        let p = this.proxies.get(host)
        if (!wide) {
          if (p) { this.drop(p); this.proxies.delete(host) }
          continue
        }
        if (!p) {
          p = this.make(host)
          this.proxies.set(host, p)
        }
        this.place(p)
      }
      for (const [host, p] of this.proxies) {
        if (!seen.has(host)) { this.drop(p); this.proxies.delete(host) }
      }
    }

    private make(host: HTMLElement): Proxy {
      const track = document.createElement('div')
      track.className = 'xg-tbl-scroll'
      const thumb = document.createElement('div')
      thumb.className = 'xg-tbl-thumb'
      track.appendChild(thumb)
      this.view.scrollDOM.appendChild(track)

      const p: Proxy = {
        host, track, thumb,
        onScroll: () => this.place(p),
        onWheel: (e) => {
          // 在滚动条上滚轮 = 横着滚表格。竖向滚轮也吃掉,不然会去滚正文
          e.preventDefault()
          host.scrollLeft += (e.deltaX || e.deltaY)
        },
        onDown: (e) => this.drag(p, e),
      }
      host.addEventListener('scroll', p.onScroll, { passive: true })
      track.addEventListener('wheel', p.onWheel, { passive: false })
      thumb.addEventListener('pointerdown', p.onDown)
      // 点轨道空白处:滑块跳过去
      track.addEventListener('pointerdown', (e) => {
        if (e.target !== track) return
        const r = track.getBoundingClientRect()
        const ratio = (e.clientX - r.left) / r.width
        host.scrollLeft = ratio * host.scrollWidth - host.clientWidth / 2
      })
      return p
    }

    private drop(p: Proxy) {
      p.host.removeEventListener('scroll', p.onScroll)
      p.track.remove()
    }

    /** 核心：贴在表格底边和可视区底边里更靠上的那条上 */
    private place(p: Proxy) {
      const scroller = this.view.scrollDOM
      const sr = scroller.getBoundingClientRect()
      const hr = p.host.getBoundingClientRect()

      // 表格完全在视口外就别画
      if (hr.bottom < sr.top || hr.top > sr.bottom) { p.track.style.display = 'none'; return }
      p.track.style.display = ''

      // 坐标换算成 scroller 的内容坐标（track 是 scroller 的子元素,随内容滚）
      const contentTop = scroller.scrollTop
      const tableBottom = hr.bottom - sr.top + contentTop
      const viewBottom = sr.bottom - sr.top + contentTop
      const pinned = tableBottom > viewBottom
      const y = Math.min(tableBottom, viewBottom) - TRACK_H

      p.track.style.top = `${y}px`
      p.track.style.left = `${hr.left - sr.left + scroller.scrollLeft}px`
      p.track.style.width = `${hr.width}px`
      p.track.classList.toggle('is-pinned', pinned)

      const ratio = p.host.clientWidth / p.host.scrollWidth
      const w = Math.max(MIN_THUMB, hr.width * ratio)
      const maxLeft = hr.width - w
      const x = maxLeft * (p.host.scrollLeft / (p.host.scrollWidth - p.host.clientWidth || 1))
      p.thumb.style.width = `${w}px`
      p.thumb.style.transform = `translateX(${x}px)`
    }

    private drag(p: Proxy, e: PointerEvent) {
      e.preventDefault()
      const startX = e.clientX
      const startLeft = p.host.scrollLeft
      const trackW = p.track.getBoundingClientRect().width
      const thumbW = p.thumb.getBoundingClientRect().width
      const range = p.host.scrollWidth - p.host.clientWidth
      p.thumb.setPointerCapture(e.pointerId)
      p.track.classList.add('is-dragging')
      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - startX
        p.host.scrollLeft = startLeft + (dx / Math.max(1, trackW - thumbW)) * range
      }
      const up = () => {
        p.thumb.removeEventListener('pointermove', move)
        p.thumb.removeEventListener('pointerup', up)
        p.track.classList.remove('is-dragging')
      }
      p.thumb.addEventListener('pointermove', move)
      p.thumb.addEventListener('pointerup', up)
    }
  },
)

/**
 * 样式。贴在可视区底边（is-pinned）时给磨砂底 —— 那时候它压在正文上面，
 * 没有底就和文字混在一起；贴在表格底下时透明，看着就是表格自己的滚动条。
 */
export const tableScrollbarTheme = EditorView.theme({
  '.xg-tbl-scroll': {
    position: 'absolute',
    height: `${TRACK_H}px`,
    zIndex: '5',
    borderRadius: '10px',
    boxSizing: 'border-box',
    padding: '4px',
    background: 'transparent',
    transition: 'background-color 140ms ease, box-shadow 140ms ease',
  },
  '.xg-tbl-scroll.is-pinned': {
    background: 'color-mix(in srgb, var(--card) 62%, transparent)',
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)',
    boxShadow: '0 0 0 1px color-mix(in srgb, var(--border) 45%, transparent)',
  },
  '.xg-tbl-thumb': {
    height: '100%',
    borderRadius: '6px',
    background: 'color-mix(in srgb, var(--foreground) 22%, transparent)',
    cursor: 'grab',
    transition: 'background-color 140ms ease',
  },
  '.xg-tbl-scroll:hover .xg-tbl-thumb, .xg-tbl-scroll.is-dragging .xg-tbl-thumb': {
    background: 'color-mix(in srgb, var(--foreground) 40%, transparent)',
  },
  '.xg-tbl-scroll.is-dragging .xg-tbl-thumb': { cursor: 'grabbing' },
})
