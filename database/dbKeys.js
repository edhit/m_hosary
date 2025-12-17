// init-keys-db.js
const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

// Создаем и инициализируем базу данных для ключей
function initializeKeysDatabase() {
  return new Promise((resolve, reject) => {
    // Читаем данные из JSON файла (предполагается, что файл называется keys.json)
    const jsonFile = path.join(__dirname, "ayahs.json");
    if (!fs.existsSync(jsonFile)) {
      reject(new Error(`Файл ${jsonFile} не найден`));
      return;
    }

    const keysData = JSON.parse(fs.readFileSync(jsonFile, "utf8"));

    // Создаем подключение к базе данных
    const db = new sqlite3.Database("keys.db", (err) => {
      if (err) {
        reject(err);
        return;
      }
      console.log("Подключение к SQLite установлено");
    });

    // Включаем WAL режим для лучшей производительности
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");

    // Создаем таблицу
    db.serialize(() => {
      // Таблица ключей - просто key (TEXT) и value (TEXT)
      db.run(`
        CREATE TABLE IF NOT EXISTS keys (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);

      // Создаем индекс для быстрого поиска по ключам
      db.run("CREATE INDEX IF NOT EXISTS idx_key ON keys(key)");

      // Очищаем таблицу перед заполнением
      db.run("DELETE FROM keys");

      // Подготавливаем statement для вставки
      const insertStmt = db.prepare(
        "INSERT INTO keys (key, value) VALUES (?, ?)"
      );

      let insertedCount = 0;

      // Вставляем все ключи и значения как есть
      for (const [key, value] of Object.entries(keysData)) {
        insertStmt.run(key.toString(), value.toString());
        insertedCount++;

        // Логируем прогресс каждые 100 записей
        if (insertedCount % 100 === 0) {
          console.log(`Вставлено ${insertedCount} записей...`);
        }
      }

      insertStmt.finalize();

      console.log(`Всего вставлено ${insertedCount} записей`);

      // Проверяем количество записей
      db.get("SELECT COUNT(*) as count FROM keys", (err, row) => {
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

// Функция для тестирования
async function testDatabase() {
  const db = new sqlite3.Database("keys.db");

  // Проверяем несколько записей
  db.all("SELECT key, value FROM keys LIMIT 5", (err, rows) => {
    if (err) {
      console.error("Ошибка при тестировании:", err);
    } else {
      console.log("\nПервые 5 записей:");
      rows.forEach((row) => {
        console.log(
          `Ключ: ${row.key}, Значение: ${row.value.substring(0, 50)}...`
        );
      });
    }

    db.close();
  });
}

// Запускаем инициализацию
if (require.main === module) {
  initializeKeysDatabase()
    .then((db) => {
      console.log("\nБаза данных успешно инициализирована!");
      db.close();

      // Тестируем
      testDatabase();
    })
    .catch((err) => {
      console.error("Ошибка при инициализации базы данных:", err);
      process.exit(1);
    });
}

module.exports = { initializeKeysDatabase };
