import {useEffect,useRef,type PointerEvent} from 'react';
export interface CutRange {startFrame:number;endFrame:number}
interface Props {duration:number;value:CutRange;disabled:boolean;onChange(value:CutRange):void}
export function NativeCutRange(props:Props){
  const latest=useRef(props);latest.current=props;
  const track=useRef<HTMLDivElement>(null),drag=useRef<{edge:'start'|'end';pointerId:number;capture:HTMLElement;initial:CutRange}|null>(null);
  function release(restore=false){
    const current=drag.current;drag.current=null;if(!current)return;
    if(restore)latest.current.onChange(current.initial);
    try{if(current.capture.hasPointerCapture(current.pointerId))current.capture.releasePointerCapture(current.pointerId);}catch{/* retired pointer */}
  }
  function change(edge:'start'|'end',value:number){
    const current=latest.current;if(current.disabled)return;
    if(edge==='start')current.onChange({...current.value,startFrame:Math.max(0,Math.min(current.value.endFrame-1,Math.round(value)))});
    else current.onChange({...current.value,endFrame:Math.max(current.value.startFrame+1,Math.min(current.duration,Math.round(value)))});
  }
  useEffect(()=>{
    const move=(event:globalThis.PointerEvent)=>{const current=drag.current,bounds=track.current?.getBoundingClientRect();if(!current||event.pointerId!==current.pointerId||!bounds?.width)return;change(current.edge,(event.clientX-bounds.left)/bounds.width*latest.current.duration);};
    const up=(event:globalThis.PointerEvent)=>{if(event.pointerId===drag.current?.pointerId)release();};
    const cancel=()=>release(true),key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&drag.current){event.preventDefault();event.stopPropagation();release(true);}};
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);window.addEventListener('pointercancel',cancel);window.addEventListener('blur',cancel);window.addEventListener('keydown',key,true);
    return()=>{release();window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',cancel);window.removeEventListener('blur',cancel);window.removeEventListener('keydown',key,true);};
  },[]);
  useEffect(()=>{if(props.disabled)release();},[props.disabled]);
  function begin(event:PointerEvent<HTMLButtonElement>,edge:'start'|'end'){
    if(props.disabled||event.button!==0||drag.current)return;event.preventDefault();event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);drag.current={edge,pointerId:event.pointerId,capture:event.currentTarget,initial:{...props.value}};
  }
  return <div className="native-cut-range"><div ref={track} className="native-cut-range-track">
    <span className="native-cut-range-selected" style={{left:`${props.value.startFrame/props.duration*100}%`,width:`${(props.value.endFrame-props.value.startFrame)/props.duration*100}%`}}/>
    {(['start','end'] as const).map(edge=>{
      const value=edge==='start'?props.value.startFrame:props.value.endFrame,min=edge==='start'?0:props.value.startFrame+1,max=edge==='start'?props.value.endFrame-1:props.duration;
      return <button key={edge} type="button" role="slider" className={`native-cut-handle native-cut-handle-${edge}`} aria-label={edge==='start'?'戻す範囲の開始つまみ':'戻す範囲の終了つまみ'} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} aria-valuetext={`${value}フレーム`} disabled={props.disabled}
        style={{left:`${value/props.duration*100}%`}} onPointerDown={event=>begin(event,edge)} onLostPointerCapture={()=>{drag.current=null;}}
        onKeyDown={event=>{const delta=event.key==='ArrowLeft'||event.key==='ArrowDown'?-1:event.key==='ArrowRight'||event.key==='ArrowUp'?1:0;if(delta||event.key==='Home'||event.key==='End'){event.preventDefault();event.stopPropagation();change(edge,event.key==='Home'?min:event.key==='End'?max:value+delta*(event.shiftKey?10:1));}}}>{edge==='start'?'[':']'}</button>;
    })}
  </div></div>;
}
