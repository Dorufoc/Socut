import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement
} from 'react'
import { detectCompat } from '@shared/probe'
import { mediaKindOf } from '@shared/audioClips'
import { formatDuration } from '@shared/timecode'
import { MEDIA_BIN_NAME_MAX_LENGTH, MEDIA_TAG_MAX_COUNT, MEDIA_TAG_MAX_LENGTH } from '@shared/constants'
import type { MediaBin, MediaItem } from '@shared/types'
import { useProjectStore } from '../state/projectStore'
import { useProxyStore } from '../state/proxyStore'
import { mediaGateState, useUiStore } from '../state/uiStore'
import { useVideoImport } from '../hooks/useVideoImport'
import { Expander } from '../components/ui/Expander'
import { IconPencil, IconPlus, IconProxy, IconTrash } from '../components/ui/Icon'
import { askConfirm } from '../dialog/ask'
import { nextMediaTileSize, readMediaTileSize, writeMediaTileSize } from './mediaTileSize'

/**
 * 素材库面板（v2 阶段 3）：多文件批量导入、缩略图卡片、枚级门禁角标。
 * 卡片可拖拽到时间轴媒体轨（dataTransfer 携带 mediaId），也可一键放到播放头。
 *
 * v11：参照剪映导入面板改成紧凑网格——固定列宽、缩略图为主、操作收进悬停浮层；
 * Ctrl + 滚轮改 `--media-tile-size`，列数与卡片大小随之变化（尺寸写本机 localStorage）。
 * 56px 起即可用：字体、角标与浮层按钮都按卡片尺寸用 clamp 收缩，不会溢出。
 *
 * v10（Task 9）：分组筛选（全部/未分组/各分组 + 计数）、搜索（名称+标签）、
 * 选中素材后的「归类与标签」编辑区。分组只是轻量组织，不影响时间轴引用。
 */

const DRAG_MEDIA_MIME = 'application/x-socut-media'

/** 网格容器的内联样式：只暴露一个卡片尺寸变量，具体列数交给 CSS 的 auto-fill */
type MediaGridStyle = CSSProperties & Record<'--media-tile-size', string>

/** 筛选值：'all' / 'unassigned' 是保留值，其余按分组 id 解释（createId('bin') 不会撞上它们）。 */
type BinFilter = 'all' | 'unassigned' | string

function baseName(target: string): string {
  return target.split(/[\\/]/).pop() || target
}

/** 标签输入解析：英文/中文逗号分隔，trim、丢空、精确去重、限长限量（与 schema 同一口径）。 */
function parseTagDraft(value: string): string[] {
  const tags: string[] = []
  for (const raw of value.split(/[,，]/)) {
    const tag = raw.trim().slice(0, MEDIA_TAG_MAX_LENGTH).trim()
    if (tag.length === 0 || tags.includes(tag)) continue
    if (tags.length >= MEDIA_TAG_MAX_COUNT) break
    tags.push(tag)
  }
  return tags
}

export interface MediaLibraryPanelProps {
  /** 一键放到播放头（时间轴提供回调；缺省时按钮隐藏） */
  onPlaceAtPlayhead?: (mediaId: string) => void
}

