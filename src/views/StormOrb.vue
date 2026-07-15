<script setup lang="ts">
import { ref, reactive, watch, onUnmounted } from 'vue'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Slider } from '@/components/ui/slider'
import { ScrollArea } from '@/components/ui/scroll-area'

const orbFrame = ref<HTMLIFrameElement | null>(null)
const tab = ref('look')
const panelOpen = ref(true)
const expandBtn = ref(false)

type Patch = Record<string, number | string>

const params = reactive({
  color: '#d9e6ff', bg: 'transparent', density: '高',
  freq: 1.0, pull: 2.7, turb: 0.56, coreR: 0.5, coreFrac: 0.22, haloFrac: 0.28,
  shape: 2.0, warp: 0.0, warpFreq: 2.0, twist: 0.0,
  speed: 0.75, follow: 0.4, tilt: 0.32,
  sizeCore: 1.35, sizeShell: 1.0, sizeHalo: 0.85,
  brightCore: 0.55, brightShell: 0.42, brightHalo: 0.34,
  spinCore: 0.04, spinShell: 0.022, spinHalo: 0.012,
})

const P_SWATCHES = ['#d9e6ff', '#ffffff', '#38e1c0', '#6bffd8', '#7aa8ff', '#5a7cff',
  '#b388ff', '#e07bff', '#ff8fae', '#ff6b6b', '#ffd27a', '#9dff6b', '#ffb03a']
const B_COLORS = ['#000000', '#050506', '#0a0e14', '#0b1020', '#12061c', '#07140f', '#160b0b']

// 形态:按"全局 / 结构 / 内核层 / 外壳层 / 风沙层"分组
const SECTIONS = [
  { title: '全局', icon: 'icon-[lucide--settings-2]', items: [
    { key: 'speed', label: '速度', icon: 'icon-[lucide--gauge]', min: 0, max: 2.5, step: 0.01 },
    { key: 'follow', label: '窗口跟随', icon: 'icon-[lucide--move]', min: 0, max: 2, step: 0.01 },
    { key: 'tilt', label: '轴倾斜', icon: 'icon-[lucide--compass]', min: -0.9, max: 0.9, step: 0.02 },
    { key: 'freq', label: '结构大小', icon: 'icon-[lucide--layers]', min: 0.4, max: 2.4, step: 0.01 },
  ] },
  { title: '结构', icon: 'icon-[lucide--shapes]', items: [
    { key: 'pull', label: '球壳紧实', icon: 'icon-[lucide--shrink]', min: 0.8, max: 5, step: 0.01 },
    { key: 'turb', label: '风沙(湍流)', icon: 'icon-[lucide--wind]', min: 0, max: 1.4, step: 0.01 },
    { key: 'coreR', label: '内核壳大小', icon: 'icon-[lucide--circle]', min: 0.2, max: 0.8, step: 0.01 },
    { key: 'coreFrac', label: '内核壳占比', icon: 'icon-[lucide--pie-chart]', min: 0, max: 0.6, step: 0.01 },
    { key: 'haloFrac', label: '风沙占比', icon: 'icon-[lucide--sparkles]', min: 0, max: 0.6, step: 0.01 },
  ] },
  { title: '几何', icon: 'icon-[lucide--box]', items: [
    { key: 'shape', label: '形状(球↔多面)', icon: 'icon-[lucide--hexagon]', min: 0.6, max: 8, step: 0.05 },
    { key: 'warp', label: '表面起伏', icon: 'icon-[lucide--mountain]', min: 0, max: 0.5, step: 0.01 },
    { key: 'warpFreq', label: '起伏密度', icon: 'icon-[lucide--grip]', min: 0.5, max: 5, step: 0.1 },
    { key: 'twist', label: '扭转', icon: 'icon-[lucide--tornado]', min: -0.5, max: 0.5, step: 0.02 },
  ] },
  { title: '内核层', icon: 'icon-[lucide--circle-dot]', items: [
    { key: 'brightCore', label: '亮度', icon: 'icon-[lucide--sun]', min: 0.05, max: 1, step: 0.01 },
    { key: 'sizeCore', label: '颗粒', icon: 'icon-[lucide--grip]', min: 0.5, max: 3.5, step: 0.05 },
    { key: 'spinCore', label: '自转', icon: 'icon-[lucide--rotate-cw]', min: -0.15, max: 0.15, step: 0.005 },
  ] },
  { title: '外壳层', icon: 'icon-[lucide--circle]', items: [
    { key: 'brightShell', label: '亮度', icon: 'icon-[lucide--sun]', min: 0.05, max: 1, step: 0.01 },
    { key: 'sizeShell', label: '颗粒', icon: 'icon-[lucide--grip]', min: 0.5, max: 3.5, step: 0.05 },
    { key: 'spinShell', label: '自转', icon: 'icon-[lucide--rotate-cw]', min: -0.15, max: 0.15, step: 0.005 },
  ] },
  { title: '风沙层', icon: 'icon-[lucide--sparkles]', items: [
    { key: 'brightHalo', label: '亮度', icon: 'icon-[lucide--sun]', min: 0.05, max: 1, step: 0.01 },
    { key: 'sizeHalo', label: '颗粒', icon: 'icon-[lucide--grip]', min: 0.5, max: 3.5, step: 0.05 },
    { key: 'spinHalo', label: '自转', icon: 'icon-[lucide--rotate-cw]', min: -0.15, max: 0.15, step: 0.005 },
  ] },
] as const

