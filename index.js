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

// Настройка ffmpeg
ffmpeg.setFfmpegPath(ffmpegPath);

// Константы
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL;
const TEMP_FOLDER = path.resolve("./temp");
const DATA_FILE = path.resolve("./audio_data.json");
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID;


// Глобальное хранилище частей
let tafsirParts = [];
let currentTafsirPage = 0;

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

// Глобальные данные
const currentData = {
  track: "",
  text: "",
  artist: "Mahmoud Al-Hosary",
  color: "",
  audioPath: "",
  message: "",
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

// ...existing code...

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

// --- УТИЛИТА ДЛЯ ДОБАВЛЕНИЯ МЕТАДАННЫХ ---
async function metaTags(tags, outputAudioPath, tempMsg, ctx) {
  NodeID3.write(tags, outputAudioPath, async (err) => {
    if (err) {
      return false;
    }

    currentData.audioPath = outputAudioPath;
    await ctx.deleteMessage(tempMsg.message_id);

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
        // Кнопка тафсира — добавляем только если один аят
        ...(currentData.text && /^\d+$/.test(currentData.text.trim())
          ? [[Markup.button.callback("📖 Показать тафсир", "show_tafsir")]]
          : []),
      ])
    );
  });
}

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
bot.start((ctx) => {
  ctx.reply(
    "Добро пожаловать!\n\nИспользуйте /surah <номер> для выбора суры и отправьте номера аятов для создания аудио.\n\nИспользуйте /help для получения справки."
  );
});

// --- КОМАНДА ПОМОЩИ ---
bot.command("help", (ctx) => {
  const helpMsg = `
<b>Возможности бота:</b>

<b>/start</b> — Приветствие и краткая инструкция.
<b>/help</b> — Показать это справочное сообщение.
<b>/surah &lt;номер&gt;</b> — Указать номер суры для создания аудио (например: /surah 5).
<b>/clear_all</b> — Сбросить все текущие данные и очистить временные файлы.
<b>/list_audio</b> — Показать список последних 10 аудиофайлов.
<b>/delete_audio &lt;номер&gt;</b> — Удалить аудиозапись по номеру из списка (/list_audio).

<b>Создание аудио:</b>
1. Укажите суру командой <b>/surah &lt;номер&gt;</b>.
2. Отправьте номера аятов (например: 1-5, 7, 10).
3. Следуйте инструкциям для выбора цвета и отправки аудио.

<b>Примечание:</b>
Доступ к функциям бота ограничен для определённого пользователя.
  `;
  ctx.reply(helpMsg, { parse_mode: "HTML" });
});

bot.command("surah", (ctx) => {
  const newTrack = ctx.message.text.replace("/surah", "").trim();
  if (newTrack && !isNaN(newTrack)) {
    currentData.track = newTrack;
    ctx.reply(`Сура обновлена: ${newTrack}`);
  } else {
    ctx.reply("Пожалуйста, укажите номер суры, например: /surah 5", {
      parse_mode: "Markdown",
    });
  }
});

bot.command("clear_all", (ctx) => {
  Object.assign(currentData, {
    track: "",
    text: "",
    color: "",
    audioPath: "",
    message: "",
  });
  clearTempFolder();
  ctx.reply("Данные сброшены.");
});

