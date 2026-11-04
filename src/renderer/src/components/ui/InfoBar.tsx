import type { ReactElement, ReactNode } from 'react'

/** WinUI 3 InfoBar：状态提示条，error 会以 alert 角色播报。 */

export type InfoBarTone = 'info' | 'success' | 'warning' | 'error'

const GLYPH: Record<InfoBarTone, string> = {
  info: 'i',
  success: '✓',
  warning: '!',
  error: '✕'
}

export interface InfoBarProps {
  tone?: InfoBarTone
  message: ReactNode
  action?: ReactNode
  onDismiss?: () => void
  dismissLabel?: string
}

export function InfoBar({ tone = 'info', message, action, onDismiss, dismissLabel = '关闭' }: InfoBarProps): ReactElement {
  return (
    <div className={`infobar infobar--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span className="infobar__glyph" aria-hidden="true">
        {GLYPH[tone]}
      </span>
      <span className="infobar__message">{message}</span>
      {action}
      {onDismiss ? (
        <button type="button" className="infobar__close" aria-label={dismissLabel} title={dismissLabel} onClick={onDismiss}>
          ✕
        </button>
      ) : null}
    </div>
  )
}
