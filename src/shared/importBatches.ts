// src/shared/importBatches.ts
/** 1つの束に入れられる動画の上限（8本の要件に余裕を持たせる。HTTP・AI・画面で共通）。 */
export const MAX_IMPORT_BATCH_ITEMS=50;
/** 素材名の上限（文字数。ファイルシステムの名前の上限と同じ 255）。 */
export const MAX_IMPORT_NAME_LENGTH=255;
/**
 * 各素材の段（設計 §2-5: 調査中／指紋中／準備済み／失敗）。waiting は画面からの受け渡し待ち（判定を終えて登録の順番を待つ間も waiting）。
 * judging は照合時間の見込みの判定中（短い工程。登録の実行枠は握らない）、awaiting-decision はコピーするかの判断待ち（実行枠を握らない）、
 * copying は速いドライブへのコピー中（設計 §2）。
 */
export type ImportItemPhase='waiting'|'judging'|'awaiting-decision'|'probing'|'fingerprinting'|'copying'|'ready'|'failed'|'cancelled';
export type ImportBatchState='open'|'confirming'|'confirmed'|'cancelled';
/** deciding: 準備はすべて終わり、判断待ちの素材が残っている（決めるまで確定しない）。 */
export type ImportBatchPhase='preparing'|'deciding'|'ready'|'partial'|'failed'|'confirming'|'confirmed'|'cancelled';
export type ImportBatchOrigin={kind:'ui'}|{kind:'home'}|{kind:'agent';operationId:string};
/** 判断待ちの素材の扱い: 速いドライブへコピー／今回はこのまま／この接続先では今後出さない。 */
export type ImportDecisionChoice='copy'|'keep-once'|'keep-always';
/**
 * audioOnly: 映像の無い動画ファイル（音声だけの .mp4 など）。確定でメインには並べず、素材の一覧への登録だけをする。
 * slow: 照合に時間がかかる見込み（大きさと秒。canRemember:false はドライブを識別できず「この接続先では今後出さない」を記録できない＝選ぶと「今回はこのまま」と同じ）。
 * choice: 判断待ちで選ばれた扱い（登録後に素材 ID へ引き継ぐ）。
 */
export interface ImportItemView {itemId:string;key:string;name:string;phase:ImportItemPhase;assetId?:string;durationSeconds?:number;error?:string;audioOnly?:true;
  slow?:{sizeBytes:number;seconds:number;canRemember?:false};choice?:ImportDecisionChoice}
/** 確定が再試行しても通らない理由で断られた時の記録（速度登録済み・映像の無い素材・取り込み記録が無い）。一時的な失敗（版の衝突など）は記録しない。 */
export const IMPORT_REFUSAL_CODES=['SPEED_REGISTERED','NOT_VIDEO','IMPORT_ASSET_MISSING'] as const;
export type ImportRefusalCode=typeof IMPORT_REFUSAL_CODES[number];
/**
 * refusal: 未確定の束にだけ出す（最後に記録した、確定が断られた理由）。
 * decision: 未確定の束で、全項目の判定が終わり（受け渡し待ち・判定中が無い）判断待ちがある時だけ（対象と合計。案内を1回出す）。
 */
export interface ImportBatchView {batchId:string;projectId:string;createdAt:string;origin:ImportBatchOrigin;placement:'append-main';mode:'link'|'copy';phase:ImportBatchPhase;items:ImportItemView[];
  confirmed?:{executionId:string;revision:number};refusal?:{code:ImportRefusalCode;message:string};decision?:{itemIds:string[];totalBytes:number;totalSeconds:number}}
export const IMPORT_REASON={confirmed:'IMPORT_CONFIRMED',cancelled:'IMPORT_CANCELLED',confirming:'IMPORT_CONFIRMING',notReady:'IMPORT_NOT_READY',partial:'IMPORT_PARTIAL',
  closed:'IMPORT_CLOSED',delivered:'IMPORT_DELIVERED',requestConflict:'IMPORT_REQUEST_CONFLICT',assetMissing:'IMPORT_ASSET_MISSING',pruned:'IMPORT_PRUNED',
  deciding:'IMPORT_DECIDING',noDecision:'IMPORT_NO_DECISION'} as const;
const ACTIVE:readonly ImportItemPhase[]=['waiting','judging','probing','fingerprinting','copying'];
/** 束の段は記録の状態と各素材の段から導く（保存するのは状態だけ）。判断待ちは実行中の素材が無くなってから deciding にする。 */
export function importBatchPhase(state:ImportBatchState,items:readonly {phase:ImportItemPhase}[]):ImportBatchPhase{
  if(state!=='open')return state;
  if(items.some(item=>ACTIVE.includes(item.phase)))return 'preparing';
  if(items.some(item=>item.phase==='awaiting-decision'))return 'deciding';
  const ready=items.filter(item=>item.phase==='ready').length;
  return ready===items.length?'ready':ready?'partial':'failed';
}
