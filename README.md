# Mangasite

一个自己搭的本地漫画站。上传整本漫画，在线阅读，可以点赞、收藏，还能把收藏归类到自己建的「系列」里。

> **免责声明**
> 本项目仅供本地开发与学习使用，请勿用于分发受版权保护的内容。
> 上传接口没有鉴权（见下方「已知限制」），请不要直接部署到公网。

## 功能

- **上传漫画** —— 选一个文件夹整包上传，或按话分目录批量上传；带进度、失败可续传
- **在线阅读** —— 按话切分、逐页翻页
- **标签** —— 上传时打标签，导航栏按标签筛选，详情页可随时改
- **点赞 / 收藏** —— 每本一份，重复点算取消
- **收藏分组** —— 在个人页把收藏归类到自己建的「系列」里
- **删除漫画** —— 连带话、图片、收藏、点赞一起清掉

## 技术栈

| 层 | 用了什么 |
|---|---|
| 前端 | React 19 · TypeScript · Vite · react-router-dom |
| 后端 | Node.js · Express 5 · jsonwebtoken · mysql2 |
| 数据库 | MySQL 8（`utf8mb4` / `utf8mb4_0900_ai_ci`） |
| 图片 | 不上云，落在后端磁盘的 `server/uploads/` |

前端没有额外的状态管理库，数据靠 `fetch` + `useState`；后端没有 ORM，SQL 直接写在 `server/index.js` 里。

## 环境要求

- **Node.js ≥ 20.6** —— 后端启动脚本用了 `node --env-file`，这个参数是 20.6 才有的。低于这个版本会直接报 `bad option`
- **MySQL 8.0 或更高** —— 建表脚本里用了 `utf8mb4_0900_ai_ci` 排序规则，这是 MySQL 8 才引入的
- **pnpm** —— 仓库里两份锁文件都是 `pnpm-lock.yaml`

## 目录结构

```
mangasite/
├── src/                    前端
│   ├── App.tsx             路由 + 导航栏 + 上传弹窗入口
│   ├── Content.tsx         首页（点阅榜 / 爱心榜 / 标签筛选结果）
│   ├── MangaOverview.tsx   详情页
│   ├── MangaRead.tsx       阅读页
│   ├── UserInfo.tsx        个人页：我的收藏 + 系列分组
│   ├── UploadModal.tsx     上传弹窗（三步：建本 → 传图 → 提交话和封面）
│   └── *Modal.tsx          注册 / 登录
├── server/
│   ├── index.js            全部后端代码，含所有接口
│   ├── schema.sql          建库建表
│   ├── .env.example        环境变量模板（可以提交）
│   └── .env                你自己的真实配置（**不提交**）
├── public/                 静态资源，含默认封面
└── vite.config.ts          开发服务器配置，把 /api 和 /uploads 代理到后端
```

漫画图片存在 `server/uploads/`，按 `m_<id>_<标题>_<话号>` 分目录。**这个目录不进仓库**（几百 MB 的二进制，重新上传就能再生出来），首次启动后端时会自动创建。

## 快速开始

### 1. 准备数据库

```bash
mysql -u root -p < server/schema.sql
```

这会建出 `mangasite` 库和 6 张表。建表顺序在脚本里已经排好了（`manga` / `series` 要先于引用它们的外键建出来）。

### 2. 配置后端环境变量

```bash
cd server
cp .env.example .env
```

然后编辑 `server/.env`，填两个值：

| 变量 | 填什么 |
|---|---|
| `DB_PASSWORD` | 你的 MySQL 密码（用户名在 `server/index.js` 里，默认 `root`） |
| `JWT_SECRET` | 一串随机字符。生成一个：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

⚠ **不要图省事写 `123456`**。这个密钥是登录 token 唯一的防伪依据 —— 知道它的人不需要任何密码，自己签一个 token 就能冒充任意用户。

### 3. 启动后端

```bash
cd server
pnpm install
pnpm dev
```

跑在 `http://localhost:3000`。

