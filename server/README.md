# Local gallery authoring server

Requires Node.js 22.13+ (Node 22 currently labels its built-in SQLite module experimental).

```powershell
npm ci
npm start
```

Open `http://127.0.0.1:4173/#/admin`. The first administrator chooses a password of 12–128 characters. No default password is shipped. The server listens only on loopback; do not expose it directly to a public network. Hosted deployment needs an HTTPS reverse proxy, Secure session cookies, a backup policy and hosting-specific configuration. GitHub Pages continues to host the static public gallery but cannot run this authoring API.

Configuration:

- `PORT`: listening port, default 4173.
- `GALLERY_DATA_DIR`: absolute or working-directory-relative private data directory; default `.gallery-data` at the repository root. It cannot be inside `prototype`.

SQLite stores the scrypt password hash, eight-hour sessions, rate-limit counters, draft artists and published snapshots. Passwords and session tokens are never stored in plaintext. The data directory is ignored by Git. Back up the entire directory while the server is stopped; SQLite WAL files must not be omitted from a live copy.

The first start imports `defaultArtists` from `prototype/collection-data.js`. Existing static art remains a legacy published collection, without inventing a rights confirmation. Subsequent publication requires the administrator to confirm rights for every visible work. Saving a draft never changes an existing published snapshot. Unpublishing removes the artist from the API and prevents anonymous access to newly uploaded media.

New uploads accept real JPEG, PNG and HEIC/HEIF signatures with matching file extensions, up to 25 MiB and 50 megapixels. Each job runs in a worker thread with a 60-second timeout, at most two simultaneous jobs. JPEG/PNG EXIF rotation is normalized. HEIC is decoded by libheif through `heic-decode`; prepared JPEG derivatives are generated with Sharp at maximum edges 2048, 1024 and 320 pixels. Original files remain private and have no public HTTP route. There is no automatic crop. HEIC support is fixture-tested but not a guarantee for every camera-specific or HDR variant; unsupported files receive a recoverable error.

Mutation requests require an exact same-origin `Origin` header; authenticated mutations additionally require `X-CSRF-Token`. Sessions use HttpOnly and SameSite=Strict cookies. API/login/upload limits are persisted in SQLite. The current deployment is single-process. Security headers prohibit framing, MIME guessing, third-party media and arbitrary scripts. The CSP allows style attributes because existing Three.js/UI code uses validated inline CSS values; inline script hashes are computed from the shipped import map.

Run integration tests:

```powershell
npm test
```

Optional real HEIC conversion test: download the upstream libheif `examples/example.heic` fixture outside the repository, set `GALLERY_HEIC_FIXTURE` to its path, then run `npm test`. The fixture is not bundled in this project.

The API returns direct artist arrays and objects. Uploads return a direct work object plus `artistRevision`; clients should update the draft revision before saving. Stale saves return 409. Image paths and source metadata are server-controlled and cannot be replaced by arbitrary URLs in save requests.

## Static publication export

After publishing through the local admin interface, run `npm run export:static`. This reads only SQLite published snapshots and builds `dist/` with `catalog.json`, the static frontend and referenced image derivatives. Media URLs become relative so project sites such as GitHub Pages `/artgallery/` work. No original uploads, draft JSON, SQLite databases, passwords or sessions are exported. Unreferenced artwork images are omitted.

An existing destination is never deleted or overwritten. To create another export, choose a fresh directory with `npm run export:static -- --out dist-next`. A staging directory is renamed only after all assets have been validated and copied. This command prepares a build; it does not push to GitHub or deploy a website. Publish the **entire fresh build** as the hosting artifact, rather than merging it with an older export, so previously unpublished media is removed from the hosted artifact.
