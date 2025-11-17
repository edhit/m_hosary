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
const { getTafsir } = require("./tafsir");
const { button } = require("telegraf/markup");
const { getKulievTranslation } = require("./translate");

// Настройка ffmpeg
ffmpeg.setFfmpegPath(ffmpegPath);

// Константы
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL;
const TEMP_FOLDER = path.resolve("./temp");
const DATA_FILE = path.resolve("./audio_data.json");
const ADMIN_USER_ID = process.env.ALLOWED_USER_ID; // Переименовано для ясности

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

// Создание временной папки
if (!fs.existsSync(TEMP_FOLDER)) fs.mkdirSync(TEMP_FOLDER);

// Глобальные данные (теперь для каждого пользователя отдельно)
const userSessions = new Map();

// Убираем глобальные переменные
// let tafsirParts = [];
// let currentTafsirPage = 0;

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
      tafsirParts: [], // Добавляем для тафсира
      currentTafsirPage: 0, // Добавляем для тафсира
      button: null,
    });
  }
  return userSessions.get(userId);
}

// Форматирование нумерованного текста
function formatNumberedText(text) {
  // Разделяем текст по цифрам с точками
  const parts = text.split(/(\d+\.)\s*/);

  let formattedText = "";
  let currentNumber = "";

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim();

    // Если часть - это номер (например "1.")
    if (part.match(/^\d+\.$/)) {
      currentNumber = part;
    }
    // Если часть - это текст после номера
    else if (currentNumber && part) {
      formattedText += `${currentNumber} ${part}\n\n`;
      currentNumber = "";
    }
    // Если часть - обычный текст без номера
    else if (part) {
      formattedText += part + " ";
    }
  }

  return formattedText.trim();
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
  fs.readdirSync(TEMP_FOLDER).forEach((file) =>
    fs.unlinkSync(path.join(TEMP_FOLDER, file))
  );
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

// --- MIDDLEWARE ДЛЯ ЛОГИРОВАНИЯ ---
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "без username";
  const firstName = ctx.from?.first_name || "без имени";

  logger.info(
    `Пользователь ${userId} (@${username}, ${firstName}) вызвал команду: ${
      ctx.message?.text || "callback"
    }`
  );
  await next();
});

