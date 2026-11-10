import { create } from 'zustand'
import { DEFAULT_FPS, DEFAULT_RESOLUTION, DEFAULT_SEQUENCE_ID, FREEZE_FRAME_DEFAULT_SEC, MAX_TRACK_SEC, MEDIA_BIN_MAX_COUNT, MEDIA_BIN_NAME_MAX_LENGTH, MIN_CLIP_DURATION_SEC, MIN_MEDIA_CLIP_SEC } from '@shared/constants'
import { applyClipStyleToAll, createClip, createId, createTextElementClip, duplicateClip, normalizeMediaClipMask, normalizeMediaTags, normalizeProject, normalizeTextElementClip, normalizeTransition, splitSubtitleClipAt } from '@shared/projectSchema'
import { frameIntervalSec, snapTimeToFrame, timeToFrameAtOrAfter } from '@shared/fps'
import { compactMediaClips, splitMediaClipAt, topActiveMediaClip } from '@shared/mediaClips'
import { mergeMediaClips, nextMediaClipOnTrack, planFreezeFrame, rippleDeleteMediaClip as applyRippleDelete } from '@shared/timelineOps'
import { clampMoveToGap, clampTrimEnd, clampTrimStart, firstFreeStart, gapAround, type TimelineSpan } from '@shared/clipCollision'
import { resolveTargetAt, findSelectedRef, type TargetRef, type TimelineSelection, type TimelineTracks } from '@shared/timelineTargets'
import { useStabPreviewStore } from './stabPreviewStore'
import type {
  AudioClip,
  AudioDuckingLevel,
  AudioMastering,
  AudioRole,
  ClipAudio,
  ClipSpeed,
  FontRecord,
  Fps,
  GraphicsZ,
  MediaClipKey,
  MediaBin,
  MediaClip,
  MediaClipMask,
  MediaClipStab,
  MediaClipTransition,
  MediaClipVideo,
  MediaItem,
  PresetId,
  Project,
  RefVideo,
  StyleOverrides,
  SubtitleClip,
  TextElementClip,
  TextElementPresetId,
  WatermarkSettings
} from '@shared/types'
import { DEFAULT_PRESET_ID, PRESET_IDS, getPreset } from '@shared/presets'
import { clipWithPresetDefaults, hasKeys } from '@shared/clipStyle'
import { defaultMediaVideo, normalizeMediaVideo } from '@shared/mediaClipVideo'
import { normalizeKeyframeTracks, type KeyframeTrack } from '@shared/keyframes'
import { normalizeMediaClipKey } from '@shared/keying'
import { planCaptionClips, type CaptionRow } from '@shared/captionBatch'
import { defaultMediaStab, normalizeMediaStab } from '@shared/mediaStab'
import { defaultClipAudio, defaultClipSpeed, normalizeClipAudio, normalizeClipSpeed, sourceTimeAt, speedValueOf } from '@shared/mediaClipAudio'
import {
  cleanupInvalidTransitions,
  previousMediaClipOnTrack,
  resolveTransitionDuration,
  transitionMediaMetaOf
} from '@shared/transitions'
import {
  addSequence as addSequenceToProject,
  duplicateSequence as duplicateSequenceInProject,
  removeSequence as removeSequenceFromProject,
  renameSequence as renameSequenceInProject,
  switchSequence as switchSequenceInProject
} from '@shared/sequence'
import { IMAGE_STILL_SEC, applyAudioClipSpeed, inferMediaKind, makeAudioClip, moveAudioClip as applyMoveAudioClip, sortAudioClips, splitAudioClipAt, trimAudioClip as applyTrimAudioClip } from '@shared/audioClips'
import {
  addAudioTrack as appendAudioTrack,
  addMediaTrack as appendMediaTrack,
  isTrackLocked,
  mediaTrackOrder,
  moveTrack as moveTrackIn,
  removeTrack as removeTrackIn,
  renameTrack as renameTrackIn,
  setTrackHidden as setTrackHiddenIn,
  setTrackLocked as setTrackLockedIn,
  setTrackMuted as setTrackMutedIn,
  trackById,
  visibleMediaTracks
} from '@shared/tracks'

/** 工程状态（规格 §4.6）。所有时间值在写入时已吸附到帧边界，存储仍为秒。 */

/** 右侧检查器当前跟谁：刚点中的是字幕条、媒体段、音频段、文本元素还是转场（可同时处于选中态）。 */
export type SelectionKind = 'subtitle' | 'media' | 'audio' | 'text' | 'transition'

export interface ProjectState {
  project: Project
  selectedClipId: string | null
  /** v2：媒体轨上选中的片段（拆分/删除/拖拽的目标） */
  selectedMediaClipId: string | null
  /** v7：音频轨上选中的片段 */
  selectedAudioClipId: string | null
  /** M7：文本元素选中 id（文本轨固定一条） */
  selectedTextClipId: string | null
  /**
   * v11：时间轴缝隙上选中的转场——记录的是**切点右侧片段**的 id（转场数据也落在它身上）。
   * 与 `selectedMediaClipId` 相互独立：点转场图标不会改变片段选中，右侧检查器靠 `selectionKind` 分流。
   */
  selectedTransitionClipId: string | null
  /** v3：当前选中的轨道 id（时间轴行高亮 / 新片段默认落点）；不持久化 */
  selectedTrackId: string | null
  /** v6：最后一次点选的类型——决定右侧检查器渲染字幕编辑器还是视频编辑器 */
  selectionKind: SelectionKind
  /** 字体库（内置 + 用户导入） */
  fonts: FontRecord[]
  /** 每次变更递增，驱动自动保存与预览重建 */
  revision: number
  currentPath: string | null
  /** 当前工程在最近工程索引里的身份（'autosave' 或 p+hash）；未知/null 时自动保存写入草稿 */
  currentEntryId: string | null
  /** 是否有未落盘改动（保存成功后由 adoptSavedEntry 清零） */
  isDirty: boolean
  /**
   * 工程被整体替换（打开工程文件 / 启动恢复自动存档）时自增。
   * 历史记账用它判「换工程了」——跨工程的撤销没有意义，看到它变化就清空整条历史。
   */
  projectEpoch: number

  loadProject: (project: Project, path?: string, entryId?: string | null) => void
  /**
   * 另存为 / 打开成功后接住主进程返回的新身份：
   * 只更新路径与 entryId，不推 revision（内容已经在磁盘上，自动保存不需要重写一遍）。
   */
  adoptSavedEntry: (path: string, entryId: string) => void
  setName: (name: string) => void
  setResolution: (width: number, height: number) => void
  setFps: (fps: Fps) => void
  setFonts: (fonts: FontRecord[]) => void

  /**
   * @deprecated v1 单参考视频写入口。v2 冒烟取证（runGateSmoke）仍走它写入再读回；
   * 正式路径是 addMedia + insertMediaClip。
   */
  setRefVideo: (refVideo: RefVideo | undefined) => void
  /** @deprecated 同上，枚级确认请使用 ackMedia* 系列 */
  setVfrPolicy: (policy: RefVideo['vfrPolicy']) => void
  /** @deprecated 同上 */
  setCompactMode: (mode: RefVideo['compactMode']) => void
  /** @deprecated 同上 */
  ackNon169: (value: boolean) => void
  /** @deprecated 同上 */
  ackHdr: (value: boolean) => void

  addClip: (atSec?: number) => string
  duplicateClipAction: (id: string) => string | null
  removeClip: (id: string) => void
  selectClip: (id: string | null) => void
  /**
   * 把当前片段的样式（预设/配色/字体/字号/动画）应用到全部片段，保留每段文字与入出点。
   * 返回被改写的片段数（不含源片段）。
   */
  applyStyleToAll: (sourceId: string) => number
  updateClip: (id: string, patch: Partial<Pick<SubtitleClip, 'content' | 'presetId' | 'fontId' | 'animation' | 'styleOverrides'>>) => void
  /** 清除本条全部自定义参数，回到当前预设的默认配置（文字与入出点不动） */
  resetClipStyle: (id: string) => void
  setClipTimes: (id: string, startTime: number, endTime: number) => void
  /**
   * M6：整份替换字幕条关键帧（undefined = 清空并删键）。
   * 入参经 `normalizeKeyframeTracks` 归一（未知参数/非法点/过冲曲线都在这里被挡掉）。
   */
  setClipKeyframes: (id: string, keyframes: KeyframeTrack[] | undefined) => void
  /**
   * M6-E：整份替换媒体段关键帧（undefined = 清空并删键）。
   * 与字幕条共用 `normalizeKeyframeTracks`，同样"同值不产生撤销步"。
   */
  setMediaClipKeyframes: (id: string, keyframes: KeyframeTrack[] | undefined) => void
  /**
   * M8：整份替换媒体段手绘遮罩（undefined = 清除遮罩）。
   * 归一化/去重口径同 `setMediaClipKeyframes`：同值不产生撤销步。
   */
  setMediaClipMask: (id: string, mask: MediaClipMask | undefined) => void
  /** M8-P0：外部 matte（绝对路径 + 类型）；同值不推 revision，空则整键删除 */
  setMediaClipMatte: (
    id: string,
    matte: { path: string; kind: 'image' | 'video' } | undefined
  ) => void

  // ---------------------------------------------------------------- M11 字幕导入/批量
  /**
   * 把外部字幕（SRT/ASS 解析后的 cue）落成字幕条：时间吸附帧边界、标题=文本、副标题留空。
   * `replace` = 先清空现有字幕条；返回新增条数。
   */
  addCaptionsFromCues: (
    cues: ReadonlyArray<{ startSec: number; endSec: number; text: string }>,
    options?: { replace?: boolean; presetId?: PresetId }
  ) => number
  /**
   * 批量名单 → 首尾相接的字幕条（CSV/JSON/纯文本解析后的行）；返回新增条数。
   * 入点缺省 = 现有字幕末尾（接在最后一条后面）。
   */
  addCaptionBatch: (
    rows: ReadonlyArray<{ title: string; subtitle: string; durationSec?: number }>,
    options?: { startSec?: number; defaultDurationSec?: number; gapSec?: number; presetId?: PresetId }
  ) => number

  /**
   * M11-I：字幕列表多选的批量编辑。
   *
   * 五个入口共享同一条口径：**一次批量动作只推一次 revision**（= 项目级历史里的一步撤销），
   * 而且没有任何条目真的变化时不推 revision；`ids` 里不存在的条目直接忽略。
   * 返回实际改写的条数（0 = 什么都没动）。
   */
  /** 批量应用包装预设：与单条切预设同义（重置自定义、字体与动画节奏；文字与入出点不动）。 */
  applyPresetToClips: (ids: readonly string[], presetId: PresetId) => number
  /**
   * 批量统一时长：每条从自己的入点起顺延到「入点 + durationSec」，帧吸附、不小于最短时长；
   * 撞到右侧邻居就贴住（夹完不足最短时长的条目保持原样，不制造非法区间）。
   */
  setClipsDuration: (ids: readonly string[], durationSec: number) => number
  /** 批量删除字幕条（未知 id 忽略；删掉当前选中条目时把选中态挪到剩余第一条）。 */
  removeClips: (ids: readonly string[]) => number
  /** 批量开关「强制竖屏紧凑分支」（对应单条检查器里的 compact 开关；关掉即删键）。 */
  setClipsCompact: (ids: readonly string[], compact: boolean) => number
  /** 批量开关标题渐变（主/副标题各一条；开启沿用各条已有颜色，缺省用统一双色）。 */
  setClipsGradientEnabled: (ids: readonly string[], enabled: boolean) => number

  // ---------------------------------------------------------------- M7 文本元素
  /** 新建文本元素（缺省放在 `at`，示例文案取预设；选中并切到文本检查器）。 */
  addTextClip: (input?: {
    at?: number
    durationSec?: number
    presetId?: TextElementPresetId
    text?: string
  }) => TextElementClip | null
  /** 增量更新（text/presetId/styleOverrides/动画/入出点/关键帧）；整份候选过归一后再写。 */
  updateTextClip: (
    id: string,
    patch: Partial<
      Pick<TextElementClip, 'text' | 'presetId' | 'styleOverrides' | 'startTime' | 'endTime' | 'animation' | 'keyframes'>
    >
  ) => void
  removeTextClip: (id: string) => void
  selectTextClip: (id: string | null) => void

  // ---------------------------------------------------------------- v2 素材池
  /** 导入一枚素材（已探测 + 已门禁确认）；同路径已存在时复用旧条目，返回 mediaId。 */
  addMedia: (item: Omit<MediaItem, 'id'> & { id?: string }) => string
  /** 移出素材池；默认连带删除引用它的 mediaClip（removeClips=false 用于「重新定位」换源不换轨）。 */
  removeMedia: (mediaId: string, options?: { removeClips?: boolean }) => void
  /** 换源（重新定位）：只改 path/meta/sourcePath，时间轴片段保持不动。 */
  relocateMedia: (mediaId: string, patch: Pick<MediaItem, 'path' | 'meta'> & Partial<Pick<MediaItem, 'sourcePath' | 'vfrPolicy'>>) => void
  renameMedia: (mediaId: string, name: string) => void
  setMediaCompactMode: (mediaId: string, mode: MediaItem['compactMode']) => void
  setMediaVfrPolicy: (mediaId: string, policy: MediaItem['vfrPolicy']) => void
  ackMediaNon169: (mediaId: string, value: boolean) => void
  ackMediaHdr: (mediaId: string, value: boolean) => void
  setMediaThumb: (mediaId: string, thumbnailUrl: string) => void

