require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const path = require("path");
const fs = require("fs");
const NodeID3 = require("node-id3");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const winston = require("winston");
// const express = require("express");
// const Redis = require('ioredis'); // Раскомментировать если нужен Redis

const surahs = require("./quran.json");
const { mp3create } = require("./mp3create");
const { getTafsir } = require("./tafsir");
const { getKulievTranslation } = require("./translate");

// Настройка ffmpeg
try {
  ffmpeg.setFfmpegPath(ffmpegPath);
} catch (error) {
  console.error("Error setting ffmpeg path:", error);
}

// Константы и конфигурация
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL;
const TEMP_FOLDER = process.env.TEMP_FOLDER || path.resolve("./temp");
const DATA_FILE = path.resolve("./audio_data.json");
const BACKUP_FOLDER = path.resolve("./backups");
const ADMIN_USER_ID = process.env.ALLOWED_USER_ID;
const ALERT_CHAT_ID = process.env.ALERT_CHAT_ID;

// Конфигурация
const config = {
  tempFolder: TEMP_FOLDER,
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 50 * 1024 * 1024, // 50MB
  maxAyahs: parseInt(process.env.MAX_AYAHS) || 20,
  sessionTimeout: parseInt(process.env.SESSION_TIMEOUT) || 60 * 60 * 1000,
  cacheTtl: parseInt(process.env.CACHE_TTL) || 30 * 60 * 1000,
  userLimits: {
    requestsPerMinute: parseInt(process.env.REQUESTS_PER_MINUTE) || 10,
    requestsPerHour: parseInt(process.env.REQUESTS_PER_HOUR) || 50,
    maxAyahsPerRequest: parseInt(process.env.MAX_AYAHS_PER_REQUEST) || 50,
  },
  batchSize: parseInt(process.env.BATCH_SIZE) || 5,
  maxConcurrentProcesses: parseInt(process.env.MAX_CONCURRENT_PROCESSES) || 3,
  memoryCleanupInterval: parseInt(process.env.MEMORY_CLEANUP_INTERVAL) || 10 * 60 * 1000, // 10 минут
};

// Расширенная система логирования
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
      )
    }),
    new winston.transports.File({ 
      filename: "logs/error.log", 
      level: "error",
      maxsize: 10485760, // 10MB
      maxFiles: 5
    }),
    new winston.transports.File({ 
      filename: "logs/combined.log",
      maxsize: 10485760,
      maxFiles: 5
    }),
    new winston.transports.File({ 
      filename: "logs/analytics.log",
      maxsize: 10485760,
      maxFiles: 3
    })
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
  cacheHits: 0,
  cacheMisses: 0,
};

// Кэширование
const cache = new Map();
const CACHE_TTL = config.cacheTtl;

// Очередь обработки
const processingQueue = new Map();

// Система лимитов
const userLimits = new Map();

// Популярные запросы
const popularRequests = {
  surahs: new Map(),
  ayahRanges: new Map(),
  update: function(surah, ayahs) {
    try {
      // Статистика по сурам
      const surahCount = this.surahs.get(surah) || 0;
      this.surahs.set(surah, surahCount + 1);
      
      // Статистика по диапазонам аятов
      const range = ayahs.length > 1 ? 'multiple' : 'single';
      const rangeCount = this.ayahRanges.get(range) || 0;
      this.ayahRanges.set(range, rangeCount + 1);
    } catch (error) {
      console.error("Error updating popular requests:", error);
    }
  },
  getStats: function() {
    try {
      return {
        topSurahs: [...this.surahs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
        rangeStats: Object.fromEntries(this.ayahRanges)
      };
    } catch (error) {
      console.error("Error getting popular stats:", error);
      return { topSurahs: [], rangeStats: {} };
    }
  }
};

// Система шаблонов сообщений
const messageTemplates = {
  welcome: (name) => `
Ассаляму алейкум, ${name}!

🕌 Бот для создания аудио из Корана

📖 Основные команды:
/surah <номер> - выбрать суру
/surah_info <номер> - информация о суре
/help - полная справка

Пример использования:
1. /surah 1
2. Отправьте: 1-5, 7, 10
  `,

  audioReady: (surah, ayahs, isOneAyah = false) => {
    const base = `🎧 *Аудио готово!*\n\n`;
    const adminControls = isOneAyah ? `
📖 Показать перевод
📘 Показать тафсир
    ` : '';
    
    return base + adminControls;
  },

  error: (type) => {
    const errors = {
      processing: "⚠️ Ошибка при обработке аудио. Попробуйте позже.",
      validation: "❌ Некорректные данные. Проверьте номер суры и аятов.",
      timeout: "⏰ Время обработки истекло. Попробуйте снова.",
      general: "❌ Произошла ошибка. Мы уже работаем над исправлением.",
      rateLimit: "⏳ Слишком много запросов. Пожалуйста, подождите.",
      fileTooLarge: "📁 Файл слишком большой. Попробуйте меньше аятов.",
      network: "🌐 Проблемы с сетью. Попробуйте позже."
    };
    return errors[type] || errors.general;
  }
};

// Feature flags
const featureFlags = {
  newAudioEngine: process.env.FF_NEW_AUDIO === 'true',
  enhancedTafsir: process.env.FF_ENHANCED_TAFSIR === 'true',
  voiceMessages: process.env.FF_VOICE_MESSAGES === 'true',
  analytics: process.env.FF_ANALYTICS === 'true',
  qualityCheck: process.env.FF_QUALITY_CHECK === 'true'
};

// Система управления конфигурацией
class ConfigManager {
  constructor() {
    this.config = { ...config };
    this.watchers = new Map();
  }
  
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    this.notifyWatchers();
    logger.info('Configuration updated', { newConfig });
  }
  
  watch(key, callback) {
    if (!this.watchers.has(key)) {
      this.watchers.set(key, new Set());
    }
    this.watchers.get(key).add(callback);
  }
  
  notifyWatchers() {
    for (const [key, callbacks] of this.watchers) {
      if (key in this.config) {
        callbacks.forEach(callback => callback(this.config[key]));
      }
    }
  }
  
  reloadFromEnv() {
    this.updateConfig({
      maxAyahs: parseInt(process.env.MAX_AYAHS) || 20,
      userLimits: {
        requestsPerMinute: parseInt(process.env.REQUESTS_PER_MINUTE) || 10,
        requestsPerHour: parseInt(process.env.REQUESTS_PER_HOUR) || 50,
      }
    });
  }
}

