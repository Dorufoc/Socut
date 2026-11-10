# Socut CLI

面向 AI Agent 的本机控制面。它不依赖 Computer Use 或屏幕坐标，所有操作都走
Socut 内部的 zustand action、导出 runner 与主进程文件/ffprobe 能力。

```
外部 Agent / 脚本
      │  HTTP + token（127.0.0.1 随机端口）
      ▼
Socut 主进程 CliControlServer
      ├── app / project 文件 / media.probe / export.status 等直接处理
      └── 其余命令 ── IPC ──▶ 渲染进程 CLI 路由 ──▶ zustand / 导出 runner
```

## 1. 运行方式

### 开发环境

```bash
npm run cli -- app health --pretty
# 等价于
node cli/socut-cli.mjs app health --pretty
```

### 打包版

安装目录下会包含：

```
Socut.exe
socut.cmd          ← 根目录快捷入口
cli/
  socut-cli.mjs
  socut.cmd        ← 在 cli 目录内运行
```

```bat
socut.cmd app health --pretty
cli\socut.cmd app commands --pretty
```

`socut.cmd` 用 `ELECTRON_RUN_AS_NODE=1` 让 `Socut.exe` 以 Node 模式运行
CLI 脚本，因此不需要额外安装 Node。

### 自动拉起

CLI 连接不上控制服务时会自动启动一个隐藏窗口的 Socut（`--cli-server`）：

1. `SOCUT_EXE` 指定的可执行文件；
2. 打包版同级 `Socut.exe`；
3. 开发环境 `node_modules/electron/dist/electron.exe`；
4. 打包版 `.cmd` 自身的 `process.execPath`。

关闭自动拉起：

```bash
socut-cli app health --no-launch
```

已有正常窗口运行时，CLI 会直接控制该实例，不会另开进程。若已有实例是
`--cli-server` 隐藏实例，用户手动再次启动会把窗口显示出来。

## 2. 发现与安全

服务只绑定 `127.0.0.1`，每次启动生成随机 token，并写入：

```
<userData>/cli/server.json
```

内容：

```json
{
  "protocolVersion": 1,
  "port": 43127,
  "token": "……64 位十六进制……",
  "pid": 12345,
  "appVersion": "0.1.0",
  "startedAt": "2026-11-08T...",
  "userDataPath": "C:\\Users\\...\\AppData\\Roaming\\Socut",
  "rpc": { "tcpPort": 43128, "pipePath": "\\\\.\\pipe\\socut-12345" }
}
```

`rpc`（M10）是 JSON-RPC 行协议入口：TCP 回环 + Windows 命名管道，二选一即可。
同一个 token 通用；命令名与 HTTP CLI 完全一致（`project.get` / `clip.add` / `export.start` …）。

```jsonc
// 首行必须是 auth；之后一行一个请求，响应带同一个 id
{"jsonrpc":"2.0","id":0,"method":"auth","params":{"token":"<token>"}}
{"jsonrpc":"2.0","id":1,"method":"version"}
{"jsonrpc":"2.0","id":2,"method":"project.get","params":{}}
{"jsonrpc":"2.0","id":3,"method":"preview.frame","params":{"at":1.5}}
```

- `version` 返回 `capabilities`；`commands.list` 返回完整命令表；
- 业务错误是 JSON-RPC 错误对象，`data.code` 保留本协议的稳定错误码（`BAD_PARAMS` / `NOT_FOUND` / `GATE_BLOCKED`…）；
- 单连接按到达顺序串行执行，响应顺序可预测。

### 项目锁（M10）

```bash
socut-cli project lock --path D:\work\daily.socut --mode agent   # 返回 token
socut-cli project lock-status --path D:\work\daily.socut
socut-cli project unlock --path D:\work\daily.socut --token <token>
```

锁文件是 `<工程路径>.lock`；心跳 5s、超过 15s 或持有进程已退出即可被接管（崩溃不锁死）。
窗口侧接线（GUI 打开即持锁）在下一批。

### 取帧（M10）

```bash
socut-cli preview frame --at 1.5 --pretty   # 返回 { pngBase64, width, height, frame, atSec, bytes }
```

走生产渲染管线（字幕条 + 文本元素 + 关键帧），不落盘、不占导出队列。

### MCP（AI Agent 直连）

Socut 自带 MCP stdio server：`node cli/socut-mcp.mjs`（打包版 `cli\socut-mcp.cmd`）。
60+ 工具覆盖工程/序列/素材/字幕条/关键帧/时间轴/文本元素/导出/取帧/项目锁；
配置与推荐工作流见 [mcp.md](./mcp.md)。

