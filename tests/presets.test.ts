import { describe, expect, it } from 'vitest'
import { PRESETS, PRESET_IDS, validateAllPresets, getPreset, DEFAULT_PRESET_ID } from '@shared/presets'
import { buildProjectPlan } from '@shared/presetResolver'
import { createClip, createDefaultProject } from '@shared/projectSchema'
import { IN_DURATION_RANGE_SEC, OUT_RATIO_RANGE } from '@shared/presetSchema'
import { durationSecToFrames } from '@shared/fps'
import { BUILTIN_FONTS, DEFAULT_FONT_ID, FPS_23_976, FPS_30, RESOLUTION_PRESETS } from '@shared/constants'
import { motionAt } from '../src/renderer/src/render/animation'
import { computeClipBoxes, layoutCacheKey } from '../src/renderer/src/render/layoutTree'
import { getTextMeasurer } from '../src/renderer/src/render/textMeasure'
import type { FontRecord, Project } from '@shared/types'

/**
 * 预设体系（规格 §3.1 / §7）与跨分辨率布局（验收第 9 条）。
 * 布局在纯 Node 下跑：没有 Canvas 时文本度量走估算，
 * 但盒模型的相对关系仍然可比（同一度量口径贯穿全部快照）。
 */

const FONT_INDEX: FontRecord[] = BUILTIN_FONTS.map((meta) => ({
  ...meta,
  source: 'builtin',
  bytes: 1024,
  sha1: '',
  importedAt: '2026-01-01T00:00:00.000Z'
}))

function projectWith(clipCount: number, presetIdList?: string[]): Project {
  const base = createDefaultProject('测试工程')
  const clips = Array.from({ length: clipCount }, (_, index) => {
    const clip = createClip({ startTime: index * 5, fps: FPS_30 })
    const preset = presetIdList?.[index]
    return preset ? { ...clip, presetId: preset as typeof clip.presetId } : clip
  })
  return { ...base, clips, fonts: FONT_INDEX }
}

describe('8 套预设', () => {
  it('数量为 8 且全部通过校验（令牌齐备、无过冲缓动、结构分层、底部安全区锚定）', () => {
    expect(PRESETS).toHaveLength(8)
    expect(PRESET_IDS).toHaveLength(8)
    expect(validateAllPresets()).toEqual([])
  })

  it('入场时长与出场比例符合规格 §7（6–12 帧 / 出场快 30%–40%）', () => {
    for (const preset of PRESETS) {
      const [inMin, inMax] = IN_DURATION_RANGE_SEC
      expect(preset.animation.inDuration).toBeGreaterThanOrEqual(inMin)
      expect(preset.animation.inDuration).toBeLessThanOrEqual(inMax)
      const ratio = preset.animation.outDuration / preset.animation.inDuration
      const [rMin, rMax] = OUT_RATIO_RANGE
      expect(ratio).toBeGreaterThanOrEqual(rMin)
      expect(ratio).toBeLessThanOrEqual(rMax)
      // 30fps 下入场帧数落在 6–12 帧
      const frames = durationSecToFrames(preset.animation.inDuration, FPS_30)
      expect(frames).toBeGreaterThanOrEqual(6)
      expect(frames).toBeLessThanOrEqual(12)
      expect(preset.animation.textRevealFrames).toBeLessThanOrEqual(3)
    }
  })

  it('命名不含任何电视台名称（版权边界，规格 §7）', () => {
    const banned = ['cctv', '央视', 'bbc', 'nhk', 'cnn', 'fox', '台标', '卫视', 'tv b']
    for (const preset of PRESETS) {
      const haystack = `${preset.id} ${preset.name} ${preset.description}`.toLowerCase()
      for (const word of banned) expect(haystack.includes(word), `${preset.id} 命中敏感词 ${word}`).toBe(false)
    }
  })

  it('默认预设可解析且带 compact / ultrawide 分支补丁', () => {
    const preset = getPreset(DEFAULT_PRESET_ID)
    expect(preset.patches.compact.length).toBeGreaterThan(0)
    expect(preset.patches.ultrawide.length).toBeGreaterThan(0)
    // 主条宽度由「root 左右等边距 + width:100%」决定，分支补丁**不得**再给它加宽度上限
    // （任何 maxWidth 都会让右侧边距大于左侧，破坏左右相等）
    for (const patch of [...preset.patches.compact, ...preset.patches.ultrawide]) {
      if (patch.role !== 'primaryBar') continue
      expect(patch.style?.maxWidth).toBeUndefined()
      expect(patch.style?.width).toBeUndefined()
    }
    // 副条仍有宽度约束（竖屏 94%、超宽 70%）
    expect(String(preset.patches.compact.find((p) => p.role === 'secondaryBar')?.style?.maxWidth)).toContain('%')
    expect(String(preset.patches.ultrawide.find((p) => p.role === 'secondaryBar')?.style?.maxWidth)).toContain('%')
  })
})

