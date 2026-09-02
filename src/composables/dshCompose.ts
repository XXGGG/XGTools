/**
 * 输入框里的两件事:`@` 引用文件、往消息里夹图片。
 *
 * 纯函数放这儿,和文本框解耦 —— 光标位置怎么算、路径怎么写成引用,
 * 这些和 Vue 没关系,也最容易写错(引号、空格、目录尾巴那个斜杠),
 * 单独放着才好一条条对着协议核。
 */
import { invoke } from '@tauri-apps/api/core'

// ── @ 引用文件 ────────────────────────────────────────
//
// DSH 侧的规矩(照 @deepseek-ai/dsh-file-reference 的说明实现):
//  · 只有**输入开头或空白之后**的 `@path` 才算引用 —— 不然 a@b.com 这种
//    邮箱地址会把补全面板弹出来
//  · 路径里有空格就得加引号:`@"my notes/a b.md"`
//  · 目录候选补一个 `/`,让模型一眼看出这是目录不是文件
//  · **选中候选不会读文件**。它只是一句写法规范的提及,内容要模型自己调 read
//    去看 —— 所以这里也不该偷偷把文件塞进上下文

/** 光标处那个还没写完的 `@…`。不在引用位置就返回 null */
export function activeAtToken(text: string, caret: number): { from: number; query: string } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0) return null

  // 开头,或者前一个字符是空白 —— 否则这个 @ 是别的东西的一部分
  const prev = at > 0 ? before[at - 1] : ' '
  if (!/\s/.test(prev)) return null

  const rest = before.slice(at + 1)
  // 带引号的:引号内可以有空格,直到闭合为止
  if (rest.startsWith('"')) {
    const closed = rest.indexOf('"', 1)
    if (closed >= 0) return null      // 已经写完了,不再补全
    return { from: at, query: rest.slice(1) }
  }
  // 不带引号的:遇到空白就结束
  if (/\s/.test(rest)) return null
  return { from: at, query: rest }
}

