import { useState, useEffect, useRef, type ChangeEvent } from 'react'
import './UploadModal.css'

type Toast = { message: string; type: 'success' | 'warning' } | null

// ===== 各种上限，都必须和后端对得上 =====

// 单页图片上限。必须等于 server/index.js 里 express.raw({ limit: '20mb' }) 的 20mb，
// 两边不一致的话，本地预检放行、服务端返回 413，用户要到传到第 N 页才知道
const MAX_PAGE_BYTES = 20 * 1024 * 1024

// 总页数上限。这个数是从后端 express.json({ limit: '1mb' }) 反推的：
// 一页的路径约 45 字节，1mb 大概装得下两万多页，取 2000 留足余量。
// 注意后端那个 limit 实际上就是「最多多少页」的硬上限，改这里之前先回去算一遍
const MAX_PAGES = 2000

// 同时飞几个上传请求。太小了白等（一页一页传 300 页要几分钟），
// 太大了把浏览器对同一域名的连接数占满，页面上其他请求（封面、章节列表）会饿死
const CONCURRENCY = 4

// 单个请求超时。没有它的话后端一挂，界面就永远停在「上传中… 12/182」，
// 既没有结果也不能重试
const REQUEST_TIMEOUT_MS = 60_000

// 「第 1 步建好了但没传完」的记录。第 1 步的响应要是在路上丢了
// （socket 重置、代理打嗝），客户端就再也不知道那个 id，
// 重试只会永远撞在「标题已存在」上。存一份在本地，下次打开弹窗能提示继续
const PENDING_KEY = 'mangasite_pending_upload'

// 允许的图片扩展名。必须和后端 sniffImage() 认得的魔术字节集合对齐：
// 两边不一致就会「客户端悄悄丢掉、服务端本来收得下」的静默丢文件
// （或者反过来，传到第 150 页才被服务端拒掉）。
// 刻意不收 svg：它是 XML 文档，里面能嵌 <script>，被直接打开时脚本会跑起来
const IMAGE_EXTS = ['jpg', 'jpeg', 'jfif', 'jpe', 'png', 'gif', 'webp', 'avif']

// 标签盒里列出来的候选标签。现在是占位数据，将来换成真正的清单
// （从后端取、或者从已有漫画的 tags 里统计都行，换的是这一行的来源，
// 用它的那段 JSX 不用动）
const TAG_OPTIONS = Array.from({ length: 12 }, (_, i) => `占位${i + 1}`)

// ===== 选中的文件夹在内存里的样子 =====
//
// 只存 File 对象，不存内容。File 只是个磁盘文件句柄（名字 + 大小 + 指向磁盘的引用），
// 放在 state 里几乎不占内存。
// 改之前 `contents: string[]` 存的是整本漫画的 base64 字符串 —— 一本 200 页的漫画
// 就是几百 MB，标签页会先 OOM，根本轮不到请求发出去
// 一话：话号 + 可选的标题 + 这一话的所有图片文件。
//
// 这个形状在流程里出现两次，所以单独起个名字：
//   读出来的（Picked）和准备提交的（Planned）其实是同一个东西，
//   只是「谁产出它」不同 —— 一个是 buildTree 扫出来的，一个是 flatten 拉平出来的。
// 只写一份的好处不只是少几行：以前这里有过 pages / files 两个字段名指同一件事，
// 而 PUT 请求体里那个 pages 又是别的东西（是路径字符串数组，不是 File 数组）——
// 同一个词指两种东西、两个词指同一种东西，读代码时要在脑子里维护一张对照表
type ChapterPages = { number: number; title: string | null; pages: File[] }

type Picked = {
  rootName: string
  chapters: ChapterPages[]
  skipped: number   // 因为不是图片被跳过的文件数
  merged: number    // 来自更深层子目录、被并进上一层那一话的文件数
  loose: number     // 有子目录时，根目录下被忽略的散图数
}

// 「读出来的」和「准备提交的」用同一个形状。
// 名字分开留着是为了让 buildTree / flatten / runUpload 的签名各自读起来顺，
// 它们指的是同一个类型，可以互相赋值
type PickedChapter = ChapterPages
type PlannedChapter = ChapterPages

// 一个待上传的请求：一页图（或封面）
type PlannedPage = {
  key: string                        // '话号:页序号'，或 'cover:0'
  label: string                      // 出错时给人看的名字
  chapter: number | 'cover'
  index: number
  file: File
}

type UploadResult =
  | { ok: true; mangaId: string }
  | { ok: false; error: string; fatal: boolean; conflictId?: string; failed?: number }

// ===== 纯函数 =====

// 获取后缀名
function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

// 判断允许的类型中是否包含获得的后缀名
function isImage(name: string): boolean {
  return IMAGE_EXTS.includes(extOf(name))
}

// 排序用的比较器。
// numeric: true 让 '10.jpg' 排在 '9.jpg' 后面（按数比，不是按字符比）。
// 但光有这个不够：numeric 模式下 '01.jpg'、'1.jpg'、'第1话' 会被判成「相等」，
// 而 sort 是稳定排序 —— 同分时保留的是 webkitdirectory 给的枚举顺序，
// 也就是文件系统返回目录项的顺序。换台机器、或者把文件夹拷一次，顺序就可能变，话号跟着全乱。
// 后面那个不带选项的 localeCompare 是决胜局：只有前面返回 0 时才轮到它，
// 它逐字符比，一定给出确定的结果，把顺序钉死
function byPath(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true }) || a.localeCompare(b)
}

