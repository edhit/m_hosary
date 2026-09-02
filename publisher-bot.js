require("dotenv").config();

// ================================================================
// publisher-bot.js  —  БОТ-ПУБЛИКАТОР
//
// Идея: команды принимает ЭТОТ бот (свой токен, BOT2_TOKEN),
// а склеенное аудио заливается и публикуется в канал ТОКЕНОМ
// основного бота @mmmm_hosary_bot.
//
// Почему так: file_id в Telegram привязан к конкретному боту.
// Если файл загрузит бот №2, то @mmmm_hosary_bot не сможет
// использовать полученный file_id (ошибка "wrong file identifier").
// Поэтому все sendAudio идут через экземпляр `hosary` ниже.
//
// Порядок работы:
//   1. админ пишет:  /publish 5 57-58   (или просто "5 57-58")
//   2. mp3create склеивает аяты в один mp3
//   3. токеном бота №1 файл заливается в DRAFT_CHAT_ID (черновик)
//      -> получаем file_id, валидный для @mmmm_hosary_bot
//   4. админ выбирает цвет и подтверждает
//   5. токеном бота №1 этот же file_id отправляется в канал
//      (повторной заливки нет — Telegram переиспользует файл)
//   6. запись добавляется в audio_data.json через файловый лок
// ================================================================

const path = require("path");
const fs = require("fs");
const { Telegraf, Telegram, Markup } = require("telegraf");
const NodeID3 = require("node-id3");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");

const surahs = require("./quran.json");
const { mp3create } = require("./mp3create");
const audioStore = require("./audio-store");

// ================================================================
// КОНФИГУРАЦИЯ
// ================================================================
const BOT2_TOKEN = process.env.BOT2_TOKEN;
const HOSARY_BOT_TOKEN = process.env.HOSARY_BOT_TOKEN || process.env.BOT_TOKEN;
const HOSARY_BOT_USERNAME =
  process.env.HOSARY_BOT_USERNAME || "mmmm_hosary_bot";

const CHANNEL_ID = process.env.CHANNEL; // @m_al_hosary
const GROUP_ID = process.env.GROUP;
const ADMIN_USER_ID = process.env.ALLOWED_USER_ID;

// Куда бот №1 заливает черновик, чтобы получить file_id.
// По умолчанию — личка первого админа с @mmmm_hosary_bot.
const DRAFT_CHAT_ID =
  process.env.DRAFT_CHAT_ID || (ADMIN_USER_ID || "").split(",")[0].trim();

const TEMP_FOLDER = process.env.TEMP_FOLDER || path.resolve("./temp");
const ARTIST = process.env.ARTIST || "Mahmoud Al-Hosary";
const ARTIST_RU = process.env.ARTIST_RU || "Махмуд Аль-Хусари";
const MAX_AYAHS = parseInt(process.env.MAX_AYAHS_PER_REQUEST) || 50;

if (!BOT2_TOKEN) throw new Error("Не задан BOT2_TOKEN");
if (!HOSARY_BOT_TOKEN)
  throw new Error("Не задан HOSARY_BOT_TOKEN (токен @mmmm_hosary_bot)");
if (!CHANNEL_ID) throw new Error("Не задан CHANNEL");
if (!DRAFT_CHAT_ID) throw new Error("Не задан DRAFT_CHAT_ID");

const bot = new Telegraf(BOT2_TOKEN);

// Экземпляр API основного бота. Только для отправки аудио —
// апдейты он не получает, launch() для него не вызывается.
const hosary = new Telegram(HOSARY_BOT_TOKEN);

try {
  ffmpeg.setFfmpegPath(ffmpegPath);
} catch (err) {
  console.error("ffmpeg path error:", err.message);
}

if (!fs.existsSync(TEMP_FOLDER)) fs.mkdirSync(TEMP_FOLDER, { recursive: true });

const log = {
  info: (...a) => console.log(new Date().toISOString(), "INFO ", ...a),
  warn: (...a) => console.warn(new Date().toISOString(), "WARN ", ...a),
  error: (...a) => console.error(new Date().toISOString(), "ERROR", ...a),
};

