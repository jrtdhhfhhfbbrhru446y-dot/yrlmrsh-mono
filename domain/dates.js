/** Calendar keys are local dates, never toISOString().slice(0, 10). */
export function localDateKey(date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new TypeError('Некорректная дата.');
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function isDateKey(key) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const [year, month, day] = key.split('-').map(Number);
  if (year < 1900 || year > 2199) return false;
  const parsed = new Date(year, month - 1, day, 12);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
}
export function displayDate(key) {
  if (!isDateKey(key)) throw new TypeError('Некорректная календарная дата.');
  const [year, month, day] = key.split('-');
  return `${day}.${month}.${year.slice(-2)}`;
}
export function dateTimeInputValue(timestamp = Date.now()) {
  const date = new Date(timestamp);
  return `${localDateKey(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
export function groupActiveTasks(tasks) {
  const groups = new Map();
  for (const task of tasks.filter(t => t.status === 'active')) {
    const key = task.dueDate ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a === '' ? 1 : b === '' ? -1 : a.localeCompare(b))
    .map(([date, items]) => ({
      date: date || null,
      tasks: items.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
    }));
}
