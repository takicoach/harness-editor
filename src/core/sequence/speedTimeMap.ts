import type {Rational} from './time';
import {SequenceError} from './errors';

/** A descriptor is a single main occurrence, in editing order. No model/UI state is read here. */
export interface SpeedMapDescriptor {
  readonly ownerId:string;
  readonly span:Rational;
  readonly rate:Rational;
  readonly mode:'absolute'|'cumulative';
  /** Completed-timeline frames, played at 1x. A positive gap starts a new run. */
  readonly gapBefore:number;
  /** Absolute run's saved basis coordinate before its first occurrence. Preserves rounding after a cut opens a gap. */
  readonly runBasisOffset?:Rational;
  /** On the incoming occurrence: requested PRE-speed frames of the preceding overlap. */
  readonly overlapBefore?:Rational;
}
export type SpeedMapPart='clip'|'gap-before';
export interface SpeedMapPoint {readonly ownerId:string;readonly kind:SpeedMapPart;readonly offset:Rational}
export interface SpeedMapEntry {
  readonly ownerId:string;readonly startFrame:number;readonly endFrame:number;
  readonly gapStartFrame:number;readonly gapEndFrame:number;readonly overlapBeforeFrames:number;
}
export interface SpeedTimeMap {
  readonly entries:readonly SpeedMapEntry[];
  readonly originFrame:number;readonly endFrame:number;readonly durationFrames:number;
  point(point:SpeedMapPoint):number;
  /** Closed interval. Exact start/end retain the owner's saved 0/span rather than a rounded inverse. */
  inverse(ownerId:string,frame:number,kind?:SpeedMapPart):Rational;
}

type Q={n:bigint;d:bigint};
const LIMIT=BigInt(Number.MAX_SAFE_INTEGER),ZERO:Q={n:0n,d:1n};
const invalid=(message:string,ids:string[]=[]):never=>{throw new SequenceError('INVALID_RANGE',message,ids);};
function gcd(a:bigint,b:bigint):bigint {a=a<0n?-a:a;while(b){[a,b]=[b,a%b];}return a;}
function q(n:bigint,d=1n):Q {const g=gcd(n,d);return {n:n/g,d:d/g};}
function read(value:Rational,ownerId?:string):Q {
  if(!value||!Number.isSafeInteger(value.num)||!Number.isSafeInteger(value.den)||value.den<=0)
    throw new SequenceError('INVALID_TIME','速度の時刻には安全な整数の分子と正の分母が必要です',ownerId?[ownerId]:[]);
  return q(BigInt(value.num),BigInt(value.den));
}
function add(a:Q,b:Q):Q{return q(a.n*b.d+b.n*a.d,a.d*b.d);}
function sub(a:Q,b:Q):Q{return q(a.n*b.d-b.n*a.d,a.d*b.d);}
function mul(a:Q,b:Q):Q{return q(a.n*b.n,a.d*b.d);}
function div(a:Q,b:Q):Q{return q(a.n*b.d,a.d*b.n);}
function compare(a:Q,b:Q):number{const delta=a.n*b.d-b.n*a.d;return delta<0n?-1:delta>0n?1:0;}
function floor(n:bigint,d:bigint):bigint{return n>=0n?n/d:-((-n+d-1n)/d);}
/** Math.round tie direction, including negative halves; no IEEE754 division occurs. */
function round(value:Q):bigint{return floor(2n*value.n+value.d,2n*value.d);}
function safe(value:bigint,ids:string[]=[]):number {
  if(value>LIMIT||value< -LIMIT)throw new SequenceError('TIME_OVERFLOW','速度変更後の時刻を安全な整数で保存できません',ids);
  return Number(value);
}
function stored(value:Q,ownerId:string):Rational {
  return {num:safe(value.n,[ownerId]),den:safe(value.d,[ownerId])};
}
function integer(value:number,label:string):bigint {
  if(!Number.isSafeInteger(value))invalid(`${label}には安全な整数が必要です`);
  return BigInt(value);
}
export function roundSpeedTime(value:Rational):number{return safe(round(read(value)));}

