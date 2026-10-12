/**
 * 桌宠脚下那块键盘：three.js 真 3D 渲染，不描边，立体感全靠光影。
 *
 * 角度是用户 2026-10-12 在取景台（three.js 页面）里亲手调好发回来的：
 * 左右转 3°、往下看 31°、距离 19、透视 32°、光从左边 35°。场景、材质、灯光跟取景台一模一样，
 * 窗口里只是从那张大图上「裁」出键盘那一块（setViewOffset），所以透视关系不会变。
 *
 * 只在键帽动的时候才渲染，平时一帧都不画，GPU 不干活。
 */
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'

export const VIEW = { azimuth: 3, elevation: 31, distance: 19, fov: 32, light: -35 }
const TARGET = new THREE.Vector3(0, 0.4, 0.2)

/** 底座：圆角厚板（世界单位） */
export const BASE = { w: 10, h: 0.7, d: 5.4 }
/** 键帽高、进深、间隔；前排四个键靠底座前沿 */
const KH = 0.55
const KD = 1.05
const GAP = 0.16
const KEYS = [
  { k: 'ctrl', w: 1.35 },
  { k: 'shift', w: 1.6 },
  { k: 'space', w: 3.7 },
  { k: 'enter', w: 1.7 },
]
export const KEY_Z = BASE.d / 2 - 0.35 - KD / 2
/** 键帽后沿顶上那条线：站在键帽后面的小动物，脚不能低过它 */
export const KEY_BACK = { y: BASE.h + KH, z: KEY_Z - KD / 2 }

const deg = Math.PI / 180
/** 留给底座在地上投的影子：光从左前方来，影子往右后方落 */
const MARGIN = { left: 12, right: 26, bottom: 12 }

// 取景台用的是 three r147 的旧色彩管线（颜色值直接当线性用、灯光强度自带 ×π），
// 这里关掉色彩管理、灯光乘回 π，出来的颜色和明暗才跟用户挑中的那张一样
THREE.ColorManagement.enabled = false

function rainbow() {
  const c = document.createElement('canvas')
  c.width = 512
  c.height = 8
  const g = c.getContext('2d')!
  const gr = g.createLinearGradient(0, 0, 512, 0)
  const stops = ['#ff7cc4', '#ffd45c', '#6fe3a2', '#5cc3ff', '#b08cff', '#ff7cc4']
  stops.forEach((col, i) => gr.addColorStop(i / (stops.length - 1), col))
  g.fillStyle = gr
  g.fillRect(0, 0, 512, 8)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = THREE.RepeatWrapping
  return t
}

