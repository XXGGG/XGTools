/**
 * 引擎那盏灯 —— 边车现在到底能不能用,以及一句人话。
 *
 * 从智能体页搬出来的。以前它只在会话侧栏底下那一条里,而现在这盏灯挪到了
 * 窗口右上角(和三颗控制点并排,占住顶上那一行),智能体页里别的地方也要用同一句话 ——
 * 同一件事说两遍迟早会说岔:一个显示「已连接」另一个还写着「未启动」,
 * 用户没法判断该信哪个。所以判断只写这一份。
 *
 * **装没装是引导页的事,跑没跑才是这盏灯的事。**
 * 混在一起会出现「绿灯但没装」这种自相矛盾的显示。
 */
import { computed } from 'vue'
import { useI18n } from '@/i18n'
import { dsh, dshUsable, startDsh, resetRevive } from './useDsh'
import { chat, chatReady } from './useDshChat'

export function useDshStatus() {
  const { t } = useI18n()

  const dot = computed(() => ({
    stopped: 'bg-muted-foreground/50',
    starting: 'bg-amber-500 animate-pulse',
    ready: 'bg-emerald-500',
    failed: 'bg-red-500',
  }[dsh.state.phase]))

  /**
   * 失败原因排在「没装」前面。
   * 反过来写过一版:安装失败时这里显示的还是「未安装 DSH」—— 说的是事实,
   * 但把真正的原因盖掉了,用户只看到红灯配一句废话,完全没法排查。
   * 有具体报错就一定要让它冒出来。
   */
  const label = computed(() => {
    if (dsh.installing) return t('agent.installing')
    if (chat.error) return chat.error
    if (dsh.state.phase === 'failed' && dsh.state.message) return dsh.state.message
    // 边车起来了但事件流还没通,不能说「已连接」—— 那样用户发消息会石沉大海
    if (dsh.state.phase === 'ready' && !chatReady.value) return t('agent.stateStarting')
    if (!dsh.pre) return t('agent.stateStopped')
    if (!dsh.pre.nodeOk) return t('agent.stateNoNode')
    if (!dsh.pre.pnpmVersion) return t('agent.stateNoPnpm')
    if (!dsh.pre.dshEntry) return t('agent.stateNotInstalled')
    return t(`agent.state${dsh.state.phase[0].toUpperCase()}${dsh.state.phase.slice(1)}`)
  })

  const canStart = computed(() =>
    dshUsable.value && (dsh.state.phase === 'stopped' || dsh.state.phase === 'failed'))

  const busy = computed(() => dsh.state.phase === 'starting' || dsh.installing)

  function click() {
    if (canStart.value) (resetRevive(), startDsh())
  }

  return { dot, label, canStart, busy, click }
}
