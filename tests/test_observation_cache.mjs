import test from 'node:test';
import assert from 'node:assert/strict';
import { createObservationCache } from '../dist/observation-cache.mjs';
const ok = (data) => ({ ok: true, json: async () => data });

test('shared callers retry a temporary failure and keep a successful result', async () => {
  let calls = 0;
  const cache = createObservationCache(async () => { if (++calls === 1) throw new Error('offline'); return ok({region:'seoul'}); });
  const first = cache.get('map');
  assert.equal(cache.get('map'), first);
  await assert.rejects(first, /offline/);
  assert.deepEqual(await cache.get('map'), {region:'seoul'});
  await cache.get('map');
  assert.equal(calls, 2);
});

test('HTTP errors and mismatched observation data are retryable', async () => {
  const results = [{ok:false}, ok({region:'busan'}), ok({region:'seoul'})];
  const cache = createObservationCache(async () => results.shift());
  const valid = data => data.region === 'seoul';
  await assert.rejects(cache.get('map', valid), /request failed/);
  await assert.rejects(cache.get('map', valid), /identity/);
  assert.equal((await cache.get('map', valid)).region, 'seoul');
});

test('timeout releases the failed request for the next attempt', async () => {
  let calls = 0;
  const cache = createObservationCache((_url, {signal}) => ++calls > 1 ? Promise.resolve(ok({ready:true})) : new Promise((_resolve,reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))), 10);
  await assert.rejects(cache.get('map'), /aborted/);
  assert.equal((await cache.get('map')).ready, true);
});

test('a stale rejected request cannot remove a newer successful request', async () => {
  let rejectOld, calls = 0;
  const cache = createObservationCache(() => ++calls === 1 ? new Promise((_resolve,reject) => {rejectOld = reject;}) : Promise.resolve(ok({ready:true})));
  const old = cache.get('map');
  cache.clear('map');
  await cache.get('map');
  rejectOld(new Error('late failure'));
  await assert.rejects(old);
  assert.equal((await cache.get('map')).ready, true);
  assert.equal(calls, 2);
});
