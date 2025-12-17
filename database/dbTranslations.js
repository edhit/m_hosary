// init-db.js
const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

// Создаем и инициализируем базу данных
function initializeDatabase() {
  return new Promise((resolve, reject) => {
    // Читаем данные из JSON
    const translationsData = JSON.parse(
      fs.readFileSync(path.join(__dirname, "translations.json"), "utf8")
    );

    // Создаем подключение к базе данных
    const db = new sqlite3.Database("translations.db", (err) => {
      if (err) {
        reject(err);
        return;
      }
      console.log("Подключение к SQLite установлено");
    });

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

      // Таблица переводов
      db.run(`
        CREATE TABLE IF NOT EXISTS translations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          surah INTEGER NOT NULL,
          ayah INTEGER NOT NULL,
          translator TEXT NOT NULL,
          text TEXT NOT NULL,
          timestamp TEXT,
          UNIQUE(surah, ayah, translator)
        )
      `);

      // Создаем индексы для быстрого поиска
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_surah_ayah ON translations(surah, ayah)"
      );
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_translator ON translations(translator)"
      );
      db.run("CREATE INDEX IF NOT EXISTS idx_surah ON translations(surah)");

      // Очищаем таблицы перед заполнением
      db.run("DELETE FROM metadata");
      db.run("DELETE FROM translations");

      // Сохраняем метаданные
      const metadataStmt = db.prepare(
        "INSERT INTO metadata (key, value) VALUES (?, ?)"
      );

      // Сохраняем простые метаданные
      metadataStmt.run("generatedAt", translationsData.metadata.generatedAt);
      metadataStmt.run("lastUpdated", translationsData.metadata.lastUpdated);
      metadataStmt.run(
        "completed",
        translationsData.metadata.completed ? "true" : "false"
      );

      // Сохраняем источники как JSON
      metadataStmt.run(
        "source_kuliev",
        translationsData.metadata.source.kuliev
      );
      metadataStmt.run(
        "source_abuAdel",
        translationsData.metadata.source.abuAdel
      );

      // Сохраняем переводчиков как JSON
      metadataStmt.run(
        "translator_kuliev",
        translationsData.metadata.translators.kuliev
      );
      metadataStmt.run(
        "translator_abuAdel",
        translationsData.metadata.translators.abuAdel
      );

      metadataStmt.finalize();

      // Подготавливаем statement для переводов
      const insertStmt = db.prepare(`
        INSERT INTO translations (surah, ayah, translator, text, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `);

      let totalInserted = 0;

      // Вставляем переводы
      for (const [surahNum, surah] of Object.entries(translationsData.surahs)) {
        for (const [ayahNum, translations] of Object.entries(surah)) {
          // Перевод Кулиева
          if (translations.kuliev) {
            insertStmt.run(
              parseInt(surahNum),
              parseInt(ayahNum),
              "kuliev",
              translations.kuliev,
              translations.timestamp || null
            );
            totalInserted++;
          }

          // Перевод Абу Аделя
          if (translations.abuAdel) {
            insertStmt.run(
              parseInt(surahNum),
              parseInt(ayahNum),
              "abuAdel",
              translations.abuAdel,
              translations.timestamp || null
            );
            totalInserted++;
          }
        }
      }

      insertStmt.finalize();

      console.log(`Вставлено ${totalInserted} переводов`);

      // Получаем статистику для проверки
      db.get("SELECT COUNT(*) as count FROM translations", (err, row) => {
        if (err) {
          reject(err);
        } else {
          console.log(`Всего записей в базе: ${row.count}`);
          resolve(db);
        }
      });
    });
  });
}

// Запускаем инициализацию
if (require.main === module) {
  initializeDatabase()
    .then((db) => {
      console.log("База данных успешно инициализирована!");
      db.close();
      process.exit(0);
    })
    .catch((err) => {
      console.error("Ошибка при инициализации базы данных:", err);
      process.exit(1);
    });
}

module.exports = { initializeDatabase };
