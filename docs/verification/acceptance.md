# 验收标准逐条留档（规格 §10 / 计划 M4）

规格 §10 的 10 条验收原文逐条列出，每条给出**可复现的取证入口**与当前状态。
状态只有三种：`通过`（本机已证）、`部分`（本机证了可自动化的一半，另一半必须人工/实机）、
`待外部条件`（本机无法证明）。判定依据的原始数据在 `spikes/`（gitignore，按需重跑生成）。

| # | 验收标准（原文） | 取证入口 | 状态 |
|---|---|---|---|
| 1 | 安装包在无 FFmpeg、无 Node、无 Python 的 Windows 机器上可离线运行 | `npm run dist:win` → `npm run verify:packaged`（静默安装 → 断网冷启动 → 优雅退出 → **覆盖安装（升级）** → 再冷启动 → 卸载）；`npm run check:env` 静态禁网 + 生产 CSP；打包日志 `FFmpeg bundled (<安装目录>\resources\ffmpeg\ffmpeg.exe)` | **部分**：随包二进制、断网等价（`--proxy-server=127.0.0.1:9`）、无外部依赖、**安装/升级/卸载三态**已证（升级后 `ffmpeg-bundled=1`、仍能冷启动）；「真正没装任何运行库的第二台机器」需实机（清单 C1/C2/C8） |
| 2 | 1080p30、10 秒字幕条透明 MOV 导出耗时 ≤ 30 秒 | `FOCUSNEWS_SMOKE=1 …SMOKE_W=1920 H=1080 SEC=10`；`node scripts/smoke-export.mjs --width 1920 --height 1080 --fps 30/1 --seconds 10` | **通过**：应用内 6.67s（300 帧，吞吐 45 fps）；CLI 侧（合成帧，非真实绘制）约 3.5–4s |
| 3 | ProRes 4444 MOV 在 Premiere、DaVinci Resolve 中透明通道正确，无黑边、无预乘问题 | FFmpeg 侧：`smoke-export` 断言 `pix_fmt=yuva*`/`fourcc=ap4h`/alpha 均值 14.77（非全 255）；`tests/ffmpegPipeline.test.ts` 的 alpha 枚举表 + 期望像素 192/64/64；计划 C2 修正 | **待外部条件**：DCC 里的终评必须人工完成（清单第 3 节） |
| 4 | 同一工程导出 1080p30 透明 MOV 与叠加到 **720p 23.976** 参考视频，入出点时间误差 < 1 帧 | `FOCUSNEWS_SMOKE_OVERLAY=1 FOCUSNEWS_SMOKE_REF=<ref-720p23976.mp4>`（主进程逐帧 PSNR 从产物像素量区间）+ `tests/presets.test.ts` M3-7（帧算法逐段 <1 帧） | **通过**：产物 144 帧=参考、`yuv420p`、24000/1001；实测可见区间帧 13..130 vs 声明 12..132（入点 1 帧、出点 2 帧，均在淡入 6/淡出 3 帧窗口内，无泄漏）；算法层面逐段误差 <1 帧 |
| 5 | 非 16:9、HDR 视频导入均触发模态提示，未确认不可继续 | `FOCUSNEWS_SMOKE_GATE=1`（走生产 `importMediaWith` + CompatModal 同一应答动作） | **通过**（v2 枚级）：portrait.mp4→`non169`、hdr.mp4→`hdr`；未确认时 `gateBlocked` 逐枚检查素材池为真（导出按钮禁用并在原因里带展示名）；选「取消」素材池不写入（poolSize=0 断言） |
| 6 | VFR 视频转换 CFR 后 ffprobe 确认帧率一致；直接导入 VFR 时二次提醒生效 | 同上 gate 场景（选「转换并导入」）+ `tests/ffmpegPipeline.test.ts` VFR→CFR PTS 偏差 | **通过**（前半）：CFR 产物主进程独立 ffprobe 得 `r=30/1 == avg=30/1`，重探不再判 VFR，枚级 `vfrPolicy=converted` 且保留 `sourcePath`。（后半）二次提醒为 UI 模态，代码路径 `askVfrSecondConfirm` 在任一段 `vfrPolicy==='raw'` 时必经；真机手机素材需人工（清单 C11） |
| 7 | 音频 `-c:a copy` 成功；不可复制时回退 AAC 并提示 | overlay 冒烟（aac 参考 → copy 成功）+ overlay 冒烟（pcm_s16le 参考 → 预检转 AAC 且带 notice）+ `tests/overlayAudioFallback.test.ts`（注入退出码，5 例） | **通过**：copy 路径产物音轨 `aac` 与参考一致；`pcm_s16le → aac` 且 notices = ["音频已转码为 AAC 192k（原音轨 pcm_s16le 不能直接复制）。"]；运行期 copy 失败只重试一次、不无限重试 |
| 8 | 导出取消后无孤儿 FFmpeg 进程，临时文件被清理 | `FOCUSNEWS_SMOKE_CANCEL=1`（**两种出口各跑一次**：透明 MOV 与 PNG 序列） | **通过**：MOV 中途 15/600 帧、PNG 序列中途 41/600 帧取消；`errorCode=CANCELLED`、`activeJobs=[]`、`artifactExists=false`（PNG 是**目录**型半成品，走 `kind==='dir'` 递归删除分支）、`staleTempDirs=[]`。注：清理发生在结果事件之后的 `finally`，校验用有界轮询（实测 200ms 内完成）而不是单时间点采样 |
| 9 | Yoga 布局在 360p 至 4K、竖屏、超宽屏下字号与条高可读且不失控 | `tests/presets.test.ts` 8 预设 × 8 档（含 9:16 与 21:9）+ 分支覆盖计数 + **标题宽度法则专项**（结构断言两条矩形 `maxWidth === BAR_MAX_WIDTH` 且 root `left === right`；几何断言长文案右缘落在「画宽 − 左边距」上、短文案仍 hug）；`FOCUSNEWS_REVIEW_SHEET` 出图 | **通过**（机器可判部分）：整数像素网格、字号硬上限、compact 副标题单行省略；4K 条高 ≈ 360p 的 6 倍；**标题宽度**：1080p 下短/长文案条宽 440→1717（上限 = root 内容宽 1728，右缘落在 1824 = 1920 − 96；左缘均 x=96）。「观感是否廉价」仍需人看 |
| 10 | 预设样式在真实 1080p 画面上逐帧评审，动画无网页式弹跳与轻浮感 | `FOCUSNEWS_REVIEW_SHEET=…`（8 预设 × 7 关键帧 + 末行「长文案换行」共 9 行，画面由生产同一套 `renderFrame` 产出）；曲线表从源头禁 overshoot（`validatePreset` + `tests/projectSchema.test.ts`）；擦除进度逐帧与 `motionAt` 对照（`FOCUSNEWS_PIXELCHECK` 的 `wipe` 段） | **部分**：评审表可一键产出且每帧都是真实导出像素；动画已是「整体左→右擦除」（无位移、无淡入，仍无 overshoot）；背景为 FFmpeg `testsrc2` 合成画面，**实拍素材观感判定必须人工**（清单第 3 节） |

## 关键纪律（规格 §11）的机器化程度

| 纪律 | 落实方式 | 状态 |
|---|---|---|
| FFmpeg 仅异步 spawn，禁止同步调用 | ESLint `no-restricted-imports` + `no-restricted-syntax` + `check-env` 全仓静态扫描 | 通过 |
| 叠加必须按参考视频参数重新渲染，禁止复用透明 MOV 缩放 | `runOverlayMp4` 阶段一按参考分辨率/帧率重渲染（`restrictToActiveSpan` 限定 span）；`tests/pixelParity.test.ts` 静态禁读显示度量 | 通过 |
| FFmpeg 二进制必须在 asar 外 | `electron-builder.yml` `files` 白名单 + `extraResources`；`check-env` 硬校验；asar 内 172 项不含 ffmpeg | 通过 |
| 时间轴存秒、帧率存分数、全程整数运算 | `src/shared/fps.ts`（含 BigInt 片段区间）+ `tests/fps.test.ts` 互逆 | 通过 |
| 非 16:9 与 HDR 模态阻断，未确认不得导入或导出 | `CompatModal` + `gateBlocked`（v2 枚级：逐枚检查素材池，UI 禁用导出按钮）+ `useExportJob.assertGate`（主路径二次拦截） | 通过 |
| 渲染以帧序号驱动，预览 Canvas 不参与坐标计算 | `renderFrame(ctx, job, globalFrame)` 单一像素生产者 + `FOCUSNEWS_PIXELCHECK` 逐像素比对（导出字节 = 预览原生层，DPR=1.5 下仍成立） | 通过 |

## 三个出口的覆盖情况（规格 §2.3）

