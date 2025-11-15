const getTafsir = async (surah, ayah) => {
  try {
    console.log(`Запрос тафсира для суры ${surah}, аят ${ayah}`);

    const response = await fetch(
      `https://api.quran.com/api/v4/tafsirs/170/by_ayah/${surah}:${ayah}`
    );

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    if (data.tafsir && data.tafsir.verses && data.tafsir.text) {
      // Получаем первый аят из verses (это единственный аят с тафсиром)
      const firstVerseKey = Object.keys(data.tafsir.verses)[0];
      const [firstSurah, firstAyah] = firstVerseKey.split(":").map(Number);

      // Проверяем, совпадает ли запрошенный аят с первым аятом (который имеет тафсир)
      if (firstSurah === surah && firstAyah === ayah) {
        // console.log(`Тафсир найден для ${surah}:${ayah}`);
        return data.tafsir.text;
      } else {
        // console.log(
        //   `Тафсира нет для ${surah}:${ayah} (тафсир есть только для ${firstVerseKey})`
        // );
        return `Тафсира нет для ${surah}:${ayah} (тафсир есть только для ${firstVerseKey})`;
      }
    } else {
      // console.log(`Нет данных тафсира для ${surah}:${ayah}`);
      return null;
    }
  } catch (error) {
    // console.error("Tafsir API error:", error);
    return null;
  }
};
module.exports = { getTafsir };
