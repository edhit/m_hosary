// keys-db.js
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");

class KeysDatabase {
  constructor() {
    this.db = null;
    this.initialized = false;
    this.dbPath = path.join(__dirname, "keys.db");
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

  // Получить значение по ключу
  async getValue(key) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.get(
        "SELECT value FROM keys WHERE key = ?",
        [key.toString()],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row ? row.value : null);
          }
        }
      );
    });
  }

  // Получить несколько значений по ключам
  async getValues(keys) {
    await this.init();

    if (!keys.length) return {};

    // Создаем плейсхолдеры для SQL запроса
    const placeholders = keys.map(() => "?").join(",");

    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT key, value FROM keys WHERE key IN (${placeholders})`,
        keys.map((k) => k.toString()),
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            const result = {};
            rows.forEach((row) => {
              result[row.key] = row.value;
            });
            resolve(result);
          }
        }
      );
    });
  }

  // Получить все ключи и значения (с пагинацией)
  async getAll(limit = 100, offset = 0) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.all(
        "SELECT key, value FROM keys LIMIT ? OFFSET ?",
        [limit, offset],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            const result = {};
            rows.forEach((row) => {
              result[row.key] = row.value;
            });
            resolve({
              data: result,
              limit,
              offset,
              hasMore: rows.length === limit,
            });
          }
        }
      );
    });
  }

  // Поиск ключей по шаблону
  async searchKeys(pattern) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.all(
        "SELECT key, value FROM keys WHERE key LIKE ? LIMIT 100",
        [`%${pattern}%`],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            const result = {};
            rows.forEach((row) => {
              result[row.key] = row.value;
            });
            resolve(result);
          }
        }
      );
    });
  }

  // Поиск значений по шаблону
  async searchValues(pattern) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.all(
        "SELECT key, value FROM keys WHERE value LIKE ? LIMIT 100",
        [`%${pattern}%`],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            const result = {};
            rows.forEach((row) => {
              result[row.key] = row.value;
            });
            resolve(result);
          }
        }
      );
    });
  }

  // Получить статистику
  async getStatistics() {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.get("SELECT COUNT(*) as total FROM keys", (err, row) => {
        if (err) {
          reject(err);
          return;
        }

        // Получаем размер базы данных
        fs.stat(this.dbPath, (err, stats) => {
          if (err) {
            resolve({
              totalKeys: row.total,
              databaseSize: "unknown",
            });
          } else {
            const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
            resolve({
              totalKeys: row.total,
              databaseSize: `${sizeMB} MB`,
            });
          }
        });
      });
    });
  }

  // Получить диапазон ключей (например, с 1 по 10)
  async getKeyRange(startKey, endKey) {
    await this.init();

    return new Promise((resolve, reject) => {
      // Если ключи числовые, конвертируем в числа для сравнения
      const start = parseInt(startKey);
      const end = parseInt(endKey);

      if (!isNaN(start) && !isNaN(end)) {
        // Для числовых ключей
        this.db.all(
          "SELECT key, value FROM keys WHERE CAST(key AS INTEGER) BETWEEN ? AND ? ORDER BY CAST(key AS INTEGER)",
          [start, end],
          (err, rows) => {
            if (err) {
              reject(err);
            } else {
              const result = {};
              rows.forEach((row) => {
                result[row.key] = row.value;
              });
              resolve(result);
            }
          }
        );
      } else {
        // Для строковых ключей
        this.db.all(
          "SELECT key, value FROM keys WHERE key BETWEEN ? AND ? ORDER BY key",
          [startKey, endKey],
          (err, rows) => {
            if (err) {
              reject(err);
            } else {
              const result = {};
              rows.forEach((row) => {
                result[row.key] = row.value;
              });
              resolve(result);
            }
          }
        );
      }
    });
  }

  // Проверить существование ключа
  async hasKey(key) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.get(
        "SELECT 1 FROM keys WHERE key = ?",
        [key.toString()],
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

  // Получить все ключи
  async getAllKeys() {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.all("SELECT key FROM keys ORDER BY key", (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows.map((row) => row.key));
        }
      });
    });
  }

  // Экспорт всех данных в JSON (с ограничением)
  async exportToJson(limit = 1000) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.all(
        "SELECT key, value FROM keys LIMIT ?",
        [limit],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            const result = {};
            rows.forEach((row) => {
              result[row.key] = row.value;
            });
            resolve(result);
          }
        }
      );
    });
  }
}

// Создаем синглтон экземпляр
const dbInstance = new KeysDatabase();

// Экспортируем функции
module.exports = {
  // Основные функции
  getValue: (key) => dbInstance.getValue(key),
  getValues: (keys) => dbInstance.getValues(keys),
  getAll: (limit, offset) => dbInstance.getAll(limit, offset),

  // Поиск
  searchKeys: (pattern) => dbInstance.searchKeys(pattern),
  searchValues: (pattern) => dbInstance.searchValues(pattern),

  // Утилиты
  getStatistics: () => dbInstance.getStatistics(),
  getKeyRange: (start, end) => dbInstance.getKeyRange(start, end),
  hasKey: (key) => dbInstance.hasKey(key),
  getAllKeys: () => dbInstance.getAllKeys(),
  exportToJson: (limit) => dbInstance.exportToJson(limit),

  // Управление подключением
  initDatabase: () => dbInstance.init(),
  closeDatabase: () => dbInstance.close(),

  // Экспортируем сам класс
  KeysDatabase,
};
