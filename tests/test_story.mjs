import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGuide, guideScene } from '../dist/story.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const annual = read('../dist/data/manifest.json');
const monthly = read('../dist/recent/data/manifest.json');
// Fixed observations protect numerical expectations while the live editions grow.
const annualSnapshot = read('../dist/history/605ffbb1b8dc273d8291/manifest.json');
const monthlySnapshot = read('../dist/recent/history/652e6cc3072426d16333/manifest.json');
const serialized = (guide) => guide.chapters.map((chapter) => chapter.title + ' ' + chapter.body).join('\n');
const entity = (id, from, to, area = 25) => ({ id, name: id, label: id,
  series: [{ year: 2020, mean: from, decreased_area_pct: 0 },
    { year: 2021, mean: to, decreased_area_pct: area }] });
const fixture = (...regions) => ({ years: [2020, 2021], baseline_year: 2020,
  units: 'nW/cm²/sr', regions });

for (const [edition, manifest] of [['annual', annual], ['monthly', monthly]]) {
  for (const regionId of ['all', 'seoul', 'busan', 'jeju']) {
    test(`${edition} ${regionId}: actual observations and free choice of place`, () => {
      const original = JSON.stringify(manifest), guide = createGuide(manifest, regionId);
      const regions = regionId === 'all' ? manifest.regions : manifest.regions.filter((item) => item.id === regionId);
      assert.equal(guide.region, regionId);
      assert.equal(guide.district, null);
      assert.equal(guide.chapters.length, 4);
      for (const region of regions) {
        assert.ok(guide.chapters[0].body.includes(region.label));
        if (regionId !== 'all') {
          assert.ok(guide.chapters[0].body.includes(region.series[0].mean.toFixed(2)));
          assert.ok(guide.chapters[0].body.includes(region.series.at(-1).mean.toFixed(2)));
        }
        assert.ok(guide.chapters[1].body.includes(region.series.at(-1).decreased_area_pct.toFixed(1) + '%'));
      }
      assert.match(guide.chapters[3].body, /다시 전체.*어떤 말로 설명/);
      assert.doesNotMatch(serialized(guide), /NaN|undefined|Infinity|종로구|동구/);
      assert.equal(JSON.stringify(manifest), original);
      for (let step = 0; step < 4; step++) {
        const scene = guideScene(guide, step, manifest.years);
        assert.equal(scene.region, regionId);
        assert.equal(scene.compare, false);
        assert.equal(scene.district, null);
        assert.equal(scene.zoom, false);
        assert.equal(scene.yearIndex, manifest.years.length - 1);
      }
      assert.equal(guideScene(guide, 0, manifest.years).mode, 'absolute');
      assert.equal(guideScene(guide, 3, manifest.years).mode, 'change');
      if (edition === 'monthly') {
        const start = `${manifest.baseline_year}년 ${manifest.period.month}월`;
        const end = `${manifest.years.at(-1)}년 ${manifest.period.month}월`;
        assert.ok(guide.chapters[0].body.includes(start));
        assert.ok(guide.chapters[0].body.includes(end));
        assert.doesNotMatch(serialized(guide), /매년|2015년|2023년/);
      }
    });
  }
}

test('overview never silently switches to Seoul and unknown regions are rejected', () => {
  assert.equal(createGuide(annual).region, 'all');
  assert.equal(createGuide(annual, null).region, 'all');
  assert.throws(() => createGuide(annual, 'not-a-region'), /selected guide region/);
});

test('archived annual overview grounds the story in all three regions', () => {
  const guide = createGuide(annualSnapshot);
  assert.match(guide.chapters[0].body, /서울.*\+14\.1%.*부산.*\+20\.0%.*제주.*\+44\.5%/);
  assert.match(guide.chapters[1].body, /21\.2%.*20\.0%.*5\.2%/);
  assert.match(guide.chapters[2].body, /부산은.*9개 연도.*매년.*20\.0%/);
  assert.match(guide.chapters[2].body, /서울 \+6\.14, 부산 \+4\.06, 제주 \+1\.10/);
});

test('monthly snapshot uses its own observations without importing the annual story', () => {
  const guide = createGuide(monthlySnapshot);
  for (const region of monthlySnapshot.regions) {
    const first = region.series[0].mean, last = region.series.at(-1).mean;
    assert.ok(guide.chapters[0].body.includes(((last - first) / first * 100).toFixed(1) + '%'));
  }
  assert.doesNotMatch(serialized(guide), /매년|9개 연도|14\.1%|20\.0%|44\.5%/);
});

