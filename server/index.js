import express from 'express';
import mysql from 'mysql2/promise';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';

const app = express();
const port = 3000;

// 启动前先确认两个密钥都到位，缺一个就立刻退出。
// ⚠ 为什么要在启动时查，而不是等用到了再报错：
// 这两个值现在都从环境变量读（见 server/.env），忘带 --env-file 时
// 它们就是 undefined —— 而代码本身不会因此报错。真正的报错要等到
// 有用户点登录，才在 jwt.sign 那里抛一句
// 「secretOrPrivateKey must have a value」。那时候没人看得出
// 真正的原因是启动命令少了参数。数据库密码那边更绕：报出来的是
// 一个连不上库的 ECONNREFUSED，看着像 MySQL 没开。
// 在这里挡下，错误信息直接说清楚缺什么、该怎么启动
for (const key of ['JWT_SECRET', 'DB_PASSWORD']) {
  if (!process.env[key]) {
    console.error(`缺少环境变量 ${key}。请用 npm run dev 启动（package.json 里带了 --env-file=.env），不要直接 node index.js`);
    process.exit(1);
  }
}

const SECRET = process.env.JWT_SECRET; //jwt 的签名密钥

// 解析 JSON 请求体，这样 req.body 才能拿到前端 POST 过来的数据。
// 图片不再走这里 —— 它们从 /api/manga/:id/image 那条原始二进制通道进来（express.raw），
// 所以这个 limit 只需要装得下标题/作者/标签和「话」的元数据。
// 一次提交最多 2000 页，每页路径约 45 字节 ≈ 90KB，1mb 绰绰有余。
// 顺带说一句：这个数字实际上就是服务端的页数上限，想调小之前先算一遍
app.use(express.json({ limit: '1mb' }));

// ESM 里没有 __dirname，要自己从当前文件的路径算出来
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 上传的封面图存这个目录；不存在就先建出来，不然第一次上传会报错
const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
// 挂成静态目录：这样 /uploads/m_5_某本漫画/ch01/001.jpg 就能直接被浏览器访问到。
// 注意这是个前缀匹配，路径变深（多一层漫画目录、再一层话目录）它照样管用，
// 不需要为新的目录结构改任何东西
app.use('/uploads', express.static(uploadsDir));

// ===== 上传相关的工具函数 =====

// 漫画目录名的固定前缀。结尾那个下划线不能省：
// m_1_ 和 m_10_ 靠它区分 —— m_10_x 的第二个字符是 '0' 不是 '_'，
// 所以 'm_10_x'.startsWith('m_1_') 是 false。
// 以后重构别把它简化掉，否则漫画 1 会认领漫画 10 的目录。
const dirPrefixOf = (id) => `m_${id}_`;

// 标题 → 目录名里可以安全使用的一段。
//
// 这里用的是「白名单」（只保留列举出来的字符），不是「黑名单」。
// 两者差别不是风格问题：黑名单要求你把所有危险字符一个不漏地想到，
// 而最容易漏的恰恰是 # 和 % ——
//   #  浏览器把它当 URL 片段的分隔符。<img src="/uploads/m_5_周刊 #12/ch01/001.jpg">
//      实际请求的路径在 # 处就被截断了 → 这本漫画所有图全部 404
//   %  后面跟着的不是合法十六进制时，静态服务解码失败
// 两个字符都再普通不过（「周刊 #12」「100%漫画」），后果却是整本漫画的图
// 全挂，而上传流程报的是成功 —— 静默、全面、由最寻常的数据触发。
//
// 保留中日韩文字是故意的：浏览器会把 <img src> 里的非 ASCII 自动做百分号编码，
// 静态服务再解码回 UTF-16 字符串，Windows 的 fs 最后转成 UTF-16 交给 NTFS，能对上。
// 所以目录名可以保持人能看懂。
//
// 返回空串时兜底成 untitled（标题是 ".." 或纯符号的时候会出现）
function slugify(title) {
  const kept = String(title)
    .normalize('NFKC')
    // 后面那五个 \u 是单独补的，不在任何 Script 类里：
    // Unicode 把 ー ・ 々 〆 〻 归为 Script=Common（多种文字共用），
    // 所以 \p{Script=Katakana} 并不收 ー —— 「ワンピース」会被写成「ワンピ_ス」。
    // 「ー」和「々」在中日文标题里出现得太频繁了，不放进来很难看
    .replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}A-Za-z0-9._ー・々〆〻-]/gu, '_')
    .replace(/_+/g, '_')          // 连续的下划线压成一个，免得目录名全是 ___
    .replace(/^[._]+|[._]+$/g, '') // 首尾的点和下划线去掉：开头的点会变成隐藏目录
    .slice(0, 40);
  return kept || 'untitled';
}

// mangaId → 目录名。id 不会被复用、目录不会改名，所以不用考虑失效
const dirCache = new Map();

// 找到（或第一次建出）某本漫画的目录，返回目录名（不带 uploadsDir 前缀）。
//
// 用 readdir 找前缀，而不是拿标题重新算一遍 slug：这样以后改了 slugify 的规则，
// 也照样能找到以前建的目录，不会凭空多出一个空目录、把图写到新目录里。
async function mangaDir(id, title) {
  const cached = dirCache.get(String(id));
  if (cached) return cached;

  const prefix = dirPrefixOf(id);
  const entries = await fs.promises.readdir(uploadsDir, { withFileTypes: true });
  const hits = entries.filter(e => e.isDirectory() && e.name.startsWith(prefix));

  if (hits.length > 1) {
    // 正常不会发生（id 唯一，目录只在建漫画时建一次）。
    // 真出现了就报错，而不是随便挑一个 —— 猜错了会把图写进别人的目录
    throw new Error(`前缀 ${prefix} 匹配到多个目录：${hits.map(h => h.name).join(', ')}`);
  }

  const name = hits.length === 1
    ? hits[0].name
    : `${prefix}${slugify(title)}`;

  if (hits.length === 0) {
    // fs.writeFile 不会自动建父目录，这里先建出来
    await fs.promises.mkdir(path.join(uploadsDir, name), { recursive: true });
  }
  dirCache.set(String(id), name);
  return name;
}

