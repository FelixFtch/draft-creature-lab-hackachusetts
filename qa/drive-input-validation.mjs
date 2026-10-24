import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createDriveInput } from '../play/src/drive-input.js';

const results=[];
async function test(name,run){await run();results.push({name,pass:true});}
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function harness({active=false,vision=false,delayed=false}={}) {
  const state={modelId:'flower-1',walking:{active,loading:false},vision:{active:vision}};
  let allowed=true,loadEpoch=0,gate=delayed?deferred():null;
  const calls=[],pending=[],errors=[];let invalidations=0;
  const lab={
    snapshot:()=>structuredClone(state),
    setDriveCommand(command){calls.push({method:'drive',command:[...command]});if(state.vision.active){state.vision.active=false;state.walking.active=true;}},
    async startWalking(){const epoch=++loadEpoch;calls.push({method:'start'});state.walking.loading=true;if(gate)await gate.promise;if(epoch===loadEpoch){state.walking.active=true;state.walking.loading=false;}},
    stopWalking(){++loadEpoch;state.walking.active=false;state.walking.loading=false;calls.push({method:'stop'});},
    stopVision(){state.vision.active=false;lab.stopWalking();calls.push({method:'stopVision'});},
  };
  let currentLab=lab;
  const input=createDriveInput({getContext:()=>({lab:currentLab,allowed}),onPending:value=>pending.push(value),onError:error=>errors.push(error.message),onInvalidated:()=>invalidations++});
  return {state,lab,input,calls,pending,errors,get invalidations(){return invalidations;},setAllowed:value=>{allowed=value;},setLab:value=>{currentLab=value;},gate,
    nextGate(){gate=deferred();return gate;}, nonzero:()=>calls.filter(item=>item.command?.some(value=>value!==0))};
}

await test('paused gesture resumes and applies its held command',async()=>{const h=harness();await h.input.begin([.35,0,0]);assert.equal(h.calls.filter(c=>c.method==='start').length,1);assert.deepEqual(h.nonzero().at(-1).command,[.35,0,0]);assert.equal(h.state.walking.active,true);});
await test('latest drag replaces the original command during asynchronous load',async()=>{const h=harness({delayed:true});const result=h.input.begin([.35,0,0]);h.input.update([-.2,0,.5]);assert.equal(h.nonzero().length,0);h.gate.resolve();await result;assert.deepEqual(h.nonzero().map(c=>c.command),[[-.2,0,.5]]);});
await test('release before load finishes stops owned loading and never moves later',async()=>{const h=harness({delayed:true});const result=h.input.begin([.35,0,0]);h.input.release();assert.equal(h.pending.at(-1),false);h.gate.resolve();await result;assert.equal(h.nonzero().length,0);assert.equal(h.state.walking.active,false);assert.equal(h.input.hasSession(),false);});
await test('external pause invalidates a pending start even with a held gesture',async()=>{const h=harness({delayed:true});const result=h.input.begin([.35,0,0]);h.lab.stopWalking();h.gate.resolve();await result;assert.equal(h.nonzero().length,0);assert.equal(h.input.hasSession(),false);});
await test('body change discards old commands without pausing the replacement',async()=>{const h=harness({delayed:true});const result=h.input.begin([.35,0,0]);h.state.modelId='cheetah-1';h.state.walking.active=true;h.gate.resolve();await result;assert.equal(h.nonzero().length,0);assert.equal(h.calls.filter(c=>c.method==='stop').length,0);});
await test('engine replacement discards the old gesture',async()=>{const h=harness({delayed:true});const result=h.input.begin([.35,0,0]);h.setLab(harness({active:true}).lab);h.gate.resolve();await result;assert.equal(h.nonzero().length,0);});
await test('body becomes ineligible during startup',async()=>{const h=harness({delayed:true});const result=h.input.begin([.35,0,0]);h.setAllowed(false);h.gate.resolve();await result;assert.equal(h.nonzero().length,0);assert.equal(h.input.hasSession(),false);});
await test('late rejected old request cannot cancel a new successful gesture',async()=>{const h=harness({delayed:true});const oldGate=h.gate;const old=h.input.begin([.35,0,0]);h.input.release();const next=h.nextGate();const current=h.input.begin([-.2,0,0]);next.resolve();await current;oldGate.reject(Error('old request failed'));await old;assert.deepEqual(h.nonzero().map(c=>c.command),[[-.2,0,0]]);assert.equal(h.errors.length,0);assert.equal(h.input.hasSession(),true);});
await test('manual input takes over visual control without resetting the walker',async()=>{const h=harness({vision:true});await h.input.begin([0,0,.5]);assert.equal(h.state.vision.active,false);assert.equal(h.calls.filter(c=>c.method==='start').length,0);assert.deepEqual(h.nonzero().at(-1).command,[0,0,.5]);});
await test('manual input cancels VLM controller loading before its own startup',async()=>{const h=harness({vision:true,delayed:true});h.state.walking.loading=true;const result=h.input.begin([.35,0,0]);assert.equal(h.state.vision.active,false);assert.ok(h.calls.findIndex(c=>c.method==='stopVision')<h.calls.findIndex(c=>c.method==='start'));h.input.update([-.2,0,0]);h.gate.resolve();await result;assert.deepEqual(h.nonzero().map(c=>c.command),[[-.2,0,0]]);assert.equal(h.errors.length,0);});
await test('release during walking requests zero speed and keeps balance running',async()=>{const h=harness({active:true});await h.input.begin([.35,0,0]);h.input.release();assert.deepEqual(h.calls.at(-1),{method:'drive',command:[0,0,0]});assert.equal(h.state.walking.active,true);});
await test('drag update after external pause cannot resume the old gesture',async()=>{const h=harness({active:true});await h.input.begin([.35,0,0]);h.lab.stopWalking();const count=h.nonzero().length;h.input.update([.4,0,0]);assert.equal(h.nonzero().length,count);assert.equal(h.input.hasSession(),false);});
await test('startup error clears pending and reports once',async()=>{const h=harness({delayed:true});const result=h.input.begin([.35,0,0]);h.gate.reject(Error('missing asset'));await result;assert.equal(h.pending.at(-1),false);assert.deepEqual(h.errors,['missing asset']);assert.equal(h.input.hasSession(),false);});

const source=await readFile(new URL('../play/src/drive-input.js',import.meta.url));
const report={schema:1,pass:true,sourceSha256:createHash('sha256').update(source).digest('hex'),checks:results.length,results,scope:'Production input ownership helper with controlled asynchronous engine mocks; actual browser and physics validation are separate.'};
await writeFile(new URL('./drive-input-validation.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({pass:true,checks:results.length}));
