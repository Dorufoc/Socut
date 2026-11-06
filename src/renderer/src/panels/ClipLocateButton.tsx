import type { ReactElement } from 'react'
import { TEXT } from '@shared/i18n'
import { IconLocate } from '../components/ui/Icon'
import { useUiStore } from '../state/uiStore'

/**
 * 「定位到这一段」（P5）。
 *
 * 为什么需要它：时间轴上点段落现在**只选中、不再跳播放头**（用户明确要求），
 * 于是会出现「右侧在改这一段，预览里却是别的画面」——画面参数改了看不见，
 * 预览里的变换手柄也无处可挂。这里给一个明确入口，而不是偷偷替用户跳。
 *
 * 落点用区间**中点**（与左侧字幕列表同一口径）：中点天然在段内，
 * 不像入点那样正好压在边界上（出点是开区间，边界值容易被判成段外）。
 */

export interface ClipLocateButtonProps {
  /** 本段在时间轴上的入点（秒） */
  startSec: number
  /** 本段在时间轴上的出点（秒，开区间） */
  endSec: number
}

/** 播放头是否落在 [startSec, endSec) 内（出点开区间，与时间轴同一口径） */
export function clipContainsSec(startSec: number, endSec: number, atSec: number): boolean {
  return atSec >= startSec - 1e-9 && atSec < endSec - 1e-9
}

export function ClipLocateButton({ startSec, endSec }: ClipLocateButtonProps): ReactElement | null {
  const displayTime = useUiStore((state) => state.displayTimeSec)
  const playing = useUiStore((state) => state.playing)
  const setPlaying = useUiStore((state) => state.setPlaying)
  const seekHandler = useUiStore((state) => state.seekHandler)

  if (clipContainsSec(startSec, endSec, displayTime)) return null

  const locate = (): void => {
    // 播放中跳过去会被时钟立刻带走，看不出定位效果：先接管时钟（与字幕列表同一口径）
    if (playing) setPlaying(false)
    seekHandler?.((startSec + endSec) / 2)
  }

  return (
    <div className="locate-bar">
      <button type="button" className="btn btn--sm btn--subtle" aria-label={TEXT.inspector.locate} title={TEXT.inspector.locateHint} onClick={locate}>
        <IconLocate size={13} />
        {TEXT.inspector.locate}
      </button>
    </div>
  )
}
