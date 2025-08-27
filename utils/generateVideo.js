const getAyahsTextWithNumbers = require("./getAyahsTextWithNumbers");
const { toGlobalAyah } = require("./mp3create");
const VideoProcessor = require("./mp4create");

async function generateVideo(currentData) {
  try {
    currentData.quran = await getAyahsTextWithNumbers(currentData.ayahs);

    let ayahNumbers = currentData.ayahs.map((a) =>
      toGlobalAyah(currentData.track, a)
    );

    for (let index = 0; index < currentData.quran.length; index++) {
      console.log(
        `------

        Готовлю видео
        
        Сура ${currentData.track} Аят ${currentData.ayahs[index]}
        
        -----`
      );

      let video = new VideoProcessor({
        audioPath: `${ayahNumbers[index]}.mp3`,
        arabicText: `${currentData.quran[index]}`,
        outputPath: `${ayahNumbers[index]}.mp4`,
        backgroundImage: currentData.photoPath.split("/")[1],
      });

      await video.process();
    }

    return { currentData, ayahNumbers };
  } catch (error) {
    console.log(error);
  }
}

module.exports = generateVideo;
