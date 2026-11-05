import { isId, isStamp, validateTask, validatePreferences } from './backup.js';

export class ConflictError extends Error {
  constructor(message = 'Запись изменена в другом окне. Проверьте актуальную запись.') {
    super(message); this.name = 'ConflictError';
  }
}

export function requireRevision(record, expectedRevision) {
  if (!record) throw new Error('Запись больше не существует. Проверьте актуальный список.');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== record.revision) throw new ConflictError();
  return record;
}

export function checkExpectedTask(current, expected) {
  if (expected === undefined) return;
  const previous = validateTask(expected);
  if (!current || Object.keys(previous).some(key => current[key] !== previous[key])) {
    throw new ConflictError('Запись изменена или заменена импортом. Проверьте актуальную запись.');
  }
}

export function editTaskRecord(current, patch, expectedRevision, now = Date.now()) {
  requireRevision(current, expectedRevision);
  if (current.status === 'deleted') throw new Error('Сначала восстановите задачу из корзины.');
  if (!isStamp(now)) throw new TypeError('Некорректное время.');
  const next = { ...current, updatedAt: now, revision: current.revision + 1 };
  for (const key of ['text', 'sectionId', 'dueDate']) if (Object.hasOwn(patch, key)) next[key] = patch[key];
  if (typeof next.text !== 'string' || !next.text.trim()) throw new TypeError('Введите текст задачи.');
  if (next.text.length > 10000) throw new RangeError('В задаче может быть не больше 10 000 символов.');
  return validateTask(next);
}

export function statusTaskRecord(current, status, expectedRevision, now = Date.now()) {
  requireRevision(current, expectedRevision);
  if (!['active', 'completed'].includes(status) || current.status === 'deleted') {
    throw new Error('Сначала восстановите задачу из корзины.');
  }
  return validateTask({ ...current, status, previousStatus: null, completedAt: status === 'completed'
    ? (current.status === 'completed' ? current.completedAt : now) : null,
  deletedAt: null, updatedAt: now, revision: current.revision + 1 });
}

export function trashTaskRecord(current, expectedRevision, now = Date.now()) {
  requireRevision(current, expectedRevision);
  if (current.status === 'deleted') throw new ConflictError('Задача уже в корзине.');
  return validateTask({ ...current, previousStatus: current.status, status: 'deleted', deletedAt: now,
    updatedAt: now, revision: current.revision + 1 });
}

export function restoreTaskRecord(current, expectedRevision, now = Date.now()) {
  requireRevision(current, expectedRevision);
  if (current.status !== 'deleted') throw new ConflictError('Задача уже восстановлена.');
  return validateTask({ ...current, status: current.previousStatus, previousStatus: null, deletedAt: null,
    updatedAt: now, revision: current.revision + 1 });
}

export function undoTaskRecord(current, expectedRevision, previous, now = Date.now()) {
  requireRevision(current, expectedRevision);
  const old = validateTask(previous);
  if (old.id !== current.id || old.createdAt !== current.createdAt || old.revision + 1 !== expectedRevision) {
    throw new ConflictError('Это действие уже изменилось. Отмена недоступна.');
  }
  return validateTask({ ...old, updatedAt: now, revision: current.revision + 1 });
}

export function patchPreferencesRecord(current, patch, sectionIds) {
  const next = { ...current };
  for (const key of ['defaultDurationMinutes', 'colorsEnabled', 'intervalBasis', 'intervals', 'legacyIntervals', 'lastSectionId', 'theme']) {
    if (Object.hasOwn(patch, key)) next[key] = patch[key];
  }
  return validatePreferences(next, sectionIds);
}

export function sameCycle(current, expected) {
  if (!current || !expected) return current === expected;
  return current.startAt === expected.startAt && current.durationMinutes === expected.durationMinutes &&
    (current.stoppedAt ?? null) === (expected.stoppedAt ?? null) &&
    (current.revision ?? 1) === (expected.revision ?? 1) && current.operationId === expected.operationId;
}

export function checkCycle(current, expected) {
  if (expected !== undefined && !sameCycle(current, expected)) {
    throw new ConflictError('Отсчёт изменён в другом окне. Проверьте его актуальное состояние.');
  }
}

export function checkDraftOwner(draft, ownerId) {
  if (draft && (!isId(ownerId) || draft.ownerId !== ownerId)) {
    throw new ConflictError('Черновик открыт в другом окне. Сначала выберите его восстановление.');
  }
}
