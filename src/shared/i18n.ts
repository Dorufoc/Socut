/**
 * 界面文案集中（模态提示、进度、错误）。
 *
 * 两条文案纪律：
 * 1. **规格 §6 的模态文案必须逐字使用**（非 16:9 / HDR / VFR / 大体积导出 / 文件不可用），
 *    它们是验收证据的一部分，不参与下面的精简。
 * 2. 其余按商业软件口径写：**标签短、说明少、一处只说一次**。
 *    解释性内容只在 hover（title）里出现，面板里不放常驻说明书；
 *    不写规格编号、FFmpeg 参数名、「分支/令牌/广播级」这类内部术语。
 */
export const TEXT = {
  appTitle: 'Socut 新闻字幕条',

  // 兼容性模态（规格 §6.1 / §6.2 / §6.3）
  modalNon169: {
    title: '参考视频非 16:9',
    body: '字幕条将按流式布局自适应宽度，竖屏/超宽屏下观感可能与 16:9 不同。',
    confirm: '我已了解',
    cancel: '取消'
  },
  modalHdr: {
    title: '参考视频为 HDR',
    body: 'HDR 效果将丢失，输出回归 SDR BT.709，原 HDR 元数据不保留。',
    confirm: '我已了解',
    cancel: '取消'
  },
  /** 规格 §8：工程里的参考视频被移动/删除时提示重新定位 */
  refVideoMissing: {
    title: '参考视频文件不可用',
    body: '工程记录的参考视频已移动、重命名或不在本机。叠加导出已禁用；透明字幕条导出仍可用。',
    confirm: '重新定位',
    notice: '参考视频文件不可用，叠加导出已禁用；可在参考视频面板重新导入。'
  },
  modalVfr: {
    title: '参考视频为变帧率（VFR）',
    body: '检测到帧间隔不均匀。为保证入出点精确，建议先转换为固定帧率（CFR）后再编辑。',
    convert: '转换并导入（推荐）',
    raw: '直接导入',
    cancel: '取消',
    rawWarning: '该素材为 VFR：叠加导出将强制走 VFR 路径，且不保证帧级对齐。',
    secondConfirmTitle: 'VFR 素材二次确认',
    secondConfirmBody: '该参考视频为 VFR 且未转换。导出将基于 CFR 时间轴重新生成 VFR 时间戳，非原始逐帧时间戳恢复，帧级对齐不保证。是否继续？',
    vfrNote: '本次输出的 VFR 基于 CFR 时间轴重新生成，非原始 VFR 时间戳逐帧恢复。'
  },
  modalHugeExport: {
    title: '大体积导出确认',
    bodyPrefix: '预计输出约',
    bodySuffix: '。4K60 透明 ProRes 4444 体积较大，可改用 PNG 序列出口。',
    usePng: '改用 PNG 序列',
    useMov: '仍然导出 MOV',
    cancel: '取消',
    diskShort: '目标磁盘可用空间不足（需要约'
  },

  // 导出面板
  export: {
    tab: '导出',
    scope: '导出范围',
    scopeTimeline: '整条时间轴',
    scopeSelected: '仅选中片段',
    resolution: '分辨率',
    fps: '帧率',
    followRef: '跟随参考视频',
    audioCopy: '音频：直接复制',
    audioAac: '音频：转码 AAC 192k',
    audioTranscoded: '参考音频不可直接复制，已转码为 AAC 192k。',
    audioNone: '参考视频无音轨，输出无声。',
    estimate: '预估体积',
    startMov: '导出透明 MOV（ProRes 4444）',
    startMp4: '导出 MP4（叠加到参考视频）',
    startPng: '导出 PNG 序列',
    cancel: '取消导出',
    reveal: '打开所在目录',
    queued: '排队中',
    preparing: '准备中',
    rendering: '逐帧渲染',
    muxing: '编码封装',
    verifying: '校验产物',
    done: '完成',
    failed: '失败',
    cancelled: '已取消',
    /** v10：成片响度标准化 */
    mastering: '音量标准化',
    masteringOff: '不处理',
    masteringSocial: '短视频（-14 LUFS）',
    masteringBroadcast: '电视播出（-23 LUFS）',
    masteringHint: '统一响度，避免不同平台音量忽大忽小',
    /** 导出位置 */
    fileName: '作品名称',
    outputDir: '导出至',
    /** 交付画布 */
    canvas: '导出画布',
    canvasHint: '可多选，一次导出多个版本',
    canvasFollow: '跟随素材',
    /** 分辨率 / 码率 / 编码 / 音频码率 */
    resolutionSource: '跟随素材（推荐）',
    resolution480: '480P',
    resolution720: '720P',
    resolution1080: '1080P',
    resolution2k: '2K',
    resolution4k: '4K',
    bitrate: '码率',
    bitrateLow: '较低',
    bitrateStandard: '标准',
    bitrateHigh: '较高',
    bitrateCustom: '自定义',
    bitrateCustomLabel: '自定义视频码率',
    bitrateHint: (kbps: number) => `当前码率：${kbps} kbps`,
    codec: '编码格式',
    codecAvc: 'AVC（H.264）',
    codecHevc: 'HEVC（H.265）',
    codecAv1: 'AV1',
    crfLabel: 'CRF（留空按画质档）',
    bitDepthLabel: '位深',
    bitDepth8: '8-bit',
    bitDepth10: '10-bit',
    colorRangeLabel: '色彩范围',
    colorRangeLimited: '有限（TV 16–235）',
    colorRangeFull: '全范围（PC 0–255）',
    // M7-E：图形层 z 档（字幕条/文本元素相对媒体层的位置）
    graphicsZLabel: '图形层位置',
    graphicsZAbove: '媒体之上（默认）',
    graphicsZBelow: '媒体之下',
    codecHint: 'HEVC 体积更小，但兼容性略差',
    audioBitrate: '音频码率',
    audioBitrateCopy: '原声直通',
    audioBitrateCustom: '自定义音频码率',
    audioBitrateHint: '选择码率后会转为 AAC 重新编码',
    /** 画质 */
    quality: '画质',
    qualityHigh: '高清',
    qualityStandard: '标准',
    qualitySmall: '小体积',
    qualityHint: '推荐「高清」：画质与体积平衡',
    /** 导出摘要 */
    summary: '导出摘要',
    /** 更多导出选项 */
    moreOptions: '更多导出选项',
    transparentHint: '透明素材用于在剪辑软件中叠加，不含成片画面。',
    transparentFormat: '透明素材格式',
    pipeTransport: '帧传输',
    pipeAuto: '自动（推荐）',
    pipePng: 'PNG（兼容模式）',
    pipeHint: '自动模式将帧直接送入编码器；兼容模式仅在排障时使用。',
    /** 预览导出画布 */
    previewCanvas: '预览导出画布'
  },

  // 时间轴与片段
  timeline: {
    /** v10 P2：新建/删除字幕条的入口已合并到左侧「字幕」Tab，工具栏只留通用拆/删与撤销 */
    undo: '撤销',
    redo: '重做',
    undoHint: (count: number) => `撤销上一步（还能撤 ${count} 步，Ctrl+Z）`,
    redoHint: (count: number) => `重做（还能重做 ${count} 步，Ctrl+Shift+Z / Ctrl+Y）`,
    /** v2 媒体轨 → v10 P3：拆分/删除不再分轨，都作用于「当前该操作的那一段」 */
    splitClip: '拆分',
    splitHint: '拆开当前选中的段（未选中时拆播放头处的媒体段）· Ctrl+B',
    removeTarget: '删除',
    removeTargetHint: '删掉当前选中的段（未选中时删播放头处的媒体段）',
    noSplitTarget: '没有可拆分的段：先选中一段，或把播放头放到要拆的媒体段上',
    noRemoveTarget: '没有可删除的段：先选中一段，或把播放头放到要删的媒体段上',
    emptyMedia: '空轨：从素材库拖入',
    /** M7：文本轨（固定一条） */
    emptyText: '空文本轨：从「包装」Tab 新增文本元素',
    /** v7：音频轨 */
    audioLane: '音频',
    emptyAudio: '空轨：从素材库拖入音频',
    /** v7：叠层 */
    layerUp: '上移层',
    layerDown: '下移层',
    layerUpHint: '把选中片段叠到上一层（上层盖住下层）',
    layerDownHint: '把选中片段落到下一层',
    inPoint: '入点',
    outPoint: '出点',
    duration: '时长',
    empty: '暂无片段',
    /** v4：字幕轨窄示意条的悬停读数（只给三个时间，不写操作说明） */
    stripHint: (start: string, end: string, current: string) =>
      `入点 ${start} → 出点 ${end} · 当前 ${current}`,
    /** v6.2：时间轴工具栏三个开关（说明只在 hover） */
    snapTogether: '主轨对齐',
    snapTogetherHint: '主轨片段从左到右紧贴，不留空隙',
    magneticSnap: '自动吸附',
    magneticSnapHint: '拖拽时自动贴到相邻片段的首尾',
    rippleDeleteTool: '磁性删除',
    rippleDeleteToolHint: '开启后 Delete 会把后续同轨片段自动左移合拢（等同 Shift+Delete）',
    hoverPreview: '预览轴',
    hoverPreviewHint: '悬停时用黄线预览帧位置',
    /** M5：剪辑操作（波纹删除 / 向后合并） */
    rippleDelete: '波纹删除',
    rippleDeleteHint: '删掉该段并让同轨后续片段左移合拢 · Shift+Delete',
    mergeNext: '向后合并',
    mergeNextHint: '与同轨紧邻的下一段合并（同素材、源连续、参数一致）· Ctrl+M',
    noRippleTarget: '没有可波纹删除的段：先选中一条媒体段',
    noMergeTarget: '没有可合并的下一段：需要同轨相邻、同一素材且源区间连续',
    /** M5-D：多序列（一个工程多段剪辑） */
    sequence: '序列',
    sequenceHint: '一个工程可有多段剪辑：切换后时间轴只显示当前序列',
    sequenceAdd: '新建空序列',
    sequenceRemove: '删除当前序列',
    sequenceRemoveHint: '删除当前序列（至少保留一条）',
    sequenceLastHint: '只剩一条序列，无法删除',
    /** M5：冻结帧 */
    freezeFrame: '冻结帧',
    freezeFrameHint: '在播放头切点插入 1s 静帧，后续片段右移 · Shift+F',
    noFreezeTarget: '没有可冻结的段：把播放头放到媒体段中间（距两端至少 0.2s）',
    freezeFailed: '冻结帧失败：源文件不可读或 FFmpeg 不可用'
  },

  /**
   * 左侧「包装」Tab（P6）：字幕 / 片尾 / 水印三块从上到下一次铺开。
   * 片尾先占位——功能未实现就不给假入口。
   */
  wrap: {
    tab: '包装',
    captions: '字幕',
    textElements: '文本元素',
    ending: '片尾',
    endingTodo: '片尾功能尚未实现，后续版本开放',
    endingPlaceholder: '片尾占位',
    watermark: '水印'
  },

  /** M7：文本元素（自由叠加文字，与字幕条是两套体系） */
  textElement: {
    title: '文本元素',
    add: '新增文本元素',
    addHint: '新增一条默认 5s 的文本元素，随即可在右侧改字与样式',
    empty: '暂无文本元素',
    hint: '选中并在预览里显示',
    remove: '删除文本元素',
    preset: '起始预设',
    text: '文字',
    inPoint: '入点（秒）',
    outPoint: '出点（秒）',
    style: '样式',
    size: '字号',
    weight: '字重',
    color: '颜色',
    tracking: '字距',
    lineHeight: '行高',
    align: '对齐',
    alignLeft: '左对齐',
    alignCenter: '居中',
    alignRight: '右对齐',
    anchorX: '锚点 X（%）',
    anchorY: '锚点 Y（%）',
    plate: '背景板',
    plateEnabled: '启用背景板',
    plateColor: '底色',
    plateOpacity: '不透明度',
    platePaddingX: '左右内边距',
    platePaddingY: '上下内边距',
    plateRadius: '圆角',
    stroke: '描边',
    strokeWidth: '描边宽度',
    strokeColor: '描边颜色',
    shadow: '阴影',
    shadowBlur: '模糊',
    shadowColor: '阴影颜色',
    shadowOffsetX: '阴影 X',
    shadowOffsetY: '阴影 Y',
    animation: '动画',
    inDuration: '入场（秒）',
    outDuration: '出场（秒）',
    rise: '上浮（px）'
  },

  /** 左侧「字幕」Tab：按时间顺序列出全部标题，并且是新建/删除字幕条的唯一入口 */
  captions: {
    tab: '字幕',
    title: '字幕',
    count: (n: number) => `${n} 条`,
    empty: '暂无字幕条',
    add: '新建片段',
    addHint: '在时间轴末尾接一条新的字幕条，随即可在右侧编辑',
    // M11：外部字幕 / 名单导入
    importSubtitle: '导入 SRT/ASS',
    importSubtitleHint: '把外部字幕文件解析成字幕条（按文件里的时间码落位）',
    importList: '导入名单',
    importListHint: 'CSV/JSON/纯文本名单 → 首尾相接的字幕条（列：标题,副标题,时长）',
    imported: (n: number) => `已导入 ${n} 条字幕`,
    importedBatch: (n: number) => `已生成 ${n} 条字幕`,
    importEmpty: '文件里没有可导入的字幕内容',
    importFailed: '导入失败',
    // M11：自动字幕（whisper.cpp）——选中媒体片段 → 离线识别 → 字幕条落到时间轴
    autoCaption: '自动字幕',
    autoCaptionHint: '用 whisper.cpp 离线识别选中媒体片段的语音，并按片段在时间轴上的位置生成字幕条',
    autoCaptionNoMedia: '先在时间轴上选中一个媒体片段，再点「自动字幕」',
    autoCaptionSelected: (name: string) => `将识别选中片段的素材：${name}`,
    autoCaptionLanguage: '识别语言',
    autoCaptionLangAuto: '自动检测',
    autoCaptionLangZh: '中文',
    autoCaptionLangEn: '英文',
    autoCaptionPrepare: '准备音频…',
    autoCaptionProgress: (percent: number) => `识别中 ${percent}%`,
    autoCaptionCancel: '取消识别',
    autoCaptionCancelled: '已取消自动字幕',
    autoCaptionAdded: (n: number) => `自动字幕：新增 ${n} 条`,
    autoCaptionEmpty: '没有识别到落在该片段区间内的语音',
    autoCaptionFailed: '自动字幕失败',
    /** 缺资产时给「可执行」提示，而不是只报一句错 */
    autoCaptionImportHint:
      '可执行：请先导入 whisper 二进制与模型（npm run fetch:whisper / fetch:whisper:model，或放到 resources/whisper 与 resources/models/whisper），也能用 CLI whisper.config 指定路径',
    autoCaptionMissingMedia: '选中的媒体文件已不存在：请先用「重新定位」恢复素材',
    autoCaptionAudioFailed: '抽音失败：该素材可能没有音轨，或随包 FFmpeg 不可用',
    remove: '删除这条字幕',
    removeNamed: (title: string) => `删除字幕条：《${title}》`,
    hint: '选中并跳到中点',
    onAir: '正在显示',
    noTitle: '未填写',
    noSubtitle: '未填写',
    // M11-H：字幕列表多选 + 批量编辑（每个批量动作 = 一次撤销步）
    batchMode: '批量',
    batchModeHint: '进入批量编辑：勾选多条字幕后统一改预设/时长/开关，或一次删除',
    batchModeExit: '退出批量',
    batchGroup: '字幕批量编辑',
    batchSelectedCount: (n: number) => `已选 ${n} 条`,
    batchSelectAll: '全选',
    batchClear: '清空',
    batchEmptyHint: '勾选列表左侧的复选框，选择要批量处理的字幕条',
    batchPreset: '批量预设',
    batchApplyPreset: '应用预设',
    batchPresetDone: (n: number) => `已为 ${n} 条字幕应用预设`,
    batchDuration: '统一时长（秒）',
    batchApplyDuration: '统一时长',
    batchDurationDone: (n: number) => `已统一 ${n} 条字幕的时长`,
    batchCompact: '强制竖屏紧凑',
    batchCompactDone: (n: number) => `已更新 ${n} 条字幕的紧凑设置`,
    batchGradient: '标题渐变',
    batchGradientDone: (n: number) => `已更新 ${n} 条字幕的渐变设置`,
    batchDelete: '删除选中',
    batchDeleteDone: (n: number) => `已删除 ${n} 条字幕`,
    batchNothing: '没有可改动的字幕条（可能已是该状态）',
    selectNamed: (title: string) => `选择字幕条：《${title}》`
  },

  /** 右侧「视频片段」编辑器（选中媒体段时替换字幕检查器） */
  videoEditor: {
    title: '视频片段',
    edited: '已编辑',
    noneSelected: '未选择视频片段',
    geometry: '几何变换',
    scale: '缩放',
    offsetX: '水平位置',
    offsetY: '垂直位置',
    rotation: '旋转',
    flip: '画面翻转',
    flipH: '水平镜像',
    flipV: '垂直镜像',
    grade: '色彩与光影',
    basics: '基础',
    brightness: '亮度',
    exposure: '曝光',
    colorGroup: '色彩',
    contrast: '对比度',
    saturation: '饱和度',
    warmth: '冷暖',
    advanced: '高级',
    vibrance: '光感',
    vibranceHint: '抬中调、护高光，脏色轻推；肤色不冲顶',
    missingMedia: '素材已移出',
    curves: '曲线',
    curveMaster: '亮度',
    resetCurve: '复位',
    interact: '交互',
    interactHint: '在预览里拖角缩放、拖画面平移、拖顶部圆点旋转',
    reset: '恢复默认',
    resetHint: '本条片段的画面、音频与变速参数全部回到默认值'
  },

  /**
   * v11：转场（左侧「转场」Tab + 时间轴切点 + 右侧转场检查器）。
   * 数据仍落在切点右侧片段的 `transitionIn` 上，但入口从「片段检查器」搬到
   * 「样式面板 → 拖到缝隙」，检查器只负责调时长与删除。
   */
  transition: {
    /** 左侧 Tab 标题 */
    tab: '转场',
    panelTitle: '转场样式',
    panelHint: '长按一种转场，拖到两个片段之间的连接缝隙处松开即可应用；点选样式可替换已选中的转场',
    panelCount: (count: number) => (count > 0 ? `时间轴上已有 ${count} 个转场` : '时间轴上还没有转场'),
    dragFirst: '先长按样式拖到片段缝隙，或点选时间轴上的转场图标，再用样式替换',
    dropInvalid: '请拖到同一轨道相邻两个片段之间的连接缝隙（有空隙的位置不能添加转场）',
    rejected: '该切点无法添加转场：需要两侧片段紧贴，且两侧素材的余量足够',
    added: (label: string) => `已添加转场：${label}`,
    replaced: (label: string) => `已替换为：${label}`,
    inspectorTitle: '转场',
    noneSelected: '未选中转场。点击时间轴缝隙上的转场图标即可编辑',
    durationGroup: '参数',
    cutPoint: (timecode: string) => `切点 ${timecode}`,
    maxDuration: (sec: string) => `可调范围 0.2–${sec}s`,
    deleteKeyHint: '选中状态按 Delete / 退格键可直接删除',
    /** 首段 / 间隙 / 手柄不足的禁用原因 */
    first: '本段是同轨第一段，没有入场转场',
    gap: '与前段之间有空隙，先紧贴再设置转场',
    noType: '先选一个转场类型',
    noTail: '前段尾部没有足够素材，可缩短转场或把前段出点提前',
    noHead: '本段头部没有足够素材，可缩短转场或把本段入点提前',
    tooShort: '可用时长不足 2 帧，无法设置转场',
    insufficient: (sec: string) => `可用转场约 ${sec} 秒，不足最短 0.2 秒`,
    duration: '时长',
    frames: (count: number) => `${count} 帧`,
    remove: '删除转场',
    hint: '转场只在叠加 MP4 与封面中生效；音频仍按切点硬切',
    marker: (label: string, sec: string) => `转场：${label} ${sec} 秒`
  },

  /** v9：片段音频（媒体段原声与音频段共用一套控件） */
  clipAudio: {
    title: '音频',
    volume: '音量',
    fadeIn: '渐入',
    fadeOut: '渐出',
    volumeHint: '0%~200%，100% 为原始音量（导出侧 volume 滤镜同一增益）',
    fadeInHint: '从静音升到正常音量所需时间（导出侧 afade=t=in）',
    fadeOutHint: '从正常音量降到静音所需时间（导出侧 afade=t=out）',
    /** v10：导出侧节点降噪（预览不生效） */
    denoise: '降噪',
    denoiseOff: '关闭',
    denoiseLight: '轻度',
    denoiseStandard: '标准',
    denoiseStrong: '强',
    denoiseHint: '导出生效：afftdn 频域降噪，作用于变速/音量/淡变之前',
    // M8：arnndn 神经网络降噪（随包 RNNoise 模型；缺模型时导出侧给可执行提示）
    denoiseAi: 'AI 降噪',
    denoiseAiHint: '导出生效：arnndn 神经网络降噪（用随包 RNNoise 模型）；缺模型时导出会提示先取回模型',
    // M8：人声增强 / 变声（都只在导出侧生效）
    voiceEnhance: '人声增强',
    voiceEnhanceHint: '导出生效：高通去低频轰鸣 + 3kHz 存在感 + 轻压缩，全程不改时长',
    voiceEnhanceOff: '关闭',
    voiceEnhanceLight: '轻度',
    voiceEnhanceStandard: '标准',
    voiceEnhanceStrong: '强',
    voiceChange: '变声',
    voiceChangeHint: '导出生效：rubberband 改音高并保持时长（与画面不会错位）',
    voiceChangeOff: '关闭',
    voiceChangeChipmunk: '花栗鼠',
    voiceChangeRobot: '机器人',
    voiceChangePhone: '电话音',
    voiceChangeDeep: '低沉'
  },

  /** v9：片段变速 */
  /** M7-E：特效包（导出侧生效，预览 CSS 近似） */
  /** M8：抠像（色度键/亮度键，导出侧生效） */
  clipKey: {
    title: '抠像',
    hint: '导出生效：把键色抠成透明（绿幕/蓝幕/白底素材），预览不显示透明结果',
    mode: '模式',
    off: '关闭',
    chroma: '色度键（绿/蓝幕）',
    luma: '亮度键（白底/黑底）',
    color: '键色',
    similarity: '相似度',
    blend: '边缘混合',
    despill: '去溢色',
    threshold: '阈值',
    tolerance: '容差',
    softness: '柔和'
  },
  clipEffects: {
    title: '特效包',
    hint: '导出侧生效（预览为近似）：暗角 / 胶片颗粒 / 故障 / 色差 / 暖色漏光 / 黑白'
  },
  clipSpeed: {
    title: '变速',
    rate: '倍速',
    maintainPitch: '变速保持音高',
    on: '保持音高',
    off: '连动音高',
    rateHint: '源内容不变，片段在时间轴上按倍速伸缩',
    maintainPitchHint: '开启：只变时长（atempo）；关闭：音高随倍速升降（asetrate）'
  },

  /** v9：音频片段编辑器（与视频编辑器同一套分区，只是没有画面参数） */
  audioEditor: {
    title: '音频片段',
    edited: '已编辑',
    noneSelected: '未选择音频片段',
    missingMedia: '素材已移出',
    reset: '恢复默认',
    resetHint: '本条音频的音量、渐变、变速、角色与 ducking 全部回到默认值'
  },

  /** v10：音频片段角色（BGM 自动压低） */
  audioRole: {
    title: 'BGM 与人声',
    voice: '人声',
    bgm: 'BGM',
    ducking: '自动压低',
    duckingOff: '关闭',
    duckingLight: '轻度',
    duckingStandard: '标准',
    duckingStrong: '强',
    hint: '角色决定谁压谁：标记为 BGM 的段在有口播时被自动压低',
    duckingHint: '导出生效：有口播时自动压低'
  },

  /** v8：时间轴片段级视频防抖（ffmpeg vidstab 两段式；导出逐段生效，预览经「应用防抖预览」代理） */
  stab: {
    title: '防抖稳定',
    on: '防抖',
    off: '已关闭',
    hint: '导出时逐段预分析并补偿镜头抖动；预览需点「应用防抖预览」生成稳定化代理',
    levelLabel: '强度',
    levelLow: '轻度',
    levelStandard: '标准',
    levelHigh: '强',
    levelHint: '越强的抖动用越高的搜索精度，预分析也越慢',
    tripod: '虚拟三脚架',
    tripodHint: '用超长窗口平滑把相机轨迹钉成一条直线，模拟三脚架锁定；对持续平移的机位比常规档拉得更紧',
    analyzeNotice: (done: number, total: number) => `防抖预分析：第 ${done}/${total} 段`,
    exportNote: '含防抖片段：基座逐段重编码，音频转为 AAC 192k。',
    /** v8.1：预览代理（Inspector 应用按钮 + 主进程后台作业） */
    previewApply: '应用防抖预览',
    previewApplying: '正在生成防抖代理…',
    previewQueued: '已排队，等待生成…',
    previewApplied: '防抖代理已就绪',
    previewStale: '参数已改动，需重新应用',
    previewReapply: '重新应用防抖预览',
    previewCancel: '取消生成',
    previewDetect: '运动检测',
    previewTranscode: '代理转码',
    previewCancelled: '防抖预览生成已取消',
    applyDisabled: '未开启防抖，无需生成预览代理',
    applyBadRange: '片段区间无效，无法生成防抖代理',
    sourceMissing: (p: string) => `源文件不存在或不可读：${p}`,
    detectFailed: '运动检测未生成有效的分析数据，请重试',
    proxyEmpty: (p: string) => `防抖代理产物为空：${p}`
  },

  /** M6：片段参数关键帧（右侧检查器"关键帧"展开器） */
  keyframes: {
    title: '关键帧',
    hint: '按片段内进度改参数（0% = 入点，100% = 出点）；没有关键帧时参数不生效',
    addPoint: '在播放头打点',
    clearTrack: '清空该参数',
    deletePoint: '删除关键点',
    points: (n: number) => `${n} 个关键点`,
    empty: '还没有关键帧',
    playhead: (percent: number) => `播放头 ${percent}%`,
    easing: '缓动',
    easingCustom: '自定义贝塞尔',
    bezierHint: 'cubic-bezier(x1, y1, x2, y2)：x/y 都在 0–1，禁回弹',
    bezierEditor: '贝塞尔曲线编辑器（拖动两个控制点；松手才写回）',
    value: '值',
    labels: {
      opacity: '不透明度',
      offsetXPct: '水平位移 %',
      offsetYPct: '垂直位移 %',
      scalePct: '缩放 %',
      rotationDeg: '旋转 °',
      brightness: '亮度',
      exposure: '曝光',
      contrast: '对比度',
      saturation: '饱和度',
      warmth: '冷暖',
      vibrance: '光感'
    }
  },

  /** M8：手绘遮罩（预览 CSS mask + 画笔层；导出侧用同一份归一化笔画光栅化） */
  mask: {
    title: '遮罩',
    hint: '在预览画面上涂掉不要的区域；坐标归一化，改画幅/缩放不影响已有笔画',
    enter: '进入画笔',
    exit: '退出画笔',
    enterHint: '进入画笔会暂停播放并跳到该段中点，预览画面被画笔层接管（不会误触选中/拖拽手柄）',
    brush: '笔刷大小',
    brushUnit: '% 画面宽',
    mode: '笔刷模式',
    hide: '抹掉',
    restore: '擦回',
    clear: '清空遮罩',
    clearHint: '删除这一段上的全部笔画（可撤销）',
    strokes: (n: number) => (n > 0 ? `${n} 笔` : '无笔画'),
    empty: '还没有笔画：进入画笔后直接在预览画面上按住拖动',
    paintHint: '按住拖动涂抹 · 松手提交一笔 · [ / ] 调笔刷 · Esc 退出画笔',
    feather: '羽化',
    featherHint: '柔化遮罩边缘：0 = 硬边；数值按画面宽度百分比做模糊，预览与导出共用同一张遮罩图',
    invert: '反向遮罩',
    invertHint: '黑白互换：已涂掉的区域变可见、其余变隐藏（预览与导出共用同一张遮罩图）',
    brushHint: '半径按画面宽度的百分比计算，与导出光栅化同一公式（lineWidth = 2·radius%·宽）'
  },

  /** M8-P0：外部 matte（图片/视频文件；与手绘遮罩可叠加，两者都只在导出侧生效） */
  matte: {
    title: '外部 matte',
    import: '导入 matte…',
    importHint: '选择一个图片或视频 matte（白 = 保留、黑 = 隐藏）；仅导出生效，预览仍显示原片',
    remove: '移除 matte',
    removeHint: '删除该段的 matte 引用（不会删除磁盘上的 matte 文件）',
    none: '未导入',
    image: '静态图',
    video: '视频',
    exportingOnly: '外部 matte 仅导出生效（预览仍显示原片）',
    pickFailed: (reason: string) => `导入 matte 失败：${reason}`,
    applied: (name: string) => `已挂载 matte：${name}（导出时生效）`,
    removed: '已移除外部 matte'
  },

  /** M8-P1：AI 人像抠像（Selfie Segmenter；主进程推理生成 matte 视频，仅导出生效） */
  aiMatte: {
    title: 'AI 抠像',
    generate: 'AI 抠像（生成 matte）',
    generateHint: '用本机 ONNX 模型逐帧分离人像，生成 matte 视频后自动挂到本段；仅导出生效，预览仍显示原片',
    runtimeMissing: 'AI 运行时未就绪',
    modelMissing: '模型未就绪',
    ready: '就绪',
    readyHint: '运行时与模型已就绪：生成过程在主进程后台跑，可随时取消',
    cancel: '取消生成',
    generating: (done: number, total: number) =>
      total > 0 ? `正在生成 matte… ${done}/${total} 帧` : '正在准备推理…',
    cached: '已命中缓存，直接复用上次生成的 matte',
    done: 'AI matte 已生成并挂到本段（导出时生效）',
    failed: (reason: string) => `AI 抠像失败：${reason}`,
    installHint: '需要 onnxruntime-node 与 Selfie 模型：执行 npm run fetch:matte:model，或重新安装完整包'
  },

  // 检查器
  inspector: {    preset: '预设样式',
    presetCount: (n: number) => `${n} 套`,
    title: '主标题',
    subtitle: '副标题',
    text: '文字',
    color: '配色',
    font: '字体',
    animation: '动画',
    barOpacity: '方框透明度',
    gradient: '渐变文字',
    gradientFrom: '起始色',
    gradientTo: '结束色',
    gradientAngle: '角度',
    inDuration: '入场（秒）',
    outDuration: '出场（秒）',
    easing: '缓动',
    textReveal: '逐字过渡（字）',
    /** 右侧「当前字幕条」检查器 */
    selectedClip: '当前字幕条',
    noneSelected: '未选择片段',
    noneSelectedHint: '点时间轴或预览选择一条',
    /** P5：点段落只选中不跳转，编辑器里给一个明确的定位入口 */
    locate: '定位到这一段',
    locateHint: '播放头不在这一段的入点→出点里；点一下把画面带到这一段中间',
    fontSizeTitle: '主标题字号',
    fontSizeSubtitle: '副标题字号',
    fontScaleHint: '相对预设字号缩放，受可读上限约束',
    applyAll: '应用到全部',
    applyAllHint: '复制样式到全部，文字与入出点不变',
    applyAllConfirmTitle: '应用到全部字幕条',
    applyAllConfirmBody: (count: number) => `把当前样式复制到其余 ${count} 条；文字与入出点不变。`,
    applyAllDone: (count: number) => `已应用到其余 ${count} 条`,
    applyAllNoTarget: '只有一条字幕条，无需应用',
    /** 切预设 / 清除自定义 */
    customized: (count: number) => `已自定义 ${count} 项`,
    resetAllCustom: '恢复预设默认',
    resetAllCustomHint: '清除本条自定义，回到预设默认',
    resetAllCustomTitle: '恢复预设默认',
    resetAllCustomBody: (count: number) => `清除本条 ${count} 项自定义，回到预设默认；文字与入出点不变。`,
    resetAllCustomDone: '已恢复预设默认',
    presetSameTitle: '重新应用当前预设',
    presetSameBody: (count: number) => `将清除本条 ${count} 项自定义，回到预设默认。`,
    tokens: {
      primary: '主色',
      accent: '强调色',
      text: '主标题色',
      secondaryText: '副标题色',
      barBackground: '方框背景'
    },
    resetTokens: '恢复预设配色',
    resetTokensHint: '只回到预设的颜色与透明度',
    fontFixedByPreset: (roles: string) => `该预设锁定了${roles}字体`
  },

  fonts: {
    import: '导入 TTF 字体',
    builtin: '内置',
    user: '用户导入',
    loading: '字体加载中，导出暂不可用',
    remove: '移除',
    removeBuiltinForbidden: '内置字体不可移除',
    importFailed: '字体导入失败',
    tooLarge: '字体文件超过 100MB 上限'
  },

  project: {
    open: '打开工程',
    saveAs: '另存为',
    autosaved: '已自动保存',
    autosaveFailed: '自动保存失败',
    restoredAutosave: '已自动恢复上次编辑的进度',
    refVideoMissing: '参考视频文件不存在或已被移动，请重新定位。',
    newProject: '新建工程'
  },

  errors: {
    ffmpegMissing: (path: string) => `未找到 FFmpeg：${path}（请执行 npm run fetch:ffmpeg）`,
    ffmpegExited: (code: number | null, tail: string) => `FFmpeg 异常退出（${code ?? '未知'}）。${tail}`,
    alphaDropped: '所选 ProRes profile 不编码 alpha，导出会被降级为不透明。请检查编码参数。',
    verifyFailed: (detail: string) => `产物校验未通过：${detail}`,
    frameTimeout: (index: number) => `第 ${index} 帧渲染超时，任务中止。`,
    diskFull: (need: string) => `磁盘可用空间不足，预计需要 ${need}。`,
    generic: (message: string) => message
  },

  preview: {
    play: '播放',
    pause: '暂停',
    fit: '等比',
    actual: '1:1',
    compactMode: '紧凑（竖屏）',
    ultrawideMode: '超宽上限',
    safeArea: '安全区',
    pickHint: '点选字幕条'
  },

  /** v11：设置页（渲染显卡 / 导出编码 / 诊断信息） */
  settings: {
    title: '设置',
    subtitle: '渲染与导出硬件',
    back: '← 最近项目',
    nav: {
      recent: '最近项目',
      settings: '设置'
    },
    render: {
      title: '渲染显卡',
      preference: '渲染设备偏好',
      active: '当前使用',
      preferred: '将优先使用',
      hint: '预览渲染、视频解码与画面合成由 Chromium 使用所选显卡；切换需要重启应用。',
      softwareRendering: '当前处于软件渲染，硬件加速不可用。',
      emptyTitle: '未检测到可用显卡',
      emptyHint: 'Chromium 正在使用软件渲染。请确认显卡驱动已正确安装，然后重启应用重新检测。'
    },
    encoder: {
      title: '导出编码',
      mode: '编码模式',
      selected: '当前编码器',
      available: '可用 H.264 硬件编码器',
      software: 'libx264（软件）',
      hintHardware: '硬件编码只作用于叠加导出的 H.264 MP4；透明 ProRes 仍由 CPU 编码。',
      hintFallback: '硬件编码不可用或失败时会自动回退 libx264，不会导致导出失败。'
    },
    diagnostics: {
      title: '诊断信息',
      activeDevice: 'Chromium 当前设备',
      appliedPreference: '已应用偏好',
      hardwareEncoding: 'FFmpeg 硬件编码可用',
      yes: '是',
      no: '否'
    },
    loading: '正在检测显卡…',
    error: '显卡检测失败',
    saveError: '设置保存失败',
    retry: '重试',
    restartNote: '已保存。重启 Socut 后切换到所选显卡。',
    /** M11/M8：语音资产（whisper 转写 + RNNoise AI 降噪），离线资产只做本地选择 */
    voice: {
      title: '语音资产（离线）',
      subtitle: '自动字幕与 AI 降噪都在本机运行；二进制与模型由安装包提供或从本地选择，应用不联网下载。',
      status: '状态',
      ready: '就绪',
      missingBinary: '缺少 whisper 二进制',
      missingModel: '缺少 whisper 模型',
      binary: 'whisper.cpp 可执行文件',
      model: 'whisper 模型（ggml-*.bin）',
      language: '识别语言',
      languageAuto: '自动检测',
      languageZh: '中文',
      languageEn: '英文',
      configPath: '配置文件',
      candidates: '候选路径',
      pickBinary: '选择二进制…',
      pickModel: '选择模型…',
      reset: '清除配置',
      refresh: '重新检测',
      none: '（未找到）',
      rnnoiseTitle: 'AI 降噪模型（RNNoise）',
      rnnoiseReady: '就绪（导出可选「AI 降噪」）',
      rnnoiseMissing: '未就绪：导出时选「AI 降噪」会提示先取回模型',
      fetchHint: '取回命令：npm run fetch:whisper / npm run fetch:whisper:model / npm run fetch:rnnoise',
      loading: '正在检测语音资产…',
      saved: '已保存',
      pickCancelled: '已取消选择'
    }
  },

  /** 主界面伸缩布局：区域名用于分隔线实时读数与无障碍朗读 */
  layout: {
    labels: {
      left: '素材栏',
      center: '预览',
      right: '字幕编辑',
      stage: '预览区',
      timeline: '时间轴'
    },
    splitterLeft: '素材栏 / 预览',
    splitterRight: '预览 / 字幕编辑',
    splitterTimeline: '预览区 / 时间轴',
    splitterHelp: '拖拽调整，双击复位',
    reset: '默认布局',
    resetHint: '布局比例记在本机，下次启动自动恢复'
  }
} as const

/** 相位 → 中文。 */
export const PHASE_LABEL: Record<string, string> = {
  queued: TEXT.export.queued,
  preparing: TEXT.export.preparing,
  rendering: TEXT.export.rendering,
  muxing: TEXT.export.muxing,
  verifying: TEXT.export.verifying,
  done: TEXT.export.done,
  failed: TEXT.export.failed,
  cancelled: TEXT.export.cancelled
}
