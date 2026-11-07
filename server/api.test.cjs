const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const http = require('node:http');
const { startServer } = require('./index.cjs');

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gallery-api-test-'));
  const app = await startServer({ dataDir, port: 0, seed: [] });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '';
  let csrf = '';
  t.after(async () => { await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const call = async (route, method = 'GET', body, extra = {}) => {
    const headers = { Origin: base, Cookie: cookie, 'X-CSRF-Token': csrf, ...extra };
    if (body !== undefined && !Buffer.isBuffer(body)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
    const response = await fetch(base + route, { method, headers, body });
    const nextCookie = response.headers.get('set-cookie');
    if (nextCookie) cookie = nextCookie.split(';')[0];
    const value = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.arrayBuffer();
    if (value.csrfToken) csrf = value.csrfToken;
    return { status: response.status, value, headers: response.headers };
  };
  return { app, base, call, get cookie() { return cookie; } };
}

test('setup, sessions, CSRF, password verification, and origin restrictions', async (t) => {
  const { call, base } = await fixture(t);
  assert.equal((await call('/api/status')).value.setupRequired, true);
  assert.equal((await call('/api/admin/artists')).status, 401);
  assert.equal((await call('/api/setup', 'POST', { password: 'short' })).status, 400);
  assert.equal((await call('/api/setup', 'POST', { password: 'a-long-test-password' }, { Origin: 'http://evil.example' })).status, 403);
  const setup = await call('/api/setup', 'POST', { password: 'a-long-test-password' });
  assert.equal(setup.status, 200);
  assert.match(setup.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await call('/api/admin/artists', 'POST', { name: 'Artist', slug: 'artist' }, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await call('/api/setup', 'POST', { password: 'another-good-password' })).status, 409);
  assert.equal((await call('/api/logout', 'POST', {})).status, 200);
  assert.equal((await call('/api/admin/artists')).status, 401);
  assert.equal((await call('/api/login', 'POST', { password: 'a-wrong-test-password' })).status, 401);
  assert.equal((await call('/api/login', 'POST', { password: 'a-long-test-password' })).status, 200);
  assert.equal((await call('/api/status')).value.authenticated, true);
  const hostSpoofStatus = await new Promise((resolve, reject) => {
    http.get(base + '/api/status', { headers: { Host: 'evil.example' } }, (response) => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(hostSpoofStatus, 403);
});

test('draft uploads stay private, publish snapshot isolates drafts, unpublish revokes media, original inaccessible', async (t) => {
  const { call, base } = await fixture(t);
  await call('/api/setup', 'POST', { password: 'test-publication-password' });
  const created = await call('/api/admin/artists', 'POST', { name: 'Test artist', slug: 'test-artist' });
  assert.equal(created.status, 201);
  assert.equal((await call('/api/artists')).value.length, 0);
  assert.equal((await call('/api/admin/artists/test-artist/publish', 'POST', {})).status, 400);
  const png = await sharp({ create: { width: 400, height: 800, channels: 3, background: '#336699' } }).png().toBuffer();
  const uploaded = await call('/api/admin/artists/test-artist/uploads', 'POST', png, { 'X-File-Name': encodeURIComponent('вертикальная.png'), 'Content-Type': 'image/png' });
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.value.widthPx, 400);
  assert.equal(uploaded.value.heightPx, 800);
  assert.equal(uploaded.value.rightsConfirmed, false);
  assert.ok(Math.abs(uploaded.value.displayWidthM / uploaded.value.displayHeightM - 0.5) < 0.001);
  const publicDraftMedia = await fetch(base + uploaded.value.imageSrc);
  assert.equal(publicDraftMedia.status, 404);
  assert.equal((await call(uploaded.value.imageSrc)).status, 200);
  let draft = (await call('/api/admin/artists')).value[0];
  assert.equal(draft.works.length, 1);
  draft.works[0].rightsConfirmed = true;
  let saved = await call('/api/admin/artists/test-artist', 'PUT', draft);
  assert.equal(saved.status, 200);
  assert.equal((await call('/api/admin/artists/test-artist', 'PUT', draft)).status, 409);
  assert.equal((await call('/api/admin/artists/test-artist/publish', 'POST', {})).status, 200);
  assert.equal((await fetch(base + uploaded.value.imageSrc)).status, 200);
  assert.equal((await fetch(base + uploaded.value.imageSrc.replace('full.jpg', 'original'))).status, 404);
  draft = (await call('/api/admin/artists')).value[0];
  draft.name = 'Changed only in draft';
  await call('/api/admin/artists/test-artist', 'PUT', draft);
  assert.equal((await call('/api/artists')).value[0].name, 'Test artist');
  await call('/api/admin/artists/test-artist/unpublish', 'POST', {});
  assert.equal((await call('/api/artists')).value.length, 0);
  assert.equal((await fetch(base + uploaded.value.imageSrc)).status, 404);
  assert.equal((await fetch(base + '/.gallery-data/gallery.sqlite')).status, 404);
  assert.ok([403, 404].includes((await fetch(base + '/%2e%2e%5cpackage.json')).status));
});

test('rejects forged images and unsafe metadata without publishing broken work', async (t) => {
  const { call } = await fixture(t);
  await call('/api/setup', 'POST', { password: 'test-validation-password' });
  assert.equal((await call('/api/admin/artists', 'POST', { name: 'Artist', slug: '../bad' })).status, 400);
  await call('/api/admin/artists', 'POST', { name: 'Artist', slug: 'artist' });
  const spoof = await call('/api/admin/artists/artist/uploads', 'POST', Buffer.from('<svg>bad</svg>'), { 'X-File-Name': 'picture.jpg' });
  assert.equal(spoof.status, 415);
  const corrupt = await call('/api/admin/artists/artist/uploads', 'POST', Buffer.from([0xff, 0xd8, 0xff, 0, 0]), { 'X-File-Name': 'picture.jpg' });
  assert.equal(corrupt.status, 422);
  const artist = (await call('/api/admin/artists')).value[0];
  assert.equal(artist.works.length, 0);
  artist.works = [{ id: 'forged', title: 'Forged', imageSrc: 'https://evil.example/image.jpg', rightsConfirmed: true }];
  assert.equal((await call('/api/admin/artists/artist', 'PUT', artist)).status, 400);
  assert.equal((await call('/api/admin/artists/artist/publish', 'POST', {})).status, 400);
});

test('login limit persists in SQLite', async (t) => {
  const { call, app } = await fixture(t);
  await call('/api/setup', 'POST', { password: 'test-limiting-password' });
  for (let attempt = 0; attempt < 9; attempt += 1) await call('/api/login', 'POST', { password: 'incorrect-password' });
  assert.equal((await call('/api/login', 'POST', { password: 'test-limiting-password' })).status, 429);
  assert.equal(app.db.prepare("SELECT count FROM limits WHERE key LIKE 'login:%'").get().count, 10);
});

test('JPEG EXIF orientation is applied before generating browser versions', async (t) => {
  const { call } = await fixture(t);
  await call('/api/setup', 'POST', { password: 'test-orientation-password' });
  await call('/api/admin/artists', 'POST', { name: 'Orientation', slug: 'orientation' });
  const rotated = await sharp({ create: { width: 800, height: 400, channels: 3, background: '#336699' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const uploaded = await call('/api/admin/artists/orientation/uploads', 'POST', rotated, { 'X-File-Name': 'rotated.jpg' });
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.value.widthPx, 400);
  assert.equal(uploaded.value.heightPx, 800);
  const image = await call(uploaded.value.imageSrc);
  const metadata = await sharp(Buffer.from(image.value)).metadata();
  assert.equal(metadata.width, 400);
  assert.equal(metadata.height, 800);
  assert.equal(metadata.orientation, undefined);
});

test('HEIC fixture decodes to compatible JPEG versions', { skip: !process.env.GALLERY_HEIC_FIXTURE }, async (t) => {
  const { call } = await fixture(t);
  await call('/api/setup', 'POST', { password: 'test-heic-image-password' });
  await call('/api/admin/artists', 'POST', { name: 'HEIC', slug: 'heic' });
  const input = await fs.readFile(process.env.GALLERY_HEIC_FIXTURE);
  const uploaded = await call('/api/admin/artists/heic/uploads', 'POST', input, { 'X-File-Name': 'example.heic' });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.value));
  assert.equal(uploaded.value.sourceFormat, 'HEIC');
  assert.ok(uploaded.value.widthPx > 0 && uploaded.value.heightPx > 0);
  const image = await call(uploaded.value.imageSrc);
  assert.equal(image.headers.get('content-type'), 'image/jpeg');
  const metadata = await sharp(Buffer.from(image.value)).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.ok(metadata.width <= 2048 && metadata.height <= 2048);
});

test('artists and password configuration survive server restart', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gallery-restart-test-'));
  let app;
  try {
    app = await startServer({ dataDir, port: 0, seed: [] });
    let base = `http://127.0.0.1:${app.server.address().port}`;
    const setup = await fetch(base + '/api/setup', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'restart-test-password' }) });
    const session = await setup.json();
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    await fetch(base + '/api/admin/artists', { method: 'POST', headers: { Origin: base, Cookie: cookie, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Persistent Artist', slug: 'persistent' }) });
    await app.close();
    app = await startServer({ dataDir, port: 0, seed: [] });
    base = `http://127.0.0.1:${app.server.address().port}`;
    const status = await fetch(base + '/api/status').then((response) => response.json());
    assert.equal(status.setupRequired, false);
    const response = await fetch(base + '/api/admin/artists', { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    assert.equal((await response.json())[0].name, 'Persistent Artist');
  } finally {
    if (app) await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
