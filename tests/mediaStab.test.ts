import { describe, expect, it } from 'vitest'
import {
  defaultMediaStab,
  isDefaultMediaStab,
  normalizeMediaStab,
  STAB_LEVELS,
  stabDetectProfile,
  stabPreviewFileName,
  stabPreviewSignature,
  stabPreviewToken,
  stabProxyTimeOf,
  stabTransformProfile
} from '@shared/mediaStab'
import type { Fps, MediaClipStab } from '@shared/types'

/**
 * 防抖口径（v8）：默认值纪律、脏值归一、档位 → vidstab 滤镜参数映射。
 * 单位换算只允许发生在 shared/mediaStab，这里就是它的锁定测试。
 */

const stab = (over: Partial<MediaClipStab> = {}): MediaClipStab => ({
  ...defaultMediaStab(),
  ...over
})

describe('normalizeMediaStab', () => {
  it('全默认 = undefined（调用方整键删除，工程 JSON 不留零值）', () => {
    expect(normalizeMediaStab(stab())).toBeUndefined()
    expect(normalizeMediaStab({ enabled: false, level: 'standard', tripod: false })).toBeUndefined()
  })

  it('开关打开即非默认；只改档位/三脚架也算非默认', () => {
    expect(normalizeMediaStab(stab({ enabled: true }))).toEqual({ enabled: true, level: 'standard', tripod: false })
    expect(normalizeMediaStab(stab({ level: 'high' }))).toEqual({ enabled: false, level: 'high', tripod: false })
    expect(normalizeMediaStab(stab({ tripod: true }))).toEqual({ enabled: false, level: 'standard', tripod: true })
  })

  it('脏值归一：非法档位回 standard，非 true 一律视为 false，非对象回 undefined', () => {
    // 开关生效 + 非法档位 → 归一到 standard，且因为 enabled 仍非默认而落盘
    expect(normalizeMediaStab({ enabled: true, level: 'ultra', tripod: 1 })).toEqual({
      enabled: true,
      level: 'standard',
      tripod: false
    })
    // 全部脏值归一后落到默认值 → 整键不落盘
    expect(normalizeMediaStab({ enabled: 'yes', level: 'ultra', tripod: 1 })).toBeUndefined()
    expect(normalizeMediaStab(null)).toBeUndefined()
    expect(normalizeMediaStab('stab')).toBeUndefined()
    expect(normalizeMediaStab([{ enabled: true }])).toBeUndefined()
  })

  it('isDefaultMediaStab：undefined 与全默认对象都算默认', () => {
    expect(isDefaultMediaStab(undefined)).toBe(true)
    expect(isDefaultMediaStab(stab())).toBe(true)
    expect(isDefaultMediaStab(stab({ enabled: true }))).toBe(false)
  })
})

describe('档位 → vidstab 滤镜参数', () => {
  it('STAB_LEVELS 覆盖三档且与文案档位一一对应', () => {
    expect(STAB_LEVELS).toEqual(['low', 'standard', 'high'])
  })

  it('单调性：档位越高，shakiness/accuracy/smoothing/zoomspeed 越激进', () => {
    const byLevel = STAB_LEVELS.map((level) => ({
      detect: stabDetectProfile(stab({ enabled: true, level })),
      transform: stabTransformProfile(stab({ enabled: true, level }))
    }))
    const shakiness = byLevel.map((p) => p.detect.shakiness)
    const accuracy = byLevel.map((p) => p.detect.accuracy)
    const smoothing = byLevel.map((p) => p.transform.smoothing)
    const zoomspeed = byLevel.map((p) => p.transform.zoomspeed)
    expect([...shakiness].sort((a, b) => a - b)).toEqual(shakiness)
    expect([...accuracy].sort((a, b) => a - b)).toEqual(accuracy)
    expect([...smoothing].sort((a, b) => a - b)).toEqual(smoothing)
    expect([...zoomspeed].sort((a, b) => a - b)).toEqual(zoomspeed)
    // 严格递增：档位之间必须真的不同，否则 UI 上就是摆设
    expect(new Set(shakiness).size).toBe(3)
    expect(new Set(smoothing).size).toBe(3)
  })

  it('画幅口径固定：optzoom=2 动态最优缩放 + crop=keep 无边框 + bicubic', () => {
    for (const level of STAB_LEVELS) {
      const p = stabTransformProfile(stab({ enabled: true, level }))
      expect(p.optzoom).toBe(2)
      expect(p.optalgo).toBe('opt')
      expect(p.crop).toBe('keep')
      expect(p.interpol).toBe('bicubic')
    }
  })

  it('detect 参数在滤镜合法区间内（shakiness 1–10、accuracy 1–15 且 ≥shakiness）', () => {
    for (const level of STAB_LEVELS) {
      const p = stabDetectProfile(stab({ enabled: true, level }))
      expect(p.shakiness).toBeGreaterThanOrEqual(1)
      expect(p.shakiness).toBeLessThanOrEqual(10)
      expect(p.accuracy).toBeGreaterThanOrEqual(p.shakiness)
      expect(p.accuracy).toBeLessThanOrEqual(15)
    }
  })

  it('三脚架（v8.2）：detect 不再给绝对参考帧；transform 走静态超长平滑，绝不用 vidstab tripod 宏', () => {
    // detect 恒相对（tripod=0）：与 transform relative=1 口径一致，否则绝对位移会被当帧间增量误读
    expect(stabDetectProfile(stab({ enabled: true, tripod: true })).tripod).toBe(0)
    const t = stabTransformProfile(stab({ enabled: true, tripod: true }))
    expect(t.mode).toBe('tripod')
    expect(t.optzoom).toBe(1) // 静态最优缩放，无逐帧变倍脉动
    expect(t.smoothing).toBeGreaterThanOrEqual(60) // 超长窗低通钉死机位
    expect(t.crop).toBe('keep')
    // 非三脚架仍是逐帧动态最优
    expect(stabTransformProfile(stab({ enabled: true })).mode).toBe('smooth')
    expect(stabTransformProfile(stab({ enabled: true })).optzoom).toBe(2)
  })
})