interface Internal {
  id:string;span:Q;rate:Q;mode:'absolute'|'cumulative';gap:bigint;requested?:Q;runBasisOffset?:Q;
  basisStart:Q;runOrigin:bigint;prefix:bigint;shift:bigint;
  start:bigint;end:bigint;gapStart:bigint;gapEnd:bigint;overlap:bigint;
}

/** Builds and validates a complete immutable candidate before publishing any map.
 * No minimum-frame rescue, collision reinterpretation, or mixed-mode fallback is performed.
 * Rates only need to be positive; the caller owns the editing UI's 0.1–16 policy.
 */
export function buildSpeedTimeMap(descriptors:readonly SpeedMapDescriptor[],options:{originFrame?:number}={}):SpeedTimeMap {
  if(!Array.isArray(descriptors))invalid('速度区間の配列が必要です');
  const origin=integer(options.originFrame??0,'開始時刻'),seen=new Set<string>();
  const cells:Internal[]=Array.from(descriptors,input=>{
    if(!input||typeof input.ownerId!=='string'||!input.ownerId.trim()||seen.has(input.ownerId))invalid('速度区間の所有IDが空または重複しています');
    seen.add(input.ownerId);
    if(input.mode!=='absolute'&&input.mode!=='cumulative')invalid('速度区間の丸め方式が不正です',[input.ownerId]);
    const span=read(input.span,input.ownerId),rate=read(input.rate,input.ownerId),gap=integer(input.gapBefore,'空白の長さ');
    if(span.n<=0n||rate.n<=0n||gap<0n)invalid('区間長と速度は正、空白は0以上で指定してください',[input.ownerId]);
    const requested=input.overlapBefore===undefined?undefined:read(input.overlapBefore,input.ownerId);
    const runBasisOffset=input.runBasisOffset===undefined?undefined:read(input.runBasisOffset,input.ownerId);
    if(requested&&requested.n<=0n)invalid('重なり要求は正の長さで指定してください',[input.ownerId]);
    return {id:input.ownerId,span,rate,mode:input.mode,gap,requested,runBasisOffset,basisStart:ZERO,runOrigin:origin,prefix:origin,shift:0n,start:origin,end:origin,gapStart:origin,gapEnd:origin,overlap:0n};
  });
  let cursor=origin,runOrigin=origin,basisStart=ZERO,shift=0n;
  for(let i=0;i<cells.length;i++){
    const cell=cells[i]!,previous=cells[i-1],newRun=!previous||cell.gap>0n;
    if(cell.runBasisOffset&&(!newRun||cell.mode!=='absolute'))invalid('丸めの基準位置は絶対丸め区間の先頭だけに指定できます',[cell.id]);
    if(cell.requested&&(!previous||newRun))invalid('先頭または空白の後には重なりを指定できません',[cell.id]);
    if(newRun){basisStart=cell.runBasisOffset??ZERO;runOrigin=cursor+cell.gap-(cell.mode==='absolute'?round(div(basisStart,cell.rate)):0n);shift=0n;}
    else if(cell.mode!==previous.mode)invalid('同じ連続区間の丸め方式を混在させることはできません',[previous.id,cell.id]);
    if(!newRun&&cell.mode==='absolute'&&compare(cell.rate,previous!.rate)!==0)
      invalid('絶対丸めの連続区間では同じ速度が必要です',[previous!.id,cell.id]);
    if(cell.requested&&cell.mode!=='absolute')invalid('重なりは同じ速度の絶対丸め区間だけに指定できます',[cell.id]);
    cell.basisStart=basisStart;cell.runOrigin=runOrigin;cell.gapStart=cursor;cell.gapEnd=cursor+cell.gap;
    const duration=cell.mode==='absolute'
      ?round(div(add(basisStart,cell.span),cell.rate))-round(div(basisStart,cell.rate))
      :round(div(cell.span,cell.rate));
    if(duration<=0n)invalid('速度変更後に0フレームになる区間があります',[cell.id]);
    if(cell.requested){
      const priorDuration=previous!.end-previous!.start;
      const requested=round(div(cell.requested,previous!.rate));
      const cap=(priorDuration<duration?priorDuration:duration)/2n;
      cell.overlap=requested<cap?requested:cap;
      if(cell.overlap<=0n)invalid('速度変更後に重なりが0フレームになります',[previous!.id,cell.id]);
      shift+=cell.overlap;
    }
    // prefix is the ACTUAL rounded timeline start. It is not sum(span / rate).
    cell.prefix=cursor+cell.gap-cell.overlap;cell.shift=shift;
    cell.start=cell.prefix;cell.end=cell.start+duration;
    if(cell.mode==='absolute'&&cell.start!==runOrigin+round(div(basisStart,cell.rate))-shift)
      invalid('区間の開始位置を一意に構成できません',[cell.id]);
    // Adjacent half caps permit a shared boundary, never a three-way overlap.
    const beforePrevious=cells[i-2];
    if(beforePrevious&&cell.overlap>0n&&cell.start<beforePrevious.end)
      invalid('3つの区間が同時に重なる配置は扱えません',[beforePrevious.id,previous!.id,cell.id]);
    for(const frame of [cell.start,cell.end,cell.gapStart,cell.gapEnd])safe(frame,[cell.id]);
    cursor=cell.end;basisStart=add(basisStart,cell.span);
  }
  const byId=new Map(cells.map(cell=>[cell.id,cell]));
  const owner=(id:string):Internal=>{const cell=byId.get(id);if(!cell)throw new SequenceError('MISSING_TARGET','速度区間の所有IDが見つかりません',[id]);return cell;};
  const part=(kind:SpeedMapPart)=>{if(kind!=='clip'&&kind!=='gap-before')invalid('時刻の領域が不正です');};
  const entries=Object.freeze(cells.map(cell=>Object.freeze({ownerId:cell.id,startFrame:safe(cell.start),endFrame:safe(cell.end),gapStartFrame:safe(cell.gapStart),gapEndFrame:safe(cell.gapEnd),overlapBeforeFrames:safe(cell.overlap)})));
  return Object.freeze({entries,originFrame:safe(origin),endFrame:safe(cursor),durationFrames:safe(cursor-origin),
    point(point:SpeedMapPoint):number{
      if(!point)invalid('所有区間と時刻を指定してください');part(point.kind);
      const cell=owner(point.ownerId),offset=read(point.offset,cell.id),span=point.kind==='clip'?cell.span:q(cell.gap);
      if(point.kind==='gap-before'&&cell.gap===0n)invalid('この所有区間の前に空白はありません',[cell.id]);
      if(compare(offset,ZERO)<0||compare(offset,span)>0)invalid('時刻が所有区間の外にあります',[cell.id]);
      if(point.kind==='gap-before')return safe(cell.gapStart+round(offset),[cell.id]);
      return safe(cell.mode==='absolute'
        ?cell.runOrigin+round(div(add(cell.basisStart,offset),cell.rate))-cell.shift
        :cell.prefix+round(div(offset,cell.rate)),[cell.id]);
    },
    inverse(ownerId:string,frame:number,kind:SpeedMapPart='clip'):Rational{
      part(kind);const cell=owner(ownerId),at=integer(frame,'編集時刻');
      if(kind==='gap-before'&&cell.gap===0n)invalid('この所有区間の前に空白はありません',[cell.id]);
      const start=kind==='clip'?cell.start:cell.gapStart,end=kind==='clip'?cell.end:cell.gapEnd;
      if(at<start||at>end)invalid('編集時刻が所有区間の外にあります',[cell.id]);
      if(kind==='gap-before')return stored(q(at-start),cell.id);
      if(at===start)return {num:0,den:1};if(at===end)return stored(cell.span,cell.id);
      const offset=cell.mode==='absolute'
        ?sub(mul(q(at-cell.runOrigin+cell.shift),cell.rate),cell.basisStart)
        :mul(q(at-cell.prefix),cell.rate);
      if(compare(offset,ZERO)<0||compare(offset,cell.span)>0)invalid('編集時刻の局所逆を所有区間内に構成できません',[cell.id]);
      return stored(offset,cell.id);
    },
  });
}
