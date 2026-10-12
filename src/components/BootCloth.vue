<script setup lang="ts">
/**
 * 启动遮布:主窗口亮相时罩在最上面的一层不透明底(深色主题黑、浅色白)。
 *
 * 为什么要有它:主窗口是透明窗 + 系统材质(云母),一建出来就显示。设置从磁盘读出来、材质贴上去
 * 之前的几百毫秒,窗口底下是不透明的主题底(index.html 里铺的 boot-base);材质贴上、底摘掉那一下
 * 会闪。布把这一下盖住,等外面调 dismiss() 再淡出卸掉。
 * (窗口不能先藏着再亮相:那样创建的窗口正式版里 DWM 不画云母,见 App.vue 的说明。)
 *
 * 2026-10-12 用户嫌原来的粒子汇聚 Logo 晃眼、没用,去掉了,只留一块纯色布、尽快淡出。
 */
import { ref } from 'vue'

const fading = ref(false)
/** 主题在 index.html 里就已经定好(见那段内联脚本) */
const dark = document.documentElement.classList.contains('dark')

function dismiss(): Promise<void> {
  fading.value = true
  return new Promise(r => window.setTimeout(r, 200))
}

defineExpose({ dismiss })
</script>

<template>
  <div class="fixed inset-0 z-[9999] transition-opacity duration-200 ease-out"
    :class="[dark ? 'bg-black' : 'bg-white', fading ? 'opacity-0 pointer-events-none' : 'opacity-100']" />
</template>
