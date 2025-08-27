// const path = require("path");
// const NodeID3 = require("node-id3");
const { Markup } = require("telegraf");
const parsePageRanges = require("../../utils/parsePageRanges");
const surahs = require("../../quran.json");
const toHashtag = require("../../utils/toHashtag");
const getAyahsTextWithNumbers = require("../../utils/getAyahsTextWithNumbers");

// const surahs = require("../../quran.json"); // Предполагается файл с данными о сурах

module.exports = (bot, currentData, logger) => {
  bot.on("text", async (ctx) => {
    try {
      const newText = ctx.message.text.trim();
      currentData.text = newText;

      // Проверка заполненных данных
      if (!currentData.track || !currentData.text) {
        return ctx.reply(
          "Заполните все данные перед загрузкой файла:\n- Номер суры (`/surah`)\n- Номер аята (отправьте текст)"
        );
      }

      // Парсинг номеров аятов
      const ayahs = parsePageRanges(currentData.text);
      if (!ayahs || ayahs.includes(0)) {
        return ctx.reply("Неверно указан(ы) номер(а) аятов");
      }
      currentData.ayahs = ayahs;
      currentData.quran = await getAyahsTextWithNumbers(ayahs);

      const surahInfo = surahs[Number(currentData.track) - 1] || {};
      const isMultipleAyahs = currentData.text.includes("-");
      currentData.message = `Сура ${currentData.track} «${surahInfo.name_en} (${
        surahInfo.name_ru
      }), ${isMultipleAyahs ? "аяты" : "аят"} ${
        currentData.text
      }» - Махмуд Аль-Хусари\n\n#коран ${toHashtag(surahInfo.name_en)}`;

      await ctx.reply("Выберите категорию:", {
        ...Markup.inlineKeyboard([
          ["Сделать видео"].map((e) => Markup.button.callback(e, `make_video`)),
        ]),
      });
      // // Уведомление о начале обработки
      // const tempMsg = await ctx.reply("⏳ Обработка аудио...");

      // // Создание аудиофайла
      // const settings = {
      //   ayahs,
      //   surah: parseInt(currentData.track),
      // };
      // const outputAudio = await mp3create(settings);
      // const outputAudioPath = path.join(outputAudio.folder, outputAudio.file);

      // // Установка метаданных
      // const tags = {
      //   title: `Surah ${currentData.track} ${
      //     surahs[Number(currentData.track) - 1]?.name_en || "Unknown"
      //   } (${currentData.text})`,
      //   artist: currentData.artist || "Quran Recitation",
      //   year: new Date().getFullYear(),
      // };

      // // Запись метаданных и обработка результата
      // NodeID3.write(tags, outputAudioPath, async (err) => {
      //   if (err) {
      //     logger.error(`ID3 tag error: ${err.message}`);
      //     return ctx.reply(
      //       "Произошла ошибка при обработке метаданных. Попробуйте еще раз"
      //     );
      //   }

      //   currentData.audioPath = outputAudioPath;
      //   await ctx.deleteMessage(tempMsg.message_id);

      //   // Предложение выбрать цвет

      // });
    } catch (err) {
      console.log(err);

      logger.error(`Text handler error: ${err.message}`);
      ctx.reply("Произошла ошибка при обработке аудио.");
    }
  });
};
