import {useContext,useEffect,useId,useRef} from 'react';
import {defaultColorGrade,normalizeColorWheels,type ColorWheelName,type ColorWheelValue} from '../../core/colorGrade';
import type {ClipVisual} from '../../core/sequence/model';
import {ColorWheelInputs,type ColorWheelChange} from '../panels/inspector/ColorWheelControls';
import {InspectorDraftContext,NumberField} from './NativeInspectorFields';

/** Transient pixels are outside the document; only a completed gesture enters the intent queue. */
export function NativeColorWheels({ownerKey,revision,clipId,visual,disabled,isCurrent,onCommit,onPreview}: {
  ownerKey:string;revision:number;clipId:string;visual:ClipVisual;disabled:boolean;isCurrent():boolean;
  onCommit(name:ColorWheelName,value:ColorWheelValue,change:ColorWheelChange):Promise<boolean>;
  onPreview?(clipId:string,visual:ClipVisual|null):void;
}) {
  const report=useContext(InspectorDraftContext),id=useId(),active=useRef(false),mounted=useRef(true);
  const latest=useRef({isCurrent,onPreview,clipId});latest.current={isCurrent,onPreview,clipId};
  const clear=()=>{if(active.current){active.current=false;report?.(id,false);onPreview?.(clipId,null);}};
  useEffect(()=>{mounted.current=true;return ()=>{mounted.current=false;report?.(id,false);if(active.current){active.current=false;latest.current.onPreview?.(latest.current.clipId,null);}};},[]);
  useEffect(()=>{clear();},[ownerKey,disabled]);
  return <ColorWheelInputs wheels={normalizeColorWheels(visual.colorGrade?.wheels)} ownerKey={ownerKey} refreshKey={revision} supported={!disabled} unsupportedHint={null} isCurrent={isCurrent} deferCommit onFinish={clear}
    hint="暗部・中間調・明部の色を整えます。選択中の映像に反映されます。"
    onGestureChange={value=>{if(!value){report?.(id,false);return;}if(mounted.current&&!disabled&&isCurrent()){active.current=true;report?.(id,true);}}}
    onLive={wheels=>{if(active.current&&mounted.current&&!disabled&&isCurrent())onPreview?.(clipId,{...visual,colorGrade:{...(visual.colorGrade??defaultColorGrade()),wheels}});else clear();}}
    onCommit={(name,value,change)=>{if(mounted.current&&!disabled&&isCurrent())return onCommit(name,value,change).catch(()=>false);}}
    renderNumber={({label,value,onCommit})=><NumberField label={label} value={Math.round(value*100)/100} min={-100} max={100} step={1} onCommit={onCommit}/>}/>;
}