const configManager = new ConfigManager();

// Система аналитики
const analytics = {
  trackEvent: function(userId, eventType, metadata = {}) {
    try {
      if (!featureFlags.analytics) return;
      
      const event = {
        userId,
        eventType,
        timestamp: new Date().toISOString(),
        ...metadata
      };
      
      // Сохранение в файл
      const analyticsFile = path.join(__dirname, 'logs', 'analytics.log');
      fs.appendFileSync(analyticsFile, JSON.stringify(event) + '\n');
      
    } catch (error) {
      console.error('Analytics tracking error:', error);
    }
  },

  getConversionRate: function() {
    const total = botStats.successfulAudio + botStats.failedAudio;
    return total > 0 ? (botStats.successfulAudio / total * 100).toFixed(1) : 0;
  },

  getCacheEfficiency: function() {
    const total = botStats.cacheHits + botStats.cacheMisses;
    return total > 0 ? (botStats.cacheHits / total * 100).toFixed(1) : 0;
  }
};

// Система управления памятью
const memoryManager = {
  cleanup: function() {
    try {
      // Принудительный сбор мусора (если доступен)
      if (global.gc) {
        global.gc();
      }
      
      // Очистка старых кэшей
      const now = Date.now();
      let clearedCacheItems = 0;
      for (const [key, value] of cache.entries()) {
        if (now - value.timestamp > CACHE_TTL) {
          cache.delete(key);
          clearedCacheItems++;
        }
      }
      
      // Очистка старых сессий
      const SESSION_MAX_AGE = 24 * 60 * 60 * 1000; // 24 часа
      let clearedSessions = 0;
      for (const [userId, session] of userSessions.entries()) {
        if (now - (session.lastActivity || 0) > SESSION_MAX_AGE) {
          userSessions.delete(userId);
          clearedSessions++;
        }
      }
      
      logger.info(`Memory cleanup completed. Cache: ${clearedCacheItems} items, Sessions: ${clearedSessions} sessions`);
    } catch (error) {
      logger.error("Memory cleanup error:", error);
    }
  }
};

// Система ретраев с экспоненциальной задержкой
async function retryWithBackoff(operation, maxRetries = 3, baseDelay = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === maxRetries) throw error;
      
      const delay = baseDelay * Math.pow(2, attempt - 1);
      const jitter = delay * 0.1 * Math.random();
      
      logger.warn(`Retry attempt ${attempt} after ${Math.round(delay + jitter)}ms`);
      await new Promise(resolve => setTimeout(resolve, delay + jitter));
    }
  }
}

