/**
 * M7-E：转场目录（58 种 xfade + 旧工程别名），类型与元数据的**唯一真值**。
 *
 * 为什么单独成文件：`types.ts` 要引用 `TransitionType` 联合，`transitions.ts` 要引用元数据；
 * 把"枚举 + 元数据"放在本文件（不 import 任何东西）就能让 types 与 transitions 都引用它而不成环。
 *
 * 覆盖口径：FFmpeg 9 的 `xfade` 共 58 个具名 transition（不含 `custom`），目录里 **58 个唯一
 * xfade 值全部覆盖**；旧工程的 `blurV`（纵向模糊）在 FFmpeg 9 没有对应原语，映射到 `hblur`
 * （横向模糊近似，导出不再报 "transition not found"）。
 */

export const TRANSITION_FAMILIES = [
  'basic',
  'blur',
  'wind',
  'push',
  'pull',
  'camera',
  'wipe',
  'slide',
  'shape',
  'effect'
] as const

export type TransitionFamily = (typeof TRANSITION_FAMILIES)[number]

export const TRANSITION_DIRECTIONS = ['left', 'right', 'up', 'down', 'none'] as const

export type TransitionDirection = (typeof TRANSITION_DIRECTIONS)[number]

export const TRANSITION_FAMILY_LABELS: Record<TransitionFamily, string> = {
  basic: '基础',
  blur: '模糊',
  wind: '运动模糊平移',
  push: '推入',
  pull: '拉出',
  camera: '运镜',
  wipe: '擦除',
  slide: '滑动',
  shape: '形状',
  effect: '特效'
}

/** 59 个转场 id（58 个唯一 xfade + `blurV` 旧工程别名）。显式联合避免与目录常量互相推导。 */
export type TransitionType =
  | 'dissolve'
  | 'fadeBlack'
  | 'fadeWhite'
  | 'lightFlash'
  | 'softDissolve'
  | 'fadeFast'
  | 'fadeSlow'
  | 'blurH'
  | 'blurV'
  | 'windLeft'
  | 'windRight'
  | 'windUp'
  | 'windDown'
  | 'pushLeft'
  | 'pushRight'
  | 'pushUp'
  | 'pushDown'
  | 'pullLeft'
  | 'pullRight'
  | 'pullUp'
  | 'pullDown'
  | 'zoomIn'
  | 'wipeLeft'
  | 'wipeRight'
  | 'wipeUp'
  | 'wipeDown'
  | 'wipeTl'
  | 'wipeTr'
  | 'wipeBl'
  | 'wipeBr'
  | 'smoothLeft'
  | 'smoothRight'
  | 'smoothUp'
  | 'smoothDown'
  | 'diagTl'
  | 'diagTr'
  | 'diagBl'
  | 'diagBr'
  | 'sliceHl'
  | 'sliceHr'
  | 'sliceVu'
  | 'sliceVd'
  | 'slideLeft'
  | 'slideRight'
  | 'slideUp'
  | 'slideDown'
  | 'circleCrop'
  | 'rectCrop'
  | 'distance'
  | 'radial'
  | 'circleOpen'
  | 'circleClose'
  | 'vertOpen'
  | 'vertClose'
  | 'horzOpen'
  | 'horzClose'
  | 'pixelize'
  | 'squeezeH'
  | 'squeezeV'

export interface TransitionMeta {
  type: TransitionType
  family: TransitionFamily
  direction: TransitionDirection
  /** 中文短名（检查器按钮与时间轴 tooltip 共用） */
  label: string
  /** FFmpeg `xfade` 的 transition 值 */
  xfade: string
}

