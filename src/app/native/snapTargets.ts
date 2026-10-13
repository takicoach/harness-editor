import type {SequenceDocument} from '../../core/sequence/model';
import {buildSnapIndex,type SnapTarget} from './snapIndex';

/** 文書オブジェクト（中身を変えないかたまり）ごとに1回だけ作る。外部編集・AI 編集・再読込は別のオブジェクトなので古い索引は使われない（設計 §2-5）。WeakMap なので捨てた文書の索引は一緒に消える。 */
const built=new WeakMap<SequenceDocument,readonly SnapTarget[]>();
/**
 * playhead は null で渡す — 文書由来の索引に「再生位置」を焼き込むと、frame 0 付近で KIND_PRIORITY（playhead > zero）
 * により常に「再生位置」が勝って「先頭」が出せなくなる。実際の再生ヘッドはドラッグ中の吸着で別に足す。
 */
export function snapTargetsFor(document:SequenceDocument):readonly SnapTarget[]{
  let targets=built.get(document);if(!targets){targets=buildSnapIndex(document,null,[]);built.set(document,targets);}return targets;
}
/** 文書が変わった後の空き時間に作る。吸い付く操作が先に始まったら snapTargetsFor がその場で作り、ここは作り直さない。 */
export function scheduleSnapTargets(document:SequenceDocument):()=>void{
  if(built.has(document))return()=>undefined;
  if(typeof requestIdleCallback==='function'){const handle=requestIdleCallback(()=>{snapTargetsFor(document);},{timeout:1000});return()=>cancelIdleCallback(handle);}
  const handle=setTimeout(()=>{snapTargetsFor(document);},0);return()=>clearTimeout(handle);
}
