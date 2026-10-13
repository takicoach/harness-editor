import {useEffect,useState} from 'react';
import type {ImportBatchView,ImportDecisionChoice} from '../../shared/importBatches';
import {KEEP_ALWAYS_LABEL,slowItemLabel,slowMediaMessage,unknownDriveNote} from './NativeSlowMediaAdvice';
import './native-import.css';
import './native-media-copy.css';

/** 判断待ちを含む束の見出し: 準備済み・準備中・判断待ち・準備できなかった本数。 */
function decidingHeadline(batch:ImportBatchView,ready:number,failed:number):string{
  const preparing=batch.items.filter(item=>item.phase!=='ready'&&item.phase!=='failed'&&item.phase!=='cancelled'&&item.phase!=='awaiting-decision').length;
  const waiting=batch.decision?.itemIds.length??batch.items.filter(item=>item.phase==='awaiting-decision').length;
  return [`準備済み ${ready}本`,preparing?`準備中 ${preparing}本`:'',`判断待ち ${waiting}本`,failed?`準備できなかった ${failed}本`:''].filter(Boolean).join('・');
}
const headline=(batch:ImportBatchView,ready:number,failed:number)=>batch.decision||batch.phase==='deciding'?decidingHeadline(batch,ready,failed)
  :batch.phase==='ready'?`準備済み・未配置（${ready}本）`:batch.phase==='partial'?`${failed}本を準備できませんでした（${ready}本は準備済み）`
  :batch.phase==='confirming'?`配置が止まっています（${ready}本）。エディタを終了して起動し直すと「準備済み・未配置」に戻り、もう一度並べられます。`
  :batch.phase==='preparing'?`準備中（${batch.items.length}本）`:'動画を準備できませんでした';
/**
 * 素材の欄の「準備済み・未配置」と失敗を含む束（設計 §1）、追加時の判断待ち（設計 §2: 束の全項目の判定後に1回だけ案内）。
 * 確定・取り消し・判断は親が行う。unplaced は確定の印があるのに文書に無い束（案内だけ）。
 * 判断（onDecide）は束ごとに1回だけ受け付け、その束の案内が消えるまで押せない（失敗＝Promise の拒否なら押し直せる）。
 * 同じ束に案内が再び付いた時（残りを中止・コピーを始められなかった・接続の結果を確かめられなかった）は、また押せる。
 * unfinishedCopies: 追加時のコピーで終わらなかった項目（`<束>:<項目>`）。案内の対象に含まれれば、前回のコピーが終わらなかったことを添える。
 * 文言は 2026-10-06 決定（開いた時の案内と同じ本文。［コピーして使う］［このまま使う］、押した時に「今後この場所では出さない」を選んでいれば keep-always）。
 * 「今後この場所では出さない」は、判断待ちの項目のドライブを1本も識別できなければ出さない（混じる時は出し、選んだ時だけ識別できない項目が今回だけになると添える）。
 */