// Система проверки качества аудио
const audioQuality = {
  validateFile: async function(filePath) {
    return new Promise((resolve) => {
      try {
        const stats = fs.statSync(filePath);
        
        // Проверка размера файла
        if (stats.size === 0) {
          resolve({ valid: false, reason: 'empty_file' });
          return;
        }
        
        if (stats.size > config.maxFileSize) {
          resolve({ valid: false, reason: 'file_too_large' });
          return;
        }
        
        // Проверка продолжительности через ffmpeg
        ffmpeg.ffprobe(filePath, (err, metadata) => {
          if (err) {
            resolve({ valid: false, reason: 'corrupted_file' });
            return;
          }
          
          const duration = metadata.format.duration;
          if (!duration || duration < 0.1) {
            resolve({ valid: false, reason: 'invalid_duration' });
            return;
          }
          
          resolve({ valid: true, duration, size: stats.size });
        });
      } catch (error) {
        resolve({ valid: false, reason: 'file_error' });
      }
    });
  }
};

// Система уведомлений
const notifications = {
  sendToUser: async function(userId, message, options = {}) {
    try {
      await bot.telegram.sendMessage(userId, message, {
        parse_mode: 'Markdown',
        ...options
      });
      return true;
    } catch (error) {
      if (error.response?.error_code === 403) {
        logger.warn(`User ${userId} blocked the bot`);
        // Удаляем пользователя из статистики
        botStats.users.delete(userId);
      }
      return false;
    }
  }
};

// Система A/B тестирования
const abTesting = {
  experiments: new Map(),
  
  createExperiment: function(name, variants, weights = []) {
    this.experiments.set(name, {
      variants,
      weights: weights.length === variants.length ? weights : Array(variants.length).fill(1/variants.length),
      participants: new Map()
    });
  },
  
  getVariant: function(userId, experimentName) {
    const experiment = this.experiments.get(experimentName);
    if (!experiment) return null;
    
    if (experiment.participants.has(userId)) {
      return experiment.participants.get(userId);
    }
    
    // Распределение по вариантам с учетом весов
    const random = Math.random();
    let sum = 0;
    let selectedVariant = experiment.variants[0];
    
    for (let i = 0; i < experiment.weights.length; i++) {
      sum += experiment.weights[i];
      if (random <= sum) {
        selectedVariant = experiment.variants[i];
        break;
      }
    }
    
    experiment.participants.set(userId, selectedVariant);
    return selectedVariant;
  }
};

// Система плагинов
class PluginSystem {
  constructor() {
    this.plugins = new Map();
    this.hooks = new Map();
  }
  
  registerPlugin(name, plugin) {
    this.plugins.set(name, plugin);
    
    if (plugin.hooks) {
      for (const [hookName, hookFn] of Object.entries(plugin.hooks)) {
        this.registerHook(hookName, hookFn);
      }
    }
    
    logger.info(`Plugin registered: ${name}`);
  }
  
  registerHook(hookName, hookFn) {
    if (!this.hooks.has(hookName)) {
      this.hooks.set(hookName, []);
    }
    this.hooks.get(hookName).push(hookFn);
  }
  
  async executeHook(hookName, ...args) {
    if (!this.hooks.has(hookName)) return;
    
    for (const hookFn of this.hooks.get(hookName)) {
      try {
        await hookFn(...args);
      } catch (error) {
        logger.error(`Plugin hook error (${hookName}):`, error);
      }
    }
  }
}

const pluginSystem = new PluginSystem();

// Пример плагина для улучшения аудио
const audioEnhancementPlugin = {
  hooks: {
    'before_audio_create': async (settings) => {
      logger.info('Audio enhancement plugin: processing settings', { settings });
    },
    
    'after_audio_create': async (audioPath, settings) => {
      if (featureFlags.qualityCheck) {
        const qualityCheck = await audioQuality.validateFile(audioPath);
        if (!qualityCheck.valid) {
          logger.warn('Audio quality check failed', { audioPath, reason: qualityCheck.reason });
        }
      }
    }
  }
};

pluginSystem.registerPlugin('audioEnhancement', audioEnhancementPlugin);

// Система мониторинга и алертов
async function sendAlert(message, level = "ERROR") {
  try {
    if (!ALERT_CHAT_ID) return;
    
    const alertMsg = `🚨 *${level}*\n${message}\n_${new Date().toISOString()}_`;
    await bot.telegram.sendMessage(ALERT_CHAT_ID, alertMsg, { 
      parse_mode: "Markdown" 
    });
  } catch (error) {
    console.error("Alert sending failed:", error);
  }
}

