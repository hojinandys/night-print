import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PLACE_STORIES, eligiblePlaceStories, placeStoryScene, projectPlace, observationSummary } from '../dist/place-stories.mjs';

const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
const read = (relative) => JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'));
// The live annual edition may advance and intentionally retire these stories.
// Exercise the curated basis without making future publication depend on it.
const annual = { years: [...PLACE_STORIES[0].basis.years], source: { doi: PLACE_STORIES[0].basis.doi },
  units: PLACE_STORIES[0].observation.units,
  experience: { files: PLACE_STORIES.map((story) => ({ region: story.region, sha256: story.basis.interactionHash })) },
  regions: [...new Set(PLACE_STORIES.map((story) => story.region))].map((id) => ({ id, label: id, full_name: `${id} 전체`, districts: [] })) };
const monthly = { ...annual, period: { kind: 'monthly_same_month', month: 10 } };
const stories = eligiblePlaceStories(annual);
const interactionFor = (story) => ({ region: story.region, years: story.basis.years,
  source: { series_sha256: story.observation.sourceHash }, bounds: [-5, -5, 5, 5],
  coordinates: { source_crs: 'EPSG:32652', utm_origin: story.location.utm, utm_to_world_scale: .001 } });
function applicationFunction(name) {
  const start = source.search(new RegExp(`^  (?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0);
  const next = source.slice(start + 1).search(/^  (?:async )?function /m);
  assert.ok(next >= 0);
  return source.slice(start, start + 1 + next);
}
class Element {
  constructor(tag = 'div', attributes = {}) {
    this.tagName = tag; this.attributes = attributes; this.children = []; this.dataset = {};
    const classes = new Set();
    this.classList = { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name), toggle: (name, active) => active ? classes.add(name) : classes.delete(name) };
  }
  get firstElementChild() { return this.children[0] || null; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  setAttribute(key, value) { this.attributes[key] = value; }
  scrollIntoView() {}
  focus() {}
}
function harness(manifest = annual) {
  const nodes = new Map();
  const state = { data: manifest, region: 'all', district: null, compare: false, placeStory: null, yearIndex: 0, interaction: null };
  const context = vm.createContext({
    state, eligiblePlaceStories, placeStoryScene, projectPlace, observationSummary,
    $: (id) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); },
    stopPlay() { context.stops++; }, leaveGuide() {},
    clearPlaceStory() { state.placeStory = null; context.pendingPlaceFocus = null; },
    syncInfo() {}, render() {}, renderDetail() {}, announce() {},
    reducedMotion: { matches: true }, pendingFocus: null, pendingPlaceFocus: null, stops: 0,
    region: () => manifest.regions.find((region) => region.id === state.region), label: (region) => region.label,
    selectedPlaceStory: () => stories.find((story) => story.id === state.placeStory),
    finite: Number.isFinite, fmt: (value, digits = 1, signed = false) => `${signed && value > 0 ? '+' : ''}${value.toFixed(digits)}`,
    pct: (value, signed = false) => `${signed && value > 0 ? '+' : ''}${value.toFixed(1)}%`, units: () => annual.units,
    el: (tag, className, text) => { const node = new Element(tag); node.textContent = text; return node; },
    svgNode: (tag, attributes) => new Element(tag, attributes), viewer: null, commonArea: () => '9년 공통 관측 영역',
  });
  return context;
}

test('each eligible case atomically selects its own region and historical pair without a district', () => {
  assert.equal(stories.length, PLACE_STORIES.length);
  for (const story of stories) {
    const context = harness();
    context.state.interaction = { region: 'previous-region' };
    vm.runInContext(applicationFunction('selectPlaceStory'), context);
    context.selectPlaceStory(story.id);
    assert.equal(context.state.region, story.region);
    assert.equal(context.state.compareA, story.fromYear);
    assert.equal(context.state.compareB, story.toYear);
    assert.equal(context.state.yearIndex, annual.years.indexOf(story.toYear));
    assert.equal(context.state.district, null);
    assert.equal(context.state.compare, true);
    assert.equal(context.state.interaction, null);
    assert.equal(context.pendingPlaceFocus, story.id);
    assert.equal(context.stops, 1);
  }
});

test('the monthly viewer cannot activate an annual historical case', () => {
  const context = harness(monthly);
  vm.runInContext(applicationFunction('selectPlaceStory'), context);
  context.selectPlaceStory(stories[0].id);
  assert.equal(context.state.region, 'all');
  assert.equal(context.state.placeStory, null);
  assert.equal(context.stops, 0);
});

test('manual region and year changes leave case context before the next surface loads', async () => {
  const context = harness();
  context.state.placeStory = stories[0].id;
  vm.runInContext(applicationFunction('setRegion'), context);
  context.setRegion('busan');
  assert.equal(context.state.placeStory, null);
  context.state.placeStory = stories[1].id;
  context.yearRequest = 0;
  context.periodName = String;
  let resolve;
  context.prepareYear = () => new Promise((done) => { resolve = done; });
  context.presentYear = async index => { context.state.yearIndex = index; return true; };
  vm.runInContext(applicationFunction('setYear'), context);
  const pending = context.setYear(2);
  assert.equal(context.state.placeStory, null, 'Old interpretation disappears while the requested year is loading');
  resolve(); await pending;
  assert.equal(context.state.yearIndex, 2);
});

test('map uses exact transformed bounds and 3D focus waits for the matching pair', () => {
  const story = stories[0], context = harness();
  const interaction = interactionFor(story);
  context.state.placeStory = story.id; context.state.region = story.region; context.state.interaction = interaction;
  context.selectedPlaceStory = () => story;
  context.svgNode = (tag, attributes) => new Element(tag, attributes);
  context.$('linked-map').append(new Element('svg'));
  context.viewerReady = true; context.pendingPlaceFocus = story.id;
  const locations = [];
  context.viewer = { regionId: story.region, year: story.fromYear - 1, compareYear: story.toYear,
    setPlaceLocation: (location) => locations.push(location), focusPlace: () => { context.focuses++; } };
  context.focuses = 0;
  vm.runInContext(applicationFunction('renderPlaceLocation'), context);
  context.renderPlaceLocation();
  const projected = projectPlace(story, interaction);
  const overlay = context.$('linked-map').firstElementChild.children[0];
  assert.equal(overlay.children[0].attributes.x, projected.bounds[0]);
  assert.equal(overlay.children[0].attributes.y, -projected.bounds[3]);
  assert.equal(overlay.children[1].attributes.cx, projected.point[0]);
  assert.equal(overlay.children[1].attributes.cy, -projected.point[1]);
  assert.equal(context.focuses, 0, 'The previously displayed surface cannot claim this case yet');
  context.viewer.year = story.fromYear;
  context.renderPlaceLocation();
  assert.equal(context.focuses, 1);
  assert.equal(context.pendingPlaceFocus, null);
  assert.equal(locations[0].id, story.id);
  assert.match(context.$('map-status').textContent, /공식 사업 경계가 아닙니다/);
});

test('the case sidebar shows local decline and restores administrative scope on exit', () => {
  const story = stories.find((item) => item.id === 'dunchon'), context = harness();
  context.state.placeStory = story.id; context.state.region = story.region;
  vm.runInContext(applicationFunction('renderPlaceSummary') + applicationFunction('clearPlaceStory'), context);
  context.renderPlaceSummary();
  assert.equal(context.$('place-title').textContent, story.location.label);
  assert.match(context.$('place-context').textContent, /1\.5.*행정구역 평균과 별도/);
  assert.equal(context.$('place-case-change').textContent, observationSummary(story).change.toFixed(2));
  assert.ok(context.$('artwork').classList.contains('case-active'));
  assert.equal(context.$('place-case-summary').hidden, false);
  context.clearPlaceStory();
  assert.equal(context.$('place-case-summary').hidden, true);
  assert.equal(context.$('artwork').classList.contains('case-active'), false);
  assert.equal(context.$('place-title').textContent, `${story.region} 전체`);
});

test('each chart names every year and exposes exact values with visible event context', () => {
  for (const story of stories) {
    const context = harness();
    vm.runInContext(applicationFunction('drawPlaceStoryChart'), context);
    context.drawPlaceStoryChart(story);
    const svg = context.$('place-story-chart').firstElementChild;
    const labels = svg.children.filter((node) => node.tagName === 'text').map((node) => String(node.textContent));
    for (const entry of story.observation.series) assert.ok(labels.includes(String(entry.year)));
    assert.equal(svg.children.filter((node) => node.tagName === 'line').length, story.event.years.length);
    assert.match(context.$('place-story-chart-note').textContent, /장소마다 다릅니다/);
    const body = context.$('place-story-table').children[2];
    assert.equal(body.children.length, story.observation.series.length);
    body.children.forEach((row, index) => assert.equal(row.children[1].textContent, String(story.observation.series[index].mean)));
  }
});

test('precise locator remains available when WebGL is unavailable', () => {
  const story = stories[0], context = harness();
  context.state.placeStory = story.id; context.state.region = story.region; context.state.interaction = interactionFor(story);
  context.$('linked-map').append(new Element('svg')); context.viewerReady = false;
  vm.runInContext(applicationFunction('renderPlaceLocation'), context);
  context.renderPlaceLocation();
  assert.equal(context.$('linked-map').firstElementChild.children[0].attributes.class, 'map-place-story');
  assert.match(context.$('map-status').textContent, /살펴보는 범위/);
});

test('a future annual edition hides historical cases without preventing the viewer from loading', () => {
  const future = { ...annual, years: [...annual.years, annual.years.at(-1) + 1] }, context = harness(future);
  context.selectedPlaceStory = () => eligiblePlaceStories(future).find((story) => story.id === context.state.placeStory);
  context.viewerReady = false;
  vm.runInContext(applicationFunction('renderPlaceStories') + applicationFunction('renderPlaceLocation'), context);
  context.renderPlaceStories(); context.renderPlaceLocation();
  assert.equal(context.$('place-stories').hidden, true);
  assert.equal(context.$('place-story-panel').hidden, true);
  assert.equal(context.$('linked-map').children.length, 0);
});
