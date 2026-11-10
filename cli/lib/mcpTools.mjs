/**
 * M10：MCP 工具表（纯数据，无副作用）。
 *
 * 为什么单独成文件：MCP server 进程要尽量薄，工具表要能被 Node 单测直接 import
 * （`tests/mcpTools.test.ts` 校验"每个工具指向的命令都真实存在于 CLI 注册表"）。
 *
 * 约定：
 * - `name` 用 snake_case（MCP 客户端习惯；与 CLI 的点分命令名解耦）；
 * - `command` 是 `src/shared/cliProtocol.ts` 里的命令名；少数工具（export_wait / preview_frame）
 *   没有 `command`，由 MCP server 自己组合多个命令实现；
 * - `inputSchema` 是 JSON Schema（只用到 type/properties/required/enum/additionalProperties），
 *   与命令参数一一对应（参数名保持 CLI 的 camelCase）。
 */

const str = (description) => ({ type: 'string', description })
const num = (description) => ({ type: 'number', description })
const bool = (description) => ({ type: 'boolean', description })
const obj = (description) => ({ type: 'object', description, additionalProperties: true })
const enumOf = (values, description) => ({ type: 'string', enum: values, description })
const arr = (description) => ({ type: 'array', description, items: { type: 'object', additionalProperties: true } })

function tool(name, description, command, properties = {}, required = []) {
  return {
    name,
    description,
    command,
    inputSchema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false
    }
  }
}

