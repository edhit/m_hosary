// redis-limits.js
const Redis = require("ioredis");

class RedisLimiter {
  constructor() {
    this.redisClient = null;
    this.initialized = false;
    this.config = {
      redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
      // Лимиты по умолчанию
      limits: {
        perMinute: parseInt(process.env.REQUESTS_PER_MINUTE) || 10,
        perHour: parseInt(process.env.REQUESTS_PER_HOUR) || 50,
        perDay: parseInt(process.env.REQUESTS_PER_DAY) || 200,
        audioPerHour: parseInt(process.env.AUDIO_PER_HOUR) || 5,
        audioPerDay: parseInt(process.env.AUDIO_PER_DAY) || 20,
      },
      // Время блокировки при превышении лимитов
      banDurations: {
        minute: 60 * 1000, // 1 минута
        hour: 60 * 60 * 1000, // 1 час
        day: 24 * 60 * 60 * 1000, // 1 день
      },
    };
  }

  // Инициализация Redis
  async init() {
    if (this.initialized) return;

    try {
      this.redisClient = new Redis(this.config.redisUrl, {
        retryStrategy: (times) => {
          const delay = Math.min(times * 50, 2000);
          return delay;
        },
        maxRetriesPerRequest: 3,
      });

      // Проверка подключения
      await this.redisClient.ping();

      this.initialized = true;
      console.log("✅ Redis limiter initialized");
    } catch (error) {
      console.error("❌ Failed to initialize Redis limiter:", error);
      throw error;
    }
  }

  // Закрытие соединения
  async close() {
    if (this.redisClient) {
      await this.redisClient.quit();
      this.initialized = false;
    }
  }

  // Генерация ключей для Redis
  getKeys(userId, type = "request") {
    const now = Date.now();
    const minute = Math.floor(now / 60000);
    const hour = Math.floor(now / 3600000);
    const day = Math.floor(now / 86400000);

    return {
      minute: `limit:${type}:${userId}:minute:${minute}`,
      hour: `limit:${type}:${userId}:hour:${hour}`,
      day: `limit:${type}:${userId}:day:${day}`,
      ban: `limit:ban:${userId}`,
    };
  }

  // Проверка и увеличение счетчика
  async checkAndIncrement(userId, type = "request") {
    await this.init();

    function formatShortTime(ms) {
      const seconds = Math.floor(ms / 1000);

      if (seconds < 60) {
        return `${seconds}с`;
      }

      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) {
        return `${minutes}м`;
      }

      const hours = Math.floor(minutes / 60);
      if (hours < 24) {
        return `${hours}ч`;
      }

      const days = Math.floor(hours / 24);
      return `${days}д`;
    }

    const keys = this.getKeys(userId, type);

