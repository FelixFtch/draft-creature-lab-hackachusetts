// Real arbitration module with injected transport. No provider accuracy claim.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createVisionControl,validateVisionDecision} from '../play/src/vlm-control.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const imageBytes=Buffer.from('89504e470d0a1a0a','hex');
const imageDataUrl='data:image/png;base64,'+imageBytes.toString('base64');
const imageSha256=hash(imageBytes);
const report={createdAt:new Date().toISOString(),scope:'Production visual arbitration with injected transport and camera bytes; actual WASM/PPO bounded movement separately below. Not browser rendering or live VLM navigation evidence.',checks:[],physicalEpisode:null,limitations:['Cancellation checks exercise the production vision arbiter with injected engine callbacks; they do not execute draft-lab.js DOM event handlers or asynchronous model loading.', 'Camera bytes in this harness are synthetic. Real rendering, service transport and VLM choices require separate live browser evidence.', 'The physical episode uses injected high-level decisions and the production Flower gait; it validates bounded actuation and freeze, not visual navigation.']};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await pause(2);}throw Error('condition did not settle');}
function decision(observationId,operation='forward',durationSeconds=1,overrides={}){
  const commands={forward:[.35,0,0],backward:[-.2,0,0],turn_left:[0,0,.5],turn_right:[0,0,-.5],stand:[0,0,0]},[vx,vy,wz]=commands[operation];
  return {ok:true,executesMotion:false,decisionId:'live-shaped-fixture',observationId,action:{operation,vx,vy,wz,durationSeconds},provenance:{source:'local_vlm',model:'injected-test-fixture',imageSha256,elapsedMilliseconds:1},...overrides};
}
function harness(options={}){
  const h={time:0,body:'body-1',position:[0,0,.28],moves:[],frozen:0,requests:[],frame:0,changed:0};
  h.control=createVisionControl({prepare:options.prepare??(async()=>{}),capture:()=>({imageDataUrl,observationId:`frame-${++h.frame}`,width:640,height:400}),
    apply:command=>h.moves.push([...command]),freeze:()=>h.frozen++,context:()=>h.body,getSimTime:()=>h.time,getPosition:()=>h.position,
    onChange:()=>h.changed++,request:async(body,signal)=>{h.requests.push({body,signal});return options.request?options.request(body,signal):decision(body.observationId);},
    timeoutMs:options.timeoutMs??2000});return h;
}
async function check(name,fn){try{const details=await fn();report.checks.push({name,pass:true,...details});}catch(e){report.checks.push({name,pass:false,error:e.stack});}}
await check('Reject invalid instruction and bounds before preparing or applying',async()=>{const h=harness();for(const args of [[''],['x',{maxSteps:0}],['x',{maxSteps:31}],['x',{maxSteps:1.5}],[true]])await assert.rejects(h.control.start(...args));assert.equal(h.requests.length,0);assert.equal(h.moves.length,0);});
await check('All five adapter operations map to exact bounded velocities',async()=>{for(const op of ['forward','backward','turn_left','turn_right','stand'])assert.equal(validateVisionDecision(decision('f',op,op==='stand'?0:2),'f').action.operation,op);});
await check('Reject mismatch, malicious action fields, nonfinite duration and wrong provenance',async()=>{
  const variants=[v=>v.observationId='old',v=>v.ok=false,v=>v.executesMotion=true,v=>v.provenance.source='script',v=>v.provenance.imageSha256='bad',v=>v.action.vx=2,v=>v.action.vy=.1,v=>v.action.durationSeconds=NaN,v=>v.action.durationSeconds=2.001,v=>v.action.durationSeconds=0,v=>v.action.code='run',v=>v.action.operation='constructor',v=>v.decisionId=''];
  for(const mutate of variants){const v=decision('f');mutate(v);assert.throws(()=>validateVisionDecision(v,'f'));}return {cases:variants.length};
});
await check('Exact captured image hash is required before issuing a move',async()=>{const h=harness({request:async b=>decision(b.observationId,'forward',1,{provenance:{source:'local_vlm',model:'fixture',imageSha256:'0'.repeat(64)}})});await h.control.start('test');assert.equal(h.control.snapshot().phase,'error');assert.equal(h.moves.length,0);});
await check('Stationary model choice freezes and finishes without motion',async()=>{const h=harness({request:async b=>decision(b.observationId,'stand',0)});await h.control.start('stay');assert.equal(h.control.snapshot().reason,'model_stand');assert.equal(h.control.snapshot().completedSteps,1);assert.equal(h.moves.length,0);});
await check('Waiting is frozen and exact simulation deadline stops a single move',async()=>{const waiting=deferred(),h=harness({request:()=>waiting.promise});const start=h.control.start('one step',{maxSteps:1});await until(()=>h.requests.length);assert.equal(h.control.snapshot().phase,'thinking');assert.equal(h.moves.length,0);assert.equal(h.frozen,1);waiting.resolve(decision('frame-1'));await start;assert.equal(h.control.snapshot().phase,'moving');h.time=.98;h.control.advance();assert.equal(h.control.snapshot().phase,'moving');h.time=1;h.position=[.32,0,.28];h.control.advance();assert.equal(h.control.snapshot().phase,'done');assert.equal(h.control.snapshot().reason,'step_limit');assert.equal(h.control.snapshot().completedSteps,1);assert.deepEqual(h.control.snapshot().history[0].displacement,[.32,0,0]);assert.equal(h.requests.length,1);});
await check('Every subsequent move gets a new frame after previous simulated action',async()=>{const h=harness();await h.control.start('two steps',{maxSteps:2});h.time=1;h.control.advance();await until(()=>h.moves.length===2);assert.equal(h.requests[1].body.observationId,'frame-2');assert.equal(h.control.snapshot().frame.simTime,1);h.time=2;h.control.advance();assert.equal(h.control.snapshot().phase,'done');assert.equal(h.control.snapshot().completedSteps,2);});
await check('Thirty maximum actions stop at60 simulated seconds',async()=>{const h=harness({request:async b=>decision(b.observationId,'forward',2)});await h.control.start('bounded',{maxSteps:30});for(let n=1;n<=30;n++){h.time=n*2;h.control.advance();if(n<30)await until(()=>h.moves.length===n+1);}assert.equal(h.control.snapshot().elapsedSeconds,60);assert.equal(h.requests.length,30);assert.equal(h.control.snapshot().history.length,30);assert.equal(h.control.snapshot().phase,'done');});
await check('Cancelled request cannot move even if transport ignores AbortSignal',async()=>{const pending=deferred(),h=harness({request:()=>pending.promise});const start=h.control.start('move');await until(()=>h.requests.length);h.control.cancel('manual');assert.equal(h.requests[0].signal.aborted,true);pending.resolve(decision('frame-1'));await start;assert.equal(h.moves.length,0);assert.equal(h.control.snapshot().reason,'manual');});
await check('Cancellation during delayed controller preparation prevents capture and side effects',async()=>{const pending=deferred();let afterPrepareSideEffects=0;const h=harness({prepare:async isCurrent=>{await pending.promise;if(!isCurrent())return;afterPrepareSideEffects++;}});const start=h.control.start('move');h.control.cancel('manual');pending.resolve();await start;assert.equal(afterPrepareSideEffects,0);assert.equal(h.requests.length,0);assert.equal(h.frame,0);});
await check('New session replaces old deferred response without freezing its movement',async()=>{const pending=deferred();let calls=0;const h=harness({request:b=>++calls===1?pending.promise:Promise.resolve(decision(b.observationId))});const first=h.control.start('old');await until(()=>h.requests.length===1);await h.control.start('new');const freezes=h.frozen;pending.resolve(decision('frame-1'));await first;assert.equal(h.moves.length,1);assert.equal(h.control.snapshot().phase,'moving');assert.equal(h.frozen,freezes);});
await check('Body/session change invalidates a pending result',async()=>{const pending=deferred(),h=harness({request:()=>pending.promise});const start=h.control.start('move');await until(()=>h.requests.length);h.body='body-2';pending.resolve(decision('frame-1'));await start;assert.equal(h.moves.length,0);assert.equal(h.control.snapshot().phase,'error');});
await check('Body/session change stops an active action',async()=>{const h=harness();await h.control.start('move');h.body='new';h.control.advance();assert.equal(h.control.snapshot().phase,'error');});
await check('Reset simulation clock cannot prolong action',async()=>{const h=harness();h.time=3;await h.control.start('move');h.time=2;h.control.advance();assert.equal(h.control.snapshot().phase,'error');});
await check('Offline and malformed responses freeze without fallback',async()=>{for(const request of [async()=>{throw Error('provider offline');},async()=>({ok:false}),async b=>decision(b.observationId,'forward',3)]){const h=harness({request});await h.control.start('move');assert.equal(h.control.snapshot().phase,'error');assert.equal(h.moves.length,0);}});
await check('Timeout aborts transport and ignores late valid output',async()=>{const p=deferred(),h=harness({timeoutMs:10,request:()=>p.promise});const start=h.control.start('move');await until(()=>h.control.snapshot().phase==='error');assert.equal(h.requests[0].signal.aborted,true);p.resolve(decision('frame-1'));await start;assert.equal(h.moves.length,0);assert.match(h.control.snapshot().error,/timed out/);});
await check('Snapshot excludes pixels, copies history, and dispose invalidates pending response',async()=>{const p=deferred(),h=harness({request:()=>p.promise});const start=h.control.start('move');await until(()=>h.requests.length);assert(!JSON.stringify(h.control.snapshot()).includes(imageDataUrl));h.control.dispose();p.resolve(decision('frame-1'));await start;assert.equal(h.moves.length,0);assert.equal(h.control.getFrame(),null);});

