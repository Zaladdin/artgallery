import { createRoomForArtworkCount } from "./gallery-config.js";
import { mountArtworkViewer } from "./artwork-viewer.js";
import { defaultArtists, fitArtwork } from './collection-data.js';
import { isCloudMediaUrl, usesCloudGallery } from './supabase-config.js';

let artists = defaultArtists;
let artist = artists[0];
let artistGalleryRoute = `/gallery/${artist.slug}`;
const legacyArtistGalleryRoutes = new Set(["/gallery/leila-mirzaeva"]);
let room = createRoomForArtworkCount(artist.works.length);
let adminCleanup = () => {};
let routeRevision = 0;
let catalogLoadError = '';

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function mediaPath(source) {
  if (isCloudMediaUrl(source)) return source;
  return typeof source === 'string' && /^(?:\.\/assets\/[a-z0-9/_-]+\.jpg|(?:\.\/|\/)media\/[a-z0-9-]+\/(?:full|scene|thumb)\.jpg)$/i.test(source) ? source : '';
}

function refreshCloudImageOnError(image) {
  if (!image || !isCloudMediaUrl(image.src)) return;
  const preview = route().startsWith('/preview/');
  image.addEventListener('error', async () => {
    try {
      const { refreshCloudMedia } = await import('./supabase-gallery.js');
      const replacement = await refreshCloudMedia(image.src, { preview });
      if (image.isConnected && isCloudMediaUrl(replacement)) image.src = replacement;
    } catch {
      // Keep the alt text if the work was unpublished or storage is unreachable.
    }
  }, { once: true });
}

function prepareArtist(value) {
  return { ...value, aliases: value.aliases || [], works: value.works.filter((work) => work.visible !== false).map((work) => ({
    ...work,
    imageSrc: mediaPath(work.imageSrc), sceneImageSrc: mediaPath(work.sceneImageSrc), thumbnailSrc: mediaPath(work.thumbnailSrc),
    ...fitArtwork(work.widthPx || work.displayWidthM, work.heightPx || work.displayHeightM)
  })) };
}

async function fetchArtists() {
  if (usesCloudGallery()) {
    const { cloudApi } = await import('./supabase-gallery.js');
    return cloudApi('artists', { signal: AbortSignal.timeout(8000) });
  }
  const response = await fetch('./api/artists', { signal: AbortSignal.timeout(5000), cache: 'no-store' });
  if (response.status === 404) {
    const snapshot = await fetch('./catalog.json', { signal: AbortSignal.timeout(5000), cache: 'no-store' });
    if (snapshot.status === 404) return defaultArtists;
    if (!snapshot.ok) throw new Error('Не удалось загрузить каталог выставок.');
    return await snapshot.json();
  }
  if (!response.ok) throw new Error('Не удалось загрузить выставки. Попробуйте обновить страницу.');
  return await response.json();
}

const app = document.querySelector("#app");
let galleryScene = null;
let gallerySceneRevision = 0;
let gallerySceneAbortController = null;
let artworkOpener = null;
let closeWorksDrawer = () => {};
let showGalleryCatalog = () => {};
let galleryMovementFocusTarget = null;
const MAP_INSET_PERCENT = 14;
let galleryLightLevel = 100;

function normalise(value) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");
}

function formatDimensions(work) {
  if (Number.isFinite(work.widthCm) && Number.isFinite(work.heightCm)) return `${work.widthCm} × ${work.heightCm} см`;
  return "Размер оригинала не указан";
}

function formatWorkMeta(work) {
  return escapeHtml([work.year, work.medium].filter(Boolean).join(" · ") || 'Живопись');
}

function formatArtworkDetails(work) {
  return [work.year, work.medium].filter(Boolean).concat([formatDimensions(work)]).map(escapeHtml).join("<br>");
}

