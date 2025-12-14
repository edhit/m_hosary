require("dotenv").config();

// ================ ИМПОРТ МОДУЛЕЙ ================
const { Telegraf, Markup } = require("telegraf");
const path = require("path");
const fs = require("fs");
const NodeID3 = require("node-id3");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const winston = require("winston");
const Redis = require("ioredis");

// Импорт данных и модулей
const surahs = require("./quran.json");
const { mp3create, toGlobalAyah } = require("./mp3create");
const { getTafsir } = require("./db-tafsir");
const { getAbuAdelTranslation } = require("./db-translations");
const { getAyahPhoto } = require("./db-ayah-photos");
const { getValue } = require("./db-keys");

// Импорт новых модулей для пользователей и лимитов
const usersDB = require("./db-users");
const redisLimiter = require("./redis-limits");

// ================ КОНСТАНТЫ И КОНФИГУРАЦИЯ ================
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL;
const TEMP_FOLDER = process.env.TEMP_FOLDER || path.resolve("./temp");
const DATA_FILE = path.resolve("./audio_data.json");
const BACKUP_FOLDER = path.resolve("./backups");
const ADMIN_USER_ID = process.env.ALLOWED_USER_ID;
const ALERT_CHAT_ID = process.env.ALERT_CHAT_ID;
const REDIS_URL = process.env.REDIS_URL;

const CONFIG = {
  tempFolder: TEMP_FOLDER,
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 50 * 1024 * 1024,
  maxAyahs: parseInt(process.env.MAX_AYAHS) || 20,
  sessionTimeout: parseInt(process.env.SESSION_TIMEOUT) || 60 * 60 * 1000,
  cacheTtl: parseInt(process.env.CACHE_TTL) || 30 * 60 * 1000,
  userLimits: {
    requestsPerMinute: parseInt(process.env.REQUESTS_PER_MINUTE) || 10,
    requestsPerHour: parseInt(process.env.REQUESTS_PER_HOUR) || 50,
    maxAyahsPerRequest: parseInt(process.env.MAX_AYAHS_PER_REQUEST) || 50,
    audioPerHour: parseInt(process.env.AUDIO_PER_HOUR) || 5,
    audioPerDay: parseInt(process.env.AUDIO_PER_DAY) || 20,
  },
  batchSize: parseInt(process.env.BATCH_SIZE) || 5,
  maxConcurrentProcesses: parseInt(process.env.MAX_CONCURRENT_PROCESSES) || 3,
  memoryCleanupInterval:
    parseInt(process.env.MEMORY_CLEANUP_INTERVAL) || 10 * 60 * 1000,
};

const FEATURE_FLAGS = {
  newAudioEngine: process.env.FF_NEW_AUDIO === "true",
  enhancedTafsir: process.env.FF_ENHANCED_TAFSIR === "true",
  voiceMessages: process.env.FF_VOICE_MESSAGES === "true",
  analytics: process.env.FF_ANALYTICS === "true",
  qualityCheck: process.env.FF_QUALITY_CHECK === "true",
  redisCache: process.env.FF_REDIS_CACHE === "true",
  redisLimits: process.env.FF_REDIS_LIMITS === "true",
  usersDatabase: process.env.FF_USERS_DB === "true",
};

// ================ СИСТЕМА ЛОГИРОВАНИЯ ================
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
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
    new winston.transports.File({
      filename: "logs/analytics.log",
      maxsize: 10485760,
      maxFiles: 3,
    }),
    new winston.transports.File({
      filename: "logs/users.log",
      maxsize: 10485760,
      maxFiles: 3,
    }),
  ],
});

// ================ ШАБЛОНЫ СООБЩЕНИЙ ================
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

// ================ ИНИЦИАЛИЗАЦИЯ СИСТЕМ ================

// Инициализация бота
const bot = new Telegraf(BOT_TOKEN);

// Настройка ffmpeg
try {
  ffmpeg.setFfmpegPath(ffmpegPath);
} catch (error) {
  console.error("Error setting ffmpeg path:", error);
}

// Создание папок
["logs", CONFIG.tempFolder, BACKUP_FOLDER].forEach((folder) => {
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
});

// ================ СИСТЕМА КЭШИРОВАНИЯ ================
const cache = new Map();
let redisClient;

class RedisCache {
  constructor() {
    this.prefix = "quran_bot:";
    if (REDIS_URL && FEATURE_FLAGS.redisCache) {
      try {
        redisClient = new Redis(REDIS_URL);
        logger.info("Redis cache client initialized");
      } catch (error) {
        logger.error("Redis cache initialization failed:", error);
      }
    }
  }

  async get(key) {
    if (!redisClient || !FEATURE_FLAGS.redisCache) return null;
    try {
      const data = await redisClient.get(this.prefix + key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      logger.error("Redis get error:", error);
      return null;
    }
  }

  async set(key, value, ttl = CONFIG.cacheTtl) {
    if (!redisClient || !FEATURE_FLAGS.redisCache) return;
    try {
      await redisClient.setex(
        this.prefix + key,
        Math.floor(ttl / 1000),
        JSON.stringify(value)
      );
    } catch (error) {
      logger.error("Redis set error:", error);
    }
  }
}

const redisCache = new RedisCache();

// ================ СТАТИСТИКА И МОНИТОРИНГ ================
const botStats = {
  totalRequests: 0,
  successfulAudio: 0,
  failedAudio: 0,
  users: new Set(),
  cacheHits: 0,
  cacheMisses: 0,
};

const popularRequests = {
  surahs: new Map(),
  ayahRanges: new Map(),

  update: function (surah, ayahs) {
    try {
      const surahCount = this.surahs.get(surah) || 0;
      this.surahs.set(surah, surahCount + 1);

      const range = ayahs.length > 1 ? "multiple" : "single";
      const rangeCount = this.ayahRanges.get(range) || 0;
      this.ayahRanges.set(range, rangeCount + 1);
    } catch (error) {
      logger.error("Error updating popular requests:", error);
    }
  },

  getStats: function () {
    try {
      return {
        topSurahs: [...this.surahs.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5),
        rangeStats: Object.fromEntries(this.ayahRanges),
      };
    } catch (error) {
      logger.error("Error getting popular stats:", error);
      return { topSurahs: [], rangeStats: {} };
    }
  },
};

// Класс для управления сессиями в памяти
class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.processingQueue = new Map();
  }

  getSession(userId) {
    try {
      if (!this.sessions.has(userId)) {
        this.sessions.set(userId, {
          track: "",
          text: "",
          artist: "Mahmoud Al-Hosary",
          color: "",
          audioPath: "",
          message: "",
          tafsirParts: [],
          currentTafsirPage: 0,
          button: null,
          lastActivity: Date.now(),
        });
      } else {
        this.sessions.get(userId).lastActivity = Date.now();
      }
      return this.sessions.get(userId);
    } catch (error) {
      logger.error("Error in getSession:", error);
      return {
        track: "",
        text: "",
        artist: "Mahmoud Al-Hosary",
        color: "",
        audioPath: "",
        message: "",
        tafsirParts: [],
        currentTafsirPage: 0,
        button: null,
        lastActivity: Date.now(),
      };
    }
  }

  deleteSession(userId) {
    this.sessions.delete(userId);
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
    if (cleaned > 0) {
      logger.info(`Cleaned ${cleaned} old sessions`);
    }
    return cleaned;
  }

  getSessionCount() {
    return this.sessions.size;
  }

  // Управление очередью обработки
  addToProcessingQueue(userId) {
    if (this.processingQueue.has(userId)) {
      throw new Error(
        "⏳ Ваш предыдущий запрос еще обрабатывается. Подождите..."
      );
    }
    this.processingQueue.set(userId, { startTime: Date.now() });
  }

  removeFromProcessingQueue(userId) {
    this.processingQueue.delete(userId);
  }

  isInProcessingQueue(userId) {
    return this.processingQueue.has(userId);
  }

  getProcessingQueueCount() {
    return this.processingQueue.size;
  }
}

// Создаем экземпляр менеджера сессий
const sessionManager = new SessionManager();

// Обновленная функция getUserData для использования SessionManager
function getUserData(userId) {
  return sessionManager.getSession(userId);
}

