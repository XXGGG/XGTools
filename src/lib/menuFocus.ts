/*
  从右键菜单里进「原地改名」时，reka-ui 的菜单会跟输入框抢两次焦点：

  1. 点下菜单项的那一刻菜单还开着，焦点被锁在菜单里。
     这时候去聚焦输入框，会被当场拽回菜单项 —— 框出来了，光标却不在里面。
  2. 菜单收起动画播完，它把焦点还给右键的那一行（比一帧还晚）。
     输入框随之失焦，失焦又被当成「改完了」提交，用户看到的就是框闪一下就没了。

  所以：聚焦等到下一帧（菜单已经关了、锁已经解了），
  菜单收起时那次焦点归还挡掉 —— 焦点本来就该留在输入框里。

  用法：菜单项 @select 里先 arm()，再 focusSoon(...)；
  那份 ContextMenuContent 挂 @close-auto-focus="onCloseAutoFocus"。
*/

export function menuFocusHandoff() {
  let armed = false
  return {
    /** 这次菜单关掉时别把焦点还回去 */
    arm() { armed = true },
    /** 挂在 ContextMenuContent 的 close-auto-focus 上 */
    onCloseAutoFocus(e: Event) {
      if (!armed) return
      armed = false
      e.preventDefault()
    },
    /** 等菜单放开焦点之后再聚焦 */
    focusSoon(fn: () => void) { requestAnimationFrame(fn) },
    disarm() { armed = false },
  }
}
