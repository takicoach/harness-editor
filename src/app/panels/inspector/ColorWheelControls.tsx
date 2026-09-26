import { useEffect, useRef, useState, type ReactNode, type PointerEvent } from 'react';
import { normalizeColorWheels, normalizeColorWheel, type ColorWheelName, type ColorWheelValue, type ColorWheels } from '../../../core/colorGrade';
import type { EditState } from '../../edit/editState';
import { currentColorGrade, setColorWheel } from '../../edit/mainVideoOps';
import { NumberField } from './shared';
import './colorWheels.css';

const WHEELS: { name: ColorWheelName; label: string }[] = [
  { name: 'lift', label: '暗部' }, { name: 'gamma', label: '中間調' }, { name: 'gain', label: '明部' },
];

export function ColorWheelControls({ state, onEdit, onLive, supported }: {
  state: EditState; onEdit: (next: EditState) => void;
  onLive?: (next: EditState) => void; supported: boolean;
}) {
  const base=useRef<EditState|null>(null);
  return <ColorWheelInputs wheels={normalizeColorWheels(currentColorGrade(state).wheels)} supported={supported}
    onGestureChange={active=>{if(active)base.current=state;}}
    onFinish={()=>{base.current=null;}}
    onCommit={(name,value)=>onEdit(setColorWheel(base.current??state,name,value))}
    onLive={wheels=>{
      const original=base.current??state;
      const originalWheels=normalizeColorWheels(currentColorGrade(original).wheels);
      onLive?.(JSON.stringify(wheels)===JSON.stringify(originalWheels)?original:
        setColorWheel(setColorWheel(setColorWheel(original,'lift',wheels.lift),'gamma',wheels.gamma),'gain',wheels.gain));
    }}/>;
}

