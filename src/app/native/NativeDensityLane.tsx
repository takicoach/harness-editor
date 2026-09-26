import type {SequenceClip} from '../../core/sequence/model';

/** 密度帯（F10）: トラックの全クリップを 1 本の SVG に目盛として描く。件数は帯の右中央。表示専用で、拡大するとクリップに戻る。 */
export function NativeDensityLane({clips,pixels,offset,height}:{clips:readonly SequenceClip[];pixels:number;offset:number;height:number}){
  const end=clips.reduce((max,c)=>Math.max(max,c.startFrame+c.durationFrames),0);
  const width=Math.max(1,Math.ceil(end*pixels));
  const barH=Math.max(6,Math.min(10,Math.round(height*.28)));
  return <div className="native-density-lane" role="img" aria-label={`${clips.length} 件の字幕（拡大するとクリップになります）`}
    style={{left:offset,width,height}}>
    <svg width={width} height={barH} viewBox={`0 0 ${width} ${barH}`} preserveAspectRatio="none" aria-hidden="true">
      {clips.map(c=><rect key={c.id} x={c.startFrame*pixels} y={0} width={Math.max(1,c.durationFrames*pixels)} height={barH} rx={1}/>)}
    </svg>
    <span className="native-density-count">{clips.length} 件</span>
  </div>;
}
