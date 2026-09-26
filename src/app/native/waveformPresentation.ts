import {clipEnd,effectFrameAt,sourceTimeAt,type SequenceClip} from '../../core/sequence/model';
import type {ScenePlan} from '../../core/sequence/scenePlan';
import {rational,type Rational} from '../../core/sequence/time';
import type {WaveformRequest} from '../../server/sequence/waveform';
import type {WaveformViewport} from './waveformViewport';

export const waveformRequestKey=(request:WaveformRequest)=>JSON.stringify([
  request.assetId,request.streamIndex,rational(request.rate.num,request.rate.den),
  rational(request.sourceIn.num,request.sourceIn.den),rational(request.fps.num,request.fps.den),
  request.startFrame,request.frameCount,request.clipFrames,request.bins,request.loop,
]);

/** Project one audio clip with the same source and effect clocks as a committed
 * trim. A move changes its timeline placement, but does not consume source time.
 * No document clone or rebuilding of the plan's speech index is needed. */
export function waveformPresentation(clip:SequenceClip,fps:Rational,viewport:WaveformViewport,
  sourceOffsetFrames:number,displayStartFrame:number,displayDuration:number):
  {ok:true;clip:SequenceClip;request:WaveformRequest}|{ok:false;error:string}{
  try{
    if(clip.content.kind!=='audio')throw new Error('音声クリップが必要です');
    const sourceFrame=clip.startFrame+sourceOffsetFrames;
    const projected:SequenceClip={...clip,startFrame:displayStartFrame,durationFrames:displayDuration,
      clock:{...clip.clock,offset:effectFrameAt(clip,sourceFrame)},
      content:{...clip.content,rate:rational(clip.content.rate.num,clip.content.rate.den),sourceIn:sourceTimeAt(clip,sourceFrame,fps)}};
    if(projected.content.kind!=='audio')throw new Error('音声クリップが必要です');
    return {ok:true,clip:projected,request:{assetId:projected.content.assetId,streamIndex:projected.content.streamIndex,
      rate:projected.content.rate,sourceIn:projected.content.sourceIn,fps:rational(fps.num,fps.den),
      startFrame:viewport.startFrame,frameCount:viewport.frameCount,clipFrames:displayDuration,bins:viewport.bins,loop:projected.content.loop}};
  }catch(error){
    // A tentative trim can exceed the saved Rational precision. The auxiliary
    // waveform must fail locally; cancelling the gesture restores its request.
    return {ok:false,error:error instanceof Error?error.message:'波形の時刻を計算できませんでした'};
  }
}

export function waveformGainAt(plan:ScenePlan,clip:SequenceClip,localFrame:number):number{
  return plan.audioGain(clip,clip.startFrame+localFrame,Math.max(plan.document.sequenceEndFrame,clipEnd(clip)));
}
