module.exports = (bot, currentData, clearTempFolder, logger) => {
  bot.command("clear", (ctx) => {
    try {
      // Сброс всех данных
      Object.assign(currentData, {
        track: "",
        text: "",
        artist: "",
        color: "",
        audioPath: "",
        photoPath: "",
        message: "",
        ayahs: "",
        quran: "",
        color: "",
      });

      // Очистка временной папки
      clearTempFolder();

      ctx.reply("✅ Все данные успешно сброшены!");
    } catch (error) {
      logger.error("Ошибка при сбросе данных:", error);
      ctx.reply("❌ Произошла ошибка при сбросе данных");
    }
  });
};
