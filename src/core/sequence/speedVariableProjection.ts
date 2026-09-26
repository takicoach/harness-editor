import {SequenceError} from './errors';
import {type SequenceDocument,type SequenceClip} from './model';
import {phasePoint,phaseInverse} from './speedTopologyProjection';
import {roundSpeedTime} from './speedTimeMap';
import {addTime,subtractTime,divideTime,compareTime,rational,type Rational} from './time';
import type {DocumentSpeedProjection} from './speedCaptionLedger';
const zero=rational(0);
function fail(message:string,ids:string[]=[]):never{throw new SequenceError('INVALID_RANGE',message,ids);}
const safe=(v:number)=>{if(!Number.isSafeInteger(v)||v<0)return fail('速度変更後の表示時刻を保存できません');return v;};
/** Saved evaluation lineage and projection-rate partitions are separate concerns.
 * No rounded current clip position/source/clock is used to construct this map. */
export function variableSpeedProjection(doc:SequenceDocument):DocumentSpeedProjection {
 const speed=doc.speed!;
 const mains=doc.clips.filter(c=>c.speed?.kind==='main').sort((a,b)=>(a.speed?.kind==='main'?a.speed.order:0)-(b.speed?.kind==='main'?b.speed.order:0));
 if(!mains.length||speed.sequenceEndBasis.kind!=='main-offset')return fail('速度変更する主映像がありません');
 const mode=mains.some(c=>c.speed?.kind==='main'&&compareTime(c.speed.override??speed.globalRate,speed.globalRate)!==0)?'cumulative' as const:'absolute' as const;
 type Piece={clip:SequenceClip;offset:Rational;span:Rational;rate:Rational};
 type Group={root:SequenceClip;pieces:Piece[];extent:Rational;phase:Rational;virtual:number;gapStart:number;gapEnd:number;overlap:number;point:(x:Rational)=>number};
 const groups:Group[]=[],byId=new Map<string,{group:Group;piece:Piece}>();let phase=zero;
 for(const c of mains){const s=c.speed!;if(s.kind!=='main')return fail('主映像の基準がありません',[c.id]);const owner=s.evaluationOwnerId??c.id;let g=groups.at(-1);
  if(!g||g.root.id!==owner){if(owner!==c.id)return fail('元時計の先頭ownerがありません',[c.id,owner]);if(s.runHead)phase=s.runHead.phase;if(s.structuralPlacement)phase=s.structuralPlacement.phase;
   g={root:c,pieces:[],extent:s.projectionExtent??zero,phase,virtual:0,gapStart:0,gapEnd:0,overlap:0,point:()=>0};groups.push(g);
  } else if(s.runHead||s.structuralPlacement||s.overlapBefore)return fail('分割片途中の配置基準は未対応です',[c.id]);
  const previous=g.pieces.at(-1),offset=s.projectionOffset??(previous?addTime(previous.offset,previous.span):zero);
  const p={clip:c,offset,span:s.span,rate:s.override??speed.globalRate};g.pieces.push(p);byId.set(c.id,{group:g,piece:p});
  if(!g.root.speed||g.root.speed.kind!=='main')return fail('元投影の種類が不正です');
  if(!g.root.speed.projectionExtent)g.extent=addTime(offset,s.span);
  phase=addTime(g.phase,g.extent);
 }
 for(const g of groups){
  const rateAt=(x:Rational)=>[...g.pieces].reverse().find(p=>compareTime(p.offset,x)<=0)?.rate??g.pieces[0]!.rate;
  g.point=(x:Rational)=>{
   if(compareTime(x,zero)===0)return 0;
   const low=compareTime(x,zero)<0?x:zero,high=compareTime(x,zero)<0?zero:x;
   const edges=[low,...g.pieces.map(p=>p.offset).filter(p=>compareTime(p,low)>0&&compareTime(p,high)<0),high];let sum=0;
   for(let i=1;i<edges.length;i++){const a=edges[i-1]!,b=edges[i]!,rate=rateAt(a);sum+=phasePoint(g.phase,b,rate,mode)-phasePoint(g.phase,a,rate,mode);if(!Number.isSafeInteger(sum))return fail('速度区間の合計が安全整数を超えます',[g.root.id]);}
   return compareTime(x,zero)<0?-sum:sum;
  };
 }
 let cursor=speed.originFrame;
 for(const [i,g] of groups.entries()){const s=g.root.speed!;if(s.kind!=='main')return fail('主基準が不正です');const gap=s.structuralPlacement?.gapFrames??s.runHead?.gapFrames??0;g.gapStart=cursor;
  if(s.overlapBefore){const prev=groups[i-1];if(!prev||mode!=='absolute'||gap||prev.pieces.some(p=>compareTime(p.rate,g.pieces[0]!.rate)!==0)||g.pieces.some(p=>compareTime(p.rate,g.pieces[0]!.rate)!==0))return fail('異なる速度を含む重なり転換には専用再結合が必要です',[prev?.root.id??'',g.root.id]);
   g.overlap=Math.min(roundSpeedTime(divideTime(s.overlapBefore,g.pieces[0]!.rate)),Math.floor(Math.min(prev.point(prev.extent),g.point(g.extent))/2));if(g.overlap<=0)return fail('速度変更で転換が0フレームになります',[g.root.id]);
  }
  g.gapEnd=safe(cursor+gap);g.virtual=g.gapEnd-g.overlap-(s.structuralPlacement?g.point(s.structuralPlacement.anchorStart):0);
  cursor=safe(g.virtual+g.point(s.structuralPlacement?.anchorEnd??g.extent));
 }
 const get=(id:string)=>byId.get(id)??fail('速度の所有者がありません',[id]);
 const rootPoint=(id:string,x:Rational)=>{const {group:g}=get(id);return safe(g.virtual+g.point(x));};
 const entries=mains.map(c=>{const {group:g,piece:p}=get(c.id);return {ownerId:c.id,startFrame:rootPoint(c.id,p.offset),endFrame:rootPoint(c.id,addTime(p.offset,p.span)),gapStartFrame:c.id===g.root.id?g.gapStart:rootPoint(c.id,p.offset),gapEndFrame:c.id===g.root.id?g.gapEnd:rootPoint(c.id,p.offset),overlapBeforeFrames:c.id===g.root.id?g.overlap:0};});
 const mainEndFrame=entries.at(-1)!.endFrame,sequenceEndFrame=safe(mainEndFrame+speed.sequenceEndBasis.offsetFrames);
 const rootInverse=(id:string,frame:number)=>{const {group:g,piece:p}=get(id);if(!Number.isSafeInteger(frame))return fail('時刻は整数で指定してください',[id]);return phaseInverse(g.phase,frame-g.virtual-g.point(p.offset)+phasePoint(g.phase,p.offset,p.rate,mode),p.rate,mode);};
 return {family:'native-exact-v1',mode,entries,originFrame:speed.originFrame,mainEndFrame,sequenceEndFrame,phase:id=>get(id).group.phase,rootSpan:id=>get(id).group.extent,rootStart:id=>get(id).group.virtual,offset:id=>get(id).piece.offset,rate:id=>get(id).piece.rate,rootPoint,rootInverse,
  evaluationDelta(id){const {group:g,piece:p}=get(id);return phasePoint(g.phase,p.offset,p.rate,mode);},
  point(p){const {group:g,piece}=get(p.ownerId);if(p.kind==='clip'){if(compareTime(p.offset,zero)<0||compareTime(p.offset,piece.span)>0)return fail('時刻が主片の外です',[p.ownerId]);return rootPoint(p.ownerId,addTime(piece.offset,p.offset));}
   if(p.kind==='gap-before'){if(p.ownerId!==g.root.id||g.gapEnd<=g.gapStart||compareTime(p.offset,zero)<0||compareTime(p.offset,rational(g.gapEnd-g.gapStart))>0)return fail('時刻が空白の外です',[p.ownerId]);return safe(g.gapStart+roundSpeedTime(p.offset));}
   if(p.ownerId!==mains.at(-1)!.id||sequenceEndFrame<=mainEndFrame||compareTime(p.offset,zero)<0||compareTime(p.offset,rational(sequenceEndFrame-mainEndFrame))>0)return fail('時刻が完成尺末尾の外です',[p.ownerId]);return safe(mainEndFrame+roundSpeedTime(p.offset));
  },
  inverse(id,frame,kind='clip'){const e=entries.find(e=>e.ownerId===id)??fail('主片がありません',[id]),{group:g,piece:p}=get(id);
   if(!Number.isSafeInteger(frame))return fail('時刻は整数で指定してください',[id]);
   if(kind==='gap-before'){if(id!==g.root.id||frame<g.gapStart||frame>g.gapEnd||g.gapEnd<=g.gapStart)return fail('空白外の時刻です',[id]);return rational(frame-g.gapStart);}
   if(kind==='after-main'){if(id!==mains.at(-1)!.id||frame<mainEndFrame||frame>sequenceEndFrame||sequenceEndFrame<=mainEndFrame)return fail('末尾外の時刻です',[id]);return rational(frame-mainEndFrame);}
   if(frame<e.startFrame||frame>e.endFrame)return fail('主片外の時刻です',[id]);if(frame===e.startFrame)return zero;if(frame===e.endFrame)return p.span;return subtractTime(rootInverse(id,frame),p.offset);
  }
 };
}
