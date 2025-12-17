# Используем официальный образ Node.js
FROM node:18-alpine

# Устанавливаем ffmpeg и необходимые зависимости
RUN apk add --no-cache \
    ffmpeg \
    python3 \
    make \
    g++

# Создаём рабочую директорию
WORKDIR /app

# Копируем package.json и package-lock.json
COPY package*.json ./

# Устанавливаем зависимости
RUN npm ci --only=production

# Копируем остальные файлы приложения
COPY . .

# Создаём директорию для временных файлов
RUN mkdir -p temp

# Переменные окружения (будут переопределены через .env или docker-compose)
ENV NODE_ENV=production

# Запускаем бота
CMD ["node", "index.js"]