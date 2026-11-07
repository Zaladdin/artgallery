const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PIXELS = 50_000_000;
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);
const VARIANTS = [['full', 2048, 0.88], ['scene', 1024, 0.84], ['thumb', 320, 0.8]];

function imageError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function detectFormat(file) {
  if (!(file instanceof File) || file.size === 0) throw imageError(400, 'Выберите непустой файл изображения.');
  if (file.size > MAX_BYTES) throw imageError(413, 'Файл больше 25 МБ.');
  const bytes = new Uint8Array(await file.slice(0, 256).arrayBuffer());
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (['jpg', 'jpeg'].includes(extension) && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    return { format: 'JPG', mime: 'image/jpeg' };
  }
  if (extension === 'png' && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) {
    return { format: 'PNG', mime: 'image/png' };
  }
  const tag = (index) => String.fromCharCode(...bytes.subarray(index, index + 4));
  if (['heic', 'heif'].includes(extension) && bytes.length >= 16 && tag(4) === 'ftyp') {
    const size = new DataView(bytes.buffer).getUint32(0);
    const brands = [tag(8)];
    for (let index = 16; index + 4 <= Math.min(size, bytes.length); index += 4) brands.push(tag(index));
    if (brands.some((brand) => HEIF_BRANDS.has(brand)) && !brands.some((brand) => ['avif', 'avis'].includes(brand))) {
      return { format: 'HEIC', mime: extension === 'heif' ? 'image/heif' : 'image/heic' };
    }
  }
  throw imageError(415, 'Формат содержимого не соответствует JPG, PNG или HEIC.');
}

async function decodeImage(file, format) {
  let source = file;
  if (format === 'HEIC') {
    try {
      const { heicTo } = await import('https://cdn.jsdelivr.net/npm/heic-to@1.6.7/dist/csp/heic-to.js');
      source = await heicTo({ blob: file, type: 'image/jpeg', quality: 0.95 });
    } catch {
      throw imageError(422, 'Этот HEIC не удалось преобразовать. Сохраните фото как JPG и загрузите повторно.');
    }
  }
  try {
    return await createImageBitmap(source, { imageOrientation: 'from-image' });
  } catch {
    throw imageError(422, 'Изображение не удалось прочитать. Проверьте, что файл не повреждён.');
  }
}

async function encodeJpeg(image, edge, quality) {
  const ratio = Math.min(1, edge / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.width * ratio));
  canvas.height = Math.max(1, Math.round(image.height * ratio));
  try {
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw imageError(422, 'Браузер не смог подготовить изображение.');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob || blob.type !== 'image/jpeg') throw imageError(422, 'Не удалось сохранить подготовленное изображение.');
    return blob;
  } finally {
    canvas.width = canvas.height = 0;
  }
}

export async function prepareImage(file, signal) {
  const { format, mime } = await detectFormat(file);
  signal?.throwIfAborted();
  const image = await decodeImage(file, format);
  try {
    const { width, height } = image;
    if (!width || !height || width * height > MAX_PIXELS) throw imageError(413, 'Изображение должно быть не больше 50 мегапикселей.');
    const variants = {};
    for (const [name, edge, quality] of VARIANTS) {
      signal?.throwIfAborted();
      variants[name] = await encodeJpeg(image, edge, quality);
    }
    return { format, mime, width, height, variants };
  } finally {
    image.close();
  }
}
