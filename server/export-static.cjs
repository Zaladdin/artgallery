const fs = require('node:fs/promises');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const CODE_EXTENSIONS = new Set(['.html', '.js', '.css', '.svg', '.ico']);
const MEDIA_PATH = /^\/media\/([a-f0-9-]{36})\/(full|scene|thumb)\.jpg$/;
const STATIC_PATH = /^\.\/assets\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png|webp)$/;

function inside(root, filename) {
  const relative = path.relative(root, filename);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function checkedFile(root, relative) {
  const filename = path.resolve(root, relative);
  if (!inside(root, filename)) throw new Error('Export asset is outside its expected directory.');
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Export assets must be ordinary files.');
  const realRoot = await fs.realpath(root);
  const realFile = await fs.realpath(filename);
  if (!inside(realRoot, realFile)) throw new Error('Export asset resolves outside its expected directory.');
  return filename;
}

async function exportStatic(options = {}) {
  const staticDir = path.resolve(options.staticDir || path.join(ROOT, 'prototype'));
  const dataDir = path.resolve(options.dataDir || process.env.GALLERY_DATA_DIR || path.join(ROOT, '.gallery-data'));
  const outputDir = path.resolve(options.outputDir || path.join(ROOT, 'dist'));
  if (inside(dataDir, outputDir) || inside(staticDir, outputDir)) throw new Error('Export output cannot be inside the source site or private data directory.');
  try {
    await fs.lstat(outputDir);
    throw new Error('Output already exists. Choose a new directory with --out; no existing files will be overwritten.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await checkedFile(dataDir, 'gallery.sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'gallery.sqlite'), { readOnly: true });
  let snapshots;
  try {
    snapshots = db.prepare('SELECT published FROM artists WHERE published IS NOT NULL ORDER BY slug').all().map((row) => JSON.parse(row.published));
  } finally { db.close(); }

  const assets = new Map();
  function imageReference(value) {
    if (typeof value !== 'string') throw new Error('A published image reference is missing.');
    const media = MEDIA_PATH.exec(value);
    if (media) {
      const relative = `media/${media[1]}/${media[2]}.jpg`;
      assets.set(relative, { root: dataDir, relative });
      return `./${relative}`;
    }
    if (STATIC_PATH.test(value)) {
      const relative = value.slice(2);
      assets.set(relative, { root: staticDir, relative });
      return value;
    }
    throw new Error('Published images must reference local prepared gallery assets.');
  }
  const artists = snapshots.map((artist) => ({
    slug: artist.slug,
    name: artist.name,
    years: artist.years || '',
    aliases: artist.aliases || [],
    biography: artist.biography || '',
    room: artist.room || {},
    works: artist.works.filter((work) => work.visible !== false).map((work) => {
      const result = {};
      for (const key of ['id', 'title', 'year', 'medium', 'description', 'widthCm', 'heightCm', 'widthPx', 'heightPx', 'displayWidthM', 'displayHeightM', 'sourceFormat']) {
        if (work[key] !== undefined) result[key] = work[key];
      }
      result.imageSrc = imageReference(work.imageSrc);
      result.sceneImageSrc = imageReference(work.sceneImageSrc);
      result.thumbnailSrc = imageReference(work.thumbnailSrc);
      return result;
    })
  }));

  // Copy only executable site files plus explicitly published image references.
  // Upload originals, SQLite, drafts and unreferenced artwork are never traversed.
  async function collectCode(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (prefix === '' && entry.name === 'assets') continue;
        await collectCode(path.join(directory, entry.name), relative);
      } else if (entry.isFile() && CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && entry.name !== 'serve.js') {
        assets.set(relative, { root: staticDir, relative });
      }
    }
  }
  await collectCode(staticDir);
  for (const asset of assets.values()) asset.source = await checkedFile(asset.root, asset.relative);
  const parent = path.dirname(outputDir);
  await fs.mkdir(parent, { recursive: true });
  const stagingDir = await fs.mkdtemp(path.join(parent, '.gallery-export-'));
  try {
    for (const [relative, asset] of assets) {
      const target = path.join(stagingDir, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(asset.source, target);
    }
    await fs.writeFile(path.join(stagingDir, 'catalog.json'), JSON.stringify(artists, null, 2) + '\n', { flag: 'wx' });
    await fs.writeFile(path.join(stagingDir, '.nojekyll'), '', { flag: 'wx' });
    // The destination must still be absent. Rename publishes only a complete build.
    try { await fs.lstat(outputDir); throw new Error('Output was created during export; choose a new directory.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rename(stagingDir, outputDir);
    return { outputDir, artists: artists.length, works: artists.reduce((sum, artist) => sum + artist.works.length, 0), assets: assets.size };
  } catch (error) {
    // Only the fresh directory created by this function can be removed.
    if (inside(parent, stagingDir) && path.basename(stagingDir).startsWith('.gallery-export-')) await fs.rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--out')) {
    console.error('Usage: npm run export:static -- [--out NEW_OUTPUT_DIRECTORY]');
    process.exitCode = 1;
  } else {
    exportStatic({ outputDir: args[1] }).then((result) => console.log(`Exported ${result.artists} artists / ${result.works} works to ${result.outputDir}`)).catch((error) => { console.error('Export failed:', error.message); process.exitCode = 1; });
  }
}

module.exports = { exportStatic };
