# 随包资产与许可证

本文件是交付合规与可复现构建的唯一记录点（计划 M4-3）。所有二进制/字体都由脚本按固定来源获取，
仓库不入库（见 `.gitignore`），因此这里的 URL、版本与校验和就是重建依据。

## 本项目许可证：AGPL-3.0-or-later（2026-11-10 决定）

> 由 `UNLICENSED`（保留所有权利）改为 **GNU Affero General Public License v3.0 or later**。
> 仓库根 `LICENSE` 是 AGPL-3.0 全文（取自 <https://www.gnu.org/licenses/agpl-3.0.txt>，
> 34,523 B / 661 行）；`package.json` 与 `package-lock.json` 的 `license` 为 SPDX
> `AGPL-3.0-or-later`；`electron-builder.yml` 的 `extraFiles` 把 `LICENSE` 放进安装目录根。
> 这三处由 `scripts/check-env.mjs` 的 `checkLicense()` 互相校验，防「改了 README 忘 LICENSE」。

分发（安装包或源码）时的义务与落地物：

| 义务 | 条款 | 落地物 / 现状 |
|---|---|---|
| 随目标代码提供许可全文 | §4、§6 | 安装目录根 `LICENSE`（`extraFiles`，打包后与 `Socut.exe` 同级） |
| 提供完整对应源码 | §6 | 公开仓库 <https://github.com/Dorufoc/socut>；Release 页自带的 "Source code (zip/tar.gz)" 与安装包同一地点（§6(d)） |
| 保留版权声明、标注修改 | §5(a)(b) | 仓库保留 Git 历史与 `copyright`；改版者须自行加「已修改 + 日期」声明 |
| 网络交互时提供源码入口 | §13 | 当前**不触发**：纯本地应用，CLI/MCP 走本机 stdio 与环回地址，不存在「远程网络用户」 |
| 不得附加进一步限制 | §10 | 无使用量/时间/地域限制；作者本人的商业授权属于另行授予，不限制接收者的 AGPL 权利 |

与其他许可的关系：

- **FFmpeg（GPL-3.0-or-later 构建）**：AGPL §13 末段显式允许与 GPLv3 作品链接并分组合分发，
  两者兼容；何况本项目与 FFmpeg 只是「独立进程 + 命令行调用」。合规压力仍来自 FFmpeg 一侧
  （GPL 源码要约，见下一节），与自身协议无关。
- **第三方资产（MIT / BSD / Apache-2.0 / OFL）**：都能与 AGPL 组合，各自义务不变。
  其中 whisper.cpp、RNNoise 模型、matte 模型、ONNX Runtime 的许可文本**尚未随安装包交付**，
  是当前唯一的已知合规缺口（M12 台账「未完成」已记，待补 `THIRD_PARTY_NOTICES`）。
- **`package.json` 的 `private: true`** 保持不动：只用于阻止 `npm publish` 误发布，与许可无关。

## FFmpeg（随包，位于 asar 之外）

| 项 | 值 |
|---|---|
| 获取脚本 | `scripts/fetch-ffmpeg.mjs`（`npm run fetch:ffmpeg`） |
| 默认来源 | `https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip`（**精简同源构建**，含 libx264） |
| 取用文件 | 包内 `bin/ffmpeg.exe`、`bin/ffprobe.exe`（**同一构建，版本严格一致**） |
| 落地位置 | `resources/ffmpeg/`（`extraResources` → 安装后位于 `<安装目录>/resources/ffmpeg`） |
| 校验 | 下载后计算 SHA256 并写入 `resources/ffmpeg/manifest.json`；提供 `FFMPEG_SHA256` 时强校验 |
| 覆盖手段 | `FFMPEG_URL`（zip 或 exe 直链）、`FFMPEG_SHA256`（强校验）、`FFMPEG_LOCAL_DIR`（离线复制）、`--from-path`（仅开发）、`GH_PROXY` |
| 当前实装 | FFmpeg **9.0.2-essentials_build**（`--enable-gpl --enable-version3 --enable-libx264`），ffmpeg.exe 100.5MB + ffprobe.exe 100.3MB；zip SHA256 `60f46726…2047ba` |
| 缓存 | `.cache/ffmpeg/<zip 名>`（已 gitignore）；重跑时校 SHA256 后复用，失败/中断的 `extract-*` 解包目录下次开跑自动清扫 |

