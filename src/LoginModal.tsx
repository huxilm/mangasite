import './LoginModal.css'
import { useState, useEffect } from 'react'

// 提示条的类型：success 成功（绿），warning 警告（橙），null 表示不显示
type Toast = { message: string; type: 'success' | 'warning' } | null

// 登录弹窗组件：和注册弹窗结构相同，但只有用户名和密码
function LoginModal({ onClose, onLogin }: { onClose: () => void; onLogin: () => void }) {
  // 提示条状态：null 表示不显示
  const [toast, setToast] = useState<Toast>(null)

  // 用户名、密码的输入值
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  // 提示条出现后，1.5 秒后自动消失
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 1500)
    return () => clearTimeout(timer)
  }, [toast])

  // 点击「登录」提交数据
  const handleLogin = () => {
    // 判断是否有空输入：任一为空就提示，不发请求
    if (!username.trim() || !password.trim()) {
      setToast({ message: '请填写完整', type: 'warning' })
      return
    }
    fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    })
      .then(r => r.json())
      .then(data => {
        if (data.message) {         // 成功：后端返回 { message: '登录成功' }
          setToast({ message: data.message, type: 'success' })
          localStorage.setItem('mangasitetoken', data.token) // 保存 token
          onLogin() // 调用 onLogin 回调，更新用户状态
          const timer = setTimeout(() => {
            onClose() // 调用 onClose 回调，关闭弹窗
          }, 1500) // 1.5 秒后隐藏弹窗
          return () => clearTimeout(timer)
        } else {                    // 失败：后端返回 { error: '...' }
          alert(data.error)
        }
      })
      .catch(() => alert('网络错误，请重试'))
  }

  // 点遮罩关窗。必须用 mousedown + target 比对，不能写 onClick={onClose}：
  // click 的 target 是 mousedown 和 mouseup 两个目标的**最近公共祖先**，
  // 在输入框里按下、拖到弹窗外面才松手（拖选文字时很常见）会让它变成这个遮罩
  // —— 于是被误判成「点了遮罩」。而传播路径是 mask → body → …，表单是遮罩的
  // 子元素、不在往上冒的路径上，下面那句 stopPropagation 拦不住。
  // 完整说明见 UploadModal.tsx 里 .modal-mask 上那一段
  return (
    <div className="modal-mask" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <form className="modal" noValidate onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); handleLogin(); }}>
        <input type="text" placeholder="用户名" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input type="password" placeholder="密码" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button type="submit" className="modal-submit">登录</button>

        {/* 提示条：根据 type 显示不同颜色，1.5 秒后消失 */}
        {toast && <div className={`toast ${toast.type}`}>{toast.message}</div>}
      </form>
    </div>
  )
}

export default LoginModal
