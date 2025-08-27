const logger = require('../../utils/logger'); // Предполагается, что у вас есть логгер

module.exports = (ALLOWED_USER_ID) => {
  return async (ctx, next) => {
    try {
      if (!ALLOWED_USER_ID || ctx.from?.id?.toString() !== ALLOWED_USER_ID) {
        return;
      }
      await next();
    } catch (err) {
      logger.error(`Middleware error: ${err.message}`);
      ctx.reply("⚠️ Ошибка проверки доступа.");
    }
  };
};