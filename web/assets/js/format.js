'use strict';

const niceStep = x => {
  const e = Math.pow(10, Math.floor(Math.log10(x))), f = x / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
};
const fu = (v, unit, axis) => {
  const loc = (x, d) => x.toLocaleString('es-ES', { minimumFractionDigits: axis ? 0 : d, maximumFractionDigits: d });
  if (v == null || isNaN(v)) return '—';
  if (unit === '€') return loc(v, 2) + (axis ? '' : ' €');
  if (unit === '€/kWh') return loc(v, axis ? 2 : 3) + (axis ? '' : ' €/kWh');
  if (unit === 'Wh') return loc(v, 0) + (axis ? '' : ' Wh');
  return loc(v, axis ? 2 : v < 10 ? 2 : 1) + (axis ? '' : ' kWh');
};
const pad2 = n => String(n).padStart(2, '0');
const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const avgOf = a => { const v = (a || []).filter(x => x != null); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; };
const cheapestWindow = (prices, from, n, worst) => {
  let best = null;
  for (let s = from; s + n <= prices.length; s++) {
    const w = prices.slice(s, s + n);
    if (w.some(x => x == null)) continue;
    const avg = w.reduce((a, b) => a + b, 0) / n;
    if (!best || (worst ? avg > best.avg : avg < best.avg)) best = { start: s, avg };
  }
  return best;
};
const isoDate = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
const daysAgo = iso => { const [y, m, d] = iso.split('-').map(Number); const t = new Date(); t.setHours(0, 0, 0, 0); return Math.round((t - new Date(y, m - 1, d)) / 864e5); };

