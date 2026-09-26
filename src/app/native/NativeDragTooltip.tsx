/**
 * ドラッグ中に掴んだ位置の上へ出す小さな札。時刻と移動量を出す。
 * legacy の `src/app/timeline/DragTooltip.tsx` を native の座標系（px 直指定）へ移植したもの。
 * legacy は `frameToXMapped` と表示マップを持つが、native は呼び出し側が px を算出済みで渡す。
 */
export function dragTooltipText(frame:number,originFrame:number,fps:number):{clock:string;delta:string} {
  const deltaFrames=Math.round(frame-originFrame);
  const sign=deltaFrames>0?'+':deltaFrames<0?'−':'';
  const absFrames=Math.abs(deltaFrames);
  const seconds=fps>0?frame/fps:0,absSeconds=fps>0?absFrames/fps:0;
  const clock=`${Math.floor(seconds/60)}:${(seconds%60).toFixed(2).padStart(5,'0')}`;
  return {clock,delta:`${sign}${absFrames}f（${deltaFrames===0||fps<=0?'':sign}${absSeconds.toFixed(2)}秒）`};
}

export function NativeDragTooltip({frame,originFrame,fps,left,top}:{frame:number;originFrame:number;fps:number;left:number;top:number}) {
  const {clock,delta}=dragTooltipText(frame,originFrame,fps);
  return <div className="native-drag-tooltip" aria-hidden="true" style={{left,top}}>
    <span>{clock}</span><span className="native-drag-tooltip-delta">{delta}</span>
  </div>;
}
