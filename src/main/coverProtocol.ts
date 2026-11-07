import fs from 'node:fs/promises'
import { protocol } from 'electron'
import { RECENT_ENTRY_ID_PATTERN } from '../shared/recentProjects'
import { userCoverPath } from './paths'

/**
 * 启动页封面协议：focusnews-cover://<entryId>?v=<modifiedAt>。
 *
 * host 就是最近工程 id，主进程只按 id 映射到 userData/covers/<id>.png，
 * 不接受任何路径片段——渲染进程拿不到读任意文件的能力。
 * 与 focusnews-thumb 保持同一套权限声明（标准 + 安全 + Fetch API）。
 */

export const COVER_SCHEME = 'focusnews-cover'

/** 必须在 app ready 之前调用（与其它自定义协议并列注册）。 */
export function registerCoverScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: COVER_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true }
    }
  ])
}

/** app ready 之后调用：GET/HEAD 读取封面 PNG。 */
export function installCoverProtocol(): void {
  protocol.handle(COVER_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405 })
    }

    let entryId: string
    try {
      entryId = decodeURIComponent(new URL(request.url).host || '')
    } catch {
      return new Response(null, { status: 400 })
    }
    // 非法 id（含目录穿越尝试）直接拒绝，绝不参与路径拼接
    if (!RECENT_ENTRY_ID_PATTERN.test(entryId)) {
      return new Response(null, { status: 403 })
    }

    let file: string
    try {
      file = userCoverPath(entryId)
    } catch {
      return new Response(null, { status: 403 })
    }

    const stat = await fs.stat(file).catch(() => null)
    if (!stat || !stat.isFile() || stat.size === 0) {
      return new Response(null, { status: 404 })
    }

    const headers: Record<string, string> = {
      'Content-Type': 'image/png',
      'Content-Length': String(stat.size),
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    }
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers })

    try {
      const body = await fs.readFile(file)
      return new Response(body, { status: 200, headers })
    } catch {
      return new Response(null, { status: 404 })
    }
  })
}
