import {DEFAULT_MAIN_LAYOUT} from '../mainLayout';
import {easeInOutCubic,interpolatePosition,sampleMotion} from '../motion';
import {visualPositionPolicy} from './visualPositionPolicy';
import {clipEnd,effectFrameAt,type ClipVisual,type SequenceClip} from './model';
import {SequenceError} from './errors';
import {addTime,compareTime,divideTime,multiplyTime,rational,sampleTimeClock,subtractTime,timeNumber,type Rational} from './time';

/** Position on the retained effect clock, including legacy clocks and cut fragments. */
export function visualKeyframeTime(clip:SequenceClip,frame:number):Rational {
  const clock=clip.visual?.keyframeClock??clip.clock;
  return addTime(clock.offset,multiplyTime(rational(frame-clip.startFrame),clock.rate));
}
export function keyframeTimelineTime(clip:SequenceClip,frame:Rational):Rational {
  const clock=clip.visual?.keyframeClock??clip.clock;
  return addTime(rational(clip.startFrame),divideTime(subtractTime(frame,clock.offset),clock.rate));
}

/** Shared by preview/export and the inspector's capture-current-position action. */
export function sampleVisualTransform(clip:SequenceClip,frame:number) {
  const positionPolicy=visualPositionPolicy(clip);
  const effectFrame=timeNumber(effectFrameAt(clip,frame)),effectDuration=timeNumber(clip.clock.duration);
  const layout=structuredClone(clip.visual?.layout??DEFAULT_MAIN_LAYOUT);
  let opacity=clip.visual?.opacity??1;
  const keys=[...(clip.visual?.keyframes??[])].sort((a,b)=>compareTime(a.frame,b.frame));
  const clock=clip.visual?.keyframeClock??clip.clock,keyFrame=sampleTimeClock(clock.offset,clock.rate,frame-clip.startFrame);
  const keysActive=keys.length>0&&(clip.visual?.keyframesOutside!=='base'||(keyFrame.compare(keys[0]!.frame)>=0&&keyFrame.compare(keys.at(-1)!.frame)<=0));
  if(keysActive){
    const after=keys.findIndex(key=>keyFrame.compare(key.frame)<0);
    const right=after<0?keys.at(-1)!:keys[after]!;
    const left=after<=0?(after===0?keys[0]!:keys.at(-1)!):keys[after-1]!;
    const progress=Math.max(0,Math.min(1,keyFrame.progress(left.frame,right.frame)));
    const t=left.easing==='easeInOut'?easeInOutCubic(progress):progress,lerp=(a:number,b:number)=>a+(b-a)*t;
    layout.position.x=interpolatePosition(left.value.position?.x??layout.position.x,right.value.position?.x??layout.position.x,t,positionPolicy);
    layout.position.y=interpolatePosition(left.value.position?.y??layout.position.y,right.value.position?.y??layout.position.y,t,positionPolicy);
    layout.scale=lerp(left.value.scale??layout.scale,right.value.scale??layout.scale);
    layout.rotation=lerp(left.value.rotation??layout.rotation,right.value.rotation??layout.rotation);
    layout.flipH=left.value.flipH??layout.flipH;layout.flipV=left.value.flipV??layout.flipV;
    opacity=lerp(left.value.opacity??opacity,right.value.opacity??opacity);
  }
  const motion=sampleMotion(keysActive?undefined:clip.visual?.motion,{x:layout.position.x,y:layout.position.y,scale:layout.scale,rotation:layout.rotation,opacity},Math.max(0,Math.min(1,effectFrame/Math.max(1,effectDuration))),positionPolicy);
  if(clip.content.kind==='scene-fade'){
    const p=Math.max(0,Math.min(1,effectFrame/effectDuration));
    motion.opacity*=clip.content.phase==='head'?1-p:clip.content.phase==='tail'?p:1-Math.abs(2*p-1);
  }
  return {...motion,flipH:layout.flipH,flipV:layout.flipV};
}

export function punchVisualKeyframe(clip:SequenceClip,frame:number):ClipVisual {
  if(!Number.isSafeInteger(frame)||frame<clip.startFrame||frame>=clipEnd(clip)||clip.content.kind==='audio'||clip.content.kind==='scene-fade')throw new SequenceError('INVALID_TIME','選択したクリップの再生位置に移動してください');
  const time=visualKeyframeTime(clip,frame);if(time.num<0)throw new SequenceError('INVALID_TIME','この位置にはキーフレームを追加できません');
  const visual=structuredClone(clip.visual??{layout:DEFAULT_MAIN_LAYOUT,opacity:1,keyframes:[]});
  const current=sampleVisualTransform(clip,frame),existingIndex=visual.keyframes.map((key,index)=>compareTime(key.frame,time)===0?index:-1).filter(index=>index>=0).at(-1);
  const existing=existingIndex===undefined?undefined:visual.keyframes[existingIndex];
  const value={position:{x:current.x,y:current.y},scale:current.scale,rotation:current.rotation,flipH:current.flipH,flipV:current.flipV,opacity:current.opacity};
  const recorded={frame:time,value,...(existing?.easing?{easing:existing.easing}:{})};
  if(existingIndex===undefined)visual.keyframes.push(recorded);else visual.keyframes[existingIndex]=recorded;
  visual.keyframes.sort((a,b)=>compareTime(a.frame,b.frame));
  return visual;
}