describe('时间轴计划与帧驱动动画', () => {
  it('多片段一次导出：帧区间连续、间隙保持全透明（规格 §3.1）', () => {
    const project = projectWith(3)
    const plan = buildProjectPlan({ project, scope: { kind: 'timeline' }, fontIndex: FONT_INDEX })
    expect(plan.clips).toHaveLength(3)
    expect(plan.startFrame).toBe(0)
    expect(plan.endFrame).toBe(450) // 3 段 × 5s × 30fps
    const [first, second] = [plan.clips[0], plan.clips[1]]
    expect(second!.startFrame - first!.endFrame).toBe(0) // 5s 无缝衔接
  })

  it('单片段导出：区间只覆盖该片段', () => {
    const project = projectWith(2)
    const clipId = project.clips[1]!.id
    const plan = buildProjectPlan({ project, scope: { kind: 'clips', clipIds: [clipId] }, fontIndex: FONT_INDEX })
    expect(plan.clips).toHaveLength(1)
    expect(plan.startFrame).toBe(150)
    expect(plan.endFrame).toBe(300)
  })

  it('动画在片段外完全不可见；入场完成擦除窗口=整条，出场末帧从左擦到尽', () => {
    const project = projectWith(1)
    const plan = buildProjectPlan({ project, scope: { kind: 'timeline' }, fontIndex: FONT_INDEX })
    const clip = plan.clips[0]!
    expect(motionAt(clip.animation, -1).visible).toBe(false)
    expect(motionAt(clip.animation, clip.animation.totalFrames).visible).toBe(false)
    const inEnd = motionAt(clip.animation, clip.animation.inFrames)
    expect(inEnd.wipeFrom).toBeCloseTo(0, 3)
    expect(inEnd.wipeTo).toBeCloseTo(1, 3)
    // 逐字过渡的跨度：由预设 textRevealFrames 解释（至少 1 字），不再是“整段遮罩”
    expect(inEnd.textStaggerChars).toBe(Math.max(1, Math.round(clip.animation.textRevealFrames)))
    // 出场是「从左到右擦去」：左边界推进到尽，右边界不动
    const last = motionAt(clip.animation, clip.animation.totalFrames - 1)
    expect(last.wipeTo).toBeCloseTo(1, 3)
    expect(last.wipeFrom).toBeGreaterThan(0.9)
    expect(last.visible).toBe(false)
    // 单调：入场期间右边界只增不减，且左边界始终为 0
    let previous = -1
    for (let frame = 0; frame <= clip.animation.inFrames; frame++) {
      const motion = motionAt(clip.animation, frame)
      expect(motion.wipeTo).toBeGreaterThanOrEqual(previous - 1e-9)
      expect(motion.wipeFrom).toBeCloseTo(0, 6)
      previous = motion.wipeTo
    }
  })

  it('1080p30 与 720p23.976：入出点误差 <1 帧（M3-7 / 验收第 4 条）', () => {
    // 计划写的是同时换分辨率与帧率：时间点存在秒，只换 fps 不换秒 → 观感必须稳定。
    const project = projectWith(3)
    const hd30 = buildProjectPlan({
      project,
      resolution: { width: 1920, height: 1080 },
      fps: FPS_30,
      scope: { kind: 'timeline' },
      fontIndex: FONT_INDEX
    })
    const sd23976 = buildProjectPlan({
      project,
      resolution: { width: 1280, height: 720 },
      fps: FPS_23_976,
      scope: { kind: 'timeline' },
      fontIndex: FONT_INDEX
    })
    expect(sd23976.clips).toHaveLength(hd30.clips.length)
    for (let index = 0; index < hd30.clips.length; index++) {
      const a = hd30.clips[index]!
      const b = sd23976.clips[index]!
      // 23.976 的一帧时长就是允许的误差上限
      const oneFrame = FPS_23_976.den / FPS_23_976.num
      const startA = (a.startFrame * FPS_30.den) / FPS_30.num
      const startB = (b.startFrame * FPS_23_976.den) / FPS_23_976.num
      const endA = (a.endFrame * FPS_30.den) / FPS_30.num
      const endB = (b.endFrame * FPS_23_976.den) / FPS_23_976.num
      expect(Math.abs(startA - startB), `第 ${index} 段入点`).toBeLessThan(oneFrame)
      expect(Math.abs(endA - endB), `第 ${index} 段出点`).toBeLessThan(oneFrame)
      // 时长同样稳定（不因换档而拉长或截短）
      expect(Math.abs(endA - startA - (endB - startB))).toBeLessThan(oneFrame)
    }
    // 旧写法只比了中间一个入点；保留同一断言口径以防回退
    const secOf30 = (hd30.clips[1]!.startFrame * FPS_30.den) / FPS_30.num
    const secOf24 = (sd23976.clips[1]!.startFrame * FPS_23_976.den) / FPS_23_976.num
    expect(Math.abs(secOf30 - secOf24)).toBeLessThan(FPS_23_976.den / FPS_23_976.num)
  })
})