// 按文件头（魔术字节）判断图片格式，返回扩展名；认不出来返回 null。
//
// 为什么不看 Content-Type、也不看文件名：两个都是客户端说了算的，
// 把 a.exe 改名成 a.jpg 就能骗过去。字节是改不掉的（真改了就打不开）。
//
// 不收 SVG：它是 XML 文档，里面能塞 <script>，被直接打开时脚本会跑起来。
// 和前端 UploadModal.tsx 里那条注释是同一个理由
function sniffImage(buf) {
  if (buf.length < 12) return null;   // 下面要读到偏移 8~11，先确认够长
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  // GIF8：87a 和 89a 两种版本都能覆盖
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif';
  // WebP：RIFF 开头，并且偏移 8 处是 WEBP。两处都要验，
  // 否则任何一个 RIFF 容器（比如 wav）都会被当成 webp
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  // AVIF：偏移 4 处是 ftyp（ISO 基础媒体容器）。品牌名可能在紧跟着的位置，
  // 也可能排在兼容品牌列表里，所以在前 32 字节里找一次，不写死偏移 8
  if (buf.toString('latin1', 4, 8) === 'ftyp') {
    const brands = buf.toString('latin1', 0, Math.min(32, buf.length));
    if (brands.includes('avif') || brands.includes('avis')) return 'avif';
  }
  return null;
}

// 校验一个由客户端传上来的图片路径，确保它确实指向「这本漫画自己的目录」。
//
// 为什么不能只做前缀匹配：'/uploads/m_5_/../../etc/passwd' 是能通过前缀检查的。
// 而且浏览器在真正发请求之前就会把 '..' 解析掉，静态目录那层防护根本看不到原始字符串。
// 做法是先归一化，再要求「归一化前后一模一样」—— 任何需要被归一化的路径都直接拒绝。
function isOwnImagePath(p, id) {
  if (typeof p !== 'string' || p === '') return false;
  // % 会被静态服务解码、\ 在 Windows 上是分隔符、\0 是字符串截断，
  // 三个都直接拒绝，不留给它们任何解释空间
  if (/[%\\\0]/.test(p)) return false;
  if (p.includes('//')) return false;
  if (path.posix.normalize(p) !== p) return false;   // '..'、'./'、多余斜杠都在这一步被挡下
  return p.startsWith(`/uploads/${dirPrefixOf(id)}`);
}

// 用连接池，不要每次请求都新建连接
const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: process.env.DB_PASSWORD,   // 值在 server/.env（不上传），不要写回这里
  database: 'mangasite',
  waitForConnections: true,
  connectionLimit: 10,
});



// ===== 上传 =====
//
// 整个流程拆成三步，新本和续本只在第一步不同：
//
//   1. POST /api/manga                    建漫画行，拿到 id          （JSON，很小）
//   2. POST /api/manga/:id/image × N      一页图一个请求，原始二进制   （大头在这里）
//   3. PUT  /api/manga/:id/chapters       一次提交所有话 + 封面       （JSON，很小）
//
// 续本跳过第 1 步（id 已经有了），2、3 走的是完全相同的代码。
//
// 为什么不把图片塞进 JSON 里（这是这次改造的核心）：
//   base64 比原始字节大 1/3，请求体还有上限，一本 100~200 页、每页 1~3MB 的漫画
//   就是 200~500MB —— 必炸。而且前端要把整本的 base64 字符串存在内存里，标签页会先 OOM。
// 一页一个请求还顺带让重传天然幂等：文件名由「话号 + 页序号」推导出来，
// 重传同一页就是覆盖同一个文件，不会像以前那样每传一次多出一堆 page-xxx.jpg。
//
// 第 1 步只写一行数据库、不碰磁盘；第 3 步只写数据库、不碰磁盘。
// 只有第 2 步会留下文件，而它的每一步都是独立的，失败重试的代价很小。
//
// 下面三个接口都**不做登录校验**，未登录也能上传。这是选定的行为，不是漏写。
// 代价是清楚的：id 是自增整数、首页列表里就印着，所以任何人都能往任意一本漫画里
// 追加话、覆盖图片；manga 表上也没有归属列，「这本是谁的」无从判断。
// 别顺手把 auth 加回来 —— 那会让未登录用户点上传直接吃 401。

// 接口：新建一本漫画（标题、作者、标签），返回新漫画的 id
app.post('/api/manga', async (req, res) => {
  // req.body 用 ?? {} 兜底：Express 5 里如果没有任何解析器接手，
  // req.body 是 undefined 而不是 {}，直接解构会抛，变成一句没用的 500
  const { title, author, tags } = req.body ?? {};

  // 先 trim 成三个字符串，后面统一用 t / a / g
  const t = String(title ?? '').trim();
  const a = String(author ?? '').trim();
  const g = String(tags ?? '').trim();

  // 校验：一个都不能超过字段长度，不然 INSERT 会直接报数据库错误
  // （manga.title / author / tags 都是 varchar(100)）
  if (!t) return res.status(400).json({ error: '标题不能为空' });
  if (t.length > 100) return res.status(400).json({ error: '标题不能超过 100 个字符' });
  if (a.length > 100) return res.status(400).json({ error: '作者不能超过 100 个字符' });
  if (g.length > 100) return res.status(400).json({ error: '标签总长度不能超过 100 个字符' });

  try {
    // 查重必须在任何文件上传之前 —— 传完 300MB 才发现重名是不可接受的
    const [rows] = await pool.query('SELECT id FROM manga WHERE title = ?', [t]);
    if (rows.length > 0) {
      // 把已存在的 id 一起返回：客户端万一丢了上一次的响应（socket 重置、
      // 代理打嗝），还能拿这个 id 去问用户「是不是你刚建的那本」。
      // 不自动替他认领 —— manga 表上没有任何归属字段，自动认领等于
      // 允许往别人的漫画里追加章节
      return res.status(409).json({ error: `《${t}》已经存在了`, id: rows[0].id });
    }

    // 封面这时候还不知道（它是第一话的第一页），先插 NULL，等第 3 步再补上
    const [result] = await pool.query(
      'INSERT INTO manga (title, author, tags, cover, readcounts, lovecounts) VALUES (?, ?, ?, NULL, 0, 0)',
      [t, a || null, g || null]
    );
    res.status(201).json({ id: result.insertId, message: '创建成功' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '创建失败' });
  }
});

