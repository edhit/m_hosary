require("dotenv").config();

// ================================================================
// ИМПОРТ МОДУЛЕЙ
// ================================================================
const { Telegraf, Markup } = require("telegraf");
const path = require("path");
const fs = require("fs");
const NodeID3 = require("node-id3");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const winston = require("winston");

const surahs = require("./quran.json");
const { mp3create, toGlobalAyah } = require("./mp3create");
const { getTafsir, hasTafsir } = require("./db-tafsir");
const {
  getAbuAdelTranslation,
  getKulievTranslation,
} = require("./db-translations");
const { getAyahPhoto } = require("./db-ayah-photos");
const { getValue } = require("./db-keys");
const usersDB = require("./db-users");
const redisLimiter = require("./redis-limits");

// ================================================================
// КОНФИГУРАЦИЯ
// ================================================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL;
const GROUP_ID = process.env.GROUP;
const TEMP_FOLDER = process.env.TEMP_FOLDER || path.resolve("./temp");
const DATA_FILE = path.resolve("./audio_data.json");
const BACKUP_FOLDER = path.resolve("./backups");
const ADMIN_USER_ID = process.env.ALLOWED_USER_ID;
const ALERT_CHAT_ID = process.env.ALERT_CHAT_ID;

// Webhook-режим включается автоматически, если задан WEBHOOK_DOMAIN.
// Если его нет — бот работает через обычный long polling (как раньше).
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN; // например: https://example.com
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || `/telegraf/${BOT_TOKEN}`;
const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT) || 8443;
const WEBHOOK_SECRET_TOKEN = process.env.WEBHOOK_SECRET_TOKEN || undefined;

const CONFIG = {
  tempFolder: TEMP_FOLDER,
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 50 * 1024 * 1024,
  sessionTimeout: parseInt(process.env.SESSION_TIMEOUT) || 60 * 60 * 1000,
  // ВАЖНО: реальные лимиты запросов применяются внутри redis-limits.js.
  // Эти значения используются только этим файлом (redisLimiter.init ниже
  // получает их явно), чтобы не было двух независимых источников правды.
  userLimits: {
    requestsPerMinute: parseInt(process.env.REQUESTS_PER_MINUTE) || 10,
    requestsPerHour: parseInt(process.env.REQUESTS_PER_HOUR) || 50,
    maxAyahsPerRequest: parseInt(process.env.MAX_AYAHS_PER_REQUEST) || 50,
    audioPerHour: parseInt(process.env.AUDIO_PER_HOUR) || 5,
    audioPerDay: parseInt(process.env.AUDIO_PER_DAY) || 20,
  },
  memoryCleanupInterval:
    parseInt(process.env.MEMORY_CLEANUP_INTERVAL) || 10 * 60 * 1000,
};

// Оставлены только реально используемые флаги.
const FEATURE_FLAGS = {
  qualityCheck: process.env.FF_QUALITY_CHECK === "true",
  redisLimits: process.env.FF_REDIS_LIMITS === "true",
  usersDatabase: process.env.FF_USERS_DB === "true",
};

// ================================================================
// ЛОГИРОВАНИЕ
// ================================================================
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple(),
      ),
    }),
    new winston.transports.File({
      filename: "logs/error.log",
      level: "error",
      maxsize: 10485760,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: "logs/combined.log",
      maxsize: 10485760,
      maxFiles: 5,
    }),
  ],
});

// ================================================================
// ШАБЛОНЫ СООБЩЕНИЙ
// ================================================================
const MESSAGE_TEMPLATES = {
  welcome: (name) => `
Ассаляму алейкум, ${name}!

🕌 Это бот получения аята и тафсира для него

📖 Основные команды:
/surah <номер> - выбрать суру
/surah_info <номер> - информация о суре
/help - полная справка

Пример использования:
1. /surah 1
2. Отправьте номер аята: 7

или нажмите на кнопку ниже, чтобы выбрать суру и аят
  `,

  error: (type) => {
    const errors = {
      processing: "⚠️ Ошибка при обработке аудио. Попробуйте позже.",
      validation: "❌ Некорректные данные. Проверьте номер суры и аятов.",
      timeout: "⏰ Время обработки истекло. Попробуйте снова.",
      general: "❌ Произошла ошибка. Мы уже работаем над исправлением.",
      rateLimit: "⏳ Слишком много запросов. Пожалуйста, подождите.",
      fileTooLarge: "📁 Файл слишком большой. Попробуйте меньше аятов.",
      network: "🌐 Проблемы с сетью. Попробуйте позже.",
      audioLimit: "🎵 Превышен лимит создания аудио. Попробуйте позже.",
    };
    return errors[type] || errors.general;
  },
};

// ================================================================
// ИНИЦИАЛИЗАЦИЯ БОТА / FFMPEG / ПАПОК
// ================================================================
const bot = new Telegraf(BOT_TOKEN);

try {
  ffmpeg.setFfmpegPath(ffmpegPath);
} catch (error) {
  logger.error("Error setting ffmpeg path:", error);
}

["logs", CONFIG.tempFolder, BACKUP_FOLDER].forEach((folder) => {
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
});

// ================================================================
// СЕССИИ (в памяти процесса)
// ================================================================
// track / text          — выбранная сура / аят(ы), общий для любого юзера сценарий
// translate             — выбранный перевод (abu_adel | kuliev)
// tafsirParts / page    — постраничный тафсир текущего аята
// audioPath / audioMode — путь к готовому аудио и его происхождение:
//                          'single' — file_id одного аята из БД (можно переиспользовать)
//                          'multi'  — локальный файл, склеенный из нескольких аятов
//                                     (нельзя молча подменять на file_id одного аята)
// color / message       — состояние процесса публикации в канал/группу (только админ)
class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.processingQueue = new Map();
  }

  getSession(userId) {
    if (!this.sessions.has(userId)) {
      this.sessions.set(userId, this._blank());
    } else {
      this.sessions.get(userId).lastActivity = Date.now();
    }
    return this.sessions.get(userId);
  }

  _blank() {
    return {
      track: "",
      text: "",
      artist: "Mahmoud Al-Hosary",
      color: "",
      audioPath: "",
      audioMode: "single",
      message: "",
      tafsirParts: [],
      currentTafsirPage: 0,
      button: null,
      lastActivity: Date.now(),
    };
  }

  cleanupOldSessions(maxAge = CONFIG.sessionTimeout) {
    const now = Date.now();
    let cleaned = 0;
    for (const [userId, session] of this.sessions.entries()) {
      if (now - session.lastActivity > maxAge) {
        this.sessions.delete(userId);
        cleaned++;
      }
    }
    if (cleaned > 0) logger.info(`Cleaned ${cleaned} old sessions`);
    return cleaned;
  }

  getSessionCount() {
    return this.sessions.size;
  }

  addToProcessingQueue(userId) {
    if (this.processingQueue.has(userId)) {
      throw new Error(
        "⏳ Ваш предыдущий запрос еще обрабатывается. Подождите...",
      );
    }
    this.processingQueue.set(userId, { startTime: Date.now() });
  }

  removeFromProcessingQueue(userId) {
    this.processingQueue.delete(userId);
  }
}

const sessionManager = new SessionManager();
function getUserData(userId) {
  return sessionManager.getSession(userId);
}

// ================================================================
// УТИЛИТЫ
// ================================================================
function isAdmin(userId) {
  if (!ADMIN_USER_ID) return false;
  const adminIds = ADMIN_USER_ID.split(",").map((id) => id.trim());
  return adminIds.includes(userId?.toString());
}