const monitorSystem = {
  start: function() {
    setInterval(() => {
      try {
        const memoryUsage = process.memoryUsage();
        const memoryPercent = (memoryUsage.heapUsed / memoryUsage.heapTotal * 100).toFixed(2);
        
        if (memoryPercent > 80) {
          sendAlert(`Высокое использование памяти: ${memoryPercent}%`, "WARNING");
        }
        
        // Мониторинг ошибок
        if (botStats.failedAudio > 0 && botStats.failedAudio > botStats.successfulAudio * 0.1) {
          sendAlert(`Высокий процент ошибок: ${((botStats.failedAudio / (botStats.successfulAudio + botStats.failedAudio)) * 100).toFixed(1)}%`, "WARNING");
        }

        // Мониторинг очереди
        if (processingQueue.size > 5) {
          sendAlert(`Большая очередь обработки: ${processingQueue.size} запросов`, "WARNING");
        }

        // Мониторинг файловой системы
        this.monitorFileSystem();
      } catch (error) {
        console.error("Monitoring error:", error);
      }
    }, 5 * 60 * 1000); // Каждые 5 минут
  },

  monitorFileSystem: function() {
    try {
      const tempSize = getFolderSize(TEMP_FOLDER);
      if (tempSize > 1000) { // 1GB
        sendAlert(`Большой размер temp папки: ${tempSize}MB`, "WARNING");
      }
    } catch (error) {
      console.error("File system monitoring error:", error);
    }
  }
};

// Создание необходимых папок
try {
  [config.tempFolder, BACKUP_FOLDER, "logs"].forEach((folder) => {
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
  });
} catch (error) {
  console.error("Error creating folders:", error);
}

// --- ГЛОБАЛЬНЫЕ ОБРАБОТЧИКИ ОШИБОК ---
process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled Rejection at:", promise, "reason:", reason);
  sendAlert(`Unhandled Rejection: ${reason}`, "CRITICAL");
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught Exception:", error);
  sendAlert(`Uncaught Exception: ${error.message}`, "CRITICAL");
  process.exit(1);
});

// --- ФУНКЦИЯ ПРОВЕРКИ АДМИНА ---
function isAdmin(userId) {
  try {
    if (!ADMIN_USER_ID) return false;
    const adminIds = ADMIN_USER_ID.split(",").map((id) => id.trim());
    return adminIds.includes(userId.toString());
  } catch (error) {
    console.error("Error in isAdmin:", error);
    return false;
  }
}

// ---- ADMIN ONLY MIDDLEWARE ----
try {
  if (ADMIN_USER_ID) {
    const adminIds = ADMIN_USER_ID.split(",").map((id) => id.trim());
    bot.use((ctx, next) => {
      try {
        const userId = ctx.from?.id?.toString();
        if (adminIds.includes(userId)) {
          return next();
        }
        return;
      } catch (error) {
        console.error("Error in admin middleware:", error);
        return next();
      }
    });
  } else {
    console.error("ADMIN_USER_ID не указан в .env!");
  }
} catch (error) {
  console.error("Error setting up admin middleware:", error);
}

// --- СИСТЕМА ОЧЕРЕДИ ---
async function addToQueue(userId, task) {
  try {
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
  } catch (error) {
    console.error("Error in addToQueue:", error);
    throw error;
  }
}

// --- СИСТЕМА ЛИМИТОВ ---
function checkRateLimit(userId) {
  try {
    const now = Date.now();
    const userLimit = userLimits.get(userId) || { 
      minute: [], 
      hour: [],
      lastWarning: 0
    };
    
    // Очистка старых записей
    userLimit.minute = userLimit.minute.filter(time => now - time < 60000);
    userLimit.hour = userLimit.hour.filter(time => now - time < 3600000);
    
    // Проверка лимитов
    if (userLimit.minute.length >= config.userLimits.requestsPerMinute) {
      return { allowed: false, reason: "minute_limit" };
    }
    
    if (userLimit.hour.length >= config.userLimits.requestsPerHour) {
      return { allowed: false, reason: "hour_limit" };
    }
    
    // Добавление текущего запроса
    userLimit.minute.push(now);
    userLimit.hour.push(now);
    userLimits.set(userId, userLimit);
    
    return { allowed: true };
  } catch (error) {
    console.error("Error in checkRateLimit:", error);
    return { allowed: true }; // В случае ошибки разрешаем запрос
  }
}

// --- КЭШИРОВАНИЕ ---
function getCacheKey(type, surah, ayah) {
  try {
    return `${type}_${surah}_${ayah}`;
  } catch (error) {
    console.error("Error in getCacheKey:", error);
    return `error_${Date.now()}`;
  }
}

async function getCachedTafsir(surah, ayah) {
  try {
    const key = getCacheKey("tafsir", surah, ayah);
    const cached = cache.get(key);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      botStats.cacheHits++;
      return cached.data;
    }

    botStats.cacheMisses++;
    const data = await getTafsir(surah, ayah);
    cache.set(key, { data, timestamp: Date.now() });
    return data;
  } catch (error) {
    console.error("Error in getCachedTafsir:", error);
    throw error;
  }
}

