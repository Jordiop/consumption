'use strict';

const polyArea = p => p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0) / 2;
const centroid = p => {
  const A = polyArea(p); let cx = 0, cy = 0;
  p.forEach((a, i) => { const b = p[(i + 1) % p.length]; const f = a[0] * b[1] - b[0] * a[1]; cx += (a[0] + b[0]) * f; cy += (a[1] + b[1]) * f; });
  return [cx / (6 * A), cy / (6 * A)];
};
const bbox = p => { const xs = p.map(q => q[0]), ys = p.map(q => q[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };
const inside = (pt, poly) => {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) r = !r;
  }
  return r;
};
function stairGeometry(r) {
  let q = r.points.slice(0, 4);
  const len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len(q[0], q[1]) > len(q[1], q[2])) q = [q[1], q[2], q[3], q[0]];
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const L = len(q[0], q[3]);
  const cfg = { landing: 'end', landingDepth: 110, tread: 28, ...r.stairs };
  const flip = cfg.landing === 'start';
  const Q = (s, t) => { if (flip) s = 1 - s; return lerp(lerp(q[0], q[1], t), lerp(q[3], q[2], t), s); };
  const quad = (s0, s1, t0, t1) => [Q(s0, t0), Q(s1, t0), Q(s1, t1), Q(s0, t1)];
  const f1 = 1 - cfg.landingDepth / L;
  const n = Math.max(3, Math.round(f1 * L / cfg.tread));
  const ds = f1 / n, w0 = .46, w1 = .54, total = 2 * n + 1;
  const op = i => .03 + .55 * i / total;
  const steps = [];
  for (let i = 0; i < n; i++) steps.push({ q: quad(i * ds, (i + 1) * ds, w1, 1), o: op(i) });
  for (let i = 0; i < n; i++) steps.push({ q: quad(f1 - (i + 1) * ds, f1 - i * ds, 0, w0), o: op(n + 1 + i) });
  const P = p => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
  const start = Q(ds * .5, .77), end = Q(ds * 1.6, .23), turn = f1 + (1 - f1) * .55;
  const walk = `M${P(start)}L${P(Q(f1, .77))}C${P(Q(turn, .77))} ${P(Q(turn, .23))} ${P(Q(f1, .23))}L${P(end)}`;
  const dir = (() => { const a = Q(.5, .23), b = Q(.4, .23), d = Math.hypot(b[0] - a[0], b[1] - a[1]); return [(b[0] - a[0]) / d, (b[1] - a[1]) / d]; })();
  const nrm = [-dir[1], dir[0]], hs = 26;
  const tip = [end[0] + dir[0] * hs, end[1] + dir[1] * hs];
  const head = `M${P(tip)}L${P([end[0] + nrm[0] * hs * .7, end[1] + nrm[1] * hs * .7])}L${P([end[0] - nrm[0] * hs * .7, end[1] - nrm[1] * hs * .7])}Z`;
  return {
    steps, count: 2 * n, start, walk, head,
    landing: quad(f1, 1, 0, 1), landingO: op(n),
    well: quad(0, f1, w0, w1),
    rails: [[Q(0, w0 - .015), Q(f1, w0 - .015)], [Q(0, w1 + .015), Q(f1, w1 + .015)]],
  };
}

const project = (q, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L2)) : 0;
  const p = [a[0] + t * dx, a[1] + t * dy];
  return { p, d: Math.hypot(p[0] - q[0], p[1] - q[1]) };
};
const prepareRoom = r => {
  if (r.stairs) return { ...r, geo: stairGeometry(r), c: centroid(r.points) };
  const b = bbox(r.points);
  return { ...r, area: Math.abs(polyArea(r.points)) / 1e4, c: [b[0] + 30, b[1] + 60] };
};
const WELD = 15;
const clone = v => JSON.parse(JSON.stringify(v));
