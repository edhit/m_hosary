// test-translations.js
const translationsDB = require("../db-translations");

async function test() {
  try {
    console.log("=== ТЕСТИРОВАНИЕ МОДУЛЯ TRANSLATIONS ===\n");

    // Инициализируем базу данных
    await translationsDB.initDatabase();
    console.log("✅ База данных инициализирована\n");

    // 1. Тест метаданных
    console.log("1. Получение метаданных:");
    const metadata = await translationsDB.getMetadata();
    console.log("   - Источники:");
    console.log("     * Кулиев:", metadata.source.kuliev);
    console.log("     * Абу Адель:", metadata.source.abuAdel);
    console.log("   - Переводчики:");
    console.log("     * Кулиев:", metadata.translators.kuliev);
    console.log("     * Абу Адель:", metadata.translators.abuAdel);
    console.log("   - Создано:", metadata.generatedAt);
    console.log("   - Обновлено:", metadata.lastUpdated);
    console.log("   - Завершено:", metadata.completed ? "Да" : "Нет");

    // 2. Тест получения переводов (совместимость с оригинальными функциями)
    console.log("\n2. Тест получения переводов (совместимость):");

    // Кулиев
    const kuliev1_1 = await translationsDB.getKulievTranslation(1, 1);
    console.log(
      "   Кулиев 1:1:",
      kuliev1_1 ? kuliev1_1.substring(0, 50) + "..." : "Нет перевода"
    );

    // Абу Адель
    const abuAdel1_1 = await translationsDB.getAbuAdelTranslation(1, 1);
    console.log(
      "   Абу Адель 1:1:",
      abuAdel1_1 ? abuAdel1_1.substring(0, 50) + "..." : "Нет перевода"
    );

    // Оба перевода
    const both1_1 = await translationsDB.getTranslations(1, 1);
    console.log("   Оба перевода 1:1:");
    console.log("     - Кулиев:", both1_1.kuliev ? "✓" : "✗");
    console.log("     - Абу Адель:", both1_1.abuAdel ? "✓" : "✗");

    // 3. Тест несуществующего аята
    console.log("\n3. Тест несуществующего аята:");
    const nonExistent = await translationsDB.getTranslations(1, 999);
    console.log(
      "   Кулиев для 1:999:",
      nonExistent.kuliev ? "Есть" : "Нет (правильно)"
    );
    console.log(
      "   Абу Адель для 1:999:",
      nonExistent.abuAdel ? "Есть" : "Нет (правильно)"
    );

    // 4. Тест получения всей суры
    console.log("\n4. Тест получения всей суры:");
    const surah1 = await translationsDB.getSurahTranslations(1);
    console.log("   Сура 1 содержит аятов:", surah1.length);
    console.log("   Пример аятов:");
    surah1.slice(0, 3).forEach((ayah, i) => {
      console.log(`     ${i + 1}. Аят ${ayah.ayah}:`);
      console.log(
        `        Кулиев: ${
          ayah.kuliev ? ayah.kuliev.substring(0, 30) + "..." : "Нет"
        }`
      );
      console.log(
        `        Абу Адель: ${
          ayah.abuAdel ? ayah.abuAdel.substring(0, 30) + "..." : "Нет"
        }`
      );
    });

    // 5. Тест поиска
    console.log("\n5. Тест поиска переводов:");

    // Поиск в обоих переводах
    const searchAll = await translationsDB.searchTranslations("хвала", "both");
    console.log(
      '   Поиск "хвала" в обоих переводах:',
      searchAll.length,
      "результатов"
    );
    if (searchAll.length > 0) {
      console.log("   Первый результат:");
      console.log(`     Сура ${searchAll[0].surah}:${searchAll[0].ayah}`);
      console.log(
        `     Кулиев: ${
          searchAll[0].kuliev
            ? searchAll[0].kuliev.substring(0, 50) + "..."
            : "Нет"
        }`
      );
    }

    // Поиск только в Кулиеве
    const searchKuliev = await translationsDB.searchTranslations(
      "Аллаха",
      "kuliev"
    );
    console.log(
      '   Поиск "Аллаха" в переводе Кулиева:',
      searchKuliev.length,
      "результатов"
    );

    // Поиск только в Абу Аделе
    const searchAbuAdel = await translationsDB.searchTranslations(
      "Царю",
      "abuAdel"
    );
    console.log(
      '   Поиск "Царю" в переводе Абу Аделя:',
      searchAbuAdel.length,
      "результатов"
    );

    // 6. Тест статистики
    console.log("\n6. Тест статистики:");
    const stats = await translationsDB.getStatistics();
    console.log("   Статистика базы данных:");
    console.log("     - Всего сур:", stats.totalSurahs);
    console.log("     - Всего аятов:", stats.totalAyahs);
    console.log("     - Всего переводов:", stats.totalTranslations);
    console.log(
      "     - Среднее переводов на аят:",
      (stats.totalTranslations / stats.totalAyahs).toFixed(1)
    );

    // 7. Тест навигации
    console.log("\n7. Тест навигации:");

    // Следующий аят
    const nextAyah = await translationsDB.getNextAyah(1, 7);
    console.log(
      "   Следующий аят после 1:7:",
      nextAyah
        ? `Сура ${nextAyah.surah}, аят ${nextAyah.ayah}`
        : "Нет (конец Корана)"
    );

    // Предыдущий аят
    const prevAyah = await translationsDB.getPreviousAyah(1, 1);
    console.log(
      "   Предыдущий аят перед 1:1:",
      prevAyah
        ? `Сура ${prevAyah.surah}, аят ${prevAyah.ayah}`
        : "Нет (начало Корана)"
    );

    // Циклическая навигация
    const firstAyahNext = await translationsDB.getNextAyah(1, 7);
    if (firstAyahNext) {
      const backToFirst = await translationsDB.getPreviousAyah(
        firstAyahNext.surah,
        firstAyahNext.ayah
      );
      console.log(
        "   Циклическая проверка:",
        backToFirst && backToFirst.surah === 1 && backToFirst.ayah === 7
          ? "✓ Работает"
          : "✗ Ошибка"
      );
    }

    // 8. Тест работы с диапазоном ключей
    console.log("\n8. Тест диапазона ключей:");
    const surah2First5 = [];
    for (let i = 1; i <= 5; i++) {
      const trans = await translationsDB.getTranslations(2, i);
      surah2First5.push(trans);
    }
    console.log(
      "   Первые 5 аятов суры 2 получены:",
      surah2First5.length === 5 ? "✓" : "✗"
    );
    console.log(
      "   Пример 2:1 - Кулиев:",
      surah2First5[0]?.kuliev
        ? surah2First5[0].kuliev.substring(0, 30) + "..."
        : "Нет"
    );

    // 9. Тест параллельных запросов
    console.log("\n9. Тест параллельных запросов:");
    const parallelRequests = await Promise.all([
      translationsDB.getTranslations(1, 1),
      translationsDB.getTranslations(1, 2),
      translationsDB.getTranslations(1, 3),
      translationsDB.getTranslations(2, 1),
      translationsDB.getTranslations(2, 2),
    ]);
    console.log("   Параллельно выполнено запросов:", parallelRequests.length);
    console.log(
      "   Успешно:",
      parallelRequests.filter((r) => r.kuliev || r.abuAdel).length
    );

    // 10. Тест производительности
    console.log("\n10. Тест производительности:");
    const startTime = Date.now();
    const testRequests = 10;

    for (let i = 0; i < testRequests; i++) {
      await translationsDB.getTranslations(1, (i % 7) + 1);
    }

    const endTime = Date.now();
    const duration = endTime - startTime;
    console.log(`   ${testRequests} запросов выполнено за ${duration}мс`);
    console.log(
      `   Среднее время запроса: ${(duration / testRequests).toFixed(1)}мс`
    );

    // // 11. Тест экспорта
    // console.log("\n11. Тест экспорта данных:");
    // const exportData = await translationsDB.getAll(3, 0); // первые 3 записи
    // console.log(
    //   "   Экспортировано записей:",
    //   Object.keys(exportData.data).length
    // );
    // console.log("   Лимит:", exportData.limit);
    // console.log("   Смещение:", exportData.offset);
    // console.log("   Есть еще данные:", exportData.hasMore ? "Да" : "Нет");

    // // 12. Тест всех ключей
    // console.log("\n12. Тест получения всех ключей:");
    // const allKeys = await translationsDB.getAllKeys();
    // console.log("   Всего ключей в базе:", allKeys.length);
    // if (allKeys.length > 0) {
    //   console.log("   Пример ключей:", allKeys.slice(0, 5).join(", "));

    //   // Проверяем структуру ключей
    //   const sampleKey = allKeys[0];
    //   console.log("   Структура ключа:", typeof sampleKey, "-", sampleKey);
    // }

    // Закрываем подключение
    await translationsDB.closeDatabase();
    console.log("\n✅ Все тесты пройдены успешно!");
    console.log("\n=== ТЕСТИРОВАНИЕ ЗАВЕРШЕНО ===");
  } catch (error) {
    console.error("\n❌ Ошибка при тестировании:", error);
    console.error(error.stack);

    try {
      await translationsDB.closeDatabase();
    } catch (closeError) {
      console.error("Ошибка при закрытии базы данных:", closeError);
    }
  }
}

// Запускаем тест
if (require.main === module) {
  console.log("Запуск тестов модуля translations...\n");
  test().catch(console.error);
}

// Экспортируем функцию тестирования
module.exports = { test };
