import { scaleLayout } from '../domain/layout.js';

function viewport() {
  const view = window.visualViewport;
  return { height: view?.height ?? innerHeight, width: view?.width ?? innerWidth,
    offsetTop: view?.offsetTop ?? 0, offsetLeft: view?.offsetLeft ?? 0 };
}

function safeAreas() {
  const style = getComputedStyle(document.documentElement);
  return { safeTop: parseFloat(style.getPropertyValue('--safe-top')) || 0,
    safeBottom: parseFloat(style.getPropertyValue('--safe-bottom')) || 0,
    safeRight: parseFloat(style.getPropertyValue('--safe-right')) || 0 };
}

export function positionScale(container) {
  const view = viewport(), safe = safeAreas();
  const geometry = scaleLayout({ ...view, ...safe, count: Number(container.dataset.dotCount) || 16 });
  const right = view.offsetLeft + (view.width + Math.min(view.width, 900)) / 2 - 16 - safe.safeRight;
  container.style.top = `${geometry.top}px`;
  container.style.left = `${right - 48}px`;
  container.style.right = 'auto';
  container.style.setProperty('--dot-gap', `${geometry.gap}px`);
  container.style.setProperty('--dot-size', `${geometry.dotSize}px`);
}

export function revealSurfaceControl(control) {
  if (!control?.matches('input, textarea, select')) return;
  const body = control.closest('.surface-body');
  if (!body || !body.closest('dialog[open]')) return;
  const bounds = body.getBoundingClientRect(), field = control.getBoundingClientRect();
  if (!bounds.height) return;
  const margin = Math.min(16, bounds.height / 4);
  const top = bounds.top + margin, bottom = bounds.bottom - margin;
  // Move only the dialog body, not Safari's layout viewport or the task list.
  if (field.top < top || field.height > bottom - top) body.scrollTop += field.top - top;
  else if (field.bottom > bottom) body.scrollTop += field.bottom - bottom;
}

export function attachAppViewport(container) {
  let frame = 0;
  const update = () => {
    frame = 0;
    const view = viewport(), style = document.documentElement.style;
    style.setProperty('--viewport-height', `${view.height}px`);
    style.setProperty('--viewport-width', `${view.width}px`);
    style.setProperty('--viewport-top', `${view.offsetTop}px`);
    style.setProperty('--viewport-left', `${view.offsetLeft}px`);
    positionScale(container);
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
  window.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('scroll', schedule);
  update();
  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', schedule);
    window.visualViewport?.removeEventListener('resize', schedule);
    window.visualViewport?.removeEventListener('scroll', schedule);
  };
}