async function getCachedTranslation(surah, ayah) {
  try {
    const key = getCacheKey("translation", surah, ayah);
    const cached = cache.get(key);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      botStats.cacheHits++;
      return cached.data;
    }

    botStats.cacheMisses++;
    const data = await getKulievTranslation(surah, ayah);
    cache.set(key, { data, timestamp: Date.now() });
    return data;
  } catch (error) {
    console.error("Error in getCachedTranslation:", error);
    throw error;
  }
}

// --- ВАЛИДАЦИЯ ---
function validateSurahAndAyah(surah, ayah) {
  try {
    if (surah < 1 || surah > 114) return false;
    return true;
  } catch (error) {
    console.error("Error in validateSurahAndAyah:", error);
    return false;
  }
}

// --- УТИЛИТЫ ---
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

function createLogEntry(ctx, action, metadata = {}) {
  try {
    return {
      timestamp: new Date().toISOString(),
      userId: ctx.from?.id,
      username: ctx.from?.username,
      action,
      chatType: ctx.chat?.type,
      ...metadata,
    };
  } catch (error) {
    console.error("Error in createLogEntry:", error);
    return {
      timestamp: new Date().toISOString(),
      action,
      error: "Failed to create log entry",
    };
  }
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
  }
};

// Система бэкапа конфигурации
const configBackup = {
  createBackup: () => {
    try {
      const backup = {
        config,
        featureFlags,
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || "1.0.0"
      };
      
      const backupPath = path.join(BACKUP_FOLDER, `config_${Date.now()}.json`);
      fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
      logger.info("Config backup created");
    } catch (error) {
      console.error("Config backup error:", error);
    }
  }
};

// Автобэкап каждые 24 часа
try {
  setInterval(() => {
    backupManager.createBackup();
    configBackup.createBackup();
  }, 24 * 60 * 60 * 1000);
} catch (error) {
  console.error("Error setting up backup interval:", error);
}

// Система восстановления после сбоев
const recoveryManager = {
  async recoverFromCrash() {
    try {
      // Проверяем незавершенные процессы
      const tempFiles = fs.readdirSync(TEMP_FOLDER);
      if (tempFiles.length > 0) {
        logger.warn(`Found ${tempFiles.length} temp files from previous session`);
        clearTempFolder();
      }
      
      // Восстанавливаем статистику из файла если нужно
      await this.restoreStats();
    } catch (error) {
      logger.error("Recovery failed:", error);
    }
  },
  
  async restoreStats() {
    try {
      // Логика восстановления статистики при необходимости
    } catch (error) {
      logger.error("Stats restoration failed:", error);
    }
  }
};

// Глобальные данные (теперь для каждого пользователя отдельно)
const userSessions = new Map();

// Обновляем функцию получения данных пользователя
function getUserData(userId) {
  try {
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
        lastActivity: Date.now()
      });
    } else {
      // Обновляем время последней активности
      userSessions.get(userId).lastActivity = Date.now();
    }
    return userSessions.get(userId);
  } catch (error) {
    console.error("Error in getUserData:", error);
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
      lastActivity: Date.now()
    };
  }
}

// Форматирование нумерованного текста
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
    console.error("Error in formatNumberedText:", error);
    return text;
  }
}

// --- УТИЛИТЫ ---
const parsePageRanges = (input) => {
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
};

const toHashtag = (str) => {
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
    console.error("Error in toHashtag:", error);
    return "#error";
  }
};

