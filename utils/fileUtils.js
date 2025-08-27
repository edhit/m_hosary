const fs = require("fs");
const path = require("path");

const clearTempFolder = (tempFolder = "./temp") => {
  try {
    if (!fs.existsSync(tempFolder)) {
      fs.mkdirSync(tempFolder, { recursive: true });
      return;
    }

    fs.readdirSync(tempFolder).forEach((file) => {
      const filePath = path.join(tempFolder, file);
      fs.unlinkSync(filePath);
    });

    console.log(`Временная папка ${tempFolder} очищена`);
  } catch (err) {
    console.error(`Ошибка при очистке временной папки: ${err.message}`);
    throw err; // Можно обработать ошибку на уровне вызова
  }
};

module.exports = { clearTempFolder };
