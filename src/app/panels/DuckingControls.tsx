import type {DuckingSettings,DuckingStrength} from '../../core/types';

/** Shared with the original settings menu; the host owns persistence and Undo. */
export function DuckingControls({value,disabled=false,onChange}:{value:DuckingSettings;disabled?:boolean;onChange(patch:Partial<DuckingSettings>):void}){
  return <div className="tb-ducking" role="group" aria-label="ダッキング">
    <button type="button" className={'tb-duck-toggle'+(value.enabled?' on':'')} disabled={disabled} aria-pressed={value.enabled}
      title={value.enabled?'ダッキング ON（喋り中に BGM を下げる）':'ダッキング OFF'}
      onClick={()=>onChange({enabled:!value.enabled})}><span>{value.enabled?'ON':'OFF'}</span></button>
    <div className="tb-duck-strength">{(['weak','mid','strong'] as DuckingStrength[]).map(strength=><button type="button" key={strength}
      className={'tb-duck-lv'+(value.strength===strength?' active':'')} disabled={disabled||!value.enabled} aria-pressed={value.strength===strength}
      onClick={()=>onChange({strength})}>{strength==='weak'?'弱':strength==='mid'?'中':'強'}</button>)}</div>
  </div>;
}
