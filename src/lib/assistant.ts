/**
 * 语音助手的设置和本机语音服务（voice/server.py）的连接。
 *
 * 收音、放音、唤醒都在语音服务里做，所以只要服务在跑，界面关着也能喊它。
 * 主窗口启动时：开了唤醒就把服务拉起来、把设置推过去（见 App.vue）。
 */
import { invoke } from '@tauri-apps/api/core'
import { LazyStore } from '@tauri-apps/plugin-store'
import { locale } from '@/i18n'

export const VOICE_BASE = 'http://127.0.0.1:18733'

export type AssistantCfg = {
  name: string
  /** 实际发给模型的人设（由 personaPreset / personaCustom 决定，别直接改） */
  persona: string
  /** 用哪套人设：内置的 id，或 'custom' */
  personaPreset: string
  /** 自定义人设。切回内置的不清掉，再切回来还在 */
  personaCustom: string
  /** 只用 GPT-SoVITS（Kokoro 太难听，CosyVoice / Qwen3-TTS 开口太慢，2026-10-20 都下掉了）；语音服务那边还认 kokoro，留着字段 */
  engine: 'gsv' | 'kokoro'
  voice: string
  speed: number
  volume: number
  model: string
  /** 后台听唤醒词 */
  wake: boolean
  wakeWord: string
  /** 英文唤醒词（另一个只认英文的模型在听），留空就只用中文的 */
  wakeWordEn: string
  /** 允许它上网查 */
  search: boolean
  /** 默认用哪种语言回答（对方用另一种语言问也照这个答，除非明确要求换）；第一次跟随软件的界面语言 */
  replyLang: 'zh' | 'en'
  /** 回答前先想一想（更聪明，慢一两秒；只对本机模型有用） */
  think: boolean
  /** 聊天用哪个大模型：local = 本机 Ollama（「大模型」设置里选的那个）；online = OpenAI 兼容的在线接口 */
  llm: 'local' | 'online'
  /** 在线接口地址，比如 https://api.deepseek.com */
  apiUrl: string
  apiKey: string
  /** 在线模型名，比如 deepseek-chat */
  apiModel: string
  /** 游戏模式：全屏游戏 / 指定程序在前台时助手歇着（见 lib/gameMode.ts） */
  gameMode: boolean
  /** 这些程序在前台也算游戏（exe 文件名，比如 LeagueClient.exe） */
  gameApps: string[]
  /** 只响应主人的声音（唤醒和说话都先比对声纹，要先在设置里录过主人声音） */
  ownerOnly: boolean
  /** 它说话时主人开口就打断它（靠声纹认出是主人，不会被它自己的声音打断） */
  bargeIn: boolean
}

/** 几套人设共用的说话规矩 */
const PERSONA_RULES = `
- 像平时说话一样自然，不要播音腔。
- 回答要短：一般一到三句话。不要列表、不要标题、不要 markdown、不要表情符号。
- 问到事实（年龄、日期、谁是谁）就直接给答案。不知道或不确定就直说。
- 现在是 {now}。`

/** 内置人设。{name} 换成唤醒词（它的名字），{now} 换成现在的日期时间 */
export const PERSONAS: { id: string; label: string; text: string }[] = [
  { id: 'gentle', label: '温柔', text: `你是 {name}，一个私人语音助手，温柔可爱的女生，说话亲切，不刻意卖萌。${PERSONA_RULES}` },
  { id: 'lively', label: '元气', text: `你是 {name}，一个私人语音助手，活泼开朗、有点俏皮的女生，说话轻快有精神，偶尔开个小玩笑。${PERSONA_RULES}` },
  { id: 'butler', label: '管家', text: `你是 {name}，一个私人语音助手，像沉稳可靠的管家：礼貌、冷静、办事利落，说话简洁，不多废话。${PERSONA_RULES}` },
  { id: 'buddy', label: '损友', text: `你是 {name}，一个私人语音助手，像认识很多年的老朋友：嘴上爱吐槽两句，但心是软的，该帮忙时认真帮。不说脏话，不真的伤人。${PERSONA_RULES}` },
]

export const DEFAULT_PERSONA = PERSONAS[0].text

/** 按选的人设算出实际发给模型的那一段 */
export function resolvePersona(c: Pick<AssistantCfg, 'personaPreset' | 'personaCustom'>): string {
  if (c.personaPreset === 'custom') return c.personaCustom.trim() || DEFAULT_PERSONA
  return (PERSONAS.find(p => p.id === c.personaPreset) ?? PERSONAS[0]).text
}

export const ASSISTANT_DEFAULTS: AssistantCfg = {
  name: '小精灵', persona: PERSONAS[2].text, personaPreset: 'butler', personaCustom: '', engine: 'gsv', voice: 'sweet', speed: 1, volume: 1.4,
  model: 'qwen3.5:9b', wake: true, wakeWord: '小精灵', wakeWordEn: 'HEY FAIRY', search: true, think: true, replyLang: 'zh', llm: 'local', apiUrl: 'https://api.deepseek.com', apiKey: '', apiModel: 'deepseek-chat', gameMode: true, gameApps: [], ownerOnly: false, bargeIn: true,
}

const store = new LazyStore('assistant.json')
// 存档键带版本：人设里的 {date} 换成了 {now}（带上几点几分），旧存档不再带过来
const KEY = 'config.v3'

export async function loadAssistantCfg(): Promise<AssistantCfg> {
  await store.init()
  const c = { ...ASSISTANT_DEFAULTS, ...((await store.get<Partial<AssistantCfg>>(KEY)) ?? {}) }
  // 旧存档没有人设选择：旧版默认的（里面写死了作者的名字，XGTools 是开源给别人用的）换成内置温柔，
  // 改过的当成自定义留着
  if (!c.personaCustom && !(await store.get<Partial<AssistantCfg>>(KEY))?.personaPreset) {
    const old = c.persona.trim()
    const builtin = /^你是 \{name\}，([^，]{1,8}的私人助手|一个私人语音助手，温柔可爱的女生)/.test(old) || PERSONAS.some(p => p.text === old)
    if (!builtin && old) { c.personaCustom = old; c.personaPreset = 'custom' }
  }
  // 默认回复语言：第一次（存档里还没有）跟随软件界面语言，之后就按用户自己选的
  const saved = await store.get<Partial<AssistantCfg>>(KEY)
  if (!saved?.replyLang) c.replyLang = locale.value === 'en' ? 'en' : 'zh'
  // 名字就是唤醒词，不再分开填
  c.name = c.wakeWord
  // 「极速」那个音色（Kokoro）太难听，下掉了
  c.engine = 'gsv'
  c.persona = resolvePersona(c)
  return c
}

export async function saveAssistantCfg(c: AssistantCfg) {
  c.name = c.wakeWord
  c.persona = resolvePersona(c)
  await store.set(KEY, c)
  await store.save()
  await pushCfg(c)
}

export async function pushCfg(c: AssistantCfg) {
  const r = await fetch(`${VOICE_BASE}/config`, { method: 'POST', body: JSON.stringify(c) }).then(r => r.json()).catch(() => null)
  if (r && !r.ok) throw new Error(r.error)
}

/** 把语音服务拉起来，等它能响应；起不来返回错误文字 */
export async function ensureVoiceService(c: AssistantCfg): Promise<string> {
  try {
    await invoke('voice_start')
  }
  catch (e) {
    return String(e)
  }
  for (let i = 0; i < 160; i++) {
    try {
      const r = await fetch(`${VOICE_BASE}/health`)
      if (r.ok) {
        await pushCfg(c)
        return ''
      }
    }
    catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  return '语音服务没起来'
}
