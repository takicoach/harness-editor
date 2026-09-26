import type {MotionPositionPolicy} from '../../core/motion';
import {NumberField} from './NativeInspectorFields';
import {useState} from 'react';

/** Percent normally; raw normalized coordinates keep overflowed percentages editable. */
export function NativePositionField({label,value,policy,onCommit}:{label:string;value:number;policy:MotionPositionPolicy;onCommit(value:number):Promise<boolean>}){
  const [draftFactor,setDraftFactor]=useState<number|null>(null);
  const factor=draftFactor??(Number.isFinite(value*100)?100:1),display=value*factor;
  return <NumberField label={`${label}（${factor===100?'%':label.includes('横')?'画面半幅=1':'画面半高=1'}）`} value={display}
    min={policy==='finite'?undefined:Math.min(-1.5*factor,display)} max={policy==='finite'?undefined:Math.max(1.5*factor,display)}
    onEditingChange={active=>setDraftFactor(previous=>active?(previous??factor):null)}
    onCommit={next=>onCommit(next/factor)}/>;
}