| 出口 | 应用内真实管线 | CLI 不依赖 Electron | 备注 |
|---|---|---|---|
| 透明 ProRes 4444 MOV（主路径 rawvideo 直送 stdin） | 通过（6.78s/300 帧；取消已证） | 通过 | `ap4h`/`yuva444p12le`/alpha 非全 255 |
| 透明 MOV 的 PNG 序列回退（`frameDelivery='pngSequence'`） | **通过**（`FOCUSNEWS_SMOKE_DELIVERY=pngSequence`：60 帧 / 1.57s，产物 `ap4h`+`yuva444p12le`+30/1+tv，预估/实际 1.46） | 通过（`--png-seq`） | 回退本质上多一次逐帧 PNG 压缩 + 落盘 + 二次编码，外推 1080p30/10s = 70.5s；≤30s 只适用于默认路径（否则是假阳性失败），回退路径单独给 150s 上界 |
| PNG 序列独立出口 | **通过**（60 帧全为合法 RGBA PNG；取消时目录回收已证） | — | C40 修复前它产出的是裸 RGBA 假 PNG |
| MP4 叠加压制 | 通过（720p23.976 与 1080p30/pcm 两个参考） | 通过（`--overlay`） | 逐帧 PSNR 量出入出点包络 |

## 与计划「固定选型」的偏差（已确认方向，留档）

- **帧交付主路径**：计划写「image2pipe 直送 stdin」。实测 PNG 逐帧压缩是吞吐瓶颈（360p 9.7ms/帧 vs 绘制 0.14ms/帧），
  按线性外推会卡在验收第 2 条，故主路径改为**未压缩 RGBA rawvideo**（C17），`image2pipe` 保留为 UI 可切换的
  `pipeTransport='png'` 与独立的 PNG 序列出口。1080p30/10s 实测 6.78s。
- 其余固定选型逐项与安装版本一致：Electron 45.2.1 / React 19.3.1 / TS 5.9.3 / yoga-layout 3.2.1（`yoga-layout/load`）/
  zustand 5.0.16 / vitest 4.1.12 / electron-builder 26.18.0 / vite 7.3.7 / electron-vite 6.0.0 / `engines.node >=22.12.0`。

- **广播安全区比例（需产品侧定夺）**：计划 §2 写 `ACTION_SAFE=0.95 / TITLE_SAFE=0.90`（每边 2.5% / 5%），
  实现采用 `0.93 / 0.80`（每边 3.5% / 10%），分别对应 SMPTE ST 2048-1 的 HDTV 动作安全区与
  EBU R 95 的标题安全区，对文字类内容更保守。两套都满足「标题内缩 > 动作内缩」。
  现在两个值都被 `tests/units.test.ts` 以绝对值钉住（旧断言从常量反推，改了不会报错），
  差异也记在 M0.md 的 C43。**要回到计划数值只需改两个常量**（预设全走 `safe-*` 令牌，无硬编码）。

- **PNG 序列出口的实现方式**：计划 §5 写的是用 FFmpeg 输出 `-c:v png -pix_fmt rgba`；
  实现直接把 Canvas 的 PNG 字节落盘（同一格式，少一次解码再编码）。两者输出等价，
  但后者曾因为 `frameFormat` 默认改成 raw 而产出裸 RGBA 假 PNG（C40），现已由签名硬校验拦住。

## 标题宽度、层叠顺序、逐字过渡与擦除动画（像素级判据）

判据不靠「看截图」，而是写进 `FOCUSNEWS_PIXELCHECK` 的 `wipe` 段（`spikes/pixel-parity.json`）：
在主条 / 副条高度中段扫描不透明像素包围盒，逐帧与 `motionAt` 对照（容差 2%）。

> **2026-11-05 更正（双轨重构随修）**：自「字幕条自适应宽度 + 整体擦除」重设计后，
> 擦除跨度是**实际绘制内容的横向包络**（`layers.contentBoundsOf`）而不是 root 盒，条宽随文案在
> minWidth/maxWidth 之间自适应。`runPixelParityCheck` 的 D 段判据当时没跟着改，一直在拿旧版式
> （满宽条 + root 跨度）的期望比对新渲染结果；本次拉回与 `renderFrame` 同一口径，下表读数为修复后实测。

| 需求 | 实现 | 实测读数 |
|---|---|---|
| 主条左缘钉在布局边距上，宽度随文案自适应 | 条宽 hug 文字：`min(440px@1080p, 29%)` 一类保底，上限统一为 `BAR_MAX_WIDTH`（= root 内容宽）；root 仍同时声明 `left`/`right` 为同一**布局边距**令牌（= 安全区 × 0.5） | 1080p：短文案条宽 **440**、长文案 **1717**（上限 1728，最长行余量 11px；左缘均 x=96）；root 左右边距 **96 / 96**（在 root 自身验） |
| 边距为原安全区的一半 | `LAYOUT_INSET_SCALE = 0.5`（`layout-*` 令牌），`safe-*` 与辅助线不变 | 左/右边距 96（原 192）；底部边距 54（原 108） |
| 副标题在主标题上面 | 子节点顺序「副条 → 主条」，`-overlapY` 移到主条上边距 | **subBarTop=860 < barTop=922** |
| 副条仍按文字自适应 | 副条 `maxWidth` = 与主条同一个上限（hug） | 副条实测 150px → 759px（短 → 长） |
| 文字逐字渐隐渐现 | `layers.charStagger()`：每个字按索引错峰，入场用 `wipeTo`、出场用 `wipeFrom`（与条块同源） | 入场早期已有字出现且均在擦除线以内；同帧各字 alpha 不全相同（`tests/pixelParity.test.ts`） |
| 超过条宽自动换行 | 标题 3 行 / 副标题 2 行，共用一个 `TextMeasurer.wrap()`；条高随行数长高 | 44 字标题 1 行 → 2 行 |
| 所有矩形左→右擦除 | 整条字幕**一条**绝对擦除线（跨度 = 内容包络）：入场右边界右推、出场左边界右推 | 入场 L 恒 96、R 240→535（=96+440-1）；出场 L 441→508→532、R 恒 535 |
| 擦除进度与帧号一致 | `motionAt` 的 `wipeTo/wipeFrom`（stackedNews 预设 8/5 帧短擦除） | 可见比 0.2159/0.0636/0.0091 vs 预期 0.216/0.064/0.009（偏差 ≤ 0.002） |
| 动画不改布局 | 几何只在布局层算一次，动画只落 clip | 落地几何（x/y/w/h）入场帧与稳态帧逐项相等；稳态帧无 clip |

评审表同步加了第 9 行「长文案换行」：`npm run verify:all` 的最后一步会重生成 `spikes/artifacts/review-sheet-1080p.png`（3692×3048）。

## UI 视觉证据的正确取法（本轮实测结论）

打包版取证脚本里的屏幕截图（`CopyFromScreen`）现在能拿到真实桌面像素，
但**拿到的是 IDE 而不是应用窗口**：`SetForegroundWindow` 在 Windows 前台锁定策略下并未生效，
窗口虽在 `GetWindowRect` 返回的坐标上却被遮盖。因此屏幕截图不能当作应用 UI 的证据；
可靠路径仍是应用自身的 `webContents.capturePage()`（`FOCUSNEWS_SHOT=<png>`），
它拿的是 Chromium 内容区的真实绘制结果（已证：`ui-shot-1080p.png`、`ui-shot-directpipe.png`、`ui-shot-refmissing.png`）。

## 双轨时间轴与素材库（v2，阶段 2–9）的机器化验收