// ================ УТИЛИТЫ ================
function isAdmin(userId) {
  try {
    if (!ADMIN_USER_ID) return false;
    const adminIds = ADMIN_USER_ID.split(",").map((id) => id.trim());
    return adminIds.includes(userId.toString());
  } catch (error) {
    logger.error("Error in isAdmin:", error);
    return false;
  }
}

function getCacheKey(type, surah, ayah) {
  try {
    return `${type}_${surah}_${ayah}`;
  } catch (error) {
    logger.error("Error in getCacheKey:", error);
    return `error_${Date.now()}`;
  }
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

function formatNumberedText(text) {
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
    logger.error("Error in formatNumberedText:", error);
    return text;
  }
}

function getAudioInput(audioPath) {
  // file_id — чистая строка БЕЗ слешей и БЕЗ http
  if (
    typeof audioPath === "string" &&
    !audioPath.includes("/") &&
    !audioPath.startsWith("http")
  ) {
    return audioPath; // это file_id
  }

  // URL
  if (typeof audioPath === "string" && audioPath.startsWith("http")) {
    return { url: audioPath };
  }

  // Локальный путь (есть /)
  if (typeof audioPath === "string" && audioPath.includes("/")) {
    return { source: audioPath };
  }

  // Buffer
  if (Buffer.isBuffer(audioPath)) {
    return { source: audioPath };
  }

  throw new Error("unknown audioPath format");
}

async function ensureUserExists(userId, firstName, username) {
  try {
    if (!FEATURE_FLAGS.usersDatabase) return;

    // Проверяем, есть ли пользователь в БД
    const existingUser = await usersDB.getUser(userId);

    if (!existingUser) {
      // Создаем нового пользователя
      await usersDB.upsertUser(userId, firstName || "User", username);
      logger.info(
        `New user created: ${userId} (@${username || "no-username"})`
      );
      return true;
    } else {
      // Обновляем данные существующего пользователя
      await usersDB.upsertUser(
        userId,
        firstName || existingUser.first_name,
        username
      );
      return false;
    }
  } catch (error) {
    logger.error("Error in ensureUserExists:", error);
    return false;
  }
}

// ================ СИСТЕМА АНАЛИТИКИ ================
const analytics = {
  trackEvent: function (userId, eventType, metadata = {}) {
    try {
      if (!FEATURE_FLAGS.analytics) return;
      const event = {
        userId,
        eventType,
        timestamp: new Date().toISOString(),
        ...metadata,
      };
      const analyticsFile = path.join(__dirname, "logs", "analytics.log");
      fs.appendFileSync(analyticsFile, JSON.stringify(event) + "\n");
    } catch (error) {
      logger.error("Analytics tracking error:", error);
    }
  },

  getConversionRate: function () {
    const total = botStats.successfulAudio + botStats.failedAudio;
    return total > 0
      ? ((botStats.successfulAudio / total) * 100).toFixed(1)
      : 0;
  },

  getCacheEfficiency: function () {
    const total = botStats.cacheHits + botStats.cacheMisses;
    return total > 0 ? ((botStats.cacheHits / total) * 100).toFixed(1) : 0;
  },
};

// ================ СИСТЕМА КЭШИРОВАНИЯ ДАННЫХ ================
async function getCachedTafsir(surah, ayah) {
  try {
    const key = getCacheKey("tafsir", surah, ayah);

    if (FEATURE_FLAGS.redisCache) {
      const cached = await redisCache.get(key);
      if (cached) {
        botStats.cacheHits++;
        return cached;
      }
    }

    const cached = cache.get(key);
    if (cached && Date.now() - cached.timestamp < CONFIG.cacheTtl) {
      botStats.cacheHits++;
      return cached.data;
    }

    botStats.cacheMisses++;
    const data = await getTafsir(surah, ayah);

    cache.set(key, { data, timestamp: Date.now() });
    if (FEATURE_FLAGS.redisCache) {
      await redisCache.set(key, data);
    }

    return data;
  } catch (error) {
    logger.error("Error in getCachedTafsir:", error);
    throw error;
  }
}

async function getCachedTranslation(surah, ayah) {
  try {
    const key = getCacheKey("translation", surah, ayah);

    if (FEATURE_FLAGS.redisCache) {
      const cached = await redisCache.get(key);
      if (cached) {
        botStats.cacheHits++;
        return cached;
      }
    }

    const cached = cache.get(key);
    if (cached && Date.now() - cached.timestamp < CONFIG.cacheTtl) {
      botStats.cacheHits++;
      return cached.data;
    }

    botStats.cacheMisses++;
    const data = await getAbuAdelTranslation(surah, ayah);

    cache.set(key, { data, timestamp: Date.now() });
    if (FEATURE_FLAGS.redisCache) {
      await redisCache.set(key, data);
    }

    return data;
  } catch (error) {
    logger.error("Error in getCachedTranslation:", error);
    throw error;
  }
}

// ================ СИСТЕМА ОЧЕРЕДИ ================
async function addToQueue(userId, task) {
  try {
    sessionManager.addToProcessingQueue(userId);
    try {
      const result = await task();
      return result;
    } finally {
      sessionManager.removeFromProcessingQueue(userId);
    }
  } catch (error) {
    sessionManager.removeFromProcessingQueue(userId);
    throw error;
  }
}

// ================ СИСТЕМА РЕТРАЕВ ================
async function retryWithBackoff(operation, maxRetries = 3, baseDelay = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === maxRetries) throw error;
      const delay = baseDelay * Math.pow(2, attempt - 1);
      const jitter = delay * 0.1 * Math.random();
      logger.warn(
        `Retry attempt ${attempt} after ${Math.round(delay + jitter)}ms`
      );
      await new Promise((resolve) => setTimeout(resolve, delay + jitter));
    }
  }
}

// ================ ПРОГРЕСС-БАР ================
async function showProgress(ctx, messageId, progress) {
  try {
    const bars = "█".repeat(Math.floor(progress / 10));
    const spaces = "░".repeat(10 - Math.floor(progress / 10));
    const text = `Обработка аудио...\n[${bars}${spaces}] ${progress}%`;

    try {
      await ctx.telegram.editMessageText(ctx.chat.id, messageId, null, text);
    } catch (e) {}
  } catch (error) {
    logger.error("Error in showProgress:", error);
  }
}

// ================ ОБРАБОТКА АУДИОФАЙЛОВ ================
function writeID3(tags, path) {
  return new Promise((resolve, reject) => {
    try {
      NodeID3.write(tags, path, (err) => {
        if (err) reject(err);
        else resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

const audioQuality = {
  validateFile: async function (filePath) {
    return new Promise((resolve) => {
      try {
        const stats = fs.statSync(filePath);

        if (stats.size === 0) {
          resolve({ valid: false, reason: "empty_file" });
          return;
        }

        if (stats.size > CONFIG.maxFileSize) {
          resolve({ valid: false, reason: "file_too_large" });
          return;
        }

        ffmpeg.ffprobe(filePath, (err, metadata) => {
          if (err) {
            resolve({ valid: false, reason: "corrupted_file" });
            return;
          }

          const duration = metadata.format.duration;
          if (!duration || duration < 0.1) {
            resolve({ valid: false, reason: "invalid_duration" });
            return;
          }

          resolve({ valid: true, duration, size: stats.size });
        });
      } catch (error) {
        resolve({ valid: false, reason: "file_error" });
      }
    });
  },
};

async function finalizeAudio(ctx, userData) {
  try {
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
                    "📕 Показать перевод",
                    "show_translate:false"
                  ),
                ],
                [
                  Markup.button.callback(
                    "📘 Показать тафсир",
                    "show_tafsir:false"
                  ),
                ],
              ]
            : []),
        ])
      );
    } else {
      await ctx.reply(
        "Аудио готово!",
        Markup.inlineKeyboard([
          [Markup.button.callback("🔈 Прослушать аят", "color_🔈")],
          ...(isOneAyah
            ? [
                [
                  Markup.button.callback(
                    "📕 Показать перевод",
                    "show_translate:false"
                  ),
                ],
                [
                  Markup.button.callback(
                    "📘 Показать тафсир",
                    "show_tafsir:false"
                  ),
                ],
              ]
            : []),
        ])
      );
    }

    botStats.successfulAudio++;
    return true;
  } catch (error) {
    logger.error("finalizeAudio error:", error);
  }
}

