ARG NODE_IMAGE=node:20-alpine
FROM ${NODE_IMAGE}

ARG ALPINE_REPO_MIRROR=
ARG NPM_REGISTRY=

# 可选：切换 Alpine 包仓库镜像（解决国内/受限网络下 apk 下载慢或失败）
# 传参示例：--build-arg ALPINE_REPO_MIRROR=mirrors.aliyun.com/alpine
RUN if [ -n "$ALPINE_REPO_MIRROR" ]; then \
      m="$ALPINE_REPO_MIRROR"; \
      m="${m#http://}"; \
      m="${m#https://}"; \
      sed -i "s|dl-cdn.alpinelinux.org/alpine|$m|g" /etc/apk/repositories; \
    fi

# 安装 better-sqlite3 编译依赖 和 ffmpeg（HLS 转码需要）
RUN apk add --no-cache python3 make g++ ffmpeg

WORKDIR /app

# 复制 package.json
COPY package*.json ./

# 安装依赖
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi \
  && npm install --production

# 复制源代码
COPY . .

# 创建数据目录
RUN mkdir -p /app/data

# 暴露端口
EXPOSE 3000

# 设置环境变量
ENV NODE_ENV=production
ENV PORT=3000

# 健康检查（使用 Node 内置 fetch，无需额外安装 wget/curl）
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "const p=process.env.PORT||3000;fetch('http://localhost:'+p+'/health').then(r=>{if(!r.ok)throw 1}).catch(()=>process.exit(1))"

# 启动命令
CMD ["node", "server.js"]