const COLORS = ["🔵", "🟢", "🔴", "🟡", "🟣", "🟠", "🟥"];

// ================================================================
// СЕССИИ (черновики публикаций, по одному на админа)
// ================================================================
const drafts = new Map(); // userId -> { surah, ayahs, rawText, filePath, fileId, color, caption }

function getDraft(userId) {
  return drafts.get(userId);
}

function setDraft(userId, draft) {
  drafts.set(userId, { ...draft, createdAt: Date.now() });
  return drafts.get(userId);
}

function dropDraft(userId) {
  const d = drafts.get(userId);
  if (d?.filePath) safeUnlink(d.filePath);
  drafts.delete(userId);
}

function safeUnlink(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    log.warn("Не удалось удалить файл:", filePath, err.message);
  }
}

// Черновики старше часа — мусор.
setInterval(
  () => {
    const now = Date.now();
    for (const [userId, d] of drafts.entries()) {
      if (now - d.createdAt > 60 * 60 * 1000) dropDraft(userId);
    }
  },
  15 * 60 * 1000,
);

// ================================================================
// УТИЛИТЫ
// ================================================================
function isAdmin(userId) {
  if (!ADMIN_USER_ID) return false;
  return ADMIN_USER_ID.split(",")
    .map((id) => id.trim())
    .includes(userId?.toString());
}

function adminOnly(ctx, next) {
  if (isAdmin(ctx.from?.id)) return next();
  log.warn(`Отказ в доступе: ${ctx.from?.id} (@${ctx.from?.username})`);
  return ctx.reply("❌ Бот доступен только администратору.");
}

// Тот же формат, что в основном боте: "1-10,15,20-25"
function parsePageRanges(input) {
  try {
    if (!input || typeof input !== "string") return [];
    const pages = new Set();

    for (const part of input.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      if (trimmed.includes("-")) {
        const [a, b] = trimmed.split("-").map((s) => s.trim());
        const start = parseInt(a, 10);
        const end = parseInt(b, 10);
        if (isNaN(start) || isNaN(end) || start > end) return false;
        for (let i = start; i <= end; i++) pages.add(i);
      } else {
        const page = parseInt(trimmed, 10);
        if (isNaN(page)) return false;
        pages.add(page);
      }
    }
    return Array.from(pages).sort((a, b) => a - b);
  } catch (err) {
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
  } catch (err) {
    return "#error";
  }
}

function shareLink(surah, ayah) {
  return `https://t.me/${HOSARY_BOT_USERNAME}?start=s${surah}_a${ayah}`;
}

function buildCaption(color, surah, rawText) {
  const info = surahs[surah - 1] || {};
  return (
    `${color} Сура ${surah} «${info.name_en} (${info.name_ru}), аят ${rawText}» - ${ARTIST}\n\n` +
    `#коран ${toHashtag(info.name_en || "")}`
  );
}

function writeID3(tags, filePath) {
  return new Promise((resolve, reject) => {
    NodeID3.write(tags, filePath, (err) => (err ? reject(err) : resolve()));
  });
}

