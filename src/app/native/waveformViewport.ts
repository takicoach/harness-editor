export interface WaveformViewport { startFrame:number; frameCount:number; left:number; width:number; bins:number }

/** The sticky track labels cover the first 132px of the scroll viewport. */
export function waveformViewport(start:number,duration:number,pixels:number,scrollLeft:number,viewportWidth:number):WaveformViewport|null {
  if(![start,duration,pixels,scrollLeft,viewportWidth].every(Number.isFinite)||duration<=0||pixels<=0||viewportWidth<=132)return null;
  const from=Math.max(0,Math.floor((scrollLeft-start*pixels)/pixels));
  const to=Math.min(duration,Math.ceil((scrollLeft+viewportWidth-132-start*pixels)/pixels));
  if(to<=from)return null;
  const width=(to-from)*pixels;
  return {startFrame:from,frameCount:to-from,left:from*pixels,width,bins:Math.max(1,Math.min(2400,Math.ceil(width)))};
}
