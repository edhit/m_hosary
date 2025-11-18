require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const path = require("path");
const fs = require("fs");
const NodeID3 = require("node-id3");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const winston = require("winston");
// const express = require("express");

const surahs = require("./quran.json");
const { mp3create } = require("./mp3create");
const { getTafsir } = require("./tafsir");
const { getKulievTranslation } = require("./translate");

// Настройка ffmpeg
ffmpeg.setFfmpegPath(ffmpegPath);

// Константы и конфигурация
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL;
const TEMP_FOLDER = process.env.TEMP_FOLDER || path.resolve("./temp");
const DATA_FILE = path.resolve("./audio_data.json");
const BACKUP_FOLDER = path.resolve("./backups");
const ADMIN_USER_ID = process.env.ALLOWED_USER_ID;

// Конфигурация
const config = {
  tempFolder: TEMP_FOLDER,
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 50 * 1024 * 1024, // 50MB
  maxAyahs: parseInt(process.env.MAX_AYAHS) || 20,
  sessionTimeout: parseInt(process.env.SESSION_TIMEOUT) || 60 * 60 * 1000,
  cacheTtl: parseInt(process.env.CACHE_TTL) || 30 * 60 * 1000,
};

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
    new winston.transports.File({ filename: "bot.log" }),
  ],
});

// Инициализация бота
const bot = new Telegraf(BOT_TOKEN);

// Статистика бота
const botStats = {
  totalRequests: 0,
  successfulAudio: 0,
  failedAudio: 0,
  users: new Set(),
};

// Кэширование
const cache = new Map();
const CACHE_TTL = config.cacheTtl;

// Очередь обработки
const processingQueue = new Map();

// Создание необходимых папок
[config.tempFolder, BACKUP_FOLDER].forEach((folder) => {
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
});

// --- ГЛОБАЛЬНЫЕ ОБРАБОТЧИКИ ОШИБОК ---
process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught Exception:", error);
  process.exit(1);
});

// --- ФУНКЦИЯ ПРОВЕРКИ АДМИНА ---
function isAdmin(userId) {
  if (!ADMIN_USER_ID) return false;
  const adminIds = ADMIN_USER_ID.split(",").map((id) => id.trim());
  return adminIds.includes(userId.toString());
}

// ---- ADMIN ONLY MIDDLEWARE ----
if (ADMIN_USER_ID) {
  const adminIds = ADMIN_USER_ID.split(",").map((id) => id.trim());
  bot.use((ctx, next) => {
    const userId = ctx.from?.id?.toString();
    if (adminIds.includes(userId)) {
      return next();
    }
    return;
  });
} else {
  console.error("ADMIN_USER_ID не указан в .env!");
}

// --- СИСТЕМА ОЧЕРЕДИ ---
async function addToQueue(userId, task) {
  if (processingQueue.has(userId)) {
    throw new Error(
      "⏳ Ваш предыдущий запрос еще обрабатывается. Подождите..."
    );
  }

  processingQueue.set(userId, { startTime: Date.now() });
  try {
    return await task();
  } finally {
    processingQueue.delete(userId);
  }
}

// --- КЭШИРОВАНИЕ ---
function getCacheKey(type, surah, ayah) {
  return `${type}_${surah}_${ayah}`;
}

async function getCachedTafsir(surah, ayah) {
  const key = getCacheKey("tafsir", surah, ayah);
  const cached = cache.get(key);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const data = await getTafsir(surah, ayah);
  cache.set(key, { data, timestamp: Date.now() });
  return data;
}

async function getCachedTranslation(surah, ayah) {
  const key = getCacheKey("translation", surah, ayah);
  const cached = cache.get(key);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const data = await getKulievTranslation(surah, ayah);
  cache.set(key, { data, timestamp: Date.now() });
  return data;
}

// --- ВАЛИДАЦИЯ ---
function validateSurahAndAyah(surah, ayah) {
  if (surah < 1 || surah > 114) return false;

  // const surahInfo = surahs[surah - 1];
  // if (!surahInfo) return false;

  // return ayah >= 1 && ayah <= surahInfo.ayahs;
}

