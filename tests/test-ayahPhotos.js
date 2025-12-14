// test-ayah-photos-db.js
const ayahPhotosDB = require("../db-ayah-photos");

async function test() {
  try {
    console.log("=== ТЕСТИРОВАНИЕ МОДУЛЯ AYAH PHOTOS DATABASE ===\n");

    // Инициализируем базу данных
    await ayahPhotosDB.initDatabase();
    console.log("✅ База данных фото аятов инициализирована\n");

    // 1. Тест получения фото для аята
    console.log("1. Тест получения фото для аята:");

    // Предполагаем, что фото для суры 1
    const photo1_1 = await ayahPhotosDB.getAyahPhoto(20, 1);
    console.log(
      "   Фото для суры 1, аят 1:",
      photo1_1 ? photo1_1.substring(0, 30) + "..." : "Нет фото"
    );

    const photo1_2 = await ayahPhotosDB.getAyahPhoto(1, 2);
    console.log(
      "   Фото для суры 1, аят 2:",
      photo1_2 ? photo1_2.substring(0, 30) + "..." : "Нет фото"
    );

    // 2. Тест получения нескольких фото
    console.log("\n2. Тест получения нескольких фото:");
    const photos = await ayahPhotosDB.getAyahPhotos(1, [1, 2, 3, 4, 5]);
    console.log(
      `   Получено фото для аятов 1-5: ${Object.keys(photos).length} фото`
    );

    // 3. Тест проверки существования фото
    console.log("\n3. Тест проверки существования фото:");
    const hasPhoto1_1 = await ayahPhotosDB.hasAyahPhoto(1, 1);
    const hasPhoto1_999 = await ayahPhotosDB.hasAyahPhoto(1, 999);
    console.log("   Есть фото для 1:1:", hasPhoto1_1 ? "Да" : "Нет");
    console.log("   Есть фото для 1:999:", hasPhoto1_999 ? "Да" : "Нет");

    // 4. Тест получения всех фото суры
    console.log("\n4. Тест получения всех фото суры:");
    const surahPhotos = await ayahPhotosDB.getSurahPhotos(1);
    console.log(`   Всего фото в суре 1: ${Object.keys(surahPhotos).length}`);

    // 5. Тест получения диапазона фото
    console.log("\n5. Тест получения диапазона фото:");
    const rangePhotos = await ayahPhotosDB.getPhotosRange(1, 1, 3);
    console.log(
      `   Фото для аятов 1-3: ${Object.keys(rangePhotos).length} фото`
    );

    // 6. Тест статистики
    console.log("\n6. Тест статистики:");
    const stats = await ayahPhotosDB.getStatistics();
    console.log("   Статистика базы данных:");
    console.log(`   - Всего фото: ${stats.totalPhotos}`);
    console.log(`   - Суры с фото: ${stats.surahsCount}`);
    console.log(`   - Диапазон сур: ${stats.surahRange}`);
    console.log(`   - Диапазон аятов: ${stats.ayahRange}`);
    console.log(`   - Размер БД: ${stats.databaseSize}`);

    // 7. Тест количества фото в суре
    console.log("\n7. Тест количества фото в суре:");
    const photoCount = await ayahPhotosDB.getSurahPhotoCount(1);
    console.log(`   Фото в суре 1: ${photoCount}`);

    // 8. Тест навигации
    console.log("\n8. Тест навигации:");

    // Следующий аят с фото
    const nextAyah = await ayahPhotosDB.getNextAyahWithPhoto(1, 1);
    console.log(
      "   Следующий аят с фото после 1:1:",
      nextAyah ? `Сура ${nextAyah.surah}, аят ${nextAyah.ayah}` : "Нет"
    );

    // Предыдущий аят с фото
    const prevAyah = await ayahPhotosDB.getPreviousAyahWithPhoto(1, 2);
    console.log(
      "   Предыдущий аят с фото перед 1:2:",
      prevAyah ? `Сура ${prevAyah.surah}, аят ${prevAyah.ayah}` : "Нет"
    );

    // 9. Тест поиска по диапазону
    console.log("\n9. Тест поиска по диапазону:");
    const searchResults = await ayahPhotosDB.searchByAyahRange(1, 1, 5);
    console.log(
      `   Найдено фото в диапазоне 1-5: ${Object.keys(searchResults).length}`
    );

    // 10. Тест получения всех сур с фото
    console.log("\n10. Тест получения всех сур с фото:");
    const surahsWithPhotos = await ayahPhotosDB.getAllSurahsWithPhotos();
    console.log(`   Всего сур с фото: ${surahsWithPhotos.length}`);
    if (surahsWithPhotos.length > 0) {
      surahsWithPhotos.forEach((surah) => {
        console.log(`   - Сура ${surah.surah}: ${surah.photo_count} фото`);
      });
    }

    // 11. Тест экспорта
    console.log("\n11. Тест экспорта данных:");
    const exportData = await ayahPhotosDB.exportToJson(3);
    console.log(
      `   Экспортировано записей: ${Object.values(exportData).reduce(
        (sum, obj) => sum + Object.keys(obj).length,
        0
      )}`
    );
    console.log("   Пример экспортированных данных:");
    Object.entries(exportData).forEach(([surah, ayahs]) => {
      console.log(`   Сура ${surah}: ${Object.keys(ayahs).length} аятов`);
    });

    // Закрываем подключение
    await ayahPhotosDB.closeDatabase();
    console.log("\n✅ Все тесты пройдены успешно!");
    console.log("\n=== ТЕСТИРОВАНИЕ ЗАВЕРШЕНО ===");
  } catch (error) {
    console.error("\n❌ Ошибка при тестировании:", error);
    console.error(error.stack);

    try {
      await ayahPhotosDB.closeDatabase();
    } catch (closeError) {
      console.error("Ошибка при закрытии базы данных:", closeError);
    }
  }
}

// Запускаем тест
if (require.main === module) {
  console.log("Запуск тестов модуля ayah photos database...\n");
  test().catch(console.error);
}

module.exports = { test };
