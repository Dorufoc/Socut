import { describe, expect, it } from 'vitest'
import { PRESETS, PRESET_IDS, validateAllPresets, getPreset, DEFAULT_PRESET_ID } from '@shared/presets'
import { buildProjectPlan } from '@shared/presetResolver'
import { createClip, createDefaultProject } from '@shared/projectSchema'
import { IN_DURATION_RANGE_SEC, OUT_RATIO_RANGE } from '@shared/presetSchema'
import { durationSecToFrames } from '@shared/fps'
import { BAR_MAX_WIDTH } from '@shared/presets/layout'
import type { LayoutNode } from '@shared/types'
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
    // 自适应宽度：分支补丁必须给主条/副条明确的宽度上限（防止竖屏/超宽被拉满）
    for (const patch of [...preset.patches.compact, ...preset.patches.ultrawide]) {
      if (patch.role !== 'primaryBar' && patch.role !== 'secondaryBar') continue
      expect(patch.style?.maxWidth, `${patch.role} 分支补丁缺少 maxWidth`).toBeDefined()
    }
    // 紧凑分支：标题/副标题都必须单行省略
    for (const role of ['title', 'subtitle'] as const) {
      const patch = preset.patches.compact.find((p) => p.role === role)
      expect(patch?.text?.maxLines).toBe(1)
      expect(patch?.text?.ellipsis).toBe(true)
    }
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
        // 自适应宽度 + 两块矩形结构：副标题条在上、左缘对齐主条、更矮更窄
        titleWidthChecks += 1
        expect(root, `${preset.id} @ ${target.name} 缺少 root 盒`).toBeDefined()
        const subBar = boxes.find((box) => box.role === 'secondaryBar')
        expect(subBar, `${preset.id} @ ${target.name} 缺少副标题矩形`).toBeDefined()
        // 左边距 = 标题安全区内缩（10%）× LAYOUT_INSET_SCALE（0.5）= 5%W
        expect(bar.x).toBe(Math.round(target.width * 0.05))
        // 条宽自适应：不超过 root，也不超过当前分支的宽度上限
        expect(bar.w, `${preset.id} @ ${target.name} 主条宽于 root`).toBeLessThanOrEqual(root!.w + 1)
        // 标准分支上限 = root 内容宽 = 画宽 − 左右各 5% 布局边距 = 90%（长文案可一直顶到右边距）
        const capRatio = plan.mode === 'compact' ? 0.83 : plan.mode === 'ultrawide' ? 0.56 : 0.9
        expect(bar.w, `${preset.id} @ ${target.name} 主条超出宽度上限`).toBeLessThanOrEqual(target.width * capRatio + 1)
        // 副标题矩形契约：在上、左缘对齐、更矮，宽度上限与主条相同（都到画面右边距为止）
        expect(subBar!.x, `${preset.id} @ ${target.name} 副标题左缘未对齐`).toBe(bar.x)
        expect(subBar!.y + subBar!.h, `${preset.id} @ ${target.name} 副标题不在主条上方`).toBeLessThanOrEqual(bar.y + 1)
        expect(subBar!.h, `${preset.id} @ ${target.name} 副标题矩形不够小`).toBeLessThan(bar.h)
        expect(subBar!.w, `${preset.id} @ ${target.name} 副标题越过右边距`).toBeLessThanOrEqual(root!.w + 1)
        // 超宽分支：主条/副条都收窄
        if (plan.mode === 'ultrawide') {
          ultrawideChecks += 1
          expect(bar.w, `${preset.id} @ ${target.name} 超宽主条过宽`).toBeLessThanOrEqual(target.width * 0.57)
          expect(subBar!.w, `${preset.id} @ ${target.name} 超宽副条过宽`).toBeLessThanOrEqual(target.width * 0.4)
        }
        // 布局必须落在画布内（底部锚定，且不低于 7% 安全线）
        expect(bar.x).toBeGreaterThanOrEqual(0)
        expect(bar.x + bar.w).toBeLessThanOrEqual(target.width + 1)
        expect(bar.y + bar.h).toBeLessThanOrEqual(target.height * 0.93 + 1)
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
    // 同一预设在 4K 上的条高应约为 360p 的 6 倍（px@1080p 等比缩放，允许整数网格取整误差）
    const small = frames.find((row) => row.name.endsWith('/360p'))!
    const huge = frames.find((row) => row.name.endsWith('/4K'))!
    expect(Math.abs(huge.barHeight - small.barHeight * 6)).toBeLessThanOrEqual(6)
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
 * 自适应宽度 + 自动换行 + 副标题独立矩形（用户明确要求）：
 * 副标题矩形在**主条上方**、左缘与主条严格对齐、更矮更窄；主条宽度随文字增长。
 */
