"""Detect real annual releases, build a staged edition, publish only valid art.

check performs a small HTTPS metadata request only. A changed product, missing
year, broken download or incomplete rendered edition never replaces the site.
Historical replay uses real archived years and never fabricates a future year.
"""
from __future__ import annotations
import argparse,contextlib,datetime,hashlib,json,math,os,re,shutil,subprocess,sys,time,uuid
from pathlib import Path
from urllib.parse import urlsplit

ROOT=Path(__file__).resolve().parents[1]
CONFIG=json.loads((ROOT/'pipeline/source_config.json').read_text(encoding='utf-8'))

class ReviewNeeded(ValueError):pass

def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def read_json(path,default=None):
    return json.loads(Path(path).read_text(encoding='utf-8')) if Path(path).exists() else default
def write_json(path,value):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_name(path.name+'.tmp');tmp.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8');tmp.replace(path)
def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def official_files(metadata):
    other=[x for x in metadata.get('data',[]) if x.get('iso3')=='KOR' and str(x.get('id'))!=CONFIG['dataset_id']]
    if other:raise ReviewNeeded('An additional South Korea product appeared; compare its definition before replacing or mixing versions.')
    rows=[x for x in metadata.get('data',[]) if str(x.get('id'))==CONFIG['dataset_id'] and x.get('iso3')=='KOR']
    if len(rows)!=1:raise ReviewNeeded('Known dataset 62620 is absent or ambiguous; do not substitute another product.')
    row=rows[0]
    if row.get('doi')!=CONFIG['doi']:raise ReviewNeeded('Dataset DOI changed; product review is required.')
    found={}
    for url in row.get('files',[]):
        parsed=urlsplit(url);name=Path(parsed.path).name
        match=re.fullmatch(r'kor_viirs_nvf_(\d{4})_100m_v1\.tif',name)
        if not match:raise ReviewNeeded(f'Unrecognized annual product file: {name}')
        canonical=CONFIG['file_prefix']+name
        if parsed.scheme!='https' or parsed.hostname!='data.worldpop.org' or parsed.path.replace('//','/')!=urlsplit(canonical).path or parsed.query or parsed.fragment:
            raise ReviewNeeded('Unexpected official source path; no unreviewed URL will be downloaded.')
        year=int(match[1])
        if year in found:raise ReviewNeeded(f'Duplicate source year: {year}')
        found[year]=canonical
    if not found:raise ReviewNeeded('No verified-format annual files returned.')
    years=sorted(found)
    if years!=list(range(CONFIG['baseline_year'],years[-1]+1)):
        raise ReviewNeeded('Years must be continuous from 2015; a missing year requires review.')
    if years[-1]>min(2030,datetime.datetime.now(datetime.timezone.utc).year-1):
        raise ReviewNeeded('A complete future annual observation cannot be accepted.')
    return found

def make_plan(metadata,published_years,accepted=None,replay=None):
    files=official_files(metadata);available=sorted(files)
    if replay is not None:
        if replay not in files or replay<2016:raise ReviewNeeded('Replay needs an available observed end year, at least 2016.')
        years=[y for y in available if y<=replay]
    else:
        years=available
        if published_years and (published_years!=list(range(2015,max(published_years)+1)) or not set(published_years).issubset(files)):
            raise ReviewNeeded('An already published observation year is missing; retain the current edition.')
    return {'checked_at':now(),'dataset_id':CONFIG['dataset_id'],'api':CONFIG['api'],'years':years,'available_years':available,'published_years':published_years,'new_years':[y for y in years if y not in published_years],'needs_build':bool(replay is not None or years!=published_years),'historical_replay':replay is not None,'files':{str(y):files[y] for y in years},'accepted_sha256':accepted or {}}

def fetch_metadata():
    import requests
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry
    with requests.Session() as session:
        session.headers['User-Agent']='NightPrint-LivingArt/1.0'
        session.mount('https://',HTTPAdapter(max_retries=Retry(total=3,backoff_factor=1,status_forcelist=[429,500,502,503,504],allowed_methods=['GET'])))
        response=session.get(CONFIG['api'],timeout=(20,60));response.raise_for_status();return response.json()

@contextlib.contextmanager
def update_lock(path):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    try:fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY)
    except FileExistsError:raise RuntimeError('Another update is active, or an interrupted run left a lock. Inspect it before removing it.')
    try:
        with os.fdopen(fd,'w',encoding='utf-8') as f:json.dump({'pid':os.getpid(),'started':now()},f)
        yield
    finally:path.unlink(missing_ok=True)

VIEWER_FILES=('viewer3d.js','story.mjs','place-stories.mjs','place-story-data.mjs','immersive-focus.mjs','observation-cache.mjs','playback.mjs','vendor/three.module.js','vendor/three.core.js',
              'vendor/OrbitControls.js','vendor/RoomEnvironment.js',
              'vendor/LineSegments2.js','vendor/LineSegmentsGeometry.js','vendor/LineMaterial.js',
              'vendor/THREE-LICENSE.txt')

