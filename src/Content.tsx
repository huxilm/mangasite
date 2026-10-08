import './Content.css'
import { useState, useEffect } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

// 漫画数据项的类型（对应后端 manga 表返回的字段）
interface Manga {
    id: number
    title: string
    author: string
    cover: string | null
    readcounts: number
    lovecounts: number
    updated_at: string
    created_at: string
    tags: string[]
}

function Content() {
    // 1. 用 state 存后端返回的数据（初始是空数组）
    const [readList, setReadList] = useState<Manga[]>([])
    const [likedList, setLikedList] = useState<Manga[]>([])
    // 「最近更新」那一盒。和上面两个排行榜同一个接口、同一次挂载，
    // 所以下面 effect 里顺手就把它一起设了，不另开一个请求
    const [updatedList, setUpdatedList] = useState<Manga[]>([])

    // 地址栏里的 ?tag=。导航栏「分类」下拉点一下就跳到 /?tag=xxx
    // （App.tsx 里用 <Link> 拼的），这里把它读出来。
    // get() 返回的**已经是解码过的**值，所以千万别再 decodeURIComponent 一次 ——
    // 标签里合法地含 % 时会抛 URIError，而 %2520 会被解码两遍变成空格
    const [searchParams] = useSearchParams()
    const tag = (searchParams.get('tag') ?? '').trim()

    // 把「这份结果属于哪个标签」和结果存在同一个对象里。
    // 光存一个数组是不够的：从分类1 切到分类2、响应还没回来的那段时间里，
    // 屏幕上仍然显示着分类1 的结果，看着就像点击没生效。
    // 渲染时用 result.tag === tag 判断手里这份是不是过期的，过期就显示「加载中」。
    // 附带好处：清空旧结果不需要在 effect 里 setState ——
    // 那会多出一条 oxlint 的 react(set-state-in-effect) 警告，全项目现在只有 3 条
    const [result, setResult] = useState<{ tag: string; list: Manga[] } | null>(null)

    // 2. 组件挂载时执行一次，去后端拿数据
    useEffect(() => {
        fetch('/api/mangasite')
            .then(r => r.json())           // 把响应体解析成 JSON 对象
            .then(data => {
                // ⚠ 三个都用 ?? [] 兜一下。后端没重启的话新键是 undefined，
                // 不兜就是 undefined.map(...) —— 整页白屏，而且从界面上完全
                // 看不出是「后端还在跑旧代码」
                setReadList(data['rows-mostread'] ?? [])
                setLikedList(data['rows-mostliked'] ?? [])
                setUpdatedList(data['rows-updated'] ?? [])
            })
    }, [])

    // 3. 按标签筛选。和上面那个 effect 分开写是故意的 ——
    //    合在一起的话，每点一次「分类」都会把 /api/mangasite 也重新拉一遍，
    //    而那个接口返回的是两个排行榜，和标签筛选毫无关系
    useEffect(() => {
        if (!tag) return          // 没有 ?tag= 就压根不发请求，首页和改动前一模一样
        // 旧请求比新请求晚回来时，别让它把新结果挤掉。
        // 没有这个开关的话：点了分类1（慢）再点分类2（快），分类2 先渲染出来，
        // 然后分类1 的响应到达、把 result 覆盖回分类1 —— 界面永远停在「加载中」
        let cancelled = false
        fetch(`/api/manga?tag=${encodeURIComponent(tag)}`)
            .then(r => r.json())
            .then(data => {
                if (cancelled) return
                // 后端出错时返回的是 { error: '…' } 而不是数组，按空结果处理
                setResult({ tag, list: Array.isArray(data) ? data : [] })
            })
            .catch(() => { if (!cancelled) setResult({ tag, list: [] }) })
        return () => { cancelled = true }   // tag 变了或组件卸载了，这次请求作废
    }, [tag])

    // 4. 用拿到的数据渲染列表
    return (
        <div className="content">
            <div className="most-read">
                <div className="title">最多点阅</div>
                <div className="item-list">
                    {readList.map(manga => (
                        <Link className="mostread-item" to={`/manga-overview/${manga.id}`} key={manga.id}>
                            <div className="cover">
                                <img src={manga.cover ?? undefined} alt={manga.title} />
                            </div>
                            <span>{manga.title}</span>
                        </Link>
                    ))}
                </div>
            </div>
            <div className="most-liked">
                <div className="title">最多爱心</div>
                <div className="item-list">
                    {likedList.map(manga => (
                        <Link className="mostliked-item" to={`/manga-overview/${manga.id}`} key={manga.id}>
                            <div className="cover">
                                <img src={manga.cover ?? undefined} alt={manga.title} /></div>
                            <span>{manga.title}</span>
                        </Link>
                    ))}
                </div>
            </div>

            {/* 最近更新：全部漫画，按 updated_at 倒序。
                 位置放在另外两盒后面是故意的 —— 那两块是 display:none，
                 占不到地方，所以这一盒就是直接打开 / 时第一眼看到的东西。

                 类名不借 .mostread-item / .tagresult-item，自己起一个。
                 理由同 Content.css 里那段：那两块是「保持原样别再动」，
                 借了类名就把三块绑在一起了。
                 color 也不写死 #000000（那两块写死了），这一块是可见的，
                 深色模式下 #000000 压在 #16171d 的底上是一个字都看不见的 */}
            {!tag && (
                <div className="recent-update">
                    <div className="title">最近更新</div>
                    <div className="item-list">
                        {updatedList.map(manga => (
                            <Link className="recentupdate-item" to={`/manga-overview/${manga.id}`} key={manga.id}>
                                <div className="cover">
                                    <img src={manga.cover ?? undefined} alt={manga.title} />
                                </div>
                                <span>{manga.title}</span>
                            </Link>
                        ))}
                    </div>
                </div>
            )}

            {/* 按标签筛选的结果。?tag= 为空时整块连标题都不渲染，
                   所以没点分类的时候首页和改动前完全一样（那两块仍然是 display:none）。

                   条件写成 result && result.tag === tag：两个作用，
                   ① 还没拿到「当前这个标签」的响应时，落到「加载中」
                   ② TS 在这个分支里能把 result 收窄成非 null，下面才能直接写 result.list */}
            {tag && (
                <div className="tag-result">
                    <div className="title">{tag}</div>
                    {result && result.tag === tag ? (
                        result.list.length > 0 ? (
                            <div className="item-list">
                                {result.list.map(manga => (
                                    <Link className="tagresult-item" to={`/manga-overview/${manga.id}`} key={manga.id}>
                                        <div className="cover">
                                            <img src={manga.cover ?? undefined} alt={manga.title} />
                                        </div>
                                        <span>{manga.title}</span>
                                    </Link>
                                ))}
                            </div>
                        ) : (
                            // 空结果和「加载中」必须分开：占位名 分类1/2/3 在库里不存在，
                            // 所以空结果才是常走的那条路。判据是 result.tag === tag，
                            // 只有当前标签的响应真的回来了才会显示这句，
                            // 点下去不会先闪一下「没有找到」
                            <div className="tag-empty">没有找到带「{tag}」标签的漫画</div>
                        )
                    ) : (
                        <div className="tag-empty">加载中…</div>
                    )}
                </div>
            )}
        </div>
    )
}
export default Content