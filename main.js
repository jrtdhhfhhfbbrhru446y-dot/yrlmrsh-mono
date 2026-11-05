import * as repository from './storage/db.js';
import { makeCycle, scaleState } from './domain/time.js';
import { localDateKey } from './domain/dates.js';
import { uniqueId } from './domain/ids.js';
import { createTaskUI } from './ui/tasks.js';
import { element, button, input, field } from './ui/dom.js';
import { buildDataSettings } from './ui/data.js';
import { renderScale, bindScaleStart, attachScaleViewport, buildScaleSettings } from './ui/scale.js';
import { initPwa } from './ui/pwa.js';
import { revealSurfaceControl } from './ui/viewport.js';

const $ = selector => document.querySelector(selector);
const channel = 'BroadcastChannel' in globalThis ? new BroadcastChannel('mono-task-changes') : null;
let snapshot;
let refreshSequence = 0;
let busy = false;
let view = 'all';
let undo = null;
let noticeTimer;
let today = localDateKey();
let pwa;
let pwaState = { message: 'Подготавливаем офлайн-режим…' };
let surfaceKind;
let surfaceTrigger;
let ownerId = uniqueId();
try {
  ownerId = sessionStorage.getItem('mono-draft-owner') || ownerId;
  sessionStorage.setItem('mono-draft-owner', ownerId);
  view = sessionStorage.getItem('mono-view') || view;
} catch { /* Task data never depends on sessionStorage. */ }

function reportError(error) {
  const target = $('#surface').open ? $('#surface-error') : $('#error-message');
  target.textContent = error instanceof Error ? error.message : 'Не удалось сохранить. Попробуйте ещё раз.';
  target.hidden = false;
}
function clearErrors() { $('#error-message').hidden = true; $('#surface-error').hidden = true; }
function notify(message, action = null) {
  clearTimeout(noticeTimer);
  undo = action;
  $('#notice-text').textContent = message;
  $('#undo-action').hidden = !action;
  $('#notice').hidden = false;
  noticeTimer = setTimeout(() => { $('#notice').hidden = true; undo = null; }, 8000);
}
async function refresh() {
  const sequence = ++refreshSequence;
  const next = await repository.readSnapshot();
  if (sequence !== refreshSequence) return;
  snapshot = next;
  applyTheme(snapshot.preferences.theme);
  if (!['all', 'none', 'completed', 'trash'].includes(view) && !snapshot.sections.some(section => section.id === view)) view = 'all';
  tasks.render(); renderScale($('#time-rail'), snapshot); renderMenu();
  const label = ['all', 'none'].includes(view) ? (view === 'none' ? 'Без раздела' : '') :
    view === 'completed' ? 'Выполненные' : view === 'trash' ? 'Корзина' : snapshot.sections.find(section => section.id === view)?.name;
  $('#view-label').textContent = label ?? '';
  $('#view-label').hidden = !label;
}
async function mutate(work) {
  if (busy) return false;
  busy = true; clearErrors();
  try {
    await work();
    channel?.postMessage('changed');
    try { await refresh(); }
    catch { reportError(new Error('Изменение сохранено, но перечитать список пока не удалось. Перезагрузите приложение, не очищая данные сайта.')); }
    return true;
  } catch (error) { reportError(error); return false; }
  finally { busy = false; }
}
const tasks = createTaskUI({ getSnapshot: () => snapshot, getView: () => view, mutate, refresh, reportError, notify, ownerId });

function applyTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('meta[name="theme-color"]').content = dark ? '#000000' : '#ffffff';
  const manifest = dark ? '/manifest-dark.webmanifest' : '/manifest.webmanifest';
  if ($('link[rel="manifest"]').getAttribute('href') !== manifest) $('link[rel="manifest"]').setAttribute('href', manifest);
  try { localStorage.setItem('mono-theme', dark ? 'dark' : 'light'); } catch { /* Optional first-paint hint only. */ }
}
function syncLayerLock() { document.body.classList.toggle('has-layer', $('#menu-layer').open || $('#surface').open); }

