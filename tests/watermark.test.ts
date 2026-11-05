import { describe, expect, it } from 'vitest'
import {
  FPS_23_976,
  FPS_30,
  WATERMARK_BASE_RESOLUTION,
  WATERMARK_DISPLAY_SCALE,
  WATERMARK_MARGIN_PX
} from '@shared/constants'
import {
  buildImageSizeArgs,
  buildOverlayMp4,
  buildOverlayMp4DirectPipe,
  buildOverlayMp4MultiInput,
  buildOverlayMp4MultiInputDirectPipe,
  buildWatermarkFilterChain,
  buildWatermarkInputArgs,
  computeWatermarkGeometry,
  watermarkInputOf,
  buildFilterComplex
} from '@shared/ffmpegArgs'
import type { ConcatSegment, WatermarkInput } from '@shared/ffmpegArgs'
import { normalizeProject } from '@shared/projectSchema'
import { parseImageSize } from '@shared/probe'

/**
 * 水印（Watermark）：1080P 基准 → 原图 32% → 左上角 30px，随输出分辨率等比换算。
 *
 * 三条纪律都锁在这里：
 * - 几何换算是纯函数，预览与导出共用（预览看到的位 == 导出的位）；
 * - 未启用水印时四条合成路径的 argv **一个字节都不许变**（否则视觉/CLI 冒烟会出现假回归）；
 * - 滤镜链永远是最后一层（字幕层让位给 [vsub]，`-map [v]` 不动）。
 */

/** 800×450 的台标：1080P 基准下 256×144，整数无舍入，便于核对 */
const LOGO: WatermarkInput = { path: 'D:/brand/logo.png', sourceWidth: 800, sourceHeight: 450 }

/** 从 argv 里取滤镜图；不存在时给空串，让断言以可读的方式失败而不是抛 undefined */
function graphOf(args: string[]): string {
  const index = args.indexOf('-filter_complex')
  return index >= 0 ? (args[index + 1] ?? '') : ''
}

describe('水印常量与几何换算', () => {
  it('基准与系数按需求定义：1920×1080 / 32% / 30px', () => {
    expect(WATERMARK_BASE_RESOLUTION).toEqual({ width: 1920, height: 1080 })
    expect(WATERMARK_DISPLAY_SCALE).toBe(0.32)
    expect(WATERMARK_MARGIN_PX).toBe(30)
  })

  it('1080P 基准：显示尺寸 = 原图 × 32%，距顶/左各 30px', () => {
    expect(computeWatermarkGeometry(LOGO, { width: 1920, height: 1080 })).toEqual({
      width: 256,
      height: 144,
      x: 30,
      y: 30
    })
  })

  it('非 1080P 按高度比等比换算（720p=×2/3，4K=×2）', () => {
    expect(computeWatermarkGeometry(LOGO, { width: 1280, height: 720 })).toEqual({
      width: 171,
      height: 96,
      x: 20,
      y: 20
    })
    expect(computeWatermarkGeometry(LOGO, { width: 3840, height: 2160 })).toEqual({
      width: 512,
      height: 288,
      x: 60,
      y: 60
    })
  })

  it('相对位置与相对大小随分辨率保持不变（16:9 各档同比例）', () => {
    const ratios = [
      { width: 1280, height: 720 },
      { width: 1920, height: 1080 },
      { width: 3840, height: 2160 }
    ].map((output) => {
      const box = computeWatermarkGeometry(LOGO, output)
      return { w: box.width / output.width, x: box.x / output.width }
    })
    for (const ratio of ratios) {
      expect(ratio.w).toBeCloseTo(256 / 1920, 2)
      expect(ratio.x).toBeCloseTo(30 / 1920, 2)
    }
  })

  it('竖屏按高度换算，图片不被拉变形（宽高比保持 16:9 原样）', () => {
    const box = computeWatermarkGeometry(LOGO, { width: 1080, height: 1920 })
    expect(box.height / box.width).toBeCloseTo(450 / 800, 2)
    expect(box.x).toBe(53)
    expect(box.y).toBe(53)
  })

  it('极端输入夹进画面：图比画大、尺寸缺失、输出高度为 0 都不出负坐标或 0 尺寸', () => {
    const huge = computeWatermarkGeometry({ path: 'D:/a.png', sourceWidth: 10_000, sourceHeight: 10_000 }, { width: 1920, height: 1080 })
    expect(huge).toEqual({ width: 1920, height: 1080, x: 0, y: 0 })
    const zero = computeWatermarkGeometry({ path: 'D:/a.png', sourceWidth: 0, sourceHeight: 0 }, { width: 1920, height: 1080 })
    expect(zero.width).toBe(1)
    expect(zero.height).toBe(1)
    const noHeight = computeWatermarkGeometry(LOGO, { width: 1920, height: 0 })
    expect(noHeight.width).toBe(256) // 因子退回 1，不按 0 缩成看不见
    expect(noHeight.x).toBe(30)
  })

  it('滤镜链：图片先转 rgba 再缩放，叠在 [vsub] 之上并落回 yuv420p', () => {
    const chain = buildWatermarkFilterChain({ label: 2, prevLabel: 'vsub', watermark: LOGO, output: { width: 1920, height: 1080 } })
    expect(chain[0]).toBe('[2:v]format=rgba,scale=256:144[wm]')
    expect(chain[1]).toBe('[vsub][wm]overlay=30:30:alpha=straight:format=auto:eof_action=pass,format=yuv420p[v]')
  })

  it('输入参数：循环图片 + 目标帧率，不带 -t（overlay 在基座 EOF 时结束）', () => {
    expect(buildWatermarkInputArgs(LOGO, FPS_30)).toEqual(['-loop', '1', '-framerate', '30/1', '-i', 'D:/brand/logo.png'])
    expect(buildWatermarkInputArgs(LOGO, FPS_23_976)).toContain('24000/1001')
  })

  it('设置归一：路径或尺寸不可用时返回 undefined（退回无水印 argv）', () => {
    expect(watermarkInputOf(undefined)).toBeUndefined()
    expect(watermarkInputOf({ path: '', sourceWidth: 800, sourceHeight: 450 })).toBeUndefined()
    expect(watermarkInputOf({ path: 'D:/a.png', sourceWidth: 0, sourceHeight: 450 })).toBeUndefined()
    expect(watermarkInputOf({ path: 'D:/a.png', sourceWidth: 800.4, sourceHeight: 450.6 })).toEqual({
      path: 'D:/a.png',
      sourceWidth: 800,
      sourceHeight: 451
    })
  })

  it('图片尺寸探测参数：限定字段也必须带 codec_type，且不存在 -nologo', () => {
    const args = buildImageSizeArgs('D:/brand/logo.png')
    expect(args).toContain('-select_streams')
    expect(args).toContain('stream=codec_type,width,height')
    expect(args).not.toContain('-nologo')
    expect(args.at(-1)).toBe('D:/brand/logo.png')
  })
})

