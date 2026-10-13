// src/server/sequence/importBatches.ts
import {createHash,randomUUID} from 'node:crypto';
import {closeSync,existsSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {basename,join} from 'node:path';
import {z} from 'zod';
import type {SequenceAsset} from '../../core/sequence/model';
import {timeNumber} from '../../core/sequence/time';
import {createMediaKind} from '../../shared/createMedia';
import {orderByName} from '../../shared/importOrder';
import {importBatchPhase,IMPORT_REASON,IMPORT_REFUSAL_CODES,MAX_IMPORT_BATCH_ITEMS,MAX_IMPORT_NAME_LENGTH,type ImportBatchOrigin,type ImportBatchState,type ImportBatchView,type ImportDecisionChoice,
  type ImportItemPhase,type ImportRefusalCode} from '../../shared/importBatches';
import {HttpError} from '../http';
import {importSequenceAssetDetailed,registeredSequenceAssets,verifiedSequenceAssetPath,type ImportHooks} from './assets';
import {isSequenceReferenceFile,referenceTarget,registerSequenceReferenceDetailed} from './references';
import {copyIo} from './mediaCopy/io';
import {judgeAddedSource,type JudgeSession,type SlowJudgement} from './mediaCopy/estimate';
import {connectionOf,suppressSlowMediaAdvice} from './mediaCopy/slowMedia';
import {copyJobsRoot,mediaCopyJobs,type AddCallbacks,type AddItemInput,type StartCommon} from './mediaCopy/jobs';
import type {ChosenDestination,DestinationInput} from './mediaCopy/destinations';
import {executeAppendToMain} from './appendMain';
import type {SequenceService} from './service';

export type ImportItemSource={kind:'path';path:string}|{kind:'client'};
/** requestKey: 再送の照合に使う鍵（省略時は項目から作る）。AI の取り込みは受け取った本文から作り、パスを解決し直さずに再送へ答える。 */
export interface CreateImportBatchInput {requestId:string;projectId:string;origin:ImportBatchOrigin;mode:'link'|'copy';items:Array<{key:string;name:string;source:ImportItemSource}>;requestKey?:string}
/** resolvedSource: 受付時に実パスへ解決し許可を確かめた場所（パス指定・/imports/reference）。画面から受け取った一時ファイルは false。 */
export type PrepareImportAsset=(input:{directory:string;mode:'link'|'copy';path:string;name:string;expectedFingerprint?:string;resolvedSource:boolean;signal:AbortSignal;hooks:ImportHooks})=>Promise<SequenceAsset>;
export type ResolveImportAsset=(root:string,assetId:string)=>Promise<SequenceAsset|undefined>;
/** 追加時の判定（短い工程。登録の実行枠は握らない。設計 §2）。session は同じ束の判定で共有する覚え（試し読みが時間切れになったドライブの残りは読まない）。 */
export type JudgeImportSource=(path:string,signal:AbortSignal,session:JudgeSession)=>Promise<SlowJudgement>;
/** 判断待ちの項目を速いドライブへコピーする出入口（試験で差し替える）。root は作業の案件の鍵（copyJobsRoot）。 */
export interface ImportCopies {startAdd(input:StartCommon&{items:AddItemInput[];callbacks:AddCallbacks}):Promise<unknown>;cancelBatch(root:string,batchId:string):void}
/** judgeLimitMs: 判定がこの長さで終わらなければ諦めて今まで通り登録へ進む（試験だけが縮める）。 */
export interface ImportBatchOptions {judge?:JudgeImportSource;copies?:ImportCopies;judgeLimitMs?:number}
/**
 * 判定の上限（既定 2 分）。試し読みの1回の読みは 30 秒の見張りがあるが（Task 4）、場所の解決・ボリュームの識別が戻らない時にも束を判定中のまま止めない。
 * 諦めた項目は判断待ちにせず今まで通り登録する（開いた時の案内と素材行の入口で扱える）。
 */
export const IMPORT_JUDGE_LIMIT_MS=120_000;
const defaultJudge:JudgeImportSource=(path,signal,session)=>judgeAddedSource(copyIo(),path,signal,session);
const defaultCopies:ImportCopies={startAdd:input=>mediaCopyJobs.startAdd(input),cancelBatch:(root,batchId)=>mediaCopyJobs.cancelBatch(root,batchId)};
/**
 * source: 判断待ち・判断後の準備・コピー中の間だけ持つ実パス（受付で実パスへ解決済み。再起動後も判断できるように。画面・AI へは返さない）。expected: 受け渡しの時の期待する指紋（同じ間だけ）。
 * judged: 判定を終えた。slow: 判定の結果（volume はドライブの識別。無ければ「今後出さない」を記録できない）。choice: 判断待ちで選ばれた扱い。
 */
interface ItemRecord {itemId:string;key:string;name:string;phase:ImportItemPhase;assetId?:string;durationSeconds?:number;error?:string;audioOnly?:true;
  source?:string;expected?:string;judged?:true;slow?:{sizeBytes:number;seconds:number;volume?:string;bytesPerSecond?:number};choice?:ImportDecisionChoice}
interface BatchRecord {version:1;batchId:string;projectId:string;createdAt:string;requestId:string;requestKey:string;origin:ImportBatchOrigin;mode:'link'|'copy';placement:'append-main';
  state:ImportBatchState;items:ItemRecord[];confirmed?:{executionId:string;revision:number};refusal?:{code:ImportRefusalCode;message:string}}
type ConfirmResult=ReturnType<typeof executeAppendToMain>;
/**
 * confirming: 配置中の確定（同じ確定の再送が同じ結果を受け取るため。key はセッション・実行 ID・失敗分の扱い）。
 * judged: 判定を終えて登録を待つ項目（受け渡し済みの項目の判定が終わってから登録へ並べる）。registering: この束の登録（全体の読み）。
 * session: この束の判定で共有する覚え（試し読みが時間切れになったドライブ）。いずれもメモリだけに持つ。
 */
interface Batch {root:string;record:BatchRecord;controller:AbortController;pending:Set<Promise<void>>;delivered:Set<string>;confirming?:{key:string;work:Promise<ConfirmResult>};
  judged?:Array<{item:ItemRecord;path:string;resolvedSource:boolean;expectedFingerprint?:string}>;registering?:Set<Promise<void>>;session?:JudgeSession}
const ACTIVE:readonly ImportItemPhase[]=['waiting','judging','probing','fingerprinting','copying'];
const RESTARTED='サーバーが停止したため取り込みを中断しました。もう一度追加してください';
const FINGERPRINT_MISMATCH='選択した素材の指紋と現在の参照先が一致しません';
/** 保存する失敗理由の上限（ffprobe の失敗文は標準エラーを長く含むため。読む時の上限 4096 より短く切る）。 */
const MAX_STORED_ERROR=1000;
/** 画面が送れなかった（送るのをやめた）素材の理由。画面からの文は記録しない。 */
const UNDELIVERED='動画を受け取れませんでした。もう一度追加してください';
/** この時間より古い一時ファイル（rename の前に止まった書き込みの残り）は、一覧を読む時に片付ける。 */
const STALE_TEMPORARY_MS=60*60*1000,TEMPORARY=/^(imp-[a-f0-9]{20}|operations)(\.[0-9a-f-]{36})?\.tmp$/;
const RETAIN=50,BATCH_ID=/^imp-[a-f0-9]{20}$/,REQUEST_ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,REQUEST_KEY=/^[a-f0-9]{64}$/;
/** 記録の形（読む時に確かめる。合わない記録は読まない＝一覧から除く）。判断待ちの項目（source 以降）は足しただけなので、判断待ちの無い前の形もそのまま読める。 */
const itemSchema=z.object({itemId:z.string().regex(/^i\d{1,3}$/),key:z.string().min(1).max(64),name:z.string().min(1).max(MAX_IMPORT_NAME_LENGTH),
  phase:z.enum(['waiting','judging','awaiting-decision','probing','fingerprinting','copying','ready','failed','cancelled']),assetId:z.string().min(1).max(256).optional(),
  durationSeconds:z.number().nonnegative().optional(),error:z.string().max(4096).optional(),audioOnly:z.literal(true).optional(),
  source:z.string().min(1).max(4096).optional(),expected:z.string().regex(/^[a-f0-9]{64}$/).optional(),judged:z.literal(true).optional(),
  slow:z.object({sizeBytes:z.number().nonnegative(),seconds:z.number().nonnegative(),volume:z.string().min(1).max(256).optional(),bytesPerSecond:z.number().positive().optional()}).strict().optional(),
  choice:z.enum(['copy','keep-once','keep-always']).optional()});
const recordSchema=z.object({version:z.literal(1),batchId:z.string().regex(BATCH_ID),projectId:z.string().min(1).max(1024),createdAt:z.string().min(1).max(64),
  requestId:z.string().regex(REQUEST_ID),requestKey:z.string().regex(REQUEST_KEY),
  origin:z.discriminatedUnion('kind',[z.object({kind:z.literal('ui')}),z.object({kind:z.literal('home')}),z.object({kind:z.literal('agent'),operationId:z.string().min(1).max(256)})]),
  mode:z.enum(['link','copy']),placement:z.literal('append-main'),state:z.enum(['open','confirming','confirmed','cancelled']),
  items:z.array(itemSchema).min(1).max(MAX_IMPORT_BATCH_ITEMS).refine(items=>new Set(items.map(item=>item.itemId)).size===items.length),
  confirmed:z.object({executionId:z.string().min(1).max(128),revision:z.number().int().nonnegative()}).optional(),
  refusal:z.object({code:z.enum(IMPORT_REFUSAL_CODES),message:z.string().min(1).max(MAX_STORED_ERROR+1)}).optional()}).refine(record=>record.state!=='confirmed'||record.confirmed!==undefined);
const defaultPrepare:PrepareImportAsset=async({directory,mode,path,name,expectedFingerprint,resolvedSource,signal,hooks})=>mode==='link'
  ?(await registerSequenceReferenceDetailed(directory,path,name,signal,expectedFingerprint,hooks,{resolvedSource})).asset
  :(await importSequenceAssetDetailed(directory,path,name,signal,hooks,{resolvedSource})).asset;
const defaultResolve:ResolveImportAsset=async(root,assetId)=>{
  const asset=(await registeredSequenceAssets(root)).find(item=>item.id===assetId);if(asset)await verifiedSequenceAssetPath(root,asset);return asset;
};
const entry=(path:string)=>lstatSync(path,{throwIfNoEntry:false});
function isFolder(path:string):boolean{
  const info=entry(path);if(!info)return false;if(!info.isDirectory()||info.isSymbolicLink())throw new Error('取り込みの記録先が不正です');return true;
}
/** 記録先 .harness/imports。.harness は作らない（削除された案件のフォルダを復活させない）。imports だけを再帰なしで作る。 */
function folder(root:string,create=false):string{
  const harness=join(root,'.harness'),imports=join(harness,'imports');
  if(!isFolder(harness)){if(create)throw new Error('案件の記録先（.harness）がありません');return imports;}
  if(create&&!isFolder(imports)){
    try{mkdirSync(imports);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    if(!isFolder(imports))throw new Error('取り込みの記録先を作れません');
  }
  return imports;
}
/** 記録を書く。一時ファイルは推測できない名前で新しく作り（wx＝置いてあるリンクをたどらない）、置き換えは rename。失敗したら自分が作った一時ファイルを消す。 */
function writeJson(root:string,name:string,value:unknown):void{
  const directory=folder(root,true),temporary=join(directory,`${name}.${randomUUID()}.tmp`);
  let created=false;
  try{
    const handle=openSync(temporary,'wx',0o600);created=true;
    try{writeFileSync(handle,JSON.stringify(value));}finally{closeSync(handle);}
    renameSync(temporary,join(directory,`${name}.json`));
  }catch(error){if(created)try{rmSync(temporary,{force:true});}catch{/* 元のエラーを返す */}throw error;}
}
const writeRecord=(root:string,record:BatchRecord):void=>writeJson(root,record.batchId,record);
/**
 * AI の操作の索引（要求ID→束ID・要求の鍵）。古い束の記録の整理（RETAIN）の対象外。束の記録が消えた後の同じ操作の再送に、新しい束を作らず答えるため。
 * 1件は100字ほどで、AI の操作の数だけ増える。
 */
const OPERATIONS='operations',MAX_OPERATIONS_BYTES=16*1024*1024;
const operationsSchema=z.object({version:z.literal(1),operations:z.record(z.string().regex(REQUEST_ID),z.object({batchId:z.string().regex(BATCH_ID),requestKey:z.string().regex(REQUEST_KEY)}))});
type OperationIndex=z.infer<typeof operationsSchema>['operations'];
function readOperations(root:string):OperationIndex{
  const path=join(folder(root),`${OPERATIONS}.json`),info=entry(path);if(!info)return {};
  if(!info.isFile()||info.isSymbolicLink()||info.size>MAX_OPERATIONS_BYTES)throw new Error('取り込みの操作の記録が不正です');
  const parsed=operationsSchema.safeParse(JSON.parse(readFileSync(path,'utf8')));if(!parsed.success)throw new Error('取り込みの操作の記録を読み取れません');
  return parsed.data.operations;
}
/** 整理済みの束への再送（同じ中身）と、中身の違う再送を断る。 */
function assertNotIndexed(root:string,requestId:string,requestKey?:string):void{
  const operations=readOperations(root),indexed=Object.hasOwn(operations,requestId)?operations[requestId]:undefined;if(!indexed)return;
  if(requestKey!==undefined&&indexed.requestKey!==requestKey)throw new HttpError(409,'同じ要求IDに異なる取り込みがあります',{reason:IMPORT_REASON.requestConflict});
  throw new HttpError(409,'この操作は完了済みです（記録は整理済み）',{reason:IMPORT_REASON.pruned});
}
/** 判定が済んでいない項目（受け渡し待ち・判定中）がある。全項目の判定が終わるまで判断を求めない（案内は1回）。 */
const judging=(items:readonly ItemRecord[])=>items.some(item=>(item.phase==='waiting'&&!item.judged)||item.phase==='judging');
/**
 * 登録を待たせる項目（受け渡し済みで判定前、または判定中）がある。未受け渡しの項目では待たない（ブラウザ版は1本ずつ渡すので、最後の受け渡しまで1本目の登録を止めない）。
 * 案内（decisionOf）は今まで通り全項目の判定を待つ。
 */
const judgingDelivered=(batch:Batch)=>batch.record.items.some(item=>(item.phase==='waiting'&&!item.judged&&batch.delivered.has(item.itemId))||item.phase==='judging');
/** 束の全項目の判定が終わり（受け渡し待ち・判定中が無い）、判断待ちがある時だけ案内を出す（設計 §2）。 */
function decisionOf(items:readonly ItemRecord[]):ImportBatchView['decision']{
  if(judging(items))return undefined;
  const targets=items.filter(item=>item.phase==='awaiting-decision');if(!targets.length)return undefined;
  return {itemIds:targets.map(item=>item.itemId),totalBytes:targets.reduce((sum,item)=>sum+(item.slow?.sizeBytes??0),0),totalSeconds:targets.reduce((sum,item)=>sum+(item.slow?.seconds??0),0)};
}
/** 画面・AI へ返す形。実パス・期待する指紋・要求の鍵は含めない。ドライブを識別できない項目は「今後出さない」を記録できない（canRemember:false）。 */
function view(record:BatchRecord):ImportBatchView{
  const decision=record.state==='open'?decisionOf(record.items):undefined;
  return {batchId:record.batchId,projectId:record.projectId,createdAt:record.createdAt,origin:structuredClone(record.origin),placement:record.placement,mode:record.mode,
    phase:importBatchPhase(record.state,record.items),
    items:record.items.map(({itemId,key,name,phase,assetId,durationSeconds,error,audioOnly,slow,choice})=>({itemId,key,name,phase,...(assetId?{assetId}:{}),...(durationSeconds!==undefined?{durationSeconds}:{}),
      ...(error?{error}:{}),...(audioOnly?{audioOnly}:{}),...(slow?{slow:{sizeBytes:slow.sizeBytes,seconds:slow.seconds,...(slow.volume?{}:{canRemember:false as const})}}:{}),...(choice?{choice}:{})})),
    ...(record.confirmed?{confirmed:{...record.confirmed}}:{}),...(record.refusal&&record.state==='open'?{refusal:{...record.refusal}}:{}),...(decision?{decision}:{})};
}
/** 値が undefined の項目は消して変える（記録に undefined を残さない）。 */
function patchItem(item:ItemRecord,patch:Partial<ItemRecord>):void{
  for(const [key,value] of Object.entries(patch)){if(value===undefined)delete (item as unknown as Record<string,unknown>)[key];else (item as unknown as Record<string,unknown>)[key]=value;}
}
const stored=(message:string)=>message.length>MAX_STORED_ERROR?`${message.slice(0,MAX_STORED_ERROR)}…`:message;
/** 再試行しても通らない確定の拒否（速度登録済み・映像の無い素材・取り込み記録が無い）だけを束に残す理由にする。 */
function permanentRefusal(error:unknown):{code:ImportRefusalCode;message:string}|undefined{
  if(!(error instanceof HttpError))return undefined;
  const code=IMPORT_REFUSAL_CODES.find(item=>item===error.reason);
  return code?{code,message:error.message.length>MAX_STORED_ERROR?`${error.message.slice(0,MAX_STORED_ERROR)}…`:error.message}:undefined;
}

/** 取り込みの束（設計 §2-5）。文書の外に案件ごとに記録し、確定はサーバが確定時点の最新の文書で組み立てる。 */
export class ImportBatches {
  private batches=new Map<string,Batch>();
  private listeners=new Map<string,Set<()=>void>>();
  private running=0;private queue:Array<()=>void>=[];
  private judge:JudgeImportSource;private copies:ImportCopies;private judgeLimitMs:number;
  /** 束ごとの判定の列（同じ束の試し読みを重ねない）。 */
  private judging=new Map<string,Promise<void>>();
  constructor(private prepareAsset:PrepareImportAsset=defaultPrepare,private resolveAsset:ResolveImportAsset=defaultResolve,private concurrency=2,options:ImportBatchOptions={}){
    this.judge=options.judge??defaultJudge;this.copies=options.copies??defaultCopies;this.judgeLimitMs=options.judgeLimitMs??IMPORT_JUDGE_LIMIT_MS;
  }
  private key(root:string,batchId:string){return `${root}\0${batchId}`;}
  private notify(root:string):void{
    for(const listener of [...this.listeners.get(root)??[]])try{listener();}catch(error){console.error('[sme] 取り込みの通知に失敗しました:',error);}
  }
  /** 束の状態の切り替え: 記録の書き込みに成功してからメモリを変える（失敗したらメモリはそのままで、書き込みのエラーを投げる）。 */
  private commit(batch:Batch,change:(record:BatchRecord)=>void):void{
    const next=structuredClone(batch.record);change(next);writeRecord(batch.root,next);change(batch.record);this.notify(batch.root);
  }
  /** 素材の段（進み具合）: メモリを先に進め、記録は書ければ書く（書けなくても止めない。再起動後は途中の素材が失敗になるので、古い記録は安全側に倒れる）。 */
  private save(batch:Batch,message:string):void{
    try{writeRecord(batch.root,batch.record);}catch(error){console.error(message,error);}
    this.notify(batch.root);
  }
  private load(root:string,batchId:string):Batch|undefined{
    if(!BATCH_ID.test(batchId))throw new HttpError(400,'取り込みのIDが不正です');
    const cached=this.batches.get(this.key(root,batchId));if(cached)return cached;
    const path=join(folder(root),`${batchId}.json`),info=entry(path);if(!info)return undefined;
    if(!info.isFile()||info.isSymbolicLink()||info.size>1024*1024)throw new Error('取り込みの記録が不正です');
    const parsed=recordSchema.safeParse(JSON.parse(readFileSync(path,'utf8')));
    if(!parsed.success||parsed.data.batchId!==batchId)throw new Error('取り込みの記録を読み取れません');
    const record:BatchRecord=parsed.data;
    // 別のプロセス（再起動前）の作業は再開しない。確定の途中も持ち越さない（確定時にクリップの有無で配置済みかを見る）。
    // 判断の材料（実パス）を持つ項目（判断後の登録中・コピー中）は、もう一度判断を求める（コピーの途中のファイルは次の起動で回収され、完了分は再利用される）。
    // 判定中・判断の無い登録中の項目は今まで通り失敗にする。
    let changed=false;
    for(const item of record.items){
      if(!ACTIVE.includes(item.phase))continue;
      if(item.source&&item.phase!=='judging'){item.phase='awaiting-decision';delete item.choice;changed=true;continue;}
      item.phase='failed';item.error=RESTARTED;delete item.source;delete item.expected;changed=true;
    }
    if(record.state==='confirming'){record.state='open';changed=true;}
    const batch:Batch={root,record,controller:new AbortController(),pending:new Set(),delivered:new Set(record.items.map(item=>item.itemId))};
    this.batches.set(this.key(root,batchId),batch);if(changed)this.save(batch,'[sme] 取り込みの記録を更新できません:');
    return batch;
  }
  private require(directory:string,batchId:string):Batch{
    const batch=this.load(realpathSync(directory),batchId);if(!batch)throw new HttpError(404,'取り込みが見つかりません');return batch;
  }
  private item(batch:Batch,itemId:string):ItemRecord{
    const item=batch.record.items.find(entry=>entry.itemId===itemId);if(!item)throw new HttpError(404,'取り込みの素材が見つかりません');return item;
  }
  private async slot<T>(work:()=>Promise<T>):Promise<T>{
    if(this.running>=this.concurrency)await new Promise<void>(resolve=>this.queue.push(resolve));
    this.running++;
    try{return await work();}finally{this.running--;this.queue.shift()?.();}
  }
  private lanes=new Map<string,Promise<void>>();
  /**
   * 同じ案件のリンク登録は受け付けた順に1件ずつ通す。参照の登録は案件の参照台帳の排他（.harness/references/.mutation-lock）を持ち、
   * 同じプロセスから同時に入ると片方が「参照素材の接続変更が未完了です」で失敗するため。待つ間は枠（slot）を使わない。
   */
  private lane<T>(key:string|undefined,work:()=>Promise<T>):Promise<T>{
    if(key===undefined)return work();
    const run=(this.lanes.get(key)??Promise.resolve()).then(work),tail=run.then(()=>undefined,()=>undefined);
    this.lanes.set(key,tail);void tail.then(()=>{if(this.lanes.get(key)===tail)this.lanes.delete(key);});
    return run;
  }
  private schedule(batch:Batch,item:ItemRecord,path:string,resolvedSource:boolean,expectedFingerprint?:string,cleanup?:()=>Promise<void>):void{
    batch.delivered.add(item.itemId);
    // 追加時（リンク・画面とホーム）は、まず判定だけを行う。AI の取り込みと画面から送るコピーは判定せず今まで通り（設計 §2）
    if(batch.record.mode==='link'&&batch.record.origin.kind!=='agent'){this.judgeThen(batch,item,path,resolvedSource,expectedFingerprint);return;}
    this.enqueuePrepare(batch,item,path,resolvedSource,expectedFingerprint,cleanup);
  }
  private enqueuePrepare(batch:Batch,item:ItemRecord,path:string,resolvedSource:boolean,expectedFingerprint?:string,cleanup?:()=>Promise<void>):void{
    // 記録の書き込みの失敗（案件の削除など）は誰も待たない約束の拒否になるので、ここで受け止める（未処理の拒否でサーバを落とさない）。
    const task:Promise<void>=this.lane(batch.record.mode==='link'?batch.root:undefined,()=>this.slot(()=>this.prepare(batch,item,path,resolvedSource,expectedFingerprint)))
      .catch(error=>{console.error('[sme] 取り込みの準備を記録できません:',error);})
      .finally(async()=>{batch.pending.delete(task);batch.registering?.delete(task);await cleanup?.().catch(()=>undefined);});
    batch.pending.add(task);(batch.registering??=new Set()).add(task);
  }
  /**
   * 判定（束ごとに1本ずつ。登録の lane・slot は握らない）。遅い見込みなら判断待ちにして登録しない（実行枠を解放したまま）。
   * それ以外は、受け渡し済みの項目の判定が終わってから登録へ並べる（未受け渡しの項目は待たない）。登録の全体の読みと試し読みは同じ束の中で重ねない:
   * 登録は判定中・判定前の項目がある間は始めず、後から受け渡された項目の試し読みは、その時に動いている同じ束の登録が終わってから始める（同じ媒体を同時に読むと、試し読みの速さを低く測るため）。
   * 判定できなかった（読めない・時間内に終わらない）項目は今まで通り登録する。取り消しでは判定も止める。
   */
  private judgeThen(batch:Batch,item:ItemRecord,path:string,resolvedSource:boolean,expectedFingerprint?:string):void{
    const key=this.key(batch.root,batch.record.batchId),signal=batch.controller.signal;
    const task:Promise<void>=(this.judging.get(key)??Promise.resolve()).then(async()=>{
      while(batch.registering?.size&&!signal.aborted)await Promise.allSettled([...batch.registering]);
      if(batch.record.state!=='open'||item.phase!=='waiting'||signal.aborted)return;
      this.setItem(batch,item,{phase:'judging'});
      const judgement=await this.judgeWithin(path,signal,batch.session??={stalledDrives:new Set()});
      // 待つ間に取り消し・再起動の読み直しで変わりうる（型の絞り込みは await をまたがない）
      if(batch.record.state!=='open'||(item.phase as ImportItemPhase)!=='judging')return;
      if(judgement?.slow&&judgement.seconds!==undefined){
        this.setItem(batch,item,{phase:'awaiting-decision',judged:true,source:path,...(expectedFingerprint?{expected:expectedFingerprint}:{}),
          slow:{sizeBytes:judgement.sizeBytes,seconds:Math.ceil(judgement.seconds),...(judgement.volumeUuid?{volume:judgement.volumeUuid}:{}),
            ...(judgement.bytesPerSecond&&Number.isFinite(judgement.bytesPerSecond)?{bytesPerSecond:judgement.bytesPerSecond}:{})}});
        this.registerJudged(batch);return;
      }
      this.setItem(batch,item,{phase:'waiting',judged:true});(batch.judged??=[]).push({item,path,resolvedSource,...(expectedFingerprint?{expectedFingerprint}:{})});this.registerJudged(batch);
    }).catch(error=>{console.error('[sme] 取り込みの判定を記録できません:',error);});
    this.judging.set(key,task);batch.pending.add(task);
    void task.finally(()=>{batch.pending.delete(task);if(this.judging.get(key)===task)this.judging.delete(key);});
  }
  /** 受け渡し済みの項目の判定が終わった（判定前・判定中が無い）ら、判定を終えて待っていた項目を受付順に登録へ並べる。 */
  private registerJudged(batch:Batch):void{
    if(!batch.judged?.length||judgingDelivered(batch))return;
    const ready=batch.judged;batch.judged=[];for(const entry of ready)this.enqueuePrepare(batch,entry.item,entry.path,entry.resolvedSource,entry.expectedFingerprint);
  }
  /** 判定を取り消し（束の取り消し）と上限の時計と競わせる。判定が合図を聞かずに戻らなくても、上限で諦めて次へ進む（止まった判定を待ち続けない）。 */
  private async judgeWithin(path:string,batchSignal:AbortSignal,session:JudgeSession):Promise<SlowJudgement|undefined>{
    const controller=new AbortController(),stop=()=>controller.abort(batchSignal.reason);batchSignal.addEventListener('abort',stop,{once:true});
    const timer=setTimeout(()=>controller.abort(Object.assign(new Error('照合時間の見込みの判定が時間内に終わりません'),{code:'ETIMEDOUT'})),this.judgeLimitMs);timer.unref?.();
    try{
      return await new Promise<SlowJudgement>((resolve,reject)=>{
        controller.signal.addEventListener('abort',()=>reject(controller.signal.reason),{once:true});
        this.judge(path,controller.signal,session).then(resolve,reject);
      });
    }catch(error){
      // 元の素材が無い・読めないは登録が理由を出すので、ここでは静かに進む
      const code=(error as {code?:unknown}|null)?.code;
      if(!batchSignal.aborted&&code!=='ENOENT'&&code!=='ENOTDIR')console.warn('[sme] 照合時間の見込みを測れません（そのまま登録します）:',error instanceof Error?error.message:error);
      return undefined;
    }finally{clearTimeout(timer);batchSignal.removeEventListener('abort',stop);}
  }
  /** 項目の段と付帯情報を変えて記録する（書けなくても止めない。save と同じ）。値が undefined の項目は消す。 */
  private setItem(batch:Batch,item:ItemRecord,patch:Partial<ItemRecord>):void{patchItem(item,patch);this.save(batch,'[sme] 取り込みの段を記録できません:');}
  /**
   * 「この接続先では今後出さない」を、登録された素材 ID へ引き継ぐ（設計 §2）。接続先は開いた時の案内が比べる台帳の接続先（実パス）にする:
   * 受付で実パスへ解決した場所（判定した場所）と同じなら判定の時のドライブの識別で、同じ指紋の既存の登録が別の場所につながっていれば（既存の登録は元の接続先を保つ）その接続先を読み直して残す。
   * 書けなくても取り込みは止めない。
   */
  private rememberConnection(batch:Batch,held:{source?:string;volume?:string},asset:SequenceAsset):void{
    const {source,volume}=held;if(!source||!volume)return;
    void (async()=>{
      const target=isSequenceReferenceFile(asset.file)?await referenceTarget(batch.root,asset.file).catch(()=>undefined):undefined;
      const connection=target===undefined||target===source?{target:source,volume}:await connectionOf(copyIo(),target);
      if(connection)await suppressSlowMediaAdvice(batch.root,asset.id,connection);
    })().catch(error=>console.warn('[sme] 「この接続先では今後出さない」を記録できません:',error instanceof Error?error.message:error));
  }
  /** この束の追加時のコピーを止める（作業の案件の鍵は OS の実パスの解決。窓口・通知と同じ鍵）。 */
  private stopCopies(batch:Batch):void{
    try{this.copies.cancelBatch(copyJobsRoot(batch.root),batch.record.batchId);}catch(error){console.error('[sme] 取り込みのコピーを止められません:',error);}
  }
  private async prepare(batch:Batch,item:ItemRecord,path:string,resolvedSource:boolean,expectedFingerprint?:string):Promise<void>{
    const signal=batch.controller.signal;
    const set=(patch:Partial<ItemRecord>)=>{if(batch.record.state!=='open'||!ACTIVE.includes(item.phase))return;patchItem(item,patch);this.save(batch,'[sme] 取り込みの段を記録できません:');};
    // 判断で「この接続先では今後出さない」を選んだ項目は、登録した素材 ID へ引き継ぐ（判定の時の実パスとドライブの識別）。終わった項目は実パス・期待する指紋を残さない
    const held=item.choice==='keep-always'?{source:item.source,volume:item.slow?.volume}:undefined,settled={source:undefined,expected:undefined};
    // 準備済みにできた時だけ引き継ぐ（その間に取り消した束の素材は覚えない）
    const ready=(patch:Partial<ItemRecord>,asset:SequenceAsset)=>{set({...patch,phase:'ready',assetId:asset.id,...settled});if(held&&item.phase==='ready')this.rememberConnection(batch,held,asset);};
    if(signal.aborted)return;
    set({phase:'probing'});
    try{
      // リンクの名前は実ファイル名（既存の /reference と同じ）。コピーは受け取った名前（一時ファイルの名前は意味を持たない）。
      const asset=await this.prepareAsset({directory:batch.root,mode:batch.record.mode,path,name:batch.record.mode==='link'?basename(path):item.name,...(expectedFingerprint?{expectedFingerprint}:{}),resolvedSource,signal,hooks:{
        onPhase:phase=>set({phase}),onProbed:streams=>{const video=streams.find(s=>s.kind==='video');if(video)set({durationSeconds:timeNumber(video.duration)});}}});
      const video=asset.kind==='media'?asset.streams.find(s=>s.kind==='video'):undefined;
      // 映像の無い動画ファイル（音声だけの .mp4 など）はメインに並べない。確定の時に素材の一覧へ登録だけする（同じ1回の編集）。
      if(!video&&asset.kind==='media'&&asset.streams.some(s=>s.kind==='audio')){ready({audioOnly:true},asset);return;}
      if(!video)throw new Error('映像のある動画ではありません');
      ready({durationSeconds:timeNumber(video.duration)},asset);
    }catch(error){
      if(signal.aborted)return;
      set({phase:'failed',error:stored(error instanceof Error?error.message:String(error)),...settled});
    }
  }
  private prune(root:string):void{
    const finished=this.list(root).filter(batch=>batch.phase==='confirmed'||batch.phase==='cancelled').reverse().slice(RETAIN);
    for(const batch of finished){rmSync(join(folder(root),`${batch.batchId}.json`),{force:true});this.batches.delete(this.key(root,batch.batchId));}
  }
  create(directory:string,input:CreateImportBatchInput):ImportBatchView{
    const root=realpathSync(directory);
    if(!REQUEST_ID.test(input.requestId))throw new HttpError(400,'取り込みの要求IDが不正です');
    if(input.mode!=='link'&&input.mode!=='copy')throw new HttpError(400,'取り込み方が不正です');
    if(!Array.isArray(input.items)||!input.items.length||input.items.length>MAX_IMPORT_BATCH_ITEMS)throw new HttpError(400,`動画は1〜${MAX_IMPORT_BATCH_ITEMS}本で指定してください`);
    const items=input.items.map(item=>{
      if(item.source?.kind!=='client'&&!(item.source?.kind==='path'&&typeof item.source.path==='string'&&item.source.path))throw new HttpError(400,'取り込みの項目指定が不正です');
      // 場所が分かっている素材は実ファイル名で名付ける（画面から来た名前は使わない。既存の /reference と同じ）。
      const name=basename((item.source.kind==='path'?item.source.path:String(item.name)).replaceAll('\\','/')).normalize('NFC').trim();
      if(name.length>MAX_IMPORT_NAME_LENGTH)throw new HttpError(400,`素材名は${MAX_IMPORT_NAME_LENGTH}文字以内にしてください`);
      if(!name||name.startsWith('.')||createMediaKind(name)!=='video')throw new HttpError(400,`「${name||'名前なし'}」は動画として取り込めません`);
      if(typeof item.key!=='string'||!item.key||item.key.length>64)throw new HttpError(400,'取り込みの項目指定が不正です');
      return {...item,name};
    });
    if(input.requestKey!==undefined&&!REQUEST_KEY.test(input.requestKey))throw new HttpError(400,'取り込みの要求の鍵が不正です');
    const requestKey=input.requestKey??createHash('sha256').update(JSON.stringify([input.projectId,input.origin,input.mode,items.map(item=>[item.key,item.name,item.source])])).digest('hex');
    const existing=this.findBatchByRequest(root,input.requestId),durable=input.origin.kind==='agent';
    if(existing){if(existing.record.requestKey!==requestKey)throw new HttpError(409,'同じ要求IDに異なる取り込みがあります',{reason:IMPORT_REASON.requestConflict});return view(existing.record);}
    if(durable)assertNotIndexed(root,input.requestId,requestKey);
    const ordered=orderByName(items,item=>item.name),batchId=`imp-${randomUUID().replaceAll('-','').slice(0,20)}`;
    const record:BatchRecord={version:1,batchId,projectId:input.projectId,createdAt:new Date().toISOString(),requestId:input.requestId,requestKey,origin:structuredClone(input.origin),
      mode:input.mode,placement:'append-main',state:'open',items:ordered.map((item,index)=>({itemId:`i${index}`,key:item.key,name:item.name,phase:'waiting'}))};
    // 読み直しで弾かれる記録は作らない（読む時と同じ形で確かめる）。
    if(!recordSchema.safeParse(record).success)throw new HttpError(400,'取り込みの指定が不正です');
    const batch:Batch={root,record,controller:new AbortController(),pending:new Set(),delivered:new Set()};
    writeRecord(root,record);
    // AI の操作は索引にも書く（書けなければ束を作らない）。
    if(durable)try{writeJson(root,OPERATIONS,{version:1,operations:{...readOperations(root),[input.requestId]:{batchId,requestKey}}});}
    catch(error){try{rmSync(join(folder(root),`${batchId}.json`),{force:true});}catch{/* 元のエラーを返す */}throw error;}
    this.batches.set(this.key(root,batchId),batch);
    // 準備の受け渡しを先に済ませる（後始末の失敗で束を「準備中」のまま固めない）。受付時に実パス（ディスク上の形）へ解決した場所なので、準備で読む前後に今も同じ実パスかを確かめ直す。
    ordered.forEach((item,index)=>{if(item.source.kind==='path')this.schedule(batch,record.items[index]!,item.source.path,true);});
    try{this.prune(root);}catch(error){console.error('[sme] 古い取り込みの記録を片付けられません:',error);}
    this.notify(root);
    return view(record);
  }
  private findBatchByRequest(root:string,requestId:string):Batch|undefined{
    return this.list(root).map(batch=>this.load(root,batch.batchId)!).find(batch=>batch.record.requestId===requestId);
  }
  /**
   * AI の操作の照会。requestKey を渡すと、同じ要求IDで中身の違う束を衝突として断る（create と同じ 409）。
   * 束の記録が整理済みでも索引に残る操作は「完了済み」として断る（新しい束を作らせない）。
   */
  findByRequest(directory:string,requestId:string,requestKey?:string):ImportBatchView|undefined{
    const root=realpathSync(directory),batch=this.findBatchByRequest(root,requestId);
    if(!batch){assertNotIndexed(root,requestId,requestKey);return undefined;}
    if(requestKey!==undefined&&batch.record.requestKey!==requestKey)throw new HttpError(409,'同じ要求IDに異なる取り込みがあります',{reason:IMPORT_REASON.requestConflict});
    return view(batch.record);
  }
  private waiting(directory:string,batchId:string,itemId:string,mode:'link'|'copy'):{batch:Batch;item:ItemRecord}{
    const batch=this.require(directory,batchId),item=this.item(batch,itemId);
    if(batch.record.state!=='open')throw new HttpError(409,'この取り込みは受け付けを終えています',{reason:IMPORT_REASON.closed});
    if(batch.record.mode!==mode)throw new HttpError(400,'取り込み方が束と一致しません');
    if(item.phase!=='waiting'||batch.delivered.has(itemId))throw new HttpError(409,'この素材は受け付け済みです',{reason:IMPORT_REASON.delivered});
    return {batch,item};
  }
  /** 受け渡しを受け付けられるかだけを確かめる（アップロードの本文を受け取る前に断るため）。 */
  assertDeliverable(directory:string,batchId:string,itemId:string,mode:'link'|'copy'):void{this.waiting(directory,batchId,itemId,mode);}
  /** 画面がリンクで渡す素材（パスは呼び出し側が許可確認済み）。登録の名前は実ファイル名。 */
  deliverPath(directory:string,batchId:string,itemId:string,path:string,expectedFingerprint?:string):ImportBatchView{
    const {batch,item}=this.waiting(directory,batchId,itemId,'link');
    if(createMediaKind(basename(path))!=='video')throw new HttpError(400,`「${basename(path)}」は動画として取り込めません`);
    this.schedule(batch,item,path,true,expectedFingerprint);return view(batch.record);
  }
  /** 画面がコピーで渡した素材（受信済みの一時ファイル）。準備が終わったら一時ファイルを消す。 */
  deliverFile(directory:string,batchId:string,itemId:string,file:{path:string;cleanup():Promise<void>}):ImportBatchView{
    let target:{batch:Batch;item:ItemRecord};
    try{target=this.waiting(directory,batchId,itemId,'copy');}catch(error){void file.cleanup().catch(()=>undefined);throw error;}
    this.schedule(target.batch,target.item,file.path,false,undefined,file.cleanup);return view(target.batch.record);
  }
  /**
   * 画面が送れなかった（送るのをやめた）素材を失敗にする（設計 §1: 途中で失敗した素材は枠に理由を出し、残りは確定できる）。
   * 受け渡し待ちの素材だけを変える（受け渡し済み・準備の済んだ素材はそのまま）。受け付けを終えた束（取り消し・確定）は変えずに返す。
   */
  abandon(directory:string,batchId:string,itemIds:readonly string[]):ImportBatchView{
    const batch=this.require(directory,batchId),targets=itemIds.map(itemId=>this.item(batch,itemId))
      .filter(item=>item.phase==='waiting'&&!batch.delivered.has(item.itemId)).map(item=>item.itemId);
    // 未受け渡しの項目は登録を待たせない（judgingDelivered）ので、ここで登録を並べ直す必要はない。判断の案内はこの時点で出せるようになる
    if(batch.record.state==='open'&&targets.length)this.commit(batch,next=>{for(const item of next.items)if(targets.includes(item.itemId)){item.phase='failed';item.error=UNDELIVERED;}});
    return view(batch.record);
  }
  /** 案件の束を作成順に返す。読めない記録は飛ばす（1件の破損で案件の取り込み全体を止めない。その束は照会で失敗を返す）。 */
  list(directory:string):ImportBatchView[]{
    const root=realpathSync(directory),path=folder(root);if(!existsSync(path))return [];
    const views:ImportBatchView[]=[],names=readdirSync(path);
    // 残った一時ファイル（推測できない名前なので誰も上書きしない）を片付ける。記録（.json）と書き込み中の新しいものは消さない。
    for(const name of names.filter(entry=>TEMPORARY.test(entry))){
      try{const info=entry(join(path,name));if(info&&!info.isDirectory()&&Date.now()-info.mtimeMs>STALE_TEMPORARY_MS)rmSync(join(path,name),{force:true});}
      catch(error){console.error('[sme] 取り込みの一時ファイルを片付けられません:',name,error);}
    }
    for(const name of names.filter(entry=>/^imp-[a-f0-9]{20}\.json$/.test(entry))){
      try{const batch=this.load(root,name.slice(0,-5));if(batch)views.push(view(batch.record));}
      catch(error){console.error('[sme] 取り込みの記録を読み取れません:',name,error);}
    }
    return views.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.batchId.localeCompare(b.batchId));
  }
  get(directory:string,batchId:string):ImportBatchView{return view(this.require(directory,batchId).record);}
  cancel(directory:string,batchId:string):ImportBatchView{
    const batch=this.require(directory,batchId),record=batch.record;
    if(record.state==='confirming')throw new HttpError(409,'配置中のため取り消せません。配置後は元に戻すで戻せます',{reason:IMPORT_REASON.confirming});
    if(record.state==='confirmed')throw new HttpError(409,'配置済みの取り込みです。元に戻すで戻してください',{reason:IMPORT_REASON.confirmed});
    if(record.state==='open'){
      // 判断待ち・コピー中の項目も取り消す（覚えていた実パス・期待する指紋は残さない）
      this.commit(batch,next=>{next.state='cancelled';
        for(const item of next.items)if(ACTIVE.includes(item.phase)||item.phase==='awaiting-decision'){item.phase='cancelled';delete item.source;delete item.expected;}});
      // 判定・登録を止め、追加時のコピーも止める（完了分はつないだまま残る。束には並べない）
      batch.controller.abort(new Error('取り込みを取り消しました'));if(record.items.some(item=>item.choice==='copy'))this.stopCopies(batch);
    }
    return view(record);
  }
  /**
   * 全件準備後の1回の編集（設計 §1）。置き方の意図（メインの末尾に順に）は確定時点の文書で評価し直す。確定済み・取り消し済みは置かない。
   * 配置中に届いた同じ確定の再送（応答が届かなかった時。セッション・実行 ID・失敗分の扱いが同じ）は、その配置の結果を受け取る（「配置しています」で断らない）。
   * 違う確定は今まで通り「配置しています」で断る。失敗した配置は外し、同じ確定の再送は新しく実行する。
   */
  async confirm(directory:string,batchId:string,request:{sessionId:string;executionId:string;skipFailed?:boolean},sessions:SequenceService):Promise<ConfirmResult>{
    const batch=this.require(directory,batchId),record=batch.record,key=JSON.stringify([request.sessionId,request.executionId,request.skipFailed===true]);
    if(record.state==='confirmed'){
      if(record.confirmed?.executionId===request.executionId){const state=sessions.open(directory);return {...state,executionId:request.executionId,appliedRevision:record.confirmed.revision,changed:false,replayed:true};}
      throw new HttpError(409,'この取り込みは配置済みです。元に戻した取り込みは再配置しません',{reason:IMPORT_REASON.confirmed});
    }
    if(record.state==='cancelled')throw new HttpError(409,'取り消した取り込みは配置しません',{reason:IMPORT_REASON.cancelled});
    if(record.state==='confirming'){if(batch.confirming?.key===key)return batch.confirming.work;throw new HttpError(409,'この取り込みを配置しています',{reason:IMPORT_REASON.confirming});}
    const phase=importBatchPhase(record.state,record.items);
    if(phase==='preparing')throw new HttpError(409,'まだ準備中の動画があります',{reason:IMPORT_REASON.notReady});
    if(phase==='deciding')throw new HttpError(409,'判断を待っている動画があります。コピーするか、このまま使うかを選んでください',{reason:IMPORT_REASON.deciding});
    if(phase==='failed'||(phase==='partial'&&!request.skipFailed))throw new HttpError(409,'準備できなかった動画があります。失敗分を除いて並べるか、取り消してください',{reason:IMPORT_REASON.partial});
    // 確定を試みるたびに前の拒否理由を消す（この試みが再試行しても通らない理由で断られた時だけ、下で記録し直す）。
    this.commit(batch,next=>{next.state='confirming';delete next.refusal;});
    const confirming={key,work:this.place(directory,batch,request,sessions)},done=()=>{if(batch.confirming===confirming)delete batch.confirming;};
    batch.confirming=confirming;void confirming.work.then(done,done);
    return confirming.work;
  }
  /** confirm の配置（状態を confirming にした後）。置けなかった時は open に戻して投げる。 */
  private async place(directory:string,batch:Batch,request:{sessionId:string;executionId:string},sessions:SequenceService):Promise<ConfirmResult>{
    const record=batch.record,batchId=record.batchId;
    try{
      // 並べる動画と、登録だけする映像の無い素材（audioOnly）。
      const assets:SequenceAsset[]=[],registerOnly:SequenceAsset[]=[];
      for(const item of record.items.filter(entry=>entry.phase==='ready')){
        const asset=await this.resolveAsset(batch.root,item.assetId!);
        if(!asset)throw new HttpError(409,`「${item.name}」の取り込み記録が見つかりません。取り消して、もう一度追加してください`,{reason:IMPORT_REASON.assetMissing});(item.audioOnly?registerOnly:assets).push(asset);
      }
      // 素材の確認（await）の後の最新の文書で組み立てる。ここから実行まで同期（素材行の追加と同じ流儀）。
      const current=sessions.open(directory);
      // 古いタブのセッションは、確定の印を書く前に断る（印の後に実行で断られ、戻しの書き込みも失敗すると「確定済み」が残るため）。
      if(current.sessionId!==request.sessionId)throw new HttpError(409,'編集セッションが変わりました。保存済みの内容を読み直してください',{reason:'REVISION_CONFLICT'});
      if(current.document.clips.some(clip=>clip.id.startsWith(`${batchId}-`))){
        this.commit(batch,next=>{next.state='confirmed';next.confirmed={executionId:request.executionId,revision:current.document.revision};});
        return {...current,executionId:request.executionId,appliedRevision:current.document.revision,changed:false,replayed:true};
      }
      // 確定の印を置く前に書く（書けなければ置かない）。置いた後で印を書けず、再起動後にもう一度置ける状態を作らない。
      const revision=current.document.revision+1,mark=()=>this.commit(batch,next=>{next.state='confirmed';next.confirmed={executionId:request.executionId,revision};});let n=0;
      let result:ReturnType<typeof executeAppendToMain>;
      if(assets.length)result=executeAppendToMain(directory,sessions,current,request,assets,()=>`${batchId}-${++n}`,mark,registerOnly);
      else{
        // 映像の無い素材だけの束: メインには並べず、一覧に無い素材だけを登録する（全部登録済みなら編集しない）。
        const missing=[...new Map(registerOnly.filter(asset=>!current.document.assets.some(item=>item.id===asset.id)).map(asset=>[asset.id,asset])).values()];
        if(!missing.length){
          this.commit(batch,next=>{next.state='confirmed';next.confirmed={executionId:request.executionId,revision:current.document.revision};});
          return {...current,executionId:request.executionId,appliedRevision:current.document.revision,changed:false,replayed:false};
        }
        mark();
        result=sessions.execute(directory,{sessionId:request.sessionId,expectedRevision:current.document.revision,executionId:request.executionId,command:{type:'register-assets',assets:missing.map(asset=>structuredClone(asset))}});
      }
      if(result.appliedRevision!==revision){
        try{this.commit(batch,next=>{next.confirmed={executionId:request.executionId,revision:result.appliedRevision};});}
        catch(error){console.error('[sme] 取り込みの確定記録を更新できません:',error);}
      }
      return result;
    }catch(error){
      // ここに来るのは置いていない時だけ（実行は同期で、成功すれば上で返る）。open に戻す。戻す記録を書けなくても元のエラーを返す。
      // 再試行しても通らない拒否（速度登録済みなど）は理由を残す（AI が照会で読む）。一時的な失敗では残さない。
      const refusal=permanentRefusal(error),revert=(next:BatchRecord)=>{next.state='open';delete next.confirmed;if(refusal)next.refusal=refusal;};
      try{this.commit(batch,revert);}
      catch(failure){console.error('[sme] 取り込みの状態を戻せません:',failure);revert(record);this.notify(batch.root);}
      throw error;
    }
  }
  /** 判断待ちの項目（全項目の判定が終わってから）。無ければ 409。 */
  private decisionTargets(batch:Batch):ItemRecord[]{
    const targets=batch.record.items.filter(item=>item.phase==='awaiting-decision'&&item.source);
    if(!targets.length)throw new HttpError(409,'判断を待っている動画がありません',{reason:IMPORT_REASON.noDecision});
    if(judging(batch.record.items))throw new HttpError(409,'まだ読み取りの速さを確認中の動画があります。確認が終わってから選んでください',{reason:IMPORT_REASON.notReady});
    return targets;
  }
  /** 判断待ちの項目のコピーの元（コピー先の候補と開始時の確認に使う）。速さは最も遅いもの。 */
  copyInput(directory:string,batchId:string):Pick<DestinationInput,'sources'|'sourceBytesPerSecond'>{
    const batch=this.require(directory,batchId);
    if(batch.record.state!=='open')throw new HttpError(409,'この取り込みは受け付けを終えています',{reason:IMPORT_REASON.closed});
    const targets=this.decisionTargets(batch),speeds=targets.flatMap(item=>item.slow?.bytesPerSecond?[item.slow.bytesPerSecond]:[]);
    return {sources:targets.map(item=>({path:item.source!,sizeBytes:item.slow?.sizeBytes??0})),...(speeds.length?{sourceBytesPerSecond:Math.min(...speeds)}:{})};
  }
  /**
   * 判断待ちの扱いを決める（設計 §2）。全項目の判定が終わってから（案内は1回）。
   * copy: 判断待ちの項目をコピーの作業へ渡し、結果（登録・失敗・残りを中止）を受け取る。始められなければ判断待ちに戻して理由を返す。
   * keep-once／keep-always: 覚えておいた場所からそのまま登録する（keep-always は登録後に素材 ID と接続先で「今後出さない」を残す。ドライブを識別できない項目は keep-once と同じ）。
   */
  async decide(directory:string,batchId:string,decision:{choice:ImportDecisionChoice;projectId:string;destination?:ChosenDestination}):Promise<ImportBatchView>{
    const batch=this.require(directory,batchId);
    if(batch.record.state!=='open')throw new HttpError(409,'この取り込みは受け付けを終えています',{reason:IMPORT_REASON.closed});
    const targets=this.decisionTargets(batch),ids=new Set(targets.map(item=>item.itemId));
    if(decision.choice==='copy'){
      if(!decision.destination)throw new HttpError(400,'コピー先を選んでください');
      this.commit(batch,next=>{for(const item of next.items)if(ids.has(item.itemId)){item.phase='copying';item.choice='copy';}});
      try{
        await this.copies.startAdd({root:copyJobsRoot(batch.root),projectId:decision.projectId,destination:decision.destination,callbacks:this.copyCallbacks(batch),
          items:targets.map(item=>({batchId,batchItemId:item.itemId,source:item.source!,name:item.name,...(item.expected?{expectedFingerprint:item.expected}:{})}))});
      }catch(error){
        // 始められなかった: もう一度判断を求める（その間に取り消した項目は戻さない）。戻す記録を書けなくてもメモリは戻す（コピー中のまま止めない）
        const back=(record:BatchRecord)=>{for(const item of record.items)if(ids.has(item.itemId)&&item.phase==='copying'){item.phase='awaiting-decision';delete item.choice;}};
        try{this.commit(batch,back);}catch(failure){console.error('[sme] 取り込みの判断を戻せません:',failure);back(batch.record);this.notify(batch.root);}
        throw error;
      }
      // 始める間に束を取り消した: 取り消しの時にはまだ作業が無かったので、作業ができた今止める
      if((batch.record.state as ImportBatchState)==='cancelled')this.stopCopies(batch);
      return view(batch.record);
    }
    this.commit(batch,next=>{for(const item of next.items)if(ids.has(item.itemId)){item.phase='waiting';item.choice=decision.choice==='keep-always'&&item.slow?.volume?'keep-always':'keep-once';}});
    for(const item of targets)this.enqueuePrepare(batch,item,item.source!,true,item.expected);
    return view(batch.record);
  }
  /** 追加時のコピーの結果を束へ（メモリだけ。再起動後はコピー中の項目が判断待ちに戻る）。取り消した束・コピー中でない項目は変えない。 */
  private copyCallbacks(batch:Batch):AddCallbacks{
    const copying=(itemId:string)=>{const item=batch.record.items.find(entry=>entry.itemId===itemId);return batch.record.state==='open'&&item?.phase==='copying'?item:undefined;};
    return {
      done:(itemId,asset)=>{
        const item=copying(itemId);if(!item)return;
        // コピーした中身が画面で選んだ素材（期待する指紋）と違えば並べない（コピーまでの間に元が変わった）
        if(item.expected&&asset.fingerprint!==item.expected){this.setItem(batch,item,{phase:'failed',error:FINGERPRINT_MISMATCH,source:undefined,expected:undefined});return;}
        const video=asset.kind==='media'?asset.streams.find(stream=>stream.kind==='video'):undefined,audio=asset.kind==='media'&&asset.streams.some(stream=>stream.kind==='audio');
        this.setItem(batch,item,video?{phase:'ready',assetId:asset.id,durationSeconds:timeNumber(video.duration),source:undefined,expected:undefined}
          :audio?{phase:'ready',assetId:asset.id,audioOnly:true,source:undefined,expected:undefined}:{phase:'failed',error:'映像のある動画ではありません',source:undefined,expected:undefined});
      },
      failed:(itemId,message)=>{const item=copying(itemId);if(item)this.setItem(batch,item,{phase:'failed',error:stored(message),source:undefined,expected:undefined});},
      // 残りを中止・コピーの作業の停止: 未完了の項目はもう一度判断を求める（コピーの元は覚えたまま）
      stopped:itemIds=>{for(const itemId of itemIds){const item=copying(itemId);if(item)this.setItem(batch,item,{phase:'awaiting-decision',choice:undefined});}},
    };
  }
  subscribe(directory:string,listener:()=>void):()=>void{
    const root=realpathSync(directory),listeners=this.listeners.get(root)??new Set<()=>void>();
    listeners.add(listener);this.listeners.set(root,listeners);
    return ()=>{listeners.delete(listener);if(!listeners.size)this.listeners.delete(root);};
  }
  /** 試験と監査用: この束の準備が全部終わるまで待つ。 */
  async idle(directory:string,batchId:string):Promise<void>{
    const batch=this.require(directory,batchId);while(batch.pending.size)await Promise.allSettled([...batch.pending]);
  }
}
export const importBatches=new ImportBatches();
