<script setup lang="ts">
import { ref, reactive, onUnmounted } from 'vue'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Slider } from '@/components/ui/slider'
import { ScrollArea } from '@/components/ui/scroll-area'

const orbFrame = ref<HTMLIFrameElement | null>(null)
const tab = ref('look')
const panelOpen = ref(true)

type Patch = Record<string, number | string>

const params = reactive({
  color: '#d9e6ff', bg: '#000000', density: '高',
  freq: 1.0, pull: 2.3, turb: 0.62, coreR: 0.5, coreFrac: 0.22, haloFrac: 0.3,
  pointSize: 1.25, bright: 0.55, swirl: 0.35, speed: 1.0, spin: 0.05, follow: 1.0,
})

const P_SWATCHES = ['#d9e6ff', '#ffffff', '#38e1c0', '#6bffd8', '#7aa8ff', '#5a7cff',
  '#b388ff', '#e07bff', '#ff8fae', '#ff6b6b', '#ffd27a', '#9dff6b', '#ffb03a']
const B_SWATCHES = ['#000000', '#050506', '#0a0e14', '#0b1020', '#12061c', '#07140f', '#160b0b']

const SLIDERS = [
  { key: 'freq', label: '结构大小', min: 0.4, max: 2.4, step: 0.01 },
  { key: 'pull', label: '球壳紧实', min: 0.8, max: 5, step: 0.01 },
  { key: 'turb', label: '风沙(湍流)', min: 0, max: 1.4, step: 0.01 },
  { key: 'coreR', label: '内核壳大小', min: 0.2, max: 0.8, step: 0.01 },
  { key: 'coreFrac', label: '内核壳占比', min: 0, max: 0.6, step: 0.01 },
  { key: 'haloFrac', label: '风沙占比', min: 0, max: 0.6, step: 0.01 },
  { key: 'pointSize', label: '颗粒大小', min: 0.8, max: 3.5, step: 0.01 },
  { key: 'bright', label: '亮度', min: 0.15, max: 0.9, step: 0.01 },
  { key: 'swirl', label: '涡旋强度', min: 0, max: 1.2, step: 0.01 },
  { key: 'speed', label: '速度', min: 0, max: 2.5, step: 0.01 },
  { key: 'spin', label: '自转', min: 0, max: 0.3, step: 0.005 },
  { key: 'follow', label: '窗口跟随', min: 0, max: 2.5, step: 0.01 },
] as const

