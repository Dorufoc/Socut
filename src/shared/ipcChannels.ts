/** IPC 通道名唯一真值（主进程、preload、渲染进程与测试共用字符串）。 */
export const CHANNELS = {
  appInfo: 'app:info',
  chooseDirectory: 'app:chooseDirectory',
  revealPath: 'app:revealPath',
  writeLog: 'app:writeLog',
  /** 应用内端到端冒烟（FOCUSNEWS_SMOKE=1）：渲染侧跑完后由主进程校验并退出 */
  smokeReport: 'app:smokeReport',
  /** 仅开发：把渲染侧生成的取证图片（逐帧动画评审表）写盘（FOCUSNEWS_REVIEW_SHEET=<png>） */
  devWriteFile: 'app:devWriteFile',
  /** 仅开发：读仓库 spikes/ 下的取证素材（评审表背景帧） */
  devReadFile: 'app:devReadFile',

  projectOpen: 'project:open',
  projectSaveAs: 'project:saveAs',
  projectAutosaveRead: 'project:autosaveRead',
  projectAutosaveWrite: 'project:autosaveWrite',

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
  /** 参考视频预览地址：主进程校验后返回 focusnews-media:// 流地址（找不到返回 null） */
  videoPreviewUrl: 'video:previewUrl',
  /** 水印：选择一张本机图片并探测原图尺寸（用户取消返回 null） */
  watermarkPick: 'watermark:pick',
  /** v2：主进程 ffmpeg 抽帧缩略图，返回 focusnews-thumb://<mediaId>（失败返回 null） */
  mediaGenerateThumb: 'media:generateThumb',
  /** v2：将已登记的 thumb 绝对路径交回自定义协议可读 */
  mediaThumbUrl: 'media:thumbUrl',
  /** v2：素材移出池时回收 userData/thumbs 里的 jpg */
  mediaThumbRemove: 'media:thumbRemove',
  videoCfrConvert: 'video:cfrConvert',

  exportEstimate: 'export:estimate',
  exportStart: 'export:start',
  exportCancel: 'export:cancel',

  /** 主进程 → 渲染侧：请求第 N 帧（pull 背压） */
  frameRequest: 'export:frameRequest',
  /** 渲染侧 → 主进程：一帧 PNG 字节 */
  frameResponse: 'export:frameResponse',
  /** 主进程 → 渲染进程：进度 */
  jobProgress: 'job:progress',
  /** 主进程 → 渲染进程：结果 */
  jobResult: 'job:result'
} as const

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS]
