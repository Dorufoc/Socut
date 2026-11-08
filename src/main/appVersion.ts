import packageJson from '../../package.json'

/**
 * 应用版本始终以 package.json 为准。
 *
 * 开发环境直接用 `electron out/main/index.js` 启动时，`app.getVersion()` 会返回
 * Electron 自身版本而不是 Socut 的版本；CLI 的版本信息必须稳定。
 */
export const APP_VERSION = packageJson.version