function parsePageRanges(input) {
  try {
    if (!input || typeof input !== "string") return [];
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
}

function toHashtag(str) {
  try {
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
  } catch (error) {
    logger.error("Error in toHashtag:", error);
    return "#error";
  }
}

function clearTempFolder() {
  try {
    fs.readdirSync(CONFIG.tempFolder).forEach((file) => {
      try {
        fs.unlinkSync(path.join(CONFIG.tempFolder, file));
      } catch (err) {
        logger.error(`Error deleting file ${file}: ${err.message}`);
      }
    });
  } catch (err) {
    logger.error(`Error clearing temp folder: ${err.message}`);
  }
}

function getFolderSize(folderPath) {
  try {
    let size = 0;
    fs.readdirSync(folderPath).forEach((file) => {
      const stats = fs.statSync(path.join(folderPath, file));
      if (stats.isFile()) size += stats.size;
    });
    return (size / 1024 / 1024).toFixed(2);
  } catch (err) {
    return 0;
  }
}

// --- Простая очередь записи в audio_data.json, чтобы избежать гонок
// при параллельных вызовах send_audio / delete_audio (даже если сейчас
// публикует обычно один админ, это ничего не стоит и снимает риск). ---
let audioDataWriteChain = Promise.resolve();
function withAudioDataLock(task) {
  const result = audioDataWriteChain.then(task, task);
  audioDataWriteChain = result.catch(() => {});
  return result;
}

function getAudioData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch (err) {
    logger.error(`Ошибка чтения audio_data.json: ${err.message}`);
    return [];
  }
}

function setAudioData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
    return true;
  } catch (err) {
    logger.error(`Ошибка записи audio_data.json: ${err.message}`);
    return false;
  }
}

function shareLink(ctx, surah, ayah, urlonly = false) {
  const baseUrl = `https://t.me/${ctx.botInfo.username}?start=s${surah}_a${ayah}`;
  if (urlonly) return baseUrl;
  return (
    `🔗 <b>Ссылка на аят:</b>\n\n` +
    `Сура ${surah}, Аят ${ayah}\n\n` +
    `Для быстрого перехода к этому аяту скопируйте ссылку ниже:\n\n` +
    `${baseUrl}\n\n` +
    `Или просто нажмите на нее, чтобы открыть.`
  );
}

// audioPath хранит либо file_id Telegram (одиночный аят из БД),
// либо локальный путь к mp3, склеенному из нескольких аятов (только админ).
function getAudioInput(audioPath) {
  if (Buffer.isBuffer(audioPath)) return { source: audioPath };
  if (typeof audioPath !== "string") {
    throw new Error("unknown audioPath format");
  }
  if (audioPath.startsWith("http")) return { url: audioPath };
  if (audioPath.includes("/") || audioPath.includes("\\")) {
    return { source: audioPath };
  }
  return audioPath; // file_id
}

async function ensureUserExists(userId, firstName, username) {
  if (!FEATURE_FLAGS.usersDatabase) return;
  try {
    await usersDB.upsertUser(userId, firstName || "User", username);
  } catch (error) {
    logger.error("Error in ensureUserExists:", error);
  }
}

// ================================================================
// СИСТЕМА ОЧЕРЕДИ ОБРАБОТКИ (один активный запрос на пользователя)
// ================================================================
async function addToQueue(userId, task) {
  sessionManager.addToProcessingQueue(userId);
  try {
    return await task();
  } finally {
    sessionManager.removeFromProcessingQueue(userId);
  }
}

