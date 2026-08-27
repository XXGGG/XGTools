/**
 * Obsidian Excalidraw 插件那种 `.excalidraw.md` 文件的读和写。
 *
 * # 这是个什么文件
 *
 * 表面是一篇 markdown（所以 Obsidian 能搜到里面的文字、能被双链引用），
 * 真正的图藏在文件末尾一个 Obsidian 注释块 `%% ... %%` 里：
 *
 * ```
 * ---
 * excalidraw-plugin: parsed
 * tags: [excalidraw]
 * ---
 * # Excalidraw Data
 * ## Text Elements
 * 画布上的每一段文字 ^元素id
 * %%
 * ## Drawing
 * ```compressed-json
 * <lz-string 压缩过的场景 JSON>
 * ```
 * %%
 * ```
 *
 * # 为什么读写都要「只动该动的那一块」
 *
 * 这是用户的文件，可能还被插件写过我们不认识的东西（版本号、嵌入的图片、
 * 自己加的正文段落）。整份重写等于把不认识的部分全丢掉。
 * 所以保存时只替换两处：Drawing 那个代码块的内容、Text Elements 那一节，
 * 其余原样保留 —— 包括压缩还是不压缩，跟着文件原来的样子走。
 *
 * # 为什么坚持用官方的 Excalidraw
 *
 * 那种手绘感是 roughjs 按每个元素的 `seed` 随机出来的。自己实现画不出
 * 一模一样的线条，两边打开就会是两个样子 —— 而这个功能的全部意义就是
 * 「Obsidian 那边画，这边打开一模一样」。
 */
import { compressToBase64, decompressFromBase64 } from 'lz-string'

/** 一份 Excalidraw 场景。字段跟着官方走，这里只声明用得到的 */
export type Scene = {
  type: string
  version: number
  source: string
  elements: any[]
  appState: Record<string, any>
  files: Record<string, any>
}

export type ParsedCanvas = {
  scene: Scene
  /** 原文件用的是压缩还是明文 —— 保存时照旧，别替用户改设置 */
  compressed: boolean
}

/**
 * 认这份内容是不是 Excalidraw 画布。
 *
 * 判据和 Obsidian 插件一致:frontmatter 里的 `excalidraw-plugin`。
 * **不看文件名** —— `.excalidraw` 那一截只是插件的默认命名,用户改掉之后
 * 文件还是画布,Obsidian 那边照样当画布开。
 */
export function isCanvasContent(md: string) {
  return md.includes('excalidraw-plugin:')
}

const DRAWING_RE = /(```(compressed-json|json)\n)([\s\S]*?)(\n```)/

const EMPTY: Scene = {
  type: 'excalidraw',
  version: 2,
  source: 'https://github.com/XXGGG/XGTools',
  elements: [],
  appState: { viewBackgroundColor: '#ffffff', gridSize: null },
  files: {},
}

/**
 * 从文件内容里把场景挖出来。
 *
 * 挖不到就返回一份空场景 —— 新建的、被别的工具截断过的文件都会走到这里，
 * 直接报错的话用户只能看着一个打不开的文件干瞪眼。
 */
export function parseCanvas(md: string): ParsedCanvas {
  const m = DRAWING_RE.exec(md)
  if (!m) return { scene: { ...EMPTY }, compressed: true }

  const compressed = m[2] === 'compressed-json'
  const body = m[3]
  let raw: string | null
  if (compressed) {
    // 换行是排版加的，解压之前必须全清掉
    raw = decompressFromBase64(body.replace(/\s/g, ''))
  } else {
    raw = body
  }
  try {
    const scene = JSON.parse(raw ?? '') as Scene
    return { scene: { ...EMPTY, ...scene }, compressed }
  } catch {
    return { scene: { ...EMPTY }, compressed }
  }
}

/** 压缩后按 256 字一行、行间空一行 —— 和插件写出来的一模一样，diff 才不会整块变 */
function wrap(b64: string) {
  const out: string[] = []
  for (let i = 0; i < b64.length; i += 256) out.push(b64.slice(i, i + 256))
  return out.join('\n\n')
}

/**
 * 画布上的文字另抄一份到 `## Text Elements`。
 *
 * 这一节不是给我们看的，是给 **Obsidian** 看的：搜索、双链、大纲都只认
 * markdown 正文，图里的文字不抄出来就等于不存在。格式是「文字 ^元素id」。
 */
function textSection(scene: Scene) {
  const lines = scene.elements
    .filter((e) => e && e.type === 'text' && !e.isDeleted && typeof e.text === 'string')
    .map((e) => `${e.text} ^${e.id}`)
  return lines.join('\n\n')
}

/**
 * 把新场景写回文件，其余部分原样保留。
 *
 * 找不到 Drawing 代码块时说明这文件不是我们认的那种结构 —— 这时候**返回
 * null 而不是硬写**：宁可保存失败提示一声，也不能把一份看不懂的文件覆盖掉。
 */
export function updateCanvas(md: string, scene: Scene, compressed: boolean): string | null {
  if (!DRAWING_RE.test(md)) return null

  const json = JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: scene.source || EMPTY.source,
    elements: scene.elements,
    appState: scene.appState,
    files: scene.files ?? {},
  }, null, '\t')

  const body = compressed ? wrap(compressToBase64(json)) : json
  const fence = compressed ? 'compressed-json' : 'json'

  let out = md.replace(DRAWING_RE, () => `\`\`\`${fence}\n${body}\n\`\`\``)

  /*
    Text Elements 那一节整块换掉。

    **按行找边界，不用正则。** 这一节结束于下一行以 `%%` 或 `## ` 开头，
    而这两个标志可能紧贴着标题（空画布就是 `## Text Elements` 下面直接一行 `%%`）。
    非贪婪正则碰到紧贴的情况会一路吃到更后面的边界，把 `%%` 那行一起吞掉 ——
    文件结构当场报废，而且从代码上一眼看不出来。
  */
  const lines = out.split('\n')
  const head = lines.findIndex((l) => l.trim() === '## Text Elements')
  if (head >= 0) {
    let end = head + 1
    while (end < lines.length && !lines[end].startsWith('%%') && !lines[end].startsWith('## ')) end++
    const body = textSection(scene)
    lines.splice(head + 1, end - head - 1, ...(body ? [body, ''] : ['']))
    out = lines.join('\n')
  }
  return out
}

/** 新建画布时写进去的模板。照插件的样子来，保证它那边也认 */
export function newCanvasFile() {
  return `---

excalidraw-plugin: parsed
tags: [excalidraw]

---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'


# Excalidraw Data

## Text Elements

%%
## Drawing
\`\`\`compressed-json
${wrap(compressToBase64(JSON.stringify(EMPTY, null, '\t')))}
\`\`\`
%%`
}
