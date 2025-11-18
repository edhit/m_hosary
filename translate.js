// translations.js

// --- Кулиев (alquran.cloud) ---
async function getKulievTranslation(surah, ayah) {
  const reference = `${surah}:${ayah}`;
  const edition = "ru.kuliev";
  const url = `https://api.alquran.cloud/v1/ayah/${reference}/${edition}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Ошибка API alquran.cloud: статус ${response.status}`);
  }

  const data = await response.json();
  return data.data.text; // текст перевода
}

// --- Абу Адель (QuranEnc) ---
async function getAbuAdelTranslation(surah, ayah) {
  const tranKey = "russian_aboadel";
  const url = `https://quranenc.com/api/v1/translation/aya/${tranKey}/${surah}/${ayah}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Ошибка API QuranEnc: статус ${response.status}`);
  }

  const data = await response.json();

  // У них структура { "translation": "...", sura: 1, aya: 1, ... }
  return data.translation;
}

// --- Универсальная функция: получить оба перевода ---
async function getTranslations(surah, ayah) {
  const [kuliev, abuAdel] = await Promise.all([
    getKulievTranslation(surah, ayah).catch(() => null),
    getAbuAdelTranslation(surah, ayah).catch(() => null),
  ]);

  return {
    surah,
    ayah,
    kuliev,
    abuAdel,
  };
}

module.exports = {
  getKulievTranslation,
  getAbuAdelTranslation,
  getTranslations,
};
