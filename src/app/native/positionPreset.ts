import {POSITION_PRESETS} from '../preview/positionPresets';

/** 3×3 の表示名。`POSITION_PRESETS` と同じ並び（上段→下段・左→右）。 */
export const POSITION_PRESET_LABELS=[
  ['左上','中央上','右上'],
  ['左中央','中央','右中央'],
  ['左下','中央下','右下'],
] as const;

/** 3×3 の1マスの正規化座標。呼び出し側が書き換えても定数が汚れないよう複製して返す。 */
export function applyPositionPreset(row:0|1|2,column:0|1|2):{x:number;y:number} {
  const preset=POSITION_PRESETS[row]?.[column];
  if(!preset)throw new Error('整列プリセットの位置が不正です');
  return {...preset};
}