  // ---------------------------------------------------------------- v10 素材分组与标签
  /** 新建分组（名称 trim/限长；为空或已达上限返回 null），返回分组 id。 */
  addMediaBin: (name: string) => string | null
  /** 重命名分组（空名或分组不存在时忽略）。 */
  renameMediaBin: (id: string, name: string) => void
  /** 删除分组：分组消失，组内素材回到未分组（素材与时间轴引用都不动）。 */
  removeMediaBin: (id: string) => void
  /** 把素材归入分组（null/undefined = 未分组；指向不存在的分组时忽略）。 */
  assignMediaBin: (mediaId: string, binId: string | null | undefined) => void
  /** 写回素材标签（trim/丢空/去重/限长/限量；空数组删除 tags 键）。 */
  setMediaTags: (mediaId: string, tags: string[]) => void

  // ---------------------------------------------------------------- 水印
  /** 写入 / 替换水印设置（导入成功后调用）；传 null 等于移除，工程回到无水印形态。 */
  setWatermark: (settings: WatermarkSettings | null) => void
  /** 只改开关，不动路径与尺寸（临时停用而不必重新导入） */
  setWatermarkEnabled: (enabled: boolean) => void

  // ---------------------------------------------------------------- v2 媒体轨
  selectMediaClip: (id: string | null) => void
  /**
   * 把素材放入时间轴 [timelineStartSec, timelineStartSec + durationSec]。
   * 源入出点吸附后不足最短时长时向内收；返回新片段（null = 素材不存在或区间退化）。
   */
  insertMediaClip: (input: {
    mediaId: string
    timelineStartSec: number
    durationSec?: number
    sourceInSec?: number
    /** v3：落点轨道；缺省 = 当前选中媒体轨，再缺省 = 第一条媒体轨 */
    trackId?: string
  }) => MediaClip | null
  /** 整段平移（可跨轨）；与「仅重叠才右移后续片段」规则共用 alignAfterOverlap。 */
  moveMediaClip: (id: string, timelineStartSec: number, trackId?: string) => void
  /** 拖入/出点：时间轴与源坐标同幅度平移，保持时长恒等式。 */
  trimMediaClip: (id: string, patch: { timelineStartSec?: number; timelineEndSec?: number }) => void
  /** 删除一段（不动素材池；素材库卡片仍在）。 */
  removeMediaClip: (id: string) => void
  /**
   * M5 波纹删除：删除该段并把它后面的**同轨**片段整体左移被删时长（合上空隙）。
   * 返回是否真的处理了（片段不存在 / 轨道锁定 → false）。
   */
  rippleDeleteMediaClip: (id: string) => boolean
  /**
   * M5 合并：把该段与同轨紧邻的下一段并成一段（要求同素材、源连续、参数一致）。
   * 返回是否合并成功；失败时 UI/CLI 用 `canMergeMediaClips` 拿具体原因。
   */
  mergeMediaClipWithNext: (id: string) => boolean
  /**
   * M5 冻结帧：把 `atSec`（默认播放头）所在片段的那一帧抽成静态 PNG 素材，
   * 切点处插入一段冻结片段，并把后续同轨片段右移。
   * 源不在 / FFmpeg 不可用 / 轨道锁定 / 切点不可用时返回 null（不抛错）。
   */
  freezeFrameAt: (
    atSec?: number,
    options?: { clipId?: string; durationSec?: number }
  ) => Promise<string | null>

  // ---------------------------------------------------------------- v4 多序列
  /** 新建一条空序列（不切换）；达到上限返回 null。 */
  addSequence: (name?: string) => string | null
  /** 删除序列；只剩一条或不存在时返回 false。删活动序列会先切到第一条非活动序列。 */
  removeSequence: (id: string) => boolean
  /** 重命名序列；空名/不存在返回 false。 */
  renameSequence: (id: string, name: string) => boolean
  /** 切换当前编辑的序列（会重置选中态）；不存在或已是当前时返回 false。 */
  selectSequence: (id: string) => boolean
  /** 复制序列（缺省复制活动序列），副本留在非活动序列里；返回新序列 id。 */
  duplicateSequence: (id?: string, name?: string) => string | null
  /**
   * 拆「当前该操作的那一段」（P3）：选中优先（字幕条 / 媒体段 / 音频段三类都算），
   * 未选中时拆播放头处媒体轨的最下一层。返回右半段 id；
   * 没有目标段、切点不在段内或任一半不足最短时长时返回 null，由 UI 提示。
   */
  splitTargetAt: (atSec: number) => string | null
  /** 删「当前该操作的那一段」（目标解析与 splitTargetAt 同源）。返回是否真的删掉了。 */
  removeTargetAt: (atSec: number) => boolean
  /**
   * 只删「当前选中的那一段」，没选中就什么都不做。
   * Delete 键走这条而不是 removeTargetAt：一个键盘就能删掉用户没选中的段太可疑。
   */
  removeSelected: () => boolean

  // ---------------------------------------------------------------- v6 画面编辑
  /** 写回媒体段的画面变换/调色（patch 为增量；全部默认时整键删除） */
  updateMediaClipVideo: (id: string, patch: Partial<MediaClipVideo>) => void
  /** 一条片段的所有画面编辑回到默认（缩放 100% / 无翻转 / 参数归零 / 曲线直线；v8：连防抖一起清） */
  resetMediaClipVideo: (id: string) => void

  // ---------------------------------------------------------------- v8 防抖
  /** 写回媒体段的防抖参数（patch 为增量；全部默认时整键删除） */
  updateMediaClipStab: (id: string, patch: Partial<MediaClipStab>) => void

  // ---------------------------------------------------------------- v10 转场
  /**
   * 设置 / 移除本段的入场转场（落在切点右侧片段上）。
   * 类型/时长走 schema 归一与手柄解析；首段、空隙、手柄不足、轨道锁定时不写入无效数据。
   * 返回是否写入了有效转场（拖拽落点反馈用；重复设置同一转场也算成功）。
   */
  setMediaClipTransition: (id: string, transition: MediaClipTransition | null) => boolean
  /**
   * v11：选中切点上的转场（id = 切点右侧片段）。数据不存在时忽略。
   * 选中后右侧检查器切到转场面板，Delete/退格键优先删除它。
   */
  selectTransition: (id: string | null) => void

  // ---------------------------------------------------------------- v9 音频与变速
  /** 写回媒体段原声的音量/渐入渐出（patch 为增量；全默认整键删除） */
  updateMediaClipAudio: (id: string, patch: Partial<ClipAudio>) => void
  /**
   * 写回媒体段变速。**源窗口不动**，时间轴出点按 `源窗口 / 倍速` 重算，
   * 所以 2x 会让片段在时间轴上缩短一半（不去推挤其他片段：叠层重叠是 v7 的正常形态）。
   */
  updateMediaClipSpeed: (id: string, patch: Partial<ClipSpeed>) => void
  /** 写回音频段的音量/渐入渐出 */
  updateAudioClipAudio: (id: string, patch: Partial<ClipAudio>) => void
  /** 写回音频段变速（同上：源窗口不动，时间轴长度伸缩） */
  updateAudioClipSpeed: (id: string, patch: Partial<ClipSpeed>) => void
  /** v10：写回音频段角色（voice = 默认，不落盘；bgm 落盘） */
  updateAudioClipRole: (id: string, role: AudioRole) => void
  /** v10：写回音频段 BGM 自动压低档位（undefined = 关闭，不落盘） */
  updateAudioClipDucking: (id: string, level: AudioDuckingLevel | undefined) => void
  /** 本条音频的音量/渐变/变速/角色/ducking 全部回到默认（时间轴长度回到源窗口长度） */
  resetAudioClipFx: (id: string) => void

  // ---------------------------------------------------------------- v10 音频质量
  /** 工程级响度标准化：social/broadcast 落盘，off/undefined 删除键；单次写入推一次 revision */
  setAudioMastering: (mastering: AudioMastering | undefined) => void
  /** M7-E：图形层 z 档（belowMedia 才落盘；aboveMedia = 删键） */
  setGraphicsZ: (graphicsZ: GraphicsZ | undefined) => void
  /** M8：媒体段抠像（undefined = 关闭；归一后写入） */
  setClipKey: (id: string, key: MediaClipKey | undefined) => void

  // ---------------------------------------------------------------- v7 音频轨
  selectAudioClip: (id: string | null) => void
  /** 把音频素材丢到音频轨 [start, start + duration]；返回新片段（null = 素材缺失或区间退化） */
  insertAudioClip: (input: {
    mediaId: string
    timelineStartSec: number
    durationSec?: number
    sourceInSec?: number
    /** v3：落点音频轨；缺省 = 当前选中音频轨，再缺省 = 第一条音频轨 */
    trackId?: string
  }) => AudioClip | null
  /** 整段平移（可跨轨；音频允许互相重叠，不与其它段推挤） */
  moveAudioClip: (id: string, timelineStartSec: number, trackId?: string) => void
  /** 拖入点 / 出点（保持时长恒等式） */
  trimAudioClip: (id: string, patch: { timelineStartSec?: number; timelineEndSec?: number }) => void
  removeAudioClip: (id: string) => void
  /** v3：把媒体段换到另一条媒体轨（时间不变；目标轨同段有冲突时拒绝） */
  setMediaClipTrack: (id: string, trackId: string) => void
  /** v3：把音频段换到另一条音频轨 */
  setAudioClipTrack: (id: string, trackId: string) => void

  // ---------------------------------------------------------------- v3 轨道管理
  /** 选中轨道（时间轴行高亮 / 新片段默认落点） */
  selectTrack: (id: string | null) => void
  /** 在最上层新增媒体轨；达到上限返回 null */
  addMediaTrack: () => string | null
  /** 在最上层新增音频轨；达到上限返回 null */
  addAudioTrack: () => string | null
  /** 删除媒体轨（连同其上的片段）；最后一条轨不允许删 */
  removeMediaTrack: (id: string) => void
  /** 删除音频轨（连同其上的片段）；最后一条轨不允许删 */
  removeAudioTrack: (id: string) => void
  /** 调整媒体轨层级（0 = 最底层） */
  moveMediaTrack: (id: string, toIndex: number) => void
  /** 调整音频轨层级（0 = 最底层） */
  moveAudioTrack: (id: string, toIndex: number) => void
  /** 重命名轨道（媒体/音频/字幕三类都走它） */
  renameTrack: (id: string, name: string) => void
  setTrackMuted: (id: string, muted: boolean) => void
  setTrackHidden: (id: string, hidden: boolean) => void
  setTrackLocked: (id: string, locked: boolean) => void

  // ---------------------------------------------------------------- 时间轴工具
  /**
   * 主轨对齐：把所有媒体段按时间顺序从左到右紧贴排列（间隙 0，时长不变）。
   * 开关本身是 UI 态（uiStore），这个动作只负责把工程摆正；重复调用是幂等的。
   */
  compactTimeline: () => void
}

export function createInitialProject(): Project {
  return normalizeProject({
    version: 2,
    name: '未命名工程',
    resolution: { ...DEFAULT_RESOLUTION },
    fps: { ...DEFAULT_FPS },
    clips: [],
    fonts: [],
    media: [],
    mediaClips: []
  })!
}

/** 时间轴时长（秒）：字幕轨与媒体轨双轨取最大覆盖，无片段时给一个可编辑的短默认值。 */
export function timelineDurationSec(project: Project): number {
  const clipsEnd = project.clips.reduce((acc, clip) => Math.max(acc, clip.endTime), 0)
  const mediaEnd = project.mediaClips.reduce((acc, clip) => Math.max(acc, clip.timelineEndSec), 0)
  // v7：音频轨也算进尺规总长，否则拖到后面的音频会跑出尺规
  const audioEnd = (project.audioClips ?? []).reduce((acc, clip) => Math.max(acc, clip.timelineEndSec), 0)
  const furthest = Math.max(clipsEnd, mediaEnd, audioEnd)
  return furthest > 0 ? furthest : 5
}

/** 媒体轨总覆盖（含素材时长）：时间轴尺规至少容得下全部片段。 */
export function timelineMediaSpanSec(project: Project): number {
  return project.media.reduce((acc, item) => Math.max(acc, item.meta.durationSec), 0)
}

function withClips(project: Project, clips: SubtitleClip[]): Project {
  return { ...project, clips: [...clips].sort((a, b) => a.startTime - b.startTime) }
}

/** 字幕条 → 夹取函数用的区间（它用 startTime/endTime，与另两轨字段名不同）。 */
function subtitleSpan(clip: SubtitleClip): TimelineSpan {
  return { startSec: clip.startTime, endSec: clip.endTime }
}

/** 媒体段 / 音频段 → 夹取函数用的区间。 */
function trackSpan(clip: { timelineStartSec: number; timelineEndSec: number }): TimelineSpan {
  return { startSec: clip.timelineStartSec, endSec: clip.timelineEndSec }
}

function withMediaClips(project: Project, mediaClips: MediaClip[]): Project {
  return { ...project, mediaClips: [...mediaClips].sort((a, b) => a.timelineStartSec - b.timelineStartSec) }
}

/** M7：文本元素写入口（按入点排序；空数组时删掉整个键，保持 JSON 干净）。 */
function withTextClips(project: Project, textClips: TextElementClip[]): Project {
  const sorted = [...textClips].sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id))
  const next: Project = { ...project }
  if (sorted.length > 0) next.textClips = sorted
  else delete next.textClips
  return next
}

/**
 * v7：入池前把素材补全成「带 kind 的完整条目」。
 * - 图像：ffprobe 读不出时长（单帧），给一个默认静帧时长，否则上轨后长度为 0；
 * - 音频：没有画面（width=0），不带兼容性确认；
 * - 视频：不写 kind（旧工程 JSON 形状不变）。
 */
function normalizeImportedMedia(item: MediaItem): MediaItem {
  const kind = item.kind ?? inferMediaKind(item.path, item.meta)
  const meta = kind === 'image' && !(item.meta.durationSec > 0) ? { ...item.meta, durationSec: IMAGE_STILL_SEC } : item.meta
  return { ...item, meta, ...(kind !== 'video' ? { kind } : {}) }
}

