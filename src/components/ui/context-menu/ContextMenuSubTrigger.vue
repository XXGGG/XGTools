<script setup lang="ts">
import type { ContextMenuSubTriggerProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { ChevronRight } from "lucide-vue-next"
import {
  ContextMenuSubTrigger,
  useForwardProps,
} from "reka-ui"
import { cn } from "@/lib/utils"

const props = defineProps<ContextMenuSubTriggerProps & { class?: HTMLAttributes["class"], inset?: boolean }>()

const delegatedProps = reactiveOmit(props, "class")

const forwardedProps = useForwardProps(delegatedProps)
</script>

<!--
  ⚠ **这个触发行必须由调用方用 `as-child` 自己出 DOM 节点。**

  reka 的 ContextMenuSubTrigger **不把 `class` 和 `data-*` 透到 DOM 上**
  —— 拿探针量过:`data-slot="context-menu-sub-trigger"` 在 DOM 里压根不存在,
  下面那一长串类名一个都没生效。于是「有子菜单的那一行」和它上下的兄弟行长得不一样
  (缩进差一截、没有箭头),而且改这里的类名怎么改都没反应。折腾了三轮才查出来。

  所以用法是(见 Agent.vue / SessionItem.vue):

  ```
  <ContextMenuSubTrigger as-child>
    <div :class="MENU_ROW">图标 + 文字 + 自己的箭头</div>
  </ContextMenuSubTrigger>
  ```

  下面那个 `v-if="!asChild"` 是配套的:as-child 只认**一个**子节点,
  这里再补一个 ChevronRight 就成了第二个 —— 菜单里会多出一整行只有箭头的空行,
  子菜单的定位也跟着乱。所以调用方自己出节点时,这儿就不要再画箭头了。
-->
<template>
  <ContextMenuSubTrigger
    data-slot="context-menu-sub-trigger"
    :data-inset="inset ? '' : undefined"
    v-bind="forwardedProps"
    :class="cn(
      'focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground relative w-full flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=\'size-\'])]:size-4',
      props.class,
    )"
  >
    <slot />
    <ChevronRight v-if="!asChild" class="ml-auto" />
  </ContextMenuSubTrigger>
</template>