/** 59 条目录（58 个唯一 xfade + `blurV` 别名），声明顺序 = 族内展示顺序。 */
export const TRANSITION_CATALOG = [
  // ---------------------------------------------------------------- 基础（7）
  { type: 'dissolve', family: 'basic', direction: 'none', label: '溶解', xfade: 'fade' },
  { type: 'fadeBlack', family: 'basic', direction: 'none', label: '黑场', xfade: 'fadeblack' },
  { type: 'fadeWhite', family: 'basic', direction: 'none', label: '白场', xfade: 'fadewhite' },
  { type: 'lightFlash', family: 'basic', direction: 'none', label: '光效闪灰', xfade: 'fadegrays' },
  { type: 'softDissolve', family: 'basic', direction: 'none', label: '柔化溶解', xfade: 'dissolve' },
  { type: 'fadeFast', family: 'basic', direction: 'none', label: '快速淡出', xfade: 'fadefast' },
  { type: 'fadeSlow', family: 'basic', direction: 'none', label: '慢速淡出', xfade: 'fadeslow' },

  // ---------------------------------------------------------------- 模糊（2）
  { type: 'blurH', family: 'blur', direction: 'none', label: '横向模糊', xfade: 'hblur' },
  { type: 'blurV', family: 'blur', direction: 'none', label: '纵向模糊', xfade: 'hblur' },

  // ---------------------------------------------------------------- 运动模糊平移（4）
  { type: 'windLeft', family: 'wind', direction: 'left', label: '风感左移', xfade: 'hlwind' },
  { type: 'windRight', family: 'wind', direction: 'right', label: '风感右移', xfade: 'hrwind' },
  { type: 'windUp', family: 'wind', direction: 'up', label: '风感上移', xfade: 'vuwind' },
  { type: 'windDown', family: 'wind', direction: 'down', label: '风感下移', xfade: 'vdwind' },

  // ---------------------------------------------------------------- 推入（4）
  { type: 'pushLeft', family: 'push', direction: 'left', label: '推入左侧', xfade: 'coverleft' },
  { type: 'pushRight', family: 'push', direction: 'right', label: '推入右侧', xfade: 'coverright' },
  { type: 'pushUp', family: 'push', direction: 'up', label: '推入上方', xfade: 'coverup' },
  { type: 'pushDown', family: 'push', direction: 'down', label: '推入下方', xfade: 'coverdown' },

  // ---------------------------------------------------------------- 拉出（4）
  { type: 'pullLeft', family: 'pull', direction: 'left', label: '拉出左侧', xfade: 'revealleft' },
  { type: 'pullRight', family: 'pull', direction: 'right', label: '拉出右侧', xfade: 'revealright' },
  { type: 'pullUp', family: 'pull', direction: 'up', label: '拉出上方', xfade: 'revealup' },
  { type: 'pullDown', family: 'pull', direction: 'down', label: '拉出下方', xfade: 'revealdown' },

  // ---------------------------------------------------------------- 运镜（1）
  { type: 'zoomIn', family: 'camera', direction: 'none', label: '运镜推近', xfade: 'zoomin' },

  // ---------------------------------------------------------------- 擦除（20）
  { type: 'wipeLeft', family: 'wipe', direction: 'left', label: '左擦除', xfade: 'wipeleft' },
  { type: 'wipeRight', family: 'wipe', direction: 'right', label: '右擦除', xfade: 'wiperight' },
  { type: 'wipeUp', family: 'wipe', direction: 'up', label: '上擦除', xfade: 'wipeup' },
  { type: 'wipeDown', family: 'wipe', direction: 'down', label: '下擦除', xfade: 'wipedown' },
  { type: 'wipeTl', family: 'wipe', direction: 'none', label: '左上擦除', xfade: 'wipetl' },
  { type: 'wipeTr', family: 'wipe', direction: 'none', label: '右上擦除', xfade: 'wipetr' },
  { type: 'wipeBl', family: 'wipe', direction: 'none', label: '左下擦除', xfade: 'wipebl' },
  { type: 'wipeBr', family: 'wipe', direction: 'none', label: '右下擦除', xfade: 'wipebr' },
  { type: 'smoothLeft', family: 'wipe', direction: 'left', label: '柔滑左擦', xfade: 'smoothleft' },
  { type: 'smoothRight', family: 'wipe', direction: 'right', label: '柔滑右擦', xfade: 'smoothright' },
  { type: 'smoothUp', family: 'wipe', direction: 'up', label: '柔滑上擦', xfade: 'smoothup' },
  { type: 'smoothDown', family: 'wipe', direction: 'down', label: '柔滑下擦', xfade: 'smoothdown' },
  { type: 'diagTl', family: 'wipe', direction: 'none', label: '左上对角', xfade: 'diagtl' },
  { type: 'diagTr', family: 'wipe', direction: 'none', label: '右上对角', xfade: 'diagtr' },
  { type: 'diagBl', family: 'wipe', direction: 'none', label: '左下对角', xfade: 'diagbl' },
  { type: 'diagBr', family: 'wipe', direction: 'none', label: '右下对角', xfade: 'diagbr' },
  { type: 'sliceHl', family: 'wipe', direction: 'none', label: '横向左切', xfade: 'hlslice' },
  { type: 'sliceHr', family: 'wipe', direction: 'none', label: '横向右切', xfade: 'hrslice' },
  { type: 'sliceVu', family: 'wipe', direction: 'none', label: '纵向上切', xfade: 'vuslice' },
  { type: 'sliceVd', family: 'wipe', direction: 'none', label: '纵向下切', xfade: 'vdslice' },

  // ---------------------------------------------------------------- 滑动（4）
  { type: 'slideLeft', family: 'slide', direction: 'left', label: '滑入左', xfade: 'slideleft' },
  { type: 'slideRight', family: 'slide', direction: 'right', label: '滑入右', xfade: 'slideright' },
  { type: 'slideUp', family: 'slide', direction: 'up', label: '滑入上', xfade: 'slideup' },
  { type: 'slideDown', family: 'slide', direction: 'down', label: '滑入下', xfade: 'slidedown' },

  // ---------------------------------------------------------------- 形状（10）
  { type: 'circleCrop', family: 'shape', direction: 'none', label: '圆形裁切', xfade: 'circlecrop' },
  { type: 'rectCrop', family: 'shape', direction: 'none', label: '矩形裁切', xfade: 'rectcrop' },
  { type: 'distance', family: 'shape', direction: 'none', label: '远距', xfade: 'distance' },
  { type: 'radial', family: 'shape', direction: 'none', label: '径向', xfade: 'radial' },
  { type: 'circleOpen', family: 'shape', direction: 'none', label: '圆形展开', xfade: 'circleopen' },
  { type: 'circleClose', family: 'shape', direction: 'none', label: '圆形收拢', xfade: 'circleclose' },
  { type: 'vertOpen', family: 'shape', direction: 'none', label: '纵向展开', xfade: 'vertopen' },
  { type: 'vertClose', family: 'shape', direction: 'none', label: '纵向收拢', xfade: 'vertclose' },
  { type: 'horzOpen', family: 'shape', direction: 'none', label: '横向展开', xfade: 'horzopen' },
  { type: 'horzClose', family: 'shape', direction: 'none', label: '横向收拢', xfade: 'horzclose' },

  // ---------------------------------------------------------------- 特效（3）
  { type: 'pixelize', family: 'effect', direction: 'none', label: '像素化', xfade: 'pixelize' },
  { type: 'squeezeH', family: 'effect', direction: 'none', label: '横向挤压', xfade: 'squeezeh' },
  { type: 'squeezeV', family: 'effect', direction: 'none', label: '纵向挤压', xfade: 'squeezev' }
] as const satisfies readonly TransitionMeta[]