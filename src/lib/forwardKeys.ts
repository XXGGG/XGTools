/**
 * 自己窗口里的按键，补发一份 input-event。
 *
 * 按键显示和桌宠都靠后端 rdev 的全局键盘钩子发 input-event。但焦点在 XGTools 自己的窗口里
 * （比如在笔记里打字）时，钩子收不到这些键 —— 2026-10-12 用户发现在别处打字桌宠有反应、
 * 在 XGTools 笔记里没有。所以这里在网页层接 keydown/keyup，按 rdev 的键名补发同一个事件。
 *
 * 只有本窗口有焦点时 DOM 才收得到键，跟 rdev 不会同时来，不会重复。
 */
import { emit } from '@tauri-apps/api/event'

/** DOM 的 KeyboardEvent.code → rdev 的 Key 名（Debug 输出） */
const RENAME: Record<string, string> = {
  Enter: 'Return', NumpadEnter: 'KpReturn', AltLeft: 'Alt', AltRight: 'AltGr',
  ArrowUp: 'UpArrow', ArrowDown: 'DownArrow', ArrowLeft: 'LeftArrow', ArrowRight: 'RightArrow',
  Period: 'Dot', Semicolon: 'SemiColon', BracketLeft: 'LeftBracket', BracketRight: 'RightBracket',
  Backslash: 'BackSlash', Backquote: 'BackQuote', MetaLeft: 'MetaLeft', MetaRight: 'MetaRight',
}

function rdevName(code: string) {
  if (RENAME[code]) return RENAME[code]
  const digit = /^Digit(\d)$/.exec(code)
  if (digit) return `Num${digit[1]}`
  return code
}

export function forwardKeysToOverlays() {
  const send = (event_type: string) => (e: KeyboardEvent) => {
    if (!e.code) return
    void emit('input-event', { event_type, key: rdevName(e.code) }).catch(() => {})
  }
  window.addEventListener('keydown', send('KeyPress'), true)
  window.addEventListener('keyup', send('KeyRelease'), true)
}
