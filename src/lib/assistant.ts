/**
 * 语音助手的设置和本机语音服务（voice/server.py）的连接。
 *
 * 收音、放音、唤醒都在语音服务里做，所以只要服务在跑，界面关着也能喊它。
 * 主窗口启动时：开了唤醒就把服务拉起来、把设置推过去（见 App.vue）。
 */
import { invoke } from '@tauri-apps/api/core'
import { LazyStore } from '@tauri-apps/plugin-store'

export const VOICE_BASE = 'http://127.0.0.1:18733'

export type AssistantCfg = {
  name: string
  persona: string
  engine: 'gsv' | 'kokoro'
  voice: string
  speed: number
  volume: number
  model: string
  /** 后台听唤醒词 */
  wake: boolean
  wakeWord: string
  /** 允许它上网查 */
  search: boolean
  /** 游戏模式：全屏游戏 / 指定程序在前台时助手歇着（见 lib/gameMode.ts） */
  gameMode: boolean
  /** 这些程序在前台也算游戏（exe 文件名，比如 LeagueClient.exe） */
  gameApps: string[]
}

export const DEFAULT_PERSONA = `你是 {name}，夏戈的私人助手，一个温柔可爱的女生。
- 用简体中文回答，像平时说话一样自然、亲切，不要播音腔，不要刻意卖萌。
- 回答要短：一般一到三句话，像朋友聊天。不要列表、不要标题、不要 markdown、不要表情符号。
- 问到事实（年龄、日期、谁是谁）就直接给答案；算年龄要按今天的日期算。不知道或不确定就直说。
- 现在是 {now}。`

export const ASSISTANT_DEFAULTS: AssistantCfg = {
  name: 'Fairy', persona: DEFAULT_PERSONA, engine: 'gsv', voice: 'gentle', speed: 1.1, volume: 1.8,
  model: 'qwen3.5:9b', wake: true, wakeWord: '小精灵', search: true, gameMode: true, gameApps: [],
}

const store = new LazyStore('assistant.json')
// 存档键带版本：人设里的 {date} 换成了 {now}（带上几点几分），旧存档不再带过来
const KEY = 'config.v3'

export async function loadAssistantCfg(): Promise<AssistantCfg> {
  await store.init()
  return { ...ASSISTANT_DEFAULTS, ...((await store.get<Partial<AssistantCfg>>(KEY)) ?? {}) }
}

export async function saveAssistantCfg(c: AssistantCfg) {
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
