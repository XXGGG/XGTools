<script setup lang="ts">
import { ref } from 'vue'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'

const orbFrame = ref<HTMLIFrameElement | null>(null)

// 读 orb 页当前配置(颜色/形态/律动),拼成查询串,带给全屏/壁纸/屏保
function currentQuery(): string {
  try {
    const fn = (orbFrame.value?.contentWindow as any)?.__stormQuery
    return typeof fn === 'function' ? fn() : ''
  } catch {
    return ''
  }
}

async function openFullscreen() {
  const q = currentQuery()
  const existing = await WebviewWindow.getByLabel('storm')
  if (existing) await existing.close()
  // 载入 index.html → App.vue 路由到 StormFullscreen(全屏 iframe 承载 orb)
  new WebviewWindow('storm', {
    url: `index.html?${q}&panel=0`,
    title: 'Storm Orb',
    fullscreen: true,
    decorations: false,
  })
}
</script>

<template>
  <div class="h-full w-full flex flex-col">
    <div class="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
      <span class="icon-[lucide--orbit] w-5 h-5 text-primary" />
      <span class="font-medium">粒子球</span>
      <span class="text-xs text-muted-foreground hidden sm:inline">原创风暴粒子球 · 右侧面板可调形态/颜色/预设</span>
      <div class="ml-auto flex gap-2">
        <button
          @click="openFullscreen"
          class="px-3 py-1.5 rounded-lg text-sm bg-primary text-primary-foreground hover:opacity-90 flex items-center gap-1.5"
        >
          <span class="icon-[lucide--maximize] w-4 h-4" /> 全屏观赏
        </button>
      </div>
    </div>
    <div class="flex-1 relative bg-black">
      <iframe
        ref="orbFrame"
        src="orb/index.html"
        class="absolute inset-0 w-full h-full border-0"
        title="Storm Orb"
      />
    </div>
  </div>
</template>
