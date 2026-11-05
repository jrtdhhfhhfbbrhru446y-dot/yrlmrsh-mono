import { MINUTE, makeCycle, scaleState, validateDuration, validateStoppedAt } from '../domain/time.js';
import { dateTimeInputValue, localDateKey, displayDate } from '../domain/dates.js';
import { clockIntervalsForCycle, validateClockIntervals } from '../domain/intervals.js';
import { positionScale, attachAppViewport } from './viewport.js';

const PALETTE = [
  { color: '#526D82', name: 'Синий' },
  { color: '#61755B', name: 'Зелёный' },
  { color: '#91733F', name: 'Охра' },
  { color: '#856478', name: 'Сиреневый' },
  { color: '#A46356', name: 'Терракотовый' },
];
let nextScaleId = 0;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function svgNode(tag, attributes = {}) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

/** The time template is resolved against the actual start, never rounded to hours. */
export function dotSegments(dot, preferences, cycle = null) {
  const start = dot.index * 60;
  const end = start + dot.capacity * 60;
  const intervals = !preferences.colorsEnabled ? [] : preferences.intervalBasis === 'clock'
    ? clockIntervalsForCycle(preferences.intervals, cycle) : preferences.intervals;
  const boundaries = new Set([start, end]);
  for (const interval of intervals) {
    if (interval.endMinute > start && interval.startMinute < end) {
      boundaries.add(Math.max(start, interval.startMinute));
      boundaries.add(Math.min(end, interval.endMinute));
    }
  }
  const sorted = [...boundaries].sort((a, b) => a - b);
  return sorted.slice(0, -1).map((begin, index) => {
    const finish = sorted[index + 1];
    const interval = intervals.find(item => item.startMinute <= begin && item.endMinute >= finish);
    const from = (begin - start) / 60;
    const to = (finish - start) / 60;
    return { from, to, fillTo: Math.min(to, Math.max(from, dot.fill)), color: interval?.color ?? 'var(--text)' };
  });
}

function bandClip(definitions, id, from, to) {
  const clip = svgNode('clipPath', { id });
  clip.append(svgNode('rect', { x: 0, y: 12 * (1 - to), width: 12, height: (to - from) * 12 }));
  definitions.append(clip);
  return `url(#${id})`;
}

export function renderScale(container, snapshot, now = Date.now()) {
  const state = scaleState(snapshot.cycle, now, snapshot.preferences.defaultDurationMinutes);
  let dots = container.querySelector('.time-dots');
  let button = container.querySelector('.start-cycle');
  if (!dots) { dots = node('div', 'time-dots'); container.append(dots); }
  if (!button) {
    button = node('button', 'start-cycle'); button.type = 'button';
    const mark = node('span'); mark.setAttribute('aria-hidden', 'true'); button.append(mark); container.append(button);
  }
  container.querySelector('.scale-complete')?.remove();
  dots.setAttribute('role', 'img');
  const elapsedMinutes = Math.floor(state.elapsedMs / MINUTE);
  dots.setAttribute('aria-label', !snapshot.cycle ? 'Отсчёт не начат' : state.phase === 'complete'
    ? 'Выбранный период завершён' : `Прошло ${elapsedMinutes} минут из ${state.durationMinutes}`);
  const prefix = `scale-${++nextScaleId}`;
  const elements = state.dots.map(dot => {
    const svg = svgNode('svg', { viewBox: '0 0 12 12', class: 'time-dot', 'aria-hidden': 'true' });
    const definitions = svgNode('defs'); svg.append(definitions);
    const outline = bandClip(definitions, `${prefix}-${dot.index}-capacity`, 0, dot.capacity);
    svg.append(svgNode('circle', { cx: 6, cy: 6, r: 5, fill: 'var(--background)', stroke: 'var(--dot-outline)',
      'stroke-width': 1, 'clip-path': outline }));
    for (const [index, segment] of dotSegments(dot, snapshot.preferences, snapshot.cycle).entries()) {
      if (segment.fillTo > segment.from) {
        const fillClip = bandClip(definitions, `${prefix}-${dot.index}-${index}-fill`, segment.from, segment.fillTo);
        const darkColor = /^#[\da-fA-F]{6}$/.test(segment.color) &&
          [1, 3, 5].every(position => parseInt(segment.color.slice(position, position + 2), 16) < 48);
        svg.append(svgNode('circle', { cx: 6, cy: 6, r: 5, fill: segment.color,
          ...(darkColor ? { stroke: 'var(--text)', 'stroke-width': 0.6 } : {}), 'clip-path': fillClip }));
      }
    }
    return svg;
  });
  dots.replaceChildren(...elements);
  button.hidden = false;
  button.classList.toggle('is-running', state.phase === 'running');
  button.classList.toggle('is-stopped', state.phase === 'stopped');
  button.classList.toggle('is-complete', state.phase === 'complete');
  button.setAttribute('aria-label', state.phase === 'running' ? 'Остановить шкалу'
    : ['stopped', 'complete'].includes(state.phase) ? 'Начать шкалу заново' : 'Запустить шкалу');
  container.dataset.scalePhase = state.phase;
  container.dataset.dotCount = String(state.dots.length);
  updateScaleViewport(container);
  return state;
}