> `pnpm dev` 实际执行的是 `node --env-file=.env index.js`。**直接敲 `node index.js` 会失败** —— 少了 `--env-file`，那两个变量就是空的，程序会立刻退出并告诉你缺什么。这是故意的，免得你等到用户点登录才发现配置不对。

### 4. 启动前端

**另开一个终端**，在仓库根目录：

```bash
pnpm install
pnpm dev
```

打开 `http://localhost:5173`。

前端请求的是相对路径（`fetch('/api/manga')`），由 `vite.config.ts` 代理到 `localhost:3000`，所以不需要配 CORS，但**两个服务都得开着**。

## 使用说明

### 上传漫画

点右上角「上传」，弹窗里选一个文件夹。两种结构都认：

- **扁平的一堆图** —— 整包当成「第 1 话」
- **每个子文件夹一话** —— 子文件夹名当话标题，里面的图按文件名排序当页序

填好标题（必填）、作者、标签，点提交。标签用逗号分隔，例如 `热血, 冒险`。

上传是**分三步**走的，进度条看得到：先建漫画行拿到 id → 一页图一个请求地传 → 最后把话和封面一次提交。中途关掉也没关系，重新打开上传弹窗会提示「上次没传完」，可以从断掉的地方继续；标题和库里已有的撞车时也会提示。

图片按页面顺序命名存盘，第一页是 `000`。

### 首页按标签筛选

悬停导航栏的「分类」，点其中一项，首页就会列出带这个标签的漫画。

> 导航栏里那几项现在还是占位名（`分类1` / `分类2` / `分类3`），库里没有叫这些名字的标签，所以点下去是空结果 —— 这是预期行为。要让它显示东西，照下面的「改成你自己的标签」改一下，或者上传时手打这几个标签。

### 详情页

点封面进详情页，从上到下：

- **编辑标签** —— 点开输入框，里面是数据库里存的**原文**（比如 `["人妻","NTR"]` 这种 JSON 串），改完点「确定」原样存回去
- **开始阅读** —— 进第一话
- **删除漫画** —— 先弹确认框，确认后连话、图片、收藏、点赞一起删掉，然后回首页

### 阅读页

按话翻页，可以切到别的話。

### 个人页

点右上角用户名进 `/user`：左边能看到全部收藏和「未分类」的数量，可以在右边新建系列、改名、删除，也可以给每本收藏单独选一个归属的系列。删掉一个系列时，组里的收藏不会消失，只是回到未分类。

### 改成你自己的标签

导航栏那三项在 `src/App.tsx` 里，是一组 `<Link to={`/?tag=${encodeURIComponent('分类1')}`}>`。把 `分类1` 换成你实际用过的标签名即可，`encodeURIComponent` 别去掉。

## 环境变量

| 变量 | 必需 | 说明 |
|---|---|---|
| `DB_PASSWORD` | ✅ | MySQL 密码 |
| `JWT_SECRET` | ✅ | JWT 签名密钥，登录 token 有效期为 7 天 |

两个都由 `server/.env` 提供，通过 `pnpm dev` 里的 `--env-file=.env` 注入，代码里以 `process.env.XXX` 读取。缺任意一个，后端会在启动时立刻退出。

**改 JWT 密钥的副作用**：所有已签发的 token 立即失效，也就是所有人被登出。

## 接口一览

后端全部代码在 `server/index.js`。🔒 表示需要 `Authorization: Bearer <token>` 请求头。

### 认证 / 用户

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/register` | — | 注册 |
| POST | `/api/login` | — | 登录，返回 7 天有效的 token |
| GET | `/api/jwt` | — | 解出 token 里的 `userId` / `username` |
| GET | `/api/me` | 🔒 | 当前用户的完整信息（邮箱、注册时间等） |

### 漫画

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/manga` | — | 漫画列表。带 `?tag=热血` 则只返回带该标签的 |
| GET | `/api/manga/:id` | — | 单本详情 |
| GET | `/api/manga/lookup` | — | 按标题查 id（上传时查重名用） |
| GET | `/api/mangasite` | — | 首页三个列表：全部漫画按 `updated_at` 倒序 + 点阅前 8 + 爱心前 8 |
| PUT | `/api/manga/:id/tags` | — | 保存标签原文（`{"tags": "..."}`，上限 100 字符） |
| DELETE | `/api/manga/:id` | — | 删除漫画，连带话、收藏、点赞和磁盘目录 |

