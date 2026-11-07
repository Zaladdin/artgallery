const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { exportStatic } = require('./export-static.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gallery-export-test-'));
  const staticDir = path.join(directory, 'prototype');
  const dataDir = path.join(directory, 'private');
  const outputDir = path.join(directory, 'output');
  await fs.mkdir(staticDir);
  await fs.mkdir(dataDir);
  await fs.writeFile(path.join(staticDir, 'index.html'), '<html>Gallery</html>');
  await fs.writeFile(path.join(staticDir, 'app.js'), '/* public app */');
  await fs.writeFile(path.join(staticDir, 'serve.js'), '/* private development server */');
  const db = new DatabaseSync(path.join(dataDir, 'gallery.sqlite'));
  db.exec('CREATE TABLE artists(slug TEXT PRIMARY KEY, draft TEXT, published TEXT); CREATE TABLE config(key TEXT, value TEXT);');
  db.prepare('INSERT INTO config VALUES (?,?)').run('admin', 'secret-password-hash');
  const publishedId = '11111111-1111-4111-8111-111111111111';
  const draftId = '22222222-2222-4222-8222-222222222222';
  for (const id of [publishedId, draftId]) {
    const media = path.join(dataDir, 'media', id);
    await fs.mkdir(media, { recursive: true });
    for (const file of ['full.jpg', 'scene.jpg', 'thumb.jpg', 'original']) await fs.writeFile(path.join(media, file), `${id}:${file}`);
  }
  const makeWork = (id) => ({ id, title: 'Published artwork', imageSrc: `/media/${id}/full.jpg`, sceneImageSrc: `/media/${id}/scene.jpg`, thumbnailSrc: `/media/${id}/thumb.jpg`, sourceName: 'private-original-filename.heic' });
  const published = { slug: 'published', name: 'Published Artist', aliases: [], works: [makeWork(publishedId)] };
  const draft = { ...published, name: 'Secret unpublished edit', works: [makeWork(draftId)] };
  db.prepare('INSERT INTO artists VALUES(?,?,?)').run('published', JSON.stringify(draft), JSON.stringify(published));
  db.prepare('INSERT INTO artists VALUES(?,?,NULL)').run('draft-only', JSON.stringify({ name: 'Secret draft artist', works: [makeWork(draftId)] }));
  db.close();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, staticDir, dataDir, outputDir, publishedId, draftId };
}

test('static export includes published snapshots and only referenced derivatives', async (t) => {
  const options = await fixture(t);
  const result = await exportStatic(options);
  assert.equal(result.artists, 1);
  assert.equal(result.works, 1);
  const catalogText = await fs.readFile(path.join(options.outputDir, 'catalog.json'), 'utf8');
  const catalog = JSON.parse(catalogText);
  assert.equal(catalog[0].name, 'Published Artist');
  assert.equal(catalog[0].works[0].imageSrc, `./media/${options.publishedId}/full.jpg`);
  assert.ok(!catalogText.includes('Secret'));
  assert.ok(!catalogText.includes('private-original-filename'));
  const exported = await fs.readdir(options.outputDir, { recursive: true });
  assert.ok(exported.includes('index.html'));
  assert.ok(exported.includes('app.js'));
  assert.ok(exported.includes('.nojekyll'));
  assert.ok(!exported.includes('serve.js'));
  assert.ok(exported.every((file) => !/original|sqlite|password|private/.test(file)));
  assert.equal((await fs.readdir(path.join(options.outputDir, 'media'))).join(','), options.publishedId);
  assert.deepEqual((await fs.readdir(path.join(options.outputDir, 'media', options.publishedId))).sort(), ['full.jpg', 'scene.jpg', 'thumb.jpg']);
});

test('existing export is never overwritten, including after unpublishing', async (t) => {
  const options = await fixture(t);
  await exportStatic(options);
  const db = new DatabaseSync(path.join(options.dataDir, 'gallery.sqlite'));
  db.exec('UPDATE artists SET published=NULL');
  db.close();
  await assert.rejects(exportStatic(options), /Output already exists/);
  const nextOutput = path.join(options.directory, 'next-export');
  const result = await exportStatic({ ...options, outputDir: nextOutput });
  assert.equal(result.artists, 0);
  assert.equal(await fs.readFile(path.join(nextOutput, 'catalog.json'), 'utf8'), '[]\n');
  await assert.rejects(fs.stat(path.join(nextOutput, 'media')), { code: 'ENOENT' });
});

test('export fails closed for missing derivatives and unsafe image references', async (t) => {
  const options = await fixture(t);
  await fs.unlink(path.join(options.dataDir, 'media', options.publishedId, 'scene.jpg'));
  await assert.rejects(exportStatic(options), { code: 'ENOENT' });
  await assert.rejects(fs.stat(options.outputDir), { code: 'ENOENT' });
  const db = new DatabaseSync(path.join(options.dataDir, 'gallery.sqlite'));
  const artist = JSON.parse(db.prepare('SELECT published FROM artists WHERE slug=?').get('published').published);
  artist.works[0].imageSrc = './assets/../../private/gallery.sqlite';
  db.prepare('UPDATE artists SET published=? WHERE slug=?').run(JSON.stringify(artist), 'published');
  db.close();
  await assert.rejects(exportStatic(options), /local prepared gallery assets/);
  await assert.rejects(fs.stat(options.outputDir), { code: 'ENOENT' });
});
