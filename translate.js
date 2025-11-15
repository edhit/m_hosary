async function getKulievTranslation(surah, ayah) {
  const reference = `${surah}:${ayah}`;
  const edition = "ru.kuliev";

  const url = `https://api.alquran.cloud/v1/ayah/${reference}/${edition}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Ошибка API alquran.cloud: статус ${response.status}`);
  }

  const data = await response.json();
  // data.data содержит сам аят, в том числе текст перевода
  return data.data.text;
}
module.exports = { getKulievTranslation };
