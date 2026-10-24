// Focused CPU-only rules + real MuJoCo/ONNX assisted-course validation.
// No browser automation, renderer, GPU, or production-source changes.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createTrail, updateTrail, trailDrive, TRAIL_TARGETS, TRAIL_RADIUS, TRAIL_LIMIT_SECONDS } from '../play/src/trail-game.js';
import mujocoFactory from '../play/node_modules/@mujoco/mujoco/mujoco.js';
import * as ort from '../play/node_modules/onnxruntime-web/dist/ort.node.min.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const assetDir=path.join(root,'play/public/controller/cheetah');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const source=await fs.readFile(path.join(root,'play/src/cheetah-controller.js'),'utf8');
const trailSource=await fs.readFile(path.join(root,'play/src/trail-game.js'),'utf8');
const report={createdAt:new Date().toISOString(),scope:'Node CPU production rules and actual MuJoCo WASM + ONNX Runtime Web WASM; no live browser/render/UI lifecycle test',
  trailSourceSha256:hash(trailSource),controllerSourceSha256:hash(source),unitChecks:[],course:null,limitations:[
    'One deterministic nominal original-size Cheetah and one fixed course; not a robustness or altered-body result.',
    'Synthetic rule inputs validate scoring logic only; the separate course uses real physics positions and learned inference.',
    'Pause check exercises a controller pause with no simulation steps; it does not verify browser tab, UI, or asynchronous start/reset integration.',
    'Targets are visual XY checkpoints, not collision objects or physical manipulation.'
  ]};