export function MediaLibraryPanel({ onPlaceAtPlayhead }: MediaLibraryPanelProps): ReactElement {
  const media = useProjectStore((state) => state.project.media)
  const mediaBins = useProjectStore((state) => state.project.mediaBins)
  const missingMediaIds = useUiStore((state) => state.missingMediaIds)
  const uiMode = useUiStore((state) => state.uiMode)
  const setNotice = useUiStore((state) => state.setNotice)
  const { importMedia } = useVideoImport()
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [tileSize, setTileSize] = useState(() => readMediaTileSize())
  const [search, setSearch] = useState('')
  const [activeBin, setActiveBin] = useState<BinFilter>('all')
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null)
  const [binDraft, setBinDraft] = useState('')
  const [renameBinDraft, setRenameBinDraft] = useState<string | null>(null)
  const [tagDraft, setTagDraft] = useState('')
  const panelRef = useRef<HTMLElement | null>(null)
  const proxyEntries = useProxyStore((state) => state.entries)
  const proxyErrors = useProxyStore((state) => state.errors)
  const proxyBusy = useProxyStore((state) => state.busy)
  const revalidateProxy = useProxyStore((state) => state.revalidate)

  const bins = mediaBins ?? []
  // 分组被删或工程换掉后，旧筛选值一律退回「全部」，避免筛选出一张空网格
  const activeBinId: BinFilter =
    activeBin !== 'all' && activeBin !== 'unassigned' && !bins.some((bin) => bin.id === activeBin)
      ? 'all'
      : activeBin
  const activeBinDef = activeBinId !== 'all' && activeBinId !== 'unassigned'
    ? bins.find((bin) => bin.id === activeBinId) ?? null
    : null
  const selectedItem = selectedMediaId ? media.find((item) => item.id === selectedMediaId) ?? null : null

  // 尺寸偏好写回本机（与工程无关）；拖动滚轮时会连续触发，localStorage 写入很便宜
  useEffect(() => {
    writeMediaTileSize(tileSize)
  }, [tileSize])

  /**
   * Ctrl + 滚轮缩放卡片：必须用原生监听才能 preventDefault（React 的 onWheel 在
   * 根节点上是 passive 的，拦不住也就会让侧栏跟着滚动甚至触发放大页面）。
   * 只改一个自定义属性，列数由 CSS auto-fill 重新计算。
   */
  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      setTileSize((current) => nextMediaTileSize(current, event.deltaY))
    }
    panel.addEventListener('wheel', onWheel, { passive: false })
    return () => panel.removeEventListener('wheel', onWheel)
  }, [])

  // 工程载入后：主进程重启让 thumbnailUrl 失效，逐枚重新登记（文件还在就能立刻恢复显示）
  useEffect(() => {
    for (const item of media) {
      if (!item.thumbnailUrl) continue
      void window.socut.media.thumbUrl(item.id, item.thumbnailUrl).catch(() => undefined)
    }
    // 只在集合变化时重放，避免 thumbnailUrl 写回引起的循环
  }, [media.map((item) => `${item.id}:${item.thumbnailUrl}`).join('|')])

  // v10：已记账的预览代理在素材/工程变化时重查一次新鲜度；源文件被替换 → 清账本回落原片
  useEffect(() => {
    for (const item of media) {
      const entry = proxyEntries[item.id]
      if (entry && entry.sourcePath === item.path) void revalidateProxy(item.id, item.path)
    }
  }, [media, proxyEntries, revalidateProxy])

  // 选中素材变化或它的标签被写回时，把输入框对齐到工程里的值
  useEffect(() => {
    setTagDraft(selectedItem?.tags?.join('，') ?? '')
  }, [selectedItem?.id, selectedItem?.tags?.join('|')])

  const startRename = (item: MediaItem): void => {
    setRenamingId(item.id)
    setRenameValue(item.name)
  }

  const commitRename = (): void => {
    if (renamingId) useProjectStore.getState().renameMedia(renamingId, renameValue)
    setRenamingId(null)
  }

  /** v10：按需生成 720p 预览代理（只服务预览；导出仍读原片）。 */
  const applyProxy = (item: MediaItem): void => {
    void useProxyStore.getState().apply({
      mediaId: item.id,
      path: item.path,
      hasAudio: typeof item.meta.audioCodec === 'string' && item.meta.audioCodec.length > 0,
      durationSec: item.meta.durationSec
    })
  }

  const removeItem = (item: MediaItem): void => {
    // 引用它的媒体片段连带删除（素材移出池，时间轴上的段失去源）
    useProjectStore.getState().removeMedia(item.id)
    void window.socut?.media?.removeThumb?.(item.id)?.catch(() => undefined)
    // v10：代理只属于这枚素材，移出池时连同磁盘缓存一起回收（内部同时取消在跑作业）
    useProxyStore.getState().clearForMedia(item.id, true)
    if (selectedMediaId === item.id) setSelectedMediaId(null)
    setNotice(`已移出素材：${item.name}`)
  }

  const onDragStart = (event: ReactDragEvent<HTMLDivElement>, item: MediaItem): void => {
    event.dataTransfer.setData(DRAG_MEDIA_MIME, item.id)
    event.dataTransfer.setData('text/plain', item.id)
    event.dataTransfer.effectAllowed = 'copy'
  }

  const selectItem = (item: MediaItem): void => {
    setSelectedMediaId(item.id)
    setTagDraft((item.tags ?? []).join('，'))
  }

  const createBin = (): void => {
    const id = useProjectStore.getState().addMediaBin(binDraft)
    if (!id) return
    setBinDraft('')
    // 新分组立刻成为筛选条件：用户建完就能看见它（空分组会显示「没有匹配的素材」）
    setActiveBin(id)
    setRenameBinDraft(null)
  }

  const commitBinRename = (): void => {
    if (!activeBinDef || renameBinDraft === null) return
    useProjectStore.getState().renameMediaBin(activeBinDef.id, renameBinDraft)
    setRenameBinDraft(null)
  }

  const removeBin = async (bin: MediaBin): Promise<void> => {
    const ok = await askConfirm(
      '删除分组',
      `删除「${bin.name}」后，组内素材会回到未分组，不会移出素材库。`,
      '删除'
    )
    if (!ok) return
    useProjectStore.getState().removeMediaBin(bin.id)
    setActiveBin('all')
    setRenameBinDraft(null)
  }

  const commitTags = (): void => {
    if (!selectedItem) return
    const tags = parseTagDraft(tagDraft)
    useProjectStore.getState().setMediaTags(selectedItem.id, tags)
    setTagDraft(tags.join('，'))
  }

  const clearTags = (): void => {
    if (!selectedItem) return
    useProjectStore.getState().setMediaTags(selectedItem.id, [])
    setTagDraft('')
  }

  const query = search.trim().toLowerCase()
  const filteredMedia = media.filter((item) => {
    if (activeBinId === 'unassigned') {
      if (item.binId) return false
    } else if (activeBinId !== 'all') {
      if (item.binId !== activeBinId) return false
    }
    if (query.length === 0) return true
    const haystack = [item.name, baseName(item.path), ...(item.tags ?? [])]
    return haystack.some((text) => text.toLowerCase().includes(query))
  })

  const binNameOf = (binId: string | undefined): string | null =>
    binId ? bins.find((bin) => bin.id === binId)?.name ?? null : null

  const stopTileClick = (event: ReactMouseEvent): void => {
    event.stopPropagation()
  }

  return (
    <section className="group" ref={panelRef}>
      <div className="group__head">
        <span className="group__title">素材库</span>
        <span className="media-grid__tools">
          <span className="group__hint">Ctrl+滚轮 缩放</span>
          <span className={`chip${media.length > 0 ? ' chip--ok' : ''}`}>{media.length} 枚</span>
        </span>
      </div>

      <button
        type="button"
        className="btn btn--primary btn--block"
        onClick={async () => {
          const outcomes = await importMedia()
          const ok = outcomes.filter((o) => !o.cancelled).length
          if (outcomes.length > 0 && ok === 0) setNotice('批量导入未完成（全部门禁未确认）')
        }}
      >
        导入视频（可多选）
      </button>

      <div className="media-filter">
        <input
          className="input"
          type="search"
          aria-label="搜索素材"
          placeholder="搜索素材名或标签"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />

        <div className="media-bins row row--wrap" role="group" aria-label="素材分组筛选">
          <button
            type="button"
            className={`chip media-bin-chip${activeBinId === 'all' ? ' btn--primary media-bin-chip--active' : ''}`}
            aria-pressed={activeBinId === 'all'}
            onClick={() => {
              setActiveBin('all')
              setRenameBinDraft(null)
            }}
          >
            全部 ({media.length})
          </button>
          <button
            type="button"
            className={`chip media-bin-chip${activeBinId === 'unassigned' ? ' btn--primary media-bin-chip--active' : ''}`}
            aria-pressed={activeBinId === 'unassigned'}
            onClick={() => {
              setActiveBin('unassigned')
              setRenameBinDraft(null)
            }}
          >
            未分组 ({media.filter((item) => !item.binId).length})
          </button>
          {bins.map((bin) => (
            <button
              key={bin.id}
              type="button"
              className={`chip media-bin-chip${activeBinId === bin.id ? ' btn--primary media-bin-chip--active' : ''}`}
              aria-pressed={activeBinId === bin.id}
              onClick={() => {
                setActiveBin(bin.id)
                setRenameBinDraft(null)
              }}
            >
              {bin.name} ({media.filter((item) => item.binId === bin.id).length})
            </button>
          ))}
        </div>

        <div className="media-bins__create row">
          <input
            className="input"
            aria-label="新分组名称"
            placeholder="新分组名称"
            maxLength={MEDIA_BIN_NAME_MAX_LENGTH}
            value={binDraft}
            onChange={(event) => setBinDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') createBin()
            }}
          />
          <button type="button" className="btn btn--sm" onClick={createBin}>
            新建分组
          </button>
        </div>

        {activeBinDef ? (
          <div className="media-bins__actions row row--wrap">
            {renameBinDraft === null ? (
              <button
                type="button"
                className="btn btn--sm btn--subtle"
                onClick={() => setRenameBinDraft(activeBinDef.name)}
              >
                重命名分组
              </button>
            ) : (
              <>
                <input
                  className="input"
                  autoFocus
                  aria-label="分组名称"
                  maxLength={MEDIA_BIN_NAME_MAX_LENGTH}
                  value={renameBinDraft}
                  onChange={(event) => setRenameBinDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitBinRename()
                    if (event.key === 'Escape') setRenameBinDraft(null)
                  }}
                />
                <button type="button" className="btn btn--sm btn--primary" onClick={commitBinRename}>
                  保存
                </button>
                <button type="button" className="btn btn--sm btn--subtle" onClick={() => setRenameBinDraft(null)}>
                  取消
                </button>
              </>
            )}
            <button type="button" className="btn btn--sm btn--danger" onClick={() => void removeBin(activeBinDef)}>
              删除分组
            </button>
          </div>
        ) : null}
      </div>

      {media.length === 0 ? (
        <div className="empty-state">
          <span className="empty-state__glyph" aria-hidden="true">
            ▶
          </span>
          <span>
            素材池为空
            <br />
            <span className="muted">导入后可拖到媒体轨</span>
          </span>
        </div>
      ) : null}

      {media.length > 0 && filteredMedia.length === 0 ? (
        <div className="empty-state">
          <span className="empty-state__glyph" aria-hidden="true">
            ⌕
          </span>
          <span>没有匹配的素材</span>
        </div>
      ) : null}

      <div className="media-grid" style={{ '--media-tile-size': `${tileSize}px` } as MediaGridStyle}>
        {filteredMedia.map((item) => {
          const flags = detectCompat(item.meta)
          const gate = mediaGateState(item)
          const missing = missingMediaIds.includes(item.id)
          const displayName = item.name || baseName(item.path)
          const binName = binNameOf(item.binId)
          const tags = item.tags ?? []
          const kind = mediaKindOf(item)
          const proxyEntry = proxyEntries[item.id]
          const proxyReady = Boolean(proxyEntry && proxyEntry.sourcePath === item.path)
          const proxyRunning = proxyBusy[item.id] === true
          const proxyError = proxyErrors[item.id]
          const isMxf = /\.mxf$/i.test(item.path)
          return (
            <div
              key={item.id}
              className={`media-tile${missing ? ' media-tile--missing' : ''}${gate.blocked ? ' media-tile--gated' : ''}${
                selectedMediaId === item.id ? ' media-tile--selected' : ''
              }`}
              draggable={!missing}
              onDragStart={(event) => onDragStart(event, item)}
              onClick={() => selectItem(item)}
              title={item.path}
            >
              <div className="media-tile__thumb">
                {item.thumbnailUrl ? (
                  <img src={item.thumbnailUrl} alt="" draggable={false} />
                ) : (
                  <span className="media-tile__glyph" aria-hidden="true">
                    {mediaKindOf(item) === 'audio' ? '♪' : mediaKindOf(item) === 'image' ? '▣' : '▶'}
                  </span>
                )}
                <span className="media-tile__duration mono">{formatDuration(item.meta.durationSec)}</span>
                {missing ? <span className="media-tile__badge media-tile__badge--danger">文件缺失</span> : null}
                {!missing && gate.blocked ? (
                  <span className="media-tile__badge media-tile__badge--warn">{gate.reason?.replace(`《${item.name}》`, '') ?? '待确认'}</span>
                ) : null}
                {/* 悬停/键盘聚焦才出现的操作浮层：卡片本身留给缩略图，保持剪映式网格的密度 */}
                <div className="media-tile__overlay" onClick={stopTileClick}>
                  {kind === 'video' ? (
                    <button
                      type="button"
                      className="media-tile__overlay-btn"
                      disabled={missing || proxyRunning}
                      onClick={() => applyProxy(item)}
                      title="生成预览代理（720p，仅预览用）"
                      aria-label={`生成预览代理：${displayName}`}
                    >
                      <IconProxy size={13} />
                    </button>
                  ) : null}
                  {onPlaceAtPlayhead ? (
                    <button
                      type="button"
                      className="media-tile__overlay-btn"
                      disabled={missing}
                      onClick={() => onPlaceAtPlayhead(item.id)}
                      title="整段放入播放头处"
                      aria-label={`放到播放头：${displayName}`}
                    >
                      <IconPlus size={13} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="media-tile__overlay-btn"
                    onClick={() => startRename(item)}
                    title="重命名"
                    aria-label={`重命名：${displayName}`}
                  >
                    <IconPencil size={13} />
                  </button>
                  <button
                    type="button"
                    className="media-tile__overlay-btn media-tile__overlay-btn--danger"
                    onClick={() => removeItem(item)}
                    title="移出素材库"
                    aria-label={`移出素材库：${displayName}`}
                  >
                    <IconTrash size={13} />
                  </button>
                </div>
              </div>
              <div className="media-tile__body">
                {renamingId === item.id ? (
                  <input
                    className="input input--compact"
                    autoFocus
                    value={renameValue}
                    onClick={stopTileClick}
                    onChange={(event) => setRenameValue(event.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitRename()
                      if (event.key === 'Escape') setRenamingId(null)
                    }}
                  />
                ) : (
                  <span className="media-tile__name" onDoubleClick={() => startRename(item)} title="双击重命名">
                    {displayName}
                  </span>
                )}
                <span className="media-tile__meta mono">
                  {item.meta.width}×{item.meta.height}
                </span>
                {proxyReady ? (
                  <span className="chip chip--ok media-tile__tag">代理就绪</span>
                ) : proxyRunning ? (
                  <span className="chip media-tile__tag">生成中</span>
                ) : proxyError ? (
                  <span className="chip chip--warn media-tile__tag" title={proxyError}>
                    代理失败
                  </span>
                ) : isMxf && kind === 'video' ? (
                  <button
                    type="button"
                    className="chip chip--warn media-tile__tag"
                    onClick={(event) => {
                      event.stopPropagation()
                      applyProxy(item)
                    }}
                    title="MXF 无法被浏览器直接预览；生成代理后可预览"
                  >
                    MXF 不可预览 · 生成代理
                  </button>
                ) : null}
                {tags.length > 0 || binName ? (
                  <div className="media-tile__tags">
                    {tags.slice(0, 3).map((tag) => (
                      <span key={tag} className="chip media-tile__tag">
                        {tag}
                      </span>
                    ))}
                    {tags.length > 3 ? <span className="chip media-tile__tag">+{tags.length - 3}</span> : null}
                    {binName ? (
                      <span className="chip media-tile__tag media-tile__tag--bin" title={`分组：${binName}`}>
                        {binName}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {uiMode === 'advanced' ? (
                <Expander title="素材参数" summary={`${item.meta.videoCodec}${flags.vfr ? ' · VFR' : ''}`}>
                  <div className="stack stack--tight">
                    <div className="row row--wrap">
                      <span className="chip mono">avg {item.meta.avgFrameRate.num}/{item.meta.avgFrameRate.den}</span>
                      <span className="chip mono">显示比 {item.meta.displayRatio.toFixed(3)}</span>
                      {flags.non169 ? (
                        <span className={`chip ${item.non169Ack ? 'chip--ok' : 'chip--warn'}`}>
                          非 16:9 {item.non169Ack ? '已确认' : '未确认'}
                        </span>
                      ) : null}
                      {flags.hdr ? (
                        <span className={`chip ${item.hdrAck ? 'chip--ok' : 'chip--warn'}`}>HDR {item.hdrAck ? '已确认' : '未确认'}</span>
                      ) : null}
                      {flags.vfr ? (
                        <span className={`chip ${item.vfrPolicy === 'none' ? 'chip--warn' : 'chip--ok'}`}>
                          VFR · {item.vfrPolicy === 'converted' ? '已转 CFR' : item.vfrPolicy === 'raw' ? '保留 VFR' : '未处理'}
                        </span>
                      ) : null}
                    </div>
                    {flags.non169 && !item.non169Ack ? (
                      <button type="button" className="btn btn--sm" onClick={() => useProjectStore.getState().ackMediaNon169(item.id, true)}>
                        确认非 16:9
                      </button>
                    ) : null}
                    {flags.hdr && !item.hdrAck ? (
                      <button type="button" className="btn btn--sm" onClick={() => useProjectStore.getState().ackMediaHdr(item.id, true)}>
                        确认 HDR → SDR
                      </button>
                    ) : null}
                    <label className="field">
                      <span className="field__label">布局模式</span>
                      <select
                        className="select select--compact"
                        value={item.compactMode}
                        onChange={(event) =>
                          useProjectStore.getState().setMediaCompactMode(item.id, event.target.value as MediaItem['compactMode'])
                        }
                      >
                        <option value="auto">自动</option>
                        <option value="standard">标准</option>
                        <option value="compact">紧凑</option>
                        <option value="ultrawide">超宽</option>
                      </select>
                    </label>
                  </div>
                </Expander>
              ) : null}
            </div>
          )
        })}
      </div>

      {selectedItem ? (
        <div className="media-assign">
          <div className="row row--between">
            <span className="group__title">归类与标签</span>
            <button type="button" className="btn btn--sm btn--subtle" onClick={() => setSelectedMediaId(null)}>
              取消选择
            </button>
          </div>
          <span className="media-assign__name muted">{selectedItem.name || baseName(selectedItem.path)}</span>
          <label className="field">
            <span className="field__label">所属分组</span>
            <select
              className="select"
              aria-label="所属分组"
              value={selectedItem.binId ?? ''}
              onChange={(event) =>
                useProjectStore.getState().assignMediaBin(selectedItem.id, event.target.value || null)
              }
            >
              <option value="">未分组</option>
              {bins.map((bin) => (
                <option key={bin.id} value={bin.id}>
                  {bin.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">标签（逗号分隔）</span>
            <input
              className="input"
              aria-label="标签（逗号分隔）"
              placeholder="如：新闻，重点"
              value={tagDraft}
              onChange={(event) => setTagDraft(event.target.value)}
              onBlur={commitTags}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitTags()
              }}
            />
          </label>
          {(selectedItem.tags?.length ?? 0) > 0 ? (
            <div className="row row--wrap">
              {selectedItem.tags!.map((tag) => (
                <span key={tag} className="chip chip--accent">
                  {tag}
                </span>
              ))}
              <button type="button" className="btn btn--sm btn--subtle" onClick={clearTags}>
                清空标签
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

/** 拖拽媒体类型（Timeline 接收端共用，避免字符串两处手写偏差）。*/
export const MEDIA_DRAG_MIME = DRAG_MEDIA_MIME
