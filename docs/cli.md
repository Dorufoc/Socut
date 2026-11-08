# FocusNews CLI

面向 AI Agent 的本机控制面。它不依赖 Computer Use 或屏幕坐标，所有操作都走
FocusNews 内部的 zustand action、导出 runner 与主进程文件/ffprobe 能力。

```
外部 Agent / 脚本
      │  HTTP + token（127.0.0.1 随机端口）
      ▼
FocusNews 主进程 CliControlServer
      ├── app / project 文件 / media.probe / export.status 等直接处理
      └── 其余命令 ── IPC ──▶ 渲染进程 CLI 路由 ──▶ zustand / 导出 runner
```

## 1. 运行方式

### 开发环境

```bash
npm run cli -- app health --pretty
# 等价于
node cli/focusnews-cli.mjs app health --pretty
```

### 打包版

安装目录下会包含：

```
FocusNews.exe
focusnews.cmd          ← 根目录快捷入口
cli/
  focusnews-cli.mjs
  focusnews.cmd        ← 在 cli 目录内运行
```

```bat
focusnews.cmd app health --pretty
cli\focusnews.cmd app commands --pretty
```

`focusnews.cmd` 用 `ELECTRON_RUN_AS_NODE=1` 让 `FocusNews.exe` 以 Node 模式运行
CLI 脚本，因此不需要额外安装 Node。

### 自动拉起

CLI 连接不上控制服务时会自动启动一个隐藏窗口的 FocusNews（`--cli-server`）：

1. `FOCUSNEWS_EXE` 指定的可执行文件；
2. 打包版同级 `FocusNews.exe`；
3. 开发环境 `node_modules/electron/dist/electron.exe`；
4. 打包版 `.cmd` 自身的 `process.execPath`。

关闭自动拉起：

```bash
focusnews-cli app health --no-launch
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
  "userDataPath": "C:\\Users\\...\\AppData\\Roaming\\FocusNews"
}
```

客户端会自动扫描以下位置：

- `FOCUSNEWS_CLI_SERVER_FILE`
- `FOCUSNEWS_USER_DATA/cli/server.json`
- `%APPDATA%/FocusNews/cli/server.json`
- `%APPDATA%/focusnews/cli/server.json`
- `%APPDATA%/Electron/cli/server.json`（开发兜底）
- macOS / Linux 对应的 `Application Support`、`XDG_CONFIG_HOME` 路径

也可以显式指定：

```bash
focusnews-cli app health --server D:\tmp\server.json
```

所有请求都必须带：

```
Authorization: Bearer <token>
```

或：

```
x-focusnews-token: <token>
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
focusnews-cli clip update \
  --id clip-1 \
  --patch '{"content":{"main":"标题","secondary":"副标题"}}'
```

`--params` 与命令行 flag 同时存在时，flag 覆盖同名参数。

## 5. 命令

完整清单：

```bash
focusnews-cli app commands --pretty
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
focusnews-cli project apply --params "{\"project\": $(cat project.json)}"
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
focusnews-cli media import \
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
- 媒体段效果：`clip.video | clip.video.reset | clip.stab | clip.audio | clip.speed | clip.transition`
- 音频效果：`audio.fx | audio.speed | audio.role | audio.ducking | audio.reset`
- 轨道：`track.addMedia | addAudio | removeMedia | removeAudio | moveMedia | moveAudio | rename | mute | hidden | locked | select`
- 时间轴：`timeline.compact`

示例：

```bash
focusnews-cli timeline media insert --media-id m1 --at 0
focusnews-cli clip add --at 2.5 --duration 4
focusnews-cli clip update --id clip-1 --params '{"content":{"main":"今日头条"}}'
focusnews-cli audio role --id a1 --role bgm
```

### watermark / ui

```bash
focusnews-cli watermark set --path D:\logo.png --enabled
focusnews-cli watermark enable --enabled false
focusnews-cli watermark remove
focusnews-cli ui set --view editor --left-tab media
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
focusnews-cli export run \
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

CLI 的 `export.run` 已自动确认体积提示；磁盘不足仍会直接失败。VFR raw 的二次确认自动通过。
`export.run` 返回最终任务结果（含 `ok`、输出路径等），不是任务快照；要观察进度请用
`--progress` 或轮询 `export.status`。

查询任务：

```bash
focusnews-cli jobs --pretty
focusnews-cli job --job-id <id> --pretty
```

### 长任务

`export.cover`、`export.start` 等渲染侧命令默认等待 30 分钟。可用 `--timeout` 调整：

```bash
focusnews-cli export cover --output-dir D:\out --timeout 600000
```

## 6. Agent 推荐流程

```bash
# 1. 确认应用和服务
focusnews-cli app health --pretty

# 2. 新建或打开工程
focusnews-cli project new --name "每日新闻" --path D:\work\daily.focusnews

# 3. 导入素材
focusnews-cli media import --path D:\media\a.mp4 --ack-non169

# 4. 组装时间轴
focusnews-cli timeline media insert --media-id <mediaId> --at 0
focusnews-cli clip add --at 1 --duration 5

# 5. 保存
focusnews-cli project save

# 6. 导出并等待结果
focusnews-cli export run --kind overlayMp4 --output-dir D:\out --file-name daily
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
| `FOCUSNEWS_EXE` | 自动拉起时使用的 `FocusNews.exe` |
| `FOCUSNEWS_ELECTRON` | 开发环境 Electron 可执行文件 |
| `FOCUSNEWS_CLI_SERVER_FILE` | 指定 `server.json` |
| `FOCUSNEWS_USER_DATA` | 开发环境隔离 userData |
| `FOCUSNEWS_SERVER_FILE` | 兼容别名（客户端会读取） |

## 8. 限制与排错

- 单进程导出并发固定为 1，CLI 连续 `export.run` 会排队。
- 请求体上限 64 MB；`project.apply` 传超大工程时注意。
- 渲染侧命令硬超时 30 分钟；导出任务本身通过 `export.status` 轮询，不受该超时限制。
- 找不到控制服务时：
  1. 确认 FocusNews 已启动；
  2. 检查 `%APPDATA%/FocusNews/cli/server.json` 是否存在；
  3. 用 `--server` 指定实际文件；
  4. 设置 `FOCUSNEWS_EXE` 后重试；
  5. 用 `--no-launch` 排除自动拉起干扰。
- token 每次启动都会变化；不要缓存旧 `server.json` 的 token。
- `--cli-server` 隐藏窗口仍会渲染，用于逐帧导出；导出期间不要手动关闭应用。
