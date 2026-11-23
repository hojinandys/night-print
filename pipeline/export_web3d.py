"""Lossless source geometry packets for the rotating WebGL artwork.

The original XY/base/line coordinates retain float64 precision. Source heights
and contours retain float32 bytes. Blender supplies the original quad mesh's
actual tessellation and smooth normals; no decimation or height rescaling occurs.

Packet: magic NPG3D001, uint32 JSON length, uint32 data start; UTF-8 JSON at byte
16; eight-byte-aligned little-endian arrays. Array offsets are relative to data
start. The complete packet is gzip-compressed with a deterministic timestamp.

Build: python pipeline/export_web3d.py --project PROJECT --out DIST --blender BLENDER
Validate only (standard library): python pipeline/export_web3d.py --validate --out DIST
"""
from __future__ import annotations

import argparse
import array
import datetime as dt
import gzip
import hashlib
import json
import math
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile

MAGIC = b'NPG3D001'
FORMAT = 'NPG3D001'
DTYPES = {'float32': ('f', 4), 'float64': ('d', 8), 'uint32': ('I', 4)}
CAMERA = {'position': [11, -16, 19], 'target_by_mode': {'absolute': [0, 0, .45], 'change': [0, 0, 0]},
          'ortho_width': 18.5, 'shift_y': .015, 'up': [0, 0, 1]}


def sha_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha_file(path):
    return sha_bytes(Path(path).read_bytes())


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    temporary.replace(path)


