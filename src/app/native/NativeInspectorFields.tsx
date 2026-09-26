import { createContext,useContext,useEffect,useId,useRef,useState,type ReactNode } from 'react';
import {isEscape} from './keyboard';

const format=(value:number)=>String(Number(value.toFixed(6)));
type Commit<T>=(value:T)=>void|boolean|Promise<boolean>;
export const InspectorDraftContext=createContext<((id:string,dirty:boolean)=>void)|null>(null);
function useFieldDraft<T>(value:T,onCommit:Commit<T>,display:(value:T)=>string,onEditingChange?:(active:boolean)=>void){
  const report=useContext(InspectorDraftContext),id=useId();
  const [draft,setDraft]=useState(display(value)),confirmed=useRef(value),last=useRef(value),dirty=useRef(false),pending=useRef(0),generation=useRef(0);
  const settled=useRef<{generation:number;ok:boolean;value:T}>();
  confirmed.current=value;
  useEffect(()=>()=>report?.(id,false),[report,id]);
  useEffect(()=>{if(pending.current===0){last.current=value;if(!dirty.current)setDraft(display(value));}},[value]);
  const change=(next:string)=>{dirty.current=true;setDraft(next);report?.(id,true);onEditingChange?.(true);};
  const revert=()=>{dirty.current=false;setDraft(display(confirmed.current));report?.(id,false);onEditingChange?.(pending.current>0);};
  const commit=(next:T)=>{
    if(!dirty.current)return;
    dirty.current=false;setDraft(display(next));report?.(id,false);
    if(pending.current===0&&Object.is(next,last.current)){onEditingChange?.(false);return;}
    last.current=next;pending.current++;const current=++generation.current;
    onEditingChange?.(true);
    const finish=(ok:boolean)=>{
      pending.current--;
      onEditingChange?.(dirty.current||pending.current>0);
      if(current===generation.current)settled.current={generation:current,ok,value:next};
      const result=settled.current;
      if(pending.current!==0||result?.generation!==generation.current)return;
      if(!result.ok)last.current=confirmed.current;
      if(!dirty.current)setDraft(display(result.ok?result.value:confirmed.current));
    };
    try{void Promise.resolve(onCommit(next)).then(ok=>finish(ok!==false),()=>finish(false));}catch{finish(false);}
  };
  return {draft,change,revert,commit};
}
export function NumberField({label,value,onCommit,min,max,step=1,onEditingChange}:{label:string;value:number;onCommit:Commit<number>;min?:number;max?:number;step?:number;onEditingChange?:(active:boolean)=>void}){
  // Includes pending commits, so callers can preserve the draft's display unit
  // until a newer draft and every earlier save have both settled.
  const {draft,change,revert,commit}=useFieldDraft(value,onCommit,format,onEditingChange);
  const sliderMin=min??Math.min(-100,value),sliderMax=max??Math.max(100,value*2),parsed=Number(draft);
  const commitSlider=()=>{if(Number.isFinite(parsed))commit(Math.min(sliderMax,Math.max(sliderMin,parsed)));else revert();};
  return <div className="native-number-field"><label className="native-property"><span>{label}</span><input aria-label={label} type="number" min={min} max={max} step={step} value={draft}
    onChange={event=>change(event.target.value)}
    onBlur={event=>{
      const raw=event.currentTarget.value.trim(),parsed=Number(raw);
      if(!raw||!Number.isFinite(parsed)){revert();return;}
      const next=Math.min(max??Infinity,Math.max(min??-Infinity,parsed));commit(next);
    }}
    onKeyDown={event=>{
      // M-5': 変換中の Esc は IME のもの（下書きを巻き戻さない）。Enter も変換の確定なので手を出さない。
      if(event.nativeEvent.isComposing)return;
      if(event.key!=='Enter'&&!isEscape(event.nativeEvent))return;
      event.preventDefault();event.stopPropagation();
      if(isEscape(event.nativeEvent)){event.currentTarget.value=format(value);revert();}
      event.currentTarget.blur();
    }}/></label><input className="native-property-slider" type="range" aria-label={`${label}を調整`} min={sliderMin} max={sliderMax} step={step} value={Number.isFinite(parsed)?Math.min(sliderMax,Math.max(sliderMin,parsed)):value}
      onChange={event=>change(event.target.value)} onPointerUp={commitSlider} onBlur={commitSlider}
      onKeyUp={event=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key))commitSlider();}}
      onKeyDown={event=>{event.stopPropagation();if(event.nativeEvent.isComposing)return;if(isEscape(event.nativeEvent)){event.preventDefault();revert();}else if(event.key==='Enter'){event.preventDefault();commitSlider();}}}/></div>;
}
export function TextField({value,onCommit}:{value:string;onCommit:Commit<string>}){
  const {draft,change,revert,commit}=useFieldDraft(value,onCommit,String);
  return <label className="native-text-field">テキスト<textarea aria-label="テキスト" rows={4} value={draft}
    onChange={event=>change(event.target.value)}
    onBlur={event=>commit(event.currentTarget.value)}
    onKeyDown={event=>{if(isEscape(event.nativeEvent)){event.preventDefault();event.stopPropagation();event.currentTarget.value=value;revert();event.currentTarget.blur();}}}/></label>;
}
export function ColorField({label,value,onCommit}:{label:string;value:string;onCommit:Commit<string>}){
  const {draft,change,revert,commit}=useFieldDraft(value,onCommit,String);
  return <label className="native-property"><span>{label}</span><input type="color" aria-label={label} value={draft}
    onChange={event=>change(event.target.value)} onBlur={event=>commit(event.currentTarget.value)}
    onKeyDown={event=>{if(isEscape(event.nativeEvent)){event.preventDefault();event.stopPropagation();revert();event.currentTarget.blur();}}}/></label>;
}
export function SelectField({label,value,onCommit,children}:{label:string;value:string;onCommit:Commit<string>;children:ReactNode}){
  const {draft,change,commit}=useFieldDraft(value,onCommit,String);
  return <label className="native-property"><span>{label}</span><select aria-label={label} value={draft} onChange={event=>{const next=event.target.value;change(next);commit(next);}}>{children}</select></label>;
}
export function CheckField({label,value,onCommit}:{label:string;value:boolean;onCommit:Commit<boolean>}){
  const {draft,change,commit}=useFieldDraft(value,onCommit,String);
  return <label className="native-check"><input type="checkbox" checked={draft==='true'} onChange={event=>{const next=event.target.checked;change(String(next));commit(next);}}/>{label}</label>;
}