// 预设:形状各异(内核大小/占比、风沙、紧实、结构、颗粒都不同,不只是换色)
const PRESETS = [
  { name: '静谧', icon: 'icon-[lucide--moon]', patch: { color: '#d9e6ff', bg: '#050506', freq: 0.9, swirl: 0.3, turb: 0.42, pull: 4.4, coreR: 0.4, coreFrac: 0.25, haloFrac: 0.1, spin: 0.04, speed: 0.9, pointSize: 1.3, bright: 0.5, density: '高' } },
  { name: '风暴', icon: 'icon-[lucide--wind]', patch: { color: '#7aa8ff', bg: '#05070d', freq: 1.1, swirl: 0.5, turb: 1.0, pull: 2.0, coreR: 0.5, coreFrac: 0.2, haloFrac: 0.42, spin: 0.08, speed: 1.3, pointSize: 1.2, bright: 0.55, density: '高' } },
  { name: '星云', icon: 'icon-[lucide--sparkles]', patch: { color: '#b388ff', bg: '#0a0612', freq: 0.55, swirl: 0.22, turb: 0.75, pull: 1.5, coreR: 0.6, coreFrac: 0.28, haloFrac: 0.38, spin: 0.025, speed: 0.8, pointSize: 1.6, bright: 0.48, density: '高' } },
  { name: '极光', icon: 'icon-[lucide--waves]', patch: { color: '#38e1c0', bg: '#04100c', freq: 0.85, swirl: 0.4, turb: 0.65, pull: 2.6, coreR: 0.45, coreFrac: 0.22, haloFrac: 0.3, spin: 0.05, speed: 1.0, pointSize: 1.3, bright: 0.55, density: '高' } },
  { name: '黑洞', icon: 'icon-[lucide--circle-dot]', patch: { color: '#ffffff', bg: '#000000', freq: 1.0, swirl: 0.95, turb: 0.5, pull: 3.2, coreR: 0.35, coreFrac: 0.3, haloFrac: 0.24, spin: 0.02, speed: 1.2, pointSize: 1.15, bright: 0.5, density: '高' } },
  { name: '烈焰', icon: 'icon-[lucide--flame]', patch: { color: '#ffb03a', bg: '#0d0603', freq: 1.0, swirl: 0.35, turb: 1.1, pull: 1.8, coreR: 0.5, coreFrac: 0.18, haloFrac: 0.46, spin: 0.06, speed: 1.2, pointSize: 1.25, bright: 0.55, density: '高' } },
  { name: '深海', icon: 'icon-[lucide--droplet]', patch: { color: '#5ad0ff', bg: '#02080f', freq: 0.8, swirl: 0.3, turb: 0.55, pull: 3.0, coreR: 0.42, coreFrac: 0.26, haloFrac: 0.22, spin: 0.035, speed: 0.85, pointSize: 1.3, bright: 0.52, density: '高' } },
  { name: '樱粉', icon: 'icon-[lucide--heart]', patch: { color: '#ff9ecb', bg: '#0d0409', freq: 0.95, swirl: 0.32, turb: 0.6, pull: 2.4, coreR: 0.46, coreFrac: 0.22, haloFrac: 0.3, spin: 0.045, speed: 1.0, pointSize: 1.35, bright: 0.52, density: '高' } },
  { name: '翡翠', icon: 'icon-[lucide--gem]', patch: { color: '#6bff9d', bg: '#03100a', freq: 0.9, swirl: 0.38, turb: 0.68, pull: 2.7, coreR: 0.44, coreFrac: 0.24, haloFrac: 0.28, spin: 0.05, speed: 1.0, pointSize: 1.28, bright: 0.53, density: '高' } },
  { name: '黄昏', icon: 'icon-[lucide--sunset]', patch: { color: '#ff8f6b', bg: '#0c0510', freq: 0.85, swirl: 0.3, turb: 0.8, pull: 2.2, coreR: 0.48, coreFrac: 0.2, haloFrac: 0.38, spin: 0.05, speed: 1.05, pointSize: 1.3, bright: 0.54, density: '高' } },
  { name: '双核', icon: 'icon-[lucide--target]', patch: { color: '#cbd6ff', bg: '#04060c', freq: 0.9, swirl: 0.3, turb: 0.4, pull: 3.6, coreR: 0.62, coreFrac: 0.4, haloFrac: 0.12, spin: 0.04, speed: 0.9, pointSize: 1.3, bright: 0.5, density: '高' } },
  { name: '薄壳', icon: 'icon-[lucide--circle]', patch: { color: '#ffffff', bg: '#000000', freq: 1.3, swirl: 0.25, turb: 0.32, pull: 5.0, coreR: 0.5, coreFrac: 0.04, haloFrac: 0.12, spin: 0.03, speed: 0.9, pointSize: 1.15, bright: 0.5, density: '高' } },
  { name: '狂沙', icon: 'icon-[lucide--tornado]', patch: { color: '#ffd27a', bg: '#0a0602', freq: 1.0, swirl: 0.45, turb: 1.3, pull: 1.5, coreR: 0.5, coreFrac: 0.15, haloFrac: 0.55, spin: 0.06, speed: 1.3, pointSize: 1.1, bright: 0.55, density: '高' } },
  { name: '巨粒', icon: 'icon-[lucide--grip]', patch: { color: '#9dd9ff', bg: '#02060c', freq: 0.9, swirl: 0.3, turb: 0.55, pull: 2.6, coreR: 0.48, coreFrac: 0.25, haloFrac: 0.25, spin: 0.05, speed: 1.0, pointSize: 2.6, bright: 0.42, density: '中' } },
  { name: '螺旋', icon: 'icon-[lucide--loader-circle]', patch: { color: '#b8ff6b', bg: '#030c04', freq: 1.1, swirl: 1.15, turb: 0.6, pull: 2.4, coreR: 0.45, coreFrac: 0.2, haloFrac: 0.3, spin: 0.03, speed: 1.15, pointSize: 1.25, bright: 0.53, density: '高' } },
  { name: '微光', icon: 'icon-[lucide--star]', patch: { color: '#d9e6ff', bg: '#05060a', freq: 0.95, swirl: 0.3, turb: 0.5, pull: 2.8, coreR: 0.46, coreFrac: 0.24, haloFrac: 0.22, spin: 0.04, speed: 0.9, pointSize: 1.3, bright: 0.32, density: '高' } },
]

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
function setBg(hex: string) { params.bg = hex; pushPatch({ bg: hex }) }
function setDensity(d: string) { params.density = d; pushPatch({ density: d }) }
function applyPreset(p: (typeof PRESETS)[number]) {
  Object.assign(params, p.patch)
  pushPatch(p.patch as Patch)
}
function eq(a: string, b: string) { return a.toLowerCase() === b.toLowerCase() }

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
  new WebviewWindow('storm', { url: `index.html?${q}`, title: 'Storm Orb', fullscreen: true, decorations: false })
}
</script>

