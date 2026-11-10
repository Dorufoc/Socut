/** 输出文件名/目录名的安全化：去掉各平台非法字符，限长，空结果回落到兜底名。 */

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g

export function sanitizeFileName(raw: string, fallback = 'socut'): string {
  const cleaned = raw
    .replace(ILLEGAL, '_')
    .replace(/[. ]+$/g, '')
    .trim()
  return cleaned.length > 0 ? cleaned.slice(0, 80) : fallback
}
