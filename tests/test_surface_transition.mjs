import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { compatibleSurface, createSurfaceTransition } from '../dist/surface-transition.mjs';

const base = {xy:new Float32Array([0,0,1,0,1,1,0,1]),faces:new Uint32Array([0,1,2,3])};
const frame = (indices, z=[1,2,3,4]) => ({z:new Float32Array(z),triangles:new Uint32Array(indices)});
const first=frame([0,1,2,0,2,3]), second=frame([0,1,3,1,2,3],[4,3,2,1]);
test('both diagonals of the same convex observed quad are compatible', () => {
  assert.equal(compatibleSurface(first,second,base),true);
  assert.equal(compatibleSurface(first,second),false);
});
test('same used vertices cannot hide an overlapping triangle and missing half-quad', () => {
  assert.equal(compatibleSurface(first,frame([0,1,2,0,1,3]),base),false);
  assert.equal(compatibleSurface(first,frame([0,1,2]),base),false);
  assert.equal(compatibleSurface(first,frame([0,1,2,0,2,3],[1,2,NaN,4]),base),false);
});
test('a concave quad is not treated as two interchangeable diagonal choices', () => {
  assert.equal(compatibleSurface(first,second,{...base,xy:new Float32Array([0,0,1,0,.2,.2,0,1])}),false);
});
test('transition easing reaches exact endpoints and finishes once', async () => {
  const values=[], finishes=[];
  const tween=createSurfaceTransition({start:100,duration:1000,apply:t=>values.push(t),finish:c=>finishes.push(c)});
  tween.tick(100);tween.tick(350);tween.tick(600);tween.tick(850);tween.tick(1100);tween.tick(1200);
  assert.equal(await tween.promise,true);
  assert.equal(values[0],0);assert.equal(values.at(-1),1);assert.equal(values[2],.5);
  assert.ok(values.every((v,i)=>i===0||v>=values[i-1]));assert.deepEqual(finishes,[true]);
});
test('Stop restores an endpoint and late ticks never resurrect cancelled motion', async () => {
  const values=[],finishes=[];
  const tween=createSurfaceTransition({start:0,duration:1000,apply:t=>values.push(t),finish:c=>finishes.push(c)});
  tween.tick(400);tween.cancel();tween.tick(1000);tween.complete();tween.cancel();
  assert.equal(await tween.promise,false);assert.equal(values.length,1);assert.deepEqual(finishes,[false]);
});
test('explicit completion settles immediately at the observed destination', async () => {
  const values=[],finishes=[];
  const tween=createSurfaceTransition({start:0,apply:t=>values.push(t),finish:c=>finishes.push(c)});
  tween.tick(100);tween.complete();
  assert.equal(await tween.promise,true);assert.equal(values.at(-1),1);assert.deepEqual(finishes,[true]);
});

function packet(path) {
  let bytes=readFileSync(path);if(bytes[0]===31&&bytes[1]===139)bytes=gunzipSync(bytes);
  const size=bytes.readUInt32LE(8),start=bytes.readUInt32LE(12),header=JSON.parse(bytes.subarray(16,16+size));
  const result={};
  for(const [name,spec] of Object.entries(header.arrays)){
    const Type={float32:Float32Array,float64:Float64Array,uint32:Uint32Array}[spec.dtype];
    const copy=bytes.subarray(start+spec.byte_offset,start+spec.byte_offset+spec.byte_length);
    result[name]=new Type(Uint8Array.from(copy).buffer);
  }
  return result;
}
test('all shipped annual and monthly adjacent transitions preserve observation coverage', () => {
  let count=0;
  for(const edition of ['../dist/','../dist/recent/']){
    const root=new URL(edition,import.meta.url), manifest=JSON.parse(readFileSync(new URL('data/manifest.json',root)));
    for(const region of manifest.regions){
      const fixed=packet(new URL(region.webgl.static_url,root));
      for(const mode of ['absolute','change']){
        const frames=region.webgl.frames[mode].map(item=>packet(new URL(item.url,root)));
        for(let i=1;i<frames.length;i++){assert.equal(compatibleSurface(frames[i-1],frames[i],fixed),true,`${region.id} ${mode} ${i}`);count++;}
      }
    }
  }
  assert.ok(count >= 6, 'Every region and observation mode has an adjacent pair');
});
