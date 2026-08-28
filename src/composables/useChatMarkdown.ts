/**
 * 智能体回复的 markdown 渲染。
 *
 * # 为什么不复用 useExport 里那个实例
 *
 * 导出那个开着 `html: true` —— 导出的是**用户自己的笔记**,里面的 HTML
 * 是他自己写的。聊天渲染的是**模型的输出**,模型要是吐一段 `<img onerror=…>`
 * 出来,html: true 就直接把它执行了。两边的信任边界不同,不能共用配置。
 *
 * # 流式期间也照渲染
 *
 * 半截 markdown(没闭合的代码围栏之类)渲染出来会闪一下样式,
 * 但原版 DSH 就是这么做的 —— 好过整段回复写完前一直是生文本,
 * 写完那一刻「啪」地变一次排版。
 */
import MarkdownIt from 'markdown-it'

const md = new MarkdownIt({
  html: false,     // 模型输出是不可信内容,原始 HTML 一律转义
  linkify: true,
  breaks: true,    // 聊天里单个换行就是想换行,不该被折叠成空格
})

export function renderChatMd(text: string): string {
  return md.render(text)
}

/**
 * 消息区里点到链接:转给系统浏览器。
 *
 * 不拦的话 webview 会**在应用里**打开那个网页,整个界面被顶掉,
 * 还没有地址栏和后退 —— 用户只能杀进程。
 */
export async function onChatLinkClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest('a')
  if (!a?.href || !/^https?:/i.test(a.href)) return
  e.preventDefault()
  const { open } = await import('@tauri-apps/plugin-shell')
  await open(a.href)
}