| 能力 | 实现 | 取证入口 / 状态 |
|---|---|---|
| 主进程批量导入 + 枚级缩略图协议 | `video:pickManyAndProbe`（多选逐文件探测，单文件失败不阻断整批）；`thumbProtocol.ts`：ffmpeg 抽帧落 `userData/thumbs/<mediaId>.jpg`，`focusnews-thumb://<mediaId>` 仅读已登记项；移出池回收文件 | `tests/ffmpegArgs.test.ts`（缩略图 argv 快照）；应用内启动路径随 `npm run verify:all` 门禁通过 |
| 素材池/媒体轨 store 动作 | `projectStore`：addMedia/removeMedia/relocateMedia/ack 枚级、insert/move/trim/remove、`splitTargetAt`/`removeTargetAt`/`removeSelected`（v10 P3：目标段由 `shared/timelineTargets` 统一解析）；时长恒等式 `timelineEnd-timelineStart === sourceOut-sourceIn` 唯一写入口 | `src/renderer/src/state/projectStore.test.ts` + `tests/mediaClips.test.ts`（纯函数：拆分/仅重叠右移/时间↔源换算）+ `tests/timelineTargets.test.ts`（目标解析与字幕/音频拆分） |
| 旧工程迁移 | `normalizeProject` v1→v2：`refVideo` 折叠为 `media[0]` + 覆盖整段的 mediaClip，旧字段不回流 | `tests/projectSchema.test.ts`（迁移两组） |
| 左侧 Tab 壳 + 素材库 | `App.tsx` rail__tabs 由 `shared` 的 `LEFT_TABS` 生成（v10 P6 后 4 个：素材库/包装/导出/进度，同一时刻只展开一个，窄侧栏里自动换行而不被裁切）；卡片拖拽携带 `application/x-focusnews-media` | `tests/projectSchema.test.ts`「leftTab 归一化」5 例 + `Timeline.test.tsx` v2 媒体轨 4 例 + `FOCUSNEWS_SHOT` 出图（`spikes/artifacts/ui-wrap-rail.png`） |
| 水印（Watermark）模块 | `WatermarkPanel`（v10 P6 起在左侧「包装」Tab 内、字幕区下方）：导入本机图片（`watermark:pick` 用 ffprobe 取原图宽高）、启用/停用/移除；`ffmpegArgs.computeWatermarkGeometry` 以 1080P 为基准（显示尺寸 = 原图 32%，距顶/左各 30px）按输出高度等比换算，四条合成路径统一作为**最后一层** overlay 叠在字幕条之上；预览用同一函数定位 `<img>`（不进 Canvas，透明出口永不烧录台标） | `tests/watermark.test.ts`（几何/argv/图片解析/持久化 20 例）+ `WatermarkPanel.test.tsx`（导入/开关/移除/读数 9 例）+ `WrapPanel.test.tsx`（合并后仍在包装区内）+ `tests/ffmpegPipeline.test.ts`（真机 FFmpeg 取像素判定：两阶段单输入 / trim+concat 拼接 / 直管道 3 例） |
| 双轨时间轴 + 落点高亮 | 媒体轨/字幕轨共享尺规与播放头；拖拽悬停显示吸附落点竖线；v10 P3：工具栏只留一个「拆分」与一个「删除」，作用于选中段（未选中退到播放头处媒体轨最下层），没有目标就给提示而不是置灰 | `Timeline.test.tsx`（拆分/删除目标解析、空隙提示、选中/尺规跟随） |
| 预览按 mediaClip 切源 | `PreviewStage`：播放头落在哪段，`<video>` 就换那枚源文件，`currentTime` 按 `sourceTimeOf` 换算；段间空隙回棋盘格；无 mediaClips 时保留 v1 兼容 | 逐像素一致性（M1-7）仍走同一 `renderFrame`，本次重跑通过 |
| Ctrl+B 剪切 | `App.tsx` keydown：输入控件内不拦；先暂停再 `splitTargetAt(displayTimeSec)`；Delete 走 `removeSelected()`（只删选中的段，不做播放头默认解析） | UI 快捷键（可人工验证）；拆分本体由 store 单测覆盖 |
| 多输入 trim+concat 导出 | `ExportRequest.overlay.segments`（主进程按段 trim 后 concat，空隙补黑+静音；单段整段覆盖时回退旧单输入 argv 不变）；拼接路径音频强制 AAC 并提示 | `tests/ffmpegArgs.test.ts` v2 新增 5 例（滤镜链/两阶段/直管道 argv）；叠加冒烟（单段回退）仍通过 |
| 素材完整性枚级看护 | `useMediaIntegrity` 遍历 MediaItem 池查存在性 → `missingMediaIds` 驱动卡片角标与叠加禁用；重新定位走生产导入路径 | 代码路径与 v1 同构（旧 `useRefVideoIntegrity` 删除）；`FOCUSNEWS_SHOT_REFMISSING` 取证保留 v1 兼容分支 |
| leftTab 持久化与旧值迁移 | `uiStore.leftTab` 为真值，`App.tsx` 分叉时补写 `project.ui.leftTab`，自动保存落盘、启动恢复；v10 P6：`normalizeLeftTab` 把旧工程的 `captions` / `watermark` 一律迁到 `wrap`，不认识的值丢弃（避免恢复出一个已经不存在的 Tab） | `tests/projectSchema.test.ts`「leftTab 归一化与旧值迁移」5 例；隔离 profile 写入 `leftTab: "captions"` 冷启动后落在「包装」（`spikes/artifacts/ui-wrap-tab.png`） |

## 主界面伸缩布局（v3）的机器化验收

| 能力 | 实现 | 取证入口 / 状态 |
|---|---|---|
| 三栏 + 下方轨道的可拖拽分区 | `.shell`（CSS 变量宿主 + 测量目标）→ `.body` 五列 Grid（`--pane-left` / 分隔线 / `minmax(0,1fr)` / 分隔线 / `--pane-right`）+ 横分隔线 + `--pane-timeline`；`Splitter` 为 `role=separator` 的独立网格项，面板各自 `min-width/height:0` + `overflow` 裁切，层级不互叠 | `tests/paneLayout.test.ts`（总宽/总高恒等容器、极窄容器让位、保底不越界）；`FOCUSNEWS_SHOT=spikes/artifacts/ui-pane-layout.png` 已出图 |
| 拖拽实时反馈与双向拖拽 | 指针捕获 + 命令式写 CSS 变量（拖拽中**不重渲染**外层界面），HUD 气泡显示「被治理区域 + 邻居」的 px 与百分比；同一条线同时改两区（时间轴 +40 ↔ 预览 −40） | `Splitter.test.tsx`（按下/跟随/抬起、钳制、方向系数、键盘、双击复位、ARIA 读数）+ `usePaneLayout.test.tsx`（拖拽期间渲染次数不变、变量已生效） |
| 布局偏好持久化 | `shared/paneLayout` 存比例（与分辨率无关）+ `layout/panePrefs` 落 `localStorage` 键 `focusnews.layout.panes.v1`（带版本）；脏数据/隐私模式/配额异常一律回落默认，不阻断渲染 | `tests/paneLayout.test.ts`（像素↔比例往返、脏数据丢弃）+ `panePrefs.test.ts`（读写/删除/异常存储 5 例）+ `usePaneLayout.test.tsx`（冷启动默认、按比例恢复、窗口缩放保持比例、恢复默认清存档） |
| 预览叠加层绑定画面框 | 伸缩布局会把预览区拖成任意宽高比，而目标分辨率比例不变：`containFrameRect`（`render/hitTest.ts`，内缩 `STAGE_INSET_PX`）算出**与目标分辨率同比例**的画面框，Canvas / 参考视频 / 水印 / 角标 / 提示语全部装进同一个 `.stage__frame`；`usePreviewLoop` 另监听 Canvas 盒子，尺寸一变就置脏重画（否则暂停态下浏览器只能把旧位图非等比拉伸到新盒子 → 画面被压扁）；点选 `displayToNative` 改用画面框为 rect（拿容器盒子算会把黑边算进画面） | `tests/hitTest.test.ts`「画面框」6 例（比例只由目标分辨率决定、容器内不越界、扁/高容器居中装入、比边距还小时不为负、水印相对画面占比不变、点选不再有黑边偏差）；逐像素一致性（M1-7）在 `verify:all` 重跑仍通过（dpr 1.5 / blitSize 1440x810）；`FOCUSNEWS_SHOT=spikes/artifacts/ui-stage-frame.png` 可见棋盘格即为 16:9 画面矩形 |

## 字幕条自定义参数与预设联动（v3.1）的机器化验收

| 能力 | 实现 | 取证入口 / 状态 |
|---|---|---|
| 编辑即响应（配色 / 字体 / 字号 / 渐变 / 透明度 / 动画 / 文字） | 全部走 `updateClip` → `revision` 自增 → `usePreviewSpec` 重建 → `usePreviewLoop` 置脏重画；写回的是**差集**（`clipStyle.tokensDelta` / `fontScaleDelta`），等于预设声明的值不存进覆盖，`mergeOverrides` 对 tokens/fontScale 整组替换且空集/同值删键 | `tests/clipStyle.test.ts`（差集/删键/计数 19 例）+ `projectStore.test.ts`「切预设与清除自定义」7 例 + `ClipInspector.test.tsx`「改配色：只写偏离预设的令牌」 |
| 切预设即时应用 + 还原默认 | `updateClip` 见到 `presetId` 走 `clipWithPresetDefaults`：`styleOverrides` 清空、`fontId` 回 `DEFAULT_FONT_ID`、`animation` 回预设声明；文字与入出点不动。重复点当前预设同样还原，`PresetPicker` 先弹二次确认；检查器底部「恢复预设默认（N）」走 `resetClipStyle` | `PresetPicker.test.tsx` 5 例（切预设无确认即还原、同预设确认前不改/取消不改、无自定义不弹窗）+ `ClipInspector.test.tsx` 恢复默认 2 例 |
| 改动落在看得见的帧 | `clipStyle.revealTargetSec`（纯函数）判定「入场完成→出场开始」窗口，`useRevealClip` 通过 `uiStore.seekHandler`（App 注册）跳转；播放中与已可见时不动播放头 | `tests/clipStyle.test.ts`「编辑后把播放头带到看得见的帧」4 例 + `ClipInspector.test.tsx` 断言 seekHandler 收到 `startTime + inDuration` |

