const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { isIP } = require('node:net');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');
const { Worker } = require('node:worker_threads');

const scrypt = promisify(crypto.scrypt);
const SESSION_MS = 8 * 60 * 60 * 1000;
const MAX_BODY = 1024 * 1024;
const MAX_UPLOAD = 25 * 1024 * 1024;
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const UUID = /^[a-f0-9-]{36}$/;
const VARIANTS = new Set(['full.jpg', 'scene.jpg', 'thumb.jpg']);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.glb': 'model/gltf-binary' };

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function text(value, label, max = 200, required = false) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new ApiError(400, `Некорректное поле «${label}».`);
  const result = value.trim();
  if (required && !result) throw new ApiError(400, `Заполните поле «${label}».`);
  return result;
}

function color(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^#[a-f0-9]{6}$/i.test(value)) throw new ApiError(400, 'Цвет должен быть в формате #RRGGBB.');
  return value;
}

function dimension(value) {
  if (value === '' || value === undefined || value === null) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 10000) throw new ApiError(400, 'Размеры картины должны быть больше нуля и не больше 10000 см.');
  return number;
}

function fitSize(width, height) {
  const scale = Math.min(1.55 / width, 1.18 / height);
  return { displayWidthM: Number((width * scale).toFixed(5)), displayHeightM: Number((height * scale).toFixed(5)) };
}

function detectFormat(buffer, filename) {
  const extension = path.extname(filename).toLowerCase();
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff && ['.jpg', '.jpeg'].includes(extension)) return 'JPG';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && extension === '.png') return 'PNG';
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp' && ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(buffer.toString('ascii', 8, 12)) && ['.heic', '.heif'].includes(extension)) return 'HEIC';
  throw new ApiError(415, 'Нужен настоящий файл JPG, PNG или HEIC с соответствующим расширением.');
}

async function readBody(request, limit = MAX_BODY) {
  const length = Number(request.headers['content-length']);
  if (Number.isFinite(length) && length > limit) throw new ApiError(413, 'Файл или запрос превышает допустимый размер.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new ApiError(413, 'Файл или запрос превышает допустимый размер.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  if (!String(request.headers['content-type'] || '').startsWith('application/json')) throw new ApiError(415, 'Ожидается JSON.');
  try {
    const data = JSON.parse((await readBody(request)).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('object required');
    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'Некорректный JSON.');
  }
}

function processImage(inputPath, outputDir, format) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'image-worker.cjs'), { workerData: { inputPath, outputDir, format }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      worker.terminate();
      if (error) reject(error); else resolve(result);
    };
    const timeout = setTimeout(() => finish(new ApiError(422, 'Обработка заняла слишком много времени. Попробуйте уменьшить изображение.')), 60000);
    worker.on('message', ({ result, error }) => finish(error ? new ApiError(422, error) : null, result));
    worker.on('error', () => finish(new ApiError(422, 'Не удалось обработать изображение.')));
    worker.on('exit', () => { if (!settled) finish(new ApiError(422, 'Обработка изображения прервана.')); });
  });
}

