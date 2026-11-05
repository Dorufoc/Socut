import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PANE_PX,
  PANE_LIMITS,
  SPLITTER_PX,
  defaultRatios,
  edgeSign,
  formatPaneHud,
  maxLeftPx,
  maxRightPx,
  movePane,
  normalizePaneRatios,
  paneRatios,
  resolvePaneSizes,
  serializePaneRatios,
  timelineBounds,
  usableHeight,
  usableWidth,
  type PaneLabels,
  type PaneMetrics,
  type PaneSizes
} from '@shared/paneLayout'

/**
 * 主界面伸缩布局的几何契约。
 *
 * 三条纪律：
 * 1. **不重叠也不留缝**：三栏宽之和 + 两条分隔线 == 容器宽，上下两区高之和 + 一条分隔线 == 容器高；
 * 2. **同一条线同时改两个区**：被治理的一侧变，邻居等量反向变，邻居自己不受影响；
 * 3. **持久化的是比例**：换分辨率后观感一致，脏数据一律整条丢弃而不是猜。
 */

const LABELS: PaneLabels = {
  left: '素材栏',
  center: '预览',
  right: '字幕编辑',
  stage: '预览区',
  timeline: '时间轴'
}

function metricsOf(width: number, height: number): PaneMetrics {
  return { width, height, splitter: SPLITTER_PX }
}

/** 1440×700：标题栏 48 + 状态栏 28 + 内容区 ≈ 700（.shell 实测高）。 */
const BASE = metricsOf(1440, 700)

function sizesAt(ratios: { left: number; right: number; timeline: number }, metrics: PaneMetrics): PaneSizes {
  return resolvePaneSizes(ratios, metrics)
}

describe('区域尺寸解算', () => {
  it('冷启动默认布局与历史固定尺寸一致（左 300 / 右 344 / 时间轴 232）', () => {
    const sizes = resolvePaneSizes(defaultRatios(BASE), BASE)
    expect(sizes.left).toBe(DEFAULT_PANE_PX.left)
    expect(sizes.right).toBe(DEFAULT_PANE_PX.right)
    expect(sizes.timeline).toBe(DEFAULT_PANE_PX.timeline)
    expect(sizes.center).toBe(1440 - SPLITTER_PX * 2 - 300 - 344)
    expect(sizes.stage).toBe(700 - SPLITTER_PX - 232)
  })

  it('任意容器下三栏总宽与两区总高都恰好填满，既不重叠也不留缝', () => {
    const ratios = defaultRatios(BASE)
    for (const metrics of [metricsOf(1100, 700), metricsOf(1440, 900), metricsOf(2560, 1440), metricsOf(1366, 768)]) {
      const sizes = sizesAt(ratios, metrics)
      expect(sizes.left + sizes.center + sizes.right + metrics.splitter * 2).toBe(metrics.width)
      expect(sizes.stage + sizes.timeline + metrics.splitter).toBe(metrics.height)
      expect(usableWidth(metrics)).toBe(metrics.width - metrics.splitter * 2)
      expect(usableHeight(metrics)).toBe(metrics.height - metrics.splitter)
    }
  })

  it('极窄容器：中栏让位到 0，两侧退到下限以下也不把分隔线画出容器', () => {
    // 500 宽连 232+360+268 都装不下：按下限比例整体缩放，总宽仍恰好填满（谁都不越界）
    const metrics = metricsOf(500, 700)
    const sizes = sizesAt({ left: 0.5, right: 0.4, timeline: 0.33 }, metrics)
    expect(sizes.center).toBe(0)
    expect(sizes.left).toBeGreaterThan(0)
    expect(sizes.right).toBeGreaterThan(0)
    expect(sizes.left + sizes.right + metrics.splitter * 2).toBe(metrics.width)
  })

  it('正常窗口下中栏永不被挤到保底宽以下', () => {
    const metrics = metricsOf(1100, 700)
    const sizes = sizesAt({ left: 0.45, right: 0.4, timeline: 0.3 }, metrics)
    expect(sizes.center).toBeGreaterThanOrEqual(PANE_LIMITS.centerMin)
    expect(sizes.left).toBeGreaterThanOrEqual(PANE_LIMITS.leftMin)
    expect(sizes.right).toBeGreaterThanOrEqual(PANE_LIMITS.rightMin)
  })

  it('窗口尺寸变化时保持比例（记住的是习惯而不是像素）', () => {
    const ratios = defaultRatios(metricsOf(1440, 700))
    const small = sizesAt(ratios, metricsOf(1440, 700))
    const large = sizesAt(ratios, metricsOf(1920, 900))
    expect(large.left / 1920).toBeCloseTo(small.left / 1440, 3)
    expect(large.right / 1920).toBeCloseTo(small.right / 1440, 3)
    expect(large.timeline / 900).toBeCloseTo(small.timeline / 700, 3)
  })

  it('容器尚未测得时全部落到 0，由调用方交给样式表回退值', () => {
    const sizes = sizesAt(defaultRatios(metricsOf(1440, 700)), metricsOf(0, 0))
    expect(sizes).toEqual({ left: 0, center: 0, right: 0, stage: 0, timeline: 0 })
  })
})

