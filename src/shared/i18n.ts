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
  appTitle: 'FocusNews 新闻字幕条',

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
    cancelled: '已取消'
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
    hoverPreview: '预览轴',
    hoverPreviewHint: '悬停时用黄线预览帧位置'
  },

  /**
   * 左侧「包装」Tab（P6）：字幕 / 片尾 / 水印三块从上到下一次铺开。
   * 片尾先占位——功能未实现就不给假入口。
   */
  wrap: {
    tab: '包装',
    captions: '字幕',
    ending: '片尾',
    endingTodo: '片尾功能尚未实现，后续版本开放',
    endingPlaceholder: '片尾占位',
    watermark: '水印'
  },

  /** 左侧「字幕」Tab：按时间顺序列出全部标题，并且是新建/删除字幕条的唯一入口 */
  captions: {
    tab: '字幕',
    title: '字幕',
    count: (n: number) => `${n} 条`,
    empty: '暂无字幕条',
    add: '新建片段',
    addHint: '在时间轴末尾接一条新的字幕条，随即可在右侧编辑',
    remove: '删除这条字幕',
    removeNamed: (title: string) => `删除字幕条：《${title}》`,
    hint: '选中并跳到中点',
    onAir: '正在显示',
    noTitle: '未填写',
    noSubtitle: '未填写'
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

  /** v9：片段音频（媒体段原声与音频段共用一套控件） */
  clipAudio: {
    title: '音频',
    volume: '音量',
    fadeIn: '渐入',
    fadeOut: '渐出',
    volumeHint: '0%~200%，100% 为原始音量（导出侧 volume 滤镜同一增益）',
    fadeInHint: '从静音升到正常音量所需时间（导出侧 afade=t=in）',
    fadeOutHint: '从正常音量降到静音所需时间（导出侧 afade=t=out）'
  },

  /** v9：片段变速 */
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
    resetHint: '本条音频的音量、渐变与变速全部回到默认值'
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

  // 检查器
  inspector: {
    preset: '预设样式',
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
