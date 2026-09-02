// ================================================================
// mp3create.js
// Скачивает аяты в чтении Махмуда Аль-Хусари и склеивает в один mp3.
//
// Ключевые свойства:
//   - без глобального изменяемого состояния: параллельные вызовы
//     не мешают друг другу (важно, т.к. ботов теперь два);
//   - ошибки БРОСАЮТСЯ, а не логируются молча;
//   - результат существует на диске к моменту возврата из функции;
//   - имя файла по умолчанию уникально;
//   - ID3-теги вырезаются перед склейкой, чтобы не оседать
//     мусором в середине аудиопотока;
//   - скачанные аяты кэшируются и повторно не качаются.
// ================================================================

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

// Node 18+ имеет глобальный fetch; на старых версиях берём node-fetch.
const fetchFn =
  typeof globalThis.fetch === "function"
    ? globalThis.fetch.bind(globalThis)
    : require("node-fetch");

// ---------------- Настройки по умолчанию ----------------
const DEFAULTS = {
  mode: 2, // 1 = глобальные номера аятов, 2 = сура + номера внутри неё
  folder: "./temp",
  file: null, // null -> сгенерируется уникальное имя
  cacheFolder: process.env.AYAH_CACHE_FOLDER || "./cache/ayat",
  useCache: true,
  bitrate: 128, // доступно на CDN: 64 или 128
  concurrency: 4,
  timeoutMs: 30_000,
  retries: 3,
};

const CDN_BASE = "https://cdn.islamic.network/quran/audio";
const RECITER = "ar.husary";

// Количество аятов в каждой суре (индекс = номер суры, 1-based)
const ayahsPerSurah = [
  0,
  7, 286, 200, 176, 120, 165, 206, 75, 129, 109,
  123, 111, 43, 52, 99, 128, 111, 110, 98, 135,
  112, 78, 118, 64, 77, 227, 93, 88, 69, 60,
  34, 30, 73, 54, 45, 83, 182, 88, 75, 85,
  54, 53, 89, 59, 37, 35, 38, 29, 18, 45,
  60, 49, 62, 55, 78, 96, 29, 22, 24, 13,
  14, 11, 11, 18, 12, 12, 30, 52, 52, 44,
  28, 28, 20, 56, 40, 31, 50, 40, 46, 42,
  29, 19, 36, 25, 22, 17, 19, 26, 30, 20,
  15, 21, 11, 8, 8, 19, 5, 8, 8, 11,
  11, 8, 3, 9, 5, 4, 7, 3, 6, 3,
  5, 4, 5, 6,
];

const TOTAL_AYAHS = ayahsPerSurah.reduce((a, b) => a + b, 0); // 6236

// ---------------- Вспомогательное ----------------

function getAyahCount(surah) {
  return ayahsPerSurah[surah] || 0;
}

// (сура, аят в суре) -> сквозной номер аята в Коране
function toGlobalAyah(surah, ayah) {
  let total = 0;
  for (let i = 1; i < surah; i++) total += ayahsPerSurah[i];
  return total + ayah;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

// Вырезает ID3v2 в начале и ID3v1 в конце.
// Нужно, чтобы при конкатенации теги не оказались посреди аудиоданных
// (иначе плееры путаются в длительности и перемотке).
function stripId3(buf) {
  let start = 0;

  // ID3v2: "ID3" + версия(2) + флаги(1) + размер(4, synchsafe)
  while (
    buf.length >= start + 10 &&
    buf[start] === 0x49 &&
    buf[start + 1] === 0x44 &&
    buf[start + 2] === 0x33
  ) {
    const flags = buf[start + 5];
    const size =
      ((buf[start + 6] & 0x7f) << 21) |
      ((buf[start + 7] & 0x7f) << 14) |
      ((buf[start + 8] & 0x7f) << 7) |
      (buf[start + 9] & 0x7f);

    let len = 10 + size;
    if (flags & 0x10) len += 10; // есть футер
    if (len <= 0 || start + len > buf.length) break;
    start += len;
  }

  // ID3v1: последние 128 байт, начинающиеся с "TAG"
  let end = buf.length;
  if (
    end >= start + 128 &&
    buf.subarray(end - 128, end - 125).toString("latin1") === "TAG"
  ) {
    end -= 128;
  }

  return buf.subarray(start, end);
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Скачивание одного аята в Buffer, с ретраями и кэшем на диске.
async function fetchAyah(globalNum, opts) {
  const cachePath = opts.useCache
    ? path.join(opts.cacheFolder, `${opts.bitrate}_${globalNum}.mp3`)
    : null;

  if (cachePath) {
    try {
      const cached = await fsp.readFile(cachePath);
      if (cached.length > 0) return cached;
    } catch (_) {
      // кэша нет — качаем
    }
  }

  const url = `${CDN_BASE}/${opts.bitrate}/${RECITER}/${globalNum}.mp3`;
  let lastErr;

  for (let attempt = 1; attempt <= opts.retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, opts.timeoutMs);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error("получен пустой файл");

      if (cachePath) {
        // Пишем через временное имя, чтобы в кэше не появился обрезок,
        // если процесс упадёт посреди записи.
        const tmp = `${cachePath}.${process.pid}.part`;
        try {
          await fsp.writeFile(tmp, buf);
          await fsp.rename(tmp, cachePath);
        } catch (err) {
          try {
            await fsp.unlink(tmp);
          } catch (_) {}
        }
      }

      return buf;
    } catch (err) {
      lastErr = err;
      if (attempt < opts.retries) {
        await sleep(500 * 2 ** (attempt - 1));
      }
    }
  }

  throw new Error(`Не удалось скачать аят ${globalNum}: ${lastErr.message}`);
}

