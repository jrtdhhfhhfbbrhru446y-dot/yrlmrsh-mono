import { defaultPreferences, validatePayload, validateTask, validateSection, validateDraft, validatePreferences,
  isId } from '../domain/backup.js';
import { isDateKey } from '../domain/dates.js';
import { migrateIntervalPreferences } from '../domain/intervals.js';
import { makeCycle, validateDuration, validateStoppedAt, stopCycleAt, MINUTE } from '../domain/time.js';
import { uniqueId } from '../domain/ids.js';
import { ConflictError, requireRevision, editTaskRecord, statusTaskRecord, trashTaskRecord,
  restoreTaskRecord, undoTaskRecord, patchPreferencesRecord, checkCycle, checkDraftOwner,
  checkExpectedTask } from '../domain/records.js';

export const DB_NAME = 'mono-task';
export const DB_VERSION = 3;
let pendingOpen;
const allStores = ['tasks', 'sections', 'settings', 'drafts'];

export function openDatabase() {
  if (pendingOpen) return pendingOpen;
  pendingOpen = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('Локальное хранилище недоступно.')); return; }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let rejected = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      // Version 2 adds drafts; all version 1 stores and records are preserved.
      for (const name of allStores) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
      const settings = request.transaction.objectStore('settings');
      settings.get('preferences').onsuccess = event => {
        const preferences = event.target.result;
        if (!preferences) return;
        settings.get('cycle').onsuccess = event => {
          try {
            settings.put(validatePreferences(migrateIntervalPreferences({ ...preferences, theme: preferences.theme ?? 'light' }, event.target.result ?? null)));
          } catch { request.transaction.abort(); }
        };
      };
    };
    request.onblocked = () => {
      rejected = true;
      reject(new Error('Закройте другие окна приложения и попробуйте снова.'));
    };
    request.onerror = () => { rejected = true; reject(request.error ?? new Error('Не удалось открыть хранилище.')); };
    request.onsuccess = () => {
      const db = request.result;
      if (rejected) { db.close(); return; }
      db.onversionchange = () => {
        db.close(); pendingOpen = null;
        globalThis.dispatchEvent?.(new Event('mono-storage-versionchange'));
      };
      db.onclose = () => { pendingOpen = null; };
      resolve(db);
    };
  }).catch(error => { pendingOpen = null; throw error; });
  return pendingOpen;
}

/** Resolve only on commit. Callback exceptions explicitly abort the whole transaction. */
async function transaction(stores, mode, enqueue) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(stores, mode); } catch (error) { reject(error); return; }
    let result;
    let reason;
    const guard = callback => event => {
      try { callback(event); }
      catch (error) { reason = error; try { tx.abort(); } catch { reject(error); } }
    };
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(reason ?? tx.error ?? new Error('Операция не была сохранена.'));
    tx.onerror = () => { /* Default request errors abort; do not suppress them. */ };
    guard(() => enqueue(tx, value => { result = value; }, guard))();
  });
}

const read = (store, key, guard, callback) => {
  store.get(key).onsuccess = guard(event => callback(event.target.result));
};
const readAll = (store, guard, callback) => {
  store.getAll().onsuccess = guard(event => callback(event.target.result));
};
const sectionsIn = (tx, guard, callback) => readAll(tx.objectStore('sections'), guard,
  sections => callback(new Set(sections.map(section => section.id))));

function removeDraftIn(tx, options, guard, callback) {
  if (!options.draftId) { callback(); return; }
  read(tx.objectStore('drafts'), options.draftId, guard, draft => {
    if (!draft) throw new ConflictError('Этот черновик уже сохранён или удалён. Обновите список.');
    checkDraftOwner(draft, options.draftOwnerId ?? draft.ownerId);
    if (options.expectedDraftUpdatedAt !== undefined && draft.updatedAt !== options.expectedDraftUpdatedAt) {
      throw new ConflictError('Черновик изменился после ввода. Проверьте его перед сохранением.');
    }
    tx.objectStore('drafts').delete(options.draftId); callback();
  });
}

export function readSnapshot() {
  return transaction(allStores, 'readonly', (tx, output, guard) => {
    const snapshot = { tasks: [], sections: [], preferences: defaultPreferences(), cycle: null, drafts: [] };
    output(snapshot);
    readAll(tx.objectStore('tasks'), guard, value => { snapshot.tasks = value; });
    readAll(tx.objectStore('sections'), guard, value => { snapshot.sections = value; });
    readAll(tx.objectStore('drafts'), guard, value => { snapshot.drafts = value; });
    read(tx.objectStore('settings'), 'preferences', guard, value => { snapshot.preferences = value ?? defaultPreferences(); });
    read(tx.objectStore('settings'), 'cycle', guard, value => { snapshot.cycle = value ?? null; });
  });
}