/** 路径写成引用的样子。带空格的加引号,目录补斜杠 */
export function formatFileMention(path: string, kind: 'file' | 'directory'): string | null {
  // 控制字符和引号在这套语法里没法安全表示,宁可不给也不给个错的
  if (/[\x00-\x1f"]/.test(path)) return null
  const p = kind === 'directory' && !path.endsWith('/') ? `${path}/` : path
  return /\s/.test(p) ? `@"${p}"` : `@${p}`
}

export type FileCandidate = { path: string; kind: 'file' | 'directory' }

/**
 * 问 DSH 要候选。它按这个会话的工作区来找,不是我们自己扫盘。
 *
 * 回来的名单**再按输入过一遍**:DSH 给的是「相关的排前面」,不是「只给匹配的」,
 * 名单尾巴上常挂着一堆完全不沾边的路径(工作区大的时候尤其明显)。
 * 补全面板只有八行,尾巴上那些一旦挤进来,看着就像它根本没在听你打字。
 * 一个都不匹配时退回原名单 —— 那多半是刚打完 `@` 还没输字,这时候本来就是在浏览。
 */
export async function listFileReferences(sessionId: string, query: string): Promise<FileCandidate[]> {
  if (!sessionId) return []
  try {
    const v = await invoke<any[]>('dsh_rpc', {
      method: 'fileReferences/list',
      payload: { args: { agentId: sessionId, query } },
    })
    const rows = (Array.isArray(v) ? v : []).map((c): FileCandidate => ({
      path: String(c?.path ?? ''),
      kind: c?.kind === 'directory' ? 'directory' : 'file',
    })).filter((c) => c.path)

    const q = query.trim().toLowerCase()
    if (!q) return rows
    // 打了字就只给对得上的。一个都没有就是真没有 —— 这时候摆一堆不沾边的路径,
    // 比空着更让人以为它没在听
    return rows.filter((c) => c.path.toLowerCase().includes(q))
  } catch {
    return []   // 拿不到候选就当没有,别拿报错打断打字
  }
}

// ── 图片附件 ──────────────────────────────────────────
//
// 图片是**消息内容的一部分**,不是消息之外的挂件:发的时候和文字并排放进
// `content` 数组里(`{type:'image', mediaType, data}`)。这一点踩过 ——
// 试过顶层 `images`/`attachments` 字段,服务端照单全收却什么都没发生,
// 因为那两个字段它根本不认,而 payload 又是宽松校验,不报错。
//
// 第一版只收 PNG / JPEG / WebP / GIF,这是 DSH 那边的准入名单。

export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif']

const MEDIA: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
}

/** 待发送的一张图。`url` 只给界面画缩略图用,不进协议 */
export type Draft = { name: string; mediaType: string; data: string; url: string }

export function mediaTypeOf(name: string): string | null {
  return MEDIA[name.split('.').pop()?.toLowerCase() ?? ''] ?? null
}

/** Uint8Array → base64。分片走,一次 apply 太长的数组会爆栈 */
export function toBase64(bytes: Uint8Array): string {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(s)
}

export function draftFromBytes(name: string, bytes: Uint8Array): Draft | null {
  const mediaType = mediaTypeOf(name)
  if (!mediaType) return null
  const data = toBase64(bytes)
  return { name, mediaType, data, url: `data:${mediaType};base64,${data}` }
}

// ── 大段文本附件 ──────────────────────────────────────
//
// 往输入框里贴一整份文件(一段代码、一篇 md)时,如果原样铺在框里,输入框会
// 涨成一屏,前面写的那句话被推没了,想改一个字都得先滚半天 —— 而这段文本
// 十有八九不是「要打的字」,是「要给它看的材料」。
//
// 所以贴大段文本就把它收成一个附件条:输入框还是那两行,材料挂在上面,
// 点开能看、能改、能撤掉。发出去的时候再把它接回消息里 ——
// 协议这边没有「附件」这种东西,一条消息只有文字和图片两种块,
// 所以材料是以「文字」的身份跟着走的,只是界面上不让它占地方。

/** 一份贴进来的文本材料。`id` 只用来做列表 key 和正文栏的滚动位置 */
export type TextDraft = { id: string; name: string; kind: 'md' | 'code' | 'txt'; text: string }

/**
 * 多大才算「大段」。
 *
 * 两条都放宽一点:标准是「这东西铺开会不会把输入框顶掉」。贴一个网址、
 * 一句报错、一段两三行的日志,那是话的一部分,收成附件反而绕远;
 * 而十几行往上的,基本就是整份文件了。
 */
const BIG_CHARS = 800
const BIG_LINES = 15

export function isBigPaste(text: string): boolean {
  return text.length >= BIG_CHARS || text.split('\n').length >= BIG_LINES
}

/**
 * 猜猜这段文本是什么。
 *
 * 只用来决定**图标和后缀名**,猜错了顶多图标不对,内容一个字不会变 ——
 * 所以规则可以粗,不用为了准确率把它写成一个语言识别器。
 */
export function sniffText(text: string): 'md' | 'code' | 'txt' {
  const head = text.slice(0, 4000)
  if (/^---\r?\n/.test(head) || /^#{1,6}\s/m.test(head) || /^```/m.test(head) ||
      /^\s*[-*]\s+\[[ x]\]/m.test(head) || /^\s*\|.+\|\s*$/m.test(head)) return 'md'
  if (/^\s*(import|export|from|def|class|function|const|let|var|package|using|#include|fn|pub)\s/m.test(head) ||
      /=>|;\s*$|\{\s*$|<\/\w+>/m.test(head)) return 'code'
  return 'txt'
}

const EXT: Record<TextDraft['kind'], string> = { md: 'md', code: 'txt', txt: 'txt' }

/** 收一段贴进来的文本。`seq` 是这条消息里的第几份,用来起名 */
export function textDraftFrom(text: string, seq: number): TextDraft {
  const kind = sniffText(text)
  return {
    id: `t${Date.now().toString(36)}${seq}`,
    name: `粘贴内容-${seq}.${EXT[kind]}`,
    kind,
    text,
  }
}

/**
 * 把材料接回消息里。
 *
 * 用围栏包起来,并且**围栏的长度按内容里最长的一串反引号来定** ——
 * 贴进来的要是一篇本身就带代码块的 md,用固定三个反引号会被内容里的
 * 三个反引号提前截断,后半截直接漏在围栏外面。
 */
export function attachmentBlock(d: TextDraft): string {
  const longest = (d.text.match(/`+/g) ?? []).reduce((n, s) => Math.max(n, s.length), 0)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  const lang = d.kind === 'md' ? 'md' : ''
  return `【附件：${d.name}】\n${fence}${lang}\n${d.text}\n${fence}`
}
