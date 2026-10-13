import type { CSSProperties } from 'react';
import type { PlannedVisual } from '../../core/sequence/scenePlan';
import type { VisualLook } from '../../core/sequence/model';
import { animStyleAt, DEFAULT_FADE } from '../../core/elementAnim';
import { colorGradeMatrixValues, isIdentityColorGrade } from '../../core/colorGrade';

export function lookFilterNeeded(look: VisualLook | undefined): boolean {
  return !!look && ((!!look.grade && !isIdentityColorGrade(look.grade)) || (!!look.edge && look.edge.width > 0));
}
/** 色調整 → ぼかし → 白フチ（不透明な画素の外側）を 1 つのフィルターで。計算は動画と同じ色行列。 */
function LookFilter({ id, look }: { id: string; look: VisualLook }) {
  const grade = look.grade && !isIdentityColorGrade(look.grade) ? look.grade : undefined, edge = look.edge && look.edge.width > 0 ? look.edge : undefined;
  const graded = grade ? 'graded' : 'SourceGraphic', soft = look.blur ? 'soft' : graded;
  return <svg width="0" height="0" aria-hidden="true" style={{ position: 'absolute' }}>
    <filter id={id} x="-100%" y="-100%" width="300%" height="300%" colorInterpolationFilters="sRGB">
      {grade && <feColorMatrix in="SourceGraphic" type="matrix" values={colorGradeMatrixValues(grade)} result="graded" />}
      {look.blur ? <feGaussianBlur in={graded} stdDeviation={look.blur} result="soft" /> : null}
      {edge && <>
        <feMorphology in="SourceAlpha" operator="dilate" radius={edge.width} result="grown" />
        <feFlood floodColor={edge.color} result="paint" />
        <feComposite in="paint" in2="grown" operator="in" result="outline" />
        <feMerge><feMergeNode in="outline" /><feMergeNode in={soft} /></feMerge>
      </>}
    </filter>
  </svg>;
}

/** Built-in image styles for native projects without an imported legacy component. */
export function NativeImage({visual,src}:{visual:PlannedVisual;src:string}) {
  const {clip,transform:t,effectFrame,effectDuration}=visual;
  if(clip.content.kind!=='image')return null;
  const type=clip.content.style??'plain',plain=type==='plain',photo=type==='photo';
  const fallback=plain?{kind:'none' as const,frames:0}:DEFAULT_FADE;
  const anim=animStyleAt(effectFrame,effectDuration,clip.visual?.enter??fallback,clip.visual?.exit??fallback);
  const fill:CSSProperties={position:'absolute',inset:0};
  // An identity filter prevents Chromium's tiny-image blur over video canvases.
  // Unlike translateZ, it keeps resized bitmap edges independent of frame history.
  const base:CSSProperties=plain||photo?{width:'100%',height:'100%',objectFit:plain?'contain':'cover',filter:plain?'opacity(1)':undefined,transform:photo?`scale(${1+.05*Math.max(0,Math.min(1,effectFrame/effectDuration))})`:undefined}
    :{maxWidth:'78%',maxHeight:'52%',objectFit:'contain',borderRadius:28,border:'3px solid #D4B97A',boxShadow:'0 12px 40px rgba(20,46,35,.35)',backgroundColor:'#ffffff'};
  // サムネで足した任意項目。無ければ従来の DOM のまま（基準画像で固定）。
  const look=clip.visual?.look,filterId=`native-look-${clip.id}`,svg=lookFilterNeeded(look);
  const lookFilter=look?[svg?`url(#${filterId})`:'',look.blur&&!svg?`blur(${look.blur}px)`:''].filter(Boolean).join(' '):'';
  const image:CSSProperties=look?{...base,filter:lookFilter||base.filter,...(look.flipX?{transform:[base.transform,'scaleX(-1)'].filter(Boolean).join(' ')}:{})}:base;
  const shadow=look?.shadow;
  return <div style={{...fill,transform:anim.transform,zIndex:0,...(shadow?{filter:`drop-shadow(${shadow.x}px ${shadow.y}px ${shadow.blur}px ${shadow.color})`}:{})}}>
    {look&&svg&&<LookFilter id={filterId} look={look}/>}
    {type==='overlay'&&<div style={{...fill,backgroundColor:'rgba(0,0,0,.7)',opacity:anim.opacity,zIndex:50}}/>}
    <div style={{position:'absolute',top:plain?`${(1+t.y-t.scale)*50}%`:0,left:plain?`${(1+t.x-t.scale)*50}%`:0,
      width:plain?`${t.scale*100}%`:'100%',height:plain?`${t.scale*100}%`:'100%',
      transform:plain?`rotate(${t.rotation}deg)`:`translate(${t.x*50}%, ${t.y*50}%) rotate(${t.rotation}deg) scale(${t.scale})`,
      transformOrigin:'50% 50%',opacity:anim.opacity*t.opacity,zIndex:50,display:photo||plain?'block':'flex',justifyContent:'center',alignItems:'flex-start',paddingTop:photo||plain?0:100,boxSizing:'border-box'}}>
      <img src={src} style={image} data-native-plain-image={plain?clip.id:undefined}/>
    </div>
  </div>;
}
