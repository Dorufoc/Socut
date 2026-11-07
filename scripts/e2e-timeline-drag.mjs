/**
 * 端到端取证（v12 时间轴）：真 Electron 窗口 + 真鼠标/滚轮输入（CDP Input.*），验证
 *  1) 比例尺固定 72px/s，轨道可横向滚动，sticky 标签不随内容跑掉；
 *  2) Ctrl+滚轮以指针为锚点缩放；
 *  3) 拖段只在空档里滑动，撞到邻居就贴住，绝不推挤别人；
 *  4) 播放头/预览轴最多走到最后一段的末尾。
 * 运行：node scripts/e2e-timeline-drag.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = process.cwd()
const userData = path.join(os.tmpdir(), 'focusnews-e2e-drag')
const projectsDir = path.join(userData, 'projects')
const PORT = 9333

const mediaPath = path.join(root, 'spikes', 'app-smoke', 'app-smoke-overlay-640x360.mp4').replace(/\//g, '/')

const media = {
  id: 'media-1',
  path: mediaPath,
  name: 'a.mp4',
  meta: {
    width: 1920,
    height: 1080,
    durationSec: 60,
    containerName: 'mp4',
    pixFmt: 'yuv420p',
    videoCodec: 'h264',
    rFrameRate: { num: 30, den: 1 },
    avgFrameRate: { num: 30, den: 1 }
  },
  non169Ack: true,
  hdrAck: true,
  vfrPolicy: 'none',
  compactMode: 'auto',
  thumbnailUrl: '',
  importedAt: '2026-01-01T00:00:00.000Z'
}

// C[0,1] 在锚段左侧且完全不重叠；A[3,6] 是被拖的；B[8,9] 在其右侧
const seed = {
  version: 2,
  name: 'E2E 拖拽',
  resolution: { width: 1920, height: 1080 },
  fps: { num: 30, den: 1 },
  fonts: [],
  media: [media],
  mediaClips: [
    { id: 'clip-C', mediaId: 'media-1', timelineStartSec: 0, timelineEndSec: 1, sourceInSec: 0, sourceOutSec: 1 },
    { id: 'clip-A', mediaId: 'media-1', timelineStartSec: 3, timelineEndSec: 6, sourceInSec: 10, sourceOutSec: 13 },
    { id: 'clip-B', mediaId: 'media-1', timelineStartSec: 8, timelineEndSec: 9, sourceInSec: 20, sourceOutSec: 21 }
  ],
  // 字幕条与音频段：同一套拖拽换算，顺带验证这两条轨道
  // （字幕条必须是完整片段：缺 presetId/content/animation 时预览计划会退化成 0.2s 空片，播放头就被钉住）
  clips: [
    {
      id: 'clip-S',
      startTime: 1,
      endTime: 2,
      presetId: 'stackedNews',
      styleOverrides: {},
      content: { title: 'E2E 标题', subtitle: 'E2E 副标题' },
      animation: {
        inDuration: 1,
        outDuration: 1,
        easing: 'outCubic',
        textRevealFrames: 3,
        displacement: { x: '-30px@1080p', y: '0' }
      },
      fontId: 'builtin-notosanssc-700'
    }
  ],
  audioClips: [{ id: 'aclip-1', mediaId: 'media-1', timelineStartSec: 4, timelineEndSec: 6, sourceInSec: 0, sourceOutSec: 2 }]
}

await fs.rm(userData, { recursive: true, force: true })
await fs.mkdir(projectsDir, { recursive: true })
await fs.writeFile(path.join(projectsDir, 'autosave.focusnews.json'), JSON.stringify(seed, null, 2), 'utf8')

const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: root,
  env: { ...process.env, FOCUSNEWS_USER_DATA: userData },
  stdio: ['ignore', 'pipe', 'pipe']
})
child.stdout.on('data', (d) => process.stdout.write(`[app] ${d}`))
child.stderr.on('data', (d) => process.stdout.write(`[app:err] ${d}`))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function pageTarget() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* 还没起 */
    }
    await sleep(250)
  }
  throw new Error('没有拿到可调试的页面目标')
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.events = []
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id === undefined) {
        if (msg.method === 'Runtime.exceptionThrown') {
          this.events.push(`exception: ${msg.params?.exceptionDetails?.exception?.description ?? msg.params?.exceptionDetails?.text ?? '?'}`)
        }
        if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params?.type)) {
          this.events.push(`console.${msg.params.type}: ${(msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')}`)
        }
        if (msg.method === 'Log.entryAdded') {
          this.events.push(`log.${msg.params?.entry?.level}: ${msg.params?.entry?.text ?? ''}`)
        }
        return
      }
      const entry = this.pending.get(msg.id)
      if (!entry) return
      this.pending.delete(msg.id)
      if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)))
      else entry.resolve(msg.result)
    })
  }
  send(method, params = {}) {
    const id = (this.id += 1)
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
}