构建选型实测（单个 ffmpeg.exe）：gyan essentials **100.5MB** ← 采用；BtbN master 162MB；gyan full 217MB（会顶破体积预算）。
manifest.json 里的 `note` / `versionLine` / `license` 由脚本根据**实际下载源**与 `-version` 输出自动写入，不再写死某个构建名。

为什么不用 `ffprobe-static`：`3.1.0`（2022-06 最后发布）tarball 351MB 含全平台、
且与 `ffmpeg-static@5.3.0`（构建标签 b6.1.1）**不同源**，探测与编码行为版本错配会直接体现为
字段语义差异（计划 C6）。`ffmpeg-static` 也不提供 ffprobe。

### GPL 合规（必须随包交付）

默认构建为 **GPL**（含 libx264，MP4 叠加压制必需）。分发该构建即触发 GPL：

1. 安装包内需包含 FFmpeg 源码获取途径的书面要约（本文件即为要约的一部分，交付时随 `LICENSES/` 一同打包）；
2. 上游与源码地址：构建发布页 `https://www.gyan.dev/ffmpeg/builds/`，FFmpeg 源码 `https://ffmpeg.org/download.html`
   （当前实装 releases/9.0.2；`resources/ffmpeg/manifest.json` 保留完整 URL + SHA256 + 版本行作为要约凭据）；
3. 若不愿承担 GPL 义务，可改用 **LGPL 构建**（不含 x264/x265）；MP4 叠加出口需相应改为
   `-c:v h264_mf`（Windows Media Foundation 硬/软编，LGPL 友好），并调整 `ffmpegArgs.ts` 的编码参数集。
   这是交付策略决策点，需产品侧确认后再切换（当前默认 GPL + libx264，CRF 18 质量可控）。
4. 本应用代码自 2026-11-10 起为 **AGPL-3.0-or-later**（此前为 `UNLICENSED`），与 FFmpeg 仅为
   「独立进程 + 命令行调用」关系，不构成链接；即便按链接论，AGPL §13 也允许与 GPLv3 组合作品分发。
   仍按 GPL 处理是因为分发的是 GPL 构建的二进制本体，而不是因为本应用的协议。

### 体积预算（已实测）

`electron-builder.yml` 的 `files` 白名单只带 `out/` 与 `package.json`，`resources/` 只经 `extraResources`
进入安装包一次（否则 FFmpeg 会被复制两遍）。`scripts/check-env.mjs` 对单个二进制 >150MB 给出告警。

| 项 | 实测值 |
|---|---|
| 随包 FFmpeg（未压缩） | 200.8MB（essentials 同源构建） |
| 随包字体 | 76.3MB + 3 份许可证 |
| `release/win-unpacked` | 643.5MB / 88 个文件（含 Electron 本体；`verify:packaged` 实测安装后 88 文件 / 643.5MB） |
| **NSIS 安装包** | **227.64 MB**（`Socut-0.1.0-Setup-win-x64.exe`，238 697 492 字节） |
| 安装包 SHA256 | `EC12C25370BA1AF53F9F55EF285205A056D8EF33C0110F1D07FDF3793618166A`（本轮重建产物；改代码后需重算） |

安装/升级/卸载取证（`npm run verify:packaged`）：静默安装 → 断网冷启动 → 优雅退出 → **覆盖安装（升级）** → 再次断网冷启动 → 静默卸载。
最近一次实测：`installer-exit=0`、`upgrade-installer-exit=0`、`upgrade-ffmpeg-bundled=1`、两次冷启动均 4 进程存活、关闭后 0 残留、卸载后安装目录消失。

构建入口：`npm run dist:win`（`scripts/dist-win.mjs`，把 electron / electron-builder 缓存重定向到仓库 `.cache/`，
受限与离线环境可复现）。发布前跑一次 `npm run verify:all`（19 步全量取证，产出 `spikes/verify-all.json`）。

### 主进程产物里的源码暴露（已修）

`electron.vite.config.ts` 之前无条件 `build.sourcemap: 'inline'`，而 `files` 白名单就是 `out/**`：
内联地图会把**完整可读源码**随 app.asar 分发（本应用已是 AGPL-3.0-or-later、源码本就在仓库公开，
内联地图只剩「白撑体积」这一个后果），故改为只在开发构建保留。
现改为只在 `command === 'serve'`（开发）内联，生产构建不出地图：