async function metaTags(tags, outputAudioPath, ctx, userData) {
  try {
    await writeID3(tags, outputAudioPath);
    userData.audioPath = outputAudioPath;

    if (FEATURE_FLAGS.qualityCheck) {
      const qualityCheck = await audioQuality.validateFile(outputAudioPath);
      if (!qualityCheck.valid) {
        logger.warn("Audio quality check failed", {
          path: outputAudioPath,
          reason: qualityCheck.reason,
        });
      }
    }

    const finalized = await finalizeAudio(ctx, userData);
    return finalized;
  } catch (err) {
    logger.error("metaTags error:", err);
    botStats.failedAudio++;
    return false;
  }
}

// ================ СИСТЕМА ПЕРЕВОДОВ И ТАФСИРА ================
function getNavigationKeyboard(surah, ayah, tafsir = true) {
  try {
    const surahInfo = surahs[surah - 1];
    const buttons = [];

    if (ayah > 1) {
      buttons.push({
        text: "⬅️ Пред.аят",
        callback_data: tafsir ? `prev_ayah:false` : `prev_ayah:true`,
      });
    }

    if (surahInfo && ayah < surahInfo.ayahs) {
      buttons.push({
        text: "След.аят ➡️",
        callback_data: tafsir ? `next_ayah:false` : `next_ayah:true`,
      });
    }

    const keyboard = [];
    if (buttons.length > 0) {
      keyboard.push(buttons);
    }

    keyboard.push([{ text: "🔈 Прослушать аят", callback_data: `color_🔈` }]);

    if (tafsir) {
      keyboard.push([
        { text: "📘 Перейти к тафсиру", callback_data: `show_tafsir_reply` },
      ]);
    }

    return { inline_keyboard: keyboard };
  } catch (error) {
    logger.error("Error in getNavigationKeyboard:", error);
    return { inline_keyboard: [] };
  }
}

async function showTranslation(ctx, surah, ayah, reply = false) {
  try {
    await ctx.answerCbQuery("Загружаю перевод...");
    const userData = getUserData(ctx.from.id);
    const surahInfo = surahs[surah - 1] || {};

    if (reply) {
      await ctx.editMessageReplyMarkup();
    }

    if (!surah || !ayah) {
      if (reply) {
        return ctx.reply("⚠️ Не удалось определить суру и аят.");
      }
      return ctx.editMessageText("⚠️ Не удалось определить суру и аят.");
    }

    // Получаем перевод и фото параллельно
    let [translationResult, photoFileId] = await Promise.allSettled([
      getCachedTranslation(surah, ayah),
      getAyahPhoto(surah, ayah),
    ]);

    // Обрабатываем результаты
    let translationText = "";
    if (translationResult.status === "fulfilled") {
      translationText = translationResult.value;
    } else {
      logger.error("Ошибка getCachedTranslation:", translationResult.reason);
      translationText = "⚠️ Ошибка загрузки перевода.";
    }

    // Сохраняем полный перевод в сессии
    userData.fullTranslation = translationText;

    // Берем первые 512 символов для первого сообщения
    const maxFirstPartLength = 512;
    let firstPart = translationText;
    let hasMore = false;

    if (translationText.length > maxFirstPartLength) {
      // Ищем хорошее место для обрыва (после точки, запятой или пробела)
      let cutIndex = maxFirstPartLength;
      for (
        let i = maxFirstPartLength;
        i > maxFirstPartLength - 100 && i > 0;
        i--
      ) {
        if ([".", ",", ";", "!", "?", " "].includes(translationText[i])) {
          cutIndex = i + 1;
          break;
        }
      }
      firstPart = translationText.substring(0, cutIndex) + "...";
      hasMore = true;
    }

    // Формируем сообщение
    const message = `
📕 *Перевод Абу Аделя*
━━━━━━━━━━━━━━━
🕋 *Сура:* ${surah} ${surahInfo.name_ru}
🔹 *Аят:* ${ayah}

💬 *Перевод:*
_${firstPart}_
`;

    // Создаем клавиатуру
    const keyboard = { inline_keyboard: [] };

    // Кнопка "Показать продолжение перевода" если текст длинный
    if (hasMore) {
      keyboard.inline_keyboard.push([
        {
          text: "📖 Показать полный перевод",
          callback_data: `show_translation_continue:${surah}:${ayah}`,
        },
      ]);
    }

    // Кнопки навигации по аятам
    const ayahNavigation = [];

    if (ayah > 1) {
      ayahNavigation.push({
        text: "⬅️ Пред.аят",
        callback_data: `prev_translation_ayah`,
      });
    }

    if (surahInfo && ayah < surahInfo.ayahs) {
      ayahNavigation.push({
        text: "След.аят ➡️",
        callback_data: `next_translation_ayah`,
      });
    }

    if (ayahNavigation.length > 0) {
      keyboard.inline_keyboard.push(ayahNavigation);
    }

    // Кнопка прослушивания и перехода к тафсиру
    keyboard.inline_keyboard.push([
      { text: "🔈 Прослушать аят", callback_data: `color_🔈` },
    ]);

    keyboard.inline_keyboard.push([
      { text: "📘 Перейти к тафсиру", callback_data: `show_tafsir_reply` },
    ]);

    // Если есть фото, отправляем его
    if (photoFileId.status === "fulfilled" && photoFileId.value) {
      try {
        if (reply) {
          // Отправляем фото с подписью и клавиатурой
          await ctx.replyWithPhoto(photoFileId.value, {
            caption: message,
            parse_mode: "Markdown",
            reply_markup: keyboard,
          });
        } else {
          // Редактируем сообщение, добавляя фото
          await ctx.editMessageMedia(
            {
              type: "photo",
              media: photoFileId.value,
              caption: message,
              parse_mode: "Markdown",
            },
            {
              reply_markup: keyboard,
            }
          );
        }

        // Логируем успешную отправку фото
        logger.info(`Photo sent for surah ${surah}, ayah ${ayah}`);
      } catch (photoError) {
        logger.error("Error sending photo:", photoError);
        // Если ошибка с фото, отправляем только текст
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
      }
    } else {
      // Если фото нет, отправляем только текст
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

      // Логируем отсутствие фото
      if (photoFileId.status === "rejected") {
        logger.warn(
          `Photo not found for surah ${surah}, ayah ${ayah}:`,
          photoFileId.reason
        );
      }
    }
  } catch (err) {
    logger.error("Error in showTranslation:", err);
    await ctx.answerCbQuery("❌ Ошибка загрузки перевода.");

    if (reply) {
      await ctx.reply("Ошибка при загрузке перевода. Попробуйте позже.");
    } else {
      await ctx.editMessageText(
        "Ошибка при загрузке перевода. Попробуйте позже."
      );
    }
  }
}

