<script setup lang="ts">
import { Window } from '@tauri-apps/api/window'
import { ref, onMounted } from 'vue'

defineProps<{ active?: boolean }>()
const emit = defineEmits<{ logo: [] }>()

const appWindow = Window.getCurrent()
const isMaximized = ref(false)

const minimize = () => appWindow.minimize()
const toggleMaximize = async () => {
  await appWindow.toggleMaximize()
  isMaximized.value = await appWindow.isMaximized()
}
const close = () => appWindow.close()

onMounted(async () => {
  isMaximized.value = await appWindow.isMaximized()
})
</script>

<template>
  <!--
    左上角对齐常量:列宽 / 栏高 = 72(w-18 / h-18)。
    Logo 不进浮空卡片,直接落在 (36, 36)。侧栏那两张卡片是 w-14 居中在同一个 72 列里,
    卡片内图标中心同样是 36 —— 三者共线。改这里的 72 或侧栏的 w-14 都会让 Logo 错位。

    右上角这张卡片和侧栏卡片同一套模数:内边距 p-1.5(6px) + 每格 size-11(44px) → 总高 58,
    正好等于侧栏卡片的宽度;左右做成完全圆角(rounded-full)。
    每个圆点包在 44×44 的点击格里(和侧栏选框一样大,好点),但**点本身仍是 14px 不放大**,
    格子也不画底色(不出现选框)。悬停整组时才在点里浮现符号(同 Mac)。
    可调参数:卡片内边距 p-1.5 / 点击格 size-11 / 点直径 size-3.5。
    顺序是我们自己定的:绿=最小化 / 黄=最大化 / 红=关闭,红色排最右(关闭在最外侧,和 Windows 习惯一致)。
  -->
  <div class="h-18 shrink-0 flex items-center select-none z-50">
    <button @click="emit('logo')" :class="[
      'w-18 shrink-0 flex items-center justify-center transition-colors',
      active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
    ]">
      <span class="icon-[lucide--box] w-9 h-9" />
    </button>

    <!--
      页面的 Tabs 会 Teleport 到这里(见 TitleBarTabs.vue)。
      两侧各留一段 data-tauri-drag-region 保住拖拽;这个插槽本身不带那个属性,
      所以落在 Tabs 上的点击是真的点击,不会被当成拖窗口。
    -->
    <div data-tauri-drag-region class="flex-1 self-stretch"></div>
    <div id="titlebar-slot" class="relative shrink-0 flex items-center"></div>
    <div data-tauri-drag-region class="flex-1 self-stretch"></div>

    <!--
      间隔全等的推导（别随手改这三个数，改一个另两个要跟着算）：
        点径 D = 14(size-3.5)、点击格 W = 36(size-9)、卡片内边距 P = 11
        点到点 = W - D = 22
        边到点 = P + (W - D)/2 = 11 + 11 = 22   → 两者相等，1:1:1:1
        卡片高 = 2P + W = 58，和侧栏卡片的宽度同一套模数
      之前是 p-0 + W=44：边到点 15、点到点 30，正好是 1:2:2:1，看着就不匀。
    -->
    <div class="float-card group rounded-full border bg-card p-[5px] flex items-center">
      <button @click="minimize" title="最小化"
        class="size-9 rounded-full flex items-center justify-center">
        <span class="size-3.5 rounded-full bg-[#28c840] flex items-center justify-center">
        <span class="icon-[lucide--minus] w-2.5 h-2.5 text-black/60 opacity-0 group-hover:opacity-100 transition-opacity" />
        </span>
      </button>
      <button @click="toggleMaximize" :title="isMaximized ? '还原' : '最大化'"
        class="size-9 rounded-full flex items-center justify-center">
        <span class="size-3.5 rounded-full bg-[#febc2e] flex items-center justify-center">
        <span :class="isMaximized ? 'icon-[lucide--chevrons-down-up]' : 'icon-[lucide--chevrons-up-down]'"
          class="w-2.5 h-2.5 text-black/60 opacity-0 group-hover:opacity-100 transition-opacity" />
        </span>
      </button>
      <button @click="close" title="关闭"
        class="size-9 rounded-full flex items-center justify-center">
        <span class="size-3.5 rounded-full bg-[#ff5f57] flex items-center justify-center">
        <span class="icon-[lucide--x] w-2.5 h-2.5 text-black/60 opacity-0 group-hover:opacity-100 transition-opacity" />
        </span>
      </button>
    </div>
  </div>
</template>
