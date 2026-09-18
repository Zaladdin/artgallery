import { createRoomForArtworkCount } from "./gallery-config.js";

const importedArtworkFiles = Object.freeze([
  { fileName: "ayten-01.jpg", sourceName: "IMG_1156.jpg", widthPx: 2048, heightPx: 1531 },
  { fileName: "ayten-02.jpg", sourceName: "IMG_1159.jpg", widthPx: 1334, heightPx: 2048 },
  { fileName: "ayten-03.jpg", sourceName: "IMG_1163.jpg", widthPx: 1726, heightPx: 2048 },
  { fileName: "ayten-04.jpg", sourceName: "IMG_1166.jpg", widthPx: 1732, heightPx: 2048 },
  { fileName: "ayten-05.jpg", sourceName: "IMG_1441.jpg", widthPx: 1536, heightPx: 2048 },
  { fileName: "ayten-06.jpg", sourceName: "IMG_1442.jpg", widthPx: 1510, heightPx: 2048 },
  { fileName: "ayten-07.jpg", sourceName: "IMG_1444.jpg", widthPx: 2048, heightPx: 1536 },
  { fileName: "ayten-08.jpg", sourceName: "IMG_1445.jpg", widthPx: 2048, heightPx: 1693 },
  { fileName: "ayten-09.jpg", sourceName: "IMG_1446.jpg", widthPx: 2048, heightPx: 1622 },
  { fileName: "ayten-10.jpg", sourceName: "IMG_1449.jpg", widthPx: 2048, heightPx: 1536 }
]);

function createImportedWork({ fileName, sourceName, widthPx, heightPx }, index) {
  const displayHeightM = 1.18;
  const aspectRatio = widthPx / heightPx;
  const displayWidthM = Math.round(Math.min(1.55, Math.max(0.65, displayHeightM * aspectRatio)) * 100) / 100;

  return {
    id: `ayten-${String(index + 1).padStart(2, "0")}`,
    title: `Картина ${String(index + 1).padStart(2, "0")}`,
    sourceFormat: "JPG",
    sourceName,
    imageSrc: `./assets/ayten/${fileName}`,
    sceneImageSrc: `./assets/ayten/scene-${String(index + 1).padStart(2, "0")}.jpg`,
    thumbnailSrc: `./assets/ayten/thumb-${String(index + 1).padStart(2, "0")}.jpg`,
    displayWidthM,
    displayHeightM,
    description: `Работа ${index + 1} из предоставленной коллекции.`
  };
}

const artist = {
  slug: "ayten-sheydayeva",
  name: "Айтен Шейдаева",
  years: "1968–2024",
  aliases: ["Айтен", "Шейдаева", "Ayten Sheydayeva"],
  works: importedArtworkFiles.map(createImportedWork)
};

const artistGalleryRoute = `/gallery/${artist.slug}`;
const legacyArtistGalleryRoutes = new Set(["/gallery/leila-mirzaeva"]);
const room = createRoomForArtworkCount(artist.works.length);

const app = document.querySelector("#app");
let galleryScene = null;
let gallerySceneRevision = 0;
let gallerySceneAbortController = null;
let artworkOpener = null;
let closeWorksDrawer = () => {};
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
  return [work.year, work.medium].filter(Boolean).join(" · ") || `Исходник ${work.sourceFormat}`;
}

function formatArtworkDetails(work) {
  return [work.year, work.medium].filter(Boolean).concat([formatDimensions(work), `исходник ${work.sourceFormat}`, `файл ${work.sourceName}`]).join("<br>");
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
  const pitch = Math.round(state.pitchDegrees || 0);
  const verticalLook = Math.abs(pitch) < 1 ? "" : ` · ${pitch > 0 ? "вверх" : "вниз"} ${Math.abs(pitch)}°`;
  document.querySelector("#scene-position").textContent = `Точка обзора: ${formatMetres(fromEntrance)} м от входа`;
  document.querySelector("#scene-direction").textContent = `Взгляд: ${state.direction} · ${heading}°${verticalLook}`;
  stage.style.setProperty("--map-x", `${mapPosition(mapFromEntrance, room.widthM)}%`);
  stage.style.setProperty("--map-z", `${mapPosition(mapFromLeftWall, room.depthM)}%`);
  stage.style.setProperty("--map-heading", `${heading}deg`);
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
    button.setAttribute("aria-disabled", String(Boolean(state.isMoving)));
    button.toggleAttribute("data-blocked", !canMove);
    button.setAttribute("aria-label", state.isMoving ? "Выполняется перемещение" : canMove ? `${label}, шаг 1 метр` : `${label}: ${wall}`);
  });
  if (message) document.querySelector("#camera-status").textContent = message;
}