export function addTask(input, options = {}) {
  if (typeof input.text !== 'string' || !input.text.trim()) return Promise.reject(new TypeError('Введите текст задачи.'));
  if (input.text.length > 10000) return Promise.reject(new RangeError('В задаче может быть не больше 10 000 символов.'));
  const task = validateTask(input);
  return transaction(['tasks', 'sections', 'drafts'], 'readwrite', (tx, output, guard) => {
    sectionsIn(tx, guard, sectionIds => {
      validateTask(task, sectionIds);
      readAll(tx.objectStore('tasks'), guard, tasks => {
        if (tasks.length >= 10000) throw new RangeError('Достигнут предел 10 000 задач.');
        const group = tasks.filter(t => t.dueDate === task.dueDate);
        const next = { ...task, order: group.length ? Math.max(...group.map(t => t.order)) + 1 : 1 };
        if (!Number.isFinite(next.order)) throw new RangeError('Не удалось определить порядок задачи.');
        removeDraftIn(tx, options, guard, () => { tx.objectStore('tasks').add(next); output(next); });
      });
    });
  });
}

function mutateTask(id, transform, options = {}) {
  return transaction(['tasks', 'sections', 'drafts'], 'readwrite', (tx, output, guard) => {
    read(tx.objectStore('tasks'), id, guard, current => {
      checkExpectedTask(current, options.expectedTask);
      const updated = transform(current);
      sectionsIn(tx, guard, sectionIds => {
        validateTask(updated, sectionIds);
        removeDraftIn(tx, options, guard, () => { tx.objectStore('tasks').put(updated); output(updated); });
      });
    });
  });
}

export function updateTask(id, patch, expectedRevision, options = {}) {
  return mutateTask(id, task => editTaskRecord(task, patch, expectedRevision), options);
}

/** Only the records captured from the visible group move, together or not at all. */
export function changeTaskDates(expectedTasks, dueDate) {
  if (!(dueDate === null || isDateKey(dueDate)) || !Array.isArray(expectedTasks) ||
    !expectedTasks.length || new Set(expectedTasks.map(task => task.id)).size !== expectedTasks.length) {
    return Promise.reject(new TypeError('Выберите корректную дату для этой группы.'));
  }
  return transaction(['tasks'], 'readwrite', (tx, output, guard) => {
    readAll(tx.objectStore('tasks'), guard, tasks => {
      const moving = expectedTasks.map(expected => {
        const current = tasks.find(task => task.id === expected.id);
        checkExpectedTask(current, expected);
        if (current.status === 'deleted') throw new ConflictError('Задача перемещена в корзину. Обновите список.');
        return current;
      }).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
      const ids = new Set(moving.map(task => task.id));
      const destination = tasks.filter(task => task.dueDate === dueDate && !ids.has(task.id));
      let order = destination.length ? Math.max(...destination.map(task => task.order)) : 0;
      const updated = moving.map(task => task.dueDate === dueDate ? task : validateTask({ ...task, dueDate,
        order: ++order, updatedAt: Math.max(Date.now(), task.updatedAt + 1), revision: task.revision + 1 }));
      for (const task of updated) tx.objectStore('tasks').put(task);
      output(updated);
    });
  });
}
export function setTaskStatus(id, status, expectedRevision, optionsOrNow = {}, now = Date.now()) {
  const options = typeof optionsOrNow === 'number' ? {} : optionsOrNow;
  const timestamp = typeof optionsOrNow === 'number' ? optionsOrNow : now;
  return mutateTask(id, task => statusTaskRecord(task, status, expectedRevision, timestamp), options);
}
export function toggleTask(id, expectedRevision, optionsOrNow = {}, now = Date.now()) {
  const options = typeof optionsOrNow === 'number' ? {} : optionsOrNow;
  const timestamp = typeof optionsOrNow === 'number' ? optionsOrNow : now;
  return mutateTask(id, task => statusTaskRecord(task, task?.status === 'active' ? 'completed' : 'active',
    expectedRevision ?? task?.revision, timestamp), options);
}
export function trashTask(id, expectedRevision, optionsOrNow = {}, now = Date.now()) {
  const options = typeof optionsOrNow === 'number' ? {} : optionsOrNow;
  const timestamp = typeof optionsOrNow === 'number' ? optionsOrNow : now;
  return mutateTask(id, task => trashTaskRecord(task, expectedRevision, timestamp), options);
}
export function restoreTask(id, expectedRevision, optionsOrNow = {}, now = Date.now()) {
  const options = typeof optionsOrNow === 'number' ? {} : optionsOrNow;
  const timestamp = typeof optionsOrNow === 'number' ? optionsOrNow : now;
  return mutateTask(id, task => restoreTaskRecord(task, expectedRevision, timestamp), options);
}
export function undoTask(id, expectedRevision, previous, optionsOrNow = {}, options = {}) {
  const timestamp = typeof optionsOrNow === 'number' ? optionsOrNow : Date.now();
  const guardedOptions = typeof optionsOrNow === 'number' ? options : optionsOrNow;
  return mutateTask(id, task => undoTaskRecord(task, expectedRevision, previous, timestamp), guardedOptions);
}