function formatMetres(value) {
  return value.toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function mapPosition(value, dimension) {
  const fraction = Math.min(1, Math.max(0, value / dimension));
  return MAP_INSET_PERCENT + fraction * (100 - MAP_INSET_PERCENT * 2);
}

function disposeGalleryScene() {
  gallerySceneRevision += 1;
  gallerySceneAbortController?.abort();
  gallerySceneAbortController = null;
  galleryScene?.dispose();
  galleryScene = null;
  galleryMovementFocusTarget = null;
}

function setGalleryLightLevel(value) {
  const numericValue = Number(value);
  galleryLightLevel = Math.round(Math.min(100, Math.max(0, Number.isFinite(numericValue) ? numericValue : 100)));
  galleryLightLevel = galleryScene?.setLightLevel(galleryLightLevel) ?? galleryLightLevel;

  const slider = document.querySelector("#room-light-level");
  const output = document.querySelector("#room-light-value");
  if (slider) {
    slider.value = String(galleryLightLevel);
    slider.setAttribute("aria-valuetext", `${galleryLightLevel}%`);
  }
  if (output) output.textContent = `${galleryLightLevel}%`;
  return galleryLightLevel;
}

function updateCameraUi({ state, message = "" } = {}) {
  if (!state) return;
  const stage = document.querySelector(".gallery-stage");
  if (!stage) return;

  const fromEntrance = state.x + room.widthM / 2;
  const fromLeftWall = state.z + room.depthM / 2;
  const mapX = state.isMoving && Number.isFinite(state.targetX) ? state.targetX : state.x;
  const mapZ = state.isMoving && Number.isFinite(state.targetZ) ? state.targetZ : state.z;
  const mapFromEntrance = mapX + room.widthM / 2;
  const mapFromLeftWall = mapZ + room.depthM / 2;
  const heading = Math.round(state.headingDegrees) % 360;
  const mapHeading = state.isMoving && Number.isFinite(state.targetHeadingDegrees)
    ? Math.round(state.targetHeadingDegrees) % 360
    : heading;
  const mapMotionDuration = state.isMoving && Number.isFinite(state.movementDurationMs)
    ? state.movementDurationMs
    : 280;
  const pitch = Math.round(state.pitchDegrees || 0);
  const verticalLook = Math.abs(pitch) < 1 ? "" : ` · ${pitch > 0 ? "вверх" : "вниз"} ${Math.abs(pitch)}°`;
  document.querySelector("#scene-position").textContent = `Точка обзора: ${formatMetres(fromEntrance)} м от входа`;
  document.querySelector("#scene-direction").textContent = `Взгляд: ${state.direction} · ${heading}°${verticalLook}`;
  stage.style.setProperty("--map-x", `${mapPosition(mapFromEntrance, room.widthM)}%`);
  stage.style.setProperty("--map-z", `${mapPosition(mapFromLeftWall, room.depthM)}%`);
  stage.style.setProperty("--map-heading", `${mapHeading}deg`);
  stage.style.setProperty("--map-motion-duration", `${mapMotionDuration}ms`);
  stage.toggleAttribute("data-moving", Boolean(state.isMoving));

  [
    { direction: "forward", stateKey: "canForward", label: "Вперёд", wall: "впереди стена" },
    { direction: "back", stateKey: "canBack", label: "Назад", wall: "позади стена" },
    { direction: "left", stateKey: "canLeft", label: "Влево", wall: "слева стена" },
    { direction: "right", stateKey: "canRight", label: "Вправо", wall: "справа стена" }
  ].forEach(({ direction, stateKey, label, wall }) => {
    if (!(stateKey in state)) return;
    const button = document.querySelector(`[data-direction="${direction}"]`);
    if (!button) return;
    const canMove = !state.isMoving && Boolean(state[stateKey]);
    button.disabled = Boolean(state.isMoving);
    button.setAttribute("aria-disabled", String(Boolean(state.isMoving)));
    button.toggleAttribute("data-blocked", !canMove);
    button.setAttribute("aria-label", state.isMoving ? "Выполняется перемещение" : canMove ? `${label}, шаг 1 метр` : `${label}: ${wall}`);
  });
  document.querySelectorAll("[data-viewpoint]").forEach((button) => {
    button.disabled = Boolean(state.isMoving);
    button.setAttribute("aria-disabled", String(Boolean(state.isMoving)));
  });
  const tourButton = document.querySelector('[data-tour]');
  if (tourButton) tourButton.disabled = !galleryScene || Boolean(state.isMoving) || stage.hidden || !artist.works.length;
  if (!state.isMoving && galleryMovementFocusTarget) {
    const focusTarget = galleryMovementFocusTarget;
    galleryMovementFocusTarget = null;
    if (focusTarget.isConnected && !focusTarget.disabled) focusTarget.focus({ preventScroll: true });
  }
  if (message) document.querySelector("#camera-status").textContent = message;
}

function runGalleryAction(direction) {
  if (!galleryScene) return;
  if (direction === "turn-left" || direction === "turn-right") galleryScene.turn(direction === "turn-left" ? "left" : "right");
  else if (direction === "look-up" || direction === "look-down") galleryScene.tilt(direction === "look-up" ? "up" : "down");
  else {
    const actionInitiator = document.activeElement;
    galleryMovementFocusTarget = actionInitiator instanceof HTMLElement ? actionInitiator : null;
    if (!galleryScene.move(direction)) galleryMovementFocusTarget = null;
  }
}

function setGalleryControlsEnabled(enabled) {
  document.querySelectorAll("[data-direction], [data-viewpoint]").forEach((button) => {
    button.disabled = !enabled;
  });
  const lightSlider = document.querySelector("#room-light-level");
  if (lightSlider) lightSlider.disabled = !enabled;
  const tourButton = document.querySelector('[data-tour]');
  if (tourButton) tourButton.disabled = !enabled || Boolean(document.querySelector('.gallery-stage')?.hidden) || !artist.works.length;
}

async function mountGalleryScene(mount, stage, revision) {
  const abortController = new AbortController();
  gallerySceneAbortController = abortController;
  try {
    const { createGalleryScene } = await import("./gallery-scene.js");
    if (revision !== gallerySceneRevision || abortController.signal.aborted || !mount.isConnected) return;

    const scene = await createGalleryScene({
      mount,
      works: artist.works,
      room,
      signal: abortController.signal,
      onArtworkClick: (work) => openArtwork(work, stage),
      onStateChange: (payload) => {
        if (revision === gallerySceneRevision) updateCameraUi(payload);
      }
    });

    if (revision !== gallerySceneRevision || abortController.signal.aborted || !mount.isConnected) {
      scene.dispose();
      return;
    }

    galleryScene = scene;
    if (gallerySceneAbortController === abortController) gallerySceneAbortController = null;
    setGalleryControlsEnabled(true);
    setGalleryLightLevel(galleryLightLevel);
    mount.querySelector("p")?.remove();
    mount.classList.remove("is-loading");
    stage.removeAttribute("aria-busy");
    updateCameraUi({ state: scene.getState() });
  } catch (error) {
    if (revision !== gallerySceneRevision || abortController.signal.aborted || !mount.isConnected) return;
    if (gallerySceneAbortController === abortController) gallerySceneAbortController = null;
    setGalleryControlsEnabled(false);
    mount.classList.remove("is-loading");
    mount.removeAttribute("aria-hidden");
    mount.innerHTML = '';
    stage.removeAttribute("aria-busy");
    showGalleryCatalog('3D-зал недоступен. Все картины можно рассмотреть в каталоге.');
    console.error("Gallery scene failed to load", error);
  }
}

function matchesArtist(query) {
  const q = normalise(query);
  if (!q) return [];
  return artists.filter((item) => [item.name, ...(item.aliases || [])].join(' ').toLocaleLowerCase('ru-RU').includes(q));
}

function route() {
  return (location.hash.replace("#", "") || "/").split('?')[0];
}

function go(path) {
  location.hash = path;
}

function focusRouteHeading() {
  const heading = document.querySelector("#main-content h1");
  const target = heading && getComputedStyle(heading).display !== "none"
    ? heading
    : document.querySelector("#main-content");
  target?.focus();
}

function renderLanding() {
  disposeGalleryScene();
  showGalleryCatalog = () => {};
  closeWorksDrawer = () => {};
  app.innerHTML = `
    <section class="landing" id="main-content" tabindex="-1" aria-labelledby="landing-title">
      <header class="landing-header">
        <a class="brand" href="#/" aria-label="Смотритель — на главную"><span class="brand-mark" aria-hidden="true">С</span>Смотритель</a>
        <button class="text-button" type="button" data-demo-admin>Войти как админ</button>
      </header>
      <div class="landing-content">
        <p class="eyebrow">Виртуальные экспозиции</p>
        <h1 id="landing-title" tabindex="-1">Войдите в мир<br>художника.</h1>
        <p class="landing-lede">Найдите художника и войдите в его зал. Осматривайтесь мышью, перемещайтесь стрелками, изучайте работы вблизи.</p>
        <div class="search-shell">
          <form class="search-box" id="artist-search" role="search">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="6.5"></circle><path d="m16 16 4.5 4.5"></path></svg>
            <label class="sr-only" for="artist-query">Найдите художника</label>
            <input id="artist-query" name="artist" autocomplete="off" placeholder="Введите ФИО или псевдоним" />
            <button class="button button-primary" type="submit">Открыть</button>
          </form>
          <div id="search-results" class="search-results" hidden></div>
        </div>
        <div class="available-exhibitions"><p>Открытые выставки</p>${artists.map((item) => `<a href="#/gallery/${escapeHtml(item.slug)}">${escapeHtml(item.name)} <span>${item.works.length} работ ↗</span></a>`).join('') || '<span>Новые выставки скоро появятся.</span>'}</div>
        ${catalogLoadError ? `<p role="alert">${escapeHtml(catalogLoadError)}</p>` : ''}
      </div>
      <footer class="landing-footer"><span>Смотритель · виртуальная картинная галерея</span><span>Искусство доступно каждому</span></footer>
    </section>`;

  const input = document.querySelector("#artist-query");
  const cover = mediaPath(artists.flatMap((item) => item.works)[0]?.imageSrc);
  if (cover) document.querySelector('.landing').style.setProperty('--landing-cover', `url("${cover}")`);
  const results = document.querySelector("#search-results");
  const form = document.querySelector("#artist-search");

  function showResults() {
    const items = matchesArtist(input.value);
    results.hidden = input.value.trim().length === 0;
    if (input.value.trim().length === 0) return;
    results.innerHTML = items.length
      ? items.map((item) => `<button class="artist-result" type="button" data-artist="${escapeHtml(item.slug)}"><span class="artist-avatar" aria-hidden="true">${escapeHtml(item.name[0])}</span><span><span class="result-name">${escapeHtml(item.name)}</span><span class="result-meta">${item.years ? `${escapeHtml(item.years)} · ` : ''}${item.works.length} работ</span></span></button>`).join("")
      : `<p class="no-results">Мы не нашли художника. Попробуйте ввести фамилию или псевдоним.</p>`;
  }

  input.addEventListener("input", showResults);
  input.addEventListener("focus", showResults);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const first = matchesArtist(input.value)[0];
    if (first) go(`/gallery/${first.slug}`);
    else showResults();
  });
  results.addEventListener("click", (event) => {
    const target = event.target.closest("[data-artist]");
    if (target) go(`/gallery/${target.dataset.artist}`);
  });
  document.querySelector("[data-demo-admin]").addEventListener("click", () => {
    go('/admin');
  });
}

