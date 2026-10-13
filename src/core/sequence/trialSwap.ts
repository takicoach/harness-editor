import type {SequenceAsset,SequenceClip,SequenceDocument} from './model';
import {clipEnd,sourceTimeAt} from './model';
import {applySequenceCommand,type SequenceCommand} from './commands';
import {MAX_USAGE_SWAP_TARGETS} from './commandTypes';
import {compareTime,rational,subtractTime,timeNumber} from './time';
import {assetOf,sameUsage,trialSwapKind,type TrialSwapKind} from './swapUsage';
export {trialSwapKind,type TrialSwapKind};

export type TrialEndMode='loop'|'silence';
/** from-cut-head: 表示中の先頭が曲の途中から始まる（カットした部分を含めて頭から数えるため）。short-if-restored: 表示中は足りるが、カットを戻すと足りない。 */
export type TrialSwapNote='from-start'|'from-cut-head'|'rate'|'muted'|'short'|'short-if-restored';
export type TrialSwapResult=
  |{ok:true;kind:TrialSwapKind;clipIds:string[];command:SequenceCommand;preview:SequenceDocument;notes:TrialSwapNote[];silenceAllowed:boolean;rate:number}
  |{ok:false;reason:string};

const SPEED_REASON='このクリップは速度の設定があるため、まだ差し替えを試せません';
const LEGACY_REASON='このクリップは古い形式の記録があるため、まだ差し替えを試せません';
const KIND_REASON='この素材はこのクリップの候補にできません';
const MIXED_REASON='BGM の使用箇所に音声以外が混ざっています';
const SILENCE_REASON='この曲の長さでは「無音で終わる」を選べません';
const TOO_MANY_REASON='この使用箇所は分かれ方が多すぎるため、差し替えを試せません';

export function trialUsage(doc:SequenceDocument,clipId:string):SequenceClip[]{
  const clip=doc.clips.find(c=>c.id===clipId);if(!clip)return [];
  return doc.clips.filter(sameUsage(clip)).sort((a,b)=>a.startFrame-b.startFrame);
}
/**
 * カットで退避した部分のうち、同じ使用箇所に属するクリップ（設計 §2）。退避側のクリップ ID は live のクリップ ID と重なりうるので、所属する entry と組で持つ。
 * 画面（選択・終了の条件）はこれを見ない。採用の command にだけ入る。
 */
export function trialArchivedUsage(doc:SequenceDocument,clipId:string):{entryId:string;clip:SequenceClip}[]{
  const clip=doc.clips.find(c=>c.id===clipId);if(!clip)return [];
  const match=sameUsage(clip);
  return (doc.cutArchive?.entries??[]).flatMap(e=>e.clips.filter(match).map(c=>({entryId:e.id,clip:c})));
}
/**
 * 選択が「素材を試す」の対象として成り立つか。節を出す・開始を受け付ける・試しを続けるの3つをこれ1つで決める（設計 §3-1・§3-9）。
 * 選択が1件以上で、すべてが先頭のクリップ（画像か BGM）と同じ使用箇所にあるとき true。
 * trialClipIds（試し中の使用箇所）を渡すと継続の判定になり、空の選択も許し（§3-9）、使用箇所はその試しのものに限る。
 */
export function trialSelectable(doc:SequenceDocument,selected:readonly string[],trialClipIds?:readonly string[]):boolean{
  if(!selected.length)return !!trialClipIds;
  const first=doc.clips.find(c=>c.id===selected[0]);
  if(!first||!trialSwapKind(first)||(trialClipIds&&!trialClipIds.includes(first.id)))return false;
  const usage=new Set(trialUsage(doc,first.id).map(c=>c.id));
  return selected.every(id=>usage.has(id));
}
const isMusicAsset=(a:SequenceAsset)=>a.kind==='media'&&!a.streams.some(s=>s.kind==='video')&&a.streams.some(s=>s.kind==='audio');
export function trialCandidates(doc:SequenceDocument,clipId:string):SequenceAsset[]{
  const clip=doc.clips.find(c=>c.id===clipId),kind=clip&&trialSwapKind(clip);
  if(!kind)return [];
  return doc.assets.filter(a=>kind==='image'?a.kind==='image':isMusicAsset(a));
}
export const trialPreviewId=(documentId:string,generation:number)=>`${documentId}:trial:${generation}`;