// 把 webkitdirectory 给的一长串文件，整理成「一本漫画 = 若干话」。
// 规则（写死在这里，免得改的时候靠猜）：
//   <root>/a.jpg            → 根目录的图
//   <root>/第1话/a.jpg      → 第1话的图
//   <root>/第1话/raw/a.jpg  → 还算第1话的图，只是计入 merged 提示一下
// 返回 null 表示这批文件用不了（空的、或者拿不到顶层目录名）。
// ⚠ 参数是**真数组**，不是 FileList。调用方必须先在清 value 之前 Array.from 一份 ——
// 直接把 e.target.files 传进来是不行的，见 handleDirectory 里那段说明
function buildTree(files: File[]): Picked | null {
  // 拿顶层目录名，兼当输入校验
  const rootName = files[0]?.webkitRelativePath.split('/')[0] ?? ''
  if (!rootName) return null

  // 对象数组
  const images: { file: File; parts: string[] }[] = []
  let skipped = 0

  for (const file of files) {
    // webkitRelativePath 形如 'root/第1话/001.jpg'。
    // 理论上一定存在（webkitdirectory 就是为了它），但为空时退回用文件名，
    // 当作根目录的图处理，总比崩了强
    const rel = file.webkitRelativePath || file.name
    if (!isImage(file.name)) {
      skipped++
      continue
    }
    // slice(1) 去掉第一段（就是 folders 本身），剩下的 parts[0] 才是话目录
    images.push({ file, parts: rel.split('/').slice(1) })
  }

  // 先按完整相对路径整体排一次。后面每一话内部再怎么切，都是从这排好的顺序里切，
  // 所以话内顺序天然就是对的
  images.sort((a, b) => byPath(a.parts.join('/'), b.parts.join('/')))

  const inSubdir = images.filter(x => x.parts.length >= 2)
  const atRoot = images.filter(x => x.parts.length < 2)

  // 情况一：没有子目录，根目录直接就是一堆图 → 整包当一话，标题留空
  if (inSubdir.length === 0) {
    return {
      rootName,
      chapters: atRoot.length ? [{ number: 1, title: null, pages: atRoot.map(x => x.file) }] : [],
      skipped,
      merged: 0,
      loose: 0,
    }
  }

  // 情况二：有子目录 → 一个子目录一话。
  // 深度 ≥ 3 的（'第1话/raw/001.jpg'）不再单独成话，直接并进它上面那一话，
  // 但顺序仍然按完整相对路径算。扫本里这种结构非常常见，
  // 不处理的话用户会看到「识别到 3 话」，而其中一话只有真实长度的三分之一
  // Map 是 JS 内置的键值对表
  const groups = new Map<string, File[]>()
  //                       ↑       ↑
  //                    键的类型  值的类型
  let merged = 0
  for (const x of inSubdir) {
    const dir = x.parts[0]
    if (x.parts.length > 2) merged++
    const list = groups.get(dir)
    if (list) list.push(x.file)
    else groups.set(dir, [x.file])
  }

  // 话与话之间也按名字排一次（数字感知，所以「第2话」在「第10话」前面）
  const names = [...groups.keys()].sort(byPath)
  const chapters: PickedChapter[] = names.map((name, i) => ({
    // 话号是「排完序的下标 + 1」，不是从目录名里猜的数字 ——
    // 目录名叫「第一话」「序章」「番外」的时候就猜不出来了，而下标永远有
    number: i + 1,
    title: name,
    pages: groups.get(name) ?? [],
  }))

  // 有子目录时根目录下的散图就不管了。两套规则同时生效的话，
  // 用户会以为那几张也是一话，结果它们谁也不属于 —— 与其静默丢掉，
  // 不如数出来明说。常见来源：文件夹根目录下躺着一张封面.jpg
  return { rootName, chapters, skipped, merged, loose: atRoot.length }
}

// 给一棵树算个「指纹」。用来判断用户是不是换了一个文件夹 ——
// 换了就必须把「已传过的页」清空，理由见 sentRef 那段注释
function treeSignature(p: Picked | null): string {
  if (!p) return ''
  return [
    p.rootName,
    p.chapters.length,
    p.chapters.map(c => c.pages.length).join(','),
    p.chapters[0]?.pages[0]?.name ?? '',
    p.chapters[p.chapters.length - 1]?.pages.at(-1)?.name ?? '',
  ].join('|')
}

// 续本选中的文件夹整棵拉平成一话，包括子目录里的图，仍按完整相对路径排序。
// 不拉平的话，上面那套深度规则会替续本做决定，把子目录变成「第1话、第2话」——
// 而用户已经明确说了这些是第 N 话
function flatten(p: Picked, number: number, title: string): PlannedChapter {
  return {
    number,
    title: title.trim() || null,
    pages: p.chapters.flatMap(c => c.pages),
  }
}

