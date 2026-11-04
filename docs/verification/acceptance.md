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
| 5 | 非 16:9、HDR 视频导入均触发模态提示，未确认不可继续 | `FOCUSNEWS_SMOKE_GATE=1`（走生产 `importRefVideoWith` + CompatModal 同一应答动作） | **通过**：portrait.mp4→`non169`、hdr.mp4→`hdr`；未确认时 `gateBlocked` 为真（三个导出按钮禁用并显示原因）；选「取消」工程不写入 |
| 6 | VFR 视频转换 CFR 后 ffprobe 确认帧率一致；直接导入 VFR 时二次提醒生效 | 同上 gate 场景（选「转换并导入」）+ `tests/ffmpegPipeline.test.ts` VFR→CFR PTS 偏差 | **通过**（前半）：CFR 产物主进程独立 ffprobe 得 `r=30/1 == avg=30/1`，重探不再判 VFR，`vfrPolicy=converted` 且保留 `sourcePath`。（后半）二次提醒为 UI 模态，代码路径 `askVfrSecondConfirm` 在 `vfrPolicy==='raw'` 时必经；真机手机素材需人工（清单 C11） |
| 7 | 音频 `-c:a copy` 成功；不可复制时回退 AAC 并提示 | overlay 冒烟（aac 参考 → copy 成功）+ overlay 冒烟（pcm_s16le 参考 → 预检转 AAC 且带 notice）+ `tests/overlayAudioFallback.test.ts`（注入退出码，5 例） | **通过**：copy 路径产物音轨 `aac` 与参考一致；`pcm_s16le → aac` 且 notices = ["音频已转码为 AAC 192k（原音轨 pcm_s16le 不能直接复制）。"]；运行期 copy 失败只重试一次、不无限重试 |
| 8 | 导出取消后无孤儿 FFmpeg 进程，临时文件被清理 | `FOCUSNEWS_SMOKE_CANCEL=1`（**两种出口各跑一次**：透明 MOV 与 PNG 序列） | **通过**：MOV 中途 15/600 帧、PNG 序列中途 41/600 帧取消；`errorCode=CANCELLED`、`activeJobs=[]`、`artifactExists=false`（PNG 是**目录**型半成品，走 `kind==='dir'` 递归删除分支）、`staleTempDirs=[]`。注：清理发生在结果事件之后的 `finally`，校验用有界轮询（实测 200ms 内完成）而不是单时间点采样 |
| 9 | Yoga 布局在 360p 至 4K、竖屏、超宽屏下字号与条高可读且不失控 | `tests/presets.test.ts` 8 预设 × 8 档（含 9:16 与 21:9）+ 分支覆盖计数 + **标题宽度法则专项**（主条 = 画宽 − 左右等边距，逐档断言 `bar.w=root.w` 且左右边距相等，并验证与文案长短无关）；`FOCUSNEWS_REVIEW_SHEET` 出图 | **通过**（机器可判部分）：整数像素网格、字号硬上限、compact 副标题单行省略；4K 条高 ≈ 360p 的 6 倍；**标题宽度**：1080p 下 x=96 / w=1728（边距 96/96，= 安全区 × 0.5），四字/中/长文案宽度逐像素相同。「观感是否廉价」仍需人看 |
| 10 | 预设样式在真实 1080p 画面上逐帧评审，动画无网页式弹跳与轻浮感 | `FOCUSNEWS_REVIEW_SHEET=…`（8 预设 × 7 关键帧 + 末行「长文案换行」共 9 行，画面由生产同一套 `renderFrame` 产出）；曲线表从源头禁 overshoot（`validatePreset` + `tests/projectSchema.test.ts`）；擦除进度逐帧与 `motionAt` 对照（`FOCUSNEWS_PIXELCHECK` 的 `wipe` 段） | **部分**：评审表可一键产出且每帧都是真实导出像素；动画已是「整体左→右擦除」（无位移、无淡入，仍无 overshoot）；背景为 FFmpeg `testsrc2` 合成画面，**实拍素材观感判定必须人工**（清单第 3 节） |

## 关键纪律（规格 §11）的机器化程度