async function showTafsir(ctx, reply = false) {
  try {
    await ctx.answerCbQuery("Загружаю тафсир...");
    const userData = getUserData(ctx.from.id);

    if (reply) {
      await ctx.editMessageReplyMarkup();
    }

    const surah = parseInt(userData.track);
    const ayah = parseInt(userData.text);
    const surahInfo = surahs[Number(userData.track) - 1] || {};

    userData.tafsirParts = [];
    userData.currentTafsirPage = 0;

    let tafsir = formatNumberedText(await getCachedTafsir(surah, ayah));

    if (!tafsir) {
      tafsir = "⚠️ Для этого аята тафсира нет.";
    }

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
      if (reply) {
        return ctx.reply("⚠️ Ошибка при обработке тафсира.");
      }
      return ctx.editMessageText("⚠️ Ошибка при обработке тафсира.");
    }

    const keyboard =
      userData.tafsirParts.length > 1
        ? {
            inline_keyboard: [
              [{ text: "Показать ещё", callback_data: "tafsir_next" }],
            ],
          }
        : getNavigationKeyboard(surah, ayah, false);

    const message = `
📘 *Тафсир ас-Са'ди*
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
    logger.error(err);
    await ctx.answerCbQuery("❌ Ошибка при загрузке.");
    await ctx.reply("Ошибка при загрузке тафсира. Попробуйте позже.");
  }
}

// ================ СИСТЕМА ОЧИСТКИ ПАМЯТИ ================
const memoryManager = {
  cleanup: function () {
    try {
      if (global.gc) global.gc();

      const now = Date.now();
      let clearedCacheItems = 0;
      for (const [key, value] of cache.entries()) {
        if (now - value.timestamp > CONFIG.cacheTtl) {
          cache.delete(key);
          clearedCacheItems++;
        }
      }

      const clearedSessions = sessionManager.cleanupOldSessions(
        CONFIG.sessionTimeout
      );

      logger.info(
        `Memory cleanup completed. Cache: ${clearedCacheItems} items, Sessions: ${clearedSessions} sessions`
      );
    } catch (error) {
      logger.error("Memory cleanup error:", error);
    }
  },
};

// ================ СИСТЕМА БЭКАПОВ ================
const backupManager = {
  createBackup: () => {
    try {
      const backupFile = `backup_${Date.now()}.json`;
      const backupPath = path.join(BACKUP_FOLDER, backupFile);

      if (fs.existsSync(DATA_FILE)) {
        fs.copyFileSync(DATA_FILE, backupPath);
        logger.info(`Backup created: ${backupFile}`);
      }

      const backups = fs
        .readdirSync(BACKUP_FOLDER)
        .filter((f) => f.startsWith("backup_") && f.endsWith(".json"))
        .sort()
        .reverse();

      backups.slice(10).forEach((f) => {
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
};

// ================ СИСТЕМА УВЕДОМЛЕНИЙ ================
async function sendAlert(message, level = "ERROR") {
  try {
    if (!ALERT_CHAT_ID) return;
    const alertMsg = `🚨 *${level}*\n${message}\n_${new Date().toISOString()}_`;
    await bot.telegram.sendMessage(ALERT_CHAT_ID, alertMsg, {
      parse_mode: "Markdown",
    });
  } catch (error) {
    console.error("Alert sending failed:", error);
  }
}

// ================ MIDDLEWARE ДЛЯ ЛОГИРОВАНИЯ И ЛИМИТОВ ================
bot.use(async (ctx, next) => {
  try {
    const userId = ctx.from?.id;
    const username = ctx.from?.username || "без username";
    const firstName = ctx.from?.first_name || "без имени";

    // Пропускаем лимиты для администраторов
    if (isAdmin(userId)) {
      botStats.totalRequests++;
      if (userId) botStats.users.add(userId);

      logger.info(
        `Пользователь ${userId} (@${username}, ${firstName}) вызвал команду: ${
          ctx.message?.text || "callback"
        }`
      );

      await next();

      if (userId) {
        analytics.trackEvent(userId, "request_completed", {
          command: ctx.message?.text,
          chatType: ctx.chat?.type,
        });
      }
      return;
    }

    // Проверяем лимиты через Redis
    if (FEATURE_FLAGS.redisLimits) {
      const limitCheck = await redisLimiter.checkAndIncrement(userId);

      if (!limitCheck.allowed) {
        logger.warn(
          `Rate limit exceeded for user ${userId}: ${limitCheck.reason}`,
          {
            userId,
            reason: limitCheck.reason,
            username,
            firstName,
          }
        );

        analytics.trackEvent(userId, "rate_limit_exceeded", {
          reason: limitCheck.reason,
          command: ctx.message?.text,
        });

        return ctx.reply(
          limitCheck.message || MESSAGE_TEMPLATES.error("rateLimit")
        );
      }
    }

    botStats.totalRequests++;
    if (userId) botStats.users.add(userId);

    logger.info(
      `Пользователь ${userId} (@${username}, ${firstName}) вызвал команду: ${
        ctx.message?.text || "callback"
      }`
    );

    await next();

    if (userId) {
      analytics.trackEvent(userId, "request_completed", {
        command: ctx.message?.text,
        chatType: ctx.chat?.type,
      });
    }
  } catch (error) {
    logger.error("Error in logging middleware:", error);
    await next();
  }
});

// ================ ОБРАБОТЧИК СОЗДАНИЯ АУДИО С ПРОВЕРКОЙ ЛИМИТОВ ================
async function createAudioWithLimits(ctx, userData, ayahs) {
  try {
    // Проверяем лимит на создание аудио (более строгий)
    if (FEATURE_FLAGS.redisLimits) {
      const audioLimitCheck = await redisLimiter.checkAndIncrement(
        ctx.from.id,
        "audio"
      );

      if (!audioLimitCheck.allowed) {
        analytics.trackEvent(ctx.from.id, "audio_limit_exceeded", {
          reason: audioLimitCheck.reason,
          ayahsCount: ayahs.length,
        });

        return {
          success: false,
          error:
            audioLimitCheck.message || MESSAGE_TEMPLATES.error("audioLimit"),
        };
      }
    }

    // Логируем создание аудио
    logger.info(
      `Creating audio for user ${ctx.from.id}: ${userData.track}:${userData.text}`,
      {
        userId: ctx.from.id,
        surah: userData.track,
        ayahs: ayahs,
        ayahsCount: ayahs.length,
      }
    );

    let success = false;

    if (isAdmin(ctx.from.id) && ayahs.length > 1) {
      const tempMsg = await ctx.reply("Обработка аудио...");

      await showProgress(ctx, tempMsg.message_id, 10);

      const settings = { ayahs, surah: parseInt(userData.track) };

      const outputAudio = await retryWithBackoff(
        () => mp3create(settings),
        3,
        1000
      );
      const outputAudioPath = path.join(outputAudio.folder, outputAudio.file);

      await showProgress(ctx, tempMsg.message_id, 80);

      const surahInfo = surahs.find(
        (s) => s.number === parseInt(userData.track)
      );
      const tags = {
        title: `Surah ${userData.track} ${surahInfo?.name_en || ""} (${
          userData.text
        })`,
        artist: userData.artist,
        year: new Date().getFullYear(),
      };

      let i = 0;
      while (i < 3) {
        success = await metaTags(tags, outputAudioPath, ctx, userData);
        if (success) break;
        i++;
        logger.warn(`Retry ${i} for metaTags for user ${ctx.from.id}`);
      }

      try {
        await ctx.deleteMessage(tempMsg.message_id);
      } catch (e) {
        logger.error("Ошибка удаления сообщения:", e.message);
      }
    } else {
      userData.audioPath = await getValue(
        toGlobalAyah(userData.track, ayahs[0])
      );

      await finalizeAudio(ctx, userData);
      success = true;
    }
    return {
      success,
      error: success ? null : MESSAGE_TEMPLATES.error("processing"),
    };
  } catch (error) {
    logger.error("Error in audio creation:", error);
    return {
      success: false,
      error: MESSAGE_TEMPLATES.error("processing"),
    };
  }
}

// ================ КОМАНДЫ БОТА ================

// Стартовая команда
bot.start(async (ctx) => {
  try {
    const userId = ctx.from.id;
    const name = ctx.from.first_name || "брат";
    const username = ctx.from.username || null;

    // Создаем/обновляем пользователя сразу после команды /start
    if (FEATURE_FLAGS.usersDatabase) {
      try {
        await usersDB.upsertUser(
          userId,
          ctx.from.first_name || "User",
          username
        );
        logger.info(
          `User created/updated in database: ${userId} (@${
            username || "no-username"
          })`
        );
      } catch (error) {
        logger.error("Error saving user to database:", error);
      }
    }

    // Также создаем сессию в памяти
    const userData = sessionManager.getSession(userId);

    await ctx.reply(MESSAGE_TEMPLATES.welcome(name), {
      reply_markup: {
        keyboard: [
          ["📖 Выбрать суру"],
          //, ["📚 Начать заучивать"]
        ],
        resize_keyboard: true,
      },
    });

    // Трекаем событие
    analytics.trackEvent(userId, "start_command");
  } catch (error) {
    logger.error("Error in start command:", error);
  }
});

// Команда помощи
bot.command("help", (ctx) => {
  try {
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
<b>/popular</b> — Статистика популярных запросов.
<b>/users_stats</b> — Статистика пользователей
<b>/users_list</b> — Список пользователей
<b>/limits</b> — Статистика лимитов пользователя
<b>/reset_limits</b> — Сбросить лимиты пользователя
<b>/unban</b> — Разблокировать пользователя
`
    : ""
}

