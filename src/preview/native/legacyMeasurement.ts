import type { PlannedVisual } from '../../core/sequence/scenePlan';
import { measureItemRect, quantize } from '../../app/preview/measureBox';
import type { RenderedSceneGeometry } from './renderGeometry';

export type LegacyMeasuredKind = 'telop' | 'image' | 'videoInsert';
export interface LegacyMeasurementItem { kind: LegacyMeasuredKind; id: number; rect: {x:number;y:number;w:number;h:number} }
export interface LegacyMeasurementRequest {
  documentId: string; revision: number; frame: number;
  /** null reads only the owned viewport; it never scans layer DOM. */
  kind: LegacyMeasuredKind|null; id?: number;
}
export interface LegacyMeasurementSnapshot {
  documentId: string; revision: number; frame: number;
  resolution: {width:number;height:number}; items: LegacyMeasurementItem[];
}
export interface LegacyMeasurementDisplaySnapshot extends LegacyMeasurementSnapshot {
  /** Iframe viewport in the parent's client coordinates, sampled with the boxes. */
  viewport: {left:number;top:number;width:number;height:number};
}
export type LegacyMeasurementReader = (kind:LegacyMeasuredKind|null,id?:number)=>LegacyMeasurementDisplaySnapshot|null;

function identity(visual: PlannedVisual): {kind:LegacyMeasuredKind;id:number}|null {
  const content = visual.clip.content;
  if ((content.kind === 'telop' || content.kind === 'image') && content.legacyId !== undefined)
    return {kind:content.kind,id:content.legacyId};
  if (content.kind === 'video' && visual.clip.id.startsWith('legacy-insert-')) {
    const suffix = visual.clip.id.slice('legacy-insert-'.length), id = Number(suffix);
    if (Number.isFinite(id) && String(id) === suffix) return {kind:'videoInsert',id};
  }
  return null;
}

/** Legacy overlay bounds remain an on-demand read, separate from native edit
 * capabilities. A custom/animated telop can have a measured selection box without
 * promising the native manipulation engine supports its internal transforms. */
export function measureLegacyVisuals(root: ShadowRoot, mount: HTMLElement, geometry: RenderedSceneGeometry,
  visuals: readonly PlannedVisual[], request: LegacyMeasurementRequest): LegacyMeasurementSnapshot|null {
  if (geometry.documentId !== request.documentId || geometry.revision !== request.revision || geometry.frame !== request.frame) return null;
  const frame = mount.getBoundingClientRect(), {width,height} = geometry.resolution;
  if (![frame.width,frame.height,width,height].every(n => Number.isFinite(n) && n > 0)) return null;
  if(request.kind===null)return {documentId:geometry.documentId,revision:geometry.revision,frame:geometry.frame,resolution:{width,height},items:[]};
  const read = (el: Element) => {
    const rect = el.getBoundingClientRect();
    return {left:(rect.left-frame.left)*width/frame.width,top:(rect.top-frame.top)*height/frame.height,
      width:rect.width*width/frame.width,height:rect.height*height/frame.height};
  };
  const items: LegacyMeasurementItem[] = [];
  for (const container of root.querySelectorAll<HTMLElement>('[data-native-clip]')) {
    const visual = visuals.find(value => value.clip.id === container.dataset.nativeClip);
    if (!visual) continue;
    const item = identity(visual);
    if (!item || item.kind !== request.kind || (request.id !== undefined && request.id !== item.id)) continue;
    let rect: LegacyMeasurementItem['rect']|null;
    if (item.kind === 'videoInsert') {
      const video = geometry.videos.find(value => value.clipId === visual.clip.id), canvas = container.querySelector('canvas');
      if (!video || !canvas) continue;
      // The canvas covers the composition, but its visible video need not. Start
      // with the decoded fitted bounds, then apply the canvas entry/exit matrix.
      const style = canvas.ownerDocument.defaultView!.getComputedStyle(canvas);
      const matrix = new DOMMatrixReadOnly(style.transform === 'none' || !style.transform ? undefined : style.transform);
      if (!matrix.is2D) continue;
      const [ox,oy] = style.transformOrigin.split(' ').map(Number.parseFloat);
      if (!Number.isFinite(ox) || !Number.isFinite(oy)) continue;
      const b = video.bounds, angle = b.rotation*Math.PI/180, c = Math.cos(angle), s = Math.sin(angle);
      const cx = b.x+b.width/2, cy = b.y+b.height/2;
      const points = [[-1,-1],[1,-1],[-1,1],[1,1]].map(([sx,sy]) => {
        const dx=sx!*b.width/2,dy=sy!*b.height/2,x=cx+c*dx-s*dy-ox!,y=cy+s*dx+c*dy-oy!;
        return {x:matrix.a*x+matrix.c*y+matrix.e+ox!,y:matrix.b*x+matrix.d*y+matrix.f+oy!};
      });
      const x=quantize(Math.min(...points.map(p=>p.x))),y=quantize(Math.min(...points.map(p=>p.y)));
      rect={x,y,w:quantize(Math.max(...points.map(p=>p.x)))-x,h:quantize(Math.max(...points.map(p=>p.y)))-y};
    } else rect = measureItemRect(container,{frame:{left:0,top:0,width,height},origin:{left:0,top:0,width,height},read});
    if (!rect || !Object.values(rect).every(Number.isFinite) || rect.w <= 0 || rect.h <= 0) continue;
    const existing = items.find(value => value.kind === item.kind && value.id === item.id);
    if (existing) {
      const x=Math.min(existing.rect.x,rect.x),y=Math.min(existing.rect.y,rect.y);
      existing.rect={x,y,w:Math.max(existing.rect.x+existing.rect.w,rect.x+rect.w)-x,h:Math.max(existing.rect.y+existing.rect.h,rect.y+rect.h)-y};
    } else items.push({...item,rect});
  }
  return {documentId:geometry.documentId,revision:geometry.revision,frame:geometry.frame,resolution:{width,height},items};
}
