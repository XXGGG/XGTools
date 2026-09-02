/**
 * 全应用共享的设置状态(模块级单例)。
 * App.vue / TitleBar.vue / Settings.vue 引的是同一个 reactive 对象,
 * 所以设置页一改,侧栏和顶栏立刻跟着变,不需要事件通道。
 *
 * 持久化到 settings.json —— 该文件已被按键显示等功能使用,所以只读写自己的键,不整体覆盖。
 */
import { reactive, watch } from 'vue'
import { LazyStore } from '@tauri-apps/plugin-store'
import { invoke } from '@tauri-apps/api/core'
import { detectLocale, setLocale, type Locale } from '@/i18n'

// 没有 'blur':apply_blur 走的是 Win11 已废弃的 ACCENT_ENABLE_BLURBEHIND,渲染成一层压死的暗色,不可用
export type BlurKind = 'none' | 'mica' | 'acrylic'

export type AppSettings = {
  /** 配置格式版本。语义变了(而不只是加字段)时 +1,并在 loadSettings 里做一次性迁移。 */
  v: number
  /** 界面语言。'auto' = 跟随系统(每次启动重新检测),否则用用户选定的那个。 */
  language: Locale | 'auto'
  /** 主题。'auto' = 跟随系统深浅色,并在系统切换时实时跟着变。 */
  theme: ThemeMode
  blurKind: BlurKind
  /** 亚克力/模糊的不透明度 0~100:越小越通透,越大越接近实心 */
  blurOpacity: number
  sidebarOrder: string[]
  sidebarHidden: string[]
  /**
   * 启动时打开哪一页。空串 = 侧栏上排第一个没被隐藏的。
   *
   * 存的是页面 id 而不是序号 —— 序号会被「调换顺序」和「隐藏某一页」搞乱,
   * 而那两件事用户随时在做。
   */
  startPage: string
  /** 条目归哪一组的用户覆盖(id → 'tool' | 'config')。空表示用代码里的默认分组。 */
  sidebarGroups: Record<string, string>

  // ── 智能体页 ──
  /** 会话侧栏宽度(px)。用户可以拖,写回这里。范围由 AGENT_SIDEBAR 约束。 */
  agentSidebarWidth: number
  /** 工作台里正文栏放中间还是对话放中间。项目可以单独覆盖 */
  agentLayout: 'doc-center' | 'chat-center'
  /**
   * 靠右那一栏的宽度(px)。工作台里总有一栏铺满、一栏定宽,定宽的永远是靠右那个,
   * 所以换边之后拖的还是这一个数 —— 两栏各存一份的话,一换边宽度就跳。
   */
  agentDocWidth: number
  /** 会话列表里那两区收起来了没。记着,不然每次进来都要再收一次 */
  agentPinnedFold: boolean
  agentCasualFold: boolean
  /** 空态那句招呼语。留空就用当前语言的默认文案 —— 存空串而不是存默认值,
   *  否则切语言时会被钉死在设置那天的那个语种上。 */
  agentGreeting: string
  /** 聊天区外观:'card' 和侧栏一样是张浮空卡片;'flat' 直接铺在窗口材质上,更透。 */
  agentChatSurface: ChatSurface

  // ── 笔记页 ──
  vaultTreeWidth: number
  vaultChatWidth: number
  /**
   * 图片存哪儿。三种,对齐 Obsidian:
   *
   * - `subfolder` 笔记同级的子文件夹(默认,目录名见 vaultAttachDir)
   * - `note`     直接和笔记并排
   * - `fixed`    固定的一个文件夹(相对库根,路径见 vaultAttachDir)
   *
   * 默认走子文件夹:图跟着笔记走,搬一篇笔记时图就在旁边,不会搬完变成一堆红叉。
   */
  vaultAttachMode: 'subfolder' | 'note' | 'fixed'
  /** 附件目录名。`note` 模式下用不上 */
  vaultAttachDir: string
  /**
   * 附件目录在文件树里藏起来(默认藏)。
   *
   * 那里面全是机器生成的文件名,摊在树上只会挤掉真正的笔记 ——
   * Obsidian 用户装 Iconize 之类的插件也多半是为了让它不碍眼。
   * 想翻的话关掉这个开关就行,东西一直都在磁盘上。
   */
  vaultHideAttachDir: boolean
  /**
   * 删除笔记时送去哪个回收站。
   *
   * 默认库内(`<库根>/.trash/`):**只有库内那份我们才列得出来、还原得回原位**,
   * 系统回收站是操作系统的东西,里面混着全机器的删除记录,跟「这个库删了什么」
   * 对不上。库内回收站还跟着库一起同步,换台机器打开同一个库,删掉的还在。
   */
  vaultTrashToSystem: boolean
  /** 正文字体。档位见 VAULT_FONTS */
  vaultFont: VaultFont
  /**
   * 笔记的主题色(十六进制)。复选框、选中文字的高亮、链接都吃这个色。
   *
   * 单独一个色,不跟应用的 --primary 走:应用主色是中性的界面色(深色下接近白),
   * 拿它当正文强调色会糊成一片;Obsidian 也是把这个当独立设置的。
   */
  vaultAccent: string
  /** 正文字号(px)。范围见 VAULT_FONT_SIZE —— 太小看不清、太大一行放不下几个字 */
  vaultFontSize: number
  /** 正文是否铺满整栏(全局默认)。关掉时像 Obsidian 那样收窄并居中 */
  vaultFullWidth: boolean
  /**
   * 单篇笔记的宽度覆盖。键是文件相对路径,没有这一项就跟随上面那个全局默认。
   *
   * 存在我们自己的设置里,**不写进笔记的 frontmatter** —— 那会改动用户的文件,
   * 和「打开不重写」这条原则冲突。
   */
  vaultPageWidth: Record<string, 'wide' | 'narrow'>
  /** 右边那一栏开着没有。现在只有智能体会占它,大纲改成贴右缘的悬浮层了 */
  vaultSidePanel: 'none' | 'chat'
  /**
   * 标题、引用这些块要不要上色。
   *
   * 关掉就全是正文色,只靠字号和粗细区分层级 —— 有人就喜欢这种「一片白」的干净,
   * 也有人觉得那样长文里根本找不到分节在哪。所以给开关,不替谁做决定。
   * 上色用的是笔记主题色的深浅变体,不是另起一套彩虹,免得整页花掉。
   */
  vaultColorHeadings: boolean
  /** 正文底下那条状态栏(字数/字符/行数)。不想要就关掉 */
  vaultStatusBar: boolean
  /** 拼写检查。默认关 —— 中文笔记里满屏红波浪线比不检查还烦 */
  vaultSpellcheck: boolean
  /**
   * 贴进来的图自动转 WebP。
   *
   * 手机截图动辄 3~5MB PNG,转完常常小十倍而肉眼看不出差别。
   * 动图和 SVG 不碰,转完反而更大的也会留原图。
   */
  vaultWebp: boolean
  vaultTreeOpen: boolean
}