def copy_interactive_viewer(source,destination):
    """Copy the same browser renderer; never copy another edition's geometry."""
    source=Path(source);destination=Path(destination)
    for relative in ('index.html','app.js','style.css',*VIEWER_FILES):
        path=source/relative
        if not path.is_file() or path.stat().st_size==0:
            raise ValueError(f'Missing interactive viewer dependency: {relative}')
    destination.mkdir(parents=True,exist_ok=True)
    for relative in ('index.html','app.js','style.css',*(name for name in VIEWER_FILES if not name.startswith('vendor/'))):
        shutil.copy2(source/relative,destination/relative)
    shutil.copytree(source/'vendor',destination/'vendor',dirs_exist_ok=True)

def validate_interactive_art(dist,manifest,required=False):
    """Keep lightweight checks lightweight: the 3D validator uses only stdlib."""
    dist=Path(dist)
    if not(required or manifest.get('webgl') or (dist/'viewer3d.js').exists()):
        return None  # Legacy image-only replay editions remain inspectable.
    if not isinstance(manifest.get('webgl'),dict) or not manifest['webgl']:
        raise ValueError('The interactive viewer requires a complete 3D data manifest.')
    for relative in VIEWER_FILES:
        path=(dist/relative).resolve()
        if not path.is_relative_to(dist.resolve()) or not path.is_file() or path.stat().st_size==0:
            raise ValueError(f'Missing interactive viewer dependency: {relative}')
    from export_web3d import validate
    return validate(dist,expected_years=manifest['years'])

def validate_site(dist,expected_years=None):
    dist=Path(dist);manifest=read_json(dist/'data/manifest.json')
    if not manifest or not (dist/'index.html').is_file():raise ValueError('A complete site and data manifest are required.')
    years=manifest['years']
    if expected_years is not None and years!=expected_years:raise ValueError('Site years do not match the observed edition.')
    if years!=list(range(2015,max(years)+1)):raise ValueError('Non-continuous observed timeline.')
    regions=manifest.get('regions',[])
    if {r['id'] for r in regions}!={'seoul','busan','jeju'}:raise ValueError('Missing region.')
    for region in regions:
        if len(region['means'])!=len(years):raise ValueError('Mean series length mismatch.')
        if not all(isinstance(v,(int,float)) and math.isfinite(v) and v>=0 for v in region['means']):raise ValueError('Invalid mean value.')
        if not 0<region['coverage_pct']<=100:raise ValueError('Invalid observed-area coverage.')
        for mode in ['absolute','change']:
            frames=region['render'][mode]
            if [f['year'] for f in frames]!=years:raise ValueError('Incomplete annual rendered timeline.')
            for frame in frames:
                p=(dist/frame['url']).resolve()
                if not p.is_relative_to(dist.resolve()) or not p.is_file() or p.stat().st_size<100:
                    raise ValueError('Missing or unsafe rendered image path.')
                from PIL import Image
                with Image.open(p) as image:
                    if image.width<640 or abs(image.width/image.height-16/9)>.01:raise ValueError('Unexpected artwork dimensions.')
                    image.verify()
    validate_interactive_art(dist,manifest)
    if manifest.get('experience'):
        from export_experience import validate as validate_experience
        validate_experience(dist)
    from edition_history import validate as validate_history
    validate_history(dist)
    if (dist/'recent/data/manifest.json').is_file():
        from build_recent import validate_recent
        validate_recent(dist/'recent')
    return manifest

