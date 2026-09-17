<script setup lang="ts">
/**
 * 把一款字体放进四个场景里看：游戏对话框、视频字幕、视频封面、海报。
 *
 * 对的就是这个页面的三种用途。一行样张只能看出「字长什么样」，
 * 放进场景里才看得出「压在画面上行不行」—— 字幕描了黑边还认不认得出、
 * 对话框里一行放得下几个字、封面标题够不够抢眼。
 *
 * 字号用容器宽度的百分比（cqw），面板多宽场景就等比缩放，比例永远是对的。
 */
import { computed, ref } from 'vue'
import { SCENES } from '@/lib/fontSamples'

const props = defineProps<{
  /** font-family；null 时整块显示「画不出来」 */
  family: string | null
  /** 只有西文的字体：场景里换成西文 */
  latin: boolean
  /** 用户自己打的那句话。有就替换每个场景的主文字 */
  custom: string
  labels: { game: string; subtitle: string; cover: string; poster: string }
  failLabel: string
}>()

type Scene = 'game' | 'subtitle' | 'cover' | 'poster'
const scene = ref<Scene>('game')
const scenes: Scene[] = ['game', 'subtitle', 'cover', 'poster']

const g = SCENES.game
const text = computed(() => {
  const L = props.latin
  const c = props.custom.trim()
  return {
    speaker: L ? g.latinSpeaker : g.speaker,
    line: c || (L ? g.latinLine : g.line),
    menu: L ? g.latinMenu : g.menu,
    sub: c || (L ? SCENES.subtitle.latin : SCENES.subtitle.zh),
    coverTitle: c || (L ? SCENES.cover.latinTitle : SCENES.cover.title),
    coverTag: L ? SCENES.cover.latinTag : SCENES.cover.tag,
    posterTitle: c || (L ? SCENES.poster.latinTitle : SCENES.poster.title),
  }
})
/** 中文海报竖着排；西文、或者用户打了一长句，就横着排 */
const vertical = computed(() => !props.latin && text.value.posterTitle.length <= 8)
const ff = computed(() => ({ fontFamily: props.family ?? undefined }))
</script>

