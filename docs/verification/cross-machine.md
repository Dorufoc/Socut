# 跨机测试清单（计划 M4-5）

> 每条验收标准的当前证据与状态见 [`acceptance.md`](./acceptance.md)；本清单只列**必须在实机/人工下才能关掉**的项。

交付物是「Windows 10/11 x64 离线安装包，用户零外部依赖」，所以这份清单只在**真实的其他机器上**
才能全部划勾。下表把每一项写成可判定的一句话结论，执行人在「结果」列填 `通过 / 不通过 + 现象`，
并把 `userData/logs/app.log`（`%APPDATA%\focusnews\logs\app.log`）随记录一起归档。

安装包：`release/FocusNews-0.1.0-Setup-win-x64.exe`（体积与 SHA256 见 `docs/assets.md`，发布前重算）。

## 1. 机器矩阵

| # | 机器 / 场景 | 必须验证的点 | 结果 |
|---|---|---|---|
| C1 | 干净 Win11 x64，**未装** VC++ 运行库、未装 Node/Python/FFmpeg | 双击安装→启动无红字；状态栏显示「随包：…\resources\ffmpeg」；导出 1080p30/5s 透明 MOV 成功 | |
| C2 | 干净 Win10 1809/1909（LTSC 更严） | Electron 45 最低支持 Win10；安装/启动/导出成功；若失败必须给出明确提示而非闪退 | |
| C3 | 125% 显示缩放（笔记本 1080p 常见） | 预览不被裁切；导出像素与 C1 同帧**逐像素一致**（跑 `FOCUSNEWS_PIXELCHECK`） | |
| C4 | 150% 显示缩放 | 同 C3。开发机实测 `devicePixelRatio=1.5` 已通过（见下「本机已证」） | |
| C5 | 核显（Intel UHD/Iris，无独显） | 导出吞吐仍满足 1080p30/10s ≤ 30s；预览不掉帧到不可用 | |
| C6 | 独显（NVIDIA/AMD）+ 外接 4K 显示器 | 4K60/2s 冒烟成功；预览窗口在 4K 面板上不出现黑边或错位 | |
| C11 | 实拍素材（非合成）作为参考视频 | 叠加导出逐帧 PSNR 能区分字幕帧（分离度 ≥6dB）；字幕边缘无发灰/暗边 | |
| C7 | 域内/无管理员权限的标准用户 | `perMachine:false` → 装到 `%LOCALAPPDATA%`，不弹 UAC、不写 HKLM | |
| C8 | 真正断网（拔网线/关 Wi-Fi） | 冷启动、导入参考视频、三种出口全部可用；无任何等待/超时/报错来自联网 | |
| C9 | 中文用户名 + 含空格/`&`/emoji 的路径 | 工程保存、字体导入、导出路径均不出错（子进程 argv 传递） | |
| C10 | 非系统盘（D:/E:）安装与输出 | 磁盘预检按目标卷统计可用空间，不误判 | |
| C12 | 目标盘接近写满（小分区 / U 盘 / 先填满到不足预估×1.5） | 导出应在**写盘前**被拒并提示 `DISK_INSUFFICIENT`（带预估与可用空间两个具体数字），而不是跑到一半报 FFmpeg 错误；选 PNG 序列出口时**不应**被 ProRes 口径误拒 | |

## 2. 每台机器的固定动作（顺序执行，留档）

