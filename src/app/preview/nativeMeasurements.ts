import type { LegacyMeasurementDisplaySnapshot, LegacyMeasurementItem } from '../../preview/native/legacyMeasurement';
import { quantize } from './measureBox';
import type { Rect } from './overlayGeometry';

/** Convert composition pixels through the actual iframe viewport, including its
 * letterbox offset and display scale, into the existing overlay's local pixels. */
export function nativeMeasurementRect(snapshot:LegacyMeasurementDisplaySnapshot,item:LegacyMeasurementItem,origin:{left:number;top:number}):Rect|null {
  const {viewport,resolution}=snapshot,r=item.rect;
  if(![viewport.width,viewport.height,resolution.width,resolution.height].every(n=>Number.isFinite(n)&&n>0)
    ||![viewport.left,viewport.top,origin.left,origin.top,r.x,r.y,r.w,r.h].every(Number.isFinite)||r.w<=0||r.h<=0)return null;
  const x=quantize(viewport.left-origin.left+r.x/resolution.width*viewport.width);
  const y=quantize(viewport.top-origin.top+r.y/resolution.height*viewport.height);
  const right=quantize(viewport.left-origin.left+(r.x+r.w)/resolution.width*viewport.width);
  const bottom=quantize(viewport.top-origin.top+(r.y+r.h)/resolution.height*viewport.height);
  return {x,y,w:right-x,h:bottom-y};
}
