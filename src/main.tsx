import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// 入口文件：把整个应用挂载到 index.html 的 <div id="root"> 上
// 页面切换（路由）都在 App 内部完成，这里只负责渲染 App
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