function closeMenu(returnFocus = true) {
  if ($('#menu-layer').open) $('#menu-layer').close();
  $('#menu-button').setAttribute('aria-expanded', 'false');
  $('#menu-button').setAttribute('aria-label', 'Открыть меню');
  if (returnFocus) $('#menu-button').focus({ preventScroll: true });
  syncLayerLock();
}
async function selectView(next) {
  if (!await mutate(async () => {
    await tasks.suspend();
    await repository.patchPreferences({ lastSectionId: ['all', 'none', 'completed', 'trash'].includes(next) ? null : next });
    view = next;
    try { sessionStorage.setItem('mono-view', view); } catch { /* Optional view convenience. */ }
  })) return;
  closeMenu();
  $('#task-page').scrollTo({ top: 0, behavior: 'instant' });
  await tasks.restoreContext();
}
function renderMenu() {
  const menu = $('#navigation');
  const focused = menu.contains(document.activeElement) ? { view: document.activeElement.dataset.view, id: document.activeElement.id } : null;
  menu.replaceChildren();
  function entry(label, key) {
    const item = button(label, () => selectView(key), 'menu-item');
    item.dataset.view = key;
    if (view === key) { item.classList.add('is-current'); item.setAttribute('aria-current', 'page'); }
    menu.append(item);
  }
  entry('Все задачи', 'all'); entry('Без раздела', 'none');
  for (const section of [...snapshot.sections].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))) {
    const row = element('div', 'menu-section');
    const item = button(section.name, () => selectView(section.id), 'menu-item');
    item.dataset.view = section.id;
    if (view === section.id) { item.classList.add('is-current'); item.setAttribute('aria-current', 'page'); }
    const context = button('…', () => openSections(false, section.id), 'icon-button section-context');
    context.setAttribute('aria-label', `Изменить раздел «${section.name}»`); context.title = 'Изменить раздел';
    item.addEventListener('contextmenu', event => { event.preventDefault(); openSections(false, section.id); });
    row.append(item, context); menu.append(row);
  }
  menu.append(button('+ Новый раздел', () => openSections(true), 'menu-item menu-secondary'));
  const service = element('div', 'menu-service'); menu.append(service);
  service.append(button('Выполненные', () => selectView('completed'), 'menu-item'),
    button('Корзина', () => selectView('trash'), 'menu-item'),
    button('Настройки', () => openSettings(), 'menu-item'));
  const theme = button(snapshot.preferences.theme === 'dark' ? 'Светлая тема' : 'Тёмная тема',
    () => mutate(() => repository.patchPreferences({ theme: snapshot.preferences.theme === 'dark' ? 'light' : 'dark' })), 'menu-item menu-theme');
  theme.id = 'theme-toggle'; menu.append(theme);
  if (focused?.view) menu.querySelector(`[data-view="${CSS.escape(focused.view)}"]`)?.focus({ preventScroll: true });
  else if (focused?.id) document.getElementById(focused.id)?.focus({ preventScroll: true });
}
function openSurface(title, content, kind) {
  if (!$('#surface').open) surfaceTrigger = document.activeElement;
  closeMenu(false);
  surfaceKind = kind;
  $('#surface-heading').textContent = title;
  $('#surface-content').replaceChildren(content);
  $('#surface .surface-body').scrollTop = 0;
  $('#surface-error').hidden = true;
  if (!$('#surface').open) $('#surface').showModal();
  syncLayerLock();
  $('#surface-close').focus({ preventScroll: true });
}
function closeSurface() { $('#surface').close(); surfaceKind = null; syncLayerLock(); }

