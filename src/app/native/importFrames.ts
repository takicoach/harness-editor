import type {SequenceDocument} from '../../core/sequence/model';
import {mainAppendStart} from '../../core/sequence/mainTrack';
import {timeNumber} from '../../core/sequence/time';
import type {ImportBatchView,ImportItemPhase,ImportItemView} from '../../shared/importBatches';

/** 長さがまだ分からない枠の仮の長さ（秒）。 */
export const IMPORT_PLACEHOLDER_SECONDS=5;
export interface ImportFrame {batchId:string;itemId:string;name:string;phase:ImportItemPhase;error?:string;startFrame:number;durationFrames:number;estimated:boolean;first:boolean;batchSize:number}
const LABEL:Record<ImportItemPhase,string>={waiting:'受付済み',judging:'読み取りの速さを確認中','awaiting-decision':'コピーするか確認待ち',probing:'調査中',fingerprinting:'内容を確認中',
  copying:'速いドライブへコピー中',ready:'準備済み',failed:'失敗',cancelled:'取り消し'};
export function importPhaseLabel(phase:ImportItemPhase):string{return LABEL[phase];}
const OPEN=new Set<ImportBatchView['phase']>(['preparing','deciding','ready','partial','failed','confirming']);
/**
 * 読み込み中の仮の枠（文書の外・設計 §2-6）。メインの今の末尾から受付順に並べる。確定済み（その束のクリップが文書にある）・取り消した素材は出さない。
 * 失敗した素材は確定で並ばない（「失敗分を除いて並べる」）ので、並ぶ枠の位置を押し出さず、すべての並ぶ枠の後ろにまとめて出す。
 * 映像の無い素材（audioOnly）は確定で一覧に登録するだけなので枠を出さない。batchSize は並ぶ枠の本数（全部失敗した束は失敗した本数）。
 */
export function importFrames(doc:SequenceDocument,batches:readonly ImportBatchView[],durationOf:(batchId:string,item:ImportItemView)=>number|undefined):ImportFrame[]{
  const fps=timeNumber(doc.fps),frames:ImportFrame[]=[],failed:Omit<ImportFrame,'startFrame'>[]=[];let at=mainAppendStart(doc);
  for(const batch of batches){
    if(!OPEN.has(batch.phase)||doc.clips.some(clip=>clip.id.startsWith(`${batch.batchId}-`)))continue;
    const items=batch.items.filter(item=>item.phase!=='cancelled'&&!item.audioOnly),placing=items.filter(item=>item.phase!=='failed'),lead=placing[0]??items[0];
    for(const item of items){
      const seconds=item.durationSeconds??durationOf(batch.batchId,item),durationFrames=Math.max(1,Math.ceil((seconds??IMPORT_PLACEHOLDER_SECONDS)*fps));
      const frame={batchId:batch.batchId,itemId:item.itemId,name:item.name,phase:item.phase,...(item.error?{error:item.error}:{}),durationFrames,estimated:seconds===undefined,first:item===lead,batchSize:placing.length||items.length};
      if(item.phase==='failed')failed.push(frame);else{frames.push({...frame,startFrame:at});at+=durationFrames;}
    }
  }
  for(const frame of failed){frames.push({...frame,startFrame:at});at+=frame.durationFrames;}
  return frames;
}
/**
 * 確定の印はあるのに、今の文書にその束のクリップも準備済みの素材も無い束（印は置く前に書くので、配置の後に文書を保存せず終了・読み直すと起きる）。
 * 文書の版が印の版より前の時だけ出す（確定の後の「元に戻す」は版が進むので出さない）。確定済みの束は再び確定しないので、案内だけに使う。
 */
export function unplacedConfirmedImports(doc:SequenceDocument,batches:readonly ImportBatchView[]):ImportBatchView[]{
  return batches.filter(batch=>batch.phase==='confirmed'&&!!batch.confirmed&&doc.revision<batch.confirmed.revision
    &&!doc.clips.some(clip=>clip.id.startsWith(`${batch.batchId}-`))
    &&batch.items.some(item=>item.phase==='ready'&&!!item.assetId&&!doc.assets.some(asset=>asset.id===item.assetId)));
}