describe('拖拽双向调整', () => {
  const base = resolvePaneSizes(defaultRatios(BASE), BASE)

  it('方向系数：左栏与指针同向，右栏与时间轴反向', () => {
    expect(edgeSign('left')).toBe(1)
    expect(edgeSign('right')).toBe(-1)
    expect(edgeSign('timeline')).toBe(-1)
  })

  it('拖动左栏右边界：左栏加宽的量恰好等于预览变窄的量，右栏不受影响', () => {
    const moved = movePane('left', base.left + 80, base, BASE)
    expect(moved.left).toBe(base.left + 80)
    expect(moved.center).toBe(base.center - 80)
    expect(moved.right).toBe(base.right)
    expect(moved.timeline).toBe(base.timeline)
  })

  it('拖动右栏左边界：指针右移挤压的是右栏自己，预览等量变宽', () => {
    const moved = movePane('right', base.right - 60, base, BASE)
    expect(moved.right).toBe(base.right - 60)
    expect(moved.center).toBe(base.center + 60)
    expect(moved.left).toBe(base.left)
  })

  it('拖动时间轴上边缘：同一条线同时改两区高度（时间轴 +40 ↔ 预览 −40）', () => {
    const moved = movePane('timeline', base.timeline + 40, base, BASE)
    expect(moved.timeline).toBe(base.timeline + 40)
    expect(moved.stage).toBe(base.stage - 40)
    expect(moved.left).toBe(base.left)
    expect(moved.stage + moved.timeline + BASE.splitter).toBe(BASE.height)
  })

  it('钳制：两侧都不许越过保底（中栏保底宽 / 上区保底高 / 区域自身上下限）', () => {
    const leftToMax = movePane('left', 12_000, base, BASE)
    expect(leftToMax.center).toBeGreaterThanOrEqual(PANE_LIMITS.centerMin)
    expect(leftToMax.left).toBe(maxLeftPx(base, BASE))

    const rightToMin = movePane('right', 12, base, BASE)
    expect(rightToMin.right).toBe(PANE_LIMITS.rightMin)

    const rightToMax = movePane('right', 12_000, base, BASE)
    expect(rightToMax.right).toBe(maxRightPx(base, BASE))

    const bounds = timelineBounds(BASE)
    expect(movePane('timeline', 4, base, BASE).timeline).toBe(bounds.min)
    expect(movePane('timeline', 9_000, base, BASE).timeline).toBe(bounds.max)
    expect(bounds.max).toBeLessThanOrEqual(usableHeight(BASE) - PANE_LIMITS.stageMin)
  })

  it('反复拖动同一条线不会累积误差（每次都从同一份基准解算绝对像素）', () => {
    let sizes = base
    for (let px = base.left; px <= base.left + 120; px += 7) {
      sizes = movePane('left', px, base, BASE)
    }
    expect(sizes.left + sizes.center + sizes.right + BASE.splitter * 2).toBe(BASE.width)
  })

  it('小窗口下上下限仍然合法（max ≥ min，分隔线不会拖出容器）', () => {
    const tiny = metricsOf(1100, 700)
    const bounds = timelineBounds(tiny)
    expect(bounds.max).toBeGreaterThanOrEqual(bounds.min)
    const rest = resolvePaneSizes(defaultRatios(tiny), tiny)
    expect(maxLeftPx(rest, tiny)).toBeGreaterThanOrEqual(PANE_LIMITS.leftMin)
    expect(maxRightPx(rest, tiny)).toBeGreaterThanOrEqual(PANE_LIMITS.rightMin)
  })
})

