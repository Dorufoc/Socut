# M8 AI 人像 / 物体抠像（AI Matte）技术选型与落地设计

> 研究日期：2026-11-10 · 范围：只做选型与设计，**未改任何代码/依赖**
> 证据标记：`[实测]` 本机随包 FFmpeg 9.0.2 跑过；`[代码取证]` 读仓库源码/配置；`[官方]` 模型/运行时官方文档或模型卡；`[二手/估算]` 第三方 benchmark 或推算，需 App 内实测确认。
>
> **2026-11-10 协议变更后的修订**：本项目已改为 **AGPL-3.0-or-later**（此前 `UNLICENSED` 闭源），
> 下文中「必须闭源分发 → 只接受 Apache-2.0/MIT/BSD、排除 GPL 模型」的前提**已不成立**
> （AGPL §13 明确允许与 GPLv3 作品组合）。**选型结论不变**：仍用 Apache-2.0 的 MediaPipe Selfie
> Segmenter，理由回到体积（452 KB vs RVM 15 MB）与单人场景精度；RVM（GPL-3.0）从「许可禁用」
> 降级为「可选、未排期」，将来要更好的发丝边缘可以按需评估。

---

## 0. 结论（TL;DR）

**判定：有条件 go。** 先做「管线泛化」，再上「AI 推理」，AI 推理放**主进程**、模型选 **Apache-2.0** 的人像分割模型。

| 项 | 选择 | 理由摘要 |
|---|---|---|
| 集成方式 | **matte 预 pass 产出「灰度 matte 视频」→ 复用现有 alphamerge 段链** | 手绘遮罩已经把「额外输入 + alphaextract/blend/alphamerge + 输入编号/overlayLabel」跑通；AI 只是换 matte 来源 |
| 推理位置 | **主进程（或 `utilityProcess`），`onnxruntime-node`** | 生产环境是 `loadFile`（file://），ORT-web 的 `.wasm` 走 `fetch()` 会被 Chromium 挡；主进程原生 ORT 无此问题，且解码/编码本来就在主进程 |
| 首选模型 | **MediaPipe Selfie Segmenter（256²，Apache-2.0，ONNX 约 451 KB）** 编译内置；**MODNet（512²，Apache-2.0）** 作质量档 | 体积几乎为 0、许可证可闭源分发、单人场景足够；MODNet 换更好的发丝边缘 |
| 物体抠像 | 第二阶段起按需下载 **IS-Net（Apache-2.0，178.6 MB）** | 体积太大不适合内置；沿用 whisper 模型的「可选资产 + 明确报错」模式 |
| 明确排除（本轮） | **RVM（GPL-3.0）**、**RMBG-1.4/2.0（非商用）** | 本项目 2026-11-10 起为 AGPL-3.0-or-later：RVM 的 GPLv3 已可组合（AGPL §13），本轮仍不采用是**体积/精度取舍**；RMBG 的非商用授权在任何协议下都不可接受 |
| 体积成本 | 原生运行时 ≈ **+31 MB**（win-x64 `onnxruntime.dll` 30.27 MB + binding 0.34 MB，DirectML 可选再 +17.7 MB），模型 +0.5 MB（selfie）/ +6~25 MB（MODNet，按需） | 走 `extraResources`，`files` 白名单不动 |
| 耗时量级（1080p、10 s、300 帧） | selfie 档 **≈2–6 s**；MODNet 档 **≈10–25 s**（含解码/编码，待实测） | 推理成本只取决于模型输入尺寸（256/512），与 1080p 无关 |
| 最大风险 | ①原生依赖打包与 CI；②matte 与 trim/变速/转场手柄的时间对齐；③质量（自拍模型对侧脸/遮挡/多人差） | 用 P0 泛化 + P1 单模型先锁死管线，风险可控 |
| 先做哪一阶段 | **P0：把 `maskPath` 泛化成「静态 PNG / 视频 matte」并支持外部 matte 导入（零 AI、零新依赖）** | 可独立验收；失败也能当产品功能交付；AI 随时可插拔 |

---

## 1. 现状与硬约束（先读仓库得到的事实）

### 1.1 已有 matte 管线（M8-D 已完成，端到端有真机 e2e）

- 数据：`MediaClip.mask?: MediaClipMask`，`MaskStroke { mode:'hide'|'restore'; radiusPct; points[{x,y}] }`，坐标归一化 0..1（`src/shared/types.ts:521-537`、`543-583`）。
- 导出：渲染侧光栅化 PNG → `ExportRequest.mediaMasks: Array<{clipId, png}>`（`types.ts:1268-1270`）→ 主进程写 `mask-<clipId>.png` 并接 `OverlaySegment.maskPath`（`src/main/export/overlayMp4.ts:160-215`）→ 段链 alphamerge（`src/shared/ffmpegArgs.ts:600-635`）。
- 输入编号纪律：`各段媒体 → 各段 mask → 透明层/帧流/水印 → 音频`，`maskInputIndexFor` + `overlayLabel = segments.length + maskCount`（`ffmpegArgs.ts:544-555`、`overlayMp4.ts:389-396`）。
- 静图 matte 只喂 **1 帧**、靠 framesync `repeatlast` 补到段长（`ffmpegArgs.ts:557-568`，`docs/verification/M8.md:145-153`）。
- 单轨不透明：alpha 相乘后叠黑底 + `trim=end=<段长>` 收尾防少帧；多轨：保留 RGBA（`ffmpegArgs.ts:624-634`）。
- 台账明确写着下一步就是「AI matte：ONNX Runtime + MODNet/RVM；需要模型下载/离线导入 + `utilityProcess` + matte 缓存」，并指出「手绘遮罩已把管线跑通，AI 只需换 matte 来源」（`docs/verification/M8.md:189`）。

