# Этап 1: Сборка приложения
FROM oven/bun:1.1-slim AS builder
WORKDIR /app

# ИСПРАВЛЕНО: Маска *.lock* не падает, если файла блокировки нет в папке
COPY package.json bun.lockb* bun.lock* ./

# ИСПРАВЛЕНО: Убираем --frozen-lockfile, чтобы сборка шла по package.json
RUN bun install

COPY . .
RUN bun run build

# Этап 2: Раздача статики через Nginx
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]