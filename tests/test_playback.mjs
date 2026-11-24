import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayback } from '../dist/playback.mjs';
import { createPlaybackSpeed } from '../dist/playback-speed.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// A deterministic clock distinguishes waiting for an observation from its
// viewing interval without relying on real time or duplicating controller code.
function clock() {
  let now = 0, nextId = 0;
  const tasks = new Map(), cancelled = [], scheduled = [];
  return {
    schedule(callback, delay) {
      const id = nextId++;
      tasks.set(id, { callback, at: now + delay });
      scheduled.push({ id, callback, delay });
      return id;
    },
    cancel(id) { cancelled.push(id); tasks.delete(id); },
    advance(milliseconds) {
      now += milliseconds;
      for (const [id, task] of [...tasks]) {
        if (task.at <= now) { tasks.delete(id); task.callback(); }
      }
    },
    get pending() { return tasks.size; },
    scheduled,
    cancelled,
  };
}

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('changing speed during viewing preserves the pending interval without repeating or skipping years', async () => {
  const timing = clock(), shown = [], speed = createPlaybackSpeed();
  const playback = createPlayback({ prepare() {}, present: index => shown.push(index),
    delayMs: () => speed.timing().dwellMs, ...timing });
  const completion = playback.start([0, 1, 2]);
  await settle();
  assert.equal(timing.scheduled[0].delay, 3600);
  timing.advance(500); speed.set(2); await settle();
  assert.equal(playback.playing, true);
  assert.equal(timing.cancelled.length, 0);
  timing.advance(3099); await settle(); assert.deepEqual(shown, [0]);
  timing.advance(1); await settle(); assert.deepEqual(shown, [0, 1]);
  assert.equal(timing.scheduled[1].delay, 900);
  timing.advance(899); await settle(); assert.deepEqual(shown, [0, 1]);
  timing.advance(1); assert.equal(await completion, true);
  assert.deepEqual(shown, [0, 1, 2]);
});

test('a speed selected while loading controls the full next viewing interval', async () => {
  const timing = clock(), loading = deferred(), speed = createPlaybackSpeed(), shown = [];
  const playback = createPlayback({ prepare: index => index === 0 ? loading.promise : undefined,
    present: index => shown.push(index), delayMs: () => speed.timing().dwellMs, ...timing });
  const completion = playback.start([0, 1]);
  speed.set(0.25); timing.advance(8000); await settle();
  assert.equal(timing.pending, 0); assert.deepEqual(shown, []);
  loading.resolve(); await settle(); assert.equal(timing.scheduled[0].delay, 7200);
  timing.advance(7199); await settle(); assert.deepEqual(shown, [0]);
  timing.advance(1); assert.equal(await completion, true); assert.deepEqual(shown, [0, 1]);
});

test('slow preparation cannot skip an observation or consume its viewing time', async () => {
  const first = deferred(), timing = clock(), prepared = [], shown = [];
  const playback = createPlayback({
    prepare: (index) => { prepared.push(index); return index === 0 ? first.promise : undefined; },
    present: (index) => shown.push(index), delayMs: 100, ...timing,
  });
  const completion = playback.start([0, 1]);
  timing.advance(5000);
  await settle();
  assert.deepEqual(prepared, [0]);
  assert.deepEqual(shown, []);
  assert.equal(timing.pending, 0);
  first.resolve();
  await settle();
  assert.deepEqual(shown, [0]);
  timing.advance(99);
  await settle();
  assert.deepEqual(prepared, [0]);
  timing.advance(1);
  assert.equal(await completion, true);
  assert.deepEqual(shown, [0, 1]);
});

test('presentation must finish before the entire viewing interval begins', async () => {
  const drawing = deferred(), timing = clock(), prepared = [], states = [];
  const playback = createPlayback({
    prepare: (index) => prepared.push(index),
    present: (index) => index === 3 ? drawing.promise : undefined,
    onState: (value) => states.push(value), delayMs: 120, ...timing,
  });
  const completion = playback.start([3, 8]);
  await settle();
  timing.advance(1000);
  await settle();
  assert.deepEqual(prepared, [3]);
  assert.equal(timing.pending, 0);
  drawing.resolve();
  await settle();
  timing.advance(119);
  await settle();
  assert.deepEqual(prepared, [3]);
  timing.advance(1);
  assert.equal(await completion, true);
  assert.deepEqual(prepared, [3, 8]);
  assert.deepEqual(states, [true, false]);
  assert.equal(playback.playing, false);
});

test('Stop during preparation prevents that observation from being presented', async () => {
  const loading = deferred(), shown = [], states = [];
  const playback = createPlayback({ prepare: () => loading.promise,
    present: (index) => shown.push(index), onState: (value) => states.push(value) });
  const completion = playback.start([0, 1]);
  playback.stop();
  assert.equal(playback.playing, false);
  loading.resolve();
  assert.equal(await completion, false);
  assert.deepEqual(shown, []);
  assert.deepEqual(states, [true, false]);
});