function runGalleryAction(direction) {
  if (!galleryScene) return;
  if (direction === "turn-left" || direction === "turn-right") galleryScene.turn(direction === "turn-left" ? "left" : "right");
  else if (direction === "look-up" || direction === "look-down") galleryScene.tilt(direction === "look-up" ? "up" : "down");
  else galleryScene.move(direction);
}

function setGalleryControlsEnabled(enabled) {
  document.querySelectorAll("[data-direction]").forEach((button) => {
    button.disabled = !enabled;
  });
  const lightSlider = document.querySelector("#room-light-level");
  if (lightSlider) lightSlider.disabled = !enabled;
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
    mount.innerHTML = '<p class="scene-load-error" role="alert">Не удалось загрузить 3D-зал. Обновите страницу и попробуйте снова.</p>';
    stage.removeAttribute("aria-busy");
    document.querySelector("#camera-status").textContent = "3D-зал не загрузился. Попробуйте обновить страницу.";
    console.error("Gallery scene failed to load", error);
  }
}

function matchesArtist(query) {
  const q = normalise(query);
  if (!q) return [];
  const haystack = [artist.name, ...artist.aliases].join(" ").toLocaleLowerCase("ru-RU");
  return haystack.includes(q) ? [artist] : [];
}

function route() {
  return location.hash.replace("#", "") || "/";
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
  closeWorksDrawer = () => {};
  app.innerHTML = `
    <section class="landing" id="main-content" tabindex="-1" aria-labelledby="landing-title">
      <header class="landing-header">
        <a class="brand" href="#/" aria-label="Смотритель — на главную"><span class="brand-mark" aria-hidden="true">С</span>Смотритель</a>
        <button class="text-button" type="button" data-demo-admin>Войти как админ</button>
      </header>
      <div class="landing-content">
        <p class="eyebrow">Виртуальные экспозиции</p>
        <h1 id="landing-title" tabindex="-1">Искусство —<br>в своём пространстве.</h1>
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
      </div>
      <footer class="landing-footer"><span>Прототип · виртуальная картинная галерея</span><span>Мышь · клавиатура · touch</span></footer>
    </section>`;

  const input = document.querySelector("#artist-query");
  const results = document.querySelector("#search-results");
  const form = document.querySelector("#artist-search");

  function showResults() {
    const items = matchesArtist(input.value);
    results.hidden = input.value.trim().length === 0;
    if (input.value.trim().length === 0) return;
    results.innerHTML = items.length
      ? items.map((item) => `<button class="artist-result" type="button" data-artist="${item.slug || "unavailable"}"><span class="artist-avatar" aria-hidden="true">${item.name[0]}</span><span><span class="result-name">${item.name}</span><span class="result-meta">${item.years} · ${item.works?.length || item.works} работ</span></span></button>`).join("")
      : `<p class="no-results">Мы не нашли художника. Попробуйте ввести фамилию или псевдоним.</p>`;
  }

  input.addEventListener("input", showResults);
  input.addEventListener("focus", showResults);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const first = matchesArtist(input.value)[0];
    if (first?.slug === artist.slug) go(artistGalleryRoute);
    else showResults();
  });
  results.addEventListener("click", (event) => {
    const target = event.target.closest("[data-artist]");
    if (target?.dataset.artist === artist.slug) go(artistGalleryRoute);
  });
  document.querySelector("[data-demo-admin]").addEventListener("click", () => {
    alert("Админка будет следующим этапом. В MVP она позволит создать художника, загрузить сканы и опубликовать комнату.");
  });
}