function openSections(creating = false, sectionId = null) {
  if (!snapshot) return;
  const content = element('div', 'section-settings');
  const form = element('form', 'section-create');
  const name = input('text'); name.id = 'section-name'; name.maxLength = 80; name.required = true;
  form.append(field('Новый раздел', name));
  const submit = element('button', 'text-action', 'Создать'); submit.type = 'submit'; form.append(submit);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!name.value.trim() || busy) return;
    const now = Date.now();
    if (await mutate(() => repository.addSection({ id: uniqueId(), name: name.value.trim(), order: now, createdAt: now, updatedAt: now }))) openSections(true);
  });
  if (creating) content.append(form);
  for (const section of snapshot.sections.filter(section => !creating && section.id === sectionId)) {
    const row = element('div', 'section-edit');
    const renamed = input('text', section.name); renamed.maxLength = 80; renamed.setAttribute('aria-label', 'Название раздела');
    row.append(renamed, button('Переименовать', async () => {
      if (await mutate(() => repository.renameSection(section.id, renamed.value, section.updatedAt))) closeSurface();
    }), button('Удалить раздел', async () => {
      if (!confirm('Раздел будет удалён. Его задачи останутся без раздела. Продолжить?')) return;
      if (await mutate(() => repository.deleteSection(section.id, section.updatedAt))) closeSurface();
    })); content.append(row);
  }
  openSurface(creating ? 'Новый раздел' : 'Раздел', content, 'sections');
  if (creating) name.focus({ preventScroll: true });
}
function cycleNotice(oldCycle, cycle) {
  notify(oldCycle ? 'Шкала перезапущена' : 'Шкала запущена', () => mutate(() => repository.restorePreviousCycle(cycle)));
}
async function beginCycle(cycle, expectedCycle = snapshot.cycle) {
  const old = expectedCycle;
  let updated;
  const success = await mutate(async () => { updated = await repository.startCycle(cycle, expectedCycle); });
  if (success) cycleNotice(old, updated);
  return success;
}
async function stopCurrentCycle(expectedCycle = snapshot.cycle) {
  let stopped;
  const success = await mutate(async () => { stopped = await repository.stopCycle(expectedCycle); });
  if (success) notify('Шкала остановлена', () => mutate(() => repository.restorePreviousCycle(stopped)));
  return success;
}
function openScaleSettings() {
  const current = snapshot;
  const commit = async (config, expectedCycle, intent) => {
    let saved;
    const success = await mutate(async () => { saved = await repository.saveScaleEditor(config, expectedCycle, current.preferences); });
    if (success && ['restart', 'stop'].includes(intent)) notify(intent === 'stop' ? 'Шкала остановлена' : 'Шкала перезапущена',
      () => mutate(() => repository.restoreScaleEditor(current, saved, config.preferences)));
    else if (success) notify(intent === 'start' ? 'Шкала запущена' : 'Шкала сохранена');
    return success;
  };
  const content = buildScaleSettings({ snapshot: current,
    onSave: (config, expectedCycle) => commit(config, expectedCycle, 'save'),
    onStart: (config, expectedCycle) => commit(config, expectedCycle, 'start'),
    onStop: (config, expectedCycle) => commit(config, expectedCycle, 'stop'),
    onRestart: (config, expectedCycle) => commit(config, expectedCycle, 'restart'),
    onClose: closeSurface, reportError });
  openSurface('Шкала дня', content, 'scale');
}
function openDataSettings() {
  const content = buildDataSettings({ getSnapshot: () => snapshot, mutate, flushDrafts: tasks.flushDrafts,
    afterImport: async () => {
      tasks.discardEditor(); view = 'all';
      try { sessionStorage.setItem('mono-view', 'all'); } catch { /* Optional view convenience. */ }
      closeSurface();
    }, reportError, notify });
  openSurface('Резервная копия', content, 'data');
}
function pwaContent() {
  const content = element('div', 'pwa-settings');
  const state = element('p', 'support-text', pwaState.message); state.id = 'offline-state'; content.append(state);
  if (pwaState.status === 'unavailable') content.append(button('Подготовить офлайн', () => pwa?.prepareOffline()));
  if (pwaState.updateReady) {
    const update = button('Обновить приложение', async () => {
      try {
        if (busy) return;
        update.disabled = true;
        const applied = await pwa.applyUpdate({ beforeReload: tasks.prepareReload });
        if (!applied) update.disabled = false;
      } catch (error) { update.disabled = false; reportError(error); }
    }); update.id = 'apply-update'; content.append(update);
    content.append(element('p', 'support-text', 'Незавершённый ввод будет сохранён как черновик перед обновлением.'));
  } else content.append(button('Проверить обновление', async () => { await pwa?.checkForUpdate(); }));
  if (pwaState.installAvailable) content.append(button('Установить приложение', () => pwa?.promptInstall()));
  content.append(element('p', 'support-text', pwaState.installMessage || 'iPhone: Safari → «Поделиться» → «На экран Домой». Android: меню браузера → «Установить приложение».'));
  content.append(element('p', 'support-text', 'Установка и офлайн-режим на телефоне требуют HTTPS. Вкладка Safari и установленное приложение могут иметь отдельные записи.'));
  return content;
}
function openSettings() {
  const content = element('div', 'settings-home');
  content.append(button('Шкала дня', openScaleSettings), button('Резервная копия', openDataSettings),
    button('О приложении', () => openSurface('О приложении', pwaContent(), 'about')));
  openSurface('Настройки', content, 'settings');
}

