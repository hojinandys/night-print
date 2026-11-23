"""Protect observed comparisons and linked geometry; validator needs only stdlib."""
import copy
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pipeline'))
import export_experience as experience


def rectangle(x0, y0, x1, y1):
    return {'outer': [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]], 'holes': []}


def fixture(path):
    years = [2020, 2021]
    pairs = []
    for a in years:
        for b in years:
            delta = b - a
            pairs.append({
                'from': a, 'to': b, 'from_mean': a - 2019, 'to_mean': b - 2019,
                'mean_change': delta, 'percent_change': delta / (a - 2019) * 100,
                'lower_area_pct': 100 if delta < 0 else 0,
                'higher_area_pct': 100 if delta > 0 else 0,
                'unchanged_area_pct': 100 if delta == 0 else 0,
                'from_zero_area_pct': 0, 'to_zero_area_pct': 0,
                'small_change_area_pct': {format(t, 'g'): 100 if abs(delta) <= t else 0
                                          for t in experience.THRESHOLDS},
                'decrease_beyond_pct': {format(t, 'g'): 100 if delta < -t else 0
                                        for t in experience.THRESHOLDS},
                'increase_beyond_pct': {format(t, 'g'): 100 if delta > t else 0
                                        for t in experience.THRESHOLDS},
            })
    series = [{'year': 2020, 'mean': 1, 'decreased_area_pct': 0},
              {'year': 2021, 'mean': 2, 'decreased_area_pct': 0}]
    full = [rectangle(0, 0, 2, 1)]
    district = {'id': '101', 'name': '테스트구', 'polygons': full, 'anchor': [1, .5],
                'coverage_pct': 50, 'observed_area_km2': 1, 'missing_area_km2': 1,
                'comparisons': copy.deepcopy(pairs)}
    data = {'schema': 1, 'region': 'test', 'name': '테스트', 'years': years,
            'units': 'nW/cm²/sr', 'bounds': [0, 0, 2, 1], 'polygons': full,
            'observed': [rectangle(0, 0, 1, 1)], 'missing': [rectangle(1, 0, 2, 1)],
            'districts': [district], 'comparisons': pairs, 'coverage_pct': 50,
            'observed_area_km2': 1, 'missing_area_km2': 1, 'boundary_area_km2': 2,
            'quality': {'thresholds': list(experience.THRESHOLDS)},
            'coordinates': {'system': 'original_relief_world_xy', 'north': '+Y',
                            'utm_to_world_scale': .001}}
    manifest = {'years': years, 'units': data['units'], 'regions': [
        {'id': 'test', 'coverage_pct': 50, 'series': series,
         'districts': [{'id': '101', 'name': '테스트구', 'coverage_pct': 50, 'series': series}],
         'interaction_url': 'assets/interaction/test.json'}],
        'experience': {'schema': 1, 'quality_thresholds': list(experience.THRESHOLDS),
                       'files': [{'region': 'test', 'url': 'assets/interaction/test.json'}]}}
    save_fixture(path, manifest, data)
    return manifest, data


def save_fixture(path, manifest, data):
    asset = path / 'assets/interaction/test.json'
    experience.write_json(asset, data)
    manifest['experience']['files'][0].update(bytes=asset.stat().st_size,
                                             sha256=experience.sha(asset))
    experience.write_json(path / 'data/manifest.json', manifest)


class ExperienceValidationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.out = Path(self.temp.name)
        self.manifest, self.data = fixture(self.out)

    def assert_rejects(self, edit, expected):
        edit(self.manifest, self.data)
        # Re-sign to reach semantic validation instead of failing the checksum.
        save_fixture(self.out, self.manifest, self.data)
        with self.assertRaisesRegex(ValueError, expected):
            experience.validate(self.out)

    def test_small_edition_validates_without_scientific_dependencies(self):
        self.assertEqual(experience.validate(self.out),
                         {'validated': True, 'regions': 1, 'districts': 1, 'observed_pairs': 8})

    def test_checksum_damage_is_rejected(self):
        with (self.out / 'assets/interaction/test.json').open('a') as stream:
            stream.write(' ')
        with self.assertRaisesRegex(ValueError, 'hash mismatch'):
            experience.validate(self.out)

    def test_unclosed_boundary_is_rejected(self):
        self.assert_rejects(lambda m, d: d['missing'][0]['outer'].pop(), 'not closed')

    def test_changed_footprint_area_is_rejected(self):
        self.assert_rejects(lambda m, d: d.update(observed=[rectangle(0, 0, .5, 1)]), 'polygon area')

    def test_changed_observation_year_is_rejected(self):
        self.assert_rejects(lambda m, d: d.update(years=[2020, 2022]), 'identity differs')

    def test_changed_published_mean_is_rejected(self):
        self.assert_rejects(lambda m, d: d['comparisons'][1].update(to_mean=2.1), 'mean differs')

    def test_changed_published_decrease_is_rejected(self):
        self.assert_rejects(lambda m, d: m['regions'][0]['series'][1].update(decreased_area_pct=25),
                            'decrease fraction differs')

    def test_wrong_district_identity_is_rejected(self):
        self.assert_rejects(lambda m, d: d['districts'][0].update(id='999'), 'district identities')

    def test_missing_pair_is_rejected(self):
        self.assert_rejects(lambda m, d: d['comparisons'].pop(), 'Missing or duplicate')

    def test_unpartitioned_threshold_area_is_rejected(self):
        self.assert_rejects(lambda m, d: d['comparisons'][1]['small_change_area_pct'].update({'0.5': 20}),
                            'Magnitude area fractions')

    def test_flipped_north_is_rejected(self):
        self.assert_rejects(lambda m, d: d['coordinates'].update(north='-Y'), 'coordinate contract')

    def test_asset_path_escape_is_rejected(self):
        self.manifest['regions'][0]['interaction_url'] = '../elsewhere.json'
        self.manifest['experience']['files'][0]['url'] = '../elsewhere.json'
        experience.write_json(self.out / 'data/manifest.json', self.manifest)
        with self.assertRaisesRegex(ValueError, 'unsafe interaction URL'):
            experience.validate(self.out)


@unittest.skipUnless(importlib.util.find_spec('numpy'), 'Export calculation requires the scientific environment.')
class ExperienceCalculationTests(unittest.TestCase):
    def test_weights_common_mask_zero_and_reverse_direction_are_preserved(self):
        import numpy as np
        # The invalid fourth cell is deliberately extreme. The third valid
        # cell begins at real radiance zero and must remain in the denominator.
        fields = np.array([[[2, 2, 0, 10000]], [[1, 2.25, 0, 0]]], dtype='f8')
        weights = np.array([[1, 2, 1, 1000]], dtype='f8')
        common = np.array([[True, True, True, False]])
        result = experience.pair_statistics(fields, weights, common, [2020, 2021])
        forward, reverse = result[1], result[2]
        self.assertEqual((forward['from_mean'], forward['to_mean']), (1.5, 1.375))
        self.assertEqual(forward['from_zero_area_pct'], 25)
        self.assertEqual(forward['to_zero_area_pct'], 25)
        self.assertEqual(forward['lower_area_pct'], 25)
        self.assertEqual(forward['higher_area_pct'], 50)
        self.assertEqual(forward['small_change_area_pct'], {'0.1': 25, '0.5': 75, '1': 100})
        self.assertEqual(forward['decrease_beyond_pct'], {'0.1': 25, '0.5': 25, '1': 0})
        self.assertEqual(reverse['lower_area_pct'], forward['higher_area_pct'])
        self.assertEqual(reverse['decrease_beyond_pct'], forward['increase_beyond_pct'])
        self.assertEqual(result[0]['unchanged_area_pct'], 100)

    def test_zero_baseline_has_no_invented_percentage_change(self):
        import numpy as np
        result = experience.pair_statistics(np.array([[[0]], [[1]]]), np.ones((1, 1)),
                                            np.ones((1, 1), dtype=bool), [2020, 2021])
        self.assertIsNone(result[1]['percent_change'])
        self.assertEqual(result[1]['from_zero_area_pct'], 100)


if __name__ == '__main__':
    unittest.main()
