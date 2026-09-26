import {nativeSpeedRate as rate} from './speedCommandValidation';
import {materializeSpeedTiming,timingReservedIds} from './speedTimingBasis';
import {SequenceError} from './errors';
import {type SequenceDocument} from './model';
import {type Rational} from './time';
import {projectNativeSpeedMedia} from './speedMediaProjection';
import {captionLedgers,materializeSpeedCaptions} from './speedCaptionLedger';
import {operationBasis,upgradeNativeSpeedOperations} from './speedOperationBasis';
import {rebindCutBoundariesForSpeed} from './cutBoundarySpeed';
export type NativeSpeedCommand={type:'upgrade-native-speed-operations'}|{type:'set-native-global-speed';rate:Rational}|{type:'set-native-main-speed';clipId:string;rate:Rational}|{type:'reset-native-main-speed';clipId:string};

export function applyNativeSpeedCommand(document:SequenceDocument,command:NativeSpeedCommand):SequenceDocument {
 if(command.type==='upgrade-native-speed-operations')return upgradeNativeSpeedOperations(document);
 const input=upgradeNativeSpeedOperations(document);
 const result=projectNativeSpeedMedia(input,command.type==='set-native-global-speed'?rate(command.rate):input.speed!.globalRate,command.type==='set-native-global-speed'?undefined:{clipId:command.clipId,rate:command.type==='reset-native-main-speed'?null:rate(command.rate)});
 const next=structuredClone(input);next.speed=result.speed;next.sequenceEndFrame=result.projection.sequenceEndFrame;
 const replacements=new Map(result.mediaClips.map(c=>[c.id,c]));next.clips=next.clips.map(c=>replacements.get(c.id)??c);
 const captionIds=new Set(captionLedgers(next).flatMap(l=>l.parts.map(p=>p.reservedRenderId)));
 const timing=operationBasis(next)!.timing,projected=timing?materializeSpeedTiming(next,timing):undefined,timingIds=new Set(timingReservedIds(timing));
 const captions=materializeSpeedCaptions(next),all=new Map([...next.clips.filter(c=>!captionIds.has(c.id)&&!timingIds.has(c.id)),...captions,...(projected?.clips??[])].map(c=>[c.id,c]));
 next.clips=operationBasis(next)!.order.flatMap(id=>{const c=all.get(id);return c?[c]:[];});
 const fades=new Map(projected?.fades.map(f=>[f.id,f])??[]);
 next.transitions=next.transitions.map(tr=>{if(fades.has(tr.id))return fades.get(tr.id)!;if(!tr.inClipId)return tr;
  const out=next.clips.find(c=>c.id===tr.outClipId),incoming=next.clips.find(c=>c.id===tr.inClipId);
  if(!out||!incoming)throw new SequenceError('BROKEN_REFERENCE','転換の所有者がありません',[tr.id]);
  const startFrame=incoming.startFrame,durationFrames=out.startFrame+out.durationFrames-incoming.startFrame;
  // R3-M5: joinFrame も同じ射影で更新する。set-transition は速度登録中の転換編集を
  // SPEED_REGISTERED で拒否するので書き込みは壊れないが、transitionRoom／
  // transitionJoinsForUi のラベルは古い（射影前の）joinFrame をそのまま読んでしまう。
  // 旧窓の中での相対位置（before の比率）を保ったまま新しい窓へ写す。
  const rejoined=tr.joinFrame===undefined?{}:{joinFrame:tr.durationFrames>0
    ?Math.round(startFrame+((tr.joinFrame-tr.startFrame)/tr.durationFrames)*durationFrames)
    :startFrame};
  return {...tr,startFrame,durationFrames,...rejoined};
 });
 rebindCutBoundariesForSpeed(input,next);
 return next;
}