| 纪律 | 落实方式 | 状态 |
|---|---|---|
| FFmpeg 仅异步 spawn，禁止同步调用 | ESLint `no-restricted-imports` + `no-restricted-syntax` + `check-env` 全仓静态扫描 | 通过 |
| 叠加必须按参考视频参数重新渲染，禁止复用透明 MOV 缩放 | `runOverlayMp4` 阶段一按参考分辨率/帧率重渲染（`restrictToActiveSpan` 限定 span）；`tests/pixelParity.test.ts` 静态禁读显示度量 | 通过 |
| FFmpeg 二进制必须在 asar 外 | `electron-builder.yml` `files` 白名单 + `extraResources`；`check-env` 硬校验；asar 内 172 项不含 ffmpeg | 通过 |
| 时间轴存秒、帧率存分数、全程整数运算 | `src/shared/fps.ts`（含 BigInt 片段区间）+ `tests/fps.test.ts` 互逆 | 通过 |
| 非 16:9 与 HDR 模态阻断，未确认不得导入或导出 | `CompatModal` + `gateBlocked`（UI 禁用三按钮）+ `useExportJob.assertGate`（主路径二次拦截） | 通过 |
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

| 需求 | 实现 | 实测读数 |
|---|---|---|
| 标题区域长度 = 预览宽度 − 左右相等边距 | root 同时声明 `left`/`right` 为同一**布局边距**令牌（= 安全区 × 0.5），主条 `width:100%`；不设任何 `maxWidth` | 1080p：主条 **x=96、w=1728**；像素探针 **titleWidth=1728=rootWidth**，边距 **96 / 96** |
| 边距为原安全区的一半 | `LAYOUT_INSET_SCALE = 0.5`（`layout-*` 令牌），`safe-*` 与辅助线不变 | 左/右边距 96（原 192）；底部边距 54（原 108） |
| 副标题在主标题上面 | 子节点顺序「副条 → 主条」，`-overlapY` 移到主条上边距 | **subBarTop=860 < barTop=922** |
| 副条仍按文字自适应 | 副条 `maxWidth = subBarWidth`（hug） | 副条实测 127px → 1037px（短 → 长） |
| 文字逐字渐隐渐现 | `layers.charStagger()`：每个字按索引错峰，入场用 `wipeTo`、出场用 `wipeFrom`（与条块同源） | 入场早期已有字出现且均在擦除线以内；同帧各字 alpha 不全相同（`tests/pixelParity.test.ts`） |
| 超过条宽自动换行 | 标题 3 行 / 副标题 2 行，共用一个 `TextMeasurer.wrap()`；条高随行数长高 | 44 字标题 1 行 → 2 行 |
| 所有矩形左→右擦除 | 整条字幕**一条**绝对擦除线：入场右边界右推、出场左边界右推 | 入场 L 恒 96、R 长到 1823（=96+1728-1）；出场 L 1451→1713→1810、R 恒 1823 |
| 擦除进度与帧号一致 | `motionAt` 的 `wipeTo/wipeFrom` | 可见比 0.2159/0.0642/0.0081 vs 预期 0.216/0.064/0.008（偏差 ≤ 0.002） |
| 动画不改布局 | 几何只在布局层算一次，动画只落 clip | 落地几何（x/y/w/h）入场帧与稳态帧逐项相等；稳态帧无 clip |

评审表同步加了第 9 行「长文案换行」：`npm run verify:all` 的最后一步会重生成 `spikes/artifacts/review-sheet-1080p.png`（3692×3048）。

## UI 视觉证据的正确取法（本轮实测结论）

打包版取证脚本里的屏幕截图（`CopyFromScreen`）现在能拿到真实桌面像素，
但**拿到的是 IDE 而不是应用窗口**：`SetForegroundWindow` 在 Windows 前台锁定策略下并未生效，
窗口虽在 `GetWindowRect` 返回的坐标上却被遮盖。因此屏幕截图不能当作应用 UI 的证据；
可靠路径仍是应用自身的 `webContents.capturePage()`（`FOCUSNEWS_SHOT=<png>`），
它拿的是 Chromium 内容区的真实绘制结果（已证：`ui-shot-1080p.png`、`ui-shot-directpipe.png`、`ui-shot-refmissing.png`）。

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