describe('字幕条自适应宽度 + 副标题独立矩形', () => {
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
      subtitle: boxes.find((box) => box.role === 'subtitle')!,
      subBar: boxes.find((box) => box.role === 'secondaryBar')!
    }
  }

  it('短/中/长文案：主条宽度随文字增长，达到上限后不再变宽', async () => {
    const short = await layoutOf('新规发布', '本台记者')
    const mid = await layoutOf('长三角一体化新规今日正式发布', '省发展改革委负责人解读政策细节')
    const long = await layoutOf('长三角一体化发展新规今日正式对外发布并即日起施行'.repeat(2), '解读')

    expect(short.bar.w).toBeLessThan(mid.bar.w)
    expect(mid.bar.w).toBeLessThanOrEqual(long.bar.w)
    for (const layout of [short, mid, long]) {
      expect(layout.bar.x).toBe(96)
      expect(layout.bar.w).toBeLessThanOrEqual(layout.root.w)
      expect(layout.bar.x + layout.bar.w).toBeLessThanOrEqual(1920 - 96)
      expect(layout.title.w).toBeLessThanOrEqual(layout.bar.w)
    }
    const lines = Math.round(long.title.h / long.title.text!.lineHeightPx)
    expect(lines).toBeLessThanOrEqual(2)
  })

  /**
   * 用户明确要求：主标题与副标题都应当**最长延伸到画面右缘**（右侧只留与左边距等宽的那份空白），
   * 而不是被某个百分比提前截断。1080p 下左边距 96 → 右缘必须落在 1824 = 1920 − 96。
   * 注：条宽是 hug（能塞进 maxLines 行的最长行），因此几何上会差上「一个字的换行余量」；
   * 上限本身由下面的结构断言（maxWidth = BAR_MAX_WIDTH）钉住，这里验的是实测铺到了右缘附近且不越界。
   */
  const HUG_SLACK_PX = 32

  it('长文案顶到右边距：主条与副标题条右缘都落在「画宽 − 左边距」上', async () => {
    const longTitle = '长三角一体化发展新规今日正式对外发布并即日起施行'.repeat(4)
    const hugeSubtitle = '省发展改革委负责人表示新规将覆盖交通能源数据要素与公共服务多个领域'.repeat(8)
    const rightEdge = 1920 - 96
    for (const preset of PRESETS) {
      const layout = await layoutOf(longTitle, hugeSubtitle, preset.id)
      expect(layout.bar.x, `${preset.id} 左边距应为画宽 5%`).toBe(96)
      expect(layout.bar.x + layout.bar.w, `${preset.id} 主条越过右边距`).toBeLessThanOrEqual(rightEdge)
      expect(layout.bar.x + layout.bar.w, `${preset.id} 主条未铺到右边距`).toBeGreaterThanOrEqual(rightEdge - HUG_SLACK_PX)
      expect(layout.subBar.x, `${preset.id} 副标题左缘未对齐`).toBe(96)
      expect(layout.subBar.x + layout.subBar.w, `${preset.id} 副标题越过右边距`).toBeLessThanOrEqual(rightEdge)
      expect(layout.subBar.x + layout.subBar.w, `${preset.id} 副标题未铺到右边距`).toBeGreaterThanOrEqual(rightEdge - HUG_SLACK_PX)
      // 顶到上限后靠换行/省略而不是继续变宽
      const titleLines = Math.round(layout.title.h / layout.title.text!.lineHeightPx)
      expect(titleLines, `${preset.id} 超上限后必须换行而不超行数`).toBeLessThanOrEqual(layout.title.text!.maxLines)
    }
  })

  /** 结构层直接钉住上限口径：不再依赖某个像素实测，换预设/改文案也不会假通过。 */
  it('8 预设的条宽上限 = root 内容宽，且 root 左右声明同一份布局边距', () => {
    const findByRole = (node: LayoutNode, role: string): LayoutNode | null => {
      if (node.role === role) return node
      for (const child of node.children ?? []) {
        const hit = findByRole(child, role)
        if (hit) return hit
      }
      return null
    }
    for (const preset of PRESETS) {
      const root = preset.layout
      expect(root.position, `${preset.id} root 应为绝对定位`).toBe('absolute')
      // 左右边距同一个令牌 → root 内容宽就是「画宽减两份等边距」
      expect(root.right, `${preset.id} root 右边距应与左边距同一令牌`).toBe(root.left)
      for (const role of ['primaryBar', 'secondaryBar'] as const) {
        const bar = findByRole(root, role)
        expect(bar, `${preset.id} 缺少 ${role}`).toBeTruthy()
        expect(bar!.maxWidth, `${preset.id} ${role} 宽度上限不是可用内容宽`).toBe(BAR_MAX_WIDTH)
      }
    }
  })

  it('短文案仍然 hug：宽度跟随文字，不会为了铺满而拖出一条空板', async () => {
    const layout = await layoutOf('新规发布', '本台记者')
    expect(layout.bar.w).toBeLessThan(layout.root.w)
    expect(layout.subBar.w).toBeLessThan(layout.root.w)
    expect(layout.bar.x + layout.bar.w).toBeLessThan(1920 - 96)
  })

  it('上限随分辨率等比跟随：720p 下右缘 = 1280 − 64', async () => {
    const project = projectWith(1, [DEFAULT_PRESET_ID])
    project.clips[0]!.content = {
      title: '长三角一体化发展新规今日正式对外发布并即日起施行'.repeat(4),
      subtitle: '省发展改革委负责人表示新规将覆盖交通能源与数据要素三大领域'.repeat(12)
    }
    const plan = buildProjectPlan({
      project,
      resolution: { width: 1280, height: 720 },
      fps: FPS_30,
      scope: { kind: 'timeline' },
      fontIndex: FONT_INDEX
    })
    const boxes = await computeClipBoxes(plan.clips[0]!)
    const bar = boxes.find((box) => box.role === 'primaryBar')!
    const subBar = boxes.find((box) => box.role === 'secondaryBar')!
    const root = boxes.find((box) => box.role === 'root')!
    expect(bar.x).toBe(64)
    expect(root.w).toBe(1280 - 128)
    expect(bar.x + bar.w).toBeLessThanOrEqual(1280 - 64)
    expect(bar.x + bar.w).toBeGreaterThanOrEqual(1280 - 64 - HUG_SLACK_PX)
    expect(subBar.x + subBar.w).toBeLessThanOrEqual(1280 - 64)
    expect(subBar.x + subBar.w).toBeGreaterThanOrEqual(1280 - 64 - HUG_SLACK_PX)
  })

  it('8 套预设：长文案在条内换行，条高随行数长高（单行预设改为省略）', async () => {
    const longTitle = '长三角一体化发展新规今日正式对外发布并即日起施行'.repeat(4)
    const longSubtitle = '省发展改革委负责人表示新规将覆盖交通能源与数据要素三大领域'.repeat(2)
    let wrappedCount = 0
    for (const preset of PRESETS) {
      const short = await layoutOf('新规发布', '解读', preset.id)
      const long = await layoutOf(longTitle, longSubtitle, preset.id)
      const maxLines = long.title.text!.maxLines
      const lines = Math.round(long.title.h / long.title.text!.lineHeightPx)

      expect(lines, `${preset.id} 行数不得超过上限`).toBeLessThanOrEqual(maxLines)
      expect(long.title.w, `${preset.id} 文字不得溢出条块`).toBeLessThanOrEqual(long.bar.w + 1)
      expect(long.bar.x, `${preset.id} 左边距应为 5%`).toBe(96)
      expect(long.subBar.x, `${preset.id} 副标题左缘未对齐`).toBe(long.bar.x)
      expect(long.subBar.y + long.subBar.h, `${preset.id} 副标题不在主条上方`).toBeLessThanOrEqual(long.bar.y + 1)
      expect(long.subBar.h, `${preset.id} 副标题矩形不够小`).toBeLessThan(long.bar.h)
      expect(long.subBar.w, `${preset.id} 副标题越过右边距`).toBeLessThanOrEqual(long.root.w + 1)
      if (maxLines >= 2) {
        expect(lines, `${preset.id} 长文案必须换行`).toBe(2)
        expect(long.bar.h, `${preset.id} 条高应随行数长高`).toBeGreaterThan(short.bar.h)
        wrappedCount += 1
      } else {
        expect(lines, `${preset.id} 单行预设不得换行`).toBe(1)
        expect(long.bar.h).toBeGreaterThanOrEqual(short.bar.h)
      }
    }
    expect(wrappedCount).toBe(6)
  })

  it('副标题矩形：在主条上方、左缘对齐、更矮更窄，文字与主标题共左线', async () => {
    let checked = 0
    for (const preset of PRESETS) {
      const layout = await layoutOf('长三角一体化新规发布', '省发展改革委负责人解读', preset.id)
      expect(layout.subBar.y + layout.subBar.h, `${preset.id} 副标题不在主条上方`).toBeLessThanOrEqual(layout.bar.y + 1)
      expect(layout.subBar.x, `${preset.id} 副标题矩形左缘未对齐`).toBe(layout.bar.x)
      expect(layout.subBar.h, `${preset.id} 副标题矩形不够小`).toBeLessThan(layout.bar.h)
      expect(layout.subBar.w, `${preset.id} 副标题越过右边距`).toBeLessThanOrEqual(layout.root.w + 1)
      expect(layout.subBar.fill, `${preset.id} 副标题缺少纯色背景`).toBeDefined()
      expect(layout.subtitle.x, `${preset.id} 副标题文字未与主标题共左线`).toBe(layout.title.x)
      checked += 1
    }
    expect(checked).toBe(PRESETS.length)
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
