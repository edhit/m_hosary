// test-users-db.js
const usersDB = require("./users-db");

async function test() {
  try {
    console.log("=== ТЕСТИРОВАНИЕ МОДУЛЯ USERS DATABASE ===\n");

    // Инициализируем базу данных
    await usersDB.initDatabase();
    console.log("✅ База данных пользователей инициализирована\n");

    // 1. Тест добавления/обновления пользователей
    console.log("1. Тест добавления пользователей:");

    // Добавляем тестовых пользователей
    await usersDB.upsertUser(123456789, "Иван", "ivan_user");
    await usersDB.upsertUser(987654321, "Мария", "maria_user");
    await usersDB.upsertUser(555555555, "Алексей", "alexey_user");

    console.log("   Добавлено 3 тестовых пользователя");

    // 2. Тест получения пользователя
    console.log("\n2. Тест получения пользователя:");
    const user = await usersDB.getUser(123456789);
    if (user) {
      console.log("   Найден пользователь:");
      console.log(`   - ID: ${user.telegram_id}`);
      console.log(`   - Имя: ${user.first_name}`);
      console.log(`   - Username: ${user.username}`);
      console.log(`   - Запросов: ${user.requests_count}`);
      console.log(`   - Последний раз: ${user.last_seen}`);
    } else {
      console.log("   ❌ Пользователь не найден");
    }

    // 3. Тест обновления пользователя
    console.log("\n3. Тест обновления пользователя:");
    await usersDB.upsertUser(123456789, "Иван Петров", "ivan_new");
    const updatedUser = await usersDB.getUser(123456789);
    console.log("   Имя обновлено:", updatedUser.first_name);
    console.log("   Username обновлен:", updatedUser.username);
    console.log(
      "   Количество запросов увеличено:",
      updatedUser.requests_count
    );

    // 4. Тест получения всех пользователей
    console.log("\n4. Тест получения всех пользователей:");
    const allUsers = await usersDB.getAllUsers(5);
    console.log(`   Всего пользователей: ${allUsers.length}`);
    console.log("   Первые 3 пользователя:");
    allUsers.slice(0, 3).forEach((u, i) => {
      console.log(
        `   ${i + 1}. ${u.first_name} (@${u.username}) - ${
          u.requests_count
        } запросов`
      );
    });

    // 5. Тест статистики
    console.log("\n5. Тест статистики:");
    const stats = await usersDB.getStatistics();
    console.log("   Статистика пользователей:");
    console.log(`   - Всего пользователей: ${stats.total_users}`);
    console.log(`   - С username: ${stats.with_username}`);
    console.log(`   - Активных сегодня: ${stats.active_last_day}`);
    console.log(`   - Активных за неделю: ${stats.active_last_week}`);
    console.log(`   - Среднее запросов: ${Math.round(stats.avg_requests)}`);
    console.log(`   - Макс запросов: ${stats.max_requests}`);

    // 6. Тест топа пользователей
    console.log("\n6. Тест топа пользователей:");
    const topUsers = await usersDB.getTopUsers(3);
    console.log("   Топ 3 пользователей по запросам:");
    topUsers.forEach((user, i) => {
      console.log(
        `   ${i + 1}. ${user.first_name} (@${user.username}): ${
          user.requests_count
        } запросов`
      );
    });

    // 7. Тест поиска пользователей
    console.log("\n7. Тест поиска пользователей:");
    const searchResults = await usersDB.searchUsersByName("Иван", 5);
    console.log(
      `   Найдено пользователей по запросу "Иван": ${searchResults.length}`
    );

    // 8. Тест количества пользователей
    console.log("\n8. Тест количества пользователей:");
    const userCount = await usersDB.getUserCount();
    console.log(`   Общее количество пользователей: ${userCount}`);

    // 9. Тест экспорта данных
    console.log("\n9. Тест экспорта данных:");
    const exportData = await usersDB.exportToJson(2);
    console.log(`   Экспортировано записей: ${exportData.length}`);
    console.log("   Пример экспортированных данных:");
    exportData.forEach((user, i) => {
      console.log(`   ${i + 1}. ${user.first_name} (@${user.username})`);
    });

    // 10. Тест очистки неактивных пользователей
    console.log("\n10. Тест очистки неактивных пользователей:");
    const cleaned = await usersDB.cleanupInactiveUsers(0); // Тестовая очистка
    console.log(`   Удалено пользователей: ${cleaned}`);

    // 11. Тест добавления большого количества пользователей
    console.log("\n11. Тест добавления 10 пользователей:");
    for (let i = 1; i <= 10; i++) {
      await usersDB.upsertUser(
        1000000000 + i,
        `Тест${i}`,
        i % 2 === 0 ? `test_user_${i}` : null
      );
    }
    const newCount = await usersDB.getUserCount();
    console.log(`   Теперь пользователей: ${newCount}`);

    // Закрываем подключение
    await usersDB.closeDatabase();
    console.log("\n✅ Все тесты пройдены успешно!");
    console.log("\n=== ТЕСТИРОВАНИЕ ЗАВЕРШЕНО ===");
  } catch (error) {
    console.error("\n❌ Ошибка при тестировании:", error);
    console.error(error.stack);

    try {
      await usersDB.closeDatabase();
    } catch (closeError) {
      console.error("Ошибка при закрытии базы данных:", closeError);
    }
  }
}

// Запускаем тест
if (require.main === module) {
  console.log("Запуск тестов модуля users database...\n");
  test().catch(console.error);
}

module.exports = { test };
