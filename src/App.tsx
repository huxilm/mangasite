import './App.css'
import { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom'
import Content from './Content.tsx'
import MangaOverview from './MangaOverview.tsx'
import MangaRead from './MangaRead.tsx'
import RegisterModal from './RegisterModal.tsx'
import LoginModal from './LoginModal.tsx'
import UploadModal from './UploadModal.tsx'
import UserInfo from './UserInfo.tsx'

function App() {
  // 分别控制「注册弹窗」「登录弹窗」「上传弹窗」是否显示
  const [showRegister, setShowRegister] = useState(false)
  const [showLogin, setShowLogin] = useState(false)
  const [showUpload, setShowUpload] = useState(false)
  const [user, setUser] = useState<{ userId: number; username: string } | null>(null)

  // 检查本地是否有 token，如果有就去后端验证它
  function fetchMe() {
    const token = localStorage.getItem('mangasitetoken')
    if (!token) return
    fetch('/api/jwt', {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then(r => r.json())
      .then(data => {
        if (data.userId) {
          setUser({ userId: data.userId, username: data.username })
        } else {
          localStorage.removeItem('mangasitetoken') // token 无效或过期，清除它
        }
      })
  }

  // 组件挂载时检查 token
  useEffect(() => {
    fetchMe()
  }, [])
  // 处理登出：清除本地 token 并清掉登录状态
  const handleLogout = () => {
    localStorage.removeItem('mangasitetoken')  // 删掉本地 token
    setUser(null)                              // 清掉登录状态
  }

  return (
    <BrowserRouter>
      {/* 顶部导航栏：所有页面共用，始终显示在顶部 */}
      <header className="header">
        <img className="logo" src='/C6C990BF73A22F5AB2F82D4197E0C4FF.jpg'></img>

        <nav className="nav">
          {/* 第一行：首页 / 分类 / 上传。
              这三项要单独包一层 —— .nav 现在是竖向两行，
              不包的话它们会各自变成一行 */}
          <div className="nav-links">
            <Link className="home" to="/">首页</Link>

            {/* 分类下拉菜单。三项都跳到「带 ?tag= 的首页」，Content 从地址栏的
                search params 里读这个 tag、去 GET /api/manga?tag=… 取漫画。
                名字仍然是占位的（库里没有叫「分类1」的标签），所以点下去必然
                是空结果 —— 这一轮就是这么约定的，先把链路跑通

                ⚠ encodeURIComponent 不能省。分类名是自由文本（标签列是
                  varchar(100)，可能含 + # % 这些字符），不编码会静默出错：
                    + 不编码 → URLSearchParams 按 urlencoded 的规矩把它解成空格，
                               「a+b」变成「a b」，标签永远匹配不上
                    # 不编码 → 它后面的全被当成 URL fragment 丢掉，服务端收不到
                    % 不编码 → 可能凑出非法转义，解出来是 U+FFFD

                <Link> 渲染出来就是 <a>，所以 App.css 里 .list li a 那套
                胶囊样式照旧生效，那边不用改 */}
            <div className="nav-type">
              <div className="type">分类</div>
              <div className="arrow">▼</div>
              {/* 下拉面板：这一层只管「定位 + 悬停显隐 + 淡入动画」
                  （App.css 里 .list 和 .nav-type:hover .list 那两条），
                  里面两个大类各是一组「标题 + 一堆胶囊」，按正常流上下堆叠 ——
                  后一组从哪开始，由前一组的实际高度决定，不用在 CSS 里猜。

                  面板这层必须是 <div>：<ul> 的子元素只允许 <li>，
                  塞不进第二个 <ul>。

                  ⚠ 不能给每个大类各来一个 position: absolute +
                  top: 100% / 200%。top 的百分比算的是**包含块**的高度，
                  也就是 .nav-type 的 2rem —— 不是「上一个盒子有多高」，
                  所以 200% 恒等于 2rem。而一组光内边距加边框就 1.125rem，
                  随便再放一个胶囊就超过 2rem 了：第二个大类必然压在第一个
                  上面（它在 DOM 后面、z-index 又一样，画在上层） */}
              <div className="list">
                {/* 一个大类。这层外壳不是可有可无的：
                    ⚠ 标题写不进 <ul> 里 —— <ul> 的子元素只允许 <li>，
                    所以「标题 + <ul>」得有个共同的父元素。
                    它顺带把组内间距（0.4rem）和组间间距（0.75rem）分成两档 */}
                <div className="list-group">
                  <div className="list-group-title">主题</div>
                  <ul className="list-items">
                    <li><Link to={`/?tag=${encodeURIComponent('分类1')}`}>占位</Link></li>
                    <li><Link to={`/?tag=${encodeURIComponent('分类2')}`}>占位</Link></li>
                    <li><Link to={`/?tag=${encodeURIComponent('分类3')}`}>占位</Link></li>
                    <li><Link to={`/?tag=${encodeURIComponent('分类3')}`}>占位</Link></li>
                    <li><Link to={`/?tag=${encodeURIComponent('分类3')}`}>占位</Link></li>
                    <li><Link to={`/?tag=${encodeURIComponent('分类3')}`}>占位</Link></li>
                    <li><Link to={`/?tag=${encodeURIComponent('分类3')}`}>占位</Link></li>
                    <li><Link to={`/?tag=${encodeURIComponent('分类3')}`}>占位</Link></li>
                    <li><Link to={`/?tag=${encodeURIComponent('分类3')}`}>占位</Link></li>
                    <li><Link to={`/?tag=${encodeURIComponent('分类3')}`}>占位</Link></li>
                    <li><Link to={`/?tag=${encodeURIComponent('分类3')}`}>占位</Link></li>
                  </ul>
                </div>
                <div className="list-group">
                  <div className="list-group-title">作者</div>
                  <ul className="list-items">
                    <li><Link to={`/?tag=${encodeURIComponent('FRLEXZ')}`}>FRLEXZ</Link></li>
                    <li><Link to={`/?tag=${encodeURIComponent('分类2')}`}>占位</Link></li>
                    <li><Link to={`/?tag=${encodeURIComponent('分类3')}`}>占位</Link></li>
                    <li><Link to={`/?tag=${encodeURIComponent('分类3')}`}>占位</Link></li>
                    <li><Link to={`/?tag=${encodeURIComponent('分类3')}`}>占位</Link></li>
                    <li><Link to={`/?tag=${encodeURIComponent('分类3')}`}>占位</Link></li>
                    <li><Link to={`/?tag=${encodeURIComponent('分类3')}`}>占位</Link></li>
                    <li><Link to={`/?tag=${encodeURIComponent('分类3')}`}>占位</Link></li>
                    <li><Link to={`/?tag=${encodeURIComponent('分类3')}`}>占位</Link></li>
                    <li><Link to={`/?tag=${encodeURIComponent('分类3')}`}>占位</Link></li>
                    <li><Link to={`/?tag=${encodeURIComponent('分类3')}`}>占位</Link></li>
                  </ul>
                </div>
              </div>
            </div>

            {/* 上传。它原来直接挂在 .nav 下面，而 .nav 是竖向 flex
                （flex-direction: column），于是它自己占了一整行 ——
                2rem + 2rem + 4rem = 8rem 塞进 6rem 的 header，
                连 .search 都被压到只剩 3rem。挪进来才和首页/分类同一行 */}
            <button className="upload" onClick={() => setShowUpload(true)}>上传</button>
          </div>

          {/* 第二行：搜索 */}
          <div className="search">
            <input type="text" placeholder="请输入关键字" className="search-input" />
            <button type="button" className="search-button">搜索</button>
          </div>
        </nav>
        <div className='temp'>
          {!user ?
            <>
              <button className="upload" onClick={() => setShowUpload(true)}>上传</button>
              {/* 注册 / 登录：点击各自打开对应的弹窗 */}
              <button className="register" onClick={() => setShowRegister(true)}>注册</button>
              <button className="login" onClick={() => setShowLogin(true)}>登录</button>
            </> :
            <>
              <button className="upload" onClick={() => setShowUpload(true)}>上传</button>
              {/* 用户按钮：登录后显示当前用户 */}
              <Link className="user" to="/user">{user?.username}</Link>
              {/* 登出按钮：登录后显示 */}
              <button className="logout" onClick={handleLogout}>登出</button>
            </>
          }
        </div>
      </header>

      {/* 路由 */}
      <Routes>
        <Route path="/" element={<Content />} />
        <Route path="/manga-overview/:id" element={<MangaOverview />} />
        <Route path="/manga/:id/read" element={<MangaRead />} />
        {/* 带上话号的那条。两条路由指向同一个组件，组件自己从 useParams 里
            看有没有 chapterNumber —— 比在组件里再套一层路由分支好读 */}
        <Route path="/manga/:id/read/:chapterNumber" element={<MangaRead />} />
        <Route path="/user" element={<UserInfo user={user} />} />
      </Routes>

      {/* 注册弹窗：showRegister 为 true 时才渲染 */}
      {showRegister && <RegisterModal onClose={() => setShowRegister(false)} onLogin={fetchMe} />}
      {/* 登录弹窗：showLogin 为 true 时才渲染 */}
      {showLogin && <LoginModal onClose={() => setShowLogin(false)} onLogin={fetchMe} />}
      {/* 上传弹窗 */}
      {showUpload && <UploadModal onClose={() => setShowUpload(false)} />}
    </BrowserRouter>
  )
}

export default App
