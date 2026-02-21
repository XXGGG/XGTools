import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import "./style.css";

const app = createApp(App);
app.use(createPinia());
app.mount("#app");

// 禁用所有窗口的右键菜单
document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
});