describe('ffprobe 图片载荷解析', () => {
  it('取第一路视频流的宽高（字符串数值同样可解析）', () => {
    expect(parseImageSize({ streams: [{ codec_type: 'video', width: 800, height: 450 }] })).toEqual({ width: 800, height: 450 })
    expect(parseImageSize({ streams: [{ codec_name: 'png', width: '64', height: '64' }] })).toEqual({ width: 64, height: 64 })
  })

  it('结构缺失、非图片流或尺寸非法都返回 null（让调用方按探测失败处理）', () => {
    expect(parseImageSize(null)).toBeNull()
    expect(parseImageSize({ streams: [] })).toBeNull()
    expect(parseImageSize({ streams: [{ codec_type: 'audio', width: 800, height: 450 }] })).toBeNull()
    expect(parseImageSize({ streams: [{ codec_type: 'video', width: 0, height: 450 }] })).toBeNull()
    expect(parseImageSize({ streams: [{ codec_type: 'video', width: 800.5 }] })).toBeNull()
  })
})

describe('叠加合成 argv 的水印分支', () => {
  const single = {
    refVideoPath: 'D:/videos/ref.mp4',
    overlayPath: 'C:/tmp/overlay.mov',
    outputPath: 'D:/out/final.mp4',
    fps: FPS_30,
    frameSize: { width: 1920, height: 1080 },
    spanStartSec: 0,
    spanEndSec: 5,
    audioMode: 'copy' as const,
    fpsMode: 'cfr' as const
  }

  it('两阶段单输入：水印是第三路 -i，接在透明 MOV 之后', () => {
    const args = buildOverlayMp4({ ...single, watermark: LOGO })
    expect(args.filter((a) => a === '-i')).toHaveLength(3)
    expect(args.indexOf('D:/brand/logo.png')).toBeGreaterThan(args.indexOf('C:/tmp/overlay.mov'))
    expect(args).toContain('-loop')
    const graph = graphOf(args)
    expect(graph).toContain('[v0][ov]overlay=0:0:alpha=straight:format=auto:eof_action=pass:enable=\'between(t,0.000000,5.000000)\',format=yuv420p[vsub]')
    expect(graph).toContain('[2:v]format=rgba,scale=256:144[wm]')
    expect(graph).toContain('[vsub][wm]overlay=30:30:alpha=straight:format=auto:eof_action=pass,format=yuv420p[v]')
    expect(graph.endsWith('format=yuv420p[v]')).toBe(true)
    expect(args).toContain('[v]')
  })

  it('直接管道单输入：stdin 仍是序号 1，水印固定序号 2', () => {
    const args = buildOverlayMp4DirectPipe({ ...single, frameFormat: 'raw', watermark: LOGO })
    expect(args).toContain('rawvideo')
    expect(args.filter((a) => a === '-i')).toHaveLength(3)
    const graph = graphOf(args)
    expect(graph).toContain('[2:v]format=rgba,scale=256:144[wm]')
    expect(args).toContain('D:/brand/logo.png')
  })

  const seg = (over: Partial<ConcatSegment> = {}): ConcatSegment => ({
    refVideoPath: 'D:/media/a.mp4',
    timelineStartSec: 0,
    timelineEndSec: 4,
    sourceInSec: 0,
    sourceOutSec: 4,
    hasAudio: true,
    ...over
  })
  const basis = {
    segments: [seg(), seg({ refVideoPath: 'D:/media/b.mp4', timelineStartSec: 4, timelineEndSec: 8, sourceInSec: 0, sourceOutSec: 4 })],
    spanStartSec: 0,
    spanEndSec: 10,
    overlayLabel: '2',
    outputPath: 'D:/out/comp.mp4',
    fps: FPS_30,
    frameSize: { width: 1280, height: 720 },
    audioMode: 'aac' as const,
    fpsMode: 'cfr' as const
  }

  it('多输入拼接：水印序号 = 透明层序号 + 1，几何按 frameSize 换算', () => {
    const args = buildOverlayMp4MultiInput({ ...basis, overlayPath: 'D:/tmp/overlay.mov', watermark: LOGO })
    expect(args.filter((a) => a === '-i')).toHaveLength(4)
    const graph = graphOf(args)
    expect(graph).toContain('[3:v]format=rgba,scale=171:96[wm]')
    expect(graph).toContain('[vsub][wm]overlay=20:20:alpha=straight')
    expect(args[args.indexOf('-map') + 1]).toBe('[v]')
  })

  it('多输入直管道：媒体 → stdin → 水印的顺序与标签一致', () => {
    const args = buildOverlayMp4MultiInputDirectPipe({ ...basis, frameFormat: 'raw', watermark: LOGO })
    expect(args).toContain('pipe:0')
    expect(args).toContain('D:/brand/logo.png')
    const graph = graphOf(args)
    expect(graph).toContain('[3:v]format=rgba,scale=171:96[wm]')
  })

  it('未启用水印：四条路径的 argv 与旧快照逐字节一致（不引入 vsub / 多余输入）', () => {
    const plain = buildOverlayMp4(single)
    expect(plain.join(' ')).not.toContain('vsub')
    expect(plain.join(' ')).not.toContain('[wm]')
    expect(plain.filter((a) => a === '-i')).toHaveLength(2)
    expect(graphOf(plain)).toBe(buildFilterComplex(0, 5, FPS_30))

    const plainPipe = buildOverlayMp4DirectPipe({ ...single, frameFormat: 'raw' })
    expect(plainPipe.join(' ')).not.toContain('logo.png')
    expect(graphOf(plainPipe)).toBe(buildFilterComplex(0, 5, FPS_30))

    const plainMulti = buildOverlayMp4MultiInput({ ...basis, overlayPath: 'D:/tmp/overlay.mov' })
    expect(plainMulti.join(' ')).not.toContain('vsub')
    expect(plainMulti.filter((a) => a === '-i')).toHaveLength(3)

    const plainMultiPipe = buildOverlayMp4MultiInputDirectPipe({ ...basis, frameFormat: 'raw' })
    expect(plainMultiPipe.join(' ')).not.toContain('[wm]')
    expect(plainMultiPipe.at(-1)).toBe('D:/out/comp.mp4')
  })
})