describe('比例持久化口径', () => {
  it('像素 → 比例 → 像素在同一容器下往返一致', () => {
    const sizes = resolvePaneSizes(defaultRatios(BASE), BASE)
    const restored = resolvePaneSizes(paneRatios(sizes, BASE), BASE)
    expect(restored.left).toBe(sizes.left)
    expect(restored.right).toBe(sizes.right)
    expect(restored.timeline).toBe(sizes.timeline)
  })

  it('序列化带版本号，读回后仍是合法比例（4 位小数，避免噪声累积）', () => {
    const ratios = paneRatios(resolvePaneSizes(defaultRatios(BASE), BASE), BASE)
    const payload = JSON.parse(serializePaneRatios(ratios)) as Record<string, unknown>
    expect(payload['version']).toBe(1)
    expect(normalizePaneRatios(payload)).toEqual(ratios)
    expect(String(ratios.left).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(4)
  })

  it('脏数据整条丢弃：非对象 / 越界 / NaN / 版本不符 / 缺字段', () => {
    expect(normalizePaneRatios(null)).toBeNull()
    expect(normalizePaneRatios([])).toBeNull()
    expect(normalizePaneRatios('left=0.2')).toBeNull()
    expect(normalizePaneRatios({ version: 1, left: 0.2, right: 1.7, timeline: 0.3 })).toBeNull()
    expect(normalizePaneRatios({ version: 1, left: 0.2, right: -0.1, timeline: 0.3 })).toBeNull()
    expect(normalizePaneRatios({ version: 1, left: Number.NaN, right: 0.24, timeline: 0.33 })).toBeNull()
    expect(normalizePaneRatios({ version: 2, left: 0.2, right: 0.24, timeline: 0.33 })).toBeNull()
    expect(normalizePaneRatios({ version: 1, left: 0.2, timeline: 0.33 })).toBeNull()
    // 只修粒度（保留 4 位），不改语义
    expect(normalizePaneRatios({ version: 1, left: 0.20839, right: 0.24, timeline: 0.33 })).toEqual({
      left: 0.2084,
      right: 0.24,
      timeline: 0.33
    })
  })
})

describe('拖拽实时读数', () => {
  const base = resolvePaneSizes(defaultRatios(BASE), BASE)

  it('竖线显示「被治理区域 + 邻居」，横线显示「预览区 + 时间轴」', () => {
    expect(formatPaneHud('left', base, BASE, LABELS)).toBe('素材栏 300px（21%） · 预览 782px（55%）')
    expect(formatPaneHud('right', base, BASE, LABELS)).toContain('字幕编辑 344px')
    expect(formatPaneHud('timeline', base, BASE, LABELS)).toContain('时间轴 232px')
    expect(formatPaneHud('timeline', base, BASE, LABELS)).toContain('预览区 461px')
  })

  it('读数随拖拽实时变化，且百分比按同一矩形计算', () => {
    const moved = movePane('left', base.left + 100, base, BASE)
    const hud = formatPaneHud('left', moved, BASE, LABELS)
    expect(hud).toContain(`素材栏 ${moved.left}px`)
    expect(hud).toContain(`预览 ${moved.center}px`)
    expect(hud).not.toContain(`${base.left}px`)
  })
})
