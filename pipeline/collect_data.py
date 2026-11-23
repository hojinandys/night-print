"""Automatic public-data collection for Night Print (WorldPop / EOG).

Discover official files -> stream/retry/resume -> SHA-256 -> GeoTIFF validation
-> preserve original Seoul/Busan/Jeju pixels -> append provenance -> optionally analyze.
No login, API key, HTML scraping, or personal observations are used.
"""
from __future__ import annotations
import argparse,datetime,hashlib,json,re,time,sys,subprocess
from concurrent.futures import ThreadPoolExecutor,as_completed
from pathlib import Path
from urllib.parse import urlsplit
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
import rasterio
from rasterio.warp import transform
from rasterio.windows import from_bounds

ROOT=Path(__file__).resolve().parents[1]
API='https://hub.worldpop.org/rest/data/covariates/G2_NT_lights?iso3=KOR'
PREFIX='https://data.worldpop.org/GIS/Covariates/Global_2015_2030/KOR/VIIRS/v1/nvf/'

def utcnow():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def digest(path):
    h=hashlib.sha256()
    with open(path,'rb') as stream:
        for chunk in iter(lambda:stream.read(2**20),b''):h.update(chunk)
    return h.hexdigest()
def write_json(path,value):
    path.parent.mkdir(parents=True,exist_ok=True);tmp=path.with_suffix(path.suffix+'.tmp')
    tmp.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8');tmp.replace(path)
def session():
    s=requests.Session();s.headers['User-Agent']='NightPrint-AcademicDataCollector/1.0 (public WorldPop data)'
    retry=Retry(total=4,connect=4,read=2,status=4,backoff_factor=1,status_forcelist=[429,500,502,503,504],allowed_methods=['GET'],respect_retry_after_header=True)
    s.mount('https://',HTTPAdapter(max_retries=retry));return s

def discover(metadata):
    rows=metadata.get('data',[])
    row=next((x for x in rows if str(x.get('id'))=='62620' and x.get('iso3')=='KOR'),None)
    if row is None:raise ValueError('Expected South Korea VIIRS dataset 62620 is absent; no other product will be substituted.')
    found={}
    for url in row.get('files',[]):
        name=Path(urlsplit(url).path).name
        match=re.fullmatch(r'kor_viirs_nvf_(\d{4})_100m_v1\.tif',name)
        if match:
            # The official API contains a repeated slash. Canonicalize only this known product path.
            if urlsplit(url).hostname!='data.worldpop.org' or '/KOR/VIIRS/v1/nvf/' not in url:raise ValueError('Unexpected source URL')
            year=int(match[1])
            if year in found:raise ValueError(f'Duplicate year {year}')
            found[year]=PREFIX+name
    if not found:raise ValueError('No supported annual radiance files in official metadata')
    return row,found

def validate_raster(path):
    with rasterio.open(path) as ds:
        if ds.crs.to_epsg()!=4326 or ds.count!=1 or ds.dtypes!=('float32',):raise ValueError('Unexpected CRS, band count, or pixel type')
        if ds.nodata!=-999999 or ds.width!=7597 or ds.height!=6603:raise ValueError('Source grid/version changed; review before using it')
        # Read strips across the file so corrupt compressed data also fails validation.
        for row in range(0,ds.height,512):ds.read(1,window=((row,min(row+512,ds.height)),(0,ds.width)))
        return {'shape':[ds.height,ds.width],'crs':ds.crs.to_string(),'nodata':ds.nodata,'dtype':ds.dtypes[0],'bounds':list(ds.bounds)}

