"""Shared nonlinear height scale, full-boundary display, 8 interpolants per year.
Interpolated surfaces/frames are display geometry, never additional observations.
"""
import argparse,json
import numpy as np
import shapely
from shapely.geometry import shape
from shapely.ops import transform
from scipy.ndimage import map_coordinates
import contourpy
from boundaries import ROOT,REGIONS,PROJECT,load
STEPS=8
ABS_SCALE=2.8/np.log(101)
CHANGE_SCALE=1.6/np.arcsinh(10)
def contour_levels(mode):
    """Matched positive/negative thresholds: sign must not alter visibility."""
    if mode == 'absolute':
        return np.arange(.055, 4.8, .055)
    if mode != 'change':
        raise ValueError(f'Unknown display mode: {mode}')
    positive = np.arange(1, 61, dtype='f8') * .055
    return np.concatenate((-positive[::-1], positive))

def build(regions=None,modes=None,annual_only=False):
    out=ROOT/'cache/geometry';out.mkdir(parents=True,exist_ok=True);fs=load()
    for region in regions or REGIONS:
        a=np.load(ROOT/f'data/processed/{region}_series.npz');r=a['radiance'];common=a['common'];t=a['transform'];ny,nx=common.shape
        # Preserve metric aspect ratio; each separate plate is fitted to a 10-unit span.
        width,height=nx*500,ny*500;scale=10/max(width,height);cx=t[2]+width/2;cy=t[5]-height/2
        x=t[2]+(np.arange(nx*3)+.5)*500/3;y=t[5]-(np.arange(ny*3)+.5)*500/3;xx,yy=np.meshgrid(x,y)
        coords=np.array([(t[5]-yy)/500-.5,(xx-t[2])/500-.5]);g=transform(PROJECT,shape(next(f for f in fs if f['properties']['region']==region and f['properties']['level']=='region')['geometry']))
        inside=shapely.contains_xy(g,xx,yy);observed=map_coordinates(common.astype('f4'),coords,order=0,mode='nearest')>.5;visible=inside&observed
        denom=map_coordinates(common.astype('f4'),coords,order=1,mode='nearest')
        fields=np.stack([np.divide(map_coordinates(np.nan_to_num(v),coords,order=1,mode='nearest'),denom,out=np.zeros_like(denom),where=denom>1e-6) for v in r])
        wx=(x-cx)*scale;wy=(y-cy)*scale;X,Y=np.meshgrid(wx,wy);N=X.shape[1]
        valid=visible[:-1,:-1]&visible[:-1,1:]&visible[1:,:-1]&visible[1:,1:];j,i=np.nonzero(valid);q=j*N+i;faces=np.column_stack([q,q+N,q+N+1,q+1])
        allxy=np.column_stack([X.ravel(),Y.ravel()]);used,inv=np.unique(faces,return_inverse=True);meshxy=allxy[used];meshfaces=inv.reshape(-1,4)
        outlines=[];districts=[]
        for f in fs:
            if f['properties']['region']!=region:continue
            fg=transform(PROJECT,shape(f['geometry']));target=outlines if f['properties']['level']=='region' else districts
            for poly in (fg.geoms if hasattr(fg,'geoms') else [fg]):
                for ring in [poly.exterior,*poly.interiors]:
                    pts=np.asarray(ring.coords);target.append(np.column_stack([(pts[:,0]-cx)*scale,(pts[:,1]-cy)*scale]))
        # Constrained polygon triangulation gives a real base for every island,
        # including islands too small for a reliable 500 m radiance observation.
        tri=shapely.constrained_delaunay_triangles(g)
        base=np.concatenate([np.asarray(p.exterior.coords)[:3] for p in tri.geoms]);base[:,0]=(base[:,0]-cx)*scale;base[:,1]=(base[:,1]-cy)*scale
        np.savez_compressed(out/f'{region}_static.npz',xy=meshxy,faces=meshfaces,base=base,width=width*scale,height=height*scale,scale=scale,used=used)
        (out/f'{region}_lines.json').write_text(json.dumps({'outlines':[v.tolist() for v in outlines],'districts':[v.tolist() for v in districts]},separators=(',',':')),encoding='utf-8')
        selected_modes=modes or ['absolute','change']
        for mode in selected_modes:
            for idx in range(0,(len(fields)-1)*STEPS+1,STEPS if annual_only else 1):
                u=idx/STEPS;k=min(len(fields)-2,int(u));alpha=u-k;v=fields[k]*(1-alpha)+fields[k+1]*alpha
                h=ABS_SCALE*np.log1p(v) if mode=='absolute' else CHANGE_SCALE*np.arcsinh((v-fields[0])/4)
                hm=np.ma.array(h,mask=~visible)
                c=contourpy.contour_generator(x=wx,y=wy,z=hm,corner_mask=False)
                points=[];lengths=[];zs=[]
                # Equal DISPLAY-height contours (nonlinear in radiance), shared globally.
                for z in contour_levels(mode):
                    for line in c.lines(z):
                        if len(line)>=3:
                            points.append(np.column_stack([line,np.full(len(line),z+.008)]));lengths.append(len(line));zs.append(z)
                np.savez_compressed(out/f'{region}_{mode}_{idx:03}.npz',z=h.ravel()[used].astype('f4'),p=np.concatenate(points).astype('f4') if points else np.empty((0,3),dtype='f4'),n=np.array(lengths,dtype='i4'),levels=np.array(zs,dtype='f4'))
        print(region,'vertices',len(used),'faces',len(faces),'frames',(len(fields) if annual_only else (len(fields)-1)*STEPS+1)*len(selected_modes),flush=True)
    baseline=int(a['years'][0])
    (ROOT/'data/metadata/display_mapping.json').write_text(json.dumps({'absolute_height':'2.8 * log(1 + radiance) / log(101)','change_height':f'1.6 * asinh((radiance - radiance_{baseline}) / 4) / asinh(10)','contour_height_interval':.055,'change_contour_levels':'Symmetric around zero: +/-0.055, +/-0.110, ..., +/-3.300; no zero contour','first_change_contour_radiance_magnitude':float(4*np.sinh(.055/CHANGE_SCALE)),'interpolated_steps_per_year':STEPS,'horizontal':'metric aspect retained; each complete region extent fitted to 10 display units; map sizes are not area comparisons','missing':'no relief; fixed outline/base retained','smoothing':'no Gaussian smoothing; normalized bilinear spatial interpolation within common observed mask','years':'linear value interpolation between supplied observations, display-only; annual-only renders use observed endpoints only'},ensure_ascii=False,indent=2),encoding='utf-8')
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--regions',nargs='+',choices=list(REGIONS));p.add_argument('--modes',nargs='+',choices=['absolute','change']);p.add_argument('--annual-only',action='store_true');a=p.parse_args();build(a.regions,a.modes,a.annual_only)