/** 会话侧栏可拖的范围。maxRatio 是「最多占窗口宽的几成」—— 光设 max 挡不住小窗口下把聊天区挤没。 */
/** 正文字号的可调范围。给上下限是因为两头都不可用:再小看不清,再大一行放不下几个字 */
export const VAULT_FONT_SIZE = { min: 13, max: 22, step: 1, def: 16 } as const

/**
 * 正文字体的档位。
 *
 * 每一档都配了英文和中文两边:只挑中文的话英文会掉进默认无衬线,
 * 一句话里两种气质,比不换还难看。
 */
export const VAULT_FONTS = ['default', 'dengxian', 'hand', 'comic', 'round'] as const

export type VaultFont = typeof VAULT_FONTS[number]

/**
 * 各档位的字体栈。**编辑器和设置页的预览必须是同一份** ——
 * 两边各写一份的话,预览里看着是一种字,点进笔记又是另一种。
 *
 * 每档都写死了英文和中文两边:只换中文的话英文会掉进默认无衬线,
 * 一句话里两种气质,比不换还难看。后三档的中文是随包附带的
 * (见 style.css 里的 @font-face),不看系统装了什么。
 */
/*
  后三档都是「英文一款 + 中文一款」配对着来的。

  中文一律配小赖字体(Xiaolai) —— 它和这三款英文体是 Excalidraw 官方搭在一起用的,
  字形粗细、圆角、倾斜都对得上。以前那版英文用 Caveat、中文掉到系统楷体,
  一行字里两种笔迹,怎么调都别扭,所以撤掉过一次。

  字体文件和画布共用 public/excalidraw/fonts/ 那一份,分片信息在
  public/fonts/handwriting.css(由 scripts/gen-hand-font-css.mjs 生成)。
  中文按 Unicode 区间切了 205 片,只有真正用到的那几片会下载。

  授权:Excalifont / Nunito / 小赖 都是 SIL OFL 1.1,Comic Shanns 是 MIT,
  四款都允许随软件打包分发。
*/
export const VAULT_FONT_STACK: Record<VaultFont, string> = {
  default: "'Inter', 'Microsoft YaHei', system-ui, sans-serif",
  dengxian: "'DengXian', '等线', 'Microsoft YaHei', sans-serif",
  hand: "'Excalifont', 'Xiaolai', cursive",
  comic: "'ComicShanns', 'Xiaolai', cursive",
  round: "'Nunito', 'Xiaolai', sans-serif",
}

