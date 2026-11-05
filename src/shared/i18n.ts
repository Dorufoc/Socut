/** 中文文案集中（模态提示、进度、错误）。规格 §6 的模态文案必须逐字使用。 */
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
    audioCopy: '音频：直接复制（-c:a copy）',
    audioAac: '音频：转码为 AAC 192k',
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
    addClip: '新建片段',
    removeClip: '删除片段',
    /** v2 媒体轨 */
    splitClip: '拆分媒体段',
    removeMediaClip: '删除媒体段',
    emptyMedia: '媒体轨为空：从素材库把卡片拖上来，或导入时自动铺满全段。',
    inPoint: '入点',
    outPoint: '出点',
    duration: '时长',
    snapHint: '入出点已吸附到当前预览帧率的帧边界',
    empty: '尚无片段，点击「新建片段」开始。'
  },

  // 检查器
  inspector: {
    preset: '预设样式',
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
    textReveal: '逐字过渡跨度（字）',
    /** 右侧「当前字幕条」检查器 */
    selectedClip: '当前字幕条',
    noneSelected: '未选择片段',
    noneSelectedHint: '在时间轴点选一个片段，或直接点预览里的字幕条。',
    fontSizeTitle: '主标题字号',
    fontSizeSubtitle: '副标题字号',
    fontScaleHint: '按预设字号缩放，仍受可读性硬上限约束',
    applyAll: '把样式应用到全部字幕条',
    applyAllHint: '预设 / 配色 / 字体 / 字号 / 动画全部复制，文字内容与入出点保留',
    applyAllConfirmTitle: '应用到全部字幕条',
    applyAllConfirmBody: (count: number) =>
      `将把当前片段的预设、配色、字体、字号与动画复制到其余 ${count} 个字幕条，文字内容与入出点不变。`,
    applyAllDone: (count: number) => `已应用到其余 ${count} 个字幕条`,
    applyAllNoTarget: '工程里只有这一个片段，无需应用',
    tokens: {
      primary: '主色',
      accent: '强调色',
      text: '主标题色',
      secondaryText: '副标题色',
      barBackground: '方框背景'
    },
    resetTokens: '恢复预设配色'
  },

  fonts: {
    import: '导入 TTF 字体',
    builtin: '内置',
    user: '用户导入',
    loading: '字体加载中…导出暂时不可用',
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
    restoreAutosave: '检测到上次未保存的工程，是否恢复？',
    refVideoMissing: '参考视频文件不存在或已被移动，请重新定位。',
    newProject: '新建工程'
  },

  errors: {
    ffmpegMissing: (path: string) => `未找到 FFmpeg：${path}。请先执行 npm run fetch:ffmpeg。`,
    ffmpegExited: (code: number | null, tail: string) => `FFmpeg 异常退出（${code ?? '未知'}）。${tail}`,
    alphaDropped: 'FFmpeg 提示所选 ProRes profile 不会编码 alpha（导出会被降级为不透明）。请检查编码参数。',
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
    compactMode: '紧凑分支（竖屏）',
    ultrawideMode: '超宽上限',
    safeArea: '显示安全区',
    pickHint: '点预览里的字幕条即可选中并编辑'
  },

  /** 主界面伸缩布局：区域名同时用于分隔线实时读数与无障碍 valuetext */
  layout: {
    labels: {
      left: '素材栏',
      center: '预览',
      right: '字幕编辑',
      stage: '预览区',
      timeline: '时间轴'
    },
    splitterLeft: '拖动调整素材栏与预览的宽度（双击恢复默认，方向键微调）',
    splitterRight: '拖动调整预览与字幕编辑的宽度（双击恢复默认，方向键微调）',
    splitterTimeline: '拖动调整预览区与时间轴的高度（双击恢复默认，方向键微调）',
    reset: '恢复默认布局',
    resetHint: '布局比例记住在本机，下次启动自动恢复'
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
