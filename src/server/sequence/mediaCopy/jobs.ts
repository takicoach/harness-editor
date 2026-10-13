import {realpathSync} from 'node:fs';
import {basename} from 'node:path';
import {HttpError} from '../../http';
import type {SequenceAsset} from '../../../core/sequence/model';
import {COPY_CANCEL_NOTE,MAX_COPY_ITEMS,type CopyItemPhase,type CopyJobView} from '../../../shared/mediaCopy';
import {copyIo,copyIoTesting,isSimulatedCrash,type CopyIo} from './io';
import {CopyFolderError,assertCopyFolder,ensureCopyFolder,type CopyFolder} from './volumes';
import {SpaceMonitor,SpaceStopError,evaluateSpace,measureSpace,spaceReservations,type Reservation,type SpaceReservations} from './space';
import {copyOneItem,removeOwnedCopyFiles,type CopiedFile} from './copyItem';
import type {ChosenDestination} from './destinations';
import {CopyJobRecordInvalidError,LedgerUnreadableError,copyJobsFolderIdentity,ledgerConnects,newCopyJobId,pruneCopyJobRecords,readCopyJobRecords,writeCopyJobRecord,type CopyJobItemRecord,type CopyJobRecord,type LedgerPorts} from './jobRecord';
import {ownedByThisProcess,ownsFiles,recoverCopyJobs,recoveryHeldElsewhere} from './recovery';
import {ReferenceConnectUnknown,claimReferenceCopies,reconnectSequenceReferenceVerified,referenceConnection,referenceTarget,registerSequenceReferenceVerified,registeredSequenceReferences,
  type ReferenceCopyClaim,type VerifiedCopy} from '../references';

/** 参照台帳への出入口（試験で差し替える）。 */
export interface CopyPorts extends LedgerPorts {
  /** 作業の残り全項目の元の読み取りを一度に予約する（Task 9）。signal で待ちを取り消せる（中止なら予約は残らない）。 */
  claim(items:readonly {path:string;dev:number}[],signal:AbortSignal):Promise<Map<string,ReferenceCopyClaim>>;
  connection(root:string,asset:SequenceAsset):Promise<{generation:string;target:string}>;
  reconnect(root:string,asset:SequenceAsset,copy:VerifiedCopy,generation:string):Promise<void>;
  register(root:string,copy:VerifiedCopy,name:string):Promise<{asset:SequenceAsset;branch:'registered'|'reconnected'}>;
}
export const referenceCopyPorts:CopyPorts={claim:claimReferenceCopies,connection:referenceConnection,reconnect:reconnectSequenceReferenceVerified,
  register:(root,copy,name)=>registerSequenceReferenceVerified(root,copy,name),target:referenceTarget,references:registeredSequenceReferences};
/** expectedFingerprint: 画面で選んだ素材の指紋（受け渡しの時に分かっていれば）。コピー中に読んだ中身と違えば、その1本を止めて登録しない。 */
export interface AddItemInput {batchId:string;batchItemId:string;source:string;name:string;expectedFingerprint?:string}
/**
 * 追加時のコピーの結果を取り込みの束へ返す（メモリだけ。再起動後は束が判断待ちに戻る）。stopped: 残りを中止・作業の停止で終わらなかった項目と、
 * 接続の結果を確かめられなかった項目（結果不明で台帳を読めない。実際にはつながっている可能性があるので、束では失敗にせず判断待ちに戻す）。
 */
export interface AddCallbacks {done(batchItemId:string,asset:SequenceAsset):void;failed(batchItemId:string,message:string):void;stopped(batchItemIds:string[]):void}
/** destination は開始時の確認（resolveCopyDestination）を通したもの。追加時の source は受付で解決済みの実パス（copyOneItem は違えば何も作らずに断る）。 */
export interface StartCommon {root:string;projectId:string;destination:ChosenDestination}
/** volumeLost: 片付けの時にコピー先を確かめられなかった（取り外し）。記録に残した実体は再接続後に回収する（Task 11）。 */
interface Job {record:CopyJobRecord;root:string;folder:CopyFolder;assets:Map<string,SequenceAsset>;callbacks?:AddCallbacks;controller:AbortController;stopRequested?:string;
  reservation:Reservation;progress:Map<string,number>;current?:{itemId:string;startedAt:number;bytes:number};volumeLost?:boolean}
/**
 * これらは作業全体を止める（空き・媒体の取り外し・書き込みの失敗・権限）。それ以外（元の変更・指紋の不一致・generation の競合・予約の差し替え）はその1本だけを失敗にする。
 * EACCES・EPERM: 一覧の段ではコピー先のフォルダー自体の書き込み権限を見ていない（Task 5）ので、開始後に予約・.part を作れない時はここで止める。
 * ENOENT・EBADF は作業中の取り外し（元またはコピー先）で起きうる。exFAT のコピー先を書き込み中に取り外すと、次の書き込みは EIO だった（Task 16 の実測）。
 */
