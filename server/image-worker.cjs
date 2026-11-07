const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const decodeHeic = require('heic-decode');

const MAX_PIXELS = 50_000_000;
sharp.cache(false);
sharp.concurrency(1);

async function convert() {
  const input = await fs.readFile(workerData.inputPath);
  let pipeline;
  if (workerData.format === 'HEIC') {
    // Inspect dimensions before allocating the full RGBA bitmap.
    const images = await decodeHeic.all({ buffer: input });
    try {
      const image = images[0];
      if (!image || image.width * image.height > MAX_PIXELS) throw new Error('LIMIT_PIXELS');
      const decoded = await image.decode();
      pipeline = sharp(Buffer.from(decoded.data), { raw: { width: decoded.width, height: decoded.height, channels: 4 }, limitInputPixels: MAX_PIXELS });
    } finally {
      images.dispose();
    }
  } else {
    pipeline = sharp(input, { limitInputPixels: MAX_PIXELS, failOn: 'warning', animated: false }).rotate();
  }
  const normalized = await pipeline.toColourspace('srgb').flatten({ background: '#ffffff' }).png().toBuffer({ resolveWithObject: true });
  if (!normalized.info.width || !normalized.info.height || normalized.info.width * normalized.info.height > MAX_PIXELS) throw new Error('LIMIT_PIXELS');
  for (const [variant, size, quality] of [['full', 2048, 92], ['scene', 1024, 88], ['thumb', 320, 82]]) {
    await sharp(normalized.data).resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true }).jpeg({ quality, mozjpeg: true }).toFile(path.join(workerData.outputDir, `${variant}.jpg`));
  }
  return { widthPx: normalized.info.width, heightPx: normalized.info.height };
}

convert().then((result) => parentPort.postMessage({ result })).catch(() => parentPort.postMessage({ error: 'Изображение повреждено, слишком большое или не поддерживается декодером.' }));