const clearTempFolder = () => {
  try {
    fs.readdirSync(TEMP_FOLDER).forEach((file) => {
      try {
        fs.unlinkSync(path.join(TEMP_FOLDER, file));
      } catch (err) {
        logger.error(`Error deleting file ${file}: ${err.message}`);
      }
    });
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
  try {
    const bars = "█".repeat(Math.floor(progress / 10));
    const spaces = "░".repeat(10 - Math.floor(progress / 10));

    const text = `Обработка аудио...\n[${bars}${spaces}] ${progress}%`;

    try {
      await ctx.telegram.editMessageText(ctx.chat.id, messageId, null, text);
    } catch (e) {
      // Игнорируем ошибки редактирования
    }
  } catch (error) {
    console.error("Error in showProgress:", error);
  }
}

// --- MIDDLEWARE ДЛЯ ЛОГИРОВАНИЯ И СТАТИСТИКИ ---
bot.use(async (ctx, next) => {
  try {
    const userId = ctx.from?.id;
    const username = ctx.from?.username || "без username";
    const firstName = ctx.from?.first_name || "без имени";

    // Проверка лимитов
    if (userId) {
      const limitCheck = checkRateLimit(userId);
      if (!limitCheck.allowed) {
        analytics.trackEvent(userId, 'rate_limit_exceeded');
        if (limitCheck.reason === "minute_limit") {
          return ctx.reply(messageTemplates.error("rateLimit"));
        } else {
          return ctx.reply("⏳ Превышен часовой лимит запросов. Попробуйте через час.");
        }
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
    
    // Трекинг после успешной обработки
    if (userId) {
      analytics.trackEvent(userId, 'request_completed', {
        command: ctx.message?.text,
        chatType: ctx.chat?.type
      });
    }
  } catch (error) {
    console.error("Error in logging middleware:", error);
    await next();
  }
});

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

async function metaTags(tags, outputAudioPath, tempMsg, ctx, userData) {
  try {
    await pluginSystem.executeHook('before_audio_create', tags);
    
    await writeID3(tags, outputAudioPath);
    userData.audioPath = outputAudioPath;

    // Проверка качества аудио
    if (featureFlags.qualityCheck) {
      const qualityCheck = await audioQuality.validateFile(outputAudioPath);
      if (!qualityCheck.valid) {
        logger.warn('Audio quality check failed', { 
          path: outputAudioPath, 
          reason: qualityCheck.reason 
        });
      }
    }

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
    await pluginSystem.executeHook('after_audio_create', outputAudioPath, tags);
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
  try {
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
  } catch (error) {
    console.error("Error in getNavigationKeyboard:", error);
    return { inline_keyboard: [] };
  }
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
  try {
    const name = ctx.from.first_name || "друг";
    ctx.reply(messageTemplates.welcome(name), {
      //parse_mode: "Markdown",
      reply_markup: {
        keyboard: [["📖 Выбрать суру"]],
        resize_keyboard: true,
      }
    });
    analytics.trackEvent(ctx.from.id, 'start_command');
  } catch (error) {
    console.error("Error in start command:", error);
  }
});

// --- КОМАНДА ПОМОЩИ ---
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
<b>/reload_config</b> — Перезагрузить конфигурацию.
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
    analytics.trackEvent(ctx.from.id, 'help_command');
  } catch (error) {
    console.error("Error in help command:", error);
  }
});

// --- КОМАНДА ИНФОРМАЦИИ О СУРЕ ---
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
    analytics.trackEvent(ctx.from.id, 'surah_info', { surah: surahNum });
  } catch (error) {
    console.error("Error in surah_info command:", error);
    ctx.reply("Ошибка при получении информации о суре.");
  }
});

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
    ctx.reply(`Выбрана сура ${surahNum}. Теперь отправьте номера аятов.`);
    analytics.trackEvent(ctx.from.id, 'surah_selected', { surah: surahNum });
  } catch (error) {
    console.error("Error in surah command:", error);
    ctx.reply("Ошибка при выборе суры.");
  }
});

// --- КОМАНДА ДЛЯ ПРОСМОТРА ЗНАЧЕНИЕ ЦВЕТОВ ---
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
    console.error("Error in colors command:", error);
    ctx.reply("Ошибка при получении информации о цветах.");
  }
});

// --- КОМАНДА СТАТИСТИКИ (ТОЛЬКО ДЛЯ АДМИНА) ---
bot.command("stats", (ctx) => {
  try {
    if (!isAdmin(ctx.from.id)) return;

    const statsMsg = `
📊 *Статистика бота*
━━━━━━━━━━━━━━━
👥 Уникальных пользователей: ${botStats.users.size}
📨 Всего запросов: ${botStats.totalRequests}
✅ Успешных аудио: ${botStats.successfulAudio}
❌ Ошибок: ${botStats.failedAudio}
💾 Размер temp: ${getFolderSize(TEMP_FOLDER)} MB
📊 Активных сессий: ${userSessions.size}
⏳ В очереди: ${processingQueue.size}
🗂 Кэш: ${cache.size} записей
🎯 Эффективность кэша: ${analytics.getCacheEfficiency()}%
📈 Конверсия: ${analytics.getConversionRate()}%
🕐 Аптайм: ${Math.floor(process.uptime() / 60)} минут
  `;

    ctx.reply(statsMsg, { parse_mode: "Markdown" });
  } catch (error) {
    console.error("Error in stats command:", error);
    ctx.reply("Ошибка при получении статистики.");
  }
});

// --- КОМАНДА ПОПУЛЯРНЫХ ЗАПРОСОВ (ТОЛЬКО ДЛЯ АДМИНА) ---
bot.command("popular", (ctx) => {
  try {
    if (!isAdmin(ctx.from.id)) return;

    const stats = popularRequests.getStats();
    let message = "📈 *Популярные запросы:*\n\n";
    
    message += "*Топ сур:*\n";
    stats.topSurahs.forEach(([surahId, count], index) => {
      const surah = surahs[surahId - 1];
      message += `${index + 1}. ${surahId} - ${surah?.name_ru || 'Unknown'}: ${count} запросов\n`;
    });
    
    message += `\n*Типы запросов:*\n`;
    message += `Одиночные аяты: ${stats.rangeStats.single || 0}\n`;
    message += `Несколько аятов: ${stats.rangeStats.multiple || 0}`;

    ctx.reply(message, { parse_mode: "Markdown" });
  } catch (error) {
    console.error("Error in popular command:", error);
    ctx.reply("Ошибка при получении статистики популярных запросов.");
  }
});