/**
 * v8.1 预览代理纯函数：坐标换算/签名/令牌/文件名。
 * 主进程与渲染进程共用这些函数——任何行为差异都会让代理错位或缓存永不命中。
 */
describe('防抖预览代理（v8.1）', () => {
  const fps30: Fps = { num: 30, den: 1 }
  const sigInput = {
    sourcePath: 'D:/media/a.mp4',
    sourceInSec: 2,
    sourceOutSec: 6,
    fps: fps30,
    stab: stab({ enabled: true })
  }

  it('stabProxyTimeOf：代理时间 = 源时间 − 入点；区间外夹紧，不产生负 seek', () => {
    expect(stabProxyTimeOf(3, 2, 6)).toBe(1)
    expect(stabProxyTimeOf(2, 2, 6)).toBe(0)
    expect(stabProxyTimeOf(6, 2, 6)).toBe(4)
    // 拖拽越界/尾帧舍入：夹在 [0, 代理时长]
    expect(stabProxyTimeOf(1.2, 2, 6)).toBe(0)
    expect(stabProxyTimeOf(99, 2, 6)).toBe(4)
    expect(stabProxyTimeOf(Number.NaN, 2, 6)).toBe(0)
  })

  it('签名：区间/帧率/档位/三脚架/源路径任一变化即失效；enabled 不参与（受理前提已校验）', () => {
    const base = stabPreviewSignature(sigInput)
    expect(stabPreviewSignature({ ...sigInput })).toBe(base)
    expect(stabPreviewSignature({ ...sigInput, sourceInSec: 2.5 })).not.toBe(base)
    expect(stabPreviewSignature({ ...sigInput, sourceOutSec: 6.5 })).not.toBe(base)
    expect(stabPreviewSignature({ ...sigInput, fps: { num: 24, den: 1 } })).not.toBe(base)
    expect(stabPreviewSignature({ ...sigInput, stab: stab({ enabled: true, level: 'high' }) })).not.toBe(base)
    expect(stabPreviewSignature({ ...sigInput, stab: stab({ enabled: true, tripod: true }) })).not.toBe(base)
    expect(stabPreviewSignature({ ...sigInput, sourcePath: 'D:/media/b.mp4' })).not.toBe(base)
    // 只改 enabled：签名不变（否则关一下再开就“需重新应用”，而内容其实完全一样）
    expect(stabPreviewSignature({ ...sigInput, stab: stab({ enabled: false }) })).toBe(base)
    // 微小区间抖动（浮点尾差）也要算变化：1e-6 秒精度
    expect(stabPreviewSignature({ ...sigInput, sourceOutSec: 6.000001 })).not.toBe(base)
  })

  it('令牌：同输入同令牌；源大小/mtime 指纹参与（源文件被替换即失效）', () => {
    const sig = stabPreviewSignature(sigInput)
    expect(stabPreviewToken(sig, 1024, 5000)).toBe(stabPreviewToken(sig, 1024, 5000))
    expect(stabPreviewToken(sig, 1025, 5000)).not.toBe(stabPreviewToken(sig, 1024, 5000))
    expect(stabPreviewToken(sig, 1024, 5001)).not.toBe(stabPreviewToken(sig, 1024, 5000))
    expect(stabPreviewToken(sig, 1024, 5000)).toMatch(/^[0-9a-f]{8}$/)
  })

  it('文件名：clipId 前缀可批量回收；非法字符安化为下划线；同令牌同名', () => {
    const a = stabPreviewFileName('mclip-abc', 'deadbeef')
    expect(a.video).toBe('stab-mclip-abc-deadbeef.mp4')
    expect(a.trf).toBe('stab-mclip-abc-deadbeef.trf')
    // 前缀断言与 removeStabPreviewForClip 的 `stab-<safeClip>-` 匹配规则一致
    const nasty = stabPreviewFileName('../evil id', 'deadbeef')
    expect(nasty.video).not.toContain('..')
    expect(nasty.video).not.toContain('/')
    expect(nasty.video.startsWith('stab-')).toBe(true)
  })
})
