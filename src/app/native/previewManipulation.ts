import type {PlannedVisual} from '../../core/sequence/scenePlan';
import type {LocalVisualBounds} from '../../preview/native/renderGeometry';

export interface PreviewPoint {x:number;y:number}
export interface PreviewRect extends PreviewPoint {width:number;height:number}
export type PreviewCorner='nw'|'ne'|'se'|'sw';
export type PreviewPlacement=Pick<PlannedVisual['transform'],'x'|'y'|'scale'|'rotation'|'flipH'|'flipV'>;
export interface PreviewVideoGeometry {
  resolution:{width:number;height:number};
  /** Client rectangle of the composition itself, excluding surrounding letterbox/UI. */
  viewport:PreviewRect;
  /** The decoded frame dimensions and stream metadata used by SceneRenderer. */
  source:{displayWidth:number;displayHeight:number;sampleAspectRatio?:number;rotation?:number};
  /** Prefer the actual renderer's contain result when manipulating a rendered frame. */
  fittedSize?:{width:number;height:number};
  /** DOM/SVG content before placement, whose origin remains composition center.
   * Unlike media UV flips, these bounds move under the outer CSS flip.
   */
  localBounds?:LocalVisualBounds;
}

const signs:Record<PreviewCorner,PreviewPoint>={nw:{x:-1,y:-1},ne:{x:1,y:-1},se:{x:1,y:1},sw:{x:-1,y:1}};
const opposite:Record<PreviewCorner,PreviewCorner>={nw:'se',ne:'sw',se:'nw',sw:'ne'};
const finite=(...values:number[])=>{if(!values.every(Number.isFinite))throw new RangeError('Preview geometry must be finite');};
const positive=(...values:number[])=>{finite(...values);if(values.some(value=>value<=0))throw new RangeError('Preview dimensions and scale must be positive');};
function checkViewport(viewport:PreviewRect){finite(viewport.x,viewport.y);positive(viewport.width,viewport.height);}
function checkPlacement(placement:PreviewPlacement){finite(placement.x,placement.y,placement.rotation);positive(placement.scale);}

/**
 * Matches SceneRenderer's contain fit and NativeCompositor's center rotation.
 * Corners name the unrotated bounds, not texture pixels: flipH/V only change UVs.
 * Does not include enter/exit animations, transitions, or any parent transform.
 */
export function previewVideoCorners(geometry:PreviewVideoGeometry,placement:PreviewPlacement):Record<PreviewCorner,PreviewPoint>{
  const {resolution,viewport,source}=geometry;
  checkViewport(viewport);checkPlacement(placement);
  if(geometry.localBounds){
    const box=geometry.localBounds;positive(resolution.width,resolution.height,box.width,box.height);finite(box.x,box.y);
    const angle=placement.rotation*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle),ox=resolution.width/2,oy=resolution.height/2;
    const corners={} as Record<PreviewCorner,PreviewPoint>;
    for(const corner of Object.keys(signs) as PreviewCorner[]){
      const x=(box.x+(signs[corner].x+1)*box.width/2-ox)*placement.scale*(placement.flipH?-1:1);
      const y=(box.y+(signs[corner].y+1)*box.height/2-oy)*placement.scale*(placement.flipV?-1:1);
      const point={x:viewport.x+(ox+placement.x*ox+c*x-s*y)*viewport.width/resolution.width,
        y:viewport.y+(oy+placement.y*oy+s*x+c*y)*viewport.height/resolution.height};
      finite(point.x,point.y);corners[corner]=point;
    }
    return corners;
  }
  const sar=source.sampleAspectRatio??1,sourceAngle=-(source.rotation??0);
  positive(resolution.width,resolution.height,source.displayWidth,source.displayHeight,sar);finite(sourceAngle);
  const sourceWidth=source.displayWidth*sar,sourceHeight=source.displayHeight;
  const quarterTurn=Math.abs(sourceAngle)%180===90;
  const fit=Math.min(resolution.width/(quarterTurn?sourceHeight:sourceWidth),resolution.height/(quarterTurn?sourceWidth:sourceHeight));
  const fitted=geometry.fittedSize??{width:sourceWidth*fit,height:sourceHeight*fit};positive(fitted.width,fitted.height);
  const width=fitted.width*placement.scale,height=fitted.height*placement.scale;
  const angle=(sourceAngle+placement.rotation)*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
  const center={x:(1+placement.x)*resolution.width/2,y:(1+placement.y)*resolution.height/2};
  const corners={} as Record<PreviewCorner,PreviewPoint>;
  for(const corner of Object.keys(signs) as PreviewCorner[]){
    const local={x:signs[corner].x*width/2,y:signs[corner].y*height/2};
    const point={x:viewport.x+(center.x+c*local.x-s*local.y)*viewport.width/resolution.width,
      y:viewport.y+(center.y+s*local.x+c*local.y)*viewport.height/resolution.height};
    finite(point.x,point.y);corners[corner]=point;
  }
  return corners;
}