async function retryWithBackoff(operation, maxRetries = 3, baseDelay = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === maxRetries) throw error;
      const delay = baseDelay * Math.pow(2, attempt - 1);
      const jitter = delay * 0.1 * Math.random();
      logger.warn(
        `Retry attempt ${attempt} after ${Math.round(delay + jitter)}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay + jitter));
    }
  }
}

async function showProgress(ctx, messageId, progress) {
  try {
    const bars = "█".repeat(Math.floor(progress / 10));
    const spaces = "░".repeat(10 - Math.floor(progress / 10));
    const text = `Обработка аудио...\n[${bars}${spaces}] ${progress}%`;
    await ctx.telegram.editMessageText(ctx.chat.id, messageId, null, text);
  } catch (e) {
    // сообщение могли уже удалить/изменить — не критично
  }
}

// ================================================================
// АУДИО: ID3-теги, проверка качества, склейка
// ================================================================
function writeID3(tags, filePath) {
  return new Promise((resolve, reject) => {
    NodeID3.write(tags, filePath, (err) => (err ? reject(err) : resolve()));
  });
}

const audioQuality = {
  validateFile: function (filePath) {
    return new Promise((resolve) => {
      try {
        const stats = fs.statSync(filePath);
        if (stats.size === 0)
          return resolve({ valid: false, reason: "empty_file" });
        if (stats.size > CONFIG.maxFileSize)
          return resolve({ valid: false, reason: "file_too_large" });

        ffmpeg.ffprobe(filePath, (err, metadata) => {
          if (err) return resolve({ valid: false, reason: "corrupted_file" });
          const duration = metadata.format.duration;
          if (!duration || duration < 0.1)
            return resolve({ valid: false, reason: "invalid_duration" });
          resolve({ valid: true, duration, size: stats.size });
        });
      } catch (error) {
        resolve({ valid: false, reason: "file_error" });
      }
    });
  },
};

// ================================================================
// КЛАВИАТУРА НАВИГАЦИИ ПО АЯТАМ (используется под тафсиром)
// ================================================================
function getNavigationKeyboard(surah, ayah, withTafsirButton, userData) {
  const surahInfo = surahs[surah - 1];
  const buttons = [];

  if (ayah > 1) {
    buttons.push({
      text: "⬅️ Пред.аят",
      callback_data: `prev_ayah:${surah}:${ayah - 1}:${withTafsirButton ? "false" : "true"}`,
    });
  }
  if (surahInfo && ayah < surahInfo.ayahs) {
    buttons.push({
      text: "След.аят ➡️",
      callback_data: `next_ayah:${surah}:${ayah + 1}:${withTafsirButton ? "false" : "true"}`,
    });
  }

  const keyboard = [];
  if (buttons.length > 0) keyboard.push(buttons);

  keyboard.push([
    { text: "🔈 Прослушать аят", callback_data: `color_🔈:${surah}:${ayah}` },
  ]);

  if (withTafsirButton) {
    const nextPage = (userData?.currentTafsirPage || 0) + 1;
    keyboard.push([
      {
        text: "📘 Перейти к тафсиру",
        callback_data: `show_tafsir:true:${surah}:${ayah}:${nextPage}`,
      },
    ]);
  }

  return { inline_keyboard: keyboard };
}

// ================================================================
// ПЕРЕВОД / ТАФСИР (прямые обращения к БД, без кэш-слоя)
// ================================================================
async function showTranslation(
  ctx,
  surah,
  ayah,
  reply = false,
  afterText = false,
) {
  try {
    if (!afterText) await ctx.answerCbQuery("Загружаю перевод...");
    const userData = getUserData(ctx.from.id);
    const surahInfo = surahs[surah - 1] || {};
    const translate = userData.translate || "abu_adel";

    if (reply && !afterText) await ctx.editMessageReplyMarkup();

    if (!surah || !ayah) {
      const msg = "⚠️ Не удалось определить суру и аят.";
      return reply ? ctx.reply(msg) : ctx.editMessageText(msg);
    }

    const [translationResult, photoFileId] = await Promise.allSettled([
      translate === "kuliev"
        ? getKulievTranslation(surah, ayah)
        : getAbuAdelTranslation(surah, ayah),
      getAyahPhoto(surah, ayah),
    ]);

    let translationText =
      translationResult.status === "fulfilled"
        ? translationResult.value
        : "⚠️ Ошибка загрузки перевода.";
    if (translationResult.status === "rejected") {
      logger.error("Ошибка получения перевода:", translationResult.reason);
    }

    userData.fullTranslation = translationText;

    const maxFirstPartLength = 512;
    const minSecondPartLength = 150;
    let firstPart = translationText;
    let hasMore = false;

    if (translationText.length > maxFirstPartLength) {
      let cutIndex = maxFirstPartLength;
      for (
        let i = maxFirstPartLength;
        i > maxFirstPartLength - 50 && i > 0;
        i--
      ) {
        if ([".", "!", "?", ";", "\n", " "].includes(translationText[i])) {
          cutIndex = i + 1;
          break;
        }
      }
      if (cutIndex === maxFirstPartLength) {
        for (
          let i = maxFirstPartLength;
          i < maxFirstPartLength + 50 && i < translationText.length;
          i++
        ) {
          if ([".", "!", "?", ";", "\n", " "].includes(translationText[i])) {
            cutIndex = i + 1;
            break;
          }
        }
      }

      const remainingLength = translationText.length - cutIndex;
      if (remainingLength < minSecondPartLength) {
        firstPart = translationText;
        hasMore = false;
      } else {
        if (remainingLength < 200) {
          let betterCutIndex = cutIndex;
          for (let i = cutIndex; i > cutIndex - 100 && i > 0; i--) {
            if ([".", "!", "?", ";", "\n"].includes(translationText[i])) {
              const potentialRemaining = translationText.length - (i + 1);
              if (potentialRemaining >= 200) {
                betterCutIndex = i + 1;
                break;
              }
            }
          }
          cutIndex = betterCutIndex;
        }
        firstPart = translationText.substring(0, cutIndex) + "...";
        hasMore = true;
      }
    }

    const message = `
📖 <b>Сура ${surah}</b> «${surahInfo.name_ru}» — аят <b>${ayah}</b>/${surahInfo.ayahs}

${firstPart}

<i>Перевод: ${translate === "abu_adel" ? "Абу Адель" : "Кулиев"}</i>
`;

    const keyboard = { inline_keyboard: [] };

    if (hasMore) {
      keyboard.inline_keyboard.push([
        {
          text: "📖 Показать полный перевод",
          callback_data: `show_translation_continue:${surah}:${ayah}`,
        },
      ]);
    }

    const ayahNavigation = [];
    if (ayah > 1) {
      ayahNavigation.push({
        text: "⬅️ Пред.аят",
        callback_data: `prev_translation_ayah:${surah}:${ayah - 1}`,
      });
    }
    if (surahInfo && ayah < surahInfo.ayahs) {
      ayahNavigation.push({
        text: "След.аят ➡️",
        callback_data: `next_translation_ayah:${surah}:${ayah + 1}`,
      });
    }
    if (ayahNavigation.length > 0)
      keyboard.inline_keyboard.push(ayahNavigation);

    keyboard.inline_keyboard.push([
      {
        text: `🔄 Перевод ${translate === "abu_adel" ? "Кулиева" : "Абу Аделя"}`,
        callback_data: `change_translate:${surah}:${ayah}`,
      },
    ]);

    keyboard.inline_keyboard.push([
      { text: "🔈 Прослушать аят", callback_data: `color_🔈:${surah}:${ayah}` },
    ]);

    if (await hasTafsir(surah, ayah)) {
      keyboard.inline_keyboard.push([
        {
          text: "📘 Показать тафсир",
          callback_data: `show_tafsir:true:${surah}:${ayah}`,
        },
      ]);
    }

    keyboard.inline_keyboard.push([
      {
        text: "📤 Поделиться аятом",
        callback_data: `show_share_link:${surah}:${ayah}`,
      },
    ]);

    const hasPhoto = photoFileId.status === "fulfilled" && photoFileId.value;

    if (hasPhoto) {
      try {
        if (reply) {
          await ctx.replyWithPhoto(photoFileId.value, {
            caption: message,
            parse_mode: "HTML",
            reply_markup: keyboard,
          });
        } else {
          await ctx.editMessageMedia(
            {
              type: "photo",
              media: photoFileId.value,
              caption: message,
              parse_mode: "HTML",
            },
            { reply_markup: keyboard },
          );
        }
        return;
      } catch (photoError) {
        logger.error("Error sending photo:", photoError);
        // падаем в текстовый вариант ниже
      }
    }

    if (photoFileId.status === "rejected") {
      logger.warn(
        `Photo not found for surah ${surah}, ayah ${ayah}:`,
        photoFileId.reason,
      );
    }

    if (reply) {
      await ctx.reply(message, { parse_mode: "HTML", reply_markup: keyboard });
    } else {
      await ctx.editMessageText(message, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    }
  } catch (err) {
    logger.error("Error in showTranslation:", err);
    if (!afterText) await ctx.answerCbQuery("❌ Ошибка загрузки перевода.");
    const msg = "Ошибка при загрузке перевода. Попробуйте позже.";
    if (reply) await ctx.reply(msg);
    else await ctx.editMessageText(msg);
  }
}

function splitTafsirIntoParts(tafsir, maxChars = 1700) {
  const SENTENCE_ENDINGS = [".", "!", "?", ";", ":", "»", "..."];
  const parts = [];
  let remainingText = tafsir;

  while (remainingText.length > 0) {
    if (remainingText.length <= maxChars) {
      parts.push(remainingText.trim());
      break;
    }

    let cutIndex = maxChars;
    let foundBreak = false;

    for (let i = maxChars; i > maxChars - 500; i--) {
      if (i >= remainingText.length) continue;
      if (SENTENCE_ENDINGS.includes(remainingText[i])) {
        if (i + 1 >= remainingText.length || /\s/.test(remainingText[i + 1])) {
          cutIndex = i + 1;
          foundBreak = true;
          break;
        }
      }
      if (remainingText[i] === "\n" && i > maxChars - 100) {
        cutIndex = i + 1;
        foundBreak = true;
        break;
      }
    }

    if (!foundBreak) {
      for (let i = maxChars; i > maxChars - 100; i--) {
        if (i >= remainingText.length) continue;
        if (remainingText[i] === " ") {
          cutIndex = i + 1;
          foundBreak = true;
          break;
        }
      }
    }

    if (!foundBreak) cutIndex = maxChars;

    const part = remainingText.substring(0, cutIndex).trim();
    if (part.length > 0) parts.push(part);
    remainingText = remainingText.substring(cutIndex).trim();
  }

  return parts;
}

async function showTafsir(ctx, surah, ayah, currentPage = 0, reply = false) {
  try {
    await ctx.answerCbQuery("Загружаю тафсир...");
    const userData = getUserData(ctx.from.id);

    if (reply) await ctx.editMessageReplyMarkup();

    const surahInfo = surahs[Number(surah) - 1] || {};
    userData.currentTafsirPage = currentPage;

    let tafsir = await getTafsir(surah, ayah);
    if (!tafsir) tafsir = "⚠️ Для этого аята тафсира нет.";

    userData.tafsirParts = splitTafsirIntoParts(tafsir);

    if (!userData.tafsirParts.length) {
      await ctx.answerCbQuery("❌ Ошибка при обработке тафсира.");
      const msg = "⚠️ Ошибка при обработке тафсира.";
      return reply ? ctx.reply(msg) : ctx.editMessageText(msg);
    }

    const hasMorePages =
      userData.tafsirParts.length > 1 &&
      currentPage < userData.tafsirParts.length - 1;
    const keyboard = hasMorePages
      ? {
          inline_keyboard: [
            [
              {
                text: "📖 Продолжение тафсира",
                callback_data: `tafsir_next:false:${surah}:${ayah}:${currentPage}`,
              },
            ],
          ],
        }
      : getNavigationKeyboard(surah, ayah, false, userData);

    const firstPartText = userData.tafsirParts[currentPage];
    const hasMore = userData.tafsirParts.length > 1;

    const message = `
📘 <b>Тафсир ас-Са'ди</b> — сура ${surah} «${surahInfo.name_ru}», аят ${ayah}${hasMore ? ` <i>(${currentPage + 1}/${userData.tafsirParts.length})</i>` : ""}

${firstPartText}${hasMore ? "..." : ""}
`;

    if (reply) {
      await ctx.reply(message, { parse_mode: "HTML", reply_markup: keyboard });
    } else {
      await ctx.editMessageText(message, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    }
  } catch (err) {
    logger.error("Error in showTafsir:", err);
    await ctx.answerCbQuery("❌ Ошибка при загрузке.");
    await ctx.reply("Ошибка при загрузке тафсира. Попробуйте позже.");
  }
}

async function surahListMessage(ctx) {
  let surahList = "📖 <b>Список сур Корана:</b>\n\n";
  surahs.forEach((surah) => {
    surahList += `${surah.number}. ${surah.name_en} (${surah.ayahs}) /surah_${surah.number}\n`;
  });
  surahList +=
    "\n<i>Нажми на команду суры, чтобы выбрать её или введи номер</i>";
  await ctx.reply(surahList, { parse_mode: "HTML" });
}

// ================================================================
// ЗАВЕРШЕНИЕ / ПУБЛИКАЦИЯ АУДИО
// ================================================================
async function finalizeAudio(ctx, userData) {
  try {
    const isOneAyah =
      userData.text && /^\d+$/.test(userData.text.toString().trim());
    const surah = parseInt(userData.track);
    const ayah = parseInt(userData.text);
    const hasTafsirInfo = await hasTafsir(surah, ayah);

    if (isAdmin(ctx.from.id)) {
      // Админ видит выбор "цвета" тематики перед публикацией в канал/группу.
      await ctx.reply(
        "Выберите цвет перед подтверждением:",
        Markup.inlineKeyboard([
          [
            Markup.button.callback("🔵", `color_🔵:${surah}:${ayah}`),
            Markup.button.callback("🟢", `color_🟢:${surah}:${ayah}`),
            Markup.button.callback("🔴", `color_🔴:${surah}:${ayah}`),
            Markup.button.callback("🟡", `color_🟡:${surah}:${ayah}`),
          ],
          [
            Markup.button.callback("🟣", `color_🟣:${surah}:${ayah}`),
            Markup.button.callback("🟠", `color_🟠:${surah}:${ayah}`),
            Markup.button.callback("🟥", `color_🟥:${surah}:${ayah}`),
          ],
          ...(isOneAyah
            ? [
                [
                  Markup.button.callback(
                    "📕 Показать перевод",
                    `show_translate:false:${surah}:${ayah}`,
                  ),
                ],
                ...(hasTafsirInfo
                  ? [
                      [
                        Markup.button.callback(
                          "📘 Показать тафсир",
                          `show_tafsir:false:${surah}:${ayah}`,
                        ),
                      ],
                    ]
                  : []),
              ]
            : []),
        ]),
      );
    } else {
      // Обычный пользователь сразу видит перевод — без публикационного шага.
      await showTranslation(ctx, surah, ayah, true, true);
    }

    return true;
  } catch (error) {
    logger.error("finalizeAudio error:", error);
    return false;
  }
}

async function metaTags(tags, outputAudioPath, ctx, userData) {
  try {
    await writeID3(tags, outputAudioPath);
    userData.audioPath = outputAudioPath;
    userData.audioMode = "multi";

    if (FEATURE_FLAGS.qualityCheck) {
      const qualityCheck = await audioQuality.validateFile(outputAudioPath);
      if (!qualityCheck.valid) {
        logger.warn("Audio quality check failed", {
          path: outputAudioPath,
          reason: qualityCheck.reason,
        });
      }
    }

    return await finalizeAudio(ctx, userData);
  } catch (err) {
    logger.error("metaTags error:", err);
    return false;
  }
}

async function createAudioWithLimits(ctx, userData, ayahs) {
  try {
    if (FEATURE_FLAGS.redisLimits) {
      const audioLimitCheck = await redisLimiter.checkAndIncrement(
        ctx.from.id,
        "audio",
      );
      if (!audioLimitCheck.allowed) {
        return {
          success: false,
          error:
            audioLimitCheck.message || MESSAGE_TEMPLATES.error("audioLimit"),
        };
      }
    }

    logger.info(
      `Creating audio for user ${ctx.from.id}: ${userData.track}:${userData.text}`,
      {
        userId: ctx.from.id,
        surah: userData.track,
        ayahs,
      },
    );

    let success = false;

    if (isAdmin(ctx.from.id) && ayahs.length > 1) {
      const tempMsg = await ctx.reply("Обработка аудио...");
      await showProgress(ctx, tempMsg.message_id, 10);

      const settings = { ayahs, surah: parseInt(userData.track) };
      const outputAudio = await retryWithBackoff(
        () => mp3create(settings),
        3,
        1000,
      );
      const outputAudioPath = path.join(outputAudio.folder, outputAudio.file);

      await showProgress(ctx, tempMsg.message_id, 80);

      const surahInfo = surahs.find(
        (s) => s.number === parseInt(userData.track),
      );
      const tags = {
        title: `Surah ${userData.track} ${surahInfo?.name_en || ""} (${userData.text})`,
        artist: userData.artist,
        year: new Date().getFullYear(),
      };

      for (let i = 0; i < 3 && !success; i++) {
        success = await metaTags(tags, outputAudioPath, ctx, userData);
        if (!success)
          logger.warn(`Retry ${i + 1} for metaTags for user ${ctx.from.id}`);
      }

      try {
        await ctx.deleteMessage(tempMsg.message_id);
      } catch (e) {
        logger.error("Ошибка удаления сообщения:", e.message);
      }
    } else {
      userData.audioPath = await getValue(
        toGlobalAyah(userData.track, ayahs[0]),
      );
      userData.audioMode = "single";
      success = await finalizeAudio(ctx, userData);
    }

    return {
      success,
      error: success ? null : MESSAGE_TEMPLATES.error("processing"),
    };
  } catch (error) {
    logger.error("Error in audio creation:", error);
    return { success: false, error: MESSAGE_TEMPLATES.error("processing") };
  }
}

// ================================================================
// MIDDLEWARE
// ================================================================

// Только для админ-only команд публикации/модерации.
function accessForAdminsOnly(ctx, next) {
  const userId = ctx.from?.id?.toString();
  if (isAdmin(userId)) return next();
  logger.warn(
    `Unauthorized access attempt by user ${userId} (@${ctx.from?.username}, ${ctx.from?.first_name})`,
  );
  return ctx.reply("❌ Эта команда доступна только администратору.");
}

// Защита от слишком длинных сообщений. Для админа лимит выше — ему нужно
// место под диапазоны аятов ("1-10,15,20-25" и т.п.).
bot.use((ctx, next) => {
  if (ctx.message?.text) {
    const limit = isAdmin(ctx.from?.id) ? 300 : 50;
    if (ctx.message.text.length > limit) {
      logger.info(
        `Сообщение пользователя ${ctx.from?.id} пропущено (длина > ${limit}).`,
      );
      return;
    }
  }
  return next();
});

// Логирование + rate limiting (админ не лимитируется).
bot.use(async (ctx, next) => {
  try {
    const userId = ctx.from?.id;
    const username = ctx.from?.username || "без username";
    const firstName = ctx.from?.first_name || "без имени";

    if (!isAdmin(userId) && FEATURE_FLAGS.redisLimits) {
      const limitCheck = await redisLimiter.checkAndIncrement(userId);
      if (!limitCheck.allowed) {
        logger.warn(
          `Rate limit exceeded for user ${userId}: ${limitCheck.reason}`,
          {
            userId,
            username,
            firstName,
          },
        );
        const limitMsg =
          limitCheck.message || MESSAGE_TEMPLATES.error("rateLimit");
        // Раньше при превышении лимита на текстовом сообщении бот молчал
        // (return без ответа) — пользователь не понимал, что происходит.
        // Теперь всегда отвечаем, чем бы ни было исходное сообщение.
        if (ctx.message) return ctx.reply(limitMsg);
        return ctx.answerCbQuery(limitMsg);
      }
    }

    logger.info(
      `Пользователь ${userId} (@${username}, ${firstName}) вызвал: ${ctx.message?.text || "callback"}`,
    );

    return next();
  } catch (error) {
    logger.error("Error in logging middleware:", error);
    return next();
  }
});

// ================================================================
// КОМАНДЫ БОТА (доступны всем пользователям)
// ================================================================

bot.start(async (ctx) => {
  try {
    const userId = ctx.from.id;
    const name = ctx.from.first_name || "брат";
    const username = ctx.from.username || null;

    if (FEATURE_FLAGS.usersDatabase) {
      await ensureUserExists(userId, ctx.from.first_name, username);
    }

    const userData = sessionManager.getSession(userId);

    // Диплинк вида ?start=s5_a20 / surah_5_ayah_20 / 5_20 — сразу к аяту.
    const startPayload = ctx.message?.text?.split(" ")[1];
    if (startPayload) {
      const match =
        startPayload.match(/s(\d+)_a(\d+)/) ||
        startPayload.match(/surah_(\d+)_ayah_(\d+)/) ||
        startPayload.match(/(\d+)_(\d+)/);

      if (match) {
        const surah = parseInt(match[1]);
        const ayah = parseInt(match[2]);
        userData.track = surah;
        userData.text = ayah.toString();
        logger.info(
          `User ${userId} used deeplink: surah ${surah}, ayah ${ayah}`,
        );
        await showTranslation(ctx, surah, ayah, true, true);
        return;
      }
    }

    await ctx.reply(MESSAGE_TEMPLATES.welcome(name), {
      reply_markup: {
        keyboard: [["📖 Выбрать суру"]],
        resize_keyboard: true,
      },
    });
  } catch (error) {
    logger.error("Error in start command:", error);
  }
});

bot.command("help", (ctx) => {
  try {
    const helpMsg = `
<b>Возможности бота:</b>

<b>/start</b> — Приветствие и краткая инструкция.
<b>/help</b> — Показать это справочное сообщение.
<b>/surah &lt;номер&gt;</b> — Указать суру, затем отправить номер аята.
<b>/surah_info &lt;номер&gt;</b> — Информация о суре.
${
  isAdmin(ctx.from.id)
    ? `
<b>Команды администратора:</b>
<b>/colors</b> — Значение цветов при публикации.
<b>/clear_all</b> — Сбросить свои данные и очистить temp.
<b>/list_audio</b> — Последние 10 опубликованных аудио.
<b>/delete_audio &lt;номер&gt;</b> — Удалить запись из журнала публикаций.

Только администратор может запрашивать диапазон аятов (например "1-10") — это единственное ограничение для обычных пользователей.
`
    : ""
}
<b>Создание аудио:</b>
1. Укажите суру командой <b>/surah &lt;номер&gt;</b>.
2. Отправьте номер аята (например: 5).

<b>Примечание:</b>
Бот отправляет аят в исполнении Махмуда Аль-Хусари.

<b>Ваш Telegram Id:</b> <code>${ctx.from.id}</code>
  `;
    ctx.reply(helpMsg, { parse_mode: "HTML" });
  } catch (error) {
    logger.error("Error in help command:", error);
  }
});

bot.command("surah_info", (ctx) => {
  try {
    const surahNum = parseInt(ctx.message.text.split(" ")[1]);
    if (!surahNum || surahNum < 1 || surahNum > 114) {
      return ctx.reply("Укажите номер суры от 1 до 114: /surah_info 1");
    }

    const surah = surahs[surahNum - 1];
    const infoMsg = `
📖 <b>${surah.name_ru}</b> (<i>${surah.name_ar}</i>)

🔸 <b>Аятов:</b> ${surah.ayahs}
🔸 <b>Тип:</b> ${surah.type === "meccan" ? "Мекканская" : "Мединская"}
🔸 <b>Ниспослание:</b> ${surah.revelation_order}

_<i>${surah.name_en}</i>_
  `;
    ctx.reply(infoMsg, { parse_mode: "HTML" });
  } catch (error) {
    logger.error("Error in surah_info command:", error);
    ctx.reply("Ошибка при получении информации о суре.");
  }
});

bot.hears(/^\/surah(?:_(\d+))?\s*(\d+)?$/, async (ctx) => {
  try {
    const userData = getUserData(ctx.from.id);
    const match = ctx.match;
    userData.button = null;

    const surahNum = parseInt(match[1] || match[2]);

    if (!surahNum) {
      await surahListMessage(ctx);
      return;
    }
    if (surahNum < 1 || surahNum > 114) {
      return ctx.reply("Номер суры должен быть от 1 до 114");
    }

    userData.track = surahNum;
    await ctx.reply(`Выбрана сура ${surahNum}. Теперь отправьте номер аята.`);
  } catch (error) {
    logger.error("Error in surah command:", error);
    ctx.reply("Ошибка при выборе суры.");
  }
});

// ================================================================
// АДМИН-КОМАНДЫ (публикация и модерация)
// ================================================================

bot.command("colors", accessForAdminsOnly, (ctx) => {
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

bot.command("clear_all", accessForAdminsOnly, (ctx) => {
  try {
    const userData = getUserData(ctx.from.id);
    Object.assign(userData, sessionManager._blank(), {
      lastActivity: Date.now(),
    });
    clearTempFolder();
    ctx.reply("Данные сброшены.");
  } catch (error) {
    logger.error("Error in clear_all command:", error);
    ctx.reply("Ошибка при сбросе данных.");
  }
});

bot.command("list_audio", accessForAdminsOnly, (ctx) => {
  try {
    const data = getAudioData();
    if (!data.length) return ctx.reply("Список аудиофайлов пуст.");

    let msg = "📝 <b>Последние аудиофайлы:</b>\n\n";
    data.slice(-10).forEach((item, idx) => {
      const surahInfo = surahs[Number(item.surah) - 1] || {};
      msg += `<b>${idx + 1}.</b> <b>Сура:</b> ${item.surah} — ${surahInfo.name_ru || ""} (${surahInfo.name_ar || ""})\n`;
      msg += `<b>Аяты:</b> ${item.ayahs.join(", ")}\n`;
      msg += `<b>Цвет:</b> ${item.color}\n`;
      msg += `<b>Дата:</b> ${new Date(item.timestamp).toLocaleString("ru-RU")}\n`;
      msg += "──────────────\n";
    });
    ctx.reply(msg, { parse_mode: "HTML" });
  } catch (error) {
    logger.error("Error in list_audio command:", error);
    ctx.reply("Ошибка при получении списка аудио.");
  }
});

bot.command("delete_audio", accessForAdminsOnly, async (ctx) => {
  try {
    const args = ctx.message.text.split(" ").slice(1);
    const idx = parseInt(args[0], 10) - 1;

    await withAudioDataLock(() => {
      const data = getAudioData();
      const last10 = data.slice(-10);

      if (isNaN(idx) || idx < 0 || idx >= last10.length) {
        ctx.reply("Некорректный номер записи.");
        return;
      }

      const realIdx = data.length - last10.length + idx;
      data.splice(realIdx, 1);

      if (setAudioData(data)) {
        ctx.reply(`Запись №${idx + 1} из последних 10 удалена.`);
      } else {
        ctx.reply("Ошибка при удалении записи.");
      }
    });
  } catch (error) {
    logger.error("Error in delete_audio command:", error);
    ctx.reply("Ошибка при удалении аудио.");
  }
});

// ================================================================
// ТЕКСТОВЫЙ ВВОД (номер/диапазон аята)
// ================================================================
bot.on("text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) return;

  try {
    if (FEATURE_FLAGS.usersDatabase) {
      await ensureUserExists(
        ctx.from.id,
        ctx.from.first_name,
        ctx.from.username,
      );
    }

    await addToQueue(ctx.from.id, async () => {
      const userData = getUserData(ctx.from.id);
      userData.tafsirParts = [];
      userData.currentTafsirPage = 0;

      const newText = ctx.message.text.trim();

      if (newText === "📖 Выбрать суру") {
        userData.button = true;
        await surahListMessage(ctx);
        return;
      }

      if (userData.button) {
        const surahNumber = parseInt(newText);
        if (!isNaN(surahNumber) && surahNumber >= 1 && surahNumber <= 114) {
          userData.track = surahNumber;
          userData.button = null;
          return ctx.reply(
            `Выбрана сура ${surahNumber}. Отправьте номер аята.`,
          );
        }
        return ctx.reply("Номер суры должен быть от 1 до 114");
      }

      userData.text = newText;

      if (!userData.track || !userData.text) {
        return ctx.reply(
          "Укажите номер суры (/surah) и номер аята (отправьте текст).",
        );
      }

      const surahInfo = surahs.find(
        (s) => s.number === parseInt(userData.track),
      );
      if (!surahInfo) return ctx.reply(`Сура ${userData.track} не найдена`);

      const ayahs = parsePageRanges(userData.text);
      if (!ayahs || ayahs.length === 0) {
        return ctx.reply("Некорректно указан номер аята.");
      }

      // Диапазон/несколько аятов — только для администратора.
      if (ayahs.length > 1 && !isAdmin(ctx.from.id)) {
        return ctx.reply(
          "Указывать диапазон или несколько аятов может только администратор. Отправьте один номер аята.",
        );
      }

      const invalidAyahs = ayahs.filter(
        (ayah) => ayah <= 0 || ayah > surahInfo.ayahs,
      );
      if (invalidAyahs.length > 0) {
        const surahName = surahInfo.name_ru || surahInfo.name_en;
        return ctx.reply(
          `Сура ${surahInfo.number} (${surahName}) содержит ${surahInfo.ayahs} аятов.\n` +
            `Некорректные номер(а) аята(ов): ${invalidAyahs.join(", ")}`,
        );
      }

      if (ayahs.length > CONFIG.userLimits.maxAyahsPerRequest) {
        return ctx.reply(
          `Максимальное количество аятов за один запрос: ${CONFIG.userLimits.maxAyahsPerRequest}`,
        );
      }

      const result = await createAudioWithLimits(ctx, userData, ayahs);
      if (!result.success) return ctx.reply(result.error);
    });
  } catch (err) {
    if (err.message?.includes("Ваш предыдущий запрос")) {
      return ctx.reply(err.message);
    }
    logger.error(`Text handler error: ${err.message}`);
    ctx.reply(MESSAGE_TEMPLATES.error("processing"));
    clearTempFolder();
  }
});

// ================================================================
// CALLBACK: ПУБЛИКАЦИЯ (только админ)
// ================================================================

bot.action(/^show_share_link:(\d+):(\d+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery("Создаю ссылку...");
    await ctx.editMessageReplyMarkup();

    const surah = parseInt(ctx.match[1]);
    const ayah = parseInt(ctx.match[2]);

    await ctx.reply(shareLink(ctx, surah, ayah), {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "⬅️ Назад",
              callback_data: `prev_translation_ayah:${surah}:${ayah}`,
            },
          ],
        ],
      },
    });
  } catch (error) {
    logger.error("Error in show_share_link:", error);
    await ctx.answerCbQuery("Ошибка при создании ссылки", { show_alert: true });
  }
});

bot.action("send_ayah", accessForAdminsOnly, async (ctx) => {
  try {
    await ctx.editMessageReplyMarkup();
    const userData = getUserData(ctx.from.id);
    if (!userData.audioPath) return ctx.reply("Аудиофайл не найден.");

    const link = shareLink(ctx, userData.track, userData.text, true);

    await bot.telegram.sendAudio(GROUP_ID || ctx.chat.id, userData.audioPath, {
      caption: `${userData.message}\n\n🔴 Не забудь посмотреть перевод 📕 и тафсир 📘 😊`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "📕 Перевод/ 📘 Тафсир", url: link }]],
      },
    });

    Object.assign(userData, {
      text: "",
      color: "",
      audioPath: "",
      audioMode: "single",
      message: "",
    });
  } catch (err) {
    logger.error(`Send audio error: ${err.message}`);
    ctx.reply("Ошибка при отправке аудио.");
  }
});

// Универсальный обработчик выбора "цвета". Используется и обычными
// пользователями (кнопка "🔈 Прослушать аят" — colorEmoji === '🔈'),
// и админом при публикации (🔵🟢🔴🟡🟣🟠🟥).
bot.action(/^color_([🟢🔵🟡🔴🟣🟠🟥🔈]+)(?::(\d+):(\d+))?$/, async (ctx) => {
  try {
    await ctx.answerCbQuery("Загружаю аят...");
    await ctx.editMessageReplyMarkup();
    const colorEmoji = ctx.match[1];

    const hasAyahInfo = ctx.match[2] && ctx.match[3];
    const userData = getUserData(ctx.from.id);
    let surah, ayah;

    if (hasAyahInfo) {
      surah = parseInt(ctx.match[2]);
      ayah = parseInt(ctx.match[3]);
    } else {
      surah = parseInt(userData.track);
      ayah = parseInt(userData.text);
    }

    if (!surah || !ayah || isNaN(surah) || isNaN(ayah)) {
      return ctx.reply("Не удалось определить суру и аят. Начните заново.");
    }

    userData.color = colorEmoji;

    // Если в сессии уже лежит склеенное multi-ayah аудио — не подменяем его
    // одиночным file_id. Иначе (обычный кейс одного аята) можно смело
    // (пере)получить готовый file_id из БД.
    let audioFileId;
    if (userData.audioMode === "multi" && userData.audioPath) {
      audioFileId = userData.audioPath;
    } else {
      audioFileId = await getValue(toGlobalAyah(surah, ayah));
      userData.audioPath = audioFileId;
      userData.audioMode = "single";
    }

    const surahInfo = surahs[surah - 1] || {};
    userData.message = `${colorEmoji} Сура ${userData.track} «${surahInfo.name_en} (${surahInfo.name_ru}), аят ${userData.text}» - Махмуд Аль-Хусари\n\n#коран ${toHashtag(surahInfo.name_en)}`;

    const isOneAyah = true;
    const hasTafsirInfo = await hasTafsir(surah, ayah);

    const adminKeyboard = [
      ...(colorEmoji !== "🔈"
        ? [
            [
              Markup.button.callback("✅ Отправить", "send_audio"),
              Markup.button.callback("❌ Отмена", "cancel_audio"),
            ],
          ]
        : []),
      ...(isOneAyah
        ? [
            [
              {
                text: "⬅️ Пред.аят",
                callback_data: `prev_translation_ayah:${surah}:${ayah - 1}`,
              },
              {
                text: "След.аят ➡️",
                callback_data: `next_translation_ayah:${surah}:${ayah + 1}`,
              },
            ],
            [
              Markup.button.callback(
                "📕 Показать перевод",
                `show_translate:true:${surah}:${ayah}`,
              ),
            ],
            ...(hasTafsirInfo
              ? [
                  [
                    Markup.button.callback(
                      "📘 Показать тафсир",
                      `show_tafsir:true:${surah}:${ayah}`,
                    ),
                  ],
                ]
              : []),
            [
              Markup.button.callback(
                "Отправить аят в группу на заучивание",
                "send_ayah",
              ),
            ],
          ]
        : []),
    ];

    const userKeyboard = [
      [
        {
          text: "⬅️ Пред.аят",
          callback_data: `prev_translation_ayah:${surah}:${ayah - 1}`,
        },
        {
          text: "След.аят ➡️",
          callback_data: `next_translation_ayah:${surah}:${ayah + 1}`,
        },
      ],
      [
        Markup.button.callback(
          "📕 Показать перевод",
          `show_translate:true:${surah}:${ayah}`,
        ),
      ],
      ...(hasTafsirInfo
        ? [
            [
              Markup.button.callback(
                "📘 Показать тафсир",
                `show_tafsir:true:${surah}:${ayah}`,
              ),
            ],
          ]
        : []),
    ];

    let audioMessage;
    try {
      audioMessage = await ctx.replyWithAudio(
        getAudioInput(userData.audioPath),
        {
          filename: `M. Al-Hosary - ${surahInfo.name_en} - ${ayah}.mp3`,
          caption: userData.message,
          reply_markup: isAdmin(ctx.from.id)
            ? Markup.inlineKeyboard(adminKeyboard).reply_markup
            : Markup.inlineKeyboard(userKeyboard).reply_markup,
        },
      );
    } catch (audioError) {
      logger.error("Error sending audio:", audioError);
      return ctx.reply("Ошибка при отправке аудио. Попробуйте еще раз.");
    }

    // После отправки в Telegram у нас появляется "чистый" file_id —
    // используем его для последующих действий (например, публикации).
    userData.audioPath = audioMessage.audio.file_id;
    userData.audioMode = "single";
  } catch (err) {
    logger.error(`Color action error: ${err.message}`, {
      match: ctx.match,
      userId: ctx.from.id,
    });
    ctx.reply("Ошибка при выборе цвета.");
  }
});