// ================================================================
// СБОРКА ЧЕРНОВИКА
// ================================================================
async function buildDraft(ctx, surah, rawText) {
  const surahInfo = surahs.find((s) => s.number === surah);
  if (!surahInfo) return ctx.reply(`Сура ${surah} не найдена.`);

  const ayahs = parsePageRanges(rawText);
  if (!ayahs || ayahs.length === 0) {
    return ctx.reply(
      "Не понял номера аятов. Примеры: <code>5 57-58</code>, <code>2 1,2,3</code>",
      { parse_mode: "HTML" },
    );
  }

  const invalid = ayahs.filter((a) => a <= 0 || a > surahInfo.ayahs);
  if (invalid.length) {
    return ctx.reply(
      `В суре ${surah} (${surahInfo.name_ru}) всего ${surahInfo.ayahs} аятов.\n` +
        `Некорректные: ${invalid.join(", ")}`,
    );
  }

  if (ayahs.length > MAX_AYAHS) {
    return ctx.reply(`Максимум аятов за раз: ${MAX_AYAHS}`);
  }

  // Старый черновик больше не нужен.
  dropDraft(ctx.from.id);

  const status = await ctx.reply("⏳ Склеиваю аяты...");
  const edit = (text) =>
    ctx.telegram
      .editMessageText(ctx.chat.id, status.message_id, null, text)
      .catch(() => {});

  let filePath;
  try {
    const out = await mp3create({ surah, ayahs });
    filePath = path.join(out.folder, out.file);

    await writeID3(
      {
        title: `Surah ${surah} ${surahInfo.name_en || ""} (${rawText})`,
        artist: ARTIST,
        year: new Date().getFullYear(),
      },
      filePath,
    );

    const sizeMb = (fs.statSync(filePath).size / 1024 / 1024).toFixed(2);
    await edit(`⏳ Готово (${sizeMb} MB). Загружаю в Telegram...`);

    // КЛЮЧЕВОЙ ШАГ: заливаем токеном ОСНОВНОГО бота,
    // иначе file_id окажется чужим и непригодным.
    const draftMsg = await hosary.sendAudio(
      DRAFT_CHAT_ID,
      { source: filePath },
      {
        filename: `M. Al-Hosary - ${surahInfo.name_en} - ${rawText}.mp3`,
        caption: `🧪 Черновик: сура ${surah}, аяты ${rawText}`,
        performer: ARTIST,
      },
    );

    const fileId = draftMsg.audio.file_id;

    setDraft(ctx.from.id, {
      surah,
      ayahs,
      rawText,
      filePath,
      fileId,
      draftMessageId: draftMsg.message_id,
      color: null,
    });

    await edit(
      `✅ Аудио готово и залито (${sizeMb} MB).\n` +
        `Сура ${surah} «${surahInfo.name_ru}», аяты: ${rawText}\n\n` +
        `Черновик отправлен в чат ${DRAFT_CHAT_ID} основным ботом — послушайте его там.`,
    );

    await ctx.reply("Выберите цвет для публикации:", colorKeyboard());
  } catch (err) {
    log.error("buildDraft error:", err);
    safeUnlink(filePath);
    await edit(`❌ Ошибка при сборке аудио: ${err.message}`);
  }
}

function colorKeyboard() {
  return Markup.inlineKeyboard([
    COLORS.slice(0, 4).map((c) => Markup.button.callback(c, `color:${c}`)),
    COLORS.slice(4).map((c) => Markup.button.callback(c, `color:${c}`)),
    [Markup.button.callback("❌ Отмена", "cancel")],
  ]);
}

// ================================================================
// КОМАНДЫ
// ================================================================
bot.use(adminOnly);

bot.start((ctx) =>
  ctx.reply(
    "🎛 Бот-публикатор.\n\n" +
      `Склеивает аяты и публикует их в ${CHANNEL_ID} от имени @${HOSARY_BOT_USERNAME}, ` +
      "затем сохраняет file_id в audio_data.json.\n\n" +
      "Отправьте: <code>5 57-58</code>\n" +
      "Справка: /help",
    { parse_mode: "HTML" },
  ),
);

bot.command("help", (ctx) =>
  ctx.reply(
    "<b>Как пользоваться</b>\n\n" +
      "1. Отправьте суру и аяты: <code>5 57-58</code> или <code>/publish 5 57,58</code>\n" +
      "2. Послушайте черновик (придёт от основного бота)\n" +
      "3. Выберите цвет\n" +
      "4. Нажмите «Опубликовать»\n\n" +
      "<b>Команды</b>\n" +
      "/publish &lt;сура&gt; &lt;аяты&gt; — собрать аудио\n" +
      "/list — последние 10 записей в audio_data.json\n" +
      "/json — последняя запись целиком\n" +
      "/delete &lt;номер&gt; — удалить запись из последних 10\n" +
      "/cancel — сбросить текущий черновик\n" +
      "/colors — значения цветов",
    { parse_mode: "HTML" },
  ),
);