def download(url,destination,expected_sha=None,attempts=4):
    destination.parent.mkdir(parents=True,exist_ok=True)
    if destination.exists():
        sha=digest(destination)
        if expected_sha and sha!=expected_sha:raise ValueError(f'Cached file checksum mismatch: {destination.name}. Keep it for inspection; remove it explicitly to retry.')
        return {'status':'verified_cache','bytes':destination.stat().st_size,'sha256':sha,'attempts':0,'resumed_bytes':0}
    part=destination.with_suffix(destination.suffix+'.part');resumed=0
    with session() as s:
        for attempt in range(1,attempts+1):
            offset=part.stat().st_size if part.exists() else 0
            headers={'Range':f'bytes={offset}-'} if offset else {}
            try:
                with s.get(url,headers=headers,stream=True,timeout=(20,90)) as resp:
                    resp.raise_for_status()
                    append=offset>0 and resp.status_code==206
                    if append:
                        if not resp.headers.get('Content-Range','').startswith(f'bytes {offset}-'):raise ValueError('Invalid partial-content offset')
                        resumed+=offset
                    elif resp.status_code!=200:raise ValueError(f'Unexpected download status {resp.status_code}')
                    # A server that ignores Range returns 200: restart instead of appending duplicate data.
                    received=0
                    with open(part,'ab' if append else 'wb') as f:
                        for chunk in resp.iter_content(2**20):
                            if chunk:f.write(chunk);received+=len(chunk)
                    content_length=resp.headers.get('Content-Length')
                    if content_length is not None and received!=int(content_length):raise IOError('Incomplete HTTP response')
                sha=digest(part)
                if expected_sha and sha!=expected_sha:
                    part.unlink(missing_ok=True)
                    raise ValueError('Downloaded checksum differs from the pinned source version')
                validate_raster(part)
                part.replace(destination)
                return {'status':'downloaded','bytes':destination.stat().st_size,'sha256':sha,'attempts':attempt,'resumed_bytes':resumed}
            except (requests.RequestException,IOError) as e:
                if attempt==attempts:raise
                print(f'Retrying {destination.name}: {type(e).__name__}',flush=True);time.sleep(min(2**attempt,8))
    raise RuntimeError('Download did not finish')

def crop_original(path,destination,region='seoul'):
    from boundaries import load
    from shapely.geometry import shape
    import math
    from rasterio.windows import Window
    f=next(f for f in load() if f['properties']['region']==region and f['properties']['level']=='region')
    west,south,east,north=shape(f['geometry']).bounds
    with rasterio.open(path) as ds:
        # Pad the complete administrative extent (including remote islands).
        w=from_bounds(west-.02,south-.02,east+.02,north+.02,ds.transform)
        c0,r0=math.floor(w.col_off),math.floor(w.row_off)
        win=Window(c0,r0,math.ceil(w.col_off+w.width)-c0,math.ceil(w.row_off+w.height)-r0)
        pixels=ds.read(1,window=win,boundless=True,fill_value=ds.nodata);affine=ds.window_transform(win)
        destination.parent.mkdir(parents=True,exist_ok=True);tmp=destination.with_suffix('.tmp.tif')
        with rasterio.open(tmp,'w',driver='GTiff',height=pixels.shape[0],width=pixels.shape[1],count=1,dtype=pixels.dtype,crs=ds.crs,transform=affine,nodata=ds.nodata,compress='deflate') as out:out.write(pixels,1)
        tmp.replace(destination)
    return {'region':region,'crop_file':str(destination.relative_to(ROOT)) if destination.is_relative_to(ROOT) else str(destination),'crop_sha256':digest(destination),'crop_shape':list(pixels.shape),'pixel_values_modified':False,'outside_national_extent':'padded with source NoData, never zero'}

def collect_one(year,url,cache,out,expected):
    path=cache/f'kor_viirs_{year}.tif'
    entry={'year':year,'url':url,'started_utc':utcnow()}
    entry.update(download(url,path,expected));entry['raster']=validate_raster(path)
    entry['crops']=[crop_original(path,out/f'{region}_{year}_source.tif',region) for region in ['seoul','busan','jeju']]
    entry['finished_utc']=utcnow();print(f'{year}: {entry["status"]}, SHA-256 verified, all three full-region crops ready',flush=True)
    return entry

