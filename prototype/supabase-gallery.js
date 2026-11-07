import { defaultArtists, fitArtwork } from './collection-data.js';
import { isCloudMediaUrl, supabaseUrl, supabasePublishableKey } from './supabase-config.js';

export { isCloudMediaUrl };

const IMAGE_BUCKET = 'gallery-images';
const ORIGINAL_BUCKET = 'gallery-originals';
const SIGNED_TTL_SECONDS = 15 * 60;
const SCOPE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VARIANTS = [['full', 'imageSrc'], ['scene', 'sceneImageSrc'], ['thumb', 'thumbnailSrc']];
const legacyArtists = new Map(defaultArtists.map((artist) => [artist.slug, new Map(artist.works.map((work) => [work.id, work]))]));
let clients;

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function getClients() {
  if (!clients) {
    clients = import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm').then(({ createClient }) => ({
      admin: createClient(supabaseUrl, supabasePublishableKey, { auth: { storage: window.sessionStorage, storageKey: 'artgallery-admin', detectSessionInUrl: false } }),
      public: createClient(supabaseUrl, supabasePublishableKey, { auth: { storageKey: 'artgallery-public', persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
    })).catch(() => {
      clients = undefined;
      throw fail(503, 'Не удалось загрузить подключение к Supabase. Проверьте интернет и попробуйте снова.');
    });
  }
  return clients;
}

function dbError(error) {
  if (['PGRST202', 'PGRST205', '42P01', '42883'].includes(error.code)) {
    return fail(503, 'Облачная мастерская ещё не настроена. Примените SQL-миграцию в Supabase.');
  }
  if (['23505', '40001', 'PT409'].includes(error.code)) return fail(409, 'Адрес уже занят или черновик изменён в другой вкладке. Обновите данные.');
  if (error.code === 'PT404') return fail(404, 'Выставка не найдена.');
  if (error.code === '42501' || Number(error.status ?? error.statusCode) === 403) return fail(403, 'Нет прав администратора.');
  if (error.code === 'PGRST301' || Number(error.status ?? error.statusCode) === 401) return fail(401, 'Сессия закончилась. Войдите снова.');
  if (['22023', '23514', 'P0001'].includes(error.code)) return fail(400, error.message);
  if (Number(error.status ?? error.statusCode) === 429) return fail(429, 'Слишком много запросов. Попробуйте позже.');
  return fail(503, 'Не удалось выполнить запрос к Supabase. Проверьте подключение и настройки проекта.');
}

async function unwrap(query, signal) {
  signal?.throwIfAborted();
  const { data, error } = await (signal && typeof query.abortSignal === 'function' ? query.abortSignal(signal) : query);
  signal?.throwIfAborted();
  if (error) throw dbError(error);
  return data;
}

async function authenticated(client, signal) {
  const session = await unwrap(client.auth.getSession(), signal);
  if (!session?.session) return false;
  if (await unwrap(client.rpc('gallery_is_admin'), signal) === true) return true;
  await client.auth.signOut({ scope: 'local' });
  return false;
}

const status = (authenticatedUser) => ({ backend: true, setupRequired: false, authenticated: authenticatedUser });

function mediaPath(slug, id, variant) {
  return `${slug}/${id}/${variant}.jpg`;
}

export async function refreshCloudMedia(source, { preview = false } = {}) {
  if (!isCloudMediaUrl(source)) return null;
  const { admin, public: publicClient } = await getClients();
  const client = preview ? admin : publicClient;
  if (preview && !await authenticated(admin)) return null;
  const path = new URL(source).pathname.split('/').slice(6).join('/');
  const result = await unwrap(client.storage.from(IMAGE_BUCKET).createSignedUrl(path, SIGNED_TTL_SECONDS));
  return isCloudMediaUrl(result?.signedUrl) ? result.signedUrl : null;
}

async function hydrate(client, exhibitions, signal) {
  const paths = new Set();
  for (const exhibition of exhibitions) {
    if (!SCOPE.test(exhibition.slug)) continue;
    for (const work of exhibition.works || []) {
      if (UUID.test(work.id)) VARIANTS.forEach(([variant]) => paths.add(mediaPath(exhibition.slug, work.id, variant)));
    }
  }
  const lookup = new Map();
  const batch = [...paths];
  for (let offset = 0; offset < batch.length; offset += 100) {
    signal?.throwIfAborted();
    const urls = await unwrap(client.storage.from(IMAGE_BUCKET).createSignedUrls(batch.slice(offset, offset + 100), SIGNED_TTL_SECONDS), signal);
    for (const item of urls || []) {
      if (item.path && isCloudMediaUrl(item.signedUrl)) lookup.set(item.path, item.signedUrl);
    }
  }
  return exhibitions.map((exhibition) => ({ ...exhibition, works: (exhibition.works || []).map((work) => {
    const legacy = legacyArtists.get(exhibition.slug)?.get(work.id);
    const urls = Object.fromEntries(VARIANTS.map(([variant, key]) => [key, legacy?.[key] || lookup.get(mediaPath(exhibition.slug, work.id, variant)) || '']));
    if (Object.values(urls).some((url) => !url)) throw fail(503, 'Не удалось открыть подготовленное изображение. Проверьте хранилище галереи.');
    return { ...work, ...fitArtwork(work.widthPx, work.heightPx), ...urls };
  }) }));
}

