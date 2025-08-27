module.exports = (bot, currentData, clearTempFolder) => {
  bot.command("surah", (ctx) => {
    try {
      // Извлекаем номер суры из команды
      const input = ctx.message.text.replace("/surah", "").trim();
      const surahNumber = parseInt(input);

      // Валидация
      if (isNaN(surahNumber)) {
        return ctx.reply(
          "❌ Номер суры должен быть числом!\nПример: /surah 5",
          {
            parse_mode: "Markdown",
          }
        );
      }

      if (!Number.isInteger(surahNumber)) {
        return ctx.reply(
          "❌ Номер суры должен быть целым числом!\nПример: /surah 5",
          {
            parse_mode: "Markdown",
          }
        );
      }

      if (surahNumber < 1 || surahNumber > 114) {
        return ctx.reply("❌ В Коране 114 сур. Укажите число от 1 до 114", {
          parse_mode: "Markdown",
        });
      }

      // Очистка временных файлов и обновление данных
      clearTempFolder();
      currentData.track = surahNumber.toString(); // Сохраняем как строку для consistency

      ctx.reply(`✅ Номер суры обновлен: ${surahNumber}`);
    } catch (err) {
      console.error("Error in surah command:", err);
      ctx.reply("⚠️ Произошла ошибка при обработке команды");
    }
  });
};