bot.action("send_audio", accessForAdminsOnly, async (ctx) => {
  try {
    await ctx.editMessageReplyMarkup();
    const userData = getUserData(ctx.from.id);
    if (!userData.audioPath) return ctx.reply("Аудиофайл не найден.");

    const sentAudio = await bot.telegram.sendAudio(
      CHANNEL_ID || ctx.chat.id,
      userData.audioPath,
      {
        caption: userData.message,
      },
    );

    await withAudioDataLock(() => {
      const allData = getAudioData();
      allData.push({
        color: userData.color,
        surah: userData.track,
        ayahs: parsePageRanges(userData.text.toString()),
        file_id: sentAudio.audio.file_id,
        timestamp: new Date().toISOString(),
        user_id: ctx.from.id,
        username: ctx.from.username || "unknown",
      });
      setAudioData(allData);
    });

    ctx.reply("Аудиофайл отправлен и сохранён.");
    clearTempFolder();

    Object.assign(userData, {
      text: "",
      color: "",
      audioPath: "",
      audioMode: "single",
      message: "",
    });
  } catch (err) {
    logger.error(`Send audio error: ${err.message}`);
    ctx.reply("Ошибка при отправке аудио.");
  }
});

bot.action("cancel_audio", accessForAdminsOnly, async (ctx) => {
  try {
    await ctx.editMessageReplyMarkup();
    const userData = getUserData(ctx.from.id);
    ctx.reply("Отправка отменена.");
    clearTempFolder();
    Object.assign(userData, {
      audioPath: "",
      audioMode: "single",
      color: "",
      text: "",
    });
  } catch (error) {
    logger.error("Error in cancel_audio action:", error);
    ctx.reply("Ошибка при отмене отправки.");
  }
});

