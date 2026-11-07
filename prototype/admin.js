import { isCloudMediaUrl, usesCloudGallery } from './supabase-config.js';

const ACCEPTED_UPLOADS = /\.(jpe?g|png|heic|heif)$/i;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, action, className = 'admin-button') {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function field(labelText, value, onChange, { type = 'text', multiline = false, required = false, maxLength = 2000, min, max, step, hint } = {}) {
  const label = element('label', 'admin-field');
  label.append(element('span', 'admin-field-label', labelText));
  const input = element(multiline ? 'textarea' : 'input');
  if (!multiline) input.type = type;
  input.value = value ?? '';
  input.required = required;
  if (type !== 'color') input.maxLength = maxLength;
  if (min !== undefined) input.min = min;
  if (max !== undefined) input.max = max;
  if (step !== undefined) input.step = step;
  if (multiline) input.rows = 3;
  input.addEventListener('input', () => onChange(input.value));
  label.append(input);
  if (hint) label.append(element('span', 'admin-hint', hint));
  return label;
}

function checkbox(labelText, checked, onChange) {
  const label = element('label', 'admin-checkbox');
  const input = element('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  label.append(input, element('span', '', labelText));
  return label;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function unwrapArtist(payload) {
  return payload?.artist || payload;
}

function safeImagePath(value) {
  if (isCloudMediaUrl(value)) return value;
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value, location.href);
    return url.origin === location.origin ? url.href : '';
  } catch {
    return '';
  }
}

export async function renderAdmin(app) {
  const cloud = usesCloudGallery();
  let active = true;
  let busy = false;
  let dirty = false;
  let csrfToken = '';
  let artists = [];
  let draft = null;
  let refreshAfterLogin = false;
  let actionGeneration = 0;
  const controller = new AbortController();

  app.innerHTML = `<section class="admin-shell" id="main-content" tabindex="-1" aria-labelledby="admin-title">
    <header class="admin-header"><a href="#/" class="admin-home">← В галерею</a><div><p class="admin-eyebrow">Смотритель · мастерская</p><h1 id="admin-title" tabindex="-1">Управление выставками</h1></div><div class="admin-account"></div></header>
    <p class="admin-feedback" role="status" aria-live="polite" aria-atomic="true">Подключение к мастерской…</p>
    <div class="admin-body"></div>
  </section>`;
  const shell = app.querySelector('.admin-shell');
  const body = shell.querySelector('.admin-body');
  const feedback = shell.querySelector('.admin-feedback');
  const account = shell.querySelector('.admin-account');

  function message(text, isError = false) {
    if (!active) return;
    feedback.textContent = text;
    feedback.classList.toggle('is-error', isError);
  }

  function markDirty() {
    dirty = true;
    shell.querySelector('[data-save-state]')?.replaceChildren(document.createTextNode('Есть несохранённые изменения'));
  }

  function canLeave() {
    if (busy) {
      message('Дождитесь завершения текущего действия.', true);
      return false;
    }
    return !dirty || window.confirm('Изменения не сохранены. Уйти без сохранения?');
  }

  function beforeUnload(event) {
    if (!dirty && !busy) return;
    event.preventDefault();
    event.returnValue = '';
  }
  window.addEventListener('beforeunload', beforeUnload);

  const cleanup = () => {
    active = false;
    controller.abort();
    window.removeEventListener('beforeunload', beforeUnload);
  };
  cleanup.canLeave = canLeave;

  async function api(path, { method = 'GET', body: requestBody, headers = {} } = {}) {
    if (cloud) {
      const { cloudApi } = await import('./supabase-gallery.js');
      return cloudApi(path, { method, body: requestBody, signal: controller.signal });
    }
    const requestHeaders = { ...headers };
    if (method !== 'GET' && csrfToken) requestHeaders['X-CSRF-Token'] = csrfToken;
    let data = requestBody;
    if (requestBody && !(requestBody instanceof Blob)) {
      data = JSON.stringify(requestBody);
      requestHeaders['Content-Type'] = 'application/json';
    }
    const response = await fetch(`./api/${path}`, {
      method,
      body: data,
      headers: requestHeaders,
      credentials: 'same-origin',
      signal: controller.signal
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(typeof payload?.error === 'string' ? payload.error : `Запрос не выполнен (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    if (payload?.csrfToken) csrfToken = payload.csrfToken;
    return payload;
  }

  async function run(action) {
    if (busy || !active) return;
    busy = true;
    const generation = ++actionGeneration;
    const controls = [...shell.querySelectorAll('button, input, textarea, select')];
    const previousDisabled = controls.map((node) => node.disabled);
    controls.forEach((node) => { node.disabled = true; });
    shell.setAttribute('aria-busy', 'true');
    try {
      await action();
    } catch (error) {
      if (!active || error.name === 'AbortError') return;
      if (shell.querySelector('.admin-login') && (error.status === 401 || error.status === 403)) {
        message(error.message, true);
        return;
      }
      if (error.status === 401) {
        csrfToken = '';
        message('Сессия завершилась. Войдите снова. Несохранённая форма останется открытой.', true);
        renderReauthentication();
      } else if (error.status === 403) {
        const status = await api('status').catch(() => null);
        if (status?.authenticated && status.csrfToken) {
          csrfToken = status.csrfToken;
          if (refreshAfterLogin) {
            try {
              await loadArtists(draft?.slug);
              refreshAfterLogin = false;
            } catch {
              message('Сессия обновлена, но список работ загрузить не удалось. Обновите страницу перед продолжением.', true);
              return;
            }
          }
          message('Сессия обновлена. Повторите действие; изменения формы сохранены в этой вкладке.', true);
        } else {
          csrfToken = '';
          message('Войдите снова, чтобы продолжить. Форма остаётся открытой.', true);
          renderReauthentication();
        }
      } else {
        message(error.message || 'Не удалось выполнить действие. Попробуйте снова.', true);
      }
    } finally {
      if (active && generation === actionGeneration) {
        busy = false;
        shell.removeAttribute('aria-busy');
        controls.forEach((node, index) => { if (node.isConnected) node.disabled = previousDisabled[index]; });
      }
    }
  }

  function renderReauthentication() {
    if (shell.querySelector('.admin-reauth')) return;
    const panel = element('form', 'admin-reauth');
    panel.append(element('p', '', 'Повторный вход'));
    const email = addCloudEmail(panel);
    const password = field('Пароль администратора', '', () => {}, { type: 'password', required: true });
    password.querySelector('input').autocomplete = 'current-password';
    const submit = element('button', 'admin-button is-primary', 'Войти и продолжить');
    submit.type = 'submit';
    panel.append(password, submit);
    panel.addEventListener('submit', (event) => {
      event.preventDefault();
      run(async () => {
        await api('login', { method: 'POST', body: { email: email?.value.trim(), password: password.querySelector('input').value } });
        if (refreshAfterLogin) {
          refreshAfterLogin = false;
          await loadArtists(draft?.slug);
        }
        panel.remove();
        message('Вы снова вошли. Можно сохранить изменения.');
      });
    });
    body.prepend(panel);
    (email || password.querySelector('input')).focus();
  }

  function addCloudEmail(panel) {
    if (!cloud) return null;
    const email = field('Email администратора', '', () => {}, { type: 'email', required: true, maxLength: 254 });
    const input = email.querySelector('input');
    input.autocomplete = 'username';
    panel.append(email);
    return input;
  }

  function renderLogin(setupRequired) {
    body.replaceChildren();
    account.replaceChildren();
    const panel = element('form', 'admin-login');
    panel.append(element('p', 'admin-eyebrow', setupRequired ? 'Первый вход' : 'Закрытая мастерская'));
    panel.append(element('h2', '', setupRequired ? 'Создайте пароль администратора' : 'Войдите в мастерскую'));
    panel.append(element('p', 'admin-hint', setupRequired ? 'Пароль защищает создание и публикацию выставок. Используйте не менее 12 символов.' : 'Здесь можно загрузить работы, изменить экспозицию и опубликовать её.'));
    const email = addCloudEmail(panel);
    const password = field('Пароль', '', () => {}, { type: 'password', required: true, maxLength: 128 });
    const passwordInput = password.querySelector('input');
    passwordInput.autocomplete = setupRequired ? 'new-password' : 'current-password';
    if (setupRequired) passwordInput.minLength = 12;
    panel.append(password);
    let confirmation = null;
    if (setupRequired) {
      confirmation = field('Повторите пароль', '', () => {}, { type: 'password', required: true, maxLength: 128 });
      confirmation.querySelector('input').autocomplete = 'new-password';
      panel.append(confirmation);
    }
    const submit = element('button', 'admin-button is-primary', setupRequired ? 'Создать пароль и войти' : 'Войти');
    submit.type = 'submit';
    panel.append(submit);
    panel.addEventListener('submit', (event) => {
      event.preventDefault();
      if (confirmation && passwordInput.value !== confirmation.querySelector('input').value) {
        message('Пароли не совпадают. Повторите пароль.', true);
        confirmation.querySelector('input').focus();
        return;
      }
      run(async () => {
        const status = await api(setupRequired ? 'setup' : 'login', { method: 'POST', body: { email: email?.value.trim(), password: passwordInput.value } });
        if (!cloud && !csrfToken) {
          const refreshed = await api('status');
          csrfToken = refreshed.csrfToken || '';
        }
        if (status?.authenticated === false) throw new Error('Вход не выполнен. Проверьте пароль.');
        await loadArtists();
        message('Мастерская открыта.');
      });
    });
    body.append(panel);
    message(setupRequired ? 'Первичная настройка мастерской.' : 'Введите пароль администратора.');
  }

  async function loadArtists(selectedSlug) {
    const payload = await api('admin/artists');
    artists = Array.isArray(payload) ? payload : payload.artists;
    if (!Array.isArray(artists)) throw new Error('Сервер вернул некорректный список художников.');
    const selected = artists.find((artist) => artist.slug === selectedSlug) || artists[0];
    draft = selected ? clone(selected) : null;
    dirty = false;
    renderWorkspace();
  }

  function renderWorkspace() {
    if (!active) return;
    body.replaceChildren();
    account.replaceChildren(button('Выйти', () => {
      if (!canLeave()) return;
      run(async () => {
        await api('logout', { method: 'POST', body: {} });
        csrfToken = '';
        dirty = false;
        draft = null;
        renderLogin(false);
      });
    }, 'admin-button is-quiet'));
    const sidebar = element('aside', 'admin-sidebar');
    sidebar.setAttribute('aria-label', 'Художники');
    sidebar.append(element('h2', '', 'Художники'));
    const artistList = element('nav', 'admin-artist-list');
    artistList.setAttribute('aria-label', 'Выбор художника');
    artists.forEach((artist) => {
      const item = button('', () => {
        if (!canLeave()) return;
        draft = clone(artist);
        dirty = false;
        renderWorkspace();
      }, 'admin-artist');
      item.append(element('strong', '', artist.name), element('span', '', artist.published ? 'Опубликовано' : 'Черновик'));
      item.setAttribute('aria-pressed', String(artist.slug === draft?.slug));
      artistList.append(item);
    });
    sidebar.append(artistList, createArtistForm());
    const editor = element('div', 'admin-editor');
    if (draft) renderEditor(editor);
    else editor.append(element('div', 'admin-empty', 'Создайте первого художника. Затем загрузите работы и подготовьте выставку.'));
    body.append(sidebar, editor);
  }

  function createArtistForm() {
    const form = element('form', 'admin-create');
    form.append(element('h3', '', 'Новый художник'));
    const name = field('ФИО или псевдоним', '', () => {}, { required: true, maxLength: 160 });
    const slug = field('Адрес выставки', '', () => {}, { required: true, maxLength: 80, hint: 'Латинские буквы, цифры и дефисы: ayten-sheydayeva' });
    const slugInput = slug.querySelector('input');
    slugInput.pattern = '[a-z0-9]+(?:-[a-z0-9]+)*';
    const submit = element('button', 'admin-button', 'Создать художника');
    submit.type = 'submit';
    form.append(name, slug, submit);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!canLeave()) return;
      run(async () => {
        const created = unwrapArtist(await api('admin/artists', { method: 'POST', body: { name: name.querySelector('input').value.trim(), slug: slugInput.value.trim() } }));
        await loadArtists(created.slug);
        message('Художник создан. Можно добавить работы.');
      });
    });
    return form;
  }

  function updateArtistInList(artist) {
    const index = artists.findIndex((item) => item.slug === artist.slug);
    if (index === -1) artists.push(clone(artist));
    else artists[index] = clone(artist);
  }

  async function saveDraft() {
    if (!draft) return;
    const invalid = shell.querySelector('.admin-editor input:invalid, .admin-editor textarea:invalid');
    if (invalid) {
      invalid.reportValidity();
      throw new Error('Проверьте отмеченные поля перед сохранением.');
    }
    const saved = unwrapArtist(await api(`admin/artists/${encodeURIComponent(draft.slug)}`, { method: 'PUT', body: draft }));
    // Keep work objects bound to the current form if a later publish/upload fails.
    const currentWorks = new Map(draft.works.map((work) => [work.id, work]));
    const savedDraft = clone(saved);
    savedDraft.works = savedDraft.works.map((work) => {
      const current = currentWorks.get(work.id);
      if (!current) return work;
      for (const key of Object.keys(current)) delete current[key];
      return Object.assign(current, work);
    });
    Object.assign(draft, savedDraft);
    updateArtistInList(draft);
    dirty = false;
  }

  function renderEditor(editor) {
    draft.works ||= [];
    draft.room ||= {};
    const heading = element('div', 'admin-editor-heading');
    const titleGroup = element('div');
    titleGroup.append(element('p', 'admin-eyebrow', draft.published ? 'Выставка опубликована' : 'Черновик выставки'), element('h2', '', draft.name));
    const savedState = element('p', 'admin-save-state', dirty ? 'Есть несохранённые изменения' : 'Все изменения сохранены');
    savedState.dataset.saveState = '';
    titleGroup.append(savedState);
    heading.append(titleGroup);
    const actions = element('div', 'admin-editor-actions');
    actions.append(button('Сохранить черновик', () => run(async () => {
      await saveDraft();
      renderWorkspace();
      message('Черновик сохранён. Публичная версия не изменена.');
    }), 'admin-button is-primary'));
    actions.append(button('Предпросмотр', () => {
      // Open synchronously so browsers do not treat the later navigation as a popup.
      const preview = window.open('about:blank', '_blank');
      if (!preview) {
        message('Разрешите открытие новой вкладки для предпросмотра.', true);
        return;
      }
      preview.opener = null;
      run(async () => {
        try {
          await saveDraft();
          preview.location = `${location.pathname}${location.search}#/preview/${encodeURIComponent(draft.slug)}`;
          renderWorkspace();
          message('Черновик сохранён. Предпросмотр открыт в новой вкладке.');
        } catch (error) {
          preview.close();
          throw error;
        }
      });
    }));
    actions.append(button(draft.published ? 'Обновить публикацию' : 'Опубликовать', () => run(async () => {
      const visibleWorks = draft.works.filter((work) => work.visible !== false);
      if (!visibleWorks.length) throw new Error('Добавьте хотя бы одну видимую работу.');
      if (visibleWorks.some((work) => work.rightsConfirmed !== true)) throw new Error('Подтвердите право на публикацию у каждой видимой работы.');
      await saveDraft();
      const published = unwrapArtist(await api(`admin/artists/${encodeURIComponent(draft.slug)}/publish`, { method: 'POST', body: { revision: draft.revision } }));
      if (published?.slug) draft = clone(published);
      else draft.published = true;
      updateArtistInList(draft);
      renderWorkspace();
      message('Выставка опубликована и доступна посетителям.');
    }), 'admin-button is-publish'));
    if (draft.published) actions.append(button('Снять с публикации', () => {
      if (!window.confirm('Снять выставку с публикации? Она исчезнет из публичного поиска, черновик сохранится.')) return;
      run(async () => {
        await saveDraft();
        const unpublished = unwrapArtist(await api(`admin/artists/${encodeURIComponent(draft.slug)}/unpublish`, { method: 'POST', body: { revision: draft.revision } }));
        if (unpublished?.slug) draft = clone(unpublished);
        else draft.published = false;
        updateArtistInList(draft);
        renderWorkspace();
        message('Выставка снята с публикации. Черновик сохранён.');
      });
    }, 'admin-button is-quiet'));
    heading.append(actions);
    editor.append(heading);

    const profile = element('section', 'admin-section');
    profile.append(element('h3', '', 'О художнике'));
    const profileGrid = element('div', 'admin-form-grid');
    profileGrid.append(
      field('ФИО или псевдоним', draft.name, (value) => { draft.name = value; markDirty(); }, { required: true, maxLength: 160 }),
      field('Годы жизни или деятельности', draft.years, (value) => { draft.years = value; markDirty(); }, { maxLength: 80 }),
      field('Варианты имени для поиска', (draft.aliases || []).join(', '), (value) => { draft.aliases = value.split(',').map((item) => item.trim()).filter(Boolean); markDirty(); }, { maxLength: 1000, hint: 'Разделяйте варианты запятыми.' }),
      field('Биография', draft.biography, (value) => { draft.biography = value; markDirty(); }, { multiline: true, maxLength: 10000 })
    );
    profile.append(profileGrid);
    editor.append(profile);

    const roomSection = element('section', 'admin-section');
    roomSection.append(element('h3', '', 'Оформление зала'));
    const colors = element('div', 'admin-colors');
    colors.append(
      field('Цвет стен', draft.room.wallColor || '#e9e4da', (value) => { draft.room.wallColor = value; markDirty(); }, { type: 'color' }),
      field('Цвет рам', draft.room.frameColor || '#171716', (value) => { draft.room.frameColor = value; markDirty(); }, { type: 'color' })
    );
    roomSection.append(colors, element('p', 'admin-hint', 'Порядок работ ниже определяет их расположение в зале. Размер комнаты рассчитывается автоматически.'));
    editor.append(roomSection);

    const worksSection = element('section', 'admin-section');
    const workHeading = element('div', 'admin-section-heading');
    workHeading.append(element('h3', '', `Работы · ${draft.works.length}`));
    worksSection.append(workHeading, createUploadForm());
    const list = element('div', 'admin-works');
    if (!draft.works.length) list.append(element('p', 'admin-empty', 'Работ пока нет. Загрузите изображения, чтобы собрать экспозицию.'));
    draft.works.forEach((work, index) => list.append(createWorkEditor(work, index)));
    worksSection.append(list);
    editor.append(worksSection);
  }

  function createUploadForm() {
    const form = element('form', 'admin-upload');
    const fileLabel = element('label', 'admin-field');
    fileLabel.append(element('span', 'admin-field-label', 'Добавить картины'));
    const input = element('input');
    input.type = 'file';
    input.accept = '.jpg,.jpeg,.png,.heic,.heif';
    input.multiple = true;
    fileLabel.append(input, element('span', 'admin-hint', 'JPG, PNG или HEIC · до 25 МБ на файл. Оригиналы сохраняются отдельно.'));
    const upload = element('button', 'admin-button', 'Загрузить выбранные файлы');
    upload.type = 'submit';
    const progress = element('ol', 'admin-upload-progress');
    progress.setAttribute('aria-label', 'Состояние загрузки файлов');
    progress.setAttribute('aria-live', 'polite');
    form.append(fileLabel, upload, progress);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const files = [...input.files];
      if (!files.length) {
        message('Сначала выберите изображения.', true);
        return;
      }
      run(async () => {
        await saveDraft();
        progress.replaceChildren();
        let successCount = 0;
        for (const [index, file] of files.entries()) {
          const item = element('li', '', `${file.name} — обработка (${index + 1}/${files.length})…`);
          progress.append(item);
          try {
            if (!ACCEPTED_UPLOADS.test(file.name)) throw new Error('Поддерживаются только JPG, PNG и HEIC.');
            if (file.size > MAX_UPLOAD_BYTES) throw new Error('Файл больше 25 МБ.');
            const result = await api(`admin/artists/${encodeURIComponent(draft.slug)}/uploads`, {
              method: 'POST',
              body: file,
              headers: { 'X-File-Name': encodeURIComponent(file.name), 'Content-Type': file.type || 'application/octet-stream' }
            });
            const work = result.work || result;
            if (!work?.id || !work.imageSrc) throw new Error('Сервер не вернул подготовленное изображение.');
            if (Number.isFinite(work.artistRevision)) draft.revision = work.artistRevision;
            draft.works.push(work);
            successCount += 1;
            item.textContent = `${file.name} — готово`;
          } catch (error) {
            if (error.name === 'AbortError') throw error;
            item.textContent = `${file.name} — ${error.message}`;
            item.classList.add('is-error');
            if (error.status === 401 || error.status === 403) {
              refreshAfterLogin = true;
              throw error;
            }
          }
        }
        // Preserve each file's result while refreshing the editable work list.
        const rows = [...progress.children].map((item) => ({ text: item.textContent, failed: item.classList.contains('is-error') }));
        await loadArtists(draft.slug);
        const newProgress = shell.querySelector('.admin-upload-progress');
        for (const row of rows) newProgress.append(element('li', row.failed ? 'is-error' : '', row.text));
        message(`Обработано ${successCount} из ${files.length}. Изображения сохранены в черновике.`, successCount !== files.length);
      });
    });
    return form;
  }

  function createWorkEditor(work, index) {
    const row = element('article', 'admin-work');
    const preview = element('div', 'admin-work-image');
    const imagePath = safeImagePath(work.thumbnailSrc || work.imageSrc);
    if (imagePath) {
      const image = element('img');
      image.src = imagePath;
      image.alt = '';
      image.loading = 'lazy';
      preview.append(image);
    }
    preview.append(element('span', 'admin-work-number', String(index + 1).padStart(2, '0')));
    const content = element('div', 'admin-work-content');
    const rowHeading = element('div', 'admin-work-heading');
    rowHeading.append(element('h4', '', work.title || `Работа ${index + 1}`));
    const order = element('div', 'admin-order-controls');
    const move = (offset) => {
      const next = index + offset;
      if (busy || next < 0 || next >= draft.works.length) return;
      [draft.works[index], draft.works[next]] = [draft.works[next], draft.works[index]];
      markDirty();
      renderWorkspace();
      shell.querySelectorAll('.admin-work')[next]?.querySelector('input')?.focus();
    };
    const up = button('↑', () => move(-1));
    up.setAttribute('aria-label', `Переместить работу ${index + 1} выше`);
    up.disabled = index === 0;
    const down = button('↓', () => move(1));
    down.setAttribute('aria-label', `Переместить работу ${index + 1} ниже`);
    down.disabled = index === draft.works.length - 1;
    order.append(up, down, button('Убрать', () => {
      if (!window.confirm('Убрать работу из черновика экспозиции? Оригинал останется в хранилище. Изменение вступит в силу после сохранения.')) return;
      draft.works.splice(index, 1);
      markDirty();
      renderWorkspace();
      shell.querySelector('.admin-editor-heading button')?.focus();
    }, 'admin-button is-quiet'));
    rowHeading.append(order);
    const grid = element('div', 'admin-form-grid');
    const assign = (key) => (value) => { work[key] = value; markDirty(); };
    const dimension = (key) => (value) => {
      if (value === '') delete work[key];
      else work[key] = Number(value);
      markDirty();
    };
    grid.append(
      field('Название', work.title, assign('title'), { required: true, maxLength: 200 }),
      field('Год', work.year, assign('year'), { maxLength: 40 }),
      field('Техника и материал', work.medium, assign('medium'), { maxLength: 200 }),
      field('Ширина оригинала, см', work.widthCm, dimension('widthCm'), { type: 'number', min: 0.1, max: 10000, step: 'any' }),
      field('Высота оригинала, см', work.heightCm, dimension('heightCm'), { type: 'number', min: 0.1, max: 10000, step: 'any' }),
      field('Описание и история', work.description, assign('description'), { multiline: true, maxLength: 10000 })
    );
    const permissions = element('div', 'admin-work-permissions');
    permissions.append(
      checkbox('Показывать в экспозиции', work.visible !== false, assign('visible')),
      checkbox('У меня есть право на публикацию этой работы', work.rightsConfirmed === true, assign('rightsConfirmed'))
    );
    content.append(rowHeading, grid, permissions);
    row.append(preview, content);
    return row;
  }

  try {
    const status = await api('status');
    if (!status?.backend) throw new Error('Сервер мастерской недоступен.');
    if (!active) return cleanup;
    if (status.authenticated) {
      csrfToken = status.csrfToken || '';
      await loadArtists();
      message('Выберите художника или создайте новую выставку.');
    } else renderLogin(status.setupRequired);
  } catch (error) {
    if (!active || error.name === 'AbortError') return cleanup;
    body.replaceChildren();
    const unavailable = element('div', 'admin-login');
    unavailable.append(element('h2', '', 'Мастерская недоступна'), element('p', '', cloud ? 'Проверьте подключение Supabase и настройку доступа администратора.' : 'Для входа администратора нужен сервер галереи.'));
    unavailable.append(button('Проверить подключение', () => location.reload()));
    body.append(unavailable);
    message(cloud ? error.message : error.status === 404 ? 'Серверная часть по этому адресу не найдена.' : 'Не удалось подключиться к серверу. Проверьте, что он запущен.', true);
  }
  return cleanup;
}
