/**
 * 文本测量与字体串（规格 §4.3：Yoga measureFunc 依赖真实字形度量）。
 * 关键纪律：测量与绘制必须使用完全相同的 font 字符串与字距设置，
 * 否则布局宽度与实际像素宽度不一致（预览与导出同源，因此一次偏差会永久存在）。
 */

export interface FontSpec {
  family: string
  weight: number
  sizePx: number
  trackingPx: number
}

/** 统一的 CSS font 串（回退链固定，避免机器字体差异污染导出）。 */
export function canvasFont(spec: FontSpec): string {
  return `${spec.weight} ${spec.sizePx}px "${spec.family}", "Noto Sans SC", sans-serif`
}

export interface MeasuredText {
  width: number
  height: number
  lines: number
  /** 省略处理后的实际绘制文本 */
  displayText: string
}

export interface MeasureRequest {
  text: string
  font: FontSpec
  lineHeight: number
  /** 可用宽度（AtMost 场景），undefined 表示不限 */
  maxWidth?: number
  maxLines?: number
  ellipsis?: boolean
}

interface RawMeasureContext {
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null
  canvas: OffscreenCanvas | HTMLCanvasElement
}

function createMeasureContext(): RawMeasureContext {
  // 优先 OffscreenCanvas（渲染进程）；退到 DOM canvas；
  // 纯 Node（布局快照测试）两者都没有时返回 null，调用方走字形度量估算。
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(1, 1)
    return { canvas, ctx: canvas.getContext('2d') as RawMeasureContext['ctx'] }
  }
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    return { canvas, ctx: canvas.getContext('2d') as RawMeasureContext['ctx'] }
  }
  return { canvas: null as unknown as OffscreenCanvas, ctx: null }
}

export class TextMeasurer {
  private readonly raw = createMeasureContext()
  private readonly cache = new Map<string, MeasuredText>()
  private readonly wrapCache = new Map<string, { lines: string[]; truncated: boolean }>()
  private lastFont = ''
  private lastTracking = ''

  private applyFont(font: FontSpec): void {
    const ctx = this.raw.ctx
    if (!ctx) return
    const fontString = canvasFont(font)
    if (fontString !== this.lastFont) {
      ctx.font = fontString
      this.lastFont = fontString
    }
    // Chromium 支持 canvas letterSpacing；不支持时按 0 处理并让绘制侧同样跳过（保持一致）
    const tracking = `${font.trackingPx}px`
    if (tracking !== this.lastTracking) {
      const withTracking = ctx as CanvasRenderingContext2D & { letterSpacing?: string }
      if ('letterSpacing' in withTracking) {
        withTracking.letterSpacing = tracking
      }
      this.lastTracking = tracking
    }
  }

  private rawWidth(text: string, font: FontSpec): number {
    this.applyFont(font)
    const ctx = this.raw.ctx
    if (!ctx) return text.length * font.sizePx * 0.6
    // measureText 返回的 width 已含字距（letterSpacing 生效时）
    const metrics = ctx.measureText(text)
    return typeof metrics.width === 'number' ? metrics.width : 0
  }

  measure(request: MeasureRequest): MeasuredText {
    const key = [
      request.text,
      request.font.family,
      request.font.weight,
      request.font.sizePx,
      request.font.trackingPx,
      request.lineHeight,
      request.maxWidth ?? 'inf',
      request.maxLines ?? 1,
      request.ellipsis ? 'e' : ''
    ].join('|')
    const hit = this.cache.get(key)
    if (hit) return hit

    const lineHeightPx = request.font.sizePx * request.lineHeight
    const single = this.rawWidth(request.text, request.font)
    let result: MeasuredText

    if (request.maxLines && request.maxLines > 1) {
      const { lines } = this.wrap(request.text, request.font, request.maxWidth, request.maxLines)
      result = {
        width: lines.reduce((max, line) => Math.max(max, this.rawWidth(line, request.font)), 0),
        height: lines.length * lineHeightPx,
        lines: lines.length,
        // 多行时绘制侧直接调 wrap() 取行文本（displayText 只服务单行省略）
        displayText: request.text
      }
    } else {
      let displayText = request.text
      let width = single
      if (request.maxWidth !== undefined && Number.isFinite(request.maxWidth) && single > request.maxWidth) {
        if (request.ellipsis) {
          displayText = this.truncate(request.text, request.font, request.maxWidth)
          width = this.rawWidth(displayText, request.font)
        } else {
          width = request.maxWidth
        }
      }
      result = { width, height: lineHeightPx, lines: 1, displayText }
    }

    if (this.cache.size > 4000) this.cache.clear()
    this.cache.set(key, result)
    return result
  }

  /** 二分查找截断点，保证 "…" 后总宽不超过 maxWidth。 */
  truncate(text: string, font: FontSpec, maxWidth: number): string {
    if (text.length <= 1) return text
    const ellipsis = '…'
    const ellipsisWidth = this.rawWidth(ellipsis, font)
    const limit = Math.max(0, maxWidth - ellipsisWidth)
    let low = 0
    let high = text.length - 1
    let best = 0
    while (low <= high) {
      const mid = (low + high) >> 1
      const candidate = text.slice(0, mid)
      const width = this.rawWidth(candidate, font)
      if (width <= limit) {
        best = mid
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    return `${text.slice(0, best)}${ellipsis}`
  }

  widthOf(text: string, font: FontSpec): number {
    return this.rawWidth(text, font)
  }

  /**
   * 按最大宽度折行（贪心逐字），最多 maxLines 行；末行放不下时以省略号收尾（不静默丢字）。
   * 布局测量（measure）与绘制（layers.drawText）必须共用本函数：
   * 否则会出现「布局按 2 行算高、绘制按 3 行落笔」的错位，预览与导出会一起错。
   */
  wrap(
    text: string,
    font: FontSpec,
    maxWidth: number | undefined,
    maxLines: number
  ): { lines: string[]; truncated: boolean } {
    if (maxLines <= 1 || maxWidth === undefined || !Number.isFinite(maxWidth)) {
      return { lines: [text], truncated: false }
    }
    const key = [text, font.family, font.weight, font.sizePx, font.trackingPx, maxWidth, maxLines].join('|')
    const hit = this.wrapCache.get(key)
    if (hit) return hit

    const chars = [...text]
    const lines: string[] = []
    let current = ''
    let truncated = false
    for (let i = 0; i < chars.length; i++) {
      const candidate = current + chars[i]!
      if (current.length > 0 && this.rawWidth(candidate, font) > maxWidth) {
        if (lines.length >= maxLines - 1) {
          // 末行也放不下：剩余内容压成「…」，不静默丢字
          lines.push(this.truncate(current + chars.slice(i).join(''), font, maxWidth))
          truncated = true
          current = ''
          break
        }
        lines.push(current)
        current = chars[i]!
      } else {
        current = candidate
      }
    }
    if (!truncated && current.length > 0) lines.push(current)
    const out = { lines: lines.length > 0 ? lines : [''], truncated }
    if (this.wrapCache.size > 4000) this.wrapCache.clear()
    this.wrapCache.set(key, out)
    return out
  }

  clearCache(): void {
    this.cache.clear()
    this.wrapCache.clear()
    this.lastFont = ''
  }
}

let shared: TextMeasurer | null = null

/** 全局共享测量器（一个测量 Canvas 足够，避免多实例重复分配）。 */
export function getTextMeasurer(): TextMeasurer {
  if (!shared) shared = new TextMeasurer()
  return shared
}
