const viewerCleanup = new WeakMap();

export function mountArtworkViewer(dialog) {
  viewerCleanup.get(dialog)?.();
  const viewport = dialog.querySelector('.art-viewport');
  const image = viewport.querySelector('img');
  const output = dialog.querySelector('[data-zoom-value]');
  const zoomIn = dialog.querySelector('[data-zoom-in]');
  const zoomOut = dialog.querySelector('[data-zoom-out]');
  const fullscreen = dialog.querySelector('[data-art-fullscreen]');
  let zoom = 1;
  let drag = null;

  function fitImage() {
    if (!image.naturalWidth || !image.naturalHeight) return;
    const fit = Math.min(viewport.clientWidth / image.naturalWidth, viewport.clientHeight / image.naturalHeight);
    image.style.width = `${image.naturalWidth * fit * zoom}px`;
    image.style.height = `${image.naturalHeight * fit * zoom}px`;
    image.style.maxHeight = 'none';
  }

  function setZoom(next) {
    zoom = Math.max(1, Math.min(4, next));
    fitImage();
    viewport.classList.toggle('is-zoomed', zoom > 1);
    output.textContent = `${Math.round(zoom * 100)}%`;
    zoomIn.disabled = zoom >= 4;
    zoomOut.disabled = zoom <= 1;
    if (zoom === 1) viewport.scrollTo(0, 0);
  }

  zoomIn.addEventListener('click', () => setZoom(zoom + 0.5));
  zoomOut.addEventListener('click', () => setZoom(zoom - 0.5));
  dialog.querySelector('[data-zoom-reset]').addEventListener('click', () => setZoom(1));
  viewport.addEventListener('pointerdown', (event) => {
    if (zoom === 1 || event.button !== 0) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
    viewport.setPointerCapture(event.pointerId);
  });
  viewport.addEventListener('pointermove', (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    viewport.scrollLeft = drag.left - (event.clientX - drag.x);
    viewport.scrollTop = drag.top - (event.clientY - drag.y);
  });
  const stopDrag = () => { drag = null; };
  viewport.addEventListener('pointerup', stopDrag);
  viewport.addEventListener('pointercancel', stopDrag);
  viewport.addEventListener('lostpointercapture', stopDrag);
  fullscreen.setAttribute('aria-pressed', String(dialog.classList.contains('is-expanded')));
  fullscreen.textContent = dialog.classList.contains('is-expanded') ? 'Обычный вид' : 'На весь экран';
  fullscreen.addEventListener('click', () => {
    const expanded = dialog.classList.toggle('is-expanded');
    fullscreen.setAttribute('aria-pressed', String(expanded));
    fullscreen.textContent = expanded ? 'Обычный вид' : 'На весь экран';
  });
  const observer = new ResizeObserver(fitImage);
  observer.observe(viewport);
  image.addEventListener('load', fitImage);
  const cleanup = () => {
    observer.disconnect();
    image.removeEventListener('load', fitImage);
    dialog.removeEventListener('close', cleanup);
  };
  dialog.addEventListener('close', cleanup, { once: true });
  viewerCleanup.set(dialog, cleanup);
  setZoom(1);
}