export function NativeImportBatches({batches,unplaced=[],disabled,onConfirm,onCancel,onDecide,onCopyBatch,unfinishedCopies}:{batches:readonly ImportBatchView[];unplaced?:readonly ImportBatchView[];disabled:boolean;
  onConfirm(batchId:string,skipFailed:boolean):void;onCancel(batchId:string):void;onDecide?(batchId:string,choice:ImportDecisionChoice):void|Promise<unknown>;onCopyBatch?(batchId:string):void;unfinishedCopies?:ReadonlySet<string>}){
  // deciding: 判断を送った束（案内が消えるまで押せない）
  // always: 「今後この場所では出さない」を選んだ束
  const [deciding,setDeciding]=useState<ReadonlySet<string>>(new Set()),[always,setAlways]=useState<ReadonlySet<string>>(new Set());
  useEffect(()=>{setDeciding(previous=>{const next=new Set([...previous].filter(id=>batches.some(batch=>batch.batchId===id&&batch.decision)));return next.size===previous.size?previous:next;});},[batches]);
  if(!batches.length&&!unplaced.length)return null;
  const decide=(batchId:string,choice:ImportDecisionChoice)=>{
    if(!onDecide||deciding.has(batchId))return;setDeciding(previous=>new Set([...previous,batchId]));
    void Promise.resolve(onDecide(batchId,choice)).catch(()=>setDeciding(previous=>{const next=new Set(previous);next.delete(batchId);return next;}));
  };
  return <section className="native-import-batches" aria-label="メインに並べる取り込み">{unplaced.map(batch=>{
    const ready=batch.items.filter(item=>item.phase==='ready');
    return <div key={batch.batchId} className="native-import-batch" data-import-batch={batch.batchId} data-phase={batch.phase}>
      <p>{`配置の記録がある取り込み（${ready.length}本）が、今の編集内容に並んでいません（並べた後、保存する前に終了した可能性があります）。並べるには、この動画をもう一度追加してください。`}</p>
      <ul>{ready.map(item=><li key={item.itemId}>{item.name}</li>)}</ul>
    </div>;})}{batches.map(batch=>{
    const ready=batch.items.filter(item=>item.phase==='ready').length,failed=batch.items.filter(item=>item.phase==='failed'),decision=batch.decision;
    const waiting=decision?batch.items.filter(item=>decision.itemIds.includes(item.itemId)):[],unknown=waiting.filter(item=>item.slow?.canRemember===false),rememberable=unknown.length<waiting.length;
    const locked=disabled||deciding.has(batch.batchId),again=!!decision&&decision.itemIds.some(itemId=>unfinishedCopies?.has(`${batch.batchId}:${itemId}`));
    return <div key={batch.batchId} className="native-import-batch" data-import-batch={batch.batchId} data-phase={batch.phase}>
      <p>{headline(batch,ready,failed.length)}</p>
      {failed.length>0&&<ul>{failed.map(item=><li key={item.itemId}>{item.name}: {item.error??'失敗'}</li>)}</ul>}
      {decision&&onDecide&&onCopyBatch&&<div className="native-import-decision" data-import-decision={batch.batchId}>
        {again&&<p><strong>前回のコピーを最後まで終えられなかった動画があります。もう一度選んでください。</strong></p>}
        <p>{slowMediaMessage(decision.itemIds.length,decision.totalBytes,decision.totalSeconds)}</p>
        <p className="native-subtle">判定のため、各動画の先頭 64MB を試しに読みました。決めるまで、この動画はメインに並びません（ほかの動画の準備は進めています）。</p>
        <ul>{waiting.map(item=><li key={item.itemId}>{slowItemLabel(item.name,item.slow?.seconds,waiting.length>1)}</li>)}</ul>
        {rememberable&&always.has(batch.batchId)&&unknown.length>0&&<p className="native-subtle">{unknownDriveNote(unknown.map(item=>item.name))}</p>}
        <div className="native-import-actions">
          <button type="button" className="btn-tonal" disabled={locked} onClick={()=>onCopyBatch(batch.batchId)}>コピーして使う</button>
          <button type="button" className="btn-ghost" disabled={locked} onClick={()=>decide(batch.batchId,rememberable&&always.has(batch.batchId)?'keep-always':'keep-once')}>このまま使う</button>
          {rememberable&&<label className="native-slow-keep"><input type="checkbox" disabled={locked} checked={always.has(batch.batchId)}
            onChange={event=>{const checked=event.target.checked;setAlways(previous=>{const next=new Set(previous);if(checked)next.add(batch.batchId);else next.delete(batch.batchId);return next;});}}/>{KEEP_ALWAYS_LABEL}</label>}
        </div>
      </div>}
      <div className="native-import-actions">
        {batch.phase==='ready'&&<button type="button" className="btn-tonal" disabled={disabled} onClick={()=>onConfirm(batch.batchId,false)}>メインの末尾に並べる</button>}
        {batch.phase==='partial'&&<button type="button" className="btn-tonal" disabled={disabled} onClick={()=>onConfirm(batch.batchId,true)}>失敗分を除いて並べる</button>}
        {batch.phase!=='confirming'&&<button type="button" className="btn-ghost" disabled={disabled} onClick={()=>onCancel(batch.batchId)}>{batch.phase==='failed'?'閉じる':'束を取り消す'}</button>}
      </div>
    </div>;})}</section>;
}