/** v10：分组名校验（与 schema 归一同一口径：trim → 限长 → 再去尾空白）。 */
function normalizeBinName(name: string): string {
  return name.trim().slice(0, MEDIA_BIN_NAME_MAX_LENGTH).trim()
}

/** v7：音频轨写入口（按时间排序；空轨道时删掉整个键，保持 JSON 干净） */
function withAudioClips(project: Project, audioClips: AudioClip[]): Project {
  const sorted = sortAudioClips(audioClips)
  const next: Project = { ...project }
  if (sorted.length > 0) next.audioClips = sorted
  else delete next.audioClips
  return next
}

/**
 * M11-I：批量开渐变时的缺省双色（与 ColorPanel 的 GradientEditor 缺省值同源）。
 * 批量只负责「开/关」，颜色本身仍归单条面板管：已有颜色一律沿用，只有从没有过渐变的条目才落到这组默认值。
 */
const BATCH_GRADIENT_DEFAULTS = { from: '#ffffff', to: '#9ec7ff', angleDeg: 90 }

/** 批量写入口的「是否真的变了」判定：结构完全相同视为没变（不推 revision、不产生撤销步）。 */
function clipSnapshotOf(clip: SubtitleClip): string {
  return JSON.stringify(clip)
}

/** P3：拆分/删除的目标解析要看的三条轨。 */
function tracksOf(project: Project): TimelineTracks {
  return {
    clips: project.clips,
    mediaClips: project.mediaClips,
    audioClips: project.audioClips ?? [],
    mediaTracks: project.mediaTracks
  }
}

/**
 * M5：播放头处「最上层可见媒体轨」上的片段。
 * 冻结帧默认以它为目标：隐藏轨不参与（预览里看不见的东西不该被悄悄冻结），
 * 多轨重叠时取最上层（与预览/导出的合成顺序一致）。
 */
function topMediaClipAt(project: Project, atSec: number): MediaClip | null {
  const visibleTrackIds = new Set(visibleMediaTracks(project.mediaTracks).map((track) => track.id))
  const visibleClips = project.mediaClips.filter((clip) => visibleTrackIds.has(clip.trackId))
  return topActiveMediaClip(visibleClips, atSec, mediaTrackOrder(project.mediaTracks))
}

/**
 * P3：当前选中态。三个选中 id 可以并存，`selectionKind`（最后一次点选的类型）才是分流依据，
 * 所以下面三个都得带上，不能只挑一个非空的传。
 */
function selectionOf(state: ProjectState): TimelineSelection {
  return {
    clipId: state.selectedClipId,
    mediaClipId: state.selectedMediaClipId,
    audioClipId: state.selectedAudioClipId,
    kind: state.selectionKind
  }
}

/** 按解析出的目标段分派到三条轨各自的删除动作。 */
function removeTargetRef(store: ProjectState, target: TargetRef): void {
  if (target.kind === 'subtitle') store.removeClip(target.id)
  else if (target.kind === 'audio') store.removeAudioClip(target.id)
  else store.removeMediaClip(target.id)
}

/**
 * v4：切换/删除活动序列后要清空的选中态。
 * 片段 id 属于旧序列，留着会让检查器指向一段不存在的片段（面板空白但仍在编辑）。
 */
const CLEARED_SELECTION = {
  selectedClipId: null,
  selectedMediaClipId: null,
  selectedAudioClipId: null,
  selectedTextClipId: null,
  selectedTransitionClipId: null,
  selectedTrackId: null,
  selectionKind: 'subtitle' as const
}

/** v3：落点轨道解析——显式指定优先，其次当前选中轨，最后第一条同类轨道。 */
function pickMediaTrackId(project: Project, preferred: string | null | undefined): string {
  if (preferred && project.mediaTracks.some((track) => track.id === preferred)) return preferred
  return project.mediaTracks[0]!.id
}

function pickAudioTrackId(project: Project, preferred: string | null | undefined): string {
  if (preferred && project.audioTracks.some((track) => track.id === preferred)) return preferred
  return project.audioTracks[0]!.id
}

function spansOverlap(a: TimelineSpan, b: TimelineSpan): boolean {
  return a.startSec < b.endSec - 1e-9 && b.startSec < a.endSec - 1e-9
}

/** 三个开关分别写三类轨道（媒体/音频/字幕），找不到轨就原样返回。 */
function withTrackMuted(project: Project, id: string, muted: boolean): Project {
  const mediaTracks = setTrackMutedIn(project.mediaTracks, id, muted)
  if (mediaTracks !== project.mediaTracks) return { ...project, mediaTracks }
  const audioTracks = setTrackMutedIn(project.audioTracks, id, muted)
  if (audioTracks !== project.audioTracks) return { ...project, audioTracks }
  const [subtitleTrack] = setTrackMutedIn([project.subtitleTrack], id, muted)
  if (subtitleTrack && subtitleTrack !== project.subtitleTrack) return { ...project, subtitleTrack }
  return project
}

function withTrackHidden(project: Project, id: string, hidden: boolean): Project {
  const mediaTracks = setTrackHiddenIn(project.mediaTracks, id, hidden)
  if (mediaTracks !== project.mediaTracks) return { ...project, mediaTracks }
  const audioTracks = setTrackHiddenIn(project.audioTracks, id, hidden)
  if (audioTracks !== project.audioTracks) return { ...project, audioTracks }
  const [subtitleTrack] = setTrackHiddenIn([project.subtitleTrack], id, hidden)
  if (subtitleTrack && subtitleTrack !== project.subtitleTrack) return { ...project, subtitleTrack }
  return project
}

function withTrackLocked(project: Project, id: string, locked: boolean): Project {
  const mediaTracks = setTrackLockedIn(project.mediaTracks, id, locked)
  if (mediaTracks !== project.mediaTracks) return { ...project, mediaTracks }
  const audioTracks = setTrackLockedIn(project.audioTracks, id, locked)
  if (audioTracks !== project.audioTracks) return { ...project, audioTracks }
  const [subtitleTrack] = setTrackLockedIn([project.subtitleTrack], id, locked)
  if (subtitleTrack && subtitleTrack !== project.subtitleTrack) return { ...project, subtitleTrack }
  return project
}

