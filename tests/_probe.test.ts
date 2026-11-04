import { describe, it } from 'vitest'
import { PRESETS } from '@shared/presets'
import { buildProjectPlan } from '@shared/presetResolver'
import { createClip, createDefaultProject } from '@shared/projectSchema'
import { BUILTIN_FONTS, FPS_30 } from '@shared/constants'
import { computeClipBoxes } from '../src/renderer/src/render/layoutTree'
import type { FontRecord, Project } from '@shared/types'

const FONT_INDEX: FontRecord[] = BUILTIN_FONTS.map((meta) => ({
  ...meta,
  source: 'builtin',
  bytes: 1024,
  sha1: '',
  importedAt: '2026-01-01T00:00:00.000Z'
}))

function projectWith(presetId: string, title: string, subtitle: string): Project {
  const base = createDefaultProject('probe')
  const clip = createClip({ startTime: 0, fps: FPS_30 })
  clip.presetId = presetId as never
  clip.content = { title, subtitle }
  return { ...base, clips: [clip], fonts: FONT_INDEX }
}

describe('layout probe', () => {
  it('prints', async () => {
    for (const preset of PRESETS) {
      for (const [label, title, subtitle] of [
        ['short', '新规发布', '本台记者'],
        ['mid', '长三角一体化新规发布', '省发展改革委负责人解读'],
        ['long', '长三角一体化发展新规今日正式对外发布并即日起施行', '省发展改革委负责人表示新规将覆盖交通能源与数据要素三大领域']
      ] as const) {
        const project = projectWith(preset.id, title, subtitle)
        const plan = buildProjectPlan({
          project,
          resolution: { width: 1920, height: 1080 },
          fps: FPS_30,
          scope: { kind: 'timeline' },
          fontIndex: FONT_INDEX
        })
        const boxes = await computeClipBoxes(plan.clips[0]!)
        const b = boxes.find((x) => x.role === 'primaryBar')!
        const sb = boxes.find((x) => x.role === 'secondaryBar')
        const t = boxes.find((x) => x.role === 'title')!
        const s = boxes.find((x) => x.role === 'subtitle')!
        console.log(
          `${preset.id}/${label} bar=${b.x},${b.y},${b.w},${b.h} title=${t.x},${t.y},${t.w},${Math.round(t.h)} sz=${t.text?.sizePx} sub=${s.x},${s.y},${s.w},${Math.round(s.h)} sz=${s.text?.sizePx}${sb ? ` subBar=${sb.x},${sb.y},${sb.w},${sb.h}` : ''}`
        )
      }
    }
  })
})
