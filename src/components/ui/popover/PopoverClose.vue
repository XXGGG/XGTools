<script setup lang="ts">
/**
 * 点了就把这个下拉收起来。
 *
 * 菜单里选完一项之后它该消失 —— 这是所有下拉的常识,但 reka 的 Popover
 * 默认不收(它不知道你这一项算不算「选完了」)。包一层 `PopoverClose as-child`,
 * 里面那个按钮该长什么样还长什么样,只是多了「点完就关」这件事。
 *
 * 不适合包的:那种「点一下改一个开关、还想接着改下一项」的行 ——
 * 那种收起来反而要重开一次。
 */
import { PopoverClose } from "reka-ui"

defineOptions({ inheritAttrs: false })
</script>

<template>
  <PopoverClose v-bind="$attrs" data-slot="popover-close">
    <slot />
  </PopoverClose>
</template>
