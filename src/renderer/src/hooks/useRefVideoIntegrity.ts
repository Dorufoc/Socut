import { useEffect } from 'react'
import { TEXT } from '@shared/i18n'
import { askConfirm } from '../dialog/ask'
import { importRefVideoWith } from './useVideoImport'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'

/**
 * 参考视频完整性看护（规格 §8：「文件缺失（参考视频被移动）时提示重新定位」）。
 *
 * 没有它会发生什么：工程记录的路径失效后，UI 仍显示着旧的分辨率/帧率，
 * 用户点「导出 MP4」才在 FFmpeg 那里撞一个 `Error opening input file`——
 * 既晚又难懂。这里在载入/换路径时就查一次，并把「重新定位」直接接到生产导入路径上
 *（复用 importRefVideoWith，所以新文件同样会过非 16:9 / HDR / VFR 门禁）。
 */
export function useRefVideoIntegrity(): void {
  const refPath = useProjectStore((state) => state.project.refVideo?.path ?? '')
  const setMissing = useUiStore((state) => state.setRefVideoMissing)
  const setNotice = useUiStore((state) => state.setNotice)

  useEffect(() => {
    if (refPath.length === 0) {
      setMissing(false)
      return
    }
    let cancelled = false
    void (async () => {
      const exists = await window.focusnews.video.exists(refPath)
      if (cancelled) return
      setMissing(!exists)
      if (exists) return
      const relocate = await askConfirm(
        TEXT.refVideoMissing.title,
        `${TEXT.refVideoMissing.body}\n${refPath}`,
        TEXT.refVideoMissing.confirm
      )
      if (cancelled) return
      if (!relocate) {
        setNotice(TEXT.refVideoMissing.notice)
        return
      }
      const picked = await window.focusnews.video.pickAndProbe()
      if (cancelled || !picked) {
        setNotice(TEXT.refVideoMissing.notice)
        return
      }
      // 走生产导入路径：新文件同样要过门禁，成功后 refPath 变化会重新触发本检查
      await importRefVideoWith(picked)
    })()
    return () => {
      cancelled = true
    }
  }, [refPath, setMissing, setNotice])
}
