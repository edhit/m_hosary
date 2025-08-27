require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const path = require("path");
const fs = require("fs");

const logger = require("./utils/logger");
const { clearTempFolder } = require("./utils/fileUtils");

const authMiddleware = require("./src/middlewares/authMiddleware");

const setupSurahCommand = require("./src/commands/surahCommand");
const setupClearAllCommand = require("./src/commands/clearAllCommand");
const setupTextHandler = require("./src/handlers/textHandler");
const setupMakeVideoHandler = require("./src/handlers/makeVideoHandler");

const setupUploadPhotoHandler = require("./src/handlers/uploadPhotoHandler");

// Константы
const BOT_TOKEN = process.env.BOT_TOKEN;
const TEMP_FOLDER = path.resolve("./temp");
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID;

// Глобальные данные
const currentData = {
  track: "",
  text: "",
  artist: "Mahmoud Al-Hosary",
  audioPath: "",
  photoPath: "",
  message: "",
  ayahs: "",
  quran: "",
};

// Инициализация бота
const bot = new Telegraf(BOT_TOKEN);

// Создание временной папки
if (!fs.existsSync(TEMP_FOLDER)) fs.mkdirSync(TEMP_FOLDER);

// --- MIDDLEWARE ---
bot.use(authMiddleware(ALLOWED_USER_ID));

// --- ОБРАБОТЧИКИ ---
setupClearAllCommand(bot, currentData, clearTempFolder, logger);
setupSurahCommand(bot, currentData, clearTempFolder); // 1
setupTextHandler(bot, currentData, logger); // 2

setupMakeVideoHandler(bot, currentData, logger); // 3

setupUploadPhotoHandler(bot, currentData, logger);

// --- ЗАПУСК БОТА ---

bot
  .launch()
  .then(() => logger.info("Бот успешно запущен!"))
  .catch((err) => logger.error(`Bot launch error: ${err.message}`));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