## 字幕轨示意条与左侧「字幕」Tab（v4）的机器化验收

| 能力 | 实现 | 取证入口 / 状态 |
|---|---|---|
| 字幕轨只留一条上下更窄的示意条 | `ClipCard` 不再渲染副标题/预设名/秒数行：摆位本身就是该字幕在当前画面的**入点→出点**区间（与全局播放头同一 `secToPx` 口径）；CSS 高度 56/50px → 22px 并用 `top:50% + translateY` 居中；入出点拖拽手柄与平移保留；完整读数不丢，进 `title` / `aria-label` | `Timeline.test.tsx`「Timeline 字幕轨示意条」3 例（标签只有主标题、旧 meta 行消失但 title 里仍有时间码、无主标题时用可读占位）；`FOCUSNEWS_SHOT=spikes/artifacts/ui-caption-strip.png` 已出图 |
| 当前位置相对出入点的可视化 | 播放头落在区间内时条内画一条细游标（`clip-card__cursor`，left 由 `secToPx(playhead) - left` 给出）并提亮条体（`clip-card--onair`） | 同上：区间外无游标、区间内有游标且 left 为有限正像素值 |
| 左侧「字幕」Tab：按时间顺序的标题列表 | 新 `CaptionListPanel`（`leftTab === 'captions'`）；面板内显式 `sort(startTime)`（不依赖片段写入顺序）；每项 = 主标题 + 副标题 + 入点→出点时间码 + 预设名，播放头落在区间内的项标「正在显示」 | `CaptionListPanel.test.tsx` 7 例（乱序工程仍按时间输出、每项含主/副标题、空态、选中态 aria-pressed、onAir 只标一条） |
| 点一条 = 选中 + 跳到入点（预览与轨道同步） | `selectClip(id)` → 右侧检查器随即显示；`uiStore.seekHandler`（App 注册的 `seekTo`，含 `setDisplayTime`）落到 `clip.startTime`；播放中先 `setPlaying(false)`（与时间轴刮擦接管播放头同一口径，否则跳过去立刻被时钟带走） | `CaptionListPanel.test.tsx`：seek 收到入点秒、播放中点击先暂停、无 seekHandler 时仍选中不抛异常 |

## 媒体轨时间帧预览条（Thumbnail Strip，v5）的机器化验收

| 能力 | 实现 | 取证入口 / 状态 |
|---|---|---|
| 按片段时长均匀抽帧并覆盖整个 `[sourceIn, sourceOut]` | 主进程**一次** FFmpeg 调用：`-ss/-t`（输入选项，关键帧快定位）限定窗口 + `fps=N/duration` 重采样 + `scale=128:-2,setsar=1,tile=Nx1:padding=0:margin=0` 横向无缝拼接；密度由卡片像素宽决定（每约 44px 一格），走**档位** `[3,4,6,8,10,12,16,20,24]` 并夹到区间内真实帧数 | `tests/ffmpegArgs.test.ts` argv 快照 2 例（-ss/-t 在 -i 前、tile 格数与 fps、退化输入）；真机实证：8 格→1024x72、24 格→3072x72、不足格数时补位仍出图、`-ss` 越过片尾 → 退出码 -22 不产图 |
| 预览条作为卡片底图，文字不丢 | `.media-clip-card__strip` 拉满卡片（`object-fit: fill`，需求明确不要求保持原始比例）；素材名与源入出点移到底部渐变遮罩上 | `MediaClipCard.test.tsx`（请求参数与格数、长图铺底、无占位符时不重复请求） |
| 悬停读数 + 点一格跳转 | 位置→时间用 `stripTimeAtFraction`（与拖拽同一口径吸附帧边界，同时给源坐标与时间轴坐标）；读数与位置**命令式**写入（指针移动不重渲染）；跳转仅在「按下与抬起位移 ≤ 3px」时发生 | `tests/mediaStrip.test.ts`（两端/中点/越界钳制/非整帧吸附）+ `MediaClipCard.test.tsx`（悬停读数、点击跳转、拖拽不跳转、手柄不跳转） |
| 失败占位 | `url=null`（源不在 / FFmpeg 缺失 / 抽帧报错 / 区间越界）时卡片显示斜纹底 + 图标 + 「无法预览」；素材已移出则单独文案且不发请求；失败结果也进缓存，不会重轰炸主进程 | `MediaClipCard.test.tsx` 两组用例；门禁实测：`spikes/tmp-integration/gate-userdata/strips/` 生成 3 张长图（命名 `<mediaId>-<16位令牌>.jpg`） |
| 缓存与性能 | 三层：会话内存缓存（key 含**实际文件路径**，换源不换轨必频失效）→ 主进程同 token 并发合并 → 磁盘缓存 `userData/strips`（命中不起子进程，超 240 个按 mtime 淘汰）；渲染侧并发闸门 `STRIP_MAX_CONCURRENT=2` | `tests/mediaStrip.test.ts`（键含 path、令牌稳定且只含十六进制、前缀安全化）+ `MediaClipCard.test.tsx`（同 key 不重请、改入出点重请、逐像素拖宽不跨档不重请）；`verify:all` 20/20 且应用内冒烟真实跑过这条链路 |

## 视频片段编辑器与 MXF 支持面（v6）的机器化验收

| 能力 | 实现 | 取证入口 / 状态 |
|---|---|---|
| 选中媒体段 → 右栏切到视频编辑器；选中字幕条 → 保持原字幕检查器 | `projectStore.selectionKind`（`selectClip` 置 `subtitle`、`selectMediaClip` 置 `media`、删除最后一条媒体段时退回 `subtitle`），`ClipInspector` 只当分流，原字幕实现原封不动搬到 `SubtitleClipInspector` | `projectStore.test.ts`「媒体段画面编辑与检查器分流」5 例 + `MediaClipInspector.test.tsx` 前两例（三段分区、切回字幕检查器） |
| 几何变换：缩放 / 水平位移 / 垂直位移 / 旋转 | `MediaClip.video`（v6，缩到片段级；默认 100% / 0 / 0°）→ `shared/mediaClipVideo.mediaVideoTransform` 输出**固定顺序**的 CSS transform（平移→旋转→缩放→镜像），预览里直接作用在 `<video>` 上 | `tests/mediaClipVideo.test.ts`（默认 none、组合顺序、单项输出、越界夹心）+ `MediaClipInspector.test.tsx`（滑杆写回、拉回 100% 即整键删除） |
| 画面交互层：拖角缩放 / 拖画面平移（含辅助线）/ 拖旋转手柄 | 选中媒体段且该段在播放头下才挂出 `StageTransformOverlay`（`selectionKind==='media'` + `uiStore.stageInteract` + 段匹配），画面轮廓与手柄吃指针、其余穿透；几何计算全在 `shared/mediaClipVideo`（`mediaVideoCorners` / `scaleFromPointer` / `rotationFromPointers` / `snapOffset`），拖拽只写同一个 `updateMediaClipVideo`，所以面板数字实时跟着变；命中「居中 / 边对齐」时吸附并画虚线导引线，拖拽中出读数 HUD；面板上的「交互」开关是遮住字幕点选时的逃生口 | `StageTransformOverlay.test.tsx` 7 例（手柄几何、拖角翻倍→200%、平移 5%、居中吸附回到默认整键删除、旋转 90° 与 350°+90°→80°）+ `mediaClipVideo.test.ts` 几何 7 例 + `MediaClipInspector.test.tsx`（开关同步 uiStore） |
| 色彩与光影：亮度/曝光/对比度/饱和度/冷暖/光感 + 四条自由曲线 | 亮度/对比度/饱和度/光感补偿 → CSS `brightness/contrast/saturate`；曝光与冷暖 → 按通道增益；曲线（亮度 + R/G/B，可自由打点）→ `curveTableValues` 把「亮度曲线 → 单通道曲线 → 光感提亮 → 通道增益」合成 `feComponentTransfer tableValues`，三者汇成一张 SVG 滤镜（`focusnews-media-grade`）挂在同一个 `<video>` 上 | `mediaClipVideo.test.ts`（曲线归一/插值/合成顺序、直线不挂 SVG、tableValues 长度与夹心）+ `MediaClipInspector.test.tsx`（点空白加点并拖到 0.5→0.8、四通道切换只写对应通道、复位回直线） |
| 光感（Vibrance/光感）算法 | 放弃「当饱和度用」的旧口径，改为 `lightToneWeight` 中调加权（`4x(1-x)` × `(1-0.3x)`）+ 端点锁定：正值只抬中调、高光受保护，负值压中调；再叠一层很小的饱和补偿 `lightToneSaturate`（100 分只有 ×1.08，而饱和度滑杆是 ×2），对应 Premiere/剪映「通透不冲顶、肤色不炒熟」的手感 | `mediaClipVideo.test.ts`「光感（vibrance）」5 例：端点不动、中调幅度大于高光、负值压中调、补偿远小于饱和度滑杆、滤镜串里是 `saturate(1.040)` |
| 画面翻转：水平 / 垂直镜像 | 两个独立开关（`flipH` / `flipV`），CSS `scaleX(-1)` / `scaleY(-1)` 接在缩放之后 | `mediaClipVideo.test.ts`（单项输出）+ `MediaClipInspector.test.tsx`（两开关互不影响、再点即关、aria-pressed） |
| 一键恢复默认 | 顶部「恢复默认」走 `resetMediaClipVideo`（整键 `video` 删除）；曲线块另给「复位」（只清当前通道） | `projectStore.test.ts`（重置只清当前段）+ `MediaClipInspector.test.tsx`（无编辑时禁用、有编辑时一键清空） |
| MXF 导入与解码 | `IMPORTABLE_VIDEO_EXTENSIONS` 加入 `mxf`（导入对话框用它）；预览协议 `mediaRange` 认 `video/mxf`（不再 octet-stream）；探测/导出走 FFmpeg 原生 mxf 解封装 | `tests/mxfSupport.test.ts` 3 例；真机实证：`ffmpeg -f mxf` 生成的 mpeg2video 1280x720/25fps 夹具被 ffprobe 正确读出（codec/尺寸/帧率/时长全对）。**预览限制**：Chromium 无 MXF 解封装器，`<video>` 会 onError → 预览区显示「不可预览」并保留字幕叠加，需代理转码才能看到 MXF 画面 |

