import { isDateKey } from './dates.js';
import { validateDuration, DEFAULT_DURATION } from './time.js';
import { validateClockIntervals, migrateIntervalPreferences } from './intervals.js';

export const BACKUP_FORMAT = 'mono-task-backup';
export const BACKUP_SCHEMA = 4;
export const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
export const defaultPreferences = () => ({ id: 'preferences', defaultDurationMinutes: DEFAULT_DURATION,
  colorsEnabled: false, intervalBasis: 'clock', intervals: [], lastSectionId: null, theme: 'light' });
const fail = () => { throw new TypeError('Файл не удалось проверить. Ваши текущие записи не изменены.'); };
export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const isStamp = value => Number.isSafeInteger(value) && value >= 0;
export const isId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const nullableStamp = value => value === null || isStamp(value);
const revision = value => Number.isSafeInteger(value) && value >= 1;
const duration = value => { try { return validateDuration(value); } catch { fail(); } };

export function validateSection(s) {
  if (!isRecord(s) || !isId(s.id) || !text(s.name, 80) || !Number.isFinite(s.order) ||
    !isStamp(s.createdAt) || !isStamp(s.updatedAt)) fail();
  return { id: s.id, name: s.name.trim(), order: s.order, createdAt: s.createdAt, updatedAt: s.updatedAt };
}

export function validateTask(t, sectionIds) {
  if (!isRecord(t) || !isId(t.id) || !text(t.text, 10000) ||
    !(t.sectionId === null || (isId(t.sectionId) && (!sectionIds || sectionIds.has(t.sectionId)))) ||
    !(t.dueDate === null || isDateKey(t.dueDate)) ||
    !['active', 'completed', 'deleted'].includes(t.status) ||
    !(t.previousStatus === null || ['active', 'completed'].includes(t.previousStatus)) ||
    !Number.isFinite(t.order) || !isStamp(t.createdAt) || !isStamp(t.updatedAt) ||
    !nullableStamp(t.completedAt) || !nullableStamp(t.deletedAt) || !revision(t.revision)) fail();
  if ((t.status === 'active' && (t.completedAt !== null || t.deletedAt !== null)) ||
    (t.status === 'completed' && (t.completedAt === null || t.deletedAt !== null)) ||
    (t.status === 'deleted' && (t.deletedAt === null || t.previousStatus === null ||
      (t.previousStatus === 'active' && t.completedAt !== null) ||
      (t.previousStatus === 'completed' && t.completedAt === null))) ||
    (t.status !== 'deleted' && t.previousStatus !== null)) fail();
  return { id: t.id, text: t.text, sectionId: t.sectionId, dueDate: t.dueDate, status: t.status,
    previousStatus: t.previousStatus, order: t.order, createdAt: t.createdAt, updatedAt: t.updatedAt,
    completedAt: t.completedAt, deletedAt: t.deletedAt, revision: t.revision };
}

export function validatePreferences(p, sectionIds) {
  if (!isRecord(p) || p.id !== 'preferences' || typeof p.colorsEnabled !== 'boolean' ||
    !Array.isArray(p.intervals) || p.intervals.length > 48 ||
    !(p.lastSectionId === null || (isId(p.lastSectionId) && (!sectionIds || sectionIds.has(p.lastSectionId))))) fail();
  duration(p.defaultDurationMinutes);
  if (!(p.theme === undefined || ['light', 'dark'].includes(p.theme)) ||
    !(p.intervalBasis === undefined || ['offset', 'clock'].includes(p.intervalBasis))) fail();
  const intervalBasis = p.intervalBasis ?? (p.intervals.length ? 'offset' : 'clock');
  let intervals;
  try { intervals = intervalBasis === 'clock' ? validateClockIntervals(p.intervals) : validateOffsets(p.intervals, p.defaultDurationMinutes); }
  catch { fail(); }
  const result = { id: 'preferences', defaultDurationMinutes: p.defaultDurationMinutes,
    colorsEnabled: p.colorsEnabled, intervalBasis, intervals, lastSectionId: p.lastSectionId, theme: p.theme ?? 'light' };
  if (p.legacyIntervals !== undefined) result.legacyIntervals = validateOffsets(p.legacyIntervals, 1440);
  return result;
}

function validateOffsets(values, maximum) {
  if (!Array.isArray(values) || values.length > 48) fail();
  let previousEnd = 0;
  return [...values].sort((a, b) => a?.startMinute - b?.startMinute).map(i => {
    if (!isRecord(i) || typeof i.name !== 'string' || i.name.length > 80 || typeof i.color !== 'string' || !/^#[\da-fA-F]{6}$/.test(i.color) ||
      !Number.isInteger(i.startMinute) || !Number.isInteger(i.endMinute) || i.startMinute < previousEnd ||
      i.endMinute <= i.startMinute || i.endMinute > maximum) fail();
    previousEnd = i.endMinute;
    return { name: i.name, color: i.color, startMinute: i.startMinute, endMinute: i.endMinute };
  });
}

