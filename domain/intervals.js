import { MINUTE } from './time.js';

export const isClockTime = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);

export function clockMinutes(value) {
  if (!isClockTime(value)) throw new TypeError('Укажите время в формате ЧЧ:ММ.');
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

export function formatClockMinutes(value) {
  const minutes = ((value % 1440) + 1440) % 1440;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function clockPieces(interval) {
  const start = clockMinutes(interval.startTime);
  const end = clockMinutes(interval.endTime);
  if (start === end) throw new RangeError('Начало и конец интервала должны различаться.');
  return end > start ? [[start, end]] : [[start, 1440], [0, end]].filter(([a, b]) => b > a);
}

/** Validate the repeating local-day template, including overlaps across midnight. */
export function validateClockIntervals(values) {
  if (!Array.isArray(values) || values.length > 48) throw new RangeError('Можно добавить не больше 48 интервалов.');
  const intervals = values.map(value => {
    if (!value || typeof value !== 'object' || typeof value.name !== 'string' || value.name.length > 80 ||
      typeof value.color !== 'string' || !/^#[\da-fA-F]{6}$/.test(value.color)) {
      throw new TypeError('Проверьте название и цвет интервала.');
    }
    const result = { name: value.name.trim(), startTime: value.startTime, endTime: value.endTime, color: value.color };
    clockPieces(result);
    return result;
  });
  const pieces = intervals.flatMap((interval, index) => clockPieces(interval).map(([start, end]) => ({ start, end, index })))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < pieces.length; index++) {
    if (pieces[index].start < pieces[index - 1].end) throw new RangeError('Цветные интервалы пересекаются. Измените время.');
  }
  return intervals;
}

/** Old offsets are preserved verbatim when there is no trustworthy saved start. */
export function migrateIntervalPreferences(preferences, cycle) {
  if (preferences.intervalBasis === 'clock' || preferences.intervalBasis === 'offset') return preferences;
  const legacy = preferences.intervals.map(interval => ({ ...interval }));
  if (!legacy.length) return { ...preferences, intervalBasis: 'clock', intervals: [] };
  if (!cycle || !Number.isSafeInteger(cycle.startAt)) return { ...preferences, intervalBasis: 'offset' };
  const local = timestamp => {
    const value = new Date(timestamp);
    return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
  };
  const converted = legacy.map(interval => ({ name: interval.name, color: interval.color,
    startTime: local(cycle.startAt + interval.startMinute * MINUTE),
    endTime: local(cycle.startAt + interval.endMinute * MINUTE) }));
  try {
    return { ...preferences, intervalBasis: 'clock', intervals: validateClockIntervals(converted), legacyIntervals: legacy };
  } catch {
    return { ...preferences, intervalBasis: 'offset' };
  }
}

/** Resolve wall-clock boundaries into real elapsed offsets, preserving partial hours. */
export function clockIntervalsForCycle(intervals, cycle) {
  if (!cycle) return [];
  const finish = cycle.startAt + cycle.durationMinutes * MINUTE;
  const date = new Date(cycle.startAt);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - 1);
  const ranges = [];
  for (let day = 0; day < 4; day++) {
    for (const interval of intervals) {
      const begin = new Date(date);
      const end = new Date(date);
      const startMinute = clockMinutes(interval.startTime);
      const endMinute = clockMinutes(interval.endTime);
      begin.setHours(Math.floor(startMinute / 60), startMinute % 60, 0, 0);
      end.setHours(Math.floor(endMinute / 60), endMinute % 60, 0, 0);
      if (endMinute <= startMinute) end.setDate(end.getDate() + 1);
      const from = Math.max(cycle.startAt, begin.getTime());
      const to = Math.min(finish, end.getTime());
      if (to > from) ranges.push({ ...interval, startMinute: (from - cycle.startAt) / MINUTE,
        endMinute: (to - cycle.startAt) / MINUTE });
    }
    date.setDate(date.getDate() + 1);
  }
  return ranges.sort((a, b) => a.startMinute - b.startMinute);
}