await check('New body/pose clears previous decisions and makes pending responses inert',async()=>{
  const completed=harness({request:async b=>decision(b.observationId,'stand',0)});
  await completed.control.start('stay');assert.equal(completed.control.snapshot().history.length,1);
  completed.control.reset();const state=completed.control.snapshot();
  assert.equal(state.phase,'idle');assert.equal(state.lastDecision,null);assert.equal(state.frame,null);
  assert.deepEqual(state.history,[]);assert.equal(state.completedSteps,0);assert.equal(completed.control.getFrame(),null);
  const pending=deferred(),h=harness({request:()=>pending.promise});const start=h.control.start('move');
  await until(()=>h.requests.length);h.control.reset();pending.resolve(decision('frame-1'));await start;
  assert.equal(h.moves.length,0);assert.equal(h.control.snapshot().phase,'idle');assert.deepEqual(h.control.snapshot().history,[]);
});

await check('Environment goal completion freezes early and records actual movement duration',async()=>{
  const h=harness();await h.control.start('goal',{maxSteps:30});h.time=.62;h.position=[.2,0,.28];
  assert.equal(h.control.complete('trail_complete'),true);const state=h.control.snapshot();
  assert.equal(state.phase,'done');assert.equal(state.reason,'trail_complete');assert.equal(state.completedSteps,1);
  assert.equal(state.elapsedSeconds,.62);assert.equal(state.history[0].durationSeconds,1);
  assert.equal(state.history[0].executedSeconds,.62);assert.equal(state.history[0].terminationReason,'trail_complete');
  h.time=2;h.control.advance();assert.equal(h.requests.length,1);assert.equal(h.control.complete('trail_complete'),false);
});
await check('Environment completion invalidates an in-flight proposal',async()=>{
  const pending=deferred(),h=harness({request:()=>pending.promise});const start=h.control.start('goal');
  await until(()=>h.requests.length);h.control.complete('trail_complete');pending.resolve(decision('frame-1'));await start;
  assert.equal(h.moves.length,0);assert.equal(h.control.snapshot().reason,'trail_complete');assert.equal(h.control.snapshot().phase,'done');
});