/** Permanent deletion is allowed only for a current, explicitly confirmed trash record. */
export function deleteTask(id, expectedRevision, options = {}) {
  return transaction(['tasks'], 'readwrite', (tx, output, guard) => {
    read(tx.objectStore('tasks'), id, guard, task => {
      checkExpectedTask(task, options.expectedTask);
      requireRevision(task, expectedRevision);
      if (task.status !== 'deleted') throw new Error('Окончательно удалить можно только запись из корзины.');
      tx.objectStore('tasks').delete(id); output(task);
    });
  });
}
export const permanentlyDeleteTask = deleteTask;

export function addSection(input) {
  const section = validateSection(input);
  return transaction(['sections'], 'readwrite', (tx, output, guard) => {
    readAll(tx.objectStore('sections'), guard, sections => {
      if (sections.length >= 100) throw new RangeError('Можно создать не больше 100 разделов.');
      const next = { ...section, order: sections.length ? Math.max(...sections.map(s => s.order)) + 1 : 1 };
      tx.objectStore('sections').add(next); output(next);
    });
  });
}

export function renameSection(id, name, expectedUpdatedAt) {
  return transaction(['sections'], 'readwrite', (tx, output, guard) => {
    read(tx.objectStore('sections'), id, guard, section => {
      if (!section) throw new Error('Раздел больше не существует.');
      if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== section.updatedAt) throw new ConflictError();
      const updated = validateSection({ ...section, name, updatedAt: Math.max(Date.now(), section.updatedAt + 1) });
      tx.objectStore('sections').put(updated); output(updated);
    });
  });
}

export function deleteSection(id, expectedUpdatedAt) {
  return transaction(allStores, 'readwrite', (tx, output, guard) => {
    read(tx.objectStore('sections'), id, guard, section => {
      if (!section) throw new Error('Раздел больше не существует.');
      if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== section.updatedAt) throw new ConflictError();
      const now = Date.now();
      tx.objectStore('sections').delete(id);
      readAll(tx.objectStore('tasks'), guard, tasks => {
        for (const task of tasks) if (task.sectionId === id) {
          tx.objectStore('tasks').put({ ...task, sectionId: null, updatedAt: now, revision: task.revision + 1 });
        }
      });
      readAll(tx.objectStore('drafts'), guard, drafts => {
        for (const draft of drafts) if (draft.sectionId === id) tx.objectStore('drafts').put({ ...draft, sectionId: null });
      });
      read(tx.objectStore('settings'), 'preferences', guard, prefs => {
        if (prefs?.lastSectionId === id) tx.objectStore('settings').put({ ...prefs, lastSectionId: null });
      });
      output(section);
    });
  });
}

export function patchPreferences(patch) {
  return transaction(['settings', 'sections'], 'readwrite', (tx, output, guard) => {
    read(tx.objectStore('settings'), 'preferences', guard, current => {
      sectionsIn(tx, guard, sectionIds => {
        const preferences = patchPreferencesRecord(current ?? defaultPreferences(), patch, sectionIds);
        tx.objectStore('settings').put(preferences); output(preferences);
      });
    });
  });
}
export const savePreferences = patchPreferences;

const scaleKeys = ['defaultDurationMinutes', 'colorsEnabled', 'intervalBasis', 'intervals', 'legacyIntervals'];
function checkScalePreferences(current, expected) {
  if (expected && scaleKeys.some(key => JSON.stringify(current[key]) !== JSON.stringify(expected[key]))) {
    throw new ConflictError('Настройки шкалы изменились в другом окне. Откройте редактор заново.');
  }
}
function scalePatch(preferences) {
  const patch = {};
  for (const key of scaleKeys) if (Object.hasOwn(preferences, key)) patch[key] = preferences[key];
  return patch;
}

function cycleTiming(cycle) {
  const result = { startAt: cycle.startAt, durationMinutes: cycle.durationMinutes };
  if (cycle.stoppedAt !== undefined) result.stoppedAt = cycle.stoppedAt;
  return result;
}