// Скачивание пачки с ограничением параллелизма, порядок сохраняется.
async function fetchAll(numbers, opts, onProgress) {
  const result = new Array(numbers.length);
  let cursor = 0;
  let done = 0;

  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= numbers.length) return;
      result[i] = await fetchAyah(numbers[i], opts);
      done++;
      if (onProgress) onProgress(done, numbers.length);
    }
  }

  const workers = Array.from(
    { length: Math.min(opts.concurrency, numbers.length) },
    worker,
  );
  await Promise.all(workers);

  return result;
}

// ---------------- Основная функция ----------------

/**
 * @param {object} settings
 * @param {number[]} settings.ayahs   номера аятов (в суре при mode=2)
 * @param {number}  [settings.surah]  номер суры (обязателен при mode=2)
 * @param {number}  [settings.mode]   1 = глобальные номера, 2 = сура+аяты
 * @param {string}  [settings.folder] куда положить результат
 * @param {string}  [settings.file]   имя файла; по умолчанию уникальное
 * @param {function}[settings.onProgress] (готово, всего)
 * @returns {Promise<{folder, file, filePath, size, ayahs, globalAyahs, surah}>}
 */
async function mp3create(settings = {}) {
  const opts = { ...DEFAULTS, ...settings };

  if (!Array.isArray(opts.ayahs) || opts.ayahs.length === 0) {
    throw new Error("Не переданы номера аятов");
  }

  let globalAyahs;

  if (opts.mode === 2) {
    const surah = Number(opts.surah);
    if (!Number.isInteger(surah) || surah < 1 || surah > 114) {
      throw new Error(`Некорректный номер суры: ${opts.surah}`);
    }

    const limit = getAyahCount(surah);
    const bad = opts.ayahs.filter(
      (a) => !Number.isInteger(a) || a < 1 || a > limit,
    );
    if (bad.length) {
      throw new Error(
        `В суре ${surah} всего ${limit} аятов. Некорректные: ${bad.join(", ")}`,
      );
    }

    globalAyahs = opts.ayahs.map((a) => toGlobalAyah(surah, a));
  } else if (opts.mode === 1) {
    const bad = opts.ayahs.filter(
      (n) => !Number.isInteger(n) || n < 1 || n > TOTAL_AYAHS,
    );
    if (bad.length) {
      throw new Error(`Некорректные глобальные номера: ${bad.join(", ")}`);
    }
    globalAyahs = [...opts.ayahs];
  } else {
    throw new Error(`Неверный режим mode: ${opts.mode}`);
  }

  const folder = path.resolve(opts.folder);
  await ensureDir(folder);
  if (opts.useCache) await ensureDir(path.resolve(opts.cacheFolder));

  // Уникальное имя по умолчанию: параллельные запросы не затирают друг друга.
  const fileName =
    opts.file ||
    `ayat_${opts.mode === 2 ? opts.surah + "_" : ""}` +
      `${globalAyahs[0]}-${globalAyahs[globalAyahs.length - 1]}_` +
      `${Date.now()}_${process.pid}.mp3`;

  const filePath = path.join(folder, fileName);

  const buffers = await fetchAll(globalAyahs, opts, opts.onProgress);
  const merged =
    buffers.length === 1
      ? buffers[0]
      : Buffer.concat(buffers.map(stripId3));

  if (merged.length === 0) {
    throw new Error("Итоговый файл пуст");
  }

  // Пишем во временное имя и переименовываем: наблюдатель никогда
  // не увидит наполовину записанный файл.
  const tmpPath = `${filePath}.part`;
  await fsp.writeFile(tmpPath, merged);
  await fsp.rename(tmpPath, filePath);

  // Гарантия для вызывающего кода: файл на месте и не пустой.
  const stat = await fsp.stat(filePath);
  if (!stat.size) throw new Error("Файл записан, но пуст");

  return {
    folder,
    file: fileName,
    filePath,
    size: stat.size,
    surah: opts.mode === 2 ? Number(opts.surah) : null,
    ayahs: [...opts.ayahs],
    globalAyahs,
  };
}

module.exports = {
  mp3create,
  toGlobalAyah,
  getAyahCount,
  ayahsPerSurah,
  TOTAL_AYAHS,
};