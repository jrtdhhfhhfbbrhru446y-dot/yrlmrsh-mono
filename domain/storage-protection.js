function capability({ secure = globalThis.isSecureContext, storage = globalThis.navigator?.storage } = {}) {
  if (!secure) return { state: 'insecure' };
  if (typeof storage?.persisted !== 'function') return { state: 'unavailable' };
  return { storage };
}

export async function inspectStorageProtection(environment) {
  const available = capability(environment);
  if (available.state) return available;
  try {
    if (await available.storage.persisted()) return { state: 'protected' };
    return { state: typeof available.storage.persist === 'function' ? 'requestable' : 'unavailable' };
  } catch { return { state: 'error', operation: 'inspect' }; }
}

export async function requestStorageProtection(environment) {
  const available = capability(environment);
  if (available.state) return available;
  if (typeof available.storage.persist !== 'function') return { state: 'unavailable' };
  try { return { state: await available.storage.persist() ? 'protected' : 'declined' }; }
  catch { return { state: 'error', operation: 'request' }; }
}

export function storageProtectionMessage(result) {
  switch (result.state) {
    case 'insecure': return 'В тестовом HTTP-режиме дополнительная защита хранения недоступна';
    case 'unavailable': return 'Дополнительная защита хранения недоступна в этом браузере или режиме.';
    case 'protected': return 'Защита от автоочистки предоставлена. Она не защищает от ручного удаления данных или потери устройства.';
    case 'requestable': return 'Можно запросить дополнительную защиту от автоочистки. Решение принимает браузер.';
    case 'declined': return 'Браузер не предоставил защиту от автоочистки. Задачи по-прежнему сохраняются локально; сохраняйте отдельную копию.';
    case 'error': return result.operation === 'request' ? 'Не удалось запросить защиту хранения. Записи не изменены; сохраните отдельную копию.'
      : 'Не удалось проверить защиту хранения. Записи не изменены; сохраните отдельную копию.';
    default: return 'Проверяем защиту хранения…';
  }
}
