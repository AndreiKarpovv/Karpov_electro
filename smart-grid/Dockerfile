# Используем официальный легковесный образ Bun
FROM oven/bun:1.1-slim

# Указываем рабочую директорию внутри контейнера
WORKDIR /app

# Копируем файлы зависимостей
COPY package.json bun.lockb ./

# Устанавливаем зависимости
RUN bun install --frozen-lockfile

# Копируем весь остальной код бэкенда
COPY . .

# Запускаем наш воркер
CMD ["bun", "run", "worker.ts"]