"""Whole administrative regions, fixed 500 m grid, boundary-area weighting.
NoData is not zero. All statistics use the common edition-wide >=90% valid cells.
The 500 m source-cell average can mix land just outside an administrative edge.
"""
from pathlib import Path
import json,hashlib,math
import numpy as np
import rasterio
from rasterio.warp import reproject,Resampling
from rasterio.transform import from_origin
import shapely
from shapely.geometry import shape
from shapely.ops import transform
from boundaries import ROOT,REGIONS,PROJECT,load
EDITION=ROOT/'data/metadata/edition.json'
YEARS=json.loads(EDITION.read_text(encoding='utf-8'))['years'] if EDITION.exists() else list(range(2015,2024))
CELL=500;MIN_VALID=.9

def weighted_stats(v,w,common):
    w=np.where(common,w,0).astype('f8');valid=w>0
    a=v[:,valid].astype('f8');weights=w[valid];total=weights.sum()
    m=(a*weights).sum(axis=1)/total;d=a[-1]-a[0]
    return {'means':m.tolist(),'change':float(m[-1]-m[0]),'percent_change':float((m[-1]/m[0]-1)*100),'first2_last2_pct':float((m[-2:].mean()/m[:2].mean()-1)*100),'observed_area_km2':float(total/1e6),'cells':int(valid.sum()),'increased_area_pct':float(weights[d>0].sum()/total*100),'decreased_area_pct':float(weights[d<0].sum()/total*100),'unchanged_area_pct':float(weights[d==0].sum()/total*100)}

