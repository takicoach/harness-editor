import type {PlannedVisual} from '../../core/sequence/scenePlan';

export interface LocalVisualBounds {x:number;y:number;width:number;height:number}

/** Invalid CSS translation either centers the layer or retains the previous frame.
 * Reject before painting; keep the saved coordinate editable in Inspector.
 */
export function assertRenderableGraphicPosition(position:{x:number;y:number},resolution:{width:number;height:number}):void {
  if(![position.x*50,position.y*50,position.x*(resolution.width/2),position.y*(resolution.height/2)].every(Number.isFinite))
    throw new Error('レイヤーの位置が大きすぎて表示できません。プロパティの位置を0などへ戻してください。');
}

/** Offscreen/degenerate DOM boxes cannot supply reliable editing geometry. */
export function measurableGraphicBox(box:LocalVisualBounds,viewport:LocalVisualBounds):boolean {
  return [box.x,box.y,box.width,box.height].every(Number.isFinite)&&box.width>0&&box.height>0
    &&box.x<viewport.x+viewport.width&&box.y<viewport.y+viewport.height
    &&box.x+box.width>viewport.x&&box.y+box.height>viewport.y;
}

/** The static telop layer may translate/scale around its bottom origin.
 * Use the computed matrix, after renderer clamping, rather than stored scale.
 * Translation and transform-origin are already included in the measured center.
 */
export function staticTextBorderSize(size:{width:number;height:number},matrix:Pick<DOMMatrixReadOnly,'is2D'|'a'|'b'|'c'|'d'>):{width:number;height:number}|undefined {
  if(!matrix.is2D||matrix.b!==0||matrix.c!==0||matrix.a!==matrix.d||matrix.a<=0)return undefined;
  const width=size.width*matrix.a,height=size.height*matrix.d;
  return [width,height].every(value=>Number.isFinite(value)&&value>0)?{width,height}:undefined;
}

/** Recover an axis-aligned content border box before the outer placement.
 * A rotated rectangle's DOM bounding box has the same center as that rectangle.
 * Its width/height do not: use measured CSS border-box dimensions instead.
 * measuredCenter is in composition pixels, without the preview's display scale.
 */
export function unplaceBorderBox(measuredCenter:{x:number;y:number},size:{width:number;height:number},
  resolution:{width:number;height:number},transform:PlannedVisual['transform']):LocalVisualBounds|undefined {
  // Empty text can have no layout rectangle. Omit its handles, not the frame.
  if(size.width===0||size.height===0)return undefined;
  const {x,y,scale,rotation,flipH,flipV}=transform;
  if(![measuredCenter.x,measuredCenter.y,size.width,size.height,resolution.width,resolution.height,x,y,scale,rotation].every(Number.isFinite)
    ||Math.min(size.width,size.height,resolution.width,resolution.height,scale)<=0)throw new Error('内容の表示領域を取得できません');
  const ox=resolution.width/2,oy=resolution.height/2,dx=measuredCenter.x-ox-x*ox,dy=measuredCenter.y-oy-y*oy;
  const angle=rotation*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
  return {x:ox+(c*dx+s*dy)/scale*(flipH?-1:1)-size.width/2,
    y:oy+(-s*dx+c*dy)/scale*(flipV?-1:1)-size.height/2,...size};
}

/** Unscaled contain dimensions, before placement rotation/scale. */
export function fitDecodedVideo(
  frame: Pick<VideoFrame, 'displayWidth' | 'displayHeight' | 'visibleRect'>,
  sampleAspectRatio: number,
  rotation: number,
  resolution: {width:number;height:number},
): {width:number;height:number} {
  // VideoFrame.displayWidth/Height may already include the bitstream SAR.
  // Use the actual cropped pixel region, then apply our inspected stream SAR
  // once. codedWidth/Height can include decoder padding and are not visible size.
  const visible=frame.visibleRect;
  if(!visible||visible.width<=0||visible.height<=0)throw new Error('映像の表示領域を取得できません');
  const sourceWidth=visible.width*sampleAspectRatio,sourceHeight=visible.height;
  const quarterTurn=Math.abs(rotation)%180===90;
  const fit=Math.min(resolution.width/(quarterTurn?sourceHeight:sourceWidth),resolution.height/(quarterTurn?sourceWidth:sourceHeight));
  return {width:sourceWidth*fit,height:sourceHeight*fit};
}

/** The complete decoded bitmap rectangle, including transparent margins.
 * layout is the actual unrotated CSS image box after placement scale. Browser
 * natural dimensions already reflect image orientation; do not rotate them again.
 */
export function fitDecodedImage(
  natural:{width:number;height:number},layout:{width:number;height:number},scale:number,
):{width:number;height:number} {
  if(![natural.width,natural.height,layout.width,layout.height,scale].every(value=>Number.isFinite(value)&&value>0))
    throw new Error('画像の表示領域を取得できません');
  const fit=Math.min(layout.width/natural.width,layout.height/natural.height)/scale;
  return {width:natural.width*fit,height:natural.height*fit};
}

/** Captured from decoded media and the actual renderer's placement dimensions. */
export interface RenderedVisualGeometry {
  clipId:string;
  source:{displayWidth:number;displayHeight:number;sampleAspectRatio:number;rotation:number};
  fittedSize:{width:number;height:number};
  /** Text/shape content bounds before the full-composition outer placement.
   * Unlike centered media, these may be offset from the transform origin.
   */
  localBounds?:LocalVisualBounds;
  transform:PlannedVisual['transform'];
  bounds:{x:number;y:number;width:number;height:number;rotation:number};
  transition:boolean;
  animated:boolean;
}
export type RenderedVideoGeometry=RenderedVisualGeometry;
export interface RenderedSceneGeometry {
  documentId:string;revision:number;frame:number;
  resolution:{width:number;height:number};
  videos:RenderedVideoGeometry[];
  /** Only built-in plain images have a supported, measured placement contract. */
  images?:RenderedVisualGeometry[];
  /** Built-in free text and rectangle/ellipse shapes only. */
  elements?:RenderedVisualGeometry[];
}
