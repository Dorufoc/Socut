import { useId, useState, type ReactElement, type ReactNode } from 'react'

/**
 * WinUI 3 Expander。
 * 标题行常驻，内容默认收起；用 grid-template-rows 0fr → 1fr 做高度过渡，
 * 不测量 DOM、不依赖动画结束回调，折叠时内容仍保留状态（输入不会丢）。
 */
export interface ExpanderProps {
  title: string
  /** 收起时也可见的关键信息摘要（如「4 项」「等宽数字」） */
  summary?: string
  /** 高级功能标签，帮助用户判断「现在不需要点开」 */
  advanced?: boolean
  defaultOpen?: boolean
  children: ReactNode
  className?: string
}

export function Expander({
  title,
  summary,
  advanced = false,
  defaultOpen = false,
  children,
  className = ''
}: ExpanderProps): ReactElement {
  const [open, setOpen] = useState(defaultOpen)
  const panelId = useId()

  return (
    <section className={`expander${open ? ' expander--open' : ''}${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        className="expander__header"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <svg className="expander__chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path
            d="M4.5 2.5 8 6l-3.5 3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="expander__title">{title}</span>
        {advanced ? <span className="expander__badge">可选</span> : null}
        {summary ? <span className="expander__summary">{summary}</span> : null}
      </button>
      <div className="expander__body" id={panelId}>
        <div className="expander__inner">
          <div className="expander__content">{children}</div>
        </div>
      </div>
    </section>
  )
}