// --- УТИЛИТЫ ---
function getFolderSize(folderPath) {
  let size = 0;
  try {
    const files = fs.readdirSync(folderPath);
    files.forEach((file) => {
      const filePath = path.join(folderPath, file);
      const stats = fs.statSync(filePath);
      if (stats.isFile()) {
        size += stats.size;
      }
    });
    return (size / 1024 / 1024).toFixed(2);
  } catch (err) {
    return 0;
  }
}

function createLogEntry(ctx, action, metadata = {}) {
  return {
    timestamp: new Date().toISOString(),
    userId: ctx.from?.id,
    username: ctx.from?.username,
    action,
    chatType: ctx.chat?.type,
    ...metadata,
  };
}

// --- СИСТЕМА БЭКАПОВ ---
const backupManager = {
  createBackup: () => {
    try {
      const backupFile = `backup_${Date.now()}.json`;
      const backupPath = path.join(BACKUP_FOLDER, backupFile);

      if (fs.existsSync(DATA_FILE)) {
        fs.copyFileSync(DATA_FILE, backupPath);
        logger.info(`Backup created: ${backupFile}`);
      }

      // Удаляем старые бэкапы (оставляем последние 10)
      const backups = fs
        .readdirSync(BACKUP_FOLDER)
        .filter((f) => f.startsWith("backup_") && f.endsWith(".json"))
        .sort()
        .reverse();

      backups.slice(10).forEach((f) => {
        fs.unlinkSync(path.join(BACKUP_FOLDER, f));
        logger.info(`Old backup deleted: ${f}`);
      });
    } catch (err) {
      logger.error(`Backup error: ${err.message}`);
    }
  },

  restoreBackup: (filename) => {
    // Логика восстановления при необходимости
  },
};

// Автобэкап каждые 24 часа
setInterval(() => backupManager.createBackup(), 24 * 60 * 60 * 1000);

// Глобальные данные (теперь для каждого пользователя отдельно)
const userSessions = new Map();

// Обновляем функцию получения данных пользователя
function getUserData(userId) {
  if (!userSessions.has(userId)) {
    userSessions.set(userId, {
      track: "",
      text: "",
      artist: "Mahmoud Al-Hosary",
      color: "",
      audioPath: "",
      message: "",
      tafsirParts: [],
      currentTafsirPage: 0,
      button: null,
    });
  }
  return userSessions.get(userId);
}

// Форматирование нумерованного текста
function formatNumberedText(text) {
  // console.log(text);

  try {
    const parts = text.split(/(\d+\.)\s*/);
    let formattedText = "";
    let currentNumber = "";

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].trim();
      if (part.match(/^\d+\.$/)) {
        currentNumber = part;
      } else if (currentNumber && part) {
        formattedText += `${currentNumber} ${part}\n\n`;
        currentNumber = "";
      } else if (part) {
        formattedText += part + " ";
      }
    }

    return formattedText.trim();
  } catch (error) {
    return text;
  }
}

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
        const [startStr, endStr] = trimmed.split("-").map((s) => s.trim());
        const start = parseInt(startStr, 10);
        const end = parseInt(endStr, 10);
        if (isNaN(start) || isNaN(end) || start > end)
          throw new Error(`Invalid range: "${trimmed}"`);
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
};

const clearTempFolder = () => {
  try {
    fs.readdirSync(TEMP_FOLDER).forEach((file) =>
      fs.unlinkSync(path.join(TEMP_FOLDER, file))
    );
  } catch (err) {
    logger.error(`Error clearing temp folder: ${err.message}`);
  }
};

// --- УТИЛИТА ДЛЯ ЧТЕНИЯ audio_data.json ---
function getAudioData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch (err) {
    logger.error(`Ошибка чтения audio_data.json: ${err.message}`);
    return [];
  }
}

// --- УТИЛИТА ДЛЯ ЗАПИСИ audio_data.json ---
function setAudioData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
    return true;
  } catch (err) {
    logger.error(`Ошибка записи audio_data.json: ${err.message}`);
    return false;
  }
}

// --- ПРОГРЕСС-БАР ---
async function showProgress(ctx, messageId, progress) {
  const bars = "█".repeat(Math.floor(progress / 10));
  const spaces = "░".repeat(10 - Math.floor(progress / 10));

  const text = `Обработка аудио...\n[${bars}${spaces}] ${progress}%`;

  try {
    await ctx.telegram.editMessageText(ctx.chat.id, messageId, null, text);
  } catch (e) {
    // Игнорируем ошибки редактирования
  }
}

