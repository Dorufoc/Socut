import { isOvershootFree } from './easing'
import { COLOR_TOKEN_KEYS, isValidColor } from './colors'
import type { AnimationSpec, AspectMode, LayoutNode, LayoutPatch, LayoutRole, Preset } from './types'

/** 规格 §7：入场 6–12 帧（30fps 下 0.2–0.4s），出场比入场快 30%–40%。 */
export const IN_DURATION_RANGE_SEC: [number, number] = [0.15, 0.5]
/** 出场 / 入场时长比合法区间（0.6 = 快 40%，0.7 = 快 30%） */
export const OUT_RATIO_RANGE: [number, number] = [0.55, 0.72]
export const TEXT_REVEAL_FRAMES_RANGE: [number, number] = [1, 4]

export interface ValidationIssue {
  presetId: string
  path: string
  message: string
}

function walkNodes(node: LayoutNode, visit: (n: LayoutNode, path: string) => void, path = 'root'): void {
  visit(node, path)
  node.children?.forEach((child, i) => walkNodes(child, visit, `${path}>${child.role}[${i}]`))
}

/** 收集布局树中出现的角色集合（用于校验层叠结构）。 */
export function collectRoles(node: LayoutNode): LayoutRole[] {
  const roles: LayoutRole[] = []
  walkNodes(node, (n) => roles.push(n.role))
  return roles
}

/**
 * 预设静态校验（规格 §7 设计原则的机器可验证部分）：
 * 1) 配色令牌齐备且合法；
 * 2) 缓动曲线无过冲（禁弹跳）；
 * 3) 入场时长合法、出场比入场快 30%–40%；
 * 4) 结构分层：至少包含 primaryBar + （secondaryBar 或 decoration）；
 * 5) 底部锚定安全区（root 必须有 bottom 令牌）。
 */
export function validatePreset(preset: Preset): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const push = (path: string, message: string): void => {
    issues.push({ presetId: preset.id, path, message })
  }

  for (const key of COLOR_TOKEN_KEYS) {
    const value = preset.tokens[key]
    if (!isValidColor(value)) push(`tokens.${key}`, `配色令牌 ${key} 不是合法颜色：${String(value)}`)
  }

  const anim: AnimationSpec = preset.animation
  const [inMin, inMax] = IN_DURATION_RANGE_SEC
  if (anim.inDuration < inMin || anim.inDuration > inMax) {
    push('animation.inDuration', `入场时长 ${anim.inDuration}s 超出 ${inMin}–${inMax}s（约 6–12 帧 @30fps）`)
  }
  const ratio = anim.outDuration / anim.inDuration
  const [rMin, rMax] = OUT_RATIO_RANGE
  if (ratio < rMin || ratio > rMax) {
    push('animation.outDuration', `出场应为入场的 ${rMin}–${rMax} 倍（快 30%–40%），当前 ${ratio.toFixed(3)}`)
  }
  const [tMin, tMax] = TEXT_REVEAL_FRAMES_RANGE
  if (anim.textRevealFrames < tMin || anim.textRevealFrames > tMax) {
    push('animation.textRevealFrames', `文字遮罩出现帧数 ${anim.textRevealFrames} 超出 ${tMin}–${tMax}`)
  }
  if (!isOvershootFree(anim.easing)) {
    push('animation.easing', `缓动 ${anim.easing} 存在过冲或非单调，禁止网页式弹跳（规格 §7）`)
  }

  const roles = collectRoles(preset.layout)
  if (!roles.includes('primaryBar')) push('layout', '缺少 primaryBar（主条）节点')
  if (!roles.includes('secondaryBar') && !roles.includes('decoration')) {
    push('layout', '结构未层叠：需要 secondaryBar 或 decoration（规格 §7：非单框双行）')
  }
  if (!preset.layout.bottom && preset.layout.bottom !== 0) {
    push('layout.bottom', 'root 必须声明 bottom 安全区令牌（默认锚定底部安全区）')
  }

  walkNodes(preset.layout, (node, path) => {
    if (node.fill && !COLOR_TOKEN_KEYS.includes(node.fill.token)) {
      push(`${path}.fill`, `填充引用了未知令牌 ${node.fill.token}`)
    }
    if (node.kind === 'text' && !node.text) {
      push(path, 'text 节点缺少 text 样式声明')
    }
  })

  return issues
}

/**
 * 应用紧凑/超宽分支补丁（规格 §4.3）：按 role 命中节点并覆盖字段。
 * 返回深拷贝，预设本身保持不可变。
 */
export function applyLayoutPatches(node: LayoutNode, patches: LayoutPatch[]): LayoutNode {
  const clone = (n: LayoutNode): LayoutNode => ({
    ...n,
    ...(n.padding ? { padding: { ...n.padding } } : {}),
    ...(n.margin ? { margin: { ...n.margin } } : {}),
    ...(n.text ? { text: { ...n.text } } : {}),
    ...(n.children ? { children: n.children.map(clone) } : {})
  })
  const root = clone(node)
  for (const patch of patches) {
    const targets: LayoutNode[] = []
    walkNodes(root, (n) => {
      if (n.role === patch.role) targets.push(n)
    })
    for (const target of targets) {
      if (patch.hidden) {
        target.children = []
        target.width = 0
        target.height = 0
        continue
      }
      if (patch.style) Object.assign(target, patch.style)
      if (patch.text && target.text) Object.assign(target.text, patch.text)
    }
  }
  return root
}

/** 按分支模式取补丁。 */
export function patchesForMode(preset: Preset, mode: AspectMode): LayoutPatch[] {
  if (mode === 'compact') return preset.patches.compact
  if (mode === 'ultrawide') return preset.patches.ultrawide
  return []
}
