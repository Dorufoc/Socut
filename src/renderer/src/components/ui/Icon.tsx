import type { ReactElement } from 'react'

/**
 * 内联 SVG 图标（WinUI 3 风格：细描边、圆角端点、跟随 currentColor）。
 *
 * 只用 SVG 不用字符画图标：字符图标（⏮ ✚ 等）在本项目自带的字体里没有对应字形，
 * 会掉字或错位。所有图标一律 `aria-hidden`，
 * 可访问名由宿主按钮的 `aria-label` / `title` 提供。
 */

export interface IconProps {
  /** 边长（像素，正方形） */
  size?: number
  /** 描边粗细 */
  strokeWidth?: number
}

function frame(size: number, children: ReactElement | ReactElement[]): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

export function IconPlus({ size = 14, strokeWidth = 2 }: IconProps): ReactElement {
  return frame(size, [
    <line key="v" x1="12" y1="5" x2="12" y2="19" strokeWidth={strokeWidth} />,
    <line key="h" x1="5" y1="12" x2="19" y2="12" strokeWidth={strokeWidth} />
  ])
}

export function IconTrash({ size = 14, strokeWidth = 1.8 }: IconProps): ReactElement {
  return frame(size, [
    <line key="lid" x1="4" y1="7" x2="20" y2="7" strokeWidth={strokeWidth} />,
    <path key="handle" d="M9.5 7V4.8h5V7" strokeWidth={strokeWidth} />,
    <path key="body" d="M6.4 7l.9 12.2h9.4L17.6 7" strokeWidth={strokeWidth} />,
    <line key="l1" x1="10.2" y1="10.6" x2="10.4" y2="16.4" strokeWidth={strokeWidth} />,
    <line key="l2" x1="13.8" y1="10.6" x2="13.6" y2="16.4" strokeWidth={strokeWidth} />
  ])
}

/** 预览代理（素材库卡片上的「生成预览代理」入口）：画框 + 播放三角 */
export function IconProxy({ size = 14, strokeWidth = 1.8 }: IconProps): ReactElement {
  return frame(size, [
    <rect key="frame" x="3.2" y="4.6" width="17.6" height="14.8" rx="2.4" strokeWidth={strokeWidth} />,
    <polygon key="play" points="10,9 15.4,12 10,15" strokeWidth={strokeWidth} />
  ])
}

/** 铅笔（素材库紧凑卡片上的「重命名」入口） */
export function IconPencil({ size = 14, strokeWidth = 1.8 }: IconProps): ReactElement {
  return frame(size, [
    <path key="body" d="M4 20l4.6-1.1L18.8 8.7a2.3 2.3 0 0 0-3.2-3.2L5.4 15.7 4 20Z" strokeWidth={strokeWidth} />,
    <line key="tip" x1="13.9" y1="7.2" x2="16.8" y2="10.1" strokeWidth={strokeWidth} />
  ])
}

export function IconUndo({ size = 14, strokeWidth = 1.8 }: IconProps): ReactElement {
  return frame(size, [
    <path key="tail" d="M4 9h10.5a4.5 4.5 0 0 1 0 9H9" strokeWidth={strokeWidth} />,
    <polyline key="head" points="8,4 3.2,9 8,14" strokeWidth={strokeWidth} />
  ])
}

export function IconRedo({ size = 14, strokeWidth = 1.8 }: IconProps): ReactElement {
  return frame(size, [
    <path key="tail" d="M20 9H9.5a4.5 4.5 0 0 0 0 9H15" strokeWidth={strokeWidth} />,
    <polyline key="head" points="16,4 20.8,9 16,14" strokeWidth={strokeWidth} />
  ])
}

/** 定位（播放头往目标段靠）：一条竖线 + 两侧向内的箭头 */
export function IconLocate({ size = 13, strokeWidth = 1.8 }: IconProps): ReactElement {
  return frame(size, [
    <line key="axis" x1="12" y1="3.5" x2="12" y2="20.5" strokeWidth={strokeWidth} />,
    <polyline key="left" points="8,8 4.5,12 8,16" strokeWidth={strokeWidth} />,
    <polyline key="right" points="16,8 19.5,12 16,16" strokeWidth={strokeWidth} />
  ])
}
