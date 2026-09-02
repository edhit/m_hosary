// ================================================================
// audio-store.js
// Безопасная работа с audio_data.json из НЕСКОЛЬКИХ процессов.
//
// Зачем: теперь файл пишут два бота (основной @mmmm_hosary_bot и
// бот-публикатор). Без блокировки два одновременных write перетрут
// друг друга или оставят обрезанный JSON.
//
// Механика:
//   - лок = попытка создать директорию (mkdir атомарен на всех ФС);
//   - запись = во временный файл + rename (атомарная подмена);
//   - протухший лок (>30 сек) снимается автоматически.
// ================================================================

const fs = require("fs");
const path = require("path");

const DATA_FILE = path.resolve(
  process.env.AUDIO_DATA_FILE || "./audio_data.json",
);
const LOCK_DIR = DATA_FILE + ".lock";
const STALE_LOCK_MS = 30_000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function acquireLock(timeoutMs = 10_000) {
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(LOCK_DIR);
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;

      // Снимаем протухший лок (процесс умер, не убрав за собой).
      try {
        const st = fs.statSync(LOCK_DIR);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          fs.rmdirSync(LOCK_DIR);
          continue;
        }
      } catch (_) {
        // лок исчез между stat и rmdir — просто пробуем снова
      }

      if (Date.now() - start > timeoutMs) {
        throw new Error("audio_data.json занят другим процессом");
      }
      await sleep(100);
    }
  }
}

function releaseLock() {
  try {
    fs.rmdirSync(LOCK_DIR);
  } catch (_) {}
}

function readAll() {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    const raw = fs.readFileSync(DATA_FILE, "utf-8").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    throw new Error(`Не удалось прочитать audio_data.json: ${err.message}`);
  }
}

function writeAllAtomic(data) {
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, DATA_FILE);
}

// Универсальная транзакция: fn получает текущий массив, возвращает новый.
// Если fn вернул undefined — запись не производится.
async function transaction(fn) {
  await acquireLock();
  try {
    const data = readAll();
    const next = await fn(data);
    if (next === undefined) return data;
    writeAllAtomic(next);
    return next;
  } finally {
    releaseLock();
  }
}

async function appendRecord(record) {
  await transaction((data) => {
    data.push(record);
    return data;
  });
  return record;
}

async function removeAt(realIndex) {
  let removed = null;
  await transaction((data) => {
    if (realIndex < 0 || realIndex >= data.length) return undefined;
    removed = data.splice(realIndex, 1)[0];
    return data;
  });
  return removed;
}

module.exports = {
  DATA_FILE,
  readAll,
  transaction,
  appendRecord,
  removeAt,
};
