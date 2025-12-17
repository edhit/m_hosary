// test-tafsir.js
const tafsirDB = require("../db-tafsir");

async function test() {
  try {
    // Инициализируем базу данных
    await tafsirDB.initDatabase();
    console.log("База данных тафсиров инициализирована\n");

    // Получаем метаданные
    const metadata = await tafsirDB.getMetadata();
    console.log("Метаданные:");
    console.log("- Название тафсира:", metadata.tafsirName);
    console.log("- Источник:", metadata.source);
    console.log("- Создано:", metadata.generatedAt);
    console.log("- Обновлено:", metadata.lastUpdated);
    console.log("- Завершено:", metadata.completed === "true" ? "Да" : "Нет");

    // Получаем тафсир (совместимость с оригинальным кодом)
    const tafsir1_1 = await tafsirDB.getTafsir(1, 1);
    console.log("\nТафсир для суры 1, аят 1:");
    console.log(
      tafsir1_1 ? tafsir1_1.substring(0, 100) + "..." : "Нет тафсира"
    );

    const tafsir1_3 = await tafsirDB.getTafsir(1, 3);
    console.log(
      "\nТафсир для суры 1, аят 3:",
      tafsir1_3 ? "Есть" : "Нет (null как в JSON)"
    );

    // Получаем тафсир с информацией
    const tafsirInfo = await tafsirDB.getTafsirWithInfo(1, 2);
    console.log("\nТафсир с информацией для суры 1, аят 2:");
    console.log("- Есть тафсир:", tafsirInfo.hasTafsir);
    console.log(
      "- Длина текста:",
      tafsirInfo.text ? tafsirInfo.text.length : 0
    );

    // Получаем все тафсиры суры
    const surahTafsirs = await tafsirDB.getSurahTafsirs(1);
    console.log(
      `\nТафсиры для суры 1: ${surahTafsirs.length} аятов с тафсиром`
    );

    // Проверяем существование тафсира
    const hasTafsir = await tafsirDB.hasTafsir(1, 1);
    const hasNoTafsir = await tafsirDB.hasTafsir(1, 3);
    console.log("\nПроверка существования тафсиров:");
    console.log("- Сура 1, аят 1:", hasTafsir ? "Есть" : "Нет");
    console.log("- Сура 1, аят 3:", hasNoTafsir ? "Есть" : "Нет");

    // Получаем диапазон тафсиров
    const rangeTafsirs = await tafsirDB.getTafsirsRange(1, 1, 7);
    console.log(
      "\nТафсиры для суры 1, аяты 1-7:",
      Object.keys(rangeTafsirs).length,
      "аятов"
    );

    // Получаем статистику
    const stats = await tafsirDB.getStatistics();
    console.log("\nСтатистика:");
    console.log("- Всего аятов в базе:", stats.totalAyahs);
    console.log("- Аятов с тафсиром:", stats.tafsirsCount);
    console.log("- Покрытие:", stats.coverage);
    console.log("- Диапазон сур:", stats.surahRange);
    console.log("- Диапазон аятов:", stats.ayahRange);
    console.log("- Размер БД:", stats.databaseSize);

    // Навигация
    const nextTafsir = await tafsirDB.getNextTafsir(1, 1);
    console.log(
      "\nСледующий аят с тафсиром после 1:1:",
      nextTafsir ? `Сура ${nextTafsir.surah}, аят ${nextTafsir.ayah}` : "Нет"
    );

    const prevTafsir = await tafsirDB.getPreviousTafsir(1, 2);
    console.log(
      "Предыдущий аят с тафсиром перед 1:2:",
      prevTafsir ? `Сура ${prevTafsir.surah}, аят ${prevTafsir.ayah}` : "Нет"
    );

    // Поиск (простым LIKE)
    const searchResults = await tafsirDB.searchTafsirsSimple("Аллах", 3);
    console.log('\nПоиск по слову "Аллах" (первые 3 результата):');
    searchResults.forEach((result, i) => {
      console.log(
        `  ${i + 1}. Сура ${result.surah}:${result.ayah} - ${result.text}`
      );
    });

    // Экспорт в JSON
    const exportData = await tafsirDB.exportToJson(5);
    console.log("\nЭкспорт первых 5 тафсиров в JSON:");
    Object.entries(exportData).forEach(([surah, ayahs]) => {
      console.log(`  Сура ${surah}: ${Object.keys(ayahs).length} аятов`);
    });

    // Закрываем подключение
    await tafsirDB.closeDatabase();
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
