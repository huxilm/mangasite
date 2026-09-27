import { useParams, useNavigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import './MangaOverview.css'

// 漫画详情的数据类型（对应后端 manga 表返回的字段）
interface MangaDetail {
  id: number
  title: string
  author: string
  cover: string | null
  readcounts: number
  lovecounts: number
  tags: string | string[] | null   // 可能是 JSON 字符串、数组、或空
  created_at: string
  updated_at: string
}

// 把 tags 统一转成字符串数组
// 数据库里可能存成 JSON 字符串 '["热血","冒险"]'，或逗号分隔 '热血,冒险'，或已经是数组
function parseTags(tags: string | string[] | null): string[] {
  if (Array.isArray(tags)) return tags // 已经是数组，直接返回
  if (!tags) return [] // null 或空，返回空数组
  const t = tags.trim() // 去掉首尾空格
  if (t.startsWith('[')) { // 可能是 JSON 字符串
    try { return JSON.parse(t) }  // 解析 JSON 字符串
    catch { return [] }
  }
  return t.split(',').map(s => s.trim()).filter(Boolean) // 逗号分隔，去掉空字符串
}

//点赞/取消点赞功能
function updateLikeCount(mangaId: number, setLiked: (liked: boolean) => void, manga: MangaDetail, setManga: (manga: MangaDetail) => void) {
  const token = localStorage.getItem('mangasitetoken')
  if (!token) {
    alert('请先登录')
    return
  }
  fetch(`/api/manga/${mangaId}/update-like`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  })
    .then(r => r.json())
    .then(data => {
      if (data.error) {
        alert(data.error)
      } else {
        setLiked(data.liked) // 更新点赞状态
        // 更新 manga 数据
        setManga({ ...manga, lovecounts: data.lovecounts })
      }
    })
    .catch(() => alert('网络错误，请重试'))
}

//收藏/取消收藏功能
function updateFavorite(mangaId: number, setFavorited: (favorited: boolean) => void) {
  const token = localStorage.getItem('mangasitetoken')
  if (!token) {
    alert('请先登录')
    return
  }
  fetch(`/api/manga/${mangaId}/update-favorite`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  })
    .then(r => r.json())
    .then(data => {
      if (data.error) {
        alert(data.error)
      } else {
        setFavorited(data.favorited) // 更新收藏状态
      }
    })
    .catch(() => alert('网络错误，请重试'))
}

