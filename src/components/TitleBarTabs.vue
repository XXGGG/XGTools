<script setup lang="ts">
/**
 * 把页面自己的 Tabs 送到顶栏显示。
 *
 * 为什么用 Teleport 而不是把 Tabs 搬进 TitleBar:
 * Tabs 的状态和 TabsContent 属于各自的页面,搬走就要把状态提升到 App 层、每加一个页面改一次。
 * Teleport 只挪 DOM 位置,组件树不变 —— reka-ui 的 Tabs 靠 provide/inject 传上下文,
 * 走的是组件树而不是 DOM 树,所以隔着 Teleport 照样工作。
 *
 * 尺寸对齐:外框 p-1.5(6px) + 内容 h-11(44px) = 58,和侧栏卡片的宽度、右上角圆点卡片的高度
 * 完全一致 —— 这三处共用同一套模数,详见 TitleBar.vue 顶部注释。
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
      absolute + left-1/2:页面切换时,离场的旧视图和入场的新视图会短暂共存,
      两套 Tabs 同时进插槽。若按正常流排布会并排挤出一次布局抖动;
      绝对定位让它们原地重叠,配合页面本身的淡入淡出就是一次交叉淡化。
    -->
    <TabsList class="float-card absolute left-1/2 -translate-x-1/2 h-14 w-max rounded-2xl border bg-card p-1.5 gap-1">
      <slot />
    </TabsList>
  </Teleport>
</template>
