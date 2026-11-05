import { parseBackup, serializeBackup, MAX_BACKUP_BYTES } from '../domain/backup.js';
import { readSnapshot, replaceSnapshot } from '../storage/db.js';
import { localDateKey } from '../domain/dates.js';
import { element, button, input } from './dom.js';
import { inspectStorageProtection, requestStorageProtection, storageProtectionMessage } from '../domain/storage-protection.js';

export async function exportBackup({ flushDrafts, reportError }) {
  try {
    let draftError;
    try { await flushDrafts(); } catch (error) { draftError = error; }
    const snapshot = await readSnapshot();
    const url = URL.createObjectURL(new Blob([serializeBackup(snapshot)], { type: 'application/json' }));
    const link = element('a');
    link.href = url; link.download = `tasks-${localDateKey()}.mono-backup.json`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    if (draftError) reportError(new Error('Копия сохранённых записей подготовлена. Последние изменения в редакторе могут отсутствовать: черновик не удалось записать. Текст остался в редакторе.'));
    return true;
  } catch (error) { reportError(error); return false; }
}

export function buildDataSettings({ getSnapshot, mutate, flushDrafts, afterImport, reportError, notify }) {
  const content = element('div', 'data-settings');
  content.append(element('p', 'support-text', 'Записи хранятся на этом устройстве и не отправляются разработчику. При удалении данных сайта или потере устройства понадобится отдельная копия. Шифрования базы нет.'));
  content.append(element('p', 'support-text', 'Файл копии не зашифрован и содержит задачи, разделы и черновики. Храните его в безопасном месте.'));
  const exportButton = button('Сохранить копию', async () => {
    if (await exportBackup({ flushDrafts, reportError })) notify('Копия подготовлена');
  });
  exportButton.id = 'export-backup'; content.append(exportButton);
  const label = element('label', 'field-label', 'Восстановить из файла');
  const file = input('file'); file.id = 'import-file'; file.accept = '.json,.mono-backup,application/json';
  label.append(file); content.append(label);
  const preview = element('div', 'import-preview'); content.append(preview);
  let fileSequence = 0;
  file.addEventListener('change', async () => {
    const sequence = ++fileSequence;
    preview.replaceChildren();
    const selected = file.files?.[0];
    if (!selected) return;
    try {
      if (selected.size > MAX_BACKUP_BYTES) throw new Error('Файл больше 5 МиБ. Текущие записи не изменены.');
      const backup = parseBackup(await selected.text());
      if (sequence !== fileSequence) return;
      const p = backup.payload;
      preview.append(element('p', 'support-text', `Проверено: задач — ${p.tasks.length}, разделов — ${p.sections.length}, черновиков — ${p.drafts?.length ?? 0}.`));
      preview.append(element('p', 'support-text', 'Текущие записи будут заменены содержимым файла. Сначала сохраните их копию.'));
      preview.append(button('Сохранить текущую копию', () => exportBackup({ flushDrafts, reportError })));
      const replace = button('Заменить записи', async () => {
        try {
          await flushDrafts();
          const current = await readSnapshot();
          const hasDrafts = current.drafts.some(draft => draft.text.trim());
          if (!confirm('Заменить все текущие задачи, разделы и настройки содержимым файла?' + (hasDrafts ? ' Текущие черновики тоже будут заменены.' : ''))) return;
          replace.disabled = true;
          const success = await mutate(async () => {
            await replaceSnapshot(p, { discardDrafts: true, expectedDrafts: current.drafts });
            await afterImport();
          });
          if (success) { preview.replaceChildren(element('p', 'support-text', 'Копия восстановлена.')); notify('Копия восстановлена'); }
        } catch (error) { reportError(error); }
        finally { replace.disabled = false; }
      });
      replace.id = 'confirm-import'; preview.append(replace);
    } catch (error) { if (sequence === fileSequence) { reportError(error); file.value = ''; } }
  });
  const details = element('details', 'storage-details');
  const storage = element('p', 'support-text', 'Проверяем защиту хранения…'); storage.id = 'storage-state';
  const renderProtection = result => {
    storage.textContent = storageProtectionMessage(result);
    persistence.hidden = !['requestable', 'declined'].includes(result.state);
  };
  const persistence = button('Запросить защиту', async () => {
    if (persistence.disabled) return;
    persistence.disabled = true;
    try { renderProtection(await requestStorageProtection()); }
    finally { persistence.disabled = false; }
  });
  persistence.id = 'request-persistence'; persistence.hidden = true;
  details.append(element('summary', '', 'Защита от автоочистки'), storage, persistence);
  content.append(details, element('p', 'support-text', 'У каждого браузера, устройства и адреса свои записи. Для переноса используйте файл копии.'));
  inspectStorageProtection().then(renderProtection);
  return content;
}