// 把 tags 统一转成字符串数组。
// 和前端 src/MangaOverview.tsx 里的 parseTags 是**同一套规则**，故意逐行对齐：
// 库里物理上存的是 JSON 字符串 '["热血","冒险"]'（上传时 UploadModal 写进去的），
// 老数据可能是逗号分隔的 '热血,冒险'，空的时候是 NULL。四种形状这里都要能吃。
// ⚠ 改这边必须同步改那边，否则会出现「详情页显示得出来、按标签筛选却搜不到」
function parseTags(tags) {
  if (Array.isArray(tags)) return tags;      // 已经是数组，直接返回
  if (!tags) return [];                      // null 或空，返回空数组
  const t = tags.trim();                     // 去掉首尾空格
  if (t.startsWith('[')) {                   // 可能是 JSON 字符串
    try { return JSON.parse(t); }            // 解析 JSON 字符串
    catch { return []; }
  }
  return t.split(',').map(s => s.trim()).filter(Boolean);   // 逗号分隔，去掉空字符串
}

// 接口：漫画列表，可选按标签筛选
//   GET /api/manga           → 全部漫画
//   GET /api/manga?tag=热血  → 只返回带「热血」这个标签的
//
// 关于路径：没有写成 GET /api/manga/:tag。
// 下面 300 多行处已经有 GET /api/manga/:id，Express 按注册顺序匹配，
// /api/manga/热血 会先撞上它 → WHERE id = '热血'（MySQL 把 '热血' 转成 0）
// → 查不到 → 404，:tag 那条路由永远进不去。和 /api/manga/lookup 上面那个
// ⚠ 是同一个坑。而 GET /api/manga（不带子路径）现在是空的，只有同路径的 POST，
// Express 按方法区分，不冲突。它天然就是「漫画集合」接口，
// 以后要加 ?author= / ?page= 直接往上加。
//
// 关于注册顺序：这条路由的路径里一个通配符都没有，所以放哪都不会被谁抢走。
// 放在这里是为了挨着另外两个 /api/manga 根路由，而且待在下面那个兜底错误中间件
// 之前 —— 那个中间件的注释自己写着「必须注册在所有路由之后」
//
// 关于为什么不写成 WHERE tags LIKE '%热血%'：
// tags 列是一串 JSON，但老数据是逗号分隔的，两种格式都在库里。
// LIKE 是子串匹配，'%热血%' 会把「热血少年」也一起命中 —— 那是错的；
// 想精确就得把 JSON 拆开一个个比，而 MySQL 5.7 以下没有 JSON_CONTAINS，
// 5.7+ 也没法保证这一列每行都是合法 JSON（老数据不是）。
// 所以在 Node 里用 parseTags 这套规则比，结果才和详情页显示出来的标签一致。
// 代价是把整表读回来再过滤 —— 这个库是练习量级，先这样；
// 真要优化，正确方向是加一张 manga_tags 关联表，而不是加一个 LIKE
app.get('/api/manga', async (req, res) => {
  const tag = String(req.query.tag ?? '').trim();
  // tags 列是 varchar(100)，比这长的标签库里不可能存在，先挡掉
  if (tag.length > 100) return res.status(400).json({ error: '标签不能超过 100 个字符' });

  try {
    // 注意这条 SQL 里没有任何变量 —— tag 只参与下面的 JS 比较，
    // 所以这条路由连注入面都没有，也就不需要 ? 占位符
    const [rows] = await pool.query(
      'SELECT id, title, author, created_at, updated_at, tags, cover, readcounts, lovecounts FROM manga ORDER BY id DESC'
    );
    // tag 为空就返回全部，不是 400 —— 这样它才是「集合接口」，
    // 而且 ?tag=（空值）和完全不传是同一个行为，不会多出第三种
    const list = tag ? rows.filter(m => parseTags(m.tags).includes(tag)) : rows;
    // 裸数组，和 GET /api/manga/:id/chapters 的响应形状一致
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '查询失败' });
  }
});

// 接口：按标题查漫画 id。续本用标题定位、以及标题撞车后让用户确认时用。
//
// ⚠ 这条必须注册在 GET /api/manga/:id 之前！
// Express 是按注册顺序匹配的，放在后面的话 'lookup' 会被当成 :id 的值匹配走，
// 请求永远进不到这里，而是去查一本 id 叫 "lookup" 的漫画、返回一个 404
app.get('/api/manga/lookup', async (req, res) => {
  const t = String(req.query.title ?? '').trim();
  if (!t) return res.status(400).json({ error: '请提供标题' });

  try {
    const [rows] = await pool.query('SELECT id, title FROM manga WHERE title = ?', [t]);
    if (rows.length === 0) return res.status(404).json({ error: `没有找到《${t}》` });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '查询失败' });
  }
});

