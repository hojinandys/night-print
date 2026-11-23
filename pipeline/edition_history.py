"""Preserve actual observation editions, independently of UI and check timestamps.

Snapshots contain the scientific manifest and content-addressed artwork assets.
They use the current viewer; they do not pretend to preserve a historical UI or
to have been published before the archive was introduced. Standard library only.
"""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import hashlib
import json
from pathlib import Path
import shutil


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    temporary.replace(path)


def digest(content):
    return hashlib.sha256(content).hexdigest()


def identity(manifest):
    """Only measurements/provenance define a new observation edition."""
    keys = ('id', 'means', 'series', 'coverage_pct', 'observed_area_km2', 'boundary_area_km2')
    result = {k: manifest.get(k) for k in ('years', 'baseline_year', 'units', 'boundary_date')}
    period = manifest.get('period')
    result['period'] = {k: period.get(k) for k in ('kind', 'month', 'start_dates', 'end_dates', 'labels', 'baseline_moves')} if period else None
    result['source'] = {k: manifest.get('source', {}).get(k) for k in ('doi', 'product', 'collection', 'layer', 'processing_note')}
    result['source_files'] = [{k: f.get(k) for k in ('name', 'year', 'url', 'sha256', 'raster_sha256', 'period', 'product', 'collection', 'tile', 'layer', 'quality_rule')}
                              for f in manifest.get('source_files', [])]
    result['regions'] = []
    for region in manifest['regions']:
        record = {k: region.get(k) for k in keys}
        record['districts'] = [{k: district.get(k) for k in keys} for district in region.get('districts', [])]
        result['regions'].append(record)
    return digest(json.dumps(result, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode())


def local(root, relative):
    path = (Path(root) / relative).resolve()
    if not path.is_relative_to(Path(root).resolve()) or not path.is_file():
        raise ValueError(f'Missing or unsafe archive asset: {relative}')
    return path


def walk(value, transform):
    if isinstance(value, dict):
        return {k: walk(v, transform) for k, v in value.items()}
    if isinstance(value, list):
        return [walk(v, transform) for v in value]
    return transform(value)


def freeze_assets(root, manifest):
    def freeze(value):
        if not isinstance(value, str) or not value.startswith('assets/'):
            return value
        source = local(root, value)
        content = source.read_bytes()
        suffix = ''.join(source.suffixes[-2:]) if source.name.endswith('.npg.gz') else source.suffix
        relative = 'history/assets/' + digest(content) + suffix
        destination = Path(root) / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.exists():
            destination.write_bytes(content)
        elif destination.read_bytes() != content:
            raise ValueError('Content-addressed archive asset is corrupted.')
        return relative
    return walk(manifest, freeze)


def period_label(manifest):
    labels = manifest.get('period', {}).get('labels', {})
    years = manifest['years']
    return ' ↔ '.join(str(labels.get(str(y), y)) for y in [years[0], years[-1]])


def change_notes(manifest, previous):
    if not previous:
        return '관측 기록 시작', ['현재 공개된 관측 자료를 처음 보존했습니다. 과거 게시 이력은 소급해 만들지 않았습니다.']
    notes = []
    if period_label(manifest) != period_label(previous):
        notes.append(f"관측 기간: {period_label(previous)} → {period_label(manifest)}")
    if period_label(manifest) != period_label(previous) and manifest.get('period', {}).get('kind') == 'monthly_same_month':
        notes.append('기준 시점도 전년 같은 달로 이동합니다. 서로 다른 월간 판의 증감률을 연속 추세로 잇지 않습니다.')
    old = {r['id']: r for r in previous['regions']}
    for region in manifest['regions']:
        before = old.get(region['id'])
        if before and abs(region['coverage_pct'] - before['coverage_pct']) > .00001:
            notes.append(f"{region.get('label', region['id'])} 공통 관측 면적: {before['coverage_pct']:.2f}% → {region['coverage_pct']:.2f}%")
    if not notes:
        notes.append('같은 관측 기간의 원본 또는 검증된 관측값이 개정되어 새 판으로 보존했습니다.')
    return ('새 관측 기간' if period_label(manifest) != period_label(previous) else '관측 자료 개정'), notes


def prepare(staged, current=None, recorded_at=None):
    """Carry history to a staged edition, then register it without touching current."""
    staged = Path(staged).resolve()
    current = Path(current).resolve() if current else staged
    if current != staged and current.exists():
        validate(current)
    if current != staged and (current / 'data/history.json').exists():
        shutil.copytree(current / 'history', staged / 'history', dirs_exist_ok=True)
        shutil.copy2(current / 'data/history.json', staged / 'data/history.json')
    path = staged / 'data/history.json'
    index = read(path) if path.exists() else {'schema_version': 1, 'current_id': None, 'editions': []}
    manifest = read(staged / 'data/manifest.json')
    edition_id = identity(manifest)[:20]
    existing = next((e for e in index['editions'] if e['id'] == edition_id), None)
    if existing is None:
        previous_entry = next((e for e in index['editions'] if e['id'] == index['current_id']), None)
        previous = read(local(staged, previous_entry['manifest_url'])) if previous_entry else None
        # Annual and monthly archives are intentionally separate.
        kind = manifest.get('period', {}).get('kind', 'annual')
        if previous and previous.get('period', {}).get('kind', 'annual') != kind:
            raise ValueError('Observation histories cannot mix annual and monthly editions.')
        timestamp = recorded_at or dt.datetime.now(dt.timezone.utc).isoformat()
        snapshot = freeze_assets(staged, copy.deepcopy(manifest))
        snapshot['archived'] = {'id': edition_id, 'recorded_at': timestamp, 'kind': 'observation_snapshot'}
        reason, notes = change_notes(manifest, previous)
        relative = f'history/{edition_id}/manifest.json'
        write(staged / relative, snapshot)
        labels = manifest.get('period', {}).get('labels', {})
        first, last = manifest['years'][0], manifest['years'][-1]
        index['editions'].insert(0, {
            'id': edition_id, 'label': manifest.get('edition', period_label(manifest)),
            'kind': kind, 'period_label': period_label(manifest),
            'observed_from': str(labels.get(str(first), first)), 'observed_to': str(labels.get(str(last), last)),
            'recorded_at': timestamp, 'manifest_url': relative, 'is_current': True,
            'reason': reason, 'summary': notes[0], 'changes': notes,
        })
    index['current_id'] = edition_id
    for entry in index['editions']:
        entry['is_current'] = entry['id'] == edition_id
    write(path, index)
    validate(staged)
    return {'current_id': edition_id, 'edition_count': len(index['editions']), 'added': existing is None}


def validate(root):
    root = Path(root)
    path = root / 'data/history.json'
    if not path.exists():
        if (root / 'history').exists() and any((root / 'history').rglob('*')):
            raise ValueError('Observation history assets exist but the index is missing.')
        return {'edition_count': 0}
    index = read(path)
    entries = index.get('editions', [])
    if index.get('schema_version') != 1 or not entries or len({e['id'] for e in entries}) != len(entries):
        raise ValueError('Invalid observation history index.')
    if sum(e.get('is_current', False) for e in entries) != 1 or not any(e['id'] == index['current_id'] and e.get('is_current') for e in entries):
        raise ValueError('History must identify exactly one current observation.')
    checked = set()
    for entry in entries:
        if entry['manifest_url'] != f"history/{entry['id']}/manifest.json":
            raise ValueError('Unsafe snapshot path.')
        manifest = read(local(root, entry['manifest_url']))
        if identity(manifest)[:20] != entry['id'] or manifest.get('archived', {}).get('id') != entry['id']:
            raise ValueError('Snapshot scientific identity changed.')
        def check(value):
            if isinstance(value, str) and value.startswith('assets/'):
                raise ValueError('Snapshot depends on a mutable live asset.')
            if isinstance(value, str) and value.startswith('history/assets/') and value not in checked:
                asset = local(root, value)
                if digest(asset.read_bytes()) != asset.name.split('.')[0]:
                    raise ValueError('Snapshot asset checksum failed.')
                checked.add(value)
            return value
        walk(manifest, check)
    if identity(read(root / 'data/manifest.json'))[:20] != index['current_id']:
        raise ValueError('Current observations are not registered in history.')
    return {'edition_count': len(entries), 'verified_assets': len(checked)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dist', type=Path, required=True)
    parser.add_argument('--current', type=Path)
    parser.add_argument('--validate', action='store_true')
    args = parser.parse_args()
    print(json.dumps(validate(args.dist) if args.validate else prepare(args.dist, args.current), ensure_ascii=False))
