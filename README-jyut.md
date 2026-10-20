[English](README.md) | [官话 - 简体中文](README-cmn_CN.md) | [官話 - 繁體中文](README-cmn_TW.md) | 廣東話

<br>

<p align='center'>
  <img src='public/app-icon.png' width='120' />
</p>

<h1 align='center'>XGTools</h1>

<p align='center'>
  <samp>桌面細工具集 —— 日日要用一用嗰啲細工具，收埋喺一個圖示度</samp>
</p>

<p align='center'>
  <img src="https://img.shields.io/badge/Tauri-v2-FFC131?style=flat-square&logo=tauri" />
  <img src="https://img.shields.io/badge/Vue-3-4FC08D?style=flat-square&logo=vue.js" />
  <img src="https://img.shields.io/badge/Rust-2021-DEA584?style=flat-square&logo=rust" />
  <img src="https://img.shields.io/badge/TypeScript-5.6-3178C6?style=flat-square&logo=typescript" />
  <img src="https://img.shields.io/badge/version-v0.16.3-blue?style=flat-square" />
  <img src="https://img.shields.io/badge/license-CC%20BY--NC--SA%204.0-blue?style=flat-square" />
</p>

<p align='center'>
  <a href="https://github.com/XXGGG/XGTools/releases">下載</a>
</p>

<br>

## 👋 講咩嚟嘅

XGTools 將日日都要用一用嘅細工具 —— 提示詞詞庫、字體庫、音頻試聽、Markdown 筆記、計時器、
翻譯、轉格式、有 OCR 嘅截圖、啟動台 —— 收埋喺系統匣一個圖示度，唔使一樣功能裝一個軟件。

呢個係自己用嘅工具，為一部 Windows 電腦整嘅，原汁原味分享出嚟。

> [!IMPORTANT]
> **v0.16.0 —— 下面列晒嘅都用得，除咗呢幾樣：**「鍵盤桌寵」頁暫時得按鍵顯示，隻寵物仲未整；
> 字體「套用到 Affinity」接好咗連線，仲未搞掂。

<div align="center">
  <img src="docs/images/social-preview.png" width="820" />
</div>

<div align="center">
  <img src="docs/images/screenshot-prompt.png" width="820" />
</div>

## ✨ 邊度唔同

**成塊介面，唔係一疊卡。** 頁面直接鋪喺視窗嘅雲母 / 亞克力材質上面，得左邊導航欄同頂頭分頁係面板，
而且都係通透嘅。清單碌到邊度係慢慢淡出，唔係俾卡片邊框一刀切走。

**識得同其他軟件夾手嘅字體庫。** 撳一款字，Photoshop、達芬奇（Fusion 嘅 Text+）、PhotoCraft
入面揀咗嘅字就即刻換晒。字體裝入 Windows 嘅個人字體資料夾，同右鍵「安裝」一模一樣，個個軟件都認得；
仲有個置頂嘅 mini 細窗，將成日用嘅字擺喺你做緊圖嗰個軟件隔籬。每款字都會睇埋授權，話你知可唔可以
打包入遊戲、擺落片度、做圖印刷。

<div align="center">
  <img src="docs/images/screenshot-fonts.png" width="820" />
</div>

**為二次元模型度身訂造嘅提示詞詞庫。** 大約 2250 個 Danbooru 標籤、139 個細類，按層上色（質素、
鏡頭、場景、人物、衫褲、動作……），按意思去重，搜尋識得同義詞。自然語言窗口將中文描述執成
Anima 呢類模型食得落嘅英文句子；成日用嘅組合可以存做預設。

**自己識更新。** 新版本放喺 GitHub Releases，軟件一開就會檢查，撳一下就下載安裝（有簽名驗證，
俾人改過嘅安裝檔會俾拒絕）。

<div align="center">
  <img src="docs/images/screenshot-audio.png" width="820" />
</div>

## 🚀 點開始

