# 8 套预设的视觉规格（规格 §7）

实现位置：`src/shared/presets/*.ts`，由 `src/shared/presets/layout.ts` 的
`buildSubtitleAbove()` 统一装配；`validatePreset()`（`src/shared/presetSchema.ts`）
在启动自检与单测中强制校验下列纪律。

## 共用结构（副标题独立矩形在上，主标题矩形在下）

```
root（position:absolute，left=right=布局边距，bottom=8vh，flex-direction:column，gap=6px）
  ├─ secondaryBar  副标题矩形（副标题专用，纯色填充）
  │    ├─ maxWidth = 主条 minWidth（不会比主条宽）
  │    ├─ padding = 主条左块宽 + 间距（文字与主标题共左线）
  │    └─ subtitle(text)  字号更小（约主标题 0.4–0.48），可两行
  └─ primaryBar    主标题矩形（宽度随标题自适应）
       ├─ decoration(block)  可选：左侧强调块/徽标，撑满整条高度
       └─ title(text)        主标题：字号 clamp(...)、字距 tracking、最多两行
```

- **副标题必须在上**：两块独立纯色矩形，不融合、不放在主标题下方。
- **左缘严格对齐**：`secondaryBar.x === primaryBar.x`（回归测试逐例断言）。
- **副标题更小**：`secondaryBar.h < primaryBar.h`，且副标题矩形不得超过主条宽度。
- 绘制顺序 = 树的**前序遍历**顺序（`layoutTree.ts` 收集 → `renderer.ts` 落笔）。

## 动画纪律（全部预设共同满足，测试逐条断言）

动画形态统一为**整体从左到右擦除**：一个片段只有一条绝对擦除线，
条块 / 色块 / 文字全部被同一对 x 边界裁切，几何尺寸逐帧完全不变。
不做位移、不做淡入（`displacement` 字段保留只为旧工程可打开，渲染不再消费）。

**擦除线跨度 = 实际绘制内容的横向包络**（`layers.contentBoundsOf()`），不是 root 盒：
条宽自适应后，root 仍占满“画宽减边距”，拿它当跨度会让窄条在入场早期整条弹出。
`hitTest` 也用同一份包络，保证“看到的位置 = 点得到的位置”。

| 项 | 约束 | 实现 |
|---|---|---|
| 入场 | 6–12 帧（30fps 下 0.2–0.4s）自左向右擦出 | `animation.inDuration` ∈ [0.15, 0.5]s，`motionAt()` 的 `wipeTo` |
| 出场 | 比入场快 30%–40%（比例 0.55–0.72），左边界向右推进把整条擦去 | `outDuration / inDuration` 受 `OUT_RATIO_RANGE` 校验；`wipeFrom` |
| 文字 | **逐字渐隐渐现**：每个字符按索引错峰，进度与擦除同源 | `textRevealFrames` 解释为「同时过渡的字符数」，`layers.charStagger()` |
| 曲线 | 禁弹跳/过冲：只允许 `outQuad/outCubic/outQuart/outQuint/outExpo/smootherstep/linear` | `isOvershootFree()` 采样 64 点验证值域与单调性 |
| 锚定 | 所有预设统一 8vh 底部锚点 | `INSET.bottom = '8vh'` |
| 装饰线 | 可提前 `ruleLeadInFrames` 入场，但自身也是左→右生长 | `animation.ruleLeadInFrames` |

## 编辑入口：选中 → 右侧检查器

- **选中是唯一入口**：时间轴点片段、或直接在预览里点字幕条，都会写到同一个 `selectedClipId`。
  预览点击走 `render/hitTest.ts`：用与绘制同一份擦除线（`layers.sweepOf`）判定“当下真正可见的像素”，
  所以片段区间外、擦除未盖到的地方都点不中；点空白处不会取消选中。
- **右侧检查器只作用于当前片段**：文字、预设、配色令牌、方框透明度、渐变、字体、字号缩放、动画节奏全部写回该片段。
- **字号缩放**：`styleOverrides.fontScale{title,subtitle}` 是相对预设值的乘法（50%–200%），缩放后仍过
  `fontSizeCapPx` 的宽/高硬上限；归一化时与 1 相差不到 0.5% 视为未设置。
- **应用到全部**：`projectSchema.applyClipStyleToAll` 把预设 / 配色 / 字体 / 字号 / 动画复制到其余片段，
  **文字内容与入出点保留**；必须先过二次确认。

## 宽度 / 边距 / 换行

- **条宽随文字自适应**：主条 / 副标题条都 hug 内容；极短文案用 `minWidth` 保底视觉重量，
  长文案达到 `maxWidth`（`min(1180px@1080p, 64%)` 一档）后不再变宽，只在条内换行。
- **左缘 = 标题安全区内缩（10%）× `LAYOUT_INSET_SCALE`（0.5）= 画宽 5%**：1080p 下 96px；
  副标题矩形与主条矩形共用同一个左缘。
- **底部锚点 = 8vh**（1080p 下 86px）：所有预设一致，切换预设不上下跳，也不越过 overscan。
- 副标题条 `maxWidth` 与主条 `minWidth` 取同一令牌，保证「副标题矩形不比主条宽」；
  两行副标题时条高按行数增长，但仍低于主条。
- 标题最多 2 行（`financial/person` 为 1 行），副标题最多 2 行；超出以「…」收尾，不静默丢字。
- 布局测量与绘制共用 `TextMeasurer.wrap()`，不存在「布局按 2 行、绘制按 3 行」的错位。