### 上传

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/manga` | — | 第一步：建漫画行，返回新 id |
| POST | `/api/manga/:id/image` | — | 第二步：传一页图。原始二进制，`?chapter=1&index=0`（封面传 `chapter=cover`） |
| PUT | `/api/manga/:id/chapters` | — | 第三步：一次提交所有话 + 封面 |

### 阅读

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/manga/:id/chapters` | — | 话列表 |
| GET | `/api/manga/:id/chapters/:number` | — | 某一话的所有页 |
| POST | `/api/manga/:id/read-count` | — | 点阅数 +1 |

### 点赞 / 收藏

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/manga/:id/islike` | 可选 | 当前用户是否已点赞 |
| POST | `/api/manga/:id/update-like` | 🔒 | 点赞 / 取消点赞（切换） |
| GET | `/api/manga/:id/isfavorite` | 可选 | 当前用户是否已收藏 |
| POST | `/api/manga/:id/update-favorite` | 🔒 | 收藏 / 取消收藏（切换） |
| GET | `/api/me/myfavorites` | 🔒 | 我的全部收藏 |

### 系列（收藏分组）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/me/series` | 🔒 | 我的系列，以及每组里有多少本 |
| POST | `/api/series` | 🔒 | 新建系列 |
| PUT | `/api/series/:id` | 🔒 | 改名 |
| DELETE | `/api/series/:id` | 🔒 | 删除（组里的收藏回到未分类） |
| PUT | `/api/favorites/:mangaId/series` | 🔒 | 把某本收藏归入系列，传 `null` 表示移出 |

### 静态资源

| 路径 | 说明 |
|---|---|
| `/uploads/<目录>/<话号>/<页>.jpg` | 漫画图片，由后端直接 serve |

## 数据库结构

6 张表，完整定义见 [`server/schema.sql`](server/schema.sql)。

```
manga ──┬── chapters        (ON DELETE CASCADE：删漫画，话自动跟着走)
        │
        └── likes / favorites   ⚠ 这两张没有指向 manga 的外键，删漫画时要自己删

series ──── favorites.series_id  (ON DELETE SET NULL：删系列，收藏回到未分类)
```

几个容易踩的地方：

- **`manga.tags` 是 `varchar(100)`**，存的是给人看的原始文本。上传弹窗写进去的是 JSON 数组字符串（`'["热血","冒险"]'`）；读取时 `parseTags` 连逗号串（`'热血,冒险'`）也认，所以这一列没有加约束、也没有拆表
- **`chapters.pages` 是 `json` 列**，存的是这一话所有页的 URL 数组
- **`likes` / `favorites` 都有 `uk_user_manga` 唯一索引**，保证同一个人对同一本只有一条记录
- 想要「按标签查」而不只是「精确匹配某一个标签」的话，现在的做法是把全部行取出来在 Node 里解析比对。真要优化，正确方向是加一张 `manga_tags` 关联表，**不是**加 `WHERE tags LIKE '%热血%'` —— `LIKE` 是子串匹配，「热血」会误命中「热血少年」

## 已知限制

- **上传相关的三个接口没有鉴权**，也没有多用户隔离：任何能访问到这个服务的人都能上传和删除漫画。这是本项目按「本地单人使用」设计的结果，**不要直接暴露到公网**
- 导航栏 `分类1/2/3` 是占位名，见上方「改成你自己的标签」
- 标签上限 100 个字符（不是个数）
- **`manga.lovecounts` 是个冗余的计数字段**。点赞的事实来源是 `likes` 表，这一列只是缓存下来方便列表页排序。两者在 `/api/manga/:id/update-like` 里一起维护：先插入或删除 `likes` 那一行，再给这一列 ±1。⚠ 这两步没有包在事务里，中间失败（或者有人直接改库）两边就会对不上
- 没有分页。列表接口一次返回全部行，数据量大了要自己加
