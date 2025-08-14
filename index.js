require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const path = require("path");
const fs = require("fs");
const NodeID3 = require("node-id3");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const winston = require("winston");

const surahs = require("./quran.json");
const { mp3create } = require("./mp3create");

// Настройка ffmpeg
ffmpeg.setFfmpegPath(ffmpegPath);

// Константы
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL;
const TEMP_FOLDER = path.resolve("./temp");
const DATA_FILE = path.resolve("./audio_data.json");
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID;

// Настройка логирования
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ level, message, timestamp }) => {
      return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "bot.log" })
  ],
});

// Инициализация бота
const bot = new Telegraf(BOT_TOKEN);

// Создание временной папки
if (!fs.existsSync(TEMP_FOLDER)) fs.mkdirSync(TEMP_FOLDER);

// Глобальные данные
const currentData = {
  track: "",
  text: "",
  artist: "Mahmoud Al-Hosary",
  color: "",
  audioPath: "",
  message: ""
};

// --- УТИЛИТЫ ---
const parsePageRanges = (input) => {
  if (!input || typeof input !== "string") return [];
  try {
    const parts = input.split(",");
    const pages = new Set();

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      if (trimmed.includes("-")) {
        const [startStr, endStr] = trimmed.split("-").map(s => s.trim());
        const start = parseInt(startStr, 10);
        const end = parseInt(endStr, 10);
        if (isNaN(start) || isNaN(end) || start > end) throw new Error(`Invalid range: "${trimmed}"`);
        for (let i = start; i <= end; i++) pages.add(i);
      } else {
        const page = parseInt(trimmed, 10);
        if (isNaN(page)) throw new Error(`Invalid page: "${trimmed}"`);
        pages.add(page);
      }
    }

    return Array.from(pages).sort((a, b) => a - b);
  } catch (error) {
    logger.warn(`parsePageRanges error: ${error.message}`);
    return false;
  }
};

