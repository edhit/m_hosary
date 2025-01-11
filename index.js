require('dotenv').config();
const { Telegraf, Markup } = require("telegraf");
const path = require("path");
const fs = require("fs");
const fetch = require("node-fetch");
const NodeID3 = require("node-id3");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const surahs = require('./quran.json');

// Укажите токен вашего бота
const BOT_TOKEN = process.env.BOT_TOKEN;

const channel = process.env.CHANNEL;

const bot = new Telegraf(BOT_TOKEN);

// Устанавливаем путь к ffmpeg
ffmpeg.setFfmpegPath(ffmpegPath);

// Папка для временного хранения файлов
const TEMP_FOLDER = "./temp";

// Создаем папку, если её нет
if (!fs.existsSync(TEMP_FOLDER)) {
  fs.mkdirSync(TEMP_FOLDER);
}

// Переменные для хранения текущих значений метаданных
// let currentTitle = "";
let currentArtist = "";
let currentTrack = ""; // Трек по умолчанию
let currentText = ""; // Переменная для произвольного текста
let processedAudioPath = ""; // Путь к последнему обработанному аудио
let color = ""

// Функция для удаления всех файлов в папке
const clearTempFolder = () => {
  const files = fs.readdirSync(TEMP_FOLDER);
  files.forEach((file) => {
    const filePath = path.join(TEMP_FOLDER, file);
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      console.error(`Ошибка при удалении файла ${filePath}:`, err);
    }
  });
};

// Хендлер на получение команды для обновления title
// bot.command("set_title", (ctx) => {
//   const newTitle = ctx.message.text.replace("/set_title ", "").trim();
//   if (newTitle) {
//     currentTitle = newTitle;
//     ctx.reply(`Название трека обновлено на: "${currentTitle}"`);
//   } else {
//     ctx.reply("Пожалуйста, укажите новое название трека, например:\n`/set_title Новое название`", { parse_mode: "Markdown" });
//   }
// });

// Хендлер на получение команды для обновления artist
bot.command("set_artist", (ctx) => {
  const newArtist = ctx.message.text.replace("/set_artist ", "").trim();
  if (newArtist) {
    currentArtist = newArtist;
    ctx.reply(`Автор трека обновлен на: "${currentArtist}"`);
  } else {
    ctx.reply("Пожалуйста, укажите нового автора трека, например:\n`/set_artist Новый автор`", { parse_mode: "Markdown" });
  }
});

// Хендлер на получение команды для обновления track
bot.command("set_track", (ctx) => {
  const newTrack = ctx.message.text.replace("/set_track ", "").trim();
  if (newTrack && !isNaN(newTrack)) {
    currentTrack = newTrack;
    ctx.reply(`Номер трека обновлен на: "${currentTrack}"`);
  } else {
    ctx.reply("Пожалуйста, укажите корректный номер трека, например:\n`/set_track 5`", { parse_mode: "Markdown" });
  }
});

// Хендлер на получение произвольного текста
bot.on("text", (ctx) => {
  const newText = ctx.message.text.trim();
  if (newText) {
    currentText = newText;
    ctx.reply(`Текст успешно обновлен на: "${currentText}"`);
  } else {
    ctx.reply("Пожалуйста, отправьте не пустое сообщение.");
  }
});

// Хендлер на очистку всех данных
bot.command("clear_all", (ctx) => {
//   currentTitle = "";
  currentArtist = "";
  currentTrack = "";
  currentText = "";
  color = "";
  ctx.reply("Все данные успешно сброшены!");
});

