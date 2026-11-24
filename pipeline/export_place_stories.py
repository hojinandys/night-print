"""Reproduce editorial neighborhood observations from the published annual grid.

These are analyst-defined, fixed 1.5 km squares, not facility boundaries.
No causal estimate, future extrapolation, or business-activity proxy is computed.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def neighborhood(series, xy, side=1500):
    import numpy as np
    t = series['transform']
    if not np.allclose(t[:6][[0, 1, 3, 4]], [500, 0, 0, -500]):
        raise ValueError('Expected north-up 500 m annual grid')
    if side <= 0 or side % 500 or not all(math.isfinite(v) for v in xy):
        raise ValueError('Invalid aligned neighborhood')
    x0, y0 = [math.floor((v - side / 2) / 500 + .5) * 500 for v in xy]
    ny, nx = series['common'].shape
    xx = t[2] + np.arange(nx) * 500 + 250
    yy = t[5] - np.arange(ny) * 500 - 250
    inside = ((xx[None, :] > x0) & (xx[None, :] < x0 + side)
              & (yy[:, None] > y0) & (yy[:, None] < y0 + side))
    mask = inside & series['common'].astype(bool) & (series['weight'] > 0)
    w = series['weight'][mask].astype('f8')
    values = series['radiance'][:, mask].astype('f8')
    if not w.size or not np.isfinite(values).all() or (values < 0).any():
        raise ValueError('Neighborhood needs finite nonnegative common observations')
    observed = float(w.sum())
    within_region = float(series['weight'][inside].sum())
    means = (values * w).sum(axis=1) / observed
    return {
        'boundsUtm': [x0, y0, x0 + side, y0 + side],
        'observation': {
            'scopeLabel': '고정 관측 범위',
            'series': [{'year': int(y), 'mean': round(float(v), 8)}
                       for y, v in zip(series['years'], means)],
            'coveragePct': round(observed / side**2 * 100, 6),
            'commonCoveragePct': round(observed / within_region * 100, 6),
            'areaKm2': round(observed / 1e6, 8),
            'squareAreaKm2': side**2 / 1e6,
            'boundaryAreaKm2': round(within_region / 1e6, 8),
            'cellCount': int(mask.sum()),
            'units': 'nW/cm²/sr',
            'mask': 'same edition-wide common mask and region-intersection weights',
        },
    }


def build(project, dist, definitions=ROOT / 'pipeline/place_story_definitions.json'):
    import numpy as np
    from pyproj import Transformer
    project, dist = Path(project), Path(dist)
    config = json.loads(Path(definitions).read_text())
    manifest = json.loads((dist / 'data/manifest.json').read_text())
    if manifest.get('source', {}).get('doi') != '10.5258/SOTON/WP00772' or manifest.get('period'):
        raise ValueError('Context observations require the reviewed WorldPop annual product')
    years = list(range(2015, 2024))
    if manifest['years'] != years:
        raise ValueError('Review narrative and common footprint before changing the nine-year edition')
    tr = Transformer.from_crs(4326, 32652, always_xy=True)
    cases = []
    for definition in config['cases']:
        case = json.loads(json.dumps(definition))
        rid = case['region']
        source = project / f'data/processed/{rid}_series.npz'
        descriptor = next(f for f in manifest['experience']['files'] if f['region'] == rid)
        interaction_path = dist / descriptor['url']
        interaction = json.loads(interaction_path.read_text())
        if sha(interaction_path) != descriptor['sha256'] or sha(source) != interaction['source']['series_sha256']:
            raise ValueError('Local grid and published interaction provenance differ')
        with np.load(source) as series:
            if series['years'].tolist() != years:
                raise ValueError('Source years differ')
            xy = tr.transform(*case['location']['lonLat'])
            result = neighborhood(series, xy, config['sideMeters'])
            sensitivity = []
            for size in (1000, 1500, 2000):
                check = neighborhood(series, xy, size)['observation']
                lookup = {r['year']: r['mean'] for r in check['series']}
                sensitivity.append({'sideMeters': size,
                                    'change': round(lookup[case['toYear']] - lookup[case['fromYear']], 8),
                                    'coveragePct': check['coveragePct']})
        case['location'].update(utm=list(xy), boundsUtm=result['boundsUtm'])
        case['observation'] = result['observation']
        case['observation'].update(scopeLabel=f"{case['location']['label']} · 고정 1.5 × 1.5 km 범위",
                                   sourceHash=sha(source))
        case['basis'] = {'years': years, 'doi': manifest['source']['doi'],
                         'interactionHash': descriptor['sha256'],
                         'reviewedOn': config['reviewedOn']}
        case['sensitivity'] = sensitivity
        cases.append(case)
    payload = {'schema': 1, 'cases': cases,
               'method': '공식 위치 확인점에서 각 축 750 m를 뺀 뒤 가장 가까운 500 m 격자선에 맞춘 고정 정사각형. 같은 사각형과 9년 공통 마스크에 지역 경계 교차면적을 가중해 연평균 복사휘도를 계산. 범위는 값의 크기로 최적화하지 않았다. 사각형은 시설의 공식 경계가 아니며 500 m 칸도 독립적인 원관측을 뜻하지 않는다.'}
    text = json.dumps(payload, ensure_ascii=False, allow_nan=False, indent=2)
    (dist / 'place-story-data.mjs').write_text('// Generated by pipeline/export_place_stories.py.\nexport default ' + text + ';\n')
    evidence = ROOT / 'evidence'
    evidence.mkdir(exist_ok=True)
    (evidence / 'place-stories.json').write_text(text + '\n')
    with (evidence / 'place-observations.csv').open('w', newline='') as stream:
        writer = csv.writer(stream, lineterminator='\n')
        writer.writerow(['case_id', 'region', 'year', 'mean_nW_cm2_sr', 'observed_area_km2', 'square_coverage_pct'])
        for case in cases:
            o = case['observation']
            for row in o['series']:
                writer.writerow([case['id'], case['region'], row['year'], row['mean'], o['areaKm2'], o['coveragePct']])
    return cases


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, required=True)
    parser.add_argument('--dist', type=Path, default=ROOT / 'dist')
    args = parser.parse_args()
    cases = build(args.project, args.dist)
    print(json.dumps([{'id': c['id'], 'series': c['observation']['series'], 'coverage': c['observation']['coveragePct']} for c in cases], ensure_ascii=False))