// 精选预设(命名)+ 生成 250 个(参数组合的数学,类似 Wisp 的形态画廊)
function hslToHex(h: number, s: number, l: number): string {
  h /= 360
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h * 12) % 12
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(255 * c).toString(16).padStart(2, '0')
  }
  return '#' + f(0) + f(8) + f(4)
}
function rng(seed: number) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
const rd = (r: () => number, lo: number, hi: number, p = 2) => +(lo + (hi - lo) * r()).toFixed(p)
// 形态原型:决定几何骨架(球/八面/立方/凹星/瘤状/崎岖/扭转),让 250 个真正多维不同
const ARCH: any[] = [
  { shape: 2.0, warp: 0, twist: 0, pull: [2.2, 4.2], turb: [0.4, 0.85] },
  { shape: 1.0, warp: 0.05, twist: 0, pull: [3.0, 4.8], turb: [0.3, 0.55] },
  { shape: 4.8, warp: 0, twist: 0, pull: [3.2, 4.8], turb: [0.28, 0.5] },
  { shape: 0.8, warp: 0.06, twist: 0, pull: [3.0, 4.6], turb: [0.3, 0.55] },
  { shape: 2.0, warp: 0.34, twist: 0, pull: [2.6, 4.0], turb: [0.35, 0.6] },
  { shape: 2.6, warp: 0.46, twist: 0, pull: [2.6, 3.8], turb: [0.35, 0.6] },
  { shape: 2.0, warp: 0.1, twist: [0.18, 0.42], pull: [2.4, 3.6], turb: [0.4, 0.7] },
]
function genPresets(n: number, startIdx: number) {
  const out: any[] = []
  for (let i = 0; i < n; i++) {
    const r = rng((i * 2654435761) ^ 0x9e3779b9)
    const A = ARCH[i % ARCH.length]
    const color = hslToHex(Math.floor(r() * 360), 0.45 + 0.45 * r(), 0.62 + 0.22 * r())
    const base = 0.015 + 0.085 * r()
    const twist = A.twist ? +(rd(r, A.twist[0], A.twist[1]) * (r() < 0.5 ? 1 : -1)).toFixed(2) : (r() < 0.2 ? rd(r, -0.28, 0.28) : 0)
    out.push({
      name: `形态 ${String(startIdx + i).padStart(3, '0')}`, icon: 'icon-[lucide--orbit]',
      patch: {
        color,
        shape: +(A.shape * (0.9 + 0.2 * r())).toFixed(2),
        warp: +(A.warp * (0.7 + 0.6 * r())).toFixed(2),
        warpFreq: rd(r, 1.2, 4.0, 1), twist,
        coreR: rd(r, 0.3, 0.72), coreFrac: rd(r, 0.06, 0.4), haloFrac: rd(r, 0.1, 0.5),
        pull: rd(r, A.pull[0], A.pull[1]), turb: rd(r, A.turb[0], A.turb[1]), freq: rd(r, 0.6, 1.6),
        speed: rd(r, 0.45, 0.95), follow: rd(r, 0.25, 0.55), tilt: rd(r, -0.7, 0.7),
        sizeCore: rd(r, 1.0, 2.2), sizeShell: rd(r, 0.85, 1.4), sizeHalo: rd(r, 0.75, 1.15),
        brightCore: rd(r, 0.42, 0.82), brightShell: rd(r, 0.32, 0.6), brightHalo: rd(r, 0.24, 0.5),
        spinCore: +(base * (0.8 + 0.9 * r())).toFixed(3),
        spinShell: +(base * (0.3 + 0.7 * r()) * (r() < 0.22 ? -1 : 1)).toFixed(3),
        spinHalo: +(base * (0.2 + 0.7 * r()) * (r() < 0.35 ? -1 : 1)).toFixed(3),
        density: '高',
      },
    })
  }
  return out
}

