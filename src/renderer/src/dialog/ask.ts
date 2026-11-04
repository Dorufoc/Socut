import { TEXT } from '@shared/i18n'
import { useUiStore, type CompatDialogContent, type DialogAnswer, type DialogPrompt } from '../state/uiStore'

/** 模态询问（规格 §6：非 16:9 / HDR 为阻断式，未确认不可继续）。 */

let sequence = 0

export function ask(dialog: CompatDialogContent): Promise<DialogAnswer> {
  return new Promise<DialogAnswer>((resolve) => {
    const prompt: DialogPrompt = { id: `dlg-${(sequence += 1)}`, dialog, resolve }
    useUiStore.getState().pushPrompt(prompt)
  })
}

/** 二选一确认：确认返回 true，取消返回 false（取消 = 终止本次操作）。 */
export async function askConfirm(
  title: string,
  body: string,
  confirmText: string = TEXT.modalNon169.confirm
): Promise<boolean> {
  const answer = await ask({ kind: 'confirm', title, body, confirmText })
  return answer === 'ok'
}

export async function askNon169(label: string): Promise<boolean> {
  const answer = await ask({ kind: 'non169', label })
  return answer === 'ok'
}

export async function askHdr(label: string): Promise<boolean> {
  const answer = await ask({ kind: 'hdr', label })
  return answer === 'ok'
}

export async function askVfr(label: string): Promise<DialogAnswer> {
  return ask({ kind: 'vfr', label })
}

export async function askVfrSecondConfirm(label: string): Promise<boolean> {
  const answer = await ask({ kind: 'vfrSecondConfirm', label })
  return answer === 'ok'
}

export async function askHugeExport(
  label: string,
  detail: string,
  options: { allowPng: boolean; diskShort: boolean }
): Promise<DialogAnswer> {
  return ask({ kind: 'hugeExport', label, detail, ...options })
}