bot.command("colors", (ctx) =>
  ctx.reply(
    "🔵 Могущество Всевышнего Аллаха\n" +
      "🟢 Достоинства пророка, атрибуты верующих, Рай\n" +
      "🔴 Аяты постановлений\n" +
      "🟡 Рассказы пророков и народов прошлого\n" +
      "🟣 Коран и его статус, атрибуты человека, ответы многобожникам\n" +
      "🟠 Судный день, его знаки и предупреждения\n" +
      "🟥 Геенна, её атрибуты и мучения в ней",
  ),
);

bot.command("cancel", (ctx) => {
  dropDraft(ctx.from.id);
  ctx.reply("Черновик сброшен.");
});

bot.command("list", async (ctx) => {
  try {
    const data = audioStore.readAll();
    if (!data.length) return ctx.reply("audio_data.json пуст.");

    let msg = `📝 <b>Всего записей: ${data.length}</b>\nПоследние 10:\n\n`;
    data.slice(-10).forEach((item, idx) => {
      const info = surahs[Number(item.surah) - 1] || {};
      msg +=
        `<b>${idx + 1}.</b> ${item.color} Сура ${item.surah} — ${info.name_ru || ""}\n` +
        `Аяты: ${(item.ayahs || []).join(", ")}\n` +
        `<code>${item.file_id}</code>\n` +
        `${new Date(item.timestamp).toLocaleString("ru-RU")}\n──────────────\n`;
    });
    await ctx.reply(msg, { parse_mode: "HTML" });
  } catch (err) {
    log.error("list error:", err);
    ctx.reply(`Ошибка чтения: ${err.message}`);
  }
});

bot.command("json", async (ctx) => {
  try {
    const data = audioStore.readAll();
    if (!data.length) return ctx.reply("audio_data.json пуст.");
    await ctx.reply(
      `<pre>${JSON.stringify(data[data.length - 1], null, 2)}</pre>`,
      { parse_mode: "HTML" },
    );
  } catch (err) {
    ctx.reply(`Ошибка: ${err.message}`);
  }
});

bot.command("delete", async (ctx) => {
  try {
    const idx = parseInt(ctx.message.text.split(" ")[1], 10) - 1;
    const total = audioStore.readAll().length;
    const last10 = Math.min(10, total);

    if (isNaN(idx) || idx < 0 || idx >= last10) {
      return ctx.reply("Некорректный номер. Смотрите /list");
    }

    const realIdx = total - last10 + idx;
    const removed = await audioStore.removeAt(realIdx);

    if (!removed) return ctx.reply("Запись не найдена.");
    ctx.reply(
      `Удалено: сура ${removed.surah}, аяты ${(removed.ayahs || []).join(", ")}`,
    );
  } catch (err) {
    log.error("delete error:", err);
    ctx.reply(`Ошибка удаления: ${err.message}`);
  }
});

bot.command("publish", async (ctx) => {
  const args = ctx.message.text.split(" ").slice(1);
  const surah = parseInt(args[0], 10);
  const rawText = args.slice(1).join("").trim();

  if (!surah || surah < 1 || surah > 114 || !rawText) {
    return ctx.reply(
      "Формат: <code>/publish 5 57-58</code>",
      { parse_mode: "HTML" },
    );
  }
  await buildDraft(ctx, surah, rawText);
});

// Свободный ввод: "5 57-58", "5:57-58", "5 57,58"
bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return;

  const match = text.match(/^(\d{1,3})\s*[\s:.]\s*([\d,\s-]+)$/);
  if (!match) {
    return ctx.reply(
      "Не понял. Формат: <code>5 57-58</code>\nСправка: /help",
      { parse_mode: "HTML" },
    );
  }

  const surah = parseInt(match[1], 10);
  if (surah < 1 || surah > 114) {
    return ctx.reply("Номер суры должен быть от 1 до 114.");
  }

  await buildDraft(ctx, surah, match[2].replace(/\s+/g, ""));
});

