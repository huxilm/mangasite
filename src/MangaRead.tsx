import { useParams, useNavigate, Link } from 'react-router-dom'
import { useState, useEffect } from 'react'
import './MangaRead.css'

// 章节列表里的一项。后端 GET /api/manga/:id/chapters 故意不返回 pages ——
// 一本书所有话的图片路径加起来可能有好几 KB，而这个列表只需要话号和标题
interface ChapterInfo {
  id: number
  chapter_number: number
  title: string | null
}

// 一话的完整内容（GET /api/manga/:id/chapters/:number）
interface Chapter extends ChapterInfo {
  manga_id: number
  pages: string[] | null
}

function MangaRead() {
  // 从 URL 里取漫画 id。第二条路由 /manga/:id/read/:chapterNumber 会多给一个话号
  const { id, chapterNumber } = useParams()
  const navigate = useNavigate()

  const [list, setList] = useState<ChapterInfo[]>([])
  // 'loading' → 'ready' / 'error'。
  // 用一个状态而不是「list 是不是空数组」来判断加载完了没有 ——
  // 一本还没传章节的漫画，加载完也是空数组，两种情况显示的东西完全不同
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [chapter, setChapter] = useState<Chapter | null>(null)
  const [chapterError, setChapterError] = useState('')

  // 当前话号：地址里带了就用它，没带就用列表里的第一话。
  // 注意 Number(undefined) 是 NaN，Number.isInteger 会把它挡掉
  const fromUrl = Number(chapterNumber)
  const current = Number.isInteger(fromUrl) ? fromUrl : (list[0]?.chapter_number ?? null)

  // 第一步：拿话列表
  useEffect(() => {
    setListState('loading')
    fetch(`/api/manga/${id}/chapters`)
      .then(r => r.json())
      .then(data => {
        // 出错时后端返回的是 { error: '...' }，不是数组
        if (!Array.isArray(data)) {
          setListState('error')
          return
        }
        setList(data)
        setListState('ready')
      })
      .catch(() => setListState('error'))
  }, [id])

  // 第二步：拿当前话的内容。话号变了就重新取
  useEffect(() => {
    if (current === null) return

    // 先清空。不清的话切话时上一话的图还挂在屏幕上，
    // 新的一话要几百毫秒才回来，中间那段时间显示的是错的内容
    setChapter(null)
    setChapterError('')

    fetch(`/api/manga/${id}/chapters/${current}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) {
          setChapterError(data.error)
          return
        }
        setChapter(data)
      })
      .catch(() => setChapterError('网络错误，请重试'))
  }, [id, current])

  // 地址里没带话号时，把第一话的话号补进地址栏 —— 这样刷新、分享出去的链接
  // 都能停在正在看的那一话上。
  // replace: true 是为了不留下多余的历史记录：不写的话用户从详情页点进来
  // 再点浏览器返回，会回到同一个页面，得按两次才出得去
  useEffect(() => {
    if (chapterNumber || current === null) return
    navigate(`/manga/${id}/read/${current}`, { replace: true })
  }, [chapterNumber, current, id, navigate])

  if (listState === 'loading') return <div className="reader">加载中…</div>

  if (listState === 'error') {
    return (
      <div className="reader">
        <div className="reader-head">章节列表加载失败</div>
        <Link className="reader-link" to={`/manga-overview/${id}`}>返回详情页</Link>
      </div>
    )
  }

  // 列表是空的：这本漫画一话都没有（上传时第 3 步没走完的话会这样）
  if (list.length === 0) {
    return (
      <div className="reader">
        <div className="reader-head">这本漫画还没有内容</div>
        <Link className="reader-link" to={`/manga-overview/${id}`}>返回详情页</Link>
      </div>
    )
  }

  // 上一话 / 下一话。用下标找，而不是话号 ±1 ——
  // 话号是用户填的，可能不连续（比如只有第 1 话和第 5 话）
  const idx = list.findIndex(c => c.chapter_number === current)
  const prev = idx > 0 ? list[idx - 1] : null
  const next = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null
  const info = idx >= 0 ? list[idx] : null

  const go = (n: number) => navigate(`/manga/${id}/read/${n}`)

  return (
    <div className="reader">
      <div className="reader-head">
        {/* 话的选择器。一话一个按钮，话多了这一行会横向滚动（见 CSS） */}
        <div className="reader-chapters">
          {list.map(c => (
            <button
              key={c.id}
              type="button"
              className={`reader-chapter${c.chapter_number === current ? ' active' : ''}`}
              onClick={() => go(c.chapter_number)}
            >
              第 {c.chapter_number} 话{c.title ? ` ${c.title}` : ''}
            </button>
          ))}
        </div>

        <div className="reader-nav">
          <button type="button" className="reader-step" disabled={!prev} onClick={() => prev && go(prev.chapter_number)}>
            上一话
          </button>
          <span className="reader-now">第 {current} 话 {info?.title || ''}</span>
          <button type="button" className="reader-step" disabled={!next} onClick={() => next && go(next.chapter_number)}>
            下一话
          </button>
        </div>
      </div>

      {chapterError && <div className="reader-head">{chapterError}</div>}
      {!chapter && !chapterError && <div className="reader-head">加载中…</div>}

      {/* 逐页展示漫画页面。
          pages 兜底成空数组：它是 json 列，历史上写进过 NULL 的坏数据，
          直接 .map 会 TypeError 把整个页面炸掉 */}
      {(chapter?.pages ?? []).map((src, i) => (
        <img key={src} className="page" src={src} alt={`第 ${i + 1} 页`} />
      ))}

      {/* 底部再放一次「下一话」。一话几十页，看完滚到底还要再滚回顶部去点，
          是阅读时最烦的一件事 */}
      {chapter && next && (
        <button type="button" className="reader-step reader-next" onClick={() => go(next.chapter_number)}>
          下一话：第 {next.chapter_number} 话{next.title ? ` ${next.title}` : ''}
        </button>
      )}
    </div>
  )
}
export default MangaRead
