import { production } from '../runtime.js';

function installInformation() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (standalone) return { installed: true, installMessage: 'Приложение открыто с домашнего экрана.' };
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return { installed: false, installMessage: ios
    ? 'В Safari откройте «Поделиться» → «На экран Домой». Данные установленного приложения могут отличаться от данных вкладки; переносите их резервной копией.'
    : 'Для установки выберите «Установить приложение» в меню браузера. На компьютере можно продолжать работать во вкладке.' };
}

/** An activated worker can exist after its cache was cleared: ask for all precached assets. */
async function requestWorker(worker, type, timeout = 5000) {
  if (!worker) throw new Error('Офлайн-режим пока не подготовлен.');
  const result = await new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const finish = callback => value => {
      clearTimeout(timer); channel.port1.close(); callback(value);
    };
    const timer = setTimeout(finish(reject), timeout, new Error('Не удалось подготовить или проверить офлайн-файлы. Повторите при подключении к интернету.'));
    channel.port1.onmessage = finish(resolve);
    try { worker.postMessage({ type }, [channel.port2]); }
    catch (error) { finish(reject)(error); }
  });
  return result.data;
}

async function inspectCache(worker) {
  if (!worker) return false;
  const result = await requestWorker(worker, 'GET_CACHE_STATUS');
  return result?.type === 'CACHE_STATUS' && result.ready === true;
}

/** Register only production assets. No reload occurs until applyUpdate is explicitly invoked. */
export async function initPwa({ onState = () => {}, onUpdateReady = () => {} } = {}) {
  let registration;
  let waitingWorker;
  let installPrompt;
  let updateRequested = false;
  let destroyed = false;
  let checking;
  let state = { status: 'preparing', message: 'Подготовка офлайн-режима…', updateReady: false,
    installAvailable: false, ...installInformation() };
  const publish = patch => {
    if (destroyed) return;
    state = { ...state, ...patch }; onState({ ...state });
  };
  const updateReady = () => {
    const worker = registration?.waiting;
    if (worker && worker !== waitingWorker) {
      waitingWorker = worker; publish({ updateReady: true }); onUpdateReady(worker);
    }
  };
  const checkReadiness = async () => {
    if (checking) return checking;
    checking = (async () => {
      try {
        const ready = await inspectCache(registration?.active);
        publish({ status: ready ? 'ready' : 'unavailable', message: ready
          ? 'Готово к работе без интернета.' : 'Офлайн-файлы пока не готовы. Подключитесь к интернету и повторите подготовку.' });
        return ready;
      } catch (error) { publish({ status: 'unavailable', message: error.message }); return false; }
      finally { checking = null; }
    })();
    return checking;
  };
  const controllerChange = () => {
    if (updateRequested) window.location.reload();
    else {
      waitingWorker = registration?.waiting;
      publish({ updateReady: Boolean(waitingWorker) });
      checkReadiness();
    }
  };
  const beforeInstall = event => {
    event.preventDefault(); installPrompt = event;
    publish({ installAvailable: true });
  };
  const installed = () => {
    installPrompt = null;
    publish({ installed: true, installAvailable: false, installMessage: 'Приложение установлено. Записи хранятся на этом устройстве.' });
  };
  const onFocus = () => { if (registration?.active) checkReadiness(); };
  const observeInstall = () => {
    const worker = registration?.installing;
    if (!worker) return;
    if (!registration.active) publish({ status: 'preparing', message: 'Подготовка офлайн-режима…' });
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed') updateReady();
      if (worker.state === 'activated') checkReadiness();
      if (worker.state === 'redundant' && !registration.active) {
        publish({ status: 'unavailable', message: 'Подготовить офлайн-файлы не удалось. Подключитесь к интернету и повторите.' });
      }
    });
  };
  const register = async () => {
    registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
    registration.addEventListener('updatefound', observeInstall); observeInstall(); updateReady();
  };
  const waitForActive = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Подготовка офлайн-файлов не завершилась. Проверьте соединение и повторите.')), 30000);
    navigator.serviceWorker.ready.then(value => {
      clearTimeout(timer); registration = value; resolve(value);
    }, error => { clearTimeout(timer); reject(error); });
  });
  window.addEventListener('beforeinstallprompt', beforeInstall);
  window.addEventListener('appinstalled', installed);
  window.addEventListener('focus', onFocus);
  if (!production) publish({ status: 'development', message: 'Офлайн-режим доступен в production-сборке.' });
  else if (!window.isSecureContext || !('serviceWorker' in navigator)) {
    publish({ status: 'unsupported', message: 'В этом браузере или по этому адресу офлайн-режим недоступен. Для установки нужен HTTPS или localhost.' });
  } else {
    publish({});
    navigator.serviceWorker.addEventListener('controllerchange', controllerChange);
    try {
      await register();
      if (registration.active) await checkReadiness();
      navigator.serviceWorker.ready.then(() => { if (!destroyed) checkReadiness(); });
    } catch { publish({ status: 'unavailable', message: 'Подготовить офлайн-режим пока не удалось. Записи остаются в локальном хранилище.' }); }
  }
  return {
    getState: () => ({ ...state }),
    async checkForUpdate() {
      if (!registration) return false;
      try { await registration.update(); updateReady(); return checkReadiness(); }
      catch { publish({ message: 'Не удалось проверить обновление. Повторите при подключении к интернету.' }); return false; }
    },
    async prepareOffline() {
      if (!production || !window.isSecureContext || !('serviceWorker' in navigator)) return false;
      publish({ status: 'preparing', message: 'Подготовка офлайн-файлов…' });
      try {
        if (!registration) await register();
        try { await registration.update(); updateReady(); } catch { /* The worker reports a useful preparation result below. */ }
        if (!registration.active) { await waitForActive(); return checkReadiness(); }
        if (registration.waiting) {
          publish({ status: 'unavailable', message: 'Офлайн-файлы новой версии подготовлены. Обновите приложение, чтобы использовать их.' });
          return false;
        }
        const result = await requestWorker(registration.active, 'PREPARE_CACHE', 45000);
        if (result?.updateRequired) {
          publish({ status: 'unavailable', message: 'На сервере новая версия. Проверьте обновление и примените его, чтобы подготовить офлайн-файлы.' });
          return false;
        }
        return checkReadiness();
      } catch (error) { publish({ status: 'unavailable', message: error.message }); return false; }
    },
    async applyUpdate({ beforeReload = async () => true } = {}) {
      const worker = registration?.waiting ?? waitingWorker;
      if (!worker || updateRequested || worker.state === 'redundant') return false;
      if (await beforeReload() === false) return false;
      updateRequested = true;
      if (worker.state === 'activated') window.location.reload();
      else worker.postMessage({ type: 'ACTIVATE_UPDATE' });
      return true;
    },
    async promptInstall() {
      if (!installPrompt) return false;
      const prompt = installPrompt; installPrompt = null; publish({ installAvailable: false });
      await prompt.prompt();
      const choice = await prompt.userChoice;
      return choice.outcome === 'accepted';
    },
    destroy() {
      destroyed = true;
      window.removeEventListener('beforeinstallprompt', beforeInstall);
      window.removeEventListener('appinstalled', installed);
      window.removeEventListener('focus', onFocus);
      navigator.serviceWorker?.removeEventListener('controllerchange', controllerChange);
    },
  };
}