export function buildTrialSwap(doc:SequenceDocument,request:{clipId:string;assetId:string;endMode:TrialEndMode;generation:number}):TrialSwapResult{
  const clip=doc.clips.find(c=>c.id===request.clipId),kind=clip&&trialSwapKind(clip);
  if(!clip||!kind)return {ok:false,reason:'差し替えを試せるのは画像か BGM のクリップです'};
  const usage=trialUsage(doc,clip.id),archived=trialArchivedUsage(doc,clip.id),all=[...usage,...archived.map(x=>x.clip)];
  // 採用は swap-usage-content の1件で送る。1回で書き換えられる片の上限を超えるなら、試しを始める前に断る（設計 §4）。
  if(all.length>MAX_USAGE_SWAP_TARGETS)return {ok:false,reason:TOO_MANY_REASON};
  if(all.some(c=>c.speed||c.insertOwnSpeed))return {ok:false,reason:SPEED_REASON};
  if(archived.some(({clip:c})=>c.legacyAudioContinuity||c.legacyCaptionContinuity||c.legacyMainRole))return {ok:false,reason:LEGACY_REASON};
  const asset=trialCandidates(doc,clip.id).find(a=>a.id===request.assetId);
  if(!asset)return {ok:false,reason:KIND_REASON};
  const notes:TrialSwapNote[]=[];let silenceAllowed=false,rate=1;
  // 退避側のクリップ ID は live と重なりうるので、クリップの実体で引く。
  const contents=new Map<SequenceClip,SequenceClip['content']>();
  if(kind==='image'){
    for(const c of all)if(c.content.kind==='image')contents.set(c,{...c.content,assetId:asset.id});
  }else{
    // 候補は trialCandidates の isMusicAsset で音声ストリームありに限定済みなので [0] は必ず在る
    const stream=asset.streams.filter(s=>s.kind==='audio').sort((a,b)=>a.index-b.index)[0]!;
    const audio:{clip:SequenceClip;content:Extract<SequenceClip['content'],{kind:'audio'}>}[]=[];
    // sourceIn の付け直しの基準・長さの判定・「無音で終わる」の判定は、退避側も合わせて行う（戻したときも検証に通る値にする。設計 §4）。
    for(const c of all){if(c.content.kind!=='audio')return {ok:false,reason:MIXED_REASON};audio.push({clip:c,content:c.content});}
    const base=audio.map(x=>x.content.sourceIn).reduce((min,t)=>compareTime(t,min)<0?t:min);
    const rebased=audio.map(x=>({...x,sourceIn:subtractTime(x.content.sourceIn,base)}));
    const fits=(x:typeof rebased[number])=>compareTime(sourceTimeAt({...x.clip,content:{...x.content,sourceIn:x.sourceIn}},clipEnd(x.clip)-1,doc.fps),stream.duration)<0;
    const covers=rebased.every(fits),shown=rebased.slice(0,usage.length); // audio は live（usage の順）→ 退避の順に並ぶ
    silenceAllowed=!covers&&rebased.every(x=>compareTime(x.sourceIn,stream.duration)<0);
    if(!covers&&request.endMode==='silence'&&!silenceAllowed)return {ok:false,reason:SILENCE_REASON};
    rate=timeNumber(audio[0]!.content.rate);
    // 案内は画面に出ている live 側で決める。先頭の片が曲の途中から始まるなら from-cut-head、表示中は足りてカットを戻すと足りないなら short-if-restored（設計 §3-5）。
    notes.push(compareTime(shown[0]!.sourceIn,rational(0))===0?'from-start':'from-cut-head');if(rate!==1)notes.push('rate');if(shown.some(x=>x.content.settings.muted))notes.push('muted');
    if(!covers)notes.push(shown.every(fits)?'short-if-restored':'short');
    for(const x of rebased){
      const rest:Record<string,unknown>={...x.content};delete rest.endBehavior;
      const loop=covers?x.content.loop:request.endMode==='loop';
      contents.set(x.clip,{...rest as typeof x.content,assetId:asset.id,streamIndex:stream.index,sourceIn:x.sourceIn,loop,...(!covers&&!loop?{endBehavior:'silence' as const}:{})});
    }
  }
  // クリップ名（設計 §4）: 元の素材名のまま（利用者が変えていない）なら候補の素材名に替える。クリップごとに判定する。
  const assetName=(id:string|null)=>doc.assets.find(a=>a.id===id)?.name;
  const named=(c:SequenceClip)=>c.name===assetName(assetOf(c))?{name:asset.name}:{};
  // live と退避を swap-usage-content の1件にまとめる（採用は履歴1件・Undo 1回、送信の予算も1件）。退避が無ければ archived は空。
  const command:SequenceCommand={type:'swap-usage-content',
    live:usage.map(c=>({clipId:c.id,patch:{content:contents.get(c)!,...named(c)}})),
    archived:archived.map(({entryId,clip:c})=>({entryId,clipId:c.id,patch:{content:contents.get(c)!,...named(c)}}))};
  let applied:SequenceDocument;
  try{applied=applySequenceCommand(doc,command);}
  catch(error){
    return {ok:false,reason:error instanceof Error?error.message:String(error)};
  }
  return {ok:true,kind,clipIds:usage.map(c=>c.id),command,preview:{...applied,id:trialPreviewId(doc.id,request.generation)},notes,silenceAllowed,rate};
}