<b>Создание аудио:</b>
1. Укажите суру командой <b>/surah &lt;номер&gt;</b>.
2. Отправьте номера аята (например: 5).

<b>Примечание:</b>
Бот отправляет аят в исполнении Махмуда Аль-Хусари.
  `;
    ctx.reply(helpMsg, { parse_mode: "HTML" });
    analytics.trackEvent(ctx.from.id, "help_command");
  } catch (error) {
    logger.error("Error in help command:", error);
  }
});

{
  /* <b>/cleanup_users</b> — Очистить неактивных пользователей
<b>/reload_config</b> — Перезагрузить конфигурацию.
<b>/feature_flags</b> — Управление фича-флагами
<b>/health</b> — Проверка здоровья системы
<b>/backup</b> — Создать полный бэкап */
}

// Информация о суре
bot.command("surah_info", (ctx) => {
  try {
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
    analytics.trackEvent(ctx.from.id, "surah_info", { surah: surahNum });
  } catch (error) {
    logger.error("Error in surah_info command:", error);
    ctx.reply("Ошибка при получении информации о суре.");
  }
});

// Выбор суры
bot.command("surah", (ctx) => {
  try {
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
    ctx.reply(`Выбрана сура ${surahNum}. Теперь отправьте номер аята.`);
    analytics.trackEvent(ctx.from.id, "surah_selected", { surah: surahNum });
  } catch (error) {
    logger.error("Error in surah command:", error);
    ctx.reply("Ошибка при выборе суры.");
  }
});

// Информация о цветах
bot.command("colors", (ctx) => {
  try {
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
  } catch (error) {
    logger.error("Error in colors command:", error);
    ctx.reply("Ошибка при получении информации о цветах.");
  }
});

// Статистика бота с данными из users-db и redis-limits
bot.command("stats", async (ctx) => {
  try {
    if (!isAdmin(ctx.from.id)) return;

    let userStats = { total_users: 0, with_username: 0, active_last_day: 0 };
    let redisHealth = false;
    let globalStats = { totalKeys: 0, bannedUsers: 0 };

    if (FEATURE_FLAGS.usersDatabase) {
      try {
        userStats = await usersDB.getStatistics();
      } catch (error) {
        logger.error("Error getting user stats:", error);
      }
    }

    if (FEATURE_FLAGS.redisLimits) {
      try {
        redisHealth = await redisLimiter.healthCheck();
        globalStats = (await redisLimiter.getGlobalStats()) || globalStats;
      } catch (error) {
        logger.error("Error getting Redis stats:", error);
      }
    }

    const statsMsg = `