def ensure_boundaries(offline=False):
    from boundaries import URL,GIT_BLOB,build
    path=ROOT/'data/source/korea_dongs_20231231.geojson'
    if not path.exists():
        if offline:raise FileNotFoundError('Pinned boundary source is missing in offline mode')
        with session() as s:
            r=s.get(URL,timeout=(20,120));r.raise_for_status();b=r.content
        assert hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()==GIT_BLOB,'Boundary checksum mismatch'
        path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b)
    return build()

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--years',nargs='+',type=int,default=list(range(2015,2024)))
    p.add_argument('--cache',type=Path,default=ROOT/'cache/downloads')
    p.add_argument('--output',type=Path,default=ROOT/'data/source')
    p.add_argument('--workers',type=int,default=3)
    p.add_argument('--metadata-only',action='store_true',help='Discover and validate official annual file links without downloading the rasters.')
    p.add_argument('--offline',action='store_true',help='Use preserved API metadata; every requested full raster must already be cached.')
    p.add_argument('--no-analyze',action='store_true')
    a=p.parse_args();a.cache=a.cache.resolve();a.output=a.output.resolve()
    started=utcnow();meta_dir=ROOT/'data/metadata';meta_path=meta_dir/'provider_metadata_latest.json'
    if a.offline:
        metadata=json.loads((meta_path if meta_path.exists() else meta_dir/'provider_metadata.json').read_text(encoding='utf-8'))
    else:
        with session() as s:
            r=s.get(API,timeout=(20,60));r.raise_for_status();metadata=r.json()
        write_json(meta_path,metadata)
    row,files=discover(metadata)
    years=sorted(set(a.years));missing=set(years)-files.keys()
    if missing:raise ValueError(f'Requested years absent in official source: {sorted(missing)}')
    if a.offline and any(not(a.cache/f'kor_viirs_{y}.tif').exists() for y in years):raise FileNotFoundError('Offline collection requires the requested complete national raster cache.')
    manifest_path=meta_dir/'download_manifest.json'
    known=json.loads(manifest_path.read_text(encoding='utf-8')) if manifest_path.exists() else json.loads((ROOT/'pipeline/source_config.json').read_text(encoding='utf-8'))['downloads']
    expected={x['year']:x['sha256'] for x in known}
    record={'started_utc':started,'api':API,'dataset_id':row['id'],'doi':row['doi'],'requested_years':years,'available_years':sorted(files),'metadata_only':a.metadata_only,'offline':a.offline,'events':[],'errors':[]}
    log=meta_dir/'collection_log.json'
    history=meta_dir/'collection_runs'/(started.replace(':','').replace('.','_')+'.json')
    print('Official dataset:',row['title'],'Available:',sorted(files),flush=True)
    if not a.metadata_only:
        record['boundaries']=ensure_boundaries(a.offline)
        with ThreadPoolExecutor(max_workers=max(1,min(a.workers,3))) as pool:
            jobs={pool.submit(collect_one,y,files[y],a.cache,a.output,expected.get(y)):y for y in years}
            for future in as_completed(jobs):
                try:record['events'].append(future.result())
                except Exception as e:record['errors'].append({'year':jobs[future],'error':f'{type(e).__name__}: {e}'});print(record['errors'][-1],file=sys.stderr,flush=True)
                write_json(log,record);write_json(history,record)
    record['events'].sort(key=lambda r:r['year']);record['finished_utc']=utcnow();record['success']=not record['errors'];write_json(log,record);write_json(history,record)
    if record['errors']:raise SystemExit('Some years failed; successful years are retained. Review collection_log.json and rerun.')
    if not a.metadata_only and not a.no_analyze and a.output==(ROOT/'data/source').resolve() and all((a.output/f'{r}_{y}_source.tif').exists() for r in ['seoul','busan','jeju'] for y in range(2015,2024)):
        subprocess.run([sys.executable,str(ROOT/'pipeline/analyze.py')],check=True)
    print('COLLECTION COMPLETE. Audit:',log,flush=True)

if __name__=='__main__':main()
