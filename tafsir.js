// tafsir.js
const fetch = require("node-fetch");

async function getTafsir(surah, ayah, lang = "ru") {
  const tafsirType =
    lang === "ar" ? "ar-tafseer-al-saddi" : "ru-tafseer-al-saddi";
  const url = `https://cdn.jsdelivr.net/gh/spa5k/tafsir_api@main/tafsir/${tafsirType}/${surah}/${ayah}.json`;

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return data?.text || "❌ Тафсир не найден.";
  } catch (err) {
    return `⚠️ Ошибка при получении тафсира: ${err.message}`;
  }
}

module.exports = { getTafsir };
