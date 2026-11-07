/**
 * 启动页时间格式化（纯函数，本地时区）。
 *
 * 卡片上的三种时间各有分工：
 * - formatDateTime：创建时间，一眼能认出的「哪天几点」；
 * - formatRelative：修改时间，最近用相对说法，久远后回落日期；
 * - formatFull：title 属性里的完整时间，不占版面但可查。
 */

const INVALID = '—'

function parseIso(iso: string): Date | null {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return null
  return new Date(time)
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0')
}

function datePart(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function timePart(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** `YYYY-MM-DD HH:mm`（本地时区）；非法输入 → `—`。 */
export function formatDateTime(iso: string): string {
  const date = parseIso(iso)
  if (!date) return INVALID
  return `${datePart(date)} ${timePart(date)}`
}

/**
 * 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 HH:mm / YYYY-MM-DD。
 * 未来时间（时钟回拨、主进程写入误差）一律按「刚刚」处理，不显示负数。
 */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const date = parseIso(iso)
  if (!date) return INVALID
  const diff = now - date.getTime()
  if (!Number.isFinite(diff) || diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`

  const nowDate = new Date(now)
  const yesterday = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - 1)
  if (sameDay(date, yesterday)) return `昨天 ${timePart(date)}`
  return datePart(date)
}

/** `YYYY-MM-DD HH:mm:ss`（本地时区），用于 title 属性；非法输入 → `—`。 */
export function formatFull(iso: string): string {
  const date = parseIso(iso)
  if (!date) return INVALID
  return `${datePart(date)} ${timePart(date)}:${pad(date.getSeconds())}`
}
