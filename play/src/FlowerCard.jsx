import { useEffect, useState } from 'react';
import './training-card.css';

export default function FlowerCard({language,onStatus}) {
  const zh=language==='zh', [status,setStatus]=useState(null), [offline,setOffline]=useState(false);
  useEffect(()=>{
    let closed=false,timer,request;
    async function update(){
      request=new AbortController();const timeout=setTimeout(()=>request.abort(),4000);
      try{const r=await fetch('/api/flower-status',{signal:request.signal,cache:'no-store'});if(!r.ok)throw Error('offline');const s=await r.json();if(!closed){setStatus(s);setOffline(false);onStatus?.(s);}}
      catch{if(!closed){setOffline(true);onStatus?.(null);}}
      finally{clearTimeout(timeout);if(!closed)timer=setTimeout(update,4000);}
    }
    update();return()=>{closed=true;clearTimeout(timer);request?.abort();};
  },[onStatus]);
  const labels=zh?{preparing:'准备练习',starting:'正在准备',running:'练习中',completed:'训练结束 · 等待验证',failed:'本次练习未完成',stopped:'练习已停止',verified:'已通过运动测试'}:{preparing:'Preparing to practice',starting:'Getting ready',running:'Practicing',completed:'Training finished · Validation pending',failed:'Practice incomplete',stopped:'Practice stopped',verified:'Movement tests passed'};
  const count=status?.iterationsObserved??0,total=status?.iterationsRequested??0;
  const phase=(zh?{smoke:'训练流程试跑',capacity:'计算资源测试',full:'正式步态训练'}:{smoke:'Training smoke test',capacity:'Compute capacity test',full:'Gait training'})[status?.phase];
  const statusLabel=status?.status==='completed'&&status?.phase!=='full'?(zh?'准备测试通过':'Preparation test passed'):labels[status?.status]||labels.preparing;
  return <section className="training-card flower-card" aria-label={zh?'花朵的成长日记':"Flower's learning diary"}>
    <div className="training-heading"><div><span className="draft-eyebrow">{zh?'一个不一样的身体': 'A DIFFERENT KIND OF BODY'}</span><h2>{zh?'六条腿，要怎样一起迈步？':'How do six legs learn to move together?'}</h2></div><span className="training-badge">{offline?(zh?'状态暂不可用':'Status unavailable'):status?.stale?(zh?'状态更新已延迟':'Status update delayed'):statusLabel}</span></div>
    <p className="training-intro">{zh?'这是一种新设计：六条放射状腿、18 个关节。身体由 Draft 生成，动作需要单独学习。':'A new design: six radial legs and 18 joints. Draft generates the body; movement needs its own training.'}</p>
    {total>0&&<><div className="training-progress-label"><label htmlFor="flower-progress">{phase|| (zh?'训练轮次':'Training iterations')}</label><span>{count.toLocaleString()} / {total.toLocaleString()}</span></div><progress id="flower-progress" max={total} value={Math.min(count,total)}/></>}
    <dl className="training-numbers"><div><dt>{zh?'腿的数量':'Legs'}</dt><dd>6</dd></div><div><dt>{zh?'活动关节':'Moving joints'}</dt><dd>18</dd></div><div><dt>{zh?'本次练习':'This practice run'}</dt><dd>{Number.isFinite(status?.elapsedSeconds)?Math.floor(status.elapsedSeconds/60):'—'} <small>{zh?'分钟':'min'}</small></dd></div></dl>
    <details className="training-explainer"><summary>{zh?'我的电脑要做哪些工作？':'What does my computer need to do?'}</summary><p className="training-note">{zh?'训练时，GPU 并行模拟许多花朵并学习动作，显存存放这些状态。浏览器试玩时，CPU 运行物理和已学策略，GPU 绘制画面。':'During training, the GPU simulates many flowers and learns their movements; VRAM holds their state. In this browser, the CPU runs physics and the learned policy while the GPU draws the scene.'}</p><p className="training-note">{zh?'本次训练进程采样峰值':'Sampled peak for this training process'}: {Number.isFinite(status?.peakOwnedGpuMiB)?(status.peakOwnedGpuMiB/1024).toFixed(1):'—'} GiB {zh?'显存':'VRAM'} · {Number.isFinite(status?.peakOwnedRamMiB)?(status.peakOwnedRamMiB/1024).toFixed(1):'—'} GiB RAM. {zh?'这是本次用量，不是最低硬件要求。':'This is measured usage, not a minimum hardware requirement.'}</p></details>
    <p className="training-note">{status?.status==='verified'?(zh?'可以用摇杆试试原始尺寸的花朵。改变身体比例后，需要重新验证动作。':'Try the original-size flower with the joystick. Changed proportions need new movement validation.'):(zh?'现在可以观察身体、改变比例、抬腿和尝试重力。训练完成后，还要验证站立、前进和转向。':'Explore the body, change proportions, lift a leg and try gravity. After training, standing, forward motion and turning still need testing.')}</p>
    {status?.browserReady&&status.evaluation?.rows?.length>0&&<div className="training-evaluation"><h3>{zh?'它现在学会了什么？':'What has it learned?'}</h3><div className="training-table-wrap"><table><thead><tr><th>{zh?'指令':'Command'}</th><th>{zh?'实测平均速度':'Measured mean speed'}</th><th>{zh?'动作测试':'Movement test'}</th></tr></thead><tbody>{status.evaluation.rows.map(row=>{const turn=row.name==='turn_left',axis=turn?2:0;return <tr key={row.name}><td>{row.name==='stationary'?(zh?'零速度':'Zero speed'):turn?(zh?'转向':'Turn'):(zh?'前进':'Forward')} {row.command[axis]} {turn?'rad/s':'m/s'}</td><td>{row.meanActualVelocity[axis].toFixed(3)} {turn?'rad/s':'m/s'}</td><td>{row.pass?'✓':'—'}</td></tr>;})}</tbody></table></div><p className="training-note">{zh?'每项为原始尺寸身体的一次 WASM 测试：2 秒适应、10 秒测量。零速度时可能原地踏步；这还不是硬件或障碍环境验证。':'One nominal-body WASM test per command: 2 s settling, 10 s measured. It may step in place at zero speed. Hardware and obstacle environments remain untested.'}</p></div>}
    <p className="training-scope">{zh?'实验性自定义设计 · 质量与电机参数是工程假设，尚未制造验证':'Experimental custom design · Mass and motor parameters are engineering assumptions, not hardware validation'}</p>
  </section>;
}