## 分支

- **竖屏紧凑（displayRatio < 1.2）**：主条/副条 maxWidth 92%，标题与副标题单行省略，字号按 0.78 收缩。
- **超宽（displayRatio > 2.0）**：主条 maxWidth ≤ 56%，副条 ≤ 34%，避免横向被拉成一条横贯全屏的色带。
- 字号还受**按显示宽度的硬上限**约束（标准 6.2%、紧凑 7.5%），保证 360p→4K→9:16→21:9 全程可读（验收第 9 条）。

## 逐套参数

| # | id | 名称 | 令牌（primary / accent / text / secondaryText / barBackground） | 结构要点 | 入场→出场（秒） | 曲线 | 遮罩 | 字重 | 备注 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `policyAuthority` | 时政权威 | #12345E / #D4AF37 / #FFF / #E6EDF7 / #0A1B2E | 金色左条 6px、衬线主标题、副标题金调小条 | 0.30 → 0.18 | outQuart | 3 帧 | 衬线 700 / 500，字距 1.1 | 庄重克制 |
| 2 | `stackedNews` | 层叠新闻 | #0E2E52 / #2F7BD1 / #FFF / #D7E6F8 / #164A80 | 加宽蓝色左块 14px、浅蓝副标题条 | 0.27 → 0.17 | outCubic | 3 帧 | 黑体 700/400 | 最典型的广播双台阶 |
| 3 | `calmEditorial` | 冷静版 | #2A2E35 / #8FA3B8 / #F5F7FA / #CBD5E1 / #171B21 | 4px 灰色细条、无饰线、深灰副标题条 | 0.30 → 0.19 | outQuint | 3 帧 | 500/400 | 低饱和、信息优先 |
| 4 | `financeData` | 财经数据 | #0F223C / #F0A33A / #FFF / #FFC978 / #08182B | 10px 琥珀左条、上方琥珀等宽读数条 | 0.27 → 0.16 | outQuart | 2 帧 | 700 + **读数锁定等宽字体** | 数字对齐 |
| 5 | `globalSimple` | 国际简洁 | #F2F4F6 / #C81E28 / #101418 / #3B4450 / #E4E8ED | 浅色主条 + 深色字、红色副标题条 | 0.33 → 0.21 | smootherstep | 3 帧 | 700/500 | 红色小条作边界锚点 |
| 6 | `localWarm` | 地方台暖色 | #B23A18 / #F0B44E / #FFF8EE / #FFE2B8 / #7A2C12 | 6px 圆角主条、8px 暖橙左条、深暖副标题条 | 0.30 → 0.18 | outQuart | 3 帧 | 700/400 | 民生新闻，亲和 |
| 7 | `breakingRed` | 突发新闻 | #C4141E / #FFD400 / #FFF / #FFE9E9 / #1A0A0C | 14px 黄色徽标左块、暗红副标题条 | 0.20 → 0.12 | outExpo | 2 帧 | 900/500，字距 1.4 | 力度最强但无弹跳 |
| 8 | `personProfile` | 人物条 | #172B45 / #6FA8DC / #FFF / #D8E6F5 / #101F31 | 5px 蓝色左条、姓名字号 88 上限、职务副标题条 | 0.36 → 0.22 | smootherstep | 3 帧 | 700/400，字距 1.6 | 姓名大、职务小 |

## 视觉检查（新增）

`npm run visual:check` 会用生产同一套 `buildRenderJob → computeClipBoxes → renderFrame`
渲染 **8 套预设 × 短/常规/长模拟文案**，输出：

- `spikes/artifacts/visual-check/sheet.png`：8×3 总览（人眼复核）；
- `spikes/artifacts/visual-check/<preset>-<variant>.png`：单例全帧；
- `spikes/artifacts/visual-check/report.json`：逐例指标与失败项。

自动断言：文字占条宽比、右侧空白、条高/字号/行数、上下内边距、底边距、左右安全区、
标题/副标题对比度，以及「副标题在上、左缘对齐、更矮更窄、不宽于主条、文字共左线」。
任一不达标时进程以退出码 1 结束。

## 与用户覆盖的关系（规格 §7：自定义作用于令牌层）

`SubtitleClip.styleOverrides` 只允许作用于**令牌层与少数显式参数**：
`tokens`（5 个配色键）、`barOpacity`、`titleGradient` / `subtitleGradient`（双色线性渐变 + 角度）、`compact`。
颜色非法（非 `#RGB/#RGBA/#RRGGBB/#RRGGBBAA/rgb()/rgba()`）在归一化阶段被丢弃，布局树与动画节奏不可被用户改坏。

## 评审清单（M2-8 / M4-7 用）

1. 8 套 × {360p, 720p, 1080p, 2K, 4K, 9:16, 21:9} 布局快照已由 `tests/presets.test.ts` 覆盖，
   包括「副标题在上、左缘对齐、更矮更窄」的结构契约；
2. 视觉检查已脚本化：`npm run visual:check`（8 预设 × 3 文案，出图 + 指标 + 退出码）；
   逐帧动画评审表仍可用 `FOCUSNEWS_REVIEW_SHEET=<png>` 产出 8 预设 × 7 关键帧的动画总览；
3. 任何「弹跳、回弹、缩放、旋转」类动效一律视为缺陷（曲线表已从源头禁止）。