// 接口：上传一页图。请求体是原始二进制（不是 JSON、不是 base64）。
// chapter 传话号（从 1 开始），或字符串 'cover' 表示封面；index 是这一页在话里的序号。
app.post(
  '/api/manga/:id/image',
  express.raw({
    // type 必须是函数形式的 () => true，不能写白名单。
    // 按 Fetch 规范，blob.type 是空字符串时浏览器「根本不发 Content-Type 头」
    // （而不是发一个空头），而 type-is 对缺失的头返回假 —— 白名单匹配不上，
    // req.body 就是 undefined。Windows 上 .avif / .jfif 这类没注册扩展名的文件
    // File.type 就是空串，正好命中这个坑
    type: () => true,
    limit: '20mb',
    // 图片本身已经是压缩过的字节流，再解压一遍纯属白送一个攻击面
    inflate: false,
  }),
  async (req, res) => {
    const { id } = req.params;

    // 别处（比如客户端误发了 Content-Type: application/json）会让全局的 express.json
    // 先一步把请求体吃掉。那时 express.raw 发现流已经读完了，就直接 next()，
    // 什么都不做 —— req.body 于是是个普通对象而不是 Buffer。
    // 不先挡住的话，下面 buf[0] 拿到的是 undefined，会报出「格式不支持」这种
    // 完全误导人的错误
    if (!Buffer.isBuffer(req.body)) {
      return res.status(400).json({ error: '图片数据无效' });
    }

    const ext = sniffImage(req.body);
    if (!ext) return res.status(400).json({ error: '不支持的图片格式（支持 PNG/JPG/GIF/WebP/AVIF）' });

    // 话号：要么是 'cover'，要么是 1~999 的整数
    const rawChapter = String(req.query.chapter ?? '');
    const isCover = rawChapter === 'cover';
    const chapterNo = Number(rawChapter);
    if (!isCover && (!Number.isInteger(chapterNo) || chapterNo < 1 || chapterNo > 999)) {
      return res.status(400).json({ error: '话号不合法' });
    }

    // index 只用来拼文件名，所以绝不能把 query 里的字符串直接拼进路径。
    // Number('0x10') 是 16、Number('1e2') 是 100、Number('../x') 是 NaN ——
    // 强转 + isInteger + 范围，三件事一起才能把它定死成一个普通整数
    const index = Number(req.query.index ?? 0);
    if (!Number.isInteger(index) || index < 0 || index > 999) {
      return res.status(400).json({ error: '页序号不合法' });
    }

    try {
      // 顺带确认这本漫画真的存在（id 是客户端传的，不可信）。
      // 建目录要用标题，正好一起取出来
      const [rows] = await pool.query('SELECT title FROM manga WHERE id = ?', [id]);
      if (rows.length === 0) return res.status(404).json({ error: '漫画不存在' });

      const dir = await mangaDir(id, rows[0].title);

      // 文件名用「话号 + 补齐的页序号」，不用原始文件名：
      // 重传同一页就是覆盖同一个文件，天然幂等；顺序由 chapters.pages 数组决定，
      // 也不靠文件名排序
      const chDir = `ch${String(chapterNo).padStart(2, '0')}`;
      const base = String(index).padStart(3, '0');
      const relUrl = isCover ? `cover.${ext}` : `${chDir}/${base}.${ext}`;
      const absPath = isCover
        ? path.join(uploadsDir, dir, `cover.${ext}`)
        : path.join(uploadsDir, dir, chDir, `${base}.${ext}`);

      // fs.writeFile 不会自动建父目录。少了这行，第一次上传每一页都会 ENOENT
      await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
      await fs.promises.writeFile(absPath, req.body);

      // 把最终路径回给客户端，第 3 步原样提交回来
      res.status(201).json({ path: `/uploads/${dir}/${relUrl}` });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: '保存失败' });
    }
  }
);

// 接口：一次性提交所有话和封面（第 3 步）。走到这里图片已经在磁盘上了，
// 这一步只写数据库。
app.put('/api/manga/:id/chapters', async (req, res) => {
  const { id } = req.params;
  const { chapters, cover } = req.body ?? {};

  // ===== 第一步：把所有校验做完，再去跟连接池要连接 =====
  // 这个顺序是有意的。连接池只有 10 条，下面一旦拿到连接就必须负责归还；
  // 校验全放在拿连接之前，「校验没过就 return」这类路径就根本没有连接可漏。
  // （文件里本来就是这个纪律，见下面 cover 那段的说明）
  if (!Array.isArray(chapters) || chapters.length === 0) {
    // 空数组会建出一本「一话都没有」的漫画：详情页点进去、阅读页 404，
    // 而它照样带着封面出现在首页上
    return res.status(400).json({ error: '至少要有 1 话' });
  }

  const numbers = [];
  for (const c of chapters) {
    const n = c?.chapterNumber;

    // 不能只判 !n。旧表单走的是 parseInt，而 JSON.stringify(NaN) 会变成 null，
    // 不挡住的话 INSERT ... chapter_number = NULL 是能成功的
    if (!Number.isInteger(n) || n < 1) {
      return res.status(400).json({ error: '话号必须是大于 0 的整数' });
    }

    // 每话必须有图。pages 是 undefined 时 JSON.stringify 返回 undefined，
    // mysql2 会往 JSON 列写 NULL，然后前端 chapter.pages.map() 直接 TypeError
    if (!Array.isArray(c.pages) || c.pages.length === 0) {
      return res.status(400).json({ error: `第 ${n} 话没有图片` });
    }

    for (const p of c.pages) {
      if (!isOwnImagePath(p, id)) {
        return res.status(400).json({ error: '图片路径不合法' });
      }
    }

    numbers.push(n);
  }

  // 批内自查重。只查数据库挡不住 {chapters:[{2},{2}]} 这种：
  // IN (2,2) 在库里查不到任何已提交的行，两条 INSERT 都会成功，
  // 于是同一本漫画里出现两话同号 —— 而读接口是 ORDER BY chapter_number，
  // 同号的两行谁先谁后是不确定的，用户刷新几次会看到不同内容
  if (new Set(numbers).size !== numbers.length) {
    return res.status(400).json({ error: '话号有重复' });
  }

  // 封面路径同样是客户端传上来的，同样会被渲进 <img src>，所以必须同样校验。
  // 不校验的话：
  //   {cover: "https://tracker.example/pixel.gif"} → 首页上挂一个第三方请求
  //   {cover: "/uploads/m_9_other/cover.jpg"}       → 盗链别的漫画的图
  // null 是允许的（表示「没设封面」）
  if (cover !== null && cover !== undefined && !isOwnImagePath(cover, id)) {
    return res.status(400).json({ error: '封面路径不合法' });
  }

  const conn = await pool.getConnection();
  try {
    // 确认这本漫画真的存在（id 是客户端传的，不可信）
    const [m] = await conn.query('SELECT id FROM manga WHERE id = ?', [id]);
    if (m.length === 0) return res.status(404).json({ error: '漫画不存在' });

    // 再和库里已有的行查重（续本时可能和已有的话撞号）
    const [dup] = await conn.query(
      `SELECT chapter_number FROM chapters WHERE manga_id = ? AND chapter_number IN (${numbers.map(() => '?').join(',')})`,
      [id, ...numbers]
    );
    if (dup.length > 0) {
      return res.status(409).json({ error: `第 ${dup[0].chapter_number} 话已经存在了` });
    }

    // 一次要插好几话，中途失败会留下「有第 1 话和第 3 话、没有第 2 话」的残缺漫画。
    // 整批要么全成、要么全不成
    await conn.beginTransaction();

    for (const c of chapters) {
      await conn.query(
        'INSERT INTO chapters (manga_id, chapter_number, title, pages) VALUES(?, ?, ?, ?)',
        [
          id,
          c.chapterNumber,
          // 章节标题是可选的：空字符串存进去会在界面上显示成一个空的标题位，
          // 不如存 NULL 让前端用 `第 N 话` 兜底
          String(c.title ?? '').trim() || null,
          JSON.stringify(c.pages),
        ]
      );
    }

    if (cover) {
      // 封面不能写死成「第一话第一页」的路径：续本时第一话的号不一定是 1，
      // 而且客户端可能手选了一张别的图。用它实际上传成功、拿到 {path} 的那一页
      await conn.query('UPDATE manga SET cover = ? WHERE id = ?', [cover, id]);
    }

    await conn.commit();
    res.json({ message: '上传成功' });
  } catch (err) {
    // 回滚本身也可能失败（连接已经断了之类），别让它的异常盖住真正的错误
    await conn.rollback().catch(() => {});
    console.error(err);
    res.status(500).json({ error: '上传失败' });
  } finally {
    // 必须放在 finally 里。连接池只有 10 条，漏还一次就是永久少一条，
    // 漏满十次之后所有请求 —— 包括纯读的接口 —— 都会永远排队等在那里
    conn.release();
  }
});

