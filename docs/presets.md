# 8 套预设的视觉规格（规格 §7）

实现位置：`src/shared/presets/*.ts`，由 `presets/base.ts` 的 `buildStackLayout()` 统一装配，
`validatePreset()`（`src/shared/presetSchema.ts`）在启动自检与单测中强制校验下列纪律。

## 共用结构（层叠分层，非「单框双行」）

```
root（position:absolute，left=safe-title-side，bottom=safe-title-bottom，flex-direction:column）
  ├─ decoration  装饰线（above：主条上方的细强调线，可按 fadeEnd 端部渐隐）
  │               或 leftBlock：主条内部的竖向强调色块
  ├─ primaryBar  主条（row，align-items:center，fill=primary，padding=paddingX）
  │    ├─ decoration(block)  左侧色块（仅 leftBlock 方案）
  │    └─ title(text)        主标题：字号 clamp(...)、字距 tracking、单行省略
  ├─ secondaryBar 副条（row，margin-left=stackOffsetX，margin-top=-overlapY → 与主条叠压）
  │    └─ subtitle(text)     副标题：字号更小，单行省略
  └─ decoration（below：部分预设改为底部细线，align-self:flex-end）
```

绘制顺序 = 树的**前序遍历**顺序（`layoutTree.ts` 收集 → `renderer.ts` 落笔），因此天然形成
「装饰线 → 背景条 → 主条 → 文字 → 副条」的层叠关系。

## 动画纪律（全部预设共同满足，测试逐条断言）

动画形态统一为**整体从左到右擦除**：一个片段只有一条绝对擦除线（由片段 root 盒算出），
条块 / 色块 / 装饰线 / 文字遮罩全部被同一对 x 边界裁切，几何尺寸逐帧完全不变。
不做位移、不做淡入（`displacement` 字段保留只为旧工程可打开，渲染不再消费）。

| 项 | 约束 | 实现 |
|---|---|---|
| 入场 | 6–12 帧（30fps 下 0.2–0.4s）自左向右擦出 | `animation.inDuration` ∈ [0.15, 0.5]s，`motionAt()` 的 `wipeTo` |
| 出场 | 比入场快 30%–40%（比例 0.55–0.72），左边界向右推进把整条擦去 | `outDuration / inDuration` 受 `OUT_RATIO_RANGE` 校验；`wipeFrom` |
| 文字 | **逐字渐隐渐现**：每个字符按索引错峰，进度与擦除同源 | `textRevealFrames` 解释为「同时过渡的字符数」，`layers.charStagger()` |
| 曲线 | 禁弹跳/过冲：只允许 `outQuad/outCubic/outQuart/outQuint/outExpo/smootherstep/linear` | `isOvershootFree()` 采样 64 点验证值域与单调性 |
| 锚定 | 默认底部标题安全区（部分强刺激预设用动作安全区） | `safeArea` + `safe-title-bottom` / `safe-bottom` |
| 装饰线 | 可提前 `ruleLeadInFrames` 入场，但自身也是左→右生长 | `animation.ruleLeadInFrames` |

## 编辑入口：选中 → 右侧检查器

- **选中是唯一入口**：时间轴点片段、或直接在预览里点字幕条，都会写到同一个 `selectedClipId`。
  预览点击走 `render/hitTest.ts`：用与绘制同一份擦除线（`layers.sweepOf`）判定“当下真正可见的像素”，
  所以片段区间外、擦除未盖到的地方、装饰线还没长到的地方都点不中；点空白处不会取消选中。
- **右侧检查器只作用于当前片段**：文字、预设、配色令牌、方框透明度、渐变、字体、字号缩放、动画节奏全部写回该片段。
- **字号缩放**：`styleOverrides.fontScale{title,subtitle}` 是相对预设值的乘法（50%–200%），缩放后仍过
  `fontSizeCapPx` 的宽/高硬上限，因此 4K 与竖屏下不会失控；归一化时与 1 相差不到 0.5% 视为未设置。
- **应用到全部**：`projectSchema.applyClipStyleToAll` 把预设 / 配色 / 字体 / 字号 / 动画复制到其余片段，
  **文字内容与入出点保留**；必须先过二次确认，工程里只有一个片段时直接提示无需应用。

## 标题区域宽度与副条自适应

- **层叠顺序：副条在上、主条在下**（先入树 = 视觉在上），副条可用 `stackOffsetX` 向右错位；
  两段的重叠由主条的 `-overlapY` 上边距实现（主条后画，压住副条下沿）。
- **标题区域（主条）长度 = 预览宽度 − 左右相等边距**：root 同时声明 `left` 与 `right` 为同一个**布局边距**令牌，
  主条用 `width:100%` 填满它。因此左右边距天然相等，且与文字长短无关。
- **边距 = 安全区 × `LAYOUT_INSET_SCALE`（当前 0.5）**：安全区（SMPTE/EBU）仍用于预览辅助线与硬约束，
  但条块实际摆放贴得更近——1080p 标题档左右各 **96px**（主条 1728px）、底部 **54px**。
  要再改只需调一个常量（`src/shared/constants.ts`）。
- 主条**不设任何宽度上限**：任何 `maxWidth` 都会压缩宽度、把右侧边距撑大，直接破坏「左右相等」；
  所以 compact / ultrawide 分支补丁都不再给主条加宽度（超宽档只限制副条 ≤ 70%）。
- 副条按文字自适应（hug），上限为 `subBarWidth`；文字过长时在条内换行
  （标题 3 行 / 副标题 2 行），到上限仍放不下时末行以「…」收尾。
- 条高用 `minHeight`（= 原条高令牌）：单行时与旧版像素一致，多行时按行数长高。
- 布局测量与绘制共用 `TextMeasurer.wrap()`，不存在「布局按 2 行、绘制按 3 行」的错位。

