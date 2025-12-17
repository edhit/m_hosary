// translations.js
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

class TranslationsDatabase {
  constructor() {
    this.db = null;
    this.initialized = false;
  }

  // Инициализация подключения
  async init() {
    if (this.initialized) return;

    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(
        path.join(__dirname, "translations.db"),
        sqlite3.OPEN_READONLY,
        (err) => {
          if (err) {
            reject(err);
          } else {
            this.initialized = true;
            resolve();
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

        const metadata = {
          source: {},
          translators: {},
          generatedAt: null,
          lastUpdated: null,
          completed: false,
        };

        rows.forEach((row) => {
          if (row.key === "generatedAt") metadata.generatedAt = row.value;
          else if (row.key === "lastUpdated") metadata.lastUpdated = row.value;
          else if (row.key === "completed")
            metadata.completed = row.value === "true";
          else if (row.key.startsWith("source_")) {
            const translator = row.key.replace("source_", "");
            metadata.source[translator] = row.value;
          } else if (row.key.startsWith("translator_")) {
            const translator = row.key.replace("translator_", "");
            metadata.translators[translator] = row.value;
          }
        });

        resolve(metadata);
      });
    });
  }

  // Получить перевод конкретного переводчика
  async getTranslation(surah, ayah, translator) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT text FROM translations 
         WHERE surah = ? AND ayah = ? AND translator = ?`,
        [surah, ayah, translator],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row ? row.text : null);
          }
        }
      );
    });
  }

  // Получить оба перевода
  async getTranslations(surah, ayah) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT translator, text FROM translations 
         WHERE surah = ? AND ayah = ?`,
        [surah, ayah],
        (err, rows) => {
          if (err) {
            reject(err);
            return;
          }

          const result = {
            surah,
            ayah,
            kuliev: null,
            abuAdel: null,
          };

          rows.forEach((row) => {
            if (row.translator === "kuliev") result.kuliev = row.text;
            else if (row.translator === "abuAdel") result.abuAdel = row.text;
          });

          resolve(result);
        }
      );
    });
  }

  // Получить все аяты суры
  async getSurahTranslations(surah) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT ayah, translator, text FROM translations 
         WHERE surah = ? 
         ORDER BY ayah`,
        [surah],
        (err, rows) => {
          if (err) {
            reject(err);
            return;
          }

          // Группируем по аятам
          const ayahs = {};
          rows.forEach((row) => {
            if (!ayahs[row.ayah]) {
              ayahs[row.ayah] = {
                ayah: row.ayah,
                kuliev: null,
                abuAdel: null,
              };
            }

            if (row.translator === "kuliev") ayahs[row.ayah].kuliev = row.text;
            else if (row.translator === "abuAdel")
              ayahs[row.ayah].abuAdel = row.text;
          });

          // Преобразуем в массив и сортируем
          const result = Object.values(ayahs).sort((a, b) => a.ayah - b.ayah);

          resolve(result);
        }
      );
    });
  }

  // Поиск переводов по тексту
  async searchTranslations(query, translator = "both") {
    await this.init();

    return new Promise((resolve, reject) => {
      let sql = `
        SELECT DISTINCT t1.surah, t1.ayah, 
               k.text as kuliev, a.text as abuAdel
        FROM translations t1
        LEFT JOIN translations k ON 
          t1.surah = k.surah AND t1.ayah = k.ayah AND k.translator = 'kuliev'
        LEFT JOIN translations a ON 
          t1.surah = a.surah AND t1.ayah = a.ayah AND a.translator = 'abuAdel'
        WHERE 1=1
      `;

      const params = [];

      if (translator === "kuliev" || translator === "both") {
        sql += ` AND (k.text LIKE ?`;
        params.push(`%${query}%`);

        if (translator === "both") {
          sql += ` OR a.text LIKE ?)`;
          params.push(`%${query}%`);
        } else {
          sql += `)`;
        }
      } else if (translator === "abuAdel") {
        sql += ` AND a.text LIKE ?`;
        params.push(`%${query}%`);
      }

      sql += ` ORDER BY t1.surah, t1.ayah`;

      this.db.all(sql, params, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }

  // Получить статистику
  async getStatistics() {
    await this.init();

    return new Promise((resolve, reject) => {
      // Получаем количество уникальных сур
      this.db.get(
        `SELECT COUNT(DISTINCT surah) as totalSurahs FROM translations`,
        (err, surahRow) => {
          if (err) {
            reject(err);
            return;
          }

          // Получаем количество уникальных аятов
          this.db.get(
            `SELECT COUNT(DISTINCT surah || ':' || ayah) as totalAyahs FROM translations`,
            (err, ayahRow) => {
              if (err) {
                reject(err);
                return;
              }

              // Получаем общее количество переводов
              this.db.get(
                `SELECT COUNT(*) as totalTranslations FROM translations`,
                (err, transRow) => {
                  if (err) {
                    reject(err);
                    return;
                  }

                  resolve({
                    totalSurahs: surahRow.totalSurahs,
                    totalAyahs: ayahRow.totalAyahs,
                    totalTranslations: transRow.totalTranslations,
                  });
                }
              );
            }
          );
        }
      );
    });
  }

  // Получить следующий аят
  async getNextAyah(surah, ayah) {
    await this.init();

    return new Promise((resolve, reject) => {
      // Сначала ищем в той же суре
      this.db.get(
        `SELECT surah, ayah FROM translations 
         WHERE surah = ? AND ayah > ? 
         GROUP BY surah, ayah
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
            // Если нет больше аятов в этой суре, ищем следующую суру
            this.db.get(
              `SELECT MIN(surah) as nextSurah FROM translations 
               WHERE surah > ?`,
              [surah],
              (err, nextRow) => {
                if (err) {
                  reject(err);
                  return;
                }

                if (nextRow.nextSurah) {
                  // Берем первый аят следующей суры
                  this.db.get(
                    `SELECT MIN(ayah) as firstAyah FROM translations 
                     WHERE surah = ?`,
                    [nextRow.nextSurah],
                    (err, firstRow) => {
                      if (err) {
                        reject(err);
                      } else {
                        resolve({
                          surah: nextRow.nextSurah,
                          ayah: firstRow.firstAyah,
                        });
                      }
                    }
                  );
                } else {
                  // Возвращаем первый аят Корана
                  resolve({ surah: 1, ayah: 1 });
                }
              }
            );
          }
        }
      );
    });
  }

  // Получить предыдущий аят
  async getPreviousAyah(surah, ayah) {
    await this.init();

    return new Promise((resolve, reject) => {
      // Сначала ищем в той же суре
      this.db.get(
        `SELECT surah, ayah FROM translations 
         WHERE surah = ? AND ayah < ? 
         GROUP BY surah, ayah
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
            // Если нет аятов до этого в суре, ищем предыдущую суру
            this.db.get(
              `SELECT MAX(surah) as prevSurah FROM translations 
               WHERE surah < ?`,
              [surah],
              (err, prevRow) => {
                if (err) {
                  reject(err);
                  return;
                }

                if (prevRow.prevSurah) {
                  // Берем последний аят предыдущей суры
                  this.db.get(
                    `SELECT MAX(ayah) as lastAyah FROM translations 
                     WHERE surah = ?`,
                    [prevRow.prevSurah],
                    (err, lastRow) => {
                      if (err) {
                        reject(err);
                      } else {
                        resolve({
                          surah: prevRow.prevSurah,
                          ayah: lastRow.lastAyah,
                        });
                      }
                    }
                  );
                } else {
                  // Возвращаем последний аят Корана
                  this.db.get(
                    `SELECT surah, MAX(ayah) as lastAyah FROM translations 
                     GROUP BY surah 
                     ORDER BY surah DESC LIMIT 1`,
                    (err, lastRow) => {
                      if (err) {
                        reject(err);
                      } else {
                        resolve({
                          surah: lastRow.surah,
                          ayah: lastRow.lastAyah,
                        });
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
}

// Создаем синглтон экземпляр
const dbInstance = new TranslationsDatabase();

// Экспортируем функции для обратной совместимости
async function getKulievTranslation(surah, ayah) {
  return dbInstance.getTranslation(surah, ayah, "kuliev");
}

async function getAbuAdelTranslation(surah, ayah) {
  return dbInstance.getTranslation(surah, ayah, "abuAdel");
}

async function getTranslations(surah, ayah) {
  return dbInstance.getTranslations(surah, ayah);
}

module.exports = {
  // Старые функции для обратной совместимости
  getKulievTranslation,
  getAbuAdelTranslation,
  getTranslations,

  // Новые функции
  getSurahTranslations: (surah) => dbInstance.getSurahTranslations(surah),
  searchTranslations: (query, translator) =>
    dbInstance.searchTranslations(query, translator),
  getStatistics: () => dbInstance.getStatistics(),
  getMetadata: () => dbInstance.getMetadata(),
  getNextAyah: (surah, ayah) => dbInstance.getNextAyah(surah, ayah),
  getPreviousAyah: (surah, ayah) => dbInstance.getPreviousAyah(surah, ayah),

  // Для управления подключением
  initDatabase: () => dbInstance.init(),
  closeDatabase: () => dbInstance.close(),

  // Экспортируем сам класс для продвинутого использования
  TranslationsDatabase,
};