$('#menu-button').addEventListener('click', () => {
  if (!snapshot) return;
  if ($('#menu-layer').open) { closeMenu(); return; }
  $('#menu-layer').showModal(); syncLayerLock();
  $('#menu-button').setAttribute('aria-expanded', 'true');
  $('#menu-close').focus({ preventScroll: true });
});
$('#menu-close').addEventListener('click', () => closeMenu());
$('#menu-layer').addEventListener('click', event => {
  const rect = $('#menu-layer').getBoundingClientRect();
  if (event.target === $('#menu-layer') && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) closeMenu();
});
$('#menu-layer').addEventListener('close', () => {
  $('#menu-button').setAttribute('aria-expanded', 'false'); syncLayerLock();
  if (!$('#surface').open) $('#menu-button').focus({ preventScroll: true });
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Tab') return;
  const layer = $('#surface').open ? $('#surface') : $('#menu-layer').open ? $('#menu-layer') : null;
  if (!layer) return;
  const controls = [...layer.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex]:not([tabindex="-1"])')]
    .filter(control => control.getClientRects().length && !control.closest('[hidden], [inert]'));
  const first = controls[0]; const last = controls.at(-1);
  if (!first) { event.preventDefault(); layer.focus(); return; }
  const index = controls.indexOf(document.activeElement);
  if (index < 0 || (event.shiftKey ? index === 0 : index === controls.length - 1)) {
    event.preventDefault(); (event.shiftKey ? last : first).focus({ preventScroll: true });
  }
});
$('#surface-close').addEventListener('click', closeSurface);
$('#surface').addEventListener('close', () => { surfaceKind = null; syncLayerLock(); (surfaceTrigger?.isConnected && !surfaceTrigger.closest('#menu-layer, #surface') ? surfaceTrigger : $('#menu-button')).focus({ preventScroll: true }); });
$('#undo-action').addEventListener('click', async () => {
  if (!undo || busy) return;
  const action = undo;
  if (await action()) { clearTimeout(noticeTimer); $('#notice').hidden = true; undo = null; }
});
bindScaleStart($('#start-cycle'), { onStart: () => {
  if (!snapshot) return;
  if (scaleState(snapshot.cycle).phase === 'running') return stopCurrentCycle();
  else return beginCycle(makeCycle(Date.now(), snapshot.preferences.defaultDurationMinutes));
}, onManualStart: openScaleSettings, reportError });
attachScaleViewport($('#time-rail'));
function revealFocusedInput() {
  const control = document.activeElement;
  if (control?.matches('input, textarea, select') && control.closest('.inline-editor, .surface-body')) {
    requestAnimationFrame(() => {
      if (!control.isConnected || document.activeElement !== control) return;
      if (control.closest('.surface-body')) revealSurfaceControl(control);
      else control.scrollIntoView({ block: 'nearest' });
    });
  }
}
(window.visualViewport ?? window).addEventListener('resize', revealFocusedInput);
$('#surface').addEventListener('focusin', revealFocusedInput);
channel?.addEventListener('message', () => { if (snapshot) refresh().catch(reportError); });
addEventListener('mono-storage-versionchange', () => reportError(new Error('Хранилище обновлено в другом окне. Завершите ввод и перезагрузите приложение. Не очищайте данные сайта.')));
async function resume() {
  if (!snapshot || busy) return;
  const nextToday = localDateKey();
  if (nextToday !== today) today = nextToday;
  await refresh();
  await tasks.restoreContext();
}
addEventListener('pageshow', () => resume().catch(reportError));
addEventListener('focus', () => resume().catch(reportError));
document.addEventListener('visibilitychange', () => { if (!document.hidden) resume().catch(reportError); });
addEventListener('beforeunload', event => { if (busy || tasks.hasPending()) { event.preventDefault(); event.returnValue = ''; } });
setInterval(() => { if (!document.hidden) resume().catch(reportError); }, 15_000);

try {
  snapshot = await repository.readSnapshot();
  if (view === 'all' && snapshot.preferences.lastSectionId) view = snapshot.preferences.lastSectionId;
  await refresh();
  await tasks.restoreContext();
} catch (error) { reportError(new Error('Не удалось открыть локальное хранилище. Не очищайте данные сайта. ' + error.message)); }
pwa = await initPwa({ onState: state => {
  pwaState = state;
  if (surfaceKind === 'about') $('#surface-content .pwa-settings')?.replaceWith(pwaContent());
}, onUpdateReady: () => { if (surfaceKind === 'about') $('#surface-content .pwa-settings')?.replaceWith(pwaContent()); } });
