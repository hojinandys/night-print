import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pipeline'))
import edition_history as history


def fixture(root, years=(2015, 2023), value=2, kind='annual'):
    root.mkdir(parents=True, exist_ok=True)
    (root / 'assets').mkdir(exist_ok=True)
    (root / 'assets/frame.webp').write_bytes(b'actual rendered observation ' + str(value).encode())
    manifest = {'years': list(years), 'baseline_year': years[0], 'units': 'nW/cm²/sr',
                'source': {'doi': 'verified-source'}, 'source_files': [{'year': years[-1], 'sha256': str(value)}],
                'updated_utc': 'first', 'update': {'last_checked': 'first'},
                'regions': [{'id': 'seoul', 'label': '서울', 'coverage_pct': 95, 'means': [1, value],
                             'series': [{'year': years[0], 'mean': 1}, {'year': years[-1], 'mean': value}],
                             'districts': [], 'render': {'absolute': [{'url': 'assets/frame.webp'}]}}]}
    if kind != 'annual':
        manifest['period'] = {'kind': kind, 'labels': {str(y): f'{y}.10' for y in years}}
    history.write(root / 'data/manifest.json', manifest)
    return manifest


class HistoryTests(unittest.TestCase):
    def test_initial_record_is_one_honest_snapshot_with_frozen_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture(root)
            result = history.prepare(root, recorded_at='2026-11-23T00:00:00Z')
            self.assertEqual(result['edition_count'], 1)
            index = history.read(root / 'data/history.json')
            self.assertIn('소급해 만들지', index['editions'][0]['summary'])
            snapshot = history.read(root / index['editions'][0]['manifest_url'])
            url = snapshot['regions'][0]['render']['absolute'][0]['url']
            self.assertTrue(url.startswith('history/assets/'))
            (root / 'assets/frame.webp').write_bytes(b'redrawn UI')
            self.assertEqual((root / url).read_bytes(), b'actual rendered observation 2')
            self.assertEqual(history.validate(root)['verified_assets'], 1)

    def test_checks_ui_and_interaction_metadata_do_not_invent_observations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = fixture(root)
            first = history.prepare(root)
            manifest['updated_utc'] = 'later'
            manifest['update']['last_checked'] = 'later'
            manifest['experience'] = {'schema': 2}
            manifest['subtitle'] = 'Revised exhibition text'
            history.write(root / 'data/manifest.json', manifest)
            second = history.prepare(root)
            self.assertEqual(first['current_id'], second['current_id'])
            self.assertFalse(second['added'])
            self.assertEqual(second['edition_count'], 1)

    def test_new_staged_data_keeps_previous_measurements_and_deduplicates_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            old, staged = Path(directory) / 'old', Path(directory) / 'stage'
            fixture(old)
            history.prepare(old)
            fixture(staged, (2015, 2024), value=2)
            result = history.prepare(staged, old)
            self.assertEqual(result['edition_count'], 2)
            self.assertEqual(history.validate(staged)['verified_assets'], 1)
            self.assertEqual(history.validate(old)['edition_count'], 1)
            entries = history.read(staged / 'data/history.json')['editions']
            self.assertIn('2015 ↔ 2023 → 2015 ↔ 2024', entries[0]['summary'])
            self.assertEqual(history.read(staged / entries[1]['manifest_url'])['years'], [2015, 2023])

    def test_source_reprocessing_gets_a_distinct_edition(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = fixture(root)
            history.prepare(root)
            manifest['source_files'][0]['sha256'] = 'reprocessed-source'
            history.write(root / 'data/manifest.json', manifest)
            self.assertEqual(history.prepare(root)['edition_count'], 2)

    def test_monthly_explanation_edit_is_not_a_new_observation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = fixture(root, (2025, 2026), kind='monthly_same_month')
            history.prepare(root)
            manifest['period']['comparison_note'] = 'Clearer explanation of the same observations'
            history.write(root / 'data/manifest.json', manifest)
            self.assertFalse(history.prepare(root)['added'])

    def test_monthly_reprocessing_does_not_claim_a_new_baseline_month(self):
        old = {'years': [2025, 2026], 'period': {'kind': 'monthly_same_month', 'labels': {'2025': '2025.10', '2026': '2026.10'}}, 'regions': []}
        changed = copy.deepcopy(old)
        reason, notes = history.change_notes(changed, old)
        self.assertEqual(reason, '관측 자료 개정')
        self.assertNotIn('이동', ' '.join(notes))

    def test_corrupt_snapshot_asset_prevents_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture(root)
            history.prepare(root)
            next((root / 'history/assets').iterdir()).write_bytes(b'corrupt')
            with self.assertRaisesRegex(ValueError, 'checksum'):
                history.validate(root)

    def test_lost_history_index_cannot_silently_restart_the_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            old, staged = Path(directory) / 'old', Path(directory) / 'stage'
            fixture(old)
            history.prepare(old)
            (old / 'data/history.json').unlink()
            fixture(staged, (2015, 2024))
            with self.assertRaisesRegex(ValueError, 'index is missing'):
                history.prepare(staged, old)

    def test_unarchived_measurement_change_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = fixture(root)
            history.prepare(root)
            manifest['regions'][0]['means'][1] = 99
            history.write(root / 'data/manifest.json', manifest)
            with self.assertRaisesRegex(ValueError, 'not registered'):
                history.validate(root)

    def test_unsafe_asset_and_mixed_sources_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = fixture(root)
            manifest['regions'][0]['render']['absolute'][0]['url'] = 'assets/../../../private'
            history.write(root / 'data/manifest.json', manifest)
            with self.assertRaisesRegex(ValueError, 'unsafe'):
                history.prepare(root)
            fixture(root)
            history.prepare(root)
            fixture(root, (2025, 2026), kind='monthly_same_month')
            with self.assertRaisesRegex(ValueError, 'cannot mix'):
                history.prepare(root)


if __name__ == '__main__':
    unittest.main()
