import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    vue(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  optimizeDeps: {
    /*
      **只从 index.html 出发扫依赖。**

      默认会把项目里所有 .html 都当入口。而 `src-tauri/target/doc/` 下是
      cargo 生成的 Rust 文档（几百 MB、上万个 html），扫到那儿会直接把
      预构建打崩 —— dev 起不来，报错还指向 rav1e 之类根本不相干的名字。
      watch.ignored 挡的是「文件变动」，挡不住这一步。
    */
    entries: ['index.html'],
  },

  /*
    Excalidraw 的构建产物里留着 `process.env.IS_PREACT` 这个判断。
    浏览器里没有 `process`,不喂给它就会在运行时抛 ReferenceError ——
    画布整个白屏。这是官方文档要求 Vite 项目加的一行。
  */
  define: {
    'process.env.IS_PREACT': JSON.stringify('false'),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 5173,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
