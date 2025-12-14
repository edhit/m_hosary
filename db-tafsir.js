// tafsir-db.js
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

class TafsirDatabase {
  constructor() {
    this.db = null;
    this.initialized = false;
    this.dbPath = path.join(__dirname, "tafsir.db");
  }

  // Инициализация подключения
  async init() {
    if (this.initialized) return;

    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(
        this.dbPath,
        sqlite3.OPEN_READONLY,
        (err) => {
          if (err) {
            reject(
              new Error(
                `Не удалось открыть базу данных ${this.dbPath}: ${err.message}`
              )
            );
          } else {
            this.initialized = true;
            // Включаем WAL режим для лучшей производительности
            this.db.run("PRAGMA journal_mode = WAL", () => {
              this.db.run("PRAGMA cache_size = 10000", () => {
                resolve();
              });
            });
          }
        }
      );
    });
  }

  // Закрытие подключения
  async close() {
    if (this.db) {
      return new Promise((resolve, reject) => {
        this.db.close((err) => {
          if (err) {
            reject(err);
          } else {
            this.initialized = false;
            resolve();
          }
        });
      });
    }
  }

  // Получить метаданные
  async getMetadata() {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.all("SELECT key, value FROM metadata", (err, rows) => {
        if (err) {
          reject(err);
          return;
        }

        const metadata = {};
        rows.forEach((row) => {
          metadata[row.key] = row.value;
        });

        resolve(metadata);
      });
    });
  }

  // Получить тафсир по суре и аяту (аналог оригинальной функции getTafsir)
  async getTafsir(surah, ayah) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT text FROM tafsirs 
         WHERE surah = ? AND ayah = ?`,
        [surah, ayah],
        (err, row) => {
          if (err) {
            reject(err);
          } else if (row && row.text && row.text.trim() !== "") {
            resolve(row.text);
          } else {
            // Возвращаем null если тафсира нет (как в оригинальной функции)
            resolve(null);
          }
        }
      );
    });
  }

  // Получить тафсир с дополнительной информацией
  async getTafsirWithInfo(surah, ayah) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT surah, ayah, text FROM tafsirs 
         WHERE surah = ? AND ayah = ?`,
        [surah, ayah],
        (err, row) => {
          if (err) {
            reject(err);
          } else if (row) {
            resolve({
              surah: row.surah,
              ayah: row.ayah,
              text: row.text && row.text.trim() !== "" ? row.text : null,
              hasTafsir: !!(row.text && row.text.trim() !== ""),
            });
          } else {
            resolve({
              surah,
              ayah,
              text: null,
              hasTafsir: false,
            });
          }
        }
      );
    });
  }

  // Получить все тафсиры суры
  async getSurahTafsirs(surah) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT ayah, text FROM tafsirs 
         WHERE surah = ? 
         ORDER BY ayah`,
        [surah],
        (err, rows) => {
          if (err) {
            reject(err);
            return;
          }

          const result = [];
          rows.forEach((row) => {
            if (row.text && row.text.trim() !== "") {
              result.push({
                ayah: row.ayah,
                text: row.text,
              });
            }
          });

          resolve(result);
        }
      );
    });
  }

  // Получить тафсиры для диапазона аятов
  async getTafsirsRange(surah, startAyah, endAyah) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT ayah, text FROM tafsirs 
         WHERE surah = ? AND ayah BETWEEN ? AND ?
         ORDER BY ayah`,
        [surah, startAyah, endAyah],
        (err, rows) => {
          if (err) {
            reject(err);
            return;
          }

          const result = {};
          rows.forEach((row) => {
            if (row.text && row.text.trim() !== "") {
              result[row.ayah] = row.text;
            }
          });

          resolve(result);
        }
      );
    });
  }

  // Поиск по тексту тафсира (полнотекстовый поиск)
  async searchTafsirs(query, limit = 50) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT surah, ayah, snippet(tafsirs_fts, 0, '<b>', '</b>', '...', 10) as snippet
         FROM tafsirs_fts 
         WHERE text MATCH ?
         ORDER BY rank
         LIMIT ?`,
        [query, limit],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve(rows);
          }
        }
      );
    });
  }

  // Поиск по тексту тафсира (простым LIKE)
  async searchTafsirsSimple(query, limit = 50) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT surah, ayah, text 
         FROM tafsirs 
         WHERE text LIKE ? AND text != ''
         LIMIT ?`,
        [`%${query}%`, limit],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve(
              rows.map((row) => ({
                surah: row.surah,
                ayah: row.ayah,
                text: row.text.substring(0, 200) + "...",
              }))
            );
          }
        }
      );
    });
  }

  // Получить статистику
  async getStatistics() {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.get(
        `
        SELECT 
          COUNT(*) as totalAyahs,
          COUNT(CASE WHEN text != '' THEN 1 END) as tafsirsCount,
          MIN(surah) as minSurah,
          MAX(surah) as maxSurah,
          MIN(ayah) as minAyah,
          MAX(ayah) as maxAyah
        FROM tafsirs
      `,
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            // Получаем размер базы данных
            const fs = require("fs");
            fs.stat(this.dbPath, (err, stats) => {
              if (err) {
                resolve({
                  totalAyahs: row.totalAyahs,
                  tafsirsCount: row.tafsirsCount,
                  coverage:
                    ((row.tafsirsCount / row.totalAyahs) * 100).toFixed(1) +
                    "%",
                  surahRange: `${row.minSurah}-${row.maxSurah}`,
                  ayahRange: `${row.minAyah}-${row.maxAyah}`,
                  databaseSize: "unknown",
                });
              } else {
                const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
                resolve({
                  totalAyahs: row.totalAyahs,
                  tafsirsCount: row.tafsirsCount,
                  coverage:
                    ((row.tafsirsCount / row.totalAyahs) * 100).toFixed(1) +
                    "%",
                  surahRange: `${row.minSurah}-${row.maxSurah}`,
                  ayahRange: `${row.minAyah}-${row.maxAyah}`,
                  databaseSize: `${sizeMB} MB`,
                });
              }
            });
          }
        }
      );
    });
  }

  // Получить следующий аят с тафсиром
  async getNextTafsir(surah, ayah) {
    await this.init();

    return new Promise((resolve, reject) => {
      // Сначала ищем в той же суре
      this.db.get(
        `SELECT surah, ayah FROM tafsirs 
         WHERE surah = ? AND ayah > ? AND text != ''
         ORDER BY ayah LIMIT 1`,
        [surah, ayah],
        (err, row) => {
          if (err) {
            reject(err);
            return;
          }

          if (row) {
            resolve({ surah: row.surah, ayah: row.ayah });
          } else {
            // Если нет больше в этой суре, ищем следующую суру
            this.db.get(
              `SELECT surah, MIN(ayah) as ayah FROM tafsirs 
               WHERE surah > ? AND text != ''
               GROUP BY surah
               ORDER BY surah LIMIT 1`,
              [surah],
              (err, nextRow) => {
                if (err) {
                  reject(err);
                  return;
                }

                if (nextRow) {
                  resolve({ surah: nextRow.surah, ayah: nextRow.ayah });
                } else {
                  // Возвращаем первый аят с тафсиром
                  this.db.get(
                    `SELECT surah, ayah FROM tafsirs 
                     WHERE text != ''
                     ORDER BY surah, ayah LIMIT 1`,
                    (err, firstRow) => {
                      if (err) {
                        reject(err);
                      } else {
                        resolve(firstRow || null);
                      }
                    }
                  );
                }
              }
            );
          }
        }
      );
    });
  }

  // Получить предыдущий аят с тафсиром
  async getPreviousTafsir(surah, ayah) {
    await this.init();

    return new Promise((resolve, reject) => {
      // Сначала ищем в той же суре
      this.db.get(
        `SELECT surah, ayah FROM tafsirs 
         WHERE surah = ? AND ayah < ? AND text != ''
         ORDER BY ayah DESC LIMIT 1`,
        [surah, ayah],
        (err, row) => {
          if (err) {
            reject(err);
            return;
          }

          if (row) {
            resolve({ surah: row.surah, ayah: row.ayah });
          } else {
            // Если нет до этого в суре, ищем предыдущую суру
            this.db.get(
              `SELECT surah, MAX(ayah) as ayah FROM tafsirs 
               WHERE surah < ? AND text != ''
               GROUP BY surah
               ORDER BY surah DESC LIMIT 1`,
              [surah],
              (err, prevRow) => {
                if (err) {
                  reject(err);
                  return;
                }

                if (prevRow) {
                  resolve({ surah: prevRow.surah, ayah: prevRow.ayah });
                } else {
                  // Возвращаем последний аят с тафсиром
                  this.db.get(
                    `SELECT surah, ayah FROM tafsirs 
                     WHERE text != ''
                     ORDER BY surah DESC, ayah DESC LIMIT 1`,
                    (err, lastRow) => {
                      if (err) {
                        reject(err);
                      } else {
                        resolve(lastRow || null);
                      }
                    }
                  );
                }
              }
            );
          }
        }
      );
    });
  }

  // Проверить существование тафсира для аята
  async hasTafsir(surah, ayah) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT 1 FROM tafsirs 
         WHERE surah = ? AND ayah = ? AND text != ''`,
        [surah, ayah],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(!!row);
          }
        }
      );
    });
  }

  // Получить количество аятов с тафсиром в суре
  async getSurahTafsirCount(surah) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT COUNT(*) as count FROM tafsirs 
         WHERE surah = ? AND text != ''`,
        [surah],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row.count);
          }
        }
      );
    });
  }

  // Экспорт в JSON (с ограничением)
  async exportToJson(limit = 100) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT surah, ayah, text FROM tafsirs 
         WHERE text != ''
         ORDER BY surah, ayah
         LIMIT ?`,
        [limit],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            const result = {};
            rows.forEach((row) => {
              if (!result[row.surah]) {
                result[row.surah] = {};
              }
              result[row.surah][row.ayah] = row.text;
            });
            resolve(result);
          }
        }
      );
    });
  }
}

// Создаем синглтон экземпляр
const dbInstance = new TafsirDatabase();

// Экспортируем функции для обратной совместимости с оригинальной функцией
module.exports = {
  // Основная функция (совместимость с оригинальным кодом)
  getTafsir: (surah, ayah) => dbInstance.getTafsir(surah, ayah),

  // Расширенные функции
  getTafsirWithInfo: (surah, ayah) => dbInstance.getTafsirWithInfo(surah, ayah),
  getSurahTafsirs: (surah) => dbInstance.getSurahTafsirs(surah),
  getTafsirsRange: (surah, startAyah, endAyah) =>
    dbInstance.getTafsirsRange(surah, startAyah, endAyah),
  searchTafsirs: (query, limit) => dbInstance.searchTafsirs(query, limit),
  searchTafsirsSimple: (query, limit) =>
    dbInstance.searchTafsirsSimple(query, limit),

  // Утилиты
  getStatistics: () => dbInstance.getStatistics(),
  getMetadata: () => dbInstance.getMetadata(),
  getNextTafsir: (surah, ayah) => dbInstance.getNextTafsir(surah, ayah),
  getPreviousTafsir: (surah, ayah) => dbInstance.getPreviousTafsir(surah, ayah),
  hasTafsir: (surah, ayah) => dbInstance.hasTafsir(surah, ayah),
  getSurahTafsirCount: (surah) => dbInstance.getSurahTafsirCount(surah),
  exportToJson: (limit) => dbInstance.exportToJson(limit),

  // Управление подключением
  initDatabase: () => dbInstance.init(),
  closeDatabase: () => dbInstance.close(),

  // Экспортируем сам класс
  TafsirDatabase,
};