function renderArtworkDialog(work) {
  const currentIndex = artist.works.findIndex((item) => item.id === work.id);
  const dialog = document.querySelector("#artwork-dialog");
  dialog.setAttribute("aria-labelledby", "artwork-dialog-title");
  dialog.innerHTML = `
    <button class="dialog-close" type="button" aria-label="Закрыть карточку">×</button>
    <div class="art-layout">
      <div class="art-visual">
        <div class="art-viewport" tabindex="0" role="region" aria-label="Изображение картины. После увеличения перемещайте изображение пальцем, мышью или клавишами прокрутки."><img src="${escapeHtml(work.imageSrc)}" alt="${escapeHtml(work.title)}" decoding="async" draggable="false" /></div>
        <div class="art-tools" role="group" aria-label="Масштаб изображения">
          <button type="button" data-zoom-out aria-label="Уменьшить картину">−</button>
          <output data-zoom-value aria-live="polite">100%</output>
          <button type="button" data-zoom-in aria-label="Увеличить картину">+</button>
          <button type="button" data-zoom-reset>Сбросить</button>
          <button type="button" data-art-fullscreen>Полный экран</button>
        </div>
      </div>
      <div class="art-copy">
        <p class="art-index">Работа ${currentIndex + 1} из ${artist.works.length}</p>
        <h2 id="artwork-dialog-title">${escapeHtml(work.title)}</h2>
        <p class="art-meta">${formatArtworkDetails(work)}</p>
        <p class="art-description">${escapeHtml(work.description || '')}</p>
        <button class="text-button share-artwork" type="button" data-share-art>Скопировать ссылку на картину</button>
        <p class="share-status" role="status"></p>
        <div class="dialog-nav"><button class="button button-quiet" type="button" data-prev-art>← Предыдущая</button><button class="button button-primary" type="button" data-next-art>Следующая →</button></div>
      </div>
    </div>`;
  dialog.querySelector(".dialog-close").addEventListener("click", () => dialog.close());
  mountArtworkViewer(dialog);
  refreshCloudImageOnError(dialog.querySelector('.art-viewport img'));
  dialog.querySelector('[data-share-art]').addEventListener('click', async () => {
    const url = new URL(location.href);
    url.hash = `${route()}?work=${encodeURIComponent(work.id)}`;
    try {
      await navigator.clipboard.writeText(url.href);
      dialog.querySelector('.share-status').textContent = 'Ссылка скопирована';
    } catch {
      const status = dialog.querySelector('.share-status');
      status.textContent = 'Скопируйте ссылку: ';
      const input = document.createElement('input');
      input.value = url.href; input.readOnly = true; input.setAttribute('aria-label', 'Ссылка на картину');
      status.append(input); input.focus(); input.select();
    }
  });
  dialog.querySelector("[data-prev-art]").addEventListener("click", () => openArtwork(artist.works[(currentIndex - 1 + artist.works.length) % artist.works.length], artworkOpener, "[data-prev-art]"));
  dialog.querySelector("[data-next-art]").addEventListener("click", () => openArtwork(artist.works[(currentIndex + 1) % artist.works.length], artworkOpener, "[data-next-art]"));
}

