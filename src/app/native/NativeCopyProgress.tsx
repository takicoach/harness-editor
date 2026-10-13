import {useState} from 'react';
import {COPY_CANCEL_NOTE,COPY_DRIVE_WARNING,COPY_ELSEWHERE_NOTE,COPY_PHASE_LABEL,COPY_WAITING_VOLUME_NOTE,ceilGigabytes,floorGigabytes,formatMinutes,stillNeedsSource,type CopyJobItemView,type CopyJobView} from '../../shared/mediaCopy';
import './native-media-copy.css';

const speed=(bytesPerSecond:number)=>`${Math.round(bytesPerSecond/1e6)} MB/秒`;
const names=(heading:string,items:readonly CopyJobItemView[],withError=false)=>items.length>0&&<div className="native-copy-group"><p>{heading}</p>
  <ul>{items.map(item=><li key={item.itemId}>{`${item.name}${withError&&item.error?`: ${item.error}`:''}`}</li>)}</ul></div>;
/** 何本が完了したか。失敗が1本でもあれば失敗の本数を添える（finished でも失敗を含みうる: 1本の失敗では残りを続ける）。 */
function count(job:CopyJobView):string{
  const done=job.items.filter(item=>item.phase==='done').length,failed=job.items.filter(item=>item.phase==='failed').length;
  return job.state==='finished'&&!failed?`${done} 本`:`${done} / ${job.items.length} 本が完了${failed?`・${failed} 本は失敗`:''}`;
}
/** コピー先の場所（表示名だけ。パスは出さない）。ドライブ・このMac は「Harness 素材」フォルダーの中、場所を指定した時はそのフォルダー。 */
const destinationText=(destination:CopyJobView['destination'])=>destination.kind==='custom'?`コピー先: ${destination.label}`:`コピー先: 「${destination.label}」の「Harness 素材」フォルダー`;
/** 完了の通知（この画面で走っているのを見ていた作業が終わった・止まった時。useMediaCopyJobs の onSettled）。 */
export function copySettledMessage(job:CopyJobView):string{
  const failed=job.items.some(item=>item.phase==='failed');
  return job.state==='finished'?`速いドライブへのコピーが終わりました（${count(job)}）。${failed?'失敗した素材は元の媒体を使います':'素材はコピー先を使います'}`
    :job.state==='waiting-volume'?`速いドライブへのコピーが止まりました（${count(job)}）。${COPY_WAITING_VOLUME_NOTE}`
    :`速いドライブへのコピーを止めました（${count(job)}）。素材の欄で内容を確かめてください`;
}
const without=(set:ReadonlySet<string>,key:string)=>{const next=new Set(set);next.delete(key);return next;};
/**
 * 進み具合（設計 §6）: 何本中何本目・段（コピー中／コピーを確認中／接続を変更中）・速度・残り時間の幅。「残りを中止」は完了分を残すことを明記する。
 * 終わった作業は、接続を変えた素材／失敗した素材／未完了の素材／まだ元の媒体が要る素材を分けて示す（失敗・中止の理由はサーバの決まった文言をそのまま出す）。
 * このエディターが動かしていない作業（notThisProcess）は進み具合と「残りを中止」を出さず注記だけ。
 * ドライブの接続待ち（waiting-volume）は段ではなく注記と分類。閉じられない（記録は回収のため残す）ので「この表示を隠す」で画面だけ隠す（状態が変われば、また出す）。
 * onCancel・onDismiss が失敗を返したら（Promise の拒否）、もう一度押せるようにする。
 */