def unpack(raw):
    """Validate and decode a packet using only Python's standard library."""
    if raw[:2] == b'\x1f\x8b':
        raw = gzip.decompress(raw)
    if len(raw) < 16 or raw[:8] != MAGIC:
        raise ValueError('Not a Night Print geometry packet.')
    header_len, data_start = struct.unpack_from('<II', raw, 8)
    if header_len > 1024 * 1024 or data_start != ((16 + header_len + 7) // 8) * 8 or data_start > len(raw):
        raise ValueError('Invalid geometry packet header length.')
    header = json.loads(raw[16:16 + header_len])
    if header.get('schema') != 1 or header.get('kind') not in ('static', 'frame'):
        raise ValueError('Unsupported geometry packet schema.')
    values, last_end = {}, 0
    for name, descriptor in header['arrays'].items():
        dtype, shape = descriptor['dtype'], descriptor['shape']
        if dtype not in DTYPES or not isinstance(shape, list) or any(type(n) is not int or n < 0 for n in shape):
            raise ValueError('Invalid geometry array type or shape.')
        code, width = DTYPES[dtype]
        count = math.prod(shape)
        offset, length = descriptor['byte_offset'], descriptor['byte_length']
        if (descriptor['count'] != count or length != count * width or offset < last_end
                or offset % 8 or data_start + offset + length > len(raw)):
            raise ValueError('Invalid geometry array bounds.')
        payload = raw[data_start + offset:data_start + offset + length]
        if sha_bytes(payload) != descriptor['sha256']:
            raise ValueError('Geometry array SHA256 mismatch.')
        decoded = array.array(code)
        decoded.frombytes(payload)
        if sys.byteorder != 'little':
            decoded.byteswap()
        if dtype.startswith('float') and not all(map(math.isfinite, decoded)):
            raise ValueError('Non-finite geometry values.')
        values[name] = decoded
        last_end = offset + length
    if data_start + last_end != len(raw):
        raise ValueError('Unexpected geometry packet trailing data.')
    return header, values, len(raw)


def load_descriptor(out, descriptor):
    out = Path(out).resolve()
    path = (out / descriptor['url']).resolve()
    if not path.is_relative_to(out / 'assets/geometry') or not path.is_file():
        raise ValueError('Missing or unsafe WebGL geometry URL.')
    raw = path.read_bytes()
    if len(raw) != descriptor['bytes'] or sha_bytes(raw) != descriptor['sha256']:
        raise ValueError('WebGL file SHA256 or byte length differs from the manifest.')
    header, arrays, uncompressed_bytes = unpack(raw)
    if uncompressed_bytes != descriptor['uncompressed_bytes'] or header['arrays'] != descriptor['arrays']:
        raise ValueError('WebGL descriptor differs from its binary header.')
    return header, arrays


def validate(out, expected_years=None):
    """Strict artifact validation; intentionally has no NumPy/Blender dependency."""
    out = Path(out).resolve()
    manifest = json.loads((out / 'data/manifest.json').read_text(encoding='utf-8'))
    years = manifest['years']
    if expected_years is not None and list(expected_years) != years:
        raise ValueError('WebGL observation years differ from the edition.')
    if manifest.get('webgl', {}).get('format') != FORMAT:
        raise ValueError('Missing WebGL edition metadata.')
    frame_count = 0
    total_bytes = 0
    for region in manifest['regions']:
        web = region['webgl']
        if web['static_url'] != web['static']['url']:
            raise ValueError('Inconsistent static geometry URL.')
        header, static = load_descriptor(out, web['static'])
        count = web['vertex_count']
        if (header['kind'] != 'static' or header['region'] != region['id']
                or len(static['xy']) != count * 2 or len(static['faces']) % 4
                or not static['faces'] or max(static['faces']) >= count
                or len(static['base']) % 6 or len(static['base_positions']) % 3
                or len(static['base_normals']) != len(static['base_positions'])
                or len(static['base_triangles']) % 3
                or max(static['base_triangles']) >= len(static['base_positions']) // 3):
            raise ValueError('Invalid static mesh geometry.')
        for prefix in ['outline', 'district']:
            if sum(static[prefix + '_lengths']) * 2 != len(static[prefix + '_points']):
                raise ValueError('Boundary polyline lengths are inconsistent.')
        total_bytes += web['static']['bytes']
        for mode in ['absolute', 'change']:
            frames = web['frames'][mode]
            if [frame['year'] for frame in frames] != years:
                raise ValueError('Missing observed WebGL frame.')
            for frame in frames:
                h, values = load_descriptor(out, frame)
                if (h['kind'] != 'frame' or h['region'] != region['id'] or h['mode'] != mode or h['year'] != frame['year']
                        or len(values['z']) != count or len(values['normals']) != count * 3
                        or len(values['triangles']) != frame['index_count'] or len(values['triangles']) % 3
                        or max(values['triangles']) >= count
                        or len(values['triangles']) != len(static['faces']) // 4 * 6
                        or sum(values['n']) * 3 != len(values['p']) or len(values['n']) != len(values['levels'])):
                    raise ValueError('Invalid observed surface or contour topology.')
                low, high = (-1.1, 4.8) if mode == 'absolute' else (-2.6, 3.3)
                if min(values['z']) <= low or max(values['z']) >= high:
                    raise ValueError('Geometry escapes the preserved sculpture range.')
                if mode == 'change' and frame['year'] == years[0] and any(values['z']):
                    raise ValueError('Baseline change surface is not zero.')
                # GPU vertices use the same float32 conversion Blender applies.
                position_hash = hashlib.sha256()
                for i, height in enumerate(values['z']):
                    position_hash.update(struct.pack('<fff', static['xy'][i * 2], static['xy'][i * 2 + 1], height))
                if position_hash.hexdigest() != h['blender_position_sha256']:
                    raise ValueError('WebGL vertices differ from the actual Blender vertices.')
                total_bytes += frame['bytes']
                frame_count += 1
        if {a['id'] for a in web['district_anchors']} != {d['id'] for d in region['districts']}:
            raise ValueError('A district world anchor is missing.')
        for anchor in web['district_anchors']:
            if len(anchor['xyz']) != 3 or not all(map(math.isfinite, anchor['xyz'])) or anchor['xyz'][2] != 0:
                raise ValueError('Invalid district reference-plane anchor.')
    return {'validated': True, 'frames': frame_count, 'regions': len(manifest['regions']), 'bytes': total_bytes}


def packet(directory, stem, metadata, arrays, source_arrays=None):
    import numpy as np
    source_arrays = source_arrays or {}
    descriptors, chunks, cursor = {}, [], 0
    for name, values in arrays.items():
        values = np.ascontiguousarray(values)
        if values.dtype.kind == 'f':
            dtype = 'float32' if values.dtype.itemsize == 4 else 'float64'
            values = values.astype('<f4' if dtype == 'float32' else '<f8', copy=False)
            if not np.isfinite(values).all():
                raise ValueError('Non-finite source geometry.')
        else:
            if (values < 0).any() or (values > np.iinfo('uint32').max).any():
                raise ValueError('Indices cannot be represented losslessly.')
            dtype = 'uint32'
            values = values.astype('<u4')
        padding = (-cursor) % 8
        chunks.append(b'\0' * padding)
        cursor += padding
        payload = values.tobytes()
        descriptor = {'dtype': dtype, 'shape': list(values.shape), 'count': int(values.size),
                      'byte_offset': cursor, 'byte_length': len(payload), 'sha256': sha_bytes(payload)}
        if name in source_arrays:
            original = np.asarray(source_arrays[name])
            if not np.array_equal(values, original):
                raise ValueError(f'Source geometry changed: {name}')
            descriptor['source_dtype'] = str(original.dtype)
            descriptor['source_sha256'] = sha_bytes(original.tobytes())
            descriptor['source_values_exact'] = True
        descriptors[name] = descriptor
        chunks.append(payload)
        cursor += len(payload)
    header = dict(metadata, schema=1, arrays=descriptors)
    encoded = json.dumps(header, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
    start = ((16 + len(encoded) + 7) // 8) * 8
    raw = MAGIC + struct.pack('<II', len(encoded), start) + encoded
    raw += b'\0' * (start - len(raw)) + b''.join(chunks)
    compressed = gzip.compress(raw, compresslevel=9, mtime=0)
    digest = sha_bytes(compressed)
    path = directory / f'{stem}-{digest[:12]}.npg.gz'
    directory.mkdir(parents=True, exist_ok=True)
    path.write_bytes(compressed)
    parsed, decoded, _ = unpack(compressed)
    for name, original in arrays.items():
        np.testing.assert_array_equal(np.asarray(decoded[name]).reshape(original.shape), original)
    return {'url': path, 'sha256': digest, 'bytes': len(compressed), 'uncompressed_bytes': len(raw), 'arrays': parsed['arrays']}


def blender_worker(project, work):
    """Executed by Blender in a factory-startup process; no rendering is required."""
    import bpy
    import numpy as np
    project, work = Path(project), Path(work)
    facts = json.loads((project / 'data/processed/facts.json').read_text(encoding='utf-8'))
    result = {'blender_version': bpy.app.version_string, 'frames': []}
    for region in facts['regions']:
        with np.load(project / f'cache/geometry/{region}_static.npz') as source:
            xy, faces, base = source['xy'], source['faces'], source['base']
        vertices = np.column_stack([xy, np.zeros(len(xy))]).astype('f4')
        mesh = bpy.data.meshes.new('Verified original quad surface')
        mesh.from_pydata(vertices, [], faces)
        for face in mesh.polygons:
            face.use_smooth = True
        for mode in ['absolute', 'change']:
            for i, year in enumerate(facts['years']):
                key = f'{region}_{mode}_{i * 8:03}'
                with np.load(project / f'cache/geometry/{key}.npz') as source:
                    vertices[:, 2] = source['z']
                mesh.vertices.foreach_set('co', vertices.ravel())
                mesh.update()
                mesh.calc_loop_triangles()
                triangles = np.empty(len(mesh.loop_triangles) * 3, dtype='uint32')
                mesh.loop_triangles.foreach_get('vertices', triangles)
                normals = np.empty(len(mesh.vertices) * 3, dtype='float32')
                mesh.vertex_normals.foreach_get('vector', normals)
                actual_positions = np.empty(len(mesh.vertices) * 3, dtype='float32')
                mesh.vertices.foreach_get('co', actual_positions)
                np.testing.assert_array_equal(actual_positions.reshape(-1, 3), vertices)
                np.savez(work / f'{key}.npz', triangles=triangles.reshape(-1, 3), normals=normals.reshape(-1, 3))
                result['frames'].append({'key': key, 'position_sha256': sha_bytes(actual_positions.tobytes())})
        bpy.data.meshes.remove(mesh)
        # Evaluate the same thin full-boundary base as the original Blender scene.
        base_mesh = bpy.data.meshes.new('All polygon components')
        base_mesh.from_pydata(np.column_stack([base, np.full(len(base), -.065)]), [], np.arange(len(base)).reshape(-1, 3))
        base_mesh.update()
        obj = bpy.data.objects.new('Original full-region base', base_mesh)
        bpy.context.collection.objects.link(obj)
        modifier = obj.modifiers.new('Thin cut metal', 'SOLIDIFY')
        modifier.thickness = .065
        evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
        actual_mesh = evaluated.to_mesh()
        actual_mesh.calc_loop_triangles()
        positions = np.empty(len(actual_mesh.vertices) * 3, dtype='f4')
        normals = np.empty_like(positions)
        triangles = np.empty(len(actual_mesh.loop_triangles) * 3, dtype='u4')
        actual_mesh.vertices.foreach_get('co', positions)
        actual_mesh.vertex_normals.foreach_get('vector', normals)
        actual_mesh.loop_triangles.foreach_get('vertices', triangles)
        np.savez(work / f'{region}_base.npz', base_positions=positions.reshape(-1, 3),
                 base_normals=normals.reshape(-1, 3), base_triangles=triangles.reshape(-1, 3))
        evaluated.to_mesh_clear()
        bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.meshes.remove(base_mesh)
    write_json(work / 'blender.json', result)


def build(project, out, blender):
    import numpy as np
    project, out = Path(project).resolve(), Path(out).resolve()
    facts = json.loads((project / 'data/processed/facts.json').read_text(encoding='utf-8'))
    manifest_path = out / 'data/manifest.json'
    initial = json.loads(manifest_path.read_text(encoding='utf-8'))
    years = facts['years']
    if initial['years'] != years or {r['id'] for r in initial['regions']} != set(facts['regions']):
        raise ValueError('The WebGL source does not match the existing edition.')
    destination = out / 'assets/geometry'
    region_web, exports = {}, []
    with tempfile.TemporaryDirectory(prefix='night-print-webgl-') as temporary:
        work = Path(temporary)
        subprocess.run([str(blender), '-b', '--factory-startup', '--python', str(Path(__file__).resolve()), '--',
                        '--blender-worker', '--project', str(project), '--work', str(work)], check=True)
        reference = json.loads((work / 'blender.json').read_text(encoding='utf-8'))
        position_hashes = {f['key']: f['position_sha256'] for f in reference['frames']}
        for region in initial['regions']:
            rid = region['id']
            with np.load(project / f'cache/geometry/{rid}_static.npz') as s:
                static = {k: s[k] for k in s.files}
            lines = json.loads((project / f'cache/geometry/{rid}_lines.json').read_text(encoding='utf-8'))
            arrays = {k: static[k] for k in ['xy', 'faces', 'base']}
            for source, prefix in [('outlines', 'outline'), ('districts', 'district')]:
                arrays[prefix + '_points'] = np.concatenate([np.asarray(p, dtype='f8') for p in lines[source]])
                arrays[prefix + '_lengths'] = np.asarray([len(p) for p in lines[source]], dtype='u4')
            original_arrays = dict(arrays)
            with np.load(work / f'{rid}_base.npz') as base:
                arrays.update({k: base[k] for k in base.files})
            metadata = {'kind': 'static', 'region': rid, 'width': float(static['width']), 'height': float(static['height']),
                        'source_static_sha256': sha_file(project / f'cache/geometry/{rid}_static.npz'),
                        'source_lines_sha256': sha_file(project / f'cache/geometry/{rid}_lines.json'),
                        'blender_version': reference['blender_version']}
            descriptor = packet(destination / rid, 'static', metadata, arrays, original_arrays)
            descriptor['url'] = descriptor['url'].relative_to(out).as_posix()
            web = {'version': 1, 'static_url': descriptor['url'], 'static': descriptor,
                   'vertex_count': len(static['xy']), 'quad_count': len(static['faces']),
                   'width': float(static['width']), 'height': float(static['height']),
                   'frames': {'absolute': [], 'change': []}, 'camera': CAMERA,
                   'district_anchors': [],
                   'scene': {'z_up': True, 'floor_z': {'absolute': -1.1, 'change': -2.6},
                             'base_visible': {'absolute': True, 'change': False},
                             'outline_z': {'absolute': -.06, 'change': 0},
                             'district_line_z': {'absolute': -.059, 'change': -.004},
                             'extent_frame_z': -.12, 'north_marker_z': -.11,
                             'body': {'color': [.028, .019, .012], 'metalness': .72, 'roughness': .34},
                             'lights': [{'position': [-5, -1, 9], 'color': [1, .69, .43], 'power': 1100, 'size': 9},
                                        {'position': [2, 7, 8], 'color': [.42, .61, 1], 'power': 1400, 'size': 8},
                                        {'position': [6, 1, 5], 'color': [1, .80, .58], 'power': 850, 'size': 5}]}}
            with np.load(project / f'data/processed/{rid}_series.npz') as s:
                t = s['transform']; ny, nx = s['common'].shape
            cell = float(facts['cell_m']); scale = 10 / max(nx * cell, ny * cell)
            cx, cy = t[2] + nx * cell / 2, t[5] - ny * cell / 2
            for district in region['districts']:
                x, y = district['map_anchor_utm']
                web['district_anchors'].append({'id': district['id'], 'name': district['name'],
                                                'xyz': [(x - cx) * scale, (y - cy) * scale, 0]})
            exports.append({'region': rid, 'kind': 'static', 'url': descriptor['url'], 'sha256': descriptor['sha256'], 'bytes': descriptor['bytes']})
            for mode in ['absolute', 'change']:
                for i, year in enumerate(years):
                    key = f'{rid}_{mode}_{i * 8:03}'
                    with np.load(project / f'cache/geometry/{key}.npz') as s:
                        arrays = {k: s[k] for k in ['z', 'p', 'n', 'levels']}
                    original_arrays = dict(arrays)
                    with np.load(work / f'{key}.npz') as s:
                        arrays.update({k: s[k] for k in s.files})
                    metadata = {'kind': 'frame', 'region': rid, 'mode': mode, 'year': year,
                                'source_geometry_sha256': sha_file(project / f'cache/geometry/{key}.npz'),
                                'blender_position_sha256': position_hashes[key], 'blender_version': reference['blender_version']}
                    desc = packet(destination / rid / mode, str(year), metadata, arrays, original_arrays)
                    desc['url'] = desc['url'].relative_to(out).as_posix()
                    desc.update({'year': year, 'vertex_count': len(arrays['z']), 'index_count': int(arrays['triangles'].size)})
                    web['frames'][mode].append(desc)
                    exports.append({'region': rid, 'mode': mode, 'year': year, 'url': desc['url'],
                                    'sha256': desc['sha256'], 'bytes': desc['bytes'],
                                    'source_values_exact': True, 'blender_position_sha256': position_hashes[key]})
            region_web[rid] = web
        # Merge only our 3D fields; retain the edition's other metadata verbatim.
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        if manifest['years'] != years:
            raise ValueError('The edition changed while geometry was exported.')
        for region in manifest['regions']:
            region['webgl'] = region_web[region['id']]
        manifest['webgl'] = {'version': 1, 'format': FORMAT, 'compression': 'gzip',
                             'validation_url': 'assets/geometry/validation.json',
                             'source_values_exact': True, 'blender_version': reference['blender_version'],
                             'geometry_note': 'Original mesh heights, XY, all polygon components and contours; no mesh decimation. GPU float32 conversion matches Blender.',
                             'total_bytes': sum(x['bytes'] for x in exports)}
        write_json(manifest_path, manifest)
    result = validate(out, expected_years=years)
    write_json(destination / 'validation.json', {'checked_utc': dt.datetime.now(dt.timezone.utc).isoformat(),
                                                **result, 'source_facts_sha256': sha_file(project / 'data/processed/facts.json'),
                                                'all_source_values_exact': True, 'all_blender_vertices_exact': True,
                                                'blender_version': reference['blender_version'], 'files': exports})
    referenced = {x['url'] for x in exports}
    for stale in destination.rglob('*.npg.gz'):
        if stale.relative_to(out).as_posix() not in referenced:
            stale.unlink()
    print(json.dumps(result), flush=True)
    return result


if __name__ == '__main__':
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--project', type=Path)
    parser.add_argument('--out', type=Path)
    parser.add_argument('--blender', default=shutil.which('blender') or '/Applications/Blender.app/Contents/MacOS/Blender')
    parser.add_argument('--validate', action='store_true')
    parser.add_argument('--blender-worker', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--work', type=Path, help=argparse.SUPPRESS)
    options = parser.parse_args(args)
    if options.blender_worker:
        blender_worker(options.project, options.work)
    elif options.validate:
        print(json.dumps(validate(options.out)), flush=True)
    else:
        if options.project is None or options.out is None:
            parser.error('--project and --out are required for export')
        build(options.project, options.out, options.blender)
