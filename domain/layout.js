export function scaleLayout({ height, offsetTop = 0, count = 16, safeTop = 0, safeBottom = 0 }) {
  const tail = 56;
  const margin = Math.max(0, Math.min(16 + safeBottom, height / 12, height - tail - count));
  const header = Math.max(0, Math.min(82 + safeTop, height / 3, height - margin - tail - count));
  const available = Math.max(1, height - header - margin);
  const dotSize = Math.max(1, Math.min(8, (available - tail) / count));
  const gap = count > 1 ? Math.max(0, Math.min(10, (available - tail - dotSize * count) / (count - 1))) : 0;
  const totalHeight = dotSize * count + gap * Math.max(0, count - 1) + tail;
  return { top: offsetTop + header + Math.max(0, (available - totalHeight) / 2), dotSize, gap, totalHeight };
}
