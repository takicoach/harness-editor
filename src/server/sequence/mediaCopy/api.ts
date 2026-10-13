// src/server/sequence/mediaCopy/api.ts
import type {IncomingMessage,ServerResponse} from 'node:http';
import {HttpError,sendJson} from '../../http';
import {JOB_BODY_MAX_BYTES,readJsonBody} from '../../readBody';
import {assertBrowsablePath,browseRoots} from '../../browsePaths';
import {SequenceError} from '../../../core/sequence/errors';
import type {SequenceAsset} from '../../../core/sequence/model';
import {MAX_COPY_ITEMS,type CopyDestinationRequest} from '../../../shared/mediaCopy';
import {object,id} from '../editRequest';
import {SequenceStore} from '../store';
import {isSequenceReferenceFile,referenceReadState,registeredSequenceReferences} from '../references';
import {copyIo} from './io';
import {listCopyDestinations,resolveCopyDestination,type DestinationInput} from './destinations';
import {connectionOf,slowMediaAdvice,suppressSlowMediaAdvice} from './slowMedia';
import {copyJobsRoot,mediaCopyJobs} from './jobs';
import {importBatches} from '../importBatches';

/**
 * 読むだけの経路（GET）と、変える経路（POST）。GET は編集のセッションを作らず、案内は何も書かない。ただし一覧はその案件に初めて触れた時（と 15 秒ごとのやり直しの対象がある時）、
 * 終わったプロセスの作業を回収する（記録の書き換えと、記録にある自分の途中のファイルの削除がありうる。設計 §5「起動時の回収」。2回目からは書かない）。
 */
const READ_ROUTES=['/media-copy/jobs','/media-copy/advice'];
const WRITE_ROUTES=['/media-copy/destinations','/media-copy/start','/media-copy/cancel','/media-copy/dismiss','/media-copy/suppress'];
const MAX_ASSETS=MAX_COPY_ITEMS,MAX_PATH=4096,JOB_ID=/^cp-[a-f0-9]{20}$/;
const MIGRATE='先に案件を新形式へ移行してください';
/** errno・英文の失敗（絶対パスを含みうる）の代わりに出す、経路ごとの決まった文言（code を添える）。 */
const FALLBACK:Record<string,string>={'/media-copy/jobs':'コピーの作業を読めません','/media-copy/advice':'案内を確かめられません','/media-copy/destinations':'コピー先を調べられません',
  '/media-copy/start':'コピーを始められません','/media-copy/cancel':'コピーを中止できません','/media-copy/dismiss':'コピーの作業を閉じられません','/media-copy/suppress':'「今後この場所では出さない」を記録できません',
  '/imports/decide':'選んだ扱いで始められません'};
/** assertBrowsablePath の理由は指定したパスを含むので、状態ごとの決まった文言に替える。 */
const PLACE_REASON:Record<number,string>={400:'コピー先の場所は絶対パスで指定してください',403:'この場所は選べません（外付け・デスクトップ・ダウンロード・ムービーの中から選んでください）',404:'コピー先の場所が見つかりません'};
const JAPANESE=/[぀-ヿ㐀-鿿]/;
/** 絶対パスの始まり（語の途中ではない「/」）。案件の中の相対的な場所（.harness/references/…）は理由に残してよい。 */
const ABSOLUTE_PATH=/(?:^|[^\w.~\-/])\/[^\s/]/;

/** 「場所を指定」のパス: 許可された場所（素材を選べる場所と同じ）の中だけ（リンクをたどった先も）。実パスで返す。理由に指定したパスを出さない。 */
export function customPath(value:unknown):string|undefined{
  if(value===undefined)return undefined;
  if(typeof value!=='string'||!value||value.length>MAX_PATH)throw new HttpError(400,'コピー先の場所が不正です');
  try{return assertBrowsablePath(value,browseRoots());}
  catch(error){if(error instanceof HttpError)throw new HttpError(error.status,PLACE_REASON[error.status]??'コピー先の場所が不正です',{cause:error});throw error;}
}
/** 画面が選んだコピー先（選んだ時点の識別つき。開始時に今の識別と照合する）。場所を指定（custom）の時だけ customPath を受ける。 */
export function parseDestinationRequest(value:unknown):CopyDestinationRequest{
  const body=object(value),{key,uuid,dev}=body;
  if(typeof key!=='string'||!/^(internal|custom|volume:.{1,200})$/.test(key)||typeof uuid!=='string'||!uuid||uuid.length>200||typeof dev!=='number'||!Number.isSafeInteger(dev)||dev<0)
    throw new HttpError(400,'コピー先の指定が不正です');
  if(key!=='custom'){if(body.customPath!==undefined)throw new HttpError(400,'コピー先の指定が不正です');return {key,uuid,dev};}
  const path=customPath(body.customPath);if(!path)throw new HttpError(400,'場所を指定してください');
  return {key,uuid,dev,customPath:path};
}
/**
 * 指定した素材（1〜50件。重複は1つにする）。保存済みの文書の素材、無ければ参照台帳の素材（追加したばかりで未保存のリンク素材）。リンク素材だけ。
 * 素材の索引は保存済みの文書から読む（編集の版・セッションには触れない。接続の変更は台帳の generation で守る）。
 */