// 接口：改一本漫画的标签。
//
// 和 POST /api/manga 一样**原样存**：服务端不解析、不拆开、不重组这段文本，
// 拿到的字符串 trim 一下就写进 tags 列。格式是客户端的事 —— 上传时是
// UploadModal 做 JSON.stringify，这里是详情页那个输入框里用户自己敲的内容。
//
// 为什么不在服务端规整：详情页那个框的整个意义就是「让你看到并修改原文」。
// 如果存回来的时候偷偷按 parseTags 拆一遍再重新拼，用户改的格式就白改了 ——
// 你想把 '["1", "11"]' 改成 '["1","11"]'（去掉空格），存完一看又变回去，
// 而且不知道是谁改的。
app.put('/api/manga/:id/tags', async (req, res) => {
  const { id } = req.params;
  const { tags } = req.body ?? {};

  const mangaId = Number(id);
  if (!Number.isInteger(mangaId) || mangaId < 1) {
    return res.status(400).json({ error: 'id 不合法' });
  }

  // 长度校验和 POST /api/manga 那三条对齐：tags 是 varchar(100)。
  // 超了要么被 MySQL 截断（非严格模式）要么直接报错（严格模式），
  // 两种都不能接受 —— 客户端以为存进去了，实际存的东西已经不一样了
  const g = String(tags ?? '').trim();
  if (g.length > 100) return res.status(400).json({ error: '标签总长度不能超过 100 个字符' });

  try {
    // 空串存成 NULL，和 POST /api/manga 里的 `g || null` 保持一致。
    // 两边不一致的话，库里会同时存在 '' 和 NULL 两种「没有标签」，
    // 以后想按「没标签」筛就得写两遍条件
    const [result] = await pool.query(
      'UPDATE manga SET tags = ? WHERE id = ?',
      [g || null, mangaId]
    );

    // ⚠ 这里敢拿 affectedRows 判断「这本在不在」，是因为 mysql2 默认带
    // CLIENT_FOUND_ROWS 标志（server/node_modules/mysql2/lib/connection_config.js:232
    // 的 getDefaultFlags 里列着它；那个常量的注释原文就是
    // "found instead of affected rows"）。
    //
    // 带上它之后，UPDATE 报的是**匹配**到几行，不是**改动**了几行 ——
    // 所以「存的正好和原来一模一样」不会误报成 0。
    // 不带这个标志的话，这里必须改成先 SELECT 一次再 UPDATE，否则
    // 「值没变」会被当成「漫画不存在」，回一句莫名其妙的 404。
    // 以后谁要给 createPool 加 flags: '-FOUND_ROWS'，记得回来改这里。
    if (result.affectedRows === 0) return res.status(404).json({ error: '漫画不存在' });

    // 回的是**真正存进去的那个值**，不是客户端传来的那个 —— 中间 trim 过，
    // 空串还变成了 null。客户端拿这个值去更新界面，才不会出现
    // 「库里是 NULL、屏幕上还留着几个空格」这种两边不一致
    res.json({ tags: g || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '保存失败' });
  }
});

// 接口：删除一本漫画 —— 库里的关联行和 uploads 里的整个目录一起清掉。
//
// 故意不加 auth：manga 表**没有 user_id 列**，站里根本没有「这本是谁的」
// 这个概念，加了也只能验「有没有登录」，验不了「是不是他的」。和三个上传
// 接口保持一致。以后真要做归属，得先给 manga 加一列再说。
app.delete('/api/manga/:id', async (req, res) => {
  const { id } = req.params;
  // id 来自地址栏，绝不能直接拼进 SQL 或者当路径用。
  // Number('0x10') 是 16、Number('1e2') 是 100、Number('') 是 0 ——
  // 强转 + isInteger + 范围，三件事一起才能把它定死成一个普通正整数
  const mangaId = Number(id);
  if (!Number.isInteger(mangaId) || mangaId < 1) {
    return res.status(400).json({ error: 'id 不合法' });
  }

  try {
    // 先确认这本真的存在。不然删一个不存在的 id 也会回 ok，
    // 前端那边就分不出「删掉了」和「本来就没有」
    const [rows] = await pool.query('SELECT id FROM manga WHERE id = ?', [mangaId]);
    if (rows.length === 0) return res.status(404).json({ error: '漫画不存在' });

    // 先删子表，再删 manga。
    //
    // chapters 上写着 ON DELETE CASCADE，删 manga 会自动跟着走；
    // 但 favorites 和 likes 上**一条外键都没有**（全库只有
    // fk_chapters_manga 和 fk_favorites_series 两条），所以这两个得自己删 ——
    // 不删就留下一堆指向已不存在的 manga_id 的悬空行，
    // 以后某个新漫画万一拿到复用的 id，会凭空多出别人的收藏和点赞。
    //
    // 不加事务：三句都是幂等的 DELETE，中途失败重试一次就行。
    // 顺序先子后父，最坏情况是「漫画还在、少了几条收藏」，
    // 而不是「漫画没了、子表还在」—— 后者才是真正会留脏数据的那个方向
    await pool.query('DELETE FROM favorites WHERE manga_id = ?', [mangaId]);
    await pool.query('DELETE FROM likes WHERE manga_id = ?', [mangaId]);
    await pool.query('DELETE FROM manga WHERE id = ?', [mangaId]);

    // 库删完了，缓存里的目录名也就没意义了，先清掉。
    // dirCache 是按 id 存的，而 id 是会被复用的（复位自增、或者这行被删后
    // 又重新 INSERT 到同一个 id），不清的话下次这个 id 会拿到一个
    // 已经不存在的目录名
    dirCache.delete(String(mangaId));

    // 再删目录。这一步整个包在自己的 try 里，失败只记日志、照样回 ok ——
    // 因为库已经干净了，漫画在界面上已经没了。这时候回一句 500「删除失败」，
    // 客户端会以为没删掉，其实记录早没了、图片被留下来成了孤儿目录。
    // 报错的时机比错误本身更容易骗人。
    //
    // 挂在同一个 try 里还顺带挡住了 uploadsDir 不存在的情况：readdir 会
    // ENOENT，而那时候要删的东西本来也不存在
    try {
      // 这里不能调 mangaDir()：它**没找到目录就会 mkdir 出来**（上传要的
      // 正是这个），而删除要的恰好相反 —— 为了删一个目录先建一个出来。
      // 所以自己 readdir 查一遍，只读不建。
      //
      // 前缀匹配到多个目录时全删（正常不会发生，见 mangaDir 里那条说明）。
      // 删除场景下多删是对的：前缀相同的目录本来就都是这本的残留
      const prefix = dirPrefixOf(mangaId);
      const entries = await fs.promises.readdir(uploadsDir, { withFileTypes: true });
      const hits = entries.filter(e => e.isDirectory() && e.name.startsWith(prefix));
      for (const hit of hits) {
        // force 让「目录不存在」不抛错；recursive 连 ch01/ 和里面的图一起删。
        // 用 fs.promises.rm 而不是 rmdir —— rmdir 只能删空目录
        await fs.promises.rm(path.join(uploadsDir, hit.name), { recursive: true, force: true });
      }
    } catch (err) {
      console.error('删除漫画目录失败（库已删，留下孤儿目录）:', err);
    }

    res.json({ message: 'ok' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '删除失败' });
  }
});

