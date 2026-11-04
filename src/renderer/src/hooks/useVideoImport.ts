import { useCallback } from 'react'
import { TEXT } from '@shared/i18n'
import type { RefVideo, VideoMeta } from '@shared/types'
import { askHdr, askNon169, askVfr } from '../dialog/ask'
import { waitForResult } from '../state/jobEvents'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'

/**
 * 参考视频导入（规格 §6）。
 * 模态优先级：非 16:9 → HDR → VFR；任何一步选择「取消」都终止导入，不写入工程。
 */

export interface PickedVideo {
  path: string
  probe: NonNullable<Awaited<ReturnType<typeof window.focusnews.video.probe>>>
}

/**
 * 门禁主体：拿到已探测的视频就依次弹模态。
 * 拆成独立函数是为了让应用内门禁取证能走**同一段代码**（而不是写一份平行的模拟逻辑），
 * 否则测的就不是用户真正点到的那条路径。
 */
export async function importRefVideoWith(picked: PickedVideo): Promise<void> {
  const setNotice = useUiStore.getState().setNotice
  const { path, probe } = picked
  const meta: VideoMeta = probe.meta

    if (probe.flags.non169) {
      const label = `${TEXT.modalNon169.body}（显示宽高比 ${meta.displayRatio.toFixed(3)} : 1，${meta.width}×${meta.height}）`
      const ok = await askNon169(label)
      if (!ok) {
        setNotice('导入已取消（非 16:9 未确认）')
        return
      }
    }

    if (probe.flags.hdr) {
      const label = `${TEXT.modalHdr.body}（color_transfer=${meta.colorTransfer ?? '—'}，primaries=${meta.colorPrimaries ?? '—'}）`
      const ok = await askHdr(label)
      if (!ok) {
        setNotice('导入已取消（HDR 降级未确认）')
        return
      }
    }

    let usePath = path
    let useMeta = meta
    let sourcePath: string | undefined
    let vfrPolicy: RefVideo['vfrPolicy'] = 'none'

    if (probe.flags.vfr) {
      const evidence = probe.vfrEvidence
      const label =
        `${TEXT.modalVfr.body}\n` +
        `r_frame_rate=${meta.rFrameRate.num}/${meta.rFrameRate.den}，avg_frame_rate=${meta.avgFrameRate.num}/${meta.avgFrameRate.den}` +
        (evidence ? `\n抽样 ${evidence.sampledPackets} 个包，最大间隔 ${evidence.maxGapSec.toFixed(4)}s（期望 ${evidence.expectedGapSec.toFixed(4)}s）` : '')
      const answer = await askVfr(label)
      if (answer === 'cancel') {
        setNotice('导入已取消（VFR 处理方式未选择）')
        return
      }
      if (answer === 'convert') {
        setNotice(`正在转换为 CFR（${probe.suggestedFps.num}/${probe.suggestedFps.den}）…`)
        try {
          const job = await window.focusnews.video.cfrConvert(path, probe.suggestedFps, meta)
          const result = await waitForResult(job.jobId)
          if (!result.ok) {
            setNotice(`CFR 转换失败：${result.error?.message ?? '未知原因'}`)
            return
          }
          usePath = job.outputPath
          sourcePath = path
          vfrPolicy = 'converted'
          const reprobe = await window.focusnews.video.probe(job.outputPath)
          if (reprobe) useMeta = reprobe.meta
          setNotice(`已转换并导入：${job.outputPath}`)
        } catch (error) {
          setNotice(`CFR 转换异常：${String(error)}`)
          return
        }
      } else {
        vfrPolicy = 'raw'
        setNotice(TEXT.modalVfr.rawWarning)
      }
    }

  const refVideo: RefVideo = {
    path: usePath,
    ...(sourcePath ? { sourcePath } : {}),
    meta: useMeta,
    non169Ack: true,
    hdrAck: true,
    vfrPolicy,
    compactMode: 'auto',
    importedAt: new Date().toISOString()
  }
  useProjectStore.getState().setRefVideo(refVideo)
}

export function useVideoImport() {
  const importRefVideo = useCallback(async (): Promise<void> => {
    const picked = await window.focusnews.video.pickAndProbe()
    if (!picked) return
    await importRefVideoWith(picked)
  }, [])

  return { importRefVideo }
}
