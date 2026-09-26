import type {SequenceClip,SequenceDocument} from '../../core/sequence/model';
import {sequenceAssetReferences, type AssetReference} from '../../core/sequence/assetReferences';

export interface AssetUsage {count:number;places:string[];action:string}

function findClip(doc:SequenceDocument,clipId:string|undefined):SequenceClip|undefined{
  if(!clipId)return undefined;
  return doc.clips.find(c=>c.id===clipId)
    ?? doc.cutArchive?.entries.flatMap(entry=>entry.clips).find(c=>c.id===clipId);
}

/** core の構造走査（sequenceAssetReferences）が返す場所を、UI 通知向けの日本語ラベルへ写すだけ。走査そのものは持たない（I3）。 */
function label(doc:SequenceDocument,ref:AssetReference):string{
  // T28 Minor: clip を要らない枝（文字起こし・既定部品・カットした部分）でも先に引いていた。
  // findClip は旧カット記録まで辿るので、参照ごとの空振りが積み上がる。必要な枝でだけ引く。
  const named=()=>{const clip=findClip(doc,ref.clipId);return {clip,name:clip?.name??ref.detail};};
  switch(ref.place){
    case 'clip-content': {const {clip,name}=named();return clip?.content.kind==='telop' ? `字幕のスタイル（${name}）` : `タイムライン（${name}）`;}
    case 'clip-anchor': return `タイムライン（${named().name}・使用箇所）`;
    case 'clip-lut': return `カラー設定（${named().name}）`;
    case 'clip-witness': return `旧編集の証拠（${named().name}）`;
    case 'speed-basis': return `速度の基準（${named().name}）`;
    case 'transcript': return '文字起こし';
    case 'rendering': return '案件の既定部品';
    case 'cut-archive': return 'カットした部分';
    // R3-M6: 固定文言「音声補正の元」だけでは、複数の由来があるとき・通知を見た人が
    // どの素材を先に外せばいいのか分からない。detail（`${補正後の素材名}（音声補正の元）`）
    // をそのまま出す。
    case 'audio-fix-origin': return ref.detail;
    default: return ref.detail;
  }
}

/**
 * R3-M6: 「先にタイムラインから外してください」は timeline 上の参照にしか当てはまらない。
 * audio-fix-origin は別素材の origin.from（＝補正後の素材がこれを元にしている）なので、
 * タイムラインを触っても解消しない。参照が audio-fix-origin だけのときは、その補正後の
 * 素材を戻す・外す方を案内する。
 */
function actionFor(refs:readonly AssetReference[]):string{
  const fixOrigins=refs.filter(ref=>ref.place==='audio-fix-origin');
  if(refs.length>0&&fixOrigins.length===refs.length){
    const holders=[...new Set(fixOrigins.map(ref=>ref.detail.replace(/（音声補正の元）$/,'')))];
    return `補正後の素材『${holders.join('・')}』の元になっています。先にその補正を戻すか外してください。`;
  }
  return '先にタイムラインから外してください。';
}

/**
 * document のどこから参照されているかを、UI がそのまま通知文へ出せる形で返す。
 * サーバー側の唯一の正は SequenceError('BROKEN_REFERENCE', …)（remove-asset コマンド）。
 * これはその手前でユーザーへ場所を示すための、拒否理由の説明用の集計。
 */
export function assetUsage(doc:SequenceDocument,assetId:string):AssetUsage{
  const refs=sequenceAssetReferences(doc,assetId);
  return {count:refs.length,places:[...new Set(refs.map(ref=>label(doc,ref)))],action:actionFor(refs)};
}
