// init-ayah-photos-db.js
const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

// Функция для определения суры по номеру аята
function getSurahForAyah(ayahNumber, surahsData) {
  let cumulativeAyahs = 0;

  for (const surah of surahsData) {
    cumulativeAyahs += surah.ayahs;
    if (ayahNumber <= cumulativeAyahs) {
      // Определяем номер аята в конкретной суре
      const ayahInSurah = ayahNumber - (cumulativeAyahs - surah.ayahs);
      return {
        surah: surah.number,
        ayah: ayahInSurah,
      };
    }
  }

  // Если не найдено, возвращаем null
  return null;
}

// Создаем и инициализируем базу данных для фото аятов
function initializeAyahPhotosDatabase() {
  return new Promise((resolve, reject) => {
    // Читаем данные из JSON файла с фото
    const jsonFile = path.join(__dirname, "ayahPhotos.json");
    if (!fs.existsSync(jsonFile)) {
      reject(new Error(`Файл ${jsonFile} не найден`));
      return;
    }

    // Читаем данные о сурах
    const quranFile = path.join(__dirname, "/../quran.json");
    if (!fs.existsSync(quranFile)) {
      reject(new Error(`Файл ${quranFile} не найден`));
      return;
    }

    const photosData = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
    const surahsData = JSON.parse(fs.readFileSync(quranFile, "utf8"));

    // Создаем подключение к базе данных
    const db = new sqlite3.Database("ayah-photos.db", (err) => {
      if (err) {
        reject(err);
        return;
      }
      console.log("Подключение к SQLite установлено");
    });

    // Включаем WAL режим для лучшей производительности
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    db.run("PRAGMA cache_size = 10000");

    // Создаем таблицу
    db.serialize(() => {
      // Таблица фото аятов - surah (INTEGER), ayah (INTEGER), file_id (TEXT)
      db.run(`
        CREATE TABLE IF NOT EXISTS ayah_photos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          surah INTEGER NOT NULL,
          ayah INTEGER NOT NULL,
          file_id TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(surah, ayah)
        )
      `);

      // Создаем индексы для быстрого поиска
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_surah_ayah ON ayah_photos(surah, ayah)"
      );
      db.run("CREATE INDEX IF NOT EXISTS idx_surah ON ayah_photos(surah)");
      db.run("CREATE INDEX IF NOT EXISTS idx_ayah ON ayah_photos(ayah)");

      // Очищаем таблицу перед заполнением
      db.run("DELETE FROM ayah_photos");

      // Подготавливаем statement для вставки
      const insertStmt = db.prepare(
        "INSERT INTO ayah_photos (surah, ayah, file_id) VALUES (?, ?, ?)"
      );

      let insertedCount = 0;
      let skippedCount = 0;
      let errors = [];

      // Сначала сортируем ключи для правильной обработки
      const sortedKeys = Object.keys(photosData)
        .map((key) => parseInt(key))
        .filter((key) => !isNaN(key))
        .sort((a, b) => a - b);

      console.log(
        `Всего найдено ${sortedKeys.length} номеров аятов в images.json`
      );
      console.log(
        `Общее количество аятов в Коране: ${surahsData.reduce(
          (sum, surah) => sum + surah.ayahs,
          0
        )}`
      );

      // Вставляем все фото аятов
      for (const ayahNumber of sortedKeys) {
        const fileId = photosData[ayahNumber.toString()];

        if (!fileId || typeof fileId !== "string" || fileId.trim() === "") {
          console.warn(`Пропущен некорректный file_id для аята ${ayahNumber}`);
          skippedCount++;
          continue;
        }

        // Определяем суру и номер аята в суре
        const surahInfo = getSurahForAyah(ayahNumber, surahsData);

        if (!surahInfo) {
          errors.push(`Аят ${ayahNumber} выходит за пределы Корана`);
          skippedCount++;
          continue;
        }

        try {
          insertStmt.run(surahInfo.surah, surahInfo.ayah, fileId.trim());
          insertedCount++;

          // Логируем прогресс каждые 100 записей
          if (insertedCount % 100 === 0) {
            console.log(`Вставлено ${insertedCount} записей...`);
          }

          // Выводим первые несколько записей для проверки
          if (insertedCount <= 5) {
            console.log(
              `  Аят ${ayahNumber} → Сура ${surahInfo.surah}:${
                surahInfo.ayah
              } (file_id: ${fileId.substring(0, 20)}...)`
            );
          }
        } catch (err) {
          if (err.message.includes("UNIQUE constraint failed")) {
            console.warn(
              `Дубликат: сура ${surahInfo.surah}, аят ${surahInfo.ayah} уже существует`
            );
          } else {
            console.error(
              `Ошибка при вставке аята ${ayahNumber}:`,
              err.message
            );
          }
          skippedCount++;
        }
      }

      insertStmt.finalize();

      console.log(`\n--- РЕЗУЛЬТАТЫ ---`);
      console.log(`Успешно вставлено: ${insertedCount}`);
      console.log(`Пропущено: ${skippedCount}`);

      if (errors.length > 0) {
        console.log(`\nОшибки (первые 5):`);
        errors.slice(0, 5).forEach((error) => console.log(`  ${error}`));
      }

      // Проверяем количество записей
      db.get("SELECT COUNT(*) as count FROM ayah_photos", (err, row) => {
        if (err) {
          reject(err);
        } else {
          console.log(`\nВсего записей в базе: ${row.count}`);

          // Показываем распределение по сурам
          db.all(
            `SELECT surah, COUNT(*) as count 
             FROM ayah_photos 
             GROUP BY surah 
             ORDER BY surah`,
            (err, rows) => {
              if (err) {
                reject(err);
              } else {
                console.log("\nРаспределение по сурам:");
                rows.forEach((row) => {
                  console.log(`  Сура ${row.surah}: ${row.count} фото`);
                });

                // Показываем примеры записей
                db.all(
                  `SELECT surah, ayah, LENGTH(file_id) as file_id_length 
                   FROM ayah_photos 
                   ORDER BY surah, ayah 
                   LIMIT 10`,
                  (err, rows) => {
                    if (err) {
                      reject(err);
                    } else {
                      console.log("\nПервые 10 записей:");
                      rows.forEach((row) => {
                        console.log(
                          `  Сура ${row.surah}, аят ${row.ayah} (ID: ${row.file_id_length} символов)`
                        );
                      });
                      resolve(db);
                    }
                  }
                );
              }
            }
          );
        }
      });
    });
  });
}