// Physical subtest uses the real learned Flower policy. Decisions are injected;
// this verifies bounded actuation/pause only, not visual judgment/navigation.
await check('Real Flower MuJoCo and ONNX execute then freeze at bounded deadlines',async()=>{
  const {default:mujocoFactory}=await import('../play/node_modules/@mujoco/mujoco/mujoco.js');
  const ort=await import('../play/node_modules/onnxruntime-web/dist/ort.node.min.mjs');
  const dir=path.join(root,'play/public/controller/flower');
  const manifest=JSON.parse(await fs.readFile(path.join(dir,'manifest.json'),'utf8'));
  const source=await fs.readFile(path.join(root,'play/src/flower-controller.js'),'utf8');
  const transformed=source.replace("import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';","const ortWasmUrl='node-injected-session';");
  const {createFlowerController}=await import(`data:text/javascript;base64,${Buffer.from(transformed).toString('base64')}`);
  const mj=await mujocoFactory(),vfs=new mj.MjVFS();
  const xml=await fs.readFile(path.join(dir,'scene.xml')),policy=await fs.readFile(path.join(dir,'policy.onnx'));
  assert.equal(hash(xml),manifest.xmlSha256);assert.equal(hash(policy),manifest.policySha256);
  for(const asset of manifest.assets){const bytes=await fs.readFile(path.join(root,'play/public',asset.url));assert.equal(hash(bytes),asset.sha256);vfs.addBuffer(asset.name,new Uint8Array(bytes));}
  const model=mj.MjModel.from_xml_string(xml.toString(),vfs),data=new mj.MjData(model);ort.env.wasm.numThreads=1;
  const session=await ort.InferenceSession.create(new Uint8Array(policy),{executionProviders:['wasm'],graphOptimizationLevel:'all'});
  const gait=await createFlowerController({mujoco:mj,model,data,manifest,ort,session});
  let command=[0,0,0],moving=false,frames=0,applied=0;const commands=[['forward',2],['turn_left',1.4],['forward',1.2],['stand',0]];
  const control=createVisionControl({prepare:async()=>{},context:()=> 'nominal-flower',capture:()=>({imageDataUrl,observationId:`physics-${++frames}`}),
    getSimTime:()=>data.time,getPosition:()=>Array.from(data.qpos.slice(0,3)),freeze:()=>{moving=false;command=[0,0,0];gait.cancelStep();},apply:c=>{moving=true;command=c;applied++;},
    request:async b=>{const [op,duration]=commands[frames-1];return decision(b.observationId,op,duration);}});
  await control.start('Injected commands only, no VLM',{maxSteps:4});
  let ticks=0;while(control.isActive()&&ticks<400){if(!moving){await until(()=>moving||!control.isActive());continue;}await gait.step(command);ticks++;control.advance(data.time);}
  const end=gait.snapshot();assert.equal(control.snapshot().reason,'model_stand');assert.equal(applied,3);assert.equal(end.fall,false);assert.equal(end.timeResets,0);assert(end.warningCounts.every(x=>x===0));assert(data.time<=4.600001);
  const frozen=JSON.stringify({time:data.time,qpos:Array.from(data.qpos),qvel:Array.from(data.qvel)});for(let i=0;i<20;i++)control.advance(data.time);assert.equal(JSON.stringify({time:data.time,qpos:Array.from(data.qpos),qvel:Array.from(data.qvel)}),frozen);
  report.physicalEpisode={scope:'Injected high-level decisions; actual production gait, MuJoCo WASM and ONNX policy',model:manifest.model,policySha256:hash(policy),xmlSha256:hash(xml),controllerSourceSha256:hash(source),simTime:data.time,controlTicks:ticks,position:end.position,fall:end.fall,warningCounts:end.warningCounts,timeResets:end.timeResets,history:control.snapshot().history,pausedStatePreserved:true};
  control.dispose();gait.dispose();await session.release();data.delete();model.delete();vfs.delete();
});
report.sourceSha256=Object.fromEntries(await Promise.all(['play/src/vlm-control.js','play/src/draft-lab.js'].map(async p=>[p,hash(await fs.readFile(path.join(root,p)))])));
report.pass=report.checks.every(c=>c.pass);
await fs.writeFile(path.join(root,'qa/vlm-control-validation.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({pass:report.pass,checks:report.checks.length,failures:report.checks.filter(c=>!c.pass),physicalEpisode:report.physicalEpisode&&{simTime:report.physicalEpisode.simTime,position:report.physicalEpisode.position,fall:report.physicalEpisode.fall}},null,2));
if(!report.pass)process.exitCode=1;