// ================================================================
// CALLBACK: ПРОСМОТР (доступно всем)
// ================================================================

bot.action(/show_translate:(true|false):(\d+):(\d+)/, async (ctx) => {
  try {
    const flag = ctx.match[1] === "true";
    const surah = parseInt(ctx.match[2]);
    const ayah = parseInt(ctx.match[3]);

    const userData = getUserData(ctx.from.id);
    userData.track = surah;
    userData.text = ayah.toString();

    await showTranslation(ctx, surah, ayah, flag);
  } catch (error) {
    logger.error("Error in show_translate action:", error);
    ctx.reply("Ошибка при показе перевода.");
  }
});

bot.action(/show_translation_continue:(\d+):(\d+)/, async (ctx) => {
  try {
    const surah = parseInt(ctx.match[1]);
    const ayah = parseInt(ctx.match[2]);
    const userData = getUserData(ctx.from.id);
    const translate = userData.translate || "abu_adel";

    await ctx.answerCbQuery("Загружаю продолжение...");
    await ctx.editMessageReplyMarkup();

    const translationText =
      translate === "kuliev"
        ? await getKulievTranslation(surah, ayah)
        : await getAbuAdelTranslation(surah, ayah);
    const surahInfo = surahs[surah - 1] || {};

    const fullMessage = `
📖 <b>Сура ${surah}</b> «${surahInfo.name_ru}» — аят <b>${ayah}</b>/${surahInfo.ayahs} <i>(полный текст)</i>

${translationText}

<i>Перевод: ${translate === "abu_adel" ? "Абу Адель" : "Кулиев"}</i>
    `;

    await ctx.reply(fullMessage, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "⬅️ Пред.аят",
              callback_data: `prev_translation_ayah:${surah}:${ayah - 1}`,
            },
            {
              text: "След.аят ➡️",
              callback_data: `next_translation_ayah:${surah}:${ayah + 1}`,
            },
          ],
          [
            {
              text: `🔄 Перевод ${translate === "abu_adel" ? "Кулиева" : "Абу Аделя"}`,
              callback_data: `change_translate:${surah}:${ayah}`,
            },
          ],
          [
            {
              text: "🔈 Прослушать аят",
              callback_data: `color_🔈:${surah}:${ayah}`,
            },
          ],
          [
            {
              text: "📘 Перейти к тафсиру",
              callback_data: `show_tafsir:true:${surah}:${ayah}`,
            },
          ],
          [
            {
              text: "📤 Поделиться аятом",
              callback_data: `show_share_link:${surah}:${ayah}`,
            },
          ],
        ],
      },
    });
  } catch (error) {
    logger.error("Error in show_translation_continue action:", error);
    ctx.answerCbQuery("❌ Ошибка загрузки продолжения.");
  }
});