function check(name,run){try{const detail=run();report.unitChecks.push({name,pass:true,...(detail??{})});}catch(error){report.unitChecks.push({name,pass:false,error:error.message});}}
const state=(position,simTime=1,extra={})=>({position:[...position,.5].slice(0,3),heading:0,simTime,fall:false,error:null,...extra});
check('Targets are disjoint and outside initial torso collection radius',()=>{for(let i=0;i<TRAIL_TARGETS.length;i++){assert(Math.hypot(...TRAIL_TARGETS[i])>TRAIL_RADIUS);for(let j=i+1;j<TRAIL_TARGETS.length;j++)assert(Math.hypot(TRAIL_TARGETS[i][0]-TRAIL_TARGETS[j][0],TRAIL_TARGETS[i][1]-TRAIL_TARGETS[j][1])>2*TRAIL_RADIUS);}});
check('Outside radius is not collected; exact boundary and inside are collected',()=>{const [x,y]=TRAIL_TARGETS[0];assert.equal(updateTrail(createTrail(),state([x,y+TRAIL_RADIUS+1e-8])).collected,0);assert.equal(updateTrail(createTrail(),state([x,y+TRAIL_RADIUS])).collected,1);assert.equal(updateTrail(createTrail(),state([x,y+TRAIL_RADIUS-1e-8])).collected,1);});
check('Visiting a later target does not skip the first target',()=>{assert.equal(updateTrail(createTrail(),state(TRAIL_TARGETS[1])).collected,0);assert.equal(updateTrail(createTrail(),state(TRAIL_TARGETS[2])).collected,0);});
check('Lingering in a collected target cannot score it twice',()=>{let t=updateTrail(createTrail(),state(TRAIL_TARGETS[0]));for(let i=0;i<100;i++)t=updateTrail(t,state(TRAIL_TARGETS[0],1+i*.02));assert.equal(t.collected,1);assert.equal(t.records.length,1);});
check('Fall and controller error preempt collection and the guide watchdog',()=>{for(const extra of [{fall:true},{error:'injected controller failure'}]){const t=updateTrail(createTrail(0,true),state(TRAIL_TARGETS[0],TRAIL_LIMIT_SECONDS,extra));assert.equal(t.phase,'failed');assert.equal(t.reason,'fall');assert.equal(t.collected,0);assert.equal(t.assisted,false);}});
check('Invalid position or simulation time fails without score',()=>{for(const s of [state([NaN,0]),state([0,Infinity]),state(TRAIL_TARGETS[0],NaN)]){const t=updateTrail(createTrail(),s);assert.equal(t.phase,'failed');assert.equal(t.collected,0);}});
check('Manual play stays active beyond 60 seconds and can complete without a time limit',()=>{let t=updateTrail(createTrail(),state([0,0],120));assert.equal(t.phase,'active');assert.equal(t.elapsedSeconds,120);assert.equal(t.assistedSeconds,0);assert.equal(t.lastSimTime,120);for(let i=0;i<TRAIL_TARGETS.length;i++)t=updateTrail(t,state(TRAIL_TARGETS[i],1000+i));assert.equal(t.phase,'complete');assert.equal(t.elapsedSeconds,1002);assert.equal(t.assistedSeconds,0);});
check('Guide watchdog at boundary preempts collection; just before boundary can collect',()=>{const late=updateTrail(createTrail(0,true),state(TRAIL_TARGETS[0],TRAIL_LIMIT_SECONDS));assert.equal(late.phase,'failed');assert.equal(late.reason,'timeout');assert.equal(late.assistedSeconds,TRAIL_LIMIT_SECONDS);assert.equal(late.collected,0);const early=updateTrail(createTrail(0,true),state(TRAIL_TARGETS[0],TRAIL_LIMIT_SECONDS-1e-8));assert.equal(early.collected,1);});
check('Assistance accumulation excludes manual intervals and persists across toggles',()=>{let t=updateTrail(createTrail(0,true),state([0,0],10));assert.equal(t.assistedSeconds,10);t=updateTrail({...t,assisted:false},state([0,0],100));assert.equal(t.assistedSeconds,10);assert.equal(t.elapsedSeconds,100);assert.equal(t.lastSimTime,100);t=updateTrail({...t,assisted:true},state([0,0],149));assert.equal(t.assistedSeconds,59);assert.equal(t.phase,'active');t=updateTrail({...t,assisted:false},state([0,0],1000));assert.equal(t.assistedSeconds,59);assert.equal(t.phase,'active');t=updateTrail({...t,assisted:true},state(TRAIL_TARGETS[0],1001));assert.equal(t.assistedSeconds,60);assert.equal(t.phase,'failed');assert.equal(t.reason,'timeout');assert.equal(t.collected,0);});
check('Ordered completion freezes score, time, positions and assistance',()=>{let t=createTrail(0,true);for(let i=0;i<TRAIL_TARGETS.length;i++)t=updateTrail(t,state(TRAIL_TARGETS[i],i+1));assert.equal(t.phase,'complete');assert.equal(t.collected,3);assert.equal(t.assisted,false);const json=JSON.stringify(t);const later=updateTrail(t,state([NaN,NaN],100,{fall:true}));assert.equal(later,t);assert.equal(JSON.stringify(later),json);assert.deepEqual(trailDrive(later,state([0,0],4)),[0,0,0]);});
check('Failed state remains frozen and cannot later collect',()=>{const t=updateTrail(createTrail(),state([0,0],1,{fall:true}));assert.equal(updateTrail(t,state(TRAIL_TARGETS[0],2)),t);});
check('Elapsed and assistance time use simulated deltas, not wall time or polling',()=>{const initial=createTrail(12,true);assert.equal(initial.lastSimTime,12);assert.equal(initial.assistedSeconds,0);const t=updateTrail(initial,state([0,0],14.5));assert.equal(t.elapsedSeconds,2.5);assert.equal(t.assistedSeconds,2.5);const repeated=updateTrail(t,state([0,0],14.5));assert.equal(repeated.elapsedSeconds,t.elapsedSeconds);assert.equal(repeated.assistedSeconds,t.assistedSeconds);assert.equal(repeated.collected,t.collected);});
check('Assistant waits for stance settling and is off for manual/invalid states',()=>{assert.deepEqual(trailDrive(createTrail(0,true),state([0,0],.59)),[0,0,0]);assert.deepEqual(trailDrive(createTrail(),state([0,0],1)),[0,0,0]);for(const extra of [{fall:true},{error:'x'},{heading:NaN}])assert.deepEqual(trailDrive(createTrail(0,true),state([0,0],1,extra)),[0,0,0]);});
check('Assistant commands are finite and bounded across heading/position sweep',()=>{let samples=0;for(const p of [[0,0],[3,-2],[-4,4],TRAIL_TARGETS[0]])for(let i=-128;i<=128;i++){const command=trailDrive(createTrail(0,true),state(p,1,{heading:i*Math.PI/16}));assert(command.every(Number.isFinite));assert(command[0]>=0&&command[0]<=.45);assert.equal(command[1],0);assert(Math.abs(command[2])<=.7);samples++;}return {samples};});
check('Three-dimensional torso height does not alter planar checkpoint scoring',()=>{const a=updateTrail(createTrail(),state(TRAIL_TARGETS[0],1,{position:[...TRAIL_TARGETS[0],.49]}));const b=updateTrail(createTrail(),state(TRAIL_TARGETS[0],1,{position:[...TRAIL_TARGETS[0],.65]}));assert.equal(a.collected,b.collected);assert.equal(a.records[0].distance,b.records[0].distance);});

