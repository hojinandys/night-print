"""Export linked administrative geometry and observed comparison context.

The interactive map uses the same UTM-to-world transform as the existing relief.
Missing polygons mean locations excluded from the edition's common observation
mask, not dark/zero radiance. Pair statistics always use the fixed edition-wide
common mask and exact administrative intersection weights.

Build needs the existing scientific environment; validation uses only stdlib.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

THRESHOLDS = (0.1, 0.5, 1.0)


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def write_json(path, value, *, compact=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False,
                               separators=(',', ':') if compact else None,
                               indent=None if compact else 2) + '\n', encoding='utf-8')
    temp.replace(path)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def rounded(value):
    return round(float(value), 8)


def polygon_parts(geometry):
    if geometry.is_empty:
        return []
    if geometry.geom_type == 'Polygon':
        return [geometry]
    return [p for g in geometry.geoms for p in polygon_parts(g)] if hasattr(geometry, 'geoms') else []


def world_polygons(geometry, cx, cy, scale):
    def ring(coords):
        return [[rounded((x - cx) * scale), rounded((y - cy) * scale)] for x, y in coords]
    return [{'outer': ring(p.exterior.coords), 'holes': [ring(h.coords) for h in p.interiors]}
            for p in polygon_parts(geometry) if p.area > 1e-8]


def pair_statistics(radiance, weight, common, years):
    import numpy as np
    mask = common & (weight > 0)
    w = weight[mask].astype('f8')
    values = radiance[:, mask].astype('f8')
    total = float(w.sum())
    if total <= 0 or not np.isfinite(values).all() or (values < 0).any():
        raise ValueError('Comparison statistics need finite nonnegative common observations.')
    means = (values * w).sum(axis=1) / total
    def fraction(mask):
        return rounded(min(100.0, max(0.0, float(w[mask].sum() / total * 100))))
    zero = [fraction(v == 0) for v in values]
    result = []
    for a, from_year in enumerate(years):
        for b, to_year in enumerate(years):
            delta = values[b] - values[a]
            result.append({
                'from': int(from_year), 'to': int(to_year),
                'from_mean': rounded(means[a]), 'to_mean': rounded(means[b]),
                'mean_change': rounded(means[b] - means[a]),
                'percent_change': rounded((means[b] / means[a] - 1) * 100) if means[a] > 0 else None,
                'lower_area_pct': fraction(delta < 0),
                'higher_area_pct': fraction(delta > 0),
                'unchanged_area_pct': fraction(delta == 0),
                'from_zero_area_pct': zero[a], 'to_zero_area_pct': zero[b],
                'small_change_area_pct': {format(t, 'g'): fraction(np.abs(delta) <= t) for t in THRESHOLDS},
                'decrease_beyond_pct': {format(t, 'g'): fraction(delta < -t) for t in THRESHOLDS},
                'increase_beyond_pct': {format(t, 'g'): fraction(delta > t) for t in THRESHOLDS},
            })
    return result


def build(project, out):
    import numpy as np
    from affine import Affine
    from pyproj import Transformer
    from rasterio.features import shapes
    from shapely.geometry import shape
    from shapely.ops import transform, unary_union

    project, out = Path(project).resolve(), Path(out).resolve()
    manifest_path = out / 'data/manifest.json'
    manifest = read_json(manifest_path)
    facts_path = project / 'data/processed/facts.json'
    boundary_path = project / 'data/processed/boundaries.geojson'
    facts = read_json(facts_path)
    features = read_json(boundary_path)['features']
    years = list(map(int, facts['years']))
    if years != manifest['years']:
        raise ValueError('Experience export years differ from the published edition.')
    project_xy = Transformer.from_crs(4326, facts['crs'], always_xy=True).transform
    descriptors, area_checks = [], []
    for region in manifest['regions']:
        rid = region['id']
        source_path = project / f'data/processed/{rid}_series.npz'
        series = np.load(source_path)
        if list(map(int, series['years'])) != years:
            raise ValueError('Experience source years differ from the edition.')
        common = series['common'].astype(bool)
        weights = series['weight']
        fields = series['radiance']
        t = series['transform']
        ny, nx = common.shape
        cell = float(facts['cell_m'])
        scale = 10 / max(nx * cell, ny * cell)
        cx, cy = float(t[2] + nx * cell / 2), float(t[5] - ny * cell / 2)
        region_features = [f for f in features if f['properties']['region'] == rid]
        region_feature = next(f for f in region_features if f['properties']['level'] == 'region')
        full = transform(project_xy, shape(region_feature['geometry']))
        mask = common & (weights > 0)
        cells = [shape(g) for g, value in shapes(mask.astype('uint8'), mask=mask,
                                                transform=Affine(*t[:6])) if value == 1]
        observed = full.intersection(unary_union(cells))
        missing = full.difference(observed)
        expected_area = float(weights[mask].sum())
        if not math.isclose(observed.area, expected_area, rel_tol=1e-7, abs_tol=.05):
            raise ValueError(f'{rid}: common-footprint area differs from exact weighted area.')
        coverage = observed.area / full.area * 100
        if not math.isclose(coverage, float(region['coverage_pct']), abs_tol=2e-5):
            raise ValueError(f'{rid}: coverage differs from published statistics.')
        comparisons = pair_statistics(fields, weights, common, years)
        for entry in comparisons:
            if entry['from'] == years[0]:
                original = next(s for s in region['series'] if s['year'] == entry['to'])
                if not math.isclose(entry['to_mean'], original['mean'], abs_tol=1e-7):
                    raise ValueError('Region comparison means differ from the published values.')
                if not math.isclose(entry['lower_area_pct'], original['decreased_area_pct'], abs_tol=1e-7):
                    raise ValueError('Region decrease fractions differ from the published values.')
        districts = []
        source_districts = facts['regions'][rid]['districts']
        for i, district in enumerate(source_districts):
            did = str(district['code'])
            feature = next(f for f in region_features if f['properties']['level'] == 'district'
                           and str(f['properties']['code']) == did)
            geometry = transform(project_xy, shape(feature['geometry']))
            point = geometry.representative_point()
            dw = series['district_weights'][i]
            pairs = pair_statistics(fields, dw, common, years)
            d_observed = float(dw[common & (dw > 0)].sum())
            d_coverage = d_observed / geometry.area * 100
            published = next(d for d in region['districts'] if str(d['id']) == did)
            if not math.isclose(d_coverage, float(published['coverage_pct']), abs_tol=2e-5):
                raise ValueError(f'{rid}/{did}: coverage mismatch.')
            for entry in pairs:
                if entry['from'] == years[0]:
                    original = next(s for s in published['series'] if s['year'] == entry['to'])
                    if not math.isclose(entry['to_mean'], original['mean'], abs_tol=1e-7):
                        raise ValueError(f'{rid}/{did}: district matrix order or mean mismatch.')
                    if not math.isclose(entry['lower_area_pct'], original['decreased_area_pct'], abs_tol=1e-7):
                        raise ValueError(f'{rid}/{did}: district decrease mismatch.')
            districts.append({'id': did, 'name': district['name'],
                              'polygons': world_polygons(geometry, cx, cy, scale),
                              'anchor': [rounded((point.x - cx) * scale), rounded((point.y - cy) * scale)],
                              'coverage_pct': rounded(min(100, d_coverage)),
                              'observed_area_km2': rounded(d_observed / 1e6),
                              'missing_area_km2': rounded(max(0, geometry.area - d_observed) / 1e6),
                              'comparisons': pairs})
        bounds = full.bounds
        payload = {
            'schema': 1, 'region': rid, 'name': region.get('label', region.get('full_name', rid)),
            'years': years, 'units': manifest['units'],
            'bounds': [rounded((bounds[0] - cx) * scale), rounded((bounds[1] - cy) * scale),
                       rounded((bounds[2] - cx) * scale), rounded((bounds[3] - cy) * scale)],
            'polygons': world_polygons(full, cx, cy, scale),
            'observed': world_polygons(observed, cx, cy, scale),
            'missing': world_polygons(missing, cx, cy, scale),
            'districts': districts, 'comparisons': comparisons,
            'coverage_pct': rounded(min(100, coverage)),
            'observed_area_km2': rounded(observed.area / 1e6),
            'missing_area_km2': rounded(missing.area / 1e6),
            'boundary_area_km2': rounded(full.area / 1e6),
            'quality': {
                'thresholds': list(THRESHOLDS), 'units': manifest['units'],
                'mask': 'fixed_common_observation_area',
                'missing_label': '이 판의 공통 관측에서 제외된 영역',
                'missing_explanation': '자료 없음·품질 조건·공통 관측 조건으로 제외된 영역입니다. 실제 밝기 0을 뜻하지 않습니다.',
                'threshold_explanation': '선택한 크기 이하의 값 차이를 구분하는 감상 기준입니다. 측정 오차나 통계적 유의성을 판정하는 기준이 아닙니다.',
                'comparison_denominator': '선택한 구역 안에서 이 판의 모든 관측에 공통인 면적',
            },
            'coordinates': {'system': 'original_relief_world_xy', 'north': '+Y',
                            'source_crs': facts['crs'], 'utm_origin': [cx, cy],
                            'utm_to_world_scale': scale, 'rounding_decimal_places': 8,
                            'boundary_simplification_m': 0},
            'source': {'facts_sha256': sha(facts_path), 'boundaries_sha256': sha(boundary_path),
                       'series_sha256': sha(source_path)},
        }
        destination = out / 'assets/interaction' / f'{rid}.json'
        write_json(destination, payload, compact=True)
        region['interaction_url'] = destination.relative_to(out).as_posix()
        descriptors.append({'region': rid, 'url': region['interaction_url'],
                            'bytes': destination.stat().st_size, 'sha256': sha(destination)})
        area_checks.append({'region': rid, 'weighted_observed_m2': expected_area,
                            'polygon_observed_m2': observed.area,
                            'absolute_error_m2': abs(observed.area - expected_area),
                            'districts': len(districts)})
    manifest['experience'] = {
        'schema': 1, 'geometry': 'original_relief_world_xy',
        'quality_thresholds': list(THRESHOLDS),
        'all_observed_pairs': True,
        'boundary_date': manifest['boundary_date'], 'files': descriptors,
    }
    write_json(manifest_path, manifest)
    report = validate(out)
    report['area_checks'] = area_checks
    write_json(out / 'assets/interaction/validation.json', report)
    return report


def validate(out):
    """Check every published interaction artifact without scientific imports."""
    out = Path(out).resolve()
    manifest = read_json(out / 'data/manifest.json')
    experience = manifest.get('experience')
    if not isinstance(experience, dict) or experience.get('schema') != 1:
        raise ValueError('Missing interaction metadata.')
    descriptors = experience.get('files', [])
    if (len(descriptors) != len(manifest['regions'])
            or len({d.get('region') for d in descriptors}) != len(descriptors)):
        raise ValueError('Interaction region count mismatch.')
    if experience.get('quality_thresholds') != list(THRESHOLDS):
        raise ValueError('Interaction magnitude thresholds differ from the contract.')
    regions, districts, pair_count = 0, 0, 0

    def finite(value):
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)

    def check_polygons(polygons):
        if not isinstance(polygons, list):
            raise ValueError('Invalid interaction polygon collection.')
        for polygon in polygons:
            if not isinstance(polygon, dict) or set(polygon) != {'outer', 'holes'}:
                raise ValueError('Invalid interaction polygon structure.')
            for ring in [polygon['outer'], *polygon['holes']]:
                if len(ring) < 4 or ring[0] != ring[-1]:
                    raise ValueError('Interaction boundary ring is not closed.')
                if any(not isinstance(p, list) or len(p) != 2 or not all(map(finite, p)) for p in ring):
                    raise ValueError('Non-finite interaction coordinates.')

    def polygon_area(polygons):
        def ring_area(ring):
            return abs(sum(a[0] * b[1] - b[0] * a[1]
                           for a, b in zip(ring, ring[1:]))) / 2
        return sum(ring_area(p['outer']) - sum(ring_area(h) for h in p['holes'])
                   for p in polygons)

    def check_comparisons(entity, original, years):
        nonlocal pair_count
        pairs = entity['comparisons']
        if len(pairs) != len(years) ** 2 or {(p['from'], p['to']) for p in pairs} != {(a, b) for a in years for b in years}:
            raise ValueError('Missing or duplicate observed interaction comparison.')
        original_series = {int(s['year']): s for s in original['series']}
        for pair in pairs:
            for k in ('from_mean', 'to_mean', 'mean_change'):
                if not finite(pair[k]):
                    raise ValueError('Non-finite comparison statistic.')
            for side in ('from', 'to'):
                if abs(pair[side + '_mean'] - original_series[pair[side]]['mean']) > 1e-7:
                    raise ValueError('Interaction mean differs from the observation manifest.')
            if pair['from'] == years[0] and abs(pair['lower_area_pct'] - original_series[pair['to']]['decreased_area_pct']) > 1e-7:
                raise ValueError('Interaction decrease fraction differs from the observation manifest.')
            if abs(pair['mean_change'] - (pair['to_mean'] - pair['from_mean'])) > 3e-8:
                raise ValueError('Interaction pair mean difference is inconsistent.')
            pct = pair['percent_change']
            if pair['from_mean'] == 0:
                if pct is not None:
                    raise ValueError('A zero starting mean cannot define percentage change.')
            elif not finite(pct) or abs(pct - (pair['to_mean'] / pair['from_mean'] - 1) * 100) > 1e-5:
                raise ValueError('Invalid comparison percentage change.')
            for key in ('lower_area_pct', 'higher_area_pct', 'unchanged_area_pct', 'from_zero_area_pct', 'to_zero_area_pct'):
                if not finite(pair[key]) or not 0 <= pair[key] <= 100:
                    raise ValueError('Invalid comparison area percentage.')
            if abs(sum(pair[k] for k in ('lower_area_pct', 'higher_area_pct', 'unchanged_area_pct')) - 100) > 1e-6:
                raise ValueError('Signed area fractions do not partition observations.')
            for threshold in THRESHOLDS:
                key = format(threshold, 'g')
                values = [pair[name][key] for name in ('small_change_area_pct', 'decrease_beyond_pct', 'increase_beyond_pct')]
                if any(not finite(v) or not 0 <= v <= 100 for v in values) or abs(sum(values) - 100) > 1e-6:
                    raise ValueError('Magnitude area fractions do not partition observations.')
                if pair['decrease_beyond_pct'][key] > pair['lower_area_pct'] + 1e-7:
                    raise ValueError('Thresholded decrease exceeds all negative differences.')
            if pair['from'] == pair['to'] and (pair['mean_change'] != 0 or pair['lower_area_pct'] != 0):
                raise ValueError('Same-observation comparison must have zero change.')
        pair_count += len(pairs)

    for original in manifest['regions']:
        rid = original['id']
        descriptor = next((d for d in descriptors if d.get('region') == rid), None)
        if descriptor is None or descriptor.get('url') != original.get('interaction_url'):
            raise ValueError('Missing region interaction descriptor.')
        path = (out / descriptor['url']).resolve()
        if not path.is_relative_to(out / 'assets/interaction') or not path.is_file():
            raise ValueError('Missing or unsafe interaction URL.')
        if path.stat().st_size != descriptor['bytes'] or sha(path) != descriptor['sha256']:
            raise ValueError('Interaction asset hash mismatch.')
        data = read_json(path)
        if data.get('schema') != 1 or data.get('region') != rid or data.get('years') != manifest['years']:
            raise ValueError('Interaction identity differs from its observation edition.')
        coordinates = data['coordinates']
        scale = coordinates['utm_to_world_scale']
        if (coordinates.get('system') != 'original_relief_world_xy' or coordinates.get('north') != '+Y'
                or not finite(scale) or scale <= 0):
            raise ValueError('Interaction coordinates differ from the relief coordinate contract.')
        if data['units'] != manifest['units'] or data['quality']['thresholds'] != list(THRESHOLDS):
            raise ValueError('Interaction observation units or thresholds differ.')
        bounds = data['bounds']
        if len(bounds) != 4 or not all(map(finite, bounds)) or bounds[0] >= bounds[2] or bounds[1] >= bounds[3]:
            raise ValueError('Invalid interactive map bounds.')
        for field in ('polygons', 'observed', 'missing'):
            check_polygons(data[field])
        for polygons, area in (('polygons', 'boundary_area_km2'), ('observed', 'observed_area_km2'),
                               ('missing', 'missing_area_km2')):
            if not finite(data[area]) or data[area] < 0:
                raise ValueError('Invalid interaction area.')
            # World coordinates are rounded to 8 decimals. Allow up to 20 m²
            # of accumulated ring rounding; source-area equality is checked
            # more strictly during build before coordinates are rounded.
            if not math.isclose(polygon_area(data[polygons]) / scale ** 2 / 1e6,
                                data[area], rel_tol=1e-7, abs_tol=2e-5):
                raise ValueError('Interaction footprint polygon area differs from the recorded area.')
        if abs(data['coverage_pct'] - original['coverage_pct']) > 2e-5:
            raise ValueError('Interaction coverage differs from observation coverage.')
        if abs(data['observed_area_km2'] + data['missing_area_km2'] - data['boundary_area_km2']) > 3e-8:
            raise ValueError('Missing and observed footprints do not partition the boundary.')
        if (len(data['districts']) != len(original['districts'])
                or {d['id'] for d in data['districts']} != {str(d['id']) for d in original['districts']}):
            raise ValueError('Interaction district identities differ from the observation manifest.')
        check_comparisons(data, original, manifest['years'])
        for district in data['districts']:
            check_polygons(district['polygons'])
            if not math.isclose(polygon_area(district['polygons']) / scale ** 2 / 1e6,
                                district['observed_area_km2'] + district['missing_area_km2'],
                                rel_tol=1e-7, abs_tol=2e-5):
                raise ValueError('Interaction district boundary area is inconsistent.')
            published = next(d for d in original['districts'] if str(d['id']) == district['id'])
            if district['name'] != published['name'] or abs(district['coverage_pct'] - published['coverage_pct']) > 2e-5:
                raise ValueError('Interaction district identity or coverage mismatch.')
            check_comparisons(district, published, manifest['years'])
            districts += 1
        regions += 1
    return {'validated': True, 'regions': regions, 'districts': districts, 'observed_pairs': pair_count}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--validate', action='store_true')
    args = parser.parse_args()
    if not args.validate and args.project is None:
        parser.error('--project is required when exporting.')
    print(json.dumps(validate(args.out) if args.validate else build(args.project, args.out), ensure_ascii=False, indent=2))
