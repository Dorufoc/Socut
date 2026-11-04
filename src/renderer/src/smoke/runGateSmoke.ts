import { createDefaultProject } from '@shared/projectSchema'
import { detectCompat } from '@shared/probe'
import type { GateCase, GateOutcome, SmokeReport } from '@shared/api'
import type { CompatFlags } from '@shared/types'
import { importRefVideoWith } from '../hooks/useVideoImport'
import { useProjectStore } from '../state/projectStore'
import { gateBlocked, useUiStore, type DialogAnswer, type DialogPrompt } from '../state/uiStore'

/**
 * 门禁端到端取证（验收第 5/6 条 + 计划 §7）。
 *
 * 走的是**生产同一条路径**：`importRefVideoWith`（从 useVideoImport 拆出的门禁主体），
 * 模态应答也复用 CompatModal 按钮做的同一动作（resolve + shiftPrompt）。
 * 因此这里断言的就是用户真正会看到的行为，不是平行模拟。
 *
 * 断言两件事：
 *  1) 触发：非 16:9 / HDR / VFR 各自弹出对应模态；
 *  2) 阻断：未确认时 gateBlocked 为真（导出按钮因此禁用），选「取消」则工程里不写入参考视频。
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
  refPath: string | null
  vfrPolicy: string | null
  sourcePath: string | null
}

async function driveOnce(fixtureDir: string, file: string, decision: DialogAnswer): Promise<DriveResult> {
  resetProject()
  const absolute = `${fixtureDir.replace(/[\\/]+$/, '')}/${file}`
  const probe = await window.focusnews.video.probe(absolute)
  if (!probe) throw new Error(`夹具探测失败：${absolute}（先跑 npm run make:fixtures）`)
  const flags = probe.flags
  const pending = importRefVideoWith({ path: absolute, probe })
  const prompt = await waitPrompt()
  if (prompt) answerPrompt(prompt, decision)
  await pending
  const ref = useProjectStore.getState().project.refVideo
  return {
    kind: prompt?.dialog.kind ?? null,
    flags,
    refPath: ref?.path ?? null,
    vfrPolicy: ref?.vfrPolicy ?? null,
    sourcePath: ref?.sourcePath ?? null
  }
}

export async function runGateSmoke(fixtureDir: string): Promise<GateOutcome> {
  const cases: GateCase[] = []
  const failures: string[] = []
  let cfrOutputPath: string | null = null

  for (const key of Object.keys(FIXTURES) as FixtureKey[]) {
    const file = FIXTURES[key]
    const expected = EXPECTED[key]

    // 1) 取消：模态必须出现，且工程里不得写入参考视频
    const cancelled = await driveOnce(fixtureDir, file, 'cancel')
    const unacked = gateBlocked(cancelled.flags, { non169: false, hdr: false, vfrResolved: false })
    if (cancelled.kind !== expected.kind) {
      failures.push(`${file}：${expected.why}，实际弹出 ${String(cancelled.kind)}`)
    }
    if (cancelled.refPath !== null) {
      failures.push(`${file}：选择「取消」仍写入了参考视频（${cancelled.refPath}）`)
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

    const refVideo = useProjectStore.getState().project.refVideo
    if (refVideo) {
      const afterAck = gateBlocked(detectCompat(refVideo.meta), {
        non169: refVideo.non169Ack,
        hdr: refVideo.hdrAck,
        vfrResolved: refVideo.vfrPolicy !== 'none'
      })
      caseResult.blockedAfterAck = afterAck.blocked
      if (afterAck.blocked) failures.push(`${file}：确认后门禁仍阻断（${String(afterAck.reason)}）`)
      if (key === 'vfr' && detectCompat(refVideo.meta).vfr) {
        failures.push('vfr：转换后的文件仍被判定为 VFR（验收第 6 条）')
      }
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
