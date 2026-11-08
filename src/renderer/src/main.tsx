import { createRoot } from 'react-dom/client'
import { App } from './App'
import { installCliCommandRouter } from './cli/commandRouter'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('缺少 #root 容器')

// CLI 控制服务可能在本模块执行前就派发命令：preload 会先排队，
// 这里注册路由时统一回放，并握手告诉主进程可以开始转发。
installCliCommandRouter()

// 不使用 StrictMode 的双调用：帧通道与预览 rAF 循环都是「一次订阅」的副作用，
// 重复挂载会让同一帧被渲染两次、并让 IPC 端口监听器成对出现。
createRoot(container).render(<App />)