### 1.2 导出有两条完全不同的帧来源路径 `[代码取证]`

| 出口 | 帧从哪来 | 主进程角色 |
|---|---|---|
| `overlayMp4` | 媒体由 **FFmpeg 直接解码**合成；渲染侧只提供图形/字幕层帧 | 拼 argv、写临时文件、跑 ffmpeg |
| `transparentMov` / `pngSequence` | **渲染进程逐帧渲染**（`NativeStage`，raw RGBA 或 PNG），主进程按帧号 pull 并直接写进 ffmpeg stdin | `framePump.ts` 背压泵（192 MB 字节预算、最多 3 帧在飞） |

- 帧供给端：`src/renderer/src/render/frameSource.ts:64-108`（`serveFrame`：按 `request.index` 渲染 → `stage.rawRgba()`/`pngBuffer()` → `window.socut.export.sendFrame`），池 4 个舞台画布；主进程 `src/main/export/framePump.ts:47-81`。
- 结论：**渲染进程已经具备「被主进程驱动、逐帧出图」的能力**，这为「在渲染侧做逐帧推理」留了口子；但 `overlayMp4`（本工具主打出口）的媒体帧不经过渲染进程，所以 matte 不能假设「渲染侧一定有原始帧」。

### 1.3 打包 / 离线 / CSP / Electron 版本 `[代码取证]`

- `electron-builder.yml`：`files` 只有 `out/**/*` + `package.json`；`npmRebuild: false`；原生/可选资产一律 `extraResources`（ffmpeg、whisper、rnnoise 模型已有先例）；`asar: true`。
- 离线资产模式：`resources/models/**` + `scripts/fetch-*.mjs`（whisper、rnnoise），缺失时「只 warn，功能报可读错误」。
- Electron 45.2.1 = **Chromium 156 / Node 24.22.1**（`https://releases.electronjs.org/`）→ WebGPU 可用（若走 ORT-web WebGPU 路线）。
- CSP **实测**：`src/renderer/index.html:8` 与构建产物 `out/renderer/index.html:8` 均已含 `script-src 'self' 'wasm-unsafe-eval'`；`electron.vite.config.ts:30` 的 `tightenCspInProd` 只收紧 localhost/ws；`scripts/check-env.mjs:213-227` 只要求保留 `default-src 'self'` 且不得带 localhost/ws。
  - ✅ **走 WASM 不需要改 CSP**（`wasm-unsafe-eval` 已在）。
- 生产窗口 `windows.ts:68` 用 `loadFile(...)` → 页面是 **`file://` origin**。
  - ⚠️ **关键约束**：ORT-web / MediaPipe 的 `.wasm` 是运行时 `fetch()` 加载的；`file://` 页面 fetch 本地文件在 Chromium 被禁止。要走 Web 运行时，必须额外做一个 `socut-app://` 自定义协议把 `out/renderer/**` 供出来（项目已有 `socut-media://`、`socut-strip://` 等 4 个同类协议，可复用模式），或把 wasm 以 data: 内联（+33% 体积，不推荐）。
  - 因此本报告把「主进程原生 ORT」列为首选，「渲染侧 ORT-web」列为退路。

### 1.4 由事实推出的 4 条硬约束

1. **C1 离线**：不联网、模型随包或一次性 fetch 落到磁盘（沿用 `scripts/fetch-*` + `extraResources`）。
2. **C2 打包**：`files` 白名单不放宽；原生模块只走 `extraResources`/`asarUnpack`；`npmRebuild:false` 不能破（→ 必须选 **N-API 预编译** 的运行时）。
3. **C3 帧来源**：`overlayMp4` 的媒体帧在 FFmpeg 侧，matte 必须是「文件」而不是「渲染侧内存帧」，才能同时服务两个出口。
4. **C4 许可证**：闭源商业分发 → 只接受 Apache-2.0 / MIT / BSD；GPL 与非商用模型排除。

---

## 2. 候选模型对比

体积/输入为实际文件与模型卡口径；「视频适用」= 能否按帧批量跑（成本与输入尺寸相关，与源分辨率基本无关）。

