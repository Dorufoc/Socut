import fs from 'node:fs/promises'
import path from 'node:path'
import { logsDir } from './paths'

/** 落盘日志（规格 §5.3 错误可追溯；崩溃兜底）。单文件 4MB 轮转一份。 */

const MAX_BYTES = 4 * 1024 * 1024

function logFile(): string {
  return path.join(logsDir(), 'app.log')
}

let queue: Promise<void> = Promise.resolve()

async function write(level: 'info' | 'warn' | 'error', message: string): Promise<void> {
  await fs.mkdir(logsDir(), { recursive: true })
  const file = logFile()
  try {
    const stat = await fs.stat(file)
    if (stat.size > MAX_BYTES) {
      await fs.rename(file, `${file}.${Date.now()}.old`)
    }
  } catch {
    // 文件不存在：直接写
  }
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}\n`
  await fs.appendFile(file, line, 'utf8')
}

/** 串行化写入，避免并发轮转互相踩踏。 */
export function log(level: 'info' | 'warn' | 'error', message: string): Promise<void> {
  queue = queue.then(() => write(level, message)).catch(() => undefined)
  return queue
}

export async function readRecent(maxLines = 200): Promise<string> {
  try {
    const content = await fs.readFile(logFile(), 'utf8')
    const lines = content.split('\n')
    return lines.slice(-maxLines).join('\n')
  } catch {
    return ''
  }
}