const STOP_CODES=new Set(['ENOSPC','EDQUOT','EIO','ENXIO','ENODEV','EROFS','ENOENT','EBADF','EACCES','EPERM']);
const ENDED:readonly CopyItemPhase[]=['done','failed','cancelled'];
const NOTIFY_MS=500;
/** 回収をやり直す間隔（コピー先のドライブの接続を待つ作業・持ち主を確かめられずに飛ばした作業）。 */
const RETRY_MS=15_000;
const RECOVERING_ELSEWHERE='別のエディターがコピーの後片付けをしています。少し待ってからもう一度お試しください';
const text=(error:unknown)=>{const value=error instanceof Error?error.message:String(error);return value.length>1000?`${value.slice(0,1000)}…`:value;};
const codeOf=(error:unknown)=>(error as {code?:unknown}|null)?.code;
const DETACHED='元の媒体かコピー先のドライブが外れた可能性があります';
/** 画面に出す理由（errno は日本語の理由と code。errno の文言はパスを含むので出さない）。 */
const CODE_REASON:Record<string,string>={EACCES:'権限がないため読み書きできません。コピー先のフォルダーの書き込み権限を確かめてください',EPERM:'権限がないため読み書きできません。コピー先のフォルダーの書き込み権限を確かめてください',
  ENOSPC:'コピー先の空きが足りません',EDQUOT:'コピー先で使える容量の上限に達しました',EROFS:'コピー先が書き込めない状態です',
  EIO:`読み書きに失敗しました。${DETACHED}`,ENXIO:`読み書きに失敗しました。${DETACHED}`,ENODEV:`読み書きに失敗しました。${DETACHED}`,EBADF:`読み書きに失敗しました。${DETACHED}`,
  ENOENT:`ファイルまたはフォルダーが見つかりません。${DETACHED}`,
  // 元はリンクをたどらずに開く（READ_ONLY の O_NOFOLLOW）。予約・.part は排他作成なので、ELOOP になるのは元がリンクの時だけ
  ELOOP:'元の素材の場所が変わりました（リンクをたどらずに開けないため、コピーしません）'};
const SOURCE_REASON='元の素材を読めません。元の媒体の接続と権限を確かめてください';
/** 日本語を含まない本文（ライブラリの英文など）は画面に出さない（ログへ）。 */
const JAPANESE=/[\u3040-\u30ff\u3400-\u9fff]/;
/**
 * 画面に出す理由。errno の本文（英文と絶対パス）は出さず、日本語の理由と code だけにする。元のパスの errno は元の素材の理由にする（コピー先の権限と取り違えない）。
 * code の無いものは自分の文言（日本語）だけを出す。
 */
function reasonOf(error:unknown,source?:string):string{
  const code=codeOf(error);
  if(typeof code==='string'){
    if(source!==undefined&&(error as {path?:unknown}).path===source)return `${code==='ELOOP'?CODE_REASON.ELOOP:SOURCE_REASON}（${code}）`;
    return `${CODE_REASON[code]??'コピーに失敗しました'}（${code}）`;
  }
  const value=text(error);if(JAPANESE.test(value))return value;
  console.error('[sme] コピーの失敗（画面には決まった文言を出します）:',error);return 'コピーに失敗しました';
}
/** 案件のドライブの問題（続けても失敗する）。台帳の記録が無いだけ（ENOENT）はその1本だけを失敗にする。 */
const LEDGER_STOP=new Set(['EACCES','EPERM','EROFS','ENOSPC','EDQUOT','EIO','ENXIO','ENODEV']);
/** 参照台帳（案件の .harness/references）の読み書きの失敗。コピー先・元の errno と取り違えない（code を持たない）。 */
class LedgerStepError extends Error{
  readonly stopJob:boolean;
  constructor(code:string,cause:unknown){super(`案件の参照の記録を読み書きできません（${code}）`,{cause});this.name='LedgerStepError';this.stopJob=LEDGER_STOP.has(code);}
}
const inside=(path:string,folder:string)=>path===folder||path.startsWith(`${folder}/`);
/** 接続の段の errno: コピー先（受け渡したコピー）のパスならそのまま、それ以外は台帳の側の失敗にする。 */
const ledgerSide=(error:unknown,folder:string):unknown=>{
  const code=codeOf(error),path=(error as {path?:unknown}|null)?.path;
  return typeof code==='string'&&!(typeof path==='string'&&inside(path,folder))?new LedgerStepError(code,error):error;
};
/** 記録を書けない理由（本文は出さない。形の誤りは決まった文言）。 */
const recordFailure=(error:unknown)=>{
  if(error instanceof CopyJobRecordInvalidError)return 'コピーの記録の形が正しくないため止めました';
  const code=codeOf(error);return typeof code==='string'?`コピーの記録を書けないため止めました（${code}）`:'コピーの記録を書けないため止めました';
};
const UNRESOLVED='接続を変えた結果を確かめられないため、コピーしたファイルを残して止めました（参照台帳を読めません。次の起動で台帳と照合します）';
/** 結果不明で台帳も読めなかった（完成ファイルは消さない。作業全体を止める: 台帳が読めない間の接続の変更は続けても失敗する）。 */
class ConnectUnresolvedError extends Error{constructor(cause:unknown){super(UNRESOLVED,{cause});this.name='ConnectUnresolvedError';}}
/** 開始時の確認の失敗（コピー先のフォルダー・空き）は、作業を作らずに 409 で断る。 */
const refuse=(error:unknown):never=>{if(error instanceof CopyFolderError||error instanceof SpaceStopError)throw new HttpError(409,error.message,{cause:error});throw error;};
/** 取り込みの束への知らせ（束の側の失敗でコピーの作業を止めない）。 */
const tell=(action:()=>void)=>{try{action();}catch(error){console.error('[sme] 取り込みの束へコピーの結果を知らせられません:',error);}};

