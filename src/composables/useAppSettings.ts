/**
 * 全应用共享的设置状态(模块级单例)。
 * App.vue / TitleBar.vue / Settings.vue 引的是同一个 reactive 对象,
 * 所以设置页一改,侧栏和顶栏立刻跟着变,不需要事件通道。
 *
 * 持久化到 settings.json —— 该文件已被按键显示等功能使用,所以只读写自己的键,不整体覆盖。
 */
import { reactive, watch } from 'vue'
import { LazyStore } from '@tauri-apps/plugin-store'

// 没有 'blur':apply_blur 走的是 Win11 已废弃的 ACCENT_ENABLE_BLURBEHIND,渲染成一层压死的暗色,不可用
export type BlurKind = 'none' | 'mica' | 'acrylic'

export type AppSettings = {
  /** 配置格式版本。语义变了(而不只是加字段)时 +1,并在 loadSettings 里做一次性迁移。 */
  v: number
  blurKind: BlurKind
  /** 亚克力/模糊的不透明度 0~100:越小越通透,越大越接近实心 */
  blurOpacity: number
  sidebarOrder: string[]
  sidebarHidden: string[]
  /** 条目归哪一组的用户覆盖(id → 'tool' | 'config')。空表示用代码里的默认分组。 */
  sidebarGroups: Record<string, string>
}

const SETTINGS_VERSION = 2

const DEFAULTS: AppSettings = {
  v: SETTINGS_VERSION,
  blurKind: 'none',
  blurOpacity: 40,
  sidebarOrder: [],
  sidebarHidden: [],
  sidebarGroups: {},
}

export const settings = reactive<AppSettings>({ ...DEFAULTS })

/** 首帧还没读到磁盘时为 false —— 用来避免「默认值先渲染一下再跳到真实值」的闪烁。 */
export const settingsReady = reactive({ value: false })

const KEY = 'app_settings'
let store: LazyStore | null = null
let loaded = false

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
    // 旧存档可能选的是已移除的高斯模糊,迁到亚克力,免得停在一个界面上不存在的选项
    if ((settings.blurKind as string) === 'blur') settings.blurKind = 'acrylic'
    settingsReady.value = true
    startAutoSave()
  }
}

let saveTimer: number | undefined
function startAutoSave() {
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