📊 *Статистика бота*
━━━━━━━━━━━━━━━
👥 Всего пользователей: ${userStats.total_users || botStats.users.size}
👤 С username: ${userStats.with_username || "N/A"}
🔥 Активных сегодня: ${userStats.active_last_day || "N/A"}
📈 Активных за неделю: ${userStats.active_last_week || "N/A"}
📨 Всего запросов: ${botStats.totalRequests}
✅ Успешных аудио: ${botStats.successfulAudio}
❌ Ошибок: ${botStats.failedAudio}
💾 Размер temp: ${getFolderSize(CONFIG.tempFolder)} MB
📊 Активных сессий: ${sessionManager.getSessionCount()}
⏳ В очереди: ${sessionManager.getProcessingQueueCount()}
🗂 Кэш: ${cache.size} записей
🎯 Эффективность кэша: ${analytics.getCacheEfficiency()}%
📈 Конверсия: ${analytics.getConversionRate()}%
🕐 Аптайм: ${Math.floor(process.uptime() / 60)} минут
━━━━━━━━━━━━━━━
🔴 *Redis Status:* ${redisHealth ? "✅ OK" : "❌ OFFLINE"}
📊 *Redis Keys:* ${globalStats.totalKeys || "N/A"}
🚫 *Заблокировано:* ${globalStats.bannedUsers || "N/A"}
    `;

    ctx.reply(statsMsg, { parse_mode: "Markdown" });
  } catch (error) {
    logger.error("Error in stats command:", error);
    ctx.reply("Ошибка при получении статистики.");
  }
});

// Популярные запросы
bot.command("popular", (ctx) => {
  try {
    if (!isAdmin(ctx.from.id)) return;

    const stats = popularRequests.getStats();
    let message = "📈 *Популярные запросы:*\n\n";

    message += "*Топ сур:*\n";
    stats.topSurahs.forEach(([surahId, count], index) => {
      const surah = surahs[surahId - 1];
      message += `${index + 1}. ${surahId} - ${
        surah?.name_ru || "Unknown"
      }: ${count} запросов\n`;
    });

    message += `\n*Типы запросов:*\n`;
    message += `Одиночные аяты: ${stats.rangeStats.single || 0}\n`;
    message += `Несколько аятов: ${stats.rangeStats.multiple || 0}`;

    ctx.reply(message, { parse_mode: "Markdown" });
  } catch (error) {
    logger.error("Error in popular command:", error);
    ctx.reply("Ошибка при получении статистики популярных запросов.");
  }
});

// Статистика пользователей
bot.command("users_stats", async (ctx) => {
  try {
    if (!isAdmin(ctx.from.id)) return;

    if (!FEATURE_FLAGS.usersDatabase) {
      return ctx.reply(
        "База данных пользователей отключена. Включите FF_USERS_DB."
      );
    }

    const stats = await usersDB.getStatistics();
    const topUsers = await usersDB.getTopUsers(5);

    let message = "📊 *Статистика пользователей*\n━━━━━━━━━━━━━━━\n";
    message += `👥 Всего пользователей: ${stats.total_users}\n`;
    message += `👤 С username: ${stats.with_username}\n`;
    message += `🔥 Активных сегодня: ${stats.active_last_day}\n`;
    message += `📈 Активных за неделю: ${stats.active_last_week}\n`;
    message += `📨 Среднее запросов: ${Math.round(stats.avg_requests)}\n`;
    message += `🏆 Макс запросов: ${stats.max_requests}\n\n`;

    message += "🏆 *Топ пользователей:*\n";
    topUsers.forEach((user, index) => {
      message += `${index + 1}. ${user.first_name} (@${
        user.username || "нет"
      }): ${user.requests_count} запросов\n`;
    });

    ctx.reply(message, { parse_mode: "Markdown" });
  } catch (error) {
    logger.error("Error in users_stats command:", error);
    ctx.reply("Ошибка при получении статистики пользователей.");
  }
});

// Список пользователей
bot.command("users_list", async (ctx) => {
  try {
    if (!isAdmin(ctx.from.id)) return;

    if (!FEATURE_FLAGS.usersDatabase) {
      return ctx.reply(
        "База данных пользователей отключена. Включите FF_USERS_DB."
      );
    }

    const users = await usersDB.getAllUsers(10);

    let message = "👥 *Последние пользователи*\n━━━━━━━━━━━━━━━\n";

    if (users.length === 0) {
      message += "Пользователей нет";
    } else {
      users.forEach((user, index) => {
        const lastSeen = new Date(user.last_seen).toLocaleString("ru-RU");
        message += `${index + 1}. ${user.first_name} (@${
          user.username || "нет"
        })\n`;
        message += `   📨 Запросов: ${user.requests_count}\n`;
        message += `   ⏰ Последний раз: ${lastSeen}\n`;
        if (index < users.length - 1) message += "━━━━━━━━━━━━━━━\n";
      });
    }

    ctx.reply(message, { parse_mode: "Markdown" });
  } catch (error) {
    logger.error("Error in users_list command:", error);
    ctx.reply("Ошибка при получении списка пользователей.");
  }
});

// Статистика лимитов пользователя
bot.command("limits", async (ctx) => {
  try {
    if (!isAdmin(ctx.from.id)) return;

    if (!FEATURE_FLAGS.redisLimits) {
      return ctx.reply("Redis лимиты отключены. Включите FF_REDIS_LIMITS.");
    }

    const args = ctx.message.text.split(" ").slice(1);
    const userId = args[0] ? parseInt(args[0]) : ctx.from.id;

    const stats = await redisLimiter.getUserStats(userId);
    const userInfo = FEATURE_FLAGS.usersDatabase
      ? await usersDB.getUser(userId)
      : null;

    if (!stats) {
      return ctx.reply("Не удалось получить статистику лимитов");
    }

    let message = "📊 *Статистика лимитов*\n━━━━━━━━━━━━━━━\n";

    if (userInfo) {
      message += `👤 Пользователь: ${userInfo.first_name} (@${
        userInfo.username || "нет"
      })\n`;
      message += `🆔 ID: ${userId}\n\n`;
    }

    message += `🕐 *Запросы за минуту:* ${stats.minute}/${redisLimiter.config.limits.perMinute}\n`;
    message += `⏰ *Запросы за час:* ${stats.hour}/${redisLimiter.config.limits.perHour}\n`;
    message += `📅 *Запросы за день:* ${stats.day}/${redisLimiter.config.limits.perDay}\n\n`;

    if (stats.banned) {
      const expires = new Date(stats.banned.expires).toLocaleString("ru-RU");
      message += `🚫 *ЗАБЛОКИРОВАН*\n`;
      message += `📝 Причина: ${stats.banned.reason}\n`;
      message += `🕐 Истекает: ${expires}\n\n`;
    }

    message += `🔄 Сброс через:\n`;
    message += `- Минута: ${stats.ttl.minute} сек\n`;
    message += `- Час: ${stats.ttl.hour} сек\n`;
    message += `- День: ${stats.ttl.day} сек`;

    ctx.reply(message, { parse_mode: "Markdown" });
  } catch (error) {
    logger.error("Error in limits command:", error);
    ctx.reply("Ошибка при получении статистики лимитов.");
  }
});

// Сброс лимитов пользователя
bot.command("reset_limits", async (ctx) => {
  try {
    if (!isAdmin(ctx.from.id)) return;

    if (!FEATURE_FLAGS.redisLimits) {
      return ctx.reply("Redis лимиты отключены. Включите FF_REDIS_LIMITS.");
    }

    const args = ctx.message.text.split(" ").slice(1);
    const userId = args[0];

    if (!userId) {
      return ctx.reply("Укажите ID пользователя: /reset_limits 123456789");
    }

    const success = await redisLimiter.resetUserLimits(parseInt(userId));

    if (success) {
      ctx.reply(`✅ Лимиты для пользователя ${userId} сброшены`);
    } else {
      ctx.reply("❌ Ошибка при сбросе лимитов");
    }
  } catch (error) {
    logger.error("Error in reset_limits command:", error);
    ctx.reply("Ошибка при сбросе лимитов.");
  }
});

// Разблокировать пользователя
bot.command("unban", async (ctx) => {
  try {
    if (!isAdmin(ctx.from.id)) return;

    if (!FEATURE_FLAGS.redisLimits) {
      return ctx.reply("Redis лимиты отключены. Включите FF_REDIS_LIMITS.");
    }

    const args = ctx.message.text.split(" ").slice(1);
    const userId = args[0];

    if (!userId) {
      return ctx.reply("Укажите ID пользователя: /unban 123456789");
    }

    await redisLimiter.unbanUser(parseInt(userId));
    ctx.reply(`✅ Пользователь ${userId} разблокирован`);
  } catch (error) {
    logger.error("Error in unban command:", error);
    ctx.reply("Ошибка при разблокировке пользователя.");
  }
});

// Очистка неактивных пользователей
bot.command("cleanup_users", async (ctx) => {
  try {
    if (!isAdmin(ctx.from.id)) return;

    const args = ctx.message.text.split(" ");
    const days = parseInt(args[1]) || 30;

    if (days < 1) {
      return ctx.reply("Укажите количество дней больше 0");
    }

    let cleanedFromDB = 0;
    if (FEATURE_FLAGS.usersDatabase) {
      cleanedFromDB = await usersDB.cleanupInactiveUsers(days);
    }

    const cleanedFromSessions = sessionManager.cleanupOldSessions(
      days * 24 * 60 * 60 * 1000
    );

    ctx.reply(
      `✅ Удалено ${cleanedFromDB} неактивных пользователей из БД и ${cleanedFromSessions} сессий (старше ${days} дней)`
    );
  } catch (error) {
    logger.error("Error in cleanup_users command:", error);
    ctx.reply("Ошибка при очистке неактивных пользователей.");
  }
});

// Очистка всех данных
bot.command("clear_all", (ctx) => {
  try {
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
  } catch (error) {
    logger.error("Error in clear_all command:", error);
    ctx.reply("Ошибка при сбросе данных.");
  }
});

// Список аудиофайлов
bot.command("list_audio", (ctx) => {
  try {
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
      msg += `<b>Дата:</b> ${new Date(item.timestamp).toLocaleString(
        "ru-RU"
      )}\n`;
      msg += "──────────────\n";
    });
    ctx.reply(msg, { parse_mode: "HTML" });
  } catch (error) {
    logger.error("Error in list_audio command:", error);
    ctx.reply("Ошибка при получении списка аудио.");
  }
});

// Удаление аудиофайла
bot.command("delete_audio", (ctx) => {
  try {
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
  } catch (error) {
    logger.error("Error in delete_audio command:", error);
    ctx.reply("Ошибка при удалении аудио.");
  }
});

// ================ ОБРАБОТЧИК ТЕКСТОВЫХ СООБЩЕНИЙ ================
bot.on("text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) {
    return;
  }

  try {
    // Проверяем и создаем пользователя, если нужно
    if (FEATURE_FLAGS.usersDatabase && ctx.from) {
      await ensureUserExists(
        ctx.from.id,
        ctx.from.first_name,
        ctx.from.username
      );
    }

    await addToQueue(ctx.from.id, async () => {
      try {
        const userData = getUserData(ctx.from.id);
        userData.tafsirParts = [];
        userData.currentTafsirPage = 0;

        const newText = ctx.message.text.trim();

        if (newText === "📖 Выбрать суру") {
          userData.button = true;
          return ctx.reply("Введите номер суры (от 1 до 114)");
        }

        if (newText === "📚 Начать заучивать") {
          // правила заучивания
          const rulesMsg = `
<b>🤝 Ассаляму ‘алейкум!</b>

Мы рады приветствовать вас на пути заучивания Священного Корана — одному из величайших видов поклонения.

📖 Пророк ﷺ сказал:  
<i>«Кто ступит на путь поиска знания, тому Аллах облегчает путь в Рай»</i>  
<i>«Лучшие из вас — те, кто изучают Коран и обучают ему»</i>

Так как сегодня большинство людей пользуются мессенджерами, мы сделали процесс заучивания максимально простым и доступным.

✨ Совместно с <b>@lubi_quran</b> мы подготовили программу, основанную на принципе:  
<b>— один аят → один шаг</b>

<b>📘 В рамках программы:</b>
• 🎧 вы слушаете чтение аята в исполнении шейха <b>Махмуда Халиля аль-Хусари</b>;  
• 📕 читаете перевод для понимания смысла;  
• 📘 изучаете краткий тафсир шейха <b>Ас-Са‘ди</b>;  
• 🔁 после освоения аята переходите к следующему.

<b>📌 Правильное чтение — основа успешного заучивания.</b>  
Поэтому рекомендуем пройти курс таджвида у <b>@lubi_quran</b>.