function openArtwork(work, opener = document.activeElement, focusTarget) {
  const dialog = document.querySelector("#artwork-dialog");
  if (!dialog.open) artworkOpener = opener;
  renderArtworkDialog(work);
  if (!dialog.open) dialog.showModal();
  if (focusTarget) dialog.querySelector(focusTarget)?.focus();
}

function renderGallery() {
  disposeGalleryScene();
  const sceneRevision = gallerySceneRevision;
  const mapAspect = Math.min(room.widthM / room.depthM, 5);
  app.innerHTML = `
    <section class="gallery" id="main-content" tabindex="-1" aria-label="Галерея ${escapeHtml(artist.name)}">
      <header class="gallery-bar">
        <button class="text-button gallery-back" type="button" data-home>← <span>К поиску</span></button>
        <h1 class="gallery-title" tabindex="-1">${escapeHtml(artist.name)}</h1>
        <button class="text-button gallery-list" type="button" data-open-list aria-controls="works-drawer" aria-expanded="false" aria-label="Открыть список из ${artist.works.length} работ"><span aria-hidden="true">☰</span><span class="list-label">Список работ</span></button>
      </header>
      <div class="gallery-modes" role="group" aria-label="Режим просмотра выставки">
        <button type="button" data-gallery-mode="room" aria-pressed="true" aria-controls="gallery-room">3D-зал</button>
        <button type="button" data-gallery-mode="catalog" aria-pressed="false" aria-controls="gallery-catalog">Каталог · ${artist.works.length}</button>
        <button type="button" data-tour>По картинам →</button>
        <button type="button" data-gallery-help aria-expanded="false" aria-controls="gallery-help">Помощь</button>
      </div>
      <div id="gallery-help" class="gallery-help" hidden><strong>Осмотр выставки</strong><p>Потяните изображение мышью или пальцем, чтобы осмотреться. Стрелки перемещают на один метр. Нажмите кольцо на полу, чтобы подойти к картине, или выберите «По картинам».</p><p>С клавиатуры: WASD — шаг, Q/E — поворот, R/F — взгляд вверх и вниз. Нажмите картину, чтобы увеличить её.</p><button class="button button-quiet" type="button" data-close-help>Понятно</button></div>
      <p class="gallery-notice" role="status" hidden></p>
      <div id="gallery-room" class="gallery-stage" tabindex="0" aria-busy="true" aria-describedby="scene-instructions" aria-label="Виртуальный зал ${escapeHtml(artist.name)}" style="--room-map-aspect: ${mapAspect} / 1">
        <div class="scene-host is-loading" id="scene-host" aria-hidden="true"><p>Загрузка 3D-зала…</p></div>
        <details class="scene-caption"><summary>О зале</summary><p>Зал: длина ${formatMetres(room.widthM)} м · ширина ${formatMetres(room.depthM)} м</p><strong id="scene-position">Загрузка…</strong><span id="scene-direction">Шаг 1 м · обзор 360°</span></details>
        <details class="lighting-control"><summary>Свет в зале</summary>
          <label for="room-light-level">Общий свет в зале <output id="room-light-value" for="room-light-level">${galleryLightLevel}%</output></label>
          <input id="room-light-level" type="range" min="0" max="100" step="1" value="${galleryLightLevel}" aria-valuetext="${galleryLightLevel}%" aria-describedby="room-light-hint" disabled />
          <span id="room-light-hint" class="sr-only">Регулирует общий свет в виртуальном зале. Прожекторы над картинами остаются включёнными.</span>
        </details>
        <p id="scene-instructions" class="sr-only">Размер комнаты: ${formatMetres(room.widthM)} × ${formatMetres(room.depthM)} м. Стрелка вверх или W делает плавный шаг вперёд на один метр, вниз или S — назад. Влево и вправо, либо A и D, делают боковой шаг на один метр относительно взгляда. Q и E поворачивают взгляд на пятнадцать градусов. Мышью или пальцем можно смотреть влево, вправо, вверх и вниз. Клавиши R и F наклоняют взгляд вверх и вниз; шаг при этом остаётся по полу. Круглые точки на полу перед картинами переносят к соответствующей работе; те же переходы доступны кнопками «К точке» в списке работ. Ползунок «Общий свет в зале» регулирует освещение комнаты, но прожекторы над картинами остаются включёнными.</p>
        <p id="camera-status" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></p>
        <nav class="navigation" aria-label="Перемещение по залу">
          <button class="nav-button" type="button" data-direction="forward" aria-label="Вперёд, шаг 1 метр" disabled>↑</button>
          <button class="nav-button" type="button" data-direction="left" aria-label="Влево, шаг 1 метр" disabled>←</button>
          <button class="nav-button" type="button" data-direction="back" aria-label="Назад, шаг 1 метр" disabled>↓</button>
          <button class="nav-button" type="button" data-direction="right" aria-label="Вправо, шаг 1 метр" disabled>→</button>
        </nav>
        <details class="map-toggle"><summary>План зала</summary><div class="room-map" aria-hidden="true"><span class="map-label map-label-far">Стена</span><span class="map-label map-label-entry">Вход</span><span class="map-cursor"></span></div></details>
        <aside class="works-drawer" id="works-drawer" hidden aria-label="Список из ${artist.works.length} работ">
          <div class="drawer-head"><h2>Работы · ${artist.works.length}</h2><button class="icon-button" type="button" data-close-list aria-label="Закрыть список работ">×</button></div>
          <p class="drawer-hint">Откройте работу или перейдите к точке перед ней в зале.</p>
          <div class="work-list">${artist.works.map((work) => `<article class="work-entry"><button class="work-card" type="button" data-work="${escapeHtml(work.id)}"><img class="work-thumb" src="${escapeHtml(work.thumbnailSrc)}" alt="" loading="lazy" decoding="async" /><span><h3>${escapeHtml(work.title)}</h3><p>${formatWorkMeta(work)}</p></span></button><button class="viewpoint-button" type="button" data-viewpoint="${escapeHtml(work.id)}" disabled aria-label="Перейти к точке обзора перед работой «${escapeHtml(work.title)}»">К точке<span class="sr-only"> обзора</span></button></article>`).join("")}</div>
        </aside>
      </div>
      <section id="gallery-catalog" class="gallery-catalog" aria-labelledby="catalog-title" hidden>
        <div class="catalog-heading"><p class="eyebrow">Коллекция</p><h2 id="catalog-title" tabindex="-1">${escapeHtml(artist.name)}</h2>${artist.biography ? `<p class="artist-biography">${escapeHtml(artist.biography)}</p>` : ''}<p>Выберите картину, чтобы рассмотреть её детали.</p></div>
        <div class="catalog-grid">${artist.works.map((work, index) => `<button type="button" class="catalog-card" data-work="${escapeHtml(work.id)}"><span class="catalog-image"><img src="${escapeHtml(work.sceneImageSrc)}" alt="" loading="lazy" decoding="async" /></span><span class="catalog-card-copy"><span class="catalog-number">${String(index + 1).padStart(2, '0')}</span><span>${escapeHtml(work.title)}</span><span class="catalog-action" aria-hidden="true">Рассмотреть ↗</span></span></button>`).join('')}</div>
      </section>
      <dialog id="artwork-dialog" class="art-dialog"></dialog>
    </section>`;

  const stage = document.querySelector(".gallery-stage");
  const sceneHost = document.querySelector("#scene-host");
  const drawer = document.querySelector("#works-drawer");
  const dialog = document.querySelector("#artwork-dialog");
  const listTrigger = document.querySelector("[data-open-list]");
  const closeListButton = document.querySelector("[data-close-list]");
  const lightSlider = document.querySelector("#room-light-level");
  const catalog = document.querySelector('#gallery-catalog');
  document.querySelectorAll('.catalog-image img, .work-thumb').forEach(refreshCloudImageOnError);
  const notice = document.querySelector('.gallery-notice');
  const tourButton = document.querySelector('[data-tour]');
  const help = document.querySelector('#gallery-help');
  const helpButton = document.querySelector('[data-gallery-help]');
  let tourIndex = 0;
  tourButton.disabled = true;
  function closeHelp() {
    help.hidden = true;
    helpButton.setAttribute('aria-expanded', 'false');
    helpButton.focus();
    try { localStorage.setItem('gallery-help-seen', '1'); } catch {}
  }
  helpButton.addEventListener('click', () => {
    help.hidden = !help.hidden;
    helpButton.setAttribute('aria-expanded', String(!help.hidden));
  });
  document.querySelector('[data-close-help]').addEventListener('click', closeHelp);
  try {
    if (!localStorage.getItem('gallery-help-seen')) {
      help.hidden = false;
      helpButton.setAttribute('aria-expanded', 'true');
    }
  } catch {}
  tourButton.addEventListener('click', () => {
    const work = artist.works[tourIndex];
    galleryMovementFocusTarget = tourButton;
    if (work && galleryScene?.moveToArtwork(work.id)) {
      tourIndex = (tourIndex + 1) % artist.works.length;
      tourButton.textContent = tourIndex ? `Следующая · ${tourIndex}/${artist.works.length} →` : 'Осмотреть заново →';
    } else galleryMovementFocusTarget = null;
  });
  let sceneFailed = false;
  function setMode(mode) {
    const isCatalog = mode === 'catalog';
    if (!isCatalog && sceneFailed) return;
    closeDrawer(false);
    stage.hidden = isCatalog;
    catalog.hidden = !isCatalog;
    listTrigger.hidden = isCatalog;
    if (isCatalog) {
      help.hidden = true;
      helpButton.setAttribute('aria-expanded', 'false');
    }
    tourButton.hidden = isCatalog;
    tourButton.disabled = isCatalog || !galleryScene || Boolean(galleryScene?.getState().isMoving) || !artist.works.length;
    document.querySelectorAll('[data-gallery-mode]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.galleryMode === mode));
    });
    if (isCatalog && galleryMovementFocusTarget) galleryMovementFocusTarget = null;
  }
  showGalleryCatalog = (message) => {
    sceneFailed = true;
    const focusWasInRoom = stage.contains(document.activeElement);
    setMode('catalog');
    const roomButton = document.querySelector('[data-gallery-mode="room"]');
    const roomButtonFocused = document.activeElement === roomButton;
    roomButton.disabled = true;
    notice.textContent = message;
    notice.hidden = false;
    if (focusWasInRoom || roomButtonFocused) document.querySelector('[data-gallery-mode="catalog"]').focus();
  };
  document.querySelectorAll('[data-gallery-mode]').forEach((button) => {
    button.addEventListener('click', () => setMode(button.dataset.galleryMode));
  });
  sceneHost.addEventListener("pointerdown", () => stage.focus({ preventScroll: true }));
  function closeDrawer(restoreFocus = true) {
    if (drawer.hidden) return;
    drawer.hidden = true;
    listTrigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) listTrigger.focus();
  }
  closeWorksDrawer = closeDrawer;
  document.querySelector("[data-home]").addEventListener("click", () => go("/"));
  listTrigger.addEventListener("click", () => {
    drawer.hidden = false;
    listTrigger.setAttribute("aria-expanded", "true");
    closeListButton.focus();
  });
  closeListButton.addEventListener("click", closeDrawer);
  document.querySelectorAll("[data-work]").forEach((button) => button.addEventListener("click", () => openArtwork(artist.works.find((work) => work.id === button.dataset.work), button)));
  document.querySelectorAll("[data-viewpoint]").forEach((button) => button.addEventListener("click", () => {
    if (galleryScene?.moveToArtwork(button.dataset.viewpoint)) closeDrawer();
  }));
  document.querySelectorAll("[data-direction]").forEach((button) => button.addEventListener("click", () => {
    runGalleryAction(button.dataset.direction);
  }));
  lightSlider.addEventListener("input", () => {
    setGalleryLightLevel(lightSlider.value);
  });
  dialog.addEventListener("close", () => {
    const target = artworkOpener && document.contains(artworkOpener) && !artworkOpener.hidden ? artworkOpener : stage;
    artworkOpener = null;
    target.focus();
  });
  mountGalleryScene(sceneHost, stage, sceneRevision);
  const linkedWork = new URLSearchParams(location.hash.split('?')[1] || '').get('work');
  const work = artist.works.find((item) => item.id === linkedWork);
  if (work) {
    setMode('catalog');
    openArtwork(work, document.querySelector(`.catalog-card[data-work="${CSS.escape(work.id)}"]`));
  }
}

