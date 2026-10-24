// Bounded visual decisions. This module never supplies a substitute planner:
// every move must arrive from the local adapter and match the captured frame.
const COMMANDS = Object.freeze({forward:[.35,0,0],backward:[-.2,0,0],turn_left:[0,0,.5],turn_right:[0,0,-.5],stand:[0,0,0]});
export const VISION_MAX_DECISIONS = 30;
export const VISION_MAX_SIM_SECONDS = 60;
const activePhase = phase => phase === 'thinking' || phase === 'moving';
export function validateVisionDecision(value, observationId) {
  if (!value || value.ok !== true || value.executesMotion !== false || value.observationId !== observationId ||
      typeof value.decisionId !== 'string' || !value.decisionId || value.decisionId.length > 160 ||
      value.provenance?.source !== 'local_vlm' || typeof value.provenance.model !== 'string' || !value.provenance.model || value.provenance.model.length>160 ||
      !/^[a-f0-9]{64}$/.test(value.provenance.imageSha256 ?? '')) throw Error('Invalid or stale visual decision');
  const a=value.action, expected=Object.hasOwn(COMMANDS,a?.operation)?COMMANDS[a.operation]:null;
  if (!a || Object.keys(a).sort().join(',') !== 'durationSeconds,operation,vx,vy,wz' || !expected ||
      typeof a.durationSeconds !== 'number' || !Number.isFinite(a.durationSeconds) ||
      (a.operation === 'stand' ? a.durationSeconds !== 0 : a.durationSeconds < .1 || a.durationSeconds > 2) ||
      !['vx','vy','wz'].every((key,i) => a[key] === expected[i])) throw Error('Visual action exceeds the movement contract');
  return {action:{...a},decisionId:value.decisionId,observationId,provenance:{...value.provenance}};
}

