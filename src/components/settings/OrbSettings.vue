<script setup lang="ts">
/**
 * 语音助手那颗球的外观：待命 / 对话两套（颜色、自转、亮度，对话时还有起伏），加上粒子飘散快慢、想事情时的自旋。
 * 直接改 lib/orbLook 的全局状态，球那边实时跟着变；每一行和默认值不一样时，行尾有个「恢复默认」。
 */
import { onBeforeUnmount, onMounted } from 'vue'
import { Slider } from '@/components/ui/slider'
import InfoTip from '@/components/InfoTip.vue'
import ResetBtn from '@/components/settings/ResetBtn.vue'
import { loadOrbLook, ORB_DEFAULTS, orbLook, orbPreview, resetOrbLook, type OrbMood } from '@/lib/orbLook'

/** 颜色用色块挑（不用浏览器自带的取色器） */
const SWATCHES = ['#e6ecf8', '#fbfdff', '#bfe0ff', '#8fd8ff', '#9fb4ff', '#c4a8ff', '#ffb3e1', '#ff9eae', '#ffd28f', '#b8f5c8']

const GROUPS: { key: 'idle' | 'talk'; title: string; tip: string }[] = [
  { key: 'idle', title: '待命时', tip: '没在跟你说话的时候。' },
  { key: 'talk', title: '对话时', tip: '点了它、它在听你说或者在回答你的时候。起伏是它说话时跟着声音胀缩的幅度。' },
]

// 亮度最高 100%：再往上粒子叠在一起就只剩一团实心的光
const SLIDERS: { key: 'spin' | 'swell' | 'bright'; label: string; min: number; max: number; step: number; fmt: (v: number) => string }[] = [
  { key: 'spin', label: '自转', min: 0, max: 3, step: 0.05, fmt: v => v.toFixed(2) },
  { key: 'swell', label: '起伏', min: 0, max: 3, step: 0.1, fmt: v => `${Math.round(v * 100)}%` },
  { key: 'bright', label: '亮度', min: 0.1, max: 1, step: 0.05, fmt: v => `${Math.round(v * 100)}%` },
]

const setMood = <K extends keyof OrbMood>(g: 'idle' | 'talk', k: K, v: OrbMood[K]) => { orbLook[g][k] = v }

onMounted(loadOrbLook)
onBeforeUnmount(() => { orbPreview.value = null })
</script>

<template>
  <div class="space-y-5">
    <!-- 鼠标在哪一块，球就演示哪一种样子（见 lib/orbLook 的 orbPreview） -->
    <section v-for="g in GROUPS" :key="g.key" class="space-y-2"
      @pointerenter="orbPreview = g.key" @pointerleave="orbPreview = null">
      <h3 class="text-sm font-medium flex items-center gap-1.5">{{ g.title }}<InfoTip :text="g.tip" /></h3>
      <div class="rounded-xl border divide-y">
        <div v-for="part in (['shell', 'core'] as const)" :key="part" class="flex items-center gap-3 px-4 py-3">
          <div class="w-10 text-sm shrink-0">{{ part === 'shell' ? '外壳' : '内核' }}</div>
          <div class="flex-1 flex flex-wrap gap-1.5">
            <button v-for="c in SWATCHES" :key="c" class="size-5 rounded-full border transition-transform hover:scale-110"
              :class="orbLook[g.key][part] === c ? 'ring-2 ring-primary ring-offset-1 ring-offset-background' : 'border-border'"
              :style="{ background: c }" :title="c" @click="setMood(g.key, part, c)" />
          </div>
          <ResetBtn :show="orbLook[g.key][part] !== ORB_DEFAULTS[g.key][part]" @reset="setMood(g.key, part, ORB_DEFAULTS[g.key][part])" />
        </div>
        <!-- 待命时不说话，没有起伏可调 -->
        <div v-for="s in SLIDERS.filter(x => g.key === 'talk' || x.key !== 'swell')" :key="s.key" class="flex items-center gap-3 px-4 py-3">
          <div class="w-10 text-sm shrink-0">{{ s.label }}</div>
          <Slider :model-value="[orbLook[g.key][s.key]]" :min="s.min" :max="s.max" :step="s.step" class="flex-1"
            @update:model-value="(v) => { if (v) setMood(g.key, s.key, v[0]) }" />
          <span class="w-11 text-right text-xs tabular-nums text-muted-foreground">{{ s.fmt(orbLook[g.key][s.key]) }}</span>
          <ResetBtn :show="orbLook[g.key][s.key] !== ORB_DEFAULTS[g.key][s.key]" @reset="setMood(g.key, s.key, ORB_DEFAULTS[g.key][s.key])" />
        </div>
      </div>
    </section>

    <section class="space-y-2">
      <h3 class="text-sm font-medium">粒子</h3>
      <div class="rounded-xl border divide-y">
        <div class="flex items-center gap-3 px-4 py-3" @pointerenter="orbPreview = 'talk'" @pointerleave="orbPreview = null">
          <div class="w-20 shrink-0 text-sm whitespace-nowrap flex items-center gap-1">飘散<InfoTip text="粒子流动、飘散的快慢。" /></div>
          <Slider :model-value="[orbLook.drift]" :min="0.1" :max="3" :step="0.05" class="flex-1"
            @update:model-value="(v) => { if (v) orbLook.drift = v[0] }" />
          <span class="w-11 text-right text-xs tabular-nums text-muted-foreground">{{ Math.round(orbLook.drift * 100) }}%</span>
          <ResetBtn :show="orbLook.drift !== ORB_DEFAULTS.drift" @reset="orbLook.drift = ORB_DEFAULTS.drift" />
        </div>
        <div class="flex items-center gap-3 px-4 py-3" @pointerenter="orbPreview = 'think'" @pointerleave="orbPreview = null">
          <div class="w-20 shrink-0 text-sm whitespace-nowrap flex items-center gap-1">思考自旋<InfoTip text="它在想怎么回答你的时候转多快。" /></div>
          <Slider :model-value="[orbLook.thinkSpin]" :min="0.5" :max="10" :step="0.1" class="flex-1"
            @update:model-value="(v) => { if (v) orbLook.thinkSpin = v[0] }" />
          <span class="w-11 text-right text-xs tabular-nums text-muted-foreground">{{ orbLook.thinkSpin.toFixed(1) }}</span>
          <ResetBtn :show="orbLook.thinkSpin !== ORB_DEFAULTS.thinkSpin" @reset="orbLook.thinkSpin = ORB_DEFAULTS.thinkSpin" />
        </div>
      </div>
      <button class="text-xs text-muted-foreground hover:text-foreground" @click="resetOrbLook">全部恢复默认</button>
    </section>
  </div>
</template>