// --- MIDDLEWARE ДЛЯ ЛОГИРОВАНИЯ И СТАТИСТИКИ ---
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "без username";
  const firstName = ctx.from?.first_name || "без имени";

  botStats.totalRequests++;
  botStats.users.add(userId);

  logger.info(
    `Пользователь ${userId} (@${username}, ${firstName}) вызвал команду: ${
      ctx.message?.text || "callback"
    }`
  );

  await next();
});

function writeID3(tags, path) {
  return new Promise((resolve, reject) => {
    NodeID3.write(tags, path, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function metaTags(tags, outputAudioPath, tempMsg, ctx, userData) {
  try {
    await writeID3(tags, outputAudioPath);
    userData.audioPath = outputAudioPath;

    try {
      await ctx.deleteMessage(tempMsg.message_id);
    } catch (e) {
      console.error("Ошибка удаления сообщения:", e.message);
    }

    const isOneAyah = userData.text && /^\d+$/.test(userData.text.trim());

    if (isAdmin(ctx.from.id)) {
      await ctx.reply(
        "Выберите цвет перед подтверждением:",
        Markup.inlineKeyboard([
          [
            Markup.button.callback("🔵", "color_🔵"),
            Markup.button.callback("🟢", "color_🟢"),
            Markup.button.callback("🔴", "color_🔴"),
            Markup.button.callback("🟡", "color_🟡"),
          ],
          [
            Markup.button.callback("🟣", "color_🟣"),
            Markup.button.callback("🟠", "color_🟠"),
            Markup.button.callback("🟥", "color_🟥"),
          ],
          ...(isOneAyah
            ? [
                [
                  Markup.button.callback(
                    "📖 Показать перевод",
                    "show_translate"
                  ),
                ],
                [Markup.button.callback("📘 Показать тафсир", "show_tafsir")],
              ]
            : []),
        ])
      );
    } else {
      await ctx.reply(
        "Аудио готово!",
        Markup.inlineKeyboard([
          [Markup.button.callback("📤 Отправить выбранные аяты", "color_🔵")],
          ...(isOneAyah
            ? [
                [
                  Markup.button.callback(
                    "📖 Показать перевод",
                    "show_translate"
                  ),
                ],
                [Markup.button.callback("📘 Показать тафсир", "show_tafsir")],
              ]
            : []),
        ])
      );
    }

    botStats.successfulAudio++;
    return true;
  } catch (err) {
    console.error("metaTags error:", err);
    botStats.failedAudio++;
    return false;
  }
}

async function showTafsir(ctx, reply) {
  try {
    await ctx.answerCbQuery("Загружаю...");
    const userData = getUserData(ctx.from.id);

    if (reply) {
      await ctx.editMessageReplyMarkup();
    }

    const surah = parseInt(userData.track);
    const ayah = parseInt(userData.text);
    const surahInfo = surahs[Number(userData.track) - 1] || {};

    // Сбрасываем старые данные каждый раз при открытии
    userData.tafsirParts = [];
    userData.currentTafsirPage = 0;

    // Загружаем текст с кэшированием
    const tafsir = formatNumberedText(await getCachedTafsir(surah, ayah));

    if (!tafsir) {
      await ctx.answerCbQuery("❌ Тафсир не найден.");
      return await ctx.editMessageText("⚠️ Тафсир не найден.");
    }

    // Разбивка по словам
    const words = tafsir.split(" ");
    const maxLength = 512;
    let current = "";

    for (const word of words) {
      if ((current + " " + word).length > maxLength) {
        userData.tafsirParts.push(current.trim() + "...");
        current = word;
      } else {
        current += " " + word;
      }
    }
    if (current.trim()) userData.tafsirParts.push(current.trim());

    if (!userData.tafsirParts || userData.tafsirParts.length === 0) {
      await ctx.answerCbQuery("❌ Ошибка при обработке тафсира.");
      return await ctx.editMessageText("⚠️ Ошибка при обработке тафсира.");
    }

    const keyboard =
      userData.tafsirParts.length > 1
        ? {
            inline_keyboard: [
              [{ text: "Показать ещё", callback_data: "tafsir_next" }],
            ],
          }
        : undefined;

    const message = `
📖 *Тафсир ас-Са'ди*
━━━━━━━━━━━━━━━
🕋 *Сура:* ${surah} ${surahInfo.name_ru}
🔹 *Аят:* ${ayah}

💬 *Толкование:*
_${userData.tafsirParts[0]}_
`;

    if (reply) {
      await ctx.reply(message, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
      });
    } else {
      await ctx.editMessageText(message, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
      });
    }
  } catch (err) {
    console.error(err);
    await ctx.answerCbQuery("❌ Ошибка при загрузке.");
    await ctx.reply("Ошибка при загрузке тафсира. Попробуйте позже.");
  }
}

function getNavigationKeyboard(surah, ayah) {
  const surahInfo = surahs[surah - 1];
  const buttons = [];

  // Проверяем есть ли предыдущий аят
  if (ayah > 1) {
    buttons.push({ text: "⬅️ Пред.аят", callback_data: `prev_ayah` });
  }

  // Проверяем есть ли следующий аят
  if (surahInfo && ayah < surahInfo.ayahs) {
    buttons.push({ text: "След.аят ➡️", callback_data: `next_ayah` });
  }

  const keyboard = [];

  // Добавляем кнопки навигации только если они есть
  if (buttons.length > 0) {
    keyboard.push(buttons);
  }

  // Всегда добавляем кнопку тафсира
  keyboard.push([
    {
      text: "📘 Перейти к тафсиру",
      callback_data: `show_tafsir_reply`,
    },
  ]);

  return {
    inline_keyboard: keyboard,
  };
}

// Использование в функции showTranslation:
async function showTranslation(ctx, surah, ayah) {
  try {
    await ctx.answerCbQuery("Загружаю перевод...");

    const surahInfo = surahs[surah - 1] || {};

    if (!surah || !ayah) {
      return ctx.editMessageText("⚠️ Не удалось определить суру и аят.");
    }

    let translation;
    try {
      translation = await getCachedTranslation(surah, ayah);
    } catch (e) {
      console.error("Ошибка getKulievTranslation:", e);
      return ctx.editMessageText("⚠️ Ошибка загрузки перевода.");
    }

    const maxLen = 2000;
    if (translation.length > maxLen) {
      translation = translation.slice(0, maxLen) + "…";
    }

    const message = `
📖 *Перевод Кулиева*
━━━━━━━━━━━━━━━
🕋 *Сура:* ${surah} ${surahInfo.name_ru}
🔹 *Аят:* ${ayah}

💬 *Перевод:*
_${translation}_
`;

    await ctx.editMessageText(message, {
      parse_mode: "Markdown",
      reply_markup: getNavigationKeyboard(surah, ayah),
    });
  } catch (err) {
    console.error(err);
    await ctx.answerCbQuery("❌ Ошибка.");
    await ctx.reply("Ошибка при загрузке перевода. Попробуйте позже.");
  }
}

// --- КОМАНДЫ ---
bot.start((ctx) => {
  ctx.reply(
    "Ассалямуалейкум!\n\n" +
      "Основные команды:\n" +
      "/surah <номер> - выбрать суру\n" +
      "/help - полная справка\n\n" +
      "Как использовать:\n" +
      "1. Выберите суру: /surah 1\n" +
      "2. Отправьте номера аятов: 1-5, 7, 10",
    {
      reply_markup: {
        keyboard: [["📖 Выбрать суру"]],
        resize_keyboard: true,
      },
    }
  );
});

// --- КОМАНДА ПОМОЩИ ---
bot.command("help", (ctx) => {
  const helpMsg = `
<b>Возможности бота:</b>

<b>/start</b> — Приветствие и краткая инструкция.
<b>/help</b> — Показать это справочное сообщение.
<b>/surah &lt;номер&gt;</b> — Указать номер суры для создания аудио (например: /surah 5).
<b>/surah_info &lt;номер&gt;</b> — Информация о суре.
${
  isAdmin(ctx.from.id)
    ? `

<b>Команды администратора:</b>
<b>/clear_all</b> — Сбросить все текущие данные и очистить временные файлы.
<b>/list_audio</b> — Показать список последних 10 аудиофайлов.
<b>/delete_audio &lt;номер&gt;</b> — Удалить аудиозапись по номеру из списка.
<b>/colors</b> — Показать значение цветов.
<b>/stats</b> — Статистика бота.
`
    : ""
}

<b>Создание аудио:</b>
1. Укажите суру командой <b>/surah &lt;номер&gt;</b>.
2. Отправьте номера аятов (например: 1-5, 7, 10).

<b>Примечание:</b>
Бот создаёт аудиофайлы из Корана в исполнении Махмуда Аль-Хусари.
  `;
  ctx.reply(helpMsg, { parse_mode: "HTML" });
});

// --- КОМАНДА ИНФОРМАЦИИ О СУРЕ ---
bot.command("surah_info", (ctx) => {
  const surahNum = parseInt(ctx.message.text.split(" ")[1]);

  if (!surahNum || surahNum < 1 || surahNum > 114) {
    return ctx.reply("Укажите номер суры от 1 до 114: /surah_info 1");
  }

  const surah = surahs[surahNum - 1];
  const infoMsg = `
📖 *${surah.name_ru} (${surah.name_ar})*

🔸 *Аятов:* ${surah.ayahs}
🔸 *Тип:* ${surah.type === "meccan" ? "Мекканская" : "Мединская"}
🔸 *Ниспослание:* ${surah.revelation_order}

_${surah.name_en}_
  `;

  ctx.reply(infoMsg, { parse_mode: "Markdown" });
});

bot.command("surah", (ctx) => {
  const userData = getUserData(ctx.from.id);
  const newTrack = ctx.message.text.replace("/surah", "").trim();

  if (!newTrack || isNaN(newTrack)) {
    return ctx.reply("Укажите номер суры, например: /surah 5");
  }

  const surahNum = Number(newTrack);

  if (surahNum < 1 || surahNum > 114) {
    return ctx.reply("Номер суры должен быть от 1 до 114");
  }

  userData.track = surahNum;
  ctx.reply(`Выбрана сура ${surahNum}. Теперь отправьте номера аятов.`);
});

// --- КОМАНДА ДЛЯ ПРОСМОТРА ЗНАЧЕНИЕ ЦВЕТОВ ---
bot.command("colors", (ctx) => {
  const colorsMsg = `
Что означают цвета при выборе? 

🔵 Аяты указывающие на могущество Всевышнего Аллаха
🟢 Достоинства пророка и его атрибуты, Атрибуты верующих и их награда. Рай и его описание
🔴 Аяты постановлений
🟡 Рассказы пророков и их истории и чудеса, рассказы народов прошлого
🟣 Священный Коран и его статус, атрибуты человек, отрицание Корана им и высокомерие человека, ответы на клевету и притензии многобожников 
🟠 Судный день его знаки, предпосылки и предупреждение для людей от него 
🟥 Геена и ее атрибуты, мучения многобожников и неверующих в ней
  `;
  ctx.reply(colorsMsg);
});

// --- КОМАНДА СТАТИСТИКИ (ТОЛЬКО ДЛЯ АДМИНА) ---
bot.command("stats", (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const statsMsg = `
📊 *Статистика бота*
━━━━━━━━━━━━━━━
👥 Уникальных пользователей: ${botStats.users.size}
📨 Всего запросов: ${botStats.totalRequests}
✅ Успешных аудио: ${botStats.successfulAudio}
❌ Ошибок: ${botStats.failedAudio}
💾 Размер temp: ${getFolderSize(TEMP_FOLDER)} MB
🕐 Аптайм: ${Math.floor(process.uptime() / 60)} минут
  `;

  ctx.reply(statsMsg, { parse_mode: "Markdown" });
});

// --- КОМАНДА ДЛЯ СБРОСА ВСЕХ ДАННЫХ (ТОЛЬКО ДЛЯ АДМИНА) ---
bot.command("clear_all", (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply("❌ Эта команда доступна только администратору.");
  }

  const userData = getUserData(ctx.from.id);
  Object.assign(userData, {
    track: "",
    text: "",
    color: "",
    audioPath: "",
    message: "",
  });
  clearTempFolder();
  ctx.reply("Данные сброшены.");
});

// --- КОМАНДА ДЛЯ ПРОСМОТРА СПИСКА АУДИО (ТОЛЬКО ДЛЯ АДМИНА) ---
bot.command("list_audio", (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply("❌ Эта команда доступна только администратору.");
  }

  const data = getAudioData();
  if (!data.length) {
    return ctx.reply("Список аудиофайлов пуст.");
  }
  let msg = "📝 <b>Последние аудиофайлы:</b>\n\n";
  data.slice(-10).forEach((item, idx) => {
    const surahInfo = surahs[Number(item.surah) - 1] || {};
    msg += `<b>${idx + 1}.</b> <b>Сура:</b> ${item.surah} — ${
      surahInfo.name_ru || ""
    } (${surahInfo.name_ar || ""})\n`;
    msg += `<b>Аяты:</b> ${item.ayahs.join(", ")}\n`;
    msg += `<b>Цвет:</b> ${item.color}\n`;
    msg += `<b>Дата:</b> ${new Date(item.timestamp).toLocaleString("ru-RU")}\n`;
    msg += "──────────────\n";
  });
  ctx.reply(msg, { parse_mode: "HTML" });
});