客户端会自动扫描以下位置：

- `SOCUT_CLI_SERVER_FILE`
- `SOCUT_USER_DATA/cli/server.json`
- `%APPDATA%/Socut/cli/server.json`
- `%APPDATA%/socut/cli/server.json`
- `%APPDATA%/Electron/cli/server.json`（开发兜底）
- macOS / Linux 对应的 `Application Support`、`XDG_CONFIG_HOME` 路径

也可以显式指定：

```bash
socut-cli app health --server D:\tmp\server.json
```

所有请求都必须带：

```
Authorization: Bearer <token>
```

或：

```
x-socut-token: <token>
```

服务不提供 CORS，不接受远程连接。`POST /v1/shutdown` 与 `app.shutdown` 会退出应用。

## 3. 输出格式

成功：

```json
{ "ok": true, "result": { } }
```

失败：

```json
{
  "ok": false,
  "error": {
    "code": "BAD_PARAMS",
    "message": "缺少参数：path",
    "detail": "可选"
  }
}
```

- 业务错误仍返回 HTTP 200，`ok:false`；只有鉴权/传输/路由错误返回非 200。
- 成功退出码为 `0`，失败为 `1`。
- `--pretty` 输出缩进 JSON。
- 默认输出紧凑 JSON，适合程序解析。
- stdout 始终是 UTF-8。Windows PowerShell 7 直接 `ConvertFrom-Json` 时，若中文乱码，
  先在当前会话执行 `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`。

## 4. 参数

命令行 flag 自动从 kebab-case 转成 camelCase：

```bash
--output-dir D:\out       →  { "outputDir": "D:\\out" }
--ack-non169              →  { "ackNon169": true }
--no-hdr                  →  { "hdr": false }
--at 12.5                 →  { "at": 12.5 }
--tags '["a","b"]'        →  { "tags": ["a", "b"] }
```

复杂对象用 `--params`：

```bash
socut-cli clip update \
  --id clip-1 \
  --patch '{"content":{"main":"标题","secondary":"副标题"}}'
```

`--params` 与命令行 flag 同时存在时，flag 覆盖同名参数。

## 5. 命令

完整清单：

```bash
socut-cli app commands --pretty
```

### app

| 命令 | 说明 |
|---|---|
| `app.info` | 版本、路径、FFmpeg、CLI 服务信息 |
| `app.health` | 健康检查 |
| `app.commands` | 全部命令 |
| `app.gpu` | 显卡与编码器体检 |
| `app.shutdown` | 退出应用（先落盘自动存档） |

### project

| 命令 | 说明 |
|---|---|
| `project.new` | 新建工程并加载，可选 `--path`、`--name` |
| `project.open` | 按路径打开工程 |
| `project.openRecent` | 按最近工程 id 打开 |
| `project.recent` | 列出最近工程 |
| `project.get` | 读取当前工程与选择状态 |
| `project.save` | 保存到指定路径；缺省用当前路径 |
| `project.apply` | 用完整 Project JSON 覆盖当前工程（通用逃生口） |
| `project.rename` / `resolution` / `fps` / `audioMastering` | 基础属性 |
| `project.undo` / `project.redo` | 撤销/重做 |

`project.apply` 接收完整工程 JSON，适合一次性完成离散命令覆盖不到的复杂编辑：

```bash
socut-cli project apply --params "{\"project\": $(cat project.json)}"
```

### media

| 命令 | 说明 |
|---|---|
| `media.import` | 导入素材，含门禁确认 |
| `media.list` | 素材池、分组、轨道、媒体段 |
| `media.remove` | 移出素材池 |
| `media.probe` / `exists` | 主进程 ffprobe / 文件存在性 |
| `media.relocate` | 换源不换轨 |
| `media.rename` / `tags` / `compactMode` / `vfrPolicy` | 素材属性 |
| `media.ackNon169` / `ackHdr` | 确认/撤销门禁提示 |
| `media.bin.*` | 素材分组增删改、归组 |

CLI 导入默认拒绝非 16:9、HDR、VFR。必须显式确认：

```bash
socut-cli media import \
  --path D:\media\a.mp4 \
  --ack-non169 \
  --ack-hdr \
  --vfr convert
```

成功返回 `{ cancelled:false, mediaId, path, cfrPath, vfrPolicy, sourcePath }`；
`mediaId` 用于后续 `timeline.media.insert`。

`--vfr` 可选：

