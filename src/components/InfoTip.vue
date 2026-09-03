<script setup lang="ts">
/**
 * 一个 ⓘ，鼠标停上去才说话。
 *
 * # 为什么要有这个东西
 *
 * 解释性的文字**不该常驻在界面上**。一句「点一下打开来看；刮选一段按 Alt+K……」
 * 第一次有用，第十次开始就是噪音 —— 而界面上这种句子攒够五六句，
 * 整个应用看着就是脏乱差。
 *
 * 但把话删干净也不行：新来的人真的不知道 Alt+K 能干嘛。
 * 折中就是收进这个圈里 —— 平时只占一个 14 像素的点，要看的时候停一下就有。
 *
 * # 位置的规矩
 *
 * **紧跟在它解释的那个东西后面**（小节标题、字段名的右边），
 * 不要放到行尾去和操作按钮挤在一起 —— 那儿是「能点的东西」的地盘，
 * 一个不能点的图标混进去，人会去点它。
 */
defineProps<{
  /** 悬停时说的话 */
  text: string
}>()
</script>

<template>
  <span
    :title="text"
    class="shrink-0 inline-flex items-center justify-center size-3.5 rounded-full
           text-muted-foreground/60 transition-colors hover:text-foreground cursor-help"
  >
    <span class="icon-[lucide--info] w-3.5 h-3.5" />
  </span>
</template>
