'use strict';

const ColChart = {
  props: { cols: Array, unit: String, height: { type: Number, default: 200 }, dim: { type: Boolean, default: true } },
  emits: ['pick'],
  data: () => ({ tip: null }),
  computed: {
    scale() {
      const max = Math.max(0, ...this.cols.map(c => c.total));
      const step = niceStep((max || 1) / 4);
      const top = Math.max(step, Math.ceil(max / step - 1e-9) * step);
      const ticks = [];
      for (let t = step; t <= top + step / 1e6; t += step) ticks.push(t);
      return { top, ticks };
    },
    anySel() { return this.cols.some(c => c.sel); },
    tipCol() { return this.tip != null ? this.cols[this.tip] : null; },
    tipStyle() { const f = (this.tip + .5) / this.cols.length; return { left: f * 100 + '%', transform: 'translateX(' + (-f * 100) + '%)' }; },
  },
  methods: { f(v, axis) { return fu(v, this.unit, axis); } },
  template: `
    <div class="cc" :style="{ '--h': height + 'px' }">
      <div class="cc-plot" @mouseleave="tip = null">
        <div v-for="t in scale.ticks" :key="t" class="cc-grid" :style="{ bottom: (t / scale.top * 100) + '%' }"><span>{{ f(t, true) }}</span></div>
        <div class="cc-cols">
          <button v-for="(c, i) in cols" :key="c.key" type="button" class="cc-col"
                  :class="{ dim: dim && anySel && !c.sel, sel: c.sel, missing: !!c.missing }"
                  :aria-label="c.label + ': ' + (c.missing || f(c.total))"
                  @mouseenter="tip = i" @focus="tip = i" @blur="tip = null" @click="$emit('pick', i)">
            <span class="cc-stack" :style="{ height: (c.total / scale.top * 100) + '%' }">
              <i v-for="sg in c.segs.filter(x => x.v > 0)" :key="sg.name" :style="{ flex: (c.total ? sg.v / c.total * 100 : 0) + ' 1 0px', background: sg.color }"></i>
            </span>
          </button>
          <div v-if="tipCol" class="cc-tip" :style="tipStyle" role="status">
            <b>{{ tipCol.label }}</b>
            <template v-if="!tipCol.missing">
              <div v-for="sg in tipCol.segs" :key="sg.name" class="cc-row"><span class="sw" :style="{ background: sg.color }"></span>{{ sg.name }}<span>{{ f(sg.v) }}</span></div>
              <div v-if="tipCol.segs.length > 1" class="cc-row total">Total<span>{{ f(tipCol.total) }}</span></div>
            </template>
            <div v-else class="muted">{{ tipCol.missing }}</div>
            <div v-if="tipCol.note" class="muted">{{ tipCol.note }}</div>
          </div>
        </div>
      </div>
      <div class="cc-x"><span v-for="c in cols" :key="c.key" :class="{ sel: c.sel }">{{ c.tick }}</span></div>
    </div>`,
};