// 接口：按 id 查询单个漫画详情
app.get('/api/manga/:id', async (req, res) => {
  const { id } = req.params;   // 从地址里取出 :id（注意：GET 用 params，不是 body）

  try {
    const [rows] = await pool.query(
      'SELECT id, title, author, created_at, updated_at, tags, cover, readcounts, lovecounts FROM manga WHERE id = ?',
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: '漫画不存在' });
    }

    res.json(rows[0]);   // 直接返回查到的这一条数据
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '查询失败' });
  }
});
// 接口：某本漫画的章节列表。
// 故意不返回 pages —— 阅读页要先用它渲一个话的选择器，
// 每话的图片路径加起来可能有好几 KB，而且这里用不上。
// 顺带说一句，这条取代了原来的 GET /api/manga/:id/read：
// 那个接口只返回第一话，导致第 2、3 话建出来之后没有任何入口能读到
app.get('/api/manga/:id/chapters', async (req, res) => {
  const { id } = req.params;

  try {
    const [rows] = await pool.query(
      'SELECT id, chapter_number, title FROM chapters WHERE manga_id = ? ORDER BY chapter_number ASC',
      [id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '查询失败' });
  }
});

// 接口：某一话的内容（含页面图片路径）
app.get('/api/manga/:id/chapters/:number', async (req, res) => {
  const { id, number } = req.params;
  // 话号来自地址栏。不是整数就直接挡掉，不要拿一个乱七八糟的字符串去查库
  const n = Number(number);
  if (!Number.isInteger(n)) return res.status(400).json({ error: '话号不合法' });

  try {
    const [rows] = await pool.query(
      'SELECT id, manga_id, chapter_number, title, pages FROM chapters WHERE manga_id = ? AND chapter_number = ?',
      [id, n]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: '这一话不存在' });
    }

    // pages 是 json 列，mysql2 会自动解析成数组，这里不用再 JSON.parse
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '查询失败' });
  }
});

// 接口：阅读量 +1（点「开始阅读」时调用）
app.post('/api/manga/:id/read-count', async (req, res) => {
  const { id } = req.params;

  try {
    // 直接 +1，不用先查出来再加
    await pool.query('UPDATE manga SET readcounts = readcounts + 1 WHERE id = ?', [id]);
    res.json({ message: 'ok' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '更新失败' });
  }
});



// ===== 兜底的错误中间件 =====
//
// 四个参数是 Express 认出「这是错误处理器」的标志，少一个就会被当成普通中间件，
// 结果是它永远不会被调用、也不报错。它必须注册在所有路由之后。
//
// 加这个的直接原因：body-parser 抛的错（请求体超限、JSON 语法错）以前没人接，
// 会落到 Express 内置的默认处理器上，返回的是**一张 HTML 错误页**。
// 而前端拿到响应一律 r.json() —— 解析 HTML 会抛，于是掉进 .catch()，
// 用户看到的永远是「网络错误，请重试」，真实原因（比如「这一页超过 20MB」）
// 一点都透不出来。这里把它们转成 JSON，让前端能显示人话。
app.use((err, req, res, next) => {
  // 响应已经开始往外发了（比如流到一半出错），此时改不了状态码，
  // 交给 Express 自己收尾，否则会抛 ERR_HTTP_HEADERS_SENT
  if (res.headersSent) return next(err);

  // 优先认 status，而不是认 type 字符串：http-errors 一定会保留 status，
  // 而自定义字段 type 在层层包装之后还在不在，不是能指望的事
  const status = err?.status || err?.statusCode || 500;

  if (status === 413) {
    // err.limit 是触发上限的那个字节数（express.raw 的 20mb 或 express.json 的 1mb），
    // 拿它换算成人看的 MB，提示才是准的
    const mb = err?.limit ? Math.round(err.limit / 1024 / 1024) : null;
    return res.status(413).json({ error: mb ? `数据太大（上限 ${mb}MB）` : '数据太大' });
  }

  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '请求体不是合法的 JSON' });
  }

  console.error(err);
  res.status(status).json({ error: '服务器内部错误' });
});

















// ===== 鉴权中间件（写一次，所有接口共用）=====
// 硬鉴权：必须带有效 token，验不过直接返回 401，不再往下走
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: '未登录' });
  try {
    req.user = jwt.verify(token, SECRET);   // { userId, username } 挂到 req 上
    next();                                 // 放行，交给后面的路由函数
  } catch (e) {
    return res.status(401).json({ error: '无效或过期的 token' });
  }
}

