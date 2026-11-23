import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGuide } from '../dist/story.mjs';

const annual = JSON.parse(readFileSync(new URL('../dist/data/manifest.json', import.meta.url)));
const monthly = JSON.parse(readFileSync(new URL('../dist/recent/data/manifest.json', import.meta.url)));
// Fixed real observation snapshots for regression expectations. The live
// manifests above may change when a new observation is published.
const annualSnapshot = JSON.parse(readFileSync(new URL('../dist/history/605ffbb1b8dc273d8291/manifest.json', import.meta.url)));
const monthlySnapshot = JSON.parse(readFileSync(new URL('../dist/recent/history/652e6cc3072426d16333/manifest.json', import.meta.url)));
const serialized = (guide) => guide.chapters.map((chapter) => chapter.title + ' ' + chapter.body).join('\n');
const entity = (id, from, to, area = 25, coverage = 100) => ({ id, name: id, label: id,
  coverage_pct: coverage, series: [{ year: 2020, mean: from, decreased_area_pct: 0 },
    { year: 2021, mean: to, decreased_area_pct: area }] });
const fixture = (region, districts) => ({ years: [2020, 2021], baseline_year: 2020,
  units: 'nW/cm²/sr', regions: [{ ...region, districts }] });

for (const [edition, manifest] of [['annual', annual], ['monthly', monthly]]) {
  for (const regionId of ['seoul', 'busan', 'jeju']) {
    test(`${edition} ${regionId}: respects the chosen region and cites its observations`, () => {
      const original = JSON.stringify(manifest), guide = createGuide(manifest, regionId);
      const region = manifest.regions.find((item) => item.id === regionId);
      assert.equal(guide.region, regionId);
      assert.equal(guide.chapters.length, 4);
      assert.ok(region.districts.some((item) => item.id === guide.district && item.coverage_pct >= 85));
      assert.match(guide.chapters[0].title, new RegExp(region.label));
      assert.ok(guide.chapters[0].body.includes(region.series[0].mean.toFixed(2)));
      assert.ok(guide.chapters[0].body.includes(region.series.at(-1).mean.toFixed(2)));
      assert.ok(guide.chapters[1].body.includes(region.series.at(-1).decreased_area_pct.toFixed(1) + '%'));
      assert.match(guide.chapters[3].body, /실제 관측/);
      assert.match(guide.chapters[3].body, /비교 끄기/);
      assert.equal(JSON.stringify(manifest), original);
      assert.doesNotMatch(serialized(guide), /NaN|undefined|Infinity/);
      if (edition === 'monthly') {
        const start = `${manifest.baseline_year}년 ${manifest.period.month}월`;
        const end = `${manifest.years.at(-1)}년 ${manifest.period.month}월`;
        assert.ok(guide.chapters[0].body.includes(start));
        assert.ok(guide.chapters[0].body.includes(end));
      }
    });
  }
}

test('all-region guide has a deterministic Seoul starting point, explicit unknown region is rejected', () => {
  assert.equal(createGuide(annual, 'all').region, 'seoul');
  assert.equal(createGuide(annual).region, 'seoul');
  assert.throws(() => createGuide(annual, 'not-a-region'), /selected guide region/);
});

test('archived annual counterexamples remain in Seoul and Busan, not an invented Jeju decline', () => {
  assert.equal(createGuide(annualSnapshot, 'seoul').district, '11110');
  const busan = createGuide(annualSnapshot, 'busan');
  assert.equal(busan.district, '26170');
  assert.equal(busan.counterexample, true);
  assert.match(busan.chapters[2].body, /\+20\.0%.*-4\.6%/);
  const jeju = createGuide(annualSnapshot, 'jeju');
  assert.equal(jeju.counterexample, false);
  assert.match(jeju.chapters[2].body, /제주시 \+34\.1%, 서귀포시 \+65\.9%/);
  assert.match(jeju.chapters[2].body, /6\.0%/);
});

