# Этап 1: Сборка приложения
FROM oven/bun:1.1-slim AS builder
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# Этап 2: Раздача статики через Nginx
FROM nginx:alpine
# Копируем собранный фронтенд из первого этапа в папку Nginx
COPY --from=builder /app/dist /usr/share/nginx/html
# Открываем 80 порт контейнера для внешнего мира
EXPOSE 80
CMD ["nginx", "-g", "deamon off;"]