describe('跨分辨率布局快照（验收第 9 条）', () => {
  it('8 预设 × 6 档分辨率 + 竖屏 + 超宽：字号与条高为正且不超过硬上限', async () => {
    const frames: Array<{ name: string; boxes: number; maxFontSize: number; barHeight: number; bottom: number }> = []
    // 分支覆盖计数：没有这些计数，compact/ultrawide 断言可能“空转通过”（根本不进入分支）
    const modeHits: Record<string, number> = { standard: 0, compact: 0, ultrawide: 0 }
    let ellipsisChecks = 0
    let integerChecks = 0
    let ultrawideChecks = 0
    let titleWidthChecks = 0
    // 8 预设 × 8 档，每档至少 4 个盒、每盒 4 个坐标字段
    const boxesExpectedMinimum = PRESETS.length * 8 * 4 * 4
    const targets = [
      ...RESOLUTION_PRESETS.map((preset) => ({ name: preset.key, ...preset.resolution })),
      { name: 'portrait-1080x1920', width: 1080, height: 1920 },
      { name: 'ultrawide-3840x1440', width: 3840, height: 1440 }
    ]
    for (const preset of PRESETS) {
      for (const target of targets) {
        const project = projectWith(1, [preset.id])
        // 条宽已是 hug（内容驱动）：空文案会退化成「仅左右内边距」的非代表性尺寸，
        // 快照固定一段真实长度文案，才能校验等比缩放与上限钳制
        project.clips[0]!.content = { title: '长三角一体化新规发布', subtitle: '省发展改革委负责人解读' }
        const plan = buildProjectPlan({
          project,
          resolution: { width: target.width, height: target.height },
          scope: { kind: 'timeline' },
          fontIndex: FONT_INDEX
        })
        const clipPlan = plan.clips[0]!
        const boxes = await computeClipBoxes(clipPlan)
        const texts = boxes.filter((box) => box.text)
        const bars = boxes.filter((box) => box.role === 'primaryBar')
        const root = boxes.find((box) => box.role === 'root')
        expect(bars).toHaveLength(1)
        const bar = bars[0]!
        // 计划 C9：Config.setPointScaleFactor(1) 后布局必须落在整数像素网格上
        // （否则 1 像素线/字底会在奇数分辨率上被重采样成灰边，预览与导出都会糊）
        for (const box of boxes) {
          for (const [key, value] of [
            ['x', box.x],
            ['y', box.y],
            ['w', box.w],
            ['h', box.h]
          ] as const) {
            integerChecks += 1
            expect(Number.isInteger(value), `${preset.id} @ ${target.name} 的 ${key}=${value} 不是整数`).toBe(true)
          }
        }
        const title = texts.find((box) => box.role === 'title')
        modeHits[plan.mode] = (modeHits[plan.mode] ?? 0) + 1
        // 竖屏紧凑分支：副标题必须单行省略（规格 §2 / §6.1）
        const subtitle = texts.find((box) => box.role === 'subtitle')
        if (plan.mode === 'compact' && subtitle?.text) {
          ellipsisChecks += 1
          expect(subtitle.text.maxLines, `${preset.id} @ ${target.name} 副标题应限单行`).toBe(1)
          expect(subtitle.text.ellipsis, `${preset.id} @ ${target.name} 副标题应开启省略`).toBe(true)
        }
        // 标题区域宽度法则（需求原文）：主条长度 = 预览宽度 − 左右相等边距，
        // 即：主条填满 root，且左/右边距逐像素相等（不允许靠 maxWidth 猜宽度）
        titleWidthChecks += 1
        expect(root, `${preset.id} @ ${target.name} 缺少 root 盒`).toBeDefined()
        expect(bar.w, `${preset.id} @ ${target.name} 主条应与 root 同宽`).toBe(root!.w)
        expect(bar.x, `${preset.id} @ ${target.name} 左边距 ${bar.x} 应等于右边距 ${target.width - (bar.x + bar.w)}`).toBe(
          target.width - (bar.x + bar.w)
        )
        // 超宽分支：主条不再压宽，副条仍受 70% 上限约束
        if (plan.mode === 'ultrawide') {
          ultrawideChecks += 1
          const subBar = boxes.find((box) => box.role === 'secondaryBar')
          expect(subBar, `${preset.id} @ ${target.name} 缺少副条`).toBeDefined()
          expect(subBar!.w, `${preset.id} @ ${target.name} 超宽副条过宽`).toBeLessThanOrEqual(target.width * 0.72)
        }
        // 布局必须落在画布内（底部锚定，含水平内缩）
        expect(bar.x).toBeGreaterThanOrEqual(0)
        expect(bar.x + bar.w).toBeLessThanOrEqual(target.width + 1)
        expect(bar.y + bar.h).toBeLessThanOrEqual(target.height + 1)
        expect(bar.h).toBeGreaterThan(4)
        expect(bar.w).toBeGreaterThan(20)
        if (title?.text) {
          expect(title.text.sizePx).toBeGreaterThan(6)
          // 竖屏/超宽下的字号硬上限（按显示宽度 7.5% / 6.2%）
          const cap = target.width * (plan.mode === 'compact' ? 0.075 : 0.062) + 1e-6
          expect(title.text.sizePx, `${preset.id} @ ${target.name}`).toBeLessThanOrEqual(cap)
          frames.push({
            name: `${preset.id}/${target.name}`,
            boxes: boxes.length,
            maxFontSize: title.text.sizePx,
            barHeight: bar.h,
            bottom: target.height - (bar.y + bar.h)
          })
        }
        // 缓存键包含分辨率，不同档不得串用
        expect(layoutCacheKey(clipPlan)).toContain(String(target.width))
      }
    }
    // 同一预设在 4K 上的条高应约为 360p 的 6 倍（px@1080p 等比缩放）
    const small = frames.find((row) => row.name.endsWith('/360p'))!
    const huge = frames.find((row) => row.name.endsWith('/4K'))!
    expect(huge.barHeight).toBeCloseTo(small.barHeight * 6, 0)
    // 底部安全区留白随分辨率等比放大
    expect(huge.bottom).toBeGreaterThan(small.bottom)
    // 分支真的被执行过（否则上面的条件断言等于没写）
    expect(integerChecks, '整数网格断言次数').toBeGreaterThanOrEqual(boxesExpectedMinimum)
    expect(modeHits.compact, 'compact 分支次数').toBe(PRESETS.length)
    expect(modeHits.ultrawide, 'ultrawide 分支次数').toBe(PRESETS.length)
    expect(titleWidthChecks, '标题宽度法则断言次数').toBe(PRESETS.length * targets.length)
    expect(ellipsisChecks, '副标题省略断言次数').toBe(PRESETS.length)
    expect(ultrawideChecks, '超宽宽度钳制断言次数').toBe(PRESETS.length)
  })

  it('片段字体缺失时回退到内置字体而不抛错', () => {
    const project = projectWith(1)
    const broken = { ...project, clips: [{ ...project.clips[0]!, fontId: 'user-does-not-exist' }] }
    const plan = buildProjectPlan({ project: broken, scope: { kind: 'timeline' }, fontIndex: FONT_INDEX })
    expect(plan.clips[0]!.fonts.title.family).toContain(DEFAULT_FONT_ID)
  })
})