## 时间轴工具栏（v6.2）的机器化验收

| 能力 | 实现 | 取证入口 / 状态 |
|---|---|---|
| 主轨对齐（snap-together） | `uiStore.timelineTools.snapTogether`；打开即调 `projectStore.compactTimeline()` → `shared/mediaClips.compactMediaClips`：按 `timelineStartSec` 升序、按**帧数**平移，间隙恒为 0 且时长与源出点保持恒等式；只动媒体轨，字幕轨允许留空；拖拽抬手（`MediaClipCard.onCommit`）在开关开着时重新摆紧；关闭后不回滚 | `tests/timelineSnap.test.ts`「主轨对齐」4 例（紧贴/单条归零/幂等/空轨）+ `Timeline.test.tsx`「主轨对齐打开…间隙为 0」 |
| 自动吸附（magnetic snap） | `uiStore.timelineTools.magneticSnap`；`shared/timelineSnap`：像素窗口 `TIMELINE_SNAP_PX=10` 按「轨道宽/总时长」折成秒，候选边缘 = 两轨所有片段首尾 + 0 点（**排除被拖的那条**）；整段平移时首尾各试一次取位移小的，拖入/出点只吸被拖的那条边；命中时 `Timeline` 在两轨各画一条强调蓝高亮线 | `timelineSnap.test.ts` 9 例（窗口换算/候选收集/单边/整段/夹取）+ `Timeline.test.tsx`「自动吸附打开…被吸住并高亮」「关闭…不吸附」 |
| 预览轴（hover preview） | `uiStore.timelineTools.hoverPreview`；鼠标在时间轴上移动时按媒体轨矩形把 x 折成帧（`snapTimeToFrame`），两轨各画一条黄色竖线 + 当前帧码胶囊；根节点加 `timeline--hover-preview` 把蓝色播放头 `visibility: hidden`（“暂时替换”）；移出面板或关掉开关立即收起 | `Timeline.test.tsx`「预览轴：开着时悬停出黄线并顶掉蓝色播放头，移出即消失」 |
| 工具栏三个开关的选中态 | 复用 `btn--sm` + `btn--primary`（选中态背景变强调色）+ `aria-pressed`，说明只在 `title`；与既有「新建/删除/拆分」按钮同一条工具栏，中间用分隔线隔开 | `Timeline.test.tsx`「三个开关默认关闭，点一下变选中态」 |

## 防抖稳定（v8）的机器化验收

算法路线：ffmpeg 内置 vidstab 两段式（网格运动检测 + `vidstabtransform` 逐帧动态最优缩放），不引入 Python/OpenCV 旁路；口径 = 「用 crop=keep 保留边框避免黑边，用 optzoom=2 最小化画幅损失」。参数名全部经本机 `resources/ffmpeg`（Gyan 9.0.2）`-h filter=` 实证：detect 的输出文件参数是 `result`（非 `resultfile`），`shakiness` 1–10、`accuracy` 1–15。

| 验收项 | 实现口径 | 机器化证据 |
|---|---|---|
| 片段级开关与参数 | `MediaClip.stab`（v8，缺省 = 关闭；`enabled/level/tripod` 三字段，全默认整键不落盘，PROJECT_VERSION 保持 2）；UI 只暴露三档（轻度/标准/强）+ 虚拟三脚架，档位→滤镜参数映射只在 `shared/mediaStab` | `mediaStab.test.ts` 9 例（默认纪律/脏值归一/单调性/画幅口径固定/参数合法区间）+ `projectSchema.test.ts`「v8 防抖参数归一」5 例 + `projectStore.test.ts` 2 例 + `MediaClipInspector.test.tsx`「防抖稳定（v8）」4 例 |
| 零差异纪律：默认关闭时导出 argv 逐字节不变 | 段不带 `stabFile` 时 `buildMediaBasisFilterComplex` 不注入任何滤镜；无防抖任务不启动 detect 进程、不传 `cwd` | `ffmpegArgs.test.ts`「零差异锁定」+ 既有全部 argv 快照未动 + `verify:all` 像素取证通过 |
| 帧序列对齐（.trf 按帧序号索引的硬前提） | detect 与合成段链共用 `segmentTrimFpsPrefix`（trim→setpts→fps 同一字面量） | `ffmpegArgs.test.ts`：detect `-vf` 前缀与合成段链前缀字符串相等断言（TRIM_PREFIX 同源比对） |
| pass 1 预分析 | `runStabDetects`（overlayMp4.ts）：按 `stabSegmentKey`（路径+区间+fps+档位+三脚架）去重，同素材多段只分析一次；子进程 `${jobId}-stabN` 独立 id + 200ms cancel-watch；`.trf` 落任务临时目录，随 workspace 清理 | `ffmpegPipeline.test.ts`「pass 1：detect 退出码 0，.trf 非空」（真 FFmpeg）+ `ffmpegArgs.test.ts` detect argv 快照 |
| pass 2 形变 + 画幅优化 | 段链 `fps` 之后、`setsar` 之前注入 `vidstabtransform=input=<相对名>:smoothing=…:optalgo=opt:optzoom=2:zoomspeed=…:interpol=bicubic:crop=keep`；动态最优缩放 = oximedia Zoom Optimization 口径，crop=keep = 无黑边目标；`.trf` 用相对文件名 + 进程 `cwd`，规避盘符冒号转义陷阱 | `ffmpegPipeline.test.ts`「pass 2：合成链可解，交付尺寸/帧率/像素格式不回退」（输出 320x240/yuv420p/帧数不变）；`ffmpegArgs.test.ts`「transform 注入位置」 |
| 防抖真实生效 | 防抖输出 vs 不防抖输出的逐帧 PSNR 在「明显补偿」区间（<40 且 >5），排除「参数写了但画面没变」的假实现 | `ffmpegPipeline.test.ts` pass 2 尾段 PSNR 判据（正弦 pan/tilt 夹具） |
| 导出逐段生效 + 预览经代理生效（v8.1 前为「预览仍播原片」） | stab 不参与 CSS 预览样式；防抖段强制多输入路径 → 音频重编码 AAC（额外 push `TEXT.stab.exportNote`）；预览侧见下节 v8.1 | `MediaClipInspector.test.tsx`（hint 文案）+ 导出拓扑判定（原 `overlayMp4.ts` 的私有函数，v9 起升为 `shared/ffmpegArgs.segmentsNeedMultiInput` 并有自己的 4 例）的防抖分支 + 既有合成测试覆盖 |
| 取消不泄漏检测进程 | detect 阶段尚无主进程可杀：engine.cancel 置 cancelRequested 后由 200ms watch `terminateJob(子id)`；产物由 engine finally 统一删除 | 手工取证：预分析中点取消 → 进程表无残留、无半成品；自动化覆盖在 pass 1 用例的参数/子 id 口径上 |

已知边界（不属防抖缺陷）：v6 预览几何/调色（`MediaClip.video`）仍只作用于预览，尚未烧进导出链；防抖作用于源帧序列，两者同时设置时导出只体现防抖。

### 虚拟三脚架放大高频抖动（v8.2 缺陷修复）

