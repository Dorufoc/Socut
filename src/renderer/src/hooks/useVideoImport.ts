import { useCallback } from 'react'
import { TEXT } from '@shared/i18n'
import { createId } from '@shared/projectSchema'
import type { MediaItem, VideoMeta } from '@shared/types'
import { askHdr, askNon169, askVfr } from '../dialog/ask'
import { waitForResult } from '../state/jobEvents'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'

/**
 * 参考视频导入（规格 §6）。
 * 模态优先级：非 16:9 → HDR → VFR；任何一步选择「取消」都终止该枚导入，不写入素材池。
 * v2：门禁确认位下放到枚级——导入落进 MediaItem 池，每枚各自确认、各自记录 VFR 策略。
 */

export interface PickedVideo {
  path: string
  probe: NonNullable<Awaited<ReturnType<typeof window.focusnews.video.probe>>>
}

export interface MediaImportOutcome {
  /** 门禁中途取消（该枚不写入素材池） */
  cancelled: boolean
  /** 写入素材池的 mediaId；cancelled 时为 null */
  mediaId: string | null
  path: string
  /** 「转换并导入」的 CFR 产物路径（验收第 6 条取证用） */
  cfrPath: string | null
  vfrPolicy: MediaItem['vfrPolicy']
  sourcePath: string | null
}

/**
 * 门禁主体：拿到已探测的视频就依次弹模态。
 * 拆成独立函数是为了让应用内门禁取证能走**同一段代码**（而不是写一份平行的模拟逻辑），
 * 否则测的就不是用户真正点到的那条路径。
 */
export async function importMediaWith(picked: PickedVideo): Promise<MediaImportOutcome> {
  const setNotice = useUiStore.getState().setNotice
  const { path, probe } = picked
  const meta: VideoMeta = probe.meta

  if (probe.flags.non169) {
    const label = `${TEXT.modalNon169.body}（显示宽高比 ${meta.displayRatio.toFixed(3)} : 1，${meta.width}×${meta.height}）`
    const ok = await askNon169(label)
    if (!ok) {
      setNotice('导入已取消（非 16:9 未确认）')
      return { cancelled: true, mediaId: null, path, cfrPath: null, vfrPolicy: 'none', sourcePath: null }
    }
  }

  if (probe.flags.hdr) {
    const label = `${TEXT.modalHdr.body}（color_transfer=${meta.colorTransfer ?? '—'}，primaries=${meta.colorPrimaries ?? '—'}）`
    const ok = await askHdr(label)
    if (!ok) {
      setNotice('导入已取消（HDR 降级未确认）')
      return { cancelled: true, mediaId: null, path, cfrPath: null, vfrPolicy: 'none', sourcePath: null }
    }
  }

  let usePath = path
  let useMeta = meta
  let sourcePath: string | undefined
  let cfrPath: string | null = null
  let vfrPolicy: MediaItem['vfrPolicy'] = 'none'

  if (probe.flags.vfr) {
    const evidence = probe.vfrEvidence
    const label =
      `${TEXT.modalVfr.body}\n` +
      `r_frame_rate=${meta.rFrameRate.num}/${meta.rFrameRate.den}，avg_frame_rate=${meta.avgFrameRate.num}/${meta.avgFrameRate.den}` +
      (evidence ? `\n抽样 ${evidence.sampledPackets} 个包，最大间隔 ${evidence.maxGapSec.toFixed(4)}s（期望 ${evidence.expectedGapSec.toFixed(4)}s）` : '')
    const answer = await askVfr(label)
    if (answer === 'cancel') {
      setNotice('导入已取消（VFR 处理方式未选择）')
      return { cancelled: true, mediaId: null, path, cfrPath: null, vfrPolicy: 'none', sourcePath: null }
    }
    if (answer === 'convert') {
      setNotice(`正在转换为 CFR（${probe.suggestedFps.num}/${probe.suggestedFps.den}）…`)
      try {
        const job = await window.focusnews.video.cfrConvert(path, probe.suggestedFps, meta)
        const result = await waitForResult(job.jobId)
        if (!result.ok) {
          setNotice(`CFR 转换失败：${result.error?.message ?? '未知原因'}`)
          return { cancelled: true, mediaId: null, path, cfrPath: null, vfrPolicy: 'none', sourcePath: null }
        }
        usePath = job.outputPath
        cfrPath = job.outputPath
        sourcePath = path
        vfrPolicy = 'converted'
        const reprobe = await window.focusnews.video.probe(job.outputPath)
        if (reprobe) useMeta = reprobe.meta
        setNotice(`已转换并导入：${job.outputPath}`)
      } catch (error) {
        setNotice(`CFR 转换异常：${String(error)}`)
        return { cancelled: true, mediaId: null, path, cfrPath: null, vfrPolicy: 'none', sourcePath: null }
      }
    } else {
      vfrPolicy = 'raw'
      setNotice(TEXT.modalVfr.rawWarning)
    }
  }

  const mediaId = createId('media')
  const item: Omit<MediaItem, 'id'> & { id: string } = {
    id: mediaId,
    path: usePath,
    ...(sourcePath ? { sourcePath } : {}),
    name: usePath.split(/[\\/]/).pop() ?? usePath,
    meta: useMeta,
    non169Ack: true,
    hdrAck: true,
    vfrPolicy,
    compactMode: 'auto',
    thumbnailUrl: '',
    importedAt: new Date().toISOString()
  }
  const store = useProjectStore.getState()
  store.addMedia(item)
  // 导入只入素材池，不自动落时间轴；用户可拖到轨道或点「放到播放头」显式放置。
  // 缩略图异步抽帧（不阻塞导入流程；失败保持空串，卡片显示占位符）
  void window.focusnews.media
    .generateThumb(mediaId, usePath, Math.min(1, Math.max(0, useMeta.durationSec / 2)))
    .then((url) => {
      if (url) useProjectStore.getState().setMediaThumb(mediaId, url)
    })
    .catch(() => undefined)
  return { cancelled: false, mediaId, path, cfrPath, vfrPolicy, sourcePath: sourcePath ?? null }
}

/** @deprecated v1 冒烟取证仍引用；等价于 importMediaWith。 */
export const importRefVideoWith = importMediaWith

/** 素材库批量导入：逐枚走门禁（每枚各自弹模态），单枚取消不影响其余。 */
export async function importMediaBatch(pickedList: PickedVideo[]): Promise<MediaImportOutcome[]> {
  const outcomes: MediaImportOutcome[] = []
  for (const picked of pickedList) {
    outcomes.push(await importMediaWith(picked))
  }
  return outcomes
}

export function useVideoImport() {
  /** 素材库「导入」按钮：多选 → 逐枚门禁 → 入池。 */
  const importMedia = useCallback(async (): Promise<MediaImportOutcome[]> => {
    const picked = await window.focusnews.video.pickManyAndProbe()
    if (picked.length === 0) return []
    return importMediaBatch(picked)
  }, [])

  /** @deprecated v1 单选入口，冒烟取证脚本保留。 */
  const importRefVideo = useCallback(async (): Promise<void> => {
    const picked = await window.focusnews.video.pickAndProbe()
    if (!picked) return
    await importMediaWith(picked)
  }, [])

  return { importMedia, importRefVideo }
}