// Функция для тестирования
async function testDatabase() {
  const db = new sqlite3.Database("ayah-photos.db");

  console.log("\n--- ТЕСТИРОВАНИЕ БАЗЫ ДАННЫХ ---\n");

  // Проверяем несколько записей
  db.all(
    "SELECT surah, ayah, file_id FROM ayah_photos ORDER BY surah, ayah LIMIT 10",
    (err, rows) => {
      if (err) {
        console.error("Ошибка при тестировании:", err);
      } else {
        console.log("Первые 10 записей:");
        rows.forEach((row) => {
          console.log(
            `  Сура ${row.surah}, аят ${row.ayah}: ${row.file_id.substring(
              0,
              30
            )}...`
          );
        });
      }

      // Проверяем статистику
      db.get(
        `SELECT 
          COUNT(*) as total, 
          MIN(surah) as min_surah, 
          MAX(surah) as max_surah,
          MIN(ayah) as min_ayah, 
          MAX(ayah) as max_ayah 
         FROM ayah_photos`,
        (err, row) => {
          if (err) {
            console.error("Ошибка при получении статистики:", err);
          } else {
            console.log("\nСтатистика:");
            console.log(`  Всего записей: ${row.total}`);
            console.log(`  Диапазон сур: ${row.min_surah}-${row.max_surah}`);
            console.log(
              `  Диапазон аятов в сурах: ${row.min_ayah}-${row.max_ayah}`
            );
          }

          // Показываем количество фото по сурам
          db.all(
            `SELECT surah, COUNT(*) as count 
             FROM ayah_photos 
             GROUP BY surah 
             ORDER BY surah`,
            (err, rows) => {
              if (err) {
                console.error("Ошибка при группировке:", err);
              } else {
                console.log("\nКоличество фото по сурам:");
                rows.forEach((row) => {
                  console.log(`  Сура ${row.surah}: ${row.count} фото`);
                });
              }

              db.close();
            }
          );
        }
      );
    }
  );
}

// Запускаем инициализацию
if (require.main === module) {
  initializeAyahPhotosDatabase()
    .then((db) => {
      console.log("\n✅ База данных фото аятов успешно инициализирована!");
      db.close();

      // Тестируем
      setTimeout(() => {
        testDatabase();
      }, 1000);
    })
    .catch((err) => {
      console.error("❌ Ошибка при инициализации базы данных:", err);
      process.exit(1);
    });
}

module.exports = { initializeAyahPhotosDatabase, getSurahForAyah };