// Vite asset import is replaced only for Node loading. Inference below uses the
// production controller unchanged and the real ORT Web WASM session.
const production=source.replace("import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';","const ortWasmUrl = 'node-injected-session';");
const {createCheetahController}=await import(`data:text/javascript;base64,${Buffer.from(production).toString('base64')}`);
const manifest=JSON.parse(await fs.readFile(path.join(assetDir,'manifest.json'),'utf8'));
const xml=await fs.readFile(path.join(assetDir,'scene.xml'));
const policy=await fs.readFile(path.join(assetDir,'policy.onnx'));
assert.equal(hash(xml),manifest.xmlSha256);assert.equal(hash(policy),manifest.policySha256);
const mj=await mujocoFactory(),vfs=new mj.MjVFS();
for(const asset of manifest.assets){const bytes=await fs.readFile(path.join(assetDir,asset.name));assert.equal(hash(bytes),asset.sha256);vfs.addBuffer(asset.name,new Uint8Array(bytes));}
const model=mj.MjModel.from_xml_string(xml.toString('utf8'),vfs),data=new mj.MjData(model);
assert.equal(model.nq,19);assert.equal(model.nv,18);assert.equal(model.nu,12);assert.equal(model.ngeom,manifest.model.ngeom);
ort.env.wasm.numThreads=1;
const session=await ort.InferenceSession.create(new Uint8Array(policy),{executionProviders:['wasm'],graphOptimizationLevel:'all'});
const controller=await createCheetahController({mujoco:mj,model,data,manifest,ort,session});
report.engines={mujoco:mj.mj_versionString(),onnxruntime:ort.env.versions};
report.provenance={checkpointSha256:manifest.checkpointSha256,policySha256:hash(policy),xmlSha256:hash(xml),nq:model.nq,nv:model.nv,nu:model.nu,ngeom:model.ngeom};
const samples=[],events=[];let trail=createTrail(data.time,true),error=null,pathLength=0,pauseCheck=null;
const started=performance.now(),maxTicks=Math.round(TRAIL_LIMIT_SECONDS/manifest.controlDt);
for(let i=0;i<maxTicks&&trail.phase==='active';i++){
  const before=controller.snapshot(),command=trailDrive(trail,before),count=trail.collected;
  if(i===75){controller.pause();const previous=JSON.stringify({qpos:Array.from(data.qpos),qvel:Array.from(data.qvel),time:data.time,trail});for(let j=0;j<5;j++)controller.snapshot();pauseCheck={scope:'Controller pause and snapshot polling without any physics step; no wall-time sleep or browser lifecycle',pass:previous===JSON.stringify({qpos:Array.from(data.qpos),qvel:Array.from(data.qvel),time:data.time,trail})};}
  try{
    const after=await controller.step(command);trail=updateTrail(trail,after);
    pathLength+=Math.hypot(after.position[0]-before.position[0],after.position[1]-before.position[1]);
    const sample={step:i+1,simTime:after.simTime,command,position:after.position,heading:after.heading,actualVelocity:after.actualVelocity,
      fall:after.fall,tilt:after.tilt,heightAboveFeet:after.heightAboveFeet,contacts:after.contacts,footPositions:after.footPositions,
      qpos:Array.from(data.qpos),qvel:Array.from(data.qvel),rawAction:after.action,warningCounts:after.warningCounts,
      phase:trail.phase,collected:trail.collected,distanceToNextTarget:trail.distance,elapsedSeconds:trail.elapsedSeconds,assistedSeconds:trail.assistedSeconds};
    samples.push(sample);
    if(trail.collected!==count){const event={...trail.records.at(-1),controlStep:i+1};events.push(event);console.log('COLLECTED',JSON.stringify(event));}
  }catch(e){error=e.message;trail=updateTrail(trail,{...controller.snapshot(),error});break;}
}
const end=controller.snapshot(),completedCopy=JSON.stringify(trail);
// Completion only requests a standing command; it must not alter or reset the
// physical pose. Exercise one second of genuine policy-driven standing after it.
const afterCompletion=[];
if(trail.phase==='complete')for(let i=0;i<50;i++){try{const command=trailDrive(trail,controller.snapshot());assert.deepEqual(command,[0,0,0]);const s=await controller.step(command);trail=updateTrail(trail,s);afterCompletion.push({simTime:s.simTime,position:s.position,fall:s.fall,warningCounts:s.warningCounts,command});if(s.fall)break;}catch(e){error=e.message;break;}}
const final=controller.snapshot();
const allFinite=samples.every(s=>[...s.qpos,...s.qvel,...s.position,...s.actualVelocity,...s.rawAction].every(Number.isFinite));
const zeroWarnings=samples.every(s=>s.warningCounts.every(n=>n===0))&&final.warningCounts.every(n=>n===0);
const evidence=events.every((event,i)=>event.targetIndex===i&&Math.hypot(event.position[0]-event.target[0],event.position[1]-event.target[1])<=TRAIL_RADIUS);
report.course={pass:trail.phase==='complete'&&trail.collected===3&&!error&&allFinite&&zeroWarnings&&!final.fall&&final.timeResets===0&&evidence,
  phase:trail.phase,score:trail.collected,total:trail.total,elapsedSeconds:trail.elapsedSeconds,assistedSeconds:trail.assistedSeconds,
  limitSeconds:TRAIL_LIMIT_SECONDS,limitScope:'Cumulative assisted simulation time only; manual play is untimed',
  executedTicks:samples.length,records:events,pathLengthMetres:pathLength,endState:end,error,allFinite,zeroWarnings,
  collectionEvidenceValid:evidence,pauseWithoutSteps:pauseCheck,
  postCompletion:{steps:afterCompletion.length,allZeroCommands:afterCompletion.every(s=>s.command.every(x=>x===0)),frozenResult:JSON.stringify(trail)===completedCopy,finalState:final},
  wallSeconds:(performance.now()-started)/1000};
report.pass=report.unitChecks.every(x=>x.pass)&&report.course.pass&&pauseCheck?.pass&&report.course.postCompletion.frozenResult;
await fs.writeFile(path.join(root,'qa/trail-game-validation.json'),JSON.stringify(report,null,2)+'\n');
await fs.writeFile(path.join(root,'qa/trail-game-traces.json'),JSON.stringify({scope:report.scope,targets:TRAIL_TARGETS,radius:TRAIL_RADIUS,dt:manifest.controlDt,samples,afterCompletion})+'\n');
console.log('UNIT',report.unitChecks.map(({name,pass,error})=>({name,pass,error})));
console.log('COURSE',JSON.stringify({pass:report.course.pass,phase:trail.phase,score:trail.collected,elapsedSeconds:trail.elapsedSeconds,ticks:samples.length,pathLength,allFinite,zeroWarnings,error,pauseCheck,completionFrozen:report.course.postCompletion.frozenResult}));
console.log('RESULT',report.pass);
controller.dispose();await session.release();data.delete();model.delete();vfs.delete();
process.exitCode=report.pass?0:1;
