# 多阶段构建：build 阶段产出前端静态资源，运行阶段以 tsx 直跑服务端（KISS）
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
ARG COMMIT=unknown
ARG BUILD_DATE=unknown
WORKDIR /app
ENV NODE_ENV=production \
    COMMIT_SHA=$COMMIT \
    BUILD_DATE=$BUILD_DATE \
    TZ=Asia/Shanghai
RUN apk add --no-cache tzdata
COPY --from=build /app ./
EXPOSE 3001
CMD ["npm", "run", "start"]