// --- КОМАНДА ДЛЯ ПРОСМОТРА СПИСКА АУДИО ---
bot.command("list_audio", (ctx) => {
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

// --- КОМАНДА ДЛЯ УДАЛЕНИЯ ЗАПИСИ ПО ИНДЕКСУ (из последних 10) ---
bot.command("delete_audio", (ctx) => {
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
  try {
    tafsirParts = [];
    
    const newText = ctx.message.text.trim();
    currentData.text = newText;

    if (!currentData.track || !currentData.text) {
      return ctx.reply(
        "Пожалуйста, укажите номер суры (/surah) и номера аятов (отправьте текст)."
      );
    }

    const ayahs = parsePageRanges(currentData.text);
    if (!ayahs || ayahs.includes(0))
      return ctx.reply("Некорректно указаны номера аятов.");

    const tempMsg = await ctx.reply("Обработка аудио...");

    const settings = { ayahs, surah: parseInt(currentData.track) };
    const outputAudio = await mp3create(settings);
    const outputAudioPath = path.join(outputAudio.folder, outputAudio.file);

    const tags = {
      title: `Surah ${currentData.track} ${
        surahs[Number(currentData.track) - 1]?.name_en || "Unknown"
      } (${currentData.text})`,
      artist: currentData.artist,
      year: new Date().getFullYear(),
    };

    let i = 0;
    while (i < 3) {
      if ((await metaTags(tags, outputAudioPath, tempMsg, ctx)) !== false)
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
    const colorAction = ctx.match[1];
    currentData.color = colorAction;

    // Проверка всех необходимых данных
    if (
      !currentData.audioPath ||
      !currentData.track ||
      !currentData.text ||
      !currentData.artist
    ) {
      return ctx.reply(
        "Недостаточно данных для отправки аудио. Пожалуйста, начните заново."
      );
    }

    const surahInfo = surahs[Number(currentData.track) - 1] || {};
    currentData.message = `${colorAction} Сура ${currentData.track} «${
      surahInfo.name_en
    } (${surahInfo.name_ru}), ${
      currentData.text.includes("-") ? "аяты" : "аят"
    } ${currentData.text}» - Махмуд Аль-Хусари\n\n#коран ${toHashtag(
      surahInfo.name_en
    )}`;

    await ctx.replyWithAudio(
      {
        source: currentData.audioPath,
        filename: `${currentData.artist} - ${surahInfo.name_en} - ${currentData.text}.mp3`,
      },
      {
        caption: currentData.message,
        ...Markup.inlineKeyboard([
          Markup.button.callback("✅ Отправить", "send_audio"),
          Markup.button.callback("❌ Отмена", "cancel_audio"),
        ]),
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
    if (!currentData.audioPath) return ctx.reply("Аудиофайл не найден.");

    const sentAudio = await bot.telegram.sendAudio(
      CHANNEL_ID || ctx.chat.id,
      {
        source: currentData.audioPath,
        filename: path.basename(currentData.audioPath),
      },
      { caption: currentData.message }
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
      color: currentData.color,
      surah: currentData.track,
      ayahs: parsePageRanges(currentData.text),
      file_id,
      timestamp: new Date().toISOString(),
    });

    fs.writeFileSync(DATA_FILE, JSON.stringify(allData, null, 2), "utf-8");
    ctx.reply("Аудиофайл отправлен и сохранён.");
    clearTempFolder();
    Object.assign(currentData, {
      // track: "",
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



bot.action("show_tafsir", async (ctx) => {
  try {
    await ctx.answerCbQuery("Загружаю тафсир...");

    const surah = parseInt(currentData.track);
    const ayah = parseInt(currentData.text);
    const surahInfo = surahs[Number(currentData.track) - 1] || {};

    // Сбрасываем старые данные каждый раз при открытии
    tafsirParts = [];
    currentTafsirPage = 0;

    // Загружаем текст
    const tafsir = await getTafsir(surah, ayah);

    if (!tafsir) {
      return await ctx.editMessageText("⚠️ Тафсир не найден.");
    }

    // Разбивка по словам
    const words = tafsir.split(" ");
    const maxLength = 1024;
    let current = "";

    for (const word of words) {
      if ((current + " " + word).length > maxLength) {
        tafsirParts.push(current.trim() + "...");
        current = word;
      } else {
        current += " " + word;
      }
    }
    if (current.trim()) tafsirParts.push(current.trim());

    // Формируем клавиатуру (если больше одной части)
    const keyboard = tafsirParts.length > 1
      ? {
          inline_keyboard: [
            [{ text: "Показать ещё", callback_data: "tafsir_next" }]
          ]
        }
      : undefined;

    const message = `
📖 *Тафсир ас-Са’ди*
━━━━━━━━━━━━━━━
🕋 *Сура:* ${surah} ${surahInfo.name_ru}
🔹 *Аят:* ${ayah}

💬 *Толкование:*
_${tafsirParts[0]}_
`;

    await ctx.editMessageText(message, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });

  } catch (err) {
    console.error(err);
    await ctx.reply("Ошибка при загрузке. Попробуйте позже.");
  }
});

// ===========================
//  Показать следующую часть
// ===========================
bot.action("tafsir_next", async (ctx) => {
  try {
    await ctx.answerCbQuery();

    currentTafsirPage++;

    // Если частей больше нет — убираем кнопку
    const keyboard = currentTafsirPage < tafsirParts.length - 1
      ? {
          inline_keyboard: [
            [{ text: "Показать ещё", callback_data: "tafsir_next" }]
          ]
        }
      : undefined;

    const surah = parseInt(currentData.track);
    const ayah = parseInt(currentData.text);
    const surahInfo = surahs[Number(currentData.track) - 1] || {};

    const message = `
📖 *Тафсир ас-Са’ди*
━━━━━━━━━━━━━━━
🕋 *Сура:* ${surah} ${surahInfo.name_ru}
🔹 *Аят:* ${ayah}

💬 *Продолжение:*
_${tafsirParts[currentTafsirPage]}_

━━━━━━━━━━━━━━━
Страница: *${currentTafsirPage + 1}/${tafsirParts.length}*
`;

    await ctx.editMessageText(message, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });

  } catch (err) {
    console.error(err);
    await ctx.answerCbQuery("Ошибка.");
  }
});

bot.action("cancel_audio", async (ctx) => {
  await ctx.deleteMessage();
  ctx.reply("Отправка отменена.");
  clearTempFolder();
  Object.assign(currentData, { audioPath: "", color: "", text: "", track: "" });
});

// ...existing code...

// --- ЗАПУСК БОТА ---
bot
  .launch()
  .then(() => logger.info("Бот успешно запущен!"))
  .catch((err) => logger.error(`Bot launch error: ${err.message}`));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