| 项 | 修前 | 修后 |
|---|---|---|
| `out/main/index.js` | 619KB（含 356KB 内联源码地图） | 143.7KB，无 `sourceMappingURL=data:` |
| 安装包 | 227.75 MB | **227.64 MB** |
| 安装后 win-unpacked | 644 MB | 643.5 MB（88 文件） |

保留决定：主进程**不开 minify**。它保留了注释，但不含原始源码树与文件布局；
而 minify 会让 `log.ts` 里写的堆栈指向混淆标识——本应用的主要故障形态是 FFmpeg 子进程报错，
规格 §9 要求的正是可读的 stderr 尾部与命令行，因此可调试性优先于消除注释。

## 内置字体（`scripts/fetch-fonts.mjs` → `resources/fonts/` + `manifest.json`）

| fontId | 家族 | 字重 | 文件 | 来源 | 许可证 |
|---|---|---|---|---|---|
| `builtin-notosanssc-400` | Noto Sans SC | 400 | `NotoSansSC-Regular.otf` | `notofonts/noto-cjk` `Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf` | SIL OFL 1.1 |
| `builtin-notosanssc-500` | Noto Sans SC | 500 | `NotoSansSC-Medium.otf` | 同上 `-Medium` | SIL OFL 1.1 |
| `builtin-notosanssc-700` | Noto Sans SC | 700 | `NotoSansSC-Bold.otf` | 同上 `-Bold` | SIL OFL 1.1 |
| `builtin-notosanssc-900` | Noto Sans SC | 900 | `NotoSansSC-Black.otf` | 同上 `-Black` | SIL OFL 1.1 |
| `builtin-notoserifsc-700` | Noto Serif SC | 700 | `NotoSerifSC-Bold.otf` | `notofonts/noto-cjk` `Serif/SubsetOTF/SC/NotoSerifSC-Bold.otf`（11.5MB） | SIL OFL 1.1 |
| `builtin-jetbrainsmono-400` | JetBrains Mono | 400 | `JetBrainsMono-Variable.ttf` | `google/fonts` `ofl/jetbrainsmono/JetBrainsMono[wght].ttf` | SIL OFL 1.1 |
| `builtin-jetbrainsmono-700` | JetBrains Mono | 700 | 同上（同一文件按两个 fontId 各注册一次） | 同上 | SIL OFL 1.1 |

- 许可证文本按家族写入 `resources/fonts/LICENSES/<家族>-LICENSE.txt`（候选 URL 逐个尝试，取首个成功者）。
  当前已全部就位（3/3）：`NotoSansSC-LICENSE.txt`、`NotoSerifSC-LICENSE.txt`、`JetBrainsMono-LICENSE.txt`。
- JetBrains Mono 的许可证此前四处候选全部 404；已定位真实路径为
  `google/fonts` 仓库的 `ofl/jetbrainsmono/OFL.txt`（已写入 `LICENSE_CANDIDATES` 首位，现可自动拉取）。
- ⚠ `Noto Serif SC` 的全量 OTF（约 23MB）超过 jsDelivr 单文件 20MB 限制（返回 403），已改用 SubsetOTF（11.5MB）。
- 单一可变字体文件用两个 `fontId` 分别以 `weight: '400'` / `'700'` 注册 `FontFace`，
  避免同一 family 下字重互相干扰导致 Canvas 选错字形（`cssFamilyFor(fontId)` 使 family 名按 fontId 隔离）。
- 字体清单**必须与 `src/shared/constants.ts` 的 `BUILTIN_FONTS` 保持一致**（两处都有注释提醒）。
- 用户导入字体：`userData/fonts/<fontId>.<ext>` + `userData/fonts/fonts.json`，`fontId = 'user-' + sha1(bytes).slice(0,12)`；
  重复 sha1 不复制；内置字体不可删除；片段只保存 `fontId`（规格 §4.5）。

## 品牌字体包（用户已确认要提供，按协议原文分类处理）

需求：除思源黑体/宋体外，还要华为、OPPO、阿里巴巴、腾讯的免费可商用字体。
**关键区别：「免费商用」不等于「允许把字体文件再分发」。** 本应用必须把字体文件随包
（Canvas 要拿字节注册 FontFace），因此逐家查了协议原文：

