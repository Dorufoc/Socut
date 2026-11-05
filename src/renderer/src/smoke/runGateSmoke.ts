import { createDefaultProject } from '@shared/projectSchema'
import { detectCompat } from '@shared/probe'
import type { GateCase, GateOutcome, SmokeReport } from '@shared/api'
import type { CompatFlags, MediaItem, VideoMeta } from '@shared/types'
import { importMediaWith } from '../hooks/useVideoImport'
import { useProjectStore } from '../state/projectStore'
import { gateBlocked, useUiStore, type DialogAnswer, type DialogPrompt } from '../state/uiStore'

/**
 * 门禁端到端取证（验收第 5/6 条 + 计划 §7）。
 *
 * 走的是**生产同一条路径**：`importMediaWith`（从 useVideoImport 拆出的门禁主体），
 * 模态应答也复用 CompatModal 按钮做的同一动作（resolve + shiftPrompt）。
 * 因此这里断言的就是用户真正会看到的行为，不是平行模拟。
 *
 * v2：确认位在枚级——导入落进素材池（MediaItem），门禁断言逐枚跑；
 * 取消轮次要求素材池保持干净，确认轮次要求写入后 gateBlocked 放行。
 *
 * 事实交给主进程独立校验（尤其 CFR 产物要用 ffprobe 复测），这里只负责如实上报。
 */

const FIXTURES = {
  portrait: 'portrait.mp4',
  hdr: 'hdr.mp4',
  vfr: 'vfr.mp4'
} as const

type FixtureKey = keyof typeof FIXTURES

const EXPECTED: Record<FixtureKey, { kind: string; why: string }> = {
  portrait: { kind: 'non169', why: '9:16 显示宽高比应先触发非 16:9 模态' },
  hdr: { kind: 'hdr', why: 'bt2020 + smpte2084 应触发 HDR 模态' },
  vfr: { kind: 'vfr', why: 'VFR 素材应给出三选项模态' }
}

function resetProject(): void {
  useProjectStore.getState().loadProject(createDefaultProject('gate-smoke'))
  // 模态队列必须清空，否则上一个用例的残留会串到下一个
  useUiStore.setState({ dialogQueue: [] })
}

