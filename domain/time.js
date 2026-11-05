/** Pure domain logic: no timers, storage, DOM, network or timezone assumptions. */
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DEFAULT_DURATION = 960;

export function validateDuration(minutes) {
  if (!Number.isInteger(minutes) || minutes < 60 || minutes > 1440) {
    throw new RangeError('Длительность должна быть от 60 до 1440 минут.');
  }
  return minutes;
}

/** Create/correct a cycle. A future start is not a scheduled start in this product. */
export function makeCycle(startAt, durationMinutes = DEFAULT_DURATION, now = Date.now()) {
  validateDuration(durationMinutes);
  if (!Number.isSafeInteger(startAt) || startAt < 0 || !Number.isSafeInteger(now) || now < 0) {
    throw new TypeError('Некорректное время начала.');
  }
  if (startAt > now) throw new RangeError('Начало не может быть позже текущего времени.');
  return { startAt, durationMinutes };
}

export function validateStoppedAt(cycle) {
  if (cycle.stoppedAt === undefined || cycle.stoppedAt === null) return;
  if (!Number.isSafeInteger(cycle.stoppedAt) || cycle.stoppedAt < cycle.startAt) {
    throw new RangeError('Начало не может быть позже момента остановки.');
  }
}

export function stopCycleAt(cycle, now = Date.now()) {
  if (!cycle) throw new Error('Сначала запустите шкалу.');
  const state = scaleState(cycle, now);
  if (state.phase !== 'running') throw new Error('Шкала уже остановлена или завершена.');
  const next = { startAt: cycle.startAt, durationMinutes: cycle.durationMinutes, stoppedAt: now };
  validateStoppedAt(next);
  return next;
}

/**
 * The last partial dot has a capacity < 1. Its fill is measured in HOURS,
 * not stretched to pretend that a partial hour is a complete hour.
 * @param {{startAt:number,durationMinutes:number,stoppedAt?:number|null}|null} cycle
 * @param {number} now
 * @param {number} fallbackDuration
 */
export function scaleState(cycle, now = Date.now(), fallbackDuration = DEFAULT_DURATION) {
  const durationMinutes = validateDuration(cycle?.durationMinutes ?? fallbackDuration);
  if (!Number.isFinite(now)) throw new TypeError('Некорректное текущее время.');
  if (cycle && (!Number.isSafeInteger(cycle.startAt) || cycle.startAt < 0)) {
    throw new TypeError('Некорректное сохранённое начало.');
  }
  if (cycle) validateStoppedAt(cycle);
  const stopped = cycle?.stoppedAt !== undefined && cycle.stoppedAt !== null;
  const rawElapsed = cycle ? (stopped ? cycle.stoppedAt : now) - cycle.startAt : 0;
  const elapsedMs = Math.min(durationMinutes * MINUTE, Math.max(0, rawElapsed));
  const dots = Array.from({ length: Math.ceil(durationMinutes / 60) }, (_, index) => {
    const capacity = Math.min(60, durationMinutes - index * 60) / 60;
    const fill = Math.max(0, Math.min(capacity, elapsedMs / HOUR - index));
    return { index, capacity, fill };
  });
  return {
    phase: !cycle ? 'idle' : rawElapsed >= durationMinutes * MINUTE ? 'complete' : stopped ? 'stopped' : 'running',
    durationMinutes,
    elapsedMs,
    clockBeforeStart: Boolean(cycle && now < cycle.startAt),
    dots,
  };
}
