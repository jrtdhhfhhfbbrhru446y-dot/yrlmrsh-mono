import * as repository from '../storage/db.js';
import { localDateKey, displayDate, groupActiveTasks } from '../domain/dates.js';
import { uniqueId } from '../domain/ids.js';
import { element, button, field, input, sectionSelect } from './dom.js';
import { bindSwipe } from './swipe.js';

/** A single inline editor survives refreshes; committed tasks and drafts use separate records. */
export function createTaskUI({ getSnapshot, getView, mutate, refresh, reportError, notify, ownerId }) {
  const groups = document.querySelector('#task-groups');
  const completed = document.querySelector('#completed');
  const completedList = document.querySelector('#completed-list');
  let editor = null;
  let draftQueue = Promise.resolve();
  let draftFailure = null;
  let pendingDrafts = 0;
  let chosenDate;
  let lastDraftStamp = 0;
  let restoring = false;
  let owners;
  const ownerQueries = new Map();
  try { if ('BroadcastChannel' in globalThis) owners = new BroadcastChannel('mono-task-draft-owners'); }
  catch { /* Foreign drafts stay explicitly recoverable when tab detection is unavailable. */ }
  owners?.addEventListener('message', event => {
    const message = event.data;
    if (message?.type === 'query' && message.ownerId === ownerId) {
      owners.postMessage({ type: 'present', ownerId, queryId: message.queryId });
    } else if (message?.type === 'present') {
      const pending = ownerQueries.get(message.queryId);
      if (pending?.ownerId === message.ownerId) { clearTimeout(pending.timer); ownerQueries.delete(message.queryId); pending.resolve(true); }
    }
  });
  function ownerIsLive(id) {
    if (!owners) return Promise.resolve(true);
    const queryId = uniqueId();
    return new Promise(resolve => {
      const timer = setTimeout(() => { ownerQueries.delete(queryId); resolve(false); }, 500);
      ownerQueries.set(queryId, { ownerId: id, resolve, timer });
      owners.postMessage({ type: 'query', ownerId: id, queryId });
    });
  }

  const matching = task => {
    const view = getView();
    return view === 'all' || view === 'completed' || view === 'trash' ||
      (view === 'none' ? task.sectionId === null : task.sectionId === view);
  };
  const defaultSection = () => ['all', 'none', 'completed', 'trash'].includes(getView()) ? null : getView();
  const draftMatches = draft => matching(draft) && Boolean(draft.text.trim());
  const draftTask = draft => draft.taskId ? getSnapshot().tasks.find(task => task.id === draft.taskId) : null;
  const contextualDrafts = () => (getSnapshot().drafts ?? []).filter(draft => {
    if (!draftMatches(draft) || draft.id === editor?.id) return false;
    const task = draftTask(draft);
    const view = getView();
    if (view === 'trash') return false;
    if (view === 'completed') return task?.status === 'completed';
    return !task || task.status === 'active' || task.status === 'deleted' || (task.status === 'completed' && completed.open);
  }).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));

  function draftRecord(current) {
    return { id: current.id, ownerId, taskId: current.task?.id ?? null,
      text: current.text.value, sectionId: current.section.value || null,
      dueDate: current.date.value || null, baseRevision: current.baseRevision,
      updatedAt: (lastDraftStamp = Math.max(Date.now(), lastDraftStamp + 1)) };
  }
  function saveDraft(current = editor) {
    if (!current) return draftQueue;
    const draft = draftRecord(current);
    pendingDrafts++;
    draftQueue = draftQueue.then(async () => {
      try {
        if (current.task || draft.text.trim() || current.persisted) {
          await repository.saveDraft(draft);
          current.persisted = true;
          current.persistedStamp = draft.updatedAt;
        }
        draftFailure = null;
      } catch (error) {
        draftFailure = error;
        current.error.textContent = 'Черновик пока не сохранён. ' + error.message;
        current.error.hidden = false;
      } finally { pendingDrafts--; }
    });
    return draftQueue;
  }
  async function flushDrafts() {
    if (editor) await saveDraft();
    await draftQueue;
    if (draftFailure) throw draftFailure;
  }
  async function prepareReload() {
    const controls = [...document.querySelectorAll('input,select,textarea,button')];
    const disabled = controls.map(control => control.disabled);
    controls.forEach(control => { control.disabled = true; });
    try { await flushDrafts(); return true; }
    catch (error) { controls.forEach((control, index) => { control.disabled = disabled[index]; }); throw error; }
  }
  function fitTextarea(current) {
    current.text.style.height = 'auto';
    current.text.style.height = `${current.text.scrollHeight}px`;
  }
  function focusEditor() {
    if (!editor) return;
    editor.text.focus({ preventScroll: true });
    fitTextarea(editor);
    editor.node.scrollIntoView({ block: 'nearest' });
  }
  async function suspend() {
    if (!editor) return;
    const current = editor;
    await flushDrafts();
    if (!current.task && !current.text.value.trim() && current.persisted) {
      await repository.deleteDraft(current.id, ownerId, current.persistedStamp);
    }
    editor = null;
  }

  async function openEditor(task = null, date = localDateKey(), recovered = null, { focus = true, sectionId } = {}) {
    if (editor && !(await mutate(async () => { await suspend(); }))) return false;
    lastDraftStamp = Math.max(lastDraftStamp, recovered?.updatedAt ?? 0);
    const current = { id: recovered?.id ?? uniqueId(), task,
      dateContext: recovered?.dueDate ?? date, saving: false, persisted: Boolean(recovered),
      persistedStamp: recovered?.updatedAt,
      baseRevision: task ? (recovered?.baseRevision ?? task.revision) : null };
    const form = element('form', 'inline-editor');
    form.autocomplete = 'off';
    form.noValidate = true;
    current.node = form;
    const bullet = element('span', 'input-bullet', '•');
    bullet.setAttribute('aria-hidden', 'true');
    const body = element('div', 'editor-body');
    current.text = element('textarea', 'task-input');
    current.text.rows = 1;
    current.text.placeholder = 'Добавить задачу';
    current.text.setAttribute('aria-label', task ? 'Текст задачи' : 'Новая задача');
    current.text.value = recovered?.text ?? task?.text ?? '';
    const parameters = element('details', 'editor-parameters');
    parameters.append(element('summary', '', 'Дата и раздел'));
    current.date = input('date', (recovered ? recovered.dueDate : task ? task.dueDate : date) ?? '');
    current.date.min = '1900-01-01'; current.date.max = '2199-12-31';
    current.section = sectionSelect(getSnapshot().sections, recovered ? recovered.sectionId : task ? task.sectionId : sectionId === undefined ? defaultSection() : sectionId);
    parameters.append(field('Дата', current.date), button('Без даты', () => {
      current.date.value = '';
      if (!current.task) { current.dateContext = null; render(); }
      saveDraft(current);
    }), field('Раздел', current.section));
    const actions = element('div', 'editor-actions');
    const submit = element('button', 'text-action', 'Сохранить'); submit.type = 'submit';
    const quickSubmit = element('button'); quickSubmit.type = 'submit'; quickSubmit.hidden = true;
    const cancel = button('Отмена', async () => {
      if (current.saving) return;
      await draftQueue;
      if (await mutate(async () => { if (current.persisted) await repository.deleteDraft(current.id, ownerId, current.persistedStamp); })) {
        editor = null; await refresh();
        if (task) document.querySelector(`[data-task-id="${CSS.escape(task.id)}"] .task-content`)?.focus({ preventScroll: true });
        else groups.querySelector('.add-task')?.focus({ preventScroll: true });
      }
    });
    actions.append(submit, cancel, quickSubmit);
    if (task) actions.append(button('В корзину', async () => {
      if (current.saving) return;
      await draftQueue;
      if (current.text.value !== task.text && !confirm('Изменения текста не будут применены. Переместить задачу в корзину?')) return;
      let updated;
      if (await mutate(async () => {
        updated = await repository.trashTask(task.id, task.revision, { draftId: current.id, draftOwnerId: ownerId,
          expectedDraftUpdatedAt: current.persistedStamp, expectedTask: task });
        editor = null;
      })) notify('Удалено', () => mutate(() => repository.undoTask(task.id, updated.revision, task, Date.now(), { expectedTask: updated })));
    }));
    current.error = element('p', 'field-error'); current.error.setAttribute('role', 'alert'); current.error.hidden = true;
    body.append(current.text, parameters, actions, current.error);
    form.append(bullet, body);
    current.text.addEventListener('input', () => {
      fitTextarea(current);
      current.error.hidden = true;
      if (current.text.value.length > 10000) {
        current.error.textContent = 'В задаче может быть не больше 10 000 символов.'; current.error.hidden = false;
      } else saveDraft(current);
    });
    current.text.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); form.requestSubmit(quickSubmit); }
      if (event.key === 'Escape') { event.preventDefault(); cancel.click(); }
    });
    for (const control of [current.date, current.section]) control.addEventListener('change', () => {
      if (!current.task && control === current.date) { current.dateContext = current.date.value || null; render(); }
      saveDraft(current);
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const text = current.text.value.trim();
      const quick = event.submitter === quickSubmit;
      if (current.saving || (quick && !text)) return;
      if (text.length > 10000) { current.error.textContent = 'В задаче может быть не больше 10 000 символов.'; current.error.hidden = false; return; }
      if (text && !form.reportValidity()) return;
      current.saving = true;
      const controls = [...form.querySelectorAll('input,select,textarea,button')];
      controls.forEach(control => { control.disabled = true; });
      await draftQueue;
      const patch = { text, sectionId: current.section.value || null, dueDate: current.date.value || null };
      const options = { ...(current.persisted ? { draftId: current.id, draftOwnerId: ownerId,
        expectedDraftUpdatedAt: current.persistedStamp } : {}), expectedTask: current.task ?? undefined };
      const saved = await mutate(async () => {
        if (!text) {
          if (current.persisted) await repository.deleteDraft(current.id, ownerId, current.persistedStamp);
        } else if (current.task) await repository.updateTask(current.task.id, patch, current.task.revision, options);
        else {
          const now = Date.now();
          await repository.addTask({ id: uniqueId(), ...patch, status: 'active', previousStatus: null,
            order: now, createdAt: now, updatedAt: now, completedAt: null, deletedAt: null, revision: 1 }, options);
        }
        editor = null;
        draftFailure = null;
      });
      current.saving = false; controls.forEach(control => { control.disabled = false; });
      if (saved) {
        if (quick && !current.task) await openEditor(null, patch.dueDate, null, { sectionId: patch.sectionId });
        else {
          if (!text && current.task) notify('Пустые изменения не сохранены');
          if (current.task) document.querySelector(`[data-task-id="${CSS.escape(current.task.id)}"] .task-content`)?.focus({ preventScroll: true });
          else groups.querySelector('.add-task')?.focus({ preventScroll: true });
        }
      } else {
        current.error.textContent = 'Не удалось сохранить. Текст остался в редакторе. Проверьте сообщение и попробуйте ещё раз.';
        current.error.hidden = false;
      }
    });
    editor = current;
    await saveDraft(current);
    render();
    requestAnimationFrame(() => {
      if (editor !== current) return;
      fitTextarea(current);
      if (focus) focusEditor();
    });
    return !draftFailure;
  }

  async function changeStatus(task) {
    const next = task.status === 'completed' ? 'active' : 'completed';
    let updated;
    if (await mutate(async () => { updated = await repository.setTaskStatus(task.id, next, task.revision, { expectedTask: task }); })) {
      notify(next === 'completed' ? 'Выполнено' : 'Восстановлено', () => mutate(() => repository.undoTask(task.id, updated.revision, task, Date.now(), { expectedTask: updated })));
    }
  }
  function taskRow(task) {
    if (editor?.task?.id === task.id) {
      const row = element('li', 'editor-row'); row.append(editor.node); return row;
    }
    const row = element('li', `task-row${task.status === 'completed' || task.previousStatus === 'completed' ? ' is-completed' : ''}`);
    row.dataset.taskId = task.id;
    const toggle = button('•', () => task.status === 'deleted' ? restore(task) : changeStatus(task), 'task-toggle');
    toggle.setAttribute('aria-label', `${task.status === 'active' ? 'Выполнить' : 'Восстановить'} задачу: ${task.text}`);
    const content = button('', () => {}, 'task-content');
    content.setAttribute('aria-label', `Редактировать задачу: ${task.text}`);
    const text = element('span', 'task-text', task.text); content.append(text);
    row.append(toggle, content);
    if (task.status === 'active') bindSwipe(row, text, { onComplete: () => changeStatus(task), onOpen: () => openEditor(task, task.dueDate), reportError });
    else if (task.status === 'completed') content.addEventListener('click', () => openEditor(task, task.dueDate));
    else {
      content.disabled = true;
      const actions = element('div', 'trash-actions');
      actions.append(button('Восстановить', () => restore(task)), button('Удалить навсегда', async () => {
        if (!confirm('Удалить без возможности восстановления из приложения?')) return;
        await mutate(() => repository.deleteTask(task.id, task.revision, { expectedTask: task }));
      })); row.append(actions);
    }
    return row;
  }
  async function restore(task) {
    await mutate(() => repository.restoreTask(task.id, task.revision, { expectedTask: task }));
  }
  async function changeGroupDate(records, date, heading, creating) {
    if (date !== null && !date) return;
    const position = heading.getBoundingClientRect().top;
    const container = heading.closest('#task-groups, #completed-list');
    let updated;
    const success = await mutate(async () => {
      await flushDrafts();
      updated = await repository.changeTaskDates(records, date);
      const changed = updated.find(task => task.id === editor?.task?.id);
      if (changed) {
        if ((editor.date.value || null) === editor.task.dueDate) editor.date.value = date ?? '';
        editor.task = changed; editor.baseRevision = changed.revision; editor.dateContext = date;
      } else if (creating && editor && !editor.task && !editor.text.value.trim() && editor.dateContext === records[0].dueDate) {
        editor.dateContext = date; editor.date.value = date ?? '';
      }
    });
    if (!success) return;
    if (editor?.task && updated.some(task => task.id === editor.task.id)) await saveDraft();
    const destination = [...(container?.querySelectorAll('.date-group') ?? [])].find(group => group.dataset.date === (date ?? ''));
    if (destination) scrollBy({ top: destination.getBoundingClientRect().top - position, behavior: 'instant' });
    notify(date ? `Дата изменена: ${displayDate(date)}` : 'Дата убрана');
    destination?.querySelector('.date-button')?.focus({ preventScroll: true });
  }
  function dateHeading(date, first, interactive, records = [], creating = false) {
    const heading = element(first ? 'h1' : 'h2', `date-heading${first ? '' : ' secondary'}`);
    const label = date ? displayDate(date) : 'Без даты';
    if (!interactive) { heading.textContent = label; return heading; }
    heading.append(button(label, () => {
      const shown = records.map(task => ({ ...task }));
      const chooser = input('date', date ?? localDateKey());
      chooser.setAttribute('aria-label', shown.length ? 'Дата задач группы' : 'Дата новой задачи');
      chooser.min = '1900-01-01'; chooser.max = '2199-12-31';
      const wrapper = element('div', 'date-chooser');
      const apply = next => {
        if (shown.length) changeGroupDate(shown, next, heading, creating);
        else { chosenDate = next; openEditor(null, next); }
      };
      wrapper.append(chooser, button(shown.length ? 'Сохранить' : 'Добавить', () => {
        if (chooser.reportValidity()) apply(chooser.value || null);
      }), button('Без даты', () => apply(null)), button('Отмена', render));
      heading.replaceChildren(wrapper); chooser.focus();
    }, 'date-button'));
    return heading;
  }
  function appendGroups(container, tasks, creating = false) {
    const grouped = groupActiveTasks(tasks.map(task => ({ ...task, status: 'active' })));
    const byId = new Map(tasks.map(task => [task.id, task]));
    const drafts = creating ? contextualDrafts().filter(draft => !draft.taskId) : [];
    if (!grouped.length && creating && !drafts.length && !editor) grouped.push({ date: chosenDate === undefined ? localDateKey() : chosenDate, tasks: [] });
    if (creating && editor && !editor.task && !grouped.some(group => group.date === editor.dateContext)) {
      grouped.push({ date: editor.dateContext, tasks: [] });
    }
    for (const draft of drafts) if (!grouped.some(group => group.date === draft.dueDate)) grouped.push({ date: draft.dueDate, tasks: [] });
    grouped.sort((a, b) => a.date === null ? 1 : b.date === null ? -1 : a.date.localeCompare(b.date));
    grouped.forEach((group, index) => {
      const section = element('section', 'date-group'); section.dataset.date = group.date ?? '';
      section.append(dateHeading(group.date, index === 0 && container === groups, getView() !== 'trash', group.tasks.map(task => byId.get(task.id)), creating));
      const list = element('ul', 'task-list');
      group.tasks.forEach(task => list.append(taskRow(byId.get(task.id))));
      section.append(list);
      if (creating) {
        if (editor && !editor.task && editor.dateContext === group.date) section.append(editor.node);
        else section.append(button('• Добавить задачу', () => openEditor(null, group.date), 'add-task'));
        for (const draft of drafts.filter(draft => draft.dueDate === group.date)) section.append(draftPreview(draft));
      }
      container.append(section);
    });
  }
  function render() {
    const focused = document.activeElement;
    const selection = focused === editor?.text ? [focused.selectionStart, focused.selectionEnd] : null;
    const snapshot = getSnapshot();
    if (editor) {
      const selected = snapshot.sections.some(section => section.id === editor.section.value) ? editor.section.value : null;
      const options = sectionSelect(snapshot.sections, selected);
      editor.section.replaceChildren(...options.children);
      editor.section.value = selected ?? '';
    }
    groups.replaceChildren(); completedList.replaceChildren();
    const view = getView();
    const archived = view === 'completed' || view === 'trash';
    const tasks = snapshot.tasks.filter(matching);
    appendGroups(groups, tasks.filter(task => task.status === (view === 'trash' ? 'deleted' : view === 'completed' ? 'completed' : 'active')), !archived);
    if (archived && !groups.childElementCount) groups.append(element('h1', 'date-heading archive-heading', view === 'trash' ? 'Корзина пуста' : 'Нет выполненных'));
    const done = tasks.filter(task => task.status === 'completed');
    completed.hidden = archived || done.length === 0;
    if (!archived) appendGroups(completedList, done);
    if (editor?.task && !groups.contains(editor.node) && !completedList.contains(editor.node)) groups.append(editor.node);
    if (editor?.task?.status === 'completed') completed.open = true;
    const pendingEdits = contextualDrafts().filter(draft => draft.taskId);
    for (const draft of pendingEdits) {
      const task = draftTask(draft);
      const row = task && [...document.querySelectorAll('[data-task-id]')].find(row => row.dataset.taskId === task.id);
      if (row) { const item = element('li', 'draft-recovery-row'); item.append(draftPreview(draft)); row.after(item); }
      else groups.append(draftPreview(draft));
    }
    if (focused && focused.isConnected && editor?.node.contains(focused)) {
      focused.focus({ preventScroll: true });
      if (selection) focused.setSelectionRange(...selection);
    }
  }
  function draftPreview(draft) {
    const row = element('div', 'draft-recovery');
    const sectionName = getSnapshot().sections.find(section => section.id === draft.sectionId)?.name ?? 'Без раздела';
    row.append(element('p', 'draft-text', draft.text),
      element('p', 'support-text', `Незавершённый ввод · ${sectionName} · ${draft.dueDate ? displayDate(draft.dueDate) : 'Без даты'}`),
      button('Продолжить', () => recover(draft).catch(reportError)));
    return row;
  }
  async function recover(draft, { focus = true } = {}) {
    const task = draft.taskId ? getSnapshot().tasks.find(task => task.id === draft.taskId) : null;
    if (draft.taskId && (!task || task.status === 'deleted')) {
      if (!confirm('Исходная задача недоступна. Восстановить текст как новую задачу?')) return;
    }
    let recovered = draft;
    if (draft.ownerId !== ownerId) {
      if (editor && !await mutate(suspend)) return false;
      if (!await mutate(async () => { recovered = await repository.claimDraft(draft.id, ownerId, draft.updatedAt); })) return false;
    }
    if (!await openEditor(task?.status === 'deleted' ? null : task, draft.dueDate, recovered, { focus })) return false;
    if (task && draft.baseRevision !== task.revision) {
      editor.error.textContent = 'Задача менялась после начала этого черновика. Проверьте текст перед сохранением.';
      editor.error.hidden = false;
    }
    await refresh();
    return true;
  }
  async function restoreContext() {
    if (editor || restoring) return;
    const drafts = contextualDrafts();
    const own = drafts.filter(draft => draft.ownerId === ownerId);
    const candidate = own[0] ?? (drafts.length === 1 ? drafts[0] : null);
    if (!candidate || (candidate.taskId && (!draftTask(candidate) || draftTask(candidate).status === 'deleted'))) return;
    restoring = true;
    try {
      if (candidate.ownerId !== ownerId && await ownerIsLive(candidate.ownerId)) return;
      const latest = getSnapshot().drafts.find(draft => draft.id === candidate.id);
      if (editor || !latest || latest.ownerId !== candidate.ownerId || latest.updatedAt !== candidate.updatedAt) return;
      await recover(candidate, { focus: false });
    }
    finally { restoring = false; }
  }
  return { render, openEditor, suspend, flushDrafts, prepareReload, recover, restoreContext,
    discardEditor: () => { editor = null; }, hasPending: () => pendingDrafts > 0 || Boolean(draftFailure) || (editor?.text.value.length ?? 0) > 10000, getEditor: () => editor };
}
