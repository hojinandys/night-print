export const PLAYBACK_SPEED_KEY = 'night-print-playback-speed';
export const DEFAULT_PLAYBACK_SPEED = 0.5;
const rates = new Set([0.25, 0.5, 1, 2]);

function validRate(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const rate = Number(value);
  return rates.has(rate) ? rate : null;
}

// Storage is optional: private browsing, blocked storage, and old preferences
// must never prevent the artwork or its controls from opening.
export function createPlaybackSpeed({ read = () => null, write = () => {} } = {}) {
  let rate = DEFAULT_PLAYBACK_SPEED;
  try { rate = validRate(read()) ?? DEFAULT_PLAYBACK_SPEED; } catch {}
  return {
    get rate() { return rate; },
    set(value) {
      const next = validRate(value);
      if (next === null) return rate;
      rate = next;
      try { write(String(rate)); } catch {}
      return rate;
    },
    timing({ reducedMotion = false } = {}) {
      // Each consumer takes one snapshot. An in-flight transition or viewing
      // interval keeps its deadline when the user changes the next speed.
      return Object.freeze({
        surfaceMs: reducedMotion ? 0 : 1100 / rate,
        imageMs: reducedMotion ? 0 : 850 / rate,
        dwellMs: (reducedMotion ? 3200 : 1800) / rate,
      });
    },
  };
}
