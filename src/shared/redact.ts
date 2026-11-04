/**
 * 命令行脱敏（规格 §9：失败时附完整命令行，「脱敏路径可选」）。
 * 放在 shared 里是为了让这段字符串逻辑可被 Node 环境直接单测——
 * 它决定用户提单时会不会泄露本机目录，不该埋在组件里无人验证。
 */

/** 绝对路径形式：盘符开头（D:\… / E:/…）或 Unix 根开头（/…）。 */
const ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]|^[\\/]/

/**
 * 只对**绝对路径**脱敏。不能拿“含 /”当判据：
 * filter_complex 表达式（fps=24000/1001、between(t,…)）里也有斜杠，
 * 误判会把用户最需要看的参数截没。
 */
export function maskArgument(arg: string): string {
  if (!ABSOLUTE_PATH.test(arg)) return arg
  const parts = arg.split(/[\\/]+/).filter((part) => part.length > 0)
  const last = parts[parts.length - 1] ?? arg
  return `…/${last}`
}

export function maskArgv(argv: readonly string[]): string[] {
  return argv.map((arg) => maskArgument(arg))
}