/** 时长恒等式（timelineEnd - timelineStart === sourceOut - sourceIn）的唯一写入口。 */
function makeMediaClip(input: {
  id?: string
  mediaId: string
  trackId: string
  timelineStartSec: number
  timelineEndSec: number
  sourceInSec: number
  sourceOutSec: number
}): MediaClip {
  return {
    id: input.id ?? createId('mclip'),
    mediaId: input.mediaId,
    trackId: input.trackId,
    timelineStartSec: input.timelineStartSec,
    timelineEndSec: input.timelineEndSec,
    sourceInSec: input.sourceInSec,
    sourceOutSec: input.sourceOutSec
  }
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  project: createInitialProject(),
  selectedClipId: null,
  selectedMediaClipId: null,
  selectedAudioClipId: null,
  selectedTextClipId: null,
  selectedTransitionClipId: null,
  selectedTrackId: null,
  selectionKind: 'subtitle',
  fonts: [],
  revision: 0,
  currentPath: null,
  currentEntryId: null,
  isDirty: false,
  projectEpoch: 0,

  loadProject: (project, path, entryId) =>
    set((state) => ({
      project,
      currentPath: path ?? null,
      currentEntryId: entryId ?? null,
      isDirty: false,
      selectedClipId: project.clips[0]?.id ?? null,
      selectedMediaClipId: project.mediaClips[0]?.id ?? null,
      selectedAudioClipId: project.audioClips?.[0]?.id ?? null,
      selectedTransitionClipId: null,
      selectedTrackId: null,
      // 打开工程默认先看字幕（这是主任务）；没有字幕条时才落到视频编辑器
      selectionKind: project.clips.length > 0 ? 'subtitle' : 'media',
      revision: state.revision + 1,
      projectEpoch: state.projectEpoch + 1
    })),

  adoptSavedEntry: (path, entryId) =>
    set({ currentPath: path, currentEntryId: entryId, isDirty: false }),

  setName: (name) =>
    set((state) => ({ project: { ...state.project, name }, revision: state.revision + 1 })),

  setResolution: (width, height) =>
    set((state) => ({
      project: { ...state.project, resolution: { width: Math.round(width), height: Math.round(height) } },
      revision: state.revision + 1
    })),

  setFps: (fps) => {
    const state = get()
    // 换帧率时保持秒不变，重新吸附入出点（规格 §4.4：时间点跨帧率一致）；媒体轨同步
    const clips = state.project.clips.map((clip) => ({
      ...clip,
      startTime: snapTimeToFrame(clip.startTime, fps),
      endTime: snapTimeToFrame(clip.endTime, fps)
    }))
    const mediaClips = state.project.mediaClips.map((clip) => ({
      ...clip,
      timelineStartSec: snapTimeToFrame(clip.timelineStartSec, fps),
      timelineEndSec: snapTimeToFrame(clip.timelineEndSec, fps),
      sourceInSec: snapTimeToFrame(clip.sourceInSec, fps),
      sourceOutSec: snapTimeToFrame(clip.sourceOutSec, fps)
    }))
    set({ project: { ...state.project, fps, clips, mediaClips }, revision: state.revision + 1 })
  },

  setFonts: (fonts) => set((state) => ({ fonts, revision: state.revision + 1 })),

  setRefVideo: (refVideo) =>
    set((state) => ({
      project: { ...state.project, ...(refVideo ? { refVideo } : { refVideo: undefined }) },
      revision: state.revision + 1
    })),

  setVfrPolicy: (policy) =>
    set((state) => {
      if (!state.project.refVideo) return {}
      return {
        project: { ...state.project, refVideo: { ...state.project.refVideo, vfrPolicy: policy } },
        revision: state.revision + 1
      }
    }),

  setCompactMode: (mode) =>
    set((state) => {
      if (!state.project.refVideo) return {}
      return {
        project: { ...state.project, refVideo: { ...state.project.refVideo, compactMode: mode } },
        revision: state.revision + 1
      }
    }),

  ackNon169: (value) =>
    set((state) => {
      if (!state.project.refVideo) return {}
      return {
        project: { ...state.project, refVideo: { ...state.project.refVideo, non169Ack: value } },
        revision: state.revision + 1
      }
    }),

  ackHdr: (value) =>
    set((state) => {
      if (!state.project.refVideo) return {}
      return { project: { ...state.project, refVideo: { ...state.project.refVideo, hdrAck: value } }, revision: state.revision + 1 }
    }),

  addClip: (atSec) => {
    const state = get()
    const fps = state.project.fps
    const start = atSec ?? (state.project.clips.length === 0 ? 0 : timelineDurationSec(state.project))
    const clip = createClip({ startTime: start, fps })
    const project = withClips(state.project, [...state.project.clips, clip])
    set({ project, selectedClipId: clip.id, revision: state.revision + 1 })
    return clip.id
  },

  duplicateClipAction: (id) => {
    const state = get()
    const clip = state.project.clips.find((c) => c.id === id)
    if (!clip) return null
    const copy = duplicateClip(clip, state.project.fps)
    const project = withClips(state.project, [...state.project.clips, copy])
    set({ project, selectedClipId: copy.id, revision: state.revision + 1 })
    return copy.id
  },

  removeClip: (id) => {
    const state = get()
    const clips = state.project.clips.filter((c) => c.id !== id)
    const selectedClipId = state.selectedClipId === id ? (clips[0]?.id ?? null) : state.selectedClipId
    set({ project: withClips(state.project, clips), selectedClipId, revision: state.revision + 1 })
  },

  selectClip: (id) =>
    set({ selectedClipId: id, selectedTransitionClipId: null, ...(id ? { selectionKind: 'subtitle' as const } : {}) }),

  applyStyleToAll: (sourceId) => {
    const state = get()
    const result = applyClipStyleToAll(state.project, sourceId)
    if (result.count === 0) return 0
    set({ project: withClips(result.project, result.project.clips), revision: state.revision + 1 })
    return result.count
  },

  updateClip: (id, patch) => {
    const state = get()
    const clips = state.project.clips.map((clip) => {
      if (clip.id !== id) return clip
      /**
       * 切预设（含重复点当前预设）= 即时应用该预设并把**全部**自定义参数回到它的默认配置：
       * 配色/透明度/渐变/字号缩放/紧凑清空、字体回默认、动画回预设声明的节奏；文字与入出点不动。
       * 同一次调用里显式传了其他字段时，仍按调用者给的叠加在上面（不让 patch 默默丢字段）。
       */
      const base = patch.presetId
        ? clipWithPresetDefaults({ ...clip }, getPreset(patch.presetId as PresetId))
        : { ...clip }
      if (patch.content) base.content = { ...base.content, ...patch.content }
      if (patch.styleOverrides) base.styleOverrides = mergeOverrides(base.styleOverrides, patch.styleOverrides)
      if (patch.fontId) base.fontId = patch.fontId
      if (patch.animation) base.animation = { ...base.animation, ...patch.animation }
      return base
    })
    set({ project: withClips(state.project, clips), revision: state.revision + 1 })
  },

  /** 清除本条全部自定义，回到当前预设的默认配置（与切预设同一口径，不碰文字与入出点）。 */
  resetClipStyle: (id) => {
    const state = get()
    const clips = state.project.clips.map((clip) =>
      clip.id === id ? clipWithPresetDefaults(clip, getPreset(clip.presetId)) : clip
    )
    set({ project: withClips(state.project, clips), revision: state.revision + 1 })
  },

  setClipTimes: (id, startTime, endTime) => {
    const state = get()
    const fps = state.project.fps
    const current = state.project.clips.find((clip) => clip.id === id)
    if (!current) return
    const minSec = frameIntervalSec(fps)
    // 只在「自己当前所在的空档」里移动/伸缩：撞到邻居就贴住，不推开别人
    const gap = gapAround(
      subtitleSpan(current),
      state.project.clips.filter((clip) => clip.id !== id).map(subtitleSpan)
    )
    let start = snapTimeToFrame(Math.max(0, startTime), fps)
    let end = snapTimeToFrame(Math.max(start + 0.001, endTime), fps)
    const startMoved = Math.abs(start - current.startTime) > 1e-9
    const endMoved = Math.abs(end - current.endTime) > 1e-9
    if (startMoved && endMoved) {
      // 整体拖拽：保持时长，夹在空档里
      const length = Math.max(minSec, end - start)
      start = clampMoveToGap(start, length, gap.startSec, gap.endSec)
      end = snapTimeToFrame(start + length, fps)
    } else if (startMoved) {
      start = clampTrimStart(start, gap.startSec, current.endTime - minSec)
    } else if (endMoved) {
      end = clampTrimEnd(end, current.startTime + minSec, gap.endSec)
    }
    if (timeToFrameAtOrAfter(end, fps) - timeToFrameAtOrAfter(start, fps) < 1) {
      end = snapTimeToFrame(start + 0.2, fps)
    }
    const clips = state.project.clips.map((clip) => (clip.id === id ? { ...clip, startTime: start, endTime: end } : clip))
    set({ project: withClips(state.project, clips), revision: state.revision + 1 })
  },

  setClipKeyframes: (id, keyframes) => {
    const state = get()
    const current = state.project.clips.find((clip) => clip.id === id)
    if (!current) return
    // 归一后再比较：避免「写入了同样的点」也产生一次撤销步 / 一次自动存档
    const normalized = normalizeKeyframeTracks(keyframes)
    const before = JSON.stringify(current.keyframes ?? null)
    const after = JSON.stringify(normalized ?? null)
    if (before === after) return
    const next: SubtitleClip = { ...current }
    if (normalized) next.keyframes = normalized
    else delete next.keyframes
    const clips = state.project.clips.map((clip) => (clip.id === id ? next : clip))
    set({ project: withClips(state.project, clips), revision: state.revision + 1 })
  },

  // ---------------------------------------------------------------- M11 字幕导入/批量
  addCaptionsFromCues: (cues, options) => {
    const state = get()
    const fps = state.project.fps
    const presetId = options?.presetId ?? DEFAULT_PRESET_ID
    const created: SubtitleClip[] = []
    for (const cue of cues) {
      const start = snapTimeToFrame(Math.max(0, cue.startSec), fps)
      const end = snapTimeToFrame(Math.max(start + MIN_CLIP_DURATION_SEC, cue.endSec), fps)
      if (!(end > start)) continue
      const clip = createClip({ startTime: start, fps, presetId })
      clip.startTime = start
      clip.endTime = end
      clip.content = { title: cue.text.slice(0, 200), subtitle: '' }
      created.push(clip)
    }
    if (created.length === 0) return 0
    const next = options?.replace === true ? created : [...state.project.clips, ...created]
    set({
      project: withClips(state.project, next),
      selectedClipId: created[0]!.id,
      selectionKind: 'subtitle',
      revision: state.revision + 1
    })
    return created.length
  },

  addCaptionBatch: (rows, options) => {
    const state = get()
    const fps = state.project.fps
    const presetId = options?.presetId ?? DEFAULT_PRESET_ID
    // 缺省接在现有字幕末尾（不与已有条目重叠；用户也可以显式给 startSec）
    const existingEnd = state.project.clips.reduce((acc, clip) => Math.max(acc, clip.endTime), 0)
    const plan = planCaptionClips(rows as CaptionRow[], {
      fps,
      startSec: options?.startSec ?? existingEnd,
      ...(options?.defaultDurationSec !== undefined ? { defaultDurationSec: options.defaultDurationSec } : {}),
      ...(options?.gapSec !== undefined ? { gapSec: options.gapSec } : {})
    })
    const created: SubtitleClip[] = plan.map((item) => {
      const clip = createClip({ startTime: item.startTime, fps, presetId })
      clip.startTime = item.startTime
      clip.endTime = item.endTime
      clip.content = { title: item.title, subtitle: item.subtitle }
      return clip
    })
    if (created.length === 0) return 0
    set({
      project: withClips(state.project, [...state.project.clips, ...created]),
      selectedClipId: created[0]!.id,
      selectionKind: 'subtitle',
      revision: state.revision + 1
    })
    return created.length
  },

  // ---------------------------------------------------------------- M11-I 字幕批量编辑（列表多选）

  applyPresetToClips: (ids, presetId) => {
    const state = get()
    // 合法值为空时不动：越界/未知预设 id（手改 JSON、旧版本留下的值）一律拒收
    if (!(PRESET_IDS as readonly string[]).includes(presetId)) return 0
    const wanted = new Set(ids)
    if (wanted.size === 0) return 0
    const preset = getPreset(presetId)
    let changed = 0
    const clips = state.project.clips.map((clip) => {
      if (!wanted.has(clip.id)) return clip
      // 与单条 updateClip(presetId) 完全同义：即时应用预设并清掉自定义，文字与入出点不动
      const next = clipWithPresetDefaults(clip, preset)
      if (clipSnapshotOf(next) === clipSnapshotOf(clip)) return clip
      changed += 1
      return next
    })
    if (changed === 0) return 0
    set({ project: withClips(state.project, clips), revision: state.revision + 1 })
    return changed
  },

  setClipsDuration: (ids, durationSec) => {
    const state = get()
    const fps = state.project.fps
    // 合法值为空时不动：非有限值 / 非正 / 吸附后仍不足最短时长都拒收
    if (!Number.isFinite(durationSec) || durationSec <= 0) return 0
    const requested = snapTimeToFrame(durationSec, fps)
    if (requested < MIN_CLIP_DURATION_SEC - 1e-9) return 0
    const wanted = new Set(ids)
    if (wanted.size === 0) return 0
    let changed = 0
    const clips = state.project.clips.map((clip) => {
      if (!wanted.has(clip.id)) return clip
      // 入点不动，只把出点顺延到统一时长；右侧邻居的起点是硬边界（字幕条不允许重叠）
      const gap = gapAround(
        subtitleSpan(clip),
        state.project.clips.filter((other) => other.id !== clip.id).map(subtitleSpan)
      )
      // 空档本身就放不下最短时长（历史重叠数据）：不动它，免得把条子撑到邻居身上
      if (gap.endSec < clip.startTime + MIN_CLIP_DURATION_SEC - 1e-9) return clip
      const desiredEnd = snapTimeToFrame(clip.startTime + requested, fps)
      const endTime = snapTimeToFrame(
        clampTrimEnd(desiredEnd, clip.startTime + MIN_CLIP_DURATION_SEC, gap.endSec),
        fps
      )
      if (endTime - clip.startTime < MIN_CLIP_DURATION_SEC - 1e-9) return clip
      if (Math.abs(endTime - clip.endTime) < 1e-9) return clip
      changed += 1
      return { ...clip, endTime }
    })
    if (changed === 0) return 0
    set({ project: withClips(state.project, clips), revision: state.revision + 1 })
    return changed
  },

  removeClips: (ids) => {
    const state = get()
    const wanted = new Set(ids)
    if (wanted.size === 0) return 0
    const clips = state.project.clips.filter((clip) => !wanted.has(clip.id))
    const removed = state.project.clips.length - clips.length
    if (removed === 0) return 0
    // 删掉的正是当前选中条目 → 选中态挪到剩余第一条，绝不留下指向已删片段的选中 id
    const selectedRemoved = state.selectedClipId !== null && wanted.has(state.selectedClipId)
    set({
      project: withClips(state.project, clips),
      ...(selectedRemoved ? { selectedClipId: clips[0]?.id ?? null } : {}),
      revision: state.revision + 1
    })
    return removed
  },

  setClipsCompact: (ids, compact) => {
    const state = get()
    const wanted = new Set(ids)
    if (wanted.size === 0) return 0
    let changed = 0
    const clips = state.project.clips.map((clip) => {
      if (!wanted.has(clip.id)) return clip
      if ((clip.styleOverrides.compact === true) === compact) return clip
      const styleOverrides: StyleOverrides = { ...clip.styleOverrides }
      // 关掉 = 删键（与 mergeOverrides 同一洁净度：不留「看似自定义」的 false）
      if (compact) styleOverrides.compact = true
      else delete styleOverrides.compact
      changed += 1
      return { ...clip, styleOverrides }
    })
    if (changed === 0) return 0
    set({ project: withClips(state.project, clips), revision: state.revision + 1 })
    return changed
  },

  setClipsGradientEnabled: (ids, enabled) => {
    const state = get()
    const wanted = new Set(ids)
    if (wanted.size === 0) return 0
    let changed = 0
    const clips = state.project.clips.map((clip) => {
      if (!wanted.has(clip.id)) return clip
      const currentTitle = clip.styleOverrides.titleGradient
      const currentSubtitle = clip.styleOverrides.subtitleGradient
      // 开：沿用已有颜色（从没有过渐变才用统一双色）；关：只翻 enabled，颜色留着下次开不用重配
      const nextTitle = enabled
        ? { ...(currentTitle ?? BATCH_GRADIENT_DEFAULTS), enabled: true }
        : currentTitle
          ? { ...currentTitle, enabled: false }
          : undefined
      const nextSubtitle = enabled
        ? { ...(currentSubtitle ?? BATCH_GRADIENT_DEFAULTS), enabled: true }
        : currentSubtitle
          ? { ...currentSubtitle, enabled: false }
          : undefined
      if (
        JSON.stringify(nextTitle) === JSON.stringify(currentTitle) &&
        JSON.stringify(nextSubtitle) === JSON.stringify(currentSubtitle)
      ) {
        return clip
      }
      const styleOverrides: StyleOverrides = { ...clip.styleOverrides }
      if (nextTitle) styleOverrides.titleGradient = nextTitle
      if (nextSubtitle) styleOverrides.subtitleGradient = nextSubtitle
      changed += 1
      return { ...clip, styleOverrides }
    })
    if (changed === 0) return 0
    set({ project: withClips(state.project, clips), revision: state.revision + 1 })
    return changed
  },

  // ---------------------------------------------------------------- M7 文本元素
  addTextClip: (input) => {
    const state = get()
    const fps = state.project.fps
    const clip = createTextElementClip({
      startTime: input?.at ?? 0,
      fps,
      ...(input?.presetId ? { presetId: input.presetId } : {}),
      ...(input?.text ? { text: input.text } : {}),
      ...(input?.durationSec ? { durationSec: input.durationSec } : {})
    })
    const textClips = withTextClips(state.project, [...(state.project.textClips ?? []), clip])
    set({
      project: textClips,
      selectedTextClipId: clip.id,
      selectionKind: 'text',
      revision: state.revision + 1
    })
    return clip
  },

  updateTextClip: (id, patch) => {
    const state = get()
    const current = (state.project.textClips ?? []).find((clip) => clip.id === id)
    if (!current) return
    // 与字幕条同一口径：整份候选 → normalize（夹取/去非法），再比较决定是否产生撤销步
    const candidate = { ...current, ...patch }
    const normalized = normalizeTextElementClip(candidate, state.project.fps)
    if (!normalized) return
    const before = JSON.stringify(current)
    const after = JSON.stringify(normalized)
    if (before === after) return
    const project = withTextClips(
      state.project,
      (state.project.textClips ?? []).map((clip) => (clip.id === id ? normalized : clip))
    )
    set({ project, revision: state.revision + 1 })
  },

  removeTextClip: (id) => {
    const state = get()
    const textClips = (state.project.textClips ?? []).filter((clip) => clip.id !== id)
    if (textClips.length === (state.project.textClips ?? []).length) return
    const next: Project = { ...state.project }
    if (textClips.length > 0) next.textClips = textClips
    else delete next.textClips
    const removedSelected = state.selectedTextClipId === id
    set({
      project: next,
      ...(removedSelected
        ? {
            selectedTextClipId: textClips[0]?.id ?? null,
            ...(textClips.length === 0 && state.selectionKind === 'text' ? { selectionKind: 'subtitle' as const } : {})
          }
        : {}),
      revision: state.revision + 1
    })
  },

  selectTextClip: (id) =>
    set({
      selectedTextClipId: id,
      ...(id ? { selectionKind: 'text' as const } : {})
    }),

  // ---------------------------------------------------------------- v2 素材池

  addMedia: (item) => {
    const state = get()
    // 同路径复用：重复导入同一文件不产生第二枚卡片，也不断开既有片段的引用
    const existing = state.project.media.find((m) => m.path === item.path)
    if (existing) {
      set({
        project: {
          ...state.project,
          media: state.project.media.map((m) => (m.id === existing.id ? { ...m, ...item, id: existing.id } : m))
        },
        revision: state.revision + 1
      })
      return existing.id
    }
    const media: MediaItem = normalizeImportedMedia({ ...item, id: item.id ?? createId('media') })
    set({ project: { ...state.project, media: [...state.project.media, media] }, revision: state.revision + 1 })
    return media.id
  },

  removeMedia: (mediaId, options) => {
    const state = get()
    const removeClips = options?.removeClips !== false
    const media = state.project.media.filter((m) => m.id !== mediaId)
    const removedClipIds = new Set(
      state.project.mediaClips.filter((c) => c.mediaId === mediaId).map((c) => c.id)
    )
    const mediaClips = removeClips
      ? state.project.mediaClips.filter((c) => c.mediaId !== mediaId)
      : state.project.mediaClips
    const selectedMediaClipId =
      !removeClips || !state.project.mediaClips.some((c) => c.id === state.selectedMediaClipId && c.mediaId === mediaId)
        ? state.selectedMediaClipId
        : (mediaClips[0]?.id ?? null)
    const nextProject = withMediaClips({ ...state.project, media }, mediaClips)
    const removedSelectedTransition =
      removeClips && state.selectedTransitionClipId !== null && removedClipIds.has(state.selectedTransitionClipId)
    set({
      // removeClips=false 是「重新定位」的临时态：片段还在但素材暂时不在池里，
      // 此时不做手柄清理，避免把有效转场误删。
      project: removeClips ? cleanupInvalidTransitions(nextProject, state.project.fps) : nextProject,
      selectedMediaClipId,
      ...(removedSelectedTransition
        ? {
            selectedTransitionClipId: null,
            ...(state.selectionKind === 'transition'
              ? { selectionKind: (selectedMediaClipId === null ? 'subtitle' : 'media') as SelectionKind }
              : {})
          }
        : {}),
      revision: state.revision + 1
    })
  },

  relocateMedia: (mediaId, patch) => {
    const state = get()
    const media = state.project.media.map((m) => (m.id === mediaId ? { ...m, ...patch } : m))
    set({ project: { ...state.project, media }, revision: state.revision + 1 })
  },

  renameMedia: (mediaId, name) => {
    const state = get()
    const trimmed = name.trim()
    if (trimmed.length === 0) return
    const media = state.project.media.map((m) => (m.id === mediaId ? { ...m, name: trimmed } : m))
    set({ project: { ...state.project, media }, revision: state.revision + 1 })
  },

  setMediaCompactMode: (mediaId, mode) => {
    const state = get()
    const media = state.project.media.map((m) => (m.id === mediaId ? { ...m, compactMode: mode } : m))
    set({ project: { ...state.project, media }, revision: state.revision + 1 })
  },

  setMediaVfrPolicy: (mediaId, policy) => {
    const state = get()
    const media = state.project.media.map((m) => (m.id === mediaId ? { ...m, vfrPolicy: policy } : m))
    set({ project: { ...state.project, media }, revision: state.revision + 1 })
  },

  ackMediaNon169: (mediaId, value) => {
    const state = get()
    const media = state.project.media.map((m) => (m.id === mediaId ? { ...m, non169Ack: value } : m))
    set({ project: { ...state.project, media }, revision: state.revision + 1 })
  },

  ackMediaHdr: (mediaId, value) => {
    const state = get()
    const media = state.project.media.map((m) => (m.id === mediaId ? { ...m, hdrAck: value } : m))
    set({ project: { ...state.project, media }, revision: state.revision + 1 })
  },

  setMediaThumb: (mediaId, thumbnailUrl) => {
    const state = get()
    const media = state.project.media.map((m) => (m.id === mediaId ? { ...m, thumbnailUrl } : m))
    set({ project: { ...state.project, media }, revision: state.revision + 1 })
  },

  // ---------------------------------------------------------------- v10 素材分组与标签

  addMediaBin: (name) => {
    const state = get()
    const trimmed = normalizeBinName(name)
    if (trimmed.length === 0) return null
    const bins = state.project.mediaBins ?? []
    if (bins.length >= MEDIA_BIN_MAX_COUNT) return null
    const bin: MediaBin = { id: createId('bin'), name: trimmed }
    set({
      project: { ...state.project, mediaBins: [...bins, bin] },
      revision: state.revision + 1
    })
    return bin.id
  },

  renameMediaBin: (id, name) => {
    const state = get()
    const bins = state.project.mediaBins ?? []
    if (!bins.some((bin) => bin.id === id)) return
    const trimmed = normalizeBinName(name)
    if (trimmed.length === 0) return
    const mediaBins = bins.map((bin) => (bin.id === id ? { ...bin, name: trimmed } : bin))
    set({ project: { ...state.project, mediaBins }, revision: state.revision + 1 })
  },

  removeMediaBin: (id) => {
    const state = get()
    const bins = state.project.mediaBins ?? []
    if (!bins.some((bin) => bin.id === id)) return
    const mediaBins = bins.filter((bin) => bin.id !== id)
    // 只清归属，不删素材也不动时间轴片段：分组是轻量组织，不是引用关系
    const media = state.project.media.map((item) => {
      if (item.binId !== id) return item
      const next: MediaItem = { ...item }
      delete next.binId
      return next
    })
    const project: Project = { ...state.project, media }
    if (mediaBins.length > 0) project.mediaBins = mediaBins
    else delete project.mediaBins
    set({ project, revision: state.revision + 1 })
  },

  assignMediaBin: (mediaId, binId) => {
    const state = get()
    const item = state.project.media.find((m) => m.id === mediaId)
    if (!item) return
    // 非法分组（手改 JSON / 已被删）：忽略而不是写入悬空引用
    if (binId && !(state.project.mediaBins ?? []).some((bin) => bin.id === binId)) return
    const current = item.binId ?? null
    const target = binId ?? null
    if (current === target) return
    const media = state.project.media.map((m) => {
      if (m.id !== mediaId) return m
      const next: MediaItem = { ...m }
      if (target) next.binId = target
      else delete next.binId
      return next
    })
    set({ project: { ...state.project, media }, revision: state.revision + 1 })
  },

  setMediaTags: (mediaId, tags) => {
    const state = get()
    const item = state.project.media.find((m) => m.id === mediaId)
    if (!item) return
    // 与读盘同一套归一：trim / 丢空 / 精确去重 / 单条限长 / 上限 12 个
    const normalized = normalizeMediaTags(tags)
    const current = item.tags ?? []
    if (JSON.stringify(current) === JSON.stringify(normalized ?? [])) return
    const media = state.project.media.map((m) => {
      if (m.id !== mediaId) return m
      const next: MediaItem = { ...m }
      if (normalized) next.tags = normalized
      else delete next.tags
      return next
    })
    set({ project: { ...state.project, media }, revision: state.revision + 1 })
  },

  // ---------------------------------------------------------------- 水印

  setWatermark: (settings) => {
    const state = get()
    if (!settings) {
      // 移除 = 字段整个消失（而不是留一个 enabled:false 的空壳）：
      // 未导入水印的工程保持原有序列化形态，自动存档不会回洗出无意义字段
      const next: Project = { ...state.project }
      delete next.watermark
      set({ project: next, revision: state.revision + 1 })
      return
    }
    set({ project: { ...state.project, watermark: settings }, revision: state.revision + 1 })
  },

  setWatermarkEnabled: (enabled) => {
    const state = get()
    const current = state.project.watermark
    if (!current || current.enabled === enabled) return
    set({ project: { ...state.project, watermark: { ...current, enabled } }, revision: state.revision + 1 })
  },

  // ---------------------------------------------------------------- v2 媒体轨

  selectMediaClip: (id) =>
    set({
      selectedMediaClipId: id,
      selectedTransitionClipId: null,
      ...(id ? { selectionKind: 'media' as const } : {})
    }),

  insertMediaClip: (input) => {
    const state = get()
    const fps = state.project.fps
    const item = state.project.media.find((m) => m.id === input.mediaId)
    if (!item) return null
    let start = snapTimeToFrame(Math.max(0, input.timelineStartSec), fps)
    const durationSec = Math.max(MIN_MEDIA_CLIP_SEC, input.durationSec ?? item.meta.durationSec)
    // 源入点后钳到最短时长，再向源尾部收：不足最短时长的落点拒收而不是静默截断
    const sourceIn = snapTimeToFrame(Math.max(0, input.sourceInSec ?? 0), fps)
    const sourceOut = snapTimeToFrame(Math.min(item.meta.durationSec, sourceIn + durationSec), fps)
    if (sourceOut - sourceIn < MIN_MEDIA_CLIP_SEC) return null
    // 新建段一律 1x（无 speed 键），所以 `(sourceOut - sourceIn) / 1` 与旧写法逐字节一致
    let end = snapTimeToFrame(start + (sourceOut - sourceIn), fps)
    if (end - start < MIN_MEDIA_CLIP_SEC) end = snapTimeToFrame(start + MIN_MEDIA_CLIP_SEC, fps)
    // v3：落点轨道（选中轨优先；轨道锁定则拒收）
    const trackId = pickMediaTrackId(state.project, input.trackId ?? state.selectedTrackId)
    if (isTrackLocked(trackById(state.project.mediaTracks, trackId))) return null
    // 落点被占：顺延到同一轨道后面的第一个空档（只选位置，不推动已有段）；一直放不下就拒收
    const length = end - start
    const placed = firstFreeStart(
      start,
      length,
      state.project.mediaClips
        .filter((other) => other.trackId === trackId)
        .map((other) => ({ startSec: other.timelineStartSec, endSec: other.timelineEndSec })),
      MAX_TRACK_SEC
    )
    if (placed === null) return null
    if (placed !== start) {
      start = placed
      end = snapTimeToFrame(start + length, fps)
    }
    const clip = makeMediaClip({
      mediaId: item.id,
      trackId,
      timelineStartSec: start,
      timelineEndSec: end,
      sourceInSec: sourceIn,
      sourceOutSec: sourceOut
    })
    set({
      project: cleanupInvalidTransitions(
        withMediaClips(state.project, [...state.project.mediaClips, clip]),
        fps
      ),
      selectedMediaClipId: clip.id,
      revision: state.revision + 1
    })
    return clip
  },

  moveMediaClip: (id, timelineStartSec, trackId) => {
    const state = get()
    const fps = state.project.fps
    const current = state.project.mediaClips.find((c) => c.id === id)
    if (!current) return
    if (isTrackLocked(trackById(state.project.mediaTracks, current.trackId))) return
    const targetTrackId = pickMediaTrackId(state.project, trackId ?? current.trackId)
    if (isTrackLocked(trackById(state.project.mediaTracks, targetTrackId))) return
    const length = current.timelineEndSec - current.timelineStartSec
    // 只跟**同一目标轨道**的邻居抢空间：不同轨道允许时间重叠
    const others = state.project.mediaClips.filter(
      (c) => c.id !== id && c.trackId === targetTrackId
    )
    // 跨轨落点若压住目标轨已有片段：直接拒绝（不做静默覆盖/推挤）
    const requestedStart = snapTimeToFrame(Math.max(0, timelineStartSec), fps)
    let start: number
    if (targetTrackId !== current.trackId) {
      const requestedEnd = snapTimeToFrame(requestedStart + length, fps)
      if (others.some((other) => spansOverlap(trackSpan(other), { startSec: requestedStart, endSec: requestedEnd }))) {
        return
      }
      start = requestedStart
    } else {
      const gap = gapAround(trackSpan(current), others.map(trackSpan))
      // 夹在空档里：撞到邻居就贴住，绝不推开别人（"挪不过去就卡在原地"）
      start = clampMoveToGap(requestedStart, length, gap.startSec, gap.endSec)
    }
    const moved: MediaClip = {
      ...current,
      trackId: targetTrackId,
      timelineStartSec: start,
      timelineEndSec: snapTimeToFrame(start + length, fps)
    }
    const merged = state.project.mediaClips.map((c) => (c.id === id ? moved : c))
    // 空工程/已紧贴时不动工程，避免无意义地推高 revision（会触发自动保存）
    if (
      moved.trackId === current.trackId &&
      Math.abs(moved.timelineStartSec - current.timelineStartSec) < 1e-9 &&
      Math.abs(moved.timelineEndSec - current.timelineEndSec) < 1e-9
    ) {
      return
    }
    set({
      project: cleanupInvalidTransitions(withMediaClips(state.project, merged), fps),
      selectedMediaClipId: id,
      revision: state.revision + 1
    })
  },

  trimMediaClip: (id, patch) => {
    const state = get()
    const fps = state.project.fps
    const current = state.project.mediaClips.find((c) => c.id === id)
    if (!current) return
    if (isTrackLocked(trackById(state.project.mediaTracks, current.trackId))) return
    const item = state.project.media.find((m) => m.id === current.mediaId)
    const sourceDuration = item?.meta.durationSec ?? Number.POSITIVE_INFINITY
    // v9：拖边时时间轴位移与源位移之间差一个倍速（1x 时与旧写法逐字节一致）
    const speed = speedValueOf(current.speed)
    // 同层邻居决定这段能伸到哪：撞到邻居就停，绝不挤开别人
    const gap = gapAround(
      trackSpan(current),
      state.project.mediaClips
        .filter((c) => c.id !== id && c.trackId === current.trackId)
        .map(trackSpan)
    )
    let next = { ...current }
    if (patch.timelineStartSec !== undefined) {
      const start = snapTimeToFrame(
        clampTrimStart(
          Math.max(0, patch.timelineStartSec),
          gap.startSec,
          current.timelineEndSec - MIN_MEDIA_CLIP_SEC
        ),
        fps
      )
      const delta = start - current.timelineStartSec
      const sourceIn = snapTimeToFrame(Math.max(0, Math.min(sourceDuration - MIN_MEDIA_CLIP_SEC, current.sourceInSec + delta * speed)), fps)
      const duration = current.timelineEndSec - start
      next = {
        ...next,
        timelineStartSec: start,
        sourceInSec: sourceIn,
        sourceOutSec: snapTimeToFrame(sourceIn + duration * speed, fps)
      }
    }
    if (patch.timelineEndSec !== undefined) {
      const end = snapTimeToFrame(
        clampTrimEnd(patch.timelineEndSec, next.timelineStartSec + MIN_MEDIA_CLIP_SEC, gap.endSec),
        fps
      )
      const duration = end - next.timelineStartSec
      const sourceOut = snapTimeToFrame(
        Math.min(Math.max(sourceDuration, next.sourceInSec + MIN_MEDIA_CLIP_SEC * speed), next.sourceInSec + duration * speed),
        fps
      )
      next = {
        ...next,
        timelineEndSec: snapTimeToFrame(next.timelineStartSec + (sourceOut - next.sourceInSec) / speed, fps),
        sourceOutSec: sourceOut
      }
    }
    set({
      project: cleanupInvalidTransitions(
        withMediaClips(state.project, state.project.mediaClips.map((c) => (c.id === id ? next : c))),
        fps
      ),
      revision: state.revision + 1
    })
  },

  removeMediaClip: (id) => {
    const state = get()
    const current = state.project.mediaClips.find((c) => c.id === id)
    if (!current) return
    if (isTrackLocked(trackById(state.project.mediaTracks, current.trackId))) return
    const mediaClips = state.project.mediaClips.filter((c) => c.id !== id)
    const removedSelected = state.selectedMediaClipId === id
    const removedTransition = state.selectedTransitionClipId === id
    const selectedMediaClipId = removedSelected ? (mediaClips[0]?.id ?? null) : state.selectedMediaClipId
    // v8.1：片段没了，它的防抖代理账本与磁盘缓存一起回收（fire-and-forget，不阻塞删轨）
    useStabPreviewStore.getState().clearForClip(id, true)
    set({
      project: cleanupInvalidTransitions(withMediaClips(state.project, mediaClips), state.project.fps),
      selectedMediaClipId,
      // 删掉的片段承载着当前选中的转场：选中态一起清，检查器退回字幕/视频视图
      ...(removedTransition
        ? {
            selectedTransitionClipId: null,
            ...(state.selectionKind === 'transition'
              ? { selectionKind: (selectedMediaClipId === null ? 'subtitle' : 'media') as SelectionKind }
              : {})
          }
        : {}),
      // 删掉了正在编辑的那条且再无媒体段：检查器退回字幕编辑器，不留一个空视频面板
      ...(removedSelected && selectedMediaClipId === null ? { selectionKind: 'subtitle' as const } : {}),
      revision: state.revision + 1
    })
  },

  // ---------------------------------------------------------------- M5 剪辑操作
  rippleDeleteMediaClip: (id) => {
    const state = get()
    const current = state.project.mediaClips.find((c) => c.id === id)
    if (!current) return false
    if (isTrackLocked(trackById(state.project.mediaTracks, current.trackId))) return false
    const result = applyRippleDelete(state.project.mediaClips, id, state.project.fps)
    if (!result) return false
    const removedSelected = state.selectedMediaClipId === id
    const removedTransition = state.selectedTransitionClipId === id
    // 选中态交还给同轨最靠前的剩余片段（没有就退到任意片段，再没有才空）
    const selectedMediaClipId = removedSelected
      ? (result.clips.find((clip) => clip.trackId === current.trackId)?.id ?? result.clips[0]?.id ?? null)
      : state.selectedMediaClipId
    useStabPreviewStore.getState().clearForClip(id, true)
    set({
      project: cleanupInvalidTransitions(withMediaClips(state.project, result.clips), state.project.fps),
      selectedMediaClipId,
      ...(removedTransition
        ? {
            selectedTransitionClipId: null,
            ...(state.selectionKind === 'transition'
              ? { selectionKind: (selectedMediaClipId === null ? 'subtitle' : 'media') as SelectionKind }
              : {})
          }
        : {}),
      ...(removedSelected && selectedMediaClipId === null ? { selectionKind: 'subtitle' as const } : {}),
      revision: state.revision + 1
    })
    return true
  },

  mergeMediaClipWithNext: (id) => {
    const state = get()
    const first = state.project.mediaClips.find((c) => c.id === id)
    if (!first) return false
    if (isTrackLocked(trackById(state.project.mediaTracks, first.trackId))) return false
    const next = nextMediaClipOnTrack(state.project.mediaClips, id)
    if (!next) return false
    const result = mergeMediaClips(state.project.mediaClips, id, next.id, state.project.fps)
    if (!result) return false
    // 被抹掉的内部切点可能正承载着选中的转场：一并清掉，检查器回到片段本身
    const removedTransition = state.selectedTransitionClipId === next.id
    useStabPreviewStore.getState().clearForClip(next.id, true)
    set({
      project: cleanupInvalidTransitions(withMediaClips(state.project, result.clips), state.project.fps),
      selectedMediaClipId: result.merged.id,
      ...(removedTransition ? { selectedTransitionClipId: null } : {}),
      selectionKind: 'media',
      revision: state.revision + 1
    })
    return true
  },

  freezeFrameAt: async (atSec, options) => {
    const state = get()
    const fps = state.project.fps
    const at = snapTimeToFrame(Math.max(0, atSec ?? 0), fps)
    const project = state.project
    // 目标片段：显式指定优先，否则取播放头处「最上层可见媒体轨」上的那一段
    const target =
      (options?.clipId ? project.mediaClips.find((clip) => clip.id === options.clipId) : undefined) ??
      topMediaClipAt(project, at)
    if (!target) return null
    if (isTrackLocked(trackById(project.mediaTracks, target.trackId))) return null
    const item = project.media.find((media) => media.id === target.mediaId)
    if (!item) return null
    // 切点必须在段内且两侧都留得下最短时长（与拆分同一口径）
    if (at <= target.timelineStartSec + MIN_MEDIA_CLIP_SEC - 1e-9) return null
    if (at >= target.timelineEndSec - MIN_MEDIA_CLIP_SEC + 1e-9) return null
    const sourceSec = sourceTimeAt(target, at)
    const durationSec = Math.max(MIN_MEDIA_CLIP_SEC, options?.durationSec ?? FREEZE_FRAME_DEFAULT_SEC)

    // 主进程抽帧（不可用时给 null：不抛错，UI 提示即可）
    const extract = window.socut?.media?.extractFrame
    if (typeof extract !== 'function') return null
    const extracted = await extract({
      path: item.path,
      atSec: sourceSec,
      key: item.id,
      width: item.meta.width,
      height: item.meta.height
    })
    if (!extracted?.path) return null

    // 抽出来的 PNG 按普通 image 素材入池：导出侧走 `-loop 1`，与用户导入的图片同一口径
    const freezeMediaId = get().addMedia({
      path: extracted.path,
      name: `${item.name.replace(/\.[^.]+$/, '')} 冻结帧`,
      kind: 'image',
      meta: {
        ...item.meta,
        path: extracted.path,
        containerName: 'png',
        videoCodec: 'png',
        audioCodec: null,
        audioChannels: null,
        pixFmt: 'rgba',
        width: extracted.width > 0 ? extracted.width : item.meta.width,
        height: extracted.height > 0 ? extracted.height : item.meta.height,
        durationSec: Math.max(IMAGE_STILL_SEC, durationSec + 1)
      },
      non169Ack: item.non169Ack,
      hdrAck: item.hdrAck,
      vfrPolicy: 'none',
      compactMode: item.compactMode,
      thumbnailUrl: '',
      importedAt: new Date().toISOString()
    })

    const current = get()
    const plan = planFreezeFrame({
      clips: current.project.mediaClips,
      clipId: target.id,
      atSec: at,
      fps,
      freezeMediaId,
      durationSec,
      newClipId: createId('mclip'),
      newRightId: createId('mclip')
    })
    if (!plan) return null
    set({
      project: cleanupInvalidTransitions(withMediaClips(current.project, plan.clips), fps),
      selectedMediaClipId: plan.freezeClip.id,
      selectedTransitionClipId: null,
      selectionKind: 'media',
      revision: current.revision + 1
    })
    return plan.freezeClip.id
  },

  // ---------------------------------------------------------------- v4 多序列
  addSequence: (name) => {
    const state = get()
    const added = addSequenceToProject(state.project, name)
    if (!added) return null
    set({ project: added.project, revision: state.revision + 1 })
    return added.id
  },

  removeSequence: (id) => {
    const state = get()
    const wasActive = id === (state.project.activeSequenceId ?? DEFAULT_SEQUENCE_ID)
    const next = removeSequenceFromProject(state.project, id)
    if (!next || next === state.project) return false
    set({
      project: next,
      // 删的是活动序列 → 已切到别的序列，选中态必须清空
      ...(wasActive ? CLEARED_SELECTION : {}),
      revision: state.revision + 1
    })
    return true
  },

  renameSequence: (id, name) => {
    const state = get()
    const next = renameSequenceInProject(state.project, id, name)
    if (next === state.project) return false
    set({ project: next, revision: state.revision + 1 })
    return true
  },

  selectSequence: (id) => {
    const state = get()
    const next = switchSequenceInProject(state.project, id)
    if (!next || next === state.project) return false
    set({
      project: next,
      ...CLEARED_SELECTION,
      revision: state.revision + 1
    })
    return true
  },

  duplicateSequence: (id, name) => {
    const state = get()
    const added = duplicateSequenceInProject(state.project, id, name)
    if (!added) return null
    set({ project: added.project, revision: state.revision + 1 })
    return added.id
  },

  splitTargetAt: (atSec) => {
    const state = get()
    const fps = state.project.fps
    const target = resolveTargetAt(tracksOf(state.project), selectionOf(state), atSec)
    if (!target) return null

    if (target.kind === 'subtitle') {
      if (state.project.subtitleTrack.locked) return null
      const clip = state.project.clips.find((item) => item.id === target.id)
      if (!clip) return null
      const result = splitSubtitleClipAt(clip, atSec, fps, () => createId('clip'))
      if (!result) return null
      // M6：关键帧的 t 是"片段内进度"，切点之后不该继承前半段的曲线（与转场同一纪律：内部切点不继承）
      const right: SubtitleClip = { ...result.right }
      delete right.keyframes
      const clips = state.project.clips.filter((item) => item.id !== clip.id).concat(result.left, right)
      set({
        project: withClips(state.project, clips),
        selectedClipId: result.right.id,
        selectionKind: 'subtitle',
        revision: state.revision + 1
      })
      return result.right.id
    }

    if (target.kind === 'audio') {
      const clip = (state.project.audioClips ?? []).find((item) => item.id === target.id)
      if (!clip) return null
      if (isTrackLocked(trackById(state.project.audioTracks, clip.trackId))) return null
      const result = splitAudioClipAt(clip, atSec, fps, () => createId('aclip'))
      if (!result) return null
      const audioClips = (state.project.audioClips ?? []).filter((item) => item.id !== clip.id).concat(result.left, result.right)
      set({
        project: withAudioClips(state.project, audioClips),
        selectedAudioClipId: result.right.id,
        selectionKind: 'audio',
        revision: state.revision + 1
      })
      return result.right.id
    }

    const clip = state.project.mediaClips.find((item) => item.id === target.id)
    if (!clip) return null
    if (isTrackLocked(trackById(state.project.mediaTracks, clip.trackId))) return null
    const result = splitMediaClipAt(clip, atSec, fps, () => createId('mclip'))
    if (!result) return null
    // 转场属于「切点」而不是素材：左半保留原入场转场，右半是新的切点，不继承。
    const right: MediaClip = { ...result.right }
    delete right.transitionIn
    const mediaClips = state.project.mediaClips.filter((item) => item.id !== clip.id).concat(result.left, right)
    set({
      project: cleanupInvalidTransitions(withMediaClips(state.project, mediaClips), fps),
      selectedMediaClipId: result.right.id,
      // 拆完直接编辑右半段，检查器跟着切到视频视图
      selectionKind: 'media',
      revision: state.revision + 1
    })
    return result.right.id
  },

  removeTargetAt: (atSec) => {
    const state = get()
    const target = resolveTargetAt(tracksOf(state.project), selectionOf(state), atSec)
    if (!target) return false
    removeTargetRef(state, target)
    return true
  },

  removeSelected: () => {
    const state = get()
    // M7：文本元素选中时 Delete 只删文本元素
    if (state.selectionKind === 'text' && state.selectedTextClipId !== null) {
      state.removeTextClip(state.selectedTextClipId)
      return true
    }
    // v11：转场选中优先——Delete/退格键在「缝隙图标高亮」时删的是转场，不是右侧片段
    if (state.selectionKind === 'transition' && state.selectedTransitionClipId !== null) {
      const clip = state.project.mediaClips.find((item) => item.id === state.selectedTransitionClipId)
      if (clip?.transitionIn) {
        const removed = state.setMediaClipTransition(clip.id, null)
        // 删除后把检查器交还给该片段，用户接着能看到片段参数而不是空面板
        set({
          selectedTransitionClipId: null,
          selectedMediaClipId: clip.id,
          selectionKind: 'media'
        })
        return removed
      }
    }
    const target = findSelectedRef(tracksOf(state.project), selectionOf(state))
    if (!target) return false
    removeTargetRef(state, target)
    return true
  },

  // ---------------------------------------------------------------- v6 画面编辑

  /**
   * M6-E：媒体段关键帧（与字幕条同一套归一/去重口径）。
   * 值相同不产生撤销步；全空/全非法 → 整键删除。
   */
  setMediaClipKeyframes: (id, keyframes) => {
    const state = get()
    const current = state.project.mediaClips.find((clip) => clip.id === id)
    if (!current) return
    const normalized = normalizeKeyframeTracks(keyframes)
    const before = JSON.stringify(current.keyframes ?? null)
    const after = JSON.stringify(normalized ?? null)
    if (before === after) return
    const next: MediaClip = { ...current }
    if (normalized) next.keyframes = normalized
    else delete next.keyframes
    const mediaClips = state.project.mediaClips.map((clip) => (clip.id === id ? next : clip))
    set({ project: withMediaClips(state.project, mediaClips), revision: state.revision + 1 })
  },

  /**
   * M8：媒体段手绘遮罩（同一套归一/去重口径）。
   * 同值（JSON 逐字节相同）不产生撤销步；空遮罩 → 整键删除。
   */
  setMediaClipMask: (id, mask) => {
    const state = get()
    const current = state.project.mediaClips.find((clip) => clip.id === id)
    if (!current) return
    const normalized = normalizeMediaClipMask(mask ?? undefined)
    const before = JSON.stringify(current.mask ?? null)
    const after = JSON.stringify(normalized ?? null)
    if (before === after) return
    const next: MediaClip = { ...current }
    if (normalized) next.mask = normalized
    else delete next.mask
    const mediaClips = state.project.mediaClips.map((clip) => (clip.id === id ? next : clip))
    set({ project: withMediaClips(state.project, mediaClips), revision: state.revision + 1 })
  },

  /**
   * M8-P0：外部 matte（与 setMediaClipMask 同口径）。
   * 只接受归一化后的 `{ path, kind }`：path 为空 = 移除；同值（两键 JSON 相同）不产生撤销步。
   */
  setMediaClipMatte: (id, matte) => {
    const state = get()
    const current = state.project.mediaClips.find((clip) => clip.id === id)
    if (!current) return
    const pathValue = typeof matte?.path === 'string' ? matte.path.trim() : ''
    const kind = matte?.kind === 'image' || matte?.kind === 'video' ? matte.kind : undefined
    const next: MediaClip = { ...current }
    if (pathValue.length > 0 && kind) {
      next.mattePath = pathValue
      next.matteKind = kind
    } else {
      delete next.mattePath
      delete next.matteKind
    }
    const before = JSON.stringify([current.mattePath ?? null, current.matteKind ?? null])
    const after = JSON.stringify([next.mattePath ?? null, next.matteKind ?? null])
    if (before === after) return
    const mediaClips = state.project.mediaClips.map((clip) => (clip.id === id ? next : clip))
    set({ project: withMediaClips(state.project, mediaClips), revision: state.revision + 1 })
  },

  updateMediaClipVideo: (id, patch) => {
    const state = get()
    const mediaClips = state.project.mediaClips.map((clip) => {
      if (clip.id !== id) return clip
      // 增量合并到「当前值（缺省 = 默认值）」上，再交给纯函数夹心/剔除默认值
      const current = clip.video ?? defaultMediaVideo()
      const merged: MediaClipVideo = {
        ...current,
        ...patch,
        curves: patch.curves ?? { ...current.curves }
      }
      const normalized = normalizeMediaVideo(merged)
      const next: MediaClip = { ...clip }
      if (normalized) next.video = normalized
      else delete next.video
      return next
    })
    set({ project: withMediaClips(state.project, mediaClips), revision: state.revision + 1 })
  },

  resetMediaClipVideo: (id) => {
    const state = get()
    const mediaClips = state.project.mediaClips.map((clip) => {
      if (clip.id !== id) return clip
      const next: MediaClip = { ...clip }
      delete next.video
      // 「恢复默认」现在覆盖画面关键帧（滑条上的动画也一并清掉）
      delete next.keyframes
      // v8：「恢复默认」语义覆盖防抖（画面与稳定都回到不做任何处理）
      delete next.stab
      // v9：音频与变速也是“这一条的处理”，一并回到默认（时间轴长度回到源窗口长度）
      delete next.audio
      delete next.speed
      next.timelineEndSec = snapTimeToFrame(
        next.timelineStartSec + Math.max(MIN_MEDIA_CLIP_SEC, clip.sourceOutSec - clip.sourceInSec),
        state.project.fps
      )
      return next
    })
    set({ project: withMediaClips(state.project, mediaClips), revision: state.revision + 1 })
  },

  // ---------------------------------------------------------------- v8 防抖

  updateMediaClipStab: (id, patch) => {
    const state = get()
    const mediaClips = state.project.mediaClips.map((clip) => {
      if (clip.id !== id) return clip
      // 与 updateMediaClipVideo 同一套纪律：增量合并 → 纯函数归一 → 全默认整键删除
      const current = clip.stab ?? defaultMediaStab()
      const normalized = normalizeMediaStab({ ...current, ...patch })
      const next: MediaClip = { ...clip }
      if (normalized) next.stab = normalized
      else delete next.stab
      return next
    })
    set({ project: withMediaClips(state.project, mediaClips), revision: state.revision + 1 })
  },

  // ---------------------------------------------------------------- v10 转场

  selectTransition: (id) => {
    if (id === null) {
      set({ selectedTransitionClipId: null })
      return
    }
    const clip = get().project.mediaClips.find((item) => item.id === id)
    // 只有真的挂着转场才切过去，避免右键/拖拽落点误触后检查器出现空面板
    if (!clip?.transitionIn) return
    set({
      selectedTransitionClipId: id,
      selectedMediaClipId: id,
      selectionKind: 'transition'
    })
  },

  setMediaClipTransition: (id, transition) => {
    const state = get()
    const fps = state.project.fps
    const clip = state.project.mediaClips.find((item) => item.id === id)
    if (!clip) return false
    // 锁定轨道：只读，不允许增删转场（与片段拖拽/修剪同一规则）
    if (isTrackLocked(trackById(state.project.mediaTracks, clip.trackId))) return false

    if (transition === null) {
      if (!clip.transitionIn) return false
      const mediaClips = state.project.mediaClips.map((item) => {
        if (item.id !== id) return item
        const next: MediaClip = { ...item }
        delete next.transitionIn
        return next
      })
      set({
        project: withMediaClips(state.project, mediaClips),
        // 删掉的正是当前选中的转场：选中态一并清掉，免得检查器停在空气上
        ...(state.selectedTransitionClipId === id ? { selectedTransitionClipId: null } : {}),
        revision: state.revision + 1
      })
      return true
    }

    // 类型 / 时长合法性统一走 schema 归一（与读盘时同一口径），无效数据直接丢弃
    const normalized = normalizeTransition(transition, fps)
    if (!normalized) return false

    const prev = previousMediaClipOnTrack(state.project.mediaClips, clip)
    const resolution = resolveTransitionDuration({
      prev,
      clip,
      prevMeta: transitionMediaMetaOf(state.project, prev),
      clipMeta: transitionMediaMetaOf(state.project, clip),
      requestedSec: normalized.durationSec,
      fps
    })
    // 首段 / 有空隙 / 手柄不足：不写入无效数据（拖拽面板给原因）
    if (!resolution.ok) return false

    const nextTransition: MediaClipTransition = {
      type: normalized.type,
      durationSec: resolution.durationSec
    }
    if (
      clip.transitionIn?.type === nextTransition.type &&
      Math.abs(clip.transitionIn.durationSec - nextTransition.durationSec) < 1e-9
    ) {
      return true
    }
    const mediaClips = state.project.mediaClips.map((item) =>
      item.id === id ? { ...item, transitionIn: nextTransition } : item
    )
    // 同一升/降级里的相邻转场可能占用同一片段的头/尾，交给统一清理夹到半段
    set({
      project: cleanupInvalidTransitions(withMediaClips(state.project, mediaClips), fps),
      revision: state.revision + 1
    })
    return true
  },

  // ---------------------------------------------------------------- v9 音频与变速

  updateMediaClipAudio: (id, patch) => {
    const state = get()
    const mediaClips = state.project.mediaClips.map((clip) => {
      if (clip.id !== id) return clip
      const current = clip.audio ?? defaultClipAudio()
      const normalized = normalizeClipAudio({ ...current, ...patch })
      const next: MediaClip = { ...clip }
      if (normalized) next.audio = normalized
      else delete next.audio
      return next
    })
    set({ project: withMediaClips(state.project, mediaClips), revision: state.revision + 1 })
  },

  updateMediaClipSpeed: (id, patch) => {
    const state = get()
    const fps = state.project.fps
    const mediaClips = state.project.mediaClips.map((clip) => {
      if (clip.id !== id) return clip
      const current = clip.speed ?? defaultClipSpeed()
      const normalized = normalizeClipSpeed({ ...current, ...patch })
      const next: MediaClip = { ...clip }
      if (normalized) next.speed = normalized
      else delete next.speed
      // 源窗口不动，时间轴出点跟着倍速伸缩（1x 时就是源窗口长度，与旧恒等式一致）
      const sourceLen = Math.max(MIN_MEDIA_CLIP_SEC, clip.sourceOutSec - clip.sourceInSec)
      next.timelineEndSec = snapTimeToFrame(
        clip.timelineStartSec + Math.max(MIN_MEDIA_CLIP_SEC, sourceLen / speedValueOf(normalized)),
        fps
      )
      return next
    })
    set({ project: withMediaClips(state.project, mediaClips), revision: state.revision + 1 })
  },

  updateAudioClipAudio: (id, patch) => {
    const state = get()
    const audioClips = (state.project.audioClips ?? []).map((clip) => {
      if (clip.id !== id) return clip
      const current = clip.audio ?? defaultClipAudio()
      const normalized = normalizeClipAudio({ ...current, ...patch })
      const next: AudioClip = { ...clip }
      if (normalized) next.audio = normalized
      else delete next.audio
      return next
    })
    set({ project: withAudioClips(state.project, audioClips), revision: state.revision + 1 })
  },

  updateAudioClipSpeed: (id, patch) => {
    const state = get()
    const fps = state.project.fps
    const audioClips = (state.project.audioClips ?? []).map((clip) => {
      if (clip.id !== id) return clip
      const current = clip.speed ?? defaultClipSpeed()
      const normalized = normalizeClipSpeed({ ...current, ...patch })
      return applyAudioClipSpeed(clip, normalized, fps)
    })
    set({ project: withAudioClips(state.project, audioClips), revision: state.revision + 1 })
  },

  updateAudioClipRole: (id, role) => {
    const state = get()
    const audioClips = (state.project.audioClips ?? []).map((clip) => {
      if (clip.id !== id) return clip
      const next: AudioClip = { ...clip }
      // voice 是默认角色：整键删除，旧工程 JSON 形态不变
      if (role === 'bgm') next.role = 'bgm'
      else delete next.role
      return next
    })
    set({ project: withAudioClips(state.project, audioClips), revision: state.revision + 1 })
  },

  updateAudioClipDucking: (id, level) => {
    const state = get()
    const audioClips = (state.project.audioClips ?? []).map((clip) => {
      if (clip.id !== id) return clip
      const next: AudioClip = { ...clip }
      if (level === 'light' || level === 'standard' || level === 'strong') next.ducking = level
      else delete next.ducking
      return next
    })
    set({ project: withAudioClips(state.project, audioClips), revision: state.revision + 1 })
  },

  resetAudioClipFx: (id) => {
    const state = get()
    const fps = state.project.fps
    const audioClips = (state.project.audioClips ?? []).map((clip) => {
      if (clip.id !== id) return clip
      const cleared: AudioClip = { ...clip }
      delete cleared.audio
      // v10：角色与 ducking 也属于“这一条的处理”，一并回到默认
      delete cleared.role
      delete cleared.ducking
      // 变速归位后时间轴长度要回到源窗口长度
      return applyAudioClipSpeed(cleared, undefined, fps)
    })
    set({ project: withAudioClips(state.project, audioClips), revision: state.revision + 1 })
  },

  // ---------------------------------------------------------------- v10 音频质量

  setAudioMastering: (mastering) => {
    const state = get()
    const next: Project = { ...state.project }
    if (mastering === 'social' || mastering === 'broadcast') next.audioMastering = mastering
    else delete next.audioMastering
    set({ project: next, revision: state.revision + 1 })
  },

  setGraphicsZ: (graphicsZ) => {
    const state = get()
    const next: Project = { ...state.project }
    if (graphicsZ === 'belowMedia') next.graphicsZ = 'belowMedia'
    else delete next.graphicsZ
    set({ project: next, revision: state.revision + 1 })
  },

  setClipKey: (id, key) => {
    const state = get()
    const current = state.project.mediaClips.find((clip) => clip.id === id)
    if (!current) return
    const normalized = normalizeMediaClipKey(key)
    // 值相同不产生撤销步（与 setClipKeyframes 同一纪律）
    const before = current.key ? JSON.stringify(current.key) : ''
    const after = normalized ? JSON.stringify(normalized) : ''
    if (before === after) return
    const clips = state.project.mediaClips.map((clip) => {
      if (clip.id !== id) return clip
      const next: MediaClip = { ...clip }
      if (normalized) next.key = normalized
      else delete next.key
      return next
    })
    set({ project: { ...state.project, mediaClips: clips }, revision: state.revision + 1 })
  },

  // ---------------------------------------------------------------- v7 音频轨

  selectAudioClip: (id) =>
    set({
      selectedAudioClipId: id,
      selectedTransitionClipId: null,
      ...(id ? { selectionKind: 'audio' as const } : {})
    }),

  insertAudioClip: (input) => {
    const state = get()
    const item = state.project.media.find((m) => m.id === input.mediaId)
    if (!item) return null
    // v3：落点轨道（选中轨优先；轨道锁定则拒收）
    const trackId = pickAudioTrackId(state.project, input.trackId ?? state.selectedTrackId)
    if (isTrackLocked(trackById(state.project.audioTracks, trackId))) return null
    const clip = makeAudioClip(
      {
        id: createId('aclip'),
        mediaId: input.mediaId,
        trackId,
        timelineStartSec: input.timelineStartSec,
        durationSec: input.durationSec ?? item.meta.durationSec,
        sourceInSec: input.sourceInSec ?? 0,
        sourceDurationSec: item.meta.durationSec
      },
      state.project.fps
    )
    if (!clip) return null
    // 落点被占：顺延到同一轨道后面的第一个空档（只选位置，不推动已有段）
    const placed = firstFreeStart(
      clip.timelineStartSec,
      clip.timelineEndSec - clip.timelineStartSec,
      (state.project.audioClips ?? [])
        .filter((other) => other.trackId === trackId)
        .map((other) => ({ startSec: other.timelineStartSec, endSec: other.timelineEndSec })),
      MAX_TRACK_SEC
    )
    if (placed === null) return null
    const placedClip =
      Math.abs(placed - clip.timelineStartSec) < 1e-9
        ? clip
        : applyMoveAudioClip(clip, placed, state.project.fps)
    const audioClips = [...(state.project.audioClips ?? []), placedClip]
    set({
      project: withAudioClips(state.project, audioClips),
      selectedAudioClipId: placedClip.id,
      revision: state.revision + 1
    })
    return placedClip
  },

  moveAudioClip: (id, timelineStartSec, trackId) => {
    const state = get()
    const current = (state.project.audioClips ?? []).find((clip) => clip.id === id)
    if (!current) return
    if (isTrackLocked(trackById(state.project.audioTracks, current.trackId))) return
    const targetTrackId = pickAudioTrackId(state.project, trackId ?? current.trackId)
    if (isTrackLocked(trackById(state.project.audioTracks, targetTrackId))) return
    // 只跟同一目标轨道的邻居抢空间；撞到就贴住，不推开别人
    const others = (state.project.audioClips ?? []).filter(
      (clip) => clip.id !== id && clip.trackId === targetTrackId
    )
    // 跨轨落点若压住目标轨已有片段：直接拒绝（不做静默覆盖）
    const length = current.timelineEndSec - current.timelineStartSec
    const requestedStart = snapTimeToFrame(Math.max(0, timelineStartSec), state.project.fps)
    let start: number
    if (targetTrackId !== current.trackId) {
      const requestedEnd = snapTimeToFrame(requestedStart + length, state.project.fps)
      if (others.some((other) => spansOverlap(trackSpan(other), { startSec: requestedStart, endSec: requestedEnd }))) {
        return
      }
      start = requestedStart
    } else {
      const gap = gapAround(trackSpan(current), others.map(trackSpan))
      start = clampMoveToGap(requestedStart, length, gap.startSec, gap.endSec)
    }
    if (targetTrackId === current.trackId && Math.abs(start - current.timelineStartSec) < 1e-9) return
    const audioClips = (state.project.audioClips ?? []).map((clip) =>
      clip.id === id ? { ...applyMoveAudioClip(clip, start, state.project.fps), trackId: targetTrackId } : clip
    )
    set({ project: withAudioClips(state.project, audioClips), revision: state.revision + 1 })
  },

  trimAudioClip: (id, patch) => {
    const state = get()
    const current = (state.project.audioClips ?? []).find((clip) => clip.id === id)
    if (!current) return
    if (isTrackLocked(trackById(state.project.audioTracks, current.trackId))) return
    const others = (state.project.audioClips ?? []).filter(
      (clip) => clip.id !== id && clip.trackId === current.trackId
    )
    const gap = gapAround(trackSpan(current), others.map(trackSpan))
    const minSec = frameIntervalSec(state.project.fps)
    const clamped: { timelineStartSec?: number; timelineEndSec?: number } = {}
    if (patch.timelineStartSec !== undefined) {
      clamped.timelineStartSec = clampTrimStart(
        patch.timelineStartSec,
        gap.startSec,
        current.timelineEndSec - minSec
      )
    }
    if (patch.timelineEndSec !== undefined) {
      clamped.timelineEndSec = clampTrimEnd(
        patch.timelineEndSec,
        current.timelineStartSec + minSec,
        gap.endSec
      )
    }
    const audioClips = (state.project.audioClips ?? []).map((clip) => {
      if (clip.id !== id) return clip
      const item = state.project.media.find((m) => m.id === clip.mediaId)
      return applyTrimAudioClip(
        clip,
        clamped,
        state.project.fps,
        item?.meta.durationSec ?? Number.POSITIVE_INFINITY
      )
    })
    set({ project: withAudioClips(state.project, audioClips), revision: state.revision + 1 })
  },

  removeAudioClip: (id) => {
    const state = get()
    const current = (state.project.audioClips ?? []).find((clip) => clip.id === id)
    if (!current) return
    if (isTrackLocked(trackById(state.project.audioTracks, current.trackId))) return
    const audioClips = (state.project.audioClips ?? []).filter((clip) => clip.id !== id)
    const removedSelected = state.selectedAudioClipId === id
    const selectedAudioClipId = removedSelected ? (audioClips[0]?.id ?? null) : state.selectedAudioClipId
    set({
      project: withAudioClips(state.project, audioClips),
      ...(removedSelected ? { selectedAudioClipId } : {}),
      // 删掉了正在编辑的音频段且再无音频段：检查器退回字幕编辑器，不留一个空音频面板
      ...(removedSelected && selectedAudioClipId === null && state.selectionKind === 'audio'
        ? { selectionKind: 'subtitle' as const }
        : {}),
      revision: state.revision + 1
    })
  },

  // ---------------------------------------------------------------- v3 轨道

  selectTrack: (id) => set({ selectedTrackId: id }),

  addMediaTrack: () => {
    const state = get()
    const mediaTracks = appendMediaTrack(state.project.mediaTracks)
    if (mediaTracks === state.project.mediaTracks) return null
    const added = mediaTracks[mediaTracks.length - 1]!
    set({
      project: { ...state.project, mediaTracks },
      selectedTrackId: added.id,
      revision: state.revision + 1
    })
    return added.id
  },

  addAudioTrack: () => {
    const state = get()
    const audioTracks = appendAudioTrack(state.project.audioTracks)
    if (audioTracks === state.project.audioTracks) return null
    const added = audioTracks[audioTracks.length - 1]!
    set({
      project: { ...state.project, audioTracks },
      selectedTrackId: added.id,
      revision: state.revision + 1
    })
    return added.id
  },

  removeMediaTrack: (id) => {
    const state = get()
    const { mediaTracks, mediaClips } = state.project
    if (!mediaTracks.some((track) => track.id === id)) return
    const nextTracks = removeTrackIn(mediaTracks, id)
    if (nextTracks === mediaTracks) return
    const removed = mediaClips.filter((clip) => clip.trackId === id)
    const removedIds = new Set(removed.map((clip) => clip.id))
    set({
      project: {
        ...state.project,
        mediaTracks: nextTracks,
        mediaClips: mediaClips.filter((clip) => clip.trackId !== id)
      },
      ...(state.selectedMediaClipId && removedIds.has(state.selectedMediaClipId)
        ? { selectedMediaClipId: null }
        : {}),
      ...(state.selectedTrackId === id ? { selectedTrackId: nextTracks[0]?.id ?? null } : {}),
      revision: state.revision + 1
    })
  },

  removeAudioTrack: (id) => {
    const state = get()
    const { audioTracks } = state.project
    if (!audioTracks.some((track) => track.id === id)) return
    const nextTracks = removeTrackIn(audioTracks, id)
    if (nextTracks === audioTracks) return
    const kept = (state.project.audioClips ?? []).filter((clip) => clip.trackId !== id)
    const removedIds = new Set(
      (state.project.audioClips ?? []).filter((clip) => clip.trackId === id).map((clip) => clip.id)
    )
    const project: Project = { ...state.project, audioTracks: nextTracks }
    if (kept.length > 0) project.audioClips = sortAudioClips(kept)
    else delete project.audioClips
    set({
      project,
      ...(state.selectedAudioClipId && removedIds.has(state.selectedAudioClipId)
        ? { selectedAudioClipId: null }
        : {}),
      ...(state.selectedTrackId === id ? { selectedTrackId: nextTracks[0]?.id ?? null } : {}),
      revision: state.revision + 1
    })
  },

  moveMediaTrack: (id, toIndex) => {
    const state = get()
    const mediaTracks = moveTrackIn(state.project.mediaTracks, id, toIndex)
    if (mediaTracks === state.project.mediaTracks) return
    set({ project: { ...state.project, mediaTracks }, revision: state.revision + 1 })
  },

  moveAudioTrack: (id, toIndex) => {
    const state = get()
    const audioTracks = moveTrackIn(state.project.audioTracks, id, toIndex)
    if (audioTracks === state.project.audioTracks) return
    set({ project: { ...state.project, audioTracks }, revision: state.revision + 1 })
  },

  renameTrack: (id, name) => {
    const state = get()
    const project = state.project
    const mediaTracks = renameTrackIn(project.mediaTracks, id, name)
    if (mediaTracks !== project.mediaTracks) {
      set({ project: { ...project, mediaTracks }, revision: state.revision + 1 })
      return
    }
    const audioTracks = renameTrackIn(project.audioTracks, id, name)
    if (audioTracks !== project.audioTracks) {
      set({ project: { ...project, audioTracks }, revision: state.revision + 1 })
      return
    }
    const [subtitleTrack] = renameTrackIn([project.subtitleTrack], id, name)
    if (subtitleTrack && subtitleTrack !== project.subtitleTrack) {
      set({ project: { ...project, subtitleTrack }, revision: state.revision + 1 })
    }
  },

  setTrackMuted: (id, muted) => {
    const state = get()
    const project = withTrackMuted(state.project, id, muted)
    if (project !== state.project) set({ project, revision: state.revision + 1 })
  },

  setTrackHidden: (id, hidden) => {
    const state = get()
    const project = withTrackHidden(state.project, id, hidden)
    if (project !== state.project) set({ project, revision: state.revision + 1 })
  },

  setTrackLocked: (id, locked) => {
    const state = get()
    const project = withTrackLocked(state.project, id, locked)
    if (project !== state.project) set({ project, revision: state.revision + 1 })
  },

  setMediaClipTrack: (id, trackId) => {
    const state = get()
    const current = state.project.mediaClips.find((clip) => clip.id === id)
    if (!current || current.trackId === trackId) return
    if (!state.project.mediaTracks.some((track) => track.id === trackId)) return
    if (isTrackLocked(trackById(state.project.mediaTracks, current.trackId))) return
    if (isTrackLocked(trackById(state.project.mediaTracks, trackId))) return
    const conflict = state.project.mediaClips.some(
      (other) =>
        other.id !== id && other.trackId === trackId && spansOverlap(trackSpan(other), trackSpan(current))
    )
    if (conflict) return
    const mediaClips = state.project.mediaClips.map((clip) =>
      clip.id === id ? { ...clip, trackId } : clip
    )
    set({ project: withMediaClips(state.project, mediaClips), revision: state.revision + 1 })
  },

  setAudioClipTrack: (id, trackId) => {
    const state = get()
    const current = (state.project.audioClips ?? []).find((clip) => clip.id === id)
    if (!current || current.trackId === trackId) return
    if (!state.project.audioTracks.some((track) => track.id === trackId)) return
    if (isTrackLocked(trackById(state.project.audioTracks, current.trackId))) return
    if (isTrackLocked(trackById(state.project.audioTracks, trackId))) return
    const conflict = (state.project.audioClips ?? []).some(
      (other) =>
        other.id !== id && other.trackId === trackId && spansOverlap(trackSpan(other), trackSpan(current))
    )
    if (conflict) return
    const audioClips = (state.project.audioClips ?? []).map((clip) =>
      clip.id === id ? { ...clip, trackId } : clip
    )
    set({ project: withAudioClips(state.project, audioClips), revision: state.revision + 1 })
  },

  compactTimeline: () => {
    const state = get()
    const compacted = compactMediaClips(state.project.mediaClips, state.project.fps)
    // 已经紧贴时不动工程，避免无意义地推高 revision（会触发自动保存）
    const changed = compacted.some((clip) => {
      const before = state.project.mediaClips.find((item) => item.id === clip.id)
      return (
        !before ||
        Math.abs(before.timelineStartSec - clip.timelineStartSec) > 1e-6 ||
        Math.abs(before.timelineEndSec - clip.timelineEndSec) > 1e-6
      )
    })
    if (!changed) return
    set({
      project: cleanupInvalidTransitions(withMediaClips(state.project, compacted), state.project.fps),
      revision: state.revision + 1
    })
  }
}))

