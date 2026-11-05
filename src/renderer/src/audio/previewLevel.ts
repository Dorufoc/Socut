/**
 * 预览实时电平（v9）：把「正在出声的那一路」的瞬时电平交给时间轴频谱条。
 *
 * 为什么单独一个模块而不是 props/store：
 * 播放时电平每帧都在变，走 React 状态会让整条时间轴逐帧重渲染；
 * 这里只暴露一个「读函数」，卡片用自己的 rAF 把它写成 CSS 变量（命令式，不进渲染）。
 *
 * 只有一份读者（同一时刻预览里只有一路媒体在响），由预览侧登记与清空。
 */

type LevelReader = () => number

let reader: LevelReader | null = null

/** 登记电平来源；传 null 表示清空（停止播放 / 换素材）。 */
export function setPreviewLevelReader(next: LevelReader | null): void {
  reader = next
}

/** 读当前电平（0..1）；没有来源或来源抛错都归一为 0（频谱条退回静态幅度）。 */
export function readPreviewLevel(): number {
  if (!reader) return 0
  try {
    const value = reader()
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
  } catch {
    return 0
  }
}

/** 测试与热重载用：清掉残留来源。 */
export function resetPreviewLevel(): void {
  reader = null
}
