// test-keys.js
const keysDB = require("./../db-keys");

async function test() {
  try {
    // Инициализируем базу данных
    await keysDB.initDatabase();
    console.log("База данных инициализирована\n");

    // Получаем значение по ключу
    const value1 = await keysDB.getValue("1");
    console.log(
      'Значение для ключа "1":',
      value1 ? value1.substring(0, 50) + "..." : "Не найдено"
    );

    const value12 = await keysDB.getValue("12");
    console.log(
      'Значение для ключа "12":',
      value12 ? value12.substring(0, 50) + "..." : "Не найдено"
    );

    // Получаем несколько значений
    const values = await keysDB.getValues(["1", "2", "3", "100"]);
    console.log("\nПолучено значений:", Object.keys(values).length);
    console.log("Ключи:", Object.keys(values));

    // Проверяем существование ключа
    const hasKey = await keysDB.hasKey("5");
    console.log('\nКлюч "5" существует:', hasKey);

    const hasKey999 = await keysDB.hasKey("999");
    console.log('Ключ "999" существует:', hasKey999);

    // Получаем диапазон ключей
    const range = await keysDB.getKeyRange("1", "5");
    console.log("\nДиапазон 1-5 содержит ключей:", Object.keys(range).length);

    // Поиск по ключам
    const search = await keysDB.searchKeys("1");
    console.log(
      '\nПоиск ключей с "1":',
      Object.keys(search).length,
      "результатов"
    );

    // Получаем статистику
    const stats = await keysDB.getStatistics();
    console.log("\nСтатистика:");
    console.log("- Всего ключей:", stats.totalKeys);
    console.log("- Размер БД:", stats.databaseSize);

    // Получаем все ключи
    const allKeys = await keysDB.getAllKeys();
    console.log("\nПервые 10 ключей:", allKeys.slice(0, 10));

    // Экспорт в JSON (ограничено)
    const exportData = await keysDB.exportToJson(5);
    console.log("\nЭкспорт первых 5 записей:");
    Object.entries(exportData).forEach(([key, value]) => {
      console.log(`  ${key}: ${value.substring(0, 30)}...`);
    });

    // Закрываем подключение
    await keysDB.closeDatabase();
    console.log("\nТестирование завершено успешно!");
  } catch (error) {
    console.error("Ошибка при тестировании:", error);
  }
}

// Запускаем тест
if (require.main === module) {
  test();
}

module.exports = { test };
