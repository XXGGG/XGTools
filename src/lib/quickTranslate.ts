/**
 * 一句话翻译。给命令面板用的:输入一段文字,回车,拿回译文。
 *
 * 引擎和密钥沿用翻译页的设置(settings.json 里那几个 translate_* 键),
 * 不另开一套 —— 用户在翻译页配好的 AI 引擎,面板里理所当然也该生效。
 * 目标语言按内容定:中文占三成以上就译成英文,否则译成中文;
 * 和截图翻译用的是同一条规矩。
 */
import { invoke } from '@tauri-apps/api/core'
import { LazyStore } from '@tauri-apps/plugin-store'

export type QuickTranslation = {
  /** 原文,用来判断「第二次回车」是不是同一句 */
  source: string
  text: string
  detected: string | null
  target: string
  engine: string
}

type AiConfig = { api_key: string; api_url: string; model: string }

const store = new LazyStore('settings.json')

export async function quickTranslate(source: string): Promise<QuickTranslation> {
  await store.init()
  const mode = (await store.get<string>('translate_mode')) ?? 'free'
  const freeEngine = (await store.get<string>('translate_free_engine')) ?? 'google'
  const aiEngine = (await store.get<string>('translate_ai_engine')) ?? 'openai'
  const aiConfigs = (await store.get<Record<string, AiConfig>>('translate_ai_configs')) ?? {}

  const useAi = mode === 'ai' && !!aiConfigs[aiEngine]?.api_key
  const engine = useAi ? aiEngine : freeEngine
  const ai = useAi ? aiConfigs[aiEngine] : null

  const zh = (source.match(/[一-鿿]/g) || []).length / Math.max(1, source.length)
  const target = zh > 0.3 ? 'en' : 'zh'

  const res = await invoke<{ text: string; detected_lang: string | null; engine: string }>('translate', {
    request: {
      text: source,
      source_lang: 'auto',
      target_lang: target,
      engine,
      ai_config: ai ? { api_key: ai.api_key, api_url: ai.api_url || null, model: ai.model || null } : null,
    },
  })
  return { source, text: res.text.trim(), detected: res.detected_lang, target, engine: res.engine }
}
