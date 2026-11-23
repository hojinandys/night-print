"""Monthly plan/publication checks run without scientific dependencies or tokens."""
import copy
import datetime as dt
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pipeline'))
import build_recent as recent


def record(year, month=10, production='2025001000000'):
    doy = dt.date(year, month, 1).timetuple().tm_yday
    name = f'VJ146A3.A{year}{doy:03}.h30v05.002.{production}.h5'
    return {'name': name, 'product': 'VJ146A3', 'collection': '002', 'tile': 'h30v05',
            'url': f'https://ladsweb.modaps.eosdis.nasa.gov/archive/allData/5200/VJ146A3/{year}/{doy:03}/{name}',
            'size': 100, 'status': 'Online', 'period': f'{year}-{month:02}'}


def check(month=10):
    return {'checked_utc': '2025-01-01T00:00:00Z', 'monthly_pair': [record(2023, month), record(2024, month)]}


def create_site(path):
    path.mkdir(parents=True)
    (path / 'data').mkdir()
    for name in ['index.html', 'app.js', 'style.css']:
        (path / name).write_text('monthly viewer', encoding='utf-8')
    Image.new('RGB', (1920, 1080), '#181818').save(path / 'frame.webp')
    plan = recent.make_plan(check())
    stat = {'means': [10.0, 11.0], 'coverage_pct': 99.0,
            'series': [{'year': 2023, 'mean': 10.0, 'change': 0, 'percent_change': 0, 'decreased_area_pct': 0},
                       {'year': 2024, 'mean': 11.0, 'change': 1, 'percent_change': 10, 'decreased_area_pct': 30}]}
    regions = []
    for rid, count in [('seoul', 25), ('busan', 16), ('jeju', 2)]:
        r = copy.deepcopy(stat)
        r.update({'id': rid, 'districts': [copy.deepcopy(stat) for _ in range(count)],
                  'render': {mode: [{'year': y, 'url': 'frame.webp'} for y in [2023, 2024]]
                             for mode in ['absolute', 'change']}})
        regions.append(r)
    manifest = {'years': plan['years'], 'baseline_year': 2023, 'period': plan['period'],
                'latest_period': '2024-10', 'source': {'doi': recent.DOI}, 'source_files': plan['monthly_pair'],
                'reading': {'height_absolute': '월간 복사휘도'}, 'regions': regions}
    recent.write_json(path / 'data/manifest.json', manifest)
    return manifest


