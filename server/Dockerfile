# 后端镜像。三个依赖（express / jsonwebtoken / mysql2），全是纯 JS ——
# 没有原生模块，所以没有构建步骤，单阶段就够。
#
# 构建命令（在仓库根目录跑，上下文是根目录不是 server/）：
#   docker build -f server/Dockerfile -t mangasite-server .
# 上下文用根目录，是为了让根目录那份 .dockerignore 同时管住两个镜像 ——
# 上下文设成 server/ 的话得再写一份 server/.dockerignore
FROM node:24-slim

WORKDIR /app

# ⚠ 先只拷这两个文件，index.js 留到下面才拷。
# Docker 是逐层缓存的：只要 package.json 和 lock 没变，下面那条 RUN 直接命中缓存。
# 反过来写成 COPY . . 再 install 的话，你每改一次 index.js 都要重装一遍依赖
COPY server/package.json server/pnpm-lock.yaml ./

# --frozen-lockfile：lock 和 package.json 对不上就报错退出，不偷偷改 lock。
# --prod：不装 devDependencies（这份 package.json 里本来也没有，写上是表明意图）
RUN npm i -g pnpm && pnpm install --frozen-lockfile --prod

# 只有这一个文件。uploads 目录不用拷 —— index.js 启动时自己 mkdirSync 建
COPY server/index.js ./

EXPOSE 3000

# ⚠ 这里没有 --env-file。JWT_SECRET / DB_PASSWORD 是 docker run 时
# 用 --env-file 传进来的，不烤进镜像（.dockerignore 里也挡了 server/.env）。
# 缺了它们 index.js 会在启动那几行直接 exit 1 并打印缺哪个键，不会静悄悄跑起来
CMD ["node", "index.js"]
