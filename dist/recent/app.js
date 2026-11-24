'use strict';
import { createGuide, guideScene } from './story.mjs?v=526b8b596811';
import { createImmersiveFocus } from './immersive-focus.mjs';
import { createObservationCache } from './observation-cache.mjs';
import { createPlayback } from './playback.mjs';
import { createPlaybackSpeed, PLAYBACK_SPEED_KEY } from './playback-speed.mjs?v=7d9a364fda9d';
import { eligiblePlaceStories, placeStoryScene, projectPlace, observationSummary } from './place-stories.mjs?v=8a5b4c065740';
(() => {
  const $ = (id) => document.getElementById(id);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const playbackSpeed = createPlaybackSpeed({
    read: () => window.localStorage.getItem(PLAYBACK_SPEED_KEY),
    write: value => window.localStorage.setItem(PLAYBACK_SPEED_KEY, value),
  });
  const state = { data: null, region: 'all', mode: 'absolute', yearIndex: 0, district: null, zoom: false, renderToken: 0, guide: null, guideTarget: null, compare: false, compareA: null, compareB: null, quality: false, threshold: '0.5', infoHidden: false, immersive: false, archiveId: null, history: null, historyLoading: false, interaction: null, placeStory: null };
  const interactionCache = createObservationCache();
  const immersiveFocus = createImmersiveFocus($('artwork'), $('cinema-toggle'));
  let loadingKey = '', loadingPromise = null, mapToken = 0, historyToken = 0, yearRequest = 0;
  let viewerModulePromise = null, webglUnavailable = false, rendererUnavailable = false;
  const imageCache = new Map();
  const viewerModule = () => viewerModulePromise ||= import('./viewer3d.js?v=4688a72fd4e6');
  let viewerPromise = null, viewer = null, viewerKey = '', viewerReady = false, pendingFocus = null;
  let pendingPlaceFocus = null, pendingComparison = null, pendingYearPresentation = null;
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  const fmt = (v, digits = 1, signed = false) => finite(v) ? `${signed && v > 0 ? '+' : ''}${v.toFixed(digits)}` : '—';
  const pct = (v, signed = false) => `${fmt(v, 1, signed)}${finite(v) ? '%' : ''}`;
  const label = (r) => r.label || r.name || r.full_name || r.id;
  const year = () => state.data.years[state.yearIndex];
  const baseline = () => state.data.baseline_year || state.data.years[0];
  const monthly = () => state.data?.period?.kind === 'monthly_same_month';
  const periodLabel = (y) => state.data.period?.labels?.[String(y)] || (monthly() ? `${y}.${String(state.data.period.month).padStart(2, '0')}` : String(y));
  const periodName = (y) => monthly() ? `${y}년 ${state.data.period.month}월` : `${y}년`;
  const observation = () => monthly() ? '월간 관측값' : '연평균 관측값';
  const commonArea = () => monthly() ? `${state.data.years.length === 2 ? '두' : state.data.years.length} 시점 공통 관측 영역` : `${state.data.years.length}년 공통 관측 영역`;
  const units = () => state.data.units || 'nW/cm²/sr';
  const region = () => state.data.regions.find((r) => r.id === state.region);
  const announce = (message) => { $('announcer').textContent = message; };
  function series(entity, index = state.yearIndex) {
    const item = entity.series?.find((s) => Number(s.year) === Number(state.data.years[index]));
    if (item) return item;
    const mean = entity.means?.[index], first = entity.means?.[0];
    return { year: state.data.years[index], mean, change: Number.isFinite(mean) && Number.isFinite(first) ? mean - first : null, percent_change: first > 0 ? (mean / first - 1) * 100 : null, decreased_area_pct: index === state.data.years.length - 1 ? entity.decreased_area_pct : null };
  }
  function imagePath(r, selectedYear = year(), mode = state.mode) {
    return editionAsset(r.render?.[mode]?.find((f) => Number(f.year) === Number(selectedYear))?.url || '');
  }
  const yearIndex = (y) => state.data.years.findIndex((value) => Number(value) === Number(y));
  const pair = () => state.compare ? [state.compareA, state.compareB] : [baseline(), year()];
  function pairValues(entity) {
    const [a, b] = pair(), first = series(entity, yearIndex(a)), last = series(entity, yearIndex(b));
    const change = finite(first.mean) && finite(last.mean) ? last.mean - first.mean : null;
    return { first, last, change, percent: first.mean > 0 && finite(change) ? change / first.mean * 100 : null };
  }
  function pairRecord(entity) {
    const source = String(entity.id) === String(state.region) ? state.interaction : state.interaction?.districts?.find((d) => String(d.id) === String(entity.id));
    const [a, b] = pair();
    return source?.comparisons?.find((c) => Number(c.from) === Number(a) && Number(c.to) === Number(b));
  }
  async function loadInteraction(r) {
    if (!r.interaction_url) return null;
    const url = editionAsset(r.interaction_url);
    const years = [...state.data.years];
    return interactionCache.get(url, (data) => data?.schema === 1 && data.region === r.id &&
      JSON.stringify(data.years) === JSON.stringify(years) && Array.isArray(data.bounds) &&
      Array.isArray(data.districts) && data.districts.length === r.districts.length).catch(() => null);
  }
  function retryMap() {
    if (!state.data || state.region === 'all') return;
    const r = region();
    interactionCache.clear(editionAsset(r.interaction_url || ''));
    state.interaction = null;
    $('retry-map').disabled = true;
    $('map-status').textContent = '지도와 관측 범위를 다시 불러오고 있습니다.';
    renderDetail();
  }
  function syncMarkers() {
    const showAll = $('show-markers').checked;
    $('hotspots').hidden = false;
    $('hotspots').querySelectorAll('.hotspot').forEach((node) => { node.hidden = !showAll && !node.classList.contains('selected'); });
    viewer?.setMarkersVisible(showAll);
  }
  function leaveGuide() {
    state.guide = null; state.guideTarget = null;
    $('guided-story').hidden = true;
    $('start-guide').setAttribute('aria-expanded', 'false');
    $('regional-guide').setAttribute('aria-expanded', 'false');
  }
  function clearPlaceStory() {
    state.placeStory = null; pendingPlaceFocus = null;
    viewer?.setPlaceLocation(null);
    $('place-story-panel').hidden = true;
    $('place-case-summary').hidden = true;
    $('artwork').classList.remove('case-active');
    $('place-panel-kind').textContent = '지역 기록';
    if (state.data && state.region !== 'all') {
      const r = region(), district = r?.districts.find((item) => String(item.id) === String(state.district));
      if (r) { $('place-title').textContent = district ? district.name : (r.full_name || label(r)); $('place-context').textContent = `이 판의 ${commonArea()} · 면적 가중 평균`; }
    }
    $('linked-map').querySelector('.map-place-story')?.remove();
    $('place-story-choices').querySelectorAll('[data-place-story]').forEach((button) => {
      button.classList.remove('active'); button.setAttribute('aria-pressed', 'false');
    });
  }
  function selectedPlaceStory() {
    return eligiblePlaceStories(state.data).find((story) => story.id === state.placeStory) || null;
  }
  function selectPlaceStory(id) {
    const story = eligiblePlaceStories(state.data).find((item) => item.id === id);
    const scene = story && placeStoryScene(story, state.data);
    if (!scene) return;
    stopPlay(); leaveGuide(); clearPlaceStory();
    const regionChanged = state.region !== scene.region;
    Object.assign(state, scene, { placeStory: story.id, zoom: false, infoHidden: false });
    if (regionChanged) state.interaction = null;
    pendingFocus = null; pendingPlaceFocus = story.id;
    syncInfo(); render();
    $('region-detail').scrollIntoView({ behavior: reducedMotion.matches ? 'instant' : 'smooth', block: 'start' });
    $('place-story-title').focus({ preventScroll: true });
    announce(`${story.title}. ${story.fromYear}년과 ${story.toYear}년의 밝기를 비교합니다. 지도에 장소와 살펴보는 범위를 표시합니다.`);
  }
  function renderPlaceStories() {
    const stories = eligiblePlaceStories(state.data), choices = $('place-story-choices');
    $('place-stories').hidden = stories.length === 0;
    $('place-stories').classList.toggle('compact', state.region !== 'all');
    const key = stories.map((story) => story.id).join('/');
    if (choices.dataset.key !== key) {
      choices.replaceChildren(); choices.dataset.key = key;
      stories.forEach((story, index) => {
        const button = el('button', 'place-story-choice'); button.type = 'button'; button.dataset.placeStory = story.id;
        button.setAttribute('aria-controls', 'place-story-panel');
        const place = state.data.regions.find((item) => item.id === story.region);
        button.append(el('span', 'place-story-choice-meta', `0${index + 1} · ${label(place || { id: story.region })} · ${story.fromYear}–${story.toYear}`), el('span', 'place-story-choice-location', story.location.label), el('strong', '', story.title), el('span', 'place-story-choice-action', '이 장소 살펴보기 ↗'));
        button.addEventListener('click', () => selectPlaceStory(story.id)); choices.append(button);
      });
    }
    const story = selectedPlaceStory();
    choices.querySelectorAll('[data-place-story]').forEach((button) => {
      const active = button.dataset.placeStory === story?.id;
      button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
    });
    $('place-story-panel').hidden = !story;
    if (!story) return;
    const values = observationSummary(story), observed = story.observation;
    $('place-story-period').textContent = `${story.fromYear}–${story.toYear} · 연간 관측과 장소의 기록`;
    $('place-story-title').textContent = story.title;
    $('place-story-location').textContent = `${story.location.label} · 지도 점은 장소, 사각형은 살펴보는 범위입니다. 공식 사업 경계가 아닙니다.`;
    $('place-story-observation').textContent = `${observed.scopeLabel}의 평균 복사휘도는 ${story.fromYear}년 ${fmt(values.from, 2)}에서 ${story.toYear}년 ${fmt(values.to, 2)} ${units()}로 변했습니다. 차이는 ${fmt(values.change, 2, true)} ${units()}${finite(values.percent) ? ` (${pct(values.percent, true)})` : ''}입니다.`;
    $('place-story-scope').textContent = `범위 중 계산 면적 ${fmt(observed.areaKm2, 2)} km² (${pct(observed.coveragePct)}) · ${observed.cellCount}개 500 m 집계칸. 같은 위치의 공통 관측을 집계했으며 개별 가게를 구분할 수 없습니다. 새벽의 빛이며 매출·방문객을 뜻하지 않습니다.`;
    $('place-story-event').textContent = `${story.event.date} · ${story.event.fact}`;
    const sources = $('place-story-sources'); sources.replaceChildren();
    const links = [...story.event.sources];
    if (story.location.sourceUrl) links.push({ title: `위치 확인 · ${story.location.sourceTitle}`, url: story.location.sourceUrl });
    links.forEach((source) => {
      const item = el('li'), link = el('a', '', `${source.title} ↗`);
      link.href = source.url; link.target = '_blank'; link.rel = 'noreferrer'; item.append(link); sources.append(item);
    });
    $('place-story-anchor-note').textContent = story.location.anchorNote || '';
    $('place-story-interpretation').textContent = story.interpretation;
    $('place-story-limits').textContent = Array.isArray(story.limits) ? story.limits.join(' ') : story.limits;
    $('place-story-question').textContent = story.question || '';
    drawPlaceStoryChart(story);
  }
  function renderPlaceSummary() {
    const story = selectedPlaceStory(), values = story && observationSummary(story);
    if (!story || !values) return;
    $('artwork').classList.add('case-active');
    $('place-panel-kind').textContent = '장소의 주변 관측';
    $('place-title').textContent = story.location.label;
    $('place-context').textContent = '고정 1.5 × 1.5 km 주변 범위 · 행정구역 평균과 별도';
    $('detail-label').textContent = `${story.location.label} · ${story.fromYear}–${story.toYear} · 주변 평균 ${finite(values.percent) ? pct(values.percent, true) : `${fmt(values.change, 2, true)} ${units()}`}`;
    $('point-instruction').textContent = '금빛 표시는 장소의 위치입니다. 주변의 관측값과 공식 기록을 함께 읽어보세요.';
    $('place-case-summary').hidden = false;
    $('place-case-summary').classList.toggle('decreased', values.change < 0);
    $('place-case-period').textContent = `${story.fromYear} → ${story.toYear} · 주변 평균의 차이`;
    $('place-case-change').textContent = fmt(values.change, 2, true);
    $('place-case-percent').textContent = finite(values.percent) ? `${story.fromYear}년 대비 ${pct(values.percent, true)}` : '기준값이 0이므로 변화율을 표시하지 않습니다.';
    $('place-case-from-label').textContent = `${story.fromYear}년`; $('place-case-to-label').textContent = `${story.toYear}년`;
    $('place-case-from').textContent = fmt(values.from, 2); $('place-case-to').textContent = fmt(values.to, 2);
    $('place-case-scope').textContent = `단위: ${units()}. 사각 범위 중 계산 면적 ${fmt(story.observation.areaKm2, 2)} km² (${pct(story.observation.coveragePct)}). 다른 구·군·시를 고르면 지역 기록으로 돌아갑니다.`;
  }
  function drawPlaceStoryChart(story) {
    const target = $('place-story-chart'), series = story.observation.series;
    target.replaceChildren();
    if (!series.length || series.some((entry) => !finite(entry.mean))) return;
    const values = series.map((entry) => entry.mean), low = Math.min(...values), high = Math.max(...values), span = high - low || 1;
    const firstYear = series[0].year, yearSpan = series.at(-1).year - firstYear || 1;
    const points = series.map((entry) => [24 + (entry.year - firstYear) / yearSpan * 312, 97 - (entry.mean - low) / span * 65]);
    const eventYears = (story.event.years || []).filter((year) => series.some((entry) => entry.year === year));
    const svg = svgNode('svg', { viewBox: '0 0 360 134', 'aria-hidden': 'true' });
    eventYears.forEach((year) => {
      const [x] = points[series.findIndex((entry) => entry.year === year)];
      svg.append(svgNode('line', { x1: x, x2: x, y1: 23, y2: 105, stroke: '#b9996b', 'stroke-width': 1, 'stroke-dasharray': '3 4', opacity: .7 }));
    });
    svg.append(svgNode('polyline', { points: points.map((point) => point.join(',')).join(' '), fill: 'none', stroke: '#8e989f', 'stroke-width': 1.4 }));
    points.forEach(([x, y], index) => {
      const active = [story.fromYear, story.toYear].includes(series[index].year);
      const dot = svgNode('circle', { cx: x, cy: y, r: active ? 3.5 : 1.8, fill: active ? '#e5c391' : '#8e989f' });
      const title = svgNode('title'); title.textContent = `${series[index].year}년 ${fmt(series[index].mean, 2)} ${units()}`; dot.append(title); svg.append(dot);
    });
    series.forEach((entry, index) => {
      const event = eventYears.includes(entry.year);
      const node = svgNode('text', { x: points[index][0], y: 124, 'text-anchor': 'middle', fill: event ? '#e5c391' : '#a6acb1', 'font-size': 11, 'font-weight': event ? 'bold' : 'normal' }); node.textContent = entry.year; svg.append(node);
    });
    const range = svgNode('text', { x: 336, y: 12, 'text-anchor': 'end', fill: '#a6acb1', 'font-size': 10 });
    range.textContent = `세로축 ${fmt(low, 2)}–${fmt(high, 2)} ${units()}`; svg.append(range); target.append(svg);
    $('place-story-chart-note').textContent = `점선·금빛 연도: 공식 기록 시점${eventYears.length ? ` (${eventYears.join('·')}년)` : ''}. 세로축 범위는 장소마다 다릅니다. 선은 연간 관측을 연결하며 사건의 효과를 나타내지 않습니다.`;
    target.setAttribute('aria-label', `${story.observation.scopeLabel}의 연평균 복사휘도. ${series.map((entry) => `${entry.year}년 ${fmt(entry.mean, 2)}`).join(', ')} ${units()}. 공식 기록 시점 ${eventYears.join(', ')}년. 세로축 ${fmt(low, 2)}부터 ${fmt(high, 2)}이며 장소마다 범위가 다릅니다.`);
    const table = $('place-story-table'); table.replaceChildren();
    const caption = el('caption', '', `${story.location.label} 연평균 복사휘도 · ${units()}`), head = el('thead'), row = el('tr');
    ['연도', '관측값', '공식 기록 시점'].forEach((text) => { const th = el('th', '', text); th.scope = 'col'; row.append(th); }); head.append(row);
    const body = el('tbody');
    series.forEach((entry) => {
      const row = el('tr'), yearCell = el('th', '', String(entry.year)); yearCell.scope = 'row';
      row.append(yearCell, el('td', '', String(entry.mean)), el('td', '', eventYears.includes(entry.year) ? '해당' : '—')); body.append(row);
    });
    table.append(caption, head, body);
  }
  function renderPlaceLocation() {
    const story = selectedPlaceStory(), map = $('linked-map'), svg = map.firstElementChild;
    map.querySelector('.map-place-story')?.remove();
    const projected = story && state.interaction?.region === story.region ? projectPlace(story, state.interaction) : null;
    if (!projected) {
      if (viewerReady) viewer.setPlaceLocation(null);
      if (story) {
        $('map-status').textContent = `${story.location.label}의 상세 위치 표시를 준비하지 못했습니다. 지도 다시 불러오기를 누르거나 아래 위치 출처를 확인하세요.`;
        $('retry-map').hidden = false; $('retry-map').disabled = false;
      }
      return;
    }
    const location = { ...projected, id: story.id, label: story.location.label };
    if (svg) {
      const [x, y] = location.point, [west, south, east, north] = location.bounds;
      const size = Math.max(state.interaction.bounds[2] - state.interaction.bounds[0], state.interaction.bounds[3] - state.interaction.bounds[1]);
      const group = svgNode('g', { class: 'map-place-story', 'aria-label': `${location.label} 위치와 관측 범위. 공식 사업 경계가 아닙니다.`, role: 'img' });
      group.append(svgNode('rect', { x: west, y: -north, width: east - west, height: north - south, class: 'map-place-bounds' }));
      group.append(svgNode('circle', { cx: x, cy: -y, r: size * .013, class: 'map-place-point' }));
      const title = svgNode('title'); title.textContent = `${location.label} · 사각형은 주변 관측 범위`; group.append(title); svg.append(group);
    }
    $('map-status').textContent = `${location.label} · 점은 장소, 사각형은 살펴보는 범위입니다. 공식 사업 경계가 아닙니다.`;
    if (viewerReady && viewer.regionId === story.region && Number(viewer.year) === story.fromYear && Number(viewer.compareYear) === story.toYear) {
      viewer.setPlaceLocation(location);
      if (pendingPlaceFocus === story.id) { viewer.focusPlace(); pendingPlaceFocus = null; }
    }
  }
  function editionAsset(path) {
    const version = state.data?.release_id || state.data?.updated_utc;
    return path && version ? `${path}${path.includes('?') ? '&' : '?'}v=${encodeURIComponent(version)}` : path;
  }
  function el(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  const playback = createPlayback({
    prepare: async (index) => {
      $('timeline-caption').textContent = `${periodName(state.data.years[index])} 준비 중 · 현재 장면을 유지합니다`;
      await prepareYear(index);
    },
    present: async (index) => {
      const request = yearRequest;
      if (!await presentYear(index, request)) return;
      if (request !== yearRequest || !playback.playing) return;
      $('timeline-caption').textContent = state.mode === 'change' && year() === baseline()
        ? '기준 관측 · 같은 값을 뺀 차이는 0입니다'
        : '관측 사이를 부드럽게 연결 · 중간 움직임은 시각적 보간';
    },
    delayMs: () => playbackSpeed.timing({ reducedMotion: reducedMotion.matches }).dwellMs,
    onState: syncPlayback,
    onError: () => { $('timeline-caption').textContent = '다음 관측을 불러오지 못해 멈췄습니다. 현재 장면은 유지합니다. 다시 재생해 주세요.'; },
  });
  function syncPlayback(playing) {
      $('play-years').setAttribute('aria-label', playing ? '관측 재생 멈추기' : monthly() ? '같은 달 관측 재생' : '관측 연도 재생');
      $('play-years').setAttribute('aria-pressed', String(playing));
      $('play-years').innerHTML = playing
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zm7 0h4v14h-4z" fill="currentColor"/></svg><span>멈추기</span>'
        : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5 19 12 8 18.5Z" fill="currentColor"/></svg><span>${monthly() ? '관측 재생' : '연도 재생'}</span>`;
      if (!playing) $('timeline-caption').textContent = '같은 관측 영역 · 같은 높이 규칙';
  }
  function stopPlay() {
    ++yearRequest;
    cancelYearPresentation();
    cancelPendingComparison();
    playback.stop();
    syncPlayback(false);
  }
  function syncComparisonControls(message = '같은 위치 · 같은 높이 규칙 · 함께 움직이는 시점') {
    if (state.data) {
      $('compare-a').value = String(state.compareA);
      $('compare-b').value = String(state.compareB);
    }
    $('pair-controls').setAttribute('aria-busy', String(!!pendingComparison));
    const note = $('pair-controls').querySelector('p');
    note.setAttribute('role', 'status'); note.textContent = message;
  }
  function cancelPendingComparison() {
    pendingComparison = null;
    syncComparisonControls();
  }
  async function prepareComparison(r, a, b) {
    if (r.webgl && !webglUnavailable && !rendererUnavailable) {
      const module = await viewerModule();
      await Promise.all([module.preloadFrame(r, a, 'absolute'), module.preloadFrame(r, b, 'absolute')]);
    } else {
      await Promise.all([prepareImage(imagePath(r, a, 'absolute')), prepareImage(imagePath(r, b, 'absolute'))]);
    }
  }
  async function setComparison(axis, value) {
    const selected = Number(value);
    if (!state.data || !state.compare || state.region === 'all' ||
        !['a', 'b'].includes(axis) || !state.data.years.includes(selected)) return false;
    // Successive A/B choices extend the pending request, while controls and
    // observations continue to describe the complete pair already on screen.
    const previous = pendingComparison;
    const requested = { a: previous?.a ?? state.compareA, b: previous?.b ?? state.compareB,
      data: state.data, region: state.region };
    requested[axis] = selected;
    stopPlay();
    if (requested.a === state.compareA && requested.b === state.compareB) return true;
    pendingComparison = requested;
    syncComparisonControls(`${periodName(requested.a)} · ${periodName(requested.b)} 준비 중 · 현재 두 관측을 유지합니다`);
    const current = () => pendingComparison === requested && state.data === requested.data &&
      state.region === requested.region && state.compare;
    try {
      await prepareComparison(region(), requested.a, requested.b);
      if (!current()) return false;
      pendingComparison = null;
      leaveGuide(); clearPlaceStory();
      state.compareA = requested.a; state.compareB = requested.b;
      state.yearIndex = yearIndex(requested.b);
      syncComparisonControls();
      await render();
      return true;
    } catch (error) {
      if (!current()) return false;
      pendingComparison = null;
      const message = '두 관측을 불러오지 못해 이전 비교를 유지했습니다. 연도를 다시 선택해 주세요.';
      syncComparisonControls(message); announce(message);
      return false;
    }
  }
  function playYears() {
    if (!state.data || state.compare) return;
    leaveGuide(); clearPlaceStory();
    if (playback.playing) { stopPlay(); return; }
    stopPlay();
    const first = state.yearIndex === state.data.years.length - 1 ? 0 : state.yearIndex;
    playback.start(state.data.years.map((_, index) => index).slice(first));
  }
  async function setYear(index) {
    leaveGuide(); clearPlaceStory(); stopPlay();
    const request = ++yearRequest;
    index = Math.max(0, Math.min(state.data.years.length - 1, Number(index)));
    $('timeline-caption').textContent = `${periodName(state.data.years[index])} 준비 중 · 현재 장면을 유지합니다`;
    // Keep the slider, year, statistics and actual surface on one observation.
    $('year-slider').value = String(state.yearIndex);
    try {
      await prepareYear(index);
      if (request !== yearRequest) return;
      await presentYear(index, request);
      if (request === yearRequest) $('timeline-caption').textContent = '같은 관측 영역 · 중간 움직임은 시각적 보간';
    } catch (error) {
      if (request === yearRequest) $('timeline-caption').textContent = '관측을 불러오지 못했습니다. 현재 장면을 유지합니다. 연도를 다시 선택해 주세요.';
    }
  }
  function cancelYearPresentation() {
    const pending = pendingYearPresentation;
    pendingYearPresentation = null;
    viewer?.cancelSurfaceTransition?.();
    if (!pending) return;
    for (const animation of pending.animations) animation.cancel();
    for (const overlay of pending.overlays) overlay.remove();
    if (state.data) renderHeading();
    $('artwork').removeAttribute('data-observation-transition');
  }
  async function fadeYearImages(index, pending) {
    const targets = state.region === 'all'
      ? state.data.regions.map((r, i) => ({ image: $('comparison').querySelectorAll('.plate-image-wrap img')[i], region: r }))
      : [{ image: $('single-image'), region: region() }];
    for (const { image, region: r } of targets) {
      if (!image?.animate || !image.parentElement) continue;
      const overlay = image.cloneNode(false); overlay.removeAttribute('id'); overlay.setAttribute('aria-hidden', 'true'); overlay.alt = '';
      if (state.region !== 'all') { overlay.style.position = 'absolute'; overlay.style.inset = '0'; }
      overlay.src = imagePath(r, state.data.years[index], state.mode);
      overlay.style.pointerEvents = 'none'; overlay.style.opacity = '0';
      image.parentElement.append(overlay); pending.overlays.push(overlay);
      pending.animations.push(overlay.animate([{ opacity: 0 }, { opacity: 1 }], { duration: pending.timing.imageMs, easing: 'cubic-bezier(.45,0,.55,1)', fill: 'forwards' }));
    }
    try { await Promise.all(pending.animations.map(animation => animation.finished)); return true; }
    catch { return false; }
  }
  async function presentYear(index, request) {
    if (request !== yearRequest || !state.data) return false;
    if (index === state.yearIndex) return true;
    const pending = { data: state.data, region: state.region, mode: state.mode, animations: [], overlays: [], timing: playbackSpeed.timing({ reducedMotion: reducedMotion.matches }) };
    pendingYearPresentation = pending;
    const current = () => pendingYearPresentation === pending && request === yearRequest &&
      state.data === pending.data && state.region === pending.region && state.mode === pending.mode && !state.compare;
    try {
    const from = year(), to = state.data.years[index];
    if (!reducedMotion.matches) {
      $('artwork').setAttribute('data-observation-transition', 'true');
      $('scene-year').textContent = `${periodLabel(from)} → ${periodLabel(to)}`;
      $('scene-year-note').textContent = '전환 중 · 중간 표면은 관측값이 아닙니다';
      $('timeline-caption').textContent = `${periodName(from)} → ${periodName(to)} · 시각적 연결 중 · 수치는 ${periodName(from)} 관측`;
      const complete = state.region !== 'all' && viewerReady && !webglUnavailable && !rendererUnavailable
        ? await viewer.transitionTo(region(), to, state.mode, { duration: pending.timing.surfaceMs })
        : await fadeYearImages(index, pending);
      if (!complete) {
        if (current()) { cancelYearPresentation(); throw new Error('Observation transition interrupted'); }
        return false;
      }
      if (!current()) return false;
    }
    if (!current()) return false;
    state.yearIndex = index;
    const displayed = await render();
    if (!current()) return false;
    pendingYearPresentation = null;
    for (const animation of pending.animations) animation.cancel();
    for (const overlay of pending.overlays) overlay.remove();
    $('artwork').removeAttribute('data-observation-transition');
    if (displayed === false) throw new Error('Observation could not be displayed');
    return true;
    } catch (error) {
      if (pendingYearPresentation === pending) cancelYearPresentation();
      throw error;
    }
  }
  function prepareImage(url) {
    if (imageCache.has(url)) return imageCache.get(url);
    const image = new Image(); image.src = url;
    const pending = image.decode(); imageCache.set(url, pending);
    while (imageCache.size > 20) imageCache.delete(imageCache.keys().next().value);
    pending.catch(() => { if (imageCache.get(url) === pending) imageCache.delete(url); });
    return pending;
  }
  async function prepareYear(index) {
    const selectedYear = state.data.years[index], mode = state.mode;
    const regions = state.region === 'all' ? state.data.regions : [region()];
    if (state.region !== 'all' && regions[0].webgl && !webglUnavailable) {
      const module = await viewerModule();
      if (rendererUnavailable) await prepareImage(imagePath(regions[0], selectedYear, mode));
      else await module.preloadFrame(regions[0], selectedYear, mode);
    } else {
      await Promise.all(regions.map((r) => prepareImage(imagePath(r, selectedYear, mode))));
    }
  }
  function setRegion(id) {
    if (!state.data || (id !== 'all' && !state.data.regions.some((r) => r.id === id))) return;
    leaveGuide(); clearPlaceStory(); stopPlay(); state.region = id; state.district = null; state.zoom = false; state.interaction = null; if (id === 'all') state.compare = false; render();
    $('artwork').scrollIntoView({ behavior: reducedMotion.matches ? 'instant' : 'smooth', block: 'start' });
    announce(id === 'all' ? '세 지역 비교' : `${label(region())} 안의 구·군·시를 선택할 수 있습니다.`);
  }
  function setMode(mode, fromStory = false) {
    if (!state.data) return;
    leaveGuide(); clearPlaceStory(); stopPlay(); state.compare = false; state.mode = mode;
    if (fromStory) { state.yearIndex = state.data.years.length - 1; }
    render();
    if (fromStory) $('artwork').scrollIntoView({ behavior: reducedMotion.matches ? 'instant' : 'smooth', block: 'start' });
    announce(mode === 'change' ? `${periodName(baseline())}의 빛을 뺀 변화입니다. 금빛은 증가, 푸른빛은 감소입니다.` : `${observation()}의 밝기 장면입니다.`);
  }
  function selectDistrict(id) {
    if (!state.data || state.region === 'all') return;
    stopPlay();
    cancelPendingComparison();
    leaveGuide(); clearPlaceStory(); state.district = id || null; state.zoom = !!id; renderDetail();
    if (viewerReady) { viewer.select(id); if (id) viewer.focus(id); }
    else pendingFocus = id || null;
    const d = region().districts.find((x) => String(x.id) === String(id));
    if (d) { const values = pairValues(d); announce(`${d.name}의 경계와 정보를 선택했습니다. ${periodName(pair()[0])}부터 ${periodName(pair()[1])}까지 평균 ${pct(values.percent, true)}.`); }
  }
  function fallback3D(message) {
    webglUnavailable = true; viewerReady = false; viewer?.setActive(false); $('webgl-view').hidden = true; $('single-scene').hidden = state.compare; $('pair-fallback').hidden = !state.compare; $('webgl-status').hidden = true;
    $('view-compass').hidden = true;
    $('orbit-instruction').textContent = message; $('reset-view').textContent = '선택 해제'; $('reset-view').hidden = !state.district;
  }
  function update3D(r) {
    const selectedYear = state.compare ? state.compareA : year(), compareYear = state.compare ? state.compareB : undefined, selectedMode = state.compare ? 'absolute' : state.mode;
    const key = `${state.data.release_id || state.data.updated_utc}/${r.id}/${selectedMode}/${selectedYear}/${compareYear}/${r.webgl?.grid_url || r.interaction_url}`;
    if (viewerReady && key === viewerKey && !loadingKey) { viewer.setActive(true); viewer.select(state.district); viewer.setQualityVisible?.(state.quality); if (state.placeStory) renderPlaceLocation(); return Promise.resolve(true); }
    if (loadingKey === key) return loadingPromise;
    loadingKey = key;
    const token = ++state.renderToken;
    const retainSurface = viewerReady && viewer.regionId === r.id && viewer.mode === selectedMode &&
      viewer.comparing === state.compare && viewer.spec?.static_url === r.webgl?.static_url;
    if (!retainSurface) {
      viewerReady = false; viewer?.setActive(false); $('webgl-view').hidden = true; $('single-scene').hidden = state.compare; $('pair-fallback').hidden = !state.compare; $('view-compass').hidden = true;
      $('orbit-instruction').textContent = '3D 지형을 준비하고 있습니다. 현재 보이는 장면은 정지 이미지입니다.';
    }
    $('webgl-status').hidden = retainSurface;
    $('webgl-status').textContent = state.compare ? '두 관측의 입체를 불러오는 중' : '회전 가능한 입체를 불러오는 중';
    if (!r.webgl || rendererUnavailable) { loadingKey = ''; fallback3D('실제 관측의 정지 이미지로 감상합니다. 구역별 정보와 연도 재생은 그대로 사용할 수 있습니다.'); return Promise.resolve(true); }
    loadingPromise = (async () => {
    try {
      if (!viewerPromise) viewerPromise = viewerModule().then(({ ReliefViewer }) => {
        viewer = new ReliefViewer($('webgl-view'), {
          onSelect: selectDistrict,
          onError: () => { rendererUnavailable = true; fallback3D('3D 표시가 중단되어 실제 관측의 정지 이미지로 전환했습니다. 새로고침하면 다시 시도합니다.'); },
          onMove: () => { $('reset-view').hidden = false; },
          onView: ({ northAngle = 0, comparing, comparisonAxis = 'horizontal' }) => {
            $('compass-arrow').style.transform = `rotate(${northAngle}deg)`;
            $('single-viewport').dataset.comparisonAxis = comparisonAxis;
            $('pair-labels').dataset.comparisonAxis = comparisonAxis;
          }
        }); return viewer;
      }).catch((error) => { rendererUnavailable = true; throw error; });
      const instance = await viewerPromise;
      if (token !== state.renderToken || state.region === 'all') return;
      const loaded = await instance.show(r, selectedYear, selectedMode, { compareYear, interaction: state.interaction });
      if (!loaded || token !== state.renderToken || state.region === 'all') return;
      // A map retry may have recovered while the surface was still loading.
      if (state.interaction && instance.interaction !== state.interaction) instance.setInteraction(state.interaction);
      viewerKey = key; viewerReady = true; webglUnavailable = false; $('single-scene').hidden = true; $('pair-fallback').hidden = true; $('single-image-error').hidden = true; $('webgl-view').hidden = false; $('webgl-status').hidden = true; $('view-compass').hidden = false;
      instance.setActive(true); instance.setMarkersVisible($('show-markers').checked); instance.select(state.district); instance.setQualityVisible?.(state.quality);
      if (pendingFocus && pendingFocus === state.district) instance.focus(pendingFocus);
      pendingFocus = null; $('reset-view').hidden = false; $('reset-view').textContent = '원래 시점';
      if (state.placeStory) renderPlaceLocation();
      $('orbit-instruction').textContent = state.compare ? '어느 쪽을 드래그해도 같은 각도로 회전합니다. 휠로 확대 · 방향키로 회전 · R 원래 시점' : '드래그해 회전 · 휠 또는 두 손가락으로 확대 · 방향키로 회전 · + / − 확대 · R 원래 시점';
      return true;
    } catch (error) {
      if (token !== state.renderToken) return;
      console.warn('3D unavailable:', error); fallback3D('이 기기에서 3D를 불러오지 못해 실제 관측의 정지 이미지를 표시합니다. 구역별 정보는 그대로 확인할 수 있습니다.');
      return false;
    } finally { if (token === state.renderToken) { loadingKey = ''; loadingPromise = null; } }
    })();
    return loadingPromise;
  }
  function renderHeading() {
    const changed = state.mode === 'change';
    $('scene-year').textContent = changed ? `${periodLabel(year())} − ${periodLabel(baseline())}` : periodLabel(year());
    $('scene-year-note').textContent = changed ? `같은 위치의 ${observation()} 차이` : observation();
    $('art-title').textContent = changed ? '빛이 늘고 줄어든 곳' : '빛을 높이로 옮기다';
    $('scene-description').textContent = changed ? '금빛은 증가, 푸른빛은 감소. 높이는 기준 관측과의 차이입니다.' : state.region === 'all' ? '작품을 고르면 회전하며 살펴볼 수 있습니다.' : '드래그해 회전하고, 지도에서 익숙한 곳을 찾아보세요.';
    if (year() === baseline() && changed) $('scene-description').textContent = '비교의 기준이 되는 관측입니다. 같은 관측에서 같은 값을 빼면 차이는 0입니다.';
    $('story-hint').textContent = '지역을 고르면 작품을 돌려 볼 수 있습니다.';
    const action = $('reveal-change'); action.replaceChildren(document.createTextNode(changed ? '밝기 보기 ' : '빛의 변화 보기 '));
    action.append(el('span', '', changed ? observation() : `${periodName(baseline())}을 기준으로`));
    $('legend').innerHTML = changed ? '<span class="legend-line gold"></span>금빛: 증가 <span class="legend-separator">/</span><span class="legend-line blue"></span>푸른빛: 감소 <span class="legend-separator">/</span>높이: 기준 관측과의 차이' : `<span class="legend-line gold"></span>높이: ${observation()} <span class="legend-separator">/</span>선: 같은 표시 높이`;
    document.querySelectorAll('[data-region]').forEach((button) => { const active = button.dataset.region === state.region; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
    document.querySelectorAll('[data-mode]').forEach((button) => { const active = button.dataset.mode === state.mode; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
    $('year-slider').value = String(state.yearIndex); $('year-slider').setAttribute('aria-valuetext', periodName(year())); $('selected-year').textContent = periodLabel(year());
    document.querySelectorAll('[data-year-index]').forEach((button) => { const active = Number(button.dataset.yearIndex) === state.yearIndex; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
    $('artwork').classList.toggle('pair-mode', state.compare);
    $('artwork').classList.toggle('information-hidden', state.infoHidden);
    $('pair-controls').hidden = !state.compare;
    $('pair-labels').hidden = !state.compare;
    $('timeline').hidden = state.compare;
    $('compare-toggle').setAttribute('aria-pressed', String(state.compare));
    $('compare-action').textContent = state.compare ? '비교 끄기' : '비교 켜기';
    $('compare-toggle').setAttribute('aria-label', state.compare ? '두 시점 비교 끄기, 한 작품으로 보기' : '두 시점 비교 켜기');
    $('compare-toggle').title = state.compare ? `${periodLabel(state.compareB)}의 한 작품으로 돌아갑니다` : '현재 보는 관측과 다른 시점을 나란히 봅니다';
    $('regional-guide').textContent = state.region === 'all' ? '세 지역 이야기' : `${label(region())}의 이야기`;
    $('regional-guide').setAttribute('aria-expanded', String(state.guide !== null));
    const regionalToolsUnavailable = state.region === 'all';
    document.querySelector('.experience-tools').hidden = regionalToolsUnavailable;
    ['compare-toggle', 'quality-toggle'].forEach((id) => {
      $(id).disabled = regionalToolsUnavailable;
      if (regionalToolsUnavailable) $(id).setAttribute('aria-describedby', 'regional-tools-note');
      else $(id).removeAttribute('aria-describedby');
    });
    $('regional-tools-note').hidden = true;
    $('quality-toggle').setAttribute('aria-pressed', String(state.quality));
    $('info-toggle').disabled = regionalToolsUnavailable;
    $('quality-panel').hidden = !state.quality;
    document.querySelectorAll('[data-mode]').forEach((button) => { button.disabled = state.compare; });
    if (state.compare) {
      $('scene-year').textContent = `${periodLabel(state.compareA)} ↔ ${periodLabel(state.compareB)}`;
      $('scene-year-note').textContent = '둘 다 실제 관측 · 밝기 대 밝기';
      $('art-title').textContent = '두 시점의 밤';
      $('scene-description').textContent = '같은 각도와 높이 규칙으로 봅니다. 어느 쪽을 돌려도 함께 움직입니다.';
      $('compare-a').value = String(state.compareA); $('compare-b').value = String(state.compareB);
      $('pair-label-a').textContent = `A · ${periodLabel(state.compareA)}`; $('pair-label-b').textContent = `B · ${periodLabel(state.compareB)}`;
    }
  }
  function renderComparison() {
    const container = $('comparison'); container.replaceChildren();
    state.data.regions.forEach((r, index) => {
      const values = series(r), plate = el('figure', 'art-plate'), button = el('button', 'plate-button'); button.type = 'button'; button.setAttribute('aria-label', `${label(r)} 확대하고 구·군·시 보기`); button.addEventListener('click', () => setRegion(r.id));
      const heading = el('div', 'plate-label'); heading.append(el('span', 'plate-index', `0${index + 1}`), el('h2', '', label(r)), el('span', 'plate-link', '3D로 보기 ↗'));
      const value = el('p', 'plate-value', fmt(state.mode === 'change' ? values.change : values.mean, 2, state.mode === 'change')); value.append(el('small', '', units()));
      const visual = el('div', 'plate-image-wrap'), img = el('img'); img.src = imagePath(r); img.alt = `${label(r)} ${periodName(year())} ${state.mode === 'change' ? `${periodName(baseline())} 대비 변화` : observation()} 입체 작품`; img.draggable = false; img.decoding = 'async';
      img.addEventListener('error', () => { visual.replaceChildren(el('p', 'image-failure', '이 관측의 이미지를 불러오지 못했습니다.')); });
      visual.append(img); button.append(heading, visual); plate.append(button);
      const caption = el('figcaption', 'plate-summary');
      const measurement = el('div', 'plate-measurement'); measurement.append(el('span', 'metric-caption', state.mode === 'change' ? '평균 변화량' : '평균 복사휘도'), value); caption.append(measurement);
      const growth = el('p', 'summary-row'); growth.append(el('span', '', `${periodLabel(baseline())} 대비 평균`), el('strong', '', pct(values.percent_change, true))); caption.append(growth);
      if (state.mode === 'change') {
        const decrease = el('p', 'summary-row decrease-row'); decrease.append(el('span', '', '값이 낮아진 면적'), el('strong', '', pct(values.decreased_area_pct))); caption.append(decrease);
        const bar = el('div', 'decrease-bar'), fill = el('span'); fill.style.width = `${Math.max(0, Math.min(100, Number(values.decreased_area_pct) || 0))}%`; bar.setAttribute('aria-hidden', 'true'); bar.append(fill); caption.append(bar);
        caption.append(el('p', 'plate-footnote', `${commonArea()} 중 ${periodLabel(year())} 값 < ${periodLabel(baseline())} 값. 부호 기준이며 유의성 검정이 아닙니다.`));
      } else caption.append(el('p', 'plate-footnote', `전체 경계 중 공통 관측 영역 ${pct(r.coverage_pct)}. 같은 높이 규칙으로 표현합니다.`));
      plate.append(caption); container.append(plate);
    });
  }
  function drawChart(entity) {
    const target = $('place-chart'); target.replaceChildren();
    const values = state.data.years.map((_, i) => series(entity, i).mean);
    if (!values.every(Number.isFinite)) { target.textContent = '시점별 관측값을 표시할 수 없습니다.'; return; }
    const low = Math.min(...values), high = Math.max(...values), span = high - low || 1;
    const points = values.map((v, i) => [8 + (i / Math.max(1, values.length - 1)) * 230, 56 - (v - low) / span * 40]);
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 246 86');
    const line = document.createElementNS(ns, 'polyline'); line.setAttribute('points', points.map((p) => p.join(',')).join(' ')); line.setAttribute('fill', 'none'); line.setAttribute('stroke', '#8e989f'); line.setAttribute('stroke-width', '1.4'); svg.append(line);
    points.forEach(([x, y], i) => { const dot = document.createElementNS(ns, 'circle'); const active = state.compare ? [Number(state.compareA),Number(state.compareB)].includes(Number(state.data.years[i])) : i === state.yearIndex; dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('r', active ? '3.5' : '1.7'); dot.setAttribute('fill', active ? '#e5c391' : '#8e989f'); svg.append(dot); });
    [[8, periodLabel(state.data.years[0]), 'start'], [238, periodLabel(state.data.years.at(-1)), 'end']].forEach(([x, text, anchor]) => { const t = document.createElementNS(ns, 'text'); t.setAttribute('x', x); t.setAttribute('y', '81'); t.setAttribute('text-anchor', anchor); t.setAttribute('fill', '#7c8790'); t.setAttribute('font-size', '11'); t.textContent = text; svg.append(t); });
    const rangeLabel = document.createElementNS(ns, 'text'); rangeLabel.setAttribute('x', '238'); rangeLabel.setAttribute('y', '9'); rangeLabel.setAttribute('text-anchor', 'end'); rangeLabel.setAttribute('fill', '#7c8790'); rangeLabel.setAttribute('font-size', '10'); rangeLabel.textContent = `${fmt(low, 2)}–${fmt(high, 2)} ${units()}`; svg.append(rangeLabel);
    target.append(svg); target.setAttribute('aria-label', `${entity.name || entity.label || entity.full_name} 시점별 평균 복사휘도: ${state.data.years.map((y, i) => `${periodName(y)} ${fmt(values[i], 2)}`).join(', ')}. 구역마다 세로축 범위가 다릅니다. 선은 표시된 관측을 연결하며 그 사이의 측정값을 뜻하지 않습니다.`);
  }
  function renderDetail() {
    if (state.region === 'all') return;
    const r = region(), selected = r.districts.find((d) => String(d.id) === String(state.district)), entity = selected || r, values = series(entity), compared = pairValues(entity), record = pairRecord(entity), [a, b] = pair();
    if ($('linked-map').dataset.key !== `${editionAsset(r.interaction_url || '')}/${r.id}`) { $('linked-map').replaceChildren(); $('linked-map').dataset.key = ''; $('region-map').hidden = true; }
    $('detail-label').textContent = `${label(r)} · ${state.compare ? '두 시점의 밝기' : state.mode === 'change' ? '변화의 표면' : '밝기의 표면'}`;
    const img = $('single-image'), path = imagePath(r); if (img.getAttribute('src') !== path) { $('single-image-error').hidden = true; img.src = path; }
    img.alt = `${label(r)} ${periodName(year())} ${state.mode === 'change' ? `${periodName(baseline())} 대비 변화` : observation()} 입체 작품`;
    if (state.compare) {
      const fallback = $('pair-fallback'), key = `${state.data.release_id || state.data.updated_utc}/${r.id}/${imagePath(r,a,'absolute')}/${imagePath(r,b,'absolute')}`;
      if (fallback.dataset.key !== key) {
        fallback.replaceChildren(); fallback.dataset.key = key;
        [a, b].forEach((y) => { const image = el('img'); image.src = imagePath(r, y, 'absolute'); image.alt = `${label(r)} ${periodName(y)} 실제 관측의 정지 이미지`; image.draggable = false; fallback.append(image); });
      }
    }
    const select = $('district-select'), currentIds = r.districts.map((d) => `${d.id}:${d.name}`).join(',');
    if (select.dataset.ids !== currentIds) { select.replaceChildren(new Option(`${label(r)} 전체`, '')); r.districts.forEach((d) => select.add(new Option(d.name, d.id))); select.dataset.ids = currentIds; }
    select.value = state.district || '';
    const hotspots = $('hotspots'); hotspots.replaceChildren();
    r.districts.forEach((d) => {
      const anchor = d.anchor_by_mode?.[state.mode] || d.anchor; if (!anchor || !finite(anchor.x) || !finite(anchor.y)) return;
      const button = el('button', 'hotspot'); button.type = 'button'; button.style.left = `${anchor.x * 100}%`; button.style.top = `${anchor.y * 100}%`; button.classList.toggle('cold', state.mode === 'change' && series(d).change < 0); button.classList.toggle('selected', String(d.id) === String(state.district)); button.setAttribute('aria-label', `${d.name} 확대 및 정보`); button.setAttribute('aria-pressed', String(String(d.id) === String(state.district))); button.append(el('span', '', d.name)); button.addEventListener('click', () => selectDistrict(d.id)); hotspots.append(button);
    });
    syncMarkers();
    $('single-scene').style.transform = ''; $('single-scene').classList.remove('zoomed');
    $('reset-view').hidden = !viewerReady && !state.district;
    $('point-instruction').textContent = selected ? `${selected.name}의 경계 · 수치는 구역 전체 집계` : '지도나 목록에서 장소를 고르세요. 선택한 지점만 작품에 남습니다.';
    $('place-title').textContent = selected ? selected.name : (r.full_name || label(r));
    $('place-context').textContent = `이 판의 ${commonArea()} · 면적 가중 평균`;
    $('place-value').textContent = fmt(state.compare ? compared.change : state.mode === 'change' ? values.change : values.mean, 2, state.compare || state.mode === 'change');
    $('place-value-label').textContent = state.compare ? '두 관측의 평균 차이 · B − A' : state.mode === 'change' ? `${periodLabel(baseline())} 대비 평균 변화량` : `${periodLabel(year())} 평균 복사휘도`;
    $('pair-values').hidden = !state.compare;
    $('pair-value-a-label').textContent = `A · ${periodLabel(a)}`; $('pair-value-b-label').textContent = `B · ${periodLabel(b)}`;
    $('pair-value-a').textContent = fmt(compared.first.mean, 2); $('pair-value-b').textContent = fmt(compared.last.mean, 2);
    $('growth-label').textContent = state.compare ? 'A 대비 B의 평균' : `${periodLabel(a)} 대비 평균`;
    $('place-growth').textContent = pct(compared.percent, true);
    $('place-decrease').textContent = pct(record?.lower_area_pct ?? (state.compare ? null : values.decreased_area_pct)); $('place-coverage').textContent = pct(entity.coverage_pct);
    $('place-note').textContent = `${periodName(b)} 값이 ${periodName(a)}보다 낮은 면적의 비율입니다. 분모는 공통 관측 영역이며 작은 음수도 포함합니다.${state.compare && !record ? ' 이 두 시점의 면적 통계를 불러오는 중입니다.' : ''}${Number(entity.coverage_pct) < 85 ? ' 관측 범위가 제한되어 전체 지역으로 확대 해석하지 않습니다.' : ''}`;
    drawChart(entity); renderQuality(entity); updateMapSelection();
    if (state.placeStory) renderPlaceSummary();
    const ready = update3D(r);
    if (!state.interaction) {
      $('map-status').textContent = '지도와 관측 범위를 불러오고 있습니다.';
      $('retry-map').disabled = true;
    }
    const token = ++mapToken, currentData = state.data;
    loadInteraction(r).then((data) => {
      if (token !== mapToken || state.region !== r.id || state.data !== currentData) return;
      state.interaction = data; renderMap(r, data); renderQuality(entity);
      if (data && viewerReady && viewer?.regionId === r.id && viewer.interaction !== data) viewer.setInteraction(data);
      if (state.placeStory) renderPlaceLocation();
      const record = pairRecord(entity);
      $('place-decrease').textContent = pct(record?.lower_area_pct ?? (state.compare ? null : series(entity).decreased_area_pct));
      if (state.compare) $('place-note').textContent = `${periodName(pair()[1])} 값이 ${periodName(pair()[0])}보다 낮은 면적의 비율입니다. 분모는 공통 관측 영역이며 작은 음수도 포함합니다.${!record ? ' 이 관측 조합의 면적 통계를 제공하지 못해 —로 표시합니다.' : ''}${Number(entity.coverage_pct) < 85 ? ' 관측 범위가 제한되어 전체 지역으로 확대 해석하지 않습니다.' : ''}`;
    });
    return ready;
  }
  function svgNode(tag, attributes = {}) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, String(value)));
    return node;
  }
  function polygonPath(polygons = []) {
    return polygons.map((polygon) => [polygon.outer, ...(polygon.holes || [])].map((ring) => ring?.length ? `M${ring.map(([x,y]) => `${x},${-y}`).join('L')}Z` : '').join('')).join('');
  }
  function renderMap(r, data) {
    const target = $('linked-map'), key = `${editionAsset(r.interaction_url || '')}/${r.id}`;
    $('retry-map').disabled = false;
    $('retry-map').hidden = !!data;
    $('region-map').hidden = !!data || !r.map_url;
    if (!data || !Array.isArray(data.bounds) || !data.districts?.length) {
      target.replaceChildren(); target.dataset.key = '';
      if (r.map_url) $('region-map').src = editionAsset(r.map_url);
      $('map-status').textContent = '연동 지도를 불러오지 못했습니다. 다시 시도하거나 위 목록에서 구역을 고를 수 있습니다.'; return;
    }
    if (target.dataset.key !== key || !target.firstElementChild) {
      const [minX,minY,maxX,maxY] = data.bounds, pad = Math.max(maxX-minX,maxY-minY) * .045;
      const svg = svgNode('svg', {viewBox:`${minX-pad} ${-maxY-pad} ${maxX-minX+2*pad} ${maxY-minY+2*pad}`, role:'group', 'aria-label':`${label(r)}의 북쪽이 위인 구역 지도`});
      const defs = svgNode('defs'), pattern = svgNode('pattern', {id:'map-missing-pattern', patternUnits:'userSpaceOnUse',width:.04,height:.04,patternTransform:'rotate(35)'});
      pattern.append(svgNode('line',{x1:0,y1:0,x2:0,y2:.04,stroke:'#99a6b5','stroke-width':.008})); defs.append(pattern); svg.append(defs);
      data.districts.forEach((district) => {
        const path = svgNode('path', {d:polygonPath(district.polygons),class:'map-district','fill-rule':'evenodd',tabindex:0,role:'button','aria-label':`${district.name}의 경계와 정보 선택`,'aria-pressed':'false','data-district':district.id});
        const title = svgNode('title'); title.textContent = district.name; path.append(title);
        path.addEventListener('click', () => selectDistrict(district.id));
        path.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectDistrict(district.id); } }); svg.append(path);
      });
      svg.append(svgNode('path',{d:polygonPath(data.missing),class:'map-missing','fill-rule':'evenodd',fill:'url(#map-missing-pattern)','aria-hidden':'true'}));
      target.replaceChildren(svg); target.dataset.key = key;
    }
    updateMapSelection();
    if (state.placeStory) renderPlaceLocation();
  }
  function updateMapSelection() {
    $('linked-map').classList.toggle('show-quality', state.quality);
    $('linked-map').querySelectorAll('[data-district]').forEach((path) => { const selected = String(path.dataset.district) === String(state.district); path.classList.toggle('selected', selected); path.setAttribute('aria-pressed', String(selected)); });
    if (!state.interaction) return;
    const selected = region()?.districts.find((d) => String(d.id) === String(state.district));
    $('map-status').textContent = selected ? `${selected.name} 선택됨. 같은 경계가 입체에 표시됩니다. 공통 관측에서 제외된 경계 구간은 기준면에 표시합니다.` : '북쪽이 위인 지도입니다. 구역을 누르면 입체에서도 같은 경계를 따라갑니다.';
  }
  function renderQuality(entity) {
    $('quality-panel').hidden = !state.quality;
    const record = pairRecord(entity), source = String(entity.id) === String(state.region) ? state.interaction : state.interaction?.districts?.find((d) => String(d.id) === String(entity.id));
    $('quality-coverage').textContent = `전체 경계 중 공통 관측 ${pct(source?.coverage_pct ?? entity.coverage_pct)}${finite(source?.missing_area_km2) ? ` · 제외 ${fmt(source.missing_area_km2, 2)} km²` : ''}. ${source && source.missing_area_km2 === 0 ? '이 판에는 공통 관측에서 제외된 영역이 없습니다.' : '빗금은 자료 없음·품질·공통 관측 조건으로 이 판에서 제외된 영역입니다.'}`;
    $('quality-zero').textContent = finite(record?.to_zero_area_pct) ? `${periodLabel(pair()[1])}에 실제 값이 0인 면적은 공통 관측의 ${pct(record.to_zero_area_pct)}입니다. 회색 빗금의 공통 관측 제외 영역과 구분합니다.` : '값이 0인 관측도 유효한 자료입니다. 공통 관측에서 제외된 영역은 실제 값 0과 다릅니다.';
    const small = record?.small_change_area_pct?.[state.threshold], below = record?.decrease_beyond_pct?.[state.threshold];
    $('quality-difference').textContent = finite(small) && finite(below) ? `${periodLabel(pair()[0])} → ${periodLabel(pair()[1])}. 절대 차이가 ${state.threshold} 이하인 면적 ${pct(small)}. ${state.threshold}보다 더 낮아진 면적 ${pct(below)}. 모두 공통 관측 영역을 기준으로 합니다.` : '선택한 두 관측의 차이 분포를 불러오지 못해 비율을 표시하지 않습니다.';
  }
  function render() {
    if (!state.data) return;
    renderHeading(); const all = state.region === 'all'; $('comparison').hidden = !all; $('region-detail').hidden = all;
    // Keep time selection beside the artwork, before the regional information on mobile.
    const timeline = $('timeline'), timelineHost = $(all ? 'overview-timeline' : 'detail-timeline');
    if (timeline.parentElement !== timelineHost) timelineHost.appendChild(timeline);
    let ready;
    if (all) { ++state.renderToken; ++mapToken; loadingKey = ''; viewer?.setActive(false); renderComparison(); } else ready = renderDetail();
    renderGuide(); renderPlaceStories();
    fitImmersiveCanvas();
    preloadNext();
    return ready;
  }
  function findGuideTarget() {
    return createGuide(state.data, state.region);
  }
  function setGuide(step) {
    if (!state.data) return;
    stopPlay(); clearPlaceStory();
    if (!state.guideTarget) state.guideTarget = findGuideTarget();
    const previousRegion = state.region;
    Object.assign(state, guideScene(state.guideTarget, step, state.data.years));
    state.compareA = state.data.years[0]; state.compareB = state.data.years.at(-1);
    if (previousRegion !== state.region) state.interaction = null;
    state.infoHidden = false; syncInfo();
    if (step === 0) { state.quality = false; if (viewerReady) viewer.reset(); }
    pendingFocus = null;
    render();
    $('guided-story').scrollIntoView({behavior:reducedMotion.matches ? 'instant' : 'smooth', block:'start'});
    $('guide-step-title').focus({preventScroll:true});
    announce(`안내 감상 ${step+1} / 4. ${$('guide-step-title').textContent}`);
  }
  function renderGuide() {
    $('guided-story').hidden = state.guide === null;
    $('start-guide').setAttribute('aria-expanded', String(state.guide !== null));
    $('guide-place-stories').hidden = true;
    if (state.guide === null || !state.guideTarget) return;
    const r = state.data.regions.find((item) => item.id === state.guideTarget.region);
    const chapter = state.guideTarget.chapters[state.guide];
    $('guide-step-count').textContent = `0${state.guide+1} / 04 · ${r ? label(r) : '세 지역'}`;
    $('guide-step-title').textContent = chapter.title; $('guide-step-body').textContent = chapter.body;
    $('guide-place-stories').hidden = state.guide !== 2 || chapter.action !== 'choose-place-story' ||
      !eligiblePlaceStories(state.data).some((story) => state.region === 'all' || story.region === state.region);
    $('guide-prev').disabled = state.guide === 0; $('guide-next').textContent = state.guide === 3 ? '직접 살펴보기' : '다음 장면';
    document.querySelectorAll('.guide-progress span').forEach((node,index) => { node.classList.toggle('active',index === state.guide); node.classList.toggle('complete',index < state.guide); if(index === state.guide) node.setAttribute('aria-current','step'); else node.removeAttribute('aria-current'); });
  }
  function chooseGuidePlaceStories() {
    if (state.guide !== 2 || state.guideTarget?.chapters[2]?.action !== 'choose-place-story') return;
    const stories = eligiblePlaceStories(state.data).filter((story) => state.region === 'all' || story.region === state.region);
    if (!stories.length) return;
    // Focus a choice without selecting it or changing the current observation.
    leaveGuide();
    const choices = $('place-story-choices');
    const target = state.region === 'all' ? choices : choices.querySelector(`[data-place-story="${stories[0].id}"]`);
    $('place-stories').scrollIntoView({ behavior: reducedMotion.matches ? 'instant' : 'smooth', block: 'start' });
    (target || choices).focus({ preventScroll: true });
    announce('장소 이야기를 직접 골라 보세요. 주변의 관측과 공식 기록을 함께 살펴볼 수 있습니다.');
  }
  function finishGuide() {
    leaveGuide();
    const target = document.querySelector(`[data-region="${state.region}"]`);
    target?.focus({preventScroll:true});
    announce(state.region === 'all' ? '자유 감상으로 이어집니다. 보고 싶은 지역을 골라 입체와 지도를 살펴보세요.' : '자유 감상으로 이어집니다. 같은 작품을 돌려 보거나 지도를 선택할 수 있습니다. 비교는 원할 때 켜세요.');
  }
  function toggleComparison() {
    if (!state.data || state.region === 'all') return;
    // Enter from the observation already being viewed; leaving keeps B and
    // the selected district/camera instead of jumping to a different year.
    if (!state.compare) state.compareB = year();
    leaveGuide(); clearPlaceStory(); stopPlay(); state.compare = !state.compare;
    state.mode = 'absolute'; state.yearIndex = yearIndex(state.compareB);
    render(); announce(state.compare ? '비교 켜짐. A와 B를 함께 회전합니다. 비교 끄기를 누르면 한 작품으로 돌아갑니다.' : `비교 꺼짐. ${periodName(year())}의 한 작품을 크게 감상합니다.`);
  }
  function syncInfo() {
    $('artwork').classList.toggle('information-hidden',state.infoHidden);
    $('info-toggle').setAttribute('aria-expanded',String(!state.infoHidden));
    $('info-toggle').textContent = state.infoHidden ? '정보 펼치기' : '정보 접기';
    $('place-panel').hidden = state.infoHidden;
    fitImmersiveCanvas();
  }
  function fitImmersiveCanvas() {
    if (!state.immersive) return;
    requestAnimationFrame(() => {
      if (!state.immersive || state.region === 'all') return;
      const artwork = $('artwork'), viewport = $('single-viewport');
      const top = viewport.getBoundingClientRect().top - artwork.getBoundingClientRect().top + artwork.scrollTop;
      const reserve = window.innerWidth <= 700 ? 72 : 88;
      const available = artwork.clientHeight - top - reserve;
      artwork.style.setProperty('--immersive-canvas-height', `${Math.max(210, Math.floor(available))}px`);
    });
  }
  function syncImmersive() {
    $('artwork').classList.toggle('immersive',state.immersive);
    document.body.classList.toggle('artwork-immersive',state.immersive);
    $('cinema-toggle').setAttribute('aria-pressed',String(state.immersive));
    $('cinema-toggle').textContent = state.immersive ? '화면 나가기' : '화면 채우기';
    if (state.immersive) immersiveFocus.activate(); else immersiveFocus.deactivate();
    if (!state.immersive) $('artwork').style.removeProperty('--immersive-canvas-height');
    fitImmersiveCanvas();
  }
  async function toggleImmersive() {
    stopPlay();
    if (state.immersive) {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
      state.immersive = false;
    } else {
      leaveGuide();
      state.immersive = true;
      if ($('artwork').requestFullscreen) await $('artwork').requestFullscreen().catch(() => {});
    }
    syncImmersive();
    if (state.immersive) $('artwork').scrollTop = 0;
    fitImmersiveCanvas();
  }
  function renderHistory() {
    const history = state.history, selector = $('history-select');
    if (!history?.editions?.length) { selector.disabled = true; selector.replaceChildren(new Option('기록 준비 중','')); $('history-status').textContent = '관측 기록을 불러오지 못했습니다. 현재 작품의 관측은 그대로 볼 수 있습니다.'; return; }
    const selected = history.editions.find((entry) => entry.id === (state.archiveId || history.current_id)) || history.editions[0];
    selector.replaceChildren(); history.editions.forEach((entry) => selector.add(new Option(`${entry.label || entry.period_label || entry.id}${entry.is_current || entry.id === history.current_id ? ' · 현재' : ''}`,entry.id)));
    selector.value = selected.id; selector.disabled = state.historyLoading || history.editions.length < 2;
    $('history-latest').hidden = !state.archiveId;
    $('history-status').textContent = state.archiveId ? '기록된 판을 보고 있습니다. 이 판은 새 자료가 와도 자동으로 바뀌지 않습니다.' : history.editions.length === 1 ? '첫 기록 · 다음 자료부터 이전 판이 쌓입니다.' : '현재 공개된 판입니다. 새 관측이 검증되면 이전 판과 함께 기록됩니다.';
    const date = selected.recorded_at && !Number.isNaN(new Date(selected.recorded_at).getTime()) ? new Date(selected.recorded_at).toLocaleString('ko-KR',{year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Seoul'}) : '기록 시각 없음';
    $('history-period').textContent = `관측 ${selected.period_label || `${selected.observed_from}–${selected.observed_to}`} · 기록 ${date}`;
    const summary = (selected.summary || selected.reason || '검증된 관측과 그때의 공통 관측 영역을 보존했습니다.').trim();
    $('history-summary').textContent = summary;
    const changes = [...new Set((selected.changes || []).filter((value) => typeof value === 'string').map((value) => value.trim()))]
      .filter((value) => value && value !== summary);
    $('history-changes').replaceChildren(...changes.map((value) => el('li','',value)));
    $('history-changes').hidden = changes.length === 0;
  }
  async function loadHistory() {
    try {
      const response = await fetch('./data/history.json',{cache:'no-cache'}); if (!response.ok) throw new Error('History unavailable');
      state.history = await response.json(); renderHistory();
    } catch { if (!state.history) renderHistory(); }
  }
  async function selectHistory(id) {
    if (!state.history) return;
    const entry = state.history.editions.find((item) => item.id === id), latest = !id || id === state.history.current_id;
    if (!latest && !entry?.manifest_url) return;
    const token = ++historyToken, previousArchiveId = state.archiveId;
    stopPlay(); leaveGuide(); clearPlaceStory(); state.historyLoading = true; $('history-select').disabled = true; $('history-status').textContent = '기록된 관측을 불러오는 중입니다.';
    try {
      const response = await fetch(latest ? './data/manifest.json' : entry.manifest_url, {cache:latest ? 'no-cache' : 'default'});
      if (!response.ok) throw new Error('Recorded observation unavailable');
      const data = await response.json(); if (token !== historyToken) return;
      state.archiveId = latest ? null : entry.id; initialize(data); renderHistory();
      $('update-notice').hidden = !state.archiveId; $('update-notice').textContent = state.archiveId ? '기록된 관측 판입니다. 최신 자료의 자동 반영은 잠시 멈춥니다.' : '';
      announce(latest ? '최신 관측 판으로 돌아왔습니다.' : `${entry.label || entry.period_label}의 기록된 관측을 불러왔습니다.`);
    } catch {
      if (token !== historyToken) return;
      state.archiveId = previousArchiveId;
      renderHistory(); $('history-status').textContent = '이 기록을 불러오지 못해 현재 작품을 유지했습니다. 잠시 후 다시 선택해 주세요.';
    } finally {
      if (token === historyToken) {
        state.historyLoading = false;
        $('history-select').disabled = (state.history?.editions?.length || 0) < 2;
      }
    }
  }
  function preloadNext() {
    if (!state.data || state.compare || state.yearIndex >= state.data.years.length - 1) return;
    prepareYear(state.yearIndex + 1).catch(() => {});
  }
  function configureEdition() {
    const data = state.data, source = data.source || {}, isMonthly = monthly();
    document.body.classList.toggle('monthly-edition', isMonthly);
    document.title = `밤의 지문 — ${isMonthly ? '최근 같은 달의 관측' : '평균이 지운 자리'}`;
    document.querySelector('meta[name="description"]').content = `서울·부산·제주의 ${isMonthly ? '같은 달' : '연간'} 야간광을 입체로 옮긴 데이터 아트. 빛이 늘어난 곳과 줄어든 곳을 돌아봅니다.`;
    $('opening-copy').textContent = isMonthly ? `${periodName(data.years[0])}과 ${periodName(data.years.at(-1))}의 야간광을 입체로 옮겼습니다. 같은 달, 달라진 빛을 돌아보세요.` : '서울·부산·제주의 야간광을 입체로 옮겼습니다. 빛이 늘어난 곳과 줄어든 곳을 직접 돌아보세요.';
    $('comparison').setAttribute('aria-label', `세 지역 같은 ${isMonthly ? '월간 관측' : '연도'} 비교`);
    $('timeline-label').textContent = isMonthly ? '같은 달의 관측 시점' : '관측 연도';
    $('year-ticks').setAttribute('aria-label', isMonthly ? '같은 달 관측 바로 선택' : '연도 바로 선택');
    document.querySelector('.place-main-value .unit').textContent = units();
    $('afterword-title').innerHTML = '내가 아는 도시는<br>어떻게 변했을까.';
    $('afterword-main').textContent = '익숙한 길이 전보다 어둡게 느껴질 때, 실제로 무엇이 달라졌는지 궁금해집니다. 도시가 밝아졌다는 말만으로는 동네마다 생긴 변화를 알 수 없습니다. 그래서 빛을 평균값 하나로만 보여 주지 않고, 원래의 위치에 높이로 세웠습니다. 멀리서는 도시의 모양을, 가까이서는 그 안의 차이를 봅니다. 익숙한 곳을 찾아본 뒤 처음의 전체 모습으로 돌아와 보세요.';
    $('afterword-update').textContent = isMonthly ? '같은 달을 비교해도 날씨와 관측 품질의 영향은 남습니다. 이 표면만으로 변화의 원인이나 도시의 사정을 단정할 수는 없습니다.' : eligiblePlaceStories(state.data).length ? '빛이 줄었다는 사실만으로 그곳의 사정을 알 수는 없습니다. 장소의 변화에서는 주민 이주나 시설 개장 같은 공식 기록을 관측 옆에 놓았습니다. 같은 빛의 변화라도, 그곳에서 일어난 일에 따라 다르게 읽힐 수 있습니다.' : '빛이 줄었다는 사실만으로 그곳의 사정을 알 수는 없습니다. 이 작품은 도시를 한 숫자로 이해할 때 놓치는 곳을 보여 주려 합니다.';
    $('guide-height').textContent = `밝기 장면은 ${observation()}, 변화 장면은 같은 위치의 ${periodName(baseline())} 값을 뺀 차이입니다. 큰 값과 작은 값을 함께 보기 위해 비선형 높이를 사용합니다.`;
    $('guide-color').textContent = '변화 장면의 금빛은 증가, 푸른빛은 감소입니다. 등고선은 같은 표시 높이를 잇습니다. 선 한 줄이 하나의 관측 시점을 뜻하지 않습니다. 밝기 장면의 색과 그림자는 고정 조명입니다.';
    $('guide-time').textContent = isMonthly ? `각 연도의 ${data.period.month}월 실제 관측을 고릅니다. 재생은 공개된 관측의 순서이며 새 자료의 실시간 도착이 아닙니다. 그래프의 선은 두 시점을 연결할 뿐, 사이의 관측이나 연속 추세를 뜻하지 않습니다.` : '연도별 실제 관측을 고릅니다. 연도 재생은 공개된 과거 관측의 순서이며, 새로운 자료가 도착했다는 알림이나 실시간 측정이 아닙니다.';
    $('source-title').textContent = '자료는 어떻게 작품이 될까';
    $('source-lead').textContent = isMonthly ? '같은 달의 밤을 같은 좌표에서 비교합니다. 장기 변화와 최근 관측은 서로 다른 자료를 사용하는 별도의 판입니다. 두 판의 수치를 직접 이어 붙이지 않습니다.' : '한 장의 야경으로는 여러 해 동안 어디서 빛이 달라졌는지 알기 어렵습니다. 야간광은 익숙한 밤을 같은 좌표의 관측으로 다시 볼 수 있게 합니다. 빛의 양뿐 아니라 그 빛이 놓인 자리를 함께 살펴보려는 이유입니다.';
    $('update-discovery').textContent = isMonthly ? '공식 제공처에서 같은 달 비교에 필요한 자료와 관측 품질 정보를 확인합니다.' : '공식 제공처의 연도 목록을 확인합니다.';
    const monthlyMethod = `${source.title || source.label || '공식 월간 야간광'} 자료를 사용합니다.${source.processing_note ? ` ${source.processing_note}` : ''} 같은 판의 두 시점에서 공통으로 관측 가능한 위치를 사용하고, 경계와 겹치는 면적으로 가중합니다. 같은 달 비교에도 기상과 관측 품질의 영향이 남으며, 두 시점만으로 장기 추세를 판단할 수 없습니다.`;
    const annualMethod = 'WorldPop이 제공한 EOG 연평균 야간광을 500m 격자로 집계했습니다. 같은 판에 포함된 모든 연도에 공통으로 관측 가능한 위치를 사용하고, 경계와 겹치는 면적으로 가중합니다. 새 연도가 추가되면 공통 관측 영역이 달라질 수 있어 이전 연도의 수치도 같은 영역에서 다시 계산합니다.';
    $('source-scope').textContent = `${isMonthly ? monthlyMethod : annualMethod} 야간광만으로 인구·경제·정책 효과나 변화의 원인을 단정하지 않습니다.`;
    $('footer-credit').textContent = `${source.label || (isMonthly ? 'NASA Black Marble' : 'WorldPop / EOG')} · SGIS / vuski/admdongkor`;
    const primary = $('primary-source-link'), primaryURL = source.url || (source.doi ? `https://doi.org/${source.doi}` : '');
    primary.parentElement.hidden = !/^https?:\/\//.test(primaryURL);
    if (!primary.parentElement.hidden) primary.href = primaryURL;
    primary.textContent = `${source.label || '공식 제공처'} · ${source.product || '자료와 출처'}`;
    const secondaryURL = source.documentation_url || (isMonthly ? '' : 'https://eogdata.mines.edu/products/vnl/');
    $('secondary-source').hidden = !/^https?:\/\//.test(secondaryURL);
    if (!$('secondary-source').hidden) { $('secondary-source-link').href = secondaryURL; $('secondary-source-link').textContent = source.documentation_label || (isMonthly ? 'NASA · 제품 설명' : 'EOG · Annual VNL'); }
    const credit = [source.license ? `${source.label || '관측 자료'}: ${source.license}.` : null, source.boundary_credit ? `${source.boundary_credit}.` : '가공 경계: CC BY 4.0. SGIS 원자료: 공공누리 제1유형.', data.boundary_date ? `경계 기준일 ${data.boundary_date}.` : null, '수집·분석·보간·조형 변환은 이 프로젝트에서 수행했습니다.'].filter(Boolean);
    $('source-credit').textContent = credit.join(' ');
    const editions = $('edition-links'); editions.replaceChildren();
    (data.edition_links || []).forEach((item) => {
      if (typeof item.url !== 'string' || !/^(\.\.?\/|https?:\/\/)/.test(item.url)) return;
      const link = el('a', item.active ? 'active' : '', item.label); link.href = item.url;
      if (item.active) link.setAttribute('aria-current', 'page');
      editions.append(link);
    });
    editions.hidden = !editions.children.length;
    stopPlay();
  }
  function updateMetadata() {
    const data = state.data, first = data.years[0], last = data.years.at(-1);
    $('edition').textContent = `${periodLabel(first)}–${periodLabel(last)}`; $('release-years').textContent = `${periodLabel(first)}–${periodLabel(last)} · ${data.years.length}개 ${monthly() ? '월간' : '연간'} 관측`;
    const checked = data.update?.last_checked || data.update?.checked_utc || data.checked_utc;
    const date = checked && !Number.isNaN(new Date(checked).getTime()) ? new Date(checked).toLocaleString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' }) : '확인 시각 기록 없음';
    $('release-checked').textContent = date;
    const status = data.update?.state || data.update?.status;
    const noNew = ['no_new_data', 'unchanged', 'up_to_date'].includes(status);
    const replay = status === 'historical_replay' || data.update?.historical_replay;
    $('release-status').textContent = replay ? `${periodName(last)}까지의 과거 관측으로 갱신 과정 재현` : noNew ? `${periodName(last)}까지 반영 · 새 ${monthly() ? '비교' : '연도'} 자료 없음` : `${periodName(last)}까지 검증된 관측 반영`;
    if (data.update?.message && !replay) $('release-status').textContent = data.update.message;
    if (status === 'needs_credentials' && !replay) {
      const pendingPeriod = data.update?.latest_available_period;
      const pending = typeof pendingPeriod === 'string' ? ` 공식 목록의 최신 자료: ${pendingPeriod}.` : '';
      $('release-status').textContent = `${periodName(last)}까지의 작품을 유지 중. ${data.update?.explanation || '새 자료의 자동 다운로드 인증을 갱신해야 합니다.'}${pending}`;
    }
    const repo = data.repository_url || data.source?.repository_url || data.update?.repository_url;
    $('repository-link').hidden = !(repo && /^https:\/\/github\.com\//.test(repo));
    if (!$('repository-link').hidden) $('repository-link').querySelector('a').href = repo;
    const schedule = data.update?.schedule_description || (monthly() ? '최근 관측 판은 공식 월간 자료를 확보하고 같은 달 비교가 가능한지 검증한 뒤 갱신합니다.' : '연간 자료를 주기적으로 점검하는 갱신 방식입니다.');
    $('automation-note').textContent = `${schedule} 새 ${monthly() ? '비교' : '연도'} 자료가 없으면 현재 작품을 유지합니다. 검증에 실패하거나 제품 규격이 바뀌면 기존 작품을 덮어쓰지 않습니다.`;
    if (replay) { $('update-notice').hidden = false; $('update-notice').textContent = '과거에 공개된 실제 관측으로 갱신 과정을 재현하고 있습니다. 새 자료의 실시간 도착을 뜻하지 않습니다.'; }
  }
  function initialize(data, refreshing = false) {
    if (!Array.isArray(data.years) || !data.years.length || !Array.isArray(data.regions) || data.regions.length !== 3) throw new Error('Invalid artwork manifest');
    cancelYearPresentation(); cancelPendingComparison();
    clearPlaceStory();
    if (!state.data) {
      const hash = window.location.hash.slice(1);
      const linkedRegion = new URLSearchParams(window.location.search).get('region') || new URLSearchParams(hash).get('region') || hash;
      if (data.regions.some((item) => item.id === linkedRegion)) state.region = linkedRegion;
    }
    const oldYear = state.data ? year() : null, wasLatest = !state.data || state.yearIndex === state.data.years.length - 1;
    state.data = data; state.yearIndex = wasLatest ? data.years.length - 1 : Math.max(0, data.years.indexOf(oldYear));
    state.interaction = null; viewerKey = ''; loadingKey = ''; ++state.renderToken; ++mapToken;
    if (!data.years.includes(Number(state.compareA))) state.compareA = data.years[0];
    if (!data.years.includes(Number(state.compareB)) || refreshing) state.compareB = data.years.at(-1);
    ['compare-a','compare-b'].forEach((id) => { $(id).replaceChildren(); data.years.forEach((y) => $(id).add(new Option(periodLabel(y),String(y)))); });
    if (state.guide !== null) { state.guide = null; state.guideTarget = null; }

    $('year-slider').max = String(data.years.length - 1); $('year-ticks').replaceChildren();
    data.years.forEach((y, i) => { const b = el('button', '', periodLabel(y)); b.type = 'button'; b.dataset.yearIndex = String(i); b.setAttribute('aria-label', `${periodName(y)} 관측 보기`); b.addEventListener('click', () => setYear(i)); $('year-ticks').append(b); });
    $('load-state').hidden = true; $('load-error').hidden = true; $('timeline').hidden = false; $('artwork').setAttribute('aria-busy', 'false');
    $('start-guide').disabled = false; $('regional-guide').disabled = false;
    configureEdition(); updateMetadata(); render();
    if (refreshing) { $('update-notice').hidden = false; $('update-notice').textContent = `${periodName(data.years.at(-1))}까지의 검증된 관측으로 작품이 갱신되었습니다.`; announce($('update-notice').textContent); }
  }
  async function loadData() {
    $('load-error').hidden = true; $('load-state').hidden = false;
    try { const response = await fetch('./data/manifest.json', { cache: 'no-cache' }); if (!response.ok) throw new Error(`Manifest ${response.status}`); initialize(await response.json()); loadHistory(); }
    catch (error) { $('load-state').hidden = true; $('load-error').hidden = false; $('artwork').setAttribute('aria-busy', 'false'); console.error('Artwork load failed:', error); }
  }
  async function checkForUpdates() {
    if (document.hidden || !state.data || state.archiveId || state.historyLoading) return;
    try {
      const response = await fetch('./data/manifest.json', { cache: 'no-cache' }); if (!response.ok) return;
      const data = await response.json();
      if (state.archiveId || state.historyLoading) return;
      const identity = (v) => JSON.stringify([v.years, v.release_id || v.updated_utc]);
      if (identity(data) !== identity(state.data)) { stopPlay(); initialize(data, true); loadHistory(); }
      else { state.data.update = data.update; updateMetadata(); }
    } catch { /* A failed refresh leaves the last complete artwork in place. */ }
  }
  $('start-guide').setAttribute('aria-controls','guided-story');
  $('start-guide').addEventListener('click', () => { if (!state.data) return; state.guideTarget = createGuide(state.data, 'all'); setGuide(0); });
  $('regional-guide').addEventListener('click', () => { state.guideTarget = null; setGuide(0); });
  $('guide-prev').addEventListener('click', () => setGuide(state.guide-1));
  $('guide-next').addEventListener('click', () => { if (state.guide === 3) finishGuide(); else setGuide(state.guide+1); });
  $('guide-exit').addEventListener('click', finishGuide);
  $('guide-place-stories').addEventListener('click', chooseGuidePlaceStories);
  $('compare-toggle').addEventListener('click',toggleComparison);
  ['compare-a','compare-b'].forEach((id) => $(id).addEventListener('change', (event) => setComparison(id === 'compare-a' ? 'a' : 'b', event.target.value)));
  $('quality-toggle').addEventListener('click', () => {
    if (!state.data || state.region === 'all') return;
    stopPlay();
    state.quality = !state.quality;
    if (state.quality) { state.infoHidden = false; syncInfo(); }
    render(); viewer?.setQualityVisible?.(state.quality);
  });
  $('change-threshold').addEventListener('change', (event) => { state.threshold = event.target.value; if (state.region !== 'all') renderQuality(region().districts.find((d) => String(d.id) === String(state.district)) || region()); });
  $('info-toggle').addEventListener('click', () => { state.infoHidden = !state.infoHidden; syncInfo(); });
  $('cinema-toggle').addEventListener('click',toggleImmersive);
  window.addEventListener('resize', fitImmersiveCanvas);
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) { state.immersive = false; syncImmersive(); } });
  $('history-select').addEventListener('change', (event) => selectHistory(event.target.value));
  $('history-latest').addEventListener('click', () => selectHistory(null));
  document.querySelectorAll('[data-region]').forEach((b) => b.addEventListener('click', () => setRegion(b.dataset.region)));
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('reveal-change').addEventListener('click', () => setMode(state.mode === 'absolute' ? 'change' : 'absolute', true));
  $('district-select').addEventListener('change', (e) => selectDistrict(e.target.value));
  $('reset-view').addEventListener('click', () => { leaveGuide(); state.district = null; state.zoom = false; pendingFocus = null; if (viewerReady) { viewer.select(null); viewer.reset(); } renderDetail(); });
  $('place-story-close').addEventListener('click', () => { const id = state.placeStory; clearPlaceStory(); renderDetail(); $('place-story-choices').querySelector(`[data-place-story="${id}"]`)?.focus({ preventScroll: true }); announce('장소의 기록을 닫았습니다. 같은 관측을 자유롭게 살펴보세요.'); });
  $('place-case-read').addEventListener('click', () => { $('place-story-panel').scrollIntoView({ behavior: reducedMotion.matches ? 'instant' : 'smooth', block: 'start' }); $('place-story-title').focus({ preventScroll: true }); });
  $('show-markers').addEventListener('change', syncMarkers);
  $('retry-map').addEventListener('click', retryMap);
  window.addEventListener('online', () => { if (!document.hidden && state.region !== 'all' && !$('retry-map').hidden && !$('retry-map').disabled) retryMap(); });
  $('year-slider').addEventListener('input', (e) => { if (state.data) setYear(e.target.value); });
  $('play-years').addEventListener('click', playYears); $('retry-load').addEventListener('click', loadData);
  $('playback-speed').value = String(playbackSpeed.rate);
  $('playback-speed').addEventListener('change', event => {
    event.target.value = String(playbackSpeed.set(event.target.value));
    announce(`재생 속도 ${playbackSpeed.rate}배. 전환과 감상 시간이 함께 바뀝니다. 진행 중인 전환과 감상 시간은 마친 뒤 적용합니다.`);
  });
  $('single-image').addEventListener('error', () => { $('single-image-error').hidden = viewerReady; });
  $('single-image').addEventListener('load', () => { $('single-image-error').hidden = true; });
  document.querySelectorAll('[data-dialog]').forEach((b) => b.addEventListener('click', () => { stopPlay(); $(b.dataset.dialog).showModal(); document.body.classList.add('dialog-open'); }));
  document.querySelectorAll('dialog').forEach((dialog) => { dialog.addEventListener('close', () => document.body.classList.remove('dialog-open')); dialog.addEventListener('click', (event) => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } }); });
  document.addEventListener('keydown', (event) => { if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return; if (state.immersive && !document.fullscreenElement) { state.immersive = false; syncImmersive(); } else if (state.guide !== null) { leaveGuide(); $('start-guide').focus(); } else if (state.zoom) { state.district = null; state.zoom = false; viewer?.select(null); renderDetail(); } });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopPlay(); else checkForUpdates(); });
  reducedMotion.addEventListener('change', () => stopPlay());
  window.setInterval(checkForUpdates, 180000);
  loadData();
})();