/** Screen displacement maps to the native outer placement, independently of scale/rotation. */
export function movePreviewPlacement<T extends PreviewPlacement>(placement:T,viewport:PreviewRect,delta:PreviewPoint):T{
  checkViewport(viewport);checkPlacement(placement);finite(delta.x,delta.y);
  if(delta.x===0&&delta.y===0)return placement;
  const x=placement.x+2*delta.x/viewport.width,y=placement.y+2*delta.y/viewport.height;finite(x,y);
  return {...placement,x,y};
}

/**
 * Uniform scale with the opposite corner fixed. Only motion projected onto the
 * starting client-space diagonal follows the pointer; perpendicular motion is
 * ignored. Pointer displacement preserves an off-center handle grab.
 *
 * Returns null at/beyond zero scale; crossing the anchor never introduces a flip.
 * No render/UI limits are applied. A caller must constrain the scale along this
 * same diagonal or reject the candidate, rather than clamp x/y/scale afterwards
 * (which would break the fixed-corner contract). Pass evaluated render placement.
 */
export function resizePreviewVideo<T extends PreviewPlacement>(geometry:PreviewVideoGeometry,placement:T,corner:PreviewCorner,start:PreviewPoint,current:PreviewPoint):T|null{
  finite(start.x,start.y,current.x,current.y);
  const corners=previewVideoCorners(geometry,placement),grabbed=corners[corner],anchor=corners[opposite[corner]];
  const dx=current.x-start.x,dy=current.y-start.y;
  if(dx===0&&dy===0)return placement;
  const diagonal={x:grabbed.x-anchor.x,y:grabbed.y-anchor.y},length=Math.hypot(diagonal.x,diagonal.y);
  positive(length);
  const unit={x:diagonal.x/length,y:diagonal.y/length};
  // Project the remaining diagonal, rather than subtract two almost equal
  // lengths: a pointer exactly at the anchor must yield exactly zero scale.
  const ratio=((diagonal.x+dx)/length)*unit.x+((diagonal.y+dy)/length)*unit.y,scale=placement.scale*ratio;
  finite(ratio,scale);
  if(scale<=0)return null;
  if(ratio===1)return placement;
  if(geometry.localBounds){
    // The content's center can be far from the CSS transform origin. Preserve
    // the actual opposite corner, rather than moving half the content diagonal.
    const origin={x:geometry.viewport.x+(1+placement.x)*geometry.viewport.width/2,
      y:geometry.viewport.y+(1+placement.y)*geometry.viewport.height/2};
    const x=placement.x+2*(1-ratio)*(anchor.x-origin.x)/geometry.viewport.width;
    const y=placement.y+2*(1-ratio)*(anchor.y-origin.y)/geometry.viewport.height;
    finite(x,y);return {...placement,x,y,scale};
  }
  const x=placement.x+(ratio-1)*diagonal.x/geometry.viewport.width,y=placement.y+(ratio-1)*diagonal.y/geometry.viewport.height;
  finite(x,y);
  return {...placement,x,y,scale};
}