const failures = []
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const GEOM = `(() => {
  const scroll = document.querySelector('.timeline__scroll')
  const rows = document.querySelector('.timeline__rows')
  if (!scroll || !rows) return null
  const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, top: r.top, height: r.height } }
  const cards = (sel) => [...document.querySelectorAll(sel)].map((el) => ({ id: el.dataset.clipId, ...box(el) }))
  const laneEl = document.querySelector('.timeline__track--media .timeline__lane')
  const labelEl = document.querySelector('.timeline__track--media .timeline__lane-label')
  const headEl = document.querySelector('.timeline__playhead')
  const metaEl = document.querySelector('.timeline__meta')
  return {
    pxPerSec: Number(rows.dataset.pxPerSec),
    spanSec: Number(rows.dataset.spanSec),
    contentEnd: Number(rows.dataset.contentEndSec),
    scrollLeft: scroll.scrollLeft,
    scrollWidth: scroll.scrollWidth,
    clientWidth: scroll.clientWidth,
    lane: box(laneEl),
    label: labelEl ? box(labelEl) : null,
    scroll: box(scroll),
    playhead: headEl ? box(headEl) : null,
    meta: metaEl?.textContent ?? '',
    media: cards('.media-clip-card'),
    audio: cards('.audio-clip-card'),
    subtitle: cards('.clip-card')
  }
})()`

const HANDLE = (id, side) => `(() => {
  const el = document.querySelector('[data-clip-id="${id}"] .media-clip-card__handle--${side}')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
})()`