def build():
    fs=load();out=ROOT/'data/processed';facts={'years':YEARS,'units':'nW/cm²/sr','cell_m':CELL,'crs':'EPSG:32652','valid_fraction_min':MIN_VALID,'boundary_date':'2023-12-31','scope':'All polygon components of Seoul, Busan and Jeju in the pinned SGIS-derived boundary dataset','method':f'Area-weighted means of 500 m cells intersecting fixed boundaries. Same cells in all {len(YEARS)} years, >=90% source-valid area each year. Cell-level averages can include land outside the administrative edge. Coverage is grid-based, not a source quality-band statistic.','regions':{},'source_crops':[]}
    for region,(_,name,_) in REGIONS.items():
        feature=next(f for f in fs if f['properties']['region']==region and f['properties']['level']=='region');g=transform(PROJECT,shape(feature['geometry']))
        west,south,east,north=g.bounds;x0=math.floor(west/CELL)*CELL-CELL;y0=math.floor(south/CELL)*CELL-CELL;x1=math.ceil(east/CELL)*CELL+CELL;y1=math.ceil(north/CELL)*CELL+CELL
        nx,ny=round((x1-x0)/CELL),round((y1-y0)/CELL);grid=from_origin(x0,y1,CELL,CELL)
        xx,yy=np.meshgrid(x0+np.arange(nx)*CELL,y1-(np.arange(ny)+1)*CELL)
        boxes=shapely.box(xx,yy,xx+CELL,yy+CELL);weight=shapely.area(shapely.intersection(boxes,g));weight=np.where(weight>1e-6,weight,0)
        assert abs(weight.sum()-g.area)<1, 'Boundary area conservation failed'
        fields=[];fractions=[]
        for year in YEARS:
            p=ROOT/'data/source'/f'{region}_{year}_source.tif'
            with rasterio.open(p) as src:
                pixels=src.read(1);valid=(pixels!=src.nodata)&np.isfinite(pixels)
                dst=np.full((ny,nx),np.nan,np.float32);fraction=np.zeros((ny,nx),np.float32)
                args=dict(src_transform=src.transform,src_crs=src.crs,dst_transform=grid,dst_crs='EPSG:32652',resampling=Resampling.average)
                reproject(pixels,dst,src_nodata=src.nodata,dst_nodata=np.nan,**args)
                reproject(valid.astype('f4'),fraction,**args)
                fields.append(dst);fractions.append(fraction)
            facts['source_crops'].append({'region':region,'year':year,'file':str(p.relative_to(ROOT)),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
        r=np.stack(fields);coverage=np.stack(fractions);common=np.isfinite(r).all(axis=0)&(coverage.min(axis=0)>=MIN_VALID)&(weight>0)
        assert np.nanmin(r)>=0 and common.any()
        base=weighted_stats(r,weight,common);base.update({'name':name,'full_name':REGIONS[region][2],'boundary_area_km2':float(g.area/1e6),'coverage_pct':float(base['observed_area_km2']/(g.area/1e6)*100),'shape':[ny,nx],'bounds_utm':[x0,y0,x1,y1],'bounds_lonlat':list(shape(feature['geometry']).bounds),'total_intersecting_cells':int((weight>0).sum()),'districts':[]})
        weights=[]
        for f in [f for f in fs if f['properties']['region']==region and f['properties']['level']=='district']:
            dg=transform(PROJECT,shape(f['geometry']));dw=shapely.area(shapely.intersection(boxes,dg));dw=np.where(dw>1e-6,dw,0);weights.append(dw)
            ds=weighted_stats(r,dw,common);ds.update({'name':f['properties']['name'],'code':f['properties']['code'],'boundary_area_km2':dg.area/1e6,'coverage_pct':ds['observed_area_km2']/(dg.area/1e6)*100});base['districts'].append(ds)
        partition=np.stack(weights).sum(axis=0)
        base['district_area_sum_error_m2']=float(abs(partition-weight).sum())
        assert np.allclose(partition,weight,atol=1),'Districts do not partition the region'
        dweights=np.array([d['observed_area_km2'] for d in base['districts']]);dm=np.array([d['means'] for d in base['districts']]);assert np.allclose((dm*dweights[:,None]).sum(axis=0)/dweights.sum(),base['means'],rtol=1e-9)
        # Descriptive sign/magnitude sensitivity, not measurement-error calibration.
        delta=r[-1].astype('f8')-r[0].astype('f8')
        valid_weights=np.where(common,weight,0).astype('f8')
        base['decrease_threshold_sensitivity']={
            str(threshold):{
                'threshold_nW_cm2_sr':threshold,
                'decreased_area_pct':float(valid_weights[delta < -threshold].sum()/valid_weights.sum()*100),
                'within_plus_minus_threshold_area_pct':float(valid_weights[np.abs(delta)<=threshold].sum()/valid_weights.sum()*100),
            }
            for threshold in [0,.5,1,2]
        }
        base['decrease_threshold_sensitivity_note']='Descriptive magnitude thresholds only; not sensor uncertainty limits, statistical significance, or confidence intervals. The reported decrease proportion uses delta < 0.'
        # Coverage threshold sensitivity; not a confidence interval.
        base['coverage_sensitivity']={}
        for threshold in [.5,.9,.99]:
            cm=np.isfinite(r).all(axis=0)&(coverage.min(axis=0)>=threshold)&(weight>0)
            st=weighted_stats(r,weight,cm);base['coverage_sensitivity'][str(threshold)]={'percent_change':st['percent_change'],'observed_area_km2':st['observed_area_km2']}
        np.savez_compressed(out/f'{region}_series.npz',radiance=np.where(common[None],r,np.nan),raw_500m=r,common=common,weight=weight,valid_fraction=coverage,years=YEARS,transform=np.array(grid),district_weights=np.stack(weights))
        facts['regions'][region]=base
        print(region, 'shape',r.shape, 'mean',base['means'][0],base['means'][-1],'change%',base['percent_change'],'coverage%',base['coverage_pct'],'decrease%',base['decreased_area_pct'],flush=True)
    (out/'facts.json').write_text(json.dumps(facts,ensure_ascii=False,indent=2),encoding='utf-8');return facts
if __name__=='__main__':build()
