/**
 * `cli/lib/mcpTools.mjs` 的类型声明（测试与工具脚本在 TS 侧 import 时用）。
 * 运行时真值在 .mjs 文件里；这里只描述形状，不重复实现。
 */

export interface McpToolInputSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties: boolean
}

export interface McpTool {
  name: string
  description: string
  /** 对应的 CLI 命令名（特殊工具没有） */
  command?: string
  /** 调用时固定附加的参数（例如 transition_remove 的 transition:null） */
  fixedParams?: Record<string, unknown>
  inputSchema: McpToolInputSchema
}

export const MCP_TOOLS: McpTool[]

export function findMcpTool(name: string): McpTool | null

export function mcpToolNames(): string[]
