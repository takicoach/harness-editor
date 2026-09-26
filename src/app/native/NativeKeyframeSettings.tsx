import {DEFAULT_MAIN_LAYOUT} from '../../core/mainLayout';
import {clipEnd,type ClipVisual,type SequenceClip,type TransformKey} from '../../core/sequence/model';
import {compareTime,rational,timeNumber,type Rational} from '../../core/sequence/time';
import {keyframeTimelineTime,punchVisualKeyframe,visualKeyframeTime} from '../../core/sequence/visualTransform';
import {NumberField} from './NativeInspectorFields';
import {SequenceError} from '../../core/sequence/errors';
import {visualPositionPolicy} from '../../core/sequence/visualPositionPolicy';
import {NativePositionField} from './NativePositionField';

function representableTime(read:()=>Rational):Rational|null {
  try{return read();}catch(error){if(error instanceof SequenceError&&error.code==='TIME_OVERFLOW')return null;throw error;}
}

export function NativeKeyframeSettings({clip,frame,fps,onSeek,onFieldAction,onAction,timing}:{clip:SequenceClip;frame:number;fps:Rational;timing?:ReactNode;onSeek(key:Rational):void;onFieldAction(change:(current:SequenceClip)=>ClipVisual):Promise<boolean>;onAction(change:(current:SequenceClip)=>ClipVisual):Promise<boolean>}){
  const [error,setError]=useState('');
  const visual=clip.visual??{layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[]};
  const current=representableTime(()=>visualKeyframeTime(clip,frame)),inside=frame>=clip.startFrame&&frame<clipEnd(clip)&&current!==null&&current.num>=0;
  const context=`${clip.id}:${frame}`,latestContext=useRef(context),invocation=useRef(0);latestContext.current=context;
  useEffect(()=>setError(''),[clip.id,frame]);
  useEffect(()=>{if(inside)setError('');},[inside]);
  const perform=async(change:(current:SequenceClip)=>ClipVisual)=>{const generation=++invocation.current;setError('');try{if(!await onAction(change))throw new Error('キーフレームを保存できませんでした。内容を確認して、もう一度操作してください。');}catch(error){if(latestContext.current===context&&invocation.current===generation)setError(error instanceof Error?error.message:'キーフレームを変更できませんでした');}};
  if(clip.content.kind==='audio'||clip.content.kind==='scene-fade')return null;
  const keys=visual.keyframes.map((key,index)=>({key,index})).sort((a,b)=>compareTime(a.key.frame,b.key.frame));
  const requireSameKeys=(current:SequenceClip)=>{
    const latest=current.visual;
    if(!latest||latest.keyframes.length!==visual.keyframes.length||latest.keyframes.some((key,index)=>compareTime(key.frame,visual.keyframes[index]!.frame)!==0))throw new Error('位置キーの並びが変わりました。点を確認して、もう一度操作してください。');
    return latest;
  };
  const editKey=(current:SequenceClip,index:number,change:(key:TransformKey,visual:ClipVisual)=>Partial<TransformKey>)=>{
    const latest=requireSameKeys(current);
    return {...latest,keyframes:latest.keyframes.map((key,i)=>i===index?{...key,...change(key,latest)}:key)};
  };
  const update=(index:number,change:(key:TransformKey,visual:ClipVisual)=>Partial<TransformKey>)=>onFieldAction(current=>editKey(current,index,change));
  return <section className="native-position-keys" onKeyDown={event=>{if(event.target instanceof HTMLButtonElement&&(event.key===' '||event.key==='Enter'))event.stopPropagation();}}><h3>位置キーフレーム</h3>
    <button disabled={!inside} onPointerDown={event=>event.preventDefault()} onClick={()=>perform(current=>punchVisualKeyframe(current,frame))}>現在の位置を記録</button>
    {error&&<p role="alert">{error}</p>}
    <p className="native-subtle">{inside?'再生位置の配置を記録し、点の間で動かします。':'選択したクリップの再生位置へ移動してください。'}</p>
    {keys.length>0&&<>
      {timing}
      <p className="native-subtle">{clip.content.kind==='telop'?'文字自体の動きに、レイヤーの位置キーフレームを重ねます。':'位置キーフレームは「動き方」より優先されます。'}</p>
      {keys.map(({key,index},order)=>{
        const timeline=representableTime(()=>keyframeTimelineTime(clip,key.frame)),at=timeline===null?null:timeNumber(timeline),inClip=timeline!==null&&compareTime(timeline,rational(clip.startFrame))>=0&&compareTime(timeline,rational(clipEnd(clip)))<0;
        const value=key.value,base=visual.layout,prefix=`点 ${order+1}`;
        return <div className="native-motion-key" data-native-position-key={order+1} key={`${key.frame.num}/${key.frame.den}:${index}`}>
          <div><button disabled={!inClip} onPointerDown={event=>event.preventDefault()} aria-label={`${prefix}の位置へ移動`} aria-current={current!==null&&compareTime(current,key.frame)===0?'true':undefined} onClick={()=>onSeek(key.frame)}>{prefix} · {at===null?'時刻を表示できません':`${(at/timeNumber(fps)).toFixed(2)} 秒`}</button>{timeline!==null&&!inClip&&<small> クリップの範囲外</small>}</div>
          <NativePositionField label={`${prefix} 横位置`} value={value.position?.x??base.position.x} policy={visualPositionPolicy(clip)} onCommit={x=>update(index,(key,visual)=>({value:{...key.value,position:{x,y:key.value.position?.y??visual.layout.position.y}}}))}/>
          <NativePositionField label={`${prefix} 縦位置`} value={value.position?.y??base.position.y} policy={visualPositionPolicy(clip)} onCommit={y=>update(index,(key,visual)=>({value:{...key.value,position:{x:key.value.position?.x??visual.layout.position.x,y}}}))}/>
          <NumberField label={`${prefix} 大きさ（%）`} value={(value.scale??base.scale)*100} min={Math.min(5,(value.scale??base.scale)*100)} max={Math.max(800,(value.scale??base.scale)*100)} onCommit={scale=>update(index,key=>({value:{...key.value,scale:scale/100}}))}/>
          <NumberField label={`${prefix} 回転（°）`} value={value.rotation??base.rotation} min={Math.min(-360,value.rotation??base.rotation)} max={Math.max(360,value.rotation??base.rotation)} onCommit={rotation=>update(index,key=>({value:{...key.value,rotation}}))}/>
          <NumberField label={`${prefix} 不透明度（%）`} value={(value.opacity??visual.opacity)*100} min={0} max={100} onCommit={opacity=>update(index,key=>({value:{...key.value,opacity:opacity/100}}))}/>
          {order<keys.length-1&&<div role="group" aria-label={`${prefix} 次の点までの動き`}><p className="native-subtle">次の点までの動き</p>
            <button aria-pressed={(key.easing??'linear')==='linear'} onPointerDown={event=>event.preventDefault()} onClick={()=>perform(current=>editKey(current,index,()=>({easing:'linear'})))}>一定の速さ</button>
            <button aria-pressed={key.easing==='easeInOut'} onPointerDown={event=>event.preventDefault()} onClick={()=>perform(current=>editKey(current,index,()=>({easing:'easeInOut'})))}>ゆっくり開始・終了</button>
          </div>}
          <button aria-label={`${prefix}を削除`} onPointerDown={event=>event.preventDefault()} onClick={()=>perform(current=>{const latest=requireSameKeys(current);return {...latest,keyframes:latest.keyframes.filter((_,i)=>i!==index)};})}>この点を削除</button>
        </div>;
      })}
      <div role="group" aria-label="キーフレーム範囲外"><p className="native-subtle">最初と最後の点の外</p>
        <button aria-pressed={(visual.keyframesOutside??'hold')==='hold'} onPointerDown={event=>event.preventDefault()} onClick={()=>perform(current=>({...current.visual??visual,keyframesOutside:'hold'}))}>端の値を保持</button>
        <button aria-pressed={visual.keyframesOutside==='base'} onPointerDown={event=>event.preventDefault()} onClick={()=>perform(current=>({...current.visual??visual,keyframesOutside:'base'}))}>元の配置</button>
      </div>
      <button onPointerDown={event=>event.preventDefault()} onClick={()=>perform(current=>({...current.visual??visual,keyframes:[]}))}>位置キーフレームを全解除</button>
    </>}
  </section>;
}
import {useEffect,useRef,useState,type ReactNode} from 'react';
