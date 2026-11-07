# Local gallery authoring server

Requires Node.js 22.13+ (Node 22 currently labels its built-in SQLite module experimental).

```powershell
npm ci
npm start
```

Open `http://127.0.0.1:4173/#/admin`. The first administrator chooses a password of 12–128 characters. No default password is shipped. Local mode listens only on loopback. GitHub Pages serves the static public gallery but cannot run this authoring API.

## Online admin and gallery

The repository's `render.yaml` provisions one Node web service and a persistent disk for SQLite and uploaded images. Import the repository under **New → Blueprint** in the Render dashboard. Review the paid service and disk before applying. The Standard plan leaves memory for large image conversions. Supply `GALLERY_ADMIN_PASSWORD` directly in the hosting dashboard as a unique 16–128 character password. Never commit it or pass it in a URL. Once the service is healthy, open its HTTPS URL followed by `/#/admin`. Use the same service's public gallery URL for visitors: publishing from the editor updates that site directly. The separate GitHub Pages site stays a static copy.

Hosted mode takes its canonical HTTPS origin from `GALLERY_PUBLIC_ORIGIN` or Render's `RENDER_EXTERNAL_URL`. It uses `PORT`, binds to the provider's network, and must sit behind the provider's HTTPS proxy; do not expose its raw Node port on an unmanaged host. Configure a single canonical domain for both user requests and health checks. Set `GALLERY_DATA_DIR` to an attached persistent volume outside the frontend directory. The provided blueprint uses `/var/data` and `/health`. Do not scale this SQLite service to multiple instances.

On the first boot against a new disk, the server requires the provisioning password and stores its scrypt hash. Existing stored passwords are not overwritten by the environment variable. Browser-based initial setup is disabled in hosted mode. Sessions are host-bound Secure, HttpOnly, SameSite=Strict cookies. On Render, sign-in limits use the validated `CF-Connecting-IP` supplied by its public edge; other deployments use the socket address. Keep this service isolated from untrusted private-network clients. Signed-in API calls have a per-session limit. The gallery remains readable even if login is temporarily limited.

On an empty disk the existing bundled exhibition is seeded. Local database changes and uploaded files do not migrate automatically. To migrate an existing gallery, make a consistent copy of the stopped local server's data directory and restore it on the persistent volume before starting the new instance. Keep private backups off GitHub. After deployment verify `/health`, login, a draft upload and preview, and that public viewing reflects publication.

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