export function NativeCopyProgress({jobs,onCancel,onDismiss}:{jobs:readonly CopyJobView[];onCancel(jobId:string):void|Promise<unknown>;onDismiss(jobId:string):void|Promise<unknown>}){
  // stopping: 「残りを中止」を押した作業（接続を変更中の1本は最後まで行うので、すぐには止まらない）。dismissing: 「閉じる」を押した作業。hidden: 隠した作業と状態
  const [stopping,setStopping]=useState<ReadonlySet<string>>(new Set()),[dismissing,setDismissing]=useState<ReadonlySet<string>>(new Set()),[hidden,setHidden]=useState<ReadonlySet<string>>(new Set());
  const shown=jobs.filter(job=>!hidden.has(`${job.jobId}:${job.state}`));
  if(!shown.length)return null;
  return <section className="native-copy-jobs" aria-label="速いドライブへのコピー">{shown.map(job=>{
    const done=job.items.filter(item=>item.phase==='done'),failed=job.items.filter(item=>item.phase==='failed'),unfinished=job.items.filter(item=>item.phase!=='done'&&item.phase!=='failed');
    const total=job.items.reduce((sum,item)=>sum+item.sizeBytes,0),copied=job.items.reduce((sum,item)=>sum+item.bytesDone,0),current=job.current?job.items[job.current.index]:undefined;
    const pace=[job.current?.bytesPerSecond?`速さ ${speed(job.current.bytesPerSecond)}`:'',job.current?.remaining?`残り 約 ${formatMinutes(job.current.remaining.minSeconds)}〜${formatMinutes(job.current.remaining.maxSeconds)} 分`:''].filter(Boolean).join('・');
    // 1本目の前（current が無く、どれも待ち）は、同じ媒体の別のファイルの照合が読み終わるのを待っている（設計 §5 の調停）
    const status=pace||(!job.current&&job.items.every(item=>item.phase==='waiting')?'元の媒体のほかの確認が終わるのを待っています':'速さを測っています…');
    const groups=<>
      {names('接続を変えた素材（コピー先を使います）',done)}
      {names('失敗した素材',failed,true)}
      {names('未完了の素材',unfinished,true)}
      {names('まだ元の媒体が要る素材',job.items.filter(stillNeedsSource))}
      <p className="native-subtle">{destinationText(job.destination)}</p>
      {job.kept?.length?<p className="native-subtle">{`自分のものと確かめられず、コピー先に消さずに残したファイル: ${job.kept.join('、')}（ほかの素材が使っていることがあります。消す前に中身を確かめてください）`}</p>:null}
    </>;
    const body=job.state==='running'&&job.notThisProcess?<p>{COPY_ELSEWHERE_NOTE}</p>
      :job.state==='running'?<>
        <p><strong>{`速いドライブ（${job.destination.label}）へコピーしています: ${job.items.length} 本中 ${Math.min(job.items.length,(job.current?.index??done.length+failed.length)+1)} 本目`}</strong></p>
        {current&&<p className="native-copy-phase">{`${current.name}: ${COPY_PHASE_LABEL[current.phase]}`}</p>}
        <progress max={total||1} value={copied} aria-label="コピーの進み具合"/>
        <p className="native-subtle">{`${floorGigabytes(copied)} / ${ceilGigabytes(total)} GB　${status}`}</p>
        <p className="native-copy-warning">{COPY_DRIVE_WARNING}</p>
        <div className="native-import-actions"><button type="button" className="btn-ghost" disabled={stopping.has(job.jobId)}
          onClick={()=>{setStopping(previous=>new Set([...previous,job.jobId]));void Promise.resolve(onCancel(job.jobId)).catch(()=>setStopping(previous=>without(previous,job.jobId)));}}>残りを中止</button>
          <small>{stopping.has(job.jobId)?`中止しています…（${COPY_CANCEL_NOTE}）`:COPY_CANCEL_NOTE}</small></div>
      </>
      :job.state==='waiting-volume'?<>
        <p>{COPY_WAITING_VOLUME_NOTE}</p>{job.stopReason&&<p className="native-subtle">{job.stopReason}</p>}{groups}
        <div className="native-import-actions"><button type="button" className="btn-ghost" onClick={()=>setHidden(previous=>new Set([...previous,`${job.jobId}:${job.state}`]))}>この表示を隠す</button>
          <small>記録は残します（ドライブを接続すると片付けます）</small></div>
      </>
      :<>
        <p><strong>{job.state==='finished'?`コピーが終わりました（${count(job)}）`:`コピーを止めました（${count(job)}）`}</strong></p>
        {job.state==='stopped'&&job.stopReason&&<p className="native-subtle">{job.stopReason}</p>}
        {groups}
        <div className="native-import-actions"><button type="button" className="btn-ghost" disabled={dismissing.has(job.jobId)}
          onClick={()=>{setDismissing(previous=>new Set([...previous,job.jobId]));void Promise.resolve(onDismiss(job.jobId)).catch(()=>setDismissing(previous=>without(previous,job.jobId)));}}>閉じる</button></div>
      </>;
    return <div key={job.jobId} className="native-copy-job" data-copy-job={job.jobId} data-state={job.state}>{body}</div>;})}</section>;
}
