"""Independent arithmetic checks for fixed-window neighborhood observations."""
import importlib.util
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pipeline'))
from export_place_stories import neighborhood


@unittest.skipUnless(importlib.util.find_spec('numpy'), 'scientific dependency needed')
class NeighborhoodTests(unittest.TestCase):
    def fixture(self):
        import numpy as np
        # 3 x 3 grid, one missing cell, one half-border cell.
        values = np.arange(1, 10, dtype=float).reshape(3, 3)
        common = np.ones((3, 3), dtype=bool)
        common[0, 0] = False
        weight = np.full((3, 3), 250000.)
        weight[2, 2] = 125000.
        return {'transform': np.array([500,0,0,0,-500,1500]),
                'common': common, 'weight': weight,
                'radiance': np.stack([values, values*2]), 'years': [2015,2016]}

    def test_fixed_window_weights_and_missing_cells_are_distinct(self):
        result = neighborhood(self.fixture(), (750,750))
        self.assertEqual(result['boundsUtm'], [0,0,1500,1500])
        o = result['observation']
        # Cells2..8 weight1; cell9 weight0.5; cell1 excluded both years.
        expected = (sum(range(2,9)) + 9*.5) / 7.5
        self.assertAlmostEqual(o['series'][0]['mean'], expected, places=7)
        self.assertAlmostEqual(o['series'][1]['mean'], expected*2, places=7)
        self.assertEqual(o['cellCount'], 8)
        self.assertAlmostEqual(o['coveragePct'], 7.5/9*100, places=5)
        self.assertAlmostEqual(o['commonCoveragePct'], 7.5/8.5*100, places=5)

    def test_nodata_never_silently_becomes_zero(self):
        a = self.fixture()
        a['common'][:] = False
        with self.assertRaises(ValueError): neighborhood(a, (750,750))
        a = self.fixture()
        a['radiance'][1,1,1] = float('nan')
        with self.assertRaises(ValueError): neighborhood(a, (750,750))

    def test_rotated_or_unaligned_grids_rejected(self):
        a = self.fixture()
        a['transform'][1] = 3
        with self.assertRaises(ValueError): neighborhood(a, (750,750))
        with self.assertRaises(ValueError): neighborhood(self.fixture(), (750,750), 1234)


if __name__ == '__main__': unittest.main()