let cdp
try {
  const target = await pageTarget()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  cdp = new Cdp(ws)
  await cdp.send('Runtime.enable')

  const evalJs = async (expression) => {
    const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails))
    return res.result.value
  }

  let ready = false
  for (let i = 0; i < 80 && !ready; i += 1) {
    ready = await evalJs(`!!document.querySelector('.timeline__rows')`)
    if (!ready) await sleep(250)
  }
  if (!ready) throw new Error('时间轴没有出现')
  await sleep(600)

  const mouse = async (type, x, y, buttons, extra = {}) => {
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      x: Math.round(x),
      y: Math.round(y),
      button: 'left',
      buttons,
      clickCount: 1,
      pointerType: 'mouse',
      ...extra
    })
  }
  const dragTo = async (fromX, fromY, toX, toY, steps = 12) => {
    await mouse('mousePressed', fromX, fromY, 1)
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps
      await mouse('mouseMoved', fromX + (toX - fromX) * t, fromY + (toY - fromY) * t, 1)
      await sleep(16)
    }
    await mouse('mouseReleased', toX, toY, 0)
    await sleep(350)
  }
  const wheel = async (x, y, deltaY, modifiers = 0) => {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.round(x),
      y: Math.round(y),
      deltaX: 0,
      deltaY,
      modifiers,
      pointerType: 'mouse'
    })
    await sleep(400)
  }
  const click = async (x, y) => {
    await mouse('mousePressed', x, y, 1)
    await mouse('mouseReleased', x, y, 0)
    await sleep(250)
  }

  const cardOf = (g, id) => [...g.media, ...g.audio, ...g.subtitle].find((c) => c.id === id)
  const secOf = (x, g) => (x - g.lane.left) / g.pxPerSec

  // ── 0. 基础几何 ─────────────────────────────────────────────
  const g0 = await evalJs(GEOM)
  console.log('初始:', JSON.stringify(g0))
  check('100% 缩放下比例尺 = 72px/s', Math.abs(g0.pxPerSec - 72) < 0.01, `pxPerSec=${g0.pxPerSec}`)
  check('内容末尾 = 9s（最后一段 B 的终点）', Math.abs(g0.contentEnd - 9) < 0.01, `contentEnd=${g0.contentEnd}`)
  check('轨道总宽 ≥ 内容末尾（可容纳全部段）', g0.spanSec >= g0.contentEnd, `span=${g0.spanSec}s end=${g0.contentEnd}s`)
  const c0 = cardOf(g0, 'clip-C')
  const b0 = cardOf(g0, 'clip-B')
  check(
    '0s 片段左缘与车道起点重合（不钻到标签下面）',
    Math.abs(c0.left - g0.lane.left) <= 1.5,
    `lane.left=${g0.lane.left.toFixed(1)} C.left=${c0.left.toFixed(1)}`
  )

  // ── 1. 整段右拖 1s：只动自己，不推别人 ──────────────────────
  const a0 = cardOf(g0, 'clip-A')
  const midY = a0.top + a0.height / 2
  await dragTo(a0.left + a0.width / 2, midY, a0.left + a0.width / 2 + 72, midY)
  const g1 = await evalJs(GEOM)
  const a1 = cardOf(g1, 'clip-A')
  check('整段右拖 1s 后起点 = 4s（位移贴着指针）', Math.abs(secOf(a1.left, g1) - 4) <= 0.05, `start=${secOf(a1.left, g1).toFixed(3)}s`)
  check('左侧 C 原地不动', Math.abs(cardOf(g1, 'clip-C').left - c0.left) <= 1, `C.left ${c0.left.toFixed(1)} → ${cardOf(g1, 'clip-C').left.toFixed(1)}`)
  check('右侧 B 原地不动', Math.abs(cardOf(g1, 'clip-B').left - b0.left) <= 1, `B.left ${b0.left.toFixed(1)} → ${cardOf(g1, 'clip-B').left.toFixed(1)}`)

  // ── 2. 继续右拖 4s：空档只到 8s，必须卡在 5s 贴住 B ─────────
  await dragTo(a1.left + a1.width / 2, midY, a1.left + a1.width / 2 + 288, midY)
  const g2 = await evalJs(GEOM)
  const a2 = cardOf(g2, 'clip-A')
  const b2 = cardOf(g2, 'clip-B')
  check('撞到邻居后卡在 5s（B 左缘 8s − 长度 3s）', Math.abs(secOf(a2.left, g2) - 5) <= 0.05, `start=${secOf(a2.left, g2).toFixed(3)}s`)
  check('被撞的 B 一寸没挪', Math.abs(b2.left - b0.left) <= 1, `B.left ${b0.left.toFixed(1)} → ${b2.left.toFixed(1)}`)
  check('两段首尾相接但不重叠', Math.abs(secOf(a2.right, g2) - secOf(b2.left, g2)) <= 0.05, `A.end=${secOf(a2.right, g2).toFixed(3)}s B.start=${secOf(b2.left, g2).toFixed(3)}s`)

  // ── 3. 出点手柄：往右拖越过 B 也只能停在 B 左缘 ─────────────
  const endHandle = await evalJs(HANDLE('clip-A', 'right'))
  await dragTo(endHandle.x, endHandle.y, g2.lane.left + 9 * g2.pxPerSec, endHandle.y)
  const g3 = await evalJs(GEOM)
  const a3 = cardOf(g3, 'clip-A')
  check('出点撞上 B 后停在 8s', Math.abs(secOf(a3.right, g3) - 8) <= 0.05, `end=${secOf(a3.right, g3).toFixed(3)}s`)
  check('伸缩不推动 B', Math.abs(cardOf(g3, 'clip-B').left - b0.left) <= 1, `B.left=${cardOf(g3, 'clip-B').left.toFixed(1)}`)

  // ── 4. Ctrl+滚轮：以指针为锚点放大 ──────────────────────────
  const anchorX = g3.lane.left + 4 * g3.pxPerSec
  const anchorY = g3.lane.top + g3.lane.height / 2
  const anchorSecBefore = secOf(anchorX, g3)
  await wheel(anchorX, anchorY, -120, 2)
  const g4 = await evalJs(GEOM)
  console.log('缩放后:', JSON.stringify({ pxPerSec: g4.pxPerSec, spanSec: g4.spanSec, scrollLeft: g4.scrollLeft }))
  check('Ctrl+滚轮放大：比例尺变大', g4.pxPerSec > g3.pxPerSec + 1, `${g3.pxPerSec.toFixed(1)} → ${g4.pxPerSec.toFixed(1)} px/s`)
  check(
    '缩放锚点处的时刻不变（指针下不跑位）',
    Math.abs(secOf(anchorX, g4) - anchorSecBefore) <= 0.2,
    `锚点 ${anchorSecBefore.toFixed(2)}s → ${secOf(anchorX, g4).toFixed(2)}s`
  )
  check('缩放后轨道不是铺满一屏（内容可滚动）', g4.scrollWidth > g4.clientWidth, `scrollWidth=${Math.round(g4.scrollWidth)} clientWidth=${Math.round(g4.clientWidth)}`)

  // ── 5. 横向滚动：内容跟着走，标签钉在左边 ───────────────────
  const mediaX = g4.lane.left + 300
  await wheel(mediaX, anchorY, 400, 0)
  const g5 = await evalJs(GEOM)
  console.log('横滚后:', JSON.stringify({ scrollLeft: g5.scrollLeft, laneLeft: g5.lane.left, labelLeft: g5.label?.left }))
  check('无 Ctrl 的滚轮改成横向滚动', g5.scrollLeft > 200, `scrollLeft=${Math.round(g5.scrollLeft)}`)
  check('内容随滚动左移（卡片跟着轨道走）', cardOf(g5, 'clip-A').left < cardOf(g4, 'clip-A').left - 200, `A.left ${cardOf(g4, 'clip-A').left.toFixed(1)} → ${cardOf(g5, 'clip-A').left.toFixed(1)}`)
  check(
    'sticky 标签钉在滚动视口左边（不被内容带走）',
    g5.label &&
      Math.abs(g5.label.left - g5.scroll.left) <= 1.5 &&
      Math.abs(g5.label.right - (g5.scroll.left + 56)) <= 1.5,
    `label=${g5.label?.left.toFixed(1)}..${g5.label?.right.toFixed(1)} scroll.left=${g5.scroll.left.toFixed(1)}`
  )

  // ── 6. 播放头只能走到最后一个段末尾 ─────────────────────────
  await evalJs(`(() => { const s = document.querySelector('.timeline__scroll'); s.scrollLeft = 0; return s.scrollLeft })()`)
  await sleep(300)
  const g6 = await evalJs(GEOM)
  const clickX = Math.min(g6.lane.left + (g6.contentEnd + 5) * g6.pxPerSec, g6.clientWidth - 20)
  await click(clickX, g6.lane.top + g6.lane.height / 2)
  const g7 = await evalJs(GEOM)
  const headSec = g7.playhead ? secOf(g7.playhead.left, g7) : NaN
  check('点击内容末尾之后：播放头夹在内容末尾', Math.abs(headSec - g7.contentEnd) <= 0.1, `head=${headSec.toFixed(2)}s end=${g7.contentEnd}s`)
  check('预览轴时间码同步到末尾', g7.meta.includes('9.00s'), `meta=${g7.meta}`)

  // ── 7. 字幕/音频轨：同一套换算，拖多少走多少 ────────────────
  for (const [id, kind] of [
    ['clip-S', 'subtitle'],
    ['aclip-1', 'audio']
  ]) {
    const before = cardOf(g7, id)
    if (!before) {
      check(`${kind} 卡片渲染`, false, '没找到')
      continue
    }
    const stepPx = 0.5 * g7.pxPerSec
    const cy = before.top + before.height / 2
    const cx = before.left + before.width / 2
    await dragTo(cx, cy, cx + stepPx, cy)
    const after = cardOf(await evalJs(GEOM), id)
    check(`${kind} 右拖 0.5s 位移等于指针位移`, Math.abs(after.left - before.left - stepPx) <= 4, `期望 ${stepPx.toFixed(1)}px 实得 ${(after.left - before.left).toFixed(1)}px`)
  }

  await cdp.send('Page.captureScreenshot').then(async (shot) => {
    await fs.writeFile(path.join(userData, 'timeline-after-drag.png'), Buffer.from(shot.data, 'base64'))
  })
  console.log(`截图: ${path.join(userData, 'timeline-after-drag.png')}`)
} catch (error) {
  console.error('E2E 失败：', error)
  failures.push(`异常：${error.message}`)
} finally {
  try {
    await cdp?.send('Runtime.evaluate', { expression: 'window.close()' })
  } catch {
    /* ignore */
  }
  await sleep(300)
  child.kill()
  // 失败时把渲染进程的异常/控制台错误一并打到终端，省得再手开 DevTools
  if (failures.length > 0 && cdp?.events?.length) {
    console.log('\n渲染进程诊断：')
    for (const line of cdp.events.slice(0, 12)) console.log(`  ${line}`)
  }
  console.log(failures.length === 0 ? '\n全部通过' : `\n失败 ${failures.length} 项：${failures.join(' / ')}`)
  process.exitCode = failures.length === 0 ? 0 : 1
}
