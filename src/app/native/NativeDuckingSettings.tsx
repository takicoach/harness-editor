import type {SequenceDocument} from '../../core/sequence/model';
import type {NativeCommand} from './api';
import {DuckingControls} from '../panels/DuckingControls';

export function NativeDuckingSettings({document:doc,disabled,onEdit}:{document:SequenceDocument;disabled:boolean;onEdit(build:(current:SequenceDocument)=>NativeCommand):Promise<boolean>}){
  return <fieldset className="native-ducking-settings" disabled={disabled}><section data-setting="audio">
    <h3>BGMの自動音量調整</h3>
    <p className="native-subtle">話している間はBGMを下げ、話し終わると元の音量に戻します。</p>
    <DuckingControls value={doc.ducking} disabled={disabled} onChange={patch=>{void onEdit(()=>({type:'set-ducking',patch})).catch(()=>undefined);}}/>
    <p className="native-subtle">文字起こしの発話時刻を使い、この案件のすべてのBGMに適用します。原音と効果音の音量は変わりません。</p>
  </section></fieldset>;
}
