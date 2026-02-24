# TODO

## 待开发功能

### 截图标注手绘风格
- 参考 Excalidraw 的手绘风格，让标注线条、矩形、箭头等有"不完美"的手绘感
- 技术方案：引入 [roughjs](https://roughjs.com/) 替换现有绘制逻辑
- 需要改动：标注系统的矩形、圆形、箭头、画笔等绘制方法
- 可选：引入手写风格字体（如 Virgil）
- 建议开 `feat/hand-drawn-style` 分支开发