function MangaOverview() {
  // 从 URL 里取出 :id（点击封面时由 Link 传过来）
  const { id } = useParams()
  const navigate = useNavigate()
  const [liked, setLiked] = useState(false)
  const [favorited, setFavorited] = useState(false)

  // 详情数据：null 表示还没加载到
  const [manga, setManga] = useState<MangaDetail | null>(null)

  // 「编辑标签」的两个状态：
  //   editingTags 只控制输入框显不显示（平时只有一个按钮）
  //   tagsDraft   是框里的内容，也就是用户正在编辑的那串字符
  // 分成两个而不是「tagsDraft 非空就显示」：标签本来就是空的那种情况，
  // 打开框子会得到一个空字符串，那样判据会把空框当成没打开
  const [editingTags, setEditingTags] = useState(false)
  const [tagsDraft, setTagsDraft] = useState('')

  // 组件挂载、或 id 变化时，去后端查这一本的详情
  useEffect(() => {
    fetch(`/api/manga/${id}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) {
          alert(data.error)
          return
        }
        setManga(data)
      })
      .catch(() => alert('网络错误，请重试'))
  }, [id])

  // 组件挂载、或漫画详情变化时，去后端查用户和是否已喜欢
  useEffect(() => {
    if (manga) {
      const token = localStorage.getItem('mangasitetoken')
      if (!token) return
      fetch(`/api/manga/${manga.id}/islike`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` }
      })
        .then(r => r.json())
        .then(data => {
          if (!data.error) setLiked(data.liked)
        })
        .catch(() => {})
    }
  }, [manga])//确保在获取到漫画详情后再去检查是否点赞

  // 组件挂载、或漫画详情变化时，去后端查用户是否已收藏
  useEffect(() => {
    if (manga) {
      const token = localStorage.getItem('mangasitetoken')
      if (!token) return
      fetch(`/api/manga/${manga.id}/isfavorite`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` }
      })
        .then(r => r.json())
        .then(data => {
          if (!data.error) setFavorited(data.favorited)
        })
        .catch(() => {})
    }
  }, [manga])//确保在获取到漫画详情后再去检查是否收藏

  // 数据还没回来时，先显示「加载中」
  if (!manga) return <div className="manga-overview">加载中…</div>

  const tags = parseTags(manga.tags)

  // 点「开始阅读」：先让阅读量 +1（顺手做，失败不影响阅读），再跳转第一话
  const handleRead = () => {
    fetch(`/api/manga/${id}/read-count`, { method: 'POST' }).catch(() => { })
    navigate(`/manga/${id}/read`)
  }

  // 点「删除漫画」：先弹一句确认，真删掉了才回首页
  const handleDelete = () => {
    // 用浏览器自带的 confirm，和这个文件里别处用的 alert 是同一套 ——
    // 项目里没有自己写的弹窗组件，为这一句引入一个不值当。
    // confirm 会阻塞，返回 true / false
    if (!confirm(`确定要删除《${manga.title}》吗？\n\n它所有的话和图片会一起删掉，不能恢复。`)) return

    fetch(`/api/manga/${id}`, { method: 'DELETE' })
      .then(r => r.json())
      .then(data => {
        if (data.error) {
          alert(data.error)
          return          // 没删掉就留在这一页，别跳走
        }
        navigate('/')      // 真删掉了才回首页
      })
      .catch(() => alert('网络错误，请重试'))

    // ⚠ 注意这里和 handleRead 不一样：那边是「不管成不成，先跳了再说」，
    // 因为阅读量 +1 只是个统计，失败了也不该拦着人看书。
    // 删除不能这么写 —— 请求还没回来就跳走的话，服务端回 404/500 也
    // 没人知道了，用户以为是删成功了，回头发现漫画还在
  }

  // 点「编辑标签」：打开输入框，里面放库里的原始 tags；再点一下收起
  const handleEditTags = () => {
    if (editingTags) {
      setEditingTags(false)   // 已经开着 → 这一下当「收起」
      return
    }

    // ⚠ 这里故意**不走 parseTags**：要的就是数据库里那串原样字符。
    // 它可能是 '["人妻","NTR"]' 这种 JSON 字符串，也可能是 '人妻,NTR'
    // 这种逗号串 —— 上面那排胶囊才是加工过的展示，这里不加工。
    //
    // 外面这层 String(... ?? '') 不是在「处理数据」，是把值弄成 <input>
    // 能接受的形状，两个都是必需的：
    //   ?? ''   —— tags 为 NULL 时它取到 null，而受控 <input> 的 value
    //              收到 null，React 会警告「value prop should not be null」
    //   String()—— MangaDetail.tags 的类型写的是 string | string[] | null，
    //              那是为了兼容老数据的形式；库里这一列是 varchar(100)，
    //              实际只可能是字符串或 null。对上字符串时 String() 原样返回，
    //              一个字符都不动；只是让 TS 闭嘴
    setTagsDraft(String(manga.tags ?? ''))
    setEditingTags(true)
  }

  // 点「确定」：把框里那串字符原样存回数据库
  const handleSaveTags = () => {
    fetch(`/api/manga/${id}/tags`, {
      method: 'PUT',
      // ⚠ 这个请求头绝对不能省。服务端那句 express.json() 只在
      // Content-Type 是 application/json 时才去解析请求体，
      // 少了它 req.body 就是空的 → 服务端拿到 tags = undefined →
      // 存进去一个 NULL。症状是「点确定没报错、标签却全没了」，
      // 而且没有任何提示 —— 一条静默丢数据的路径
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: tagsDraft }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.error) {
          alert(data.error)
          return
        }
        // 用服务端回的那个值更新界面，不用 tagsDraft ——
        // 服务端 trim 过、空串还转成了 NULL，用它才不会出现
        // 「库里是 NULL、屏幕上还留着几个空格」这种漂移。
        // 改完 manga.tags，上面那排胶囊（它读的是 parseTags(manga.tags)）
        // 会跟着一起刷新，不用手动去动它
        setManga({ ...manga, tags: data.tags })
        setEditingTags(false)   // 存成功了才收起，失败留着让人接着改
      })
      .catch(() => alert('网络错误，请重试'))
  }

  return (
    <div className="manga-overview">
      {/* 左：封面 */}
      <div className="manga-cover-container">
        <img src={manga.cover ?? undefined} alt={manga.title} className="manga-cover" />
        <span>id: {manga.id}</span>
      </div>

      {/* 右：详情，竖向排列 */}
      <div className="manga-details">
        <h1 className="manga-title">{manga.title}</h1>
        <div className="manga-author">{manga.author}</div>

        {/* 点阅,爱心,收藏 */}
        <div className="manga-stats">
          <span>点阅 {manga.readcounts}</span>
          <button className="icon-btn" onClick={() => updateLikeCount(manga.id, setLiked, manga, setManga)}>{liked ? '❤️  ' : '🤍  '} {manga.lovecounts}</button>
          <button className="icon-btn" onClick={() => updateFavorite(manga.id, setFavorited)}>{favorited ? '⭐' : '☆'} 收藏</button>
        </div>

        {/* 标签 + 编辑标签。
            按钮和输入框就是 .manga-tags 这个 flex 行里的最后两项 ——
            所以它们自然接在最后一个标签右边，间距也由那一行的 gap 管。
            标签多到换行时它俩跟着落到新一行的末尾，不用另外写定位。
            （真要它俩固定在整个标签块的右侧、不跟着换行，就得在外面
             再包一层 flex 行把 .manga-tags 和它俩分开，那要多两个规则） */}
        <div className="manga-tags">
          {tags.map(t => <span className="tag" key={t}>{t}</span>)}

          <button className="edit-tags-btn" onClick={handleEditTags}>编辑标签</button>

          {/* 输入框和「确定」平时都不渲染 —— 点了「编辑标签」才出现，
              再点一下收起。
              受控组件：value 绑 tagsDraft，onChange 写回它。
              ⚠ 少了 onChange，React 会把它当只读，敲键盘一个字都进不去，
              控制台还会警告「provided a value prop without an onChange」

              外层这个 <>...</> 是 Fragment：它不产生任何真实元素，
              所以里面的 input 和 button 就是 .manga-tags 这个 flex 行里
              平级的两个子项，各占一个位置，跟不经包装一样。
              （包个 <div> 就不行了 —— 那会多出一个盒子，
               两个控件被一起塞进它里面） */}
          {editingTags && (
            <>
              <input
                className="tags-input"
                value={tagsDraft}
                onChange={e => setTagsDraft(e.target.value)}
                /* 这里故意**不写** maxLength={100}。看着像顺手该加的防护，
                   其实正好和这个框的意义相反：超长会被浏览器静默截到 100，
                   用户敲的字丢了却什么都没发生 —— 和「看不到原文被改过」
                   是同一类毛病。让它原样发出去，由服务端回一句
                   「标签总长度不能超过 100 个字符」，用户能看见 */
              />
              <button className="tags-save-btn" onClick={handleSaveTags}>确定</button>
            </>
          )}
        </div>

        {/* 开始阅读：直接进第一话阅读页 */}
        <button className="read-btn" onClick={handleRead}>开始阅读</button>

        {/* 删除。骨架整个复用 .read-btn —— 内边距、圆角、字号、
            「只占内容宽度不撑满整行」那几条全都一样，只有背景色要换。
            ⚠ 两个类必须都写：CSS 里那条选择器是 .read-btn.delete-btn，
            只写 delete-btn 的话一个样式都拿不到（连 padding 都没有） */}
        <button className="read-btn delete-btn" onClick={handleDelete}>删除漫画</button>
      </div>
    </div>
  )
}
export default MangaOverview
