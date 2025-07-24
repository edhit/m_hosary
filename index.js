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
  mode: "", // 'hussary' или 'regular'
  track: "",
  text: "",
  artist: "Mahmoud Al-Hosary",
  color: "",
  audioPath: "",
  message: "",
  title: "",
  tags: {}
};

// Команды
bot.command("start", (ctx) => {
  ctx.reply("Выберите режим работы:", {
    ...Markup.inlineKeyboard([
      [Markup.button.callback("Режим Корана (Хусари)", "mode_hussary")],
      [Markup.button.callback("Режим обычного аудио", "mode_regular")]
    ])
  });
});

bot.command("surah", (ctx) => {
  if (currentData.mode !== "hussary") {
    return ctx.reply("Эта команда доступна только в режиме Корана (Хусари)");
  }
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

bot.command("artist", (ctx) => {
  const newArtist = ctx.message.text.replace("/artist", "").trim();
  if (newArtist) {
    currentData.artist = newArtist;
    ctx.reply(`Исполнитель обновлен на: "${newArtist}"`);
  } else {
    ctx.reply("Пожалуйста, укажите имя исполнителя, например:\n`/artist Artist Name`");
  }
});

bot.command("title", (ctx) => {
  if (currentData.mode !== "regular") {
    return ctx.reply("Эта команда доступна только в обычном режиме");
  }
  const newTitle = ctx.message.text.replace("/title", "").trim();
  if (newTitle) {
    currentData.title = newTitle;
    ctx.reply(`Название трека обновлено на: "${newTitle}"`);
  } else {
    ctx.reply("Пожалуйста, укажите название трека, например:\n`/title Song Name`");
  }
});

bot.command("clear_all", (ctx) => {
  Object.assign(currentData, { 
    mode: "",
    track: "", 
    text: "", 
    color: "", 
    audioPath: "", 
    message: "",
    title: "",
    artist: "Mahmoud Al-Hosary",
    tags: {}
  });
  ctx.reply("Все данные успешно сброшены!");
  clearTempFolder();
});

// Обработчики режимов
bot.action("mode_hussary", async (ctx) => {
  currentData.mode = "hussary";
  currentData.artist = "Mahmoud Al-Hosary";
  await ctx.editMessageText("Режим Корана (Хусари) активирован.\n\nТеперь укажите:\n1. Номер суры (/surah номер)\n2. Номер аята (просто отправьте текст)\n3. Отправьте видео для извлечения аудио");
});

bot.action("mode_regular", async (ctx) => {
  currentData.mode = "regular";
  await ctx.editMessageText("Обычный режим активирован.\n\nТеперь укажите:\n1. Название трека (/title название)\n2. Исполнителя (/artist имя)\n3. Отправьте аудиофайл для редактирования метаданных");
});

// Обработка текста (для номера аята в режиме Хусари)
bot.on("text", (ctx) => {
  if (ctx.message.text.startsWith('/')) return; // Игнорируем команды
  
  if (currentData.mode === "hussary") {
    const newText = ctx.message.text.trim();
    if (newText) {
      currentData.text = newText;
      ctx.reply(`Номер аята успешно обновлен на: "${newText}"`);
    } else {
      ctx.reply("Пожалуйста, отправьте не пустое сообщение.");
    }
  }
});

// Обработка видео (режим Хусари)
bot.on("video", async (ctx) => {
  try {
    if (currentData.mode !== "hussary") return;
    
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

    const surahInfo = surahs[Number(currentData.track) - 1] || {};
    currentData.tags = {
      title: `Surah ${currentData.track} ${surahInfo.name_en || "Unknown"} (${currentData.text})`,
      artist: currentData.artist,
      year: new Date().getFullYear(),
    };

    NodeID3.write(currentData.tags, outputAudioPath, (err) => {
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

// Обработка аудио (обычный режим)
bot.on("audio", async (ctx) => {
  try {
    if (currentData.mode !== "regular") return;
    
    if (!currentData.title || !currentData.artist) {
      return ctx.reply(
        "Пожалуйста, укажите название трека (/title) и исполнителя (/artist) перед загрузкой аудио",
      );
    }
    
    let message = await ctx.reply('⏳');

    const audio = ctx.message.audio;
    const fileLink = await ctx.telegram.getFileLink(audio.file_id);
    const audioPath = path.join(TEMP_FOLDER, `audio_${audio.file_id}.mp3`);

    const response = await fetch(fileLink.href);
    fs.writeFileSync(audioPath, await response.buffer());

    currentData.tags = {
      title: currentData.title,
      artist: currentData.artist,
      year: new Date().getFullYear(),
    };

    NodeID3.write(currentData.tags, audioPath, (err) => {
      if (err) throw new Error("Ошибка записи ID3 тегов.");
    });

    currentData.audioPath = audioPath;
    currentData.message = `${currentData.artist} - ${currentData.title}`;
    await ctx.deleteMessage(message.message_id);

    await ctx.replyWithAudio(
      {
        source: currentData.audioPath,
        filename: `${currentData.artist} - ${currentData.title}.mp3`,
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
    console.error("Ошибка обработки аудио:", error);
    ctx.reply("Произошла ошибка при обработке аудио.");
    clearTempFolder();
  }
});

// Обработка выбора цвета (режим Хусари)
bot.action(/color_(.+)/, async (ctx) => {
  try {
    await ctx.deleteMessage();

    const colorAction = ctx.match[1];
    currentData.color = colorAction;

    const surahInfo = surahs[Number(currentData.track) - 1] || {};
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

// Отправка аудио
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
    Object.assign(currentData, { 
      track: "", 
      text: "", 
      color: "", 
      audioPath: "", 
      message: "",
      title: "",
      tags: {}
    });
  } catch (err) {
    console.error("Ошибка отправки аудио:", err);
    ctx.reply("Ошибка при отправке аудио.");
  }
});

// Отмена отправки
bot.action("cancel_audio", async (ctx) => {
  await ctx.deleteMessage();
  await ctx.reply("Отправка аудио отменена.");
  clearTempFolder();
  Object.assign(currentData, { 
    audioPath: "", 
    color: "", 
    text: "", 
    track: "",
    title: "",
    message: "",
    tags: {}
  });
});

bot.launch().then(() => console.log("Бот запущен!"));
