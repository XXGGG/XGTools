import { createApp } from "vue";
import App from "./App.vue";
import "./style.css";

createApp(App).mount("#app");

// 禁用所有窗口的右键菜单
document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
});