用户实测：**强防抖 + 虚拟三脚架 → 画面抖动不降反升，愈演愈烈**。经真机受控实验定位根因（非并发/IPC 冲突、非 .trf 帧错位）：

- 随包 FFmpeg `-h filter=vidstabtransform` 明确：`tripod=true` **等价 `relative=0:smoothing=0`**。v8/v8.1 的三脚架实现直接透传 `tripod=1`（且写在 `smoothing=` 之后被其覆盖），等于关掉全部低通并把每帧拽回参考帧 1。
- 对**机位真实平移**的手持素材，绝对参考 + 零平滑会把带噪声的位移估计逐帧反向施加 → 放大高频残余，且离首帧越远纠得越狠（愈演愈烈）。
- 二阶差分能量实测（画面内部区，`spikes` 受控脚本，已删）：平移夹具上 `high+tripod` 旧映射 = 原片的 **194%**（复现放大），`high` 常规 = 57%；`invert=1` 对照 = 163%（反证帧序列对齐正确）。

**修复口径**（`shared/mediaStab` 单一真值，导出与预览代理同时生效）：虚拟三脚架不再使用 vidstab 的 `tripod` 宏；改为「detect 恒相对（`tripod=0`）+ transform 超长窗高斯低通 `smoothing=120` + 静态最优缩放留边 `optzoom=1:zoom=6`」，把相机轨迹钉成近直线而绝不放大。预览代理签名加算法修订号 `r2` 使旧缺陷缓存自动失效。

| 证据 | 入口 |
|---|---|
| 真机放大护栏（修复前必红、修复后绿） | `ffmpegPipeline.test.ts`「虚拟三脚架不得放大抖动（high+tripod 残余高频抖动 < 原片）」：平移夹具测二阶差分，断言 `after < base` |
| 参数映射锁定 | `mediaStab.test.ts`「三脚架（v8.2）」（detect 恒相对 + transform mode/静态平滑/`optzoom=1`）；`ffmpegArgs.test.ts`「三脚架（v8.2）」断言滤镜串不含 `tripod=1`/`zoomspeed`、含 `smoothing=120:optalgo=gauss:optzoom=1:zoom=6` |
| 常规非三脚架路径零改动 | 既有「transform 注入位置」「pass 2 PSNR」用例仍绿（`optzoom=2` 动态缩放行为不变） |

## 防抖预览代理（v8.1）的机器化验收

背景：v8 交付后用户反馈「开了防抖预览毫无效果」。v8.1 的口径：Inspector 防抖区块新增「应用防抖预览」→ 主进程后台两段式作业（进度出现在任务队列）→ 就绪后 PreviewStage 直接播稳定化代理 mp4。**避免实时防抖卡顿，又能看到真正处理后的画面**；导出链不变（代理仅预览用途）。

| 验收项 | 实现口径 | 机器化证据 |
|---|---|---|
| 两进程后台作业 | `src/main/stabPreview.ts`：jobId = `stab-<clipId>` 确定性复用（重复点击不排第二份）；detect 用子 id `${jobId}-detect` + 两阶段 200ms cancel-watch；进度/结果走既有 job 事件流 → 自动出现在 ProgressPanel 任务卡（stab- 前缀显「运动检测/代理转码」而非帧数） | `stabPreviewStore.test.ts` 9 例（queued 不记账/成功后记账/失败落 errors/串台忽略）+ 真机 `ffmpegPipeline.test.ts`「v8.1 预览代理」（detect+transform 同主进程链路 exit 0） |
| 磁盘缓存与新鲜度 | `userData/stab-preview`；文件名 = 签名令牌（区间/帧率/档位/三脚架/源路径 + 源 size/mtime 指纹的 FNV-1a）；命中且非空直接返回 cached+路径（不起进程）；`.trf` 完整则跳过 detect | `mediaStab.test.ts`「防抖预览代理（v8.1）」4 例（令牌确定性/指纹参与/失效维度/文件名安全化） |
| 预览换源与坐标映射 | `stabProxyTimeOf`（只在 `shared/mediaStab`）：代理时间 = 源时间 − 入点，区间外夹紧；PreviewStage 仅在「记账签名 === 当前参数签名」时换播代理，否则回落原片 | `mediaStab.test.ts` 夹紧/负值例 + `MediaClipInspector.test.tsx`「防抖预览代理按钮（v8.1）」5 例（含改档→「重新应用」自动失效） |
| 代理交付口径 = 源区间 1:1 | `buildStabPreviewArgs` 与导出合成段链共用 `segmentTrimFpsPrefix` + 同一 transform 串；带声时 `-af atrim` 裁音轨；无声 `-an`；快优先（veryfast+crf20）+ `+faststart`（Range 流边下边播） | `ffmpegArgs.test.ts` 2 例（同前缀/裁音/无声音分支）+ 真机用例断言帧数≈时长×fps、尺寸不回退、音轨存在、moov 在头 64KB |
| 取消与回收 | 取消共用 `export.cancel`（engine/cfr/stab 三路分发，未知 id 无副作用）；删片段 `removeMediaClip` 联动 `clearForClip` 清账本 + 按 `stab-<clipId>-` 前缀删 mp4/.trf；关防抖同样回收；失败/取消删半成品防脏缓存 | `MediaClipInspector.test.tsx`（取消入口/关闭回收断言）+ `stabPreviewStore.test.ts`（迟到结果不写回） |
| 零回归 | 导出链/协议/工程 schema 全部未动（PROJECT_VERSION 保持 2；新 IPC 通道只增不改）；不点「应用」时预览行为与 v8 交付完全一致 | `npm run verify` 656/656（含既有全部 argv 快照）+ `verify:all` 全链 PASS |

## 音频轨、音频/图像导入与多层合成（v7）的机器化验收

| 能力 | 实现 | 取证入口 / 状态 |
|---|---|---|
| 音频轨（独立车道） | `Project.audioClips?: AudioClip[]`（与媒体段同一套秒+帧对齐+时长恒等式，但**允许重叠**）；`shared/audioClips` 负责建段/平移/拖边/取当前组/层号夹取；时间轴三车道 `媒体 / 音频 / 字幕条`，音频卡是**时长指示条**（竖条波形底纹 + 宽度即占比），可平移、拖入出点、点击定位、工具栏删除 | `tests/audioClips.test.ts` 14 例 + `Timeline.test.tsx`「音频轨」3 例（车道渲染/宽度占比/删除联动/错轨拒绝） |
| 音频导入 | `IMPORTABLE_AUDIO_EXTENSIONS`（mp3/wav/m4a/aac/flac/ogg/opus）；`parseAudioProbeJson`（无视频流分支，`width=0`）；预览协议补音频 mime；素材库 ♪ 角标 | `tests/mxfSupport.test.ts` 同源白名单 + `probe` 单测；`npm run verify` 519 例全绿 |
| 音频试听与混音（预览） | `AudioBed`：播放头处每一段音频各挂一个 `<audio>`，由浏览器自然混音；暂停精确 seek、播放只纠 >0.35s 漂移 | 与导出同源的 `activeAudioClips`；`Timeline.test.tsx`/`AudioClipCard` 相关用例 |
| 导出混音 | `buildAudioMixPlan`：每段 `-ss/-t -i`（输入选项）+ `atrim` + `aresample` + `adelay=delays=…:all=1` 定位 + `amix=…:normalize=0` + 末段 `atrim=duration=<span>`；overlay 出口挂在 `[ab]` 上并 `-map [amix]`；透明出口去掉 `-an` 并补 `-map [v]` | `tests/audioMixExport.test.ts` 10 例（含“无音频段时 argv 逐字节不变”回归锁）；**真机实证**：用随包 FFmpeg 跑同一滤镜链，两条链均 exit 0，输出带 AAC 音轨且 `volumedetect` 非静音（mean -21.1dB / -19.5dB） |
| 图像素材 | `MediaKind='image'` + `inferMediaKind`（按扩展名）+ 入池补默认静帧时长 5s；素材库 ▣ 角标；预览用 `<img>` 渲染（几何/调色滤镜同样生效）；导出用 `-loop 1 -t <dur>` 撑成视频流，该段强制补静音 | `tests/mediaLayers.test.ts`（kind 推断/默认时长/`-loop` argv/`anullsrc`） |
| 多层叠加渲染 | `MediaClip.layer` / `AudioClip.layer`（0..4，0 不落盘）+ 工具栏「上移层/下移层」；时间轴按层切分车道高度；**预览取最上层**（`topActiveMediaClip`）；**导出先把层解开**（`resolveVisibleMediaClips`：逐区间取上层、相邻同源合并、源坐标同步平移）再进“不重叠+concat”基座链；字幕轨始终在画面之上（Canvas 层叠在视频层） | `tests/mediaLayers.test.ts` 5 例（取最上层/同层后者在上/遮挡区间/三层嵌套）+ `useExportJob` 基座改走 resolve；`verify:all` 20/20 |