/**
 * 笔记主题色的备选。第一个是默认 —— Obsidian 自己那个紫(hsl 254 80% 68%)。
 *
 * 给一组固定色而不是取色器:系统取色器是原生控件,和界面对不上,而且真让人
 * 随便选,选出低对比度的颜色时勾和高亮就看不清了。这几个都验证过深浅色都能看。
 */
export const VAULT_ACCENTS = [
  '#8b6cef', '#4f8ff7', '#2fb8a8', '#4caf50', '#e8913a', '#e05780',
] as const

export const AGENT_SIDEBAR = { min: 200, max: 420, minChat: 460 } as const

/** 正文栏能拖到多宽。minChat 是留给对话的下限 —— 正文再宽也不能把对话挤没 */
export const AGENT_DOC = { min: 320, max: 900, minChat: AGENT_SIDEBAR.minChat } as const

export type ChatSurface = 'card' | 'flat'

const SETTINGS_VERSION = 2

const DEFAULTS: AppSettings = {
  v: SETTINGS_VERSION,
  language: 'auto',
  theme: 'auto',
  blurKind: 'none',
  blurOpacity: 40,
  sidebarOrder: [],
  sidebarHidden: [],
  startPage: '',
  sidebarGroups: {},
  agentSidebarWidth: 240,
  agentLayout: 'doc-center',
  agentDocWidth: 448,
  agentPinnedFold: false,
  agentCasualFold: false,
  agentGreeting: '',
  agentChatSurface: 'card',
  vaultTreeWidth: 260,
  vaultChatWidth: 320,
  vaultFont: 'default' as VaultFont,
  vaultAccent: VAULT_ACCENTS[0],
  vaultTrashToSystem: false,
  vaultAttachMode: 'subfolder' as 'subfolder' | 'note' | 'fixed',
  vaultAttachDir: 'attachments',
  vaultHideAttachDir: true,
  vaultFontSize: 16,
  vaultFullWidth: false,
  vaultPageWidth: {},
  vaultSidePanel: 'chat' as 'none' | 'chat',
  vaultColorHeadings: true,
  vaultStatusBar: true,
  vaultSpellcheck: false,
  vaultWebp: true,
  vaultTreeOpen: true,
}

