import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
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
  const commits=[],paths=[];
  const context=vm.createContext({$,state,yearRequest:4,pendingYearPresentation:null,
    reducedMotion:{matches:reduced},viewerReady:true,webglUnavailable:false,rendererUnavailable:false,
    year:()=>state.data.years[state.yearIndex],region:()=>({id:state.region}),periodLabel:String,periodName:y=>`${y}년`,
    viewer:{transitionTo(r,y,m){paths.push(['3d',r.id,y,m]);return animation;},cancelSurfaceTransition(){resolve(false);}},
    fadeYearImages(i){paths.push(['image',i]);return animation;},
    renderHeading(){$('scene-year').textContent=String(state.data.years[state.yearIndex]);},
    render(){commits.push(state.yearIndex);return Promise.resolve(true);},
  });
  vm.runInContext([appFunction('cancelYearPresentation'),appFunction('presentYear')].join('\n'),context);
  return {context,state,$,commits,paths,resolve,reject};
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
