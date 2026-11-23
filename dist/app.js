'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const state = { data: null, region: 'all', mode: 'absolute', yearIndex: 0, district: null, timer: null, zoom: false, renderToken: 0 };
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
  function imagePath(r) {
    const frames = r.render?.[state.mode] || [];
    return frames.find((f) => Number(f.year) === Number(year()))?.url || '';
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
    stopPlay(); state.yearIndex = Math.max(0, Math.min(state.data.years.length - 1, Number(index))); render();
  }
  function setRegion(id) {
    if (!state.data || (id !== 'all' && !state.data.regions.some((r) => r.id === id))) return;
    state.region = id; state.district = null; state.zoom = false; render();
    $('artwork').scrollIntoView({ behavior: reducedMotion.matches ? 'instant' : 'smooth', block: 'start' });
    announce(id === 'all' ? '세 지역 비교' : `${label(region())} 안의 구·군·시를 선택할 수 있습니다.`);
  }
  function setMode(mode, fromStory = false) {
    if (!state.data) return;
    state.mode = mode;
    if (fromStory) { stopPlay(); state.yearIndex = state.data.years.length - 1; }
    render();
    if (fromStory) $('artwork').scrollIntoView({ behavior: reducedMotion.matches ? 'instant' : 'smooth', block: 'start' });
    announce(mode === 'change' ? `${periodName(baseline())}의 빛을 뺀 변화입니다. 금빛은 증가, 푸른빛은 감소입니다.` : `${observation()}의 밝기 장면입니다.`);
  }
  function selectDistrict(id) {
    state.district = id || null; state.zoom = !!id; renderDetail();
    const d = region().districts.find((x) => String(x.id) === String(id));
    if (d) announce(`${d.name} 확대. ${periodName(year())} 기준 ${periodName(baseline())} 대비 평균 ${pct(series(d).percent_change, true)}.`);
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
    points.forEach(([x, y], i) => { const dot = document.createElementNS(ns, 'circle'); dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('r', i === state.yearIndex ? '3.5' : '1.7'); dot.setAttribute('fill', i === state.yearIndex ? '#eae6dc' : '#8e989f'); svg.append(dot); });
    [[8, periodLabel(state.data.years[0]), 'start'], [238, periodLabel(state.data.years.at(-1)), 'end']].forEach(([x, text, anchor]) => { const t = document.createElementNS(ns, 'text'); t.setAttribute('x', x); t.setAttribute('y', '81'); t.setAttribute('text-anchor', anchor); t.setAttribute('fill', '#7c8790'); t.setAttribute('font-size', '11'); t.textContent = text; svg.append(t); });
    const rangeLabel = document.createElementNS(ns, 'text'); rangeLabel.setAttribute('x', '238'); rangeLabel.setAttribute('y', '9'); rangeLabel.setAttribute('text-anchor', 'end'); rangeLabel.setAttribute('fill', '#7c8790'); rangeLabel.setAttribute('font-size', '10'); rangeLabel.textContent = `${fmt(low, 2)}–${fmt(high, 2)} ${units()}`; svg.append(rangeLabel);
    target.append(svg); target.setAttribute('aria-label', `${entity.name || entity.label || entity.full_name} 시점별 평균 복사휘도: ${state.data.years.map((y, i) => `${periodName(y)} ${fmt(values[i], 2)}`).join(', ')}. 선은 표시된 관측을 연결하며 그 사이의 측정값을 뜻하지 않습니다.`);
  }
  function renderDetail() {
    if (state.region === 'all') return;
    const r = region(), selected = r.districts.find((d) => String(d.id) === String(state.district)), entity = selected || r, values = series(entity);
    $('detail-label').textContent = `${label(r)} · ${state.mode === 'change' ? '변화의 표면' : '밝기의 표면'}`;
    const img = $('single-image'), path = imagePath(r); if (img.getAttribute('src') !== path) { $('single-image-error').hidden = true; img.src = path; }
    img.alt = `${label(r)} ${periodName(year())} ${state.mode === 'change' ? `${periodName(baseline())} 대비 변화` : observation()} 입체 작품`;
    const select = $('district-select'), currentIds = r.districts.map((d) => String(d.id)).join(',');
    if (select.dataset.ids !== currentIds) { select.replaceChildren(new Option(`${label(r)} 전체`, '')); r.districts.forEach((d) => select.add(new Option(d.name, d.id))); select.dataset.ids = currentIds; }
    select.value = state.district || '';
    const hotspots = $('hotspots'); hotspots.replaceChildren();
    r.districts.forEach((d) => {
      const a = d.anchor_by_mode?.[state.mode] || d.anchor; if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) return;
      const b = el('button', 'hotspot'); b.type = 'button'; b.style.left = `${a.x * 100}%`; b.style.top = `${a.y * 100}%`; b.classList.toggle('cold', state.mode === 'change' && series(d).change < 0); b.classList.toggle('selected', String(d.id) === String(state.district)); b.setAttribute('aria-label', `${d.name} 확대 및 정보`); b.setAttribute('aria-pressed', String(String(d.id) === String(state.district))); b.append(el('span', '', d.name)); b.addEventListener('click', () => selectDistrict(d.id)); hotspots.append(b);
    });
    hotspots.hidden = !$('show-markers').checked;
    const scene = $('single-scene'), anchor = selected?.anchor_by_mode?.[state.mode] || selected?.anchor;
    if (state.zoom && anchor) { scene.style.transformOrigin = `${anchor.x * 100}% ${anchor.y * 100}%`; scene.style.transform = `translate(${(.5 - anchor.x) * 100}%, ${(.5 - anchor.y) * 100}%) scale(2.05)`; scene.classList.add('zoomed'); }
    else { scene.style.transformOrigin = '50% 50%'; scene.style.transform = ''; scene.classList.remove('zoomed'); }
    $('reset-view').hidden = !state.zoom;
    $('point-instruction').textContent = selected ? `${selected.name}의 대표 위치 · 구역 전체 집계` : '표시된 지점이나 목록에서 구·군·시를 선택하세요.';
    $('place-title').textContent = selected ? selected.name : (r.full_name || label(r));
    $('place-context').textContent = `이 판의 ${commonArea()} · 면적 가중 평균`;
    $('place-value').textContent = fmt(state.mode === 'change' ? values.change : values.mean, 2, state.mode === 'change');
    $('place-value-label').textContent = state.mode === 'change' ? `${periodLabel(baseline())} 대비 평균 변화량` : `${periodLabel(year())} 평균 복사휘도`;
    $('growth-label').textContent = `${periodLabel(baseline())} 대비 평균`;
    $('place-growth').textContent = pct(values.percent_change, true); $('place-decrease').textContent = pct(values.decreased_area_pct); $('place-coverage').textContent = pct(entity.coverage_pct);
    $('place-note').textContent = `${periodName(year())} 값이 ${periodName(baseline())}보다 낮은 면적의 비율입니다. 분모는 공통 관측 영역이며 통계적 유의성을 뜻하지 않습니다.${Number(entity.coverage_pct) < 85 ? ' 관측 범위가 제한된 구역이므로 전체 지역으로 확대 해석하지 않습니다.' : ''}`;
    const map = $('region-map'); if (r.map_url) { map.src = r.map_url; map.hidden = false; map.alt = `${r.full_name || label(r)}의 북쪽이 위인 행정 경계 지도`; } else map.hidden = true;
    drawChart(entity);
  }
  function render() {
    if (!state.data) return;
    renderHeading(); const all = state.region === 'all'; $('comparison').hidden = !all; $('region-detail').hidden = all;
    if (all) renderComparison(); else renderDetail();
    preloadNext();
  }
  function preloadNext() {
    if (state.yearIndex >= state.data.years.length - 1) return;
    const next = state.data.years[state.yearIndex + 1];
    (state.region === 'all' ? state.data.regions : [region()]).forEach((r) => { const p = r.render?.[state.mode]?.find((f) => Number(f.year) === Number(next))?.url; if (p) { const img = new Image(); img.src = p; } });
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
    $('year-slider').max = String(data.years.length - 1); $('year-ticks').replaceChildren();
    data.years.forEach((y, i) => { const b = el('button', '', periodLabel(y)); b.type = 'button'; b.dataset.yearIndex = String(i); b.setAttribute('aria-label', `${periodName(y)} 관측 보기`); b.addEventListener('click', () => setYear(i)); $('year-ticks').append(b); });
    $('load-state').hidden = true; $('load-error').hidden = true; $('timeline').hidden = false; $('artwork').setAttribute('aria-busy', 'false');
    configureEdition(); updateMetadata(); render();
    if (refreshing) { $('update-notice').hidden = false; $('update-notice').textContent = `${periodName(data.years.at(-1))}까지의 검증된 관측으로 작품이 갱신되었습니다.`; announce($('update-notice').textContent); }
  }
  async function loadData() {
    $('load-error').hidden = true; $('load-state').hidden = false;
    try { const response = await fetch('./data/manifest.json', { cache: 'no-cache' }); if (!response.ok) throw new Error(`Manifest ${response.status}`); initialize(await response.json()); }
    catch (error) { $('load-state').hidden = true; $('load-error').hidden = false; $('artwork').setAttribute('aria-busy', 'false'); console.error('Artwork load failed:', error); }
  }
  async function checkForUpdates() {
    if (document.hidden || !state.data) return;
    try {
      const response = await fetch('./data/manifest.json', { cache: 'no-cache' }); if (!response.ok) return;
      const data = await response.json();
      const identity = (v) => JSON.stringify([v.years, v.release_id || v.updated_utc]);
      if (identity(data) !== identity(state.data)) { stopPlay(); initialize(data, true); }
      else { state.data.update = data.update; updateMetadata(); }
    } catch { /* A failed refresh leaves the last complete artwork in place. */ }
  }
  document.querySelectorAll('[data-region]').forEach((b) => b.addEventListener('click', () => setRegion(b.dataset.region)));
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('reveal-change').addEventListener('click', () => setMode(state.mode === 'absolute' ? 'change' : 'absolute', true));
  $('district-select').addEventListener('change', (e) => selectDistrict(e.target.value));
  $('reset-view').addEventListener('click', () => { state.district = null; state.zoom = false; renderDetail(); });
  $('show-markers').addEventListener('change', (e) => { $('hotspots').hidden = !e.target.checked; });
  $('year-slider').addEventListener('input', (e) => { if (state.data) setYear(e.target.value); });
  $('play-years').addEventListener('click', playYears); $('retry-load').addEventListener('click', loadData);
  $('single-image').addEventListener('error', () => { $('single-image-error').hidden = false; });
  $('single-image').addEventListener('load', () => { $('single-image-error').hidden = true; });
  document.querySelectorAll('[data-dialog]').forEach((b) => b.addEventListener('click', () => { stopPlay(); $(b.dataset.dialog).showModal(); document.body.classList.add('dialog-open'); }));
  document.querySelectorAll('dialog').forEach((dialog) => { dialog.addEventListener('close', () => document.body.classList.remove('dialog-open')); dialog.addEventListener('click', (event) => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } }); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && state.zoom && !document.querySelector('dialog[open]')) { state.district = null; state.zoom = false; renderDetail(); } });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopPlay(); else checkForUpdates(); });
  reducedMotion.addEventListener('change', () => stopPlay());
  window.setInterval(checkForUpdates, 180000);
  loadData();
})();