export const MCP_TOOLS = [
  // ---------------------------------------------------------------- 应用/诊断
  tool('socut_version', '应用版本、路径、FFmpeg 可用性与控制服务信息', 'app.info'),
  tool('socut_health', '控制服务健康检查（含渲染进程就绪状态与活跃导出数）', 'app.health'),
  tool('socut_commands', '列出全部 CLI 命令（完整命令表的唯一真值）', 'app.commands'),
  tool('socut_gpu', '显卡与硬件编码器体检', 'app.gpu'),

  // ---------------------------------------------------------------- 工程
  tool('project_list', '列出最近的工程', 'project.recent'),
  tool('project_create', '新建工程并加载到编辑器', 'project.new', {
    name: str('工程名'),
    path: str('工程文件路径（缺省由应用决定）')
  }),
  tool('project_open', '按路径打开工程文件', 'project.open', { path: str('工程文件路径') }, ['path']),
  tool('project_save', '保存当前工程（缺省保存到当前路径）', 'project.save', {
    path: str('另存为路径')
  }),
  tool('project_get', '读取当前工程与选择状态（推荐先调它了解现状）', 'project.get'),
  tool('project_apply', '用完整工程 JSON 覆盖当前工程（复杂编辑的逃生口）', 'project.apply', {
    project: obj('完整 Project JSON')
  }, ['project']),
  tool('project_graphics_z', '图形层 z 档：aboveMedia（默认，压住媒体）/ belowMedia（垫在媒体下）', 'project.graphicsZ', {
    value: enumOf(['aboveMedia', 'belowMedia'], 'z 档')
  }, ['value']),
  tool('project_undo', '撤销', 'project.undo'),
  tool('project_redo', '重做', 'project.redo'),

  // ---------------------------------------------------------------- 多序列
  tool('sequence_list', '列出全部序列（活动序列排第一）', 'sequence.list'),
  tool('sequence_add', '新建空序列（不切换）', 'sequence.add', { name: str('序列名') }),
  tool('sequence_select', '切换当前编辑的序列（会重置选中态）', 'sequence.select', { id: str('序列 id') }, ['id']),
  tool('sequence_rename', '重命名序列', 'sequence.rename', { id: str('序列 id'), name: str('新名字') }, ['id', 'name']),
  tool('sequence_remove', '删除序列（只剩一条时拒绝）', 'sequence.remove', { id: str('序列 id') }, ['id']),
  tool('sequence_duplicate', '复制序列（缺省复制活动序列）', 'sequence.duplicate', {
    id: str('源序列 id'),
    name: str('副本名字')
  }),

  // ---------------------------------------------------------------- 素材
  tool('media_import', '导入素材（含非 16:9 / HDR / VFR 门禁；未确认时会被拦下）', 'media.import', {
    path: str('素材文件路径'),
    ackNon169: bool('确认非 16:9'),
    ackHdr: bool('确认 HDR 降级'),
    vfr: enumOf(['none', 'raw', 'convert'], 'VFR 处理策略'),
    name: str('素材显示名'),
    tags: { type: 'array', items: { type: 'string' }, description: '标签' },
    binId: str('素材分组 id')
  }, ['path']),
  tool('media_list', '列出素材池、分组、轨道与片段', 'media.list'),
  tool('media_probe', 'ffprobe 探测任意媒体文件', 'media.probe', { path: str('文件路径') }, ['path']),
  tool('media_remove', '把素材移出素材池', 'media.remove', {
    id: str('素材 id'),
    removeClips: bool('是否连带删除时间轴引用（缺省 true）')
  }, ['id']),

  // ---------------------------------------------------------------- 字幕条（包装）
  tool('clip_add', '新增一条新闻字幕条', 'clip.add', {
    at: num('时间轴入点（秒）'),
    duration: num('时长（秒）'),
    content: obj('文字内容 { title, subtitle }'),
    presetId: str('预设 id（8 套广播预设之一）'),
    fontId: str('字体 id'),
    animation: obj('动画节奏覆盖'),
    styleOverrides: obj('样式覆盖（令牌/透明度/渐变/字号缩放）')
  }),
  tool('clip_update', '更新字幕条（文字/预设/字体/动画/样式覆盖）', 'clip.update', {
    id: str('字幕条 id'),
    patch: obj('增量字段')
  }, ['id', 'patch']),
  tool('clip_remove', '删除字幕条', 'clip.remove', { id: str('字幕条 id') }, ['id']),
  tool('clip_duplicate', '复制字幕条', 'clip.duplicate', { id: str('字幕条 id') }, ['id']),
  tool('clip_select', '选中字幕条（右侧检查器跟随）', 'clip.select', { id: str('字幕条 id') }, ['id']),
  tool('clip_split', '在指定时间拆分字幕条', 'clip.split', { at: num('拆分时间（秒）'), id: str('字幕条 id') }),
  tool('clip_apply_style_to_all', '把一条字幕条的样式应用到全部字幕条', 'clip.applyStyleToAll', {
    id: str('字幕条 id')
  }, ['id']),
  tool('clip_reset_style', '恢复该条字幕条的预设默认样式', 'clip.resetStyle', { id: str('字幕条 id') }, ['id']),
  tool('clip_key', '设置/清除媒体段抠像（色度键 color/similarity/blend/despill 或亮度键 luma）', 'clip.key', {
    id: str('媒体段 id'),
    key: obj('{ mode, color, similarity, blend, despill, threshold, tolerance, softness } 或 null 清除')
  }, ['id']),
  tool('clip_mask', '设置/清除媒体段手绘遮罩（归一化笔画；预览与导出共用一份数据）', 'clip.mask', {
    id: str('媒体段 id'),
    mask: obj('{ strokes: [{ mode: "hide"|"restore", radiusPct, points: [{x,y}] }] } 或 null 清除')
  }, ['id']),
  tool('clip_matte', '设置/清除媒体段外部 matte（图片或视频，绝对路径；仅导出生效，预览仍显示原片）', 'clip.matte', {
    id: str('媒体段 id'),
    path: str('matte 文件绝对路径；省略或空字符串 = 清除'),
    kind: enumOf(['image', 'video'], '类型（缺省按扩展名判断；.png/.jpg 等=image，视频容器=video）')
  }, ['id']),
  tool('ai_matte', 'AI 人像抠像：主进程生成 matte 视频并挂到媒体段（仅导出生效；需要 onnxruntime-node + Selfie 模型）', 'ai.matte', {
    id: str('媒体段 id')
  }, ['id']),
  tool('ai_matte_status', 'AI 抠像运行时/模型体检（onnxruntime-node 是否可加载、Selfie 模型是否就绪）', 'ai.matte.status'),
  tool('clip_set_times', '设置字幕条入出点', 'clip.setTimes', {
    id: str('字幕条 id'),
    startTime: num('入点（秒）'),
    endTime: num('出点（秒）')
  }, ['id', 'startTime', 'endTime']),
  tool('clip_keyframes', '整份替换字幕条参数关键帧（null 清空）', 'clip.keyframes', {
    id: str('字幕条 id'),
    keyframes: arr('关键帧轨道数组；传 null 清空')
  }, ['id']),

  // ---------------------------------------------------------------- 时间轴（媒体/音频）
  tool('timeline_media_insert', '把素材放到媒体轨', 'timeline.media.insert', {
    mediaId: str('素材 id'),
    at: num('时间轴位置（秒）'),
    duration: num('时长（秒）'),
    sourceIn: num('源入点（秒）'),
    trackId: str('目标轨道 id')
  }, ['mediaId', 'at']),
  tool('timeline_media_move', '平移媒体段（可跨轨）', 'timeline.media.move', {
    id: str('媒体段 id'),
    at: num('目标位置（秒）'),
    trackId: str('目标轨道 id')
  }, ['id', 'at']),
  tool('timeline_media_trim', '裁剪媒体段入/出点', 'timeline.media.trim', {
    id: str('媒体段 id'),
    start: num('新入点（秒）'),
    end: num('新出点（秒）')
  }, ['id']),
  tool('timeline_media_remove', '删除媒体段', 'timeline.media.remove', { id: str('媒体段 id') }, ['id']),
  tool('timeline_media_split', '在指定时间拆分媒体段', 'timeline.media.split', {
    at: num('拆分时间（秒）'),
    id: str('媒体段 id')
  }, ['at']),
  tool('timeline_ripple_delete', '波纹删除：删该段并把同轨后续片段左移合拢', 'timeline.media.rippleDelete', {
    id: str('媒体段 id')
  }, ['id']),
  tool('timeline_merge_next', '与同轨紧邻的下一段合并（同素材/源连续/参数一致）', 'timeline.media.mergeNext', {
    id: str('媒体段 id')
  }, ['id']),
  tool('timeline_freeze', '冻结帧：在切点插入静帧并把后续同轨片段右移', 'timeline.media.freeze', {
    at: num('切点（秒）'),
    id: str('媒体段 id'),
    duration: num('冻结时长（秒，缺省 1）')
  }, ['at']),
  tool('timeline_compact', '媒体轨从左到右紧贴排列（主轨对齐）', 'timeline.compact'),
  tool('timeline_audio_insert', '把音频素材放到音频轨', 'timeline.audio.insert', {
    mediaId: str('素材 id'),
    at: num('时间轴位置（秒）'),
    duration: num('时长（秒）'),
    sourceIn: num('源入点（秒）'),
    trackId: str('目标轨道 id')
  }, ['mediaId', 'at']),
  tool('timeline_audio_remove', '删除音频段', 'timeline.audio.remove', { id: str('音频段 id') }, ['id']),

  // ---------------------------------------------------------------- 音频/转场
  tool('audio_fx', '音频段音量/渐入渐出（增量）', 'audio.fx', { id: str('音频段 id'), patch: obj('增量字段') }, [
    'id',
    'patch'
  ]),
  tool('audio_role', '音频段角色（voice / bgm）', 'audio.role', {
    id: str('音频段 id'),
    role: enumOf(['voice', 'bgm'], '角色')
  }, ['id', 'role']),
  tool('audio_ducking', 'BGM 自动压低档位', 'audio.ducking', {
    id: str('音频段 id'),
    level: enumOf(['light', 'standard', 'strong'], '档位')
  }, ['id']),
  tool('transition_set', '设置片段入场转场', 'clip.transition', {
    id: str('片段 id'),
    transition: obj('{ type, durationSec } 或 null 移除')
  }, ['id']),
  {
    name: 'transition_remove',
    description: '移除片段入场转场',
    command: 'clip.transition',
    // 固定参数：把 transition 置 null（不用在 schema 里表达 null 类型，避免客户端校验差异）
    fixedParams: { transition: null },
    inputSchema: {
      type: 'object',
      properties: { id: str('片段 id') },
      required: ['id'],
      additionalProperties: false
    }
  },

  // ---------------------------------------------------------------- 轨道
  tool('track_add_media', '新增媒体轨', 'track.addMedia'),
  tool('track_add_audio', '新增音频轨', 'track.addAudio'),
  tool('track_remove_media', '删除媒体轨（连同片段）', 'track.removeMedia', { id: str('轨道 id') }, ['id']),
  tool('track_move_media', '调整媒体轨层级', 'track.moveMedia', { id: str('轨道 id'), toIndex: num('目标索引') }, [
    'id',
    'toIndex'
  ]),
  tool('track_rename', '重命名轨道', 'track.rename', { id: str('轨道 id'), name: str('新名字') }, ['id', 'name']),
  tool('track_mute', '轨道静音开关', 'track.mute', { id: str('轨道 id'), muted: bool('静音') }, ['id', 'muted']),
  tool('track_hidden', '轨道隐藏开关', 'track.hidden', { id: str('轨道 id'), hidden: bool('隐藏') }, ['id', 'hidden']),
  tool('track_locked', '轨道锁定开关', 'track.locked', { id: str('轨道 id'), locked: bool('锁定') }, ['id', 'locked']),

  // ---------------------------------------------------------------- 文本元素（M7）
  tool('text_presets', '列出文本元素起始预设（标题/人名条/引语/数字/地点/时间戳/角标）', 'text.presets'),
  tool('text_list', '列出工程里的文本元素', 'text.list'),
  tool('text_add', '新增文本元素', 'text.add', {
    at: num('入点（秒）'),
    duration: num('时长（秒）'),
    presetId: str('预设 id'),
    text: str('文字内容')
  }),
  tool('text_update', '更新文本元素（文字/预设/样式/动画/入出点/关键帧）', 'text.update', {
    id: str('文本元素 id'),
    patch: obj('增量字段')
  }, ['id', 'patch']),
  tool('text_remove', '删除文本元素', 'text.remove', { id: str('文本元素 id') }, ['id']),
  tool('text_select', '选中文本元素', 'text.select', { id: str('文本元素 id') }),

  // ---------------------------------------------------------------- 字幕导入/导出（M11）
  tool('caption_parse', '读取并解析 SRT/ASS 文件，返回 cue 列表（主进程读文件）', 'caption.parse', {
    path: str('字幕文件路径'),
    format: enumOf(['srt', 'ass'], '格式（缺省按扩展名/内容自动识别）')
  }, ['path']),
  tool('caption_import', '把 cue 列表落成新闻字幕条（可替换现有字幕）', 'caption.import', {
    cues: arr('cue 列表：{ startSec, endSec, text }'),
    replace: bool('是否先清空现有字幕条'),
    presetId: str('套用的预设 id')
  }, ['cues']),
  tool('caption_batch', '批量名单 → 首尾相接的字幕条（CSV/JSON/纯文本）', 'caption.batch', {
    text: str('名单原文'),
    format: enumOf(['csv', 'json', 'lines', 'auto'], '输入格式'),
    startSec: num('第一条入点（秒）'),
    defaultDuration: num('每条缺省时长（秒）'),
    gap: num('相邻两条空隙（秒）')
  }, ['text']),
  tool('caption_export', '把当前字幕条导出为 SRT/ASS 文本', 'caption.export', {
    format: enumOf(['srt', 'ass'], '目标格式')
  }, ['format']),
  tool('caption_write', '把字幕文本写入文件（.srt/.ass）', 'caption.write', {
    path: str('目标文件路径'),
    text: str('字幕文本')
  }, ['path', 'text']),
  tool('whisper_status', 'whisper.cpp 二进制/模型就绪状态（离线导入检查）', 'whisper.status'),
  tool('whisper_config', '设置 whisper 二进制/模型路径与语言（离线导入）', 'whisper.config', {
    binaryPath: str('whisper-cli 可执行文件路径'),
    modelPath: str('ggml-*.bin 模型路径'),
    language: str('语言代码（zh/en/…）'),
    threads: num('线程数')
  }),
  tool('caption_transcribe', '用 whisper.cpp 转写音视频并返回 cue 列表（需先配置二进制与模型；长任务）', 'caption.transcribe', {
    path: str('音视频文件路径'),
    modelPath: str('模型路径（覆盖配置）'),
    language: str('语言代码'),
    translate: bool('翻译成英文'),
    threads: num('线程数'),
    minDuration: num('最短字幕时长（秒，用于合并短句）')
  }, ['path']),

  // ---------------------------------------------------------------- 水印
  tool('watermark_set', '设置/替换水印', 'watermark.set', { path: str('水印图片路径') }, ['path']),
  tool('watermark_enable', '启用/停用水印', 'watermark.enable', { enabled: bool('启用') }, ['enabled']),
  tool('watermark_remove', '移除水印', 'watermark.remove'),

  // ---------------------------------------------------------------- 导出
  tool('export_start', '发起导出任务（立即返回 jobId；用 export_wait 等结果）', 'export.start', {
    kind: enumOf(['overlayMp4', 'transparentMov', 'pngSequence'], '出口类型'),
    outputDir: str('输出目录'),
    fileName: str('文件名'),
    quality: enumOf(['high', 'standard', 'small'], '画质档'),
    codec: enumOf(['prores4444', 'qtrle'], '透明 MOV 编码'),
    canvas: obj('目标画布选择'),
    videoCodec: enumOf(['avc', 'hevc', 'av1'], '视频编码'),
    crf: num('CRF 直给（0–51）'),
    encoderPreset: str('软件编码 preset'),
    bitDepth: num('位深 8/10'),
    colorRange: enumOf(['limited', 'full'], '色彩范围')
  }, ['kind', 'outputDir', 'fileName']),
  tool('export_status', '查询导出任务进度/结果', 'export.status', { jobId: str('任务 id') }, ['jobId']),
  tool('export_cancel', '取消导出任务', 'export.cancel', { jobId: str('任务 id') }, ['jobId']),
  tool('export_list', '列出本次会话的全部导出任务', 'export.jobs'),
  tool('export_estimate', '预估输出体积与磁盘是否充足', 'export.estimate', {
    width: num('宽'),
    height: num('高'),
    fps: obj('帧率 { num, den }'),
    frames: num('帧数'),
    outputDir: str('输出目录')
  }, ['width', 'height', 'fps', 'frames', 'outputDir']),
  // 特殊工具：没有单一 command
  {
    name: 'export_wait',
    description: '等待导出任务结束并返回最终结果（轮询 export.status）',
    inputSchema: {
      type: 'object',
      properties: { jobId: str('任务 id'), timeoutMs: num('超时（毫秒，缺省 30 分钟）') },
      required: ['jobId'],
      additionalProperties: false
    }
  },
  {
    name: 'preview_frame',
    description: '渲染指定时刻的一帧并返回 PNG（MCP image content），用于 Agent"看一眼"',
    inputSchema: {
      type: 'object',
      properties: { at: num('时间轴时刻（秒，缺省为播放头）') },
      additionalProperties: false
    }
  },

  // ---------------------------------------------------------------- 项目锁
  tool('project_lock', '申请工程锁（window/agent 互斥；返回 token）', 'project.lock', {
    path: str('工程路径'),
    mode: enumOf(['window', 'agent'], '锁模式')
  }, ['path']),
  tool('project_unlock', '按 token 释放工程锁', 'project.unlock', {
    path: str('工程路径'),
    token: str('锁 token')
  }, ['path', 'token']),
  tool('project_lock_status', '查询工程锁状态', 'project.lockStatus', { path: str('工程路径') }, ['path']),

  // ---------------------------------------------------------------- UI
  tool('ui_set', '切换视图 / 左侧 Tab / 导出范围', 'ui.set', {
    view: enumOf(['launcher', 'editor', 'settings'], '视图'),
    leftTab: enumOf(['media', 'transition', 'wrap', 'export', 'progress'], '左侧 Tab'),
    exportScope: enumOf(['timeline', 'selected'], '导出范围')
  })
]

/** 按名字取工具（MCP tools/call 用）；不存在返回 null。 */
export function findMcpTool(name) {
  return MCP_TOOLS.find((item) => item.name === name) ?? null
}

/** 工具名列表（给需要在启动时打印/校验的调用方）。 */
export function mcpToolNames() {
  return MCP_TOOLS.map((item) => item.name)
}