// 5xx 是服务端自己的问题，重试有意义；4xx 是这次请求本身不对，
// 重试 182 次只是「体力活版的错误探测」。
// 401 尤其要立刻停：token 过期了，剩下 181 次注定全失败
function isRetryable(status: number): boolean {
  return status >= 500 || status === 408 || status === 429
}

// 上传一页，返回它的最终路径（或者失败原因）。
// 不做任何重试：重试的策略在上一层，这里只负责如实报告这一次的结果
async function uploadOne(
  job: PlannedPage,
  mangaId: string,
  token: string | null,
): Promise<{ ok: true; path: string } | { ok: false; fatal: boolean; error: string }> {
  const query = new URLSearchParams({ chapter: String(job.chapter), index: String(job.index) })

  try {
    const res = await fetch(`/api/manga/${mangaId}/image?${query}`, {
      method: 'POST',
      // 不手写 Content-Type：交给浏览器按 File 的类型自动带。
      // 后端的 express.raw 配的是 type: () => true，带不带都收
      headers: { Authorization: `Bearer ${token}` },
      body: job.file,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!res.ok) {
      // 后端现在有错误中间件了，超限/坏格式都会返回 JSON。
      // 拿不到就退回到状态码，总比一句「网络错误」强
      const data = await res.json().catch(() => null)
      return {
        ok: false,
        fatal: !isRetryable(res.status),
        error: data?.error ?? `HTTP ${res.status}`,
      }
    }

    const data = await res.json()
    return { ok: true, path: String(data.path) }
  } catch {
    // fetch 抛异常只可能是：网络断了、被超时 abort 掉了、CORS。
    // 三种都值得原样重试，所以 fatal 是 false
    return { ok: false, fatal: false, error: '网络错误或超时' }
  }
}

type RunUploadOptions = {
  mangaId: string | null      // 有值就跳过「建漫画」那一步（续本、或者上次建好了没传完）
  title: string
  author: string
  tags: string
  chapters: PlannedChapter[]
  coverFile: File | null      // 手选的封面；null 表示不单独传封面
  autoCover: boolean          // true = 用第一话第一页当封面（只有新本该这么做）
  sent: Set<string>           // 已传成功的页，键和 PlannedPage.key 一致
  paths: Map<string, string>  // 页 → 服务端返回的路径
  onProgress: (done: number, total: number) => void
}

// 一次完整上传。分三个阶段，各自可以单独重试：
//   create  建漫画行（只有新本需要）
//   images  传每一页（大头）
//   commit  提交话和封面（纯数据库操作）
// 已经做完的阶段不会重跑 —— 尤其是 images：300 页传到第 200 页失败，
// 重试点一下不该把那 200 页再传一遍
async function runUpload(opts: RunUploadOptions): Promise<UploadResult> {
  const token = localStorage.getItem('mangasitetoken')
  let mangaId = opts.mangaId

  // ===== 阶段一：确信拿到漫画 id =====
  if (!mangaId) {
    let res: Response
    try {
      res = await fetch('/api/manga', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: opts.title, author: opts.author, tags: opts.tags }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch {
      return { ok: false, error: '网络错误或超时', fatal: false }
    }

    const data = await res.json().catch(() => null)
    if (res.status === 409) {
      // 后端把已存在的那本的 id 一起返回了。交给用户确认 —— 不自动认领：
      // manga 表上没有任何归属字段，自动认领等于允许往别人的漫画里追加章节
      return {
        ok: false,
        error: data?.error ?? '标题已存在',
        fatal: true,
        conflictId: data?.id ? String(data.id) : undefined,
      }
    }
    if (!res.ok) {
      return { ok: false, error: data?.error ?? `HTTP ${res.status}`, fatal: !isRetryable(res.status) }
    }

    mangaId = String(data.id)
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify({ id: mangaId, title: opts.title }))
    } catch {
      // 隐私模式 / 存储配额满时 localStorage 会抛。不影响上传本身，忽略
    }
  }

  // ===== 阶段二：把所有图传上去 =====
  const jobs: PlannedPage[] = []
  for (const c of opts.chapters) {
    c.pages.forEach((file, i) => {
      jobs.push({
        key: `${c.number}:${i}`,
        label: `第 ${c.number} 话第 ${i + 1} 页`,
        chapter: c.number,
        index: i,
        file,
      })
    })
  }
  const coverJob: PlannedPage | null = opts.coverFile
    ? { key: 'cover:0', label: '封面', chapter: 'cover', index: 0, file: opts.coverFile }
    : null
  const all = coverJob ? [...jobs, coverJob] : jobs

  const todo = all.filter(j => !opts.sent.has(j.key))
  let done = all.length - todo.length
  opts.onProgress(done, all.length)

  let fatalError: string | null = null
  let failed = 0
  let firstError = ''

  // 手写的并发池。为什么不用 Promise.all 一批一批发：
  // 一批里只要有一个 reject，Promise.all 就立刻放弃剩下三个还在飞的请求，
  // 它们的 reject 没人接，变成 unhandled rejection。
  // 这里的 worker 内部自己吞掉所有异常，永远不会 reject
  let cursor = 0
  const workers = Array.from({ length: Math.min(CONCURRENCY, todo.length) }, async () => {
    while (cursor < todo.length && !fatalError) {
      // 读 cursor 和自增之间没有 await。JS 是单线程的，
      // 一个 worker 从读完到写回不会被切走，所以不会有两个 worker 拿到同一页
      const job = todo[cursor++]
      const r = await uploadOne(job, mangaId as string, token)

      if (r.ok) {
        opts.paths.set(job.key, r.path)
        opts.sent.add(job.key)
      } else if (r.fatal) {
        // 401、413 这类：再传剩下的没有意义，让所有 worker 立刻停下来
        fatalError = r.error
      } else {
        failed++
        if (!firstError) firstError = `${job.label} ${r.error}`
      }

      done++
      opts.onProgress(done, all.length)
    }
  })
  await Promise.all(workers)

  if (fatalError) return { ok: false, error: fatalError, fatal: true }
  if (failed > 0) {
    // 收齐了再报，而不是遇到第一个错就返回 —— 用户想知道的是一共差多少页，
    // 不是第一页错在哪。失败的页没有进 sent，所以点重试只会补这些
    return { ok: false, error: `${failed} 页没传成功（${firstError}）`, fatal: false, failed }
  }

  // ===== 阶段三：一次提交所有话和封面 =====
  // 封面路径：手选了就用那张；否则新本用第一话第一页的路径（后端已经返回过它，
  // 不用再传一遍造成重复文件）；续本传 null，表示「别动这本原有的封面」——
  // 续本的第一页是新一话的第一页，拿它当整本的封面是错的
  const coverPath = coverJob
    ? opts.paths.get(coverJob.key) ?? null
    : opts.autoCover
      ? opts.paths.get(jobs[0]?.key ?? '') ?? null
      : null

  try {
    const res = await fetch(`/api/manga/${mangaId}/chapters`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        chapters: opts.chapters.map(c => ({
          chapterNumber: c.number,
          title: c.title,
          // 路径用的是服务端返回给我们的值，不是客户端自己拼的。
          // 后端会校验它确实指向这本漫画自己的目录。
          // 注意这里变成了字符串数组 —— 请求体里的 pages 是「路径」，不是 File
          pages: c.pages.map((_, i) => opts.paths.get(`${c.number}:${i}`)),
        })),
        cover: coverPath,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!res.ok) {
      const data = await res.json().catch(() => null)
      return { ok: false, error: data?.error ?? `HTTP ${res.status}`, fatal: !isRetryable(res.status) }
    }
  } catch {
    return { ok: false, error: '网络错误或超时', fatal: false }
  }

  // 走完整条流程，第 1 步那条「没传完」的记录才作废
  try {
    localStorage.removeItem(PENDING_KEY)
  } catch {
    // 同上，忽略
  }
  return { ok: true, mangaId }
}

