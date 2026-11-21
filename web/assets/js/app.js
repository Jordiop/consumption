'use strict';

const { createApp } = Vue;

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const saved = {
  get(key) { try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) { return {}; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { return; } },
};

const slug = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'sala';
const meters = v => Math.max(0, parseFloat(String(v).replace(',', '.')) || 0) * 100;
const newSetupRoom = () => ({ name: '', w: '4', l: '3', kind: '' });

createApp({
  template: '#tpl',
  data: () => ({
    plugs: [], found: [], newIp: '', error: '', busy: false, scanning: false, adding: false, lastFetch: '',
    settings: { theme: 'system', motion: true, startView: 'map', wires: true, roomHeat: true, pollMs: 3000, showPlugs: true, showBulbs: true },
    serverSettings: null, syncing: false,
    view: 'map', plan: { house: null, rooms: [] }, vb: [0, 0, 100, 100], zoomRoom: null, iso: false,
    edit: false, placing: null, drag: null, dragPos: null, hover: null, selected: null,
    planEdit: false, draft: null, nodes: [], undoStack: [], planDirty: false, dragNode: null, dragFrom: null, snapHint: null,
    selNode: null, selEdge: null, edgeLen: '', confirmReset: false, confirmCancel: false,
    drawing: false, drawPts: [], cursorPt: null, selRoom: null, confirmDelete: false, nameSnap: null,
    hist: [], histLoading: false, year: new Date().getFullYear(), month: new Date().getMonth() + 1, thisYear: new Date().getFullYear(),
    monthNames: ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'],
    monthLongNames: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
    unit: 'kwh', price: 0.15, selDay: null, hours: [], hoursLoading: false, hourNote: '', storage: null,
    tariff: 'pvpc', cost: null, dayPrices: null, todayPrices: null, tomorrowPrices: null,
    setup: null, homeName: '',
    bulb: null, bulbHold: 0, schedules: [], schedSaving: false,
    dayLetters: ['L', 'M', 'X', 'J', 'V', 'S', 'D'],
    bulbColors: ['#ff0000', '#ff8000', '#ffd000', '#00ff40', '#00c8ff', '#0040ff', '#a000ff', '#ff00a0'],
  }),
  computed: {
    houseBox() { return this.plan.house ? bbox(this.plan.house) : [0, 0, 100, 100]; },
    houseVb() { const b = this.houseBox, pad = 160; return [b[0] - pad, b[1] - pad, b[2] - b[0] + pad * 2, b[3] - b[1] + pad * 2]; },
    k() { return Math.max(.35, this.vb[2] / this.houseVb[2]); },
    showPlugs() { return this.edit || this.settings.showPlugs; },
    showBulbs() { return this.edit || this.settings.showBulbs; },
    placed() { return this.showPlugs ? this.plugs.filter(p => this.posOf(p)) : []; },
    bulbPos() { return this.drag === 'bulb' ? this.dragPos : this.bulb && this.bulb.pos; },
    bulbOnMap() { return !!(this.bulb && this.bulb.configured && this.showBulbs && this.bulbPos); },
    bulbState() { const b = this.bulb; return !b || !b.online ? 'offline' : b.on ? 'live' : 'off'; },
    homeTitle() { return (this.plan.name || '').trim() || 'Casa'; },
    roomPowers() {
      const out = {};
      this.viewRooms.forEach(r => {
        out[r.id] = this.plugs.reduce((s, p) => s + (p.pos && p.online && inside(p.pos, r.points) ? p.power_w || 0 : 0), 0);
      });
      return out;
    },
    schedDirty() { return !!this.bulb && JSON.stringify(this.schedules) !== JSON.stringify(this.bulb.schedules); },
    bulbGlow() {
      const b = this.bulb;
      if (!b || !b.online || !b.on) return 'var(--off)';
      if (b.mode === 'colour') return b.color;
      const t = b.temp / 100, mix = (a, c) => Math.round(a + (c - a) * t);
      return `rgb(${mix(255, 214)}, ${mix(178, 230)}, ${mix(92, 255)})`;
    },
    costByIp() { return Object.fromEntries(((this.cost && this.cost.plugs) || []).map(c => [c.ip, c])); },
    setupLayout() {
      if (!this.setup) return null;
      let x = 0, h = 0;
      const rooms = this.setup.rooms.map((r, i) => {
        const w = meters(r.w), l = meters(r.l);
        const points = [[x, 0], [x + w, 0], [x + w, l], [x, l]];
        x += w; h = Math.max(h, l);
        return { i, name: r.name.trim(), kind: r.kind, points, w, l, c: [x - w / 2, l / 2] };
      });
      return { rooms, house: [[0, 0], [x, 0], [x, h], [0, h]], W: x, H: h };
    },
    setupVb() {
      const L = this.setupLayout, pad = 40;
      if (!L || !L.W || !L.H) return '0 0 100 60';
      return [-pad, -pad, L.W + pad * 2, L.H + pad * 2].join(' ');
    },
    setupFont() { const L = this.setupLayout; return L && L.W ? Math.max(18, Math.max(L.W, L.H) / 28) : 20; },
    setupValid() {
      const L = this.setupLayout;
      return !!L && L.rooms.length > 0 && L.rooms.every(r => r.name && r.w >= 50 && r.l >= 50 && r.w <= 5000 && r.l <= 5000);
    },
    viewHouse() { return this.draft ? this.draft.house : this.plan.house; },
    viewRooms() { return ((this.draft || this.plan).rooms || []).map(prepareRoom); },
    selRoomObj() { return this.draft && this.selRoom != null ? this.draft.rooms[this.selRoom] || null : null; },
    drawPreview() { return this.cursorPt ? [...this.drawPts, this.cursorPt] : this.drawPts; },
    canZoom() { return !this.edit && !this.planEdit; },
    peEdges() {
      if (!this.draft || !this.nodes.length) return [];
      const seen = new Set(), out = [];
      this.polyIds().forEach(o => {
        const p = this.polyOf(o);
        p.forEach((a, i) => {
          const na = this.nodeId(o, i), nb = this.nodeId(o, i + 1);
          const key = Math.min(na, nb) + '-' + Math.max(na, nb);
          if (seen.has(key)) return;
          seen.add(key);
          out.push({ key, o, i, a, b: p[(i + 1) % p.length] });
        });
      });
      return out;
    },
    peDims() {
      if (!this.draft) return [];
      const list = [], nid = this.dragNode ?? this.selNode;
      if (nid != null && this.nodes[nid]) {
        this.nodes[nid].members.forEach(m => { const n = this.polyOf(m.o).length; list.push({ o: m.o, i: (m.i - 1 + n) % n }, { o: m.o, i: m.i }); });
      } else if (this.selEdge) list.push(this.selEdge);
      let pairs = list.map(({ o, i }) => { const p = this.polyOf(o); return [p[i], p[(i + 1) % p.length]]; });
      if (this.drawing && this.cursorPt && this.drawPts.length) pairs = [[this.drawPts[this.drawPts.length - 1], this.cursorPt]];
      const seen = new Set();
      return pairs
        .filter(([a, b]) => { const key = [a, b].map(q => q.map(Math.round).join(',')).sort().join('|'); if (seen.has(key)) return false; seen.add(key); return true; })
        .map(([a, b]) => {
          const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1, off = 30 * this.k;
          let ang = Math.atan2(dy, dx) * 180 / Math.PI;
          if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
          const x = (a[0] + b[0]) / 2 - dy / L * off, y = (a[1] + b[1]) / 2 + dx / L * off;
          return { x, y, ang, text: (L / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' m' };
        });
    },
    edgeOwner() {
      if (!this.selEdge) return '';
      return this.selEdge.o < 0 ? 'la fachada' : this.draft.rooms[this.selEdge.o].name;
    },
    totalPower() { return this.plugs.reduce((s, p) => s + (p.online && p.power_w || 0), 0); },
    totalToday() { return this.plugs.reduce((s, p) => s + (p.online && p.today_energy_wh || 0), 0); },
    totalMonth() { return this.plugs.reduce((s, p) => s + (p.online && p.month_energy_wh || 0), 0); },
    onlineCount() { return this.plugs.filter(p => p.online).length; },
    unitLabel() { return this.unit === 'eur' ? '€' : 'kWh'; },
    hourUnit() { return this.unit === 'eur' ? '€' : 'Wh'; },
    pvpc() { return this.unit === 'eur' && this.tariff === 'pvpc'; },
    priceCols() {
      const pr = this.dayPrices;
      if (!pr || !pr.published) return null;
      const cheap = cheapestWindow(pr.eur_kwh, 0, 3);
      const names = { P1: 'Punta', P2: 'Llano', P3: 'Valle' };
      return pr.eur_kwh.map((v, h) => ({
        key: 'p' + h, label: pad2(h) + ':00 – ' + pad2((h + 1) % 24) + ':00 · ' + names[pr.periods[h]], tick: h % 3 === 0 ? String(h) : '',
        segs: [{ name: 'Precio', color: 'var(--' + pr.periods[h].toLowerCase() + ')', v: v || 0 }], total: v || 0,
        sel: !!cheap && h >= cheap.start && h < cheap.start + 3,
      }));
    },
    periodRows() {
      const c = this.cost;
      if (!c || !c.periods) return null;
      const tot = ['P1', 'P2', 'P3'].reduce((a, k) => a + c.periods[k].wh, 0);
      if (!tot) return null;
      const meta = { P1: ['Punta', 'L–V 10–14 y 18–22 h'], P2: ['Llano', 'L–V 8–10, 14–18 y 22–24 h'], P3: ['Valle', 'noches, fines de semana y festivos'] };
      return ['P1', 'P2', 'P3'].map(k => ({
        id: k, name: meta[k][0], hours: meta[k][1], color: 'var(--' + k.toLowerCase() + ')',
        kwh: c.periods[k].wh / 1000, eur: c.periods[k].eur, pct: Math.round(c.periods[k].wh / tot * 100),
        avg: c.periods[k].wh ? c.periods[k].eur / (c.periods[k].wh / 1000) : null,
      }));
    },
    tips() {
      const out = [], now = new Date().getHours();
      const span = w => pad2(w.start) + ':00–' + pad2(w.start + 3) + ':00';
      const price = v => fu(v, '€/kWh');
      const t = this.todayPrices;
      if (t && t.published) {
        const w = cheapestWindow(t.eur_kwh, now, 3), avg = avgOf(t.eur_kwh);
        if (w) {
          const pc = avg ? Math.round((1 - w.avg / avg) * 100) : 0;
          out.push({ icon: '↓', text: pc >= 3
            ? 'Hoy, lo más barato que queda es de <b>' + span(w) + '</b> (' + price(w.avg) + ', un ' + pc + ' % menos que la media del día).'
            : 'Las horas baratas de hoy ya han pasado: lo que queda (desde <b>' + span(w) + '</b>, ' + price(w.avg) + ') está por encima de la media.' });
        }
      }
      const m = this.tomorrowPrices;
      if (m && m.published) {
        const lo = cheapestWindow(m.eur_kwh, 0, 3), hi = cheapestWindow(m.eur_kwh, 0, 3, true);
        out.push({ icon: '→', text: 'Mañana: mejor de <b>' + span(lo) + '</b> (' + price(lo.avg) + '); evita de <b>' + span(hi) + '</b> (' + price(hi.avg) + ').' });
      } else {
        out.push({ icon: '→', text: 'Los precios de mañana salen hacia las 20:15.' });
      }
      const c = this.cost;
      if (c && c.periods && c.periods.P1.wh > 0 && c.avg_price && c.avg_price.P3 != null) {
        const paid = c.periods.P1.eur / (c.periods.P1.wh / 1000);
        const save = c.periods.P1.wh / 1000 * (paid - c.avg_price.P3);
        if (save > 0.05) out.push({ icon: '€', text: 'Si lo que gastas en punta lo gastaras en valle, este mes te ahorrarías unos <b>' + fu(save, '€') + '</b>.' });
        const top = (c.plugs || []).map(p => {
          const tot = ['P1', 'P2', 'P3'].reduce((a, k) => a + p.periods[k].wh, 0);
          return { name: p.name, share: tot ? p.periods.P1.wh / tot : 0, wh: p.periods.P1.wh };
        }).sort((a, b) => b.wh - a.wh)[0];
        if (top && top.wh > 0) out.push({ icon: '!', text: 'El <b>' + esc(top.name) + '</b> gasta el ' + Math.round(top.share * 100) + ' % de su consumo en horas punta, las más caras.' });
      }
      return out;
    },
    series() { return this.hist.map((p, i) => ({ ip: p.ip, name: p.name || p.ip, color: this.colorOf(p.ip, i), error: p.error })); },
    monthLong() { return this.monthLongNames[this.month - 1]; },
    isCurrentMonth() { const n = new Date(); return this.year === n.getFullYear() && this.month === n.getMonth() + 1; },
    monthCols() {
      const n = new Date();
      return this.monthNames.map((m, i) => this.col('m' + i, this.monthLongNames[i] + ' ' + this.year, m, this.monthVal, i, {
        sel: i + 1 === this.month,
        future: this.year === n.getFullYear() && i > n.getMonth(),
      }));
    },
    dayCols() {
      const days = new Date(this.year, this.month, 0).getDate();
      return Array.from({ length: days }, (_, i) => {
        const iso = isoDate(this.year, this.month, i + 1), ago = daysAgo(iso);
        const c = this.col('d' + i, (i + 1) + ' de ' + this.monthLong, String(i + 1), this.dayVal, i, { sel: iso === this.selDay, short: String(i + 1) });
        if (this.pvpc && this.cost && this.cost.plugs.some(p => p.exact[i] === false)) c.note = 'Estimado con el precio medio del día: no hay detalle por horas.';
        c.tick = (i + 1) === 1 || (i + 1) % 5 === 0 || ago === 0 ? String(i + 1) : '';
        if (ago === 0) c.label += ' (hoy)';
        if (c.total === 0 && ago > 89) c.missing = 'Sin detalle diario: el enchufe solo lo guarda 90 días.';
        return c;
      });
    },
    hourCols() {
      if (!this.selDay || !this.hours.length || this.hours.every(p => !(p.hours || []).length)) return null;
      return Array.from({ length: 24 }, (_, h) => {
        const c = this.col('h' + h, pad2(h) + ':00 – ' + pad2((h + 1) % 24) + ':00', String(h), this.hourVal, h, {}, this.hours);
        c.tick = h % 3 === 0 ? String(h) : '';
        return c;
      });
    },
    selDayLabel() {
      if (!this.selDay) return '';
      const [y, m, d] = this.selDay.split('-').map(Number), ago = daysAgo(this.selDay);
      return ago === 0 ? 'Hoy' : ago === 1 ? 'Ayer' : d + ' de ' + this.monthLongNames[m - 1];
    },
    shareRows() {
      const rows = this.hist.map((p, i) => ({ ip: p.ip, name: p.name || p.ip, color: this.colorOf(p.ip, i), v: this.monthVal(p, this.month - 1) }));
      const tot = rows.reduce((a, r) => a + r.v, 0);
      if (!tot) return [];
      return rows.map(r => ({ ...r, pct: Math.round(r.v / tot * 100) })).sort((a, b) => b.v - a.v);
    },
    tiles() {
      const u = this.unitLabel, mIdx = this.month - 1;
      const mv = i => i < 0 ? 0 : this.hist.reduce((a, p) => a + this.monthVal(p, i), 0);
      const monthV = mv(mIdx), prevIdx = mIdx - 1, prevV = mv(prevIdx);
      const yearV = Array.from({ length: 12 }, (_, i) => mv(i)).reduce((a, b) => a + b, 0);
      const daysIn = new Date(this.year, this.month, 0).getDate();
      const elapsed = this.isCurrentMonth ? new Date().getDate() : daysIn;
      const avg = monthV / elapsed;
      const tag = this.pvpc ? ' · PVPC' : '';
      const out = [
        { label: (this.isCurrentMonth ? 'En ' : 'Total de ') + this.monthLong + tag, value: fu(monthV, u), sub: this.isCurrentMonth ? 'hasta hoy, día ' + elapsed : '' },
        { label: 'Media diaria', value: fu(avg, u), sub: elapsed + ' días' },
      ];
      const delta = (now, before) => {
        if (!before) return null;
        const pc = Math.round((now - before) / before * 100);
        return { up: pc > 0, text: Math.abs(pc) + ' % ' + (pc > 0 ? 'más' : 'menos') + ' que ' + this.monthLongNames[prevIdx] };
      };
      if (this.isCurrentMonth) {
        const fc = avg * daysIn;
        out.push({ label: 'Previsión de ' + this.monthLong, value: fu(fc, u), delta: delta(fc, prevV), sub: 'al ritmo actual' });
      } else {
        out.push({ label: 'Frente a ' + (prevIdx >= 0 ? this.monthLongNames[prevIdx] : 'el mes anterior'), value: prevV ? fu(prevV, u) : '—', delta: delta(monthV, prevV), sub: 'sin datos del mes anterior' });
      }
      out.push({ label: 'Total ' + this.year, value: fu(yearV, u), sub: 'desde que hay datos' });
      return out;
    },
  },
  watch: {
    homeTitle: { handler(t) { document.title = t + ' · Energía'; }, immediate: true },
  },
  methods: {
    async api(path, opts = {}) {
      const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || r.statusText);
      return data;
    },
    async refresh() {
      try {
        const list = await this.api('/api/plugs');
        if (this.drag) return;
        this.plugs = list;
        this.lastFetch = new Date().toLocaleTimeString();
      } catch (e) { this.error = 'No se puede contactar con el servidor: ' + e.message; }
    },
    setBulb(data) {
      const clean = !this.schedDirty;
      this.bulb = data;
      if (clean) this.schedules = clone(data.schedules);
    },
    async refreshBulb() {
      if (Date.now() < this.bulbHold) return;
      try { const data = await this.api('/api/bulb'); if (Date.now() >= this.bulbHold) this.setBulb(data); }
      catch (e) { return; }
    },
    bulbDrag(key, e) { this.bulbHold = Date.now() + 4000; this.bulb[key] = +e.target.value; },
    async bulbSet(change) {
      this.bulbHold = Date.now() + 4000;
      Object.assign(this.bulb, change.color ? { ...change, mode: 'colour', on: true } : change);
      try {
        const data = await this.api('/api/bulb', { method: 'PATCH', body: JSON.stringify(change) });
        this.bulbHold = 0;
        this.setBulb(data);
      } catch (e) { this.error = 'No se pudo cambiar la bombilla: ' + e.message; this.bulbHold = 0; this.refreshBulb(); }
    },
    async saveBulbPos(pos) {
      const prev = this.bulb.pos;
      this.bulb.pos = pos;
      try { await this.api('/api/bulb/pos', { method: 'PUT', body: JSON.stringify({ pos }) }); }
      catch (e) { this.bulb.pos = prev; this.error = 'No se pudo guardar la posición de la bombilla: ' + e.message; }
    },
    toggleDay(s, d) {
      const i = s.days.indexOf(d);
      if (i >= 0) { if (s.days.length > 1) s.days.splice(i, 1); } else { s.days.push(d); s.days.sort(); }
    },
    addSchedule() {
      this.schedules.push({ id: Math.random().toString(36).slice(2, 10), time: '20:00', days: [0, 1, 2, 3, 4, 5, 6], enabled: true, on: true, brightness: 80, temp: 0 });
    },
    async saveSchedules() {
      this.schedSaving = true;
      const list = this.schedules.map(s => ({ ...s, brightness: s.brightness === '' ? null : s.brightness }));
      try {
        const { schedules } = await this.api('/api/bulb/schedules', { method: 'PUT', body: JSON.stringify({ schedules: list }) });
        this.bulb.schedules = schedules;
        this.schedules = clone(schedules);
      } catch (e) { this.error = 'No se pudieron guardar los horarios: ' + e.message; }
      finally { this.schedSaving = false; }
    },
    clone: v => clone(v),
    async loadPlan() {
      try {
        const plan = await this.api('/api/plan');
        plan.rooms = plan.rooms || [];
        this.plan = plan;
        this.homeName = plan.name || '';
        this.vb = this.houseVb.slice();
        if (!plan.house || !plan.rooms.length) this.openSetup();
      } catch (e) { this.error = 'No se pudo cargar el plano: ' + e.message; }
    },
    openSetup() {
      this.setup = { step: 0, home: this.plan.name || '', rooms: [newSetupRoom()], saving: false };
      this.api('/api/settings').then(st => { this.serverSettings = st; }).catch(() => {});
      this.focusSoon('setup-home');
    },
    focusSoon(id) { setTimeout(() => { const el = document.getElementById(id); if (el) { el.focus(); if (el.select) el.select(); } }, 30); },
    setupNext() {
      if (this.setup.step === 0) { this.setup.step = 1; this.focusSoon('setup-room-0'); }
      else if (this.setup.step === 1) this.finishSetupPlan();
    },
    setupAddRoom() {
      this.setup.rooms.push(newSetupRoom());
      this.focusSoon('setup-room-' + (this.setup.rooms.length - 1));
    },
    setupRemoveRoom(i) { if (this.setup.rooms.length > 1) this.setup.rooms.splice(i, 1); },
    async finishSetupPlan() {
      if (!this.setupValid) { this.error = 'Cada sala necesita un nombre y unas medidas entre 0,5 y 50 m.'; return; }
      const L = this.setupLayout, used = new Set();
      const rooms = L.rooms.map(r => {
        let id = slug(r.name), n = 2;
        while (used.has(id)) id = slug(r.name) + '-' + n++;
        used.add(id);
        return { id, name: r.name, ...(r.kind ? { kind: r.kind } : {}), points: r.points };
      });
      const body = { units: 'cm', name: this.setup.home.trim() || 'Casa', northDeg: 0, house: L.house, rooms };
      this.setup.saving = true;
      try {
        this.plan = await this.api('/api/plan', { method: 'PUT', body: JSON.stringify(body) });
        this.homeName = this.plan.name || '';
        this.vb = this.houseVb.slice();
        this.error = '';
        this.setup.step = 2;
      } catch (e) { this.error = 'No se pudo guardar el plano: ' + e.message; }
      finally { if (this.setup) this.setup.saving = false; }
    },
    finishSetup() {
      this.setup = null;
      this.view = 'map';
      this.found = [];
      if (this.plugs.length && !this.plugs.some(p => p.pos)) this.toggleEdit();
    },
    async saveHomeName() {
      const name = this.homeName.trim();
      if (!this.plan.house || name === (this.plan.name || '')) return;
      try { this.plan = await this.api('/api/plan', { method: 'PUT', body: JSON.stringify({ ...this.plan, name }) }); }
      catch (e) { this.error = 'No se pudo guardar el nombre: ' + e.message; }
    },

    pts: p => p.map(q => q.join(',')).join(' '),
    posOf(p) { return this.drag === p.ip ? this.dragPos : p.pos; },
    nameOf(ip) { if (ip === 'bulb') return this.bulb ? this.bulb.name : 'Bombilla'; const p = this.plugs.find(q => q.ip === ip); return p ? p.name || p.ip : ip; },
    roomPower(r) { return this.roomPowers[r.id] || 0; },
    heat(r) { return this.settings.roomHeat ? .05 + Math.min(1, this.roomPower(r) / 1500) * .3 : .05; },
    roomOf(p) {
      if (!p.pos) return 'Sin colocar';
      const r = this.plan.rooms.find(r => inside(p.pos, r.points));
      return r ? r.name : 'En la casa';
    },
    animateVb(target) {
      cancelAnimationFrame(this.vbAnim);
      if (reduceMotion || !this.settings.motion) { this.vb = target.slice(); return; }
      const from = this.vb.slice(), t0 = performance.now();
      const step = t => {
        const q = Math.min(1, (t - t0) / 600), e = 1 - Math.pow(1 - q, 3);
        this.vb = from.map((v, i) => v + (target[i] - v) * e);
        if (q < 1) this.vbAnim = requestAnimationFrame(step);
      };
      this.vbAnim = requestAnimationFrame(step);
    },
    zoomTo(r) {
      const b = bbox(r.points), pad = 120;
      this.zoomRoom = r;
      this.animateVb([b[0] - pad, b[1] - pad, b[2] - b[0] + pad * 2, b[3] - b[1] + pad * 2]);
    },
    fitHouse() { this.zoomRoom = null; this.animateVb(this.houseVb); },
    polyIds() { return [-1, ...this.draft.rooms.map((_, i) => i)]; },
    polyOf(o) { return o < 0 ? this.draft.house : this.draft.rooms[o].points; },
    isStairs(o) { return o >= 0 && !!this.draft.rooms[o].stairs; },
    polyArea,
    nodeId(o, i) { const n = this.polyOf(o).length; return this.nodeMap[o + ':' + ((i % n) + n) % n]; },
    nodePos(n) { const m = n.members[0]; return this.polyOf(m.o)[m.i]; },
    setNode(id, p) { this.nodes[id].members.forEach(m => { this.polyOf(m.o)[m.i] = [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]; }); },
    buildNodes() {
      const verts = [];
      this.polyIds().forEach(o => this.polyOf(o).forEach((p, i) => verts.push({ o, i, p })));
      const parent = verts.map((_, i) => i);
      const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
      for (let a = 0; a < verts.length; a++)
        for (let b = a + 1; b < verts.length; b++)
          if (verts[a].o !== verts[b].o && Math.hypot(verts[a].p[0] - verts[b].p[0], verts[a].p[1] - verts[b].p[1]) <= WELD)
            parent[find(a)] = find(b);
      const groups = new Map();
      verts.forEach((v, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push({ o: v.o, i: v.i }); });
      const map = {};
      const nodes = [...groups.values()].map((members, id) => { members.forEach(m => { map[m.o + ':' + m.i] = id; }); return { id, members }; });
      this.nodeMap = map;
      this.nodes = nodes;
    },
    snapshot() { return JSON.stringify(this.draft); },
    pushUndo() { this.undoStack.push(this.snapshot()); if (this.undoStack.length > 200) this.undoStack.shift(); },
    undo() {
      const s = this.undoStack.pop();
      if (!s) return;
      this.draft = JSON.parse(s);
      this.selNode = null; this.selEdge = null; this.selRoom = null; this.confirmDelete = false;
      this.buildNodes();
      this.planDirty = this.undoStack.length > 0;
    },
    snapPoint(q, nid, free) {
      if (free) return { p: q, hint: null };
      const tol = 22 * this.k;
      let best = null, bd = tol;
      this.nodes.forEach(n => {
        if (n.id === nid) return;
        const p = this.nodePos(n), d = Math.hypot(p[0] - q[0], p[1] - q[1]);
        if (d < bd) { bd = d; best = p; }
      });
      if (best) return { p: best.slice(), hint: best.slice() };
      let onWall = null; bd = tol;
      this.peEdges.forEach(e => {
        if (this.nodeId(e.o, e.i) === nid || this.nodeId(e.o, e.i + 1) === nid) return;
        const pr = project(q, e.a, e.b);
        if (pr.d < bd) { bd = pr.d; onWall = pr.p; }
      });
      if (onWall) return { p: onWall, hint: onWall };
      return { p: [Math.round(q[0] / 5) * 5, Math.round(q[1] / 5) * 5], hint: null };
    },
    startPlanEdit() {
      this.edit = false; this.placing = null; this.iso = false;
      this.draft = { house: clone(this.plan.house), rooms: clone(this.plan.rooms) };
      this.drawing = false; this.drawPts = []; this.cursorPt = null; this.selRoom = null; this.confirmDelete = false;
      this.undoStack = []; this.planDirty = false; this.selNode = null; this.selEdge = null;
      this.confirmReset = false; this.confirmCancel = false;
      this.buildNodes();
      this.planEdit = true;
    },
    closePlanEdit() {
      this.planEdit = false; this.draft = null; this.nodes = []; this.undoStack = [];
      this.planDirty = false; this.selNode = null; this.selEdge = null; this.dragNode = null; this.snapHint = null;
      this.drawing = false; this.drawPts = []; this.cursorPt = null; this.selRoom = null; this.confirmDelete = false;
      this.confirmReset = false; this.confirmCancel = false;
    },
    cancelPlanEdit() {
      if (this.planDirty && !this.confirmCancel) { this.confirmCancel = true; return; }
      this.closePlanEdit();
    },
    async savePlan() {
      const body = { ...this.plan, house: this.draft.house, rooms: this.draft.rooms };
      try {
        this.plan = await this.api('/api/plan', { method: 'PUT', body: JSON.stringify(body) });
        this.closePlanEdit();
      } catch (e) { this.error = 'No se pudo guardar el plano: ' + e.message; }
    },
    async resetPlan() {
      if (!this.confirmReset) { this.confirmReset = true; return; }
      try {
        this.plan = await this.api('/api/plan/reset', { method: 'POST' });
        this.startPlanEdit();
      } catch (e) { this.error = e.message; this.confirmReset = false; }
    },
    peDown(e) {
      if (e.button !== 0) return;
      this.confirmReset = false; this.confirmCancel = false; this.confirmDelete = false;
      if (this.drawing) {
        e.preventDefault();
        const q = this.snapPoint(this.svgRaw(e), null, e.altKey).p.map(v => Math.round(v));
        const first = this.drawPts[0], last = this.drawPts[this.drawPts.length - 1];
        if (this.drawPts.length >= 3 && Math.hypot(q[0] - first[0], q[1] - first[1]) < 30 * this.k) return this.finishDrawing();
        if (last && Math.hypot(q[0] - last[0], q[1] - last[1]) < 2) return;
        this.drawPts.push(q);
        return;
      }
      const nEl = e.target.closest('[data-node]'), eEl = e.target.closest('[data-edge]');
      if (nEl) {
        const id = +nEl.dataset.node;
        this.pushUndo();
        this.dragNode = id; this.selNode = id; this.selEdge = null; this.selRoom = null;
        this.dragFrom = this.nodePos(this.nodes[id]).slice();
        this.$refs.svg.setPointerCapture(e.pointerId);
        e.preventDefault();
      } else if (eEl) {
        const [o, i] = eEl.dataset.edge.split(':').map(Number);
        this.selEdge = { o, i }; this.selNode = null; this.selRoom = null;
        const p = this.polyOf(o), a = p[i], b = p[(i + 1) % p.length];
        this.edgeLen = (Math.hypot(b[0] - a[0], b[1] - a[1]) / 100).toFixed(2).replace('.', ',');
      } else {
        const q = this.svgRaw(e);
        let hit = null;
        this.draft.rooms.forEach((r, i) => { if (inside(q, r.points)) hit = i; });
        this.selEdge = null; this.selNode = null; this.selRoom = hit;
      }
    },
    startDrawing() {
      this.selEdge = null; this.selNode = null; this.selRoom = null;
      this.drawPts = []; this.cursorPt = null; this.drawing = true;
    },
    cancelDrawing() { this.drawing = false; this.drawPts = []; this.cursorPt = null; this.snapHint = null; },
    finishDrawing() {
      if (this.drawPts.length < 3) { this.error = 'Una sala necesita al menos 3 esquinas.'; return; }
      this.pushUndo(); this.planDirty = true;
      const n = this.draft.rooms.filter(r => /^Sala \d+$/.test(r.name)).length + 1;
      this.draft.rooms.push({ id: 'sala-' + Date.now().toString(36), name: 'Sala ' + n, points: this.drawPts.map(q => q.slice()) });
      this.cancelDrawing();
      this.buildNodes();
      this.selRoom = this.draft.rooms.length - 1;
      this.focusSoon('room-name');
    },
    nameChanged() {
      if (this.nameSnap) this.undoStack.push(this.nameSnap);
      this.nameSnap = null; this.planDirty = true;
      if (!this.selRoomObj.name.trim()) this.selRoomObj.name = 'Sin nombre';
    },
    setKind(kind) {
      this.pushUndo(); this.planDirty = true;
      if (kind) this.selRoomObj.kind = kind; else delete this.selRoomObj.kind;
    },
    deleteRoom() {
      if (!this.confirmDelete) { this.confirmDelete = true; return; }
      this.pushUndo(); this.planDirty = true;
      this.draft.rooms.splice(this.selRoom, 1);
      this.selRoom = null; this.confirmDelete = false;
      this.buildNodes();
    },
    onDbl(e) {
      if (!this.planEdit) return;
      if (this.drawing) { if (this.drawPts.length >= 3) this.finishDrawing(); return; }
      const eEl = e.target.closest('[data-edge]');
      if (!eEl) return;
      const [o, i] = eEl.dataset.edge.split(':').map(Number);
      const p = this.polyOf(o), na = this.nodeId(o, i), nb = this.nodeId(o, i + 1);
      const pt = project(this.svgRaw(e), p[i], p[(i + 1) % p.length]).p.map(v => Math.round(v));
      const snap = this.snapshot();
      let changed = false;
      this.polyIds().forEach(oo => {
        if (this.isStairs(oo)) return;
        const pp = this.polyOf(oo);
        for (let j = 0; j < pp.length; j++) {
          const x = this.nodeId(oo, j), y = this.nodeId(oo, j + 1);
          if ((x === na && y === nb) || (x === nb && y === na)) { pp.splice(j + 1, 0, pt.slice()); changed = true; break; }
        }
      });
      if (!changed) { this.error = 'La escalera no admite esquinas nuevas: siempre tiene 4.'; return; }
      this.undoStack.push(snap); this.planDirty = true;
      this.selEdge = null;
      this.buildNodes();
    },
    onCtx(e) {
      if (!this.planEdit) return;
      e.preventDefault();
      const nEl = e.target.closest('[data-node]');
      if (!nEl) return;
      const n = this.nodes[+nEl.dataset.node];
      const ok = n.members.filter(m => !this.isStairs(m.o) && this.polyOf(m.o).length > 3);
      if (!ok.length) { this.error = 'Esa esquina no se puede quitar: cada habitación necesita al menos 3 esquinas y la escalera 4.'; return; }
      this.pushUndo(); this.planDirty = true;
      ok.sort((a, b) => b.i - a.i).forEach(m => this.polyOf(m.o).splice(m.i, 1));
      this.selNode = null; this.selEdge = null;
      this.buildNodes();
    },
    applyLen() {
      const L = parseFloat(String(this.edgeLen).replace(',', '.')) * 100;
      if (!(L > 0)) { this.error = 'Escribe la longitud en metros, por ejemplo 3,85.'; return; }
      const { o, i } = this.selEdge, p = this.polyOf(o), a = p[i], b = p[(i + 1) % p.length];
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      this.pushUndo(); this.planDirty = true;
      this.setNode(this.nodeId(o, i + 1), [a[0] + (b[0] - a[0]) / d * L, a[1] + (b[1] - a[1]) / d * L]);
    },
    straighten() {
      const { o, i } = this.selEdge, p = this.polyOf(o), a = p[i], b = p[(i + 1) % p.length];
      const nb = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? [b[0], a[1]] : [a[0], b[1]];
      this.pushUndo(); this.planDirty = true;
      this.setNode(this.nodeId(o, i + 1), nb);
      this.buildNodes();
    },
    toggleEdit() { this.edit = !this.edit; this.placing = null; if (this.edit) this.iso = false; },
    svgRaw(e) {
      const svg = this.$refs.svg, pt = svg.createSVGPoint();
      pt.x = e.clientX; pt.y = e.clientY;
      const q = pt.matrixTransform(svg.getScreenCTM().inverse());
      return [q.x, q.y];
    },
    svgPoint(e) {
      const [x, y] = this.svgRaw(e), q = { x, y };
      const b = this.houseBox;
      return [Math.min(b[2], Math.max(b[0], q.x)), Math.min(b[3], Math.max(b[1], q.y))];
    },
    onDown(e) {
      if (this.planEdit) return this.peDown(e);
      if (!this.edit) return;
      const m = e.target.closest('[data-marker]');
      if (m && !this.placing) {
        this.drag = m.dataset.marker;
        this.dragPos = this.svgPoint(e);
        this.$refs.svg.setPointerCapture(e.pointerId);
        e.preventDefault();
      } else if (this.placing) {
        this.savePos(this.placing, this.svgPoint(e));
        this.placing = null;
      }
    },
    onMove(e) {
      if (this.drawing) {
        const s = this.snapPoint(this.svgRaw(e), null, e.altKey);
        this.cursorPt = s.p.map(v => Math.round(v)); this.snapHint = s.hint;
        return;
      }
      if (this.dragNode != null) {
        const s = this.snapPoint(this.svgRaw(e), this.dragNode, e.altKey);
        this.snapHint = s.hint;
        this.setNode(this.dragNode, s.p);
        return;
      }
      if (this.drag) this.dragPos = this.svgPoint(e);
    },
    onUp() {
      if (this.dragNode != null) {
        const now = this.nodePos(this.nodes[this.dragNode]);
        if (now[0] === this.dragFrom[0] && now[1] === this.dragFrom[1]) this.undoStack.pop();
        else this.planDirty = true;
        this.dragNode = null; this.snapHint = null;
        this.buildNodes();
        return;
      }
      if (!this.drag) return;
      const ip = this.drag, pos = this.dragPos;
      const p = this.plugs.find(q => q.ip === ip);
      if (p) p.pos = pos;
      this.drag = null; this.dragPos = null;
      this.savePos(ip, pos);
    },
    async savePos(ip, pos) {
      if (ip === 'bulb') return this.saveBulbPos(pos);
      const p = this.plugs.find(q => q.ip === ip);
      const prev = p && p.pos;
      if (p) p.pos = pos;
      try { await this.api('/api/plugs/' + encodeURIComponent(ip), { method: 'PATCH', body: JSON.stringify({ pos }) }); }
      catch (e) { if (p) p.pos = prev; this.error = 'No se pudo guardar la posición: ' + e.message; }
    },

    tick() {
      if (this.view === 'map' && !this.setup && !document.hidden) this.drawWires();
      this.raf = requestAnimationFrame(this.tick);
    },
    drawWires() {
      const root = this.$refs.mapview;
      if (!root || !this.settings.wires) return;
      const R = root.getBoundingClientRect();
      root.querySelectorAll('.wires [data-wire]').forEach(g => {
        const ip = CSS.escape(g.dataset.wire);
        const m = root.querySelector(`[data-marker="${ip}"] .core`);
        const c = root.querySelector(`[data-card="${ip}"] .port`);
        if (!m || !c) { g.style.display = 'none'; return; }
        g.style.display = '';
        const a = m.getBoundingClientRect(), b = c.getBoundingClientRect();
        let d;
        if (b.left > a.right) {
          const x1 = a.right - R.left, y1 = a.top + a.height / 2 - R.top;
          const x2 = b.left + b.width / 2 - R.left, y2 = b.top + b.height / 2 - R.top;
          const dx = (x2 - x1) * .5;
          d = `M${x1} ${y1}C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`;
        } else {
          const x1 = a.left + a.width / 2 - R.left, y1 = a.bottom - R.top;
          const x2 = b.left + b.width / 2 - R.left, y2 = b.top + b.height / 2 - R.top;
          const dy = (y2 - y1) * .5;
          d = `M${x1} ${y1}C${x1} ${y1 + dy} ${x2} ${y2 - dy} ${x2} ${y2}`;
        }
        if (g.dataset.d === d) return;
        g.dataset.d = d;
        g.querySelectorAll('path').forEach(p => p.setAttribute('d', d));
      });
    },
    state(p) {
      if (!p.online) return 'offline';
      if (!p.is_on) return 'off';
      return (p.power_w || 0) >= 0.5 || !p.energy_monitoring ? 'live' : 'idle';
    },
    dur(p) { return Math.max(.3, 2.4 - Math.log10(1 + (p.power_w || 0)) * .7).toFixed(2); },
    width(p) { return (1.8 + Math.min(3.2, Math.log10(1 + (p.power_w || 0)) * 1.2)).toFixed(1); },
    isHl(ip) { return this.hover === ip || this.selected === ip; },
    share(p) { return this.totalPower > 0 ? Math.min(100, (p.power_w || 0) / this.totalPower * 100) : 0; },

    async addPlug(ip) {
      this.busy = true; this.error = '';
      try { await this.api('/api/plugs', { method: 'POST', body: JSON.stringify({ ip }) }); this.newIp = ''; this.adding = false; await this.refresh(); this.loadHistory(); }
      catch (e) { this.error = e.message; }
      finally { this.busy = false; }
    },
    async removePlug(ip) {
      await this.api('/api/plugs/' + encodeURIComponent(ip), { method: 'DELETE' }).catch(e => this.error = e.message);
      await this.refresh();
    },
    async scan() {
      this.scanning = true; this.error = '';
      try { this.found = await this.api('/api/scan', { method: 'POST' }); if (!this.found.length) this.error = 'No se encontró ningún dispositivo Tapo en la red.'; }
      catch (e) { this.error = e.message; }
      finally { this.scanning = false; }
    },
    isRegistered(ip) { return this.plugs.some(p => p.ip === ip); },
    statusColor(p) { return !p.online ? 'var(--err)' : p.is_on ? 'var(--ok)' : 'var(--off)'; },
    label(p) { return !p.online ? 'Sin conexión' : p.is_on ? 'Encendido' : 'Apagado'; },

    async loadHistory() {
      this.histLoading = true;
      this.api('/api/storage').then(st => { this.storage = st; }).catch(() => {});
      this.api(`/api/cost?year=${this.year}&month=${this.month}`).then(c => { this.cost = c; }).catch(() => { this.cost = null; });
      try { this.hist = (await this.api(`/api/history?year=${this.year}&month=${this.month}`)).plugs; }
      catch (e) { this.error = e.message; }
      finally { this.histLoading = false; }
    },
    async loadHours() {
      this.hourNote = '';
      if (!this.selDay) { this.hours = []; this.dayPrices = null; this.hourNote = 'Pulsa un día del gráfico de arriba para ver su consumo hora a hora.'; return; }
      this.hoursLoading = true;
      try {
        this.api('/api/prices?date=' + this.selDay).then(pr => { this.dayPrices = pr; }).catch(() => { this.dayPrices = null; });
        this.hours = (await this.api('/api/history/day?date=' + this.selDay)).plugs;
        if (!this.hourCols) this.hourNote = 'No hay datos por horas de este día: el enchufe solo guarda 7 días y la base de datos aún no lo había copiado.';
      } catch (e) { this.hours = []; this.hourNote = 'No se pudo cargar: ' + e.message; }
      finally { this.hoursLoading = false; }
    },
    todayIso() { const n = new Date(); return isoDate(n.getFullYear(), n.getMonth() + 1, n.getDate()); },
    setYear(y) {
      this.year = y;
      if (y === this.thisYear) this.month = new Date().getMonth() + 1;
      this.selDay = this.isCurrentMonth ? this.todayIso() : null;
      this.loadHistory(); this.loadHours();
    },
    setMonth(m) {
      this.month = m;
      this.selDay = this.isCurrentMonth ? this.todayIso() : null;
      this.loadHistory(); this.loadHours();
    },
    pickDay(d) { this.selDay = isoDate(this.year, this.month, d); this.loadHours(); },
    setUnit(u) { this.unit = u; this.savePrefs(); },
    setSetting(k, v) {
      this.settings[k] = v;
      saved.set('consum.settings', this.settings);
      if (k === 'theme') this.applyTheme();
      if (k === 'pollMs') this.startPolling();
    },
    loadSettings() {
      Object.assign(this.settings, saved.get('consum.settings'));
    },
    applyTheme() {
      const t = this.settings.theme;
      if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
      else document.documentElement.removeAttribute('data-theme');
    },
    startPolling() {
      clearInterval(this.timer);
      this.timer = setInterval(() => { this.refresh(); this.refreshBulb(); }, this.settings.pollMs);
    },
    openSettings() {
      this.view = 'settings';
      this.api('/api/settings').then(st => { this.serverSettings = st; }).catch(() => {});
      this.api('/api/storage').then(st => { this.storage = st; }).catch(() => {});
    },
    async syncNow() {
      this.syncing = true;
      try { this.storage = await this.api('/api/sync', { method: 'POST' }); }
      catch (e) { this.error = 'No se pudo copiar el historial: ' + e.message; }
      finally { this.syncing = false; }
    },
    setTariff(t) { this.tariff = t; this.savePrefs(); },
    savePrefs() { saved.set('consum.prefs', { unit: this.unit, price: this.price, tariff: this.tariff }); },
    loadPrefs() {
      const p = saved.get('consum.prefs');
      if (p.unit) this.unit = p.unit;
      if (p.price >= 0) this.price = p.price;
      if (p.tariff) this.tariff = p.tariff;
    },
    async loadUpcoming() {
      const n = new Date(), t = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1);
      const get = d => this.api('/api/prices?date=' + d).catch(() => null);
      [this.todayPrices, this.tomorrowPrices] = await Promise.all([get(this.todayIso()), get(isoDate(t.getFullYear(), t.getMonth() + 1, t.getDate()))]);
    },
    costOf(ip) { return this.costByIp[ip] || null; },
    monthVal(p, i) {
      if (this.pvpc) { const c = this.costOf(p.ip); return c ? c.months[i] || 0 : 0; }
      return this.conv(((p.months || [])[i]) || 0, this.unitLabel);
    },
    dayVal(p, i) {
      if (this.pvpc) { const c = this.costOf(p.ip); return c ? c.days[i] || 0 : 0; }
      return this.conv(((p.days || [])[i]) || 0, this.unitLabel);
    },
    hourVal(p, h) {
      const wh = ((p.hours || [])[h]) || 0;
      if (this.pvpc) { const pr = this.dayPrices && this.dayPrices.eur_kwh[h]; return pr == null ? 0 : wh / 1000 * pr; }
      return this.conv(wh, this.hourUnit);
    },
    colorOf(ip, fallback) { const i = this.plugs.findIndex(p => p.ip === ip); return 'var(--s' + (((i >= 0 ? i : fallback) % 8) + 1) + ')'; },
    conv(wh, unit) { return unit === '€' ? wh / 1000 * (this.price || 0) : unit === 'Wh' ? wh : wh / 1000; },
    col(key, label, tick, valueOf, idx, extra, source) {
      const segs = (source || this.hist).map((p, i) => ({ name: p.name || p.ip, color: this.colorOf(p.ip, i), v: valueOf(p, idx) }));
      return { key, label, tick, segs, total: segs.reduce((a, x) => a + x.v, 0), ...extra };
    },
    fu,
    fmt: (v, d) => v == null || isNaN(v) ? '—' : Number(v).toFixed(d),
    mins: m => m == null ? '—' : `${Math.floor(m / 60)} h ${m % 60} min`,
  },
  mounted() {
    this.loadSettings(); this.applyTheme();
    this.view = this.settings.startView === 'history' ? 'history' : 'map';
    this.loadPlan(); this.refresh(); this.refreshBulb(); this.loadHistory();
    this.startPolling();
    this.loadPrefs();
    this.selDay = this.todayIso(); this.loadHours();
    this.loadUpcoming();
    this.histTimer = setInterval(() => { this.loadHistory(); this.loadUpcoming(); if (this.selDay === this.todayIso()) this.loadHours(); }, 60000);
    this.onKey = e => {
      if (this.setup) return;
      if (e.key === 'Escape') { this.placing = null; this.selEdge = null; this.selNode = null; this.selRoom = null; this.cancelDrawing(); }
      if (this.drawing && e.key === 'Backspace' && e.target.tagName !== 'INPUT') { e.preventDefault(); this.drawPts.pop(); }
      if (this.drawing && e.key === 'Enter') this.finishDrawing();
      if (this.planEdit && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && e.target.tagName !== 'INPUT') { e.preventDefault(); this.undo(); }
    };
    addEventListener('keydown', this.onKey);
    this.tick();
  },
  unmounted() {
    clearInterval(this.timer); clearInterval(this.histTimer);
    cancelAnimationFrame(this.raf); removeEventListener('keydown', this.onKey);
  },
}).component('col-chart', ColChart).mount('#app');