```
1) 安装：FocusNews-0.1.0-Setup-win-x64.exe（记录是否出现 SmartScreen、点「更多信息→仍要运行」可继续）
2) 冷启动：确认窗口标题「FocusNews 新闻字幕条」，状态栏 FFmpeg 路径在安装目录内
3) 冒烟场景（开发机/交付验证机各跑一次；打包版会忽略这些环境变量）：
   FOCUSNEWS_SMOKE=1 FOCUSNEWS_SMOKE_W=1920 FOCUSNEWS_SMOKE_H=1080 FOCUSNEWS_SMOKE_SEC=10  → 退出码 0（验收 2/3）
   FOCUSNEWS_SMOKE=1 FOCUSNEWS_SMOKE_CANCEL=1 FOCUSNEWS_SMOKE_SEC=20                        → 退出码 0（验收 8）
   FOCUSNEWS_SMOKE=1 FOCUSNEWS_SMOKE_OVERLAY=1 FOCUSNEWS_SMOKE_REF=<720p 23.976 参考视频>   → 退出码 0（验收 4）
   FOCUSNEWS_SMOKE=1 FOCUSNEWS_SMOKE_OVERLAY=1 FOCUSNEWS_SMOKE_REF=<本机实拍 1080p 素材>     → 退出码 0（现场素材口径）
   FOCUSNEWS_SMOKE=1 FOCUSNEWS_SMOKE_GATE=1                                                     → 退出码 0（验收 5/6：非16:9/HDR/VFR 模态与阻断；需先跑 npm run make:fixtures）
   FOCUSNEWS_SMOKE=1 FOCUSNEWS_SMOKE_W=3840 FOCUSNEWS_SMOKE_H=2160 FOCUSNEWS_SMOKE_FPS=60 FOCUSNEWS_SMOKE_SEC=2 → 退出码 0（M4-6 4K60）
   FOCUSNEWS_PIXELCHECK=<png路径> → 退出码 0（M1-7 逐像素；在 125%/150% 缩放机上必跑，报告里会带 blitSize）
   注：overlay 场景会额外用逐帧 PSNR 从产物像素量出字幕区间（span-<jobId>.txt），
   实拍素材上若分离度不足 6dB 会直接报「无法区分」而不是给一个看似通过的结论。
4) 卸载：控制面板或 Uninstall FocusNews.exe → 安装目录消失；%APPDATA%\focusnews 保留（工程与导入字体）
5) 归档：spikes/app-smoke/report.json、spikes/app-smoke/pixel-parity.json、%APPDATA%\focusnews\logs\app.log
```

## 3. 人工评审项（工具无法替你判断）

| 项 | 判据 | 结果 |
|---|---|---|
| Resolve / Premiere 透明终评 | 把 1080p30 透明 MOV 叠到实拍素材上：边缘无暗边/绿边、无半透明发灰、alpha 通道在示波器上非全 255 | |
| 逐帧动画观感 | 用 `FOCUSNEWS_REVIEW_SHEET` 产出的 8 预设 × 7 关键帧表逐格看：叠压关系清楚、装饰线不廉价、揭字无「网页感」、无回弹/缩放/旋转 | |
| 真实素材观感 | 用交付方提供的实拍 1080p 素材重跑评审表背景（`FOCUSNEWS_REVIEW_BACKDROP`） | |
| 参考视频兼容性 | 手机 VFR 素材触发模态三选项；非 16:9 / HDR 素材模态阻断且未确认时三个导出按钮禁用（自动化部由 `FOCUSNEWS_SMOKE_GATE=1` 取证；本条只验本机实拍素材上的观感与模态文案） | |

## 4. 本机（开发机）已证的条目

- **C4 的 150% 缩放**：`devicePixelRatio = 1.5`，像素一致性回归通过——导出帧字节与预览原生层**逐字节相同**，
  PNG 往返 0 差异，blit(1440×810) 与导出图同尺寸缩放最大通道差 1（`spikes/app-smoke/pixel-parity.json`）。
- **C8 的断网等价**：打包版以 `--proxy-server=127.0.0.1:9` 冷启动成功；`check-env` 静态禁网 + 生产 CSP
  `connect-src 'self'` 双保险。真正拔线仍需 C8 实机。
- **C1 的「无外部依赖」**：安装包内 FFmpeg/字体均在 asar 外随包（`resources/ffmpeg`、`resources/fonts`），
  打包版日志显示 `FFmpeg bundled (<安装目录>\resources\ffmpeg\ffmpeg.exe)`；未使用系统 PATH。
- 其余项（C2/C3/C5/C6/C7/C9/C10）与第 3 节人工评审**必须在别的机器或人工判断下完成**，不能由本机代证。
