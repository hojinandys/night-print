"""Pinned SGIS-derived 2023-12-31 boundaries, preserving all polygon components."""
from pathlib import Path
import json, hashlib
import shapely
from shapely.geometry import shape, mapping
from shapely.ops import transform, unary_union
from pyproj import Transformer
ROOT=Path(__file__).resolve().parents[1]
REGIONS={'seoul':('11','서울','서울특별시'),'busan':('26','부산','부산광역시'),'jeju':('50','제주','제주특별자치도')}
URL='https://raw.githubusercontent.com/vuski/admdongkor/7360288277dfd12d74e54b959c59bdd66f852e3a/ver20231231/HangJeongDong_ver20231231.geojson'
GIT_BLOB='307eb024bdb3795f40a050b63d982adfc0d6ea52'
PROJECT=Transformer.from_crs(4326,32652,always_xy=True).transform
UNPROJECT=Transformer.from_crs(32652,4326,always_xy=True).transform

def build():
    p=ROOT/'data/source/korea_dongs_20231231.geojson';b=p.read_bytes()
    assert hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()==GIT_BLOB,'Boundary version/hash mismatch'
    source=json.loads(b);features=[];report={}
    for key,(code,name,full) in REGIONS.items():
        fs=[f for f in source['features'] if f['properties']['sido']==code]
        districts=sorted(set(f['properties']['sgg'] for f in fs));gs=[]
        for district in districts:
            sub=[f for f in fs if f['properties']['sgg']==district]
            g=unary_union([shapely.make_valid(shape(f['geometry'])) for f in sub]);gs.append(g)
            features.append({'type':'Feature','properties':{'region':key,'level':'district','code':district,'name':sub[0]['properties']['sggnm']},'geometry':mapping(g)})
        g=unary_union(gs)
        features.append({'type':'Feature','properties':{'region':key,'level':'region','name':full},'geometry':mapping(g)})
        report[key]={'name':name,'dongs':len(fs),'districts':len(districts),'bounds_lonlat':list(g.bounds),'area_km2':transform(PROJECT,g).area/1e6,'components':len(g.geoms) if hasattr(g,'geoms') else 1,'valid_geometry':g.is_valid}
    out=ROOT/'data/processed';out.mkdir(parents=True,exist_ok=True)
    (out/'boundaries.geojson').write_text(json.dumps({'type':'FeatureCollection','features':features},ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    meta={'source_url':URL,'git_blob':GIT_BLOB,'sha256':hashlib.sha256(b).hexdigest(),'boundary_date':'2023-12-31','fixed_for_all_years':True,'license':'CC BY 4.0 (derivative); SGIS KOGL Type 1 (upstream)','credit':'통계청 통계지리정보서비스(SGIS) 행정동 경계, 가공: vuski/admdongkor. CC BY 4.0.','regions':report}
    (ROOT/'data/metadata/boundary_provenance.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False,indent=2));return meta

def load():
    p=ROOT/'data/processed/boundaries.geojson'
    if not p.exists():build()
    return json.loads(p.read_text(encoding='utf-8'))['features']

if __name__=='__main__':build()
