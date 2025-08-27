// const generateVideo = require("../../utils/generateVideo");
// const mergeMultipleVideos = require("../../utils/merge");

module.exports = (bot, currentData, logger) => {
  bot.action(/make_video/, async (ctx) => {
    try {
      await ctx.deleteMessage();
      if (
        !currentData.track ||
        !currentData.text ||
        !currentData.artist ||
        !currentData.ayahs
      ) {
        return ctx.reply("Нет данных. /surah");
      }

      if (!currentData.photoPath) {
        return ctx.reply("Отправь фото, для обложки видео.");
      }
    } catch (err) {
      logger.error(`Color action error: ${err.message}`);
      ctx.reply("Ошибка обработки цвета.");
    }
  });
};
