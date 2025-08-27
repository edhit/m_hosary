const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;

// Указываем пути вручную
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

/**
 * Объединяет несколько видео в один файл.
 * @param {string[]} videos - массив путей к видеофайлам
 * @param {string} output - путь к итоговому видео
 * @returns {Promise<string>} - путь к объединённому видео
 */
async function mergeMultipleVideos(videos, output) {
  return new Promise((resolve, reject) => {
    if (!videos || videos.length < 2) {
      return reject(new Error("Нужно минимум 2 видео для объединения"));
    }

    const command = ffmpeg();

    videos.forEach((video) => {
      command.input(video);
    });

    command
      .on("error", (err) => {
        console.error("Ошибка при объединении:", err.message);
        reject(err);
      })
      .on("end", () => {
        console.log("Видео успешно объединены:", output);
        resolve(output);
      })
      .mergeToFile(output, "./temp");
  });
}

module.exports = mergeMultipleVideos;
