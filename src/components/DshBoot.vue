<script setup lang="ts">
/**
 * 智能体页的启动屏：边车还没起来的那几秒，用它盖住聊天区。
 *
 * 和首页同一套粒子（同一个组件、同一套物理），只是把图标换成了 DeepSeek 的鲸鱼 ——
 * 路径数据就是侧栏和空态里用的 `ri--deepseek-line`，从 Remix Icon 里抄出来的。
 * 下面一颗橙色呼吸灯：亮度起伏的同时，一圈半透明光晕慢慢向外散开。
 *
 * 只负责「画」。什么时候出现、怎么退场由 Agent.vue 那边的 Transition 决定。
 */
import ParticleLogo from '@/components/ParticleLogo.vue'
import { useI18n } from '@/i18n'

const { t } = useI18n()

// Remix Icon `deepseek-line`，24×24 视框，填充而不是描边
const WHALE = [
  'M19.749 6.703c.6-.611 1.276-.818 2.073-.818c.677 0 1.055-.367 1.347-.65c.215-.21.373-.373.58-.308c.236.073.255.345.236.565c-.176 1.991-1.45 3.612-3.476 3.842c-.187.02-.224.084-.22.247c0 2.554-.987 4.787-2.548 6.737c-.364.454-.28 1.079.269 1.275c.281.101.62.227 1.053.433c.254.122.303.776-.401.926c-.448.093-.934.15-1.421.147c-1.2-.006-2.484.163-3.567.681c-1.13.541-2.172.648-3.139.703c-4.483.266-8.615-3.094-9.39-7.5C.48 9.188 2.572 5.072 6.664 4.612a9.5 9.5 0 0 1 1.422-.055c.79.03 1.536-.144 2.281-.318c.685-.16 1.367-.32 2.08-.32c.843 0 1.006.319.747.412c-.247.09-1.193 1.169-.371 1.768c.753.476 1.395 1.13 2.037 1.783c.841.857 1.683 1.713 2.776 2.171c.183.076.262.038.314-.134q.053-.171.109-.339q.076-.229.146-.462c.042-.131.008-.222-.124-.311c-1.578-1.072-2.3-3.312-1.356-5.038c.202-.363.491-.312.621.072c.155.659.334.979 1.208 1.37c.644.289 1.068.738 1.196 1.492m-7.46 1.455C10.753 7.02 8.799 6.384 6.887 6.6c-1.382.156-2.4.914-3.043 1.947q.334.023.746.084c2.269.333 4.201 1.358 5.8 2.95c.969.965 1.734 2.11 2.435 3.087c.58.808 1.13 1.525 1.77 2.112c1.245-1.07 2.084-2.362 2.455-2.979c.848-1.41.643-1.506-.197-1.902c-.537-.253-1.334-.63-2.28-1.55c-1.013-.982-1.496-1.603-2.284-2.19m-9.173 4.479c.591 3.363 3.592 5.836 7.301 5.85a5.64 5.64 0 0 0 2.474-.575c-.65-.66-1.193-1.386-1.69-2.079c-.76-1.058-1.403-2.02-2.223-2.836c-1.315-1.31-2.862-2.122-4.678-2.389a6 6 0 0 0-1.19-.079a6.2 6.2 0 0 0 .006 2.108m12.078-1.494c-.475-.465-1.293-1.186-2.057-.767C12 11 14.354 13.481 15.472 13.43c1.782-.083.25-1.676-.278-2.286',
]
</script>

<template>
  <div class="absolute inset-0 z-10 flex flex-col items-center justify-center bg-card">
    <ParticleLogo :icon-paths="WHALE" :icon-size="128" text="" icon-fill :pad="80" :step="1.6" :radius="90" />
    <div class="flex items-center gap-3 -mt-6">
      <span class="xg-breath" />
      <span class="text-sm text-muted-foreground tracking-wide">{{ t('agent.booting') }}</span>
    </div>
  </div>
</template>

<style scoped>
/*
  橙色呼吸灯。两层动画叠着跑,周期一样:
    · 灯珠本体:亮度 55% ↔ 100%,亮的时候带一点外发光
    · ::after 那圈光晕:从灯珠大小慢慢撑到 3 倍,同时淡出 —— 「向外扩散」
*/
.xg-breath {
  position: relative;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #f59e0b;
  animation: xg-breathe 2.4s ease-in-out infinite;
}

.xg-breath::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: #f59e0b;
  animation: xg-halo 2.4s ease-out infinite;
}

@keyframes xg-breathe {
  0%, 100% { opacity: 0.55; box-shadow: 0 0 0 0 rgba(245, 158, 11, 0); }
  50%      { opacity: 1;    box-shadow: 0 0 10px 2px rgba(245, 158, 11, 0.45); }
}

@keyframes xg-halo {
  0%   { transform: scale(1);   opacity: 0.45; }
  100% { transform: scale(3.4); opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .xg-breath, .xg-breath::after { animation: none; }
}
</style>
