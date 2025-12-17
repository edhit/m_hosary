// ayah-photos-db.js
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

class AyahPhotosDatabase {
  constructor() {
    this.db = null;
    this.initialized = false;
    this.dbPath = path.join(__dirname, "ayah-photos.db");
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
              resolve();
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

  // Получить file_id фото для аята
  async getAyahPhoto(surah, ayah) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.get(
        "SELECT file_id FROM ayah_photos WHERE surah = ? AND ayah = ?",
        [surah, ayah],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row ? row.file_id : null);
          }
        }
      );
    });
  }

  // Получить несколько фото по аятам
  async getAyahPhotos(surah, ayahs) {
    await this.init();

    if (!ayahs.length) return {};

    // Создаем плейсхолдеры для SQL запроса
    const placeholders = ayahs.map(() => "?").join(",");

    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT ayah, file_id FROM ayah_photos WHERE surah = ? AND ayah IN (${placeholders})`,
        [surah, ...ayahs],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            const result = {};
            rows.forEach((row) => {
              result[row.ayah] = row.file_id;
            });
            resolve(result);
          }
        }
      );
    });
  }

  // Получить все фото для суры
  async getSurahPhotos(surah) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.all(
        "SELECT ayah, file_id FROM ayah_photos WHERE surah = ? ORDER BY ayah",
        [surah],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            const result = {};
            rows.forEach((row) => {
              result[row.ayah] = row.file_id;
            });
            resolve(result);
          }
        }
      );
    });
  }

  // Получить диапазон фото
  async getPhotosRange(surah, startAyah, endAyah) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.all(
        "SELECT ayah, file_id FROM ayah_photos WHERE surah = ? AND ayah BETWEEN ? AND ? ORDER BY ayah",
        [surah, startAyah, endAyah],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            const result = {};
            rows.forEach((row) => {
              result[row.ayah] = row.file_id;
            });
            resolve(result);
          }
        }
      );
    });
  }

  // Проверить существование фото для аята
  async hasAyahPhoto(surah, ayah) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.get(
        "SELECT 1 FROM ayah_photos WHERE surah = ? AND ayah = ?",
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

  // Получить количество фото в суре
  async getSurahPhotoCount(surah) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.get(
        "SELECT COUNT(*) as count FROM ayah_photos WHERE surah = ?",
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

  // Получить статистику
  async getStatistics() {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.get(
        `
        SELECT 
          COUNT(*) as totalPhotos,
          COUNT(DISTINCT surah) as surahsCount,
          MIN(surah) as minSurah,
          MAX(surah) as maxSurah,
          MIN(ayah) as minAyah,
          MAX(ayah) as maxAyah
        FROM ayah_photos
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
                  totalPhotos: row.totalPhotos,
                  surahsCount: row.surahsCount,
                  surahRange: `${row.minSurah}-${row.maxSurah}`,
                  ayahRange: `${row.minAyah}-${row.maxAyah}`,
                  databaseSize: "unknown",
                });
              } else {
                const sizeKB = (stats.size / 1024).toFixed(2);
                resolve({
                  totalPhotos: row.totalPhotos,
                  surahsCount: row.surahsCount,
                  surahRange: `${row.minSurah}-${row.maxSurah}`,
                  ayahRange: `${row.minAyah}-${row.maxAyah}`,
                  databaseSize: `${sizeKB} KB`,
                });
              }
            });
          }
        }
      );
    });
  }

  // Получить следующий аят с фото
  async getNextAyahWithPhoto(surah, ayah) {
    await this.init();

    return new Promise((resolve, reject) => {
      // Сначала ищем в той же суре
      this.db.get(
        `SELECT surah, ayah FROM ayah_photos 
         WHERE surah = ? AND ayah > ? 
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
              `SELECT surah, MIN(ayah) as ayah FROM ayah_photos 
               WHERE surah > ? 
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
                  // Возвращаем первый аят с фото
                  this.db.get(
                    `SELECT surah, ayah FROM ayah_photos 
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

  // Получить предыдущий аят с фото
  async getPreviousAyahWithPhoto(surah, ayah) {
    await this.init();

    return new Promise((resolve, reject) => {
      // Сначала ищем в той же суре
      this.db.get(
        `SELECT surah, ayah FROM ayah_photos 
         WHERE surah = ? AND ayah < ? 
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
              `SELECT surah, MAX(ayah) as ayah FROM ayah_photos 
               WHERE surah < ? 
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
                  // Возвращаем последний аят с фото
                  this.db.get(
                    `SELECT surah, ayah FROM ayah_photos 
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

  // Поиск по диапазону аятов
  async searchByAyahRange(surah, start, end) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT ayah, file_id FROM ayah_photos 
         WHERE surah = ? AND ayah BETWEEN ? AND ?
         ORDER BY ayah`,
        [surah, start, end],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            const result = {};
            rows.forEach((row) => {
              result[row.ayah] = row.file_id;
            });
            resolve(result);
          }
        }
      );
    });
  }

  // Получить все суры с фото
  async getAllSurahsWithPhotos() {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT surah, COUNT(*) as photo_count 
         FROM ayah_photos 
         GROUP BY surah 
         ORDER BY surah`,
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

  // Экспорт в JSON (с ограничением)
  async exportToJson(limit = 100) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT surah, ayah, file_id FROM ayah_photos 
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
              result[row.surah][row.ayah] = row.file_id;
            });
            resolve(result);
          }
        }
      );
    });
  }
}

// Создаем синглтон экземпляр
const dbInstance = new AyahPhotosDatabase();

// Экспортируем функции
module.exports = {
  // Основные функции
  getAyahPhoto: (surah, ayah) => dbInstance.getAyahPhoto(surah, ayah),
  getAyahPhotos: (surah, ayahs) => dbInstance.getAyahPhotos(surah, ayahs),
  getSurahPhotos: (surah) => dbInstance.getSurahPhotos(surah),
  getPhotosRange: (surah, startAyah, endAyah) =>
    dbInstance.getPhotosRange(surah, startAyah, endAyah),

  // Утилиты
  getStatistics: () => dbInstance.getStatistics(),
  hasAyahPhoto: (surah, ayah) => dbInstance.hasAyahPhoto(surah, ayah),
  getSurahPhotoCount: (surah) => dbInstance.getSurahPhotoCount(surah),
  getNextAyahWithPhoto: (surah, ayah) =>
    dbInstance.getNextAyahWithPhoto(surah, ayah),
  getPreviousAyahWithPhoto: (surah, ayah) =>
    dbInstance.getPreviousAyahWithPhoto(surah, ayah),
  searchByAyahRange: (surah, start, end) =>
    dbInstance.searchByAyahRange(surah, start, end),
  getAllSurahsWithPhotos: () => dbInstance.getAllSurahsWithPhotos(),
  exportToJson: (limit) => dbInstance.exportToJson(limit),

  // Управление подключением
  initDatabase: () => dbInstance.init(),
  closeDatabase: () => dbInstance.close(),

  // Экспортируем сам класс
  AyahPhotosDatabase,
};
