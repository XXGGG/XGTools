/*
  翻译引擎优先级链。

  以前是「免费接口 or AI」二选一,AI 挂了回退到那个免费接口 —— 两级写死。现在是一条链:
  用户在翻译设置里把引擎拖成想要的顺序,翻译时从上往下试,谁成功用谁,失败的自动跳过。
  「AI 优先、本机离线垫底」「本机优先、在线兜底」都只是排序不同。

  翻译页、命令面板、截图翻译三处都从这里走;链只存一份(settings.json 的 translate_chain)。
  老版本那三个键(translate_mode / translate_free_engine / translate_ai_engine)不再写,
  第一次没有链的时候从它们推一条出来。
*/
import { invoke } from '@tauri-apps/api/core'
import { LazyStore } from '@tauri-apps/plugin-store'
import { localTranslate } from './bergamot'

export type EngineKind = 'free' | 'ai' | 'local'
export type EngineMeta = { id: string; label: string; kind: EngineKind }
export type AiConfig = { api_key: string; api_url: string; model: string }

export const ENGINES: EngineMeta[] = [
  { id: 'google', label: 'Google 翻译', kind: 'free' },
  { id: 'bing', label: 'Bing 翻译', kind: 'free' },
  { id: 'deepl', label: 'DeepL 翻译', kind: 'free' },
  { id: 'mymemory', label: 'MyMemory 翻译', kind: 'free' },
  { id: 'local', label: '本机离线（Bergamot）', kind: 'local' },
  { id: 'openai', label: 'OpenAI', kind: 'ai' },
  { id: 'claude', label: 'Claude', kind: 'ai' },
  { id: 'gemini', label: 'Gemini', kind: 'ai' },
  { id: 'deepseek', label: 'DeepSeek', kind: 'ai' },
  { id: 'qwen', label: '通义千问', kind: 'ai' },
  { id: 'zhipu', label: '智谱 GLM', kind: 'ai' },
  { id: 'yi', label: '零一万物', kind: 'ai' },
  { id: 'moonshot', label: 'Moonshot', kind: 'ai' },
  { id: 'groq', label: 'Groq', kind: 'ai' },
  { id: 'custom', label: '自定义接口', kind: 'ai' },
]
export const engineMeta = (id: string): EngineMeta | undefined => ENGINES.find((e) => e.id === id)
export const engineLabel = (id: string): string => engineMeta(id)?.label ?? id

const store = new LazyStore('settings.json')
const KEY = 'translate_chain'

/** 读链。没存过就从老版本的模式 / 免费引擎 / AI 引擎推一条出来 */
export async function loadChain(): Promise<string[]> {
  await store.init()
  const saved = await store.get<string[]>(KEY)
  if (Array.isArray(saved)) return saved.filter((id) => engineMeta(id))
  const mode = (await store.get<string>('translate_mode')) ?? 'free'
  const free = (await store.get<string>('translate_free_engine')) ?? 'google'
  const ai = (await store.get<string>('translate_ai_engine')) ?? 'openai'
  const cfgs = (await store.get<Record<string, AiConfig>>('translate_ai_configs')) ?? {}
  const chain: string[] = []
  if (mode === 'ai' && cfgs[ai]?.api_key) chain.push(ai)
  chain.push(free)
  return chain.filter((id, i, a) => engineMeta(id) && a.indexOf(id) === i)
}

export async function loadAiConfigs(): Promise<Record<string, AiConfig>> {
  await store.init()
  return (await store.get<Record<string, AiConfig>>('translate_ai_configs')) ?? {}
}

type RawResult = { text: string; detected_lang: string | null; engine: string }
export type ChainFailure = { engine: string; error: string }
export type ChainResult = { text: string; detected: string | null; engine: string; failed: ChainFailure[] }

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** 用指定引擎翻一段。抛错 = 这个引擎这次不行,链会跳到下一个 */
export async function translateWith(
  engine: string, text: string, target: 'zh' | 'en', aiConfigs: Record<string, AiConfig>,
): Promise<{ text: string; detected: string | null }> {
  const meta = engineMeta(engine)
  if (!meta) throw new Error(`未知引擎 ${engine}`)
  if (meta.kind === 'local') return { text: await localTranslate(text, target), detected: null }

  let ai_config: { api_key: string; api_url: string | null; model: string | null } | null = null
  if (meta.kind === 'ai') {
    const c = aiConfigs[engine]
    if (!c?.api_key) throw new Error('没配 API Key')
    ai_config = { api_key: c.api_key, api_url: c.api_url || null, model: c.model || null }
  }
  const r = await invoke<RawResult>('translate', {
    request: { text, source_lang: 'auto', target_lang: target, engine, ai_config },
  })
  if (!r.text?.trim()) throw new Error('返回了空译文')
  return { text: r.text, detected: r.detected_lang ?? null }
}

/** 顺着链翻。返回用了谁、前面谁失败了;全失败才抛错,错误里带每个引擎的原因 */
export async function translateChain(
  text: string, target: 'zh' | 'en', chain?: string[], aiConfigs?: Record<string, AiConfig>,
): Promise<ChainResult> {
  const order = chain ?? (await loadChain())
  const cfgs = aiConfigs ?? (await loadAiConfigs())
  if (!order.length) throw new Error('还没有翻译引擎,去翻译设置里加一个')
  const failed: ChainFailure[] = []
  for (const engine of order) {
    try {
      const r = await translateWith(engine, text, target, cfgs)
      return { ...r, engine, failed }
    } catch (e) {
      failed.push({ engine, error: errMsg(e) })
    }
  }
  throw new Error(failed.map((f) => `${engineLabel(f.engine)}：${f.error}`).join('\n'))
}

/**
 * 截图翻译用:一批文本块。AI 引擎合并成一次请求(省请求、上下文连贯),
 * 免费 / 离线引擎逐块并行,每块各自顺着链往下兜底。返回整批用的是哪个引擎。
 */
export async function translateBlocks(texts: string[], target: 'zh' | 'en'): Promise<{ texts: string[]; engine: string }> {
  const order = await loadChain()
  const cfgs = await loadAiConfigs()
  if (!order.length) throw new Error('还没有翻译引擎,去翻译设置里加一个')
  const errors: string[] = []
  for (let i = 0; i < order.length; i++) {
    const engine = order[i]
    if (engineMeta(engine)?.kind === 'ai') {
      try {
        const sep = '\n---BLOCK---\n'
        const r = await translateWith(engine, texts.join(sep), target, cfgs)
        const parts = r.text.split(/---BLOCK---/).map((s) => s.trim())
        return { texts: texts.map((_, k) => parts[k] || ''), engine }
      } catch (e) {
        errors.push(`${engineLabel(engine)}：${errMsg(e)}`)
        continue
      }
    }
    // 非 AI:逐块翻,每块从这里往后的链各自兜底;翻不出来的块留原文
    const rest = order.slice(i)
    const out = await Promise.all(texts.map((t) => translateChain(t, target, rest, cfgs).then((r) => r.text).catch(() => t)))
    return { texts: out, engine }
  }
  throw new Error(errors.join('\n'))
}
