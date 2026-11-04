import { createClip, createDefaultProject, createId } from '@shared/projectSchema'
import { snapTimeToFrame } from '@shared/fps'
import { FPS_30 } from '@shared/constants'
import { getPreset } from '@shared/presets'
import type { ExportRequest, FontRecord } from '@shared/types'
import { buildRenderJob } from '../render/jobBuilder'
import { frameSpecOf, registerExportJob } from '../render/frameSource'
import { ensureFontRegistered } from '../hooks/useFontLoader'
import { waitForResult } from '../state/jobEvents'
import { useExportStore } from '../state/exportStore'

/**
 * 错误呈现取证（计划 M4-2 / 规格 §9）。
 * 触发一次**真实失败**（输出到一个不存在的盘符），然后从渲染侧读取
 * 失败面板的数据源：code · message · stderr 尾部长度 · 完整命令行段数。
 * 面板本身（LastResultPanel）渲染的就是 useExportStore.lastResult，
 * 因此这里断言的是「用户能不能看到命令行」这件可验证的事实，而不是只看代码。
 */
export interface ErrorDemoReport {
  jobId: string
  ok: boolean
  errorCode: string | null
  errorMessage: string | null
  stderrTailBytes: number
  /** 失败面板能不能拿到完整命令行（规格 §9） */
  argvSegments: number
  argvHasBinary: boolean
  noticeCount: number
  /** 面板实际读到的就是 store 里这份 lastResult */
  panelSeesSameResult: boolean
}

export async function runErrorDemo(fontIndex: FontRecord[]): Promise<ErrorDemoReport> {
  const fps = FPS_30
  const project = createDefaultProject('error-demo')
  project.resolution = { width: 640, height: 360 }
  project.fps = fps
  const clip = createClip({ startTime: 0, fps })
  clip.presetId = 'stackedNews'
  clip.content = { title: '错误呈现取证：这条导出注定失败', subtitle: '输出目录指向不存在的盘符' }
  clip.startTime = snapTimeToFrame(0, fps)
  clip.endTime = snapTimeToFrame(1, fps)
  clip.animation = { ...getPreset('stackedNews').animation }
  project.clips = [clip]

  for (const record of fontIndex) {
    try {
      await ensureFontRegistered(record)
    } catch {
      // 单只字体缺失不影响本次取证
    }
  }

  const spec = await buildRenderJob({
    project,
    fontIndex,
    resolution: { width: 640, height: 360 },
    fps,
    scope: { kind: 'timeline' },
    frameFormat: 'raw'
  })

  const jobId = createId('errdemo')
  registerExportJob(jobId, spec)
  const request: ExportRequest = {
    jobId,
    // 不存在的盘符：FFmpeg 打不开输出文件，必然失败并带上 argv
    target: { kind: 'transparentMov', outputDir: 'Z:\\focusnews-does-not-exist', fileName: 'err-demo.mov' },
    frameSpec: frameSpecOf(spec),
    frameDelivery: 'pipe',
    codec: 'prores4444'
  }
  const startPromise = window.focusnews.export.start(request)
  // 等失败结果回到渲染侧（这就是失败面板的数据源）
  const result = await waitForResult(jobId, 60_000)
  await startPromise
  const last = useExportStore.getState().lastResult
  const argv = result?.error?.argv ?? []
  return {
    jobId,
    ok: result?.ok ?? true,
    errorCode: result?.error?.code ?? null,
    errorMessage: result?.error?.message ?? null,
    stderrTailBytes: result?.error?.stderrTail?.length ?? 0,
    argvSegments: argv.length,
    argvHasBinary: argv.length > 0 && /ffmpeg(\.exe)?$/i.test(argv[0] ?? ''),
    noticeCount: result?.progress.notices?.length ?? 0,
    panelSeesSameResult: last !== null && last.jobId === jobId && (last.error?.argv?.length ?? 0) === argv.length
  }
}