function updateScaleViewport(container) { positionScale(container); }

export function attachScaleViewport(container) {
  return attachAppViewport(container);
}

/** Pointer releases act once; their compatibility click cannot reach a new dialog. */
export function bindScaleStart(button, { onStart, onManualStart, reportError = () => {} }) {
  let timer;
  let gesture;
  let blockedClick;
  const document = button.ownerDocument;
  const window = document.defaultView;
  const cancelTimer = () => { clearTimeout(timer); timer = undefined; };
  const invoke = callback => { Promise.resolve().then(callback).catch(reportError); };
  const blockRelease = id => { blockedClick = { id, until: Date.now() + 800 }; };
  const releaseCapture = id => {
    try { if (button.hasPointerCapture?.(id)) button.releasePointerCapture(id); } catch { /* An ended pointer has no capture. */ }
  };
  const cancel = () => {
    cancelTimer();
    if (gesture) { blockRelease(gesture.id); const id = gesture.id; gesture = null; releaseCapture(id); }
  };
  const down = event => {
    if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    cancel(); blockedClick = null;
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY };
    try { button.setPointerCapture?.(event.pointerId); } catch { /* Document listeners still receive the release. */ }
    timer = setTimeout(() => {
      if (!gesture) return;
      gesture.long = true; blockRelease(gesture.id); invoke(onManualStart);
    }, 500);
  };
  const otherDown = event => {
    if (!gesture) blockedClick = null;
    else if (gesture.id !== event.pointerId) cancel();
  };
  const move = event => {
    if (gesture?.id === event.pointerId && !gesture.long && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 10) {
      cancel();
    }
  };
  const up = event => {
    if (gesture?.id !== event.pointerId) return;
    const current = gesture;
    cancelTimer(); gesture = null; blockRelease(current.id); releaseCapture(current.id);
    const bounds = button.getBoundingClientRect();
    if (!current.long && event.clientX >= bounds.left && event.clientX <= bounds.right &&
      event.clientY >= bounds.top && event.clientY <= bounds.bottom) invoke(onStart);
  };
  const pointerCancel = event => { if (gesture?.id === event.pointerId) cancel(); };
  const leave = event => { if (gesture?.id === event.pointerId && !gesture.long && !button.hasPointerCapture?.(event.pointerId)) cancel(); };
  const captureLost = event => { if (gesture?.id === event.pointerId && !gesture.long) cancel(); };
  const consumeClick = event => {
    if (!blockedClick || Date.now() > blockedClick.until) { blockedClick = null; return; }
    // Keyboard/assistive activation has no pointing device and remains available.
    if (event.detail === 0 && !event.pointerType) return;
    if (event.pointerId !== undefined && event.pointerId > 0 && event.pointerId !== blockedClick.id) return;
    event.preventDefault(); event.stopImmediatePropagation(); blockedClick = null;
  };
  const click = event => {
    if (!event.defaultPrevented && !gesture && event.detail === 0 && !event.pointerType) invoke(onStart);
  };
  const context = event => { event.preventDefault(); };
  const hidden = () => { if (document.hidden) cancel(); };
  button.addEventListener('pointerdown', down);
  button.addEventListener('pointerleave', leave);
  button.addEventListener('lostpointercapture', captureLost);
  button.addEventListener('contextmenu', context);
  button.addEventListener('click', click);
  document.addEventListener('pointerdown', otherDown, true);
  document.addEventListener('pointermove', move, true);
  document.addEventListener('pointerup', up, true);
  document.addEventListener('pointercancel', pointerCancel, true);
  document.addEventListener('click', consumeClick, true);
  document.addEventListener('visibilitychange', hidden);
  window.addEventListener('blur', cancel);
  window.addEventListener('pagehide', cancel);
  return () => {
    cancel(); blockedClick = null;
    button.removeEventListener('pointerdown', down);
    button.removeEventListener('pointerleave', leave); button.removeEventListener('lostpointercapture', captureLost);
    button.removeEventListener('contextmenu', context);
    button.removeEventListener('click', click);
    document.removeEventListener('pointerdown', otherDown, true); document.removeEventListener('pointermove', move, true);
    document.removeEventListener('pointerup', up, true); document.removeEventListener('pointercancel', pointerCancel, true);
    document.removeEventListener('click', consumeClick, true); document.removeEventListener('visibilitychange', hidden);
    window.removeEventListener('blur', cancel); window.removeEventListener('pagehide', cancel);
  };
}

