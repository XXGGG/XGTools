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
  const show = (label: string, err: unknown) => {
    const box = document.getElementById('xg-dev-error') ?? (() => {
      const d = document.createElement('div')
      d.id = 'xg-dev-error'
      d.style.cssText = 'position:fixed;inset:auto 0 0 0;z-index:99999;max-height:45vh;overflow:auto;'
        + 'background:#7f1d1d;color:#fff;font:12px/1.5 Consolas,monospace;padding:10px 14px;white-space:pre-wrap'
      document.body.appendChild(d)
      return d
    })()
    const e = err as Error
    box.textContent += `[${label}] ${e?.message ?? String(err)}\n${e?.stack ?? ''}\n\n`
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
