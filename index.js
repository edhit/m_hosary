require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const path = require("path");
const fs = require("fs");
const fetch = require("node-fetch");
const NodeID3 = require("node-id3");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const surahs = require("./quran.json");

// Установить путь для ffmpeg
ffmpeg.setFfmpegPath(ffmpegPath);

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL;
const TEMP_FOLDER = "./temp";

// Инициализация бота
const bot = new Telegraf(BOT_TOKEN);

// Создать временную папку, если она отсутствует
if (!fs.existsSync(TEMP_FOLDER)) {
  fs.mkdirSync(TEMP_FOLDER);
}

// Утилиты
function toHashtag(str) {
  return (
    "#" +
    str
      .toLowerCase()
      .replace(/[^a-zа-яё0-9\s]/gi, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .join("#")
  );
}

function clearTempFolder() {
  fs.readdirSync(TEMP_FOLDER).forEach((file) => {
    fs.unlinkSync(path.join(TEMP_FOLDER, file));
  });
}

// Глобальные переменные
const currentData = {
  track: "",
  text: "",
  artist: "Mahmoud Al-Hosary",
  color: "",
  audioPath: "",
  message: ""
};

// Команды
bot.command("surah", (ctx) => {
  const newTrack = ctx.message.text.replace("/surah", "").trim();
  if (newTrack && !isNaN(newTrack)) {
    currentData.track = newTrack;
    ctx.reply(`Номер суры обновлен на: "${newTrack}"`);
  } else {
    ctx.reply("Пожалуйста, укажите корректный номер суры, например:\n`/surah 5`", {
      parse_mode: "Markdown",
    });
  }
});

bot.command("clear_all", (ctx) => {
  Object.assign(currentData, { track: "", text: "", color: "", audioPath: "" });
  ctx.reply("Все данные успешно сброшены!");
  clearTempFolder();
});

bot.on("text", (ctx) => {
  const newText = ctx.message.text.trim();
  if (newText) {
    currentData.text = newText;
    ctx.reply(`Текст успешно обновлен на: "${newText}"`);
  } else {
    ctx.reply("Пожалуйста, отправьте не пустое сообщение.");
  }
});

bot.on("video", async (ctx) => {
  try {
    if (!currentData.track || !currentData.text) {
      return ctx.reply(
        "Пожалуйста, заполните все данные перед загрузкой файла:\n- Номер суры (`/surah`)\n- Номер аята (отправьте текст)",
      );
    }
    let message = await ctx.reply('⏳');

    const video = ctx.message.video;
    const fileLink = await ctx.telegram.getFileLink(video.file_id);
    const inputVideoPath = path.join(TEMP_FOLDER, `input_${video.file_id}.mp4`);
    const outputAudioPath = path.join(TEMP_FOLDER, `audio_${video.file_id}.mp3`);

    const response = await fetch(fileLink.href);
    fs.writeFileSync(inputVideoPath, await response.buffer());

    await new Promise((resolve, reject) => {
      ffmpeg(inputVideoPath)
        .output(outputAudioPath)
        .noVideo()
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

    const tags = {
      title: `Surah ${currentData.track} ${surahs[Number(currentData.track) - 1]?.name_en || "Unknown"} (${currentData.text})`,
      artist: currentData.artist,
      year: new Date().getFullYear(),
    };

    NodeID3.write(tags, outputAudioPath, (err) => {
      if (err) throw new Error("Ошибка записи ID3 тегов.");
    });

    currentData.audioPath = outputAudioPath;
    await ctx.deleteMessage(message.message_id);

    await ctx.reply("Выберите цвет перед подтверждением:", {
      ...Markup.inlineKeyboard([
        ["🔵", "🟢", "🔴", "🟡"].map((emoji) => Markup.button.callback(emoji, `color_${emoji}`)),
        ["🟣", "🟠", "🟥"].map((emoji) => Markup.button.callback(emoji, `color_${emoji}`)),
      ]),
    });
  } catch (error) {
    console.error("Ошибка обработки видео:", error);
    ctx.reply("Произошла ошибка при обработке видео.");
    clearTempFolder();
  }
});

bot.action(/color_(.+)/, async (ctx) => {
  try {
    await ctx.deleteMessage();

    const colorAction = ctx.match[1]; // Извлекаем значение из действия (например, "red", "blue" и т. д.)
    currentData.color = colorAction;

    const surahInfo = surahs[Number(currentData.track) - 1] || {}; // Получаем данные о суре
    currentData.message = `${colorAction} Сура ${currentData.track} «${surahInfo.name_en} (${surahInfo.name_ru}), ${(currentData.text.includes("-")) ? "аяты" : "аят"} ${currentData.text}» - Махмуд Аль-Хусари\n\n#коран ${toHashtag(surahInfo.name_en)}`;

    await ctx.replyWithAudio(
      {
        source: currentData.audioPath,
        filename: `${currentData.artist} - ${surahInfo.name_en} - ${currentData.text}.mp3`,
      },
      {
        caption: `${currentData.message}`,
        ...Markup.inlineKeyboard([
          Markup.button.callback("✅ Отправить", "send_audio"),
          Markup.button.callback("❌ Отменить", "cancel_audio"),
        ]),
      }
    );
  } catch (error) {
    console.error("Ошибка в обработке действия:", error);
    await ctx.reply("Произошла ошибка при обработке. Пожалуйста, попробуйте снова.");
  }
});



bot.action("send_audio", async (ctx) => {
  try {
    await ctx.deleteMessage();
    if (!currentData.audioPath) return ctx.reply("Нет аудиофайла для отправки!");

    await bot.telegram.sendAudio(CHANNEL_ID, {
      source: currentData.audioPath,
      filename: path.basename(currentData.audioPath),
    }, {
      caption: `${currentData.message}`,
    });

    ctx.reply("Аудиофайл успешно отправлен!");
    clearTempFolder();
    Object.assign(currentData, { track: "", text: "", color: "", audioPath: "", message: "" });
  } catch (err) {
    console.error("Ошибка отправки аудио:", err);
    ctx.reply("Ошибка при отправке аудио.");
  }
});

bot.action("cancel_audio", async (ctx) => {
  await ctx.deleteMessage();
  await ctx.reply("Отправка аудио отменена.");
  clearTempFolder();
  Object.assign(currentData, { audioPath: "", color: "", text: "", track: "" });
});

bot.launch().then(() => console.log("Бот запущен!"));