class MonthlyTests(unittest.TestCase):
    def test_same_month_pair_has_rolling_baseline(self):
        p = recent.make_plan(check())
        self.assertEqual(p['years'], [2023, 2024])
        self.assertTrue(p['period']['baseline_moves'])
        self.assertEqual(p['period']['labels'], {'2023': '2023.10', '2024': '2024.10'})

    def test_identical_official_files_skip_heavy_work(self):
        first = recent.make_plan(check())
        existing = {'source': {'doi': recent.DOI}, 'period': first['period'],
                    'source_files': first['monthly_pair'], 'latest_period': '2024-10'}
        plan = recent.make_plan(check(), existing)
        self.assertFalse(plan['needs_build'])
        with patch.object(recent, 'inspect_inputs', side_effect=AssertionError('heavy work called')):
            result = recent.build(plan, '/unused', '/unused')
        self.assertFalse(result['heavy_build_performed'])

    def test_different_calendar_months_are_rejected(self):
        bad = check()
        bad['monthly_pair'][0] = record(2023, 9)
        with self.assertRaises(ValueError):
            recent.make_plan(bad)

    def test_new_collection_is_not_silently_substituted(self):
        bad = check()
        bad['monthly_pair'][0]['name'] = bad['monthly_pair'][0]['name'].replace('.002.', '.003.')
        with self.assertRaises(ValueError):
            recent.make_plan(bad)

    def test_reprocessed_same_month_requires_new_edition(self):
        p = recent.make_plan(check())
        old = {'source': {'doi': recent.DOI}, 'period': p['period'], 'source_files': p['monthly_pair'], 'latest_period': '2024-10'}
        new = check()
        new['monthly_pair'][1] = record(2024, production='2025002000000')
        plan = recent.make_plan(new, old)
        self.assertTrue(plan['needs_build'])
        self.assertFalse(plan['new_observation'])

    def test_annual_destination_cannot_be_replaced(self):
        with self.assertRaises(ValueError):
            recent.make_plan(check(), {'source': {'doi': '10.5258/SOTON/WP00772'}})

    def test_complete_monthly_site_validates(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'site'
            create_site(target)
            self.assertEqual(recent.validate_recent(target)['years'], [2023, 2024])

    def test_stale_annual_label_blocks_publication(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'site'
            m = create_site(target)
            m['reading']['height_absolute'] = '연평균 복사휘도'
            recent.write_json(target / 'data/manifest.json', m)
            with self.assertRaises(ValueError):
                recent.validate_recent(target)

    def test_missing_art_preserves_previous_edition(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            old, new = root / 'published', root / 'stage'
            create_site(old)
            create_site(new)
            (old / 'sentinel').write_text('keep')
            (new / 'frame.webp').unlink()
            with self.assertRaises(ValueError):
                recent.promote_recent(new, old, root / 'archive')
            self.assertEqual((old / 'sentinel').read_text(), 'keep')

    def test_rename_failure_rolls_back_previous_edition(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            old, new = root / 'published', root / 'stage'
            create_site(old)
            create_site(new)
            (old / 'sentinel').write_text('keep')
            original = Path.rename
            def fail_one(path, destination):
                if path == new:
                    raise OSError('simulated interrupted swap')
                return original(path, destination)
            with patch.object(Path, 'rename', fail_one), self.assertRaises(OSError):
                recent.promote_recent(new, old, root / 'archive')
            self.assertEqual((old / 'sentinel').read_text(), 'keep')

    def test_boundary_roundoff_is_accepted_but_real_overcoverage_is_not(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'site'
            m = create_site(target)
            m['regions'][0]['coverage_pct'] = 100 + 1e-11
            recent.write_json(target / 'data/manifest.json', m)
            recent.validate_recent(target)
            m['regions'][0]['coverage_pct'] = 100.01
            recent.write_json(target / 'data/manifest.json', m)
            with self.assertRaises(ValueError):
                recent.validate_recent(target)

    def test_unchanged_check_advances_check_time_not_artwork_time(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'site'
            m = create_site(target)
            m['updated_utc'] = '2024-11-15T00:00:00Z'
            recent.write_json(target / 'data/manifest.json', m)
            plan = recent.make_plan(check(), m)
            before = (target / 'frame.webp').read_bytes()
            recent.record_status(plan, 'up_to_date', target)
            after = recent.read_json(target / 'data/manifest.json')
            self.assertEqual(after['updated_utc'], m['updated_utc'])
            self.assertEqual(after['update']['last_checked'], plan['checked_at'])
            self.assertEqual((target / 'frame.webp').read_bytes(), before)

    def test_missing_credentials_retains_observed_period_and_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'site'
            m = create_site(target)
            plan = recent.make_plan(check(11), m)
            recent.record_status(plan, 'needs_credentials', target)
            after = recent.read_json(target / 'data/manifest.json')
            self.assertEqual(after['latest_period'], '2024-10')
            self.assertEqual(after['regions'], m['regions'])
            self.assertEqual(after['update']['latest_available_period'], '2024-11')
            self.assertEqual(after['update']['state'], 'needs_credentials')

    def test_validation_never_edits_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'site'
            create_site(target)
            path = target / 'data/manifest.json'
            before = path.read_bytes()
            recent.validate_recent(target)
            self.assertEqual(path.read_bytes(), before)
            path.unlink()
            with self.assertRaises(ValueError):
                recent.validate_recent(target)

    def test_broken_monthly_3d_geometry_keeps_the_existing_edition(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            old,new=root/'published',root/'stage'
            create_site(old);create_site(new)
            (old/'sentinel').write_text('keep')
            with patch.object(recent,'validate_interactive_art',side_effect=ValueError('Broken 3D binary')):
                with self.assertRaises(ValueError):
                    recent.promote_recent(new,old,root/'archive')
            self.assertEqual((old/'sentinel').read_text(),'keep')


if __name__ == '__main__':
    unittest.main()
