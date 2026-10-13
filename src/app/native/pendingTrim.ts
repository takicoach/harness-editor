import {clipEnd,type SequenceClip,type SequenceDocument} from '../../core/sequence/model';
import type {RippleTrimPlan} from '../../core/sequence/rippleTrim';

/** 設計 §2-6: ドラッグとは別の「確定待ち」。操作元のセッション・版・対象のクリップ・確定後の位置を持ち、元の文書の上に確定後の位置を描く（差分を足さない）。 */
export interface PendingTrim {sessionId:string|undefined;documentId:string;revision:number;clipId:string;startFrame:number;durationFrames:number;
  /** 素材側のずれ（開始端を動かしたぶん）。波形・コマ絵の位置合わせに使う。 */
  sourceOffsetFrames:number;
  /** 「詰める」で送った時の計画。確定までの間も説明の帯（詰める範囲・1 本に戻す・押し出し）を出し続ける。 */
  plan?:RippleTrimPlan}
export function pendingTrimFrom(input:{sessionId:string|undefined;document:SequenceDocument;clip:SequenceClip;edge:'start'|'end';frame:number;ripple:boolean;plan:RippleTrimPlan|undefined}):PendingTrim|null{
  const {clip,edge}=input,start=clip.startFrame,end=clipEnd(clip),plan=input.ripple?input.plan:undefined;
  // 開始端の結合は左隣の先頭で止まる（RIPPLE_JOIN_START_NOTICE）。それより左へ引いた分を描くと確定で跳ぶ。
  const landing=edge==='start'&&plan?.kind==='join'?input.document.clips.find(c=>c.id===plan.leftId)?.startFrame:undefined;
  const frame=landing===undefined?input.frame:Math.max(input.frame,landing);
  // 「詰める」の短縮（close）は削った区間ごと後ろを詰めるので、開始端を削ってもクリップは元の位置から始まる。
  const closes=plan?.kind==='close';
  const startFrame=edge==='start'&&!closes?frame:start,endFrame=edge==='end'?frame:closes?end-(frame-start):end;
  if(!Number.isSafeInteger(startFrame)||!Number.isSafeInteger(endFrame)||endFrame<=startFrame)return null;
  return {sessionId:input.sessionId,documentId:input.document.id,revision:input.document.revision,clipId:clip.id,startFrame,durationFrames:endFrame-startFrame,sourceOffsetFrames:edge==='start'?frame-start:0,...(plan?{plan}:{})};
}
/** 作った時の文書にだけ効く。版・文書・セッションが変われば（確定・取り消し・AI 編集・外部の再読込）、届いた文書が正。 */
export function livePendingTrim(pending:PendingTrim|null,document:SequenceDocument,sessionId:string|undefined):PendingTrim|null{
  return pending&&pending.documentId===document.id&&pending.revision===document.revision&&pending.sessionId===sessionId&&document.clips.some(clip=>clip.id===pending.clipId)?pending:null;
}
