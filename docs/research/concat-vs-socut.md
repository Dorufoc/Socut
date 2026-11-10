# Concat × Socut 功能对比与迁移建议

> 对比对象：[jub0t/Concat](https://github.com/jub0t/Concat)（GitHub 开源，Rust 跨平台剪辑器，约 **16,024 star / 1,994 fork**，AGPL-3.0）
> 本地项目：Socut（本仓库，Electron + React 的广播新闻字幕条 / 透明叠层导出工具）
> 调研时间：2026-11-09。Concat 资料取自仓库 README、`docs/MCP.md`、`src/README.md`、开发者文档站点与 Releases 元数据；Socut 资料取自本仓库源码与 `docs/`。

---

## 0. 一句话结论

**两个项目不是同一条赛道，不能整体对标。** Concat 是「面向普通人的通用剪辑器」（消费级、跨平台、AI 自动化），Socut 是「面向新闻/广播的垂直生产工具」（透明 alpha 交付、栏目标签规范、模板纪律）。

因此正确的做法不是"抄功能"，而是：

1. **把 Concat 的 3 类"能力范式"搬进 Socut**：模板化、可脚本化（MCP）、AI 辅助（ASR/降噪/抠像）；
2. **补掉 Socut 三个真实短板**：无关键帧、无模板/批量生产、无 AI；
3. **保留并强化 Socut 的护城河**：透明 MOV / 叠层 MP4 交付、广播合规校验、视觉回归验收 —— 这些 Concat 完全不支持。

---

## 1. 项目基本面

| 维度 | Concat（jub0t/Concat） | Socut（本仓库） | 差距判断 |
|---|---|---|---|
| 定位 | 免费开源跨平台 **CapCut 替代品**：口播/短视频/教程剪辑 | **离线广播级新闻字幕条（Lower Third）+ 透明 MOV/MP4 叠层导出** | 目标用户完全不同：Concat 打"量大"的 C 端，Socut 打"精度"的 B 端 |
| 形态 | 原生桌面 App（Win/mac/Linux/Android/iOS 侧载） | Electron 桌面 App（Windows x64） | Concat 跨 5 平台，Socut 只有 Windows |
| 技术栈 | Rust（13 个 crate）+ Slint + Skia + wgpu GPU 合成 + FFmpeg 链接 | Electron 45 + React 19 + zustand + yoga-layout + FFmpeg 子进程 | 架构代差大，但**不建议重写**（见 §6） |
| 许可证 | **AGPL-3.0-or-later**（另有商业授权可谈） | UNLICENSED（私有） | ⚠️ **不可复制代码**，只能学思路（见 §7） |
| 成熟度 | Beta，v0.2.10；2026-08-25 建仓 → 3 个月 9 个 release，累计下载 52 万+ | v0.1.0，内部工程，已有 39 个测试文件 / 1.19 万行测试 | Concat 社区/迭代速度远超，但其功能仍带 beta 棱角 |
| 语言/文档 | 26 种语言 README + 站点文档，中/繁/日/韩齐全 | 中文单语（`src/shared/i18n.ts` 集中文案，非 key-based） | i18n 是 Concat 的隐性优势，对 Socut 优先级低 |
| 代码规模 | Rust 工作区（`concat-core/media/project/render/effects/export/api/server/cli/host/speech`） | TS 284 文件 / 7.37 万行（`src`+`cli`+`scripts`+`tests`） | Socut 规模已不小，重心应放在"产品化"而非"重写" |

---

## 2. 技术架构对比（决定"能不能搬"）

| 层 | Concat | Socut | 对迁移的含义 |
|---|---|---|---|
| UI | Slint + Skia（原生控件） | React 19 + CSS（DOM 渲染） | 代码不可复用；但交互范式可借鉴 |
| 合成/渲染 | `concat-render`：wgpu GPU 合成，Rust 帧循环 | DOM 布局（yoga-layout 测量）+ 逐帧 `captureStream → raw/png → ffmpeg` 管道 | Socut 用"浏览器即合成器"，已足够做字幕条；GPU 化只在 4K 长片时才是瓶颈 |
| 媒体 | FFmpeg 链接进进程（libav*），零 spawn | FFmpeg/ffprobe 子进程 + stdin raw 帧流（`src/main/export/*`） | Socut 的流式方案更易维护，无需更换 |
| 效果模型 | **效果包**：`packages/` 下每包 = TOML manifest + WGSL shader + 音频 FFmpeg 链模板 + 参数 schema | 内置固定效果：19 种转场（`shared/transitions.ts`）、RGB 曲线调色、稳定、音频 fx | Concat 的"效果包 + manifest"是最值得搬的**扩展机制**（见 §4-P1） |
| 项目格式 | `concat.json`（Rust serde 模型，命令式编辑 + undo） | `.socut` JSON + `applyClipStyleToAll` 等纯函数 schema | Socut 已有良好 schema 纪律，可加"模板"层 |
| AI | whisper.cpp（进程内）+ Kokoro TTS（sherpa-onnx）+ 抠像/稳定模型，首次下载后离线 | **无任何 AI 依赖**（全仓 0 处 whisper/onnx/llm） | Socut 需以 sidecar/ONNX Runtime 方式引入，不能照搬 Rust 集成 |
| 自动化 | JSON-RPC over TCP/Unix socket、gRPC、**MCP server**、CLI、token 鉴权、项目锁 | 本地 HTTP + token 的 CLI 控制面（60+ 命令，`docs/cli.md`），自动拉起、JSON 信封 | Socut 已有 80% 基础，**缺 MCP 一层**（成本最低、收益最高） |

---

## 3. 功能逐项对比

图例：✅ 已具备　🟡 部分/受限　❌ 无　— 不适用

### 3.1 时间线 / 剪辑

| 能力 | Concat | Socut | 迁移价值 |
|---|---|---|---|
| 多轨 | ✅ 无限视频/图片/标题轨，画中画叠加 | ✅ 多轨（M5 起软上限 50 条，原 8 条硬上限已解除）+ 固定字幕轨（恒在最上层） | 已对齐 |
| 多时间线 / 多 sequence | ✅ 一个工程多段剪辑 | ❌ 单时间线 | 🟡 P2（一期节目多段落时才需要） |
| 基础剪辑 | ✅ 分割/裁剪/波纹删除/合并/冻结帧/变速/磁性时间线 | 🟡 媒体段 `move/trim/split/remove/select` + 变速（`clip.speed`）；无波纹、无冻结帧 | 🟡 P1：波纹删除 + 冻结帧对"改稿重排"很实用 |
| 转场 | ✅ 100 种 GPU 转场 | ✅ 19 种 `xfade` 转场（6 族，`shared/transitions.ts`） | 数量差距 ≠ 价值差距；新闻场景 19 种足够 |
| 变换/裁切/翻转/混合模式 | ✅ 位置/缩放/旋转/裁剪/翻转/blend mode | 🟡 位置/缩放/旋转/镜像（`shared/mediaClipVideo.ts`）；无裁切、无 blend | 🟡 P2 |
| 关键帧 + 曲线编辑器 | ✅ 位置/缩放/旋转/不透明度/音量/效果参数全可关键帧，内置贝塞尔曲线编辑 | ❌ **无关键帧**；只有预设驱动的入场/出场擦除 + 缓动选择 + 逐字错峰（`panels/AnimationPanel.tsx`） | 🔴 **P0/P1：Socut 最大的能力缺口**（见 §4-P0-5） |
| 调色 | 🟡 滤镜/基础调色 + HDR 时间线（HLG/PQ） | ✅ RGB 四通道自由打点曲线（`panels/CurveEditor.tsx`）+ 亮度/对比度/饱和度；导出统一 SDR BT.709 | Socut 反而更专业（广播只认 BT.709） |
| 稳定 / 代理 / 硬件解码 | ✅ 稳定、代理、硬件解码、4K 顺滑 | ✅ 稳定（`clip.stab`）、代理（`src/main/mediaProxy.ts`）、GPU/编码器体检（`app.gpu`）；预览走 DOM | 平手 |

### 3.2 标题 / 字幕（Socut 的正面战场）

| 能力 | Concat | Socut | 迁移价值 |
|---|---|---|---|
| 标题样式 | ✅ 字体/描边/阴影/背景板 + 起始预设 | ✅ 8 套广播预设 + 令牌层覆盖（5 色/透明度/渐变/字号缩放/字体/缓动/逐字渐显）+ 安全区/行数/对比度硬约束 + `fontSizeCapPx` 上限 | **Socut 更强、更"广播"**；不要为了对齐 Concat 而削弱约束 |
| 逐词/局部样式 | ✅ `title_style_words`：某些词换色/字重/字号 | ❌ 只有整条级别 `styleOverrides` | 🔴 P0-4：人名/职务/数字高亮是新闻刚需 |
| 自动字幕（ASR） | ✅ 本地 Whisper，选模型大小，自动生成带样式字幕到时间线 | ❌ 纯手工录入 | 🔴 P1-6：把通稿/口播变成字幕条，效率提升最大 |
| 字幕导出 SRT/ASS | 🟡 以时间线字幕片段为主 | ❌ 只导出画面（MOV/MP4/PNG） | 🟡 可选：SRT 旁挂文件对审片有用来着 |
| 批量/列表管理 | ✅ `clips_add_sequence` 批量落片段 | 🟡 字幕列表面板（`CaptionListPanel.tsx`）可增删跳转，但仍逐条手工 | 🔴 P0-3：CSV/JSON/稿件批量生成 |
| 模板 | ✅ `template.list/instantiate/save`（作品→模板→再实例化） | ❌ 只有 8 套内置预设，无"工程模板" | 🔴 P0-1：栏目日更模板 |

### 3.3 AI / 音频

| 能力 | Concat | Socut | 迁移价值 |
|---|---|---|---|
| 语音识别 | ✅ whisper.cpp 进程内，离线 | ❌ | P1（见上） |
| TTS / 声音克隆 | ✅ Kokoro 本地 TTS + 几秒样本克隆音色 | ❌ | 🟡 P2；克隆音色有新闻真实性与法律风险，建议只做"标准播报音" |
| 背景移除 / 抠像 | ✅ 人像/物体/手绘 mask | ❌ | 🟡 P1-P2：主播出镜 + 字幕条合成场景可用 |
| 音频清理 | ✅ 一键降噪、人声增强、响度、变声特效 | ✅ 多轨混音、`audio.fx/role/ducking`、audio mastering、响度档位、峰值/频谱 | 🟡 补"降噪/人声增强"即可（RNNoise/DeepFilterNet sidecar） |
| 音频库 | ✅ 内置音效/音乐库（`docs/AUDIO_LIBRARY.md`） | ❌ | 🟡 P2：新闻片头音效包 |

### 3.4 导出 / 交付（Socut 的护城河）

| 能力 | Concat | Socut | 迁移价值 |
|---|---|---|---|
| 编码 | ✅ H.264 / HEVC / **AV1**，CRF、x264 preset、4K60、10bit、colorRange、HDR(HLG/PQ) | 🟡 H.264/HEVC（叠层 MP4）、ProRes 4444（`yuva444p10le`）/ Qtrle、PNG 序列；480p–4K；固定 SDR BT.709 | 🟡 可搬 AV1、10bit、CRF 直给；**HDR 不建议搬**（广播交付只认 SDR） |
| **透明通道 / Alpha 交付** | ❌ **无**（导出参数只有 h264/hevc/av1，无 alpha、无 MOV/ProRes/PNG 序列出口） | ✅ 透明 MOV（ProRes 4444 `ap4h` 带 alpha，另 qtrle 兼容模式）+ PNG 序列，并用 ffprobe 校验 fourcc/pix_fmt | 🟢 **护城河，反向优势**；Concat 用户要做透明叠层反而没有出路 |
| 叠层合成交付 | ❌ 只能输出"成片" | ✅ `overlayMp4`：透明叠层 + 参考视频**流式两阶段**合成 H.264/HEVC，不落中间大文件 | 🟢 护城河：这是电视台/后期"字幕条 + 素材"工作流的核心 |
| 体积预估 / 磁盘门禁 | 🟡 无明确体积预估 | ✅ `export.estimate`（ProRes/H.264 分口径标定）+ 磁盘不足拒绝 | 🟢 保留 |
| 产物校验 | 🟡 无（CI 层面） | ✅ 导出后 ffprobe 断言 alpha/fourcc/帧率/时长（`src/main/export/verify.ts`） | 🟢 保留 |

### 3.5 自动化 / 工程质量

| 能力 | Concat | Socut | 迁移价值 |
|---|---|---|---|
| RPC API | ✅ JSON-RPC 行协议（TCP/Unix socket）+ gRPC + 错误码体系 + 事件流 | ✅ HTTP + Bearer token + `ok/error.code` 信封 + 事件轮询 | 平手；Socut 缺 gRPC（无必要） |
| **MCP（AI Agent 直连）** | ✅ `concat --mcp` 内建 MCP server，30+ 工具（建工程/导入/切割/加标题/关键帧/导出/取帧），支持 window / headless 两种模式与项目锁 | ❌ | 🔴 **P0-2：Socut 已有 60+ CLI 命令，包一层 MCP 就能让 Claude Code / Cursor 直接产出字幕条** |
| 取帧回传 | ✅ `preview.frame` → PNG 给 Agent 看 | 🟡 `export.cover` 导出当前帧 PNG（面向人，不是 Agent 友好封装） | P0-2 一并做 |
| 项目锁 | ✅ `concat.lock` 防止窗口与 Agent 互踩 | 🟡 单实例 + 自动存档，无显式锁 | 🟡 做 MCP 时需补 |
| 测试/验收 | ✅ cargo test/clippy/fmt CI + locales 脚本 | ✅ vitest 39 文件 1.19 万行 + `visual:check`（8 预设×3 文案出图+指标+退出码）+ `smoke` + `verify-all` + 人工验收清单 | 🟢 Socut 工程纪律反而更贴合"交付级"要求，保留 |

---

## 4. 可迁移清单（按优先级）

> 成本为**粗估人日**（1 人），前提是沿用现有 Electron/TS 架构，不重写。

### P0 —— 建议 1–2 个迭代内做（直接放大主业）

| # | 功能 | 借鉴自 Concat | 为什么值得做 | 落地方式 | 成本 | 风险 |
|---|---|---|---|---|---|---|
| 1 | **栏目模板（工程模板）** | `template.list/instantiate/save`（template.json + 媒体 + poster.jpg） | 新闻日更的核心诉求是"每天同样的版式、换内容"；现有 8 预设只是样式，不含时长结构/素材槽/片头片尾 | 在 `.socut` 工程上做"模板导出/实例化"：抽取 `presets + 时间轴骨架 + 水印 + 音频角色`，素材槽以占位媒体表达；CLI 加 `template.*` | 3–5 | 模板与工程 schema 版本演化需迁移策略 |
| 2 | **MCP Server（Agent 直连）** | `concat --mcp`（stdio JSON-RPC、30+ 工具、window/headless、项目锁） | 差异化卖点："让 AI 直接生成一条新闻字幕条"；已有 60+ CLI 命令与 token 鉴权，只差协议适配 | 新增 `mcp/` 入口：把 `app/project/media/clip/export/preview` 映射成 MCP tools；补 `preview_frame`（PNG base64）与项目锁 | 2–4 | 需处理"窗口正在编辑"的互斥（Concat 也是分 window/headless 两种模式解决的） |
| 3 | **批量名单/稿件 → 多条字幕条** | `captions_add` / `clips_add_sequence` 的"序列生成"范式 | 一次采访/一份名单十个人，逐条手打是最大效率黑洞 | CSV/JSON/纯文本导入 → 生成 N 条字幕条，按帧吸附排布，自动处理重叠与最小间隔 | 3–5 | 排版冲突（`clipCollision` 已有）与时长估算 |
| 4 | **逐词/关键词局部样式** | `title_style_words` | 新闻可读性刚需：人名、职务、数字、地名高亮；也是"从 8 套预设进化到可定制"的最短路径 | `styleOverrides` 增加 `runs: [{start,end,color,weight,scale}]`，渲染层按字符区间分段；检查器加"选中文字→设色" | 3–4 | 与逐字渐显动画的裁剪线要统一计算（`layers.charStagger`） |
| 5 | **关键帧（阶段一：媒体段）** | 全参数关键帧 + 贝塞尔曲线编辑器 | Socut 现在动画只能是"预设擦除"，做不了自定义运动；这是与通用剪辑器的最大能力差 | 先做媒体段 `transform/opacity/volume` 关键帧（数据层 `keyframes[]` + 线性/缓动插值 + 时间轴打点 UI）；字幕条参数关键帧留阶段二 | 5–8 | 渲染与 ffmpeg 两侧插值必须同源，否则预览/导出不一致（Concat 用 Rational 时间解决，Socut 需沿用帧对齐） |

### P1 —— 3–6 周内规划

| # | 功能 | 借鉴自 | 价值 | 落地方式 | 成本 |
|---|---|---|---|---|---|
| 6 | **本地 ASR 自动字幕** | whisper.cpp 进程内 + 模型管理 | 口播 → 字幕条；新闻场景可先做"通稿强制对齐"（forced alignment）而非自由转写，准确率更高 | sidecar（whisper.cpp / sherpa-onnx）+ 模型下载器；结果落为字幕条序列，走 P0-3 的排版逻辑 | 6–10 |
| 7 | **动画/效果包机制** | `packages/` = TOML manifest + WGSL + 参数 schema + catalogue | 让栏目/电视台自定义入场动画而不改主程序；把"8 套预设"变成"可扩展包" | 定义 `socut-preset` 包格式（JSON/TOML manifest + 动画曲线函数 + 参数声明），启动扫描 + 校验（沿用 `validatePreset` 纪律），CLI `preset.list/install` | 6–9 |
| 8 | **音频降噪/人声增强** | 一键 voice cleanup | 参考视频音频脏时，叠层成片质量直接受影响 | RNNoise / DeepFilterNet WASM 或 sidecar；接在 `audio.fx` 链上 | 4–6 |
| 9 | **抠像/背景移除** | cutout + 手绘 mask | 主播出镜 + 字幕条同框（虚拟演播室轻量方案） | ONNX Runtime（MODNet/RVM）逐帧出 alpha，接入媒体段效果链 | 8–12 |
| 10 | **编码扩展** | AV1 / 10bit / CRF / 硬件编码 | 更小体积、更快导出；硬件编码对 4K 透明/叠层导出提速明显 | `ffmpegArgs.ts` 增加 av1_nvenc/svt-av1、10bit pix_fmt、CRF 直给、NVENC/QSV/AMF 探测（`app.gpu` 已有基础） | 3–5 |

### P2 —— 战略储备（先不做）

| # | 功能 | 说明 |
|---|---|---|
| 11 | 多时间线/多 sequence | 一期节目多段落时才需要；当前单时间线可用"多工程"替代 |
| 12 | 混合模式 / 裁切 / 翻转 / 画中画 | 通用剪辑能力，新闻场景低频 |
| 13 | TTS 配音 / 声音克隆 | 声音克隆有真实性与法律风险，只建议做标准播报音 |
| 14 | 跨平台（mac/Linux）+ i18n | mac 版对后期机房有价值；i18n 优先级低（先把 `TEXT` 改成 key-based 即可低成本预留） |
| 15 | 引擎 Rust 化 / GPU 重构 | **不建议**：投入 10 人月级，收益只在 4K 长片预览；局部优化（WebCodecs、代理、硬件编码）性价比高得多 |

---

## 5. 不建议迁移（避免被 Concat 带偏）

- **消费级 100 特效/滤镜/贴纸库、竖屏模板库、手机端**：与"广播字幕条交付"用户无关，只会稀释产品定位；
- **HDR / 10bit 成片出口**：Concat 主打短视频，Socut 的交付契约是 SDR BT.709，贸然放开会破坏"产物可被任何播出系统吃下"的承诺；
- **声音克隆**：新闻场景的真实性风险 > 体验收益；
- **MCP live mode**（编辑中的工程被 Agent 改动）：Concat 自己也只在 roadmap（issue #337），Socut 更应坚持"Agent 操作独立工程 + 项目锁"。

---

## 6. 许可证与合规（必须先读）

| 项 | 结论 |
|---|---|
| Concat 许可证 | **AGPL-3.0-or-later**（`LICENSE` / `LICENSING.md`，另有商业授权可购买） |
| Socut 现状 | `package.json` 为 `UNLICENSED`（私有/闭源） |
| 直接复制代码（Rust crate、效果包 WGSL、`packages/` 资源） | ❌ **不可**：AGPL 具有传染性，会要求 Socut 整体开源并对外提供源码 |
| 学习架构 / 产品行为 / 交互范式，用 TS 重新实现 | ✅ 可以（Concat 自己也有 `CLEAN-ROOM.md` 的洁净室规范，说明其同样重视"只学思路不抄代码"） |
| 引用其 README 的功能描述做对比 | ✅ 可以，注明出处 |
| 若确实要复用其代码 | 需按其 `LICENSING.md` 购买商业授权，或接受 AGPL 开源 |

> 建议：把这份对比表作为"能力地图"，落地时全部按 **独立实现 + 自写测试** 推进，并在 PR 描述里注明灵感来源（Concat 的哪一项行为）。

---

## 7. 建议的推进节奏（3 个冲刺）

| 冲刺 | 目标 | 交付物 | 验收方式 |
|---|---|---|---|
| S1（1–2 周） | "日更可用" | 栏目模板 + 批量名单导入 + 逐词样式 | 用一份 10 人名单，一条命令生成 10 条字幕条并导出透明 MOV；`visual:check` 全绿 |
| S2（2–3 周） | "AI 可用" | MCP server + 预览取帧 + 项目锁 | 在 Claude Code 里用自然语言生成字幕条并导出，全程不打开窗口（headless） |
| S3（3–6 周） | "可定制" | 关键帧、效果包机制、ASR 自动字幕 | 自定义入场动画（非预设）通过包机制加载；口播 3 分钟自动出字幕条，人工只需改错字 |

---

## 8. 证据来源

**Concat**
- 仓库主页 / README（Highlights、About、平台、构建要求）：https://github.com/jub0t/Concat
- 引擎架构与 crate 划分：仓库 `src/README.md`（Concat Engine）
- MCP 工具清单与 Agent 接入方式：仓库 `docs/MCP.md`
- 导出参数（codec/crf/tenBit/colorRange/hdr）：开发者文档 https://concat.standalones.org/docs/api/methods
- 项目/模板 API（`template.list/instantiate/save`、`concat.json`）：同上
- 版本与下载量：GitHub Releases 与 repo 元数据（v0.2.1 2026-09-04 → v0.2.9 2026-11-05，累计下载 520,962）
- 许可证：仓库 `LICENSE` / `LICENSING.md`（AGPL-3.0-or-later + 商业授权）

**Socut（本仓库）**
- 产品与导出契约：`package.json`、`docs/presets.md`、`docs/cli.md`
- 预设与动画纪律：`docs/presets.md`、`src/shared/presets/*`、`src/renderer/src/panels/AnimationPanel.tsx`
- 透明导出与校验：`src/main/export/transparentMov.ts`、`overlayMp4.ts`、`verify.ts`、`src/shared/probe.ts`
- 多轨与轨道模型：`src/shared/tracks.ts`、`src/shared/constants.ts`（`TRACK_SOFT_LIMIT=50`，`MAX_MEDIA_TRACKS`/`MAX_AUDIO_TRACKS` 为兼容别名）
- 转场：`src/shared/transitions.ts`（19 种）
- CLI 控制面：`docs/cli.md`、`src/shared/cliProtocol.ts`
- 验收体系：`docs/verification/*`、`scripts/visual-check.mjs`、`tests/*`
