# Socut 的 MCP 接入（AI Agent 直连）

Socut 自带一个 **MCP（Model Context Protocol）stdio server**：Claude Code、Claude Desktop 或任何 MCP 客户端
可以新建工程、导入素材、加新闻字幕条、加文本元素、导出透明 MOV / 叠层 MP4，并**渲染一帧 PNG 回来"看"**。

零依赖：它只用 Node 内置模块 + 全局 `fetch`，通过 Socut 自己的本地控制服务（127.0.0.1 + token）执行命令。
每个 MCP 工具都对应 CLI 注册表（`src/shared/cliProtocol.ts`，命令清单唯一真值）里的**同一条命令**，
不存在第二套业务逻辑。

## 1. 配置

### Claude Code

```bash
# 方式 A：开发环境（需要 Node 22+）
claude mcp add socut -- node "D:/path/to/FocusNews/cli/socut-mcp.mjs"

# 方式 B：打包版（安装目录下的 cli/socut-mcp.cmd，内部用 ELECTRON_RUN_AS_NODE 跑）
claude mcp add socut -- "C:/Program Files/Socut/cli/socut-mcp.cmd"
```

### Claude Desktop / 其他客户端

```json
{
  "mcpServers": {
    "socut": {
      "command": "node",
      "args": ["D:/path/to/FocusNews/cli/socut-mcp.mjs"]
    }
  }
}
```

可选参数：

| 参数 | 作用 |
|---|---|
| `--server <file>` | 指定 `server.json`（默认自动扫描 `%APPDATA%/Socut/cli/server.json` 等位置） |
| `--no-launch` | 不自动拉起 Socut（默认：连不上时自动启动一个隐藏窗口实例） |
| `--token <token>` | 覆盖 token（调试用） |

启动后 stdout 只走 MCP 协议，日志在 stderr。

## 2. 能力（60+ 工具）

| 分组 | 工具 |
|---|---|
| 应用/诊断 | `socut_version` `socut_health` `socut_commands` `socut_gpu` |
| 工程 | `project_list` `project_create` `project_open` `project_save` `project_get` `project_apply` `project_undo` `project_redo` |
| 多序列 | `sequence_list` `sequence_add` `sequence_select` `sequence_rename` `sequence_remove` `sequence_duplicate` |
| 素材 | `media_import` `media_list` `media_probe` `media_remove` |
| 字幕条（包装） | `clip_add` `clip_update` `clip_remove` `clip_duplicate` `clip_select` `clip_split` `clip_apply_style_to_all` `clip_reset_style` `clip_set_times` `clip_keyframes` |
| 时间轴 | `timeline_media_insert` `timeline_media_move` `timeline_media_trim` `timeline_media_remove` `timeline_media_split` `timeline_ripple_delete` `timeline_merge_next` `timeline_freeze` `timeline_compact` `timeline_audio_insert` `timeline_audio_remove` |
| 音频/转场 | `audio_fx` `audio_role` `audio_ducking` `transition_set` `transition_remove` |
| 抠像/遮罩 | `clip_key` `clip_mask` `clip_matte` `ai_matte` `ai_matte_status`（外部 matte 与 AI 人像抠像都**仅导出生效**） |
| 轨道 | `track_add_media` `track_add_audio` `track_remove_media` `track_move_media` `track_rename` `track_mute` `track_hidden` `track_locked` |
| 文本元素 | `text_presets` `text_list` `text_add` `text_update` `text_remove` `text_select` |
| 字幕导入导出 | `caption_parse` `caption_import` `caption_batch` `caption_export` `caption_write` |
| Whisper 转写 | `whisper_status` `whisper_config` `caption_transcribe`（离线导入二进制/模型） |
| 水印 | `watermark_set` `watermark_enable` `watermark_remove` |
| 导出 | `export_start` `export_status` `export_wait` `export_cancel` `export_list` `export_estimate` |
| 取帧 | `preview_frame`（返回 MCP image content，Agent 可直接"看"） |
| 项目锁 | `project_lock` `project_unlock` `project_lock_status` |
| UI | `ui_set` |

## 3. 推荐工作流（新闻日更）

```text
1. project_get                          # 看当前工程/序列/轨道现状
2. media_import { path }                # 导入素材（非 16:9 / HDR / VFR 会被门禁拦下，按需确认）
3. clip_add { at: 1.0, content: { title: "今日头条", subtitle: "省发展改革委发布" } }
4. text_add { presetId: "locationTag", text: "浙江 · 杭州", at: 0.5 }
5. preview_frame { at: 1.5 }            # 返回 PNG，检查版式
6. export_start { kind: "transparentMov", outputDir: "D:/out", fileName: "daily" }
7. export_wait { jobId: "<jobId>" }     # 等到 done/failed/cancelled
```

工程锁：Agent 建议先 `project_lock { path, mode: "agent" }` 再改工程，结束时 `project_unlock { path, token }`。
窗口侧接线（GUI 打开即持锁）在 M10 台账里标注为下一批。

## 4. 安全边界

- MCP server 只连 **本机 127.0.0.1** 的 Socut 控制服务，token 从 `server.json` 读取；
- 不会向外网发送任何东西（与产品"离线交付"纪律一致）；
- 写文件类操作仍走 Socut 自己的命令（导出目录、体积提示、磁盘门禁不绕过）。

## 5. 排障

| 现象 | 处理 |
|---|---|
| `CLI_CONNECT_FAILED` | 应用没启动且找不到可执行文件：设置 `SOCUT_EXE` 指向 `Socut.exe`，或先手动启动应用 |
| `CLI_LAUNCH_FAILED` | 自动拉起失败：看 `%APPDATA%/Socut/logs/` 下的日志 |
| tools/call 返回 isError | 内容里有 `{ ok:false, code, message }`；`BAD_PARAMS` / `GATE_BLOCKED` 最常见 |
| preview_frame 很慢 | 4K 工程单帧渲染接近导出单帧耗时；用 `at` 指定时刻即可，不必连续抽帧 |
