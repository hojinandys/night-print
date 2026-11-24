import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaybackSpeed } from '../dist/playback-speed.mjs';

test('first visit and malformed preferences use the slower default', () => {
  for (const value of [null, undefined, '', 'fast', '0', -1, 3, NaN, Infinity, true, {}, []]) {
    assert.equal(createPlaybackSpeed({ read: () => value }).rate, 0.5);
  }
});

test('each speed scales both the surface/image transition and the full observation interval', () => {
  const speed = createPlaybackSpeed();
  for (const rate of [0.25, 0.5, 1, 2]) {
    speed.set(rate);
    assert.deepEqual(speed.timing(), { surfaceMs: 1100 / rate, imageMs: 850 / rate, dwellMs: 1800 / rate });
  }
});

test('a saved speed survives a new annual or monthly viewer instance', () => {
  let stored = null;
  const storage = { read: () => stored, write: value => { stored = value; } };
  const annual = createPlaybackSpeed(storage);
  annual.set('0.25');
  assert.equal(stored, '0.25');
  const monthly = createPlaybackSpeed(storage);
  assert.equal(monthly.rate, 0.25);
  monthly.set('2');
  assert.equal(createPlaybackSpeed(storage).rate, 2);
});

test('blocked preference reads and writes do not break speed selection', () => {
  const speed = createPlaybackSpeed({ read() { throw new Error('blocked'); }, write() { throw new Error('blocked'); } });
  assert.equal(speed.rate, 0.5);
  assert.equal(speed.set('0.25'), 0.25);
  assert.equal(speed.timing().surfaceMs, 4400);
  assert.equal(speed.set('invalid'), 0.25);
});

test('changing speed preserves an in-flight timing snapshot', () => {
  const speed = createPlaybackSpeed(), pending = speed.timing();
  speed.set(2);
  assert.deepEqual(pending, { surfaceMs: 2200, imageMs: 1700, dwellMs: 3600 });
  assert.deepEqual(speed.timing(), { surfaceMs: 550, imageMs: 425, dwellMs: 900 });
});

test('reduced motion suppresses both animation paths but still honors viewing speed', () => {
  const speed = createPlaybackSpeed();
  for (const rate of [0.25, 0.5, 1, 2]) {
    speed.set(rate);
    assert.deepEqual(speed.timing({ reducedMotion: true }), { surfaceMs: 0, imageMs: 0, dwellMs: 3200 / rate });
  }
});
