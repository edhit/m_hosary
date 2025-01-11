#!/bin/bash

# Обновление кода из Git
echo "Получение обновлений из Git..."
git pull || { echo "Не удалось выполнить git pull"; exit 1; }

# Удаление последнего приложения в PM2
LAST_APP_ID=$(pm2 list | tail -n +4 | grep -Eo '^[0-9]+' | tail -1)
if [ -n "$LAST_APP_ID" ]; then
  echo "Удаление последнего приложения с ID $LAST_APP_ID..."
  pm2 delete "$LAST_APP_ID" || { echo "Не удалось удалить приложение $LAST_APP_ID"; exit 1; }
else
  echo "Приложения PM2 не найдены."
fi

# Запуск приложения
echo "Запуск приложения..."
pm2 start index.js || { echo "Не удалось запустить приложение"; exit 1; }

echo "Код успешно обновлён и приложение перезапущено!"