<script setup lang="ts">
import type { DropdownMenuSubContentEmits, DropdownMenuSubContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import {
  ContextMenuPortal,
  ContextMenuSubContent,
  useForwardPropsEmits,
} from "reka-ui"
import { cn } from "@/lib/utils"

const props = defineProps<DropdownMenuSubContentProps & { class?: HTMLAttributes["class"] }>()
const emits = defineEmits<DropdownMenuSubContentEmits>()

const delegatedProps = reactiveOmit(props, "class")

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<!--
  子菜单必须套在 Portal 里。

  reka 的子菜单内容不像顶层内容那样自带传送门,少了这一层它**根本不渲染** ——
  触发行会亮起来(状态确实是 open),右边却什么都不出来,看着像「这个菜单点不开」。
  shadcn-vue 生成的这份模板漏了它,自己补上。
-->
<template>
  <ContextMenuPortal>
  <ContextMenuSubContent
    data-slot="context-menu-sub-content"
    v-bind="forwarded"
    :class="
      cn(
        'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] origin-(--reka-context-menu-content-transform-origin) overflow-hidden rounded-md border p-1 shadow-lg',
        props.class,
      )
    "
  >
    <slot />
  </ContextMenuSubContent>
  </ContextMenuPortal>
</template>
