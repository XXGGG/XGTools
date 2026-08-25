<script setup lang="ts">
// 版本 / 开机自启 / GitHub 已挪到设置页(views/Settings.vue),这里只留标识。
import ParticleLogo from '@/components/ParticleLogo.vue'
</script>

<template>
  <!--
    absolute inset-0 是为了逃出 main 的 pt/pl —— 绝对定位对齐的是 padding box,
    不受那层 padding 影响,所以这里是相对**整个窗口**居中。
    顶栏和侧栏是浮层,不参与布局,不再需要以前那个 -36px 的补偿。
    Logo 和字标包在同一个 flex 里,作为一整块居中(不是各自居中)。
  -->
  <div class="absolute inset-0 flex items-center justify-center
              animate-in fade-in zoom-in-95 duration-500">
    <!-- 图标和字标现在是同一套粒子(同一个画布、同一套物理),不再是分开的两个元素 -->
    <ParticleLogo />
  </div>
</template>
