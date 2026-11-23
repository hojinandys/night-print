'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const state = { data: null, region: 'all', mode: 'absolute', yearIndex: 0, district: null, timer: null, zoom: false, renderToken: 0, guide: null, guideTarget: null, compare: false, compareA: null, compareB: null, quality: false, threshold: '0.5', infoHidden: false, immersive: false, archiveId: null, history: null, historyLoading: false, interaction: null };
  const interactionCache = new Map();
  let loadingKey = '', mapToken = 0, historyToken = 0;
  let viewerPromise = null, viewer = null, viewerKey = '', viewerReady = false, pendingFocus = null;
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
    if (!interactionCache.has(url)) interactionCache.set(url, fetch(url).then((response) => {
      if (!response.ok) throw new Error('Boundary data unavailable');
      return response.json();
    }).catch(() => null));
    return interactionCache.get(url);
  }
  function leaveGuide() {
    state.guide = null; state.guideTarget = null;
    $('guided-story').hidden = true;
    $('start-guide').setAttribute('aria-expanded', 'false');
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
  function stopPlay() {
    if (state.timer) window.clearInterval(state.timer);
    state.timer = null;
    $('play-years').setAttribute('aria-label', monthly() ? '같은 달 관측 재생' : '관측 연도 재생');
    $('play-years').innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5 19 12 8 18.5Z" fill="currentColor"/></svg><span>${monthly() ? '관측 재생' : '연도 재생'}</span>`;
    $('timeline-caption').textContent = '같은 관측 영역 · 같은 높이 규칙';
  }
  function playYears() {
    if (!state.data) return;
    leaveGuide();
    if (state.timer) { stopPlay(); return; }
    if (state.yearIndex === state.data.years.length - 1) state.yearIndex = 0;
    render();
    $('play-years').setAttribute('aria-label', '관측 재생 멈추기');
    $('play-years').innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zm7 0h4v14h-4z" fill="currentColor"/></svg><span>멈추기</span>';
    $('timeline-caption').textContent = monthly() ? '공개된 같은 달의 관측을 순서대로 재생합니다' : '공개된 연간 관측을 순서대로 재생합니다';
    state.timer = window.setInterval(() => {
      if (state.yearIndex >= state.data.years.length - 1) { stopPlay(); $('timeline-caption').textContent = '같은 관측 영역 · 같은 높이 규칙'; return; }
      state.yearIndex++; render();
    }, reducedMotion.matches ? 2600 : 1800);
  }
  function setYear(index) {
    leaveGuide(); stopPlay(); state.yearIndex = Math.max(0, Math.min(state.data.years.length - 1, Number(index))); render();
  }
  function setRegion(id) {
    if (!state.data || (id !== 'all' && !state.data.regions.some((r) => r.id === id))) return;
    leaveGuide(); stopPlay(); state.region = id; state.district = null; state.zoom = false; state.interaction = null; if (id === 'all') state.compare = false; render();
    $('artwork').scrollIntoView({ behavior: reducedMotion.matches ? 'instant' : 'smooth', block: 'start' });
    announce(id === 'all' ? '세 지역 비교' : `${label(region())} 안의 구·군·시를 선택할 수 있습니다.`);
  }
  function setMode(mode, fromStory = false) {
    if (!state.data) return;
    leaveGuide(); state.compare = false; state.mode = mode;
    if (fromStory) { stopPlay(); state.yearIndex = state.data.years.length - 1; }
    render();
    if (fromStory) $('artwork').scrollIntoView({ behavior: reducedMotion.matches ? 'instant' : 'smooth', block: 'start' });
    announce(mode === 'change' ? `${periodName(baseline())}의 빛을 뺀 변화입니다. 금빛은 증가, 푸른빛은 감소입니다.` : `${observation()}의 밝기 장면입니다.`);
  }
  function selectDistrict(id) {
    if (!state.data || state.region === 'all') return;
    leaveGuide(); state.district = id || null; state.zoom = !!id; renderDetail();
    if (viewerReady) { viewer.select(id); if (id) viewer.focus(id); }
    else pendingFocus = id || null;
    const d = region().districts.find((x) => String(x.id) === String(id));
    if (d) { const values = pairValues(d); announce(`${d.name}의 경계와 정보를 선택했습니다. ${periodName(pair()[0])}부터 ${periodName(pair()[1])}까지 평균 ${pct(values.percent, true)}.`); }
  }
  function fallback3D(message) {
    viewerReady = false; viewer?.setActive(false); $('webgl-view').hidden = true; $('single-scene').hidden = state.compare; $('pair-fallback').hidden = !state.compare; $('webgl-status').hidden = true;
    $('view-compass').hidden = true;
    $('orbit-instruction').textContent = message; $('reset-view').textContent = '선택 해제'; $('reset-view').hidden = !state.district;
  }
  async function update3D(r) {
    const selectedYear = state.compare ? state.compareA : year(), compareYear = state.compare ? state.compareB : undefined, selectedMode = state.compare ? 'absolute' : state.mode;
    const key = `${state.data.release_id || state.data.updated_utc}/${r.id}/${selectedMode}/${selectedYear}/${compareYear}/${r.webgl?.grid_url || r.interaction_url}`;
    if (viewerReady && key === viewerKey) { viewer.setActive(true); viewer.select(state.district); viewer.setQualityVisible?.(state.quality); return; }
    if (loadingKey === key) return;
    loadingKey = key;
    const token = ++state.renderToken;
    viewerReady = false; viewer?.setActive(false); $('webgl-view').hidden = true; $('single-scene').hidden = state.compare; $('pair-fallback').hidden = !state.compare; $('view-compass').hidden = true;
    $('webgl-status').hidden = false; $('webgl-status').textContent = state.compare ? '두 관측의 입체를 불러오는 중' : '회전 가능한 입체를 불러오는 중';
    $('orbit-instruction').textContent = '3D 지형을 준비하고 있습니다. 현재 보이는 장면은 정지 이미지입니다.';
    if (!r.webgl) { loadingKey = ''; fallback3D('이 관측의 3D 자료가 없어 실제 관측의 정지 이미지를 표시합니다. 구역별 정보는 그대로 확인할 수 있습니다.'); return; }
    try {
      if (!viewerPromise) viewerPromise = import('./viewer3d.js').then(({ ReliefViewer }) => {
        viewer = new ReliefViewer($('webgl-view'), {
          onSelect: selectDistrict,
          onError: () => fallback3D('3D 표시가 중단되어 실제 관측의 정지 이미지로 전환했습니다. 새로고침하면 다시 시도합니다.'),
          onMove: () => { $('reset-view').hidden = false; },
          onView: ({ northAngle = 0, comparing, comparisonAxis = 'horizontal' }) => {
            $('compass-arrow').style.transform = `rotate(${northAngle}deg)`;
            $('single-viewport').dataset.comparisonAxis = comparisonAxis;
            $('pair-labels').dataset.comparisonAxis = comparisonAxis;
          }
        }); return viewer;
      });
      const [instance, interaction] = await Promise.all([viewerPromise, loadInteraction(r)]);
      if (token !== state.renderToken || state.region === 'all') return;
      const loaded = await instance.show(r, selectedYear, selectedMode, { compareYear, interaction });
      if (!loaded || token !== state.renderToken || state.region === 'all') return;
      viewerKey = key; viewerReady = true; $('single-scene').hidden = true; $('pair-fallback').hidden = true; $('single-image-error').hidden = true; $('webgl-view').hidden = false; $('webgl-status').hidden = true; $('view-compass').hidden = false;
      instance.setActive(true); instance.setMarkersVisible($('show-markers').checked); instance.select(state.district); instance.setQualityVisible?.(state.quality);
      if (pendingFocus && pendingFocus === state.district) instance.focus(pendingFocus);
      pendingFocus = null; $('reset-view').hidden = false; $('reset-view').textContent = '원래 시점';
      $('orbit-instruction').textContent = state.compare ? '어느 쪽을 드래그해도 같은 각도로 회전합니다. 휠로 확대 · 방향키로 회전 · R 원래 시점' : '드래그해 회전 · 휠 또는 두 손가락으로 확대 · 방향키로 회전 · + / − 확대 · R 원래 시점';
    } catch (error) {
      if (token !== state.renderToken) return;
      console.warn('3D unavailable:', error); fallback3D('이 기기에서 3D를 불러오지 못해 실제 관측의 정지 이미지를 표시합니다. 구역별 정보는 그대로 확인할 수 있습니다.');
    } finally { if (loadingKey === key) loadingKey = ''; }
  }
  function renderHeading() {
    const changed = state.mode === 'change';
    $('scene-year').textContent = changed ? `${periodLabel(year())} − ${periodLabel(baseline())}` : periodLabel(year());
    $('scene-year-note').textContent = changed ? `같은 위치의 ${observation()} 차이` : observation();
    $('art-title').textContent = changed ? '평균이 지운 자리' : '한 숫자로 접기 전의 밤';
    $('scene-description').textContent = changed ? '금빛은 증가, 푸른빛은 감소입니다. 같은 자리의 다른 방향을 봅니다.' : `높이는 ${observation()}입니다. 지역을 누르면 안으로 들어갑니다.`;
    if (year() === baseline() && changed) $('scene-description').textContent = '비교의 기준이 되는 관측입니다. 같은 관측에서 같은 값을 빼면 차이는 0입니다.';
    $('story-hint').textContent = changed ? '평균의 방향과, 그 안의 자리를 함께 봅니다. 지역 안으로 들어가 보세요.' : '금빛 표면에서 시작해, 같은 자리의 변화를 살펴보세요.';
    const action = $('reveal-change'); action.replaceChildren(document.createTextNode(changed ? '빛의 양으로 돌아가기 ' : monthly() ? '지난해 같은 달 대비 ' : '처음의 빛을 빼기 '));
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
    $('quality-toggle').setAttribute('aria-pressed', String(state.quality));
    $('info-toggle').disabled = state.region === 'all';
    $('quality-panel').hidden = !state.quality;
    document.querySelectorAll('[data-mode]').forEach((button) => { button.disabled = state.compare; });
    if (state.compare) {
      $('scene-year').textContent = `${periodLabel(state.compareA)} ↔ ${periodLabel(state.compareB)}`;
      $('scene-year-note').textContent = '둘 다 실제 관측 · 밝기 대 밝기';
      $('art-title').textContent = '같은 자리, 다른 밤';
      $('scene-description').textContent = '시선을 맞추면, 한 숫자로는 보이지 않던 높낮이의 차이가 드러납니다.';
      $('compare-a').value = String(state.compareA); $('compare-b').value = String(state.compareB);
      $('pair-label-a').textContent = `A · ${periodLabel(state.compareA)}`; $('pair-label-b').textContent = `B · ${periodLabel(state.compareB)}`;
    }
  }
  function renderComparison() {
    const container = $('comparison'); container.replaceChildren();
    state.data.regions.forEach((r) => {
      const values = series(r), plate = el('figure', 'art-plate'), button = el('button', 'plate-button'); button.type = 'button'; button.setAttribute('aria-label', `${label(r)} 확대하고 구·군·시 보기`); button.addEventListener('click', () => setRegion(r.id));
      const heading = el('div', 'plate-label'); heading.append(el('h2', '', label(r)), el('span', 'metric-caption', state.mode === 'change' ? '평균 변화량' : '평균 복사휘도'));
      const value = el('p', 'plate-value', fmt(state.mode === 'change' ? values.change : values.mean, 2, state.mode === 'change')); value.append(el('small', '', units()));
      const visual = el('div', 'plate-image-wrap'), img = el('img'); img.src = imagePath(r); img.alt = `${label(r)} ${periodName(year())} ${state.mode === 'change' ? `${periodName(baseline())} 대비 변화` : observation()} 입체 작품`; img.draggable = false; img.decoding = 'async';
      img.addEventListener('error', () => { visual.replaceChildren(el('p', 'image-failure', '이 관측의 이미지를 불러오지 못했습니다.')); });
      visual.append(img, el('span', 'plate-enter', '이 지역 안으로')); button.append(heading, value, visual); plate.append(button);
      const caption = el('figcaption', 'plate-summary'); const growth = el('p', 'summary-row'); growth.append(el('span', '', `${periodLabel(baseline())} 대비 평균`), el('strong', '', pct(values.percent_change, true))); caption.append(growth);
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
    if ($('linked-map').dataset.key !== `${editionAsset(r.interaction_url || '')}/${r.id}`) { $('linked-map').replaceChildren(); $('region-map').hidden = true; }
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
    hotspots.hidden = !$('show-markers').checked;
    $('single-scene').style.transform = ''; $('single-scene').classList.remove('zoomed');
    $('reset-view').hidden = !viewerReady && !state.district;
    $('point-instruction').textContent = selected ? `${selected.name}의 경계 · 수치는 구역 전체 집계` : '입체의 지점, 지도, 목록에서 같은 구역을 선택할 수 있습니다.';
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
    drawChart(entity); renderQuality(entity); updateMapSelection(); update3D(r);
    const token = ++mapToken, currentData = state.data;
    loadInteraction(r).then((data) => {
      if (token !== mapToken || state.region !== r.id || state.data !== currentData) return;
      state.interaction = data; renderMap(r, data); renderQuality(entity);
      const record = pairRecord(entity);
      $('place-decrease').textContent = pct(record?.lower_area_pct ?? (state.compare ? null : series(entity).decreased_area_pct));
      if (state.compare) $('place-note').textContent = `${periodName(pair()[1])} 값이 ${periodName(pair()[0])}보다 낮은 면적의 비율입니다. 분모는 공통 관측 영역이며 작은 음수도 포함합니다.${!record ? ' 이 관측 조합의 면적 통계를 제공하지 못해 —로 표시합니다.' : ''}${Number(entity.coverage_pct) < 85 ? ' 관측 범위가 제한되어 전체 지역으로 확대 해석하지 않습니다.' : ''}`;
    });
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
    $('region-map').hidden = !!data || !r.map_url;
    if (!data || !Array.isArray(data.bounds) || !data.districts?.length) {
      target.replaceChildren(); target.dataset.key = '';
      if (r.map_url) $('region-map').src = editionAsset(r.map_url);
      $('map-status').textContent = '연동 경계를 불러오지 못했습니다. 위 목록에서 구역별 수치를 확인할 수 있습니다.'; return;
    }
    if (target.dataset.key !== key) {
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
  }
  function updateMapSelection() {
    $('linked-map').classList.toggle('show-quality', state.quality);
    $('linked-map').querySelectorAll('[data-district]').forEach((path) => { const selected = String(path.dataset.district) === String(state.district); path.classList.toggle('selected', selected); path.setAttribute('aria-pressed', String(selected)); });
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
    if (all) { ++state.renderToken; ++mapToken; loadingKey = ''; viewer?.setActive(false); renderComparison(); } else renderDetail();
    renderGuide();
    fitImmersiveCanvas();
    preloadNext();
  }
  function findGuideTarget() {
    const lastIndex = state.data.years.length - 1;
    const regions = state.data.regions.map((r) => ({ r, value: series(r, lastIndex), counterexample: r.districts.filter((d) => Number(d.coverage_pct) >= 85 && series(d, lastIndex).change < 0).sort((a,b) => series(a,lastIndex).percent_change - series(b,lastIndex).percent_change)[0] }));
    const candidate = regions.find((entry) => entry.value.change > 0 && entry.counterexample) || regions.find((entry) => entry.value.change > 0) || regions[0];
    const district = candidate.counterexample || [...candidate.r.districts].filter((d) => finite(series(d,lastIndex).mean)).sort((a,b) => series(a,lastIndex).percent_change - series(b,lastIndex).percent_change)[0];
    return { region: candidate.r.id, district: district?.id || null, counterexample: !!candidate.counterexample && candidate.value.change > 0 };
  }
  function setGuide(step) {
    if (!state.data) return;
    stopPlay();
    if (!state.guideTarget) state.guideTarget = findGuideTarget();
    const previousRegion = state.region;
    state.guide = Math.max(0, Math.min(3, step)); state.region = state.guideTarget.region; state.yearIndex = state.data.years.length - 1;
    state.compare = step === 3; state.compareA = state.data.years[0]; state.compareB = state.data.years.at(-1); state.mode = step === 1 || step === 2 ? 'change' : 'absolute';
    state.district = step >= 2 ? state.guideTarget.district : null; state.zoom = !!state.district;
    if (previousRegion !== state.region) state.interaction = null;
    state.infoHidden = false; syncInfo();
    if (step === 0) { state.quality = false; if (viewerReady) viewer.reset(); }
    pendingFocus = step === 2 ? state.district : null;
    render();
    if (viewerReady && step === 2 && state.district) viewer.focus(state.district);
    $('guided-story').scrollIntoView({behavior:reducedMotion.matches ? 'instant' : 'smooth', block:'start'});
    $('guide-step-title').focus({preventScroll:true});
    announce(`안내 감상 ${step+1} / 4. ${$('guide-step-title').textContent}`);
  }
  function renderGuide() {
    $('guided-story').hidden = state.guide === null;
    $('start-guide').setAttribute('aria-expanded', String(state.guide !== null));
    if (state.guide === null || !state.guideTarget) return;
    const r = state.data.regions.find((item) => item.id === state.guideTarget.region), d = r.districts.find((item) => String(item.id) === String(state.guideTarget.district));
    const last = state.data.years.length - 1, value = series(r,last), districtValue = d && series(d,last), first = periodLabel(baseline()), latest = periodLabel(state.data.years[last]);
    const direction = value.change > 0 ? '밝아졌습니다' : value.change < 0 ? '낮아졌습니다' : '같습니다';
    const chapters = [
      { title:`${label(r)}의 평균은 ${direction}`, body:`${first}의 ${fmt(series(r,0).mean,2)}에서 ${latest}의 ${fmt(value.mean,2)}로, 평균은 ${pct(value.percent_change,true)} 움직였습니다. 먼저 금빛의 높낮이를 천천히 돌려 보세요. 이 한 숫자 안에는 얼마나 다른 장소가 들어 있을까요?` },
      { title:'처음의 빛을 빼면, 방향이 보입니다', body:`같은 자리에서 ${first}의 값을 뺐습니다. 금빛은 높아진 자리, 푸른빛은 낮아진 자리입니다. ${latest}에 값이 더 낮은 면적은 공통 관측 영역의 ${pct(value.decreased_area_pct)}입니다. 색이 맞닿는 경계를 살펴보세요. 작은 차이도 이 비율에 포함됩니다.` },
      state.guideTarget.counterexample ? { title:`${d.name}, 평균과 다른 방향`, body:`${label(r)} 전체의 평균은 ${pct(value.percent_change,true)}이지만, ${d.name}의 평균은 ${pct(districtValue.percent_change,true)}입니다. 입체의 밝은 경계와 지도의 같은 구역을 따라 보세요. 이 수치는 그 구역 전체의 평균입니다. 빛의 감소만으로 쇠퇴나 원인을 단정하지 않습니다.` } : { title:d ? `${d.name}에서 차이를 확인합니다` : '평균 안의 장소를 확인합니다', body:d ? `이 판에서는 전체 평균의 증가와 구역 평균의 감소가 동시에 확인되는 사례를 고르지 못했습니다. 실제로 확인된 ${d.name}의 변화는 ${pct(districtValue.percent_change,true)}입니다. 평균과 장소를 같은 방향이라고 가정하지 않고, 경계와 수치를 함께 읽습니다.` : '지도의 구역을 선택해 각 장소의 실제 값을 확인합니다. 자료가 보여 주지 않는 반례는 만들어 넣지 않습니다.' },
      { title:'같은 시선에서, 두 밤을 다시 봅니다', body:`왼쪽 A는 ${first}, 오른쪽 B는 ${latest}의 실제 관측입니다. 두 표면은 같은 카메라로 움직입니다. 작은 화면에서는 A가 위에 놓입니다. 두 시점을 바꾸거나 다른 구역을 선택하며 질문을 이어가세요. 관측 범위를 켜면 보이지 않았던 자리와 작은 차이의 비율도 확인할 수 있습니다.` }
    ];
    const chapter = chapters[state.guide];
    $('guide-step-count').textContent = `0${state.guide+1} / 04 · ${label(r)}`;
    $('guide-step-title').textContent = chapter.title; $('guide-step-body').textContent = chapter.body;
    $('guide-prev').disabled = state.guide === 0; $('guide-next').textContent = state.guide === 3 ? '직접 이어 보기' : '다음 장면';
    document.querySelectorAll('.guide-progress span').forEach((node,index) => { node.classList.toggle('active',index === state.guide); node.classList.toggle('complete',index < state.guide); if(index === state.guide) node.setAttribute('aria-current','step'); else node.removeAttribute('aria-current'); });
  }
  function toggleComparison() {
    if (!state.data) return;
    leaveGuide(); stopPlay(); state.compare = !state.compare;
    if (state.region === 'all') { state.region = state.data.regions.find((r) => r.id === 'seoul')?.id || state.data.regions[0].id; state.interaction = null; state.district = null; }
    state.mode = 'absolute'; state.yearIndex = yearIndex(state.compareB);
    render(); announce(state.compare ? '두 시점 비교. A와 B는 같은 카메라와 같은 높이 규칙으로 표시됩니다.' : '한 시점의 밝기로 돌아왔습니다.');
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
    selector.value = selected.id; selector.disabled = false;
    $('history-latest').hidden = !state.archiveId;
    $('history-status').textContent = state.archiveId ? '기록된 판을 보고 있습니다. 이 판은 새 자료가 와도 자동으로 바뀌지 않습니다.' : history.editions.length === 1 ? '첫 기록 · 다음 자료부터 이전 판이 쌓입니다.' : '현재 공개된 판입니다. 새 관측이 검증되면 이전 판과 함께 기록됩니다.';
    const date = selected.recorded_at && !Number.isNaN(new Date(selected.recorded_at).getTime()) ? new Date(selected.recorded_at).toLocaleString('ko-KR',{year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Seoul'}) : '기록 시각 없음';
    $('history-period').textContent = `관측 ${selected.period_label || `${selected.observed_from}–${selected.observed_to}`} · 기록 ${date}`;
    $('history-summary').textContent = selected.summary || selected.reason || '검증된 관측과 그때의 공통 관측 영역을 보존했습니다.';
    $('history-changes').replaceChildren(); (selected.changes || []).filter((value) => typeof value === 'string').forEach((value) => $('history-changes').append(el('li','',value)));
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
    stopPlay(); leaveGuide(); state.historyLoading = true; $('history-select').disabled = true; $('history-status').textContent = '기록된 관측을 불러오는 중입니다.';
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
    } finally { if (token === historyToken) state.historyLoading = false; }
  }
  function preloadNext() {
    if (state.yearIndex >= state.data.years.length - 1) return;
    const next = state.data.years[state.yearIndex + 1];
    (state.region === 'all' ? state.data.regions : [region()]).forEach((r) => { const p = r.render?.[state.mode]?.find((f) => Number(f.year) === Number(next))?.url; if (p) { const img = new Image(); img.src = editionAsset(p); } });
  }
  function configureEdition() {
    const data = state.data, source = data.source || {}, isMonthly = monthly();
    document.body.classList.toggle('monthly-edition', isMonthly);
    document.title = `밤의 지문 — ${isMonthly ? '최근 같은 달의 관측' : '평균이 지운 자리'}`;
    document.querySelector('meta[name="description"]').content = isMonthly ? '서울·부산·제주의 같은 달 야간광을 비교하는 데이터 아트. 평균의 방향과 그 안의 자리를 함께 읽습니다.' : '서울·부산·제주의 공개 연간 야간광으로 읽는 데이터 아트. 평균이 밝아져도 모든 자리가 함께 밝아지는 것은 아닙니다.';
    $('opening-copy').textContent = isMonthly ? `${periodName(data.years[0])}과 ${periodName(data.years.at(-1))}, 같은 달의 밤을 겹칩니다. 평균의 방향과 그 안의 자리를 함께 봅니다.` : '한 숫자로 접힌 밤을 다시 펼칩니다. 세 지역의 빛, 그리고 그 안에 남은 다른 방향.';
    $('comparison').setAttribute('aria-label', `세 지역 같은 ${isMonthly ? '월간 관측' : '연도'} 비교`);
    $('timeline-label').textContent = isMonthly ? '같은 달의 관측 시점' : '관측 연도';
    $('year-ticks').setAttribute('aria-label', isMonthly ? '같은 달 관측 바로 선택' : '연도 바로 선택');
    document.querySelector('.place-main-value .unit').textContent = units();
    $('afterword-title').innerHTML = isMonthly ? '평균의 방향과,<br>그 안의 자리.' : '밝아진 밤 안에도,<br>낮아진 자리는 남아 있습니다.';
    $('afterword-main').textContent = isMonthly ? '평균이 움직인 방향과 모든 장소의 방향은 같지 않을 수 있습니다. 이 작품은 두 관측을 같은 자리에서 빼고, 한 숫자만으로는 보이지 않는 차이를 표면으로 펼칩니다.' : '평균의 증가는 모든 장소의 같은 변화를 뜻하지 않습니다. 이 작품은 빛이 놓인 위치를 표면으로 펼쳐, 한 숫자만으로는 보이지 않는 방향을 함께 남깁니다.';
    $('afterword-update').textContent = isMonthly ? '같은 달을 비교해 계절 차이를 줄이지만, 날씨와 관측 품질의 영향까지 사라지지는 않습니다. 새 비교 자료가 확보되면 같은 경계와 검증 기준으로 다시 질문합니다.' : '새로운 연간 관측이 공개되면, 같은 경계와 기준으로 다시 계산합니다. 작품은 관측이 늘어나는 만큼 이 질문을 이어 갑니다.';
    $('guide-height').textContent = `밝기 장면은 ${observation()}, 변화 장면은 같은 위치의 ${periodName(baseline())} 값을 뺀 차이입니다. 큰 값과 작은 값을 함께 보기 위해 비선형 높이를 사용합니다.`;
    $('guide-color').textContent = '변화 장면의 금빛은 증가, 푸른빛은 감소입니다. 등고선은 같은 표시 높이를 잇습니다. 선 한 줄이 하나의 관측 시점을 뜻하지 않습니다. 밝기 장면의 색과 그림자는 고정 조명입니다.';
    $('guide-time').textContent = isMonthly ? `각 연도의 ${data.period.month}월 실제 관측을 고릅니다. 재생은 공개된 관측의 순서이며 새 자료의 실시간 도착이 아닙니다. 그래프의 선은 두 시점을 연결할 뿐, 사이의 관측이나 연속 추세를 뜻하지 않습니다.` : '연도별 실제 관측을 고릅니다. 연도 재생은 공개된 과거 관측의 순서이며, 새로운 자료가 도착했다는 알림이나 실시간 측정이 아닙니다.';
    $('source-title').innerHTML = isMonthly ? '새로운 관측에도,<br>같은 자리에서 다시 묻습니다.' : '새로운 해에도,<br>같은 자리에서 다시 묻습니다.';
    $('source-lead').textContent = isMonthly ? '같은 달의 밤을 같은 좌표에서 비교합니다. 장기 변화와 최근 관측은 서로 다른 자료를 사용하는 별도의 판입니다. 두 판의 수치를 직접 이어 붙이지 않습니다.' : '야간광은 빛이면서 관측된 수치입니다. 같은 좌표를 여러 해에 걸쳐 읽을 수 있어, 평균과 그 안의 장소를 하나의 질문으로 연결합니다.';
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
    const repo = data.repository_url || data.source?.repository_url || data.update?.repository_url;
    $('repository-link').hidden = !(repo && /^https:\/\/github\.com\//.test(repo));
    if (!$('repository-link').hidden) $('repository-link').querySelector('a').href = repo;
    const schedule = data.update?.schedule_description || (monthly() ? '최근 관측 판은 공식 월간 자료를 확보하고 같은 달 비교가 가능한지 검증한 뒤 갱신합니다.' : '연간 자료를 주기적으로 점검하는 갱신 방식입니다.');
    $('automation-note').textContent = `${schedule} 새 ${monthly() ? '비교' : '연도'} 자료가 없으면 현재 작품을 유지합니다. 검증에 실패하거나 제품 규격이 바뀌면 기존 작품을 덮어쓰지 않습니다.`;
    if (replay) { $('update-notice').hidden = false; $('update-notice').textContent = '과거에 공개된 실제 관측으로 갱신 과정을 재현하고 있습니다. 새 자료의 실시간 도착을 뜻하지 않습니다.'; }
  }
  function initialize(data, refreshing = false) {
    if (!Array.isArray(data.years) || !data.years.length || !Array.isArray(data.regions) || data.regions.length !== 3) throw new Error('Invalid artwork manifest');
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
  $('start-guide').addEventListener('click', () => { state.guideTarget = null; setGuide(0); });
  $('guide-prev').addEventListener('click', () => setGuide(state.guide-1));
  $('guide-next').addEventListener('click', () => { if (state.guide === 3) { leaveGuide(); $('compare-a').focus(); announce('안내가 끝났습니다. 두 관측을 직접 선택하며 감상하세요.'); } else setGuide(state.guide+1); });
  $('guide-exit').addEventListener('click', () => { leaveGuide(); $('compare-toggle').focus(); announce('자유 감상으로 전환했습니다.'); });
  $('compare-toggle').addEventListener('click',toggleComparison);
  ['compare-a','compare-b'].forEach((id) => $(id).addEventListener('change', (event) => { leaveGuide(); stopPlay(); state[id === 'compare-a' ? 'compareA' : 'compareB'] = Number(event.target.value); state.yearIndex = yearIndex(state.compareB); render(); }));
  $('quality-toggle').addEventListener('click', () => {
    if (!state.data) return;
    state.quality = !state.quality;
    if (state.region === 'all') { leaveGuide(); state.region = state.data.regions[0].id; state.interaction = null; }
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
  $('show-markers').addEventListener('change', (e) => { $('hotspots').hidden = !e.target.checked; viewer?.setMarkersVisible(e.target.checked); });
  $('year-slider').addEventListener('input', (e) => { if (state.data) setYear(e.target.value); });
  $('play-years').addEventListener('click', playYears); $('retry-load').addEventListener('click', loadData);
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
