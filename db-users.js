// users-db.js
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

class UsersDatabase {
  constructor() {
    this.db = null;
    this.initialized = false;
    this.dbPath = path.join(__dirname, "users.db");
  }

  // Инициализация подключения и создание таблиц
  async init() {
    if (this.initialized) return;

    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) {
          reject(
            new Error(
              `Не удалось открыть базу данных ${this.dbPath}: ${err.message}`
            )
          );
          return;
        }

        // Включаем WAL режим для лучшей производительности
        this.db.run("PRAGMA journal_mode = WAL", () => {
          this.db.run("PRAGMA synchronous = NORMAL", () => {
            this.db.run("PRAGMA cache_size = 10000", () => {
              // Создаем таблицу пользователей с полем translate
              this.db.run(
                `
                CREATE TABLE IF NOT EXISTS users (
                  id INTEGER PRIMARY KEY,
                  telegram_id INTEGER UNIQUE NOT NULL,
                  first_name TEXT,
                  username TEXT,
                  last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  requests_count INTEGER DEFAULT 0,
                  translate TEXT
                )
              `,
                (err) => {
                  if (err) {
                    reject(err);
                    return;
                  }

                  // Добавляем поле translate, если его нет (для совместимости с существующими БД)
                  this.db.run(
                    "ALTER TABLE users ADD COLUMN translate TEXT DEFAULT NULL",
                    () => {
                      // Игнорируем ошибку, если поле уже существует
                    }
                  );

                  // Создаем индексы для быстрого поиска
                  this.db.run(
                    "CREATE INDEX IF NOT EXISTS idx_telegram_id ON users(telegram_id)",
                    () => {
                      this.db.run(
                        "CREATE INDEX IF NOT EXISTS idx_username ON users(username)",
                        () => {
                          // Создаем индекс для поля translate, если нужно
                          this.db.run(
                            "CREATE INDEX IF NOT EXISTS idx_translate ON users(translate)",
                            () => {
                              this.initialized = true;
                              resolve();
                            }
                          );
                        }
                      );
                    }
                  );
                }
              );
            });
          });
        });
      });
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

  // Добавить или обновить пользователя
  async upsertUser(telegramId, firstName, username, translate = null) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.run(
        `
        INSERT INTO users (telegram_id, first_name, username, translate, last_seen, created_at, requests_count)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, COALESCE((SELECT created_at FROM users WHERE telegram_id = ?), CURRENT_TIMESTAMP), COALESCE((SELECT requests_count FROM users WHERE telegram_id = ?), 0))
        ON CONFLICT(telegram_id) DO UPDATE SET
          first_name = excluded.first_name,
          username = excluded.username,
          translate = COALESCE(excluded.translate, translate),
          last_seen = CURRENT_TIMESTAMP,
          requests_count = requests_count + 1
      `,
        [telegramId, firstName, username, translate, telegramId, telegramId],
        (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        }
      );
    });
  }

  // Получить пользователя по telegram_id
  async getUser(telegramId) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.get(
        "SELECT * FROM users WHERE telegram_id = ?",
        [telegramId],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row || null);
          }
        }
      );
    });
  }

  // Получить всех пользователей
  async getAllUsers(limit = 100, offset = 0) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.all(
        "SELECT * FROM users ORDER BY last_seen DESC LIMIT ? OFFSET ?",
        [limit, offset],
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

  // Получить пользователей по имени
  async searchUsersByName(name, limit = 50) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.all(
        "SELECT * FROM users WHERE first_name LIKE ? OR username LIKE ? ORDER BY last_seen DESC LIMIT ?",
        [`%${name}%`, `%${name}%`, limit],
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

  // Получить пользователей по значению translate
  async searchUsersByTranslate(translateValue, limit = 50) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.all(
        "SELECT * FROM users WHERE translate LIKE ? ORDER BY last_seen DESC LIMIT ?",
        [`%${translateValue}%`, limit],
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

  // Получить пользователей с определенным значением translate
  async getUsersWithTranslate(translateValue = null) {
    await this.init();

    return new Promise((resolve, reject) => {
      if (translateValue === null) {
        // Получить пользователей с любым значением translate
        this.db.all(
          "SELECT * FROM users WHERE translate IS NOT NULL ORDER BY last_seen DESC",
          (err, rows) => {
            if (err) {
              reject(err);
            } else {
              resolve(rows);
            }
          }
        );
      } else {
        // Получить пользователей с конкретным значением translate
        this.db.all(
          "SELECT * FROM users WHERE translate = ? ORDER BY last_seen DESC",
          [translateValue],
          (err, rows) => {
            if (err) {
              reject(err);
            } else {
              resolve(rows);
            }
          }
        );
      }
    });
  }

  // Обновить поле translate для пользователя
  async updateTranslate(telegramId, translate) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.run(
        "UPDATE users SET translate = ?, last_seen = CURRENT_TIMESTAMP WHERE telegram_id = ?",
        [translate, telegramId],
        function (err) {
          if (err) {
            reject(err);
          } else {
            resolve(this.changes > 0);
          }
        }
      );
    });
  }

  // Получить статистику пользователей (обновленная версия с учетом translate)
  async getStatistics() {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.get(
        `
        SELECT 
          COUNT(*) as total_users,
          COUNT(CASE WHEN username IS NOT NULL THEN 1 END) as with_username,
          COUNT(CASE WHEN translate IS NOT NULL THEN 1 END) as with_translate,
          COUNT(DISTINCT translate) as unique_translates,
          COUNT(CASE WHEN strftime('%s', 'now') - strftime('%s', last_seen) < 86400 THEN 1 END) as active_last_day,
          COUNT(CASE WHEN strftime('%s', 'now') - strftime('%s', last_seen) < 604800 THEN 1 END) as active_last_week,
          COUNT(CASE WHEN requests_count > 0 THEN 1 END) as active_users,
          AVG(requests_count) as avg_requests,
          MAX(requests_count) as max_requests
        FROM users
      `,
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row);
          }
        }
      );
    });
  }

  // Получить топ пользователей по количеству запросов
  async getTopUsers(limit = 10) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.all(
        "SELECT telegram_id, first_name, username, translate, requests_count, last_seen FROM users ORDER BY requests_count DESC LIMIT ?",
        [limit],
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

  // Получить популярные значения translate
  async getPopularTranslates(limit = 10) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.all(
        `
        SELECT translate, COUNT(*) as user_count, 
               SUM(requests_count) as total_requests,
               MAX(requests_count) as max_requests
        FROM users 
        WHERE translate IS NOT NULL
        GROUP BY translate 
        ORDER BY user_count DESC, total_requests DESC
        LIMIT ?
        `,
        [limit],
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

  // Удалить пользователя
  async deleteUser(telegramId) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.run(
        "DELETE FROM users WHERE telegram_id = ?",
        [telegramId],
        function (err) {
          if (err) {
            reject(err);
          } else {
            resolve(this.changes > 0);
          }
        }
      );
    });
  }

  // Очистить неактивных пользователей (старше N дней)
  async cleanupInactiveUsers(days = 30) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.run(
        'DELETE FROM users WHERE strftime("%s", "now") - strftime("%s", last_seen) > ?',
        [days * 86400],
        function (err) {
          if (err) {
            reject(err);
          } else {
            resolve(this.changes);
          }
        }
      );
    });
  }

  // Получить количество пользователей
  async getUserCount() {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.get("SELECT COUNT(*) as count FROM users", (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row.count);
        }
      });
    });
  }

  // Экспорт данных пользователей в JSON
  async exportToJson(limit = 1000) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.all(
        "SELECT telegram_id, first_name, username, translate, last_seen, created_at, requests_count FROM users LIMIT ?",
        [limit],
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

  // Получить пользователей, созданных за период
  async getUsersByPeriod(startDate, endDate) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.all(
        "SELECT * FROM users WHERE created_at BETWEEN ? AND ? ORDER BY created_at DESC",
        [startDate, endDate],
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

  // Получить пользователей по значению translate за период
  async getUsersByTranslateAndPeriod(translateValue, startDate, endDate) {
    await this.init();

    return new Promise((resolve, reject) => {
      this.db.all(
        "SELECT * FROM users WHERE translate = ? AND created_at BETWEEN ? AND ? ORDER BY created_at DESC",
        [translateValue, startDate, endDate],
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
}

// Создаем синглтон экземпляр
const dbInstance = new UsersDatabase();

// Экспортируем функции
module.exports = {
  // Основные функции
  upsertUser: (telegramId, firstName, username, translate) =>
    dbInstance.upsertUser(telegramId, firstName, username, translate),
  getUser: (telegramId) => dbInstance.getUser(telegramId),
  getAllUsers: (limit, offset) => dbInstance.getAllUsers(limit, offset),

  // Функции для работы с translate
  updateTranslate: (telegramId, translate) =>
    dbInstance.updateTranslate(telegramId, translate),
  searchUsersByTranslate: (translateValue, limit) =>
    dbInstance.searchUsersByTranslate(translateValue, limit),
  getUsersWithTranslate: (translateValue) =>
    dbInstance.getUsersWithTranslate(translateValue),
  getPopularTranslates: (limit) => dbInstance.getPopularTranslates(limit),

  // Поиск и статистика
  searchUsersByName: (name, limit) => dbInstance.searchUsersByName(name, limit),
  getStatistics: () => dbInstance.getStatistics(),
  getTopUsers: (limit) => dbInstance.getTopUsers(limit),
  getUserCount: () => dbInstance.getUserCount(),
  getUsersByPeriod: (startDate, endDate) =>
    dbInstance.getUsersByPeriod(startDate, endDate),
  getUsersByTranslateAndPeriod: (translateValue, startDate, endDate) =>
    dbInstance.getUsersByTranslateAndPeriod(translateValue, startDate, endDate),

  // Административные функции
  deleteUser: (telegramId) => dbInstance.deleteUser(telegramId),
  cleanupInactiveUsers: (days) => dbInstance.cleanupInactiveUsers(days),
  exportToJson: (limit) => dbInstance.exportToJson(limit),

  // Управление подключением
  initDatabase: () => dbInstance.init(),
  closeDatabase: () => dbInstance.close(),

  // Экспортируем сам класс
  UsersDatabase,
};
