// A transition is a display bridge between two observed endpoints. It never
// creates an observation, statistic, year, or connection across missing cells.
const quadValidity = new WeakMap();
function validQuads(base) {
  if (!base?.xy || !base.faces || base.faces.length % 4) return false;
  if (quadValidity.has(base)) return quadValidity.get(base);
  let valid = true;
  for (let i = 0; valid && i < base.faces.length; i += 4) {
    const q = Array.from(base.faces.slice(i, i + 4));
    if (new Set(q).size !== 4 || q.some(v => v < 0 || v * 2 + 1 >= base.xy.length)) { valid = false; break; }
    let orientation = 0;
    for (let j = 0; j < 4; j++) {
      const [a, b, c] = [q[j], q[(j + 1) % 4], q[(j + 2) % 4]];
      const cross = (base.xy[b * 2] - base.xy[a * 2]) * (base.xy[c * 2 + 1] - base.xy[b * 2 + 1]) -
        (base.xy[b * 2 + 1] - base.xy[a * 2 + 1]) * (base.xy[c * 2] - base.xy[b * 2]);
      if (!Number.isFinite(cross) || Math.abs(cross) < 1e-12 || (orientation && Math.sign(cross) !== orientation)) { valid = false; break; }
      orientation = Math.sign(cross);
    }
  }
  quadValidity.set(base, valid); return valid;
}
function fillsSameQuads(triangles, base) {
  if (!triangles || triangles.length !== base.faces.length / 4 * 6) return false;
  for (let q = 0, t = 0; q < base.faces.length; q += 4, t += 6) {
    let a = 0, b = 0;
    for (let j = 0; j < 6; j++) {
      let slot = -1;
      for (let k = 0; k < 4; k++) if (base.faces[q + k] === triangles[t + j]) slot = k;
      if (slot < 0) return false;
      if (j < 3) a |= 1 << slot; else b |= 1 << slot;
    }
    if (!((a === 7 && b === 13) || (a === 13 && b === 7) || (a === 11 && b === 14) || (a === 14 && b === 11))) return false;
  }
  return true;
}
export function compatibleSurface(from, to, base) {
  if (!from?.z || !to?.z || from.z.length !== to.z.length) return false;
  const a = from.triangles, b = to.triangles;
  if (!!a !== !!b || (a && a.length !== b.length)) return false;
  for (let i = 0; i < from.z.length; i++) if (!Number.isFinite(from.z[i]) || !Number.isFinite(to.z[i])) return false;
  if (a) {
    let same = true;
    for (let i = 0; i < a.length; i++) { if (a[i] >= from.z.length || b[i] >= from.z.length) return false; if (a[i] !== b[i]) same = false; }
    // Different diagonals of the same proven convex observation quads do not
    // change coverage. Retain the source diagonal during motion and restore
    // the exact destination triangulation at completion.
    if (!same && !(validQuads(base) && fillsSameQuads(a, base) && fillsSameQuads(b, base))) return false;
  }
  return true;
}

export function createSurfaceTransition({ duration = 1100, start, apply, finish }) {
  if (!(duration > 0) || !Number.isFinite(duration)) throw new TypeError('A finite positive transition duration is required');
  let active = true, resolve;
  const promise = new Promise(done => { resolve = done; });
  const settle = (complete) => {
    if (!active) return;
    active = false;
    try { finish(complete); } finally { resolve(complete); }
  };
  return {
    promise,
    get active() { return active; },
    tick(time) {
      if (!active) return;
      const t = Math.max(0, Math.min(1, (time - start) / duration));
      // Quintic easing has zero speed and acceleration at each observed frame.
      const eased = t * t * t * (t * (t * 6 - 15) + 10);
      apply(eased);
      if (t === 1) settle(true);
    },
    cancel() { settle(false); },
    complete() { if (active) { apply(1); settle(true); } },
  };
}
