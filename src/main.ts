import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import "./style.css";

const app = createApp(App);

/*
  开发时把运行时报错摆到界面上。

  这是个桌面壳,不是浏览器 —— 没有地址栏、没有随手 F12 的习惯,
  而 Vue 在渲染里抛错的表现常常是「画面还在,但点什么都没反应」,
  光看界面完全猜不到出了什么事。vite 只兜编译期错误,运行期这段是空的。

  打包版本不挂:真出错了给用户看堆栈没有意义。
*/
if (import.meta.env.DEV) {
  const seen = new Map<string, HTMLElement>()

  const panel = () => {
    let box = document.getElementById('xg-dev-error')
    if (box) return box
    box = document.createElement('div')
    box.id = 'xg-dev-error'
    /*
      **不能长到挡住半个界面。**

      这块以前是 `inset:auto 0 0 0` 加 45vh 高,一条报错重复几次就铺满下半屏,
      而且它是能接鼠标的 —— 底下的界面点不到、也刮选不了,人只会以为是功能坏了。
      现在压成一条,超了自己滚,右上角给个叉。
    */
    box.style.cssText = 'position:fixed;inset:auto 0 0 0;z-index:99999;max-height:26vh;overflow:auto;'
      + 'background:#7f1d1d;color:#fff;font:12px/1.5 Consolas,monospace;padding:8px 14px 10px;white-space:pre-wrap'
    const close = document.createElement('button')
    close.textContent = '×'
    close.title = '关掉这块(只是隐藏,不影响报错本身)'
    close.style.cssText = 'position:sticky;top:0;float:right;width:22px;height:22px;margin-left:8px;'
      + 'border:1px solid rgb(255 255 255 / .35);border-radius:6px;background:transparent;color:#fff;'
      + 'font:14px/1 Consolas,monospace;cursor:pointer'
    close.onclick = () => { box!.remove(); seen.clear() }
    box.appendChild(close)
    document.body.appendChild(box)
    return box
  }

  const show = (label: string, err: unknown) => {
    const e = err as Error
    const text = `[${label}] ${e?.message ?? String(err)}
${e?.stack ?? ''}`
    /*
      同一条报错只占一行,后面记个次数。
      一个循环里抛出来的错会几十条一模一样地刷屏,那样什么都看不见。
    */
    const old = seen.get(text)
    if (old) {
      const n = Number(old.dataset.n ?? '1') + 1
      old.dataset.n = String(n)
      old.textContent = `${text}
(×${n})
`
      return
    }
    const line = document.createElement('div')
    line.textContent = `${text}
`
    seen.set(text, line)
    panel().appendChild(line)
  }

  app.config.errorHandler = (err, _vm, info) => show(`vue:${info}`, err)
  window.addEventListener('error', (e) => show('error', e.error ?? e.message))
  window.addEventListener('unhandledrejection', (e) => show('reject', e.reason))
}

app.use(createPinia());
app.mount("#app");

// 禁用所有窗口的右键菜单
document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
});
