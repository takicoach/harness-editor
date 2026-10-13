import {useEffect,useState} from 'react';
import {COPY_DRIVE_WARNING,COPY_GB_NOTE,COPY_SPACE_NOTE,ceilGigabytes,floorGigabytes,formatMinutes,type CopyDestinationRequest,type CopyDestinationView} from '../../shared/mediaCopy';
import {MediaPicker} from '../panels/MediaPicker';
import {copyErrorMessage,fetchCopyDestinations,type CopyTargets} from './mediaCopyApi';
import './native-media-copy.css';

const TIME_NOTE='所要時間は、元の媒体の読み取り・コピー先への書き込み・書き先の照合を合わせた目安です。書き込みの速さは測っていないため、幅で示します';
/**
 * コピー先を選ぶ（設計 §3・§4）。既定はドライブだけ選ぶ。「場所を指定…」も同じ検査を通す（選べない時は理由を出す）。
 * 選んだ候補の識別（UUID・dev）を開始の要求に入れ、サーバが開始時に今の識別と照合する。始められなかった時は理由を出し、候補を調べ直す（選び直せるように）。
 * 空き・コピー後の空きは 0.1GB 単位の切り捨て、コピーする量は切り上げ（サーバの理由の文と同じ丸め）。空きを測る前に断った候補（space:null）は理由だけを出す。
 * 画面に出す失敗の文はサーバの決まった文言だけ（通信の失敗などの英文は出さない）。
 */
export function NativeCopyDestinationDialog({projectId,targets,onStart,onCancel}:{projectId:string;targets:CopyTargets;onStart(request:CopyDestinationRequest):Promise<void>;onCancel():void}){
  const [customPath,setCustomPath]=useState<string|undefined>(),[list,setList]=useState<{destinations:CopyDestinationView[];totalBytes:number}|null>(null),[loading,setLoading]=useState(true);
  const [chosen,setChosen]=useState<string|null>(null),[listError,setListError]=useState<string|null>(null),[startError,setStartError]=useState<string|null>(null);
  const [picking,setPicking]=useState(false),[starting,setStarting]=useState(false),[reload,setReload]=useState(0);
  const targetKey=JSON.stringify(targets);
  useEffect(()=>{
    let live=true;setListError(null);setLoading(true);
    fetchCopyDestinations(projectId,JSON.parse(targetKey) as CopyTargets,customPath).then(next=>{
      if(!live)return;setList(next);
      const custom=customPath?next.destinations.find(item=>item.key==='custom'&&item.selectable):undefined;
      setChosen(current=>custom?'custom':next.destinations.some(item=>item.key===current&&item.selectable)?current:next.destinations.find(item=>item.recommended)?.key??null);
    }).catch(reason=>{if(live)setListError(copyErrorMessage(reason,'コピー先を調べられませんでした。'));}).finally(()=>{if(live)setLoading(false);});
    return ()=>{live=false;};
  },[projectId,targetKey,customPath,reload]);
  const selected=list?.destinations.find(item=>item.key===chosen&&item.selectable);
  const start=async()=>{
    if(!selected)return;setStarting(true);setStartError(null);
    try{await onStart({key:selected.key,uuid:selected.volume.uuid,dev:selected.volume.dev,...(selected.key==='custom'&&customPath?{customPath}:{})});}
    catch(reason){setStartError(copyErrorMessage(reason,'コピーを始められませんでした。'));setReload(value=>value+1);}
    finally{setStarting(false);}
  };
  return <>
    {/* 始めている間（開始の確認中）は閉じない: 閉じても作業は始まりうるため、結果（始まった・理由）を見せるまで待つ */}
    <div className="export-overlay" onClick={()=>{if(!starting)onCancel();}}><div className="export-dialog native-copy-dialog" role="dialog" aria-modal="true" aria-label="コピー先を選ぶ" onClick={event=>event.stopPropagation()}>
      <div className="export-head">コピー先を選ぶ</div>
      <p className="native-subtle">{`速いドライブへコピーして、元の媒体の代わりに使います。元の素材は消しません・動かしません。${list?`コピーする量: ${ceilGigabytes(list.totalBytes)} GB`:''}`}</p>
      {!list&&loading&&<p className="native-subtle">コピー先を調べています…</p>}
      {listError&&<p className="native-copy-error" role="alert">{listError}</p>}
      {startError&&<p className="native-copy-error" role="alert">{startError}</p>}
      {list&&<div className="native-copy-options" role="radiogroup" aria-label="コピー先">{list.destinations.map(item=>
        <label key={item.key} className="native-copy-option" data-selectable={item.selectable?'true':'false'} data-destination={item.key}>
          <input type="radio" name="copy-destination" aria-label={item.label} value={item.key} disabled={!item.selectable} checked={chosen===item.key} onChange={()=>setChosen(item.key)}/>
          <span className="native-copy-option-body"><strong>{item.label}{item.recommended&&<span className="native-copy-recommended">おすすめ</span>}</strong>
            {item.space&&<small>{`空き ${floorGigabytes(item.space.free)} GB／容量 ${floorGigabytes(item.space.capacity)} GB → コピー後 ${floorGigabytes(item.space.after)} GB`}</small>}
            {item.space&&<small>{item.time?`所要時間の目安: 約 ${formatMinutes(item.time.minSeconds)}〜${formatMinutes(item.time.maxSeconds)} 分`:'所要時間の目安: コピーを始めると分かります'}</small>}
            {item.note&&<small className="native-copy-note">{item.note}</small>}
            {item.reason&&<small className="native-copy-reason">{item.reason}</small>}</span>
        </label>)}</div>}
      {list&&!list.destinations.some(item=>item.selectable)&&<p className="native-copy-error">選べるコピー先がありません。空きのある外付けのドライブを接続するか、「場所を指定…」で別の場所を選んでください。</p>}
      <p className="native-copy-warning">{COPY_DRIVE_WARNING}</p>
      <div className="native-copy-notes"><small>{COPY_GB_NOTE}</small><small>{COPY_SPACE_NOTE}</small><small>{TIME_NOTE}</small></div>
      <div className="export-actions">
        <button type="button" className="btn-ghost" disabled={starting} onClick={()=>setPicking(true)}>場所を指定…</button>
        <button type="button" className="export-cancel" disabled={starting} onClick={onCancel}>キャンセル</button>
        <button type="button" className="export-start" disabled={!selected||starting||loading} onClick={()=>void start()}>{starting?'始めています…':'コピーを始める'}</button>
      </div>
    </div></div>
    {picking&&<MediaPicker title="コピー先のフォルダーを選ぶ" note="元の素材と同じドライブ・ネットワークの場所・案件のフォルダーの中は選べません。" onPick={()=>undefined}
      onPickFolder={path=>{setPicking(false);setStartError(null);setCustomPath(path);}} folderLabel="このフォルダーにコピー" onCancel={()=>setPicking(false)}/>}
  </>;
}
