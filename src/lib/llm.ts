/**
 * 本机大模型（Ollama）的设置：连哪、用哪个模型、每个功能开不开思考。
 *
 * 设置页「大模型」改这里，存在 llm.json。用到它的地方：
 *  - 翻译：翻译引擎链里的本机 AI 引擎，开不开思考看 think.translate（默认关，开了一句话要想十几秒）
 *  - 提示词：Anima 打磨，think.prompt
 *  - 笔记：改写、续写这些，think.notes
 *  - 语音助手：用同一个模型
 * 本机没装 Ollama 或者没有这个模型时，这些功能自己退回原来的做法（翻译链、直译），不报错。
 */
import { LazyStore } from '@tauri-apps/plugin-store'

export type LlmFeature = 'translate' | 'prompt' | 'notes'

export type LlmCfg = {
  url: string
  model: string
  think: Record<LlmFeature, boolean>
}

export const LLM_DEFAULTS: LlmCfg = {
  url: 'http://127.0.0.1:11434',
  model: 'qwen3.5:9b',
  think: { translate: false, prompt: false, notes: false },
}

const store = new LazyStore('llm.json')
let cache: LlmCfg | null = null

export async function loadLlm(): Promise<LlmCfg> {
  if (cache) return cache
  await store.init()
  const saved = (await store.get<Partial<LlmCfg>>('config')) ?? {}
  cache = { ...LLM_DEFAULTS, ...saved, think: { ...LLM_DEFAULTS.think, ...(saved.think ?? {}) } }
  return cache
}

export async function saveLlm(c: LlmCfg) {
  cache = c
  await store.set('config', c)
  await store.save()
}

/** 某个功能要不要开思考（模型不支持思考时永远是关） */
export async function thinkFor(f: LlmFeature) {
  return (await loadLlm()).think[f]
}

export type LocalModel = { name: string; size: number; think: boolean; vision: boolean }

/** 列出本机 Ollama 里的模型，顺便看每个支不支持思考、看图；连不上返回 null */
export async function listLocalModels(url: string): Promise<LocalModel[] | null> {
  try {
    const r = await fetch(`${url.replace(/\/+$/, '')}/api/tags`)
    if (!r.ok) return null
    const { models = [] } = await r.json() as { models?: { name: string; size: number }[] }
    return await Promise.all(models.map(async (m) => {
      const caps = await capabilities(url, m.name)
      return { name: m.name, size: m.size, think: caps.includes('thinking'), vision: caps.includes('vision') }
    }))
  }
  catch {
    return null
  }
}

async function capabilities(url: string, model: string): Promise<string[]> {
  try {
    const r = await fetch(`${url.replace(/\/+$/, '')}/api/show`, { method: 'POST', body: JSON.stringify({ model }) })
    return r.ok ? ((await r.json()).capabilities ?? []) : []
  }
  catch {
    return []
  }
}

type Msg = { role: 'system' | 'user' | 'assistant'; content: string }

/**
 * 问本机模型一次（不流式）。feature 决定开不开思考；json=true 时要求它只回 JSON。
 * 连不上 / 没这个模型就抛错，调用方自己决定退回什么。
 */
export async function askLocal(feature: LlmFeature, messages: Msg[], opts: { json?: boolean; temperature?: number } = {}): Promise<string> {
  const c = await loadLlm()
  const r = await fetch(`${c.url.replace(/\/+$/, '')}/api/chat`, {
    method: 'POST',
    body: JSON.stringify({
      model: c.model, messages, stream: false, think: c.think[feature], keep_alive: '30m',
      ...(opts.json ? { format: 'json' } : {}),
      options: { temperature: opts.temperature ?? 0.3, num_ctx: 8192 },
    }),
  })
  if (!r.ok) throw new Error(`本机模型没响应（${r.status}）：${(await r.text()).slice(0, 120)}`)
  return ((await r.json()).message?.content ?? '').trim()
}
