import type {SequenceClip,SequenceDocument} from './model';
import {isMediaContent} from './model';
import {SequenceError} from './errors';

/**
 * 「使用箇所」の判定（設計 §2・§4）。trialSwap.ts（試しを作る側）と commands.ts（swap-usage-content を検証する側）が共有する葉のモジュール。
 * commands.ts は trialSwap.ts を import できない（trialSwap.ts が commands.ts を使う）ので、判定はここに置く。
 */
export type TrialSwapKind='image'|'music';
export interface UsageSwapPatch {name?:string;content:SequenceClip['content']}
export interface UsageSwapTargets {live:Array<{clipId:string;patch:UsageSwapPatch}>;archived:Array<{entryId:string;clipId:string;patch:UsageSwapPatch}>}

export function trialSwapKind(clip:SequenceClip):TrialSwapKind|null{
  if(clip.content.kind==='image')return 'image';
  if(clip.content.kind==='audio'&&clip.content.role==='music')return 'music';
  return null;
}
export const assetOf=(clip:SequenceClip)=>clip.content.kind==='image'||isMediaContent(clip.content)?clip.content.assetId:null;
/** 同じトラック・同じ素材・同じ続き番号（設計 §2）。live と退避側の両方をこの1つで判定する。 */
export const sameUsage=(clip:SequenceClip)=>{const key=clip.continuationGroupId??clip.id,asset=assetOf(clip);return (c:SequenceClip)=>c.trackId===clip.trackId&&(c.continuationGroupId??c.id)===key&&assetOf(c)===asset;};

const WHOLE='使用箇所の全体を差し替えてください';
/** 差し替えで変えてよい content のキー（名前は別に許す）。それ以外のキーと種類は元のまま（設計 §4）。 */
const SWAPPABLE:Record<TrialSwapKind,readonly string[]>={image:['assetId'],music:['assetId','streamIndex','sourceIn','loop','endBehavior']};
const canonical=(value:unknown):string=>{
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(value&&typeof value==='object'){const record=value as Record<string,unknown>;return `{${Object.keys(record).filter(key=>record[key]!==undefined).sort().map(key=>`${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;}
  return JSON.stringify(value);
};
function swappable(kind:TrialSwapKind,before:SequenceClip['content'],after:unknown):boolean{
  if(!after||typeof after!=='object'||(after as {kind?:unknown}).kind!==before.kind)return false;
  const a=before as unknown as Record<string,unknown>,b=after as Record<string,unknown>,allowed=SWAPPABLE[kind];
  return [...new Set([...Object.keys(a),...Object.keys(b)])].every(key=>allowed.includes(key)||canonical(a[key])===canonical(b[key]));
}
/**
 * swap-usage-content の中身が、先頭の live 片から求めた1つの使用箇所（画像か BGM）の全片（live と退避）と過不足・重複なく一致し、
 * 各片は種類を変えず、変えてよいキーだけを変えていることを確かめる。HTTP から直接送られても、使用箇所の一部や別の片を書き換えさせない。
 */
export function assertWholeUsage(document:SequenceDocument,targets:UsageSwapTargets):void{
  const first=targets.live[0];if(!first)throw new SequenceError('INVALID_RANGE',WHOLE);
  const clip=document.clips.find(c=>c.id===first.clipId);if(!clip)throw new SequenceError('MISSING_TARGET','対象のクリップが見つかりません',[first.clipId]);
  const kind=trialSwapKind(clip);if(!kind)throw new SequenceError('INVALID_RANGE',WHOLE,[clip.id]);
  const match=sameUsage(clip),key=(entryId:string,clipId:string)=>`${entryId}\u0000${clipId}`;
  const live=new Map(document.clips.filter(match).map(c=>[c.id,c]));
  const archived=new Map((document.cutArchive?.entries??[]).flatMap(e=>e.clips.filter(match).map(c=>[key(e.id,c.id),c] as const)));
  if(targets.live.length!==live.size||targets.archived.length!==archived.size)throw new SequenceError('INVALID_RANGE',WHOLE,[clip.id]);
  const seen=new Set<string>();
  const check=(original:SequenceClip|undefined,seenKey:string,patch:UsageSwapPatch)=>{
    if(!original||seen.has(seenKey)||!swappable(kind,original.content,patch?.content))throw new SequenceError('INVALID_RANGE',WHOLE,[clip.id]);
    seen.add(seenKey);
  };
  for(const item of targets.live)check(live.get(item.clipId),`live\u0000${item.clipId}`,item.patch);
  for(const item of targets.archived)check(archived.get(key(item.entryId,item.clipId)),`archived\u0000${key(item.entryId,item.clipId)}`,item.patch);
}
