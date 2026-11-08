import { useEffect } from 'react'
import { TEXT } from '@shared/i18n'
import { askConfirm } from '../dialog/ask'
import { importMediaWith } from './useVideoImport'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'

/**
 * 素材池完整性看护（v2 阶段 8，承接规格 §8 的单参考视频检查）。
 *
 * 遍历 MediaItem 池逐枚查询文件是否还在：缺失集合写入 uiStore.missingMediaIds，
 * 驱动素材库卡片角标与叠加导出禁用。逐枚询问「重新定位」：
 * 确认 → 走生产导入路径换源（relocateMedia 保持时间轴片段引用，同样过门禁）；
 * 拒绝 → 提示可从素材库重新导入。旧版 refVideo 路径保持兼容（冒烟取证仍会写它）。
 */
export function useMediaIntegrity(): void {
  const mediaKey = useProjectStore((state) =>
    [
      ...state.project.media.map((item) => `${item.id}:${item.path}`),
      state.project.refVideo ? `legacy:${state.project.refVideo.path}` : ''
    ].join('|')
  )

  useEffect(() => {
    if (mediaKey.length === 0) {
      useUiStore.getState().setMissingMediaIds([])
      return
    }
    let cancelled = false
    void (async () => {
      const store = useProjectStore.getState()
      const legacyPath = store.project.refVideo?.path ?? null
      const items = store.project.media.map((item) => ({ id: item.id, path: item.path, name: item.name }))
      const checks = await Promise.all(
        items.map(async (item) => ({ ...item, exists: await window.socut.video.exists(item.path) }))
      )
      const legacyMissing = legacyPath ? !(await window.socut.video.exists(legacyPath)) : false
      if (cancelled) return
      const missing = checks.filter((item) => !item.exists)
      // v1 兼容：旧取证脚本只写 refVideo 时，缺失态落在 refVideoMissing 上
      useUiStore.getState().setMissingMediaIds(missing.map((item) => item.id))
      if (items.length === 0 && legacyPath) useUiStore.getState().setRefVideoMissing(legacyMissing)

      for (const item of missing) {
        if (cancelled) return
        const relocate = await askConfirm(
          TEXT.refVideoMissing.title,
          `${TEXT.refVideoMissing.body}\n${item.name}\n${item.path}`,
          TEXT.refVideoMissing.confirm
        )
        if (cancelled) return
        if (!relocate) {
          useUiStore.getState().setNotice(`${item.name}：${TEXT.refVideoMissing.notice}`)
          continue
        }
        const picked = await window.socut.video.pickAndProbe()
        if (cancelled || !picked) {
          useUiStore.getState().setNotice(TEXT.refVideoMissing.notice)
          continue
        }
        const outcome = await importMediaWith(picked)
        if (cancelled || outcome.cancelled || !outcome.mediaId) continue
        // 换源不换轨：新条目替换旧 id 的路径/元数据，临时导入项随即从池中删掉
        const latest = useProjectStore.getState()
        const fresh = latest.project.media.find((m) => m.id === outcome.mediaId)
        if (fresh) {
          latest.relocateMedia(item.id, { path: fresh.path, meta: fresh.meta, sourcePath: fresh.sourcePath, vfrPolicy: fresh.vfrPolicy })
          latest.removeMedia(outcome.mediaId)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [mediaKey])
}

/** @deprecated 旧名保留导出以免冒烟/历史引用断链；实现即 useMediaIntegrity。 */
export const useRefVideoIntegrity = useMediaIntegrity
