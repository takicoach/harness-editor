import type { CSSProperties } from 'react';
import type { PlannedVisual } from '../../core/sequence/scenePlan';
import { animStyleAt, DEFAULT_FADE } from '../../core/elementAnim';

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
  const image:CSSProperties=plain||photo?{width:'100%',height:'100%',objectFit:plain?'contain':'cover',filter:plain?'opacity(1)':undefined,transform:photo?`scale(${1+.05*Math.max(0,Math.min(1,effectFrame/effectDuration))})`:undefined}
    :{maxWidth:'78%',maxHeight:'52%',objectFit:'contain',borderRadius:28,border:'3px solid #D4B97A',boxShadow:'0 12px 40px rgba(20,46,35,.35)',backgroundColor:'#ffffff'};
  return <div style={{...fill,transform:anim.transform,zIndex:0}}>
    {type==='overlay'&&<div style={{...fill,backgroundColor:'rgba(0,0,0,.7)',opacity:anim.opacity,zIndex:50}}/>}
    <div style={{position:'absolute',top:plain?`${(1+t.y-t.scale)*50}%`:0,left:plain?`${(1+t.x-t.scale)*50}%`:0,
      width:plain?`${t.scale*100}%`:'100%',height:plain?`${t.scale*100}%`:'100%',
      transform:plain?`rotate(${t.rotation}deg)`:`translate(${t.x*50}%, ${t.y*50}%) rotate(${t.rotation}deg) scale(${t.scale})`,
      transformOrigin:'50% 50%',opacity:anim.opacity*t.opacity,zIndex:50,display:photo||plain?'block':'flex',justifyContent:'center',alignItems:'flex-start',paddingTop:photo||plain?0:100,boxSizing:'border-box'}}>
      <img src={src} style={image} data-native-plain-image={plain?clip.id:undefined}/>
    </div>
  </div>;
}