bot.action(/next_ayah:(\d+):(\d+):(true|false)/, async (ctx) => {
  try {
    const surah = parseInt(ctx.match[1]);
    const nextAyah = parseInt(ctx.match[2]);
    const flag = ctx.match[3] === "true";

    const userData = getUserData(ctx.from.id);
    userData.track = surah;
    userData.text = nextAyah;

    await showTranslation(ctx, surah, nextAyah, flag);
  } catch (error) {
    logger.error("Error in next_ayah action:", error);
    ctx.reply("Ошибка при переходе к следующему аяту.");
  }
});

bot.action(/prev_ayah:(\d+):(\d+):(true|false)/, async (ctx) => {
  try {
    const surah = parseInt(ctx.match[1]);
    const prevAyah = parseInt(ctx.match[2]);
    const flag = ctx.match[3] === "true";

    if (prevAyah < 1) return ctx.answerCbQuery("❌ Это первый аят суры");

    const userData = getUserData(ctx.from.id);
    userData.track = surah;
    userData.text = prevAyah;

    await showTranslation(ctx, surah, prevAyah, flag);
  } catch (error) {
    logger.error("Error in prev_ayah action:", error);
    ctx.reply("Ошибка при переходе к предыдущему аяту.");
  }
});

bot.action(/next_translation_ayah:(\d+):(\d+)/, async (ctx) => {
  try {
    const surah = parseInt(ctx.match[1]);
    const nextAyah = parseInt(ctx.match[2]);
    const surahInfo = surahs[surah - 1];

    if (!surahInfo || nextAyah > surahInfo.ayahs) {
      return ctx.answerCbQuery("❌ Это последний аят суры");
    }

    const userData = getUserData(ctx.from.id);
    userData.track = surah;
    userData.text = nextAyah.toString();

    await showTranslation(ctx, surah, nextAyah, false);
  } catch (error) {
    logger.error("Error in next_translation_ayah action:", error);
    ctx.answerCbQuery("❌ Ошибка перехода к следующему аяту.");
  }
});

