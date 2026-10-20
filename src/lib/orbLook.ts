/**
 * 语音助手那颗球的样子：待命时、说话时各自的颜色 / 自转 / 起伏，粒子飘散快慢，想事情时自旋多快。
 * 一份响应式的全局状态，助手页的小设置和球都直接用它，改了马上生效、顺手存盘。
 */
import { reactive, ref, watch } from 'vue'
import { LazyStore } from '@tauri-apps/plugin-store'

export type OrbMood = {
  /** 外壳粒子颜色 */
  shell: string
  /** 内核粒子颜色 */
  core: string
  /** 自转快慢（弧度 / 秒） */
  spin: number
  /** 起伏：说话时跟着声音胀缩的幅度，1 = 默认 */
  swell: number
  /** 亮度 */
  bright: number
}

export type OrbLook = {
  idle: OrbMood
  talk: OrbMood
  /** 粒子飘散 / 流动的快慢，1 = 默认 */
  drift: number
  /** 想事情时自旋多快 */
  thinkSpin: number
}

export const ORB_DEFAULTS: OrbLook = {
  idle: { shell: '#ffd28f', core: '#ffd28f', spin: 0.15, swell: 0, bright: 0.4 },
  talk: { shell: '#bfe0ff', core: '#bfe0ff', spin: 0.7, swell: 2.2, bright: 0.65 },
  drift: 3,
  thinkSpin: 2.3,
}

const clone = (l: OrbLook): OrbLook => JSON.parse(JSON.stringify(l))

export const orbLook = reactive<OrbLook>(clone(ORB_DEFAULTS))

const store = new LazyStore('assistant.json')
let loaded: Promise<void> | null = null

export function loadOrbLook() {
  return (loaded ??= (async () => {
    await store.init()
    const saved = await store.get<Partial<OrbLook>>('orb.v1')
    if (saved) {
      Object.assign(orbLook.idle, saved.idle ?? {})
      Object.assign(orbLook.talk, saved.talk ?? {})
      if (typeof saved.drift === 'number') orbLook.drift = saved.drift
      if (typeof saved.thinkSpin === 'number') orbLook.thinkSpin = saved.thinkSpin
      // 亮度上限改成了 100%
      orbLook.idle.bright = Math.min(1, orbLook.idle.bright)
      orbLook.talk.bright = Math.min(1, orbLook.talk.bright)
    }
    let t = 0
    watch(orbLook, () => {
      window.clearTimeout(t)
      t = window.setTimeout(async () => { await store.set('orb.v1', clone(orbLook)); await store.save() }, 400)
    }, { deep: true })
  })())
}

export function resetOrbLook() {
  Object.assign(orbLook, clone(ORB_DEFAULTS))
}

/**
 * 调设置时让球当场演示：鼠标在「待命时」那块 → 球切到待命的样子；在「对话时」那块 → 对话的样子，
 * 并且假装在说话（一胀一缩，看得到起伏）；在「思考自旋」那行 → 演示思考时的自旋。移开就恢复。
 */
export const orbPreview = ref<null | 'idle' | 'talk' | 'think'>(null)
