import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import './UserInfo.css'

// ===== 类型 =====

// 完整的用户信息（来自 /api/me）
interface UserInfoData {
  id: number
  username: string
  email: string
  created_at: string
}

// 收藏条目（来自 /api/me/myfavorites）
interface Favorite {
  manga_id: number              // 漫画 id（注意不是收藏记录自己的 id）
  title: string
  cover: string | null
  series_id: number | null      // null = 未分类
}

// 系列（来自 /api/me/series）
interface Series {
  id: number
  name: string
  manga_count: number
}

// 右侧列表的筛选条件：全部 / 未分类 / 某个系列
type SeriesFilter = 'all' | 'none' | number

// ===== 请求封装 =====

// 统一带上 token，省得每个请求都抄一遍 header
function authFetch(url: string, options: RequestInit = {}) {
  const token = localStorage.getItem('mangasitetoken')
  return fetch(url, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${token}` }
  })
}

// 带 JSON body 的请求（POST/PUT），自动补上 Content-Type
function jsonFetch(url: string, method: string, body: unknown) {
  return authFetch(url, {
    method: method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

// 重新拉取系列列表
function loadSeries(setSeries: (list: Series[]) => void) {
  authFetch('/api/me/series')
    .then(r => r.json())
    .then(data => { if (Array.isArray(data)) setSeries(data) })
    .catch(() => { })
}

// 重新拉取收藏列表
function loadFavorites(setFavorites: (list: Favorite[]) => void) {
  authFetch('/api/me/myfavorites')
    .then(r => r.json())
    .then(data => { if (Array.isArray(data)) setFavorites(data) })
    .catch(() => { })
}

// ===== 组件 =====

// 接收 user 只是为了快速判断「是否已登录」；完整信息由组件自己调 /api/me 获取
function UserInfo({ user }: { user: { userId: number; username: string } | null }) {
  // 用户信息
  const [info, setInfo] = useState<UserInfoData | null>(null)
  // null 表示还没请求回来，[] 表示确实一条都没有
  // 收藏列表
  const [favorites, setFavorites] = useState<Favorite[] | null>(null)
  // 系列列表
  const [series, setSeries] = useState<Series[]>([])

  // 右侧显示哪些收藏 / 左侧哪个系列被选中
  // 'all' = 全部，'none' = 未分类，number = 某个系列的 id
  const [filter, setFilter] = useState<SeriesFilter>('all')
  // 新建系列的输入框
  const [newSeriesName, setNewSeriesName] = useState('')
  // 正在改名的系列 id（null = 没有在改名）
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editingName, setEditingName] = useState('')

  // 请求个人信息：只在组件挂载时请求一次
  useEffect(() => {
    const token = localStorage.getItem('mangasitetoken')
    if (!token) return
    fetch('/api/me', {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then(r => r.json())
      .then(data => { if (!data.error) setInfo(data) })
      .catch(() => { })
  }, [])

  // 收藏和系列：和上面的个人信息并行发出
  useEffect(() => {
    if (!user) return
    loadFavorites(setFavorites)
    loadSeries(setSeries)
  }, [user])

  // ===== 事件处理 =====

  // 新建系列
  const handleCreateSeries = async () => {
    const name = newSeriesName.trim()
    if (!name) return
    const data = await (await jsonFetch('/api/series', 'POST', { name })).json()
    if (data.error) return alert(data.error)
    setNewSeriesName('')
    loadSeries(setSeries)
  }

  // 系列改名
  const handleRenameSeries = async (id: number) => {
    const name = editingName.trim()
    if (!name) return
    const data = await (await jsonFetch(`/api/series/${id}`, 'PUT', { name })).json()
    if (data.error) return alert(data.error)
    setEditingId(null)
    loadSeries(setSeries)
  }

  // 删除系列
  const handleDeleteSeries = async (s: Series) => {
    // 删除是不可逆的，先问一句
    if (!confirm(`确定删除系列「${s.name}」吗？\n里面的收藏会回到「未分类」，不会丢失。`)) return
    const data = await (await authFetch(`/api/series/${s.id}`, { method: 'DELETE' })).json()
    if (data.error) return alert(data.error)
    if (filter === s.id) setFilter('all')   // 正在看这个系列，退回「全部」
    loadSeries(setSeries)
    loadFavorites(setFavorites)             // 里面的收藏 series_id 被置成 NULL 了
  }

  // 把某本收藏归到某个系列（或移出系列）
  const handleAssignSeries = async (mangaId: number, seriesId: number | null) => {
    // 乐观更新：先在本地改掉，等后端返回再刷新,如果错误再回滚
    setFavorites(prev => {
      if (prev === null) return null
      return prev.map(f => {
        if (f.manga_id !== mangaId) return f        // 不是这本，原样返回
        return { ...f, series_id: seriesId }        // 是这本，改掉 series_id
      })
    })
    const data = await (await jsonFetch(`/api/favorites/${mangaId}/series`, 'PUT', { seriesId })).json()
    if (data.error) {
      alert(data.error)
      loadFavorites(setFavorites)
      return
    }
    loadSeries(setSeries)                   // 各系列的数量变了
  }

  // ===== 渲染前的计算 =====

  // 未登录：由 App 传下来的 user 判断，立即显示
  if (!user) return <div className="user-info-page">请先登录</div>
  // 已登录但详情还在请求中
  if (!info) return <div className="user-info-page">加载中…</div>

  // 计算「未分类」的数量
  const uncategorized = favorites?.filter(f => f.series_id === null).length ?? 0

  // 过滤后的收藏列表
  const visibleFavorites = (favorites ?? []).filter(fav => {
    if (filter === 'all') return true
    if (filter === 'none') return fav.series_id === null
    return fav.series_id === filter
  })

  // 计算右侧 box 的标题
  const currentSeries = (typeof filter === 'number') ? series.find(s => s.id === filter) : undefined
  const boxTitle = (filter === 'all')
  ? '我的收藏': ((filter === 'none')? '我的收藏 · 未分类': (`我的收藏 · ${currentSeries?.name ?? ''}`))

  return (
    <div className="user-info-page">
      {/* 左列：个人信息，下面是系列管理 */}
      <div className="user-left">
        <div className="user-info">
          <p>用户名：{info.username}</p>
          <p>邮箱：{info.email}</p>
          <p>用户 ID：{info.id}</p>
          <p>注册时间：{new Date(info.created_at).toLocaleString()}</p>
        </div>

        <div className="side-box">
          <h2>系列</h2>
          {/* 系列列表 */}
          <ul className="series-list">
            {/* 前两项是虚拟的：全部 / 未分类，都不是真实的系列 */}
            <li>
              <button
                className={filter === 'all' ? 'series-name active' : 'series-name'}
                onClick={() => setFilter('all')}
              >
                全部
                <span className="series-count">{favorites?.length ?? 0}</span>
              </button>
            </li>

            <li>
              <button
                className={filter === 'none' ? 'series-name active' : 'series-name'}
                onClick={() => setFilter('none')}
              >
                未分类
                <span className="series-count">{uncategorized}</span>
              </button>
            </li>

            {series.map(s => (
              <li key={s.id}>
                {editingId === s.id ? (
                  // 改名中：输入框 + 保存 / 取消
                  <>
                    <input
                      className="series-input"
                      value={editingName}
                      autoFocus
                      onChange={e => setEditingName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleRenameSeries(s.id) }}
                    />
                    <button className="series-btn" onClick={() => handleRenameSeries(s.id)}>存</button>
                    <button className="series-btn" onClick={() => setEditingId(null)}>×</button>
                  </>
                ) : (
                  // 平时：名字（点了筛选）+ 改名 / 删除
                  <>
                    <button
                      className={filter === s.id ? 'series-name active' : 'series-name'}
                      onClick={() => setFilter(s.id)}
                    >
                      {s.name}
                      <span className="series-count">{s.manga_count}</span>
                    </button>
                    <button
                      className="series-btn"
                      title="改名"
                      onClick={() => { setEditingId(s.id); setEditingName(s.name) }}
                    >✎</button>
                    <button
                      className="series-btn"
                      title="删除"
                      onClick={() => handleDeleteSeries(s)}
                    >✕</button>
                  </>
                )}
              </li>
            ))}
          </ul>

          {/* 新建系列 */}
          <div className="series-new">
            <input
              className="series-input"
              placeholder="新系列名称"
              value={newSeriesName}
              onChange={e => setNewSeriesName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreateSeries() }}
            />
            <button className="series-btn" onClick={handleCreateSeries}>新建</button>
          </div>
        </div>
      </div>

      {/* 右列：我的收藏，占满剩余宽度 */}
      <div className="side-box favorites-box">
        <h2>{boxTitle}</h2>

        {favorites === null ? (
          <p className="empty">加载中…</p>
        ) : visibleFavorites.length === 0 ? (
          <p className="empty">{filter === 'all' ? '暂无收藏' : '这里还没有收藏'}</p>
        ) : (
          <div className="favorites-grid">
            {visibleFavorites.map(fav => (
              <div className="favorite-item" key={fav.manga_id}>
                {/* 点封面跳到该漫画的详情页 */}
                <Link to={`/manga-overview/${fav.manga_id}`}>
                  <img className="favorite-cover" src={fav.cover ?? undefined} alt={fav.title} />
                </Link>
                <div className="favorite-title">{fav.title}</div>

                {/* 把这一本归到某个系列；选「未分类」就是移出来 */}
                <select
                  className="favorite-series"
                  value={fav.series_id ?? ''}
                  onChange={e => handleAssignSeries(fav.manga_id, e.target.value === '' ? null : Number(e.target.value))}
                >
                  <option value="">未分类</option>
                  {series.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
export default UserInfo
