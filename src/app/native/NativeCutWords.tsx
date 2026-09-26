import {useEffect,useRef,useState} from 'react';
import type {CutWord} from './cutPresentation';
import type {CutRange} from './NativeCutRange';

interface Props {words:CutWord[];value:CutRange;disabled:boolean;onChange(value:CutRange):void}
/** Selection is local until Restore. A cancelled gesture restores that local selection. */
export function NativeCutWords(props:Props){
  const latest=useRef(props);latest.current=props;
  const anchor=useRef<number|null>(null),drag=useRef<{pointerId:number;from:number;initial:CutRange;anchor:number|null}|null>(null);
  const [shown,setShown]=useState(80);
  function select(from:number,to:number){
    const words=latest.current.words.slice(Math.min(from,to),Math.max(from,to)+1);if(!words.length)return;
    latest.current.onChange({startFrame:Math.min(...words.map(w=>w.startFrame)),endFrame:Math.max(...words.map(w=>w.endFrame))});
  }
  function cancel(){const current=drag.current;drag.current=null;if(current){anchor.current=current.anchor;latest.current.onChange(current.initial);}}
  useEffect(()=>{
    const up=(event:PointerEvent)=>{if(event.pointerId===drag.current?.pointerId)drag.current=null;};
    const abort=(event:PointerEvent)=>{if(event.pointerId===drag.current?.pointerId)cancel();};
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&drag.current){event.preventDefault();event.stopPropagation();cancel();}};
    window.addEventListener('pointerup',up);window.addEventListener('pointercancel',abort);window.addEventListener('blur',cancel);window.addEventListener('keydown',key,true);
    return()=>{drag.current=null;window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',abort);window.removeEventListener('blur',cancel);window.removeEventListener('keydown',key,true);};
  },[]);
  useEffect(()=>{if(props.disabled)drag.current=null;},[props.disabled]);
  return <div className="native-cut-words" aria-label="カットしたことば">{props.words.slice(0,shown).map((word,index)=><button key={word.id} disabled={props.disabled} aria-pressed={word.startFrame>=props.value.startFrame&&word.endFrame<=props.value.endFrame}
    onPointerDown={event=>{
      if(event.button!==0||drag.current||props.disabled)return;
      const from=event.shiftKey?(anchor.current??index):index;
      drag.current={pointerId:event.pointerId,from,initial:{...props.value},anchor:anchor.current};anchor.current=from;select(from,index);
    }}
    onPointerEnter={event=>{const current=drag.current;if(current&&event.pointerId===current.pointerId&&(event.buttons&1))select(current.from,index);}}
    onClick={event=>{if(event.detail===0){const from=event.shiftKey?(anchor.current??index):index;anchor.current=from;select(from,index);}}}>{word.text}</button>)}
    {shown<props.words.length&&<button disabled={props.disabled} onClick={()=>setShown(value=>value+80)}>続きのことばを表示</button>}
  </div>;
}