test('archived monthly Busan and Jeju distinguish rising means from lower positions', () => {
  const busan = createGuide(monthlySnapshot, 'busan');
  assert.equal(busan.counterexample, false);
  assert.equal(busan.district, '26320');
  assert.match(busan.chapters[2].body, /모두 높아졌습니다/);
  assert.match(busan.chapters[2].body, /46\.6%/);
  const jeju = createGuide(monthlySnapshot, 'jeju');
  assert.equal(jeju.district, '50130');
  assert.equal(jeju.counterexample, false);
  assert.match(jeju.chapters[2].body, /39\.2%/);
});

test('a later monthly fixture uses its own month and observed years', () => {
  const manifest = fixture(entity('later', 10, 12), [entity('place', 5, 6)]);
  manifest.period = { kind: 'monthly_same_month', month: 11 };
  const guide = createGuide(manifest, 'later');
  assert.match(guide.chapters[0].body, /2020년 11월.*2021년 11월/);
  assert.doesNotMatch(serialized(guide), /2025년|2026년|10월/);
});

test('zero starting mean uses an absolute difference, not a fabricated percentage', () => {
  const guide = createGuide(fixture(entity('zero', 0, 2), [entity('place', 0, 1)]), 'zero');
  assert.match(guide.chapters[0].body, /평균 차이는 \+2\.00 nW/);
  assert.doesNotMatch(serialized(guide), /NaN|Infinity|undefined/);
});

test('unchanged mean does not claim every position stayed unchanged', () => {
  const guide = createGuide(fixture(entity('same', 10, 10, 45), [entity('place', 5, 5, 50)]), 'same');
  assert.match(guide.chapters[0].title, /같습니다/);
  assert.match(guide.chapters[2].body, /50\.0%/);
  assert.equal(guide.counterexample, false);
  assert.doesNotMatch(serialized(guide), /모두 높아졌습니다|모든.*같습니다/);
});

test('no measured lower area does not narrate a hidden decline', () => {
  const guide = createGuide(fixture(entity('rising', 10, 12, 0), [entity('place', 5, 6, 0)]), 'rising');
  assert.equal(guide.counterexample, false);
  assert.match(guide.chapters[2].body, /낮아진 면적은 0\.0%/);
  assert.doesNotMatch(guide.chapters[2].title, /남은 감소/);
});

test('falling regional mean can have a genuine rising-district counterexample', () => {
  const guide = createGuide(fixture(entity('falling', 10, 8, 70), [entity('growing', 5, 6, 30)]), 'falling');
  assert.equal(guide.counterexample, true);
  assert.match(guide.chapters[0].title, /낮아졌습니다/);
  assert.match(guide.chapters[2].body, /-20\.0%.*\+20\.0%/);
});

test('coverage excludes a dramatic but weakly observed district', () => {
  const guide = createGuide(fixture(entity('overall', 10, 12), [entity('low-coverage', 10, 1, 90, 70), entity('covered', 10, 9, 60, 95)]), 'overall');
  assert.equal(guide.district, 'covered');
  assert.equal(guide.counterexample, true);
});

test('missing or ineligible district data does not invent a place or percentage', () => {
  const guide = createGuide(fixture(entity('overall', 10, 12), [entity('missing', 5, null), entity('excluded', 10, 8, 80, 30)]), 'overall');
  assert.equal(guide.district, null);
  assert.equal(guide.counterexample, false);
  assert.match(guide.chapters[2].body, /고르지 못했습니다/);
  assert.doesNotMatch(serialized(guide), /NaN|undefined|Infinity/);
});

test('missing area statistics stay missing, not zero', () => {
  const guide = createGuide(fixture(entity('overall', 10, 12, null), [entity('place', 5, 6, null)]), 'overall');
  assert.match(guide.chapters[1].body, /통계는 제공되지 않습니다/);
  assert.match(guide.chapters[2].body, /통계는 없어/);
});

test('unobserved baseline or incomplete regional means are rejected', () => {
  const missingBaseline = fixture(entity('overall', 10, 12), []);
  missingBaseline.baseline_year = 2019;
  assert.throws(() => createGuide(missingBaseline, 'overall'), /baseline/);
  assert.throws(() => createGuide(fixture(entity('overall', 10, null), []), 'overall'), /incomplete observations/);
});
