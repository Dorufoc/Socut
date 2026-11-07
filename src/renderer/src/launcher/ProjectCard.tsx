import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { Fps } from '@shared/types'
import { clampProjectName, type RecentProjectCard } from '@shared/recentProjects'
import { askConfirm } from '../dialog/ask'
import { useUiStore } from '../state/uiStore'
import { formatDateTime, formatFull, formatRelative } from './time'

export interface ProjectCardProps {
  entry: RecentProjectCard
  onOpen: (id: string) => void
  onRename: (id: string, name: string) => Promise<boolean>
  onRemove: (id: string) => Promise<boolean> | void
  onReveal?: (entry: RecentProjectCard) => void
}

const RENAME_ERROR = '重命名失败，请稍后重试'
const MISSING_NOTICE = '工程文件已丢失或无法读取'

/** 分辨率角标里的帧率：整数截断（29.97 → 29fps），与卡片密度保持一致。 */
function formatFpsChip(fps: Fps): string {
  const value = fps.den > 0 ? fps.num / fps.den : fps.num
  return Number.isFinite(value) ? `${Math.trunc(value)}fps` : '—'
}

function countsLabel(entry: RecentProjectCard): string {
  const parts: string[] = []
  if (entry.clipCount > 0) parts.push(`${entry.clipCount} 段字幕`)
  if (entry.mediaCount > 0) parts.push(`${entry.mediaCount} 个素材`)
  if (entry.audioClipCount > 0) parts.push(`${entry.audioClipCount} 段音频`)
  return parts.length > 0 ? parts.join(' · ') : '空工程'
}

/**
 * 最近工程卡片：封面 + 名称 + 时间/规格 + 悬停操作。
 * 整卡是一个可键盘触发的按钮，内部操作按钮各自 stopPropagation，避免误打开工程。
 */
