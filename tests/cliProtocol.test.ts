import { describe, expect, it } from 'vitest'
import {
  CLI_COMMANDS,
  CLI_COMMAND_NAMES,
  CLI_ERROR_CODES,
  CliCommandError,
  findCliCommand,
  optionalEnum,
  optionalStringArray,
  requireEnum,
  requireNumber,
  requireString,
  toCliErrorInfo
} from '../src/shared/cliProtocol'

describe('CLI 命令清单', () => {
  it('命令名唯一', () => {
    expect(new Set(CLI_COMMAND_NAMES).size).toBe(CLI_COMMAND_NAMES.length)
  })

  it('每条命令都有合法的 host/group/summary', () => {
    for (const command of CLI_COMMANDS) {
      expect(command.host === 'main' || command.host === 'renderer').toBe(true)
      expect(command.group.length).toBeGreaterThan(0)
      expect(command.summary.length).toBeGreaterThan(0)
    }
  })

  it('核心命令都存在且分派到正确进程', () => {
    expect(findCliCommand('app.health')?.host).toBe('main')
    expect(findCliCommand('project.open')?.host).toBe('main')
    expect(findCliCommand('project.get')?.host).toBe('renderer')
    expect(findCliCommand('export.start')?.host).toBe('renderer')
    expect(findCliCommand('export.status')?.host).toBe('main')
    expect(findCliCommand('not.a.command')).toBeUndefined()
  })
})

describe('CLI 参数读取', () => {
  it('requireString 拒绝缺失/空字符串', () => {
    expect(() => requireString({}, 'path')).toThrowError(CliCommandError)
    expect(() => requireString({ path: '' }, 'path')).toThrowError(CliCommandError)
    expect(requireString({ path: 'D:\\a.mp4' }, 'path')).toBe('D:\\a.mp4')
  })

  it('requireNumber 拒绝 NaN/Infinity', () => {
    expect(() => requireNumber({ at: Number.NaN }, 'at')).toThrowError(CliCommandError)
    expect(() => requireNumber({ at: Number.POSITIVE_INFINITY }, 'at')).toThrowError(CliCommandError)
    expect(requireNumber({ at: 0 }, 'at')).toBe(0)
  })

  it('枚举：可选值非法时返回 undefined，必填值非法时抛 BAD_PARAMS', () => {
    expect(optionalEnum({ mode: 'bogus' }, 'mode', ['a', 'b'])).toBeUndefined()
    expect(optionalEnum({ mode: 'a' }, 'mode', ['a', 'b'])).toBe('a')
    try {
      requireEnum({ mode: 'bogus' }, 'mode', ['a', 'b'])
      throw new Error('应当抛出')
    } catch (error) {
      expect(error).toBeInstanceOf(CliCommandError)
      expect((error as CliCommandError).code).toBe(CLI_ERROR_CODES.BAD_PARAMS)
    }
  })

  it('字符串数组过滤非字符串项', () => {
    expect(optionalStringArray({ tags: ['a', 1, 'b'] }, 'tags')).toEqual(['a', 'b'])
    expect(optionalStringArray({ tags: 'a' }, 'tags')).toBeUndefined()
  })
})

describe('CLI 错误序列化', () => {
  it('CliCommandError 保留 code 与 detail', () => {
    const info = toCliErrorInfo(new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, '没有', '细节'))
    expect(info).toEqual({ code: CLI_ERROR_CODES.NOT_FOUND, message: '没有', detail: '细节' })
  })

  it('普通 Error 归为 INTERNAL', () => {
    const info = toCliErrorInfo(new Error('boom'))
    expect(info.code).toBe(CLI_ERROR_CODES.INTERNAL)
    expect(info.message).toBe('boom')
  })
})
