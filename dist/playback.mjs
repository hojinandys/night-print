// Display only the supplied observations, with a complete viewing interval
// after each successful presentation. Loading time never advances the sequence.
export function createPlayback({
  prepare,
  present,
  onState = () => {},
  onError = () => {},
  delayMs = 1800,
  schedule = (callback, milliseconds) => setTimeout(callback, milliseconds),
  cancel = (handle) => clearTimeout(handle),
}) {
  if (typeof prepare !== 'function' || typeof present !== 'function') {
    throw new TypeError('Playback requires prepare and present functions');
  }
  let generation = 0;
  let playing = false;
  let waiting = null;

  function setPlaying(value) {
    if (playing === value) return;
    playing = value;
    onState(value);
  }

  function cancelWait() {
    const previous = waiting;
    waiting = null;
    if (!previous) return;
    if (previous.handle !== null) cancel(previous.handle);
    previous.resolve(false);
  }

  function isCurrent(token) {
    return playing && generation === token;
  }

  function dwell(milliseconds, token) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new TypeError('Playback delay must be a finite, nonnegative number');
    }
    return new Promise((resolve) => {
      const record = { handle: null, resolve };
      waiting = record;
      record.handle = schedule(() => {
        if (waiting === record) waiting = null;
        resolve(isCurrent(token));
      }, milliseconds);
    });
  }

  async function run(indices, token) {
    try {
      for (let cursor = 0; cursor < indices.length; cursor++) {
        const index = indices[cursor];
        await prepare(index);
        if (!isCurrent(token)) return false;
        await present(index);
        if (!isCurrent(token)) return false;
        if (cursor < indices.length - 1) {
          const duration = typeof delayMs === 'function' ? delayMs(index, indices[cursor + 1]) : delayMs;
          if (!await dwell(duration, token)) return false;
        }
      }
      if (!isCurrent(token)) return false;
      setPlaying(false);
      return true;
    } catch (error) {
      // An old request can settle after Stop or a new sequence. It must not
      // change the current controls, report a stale error, or advance a year.
      if (!isCurrent(token)) return false;
      cancelWait();
      setPlaying(false);
      onError(error);
      return false;
    }
  }

  function start(indices) {
    const sequence = Array.from(indices);
    if (sequence.some((index) => !Number.isInteger(index) || index < 0)) {
      throw new TypeError('Playback indices must be nonnegative integers');
    }
    const token = ++generation;
    cancelWait();
    if (!sequence.length) {
      setPlaying(false);
      return Promise.resolve(true);
    }
    setPlaying(true);
    return run(sequence, token);
  }

  function stop() {
    ++generation;
    cancelWait();
    setPlaying(false);
  }

  // Already-running prepare/present work may finish, but cannot advance the
  // cancelled sequence. The presentation layer owns its own stale-render guard.
  return { start, stop, get playing() { return playing; } };
}