/** コピーの作業（設計 §5）。コピーは1本ずつ（全案件で1本）。案件を切り替えても続く（サーバの作業）。アプリの終了で止まり、次の起動で回収する。 */
export class MediaCopyJobs{
  private jobs=new Map<string,Job>();private chain:Promise<void>=Promise.resolve();private starting=new Map<string,Set<string>>();
  private listeners=new Map<string,Set<()=>void>>();private notified=new Map<string,number>();private pendingNotify=new Map<string,ReturnType<typeof setTimeout>>();
  /** 案件ごとの回収（直列に並べる）。retryRoots: 回収をやり直す案件（ドライブの接続を待つ作業・持ち主を確かめられずに飛ばした作業がある）。 */
  private recoveries=new Map<string,Promise<void>>();private retryRoots=new Set<string>();private retryTimer:ReturnType<typeof setTimeout>|undefined;private retryMs:number;
  /** options.retryMs は試験だけが縮める（既定 15 秒）。 */
  constructor(private io:()=>CopyIo=copyIo,private ports:CopyPorts=referenceCopyPorts,private reservations:SpaceReservations=spaceReservations,options:{retryMs?:number}={}){this.retryMs=options.retryMs??RETRY_MS;}
  /** 試験専用（製品の経路からは呼ばない）。 */
  setPortsForTests(ports:CopyPorts):void{this.ports=ports;}
  /** コピー中（作業が終わっていない・開始の受付中）の素材。 */
  activeAssetIds(root:string):Set<string>{
    const ids=new Set<string>(this.starting.get(root)??[]);
    for(const job of this.jobs.values())if(job.root===root&&job.record.state==='running')
      for(const item of job.record.items)if(item.target.kind==='reconnect'&&!ENDED.includes(item.phase))ids.add(item.target.assetId);
    return ids;
  }
  /** 開いた時のコピー: 各素材の generation と接続先を作業の開始時に読んで記録する。受付中の素材は同時に2つ目の作業を作らない。 */
  async startReconnect(input:StartCommon&{assets:SequenceAsset[]}):Promise<CopyJobView>{
    await this.recoverBeforeStart(input.root);
    if(!input.assets.length||input.assets.length>MAX_COPY_ITEMS)throw new HttpError(400,`コピーする素材を1〜${MAX_COPY_ITEMS}件で指定してください`);
    const ids=input.assets.map(asset=>asset.id),busy=this.activeAssetIds(input.root);
    if(new Set(ids).size!==ids.length)throw new HttpError(400,'同じ素材が重複しています');
    if(ids.some(id=>busy.has(id)))throw new HttpError(409,'コピー中の素材が含まれています');
    const starting=this.starting.get(input.root)??new Set<string>();this.starting.set(input.root,starting);for(const id of ids)starting.add(id);
    try{
      const io=this.io(),items:CopyJobItemRecord[]=[];
      for(const [index,asset] of input.assets.entries()){
        if(!asset.file.startsWith('.harness/references/'))throw new HttpError(400,`「${asset.name}」はリンク素材ではありません`);
        const {generation,target}=await this.ports.connection(input.root,asset),info=await this.sourceInfo(io,target,asset.name);
        items.push({itemId:`c${index}`,name:basename(target),sizeBytes:info.size,source:target,sourceDev:info.dev,phase:'waiting',
          target:{kind:'reconnect',assetId:asset.id,assetFile:asset.file,generation,expectedFingerprint:asset.fingerprint}});
      }
      return await this.begin(input,'reconnect',items,new Map(input.assets.map((asset,index)=>[`c${index}`,asset])));
    }finally{for(const id of ids)starting.delete(id);if(!starting.size&&this.starting.get(input.root)===starting)this.starting.delete(input.root);}
  }
  /** 追加時のコピー（判断待ちの束の項目）。 */
  async startAdd(input:StartCommon&{items:AddItemInput[];callbacks:AddCallbacks}):Promise<CopyJobView>{
    await this.recoverBeforeStart(input.root);
    if(!input.items.length||input.items.length>MAX_COPY_ITEMS)throw new HttpError(400,`コピーする動画を1〜${MAX_COPY_ITEMS}件で指定してください`);
    const io=this.io(),items:CopyJobItemRecord[]=[];
    for(const [index,item] of input.items.entries()){const info=await this.sourceInfo(io,item.source,item.name);
      items.push({itemId:`c${index}`,name:item.name,sizeBytes:info.size,source:item.source,sourceDev:info.dev,phase:'waiting',
        target:{kind:'add',batchId:item.batchId,batchItemId:item.batchItemId,...(item.expectedFingerprint?{expectedFingerprint:item.expectedFingerprint}:{})}});}
    return this.begin(input,'add',items,new Map(),input.callbacks);
  }
  private async sourceInfo(io:CopyIo,path:string,name:string){
    let info;try{info=await io.stat(path);}catch(error){if(isSimulatedCrash(error))throw error;throw new HttpError(409,`「${name}」の元の素材を確かめられません。ドライブの接続を確認してください`,{cause:error});}
    if(!info.isFile())throw new HttpError(409,`「${name}」の元の素材が通常のファイルではありません`);return info;
  }
  private async begin(input:StartCommon,mode:'reconnect'|'add',items:CopyJobItemRecord[],assets:Map<string,SequenceAsset>,callbacks?:AddCallbacks):Promise<CopyJobView>{
    const io=this.io(),{destination}=input,total=items.reduce((sum,item)=>sum+item.sizeBytes,0);
    const folder=await ensureCopyFolder(io,destination.volume,destination.base,destination.segments).catch(refuse);
    // 開始時の確認: アプリ内の予約を差し引いた空きで、もう一度安全余裕を確かめてから予約する（確かめてから予約するまでの間に await を挟まない）
    const measure=await measureSpace(io,folder.path).catch(refuse);
    const space=evaluateSpace(measure,this.reservations.reservedIn(destination.volume.spaceUnit),total);if(!space.selectable)throw new HttpError(409,space.reason!);
    const reservation=this.reservations.reserve(destination.volume.spaceUnit,total);
    const cannotStart=(error:unknown):never=>{reservation.release();if(isSimulatedCrash(error))throw error;throw new HttpError(500,recordFailure(error).replace('止めました','コピーを始められません'),{cause:error});};
    // 記録先の識別（案件フォルダーを複製・復元した先の記録を、回収が元の案件の記録と取り違えないため。Task 11）
    const recordFolder=(await copyJobsFolderIdentity(input.root,true).catch(cannotStart))!;
    const record:CopyJobRecord={format:'harness-copy-job',version:1,jobId:newCopyJobId(),owner:{pid:io.self.pid,startedAt:io.self.startedAt},recordFolder,createdAt:new Date(io.wallNow()).toISOString(),
      projectId:input.projectId,mode,margin:space.margin,
      destination:{kind:destination.kind,label:destination.label,volume:{uuid:destination.volume.uuid,dev:destination.volume.dev,mountPoint:destination.volume.mountPoint,spaceUnit:destination.volume.spaceUnit},
        folder:{path:folder.path,dev:folder.dev,ino:folder.ino}},
      state:'running',items};
    await writeCopyJobRecord(input.root,record).catch(cannotStart);
    const job:Job={record,root:input.root,folder,assets,...(callbacks?{callbacks}:{}),controller:new AbortController(),reservation,progress:new Map()};
    this.jobs.set(record.jobId,job);
    this.chain=this.chain.then(()=>this.run(job)).catch(error=>{if(!isSimulatedCrash(error))console.error('[sme] コピーの作業が止まりました:',error);});
    this.notify(input.root,true);return this.view(job);
  }
  /**
   * 作業の本体。元の読み取りの予約は残り全項目を一度に取り、各項目は接続を変え終えた時点で手放す（成功・失敗・中止・試験の強制終了のどれでも finally で残りを手放す）。
   * 作業全体の失敗（予約の失敗など）でも記録を running のまま残さない（残りを中止にして閉じる）。試験の強制終了だけは、プロセスが落ちたのと同じく片付けも記録もしない。
   */
  private async run(job:Job):Promise<void>{
    let claims=new Map<string,ReferenceCopyClaim>();
    const releaseClaims=()=>{for(const claim of claims.values())claim.release();};   // 2回目以降は何もしない
    try{
      try{
        // 監視の部品は try の中で作る（作る途中の例外でも finally で予約を解放する。Task 3 のレビューの申し送り）
        const io=this.io(),monitor=new SpaceMonitor(io,job.folder.path,job.reservation,this.reservations,job.record.margin);
        // 元の読み取りの調停（Task 9）: 待ち（同じ媒体の別ファイルの照合の読み終わり）は「残りを中止」で取り消せる（その時は下で全項目を中止にする）
        try{claims=await this.ports.claim(job.record.items.filter(item=>item.phase==='waiting').map(item=>({path:item.source,dev:item.sourceDev})),job.controller.signal);}
        catch(error){if(!job.controller.signal.aborted)throw error;}
        for(const item of job.record.items){
          if(item.phase!=='waiting')continue;
          if(job.stopRequested){claims.get(item.source)?.release();await this.update(job,item,{phase:'cancelled',error:job.stopRequested}).catch(()=>undefined);continue;}
          try{await this.copyItem(io,job,item,monitor,claims.get(item.source));}
          catch(error){
            if(isSimulatedCrash(error))throw error;   // 試験: プロセスが落ちたのと同じく、片付けも記録もしない
            const stop=error instanceof SpaceStopError||error instanceof CopyFolderError||error instanceof ConnectUnresolvedError||(error instanceof LedgerStepError&&error.stopJob)
              ||STOP_CODES.has(String(codeOf(error)??''))||!!(error as {recordFailed?:boolean}).recordFailed;
            await this.settleFailure(io,job,item,error,job.stopRequested?'cancelled':'failed');
            if(stop&&!job.stopRequested)job.stopRequested=`コピーを止めました: ${reasonOf(error,item.source)}`;
          }
        }
      }catch(error){
        if(isSimulatedCrash(error))throw error;
        console.error('[sme] コピーの作業を続けられません:',error);
        job.stopRequested??=`コピーを止めました: ${reasonOf(error)}`;
        for(const item of job.record.items)if(item.phase==='waiting'){item.phase='cancelled';item.error=job.stopRequested;}
      }
      releaseClaims();await this.finish(job);
    }finally{releaseClaims();job.reservation.release();job.current=undefined;}
  }
  private async copyItem(io:CopyIo,job:Job,item:CopyJobItemRecord,monitor:SpaceMonitor,claim?:ReferenceCopyClaim):Promise<void>{
    let copied:CopiedFile;
    try{
      await assertCopyFolder(io,job.folder,job.record.destination.volume);
      const remaining=()=>job.record.items.filter(other=>other!==item&&other.phase==='waiting').reduce((sum,other)=>sum+other.sizeBytes,0)+Math.max(0,item.sizeBytes-(job.progress.get(item.itemId)??0));
      await monitor.check(remaining());
      job.current={itemId:item.itemId,startedAt:io.now(),bytes:0};
      // 期待する指紋: 開いた時は素材の指紋、追加時は画面で選んだ素材の指紋（分かっていれば）。違えばコピー中に止める（理由の文言は出どころで分ける）
      const expectedFingerprint=item.target.expectedFingerprint;
      copied=await copyOneItem(io,{path:item.source,...(expectedFingerprint?{expectedFingerprint,expectedFrom:item.target.kind==='add'?'chosen':'registered'}:{})},{folder:job.folder,name:item.name},{
        // 元の識別情報（sourceIdentity）は記録しない（メモリの copied で足りる。元の ino は 2^53 を超えうる）
        signal:job.controller.signal,phase:(phase,patch)=>{const recorded={...patch};delete recorded.sourceIdentity;return this.update(job,item,{...recorded,phase});},
        progress:async bytes=>{if(job.current)job.current.bytes+=bytes;job.progress.set(item.itemId,(job.progress.get(item.itemId)??0)+bytes);this.notify(job.root);await monitor.wrote(bytes,remaining());}});
    }catch(error){claim?.release();throw error;}
    // 元を読み切って照合した組（既存の完成ファイルを再利用した時は無い）
    const read=copied.sourceIdentity?{fingerprint:copied.fingerprint,info:copied.sourceIdentity}:undefined;
    // 6. 接続を変える。取り消しの合図は渡さない（始めた接続の変更は最後まで行い、その後で残りを止める）。
    // 予約は接続を変え終えるまで持つ（つなぎ替えの間の再生・状態確認は「コピー中」）。つないだら、元を読んだなら release(その組)、読まずに既存を再利用したなら drop（要らない元の照合でカードを読まない。Task 9）
    let connected=false,added:SequenceAsset|undefined;
    try{
      await this.update(job,item,{phase:'connecting',fingerprint:copied.fingerprint});
      const verified:VerifiedCopy={path:copied.path,fingerprint:copied.fingerprint,identity:copied.identity};
      try{
        if(item.target.kind==='reconnect')await this.ports.reconnect(job.root,job.assets.get(item.itemId)!,verified,item.target.generation);
        else{const {asset}=await this.ports.register(job.root,verified,item.name);item.assetId=asset.id;added=asset;}
      }catch(error){
        // 7. 結果不明: 台帳の接続先を読んで判定する。新しい場所に変わっていれば完成ファイルは消さない。台帳を読めなければ判定せずに残す（回収で照合し直す）
        if(!(error instanceof ReferenceConnectUnknown))throw ledgerSide(error,job.folder.path);
        let result:{connected:boolean;asset?:SequenceAsset};
        try{result=await ledgerConnects(this.ports,job.root,item,copied.path);}
        catch(unreadable){if(!(unreadable instanceof LedgerUnreadableError))throw unreadable;item.unresolved=true;throw new ConnectUnresolvedError(unreadable);}
        if(!result.connected)throw error;
        if(result.asset&&item.target.kind==='add'){item.assetId=result.asset.id;added=result.asset;}
      }
      connected=true;
    }finally{if(connected&&!read)claim?.drop();else claim?.release(read);}
    if(added&&item.target.kind==='add'){const {batchItemId}=item.target,asset=added;tell(()=>job.callbacks?.done(batchItemId,asset));}
    await this.update(job,item,{phase:'done',connected:true});job.current=undefined;
  }
  /** 段と実体を記録する。メモリを先に変える（書けなくても片付けはメモリの記録に従う）。書けなければ作業全体を止める。 */
  private async update(job:Job,item:CopyJobItemRecord,patch:Partial<CopyJobItemRecord>):Promise<void>{
    for(const [key,value] of Object.entries(patch)){if(value===undefined)delete (item as Record<string,unknown>)[key];else (item as Record<string,unknown>)[key]=value;}
    try{await writeCopyJobRecord(job.root,job.record);}catch(error){throw Object.assign(new Error(recordFailure(error),{cause:error}),{recordFailed:true});}
    this.notify(job.root,true);
  }
  /**
   * 失敗・取り消し: 接続を変えていなければ、記録にある自分の実体だけを消す（removeOwnedCopyFiles が実体を照合する）。消さずに残したもの（kept）は記録の kept に残して報告する。
   * コピー先を確かめられない（取り外し・入れ替わり）時・消せなかった時は片付けず、記録を残して後で回収する（「無い」と見えても記録から外さない）。
   * 接続を変え終えた項目（記録だけ書けなかった）は完了のまま。結果不明で台帳を読めなかった項目（unresolved）は完成ファイルを残す。
   */
  private async settleFailure(io:CopyIo,job:Job,item:CopyJobItemRecord,error:unknown,phase:'failed'|'cancelled'):Promise<void>{
    job.current=undefined;
    if(item.connected){await this.update(job,item,{phase:'done'}).catch(()=>undefined);return;}
    if(!item.unresolved&&(item.part||(!item.reused&&(item.reserved||item.final)))){
      try{
        await assertCopyFolder(io,job.folder,job.record.destination.volume);
        const cleaned=await removeOwnedCopyFiles(io,job.folder.path,item);
        if(cleaned.kept.length)job.record.kept=[...new Set([...(job.record.kept??[]),...cleaned.kept])].slice(0,200);
        delete item.part;delete item.reserved;if(!item.reused)delete item.final;
      }catch(cleanup){
        if(isSimulatedCrash(cleanup))throw cleanup;
        if(cleanup instanceof CopyFolderError)job.volumeLost=true;
        console.error('[sme] コピーの途中のファイルを片付けられません（記録に従って後で片付けます）:',cleanup instanceof Error?cleanup.message:cleanup);
      }
    }
    const message=phase==='cancelled'?(job.stopRequested??'中止しました'):reasonOf(error,item.source);
    await this.update(job,item,{phase,error:message}).catch(()=>undefined);
    // 結果不明で台帳を読めなかった項目は、束では失敗にせず判断待ちに戻す（実際にはつながっている可能性がある。もう一度選べば、同じ指紋の登録として扱われ二重にならない）
    if(item.target.kind==='add'&&phase==='failed'){const {batchItemId}=item.target;tell(()=>item.unresolved?job.callbacks?.stopped([batchItemId]):job.callbacks?.failed(batchItemId,message));}
  }
  private async finish(job:Job):Promise<void>{
    const record=job.record;record.state=job.stopRequested?'stopped':'finished';if(job.stopRequested)record.stopReason=job.stopRequested;
    // 同じ起動中の取り外し: コピー先を確かめられずに片付けられなかった実体が記録に残れば、回収を待つ（ドライブ・フォルダーの照合は回収の側。同じ dev で付け直した時も片付く）
    if(job.volumeLost&&record.items.some(ownsFiles)){record.state='waiting-volume';this.retryRoots.add(job.root);}
    try{await writeCopyJobRecord(job.root,record);}catch(error){console.error('[sme] コピーの記録を更新できません:',error);}
    if(record.state==='waiting-volume')this.scheduleRetry();
    const stopped=record.items.flatMap(item=>item.target.kind==='add'&&item.phase==='cancelled'?[item.target.batchItemId]:[]);
    if(stopped.length)tell(()=>job.callbacks?.stopped(stopped));
    await pruneCopyJobRecords(job.root).catch(()=>undefined);this.notify(job.root,true);
  }
  /** 残りを中止（設計 §6）: コピー・照合中の1本は止めて片付ける。名前を確定済み・接続を変更中の1本は最後まで行う。完了分はつなぎ替えたまま残す。 */
  cancel(root:string,jobId:string):CopyJobView{
    const job=this.jobs.get(jobId);if(!job||job.root!==root)throw new HttpError(404,'コピーの作業が見つかりません');
    if(job.record.state==='running'&&!job.stopRequested){
      job.stopRequested=`残りを中止しました（${COPY_CANCEL_NOTE}）`;
      if(!job.record.items.some(item=>item.phase==='named'||item.phase==='connecting'))job.controller.abort(new Error('残りを中止しました'));
      this.notify(root,true);
    }
    return this.view(job);
  }
  /** 取り込みの束を取り消した時: その束の追加時のコピーを中止する。 */
  cancelBatch(root:string,batchId:string):void{
    for(const job of this.jobs.values())if(job.root===root&&job.record.state==='running'&&job.record.items.some(item=>item.target.kind==='add'&&item.target.batchId===batchId))this.cancel(root,job.record.jobId);
  }
  /** 終わった作業を一覧から閉じる（記録は自分の実体が残っていなければ後で消す）。 */
  async dismiss(root:string,jobId:string):Promise<void>{
    const job=this.jobs.get(jobId),record=job?.root===root?job.record:(await readCopyJobRecords(root)).find(item=>item.jobId===jobId);
    if(!record)throw new HttpError(404,'コピーの作業が見つかりません');
    if(record.state==='running'||record.state==='waiting-volume')throw new HttpError(409,'コピーの作業が終わってから閉じてください');
    record.dismissed=true;await writeCopyJobRecord(root,record);if(job?.root===root)this.jobs.delete(jobId);this.notify(root,true);
  }
  async list(root:string):Promise<CopyJobView[]>{
    await this.ensureRecovered(root);
    const views=new Map<string,CopyJobView>();
    // このプロセスが動かしていない作業（別のエディター・回収を待つ前回の作業）には印を付ける（画面は進み具合と「残りを中止」を出さず、素材をコピー中として扱わない）
    const io=this.io(),elsewhere=(record:CopyJobRecord)=>record.state==='running'||(record.state==='waiting-volume'&&!ownedByThisProcess(io,record.owner));
    for(const record of await readCopyJobRecords(root).catch(()=>[] as CopyJobRecord[]))
      if(!record.dismissed)views.set(record.jobId,{...this.recordView(record),...(elsewhere(record)?{notThisProcess:true as const}:{})});
    for(const job of this.jobs.values())if(job.root===root){if(job.record.dismissed)views.delete(job.record.jobId);else views.set(job.record.jobId,this.view(job));}
    return [...views.values()].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.jobId.localeCompare(b.jobId));
  }
  subscribe(root:string,listener:()=>void):()=>void{
    const set=this.listeners.get(root)??new Set<()=>void>();set.add(listener);this.listeners.set(root,set);
    return ()=>{set.delete(listener);if(!set.size&&this.listeners.get(root)===set)this.listeners.delete(root);};
  }
  /** その案件のコピーの作業にこのプロセスで初めて触れた時に、終わったプロセスの作業を回収する（設計 §5「起動時の回収」）。2回目からは最初の回収を待つだけ。 */
  ensureRecovered(root:string):Promise<void>{return this.recoveries.get(root)??this.queueRecovery(root);}
  /** 回収をやり直す案件（ドライブの接続を待つ作業・持ち主を確かめられずに飛ばした作業がある）を、もう一度回収する（15 秒ごとのタイマー・試験から呼ぶ）。 */
  async retryWaiting():Promise<void>{for(const root of [...this.retryRoots])await this.queueRecovery(root);}
  /**
   * 開始の前: 初めての案件なら回収し、やり直す作業があればもう一度回収する（戻ったドライブの上の実体を、新しい作業が既存の完成名として再利用する前に片付ける）。
   * 別の生きているプロセスがこの案件の回収の札を持つ間は始めない（409。その回収が消そうとしている完成コピーを再利用しないように）。
   */
  private async recoverBeforeStart(root:string):Promise<void>{
    await this.ensureRecovered(root);
    // 回収と同じ列に並べる（開始の確かめが受け付けた順に終わり、同時の2つの開始の先着が入れ替わらない）。札を見回れない時は断らない（記録先が使えなければ作業の記録で止まる）
    const held=(this.recoveries.get(root)??Promise.resolve()).then(async()=>{
      if(this.retryRoots.has(root))await this.recover(root);
      return recoveryHeldElsewhere(this.io(),root).catch(error=>{console.error('[sme] コピーの回収の札を見回れません:',error);return false;});
    });
    this.recoveries.set(root,held.then(()=>undefined));
    if(await held)throw new HttpError(409,RECOVERING_ELSEWHERE);
  }
  /** 同じ案件の回収は直列に行う（同じプロセスの2つの回収が札を取り合って、待っている作業を取りこぼさない）。 */
  private queueRecovery(root:string):Promise<void>{
    const next=(this.recoveries.get(root)??Promise.resolve()).then(()=>this.recover(root));this.recoveries.set(root,next);return next;
  }
  private async recover(root:string):Promise<void>{
    try{
      // このプロセスがその案件で作業を走らせている間は回収しない（同じコピー先の完成名を、作業と回収が同時に扱わない）。作業が終わった後のタイマーで行う
      if([...this.jobs.values()].some(job=>job.root===root&&job.record.state==='running')){if(this.retryRoots.has(root))this.scheduleRetry();return;}
      const result=await recoverCopyJobs(this.io(),root,this.ports),touched=new Set([...result.recovered,...result.waitingVolume]);
      // このプロセスの作業（同じ起動中の取り外し）の記録を回収の結果に合わせる
      if([...touched].some(id=>this.jobs.get(id)?.root===root))
        for(const record of await readCopyJobRecords(root)){const job=this.jobs.get(record.jobId);if(job?.root===root&&touched.has(record.jobId))job.record=record;}
      // ドライブを待つ作業と、持ち主を確かめられずに飛ばした作業（別のエディターが動いている・ps の失敗・札を他が持つ・一時的な失敗）は、15 秒ごとにやり直す
      // （このプロセスが走らせている作業は飛ばして当然なので数えない）
      const retry=result.waitingVolume.length>0||result.skipped.some(id=>this.jobs.get(id)?.record.state!=='running');
      if(retry){this.retryRoots.add(root);this.scheduleRetry();}else this.retryRoots.delete(root);
      if(touched.size)this.notify(root,true);
    }catch(error){
      if(!isSimulatedCrash(error))console.error('[sme] コピーの作業を回収できません:',error);
      if(this.retryRoots.has(root))this.scheduleRetry();   // 例外で終わっても、やり直す作業があれば見張りを続ける
    }
  }
  private scheduleRetry():void{if(this.retryTimer)return;this.retryTimer=setTimeout(()=>{this.retryTimer=undefined;void this.retryWaiting();},this.retryMs);this.retryTimer.unref?.();}
  /** 試験と監査用: 並んでいる作業が全部終わるまで待つ。 */
  async idle():Promise<void>{let seen:Promise<void>|undefined;while(seen!==this.chain){seen=this.chain;await seen;}}
  /** 段が変わった時はすぐ、進み具合は 0.5 秒に1回まで知らせる。 */
  private notify(root:string,immediate=false):void{
    const fire=()=>{this.pendingNotify.delete(root);this.notified.set(root,Date.now());
      for(const listener of [...this.listeners.get(root)??[]])try{listener();}catch(error){console.error('[sme] コピーの通知に失敗しました:',error);}};
    if(immediate){clearTimeout(this.pendingNotify.get(root));fire();return;}
    if(this.pendingNotify.has(root))return;
    const timer=setTimeout(fire,Math.max(0,NOTIFY_MS-(Date.now()-(this.notified.get(root)??0))));timer.unref?.();this.pendingNotify.set(root,timer);
  }
  private recordView(record:CopyJobRecord):CopyJobView{
    return {jobId:record.jobId,projectId:record.projectId,mode:record.mode,state:record.state,createdAt:record.createdAt,destination:{kind:record.destination.kind,label:record.destination.label},
      ...(record.stopReason?{stopReason:record.stopReason}:{}),...(record.kept?.length?{kept:[...record.kept]}:{}),
      items:record.items.map(item=>({itemId:item.itemId,name:item.name,sizeBytes:item.sizeBytes,phase:item.phase,bytesDone:item.phase==='done'?item.sizeBytes:0,
        ...(item.target.kind==='reconnect'?{assetId:item.target.assetId}:item.assetId?{assetId:item.assetId}:{}),
        ...(item.target.kind==='add'?{batchItem:{batchId:item.target.batchId,itemId:item.target.batchItemId}}:{}),...(item.error?{error:item.error}:{})}))};
  }
  /** 進み具合: 何本中何本目・速度・残り時間の幅（下限はコピーの実測の速さ、上限は書き先の照合も同じ速さとした2倍）。 */
  private view(job:Job):CopyJobView{
    const base=this.recordView(job.record),current=job.current;
    const items=base.items.map(item=>({...item,bytesDone:item.phase==='done'?item.sizeBytes:Math.min(item.sizeBytes,job.progress.get(item.itemId)??0)}));
    if(!current||job.record.state!=='running')return {...base,items};
    const index=job.record.items.findIndex(item=>item.itemId===current.itemId),seconds=(this.io().now()-current.startedAt)/1000,rate=seconds>0&&current.bytes>0?current.bytes/seconds:undefined;
    const left=job.record.items.filter(item=>item.phase==='waiting').reduce((sum,item)=>sum+item.sizeBytes,0)+Math.max(0,(job.record.items[index]?.sizeBytes??0)-current.bytes);
    return {...base,items,current:{index,...(rate?{bytesPerSecond:rate,remaining:{minSeconds:Math.ceil(left/rate),maxSeconds:Math.ceil(left*2/rate)}}:{})}};
  }
}
export const mediaCopyJobs=new MediaCopyJobs();
/**
 * 作業の案件の鍵（root）: OS の実パスの解決（ディスク上の形）。窓口・通知（SSE の copy-jobs）・取り込みの束からの開始で同じ関数を使う
 * （JS 版の realpathSync は渡した文字列の形〈NFC/NFD・大文字小文字〉を残すので、混ぜると同じ案件が別の鍵になり、作業が一覧・通知に出ない）。
 */
export const copyJobsRoot=(directory:string):string=>realpathSync.native(directory);
/** 試験専用: 外界とポートを差し替える（製品の経路からは呼ばない）。 */
export const mediaCopyTesting={
  use(options:{io?:CopyIo;ports?:CopyPorts}){if(options.io)copyIoTesting.use(options.io);if(options.ports)mediaCopyJobs.setPortsForTests(options.ports);},
  reset(){copyIoTesting.use(undefined);mediaCopyJobs.setPortsForTests(referenceCopyPorts);},
};