function renderArtworkDialog(work) {
  const currentIndex = artist.works.findIndex((item) => item.id === work.id);
  const dialog = document.querySelector("#artwork-dialog");
  dialog.setAttribute("aria-labelledby", "artwork-dialog-title");
  dialog.innerHTML = `
    <button class="dialog-close" type="button" aria-label="Закрыть карточку">×</button>
    <div class="art-layout">
      <div class="art-visual"><img src="${work.imageSrc}" alt="${work.title} из предоставленной коллекции" decoding="async" /></div>
      <div class="art-copy">
        <p class="art-index">Работа ${currentIndex + 1} из ${artist.works.length}</p>
        <h2 id="artwork-dialog-title">${work.title}</h2>
        <p class="art-meta">${formatArtworkDetails(work)}</p>
        <p class="art-description">${work.description}</p>
        <div class="dialog-nav"><button class="button button-quiet" type="button" data-prev-art>← Предыдущая</button><button class="button button-primary" type="button" data-next-art>Следующая →</button></div>
      </div>
    </div>`;
  dialog.querySelector(".dialog-close").addEventListener("click", () => dialog.close());
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
    <section class="gallery" id="main-content" tabindex="-1" aria-label="Галерея ${artist.name}">
      <header class="gallery-bar">
        <button class="text-button gallery-back" type="button" data-home>← <span>К поиску</span></button>
        <h1 class="gallery-title" tabindex="-1">${artist.name}</h1>
        <button class="text-button gallery-list" type="button" data-open-list aria-controls="works-drawer" aria-expanded="false" aria-label="Открыть список из ${artist.works.length} работ"><span aria-hidden="true">☰</span><span class="list-label">Список работ</span></button>
      </header>
      <div class="gallery-stage" tabindex="0" aria-busy="true" aria-describedby="scene-instructions" aria-label="Виртуальный зал ${artist.name}" style="--room-map-aspect: ${mapAspect} / 1">
        <div class="scene-host is-loading" id="scene-host" aria-hidden="true"><p>Загрузка 3D-зала…</p></div>
        <div class="scene-caption"><p>Зал: длина ${formatMetres(room.widthM)} м · ширина ${formatMetres(room.depthM)} м</p><strong id="scene-position">Загрузка…</strong><span id="scene-direction">Шаг 1 м · обзор 360°</span></div>
        <div class="lighting-control">
          <label for="room-light-level">Общий свет в зале <output id="room-light-value" for="room-light-level">${galleryLightLevel}%</output></label>
          <input id="room-light-level" type="range" min="0" max="100" step="1" value="${galleryLightLevel}" aria-valuetext="${galleryLightLevel}%" aria-describedby="room-light-hint" disabled />
          <span id="room-light-hint" class="sr-only">Регулирует общий свет в виртуальном зале. Прожекторы над картинами остаются включёнными.</span>
        </div>
        <p id="scene-instructions" class="sr-only">Размер комнаты: ${formatMetres(room.widthM)} × ${formatMetres(room.depthM)} м. Стрелка вверх или W делает плавный шаг вперёд на один метр, вниз или S — назад. Влево и вправо, либо A и D, делают боковой шаг на один метр относительно взгляда. Q и E поворачивают взгляд на пятнадцать градусов. Мышью или пальцем можно смотреть влево, вправо, вверх и вниз. Клавиши R и F наклоняют взгляд вверх и вниз; шаг при этом остаётся по полу. Ползунок «Общий свет в зале» регулирует освещение комнаты, но прожекторы над картинами остаются включёнными.</p>
        <p id="camera-status" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></p>
        <nav class="navigation" aria-label="Перемещение по залу">
          <button class="nav-button" type="button" data-direction="forward" aria-label="Вперёд, шаг 1 метр" disabled>↑</button>
          <button class="nav-button" type="button" data-direction="left" aria-label="Влево, шаг 1 метр" disabled>←</button>
          <button class="nav-button" type="button" data-direction="back" aria-label="Назад, шаг 1 метр" disabled>↓</button>
          <button class="nav-button" type="button" data-direction="right" aria-label="Вправо, шаг 1 метр" disabled>→</button>
        </nav>
        <div class="room-map" aria-hidden="true"><span class="map-label map-label-far">Стена</span><span class="map-label map-label-entry">Вход</span><span class="map-cursor"></span></div>
        <aside class="works-drawer" id="works-drawer" hidden aria-label="Список из ${artist.works.length} работ">
          <div class="drawer-head"><h2>Работы · ${artist.works.length}</h2><button class="icon-button" type="button" data-close-list aria-label="Закрыть список работ">×</button></div>
          <div class="work-list">${artist.works.map((work) => `<button class="work-card" type="button" data-work="${work.id}"><img class="work-thumb" src="${work.thumbnailSrc}" alt="" loading="lazy" decoding="async" /><span><h3>${work.title}</h3><p>${formatWorkMeta(work)}</p></span></button>`).join("")}</div>
        </aside>
      </div>
      <dialog id="artwork-dialog" class="art-dialog"></dialog>
    </section>`;

  const stage = document.querySelector(".gallery-stage");
  const sceneHost = document.querySelector("#scene-host");
  const drawer = document.querySelector("#works-drawer");
  const dialog = document.querySelector("#artwork-dialog");
  const listTrigger = document.querySelector("[data-open-list]");
  const closeListButton = document.querySelector("[data-close-list]");
  const lightSlider = document.querySelector("#room-light-level");
  mountGalleryScene(sceneHost, stage, sceneRevision);
  sceneHost.addEventListener("pointerdown", () => stage.focus({ preventScroll: true }));
  function closeDrawer() {
    if (drawer.hidden) return;
    drawer.hidden = true;
    listTrigger.setAttribute("aria-expanded", "false");
    listTrigger.focus();
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
}

function renderRoute() {
  const currentRoute = route();
  if (legacyArtistGalleryRoutes.has(currentRoute)) {
    go(artistGalleryRoute);
    return;
  }
  if (currentRoute === artistGalleryRoute) renderGallery();
  else renderLanding();
}

document.querySelector(".skip-link").addEventListener("click", (event) => {
  event.preventDefault();
  document.querySelector("#main-content")?.focus({ preventScroll: false });
});

window.addEventListener("hashchange", () => {
  renderRoute();
  focusRouteHeading();
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

renderRoute();
