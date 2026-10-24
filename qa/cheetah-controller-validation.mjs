// CPU-only production-controller validation. No browser automation or GPU.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import mujocoFactory from '../play/node_modules/@mujoco/mujoco/mujoco.js';
import * as ort from '../play/node_modules/onnxruntime-web/dist/ort.node.min.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const assetDir=path.join(root,'play/public/controller/cheetah');
const source=await fs.readFile(path.join(root,'play/src/cheetah-controller.js'),'utf8');
// Vite's asset URL import is the only source adaptation. Actual inference uses
// the same ONNX Runtime Web WASM backend, injected to avoid browser URL loading.
const production=source.replace("import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';", "const ortWasmUrl = 'node-injected-session';");
const api=await import(`data:text/javascript;base64,${Buffer.from(production).toString('base64')}`);
const manifest=JSON.parse(await fs.readFile(path.join(assetDir,'manifest.json'),'utf8'));
const fixtures=JSON.parse(await fs.readFile(path.join(assetDir,'fixtures.json'),'utf8'));
const mj=await mujocoFactory();
const vfs=new mj.MjVFS();
for(const asset of manifest.assets) vfs.addBuffer(asset.name,new Uint8Array(await fs.readFile(path.join(assetDir,asset.name))));
const model=mj.MjModel.from_xml_string(await fs.readFile(path.join(assetDir,'scene.xml'),'utf8'),vfs);
const data=new mj.MjData(model);
const ctx=api.createControllerContext(mj,model,data,manifest);
ort.env.wasm.numThreads=1;
const session=await ort.InferenceSession.create(new Uint8Array(await fs.readFile(path.join(assetDir,'policy.onnx'))),{executionProviders:['wasm'],graphOptimizationLevel:'all'});
const maxAbs=(a,b)=>Math.max(0,...Array.from(a,(x,i)=>Math.abs(x-b[i])));
const flatten=x=>Array.isArray(x)?x.flat(Infinity):Array.from(x);
const mean=a=>a.reduce((s,x)=>s+x,0)/a.length;
const report={createdAt:new Date().toISOString(),scope:'Node CPU, actual MuJoCo WASM and ONNX Runtime Web WASM; not a live browser test',
  engines:{nativeFixture:'MuJoCo 3.8.0 CPU with source float32 math',wasm:mj.mj_versionString(),onnxruntime:ort.env.versions},
  checkpointSha256:manifest.checkpointSha256,policySha256:manifest.policySha256,
  controllerSha256:crypto.createHash('sha256').update(source).digest('hex'),modelParity:{},fixtureParity:[],motorParity:[],fixedActionTrajectory:[],episodes:[],lifecycle:{}};
const check=(label,actual,expected,tolerance=1e-9)=>{
  const a=flatten(actual),b=flatten(expected),error=a.length===b.length?maxAbs(a,b):Infinity;
  return {label,maxAbs:error,tolerance,pass:error<=tolerance};
};
function restore(f){mj.mj_resetData(model,data);data.qpos.set(f.qpos);data.qvel.set(f.qvel);mj.mj_forward(model,data);}
async function infer(observation){const input=new ort.Tensor('float32',Float32Array.from(observation),[1,235]);let outputs;try{outputs=await session.run({[session.inputNames[0]]:input});return Array.from(outputs[session.outputNames[0]].data);}finally{input.dispose();if(outputs)for(const t of Object.values(outputs))t.dispose();}}

