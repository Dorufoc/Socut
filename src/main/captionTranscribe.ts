import type {
  CaptionProgressEvent,
  CaptionTranscribeRequest,
  CaptionTranscribeResult
} from '../shared/api'
import type { WhisperSegment } from '../shared/whisper'

/**
 * M11：自动字幕的 IPC 会话层（主进程）。
 *
 * 为什么单独一层：whisper 转写是十秒级到分钟级的长任务，UI 需要「能看进度 + 能取消」。
 * 这里只做三件与进程无关的事：
 * 1. **会话表**：requestId → AbortController，重复点按不会并发跑两份（第二次明确报 CAPTION_BUSY）；
 * 2. **进度归一**：把 whisper 的百分比包成 `{requestId, percent, stage}` 再交给接线层发给渲染进程；
 * 3. **错误归一**：保留 `WhisperError.code` 原样透传（WHISPER_BINARY_MISSING / … / CANCELLED），
 *    取消时即使下层抛的是别的错误也统一成 CANCELLED。
 *
 * 真正的 whisper 进程/FFmpeg 抽音在 `src/main/whisper.ts`；IPC 通道接线在 `src/main/ipc.ts`。
 * 依赖注入（`deps.transcribe`）让这一层可以在测试里完全不碰真实资产。
 */

/** 会话层依赖的转写能力（`createWhisperManager().transcribe` 的形状子集）。 */
export interface CaptionTranscribeDeps {
  transcribe: (request: {
    mediaPath: string
    language?: string
    modelPath?: string
    onProgress?: (percent: number) => void
    /** M11：抽音阶段进度（0..99） */
    onPrepareProgress?: (percent: number) => void
    signal?: AbortSignal
  }) => Promise<{ cues: ReadonlyArray<WhisperSegment>; language?: string }>
}

export interface CaptionTranscribeService {
  /** 启动一次转写；`emitProgress` 由 IPC 接线层接到发起请求的 webContents 上。 */
  transcribe(
    request: CaptionTranscribeRequest,
    emitProgress?: (event: CaptionProgressEvent) => void
  ): Promise<CaptionTranscribeResult>
  /** 按 requestId 取消在跑的转写；没有该会话返回 false。 */
  cancel(requestId: string): boolean
  /** 在跑的会话数（测试与诊断用）。 */
  activeCount(): number
}

/** 进度百分比归一：四舍五入并夹到 0..100，非有限值按 0 处理。 */
function normalizePercent(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, Math.round(value)))
}

/** 从下层错误里取错误码：WhisperError 自带 code，其它错误兜底 WHISPER_ERROR。 */
function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code
  }
  return 'WHISPER_ERROR'
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  return String(error)
}

function failure(requestId: string, errorCode: string, errorMessage: string): CaptionTranscribeResult {
  return { requestId, ok: false, cues: [], language: null, errorCode, errorMessage }
}

/**
 * 校验渲染侧传来的原始参数。校验失败返回 null（IPC 接线层据此回 BAD_REQUEST，
 * 而不是把一个缺参数的请求丢给 whisper 管理器等它在 fs 层炸）。
 */
export function normalizeCaptionTranscribeRequest(raw: unknown): CaptionTranscribeRequest | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  const requestId = typeof value['requestId'] === 'string' ? value['requestId'].trim() : ''
  const mediaPath = typeof value['mediaPath'] === 'string' ? value['mediaPath'].trim() : ''
  if (requestId.length === 0 || mediaPath.length === 0) return null
  const language =
    typeof value['language'] === 'string' && value['language'].trim().length > 0 ? value['language'].trim() : undefined
  const modelPath =
    typeof value['modelPath'] === 'string' && value['modelPath'].trim().length > 0 ? value['modelPath'].trim() : undefined
  return {
    requestId,
    mediaPath,
    ...(language ? { language } : {}),
    ...(modelPath ? { modelPath } : {})
  }
}

export function createCaptionTranscribeService(deps: CaptionTranscribeDeps): CaptionTranscribeService {
  /** 在跑的转写会话：requestId → AbortController（取消 = abort，下层 kill 子进程） */
  const sessions = new Map<string, AbortController>()

  function transcribe(
    request: CaptionTranscribeRequest,
    emitProgress?: (event: CaptionProgressEvent) => void
  ): Promise<CaptionTranscribeResult> {
    if (sessions.has(request.requestId)) {
      return Promise.resolve(failure(request.requestId, 'CAPTION_BUSY', '同一自动字幕请求已在运行'))
    }
    const controller = new AbortController()
    sessions.set(request.requestId, controller)
    const report = (percent: number, stage: CaptionProgressEvent['stage']): void => {
      emitProgress?.({ requestId: request.requestId, percent: normalizePercent(percent), stage })
    }
    // 抽音阶段先报 0% 让 UI 立刻从「未开始」切到「进行中」；有真实进度时按抽音比例推进（0..99）
    report(0, 'prepare')
    return deps
      .transcribe({
        mediaPath: request.mediaPath,
        ...(request.language ? { language: request.language } : {}),
        ...(request.modelPath ? { modelPath: request.modelPath } : {}),
        signal: controller.signal,
        onPrepareProgress: (percent) => report(percent, 'prepare'),
        onProgress: (percent) => report(percent, 'transcribe')
      })
      .then((result): CaptionTranscribeResult => {
        return {
          requestId: request.requestId,
          ok: true,
          cues: result.cues.map((cue) => ({ startSec: cue.startSec, endSec: cue.endSec, text: cue.text })),
          language: result.language ?? null,
          errorCode: null,
          errorMessage: null
        }
      })
      .catch((error: unknown): CaptionTranscribeResult => {
        // 用户点了取消：下层按理抛 CANCELLED，但这里按 signal 兜底，避免错误码随实现漂移
        if (controller.signal.aborted) return failure(request.requestId, 'CANCELLED', '转写已取消')
        return failure(request.requestId, errorCodeOf(error), errorMessageOf(error))
      })
      .finally(() => {
        // busy 检查保证同一 requestId 只有一个会话，直接删即可
        sessions.delete(request.requestId)
      })
  }

  function cancel(requestId: string): boolean {
    const controller = sessions.get(requestId)
    if (!controller) return false
    controller.abort()
    return true
  }

  function activeCount(): number {
    return sessions.size
  }

  return { transcribe, cancel, activeCount }
}