// ================================================================
// CALLBACK
// ================================================================
bot.action(/^color:(.+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const draft = getDraft(ctx.from.id);
    if (!draft) {
      return ctx.editMessageText("Черновик потерян. Соберите аудио заново.");
    }

    draft.color = ctx.match[1];
    draft.caption = buildCaption(draft.color, draft.surah, draft.rawText);

    const buttons = [
      [
        Markup.button.callback("✅ Опубликовать в канал", "send_channel"),
        Markup.button.callback("❌ Отмена", "cancel"),
      ],
      [Markup.button.callback("🎨 Сменить цвет", "change_color")],
    ];
    if (GROUP_ID) {
      buttons.splice(1, 0, [
        Markup.button.callback("📨 Отправить в группу", "send_group"),
      ]);
    }

    await ctx.editMessageText(
      `<b>Предпросмотр подписи:</b>\n\n<code>${draft.caption}</code>`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) },
    );
  } catch (err) {
    log.error("color action error:", err);
    ctx.reply("Ошибка при выборе цвета.");
  }
});

bot.action("change_color", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText("Выберите цвет для публикации:", colorKeyboard());
});

bot.action("send_channel", async (ctx) => {
  try {
    await ctx.answerCbQuery("Публикую...");
    await ctx.editMessageReplyMarkup();

    const draft = getDraft(ctx.from.id);
    if (!draft?.fileId) return ctx.reply("Черновик не найден.");
    if (!draft.color) return ctx.reply("Сначала выберите цвет.");

    // Отправка file_id токеном основного бота — повторной заливки нет.
    const sent = await hosary.sendAudio(CHANNEL_ID, draft.fileId, {
      caption: draft.caption,
    });

    const record = {
      color: draft.color,
      surah: draft.surah,
      ayahs: draft.ayahs,
      file_id: sent.audio.file_id,
      timestamp: new Date().toISOString(),
      user_id: ctx.from.id,
      username: ctx.from.username || "unknown",
    };

    await audioStore.appendRecord(record);
    log.info("Опубликовано:", record.surah, record.ayahs.join(","));

    await ctx.reply(
      `✅ Опубликовано в ${CHANNEL_ID} и сохранено в audio_data.json:\n\n` +
        `<pre>${JSON.stringify(record, null, 2)}</pre>`,
      { parse_mode: "HTML" },
    );

    dropDraft(ctx.from.id);
  } catch (err) {
    log.error("send_channel error:", err);
    await ctx.reply(
      `❌ Ошибка публикации: ${err.message}\n\n` +
        "Черновик сохранён — можно попробовать ещё раз.",
    );
  }
});

bot.action("send_group", async (ctx) => {
  try {
    await ctx.answerCbQuery("Отправляю в группу...");

    const draft = getDraft(ctx.from.id);
    if (!draft?.fileId) return ctx.reply("Черновик не найден.");

    const link = shareLink(draft.surah, draft.ayahs[0]);

    await hosary.sendAudio(GROUP_ID, draft.fileId, {
      caption: `${draft.caption}\n\n🔴 Не забудь посмотреть перевод 📕 и тафсир 📘 😊`,
      reply_markup: {
        inline_keyboard: [[{ text: "📕 Перевод / 📘 Тафсир", url: link }]],
      },
    });

    await ctx.reply("✅ Отправлено в группу.");
  } catch (err) {
    log.error("send_group error:", err);
    ctx.reply(`❌ Ошибка отправки в группу: ${err.message}`);
  }
});

bot.action("cancel", async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup();
    dropDraft(ctx.from.id);
    await ctx.reply("Отменено, черновик удалён.");
  } catch (err) {
    log.error("cancel error:", err);
  }
});

// ================================================================
// ЗАПУСК / ЗАВЕРШЕНИЕ
// ================================================================
bot.catch((err, ctx) => {
  log.error(`Необработанная ошибка (${ctx.updateType}):`, err);
});

process.on("unhandledRejection", (r) => log.error("Unhandled Rejection:", r));

async function shutdown(signal) {
  log.info(`Получен ${signal}, останавливаюсь`);
  for (const userId of [...drafts.keys()]) dropDraft(userId);
  bot.stop(signal);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

(async () => {
  try {
    const me = await hosary.getMe();
    log.info(`Публикация пойдёт от имени @${me.username}`);

    await bot.launch();
    log.info(`✅ Бот-публикатор запущен. Канал: ${CHANNEL_ID}`);
  } catch (err) {
    log.error("Ошибка запуска:", err.message);
    process.exit(1);
  }
})();