// --- КОМАНДА ДЛЯ УДАЛЕНИЯ ЗАПИСИ ПО ИНДЕКСУ (ТОЛЬКО ДЛЯ АДМИНА) ---
bot.command("delete_audio", (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply("❌ Эта команда доступна только администратору.");
  }

  const args = ctx.message.text.split(" ").slice(1);
  const data = getAudioData();
  const last10 = data.slice(-10);
  const idx = parseInt(args[0], 10) - 1;

  if (isNaN(idx) || idx < 0 || idx >= last10.length) {
    return ctx.reply("Некорректный номер записи.");
  }

  const realIdx = data.length - last10.length + idx;
  data.splice(realIdx, 1);

  if (setAudioData(data)) {
    ctx.reply(`Запись №${idx + 1} из последних 10 удалена.`);
  } else {
    ctx.reply("Ошибка при удалении записи.");
  }
});

// --- ИНЛАЙН-ПОИСК СУР ---
// bot.on("inline_query", async (ctx) => {
//   const query = ctx.inlineQuery.query.toLowerCase();

//   const results = surahs
//     .filter(
//       (surah) =>
//         surah.name_ru.toLowerCase().includes(query) ||
//         surah.name_en.toLowerCase().includes(query) ||
//         surah.name_ar.includes(query)
//     )
//     .slice(0, 10)
//     .map((surah, idx) => ({
//       type: "article",
//       id: idx.toString(),
//       title: `${surah.name_ru} (${surah.name_ar})`,
//       description: `Аятов: ${surah.ayahs}`,
//       input_message_content: {
//         message_text: `Выбрана сура ${surah.id} - ${surah.name_ru}`,
//       },
//     }));

