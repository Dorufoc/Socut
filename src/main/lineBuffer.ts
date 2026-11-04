/** 跨 chunk 的行缓冲：子进程管道输出可能把一行拆成多次到达。 */
export class LineBuffer {
  private pending = ''

  /** 追加一块数据，返回已完整的行（不含空行）。 */
  push(chunk: Buffer | string): string[] {
    this.pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    const lines: string[] = []
    let index = this.pending.indexOf('\n')
    while (index >= 0) {
      const line = this.pending.slice(0, index).trim()
      this.pending = this.pending.slice(index + 1)
      if (line.length > 0) lines.push(line)
      index = this.pending.indexOf('\n')
    }
    return lines
  }

  /** 流结束时取出残留（可能没有结尾换行）。 */
  flush(): string[] {
    const rest = this.pending.trim()
    this.pending = ''
    return rest.length > 0 ? [rest] : []
  }
}
