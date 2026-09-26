import './native-save-progress.css';

export function NativeSaveProgress({percent}:{percent:number}){
  const value=Math.max(0,Math.min(100,Math.round(percent))),complete=value===100;
  const stage=value<10?'入力を確認中':value<30?'保存を準備中':value<80?'書き込み中':value<100?'保存結果を確認中':'保存完了';
  return <div className="native-save-progress" data-complete={complete} role="progressbar" aria-label={complete?'保存完了':'保存中'}
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-valuetext={`${stage} ${value}%`}>
    <span className="native-save-ring" aria-hidden="true">
      <svg viewBox="0 0 28 28" className="native-save-orbit">
        <circle className="native-save-ring-track" cx="14" cy="14" r="11"/>
        <circle className="native-save-ring-value" cx="14" cy="14" r="11" pathLength="100" strokeDasharray="100" strokeDashoffset={100-Math.max(4,value)}/>
      </svg>
      {complete&&<svg viewBox="0 0 28 28" className="native-save-check"><path d="m8.5 14 3.5 3.5 7.5-7" pathLength="1"/></svg>}
    </span>
    <span className="native-save-progress-label">{complete?'保存完了':'保存中'} <span>{value}%</span></span>
  </div>;
}
