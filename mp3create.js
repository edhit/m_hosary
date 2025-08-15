// mp3create.js
const fs = require('fs');
const fetch = require("node-fetch");
const path = require('path');

// ==== CONFIG ====
const config = {
  mode: 2,             // 1 = глобальные номера, 2 = сура+аяты
  ayahs: [255, 256, 257], // если mode=1 — глобальные номера, если mode=2 — номера в суре
  surah: 2,             // используется только если mode=2
  folder: "./temp",
  file: "result.mp3"
};
// ================

// Количество аятов в каждой суре (1-based)
const ayahsPerSurah = [
  0,
  7, 286, 200, 176, 120, 165, 206, 75, 129, 109,
  123, 111, 43, 52, 99, 128, 111, 110, 98, 135,
  112, 78, 118, 64, 77, 227, 93, 88, 69, 60,
  34, 30, 73, 54, 45, 83, 182, 88, 75, 85,
  54, 53, 89, 59, 37, 35, 38, 29, 18, 45,
  60, 49, 62, 55, 78, 96, 29, 22, 24, 13,
  14, 11, 11, 18, 12, 12, 30, 52, 52, 44,
  28, 28, 20, 56, 40, 31, 50, 40, 46, 42,
  29, 19, 36, 25, 22, 17, 19, 26, 30, 20,
  15, 21, 11, 8, 8, 19, 5, 8, 8, 11,
  11, 8, 3, 9, 5, 4, 7, 3, 6, 3,
  5, 4, 5, 6
];

// Преобразуем (сура, аят в суре) → глобальный номер
function toGlobalAyah(surah, ayah) {
  let total = 0;
  for (let i = 1; i < surah; i++) {
    total += ayahsPerSurah[i];
  }
  return total + ayah;
}

// Скачать файл
async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Ошибка загрузки ${url}: ${res.statusText}`);
  const fileStream = fs.createWriteStream(dest);
  await new Promise((resolve, reject) => {
    res.body.pipe(fileStream);
    res.body.on('error', reject);
    fileStream.on('finish', resolve);
  });
}

// Склеить mp3
function mergeFiles(files, output) {
  const writeStream = fs.createWriteStream(output);
  for (const file of files) {
    const data = fs.readFileSync(file);
    writeStream.write(data);
  }
  writeStream.end();
}

async function processAyahs(ayahNumbers) {
  try {
    const tempFiles = [];

    for (const num of ayahNumbers) {
      const url = `https://cdn.islamic.network/quran/audio/128/ar.husary/${num}.mp3`;
      const tempFile = path.join(config.folder, `${num}.mp3`);
      console.log(`Скачиваю аят ${num}...`);
      await downloadFile(url, tempFile);
      tempFiles.push(tempFile);
    }

    const outputFile = path.join(config.folder, config.file);
    if (tempFiles.length > 1) {
      console.log("Объединяю файлы...");
      mergeFiles(tempFiles, outputFile);
    } else {
      fs.renameSync(tempFiles[0], outputFile);
    }

    console.log(`Файл сохранён: ${outputFile}`);

    // Удаляем временные файлы
    for (const f of tempFiles) {
      if (fs.existsSync(f) && f !== outputFile) fs.unlinkSync(f);
    }

    console.log("Временные файлы удалены.");
  } catch (err) {
    console.error("Ошибка:", err);
  }
}

async function mp3create(settings) {
  let ayahNumbers = [];

  // config.mode = settings.mode ? settings.mode : config.mode;
  // config.surah = settings.surah ? settings.surah : config.surah;
  // config.ayahs = settings.ayahs ? settings.ayahs : config.ayahs;
  // config.folder = settings.folder ? settings.folder : config.folder;
  // config.file = settings.file ? settings.file : config.file;
  
  if (settings) {
    Object.keys(config).forEach(key => {
      if (settings[key] !== undefined) {
        config[key] = settings[key];
      }
    });
  }
  
  if (config.mode === 1) {
    ayahNumbers = config.ayahs;
  } else if (config.mode === 2) {
    ayahNumbers = config.ayahs.map(a => toGlobalAyah(config.surah, a));
  } else {
    console.error("Неверный режим в config.mode");
    return;
  }

  await processAyahs(ayahNumbers);

  return config
}

module.exports = { mp3create }