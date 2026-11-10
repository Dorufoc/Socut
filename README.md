# Socut

[![verify](https://github.com/Dorufoc/socut/actions/workflows/verify.yml/badge.svg)](https://github.com/Dorufoc/socut/actions/workflows/verify.yml)

**离线广播级字幕条（Lower Third）与图形包装工作台**：把新闻标题条、人名条、台标、图表包做成可在剪辑软件里直接叠加的**透明 MOV / MP4**。

全程离线运行（不联网、不上传素材），Windows x64 桌面应用，Electron + React + Canvas2D 逐帧渲染 + 随包 FFmpeg 合成。

- 定位：CapCut / 剪映这类通用剪辑器的「字幕条 + 图形包装」专用替代，面向广播、政务、企业宣传片的批量出片场景。
- 纪律：**预览与导出同源**——同一份 Canvas 绘制代码既画预览帧也画导出帧，媒体层交给 FFmpeg滤镜图；不引入 WebGL，不做第二套像素实现。

## 功能

| 模块 | 能力 |
|---|---|
| 剪辑内核 | 多序列、媒体轨/音频轨无限条、波纹删除、片段合并、冻结帧、磁性吸附、逐帧吸附 |
| 关键帧 | 参数轨 + 7 种缓动 + 自定义 `cubic-bezier`（禁过冲）、可视化曲线编辑器、媒体段关键帧（预览 CSS 与导出 FFmpeg 表达式同源） |
| 文本与图形 | 富文本元素、图形层 z 档、58 种转场、6 个特效包（含像素级抖动的确定性实现） |
| 音频 | RNNoise 离线降噪、人声增强、变声、响度归一、ducking |
| 抠像 | 手绘遮罩（笔刷/羽化/反向）+ 外部 matte + **AI 人像抠像**（ONNX Runtime 跑 MediaPipe Selfie Segmenter，逐帧生成灰度 matte 并复用导出台账） |
| 编码交付 | 1080p/4K、任意帧率、像素格式与全范围控制、软件编码器回退、透明 MOV（ProRes 4444 / QTRLE）与 MP4 输出 |
| 自动化 | `socut` CLI（JSON-RPC 控制面 + 批量导出）、**MCP server**（供 AI 助手直接驱动项目）、项目锁（窗口 + agent 协作）、`preview_frame` 取帧 |
| 字幕 | Whisper 离线转写（真实二进制 + ggml 模型）、抽音进度、片段窗口映射、批量编辑 |

里程碑验收台账（每个 M 的落地范围、取证命令、明确不做的事）见 [`docs/verification/INDEX.md`](docs/verification/INDEX.md)。

## 环境要求

- Windows 10/11 x64（当前唯一支持平台）
- Node.js **≥ 22.19**（开发机与 CI 统一用 24；jsdom 依赖的 undici 8 需要 22.15+ 的 zstd API）
- 首次运行前需要取回随包资源（脚本支持本地文件/环境变量覆盖，便于内网）：

```powershell
npm install
npm run fetch:ffmpeg        # 随包 FFmpeg（必装，导出/解码都靠它）
npm run fetch:fonts         # 打包字体（标题条排版需要）
npm run fetch:whisper        # 可选：whisper.cpp 二进制
npm run fetch:whisper:model  # 可选：ggml 模型
npm run fetch:rnnoise        # 可选：RNNoise 降噪模型
npm run fetch:matte:model    # 可选：人像抠像 ONNX 模型
```

未取回的可选资源不会导致启动失败：相关功能会**降级并给出可读提示**，对应测试自动 skip。

## 快速开始

```powershell
npm run dev          # 开发模式启动桌面应用
npm run cli -- --help  # CLI：JSON-RPC 控制面，可脚本化批量出片
npm run mcp          # MCP server（stdio），把项目操作暴露给 AI 助手
npm run package:win  # 打 Windows 安装包（NSIS）
```

CLI 与 MCP 的完整命令/工具表分别见 [`docs/cli.md`](docs/cli.md)、[`docs/mcp.md`](docs/mcp.md)。

## 验证

仓库自带三层门禁，CI（`.github/workflows/verify.yml`）跑的是第二层：

| 命令 | 内容 | 最近一次结果 |
|---|---|---|
| `npm run verify` | `check:env` + ESLint + 三套 tsc + vitest | **139 文件 / 1750 passed + 1 skipped** |
| `npm run verify:ci` | 在上一行基础上加 `electron-vite build` | 通过 |
| `npm run verify:all` | 全量验收：CI 等价链路 + CLI/MCP 冒烟 + 10 个应用内场景（真导出、取消回收、逐像素一致性、错误呈现、视觉检查 24 例） | **20/20 步通过** |
| `npm run smoke:packaged:ai` | 打包产物内加载原生 ONNX Runtime 并跑真实推理 | 通过 |

已在 GitHub Actions 上真跑（[#42726427708](https://github.com/Dorufoc/socut/actions/runs/42726427708)）：windows-latest + Node 24，**2 分 52 秒全绿**，139 文件 / 1747 passed + 4 skipped（比本机多 3 个 skip 是 whisper 真资产用例，CI 不拉 141MB 模型）。

`check:env` 会用脚本固化几条项目纪律（禁同步 spawn、`node:net` 只允许出现在主进程、禁 `toDataURL`、离线交付），违反即失败。

## 目录结构

```
src/main/        主进程：窗口、协议、FFmpeg 管道、导出任务、项目锁、CLI/MCP 桥
src/preload/     受限的 window.socut API（唯一 IPC 出口）
src/renderer/    React 界面：时间轴、检查器、Canvas2D 渲染器、遮罩绘制
src/shared/      项目 schema、类型、i18n、FFmpeg 参数构造、CLI 协议（跨进程唯一真值）
cli/             socut-cli.mjs / socut-mcp.mjs
scripts/         资源取回、打包、守卫与验收脚本
tests/           vitest（node + jsdom 两套），含 FFmpeg argv 快照与真资源用例
docs/            验收台账（verification/）、CLI/MCP/资源/预设说明
```

## 许可与第三方组件

- 本仓库代码 **UNLICENSED**（保留所有权利，未授予开源许可）。公开仅为可查看，不构成使用/分发授权。
- 第三方资源各自遵循其许可：FFmpeg（gyan.dev essentials 构建）、whisper.cpp、RNNoise、打包字体、ONNX Runtime（MIT）、MediaPipe Selfie Segmenter 模型（Apache-2.0）。资源清单与来源见 [`docs/assets.md`](docs/assets.md)。
- 功能面参考了 CapCut / Concat 等剪辑器公开的能力清单，**代码与设计文档全部自研**，未复制任何第三方实现；对比研究见 [`docs/research/concat-vs-socut.md`](docs/research/concat-vs-socut.md)。
