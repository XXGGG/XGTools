/**
 * 游戏模式：全屏玩游戏（或者前台是你指定的程序）时，让语音助手歇着 ——
 * 不听唤醒词、不录音、本地大模型也不回话，免得吃显卡、免得打游戏时被它误唤醒。
 *
 * 每 2 秒问一次后端前台是谁、是不是全屏（game_mode.rs）。
 * 浏览器、视频播放器全屏不算游戏：一起看视频时还要能喊它。
 */
import { invoke } from '@tauri-apps/api/core'
import { loadAssistantCfg, VOICE_BASE } from '@/lib/assistant'

/** 全屏了也不算游戏的程序（看视频、看图、开会） */
const NOT_GAMES = new Set([
  'msedge.exe', 'chrome.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'arc.exe', 'vivaldi.exe',
  'potplayermini64.exe', 'potplayermini.exe', 'vlc.exe', 'mpv.exe', 'mpc-hc64.exe', 'mpc-be64.exe',
  'qqmusic.exe', 'cloudmusic.exe', 'bilibili.exe', 'neteasecloudmusic.exe', 'iqiyi.exe', 'qqlive.exe',
  'powerpnt.exe', 'wps.exe', 'zoom.exe', 'teams.exe', 'explorer.exe', 'xgtools.exe',
])

let timer = 0
let paused = false

export function startGameMode() {
  if (timer) return
  timer = window.setInterval(() => void tick(), 2000)
  void tick()
}

async function tick() {
  const c = await loadAssistantCfg()
  let game = false
  if (c.gameMode) {
    const fg = await invoke<{ exe: string; fullscreen: boolean }>('foreground_info').catch(() => null)
    if (fg) {
      const listed = c.gameApps.map(a => a.trim().toLowerCase()).filter(Boolean)
      game = listed.includes(fg.exe) || (fg.fullscreen && !!fg.exe && !NOT_GAMES.has(fg.exe))
    }
  }
  if (game === paused) return
  const r = await fetch(`${VOICE_BASE}/pause`, { method: 'POST', body: JSON.stringify({ on: game }) }).catch(() => null)
  if (r?.ok) paused = game
}