//   ctx.answerInlineQuery(results);
// });

// --- ОБРАБОТКА ТЕКСТА С ОЧЕРЕДЬЮ ---
bot.on("text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) {
    return;
  }

  try {
    await addToQueue(ctx.from.id, async () => {
      const userData = getUserData(ctx.from.id);
      userData.tafsirParts = [];
      userData.currentTafsirPage = 0;

      const newText = ctx.message.text.trim();

      if (newText === "📖 Выбрать суру") {
        userData.button = true;
        return ctx.reply("Введите номер суры");
      }

      if (userData.button) {
        if (!isNaN(newText) && newText >= 1 && newText <= 114) {
          userData.track = newText;
          userData.button = null;
          return ctx.reply(`Выбрана сура ${newText}. Отправьте номера аятов.`);
        } else {
          return ctx.reply("Номер суры должен быть от 1 до 114");
        }
      }

      userData.text = newText;

      if (!userData.track || !userData.text) {
        return ctx.reply(
          "Укажите номер суры (/surah) и номера аятов (отправьте текст)."
        );
      }

      const ayahs = parsePageRanges(userData.text);
      if (!ayahs || ayahs.includes(0))
        return ctx.reply("Некорректно указаны номера аятов.");

      // Валидация аятов
      // const maxAyah = Math.max(...ayahs);
      // if (!validateSurahAndAyah(parseInt(userData.track))) {
      //   return ctx.reply("❌ Указанные аяты не существуют в этой суре.");
      // }

      const tempMsg = await ctx.reply("Обработка аудио...");

      // Показываем прогресс
      await showProgress(ctx, tempMsg.message_id, 10);

      const settings = { ayahs, surah: parseInt(userData.track) };
      const outputAudio = await mp3create(settings);
      const outputAudioPath = path.join(outputAudio.folder, outputAudio.file);

      await showProgress(ctx, tempMsg.message_id, 80);

      const tags = {
        title: `Surah ${userData.track} ${
          surahs[Number(userData.track) - 1]?.name_en || "Unknown"
        } (${userData.text})`,
        artist: userData.artist,
        year: new Date().getFullYear(),
      };

      let i = 0;
      while (i < 3) {
        if (
          (await metaTags(tags, outputAudioPath, tempMsg, ctx, userData)) !==
          false
        )
          break;
        i++;
        console.log(i);
      }
    });
  } catch (err) {
    if (err.message.includes("Ваш предыдущий запрос")) {
      return ctx.reply(err.message);
    }
    logger.error(`Text handler error: ${err.message}`);
    ctx.reply("Ошибка при обработке аудио.");
    clearTempFolder();
  }
});

