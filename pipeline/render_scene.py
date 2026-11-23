"""Cycles relief sculptures for complete administrative regions."""
import bpy,sys,argparse,math,json,time
import numpy as np
from pathlib import Path
from mathutils import Vector
ROOT=Path(__file__).resolve().parents[1]
BASELINE=json.loads((ROOT/'data/processed/facts.json').read_text(encoding='utf-8'))['years'][0]
sys.path.insert(0,str(ROOT/'pipeline'))
import render_cache
p=argparse.ArgumentParser();p.add_argument('--cpu',action='store_true');p.add_argument('--regions',nargs='+',default=['seoul','busan','jeju']);p.add_argument('--modes',nargs='+',default=['absolute','change']);p.add_argument('--indices',nargs='+',type=int);p.add_argument('--size',type=int,default=1920);p.add_argument('--samples',type=int,default=24);p.add_argument('--save',action='store_true');p.add_argument('--out',type=Path,default=ROOT/'cache/renders')
a=p.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []);a.out.mkdir(parents=True,exist_ok=True)

def material(name,color,metal=.5,rough=.35,emit=0):
    m=bpy.data.materials.new(name);m.diffuse_color=(*color,1);m.use_nodes=True;b=m.node_tree.nodes['Principled BSDF']
    for k,v in [('Base Color',(*color,1)),('Metallic',metal),('Roughness',rough),('Emission Color',(*color,1)),('Emission Strength',emit)]:b.inputs[k].default_value=v
    return m

def curves(name,paths,mat,radius,z=0):
    c=bpy.data.curves.new(name,'CURVE');c.dimensions='3D';c.bevel_depth=radius;c.bevel_resolution=1
    for pts in paths:
        if len(pts)<2:continue
        xy=np.asarray(pts);sp=c.splines.new('POLY');sp.points.add(len(xy)-1);co=np.ones((len(xy),4));co[:,:2]=xy[:,:2];co[:,2]=z;sp.points.foreach_set('co',co.ravel())
    o=bpy.data.objects.new(name,c);bpy.context.collection.objects.link(o);c.materials.append(mat);return o

