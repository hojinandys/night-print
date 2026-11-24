import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createPlaybackSpeed } from '../dist/playback-speed.mjs';
const source=readFileSync(new URL('../dist/app.js',import.meta.url),'utf8');
function appFunction(name){
  const start=source.search(new RegExp(`^  (?:async )?function ${name}\\(`,'m'));
  assert.ok(start>=0);const next=source.slice(start+1).search(/^  (?:async )?function /m);
  assert.ok(next>=0);return source.slice(start,start+1+next);
}
function harness({all=false,reduced=false}={}){
  let resolve,reject;const animation=new Promise((a,b)=>{resolve=a;reject=b;});
  const nodes=new Map(), $=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',attrs:{},setAttribute(k,v){this.attrs[k]=v;},removeAttribute(k){delete this.attrs[k];}});return nodes.get(id);};
  const state={data:{years:[2015,2016,2023]},region:all?'all':'seoul',mode:'absolute',compare:false,yearIndex:2};
  const commits=[],paths=[],durations=[],playbackSpeed=createPlaybackSpeed();
  const context=vm.createContext({$,state,yearRequest:4,pendingYearPresentation:null,
    playbackSpeed,
    reducedMotion:{matches:reduced},viewerReady:true,webglUnavailable:false,rendererUnavailable:false,
    year:()=>state.data.years[state.yearIndex],region:()=>({id:state.region}),periodLabel:String,periodName:y=>`${y}년`,
    viewer:{transitionTo(r,y,m,options){paths.push(['3d',r.id,y,m]);durations.push(options.duration);return animation;},cancelSurfaceTransition(){resolve(false);}},
    fadeYearImages(i,pending){paths.push(['image',i]);durations.push(pending.timing.imageMs);return animation;},
    renderHeading(){$('scene-year').textContent=String(state.data.years[state.yearIndex]);},
    render(){commits.push(state.yearIndex);return Promise.resolve(true);},
  });
  vm.runInContext([appFunction('cancelYearPresentation'),appFunction('presentYear')].join('\n'),context);
  return {context,state,$,commits,paths,resolve,reject,durations,playbackSpeed};
}
test('3D rewind shows both endpoint years and commits numbers only after motion finishes',async()=>{
  const h=harness(),completion=h.context.presentYear(0,4);
  assert.equal(h.state.yearIndex,2);assert.equal(h.$('scene-year').textContent,'2023 → 2015');
  assert.match(h.$('timeline-caption').textContent,/수치는 2023년 관측/);assert.deepEqual(h.commits,[]);
  h.resolve(true);assert.equal(await completion,true);assert.deepEqual(h.commits,[0]);
  assert.equal(h.context.pendingYearPresentation,null);
  assert.equal(h.$('artwork').attrs['data-observation-transition'],undefined);
});
test('three-region overview waits for its crossfade before any new values are committed',async()=>{
  const h=harness({all:true}),completion=h.context.presentYear(1,4);
  assert.deepEqual(h.paths,[['image',1]]);assert.equal(h.state.yearIndex,2);
  h.resolve(true);assert.equal(await completion,true);assert.deepEqual(h.commits,[1]);
});
test('Stop during a transition restores the actual previous year and cannot later commit',async()=>{
  const h=harness(),completion=h.context.presentYear(0,4);
  h.context.yearRequest++;h.context.cancelYearPresentation();
  assert.equal(await completion,false);assert.equal(h.state.yearIndex,2);assert.deepEqual(h.commits,[]);
  assert.equal(h.$('scene-year').textContent,'2023');
});
test('a late transition result after switching region cannot overwrite the new scene',async()=>{
  const h=harness(),completion=h.context.presentYear(0,4);
  h.context.yearRequest++;h.context.cancelYearPresentation();h.state.region='busan';
  h.resolve(true);assert.equal(await completion,false);assert.deepEqual(h.commits,[]);
});
test('reduced motion presents the exact observed endpoint with no intermediate animation',async()=>{
  const h=harness({reduced:true});assert.equal(await h.context.presentYear(1,4),true);
  assert.deepEqual(h.paths,[]);assert.deepEqual(h.commits,[1]);
});
test('a failed transition clears its range label and retains the previous actual observation',async()=>{
  const h=harness(),completion=h.context.presentYear(0,4);
  h.reject(new Error('geometry unavailable'));await assert.rejects(completion,/geometry unavailable/);
  assert.equal(h.state.yearIndex,2);assert.equal(h.$('scene-year').textContent,'2023');
  assert.equal(h.context.pendingYearPresentation,null);assert.deepEqual(h.commits,[]);
});
test('a speed change during a manual year transition keeps that animation and the committed year intact',async()=>{
  const h=harness(),completion=h.context.presentYear(0,4);
  assert.deepEqual(h.durations,[2200]);
  h.playbackSpeed.set(0.25);
  assert.equal(h.context.pendingYearPresentation.timing.surfaceMs,2200);
  assert.equal(h.state.yearIndex,2);
  h.resolve(true);assert.equal(await completion,true);
  assert.deepEqual(h.commits,[0]);
  assert.equal(await h.context.presentYear(1,4),true);
  assert.deepEqual(h.durations,[2200,4400]);
  assert.deepEqual(h.commits,[0,1]);
});
test('the overview follows the same speed selection as a regional 3D scene',async()=>{
  const h=harness({all:true});h.playbackSpeed.set(0.25);
  const completion=h.context.presentYear(1,4);
  assert.deepEqual(h.durations,[3400]);
  h.resolve(true);assert.equal(await completion,true);
});
test('all overview images receive the same snapshotted fade duration',async()=>{
  const durations=[],regions=[{id:'seoul'},{id:'busan'},{id:'jeju'}];
  const images=regions.map(()=>({parentElement:{append(){}},animate(){},cloneNode(){return {
    style:{},removeAttribute(){},setAttribute(){},animate(frames,options){durations.push(options.duration);return {finished:Promise.resolve()};},
  };}}));
  const context=vm.createContext({state:{region:'all',data:{regions,years:[2015,2023]},mode:'absolute'},
    $:()=>({querySelectorAll:()=>images}),imagePath:(r,y)=>`${r.id}/${y}.png`});
  vm.runInContext(appFunction('fadeYearImages'),context);
  const pending={animations:[],overlays:[],timing:createPlaybackSpeed().timing()};
  assert.equal(await context.fadeYearImages(1,pending),true);
  assert.deepEqual(durations,[1700,1700,1700]);
  assert.equal(pending.overlays.length,3);
});
