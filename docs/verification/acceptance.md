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
| 素材池/媒体轨 store 动作 | `projectStore`：addMedia/removeMedia/relocateMedia/ack 枚级、insert/move/trim/remove/splitAtFrame；时长恒等式 `timelineEnd-timelineStart === sourceOut-sourceIn` 唯一写入口 | `src/renderer/src/state/projectStore.test.ts`（13 例）+ `tests/mediaClips.test.ts`（纯函数：拆分/仅重叠右移/时间↔源换算） |
| 旧工程迁移 | `normalizeProject` v1→v2：`refVideo` 折叠为 `media[0]` + 覆盖整段的 mediaClip，旧字段不回流 | `tests/projectSchema.test.ts`（迁移两组） |
| 左侧 Tab 壳 + 素材库 | `App.tsx` rail__tabs（素材库/水印/字幕/导出/进度，同一时刻只展开一个；v4 后 5 个，窄侧栏里自动换行而不被裁切）；卡片拖拽携带 `application/x-focusnews-media` | `Timeline.test.tsx` v2 媒体轨 4 例 + `FOCUSNEWS_SHOT` 可出图 |
| 水印（Watermark）模块 | 左侧新增「水印」Tab + `WatermarkPanel`：导入本机图片（`watermark:pick` 用 ffprobe 取原图宽高）、启用/停用/移除；`ffmpegArgs.computeWatermarkGeometry` 以 1080P 为基准（显示尺寸 = 原图 32%，距顶/左各 30px）按输出高度等比换算，四条合成路径统一作为**最后一层** overlay 叠在字幕条之上；预览用同一函数定位 `<img>`（不进 Canvas，透明出口永不烧录台标） | `tests/watermark.test.ts`（几何/argv/图片解析/持久化 20 例）+ `WatermarkPanel.test.tsx`（导入/开关/移除/读数 9 例）+ `tests/ffmpegPipeline.test.ts`（真机 FFmpeg 取像素判定：两阶段单输入 / trim+concat 拼接 / 直管道 3 例） |
| 双轨时间轴 + 落点高亮 | 媒体轨/字幕轨共享尺规与播放头；拖拽悬停显示吸附落点竖线；拆分按钮 + `canSplitMediaClipAt` 纯谓词 | `Timeline.test.tsx`（拆分启用/禁用/选中/尺规跟随） |
| 预览按 mediaClip 切源 | `PreviewStage`：播放头落在哪段，`<video>` 就换那枚源文件，`currentTime` 按 `sourceTimeOf` 换算；段间空隙回棋盘格；无 mediaClips 时保留 v1 兼容 | 逐像素一致性（M1-7）仍走同一 `renderFrame`，本次重跑通过 |
| Ctrl+B 剪切 | `App.tsx` keydown：输入控件内不拦；先暂停再 `splitAtFrame(displayTimeSec)`；Delete 删选中媒体段 | UI 快捷键（可人工验证）；拆分本体由 store 单测覆盖 |
| 多输入 trim+concat 导出 | `ExportRequest.overlay.segments`（主进程按段 trim 后 concat，空隙补黑+静音；单段整段覆盖时回退旧单输入 argv 不变）；拼接路径音频强制 AAC 并提示 | `tests/ffmpegArgs.test.ts` v2 新增 5 例（滤镜链/两阶段/直管道 argv）；叠加冒烟（单段回退）仍通过 |
| 素材完整性枚级看护 | `useMediaIntegrity` 遍历 MediaItem 池查存在性 → `missingMediaIds` 驱动卡片角标与叠加禁用；重新定位走生产导入路径 | 代码路径与 v1 同构（旧 `useRefVideoIntegrity` 删除）；`FOCUSNEWS_SHOT_REFMISSING` 取证保留 v1 兼容分支 |
| leftTab 持久化 | `uiStore.leftTab` 为真值，`App.tsx` 分叉时补写 `project.ui.leftTab`，自动保存落盘、启动恢复 | `normalizeProject` 保留 `ui` 字段（往返单测覆盖） |

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
| 画面翻转：水平 / 垂直镜像 | 两个独立开关（`flipH` / `flipV`），CSS `scaleX(-1)` / `scaleY(-1)` 接在缩放之后 | `mediaClipVideo.test.ts`（单项输出）+ `MediaClipInspector.test.tsx`（两开关互不影响、再点即关、aria-pressed） |
| 色彩与光影：亮度/曝光/对比度/饱和度/冷暖/光感 + RGB 三通道曲线 | 亮度/对比度/饱和度/光感 → CSS `brightness/contrast/saturate`；曝光与冷暖 → 按通道增益；曲线（每通道三点位：阴影/中间调/高光）→ `curveTableValues` 生成 `feComponentTransfer tableValues`，三者合成一张 SVG 滤镜（`focusnews-media-grade`）挂在同一个 `<video>` 上 | `mediaClipVideo.test.ts`（filter 组合、直线不挂 SVG、采样与 tableValues 长度/夹心）+ `MediaClipInspector.test.tsx`（六个滑杆独立写回、曲线只动当前通道） |
| 一键恢复默认 | 顶部「恢复默认」走 `resetMediaClipVideo`（整键 `video` 删除）；曲线块另给「曲线复位」（只清三通道） | `projectStore.test.ts`（重置只清当前段）+ `MediaClipInspector.test.tsx`（无编辑时禁用、有编辑时一键清空） |
| MXF 导入与解码 | `IMPORTABLE_VIDEO_EXTENSIONS` 加入 `mxf`（导入对话框用它）；预览协议 `mediaRange` 认 `video/mxf`（不再 octet-stream）；探测/导出走 FFmpeg 原生 mxf 解封装 | `tests/mxfSupport.test.ts` 3 例；真机实证：`ffmpeg -f mxf` 生成的 mpeg2video 1280x720/25fps 夹具被 ffprobe 正确读出（codec/尺寸/帧率/时长全对）。**预览限制**：Chromium 无 MXF 解封装器，`<video>` 会 onError → 预览区显示「不可预览」并保留字幕叠加，需代理转码才能看到 MXF 画面 |

## 重跑取证的最短路径

**一条命令跑完全部可自动化验证**（计划 M4-6「断言脚本化」）：

```bash
npm run verify:all        # 19 步：门禁 6 + CLI 冒烟 2 + 应用内场景 11
npm run verify:all -- --quick   # 只跑门禁 + CLI（不启 Electron）
→ spikes/verify-all.json（逐步退出码 + 关键读数 + 耗时）
```

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