function draftRow(row, published) {
  return { ...row.draft, slug: row.slug, revision: row.revision, published };
}

async function readDraft(client, slug, signal) {
  const row = await unwrap(client.from('gallery_drafts').select('slug,draft,revision').eq('slug', slug).maybeSingle(), signal);
  if (!row) throw fail(404, 'Выставка не найдена.');
  return row;
}

async function readPublished(client, slug, signal) {
  return Boolean(await unwrap(client.from('gallery_publications').select('slug').eq('slug', slug).maybeSingle(), signal));
}

function text(value, limit, field, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) throw fail(400, `Проверьте поле «${field}».`);
  return value.trim();
}

function dimensions(work) {
  const width = work.widthCm === '' || work.widthCm == null ? undefined : Number(work.widthCm);
  const height = work.heightCm === '' || work.heightCm == null ? undefined : Number(work.heightCm);
  if ((width === undefined) !== (height === undefined) || (width !== undefined && (![width, height].every((n) => Number.isFinite(n) && n > 0 && n <= 10_000)))) {
    throw fail(400, 'Укажите оба размера картины в сантиметрах или оставьте оба поля пустыми.');
  }
  return { widthCm: width, heightCm: height };
}

function sanitizeDraft(slug, input, existing) {
  const knownWorks = new Map((existing.works || []).map((work) => [work.id, work]));
  if (!Array.isArray(input.works) || input.works.length > 100 || new Set(input.works.map((work) => work.id)).size !== input.works.length) {
    throw fail(400, 'В выставке допускается не более 100 работ без повторений.');
  }
  if (!Array.isArray(input.aliases) || input.aliases.length > 20) throw fail(400, 'Укажите не больше 20 вариантов имени.');
  const color = (value, fallback) => /^#[0-9a-f]{6}$/i.test(value || '') ? value : fallback;
  return {
    slug,
    name: text(input.name, 200, 'ФИО', true),
    years: text(input.years, 80, 'Годы'),
    biography: text(input.biography, 20_000, 'Биография'),
    aliases: input.aliases.map((alias) => text(alias, 200, 'Вариант имени', true)),
    room: { wallColor: color(input.room?.wallColor, '#e9e4da'), frameColor: color(input.room?.frameColor, '#171716') },
    works: input.works.map((work) => {
      const original = knownWorks.get(work.id);
      if (!original) throw fail(400, 'Сначала загрузите изображение для этой работы.');
      return {
        ...original,
        title: text(work.title, 200, 'Название картины', true),
        year: text(work.year, 40, 'Год'),
        medium: text(work.medium, 200, 'Техника'),
        description: text(work.description, 10_000, 'Описание'),
        ...dimensions(work),
        rightsConfirmed: work.rightsConfirmed === true,
        visible: work.visible !== false
      };
    })
  };
}

async function updateDraft(client, row, draft, signal) {
  const saved = await unwrap(client.from('gallery_drafts').update({ draft, revision: row.revision + 1 })
    .eq('slug', row.slug).eq('revision', row.revision).select('slug,draft,revision').maybeSingle(), signal);
  if (!saved) throw fail(409, 'Черновик изменён в другой вкладке. Обновите данные перед сохранением.');
  return saved;
}

async function upload(client, slug, file, signal) {
  const row = await readDraft(client, slug, signal);
  if (row.draft.works.length >= 100) throw fail(400, 'В выставке не может быть больше 100 работ.');
  const { prepareImage } = await import('./browser-image.js');
  const { format, mime, width, height, variants } = await prepareImage(file, signal);
  const id = crypto.randomUUID();
  const sourceName = file.name.slice(0, 255);
  const work = { id, title: sourceName.replace(/\.[^.]+$/, '').trim().slice(0, 200) || 'Без названия', sourceFormat: format,
    sourceName, widthPx: width, heightPx: height, year: '', medium: '', description: '', visible: true, rightsConfirmed: false };
  const images = client.storage.from(IMAGE_BUCKET);
  const originals = client.storage.from(ORIGINAL_BUCKET);
  const originalPath = `${slug}/${id}/original`;
  const paths = VARIANTS.map(([variant]) => mediaPath(slug, id, variant));
  let saved;
  try {
    // Supabase uploads Blob bodies as multipart and uses the Blob's MIME type.
    await unwrap(originals.upload(originalPath, file.slice(0, file.size, mime), { cacheControl: '0', upsert: false }), signal);
    for (const [variant] of VARIANTS) {
      signal?.throwIfAborted();
      await unwrap(images.upload(mediaPath(slug, id, variant), variants[variant], { cacheControl: '0', upsert: false }), signal);
    }
    const [hydrated] = await hydrate(client, [{ slug, works: [work] }], signal);
    if (!hydrated.works[0].imageSrc) throw fail(503, 'Не удалось получить ссылку на подготовленное изображение.');
    saved = await updateDraft(client, row, { ...row.draft, works: [...row.draft.works, work] }, signal);
    return { ...hydrated.works[0], artistRevision: saved.revision };
  } catch (error) {
    // Storage policies allow cleanup only for files not attached to a draft or publication.
    if (!saved) await Promise.allSettled([images.remove(paths), originals.remove([originalPath])]);
    throw error;
  }
}