<template>
  <div class="flex flex-col gap-2">
    <div class="flex items-center rounded-lg bg-muted/60 p-0.5 self-start">
      <button v-for="s in scenes" :key="s" @click="scene = s"
        class="h-7 px-2.5 rounded-md text-[12px] transition-colors whitespace-nowrap"
        :class="scene === s ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'">
        {{ labels[s] }}
      </button>
    </div>

    <div v-if="!family" class="rounded-xl border border-dashed p-6 text-center text-[12px] text-muted-foreground">
      {{ failLabel }}
    </div>

    <!-- ── 游戏对话框：夜里的森林，左上血条，右边菜单，底下对话 ── -->
    <div v-else-if="scene === 'game'" class="scene aspect-[16/9]" :style="ff"
      style="background: radial-gradient(120% 80% at 70% 0%, #2c4466 0%, #16243a 45%, #0b1220 100%)">
      <div class="absolute rounded-full" style="left: 56%; top: 8%; width: 7cqw; height: 7cqw;
        background: radial-gradient(circle at 40% 40%, #fff7d6, #f3d98a 60%, transparent 62%)" />
      <div class="absolute inset-x-0 bottom-0 h-[46%]" style="background:
        linear-gradient(to top, #07100b 30%, transparent),
        repeating-linear-gradient(90deg, #0d1e16 0 6cqw, #10271c 6cqw 9cqw)" />
      <div class="absolute left-[4%] top-[6%] flex flex-col gap-[1.2cqw] text-[3.4cqw] text-[#f4f1e6]">
        <div class="flex items-center gap-[1.5cqw]">
          <span>{{ g.hp }}</span>
          <span class="block h-[1.6cqw] w-[16cqw] rounded-sm bg-black/50 overflow-hidden">
            <span class="block h-full w-[40%] bg-[#e5484d]" />
          </span>
        </div>
        <span class="text-[#f3d98a]">{{ g.lv }}</span>
      </div>
      <div class="absolute right-[4%] top-[26%] flex flex-col gap-[1.4cqw] text-[3.6cqw] text-[#f4f1e6]">
        <span v-for="(m, i) in text.menu" :key="m" class="flex items-center gap-[1cqw]"
          :class="i === 0 ? 'text-[#f3d98a]' : 'opacity-80'">
          <!-- 光标用 CSS 画的三角：▶ 这个字很多字体里没有，会被画成缺字框，那不是这款字的问题 -->
          <span class="w-[2.4cqw] flex justify-center">
            <span v-if="i === 0" class="block w-0 h-0 border-y-[0.9cqw] border-y-transparent border-l-[1.3cqw] border-l-current" />
          </span>{{ m }}
        </span>
      </div>
      <div class="absolute left-[4%] right-[4%] bottom-[5%] rounded-[1.2cqw] px-[3cqw] pt-[3.2cqw] pb-[2.6cqw]"
        style="background: rgba(8, 12, 20, 0.86); border: 0.5cqw solid #e8d9a8; box-shadow: 0 0 0 0.5cqw #1a1f2b">
        <span class="absolute -top-[2.6cqw] left-[3cqw] rounded-[0.8cqw] px-[1.6cqw] py-[0.3cqw] text-[3.2cqw]"
          style="background: #e8d9a8; color: #1a1f2b">{{ text.speaker }}</span>
        <p class="text-[4cqw] leading-[1.45] text-[#f4f1e6] line-clamp-2">{{ text.line }}</p>
      </div>
    </div>

    <!-- ── 视频字幕：傍晚街景，底下白字黑边 ── -->
    <div v-else-if="scene === 'subtitle'" class="scene aspect-[16/9]" :style="ff"
      style="background: linear-gradient(180deg, #f6b26b 0%, #e07a5f 42%, #5b4a86 100%)">
      <div class="absolute inset-x-0 bottom-0 h-[48%]" style="background:
        linear-gradient(to top, rgba(20, 16, 40, 0.85), transparent),
        repeating-linear-gradient(90deg, rgba(30, 24, 60, 0.9) 0 7cqw, rgba(44, 34, 80, 0.9) 7cqw 11cqw, transparent 11cqw 13cqw)" />
      <p class="absolute inset-x-[6%] bottom-[7%] text-center text-[4.6cqw] leading-[1.35] text-white subtitle">
        {{ text.sub }}
      </p>
    </div>

    <!-- ── 视频封面：大色块、大标题、斜着的角标 ── -->
    <div v-else-if="scene === 'cover'" class="scene aspect-[16/9]" :style="ff" style="background: #ffd23f">
      <div class="absolute -right-[8%] -bottom-[30%] w-[60%] aspect-square rounded-full bg-[#ff6b35]" />
      <div class="absolute left-[6%] top-[14%] right-[6%] flex flex-col items-start gap-[2cqw]">
        <span class="rounded-[1cqw] bg-[#1b1b1b] px-[1.8cqw] py-[0.6cqw] text-[3.2cqw] text-[#ffd23f] -rotate-3">
          {{ text.coverTag }}
        </span>
        <p class="text-[11cqw] leading-[1.05] text-[#1b1b1b] line-clamp-2 cover">{{ text.coverTitle }}</p>
      </div>
    </div>

    <!-- ── 海报：宣纸色，中文竖排 ── -->
    <div v-else class="scene aspect-[3/4] max-w-[78%] self-center w-full" :style="ff" style="background: #f1ece2; color: #1d1d1b">
      <div class="absolute inset-[5%] border border-[#1d1d1b]/25" />
      <div class="absolute right-[9%] top-[9%] bottom-[20%] flex"
        :class="vertical ? 'items-start' : 'left-[9%] items-center justify-center'">
        <p :class="vertical ? 'text-[15cqw] leading-[1.1] tracking-[0.12em]' : 'text-[12cqw] leading-[1.1] text-center'"
          :style="vertical ? { writingMode: 'vertical-rl' } : undefined">{{ text.posterTitle }}</p>
      </div>
      <div class="absolute left-[9%] bottom-[8%] right-[9%] flex flex-col gap-[1.2cqw]">
        <span class="text-[3.2cqw] tracking-[0.18em] opacity-70">{{ SCENES.poster.sub }}</span>
        <span class="text-[3.6cqw] tabular-nums">{{ SCENES.poster.date }}</span>
      </div>
      <div class="absolute left-[9%] top-[9%] w-[7cqw] h-[7cqw] rounded-[1cqw] bg-[#c0392b]" />
    </div>
  </div>
</template>

<style scoped>
.scene {
  position: relative;
  width: 100%;
  overflow: hidden;
  border-radius: 12px;
  container-type: inline-size;
}
/* 字幕的黑边：先描边再填色，描边不吃进字里 */
.subtitle {
  -webkit-text-stroke: 0.9cqw #111;
  paint-order: stroke fill;
  text-shadow: 0 0.4cqw 1.2cqw rgba(0, 0, 0, 0.45);
}
.cover {
  text-shadow: 0.6cqw 0.6cqw 0 rgba(255, 255, 255, 0.55);
}
</style>
