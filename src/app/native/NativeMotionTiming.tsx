import type {SequenceClip} from '../../core/sequence/model';
import type {Rational} from '../../core/sequence/time';
import {SequenceError} from '../../core/sequence/errors';
import type {NativeCommand} from './api';
import {ValidatedTextField} from './NativeInspectorFields';
import {firstMotionKey,firstMotionKeySeconds,motionRateClock,motionStartClock,motionTimingValue,parseMotionTiming} from './motionTiming';

type Edit=(build:(current:SequenceClip)=>NativeCommand)=>Promise<boolean>;
export function NativeMotionTiming({clip,fps,onEdit,onAction}:{clip:SequenceClip;fps:Rational;onEdit:Edit;onAction:Edit}){
 if(!clip.insertOwnSpeed||clip.content.kind!=='video'||!clip.visual?.keyframes.length)return null;
 const clock=clip.visual.keyframeClock??clip.clock,first=firstMotionKey(clip);
 let start:string|null=null;try{start=motionTimingValue(firstMotionKeySeconds(clip,fps));}catch(error){if(!(error instanceof SequenceError)||error.code!=='TIME_OVERFLOW')throw error;}
 return <div role="group" aria-label="位置キーのタイミング">
  <p className="native-subtle">素材の長さを変えず、動く速さと開始位置を調整します。秒はクリップの先頭からの位置です。</p>
  <ValidatedTextField label="動きの速さ（倍）" value={motionTimingValue(clock.rate)} validate={text=>parseMotionTiming(text,true)}
   onCommit={text=>onEdit(current=>({type:'rebase-native-insert-own-keyframe-clock',clipId:current.id,clock:motionRateClock(current,parseMotionTiming(text,true),first)}))}/>
  {start===null?<p className="native-subtle">最初の点の位置を正確に表示できません。速さを調整するか、素材に合わせてください。</p>:
   <ValidatedTextField label="最初の点（クリップ内秒）" value={start} validate={text=>parseMotionTiming(text)}
    onCommit={text=>onEdit(current=>({type:'rebase-native-insert-own-keyframe-clock',clipId:current.id,clock:motionStartClock(current,fps,parseMotionTiming(text),first)}))}/>}
  <button disabled={!clip.visual.keyframeClock} onClick={()=>{void onAction(current=>({type:'rebase-native-insert-own-keyframe-clock',clipId:current.id,clock:null})).catch(()=>{});}}>素材の動きに合わせる</button>
 </div>;
}
