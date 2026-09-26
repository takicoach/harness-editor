import {LAYER_POSITION_PRESETS} from '../preview/layerPresets';

/** 3×3 の1マスのレイヤー座標。呼び出し側が書き換えても定数が汚れないよう複製して返す。 */
export function applyLayerPreset(row:0|1|2,column:0|1|2):{x:number;y:number} {
  const preset=LAYER_POSITION_PRESETS[row]?.[column];
  if(!preset)throw new Error('レイヤーの基本配置が不正です');
  return {...preset};
}
