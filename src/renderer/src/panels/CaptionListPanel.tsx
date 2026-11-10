import { useEffect, useRef, useState, type ReactElement } from 'react'
import { DEFAULT_CLIP_DURATION_SEC, MIN_CLIP_DURATION_SEC } from '@shared/constants'
import { parseCaptionRows } from '@shared/captionBatch'
import { DEFAULT_PRESET_ID, PRESETS, getPreset } from '@shared/presets'
import { parseSubtitleFile } from '@shared/subtitleFormats'
import { TEXT } from '@shared/i18n'
import { secondsToTimecode } from '@shared/timecode'
import type { PresetId, SubtitleClip } from '@shared/types'
import { IconPlus, IconTrash } from '../components/ui/Icon'
import { CaptionAutoSection } from './CaptionAutoSection'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'

/**
 * 左侧「字幕」Tab（v10 P2）：按**时间顺序**列出全部字幕条，同时是新建/删除字幕条的唯一入口。
 *
 * 三种点击各自的契约：
 * 1. **点卡片** = 选中（右侧检查器随即指向这一条）+ 播放头跳到该条**区间中点**
 *    → 预览与时间轴同步过去。用中点而不是入点：中点天然落在「入场完成 → 出场开始」
 *    窗口里，预览一定看得见完整样式，入点则正好压在入场动画的第一帧上。
 * 2. **点加号** = 在时间轴末尾新建一条并选中它，同样跳到中点（不跳的话右侧在编辑、
 *    预览里却看不到这一条，等于「改了但没反应」）。空态是整块大虚线框，有字幕时
 *    退成列表末尾一条矮虚线条——两个入口走同一段逻辑。
 * 3. **点删除** = 直接删这一条，不弹二次确认：删错了靠项目级撤销（Ctrl+Z）找回。
 *
 * 跳转前一律先暂停：播放中跳过去会被时钟立刻带走，看不出跳转效果
 * （与时间轴刮擦接管播放头同一口径）。
 *
 * 排序在这里显式做一次：「按时间顺序」是本面板的契约，不能依赖片段的写入顺序。
 *
 * M11-I：批量编辑。点右上角「批量」进入多选态——卡片点击语义从「选中并跳中点」变成
 * 「勾选/取消勾选」，工具栏对选中集合做 预设 / 统一时长 / 两个开关 / 删除。
 * 多选状态**只放组件本地**：切换单条选中、切换序列、退出批量都会清空（旧 id 可能已不属于
 * 当前序列）；每个批量动作在 store 里只推一次 revision，所以撤销一步就整批回滚。
 */

/** 该条在轨道上的中点（秒）：预览与时间轴都落到这里 */
function midSec(clip: SubtitleClip): number {
  return (clip.startTime + clip.endTime) / 2
}