### 已知边界

- 预览与导出都按「画面不透明」处理多层：上层**完全覆盖**下层（未实现透明度/混合模式）。
- `verify:all` 的应用内冒烟工程不含音频/图像段，因此自动化门禁覆盖的是「无音频段时 argv 不变」的回归面；含音频/图像的端到端导出凭证目前是 argv 单测 + 随包 FFmpeg 链实证。

## 片段音频编辑与频谱可视化（v9）的机器化验收

背景：需求要求「媒体卡片底部 1/3 频谱条 + 音量/渐入渐出 + 变速（保持音高）+ 音频段专属面板」，且**参数必须到达导出引擎**。口径：一套语义三处消费——面板滑杆、预览（`playbackRate` + 增益包络 + 频谱条形状）、导出（`atempo`/`asetrate`/`volume`/`afade`/`setpts`）全部只读 `shared/mediaClipAudio`，单位换算只允许写在那一个文件里。

| 验收项 | 实现口径 | 机器化证据 |
|---|---|---|
| 变速的时间口径 | **源窗口不变、时间轴伸缩**：`sourceOutSec − sourceInSec = (timelineEndSec − timelineStartSec) × 倍速`（1x 时即旧恒等式）。换算集中在 `sourceSecForTimelineSec`/`timelineSecForSourceSec`，schema 归一、拆分、主轨对齐、层展开、拖边、预览映射、导出 `outLen` 全部走它 | `tests/mediaClipAudio.test.ts` 21 例 + `tests/mediaClips.test.ts`「变速段的时间换算」4 例 + `tests/audioClips.test.ts`「音频段变速」5 例 + `tests/projectSchema.test.ts`「v9 归一」6 例（含恒等式与脏值夹心）+ `projectStore.test.ts`「v9 片段音频与变速动作」9 例 |
| 音量 0~200% / 渐入渐出 0~5s | `ClipAudio{volumePercent,fadeInSec,fadeOutSec}`；导出 `volume=1.5` + `afade=t=in:st=0:d=X` / `afade=t=out:st=<len−d>:d=d`（各限半段，秒数是**变速后**的本段输出长度）；链序固定为 变速 → 音量 → 淡入 → 淡出 | `tests/ffmpegArgs.test.ts`「v9 片段音频与变速 argv」10 例 + **真机实证**：`ffmpegPipeline.test.ts`「音量 50%」——同一素材只改 `volume`，`volumedetect` 的 `max_volume` 相对差 = −6.02dB（±2） |
| 变速 0.25x~4x + 保持音高 | 开启 = `atempo` 链（单实例安全区 0.5..2，4x 串两个 2）；关闭 = `aresample=48000,asetrate=48000×s,aresample=48000`（音高随倍速升降）。画面侧 `setpts=(PTS-STARTPTS)/s` **挂在 `fps=` 之后**（保 vidstab `.trf` 帧序号对齐）。预览用 `playbackRate` + `preservesPitch`（含 webkit 前缀） | 同上 argv 用例（`atempoFilters`/`pitchShiftFilters`/链序断言）+ **真机**：「2x 变速」交付 90±5 帧/3s、「0.5x 慢放」360±12 帧/12s、「asetrate」链 exit 0 且时长仍为 3s |
| 导出链不漏参数 | `segmentsNeedMultiInput`（从主进程提到 `shared/ffmpegArgs` 以便单测锁住）认 `audio`/`speed` 键：单输入 overlay 链没有逐段音频插入点，不强制走 trim 链就会把参数静默吞掉→预览与导出分叉；图像段 `-loop 1 -t` 用**源窗口**长度，无音轨段 `anullsrc` 用**时间轴**长度 | `tests/ffmpegArgs.test.ts`「segmentsNeedMultiInput（导出拓扑判定）」4 例 +（静音长度/`-loop` 长度/默认值不落盘时链串与基线逐字节相等）+ `tests/audioMixExport.test.ts`「混音计划的音频参数（v9）」5 例 |
| 音频段专属面板 | `selectionKind==='audio'` → `AudioClipInspector`，与视频编辑器**共用** `ClipFxSections`（同一组滑杆、同一份默认值）；画面参数（缩放/旋转/色彩/防抖）在音频模式下**根本不渲染**，而非 disabled | `src/renderer/src/panels/AudioClipInspector.test.tsx` 9 例（分流三态互不卡住、画面分区不在 DOM、数值标签读数、倍速伸缩、恢复默认） |
| 频谱条（卡片底 1/3） | 数据源 = 主进程一次 FFmpeg 解码单声道 PCM（`-ss/-t` 前置 + `-vn -sn -dn -ac 1 -ar <低率> -f s16le pipe:1`，**绝不带 `-progress`**）→ 等分桶峰值 → −60dBFS 地板折算；柱高再乘「音量 × 淡变包络」，所以滑杆一动形状就动；播放时由 `AnalyserNode` 写 CSS 变量做实时起伏（命令式，不触发 React 渲染）；无音轨/图像/素材已移出 → **一个请求都不发** | `tests/audioPeaks.test.ts` 14 例（折桶数学/成本闸门/柱高/该不该画）+ `tests/ffmpegArgs.test.ts`（argv 不含 `-progress`）+ `MediaClipCard.test.tsx`「音频频谱条」7 例 + **真机**：「频谱取样」从正弦夹具折出 48 根柱（全部 >0.6）、只取后半时字节量减半、无音轨素材返回 0 字节 |
| 零回归 | 默认值 = 不生效：全默认时 `audio`/`speed` 整键不落盘，`PROJECT_VERSION` 保持 2；无 v9 键时基座与混音 argv 与 v7/v8 **逐字节一致**（由相等断言锁定）；预览从恒定 `muted` 改为 `muted={!audible}`，AudioContext 起不来时自我拆除退回 `element.volume`（最坏情况 = 今日行为） | `npm run verify` 666/666（49 文件）+ `src/renderer/src/audio/previewAudioGraph.test.ts` 6 例（退化纪律）+ `verify:all` 全链 PASS |

### 已知边界（v9）

- 「变速保持音高」的实现按 FFmpeg 物理语义：开启 = `atempo`（只变时长），关闭 = `asetrate`（音高与时长一起变）。需求原文把两条滤镜分配反了（仅 `atempo` 不可能改变音高），已按可工作的方向实现并在 i18n hint 与文件注释写明。
- 频谱条是**幅度包络**（等分时间桶峰值），不是频域分析；主进程侧是会话内存 LRU（240 键）+ 并发闸门，不落盘也不写进工程。
- 预览出声只在「播放中 + 有音轨」时打开；浏览器自动播放策略可能拒绝 AudioContext，此时 >100% 增益在预览里听不到（导出仍按 `volume` 生效）。
- 与 v7 同一限制：`verify:all` 的应用内冒烟工程不放媒体/音频段，因此频谱条「屏幕上的像素」不在自动化门禁里（它由 jsdom 结构断言 + 真机折桶数据两层锁定）；面板滑杆→预览→导出的逐环同步已由上述 argv/包络单测接上。

## 撤销历史与交互统一（v10，P1–P6）的机器化验收

背景：本轮把「新建/删除片段」从时间轴工具栏收回左侧列表、把拆分/删除改成按选中段解析、把预览轴改成真正的画面预览、把点段落从「选中+跳转」拆成「只选中」，并把水印与字幕合并成「包装」。删掉二次确认的前提是**有撤销**，所以先补了一个历史子系统。