export async function cloudApi(path, { method = 'GET', body, signal } = {}) {
  signal?.throwIfAborted();
  const { admin, public: publicClient } = await getClients();
  if (path === 'artists' && method === 'GET') {
    const rows = await unwrap(publicClient.from('gallery_publications').select('slug,exhibition').order('slug'), signal);
    return hydrate(publicClient, rows.map(({ slug, exhibition }) => ({ ...exhibition, slug })), signal);
  }
  if (path === 'status' && method === 'GET') {
    await unwrap(publicClient.from('gallery_publications').select('slug').limit(1), signal);
    return status(await authenticated(admin, signal));
  }
  if (path === 'login' && method === 'POST') {
    const email = text(body?.email, 254, 'Email', true);
    const password = body?.password;
    if (typeof password !== 'string' || !password || password.length > 128) throw fail(400, 'Введите пароль.');
    const { error } = await admin.auth.signInWithPassword({ email, password });
    if (error) throw Number(error.status) === 400 ? fail(400, 'Неверный email или пароль.') : dbError(error);
    if (!await authenticated(admin, signal)) throw fail(400, 'Этой учётной записи не назначены права администратора.');
    return status(true);
  }
  if (path === 'logout' && method === 'POST') {
    await unwrap(admin.auth.signOut({ scope: 'local' }), signal);
    return status(false);
  }
  if (!await authenticated(admin, signal)) throw fail(401, 'Войдите как администратор.');
  if (path === 'admin/artists' && method === 'GET') {
    const [drafts, published] = await Promise.all([
      unwrap(admin.from('gallery_drafts').select('slug,draft,revision').order('slug'), signal),
      unwrap(admin.from('gallery_publications').select('slug'), signal)
    ]);
    const publishedSlugs = new Set(published.map(({ slug }) => slug));
    return hydrate(admin, drafts.map((row) => draftRow(row, publishedSlugs.has(row.slug))), signal);
  }
  if (path === 'admin/artists' && method === 'POST') {
    const slug = text(body?.slug, 80, 'Адрес', true);
    if (!SCOPE.test(slug)) throw fail(400, 'В адресе допустимы только строчные латинские буквы, цифры и дефисы.');
    const draft = sanitizeDraft(slug, { name: body?.name, aliases: [], works: [] }, {});
    const row = await unwrap(admin.from('gallery_drafts').insert({ slug, draft }).select('slug,draft,revision').single(), signal);
    return draftRow(row, false);
  }
  const match = /^admin\/artists\/([a-z0-9][a-z0-9-]{0,79})(?:\/(publish|unpublish|uploads))?$/.exec(path);
  if (!match) throw fail(404, 'Действие не найдено.');
  const [, slug, action] = match;
  if (action === 'uploads' && method === 'POST') return upload(admin, slug, body, signal);
  const row = await readDraft(admin, slug, signal);
  if (!action && method === 'PUT') {
    if (body?.revision !== row.revision) throw fail(409, 'Черновик изменён в другой вкладке. Обновите данные перед сохранением.');
    const draft = sanitizeDraft(slug, body, row.draft);
    const [hydrated] = await hydrate(admin, [draftRow({ ...row, draft }, await readPublished(admin, slug, signal))], signal);
    const saved = await updateDraft(admin, row, draft, signal);
    return { ...hydrated, revision: saved.revision };
  }
  if ((action === 'publish' || action === 'unpublish') && method === 'POST') {
    if (!Number.isInteger(body?.revision) || body.revision !== row.revision) throw fail(409, 'Черновик изменён в другой вкладке. Обновите данные.');
    const published = action === 'publish';
    const [hydrated] = await hydrate(admin, [draftRow(row, published)], signal);
    const revision = await unwrap(admin.rpc('gallery_publish', { p_slug: slug, p_revision: body.revision, p_publish: published }), signal);
    return { ...hydrated, revision };
  }
  throw fail(405, 'Метод не поддерживается.');
}