export const settings = reactive<AppSettings>({ ...DEFAULTS })

/** 首帧还没读到磁盘时为 false —— 用来避免「默认值先渲染一下再跳到真实值」的闪烁。 */
export const settingsReady = reactive({ value: false })

const KEY = 'app_settings'
let store: LazyStore | null = null
let loaded = false

/**
 * 强制重读一次设置。
 *
 * loadSettings 有 `if (loaded) return` 的一次性守卫,再调是空转 —— 对主窗口没问题
 * (它自己改自己),但**常驻的附属窗口(命令面板、托盘菜单)是独立 webview,
 * 各有一份自己的 settings**,主界面里改了主题/材质它们一无所知,
 * 会一直停在启动那一刻的样子。那两扇窗每次显示前要调这个。
 */
export async function reloadSettings() {
  loaded = false
  await loadSettings()
}

export async function loadSettings() {
  if (loaded) return
  loaded = true
  try {
    store = new LazyStore('settings.json')
    await store.init()
    const saved = await store.get<Partial<AppSettings>>(KEY)
    if (saved && typeof saved === 'object') {
      // 逐键合并:磁盘上没有的键保持默认,磁盘上多出来的旧键丢弃
      for (const k of Object.keys(DEFAULTS) as (keyof AppSettings)[]) {
        if (saved[k] !== undefined) (settings as any)[k] = saved[k]
      }
    }
  } catch (e) {
    console.error('读取设置失败,使用默认值:', e)
  } finally {
    // v1 → v2:blurOpacity 的含义从「卡片不透明度」改成「底面不透明度」,
    // 沿用旧值会让底面几乎不透明、看着像特效失效。语义变了就重置成新默认值。
    if (settings.v !== SETTINGS_VERSION) {
      settings.blurOpacity = DEFAULTS.blurOpacity
      settings.v = SETTINGS_VERSION
    }
    settings.blurOpacity = Math.min(100, Math.max(0, settings.blurOpacity))
    if (!/^#[0-9a-fA-F]{6}$/.test(settings.vaultAccent)) settings.vaultAccent = DEFAULTS.vaultAccent
    // 旧存档里可能是已经不存在的档位,落回默认,免得正文字体变成一串空引号
    if (!VAULT_FONTS.includes(settings.vaultFont)) settings.vaultFont = DEFAULTS.vaultFont
    settings.vaultFontSize = Math.min(VAULT_FONT_SIZE.max,
      Math.max(VAULT_FONT_SIZE.min, Math.round(settings.vaultFontSize || VAULT_FONT_SIZE.def)))
    settings.agentSidebarWidth = Math.min(AGENT_SIDEBAR.max,
      Math.max(AGENT_SIDEBAR.min, Math.round(settings.agentSidebarWidth)))
    settings.agentDocWidth = Math.min(AGENT_DOC.max,
      Math.max(AGENT_DOC.min, Math.round(settings.agentDocWidth || DEFAULTS.agentDocWidth)))
    // 旧存档可能选的是已移除的高斯模糊,迁到亚克力,免得停在一个界面上不存在的选项
    if ((settings.blurKind as string) === 'blur') settings.blurKind = 'acrylic'
    // 语言:选了 auto 就每次启动重新看系统语言,否则用存档里选定的那个
    setLocale(settings.language === 'auto' ? detectLocale() : settings.language)
    applyTheme()
    watchSystemTheme()
    settingsReady.value = true
    startAutoSave()
  }
}

/*
  **只读窗口不许回写设置。**

  命令面板、托盘菜单都是独立 webview,各自跑一份这个模块、各自持有一份
  settings。如果它们也注册自动保存,就成了"后写的赢":任何一个附属窗口
  在旧值上触发一次保存,都会把主窗口刚改的东西**整份盖掉** ——
  而且是静默的,用户只会觉得"我改的设置自己变回去了"。

  它们只消费设置,不产生设置,所以在 loadSettings 之前调这个把回写关掉。
*/
let persistEnabled = true
export function disableSettingsPersist() { persistEnabled = false }

let saveTimer: number | undefined
function startAutoSave() {
  if (!persistEnabled) return
  watch(settings, () => {
    if (!store) return
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(async () => {
      try {
        await store!.set(KEY, { ...settings })
        await store!.save()
      } catch (e) {
        console.error('保存设置失败:', e)
      }
    }, 300)
  }, { deep: true })
}

/**
 * 各材质真正「有效」的不透明度上限。
 * 超过这个值材质就被染实了,看着跟没开特效一样 —— 亚克力大约到 50、云母到 20 就到头。
 * 所以滑块对用户永远是 0~100(行程完整、两种材质一致),内部再缩放到各自的可用区间。
 */
const KIND_MAX: Record<BlurKind, number> = { none: 0, mica: 20, acrylic: 50 }

/** 把当前设置写进 CSS 变量。样式那边只认 --vibrancy-alpha,换算集中在这里一处。 */
export function applyVibrancyVars() {
  const alpha = (settings.blurOpacity / 100) * (KIND_MAX[settings.blurKind] ?? 0)
  document.documentElement.style.setProperty('--vibrancy-alpha', alpha.toFixed(2))
}


export type ThemeMode = 'auto' | 'dark' | 'light'

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** 当前是否该用深色。auto 时读系统偏好。 */
export function isDarkNow(): boolean {
  if (settings.theme === 'dark') return true
  if (settings.theme === 'light') return false
  return window.matchMedia(DARK_QUERY).matches
}

/**
 * 把主题落到 DOM 上,并让窗口材质跟着换深浅。
 *
 * 不用 VueUse 的 useDark:它自带一套 localStorage 持久化,和我们的 settings.json
 * 就成了两个真相源,改一边另一边不知道。这里只认 settings.theme 一处。
 */
export function applyTheme() {
  const dark = isDarkNow()
  document.documentElement.classList.toggle('dark', dark)
  // 给下次启动的第一帧留个提示(index.html 里那段内联脚本读):settings.json 还没读出来
  // 的那几百毫秒,底和黑布也得是对的颜色。只是缓存,真相仍在 settings.json。
  try { localStorage.setItem('xg-theme', dark ? 'dark' : 'light') } catch { /* 存不了就下次再说 */ }
  void applyWindowEffect()   // 材质的深浅属性要跟着主题走
}

/**
 * 应用窗口背景材质。启动恢复、设置页改动、主题切换三处都走这里 ——
 * 散成几份迟早会不同步(深色属性就是最容易漏的那个)。
 *
 * 返回 null 表示成功,否则是错误消息。
 *
 * 注意 r/g/b/a 在 Win11 build >= 22523 上会被 DWM 忽略,仍然传是为了兼容老版本
 * 走 SetWindowCompositionAttribute 的那条路径。
 */
export async function applyWindowEffect(
  kind: BlurKind = settings.blurKind,
  /** 目标窗口。命令面板要跟主窗口用同一套材质,所以这里能指定标签。 */
  label?: string,
): Promise<string | null> {
  const dark = isDarkNow()
  const tint = dark ? [10, 10, 12] : [246, 246, 248]
  try {
    await invoke('set_window_effect', {
      kind,
      r: tint[0], g: tint[1], b: tint[2],
      a: Math.round((settings.blurOpacity / 100) * 255),
      dark,
      label,
    })
    return null
  } catch (e: any) {
    // 把错误消息回传而不是吞掉:设置页要把具体原因显示给用户(比如"云母不可用")
    return String(e?.message ?? e)
  }
}

/** 系统深浅色变化时,只有 auto 模式需要跟着动。 */
export function watchSystemTheme() {
  window.matchMedia(DARK_QUERY).addEventListener('change', () => {
    if (settings.theme === 'auto') applyTheme()
  })
}