const toHashtag = (str) => {
  return "#" + str.toLowerCase()
    .replace(/[^a-zа-яё0-9\s]/gi, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join("#");
};

const clearTempFolder = () => {
  fs.readdirSync(TEMP_FOLDER).forEach(file => fs.unlinkSync(path.join(TEMP_FOLDER, file)));
};

// --- MIDDLEWARE ---
bot.use(async (ctx, next) => {
  try {
    if (!ALLOWED_USER_ID || ctx.from?.id?.toString() !== ALLOWED_USER_ID) {
      return;
    }
    await next();
  } catch (err) {
    logger.error(`Middleware error: ${err.message}`);
    ctx.reply("⚠️ Ошибка проверки доступа.");
  }
});

// --- КОМАНДЫ ---
bot.command("surah", (ctx) => {
  const newTrack = ctx.message.text.replace("/surah", "").trim();
  if (newTrack && !isNaN(newTrack)) {
    currentData.track = newTrack;
    ctx.reply(`Номер суры обновлен на: "${newTrack}"`);
  } else {
    ctx.reply("Укажите корректный номер суры, например: `/surah 5`", { parse_mode: "Markdown" });
  }
});

bot.command("clear_all", (ctx) => {
  Object.assign(currentData, { track: "", text: "", color: "", audioPath: "", message: "" });
  clearTempFolder();
  ctx.reply("Все данные успешно сброшены!");
});

// --- ОБРАБОТКА ТЕКСТА ---
bot.on("text", async (ctx) => {
  try {
    const newText = ctx.message.text.trim();
    currentData.text = newText;

    if (!currentData.track || !currentData.text) {
      return ctx.reply(
        "Заполните все данные перед загрузкой файла:\n- Номер суры (`/surah`)\n- Номер аята (отправьте текст)"
      );
    }

    const ayahs = parsePageRanges(currentData.text);
    if (!ayahs || ayahs.includes(0)) return ctx.reply("Неверно указан(ы) номер(а) аятов");

    const tempMsg = await ctx.reply("⏳ Обработка аудио...");

    const settings = { ayahs, surah: parseInt(currentData.track), folder: TEMP_FOLDER };
    const outputAudio = await mp3create(settings);
    const outputAudioPath = path.join(outputAudio.folder, outputAudio.file);

    const tags = {
      title: `Surah ${currentData.track} ${surahs[Number(currentData.track) - 1]?.name_en || "Unknown"} (${currentData.text})`,
      artist: currentData.artist,
      year: new Date().getFullYear(),
    };
    NodeID3.write(tags, outputAudioPath, (err) => {
      if (err) {
        return ctx.reply("Произошла ошибка при обработке аудио.");
      }
    });

    currentData.audioPath = outputAudioPath;
    await ctx.deleteMessage(tempMsg.message_id);

    await ctx.reply("Выберите цвет перед подтверждением:", {
      ...Markup.inlineKeyboard([
        ["🔵", "🟢", "🔴", "🟡"].map(e => Markup.button.callback(e, `color_${e}`)),
        ["🟣", "🟠", "🟥"].map(e => Markup.button.callback(e, `color_${e}`)),
      ])
    });
  } catch (err) {
    logger.error(`Text handler error: ${err.message}`);
    ctx.reply("Произошла ошибка при обработке аудио.");
    clearTempFolder();
  }
});

// --- ОБРАБОТКА ЦВЕТА ---
bot.action(/color_(.+)/, async (ctx) => {
  try {
    await ctx.deleteMessage();
    const colorAction = ctx.match[1];
    currentData.color = colorAction;

    const surahInfo = surahs[Number(currentData.track) - 1] || {};
    currentData.message = `${colorAction} Сура ${currentData.track} «${surahInfo.name_en} (${surahInfo.name_ru}), ${(currentData.text.includes("-")) ? "аяты" : "аят"} ${currentData.text}» - Махмуд Аль-Хусари\n\n#коран ${toHashtag(surahInfo.name_en)}`;

    await ctx.replyWithAudio(
      { source: currentData.audioPath, filename: `${currentData.artist} - ${surahInfo.name_en} - ${currentData.text}.mp3` },
      {
        caption: currentData.message,
        ...Markup.inlineKeyboard([
          Markup.button.callback("✅ Отправить", "send_audio"),
          Markup.button.callback("❌ Отменить", "cancel_audio"),
        ]),
      }
    );
  } catch (err) {
    logger.error(`Color action error: ${err.message}`);
    ctx.reply("Ошибка обработки цвета.");
  }
});

// --- ОТПРАВКА И ОТМЕНА ---
bot.action("send_audio", async (ctx) => {
  try {
    await ctx.deleteMessage();
    if (!currentData.audioPath) return ctx.reply("Нет аудиофайла для отправки!");

    const sentAudio = await bot.telegram.sendAudio(CHANNEL_ID, { source: currentData.audioPath, filename: path.basename(currentData.audioPath) }, { caption: currentData.message });
    const file_id = sentAudio.audio.file_id;

    let allData = [];
    try {
      allData = fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE, "utf-8")) : [];
    } catch (err) {
      logger.error(`Error reading DATA_FILE: ${err.message}`);
    }

    allData.push({
      color: currentData.color,
      surah: currentData.track,
      ayahs: parsePageRanges(currentData.text),
      file_id,
      timestamp: new Date().toISOString()
    });

    fs.writeFileSync(DATA_FILE, JSON.stringify(allData, null, 2), "utf-8");
    ctx.reply("Аудиофайл успешно отправлен и данные сохранены!");
    clearTempFolder();
    Object.assign(currentData, { track: "", text: "", color: "", audioPath: "", message: "" });
  } catch (err) {
    logger.error(`Send audio error: ${err.message}`);
    ctx.reply("Ошибка при отправке аудио.");
  }
});

bot.action("cancel_audio", async (ctx) => {
  await ctx.deleteMessage();
  ctx.reply("Отправка аудио отменена.");
  clearTempFolder();
  Object.assign(currentData, { audioPath: "", color: "", text: "", track: "" });
});

// --- ЗАПУСК БОТА ---
bot.launch()
  .then(() => logger.info("Бот успешно запущен!"))
  .catch(err => logger.error(`Bot launch error: ${err.message}`));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