去 [Releases](https://github.com/XXGGG/XGTools/releases/latest) 下載安裝檔 —— 裝好之後，
更新喺軟件入面搞掂。或者自己 build：

```bash
pnpm install

# Format conversion needs ffmpeg — drop ffmpeg.exe and ffprobe.exe into
# src-tauri/resources/ffmpeg/  (https://github.com/BtbN/FFmpeg-Builds/releases)

pnpm tauri dev      # development
pnpm dist           # installer -> installer/
```

要咩環境：Node.js 18+、Rust 1.77+、pnpm，Windows 10/11 —— 好幾樣功能直接 call Win32 API，冇得跨平台。

## 📦 有啲乜

| | |
|---|---|
| **提示詞** | Danbooru 標籤詞庫，分層配色、搜尋、預設，仲有自然語言 → 提示詞窗口 |
| **筆記** | 本機 Markdown 筆記：分頁、反向連結、歷史版本、畫布 |
| **字體庫** | 授權體檢、一撳安裝、套用到其他軟件、mini 細窗、成行拖字體檔出去 |
| **音頻試聽** | 音效庫波形睇法：剪、轉格式、直接拖入專案 |
| **計時器** | 用空格掣嘅扭計骰計時，加一個轉頁都唔停嘅番茄鐘錶盤 |
| **翻譯** | 離線（Bergamot）或者網上引擎，亦都接得任何 OpenAI 相容嘅大模型 |
| **轉格式** | 圖片、聲、片，用內置嘅 ffmpeg |
| **啟動台** | 全螢幕程式格仔，拖嚟拖去排次序，資料夾換圖示 |
| **截圖** | 框選、標註、釘喺螢幕、錄影、OCR、原地翻譯 |
| **命令面板** | 一個快捷鍵搵程式、筆記、檔案，或者直接翻譯 |

<div align="center">
  <img src="docs/images/screenshot-notes.png" width="820" />
</div>

<div align="center">
  <img src="docs/images/screenshot-timer.png" width="820" />
</div>

## 📁 結構

```
src/
  App.vue                    window routing + the floating chrome
  components/TitleBar.vue    teleport target for page tabs, window controls
  composables/               shared reactive settings (settings.json), updater
  lib/sidebar-prefs.ts       sidebar order/visibility reconciliation (pure, testable)
  lib/prompt/                prompt tag library, dedupe, synonyms
  views/                     one file per tool page
src-tauri/src/
  window_effects.rs          mica / acrylic, and the dark-mode attribute Windows needs
  font_commands.rs           font scan / install (per-user Fonts folder + shared ledger)
  font_apply.rs              apply a font to Photoshop / DaVinci Resolve / PhotoCraft
  *_commands.rs              screenshot, OCR, translate, convert, audio, launcher
```

## 🙏 多謝

**框架** —— [Tauri](https://tauri.app)、[Vue.js](https://vuejs.org)、
[Tailwind CSS](https://tailwindcss.com)
**介面** —— [shadcn-vue](https://www.shadcn-vue.com)（用嘅係 [reka-ui](https://reka-ui.com)）、
[Lucide](https://lucide.dev) 圖示
**截圖與 OCR** —— [xcap](https://github.com/nashaofu/xcap)、
[PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)、
[ONNX Runtime](https://onnxruntime.ai)
**輸入與特效** —— [rdev](https://github.com/Narsil/rdev)、
[window-vibrancy](https://github.com/tauri-apps/window-vibrancy)
**離線翻譯** —— [Bergamot](https://browser.mt) 同 Mozilla 嘅翻譯模型
**提示詞標籤** —— 標籤名跟足 [Danbooru](https://danbooru.donmai.us)

程式圖示係一個口袋，由零開始畫 —— **諗頭**嚟自叮噹嘅四次元百寶袋，乜嘢法寶都係由入面掏出嚟。
攞嚟做工具箱就啱晒。

README 版面參考 [vitesse](https://github.com/antfu-collective/vitesse) 同
[BewlyBewly](https://github.com/BewlyBewly/BewlyBewly)。

## 授權

[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hant) —— 隨便用、
隨便改、隨便分享，要註明出處、**唔可以商用**、改出嚟嘅嘢要用同一個授權。

Copyright © 2026 [Xie Xiage](https://github.com/XXGGG)
