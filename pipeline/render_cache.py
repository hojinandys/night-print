"""Content-aware render reuse; a stale PNG must never survive changed geometry."""
import hashlib,json
from pathlib import Path
import numpy as np

def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def array_hash(path):
    h=hashlib.sha256()
    with np.load(path) as data:
        for key in sorted(data.files):
            a=np.ascontiguousarray(data[key]);h.update(key.encode());h.update(str((a.shape,a.dtype.str)).encode());h.update(a.tobytes())
    return h.hexdigest()
def signature(geometry_dir,region,mode,index,script,size,samples,engine_version):
    p=Path(geometry_dir)
    record={'static':array_hash(p/f'{region}_static.npz'),'field':array_hash(p/f'{region}_{mode}_{index:03}.npz'),'lines':sha(p/f'{region}_lines.json'),'renderer':sha(script),'region':region,'mode':mode,'index':index,'width':size,'samples':samples,'engine_version':engine_version}
    return hashlib.sha256(json.dumps(record,sort_keys=True).encode()).hexdigest()
def valid(image,input_signature):
    p=Path(image);meta=p.with_suffix('.render.json')
    if not p.exists() or not meta.exists():return False
    try:r=json.loads(meta.read_text());return r['input_signature']==input_signature and r['image_sha256']==sha(p)
    except (OSError,ValueError,KeyError):return False

def record(image,input_signature):
    p=Path(image);p.with_suffix('.render.json').write_text(json.dumps({'input_signature':input_signature,'image_sha256':sha(p)},indent=2))