bot.action(/prev_translation_ayah:(\d+):(\d+)/, async (ctx) => {
  try {
    const surah = parseInt(ctx.match[1]);
    const prevAyah = parseInt(ctx.match[2]);

    if (prevAyah < 1) return ctx.answerCbQuery("❌ Это первый аят суры");

    const userData = getUserData(ctx.from.id);
    userData.track = surah;
    userData.text = prevAyah.toString();

    await showTranslation(ctx, surah, prevAyah, false);
  } catch (error) {
    logger.error("Error in prev_translation_ayah action:", error);
    ctx.answerCbQuery("❌ Ошибка перехода к предыдущему аяту.");
  }
});

bot.action(/show_tafsir:(true|false):(\d+):(\d+)/, async (ctx) => {
  try {
    const flag = ctx.match[1] === "true";
    const surah = parseInt(ctx.match[2]);
    const ayah = parseInt(ctx.match[3]);

    const userData = getUserData(ctx.from.id);
    userData.track = surah;
    userData.text = ayah.toString();

    await showTafsir(ctx, surah, ayah, 0, flag);
  } catch (error) {
    logger.error("Error in show_tafsir action:", error);
    ctx.reply("Ошибка при показе тафсира.");
  }
});

bot.action(/tafsir_next:(true|false):(\d+):(\d+):(\d+)/, async (ctx) => {
  try {
    const flag = ctx.match[1] === "true";
    const surah = parseInt(ctx.match[2]);
    const ayah = parseInt(ctx.match[3]);
    const userData = getUserData(ctx.from.id);

    if (!userData.tafsirParts || userData.tafsirParts.length === 0) {
      const currentPage = parseInt(ctx.match[4]);
      await showTafsir(ctx, surah, ayah, currentPage + 1, true);
      return;
    }

    await ctx.editMessageReplyMarkup();
    await ctx.answerCbQuery("Загружаю продолжение тафсира...");

    if (userData.currentTafsirPage >= userData.tafsirParts.length - 1) {
      return ctx.answerCbQuery("✅ Вы прочитали весь тафсир!");
    }

    userData.currentTafsirPage++;

    const hasMore =
      userData.currentTafsirPage < userData.tafsirParts.length - 1;
    const surahInfo = surahs[surah - 1] || {};
    const currentPartText = userData.tafsirParts[userData.currentTafsirPage];

    const keyboard = hasMore
      ? {
          inline_keyboard: [
            [
              {
                text: "📖 Продолжение тафсира",
                callback_data: `tafsir_next:${flag}:${surah}:${ayah}:${userData.currentTafsirPage}`,
              },
            ],
          ],
        }
      : getNavigationKeyboard(surah, ayah, flag, userData);

    const message = `
📘 <b>Тафсир ас-Са'ди</b> — сура ${surah} «${surahInfo.name_ru || ""}», аят ${ayah} <i>(${userData.currentTafsirPage + 1}/${userData.tafsirParts.length})</i>

${currentPartText}${hasMore ? "..." : ""}
`;

    await ctx.reply(message, { parse_mode: "HTML", reply_markup: keyboard });
  } catch (err) {
    logger.error("Error in tafsir_next action:", err);
    await ctx.answerCbQuery("❌ Ошибка при загрузке тафсира.");
  }
});