export function createKeyboard(W: number, H: number) {
  const canvas = document.createElement('canvas')
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
  renderer.setClearColor(0x000000, 0)
  renderer.setPixelRatio(window.devicePixelRatio || 1)
  renderer.setSize(W, H)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05

  const scene = new THREE.Scene()
  scene.add(new THREE.HemisphereLight(0xfff6ec, 0x8a7f78, 0.75 * Math.PI))
  const sun = new THREE.DirectionalLight(0xffffff, 1.35 * Math.PI)
  const a = VIEW.light * deg
  sun.position.set(Math.sin(a) * 12, 14, Math.cos(a) * 8 + 4)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9 })
  sun.shadow.bias = -0.0005
  scene.add(sun)

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.ShadowMaterial({ opacity: 0.18 }))
  ground.rotation.x = -Math.PI / 2
  ground.receiveShadow = true
  scene.add(ground)

  const base = new THREE.Mesh(
    new RoundedBoxGeometry(BASE.w, BASE.h, BASE.d, 6, 0.32),
    new THREE.MeshStandardMaterial({ color: 0xf6ece0, roughness: 0.72 }),
  )
  base.position.y = BASE.h / 2
  base.castShadow = true
  base.receiveShadow = true
  scene.add(base)

  // 四个键帽共用一条彩虹，每个键只取自己那一段
  const keys = new Map<string, { mesh: THREE.Mesh; rest: number; target: number }>()
  const total = KEYS.reduce((s, k) => s + k.w, 0) + GAP * (KEYS.length - 1)
  let x = -total / 2
  for (const k of KEYS) {
    const tex = rainbow()
    tex.repeat.set(k.w / total, 1)
    tex.offset.set((x + total / 2) / total, 0)
    const mesh = new THREE.Mesh(
      new RoundedBoxGeometry(k.w, KH, KD, 5, 0.16),
      new THREE.MeshPhysicalMaterial({ map: tex, roughness: 0.38, clearcoat: 0.6, clearcoatRoughness: 0.35 }),
    )
    const rest = BASE.h + KH / 2
    mesh.position.set(x + k.w / 2, rest, KEY_Z)
    mesh.castShadow = true
    mesh.receiveShadow = true
    scene.add(mesh)
    keys.set(k.k, { mesh, rest, target: rest })
    x += k.w + GAP
  }

  // ── 镜头：先按取景台的参数摆好，再从整张图里裁出底座那一块 ──
  const camera = new THREE.PerspectiveCamera(VIEW.fov, 2, 0.1, 200)
  const { azimuth: az, elevation: el, distance: r } = VIEW
  camera.position.set(
    TARGET.x + r * Math.cos(el * deg) * Math.sin(az * deg),
    TARGET.y + r * Math.sin(el * deg),
    TARGET.z + r * Math.cos(el * deg) * Math.cos(az * deg),
  )
  camera.lookAt(TARGET)
  camera.updateMatrixWorld()
  camera.updateProjectionMatrix()
  // 整张图高 1 时，底座八个角落在哪（横向按画幅比例展开）
  let minU = Infinity, maxU = -Infinity, maxV = -Infinity
  for (const sx of [-1, 1]) for (const sy of [0, 1]) for (const sz of [-1, 1]) {
    const v = new THREE.Vector3((sx * BASE.w) / 2, sy * BASE.h, (sz * BASE.d) / 2).project(camera)
    const u = ((v.x + 1) / 2) * camera.aspect
    minU = Math.min(minU, u)
    maxU = Math.max(maxU, u)
    maxV = Math.max(maxV, (1 - v.y) / 2)
  }
  const fullH = (W - MARGIN.left - MARGIN.right) / (maxU - minU)
  camera.setViewOffset(fullH * camera.aspect, fullH, minU * fullH - MARGIN.left, maxV * fullH + MARGIN.bottom - H, W, H)
  camera.updateProjectionMatrix()

  /** 世界坐标 → 舞台上的 px */
  function project(x: number, y: number, z: number) {
    const v = new THREE.Vector3(x, y, z).project(camera)
    return { x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * H }
  }
  /** 这个位置上，竖着 1 个世界单位在屏幕上有多少 px（小动物按它定大小，近大远小） */
  function unitPx(x: number, y: number, z: number) {
    return project(x, y, z).y - project(x, y + 1, z).y
  }

  // ── 只在键帽动的时候渲染 ──
  let raf = 0
  const render = () => renderer.render(scene, camera)
  function tick() {
    raf = 0
    let moving = false
    for (const o of keys.values()) {
      const d = o.target - o.mesh.position.y
      if (Math.abs(d) > 0.002) {
        o.mesh.position.y += d * 0.55
        moving = true
      } else o.mesh.position.y = o.target
    }
    render()
    if (moving) raf = requestAnimationFrame(tick)
  }
  const kick = () => {
    if (!raf) raf = requestAnimationFrame(tick)
  }
  render()

  return {
    canvas,
    project,
    unitPx,
    /** 按下沉一半，松开弹回 */
    press(k: string) {
      const o = keys.get(k)
      if (!o) return
      o.target = o.rest - KH / 2
      kick()
    },
    release(k: string) {
      const o = keys.get(k)
      if (!o) return
      o.target = o.rest
      kick()
    },
    /** 窗口整体缩放后，按实际像素重画，别糊 */
    setPixelRatio(ratio: number) {
      renderer.setPixelRatio(ratio)
      renderer.setSize(W, H)
      render()
    },
    dispose() {
      cancelAnimationFrame(raf)
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose()
          const m = o.material as THREE.MeshStandardMaterial
          m.map?.dispose()
          m.dispose()
        }
      })
      renderer.dispose()
    },
  }
}