describe('工程里的水印持久化', () => {
  const projectOf = (watermark: unknown) =>
    normalizeProject({
      version: 2,
      name: '水印测试',
      resolution: { width: 1920, height: 1080 },
      fps: { num: 30, den: 1 },
      clips: [],
      fonts: [],
      media: [],
      mediaClips: [],
      watermark
    })

  it('合法设置原样保留，缺省 enabled 视为启用，展示名回落到文件名', () => {
    const loaded = projectOf({ path: 'D:\\brand\\logo.png', sourceWidth: 800, sourceHeight: 450 })
    expect(loaded?.watermark).toEqual({
      enabled: true,
      path: 'D:\\brand\\logo.png',
      name: 'logo.png',
      sourceWidth: 800,
      sourceHeight: 450,
      importedAt: expect.any(String)
    })
  })

  it('开关可以关着存（保留路径与尺寸，随时可再启用）', () => {
    const loaded = projectOf({ path: 'D:/a.png', name: '台标', sourceWidth: 64, sourceHeight: 64, enabled: false })
    expect(loaded?.watermark?.enabled).toBe(false)
    expect(loaded?.watermark?.name).toBe('台标')
  })

  it('路径或尺寸不可用时整字段丢弃，不带坏整个工程', () => {
    expect(projectOf({ path: '', sourceWidth: 800, sourceHeight: 450 })?.watermark).toBeUndefined()
    expect(projectOf({ path: 'D:/a.png', sourceWidth: 0, sourceHeight: 450 })?.watermark).toBeUndefined()
    expect(projectOf('D:/a.png')?.watermark).toBeUndefined()
    // 字段整个缺失 = 未导入（旧工程读出 undefined，行为与升级前一致）
    expect(projectOf(undefined)?.watermark).toBeUndefined()
  })
})