    try {
      // Проверяем, забанен ли пользователь
      const isBanned = await this.redisClient.get(keys.ban);
      if (isBanned) {
        const banData = JSON.parse(isBanned);
        if (Date.now() < banData.expires) {
          return {
            allowed: false,
            reason: "banned",
            remaining: 0,
            reset: banData.expires,
            message: `🚫 Повторите попытку через: ${formatShortTime(
              banData.expires - Date.now()
            )} | ${banData.reason}`,
          };
        } else {
          // Удаляем истекший бан
          await this.redisClient.del(keys.ban);
        }
      }

      // Используем транзакцию для атомарных операций
      const multi = this.redisClient.multi();

      // INCR для каждого интервала
      multi.incr(keys.minute);
      multi.incr(keys.hour);
      multi.incr(keys.day);

      // Устанавливаем TTL для ключей
      multi.expire(keys.minute, 60); // 60 секунд
      multi.expire(keys.hour, 3600); // 1 час
      multi.expire(keys.day, 86400); // 24 часа

      // Получаем значения
      const results = await multi.exec();
      const [minuteCount, hourCount, dayCount] = results.map((r) => r[1]);

      // Получаем лимиты для типа
      const limits =
        type === "audio"
          ? {
              minute: this.config.limits.audioPerHour / 60, // Примерное распределение
              hour: this.config.limits.audioPerHour,
              day: this.config.limits.audioPerDay,
            }
          : this.config.limits;

      // Проверяем превышение лимитов
      if (minuteCount > limits.perMinute) {
        await this.banUser(
          userId,
          "minute_limit",
          this.config.banDurations.minute
        );
        return {
          allowed: false,
          reason: "minute_limit",
          remaining: 0,
          reset: Date.now() + 60000 - (Date.now() % 60000),
          message: "Слишком много запросов в минуту. Подождите 1 минуту.",
        };
      }

      if (hourCount > limits.perHour) {
        await this.banUser(userId, "hour_limit", this.config.banDurations.hour);
        return {
          allowed: false,
          reason: "hour_limit",
          remaining: 0,
          reset: Date.now() + 3600000 - (Date.now() % 3600000),
          message: "Превышен часовой лимит запросов. Попробуйте через час.",
        };
      }

      if (dayCount > limits.perDay) {
        await this.banUser(userId, "day_limit", this.config.banDurations.day);
        return {
          allowed: false,
          reason: "day_limit",
          remaining: 0,
          reset: Date.now() + 86400000 - (Date.now() % 86400000),
          message: "Превышен дневной лимит запросов. Попробуйте завтра.",
        };
      }

      // Если все ок, возвращаем информацию о лимитах
      return {
        allowed: true,
        remaining: {
          minute: Math.max(0, limits.perMinute - minuteCount),
          hour: Math.max(0, limits.perHour - hourCount),
          day: Math.max(0, limits.perDay - dayCount),
        },
        limits: {
          minute: limits.perMinute,
          hour: limits.perHour,
          day: limits.perDay,
        },
        reset: {
          minute: Date.now() + 60000 - (Date.now() % 60000),
          hour: Date.now() + 3600000 - (Date.now() % 3600000),
          day: Date.now() + 86400000 - (Date.now() % 86400000),
        },
      };
    } catch (error) {
      console.error("Redis limiter error:", error);
      // В случае ошибки Redis разрешаем запрос (fail-open стратегия)
      return {
        allowed: true,
        error: true,
        message: "Система лимитов временно недоступна",
      };
    }
  }

  // Бан пользователя
  async banUser(userId, reason, duration) {
    try {
      const banData = {
        reason,
        bannedAt: Date.now(),
        expires: Date.now() + duration,
      };

      await this.redisClient.setex(
        `limit:ban:${userId}`,
        Math.ceil(duration / 1000),
        JSON.stringify(banData)
      );
    } catch (error) {
      console.error("Error banning user:", error);
    }
  }

  // Разбан пользователя
  async unbanUser(userId) {
    try {
      await this.redisClient.del(`limit:ban:${userId}`);
    } catch (error) {
      console.error("Error unbanning user:", error);
    }
  }

  // Получение статистики по пользователю
  async getUserStats(userId) {
    await this.init();

    try {
      const keys = this.getKeys(userId);
      const multi = this.redisClient.multi();

      multi.get(keys.minute);
      multi.get(keys.hour);
      multi.get(keys.day);
      multi.get(keys.ban);
      multi.ttl(keys.minute);
      multi.ttl(keys.hour);
      multi.ttl(keys.day);

      const results = await multi.exec();

      return {
        minute: parseInt(results[0][1]) || 0,
        hour: parseInt(results[1][1]) || 0,
        day: parseInt(results[2][1]) || 0,
        banned: results[3][1] ? JSON.parse(results[3][1]) : null,
        ttl: {
          minute: results[4][1],
          hour: results[5][1],
          day: results[6][1],
        },
      };
    } catch (error) {
      console.error("Error getting user stats:", error);
      return null;
    }
  }

  // Сброс лимитов для пользователя
  async resetUserLimits(userId) {
    await this.init();

    try {
      const keys = this.getKeys(userId);
      const multi = this.redisClient.multi();

      multi.del(keys.minute);
      multi.del(keys.hour);
      multi.del(keys.day);
      multi.del(keys.ban);

      // Также удаляем все ключи для аудио
      const audioKeys = this.getKeys(userId, "audio");
      multi.del(audioKeys.minute);
      multi.del(audioKeys.hour);
      multi.del(audioKeys.day);

      await multi.exec();
      return true;
    } catch (error) {
      console.error("Error resetting user limits:", error);
      return false;
    }
  }

  // Получение глобальной статистики
  async getGlobalStats() {
    await this.init();

    try {
      const keys = await this.redisClient.keys("limit:*");
      const bannedUsers = await this.redisClient.keys("limit:ban:*");

      return {
        totalKeys: keys.length,
        bannedUsers: bannedUsers.length,
        memoryInfo: await this.redisClient.info("memory"),
      };
    } catch (error) {
      console.error("Error getting global stats:", error);
      return null;
    }
  }

  // Проверка доступности Redis
  async healthCheck() {
    try {
      await this.init();
      const result = await this.redisClient.ping();
      return result === "PONG";
    } catch (error) {
      return false;
    }
  }
}

// Создаем синглтон экземпляр
const limiter = new RedisLimiter();

module.exports = limiter;
