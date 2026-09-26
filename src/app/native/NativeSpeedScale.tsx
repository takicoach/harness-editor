import {SPEED_PRESETS,formatRate,rateToSlider,sliderToRate} from './speedScale';

/**
 * ワンクリックの倍率ボタン＋対数スライダー。数値欄は呼び出し側（Rational で厳密に持つ）。
 * legacy の `inspector/MainVideoSettingsTab.tsx:57-75` と同じ操作感を native へ移したもの。
 * 値の正本は常に呼び出し側の Rational。ここは「押した倍率を返す」だけで状態を持たない。
 */
export function NativeSpeedScale({rate,disabled=false,scope,onPick}:{rate:number;disabled?:boolean;scope:'全体'|'このクリップ';onPick(rate:number):void}) {
  return <div className="native-speed-scale">
    <input className="native-speed-slider" type="range" aria-label={`${scope}の速度スライダー`} min={0} max={100} step={1}
      value={rateToSlider(rate)} disabled={disabled} onChange={event=>onPick(sliderToRate(Number(event.target.value)))}/>
    <div className="native-speed-presets" role="group" aria-label={`${scope}のよく使う倍率`}>
      {SPEED_PRESETS.map(preset=><button key={preset} type="button" className="native-toggle"
        aria-pressed={Math.abs(rate-preset)<1e-9} disabled={disabled} onClick={()=>onPick(preset)}>{formatRate(preset)}</button>)}
    </div>
  </div>;
}
