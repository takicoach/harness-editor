import {isSimulatedCrash,type CopyIo,type SpaceInfo} from './io';
import {ceilGigabytes,floorGigabytes} from '../../../shared/mediaCopy';

/** GB は 1024³ バイト（exportSpace.ts と同じ数え方）。 */
export const GiB=1024**3;
/** 安全余裕 = max(20GB, そのボリュームの容量の 10%)（設計 §4）。10% は切り上げ（安全側）。内蔵の空きが既に容量の 10% 未満なら、この式で自動的に選べない。 */
export const COPY_MARGIN_MIN_BYTES=20*GiB;
export const safetyMargin=(capacity:number)=>Math.max(COPY_MARGIN_MIN_BYTES,Math.ceil(capacity/10));
export const formatGiB=(bytes:number)=>(bytes/GiB).toFixed(1);
// 理由の文の数は 0.1GB 単位で、足りない側（空き・コピー後）は切り捨て、余裕は切り上げて見せる（1TB の外付けで「93.1 GB になり、余裕（93.1 GB）を下回ります」と同じ値に見せない）。
// 丸めは画面のコピー先の選択と同じ関数（floorGigabytes・ceilGigabytes）。
const validBytes=(bytes:number)=>Number.isFinite(bytes)&&bytes>=0;
export interface SpaceMeasure {free:number;capacity:number}
/** 空きや容量が確かめられない・安全余裕を割る見込み（作業全体を止める）。元の errno は cause に残す。 */
export class SpaceStopError extends Error{readonly stop=true as const;constructor(message:string,options?:{cause?:unknown}){super(message,options);this.name='SpaceStopError';}}
/** 空き = bavail × bsize、容量 = blocks × bsize（df と一致することを実機で確認済み）。測れない・値が不自然なら SpaceStopError。試験の強制終了はそのまま通す。 */
export async function measureSpace(io:CopyIo,path:string):Promise<SpaceMeasure>{
  let info:SpaceInfo;
  try{info=await io.statfs(path);}catch(error){if(isSimulatedCrash(error))throw error;throw new SpaceStopError(`空き容量を測れません（${(error as NodeJS.ErrnoException).code??'不明'}）`,{cause:error});}
  const free=info.bavail*info.bsize,capacity=info.blocks*info.bsize;
  if(![info.bavail,info.bsize,info.blocks,free,capacity].every(Number.isSafeInteger)||info.bavail<0||info.bsize<=0||capacity<=0||free>capacity)throw new SpaceStopError('空き容量を測れません（値が不正です）');
  return {free,capacity};
}
export interface SpaceEvaluation extends SpaceMeasure {reserved:number;after:number;margin:number;selectable:boolean;reason?:string}
/** コピー後の空き（空き − アプリ内の他のコピーの予約 − このコピーの量）が安全余裕以上なら選べる。ちょうど余裕と同じは選べる（「割る」は下回ること）。予約・コピーの量が 0 以上の有限の数でなければ選べない（監視と同じ）。 */
export function evaluateSpace(measure:SpaceMeasure,reserved:number,copyBytes:number):SpaceEvaluation{
  const margin=safetyMargin(measure.capacity),after=measure.free-reserved-copyBytes,valid=validBytes(reserved)&&validBytes(copyBytes),selectable=valid&&after>=margin;
  if(selectable)return {...measure,reserved,after,margin,selectable};
  const limit=`安全のための余裕（${ceilGigabytes(margin)} GB＝20GB か容量の10%の大きい方）`,others=reserved>0?`（実行中・待機中の他のコピーの分 ${formatGiB(reserved)} GB を差し引いた値）`:'';
  const reason=!valid||!Number.isFinite(after)||!Number.isFinite(margin)?'空き容量を計算できないため選べません'
    :measure.free-reserved<margin?`空きが ${floorGigabytes(measure.free-reserved)} GB${others}で、すでに${limit}を下回っています`
    :`コピー後の空きが ${floorGigabytes(after)} GB${others}になり、${limit}を下回ります`;
  return {...measure,reserved,after,margin,selectable,reason};
}
export interface Reservation {readonly unit:string;update(bytes:number):void;release():void}
const reservedBytes=(bytes:number)=>{if(!Number.isFinite(bytes))throw new RangeError(`予約の量が正しくありません: ${bytes}`);return Math.max(0,bytes);};
/** アプリ内のコピー作業が使う量の予約（設計 §4）。容量を共有する単位（VolumeIdentity.spaceUnit）ごとに合計する。解放した予約の update は何もしない。 */
export class SpaceReservations{
  private units=new Map<string,Map<Reservation,number>>();
  reserve(unit:string,bytes:number):Reservation{
    const amount=reservedBytes(bytes),entries=this.units.get(unit)??new Map<Reservation,number>();this.units.set(unit,entries);
    const reservation:Reservation={unit,update:next=>{const value=reservedBytes(next);if(entries.has(reservation))entries.set(reservation,value);},
      release:()=>{entries.delete(reservation);if(!entries.size&&this.units.get(unit)===entries)this.units.delete(unit);}};
    entries.set(reservation,amount);return reservation;
  }
  reservedIn(unit:string,except?:Reservation):number{let sum=0;for(const [reservation,bytes] of this.units.get(unit)??[])if(reservation!==except)sum+=bytes;return sum;}
}
export const spaceReservations=new SpaceReservations();
export const MONITOR_BYTES=GiB,MONITOR_MS=5000;
/**
 * コピー中の監視（設計 §4）: 1GB ごとと 5 秒ごとの早い方で空きを測り、「残りのコピー量を書いた後の空き」（空き − 同じ単位の他の予約 − 残り）が安全余裕を割る見込みなら止める。
 * 測れない時・残りの量が数でない時も止める。自分の予約は書くたびに残りの量へ減らす。ENOSPC・書き込みの失敗で止めるのは呼び手（コピーの作業）。
 * 監視は頻度であり、他のアプリの書き込みに対する保証ではない。
 */
export class SpaceMonitor{
  private since=0;private lastAt:number;
  constructor(private io:CopyIo,private path:string,private reservation:Reservation,private reservations:SpaceReservations,readonly margin:number){this.lastAt=io.now();}
  async wrote(bytes:number,remaining:number):Promise<void>{
    if(!validBytes(bytes)||!validBytes(remaining))throw new SpaceStopError('書いた量・残りのコピー量を確かめられないため、コピーを止めました');
    this.since+=bytes;this.reservation.update(remaining);
    if(this.since>=MONITOR_BYTES||this.io.now()-this.lastAt>=MONITOR_MS)await this.check(remaining);
  }
  async check(remaining:number):Promise<void>{
    if(!validBytes(remaining))throw new SpaceStopError('残りのコピー量を確かめられないため、コピーを止めました');
    this.since=0;this.lastAt=this.io.now();this.reservation.update(remaining);let measure:SpaceMeasure;
    try{measure=await measureSpace(this.io,this.path);}catch(error){if(isSimulatedCrash(error))throw error;throw new SpaceStopError('コピー先の空き容量を測れないため、コピーを止めました',{cause:error});}
    const after=measure.free-this.reservations.reservedIn(this.reservation.unit,this.reservation)-remaining;
    // 数でない時（余裕・予約が壊れている）も止める側に倒す
    if(!(after>=this.margin))throw new SpaceStopError(`このまま書くとコピー先の空きが安全のための余裕（${ceilGigabytes(this.margin)} GB）を下回る見込みのため、コピーを止めました`);
  }
}
