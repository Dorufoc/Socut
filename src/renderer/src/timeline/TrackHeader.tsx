import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import type { Track, TrackKind } from '@shared/types'

/**
 * 时间轴轨道头（v3 多轨）。
 *
 * 每条轨道左侧的 56px 槽位：轨道名 + 一排小按钮。
 * - 名字双击进入 inline 重命名（Enter 提交 / Esc 取消 / blur 提交）；
 * - 按钮按轨道类型裁剪：媒体 = 静音/隐藏/锁定/上移/下移/删除，音频 = 静音/锁定/上移/下移/删除，
 *   字幕 = 隐藏/锁定（固定轨，不参与增删与排序）；
 * - 点击头部（非按钮、非输入）选中该轨，行高亮由上层按 `selectedTrackId` 决定；
 * - 头部自己吞掉 pointerdown，避免点按钮时被轨道空白处的刮擦逻辑抢走。
 */

export interface TrackHeaderProps {
  track: Track
  kind: TrackKind
  selected: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  canDelete: boolean
  onSelect: () => void
  onRename: (name: string) => void
  onToggleMuted?: () => void
  onToggleHidden?: () => void
  onToggleLocked: () => void
  onMoveUp?: () => void
  onMoveDown?: () => void
  onDelete?: () => void
}

export function TrackHeader({
  track,
  kind,
  selected,
  canMoveUp,
  canMoveDown,
  canDelete,
  onSelect,
  onRename,
  onToggleMuted,
  onToggleHidden,
  onToggleLocked,
  onMoveUp,
  onMoveDown,
  onDelete
}: TrackHeaderProps): ReactElement {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(track.name)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // 轨道名被外部改掉（撤销/打开工程）时同步草稿，避免下次编辑从旧名字开始
  useEffect(() => {
    setDraft(track.name)
  }, [track.name])

  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])

  const beginEdit = (): void => {
    setDraft(track.name)
    setEditing(true)
  }

  const commit = (): void => {
    const name = draft.trim()
    if (name.length > 0) onRename(name)
    setEditing(false)
  }

  const cancel = (): void => {
    setDraft(track.name)
    setEditing(false)
  }

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      cancel()
    }
  }

  const showMute = kind === 'media' || kind === 'audio'
  const showHide = kind === 'media' || kind === 'subtitle'
  const showReorder = kind !== 'subtitle'

  return (
    <div
      className={`timeline__track-header${selected ? ' timeline__track-header--selected' : ''}${
        track.locked ? ' timeline__track-header--locked' : ''
      }${track.hidden ? ' timeline__track-header--hidden' : ''}${track.muted ? ' timeline__track-header--muted' : ''}`}
      data-track-id={track.id}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        onSelect()
      }}
      title={track.name}
    >
      {editing ? (
        <input
          ref={inputRef}
          className="timeline__track-name-input"
          value={draft}
          maxLength={40}
          aria-label="轨道名称"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onInputKeyDown}
          onBlur={commit}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        />
      ) : (
        <span
          className="timeline__track-name"
          data-action="name"
          onDoubleClick={(event) => {
            event.stopPropagation()
            beginEdit()
          }}
        >
          {track.name}
        </span>
      )}

      <div className="timeline__track-controls" onClick={(event) => event.stopPropagation()}>
        {showMute ? (
          <button
            type="button"
            data-action="mute"
            aria-pressed={track.muted}
            aria-label={track.muted ? '取消静音' : '静音'}
            title={track.muted ? '取消静音' : '静音'}
            onClick={() => onToggleMuted?.()}
          >
            静
          </button>
        ) : null}
        {showHide ? (
          <button
            type="button"
            data-action="hide"
            aria-pressed={track.hidden}
            aria-label={track.hidden ? '显示轨道' : '隐藏轨道'}
            title={track.hidden ? '显示轨道' : '隐藏轨道'}
            onClick={() => onToggleHidden?.()}
          >
            隐
          </button>
        ) : null}
        <button
          type="button"
          data-action="lock"
          aria-pressed={track.locked}
          aria-label={track.locked ? '解锁轨道' : '锁定轨道'}
          title={track.locked ? '解锁轨道' : '锁定轨道'}
          onClick={() => onToggleLocked()}
        >
          锁
        </button>
        {showReorder ? (
          <>
            <button
              type="button"
              data-action="move-up"
              aria-label="轨道上移"
              title="轨道上移"
              disabled={!canMoveUp}
              onClick={() => onMoveUp?.()}
            >
              ↑
            </button>
            <button
              type="button"
              data-action="move-down"
              aria-label="轨道下移"
              title="轨道下移"
              disabled={!canMoveDown}
              onClick={() => onMoveDown?.()}
            >
              ↓
            </button>
          </>
        ) : null}
        {showReorder ? (
          <button
            type="button"
            data-action="delete"
            aria-label="删除轨道"
            title={canDelete ? '删除轨道（连同轨道上的片段）' : '最后一条轨道不能删除'}
            disabled={!canDelete}
            onClick={() => onDelete?.()}
          >
            删
          </button>
        ) : null}
      </div>
    </div>
  )
}
