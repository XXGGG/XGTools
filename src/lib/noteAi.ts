/**
 * 笔记里的大模型功能：改写选中的文字、续写、念给你听。
 *
 * 改写和续写用「设置 → 大模型」里配的本机模型（思考开关看 notes 那一项）；
 * 念给你听交给语音助手的服务（和助手同一个声音），服务没开就先把它拉起来。
 */
import { askLocal } from '@/lib/llm'
import { ensureVoiceService, loadAssistantCfg, VOICE_BASE } from '@/lib/assistant'

export type RewriteKind = 'polish' | 'shorten' | 'expand' | 'casual'

const RULES = '只输出改好的文字本身，不要解释、不要加引号、不要加标题；原文里的 Markdown 格式（加粗、列表、链接、代码）原样保留；用原文的语言。'

const ASK: Record<RewriteKind, string> = {
  polish: `润色下面这段文字：读起来更通顺、更清楚，保持原意和原来的语气，不要加原文没有的内容。${RULES}`,
  shorten: `把下面这段文字精简，保留要点，删掉重复和啰嗦的地方，大约缩到原来的一半。${RULES}`,
  expand: `把下面这段文字写得更具体一点：补上必要的细节和例子，但不要编造事实，长度大约是原来的 1.5 倍。${RULES}`,
  casual: `把下面这段文字改得更口语、更自然，像平时说话一样。${RULES}`,
}

export async function rewrite(kind: RewriteKind, text: string): Promise<string> {
  const out = await askLocal('notes', [
    { role: 'system', content: '你是一个中文写作助手，帮用户改他自己的笔记。' },
    { role: 'user', content: `${ASK[kind]}\n\n---\n${text}` },
  ], { temperature: 0.4 })
  if (!out) throw new Error('模型没给出内容')
  return out
}

/** 接着光标前面的内容往下写一小段 */
export async function continueWriting(before: string): Promise<string> {
  const ctx = before.slice(-2000)
  const out = await askLocal('notes', [
    { role: 'system', content: '你是一个中文写作助手，帮用户续写他自己的笔记。' },
    { role: 'user', content: `下面是一篇笔记写到一半的内容。接着最后一句往下写一小段（150 字以内），风格、语气、格式和前文一致，不要重复前文，不要总结。只输出续写的文字。\n\n---\n${ctx}` },
  ], { temperature: 0.7 })
  if (!out) throw new Error('模型没给出内容')
  return out
}

/** 念出来：去掉 Markdown 记号，交给语音服务 */
export async function readAloud(markdown: string) {
  const text = markdown
    .replace(/```[\s\S]*?```/g, '（代码略）')
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]*)(\|[^\]]*)?]]/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`~=>|]/g, '')
    .replace(/%%[\s\S]*?%%/g, '')
    .trim()
  if (!text) return
  const err = await ensureVoiceService(await loadAssistantCfg())
  if (err) throw new Error(err)
  await fetch(`${VOICE_BASE}/say`, { method: 'POST', body: JSON.stringify({ text }) })
}

export async function stopReading() {
  await fetch(`${VOICE_BASE}/stop`, { method: 'POST' }).catch(() => {})
}
