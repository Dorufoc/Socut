import type { ReactElement } from 'react'
import { TEXT } from '@shared/i18n'
import { useUiStore, type DialogAnswer, type DialogPrompt } from '../state/uiStore'

/**
 * 阻断式模态（规格 §6）。
 * 非 16:9 / HDR：必须点「我已了解」才能继续，点「取消」终止导入；
 * VFR：三选项（转换并导入 / 直接导入 / 取消）。
 */

function answer(prompt: DialogPrompt, value: DialogAnswer): void {
  prompt.resolve(value)
  useUiStore.getState().shiftPrompt()
}

export function CompatModal(): ReactElement | null {
  const queue = useUiStore((state) => state.dialogQueue)
  const prompt = queue[0]
  if (!prompt) return null
  const dialog = prompt.dialog

  let title = ''
  let body = ''
  let actions: Array<{ label: string; value: DialogAnswer; primary?: boolean; danger?: boolean }> = []

  switch (dialog.kind) {
    case 'non169':
      title = TEXT.modalNon169.title
      body = dialog.label
      actions = [
        { label: TEXT.modalNon169.cancel, value: 'cancel' },
        { label: TEXT.modalNon169.confirm, value: 'ok', primary: true }
      ]
      break
    case 'hdr':
      title = TEXT.modalHdr.title
      body = dialog.label
      actions = [
        { label: TEXT.modalHdr.cancel, value: 'cancel' },
        { label: TEXT.modalHdr.confirm, value: 'ok', primary: true }
      ]
      break
    case 'vfr':
      title = TEXT.modalVfr.title
      body = dialog.label
      actions = [
        { label: TEXT.modalVfr.cancel, value: 'cancel' },
        { label: TEXT.modalVfr.raw, value: 'raw' },
        { label: TEXT.modalVfr.convert, value: 'convert', primary: true }
      ]
      break
    case 'vfrSecondConfirm':
      title = TEXT.modalVfr.secondConfirmTitle
      body = dialog.label
      actions = [
        { label: TEXT.modalNon169.cancel, value: 'cancel' },
        { label: '继续导出', value: 'ok', primary: true }
      ]
      break
    case 'hugeExport':
      title = TEXT.modalHugeExport.title
      body = `${dialog.label}\n${dialog.detail}`
      actions = [
        { label: TEXT.modalHugeExport.cancel, value: 'cancel' },
        ...(dialog.allowPng ? [{ label: TEXT.modalHugeExport.usePng, value: 'png' as DialogAnswer }] : []),
        {
          label: dialog.allowPng ? TEXT.modalHugeExport.useMov : '继续（直接管道合成）',
          value: 'mov' as DialogAnswer,
          primary: true
        }
      ]
      break
    case 'confirm':
      title = dialog.title
      body = dialog.body
      actions = [
        { label: TEXT.modalNon169.cancel, value: 'cancel' },
        { label: dialog.confirmText ?? '确认', value: 'ok', primary: true }
      ]
      break
    default:
      return null
  }

  return (
    <div className="modal-mask" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal">
        <div className="modal__title">{title}</div>
        <div className="modal__body" style={{ whiteSpace: 'pre-wrap' }}>
          {body}
        </div>
        <div className="modal__actions">
          {actions.map((action) => (
            <button
              key={action.value}
              className={`btn${action.primary ? ' btn--primary' : ''}${action.danger ? ' btn--danger' : ''}`}
              onClick={() => answer(prompt, action.value)}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