async function renderRoute() {
  const revision = ++routeRevision;
  adminCleanup();
  adminCleanup = () => {};
  const currentRoute = route();
  if (legacyArtistGalleryRoutes.has(currentRoute)) {
    go(artistGalleryRoute);
    return;
  }
  if (currentRoute === '/admin') {
    disposeGalleryScene();
    const { renderAdmin } = await import('./admin.js');
    if (revision !== routeRevision) return;
    const cleanup = await renderAdmin(app);
    if (revision !== routeRevision) cleanup();
    else adminCleanup = cleanup;
    return;
  }
  const match = currentRoute.match(/^\/(gallery|preview)\/([a-z0-9-]+)$/);
  if (match) {
    let selected;
    if (match[1] === 'preview') {
      try {
        let drafts;
        if (usesCloudGallery()) {
          const { cloudApi } = await import('./supabase-gallery.js');
          drafts = await cloudApi('admin/artists', { signal: AbortSignal.timeout(12000) });
        } else {
          const response = await fetch('./api/admin/artists', { cache: 'no-store' });
          if (!response.ok) throw new Error('Войдите в админку для предпросмотра.');
          drafts = await response.json();
        }
        selected = drafts.find((item) => item.slug === match[2]);
      } catch {
        if (revision !== routeRevision) return;
        disposeGalleryScene();
        app.innerHTML = '<section class="route-message" id="main-content" tabindex="-1"><h1>Предпросмотр недоступен</h1><p>Войдите в админку и сохраните выставку.</p><a href="#/admin">Открыть админку</a></section>';
        return;
      }
    } else {
      try { artists = await fetchArtists(); }
      catch {
        if (revision !== routeRevision) return;
        disposeGalleryScene();
        app.innerHTML = '<section class="route-message" id="main-content" tabindex="-1"><h1>Выставка временно недоступна</h1><p>Не удалось получить данные. Обновите страницу.</p><a href="#/">К поиску</a></section>';
        return;
      }
      selected = artists.find((item) => item.slug === match[2]);
    }
    if (revision !== routeRevision) return;
    if (!selected) {
      disposeGalleryScene();
      app.innerHTML = '<section class="route-message" id="main-content" tabindex="-1"><h1>Выставка не найдена</h1><p>Возможно, она ещё не опубликована.</p><a href="#/">К поиску художников</a></section>';
      return;
    }
    artist = prepareArtist(selected);
    document.title = `${artist.name} — Смотритель`;
    artistGalleryRoute = currentRoute;
    room = { ...createRoomForArtworkCount(artist.works.length), ...artist.room };
    renderGallery();
    if (match[1] === 'preview') {
      const notice = document.querySelector('.gallery-notice');
      notice.textContent = 'Предпросмотр черновика. Посетители видят опубликованную версию.';
      notice.hidden = false;
    }
  } else {
    document.title = 'Смотритель — виртуальная галерея';
    try {
      artists = await fetchArtists();
      catalogLoadError = '';
    } catch (error) {
      catalogLoadError = error.message;
    }
    if (revision === routeRevision) renderLanding();
  }
}

