import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type ReactElement
} from 'react'
import { detectCompat } from '@shared/probe'
import { mediaKindOf } from '@shared/audioClips'
import { formatDuration } from '@shared/timecode'
import type { MediaItem } from '@shared/types'
import { useProjectStore } from '../state/projectStore'
import { mediaGateState, useUiStore } from '../state/uiStore'
import { useVideoImport } from '../hooks/useVideoImport'
import { Expander } from '../components/ui/Expander'
import { IconPencil, IconPlus, IconTrash } from '../components/ui/Icon'
import { nextMediaTileSize, readMediaTileSize, writeMediaTileSize } from './mediaTileSize'

/**
 * 素材库面板（v2 阶段 3）：多文件批量导入、缩略图卡片、枚级门禁角标。
 * 卡片可拖拽到时间轴媒体轨（dataTransfer 携带 mediaId），也可一键放到播放头。
 *
 * v11：参照剪映导入面板改成紧凑网格——固定列宽、缩略图为主、操作收进悬停浮层；
 * Ctrl + 滚轮改 `--media-tile-size`，列数与卡片大小随之变化（尺寸写本机 localStorage）。
 * 56px 起即可用：字体、角标与浮层按钮都按卡片尺寸用 clamp 收缩，不会溢出。
 */

const DRAG_MEDIA_MIME = 'application/x-focusnews-media'

/** 网格容器的内联样式：只暴露一个卡片尺寸变量，具体列数交给 CSS 的 auto-fill */
type MediaGridStyle = CSSProperties & Record<'--media-tile-size', string>

function baseName(target: string): string {
  return target.split(/[\\/]/).pop() || target
}

export interface MediaLibraryPanelProps {
  /** 一键放到播放头（时间轴提供回调；缺省时按钮隐藏） */
  onPlaceAtPlayhead?: (mediaId: string) => void
}

export function MediaLibraryPanel({ onPlaceAtPlayhead }: MediaLibraryPanelProps): ReactElement {
  const media = useProjectStore((state) => state.project.media)
  const missingMediaIds = useUiStore((state) => state.missingMediaIds)
  const uiMode = useUiStore((state) => state.uiMode)
  const setNotice = useUiStore((state) => state.setNotice)
  const { importMedia } = useVideoImport()
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [tileSize, setTileSize] = useState(() => readMediaTileSize())
  const panelRef = useRef<HTMLElement | null>(null)

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
      void window.focusnews.media.thumbUrl(item.id, item.thumbnailUrl).catch(() => undefined)
    }
    // 只在集合变化时重放，避免 thumbnailUrl 写回引起的循环
  }, [media.map((item) => `${item.id}:${item.thumbnailUrl}`).join('|')])

  const startRename = (item: MediaItem): void => {
    setRenamingId(item.id)
    setRenameValue(item.name)
  }

  const commitRename = (): void => {
    if (renamingId) useProjectStore.getState().renameMedia(renamingId, renameValue)
    setRenamingId(null)
  }

  const removeItem = (item: MediaItem): void => {
    // 引用它的媒体片段连带删除（素材移出池，时间轴上的段失去源）
    useProjectStore.getState().removeMedia(item.id)
    void window.focusnews.media.removeThumb(item.id).catch(() => undefined)
    setNotice(`已移出素材：${item.name}`)
  }

  const onDragStart = (event: ReactDragEvent<HTMLDivElement>, item: MediaItem): void => {
    event.dataTransfer.setData(DRAG_MEDIA_MIME, item.id)
    event.dataTransfer.setData('text/plain', item.id)
    event.dataTransfer.effectAllowed = 'copy'
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

      <div className="media-grid" style={{ '--media-tile-size': `${tileSize}px` } as MediaGridStyle}>
        {media.map((item) => {
          const flags = detectCompat(item.meta)
          const gate = mediaGateState(item)
          const missing = missingMediaIds.includes(item.id)
          const displayName = item.name || baseName(item.path)
          return (
            <div
              key={item.id}
              className={`media-tile${missing ? ' media-tile--missing' : ''}${gate.blocked ? ' media-tile--gated' : ''}`}
              draggable={!missing}
              onDragStart={(event) => onDragStart(event, item)}
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
                <div className="media-tile__overlay">
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
    </section>
  )
}

/** 拖拽媒体类型（Timeline 接收端共用，避免字符串两处手写偏差）。*/
export const MEDIA_DRAG_MIME = DRAG_MEDIA_MIME
