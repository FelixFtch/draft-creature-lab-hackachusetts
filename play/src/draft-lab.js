import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import loadMujoco from '@mujoco/mujoco';
import wasmUrl from '@mujoco/mujoco/mujoco.wasm?url';
import { createCheetahController } from './cheetah-controller.js';
import { createFlowerController } from './flower-controller.js';
import { createTrail, updateTrail, trailDrive } from './trail-game.js';
import { createTrailVisuals } from './trail-visuals.js';
import { createVisionControl } from './vlm-control.js';

// Physics owns every rendered robot transform. Pose mode only calls forward
// kinematics; drop mode only calls mj_step. Walking uses the trained actor's
// motor torques, never rendered-pose animation or root-position writes.
let enginePromise;
const clamp01 = n => Math.max(0, Math.min(1, Number(n) || 0));
async function verifyAssetHash(bytes,expected,name) {
  if(!expected)throw Error(`Missing controller asset hash: ${name}`);
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  const actual=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
  if(actual!==expected)throw Error(`Controller asset does not match training export: ${name}`);
}

// MuJoCo can reset an unstable state to finite values during mj_step. Read
// its warning counters too. The vector belongs to MjData; get() returns an
// owned entry snapshot. Deleting the borrowed vector would abort WASM.
export function readPhysicsWarningCounts(data) {
  if(!data)return [];
  const list=data.warning,counts=[];
  for(let i=0;i<list.size();i++) {
    const item=list.get(i);
    try{counts.push(item.number);}finally{item.delete();}
  }
  return counts;
}

export function stepDraftPhysics(mj,model,data,evidence) {
  const before=data.time,previous=evidence.lastTime??before;
  mj.mj_step(model,data);
  evidence.stepCount=(evidence.stepCount??0)+1;
  evidence.warningCounts=readPhysicsWarningCounts(data);
  const timeReset=before+1e-12<previous||data.time<=before;
  evidence.timeResets=(evidence.timeResets??0)+(timeReset?1:0);
  evidence.lastTime=data.time;
  const warned=evidence.warningCounts.some((count,i)=>count>(evidence.warningBaseline?.[i]??0));
  if(timeReset||warned)return 'MuJoCo reported a warning or reset. Reset the experiment';
  if(!Array.from(data.qpos).every(Number.isFinite)||!Array.from(data.qvel).every(Number.isFinite))
    return 'Physics became unstable. Reset the experiment';
  return null;
}

function geometryFor(model, id) {
  const t=model.geom_type[id], s=model.geom_size.slice(id*3,id*3+3);
  if(t===2) return new THREE.SphereGeometry(s[0],24,16);
  if(t===3) return new THREE.CapsuleGeometry(s[0],s[1]*2,8,16).rotateX(Math.PI/2);
  if(t===4) return new THREE.SphereGeometry(1,24,16).scale(...s);
  if(t===5) return new THREE.CylinderGeometry(s[0],s[0],s[1]*2,32).rotateX(Math.PI/2);
  if(t===6) return new THREE.BoxGeometry(s[0]*2,s[1]*2,s[2]*2);
  if(t===7) {
    const mesh=model.geom_dataid[id], va=model.mesh_vertadr[mesh]*3, fa=model.mesh_faceadr[mesh]*3;
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.Float32BufferAttribute(model.mesh_vert.slice(va,va+model.mesh_vertnum[mesh]*3),3));
    geometry.setIndex(Array.from(model.mesh_face.slice(fa,fa+model.mesh_facenum[mesh]*3)));
    geometry.computeVertexNormals();return geometry;
  }
  throw Error(`Unsupported Draft geometry ${t}`);
}