// --- КОМАНДА ПЕРЕЗАГРУЗКИ КОНФИГУРАЦИИ (ТОЛЬКО ДЛЯ АДМИНА) ---
bot.command("reload_config", (ctx) => {
  try {
    if (!isAdmin(ctx.from.id)) {
      return ctx.reply("❌ Эта команда доступна только администратору.");
    }

    configManager.reloadFromEnv();
    ctx.reply("✅ Конфигурация перезагружена из переменных окружения.");
  } catch (error) {
    console.error("Error in reload_config command:", error);
    ctx.reply("❌ Ошибка при перезагрузке конфигурации.");
  }
});

// --- КОМАНДА ДЛЯ СБРОСА ВСЕХ ДАННЫХ (ТОЛЬКО ДЛЯ АДМИНА) ---
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
    console.error("Error in clear_all command:", error);
    ctx.reply("Ошибка при сбросе данных.");
  }
});

// --- КОМАНДА ДЛЯ ПРОСМОТРА СПИСКА АУДИО (ТОЛЬКО ДЛЯ АДМИНА) ---
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
    console.error("Error in list_audio command:", error);
    ctx.reply("Ошибка при получении списка аудио.");
  }
});

// --- КОМАНДА ДЛЯ УДАЛЕНИЯ ЗАПИСИ ПО ИНДЕКСУ (ТОЛЬКО ДЛЯ АДМИНА) ---
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
    console.error("Error in delete_audio command:", error);
    ctx.reply("Ошибка при удалении аудио.");
  }
});

// --- ОБРАБОТКА ТЕКСТА С ОЧЕРЕДЬЮ ---
bot.on("text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) {
    return;
  }

  try {
    await addToQueue(ctx.from.id, async () => {
      try {
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
            return ctx.reply(
              `Выбрана сура ${newText}. Отправьте номера аятов.`
            );
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

        // Обновляем статистику популярных запросов
        popularRequests.update(userData.track, ayahs);

        const tempMsg = await ctx.reply("Обработка аудио...");

        // Показываем прогресс
        await showProgress(ctx, tempMsg.message_id, 10);

        const settings = { ayahs, surah: parseInt(userData.track) };
        
        // Используем систему ретраев
        const outputAudio = await retryWithBackoff(
          () => mp3create(settings),
          3,
          1000
        );
        
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
      } catch (error) {
        console.error("Error in text handler task:", error);
        analytics.trackEvent(ctx.from.id, 'audio_creation_failed', { error: error.message });
        throw error;
      }
    });
  } catch (err) {
    if (err.message.includes("Ваш предыдущий запрос")) {
      return ctx.reply(err.message);
    }
    logger.error(`Text handler error: ${err.message}`);
    ctx.reply(messageTemplates.error("processing"));
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
    
    analytics.trackEvent(ctx.from.id, 'color_selected', { color: colorAction });
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
    
    analytics.trackEvent(ctx.from.id, 'audio_sent_to_channel', {
      surah: userData.track,
      ayahs: userData.text,
      color: userData.color
    });
  } catch (err) {
    logger.error(`Send audio error: ${err.message}`);
    ctx.reply("Ошибка при отправке аудио.");
  }
});

// Обработчик для кнопки "show_translate"
bot.action("show_translate", async (ctx) => {
  try {
    const userData = getUserData(ctx.from.id);
    const surah = Number(userData.track);
    const ayah = Number(userData.text);

    await showTranslation(ctx, surah, ayah);
    analytics.trackEvent(ctx.from.id, 'translation_viewed', { surah, ayah });
  } catch (error) {
    console.error("Error in show_translate action:", error);
    ctx.reply("Ошибка при показе перевода.");
  }
});

// Обработчик для следующего аята
bot.action("next_ayah", async (ctx) => {
  try {
    const userData = getUserData(ctx.from.id);
    userData.text = Number(userData.text) + 1;

    if (userData.text > 1) {
      await showTranslation(ctx, userData.track, userData.text);
      analytics.trackEvent(ctx.from.id, 'next_ayah_navigation', {
        surah: userData.track,
        ayah: userData.text
      });
    } else {
      await ctx.answerCbQuery("❌ Это первый аят суры");
    }
  } catch (error) {
    console.error("Error in next_ayah action:", error);
    ctx.reply("Ошибка при переходе к следующему аяту.");
  }
});

