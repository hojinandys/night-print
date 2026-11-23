"""Export original rendered art and actual annual statistics for the static viewer.

No source values are invented. WebP files are faithful format conversions of the
annual Cycles renders; the display retains the camera, light and surface design.
Hotspots locate administrative districts on the fixed reference plane, not a
measurement of the clicked raster pixel. North-up SVGs retain every polygon.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
import shutil
from xml.sax.saxutils import escape, quoteattr

import numpy as np
from PIL import Image
from pyproj import Transformer
from shapely.geometry import shape
from shapely.ops import transform

HERE = Path(__file__).resolve().parents[1]
PROJECT = Transformer.from_crs(4326, 32652, always_xy=True).transform
CAMERA = np.array([11.0, -16.0, 19.0])
ASPECT = 16 / 9
ORTHO_SCALE = 18.5
SHIFT_Y = .015


def utcnow():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def project_point(x, y, mode='change', z=0):
    """Match the fixed orthographic camera in the submitted Blender scene.

    Returned coordinates use browser image convention: origin at upper left.
    Landscape sensor fit uses the orthographic width; shift_y also scales by it.
    """
    target = np.array([0., 0., .45 if mode == 'absolute' else 0.])
    forward = target - CAMERA
    forward /= np.linalg.norm(forward)
    right = np.cross(forward, np.array([0., 0., 1.]))
    right /= np.linalg.norm(right)
    up = np.cross(right, forward)
    relative = np.array([x, y, z]) - CAMERA
    return {'x': float(.5 + np.dot(relative, right) / ORTHO_SCALE),
            'y': float(.5 - np.dot(relative, up) / (ORTHO_SCALE / ASPECT)
                       + SHIFT_Y * ASPECT)}


def annual_stats(radiance, weight, common, years):
    valid = common & (weight > 0)
    weights = weight[valid].astype('f8')
    values = radiance[:, valid].astype('f8')
    total = weights.sum()
    if total <= 0:
        return [{'year': int(year), 'mean': None, 'change': None,
                 'percent_change': None, 'decreased_area_pct': None}
                for year in years]
    means = (values * weights).sum(axis=1) / total
    return [{'year': int(year), 'mean': float(means[i]),
             'change': float(means[i] - means[0]),
             'percent_change': float((means[i] / means[0] - 1) * 100)
             if means[0] > 0 else None,
             'decreased_area_pct': float(weights[values[i] < values[0]].sum()
                                         / total * 100)}
            for i, year in enumerate(years)]


def polygons(geometry):
    return list(geometry.geoms) if hasattr(geometry, 'geoms') else [geometry]


def export_map(features, region, bounds, destination):
    """North-up administrative locator, separate from the perspective artwork."""
    west, south, east, north = bounds
    margin = 34
    width = 1000
    scale = (width - margin * 2) / (east - west)
    height = (north - south) * scale + margin * 2

    def path_data(g):
        parts = []
        for poly in polygons(g):
            for ring in [poly.exterior, *poly.interiors]:
                pts = np.asarray(ring.coords)
                xy = np.column_stack([(pts[:, 0] - west) * scale + margin,
                                      (north - pts[:, 1]) * scale + margin])
                if len(xy) >= 3:
                    parts.append('M' + ' L'.join(f'{x:.2f},{y:.2f}' for x, y in xy) + 'Z')
        return ' '.join(parts)

    chunks = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 {height:.2f}" role="img" aria-label="{escape(region)} 행정구역 위치, 북쪽이 위">',
              '<style>path{fill:#222a33;stroke:#82909b;stroke-width:1.1;vector-effect:non-scaling-stroke;cursor:pointer}path:hover,path:focus,path.active{fill:#5b6976;stroke:#eae6dc;outline:none}</style>']
    for f in features:
        p = f['properties']
        g = transform(PROJECT, shape(f['geometry'])).simplify(45, preserve_topology=True)
        code = str(p['code'])
        chunks.append(f'<path id="district-{escape(code)}" data-id={quoteattr(code)} data-district={quoteattr(code)} tabindex="0" role="button" aria-label={quoteattr(p["name"])} fill-rule="evenodd" d={quoteattr(path_data(g))}><title>{escape(p["name"])}</title></path>')
    chunks.append(f'<path style="fill:none;stroke:#c5ccd0;cursor:default" d="M970,53 L970,23 M963,33 L970,23 L977,33"/><text x="970" y="17" text-anchor="middle" fill="#c5ccd0" font-size="15" font-family="sans-serif">N</text></svg>')
    destination.write_text('\n'.join(chunks), encoding='utf-8')
    return {'width': width, 'height': round(height, 2)}


def build(project, out, *, checked_at=None, status='unknown', provider_metadata=None):
    project = Path(project).resolve()
    out = Path(out).resolve()
    (out / 'data').mkdir(parents=True, exist_ok=True)
    assets = out / 'assets'
    (assets / 'frames').mkdir(parents=True, exist_ok=True)
    (assets / 'maps').mkdir(parents=True, exist_ok=True)
    facts = json.loads((project / 'data/processed/facts.json').read_text(encoding='utf-8'))
    features = json.loads((project / 'data/processed/boundaries.geojson').read_text(encoding='utf-8'))['features']
    years = [int(y) for y in facts['years']]
    if len(years) < 2 or years != sorted(set(years)):
        raise ValueError('A comparison requires at least two unique ordered observation years.')
    # A missing year must not be disguised as an equally spaced annual step.
    if years != list(range(years[0], years[-1] + 1)):
        raise ValueError('Annual observations must be contiguous before publishing.')
    manifest = {
        'schema_version': 1,
        'title': '밤의 지문',
        'subtitle': '평균이 지운 자리',
        'edition': f'{years[0]}–{years[-1]}',
        'years': years, 'baseline_year': years[0], 'updated_utc': utcnow(),
        'units': facts['units'], 'boundary_date': facts['boundary_date'],
        'source': {'label': 'WorldPop / EOG',
                   'url': 'https://hub.worldpop.org/geodata/summary?id=62620',
                   'doi': '10.5258/SOTON/WP00772',
                   'license': 'CC BY 4.0',
                   'boundary_credit': 'SGIS 원자료(공공누리 제1유형), vuski/admdongkor 가공(CC BY 4.0)'},
        'update': {'state': status, 'latest_year': years[-1], 'last_checked': checked_at},
        'reading': {
            'height_absolute': '높이 = 연평균 복사휘도 · 같은 로그 변환',
            'height_change': f'높이 = 같은 위치의 {years[0]}년 대비 변화 · 같은 asinh 변환',
            'color': '변화 장면에서 금빛은 증가, 푸른빛은 감소',
            'contours': '선은 같은 표시 높이의 등고선이며 연도별 누적 층이 아닙니다.',
            'common_area': f'{len(years)}개 연도에 공통으로 관측 가능한 영역의 면적 가중 집계',
            'negative_area': '감소 면적은 값의 차이<0인 영역의 비율이며 통계적 유의성 검정이 아닙니다.',
            'hotspots': '표시는 행정구역 대표점의 기준면 위치입니다. 정보는 해당 구·군·시 전체의 공통 관측 영역 집계이며 클릭 지점의 픽셀값이 아닙니다.',
            'map': '북쪽이 위인 행정구역 위치도. 경계 표시는 웹 열람용으로 단순화했습니다.',
            'scale': '지역별 화면 맞춤 배율은 다르며 실제 면적 비교가 아닙니다.'},
        'regions': []}
    if provider_metadata:
        metadata = json.loads(Path(provider_metadata).read_text(encoding='utf-8'))
        row = next((r for r in metadata.get('data', []) if str(r.get('id')) == '62620'), None)
        if row:
            manifest['source']['title'] = row.get('title')
    exports = []
    for region, values in facts['regions'].items():
        series = np.load(project / f'data/processed/{region}_series.npz')
        if list(map(int, series['years'])) != years:
            raise ValueError(f'{region}: array years differ from facts.')
        fields = series['radiance']
        common = series['common']
        weight = series['weight']
        t = series['transform']
        ny, nx = common.shape
        cell = float(facts['cell_m'])
        scale = 10 / max(nx * cell, ny * cell)
        cx, cy = t[2] + nx * cell / 2, t[5] - ny * cell / 2
        annual = annual_stats(fields, weight, common, years)
        np.testing.assert_allclose([s['mean'] for s in annual], values['means'], rtol=1e-10)
        region_record = {k: values[k] for k in ['full_name', 'coverage_pct', 'means', 'percent_change', 'change', 'decreased_area_pct']}
        region_record.update({'id': region, 'label': values['name'], 'series': annual,
                              'observed_area_km2': values['observed_area_km2'],
                              'boundary_area_km2': values['boundary_area_km2'],
                              'render': {'absolute': [], 'change': []}, 'districts': []})
        for mode in ['absolute', 'change']:
            directory = assets / 'frames' / region / mode
            directory.mkdir(parents=True, exist_ok=True)
            for i, year in enumerate(years):
                src = project / f'cache/renders/{region}_{mode}_{i * 8:03}.png'
                dest = directory / f'{year}.webp'
                with Image.open(src) as im:
                    if im.size != (1920, 1080):
                        raise ValueError(f'Expected 1920×1080 original camera render: {src}')
                    im.convert('RGB').save(dest, 'WEBP', quality=88, method=6)
                url = dest.relative_to(out).as_posix()
                region_record['render'][mode].append({'year': year, 'url': url})
                exports.append({'url': url, 'bytes': dest.stat().st_size,
                                'source_render_sha256': sha(src), 'sha256': sha(dest)})
        district_features = [f for f in features if f['properties']['region'] == region and f['properties']['level'] == 'district']
        feature_by_code = {str(f['properties']['code']): f for f in district_features}
        district_weights = series['district_weights']
        if len(district_weights) != len(values['districts']):
            raise ValueError(f'{region}: district weight count mismatch.')
        for i, district in enumerate(values['districts']):
            code = str(district['code'])
            feature = feature_by_code[code]
            if district['name'] != feature['properties']['name']:
                raise ValueError(f'{region}/{code}: district identity mismatch.')
            annual = annual_stats(fields, district_weights[i], common, years)
            # Confirms the stored matrix order is exactly the documented district order.
            np.testing.assert_allclose([s['mean'] for s in annual], district['means'], rtol=1e-10)
            geometry = transform(PROJECT, shape(feature['geometry']))
            point = geometry.representative_point()
            x, y = (point.x - cx) * scale, (point.y - cy) * scale
            anchors = {mode: project_point(x, y, mode) for mode in ['absolute', 'change']}
            if not all(0 <= p[a] <= 1 for p in anchors.values() for a in ['x', 'y']):
                raise ValueError(f'{region}/{code}: camera anchor outside image.')
            d = {k: district[k] for k in ['name', 'means', 'coverage_pct', 'percent_change', 'change', 'decreased_area_pct']}
            d.update({'id': code, 'series': annual, 'anchor': anchors['change'],
                      'anchor_by_mode': anchors, 'observed_area_km2': district['observed_area_km2'],
                      'boundary_area_km2': district['boundary_area_km2'],
                      'map_anchor_utm': [point.x, point.y]})
            region_record['districts'].append(d)
        rg = transform(PROJECT, shape(next(f for f in features if f['properties']['region'] == region and f['properties']['level'] == 'region')['geometry']))
        map_path = assets / 'maps' / f'{region}.svg'
        region_record['map_viewbox'] = export_map(district_features, values['name'], rg.bounds, map_path)
        region_record['map_url'] = map_path.relative_to(out).as_posix()
        manifest['regions'].append(region_record)
    fonts_out = assets / 'fonts'
    fonts_out.mkdir(exist_ok=True)
    for name in ['NanumGothic-Regular.ttf', 'NanumGothic-Bold.ttf', 'OFL.txt']:
        src = project / 'assets/fonts' / name
        if not src.exists():
            src = HERE / 'dist/assets/fonts' / name
        dest = fonts_out / name
        if src.resolve() != dest.resolve():
            shutil.copy2(src, dest)
        if not dest.exists():
            raise FileNotFoundError(f'Missing bundled font: {dest}')
    locator = project / 'assets/location_map.png'
    if locator.exists():
        shutil.copy2(locator, assets / 'location_map.png')
        manifest['location_map_url'] = 'assets/location_map.png'
    (out / 'data/manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    export_report = {'created_utc': utcnow(), 'observed_years': years,
                     'source_facts_sha256': sha(project / 'data/processed/facts.json'),
                     'frames': exports, 'frame_count': len(exports),
                     'total_frame_bytes': sum(f['bytes'] for f in exports),
                     'regions': len(manifest['regions']),
                     'districts': sum(len(r['districts']) for r in manifest['regions']),
                     'independent_values': 'All region and district annual means verified against saved facts.',
                     'camera': {'position': CAMERA.tolist(), 'ortho_width': ORTHO_SCALE, 'aspect': ASPECT, 'shift_y': SHIFT_Y},
                     'hotspot_basis': 'Administrative representative point on fixed z=0 reference plane, not clicked pixel radiance.'}
    (out / 'data/export_provenance.json').write_text(json.dumps(export_report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k: export_report[k] for k in ['frame_count', 'total_frame_bytes', 'regions', 'districts']}, ensure_ascii=False), flush=True)
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--checked-at')
    parser.add_argument('--status', choices=['up_to_date', 'updated', 'unknown'], default='unknown')
    parser.add_argument('--provider-metadata', type=Path)
    args = parser.parse_args()
    build(args.project, args.out, checked_at=args.checked_at, status=args.status,
          provider_metadata=args.provider_metadata)