for region in a.regions:
 for mode in a.modes:
    bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
    for blocks in [bpy.data.meshes,bpy.data.curves,bpy.data.materials,bpy.data.lights,bpy.data.cameras]:
        for block in list(blocks):
            if block.users==0:blocks.remove(block)
    s=bpy.context.scene;s.render.engine='CYCLES';s.cycles.samples=a.samples;s.cycles.use_denoising=True
    try:
        if a.cpu:raise RuntimeError('CPU explicitly selected')
        prefs=bpy.context.preferences.addons['cycles'].preferences;prefs.compute_device_type='METAL';prefs.get_devices()
        for d in prefs.devices:d.use=d.type=='METAL'
        s.cycles.device='GPU'
    except Exception as e:s.cycles.device='CPU';print('CPU fallback',e)
    s.render.resolution_x=a.size;s.render.resolution_y=round(a.size*9/16);s.render.resolution_percentage=100;s.render.image_settings.file_format='PNG';s.render.image_settings.color_mode='RGB';s.render.image_settings.compression=15
    s.world.use_nodes=True;s.world.node_tree.nodes['Background'].inputs['Color'].default_value=(.018,.023,.035,1);s.world.node_tree.nodes['Background'].inputs['Strength'].default_value=.19
    s.view_settings.view_transform='AgX';s.view_settings.look='AgX - Medium High Contrast'
    body=material('Obsidian bronze',(.028,.019,.012),.72,.34)
    edge=material('Administrative outline',(.27,.17,.075),.8,.3,.12)
    zero=material(f'{BASELINE} reference',(.22,.3,.36),.5,.4,.1)
    base=material('Boundary / missing observations',(.035,.045,.058),.5,.43)
    floor=material('Charcoal',(.004,.005,.007),.2,.5)
    materials=[]
    for cold in [False,True]:
        for k in range(40):
            t=k/39;color=(.4+.5*t,.16+.65*t,.045+.51*t) if not cold else (.16+.5*t,.38+.48*t,.64+.32*t)
            materials.append(material(('cold' if cold else 'gold')+str(k),color,.35,.27,.18+1.15*t*t))
    st=np.load(ROOT/f'cache/geometry/{region}_static.npz');xy=st['xy'];verts=np.column_stack([xy,np.zeros(len(xy))]);faces=st['faces']
    me=bpy.data.meshes.new('500 m radiance interpolated display');me.from_pydata(verts,[],faces);me.update();ob=bpy.data.objects.new(region+' '+mode,me);bpy.context.collection.objects.link(ob);me.materials.append(body)
    for face in me.polygons:face.use_smooth=True
    lines=json.loads((ROOT/f'cache/geometry/{region}_lines.json').read_text(encoding='utf-8'))
    curves('Complete boundary including islands',lines['outlines'],edge if mode=='absolute' else zero,.006,-.06 if mode=='absolute' else 0)
    curves('District boundaries at reference plane',lines['districts'],zero,.002,-.059 if mode=='absolute' else -.004)
    if mode=='absolute':
        vv=np.column_stack([st['base'],np.full(len(st['base']),-.065)]);bm=bpy.data.meshes.new('All boundary components');bm.from_pydata(vv,[],np.arange(len(vv)).reshape(-1,3));bm.update();bo=bpy.data.objects.new('Full region base; flat where missing',bm);bpy.context.collection.objects.link(bo);bm.materials.append(base)
        sol=bo.modifiers.new('Thin cut metal','SOLIDIFY');sol.thickness=.065
    # Quiet fixed rectangular spatial frame: 10 display units on the long side.
    w,h=float(st['width'])/2,float(st['height'])/2
    curves('Extent frame',[[(-w,-h),(w,-h),(w,h),(-w,h),(-w,-h)]],edge if mode=='absolute' else zero,.0035,-.12)
    # North tick at the same geographic location in every frame.
    curves('North marker',[[(-w+.3,h-.75),(-w+.3,h-.2)],[(-w+.2,h-.35),(-w+.3,h-.2),(-w+.4,h-.35)]],zero,.009,-.11)
    bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-1.1 if mode=='absolute' else -2.6));bpy.context.object.data.materials.append(floor)
    def light(name,loc,power,col,size):
        l=bpy.data.lights.new(name,'AREA');l.energy=power;l.color=col;l.shape='DISK';l.size=size;o=bpy.data.objects.new(name,l);bpy.context.collection.objects.link(o);o.location=loc;o.rotation_euler=(Vector((0,0,0))-o.location).to_track_quat('-Z','Y').to_euler()
    light('Amber grazing',(-5,-1,9),1100,(1,.69,.43),9);light('Cool fill',(2,7,8),1400,(.42,.61,1),8);light('Warm rim',(6,1,5),850,(1,.80,.58),5)
    c=bpy.data.cameras.new('Fixed camera');o=bpy.data.objects.new('Camera',c);bpy.context.collection.objects.link(o);s.camera=o;o.location=(11,-16,19);o.rotation_euler=(Vector((0,0,.45 if mode=='absolute' else 0))-o.location).to_track_quat('-Z','Y').to_euler();c.type='ORTHO';c.ortho_scale=18.5;c.shift_y=.015
    s.use_nodes=True;nt=s.node_tree;nt.nodes.clear();rl=nt.nodes.new('CompositorNodeRLayers');gl=nt.nodes.new('CompositorNodeGlare');gl.glare_type='FOG_GLOW';gl.quality='HIGH';gl.threshold=1.8;gl.size=7;gl.mix=-.93;out=nt.nodes.new('CompositorNodeComposite');nt.links.new(rl.outputs['Image'],gl.inputs['Image']);nt.links.new(gl.outputs['Image'],out.inputs['Image'])
    dynamic=None
    available_indices=sorted(int(p.stem.rsplit('_',1)[1]) for p in (ROOT/'cache/geometry').glob(f'{region}_{mode}_*.npz'))
    last_index=max(available_indices)
    for idx in a.indices if a.indices is not None else available_indices:
        dest=a.out/f'{region}_{mode}_{idx:03}.png'
        sig=render_cache.signature(ROOT/'cache/geometry',region,mode,idx,__file__,a.size,a.samples,bpy.app.version_string)
        scene_path=ROOT/f'artwork/{region}_{mode}.blend'
        if render_cache.valid(dest,sig) and (not (a.save and idx==last_index) or scene_path.exists()):continue
        start=time.monotonic();data=np.load(ROOT/f'cache/geometry/{region}_{mode}_{idx:03}.npz');vv=verts.copy();vv[:,2]=data['z'];me.vertices.foreach_set('co',vv.ravel());me.update()
        if dynamic:
            cu=dynamic.data;bpy.data.objects.remove(dynamic,do_unlink=True);bpy.data.curves.remove(cu)
        cu=bpy.data.curves.new('Equal display-height luminous contours','CURVE');cu.dimensions='3D';cu.bevel_depth=.006;cu.bevel_resolution=1
        for m in materials:cu.materials.append(m)
        cursor=0
        for n,z in zip(data['n'],data['levels']):
            pts=data['p'][cursor:cursor+n];cursor+=n;sp=cu.splines.new('POLY');sp.points.add(n-1);co=np.ones((n,4));co[:,:3]=pts;sp.points.foreach_set('co',co.ravel());sp.material_index=(40 if z<0 else 0)+min(39,int(abs(z)/4.2*39))
        dynamic=bpy.data.objects.new('Radiance contours',cu);bpy.context.collection.objects.link(dynamic)
        s.render.filepath=str(dest)
        if a.save and idx==last_index:bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/f'artwork/{region}_{mode}.blend'))
        bpy.ops.render.render(write_still=True);render_cache.record(dest,sig);print('FRAME_DONE',region,mode,idx,round(time.monotonic()-start,2),flush=True)