export function createVisionControl({prepare,capture,apply,freeze,context,getSimTime,getPosition=()=>[],onChange=()=>{},
  request=async (body,signal)=>{
    const response=await fetch('/vlm/decide',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
    const value=await response.json().catch(()=>{throw Error('Vision service returned an unreadable response');});
    if(!response.ok)throw Error(value?.error?.message||value?.message||`Vision service unavailable (${response.status})`);
    return value;
  },timeoutMs=125000}={}) {
  let generation=0,abort=null,timer=null,image=null,sessionContext=null,instruction='',startPosition=[];
  let state={phase:'idle',active:false,action:null,remainingSeconds:0,completedSteps:0,maxSteps:6,elapsedSeconds:0,
    lastDecision:null,error:null,reason:null,history:[],frame:null};
  const current=token=>token===generation&&activePhase(state.phase);
  const emit=()=>onChange();
  function clearRequest(){if(timer!==null)clearTimeout(timer);timer=null;abort?.abort();abort=null;}
  function finish(phase,reason,error=null) {
    ++generation;clearRequest();freeze();
    state={...state,phase,active:false,remainingSeconds:0,reason,error};emit();
  }
  function cancel(reason='user') {
    // Invalidate a response even when its fetch implementation ignores abort.
    if(!activePhase(state.phase)){++generation;clearRequest();return false;}
    finish('cancelled',reason);return true;
  }
  function reset() {
    // A different body or a return to pose starts a fresh visual experiment.
    // Never label a previous body's image/decisions as this body's evidence.
    cancel('body_or_pose_changed');image=null;sessionContext=null;instruction='';startPosition=[];
    state={phase:'idle',active:false,action:null,remainingSeconds:0,completedSteps:0,maxSteps:6,elapsedSeconds:0,
      lastDecision:null,error:null,reason:null,history:[],frame:null};emit();
  }
  function fail(message){if(activePhase(state.phase))finish('error','error',String(message));}
  function complete(reason='completed') {
    if(!activePhase(state.phase))return false;
    if(state.phase==='moving') {
      const now=getSimTime(),elapsed=Math.max(0,now-state.actionStartSimTime),position=getPosition();
      const last=state.history.at(-1);
      state.history=[...state.history.slice(0,-1),{...last,endSimTime:now,executedSeconds:elapsed,
        displacement:position.map((x,i)=>x-startPosition[i]),terminationReason:reason}];
      state.completedSteps++;state.elapsedSeconds+=elapsed;
    }
    finish('done',reason);return true;
  }
  async function decide(token) {
    if(!current(token))return;
    try {
      if(context()!==sessionContext)throw Error('Robot session changed before visual observation');
      freeze();state={...state,phase:'thinking',active:true,remainingSeconds:0};
      const frame=capture();image=frame.imageDataUrl;
      if(typeof image!=='string'||!image.startsWith('data:image/png;base64,'))throw Error('Camera did not return a PNG image');
      const bytes=Uint8Array.from(atob(image.slice('data:image/png;base64,'.length)),c=>c.charCodeAt(0));
      const digest=await crypto.subtle.digest('SHA-256',bytes);
      const imageSha256=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
      if(!current(token))return;
      state.frame={observationId:frame.observationId,width:frame.width??640,height:frame.height??400,simTime:getSimTime()};emit();
      abort=new AbortController();const ownAbort=abort;
      timer=setTimeout(()=>{if(current(token))fail('Vision request timed out; robot paused');},timeoutMs);
      const value=await request({instruction,imageDataUrl:image,observationId:frame.observationId},ownAbort.signal);
      if(!current(token))return;
      clearRequest();
      if(context()!==sessionContext)throw Error('Robot session changed while vision was thinking');
      const decision=validateVisionDecision(value,frame.observationId);
      // The adapter validates the pixels it received; bind its digest to this
      // exact local frame so a cached/incorrect response cannot issue a move.
      if(decision.provenance.imageSha256!==imageSha256)throw Error('Visual decision image hash does not match');
      const action=decision.action,now=getSimTime();startPosition=[...getPosition()];
      state={...state,lastDecision:decision,action,history:[...state.history,{step:state.completedSteps+1,...decision,
        operation:action.operation,durationSeconds:action.durationSeconds,startSimTime:now}].slice(-VISION_MAX_DECISIONS)};
      if(action.operation==='stand'){state.completedSteps++;finish('done','model_stand');return;}
      if(state.elapsedSeconds+action.durationSeconds>VISION_MAX_SIM_SECONDS+1e-8)throw Error('Visual motion budget exceeded');
      state={...state,phase:'moving',remainingSeconds:action.durationSeconds,actionStartSimTime:now};
      apply([action.vx,action.vy,action.wz]);emit();
    } catch(error) {if(current(token))fail(error?.message??error);}
  }
  async function start(nextInstruction,{maxSteps=6}={}) {
    if(typeof nextInstruction!=='string'||!nextInstruction.trim()||nextInstruction.trim().length>2000)throw Error('Enter an instruction of 1–2000 characters');
    if(!Number.isInteger(maxSteps)||maxSteps<1||maxSteps>VISION_MAX_DECISIONS)throw Error(`Choose 1–${VISION_MAX_DECISIONS} visual decisions`);
    cancel('restarted');const token=++generation;instruction=nextInstruction.trim();image=null;
    state={phase:'thinking',active:true,action:null,remainingSeconds:0,completedSteps:0,maxSteps,elapsedSeconds:0,
      lastDecision:null,error:null,reason:null,history:[],frame:null};emit();
    try {
      await prepare(()=>current(token));if(!current(token))return;
      sessionContext=context();await decide(token);
    } catch(error) {if(current(token))fail(error?.message??error);}
  }
  function advance(simTime=getSimTime()) {
    if(state.phase!=='moving')return;
    if(context()!==sessionContext){fail('Robot session changed during visual movement');return;}
    const elapsed=simTime-state.actionStartSimTime;
    if(!Number.isFinite(elapsed)||elapsed<0){fail('Simulation time changed during visual movement');return;}
    state.remainingSeconds=Math.max(0,state.action.durationSeconds-elapsed);
    if(elapsed+1e-8<state.action.durationSeconds)return;
    freeze();const position=getPosition(),last=state.history.at(-1);
    state.history=[...state.history.slice(0,-1),{...last,endSimTime:simTime,executedSeconds:elapsed,displacement:position.map((x,i)=>x-startPosition[i])}];
    state.completedSteps++;state.elapsedSeconds+=elapsed;
    if(state.completedSteps>=state.maxSteps||state.elapsedSeconds>=VISION_MAX_SIM_SECONDS-1e-8){finish('done','step_limit');return;}
    void decide(generation);
  }
  return {start,cancel,reset,fail,complete,advance,getFrame:()=>image,snapshot:()=>structuredClone(state),
    dispose(){cancel('disposed');image=null;},isActive:()=>activePhase(state.phase)};
}