const CURATED = [
  { name: '静谧', icon: 'icon-[lucide--moon]', patch: { color: '#d9e6ff', freq: 0.9, pull: 4.0, turb: 0.42, coreR: 0.4, coreFrac: 0.24, haloFrac: 0.12, speed: 0.6, follow: 0.3, sizeCore: 1.4, sizeShell: 1.1, sizeHalo: 0.95, brightCore: 0.6, brightShell: 0.48, brightHalo: 0.35, spinCore: 0.03, spinShell: 0.018, spinHalo: 0.008, density: '高' } },
  { name: '星系', icon: 'icon-[lucide--orbit]', patch: { color: '#cbd6ff', freq: 1.0, pull: 2.2, turb: 0.7, coreR: 0.35, coreFrac: 0.28, haloFrac: 0.35, speed: 0.7, follow: 0.35, sizeCore: 1.7, sizeShell: 1.1, sizeHalo: 0.9, brightCore: 0.7, brightShell: 0.45, brightHalo: 0.5, spinCore: 0.09, spinShell: 0.03, spinHalo: -0.02, density: '高' } },
  { name: '行星', icon: 'icon-[lucide--globe]', patch: { color: '#9dd9ff', freq: 0.95, pull: 3.4, turb: 0.45, coreR: 0.55, coreFrac: 0.35, haloFrac: 0.15, speed: 0.5, follow: 0.3, sizeCore: 1.8, sizeShell: 1.05, sizeHalo: 0.9, brightCore: 0.68, brightShell: 0.42, brightHalo: 0.3, spinCore: 0.02, spinShell: 0.015, spinHalo: 0.008, density: '高' } },
  { name: '风暴', icon: 'icon-[lucide--wind]', patch: { color: '#7aa8ff', freq: 1.1, pull: 2.0, turb: 1.0, coreR: 0.45, coreFrac: 0.18, haloFrac: 0.45, speed: 1.0, follow: 0.5, sizeCore: 1.3, sizeShell: 1.15, sizeHalo: 1.05, brightCore: 0.6, brightShell: 0.52, brightHalo: 0.5, spinCore: 0.06, spinShell: 0.03, spinHalo: 0.02, density: '高' } },
  { name: '黑洞', icon: 'icon-[lucide--circle-dot]', patch: { color: '#ffffff', freq: 1.0, pull: 3.2, turb: 0.5, coreR: 0.3, coreFrac: 0.3, haloFrac: 0.24, speed: 0.9, follow: 0.35, sizeCore: 1.2, sizeShell: 1.1, sizeHalo: 1.0, brightCore: 0.75, brightShell: 0.4, brightHalo: 0.32, spinCore: 0.11, spinShell: 0.02, spinHalo: 0.01, density: '高' } },
  { name: '星云', icon: 'icon-[lucide--sparkles]', patch: { color: '#b388ff', freq: 0.55, pull: 1.5, turb: 0.75, coreR: 0.6, coreFrac: 0.28, haloFrac: 0.38, speed: 0.6, follow: 0.35, sizeCore: 1.8, sizeShell: 1.5, sizeHalo: 1.3, brightCore: 0.5, brightShell: 0.42, brightHalo: 0.4, spinCore: 0.02, spinShell: 0.015, spinHalo: 0.01, density: '高' } },
  { name: '极光', icon: 'icon-[lucide--waves]', patch: { color: '#38e1c0', freq: 0.85, pull: 2.6, turb: 0.65, coreR: 0.45, coreFrac: 0.22, haloFrac: 0.3, speed: 0.8, follow: 0.4, sizeCore: 1.5, sizeShell: 1.15, sizeHalo: 1.0, brightCore: 0.62, brightShell: 0.5, brightHalo: 0.42, spinCore: 0.045, spinShell: 0.025, spinHalo: 0.015, density: '高' } },
  { name: '烈焰', icon: 'icon-[lucide--flame]', patch: { color: '#ffb03a', freq: 1.0, pull: 1.8, turb: 1.05, coreR: 0.5, coreFrac: 0.18, haloFrac: 0.46, speed: 0.95, follow: 0.45, sizeCore: 1.4, sizeShell: 1.2, sizeHalo: 1.1, brightCore: 0.6, brightShell: 0.52, brightHalo: 0.5, spinCore: 0.05, spinShell: 0.03, spinHalo: 0.02, density: '高' } },
  { name: '深海', icon: 'icon-[lucide--droplet]', patch: { color: '#5ad0ff', freq: 0.8, pull: 3.0, turb: 0.55, coreR: 0.42, coreFrac: 0.26, haloFrac: 0.2, speed: 0.6, follow: 0.3, sizeCore: 1.6, sizeShell: 1.05, sizeHalo: 0.9, brightCore: 0.66, brightShell: 0.4, brightHalo: 0.34, spinCore: 0.03, spinShell: 0.018, spinHalo: 0.01, density: '高' } },
  { name: '樱粉', icon: 'icon-[lucide--heart]', patch: { color: '#ff9ecb', freq: 0.95, pull: 2.4, turb: 0.6, coreR: 0.46, coreFrac: 0.22, haloFrac: 0.3, speed: 0.7, follow: 0.4, sizeCore: 1.5, sizeShell: 1.15, sizeHalo: 1.0, brightCore: 0.6, brightShell: 0.5, brightHalo: 0.42, spinCore: 0.04, spinShell: 0.022, spinHalo: 0.012, density: '高' } },
  { name: '翡翠', icon: 'icon-[lucide--gem]', patch: { color: '#6bff9d', freq: 0.9, pull: 2.7, turb: 0.6, coreR: 0.44, coreFrac: 0.24, haloFrac: 0.28, speed: 0.75, follow: 0.4, sizeCore: 1.5, sizeShell: 1.1, sizeHalo: 1.0, brightCore: 0.62, brightShell: 0.48, brightHalo: 0.42, spinCore: 0.03, spinShell: -0.02, spinHalo: 0.01, density: '高' } },
  { name: '双核', icon: 'icon-[lucide--target]', patch: { color: '#cbd6ff', freq: 0.9, pull: 3.6, turb: 0.4, coreR: 0.62, coreFrac: 0.42, haloFrac: 0.12, speed: 0.6, follow: 0.3, sizeCore: 1.6, sizeShell: 1.0, sizeHalo: 0.9, brightCore: 0.65, brightShell: 0.42, brightHalo: 0.3, spinCore: 0.05, spinShell: 0.02, spinHalo: 0.01, density: '高' } },
  { name: '薄壳', icon: 'icon-[lucide--circle]', patch: { color: '#ffffff', freq: 1.3, pull: 4.6, turb: 0.35, coreR: 0.5, coreFrac: 0.06, haloFrac: 0.14, speed: 0.6, follow: 0.3, sizeCore: 1.2, sizeShell: 1.15, sizeHalo: 0.95, brightCore: 0.5, brightShell: 0.55, brightHalo: 0.35, spinCore: 0.02, spinShell: 0.025, spinHalo: 0.01, density: '高' } },
  { name: '微光', icon: 'icon-[lucide--star]', patch: { color: '#d9e6ff', freq: 0.95, pull: 2.8, turb: 0.5, coreR: 0.46, coreFrac: 0.24, haloFrac: 0.22, speed: 0.55, follow: 0.3, sizeCore: 1.4, sizeShell: 1.15, sizeHalo: 1.0, brightCore: 0.4, brightShell: 0.32, brightHalo: 0.26, spinCore: 0.025, spinShell: 0.015, spinHalo: 0.008, density: '高' } },
]
// 14 精选 + 236 生成 = 250
const PRESETS = [...CURATED, ...genPresets(236, CURATED.length + 1)]

