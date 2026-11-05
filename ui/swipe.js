const pendingGestures = new Set();
let cancellationBound = false;

function bindCancellation() {
  if (cancellationBound) return;
  cancellationBound = true;
  const cancelAll = () => { for (const cancel of [...pendingGestures]) cancel(); };
  document.addEventListener('pointerdown', event => { if (!event.isPrimary) cancelAll(); }, true);
  for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, event => {
    for (const cancel of [...pendingGestures]) cancel(event.pointerId);
  });
  addEventListener('blur', cancelAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelAll(); });
}

/** Keep scrolling and zoom native; capture only a clear rightward gesture away from the edge. */
export function bindSwipe(row, textNode, { onComplete, onOpen, reportError }) {
  bindCancellation();
  let gesture = null;
  let suppressUntil = 0;
  const overlay = document.createElement('span');
  overlay.className = 'swipe-lines';
  overlay.setAttribute('aria-hidden', 'true');
  row.append(overlay);
  function draw(distance) {
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const base = row.getBoundingClientRect();
    const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
    overlay.replaceChildren();
    const limit = textNode.getBoundingClientRect().left + distance;
    for (const rect of rects) {
      const line = document.createElement('i');
      line.style.left = `${rect.left - base.left}px`;
      line.style.top = `${rect.top - base.top + rect.height * 0.52}px`;
      line.style.width = `${Math.max(0, Math.min(rect.width, limit - rect.left))}px`;
      overlay.append(line);
    }
  }
  function reset() {
    const id = gesture?.id;
    gesture = null; pendingGestures.delete(cancel);
    overlay.replaceChildren();
    if (id !== undefined && row.hasPointerCapture(id)) row.releasePointerCapture(id);
  }
  function cancel(id) {
    if (id !== undefined && id !== gesture?.id) return;
    if (gesture) suppressUntil = Date.now() + 400;
    reset();
  }
  function interactive(target) {
    return target.closest('input,textarea,select,a,summary,[contenteditable="true"],button:not(.task-content):not(.task-toggle)');
  }
  row.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || event.clientX < 24 || interactive(event.target)) return;
    reset(); suppressUntil = 0;
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, intent: null };
    pendingGestures.add(cancel);
  });
  row.addEventListener('pointermove', event => {
    if (!gesture || event.pointerId !== gesture.id) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (!gesture.intent && Math.max(Math.abs(dx), Math.abs(dy)) > 12) {
      gesture.intent = dx > 0 && dx > Math.abs(dy) * 1.5 ? 'horizontal' : 'scroll';
      if (gesture.intent === 'horizontal') row.setPointerCapture(event.pointerId);
      suppressUntil = Date.now() + 400;
    }
    if (gesture.intent !== 'horizontal') return;
    if (Math.abs(dy) > Math.abs(dx) / 1.5) { cancel(); return; }
    gesture.dx = Math.max(0, dx);
    draw(gesture.dx);
  });
  row.addEventListener('pointerup', async event => {
    if (!gesture || event.pointerId !== gesture.id) return;
    const completed = gesture.intent === 'horizontal' && gesture.dx >= Math.max(72, row.clientWidth * 0.3);
    if (gesture.intent) suppressUntil = Date.now() + 400;
    if (completed) {
      draw(row.clientWidth);
      reset();
      try { await onComplete(); } catch (error) { reportError(error); }
    }
    reset();
  });
  row.addEventListener('pointercancel', () => cancel());
  row.addEventListener('lostpointercapture', event => {
    // Touch implicitly captures the child button before capture moves to the row.
    if (event.target === row && event.pointerId === gesture?.id) cancel();
  });
  // This runs before marker/content button handlers, so one swipe cannot also become a tap.
  row.addEventListener('click', event => {
    if (event.detail > 0 && Date.now() < suppressUntil) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, true);
  row.addEventListener('click', event => {
    if (event.target.closest('.task-toggle') || interactive(event.target)) return;
    onOpen();
  });
}