test('a later monthly edition uses its own month and observed years', () => {
  const manifest = fixture(entity('later', 10, 12));
  manifest.period = { kind: 'monthly_same_month', month: 11 };
  const guide = createGuide(manifest, 'later');
  assert.match(guide.chapters[0].body, /2020년 11월.*2021년 11월/);
  assert.doesNotMatch(serialized(guide), /2025년|2026년|10월|매년/);
});

test('zero starting mean uses an absolute difference without an infinite percentage', () => {
  const guide = createGuide(fixture(entity('zero', 0, 2)), 'zero');
  assert.match(guide.chapters[0].body, /평균 차이는 \+2\.00 nW/);
  assert.doesNotMatch(serialized(guide), /NaN|Infinity|undefined/);
});

test('unchanged mean does not assert unchanged places', () => {
  const guide = createGuide(fixture(entity('same', 10, 10, 45)), 'same');
  assert.match(guide.chapters[0].title, /같습니다/);
  assert.match(guide.chapters[1].body, /45\.0%/);
  assert.doesNotMatch(serialized(guide), /모두 높아졌습니다|모든.*같습니다/);
});

test('zero or missing lower-area values are not invented declines', () => {
  const zero = createGuide(fixture(entity('rising', 10, 12, 0)), 'rising');
  assert.match(zero.chapters[1].body, /낮아진 면적은.*0\.0%/);
  assert.doesNotMatch(zero.chapters[3].body, /낮아진 자리는 남아/);
  const missing = createGuide(fixture(entity('rising', 10, 12, null)), 'rising');
  assert.match(missing.chapters[1].body, /통계는 제공되지 않습니다/);
  assert.doesNotMatch(serialized(missing), /NaN|undefined|Infinity/);
});

test('future overview directions follow the observations, including falls and mixed directions', () => {
  const falling = createGuide(fixture(entity('one', 10, 8), entity('two', 5, 4), entity('three', 20, 10)));
  assert.match(falling.chapters[0].title, /모두 낮아졌습니다/);
  assert.doesNotMatch(serialized(falling), /모두 높아졌습니다/);
  const mixed = createGuide(fixture(entity('one', 10, 8), entity('two', 5, 6), entity('three', 20, 20)));
  assert.match(mixed.chapters[0].title, /서로 다른 방향/);
});

test('a gapped or nonmonotonic annual series is not narrated as a yearly rise', () => {
  const manifest = fixture(entity('one', 10, 12));
  manifest.years = [2020, 2021, 2022];
  manifest.regions[0].series.push({year: 2022, mean: 11, decreased_area_pct: 30});
  assert.doesNotMatch(serialized(createGuide(manifest)), /매년/);
  manifest.regions[0].series[1].mean = null;
  assert.doesNotMatch(serialized(createGuide(manifest)), /매년/);
});

test('unobserved baseline and incomplete observations fail without fabricated prose', () => {
  const missingBaseline = fixture(entity('overall', 10, 12));
  missingBaseline.baseline_year = 2019;
  assert.throws(() => createGuide(missingBaseline, 'overall'), /baseline/);
  assert.throws(() => createGuide(fixture(entity('overall', 10, null)), 'overall'), /incomplete observations/);
});

test('curated annual guides connect distribution to a voluntary place story', () => {
  for (const id of ['all', 'seoul', 'busan', 'jeju']) {
    const guide = createGuide(annualSnapshot, id);
    assert.equal(guide.chapters[2].action, 'choose-place-story');
    assert.match(guide.chapters[2].body, /장소의 변화.*9년 흐름.*기록/);
    assert.match(guide.chapters[2].body, /원인이 증명되는 것은 아닙니다/);
    assert.ok(guide.chapters.filter(chapter => chapter.action).length === 1);
    assert.equal(guideScene(guide, 2, annualSnapshot.years).region, id);
    assert.equal(guideScene(guide, 2, annualSnapshot.years).compare, false);
  }
});

test('a monthly or revised annual footprint never inherits the curated case invitation', () => {
  assert.ok(createGuide(monthlySnapshot).chapters.every(chapter => !chapter.action));
  const changed = structuredClone(annualSnapshot);
  changed.experience.files.forEach(file => { file.sha256 = 'unreviewed-observation'; });
  assert.ok(createGuide(changed).chapters.every(chapter => !chapter.action));
  assert.doesNotMatch(serialized(createGuide(changed)), /이주·개장/);
  const onlyBusan = structuredClone(annualSnapshot);
  onlyBusan.experience.files = onlyBusan.experience.files.filter(file => file.region === 'busan');
  assert.equal(createGuide(onlyBusan, 'busan').chapters[2].action, 'choose-place-story');
  assert.ok(createGuide(onlyBusan, 'seoul').chapters.every(chapter => !chapter.action));
});