function pushPatch(patch: Patch) {
  orbFrame.value?.contentWindow?.postMessage({ __storm: { patch } }, '*')
}
function onSlide(key: string, v?: number[]) {
  const n = v?.[0]
  if (typeof n !== 'number') return
  ;(params as any)[key] = n
  pushPatch({ [key]: n })
}
function setColor(hex: string) { params.color = hex; pushPatch({ color: hex }) }
function setBg(v: string) { params.bg = v; pushPatch({ bg: v }) }
function setDensity(d: string) { params.density = d; pushPatch({ density: d }) }
function applyPreset(p: any) {
  Object.assign(params, p.patch)
  // 带入场动画(球从小蹦大跳出)
  orbFrame.value?.contentWindow?.postMessage({ __storm: { patch: p.patch, reenter: true } }, '*')
}
function eq(a: string, b: string) { return a.toLowerCase() === b.toLowerCase() }

watch(panelOpen, (open) => {
  if (open) { expandBtn.value = false }
  else { window.setTimeout(() => { if (!panelOpen.value) expandBtn.value = true }, 320) }
})

function onMsg(e: MessageEvent) {
  if (e.data && e.data.__storm === 'ready') pushPatch({ ...params })
}
window.addEventListener('message', onMsg)
onUnmounted(() => window.removeEventListener('message', onMsg))

