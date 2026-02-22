<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { LazyStore } from '@tauri-apps/plugin-store'
import { Switch } from '@/components/ui/switch'

const store = new LazyStore('settings.json')
const settingsLoaded = ref(false)

// --- State ---
const screenshotEnabled = ref(true)
const autoBgShadow = ref(false)
const bgColor = ref('transparent')
const bgPadding = ref(32)
const shadowBlur = ref(30)
const cornerRadius = ref(8)

// --- Load / Save ---
async function loadSettings() {
  await store.init()
  screenshotEnabled.value = (await store.get<boolean>('screenshot_enabled')) ?? true
  autoBgShadow.value = (await store.get<boolean>('screenshot_auto_bg_shadow')) ?? false
  bgColor.value = (await store.get<string>('screenshot_bg_color')) ?? 'transparent'
  bgPadding.value = (await store.get<number>('screenshot_bg_padding')) ?? 32
  shadowBlur.value = (await store.get<number>('screenshot_shadow_blur')) ?? 30
  cornerRadius.value = (await store.get<number>('screenshot_corner_radius')) ?? 8
  settingsLoaded.value = true
}

async function saveSettings() {
  await store.set('screenshot_enabled', screenshotEnabled.value)
  await store.set('screenshot_auto_bg_shadow', autoBgShadow.value)
  await store.set('screenshot_bg_color', bgColor.value)
  await store.set('screenshot_bg_padding', bgPadding.value)
  await store.set('screenshot_shadow_blur', shadowBlur.value)
  await store.set('screenshot_corner_radius', cornerRadius.value)
  await store.save()
}

onMounted(loadSettings)

watch(
  [screenshotEnabled, autoBgShadow, bgColor, bgPadding, shadowBlur, cornerRadius],
  () => { if (settingsLoaded.value) saveSettings() },
)

// 背景颜色选项
const bgColorPresets = [
  { value: 'transparent', label: '透明' },
  { value: '#ffffff', label: '' },
  { value: '#f0f0f0', label: '' },
  { value: '#1a1a2e', label: '' },
  { value: '#0d1117', label: '' },
  { value: '#000000', label: '' },
]
</script>

