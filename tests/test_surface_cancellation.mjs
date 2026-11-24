import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { compatibleSurface, createSurfaceTransition } from '../dist/surface-transition.mjs';

const source=readFileSync(new URL('../dist/viewer3d.js',import.meta.url),'utf8');
function method(name){
  const start=source.search(new RegExp(`^  (?:async )?${name}\\(`,'m'));
  assert.ok(start>=0);const next=source.slice(start+1).search(/^  (?:async )?[a-zA-Z]+\(/m);
  return source.slice(start,start+1+next).trim();
}
class Group {
  constructor(){this.children=[];}
  add(item){item.parent?.remove(item);this.children.push(item);item.parent=this;}
  remove(item){this.children=this.children.filter(x=>x!==item);item.parent=null;}
  clear(){for(const item of [...this.children])this.remove(item);}
  traverse(fn){fn(this);for(const item of this.children)fn(item);}
}
function disposeGroup(group){group.traverse(item=>{item.geometry?.dispose();item.material?.dispose();});group.clear();}
function body(frame){
  const attributes={position:{array:new Float32Array([0,0,frame.z[0]])},normal:{array:new Float32Array([0,0,1])}};
  return {isMesh:true,visible:true,geometry:{morphAttributes:{},getAttribute:k=>attributes[k],computeBoundingBox(){},computeBoundingSphere(){},dispose(){this.disposed=true;}},
    material:{dispose(){}},updateMorphTargets(){this.morphTargetInfluences=[0];}};
}
test('cancelling then choosing another year disposes the cached morph geometry before reuse',async()=>{
  const frames={a:{z:new Float32Array([1])},b:{z:new Float32Array([2])},c:{z:new Float32Array([9])}};
  const region={id:'test',webgl:{static_url:'base',frames:{absolute:[{year:2015,url:'a'},{year:2016,url:'b'},{year:2019,url:'c'}]}}};
  const viewer={regionId:'test',mode:'absolute',spec:region.webgl,base:{xy:new Float32Array([0,0])},frame:frames.a,year:2015,
    active:true,reduced:{matches:false},dynamic:new Group(),scene:new Group(),sampler:{height:()=>1},markerLayer:{},
    canvas:{getAttribute:()=> '2015 actual',setAttribute(){}},projectMarkers(){},
    buildSurface(group,base,frame){disposeGroup(group);group.add(body(frame));},
  };
  viewer.buildSurface(viewer.dynamic,viewer.base,viewer.frame);
  const oldGeometry=viewer.dynamic.children[0].geometry;
  const context=vm.createContext({viewer,THREE:{Group},packet:async url=>frames[url],surfaceSampler:()=>({height:()=>0}),
    compatibleSurface,createSurfaceTransition,disposeGroup,performance:{now:()=>0}});
  vm.runInContext(`Object.assign(viewer,{${method('cancelSurfaceTransition')},${method('transitionTo')}})`,context);
  const first=viewer.transitionTo(region,2016,'absolute');for(let i=0;i<8;i++)await Promise.resolve();
  assert.ok(viewer.surfaceMotion);viewer.surfaceMotion.tick(400);viewer.cancelSurfaceTransition();
  assert.equal(await first,false);assert.equal(oldGeometry.disposed,true);
  const restored=viewer.dynamic.children[0];assert.notEqual(restored.geometry,oldGeometry);
  assert.equal(restored.geometry.getAttribute('position').array[2],1,'Stop restores the exact previous observation');
  const second=viewer.transitionTo(region,2019,'absolute');for(let i=0;i<8;i++)await Promise.resolve();
  assert.equal(restored.geometry.morphAttributes.position[0].array[2],9,'The next transition uses the newly requested destination');
  viewer.surfaceMotion.tick(1100);assert.equal(await second,true);
  assert.equal(viewer.dynamic.children[0].geometry.getAttribute('position').array[2],9);
  assert.equal(viewer.surfacePendingCommit,true,'Markers stay hidden until the app commits matching numbers');
});
test('an incompatible observed footprint forwards the selected speed to its geometry fade',async()=>{
  const calls=[],region={id:'test',webgl:{static_url:'base',frames:{absolute:[{year:2016,url:'next'}]}}};
  const viewer={regionId:'test',mode:'absolute',spec:region.webgl,year:2015,active:true,reduced:{matches:false},
    cancelSurfaceTransition(){this.surfaceGeneration=(this.surfaceGeneration||0)+1;},
    crossfadeSurface(target,year,options){calls.push({year,duration:options.duration});return Promise.resolve(true);}};
  const context=vm.createContext({viewer,packet:async()=>({}),compatibleSurface:()=>false});
  vm.runInContext(`Object.assign(viewer,{${method('transitionTo')}})`,context);
  assert.equal(await viewer.transitionTo(region,2016,'absolute',{duration:4400}),true);
  assert.deepEqual(calls,[{year:2016,duration:2800}]);
});
test('the geometry fade finishes only after its requested speed-controlled duration',async()=>{
  const viewer={year:2015,base:{},dynamic:new Group(),scene:new Group(),markerLayer:{},
    canvas:{getAttribute:()=> '2015 actual',setAttribute(){}},projectMarkers(){},
    buildSurface(group){group.add({material:{opacity:1,transparent:false,depthWrite:true,dispose(){}}});},
  };
  viewer.buildSurface(viewer.dynamic);
  const context=vm.createContext({viewer,THREE:{Group},createSurfaceTransition,disposeGroup,performance:{now:()=>0}});
  vm.runInContext(`Object.assign(viewer,{${method('crossfadeSurface')}})`,context);
  let complete=false;
  const completion=viewer.crossfadeSurface({},2016,{duration:2800}).then(value=>{complete=true;return value;});
  viewer.surfaceMotion.tick(2799);await Promise.resolve();
  assert.equal(complete,false);assert.equal(viewer.surfacePendingCommit,undefined);
  viewer.surfaceMotion.tick(2800);
  assert.equal(await completion,true);assert.equal(viewer.surfacePendingCommit,true);
});
