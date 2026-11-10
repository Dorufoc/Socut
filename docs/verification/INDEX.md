# Socut 里程碑验收总览（M5–M12）

> 本文件是 M5–M12 的**索引**：每个里程碑的详细「已落地 / 取证 / 未完成」在各自的
> `docs/verification/M*.md` 台账里。这里只回答两个问题：**这个里程碑交付了什么**、
> **最近一次全绿门禁是否覆盖它**。
>
> 执行环境：Windows 11 · Node v24 · Electron 45.2.1 · 随包 FFmpeg 9.0.2（gyan essentials）
>
> 状态口径：`通过` = 本机可复现门禁/真机取证已证；`部分` = 机器可判的一半已证，另一半需外部条件
> （GitHub Actions 真跑、代码签名、DCC/实拍人工评审）。

## 全局门禁（最近一次，2026-11-10）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 日常门禁 | `npm run verify` | **通过**：check:env（0 警告）+ eslint + typecheck(node/web/tests) + vitest **139 文件 / 1750 passed + 1 skipped** |
| CI 等价 | `npm run verify:ci` | **通过**：在 `verify` 之后追加 `electron-vite build`（main/preload/renderer 三份产物均可编译） |
| 全量验收 | `npm run verify:all` | **通过（20/20 步，2026-11-10）**：`verify:ci` 等价链路 + 两条 CLI 导出冒烟 + MCP stdio 冒烟 + 应用内 10 个场景（1080p30/10s 透明 MOV 300 帧 5.9s、4K60 120 帧 9.49s、取消 MOV/PNG 各 600 帧后产物回收、720p23.976 叠加 120 帧、导入门禁、逐像素一致性 DPR 1.5/1440×810、错误呈现、评审表、字幕视觉检查 24 例 0 失败） |

> 单独跑某个里程碑的用例时以该台账「取证」小节列出的命令为准；
> 台账里的数字是当时快照，全局数字以本表为准。

## 里程碑总表

| 里程碑 | 范围（计划） | 台账 | 状态 |
|---|---|---|---|
| M5 | 剪辑内核：多序列、无限媒体/音频轨、波纹删除、合并、冻结帧、磁性吸附 | [M5.md](./M5.md) | **通过** |
| M6 | 关键帧与贝塞尔：参数轨、7 种缓动 + 自定义 cubic-bezier（禁过冲）、可视化曲线编辑器、媒体段关键帧（预览 CSS + 导出 FFmpeg 表达式同源）、时间轴菱形 | [M6.md](./M6.md) | **通过**（余项：媒体段卡片菱形已由 M7-F 补上） |
| M7 | 文本元素 + 图形层 z 档 + 转场 58 档 + 6 个特效包 | [M7.md](./M7.md) | **通过**（明确不做 WebGL2 合成器，理由见台账） |
| M8 | 音频（降噪/人声增强/变声/响度/ducking）、手绘遮罩、外部 matte、AI 抠像（ONNX Selfie）、反向遮罩与笔刷快捷键 | [M8.md](./M8.md) | **通过**（余项：AI matte 质量档/物体档、遮罩关键帧、预览试听，见台账「未完成」） |
| M9 | 编码交付：输出尺寸/帧率/像素格式、全范围、软件编码器回退、HDR 留待规格变更 | [M9.md](./M9.md) | **通过**（HDR 明确未排期） |
| M10 | JSON-RPC 控制面、MCP server、项目锁（窗口 + agent）、取帧 `preview_frame`、事件流 | [M10.md](./M10.md) | **通过**（gRPC 明确不排期） |
| M11 | Whisper 离线字幕：真实二进制/模型、抽音进度、片段窗口映射、批量编辑 UI | [M11.md](./M11.md) | **通过**（可选增强：模型清单切换） |
| M12 | CI（verify / package-win 工作流）、资源引导、打包前置检查、MCP 冒烟进 verify:all、原生可选依赖打包与打包后烟测 | [M12.md](./M12.md) | **部分**：本机全绿；真跑 GitHub Actions、代码签名、CI 内安装冒烟需外部条件 |

## 与计划的一处明确偏差

- **WebGL2 合成器（M7）**：不做。像素纪律是「Canvas 逐帧绘制（预览 + 导出同源）+ FFmpeg 合成媒体层」，
  引入 WebGL 会多出第三个像素源；媒体段关键帧已用 FFmpeg 表达式实现，无需 GPU 合成器。
- **HDR 传递（M9）**：未排期。需要先放开导入侧 SDR 阻断并定义交付色彩空间，属规格变更。
- **gRPC（M10）**：不排期。与 `files` 白名单 / npmRebuild 冲突，收益低于 JSON-RPC。

## 快速入口

- CLI 命令清单唯一真值：`src/shared/cliProtocol.ts`（`docs/cli.md` 是说明）
- MCP 工具表：`docs/mcp.md`；MCP 冒烟：`tests/mcpTools.test.ts` / `tests/mcpServer.test.ts`
- 打包：`npm run package:win`（安装包）/ `npm run package:win -- --dir --no-open`（免安装目录）
- 打包后原生运行时烟测：`npm run smoke:packaged:ai`
- 资源取回：`npm run fetch:ffmpeg | fetch:fonts | fetch:whisper | fetch:whisper:model | fetch:rnnoise | fetch:matte:model`
