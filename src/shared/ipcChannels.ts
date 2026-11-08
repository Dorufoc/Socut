/** IPC 通道名唯一真值（主进程、preload、渲染进程与测试共用字符串）。 */
export const CHANNELS = {
  appInfo: 'app:info',
  chooseDirectory: 'app:chooseDirectory',
  revealPath: 'app:revealPath',
  writeLog: 'app:writeLog',
  /** 应用内端到端冒烟（SOCUT_SMOKE=1）：渲染侧跑完后由主进程校验并退出 */
  smokeReport: 'app:smokeReport',
  /** 仅开发：把渲染侧生成的取证图片（逐帧动画评审表）写盘（SOCUT_REVIEW_SHEET=<png>） */
  devWriteFile: 'app:devWriteFile',
  /** 仅开发：读仓库 spikes/ 下的取证素材（评审表背景帧） */
  devReadFile: 'app:devReadFile',

  /** 渲染显卡：体检报告 / 偏好切换 / 编码模式切换 */
  gpuDiagnostics: 'gpu:diagnostics',
  gpuSetPreference: 'gpu:setPreference',
  gpuSetEncoder: 'gpu:setEncoder',

  projectOpen: 'project:open',
  projectSaveAs: 'project:saveAs',
  /** CLI：保存到显式路径（不弹另存为对话框） */
  projectWriteToPath: 'project:writeToPath',
  projectAutosaveRead: 'project:autosaveRead',
  projectAutosaveWrite: 'project:autosaveWrite',

  /** 启动页：最近工程列表 / 新建 / 打开 / 重命名 / 移出列表 / 拍封面 */
  projectRecentList: 'project:recentList',
  projectRecentCreate: 'project:recentCreate',
  projectRecentOpen: 'project:recentOpen',
  projectRecentRename: 'project:recentRename',
  projectRecentRemove: 'project:recentRemove',
  projectRecentCaptureCover: 'project:recentCaptureCover',

  fontsList: 'fonts:list',
  fontImport: 'fonts:import',
  fontReadBytes: 'fonts:readBytes',
  fontRemove: 'fonts:remove',

  videoPickAndProbe: 'video:pickAndProbe',
  /** v2：多文件选择 + 逐文件探测（素材库批量导入） */
  videoPickManyAndProbe: 'video:pickManyAndProbe',
  videoProbe: 'video:probe',
  /** 参考视频文件是否仍存在（规格 §8：文件被移动时要提示重新定位） */
  videoExists: 'video:exists',
  /** 参考视频预览地址：主进程校验后返回 socut-media:// 流地址（找不到返回 null） */
  videoPreviewUrl: 'video:previewUrl',
  /** 水印：选择一张本机图片并探测原图尺寸（用户取消返回 null） */
  watermarkPick: 'watermark:pick',
  /** CLI：按路径探测水印图片尺寸（不弹对话框） */
  watermarkProbe: 'watermark:probe',
  /** v2：主进程 ffmpeg 抽帧缩略图，返回 socut-thumb://<mediaId>（失败返回 null） */
  mediaGenerateThumb: 'media:generateThumb',
  /** v2：将已登记的 thumb 绝对路径交回自定义协议可读 */
  mediaThumbUrl: 'media:thumbUrl',
  /** v2：素材移出池时回收 userData/thumbs 里的 jpg */
  mediaThumbRemove: 'media:thumbRemove',
  /** v5：主进程均匀抽帧并拼成时间帧预览条（Thumbnail Strip）长图 */
  mediaGenerateStrip: 'media:generateStrip',
  /** v9：主进程把片段源区间解成单声道 PCM，折成频谱条的等分桶峰值 */
  mediaAudioPeaks: 'media:audioPeaks',
  /** v10：4K / MXF 预览代理（整片 720p H.264；进度经 job 事件流，jobId 前缀 proxy-） */
  mediaProxy: 'media:proxy',
  /** v10：代理新鲜度查询（源 size/mtime 变化即失效） */
  mediaProxyStatus: 'media:proxyStatus',
  /** v10：素材移出池时回收它的全部代理版本 */
  mediaProxyRemove: 'media:proxyRemove',
  videoCfrConvert: 'video:cfrConvert',
  /** v8.1：防抖预览预处理：主进程后台生成稳定化代理文件（进度经 job 事件流，jobId 前缀 stab-） */
  videoStabPreview: 'video:stabPreview',
  /** v8.1：片段删除/关闭防抖时回收它的代理 mp4 与 .trf 运动数据 */
  videoStabPreviewRemove: 'video:stabPreviewRemove',

  exportEstimate: 'export:estimate',
  exportStart: 'export:start',
  exportCancel: 'export:cancel',
  /** v10：当前帧封面 PNG（媒体 + 字幕 + 水印） */
  exportCover: 'export:cover',

  /** 主进程 → 渲染侧：请求第 N 帧（pull 背压） */
  frameRequest: 'export:frameRequest',
  /** 渲染侧 → 主进程：一帧 PNG 字节 */
  frameResponse: 'export:frameResponse',
  /** 主进程 → 渲染进程：进度 */
  jobProgress: 'job:progress',
  /** 主进程 → 渲染进程：结果 */
  jobResult: 'job:result',

  /** CLI 控制服务 → 渲染进程：执行一条编辑/导出命令 */
  cliCommand: 'cli:command',
  /** 渲染进程 → 主进程：命令结果 */
  cliResponse: 'cli:response',
  /** 渲染进程 → 主进程：命令路由已就绪 */
  cliReady: 'cli:ready'
} as const

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS]