// Хендлер на получение видео
bot.on("video", async (ctx) => {
  try {
    // Проверяем, что все данные заполнены
    if (!currentArtist || !currentTrack || !currentText) {
      await ctx.reply("Пожалуйста, заполните все данные перед загрузкой файла:\n- Автор (`/set_artist`)\n- Номер суры (`/set_track`)\n- Номер аята (отправьте любое сообщение)");
      return;
    }

    const video = ctx.message.video;

    // Скачиваем файл
    const fileLink = await ctx.telegram.getFileLink(video.file_id);
    const inputVideoPath = path.join(TEMP_FOLDER, `input_${video.file_id}.mp4`);
    const outputAudioPath = path.join(TEMP_FOLDER, `audio_${video.file_id}.mp3`);

    // Загружаем видео
    const response = await fetch(fileLink.href);
    const buffer = await response.buffer();
    fs.writeFileSync(inputVideoPath, buffer);

    // Извлечение аудио из видео
    await new Promise((resolve, reject) => {
      ffmpeg(inputVideoPath)
        .output(outputAudioPath)
        .noVideo() // Оставляем только аудио
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

    // Новые метаданные
    const tags = {
      title: `Surah ${currentTrack} ${surahs[Number(currentTrack) - 1].name_en}(${currentText})`,
      artist: currentArtist,
      year: new Date().getFullYear(),
    };

    // Применяем новые метаданные
    NodeID3.write(tags, outputAudioPath, (err) => {
      if (err) {
        console.error("Ошибка записи ID3 тегов:", err);
        throw new Error("Не удалось изменить метаданные файла.");
      }
    });

    // Сохраняем путь к обработанному аудиофайлу
    processedAudioPath = outputAudioPath;

    // Отправляем клавиатуру с цветными кнопками
    await ctx.reply("Выберите цвет перед подтверждением:", {
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🔵", "color_blue"), Markup.button.callback("🟢", "color_green")],
        [Markup.button.callback("🔴", "color_red"), Markup.button.callback("🟡", "color_yellow")],
        [Markup.button.callback("🟣", "color_purple"), Markup.button.callback("🟠", "color_orange")],
        [Markup.button.callback("🟥", "color_darkred")],
      ]),
    });
  } catch (error) {
    console.error("Ошибка:", error);
    await ctx.reply("Произошла ошибка при обработке видео.");
    clearTempFolder(); // Удаляем файлы в случае ошибки
  }
});

// Хендлеры для обработки выбора цвета
const colors = {
  color_blue: "🔵",
  color_green: "🟢",
  color_red: "🔴",
  color_yellow: "🟡",
  color_purple: "🟣",
  color_orange: "🟠",
  color_darkred: "🟥",
};

Object.keys(colors).forEach((colorAction) => {
  bot.action(colorAction, async (ctx) => {
    color = colorAction

    await ctx.editMessageText(`${colors[color]} Сура ${currentTrack} «${surahs[Number(currentTrack) - 1].name_en} (${surahs[Number(currentTrack) - 1].name_ru}), ${currentText}» Махмуд Аль-Хусари`)

    await ctx.replyWithAudio({
        source: processedAudioPath,
        filename: `${currentArtist} - ${surahs[Number(currentTrack) - 1].name_en} - ${currentText}.mp3`,
      }, {
        caption: `${colors[color]} Сура ${currentTrack} «${surahs[Number(currentTrack) - 1].name_en} (${surahs[Number(currentTrack) - 1].name_ru}), ${currentText}» Махмуд Аль-Хусари \n\n Отправить?`,
        ...Markup.inlineKeyboard([
            Markup.button.callback("✅ Отправить", "send_audio"),
            Markup.button.callback("❌ Отменить", "cancel_audio"),
          ]),
      });
  });
});

// Хендлер для подтверждения отправки аудио
bot.action("send_audio", async (ctx) => {
  try {
    if (processedAudioPath) {
      await bot.telegram.sendAudio(channel, {
        source: processedAudioPath,
        filename: `${currentArtist} - ${surahs[Number(currentTrack) - 1].name_en} - ${currentText}.mp3`,
      }, {
        caption: `${colors[color]} Сура ${currentTrack} «${surahs[Number(currentTrack) - 1].name_en} (${surahs[Number(currentTrack) - 1].name_ru}), ${currentText}» Махмуд Аль-Хусари`
      });
      await ctx.deleteMessage();
      clearTempFolder(); // Очищаем временные файлы
      processedAudioPath = ""; // Сбрасываем обработанный файл
      currentText = "";
      color = "";
    } else {
      await ctx.reply("Нет аудиофайла для отправки!");
    }
  } catch (err) {
    console.error("Ошибка при отправке аудио:", err);
    await ctx.reply("Ошибка при отправке аудио.");
  }
});

// Хендлер для отмены отправки аудио
bot.action("cancel_audio", async (ctx) => {
  await ctx.editMessageText("Отправка аудио отменена.");
  clearTempFolder(); // Удаляем временные файлы
  processedAudioPath = ""; // Сбрасываем путь к файлу
  currentText = "";
  color = "";
});

// Запуск бота
bot.launch().then(() => console.log("Бот запущен!"));