// --- ОБРАБОТКА ЦВЕТА ---
bot.action(/color_(.+)/, async (ctx) => {
  try {
    await ctx.deleteMessage();
    const userData = getUserData(ctx.from.id);
    const colorAction = ctx.match[1];
    userData.color = colorAction;

    if (
      !userData.audioPath ||
      !userData.track ||
      !userData.text ||
      !userData.artist
    ) {
      return ctx.reply(
        "Недостаточно данных для отправки аудио. Начните заново."
      );
    }

    const surahInfo = surahs[Number(userData.track) - 1] || {};
    userData.message = `${colorAction} Сура ${userData.track} «${
      surahInfo.name_en
    } (${surahInfo.name_ru}), ${userData.text.includes("-") ? "аяты" : "аят"} ${
      userData.text
    }» - Махмуд Аль-Хусари\n\n#коран ${toHashtag(surahInfo.name_en)}`;

    await ctx.replyWithAudio(
      {
        source: userData.audioPath,
        filename: `${userData.artist} - ${surahInfo.name_en} - ${userData.text}.mp3`,
      },
      {
        caption: userData.message,
        ...(isAdmin(ctx.from.id)
          ? Markup.inlineKeyboard([
              Markup.button.callback("✅ Отправить", "send_audio"),
              Markup.button.callback("❌ Отмена", "cancel_audio"),
            ])
          : { reply_markup: { inline_keyboard: [] } }),
      }
    );
  } catch (err) {
    logger.error(`Color action error: ${err.message}`);
    ctx.reply("Ошибка при выборе цвета.");
  }
});