// ===== 组件 =====

function UploadModal({ onClose }: { onClose: () => void }) {
  const [isNew, setIsNew] = useState(true)

  // 新本
  const [title, setTitle] = useState('')
  const [author, setAuthor] = useState('')
  const [tags, setTags] = useState('')

  // 续本
  const [resumeId, setResumeId] = useState('')
  const [chapterNumber, setChapterNumber] = useState<number | null>(null)
  const [chapterTitle, setChapterTitle] = useState('')

  const [picked, setPicked] = useState<Picked | null>(null)
  // 手选的封面。null = 用第一话的第一张
  const [coverFile, setCoverFile] = useState<File | null>(null)

  const [uploading, setUploading] = useState(false)
  // 防重入用 ref，不用 state —— 原因见 handleSubmit 里的注释
  const uploadingRef = useRef(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [toast, setToast] = useState<Toast>(null)
  // 第 1 步建好了、但内容没传完的那本。让用户确认后才接着用
  const [createdId, setCreatedId] = useState<string | null>(null)
  const [conflictId, setConflictId] = useState<string | null>(null)
  // 上次留下、还没传完的记录（localStorage 里翻出来的）。
  // 用惰性初始化而不是放在 useEffect 里读：这样只读一次、只 render 一次。
  // 写成「初始 null + 挂载后 setState」的话，弹窗每次打开都要先白渲染一轮空状态
  const [stale, setStale] = useState<{ id: string; title: string } | null>(() => {
    try {
      const raw = localStorage.getItem(PENDING_KEY)
      return raw ? JSON.parse(raw) : null
    } catch {
      // 存的东西坏了（手改过、或者格式对不上）就当没有，不影响上传
      return null
    }
  })

  // 已成功上传的页。键是 '话号:页序号'。
  // 必须和「当前这棵目录树 + 当前漫画 id」绑在一起，树一变就清空。
  // 不绑的话：传 A 文件夹传到 150 页失败 → 用户改选 B 文件夹再点重试 →
  // B 的前 149 页会**静默跳过**（键正好撞上了），最后得到一本缺页的漫画
  const sentRef = useRef<Set<string>>(new Set())
  const pathsRef = useRef<Map<string, string>>(new Map())
  const scopeRef = useRef('')

  // 进度节流用。300 页会触发 300 次 setProgress，而每次 render 都要重渲
  // 那串话列表，界面会卡成幻灯片。攒着，最多每 100ms 刷一次
  const lastFlushRef = useRef(0)
  const flushTimerRef = useRef<number | null>(null)

  // toast提示框提示 1.5 秒后自动消失
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 1500)
    return () => clearTimeout(timer)
  }, [toast])

  // 卸载时把攒着的那个定时器清掉，否则它会在组件没了之后再 setState
  useEffect(() => () => {
    if (flushTimerRef.current !== null) clearTimeout(flushTimerRef.current)
  }, [])

  // 收敛过的进度更新。到点就立刻刷，没到点就挂一个定时器，
  // 保证「最后那一两次」也一定会显示出来，不会永远停在 178/182
  const onProgress = (done: number, total: number) => {
    const now = Date.now()
    if (now - lastFlushRef.current >= 100) {
      lastFlushRef.current = now
      setProgress({ done, total })
      return
    }
    if (flushTimerRef.current !== null) return
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null
      lastFlushRef.current = Date.now()
      setProgress({ done, total })
    }, 100)
  }

  // 当前输入框里已经有哪些标签。
  // **直接从 tags 推出来，不另存一份 state** —— 用户是可以直接在输入框里手打、
  // 手删的（不是只能靠点标签盒），另存一份 Set 的话他一改就对不上了。
  // 下面 handleTagClick 和 JSX 里那个高亮都用这一个来源，规则只有一份
  const tagList = tags.split(',').map(s => s.trim()).filter(Boolean)

  // 点候选标签 → 切换它的选中状态，结果写回上面那个「标签」输入框。
  // 存的是逗号分隔的字符串（提交时 handleSubmit 里还会再 split 一次），
  // 所以这里也拼成同一种格式 —— 用户看到的和最终提交的是同一份数据，
  // 不会出现「点了标签，提交时却没带上」这种对不上的情况
  const handleTagClick = (name: string) => {
    // 先按「和提交时完全相同的规则」拆一遍（就是上面那个 tagList）。
    // 一举两得：① 能判断这个标签是不是已经加过了
    //          ② 顺手把用户随手打的「热血 ,  冒险」规整成「热血, 冒险」
    // 已选过 → 再点一次是取消；没选过 → 追加到末尾。
    // 用 filter 而不是「按位置删掉那一个」：手打出来的「热血, 热血」会一起去掉 ——
    // 点这一下的意思本来就是「这一栏里不要热血了」
    setTags(
      (tagList.includes(name) ? tagList.filter(t => t !== name) : [...tagList, name]).join(', ')
    )
  }

  // 选文件夹
  const handleDirectory = (e: ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files
    if (!list || !list.length) return
    // ⚠⚠ 先把 FileList 拷贝成真数组，再清 value —— 这两行的顺序绝对不能反。
    //
    // e.target.files 拿到的**不是一份快照，而是一个活的 FileList**：它和这个
    // input「当前选中了什么」绑在一起。下面那句 value = '' 一执行，列表当场变空，
    // 手里这个引用也跟着空 —— 于是 buildTree 里 files[0] 是 undefined，
    // rootName 成了空串，一句 !rootName 就把整个文件夹判成「读不出来」。
    // Array.from 之后就脱离 input 了，后面随便清。
    //
    // 症状是「不管选哪个文件夹、用哪个浏览器，都提示读不出来」—— 因为它和
    // 文件夹里的东西、和文件夹叫什么名字，一点关系都没有。
    //（HEAD 那版这个函数第一句就是 Array.from(files)，而且没有 value = ''，
    //  所以没这个问题；重构时 value = '' 被插到了它前面，顺序就坏了）
    const files = Array.from(list)
    // 清空 value：否则用户改完文件夹里的图再选同一个文件夹，不会触发 change
    e.target.value = ''

    const tree = buildTree(files)
    if (!tree) {
      setToast({ message: '这个文件夹读不出来，换一个试试', type: 'warning' })
      return
    }
    if (!tree.chapters.length) {
      setToast({ message: '这个文件夹里没有图片', type: 'warning' })
      return
    }

    setPicked(tree)
    // 换了文件夹，之前那张手选封面就不作数了（它属于另一本）。
    // 这里能无条件清，是因为封面的输入框要 picked 非空才渲染 —— 能走到这一行，
    // 说明之前一定已经选过一次文件夹了，这次就是「换一本」。
    // 两处是绑着的：要是哪天把封面块改成不依赖 picked，这里必须跟着改成 `if (picked)`，
    // 否则「先挑封面、再选文件夹」会把用户刚选的封面清掉
    setCoverFile(null)
    // 目录树变了，已传记录全部作废 —— 见 sentRef 那段注释
    sentRef.current = new Set()
    pathsRef.current = new Map()
    scopeRef.current = ''
    setProgress({ done: 0, total: 0 })
    // 新本没填过标题的话，用文件夹名预填。猜错了能当场改，不用删了重传
    if (isNew && !title.trim()) setTitle(tree.rootName.slice(0, 100))
  }

  // 手选封面
  const handleCoverFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    if (!isImage(file.name)) {
      setToast({ message: '封面只支持 PNG / JPG / GIF / WebP / AVIF', type: 'warning' })
      return
    }
    if (file.size > MAX_PAGE_BYTES) {
      setToast({ message: '封面超过 20MB 了', type: 'warning' })
      return
    }
    setCoverFile(file)
  }

  // 预览图。用 createObjectURL 而不是读成 base64：
  // 读 base64 要把整个文件塞进内存和 state 里，而这里只需要浏览器能显示
  const previewFile = coverFile ?? picked?.chapters[0]?.pages[0] ?? null
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!previewFile) {
      setPreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(previewFile)
    setPreviewUrl(url)
    // 清理函数在「换文件」和「组件卸载」时都会跑。
    // 少了它每换一次封面就在内存里留一张图的 blob，一路换下去页面会越来越卡
    return () => URL.revokeObjectURL(url)
  }, [previewFile])

  // 切换新本/续本：把上一个模式选的东西全清掉。
  // 不清的话，在新本里选的 300 页会跟着进到续本，直接传成别人的一话
  const switchMode = (next: boolean) => {
    if (next === isNew) return
    setIsNew(next)
    setPicked(null)
    setCoverFile(null)
    setTitle('')
    setAuthor('')
    setTags('')
    setResumeId('')
    setChapterNumber(null)
    setChapterTitle('')
    setCreatedId(null)
    setConflictId(null)
    sentRef.current = new Set()
    pathsRef.current = new Map()
    scopeRef.current = ''
    setProgress({ done: 0, total: 0 })
  }

  const endUpload = () => {
    uploadingRef.current = false
    setUploading(false)
  }

  const handleSubmit = async () => {
    // 用 ref 判断而不是 state：这个函数在同一次点击里会先 setUploading(true)
    // 再去 await，过程中闭包读到的 state 还是旧值，守卫等于没生效
    if (uploadingRef.current) return

    if (!picked || !picked.chapters.length) {
      setToast({ message: '请先选择漫画所在的文件夹', type: 'warning' })
      return
    }

    // 组装成统一形状：新本用它原本的话，续本把整棵树拉平成用户指定的那一话
    let chapters: PlannedChapter[]
    let effectiveId = createdId

    if (isNew) {
      if (!title.trim()) {
        setToast({ message: '请填写标题', type: 'warning' })
        return
      }
      // 不用再逐字段搬一遍了：PickedChapter 和 PlannedChapter 现在是同一个类型，
      // picked.chapters 直接就是能提交的形状
      chapters = picked.chapters
    } else {
      const n = chapterNumber
      if (!n || !Number.isInteger(n) || n < 1) {
        setToast({ message: '请填写第几话（大于 0 的整数）', type: 'warning' })
        return
      }
      if (!resumeId.trim() && !title.trim()) {
        setToast({ message: '标题和 id 至少填一个', type: 'warning' })
        return
      }

      // 续本必须有 id 才能传图（图片接口是按 id 走的），
      // 只填了标题就先把它解析成 id
      if (!effectiveId && !resumeId.trim()) {
        try {
          // encodeURIComponent将url里的保留字符转成百分号编码
          const res = await fetch(`/api/manga/lookup?title=${encodeURIComponent(title.trim())}`)
          const data = await res.json().catch(() => null)
          if (!res.ok) {
            setToast({ message: data?.error ?? '找不到这本漫画', type: 'warning' })
            return
          }
          effectiveId = String(data.id)
        } catch {
          setToast({ message: '网络错误，请重试', type: 'warning' })
          return
        }
      }
      if (!resumeId.trim() && !effectiveId) {
        setToast({ message: '找不到这本漫画', type: 'warning' })
        return
      }

      chapters = [flatten(picked, n, chapterTitle)]
    }

    // ===== 本地预检：把注定会失败的情况挪到开工前 =====
    const totalPages = chapters.reduce((s, c) => s + c.pages.length, 0)
    if (totalPages > MAX_PAGES) {
      setToast({ message: `一次最多传 ${MAX_PAGES} 页，这次有 ${totalPages} 页`, type: 'warning' })
      return
    }
    const tooBig = chapters.flatMap(c => c.pages).find(f => f.size > MAX_PAGE_BYTES)
    if (tooBig) {
      // 别传到第 150 页才失败 —— 前 149 页已经在磁盘上了
      setToast({ message: `「${tooBig.name}」超过 20MB，先压缩一下`, type: 'warning' })
      return
    }

    // 换了文件夹（或者换了漫画）就把已传记录清空
    const scope = `${effectiveId ?? resumeId.trim() ?? 'new'}|${treeSignature(picked)}`
    if (scopeRef.current !== scope) {
      scopeRef.current = scope
      sentRef.current = new Set()
      pathsRef.current = new Map()
    }

    uploadingRef.current = true
    setUploading(true)
    setConflictId(null)
    setToast(null)
    // 先把总数填上。新本要先发一个「建漫画」的请求，那一个来回里
    // runUpload 还没报过进度，不预置的话按钮会显示「上传中… 0/0」，
    // 看着像什么都没发生
    setProgress({ done: 0, total: totalPages + (coverFile ? 1 : 0) })

    const result = await runUpload({
      mangaId: effectiveId ?? (resumeId.trim() || null),
      title: title.trim(),
      author: author.trim(),
      // 标签：'热血, 冒险' → '["热血","冒险"]'。
      // 存 JSON 字符串是为了和库里已有的数据（'["1", "11"]'）保持同一格式，
      // 详情页的 parseTags 就是照这个读回来的
      tags: (() => {
        const list = tags.split(',').map(s => s.trim()).filter(Boolean)
        return list.length ? JSON.stringify(list) : ''
      })(),
      chapters,
      coverFile,
      // 只有新本才拿第一页当封面。续本的第一页是新一话的第一页，
      // 拿它当整本的封面是错的
      autoCover: isNew,
      sent: sentRef.current,
      paths: pathsRef.current,
      onProgress,
    })

    if (result.ok) {
      setToast({ message: '上传成功', type: 'success' })
      // 这里故意不 endUpload()：锁一直握到弹窗关闭为止。
      // 一放锁按钮就恢复可点，而弹窗要 1 秒后才关 —— 用户在这 1 秒里再点一次，
      // 预览图和已传集合都还在，会走重试那条路，在同一个位置重复插一次
      setTimeout(onClose, 1000)
      return
    }

    if (result.conflictId) {
      // 标题撞车。后端把已存在的那本的 id 给我们了，但要用户点一下确认 ——
      // 见 runUpload 里的说明
      setCreatedId(result.conflictId)
      setConflictId(result.conflictId)
    }
    setToast({ message: result.error, type: 'warning' })
    endUpload()
  }

  // 顶部那几条横幅（都是「有件事需要你先决定」）
  // 处理之前未传完的
  const banner = isNew && stale ? (
    <div className="upload-banner">
      上次有一本'{stale.title}'没传完。重新选同一个文件夹再点上传，已传过的页会自动跳过。
      <div className="upload-banner-actions">
        <button
          type="button"
          className="modal-btn"
          onClick={() => {
            setCreatedId(stale.id)
            setTitle(stale.title)
            setStale(null)
          }}
        >
          接着传
        </button>
        <button
          type="button"
          className="modal-btn"
          onClick={() => {
            // 只是不再提示，不动 localStorage 里的记录 ——
            // 用户可能只是这次不想传，下次打开还要看得见
            setStale(null)
          }}
        >
          忽略
        </button>
      </div>
    </div>
  ) : conflictId ? (
    <div className="upload-banner">
      这本漫画已经存在（id {conflictId}）。如果就是你刚建的那本，点下面继续补传。
      <div className="upload-banner-actions">
        <button
          type="button"
          className="modal-btn"
          onClick={() => {
            // createdId 已经在撞车时设好了，这里只是把这个提示收起来
            setConflictId(null)
          }}
        >
          是我的，继续
        </button>
        <button type="button" className="modal-btn" onClick={() => { setCreatedId(null); setConflictId(null) }}>
          不是，我改个标题
        </button>
      </div>
    </div>
  ) : null

  // 选中文件夹之后的摘要。每一种「被丢掉的东西」都要说清楚，
  // 不能沉默 —— 用户以为传了 182 页、实际只传了 160 页是最坏的情况
  const summary = picked ? [
    picked.chapters.length === 1
      ? `识别到 1 话，共 ${picked.chapters[0].pages.length} 页`
      : `识别到 ${picked.chapters.length} 话，共 ${picked.chapters.reduce((s, c) => s + c.pages.length, 0)} 页`,
    picked.skipped ? `跳过 ${picked.skipped} 个非图片文件` : '',
    picked.merged ? `有 ${picked.merged} 个文件来自更深层的子目录，已并入它上面那一话` : '',
    picked.loose ? `根目录下有 ${picked.loose} 张散图，因为已经有子目录了，这次不会上传` : '',
    !isNew && picked.chapters.length > 1 ? '续本会把整个文件夹拉平成一话' : '',
  ].filter(Boolean).join('；') : ''

  const totalPages = picked?.chapters.reduce((s, c) => s + c.pages.length, 0) ?? 0

  return (
    // 点遮罩层关窗。上传中不给关：App.tsx 里是 {showUpload && <UploadModal/>}，
    // 一点就把组件卸载了 —— 飞行中的 fetch 不属于组件会继续跑完，
    // 但最后那个 PUT 永远不会发生。结果是一条零话、没封面的漫画行占着标题，
    // 外加一整个目录的真图，而删除功能不在这个项目里。
    //
    // ⚠ 这里必须用 mousedown，不能用 click。
    // click 的 target 不是「松手的地方」，而是 mousedown 和 mouseup 两个目标的
    // 「最近公共祖先」。在输入框里按下、把鼠标拖到弹窗外才松手（拖选文字时
    // 很常见）—— 两个目标的公共祖先正好是这个遮罩，于是它被当成了「点了遮罩」。
    // 而 click 的传播路径是 mask → body → …，表单是遮罩的**后代**、不在路径上，
    // 所以下面 form 上那句 stopPropagation 根本没机会执行，拦不住。
    // mousedown 没有这个问题：按下那一刻光标在哪，target 就是谁。
    // 再比对 target === currentTarget，是为了排除「按在弹窗里、mousedown
    // 从弹窗冒泡上来」——那种情况 target 是弹窗里的元素，不是遮罩本身
    <div
      className="modal-mask"
      onMouseDown={uploading ? undefined : e => { if (e.target === e.currentTarget) onClose() }}
    >
      <form
        className="modal upload-modal"
        noValidate
        onClick={e => e.stopPropagation()}
        onSubmit={e => { e.preventDefault(); handleSubmit() }}
      >
        <h3 className="upload-title">上传漫画</h3>
        <div className="upload-type">
          <button type="button" className="modal-btn" onClick={() => switchMode(true)}>新本</button>
          <button type="button" className="modal-btn" onClick={() => switchMode(false)}>续本</button>
        </div>

        {banner}

        {/* 左右两栏：左栏是原来那堆输入框，右栏是标签盒。
            滚动的仍然只有左栏 —— 标题、切换按钮、提交按钮和右边的标签盒都固定不动 */}
        <div className="upload-body">
          {/* 中间这段单独包一层，让「只有它」能滚：标题、切换按钮和提交按钮固定不动。
              内容一多（比如选了封面，预览图很高）弹窗会冲出屏幕，提交按钮就点不到了 */}
          <div className="upload-scroll">
            {isNew ? (
              <>
                <input
                  type="text"
                  placeholder="标题（默认用文件夹名）"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                />
                <input
                  type="text"
                  placeholder="作者"
                  value={author}
                  onChange={e => setAuthor(e.target.value)}
                />
                <input
                  type="text"
                  placeholder="标签，用逗号分隔"
                  value={tags}
                  onChange={e => setTags(e.target.value)}
                />
              </>
            ) : (
              <>
                <input
                  type="text"
                  placeholder="标题（标题/id 填一个）"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                />
                <input
                  type="text"
                  placeholder="id（标题/id 填一个）"
                  value={resumeId}
                  onChange={e => setResumeId(e.target.value)}
                />
                <input
                  type="text"
                  placeholder="第几话（必填）"
                  value={chapterNumber !== null ? chapterNumber : ''}
                  onChange={e => setChapterNumber(e.target.value ? parseInt(e.target.value) : null)}
                />
                <input
                  type="text"
                  placeholder="章节标题"
                  value={chapterTitle}
                  onChange={e => setChapterTitle(e.target.value)}
                />
              </>
            )}

            <label className="upload-label">
              漫画内容，放在文件夹中（一本漫画一个文件夹；有子目录就一个子目录一话）
            </label>
            {/* webkitdirectory 是浏览器的非标准属性，React 的类型里没有它，
              用展开写法绕过属性检查（值给空字符串：它是布尔属性，存在即为开） */}
            <input type="file" {...{ webkitdirectory: '' }} onChange={handleDirectory} />

            {picked && <div className="upload-summary">{summary}</div>}

            {/* 要 picked 非空才渲染，两个理由：
                ① 「第一话」这时才存在 —— 默认封面就是从它身上取的，还没选文件夹时这句话没意义
                ② 这样「先挑封面、再选文件夹」这个顺序就不可能出现，于是 handleDirectory 里
                   那句无条件的 setCoverFile(null) 永远是对的。两处是绑着的，改一处要看另一处 */}
            {isNew && picked && (
              <>
                <label className="upload-label">
                  封面（默认用第一话的第一张，想换就自己选一张）
                </label>
                <input type="file" accept={IMAGE_EXTS.map(e => `.${e}`).join(',')} onChange={handleCoverFile} />
                {/* 选完先给自己看一眼 */}
                {previewUrl && <img className="upload-preview" src={previewUrl} alt="封面预览" />}
              </>
            )}
          </div>

          {/* 标签盒。只在「新本」渲染 —— 标签是 POST /api/manga 的参数，
              续本压根不建漫画行，这个盒子对续本没有意义。
              按钮必须写 type="button"：不写的话在 <form> 里默认类型就是 submit，
              点一下标签会顺手把整个表单提交出去 */}
          {isNew && (
            <div className="tag-box">
              {/* <div className="tag-box-title">标签</div> */}
              <div className="tag-list">
                {TAG_OPTIONS.map(t => {
                  // 选中与否完全由 tags 算出来（判断规则就是上面那个 tagList），
                  // 所以手打进输入框的「占位3」也会跟着亮 —— 不需要额外的 state
                  const on = tagList.includes(t)
                  return (
                    <button
                      type="button"
                      key={t}
                      className={on ? 'tag-chip tag-chip-on' : 'tag-chip'}
                      // aria-pressed 是给读屏软件的：这个按钮现在是「开关」，
                      // 光靠颜色变紫，看不见颜色的人不知道它按没按过。
                      // 写上去之后读屏会念「已按下/未按下」。和视觉上的高亮是同一份状态
                      aria-pressed={on}
                      onClick={() => handleTagClick(t)}
                    >{t}</button>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        {uploading && progress.total > 0 && (
          <div className="upload-progress">
            {progress.done} / {progress.total}
            {/* 进度条用 width 百分比。用 <progress> 也行，但它的默认样式
                各浏览器差很多，还要写一堆 ::-webkit- 去压 */}
            <div className="upload-progress-bar">
              <div
                className="upload-progress-fill"
                style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
              />
            </div>
          </div>
        )}

        {/* type="submit"：这样在输入框里按回车也能提交 */}
        <button type="submit" className="modal-submit" disabled={uploading}>
          {uploading
            ? `上传中… ${progress.done}/${progress.total}`
            : totalPages > 0 ? `上传（${totalPages} 页）` : '上传'}
        </button>
        {toast && <div className={`toast ${toast.type}`}>{toast.message}</div>}
      </form>
    </div>
  )
}

export default UploadModal