/** 等待模态入队（生产里由用户点击，这里由取证代答）。 */
async function waitPrompt(timeoutMs = 8000): Promise<DialogPrompt | null> {
  const startedAt = performance.now()
  for (;;) {
    const prompt = useUiStore.getState().dialogQueue[0]
    if (prompt) return prompt
    if (performance.now() - startedAt > timeoutMs) return null
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
}

/** 与 CompatModal 的按钮完全一致：兑现 promise 并把该条从队列移出。 */
function answerPrompt(prompt: DialogPrompt, value: DialogAnswer): void {
  prompt.resolve(value)
  useUiStore.getState().shiftPrompt()
}

interface DriveResult {
  kind: string | null
  flags: CompatFlags
  meta: VideoMeta
  refPath: string | null
  vfrPolicy: string | null
  sourcePath: string | null
  /** 写入素材池的那枚（确认轮次才有） */
  media: MediaItem | null
  /** 取消轮次：素材池必须保持干净 */
  poolSize: number
}

async function driveOnce(fixtureDir: string, file: string, decision: DialogAnswer): Promise<DriveResult> {
  resetProject()
  const absolute = `${fixtureDir.replace(/[\\/]+$/, '')}/${file}`
  const probe = await window.focusnews.video.probe(absolute)
  if (!probe) throw new Error(`夹具探测失败：${absolute}（先跑 npm run make:fixtures）`)
  const flags = probe.flags
  const pending = importMediaWith({ path: absolute, probe })
  const prompt = await waitPrompt()
  if (prompt) answerPrompt(prompt, decision)
  const outcome = await pending
  const state = useProjectStore.getState()
  const media = outcome.mediaId ? (state.project.media.find((m) => m.id === outcome.mediaId) ?? null) : null
  return {
    kind: prompt?.dialog.kind ?? null,
    flags,
    meta: probe.meta,
    // 「转换并导入」后编辑用路径是 CFR 产物；取证断言的是导入口径
    refPath: outcome.cancelled ? null : (outcome.cfrPath ?? outcome.path),
    vfrPolicy: outcome.cancelled ? null : outcome.vfrPolicy,
    sourcePath: outcome.cancelled ? null : outcome.sourcePath,
    media,
    poolSize: state.project.media.length
  }
}

/** 未确认状态的探针：用夹具 meta 造一枚 ack 全假的素材，断言 gateBlocked 必阻断。 */
function unackedProbe(file: string, meta: VideoMeta): MediaItem {
  return {
    id: `gate-probe-${file}`,
    path: `fixture/${file}`,
    name: file,
    meta,
    non169Ack: false,
    hdrAck: false,
    vfrPolicy: 'none',
    compactMode: 'auto',
    thumbnailUrl: '',
    importedAt: ''
  }
}

export async function runGateSmoke(fixtureDir: string): Promise<GateOutcome> {
  const cases: GateCase[] = []
  const failures: string[] = []
  let cfrOutputPath: string | null = null

  for (const key of Object.keys(FIXTURES) as FixtureKey[]) {
    const file = FIXTURES[key]
    const expected = EXPECTED[key]

    // 1) 取消：模态必须出现，且素材池不得写入
    const cancelled = await driveOnce(fixtureDir, file, 'cancel')
    const unacked = gateBlocked([unackedProbe(file, cancelled.meta)])
    if (cancelled.kind !== expected.kind) {
      failures.push(`${file}：${expected.why}，实际弹出 ${String(cancelled.kind)}`)
    }
    if (cancelled.refPath !== null) {
      failures.push(`${file}：选择「取消」仍写入了参考视频（${cancelled.refPath}）`)
    }
    if (cancelled.poolSize !== 0) {
      failures.push(`${file}：选择「取消」后素材池不为空（${cancelled.poolSize} 枚）`)
    }
    if (!unacked.blocked) failures.push(`${file}：未确认时 gateBlocked 为 false，导出按钮不会被禁用`)

    // 2) 确认：VFR 走「转换并导入」（顺带取证验收第 6 条），其余走「我已了解」
    const ackDecision: DialogAnswer = key === 'vfr' ? 'convert' : 'ok'
    const acked = await driveOnce(fixtureDir, file, ackDecision)
    const caseResult: GateCase = {
      fixture: file,
      expectedKind: expected.kind,
      appearedKind: acked.kind,
      flags: acked.flags,
      blockedBeforeAck: unacked.blocked,
      blockedReason: unacked.reason,
      refAfterCancel: cancelled.refPath,
      refAfterAck: acked.refPath,
      vfrPolicyAfterAck: acked.vfrPolicy,
      sourcePathAfterAck: acked.sourcePath,
      blockedAfterAck: true
    }
    if (acked.kind !== expected.kind) {
      failures.push(`${file}：确认轮次模态种类不符（期望 ${expected.kind}，实际 ${String(acked.kind)}）`)
    }
    if (acked.refPath === null) {
      failures.push(`${file}：确认后仍未写入参考视频`)
    } else if (key === 'vfr') {
      cfrOutputPath = acked.refPath
      if (acked.vfrPolicy !== 'converted') {
        failures.push(`vfr：vfrPolicy 应为 converted，实际 ${String(acked.vfrPolicy)}`)
      }
      if (acked.sourcePath === null) failures.push('vfr：应保留原始路径 sourcePath')
    }

    // 枚级断言：确认写入的那枚自身必须放行（兼容 v1：没写池子时回看旧 refVideo）
    const pool = useProjectStore.getState().project.media
    const refVideo = useProjectStore.getState().project.refVideo
    if (acked.media) {
      const afterAck = gateBlocked([acked.media])
      caseResult.blockedAfterAck = afterAck.blocked
      if (afterAck.blocked) failures.push(`${file}：确认后门禁仍阻断（${String(afterAck.reason)}）`)
      if (key === 'vfr' && detectCompat(acked.media.meta).vfr) {
        failures.push('vfr：转换后的文件仍被判定为 VFR（验收第 6 条）')
      }
    } else if (refVideo) {
      const afterAck = gateBlocked([
        {
          id: 'legacy-ref',
          path: refVideo.path,
          name: file,
          meta: refVideo.meta,
          non169Ack: refVideo.non169Ack,
          hdrAck: refVideo.hdrAck,
          vfrPolicy: refVideo.vfrPolicy,
          compactMode: refVideo.compactMode,
          thumbnailUrl: '',
          importedAt: refVideo.importedAt
        }
      ])
      caseResult.blockedAfterAck = afterAck.blocked
      if (afterAck.blocked) failures.push(`${file}：确认后门禁仍阻断（${String(afterAck.reason)}）`)
      if (key === 'vfr' && detectCompat(refVideo.meta).vfr) {
        failures.push('vfr：转换后的文件仍被判定为 VFR（验收第 6 条）')
      }
    } else if (pool.length === 0 && acked.refPath !== null) {
      failures.push(`${file}：确认后素材池为空但导入声称成功（未写入 MediaItem）`)
    }
    cases.push(caseResult)
  }

  resetProject()
  return { cases, cfrOutputPath, failures }
}

/** 上报用的附加字段（主进程据此独立复测 CFR 产物）。 */
export function gateReportFields(outcome: GateOutcome): Pick<SmokeReport, 'gate'> {
  return { gate: outcome }
}
