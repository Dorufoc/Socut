import type { ReactElement } from 'react'
import { detectCompat } from '@shared/probe'
import { formatDuration } from '@shared/timecode'
import { TEXT } from '@shared/i18n'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'
import { useVideoImport } from '../hooks/useVideoImport'
import { Expander } from '../components/ui/Expander'

/** 参考视频面板：探测结果只读展示，叠加导出参数一律标注「跟随参考视频」（规格 §2.3）。 */

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

export function RefVideoPanel(): ReactElement {
  const refVideo = useProjectStore((state) => state.project.refVideo)
  const setRefVideo = useProjectStore((state) => state.setRefVideo)
  const setCompactMode = useProjectStore((state) => state.setCompactMode)
  const uiMode = useUiStore((state) => state.uiMode)
  const { importRefVideo } = useVideoImport()

  if (!refVideo) {
    return (
      <section className="group">
        <div className="group__head">
          <span className="group__title">参考视频</span>
          <span className="chip">未导入</span>
        </div>
        <div className="empty-state">
          <span className="empty-state__glyph" aria-hidden="true">
            ▶
          </span>
          <span>未导入时只支持透明字幕条导出；导入后可预览叠加并压制输出 MP4。</span>
        </div>
        <button type="button" className="btn btn--block" onClick={() => void importRefVideo()}>
          导入 MP4 / MOV
        </button>
      </section>
    )
  }

  const flags = detectCompat(refVideo.meta)
  const meta = refVideo.meta

  return (
    <section className="group">
      <div className="group__head">
        <span className="group__title">参考视频</span>
        <span className="chip chip--ok">跟随</span>
      </div>

      <div className="media-card">
        <span className="media-card__glyph" aria-hidden="true">
          ▶
        </span>
        <span className="media-card__body">
          <span className="media-card__name" title={refVideo.path}>
            {baseName(refVideo.path)}
          </span>
          <span className="media-card__meta mono">
            {meta.width}×{meta.height} · {formatDuration(meta.durationSec)} · r {meta.rFrameRate.num}/{meta.rFrameRate.den}
          </span>
        </span>
      </div>

      <div className="row row--wrap">
        {uiMode === 'advanced' ? (
          <>
            <span className="chip">{meta.pixFmt}</span>
            <span className="chip">{meta.videoCodec}</span>
            <span className="chip">{meta.audioCodec ?? '无音轨'}</span>
            {flags.non169 ? <span className="chip chip--warn">非 16:9（已确认）</span> : null}
            {flags.hdr ? <span className="chip chip--warn">HDR → SDR BT.709</span> : null}
            {flags.vfr ? (
              <span className={`chip ${refVideo.vfrPolicy === 'raw' ? 'chip--danger' : 'chip--ok'}`}>
                VFR · {refVideo.vfrPolicy === 'converted' ? '已转 CFR' : refVideo.vfrPolicy === 'raw' ? '保留 VFR' : '未处理'}
              </span>
            ) : null}
            {flags.audioTranscodeNeeded ? <span className="chip chip--warn">音频将转码 AAC 192k</span> : null}
            {flags.noAudio ? <span className="chip">输出无声</span> : null}
          </>
        ) : (
          <>
            <span className="chip mono">avg {meta.avgFrameRate.num}/{meta.avgFrameRate.den}</span>
            {flags.vfr || flags.hdr || flags.non169 ? <span className="chip chip--warn">已确认兼容处理</span> : null}
            {flags.noAudio ? <span className="chip">输出无声</span> : null}
          </>
        )}
      </div>

      <Expander title="技术参数" summary={`${meta.pixFmt} · ${meta.videoCodec}`}>
        <div className="stack">
          <div className="path-line mono" title={refVideo.path}>
            {refVideo.path}
          </div>
          <label className="field">
            <span className="field__label">布局分支</span>
            <select
              className="select"
              value={refVideo.compactMode}
              onChange={(event) => setCompactMode(event.target.value as 'auto' | 'compact' | 'ultrawide' | 'standard')}
            >
              <option value="auto">自动（按显示宽高比）</option>
              <option value="standard">标准 16:9</option>
              <option value="compact">竖屏紧凑</option>
              <option value="ultrawide">超宽上限</option>
            </select>
          </label>
          <div className="row row--wrap">
            <span className="chip mono">avg {meta.avgFrameRate.num}/{meta.avgFrameRate.den}</span>
            <span className="chip mono">显示比 {meta.displayRatio.toFixed(3)}</span>
            {flags.non169 ? <span className="chip chip--warn">非 16:9</span> : null}
            {flags.hdr ? <span className="chip chip--warn">HDR</span> : null}
            {flags.vfr ? <span className="chip chip--warn">VFR</span> : null}
            {flags.audioTranscodeNeeded ? <span className="chip chip--warn">音频转码</span> : null}
          </div>
          <p className="hint">
            {TEXT.export.followRef}：分辨率、帧率、色彩与音频均取自参考视频，导出时按参考参数重新渲染字幕条。
          </p>
        </div>
      </Expander>

      <div className="row">
        <button type="button" className="btn btn--sm" onClick={() => void importRefVideo()}>
          重新导入
        </button>
        <button type="button" className="btn btn--sm btn--danger" onClick={() => setRefVideo(undefined)}>
          移除
        </button>
      </div>
    </section>
  )
}
