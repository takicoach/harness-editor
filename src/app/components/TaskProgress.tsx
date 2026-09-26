import './TaskProgress.css';

export interface TransferProgress {phase:'uploading'|'checking'|'preparing';loaded?:number;total?:number}
/** Undefined values mean unmeasured work. Never estimate a percentage from time. */
export function TaskProgress({label,value,compact=false,detail}:{label:string;value?:number;compact?:boolean;detail?:string}) {
  const progress=typeof value==='number'&&Number.isFinite(value)?Math.max(0,Math.min(1,value)):undefined;
  const percent=progress===undefined?undefined:Math.round(progress*100);
  return <div className={`task-progress ${compact?'is-compact':''} ${progress===undefined?'is-indeterminate':''}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={percent===undefined?label:`${label} ${percent}%`}>
    <span className="task-progress-ring" aria-hidden="true"><svg viewBox="0 0 44 44"><circle className="task-progress-track" cx="22" cy="22" r="18"/><circle className="task-progress-fill" cx="22" cy="22" r="18" pathLength="100" strokeDasharray={`${percent??28} 100`}/></svg>{!compact&&percent!==undefined&&<b>{percent}<small>%</small></b>}</span>
    <span className="task-progress-copy"><span>{label}{compact&&percent!==undefined?` · ${percent}%`:''}</span>{detail&&<small>{detail}</small>}{!compact&&progress!==undefined&&<span className="task-progress-bar" aria-hidden="true"><i style={{width:`${percent}%`}}/></span>}</span>
  </div>;
}