<template>
  <div class="h-full w-full flex flex-col p-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
    <div class="flex-1 overflow-y-auto space-y-3 max-w-2xl mx-auto w-full">

      <!-- 开启截图 -->
      <div class="flex items-center justify-between p-4 border rounded-xl bg-card/50 backdrop-blur-sm hover:bg-card/80 transition-colors shadow-sm">
        <div class="flex items-center gap-3">
          <div class="flex p-2 bg-primary/10 rounded-lg text-primary">
            <span class="icon-[lucide--focus] w-5 h-5" />
          </div>
          <div>
            <h3 class="font-medium">开启截图</h3>
            <p class="text-xs text-muted-foreground">启用后可通过 Ctrl+Alt+A 截图</p>
          </div>
        </div>
        <Switch :model-value="screenshotEnabled" @update:model-value="screenshotEnabled = $event" />
      </div>

      <!-- 以下设置仅在开启时可用 -->
      <div :class="{ 'opacity-40 pointer-events-none select-none': !screenshotEnabled }" class="space-y-3 transition-opacity duration-300">

        <!-- 背景与投影 -->
        <div class="flex items-center justify-between p-4 border rounded-xl bg-card/50 backdrop-blur-sm hover:bg-card/80 transition-colors shadow-sm">
          <div class="flex items-center gap-3">
            <div class="flex p-2 bg-primary/10 rounded-lg text-primary">
              <span class="icon-[lucide--image] w-5 h-5" />
            </div>
            <div>
              <h3 class="font-medium">自动添加背景与投影</h3>
              <p class="text-xs text-muted-foreground">截图自动加上背景色、圆角和阴影效果</p>
            </div>
          </div>
          <Switch :model-value="autoBgShadow" @update:model-value="autoBgShadow = $event" />
        </div>

        <!-- 背景投影的子设置 -->
        <div :class="{ 'opacity-40 pointer-events-none select-none': !autoBgShadow }" class="space-y-3 transition-opacity duration-300 pl-4">

          <!-- 背景颜色 -->
          <div class="p-4 border rounded-xl bg-card/50 backdrop-blur-sm hover:bg-card/80 transition-colors shadow-sm">
            <div class="flex items-center gap-3 mb-3">
              <div class="flex p-2 bg-primary/10 rounded-lg text-primary">
                <span class="icon-[lucide--palette] w-5 h-5" />
              </div>
              <div>
                <h3 class="font-medium">背景颜色</h3>
                <p class="text-xs text-muted-foreground">{{ bgColor === 'transparent' ? '透明' : bgColor }}</p>
              </div>
            </div>
            <div class="flex items-center gap-2 ml-10">
              <button
                v-for="preset in bgColorPresets" :key="preset.value"
                @click="bgColor = preset.value"
                class="w-7 h-7 rounded-lg border-2 transition-all duration-150 flex items-center justify-center"
                :class="bgColor === preset.value ? 'border-primary scale-110' : 'border-border hover:border-muted-foreground'"
                :style="preset.value === 'transparent'
                  ? { background: 'repeating-conic-gradient(#d0d0d0 0% 25%, transparent 0% 50%) 50%/10px 10px' }
                  : { backgroundColor: preset.value }"
              />
              <label class="relative cursor-pointer ml-1">
                <div class="w-7 h-7 rounded-lg border-2 border-dashed border-border hover:border-muted-foreground flex items-center justify-center text-muted-foreground transition-colors">
                  <span class="icon-[lucide--plus] w-3.5 h-3.5" />
                </div>
                <input type="color" :value="bgColor === 'transparent' ? '#f0f0f0' : bgColor" @input="bgColor = ($event.target as HTMLInputElement).value" class="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
              </label>
            </div>
          </div>

          <!-- 背景内边距 -->
          <div class="flex items-center justify-between p-4 border rounded-xl bg-card/50 backdrop-blur-sm hover:bg-card/80 transition-colors shadow-sm">
            <div class="flex items-center gap-3">
              <div class="flex p-2 bg-primary/10 rounded-lg text-primary">
                <span class="icon-[lucide--move] w-5 h-5" />
              </div>
              <div>
                <h3 class="font-medium">背景内边距</h3>
                <p class="text-xs text-muted-foreground">{{ bgPadding }}px</p>
              </div>
            </div>
            <input type="range" v-model.number="bgPadding" min="8" max="80" step="4" class="w-32 accent-primary" />
          </div>

          <!-- 圆角 -->
          <div class="flex items-center justify-between p-4 border rounded-xl bg-card/50 backdrop-blur-sm hover:bg-card/80 transition-colors shadow-sm">
            <div class="flex items-center gap-3">
              <div class="flex p-2 bg-primary/10 rounded-lg text-primary">
                <span class="icon-[lucide--square] w-5 h-5" />
              </div>
              <div>
                <h3 class="font-medium">圆角</h3>
                <p class="text-xs text-muted-foreground">{{ cornerRadius }}px</p>
              </div>
            </div>
            <input type="range" v-model.number="cornerRadius" min="0" max="24" step="2" class="w-32 accent-primary" />
          </div>

          <!-- 阴影强度 -->
          <div class="flex items-center justify-between p-4 border rounded-xl bg-card/50 backdrop-blur-sm hover:bg-card/80 transition-colors shadow-sm">
            <div class="flex items-center gap-3">
              <div class="flex p-2 bg-primary/10 rounded-lg text-primary">
                <span class="icon-[lucide--cloud] w-5 h-5" />
              </div>
              <div>
                <h3 class="font-medium">阴影强度</h3>
                <p class="text-xs text-muted-foreground">{{ shadowBlur }}px</p>
              </div>
            </div>
            <input type="range" v-model.number="shadowBlur" min="0" max="60" step="2" class="w-32 accent-primary" />
          </div>

        </div>

        <!-- 预览 -->
        <div v-if="autoBgShadow" class="p-4 border rounded-xl bg-card/50 backdrop-blur-sm shadow-sm">
          <p class="text-xs text-muted-foreground mb-3">预览效果</p>
          <div class="flex items-center justify-center p-6"
            :style="{ background: 'repeating-conic-gradient(#e0e0e0 0% 25%, #f8f8f8 0% 50%) 50%/16px 16px' }">
            <div
              :style="{
                backgroundColor: bgColor === 'transparent' ? 'transparent' : bgColor,
                padding: bgPadding + 'px',
                borderRadius: cornerRadius + 'px',
              }"
              class="inline-block"
            >
              <div
                :style="{
                  width: '240px',
                  height: '140px',
                  borderRadius: (cornerRadius * 0.6) + 'px',
                  boxShadow: [
                    `0 ${shadowBlur * 0.1}px ${shadowBlur * 0.3}px rgba(0,0,0,0.12)`,
                    `0 ${shadowBlur * 0.4}px ${shadowBlur * 0.8}px rgba(0,0,0,0.08)`,
                    `0 ${shadowBlur}px ${shadowBlur * 2}px rgba(0,0,0,0.06)`,
                  ].join(', '),
                  background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                }"
                class="flex items-center justify-center text-white/80 text-sm"
              >
                截图内容
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  </div>
</template>
