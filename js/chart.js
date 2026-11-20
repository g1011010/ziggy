// Sparklines (inline SVG) and the detail chart (uPlot, with touch scrubbing).

import { fmtPrice } from './format.js';

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function sparkline(values, baseline, up) {
  const W = 72, H = 28, P = 2;
  if (!values || values.length < 2) return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"></svg>`;
  let min = Math.min(...values), max = Math.max(...values);
  if (baseline != null) { min = Math.min(min, baseline); max = Math.max(max, baseline); }
  const span = max - min || 1;
  const x = (i) => P + (i / (values.length - 1)) * (W - 2 * P);
  const y = (v) => H - P - ((v - min) / span) * (H - 2 * P);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const base = baseline != null
    ? `<line x1="0" x2="${W}" y1="${y(baseline).toFixed(1)}" y2="${y(baseline).toFixed(1)}" class="spark-base"/>`
    : '';
  return `<svg class="spark ${up ? 'up' : 'down'}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${base}<path d="${d}"/></svg>`;
}

/**
 * Render a price chart into `el`. `onScrub(idx|null)` is called as the
 * crosshair moves so the caller can update its readout.
 * Returns a destroy() function.
 */
export function detailChart(el, { t, v }, { up, baseline, intraday, onScrub }) {
  el.innerHTML = '';
  const line = up ? cssVar('--up') : cssVar('--down');
  const muted = cssVar('--text-muted');
  const grid = cssVar('--grid');

  const data = [t, v];
  const series = [
    {},
    {
      stroke: line,
      width: 2,
      fill: (u) => {
        const g = u.ctx.createLinearGradient(0, u.bbox.top, 0, u.bbox.top + u.bbox.height);
        g.addColorStop(0, line + '40');
        g.addColorStop(1, line + '00');
        return g;
      },
      points: { show: false },
    },
  ];
  if (baseline != null) {
    data.push(t.map(() => baseline));
    series.push({ stroke: muted, width: 1, dash: [4, 4], points: { show: false } });
  }

  const axis = { stroke: muted, grid: { stroke: grid, width: 1 }, ticks: { show: false }, font: '11px system-ui, sans-serif' };
  const opts = {
    width: el.clientWidth || 320,
    height: 240,
    padding: [8, 4, 0, 0],
    legend: { show: false },
    cursor: {
      x: true, y: false,
      points: { size: 9, fill: line, stroke: cssVar('--bg') },
      drag: { x: false, y: false },
    },
    scales: {
      x: { time: true },
      y: {
        range: (u, min, max) => {
          if (baseline != null) { min = Math.min(min, baseline); max = Math.max(max, baseline); }
          const pad = (max - min) * 0.08 || Math.abs(max) * 0.01 || 1;
          return [min - pad, max + pad];
        },
      },
    },
    axes: [
      { ...axis, space: 60, values: intraday ? '{h}:{mm}{aa}' : undefined },
      { ...axis, side: 1, size: 56, values: (u, vals) => vals.map((x) => fmtPrice(x)) },
    ],
    series,
    hooks: {
      setCursor: [(u) => onScrub?.(u.cursor.left >= 0 ? u.cursor.idx : null)],
    },
  };

  // uPlot is loaded as a classic script (vendor/uplot) and exposes a global.
  const u = new window.uPlot(opts, data, el);

  // Touch scrubbing: uPlot only follows the mouse, so drive the cursor from pointer events.
  const over = u.over;
  over.style.touchAction = 'pan-y';
  const move = (e) => {
    if (e.pointerType === 'mouse') return;
    const r = over.getBoundingClientRect();
    u.setCursor({ left: Math.max(0, Math.min(r.width, e.clientX - r.left)), top: e.clientY - r.top });
  };
  const end = (e) => {
    if (e.pointerType === 'mouse') return;
    u.setCursor({ left: -10, top: -10 });
  };
  over.addEventListener('pointerdown', move);
  over.addEventListener('pointermove', move);
  over.addEventListener('pointerup', end);
  over.addEventListener('pointercancel', end);
  over.addEventListener('pointerleave', end);

  const ro = new ResizeObserver(() => {
    const w = el.clientWidth;
    if (w && w !== u.width) u.setSize({ width: w, height: 240 });
  });
  ro.observe(el);

  return () => { ro.disconnect(); u.destroy(); };
}