document.querySelector(".skip-link").addEventListener("click", (event) => {
  event.preventDefault();
  document.querySelector("#main-content")?.focus({ preventScroll: false });
});

let restoringAdminRoute = false;
window.addEventListener("hashchange", async (event) => {
  if (restoringAdminRoute) { restoringAdminRoute = false; return; }
  if (adminCleanup.canLeave && !adminCleanup.canLeave()) {
    restoringAdminRoute = true;
    location.replace(event.oldURL);
    return;
  }
  await renderRoute();
  if (!document.querySelector('#artwork-dialog')?.open) focusRouteHeading();
});
window.addEventListener("keydown", (event) => {
  if (route() !== artistGalleryRoute || document.querySelector("#artwork-dialog")?.open) return;
  if (event.key === "Escape") {
    closeWorksDrawer();
    return;
  }
  const target = document.activeElement;
  const controlsFocused = target === document.querySelector(".gallery-stage") || target?.closest?.(".navigation");
  if (!controlsFocused) return;
  const directions = { ArrowRight: "right", ArrowUp: "forward", ArrowLeft: "left", ArrowDown: "back", d: "right", D: "right", w: "forward", W: "forward", a: "left", A: "left", s: "back", S: "back", q: "turn-left", Q: "turn-left", e: "turn-right", E: "turn-right", r: "look-up", R: "look-up", f: "look-down", F: "look-down" };
  if (directions[event.key]) { event.preventDefault(); runGalleryAction(directions[event.key]); }
});

await renderRoute();
