import {compareTime,sampleTimeClock} from '../../core/sequence/time';
import {punchVisualKeyframe,visualKeyframeTime} from '../../core/sequence/visualTransform';
import type {ClipVisual,SequenceClip} from '../../core/sequence/model';
import {DEFAULT_MAIN_LAYOUT} from '../../core/mainLayout';
import {clampMotionState} from '../../core/motion';
import {visualPositionPolicy} from '../../core/sequence/visualPositionPolicy';
import type {PreviewPlacement} from './previewManipulation';

export function previewKeysActive(clip:SequenceClip,frame:number):boolean {
  const visual=clip.visual,keys=visual?.keyframes;
  if(!visual||!keys?.length)return false;
  if(visual.keyframesOutside!=='base')return true;
  const sorted=[...keys].sort((a,b)=>compareTime(a.frame,b.frame)),clock=visual.keyframeClock??clip.clock;
  const at=sampleTimeClock(clock.offset,clock.rate,frame-clip.startFrame);
  return at.compare(sorted[0]!.frame)>=0&&at.compare(sorted.at(-1)!.frame)<=0;
}
export function previewPlacementInRange(value:PreviewPlacement,clip?:SequenceClip):boolean {
  if(![value.x,value.y,value.scale,value.rotation].every(Number.isFinite))return false;
  const clamped=clampMotionState({...value,opacity:1},clip?visualPositionPolicy(clip):'bounded');
  return [value.x,value.y,value.scale,value.rotation].every(Number.isFinite)&&clamped.x===value.x&&clamped.y===value.y&&clamped.scale===value.scale&&clamped.rotation===value.rotation;
}
/** Changes only placement; key recording uses the same exact clock and duplicate semantics as Inspector. */
export function previewPlacementVisual(clip:SequenceClip,frame:number,value:PreviewPlacement):ClipVisual {
  if(!previewPlacementInRange(value,clip))throw new Error('配置の操作範囲を超えています。');
  if(previewKeysActive(clip,frame)){
    const visual=punchVisualKeyframe(clip,frame),time=visualKeyframeTime(clip,frame);
    const index=visual.keyframes.map((key,index)=>compareTime(key.frame,time)===0?index:-1).filter(index=>index>=0).at(-1)!;
    const key=visual.keyframes[index]!;
    key.value={...key.value,position:{x:value.x,y:value.y},scale:value.scale};
    return visual;
  }
  const visual=structuredClone(clip.visual??{layout:DEFAULT_MAIN_LAYOUT,opacity:1,keyframes:[]});
  visual.layout.position={x:value.x,y:value.y};visual.layout.scale=value.scale;
  return visual;
}
