/**
 * 禅模式：把界面上除了正文以外的东西全让开。
 *
 * 状态放在这儿而不是笔记页里，是因为要让开的东西**不都归笔记页管** ——
 * 左边的功能侧栏和右上角那三颗窗口控制点画在 App.vue，笔记页够不着它们。
 *
 * 不进 settings：这是「我现在要写东西」而不是「我一直喜欢这样」。
 * 存下来的话，用户某天进了禅模式直接关掉应用，下次打开面对一个空屏幕，
 * 得先想半天界面去哪了。
 */
import { reactive } from 'vue'

export const zen = reactive({ on: false })

/**
 * 进出禅模式，顺带切窗口全屏。
 *
 * 全屏失败不回滚「让开界面」那一半 —— 那部分本身就成立，
 * 没必要因为窗口管理器不肯全屏就整个功能不给用。
 */
export async function toggleZen(next = !zen.on) {
  zen.on = next
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().setFullscreen(next)
  } catch (e) {
    console.warn('[zen] 切全屏失败:', e)
  }
}
