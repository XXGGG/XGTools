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
  { id: 'custom', label: 'AI 自定义接口', kind: 'ai' },
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

/* ────────── 兜底赛跑 ────────── */

/*
  **排序和兜底是两件事，别混。**

  排序（上面那条链）是「前面的不行才轮到后面的」—— 它省钱，代价是**时间**：
  等第一个引擎超时、失败，人已经干等了好几秒，才开始试第二个。

  兜底是「同时开跑，谁先回来算谁的」。两个开关：本地离线包，和本机跑的 AI 接口。
  它们和链**一起**出发；Google 慢的时候，本地那份早就翻好了，直接就出来。

  ⚠ **兜底只收跑在本机的东西，在线接口一概不进来。** 赛跑意味着请求**一定发出去**了 ——
  在线接口哪怕最后没赢，那次调用照样计费，而赛跑是**每一次翻译**都发。
  一个「顺手打开」的开关不该在背地里按次烧额度，所以这里不给这个选项，
  而不是给了再写一行警告。本机跑的模型（Ollama 那种）不花钱，随便开。

  「地址是不是本机」由 isFreeToRace 现算 —— 存档里存的只是「开没开」，
  真要出发之前还会再验一次，免得改了地址之后旧开关偷偷把请求发到线上去。
*/
export type RaceConfig = {
  /** 本地离线包（Bergamot）当兜底 */
  local: boolean
  /** 「AI 自定义接口」当兜底。只在它的地址指向本机时才真的出发 */
  localAi: boolean
}

const RACE_KEY = 'translate_race'

export async function loadRace(): Promise<RaceConfig> {
  await store.init()
  const r = (await store.get<Record<string, unknown>>(RACE_KEY)) ?? {}
  return {
    // 早一版这两格存的是引擎 id 而不是布尔,认一下
    local: r.local === true || r.local === 'local',
    localAi: r.localAi === true || r.ai === 'custom',
  }
}

export async function saveRace(r: RaceConfig): Promise<void> {
  await store.init()
  await store.set(RACE_KEY, r)
  await store.save()
}

/**
 * 这个引擎参加赛跑要不要花钱。
 *
 * 本机离线永远免费；自定义接口指向本机（Ollama、LM Studio 那种）也免费 ——
 * 判据就是地址里的 localhost / 127.0.0.1 / 0.0.0.0 / [::1]。
 * 其余的 AI 引擎一律当成要花钱，宁可多提醒一次。
 */
export function isFreeToRace(engine: string, cfgs: Record<string, AiConfig>): boolean {
  const meta = engineMeta(engine)
  if (!meta) return false
  if (meta.kind !== 'ai') return true
  const url = cfgs[engine]?.api_url ?? ''
  return /(?:^|\/\/)(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::|\/|$)/i.test(url)
}

type Runner = { name: string; run: () => Promise<ChainResult> }

/**
 * 谁先成功算谁的。全都失败才抛错，错误里带上每一路的原因。
 *
 * 不用 Promise.any：那个只给一个 AggregateError，拿不到「谁赢了」，
 * 而我们要把赢家标在结果上（界面右上角那个徽章）。而且这里 target 是 ES2020，
 * Promise.any 的类型压根不在 lib 里。
 */
function firstSuccess(runners: Runner[]): Promise<ChainResult> {
  return new Promise((resolve, reject) => {
    let left = runners.length
    const failed: ChainFailure[] = []
    let done = false
    for (const r of runners) {
      r.run().then(
        (v) => { if (!done) { done = true; resolve(v) } },
        (e) => {
          failed.push({ engine: r.name, error: errMsg(e) })
          if (--left === 0 && !done) {
            reject(new Error(failed.map((f) => `${engineLabel(f.engine)}：${f.error}`).join('\n')))
          }
        },
      )
    }
  })
}

/**
 * 翻一段。配了兜底就赛跑，没配就还是老老实实顺着链走。
 *
 */
export async function translateRacing(
  text: string, target: 'zh' | 'en',
  opts?: { chain?: string[]; aiConfigs?: Record<string, AiConfig>; race?: RaceConfig },
): Promise<ChainResult> {
  // 翻译页会把「页面上正在编辑、还没落盘」的那份传进来,其余地方读存档
  const [order, cfgs, race] = await Promise.all([
    opts?.chain ?? loadChain(),
    opts?.aiConfigs ?? loadAiConfigs(),
    opts?.race ?? loadRace(),
  ])
  /*
    两条硬规矩:
     · 兜底只放本机的东西 —— localAi 那格还要**当场验一次地址**,
       改了地址之后留下的旧开关不能把请求偷偷发到线上去
     · 已经排在链**第一位**的引擎不再作为兜底出发一次:同一个请求发两遍,
       不会更快,只会多花一次
  */
  const extras = [
    race.local ? 'local' : null,
    race.localAi && isFreeToRace('custom', cfgs) ? 'custom' : null,
  ].filter((e): e is string => !!e && e !== order[0])

  if (!order.length && !extras.length) {
    throw new Error('还没有翻译引擎,去翻译设置里加一个')
  }
  if (!extras.length) return translateChain(text, target, order, cfgs)

  const runners: Runner[] = []
  if (order.length) {
    runners.push({ name: order[0], run: () => translateChain(text, target, order, cfgs) })
  }
  for (const e of extras) {
    runners.push({
      name: e,
      run: () => translateWith(e, text, target, cfgs)
        .then((r) => ({ ...r, engine: e, failed: [] as ChainFailure[] })),
    })
  }
  return firstSuccess(runners)
}
