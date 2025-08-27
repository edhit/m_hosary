const { savePhotoToTemp } = require("../../utils/photoUtils");
const fs = require("fs");
const path = require("path");

module.exports = (bot, currentData, logger) => {
  bot.on("photo", async (ctx) => {
    try {
      const photoPath = await savePhotoToTemp(bot, ctx.message.photo);
      currentData.photoPath = photoPath;

      ctx.reply(`Фото сохранено`);

      // Сохраняем currentData в JSON файл
      const tempDir = path.join(__dirname, "../../temp");
      const dataFilePath = path.join(tempDir, "currentData.json");

      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      fs.writeFileSync(dataFilePath, JSON.stringify(currentData, null, 2));

      console.log(currentData);
    } catch (err) {
      ctx.reply("Ошибка при сохранении фото");
      logger.error(err);
    }
  });
};
