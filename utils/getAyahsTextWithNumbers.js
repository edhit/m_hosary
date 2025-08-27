async function getAyahsTextWithNumbers(ayahsArray) {
  try {
    const result = [];

    for (const ayahNumber of ayahsArray) {
      const response = await fetch(
        `https://api.alquran.cloud/v1/ayah/${ayahNumber}`
      );

      if (response.ok) {
        const data = await response.json();
        if (data.code === 200) {
          result.push(data.data.text);
        }
      }
    }

    return result;
  } catch (error) {
    console.error("Ошибка:", error);
    return {};
  }
}

module.exports = getAyahsTextWithNumbers;
// // Использование
// let quran = await getAyahsTextWithNumbers([670, 671]);

// for (let index = 0; index < quran.length; index++) {
//   console.log(`Аят ${quran[index]}`);
// }