def promote(staged_dist,destination,archive_root,expected_years=None):
    """Validated rename swap, with rollback if replacement fails."""
    staged_dist=Path(staged_dist);destination=Path(destination);archive_root=Path(archive_root)
    manifest=validate_site(staged_dist,expected_years)
    archive_root.mkdir(parents=True,exist_ok=True)
    old=None
    if destination.exists():
        old=archive_root/(datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S')+'-'+uuid.uuid4().hex[:8])
        destination.rename(old)
    try:staged_dist.rename(destination)
    except BaseException:
        if old is not None and old.exists() and not destination.exists():old.rename(destination)
        raise
    return {'published_years':manifest['years'],'previous_edition':str(old) if old else None,'published_at':now()}

def current_years():return read_json(ROOT/'dist/data/manifest.json',{}).get('years',[])
def accepted_hashes():
    # The accepted fingerprints travel inside the atomically promoted manifest.
    files=read_json(ROOT/'dist/data/manifest.json',{}).get('source_files',[])
    return {str(x['year']):x['sha256'] for x in files if x.get('sha256')}
def append_audit(event):
    path=ROOT/'.runtime/updates.json';records=read_json(path,[]);records.append(event);write_json(path,records)
def mark_checked(plan):
    path=ROOT/'dist/data/manifest.json';m=read_json(path)
    if not m:return
    m.setdefault('update',{}).update({'state':'up_to_date','latest_year':max(plan['years']),'last_checked':plan['checked_at'],'new_observation':False})
    write_json(path,m)

def run(command,**kwargs):subprocess.run([str(x) for x in command],check=True,**kwargs)

def build_edition(plan,blender,source_project=None,cpu=False,size=1920,samples=24,replay_destination=None):
    if not plan['needs_build']:
        mark_checked(plan);return {'status':'up_to_date','heavy_build_performed':False}
    if size!=1920 or samples<1:raise ValueError('The preserved artwork design requires 1920 x 1080 renders.')
    if plan['years']!=list(range(2015,max(plan['years'])+1)) or len(plan['years'])<2:raise ReviewNeeded('Invalid edition years.')
    for year in plan['years']:
        if plan['files'].get(str(year))!=CONFIG['file_prefix']+f'kor_viirs_nvf_{year}_100m_v1.tif':raise ReviewNeeded('Plan contains an unreviewed data URL.')
    runtime=ROOT/'.runtime';stage=runtime/'staging'/('edition-'+str(plan['years'][-1])+'-'+uuid.uuid4().hex[:8]);stage.mkdir(parents=True)
    # The source tree and visual assets are copied; publication is untouched here.
    shutil.copytree(ROOT/'pipeline',stage/'pipeline',ignore=shutil.ignore_patterns('__pycache__'))
    shutil.copytree(ROOT/'dist',stage/'dist')
    # This initial-export inspection belongs to the initial edition only.
    (stage/'dist/data/export_validation.json').unlink(missing_ok=True)
    (stage/'artwork').mkdir();(stage/'assets').mkdir()
    font_dir=ROOT/'dist/assets/fonts'
    if font_dir.exists():shutil.copytree(font_dir,stage/'assets/fonts')
    for name in ['location_map.png','location-map.png']:
        if (ROOT/'dist/assets'/name).exists():shutil.copy2(ROOT/'dist/assets'/name,stage/'assets/location_map.png');break
    plan_path=stage/'plan.json';write_json(plan_path,plan)
    cmd=[sys.executable,stage/'pipeline/stage_worker.py','--plan',plan_path,'--cache',runtime/'downloads']
    if source_project:cmd+=['--source-project',Path(source_project).resolve()]
    run(cmd,cwd=stage)
    run([sys.executable,stage/'pipeline/build_geometry.py','--annual-only'],cwd=stage)
    import numpy as np
    for mode in ['absolute','change']:
        for path in (stage/'cache/geometry').glob(f'*_{mode}_*.npz'):
            with np.load(path) as geometry:
                height=geometry['z']
                if not np.isfinite(height).all():raise ReviewNeeded('Nonfinite geometry requires review.')
                low,high=(-1.1,4.8) if mode=='absolute' else (-2.6,3.3)
                if len(height) and (height.min()<=low or height.max()>=high):
                    raise ReviewNeeded('New observation exceeds the preserved display range; review the shared visual scale before publication.')
    indices=[str(i*8) for i in range(len(plan['years']))]
    cmd=[blender,'-b','--python',stage/'pipeline/render_scene.py','--','--indices',*indices,'--size',str(size),'--samples',str(samples),'--save']
    if cpu:cmd.append('--cpu')
    run(cmd,cwd=stage)
    run([sys.executable,stage/'pipeline/export_web.py','--project',stage,'--out',stage/'dist','--checked-at',plan['checked_at'],'--status','updated'],cwd=stage)
    manifest_path=stage/'dist/data/manifest.json';m=read_json(manifest_path)
    previous_manifest=read_json(ROOT/'dist/data/manifest.json',{})
    for key in ['repository_url','edition_links']:
        if key in previous_manifest:m[key]=previous_manifest[key]
    m['updated_utc']=now();m['edition']=f"2015–{plan['years'][-1]}";m['baseline_year']=2015
    new_observation=not plan['historical_replay'] and bool(plan['published_years']) and bool(plan['new_years'])
    explanation='기존에 공개된 실제 관측 연도로 갱신 과정을 재현합니다.' if plan['historical_replay'] else ('동일 계열의 새로운 연간 자료를 검증해 작품을 갱신했습니다.' if new_observation else '공개된 실제 연간 자료를 검증해 최초 작품 판을 구성했습니다.')
    m['update']={'state':'historical_replay' if plan['historical_replay'] else 'updated','latest_year':max(plan['years']),'last_checked':plan['checked_at'],'new_observation':new_observation,'historical_replay':plan['historical_replay'],'explanation':explanation,'common_mask_policy':'이 판의 모든 연도에 공통인 관측 영역을 다시 계산합니다. 이전 판과 관측 영역이 달라질 수 있습니다.'}
    receipts=read_json(stage/'data/metadata/source_receipts.json');m['source_files']=[{'year':r['year'],'url':r['url'],'sha256':r.get('sha256'),'status':r['status']} for r in receipts]
    write_json(manifest_path,m)
    run([sys.executable,stage/'pipeline/export_web3d.py','--project',stage,'--out',stage/'dist','--blender',blender],cwd=stage)
    from export_experience import build as build_experience
    build_experience(stage,stage/'dist')
    validate_interactive_art(stage/'dist',read_json(manifest_path),required=True)
    if plan['historical_replay']:
        destination=Path(replay_destination).resolve() if replay_destination else runtime/'replay'/str(plan['years'][-1])
        destination.parent.mkdir(parents=True,exist_ok=True)
    else:destination=ROOT/'dist'
    from edition_history import prepare as prepare_history
    if plan['historical_replay']:
        # A replay is not a formerly published observation edition.
        shutil.rmtree(stage/'dist/history',ignore_errors=True)
        (stage/'dist/data/history.json').unlink(missing_ok=True)
        prepare_history(stage/'dist')
    else:prepare_history(stage/'dist',destination)
    result=promote(stage/'dist',destination,runtime/'releases',plan['years'])
    result.update({'status':'historical_replay' if plan['historical_replay'] else 'updated','heavy_build_performed':True,'stage':str(stage),'destination':str(destination)})
    return result

def main():
    parser=argparse.ArgumentParser(description=__doc__);sub=parser.add_subparsers(dest='command',required=True)
    c=sub.add_parser('check');c.add_argument('--metadata',type=Path);c.add_argument('--output',type=Path,default=ROOT/'.runtime/plan.json');c.add_argument('--github-output',type=Path)
    b=sub.add_parser('build');b.add_argument('--plan',type=Path,default=ROOT/'.runtime/plan.json');b.add_argument('--blender',default=shutil.which('blender') or '/Applications/Blender.app/Contents/MacOS/Blender');b.add_argument('--source-project',type=Path);b.add_argument('--cpu',action='store_true');b.add_argument('--size',type=int,default=1920);b.add_argument('--samples',type=int,default=24)
    c=sub.add_parser('record-check');c.add_argument('--plan',type=Path,default=ROOT/'.runtime/plan.json')
    r=sub.add_parser('replay');r.add_argument('--through',required=True,type=int);r.add_argument('--metadata',type=Path);r.add_argument('--source-project',required=True,type=Path);r.add_argument('--blender',default=shutil.which('blender') or '/Applications/Blender.app/Contents/MacOS/Blender');r.add_argument('--destination',type=Path);r.add_argument('--cpu',action='store_true');r.add_argument('--size',type=int,default=1920);r.add_argument('--samples',type=int,default=24)
    v=sub.add_parser('validate');v.add_argument('--dist',type=Path,default=ROOT/'dist')
    a=parser.parse_args()
    try:
        if a.command=='check':
            metadata=read_json(a.metadata) if a.metadata else fetch_metadata();plan=make_plan(metadata,current_years(),accepted_hashes())
            plan['metadata_origin']='provided_snapshot' if a.metadata else 'official_live_https';write_json(a.output,plan)
            write_json(ROOT/'.runtime/provider_metadata.json',metadata)
            if a.github_output:
                with a.github_output.open('a',encoding='utf-8') as f:f.write('needs_build='+str(plan['needs_build']).lower()+'\n')
            result={'status':'new_observation' if plan['needs_build'] else 'up_to_date','available_years':plan['available_years'],'new_years':plan['new_years'],'metadata_only':True}
        elif a.command=='record-check':plan=read_json(a.plan);mark_checked(plan);result={'status':'up_to_date','heavy_build_performed':False}
        elif a.command=='validate':m=validate_site(a.dist);result={'status':'valid','years':m['years']}
        else:
            with update_lock(ROOT/'.runtime/update.lock'):
                if a.command=='replay':
                    metadata=read_json(a.metadata) if a.metadata else fetch_metadata();plan=make_plan(metadata,[],accepted_hashes(),a.through)
                else:plan=read_json(a.plan)
                if not plan:raise ValueError('Run check before build.')
                result=build_edition(plan,a.blender,a.source_project,a.cpu,a.size,a.samples,getattr(a,'destination',None))
        append_audit({'at':now(),'command':a.command,**result});print(json.dumps(result,ensure_ascii=False,indent=2))
    except Exception as e:
        append_audit({'at':now(),'command':a.command,'status':'review_needed' if isinstance(e,ReviewNeeded) else 'failed','error':str(e),'publication_policy':'Build and image validation precede replacement; failed swaps restore the previous site.'})
        raise

if __name__=='__main__':main()