<b>🤲 Пусть Аллах сделает ваше заучивание лёгким и благодатным и откроет вам понимание Его Книги.</b>

          `;
          return ctx.reply(rulesMsg, { parse_mode: "HTML" });
        }

        if (userData.button) {
          const surahNumber = parseInt(newText);
          if (!isNaN(surahNumber) && surahNumber >= 1 && surahNumber <= 114) {
            userData.track = surahNumber;
            userData.button = null;
            return ctx.reply(
              `Выбрана сура ${surahNumber}. Отправьте номер аята.`
            );
          } else {
            return ctx.reply("Номер суры должен быть от 1 до 114");
          }
        }

        userData.text = newText;

        if (!userData.track || !userData.text) {
          return ctx.reply(
            "Укажите номер суры (/surah) и номер аята (отправьте текст)."
          );
        }

        // Получаем информацию о суре
        const surahInfo = surahs.find(
          (s) => s.number === parseInt(userData.track)
        );
        if (!surahInfo) {
          return ctx.reply(`Сура ${userData.track} не найдена`);
        }

        const ayahs = parsePageRanges(userData.text);
        if (!ayahs || ayahs.length === 0) {
          return ctx.reply("Некорректно указан номер аята.");
        }

        if (ayahs.length > 1 && !isAdmin(ctx.from.id)) {
          return ctx.reply("Некорректно указан номер аята.");
        }

        // Проверяем, что все аяты в пределах суры
        const invalidAyahs = ayahs.filter(
          (ayah) => ayah <= 0 || ayah > surahInfo.ayahs
        );
        if (invalidAyahs.length > 0) {
          const surahName = surahInfo.name_ru || surahInfo.name_en;
          return ctx.reply(
            `Сура ${surahInfo.number} (${surahName}) содержит ${surahInfo.ayahs} аятов.\n` +
              `Некорректные номер(а) аята(ов): ${invalidAyahs.join(", ")}`
          );
        }

        // Проверяем лимит на количество аятов
        if (ayahs.length > CONFIG.userLimits.maxAyahsPerRequest) {
          return ctx.reply(
            `Максимальное количество аятов за один запрос: ${CONFIG.userLimits.maxAyahsPerRequest}`
          );
        }

        popularRequests.update(userData.track, ayahs);

        // Создаем аудио с проверкой лимитов
        const result = await createAudioWithLimits(ctx, userData, ayahs);

        if (!result.success) {
          return ctx.reply(result.error);
        }
      } catch (error) {
        logger.error("Error in text handler task:", error);
        analytics.trackEvent(ctx.from.id, "audio_creation_failed", {
          error: error.message,
        });
        throw error;
      }
    });
  } catch (err) {
    if (err.message.includes("Ваш предыдущий запрос")) {
      return ctx.reply(err.message);
    }
    logger.error(`Text handler error: ${err.message}`);
    ctx.reply(MESSAGE_TEMPLATES.error("processing"));
    clearTempFolder();
  }
});

// ================ ОБРАБОТЧИКИ КОЛБЭКОВ ================

// Обработка выбора цвета
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

    userData.audioPath = await getValue(
      toGlobalAyah(userData.track, parseInt(userData.text))
    );
    userData.text = userData.text.toString();

    const surahInfo = surahs[Number(userData.track) - 1] || {};
    userData.message = `${colorAction} Сура ${userData.track} «${
      surahInfo.name_en
    } (${surahInfo.name_ru}), ${userData.text.includes("-") ? "аяты" : "аят"} ${
      userData.text
    }» - Махмуд Аль-Хусари\n\n#коран ${toHashtag(surahInfo.name_en)}`;

    const isOneAyah = userData.text && /^\d+$/.test(userData.text.trim());

    // Кнопки для админа
    const adminKeyboard = [
      [
        Markup.button.callback("✅ Отправить", "send_audio"),
        Markup.button.callback("❌ Отмена", "cancel_audio"),
      ],
      ...(isOneAyah
        ? [
            [
              Markup.button.callback(
                "📕 Показать перевод",
                "show_translate:true"
              ),
            ],
            [Markup.button.callback("📘 Показать тафсир", "show_tafsir:true")],
          ]
        : []),
    ];

    // Кнопки для обычного пользователя
    const userKeyboard = [
      ...(isOneAyah
        ? [
            [
              Markup.button.callback(
                "📕 Показать перевод",
                "show_translate:true"
              ),
            ],
            [Markup.button.callback("📘 Показать тафсир", "show_tafsir:true")],
          ]
        : []),
    ];

    let audioFileId = await ctx.replyWithAudio(
      getAudioInput(userData.audioPath),
      {
        filename: `${userData.artist} - ${surahInfo.name_en} - ${userData.text}.mp3`,
        caption: userData.message,
        reply_markup: isAdmin(ctx.from.id)
          ? Markup.inlineKeyboard(adminKeyboard).reply_markup
          : Markup.inlineKeyboard(userKeyboard).reply_markup,
      }
    );

    userData.audioPath = audioFileId.audio.file_id;

    analytics.trackEvent(ctx.from.id, "color_selected", { color: colorAction });
  } catch (err) {
    logger.error(`Color action error: ${err.message}`);
    ctx.reply("Ошибка при выборе цвета.");
  }
});

// Отправка аудио в канал
bot.action("send_audio", async (ctx) => {
  try {
    await ctx.deleteMessage();
    const userData = getUserData(ctx.from.id);

    if (!userData.audioPath) return ctx.reply("Аудиофайл не найден.");

    const sentAudio = await bot.telegram.sendAudio(
      CHANNEL_ID || ctx.chat.id,
      userData.audioPath,
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

    analytics.trackEvent(ctx.from.id, "audio_sent_to_channel", {
      surah: userData.track,
      ayahs: userData.text,
      color: userData.color,
    });
  } catch (err) {
    logger.error(`Send audio error: ${err.message}`);
    ctx.reply("Ошибка при отправке аудио.");
  }
});

// Отмена отправки
bot.action("cancel_audio", async (ctx) => {
  try {
    const userData = getUserData(ctx.from.id);
    await ctx.deleteMessage();
    ctx.reply("Отправка отменена.");
    clearTempFolder();
    Object.assign(userData, {
      audioPath: "",
      color: "",
      text: "",
    });
    analytics.trackEvent(ctx.from.id, "audio_cancelled");
  } catch (error) {
    logger.error("Error in cancel_audio action:", error);
    ctx.reply("Ошибка при отмене отправки.");
  }
});

// Показать перевод
bot.action(/show_translate:(true|false)/, async (ctx) => {
  try {
    const flag = ctx.match[1] === "true";
    const userData = getUserData(ctx.from.id);

    const surah = Number(userData.track);
    const ayah = Number(userData.text);

    await showTranslation(ctx, surah, ayah, flag);

    analytics.trackEvent(ctx.from.id, "translation_viewed", {
      surah,
      ayah,
    });
  } catch (error) {
    logger.error("Error in show_translate action:", error);
    ctx.reply("Ошибка при показе перевода.");
  }
});

// Обработчик для показа продолжения перевода
bot.action(/show_translation_continue:(\d+):(\d+)/, async (ctx) => {
  try {
    const surah = parseInt(ctx.match[1]);
    const ayah = parseInt(ctx.match[2]);
    const userData = getUserData(ctx.from.id);

    await ctx.answerCbQuery("Загружаю продолжение...");
    await ctx.editMessageReplyMarkup(); // Убираем кнопку

    // Получаем полный перевод
    let translationResult = await getCachedTranslation(surah, ayah);
    const surahInfo = surahs[surah - 1] || {};

    // Формируем полное сообщение
    const fullMessage = `
📕 *Перевод Абу Аделя (полный текст)*
━━━━━━━━━━━━━━━
🕋 *Сура:* ${surah} ${surahInfo.name_ru}
🔹 *Аят:* ${ayah}

💬 *Полный перевод:*
_${translationResult}_
    `;

    // Отправляем полный перевод как новое сообщение
    await ctx.reply(fullMessage, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "⬅️ Пред.аят", callback_data: `prev_translation_ayah` },
            { text: "След.аят ➡️", callback_data: `next_translation_ayah` },
          ],
          [{ text: "🔈 Прослушать аят", callback_data: `color_🔈` }],
          [
            {
              text: "📘 Перейти к тафсиру",
              callback_data: `show_tafsir_reply`,
            },
          ],
        ],
      },
    });

    analytics.trackEvent(ctx.from.id, "translation_continue_viewed", {
      surah,
      ayah,
    });
  } catch (error) {
    logger.error("Error in show_translation_continue action:", error);
    ctx.answerCbQuery("❌ Ошибка загрузки продолжения.");
  }
});

