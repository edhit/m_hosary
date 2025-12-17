// init-tafsir-db.js
const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

// Создаем и инициализируем базу данных для тафсиров
function initializeTafsirDatabase() {
  return new Promise((resolve, reject) => {
    // Читаем данные из JSON файла (предполагается, что файл называется tafsir.json)
    const jsonFile = path.join(__dirname, "tafsirs_cleaned.json");
    if (!fs.existsSync(jsonFile)) {
      reject(new Error(`Файл ${jsonFile} не найден`));
      return;
    }

    const tafsirData = JSON.parse(fs.readFileSync(jsonFile, "utf8"));

    // Создаем подключение к базе данных
    const db = new sqlite3.Database("tafsir.db", (err) => {
      if (err) {
        reject(err);
        return;
      }
      console.log("Подключение к SQLite установлено");
    });

    // Включаем WAL режим для лучшей производительности
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    db.run("PRAGMA cache_size = 10000"); // Увеличиваем кэш для производительности

    // Создаем таблицы
    db.serialize(() => {
      // Таблица метаданных
      db.run(`
        CREATE TABLE IF NOT EXISTS metadata (
          id INTEGER PRIMARY KEY,
          key TEXT UNIQUE,
          value TEXT
        )
      `);

      // Таблица тафсиров
      db.run(`
        CREATE TABLE IF NOT EXISTS tafsirs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          surah INTEGER NOT NULL,
          ayah INTEGER NOT NULL,
          text TEXT,
          UNIQUE(surah, ayah)
        )
      `);

      // Создаем индексы для быстрого поиска
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_surah_ayah ON tafsirs(surah, ayah)"
      );
      db.run("CREATE INDEX IF NOT EXISTS idx_surah ON tafsirs(surah)");
      db.run("CREATE INDEX IF NOT EXISTS idx_ayah ON tafsirs(ayah)");

      // Создаем полнотекстовый индекс для поиска по тексту тафсира
      db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS tafsirs_fts 
        USING fts5(surah, ayah, text)
      `);

      // Очищаем таблицы перед заполнением
      db.run("DELETE FROM metadata");
      db.run("DELETE FROM tafsirs");
      db.run("DELETE FROM tafsirs_fts");

      // Сохраняем метаданные
      const metadataStmt = db.prepare(
        "INSERT INTO metadata (key, value) VALUES (?, ?)"
      );

      // Сохраняем простые метаданные
      metadataStmt.run("source", tafsirData.metadata.source);
      metadataStmt.run("tafsirId", tafsirData.metadata.tafsirId.toString());
      metadataStmt.run("tafsirName", tafsirData.metadata.tafsirName);
      metadataStmt.run("generatedAt", tafsirData.metadata.generatedAt);
      metadataStmt.run("lastUpdated", tafsirData.metadata.lastUpdated);
      metadataStmt.run(
        "completed",
        tafsirData.metadata.completed ? "true" : "false"
      );

      metadataStmt.finalize();

      // Подготавливаем statements для вставки
      const insertStmt = db.prepare(`
        INSERT INTO tafsirs (surah, ayah, text)
        VALUES (?, ?, ?)
      `);

      const insertFtsStmt = db.prepare(`
        INSERT INTO tafsirs_fts (surah, ayah, text)
        VALUES (?, ?, ?)
      `);

      let insertedCount = 0;
      let skippedCount = 0;

      // Вставляем тафсиры
      for (const [surahNum, surah] of Object.entries(tafsirData.surahs)) {
        const surahInt = parseInt(surahNum);

        for (const [ayahNum, text] of Object.entries(surah)) {
          const ayahInt = parseInt(ayahNum);

          // Проверяем, есть ли текст тафсира (не null)
          if (text !== null && text !== undefined && text.trim() !== "") {
            insertStmt.run(surahInt, ayahInt, text);
            insertFtsStmt.run(surahInt, ayahInt, text);
            insertedCount++;
          } else {
            // Вставляем пустую строку для NULL значений, чтобы сохранить структуру
            insertStmt.run(surahInt, ayahInt, "");
            skippedCount++;
          }

          // Логируем прогресс каждые 100 записей
          if ((insertedCount + skippedCount) % 100 === 0) {
            console.log(`Обработано ${insertedCount + skippedCount} аятов...`);
          }
        }
      }

      insertStmt.finalize();
      insertFtsStmt.finalize();

      console.log(`\nВсего вставлено тафсиров: ${insertedCount}`);
      console.log(`Аятов без тафсира: ${skippedCount}`);
      console.log(`Всего обработано аятов: ${insertedCount + skippedCount}`);

      // Проверяем количество записей
      db.get("SELECT COUNT(*) as count FROM tafsirs", (err, row) => {
        if (err) {
          reject(err);
        } else {
          console.log(`Всего записей в таблице tafsirs: ${row.count}`);

          db.get("SELECT COUNT(*) as count FROM tafsirs_fts", (err, ftsRow) => {
            if (err) {
              reject(err);
            } else {
              console.log(
                `Всего записей в таблице tafsirs_fts: ${ftsRow.count}`
              );
              resolve(db);
            }
          });
        }
      });
    });
  });
}

// Функция для тестирования
async function testDatabase() {
  const db = new sqlite3.Database("tafsir.db");

  console.log("\n--- ТЕСТИРОВАНИЕ БАЗЫ ДАННЫХ ---\n");

  // Проверяем метаданные
  db.all("SELECT key, value FROM metadata", (err, rows) => {
    if (err) {
      console.error("Ошибка при получении метаданных:", err);
    } else {
      console.log("Метаданные:");
      rows.forEach((row) => {
        console.log(`  ${row.key}: ${row.value}`);
      });
    }

    // Проверяем несколько тафсиров
    db.all(
      "SELECT surah, ayah, LENGTH(text) as length FROM tafsirs ORDER BY surah, ayah LIMIT 10",
      (err, rows) => {
        if (err) {
          console.error("Ошибка при получении тафсиров:", err);
        } else {
          console.log("\nПервые 10 записей тафсиров:");
          rows.forEach((row) => {
            console.log(
              `  Сура ${row.surah}, аят ${row.ayah}: ${row.length} символов`
            );
          });
        }

        // Проверяем статистику
        db.get(
          'SELECT COUNT(*) as total, COUNT(CASE WHEN text != "" THEN 1 END) as with_text FROM tafsirs',
          (err, row) => {
            if (err) {
              console.error("Ошибка при получении статистики:", err);
            } else {
              console.log("\nСтатистика:");
              console.log(`  Всего записей: ${row.total}`);
              console.log(`  С текстом тафсира: ${row.with_text}`);
              console.log(`  Без текста: ${row.total - row.with_text}`);
            }

            db.close();
          }
        );
      }
    );
  });
}

// Запускаем инициализацию
if (require.main === module) {
  initializeTafsirDatabase()
    .then((db) => {
      console.log("\nБаза данных тафсиров успешно инициализирована!");
      db.close();

      // Тестируем
      setTimeout(() => {
        testDatabase();
      }, 1000);
    })
    .catch((err) => {
      console.error("Ошибка при инициализации базы данных:", err);
      process.exit(1);
    });
}

module.exports = { initializeTafsirDatabase };