| 家族 | 协议里与再分发相关的原文要点 | 判定 | 处理 |
|---|---|---|---|
| HarmonyOS Sans SC（华为） | 授予「使用、复制、合并、**嵌入、捆绑、重新分发**和/或销售…的**未修改副本**以及除字体软件以外的任何软件」；条件：不得修改、不得在独立基础上重新分发或销售、须随附本协议 | **可随包** | `npm run fetch:fonts -- --brand`：从官方页下载后放 `BRAND_FONT_DIR`，脚本做魔数+SHA1 归档，并要求协议文本同步入 `LICENSES/`（缺失则告警：无协议文本就不得分发） |
| OPPO Sans 4.0 | 免费商用，但条件含「不对字体改编/不对外售卖字体/**不向他方提供其他下载渠道**」 | **不随包** | 应用内「导入字体」由用户自行引入（我们不充当下载渠道，FontPanel 会列出官方页与原因） |
| 阿里巴巴普惠体 3.0 | 官方声明「全球永久免费正版商用」，3.0 去除了旧版「未经授权不得仿制/转换」条，但**未见允许字体文件随第三方软件再分发的明确文字** | **不随包（待书面确认）** | 同上；若拿到书面嵌入许可，只需把 `distribution` 改为 `bundle` 并重跑脚本 |
| 腾讯体 Tencent Sans | 官方声明免费商用，未见到允许嵌入/再分发的条款文字 | **不随包（待书面确认）** | 同上 |

实现位置：`scripts/fetch-fonts.mjs` 的 `BRAND_PACK`（每条带 `distribution` / `officialPage` / `license` / 可接受文件名），
处理结果写入 `resources/fonts/manifest.json` 的 `brandPack` 数组（bundled / import-only / missing / invalid +
`licenseArchived` / `licenseMissing`），即合规判定本身也是可追溯的产物。

> 官方字体包均在门户页后面（本机实测多个直链 404），因此脚本不自动拉字体本体；
> 这与 FFmpeg 的离线交付路径同构：开发者取得一次官方文件，脚本负责校验与归档。

## 签名与交付说明（用户已确认：不签名）

当前安装包**未做代码签名**（`electron-builder.yml` 里 `signExecutable: false`，只跳签名、保留 exe 图标与
元数据写入；构建日志会输出 `file signing skipped via signExecutable configuration`）。
交付时必须告知用户以下两点：

1. **SmartScreen**：首次运行会弹「Windows 已保护你的电脑」，点「更多信息」→「仍要运行」即可；
   这是因为没买证书，不是文件损坏。若后续拿到 OV/EV 证书，只需配置 `win.sign` 并重跑 `npm run dist:win`。
2. **完整性校验**：建议随包公告 SHA256。本次构建（2026-11-04）：

   ```
   Socut-0.1.0-Setup-win-x64.exe   238,695,308 B（227.64 MB）
   SHA256 3B06154B0F50053D298E1306802CCE290B9A9DC815901ACE8876C12F675B6B90
   ```

   重算命令：`Get-FileHash .\Socut-0.1.0-Setup-win-x64.exe -Algorithm SHA256`。
   注：安装包内容一变（含字体/FFmpeg/代码）哈希就变，上值只对当前产物有效；发布时以实际重算为准。

## 第三方素材与品牌边界

- 8 套预设仅使用风格词命名（时政权威 / 层叠新闻 / 冷静版 / 财经数据 / 国际简洁 / 地方台暖色 / 突发新闻 / 人物条），
  **不含任何电视台名称、台标、字体品牌或版式的像素级复刻**（规格 §1、§7）。
- 未使用任何受版权保护的示例图片、台标图形或素材视频；预览棋盘格与所有绘制元素均为代码生成。

## 交付决策（2026-11-04 已确认）

1. **FFmpeg：保持 GPL + libx264**（现状）。义务已落为可交付物：`docs/assets.md` 本节的源码要约 +
   `resources/ffmpeg/manifest.json` 的 URL/SHA256/版本行/许可证判定（由 `fetch-ffmpeg.mjs` 自动生成）。
2. **字体：OFL 基线不变，品牌字体按上表分类处理**（华为可随包；OPPO/阿里/腾讯走用户导入）。
3. **代码签名：不做**，按上节「签名与交付说明」向用户告知 SmartScreen 与 SHA256。

仍需外部输入才能关闭的事项（不是代码缺陷）：

- 华为官方字体包文件（需人工从开发者门户下载，门户有验证机制）；
- 若要将阿里普惠体/腾讯体随包分发，需版权方书面嵌入许可；
- Resolve/Premiere 透明终评、第二台物理机跨机测试、真实拍摄素材观感（见 `docs/verification/M0.md` 末尾清单）。