export async function createDraftLab(container,{onState=()=>{}}={}) {
  const renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,preserveDrawingBuffer:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.25;
  renderer.domElement.setAttribute('aria-label','Interactive Draft robot: drag to orbit, scroll to zoom');
  renderer.domElement.setAttribute('role','img');container.appendChild(renderer.domElement);
  const scene=new THREE.Scene();scene.background=new THREE.Color('#edece1');scene.fog=new THREE.Fog('#edece1',8,18);
  const camera=new THREE.PerspectiveCamera(38,1,.01,60);
  // Virtual torso-mounted sensor: actual physics orientation, never orbit-camera
  // orientation. The offscreen render target leaves the learner's view intact.
  const visionCamera=new THREE.PerspectiveCamera(70,640/400,.025,40);
  const visionTarget=new THREE.WebGLRenderTarget(640,400,{depthBuffer:true,stencilBuffer:false});
  visionTarget.texture.colorSpace=THREE.SRGBColorSpace;
  const visionCanvas=document.createElement('canvas');visionCanvas.width=640;visionCanvas.height=400;
  const visionPixels=new Uint8Array(640*400*4),visionFlipped=new Uint8ClampedArray(640*400*4);
  let visionFrameSequence=0,previewFrame=null;
  const controls=new OrbitControls(camera,renderer.domElement);
  controls.enableDamping=true;controls.minDistance=.6;controls.maxDistance=8;controls.maxPolarAngle=Math.PI/2-.02;
  scene.add(new THREE.HemisphereLight('#fff6df','#64796f',2.5));
  const key=new THREE.DirectionalLight('#fff3d5',4);key.position.set(-2,6,3);key.castShadow=true;
  key.shadow.mapSize.set(2048,2048);key.shadow.camera.left=-3;key.shadow.camera.right=3;
  key.shadow.camera.top=3;key.shadow.camera.bottom=-3;key.shadow.normalBias=.015;key.shadow.bias=-.0001;scene.add(key);
  const rim=new THREE.DirectionalLight('#d4eeee',2);rim.position.set(4,3,-3);scene.add(rim);
  const ground=new THREE.Mesh(new THREE.PlaneGeometry(200,200),new THREE.MeshStandardMaterial({color:'#e4e6da',roughness:.95}));
  ground.rotation.x=-Math.PI/2;ground.receiveShadow=true;scene.add(ground);
  const grid=new THREE.GridHelper(20,100,'#becbbd','#cdd5c8');grid.position.y=.001;scene.add(grid);
  const ring=new THREE.Mesh(new THREE.RingGeometry(1.7,1.72,96),new THREE.MeshBasicMaterial({color:'#72988a',side:THREE.DoubleSide}));
  ring.rotation.x=-Math.PI/2;ring.position.y=.003;scene.add(ring);
  const root=new THREE.Group();root.rotation.x=-Math.PI/2;scene.add(root);
  const trailVisuals=createTrailVisuals(scene);
  let mj,model=null,data=null,vfs=null,manifest=null,geomMeshes=[],disposed=false;
  let mode='pose',pose={crouch:0,wave:0},color='#60a894',error=null,peakContacts=0,dropStart=0;
  let loadSequence=0,raf,last=0,accumulator=0,lastEmit=0,physicsComplete=false;
  let controller=null,parkedRobot=null,walkManifest=null,walkLoading=false,walkSequence=0,walkBusy=false;
  let driveCommand=[0,0,0],walkError=null,walkDemo=null;
  let trail=null,trailSequence=0;
  let vision=null;
  function clearTrail(invalidate=true){if(invalidate)++trailSequence;trail=null;trailVisuals.update(null);ring.visible=true;}
  const matrix=new THREE.Matrix4();let joints=[],footGeoms=[],identityBase=.5;
  let physicsEvidence={stepCount:0,warningCounts:[],warningBaseline:[],lastTime:0,timeResets:0};
  function resetPhysicsEvidence() {
    const counts=readPhysicsWarningCounts(data);
    physicsEvidence={stepCount:0,warningCounts:counts,warningBaseline:[...counts],lastTime:data?.time??0,timeResets:0};
  }
  const robotState=()=>({model,data,vfs,geomMeshes,joints,footGeoms,identityBase});
  function destroyRobot(robot) {
    if(!robot)return;
    for(const mesh of robot.geomMeshes){root.remove(mesh);mesh.geometry.dispose();mesh.material.dispose();}
    robot.data?.delete();robot.model?.delete();robot.vfs?.delete();
  }
  function useRobot(robot) {
    ({model,data,vfs,geomMeshes,joints,footGeoms,identityBase}=robot);
    for(const object of geomMeshes)root.add(object);
  }
  function leaveWalking() {
    vision?.reset();previewFrame=null;
    clearTrail();
    ++walkSequence;walkLoading=false;driveCommand=[0,0,0];walkDemo=null;
    controller?.dispose();controller=null;walkManifest=null;walkError=null;
    if(parkedRobot){destroyRobot(robotState());useRobot(parkedRobot);parkedRobot=null;}
  }
  function clearRobot() {
    leaveWalking();destroyRobot(robotState());
    geomMeshes=[];data=model=vfs=null;
  }
  function snapshot() {
    const gait=controller?.snapshot();
    return {ready:!!model,preset:manifest?.preset??null,modelId:manifest?.id??null,mode,
      simTime:data?.time??0,contacts:data?.ncon??0,peakContacts,physicsComplete,
      baseHeight:data?.qpos[2]??0,droppedStartHeight:dropStart,
      finite:data?Array.from(data.qpos).every(Number.isFinite)&&Array.from(data.qvel).every(Number.isFinite):null,
      stepCount:gait?.physicsSteps??physicsEvidence.stepCount,warningCounts:[...(gait?.warningCounts??physicsEvidence.warningCounts)],
      warningBaseline:[...physicsEvidence.warningBaseline],timeResets:gait?.timeResets??physicsEvidence.timeResets,
      massKg:walkManifest?.model?.robotMass??manifest?.massKg??0,nq:model?.nq??0,nv:model?.nv??0,nu:model?.nu??0,
      geomCount:model?.ngeom??0,jointNames:joints.map(j=>j.name),qpos:data?Array.from(data.qpos):[],
      pose:{...pose},color,error,vision:vision?.snapshot()??null,
      walking:{...(gait??{}),ready:!!controller,active:mode==='walking',loading:walkLoading,
        error:walkError,simTime:controller?data.time:0,command:[...driveCommand],
        demo:walkDemo?{...walkDemo,remainingSeconds:Math.max(0,walkDemo.durationSeconds-((data?.time??0)-walkDemo.startSimTime))}:null,
        trail:trail?structuredClone(trail):null,
        modelSha256:walkManifest?.modelSha256??walkManifest?.xmlSha256??null},
      controller:controller?`Locally trained ${manifest?.preset==='flower'?'custom six-legged Flower':'Draft Cheetah'} PPO; ONNX Runtime Web, 50 Hz`:'none: passive body; pose mode uses forward kinematics',
      physicsEngine:'MuJoCo WASM 3.11.0',renderer:'Three.js',source:'Draft-generated MJCF'};
  }
  function emit(){onState(snapshot());}
  function sync() {
    if(!data)return;
    for(const mesh of geomMeshes) {
      const i=mesh.userData.geomId,p=i*3,r=i*9,a=data.geom_xmat;
      mesh.position.set(data.geom_xpos[p],data.geom_xpos[p+1],data.geom_xpos[p+2]);
      matrix.set(a[r],a[r+1],a[r+2],0,a[r+3],a[r+4],a[r+5],0,a[r+6],a[r+7],a[r+8],0,0,0,0,1);
      mesh.quaternion.setFromRotationMatrix(matrix);
    }
  }
  function setColor(value) {
    if(!/^#[0-9a-f]{6}$/i.test(value))throw Error('Use a six-digit hex colour');color=value;
    for(const mesh of geomMeshes) {
      const c=new THREE.Color(color),name=mesh.userData.name;
      if(name.endsWith('_sphere'))c.set('#394944');
      else if(name.endsWith('_motor'))c.multiplyScalar(.52);
      else if(name.endsWith('_detail'))c.multiplyScalar(.33);
      else if(name.endsWith('_link'))c.lerp(new THREE.Color('#ffffff'),.20);
      mesh.material.color.copy(c);
    }
    emit();
  }
  function poseModel(poseModel,poseData,poseJoints,poseFeet) {
    mj.mj_resetData(poseModel,poseData);
    poseData.qpos[0]=0;poseData.qpos[1]=0;poseData.qpos[2]=0;poseData.qpos[3]=1;poseData.qpos[4]=poseData.qpos[5]=poseData.qpos[6]=0;
    for(const j of poseJoints) {
      let value=j.name.endsWith('_knee')?-1.10-.95*pose.crouch:j.name.endsWith('_hip_pitch')?.55+.475*pose.crouch:0;
      if(j.name==='fl_hip_pitch')value-=1.25*pose.wave;
      if(j.name==='fl_knee')value-=.3*pose.wave;
      if(j.pose)value=j.pose.neutral+j.pose.crouch*pose.crouch+j.pose.wave*pose.wave;
      poseData.qpos[j.address]=Math.max(j.min,Math.min(j.max,value));
    }
    mj.mj_forward(poseModel,poseData);
    const footMin=Math.min(...poseFeet.map(i=>poseData.geom_xpos[i*3+2]-poseModel.geom_size[i*3]));
    poseData.qpos[2]=-footMin+.015;mj.mj_forward(poseModel,poseData);
    if(!Array.from(poseData.qpos).every(Number.isFinite))throw Error('Generated pose contains an invalid coordinate');
    return poseData.qpos[2];
  }
  function applyPose() {
    if(!model)return;identityBase=poseModel(model,data,joints,footGeoms);sync();
  }
  function setPose(next) {
    leaveWalking();
    pose={crouch:clamp01(next.crouch??pose.crouch),wave:clamp01(next.wave??pose.wave)};
    mode='pose';physicsComplete=false;peakContacts=0;dropStart=0;error=null;accumulator=0;applyPose();resetPhysicsEvidence();emit();
  }
  function reset(){leaveWalking();mode='pose';physicsComplete=false;peakContacts=0;dropStart=0;error=null;accumulator=0;applyPose();resetPhysicsEvidence();home();emit();}
  function drop() {
    if(!model)return;leaveWalking();applyPose();data.qpos[2]+=.35;data.qvel.fill(0);mj.mj_forward(model,data);
    dropStart=data.qpos[2];mode='physics';physicsComplete=false;peakContacts=0;error=null;accumulator=0;resetPhysicsEvidence();sync();emit();
  }
  function home(){
    const extent=Math.max(.9,identityBase*1.8);
    const x=controller?data.qpos[0]:0,z=controller?-data.qpos[1]:0;
    controls.target.set(x,Math.max(.25,identityBase*.55),z);camera.position.set(x+extent*2.0,extent*1.45,z+extent*2.2);controls.update();
    if(trail){controls.target.set(x+.7,.2,z);camera.position.set(x-.6,1.7,z+2.4);controls.update();}
    key.position.set(x-2,6,z+3);key.target.position.set(x,0,z);key.target.updateMatrixWorld();
  }
  async function loadModel(next) {
    const sequence=++loadSequence;
    leaveWalking();mode='pose';
    if(!next?.xmlUrl||!next?.meshUrl)throw Error('Draft model manifest is incomplete');
    const responses=await Promise.all([fetch(next.xmlUrl),fetch(next.meshUrl)]);
    if(responses.some(r=>!r.ok))throw Error('Could not load the generated robot assets');
    const [xml,mesh]=await Promise.all([responses[0].text(),responses[1].arrayBuffer()]);
    if(disposed||sequence!==loadSequence)return;
    const doc=new DOMParser().parseFromString(xml,'application/xml');
    if(doc.querySelector('parsererror'))throw Error('Invalid Draft MJCF');
    let option=doc.querySelector('option');
    if(!option){option=doc.createElement('option');doc.documentElement.appendChild(option);}
    option.setAttribute('timestep','0.002');
    const floor=doc.createElement('geom');
    Object.entries({name:'lab_floor',type:'plane',size:'8 8 0.1',rgba:'.8 .8 .7 1',friction:'.8 .1 .1'}).forEach(([k,v])=>floor.setAttribute(k,v));
    doc.querySelector('worldbody').appendChild(floor);
    let nextVfs,nextModel,nextData,nextHeight;
    const nextJoints=[],nextFeet=[],nextMeshes=[];
    try {
      nextVfs=new mj.MjVFS();nextVfs.addBuffer('torso_mesh.stl',new Uint8Array(mesh));
      nextModel=mj.MjModel.from_xml_string(new XMLSerializer().serializeToString(doc),nextVfs);nextData=new mj.MjData(nextModel);
      for(let i=1;i<nextModel.njnt;i++) {
        const name=mj.mj_id2name(nextModel,mj.mjtObj.mjOBJ_JOINT.value,i);
        const joint={name,address:nextModel.jnt_qposadr[i],min:nextModel.jnt_range[i*2],max:nextModel.jnt_range[i*2+1]};
        if(next.bodyPlan){
          const index=next.bodyPlan.jointNames.indexOf(name),roles=next.bodyPlan.poseRoles;
          if(index<0)throw Error(`Joint missing from body contract: ${name}`);
          const axis=index%3;
          // UI pose mapping only: the frozen Flower contract's original hint
          // stretches upward. This tested mapping actually lowers its torso.
          // It does not change the model, nominal training stance or policy.
          const crouch=next.preset==='flower'?[0,-.30,.45]:roles.crouchDelta;
          joint.pose={neutral:next.bodyPlan.nominalJointPositions[index],crouch:crouch[axis],wave:name.startsWith(roles.waveLeg+'_')?roles.waveDelta[axis]:0};
          if(!Object.values(joint.pose).every(Number.isFinite))throw Error('Invalid body pose contract');
        }
        nextJoints.push(joint);
      }
      for(let i=0;i<nextModel.ngeom;i++) {
        if(nextModel.geom_type[i]===0)continue;
        const name=mj.mj_id2name(nextModel,mj.mjtObj.mjOBJ_GEOM.value,i)??'';
        const geometry=geometryFor(nextModel,i);
        const mat=new THREE.MeshStandardMaterial({color:'#60a894',roughness:.38,metalness:.12});
        const meshObject=new THREE.Mesh(geometry,mat);meshObject.userData={geomId:i,name};
        meshObject.castShadow=true;meshObject.receiveShadow=true;nextMeshes.push(meshObject);
        if(next.bodyPlan?next.bodyPlan.footGeomNames.includes(name):name.endsWith('_sphere'))nextFeet.push(i);
      }
      const expected=next.preset==='flower'?[18,6]:[12,4];
      if(nextJoints.length!==expected[0]||nextFeet.length!==expected[1])throw Error('Generated joints or feet do not match the selected body');
      nextHeight=poseModel(nextModel,nextData,nextJoints,nextFeet);
    } catch(e) {
      for(const object of nextMeshes){object.geometry.dispose();object.material.dispose();}
      nextData?.delete();nextModel?.delete();nextVfs?.delete();throw e;
    }
    // Commit only after the full replacement has compiled, built and posed.
    clearRobot();model=nextModel;data=nextData;vfs=nextVfs;manifest=next;
    joints=nextJoints;footGeoms=nextFeet;geomMeshes=nextMeshes;identityBase=nextHeight;
    for(const object of geomMeshes)root.add(object);
    mode='pose';physicsComplete=false;peakContacts=0;dropStart=0;error=null;accumulator=0;
    resetPhysicsEvidence();sync();setColor(color);home();emit();
  }
  function clampDrive(command) {
    const flower=manifest?.preset==='flower';
    return [Math.max(flower?-.3:-.5,Math.min(flower ? .4 : .7,command[0])),0,Math.max(-.7,Math.min(.7,command[2]))];
  }
  function setDriveCommand(command) {
    const tookOver=vision?.cancel('manual');
    if(tookOver&&controller&&!walkError&&!controller.snapshot().fall)mode='walking';
    if(!Array.isArray(command)||command.length!==3||!command.every(Number.isFinite))throw Error('Expected [forward, sideways, turn]');
    driveCommand=clampDrive(command);
    if(mode!=='walking')driveCommand=[0,0,0];
    if(walkDemo?.active)walkDemo={...walkDemo,active:false,cancelled:true};
    if(trail?.assisted)trail={...trail,assisted:false};
  }
  function stopWalking() {
    vision?.cancel('paused');
    ++trailSequence;
    if(trail?.assisted)trail={...trail,assisted:false};
    if(walkLoading){++walkSequence;walkLoading=false;}
    driveCommand=[0,0,0];controller?.cancelStep?.();accumulator=0;
    if(walkDemo?.active)walkDemo={...walkDemo,active:false,cancelled:true};
    if(controller)mode='walk-paused';emit();
  }
  function resetWalking({preserveTrailRequest=false,preserveVision=false}={}) {
    if(!preserveVision){vision?.reset();previewFrame=null;}
    clearTrail(!preserveTrailRequest);
    if(!controller)return;driveCommand=[0,0,0];walkDemo=null;controller.reset();
    walkError=null;error=null;mode='walking';accumulator=0;peakContacts=0;
    resetPhysicsEvidence();sync();home();emit();
  }
  async function runWalkingDemo(command,seconds) {
    vision?.cancel('demo');
    if(!Number.isFinite(seconds)||seconds<=0||seconds>10)throw Error('Try a move for 1–10 simulated seconds');
    if(!controller||mode!=='walking')await startWalking();
    if(!controller||mode!=='walking')return;
    setDriveCommand(command);
    walkDemo={active:true,completed:false,cancelled:false,command:[...driveCommand],durationSeconds:seconds,
      startSimTime:data.time,startPosition:Array.from(data.qpos.slice(0,3))};emit();
  }
  async function startWalking({preserveVision=false}={}) {
    if(!preserveVision)vision?.cancel('manual');
    if(controller){
      if(mode==='walk-paused'&&!walkError&&!controller.snapshot().fall){driveCommand=[0,0,0];mode='walking';accumulator=0;emit();}
      else if(mode!=='walking')resetWalking({preserveVision});
      return;
    }
    if(walkLoading)return;
    const flower=manifest?.preset==='flower'&&manifest.parameters?.lengthScale===1&&manifest.parameters?.legScale===1;
    if(!flower&&manifest?.id!=='cheetah-31f2a9bfec7b90a8')throw Error('Walking needs a verified original-size body');
    const sequence=++walkSequence,modelSequence=loadSequence;
    walkLoading=true;walkError=null;error=null;emit();
    let candidate=null,nextController=null;
    try {
      if(flower){
        const readiness=await fetch('/api/flower-status',{cache:'no-store'});
        if(!readiness.ok||!(await readiness.json()).browserReady)throw Error('Flower movement validation is still pending');
      }
      const response=await fetch(`/controller/${flower?'flower':'cheetah'}/manifest.json`);
      if(!response.ok)throw Error('Walking assets unavailable');
      const config=await response.json();
      if(flower&&(config.rawBodyXmlSha256??config.sourceRobotXmlSha256)!==manifest.assetSha256?.['flower.xml'])throw Error('This flower differs from the trained body');
      if(flower&&config.sourceMeshSha256!==manifest.assetSha256?.['torso_mesh.stl'])throw Error('This flower mesh differs from the trained body');
      const xmlResponse=await fetch(config.xmlUrl);
      if(!xmlResponse.ok)throw Error('Walking model could not load');
      const xml=await xmlResponse.text();
      await verifyAssetHash(new TextEncoder().encode(xml),config.xmlSha256,'scene.xml');
      const assets=await Promise.all(config.assets.map(async asset=>{
        const r=await fetch(asset.url);if(!r.ok)throw Error(`Could not load ${asset.name}`);
        const bytes=new Uint8Array(await r.arrayBuffer());await verifyAssetHash(bytes,asset.sha256,asset.name);
        return [asset.name,bytes];
      }));
      if(disposed||sequence!==walkSequence||modelSequence!==loadSequence)return;
      candidate={vfs:new mj.MjVFS(),model:null,data:null,geomMeshes:[],joints:[],footGeoms:[],identityBase:config.initialQpos?.[2]??.4909090909090909};
      for(const [name,bytes] of assets)candidate.vfs.addBuffer(name,bytes);
      candidate.model=mj.MjModel.from_xml_string(xml,candidate.vfs);candidate.data=new mj.MjData(candidate.model);
      for(let i=1;i<candidate.model.njnt;i++) {
        const name=mj.mj_id2name(candidate.model,mj.mjtObj.mjOBJ_JOINT.value,i);
        candidate.joints.push({name,address:candidate.model.jnt_qposadr[i],min:candidate.model.jnt_range[i*2],max:candidate.model.jnt_range[i*2+1]});
      }
      for(let i=0;i<candidate.model.ngeom;i++) {
        if(candidate.model.geom_type[i]===0)continue;
        const name=mj.mj_id2name(candidate.model,mj.mjtObj.mjOBJ_GEOM.value,i)??'';
        const mesh=new THREE.Mesh(geometryFor(candidate.model,i),new THREE.MeshStandardMaterial({color,roughness:.38,metalness:.12}));
        mesh.userData={geomId:i,name};mesh.castShadow=true;mesh.receiveShadow=true;candidate.geomMeshes.push(mesh);
        if(name.endsWith('_sphere'))candidate.footGeoms.push(i);
      }
      nextController=await (flower?createFlowerController:createCheetahController)({mujoco:mj,model:candidate.model,data:candidate.data,policyUrl:config.policyUrl,manifest:config});
      if(disposed||sequence!==walkSequence||modelSequence!==loadSequence){nextController.dispose();destroyRobot(candidate);candidate=null;return;}
      parkedRobot=robotState();for(const mesh of geomMeshes)root.remove(mesh);
      useRobot(candidate);candidate=null;controller=nextController;nextController=null;walkManifest=config;
      setColor(color);resetWalking({preserveTrailRequest:true,preserveVision});
    } catch(e) {
      nextController?.dispose();destroyRobot(candidate);
      if(!disposed&&sequence===walkSequence){walkError=e.message;emit();throw e;}
    } finally {
      if(sequence===walkSequence){walkLoading=false;emit();}
    }
  }
  async function startTrail(assisted=false) {
    vision?.cancel('new_trail');
    // A new round always begins at the explicit reset stance. Model switches,
    // reset, hide, or stop during loading must invalidate this request.
    const request=++trailSequence,modelSequence=loadSequence;
    if(!controller)await startWalking();
    if(disposed||request!==trailSequence||modelSequence!==loadSequence||!controller||walkLoading)return;
    resetWalking();
    trail=createTrail(data.time,assisted);walkDemo=null;
    trailVisuals.update(trail);ring.visible=false;home();emit();
  }
  function setTrailAssist(enabled) {
    const tookOver=vision?.cancel('guide');
    if(tookOver&&controller&&!walkError&&!controller.snapshot().fall)mode='walking';
    if(!trail||trail.phase!=='active'||mode!=='walking')return;
    driveCommand=[0,0,0];walkDemo=null;trail={...trail,assisted:!!enabled};emit();
  }
  async function walkingTick() {
    const active=controller,sequence=walkSequence;
    walkBusy=true;
    try {
      const beforeX=data.qpos[0],beforeY=data.qpos[1];
      if(trail?.assisted)driveCommand=clampDrive(trailDrive(trail,active.snapshot()));
      await active.step([...driveCommand]);
      if(disposed||active!==controller||sequence!==walkSequence||mode!=='walking')return;
      const status=active.snapshot();
      if(trail?.phase==='active') {
        trail=updateTrail(trail,status);trailVisuals.update(trail);
        if(trail.phase!=='active'){
          driveCommand=[0,0,0];
          if(walkDemo?.active)walkDemo={...walkDemo,active:false,cancelled:true};
          // The environment ends a successful visual episode; checkpoint
          // coordinates never enter the model request or choose a direction.
          if(trail.phase==='complete')vision?.complete('trail_complete');
        }
      }
      peakContacts=Math.max(peakContacts,data.ncon);
      const dx=data.qpos[0]-beforeX,dz=-(data.qpos[1]-beforeY);
      // Follow translation, leaving the learner's orbit angle and zoom intact.
      camera.position.x+=dx;camera.position.z+=dz;controls.target.x+=dx;controls.target.z+=dz;
      key.position.x+=dx;key.position.z+=dz;key.target.position.set(data.qpos[0],0,-data.qpos[1]);
      key.target.updateMatrixWorld();
      sync();
      if(walkDemo?.active&&data.time-walkDemo.startSimTime>=walkDemo.durationSeconds-1e-8) {
        walkDemo={...walkDemo,active:false,completed:true,endedAtSimTime:data.time,
          displacement:Array.from(data.qpos.slice(0,3)).map((x,i)=>x-walkDemo.startPosition[i])};
        driveCommand=[0,0,0];
      }
      if(!status.fall&&!status.error)vision?.advance(data.time);
      if(status.fall||status.error){vision?.fail(status.error||'Robot fell; visual control stopped');walkError=status.error||'Your robot fell. Try again';stopWalking();}
    } catch(e) {
      if(!disposed&&active===controller&&sequence===walkSequence&&e.name!=='AbortError'){
        if(trail?.phase==='active'){trail=updateTrail(trail,{...active.snapshot(),error:e.message});trailVisuals.update(trail);}
        vision?.fail(e.message);walkError=e.message;stopWalking();
      }
    } finally {walkBusy=false;}
  }
  function freezeVision() {
    if(walkLoading){++walkSequence;walkLoading=false;}
    driveCommand=[0,0,0];controller?.cancelStep?.();accumulator=0;
    if(controller)mode='walk-paused';
  }
  function captureVision() {
    if(!model||!data||disposed)throw Error('Load a robot before using its camera');
    sync();
    const q=new THREE.Quaternion(data.qpos[4],data.qpos[5],data.qpos[6],data.qpos[3]);
    const origin=new THREE.Vector3(data.qpos[0],data.qpos[1],data.qpos[2]);
    const mount=new THREE.Vector3(.25,0,.30).applyQuaternion(q).add(origin);
    const forward=new THREE.Vector3(1,0,-.20).applyQuaternion(q);
    const up=new THREE.Vector3(0,0,1).applyQuaternion(q);
    visionCamera.position.set(mount.x,mount.z,-mount.y);
    visionCamera.up.set(up.x,up.z,-up.y);
    visionCamera.lookAt(mount.x+forward.x,mount.z+forward.z,-mount.y-forward.y);
    const previousTarget=renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(visionTarget);renderer.render(scene,visionCamera);
      renderer.readRenderTargetPixels(visionTarget,0,0,640,400,visionPixels);
      for(let row=0;row<400;row++)visionFlipped.set(visionPixels.subarray((399-row)*640*4,(400-row)*640*4),row*640*4);
      visionCanvas.getContext('2d').putImageData(new ImageData(visionFlipped,640,400),0,0);
    } finally {renderer.setRenderTarget(previousTarget);}
    const imageDataUrl=visionCanvas.toDataURL('image/png');previewFrame=imageDataUrl;
    return {imageDataUrl,observationId:`vision-${loadSequence}-${walkSequence}-${++visionFrameSequence}`,width:640,height:400};
  }
  vision=createVisionControl({
    prepare:async isCurrent=>{
      if(document.hidden)throw Error('Keep this tab visible for visual control');
      if(walkLoading)throw Error('Wait for the walking controller to finish loading');
      await startWalking({preserveVision:true});
      if(!isCurrent())return;
      if(!controller||walkLoading||walkError||controller.snapshot().fall)throw Error('A healthy learned walker is required');
      if(trail?.assisted)trail={...trail,assisted:false};
      if(walkDemo?.active)walkDemo={...walkDemo,active:false,cancelled:true};
      freezeVision();
    },capture:captureVision,freeze:freezeVision,
    context:()=>`${loadSequence}:${walkSequence}:${manifest?.id}:${document.hidden}:${disposed}`,
    getSimTime:()=>data?.time??0,getPosition:()=>data?Array.from(data.qpos.slice(0,3)):[],
    apply:command=>{driveCommand=clampDrive(command);mode='walking';accumulator=0;},onChange:emit,
  });
  const startVision=(instruction,options)=>vision.start(instruction,options);
  function stopVision(reason='user') {
    const wasActive=vision.cancel(reason);
    if(wasActive&&walkLoading){++walkSequence;walkLoading=false;}
    freezeVision();emit();
  }
  const onHidden=()=>{if(document.hidden){vision?.cancel('tab_hidden');driveCommand=[0,0,0];stopWalking();}};
  document.addEventListener('visibilitychange',onHidden);
  const resize=()=>{if(disposed)return;const w=container.clientWidth,h=container.clientHeight;if(!w||!h)return;renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();};
  const observer=new ResizeObserver(resize);observer.observe(container);resize();
  function frame(now) {
    if(disposed)return;const dt=Math.min((now-last)/1000||0,.05);last=now;
    if(data&&mode==='physics'&&!physicsComplete&&!error&&!document.hidden) {
      accumulator+=dt;
      while(accumulator>=.002) {
        const fault=stepDraftPhysics(mj,model,data,physicsEvidence);accumulator-=.002;peakContacts=Math.max(peakContacts,data.ncon);
        if(fault){error=fault;physicsComplete=true;break;}
        if(data.time>=4){physicsComplete=true;break;}
      }
      if(!error)mj.mj_forward(model,data);sync();
    }
    if(controller&&mode==='walking'&&!document.hidden&&!walkError) {
      accumulator=Math.min(accumulator+dt,.06);
      if(accumulator>=.02&&!walkBusy){accumulator-=.02;void walkingTick();}
    }
    controls.update();renderer.render(scene,camera);
    if(now-lastEmit>150){emit();lastEmit=now;}raf=requestAnimationFrame(frame);
  }
  home();raf=requestAnimationFrame(frame);
  try{mj=await(enginePromise??=loadMujoco({locateFile:p=>p.endsWith('.wasm')?wasmUrl:p}));}
  catch(e){enginePromise=null;vision?.dispose();visionTarget.dispose();document.removeEventListener('visibilitychange',onHidden);observer.disconnect();cancelAnimationFrame(raf);controls.dispose();scene.traverse(o=>{o.geometry?.dispose();if(o.material){for(const material of Array.isArray(o.material)?o.material:[o.material])material.dispose();}});renderer.dispose();renderer.domElement.remove();throw e;}
  const api={startVision,stopVision,captureVision,getVisionFrame:()=>previewFrame,loadModel,setPose,setColor,drop,reset,home,snapshot,startWalking,stopWalking,resetWalking,setDriveCommand,runWalkingDemo,startTrail,setTrailAssist,
    capture:()=>renderer.domElement.toDataURL('image/png'),
    dispose(){vision.dispose();visionTarget.dispose();disposed=true;loadSequence++;document.removeEventListener('visibilitychange',onHidden);cancelAnimationFrame(raf);observer.disconnect();controls.dispose();clearRobot();trailVisuals.dispose();scene.traverse(o=>{o.geometry?.dispose();if(o.material){for(const material of Array.isArray(o.material)?o.material:[o.material])material.dispose();}});renderer.dispose();renderer.domElement.remove();if(window.draftLab===api)delete window.draftLab;}
  };window.draftLab=api;return api;
}