function checkedTiming(cycle) {
  if (!cycle) return null;
  const result = { ...makeCycle(cycle.startAt, cycle.durationMinutes),
    ...(cycle.stoppedAt !== undefined ? { stoppedAt: cycle.stoppedAt } : {}) };
  validateStoppedAt(result);
  return result;
}

/** Preferences and the displayed cycle commit atomically; unrelated preferences survive. */
export function saveScaleEditor(config, expectedCycle, expectedPreferences) {
  const validated = checkedTiming(config.cycle);
  if (['start', 'restart'].includes(config.action) && validated &&
    validated.startAt + validated.durationMinutes * MINUTE <= Date.now()) {
    throw new RangeError('Окончание уже прошло. Выберите новое время окончания.');
  }
  const operationId = uniqueId();
  return transaction(['settings', 'sections'], 'readwrite', (tx, output, guard) => {
    read(tx.objectStore('settings'), 'cycle', guard, currentCycle => {
      const current = currentCycle ?? null;
      checkCycle(current, expectedCycle);
      read(tx.objectStore('settings'), 'preferences', guard, value => {
        const preferences = value ?? defaultPreferences();
        checkScalePreferences(preferences, expectedPreferences);
        sectionsIn(tx, guard, sectionIds => {
          const nextPreferences = patchPreferencesRecord(preferences, scalePatch(config.preferences), sectionIds);
          if (!validated) {
            if (current) throw new ConflictError('Отсчёт уже существует. Откройте редактор заново.');
            tx.objectStore('settings').put(nextPreferences); output(null); return;
          }
          const timing = { ...validated };
          if (!['start', 'restart', 'stop'].includes(config.action) && current?.stoppedAt !== undefined) timing.stoppedAt = current.stoppedAt;
          validateStoppedAt(timing);
          const cycle = { id: 'cycle', ...timing, revision: (current?.revision ?? 0) + 1, operationId,
            previousCycle: current ? cycleTiming(current) : null };
          tx.objectStore('settings').put(nextPreferences); tx.objectStore('settings').put(cycle); output(cycle);
        });
      });
    });
  });
}

export function restoreScaleEditor(previous, expectedCycle, expectedPreferences) {
  const operationId = uniqueId();
  return transaction(['settings', 'sections'], 'readwrite', (tx, output, guard) => {
    read(tx.objectStore('settings'), 'cycle', guard, current => {
      checkCycle(current ?? null, expectedCycle);
      read(tx.objectStore('settings'), 'preferences', guard, value => {
        const preferences = value ?? defaultPreferences();
        checkScalePreferences(preferences, expectedPreferences);
        sectionsIn(tx, guard, sectionIds => {
          const nextPreferences = patchPreferencesRecord(preferences, scalePatch(previous.preferences), sectionIds);
          if (!Object.hasOwn(previous.preferences, 'legacyIntervals')) delete nextPreferences.legacyIntervals;
          tx.objectStore('settings').put(nextPreferences);
          if (!previous.cycle) { tx.objectStore('settings').delete('cycle'); output(null); return; }
          const cycle = { ...previous.cycle, revision: (current?.revision ?? 0) + 1, operationId };
          tx.objectStore('settings').put(cycle); output(cycle);
        });
      });
    });
  });
}

function mutateCycle(change, expectedCycle) {
  const operationId = uniqueId();
  return transaction(['settings'], 'readwrite', (tx, output, guard) => {
    read(tx.objectStore('settings'), 'cycle', guard, value => {
      const current = value ?? null;
      checkCycle(current, expectedCycle);
      const next = change(current);
      if (!next) { tx.objectStore('settings').delete('cycle'); output(null); return; }
      const cycle = { id: 'cycle', ...next, revision: (current?.revision ?? 0) + 1, operationId,
        previousCycle: current ? cycleTiming(current) : null };
      tx.objectStore('settings').put(cycle); output(cycle);
    });
  });
}