- `reject`（默认）：VFR 直接拒绝；
- `raw`：按原样使用；
- `convert`：先转 CFR；
- `none`：明确声明 VFR 不是问题。

### timeline / clip / audio

- 媒体段：`timeline.media.insert | move | trim | remove | split | select | removeSelected | removeAt`
- 音频段：`timeline.audio.insert | move | trim | remove | split | select`
- 字幕条：`clip.add | update | remove | duplicate | select | split | applyStyleToAll | resetStyle | setTimes`
- 关键帧（M6/M6-E）：`clip.keyframes | clip.keyframes.reset`
  （`keyframes` 传 `[{ param, points:[{t,value,easing,bezier?}] }]`，t 为片段内 0–1 进度；
  `id` 可指向字幕条**或媒体段**，返回里 `kind: 'subtitle' | 'media'` 区分；
  媒体段支持 `opacity | offsetXPct | offsetYPct | scalePct | rotationDeg`，轨道值**绝对覆盖**静态 video 字段）
- 文本元素（M7）：`text.presets | text.list | text.add | text.update | text.remove | text.select`（与包装字幕条是两套体系）
- 媒体段效果：`clip.video | clip.video.reset | clip.stab | clip.audio | clip.speed | clip.transition | clip.key | clip.mask | clip.matte`
  （`clip.mask` 传 `{ strokes: [{ mode: 'hide'|'restore', radiusPct, points: [{x,y}] }], featherPct?: 0..20, invert?: boolean }`，
  坐标是画面归一化 0..1、`featherPct` 是画面宽度百分比的柔边半径、`invert` 为反向遮罩（黑白互换）；`null` 清除遮罩）
  （`clip.matte` 传 `{ id, path: string | null, kind?: 'image' | 'video' }`：`path` 必须是 **matte 文件的绝对路径**
  且文件存在；`path: null`（或省略/空串）清除。`kind` 缺省按扩展名判断（`.png/.jpg/.jpeg/.webp/.bmp` 等 = image，
  `mp4/mov/mkv/webm/avi…` = video，判断不出会要求显式 `kind`）。外部 matte **仅导出生效**、预览仍显示原片；
  视频 matte 暂不支持变速片段、转场切点与图像片段（会返回可读错误）；返回
  `{ id, mattePath, matteKind }`）
- AI 抠像（M8-P1）：`ai.matte | ai.matte.status`
  （`ai.matte { id }` 用本机 `onnxruntime-node` + Selfie Segmenter 逐帧推理生成 matte 视频并挂到该媒体段，
  **仅导出生效**、预览仍显示原片。命令等到生成结束再返回 `{ id, jobId, mattePath, cached }`；
  生成中途可 `socut-cli export cancel --job-id matte-<id>`；同源同区间二次调用命中缓存、不再推理；
  暂不支持变速片段（`BAD_PARAMS`）。`ai.matte.status` 返回
  `{ runtime: { ok, reason? }, model: { ok, path, sizeBytes?, sha256?, reason? }, ready }`，
  运行时/模型缺失时 `ready:false` 并给出可执行修复提示）
- 音频效果：`audio.fx | audio.speed | audio.role | audio.ducking | audio.reset`
- 轨道：`track.addMedia | addAudio | removeMedia | removeAudio | moveMedia | moveAudio | rename | mute | hidden | locked | select`
- 时间轴：`timeline.compact | timeline.media.rippleDelete | timeline.media.mergeNext | timeline.media.freeze`
- 多序列（v4）：`sequence.list | add | select | rename | remove | duplicate`

示例：

```bash
socut-cli timeline media insert --media-id m1 --at 0
socut-cli clip add --at 2.5 --duration 4
socut-cli clip update --id clip-1 --params '{"content":{"main":"今日头条"}}'
socut-cli audio role --id a1 --role bgm
# v4 多序列：新建第二段并切过去（活动序列的拍平字段即当前编辑内容）
socut-cli sequence add --name 第二段
socut-cli sequence select --id <上一步返回的 id>
socut-cli sequence list --pretty
```

### watermark / ui

```bash
socut-cli watermark set --path D:\logo.png --enabled
socut-cli watermark enable --enabled false
socut-cli watermark remove
socut-cli ui set --view editor --left-tab media
```

### export

| 命令 | 说明 |
|---|---|
| `export.start` | 发起任务，立即返回 `jobId` |
| `export.run` | 发起并等待完成（CLI 封装） |
| `export.wait` | 等待已有任务 |
| `export.status` / `export.jobs` | 查询主进程任务快照 |
| `export.cancel` | 取消任务 |
| `export.estimate` | 预估体积/磁盘 |
| `export.cover` | 导出当前帧封面 PNG |

