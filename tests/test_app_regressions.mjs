import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Run the actual application functions with a small DOM boundary. These tests
// exercise asynchronous region changes and publication status, without a GPU.
const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
function applicationFunction(name) {
  const start = source.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `Application function ${name} is present`);
  const rest = source.slice(start + 1);
  const next = rest.search(/^  (?:async )?function /m);
  assert.ok(next >= 0, `Application function ${name} has a following boundary`);
  return source.slice(start, start + 1 + next);
}

class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.attributes = new Map();
    this.classList = { toggle() {}, remove() {} };
  }
  get firstElementChild() { return this.children[0] || null; }
  replaceChildren(...nodes) { this.children = nodes; }
  append(...nodes) { this.children.push(...nodes); }
  add(node) { this.append(node); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  addEventListener() {}
  querySelector() { return new Element(); }
}

function elements() {
  const nodes = new Map();
  return (id) => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
}

test('returning to a loaded region while another map is pending restores its SVG', async () => {
  const $ = elements();
  const regions = ['seoul', 'busan'].map((id) => ({
    id, label: id, districts: [], interaction_url: `${id}-map`, map_url: `${id}.png`, coverage_pct: 100,
  }));
  const state = { region: 'seoul', data: { years: [2015, 2023], regions }, mode: 'absolute', district: null, interaction: null };
  const map = (id) => ({ bounds: [0, 0, 1, 1], districts: [{ id, name: id, polygons: [] }] });
  let resolveBusan;
  const busan = new Promise((resolve) => { resolveBusan = resolve; });
  const context = vm.createContext({
    $, state, mapToken: 0, viewerReady: false,
    region: () => regions.find((item) => item.id === state.region),
    editionAsset: (path) => path, label: (item) => item.label, imagePath: () => 'art.png',
    pair: () => [2015, 2023], pairValues: () => ({ first: {}, last: {} }), pairRecord: () => null,
    series: () => ({}), year: () => 2023, baseline: () => 2015,
    periodLabel: String, periodName: String, observation: () => 'observed', commonArea: () => 'common',
    fmt: String, pct: String, finite: Number.isFinite,
    Option: Element, el: (tag) => new Element(tag),
    svgNode: (tag, attributes) => { const node = new Element(tag); Object.entries(attributes || {}).forEach(([key, value]) => node.setAttribute(key, value)); return node; },
    polygonPath: () => '', syncMarkers() {}, drawChart() {}, renderQuality() {}, updateMapSelection() {},
    update3D: () => true,
    loadInteraction: (r) => r.id === 'busan' ? busan : Promise.resolve(map('seoul')),
  });
  vm.runInContext(applicationFunction('renderDetail') + applicationFunction('renderMap'), context);
  context.renderDetail();
  await Promise.resolve();
  assert.equal($('linked-map').firstElementChild?.tagName, 'svg');

  state.region = 'busan'; state.interaction = null;
  context.renderDetail();
  assert.equal($('linked-map').children.length, 0);
  state.region = 'seoul'; state.interaction = null;
  context.renderDetail();
  await Promise.resolve();
  const restored = $('linked-map').firstElementChild;
  assert.equal(restored?.tagName, 'svg', 'The cached region still needs its cleared SVG rebuilt');
  assert.equal($('linked-map').dataset.key, 'seoul-map/seoul');

  resolveBusan(map('busan'));
  await Promise.resolve();
  assert.equal($('linked-map').firstElementChild, restored, 'The late other-region result must not replace this map');
});

test('new monthly observations awaiting credentials are visible in the publication status', () => {
  const $ = elements();
  const explanation = '새 월간 자료가 있지만 자동 다운로드 인증이 필요해 기존 작품 판을 유지합니다.';
  const data = {
    years: [2025, 2026],
    update: { state: 'needs_credentials', latest_available_period: '2026-11', new_observation_available: true, explanation },
  };
  const context = vm.createContext({ $, state: { data }, monthly: () => true, periodLabel: String, periodName: String });
  vm.runInContext(applicationFunction('updateMetadata') + 'updateMetadata();', context);
  const status = $('release-status').textContent;
  assert.match(status, /인증/);
  assert.match(status, /기존|유지|대기/);
  assert.match(status, /2026[-년 .]+11/, 'The waiting observation period is shown separately from the published one');
});