export function ProjectCard({ entry, onOpen, onRename, onRemove, onReveal }: ProjectCardProps): ReactElement {
  const setNotice = useUiStore((state) => state.setNotice)
  const [coverFailed, setCoverFailed] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(entry.name)
  const [pending, setPending] = useState(false)
  const [removing, setRemoving] = useState(false)
  const pendingRef = useRef(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setCoverFailed(false)
  }, [entry.coverUrl])

  useEffect(
    () => () => {
      if (openTimerRef.current) clearTimeout(openTimerRef.current)
    },
    []
  )

  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])

  const cancelPendingOpen = (): void => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
  }

  const monogram = entry.name.trim().charAt(0) || '新'
  const showCover = Boolean(entry.coverUrl) && !coverFailed

  const canReveal =
    entry.source === 'file' &&
    Boolean(entry.filePath) &&
    typeof window !== 'undefined' &&
    typeof window.focusnews?.app?.revealPath === 'function'

  const openNow = (): void => {
    if (entry.missing) {
      setNotice(MISSING_NOTICE)
      return
    }
    onOpen(entry.id)
  }

  /**
   * 整卡单击延迟打开：双击名称要进入重命名，若第一次 click 就切视图，
   * 第二次 click / dblclick 根本没机会发生。延迟窗口内收到 dblclick 会取消打开。
   */
  const scheduleOpen = (): void => {
    if (entry.missing) {
      openNow()
      return
    }
    cancelPendingOpen()
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null
      onOpen(entry.id)
    }, 180)
  }

  const beginRename = (): void => {
    cancelPendingOpen()
    setDraft(entry.name)
    setEditing(true)
  }

  const commitRename = async (): Promise<void> => {
    if (pendingRef.current) return
    const next = clampProjectName(draft)
    if (next.length === 0 || next === entry.name) {
      setEditing(false)
      return
    }
    pendingRef.current = true
    setPending(true)
    try {
      const ok = await onRename(entry.id, next)
      if (!ok) setNotice(RENAME_ERROR)
    } finally {
      pendingRef.current = false
      setPending(false)
      setEditing(false)
    }
  }

  const handleRemove = async (): Promise<void> => {
    if (removing) return
    const body =
      entry.source === 'autosave'
        ? '移除后未另存的草稿会被删除；已经另存到磁盘的工程文件不受影响。'
        : '只从最近列表移除，不会删除工程文件。'
    const confirmed = await askConfirm('移除最近项目', body, '移除')
    if (!confirmed) return
    setRemoving(true)
    try {
      await onRemove(entry.id)
    } finally {
      setRemoving(false)
    }
  }

  const handleReveal = (): void => {
    if (!canReveal || !entry.filePath) return
    if (onReveal) {
      onReveal(entry)
      return
    }
    void window.focusnews.app.revealPath(entry.filePath).catch(() => {
      setNotice('无法在文件夹中显示该工程')
    })
  }

  const stop = (event: { stopPropagation: () => void }): void => {
    event.stopPropagation()
  }

  return (
    <div
      className={`project-card${entry.missing ? ' project-card--missing' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`打开工程 ${entry.name}`}
      onClick={scheduleOpen}
      onKeyDown={(event) => {
        // 内层按钮/输入框自己的键盘事件不冒泡成「打开工程」
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          openNow()
        }
      }}
    >
      <div className="project-card__cover">
        {showCover ? (
          <img
            className="project-card__cover-img"
            src={entry.coverUrl ?? undefined}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setCoverFailed(true)}
          />
        ) : (
          <div className="project-card__placeholder" aria-hidden="true">
            <span className="project-card__placeholder-grid" />
            <span className="project-card__monogram">{monogram}</span>
          </div>
        )}

        <div className="project-card__badges">
          {entry.source === 'autosave' ? <span className="project-card__badge project-card__badge--draft">草稿</span> : null}
          {entry.missing ? (
            <span className="project-card__badge project-card__badge--missing">文件缺失</span>
          ) : null}
        </div>

        <span className="project-card__res chip mono">
          {entry.resolution.width}×{entry.resolution.height} · {formatFpsChip(entry.fps)}
        </span>
      </div>

      <div className="project-card__body">
        <div className="project-card__name-row">
          {editing ? (
            pending ? (
              <span className="project-card__name project-card__name--pending">保存中…</span>
            ) : (
              <input
                ref={inputRef}
                className="project-card__rename"
                value={draft}
                maxLength={60}
                aria-label={`重命名工程 ${entry.name}`}
                onClick={stop}
                onDoubleClick={stop}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={() => {
                  if (!pendingRef.current) setEditing(false)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    event.stopPropagation()
                    void commitRename()
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    event.stopPropagation()
                    if (!pendingRef.current) setEditing(false)
                  }
                }}
              />
            )
          ) : (
            <h3
              className="project-card__name"
              title={entry.name}
              onDoubleClick={(event) => {
                event.stopPropagation()
                beginRename()
              }}
            >
              {entry.name}
            </h3>
          )}
        </div>

        <p className="project-card__meta">
          <span title={formatFull(entry.createdAt)}>创建 {formatDateTime(entry.createdAt)}</span>
          <span title={formatFull(entry.modifiedAt)}>修改 {formatRelative(entry.modifiedAt)}</span>
        </p>

        <p className="project-card__counts">{countsLabel(entry)}</p>

        <div className="project-card__actions">
          {!entry.missing ? (
            <button
              type="button"
              className="btn btn--sm btn--subtle project-card__action"
              onClick={(event) => {
                event.stopPropagation()
                openNow()
              }}
            >
              打开
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn--sm btn--subtle project-card__action"
            onClick={(event) => {
              event.stopPropagation()
              beginRename()
            }}
          >
            重命名
          </button>
          {canReveal ? (
            <button
              type="button"
              className="btn btn--sm btn--subtle project-card__action"
              onClick={(event) => {
                event.stopPropagation()
                handleReveal()
              }}
            >
              在文件夹中显示
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn--sm btn--subtle project-card__action project-card__action--danger"
            disabled={removing}
            onClick={(event) => {
              event.stopPropagation()
              void handleRemove()
            }}
          >
            {removing ? '移除中…' : '移除'}
          </button>
        </div>
      </div>
    </div>
  )
}