export function CaptionListPanel(): ReactElement {
  const clips = useProjectStore((state) => state.project.clips)
  const fps = useProjectStore((state) => state.project.fps)
  const selectedId = useProjectStore((state) => state.selectedClipId)
  const sequenceId = useProjectStore((state) => state.project.activeSequenceId ?? null)
  const selectClip = useProjectStore((state) => state.selectClip)
  const addClip = useProjectStore((state) => state.addClip)
  const removeClip = useProjectStore((state) => state.removeClip)
  // M11-I：批量写入口（每个动作只推一次 revision）
  const applyPresetToClips = useProjectStore((state) => state.applyPresetToClips)
  const setClipsDuration = useProjectStore((state) => state.setClipsDuration)
  const removeClips = useProjectStore((state) => state.removeClips)
  const setClipsCompact = useProjectStore((state) => state.setClipsCompact)
  const setClipsGradientEnabled = useProjectStore((state) => state.setClipsGradientEnabled)
  // M11：字幕文件 / 名单导入
  const addCaptionsFromCues = useProjectStore((state) => state.addCaptionsFromCues)
  const addCaptionBatch = useProjectStore((state) => state.addCaptionBatch)
  const setNotice = useUiStore((state) => state.setNotice)
  const subtitleInputRef = useRef<HTMLInputElement | null>(null)
  const listInputRef = useRef<HTMLInputElement | null>(null)
  const [importing, setImporting] = useState(false)
  // M11-I：批量多选（组件本地；不写 uiStore、不落工程）
  const [batchMode, setBatchMode] = useState(false)
  const [batchIds, setBatchIds] = useState<string[]>([])
  const [batchPresetId, setBatchPresetId] = useState<PresetId>(DEFAULT_PRESET_ID)
  const [batchDuration, setBatchDuration] = useState(String(DEFAULT_CLIP_DURATION_SEC))
  const displayTime = useUiStore((state) => state.displayTimeSec)
  const playing = useUiStore((state) => state.playing)
  const setPlaying = useUiStore((state) => state.setPlaying)
  const seekHandler = useUiStore((state) => state.seekHandler)

  // 切换单条选中 / 切换序列 = 批量勾选失效：旧 id 可能已经不属于当前序列
  useEffect(() => {
    setBatchIds([])
  }, [selectedId, sequenceId])

  const ordered = [...clips].sort((a, b) => a.startTime - b.startTime)
  const batchIdSet = new Set(batchIds)
  const batchTargets = ordered.filter((clip) => batchIdSet.has(clip.id))
  // 实际生效的勾选集合：以当前列表为准（条目被别处删掉时，本地旧 id 不会继续占着「已选 N 条」）
  const batchSelection = batchTargets.map((clip) => clip.id)
  // 开关的显示态：全部选中条目已经是「开」才显示勾选（混合态显示未勾，再点一次即全部开启）
  const allCompact =
    batchTargets.length > 0 && batchTargets.every((clip) => clip.styleOverrides.compact === true)
  const allGradient =
    batchTargets.length > 0 &&
    batchTargets.every(
      (clip) =>
        clip.styleOverrides.titleGradient?.enabled === true &&
        clip.styleOverrides.subtitleGradient?.enabled === true
    )
  // 统一时长的合法值：与单条写入口同一口径（吸附后不低于最短时长），非法时按钮禁用
  const batchDurationSec = Number(batchDuration)
  const batchDurationValid =
    batchDuration.trim().length > 0 &&
    Number.isFinite(batchDurationSec) &&
    batchDurationSec >= MIN_CLIP_DURATION_SEC

  const takeOverClock = (): void => {
    if (playing) setPlaying(false)
  }

  const jumpTo = (clip: SubtitleClip): void => {
    selectClip(clip.id)
    takeOverClock()
    seekHandler?.(midSec(clip))
  }

  const create = (): void => {
    // addClip 自己会把新片段设为选中态，这里只负责把画面带过去
    const id = addClip()
    takeOverClock()
    const created = useProjectStore.getState().project.clips.find((clip) => clip.id === id)
    if (created) seekHandler?.(midSec(created))
  }

  const toggleBatchMode = (): void => {
    setBatchIds([])
    setBatchMode((on) => !on)
  }

  const toggleBatchSelect = (id: string): void => {
    setBatchIds((ids) => (ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]))
  }

  const runBatchPreset = (): void => {
    const n = applyPresetToClips(batchSelection, batchPresetId)
    setNotice(n > 0 ? TEXT.captions.batchPresetDone(n) : TEXT.captions.batchNothing)
  }

  const runBatchDuration = (): void => {
    // 按钮在非法值上已禁用，这里再挡一次：批量入口绝不做「看着成功其实没写」
    if (!batchDurationValid) return
    const n = setClipsDuration(batchSelection, batchDurationSec)
    setNotice(n > 0 ? TEXT.captions.batchDurationDone(n) : TEXT.captions.batchNothing)
  }

  const runBatchCompact = (): void => {
    const n = setClipsCompact(batchSelection, !allCompact)
    setNotice(n > 0 ? TEXT.captions.batchCompactDone(n) : TEXT.captions.batchNothing)
  }

  const runBatchGradient = (): void => {
    const n = setClipsGradientEnabled(batchSelection, !allGradient)
    setNotice(n > 0 ? TEXT.captions.batchGradientDone(n) : TEXT.captions.batchNothing)
  }

  const runBatchDelete = (): void => {
    const n = removeClips(batchSelection)
    // 删完清空勾选：再点一次不会误删别的条（要删得重新选）
    setBatchIds([])
    setNotice(n > 0 ? TEXT.captions.batchDeleteDone(n) : TEXT.captions.batchNothing)
  }

  const addHero = (
    <button type="button" className="caption-add caption-add--hero" onClick={create}>
      <span className="caption-add__glyph" aria-hidden="true">
        <IconPlus size={26} strokeWidth={1.6} />
      </span>
      <span className="caption-add__label">{TEXT.captions.add}</span>
      <span className="caption-add__hint">
        {TEXT.captions.empty}
        <br />
        {TEXT.captions.addHint}
      </span>
    </button>
  )

  const addRow = (
    <button type="button" className="caption-add" onClick={create}>
      <IconPlus size={13} />
      <span>{TEXT.captions.add}</span>
    </button>
  )

  const importSubtitle = async (file: File): Promise<void> => {
    setImporting(true)
    try {
      const raw = await file.text()
      const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
      const format = ext === 'ass' || ext === 'ssa' ? 'ass' : 'srt'
      const report = parseSubtitleFile(raw, format)
      const added = addCaptionsFromCues(report.cues)
      setNotice(added > 0 ? TEXT.captions.imported(added) : TEXT.captions.importEmpty)
    } catch (error) {
      setNotice(`${TEXT.captions.importFailed}：${String(error)}`)
    } finally {
      setImporting(false)
    }
  }

  const importList = async (file: File): Promise<void> => {
    setImporting(true)
    try {
      const raw = await file.text()
      const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
      const format = ext === 'json' ? 'json' : ext === 'txt' ? 'lines' : 'csv'
      const report = parseCaptionRows(raw, format)
      const added = addCaptionBatch(report.rows, {})
      setNotice(added > 0 ? TEXT.captions.importedBatch(added) : TEXT.captions.importEmpty)
    } catch (error) {
      setNotice(`${TEXT.captions.importFailed}：${String(error)}`)
    } finally {
      setImporting(false)
    }
  }

  return (
    <section className="group">
      <div className="group__head">
        <span className="group__title">{TEXT.captions.title}</span>
        <span className={`chip${ordered.length > 0 ? ' chip--ok' : ''}`}>{TEXT.captions.count(ordered.length)}</span>
        {ordered.length > 0 ? (
          <button
            type="button"
            className="btn btn--sm btn--subtle"
            aria-pressed={batchMode}
            title={TEXT.captions.batchModeHint}
            onClick={toggleBatchMode}
          >
            {batchMode ? TEXT.captions.batchModeExit : TEXT.captions.batchMode}
          </button>
        ) : null}
      </div>

      {/* M11：外部字幕 / 名单导入（解析在渲染进程内完成，只读用户选的文件，不联网） */}
      <div className="caption-import">
        <button
          type="button"
          className="btn btn--sm btn--subtle"
          disabled={importing}
          title={TEXT.captions.importSubtitleHint}
          onClick={() => subtitleInputRef.current?.click()}
        >
          {TEXT.captions.importSubtitle}
        </button>
        <button
          type="button"
          className="btn btn--sm btn--subtle"
          disabled={importing}
          title={TEXT.captions.importListHint}
          onClick={() => listInputRef.current?.click()}
        >
          {TEXT.captions.importList}
        </button>
        <input
          ref={subtitleInputRef}
          type="file"
          accept=".srt,.ass,.ssa,text/plain"
          hidden
          aria-label={TEXT.captions.importSubtitle}
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void importSubtitle(file)
          }}
        />
        <input
          ref={listInputRef}
          type="file"
          accept=".csv,.json,.txt,.tsv,text/plain,application/json"
          hidden
          aria-label={TEXT.captions.importList}
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void importList(file)
          }}
        />
      </div>

      {/* M11：自动字幕（whisper.cpp）——选中媒体片段 → 识别 → 字幕条落时间轴 */}
      <CaptionAutoSection />

      {/* M11-I：批量工具栏（只有进入多选态才出现；每个按钮 = store 里的一次写入口 = 一步撤销） */}
      {batchMode && ordered.length > 0 ? (
        <>
          <div className="caption-import" role="group" aria-label={TEXT.captions.batchGroup}>
            <span className={`chip${batchSelection.length > 0 ? ' chip--ok' : ''}`}>
              {TEXT.captions.batchSelectedCount(batchSelection.length)}
            </span>
            <button
              type="button"
              className="btn btn--sm btn--subtle"
              onClick={() => setBatchIds(ordered.map((clip) => clip.id))}
            >
              {TEXT.captions.batchSelectAll}
            </button>
            <button
              type="button"
              className="btn btn--sm btn--subtle"
              disabled={batchSelection.length === 0}
              onClick={() => setBatchIds([])}
            >
              {TEXT.captions.batchClear}
            </button>
          </div>

          <div className="caption-import">
            <select
              className="select"
              aria-label={TEXT.captions.batchPreset}
              value={batchPresetId}
              onChange={(event) => setBatchPresetId(event.target.value as PresetId)}
            >
              {PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn--sm btn--subtle"
              disabled={batchSelection.length === 0}
              onClick={runBatchPreset}
            >
              {TEXT.captions.batchApplyPreset}
            </button>
          </div>

          <div className="caption-import">
            <input
              className="input mono"
              type="number"
              min={MIN_CLIP_DURATION_SEC}
              step={0.1}
              aria-label={TEXT.captions.batchDuration}
              value={batchDuration}
              onChange={(event) => setBatchDuration(event.target.value)}
            />
            <button
              type="button"
              className="btn btn--sm btn--subtle"
              disabled={batchSelection.length === 0 || !batchDurationValid}
              onClick={runBatchDuration}
            >
              {TEXT.captions.batchApplyDuration}
            </button>
          </div>

          <div className="caption-import">
            <label className="switch">
              <input
                type="checkbox"
                aria-label={TEXT.captions.batchCompact}
                checked={allCompact}
                onChange={runBatchCompact}
              />
              <span>{TEXT.captions.batchCompact}</span>
            </label>
            <label className="switch">
              <input
                type="checkbox"
                aria-label={TEXT.captions.batchGradient}
                checked={allGradient}
                onChange={runBatchGradient}
              />
              <span>{TEXT.captions.batchGradient}</span>
            </label>
            <button
              type="button"
              className="btn btn--sm btn--subtle"
              disabled={batchSelection.length === 0}
              onClick={runBatchDelete}
            >
              {TEXT.captions.batchDelete}
            </button>
          </div>

          {batchSelection.length === 0 ? <p className="hint">{TEXT.captions.batchEmptyHint}</p> : null}
        </>
      ) : null}

      {ordered.length === 0 ? (
        addHero
      ) : (
        <>
          <ol className="caption-list">
            {ordered.map((clip, index) => {
              const active = clip.id === selectedId
              const checked = batchIdSet.has(clip.id)
              const onAir = displayTime >= clip.startTime && displayTime < clip.endTime
              const classes = ['caption-item']
              if (active) classes.push('caption-item--active')
              if (checked) classes.push('caption-item--checked')
              if (onAir) classes.push('caption-item--onair')
              const title = clip.content.title || TEXT.captions.noTitle
              return (
                <li key={clip.id}>
                  <div className={classes.join(' ')}>
                    {/* M11-I：多选态的勾选框（与卡片点击等价；卡片本身仍是按钮，所以并列不嵌套） */}
                    {batchMode ? (
                      <label className="switch caption-item__select" title={TEXT.captions.selectNamed(title)}>
                        <input
                          type="checkbox"
                          aria-label={TEXT.captions.selectNamed(title)}
                          checked={checked}
                          onChange={() => toggleBatchSelect(clip.id)}
                        />
                      </label>
                    ) : null}
                    <button
                      type="button"
                      className="caption-item__pick"
                      aria-pressed={batchMode ? checked : active}
                      title={`${getPreset(clip.presetId).name} · ${TEXT.captions.hint}`}
                      onClick={() => (batchMode ? toggleBatchSelect(clip.id) : jumpTo(clip))}
                    >
                      <span className="caption-item__index mono">{index + 1}</span>
                      <span className="caption-item__body">
                        <span className="caption-item__title">{title}</span>
                        <span className="caption-item__sub">{clip.content.subtitle || TEXT.captions.noSubtitle}</span>
                        <span className="caption-item__meta mono">
                          {secondsToTimecode(clip.startTime, fps)} → {secondsToTimecode(clip.endTime, fps)} ·{' '}
                          {getPreset(clip.presetId).name}
                          {onAir ? <span className="caption-item__onair-tag"> {TEXT.captions.onAir}</span> : null}
                        </span>
                      </span>
                    </button>
                    {/* 删除按钮常驻：入口藏起来等于没有入口；卡片本体是按钮，所以两者并列而不能嵌套 */}
                    <button
                      type="button"
                      className="caption-item__remove"
                      aria-label={TEXT.captions.removeNamed(title)}
                      title={TEXT.captions.remove}
                      onClick={() => removeClip(clip.id)}
                    >
                      <IconTrash size={14} />
                    </button>
                  </div>
                </li>
              )
            })}
          </ol>
          {addRow}
        </>
      )}
    </section>
  )
}