/**
 * 标题区域宽度法则 + 自动换行。
 * 契约：主条长度 = 预览宽度 − 左右相等边距（与文字长短无关）；
 * 文字过长时在条内换行、条高随行数长高；副标题仍按文字自适应。
 */
describe('标题区域宽度 = 画宽 − 左右等边距（副条仍自适应）', () => {
  const layoutOf = async (title: string, subtitle: string, presetId: string = DEFAULT_PRESET_ID) => {
    const project = projectWith(1, [presetId])
    project.clips[0]!.content = { title, subtitle }
    const plan = buildProjectPlan({
      project,
      resolution: { width: 1920, height: 1080 },
      fps: FPS_30,
      scope: { kind: 'timeline' },
      fontIndex: FONT_INDEX
    })
    const boxes = await computeClipBoxes(plan.clips[0]!)
    return {
      bar: boxes.find((box) => box.role === 'primaryBar')!,
      root: boxes.find((box) => box.role === 'root')!,
      title: boxes.find((box) => box.role === 'title')!,
      subBar: boxes.find((box) => box.role === 'secondaryBar')!
    }
  }

  it('主条宽度与文字长短无关：短/中/长文案都是「满宽减等边距」', async () => {
    const short = await layoutOf('新规发布', '省发展改革委解读')
    const mid = await layoutOf('长三角一体化新规今日正式发布', '省发展改革委负责人解读政策细节')
    const long = await layoutOf('长三角一体化发展新规今日正式对外发布并即日起施行'.repeat(2), '解 读')

    for (const layout of [short, mid, long]) {
      expect(layout.bar.w).toBe(layout.root.w)
      expect(layout.bar.x).toBe(1920 - (layout.bar.x + layout.bar.w))
    }
    expect(short.bar.w).toBe(mid.bar.w)
    expect(mid.bar.w).toBe(long.bar.w)
    // 左右边距 = 标题安全区内缩 × LAYOUT_INSET_SCALE（当前 0.5）：10% → 每边 96px
    expect(short.bar.x).toBe(96)
    expect(short.bar.w).toBe(1920 - 96 * 2)
    // 文字盒不得溢出条块
    expect(long.title.w).toBeLessThanOrEqual(long.bar.w)
  })

  it('8 套预设 × 长文案：主条满宽、标题换行、条高随行数长高', async () => {
    // 条块变宽（边距减半）后，样本必须显著超过可容纳宽度：88 字（Node 下字宽按 0.6em 估算也必然超宽）
    const longTitle = '长三角一体化发展新规今日正式对外发布并即日起施行'.repeat(4)
    const longSubtitle = '省发展改革委负责人表示新规将覆盖交通能源与数据要素三大领域'.repeat(2)
    let wrappedCount = 0
    for (const preset of PRESETS) {
      const short = await layoutOf('新规发布', '解读', preset.id)
      const long = await layoutOf(longTitle, longSubtitle, preset.id)
      const lineHeight = long.title.text!.lineHeightPx
      const lines = Math.round(long.title.h / lineHeight)

      expect(lines, `${preset.id} 长文案必须换行`).toBeGreaterThan(1)
      expect(lines, `${preset.id} 行数不得超过 3`).toBeLessThanOrEqual(3)
      expect(long.bar.h, `${preset.id} 条高应随行数长高`).toBeGreaterThan(short.bar.h)
      // 满宽减等边距：长短文案的条宽完全一致，且等于 root
      expect(long.bar.w, `${preset.id} 主条应与 root 同宽`).toBe(long.root.w)
      expect(long.bar.x, `${preset.id} 左右边距应相等`).toBe(1920 - (long.bar.x + long.bar.w))
      expect(long.title.w, `${preset.id} 文字不得溢出条块`).toBeLessThanOrEqual(long.bar.w)
      wrappedCount += 1
    }
    expect(wrappedCount).toBe(PRESETS.length)
  })

  it('副标题在上、主标题在下，副条仍按文字自适应', async () => {
    const short = await layoutOf('新规发布', '解读')
    const long = await layoutOf('新规发布', '省发展改革委负责人解读政策细节并回答记者提问')
    // 副条整体在主条上方（副条下沿不得低于主条下沿，且副条顶端更高）
    expect(short.subBar.y).toBeLessThan(short.bar.y)
    expect(short.subBar.y + short.subBar.h).toBeLessThanOrEqual(short.bar.y + short.bar.h)
    // 副条仍按文字长短自适应
    expect(short.subBar.w).toBeLessThan(long.subBar.w)
    expect(long.subBar.w).toBeLessThanOrEqual(long.bar.w)
  })

  it('超出最大行数时末行以省略号收尾（不静默丢字）', async () => {
    const measurer = getTextMeasurer()
    const font = { family: 'Noto Sans SC', weight: 500, sizePx: 60, trackingPx: 0 }
    const text = '一二三四五六七八九十'.repeat(6)
    const wrapped = measurer.wrap(text, font, 300, 3)
    expect(wrapped.lines).toHaveLength(3)
    expect(wrapped.truncated).toBe(true)
    expect(wrapped.lines[2]!.endsWith('…')).toBe(true)
    // 不超宽、不超行：每一行都能放进可用宽度
    for (const line of wrapped.lines) expect(measurer.widthOf(line, font)).toBeLessThanOrEqual(300 + 1)
    // 放得下时不截断
    const fits = measurer.wrap('一二三', font, 1000, 3)
    expect(fits).toMatchObject({ lines: ['一二三'], truncated: false })
  })
})

