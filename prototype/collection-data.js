const files = [
  ['IMG_1156.jpg', 2048, 1531], ['IMG_1159.jpg', 1334, 2048],
  ['IMG_1163.jpg', 1726, 2048], ['IMG_1166.jpg', 1732, 2048],
  ['IMG_1441.jpg', 1536, 2048], ['IMG_1442.jpg', 1510, 2048],
  ['IMG_1444.jpg', 2048, 1536], ['IMG_1445.jpg', 2048, 1693],
  ['IMG_1446.jpg', 2048, 1622], ['IMG_1449.jpg', 2048, 1536]
];

export function fitArtwork(width, height) {
  const ratio = width > 0 && height > 0 ? width / height : 1;
  const displayHeightM = Math.min(1.18, 1.55 / ratio);
  return { displayWidthM: displayHeightM * ratio, displayHeightM };
}

export const defaultArtists = [{
  slug: 'ayten-sheydayeva', name: 'Айтен Шейдаева', years: '',
  aliases: ['Айтен', 'Шейдаева', 'Ayten Sheydayeva'], biography: '',
  room: { wallColor: '#e9e4da', frameColor: '#171716' },
  works: files.map(([sourceName, widthPx, heightPx], index) => {
    const number = String(index + 1).padStart(2, '0');
    return {
      id: `ayten-${number}`, title: `Картина ${number}`, sourceFormat: 'JPG', sourceName,
      imageSrc: `./assets/ayten/ayten-${number}.jpg`,
      sceneImageSrc: `./assets/ayten/scene-${number}.jpg`,
      thumbnailSrc: `./assets/ayten/thumb-${number}.jpg`,
      widthPx, heightPx, ...fitArtwork(widthPx, heightPx),
      description: '', rightsConfirmed: false, visible: true
    };
  })
}];