export async function linkAssets(root:string,saved:ReadonlyMap<string,SequenceAsset>,value:unknown):Promise<SequenceAsset[]>{
  if(!Array.isArray(value)||!value.length||value.length>MAX_ASSETS)throw new HttpError(400,`素材を1〜${MAX_ASSETS}件で指定してください`);
  const assets:SequenceAsset[]=[];let ledger:SequenceAsset[]|undefined;
  for(const assetId of new Set(value.map(item=>id(item)))){
    let asset=saved.get(assetId);
    if(!asset){ledger??=await registeredSequenceReferences(root);asset=ledger.find(item=>item.id===assetId);}
    if(!asset||!isSequenceReferenceFile(asset.file))throw new HttpError(400,'リンク素材を指定してください');
    assets.push(asset);
  }
  return assets;
}
/** 開いた時のコピーの元: 台帳の接続先（実パス）と大きさ。測れていれば最も遅い速さ（所要時間の幅に使う）。 */
export async function referenceSources(root:string,assets:readonly SequenceAsset[]):Promise<Pick<DestinationInput,'sources'|'sourceBytesPerSecond'>>{
  const sources:DestinationInput['sources']=[],speeds:number[]=[];
  for(const asset of assets){
    const state=await referenceReadState(root,asset);if(!state)throw new HttpError(409,`「${asset.name}」の接続を確認できません。ドライブの接続を確認してください`);
    sources.push({path:state.path,sizeBytes:state.sizeBytes});if(state.bytesPerSecond)speeds.push(state.bytesPerSecond);
  }
  return {sources,...(speeds.length?{sourceBytesPerSecond:Math.min(...speeds)}:{})};
}
/**
 * 画面へ返す失敗: こちらで決めた文言（HttpError・SequenceError・絶対パスを含まない日本語の本文）はそのまま返す。待てば直る印（busy。参照台帳の接続の変更中など）の付いたものは 409。
 * errno・英文・絶対パスを含むもの（ネットワークの識別を含みうる）はログへ回し、経路ごとの決まった文言と code にする。取り込みの束の判断（/imports/decide）も同じ規則で返す。
 */
export function shownError(error:unknown,route:string):unknown{
  if(error instanceof HttpError||error instanceof SequenceError)return error;
  const message=error instanceof Error?error.message:'',code=(error as {code?:unknown}|null)?.code;
  if(typeof code!=='string'&&JAPANESE.test(message)&&!ABSOLUTE_PATH.test(message))
    return (error as {busy?:unknown}).busy===true?new HttpError(409,message,{cause:error}):error;
  console.error('[sme] コピーの窓口の失敗（画面には決まった文言を出します）:',error);
  return new HttpError(500,`${FALLBACK[route]??'処理に失敗しました'}${typeof code==='string'&&/^[A-Z][A-Z0-9_]{1,31}$/.test(code)?`（${code}）`:''}`,{cause:error});
}
const jobIdOf=(value:unknown)=>{if(typeof value!=='string'||!JOB_ID.test(value))throw new HttpError(400,'コピーの作業の指定が不正です');return value;};
/**
 * 本文（64KiB まで）。大きすぎる本文はここで 413 を返して接続を閉じ、undefined を返す: 読みを途中で止めると Node は要求を中断扱いにし（読み終わる前の破棄で aborted を出す）、
 * handleSequenceApi の catch は中断した要求に応答しないので、投げると応答のないまま接続が残る。
 */