// 软鉴权：带了有效 token 就解出来，没带或过期也放行（此时 req.user 是 undefined）
function optionalAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (token) {
    try { req.user = jwt.verify(token, SECRET); }
    catch (e) { /* 忽略，当作未登录 */ }
  }
  next();   // 无论如何都放行
}

//jwt解码
app.get('/api/jwt', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  try {
    const data = jwt.verify(token, SECRET);
    res.json({ userId: data.userId, username: data.username });
  } catch (e) {
    res.status(401).json({ error: '无效或过期的 token' });
  }
});

// 接口：查询当前登录用户的完整信息（邮箱、注册时间等）
app.get('/api/me', auth, async (req, res) => {
  try {
    // 注意：不查 password，密码永远不要返回给前端
    const [rows] = await pool.query(
      'SELECT id, username, email, created_at FROM user WHERE id = ?',
      [req.user.userId]
    );
    if (rows.length === 0) return res.status(404).json({ error: '用户不存在' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '查询失败' });
  }
});

//接口: 查询当前登录用户的收藏列表（id、title、cover、所属系列）
app.get('/api/me/myfavorites', auth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT m.id AS manga_id, m.title, m.cover, f.series_id
       FROM manga m
       JOIN favorites f ON m.id = f.manga_id
       WHERE f.user_id = ?
       ORDER BY f.created_at DESC, f.id DESC`,
      [req.user.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '查询失败' });
  }
});

//接口: 我的系列列表（带每个系列里的收藏数量）
app.get('/api/me/series', auth, async (req, res) => {
  try {
    // LEFT JOIN：空系列也要列出来（COUNT 会是 0），所以不能用 JOIN
    const [rows] = await pool.query(
      `SELECT s.id, s.name, s.created_at, COUNT(f.id) AS manga_count
       FROM series s
       LEFT JOIN favorites f ON f.series_id = s.id
       WHERE s.user_id = ?
       GROUP BY s.id, s.name, s.created_at
       ORDER BY s.created_at ASC, s.id ASC`,
      [req.user.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '查询失败' });
  }
});

//接口: 新建系列
app.post('/api/series', auth, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '系列名不能为空' });
  try {
    const [result] = await pool.query(
      'INSERT INTO series (user_id, name) VALUES (?, ?)',
      [req.user.userId, name.trim()]
    );
    res.status(201).json({ id: result.insertId, name: name.trim() });
  } catch (err) {
    // uk_user_series 这个唯一索引挡下的重名
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: '已有同名系列' });
    }
    console.error(err);
    res.status(500).json({ error: '创建失败' });
  }
});

//接口: 系列改名
app.put('/api/series/:id', auth, async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '系列名不能为空' });
  try {
    // 先确认这个系列是当前用户的（id 由前端传，不可信）
    const [rows] = await pool.query('SELECT id FROM series WHERE id = ? AND user_id = ?', [id, req.user.userId]);
    if (rows.length === 0) return res.status(404).json({ error: '系列不存在' });

    await pool.query('UPDATE series SET name = ? WHERE id = ? AND user_id = ?', [name.trim(), id, req.user.userId]);
    res.json({ message: 'ok' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: '已有同名系列' });
    }
    console.error(err);
    res.status(500).json({ error: '改名失败' });
  }
});

//接口: 删除系列（里面的收藏会回到「未分类」，因为外键是 ON DELETE SET NULL）
app.delete('/api/series/:id', auth, async (req, res) => {
  const { id } = req.params;
  try {
    const [result] = await pool.query('DELETE FROM series WHERE id = ? AND user_id = ?', [id, req.user.userId]);
    if (result.affectedRows === 0) return res.status(404).json({ error: '系列不存在' });
    res.json({ message: 'ok' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '删除失败' });
  }
});

// ===== 导航栏「分类」下拉里的两组链接 =====
// 存在 nav_link 表（见 schema.sql）。和那三个上传接口一样**不鉴权** ——
// 本项目按「本地单人使用」设计。⚠ 部署到公网的话，任何人都能改你导航栏的分类。

// 只认这两个组名。为什么要在这里挡一道：group_name 是主键的一部分，
// 放任意值进来就等于让请求方往库里塞新分组，而前端只渲染这两组 ——
// 那些行会静静地堆在库里，永远不会显示出来，也没有任何界面能删掉它们
const NAV_GROUPS = ['主题', '作者'];

//接口: 导航栏的全部链接
app.get('/api/nav-links', async (req, res) => {
  try {
    // ORDER BY 带上 name 是因为 created_at 只精确到秒：同一秒里连着加两条
    // 会排不出先后，加个 name 兜底让顺序稳定（不然每次刷新顺序可能变）
    const [rows] = await pool.query(
      'SELECT group_name, name, created_at FROM nav_link ORDER BY group_name, created_at, name'
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '查询失败' });
  }
});

//接口: 新增一条导航链接
app.post('/api/nav-links', async (req, res) => {
  const group = String(req.body?.group ?? '').trim();
  const name = String(req.body?.name ?? '').trim();
  if (!NAV_GROUPS.includes(group)) return res.status(400).json({ error: '分组不对' });
  if (!name) return res.status(400).json({ error: '名称不能为空' });
  // name 列是 varchar(50)，超了 MySQL 默认会截断或报错（取决于 SQL 模式），
  // 先在这里挡掉，让错误信息说清楚是哪个字段的问题
  if (name.length > 50) return res.status(400).json({ error: '名称不能超过 50 个字符' });

  try {
    await pool.query('INSERT INTO nav_link (group_name, name) VALUES (?, ?)', [group, name]);
    res.status(201).json({ group, name });
  } catch (err) {
    // 主键 (group_name, name) 挡下的重名
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: '这一组里已经有同名的了' });
    console.error(err);
    res.status(500).json({ error: '创建失败' });
  }
});

//接口: 删除一条导航链接
// 为什么要删哪一条是放在 query 里，而不是像 DELETE /api/series/:id 那样放路径：
// 这里的「主键」是用户自由输入的文本，可能含 / # + 这些字符 ——
// 放进路径段要么被 Express 拆错（/ 会被当成层级），要么得来回编码。
// query 里这些字符都有确定的编码方式，没有歧义
app.delete('/api/nav-links', async (req, res) => {
  const group = String(req.query.group ?? '').trim();
  const name = String(req.query.name ?? '').trim();
  if (!group || !name) return res.status(400).json({ error: '缺少 group 或 name' });

  try {
    const [result] = await pool.query(
      'DELETE FROM nav_link WHERE group_name = ? AND name = ?',
      [group, name]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: '这一项不存在' });
    res.json({ message: 'ok' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '删除失败' });
  }
});

//接口: 把某本收藏放进系列（seriesId 传 null 表示移出系列，回到未分类）
app.put('/api/favorites/:mangaId/series', auth, async (req, res) => {
  const { mangaId } = req.params;
  const { seriesId } = req.body;
  const sid = seriesId ?? null;
  try {
    // 指定了系列的话，先确认这个系列属于当前用户，否则就能把收藏塞进别人的系列
    if (sid !== null) {
      const [s] = await pool.query('SELECT id FROM series WHERE id = ? AND user_id = ?', [sid, req.user.userId]);
      if (s.length === 0) return res.status(404).json({ error: '系列不存在' });
    }

    // 再确认这本确实在「我」的收藏里（没收藏就没得归类）
    const [fav] = await pool.query('SELECT id FROM favorites WHERE user_id = ? AND manga_id = ?', [req.user.userId, mangaId]);
    if (fav.length === 0) return res.status(404).json({ error: '尚未收藏这本漫画' });

    await pool.query(
      'UPDATE favorites SET series_id = ? WHERE user_id = ? AND manga_id = ?',
      [sid, req.user.userId, mangaId]
    );
    res.json({ message: 'ok' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '更新失败' });
  }
});

// 接口：注册新用户
app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body;

  try {
    const [rows] = await pool.query(
      'SELECT * FROM user WHERE username = ? OR email = ?',
      [username, email]
    );

    if (rows.length > 0) {
      return res.status(400).json({ error: '用户名或邮箱已存在' });
    }

    const [result] = await pool.query(
      'INSERT INTO user (username, email, password) VALUES (?, ?, ?)',
      [username, email, password]
    );

    // 用 insertId 直接签 token，注册完就相当于自动登录了
    const token = jwt.sign(
      { userId: result.insertId, username },
      SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({ message: '注册成功', token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '注册失败' });
  }
});

// 登录接口
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const [rows] = await pool.query(
      'SELECT * FROM user WHERE username = ? AND password = ?',
      [username, password]
    );

    if (rows.length > 0) {
      const token = jwt.sign(
        { userId: rows[0].id, username },
        SECRET,
        { expiresIn: '7d' }
      );
      res.json({ message: '登录成功', token });
    } else {
      res.status(401).json({ error: '用户名或密码错误' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '登录失败' });
  }
});

// 接口：一次返回「最多点阅」和「最多爱心」两个榜单
app.get('/api/mangasite', async (req, res) => {
  try {
    const [rowsMostread] = await pool.query(
      'SELECT id, title, author, created_at, updated_at, tags, cover, readcounts, lovecounts FROM manga ORDER BY readcounts DESC LIMIT 8'
    );
    const [rowsMostliked] = await pool.query(
      'SELECT id, title, author, created_at, updated_at, tags, cover, readcounts, lovecounts FROM manga ORDER BY lovecounts DESC LIMIT 8'
    );
    res.json({
      'rows-mostread': rowsMostread,
      'rows-mostliked': rowsMostliked,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '数据库查询失败' });
  }
});
//接口:是否已点喜欢（「进入mangaoverview」时调用）
app.get('/api/manga/:id/islike', optionalAuth, async (req, res) => {
  if (!req.user) return res.json({ liked: false });   // 没登录（或 token 过期）
  const { id } = req.params;
  try {
    const [rows] = await pool.query('SELECT id FROM likes WHERE user_id = ? AND manga_id = ?', [req.user.userId, id]);
    res.json({ liked: rows.length > 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '查询失败' });
  }
});

// 接口：点赞/取消喜欢
app.post('/api/manga/:id/update-like', auth, async (req, res) => {
  const { id } = req.params;
  try {
    const [rows] = await pool.query('SELECT id FROM likes WHERE user_id = ? AND manga_id = ?', [req.user.userId, id]);
    if (rows.length === 0) {
      await pool.query('INSERT INTO likes (user_id, manga_id) VALUES (?, ?)', [req.user.userId, id]);
      await pool.query('UPDATE manga SET lovecounts = lovecounts + 1 WHERE id = ?', [id]);
      const [mangaRows] = await pool.query('SELECT lovecounts FROM manga WHERE id = ?', [id]);
      res.json({ liked: true, lovecounts: mangaRows[0].lovecounts });
    } else {
      await pool.query('DELETE FROM likes WHERE user_id = ? AND manga_id = ?', [req.user.userId, id]);
      await pool.query('UPDATE manga SET lovecounts = lovecounts - 1 WHERE id = ?', [id]);
      const [mangaRows] = await pool.query('SELECT lovecounts FROM manga WHERE id = ?', [id]);
      res.json({ liked: false, lovecounts: mangaRows[0].lovecounts });
    }

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '更新失败' });
  }
})

// 接口：是否已收藏（进入 mangaoverview 时调用）
app.get('/api/manga/:id/isfavorite', optionalAuth, async (req, res) => {
  if (!req.user) return res.json({ favorited: false });   // 没登录（或 token 过期）
  const { id } = req.params;
  try {
    const [rows] = await pool.query('SELECT id FROM favorites WHERE user_id = ? AND manga_id = ?', [req.user.userId, id]);
    res.json({ favorited: rows.length > 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '查询失败' });
  }
});

// 接口：收藏/取消收藏
app.post('/api/manga/:id/update-favorite', auth, async (req, res) => {
  const { id } = req.params;
  try {
    const [rows] = await pool.query('SELECT id FROM favorites WHERE user_id = ? AND manga_id = ?', [req.user.userId, id]);
    if (rows.length === 0) {
      // 还没收藏：插入（series 暂时不填，默认 NULL = 未分类）
      await pool.query('INSERT INTO favorites (user_id, manga_id) VALUES (?, ?)', [req.user.userId, id]);
      res.json({ favorited: true });
    } else {
      await pool.query('DELETE FROM favorites WHERE user_id = ? AND manga_id = ?', [req.user.userId, id]);
      res.json({ favorited: false });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '更新失败' });
  }
});
app.listen(port, () => console.log(`后端运行在 http://localhost:${port}`));