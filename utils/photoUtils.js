const fs = require('fs');
const path = require('path');
const axios = require('axios');

/**
 * Сохраняет фото в папку temp
 * @param {Object} photo - Объект фото из Telegram
 * @param {string} tempFolder - Путь к временной папке
 * @returns {Promise<string>} Путь к сохраненному файлу
 */
const savePhotoToTemp = async (bot, photo, tempFolder = './temp') => {
  try {
    // Создаем папку temp, если ее нет
    if (!fs.existsSync(tempFolder)) {
      fs.mkdirSync(tempFolder, { recursive: true });
    }

    // Получаем файл с наибольшим разрешением (последний в массиве)
    const photoFile = photo[photo.length - 1];
    const fileUrl = await bot.telegram.getFileLink(photoFile.file_id);
    const fileExt = path.extname(fileUrl.pathname) || '.jpg';
    const fileName = `photo_${Date.now()}${fileExt}`; 
    const filePath = path.join(tempFolder, fileName);

    // Скачиваем и сохраняем файл
    const response = await axios.get(fileUrl.href, { responseType: 'stream' });
    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(filePath));
      writer.on('error', reject);
    });

  } catch (err) {
    console.error('Error saving photo:', err);
    throw err;
  }
};

module.exports = { savePhotoToTemp };