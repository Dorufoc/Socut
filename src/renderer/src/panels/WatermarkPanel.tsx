import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { WATERMARK_BASE_RESOLUTION, WATERMARK_DISPLAY_SCALE, WATERMARK_MARGIN_PX } from '@shared/constants'
import { computeWatermarkGeometry } from '@shared/ffmpegArgs'
import type { WatermarkSettings } from '@shared/types'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'
import { Expander } from '../components/ui/Expander'
import { InfoBar } from '../components/ui/InfoBar'

/**
 * 水印面板（左侧 Tab「水印」）。
 *
 * 只做三件事：选一张本机图片（原图尺寸由主进程 ffprobe 探测）→ 开关 / 移除 →
 * 把换算规则讲成人能读懂的数字。真正的滤镜参数在导出时由 `shared/ffmpegArgs`
 * 按**本次输出分辨率**换算，这里只显示同一套公式的结果，绝不写第二份算法。
 *
 * 规则（基准 1080P）：显示尺寸 = 原图 × 32%，距顶部与左侧各 30px，落在左上角；
 * 输出非 1080P 时按 `输出高 / 1080` 等比换算，相对位置与大小保持一致。
 */

type Readiness = 'idle' | 'loading' | 'ready' | 'unavailable'

function geometryOf(settings: WatermarkSettings | null | undefined, width: number, height: number) {
  if (!settings) return null
  return computeWatermarkGeometry(
    { path: settings.path, sourceWidth: settings.sourceWidth, sourceHeight: settings.sourceHeight },
    { width, height }
  )
}

