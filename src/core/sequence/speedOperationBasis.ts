import {captureSpeedTiming,timingReservedIds,validateSpeedTiming,rebindSpeedTiming} from './speedTimingBasis';
import {SequenceError} from './errors';
import type {SequenceDocument,NativeSpeedOperationBasis} from './model';
import {captionLedgers,speedReservedIds,upgradeNativeSpeedMetadata,refreshCaptionBaselines} from './speedCaptionLedger';
const fail=(message:string):never=>{throw new SequenceError('INVALID_DOCUMENT',message);};
export function operationBasis(doc:SequenceDocument):NativeSpeedOperationBasis|undefined{return doc.clips.find(c=>c.speed?.operationBasis)?.speed?.operationBasis;}
export function operationCarrier(doc:SequenceDocument){return doc.clips.find(c=>c.speed?.kind==='main'&&c.speed.order===0)??doc.clips.find(c=>c.speed?.kind==='independent-audio');}
function ids(doc:SequenceDocument){return new Set([...doc.clips.map(c=>c.id),...captionLedgers(doc).flatMap(l=>l.parts.map(p=>p.reservedRenderId)),...timingReservedIds(operationBasis(doc)?.timing)]);}
export function validateOperationBasis(doc:SequenceDocument):void {
 const carriers=doc.clips.filter(c=>c.speed?.operationBasis!==undefined);if(!carriers.length){if(doc.speed?.projectionPolicy==='split-rate-v1'&&doc.clips.some(c=>c.speed?.kind==='main'||c.speed?.kind==='independent-audio'))fail('速度操作の保存正本がありません');return;}
 if(carriers.length!==1||doc.speed?.version!==2||doc.speed.projectionPolicy!=='split-rate-v1')return fail('速度操作基準の所有者または版が不正です');
 const b=carriers[0]!.speed!.operationBasis!;
 if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!['version','order','timing'].includes(k))||b.version!==1||!Array.isArray(b.order)||b.order.some(id=>typeof id!=='string')||new Set(b.order).size!==b.order.length)return fail('速度操作の保存順が不正です');
 const expected=ids(doc);if(b.order.length!==expected.size||b.order.some(id=>!expected.has(id)))return fail('速度操作の保存順に欠損または無関係なIDがあります');
 const live=new Set(doc.clips.map(c=>c.id));if(JSON.stringify(b.order.filter(id=>live.has(id)))!==JSON.stringify(doc.clips.map(c=>c.id)))return fail('速度操作の保存順と表示配列が一致しません');
 if(b.timing!==undefined)validateSpeedTiming(doc,b.timing);else if(doc.clips.some(c=>c.content.kind==='scene-fade')||doc.transitions.some(t=>!t.inClipId))fail('フェードの保存時刻intentがありません');
}
/** Explicit upgrade preserves all visible fields. Existing latent IDs have no
 * recoverable old storage slot: adopt them, in ledger order, after visible IDs. */
export function upgradeNativeSpeedOperations(doc:SequenceDocument):SequenceDocument {
 if(!doc.speed||!doc.clips.some(c=>c.speed?.kind==='main'))throw new SequenceError('MISSING_TARGET','速度を変更する主映像の保存基準がありません');
 if(operationBasis(doc))return doc;
 const next=structuredClone(upgradeNativeSpeedMetadata(doc));next.speed!.projectionPolicy='split-rate-v1';
 const used=new Set([...speedReservedIds(next),...ids(next),...next.assets.map(a=>a.id),...next.tracks.map(t=>t.id),...next.transitions.map(t=>t.id),...next.clips.flatMap(c=>[c.linkGroupId,c.continuationGroupId].filter((id):id is string=>!!id))]);let counter=0;
 const timing=captureSpeedTiming(next,()=>{let id:string;do{id=`speed-fade-${++counter}`;}while(used.has(id));used.add(id);return id;});
 operationCarrier(next)!.speed!.operationBasis={version:1,order:[...ids(next)],...(timing?{timing}:{})};
 const b=operationBasis(next)!;for(const record of timing?.clips??[]){const index=b.order.indexOf(record.original.id);b.order.splice(index+1,0,...record.parts.slice(1).map(p=>p.renderId));}
 refreshCaptionBaselines(next);return next;
}
/** Ordinary editing owns only its changed topology, not a new speed baseline. */
export function rebindOperationBasis(before:SequenceDocument,next:SequenceDocument):SequenceDocument {
 const old=operationBasis(before);if(!old||before===next)return next;
 const used=new Set([...speedReservedIds(before),...speedReservedIds(next),...ids(before),...ids(next),...next.assets.map(a=>a.id),...next.tracks.map(t=>t.id),...next.transitions.map(t=>t.id),...next.clips.flatMap(c=>[c.linkGroupId,c.continuationGroupId].filter((id):id is string=>!!id))]);let counter=0;
 const timing=rebindSpeedTiming(before,next,old.timing??{baselines:[],clips:[],fades:[]},()=>{let id:string;do{id=`speed-fade-${++counter}`;}while(used.has(id));used.add(id);return id;});
 for(const c of next.clips)if(c.speed)delete c.speed.operationBasis;
 const carrier=operationCarrier(next);if(!carrier?.speed)return next;
 carrier.speed.operationBasis={version:1,order:[],...(timing?{timing}:{})};
 const allowed=ids(next),live=new Set(next.clips.map(c=>c.id)),queue=next.clips.map(c=>c.id),order:string[]=[];
 for(const id of old.order){if(!allowed.has(id))continue;if(live.has(id)){const replacement=queue.shift();if(replacement)order.push(replacement);}else order.push(id);}
 order.push(...queue);for(const id of allowed)if(!order.includes(id))order.push(id);
 carrier.speed.operationBasis.order=order;
 return next;
}