function currentQuery(): string {
  try {
    const fn = (orbFrame.value?.contentWindow as any)?.__stormQuery
    return typeof fn === 'function' ? fn() : ''
  } catch { return '' }
}
async function openFullscreen() {
  const q = currentQuery()
  const existing = await WebviewWindow.getByLabel('storm')
  if (existing) await existing.close()
  new WebviewWindow('storm', { url: `index.html?${q}&fs=1`, title: 'Storm Orb', fullscreen: true, decorations: false })
}
</script>

<template>
  <div class="h-full w-full flex">
    <div class="flex-1 min-w-0 relative grid place-items-center" style="container-type:size">
      <iframe ref="orbFrame" src="orb/index.html" style="width:100cqmin;height:100cqmin" class="border-0 block bg-transparent" title="Storm Orb" />
      <button
        @click="openFullscreen"
        class="absolute top-4 left-4 h-9 px-3 rounded-lg text-sm bg-black/25 hover:bg-black/45 border border-white/12 text-foreground/90 backdrop-blur-md flex items-center gap-1.5"
      >
        <span class="icon-[lucide--maximize] w-4 h-4" /> 全屏观赏
      </button>
      <button
        v-show="expandBtn" @click="panelOpen = true" title="展开面板"
        class="absolute top-4 right-4 size-9 rounded-lg bg-black/25 hover:bg-black/45 border border-white/12 text-foreground/90 backdrop-blur-md flex items-center justify-center"
      >
        <span class="icon-[lucide--sliders-horizontal] w-4 h-4" />
      </button>
    </div>

    <div class="shrink-0 overflow-hidden transition-[width] duration-300 ease-out" :class="panelOpen ? 'w-76.5' : 'w-0'">
      <div class="w-76.5 h-full p-3 transition-transform duration-300 ease-out" :class="panelOpen ? 'translate-x-0' : 'translate-x-full'">
        <div class="h-full rounded-2xl border border-border bg-card/75 backdrop-blur-xl shadow-2xl flex flex-col overflow-hidden">
          <div class="flex items-center justify-between pl-4 pr-2.5 pt-3 pb-0.5">
            <span class="text-sm font-semibold tracking-wide">粒子球</span>
            <button
              @click="panelOpen = false" title="收起面板"
              class="size-7 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted flex items-center justify-center"
            >
              <span class="icon-[lucide--panel-right-close] w-4 h-4" />
            </button>
          </div>

          <Tabs v-model="tab" class="flex-1 flex flex-col min-h-0">
            <TabsList class="grid grid-cols-4 h-10 mx-3 mt-2 mb-1 shrink-0">
              <TabsTrigger value="look" class="text-sm">外观</TabsTrigger>
              <TabsTrigger value="shape" class="text-sm">形态</TabsTrigger>
              <TabsTrigger value="wall" class="text-sm">壁纸</TabsTrigger>
              <TabsTrigger value="saver" class="text-sm">屏保</TabsTrigger>
            </TabsList>

            <!-- 外观 -->
            <TabsContent value="look" class="flex-1 min-h-0 mt-0">
              <ScrollArea class="h-full">
                <div class="px-4 pb-6 pt-2 space-y-5">
                  <div>
                    <div class="text-xs text-muted-foreground mb-2">预设</div>
                    <div class="grid grid-cols-2 gap-2">
                      <button
                        v-for="p in PRESETS" :key="p.name" @click="applyPreset(p)"
                        class="flex items-center gap-2 px-2.5 py-2 rounded-lg border border-border bg-muted/40 hover:bg-muted hover:border-primary/60 text-sm transition-colors"
                      >
                        <span :class="p.icon" class="w-4 h-4 text-primary shrink-0" />
                        <span class="truncate">{{ p.name }}</span>
                      </button>
                    </div>
                  </div>
                  <div>
                    <div class="text-xs text-muted-foreground mb-2">粒子颜色</div>
                    <div class="flex flex-wrap gap-2">
                      <button
                        v-for="c in P_SWATCHES" :key="c" @click="setColor(c)" :style="{ background: c }"
                        class="w-7 h-7 rounded-lg border transition-all"
                        :class="eq(params.color, c) ? 'border-primary ring-2 ring-primary/40' : 'border-white/15'"
                      />
                      <label class="w-7 h-7 rounded-lg border border-white/15 bg-muted flex items-center justify-center cursor-pointer relative overflow-hidden text-muted-foreground">
                        <span class="icon-[lucide--pipette] w-3.5 h-3.5" />
                        <input type="color" :value="params.color" @input="setColor(($event.target as HTMLInputElement).value)" class="absolute inset-0 opacity-0 cursor-pointer" />
                      </label>
                    </div>
                  </div>
                  <div>
                    <div class="text-xs text-muted-foreground mb-2">背景色</div>
                    <div class="flex flex-wrap gap-2">
                      <button
                        @click="setBg('transparent')" title="透明(融入应用)"
                        class="w-7 h-7 rounded-lg border transition-all"
                        :class="params.bg === 'transparent' ? 'border-primary ring-2 ring-primary/40' : 'border-white/15'"
                        style="background-image:repeating-conic-gradient(#5a5f6b 0% 25%,#31353d 0% 50%);background-size:10px 10px"
                      />
                      <button
                        v-for="c in B_COLORS" :key="c" @click="setBg(c)" :style="{ background: c }"
                        class="w-7 h-7 rounded-lg border transition-all"
                        :class="eq(params.bg, c) ? 'border-primary ring-2 ring-primary/40' : 'border-white/15'"
                      />
                      <label class="w-7 h-7 rounded-lg border border-white/15 bg-muted flex items-center justify-center cursor-pointer relative overflow-hidden text-muted-foreground">
                        <span class="icon-[lucide--pipette] w-3.5 h-3.5" />
                        <input type="color" :value="params.bg === 'transparent' ? '#000000' : params.bg" @input="setBg(($event.target as HTMLInputElement).value)" class="absolute inset-0 opacity-0 cursor-pointer" />
                      </label>
                    </div>
                  </div>
                </div>
              </ScrollArea>
            </TabsContent>

            <!-- 形态(分层)-->
            <TabsContent value="shape" class="flex-1 min-h-0 mt-0">
              <ScrollArea class="h-full">
                <div class="px-4 pb-6 pt-2 space-y-5">
                  <div>
                    <div class="text-xs text-muted-foreground mb-2">密度</div>
                    <div class="grid grid-cols-3 gap-1.5">
                      <button
                        v-for="d in ['低', '中', '高']" :key="d" @click="setDensity(d)"
                        class="py-1.5 rounded-md text-xs transition-colors"
                        :class="params.density === d ? 'bg-primary text-primary-foreground' : 'bg-muted/50 text-muted-foreground hover:bg-muted'"
                      >{{ d }}</button>
                    </div>
                  </div>
                  <div v-for="sec in SECTIONS" :key="sec.title">
                    <div class="flex items-center gap-1.5 text-xs font-medium text-foreground/80 mb-2.5">
                      <span v-if="sec.icon" :class="sec.icon" class="w-3.5 h-3.5 text-primary" />
                      {{ sec.title }}
                    </div>
                    <div class="space-y-3.5">
                      <div v-for="s in sec.items" :key="s.key">
                        <div class="flex items-center justify-between text-xs mb-1.5">
                          <span class="text-muted-foreground flex items-center gap-1.5">
                            <span :class="s.icon" class="w-3.5 h-3.5" /> {{ s.label }}
                          </span>
                          <span class="tabular-nums">{{ (params as any)[s.key].toFixed(s.step < 0.01 ? 3 : 2) }}</span>
                        </div>
                        <Slider
                          :model-value="[(params as any)[s.key]]"
                          :min="s.min" :max="s.max" :step="s.step"
                          @update:model-value="(v: number[] | undefined) => onSlide(s.key, v)"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </ScrollArea>
            </TabsContent>

            <TabsContent value="wall" class="flex-1 min-h-0 mt-0 flex flex-col items-center justify-center gap-3 text-center px-6">
              <span class="icon-[lucide--monitor] w-8 h-8 text-muted-foreground" />
              <div class="text-sm text-muted-foreground">动态壁纸<br />即将支持</div>
            </TabsContent>
            <TabsContent value="saver" class="flex-1 min-h-0 mt-0 flex flex-col items-center justify-center gap-3 text-center px-6">
              <span class="icon-[lucide--tv-minimal] w-8 h-8 text-muted-foreground" />
              <div class="text-sm text-muted-foreground">定时屏保<br />即将支持</div>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  </div>
</template>