async function readBody(req:IncomingMessage,res:ServerResponse):Promise<Record<string,unknown>|undefined>{
  try{return object(await readJsonBody(req,JOB_BODY_MAX_BYTES));}
  catch(error){
    if(!(error instanceof HttpError)||error.status!==413||res.headersSent)throw error;
    res.setHeader('Connection','close');sendJson(res,413,{error:error.message});return undefined;
  }
}

/**
 * 遅い媒体の素材のコピーの窓口（設計 §1〜§6）。案件は呼び手（handleSequenceApi）が許可された場所の中に解決済み。
 * GET /media-copy/jobs → {jobs}（初回は前回のプロセスの作業を回収する: 記録の書き換え・自分の途中のファイルの削除がありうる）・GET /media-copy/advice → SlowMediaAdvice（書かない）。
 * POST /media-copy/destinations {assetIds;customPath?}（追加時の判断待ちは assetIds の代わりに batchId）・/start {assetIds;destination}・/cancel {jobId}・/dismiss {jobId}・/suppress {assetId}。
 */
export async function handleMediaCopyApi(req:IncomingMessage,res:ServerResponse,route:string,directory:string,projectId:string):Promise<boolean>{
  const reading=READ_ROUTES.includes(route);if(!reading&&!WRITE_ROUTES.includes(route))return false;
  const method=req.method??'GET';
  if(reading&&method!=='GET')throw new HttpError(405,'この操作は GET のみ対応します');
  if(!reading&&method!=='POST')throw new HttpError(405,'この操作は POST のみ対応します');
  try{
    const store=new SequenceStore(directory),root=copyJobsRoot(directory),io=copyIo();
    if(reading){
      // 素材の索引だけを読む（文書の複製・編集のセッションを作らない）
      const index=store.assetIndex();if(!index)throw new HttpError(409,MIGRATE);
      sendJson(res,200,route==='/media-copy/jobs'?{jobs:await mediaCopyJobs.list(root)}:await slowMediaAdvice(io,root,[...index.values()]));return true;
    }
    const saved=store.load();if(!saved)throw new HttpError(409,MIGRATE);
    const body=await readBody(req,res);if(!body)return true;
    const assets=new Map(saved.document.assets.map(asset=>[asset.id,asset]));
    const project={name:saved.document.name,id:saved.document.id,root};
    if(route==='/media-copy/destinations'){
      // 追加時（取り込みの束の判断待ち）は、束が覚えている元の実パスと大きさ。開いた時は台帳の接続先
      if(body.batchId!==undefined&&body.assetIds!==undefined)throw new HttpError(400,'素材と取り込みの束は同時に指定できません');
      const path=customPath(body.customPath),sources=body.batchId!==undefined?importBatches.copyInput(directory,id(body.batchId)):await referenceSources(root,await linkAssets(root,assets,body.assetIds));
      sendJson(res,200,{destinations:await listCopyDestinations(io,{project,...sources,...(path?{customPath:path}:{})}),totalBytes:sources.sources.reduce((sum,source)=>sum+source.sizeBytes,0)});
      return true;
    }
    if(route==='/media-copy/start'){
      const request=parseDestinationRequest(body.destination),targets=await linkAssets(root,assets,body.assetIds);
      const destination=await resolveCopyDestination(io,{project,...await referenceSources(root,targets)},request);
      sendJson(res,200,{job:await mediaCopyJobs.startReconnect({root,projectId,destination,assets:targets})});return true;
    }
    if(route==='/media-copy/cancel'){sendJson(res,200,{job:mediaCopyJobs.cancel(root,jobIdOf(body.jobId))});return true;}
    if(route==='/media-copy/dismiss'){await mediaCopyJobs.dismiss(root,jobIdOf(body.jobId));sendJson(res,200,{ok:true});return true;}
    // /media-copy/suppress: 「この接続先では今後出さない」（今の接続先＝実パスとボリュームの UUID で残す。UUID を読めないドライブは覚えられない）
    const [asset]=await linkAssets(root,assets,[body.assetId]),state=await referenceReadState(root,asset!);
    if(!state)throw new HttpError(409,'素材の接続を確認できません。ドライブの接続を確認してください');
    const connection=await connectionOf(io,state.path);if(!connection)throw new HttpError(409,'素材のドライブを識別できないため、「今後この場所では出さない」を記録できません');
    await suppressSlowMediaAdvice(root,asset!.id,connection);sendJson(res,200,{ok:true});return true;
  }catch(error){throw shownError(error,route);}
}