<template>
  <div class="h-full w-full flex flex-col">
    <!-- 顶栏(固定 h-14 = 56px)-->
    <div class="h-14 shrink-0 flex items-center gap-2 px-4 border-b border-border">
      <span class="icon-[lucide--orbit] w-5 h-5 text-primary" />
      <span class="font-medium">粒子球</span>
      <span class="text-xs text-muted-foreground hidden md:inline">原创风暴粒子球</span>
      <button
        @click="openFullscreen"
        class="ml-auto px-3 py-1.5 rounded-lg text-sm bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-1.5"
      >
        <span class="icon-[lucide--maximize] w-4 h-4" /> 全屏观赏
      </button>
      <button
        @click="panelOpen = !panelOpen"
        :title="panelOpen ? '收起面板' : '展开面板'"
        class="size-9 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:border-primary/60 flex items-center justify-center"
      >
        <span :class="panelOpen ? 'icon-[lucide--panel-right-close]' : 'icon-[lucide--panel-right-open]'" class="w-4 h-4" />
      </button>
    </div>

    <div class="flex-1 flex min-h-0">
      <!-- 画布:居中方形(cqmin = 取容器较小边)-->
      <div class="flex-1 bg-black grid place-items-center min-w-0" style="container-type:size">
        <iframe ref="orbFrame" src="orb/index.html" style="width:100cqmin;height:100cqmin" class="border-0 block" title="Storm Orb" />
      </div>

      <!-- 控制面板(可收起)-->
      <Transition
        enter-active-class="transition-all duration-200" enter-from-class="opacity-0 translate-x-4"
        leave-active-class="transition-all duration-200" leave-to-class="opacity-0 translate-x-4"
      >
        <div v-show="panelOpen" class="w-72 shrink-0 border-l border-border flex flex-col bg-card/40">
          <Tabs v-model="tab" class="flex-1 flex flex-col min-h-0">
            <TabsList class="mx-auto h-11 mt-3 mb-1 shrink-0">
              <TabsTrigger value="look" class="px-5 text-sm">外观</TabsTrigger>
              <TabsTrigger value="shape" class="px-5 text-sm">形态</TabsTrigger>
              <TabsTrigger value="wall" class="px-5 text-sm">壁纸</TabsTrigger>
              <TabsTrigger value="saver" class="px-5 text-sm">屏保</TabsTrigger>
            </TabsList>

            <!-- 外观 -->
            <TabsContent value="look" class="flex-1 min-h-0 mt-0">
              <ScrollArea class="h-full">
                <div class="px-3 pb-6 pt-2 space-y-5">
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
                        v-for="c in B_SWATCHES" :key="c" @click="setBg(c)" :style="{ background: c }"
                        class="w-7 h-7 rounded-lg border transition-all"
                        :class="eq(params.bg, c) ? 'border-primary ring-2 ring-primary/40' : 'border-white/15'"
                      />
                      <label class="w-7 h-7 rounded-lg border border-white/15 bg-muted flex items-center justify-center cursor-pointer relative overflow-hidden text-muted-foreground">
                        <span class="icon-[lucide--pipette] w-3.5 h-3.5" />
                        <input type="color" :value="params.bg" @input="setBg(($event.target as HTMLInputElement).value)" class="absolute inset-0 opacity-0 cursor-pointer" />
                      </label>
                    </div>
                  </div>
                </div>
              </ScrollArea>
            </TabsContent>

            <!-- 形态 -->
            <TabsContent value="shape" class="flex-1 min-h-0 mt-0">
              <ScrollArea class="h-full">
                <div class="px-3 pb-6 pt-2 space-y-4">
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
                  <div v-for="s in SLIDERS" :key="s.key">
                    <div class="flex items-center justify-between text-xs mb-2">
                      <span class="text-muted-foreground">{{ s.label }}</span>
                      <span class="tabular-nums">{{ (params as any)[s.key].toFixed(2) }}</span>
                    </div>
                    <Slider
                      :model-value="[(params as any)[s.key]]"
                      :min="s.min" :max="s.max" :step="s.step"
                      @update:model-value="(v: number[] | undefined) => onSlide(s.key, v)"
                    />
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
      </Transition>
    </div>
  </div>
</template>