/** Exact textual values with local validation. Invalid drafts remain dirty, so
 * the existing Inspector flush blocks a save/view transition until corrected. */
export function ValidatedTextField({label,value,onCommit,validate,hint}:{label:string;value:string;onCommit:Commit<string>;validate(value:string):void;hint?:string}){
  const {draft,change,revert,commit}=useFieldDraft(value,onCommit,String),[error,setError]=useState(''),id=useId();
  return <div className="native-validated-field"><label className="native-property"><span>{label}</span><input aria-label={label} type="text" inputMode="decimal" value={draft} aria-invalid={!!error} aria-describedby={hint||error?id:undefined}
    onChange={event=>{setError('');change(event.target.value);}}
    onBlur={event=>{try{validate(event.currentTarget.value);setError('');commit(event.currentTarget.value);}catch(cause){setError(cause instanceof Error?cause.message:'入力内容を確認してください。');}}}
    onKeyDown={event=>{event.stopPropagation();if(event.nativeEvent.isComposing)return;if(event.key!=='Enter'&&!isEscape(event.nativeEvent))return;event.preventDefault();if(isEscape(event.nativeEvent)){event.currentTarget.value=value;setError('');revert();}event.currentTarget.blur();}}/></label>
    {(hint||error)&&<p id={id} className="native-subtle" role={error?'alert':undefined}>{error||hint}</p>}
  </div>;
}
