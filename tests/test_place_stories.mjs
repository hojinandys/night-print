import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PLACE_STORIES, eligiblePlaceStories, observationSummary, placeStoryScene, projectPlace} from '../dist/place-stories.mjs';

// The reviewed cases are frozen editorial observations. A future live edition
// must hide them until reviewed, without blocking automatic art publication.
const live = JSON.parse(readFileSync(new URL('../dist/data/manifest.json', import.meta.url)));
const manifest = {years: PLACE_STORIES[0].basis.years, units:'nW/cm²/sr',
  source:{doi:'10.5258/SOTON/WP00772'},
  regions:PLACE_STORIES.map(s => ({id:s.region})),
  experience:{files:PLACE_STORIES.map(s => ({region:s.region,sha256:s.basis.interactionHash}))}};
test('only the reviewed annual source and footprint expose the three stories', () => {
  assert.equal(eligiblePlaceStories(manifest).length, 3);
  const monthly = structuredClone(manifest);
  monthly.period = {kind: 'monthly_same_month'};
  assert.deepEqual(eligiblePlaceStories(monthly), []);
  const changed = structuredClone(manifest);
  changed.experience.files[0].sha256 = 'new source';
  assert.equal(eligiblePlaceStories(changed).length, 2);
  const extended = structuredClone(manifest);
  extended.years.push(2024);
  assert.deepEqual(eligiblePlaceStories(extended), []);
  assert.deepEqual(eligiblePlaceStories({...manifest, source:{doi:'other'}}), []);
});
test('public case text uses regional descriptions while original source links remain usable', () => {
  assert.deepEqual(PLACE_STORIES.map(story => [story.id, story.location.label]), [
    ['seoul-residential', '서울의 주거지'],
    ['busan-development', '부산의 해안 개발지'],
    ['jeju-tourism', '제주의 관광시설 주변'],
  ]);
  const definitions = JSON.parse(readFileSync(new URL('../pipeline/place_story_definitions.json', import.meta.url)));
  const checkText = (value, key = '') => {
    if (typeof value === 'string') {
      if (/url$/i.test(key)) return;
      assert.doesNotMatch(value, /둔촌|돈춘|오시리아|신화월드|신화테마파크|롯데월드|포레온|서머셋|dunchon|osiria|shinhwa/i);
    } else if (value && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) checkText(child, childKey);
    }
  };
  checkText(definitions);
  checkText(PLACE_STORIES);
  for (const story of PLACE_STORIES) {
    assert.equal(new URL(story.location.sourceUrl).protocol, 'https:');
    assert.ok(story.observation.scopeLabel.startsWith(story.location.label));
  }
});
test('cases carry real local means, fixed years, reproducible geometry and sources', () => {
  for (const story of PLACE_STORIES) {
    const summary = observationSummary(story);
    assert.ok(Number.isFinite(summary.change));
    assert.equal(summary.change, summary.to - summary.from);
    const scene = placeStoryScene(story, manifest);
    assert.equal(scene.compareA, story.fromYear);
    assert.equal(scene.compareB, story.toYear);
    assert.equal(scene.yearIndex, manifest.years.indexOf(story.toYear));
    assert.equal(scene.district, null);
    const geo = JSON.parse(readFileSync(new URL(`../dist/assets/interaction/${story.region}.json`, import.meta.url)));
    if (geo.source?.series_sha256 !== story.observation.sourceHash) {
      assert.equal(projectPlace(story, geo), null);
      assert.ok(!eligiblePlaceStories(live).some(s => s.id === story.id));
      continue;
    }
    const projected = projectPlace(story, geo);
    assert.ok(projected && projected.point.every(Number.isFinite));
    const [x,y] = projected.point, [x0,y0,x1,y1] = projected.bounds;
    assert.ok(x > x0 && x < x1 && y > y0 && y < y1);
    assert.ok(x >= geo.bounds[0] && x <= geo.bounds[2] && y >= geo.bounds[1] && y <= geo.bounds[3]);
    assert.ok(Math.abs((x1 - x0) / geo.coordinates.utm_to_world_scale - 1500) < 1e-6);
    assert.equal(projectPlace(story, {...geo, region:'wrong'}), null);
    assert.equal(projectPlace(story, {...geo, source:{series_sha256:'changed'}}), null);
    assert.equal(projectPlace(story, {...geo, coordinates:{...geo.coordinates, source_crs:'EPSG:4326'}}), null);
    assert.equal(story.observation.series.length, 9);
    assert.ok(story.observation.coveragePct > 90 && story.observation.coveragePct <= 100);
    assert.ok(story.event.sources.every(s => new URL(s.url).protocol === 'https:'));
  }
});
test('the selected dip, earlier growth, and later retreat remain in full observation history', () => {
  const [d,o,s] = PLACE_STORIES;
  assert.ok(observationSummary(d).change < 0);
  const at = (c,y) => c.observation.series.find(s => s.year === y).mean;
  assert.ok(at(o,2017) > at(o,2015));
  assert.ok(at(o,2023) < at(o,2022));
  assert.ok(at(s,2018) > at(s,2016));
  assert.ok(at(s,2023) < at(s,2018));
  assert.equal(observationSummary({...d, fromYear:2026}), null);
  assert.equal(placeStoryScene({...d, id:'missing'}, manifest), null);
});
