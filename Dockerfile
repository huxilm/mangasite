# 前端镜像。两个阶段：
#   第 1 阶段  装依赖 + vite build，产出 /app/dist
#   第 2 阶段  把 dist 拷进 nginx，第 1 阶段那一整套 node 和 node_modules 全部丢掉
#
# 为什么要分两阶段：构建要 node、要 vite、要 typescript（几百 MB），
# 而**运行**只需要几个静态文件。不分开的话，镜像里会永远躺着一份再也用不到的
# node_modules，而且那里面还有构建期的源码和 devDependencies。
#
# 构建命令（在仓库根目录跑）：
#   docker build -t mangasite-web .

# ---------- 第 1 阶段：构建 ----------
FROM node:24-slim AS web

WORKDIR /app

# 先只拷依赖清单。理由和 server/Dockerfile 里那条一样：改了 src/ 不该重装依赖
COPY package.json pnpm-lock.yaml ./
# ⚠ 这里不能加 --prod。vite 和 typescript 都在 devDependencies 里，
# 少了它们下一步的 pnpm run build 直接报找不到命令
RUN npm i -g pnpm && pnpm install --frozen-lockfile

# 构建真正需要的东西。⚠ 一个个列出来而不是 COPY . . ——
# 后者会把 server/、.git/、README 全塞进构建上下文（虽然 .dockerignore 挡了一部分），
# 而且改了后端代码会让这一层缓存失效，白白重装一遍前端依赖
COPY index.html vite.config.ts ./
COPY tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY public ./public
COPY src ./src

# = tsc -b && vite build（见 package.json 的 build 脚本）。
# ⚠ 这是道闸：tsc 报错整个镜像就构建失败。故意的 —— 宁可构建失败，
# 也不要一个带着类型错误的前端被烤进镜像、等到运行时才在白屏里发现
RUN pnpm run build

# ---------- 第 2 阶段：运行 ----------
FROM nginx:alpine

# nginx 默认就在这个目录找文件（见 /etc/nginx/conf.d/default.conf 的 root 指令），
# 所以拷到这里不需要改任何配置
COPY --from=web /app/dist /usr/share/nginx/html

# 我们那份配置顶掉镜像自带的 /etc/nginx/conf.d/default.conf。
# 构建上下文是仓库根目录（docker build -t mangasite-web .），nginx.conf 也在
# 根目录，所以直接写文件名就找得到；.dockerignore 里没有 *.conf 这类规则，挡不着。
# ⚠ 这份配置里的 proxy_pass 指向 http://backend:3000 —— backend 是 compose 里
#   后端服务的名字，nginx 启动时解析不到会直接退出。所以这个镜像只能配合
#   docker-compose.yml 跑，不能 docker run 单独起
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

# 没有 CMD —— 用 nginx 镜像自带的那条（nginx -g 'daemon off;'）。
# ⚠ 它不能省：不写 daemon off 的话 nginx 启动后转后台，前台没进程，容器立刻退出