// --- ОТПРАВКА И ОТМЕНА ---
bot.action("send_audio", async (ctx) => {
  try {
    await ctx.deleteMessage();
    const userData = getUserData(ctx.from.id);

    if (!userData.audioPath) return ctx.reply("Аудиофайл не найден.");

    const sentAudio = await bot.telegram.sendAudio(
      CHANNEL_ID || ctx.chat.id,
      {
        source: userData.audioPath,
        filename: path.basename(userData.audioPath),
      },
      { caption: userData.message }
    );
    const file_id = sentAudio.audio.file_id;

    let allData = [];
    try {
      allData = fs.existsSync(DATA_FILE)
        ? JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"))
        : [];
    } catch (err) {
      logger.error(`Error reading DATA_FILE: ${err.message}`);
    }

    allData.push({
      color: userData.color,
      surah: userData.track,
      ayahs: parsePageRanges(userData.text),
      file_id,
      timestamp: new Date().toISOString(),
      user_id: ctx.from.id,
      username: ctx.from.username || "unknown",
    });

    fs.writeFileSync(DATA_FILE, JSON.stringify(allData, null, 2), "utf-8");
    ctx.reply("Аудиофайл отправлен и сохранён.");
    clearTempFolder();

    Object.assign(userData, {
      text: "",
      color: "",
      audioPath: "",
      message: "",
    });
  } catch (err) {
    logger.error(`Send audio error: ${err.message}`);
    ctx.reply("Ошибка при отправке аудио.");
  }
});