export function startCycle(cycle, expectedCycle) {
  const validated = makeCycle(cycle.startAt, cycle.durationMinutes);
  if (validated.startAt + validated.durationMinutes * MINUTE <= Date.now()) {
    throw new RangeError('Окончание уже прошло. Выберите новое время окончания.');
  }
  return mutateCycle(() => validated, expectedCycle);
}
export function stopCycle(expectedCycle, now = Date.now()) {
  return mutateCycle(current => stopCycleAt(current, now), expectedCycle);
}
export function correctCycle(startAt, expectedCycle) {
  return mutateCycle(current => {
    if (!current) throw new Error('Сначала запустите отсчёт.');
    return checkedTiming({ ...cycleTiming(current), startAt });
  }, expectedCycle);
}
export function applyCycleDuration(durationMinutes, expectedCycle) {
  validateDuration(durationMinutes);
  return mutateCycle(current => {
    if (!current) throw new Error('Сначала запустите отсчёт.');
    return checkedTiming({ ...cycleTiming(current), durationMinutes });
  }, expectedCycle);
}
export function restorePreviousCycle(expectedCycle) {
  const operationId = uniqueId();
  return transaction(['settings'], 'readwrite', (tx, output, guard) => {
    read(tx.objectStore('settings'), 'cycle', guard, value => {
      const current = value ?? null;
      checkCycle(current, expectedCycle);
      if (!current) throw new Error('Нет отсчёта для восстановления.');
      if (!current.previousCycle) { tx.objectStore('settings').delete('cycle'); output(null); return; }
      const cycle = { id: 'cycle', ...current.previousCycle, previousCycle: null,
        revision: (current.revision ?? 1) + 1, operationId };
      tx.objectStore('settings').put(cycle); output(cycle);
    });
  });
}

export function saveDraft(input) {
  const draft = validateDraft(input);
  return transaction(['drafts', 'sections'], 'readwrite', (tx, output, guard) => {
    sectionsIn(tx, guard, sectionIds => {
      validateDraft(draft, sectionIds);
      read(tx.objectStore('drafts'), draft.id, guard, previous => {
        checkDraftOwner(previous, draft.ownerId);
        if (previous && previous.updatedAt > draft.updatedAt) throw new ConflictError('Есть более новый черновик.');
        readAll(tx.objectStore('drafts'), guard, drafts => {
          if (!previous && drafts.length >= 1000) throw new RangeError('Слишком много черновиков. Восстановите или удалите ненужные.');
          tx.objectStore('drafts').put(draft); output(draft);
        });
      });
    });
  });
}

export function deleteDraft(id, ownerId, expectedUpdatedAt) {
  if (!isId(id)) return Promise.reject(new TypeError('Некорректный черновик.'));
  return transaction(['drafts'], 'readwrite', (tx, output, guard) => {
    read(tx.objectStore('drafts'), id, guard, draft => {
      if (ownerId !== undefined) checkDraftOwner(draft, ownerId);
      if (expectedUpdatedAt !== undefined && draft?.updatedAt !== expectedUpdatedAt) {
        throw new ConflictError('Черновик изменился. Проверьте его перед удалением.');
      }
      tx.objectStore('drafts').delete(id); output(draft ?? null);
    });
  });
}

/** Claim only after the user selects a recovered draft; the task revision stays unchanged. */
export function claimDraft(id, ownerId, expectedUpdatedAt) {
  if (!isId(ownerId)) return Promise.reject(new TypeError('Некорректный идентификатор окна.'));
  return transaction(['drafts'], 'readwrite', (tx, output, guard) => {
    read(tx.objectStore('drafts'), id, guard, draft => {
      if (!draft) throw new Error('Черновик больше не существует.');
      if (expectedUpdatedAt !== undefined && draft.updatedAt !== expectedUpdatedAt) throw new ConflictError();
      const updated = { ...draft, ownerId, updatedAt: Math.max(Date.now(), draft.updatedAt + 1) };
      tx.objectStore('drafts').put(updated); output(updated);
    });
  });
}

export function replaceSnapshot(input, { discardDrafts = false, expectedDrafts } = {}) {
  const payload = validatePayload(input);
  return transaction(allStores, 'readwrite', (tx, output, guard) => {
    readAll(tx.objectStore('drafts'), guard, drafts => {
      if (drafts.length && !discardDrafts) throw new Error('Сначала сохраните или явно подтвердите замену черновиков.');
      if (expectedDrafts && (drafts.length !== expectedDrafts.length || drafts.some(d =>
        !expectedDrafts.some(e => e.id === d.id && e.ownerId === d.ownerId && e.updatedAt === d.updatedAt)))) {
        throw new ConflictError('Черновики изменились после подтверждения импорта. Проверьте их ещё раз.');
      }
      for (const name of allStores) tx.objectStore(name).clear();
      for (const task of payload.tasks) tx.objectStore('tasks').add(task);
      for (const section of payload.sections) tx.objectStore('sections').add(section);
      for (const draft of payload.drafts) tx.objectStore('drafts').add(draft);
      tx.objectStore('settings').put(payload.preferences);
      if (payload.cycle) tx.objectStore('settings').put(payload.cycle);
      output(payload);
    });
  });
}
