import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Expander } from './Expander'

/**
 * WinUI Expander 的两个可见契约：
 * 1) 默认收起（高级/低频内容不会在首屏铺开）；
 * 2) 标题行是唯一开关，点击即可展开、再点收起。
 */

afterEach(() => cleanup())

describe('Expander（折叠区）', () => {
  it('默认收起，内容仍挂载（折叠不该丢失输入状态）', () => {
    render(<Expander title="配色">配色内容</Expander>)
    const header = screen.getByRole('button', { name: /配色/ })
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(header.parentElement?.className).not.toContain('expander--open')
    expect(screen.getByText('配色内容')).toBeTruthy()
  })

  it('点击标题展开、再次点击收起，摘要常驻标题行', () => {
    render(
      <Expander title="字体" summary="3 个可用">
        字体内容
      </Expander>
    )
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button').parentElement?.className).toContain('expander--open')
    expect(screen.getByText('3 个可用')).toBeTruthy()

    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
  })
})