```bash
socut-cli export run \
  --kind overlayMp4 \
  --output-dir D:\out \
  --file-name demo \
  --quality high \
  --progress
```

`kind`：

- `overlayMp4`：透明叠层 + 参考视频合成 MP4；
- `transparentMov`：透明 MOV（ProRes 4444 / Qtrle）；
- `pngSequence`：PNG 序列。

M9 编码参数（仅叠加出口生效；缺省 = 旧行为）：

```bash
# AV1 + CRF 直给 + 10bit + 全范围
socut-cli export run --kind overlayMp4 --output-dir D:\out --file-name demo \
  --video-codec av1 --crf 32 --bit-depth 10 --color-range full --progress
```

- `--video-codec avc|hevc|av1`（AV1 软件走 libaom-av1，硬件视显卡支持）
- `--crf 0..51`（缺省按 `--quality` 档：high 18 / standard 23 / small 28）
- `--encoder-preset`（x264/x265 preset 名；AV1 映射到 `-cpu-used`）
- `--bit-depth 8|10`（10 仅 HEVC/AV1）
- `--color-range limited|full`（full 输出 `-color_range pc` 标签）

CLI 的 `export.run` 已自动确认体积提示；磁盘不足仍会直接失败。VFR raw 的二次确认自动通过。
`export.run` 返回最终任务结果（含 `ok`、输出路径等），不是任务快照；要观察进度请用
`--progress` 或轮询 `export.status`。

查询任务：

```bash
socut-cli jobs --pretty
socut-cli job --job-id <id> --pretty
```

### 长任务

`export.cover`、`export.start` 等渲染侧命令默认等待 30 分钟。可用 `--timeout` 调整：

```bash
socut-cli export cover --output-dir D:\out --timeout 600000
```

## 6. Agent 推荐流程

```bash
# 1. 确认应用和服务
socut-cli app health --pretty

# 2. 新建或打开工程
socut-cli project new --name "每日新闻" --path D:\work\daily.socut

# 3. 导入素材
socut-cli media import --path D:\media\a.mp4 --ack-non169

# 4. 组装时间轴
socut-cli timeline media insert --media-id <mediaId> --at 0
socut-cli clip add --at 1 --duration 5

# 5. 保存
socut-cli project save

# 6. 导出并等待结果
socut-cli export run --kind overlayMp4 --output-dir D:\out --file-name daily
```

Agent 应始终检查 JSON 的 `ok` 字段，并在失败时读取 `error.code`：

- `BAD_PARAMS`：参数缺失或类型错误；
- `NOT_FOUND`：工程/素材/片段/任务不存在；
- `GATE_BLOCKED`：素材门禁未确认；
- `MEDIA_PROBE_FAILED`：ffprobe 无法读取；
- `RENDERER_UNAVAILABLE`：窗口尚未加载或已关闭；
- `TIMEOUT`：命令执行超时；
- `EXPORT_FAILED`：导出失败，`detail` 可能含 FFmpeg stderr 尾部。

## 7. 环境变量

| 变量 | 用途 |
|---|---|
| `SOCUT_EXE` | 自动拉起时使用的 `Socut.exe` |
| `SOCUT_ELECTRON` | 开发环境 Electron 可执行文件 |
| `SOCUT_CLI_SERVER_FILE` | 指定 `server.json` |
| `SOCUT_USER_DATA` | 开发环境隔离 userData |
| `SOCUT_SERVER_FILE` | 兼容别名（客户端会读取） |

## 8. 限制与排错

- 单进程导出并发固定为 1，CLI 连续 `export.run` 会排队。
- 请求体上限 64 MB；`project.apply` 传超大工程时注意。
- 渲染侧命令硬超时 30 分钟；导出任务本身通过 `export.status` 轮询，不受该超时限制。
- 找不到控制服务时：
  1. 确认 Socut 已启动；
  2. 检查 `%APPDATA%/Socut/cli/server.json` 是否存在；
  3. 用 `--server` 指定实际文件；
  4. 设置 `SOCUT_EXE` 后重试；
  5. 用 `--no-launch` 排除自动拉起干扰。
- token 每次启动都会变化；不要缓存旧 `server.json` 的 token。
- `--cli-server` 隐藏窗口仍会渲染，用于逐帧导出；导出期间不要手动关闭应用。
