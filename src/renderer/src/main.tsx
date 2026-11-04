import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('缺少 #root 容器')

// 不使用 StrictMode 的双调用：帧通道与预览 rAF 循环都是「一次订阅」的副作用，
// 重复挂载会让同一帧被渲染两次、并让 IPC 端口监听器成对出现。
createRoot(container).render(<App />)