| 模型 | 形态与体积 | 输入 | 输出 | 单人/物体 | 质量口碑 | 许可证（能否闭源离线分发） | 下载源 |
|---|---|---|---|---|---|---|---|
| **MediaPipe Selfie Segmenter** | TFLite **244 KB**；ONNX 转换版 **≈451 KB** | 256×256 | 256×256 概率/类别 mask | 单人（自拍/半身） | 边缘一般（发丝弱），但极快、极稳 | **Apache-2.0 ✅**（Google MediaPipe；onnx-community 转换同协议） | [TFLite](https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite) · [ONNX](https://huggingface.co/onnx-community/mediapipe_selfie_segmentation) |
| **MODNet** | ONNX **24.69 MB**（fp32）/ 12.38 fp16 / **6.32 MB** uint8 | 512×512 | 单通道 alpha matte | 单人肖像（半身/人像） | 发丝/半透明边缘好，论文定位实时 | **Apache-2.0 ✅**（README 明示 code/models/demos） | [Xenova/modnet](https://huggingface.co/Xenova/modnet) · [官方仓库](https://github.com/ZHKKKe/MODNet) |
| **RVM MobileNetV3** | ONNX **14.98 MB** | 动态，长边 ≤512 足够 | alpha（含时序状态） | 单人视频，时序稳定 | 视频人像 SOTA 级；论文 1080p 104 FPS / 4K 76 FPS（GTX 1080Ti） | **GPL-3.0 ❌**（闭源商业分发有传染风险） | [release](https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx) |
| **IS-Net (general-use)** | ONNX **178.65 MB** | 1024×1024 | 单通道显著性 mask | **通用物体** | 物体抠图强 | **Apache-2.0 ✅** | [rembg release](https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx) |
| **u2net** | ONNX **175.99 MB** (~167.8 MiB) | 320×320 | 单通道 mask | 通用物体 | 老牌、够用 | **Apache-2.0 ✅** | [rembg release](https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx) |
| **u2netp** | ONNX **4.57 MB** | 320×320 | 单通道 mask | 通用物体 | 精度明显弱于 u2net | **Apache-2.0 ✅** | [rembg release](https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx) |
| **RMBG-1.4 / 2.0** | ONNX 168 MB / 更大 | 1024×1024 | alpha | 通用物体/人像 | 商业级质量 | **非商用 ❌**（需向 BRIA 购买商用授权） | [RMBG-1.4](https://huggingface.co/briaai/RMBG-1.4) · [RMBG-2.0](https://huggingface.co/briaai/RMBG-2.0) |
| **BiRefNet / _lite** | `_lite` ONNX **213.6 MB**（fp16 109 MB） | 1024×1024 | alpha | 物体/人像（强） | 当前开源质量第一梯队 | **MIT ✅**（可分发，但太重） | [BiRefNet](https://huggingface.co/ZhengPeng7/BiRefNet) · [lite](https://huggingface.co/onnx-community/BiRefNet_lite) |

**旁证（很有价值）**：同为开源剪辑器的 Concat（AGPL-3.0）真实落地组合 —— 编译内置 **MediaPipe Selfie Segmentation**（ONNX，256²，`include_bytes!`，无需下载）；首次使用时下载 **RVM MobileNetV3（GPL-3.0）** 做「人像真 alpha」、**IS-Net（Apache-2.0，178,648,008 B）** 做「通用物体」；智能画笔用 **SlimSAM**（Apache-2.0）。其 `models.rs` 里每个模型都带 `file / upstream URL / bytes / sha256 / licence` 五元组，下载先落 `.part` 再改名。
→ 说明：**Concat 能用 RVM 是因为它自己就是 AGPL；Socut 闭源，不能照抄这一半。**
来源：[concat-vision/models/NOTICE.md](https://github.com/jub0t/Concat/blob/main/src/crates/concat-vision/models/NOTICE.md)、[concat-vision/src/models.rs](https://github.com/jub0t/Concat/blob/main/src/crates/concat-vision/src/models.rs)、[concat-host/src/cutout.rs](https://github.com/jub0t/Concat/blob/main/src/crates/concat-host/src/cutout.rs)。

### 2.1 模型层面的落地结论

1. **P1 用 Selfie Segmenter**：0.45 MB、Apache-2.0、256²，本机跑「每帧几毫秒」量级，完全够 Lower Third 场景（人物出镜、主播抠像）。
2. **P2 加 MODNet**：6.32 MB uint8 / 24.69 MB fp32，发丝与半透明边缘明显好于 selfie；输入 512²，耗时约为 selfie 的 3–5 倍。
3. **物体抠像（P3）走按需下载 IS-Net**（178 MB 不能进安装包；用 `resources/models/ai-matte` 之外的用户目录缓存，与 whisper 模型同模式）。
4. **永远不要**把 RVM（GPL-3.0）或 RMBG（非商用）打进闭源安装包；若质量不够，优先「MODNet + 手绘遮罩修补」，而不是换 GPL 模型。

---

## 3. 候选运行时对比

| 运行时 | 体积（实测包/资产） | 原生？ | CSP / file:// 影响 | 打包改动 | 推理位置 | 结论 |
|---|---|---|---|---|---|---|
| **onnxruntime-node 1.31.1** | 包 293.4 MB（全平台）；win-x64 实际只需 `onnxruntime.dll` **30.27 MB** + `onnxruntime_binding.node` **0.34 MB**（DirectML EP 再 +17.67 MB `DirectML.dll`） | ✅ 原生（**N-API v6 预编译**，ABI 稳定） | 无（require 磁盘文件，不走 fetch） | `extraResources` 一份运行时目录（或 `asarUnpack`）；`npmRebuild:false` 兼容 | 主进程 / `utilityProcess` | ✅ **首选** |
| **onnxruntime-web 1.31.1** | JS `ort.min.mjs` 0.35 MB + `ort-wasm-simd-threaded.wasm` **14.16 MB`（CPU）；WebGPU 需 `jsep.wasm` **28.15 MB** | ❌ | `wasm-unsafe-eval` **已满足**；但 **file:// 下 wasm fetch 受限** → 需自定义 `socut-app://` 协议或 data: 内联 | 资产进 `out/**`（白名单已覆盖） | 渲染进程 / Worker | ⚠️ 退路（需先做协议改造） |
| **@mediapipe/tasks-vision 1.2.2** | 包 29.8 MB；`vision_wasm_internal.wasm` **13.93 MB** + bundle 0.15 MB | ❌ | 同上（wasm fetch） | 资产进 `out/**` | 渲染进程 | ⚠️ 只支持 `.tflite`，锁死模型选择，不选 |
| **@tensorflow/tfjs 4.22** | 包 140.6 MB；`tfjs-backend-wasm` 12.6 MB；`tfjs-node` 包仅 1.9 MB 但 **postinstall 下载原生** | 部分 | 同上 | 破坏离线/可重复构建 | 渲染/主进程 | ❌ 不选 |

要点：

- **N-API 是关键**：`onnxruntime-node` 的 `bin/napi-v6/**` 是预编译 N-API 绑定，Electron 45（Node 24.22）直接可用，**不需要 electron-rebuild**，因此 `npmRebuild: false` 不用改；代价只是把二进制带进 `extraResources`（约 31 MB，可选 DirectML 加速再 +17.7 MB）。
- 若产品上不能接受原生依赖：退路是「自定义应用协议 + ORT-web WASM」，代价 +14.16 MB 渲染包、单线程 wasm 比原生 CPU 慢约 1.5–3 倍（`[二手/估算]`，本机未实测），且要改窗口加载方式（`loadFile` → `socut-app://`），回归面比原生方案大。
- WebGPU（ORT-web `jsep` 或 ORT-node DirectML）能把推理压到 CPU 的 1.4–9.4 倍（同机不同模型差异很大，见 [dev.to benchmark](https://dev.to/yue_shu_c621a4a637f22396f/webgpu-vs-wasm-in-onnxruntime-web-14x-to-94x-faster-on-the-same-mac-depending-on-the-model-li5)）；但 GPU 路径驱动兼容性风险高，**建议先 CPU、后 DirectML**。

---

## 4. 性能估算（1080p / 10 s / 300 帧）

### 4.1 成本结构

matte 预 pass = ①源解码 + 缩放（FFmpeg，主进程）→ ②逐帧推理（ORT）→ ③matte 编码（FFmpeg）。三件事都能流式串起来，不需要把帧落盘成图片。

- 推理成本只与**模型输入尺寸**有关（selfie 256²、MODNet 512²），与 1080p 无关。
- 解码只需解到模型输入尺寸（如 512×288），比原来完整解码 1080p 更快；10 s 素材解码约 1–3 s（随 CPU/硬件解码）。
- matte 编码：灰度 FFV1（无损、小），`-c:v ffv1 -pix_fmt gray`，320×180~512×288 的 300 帧约 <1 s。本机验证随包 FFmpeg 9.0.2 **含 ffv1/qtrle/prores** `[实测]`。
- 可把「分析帧率」降到 **10–12 fps**（Concat 的 mask 分析网格就是这个思路：`concat-vision::MASK_RATE`），一条 `fps=<输出帧率>` 用最近邻补到 30 fps（本机实测见 4.3 F 用例）。总耗时直接 ÷2.5~3。

### 4.2 每帧推理量级（`[二手/估算]`，待 App 内自测）

| 模型 | ORT-node CPU（多线程） | ORT-web WASM（单线程） | GPU（DirectML/WebGPU） | 依据 |
|---|---|---|---|---|
| Selfie 256² | **3–8 ms** | 5–15 ms | 1–4 ms | Concat 注释「一次几毫秒」；MediaPipe 定位移动端实时 |
| MODNet 512² | 25–60 ms | 60–150 ms | 10–30 ms | 论文定位实时（512²）；同尺寸 CNN 的量级换算 |
| RVM MobileNetV3（长边 512） | 40–100 ms | 100–250 ms | 15–40 ms | 官方 GTX 1080Ti「HD 104 FPS」是 GPU 原生日语；CPU 无官方数 |
| IS-Net 1024² | 800–2500 ms | 不适用 | 300–900 ms | 1024² 大模型 + 178 MB 权重；**只适合静帧/单张**，不适合视频 |
| u2netp 320² | 20–50 ms | 40–100 ms | — | 4.4 MB 小模型量级 |

**300 帧总耗时估算**（含解码/编码约 +30%）：

- selfie 档：**≈2–6 s**
- MODNet 档：**≈10–25 s**
- 再叠加 10 fps 分析网格：selfie **≈1–3 s**、MODNet **≈4–10 s**

### 4.3 本机 FFmpeg 原型验证 `[实测]`（关键结论，已可锁进实现）

用随包 FFmpeg 9.0.2（`resources/ffmpeg/ffmpeg.exe`）在临时目录实测「视频 matte 版 alphamerge」：

```
输入：src.mp4（320×180/30fps/30 帧）、matte.mkv（320×180/30fps/30 帧，FFV1 灰度，左半白右半黑）
链路： [0:v]format=rgba,alphaextract[ae];
       [1:v]format=gray,scale=320:180,fps=30,trim=end_frame=30,setpts=PTS-STARTPTS[mm];
       [ae][mm]blend=all_mode=multiply[mam];
       [0:v]format=rgba[mb];[mb][mam]alphamerge[o]
结果： 输出 30 帧；左半 alpha 均值 255，右半 0 ✅
```

同时得到 3 条**必须写进实现的坑**（与手绘遮罩当年的坑同源）：

1. **等长 matte 会多出 1 帧**：matte 30 帧 + 源 30 帧 → 输出 31 帧；`trim=end=<秒>` 收不掉（边界帧含在 PTS=end 上），**必须用 `trim=end_frame=<N>`**（或 `fps` + `-frames:v`）。
2. **matte 短于段长是安全的**：11 帧 matte + 30 帧源 → 输出 30 帧，framesync `repeatlast` 补帧；这正好支撑「10 fps 分析网格 + `fps=` 补齐」方案（实测 10fps matte + `fps=30` → 30 帧、右半 alpha 仍为 0）。
3. **matte 与源帧率不同必须显式 `fps=<输出帧率>`**：25fps matte 不加重采样直接混会产生帧数/时序偏差；加 `fps=30` 后 30 帧对齐。

> 与现有的静图 1 帧 matte 方案（`-loop 1 -t 1/fps` + repeatlast）兼容：视频 matte 用 `fps`+`trim=end_frame`，静图 matte 保持原参数，argv 零回归。

---

## 5. 集成设计（具体到文件与函数）

### 5.1 总体管线

```
用户给片段挂「AI 抠像」
        │
        ▼  (主进程 matte 作业，导出前跑；有缓存则跳过)
FFmpeg 解码源窗口 @512×288/输出fps ──► ORT 推理（selfie/MODNet）──► 灰度帧
        │                                                      │
        ▼                                                      ▼
FFmpeg 编码 matte 视频（ffv1 gray，落任务 workspace 或工程缓存）
        │
        ▼
导出：OverlaySegment 增加 matte 输入 ──► 现有段链
   alphaextract → blend=all_mode=multiply → alphamerge
   （单轨再叠黑底；多轨保留 RGBA）
```

与现有设计的关系：**不新造合成分支**，只是把「matte 来源」从「一张静态 PNG」扩成「PNG 或视频文件」。两个出口（overlayMp4 / transparentMov）都自动受益，PNG 序列出口可以只写 matte 文件不合成。

### 5.2 管线泛化（P0，核心改动）

| 位置 | 现状 | 改法 |
|---|---|---|
| `src/shared/types.ts` `OverlaySegment.maskPath?: string`（:1178） | 只有静态 PNG 路径 | 新增 `matte?: { kind: 'image' \| 'video'; path: string; fps?: Fps }`；`maskPath` 保留为 image 的兼容别名（首版只写 `matte`，读时兼容 `maskPath`） |
| `src/shared/ffmpegArgs.ts` `buildMaskInputArgs(maskPath, fps)`（:566-568） | `-loop 1 -framerate fps -t 1/fps -i PNG` | 拆成 `buildMatteInputArgs(matte, fps)`：image 分支原样；video 分支 `['-i', path]`（可选 `-ss/-t` 由调用方按段窗口裁剪） |
| `MediaMaskChainInput`（:570-586） | 无 kind | 增 `kind: 'image' \| 'video'`；`buildMediaMaskFilterChain`（:600-635）video 分支在 `format=gray,scale` 后插 `fps=<fps>,trim=end_frame=<round(duration*fps)>,setpts=PTS-STARTPTS`（实测 E 用例） |
| `maskInputIndexFor` / `overlayLabel`（:544-555、`overlayMp4.ts:389-396`） | 按「带 mask 的段数」计数 | 改为按「带 matte 的段数」计数；**仍是每段 1 个输入**，编号纪律不变，水印/音频顺移不变 |
| `segmentWantsMask`（:539-542） | 看 `maskPath` 非空 | 改 `segmentWantsMatte`：`matte.path` 非空；`segmentsNeedMultiInput`（:697-698）同步改 |
| `src/main/export/overlayMp4.ts` `writeMediaMaskFiles`（:160-187） | 只收 PNG 字节、写 `mask-<id>.png` | 保留给手绘遮罩；新增 `attachMattePaths(segments, files)`（或扩展成 `{clipId, path, kind}` 列表），按 clipId 映射、数量不匹配仍直接报错 |
| `src/main/export/overlayMp4.ts` 输入拼装（:503-510） | `writeMediaMaskFiles` 后 `attachMaskPaths` | `matteFiles = [...]`（渲染侧 PNG + 主进程生成的 matte 视频）→ 统一 `attachMattePaths` |
| `src/renderer/src/render/exportRunner.ts` `rasterizeExportMasks`（:274-287）/ `mediaMasks`（:612-620） | 只提交手绘 PNG | 手绘遮罩仍走这里；AI matte 由主进程按 `segment` 数据自行生成（见 5.4），请求里只带意图，不传帧 |
| `src/shared/types.ts` `ExportRequest`（:1253-1270） | `mediaMasks` | 增 `mediaMattes?: Array<{ clipId; modelId?; subject?; sourceInSec; sourceOutSec; fps; width; height }>`（**元数据**，不传帧） |

### 5.3 数据模型建议

```ts
// src/shared/types.ts（示意；实际实现时再定稿）
export interface MediaClipMatte {
  kind: 'ai'
  model: 'selfie' | 'modnet' | 'object'   // object=P3
  /** 分析网格帧率，缺省 10 */
  analysisFps?: number
  /** 羽化：0..20（画面宽度百分比），与手绘遮罩同一语义 */
  featherPct?: number
}
// MediaClip 增加可选字段，缺省不落键（旧工程 JSON 零变化）
matte?: MediaClipMatte
```

- 与 `mask` 并存：**`mask` = 手绘修补层（已有），`matte` = 模型来源**；导出时先模型 alpha、再叠加手绘 stroke 修正（P3 再做叠加语义；P1 时二者互斥并在 UI 上提示）。
- `src/shared/projectSchema.ts`：加 `normalizeMediaClipMatte`（枚举兜底、analysisFps 夹 5–30、featherPct 夹 0–20、未知 model → 删除整键），接进 `normalizeMediaClip`。
- `src/renderer/src/state/projectStore.ts`：`setMediaClipMatte(id, matte|undefined)`（同值不推 revision，与 `setMediaClipMask` 完全同口径）。
- 预览/检查器：`MediaClipInspector` 增加「AI 抠像」分区（模型选择、分析帧率、羽化、重新分析、清除）。
- CLI/MCP 对齐（可选，P2）：`clip.matte { id, matte|null }`。

### 5.4 主进程 matte 作业（P1）

建议新增模块（不改既有函数语义）：

```
src/main/export/matteJob.ts     // 编排：区间裁剪 → 解码 → 推理 → 编码；进度/取消/缓存
src/main/aiMatte/runtime.ts     // onnxruntime-node 懒加载（失败给出可读原因：缺 DLL / 缺模型）
src/main/aiMatte/models.ts      // 模型表：file/upstream/bytes/sha256/licence（照抄 Concat models.rs 范式）
src/main/aiMatte/segmenter.ts   // 预处理(归一化)/推理/后处理（BGR→RGB、0..1、mask 上采样到 matte 尺寸）
```

要点：

- **复用现有 job 基础设施**：`src/main/export/engine.ts` 已有 `phase`（`'preparing'` → `'rendering'`，:221/:310）、`state.cancelRequested`、`JobProgress` 节流（`PROGRESS_THROTTLE_MS=100`）、`notifyProgress` 与 JSON-RPC `export.progress` 事件（:50-83）。matte pass 加一个 `phase:'matte'`，进度 = 已分析帧/总帧；取消走同一 `isCancelled()`（:280/:323）。
- **模型加载一次**：进程内 `OnceLock`/模块级单例；ORT session 复用（`intra_op_num_threads` 按 CPU 核数一半，避免抢导出编码线程）。
- **流式**：`ffmpeg -ss <in> -t <dur> -i src -vf scale=W:H,fps=analysisFps -f rawvideo -pix_fmt rgb24 -` → 按帧读入 → 推理 → `ffmpeg -f rawvideo -pix_fmt gray -s WxH -r fps -i - -c:v ffv1 -pix_fmt gray matte.mkv`。两级 ffmpeg 都有明确退出码/stderr 尾部，失败要可读。
- **缓存**：matte 落在**工程目录**（与 proxy / stab `.trf` 同级），文件名 `matte-<mediaId>-<model>-<analysisFps>-<in>-<out>.mkv`，或用 `matte/` 子目录 + JSON 索引。key 至少含：源文件指纹（大小+mtime 或已有 media 指纹）、modelId、subject、analysisFps、源区间、matte 尺寸。命中直接复用，导出耗时 ≈0。**只补缺失区间**（同一素材多段引用时按源时间轴合并区间）。
- **失败降级**：模型/运行时缺失 → 导出前明确报错（「请先导入 AI 抠像模型」+ 设置页入口），**绝不静默退回手绘**（与 RNNoise 的既有纪律一致，`electron-builder.yml` 注释）。

### 5.5 时间对齐规范（易错点，必须写进实现注释）

1. **生成域 = 源的裁剪窗口**：`[sourceInSec, sourceOutSec]` 用段自己的坐标；因为 matte 只用于该段，生成时直接按段窗口取帧即可，不需要全片 matte。
2. **转场手柄**：`transitionIn` 的扩展手柄（`TransitionPlanContext`，`ffmpegArgs.ts:715+`）意味着段画面可能比 `sourceIn/Out` 多取一段。matte 必须按**扩展后窗口**生成（复用转场计划里已算好的 `sourceInExtSec/sourceOutExtSec`），否则转场期间 alpha 会停在最后一帧。
3. **变速**：渲染侧 `sourceOutSec = sourceIn + (timeline 长度)×speed`（`exportRunner.ts:560-567`）。matte 生成按**输出时间域**取帧（`fps=输出fps`），即对源窗口 `fps=源fps×speed` 重采样；不要生成源帧率 matte 再在链里 `setpts` 变速，容易造成帧错位。
4. **帧数精确**：链里 `fps=<输出fps>,trim=end_frame=<round(段输出时长×fps)>,setpts=PTS-STARTPTS`（实测 E）。**只用 `trim=end=` 不行**（实测 31 帧）。
5. **段数/输入数**：matte 输入仍排在所有段输入之后、透明层/帧流/水印之前；`overlayLabel` 用 `segments.length + matteCount`，与近日志一致。
6. **色彩**：matte 只取亮度（`format=gray`），与源 YUV 4:2:0 无关；不需要 alpha 预乘处理（源按 straight alpha，alphamerge 后仍 straight，与手绘遮罩一致）。

### 5.6 预览（分阶段，避免拖垮首版）

- **P1（导出生效）**：预览不实时抠像；片段角标「AI 抠像 · 导出时生效」；点「重新分析」时展示进度条（复用导出 job 进度 UI 的模式）。这是现有降噪/增强/安全的同款口径（`docs/verification/M8.md:192`）。
- **P2（静止帧预览）**：matte 分析完成后，暂停时用「当前帧 → 一次推理（~5–15 ms）→ canvas 合成」显示结果；播放时回退原片，避免实时性能接管。
- **P3（播放预览）**：用低分辨率 matte 视频 + `<video>` 的 `requestVideoFrameCallback` 把 matte 帧画进离屏 canvas，与媒体层做 `globalCompositeOperation='destination-in'` 合成（或每个 rAF 生成 blob URL 给 CSS `mask-image`，注意 revoke）。风险：与现有 DOM 预览层（`MediaPreviewLayer`/`MaskPaintLayer`）耦合，放到最后。

### 5.7 离线资产与打包（沿用既有模式）

- 脚本：`scripts/fetch-ai-matte-model.mjs`（参照 `scripts/fetch-whisper-model.mjs`/`fetch-rnnoise-model.mjs`）：下载 → 校验 sha256 → 落 `resources/models/ai-matte/`。
- 内置（selfie）：`resources/models/ai-matte/selfie-segmentation.onnx`（451 KB），`extraResources` 加一条 `from: resources/models/ai-matte to: models/ai-matte`。
- 原生运行时：`extraResources` 加 `node_modules/onnxruntime-node/bin/napi-v6/win32/x64/{onnxruntime.dll,onnxruntime_binding.node}` + 其 JS 包装（或整包 `asarUnpack`）；**`files` 白名单不动**。
- `package.json` 新增依赖 `onnxruntime-node`（N-API，无需 rebuild；`npmRebuild:false` 保持不变）。
- 缺失时：CI 仍能出包（只 warn），功能入口禁用并给可读错误 —— 与 whisper/rnnoise 完全一致。

### 5.8 失败模式清单（实现时逐条给测试）

| 失败 | 表现 | 应对话术/行为 |
|---|---|---|
| 运行时 DLL 缺失/加载失败 | ORT session 创建抛错 | 导出前报「AI 抠像运行时不可用」，禁用入口（设置页可看原因） |
| 模型缺失/哈希不符 | 找不到文件 | 「请先取回 AI 抠像模型（npm run fetch:ai-matte）」，不静默回退 |
| 推理失败（尺寸/NaN） | 单帧失败 | 该帧 matte 置全白并记日志；连续失败 N 帧 → 整段报错，不产出半透明脏片 |
| 取消 | 用户在 matte pass 中取消 | 清理 `.part`/临时文件，job 状态 cancelled |
| matte 与段数量不匹配 | 主进程接线时 | 直接报错（比错配 matte 到别的段好） |
| 4K 输出 | matte 512 上采样到 4K | 边缘变软是可接受代价；如需更锐可给「matte 尺寸 1024」档（成本×2~4） |

---

## 6. 分阶段实施计划

| 阶段 | 交付 | 验证方式（可独立验收） | 预估工作量 | 风险 |
|---|---|---|---|---|
| **P0 泛化 matte** | `OverlaySegment.matte{kind:'image'\|'video',path}`；`buildMatteInputArgs`；`buildMediaMaskFilterChain` 视频分支（`fps,trim=end_frame,setpts`）；`attachMattePaths`；**外部 matte 导入（选一个静止 PNG / 一个 mp4 当 matte）** | argv 快照零回归（无 matte 时逐字节不变）；真机 e2e：视频 matte 左半透明/右半可见、帧数精确 = 段长；外部导入 UI 走通 | 1–2 天 | 输入编号/帧数偏移（已被 4.3 实测锁定做法） |
| **P1 selfie + 主进程 ORT** | `onnxruntime-node` + `resources/models/ai-matte/selfie`；`matteJob.ts` 流式解码→推理→matte 编码；缓存；`MediaClip.matte` 数据链（schema/store/检查器/角标）；job phase `matte` + 取消 | 真机 e2e：1080p 单轨抠像导出（黑底/多轨透明各 1 例）、重导出命中缓存、取消清理；单测：模型表 sha256、缓存 key、失败路径 | 3–5 天 | 原生打包/CI；质量（多人/侧脸） |
| **P2 MODNet 质量档 + 预览（静止帧）** | 模型表加 modnet；UI 选模型；分析帧率 5–30 可选；暂停态预览 | 质量对比截图（selfie vs modnet）；预览开关不改变导出结果 | 2–3 天 | 推理耗时（~4–10 s/10 s 素材） |
| **P3 物体模式 + matte 叠加手绘修补 + 播放预览** | IS-Net 按需下载（178 MB，校验 sha256）；matte × 手绘 stroke 合成；rVFC 播放预览 | 物体抠像 e2e；手绘修补可见；播放预览帧率 ≥25fps | 3–5 天 | 模型下载体验、预览性能 |

**建议节奏**：P0 单独一个 PR（零依赖、零风险、可发布）；P1 一个 PR（最大风险集中在这里，先在 1/2 个真机样本上量耗时再定默认模型）；P2/P3 按产品优先级排。

---

## 7. 退路（如果关键约束不满足）

1. **原生依赖被否 / CI 不接受 31 MB 原生** → 走「自定义 `socut-app://` 协议 + ORT-web WASM」：先把 `out/renderer` 用协议供出（现有 4 个协议可复用模式），再 `ort.min.mjs` + `ort-wasm-simd-threaded.wasm`（14.16 MB，进 `out/**` 白名单）。代价：+14 MB 安装包、推理慢 1.5–3 倍、窗口加载代码要动（回归面大）。
2. **打包体积连模型都不能带** → selfie 只有 451 KB，几乎不可能被否；MODNet 取 uint8 6.32 MB 也远小于 whisper 141 MB 的先例。
3. **AI 质量不接受（多人、遮挡、侧脸）** → **P0 的外部 matte 导入就是兜底产品**：用户可用外部工具生成 matte 视频/PNG，走同一条管线；同时保留手绘遮罩修补。
4. **时间对齐风险** → P0 已把视频 matte 的帧数/时长/输入编号问题全部实测锁死（4.3 的 A–F 用例可 1:1 变成测试）；AI 只是替换「matte 从哪来」，不碰对齐逻辑。
5. **Windows 之外的平台**：`onnxruntime-node` 有 darwin/linux 预编译；打包时按平台各带一份即可（目前只出 win-x64，暂无成本）。

---

## 8. 最终结论

**go（有条件）**，首选组合：

- **运行时**：`onnxruntime-node`（N-API v6 预编译）在主进程跑，CPU 优先、DirectML 可选。
- **模型**：MediaPipe Selfie Segmenter 256²（Apache-2.0，451 KB，编译内置，默认）+ MODNet 512²（Apache-2.0，6.32 MB uint8，质量档）+ IS-Net（Apache-2.0，178 MB，按需下载，物体档）。
- **集成**：matte 预 pass 生成「灰度 matte 视频（FFV1）」→ 复用现有 `alphamerge` 段链；视频分支固定 `fps=<输出fps>,trim=end_frame=<N>,setpts=PTS-STARTPTS`；matte 缓存在工程目录，按媒体指纹+模型+源区间增量补齐。
- **体积/耗时量级**：安装包 **+31 MB 原生 + 0.5～6 MB 模型**；1080p/10 s 抠像 **2–10 s**（selfie，10 fps 分析网格）或 **10–25 s**（MODNet，全帧率），命中缓存后 ≈0。
- **最大风险**：原生依赖的打包/CI；其次是 AI 质量与预览实时性。
- **下一步**：先做 **P0（视频 matte 泛化 + 外部 matte 导入）**，它是 AI 的前置、也是退路，且能立刻交付一个可见功能。

---

## 9. 来源

**仓库内取证**（相对路径）
- 遮罩数据契约与导出链路：`src/shared/types.ts:521-537`、`543-583`、`1140-1179`、`1253-1270`；`src/shared/ffmpegArgs.ts:486-709`；`src/main/export/overlayMp4.ts:130-215`、`389-396`、`503-510`；`src/renderer/src/render/exportRunner.ts:220-287`、`612-620`；`docs/verification/M8.md:125-192`
- 帧供给架构：`src/renderer/src/render/frameSource.ts`、`src/main/export/framePump.ts`、`src/main/export/engine.ts:46-83`、`src/preload/index.ts`（export/job API）
- 打包与离线：`electron-builder.yml`、`package.json`、`scripts/check-env.mjs:213-227`、`electron.vite.config.ts:30`、`src/renderer/index.html:8`、`out/renderer/index.html:8`、`src/main/windows.ts:66-68`
- 随包 FFmpeg：`resources/ffmpeg/ffmpeg.exe`（9.0.2，含 ffv1/qtrle/prores/P5 编码器）

**模型与许可证**
- MediaPipe Selfie Segmenter 文档：<https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter>
- 自拍分割 TFLite（244 KB）：<https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite>
- 自拍分割 ONNX（Apache-2.0）：<https://huggingface.co/onnx-community/mediapipe_selfie_segmentation>
- MODNet 论文：<https://arxiv.org/abs/2011.11961>；官方仓库与 Apache-2.0 声明：<https://github.com/ZHKKKe/MODNet>
- MODNet ONNX（24.69 MB fp32 / 6.32 MB uint8）：<https://huggingface.co/Xenova/modnet>
- RVM 论文：<https://arxiv.org/abs/2108.11515>；官方速度声明与下载：<https://github.com/PeterL1n/RobustVideoMatting>；**GPL-3.0**：<https://github.com/PeterL1n/RobustVideoMatting/blob/master/LICENSE>
- IS-Net（Apache-2.0，178,648,008 B）：<https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx>
- U-2-Net（Apache-2.0）：<https://github.com/xuebinqin/U-2-Net>；u2net 175,997,641 B / u2netp 4,574,861 B：<https://github.com/danielgatis/rembg/releases/tag/v0.0.0>
- RMBG-1.4（**非商用**）：<https://huggingface.co/briaai/RMBG-1.4>；RMBG-2.0：<https://huggingface.co/briaai/RMBG-2.0>
- BiRefNet（MIT）：<https://huggingface.co/ZhengPeng7/BiRefNet>；BiRefNet_lite ONNX（213.6 MB）：<https://huggingface.co/onnx-community/BiRefNet_lite>

**运行时**
- onnxruntime-web（1.31.1；wasm 14.16 MB / jsep 28.15 MB）：<https://www.npmjs.com/package/onnxruntime-web>、<https://unpkg.com/onnxruntime-web@1.31.1/>
- onnxruntime-node（1.31.1；win-x64 dll 30.27 MB + binding 0.34 MB，N-API v6）：<https://www.npmjs.com/package/onnxruntime-node>、<https://unpkg.com/onnxruntime-node@1.31.1/bin/napi-v6/win32/x64/>
- ORT WebGPU EP：<https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html>
- WebGPU vs WASM 同机 1.4–9.4×（二手 benchmark）：<https://dev.to/yue_shu_c621a4a637f22396f/webgpu-vs-wasm-in-onnxruntime-web-14x-to-94x-faster-on-the-same-mac-depending-on-the-model-li5>
- @mediapipe/tasks-vision（1.2.2；wasm 13.93 MB）：<https://www.npmjs.com/package/@mediapipe/tasks-vision>
- TensorFlow.js（含 tfjs-node postinstall 下载原生）：<https://www.npmjs.com/package/@tensorflow/tfjs-node>
- Electron 45.2.1 = Chromium 156 / Node 24.22.1：<https://releases.electronjs.org/>

**同赛道工程范式（许可证思路来源）**
- Concat（AGPL-3.0）模型表（含 sha256/licence）：<https://github.com/jub0t/Concat/blob/main/src/crates/concat-vision/src/models.rs>
- Concat 内置 MediaPipe 自拍分割模型说明：<https://github.com/jub0t/Concat/blob/main/src/crates/concat-vision/models/NOTICE.md>
- Concat 抠像作业编排（分析网格、缓存、单飞）：<https://github.com/jub0t/Concat/blob/main/src/crates/concat-host/src/cutout.rs>