/**
 * 布局缓存键契约（计划 §2）。
 * 计划原文还提了「文本变化只 markDirty 对应文本节点」：本实现没有常驻 Yoga 树
 * （每次按键重建节点），而是把内容/字号都纳入缓存键，变了就整棵重算。
 * 代价实测可忽：布局只在作业/编辑时算一次，每帧成本为 0（见 computeLayoutCost）。
 * 这里锁住的是不能出错的那一半：**任何一个影响像素的字段变了，键必须变**。
 */
describe('布局缓存键契约（计划 §2）', () => {
  const planOf = (mutate?: (p: Project) => void, resolution?: { width: number; height: number }) => {
    const project = projectWith(1)
    mutate?.(project)
    return buildProjectPlan({
      project,
      resolution: resolution ?? { width: 1920, height: 1080 },
      fps: FPS_30,
      scope: { kind: 'timeline' },
      fontIndex: FONT_INDEX
    })
  }

  it('同一 plan 两次取键相同（否则每帧都会重算）', () => {
    const plan = planOf().clips[0]!
    expect(layoutCacheKey(plan)).toBe(layoutCacheKey(plan))
  })

  it('内容完全相同的两个片段共用同一个键（计划键组成不含片段 id）', () => {
    const project = projectWith(1)
    const base = project.clips[0]!
    const clone = { ...base, id: '另一个-id', startTime: base.startTime + 2, endTime: base.endTime + 2 }
    project.clips = [base, clone]
    const plan = buildProjectPlan({
      project,
      resolution: { width: 1920, height: 1080 },
      fps: FPS_30,
      scope: { kind: 'timeline' },
      fontIndex: FONT_INDEX
    })
    expect(layoutCacheKey(plan.clips[0]!)).toBe(layoutCacheKey(plan.clips[1]!))
  })

  it('标题变化会改变键（文字改了必须重算，不能吃旧缓存）', () => {
    expect(layoutCacheKey(planOf((p) => {
      p.clips[0]!.content = { title: '另一个完全不同的标题', subtitle: 'x' }
    }).clips[0]!)).not.toBe(layoutCacheKey(planOf().clips[0]!))
  })

  it('尺寸 / 宽高比分支 / 条透明度 / 令牌变化都会改变键', () => {
    const base = layoutCacheKey(planOf().clips[0]!)
    expect(layoutCacheKey(planOf(undefined, { width: 1280, height: 720 }).clips[0]!)).not.toBe(base)
    expect(layoutCacheKey(planOf(undefined, { width: 1080, height: 1920 }).clips[0]!)).not.toBe(base)
    expect(
      layoutCacheKey(
        planOf((p) => {
          p.clips[0]!.styleOverrides = { barOpacity: 0.5 }
        }).clips[0]!
      )
    ).not.toBe(base)
    expect(
      layoutCacheKey(
        planOf((p) => {
          p.clips[0]!.styleOverrides = { tokens: { primary: '#ff0000' } }
        }).clips[0]!
      )
    ).not.toBe(base)
  })

  it('非法颜色与不存在的令牌名被丢弃：键与像素都不受影响（规格 §7）', () => {
    const base = layoutCacheKey(planOf().clips[0]!)
    // primaryBar 不是令牌键（实际为 primary/accent/text/secondaryText/barBackground）
    expect(
      layoutCacheKey(
        planOf((p) => {
          p.clips[0]!.styleOverrides = { tokens: { primaryBar: '#ff0000' } as never }
        }).clips[0]!
      )
    ).toBe(base)
    expect(
      layoutCacheKey(
        planOf((p) => {
          p.clips[0]!.styleOverrides = { tokens: { primary: 'not-a-color' } }
        }).clips[0]!
      )
    ).toBe(base)
  })

  it('片段字体变化：要么键变，要么预设已固定该角色字体（两者必居其一，不能默默吃旧缓存）', () => {
    const base = planOf()
    const other = planOf((p) => {
      p.clips[0]!.fontId = 'builtin-notosanssc-900'
    })
    const keyChanged = layoutCacheKey(base.clips[0]!) !== layoutCacheKey(other.clips[0]!)
    // 预设把 title/subtitle 角色锁到内置字体时，片段 fontId 不影响任何像素，
    // 此时键不变是正确的；一旦角色跟随片段字体（builtinKey==='auto'），键必须变。
    const followsClipFont = (['title', 'subtitle'] as const).some(
      (role) => getPreset(base.clips[0]!.presetId).fonts[role].builtinKey === 'auto'
    )
    if (followsClipFont) expect(keyChanged).toBe(true)
    else {
      expect(base.clips[0]!.fonts.title.fontId).toBe(other.clips[0]!.fonts.title.fontId)
      expect(base.clips[0]!.fonts.subtitle.fontId).toBe(other.clips[0]!.fonts.subtitle.fontId)
    }
  })

  it('时长变化不改变键是合理的：盒模型不依赖时长（动画帧数已在键里）', () => {
    const base = layoutCacheKey(planOf().clips[0]!)
    const longer = layoutCacheKey(
      planOf((p) => {
        p.clips[0]!.endTime = p.clips[0]!.endTime + 2
      }).clips[0]!
    )
    expect(longer).toBe(base)
  })

  it('布局只在作业期算一次：每帧不重新计算（缓存键命中即复用）', async () => {
    const plan = buildProjectPlan({
      project: projectWith(1),
      resolution: { width: 1920, height: 1080 },
      fps: FPS_30,
      scope: { kind: 'timeline' },
      fontIndex: FONT_INDEX
    })
    const startedAt = performance.now()
    const first = await computeClipBoxes(plan.clips[0]!)
    const coldMs = performance.now() - startedAt
    const warmStartedAt = performance.now()
    const second = await computeClipBoxes(plan.clips[0]!)
    const warmMs = performance.now() - warmStartedAt
    expect(second).toEqual(first)
    // 命中缓存时应当明显快于首次（不断言具体数值，只断言量级）
    expect(warmMs).toBeLessThanOrEqual(Math.max(1, coldMs))
  })
})