| 验收项 | 实现口径 | 机器化证据 |
|---|---|---|
| P1 撤销/重做 | `state/projectHistory.ts`：订阅 `projectStore`，命边界（任一段数变 / 选中变 / 距上一步 >500ms）才压快照；上限 100 步、新编辑清空重做栈、`loadProject` 清空；比较与恢复忽略 `ui`（leftTab）与 `media[].thumbnailUrl`（派生缓存），恢复时从活态带回；Ctrl+Z / Ctrl+Shift+Z（输入控件内不接管）+ 工具栏两个按钮（无可撤销时置灰） | `state/projectHistory.test.ts`（边界合成、100 步丢最旧、volatile 过滤、载入清空）+ `hooks/useEditKeys.test.tsx`（快捷键与输入框豁免）+ `Timeline.test.tsx`「时间轴工具栏：撤销 / 重做」3 例 |
| P2 字幕 Tab 为唯一入口 | `CaptionListPanel`：0 条时整块大虚线加号，≥1 条时列表末尾矮加号条；每张卡片常驻 16px SVG 垃圾桶（`stopPropagation`，不触发选中）；点卡片 = 选中 + 播放头跳到**区间中点**（先暂停）；时间轴工具栏的「新建片段」「删除片段」已移除 | `CaptionListPanel.test.tsx` 13 例（空态/尾部入口、删除不选中、跳中点、无 seekHandler 不抛）+ `Timeline.test.tsx`（工具栏不再有这两个入口）+ `FOCUSNEWS_SHOT=spikes/artifacts/ui-wrap-rail.png` |
| P3 拆分/删除按选中段解析 | `shared/timelineTargets.ts` 统一解析目标：选中哪类就作用于哪类（字幕/媒体/音频），未选中时退到**播放头处媒体轨最下层**（layer 号最大），都没有则不改工程只给提示；字幕拆分两段共用文字与样式、入出点切开 | `tests/timelineTargets.test.ts` + `projectStore.test.ts`（`splitTargetAt`/`removeTargetAt`/`removeSelected`）+ `Timeline.test.tsx`（三轨目标、空隙提示不置灰） |
| P4 预览轴接管画面 | 悬停帧存 `uiStore.hoverPreviewSec`（null = 无悬停/播放中）；`PreviewStage` 与 `usePreviewLoop` 用 `previewFrame.choosePreviewFrame` 决定画哪一帧，而 `displayTimeSec`（蓝线、时间码、拆分参照）一律不动；播放时临时禁用、鼠标离开即回落；黄线在场时拆分以黄线为准 | `render/previewFrame.test.ts` + `uiStore.test.ts`（同帧不产生新 state）+ `Timeline.test.tsx`（悬停写入/离开清空/播放中禁用/拆分以黄线为准） |
| P5 点段落只选中 | 媒体/音频/字幕卡片一律只 `onSelect`，不再 seek；`isStripTap` 与卡片点击跳转整体删除；跳转入口只留轨道空白处与尺规；编辑器顶部给「定位到这一段」（播放头在段外才出现，点击先暂停再跳到中点） | `Timeline.test.tsx`「点段落只选中不跳转」3 例 + `MediaClipCard.test.tsx`（点一格不再跳转）+ `ClipLocateButton.test.tsx` + 三个编辑器的「定位到这一段」用例 |
| P6 「包装」Tab | `LEFT_TABS`（media/wrap/export/progress）为唯一清单；`WrapPanel` 自上而下 = 字幕（`CaptionListPanel`）/ 片尾（占位，无任何可点入口）/ 水印（`WatermarkPanel`）；`normalizeLeftTab` 把旧工程的 `captions`/`watermark` 迁到 `wrap` | `WrapPanel.test.tsx` 5 例（顺序、字幕区入口、水印区、片尾无入口）+ `tests/projectSchema.test.ts`「leftTab 归一化与旧值迁移」5 例 + 隔离 profile 写入 `leftTab:"captions"` 冷启动落在「包装」（`spikes/artifacts/ui-wrap-tab.png`） |
| 零回归 | `npm run verify`（check:env + lint + typecheck×3 + vitest）全绿 | 774 例 / 56 文件通过（v9 为 666） |

## 播放键盘（空格 / 方向键逐帧）的机器化验收

| 能力 | 实现 | 取证入口 / 状态 |
|---|---|---|
| 空格播放/暂停 | `hooks/useTransportKeys`（window keydown）：焦点在 input/textarea/select/contentEditable 里一律放行；`event.repeat` 忽略（按住只切一次）；`preventDefault` 防住「空格滚动预览区」与「当前聚焦按钮被再点一次 = 切换两下」 | `useTransportKeys.test.tsx`（切换/连发/四类文本控件让位/勾选框/修饰键 6 例） |
| ←/→ 上一帧下一帧 | `App.stepFrame`：帧号取 `PreviewStage` 句柄的 `currentFrame()`（预览时钟的真实帧；UI 时间文本是 100ms 节流值，拿它折算会差好几帧），`shared/fps.stepLocalFrame` 夹在 `[0, totalFrames)` 后 `seekTo(frameTimeSec(...))`，并先接管播放时钟 | `tests/fps.test.ts`「逐帧跳转的落点」4 例（单步/两端夹住不回绕/连跳累加等价单步/空工程） |
| 长按连续跳转 | 同一模块自己计时：按住 `FRAME_HOLD_DELAY_MS`（320ms）后按 `FRAME_REPEAT_INTERVAL_MS`（60ms）逐帧连发；keyup、窗口 blur、换方向、焦点进输入框四条路径都断开；不认系统按键重复率设置 | `useTransportKeys.test.tsx` 连跳 5 例（阈值前/后、松手、失焦、换方向不叠定时器） |
| 与门禁弹窗/其他按键消费者共存 | 弹窗排队中整组快捷键不生效（不能拿空格绕过「必须确认」的阻断，规格 §6）；已被别处 `preventDefault` 的按键不接手（分隔线 `role=separator` 的方向键调布局时不会顺带推播放头） | `useTransportKeys.test.tsx` 2 例 |
| 暂停逐帧时媒体画面真的跟着动 | `PreviewStage` 暂停吸附阈值由固定 0.04s 改为**半帧**（`frameIntervalSec(fps)/2`）：0.04s 在 25/30fps 下正好把「一帧」当噪声放过，于是只动字幕层不动参考视频 | 既有 `mediaClip*`/`mediaLayers` 单测未回归；`FOCUSNEWS_SHOT=spikes/artifacts/ui-transport.png` 可见五键 transport（⏮ \|◀ ▶/❚❚ ▶\| ⏭）与按钮上的快捷键提示 |

## 重跑取证的最短路径

**一条命令跑完全部可自动化验证**（计划 M4-6「断言脚本化」）：

```bash
npm run verify:all        # 19 步：门禁 6 + CLI 冒烟 2 + 应用内场景 11
npm run verify:all -- --quick   # 只跑门禁 + CLI（不启 Electron）
→ spikes/verify-all.json（逐步退出码 + 关键读数 + 耗时）
```

2026-11-06（v9 交付后）全量重跑（`VERIFY ALL PASS`，20/20）：

| 步骤 | 读数 |
|---|---|
| check:env / lint / typecheck×3 | 全部 exit 0 |
| vitest | exit 0，**49 文件 / 666 用例**（11.8s），无未捕获异常 |
| CLI 1080p30/10s 透明 MOV / CLI 720p 叠加 | 3.6s / 1.7s |
| 应用内 1080p30/10s | 5.76s（外推 5.8s，阈值 30s） |
| 应用内 4K60/2s | 10.46s（外推 6.5s） |
| 应用内 逐像素一致性 / 错误呈现 / 逐帧评审表 / 视觉检查 | 均 PASS（5 帧、argvSegments 38、24 例 0 failure） |
| 真机 FFmpeg（`ffmpegPipeline.test.ts`） | v9 六例均 exit 0：频谱折桶/2x 90 帧/0.5x 360 帧/音量相对差 −6dB/asetrate/混音链 |

→ 日志：`spikes/verify-all-v9.log`；结构化结果：`spikes/verify-all.json`

2026-11-04 全量实测（`VERIFY ALL PASS`，19/19）：

| 步骤 | 读数 |
|---|---|
| check:env / lint / typecheck×3 / vitest | 全部 exit 0（164 用例：node 148 + dom 16） |
| CLI 1080p30/10s 透明 MOV | 4.3s |
| CLI 720p 叠加合成 | 1.9s |
| 应用内 1080p30/10s | **6.63s**（外推 6.6s，阈值 30s） |
| 应用内 4K60/2s | 10.33s（外推 6.5s） |
| 应用内 取消透明 MOV | 600 帧时间轴中途取消，1.15s |
| 应用内 PNG 序列独立出口 | 60 帧 / 1.25s |
| 应用内 取消 PNG 序列 | 1.11s（目录型半成品已回收） |
| 应用内 MOV 的 pngSequence 回退 | 60 帧 / 1.7s，外推 **76.7s**（回退上界 150s，不拿默认路径的 30s 去量） |
| 应用内 叠加 720p23.976 | 120 帧 / 3.18s |
| 应用内 门禁端到端 | 3 个夹具全部通过 |
| 应用内 逐像素一致性 | 5 帧，DPR 1.5，blit 1440×810 |
| 应用内 错误呈现 | argv 38 段、stderr 245B |
| 应用内 逐帧评审表出图 | 8 预设 × 7 关键帧 PNG |

单步命令（需要单独重现某一项时）：

```bash
npm run verify            # check:env + lint + typecheck×3 + 164 个用例
npm run dist:win          # 出 NSIS 安装包
npm run verify:packaged   # 静默安装 → 断网等价冷启动 → 优雅退出 → 静默卸载
# 应用内取证（详见 M0.md 的命令块）：
#   FOCUSNEWS_SMOKE=1 [+ _CANCEL / _OVERLAY / _GATE=1 / _KIND / _DELIVERY]、FOCUSNEWS_PIXELCHECK、
#   FOCUSNEWS_REVIEW_SHEET、FOCUSNEWS_SHOT_ERROR、FOCUSNEWS_SHOT_REFMISSING、FOCUSNEWS_SHOT
```