test('Stop during presentation prevents its deferred result from advancing', async () => {
  const drawing = deferred(), timing = clock(), prepared = [];
  const playback = createPlayback({ prepare: (index) => prepared.push(index),
    present: () => drawing.promise, ...timing });
  const completion = playback.start([1, 2]);
  await settle();
  playback.stop();
  drawing.resolve();
  assert.equal(await completion, false);
  assert.deepEqual(prepared, [1]);
  assert.equal(timing.pending, 0);
});

test('Stop cancels the pending viewing timer, including a timer handle of zero', async () => {
  const timing = clock(), shown = [];
  const playback = createPlayback({ prepare: () => {}, present: (index) => shown.push(index), ...timing });
  const completion = playback.start([0, 1]);
  await settle();
  assert.equal(timing.pending, 1);
  playback.stop();
  assert.equal(await completion, false);
  assert.deepEqual(timing.cancelled, [0]);
  timing.advance(10000);
  await settle();
  assert.deepEqual(shown, [0]);
});

test('a fast restart ignores old preparation and a stale timer callback', async () => {
  const loading = deferred(), timing = clock(), shown = [], states = [];
  const playback = createPlayback({ prepare: (index) => index === 0 ? loading.promise : undefined,
    present: (index) => shown.push(index), onState: (value) => states.push(value), delayMs: 100, ...timing });
  const oldPreparation = playback.start([0, 1]);
  const oldTimer = playback.start([2, 3]);
  await settle();
  const staleCallback = timing.scheduled[0].callback;
  const current = playback.start([4, 5]);
  await settle();
  loading.resolve();
  staleCallback();
  await settle();
  assert.equal(await oldPreparation, false);
  assert.equal(await oldTimer, false);
  assert.equal(playback.playing, true);
  assert.deepEqual(shown, [2, 4]);
  assert.deepEqual(states, [true]);
  timing.advance(100);
  assert.equal(await current, true);
  assert.deepEqual(shown, [2, 4, 5]);
  assert.deepEqual(states, [true, false]);
});

for (const stage of ['prepare', 'present']) {
  test(`${stage} failure stops playback, reports once, and leaves later observations untouched`, async () => {
    const error = new Error(`${stage} failed`), timing = clock(), errors = [], prepared = [], shown = [], states = [];
    const playback = createPlayback({
      prepare: (index) => { prepared.push(index); if (stage === 'prepare') throw error; },
      present: (index) => { shown.push(index); if (stage === 'present') return Promise.reject(error); },
      onError: (value) => errors.push(value), onState: (value) => states.push(value), ...timing,
    });
    assert.equal(await playback.start([2, 3]), false);
    assert.deepEqual(prepared, [2]);
    assert.deepEqual(shown, stage === 'present' ? [2] : []);
    assert.deepEqual(errors, [error]);
    assert.deepEqual(states, [true, false]);
    assert.equal(timing.pending, 0);
  });
}

test('a rejected old request does not stop or report an error for the new playback', async () => {
  const loading = deferred(), timing = clock(), errors = [], shown = [];
  const playback = createPlayback({ prepare: (index) => index === 0 ? loading.promise : undefined,
    present: (index) => shown.push(index), onError: (error) => errors.push(error), delayMs: 100, ...timing });
  const old = playback.start([0, 1]);
  playback.stop();
  const current = playback.start([2, 3]);
  await settle();
  loading.reject(new Error('late old failure'));
  assert.equal(await old, false);
  assert.equal(playback.playing, true);
  assert.deepEqual(errors, []);
  timing.advance(100);
  assert.equal(await current, true);
  assert.deepEqual(shown, [2, 3]);
});

test('only supplied indices are shown in order; the caller array and delay may change independently', async () => {
  const timing = clock(), shown = [], intervals = [];
  const playback = createPlayback({ prepare: () => {}, present: (index) => shown.push(index),
    delayMs: (from, to) => { intervals.push([from, to]); return 50; }, ...timing });
  const input = [0, 3, 8], completion = playback.start(input);
  input.push(9);
  await settle();
  timing.advance(50);
  await settle();
  timing.advance(50);
  assert.equal(await completion, true);
  assert.deepEqual(shown, [0, 3, 8]);
  assert.deepEqual(intervals, [[0, 3], [3, 8]]);
  assert.equal(timing.pending, 0);
});

test('an empty replacement cancels an active sequence and leaves playback stopped', async () => {
  const loading = deferred(), shown = [];
  const playback = createPlayback({ prepare: () => loading.promise, present: (index) => shown.push(index) });
  const old = playback.start([0]);
  assert.equal(await playback.start([]), true);
  assert.equal(playback.playing, false);
  loading.resolve();
  assert.equal(await old, false);
  assert.deepEqual(shown, []);
});
