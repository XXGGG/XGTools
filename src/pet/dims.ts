/**
 * 桌宠舞台尺寸（CSS px，窗口大小 = 它 × 缩放）。
 * 单独放一个文件：主窗口的设置页要用它算窗口大小，从这里拿就不会顺带把 three.js / 绘图核心打进主窗口。
 */
export const STAGE_W = 440
export const STAGE_H = 270
/** 键盘款 */
export const KB_W = 420
export const KB_H = 200

export type PetKind = 'keyboard' | 'animals'
export const stageSize = (kind: PetKind) => (kind === 'keyboard' ? { w: KB_W, h: KB_H } : { w: STAGE_W, h: STAGE_H })