// --- ФУНКЦИЯ ПРОВЕРКИ АДМИНА ---
function isAdmin(userId) {
  return ADMIN_USER_ID && userId.toString() === ADMIN_USER_ID;
}


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
    // Ждём запись тегов
    await writeID3(tags, outputAudioPath);

    userData.audioPath = outputAudioPath;

    // Безопасное удаление сообщения
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

    return true;
  } catch (err) {
    console.error("metaTags error:", err);
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

    // Загружаем текст
    const tafsir = formatNumberedText(await getTafsir(surah, ayah));

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

    // Проверяем, что тафсир успешно разбит на части
    if (!userData.tafsirParts || userData.tafsirParts.length === 0) {
      await ctx.answerCbQuery("❌ Ошибка при обработке тафсира.");
      return await ctx.editMessageText("⚠️ Ошибка при обработке тафсира.");
    }

    // Формируем клавиатуру (если больше одной части)
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
        resize_keyboard: true
      }
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
${
  isAdmin(ctx.from.id)
    ? `

<b>Команды администратора:</b>
<b>/clear_all</b> — Сбросить все текущие данные и очистить временные файлы.
<b>/list_audio</b> — Показать список последних 10 аудиофайлов.
<b>/delete_audio &lt;номер&gt;</b> — Удалить аудиозапись по номеру из списка.
<b>/colors</b> — Показать значение цветов.
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

bot.command("surah", (ctx) => {
  const userData = getUserData(ctx.from.id);
  const newTrack = ctx.message.text.replace("/surah", "").trim();

  // Проверка: число ли это
  if (!newTrack || isNaN(newTrack)) {
    return ctx.reply("Укажите номер суры, например: /surah 5");
  }

  const surahNum = Number(newTrack);

  // Проверка диапазона
  if (surahNum < 1 || surahNum > 114) {
    return ctx.reply("Номер суры должен быть от 1 до 114");
  }

  // Всё ок
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

  // Находим реальный индекс в полном массиве
  const realIdx = data.length - last10.length + idx;
  data.splice(realIdx, 1);

  if (setAudioData(data)) {
    ctx.reply(`Запись №${idx + 1} из последних 10 удалена.`);
  } else {
    ctx.reply("Ошибка при удалении записи.");
  }
});

// --- ОБРАБОТКА ТЕКСТА ---
bot.on("text", async (ctx) => {
  // Пропускаем команды
  if (ctx.message.text.startsWith("/")) {
    return;
  }

  try {
    const userData = getUserData(ctx.from.id);
    // Сбрасываем данные тафсира для этого пользователя
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

    const tempMsg = await ctx.reply("Обработка аудио...");

    const settings = { ayahs, surah: parseInt(userData.track) };
    const outputAudio = await mp3create(settings);
    const outputAudioPath = path.join(outputAudio.folder, outputAudio.file);

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
  } catch (err) {
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

    // Проверка всех необходимых данных
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
          : { reply_markup: { inline_keyboard: [] } }), // Пустая клавиатура для обычных пользователей
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
      user_id: ctx.from.id, // Сохраняем ID пользователя
      username: ctx.from.username || "unknown",
    });

    fs.writeFileSync(DATA_FILE, JSON.stringify(allData, null, 2), "utf-8");
    ctx.reply("Аудиофайл отправлен и сохранён.");
    clearTempFolder();

    // Сбрасываем только данные этого пользователя
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

bot.action("show_translate", async (ctx) => {
  try {
    await ctx.answerCbQuery("Загружаю перевод...");

    const userData = getUserData(ctx.from.id);

    const surah = Number(userData.track);
    const ayah = Number(userData.text);
    const surahInfo = surahs[surah - 1] || {};

    if (!surah || !ayah) {
      return ctx.editMessageText("⚠️ Не удалось определить суру и аят.");
    }

    // Загружаем перевод Кулиева
    let translation;
    try {
      translation = await getKulievTranslation(surah, ayah);
    } catch (e) {
      console.error("Ошибка getKulievTranslation:", e);
      return ctx.editMessageText("⚠️ Ошибка загрузки перевода.");
    }

    // Лимит в 2000 символов
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

    // ❗ Добавляем кнопку Показать тафсир
    const keyboard = {
      inline_keyboard: [
        [{ text: "📘 Перейти к тафсиру", callback_data: "show_tafsir_reply" }],
      ],
    };

    await ctx.editMessageText(message, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
  } catch (err) {
    console.error(err);
    await ctx.answerCbQuery("❌ Ошибка.");
    await ctx.reply("Ошибка при загрузке перевода. Попробуйте позже.");
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

    // Проверяем, есть ли данные тафсира
    if (!userData.tafsirParts || userData.tafsirParts.length === 0) {
      await ctx.answerCbQuery("❌ Данные тафсира не найдены. Начните заново.");
      return;
    }

    // Проверяем, существует ли следующая страница
    if (userData.currentTafsirPage >= userData.tafsirParts.length - 1) {
      await ctx.answerCbQuery("❌ Это последняя страница тафсира.");
      return;
    }

    // 1️⃣ Удаляем клавиатуру у старого сообщения
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

    // Проверяем, что текст существует
    const currentTafsirText = userData.tafsirParts[userData.currentTafsirPage];
    if (!currentTafsirText) {
      await ctx.answerCbQuery("❌ Ошибка: текст тафсира не найден.");
      return;
    }

    const message = `
..._${currentTafsirText}_

Страница: *${userData.currentTafsirPage + 1}/${userData.tafsirParts.length}*
`;

    // 2️⃣ Новую часть отправляем через ctx.reply
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
    // track: "" // Оставляем выбранную суру для удобства
  });
});

// --- ОЧИСТКА СТАРЫХ СЕССИЙ (ОПЦИОНАЛЬНО) ---
setInterval(() => {
  const now = Date.now();
  const MAX_SESSION_AGE = 60 * 60 * 1000; // 1 час

  for (const [userId, data] of userSessions.entries()) {
    // Если у данных есть timestamp, можно добавить проверку на возраст
    // Пока просто оставляем очистку на будущее
  }
}, 30 * 60 * 1000); // Проверка каждые 30 минут

// --- ЗАПУСК БОТА ---
bot
  .launch()
  .then(() => logger.info("Бот успешно запущен!"))
  .catch((err) => logger.error(`Bot launch error: ${err.message}`));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