export function WatermarkPanel(): ReactElement {
  const settings = useProjectStore((state) => state.project.watermark)
  const resolution = useProjectStore((state) => state.project.resolution)
  const uiMode = useUiStore((state) => state.uiMode)
  const setNotice = useUiStore((state) => state.setNotice)

  const [url, setUrl] = useState<string | null>(null)
  const [readiness, setReadiness] = useState<Readiness>('idle')
  const [picking, setPicking] = useState(false)

  // 图片与参考视频共用 focusnews-media 协议：主进程校验存在 + 扩展名后才登记可读
  const path = settings?.path ?? null
  useEffect(() => {
    let cancelled = false
    setUrl(null)
    if (!path) {
      setReadiness('idle')
      return
    }
    setReadiness('loading')
    void window.focusnews.video
      .previewUrl(path)
      .then((resolved) => {
        if (cancelled) return
        setUrl(resolved)
        setReadiness(resolved ? 'ready' : 'unavailable')
      })
      .catch(() => {
        if (!cancelled) setReadiness('unavailable')
      })
    return () => {
      cancelled = true
    }
  }, [path])

  const pick = async (): Promise<void> => {
    setPicking(true)
    try {
      const picked = await window.focusnews.watermark.pick()
      if (!picked) return // 用户取消：不改工程
      useProjectStore.getState().setWatermark({
        enabled: true,
        path: picked.path,
        name: picked.name,
        sourceWidth: picked.sourceWidth,
        sourceHeight: picked.sourceHeight,
        importedAt: new Date().toISOString()
      })
      setNotice(`水印已导入：${picked.name}（原图 ${picked.sourceWidth}×${picked.sourceHeight}）`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setPicking(false)
    }
  }

  /** 基准 1080P 与实际工程分辨率两套数字：让用户看见「等比换算」到底换算成了什么 */
  const baseBox = useMemo(() => geometryOf(settings, WATERMARK_BASE_RESOLUTION.width, WATERMARK_BASE_RESOLUTION.height), [settings])
  const outBox = useMemo(() => geometryOf(settings, resolution.width, resolution.height), [settings, resolution.width, resolution.height])
  const percent = Math.round(WATERMARK_DISPLAY_SCALE * 100)

  return (
    <section className="group">
      <div className="group__head">
        <span className="group__title">水印</span>
        <span className={`chip${settings?.enabled ? ' chip--ok' : settings ? ' chip--warn' : ''}`}>
          {settings ? (settings.enabled ? '已启用' : '已停用') : '未导入'}
        </span>
      </div>

      <button type="button" className="btn btn--primary btn--block" disabled={picking} onClick={() => void pick()}>
        {picking ? '读取图片信息…' : settings ? '更换水印图片…' : '导入水印图片…'}
      </button>

      {!settings ? (
        <div className="empty-state">
          <span className="empty-state__glyph" aria-hidden="true">
            ✎
          </span>
          <span>
            还没有水印。导入一张 PNG（建议带透明通道）后，叠加导出会把它放在画面左上角；透明字幕条出口不含水印。
          </span>
        </div>
      ) : (
        <div className="watermark-card">
          <div className={`watermark-card__thumb${readiness === 'unavailable' ? ' watermark-card__thumb--broken' : ''}`}>
            {url ? <img src={url} alt="" draggable={false} /> : <span className="watermark-card__glyph" aria-hidden="true">✎</span>}
          </div>
          <div className="watermark-card__body">
            <span className="watermark-card__name" title={settings.path}>
              {settings.name}
            </span>
            <span className="watermark-card__meta mono">
              原图 {settings.sourceWidth}×{settings.sourceHeight}
            </span>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(event) => useProjectStore.getState().setWatermarkEnabled(event.target.checked)}
              />
              <span>叠加到导出画面</span>
            </label>
            <div className="media-tile__actions">
              <button type="button" className="btn btn--sm btn--danger" onClick={() => {
                useProjectStore.getState().setWatermark(null)
                setNotice('已移除水印')
              }}>
                移除
              </button>
            </div>
          </div>
        </div>
      )}

      {settings && readiness === 'unavailable' ? (
        <InfoBar
          tone="error"
          message="图片当前不可读（已移动、删除或扩展名不支持）。请重新导入，或先关掉开关，否则叠加导出会被拦下。"
        />
      ) : null}

      {baseBox && outBox ? (
        <div className="kv">
          <div className="kv__row">
            <span>基准 1080P</span>
            <span className="mono">
              {baseBox.width}×{baseBox.height} @ ({baseBox.x},{baseBox.y})
            </span>
          </div>
          <div className="kv__row">
            <span>本工程 {resolution.width}×{resolution.height}</span>
            <span className="mono">
              {outBox.width}×{outBox.height} @ ({outBox.x},{outBox.y})
            </span>
          </div>
          <div className="kv__row">
            <span>位置</span>
            <span className="mono">左上角 · 距顶/左 {WATERMARK_MARGIN_PX}px@1080p</span>
          </div>
        </div>
      ) : null}

      <p className="hint">
        显示尺寸恒为原图 {percent}%（按 1080P 定义），输出非 1080P 时按高度比等比换算；
        叠加导出以媒体分辨率为准，因此上表可能比实际画面略大或略小。
      </p>

      {settings && uiMode === 'advanced' ? (
        <Expander title="换算细节" summary="1080P 基准 / 尺寸与边距同源">
          <div className="stack stack--tight">
            <div className="row row--wrap">
              <span className="chip mono">尺寸系数 {WATERMARK_DISPLAY_SCALE}</span>
              <span className="chip mono">边距 {WATERMARK_MARGIN_PX}px</span>
              <span className="chip mono">基准 {WATERMARK_BASE_RESOLUTION.width}×{WATERMARK_BASE_RESOLUTION.height}</span>
            </div>
            <p className="hint">
              滤镜链为 <code>[n:v]format=rgba,scale=W:H[wm]</code> +{' '}
              <code>[vsub][wm]overlay=X:Y</code>，永远叠在字幕条之上；
              调色板 PNG 先转 rgba 以保住透明通道。
            </p>
          </div>
        </Expander>
      ) : null}
    </section>
  )
}
