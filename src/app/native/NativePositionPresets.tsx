import {POSITION_PRESET_LABELS,applyPositionPreset} from './positionPreset';
import {applyLayerPreset} from './layerPreset';

/**
 * 3×3 の整列ボタン。位置の単位は正規化座標。
 *
 * `preset` は必須（既定値を置かない）。`caption` は字幕の下端基準（`POSITION_PRESETS`）、
 * `layer` はレイヤーの中心基準・三分割（`LAYER_POSITION_PRESETS`）。取り違えると
 * 「下段を押すと中央へ行く」不具合（#8）に戻る。
 *
 * T17: disabled は任意。囲いの `<fieldset disabled>` があるところでは指定不要。
 */
export function NativePositionPresets({preset,disabled=false,current,onPick}:{preset:'caption'|'layer';disabled?:boolean;current:{x:number;y:number}|null;onPick(position:{x:number;y:number}):void}) {
  const pick=preset==='caption'?applyPositionPreset:applyLayerPreset;
  return <div className="native-position-presets" role="group" aria-label="位置をそろえる">
    {POSITION_PRESET_LABELS.map((labels,row)=>labels.map((label,column)=>{
      const position=pick(row as 0|1|2,column as 0|1|2);
      const active=!!current&&Math.abs(current.x-position.x)<1e-6&&Math.abs(current.y-position.y)<1e-6;
      return <button key={label} type="button" className="native-position-cell" aria-label={`${label}に配置`} title={label}
        aria-pressed={active} disabled={disabled} onClick={()=>onPick(position)}><span aria-hidden="true"/></button>;
    }))}
  </div>;
}
