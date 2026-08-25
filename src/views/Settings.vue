<script setup lang="ts">
import { ref, computed, nextTick, onMounted } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-shell'
import { useDark, useToggle } from '@vueuse/core'
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart'
import { VueDraggable } from 'vue-draggable-plus'
import { Tabs, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import TitleBarTabs from '@/components/TitleBarTabs.vue'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { ScrollArea } from '@/components/ui/scroll-area'
import { settings, type BlurKind } from '@/composables/useAppSettings'
import { MENU_ITEMS, orderedAll, type MenuItem } from '@/lib/sidebar-prefs'

const isDark = useDark()
const toggleDark = useToggle(isDark)

const version = ref('')
const autostart = ref(false)
const effectError = ref('')

onMounted(async () => {
  try { version.value = await invoke<string>('plugin:app|version') } catch { /* noop */ }
  try { autostart.value = await isEnabled() } catch { /* noop */ }
})

async function setAutostart(v: boolean) {
  try {
    if (v) await enable(); else await disable()
    autostart.value = v
  } catch (e) {
    console.error('切换开机自启失败:', e)
    autostart.value = await isEnabled().catch(() => false)   // 失败回读真实状态,别让开关停在假位置
  }
}

// ---------- 窗口背景特效 ----------
const BLUR_KINDS: { key: BlurKind; name: string }[] = [
  { key: 'none', name: '关闭' },
  { key: 'mica', name: '云母' },
  { key: 'acrylic', name: '亚克力' },
]

/**
 * 应用窗口特效。
 *
 * 【关键】必须「先应用成功、再提交状态」:blurKind 一旦不是 none,外壳的 CSS 背景就会变透明
 * 好让系统材质透上来。如果这时系统 API 其实失败了(比如老系统没有云母),就会变成
 * 「CSS 透明 + 没有系统材质」= 整个窗口全透明,界面直接消失、也点不回来。
 * 所以失败时要退回 none。
 *
 * 注意:传进去的 r/g/b/a 在 Win11 build >= 22523 上会被 DWM 忽略(见 style.css 的说明),
 * 仍然传是为了兼容老版本 Windows 走 SetWindowCompositionAttribute 的那条路径。
 */
async function applyEffect(kind: BlurKind = settings.blurKind): Promise<boolean> {
  effectError.value = ''
  const a = Math.round((settings.blurOpacity / 100) * 255)
  const tint = isDark.value ? [10, 10, 12] : [246, 246, 248]
  try {
    await invoke('set_window_effect', {
      kind,
      r: tint[0], g: tint[1], b: tint[2], a,
      dark: isDark.value,
    })
    return true
  } catch (e: any) {
    effectError.value = String(e?.message ?? e)
    return false
  }
}

/**
 * 切换特效种类。两个方向的顺序是反的,否则会闪:
 *  · 切到「关闭」:先让 CSS 把不透明底画回来,再清系统材质。反过来的话中间会有一帧
 *    「材质已清掉、CSS 还透明」→ 整窗全透明闪一下。
 *  · 切到某个材质:先挂材质,再让 CSS 透出来。同理避免中间那帧全透明。
 */
async function setBlurKind(k: BlurKind) {
  if (k === 'none') {
    settings.blurKind = 'none'
    await nextTick()
    await new Promise((r) => requestAnimationFrame(() => r(null)))   // 等这一帧真的画出来
    await applyEffect('none')
    return
  }
  const ok = await applyEffect(k)
  settings.blurKind = ok ? k : 'none'
}
function setBlurOpacity(v?: number[]) {
  const n = v?.[0]
  if (typeof n !== 'number') return
  settings.blurOpacity = n   // CSS 变量由 App.vue 的 watcher 统一换算,这里不直接碰 DOM
}

// ---------- 侧栏:排序 + 开关 ----------
const ordered = orderedAll(MENU_ITEMS, { order: settings.sidebarOrder, hidden: settings.sidebarHidden })
// 两组各自一个列表。两个 VueDraggable 共享同一个 group 名,所以条目能在上下两组之间拖来拖去,
// 拖过去就等于改了它归属哪张侧栏卡片。
const toolList = ref<MenuItem[]>(ordered.filter((m) => m.group === 'tool'))
const configList = ref<MenuItem[]>(ordered.filter((m) => m.group === 'config'))
const hiddenSet = computed(() => new Set(settings.sidebarHidden))

function persistOrder() {
  // 拖动可能跨组,先把每条的 group 按它现在所在的列表回写,再存顺序
  toolList.value.forEach((m) => { m.group = 'tool' })
  configList.value.forEach((m) => { m.group = 'config' })
  settings.sidebarOrder = [...toolList.value, ...configList.value].map((m) => m.id)
  settings.sidebarGroups = Object.fromEntries(
    [...toolList.value.map((m) => [m.id, 'tool'] as const),
     ...configList.value.map((m) => [m.id, 'config'] as const)]
  )
}
function toggleItem(id: string) {
  // 可以全部关掉:设置入口是常驻的,不在这份清单里,所以关光了也进得去
  settings.sidebarHidden = hiddenSet.value.has(id)
    ? settings.sidebarHidden.filter((x) => x !== id)
    : [...settings.sidebarHidden, id]
}
</script>

<template>
  <ScrollArea class="h-full">
    <div class="max-w-3xl mx-auto px-8 py-8">
      <Tabs default-value="general">
        <TitleBarTabs>
          <TabsTrigger value="general" class="h-11 px-4 rounded-xl">常规</TabsTrigger>
          <TabsTrigger value="sidebar" class="h-11 px-4 rounded-xl">侧边栏</TabsTrigger>
        </TitleBarTabs>

        <!-- ================= 常规（含外观 / 关于）================= -->
        <TabsContent value="general" class="space-y-6">
          <div class="rounded-xl border divide-y">
            <div class="flex items-center gap-4 px-4 py-3.5">
              <span class="icon-[lucide--power] w-5 h-5 shrink-0 text-muted-foreground" />
              <div class="flex-1 min-w-0">
                <div class="text-sm">开机自启</div>
                <div class="text-xs text-muted-foreground mt-0.5">登录 Windows 后自动运行</div>
              </div>
              <Switch :model-value="autostart" @update:model-value="setAutostart" />
            </div>
          </div>

          <div class="rounded-xl border divide-y">
            <div class="flex items-center gap-4 px-4 py-3.5">
              <span class="icon-[lucide--moon] w-5 h-5 shrink-0 text-muted-foreground" />
              <div class="flex-1 min-w-0"><div class="text-sm">深色模式</div></div>
              <Switch :model-value="isDark" @update:model-value="() => { toggleDark(); applyEffect() }" />
            </div>
          </div>

          <!-- 窗口背景特效 -->
          <section class="space-y-3">
            <div class="text-sm font-medium">窗口背景</div>
            <div class="grid grid-cols-3 gap-2">
              <button v-for="k in BLUR_KINDS" :key="k.key" @click="setBlurKind(k.key)" :class="[
                'rounded-xl border px-3 py-3 text-left transition-colors',
                settings.blurKind === k.key ? 'border-foreground/60 bg-muted/60' : 'hover:bg-muted/40'
              ]">
                <div class="text-sm">{{ k.name }}</div>
              </button>
            </div>
            <div v-if="settings.blurKind !== 'none'" class="rounded-xl border px-4 py-3.5 space-y-3">
              <div class="flex items-center justify-between">
                <div class="text-sm">底面不透明度</div>
                <span class="text-xs font-mono text-muted-foreground">{{ settings.blurOpacity }}</span>
              </div>
              <Slider :model-value="[settings.blurOpacity]" :min="0" :max="100" :step="1"
                @update:model-value="setBlurOpacity" />
            </div>

            <p v-if="effectError" class="text-xs text-amber-500">特效应用失败：{{ effectError }}</p>
          </section>


          <section class="space-y-1">
            <h3 class="text-sm font-medium text-muted-foreground">关于</h3>
          <div class="rounded-xl border divide-y">
            <div class="flex items-center gap-4 px-4 py-3.5">
              <span class="icon-[lucide--box] w-5 h-5 shrink-0 text-muted-foreground" />
              <div class="flex-1 min-w-0"><div class="text-sm">版本</div></div>
              <span class="text-sm font-mono text-muted-foreground">v{{ version || '—' }}</span>
            </div>
            <button class="w-full flex items-center gap-4 px-4 py-3.5 text-left hover:bg-muted/50 transition-colors"
              @click="open('https://github.com/XXGGG/XGTools')">
              <span class="icon-[lucide--github] w-5 h-5 shrink-0 text-muted-foreground" />
              <div class="flex-1 min-w-0">
                <div class="text-sm">GitHub</div>
                <div class="text-xs text-muted-foreground mt-0.5">XXGGG/XGTools</div>
              </div>
              <span class="icon-[lucide--arrow-up-right] w-4 h-4 shrink-0 text-muted-foreground" />
            </button>
          </div>
          </section>
        </TabsContent>

        <!-- ================= 侧边栏 ================= -->
        <TabsContent value="sidebar" class="space-y-5">
          <p class="text-xs text-muted-foreground">
            整条都能拖：上下两组分别对应侧栏的两张卡片，跨组拖动就改变它归哪一张。右侧开关控制是否显示。
          </p>

          <section class="space-y-2">
            <h3 class="text-sm font-medium">工具（上面那张卡片）</h3>
            <VueDraggable v-model="toolList" group="sidebar" :animation="180" :force-fallback="true"
              filter=".no-drag" :prevent-on-filter="false" ghost-class="opacity-30" @end="persistOrder"
              class="rounded-xl border divide-y overflow-hidden min-h-16">
              <div v-for="item in toolList" :key="item.id"
                class="flex items-center gap-4 px-4 py-4 bg-background cursor-grab active:cursor-grabbing">
                <span class="icon-[lucide--grip-vertical] w-4 h-4 shrink-0 text-muted-foreground" />
                <span :class="item.icon" class="w-5 h-5 shrink-0"
                  :style="{ opacity: hiddenSet.has(item.id) ? 0.4 : 1 }" />
                <span class="text-sm flex-1" :class="hiddenSet.has(item.id) ? 'text-muted-foreground' : ''">
                  {{ item.label }}
                </span>
                <!--
                  no-drag 区要比开关本身宽得多:filter 只在指针真正命中该元素时才拦截,
                  开关本体才十几像素,擦边就会被判成拖行 —— 这是误触的根源。
                  这里给它一整条右侧列(含内边距),够手抖的余量。
                -->
                <div class="no-drag shrink-0 flex items-center justify-end pl-6 pr-1 py-2 cursor-default">
                  <Switch :model-value="!hiddenSet.has(item.id)"
                    @update:model-value="() => toggleItem(item.id)" />
                </div>
              </div>
            </VueDraggable>
          </section>

          <section class="space-y-2">
            <h3 class="text-sm font-medium">功能配置（下面那张卡片）</h3>
            <VueDraggable v-model="configList" group="sidebar" :animation="180" :force-fallback="true"
              filter=".no-drag" :prevent-on-filter="false" ghost-class="opacity-30" @end="persistOrder"
              class="rounded-xl border divide-y overflow-hidden min-h-16">
              <div v-for="item in configList" :key="item.id"
                class="flex items-center gap-4 px-4 py-4 bg-background cursor-grab active:cursor-grabbing">
                <span class="icon-[lucide--grip-vertical] w-4 h-4 shrink-0 text-muted-foreground" />
                <span :class="item.icon" class="w-5 h-5 shrink-0"
                  :style="{ opacity: hiddenSet.has(item.id) ? 0.4 : 1 }" />
                <span class="text-sm flex-1" :class="hiddenSet.has(item.id) ? 'text-muted-foreground' : ''">
                  {{ item.label }}
                </span>
                <!--
                  no-drag 区要比开关本身宽得多:filter 只在指针真正命中该元素时才拦截,
                  开关本体才十几像素,擦边就会被判成拖行 —— 这是误触的根源。
                  这里给它一整条右侧列(含内边距),够手抖的余量。
                -->
                <div class="no-drag shrink-0 flex items-center justify-end pl-6 pr-1 py-2 cursor-default">
                  <Switch :model-value="!hiddenSet.has(item.id)"
                    @update:model-value="() => toggleItem(item.id)" />
                </div>
              </div>
            </VueDraggable>
          </section>

        </TabsContent>
      </Tabs>
    </div>
  </ScrollArea>
</template>