// Следующий аят
// Обработчик перехода к следующему аяту из перевода
bot.action("next_translation_ayah", async (ctx) => {
  try {
    const userData = getUserData(ctx.from.id);
    const nextAyah = Number(userData.text) + 1;
    const surahInfo = surahs[userData.track - 1];

    if (!surahInfo || nextAyah > surahInfo.ayahs) {
      return ctx.answerCbQuery("❌ Это последний аят суры");
    }

    userData.text = nextAyah;
    await showTranslation(ctx, userData.track, nextAyah, false);

    analytics.trackEvent(ctx.from.id, "next_ayah_from_translation", {
      surah: userData.track,
      ayah: nextAyah,
    });
  } catch (error) {
    logger.error("Error in next_translation_ayah action:", error);
    ctx.answerCbQuery("❌ Ошибка перехода к следующему аяту.");
  }
});

// Обработчик перехода к предыдущему аяту из перевода
bot.action("prev_translation_ayah", async (ctx) => {
  try {
    const userData = getUserData(ctx.from.id);
    const prevAyah = Number(userData.text) - 1;

    if (prevAyah < 1) {
      return ctx.answerCbQuery("❌ Это первый аят суры");
    }

    userData.text = prevAyah;
    await showTranslation(ctx, userData.track, prevAyah, false);

    analytics.trackEvent(ctx.from.id, "prev_ayah_from_translation", {
      surah: userData.track,
      ayah: prevAyah,
    });
  } catch (error) {
    logger.error("Error in prev_translation_ayah action:", error);
    ctx.answerCbQuery("❌ Ошибка перехода к предыдущему аяту.");
  }
});

// Предыдущий аят
bot.action(/prev_ayah:(true|false)/, async (ctx) => {
  try {
    const flag = ctx.match[1] === "true"; // превращаем строку в boolean
    const userData = getUserData(ctx.from.id);
    userData.text = Number(userData.text) - 1;

    if (userData.text >= 1) {
      await showTranslation(ctx, userData.track, userData.text, flag);
      analytics.trackEvent(ctx.from.id, "prev_ayah_navigation", {
        surah: userData.track,
        ayah: userData.text,
        // showTranslation: flag
      });
    } else {
      await ctx.answerCbQuery("❌ Это первый аят суры");
    }
  } catch (error) {
    logger.error("Error in prev_ayah action:", error);
    ctx.reply("Ошибка при переходе к предыдущему аяту.");
  }
});

// Показать тафсир
bot.action(/show_tafsir:(true|false)/, async (ctx) => {
  try {
    const flag = ctx.match[1] === "true"; // превращаем строку в boolean
    const userData = getUserData(ctx.from.id);

    const surah = Number(userData.track);
    const ayah = Number(userData.text);

    await showTafsir(ctx, flag);

    analytics.trackEvent(ctx.from.id, "tafsir_viewed", {
      surah,
      ayah,
      // flag,
    });
  } catch (error) {
    logger.error("Error in show_tafsir action:", error);
    ctx.reply("Ошибка при показе тафсира.");
  }
});

// Показать тафсир (из перевода)
bot.action("show_tafsir_reply", async (ctx) => {
  try {
    await showTafsir(ctx, true);
    const userData = getUserData(ctx.from.id);
    analytics.trackEvent(ctx.from.id, "tafsir_viewed_from_translation", {
      surah: userData.track,
      ayah: userData.text,
    });
  } catch (error) {
    logger.error("Error in show_tafsir_reply action:", error);
    ctx.reply("Ошибка при показе тафсира.");
  }
});

// Следующая часть тафсира
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
      : getNavigationKeyboard(userData.track, userData.text, false);

    const currentTafsirText = userData.tafsirParts[userData.currentTafsirPage];
    if (!currentTafsirText) {
      await ctx.answerCbQuery("❌ Ошибка: текст тафсира не найден.");
      return;
    }

    const message = `..._${currentTafsirText}_\n\nСтраница: *${
      userData.currentTafsirPage + 1
    }/${userData.tafsirParts.length}*`;

    await ctx.reply(message, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });

    analytics.trackEvent(ctx.from.id, "tafsir_pagination", {
      page: userData.currentTafsirPage + 1,
      total: userData.tafsirParts.length,
    });
  } catch (err) {
    logger.error(err);
    await ctx.answerCbQuery("❌ Ошибка при загрузке тафсира.");
  }
});

// ================ СИСТЕМА ОЧИСТКИ И ПОДДЕРЖКИ ================

// Очистка старых сессий и лимитов
setInterval(() => {
  try {
    // Очищаем старые сессии
    sessionManager.cleanupOldSessions(CONFIG.sessionTimeout);

    logger.info(
      `Session cleanup: ${sessionManager.getSessionCount()} active sessions`
    );
  } catch (error) {
    logger.error("Error in session cleanup:", error);
  }
}, 30 * 60 * 1000);

// Очистка памяти
setInterval(() => memoryManager.cleanup(), CONFIG.memoryCleanupInterval);

// Автобэкап каждые 24 часа
setInterval(() => {
  backupManager.createBackup();
}, 24 * 60 * 60 * 1000);

// ================ ИНИЦИАЛИЗАЦИЯ БАЗ ДАННЫХ ================
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
    sendAlert(`Ошибка инициализации баз данных: ${error.message}`, "CRITICAL");
  }
}

// ================ ОБРАБОТЧИКИ ОШИБОК ================
process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled Rejection at:", promise, "reason:", reason);
  sendAlert(`Unhandled Rejection: ${reason}`, "CRITICAL");
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught Exception:", error);
  sendAlert(`Uncaught Exception: ${error.message}`, "CRITICAL");
  process.exit(1);
});

process.once("SIGINT", async () => {
  try {
    logger.info("Received SIGINT, shutting down gracefully");

    if (FEATURE_FLAGS.usersDatabase) {
      await usersDB.closeDatabase();
      logger.info("Users database closed");
    }

    if (FEATURE_FLAGS.redisLimits) {
      await redisLimiter.close();
      logger.info("Redis limiter closed");
    }

    bot.stop("SIGINT");
    logger.info("Bot stopped");
  } catch (error) {
    logger.error("Error during SIGINT handling:", error);
  }
});

process.once("SIGTERM", async () => {
  try {
    logger.info("Received SIGTERM, shutting down gracefully");

    if (FEATURE_FLAGS.usersDatabase) {
      await usersDB.closeDatabase();
      logger.info("Users database closed");
    }

    if (FEATURE_FLAGS.redisLimits) {
      await redisLimiter.close();
      logger.info("Redis limiter closed");
    }

    bot.stop("SIGTERM");
    logger.info("Bot stopped");
  } catch (error) {
    logger.error("Error during SIGTERM handling:", error);
  }
});

// ================ ЗАПУСК БОТА ================
async function startBot() {
  try {
    // Инициализируем базы данных
    await initializeDatabases();

    // Запускаем бота
    await bot.launch();

    logger.info("✅ Бот успешно запущен!");
    logger.info("System initialized", {
      featureFlags: FEATURE_FLAGS,
      config: {
        maxAyahs: CONFIG.maxAyahs,
        userLimits: CONFIG.userLimits,
        cacheTtl: CONFIG.cacheTtl,
      },
    });

    // Отправляем уведомление о запуске
    if (ALERT_CHAT_ID) {
      try {
        await bot.telegram.sendMessage(
          ALERT_CHAT_ID,
          "✅ Бот успешно запущен!\n" +
            `Режимы: ${FEATURE_FLAGS.usersDatabase ? "UsersDB" : ""} ${
              FEATURE_FLAGS.redisLimits ? "RedisLimits" : ""
            }`,
          { parse_mode: "Markdown" }
        );
      } catch (error) {
        logger.error("Failed to send startup alert:", error);
      }
    }
  } catch (error) {
    logger.error(`❌ Bot launch error: ${error.message}`);
    sendAlert(`Ошибка запуска бота: ${error.message}`, "CRITICAL");
    process.exit(1);
  }
}

// Запускаем бота
startBot();