function input(type, value, attributes = {}) {
  const element = node('input', 'form-field'); element.type = type; element.value = String(value);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  return element;
}

function action(text, handler, className = 'text-action') {
  const button = node('button', className, text); button.type = 'button'; button.addEventListener('click', handler); return button;
}

function field(labelText, control) {
  const row = node('div', 'scale-field');
  const label = node('label', 'scale-field-label', labelText);
  control.id ||= `scale-field-${++nextScaleId}`;
  label.htmlFor = control.id;
  const area = node('div', 'scale-control'); area.append(control);
  const error = node('p', 'field-error'); error.hidden = true; error.setAttribute('role', 'alert');
  error.id = `${control.id}-error`; control.setAttribute('aria-describedby', error.id);
  row.append(label, area, error);
  return { row, area, error, control };
}

function readDateTime(element, message) {
  const value = new Date(element.value).getTime();
  if (!Number.isSafeInteger(value) || dateTimeInputValue(value) !== element.value) throw new TypeError(message);
  return value;
}

function dayLabel(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  const today = new Date();
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const key = localDateKey(date);
  return key === localDateKey(today) ? 'Сегодня' : key === localDateKey(tomorrow) ? 'Завтра'
    : key === localDateKey(yesterday) ? 'Вчера' : displayDate(key);
}

