type DurationDeps={create?:()=>HTMLVideoElement;url?:Pick<typeof URL,'createObjectURL'|'revokeObjectURL'>;timeoutMs?:number};
/** 長さの先読みで同時に使う video 要素の上限（50本を落としても要素を50個作らない）。 */
export const VIDEO_DURATION_READS=4;
/** デスクトップ版の長さの先読み（設計 §1）: 動画の情報だけを読む（全体は読まない）。読めなければ undefined（サーバの調査を待つ）。 */
export async function readVideoDuration(file:File,deps:DurationDeps={}):Promise<number|undefined>{
  const create=deps.create??(()=>document.createElement('video')),url=deps.url??URL,timeoutMs=deps.timeoutMs??4000;
  const element=create(),source=url.createObjectURL(file);
  try{
    return await new Promise<number|undefined>(resolve=>{
      const timer=setTimeout(()=>resolve(undefined),timeoutMs);
      element.onloadedmetadata=()=>{clearTimeout(timer);resolve(Number.isFinite(element.duration)&&element.duration>0?element.duration:undefined);};
      element.onerror=()=>{clearTimeout(timer);resolve(undefined);};
      element.preload='metadata';element.muted=true;element.src=source;
    });
  }finally{element.onloadedmetadata=null;element.onerror=null;element.removeAttribute('src');element.load();url.revokeObjectURL(source);}
}
/**
 * 複数の長さを、同時に VIDEO_DURATION_READS 本ずつ読む。鍵は files の添字（読めなかった添字は飛ばす）。
 * 読めた分から onRead で知らせる（全部を待たずに枠へ出すため）。signal が止まったら新しく読み始めない。
 */
export async function readVideoDurations(files:readonly File[],options:{onRead?(key:string,seconds:number):void;signal?:AbortSignal;deps?:DurationDeps}={}):Promise<Map<string,number>>{
  const lengths=new Map<string,number>();let next=0;
  const worker=async()=>{
    while(next<files.length&&!options.signal?.aborted){
      const index=next++,seconds=await readVideoDuration(files[index]!,options.deps).catch(()=>undefined);
      if(seconds!==undefined){lengths.set(String(index),seconds);options.onRead?.(String(index),seconds);}
    }
  };
  await Promise.all(Array.from({length:Math.min(VIDEO_DURATION_READS,files.length)},worker));
  return lengths;
}
