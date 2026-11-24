import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
function appFunction(name) {
  const start = source.search(new RegExp(`^  (?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  const next = source.slice(start + 1).search(/^  (?:async )?function /m);
  assert.ok(next >= 0, name);
  return source.slice(start, start + 1 + next);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a,b) => {resolve=a; reject=b;});
  return {promise,resolve,reject};
}
function harness() {
  const nodes = new Map();
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, {value:'',textContent:'',attributes:{},
      setAttribute(k,v) {this.attributes[k]=v;}, querySelector() {return $('pair-note');}, scrollIntoView() {}});
    return nodes.get(id);
  };
  const regions = ['seoul','busan'].map(id => ({id,label:id,districts:[],webgl:{}}));
  const state = {data:{years:[2015,2016,2017,2018,2019,2020,2021,2022,2023],regions},
    region:'seoul',compare:true,compareA:2015,compareB:2023,yearIndex:8,placeStory:'current-case'};
  const pending = [], commits = [], announcements = [];
  const context = vm.createContext({$,state,pendingComparison:null,yearRequest:0,
    playback:{stop(){}},syncPlayback(){},periodName:y=>`${y}년`,
    region:()=>regions.find(r=>r.id===state.region),label:r=>r.label,
    year:()=>state.data.years[state.yearIndex],yearIndex:y=>state.data.years.indexOf(y),
    leaveGuide(){},clearPlaceStory(){state.placeStory=null;},
    render(){commits.push({region:state.region,a:state.compareA,b:state.compareB,index:state.yearIndex});return Promise.resolve(true);},
    prepareComparison(r,a,b){const p=deferred();pending.push({...p,region:r.id,a,b});return p.promise;},
    reducedMotion:{matches:true},announce:m=>announcements.push(m),cancelYearPresentation(){},
  });
  vm.runInContext(['syncComparisonControls','cancelPendingComparison','stopPlay','setComparison',
    'setRegion','toggleComparison'].map(appFunction).join('\n'),context);
  context.syncComparisonControls();
  return {context,state,$,pending,commits,announcements};
}

test('a slow new pair preserves the visible pair, numbers and case until both frames are ready', async () => {
  const h=harness();
  h.$('compare-a').value='2017'; // native select changes before its event handler
  const p=h.context.setComparison('a','2017');
  assert.deepEqual([h.state.compareA,h.state.compareB,h.state.yearIndex],[2015,2023,8]);
  assert.equal(h.state.placeStory,'current-case');
  assert.equal(h.$('compare-a').value,'2015');
  assert.equal(h.$('pair-controls').attributes['aria-busy'],'true');
  assert.match(h.$('pair-note').textContent,/2017년.*2023년.*현재 두 관측/);
  assert.equal(h.commits.length,0);
  h.pending[0].resolve(); assert.equal(await p,true);
  assert.deepEqual(h.commits,[{region:'seoul',a:2017,b:2023,index:8}]);
  assert.equal(h.state.placeStory,null);
  assert.equal(h.$('compare-a').value,'2017');
  assert.equal(h.$('pair-controls').attributes['aria-busy'],'false');
});

test('rapid choices of A and B combine into the last requested pair without stale commits', async () => {
  const h=harness();
  const first=h.context.setComparison('a',2016), last=h.context.setComparison('b',2021);
  assert.deepEqual(h.pending.map(p=>[p.a,p.b]),[[2016,2023],[2016,2021]]);
  h.pending[0].resolve(); assert.equal(await first,false);
  assert.equal(h.commits.length,0);
  assert.equal(h.$('pair-controls').attributes['aria-busy'],'true');
  h.pending[1].resolve(); await last;
  assert.deepEqual(h.commits,[{region:'seoul',a:2016,b:2021,index:6}]);
});

test('leaving the region cancels a waiting pair before it can replace the new region', async () => {
  const h=harness(), p=h.context.setComparison('b',2018);
  h.context.setRegion('busan');
  const before=structuredClone(h.commits);
  h.pending[0].resolve(); assert.equal(await p,false);
  assert.equal(h.state.region,'busan');
  assert.deepEqual(h.commits,before);
  assert.equal(h.state.compareB,2023);
});

test('comparison off retains the currently displayed B rather than a still-loading request', async () => {
  const h=harness(),p=h.context.setComparison('b',2018);
  h.context.toggleComparison();
  h.pending[0].resolve(); assert.equal(await p,false);
  assert.equal(h.state.compare,false);
  assert.equal(h.state.compareB,2023);
  assert.equal(h.state.yearIndex,8);
  assert.equal(h.$('pair-controls').attributes['aria-busy'],'false');
});

test('failed preparation preserves the old scene and permits an identical retry', async () => {
  const h=harness(),p=h.context.setComparison('b',2018);
  h.pending[0].reject(new Error('offline')); assert.equal(await p,false);
  assert.equal(h.commits.length,0);
  assert.equal(h.state.compareB,2023);
  assert.equal(h.state.placeStory,'current-case');
  assert.equal(h.$('compare-b').value,'2023');
  assert.match(h.$('pair-note').textContent,/이전 비교를 유지/);
  assert.equal(h.announcements.length,1);
  const retry=h.context.setComparison('b',2018);
  h.pending[1].resolve(); assert.equal(await retry,true);
  assert.equal(h.state.compareB,2018);
});

test('an old failure cannot replace the state or status of a newer successful choice', async () => {
  const h=harness(),first=h.context.setComparison('a',2016),last=h.context.setComparison('b',2018);
  h.pending[1].resolve(); await last;
  const note=h.$('pair-note').textContent;
  h.pending[0].reject(new Error('late failure')); assert.equal(await first,false);
  assert.equal(h.$('pair-note').textContent,note);
  assert.equal(h.announcements.length,0);
  assert.equal(h.commits.length,1);
  assert.deepEqual([h.state.compareA,h.state.compareB],[2016,2018]);
});

test('replaced editions and unobserved selections cannot receive an old comparison', async () => {
  const h=harness();
  assert.equal(await h.context.setComparison('a',2026),false);
  assert.equal(h.pending.length,0);
  const p=h.context.setComparison('b',2018);
  h.context.cancelPendingComparison();
  h.state.data={...h.state.data,years:[2025,2026]};
  h.pending[0].resolve(); assert.equal(await p,false);
  assert.equal(h.commits.length,0);
});

test('selecting back to the committed pair cancels the queued change without redrawing', async () => {
  const h=harness(),p=h.context.setComparison('a',2017);
  assert.equal(await h.context.setComparison('a',2015),true);
  h.pending[0].resolve(); assert.equal(await p,false);
  assert.equal(h.commits.length,0);
  assert.equal(h.$('pair-controls').attributes['aria-busy'],'false');
});

test('pair preparation loads both absolute frames or both fallback images without changing presentation', async () => {
  const loads=[];
  const context=vm.createContext({webglUnavailable:false,rendererUnavailable:false,
    viewerModule:async()=>({preloadFrame:async(r,y,m)=>loads.push(['3d',r.id,y,m])}),
    prepareImage:async url=>loads.push(['image',url]), imagePath:(r,y,m)=>`${r.id}/${m}/${y}.webp`});
  vm.runInContext(appFunction('prepareComparison'),context);
  await context.prepareComparison({id:'seoul',webgl:{}},2017,2019);
  assert.deepEqual(loads,[['3d','seoul',2017,'absolute'],['3d','seoul',2019,'absolute']]);
  loads.length=0;context.rendererUnavailable=true;
  await context.prepareComparison({id:'seoul',webgl:{}},2017,2019);
  assert.deepEqual(loads,[['image','seoul/absolute/2017.webp'],['image','seoul/absolute/2019.webp']]);
});