## 分支

- **竖屏紧凑（displayRatio < 1.2）**：主条仍是「满宽减等边距」、副条上限 94%、字号按 0.78 收缩（clamp 的 preferred 与 max 同时收缩），副标题强制单行省略。
- **超宽（displayRatio > 2.0）**：主条保持满宽减等边距（压宽会破坏左右相等），只把副条收到 `min(声明宽度, 70%)`，避免横向拉扯失控。
- 字号还受**按显示宽度的硬上限**约束（标准 6.2%、紧凑 7.5%），保证 360p→4K→9:16→21:9 全程可读（验收第 9 条）。

## 逐套参数

| # | id | 名称 | 令牌（primary / accent / text / secondaryText / barBackground） | 结构要点 | 入场→出场（秒） | 曲线 | 遮罩 | 字重 | 备注 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `policyAuthority` | 时政权威 | #143A6B / #C9A227 / #FFF / #E8EDF5 / rgba(10,26,48,.86) | 上方金线 22% 宽、主条 58vw、副条错位 28px@1080p、叠压 6px | 0.30 → 0.18 | outQuart | 3 帧 | 衬线主标题（回退思源宋体 Bold），字距 1.6 | 庄重克制，位移 -36px |
| 2 | `stackedNews` | 层叠新闻 | #0E2E52 / #2F7BD1 / #FFF / #CFE0F5 / rgba(20,62,108,.9) | 左侧强调色块 12px、主副条明显错位 46px、叠压 10px | 0.27 → 0.17 | outCubic | 3 帧 | 黑体 700/400 | 最典型的新闻联播式层叠（仅风格参考） |
| 3 | `calmEditorial` | 冷静版 | #2A2E35 / #7C8A99 / #F2F4F7 / #BCC6D1 / rgba(58,64,72,.82) | 主条下方 2px 细分割线（34% 宽、右端渐隐 0.6）、条宽 50vw | 0.30 → 0.19 | outQuint | 3 帧 | 500/400 | 低饱和、留白多，垂直入场 14px |
| 4 | `financeData` | 财经数据 | #10233F / #E8912D / #FFF / #FFD9A0 / rgba(16,35,63,.88) | 左侧琥珀色块 14px、副条 58% 宽、字距 1px | 0.27 → 0.16 | outQuart | 2 帧 | 黑体 700 + **副条锁定等宽字体角色** | 数字对齐；该角色不被片段字体覆盖 |
| 5 | `globalSimple` | 国际简洁 | #F5F6F8 / #D0202A / #101418 / #3B4450 / rgba(228,232,237,.94) | 亮白主条 + 深色字、上方短促红线 14% | 0.33 → 0.21 | smootherstep | 3 帧 | 700/400 | 跨平台最中性的一套；条内文字为深色系 |
| 6 | `localWarm` | 地方台暖色 | #B33A17 / #E9A13B / #FFF8EE / #F6D9A8 / rgba(120,45,20,.84) | 上方暖橙装饰线 20%（端部渐隐 0.4）、副条错位 34px | 0.30 → 0.18 | outQuart | 3 帧 | 700/400 | 民生新闻；建议搭配双色渐变文字（面板开启） |
| 7 | `breakingRed` | 突发新闻 | #C4141E / #FFD400 / #FFF / #FFE9E9 / rgba(122,12,18,.92) | 左侧黄色色块 18px、主条满宽减等边距、副条 54% 反错位 | 0.20 → 0.12 | outExpo | 2 帧 | 900/500，字距 2.4 | 锚定**动作安全区**、擦除入场，力度最强但仍无弹跳 |
| 8 | `personProfile` | 人物条 | #14283F / #6FA8DC / #FFF / #D6E4F3 / rgba(30,58,95,.8) | 左细色块 8px + 20px 留白、主条满宽减等边距、副条 78% 宽 | 0.36 → 0.22 | smootherstep | 3 帧 | 500/400，字距 3 | 姓名 + 职务双段，节奏最从容 |

## 与用户覆盖的关系（规格 §7：自定义作用于令牌层）

`SubtitleClip.styleOverrides` 只允许作用于**令牌层与少数显式参数**：
`tokens`（5 个配色键）、`barOpacity`、`titleGradient` / `subtitleGradient`（双色线性渐变 + 角度）、`compact`。
颜色非法（非 `#RGB/#RGBA/#RRGGBB/#RRGGBBAA/rgb()/rgba()`）在归一化阶段被丢弃，布局树与动画节奏不可被用户改坏。

## 评审清单（M2-8 / M4-7 用）

1. 8 套 × {360p, 720p, 1080p, 2K, 4K, 9:16, 21:9} 布局快照已由 `tests/presets.test.ts` 覆盖；
2. 逐帧评审表已可一键产出（命令见 `docs/verification/M0.md` 的「逐帧动画评审表」一节）：
   `FOCUSNEWS_REVIEW_SHEET=<png>` 跑一次应用，得到 8 预设 × 7 关键帧（入场起/中/末 · 静止 · 出场前/中/末）
   的 3700×2600 总览图，画面由生产同一套 `renderFrame` 以原生 1080p 渲染后缩排，背景为 FFmpeg
   testsrc2 合成的 1080p 画面帧（未使用任何版权素材）。**叠压关系是否清楚、装饰线是否廉价、
   揭字是否「网页感」仍需人看**，工具只保证每一帧都是真实导出像素；
   用真实拍摄素材的观感评审需交付方提供素材。
3. 任何「弹跳、回弹、缩放、旋转」类动效一律视为缺陷（曲线表已从源头禁止）。
