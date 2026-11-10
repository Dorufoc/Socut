import { describe, expect, it } from 'vitest'
import { CLI_COMMANDS } from '@shared/cliProtocol'
import { MCP_TOOLS, findMcpTool, mcpToolNames } from '../cli/lib/mcpTools.mjs'

/** M10：MCP 工具表自检（每个工具都必须指向真实存在的 CLI 命令）。 */

const commandNames = new Set(CLI_COMMANDS.map((command) => command.name))

describe('MCP 工具表', () => {
  it('工具名唯一且是 snake_case', () => {
    const names = mcpToolNames()
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_]*$/)
  })

  it('至少 30 个工具（覆盖工程/素材/字幕条/文本/时间轴/导出/锁）', () => {
    expect(MCP_TOOLS.length).toBeGreaterThanOrEqual(30)
    for (const name of [
      'project_get',
      'media_import',
      'clip_add',
      'text_add',
      'timeline_freeze',
      'export_start',
      'preview_frame',
      'project_lock'
    ]) {
      expect(findMcpTool(name)).not.toBeNull()
    }
  })

  it('除特殊工具外，每个工具都指向 CLI 注册表里真实存在的命令', () => {
    const special = new Set(['preview_frame', 'export_wait'])
    for (const tool of MCP_TOOLS) {
      if (special.has(tool.name)) {
        expect(tool.command).toBeUndefined()
        continue
      }
      expect(tool.command, `${tool.name} 缺少 command`).toBeTruthy()
      const command = tool.command
      if (!command) continue
      expect(commandNames.has(command), `${tool.name} → ${command} 不在 CLI_COMMANDS`).toBe(true)
    }
  })

  it('inputSchema 结构合法：object + properties，required 都在 properties 里', () => {
    for (const tool of MCP_TOOLS) {
      const schema = tool.inputSchema
      expect(schema.type).toBe('object')
      expect(schema.additionalProperties).toBe(false)
      expect(schema.properties).toBeTypeOf('object')
      for (const required of schema.required ?? []) {
        expect(schema.properties[required], `${tool.name} required=${required} 不在 properties`).toBeTruthy()
      }
    }
  })

  it('工具表里不出现 JSON Schema 之外的私有字段（command/fixedParams 不会透给客户端）', () => {
    // server 的 publicTools() 只挑 name/description/inputSchema；这里锁定表结构约定
    for (const tool of MCP_TOOLS) {
      expect(Object.keys(tool.inputSchema)).toContain('type')
      expect(tool.inputSchema).not.toHaveProperty('command')
    }
  })

  it('transition_remove 用固定参数表达"移除"（不靠 schema 的 null 类型）', () => {
    const tool = findMcpTool('transition_remove')!
    expect(tool.command).toBe('clip.transition')
    expect(tool.fixedParams).toEqual({ transition: null })
  })
})