/** One local editor; callbacks confirm only committed, atomic scale changes. */
export function buildScaleSettings({ snapshot, onSave, onStart, onStop, onRestart, onClose = () => {}, reportError = () => {} }) {
  const root = node('form', 'scale-settings'); root.noValidate = true;
  const cycle = snapshot.cycle;
  const preferences = snapshot.preferences;
  const phase = scaleState(cycle).phase;
  root.append(node('p', 'support-text scale-status', ({ idle: 'Не запущена', running: 'Работает', stopped: 'Остановлена', complete: 'Завершена' })[phase]));
  const baseStart = cycle?.startAt ?? Date.now();
  const originalStart = dateTimeInputValue(baseStart);
  const start = input('datetime-local', originalStart, { step: 60 }); start.id = 'scale-start-time';
  const startField = field('Начало', start);
  const startDay = node('span', 'scale-day-label', dayLabel(baseStart)); startField.area.append(startDay);
  start.addEventListener('input', () => { startDay.textContent = dayLabel(new Date(start.value).getTime()); });
  root.append(startField.row);

  const lengthGroup = node('div', 'scale-length');
  const modes = node('div', 'scale-mode'); modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', 'Длина шкалы');
  let endMode = false;
  const durationModeButton = action('Длительность', () => setMode(false));
  const endModeButton = action('До времени', () => setMode(true));
  modes.append(durationModeButton, endModeButton); lengthGroup.append(modes);
  const duration = input('number', (cycle?.durationMinutes ?? preferences.defaultDurationMinutes) / 60,
    { min: 1, max: 24, step: 0.25, inputmode: 'decimal' }); duration.id = 'scale-duration';
  const durationField = field('Часов', duration); durationField.row.classList.add('scale-duration-field');
  const end = input('datetime-local', dateTimeInputValue(baseStart + Number(duration.value) * 60 * MINUTE), { step: 60 });
  end.id = 'scale-end-time';
  const endField = field('До', end); endField.row.classList.add('scale-end-field');
  const endDay = node('span', 'scale-day-label'); endField.area.append(endDay);
  end.addEventListener('input', () => { endDay.textContent = dayLabel(new Date(end.value).getTime()); });
  lengthGroup.append(durationField.row, endField.row); root.append(lengthGroup);
  function setMode(next) {
    if (next && !endMode) {
      const shownStart = new Date(start.value).getTime();
      const minutes = Number(duration.value) * 60;
      if (Number.isFinite(shownStart) && minutes >= 60 && minutes <= 1440) end.value = dateTimeInputValue(shownStart + minutes * MINUTE);
    }
    if (!next && endMode) {
      const minutes = (new Date(end.value).getTime() - new Date(start.value).getTime()) / MINUTE;
      if (Number.isInteger(minutes) && minutes >= 60 && minutes <= 1440) duration.value = String(minutes / 60);
    }
    endMode = next; durationField.row.hidden = next; endField.row.hidden = !next;
    durationModeButton.setAttribute('aria-pressed', String(!next)); endModeButton.setAttribute('aria-pressed', String(next));
    endDay.textContent = dayLabel(new Date(end.value).getTime());
  }
  setMode(false);

  const colors = node('div', 'scale-colors');
  const enabled = input('checkbox', 'enabled'); enabled.checked = preferences.colorsEnabled; enabled.id = 'scale-colors-enabled';
  const colorLabel = node('label', 'checkbox-label'); colorLabel.append(enabled, document.createTextNode('Цветные интервалы'));
  colors.append(colorLabel);
  const unresolved = preferences.intervalBasis !== 'clock' && preferences.intervals.length > 0;
  if (unresolved) colors.append(node('p', 'support-text legacy-interval-note',
    'Старые интервалы сохранены. Уточните время суток каждого интервала перед сохранением.'));
  const items = preferences.intervals.map(interval => ({ name: interval.name, color: interval.color,
    startTime: unresolved ? '' : interval.startTime, endTime: unresolved ? '' : interval.endTime,
    legacy: unresolved ? { ...interval } : null }));
  const list = node('div', 'interval-list');
  const intervalError = node('p', 'field-error'); intervalError.hidden = true; intervalError.setAttribute('role', 'alert');
  let editing = null;
  function showList() {
    const rows = items.map(item => {
      const summary = action('', () => editInterval(item), 'scale-interval-summary');
      const swatch = node('span', 'interval-swatch'); swatch.style.setProperty('--swatch', item.color); swatch.setAttribute('aria-hidden', 'true');
      const range = item.startTime && item.endTime ? `${item.startTime}–${item.endTime}` : 'Уточнить время';
      summary.append(swatch, node('span', '', `${item.name ? `${item.name} · ` : ''}${range}`));
      if (item === editing) summary.setAttribute('aria-expanded', 'true');
      return summary;
    });
    list.replaceChildren(...rows);
  }
  const editor = node('div', 'interval-editor'); editor.hidden = true;
  function editInterval(item) {
    editing = item; showList(); editor.replaceChildren(); editor.hidden = false;
    const name = input('text', item.name, { maxlength: 80 });
    const begin = input('time', item.startTime, { step: 60 });
    const finish = input('time', item.endTime, { step: 60 });
    const fields = node('div', 'interval-fields');
    fields.append(field('Название', name).row, field('С', begin).row, field('До', finish).row);
    const changed = () => { item.name = name.value; item.startTime = begin.value; item.endTime = finish.value; showList(); };
    for (const control of [name, begin, finish]) control.addEventListener('input', changed);
    const palette = node('div', 'color-palette'); palette.setAttribute('role', 'group'); palette.setAttribute('aria-label', 'Цвет интервала');
    const choices = PALETTE.some(color => color.color.toLowerCase() === item.color.toLowerCase()) ? PALETTE
      : [...PALETTE, { color: item.color, name: 'Сохранённый цвет' }];
    for (const color of choices) {
      const button = action('', () => {
        item.color = color.color; showList();
        for (const option of palette.querySelectorAll('button')) option.setAttribute('aria-pressed', String(option === button));
      }, 'color-choice');
      button.setAttribute('aria-label', color.name); button.title = color.name;
      button.style.setProperty('--swatch', color.color); button.setAttribute('aria-pressed', String(item.color.toLowerCase() === color.color.toLowerCase()));
      palette.append(button);
    }
    const actions = node('div', 'interval-editor-actions');
    actions.append(action('Готово', () => { editing = null; editor.hidden = true; showList(); }),
      action('Удалить', () => { items.splice(items.indexOf(item), 1); editing = null; editor.hidden = true; showList(); }));
    editor.append(fields, palette, actions); name.focus();
  }
  showList();
  const add = action('Добавить интервал', () => {
    if (items.length >= 48) { intervalError.textContent = 'Можно добавить не больше 48 интервалов.'; intervalError.hidden = false; return; }
    const item = { name: '', startTime: '', endTime: '', color: PALETTE[0].color, legacy: null };
    items.push(item); editInterval(item);
  });
  colors.append(list, editor, add, intervalError); root.append(colors);
  const error = node('p', 'field-error'); error.setAttribute('role', 'alert'); error.hidden = true;
  const actions = node('div', 'scale-editor-actions');
  const save = node('button', 'text-action scale-primary', 'Сохранить');
  save.type = 'submit'; save.id = 'save-scale'; actions.append(save);
  if (!cycle) {
    const launch = action('Запустить', () => run('start'), 'text-action scale-secondary');
    launch.id = 'launch-scale'; actions.append(launch);
  } else {
    if (phase === 'running') {
      const stop = action('Остановить', () => run('stop'), 'text-action scale-secondary');
      stop.id = 'stop-scale'; actions.append(stop);
    }
    const restart = action('Начать заново', () => run('restart'), 'text-action scale-secondary');
    restart.id = 'restart-scale'; actions.append(restart);
  }
  root.append(error, actions);
  let busy = false;
  function clearErrors() {
    for (const item of [startField, durationField, endField]) { item.error.hidden = true; item.control.removeAttribute('aria-invalid'); }
    intervalError.hidden = true; error.hidden = true;
  }
  function invalid(item, reason) {
    item.error.textContent = reason.message; item.error.hidden = false; item.control.setAttribute('aria-invalid', 'true'); item.control.focus();
  }
  function readConfig(intent) {
    const now = Date.now();
    const restart = intent === 'restart';
    let chosenStart;
    try {
      chosenStart = start.value === originalStart ? baseStart : readDateTime(start, 'Укажите дату и время начала.');
      if (!restart && chosenStart > now) throw new RangeError('Начало не может быть позже текущего времени.');
      if (intent === 'save' && cycle?.stoppedAt !== undefined && cycle.stoppedAt !== null && chosenStart > cycle.stoppedAt) {
        throw new RangeError('Начало не может быть позже момента остановки.');
      }
    } catch (reason) { invalid(startField, reason); return null; }
    let minutes;
    try {
      if (!endMode) minutes = Number(duration.value) * 60;
      else {
        const finish = readDateTime(end, 'Укажите дату и время окончания.');
        if (['start', 'restart'].includes(intent) && finish <= now) throw new RangeError('Окончание уже прошло. Выберите новое время окончания.');
        minutes = (finish - Math.floor((restart ? now : chosenStart) / MINUTE) * MINUTE) / MINUTE;
        if (minutes <= 0) throw new RangeError('Окончание должно быть позже начала. Выберите день окончания.');
      }
      validateDuration(minutes);
      if (['start', 'restart'].includes(intent) && (restart ? now : chosenStart) + minutes * MINUTE <= now) {
        throw new RangeError('Окончание уже прошло. Выберите новое время начала или длительность.');
      }
    } catch (reason) { invalid(endMode ? endField : durationField, reason); return null; }
    let intervals;
    try { intervals = validateClockIntervals(items); }
    catch (reason) { intervalError.textContent = reason.message; intervalError.hidden = false; return null; }
    const nextPreferences = { defaultDurationMinutes: minutes, colorsEnabled: enabled.checked, intervalBasis: 'clock', intervals };
    if (preferences.legacyIntervals || unresolved) nextPreferences.legacyIntervals = preferences.legacyIntervals ?? preferences.intervals.map(item => ({ ...item }));
    let nextCycle = !cycle && intent === 'save' ? null : makeCycle(restart ? now : chosenStart, minutes, now);
    if (nextCycle && intent === 'save' && cycle?.stoppedAt !== undefined) nextCycle.stoppedAt = cycle.stoppedAt;
    if (nextCycle && intent === 'stop') nextCycle.stoppedAt = now;
    if (nextCycle) validateStoppedAt(nextCycle);
    return { cycle: nextCycle, preferences: nextPreferences, action: intent };
  }
  async function run(intent) {
    if (busy) return;
    clearErrors();
    const config = readConfig(intent);
    if (!config) return;
    busy = true;
    const controls = [...root.querySelectorAll('button, input')]; controls.forEach(control => { control.disabled = true; });
    try {
      const callback = ({ save: onSave, start: onStart, stop: onStop, restart: onRestart })[intent];
      const result = await callback(config, cycle);
      if (result !== false) onClose();
      else { error.textContent = 'Не удалось сохранить шкалу. Изменения остались в редакторе.'; error.hidden = false; }
    } catch (reason) {
      error.textContent = reason instanceof Error ? reason.message : 'Не удалось сохранить шкалу. Изменения остались в редакторе.';
      error.hidden = false; reportError(reason);
    } finally { busy = false; controls.forEach(control => { control.disabled = false; }); }
  }
  root.addEventListener('submit', event => { event.preventDefault(); run('save'); });
  return root;
}