export function validateCycle(value) {
  if (value === null) return null;
  const parse = v => {
    if (!isRecord(v) || !isStamp(v.startAt)) fail();
    if (!(v.stoppedAt === undefined || v.stoppedAt === null || (isStamp(v.stoppedAt) && v.stoppedAt >= v.startAt))) fail();
    const result = { startAt: v.startAt, durationMinutes: duration(v.durationMinutes) };
    if (v.stoppedAt !== undefined) result.stoppedAt = v.stoppedAt;
    return result;
  };
  if (!isRecord(value) || value.id !== 'cycle' ||
    !(value.revision === undefined || revision(value.revision)) ||
    !(value.operationId === undefined || isId(value.operationId))) fail();
  const result = { id: 'cycle', ...parse(value), previousCycle: value.previousCycle === null
    ? null : parse(value.previousCycle) };
  if (value.revision !== undefined) result.revision = value.revision;
  if (value.operationId !== undefined) result.operationId = value.operationId;
  return result;
}

export function validateDraft(d, sectionIds) {
  if (!isRecord(d) || !isId(d.id) || !isId(d.ownerId) ||
    !(d.taskId === null || isId(d.taskId)) || typeof d.text !== 'string' || d.text.length > 10000 ||
    !(d.sectionId === null || (isId(d.sectionId) && (!sectionIds || sectionIds.has(d.sectionId)))) ||
    !(d.dueDate === null || isDateKey(d.dueDate)) || !isStamp(d.updatedAt) ||
    !(d.baseRevision === null || revision(d.baseRevision)) ||
    (d.taskId === null && d.baseRevision !== null) || (d.taskId !== null && d.baseRevision === null)) fail();
  // An edited task may have been removed by another tab; its draft remains recoverable.
  return { id: d.id, ownerId: d.ownerId, taskId: d.taskId, text: d.text, sectionId: d.sectionId,
    dueDate: d.dueDate, baseRevision: d.baseRevision, updatedAt: d.updatedAt };
}

/** Construct allowed properties explicitly; never merge untrusted backup objects. */
export function validatePayload(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.tasks) || payload.tasks.length > 10000 ||
    !Array.isArray(payload.sections) || payload.sections.length > 100 ||
    !(payload.drafts === undefined || (Array.isArray(payload.drafts) && payload.drafts.length <= 1000))) fail();
  const sectionIds = new Set();
  const sections = payload.sections.map(input => {
    const section = validateSection(input);
    if (sectionIds.has(section.id)) fail();
    sectionIds.add(section.id); return section;
  });
  const taskIds = new Set();
  const tasks = payload.tasks.map(input => {
    const task = validateTask(input, sectionIds);
    if (taskIds.has(task.id)) fail();
    taskIds.add(task.id); return task;
  });
  const draftIds = new Set();
  const drafts = (payload.drafts ?? []).map(input => {
    const draft = validateDraft(input, sectionIds);
    if (draftIds.has(draft.id)) fail();
    draftIds.add(draft.id); return draft;
  });
  const cycle = validateCycle(payload.cycle);
  const checkedPreferences = validatePreferences(payload.preferences, sectionIds);
  const preferences = payload.preferences.intervalBasis === undefined
    ? validatePreferences(migrateIntervalPreferences({ ...checkedPreferences, intervalBasis: undefined }, cycle), sectionIds)
    : checkedPreferences;
  return { tasks, sections, preferences, cycle, drafts };
}

export function parseBackup(raw) {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > MAX_BACKUP_BYTES) fail();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { fail(); }
  if (!isRecord(parsed) || parsed.format !== BACKUP_FORMAT ||
    ![1, 2, 3, BACKUP_SCHEMA].includes(parsed.schemaVersion) || !isStamp(parsed.exportedAt)) fail();
  if (parsed.schemaVersion === 1 && parsed.payload?.drafts !== undefined) fail();
  if (parsed.schemaVersion >= 2 && !Array.isArray(parsed.payload?.drafts)) fail();
  return { format: BACKUP_FORMAT, schemaVersion: BACKUP_SCHEMA, exportedAt: parsed.exportedAt,
    payload: validatePayload(parsed.payload) };
}

export function serializeBackup(payload, now = Date.now()) {
  if (!isStamp(now)) fail();
  const raw = JSON.stringify({ format: BACKUP_FORMAT, schemaVersion: BACKUP_SCHEMA,
    exportedAt: now, payload: validatePayload(payload) }, null, 2);
  if (new TextEncoder().encode(raw).byteLength > MAX_BACKUP_BYTES) {
    throw new RangeError('Копия больше 5 МиБ. Экспортируйте её до добавления новых записей.');
  }
  return raw;
}