// Обработчик для кнопки "show_translate"
bot.action("show_translate", async (ctx) => {
  const userData = getUserData(ctx.from.id);
  const surah = Number(userData.track);
  const ayah = Number(userData.text);

  await showTranslation(ctx, surah, ayah);
});

// Обработчик для следующего аята
bot.action("next_ayah", async (ctx) => {
  const userData = getUserData(ctx.from.id);
  userData.text = Number(userData.text) + 1;

  if (userData.text > 1) {
    await showTranslation(ctx, userData.track, userData.text);
  } else {
    await ctx.answerCbQuery("❌ Это первый аят суры");
  }
});

// Обработчик для предыдущего аята
bot.action("prev_ayah", async (ctx) => {
  const userData = getUserData(ctx.from.id);
  userData.text = Number(userData.text) - 1;

  if (userData.text > 1) {
    await showTranslation(ctx, userData.track, userData.text);
  } else {
    await ctx.answerCbQuery("❌ Это первый аят суры");
  }
});

bot.action("show_tafsir", async (ctx) => {
  await showTafsir(ctx);
});

bot.action("show_tafsir_reply", async (ctx) => {
  await showTafsir(ctx, true);
});

// ===========================
//  Показать следующую часть
// ===========================
bot.action("tafsir_next", async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const userData = getUserData(ctx.from.id);

    if (!userData.tafsirParts || userData.tafsirParts.length === 0) {
      await ctx.answerCbQuery("❌ Данные тафсира не найдены. Начните заново.");
      return;
    }

    if (userData.currentTafsirPage >= userData.tafsirParts.length - 1) {
      await ctx.answerCbQuery("❌ Это последняя страница тафсира.");
      return;
    }

    await ctx.editMessageReplyMarkup();

    userData.currentTafsirPage++;

    const hasMore =
      userData.currentTafsirPage < userData.tafsirParts.length - 1;

    const keyboard = hasMore
      ? {
          inline_keyboard: [
            [{ text: "Показать ещё", callback_data: "tafsir_next" }],
          ],
        }
      : undefined;

    const currentTafsirText = userData.tafsirParts[userData.currentTafsirPage];
    if (!currentTafsirText) {
      await ctx.answerCbQuery("❌ Ошибка: текст тафсира не найден.");
      return;
    }

    const message = `
..._${currentTafsirText}_

Страница: *${userData.currentTafsirPage + 1}/${userData.tafsirParts.length}*
`;

    await ctx.reply(message, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
  } catch (err) {
    console.error(err);
    await ctx.answerCbQuery("❌ Ошибка при загрузке тафсира.");
  }
});

bot.action("cancel_audio", async (ctx) => {
  const userData = getUserData(ctx.from.id);
  await ctx.deleteMessage();
  ctx.reply("Отправка отменена.");
  clearTempFolder();
  Object.assign(userData, {
    audioPath: "",
    color: "",
    text: "",
  });
});

// --- HEALTH CHECK СЕРВЕР ---
// const app = express();
// app.get("/health", (req, res) => {
//   res.json({
//     status: "ok",
//     uptime: process.uptime(),
//     memory: process.memoryUsage(),
//     timestamp: new Date().toISOString(),
//     users: botStats.users.size,
//     requests: botStats.totalRequests,
//   });
// });

// const HEALTH_PORT = process.env.HEALTH_PORT || 3000;
// app.listen(HEALTH_PORT, () => {
//   logger.info(`Health check server running on port ${HEALTH_PORT}`);
// });

// --- ОЧИСТКА СТАРЫХ СЕССИЙ ---
setInterval(() => {
  const now = Date.now();
  const MAX_SESSION_AGE = config.sessionTimeout;

  for (const [userId, data] of userSessions.entries()) {
    // Если у данных есть timestamp, можно добавить проверку на возраст
    // Пока просто оставляем очистку на будущее
  }
}, 30 * 60 * 1000);

// --- ЗАПУСК БОТА ---
bot
  .launch()
  .then(() => {
    logger.info("Бот успешно запущен!");
    logger.info(`Health check доступен на порту ${HEALTH_PORT}`);
  })
  .catch((err) => logger.error(`Bot launch error: ${err.message}`));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