// Обработчик для предыдущего аята
bot.action("prev_ayah", async (ctx) => {
  try {
    const userData = getUserData(ctx.from.id);
    userData.text = Number(userData.text) - 1;

    if (userData.text > 1) {
      await showTranslation(ctx, userData.track, userData.text);
      analytics.trackEvent(ctx.from.id, 'prev_ayah_navigation', {
        surah: userData.track,
        ayah: userData.text
      });
    } else {
      await ctx.answerCbQuery("❌ Это первый аят суры");
    }
  } catch (error) {
    console.error("Error in prev_ayah action:", error);
    ctx.reply("Ошибка при переходе к предыдущему аяту.");
  }
});

bot.action("show_tafsir", async (ctx) => {
  try {
    await showTafsir(ctx);
    const userData = getUserData(ctx.from.id);
    analytics.trackEvent(ctx.from.id, 'tafsir_viewed', {
      surah: userData.track,
      ayah: userData.text
    });
  } catch (error) {
    console.error("Error in show_tafsir action:", error);
    ctx.reply("Ошибка при показе тафсира.");
  }
});

bot.action("show_tafsir_reply", async (ctx) => {
  try {
    await showTafsir(ctx, true);
    const userData = getUserData(ctx.from.id);
    analytics.trackEvent(ctx.from.id, 'tafsir_viewed_from_translation', {
      surah: userData.track,
      ayah: userData.text
    });
  } catch (error) {
    console.error("Error in show_tafsir_reply action:", error);
    ctx.reply("Ошибка при показе тафсира.");
  }
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
    
    analytics.trackEvent(ctx.from.id, 'tafsir_pagination', {
      page: userData.currentTafsirPage + 1,
      total: userData.tafsirParts.length
    });
  } catch (err) {
    console.error(err);
    await ctx.answerCbQuery("❌ Ошибка при загрузке тафсира.");
  }
});

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
    analytics.trackEvent(ctx.from.id, 'audio_cancelled');
  } catch (error) {
    console.error("Error in cancel_audio action:", error);
    ctx.reply("Ошибка при отмене отправки.");
  }
});

// --- ОЧИСТКА СТАРЫХ СЕССИЙ И ПАМЯТИ ---
try {
  setInterval(() => {
    try {
      const now = Date.now();
      const MAX_SESSION_AGE = config.sessionTimeout;

      for (const [userId, data] of userSessions.entries()) {
        if (now - (data.lastActivity || 0) > MAX_SESSION_AGE) {
          userSessions.delete(userId);
        }
      }

      // Очистка старых лимитов
      for (const [userId, limits] of userLimits.entries()) {
        const now = Date.now();
        limits.minute = limits.minute.filter(time => now - time < 60000);
        limits.hour = limits.hour.filter(time => now - time < 3600000);
        
        if (limits.minute.length === 0 && limits.hour.length === 0) {
          userLimits.delete(userId);
        }
      }
    } catch (error) {
      console.error("Error in session cleanup:", error);
    }
  }, 30 * 60 * 1000);
} catch (error) {
  console.error("Error setting up session cleanup interval:", error);
}

// Запуск очистки памяти
setInterval(() => memoryManager.cleanup(), config.memoryCleanupInterval);

// Инициализация A/B тестов
abTesting.createExperiment('button_layout', ['old', 'new'], [0.5, 0.5]);

// --- ЗАПУСК БОТА ---
try {
  bot
    .launch()
    .then(() => {
      logger.info("Бот успешно запущен!");
      monitorSystem.start();
      recoveryManager.recoverFromCrash();
      logger.info("Все системы мониторинга и восстановления запущены");
      
      // Логирование информации о системе
      logger.info("System initialized", {
        featureFlags,
        config: {
          maxAyahs: config.maxAyahs,
          userLimits: config.userLimits,
          cacheTtl: config.cacheTtl
        }
      });
    })
    .catch((err) => {
      logger.error(`Bot launch error: ${err.message}`);
      sendAlert(`Ошибка запуска бота: ${err.message}`, "CRITICAL");
    });
} catch (error) {
  console.error("Error launching bot:", error);
  sendAlert(`Критическая ошибка при запуске: ${error.message}`, "CRITICAL");
}

process.once("SIGINT", () => {
  try {
    logger.info("Received SIGINT, shutting down gracefully");
    bot.stop("SIGINT");
  } catch (error) {
    console.error("Error during SIGINT handling:", error);
  }
});

process.once("SIGTERM", () => {
  try {
    logger.info("Received SIGTERM, shutting down gracefully");
    bot.stop("SIGTERM");
  } catch (error) {
    console.error("Error during SIGTERM handling:", error);
  }
});