async function createApp(options = {}) {
  const configuredOrigin = options.publicOrigin ?? (process.env.GALLERY_PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL);
  const publicUrl = configuredOrigin ? new URL(configuredOrigin) : null;
  if (publicUrl && (publicUrl.protocol !== 'https:' || publicUrl.href !== `${publicUrl.origin}/`)) {
    throw new Error('GALLERY_PUBLIC_ORIGIN must be an HTTPS origin without a path.');
  }
  const storage = options.dataDir || process.env.GALLERY_DATA_DIR;
  if (publicUrl && !storage) throw new Error('Set GALLERY_DATA_DIR to a persistent disk mount.');
  const staticDir = path.resolve(options.staticDir || path.join(__dirname, '..', 'prototype'));
  const dataDir = path.resolve(storage || path.join(__dirname, '..', '.gallery-data'));
  if (dataDir === staticDir || dataDir.startsWith(staticDir + path.sep)) throw new Error('Private data directory cannot be inside static root.');
  await fsp.mkdir(path.join(dataDir, 'media'), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'gallery.sqlite'));
  const indexHtml = await fsp.readFile(path.join(staticDir, 'index.html'), 'utf8');
  const inlineScripts = [...indexHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => `'sha256-${crypto.createHash('sha256').update(match[1]).digest('base64')}'`).join(' ');
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS artists (slug TEXT PRIMARY KEY, draft TEXT NOT NULL, published TEXT, revision INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, artist_slug TEXT NOT NULL, work TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);`);
  const getConfig = (key) => db.prepare('SELECT value FROM config WHERE key = ?').get(key)?.value;
  async function passwordRecord(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = (await scrypt(password, salt, 64)).toString('hex');
    return JSON.stringify({ salt, hash });
  }
  if (publicUrl && !getConfig('admin')) {
    const password = options.adminPassword ?? process.env.GALLERY_ADMIN_PASSWORD;
    if (typeof password !== 'string' || password.length < 16 || password.length > 128) {
      db.close();
      throw new Error('Set GALLERY_ADMIN_PASSWORD to a unique password of 16–128 characters before first deployment.');
    }
    db.prepare('INSERT OR IGNORE INTO config VALUES (?, ?)').run('admin', await passwordRecord(password));
  }
  const sessionName = publicUrl ? '__Host-gallery_session' : 'gallery_session';
  const sessionAttributes = `HttpOnly; SameSite=Strict; Path=/${publicUrl ? '; Secure' : ''}`;
  const trustRenderProxy = Boolean(publicUrl && (options.trustRenderProxy ?? process.env.RENDER === 'true'));
  const transaction = (fn) => { db.exec('BEGIN IMMEDIATE'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const json = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
  const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
  const sessionFor = (request) => {
    const cookie = request.headers.cookie?.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${sessionName}=`));
    const token = cookie?.slice(sessionName.length + 1);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    return db.prepare('SELECT token_hash, csrf, expires FROM sessions WHERE token_hash = ? AND expires > ?').get(hashToken(token), Date.now()) || null;
  };
  function issueSession(response) {
    const token = crypto.randomBytes(32).toString('hex');
    const csrf = crypto.randomBytes(32).toString('hex');
    db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hashToken(token), csrf, Date.now() + SESSION_MS);
    response.setHeader('Set-Cookie', `${sessionName}=${token}; ${sessionAttributes}; Max-Age=${SESSION_MS / 1000}`);
    return csrf;
  }
  const statusFor = (session) => ({ backend: true, setupRequired: !getConfig('admin'), authenticated: Boolean(session), ...(session ? { csrfToken: session.csrf } : {}) });
  let nextLimitCleanup = 0;
  function rateLimit(key, count, windowMs) {
    const now = Date.now();
    if (now >= nextLimitCleanup) {
      db.prepare('DELETE FROM limits WHERE expires <= ?').run(now);
      nextLimitCleanup = now + 60_000;
    }
    const row = db.prepare('SELECT count, expires FROM limits WHERE key = ?').get(key);
    if (!row || row.expires <= now) db.prepare('INSERT INTO limits VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count=1, expires=excluded.expires').run(key, now + windowMs);
    else {
      if (row.count >= count) throw new ApiError(429, 'Слишком много попыток. Повторите позже.');
      db.prepare('UPDATE limits SET count=count+1 WHERE key=?').run(key);
    }
  }
  const draftFor = (row) => ({ ...JSON.parse(row.draft), published: Boolean(row.published), revision: row.revision });
  function getArtist(slug) {
    const row = db.prepare('SELECT * FROM artists WHERE slug=?').get(slug);
    if (!row) throw new ApiError(404, 'Художник не найден.');
    return row;
  }
  function savedWork(work, known) {
    if (!work || typeof work !== 'object' || !known.has(work.id)) throw new ApiError(400, 'Работа должна быть загружена через форму загрузки.');
    const source = known.get(work.id);
    const widthCm = dimension(work.widthCm);
    const heightCm = dimension(work.heightCm);
    if (Boolean(widthCm) !== Boolean(heightCm)) throw new ApiError(400, 'Укажите оба размера картины или оставьте оба пустыми.');
    return { ...source, title: text(work.title, 'Название работы', 200, true), year: text(String(work.year || ''), 'Год', 40), medium: text(work.medium, 'Техника', 200), description: text(work.description, 'Описание', 10000), widthCm, heightCm, rightsConfirmed: work.rightsConfirmed === true, visible: work.visible !== false, ...fitSize(source.widthPx || source.displayWidthM, source.heightPx || source.displayHeightM) };
  }
  function validatedArtist(input, row) {
    const old = JSON.parse(row.draft);
    if (input.revision !== undefined && input.revision !== row.revision) throw new ApiError(409, 'Выставка изменена в другом окне. Обновите страницу перед сохранением.');
    const known = new Map(old.works.map((work) => [work.id, work]));
    for (const { work } of db.prepare('SELECT work FROM media WHERE artist_slug=?').all(row.slug)) { const parsed = JSON.parse(work); known.set(parsed.id, parsed); }
    if (!Array.isArray(input.works) || input.works.length > 100) throw new ApiError(400, 'В выставке должно быть не больше 100 работ.');
    if (new Set(input.works.map((work) => work?.id)).size !== input.works.length) throw new ApiError(400, 'В списке работ есть повторения.');
    if (!Array.isArray(input.aliases) || input.aliases.length > 20) throw new ApiError(400, 'Укажите не больше 20 вариантов имени.');
    return { slug: row.slug, name: text(input.name, 'ФИО', 200, true), years: text(input.years, 'Годы', 80), biography: text(input.biography, 'Биография', 20000), aliases: input.aliases.map((alias) => text(alias, 'Вариант имени', 200, true)), room: { wallColor: color(input.room?.wallColor, '#e9e4da'), frameColor: color(input.room?.frameColor, '#171716') }, works: input.works.map((work) => savedWork(work, known)) };
  }
  if (!getConfig('seeded')) {
    let seed = options.seed;
    if (!seed) {
      const seedPath = path.join(staticDir, 'collection-data.js');
      if (fs.existsSync(seedPath)) {
        const source = await fsp.readFile(seedPath, 'utf8');
        seed = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).defaultArtists;
      }
    }
    if (Array.isArray(seed)) transaction(() => {
      for (const artist of seed) {
        const initial = { ...artist, works: artist.works.map((work) => ({ ...work, visible: true })) };
        db.prepare('INSERT OR IGNORE INTO artists(slug,draft,published) VALUES(?,?,?)').run(artist.slug, JSON.stringify(initial), JSON.stringify(initial));
      }
      db.prepare('INSERT INTO config VALUES(?,?)').run('seeded', 'true');
    });
  }
  let activeUploads = 0;
  async function handler(request, response) {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    // Existing gallery renders validated CSS values in style attributes.
    response.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' https://cdn.jsdelivr.net ${inlineScripts}; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://cdn.jsdelivr.net; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
    try {
      const host = request.headers.host;
      const port = request.socket.localPort;
      const allowedHosts = publicUrl ? [publicUrl.host] : [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!allowedHosts.includes(host)) throw new ApiError(403, 'Недопустимый адрес сервера.');
      const origin = publicUrl?.origin || `http://${host}`;
      const url = new URL(request.url, origin);
      const pathname = decodeURIComponent(url.pathname);
      if (publicUrl) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
      if (pathname === '/health' && request.method === 'GET') {
        db.prepare('SELECT 1').get();
        return json(response, 200, { status: 'ok' });
      }
      const session = sessionFor(request);
      if (!['GET', 'HEAD'].includes(request.method)) {
        if (request.headers.origin !== origin || ['cross-site', 'same-site'].includes(request.headers['sec-fetch-site'])) throw new ApiError(403, 'Запрос должен выполняться со страницы галереи.');
      }
      if (pathname.startsWith('/api/')) {
        if (!publicUrl) rateLimit(`api:${request.socket.remoteAddress}`, 600, 60_000);
        else if (session) rateLimit(`api-session:${session.token_hash}`, 600, 60_000);
        if (pathname === '/api/status' && request.method === 'GET') return json(response, 200, statusFor(session));
        if (pathname === '/api/artists' && request.method === 'GET') return json(response, 200, db.prepare('SELECT published FROM artists WHERE published IS NOT NULL ORDER BY slug').all().map((row) => JSON.parse(row.published)));
        if (['/api/setup', '/api/login'].includes(pathname) && request.method === 'POST') {
          if (publicUrl && pathname === '/api/setup') throw new ApiError(404, 'Первичная настройка через сайт отключена.');
          const proxyIp = request.headers['cf-connecting-ip'];
          // Render's public edge sets this header; never accept it on an unmanaged host.
          const loginIp = trustRenderProxy && typeof proxyIp === 'string' && isIP(proxyIp) ? proxyIp : request.socket.remoteAddress;
          rateLimit(`login:${loginIp}`, 10, 15 * 60_000);
          const { password } = await readJson(request);
          if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw new ApiError(400, 'Пароль должен содержать от 12 до 128 символов.');
          const admin = getConfig('admin');
          if (pathname === '/api/setup') {
            if (admin) throw new ApiError(409, 'Администратор уже создан. Войдите с паролем.');
            const record = await passwordRecord(password);
            try { db.prepare('INSERT INTO config VALUES(?,?)').run('admin', record); } catch { throw new ApiError(409, 'Администратор уже создан.'); }
          } else {
            if (!admin) throw new ApiError(409, 'Сначала создайте пароль администратора.');
            const stored = JSON.parse(admin);
            const actual = await scrypt(password, stored.salt, 64);
            if (!crypto.timingSafeEqual(Buffer.from(stored.hash, 'hex'), actual)) throw new ApiError(401, 'Неверный пароль.');
          }
          const csrfToken = issueSession(response);
          return json(response, 200, { backend: true, setupRequired: false, authenticated: true, csrfToken });
        }
        if (!session) throw new ApiError(401, 'Войдите как администратор.');
        if (request.method !== 'GET' && request.headers['x-csrf-token'] !== session.csrf) throw new ApiError(403, 'Сессия устарела. Обновите страницу и повторите.');
        if (pathname === '/api/logout' && request.method === 'POST') {
          db.prepare('DELETE FROM sessions WHERE token_hash=?').run(session.token_hash);
          response.setHeader('Set-Cookie', `${sessionName}=; ${sessionAttributes}; Max-Age=0`);
          return json(response, 200, { authenticated: false });
        }
        if (pathname === '/api/admin/artists' && request.method === 'GET') return json(response, 200, db.prepare('SELECT * FROM artists ORDER BY slug').all().map(draftFor));
        if (pathname === '/api/admin/artists' && request.method === 'POST') {
          const input = await readJson(request);
          const slug = text(input.slug, 'Адрес', 80, true);
          if (!SLUG.test(slug)) throw new ApiError(400, 'Адрес: латинские строчные буквы, цифры и дефис, до 80 символов.');
          const artist = { slug, name: text(input.name, 'ФИО', 200, true), years: '', aliases: [], biography: '', room: { wallColor: '#e9e4da', frameColor: '#171716' }, works: [] };
          try { db.prepare('INSERT INTO artists(slug,draft) VALUES(?,?)').run(slug, JSON.stringify(artist)); } catch { throw new ApiError(409, 'Этот адрес уже занят.'); }
          return json(response, 201, draftFor(getArtist(slug)));
        }
        const match = /^\/api\/admin\/artists\/([a-z0-9-]+)(?:\/(publish|unpublish|uploads))?$/.exec(pathname);
        if (match) {
          const [, slug, action] = match;
          const row = getArtist(slug);
          if (!action && request.method === 'PUT') {
            const input = await readJson(request);
            const artist = validatedArtist(input, getArtist(slug));
            db.prepare('UPDATE artists SET draft=?, revision=revision+1 WHERE slug=?').run(JSON.stringify(artist), slug);
            return json(response, 200, draftFor(getArtist(slug)));
          }
          if (action === 'publish' && request.method === 'POST') {
            const draft = JSON.parse(row.draft);
            const works = draft.works.filter((work) => work.visible !== false);
            if (!works.length || works.some((work) => !work.rightsConfirmed)) throw new ApiError(400, 'Для публикации нужна хотя бы одна видимая работа и подтверждённые права на каждую видимую работу.');
            const snapshot = { ...draft, works };
            db.prepare('UPDATE artists SET published=?,revision=revision+1 WHERE slug=?').run(JSON.stringify(snapshot), slug);
            return json(response, 200, draftFor(getArtist(slug)));
          }
          if (action === 'unpublish' && request.method === 'POST') {
            db.prepare('UPDATE artists SET published=NULL,revision=revision+1 WHERE slug=?').run(slug);
            return json(response, 200, draftFor(getArtist(slug)));
          }
          if (action === 'uploads' && request.method === 'POST') {
            rateLimit(`upload:${request.socket.remoteAddress}`, 30, 60_000);
            if (activeUploads >= 2) throw new ApiError(429, 'Обрабатываются другие изображения. Повторите через минуту.');
            if (JSON.parse(row.draft).works.length >= 100) throw new ApiError(400, 'Максимум 100 работ в выставке.');
            let filename;
            try { filename = decodeURIComponent(String(request.headers['x-file-name'] || '')); } catch { throw new ApiError(400, 'Некорректное имя файла.'); }
            filename = text(filename, 'Имя файла', 255, true);
            if (/[\/\\]/.test(filename)) throw new ApiError(400, 'Некорректное имя файла.');
            activeUploads += 1;
            let outputDir;
            try {
              const buffer = await readBody(request, MAX_UPLOAD);
              const format = detectFormat(buffer, filename);
              const id = crypto.randomUUID();
              outputDir = path.join(dataDir, 'media', id);
              await fsp.mkdir(outputDir);
              const inputPath = path.join(outputDir, 'original');
              await fsp.writeFile(inputPath, buffer, { flag: 'wx' });
              const dimensions = await processImage(inputPath, outputDir, format);
              const work = { id, title: path.basename(filename, path.extname(filename)), sourceFormat: format, sourceName: filename, imageSrc: `/media/${id}/full.jpg`, sceneImageSrc: `/media/${id}/scene.jpg`, thumbnailSrc: `/media/${id}/thumb.jpg`, ...dimensions, ...fitSize(dimensions.widthPx, dimensions.heightPx), description: '', year: '', medium: '', visible: true, rightsConfirmed: false };
              transaction(() => {
                const latest = getArtist(slug);
                const draft = JSON.parse(latest.draft);
                if (draft.works.length >= 100) throw new ApiError(400, 'Максимум 100 работ в выставке.');
                draft.works.push(work);
                db.prepare('INSERT INTO media VALUES(?,?,?)').run(id, slug, JSON.stringify(work));
                db.prepare('UPDATE artists SET draft=?,revision=revision+1 WHERE slug=?').run(JSON.stringify(draft), slug);
              });
              return json(response, 201, { ...work, artistRevision: getArtist(slug).revision });
            } catch (error) {
              if (outputDir) await fsp.rm(outputDir, { recursive: true, force: true });
              throw error;
            } finally { activeUploads -= 1; }
          }
        }
        throw new ApiError(404, 'API не найден.');
      }
      if (!['GET', 'HEAD'].includes(request.method)) throw new ApiError(405, 'Метод не поддерживается.');
      if (pathname.startsWith('/media/')) {
        const match = /^\/media\/([a-f0-9-]{36})\/(full\.jpg|scene\.jpg|thumb\.jpg)$/.exec(pathname);
        if (!match || !UUID.test(match[1]) || !VARIANTS.has(match[2])) throw new ApiError(404, 'Изображение не найдено.');
        const [, id, variant] = match;
        const media = db.prepare('SELECT artist_slug FROM media WHERE id=?').get(id);
        if (!media) throw new ApiError(404, 'Изображение не найдено.');
        const row = getArtist(media.artist_slug);
        const visible = row.published && JSON.parse(row.published).works.some((work) => work.id === id);
        if (!session && !visible) throw new ApiError(404, 'Изображение не найдено.');
        const data = await fsp.readFile(path.join(dataDir, 'media', id, variant));
        response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store', 'Content-Length': data.length });
        return response.end(request.method === 'HEAD' ? undefined : data);
      }
      const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      if (relative.split(/[\/\\]/).some((part) => part.startsWith('.')) || !Object.hasOwn(MIME, path.extname(relative).toLowerCase())) throw new ApiError(404, 'Страница не найдена.');
      const filename = path.resolve(staticDir, relative);
      const rel = path.relative(staticDir, filename);
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new ApiError(403, 'Доступ запрещён.');
      const real = await fsp.realpath(filename);
      const realRel = path.relative(await fsp.realpath(staticDir), real);
      if (realRel.startsWith('..') || path.isAbsolute(realRel)) throw new ApiError(403, 'Доступ запрещён.');
      const data = await fsp.readFile(real);
      response.writeHead(200, { 'Content-Type': MIME[path.extname(real).toLowerCase()], 'Cache-Control': 'no-store', 'Content-Length': data.length });
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : error.code === 'ENOENT' || error.code === 'EISDIR' ? 404 : error instanceof URIError ? 400 : 500;
      if (status === 500) console.error('Gallery server error:', error.code || error.name);
      if (!response.headersSent) json(response, status, { error: error instanceof ApiError ? error.message : status === 404 ? 'Не найдено.' : 'Ошибка сервера.' });
      else response.end();
    }
  }
  return { handler, db, dataDir, publicOrigin: publicUrl?.origin, close: () => db.close() };
}

async function startServer(options = {}) {
  const app = await createApp(options);
  const server = http.createServer(app.handler);
  server.requestTimeout = 90_000;
  server.headersTimeout = 15_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? Number(process.env.PORT || 4173), app.publicOrigin ? '0.0.0.0' : '127.0.0.1', resolve); });
  return { ...app, server, close: async () => { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); app.close(); } };
}

if (require.main === module) startServer().then(({ server }) => console.log(`Галерея и админка: http://127.0.0.1:${server.address().port}`)).catch((error) => { console.error('Не удалось запустить сервер:', error.code || error.message); process.exitCode = 1; });
module.exports = { createApp, startServer, detectFormat, fitSize };
