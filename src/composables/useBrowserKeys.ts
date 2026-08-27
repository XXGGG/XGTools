/**
 * 把 webview 自带的浏览器快捷键收掉。
 *
 * # 为什么要管
 *
 * 这是个桌面应用，用户不觉得自己在用浏览器。可 WebView2 底下还是 Chromium，
 * Ctrl+F 弹出的是浏览器的查找条、Ctrl+P 打印整个界面、Ctrl+R 把应用刷掉、
 * F5 同上、Ctrl+加减号缩放整个界面 —— 每一个都会让人以为应用坏了。
 *
 * # 例外
 *
 * - **Ctrl+F 在笔记页要留给编辑器**：那儿有 CodeMirror 自己的查找替换，
 *   比浏览器那条好用得多，所以不拦，让它冒泡到编辑器。
 * - **F12 / Ctrl+Shift+I 只在开发时可用**：打包出去的版本不该有开发者工具，
 *   但我们自己调试时天天要用。
 */
import { zen } from './useZen'

/** 拦下来的组合键。每一条都写清楚它原本会干什么 */
const BLOCKED: Array<{ test: (e: KeyboardEvent) => boolean, why: string }> = [
  { test: (e) => e.ctrlKey && e.key.toLowerCase() === 'p', why: '打印整个界面' },
  { test: (e) => e.ctrlKey && e.key.toLowerCase() === 'r', why: '刷新，等于把应用重启' },
  { test: (e) => e.key === 'F5', why: '同上' },
  { test: (e) => e.ctrlKey && e.key.toLowerCase() === 'u', why: '查看网页源代码' },
  { test: (e) => e.ctrlKey && e.key.toLowerCase() === 'g', why: '查找下一个（浏览器查找条的）' },
  { test: (e) => e.ctrlKey && ['+', '-', '=', '0'].includes(e.key), why: '缩放整个界面' },
]

/**
 * 现在是不是在笔记页的编辑器里。
 *
 * 用「焦点在不在 CodeMirror 里」判断，而不是看当前是哪一页 —— 笔记页上
 * 也有搜索框、也有对话输入框，在那些地方按 Ctrl+F 同样不该弹浏览器查找条，
 * 但也轮不到编辑器接管。
 */
function inEditor() {
  return !!document.activeElement?.closest('.cm-editor')
}

function onKey(e: KeyboardEvent) {
  // 开发时留着开发者工具和刷新，打包版本两个都关掉。
  // 刷新这条尤其要留：热更新救不回来的时候（比如换了 CodeMirror 的扩展类型），
  // 没有 Ctrl+R 就只能整个重启 cargo，一次两分钟。
  if (
    e.key === 'F12'
    || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'i')
    || (import.meta.env.DEV && (e.key === 'F5' || (e.ctrlKey && e.key.toLowerCase() === 'r')))
  ) {
    if (!import.meta.env.DEV) e.preventDefault()
    return
  }

  if (e.ctrlKey && e.key.toLowerCase() === 'f') {
    // 在编辑器里就让它过去，CodeMirror 的查找替换比浏览器那条好用
    if (!inEditor()) e.preventDefault()
    return
  }

  // 禅模式下 Esc 是退出全屏，那是笔记页自己的事，这里不碰
  if (e.key === 'Escape' && zen.on) return

  if (BLOCKED.some((b) => b.test(e))) e.preventDefault()
}

/**
 * 全局挂一次。**必须用捕获阶段** —— 浏览器的默认行为在事件走到冒泡阶段之前
 * 就已经排上队了，挂在冒泡上拦不住 Ctrl+P 这类。
 */
export function bindBrowserKeys() {
  window.addEventListener('keydown', onKey, true)
}
