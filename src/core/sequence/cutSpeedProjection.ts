import {SequenceError} from './errors';
import {clipEnd,type SequenceDocument} from './model';
import {compareTime} from './time';
import {applyNativeSpeedCommand} from './speedCommands';
import {captionLedgers,refreshCaptionBaselines,speedProjectionForDocument} from './speedCaptionLedger';
import {rebindInsertOwnCompletion} from './insertOwnSpeed';

/** Only a saved, already registered intent can be projected without guessing roles.
 * Caller slices in the original archive frame unit before calling this function. */
export function projectCutSpeed(current:SequenceDocument,saved:SequenceDocument,completionFloorFrames:number):{document:SequenceDocument;completionFloorFrames:number;insertionFrames:number}{
 if(!!current.speed!==!!saved.speed)throw new SequenceError('INVALID_RANGE','カット後に速度登録が変わっています。削除帯の主映像・原音の役割を確認してから復元してください');
 if(!current.speed||!saved.speed)return {document:saved,completionFloorFrames,insertionFrames:saved.sequenceEndFrame};
 if(compareTime(current.speed.fpsBasis,saved.speed.fpsBasis)!==0)throw new SequenceError('INVALID_RANGE','カット時と現在のfps基準が異なります。元のフレーム基準を確認してください');
 if(compareTime(current.speed.globalRate,saved.speed.globalRate)===0)return {document:saved,completionFloorFrames,insertionFrames:saved.sequenceEndFrame};
 // Existing per-owner overrides, source/effect bases and latent caption intents
 // remain attached. Current unrelated owners never lend their overrides here.
 const hasMain=saved.clips.some(c=>c.speed?.kind==='main');
 if(!hasMain){
  const next=structuredClone(saved);next.speed!.globalRate=structuredClone(current.speed.globalRate);refreshCaptionBaselines(next);
  return {document:next,completionFloorFrames,insertionFrames:next.sequenceEndFrame};
 }
 const command={type:'set-native-global-speed' as const,rate:current.speed.globalRate};
 let next=applyNativeSpeedCommand(saved,command);next=rebindInsertOwnCompletion(saved,next,command);
 const insertionFrames=next.sequenceEndFrame;
 const delta=speedProjectionForDocument(next).mainEndFrame-speedProjectionForDocument(saved).mainEndFrame;
 // Ordinary fixed overlays/inserts do not inherit global speed. Give their
 // preserved exposure space in the saved graph; insertion planning separately
 // protects AV continuity and avoids overlapping the next
 // live fragment, trimming it, or silently changing its effect clock.
 const projectedCaptions=new Set(captionLedgers(next).flatMap(l=>l.parts.map(p=>p.reservedRenderId)));
 const fixedEnd=Math.max(0,...next.clips.filter(c=>!c.speed&&!c.insertOwnSpeed&&!projectedCaptions.has(c.id)).map(clipEnd));
 const end=Math.max(next.sequenceEndFrame,fixedEnd);
 const floor=Math.min(end,Math.max(0,completionFloorFrames+delta,fixedEnd));
 if(end!==next.sequenceEndFrame){
  const extra=end-next.sequenceEndFrame;next.sequenceEndFrame=end;
  if(next.speed!.sequenceEndBasis.kind==='main-offset')next.speed!.sequenceEndBasis.offsetFrames+=extra;
  if(next.insertOwnSpeed)next.insertOwnSpeed.endFloor=Math.max(next.insertOwnSpeed.endFloor,floor);
  refreshCaptionBaselines(next);
 }
 return {document:next,completionFloorFrames:floor,insertionFrames};
}