bot.action(/change_translate:(\d+):(\d+)/, async (ctx) => {
  try {
    const surah = parseInt(ctx.match[1]);
    const ayah = parseInt(ctx.match[2]);
    const userData = getUserData(ctx.from.id);

    userData.translate =
      (userData.translate || "abu_adel") === "abu_adel" ? "kuliev" : "abu_adel";

    await showTranslation(ctx, surah, ayah, false);
  } catch (error) {
    logger.error("Error in change_translate action:", error);
    ctx.reply("Ошибка при смене перевода.");
  }
});

// ================================================================
// ФОНОВЫЕ ЗАДАЧИ
// ================================================================
setInterval(
  () => {
    const cleaned = sessionManager.cleanupOldSessions(CONFIG.sessionTimeout);
    logger.info(
      `Session cleanup: ${sessionManager.getSessionCount()} active sessions (${cleaned} removed)`,
    );
  },
  30 * 60 * 1000,
);

setInterval(() => {
  if (global.gc) global.gc();
}, CONFIG.memoryCleanupInterval);

setInterval(
  () => {
    try {
      const backupFile = `backup_${Date.now()}.json`;
      const backupPath = path.join(BACKUP_FOLDER, backupFile);

      if (fs.existsSync(DATA_FILE)) {
        fs.copyFileSync(DATA_FILE, backupPath);
        logger.info(`Backup created: ${backupFile}`);
      }

      fs.readdirSync(BACKUP_FOLDER)
        .filter((f) => f.startsWith("backup_") && f.endsWith(".json"))
        .sort()
        .reverse()
        .slice(10)
        .forEach((f) => {
          try {
            fs.unlinkSync(path.join(BACKUP_FOLDER, f));
            logger.info(`Old backup deleted: ${f}`);
          } catch (err) {
            logger.error(`Error deleting backup ${f}: ${err.message}`);
          }
        });
    } catch (err) {
      logger.error(`Backup error: ${err.message}`);
    }
  },
  24 * 60 * 60 * 1000,
);

// ================================================================
// АЛЕРТЫ / ИНИЦИАЛИЗАЦИЯ / ЗАВЕРШЕНИЕ ПРОЦЕССА
// ================================================================
async function sendAlert(message, level = "ERROR") {
  try {
    if (!ALERT_CHAT_ID) return;
    const alertMsg = `🚨 <b>${level}</b>\n${message}\n_<i>${new Date().toISOString()}</i>_`;
    await bot.telegram.sendMessage(ALERT_CHAT_ID, alertMsg, {
      parse_mode: "HTML",
    });
  } catch (error) {
    logger.error("Alert sending failed:", error);
  }
}

async function initializeDatabases() {
  try {
    logger.info("Initializing databases...");

    if (FEATURE_FLAGS.usersDatabase) {
      await usersDB.initDatabase();
      logger.info("✅ Users database initialized");
    }
    if (FEATURE_FLAGS.redisLimits) {
      await redisLimiter.init();
      logger.info("✅ Redis limiter initialized");
    }

    logger.info("All databases initialized successfully");
  } catch (error) {
    logger.error("Failed to initialize databases:", error);
    await sendAlert(
      `Ошибка инициализации баз данных: ${error.message}`,
      "CRITICAL",
    );
  }
}

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled Rejection:", reason);
  sendAlert(`Unhandled Rejection: ${reason}`, "CRITICAL");
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught Exception:", error);
  sendAlert(`Uncaught Exception: ${error.message}`, "CRITICAL").finally(() =>
    process.exit(1),
  );
});

async function gracefulShutdown(signal) {
  try {
    logger.info(`Received ${signal}, shutting down gracefully`);
    if (FEATURE_FLAGS.usersDatabase) {
      await usersDB.closeDatabase();
      logger.info("Users database closed");
    }
    if (FEATURE_FLAGS.redisLimits) {
      await redisLimiter.close();
      logger.info("Redis limiter closed");
    }
    bot.stop(signal);
    logger.info("Bot stopped");
  } catch (error) {
    logger.error(`Error during ${signal} handling:`, error);
  }
}

process.once("SIGINT", () => gracefulShutdown("SIGINT"));
process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));

// ================================================================
// ЗАПУСК
// ================================================================
async function startBot() {
  try {
    await initializeDatabases();

    if (WEBHOOK_DOMAIN) {
      // Webhook-режим: Telegraf сам поднимает HTTP-сервер на WEBHOOK_PORT
      // и регистрирует адрес в Telegram через setWebhook.
      await bot.launch({
        webhook: {
          domain: WEBHOOK_DOMAIN,
          path: WEBHOOK_PATH,
          port: WEBHOOK_PORT,
          secretToken: WEBHOOK_SECRET_TOKEN,
        },
      });
      logger.info(
        `✅ Бот успешно запущен в режиме webhook: ${WEBHOOK_DOMAIN}${WEBHOOK_PATH} (порт ${WEBHOOK_PORT})`,
      );
    } else {
      // Обычный long polling — используется, если WEBHOOK_DOMAIN не задан.
      await bot.launch();
      logger.info("✅ Бот успешно запущен в режиме long polling!");
    }

    logger.info("System initialized", {
      featureFlags: FEATURE_FLAGS,
      config: CONFIG.userLimits,
    });

    if (ALERT_CHAT_ID) {
      await bot.telegram
        .sendMessage(
          ALERT_CHAT_ID,
          "✅ Бот успешно запущен!\n" +
            `Режим сети: ${WEBHOOK_DOMAIN ? "webhook" : "polling"}\n` +
            `Режимы: ${FEATURE_FLAGS.usersDatabase ? "UsersDB " : ""}${FEATURE_FLAGS.redisLimits ? "RedisLimits" : ""}`,
          { parse_mode: "HTML" },
        )
        .catch((error) => logger.error("Failed to send startup alert:", error));
    }
  } catch (error) {
    logger.error(`❌ Bot launch error: ${error.message}`);
    await sendAlert(`Ошибка запуска бота: ${error.message}`, "CRITICAL");
    process.exit(1);
  }
}

startBot();
