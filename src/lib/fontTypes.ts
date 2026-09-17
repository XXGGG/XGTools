/** 字体库页面用到的数据形状。字段跟 src-tauri/src/font_commands.rs 里的一一对应 */

/** 这份字体是谁装的 */
export type FontSource = 'windows' | 'machine' | 'user' | 'xgcut' | 'xgtools'

/** 协议分档，见 font_license.rs 开头那张表 */
export type Tier = 'open' | 'free' | 'unknown' | 'system' | 'paid'

/** 某一种用途能不能用 */
export type Mark = 'yes' | 'warn' | 'no' | 'ask'

export interface Verdict {
  tier: Tier
  license: string
  game: Mark
  video: Mark
  print: Mark
  notes: string[]
}

export interface Face {
  path: string
  /** 用户名那段换成了 %LOCALAPPDATA%，截图发出去不漏隐私 */
  displayPath: string
  index: number
  style: string
  weight: number
  italic: boolean
  fullName: string
  fullNameZh: string
  postscript: string
  legacyFamily: string
  source: FontSource
  disabled: boolean
  bytes: number
}

export interface Family {
  key: string
  name: string
  nameEn: string
  source: FontSource
  manageable: boolean
  disabled: boolean
  faces: Face[]
  verdict: Verdict
  licenseText: string
  licenseUrl: string
  copyright: string
  manufacturer: string
  designer: string
  vendorUrl: string
  sc: boolean
  tc: boolean
  kana: boolean
  hangul: boolean
  latin: boolean
  symbol: boolean
  variable: boolean
  bytes: number
  catalog: string | null
}

export interface Pack {
  id: string
  name: string
  latin: string
  note: string
  uses: string[]
  license: string
  licenseUrl: string
  home: string
  url: string
  sizeMb: number
  families: string[]
  px: number[]
  sc: boolean
  tc: boolean
  kana: boolean
  latinOk: boolean
  pick: string
  /** xgtools = 字体库装的；xgcut = XGCut 装的；null = 我们俩都没装（系统里可能有） */
  installedBy: 'xgtools' | 'xgcut' | null
  files: string[]
}

export interface TrashEntry {
  id: string
  label: string
  time: number
  bytes: number
  items: { kind: string; orig: string; stored: string }[]
}

export interface Coverage {
  level1: number
  level1Total: number
  all: number
  allTotal: number
  kana: number
  kanaTotal: number
  level1Missing: string
}

/** 用途小类的顺序（和 font_catalog.rs 的 USES 一致），按大类分三组 */
export const USE_GROUPS: { id: 'game' | 'video' | 'ps'; uses: string[] }[] = [
  { id: 'game', uses: ['game-pixel', 'game-ui', 'game-title'] },
  { id: 'video', uses: ['video-sub', 'video-cover', 'video-title'] },
  { id: 'ps', uses: ['ps-brush', 'ps-serif', 'ps-latin'] },
]

export const TIERS: Tier[] = ['open', 'free', 'unknown', 'system', 'paid']

/** 协议分档的颜色。语义色，跟应用主题色分开 */
export const TIER_COLOR: Record<Tier, string> = {
  open: '#22a55b',
  free: '#d99a1e',
  unknown: '#8a8f98',
  system: '#e0702a',
  paid: '#dc4040',
}

export const MARK_COLOR: Record<Mark, string> = {
  yes: '#22a55b',
  warn: '#d99a1e',
  no: '#dc4040',
  ask: '#8a8f98',
}

export const MARK_ICON: Record<Mark, string> = {
  yes: 'icon-[lucide--circle-check]',
  warn: 'icon-[lucide--triangle-alert]',
  no: 'icon-[lucide--circle-x]',
  ask: 'icon-[lucide--circle-help]',
}