function mergeOverrides(base: StyleOverrides, patch: StyleOverrides): StyleOverrides {
  const next: StyleOverrides = { ...base }
  /**
   * `tokens` / `fontScale` 是**整组替换**（不是逐键合并）：面板负责交回「完整的自定义集合」，
   * 等于预设声明的键不在里面（见 shared/clipStyle 的差集函数）。
   * 逐键合并会把旧预设的陈旧同值覆盖留下来，切预设后它仍然压住新预设的配色。
   */
  if (patch.tokens !== undefined) {
    if (hasKeys(patch.tokens)) next.tokens = patch.tokens
    else delete next.tokens
  }
  if (patch.barOpacity !== undefined) {
    // 回到不透明（1）等于没有覆盖，整键删掉而不是留个 1
    if (Math.abs(patch.barOpacity - 1) >= 0.005) next.barOpacity = patch.barOpacity
    else delete next.barOpacity
  }
  if (patch.titleGradient) next.titleGradient = { ...base.titleGradient, ...patch.titleGradient }
  if (patch.subtitleGradient) next.subtitleGradient = { ...base.subtitleGradient, ...patch.subtitleGradient }
  if (patch.compact !== undefined) {
    if (patch.compact) next.compact = true
    else delete next.compact
  }
  if (patch.fontScale !== undefined) {
    // 100% 就是「没缩放」：这一层不依赖预设就能判定，直接在 store 层抹掉，
    // 避免面板/旧工程递上来的 {title:1} 之类噪声永久占住一个自定义席位
    const scales: { title?: number; subtitle?: number } = {}
    if (isScaled(patch.fontScale.title)) scales.title = patch.fontScale.title
    if (isScaled(patch.fontScale.subtitle)) scales.subtitle = patch.fontScale.subtitle
    if (hasKeys(scales)) next.fontScale = scales
    else delete next.fontScale
  }
  return next
}

/** 字号缩放是否偏离 100%（与滑杆粒度一致：小于 0.5% 的抖动不算自定义） */
function isScaled(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && Math.abs(value - 1) >= 0.005
}

export function selectedClip(state: ProjectState): SubtitleClip | null {
  if (!state.selectedClipId) return null
  return state.project.clips.find((clip) => clip.id === state.selectedClipId) ?? null
}
