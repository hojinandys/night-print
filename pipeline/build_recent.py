"""Build a separate NASA monthly comparison without altering the annual edition.

The latest completed month is compared with the same month one year earlier.
Input files must first pass nasa_observations.py. No annual/monthly splice, source
substitution, interpolation of missing months, or unauthenticated download occurs.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import uuid

from nasa_observations import checked_pair, LAYER, NODATA
from update import ReviewNeeded, update_lock, copy_interactive_viewer, validate_interactive_art

ROOT = Path(__file__).resolve().parents[1]
PRODUCT_URL = 'https://ladsweb.modaps.eosdis.nasa.gov/missions-and-measurements/products/VJ146A3/'
DOI = '10.5067/VIIRS/VJ146A3.002'


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def read_json(path, default=None):
    path = Path(path)
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else default


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    temporary.replace(path)


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def period_metadata(pair):
    starts = [dt.date.fromisoformat(record['period_start']) for record in pair]
    return {'kind': 'monthly_same_month', 'month': starts[1].month,
            'labels': {str(d.year): f'{d.year}.{d.month:02}' for d in starts},
            'start_dates': [record['period_start'] for record in pair],
            'end_dates': [record['period_end'] for record in pair],
            'baseline_moves': True,
            'comparison_note': '새 월이 발행되면 비교 기준도 전년 같은 달로 함께 이동합니다. 서로 다른 월간 판의 증감률은 같은 기준의 연속 추세가 아닙니다.'}


def make_plan(check, published=None):
    pair = checked_pair(check)
    published = published or {}
    previous_names = [f.get('name') for f in published.get('source_files', [])]
    names = [record['name'] for record in pair]
    if published and (published.get('source', {}).get('doi') != DOI or
                      published.get('period', {}).get('kind') != 'monthly_same_month'):
        raise ReviewNeeded('The recent destination contains another source; manual review is required.')
    return {'checked_at': check.get('checked_utc', now()), 'monthly_pair': pair,
            'period': period_metadata(pair), 'years': [int(r['period'][:4]) for r in pair],
            'needs_build': names != previous_names, 'previous_names': previous_names,
            'new_observation': bool(previous_names) and pair[-1]['period'] != published.get('latest_period'),
            'latest_period': pair[-1]['period'], 'source_doi': DOI}


def inspect_inputs(plan, nasa_root):
    """Validate scientific receipts, hashes, and georeferencing before any crop."""
    import numpy as np
    import rasterio
    nasa_root = Path(nasa_root).resolve()
    result = []
    for record in checked_pair(plan):
        receipt = read_json(nasa_root / 'receipts' / (record['name'] + '.json'))
        if not receipt or receipt.get('scientific_validation_completed') is not True:
            raise ReviewNeeded('Both monthly source files must pass scientific import validation first.')
        source = receipt.get('source', {})
        if any(source.get(k) != record[k] for k in ['name', 'url', 'period', 'product', 'collection', 'tile']):
            raise ReviewNeeded('The scientific receipt differs from the checked official monthly record.')
        raw = nasa_root / 'raw' / record['name']
        raster = nasa_root / 'rasters' / f"VJ146A3_{record['period']}_h30v05_snowfree_q0.tif"
        if not raw.is_file() or raw.stat().st_size != record['size'] or sha(raw) != receipt.get('sha256'):
            raise ReviewNeeded('The verified monthly HDF5 source changed or is missing.')
        if not raster.is_file() or sha(raster) != receipt.get('raster_sha256'):
            raise ReviewNeeded('The quality-filtered raster changed or is missing.')
        with rasterio.open(raster) as ds:
            if (ds.crs.to_epsg() != 4326 or ds.width != 2400 or ds.height != 2400 or ds.count != 1
                    or ds.dtypes != ('float32',) or ds.nodata != NODATA
                    or not np.allclose(ds.bounds, [120, 30, 130, 40], rtol=0, atol=1e-9)):
                raise ReviewNeeded('NASA raster grid or units require review.')
            tags = ds.tags()
            expected_tags = {'source': record['url'], 'source_sha256': receipt['sha256'],
                             'product': 'VJ146A3', 'collection': '002', 'tile': 'h30v05',
                             'layer': LAYER, 'period_start': record['period_start'],
                             'period_end': record['period_end'], 'units': 'nW cm-2 sr-1'}
            if any(tags.get(key) != value for key, value in expected_tags.items()):
                raise ReviewNeeded('NASA raster provenance tags differ from the scientific receipt.')
        result.append({'record': record, 'receipt': receipt, 'raster': str(raster)})
    return result


def prepare_sources(plan, nasa_root, source_project=None):
    """Runs inside a staged copy; scientific modules resolve ROOT to that stage."""
    from collect_data import crop_original, ensure_boundaries
    verified = inspect_inputs(plan, nasa_root)
    source = ROOT / 'data/source'
    source.mkdir(parents=True, exist_ok=True)
    (ROOT / 'data/processed').mkdir(parents=True, exist_ok=True)
    (ROOT / 'data/metadata').mkdir(parents=True, exist_ok=True)
    if source_project:
        boundary = Path(source_project).resolve() / 'data/source/korea_dongs_20231231.geojson'
        shutil.copy2(boundary, source / boundary.name)
    ensure_boundaries(offline=bool(source_project))
    write_json(ROOT / 'data/metadata/edition.json',
               {'years': plan['years'], 'baseline_year': plan['years'][0], 'period': plan['period']})
    receipts = []
    for item in verified:
        record, receipt = item['record'], item['receipt']
        year = int(record['period'][:4])
        crops = [crop_original(Path(item['raster']), source / f'{region}_{year}_source.tif', region)
                 for region in ['seoul', 'busan', 'jeju']]
        receipts.append({'name': record['name'], 'period': record['period'], 'url': record['url'],
                         'year': year, 'sha256': receipt['sha256'], 'raster_sha256': receipt['raster_sha256'],
                         'product': 'VJ146A3', 'collection': '002', 'tile': 'h30v05', 'layer': LAYER,
                         'quality_rule': receipt['quality_rule'], 'crops': crops})
    write_json(ROOT / 'data/metadata/source_receipts.json', receipts)
    import analyze
    facts = analyze.build()
    facts['period'] = plan['period']
    facts['source'] = {'product': 'VJ146A3', 'collection': '002', 'doi': DOI, 'layer': LAYER}
    facts['method'] = ('NASA NOAA-20 VIIRS Black Marble monthly, same calendar month in consecutive years. '
                       'All-angle snow-free composite; quality=0 and observation count>3. Fixed 500 m UTM grid, '
                       '>=90% quality-valid source area in BOTH observations, intersection mask, '
                       'administrative intersection-area weighted statistics. NoData is not zero. '
                       'Cells crossing an administrative edge may include observations just outside it. '
                       'No connection or absolute comparison with the separate EOG annual edition.')
    for region in facts['regions'].values():
        # A two-year rolling average is meaningless for a two-month comparison.
        for record in [region, *region['districts']]:
            record.pop('first2_last2_pct', None)
    write_json(ROOT / 'data/processed/facts.json', facts)


def validate_recent(dist, expected_pair=None):
    """Reject incomplete images, nonfinite values, source mixing, or stale labels."""
    from PIL import Image
    dist = Path(dist).resolve()
    m = read_json(dist / 'data/manifest.json')
    if not m or any(not (dist / name).is_file() for name in ['index.html', 'app.js', 'style.css']):
        raise ValueError('A complete monthly viewer is required before publication.')
    period = m.get('period', {})
    years = m.get('years', [])
    if period.get('kind') != 'monthly_same_month' or len(years) != 2 or years[0] + 1 != years[1]:
        raise ValueError('A monthly edition requires two consecutive years of the same month.')
    month = period.get('month')
    if type(month) is not int or not 1 <= month <= 12:
        raise ValueError('Invalid observed month.')
    if period.get('labels') != {str(y): f'{y}.{month:02}' for y in years}:
        raise ValueError('The monthly labels do not match the observed periods.')
    if m.get('baseline_year') != years[0] or m.get('source', {}).get('doi') != DOI:
        raise ValueError('The monthly source or baseline is incorrect.')
    if expected_pair and [f.get('name') for f in m.get('source_files', [])] != [r['name'] for r in expected_pair]:
        raise ValueError('Published monthly files differ from the checked pair.')
    if any(word in json.dumps(m.get('reading', {}), ensure_ascii=False) for word in ['2015', '연평균', 'WorldPop', 'EOG']):
        raise ValueError('Annual reading labels survived in the monthly edition.')
    regions = m.get('regions', [])
    if {r['id'] for r in regions} != {'seoul', 'busan', 'jeju'} or sum(len(r['districts']) for r in regions) != 43:
        raise ValueError('The complete three regions and 43 districts are required.')
    for region in regions:
        for record in [region, *region['districts']]:
            if (len(record['means']) != 2 or not all(isinstance(v, (int, float)) and math.isfinite(v) and v >= 0 for v in record['means'])
                    or not math.isfinite(record['coverage_pct']) or not 0 < record['coverage_pct'] <= 100 + 1e-7):
                raise ValueError('Every region needs finite observations and nonzero common coverage.')
            if [s['year'] for s in record['series']] != years:
                raise ValueError('The monthly data series is incomplete.')
            for s in record['series']:
                if any(s[k] is None or not math.isfinite(s[k]) for k in ['mean', 'change', 'percent_change', 'decreased_area_pct']):
                    raise ValueError('A monthly series contains a nonfinite statistic.')
        for mode in ['absolute', 'change']:
            frames = region['render'][mode]
            if [f['year'] for f in frames] != years:
                raise ValueError('Both observed monthly artwork frames are required.')
            for frame in frames:
                path = (dist / frame['url']).resolve()
                if not path.is_relative_to(dist) or not path.is_file():
                    raise ValueError('A monthly frame is missing or has an unsafe path.')
                with Image.open(path) as image:
                    if image.size != (1920, 1080):
                        raise ValueError('Monthly artwork must preserve the 1920 x 1080 camera.')
                    image.verify()
    validate_interactive_art(dist,m)
    if m.get('experience'):
        from export_experience import validate as validate_experience
        validate_experience(dist)
    from edition_history import validate as validate_history
    validate_history(dist)
    return m


def promote_recent(staged, destination, archive_root, pair=None):
    staged, destination, archive_root = map(Path, [staged, destination, archive_root])
    validate_recent(staged, pair)
    destination.parent.mkdir(parents=True, exist_ok=True)
    archive_root.mkdir(parents=True, exist_ok=True)
    previous = None
    if destination.exists():
        previous = archive_root / ('recent-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S') + '-' + uuid.uuid4().hex[:8])
        destination.rename(previous)
    try:
        staged.rename(destination)
    except BaseException:
        if previous is not None and previous.exists() and not destination.exists():
            previous.rename(destination)
        raise
    return {'destination': str(destination), 'previous_edition': str(previous) if previous else None}


def run(command, stage):
    subprocess.run([str(value) for value in command], cwd=stage, check=True)


def build(plan, nasa_root, blender, source_project=None, cpu=False, samples=24, destination=None, force=False):
    if not plan['needs_build'] and not force:
        return {'status': 'up_to_date', 'heavy_build_performed': False}
    inspect_inputs(plan, nasa_root)
    stage = ROOT / '.runtime/staging' / ('recent-' + plan['latest_period'] + '-' + uuid.uuid4().hex[:8])
    stage.mkdir(parents=True)
    shutil.copytree(ROOT / 'pipeline', stage / 'pipeline', ignore=shutil.ignore_patterns('__pycache__'))
    dist = stage / 'dist'
    dist.mkdir()
    copy_interactive_viewer(ROOT / 'dist',dist)
    (stage / 'assets').mkdir()
    shutil.copytree(ROOT / 'dist/assets/fonts', stage / 'assets/fonts')
    if (ROOT / 'dist/assets/location_map.png').exists():
        shutil.copy2(ROOT / 'dist/assets/location_map.png', stage / 'assets/location_map.png')
    (stage / 'artwork').mkdir()
    plan_path = stage / 'plan.json'
    write_json(plan_path, plan)
    command = [sys.executable, stage / 'pipeline/build_recent.py', 'prepare', '--plan', plan_path, '--nasa-root', Path(nasa_root).resolve()]
    if source_project:
        command += ['--source-project', Path(source_project).resolve()]
    run(command, stage)
    run([sys.executable, stage / 'pipeline/build_geometry.py', '--annual-only'], stage)
    import numpy as np
    for mode in ['absolute', 'change']:
        for path in (stage / 'cache/geometry').glob(f'*_{mode}_*.npz'):
            with np.load(path) as geometry:
                heights = geometry['z']
                low, high = (-1.1, 4.8) if mode == 'absolute' else (-2.6, 3.3)
                if not len(heights) or not np.isfinite(heights).all() or heights.min() <= low or heights.max() >= high:
                    raise ReviewNeeded('A monthly observation exceeds the fixed sculpture range or has no surface; inspect before publishing.')
    command = [blender, '-b', '--python', stage / 'pipeline/render_scene.py', '--', '--indices', '0', '8', '--size', '1920', '--samples', str(samples), '--save']
    if cpu:
        command.append('--cpu')
    run(command, stage)
    run([sys.executable, stage / 'pipeline/export_web.py', '--project', stage, '--out', dist, '--checked-at', plan['checked_at'], '--status', 'updated'], stage)
    m = read_json(dist / 'data/manifest.json')
    previous = read_json(ROOT / 'dist/recent/data/manifest.json', {})
    annual = read_json(ROOT / 'dist/data/manifest.json', {})
    repository_url = previous.get('repository_url') or annual.get('repository_url')
    if repository_url:
        m['repository_url'] = repository_url
    m.update({'subtitle': '같은 계절, 다른 밤', 'edition': ' ↔ '.join(plan['period']['labels'].values()),
              'period': plan['period'], 'latest_period': plan['latest_period'],
              'edition_links': [{'label': '장기 변화', 'url': '../', 'active': False},
                                {'label': '최근 관측', 'url': './', 'active': True}],
              'source': {'label': 'NASA Black Marble · NOAA-20 VIIRS', 'url': PRODUCT_URL, 'doi': DOI,
                         'product': 'VJ146A3', 'collection': '002', 'layer': LAYER,
                         'processing_note': '눈이 없는 날의 전 각도 월간 합성값에서 품질 0·관측수 4회 이상만 사용합니다. 두 시점 모두 유효 면적 90% 이상인 500m 격자의 공통 영역을 행정구역 면적으로 가중 집계합니다.',
                         'documentation_url': PRODUCT_URL,
                         'license': 'NASA Earth science open data; source attribution retained',
                         'boundary_credit': 'SGIS 원자료(공공누리 제1유형), vuski/admdongkor 가공(CC BY 4.0)'},
              'source_files': read_json(stage / 'data/metadata/source_receipts.json')})
    first = plan['period']['labels'][str(plan['years'][0])]
    m['reading'].update({'height_absolute': '높이 = 눈이 없는 날의 월간 복사휘도 합성값 · 같은 로그 변환',
                         'height_change': f'높이 = 같은 위치의 {first} 대비 변화 · 같은 asinh 변환',
                         'common_area': '품질 0·유효 관측 4회 이상인 원본을 사용하고, 두 시점 모두 유효 면적 90% 이상인 500m 격자의 공통 영역만 면적 가중 집계',
                         'quality': 'AllAngle_Composite_Snow_Free, quality=0, Num>3. 관측 제외 영역을 0으로 채우지 않습니다.',
                         'period': plan['period']['comparison_note']})
    m['update'] = {'state': 'updated', 'latest_year': plan['years'][-1], 'latest_period': plan['latest_period'],
                   'last_checked': plan['checked_at'], 'new_observation': plan['new_observation'],
                   'schedule_description': '매주 화요일 12:37 한국시간에 공식 목록을 확인하고, 새로 완료된 월과 전년 같은 달의 자료가 있을 때 검증 후 갱신합니다.',
                   'explanation': '검증된 NASA 월간 합성자료의 전년 동월 비교입니다. 실시간 관측이나 연평균 자료가 아닙니다.',
                   'common_mask_policy': '두 달에 공통인 관측 영역을 판마다 다시 계산합니다. 다음 달에는 기준 달과 관측 영역이 함께 바뀔 수 있습니다.'}
    write_json(dist / 'data/manifest.json', m)
    provenance = read_json(dist / 'data/export_provenance.json')
    provenance.update({'period': plan['period'], 'source_doi': DOI,
                       'independent_values': 'All region and district monthly means verified against saved facts.'})
    write_json(dist / 'data/export_provenance.json', provenance)
    run([sys.executable,stage/'pipeline/export_web3d.py','--project',stage,'--out',dist,'--blender',blender],stage)
    from export_experience import build as build_experience
    build_experience(stage,dist)
    validate_interactive_art(dist,read_json(dist/'data/manifest.json'),required=True)
    target = Path(destination).resolve() if destination else ROOT / 'dist/recent'
    from edition_history import prepare as prepare_history
    prepare_history(dist,target)
    result = promote_recent(dist, target, ROOT / '.runtime/releases', plan['monthly_pair'])
    return {'status': 'updated', 'heavy_build_performed': True, 'stage': str(stage), 'latest_period': plan['latest_period'], **result}


def append_audit(event):
    path = ROOT / '.runtime/recent-updates.json'
    records = read_json(path, [])
    records.append({'at': now(), **event})
    write_json(path, records)


def record_status(plan, state, dist=None):
    """Advance checking metadata while preserving the artwork/data edition."""
    dist = Path(dist) if dist else ROOT / 'dist/recent'
    path = dist / 'data/manifest.json'
    if not path.exists():
        return {'status': state, 'heavy_build_performed': False, 'existing_edition_retained': True,
                'metadata_updated': False, 'reason': 'No monthly edition exists yet.'}
    if state == 'up_to_date' and plan['needs_build']:
        raise ValueError('A pending observation cannot be marked up to date.')
    m = validate_recent(dist)
    m.setdefault('update', {}).update({
        'state': state, 'last_checked': plan['checked_at'],
        'latest_available_period': plan['latest_period'], 'new_observation': False,
        'new_observation_available': bool(plan['needs_build']),
        'explanation': ('공식 목록에 새 월간 자료가 있지만 자동 다운로드 인증이 필요해 기존 작품 판을 유지합니다.'
                        if state == 'needs_credentials' else '공식 목록을 확인했습니다. 현재 공개된 같은 달의 자료가 작품에 반영되어 있습니다.')})
    write_json(path, m)
    return {'status': state, 'heavy_build_performed': False, 'existing_edition_retained': True,
            'metadata_updated': True, 'last_checked': plan['checked_at']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    c = sub.add_parser('plan')
    c.add_argument('--input', type=Path, default=ROOT / '.runtime/nasa/check.json')
    c.add_argument('--output', type=Path, default=ROOT / '.runtime/recent-plan.json')
    c.add_argument('--github-output', type=Path)
    b = sub.add_parser('build')
    b.add_argument('--plan', type=Path, default=ROOT / '.runtime/recent-plan.json')
    b.add_argument('--nasa-root', type=Path, default=ROOT / '.runtime/nasa')
    b.add_argument('--source-project', type=Path)
    b.add_argument('--blender', default=shutil.which('blender') or '/Applications/Blender.app/Contents/MacOS/Blender')
    b.add_argument('--cpu', action='store_true')
    b.add_argument('--samples', type=int, default=24)
    b.add_argument('--destination', type=Path)
    b.add_argument('--force', action='store_true')
    p = sub.add_parser('prepare')
    p.add_argument('--plan', type=Path, required=True)
    p.add_argument('--nasa-root', type=Path, required=True)
    p.add_argument('--source-project', type=Path)
    v = sub.add_parser('validate')
    v.add_argument('--dist', type=Path, default=ROOT / 'dist/recent')
    s = sub.add_parser('record-status')
    s.add_argument('--state', choices=['needs_credentials', 'up_to_date'], required=True)
    s.add_argument('--plan', type=Path, default=ROOT / '.runtime/recent-plan.json')
    args = parser.parse_args()
    try:
        if args.command == 'prepare':
            prepare_sources(read_json(args.plan), args.nasa_root, args.source_project)
            return
        if args.command == 'plan':
            plan = make_plan(read_json(args.input), read_json(ROOT / 'dist/recent/data/manifest.json', {}))
            write_json(args.output, plan)
            credentials = bool(os.environ.get('EARTHDATA_TOKEN', '').strip())
            if args.github_output:
                with args.github_output.open('a', encoding='utf-8') as stream:
                    stream.write(f"needs_build={str(plan['needs_build']).lower()}\ncredentials_available={str(credentials).lower()}\n")
            result = {'status': 'new_observation' if plan['needs_build'] else 'up_to_date', 'latest_period': plan['latest_period'],
                      'needs_build': plan['needs_build'], 'credentials_available': credentials, 'metadata_only': True}
        elif args.command == 'validate':
            m = validate_recent(args.dist)
            result = {'status': 'valid', 'period': m['period']}
        elif args.command == 'record-status':
            with update_lock(ROOT / '.runtime/recent-update.lock'):
                result = record_status(read_json(args.plan), args.state)
        else:
            if args.samples < 1:
                raise ValueError('Samples must be positive.')
            with update_lock(ROOT / '.runtime/recent-update.lock'):
                result = build(read_json(args.plan), args.nasa_root, args.blender, args.source_project,
                               args.cpu, args.samples, args.destination, args.force)
        append_audit({'command': args.command, **result})
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception as error:
        append_audit({'command': args.command, 'status': 'review_needed' if isinstance(error, (ReviewNeeded, ValueError)) else 'failed',
                      'error': str(error), 'existing_edition_retained_until_complete_validation': True})
        raise


if __name__ == '__main__':
    main()
