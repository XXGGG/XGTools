<script setup lang="ts">
/**
 * 把页面自己的 Tabs 送到顶栏显示。
 *
 * 为什么用 Teleport 而不是把 Tabs 搬进 TitleBar:
 * Tabs 的状态和 TabsContent 属于各自的页面,搬走就要把状态提升到 App 层、每加一个页面改一次。
 * Teleport 只挪 DOM 位置,组件树不变 —— reka-ui 的 Tabs 靠 provide/inject 传上下文,
 * 走的是组件树而不是 DOM 树,所以隔着 Teleport 照样工作。
 *
 * 尺寸对齐:高度写死 58px,和侧栏卡片的宽度、右上角圆点卡片的高度完全一致 ——
 * 这三处共用同一套模数,详见 TitleBar.vue 顶部注释。
 * (曾经写 h-14 = 56,比模数矮 2px;别再用 h-* 那档刻度去凑,直接写 58。)
 */
import { ref, onMounted } from 'vue'
import { TabsList } from '@/components/ui/tabs'

// Teleport 的目标在 TitleBar 里。挂载完成前先禁用,免得目标还没进 DOM 就找不到。
const ready = ref(false)
onMounted(() => { ready.value = true })
</script>

<template>
  <Teleport to="#titlebar-slot" :disabled="!ready">
    <!--
      absolute:页面切换时,离场的旧视图和入场的新视图会短暂共存,两套 Tabs 同时进插槽。
      若按正常流排布会并排挤出一次布局抖动;绝对定位让它们原地重叠,
      配合页面本身的淡入淡出就是一次交叉淡化。

      **定位基准是 TitleBar 的根元素,不是插槽。** 插槽已经去掉 relative,
      所以这里的 left-1/2 认的是 TitleBar 根(`absolute left-2.5 right-2.5`)——
      它左右各缩 10px,中线正好是窗口中线,卡片因此是**窗口居中**的。

      别给插槽加回 relative:那样基准会变成插槽自己,而插槽宽度为 0,
      居中就成了"以插槽那个点为心向两边长",卡片一宽就往左漫过去把 Logo 压住。
    -->
    <TabsList class="float-card absolute left-1/2 -translate-x-1/2 h-[58px] w-max rounded-[14px] border bg-card p-1.5 gap-1">
      <slot />
    </TabsList>
  </Teleport>
</template>