export interface ColorWheelNumberProps {id:string;label:string;value:number;onCommit(value:number):void|Promise<boolean>}
export type ColorWheelChange = {patch:Partial<ColorWheelValue>} | {delta:Partial<ColorWheelValue>};
export function applyColorWheelChange(value:ColorWheelValue,change:ColorWheelChange):ColorWheelValue {
  if('patch' in change)return normalizeColorWheel({...value,...change.patch});
  return normalizeColorWheel({x:value.x+(change.delta.x??0),y:value.y+(change.delta.y??0),level:value.level+(change.delta.level??0)});
}
export function ColorWheelInputs({wheels:input,supported,ownerKey='',onCommit,onLive,onGestureChange,renderNumber,hint,unsupportedHint,onFinish,isCurrent,deferCommit=false,refreshKey}: {
  wheels:ColorWheels;supported:boolean;ownerKey?:string;
  onCommit(name:ColorWheelName,value:ColorWheelValue,change:ColorWheelChange):void|Promise<boolean>;onLive?(wheels:ColorWheels):void;
  isCurrent?():boolean;deferCommit?:boolean;refreshKey?:number;
  onGestureChange?(active:boolean):void;onFinish?():void;renderNumber?(props:ColorWheelNumberProps):ReactNode;hint?:string;unsupportedHint?:ReactNode;
}) {
  const drag = useRef<{ base: ColorWheels; name: ColorWheelName; value: ColorWheelValue; pointer: number; owner:string;isCurrent?:()=>boolean } | null>(null);
  const pending=useRef<typeof drag.current>(null),generation=useRef(0);
  const latest=useRef({ownerKey,supported,onLive,onGestureChange,onFinish,input});latest.current={ownerKey,supported,onLive,onGestureChange,onFinish,input};
  const [live,setLive]=useState<ColorWheels|null>(null);
  const withGesture=(base:ColorWheels,active:NonNullable<typeof drag.current>)=>({...base,[active.name]:{...base[active.name],x:active.value.x,y:active.value.y}});
  const active=drag.current??pending.current;
  const wheels=deferCommit&&active?withGesture(normalizeColorWheels(input),active):live??normalizeColorWheels(input);
  const valid=()=>supported&&(!drag.current||drag.current.owner===ownerKey&&(!drag.current.isCurrent||drag.current.isCurrent()));
  useEffect(()=>{if(drag.current)finish(true);if(pending.current){generation.current++;pending.current=null;setLive(null);onFinish?.();}},[ownerKey,supported]);
  const inputKey=JSON.stringify(input);
  useEffect(()=>{
    if(!deferCommit)return;
    // Dispatch may render before its promise acknowledges the owned revision.
    // Inspect ownership after that acknowledgement, without accepting external edits.
    let disposed=false;
    void Promise.resolve().then(()=>{
      const current=drag.current??pending.current;if(disposed||!current)return;
      if(current.isCurrent&&!current.isCurrent()){
        if(drag.current)finishRef.current(true);
        else{generation.current++;pending.current=null;setLive(null);latest.current.onFinish?.();}
      }else latest.current.onLive?.(withGesture(normalizeColorWheels(latest.current.input),current));
    });
    return()=>{disposed=true;};
  },[inputKey,deferCommit,refreshKey]);
  useEffect(()=>()=>{generation.current++;pending.current=null;if(drag.current){drag.current=null;latest.current.onGestureChange?.(false);}},[]);
  const finishRef=useRef<(cancel:boolean)=>void>(()=>{});
  useEffect(()=>{const cancel=()=>finishRef.current(true);window.addEventListener('blur',cancel);return ()=>window.removeEventListener('blur',cancel);},[]);
  const point = (event: PointerEvent<HTMLButtonElement>, value: ColorWheelValue) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return normalizeColorWheel({ ...value, x: (event.clientX - rect.left - rect.width / 2) * 200 / rect.width,
      y: (event.clientY - rect.top - rect.height / 2) * 200 / rect.height });
  };
  const finish = (cancel: boolean) => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    if(deferCommit&&!cancel&&active.owner===ownerKey&&supported&&(!active.isCurrent||active.isCurrent())){
      const token=++generation.current;pending.current=active;
      onGestureChange?.(false);
      const settled=()=>{if(token!==generation.current)return;pending.current=null;setLive(null);latest.current.onFinish?.();};
      try{void Promise.resolve(onCommit(active.name,active.value,{patch:{x:active.value.x,y:active.value.y}})).then(settled,settled);}catch{settled();}
      return;
    }
    // setTransient replaces the current history entry: restore it before pushing one edit.
    setLive(null);onGestureChange?.(false);
    if(active.owner!==ownerKey||!supported||active.isCurrent&&!active.isCurrent()){onFinish?.();return;}
    onLive?.(active.base);
    if (!cancel) onCommit(active.name, active.value,{patch:{x:active.value.x,y:active.value.y}});
    onFinish?.();
  };
  finishRef.current=finish;
  return <section className="color-wheels" aria-label="カラーホイール">
    <p className="ins-hint">{hint??'暗い部分・中間の明るさ・明るい部分の色を整えます。映像全体に反映されます。'}</p>
    {!supported && unsupportedHint!==null && <p className="export-note export-note-warn" role="note">{unsupportedHint??'ホイールを使うには、「レイアウトを書き出しに導入」で更新してください。'}</p>}
    <fieldset disabled={!supported}>
      <legend className="color-wheels-legend">色のバランス</legend>
      {WHEELS.map(({ name, label }) => {
        const value = wheels[name];
        const commit = (change:ColorWheelChange) => {if(supported)return onCommit(name,applyColorWheelChange(value,change),change);};
        return <div className="color-wheel-row" key={name}>
          <div className="color-wheel-disc-column">
            <span className="color-wheel-title">{label}</span>
            <button type="button" className="color-wheel-disc" aria-label={`${label}の色バランス`}
              aria-describedby="color-wheel-help" data-wheel={name}
              onPointerDown={event => {
                if (event.button !== 0 || drag.current || !supported) return;
                event.preventDefault(); event.currentTarget.focus();
                event.currentTarget.setPointerCapture?.(event.pointerId);
                const next = point(event, value);
                generation.current++;pending.current=null;
                drag.current = { base: normalizeColorWheels(input), name, value: next, pointer: event.pointerId,owner:ownerKey,isCurrent };
                onGestureChange?.(true);
                const updated={...drag.current.base,[name]:next};setLive(updated);onLive?.(updated);
              }}
              onPointerMove={event => {
                const active = drag.current;
                if (!active || active.pointer !== event.pointerId || !valid()) return;
                active.value = point(event, active.value);
                const updated=deferCommit?withGesture(normalizeColorWheels(input),active):{...active.base,[name]:active.value};setLive(updated);onLive?.(updated);
              }}
              onPointerUp={event => { if (drag.current?.pointer === event.pointerId) { finish(false); event.currentTarget.releasePointerCapture?.(event.pointerId); } }}
              onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish(true)}
              onBlur={() => finish(false)}
              onKeyDown={event => {
                if (drag.current) { event.preventDefault(); event.stopPropagation(); if (event.key === 'Escape') finish(true); return; }
                const step = event.shiftKey ? 10 : 1;
                if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) {
                  event.preventDefault(); event.stopPropagation();
                  if (event.key === 'Home') commit({patch:{x:0,y:0}});
                  else commit({delta:{x:event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0,
                    y:event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0}});
                }
              }}>
              <span className="color-wheel-handle" style={{ left: `${50 + value.x / 2}%`, top: `${50 + value.y / 2}%` }} />
            </button>
          </div>
          <div className="color-wheel-values">
            {([{ key: 'x', label: 'シアン ↔ 赤' }, { key: 'y', label: '緑 ↔ 青紫' }, { key: 'level', label: '明るさ' }] as const).map(field =>
              renderNumber ? <div key={field.key}>{renderNumber({id:`wheel-${name}-${field.key}`,label:`${label} ${field.label}`,value:value[field.key],onCommit:n=>commit({patch:{[field.key]:n}})})}</div> :
              <label key={field.key} htmlFor={`wheel-${name}-${field.key}`}>
                <span>{field.label}</span><NumberField id={`wheel-${name}-${field.key}`} value={value[field.key]} min={-100} max={100} step={1} decimals={1}
                  onCommit={n => commit({patch:{[field.key]:n}})} />
              </label>)}
            <button type="button" className="tx-mini-btn" onClick={() => commit({patch:{x:0,y:0,level:0}})}>{label}をリセット</button>
          </div>
        </div>;
      })}
    </fieldset>
    <p className="ins-hint" id="color-wheel-help">円をドラッグして調整。矢印キーで微調整、Shiftで大きく移動、Homeで色を中央に戻せます。</p>
  </section>;
}
