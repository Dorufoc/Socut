import { STDERR_PRESENT_CHARS, STDERR_TAIL_BYTES } from '../shared/constants'

/** stderr 环形缓冲（规格 §5.3：必须收集并在失败时输出尾部）。 */
export class StderrTail {
  private chunks: Buffer[] = []
  private totalBytes = 0

  constructor(private readonly capBytes: number = STDERR_TAIL_BYTES) {}

  push(chunk: Buffer | string): void {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    this.chunks.push(buf)
    this.totalBytes += buf.length
    while (this.totalBytes > this.capBytes && this.chunks.length > 0) {
      const overflow = this.totalBytes - this.capBytes
      const first = this.chunks[0]
      if (!first) break
      if (first.length <= overflow) {
        this.chunks.shift()
        this.totalBytes -= first.length
      } else {
        this.chunks[0] = first.subarray(overflow)
        this.totalBytes -= overflow
      }
    }
  }

  pushText(text: string): void {
    this.push(Buffer.from(text, 'utf8'))
  }

  size(): number {
    return this.totalBytes
  }

  /** 失败时展示给用户的尾部（按字符截断，避免多字节切断）。 */
  tail(maxChars: number = STDERR_PRESENT_CHARS): string {
    const text = Buffer.concat(this.chunks).toString('utf8')
    if (text.length <= maxChars) return text
    return `…（已截断，仅保留末尾 ${maxChars} 字符）\n${text.slice(-maxChars)}`
  }

  /** 判断是否命中关键告警（如计划 C1 的 alpha 丢失提示）。 */
  contains(needle: string): boolean {
    return Buffer.concat(this.chunks).toString('utf8').includes(needle)
  }

  clear(): void {
    this.chunks = []
    this.totalBytes = 0
  }
}