const models=[];
for(const key of ['nq','nv','nu','nbody','ngeom','nsensor'])models.push(check(key,[model[key]],[manifest.model[key]],0));
for(const b of manifest.model.bodies){models.push(check(`body ${b.id} mass`,[model.body_mass[b.id]],[b.mass],1e-8),check(`body ${b.id} inertia`,model.body_inertia.slice(b.id*3,b.id*3+3),b.inertia,1e-8),check(`body ${b.id} inertialPosition`,model.body_ipos.slice(b.id*3,b.id*3+3),b.inertialPosition,1e-8),check(`body ${b.id} inertialQuaternion`,model.body_iquat.slice(b.id*4,b.id*4+4),b.inertialQuaternion,1e-8));}
for(const g of manifest.model.geoms){models.push(check(`geom ${g.id} masks`,[model.geom_group[g.id],model.geom_contype[g.id],model.geom_conaffinity[g.id],model.geom_condim[g.id],model.geom_priority[g.id]],[g.group,g.contype,g.conaffinity,g.condim,g.priority],0),check(`geom ${g.id} friction`,model.geom_friction.slice(g.id*3,g.id*3+3),g.friction),check(`geom ${g.id} size`,model.geom_size.slice(g.id*3,g.id*3+3),g.size,1e-7));}
// jnt_limited's bool memory view is not bound in MuJoCo3.11 WASM. Compare
// addresses/ranges here; the hashed MJCF preserves the explicit limited flags.
for(const j of manifest.model.joints){models.push(check(`joint ${j.id} addresses`,[model.jnt_qposadr[j.id],model.jnt_dofadr[j.id]],[j.qposAdr,j.dofAdr],0),check(`joint ${j.id} range`,model.jnt_range.slice(j.id*2,j.id*2+2),j.range),check(`joint ${j.id} passive`,[model.dof_armature[j.dofAdr],model.dof_damping[j.dofAdr],model.dof_frictionloss[j.dofAdr]],[j.armature,j.damping,j.frictionloss]));}
for(const a of manifest.model.actuators)models.push(check(`actuator ${a.id}`, [model.actuator_trnid[a.id*2],...model.actuator_ctrlrange.slice(a.id*2,a.id*2+2),...model.actuator_forcerange.slice(a.id*2,a.id*2+2)], [a.jointId,...a.ctrlRange,...a.forceRange]));
for(const s of manifest.model.sensors)models.push(check(`sensor ${s.id}`,[model.sensor_type[s.id],model.sensor_adr[s.id],model.sensor_dim[s.id],model.sensor_objtype[s.id],model.sensor_objid[s.id]],[s.type,s.adr,s.dim,s.objType,s.objId],0));
const options={timestep:model.opt.timestep,integrator:model.opt.integrator,cone:model.opt.cone,jacobian:model.opt.jacobian,solver:model.opt.solver,iterations:model.opt.iterations,tolerance:model.opt.tolerance,ls_iterations:model.opt.ls_iterations,ls_tolerance:model.opt.ls_tolerance,gravity:Array.from(model.opt.gravity)};
const expectedEnums={integrator:mj.mjtIntegrator.mjINT_IMPLICITFAST.value,cone:mj.mjtCone.mjCONE_PYRAMIDAL.value,jacobian:mj.mjtJacobian.mjJAC_AUTO.value,solver:mj.mjtSolver.mjSOL_NEWTON.value};
for(const [k,v] of Object.entries(options))models.push(check(`physics ${k}`,Array.isArray(v)?v:[v],Array.isArray(manifest.physics[k])?manifest.physics[k]:[expectedEnums[k]??manifest.physics[k]],1e-12));
report.modelParity={pass:models.every(x=>x.pass),robotMass:Array.from(model.body_mass).reduce((s,x)=>s+x,0),options,checks:models};
console.log('MODEL',report.modelParity.pass,models.filter(x=>!x.pass));
for(const f of fixtures.fixtures){restore(f);const o=api.observeCheetah(ctx,f.command,f.previousAction);const action=await infer(o.observation);const comparisons=[...manifest.observationTerms.map(t=>check(t.name,o.observation.slice(t.start,t.start+t.length),f.observation.slice(t.start,t.start+t.length),3e-6)),check('rayOrigins',o.ray.origins,f.rayOrigins,3e-6),check('rayDistances',o.ray.distances,f.rayDistances,3e-6),check('rayGeomIds',o.ray.geomIds,f.rayGeomIds,0),check('onnxAction',action,f.onnxAction,2e-5),check('pytorchAction',action,f.action,2e-5),check('torque',api.computeMotorTorques(ctx,f.action),f.torque,1e-4)];const row={name:f.name,pass:comparisons.every(x=>x.pass),misses:o.ray.distances.filter(d=>d<0).length,selfHits:o.ray.geomIds.filter(id=>id>0).length,comparisons};report.fixtureParity.push(row);console.log('FIXTURE',f.name,row.pass,comparisons.filter(x=>!x.pass));}
for(const c of fixtures.motorCases){restore(fixtures.fixtures[0]);for(let i=0;i<12;i++){data.qpos[ctx.qposAddresses[i]]=c.jointPosition[i];data.qvel[ctx.qvelAddresses[i]]=c.jointVelocity[i];}const row=check(c.name,api.computeMotorTorques(ctx,c.rawAction),c.torque,1e-4);report.motorParity.push(row);console.log('MOTOR',row);}
restore(fixtures.fixtures.find(f=>f.name===fixtures.fixedActionTrajectory.startFixture));
for(const f of fixtures.fixedActionTrajectory.steps){const torque=api.computeMotorTorques(ctx,fixtures.fixedActionTrajectory.rawAction);for(let i=0;i<12;i++)data.ctrl[ctx.actuatorIds[i]]=torque[i];mj.mj_step(model,data);mj.mj_forward(model,data);const checks=[check('torque',torque,f.torque,1e-3),check('qpos',data.qpos,f.qpos,1e-5),check('qvel',data.qvel,f.qvel,1e-3)];report.fixedActionTrajectory.push({substep:f.substep,pass:checks.every(x=>x.pass),checks});}
console.log('FIXED',report.fixedActionTrajectory);
api.disposeControllerContext(ctx);
const controller=await api.createCheetahController({mujoco:mj,model,data,manifest,ort,session});
const contactAddresses=['fl','fr','rl','rr'].map(leg=>model.sensor_adr[mj.mj_name2id(model,mj.mjtObj.mjOBJ_SENSOR.value,`feet_ground_contact_${leg}_lower_leg_link_sphere_found`)]);
const scenarios=[['stationary',[0,0,0]],['forward',[.5,0,0]],['turn_left',[0,0,.5]],['forward_ui_max',[.7,0,0]],['backward_ui_max',[-.5,0,0]],['turn_left_ui_max',[0,0,.7]],['turn_right_ui_max',[0,0,-.7]],['forward_left_combined',[.7,0,.7]]];
const traces={scope:report.scope,dt:.02,settleSteps:100,episodes:[]};
for(const [name,command] of scenarios){controller.reset();const started=performance.now(),samples=[];let error=null;
  for(let i=0;i<600;i++){try{const s=await controller.step(command);samples.push({step:i+1,time:s.simTime,position:s.position,velocity:s.actualVelocity,heading:s.heading,tilt:s.tilt,heightAboveFeet:s.heightAboveFeet,fall:s.fall,contacts:s.contacts,footContact:contactAddresses.map(a=>data.sensordata[a]>0),feet:s.footPositions,jointPosition:Array.from(data.qpos.slice(7)),action:s.action});if(s.fall)break;}catch(e){error=e.message;break;}}
  const measured=samples.slice(100),last=samples.at(-1),start=measured[0];
  const edges=Array(4).fill(0);for(let i=1;i<measured.length;i++)for(let j=0;j<4;j++)if(!measured[i-1].footContact[j]&&measured[i].footContact[j])edges[j]++;
  const wrap=x=>Math.atan2(Math.sin(x),Math.cos(x));let headingChange=0;for(let i=1;i<measured.length;i++)headingChange+=wrap(measured[i].heading-measured[i-1].heading);
  const row={name,command,requestedSteps:600,executedSteps:samples.length,measurementSamples:measured.length,measurementSeconds:measured.length*.02,pass:samples.length===600&&!error&&!last?.fall,error,fall:!!last?.fall,final:controller.snapshot(),meanActualVelocity:measured.length?[0,1,2].map(j=>mean(measured.map(s=>s.velocity[j]))):null,meanAbsoluteTrackingError:measured.length?[0,1,2].map(j=>mean(measured.map(s=>Math.abs(s.velocity[j]-command[j])))):null,measurementDisplacement:start?last.position.map((x,j)=>x-start.position[j]):null,headingChange,footContactOnEdges:edges,footVerticalExcursion:measured.length?[0,1,2,3].map(j=>Math.max(...measured.map(s=>s.feet[j][2]))-Math.min(...measured.map(s=>s.feet[j][2]))):null,wallSeconds:(performance.now()-started)/1000};
  report.episodes.push(row);traces.episodes.push({name,command,samples});console.log('EPISODE',JSON.stringify({name,pass:row.pass,steps:row.executedSteps,velocity:row.meanActualVelocity,displacement:row.measurementDisplacement,error,wallSeconds:row.wallSeconds}));
}
controller.dispose();
// Deliberately resolve an in-flight inference after reset/pause/disposal. The
// stale result must neither step a reset simulation nor access released data.
for(const operation of ['reset','pause','dispose']){
  const localData=new mj.MjData(model);let resolveRun;
  const gated={inputNames:['obs'],outputNames:['actions'],run:()=>new Promise(resolve=>{resolveRun=resolve;})};
  const c=await api.createCheetahController({mujoco:mj,model,data:localData,manifest,ort,session:gated});
  const pending=c.step([.5,0,0]).then(()=>({resolved:true}),e=>({name:e.name,message:e.message}));
  c[operation]();if(operation==='dispose')localData.delete();
  resolveRun({actions:new ort.Tensor('float32',new Float32Array(12),[1,12])});
  const result=await pending;const time=operation==='dispose'?null:localData.time;
  report.lifecycle[operation]={...result,time,pass:result.name==='AbortError'&&(time===null||time===0)};
  c.dispose();if(operation!=='dispose')localData.delete();
}
{
  const c=await api.createCheetahController({mujoco:mj,model,data,manifest,ort,session});
  data.qvel[0]=NaN;
  let error=null;try{await c.step([0,0,0]);}catch(e){error=e.message;}
  const s=c.snapshot();report.lifecycle.invalidState={error,warningCounts:s.warningCounts,timeResets:s.timeResets,pass:!!error&&!s.active};c.dispose();
}
{
  const realFetch=globalThis.fetch;let error=null;
  globalThis.fetch=async()=>new Response(new Uint8Array([1,2,3]),{status:200});
  try{await api.createCheetahController({mujoco:mj,model,data,manifest:{...manifest,policySha256:'0'.repeat(64)},ort});}catch(e){error=e.message;}finally{globalThis.fetch=realFetch;}
  report.lifecycle.badPolicyHash={error,pass:error==='Controller policy SHA-256 does not match the verified export'};
}
report.pass=report.modelParity.pass&&report.fixtureParity.every(x=>x.pass)&&report.motorParity.every(x=>x.pass)&&report.fixedActionTrajectory.every(x=>x.pass)&&report.episodes.every(x=>x.pass)&&Object.values(report.lifecycle).every(x=>x.pass);
await fs.writeFile(path.join(root,'qa/cheetah-controller-validation.json'),JSON.stringify(report,null,2)+'\n');
await fs.writeFile(path.join(root,'qa/cheetah-controller-traces.json'),JSON.stringify(traces)+'\n');
console.log('RESULT',report.pass,'LIFECYCLE',report.lifecycle);
await session.release();data.delete();model.delete();vfs.delete();
process.exitCode=report.pass?0:1;
