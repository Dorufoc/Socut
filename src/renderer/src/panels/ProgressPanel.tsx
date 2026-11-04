import type { ReactElement } from 'react'
import { useState } from 'react'
import { PHASE_LABEL, TEXT } from '@shared/i18n'
import { maskArgument } from '@shared/redact'
import { formatBytes } from '@shared/sizeEstimate'
import { useExportStore } from '../state/exportStore'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'
import { useExportJob } from '../hooks/useExportJob'
import { Expander } from '../components/ui/Expander'

/** 进度面板：阶段、百分比、已交付帧、写入字节、提示与错误尾部（规格 §3.1 / §5.3）。 */

export function ProgressPanel(): ReactElement | null {
  const jobs = useExportStore((state) => state.jobs)
  const order = useExportStore((state) => state.order)
  const clearFinished = useExportStore((state) => state.clearFinished)
  const projectName = useProjectStore((state) => state.project.name)
  const uiMode = useUiStore((state) => state.uiMode)

  const list = order.map((id) => jobs[id]).filter((job): job is NonNullable<typeof job> => job !== undefined)

  if (list.length === 0) {
    // 基础模式下空任务卡只是噪音：没有任务就完全不占位
    if (uiMode === 'basic') return null
    return (
      <section className="group">
        <div className="group__head">
          <span className="group__title">任务进度</span>
          <span className="group__hint">{projectName || '未命名工程'}</span>
        </div>
        <p className="hint">暂无任务。导出后可在这里查看逐帧进度与取消入口。</p>
      </section>
    )
  }

  return (
    <section className="group">
      <div className="group__head">
        <span className="group__title">任务进度</span>
        <button type="button" className="btn btn--sm btn--subtle" onClick={clearFinished}>
          清除已完成
        </button>
      </div>
      <div className="job-list">
        {list.map((job) => {
          const terminal = job.phase === 'done' || job.phase === 'failed' || job.phase === 'cancelled'
          return (
            <div className={`job-card${terminal ? ' job-card--terminal' : ''}`} key={job.jobId}>
              <div className="job-card__head">
                <span className="job-card__id mono">{job.jobId}</span>
                <span
                  className={`chip${job.phase === 'failed' ? ' chip--danger' : job.phase === 'done' ? ' chip--ok' : ''}`}
                >
                  {PHASE_LABEL[job.phase] ?? job.phase}
                </span>
              </div>
              <div className="progress-bar">
                <div
                  className={`progress-bar__fill${job.phase === 'failed' ? ' progress-bar__fill--danger' : ''}`}
                  style={{ width: `${Math.round(job.percent * 100)}%` }}
                />
              </div>
              <div className="job-card__stats">
                <span className="mono">
                  {job.framesDone}/{job.framesTotal} 帧
                </span>
                <span className="mono">{Math.round(job.percent * 100)}%</span>
                <span className="mono muted">{formatBytes(job.bytesWritten)}</span>
                <span className="mono muted">{(job.elapsedMs / 1000).toFixed(1)}s</span>
              </div>
              {job.notices.length > 0 ? <div className="notice-list">{job.notices.join('；')}</div> : null}
              {!terminal ? (
                <button
                  type="button"
                  className="btn btn--sm btn--danger"
                  onClick={() => void window.focusnews.export.cancel(job.jobId)}
                >
                  {TEXT.export.cancel}
                </button>
              ) : null}
            </div>
          )
        })}
      </div>
    </section>
  )
}

/** 最近一次结果（错误尾部 + 完整命令行 + 重试入口，计划 M4-2 / 规格 §9）。 */
export function LastResultPanel(): ReactElement | null {
  const lastResult = useExportStore((state) => state.lastResult)
  const lastInput = useExportStore((state) => state.lastInput)
  const setNotice = useUiStore((state) => state.setNotice)
  const { retryLast } = useExportJob()
  const [maskPaths, setMaskPaths] = useState(false)
  if (!lastResult) return null
  return (
    <section className="group">
      <div className="group__head">
        <span className="group__title">最近结果</span>
        <span className={`chip ${lastResult.ok ? 'chip--ok' : 'chip--danger'}`}>{lastResult.ok ? '成功' : '失败'}</span>
      </div>
      {lastResult.ok ? (
        <div className="stack stack--tight">
          {lastResult.outputs.map((output) => (
            <div className="list-row" key={output}>
              <span className="list-row__name mono" title={output}>
                {output}
              </span>
              <button type="button" className="btn btn--sm" onClick={() => void window.focusnews.app.revealPath(output)}>
                {TEXT.export.reveal}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="stack">
          <div className="progress-item__error">
            {lastResult.error ? `${lastResult.error.code} · ${lastResult.error.message}` : '失败'}
            {lastResult.error?.stderrTail ? `\n\n${lastResult.error.stderrTail}` : ''}
          </div>
          {/* 规格 §9：失败时除了 stderr 尾部，还要**附上完整命令行**（之前 argv 被采集了但从未展示） */}
          {lastResult.error?.argv && lastResult.error.argv.length > 0 ? (
            <Expander title={`完整命令行（${lastResult.error.argv.length} 段）`} summary="可选中复制">
              <div className="stack stack--tight">
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={maskPaths}
                    onChange={(event) => setMaskPaths(event.target.checked)}
                  />
                  <span>脱敏本机路径</span>
                </label>
                <pre className="argv-block mono">
                  {lastResult.error.argv.map((arg) => (maskPaths ? maskArgument(arg) : arg)).join(maskPaths ? ' ' : '\n')}
                </pre>
              </div>
            </Expander>
          ) : null}
          {lastResult.error?.code !== 'CANCELLED' && lastInput !== null ? (
            <button
              type="button"
              className="btn btn--sm"
              onClick={async () => {
                try {
                  const jobId = await retryLast()
                  if (jobId) setNotice(`已重新发起导出 ${jobId}`)
                  else setNotice('无可重读的导出参数，请在导出面板重新设置')
                } catch (error) {
                  setNotice(`重试失败：${error instanceof Error ? error.message : String(error)}`)
                }
              }}
            >
              重试上一次导出
            </button>
          ) : null}
        </div>
      )}
    </section>
  )
}
